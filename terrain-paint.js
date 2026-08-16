// Paint layers for terrain-generator-v5: a signed height delta (world units) added after
// erosion, and a per-cell biome override (255 = none). Both live on the same res x res grid
// as the generated map so the pipeline can consume them directly. Brush maths follow
// ZyFou/ProceduralTerrains' PaintLayerManager (radial falloff, smoothstep feather, four
// shapes). Pure JS, no DOM; base64 serialization keeps project JSON small.

import { clamp, smoothstep, hash12 } from './terrain-noise.js';

export const PAINT_TOOLS = ['raise', 'lower', 'smooth', 'flatten', 'biome', 'erase'];
export const BRUSH_SHAPES = ['round', 'ellipse', 'ribbon', 'organic', 'scatter'];
export const NO_OVERRIDE = 255;

export const DEFAULT_BRUSH = { radius: 60, strength: 0.5, falloff: 0.6, shape: 'round', angle: 0 };

export class PaintLayers {
  constructor(resolution, worldX, worldZ) {
    this.resize(resolution, worldX, worldZ);
  }

  resize(resolution, worldX, worldZ) {
    const old = this.heightDelta ? { resolution: this.resolution, heightDelta: this.heightDelta, biomeOverride: this.biomeOverride } : null;
    this.resolution = resolution; this.worldX = worldX; this.worldZ = worldZ;
    const n = resolution * resolution;
    const heightDelta = new Float32Array(n);
    const biomeOverride = new Uint8Array(n).fill(NO_OVERRIDE);
    if (old && old.resolution !== resolution) {
      // Resample the old layers so a resolution change never throws paint away.
      const r0 = old.resolution;
      for (let iz = 0; iz < resolution; iz++) {
        const gz = (iz / Math.max(1, resolution - 1)) * (r0 - 1);
        const z0 = Math.min(r0 - 2, Math.floor(gz)), tz = gz - z0;
        for (let ix = 0; ix < resolution; ix++) {
          const gx = (ix / Math.max(1, resolution - 1)) * (r0 - 1);
          const x0 = Math.min(r0 - 2, Math.floor(gx)), tx = gx - x0;
          const a = old.heightDelta[z0 * r0 + x0], b = old.heightDelta[z0 * r0 + x0 + 1];
          const c = old.heightDelta[(z0 + 1) * r0 + x0], d = old.heightDelta[(z0 + 1) * r0 + x0 + 1];
          heightDelta[iz * resolution + ix] = a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
          biomeOverride[iz * resolution + ix] = old.biomeOverride[Math.round(gz) * r0 + Math.round(gx)];
        }
      }
    } else if (old) { heightDelta.set(old.heightDelta); biomeOverride.set(old.biomeOverride); }
    this.heightDelta = heightDelta;
    this.biomeOverride = biomeOverride;
  }

  isEmpty() {
    for (let i = 0; i < this.heightDelta.length; i++) if (this.heightDelta[i] !== 0) return false;
    for (let i = 0; i < this.biomeOverride.length; i++) if (this.biomeOverride[i] !== NO_OVERRIDE) return false;
    return true;
  }

  clear() { this.heightDelta.fill(0); this.biomeOverride.fill(NO_OVERRIDE); }

  snapshot() { return { heightDelta: Float32Array.from(this.heightDelta), biomeOverride: Uint8Array.from(this.biomeOverride) }; }
  restore(snap) {
    if (!snap || snap.heightDelta.length !== this.heightDelta.length) return false;
    this.heightDelta.set(snap.heightDelta); this.biomeOverride.set(snap.biomeOverride); return true;
  }

  // World (x, z) -> fractional grid coords.
  worldToGrid(x, z) {
    const r = this.resolution - 1;
    return [(x / this.worldX + 0.5) * r, (z / this.worldZ + 0.5) * r];
  }

