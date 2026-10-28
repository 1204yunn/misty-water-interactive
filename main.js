import * as THREE from 'three';
import { SlidingWater } from './water.js';
import { CondensationRegions } from './condensation.js';
import { GlassWiping } from './wiping.js';
import { HandCamera } from './hand-camera.js';
import { PhotoBooth } from './photo.js';
import { GesturePen, segmentCrossesRect } from './gestures.js';

// Fixed V2 settings shared by shader uniforms and CPU simulations.
// slideRatio is a fraction: 20% = 0.2.
export const parameters = Object.freeze({ density: 0.5, size: 0.8, refraction: 1, fog: 0.8, slideRatio: 0.2, speed: 2, tailLength: 0.85, streakStrength: 2,
  regionCount: 4, regionIntensity: 0.5, regionSize: 1.4, microDensity: 0.8, regionBlur: 1,
  wipeStrength: 0.5, wipeRange: 0.5, refogSpeed: 1 });
const status = document.querySelector('#status');
const host = document.querySelector('#experiment');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let paused = reducedMotion;
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power' });
} catch (error) {
  status.textContent = '此裝置無法啟動 WebGL，請使用支援 WebGL 的瀏覽器並啟用硬體加速。';
  throw error;
}
host.appendChild(renderer.domElement);
renderer.domElement.setAttribute('aria-label', '透明水滴在霧藍玻璃上緩緩凝結');

// Load the artwork before starting the renderer: no incomplete texture frames.
async function makeBackground() {
  const texture = await new THREE.TextureLoader().loadAsync(new URL('./assets/background.png', import.meta.url).href);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace; // Existing custom shader works in display-space.
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}
const backgroundTexture = await makeBackground();
const vertexShader = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragmentShader = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform sampler2D uBackground, uWater, uTracks;
uniform float uBackgroundAspect;
// The hand tracker and mirror share one camera stream.
uniform sampler2D uCamera;
uniform float uCameraReady, uCameraAspect;
uniform vec2 uWaterTexel;
uniform float uStreakStrength;
uniform float uTime, uSeed, uDensity, uSize, uRefraction, uFog;
uniform vec2 uPointer;
uniform float uTouch;
uniform sampler2D uCondensation;
uniform sampler2D uWipe;
uniform float uMicroDensity, uRegionBlur;

vec2 wipeShift(vec2 uv) {
  vec4 field = texture2D(uWipe,clamp(uv,0.0,1.0));
  return (field.rg*2.0-1.0)*vec2(1.0,-1.0)*field.a*.009;
}

vec2 hash22(vec2 p) {
  // Integer-valued arithmetic below 2^24: identical layout on CPU and GPU.
  vec2 n = mod(floor(p), 2039.0);
  float a = mod(n.x*127.0+n.y*311.0+uSeed*17.0,2039.0);
  float b = mod(a*a+a*13.0+73.0,2039.0);
  return vec2(b,mod(b*b+b*19.0+199.0,2039.0))/2039.0;
}
float hash12(vec2 p) { return hash22(p).x; }

