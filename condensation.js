// Cached, low-resolution moisture field, shared by the shader and drop births.
const smooth = t => { t = Math.max(0,Math.min(1,t)); return t*t*(3-2*t); };
// Normalized screen coordinates; cached in the field's otherwise unused B channel.
export function drawingDensity(x,y) {
  const wx = x-.5+.012*Math.sin(y*23)+.009*Math.sin(x*31+y*11);
  const wy = y-.5+.014*Math.sin(x*19)-.008*Math.cos(y*29+x*7);
  const radius = Math.pow(Math.pow(wx/.29,4)+Math.pow(wy/.275,4),.25);
  return .35+.65*smooth((radius-.98)/.4);
}
export class CondensationRegions {
  constructor(parameters, seed) {
    this.parameters = parameters;
    this.canvas = document.createElement('canvas');
    this.aspect = 1;
    this.reset(seed);
  }
  reset(seed) { this.seed = seed; this.key = ''; }
  noise(x,y) {
    const hash = (a,b) => {
      let n = Math.imul(a,374761393)^Math.imul(b,668265263)^Math.imul(this.seed+1,1274126177);
      n = Math.imul(n^(n>>>13),1274126177);
      return ((n^(n>>>16))>>>0)/4294967296;
    };
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x-ix), fy = smooth(y-iy);
    return (hash(ix,iy)*(1-fx)+hash(ix+1,iy)*fx)*(1-fy)
      +(hash(ix,iy+1)*(1-fx)+hash(ix+1,iy+1)*fx)*fy;
  }
  sample(x,y) {
    let value = 0;
    const size = this.parameters.regionSize;
    for (const zone of this.zones) {
      const wx = (this.noise(x*7+19,y*7)-.5)*.09*size;
      const wy = (this.noise(x*7,y*7+37)-.5)*.09*size;
      const dx = x-zone.x+wx, dy = y-zone.y+wy;
      const c = Math.cos(zone.angle), s = Math.sin(zone.angle);
      const qx = (dx*c-dy*s)/(zone.rx*size), qy = (dx*s+dy*c)/(zone.ry*size);
      const edge = .82+.35*this.noise(x*16+zone.id*7,y*16);
      const patch = (1-smooth((Math.hypot(qx,qy)/edge-.13)/1.05));
      value = 1-(1-value)*(1-patch*zone.weight);
    }
    return value*this.parameters.regionIntensity;
  }
  update(aspect) {
    this.aspect = aspect;
    const p = this.parameters;
    const key = [this.seed,aspect,p.regionCount,p.regionIntensity,p.regionSize].join('/');
    if (key === this.key) return false;
    this.key = key;
    this.zones = [];
    for (let i=0;i<p.regionCount;i++) {
      // Different lobes along all four edges, with the original warped contours.
      const a = this.noise(i*17+3,19), b = this.noise(i*11+7,43);
      const side = i%4;
      const along = .2+.6*a, edge = .065+.065*b;
      const x = side===0 ? along : side===1 ? 1-edge : side===2 ? 1-along : edge;
      const y = side===0 ? 1-edge : side===1 ? along : side===2 ? edge : 1-along;
      this.zones.push({ id:i,x:x*aspect,y,
        rx:(.1+.1*this.noise(i*7,3))*(side%2===0 ? Math.min(aspect,1.7) : 1),ry:.11+.12*this.noise(i*13,7),
        angle:a*6.28,weight:.65+.3*b });
    }
    const h = Math.round(Math.min(192,384/Math.max(1,aspect)));
    const w = Math.max(1,Math.round(h*aspect));
    this.canvas.width = w; this.canvas.height = h;
    const ctx = this.canvas.getContext('2d');
    const pixels = ctx.createImageData(w,h);
    for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
      const px = (x+.5)/h, py = 1-(y+.5)/h;
      const density = .4+.6*this.noise(px*31,py*31);
      const i = (y*w+x)*4, moisture = this.sample(px,py);
      pixels.data[i] = Math.round(moisture*255);
      const distribution = drawingDensity((x+.5)/w,py);
      pixels.data[i+1] = Math.round(moisture*density*distribution*255);
      pixels.data[i+2] = Math.round(distribution*255);
      pixels.data[i+3] = 255;
    }
    ctx.putImageData(pixels,0,0);
    return true;
  }
  birth(random) {
    if (!this.zones.length || this.parameters.regionIntensity < .05) return null;
    // Rejection sampling favors moist interiors while retaining irregular spread.
    for (let i=0;i<70;i++) {
      const zone = this.zones[Math.floor(random()*this.zones.length)];
      const x = zone.x+(random()-.5)*zone.rx*this.parameters.regionSize;
      const y = zone.y+(random()-.5)*zone.ry*this.parameters.regionSize;
      if (x>.025 && x<this.aspect-.025 && y>.12 && y<.97 && this.sample(x,y)>.24*random()+.1) return {x,y};
    }
    return null;
  }
}
