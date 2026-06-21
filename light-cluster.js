// light-cluster.js
// Pure-JS froxel (3D clustered) light-culling math for SP4a — no three.js. The CPU source
// of truth the TSL compute kernels transcribe, and the Node-tested guard. Froxel grid =
// tilesX×tilesY screen tiles × Z exponential depth slices (Olsson&Assarsson 2012); light
// culling uses the Drobot (SIGGRAPH 2017) Z-bin + per-tile bitmask scheme so a froxel's
// light set is (depth-slice index range) ∩ (screen-tile bitmask), with no per-froxel index
// lists. All view-space: camera looks down -Z, so a light in front has negative z and
// "view depth" d = -z > 0.

// Exponential depth slice index for a view depth d>0. near→0, far→zSlices-1, clamped.
export function zSlice(d, cfg) {
  const { near, far, zSlices } = cfg;
  if (d <= near) return 0;
  const s = Math.floor(Math.log(d / near) / Math.log(far / near) * zSlices);
  return Math.max(0, Math.min(zSlices - 1, s));
}

// [dNear, dFar] view-depth range of slice s (inverse of zSlice).
export function sliceDepthRange(s, cfg) {
  const { near, far, zSlices } = cfg;
  const ratio = far / near;
  return { dNear: near * ratio ** (s / zSlices), dFar: near * ratio ** ((s + 1) / zSlices) };
}

// View-space AABB of froxel (tx,ty,slice): unproject the tile's NDC corners at the slice's
// near/far depths (perspective), take the bounds of the 8 points.
export function froxelViewAABB(tx, ty, s, cfg) {
  const { tile, screenW, screenH, tanHalfFovY, aspect } = cfg;
  const ndc = (px, dim) => 2 * Math.min(px, dim) / dim - 1;
  const nx0 = ndc(tx * tile, screenW), nx1 = ndc((tx + 1) * tile, screenW);
  const ny0 = ndc(ty * tile, screenH), ny1 = ndc((ty + 1) * tile, screenH);
  const { dNear, dFar } = sliceDepthRange(s, cfg);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const d of [dNear, dFar]) {
    for (const nx of [nx0, nx1]) {
      for (const ny of [ny0, ny1]) {
        const x = nx * d * tanHalfFovY * aspect;
        const y = ny * d * tanHalfFovY;
        const z = -d;
        min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
        min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
        min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
      }
    }
  }
  return { min, max };
}

export function sphereIntersectsAABB(c, r, min, max) {
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const v = c[i];
    if (v < min[i]) d2 += (min[i] - v) ** 2;
    else if (v > max[i]) d2 += (v - max[i]) ** 2;
  }
  return d2 <= r * r;
}

// Brute-force exact per-froxel assignment (sphere vs froxel AABB) — the test reference.
export function assignLightsExact(lights, cfg, tilesX, tilesY) {
  const out = {};
  for (let s = 0; s < cfg.zSlices; s++) {
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const aabb = froxelViewAABB(tx, ty, s, cfg);
        for (let li = 0; li < lights.length; li++) {
          if (sphereIntersectsAABB(lights[li].v, lights[li].r, aabb.min, aabb.max)) {
            (out[`${tx},${ty},${s}`] ||= []).push(li);
          }
        }
      }
    }
  }
  return out;
}

// Z-bins: per slice, the [min,max] index range (in the depth-SORTED light order) whose view-
// depth sphere range overlaps the slice. A conservative contiguous range (Drobot).
export function buildZBins(sortedLights, cfg) {
  const bins = [];
  for (let s = 0; s < cfg.zSlices; s++) {
    const { dNear, dFar } = sliceDepthRange(s, cfg);
    let mn = Infinity, mx = -1;
    for (let p = 0; p < sortedLights.length; p++) {
      const L = sortedLights[p];
      const d = -L.v[2];
      const lo = d - L.r, hi = d + L.r;       // light's view-depth span
      if (lo <= dFar && hi >= dNear) { mn = Math.min(mn, p); mx = Math.max(mx, p); }
    }
    bins.push({ min: mn, max: mx });
  }
  return bins;
}

// Per-tile bitmask: bit `li` set in tile (tx,ty) if light li's screen projection overlaps it.
// Radius is projected at the sphere's NEAREST depth (largest screen footprint) → conservative.
export function buildTileBitmask(lights, cfg, tilesX, tilesY) {
  const { tile, screenW, screenH, tanHalfFovY, aspect, near } = cfg;
  const wordsPerTile = Math.max(1, Math.ceil(lights.length / 32));
  const bits = new Uint32Array(wordsPerTile * tilesX * tilesY);
  const setBit = (tx, ty, li) => {
    const base = (ty * tilesX + tx) * wordsPerTile;
    bits[base + (li >> 5)] |= (1 << (li & 31)) >>> 0;
  };
  for (let li = 0; li < lights.length; li++) {
    const v = lights[li].v, r = lights[li].r;
    const d = -v[2];
    if (d <= 0) continue;                          // behind camera → no tile
    const dN = Math.max(near, d - r);              // nearest extent → biggest projection
    const ndcX = (v[0] / d) / (tanHalfFovY * aspect);
    const ndcY = (v[1] / d) / tanHalfFovY;
    const rNdcX = r / (dN * tanHalfFovY * aspect);
    const rNdcY = r / (dN * tanHalfFovY);
    const px0 = (ndcX - rNdcX) * 0.5 + 0.5, px1 = (ndcX + rNdcX) * 0.5 + 0.5;
    const py0 = (ndcY - rNdcY) * 0.5 + 0.5, py1 = (ndcY + rNdcY) * 0.5 + 0.5;
    const txMin = Math.max(0, Math.floor(px0 * screenW / tile));
    const txMax = Math.min(tilesX - 1, Math.floor(px1 * screenW / tile));
    const tyMin = Math.max(0, Math.floor(py0 * screenH / tile));
    const tyMax = Math.min(tilesY - 1, Math.floor(py1 * screenH / tile));
    if (txMin > tilesX - 1 || txMax < 0 || tyMin > tilesY - 1 || tyMax < 0) continue;
    for (let ty = tyMin; ty <= tyMax; ty++) for (let tx = txMin; tx <= txMax; tx++) setBit(tx, ty, li);
  }
  return { bits, wordsPerTile };
}

function hasBit(bitmask, tilesX, tx, ty, li) {
  const base = (ty * tilesX + tx) * bitmask.wordsPerTile;
  return (bitmask.bits[base + (li >> 5)] & ((1 << (li & 31)) >>> 0)) !== 0;
}

// A froxel's light set = (Z-bin sorted-index range) ∩ (tile bitmask). `order[p]` maps a
// sorted position to the original light index (bitmask bits are by original index).
export function froxelLightSet(tx, ty, s, zBins, bitmask, order, tilesX) {
  const zb = zBins[s];
  if (zb.min > zb.max) return [];
  const out = [];
  for (let p = zb.min; p <= zb.max; p++) {
    const li = order[p];
    if (hasBit(bitmask, tilesX, tx, ty, li)) out.push(li);
  }
  return out;
}
