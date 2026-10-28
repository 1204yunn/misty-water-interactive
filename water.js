// Lightweight CPU motion + two low-resolution height/track maps.
// Coordinates use screen-height units, with +y pointing upward (as in GLSL).
import { drawingDensity } from './condensation.js';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mod = (x, n) => ((x % n) + n) % n;
const smooth = x => { x = clamp(x, 0, 1); return x*x*(3-2*x); };

// Keep this integer hash in sync with hash22 in main.js's fragment shader.
export function condensationHash(x, y, seed) {
  const a = mod(mod(Math.floor(x),2039)*127 + mod(Math.floor(y),2039)*311 + seed*17,2039);
  const b = mod(a*a+a*13+73,2039);
  return [b/2039, mod(b*b+b*19+199,2039)/2039];
}

export class SlidingWater {
  constructor(parameters, seed, regions = null) {
    this.parameters = parameters;
    this.regions = regions;
    this.bodyCanvas = document.createElement('canvas');
    this.trackCanvas = document.createElement('canvas');
    this.body = this.bodyCanvas.getContext('2d');
    this.tracks = this.trackCanvas.getContext('2d');
    this.aspect = 1;
    this.reset(seed);
  }

  random() {
    // Deterministic independent sequences: parameter changes don't reset motion.
    this.randomState = (Math.imul(this.randomState,1664525)+1013904223) >>> 0;
    return this.randomState/4294967296;
  }

  reset(seed) {
    this.seed = seed;
    this.randomState = seed+1;
    this.time = 0;
    this.drops = [];
    this.segments = [];
    this.merges = 0;
    this.spawnCount = 0;
    this.condensation = [];
    this.layoutKey = '';
    this.dirty = true;
    this.lastPaint = -1;
    this.makeCondensation();
  }

  resize(aspect) {
    if (Math.abs(aspect-this.aspect) > .001) {
      // Preserve normalized horizontal positions when rotating a phone.
      const ratio = aspect/this.aspect;
      for (const drop of this.drops) { drop.x *= ratio; drop.anchorX *= ratio; drop.lastX *= ratio; }
      for (const segment of this.segments) { segment.x1 *= ratio; segment.x2 *= ratio; }
      this.aspect = aspect;
      this.layoutKey = '';
    }
    // Small CPU-generated maps; full-screen shading remains GPU-side.
    const h = Math.round(Math.min(512,768/Math.max(1,aspect)));
    this.bodyCanvas.height = this.trackCanvas.height = h;
    this.bodyCanvas.width = this.trackCanvas.width = Math.max(1,Math.round(h*aspect));
    this.makeCondensation();
    this.dirty = true;
  }

