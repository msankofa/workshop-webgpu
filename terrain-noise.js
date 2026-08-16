// Pure noise primitives for terrain-generator-v5's layer stack. No Three.js, no DOM.
// Math follows the ZyFou/ProceduralTerrains GLSL vocabulary (Dave Hoskins hash, quintic
// value noise, ROT2-decorrelated fractals with an optional gradient-feedback erosion
// look, Worley cells, terrace, domain warp) so a future TSL twin can mirror it 1:1.

function fract(v) { return v - Math.floor(v); }
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / Math.max(e1 - e0, 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}
export function mix(a, b, t) { return a + (b - a) * t; }

// Dave Hoskins hash12: 2D -> [0,1).
export function hash12(x, y) {
  let px = fract(x * 0.1031), py = fract(y * 0.1031), pz = fract(x * 0.1031);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d; py += d; pz += d;
  return fract((px + py) * pz);
}

// Quintic value noise, output [0,1].
export function vnoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash12(ix, iy), b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

// Value noise with analytic derivative: returns [value, d/dx, d/dy].
export function vnoised2(x, y, out = [0, 0, 0]) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = hash12(ix, iy), b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
  const k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  out[0] = a + k1 * ux + k2 * uy + k3 * ux * uy;
  out[1] = dux * (k1 + k3 * uy);
  out[2] = duy * (k2 + k3 * ux);
  return out;
}

// Per-octave lattice rotation so octaves never share axis-aligned artefacts.
const R00 = 0.80, R01 = -0.60, R10 = 0.60, R11 = 0.80;

// Fractal Brownian motion, normalized to [0,1]. `erosion`/`warp` enable the gradient
// feedback branch: the running derivative damps amplitude on steep slopes and self-warps
// the sample point, a cheap flow-eroded look with no simulation.
export function fbm2(x, y, { octaves = 5, persistence = 0.5, lacunarity = 2.0, erosion = 0, warp = 0 } = {}) {
  const oct = Math.max(1, Math.round(octaves));
  let sum = 0, norm = 0, amp = 1, qx = x, qy = y, dx = 0, dy = 0;
  const feedback = erosion > 0 || warp > 0;
  const tmp = [0, 0, 0];
  for (let i = 0; i < oct; i++) {
    let v;
    if (feedback) {
      vnoised2(qx + dx * warp, qy + dy * warp, tmp);
      v = tmp[0]; dx += tmp[1] * amp; dy += tmp[2] * amp;
      v *= 1 / (1 + erosion * 4 * (dx * dx + dy * dy));
    } else v = vnoise2(qx, qy);
    sum += amp * v; norm += amp; amp *= persistence;
    const nx = (R00 * qx + R01 * qy) * lacunarity, ny = (R10 * qx + R11 * qy) * lacunarity;
    qx = nx; qy = ny;
  }
  return sum / Math.max(norm, 1e-4);
}

// Ridged multifractal in [0,1]: folded noise raised to `sharpness`, each octave gated by
// the previous one so valleys stay quiet.
export function ridged2(x, y, { octaves = 5, persistence = 0.5, lacunarity = 2.0, sharpness = 2.0, erosion = 0, warp = 0 } = {}) {
  const oct = Math.max(1, Math.round(octaves));
  let sum = 0, norm = 0, amp = 1, carry = 1, qx = x, qy = y, dx = 0, dy = 0;
  const feedback = erosion > 0 || warp > 0;
  const tmp = [0, 0, 0];
  for (let i = 0; i < oct; i++) {
    let n;
    if (feedback) {
      vnoised2(qx + dx * warp, qy + dy * warp, tmp);
      n = tmp[0]; dx += tmp[1] * amp; dy += tmp[2] * amp;
    } else n = vnoise2(qx, qy);
    let v = 1 - Math.abs(n * 2 - 1);
    v = Math.pow(Math.max(v, 0), sharpness) * carry;
    if (feedback) v *= 1 / (1 + erosion * 4 * (dx * dx + dy * dy));
    carry = clamp(v * 1.4, 0, 1);
    sum += amp * v; norm += amp; amp *= persistence;
    const nx = (R00 * qx + R01 * qy) * lacunarity, ny = (R10 * qx + R11 * qy) * lacunarity;
    qx = nx; qy = ny;
  }
  return sum / Math.max(norm, 1e-4);
}