  // Alpha in [0,1] for a texel at grid offset (dx, dz) from the brush centre, radius in cells.
  brushAlpha(dx, dz, radiusCells, brush) {
    const ang = (brush.angle || 0) * Math.PI / 180;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rx = dx * ca + dz * sa, rz = -dx * sa + dz * ca;
    let dist;
    switch (brush.shape) {
      case 'ellipse': dist = Math.hypot(rx / 1.65, rz * 1.2); break;
      case 'ribbon': dist = Math.max(Math.abs(rx) * 2.4, Math.abs(rz) * 0.7); break;
      case 'organic': {
        const a = Math.atan2(rz, rx);
        const wob = 1 + 0.18 * Math.sin(a * 3 + 0.7) + 0.12 * Math.sin(a * 7 - 1.3);
        dist = Math.hypot(rx, rz) / wob; break;
      }
      case 'scatter': {
        const keep = hash12(Math.floor(dx / 2), Math.floor(dz / 2)) < 0.35;
        if (!keep) return 0;
        dist = Math.hypot(rx, rz); break;
      }
      default: dist = Math.hypot(rx, rz);
    }
    const radial = 1 - dist / Math.max(radiusCells, 1e-6);
    if (radial <= 0) return 0;
    const f = clamp(brush.falloff, 0, 1);
    const shaped = f > 0 ? smoothstep(0, f, radial) : 1;
    return clamp(shaped * brush.strength, 0, 1);
  }

  // One stamp at world (x, z). `tool` from PAINT_TOOLS; `ctx` supplies baseHeight (Float32Array,
  // the pre-paint height so flatten/smooth can read the real ground) and biomeId (for biome).
  stamp(tool, x, z, brush, ctx = {}) {
    const res = this.resolution;
    const [gx, gz] = this.worldToGrid(x, z);
    const cellSize = this.worldX / Math.max(1, res - 1);
    const rc = brush.radius / cellSize;
    const x0 = Math.max(0, Math.floor(gx - rc)), x1 = Math.min(res - 1, Math.ceil(gx + rc));
    const z0 = Math.max(0, Math.floor(gz - rc)), z1 = Math.min(res - 1, Math.ceil(gz + rc));
    if (x1 < x0 || z1 < z0) return 0;
    const base = ctx.baseHeight || null;
    let target = 0;
    let src = null;
    if (tool === 'flatten') {
      const ci = clamp(Math.round(gz), 0, res - 1) * res + clamp(Math.round(gx), 0, res - 1);
      target = (base ? base[ci] : 0) + this.heightDelta[ci];
    }
    if (tool === 'smooth') src = Float32Array.from(this.heightDelta);
    const raiseStep = 18 * cellSize / 10;
    let touched = 0;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const a = this.brushAlpha(ix - gx, iz - gz, rc, brush);
        if (a <= 0) continue;
        const idx = iz * res + ix;
        touched++;
        switch (tool) {
          case 'raise': this.heightDelta[idx] += raiseStep * a; break;
          case 'lower': this.heightDelta[idx] -= raiseStep * a; break;
          case 'flatten': {
            const cur = (base ? base[idx] : 0) + this.heightDelta[idx];
            this.heightDelta[idx] += (target - cur) * a * 0.5; break;
          }
          case 'smooth': {
            let sum = 0, cnt = 0;
            for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
              const jx = ix + ox, jz = iz + oz;
              if (jx < 0 || jz < 0 || jx >= res || jz >= res) continue;
              const j = jz * res + jx;
              sum += (base ? base[j] : 0) + src[j]; cnt++;
            }
            const cur = (base ? base[idx] : 0) + src[idx];
            this.heightDelta[idx] += (sum / cnt - cur) * a; break;
          }
          case 'biome': if (a > 0.05) this.biomeOverride[idx] = ctx.biomeId ?? NO_OVERRIDE; break;
          case 'erase':
            this.heightDelta[idx] *= 1 - a;
            if (a > 0.05) this.biomeOverride[idx] = NO_OVERRIDE;
            break;
        }
      }
    }
    return touched;
  }

  serialize() {
    if (this.isEmpty()) return null;
    return {
      version: 1, resolution: this.resolution,
      heightDelta: bytesToBase64(new Uint8Array(this.heightDelta.buffer)),
      biomeOverride: bytesToBase64(this.biomeOverride),
    };
  }

  static deserialize(obj, worldX, worldZ) {
    if (!obj || !obj.resolution) return null;
    const layers = new PaintLayers(obj.resolution, worldX, worldZ);
    if (obj.heightDelta) layers.heightDelta.set(new Float32Array(base64ToBytes(obj.heightDelta).buffer));
    if (obj.biomeOverride) layers.biomeOverride.set(base64ToBytes(obj.biomeOverride));
    return layers;
  }
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(str) {
  if (typeof Buffer !== 'undefined') { const b = Buffer.from(str, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice(); }
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