  makeCondensation() {
    const {density,size} = this.parameters;
    const key = `${density}/${size}/${this.aspect}/${this.seed}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const old = new Map((this.condensation || []).map(d => [d.id,d.absorbedUntil]));
    this.condensation = [];
    for (const [scale,layer] of [[8,1],[20,5]]) {
      for (let y = -1; y <= scale; y++) {
        for (let x = -1; x <= Math.ceil(this.aspect*scale); x++) {
          const [a,b] = condensationHash(x+layer*31.7,y+layer*31.7,this.seed);
          const center = condensationHash(x+91.3+layer,y+91.3+layer,this.seed);
          const field = drawingDensity((x+.18+.64*center[0])/scale/this.aspect,(y+.18+.64*center[1])/scale);
          const distribution = scale===8 ? .55+.45*(field-.35)/.65 : field;
          if (a > density*.82*distribution) continue;
          const id = `${scale}/${x}/${y}`;
          this.condensation.push({
            id, x:(x+.18+.64*center[0])/scale, y:(y+.18+.64*center[1])/scale,
            radius:size*(.065+.235*Math.pow(b,1.7))/scale,
            scale, absorbedUntil:old.get(id) || 0,
          });
        }
      }
    }
  }

  spawn(index) {
    const anchors = this.condensation.filter(d => d.scale === 8 && d.radius > .016*this.parameters.size
      && d.y > .15 && d.y < .98 && d.x > .02 && d.x < this.aspect-.02 && d.absorbedUntil <= this.time
      && this.drops.every(other => Math.hypot(other.x-d.x,other.y-d.y) > .1));
    // Portrait screens may only budget one moving bead: alternate its births.
    const passage = index===1 || (this.target===1 && this.spawnCount%2===0);
    this.spawnCount++;
    const anchor = !passage && anchors.length ? anchors[Math.floor(this.random()*anchors.length)] : null;
    const birth = !passage && this.regions && (index === 0 || this.random()<.65) ? this.regions.birth(()=>this.random()) : null;
    const x = passage ? (.42+.16*this.random())*this.aspect : birth ? birth.x : anchor ? anchor.x : (.1+.8*this.random())*this.aspect;
    const y = passage ? 1.02 : birth ? birth.y : anchor ? anchor.y : .45+.5*this.random();
    const radius = (birth ? .025+this.random()*.01 : anchor ? anchor.radius/this.parameters.size : .023)*(1.05+this.random()*.2);
    const growthDuration = birth ? 10+this.random()*12 : 0;
    const wait = birth ? growthDuration+1+this.random()*3 : index < 2 ? 0 : this.random()*22;
    if (anchor && !birth) {
      anchor.absorbedUntil = this.time+50;
      this.segments.push({x1:x,y1:y,x2:x,y2:y+.0001,r:radius*this.parameters.size,time:this.time,spot:true});
    }
    return {
      x,y,anchorX:x,lastX:x,lastY:y,baseRadius:radius,radius:radius*this.parameters.size,
      volume:1,targetVolume:1,velocity:passage ? .028 : .007+this.random()*.015,
      phase:this.random()*Math.PI*2, distance:0, runLength:passage ? 1.2 : .16+this.random()*.48,
      wait,age:0, fade:0,retiring:false,mergeAfter:this.time+1+this.random()*4,
      growthDuration,growth:birth ? .12 : 1,fromRegion:!!birth,
    };
  }

  update(dt) {
    const previousKey = this.layoutKey;
    this.makeCondensation();
    if (previousKey !== this.layoutKey) this.dirty = true;
    const eligible = this.condensation.filter(d => d.scale === 8 && d.radius > .016*this.parameters.size).length;
    // Ratio refers to the larger beads, bounded to keep phone fill cost steady.
    const target = this.parameters.slideRatio === 0 ? 0 : Math.min(14,Math.max(1,Math.round(eligible*this.parameters.slideRatio)));
    if (target !== this.target) { this.target = target; this.dirty = true; this.lastPaint = -1; }
    for (let i = 0; i < this.drops.length; i++) this.drops[i].retiring = i >= target;
    while (this.drops.length < target) this.drops.push(this.spawn(this.drops.length));
    if (dt <= 0) return;
    this.time += dt;
    this.dirty = true;
    for (const drop of this.drops) {
      drop.age += dt;
      drop.fade = clamp(drop.fade + dt*(drop.retiring ? -1 : .5),0,1);
      drop.volume += (drop.targetVolume-drop.volume)*(1-Math.exp(-dt*2.2));
      drop.growth = drop.growthDuration ? .12+.88*smooth(drop.age/drop.growthDuration) : 1;
      drop.radius = drop.baseRadius*this.parameters.size*Math.cbrt(drop.volume)*drop.growth;
      if (drop.retiring) continue;
      if (drop.wait > 0) { drop.wait -= dt; continue; }
      // Slow independent stick-slip motion; no shared sine or global reset.
      const pulse = .68+.32*smooth((Math.sin(drop.age*.7+drop.phase)+1)*.5);
      const distance = drop.velocity*pulse*dt*(1+.12*(drop.volume-1));
      drop.y -= distance;
      drop.distance += distance;
      drop.x = clamp(drop.anchorX+Math.sin(drop.age*.23+drop.phase)*drop.radius*.16,drop.radius,this.aspect-drop.radius);
      if (Math.hypot(drop.x-drop.lastX,drop.y-drop.lastY) > .003) {
        this.segments.push({x1:drop.lastX,y1:drop.lastY,x2:drop.x,y2:drop.y,r:drop.radius,time:this.time});
        drop.lastX = drop.x; drop.lastY = drop.y;
      }
      // A bead can only be absorbed once until it has recondensed.
      // Check actual shader bead centers, not arbitrary timed growth events.
      if (this.time > drop.mergeAfter) {
        const nearby = this.condensation.find(bead => bead.radius < drop.radius*.72
          && bead.absorbedUntil <= this.time && bead.y <= drop.y+drop.radius*.65
          && Math.hypot(bead.x-drop.x,bead.y-drop.y) < drop.radius*.8+bead.radius*.3);
        if (nearby) {
          nearby.absorbedUntil = this.time+50;
          drop.targetVolume = Math.min(3.4,drop.targetVolume+Math.pow(nearby.radius/(drop.baseRadius*this.parameters.size),3));
          drop.mergeAfter = this.time+1.2+this.random()*2.5;
          this.segments.push({x1:nearby.x,y1:nearby.y,x2:nearby.x,y2:nearby.y+.0001,r:nearby.radius,time:this.time,spot:true});
          this.merges++;
        }
      }
      if (drop.distance > drop.runLength) {
        drop.wait = 3+this.random()*13;
        drop.distance = 0; drop.runLength = .12+this.random()*.38;
      }
      if (drop.y < -drop.radius*5) drop.retiring = true;
    }
    this.drops = this.drops.filter(drop => !(drop.retiring && drop.fade <= 0) && drop.y >= -drop.radius*5);
    // Bounded memory: paths last 50 simulation seconds, maximum 640 segments.
    this.segments = this.segments.filter(s => this.time-s.time < 50).slice(-640);
  }

  paint() {
    // Limit map uploads to 30 fps. Parameter changes still render while paused.
    const shapeKey = `${this.parameters.size}/${this.parameters.tailLength}`;
    if (shapeKey !== this.shapeKey) { this.shapeKey = shapeKey; this.dirty = true; }
    if (!this.dirty || (this.lastPaint >= 0 && this.time-this.lastPaint < 1/30 && shapeKey === this.paintedShapeKey)) return false;
    this.lastPaint = this.time;
    this.paintedShapeKey = shapeKey;
    this.dirty = false;
    const h = this.bodyCanvas.height, w = this.bodyCanvas.width;
    const ctx = this.body;
    ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#000'; ctx.fillRect(0,0,w,h);
    // Alpha union keeps the lens dome from clipping to a flat white plateau.
    ctx.globalCompositeOperation = 'source-over';
    for (const drop of this.drops) {
      const r = drop.baseRadius*this.parameters.size*Math.cbrt(drop.volume)*drop.growth*h;
      const x = drop.x*h, y = (1-drop.y)*h;
      const opacity = smooth(drop.fade);
      // Canvas +y points down: keep the rounded lens below its trailing neck.
      // Only the tail uses negative y; simulation still moves the body downward.
      const tail = r*this.parameters.tailLength*(drop.fromRegion && drop.wait > 0 ? 0 : drop.wait > 0 ? .55 : 1.65);
      ctx.save(); ctx.translate(x,y);
      if (tail > .1) {
        const gradient = ctx.createLinearGradient(0,0,0,-r-tail);
        gradient.addColorStop(0,`rgba(255,255,255,${opacity*.62})`);
        gradient.addColorStop(.45,`rgba(255,255,255,${opacity*.25})`);
        gradient.addColorStop(1,'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath(); ctx.moveTo(-r*.64,r*.05);
        ctx.bezierCurveTo(-r*.5,-r*.6,-r*.13,-r-tail*.65,0,-r-tail);
        ctx.bezierCurveTo(r*.13,-r-tail*.65,r*.5,-r*.6,r*.64,r*.05);
        ctx.closePath(); ctx.fill();
      }
      ctx.scale(.85,1.12);
      const gradient = ctx.createRadialGradient(0,-r*.08,0,0,0,r);
      gradient.addColorStop(0,`rgba(255,255,255,${opacity*.92})`);
      gradient.addColorStop(.48,`rgba(255,255,255,${opacity*.82})`);
      gradient.addColorStop(.78,`rgba(255,255,255,${opacity*.53})`);
      gradient.addColorStop(.94,`rgba(255,255,255,${opacity*.22})`);
      gradient.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }
    const tracks = this.tracks;
    tracks.globalCompositeOperation = 'source-over'; tracks.fillStyle = '#000'; tracks.fillRect(0,0,w,h);
    tracks.globalCompositeOperation = 'lighter'; tracks.lineCap = 'round';
    for (const segment of this.segments) {
      const age = this.time-segment.time;
      const clear = Math.round(255*clamp(1-age/50,0,1));
      tracks.beginPath(); tracks.moveTo(segment.x1*h,(1-segment.y1)*h); tracks.lineTo(segment.x2*h,(1-segment.y2)*h);
      // Red clears the encountered stationary beads and regrows them slowly.
      tracks.strokeStyle = `rgb(${clear},0,0)`;
      tracks.lineWidth = Math.max(2,segment.r*h*(segment.spot ? .9 : 1.5)); tracks.stroke();
      if (!segment.spot) {
        // Deposit wetness behind the upper shoulder, along the recorded path.
        // World +y points up, so adding this offset keeps wetness above the lens.
        const behind = segment.r*.65;
        tracks.beginPath();
        tracks.moveTo(segment.x1*h,(1-segment.y1-behind)*h);
        tracks.lineTo(segment.x2*h,(1-segment.y2-behind)*h);
        // Green is a separate, much narrower and shorter-lived wet streak.
        const wet = Math.round(100*Math.exp(-age/7));
        tracks.strokeStyle = `rgb(0,${wet},0)`;
        tracks.lineWidth = Math.max(.8,segment.r*h*.24); tracks.stroke();
        tracks.strokeStyle = `rgb(0,${Math.round(wet*.2)},0)`;
        tracks.lineWidth = Math.max(1.5,segment.r*h*.48); tracks.stroke();
      }
    }
    return true;
  }
}