// Billow: abs-folded noise, puffy rounded shapes in [0,1].
export function billow2(x, y, { octaves = 5, persistence = 0.5, lacunarity = 2.0 } = {}) {
  const oct = Math.max(1, Math.round(octaves));
  let sum = 0, norm = 0, amp = 1, qx = x, qy = y;
  for (let i = 0; i < oct; i++) {
    sum += amp * Math.abs(vnoise2(qx, qy) * 2 - 1); norm += amp; amp *= persistence;
    const nx = (R00 * qx + R01 * qy) * lacunarity, ny = (R10 * qx + R11 * qy) * lacunarity;
    qx = nx; qy = ny;
  }
  return sum / Math.max(norm, 1e-4);
}

// Worley cells. distanceMode: 0 euclid, 1 manhattan, 2 chebyshev. outputMode: 0 cell id,
// 1 F1, 2 F2-F1 (edges dark), 3 edge lines. Output roughly [0,1].
export function voronoi2(x, y, { jitter = 1, distanceMode = 0, outputMode = 1 } = {}) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  let f1 = 8, f2 = 8, cell = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ox = i + hash12(ix + i, iy + j) * jitter - fx;
      const oy = j + hash12(ix + i + 7.3, iy + j + 3.1) * jitter - fy;
      let d;
      if (distanceMode === 1) d = Math.abs(ox) + Math.abs(oy);
      else if (distanceMode === 2) d = Math.max(Math.abs(ox), Math.abs(oy));
      else d = Math.sqrt(ox * ox + oy * oy);
      if (d < f1) { f2 = f1; f1 = d; cell = hash12(ix + i + 11.7, iy + j + 5.9); }
      else if (d < f2) f2 = d;
    }
  }
  if (outputMode === 0) return cell;
  if (outputMode === 2) return clamp(f2 - f1, 0, 1);
  if (outputMode === 3) return 1 - smoothstep(0, 0.08, f2 - f1);
  return clamp(f1, 0, 1);
}

// Quantize h (any units) into `steps` per `stepHeight` with a smoothstep riser.
export function terrace(h, { stepHeight = 10, smoothness = 0.35, strength = 1 } = {}) {
  if (stepHeight <= 0 || strength <= 0) return h;
  const t = h / stepHeight;
  const f = t - Math.floor(t);
  const lo = clamp(0.5 - smoothness * 0.5, 0, 0.5), hi = clamp(0.5 + smoothness * 0.5, 0.5, 1);
  const s = smoothstep(lo, hi, f);
  const terr = (Math.floor(t) + s) * stepHeight;
  return mix(h, terr, clamp(strength, 0, 1));
}

// Domain warp offset (world units): two decorrelated fbm fields, recentred.
export function domainWarp2(x, y, { scale = 400, amount = 60, octaves = 3 } = {}, out = [0, 0]) {
  const s = 1 / Math.max(scale, 1e-6);
  const wx = fbm2(x * s + 13.7, y * s + 41.3, { octaves }) - 0.5;
  const wy = fbm2(x * s + 87.2, y * s + 9.1, { octaves }) - 0.5;
  out[0] = wx * 2 * amount; out[1] = wy * 2 * amount;
  return out;
}

// Seed -> bounded domain offset. Integer avalanche hash so nearby seeds land far apart,
// bounded to +/-1024 so float precision never collapses into visible lattice cells.
export function seedDomainOffset(seed) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2048 - 1024;
}

export const BLEND_MODES = ['add', 'subtract', 'multiply', 'max', 'min', 'replace', 'overlay', 'carve', 'flatten'];

// Fold `v` (layer output, already scaled by strength) into accumulated `acc`.
// `k` is opacity in [0,1]. `carve` only lowers, `flatten` pulls acc toward v.
export function applyBlend(mode, acc, v, k = 1) {
  let r;
  switch (mode) {
    case 'subtract': r = acc - v; break;
    case 'multiply': r = acc * v; break;
    case 'max': r = Math.max(acc, v); break;
    case 'min': r = Math.min(acc, v); break;
    case 'replace': r = v; break;
    case 'overlay': r = acc + v * (acc >= 0 ? 1 : -1); break;
    case 'carve': r = Math.min(acc, acc - Math.abs(v)); break;
    case 'flatten': r = mix(acc, v, 0.5); break;
    default: r = acc + v;
  }
  return mix(acc, r, clamp(k, 0, 1));
}
