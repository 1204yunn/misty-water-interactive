// One local rain track. The audio graph is created only after a visitor clicks.
const button = document.querySelector('#sound-toggle');
const audio = document.querySelector('#ambient-rain');
const level = 0.15;
const fadeSeconds = 2;
let context, gain, source;
let wanted = false;
let revision = 0;
let pauseTimer;
let ramp = { time: 0, from: 0, to: 0 };

function showState(playing, error = false) {
  button.setAttribute('aria-pressed', String(playing));
  const label = error ? '雨聲無法播放，點擊重試' : playing ? '暫停雨聲' : '播放雨聲';
  button.setAttribute('aria-label', label);
  button.title = label;
}

function fadeTo(target) {
  const now = context.currentTime;
  // Hold the interpolated gain when a visitor reverses an unfinished fade.
  const progress = Math.min(1, Math.max(0, (now - ramp.time) / fadeSeconds));
  const current = ramp.from + (ramp.to - ramp.from) * progress;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(current, now);
  gain.gain.linearRampToValueAtTime(target, now + fadeSeconds);
  ramp = { time: now, from: current, to: target };
}

function reset(error = false) {
  wanted = false;
  revision++;
  clearTimeout(pauseTimer);
  if (gain) {
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setValueAtTime(0, context.currentTime);
    ramp = { time: context.currentTime, from: 0, to: 0 };
  }
  audio.pause();
  showState(false, error);
}

button.addEventListener('click', async () => {
  wanted = !wanted;
  const request = ++revision;
  clearTimeout(pauseTimer);
  showState(wanted);
  if (!wanted) {
    if (!gain) return;
    fadeTo(0);
    pauseTimer = setTimeout(() => {
      if (request === revision && !wanted) audio.pause();
    }, fadeSeconds * 1000);
    return;
  }
  try {
    if (!context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      context = new AudioContext();
      gain = context.createGain();
      gain.gain.value = 0;
      source = context.createMediaElementSource(audio);
      source.connect(gain).connect(context.destination);
    }
    // Both calls originate in the click handler, including on mobile Safari.
    await Promise.all([context.resume(), audio.play()]);
    if (request !== revision || !wanted) {
      // A slow load may finish after a visitor has already requested pause.
      if (!wanted) audio.pause();
      return;
    }
    fadeTo(level);
  } catch (error) {
    if (request !== revision) return;
    console.error('Rain audio could not start:', error);
    reset(true);
  }
});

audio.addEventListener('error', () => reset(true));
audio.addEventListener('pause', () => { if (wanted) reset(); });
window.addEventListener('pagehide', () => reset());
