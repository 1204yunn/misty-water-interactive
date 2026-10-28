import { isYaGesture, YaHold } from './gestures.js';
import { savePhoto } from './photo-store.js';

// Enable only after mobile.html implements the IndexedDB photoId protocol.
export const messageBoard = Object.freeze({ url: '', photoImportReady: false });

// Called synchronously immediately after renderer.render, before WebGL discards
// its back buffer. Encoding uses the independent 2D snapshot, not a later frame.
export function captureComposite(canvas, logo) {
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width; snapshot.height = canvas.height;
  const ctx = snapshot.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  if (logo?.complete && logo.naturalWidth) {
    const glass = canvas.getBoundingClientRect(), box = logo.getBoundingClientRect();
    ctx.drawImage(logo, (box.left-glass.left)*canvas.width/glass.width,
      (box.top-glass.top)*canvas.height/glass.height,
      box.width*canvas.width/glass.width, box.height*canvas.height/glass.height);
  }
  return new Promise((resolve, reject) => snapshot.toBlob(blob => {
    if (blob) resolve({ blob, width: snapshot.width, height: snapshot.height });
    else reject(new Error('照片編碼失敗，請重新拍攝。'));
  }, 'image/png'));
}

export class PhotoBooth {
  constructor({ onResetPen, capture = captureComposite }) {
    this.onResetPen=onResetPen; this.capture=capture;
    this.hold=new YaHold(); this.stage='live'; this.holding=false; this.generation=0;
    this.countdown=document.querySelector('#photo-countdown');
    this.dialog=document.querySelector('#photo-preview');
    this.image=document.querySelector('#photo-image');
    this.message=document.querySelector('#photo-message');
    this.notice=document.querySelector('#photo-notice');
    this.retake=document.querySelector('#photo-retake');
    this.story=document.querySelector('#photo-story');
    this.retake.addEventListener('click',()=>this.retry());
    this.story.addEventListener('click',()=>this.save());
    this.dialog.addEventListener('cancel', event=> { event.preventDefault(); this.retry(); });
    document.addEventListener('visibilitychange',()=> { if(document.hidden) this.interrupt(); });
    window.addEventListener('pagehide',()=> { this.interrupt(); this.releaseImage(); });
  }
  get blocksDrawing() { return this.holding || this.stage!=='live'; }
  observe(data, ready) {
    const ya=data.landmarks ? isYaGesture(data.world || data.landmarks) : null;
    // Release can be observed during preview, but holding in preview cannot arm
    // another shutter. Retake also preserves the latch until YA is released.
    if (this.stage!=='live') {
      if (this.stage==='preview' && ya===false) this.hold.process(false,data.timestamp,data.hand);
      else this.hold.reset();
      return true;
    }
    const result=this.hold.process(ready ? ya : false,data.timestamp,data.hand);
    this.progress=result.progress || 0;
    this.holding=result.active;
    if (result.active) {
      this.onResetPen();
      this.notice.textContent=this.hold.locked ? '請先放下 YA 手勢，再重新舉起。' : '保持 YA 手勢 1.5 秒，準備拍照…';
      if (result.trigger) {
        this.stage='countdown'; this.deadline=performance.now()+3000;
        this.countdown.textContent='3'; this.countdown.hidden=false;
        this.notice.textContent='';
      }
    } else this.notice.textContent='';
    return result.active;
  }
  interrupt() {
    const wasBlocking=this.blocksDrawing;
    this.hold.reset(); this.holding=false;
    if (wasBlocking) this.onResetPen();
    if (this.stage==='live') this.notice.textContent='';
    if (this.stage==='countdown' || this.stage==='capturing') {
      this.generation++; this.stage='live'; this.countdown.hidden=true;
      this.notice.textContent='拍照已中止，請確認攝影機後重新比 YA。';
    }
  }
  // This never waits or blocks rendering. No stroke field is cleared here.
  afterRender(now, ready, canvas, logo) {
    if (this.stage!=='countdown') return;
    if (!ready) { this.interrupt(); return; }
    const remaining=this.deadline-now;
    if (remaining>0) { this.countdown.textContent=String(Math.ceil(remaining/1000)); return; }
    this.countdown.hidden=true; this.stage='capturing';
    const generation=++this.generation;
    let captured;
    try { captured=this.capture(canvas,logo); }
    catch(error) { captured=Promise.reject(error); }
    Promise.resolve(captured).then(photo=> {
      if (generation!==this.generation) return;
      this.photo=photo; this.savedId=null; this.releaseImage();
      this.imageUrl=URL.createObjectURL(photo.blob); this.image.src=this.imageUrl;
      this.message.textContent='這一刻只保留在你的裝置，尚未上傳。';
      this.stage='preview'; this.dialog.showModal(); this.retake.focus();
    }).catch(error=> {
      if (generation!==this.generation) return;
      console.error('Photo capture:',error); this.stage='live';
      this.notice.textContent='無法擷取照片，請確認攝影機並放下手勢後重試。';
    });
  }
  releaseImage() {
    if(this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl=null; this.image.removeAttribute('src');
  }
  retry() {
    if (this.saving) return;
    this.generation++; this.dialog.close(); this.releaseImage();
    this.photo=null; this.savedId=null; this.stage='live'; this.holding=false;
    this.hold.reset(); this.onResetPen(); this.countdown.hidden=true;
    this.notice.textContent='☝ 可繼續擦拭；拍照前請先解除 YA，再重新舉起。';
  }
  async save() {
    if (!this.photo || this.saving) return;
    this.saving=true; this.story.disabled=this.retake.disabled=true;
    this.message.textContent='正在儲存照片至此瀏覽器…';
    try {
      const record=await savePhoto(this.photo,this.savedId || undefined);
      this.savedId=record.id;
      const target=messageBoard.url ? new URL(messageBoard.url,location.href) : null;
      if (target && target.origin===location.origin && messageBoard.photoImportReady) {
        target.searchParams.set('photoId',record.id); location.assign(target.href);
      } else {
        this.message.textContent='照片已暫存於此瀏覽器。留言頁尚未完成同來源串接，暫時無法前往；照片仍保留，可稍後整合後繼續。';
      }
    } catch(error) {
      console.error('Local photo storage:',error);
      this.message.textContent='瀏覽器無法暫存照片（可能空間不足或隱私模式限制）。照片仍在此預覽中，請保留此頁並重試。';
    } finally {
      this.saving=false; this.story.disabled=this.retake.disabled=false;
    }
  }
}