// Dense stationary condensation; moving bodies are simulated independently.
vec4 drops(vec2 p, float scale, float layer) {
  vec2 grid = p * scale;
  vec2 cell = floor(grid);
  vec2 local = fract(grid);
  vec4 result = vec4(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 id = cell + offset;
      vec2 rnd = hash22(id + layer * 31.7);
      float presence = step(rnd.x, uDensity * .82);
      vec2 center = offset + .18 + .64 * hash22(id + 91.3 + layer);
      vec2 centerUv = (cell+center)/scale / vec2(uResolution.x/uResolution.y,1.0);
      float distribution = texture2D(uCondensation,clamp(centerUv,0.0,1.0)).b;
      if (layer < 10.0) presence = step(rnd.x,uDensity*.82*(layer<3.0 ? .55+.45*(distribution-.35)/.65 : distribution));
      if (layer > 10.0) presence = step(rnd.x,texture2D(uCondensation,centerUv).g*.8);
      center += wipeShift(centerUv)*vec2(uResolution.x/uResolution.y,1.0)*scale;
      float cleared = texture2D(uTracks,clamp(centerUv,0.0,1.0)).r;
      vec2 q = (local - center) / (uSize * (.065 + .235 * pow(rnd.y, 1.7)));
      q.x *= 1.0 + rnd.x * .28;
      q.y *= .91 + rnd.y * .18;
      float angle = atan(q.y, q.x);
      float contour = 1.0 + .045*sin(angle*3.0+rnd.x*22.0)
                           + .025*sin(angle*5.0+rnd.y*19.0);
      float d = length(q) / contour;
      float aa = max(.018, scale / uResolution.y * 2.0 / (uSize * .12));
      float mask = (1.0-smoothstep(1.0-aa, 1.0+aa, d)) * presence
                   * (1.0-smoothstep(.12,.45,cleared));
      float height = sqrt(max(0.0, 1.0 - min(d*d, 1.0)));
      vec2 normal = q * (.3 + .7 * pow(clamp(d,0.0,1.0), 2.0));
      if (mask > result.z) result = vec4(normal, mask, height);
    }
  }
  return result;
}
// Subpixel beads use isolated, jittered cells instead of extra neighbor loops.
vec4 microDrops(vec2 p, float scale, float layer, float moisture) {
  p -= wipeShift(p/vec2(uResolution.x/uResolution.y,1.0))*vec2(uResolution.x/uResolution.y,1.0);
  vec2 grid = p*scale;
  vec2 rnd = hash22(floor(grid)+layer);
  vec2 center = .32+.36*hash22(floor(grid)+layer+19.0);
  vec2 q = (fract(grid)-center)/(.055+.12*rnd.y);
  float d = length(q);
  float aa = clamp(scale/uResolution.y*1.8,.06,.85);
  float mask = (1.0-smoothstep(1.0-aa,1.0+aa,d))
    * step(rnd.x,moisture*uMicroDensity*.95);
  return vec4(q*.65,mask*.65,sqrt(max(0.0,1.0-min(d*d,1.0))));
}
// Mirror once, then cover-fit without stretching faces on portrait displays.
vec2 mirrorUv(vec2 uv) {
  float screenAspect = uResolution.x/uResolution.y;
  vec2 fit = screenAspect > uCameraAspect
    ? vec2(1.0,uCameraAspect/screenAspect)
    : vec2(screenAspect/uCameraAspect,1.0);
  vec2 cameraUv = (uv-.5)*fit+.5;
  cameraUv.x = 1.0-cameraUv.x;
  return clamp(cameraUv,.001,.999);
}
// One local field controls clarity and film removal, including refogging.
float wipeClarity(vec2 uv) {
  return smoothstep(.015,.72,texture2D(uWipe,clamp(uv,0.0,1.0)).a);
}
vec3 reflection(vec2 uv, float cleared) {
  // A small nine-tap soft blur remains even in wiped areas.
  vec2 radius = vec2(1.0/uCameraAspect,1.0)*mix(.022,.0018,cleared);
  vec3 color = texture2D(uCamera,mirrorUv(uv)).rgb*.24;
  color += (texture2D(uCamera,mirrorUv(uv+vec2(radius.x,0.0))).rgb
    +texture2D(uCamera,mirrorUv(uv-vec2(radius.x,0.0))).rgb
    +texture2D(uCamera,mirrorUv(uv+vec2(0.0,radius.y))).rgb
    +texture2D(uCamera,mirrorUv(uv-vec2(0.0,radius.y))).rgb)*.12;
  color += (texture2D(uCamera,mirrorUv(uv+radius)).rgb
    +texture2D(uCamera,mirrorUv(uv-radius)).rgb
    +texture2D(uCamera,mirrorUv(uv+vec2(radius.x,-radius.y))).rgb
    +texture2D(uCamera,mirrorUv(uv+vec2(-radius.x,radius.y))).rgb)*.07;
  float luminance = dot(color,vec3(.2126,.7152,.0722));
  color = mix(vec3(luminance),color,mix(.23,.48,cleared));
  color = (color-.5)*mix(.78,1.12,cleared)+.5;
  return mix(color*vec3(.94,.97,1.0),vec3(.43,.46,.49),mix(.10,.03,cleared));
}
vec3 background(vec2 uv) {
  float aspect = uResolution.x / uResolution.y;
  // Contain the complete artwork; clamp its edge colors into any letterboxing.
  // Camera cover fit remains independent and shares the full glass coordinates.
  vec2 fit = aspect > uBackgroundAspect
    ? vec2(aspect/uBackgroundAspect,1.0)
    : vec2(1.0,uBackgroundAspect/aspect);
  vec3 base = texture2D(uBackground, clamp((uv-.5)*fit+.5, .001, .999)).rgb;
  // Grade only the artwork, before camera compositing. White artwork maps to
  // grey mist-blue with about 20% less luminance; preserve its printed detail.
  float artworkLuma = dot(base,vec3(.2126,.7152,.0722));
  base = mix(vec3(artworkLuma),base,.24)*vec3(.80,.81,.83);
  float side = smoothstep(.24,.98,uv.x);
  base *= mix(1.02,.78,side);
  // A smaller, subdued pool of daylight keeps the left side softly alive.
  vec2 lightDelta = (uv-vec2(.16,.79))*vec2(6.2,4.8);
  base += vec3(.018,.021,.022)*exp(-dot(lightDelta,lightDelta));
  if (uCameraReady > .5) {
    float cleared = wipeClarity(uv);
    base = mix(base,reflection(uv,cleared),mix(.20,.84,cleared));
  }
  return base; // No background exposure or side shade is applied to the camera.
}void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 moisture = texture2D(uCondensation,uv).rg;
  float swept = texture2D(uTracks,uv).r;
  moisture *= 1.0-smoothstep(.12,.6,swept)*.85;
  vec4 large = drops(p, 8.0, 1.0);
  vec4 small = drops(p, 20.0, 5.0);
  vec4 drop = large.z > .1 ? large : small;
  if (moisture.r > .008) {
    vec4 medium = drops(p,34.0,13.0);
    vec4 micro = microDrops(p,78.0,23.0,moisture.g);
    vec4 fine = microDrops(p,137.0,47.0,moisture.g);
    if (fine.z > micro.z) micro = fine;
    if (medium.z > micro.z) micro = medium;
    if (drop.z < .1) drop = micro;
  }
  float water = texture2D(uWater,uv).r;
  vec2 gradient = vec2(
    texture2D(uWater,uv+vec2(uWaterTexel.x,0.0)).r-texture2D(uWater,uv-vec2(uWaterTexel.x,0.0)).r,
    texture2D(uWater,uv+vec2(0.0,uWaterTexel.y)).r-texture2D(uWater,uv-vec2(0.0,uWaterTexel.y)).r
  ) / (2.0*uWaterTexel.y);
  float movingMask = smoothstep(.012,.08,water);
  if (movingMask > .01) drop = mix(drop,vec4(-gradient*.042,1.0,water),movingMask);
  vec2 normal = drop.xy;
  float mask = drop.z;
  float height = drop.w;
  float grain = hash12(gl_FragCoord.xy * .17) - .5;
  vec3 base = background(uv);
  float clarity = wipeClarity(uv);
  // Cooler translucent scattering contrasts with the graded artwork. The
  // original moisture field supplies the irregular shape and tiny-bead detail.
  float side = smoothstep(.24,.98,uv.x);
  vec3 fogTint = mix(vec3(.82,.835,.85),vec3(.72,.745,.77),side);
  vec3 fogged = mix(base, fogTint, uFog * .42);
  // Local diffusion reduces contrast rather than painting opaque white clouds.
  vec2 blurStep = vec2(.065/aspect,.065)*uRegionBlur;
  vec3 diffuse = base*.28;
  diffuse += (background(uv+blurStep)+background(uv-blurStep)
    +background(uv+vec2(blurStep.x,-blurStep.y))
    +background(uv+vec2(-blurStep.x,blurStep.y)))*.18;
  vec3 film = mix(diffuse,fogTint+vec3(.035,.035,.03),min(.76,uFog*.42+.22+uRegionBlur*.18));
  float filmAmount = min(.68,moisture.r*(.38+.95*uRegionBlur));
  fogged = mix(fogged,film,filmAmount);
  fogged += grain * (.008 + uFog * .018);
  // Support strength 2 while keeping blend weights bounded.
  float wet = clamp(texture2D(uTracks,uv).g * uStreakStrength,0.0,1.0);
  fogged = mix(fogged, base + vec3(.012,.017,.019), wet*.42);
  // Thin residual water bends the background only slightly, without white stripes.
  fogged = mix(fogged,background(uv+vec2(wet*.002/aspect,0.0)),wet*.15);
  // Clear only the film, preserving bead optics and existing water tracks.
  fogged = mix(fogged,base,clarity*.97);
  vec2 bend = normal * vec2(1.0/aspect,1.0) * .065 * uRefraction;
  vec3 refracted = background(uv + bend);
  // Lens illumination is independent of the artwork exposure, so beads retain
  // volume against the darker film without turning into white plastic dots.
  refracted = mix(refracted, vec3(.72,.80,.84), .13);
  float edge = pow(1.0-height, 3.0);
  float shadow = clamp(dot(normal, normalize(vec2(.55,-.8))),0.0,1.0);
  refracted *= 1.0 - edge * (.12 + .28*shadow);
  // A broad softbox reflection with a small, crisp upper-left glint.
  float glint = exp(-dot(normal-vec2(-.39,.48),normal-vec2(-.39,.48))*95.0);
  float softLight = exp(-dot(normal-vec2(-.3,.5),normal-vec2(-.3,.5))*12.0);
  refracted += vec3(.80,.89,.94)*(glint*.36+softLight*.11);
  refracted += edge * pow(max(0.0,dot(normal,normalize(vec2(-.6,.8)))),8.0)*.24;
  float opacity = .84 + .13 * hash12(floor(p*91.0));
  vec3 color = mix(fogged, refracted, mask*opacity);
  vec2 pointerDelta = (uv-uPointer)*vec2(aspect,1.0);
  color += exp(-dot(pointerDelta,pointerDelta)*70.0)*uTouch*.035;
  float vignette = smoothstep(.2,.9,length((uv-.5)*vec2(.8,1.0)));
  color *= 1.0-vignette*.055*(1.0-clarity)*(1.0-mask);
  gl_FragColor = vec4(color,1.0);
}
`;

const uniforms = {
  uResolution: { value: new THREE.Vector2() }, uBackground: { value: backgroundTexture },
  uBackgroundAspect: { value: backgroundTexture.image.width/backgroundTexture.image.height },
  uCamera: { value: null }, uCameraReady: { value: 0 }, uCameraAspect: { value: 4/3 },
  uTime: { value: 0 }, uSeed: { value: Math.floor(Math.random()*2000) },
  uPointer: { value: new THREE.Vector2(-2,-2) }, uTouch: { value: 0 },
};
const condensation = new CondensationRegions(parameters,uniforms.uSeed.value);
condensation.update(innerWidth/innerHeight);
const slidingWater = new SlidingWater(parameters, uniforms.uSeed.value,condensation);
const wiping = new GlassWiping(parameters);
for (const [name,canvas] of [['uWater',slidingWater.bodyCanvas],['uTracks',slidingWater.trackCanvas],['uCondensation',condensation.canvas],['uWipe',wiping.canvas]]) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.userData.fieldSize = `${canvas.width}/${canvas.height}`;
  uniforms[name] = { value: texture };
}
uniforms.uWaterTexel = { value: new THREE.Vector2() };
for (const [key,value] of Object.entries(parameters)) {
  if (key !== 'speed') uniforms[`u${key[0].toUpperCase()}${key.slice(1)}`] = { value };
}
const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, depthTest: false, depthWrite: false });
const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),material));
const camera = new THREE.Camera();
let failed = false;
renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
  failed = true;
  console.error('Shader compilation failed', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment));
  status.hidden = false; status.textContent = 'Shader 編譯失敗，請更新瀏覽器，或查看開發者工具 Console。';
};

const viewport = { width: 0, height: 0, ratio: 0 };
let resizePending = false;
function resize() {
  // Cap both DPR and total fill rate, especially on high-DPR mobile screens.
  const bounds = host.getBoundingClientRect();
  const width = Math.max(1,Math.round(bounds.width)), height = Math.max(1,Math.round(bounds.height));
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(1800000/(width*height)));
  if (width===viewport.width && height===viewport.height && ratio===viewport.ratio) return;
  Object.assign(viewport,{width,height,ratio});
  renderer.setPixelRatio(ratio);
  renderer.setSize(width,height,false);
  renderer.getDrawingBufferSize(uniforms.uResolution.value);
  slidingWater.resize(width/height);
  wiping.resize(width/height);
  if (condensation.update(width/height)) uniforms.uCondensation.value.needsUpdate = true;
  uniforms.uWaterTexel.value.set(1/slidingWater.bodyCanvas.width,1/slidingWater.bodyCanvas.height);
  uniforms.uWater.value.needsUpdate = uniforms.uTracks.value.needsUpdate = true;
  // WebGL allocates immutable texture storage. A resized Canvas needs a new
  // texture rather than uploading changed dimensions into the existing storage.
  for (const name of ['uWater','uTracks','uCondensation','uWipe']) {
    const old = uniforms[name].value, canvas = old.image;
    const size = `${canvas.width}/${canvas.height}`;
    if (old.userData.fieldSize!==size) {
      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false; texture.userData.fieldSize = size;
      uniforms[name].value = texture; old.dispose();
    } else old.needsUpdate = true;
  }
}
const scheduleResize = () => { resizePending = true; };
window.addEventListener('resize', scheduleResize);
document.addEventListener('fullscreenchange', scheduleResize);
window.visualViewport?.addEventListener('resize', scheduleResize);
new ResizeObserver(scheduleResize).observe(host);
resize();

const glass = renderer.domElement;
let pointerId = null, lastPoint = null;
const gesturePen = new GesturePen();
const cursor = document.querySelector('#gesture-cursor');
const photoBooth = new PhotoBooth({ onResetPen: () => {
  gesturePen.reset(); cursor.hidden=true; lastPoint=null;
  if (pointerId!==null) endStroke({pointerId});
} });
const blockers = [...document.querySelectorAll('.gesture-tools, .sound-toggle')];
function paintStroke(from,to) {
  if (photoBooth.blocksDrawing) return false;
  const rect=glass.getBoundingClientRect();
  const a={x:rect.left+from.x*rect.width,y:rect.top+from.y*rect.height};
  const b={x:rect.left+to.x*rect.width,y:rect.top+to.y*rect.height};
  if (blockers.some(element=>segmentCrossesRect(a,b,element.getBoundingClientRect()))) return false;
  wiping.stroke(from,to); return true;
}
function pointerPoint(event) {
  const rect = glass.getBoundingClientRect();
  return { x:(event.clientX-rect.left)/rect.width, y:(event.clientY-rect.top)/rect.height, time:event.timeStamp };
}
glass.addEventListener('pointerdown',event => {
  if (photoBooth.blocksDrawing || pointerId !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  pointerId = event.pointerId; lastPoint = pointerPoint(event);
  gesturePen.reset(); cursor.hidden=true;
  glass.setPointerCapture(pointerId);
  paintStroke(lastPoint,lastPoint);
  uniforms.uPointer.value.set(lastPoint.x,1-lastPoint.y);
  uniforms.uTouch.value = 1;
});
glass.addEventListener('pointermove',event => {
  if (event.pointerId !== pointerId) return;
  event.preventDefault();
  const point = pointerPoint(event);
  const from=lastPoint||point;
  lastPoint=paintStroke(from,point) ? point : null;
  uniforms.uPointer.value.set(point.x,1-point.y); uniforms.uTouch.value = 1;
});
function endStroke(event) {
  if (event.pointerId !== pointerId) return;
  const id = pointerId; pointerId = null; lastPoint = null;
  if (glass.hasPointerCapture(id)) glass.releasePointerCapture(id);
}
for (const type of ['pointerup','pointercancel','lostpointercapture']) glass.addEventListener(type,endStroke);
window.addEventListener('blur',() => { if (pointerId !== null) endStroke({pointerId}); });
const handCamera = new HandCamera({
  button:document.querySelector('#camera-toggle'),status:document.querySelector('#gesture-status'),
  onReset:()=> { gesturePen.reset(); cursor.hidden=true; photoBooth.interrupt(); },
  onResult:data=> {
    const cameraReady=handCamera.video.readyState>=2 && handCamera.video.videoWidth>0
      && handCamera.stream?.getVideoTracks().some(track=>track.readyState==='live');
    if (photoBooth.observe(data,cameraReady)) {
      gesturePen.reset(); cursor.hidden=true;
      handCamera.setStatus(photoBooth.stage==='live' ? 'ya' : 'detected',
        photoBooth.stage==='countdown' ? '拍照倒數中' : photoBooth.stage==='preview' ? '照片預覽中' : '',photoBooth.progress);
      return;
    }
    if (pointerId!==null) { gesturePen.reset(); cursor.hidden=true; handCamera.setStatus(data.landmarks ? 'detected' : 'missing','滑鼠繪畫中'); return; }
    // Match the cover crop used by mirrorUv; keep raw points for gesture classification.
    const videoAspect = handCamera.video.videoWidth/handCamera.video.videoHeight || 4/3;
    const screenAspect = viewport.width/viewport.height;
    const fitX = Math.min(1,screenAspect/videoAspect);
    const fitY = Math.min(1,videoAspect/screenAspect);
    const screenLandmarks = data.landmarks?.map(point=>({ ...point,
      x:(point.x-.5)/fitX+.5, y:(point.y-.5)/fitY+.5,
    }));
    const result=gesturePen.process(screenLandmarks,data.world || data.landmarks,data.timestamp,data.hand);
    if (result.point && blockers.some(element=>segmentCrossesRect(
      {x:result.point.x*viewport.width,y:result.point.y*viewport.height},
      {x:result.point.x*viewport.width,y:result.point.y*viewport.height},element.getBoundingClientRect()))) {
      gesturePen.reset(); cursor.hidden=true; handCamera.setStatus('detected','請移到玻璃繪畫區'); return;
    }
    if (result.from && !paintStroke(result.from,result.point)) {
      gesturePen.reset(); cursor.hidden=true; handCamera.setStatus('detected','請移到玻璃繪畫區'); return;
    }
    handCamera.setStatus(result.state);
    cursor.hidden=!result.point;
    if (result.point) cursor.style.transform=`translate3d(${result.point.x*viewport.width}px,${result.point.y*viewport.height}px,0)`;
  },
});
// VideoTexture follows the existing video; no extra getUserMedia or inference copy.
const reflectionTexture = new THREE.VideoTexture(handCamera.video);
reflectionTexture.minFilter = reflectionTexture.magFilter = THREE.LinearFilter;
reflectionTexture.generateMipmaps = false;
reflectionTexture.colorSpace = THREE.NoColorSpace; // Match the existing shader's display-space palette.
uniforms.uCamera.value = reflectionTexture;
document.querySelector('#clear-strokes').addEventListener('click',()=> {
  wiping.reset(); gesturePen.reset(); lastPoint=null; cursor.hidden=true;
  if (handCamera.running) handCamera.setStatus('missing','筆觸已清除');
});
window.addEventListener('blur',()=> { gesturePen.reset(); cursor.hidden=true; });
renderer.domElement.addEventListener('webglcontextlost',event => {
  event.preventDefault(); failed = true; photoBooth.interrupt();
  status.hidden = false; status.textContent = '圖形連線暫時中斷，正在等待恢復…';
});
renderer.domElement.addEventListener('webglcontextrestored',() => { failed = false; status.hidden = true; viewport.width=0; scheduleResize(); });

let previous = performance.now();
let lastFrame = 0;
function animate(now) {
  requestAnimationFrame(animate);
  if (document.hidden || failed) { previous = now; return; }
  if (resizePending) {
    resizePending=false;
    if (pointerId!==null) endStroke({pointerId});
    gesturePen.reset(); lastPoint=null; cursor.hidden=true;
    resize(); previous=now; lastFrame=0;
  }
  // 30 fps mobile / 45 fps desktop; no expensive postprocessing or shadow maps.
  const frameInterval = viewport.width <= 600 ? 1000/30 : 1000/45;
  if (now-lastFrame < frameInterval) return;
  const delta = Math.min((now-previous)/1000,.1);
  previous = now; lastFrame = now;
  if (!paused) uniforms.uTime.value += delta * parameters.speed;
  if (condensation.update(viewport.width/viewport.height)) uniforms.uCondensation.value.needsUpdate = true;
  slidingWater.update(paused ? 0 : delta * parameters.speed);
  if (slidingWater.paint()) {
    uniforms.uWater.value.needsUpdate = uniforms.uTracks.value.needsUpdate = true;
  }
  uniforms.uTouch.value *= Math.exp(-delta*2.5);
  if (wiping.update(delta)) uniforms.uWipe.value.needsUpdate = true;
  const video = handCamera.video;
  const liveTrack = handCamera.stream?.getVideoTracks().some(track=>track.readyState==='live');
  uniforms.uCameraReady.value = liveTrack && video.readyState >= 2 && video.videoWidth > 0 ? 1 : 0;
  if (uniforms.uCameraReady.value) uniforms.uCameraAspect.value = video.videoWidth/video.videoHeight;
  renderer.render(scene,camera);
  photoBooth.afterRender(now,uniforms.uCameraReady.value>.5,glass,document.querySelector('.brand-logo'));
  if (!failed) status.hidden = true;
}
requestAnimationFrame(animate);


