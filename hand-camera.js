// One small video source + one in-flight ImageBitmap; inference stays off the UI thread.
export class HandCamera {
  constructor({button,status,onResult,onReset}) {
    Object.assign(this,{button,status,onResult,onReset});
    this.video=document.createElement('video');
    this.video.muted=true; this.video.playsInline=true;
    this.video.setAttribute('aria-hidden','true');
    this.generation=0; this.running=false; this.loading=false;
    button.addEventListener('click',()=>this.running||this.loading ? this.stop() : this.start());
    window.addEventListener('pagehide',()=>this.stop());
    document.addEventListener('visibilitychange',()=> { if (document.hidden) { this.onReset(); this.setStatus('missing'); } });
    this.setStatus('missing','攝影機未啟動');
  }
  setStatus(state,message,progress=0) {
    const label=state==='drawing' ? '食指擦拭中' : state==='ya' ? 'YA 拍照準備中' : '未偵測';
    const text=label+(message ? ' · '+message : '');
    if (this.status.textContent!==text) this.status.textContent=text;
    this.status.dataset.state=state;
    this.status.style.setProperty('--ya-progress',`${Math.max(0,Math.min(1,progress))*360}deg`);
  }
  stop(message='攝影機已關閉') {
    this.generation++; this.loading=false; this.running=false; this.busy=false;
    cancelAnimationFrame(this.raf); clearTimeout(this.loadTimer);
    this.cancelLoad?.(); this.cancelLoad=null;
    this.worker?.terminate(); this.worker=null;
    this.stream?.getTracks().forEach(track=>track.stop()); this.stream=null;
    this.video.pause(); this.video.srcObject=null;
    this.button.textContent='啟動攝影機'; this.button.setAttribute('aria-pressed','false');
    this.onReset(); this.setStatus('missing',message);
  }
  async start() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.setStatus('missing','請用 localhost 或 HTTPS 開啟'); return;
    }
    const token=++this.generation;
    this.loading=true; this.button.textContent='取消啟動'; this.setStatus('missing','等待攝影機權限');
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:20,max:24}}});
      if (token!==this.generation) { stream.getTracks().forEach(track=>track.stop()); return; }
      this.stream=stream; this.video.srcObject=stream;
      stream.getVideoTracks()[0].addEventListener('ended',()=> { if(token===this.generation) this.stop('攝影機已中斷'); });
      await this.video.play();
      if (token!==this.generation) return;
      this.setStatus('missing','載入手勢模型…');
      const worker=new Worker(new URL('./hand-worker.js',import.meta.url));
      this.worker=worker;
      await new Promise((resolve,reject)=> {
        this.cancelLoad=()=>reject(new Error('cancelled'));
        this.loadTimer=setTimeout(()=>reject(new Error('模型載入逾時，請確認網路後重試')),45000);
        worker.onerror=()=>reject(new Error('手勢辨識無法載入，可改用滑鼠繪畫'));
        worker.onmessage=({data})=> {
          if(data.type==='ready') resolve();
          if(data.type==='error') reject(new Error(data.message));
        };
        worker.postMessage({type:'init'});
      });
      clearTimeout(this.loadTimer); this.cancelLoad=null;
      if (token!==this.generation) return;
      worker.onerror=()=>this.stop('手勢辨識中斷，請重新啟動');
      worker.onmessage=({data})=> {
        if (token!==this.generation) return;
        this.busy=false;
        if (data.type==='error') { console.error('Hand Landmarker:',data.message); this.stop('手勢辨識中斷，請重新啟動'); return; }
        if (data.type!=='result') return;
        if (document.hidden || performance.now()-data.timestamp>300) { this.onReset(); this.setStatus('missing'); return; }
        this.onResult(data);
      };
      this.loading=false; this.running=true; this.busy=false;
      this.button.textContent='關閉攝影機'; this.button.setAttribute('aria-pressed','true');
      this.setStatus('missing','請舉起食指，收起其餘三指');
      this.lastVideoTime=-1; this.lastFrame=0; this.lastFresh=performance.now();
      const tick=now=> {
        if (token!==this.generation || !this.running) return;
        this.raf=requestAnimationFrame(tick);
        if (document.hidden) return;
        if (now-this.lastFresh>300) { this.onReset(); this.setStatus('missing'); }
        if (this.busy || now-this.lastFrame<1000/15 || this.video.readyState<2 || this.video.currentTime===this.lastVideoTime) return;
        this.lastFrame=now; this.lastVideoTime=this.video.currentTime; this.lastFresh=now; this.busy=true;
        const height=Math.max(1,Math.round(480*this.video.videoHeight/this.video.videoWidth));
        createImageBitmap(this.video,{resizeWidth:480,resizeHeight:height,resizeQuality:'low'}).then(frame=> {
          if(token!==this.generation) { frame.close(); return; }
          worker.postMessage({type:'frame',frame,timestamp:now},[frame]);
        }).catch(error=> { if(token===this.generation) { console.error(error); this.stop('此瀏覽器無法擷取畫面，可改用滑鼠'); } });
      };
      this.raf=requestAnimationFrame(tick);
    } catch(error) {
      if(token!==this.generation) return;
      console.error('Camera:',error);
      const message=error.name==='NotAllowedError' ? '攝影機權限未開啟，可改用滑鼠' : error.name==='NotFoundError' ? '找不到攝影機，可改用滑鼠' : error.name==='NotReadableError' ? '攝影機被占用，請關閉其他程式後重試' : '模型或攝影機啟動失敗，請確認網路後重試';
      this.stop(message);
    }
  }
}
