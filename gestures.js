const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0));
export function segmentCrossesRect(a,b,rect) {
  let low=0,high=1;
  for (const [start,delta,min,max] of [[a.x,b.x-a.x,rect.left,rect.right],[a.y,b.y-a.y,rect.top,rect.bottom]]) {
    if (Math.abs(delta)<1e-8) { if(start<min || start>max) return false; }
    else {
      const t1=(min-start)/delta,t2=(max-start)/delta;
      low=Math.max(low,Math.min(t1,t2)); high=Math.min(high,Math.max(t1,t2));
      if (low>high) return false;
    }
  }
  return true;
}
function angle(a,b,c) {
  const u = [a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0)];
  const v = [c.x-b.x,c.y-b.y,(c.z||0)-(b.z||0)];
  const length = Math.hypot(...u)*Math.hypot(...v);
  return length > 1e-8 ? Math.acos(Math.max(-1,Math.min(1,u.reduce((s,n,i)=>s+n*v[i],0)/length)))*180/Math.PI : 0;
}
function fingerPose(points, ya = false) {
  if (!points || points.length!==21 || points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(p.z??0))) return false;
  const palm = (distance(points[0],points[9])+distance(points[5],points[17]))/2;
  if (palm<1e-6) return false;
  const extended = (m,p,d,t) => {
    const length=distance(points[m],points[p])+distance(points[p],points[d])+distance(points[d],points[t]);
    return angle(points[m],points[p],points[d])>145
      && angle(points[p],points[d],points[t])>140
      && distance(points[m],points[t])/Math.max(length,1e-8)>.86
      && distance(points[0],points[t])>distance(points[0],points[m])+palm*.35;
  };
  const folded = (m,p,d,t) => {
    const length = distance(points[m],points[p])+distance(points[p],points[d])+distance(points[d],points[t]);
    const reach = distance(points[m],points[t])/Math.max(length,1e-8);
    return !extended(m,p,d,t) && (angle(points[m],points[p],points[d])<155 || reach<.82)
      && distance(points[0],points[t])<distance(points[0],points[p])+palm*.3;
  };
  // Thumb deliberately unconstrained; the ring and little fingers must fold.
  return extended(5,6,7,8) && (ya ? extended(9,10,11,12) : folded(9,10,11,12)) && folded(13,14,15,16) && folded(17,18,19,20);
}

export const isOneGesture = points => fingerPose(points);
export const isYaGesture = points => fingerPose(points, true);

// Monotonic inference timestamps, uninterrupted frames, and one trigger per pose.
export class YaHold {
  constructor() { this.locked=false; this.reset(); }
  reset() { this.since=null; this.last=null; this.hand=''; this.elapsed=0; this.missing=false; }
  process(ya, time, hand='') {
    // null means no landmarks, false means a positively observed other pose.
    if (ya===null && Number.isFinite(time)) {
      if (this.last!==null && time>=this.last && time-this.last<=200) {
        this.missing=true;
        return {active:true,trigger:false,progress:Math.min(1,this.elapsed/1500)};
      }
      this.reset(); return {active:false,trigger:false,progress:0};
    }
    if (!ya || !Number.isFinite(time)) {
      this.reset(); this.locked=false; return {active:false,trigger:false};
    }
    if (this.last!==null && (time<=this.last || time-this.last>250 || hand!==this.hand)) this.reset();
    if (this.last!==null && !this.missing) this.elapsed+=time-this.last;
    this.last=time; this.hand=hand; this.missing=false;
    if (this.locked) return {active:true,trigger:false};
    if (this.since===null) this.since=time;
    const trigger=this.elapsed>=1500;
    if (trigger) this.locked=true;
    return {active:true,trigger,progress:Math.min(1,this.elapsed/1500)};
  }
}

export class GesturePen {
  constructor() { this.reset(); }
  reset() { this.point=null; this.raw=null; this.validFrames=0; this.hand=''; }
  process(landmarks,world,time,hand='') {
    if (!landmarks && this.raw && time>=this.raw.time && time-this.raw.time<=200) {
      // Retain smoothing briefly, but never paint or extrapolate a missing hand.
      return {state:'missing'};
    }
    if (!landmarks || !isOneGesture(world || landmarks)) {
      this.reset(); return {state:landmarks ? 'detected' : 'missing'};
    }
    const tip = landmarks[8];
    const raw = {x:1-tip.x,y:tip.y,time}; // Mirrored front-facing camera, no second CSS flip.
    if (raw.x<0 || raw.x>1 || raw.y<0 || raw.y>1) { this.reset(); return {state:'detected'}; }
    const gap = this.raw ? time-this.raw.time : 0;
    const jump = this.raw ? Math.hypot(raw.x-this.raw.x,raw.y-this.raw.y) : 0;
    if (this.hand!==hand || gap>250 || jump>Math.max(.14,gap/1000*2.5)) this.reset();
    this.hand=hand; this.raw=raw; this.validFrames++;
    if (this.validFrames<2) { this.point=raw; return {state:'detected'}; }
    const previous = this.point;
    const dt = Math.max(.008,(time-previous.time)/1000);
    const motion = Math.hypot(raw.x-previous.x,raw.y-previous.y);
    const alpha = 1-Math.exp(-dt*(motion>.025 ? 22 : 10));
    const next = {x:previous.x+(raw.x-previous.x)*alpha,y:previous.y+(raw.y-previous.y)*alpha,time};
    // Small dead band rejects stationary finger jitter; don't repaint a growing blob.
    if (Math.hypot(next.x-previous.x,next.y-previous.y)<.0018) {
      this.point={...previous,time}; return {state:'drawing',point:this.point};
    }
    this.point=next;
    return {state:'drawing',point:next,from:this.validFrames===2 ? next : previous};
  }
}
