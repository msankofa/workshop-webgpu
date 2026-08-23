// flight-terrain-baked.js — a baked height grid standing in for the analytic field.
//
// Why bake at all. The sim's ground is a closed-form sum of plane waves precisely because a vertex
// shader can evaluate it (see flight-terrain.js). Terrain Generator v5's layer stack cannot go in a
// shader as it stands — it is a JS switch over a runtime list of layer objects — and its erosion,
// hydrology and paint stages are not point functions in the first place: the height at one spot
// depends on what the whole grid did over many iterations, so there is no equation to transcribe.
// A grid of numbers is the only representation both the CPU and the GPU can read.
//
// This file is the format and the CPU sampler. No three.js and no fetch, so bake-terrain.mjs, the
// tests and the viewer all share one implementation.
//
// THE SAMPLER IS THE CONTRACT. sampleBake() below and the TSL `bakedHeight` in demos/flight-sim.html
// do the same arithmetic on the same texels — four integer fetches and two lerps, no hardware
// filtering. That is deliberate: r32float is only linearly filterable where the WebGPU device
// reports `float32-filterable`, and leaning on the sampler would also mean matching its texel-centre
// convention exactly. Doing the lerp by hand costs three extra fetches per vertex and removes both
// worries. Edit the two together — this is the same hand-synced-twin arrangement the wave field has,
// except here the twins are ten lines each instead of a noise stack.

export const BAKE_VERSION = 1;

// A bake is `res × res` posts of Float32 height in metres, row-major with z outermost, covering a
// square of `size` metres whose post 0,0 sits at (originX, originZ). Post spacing is size/(res-1),
// so the last post lands exactly on the far edge rather than one step short.
export function bakeStep(size, res) { return size / Math.max(1, res - 1); }

export function validateBakeMeta(meta) {
  const e = [];
  if (!meta || typeof meta !== 'object') return ['meta must be an object'];
  if (meta.version !== BAKE_VERSION) e.push(`version must be ${BAKE_VERSION}, got ${meta.version}`);
  if (!Number.isInteger(meta.res) || meta.res < 2) e.push('res must be an integer >= 2');
  if (!(meta.size > 0)) e.push('size must be positive');
  for (const k of ['originX', 'originZ']) if (!Number.isFinite(meta[k])) e.push(`${k} must be finite`);
  return e;
}

// Bind a meta block to its height array. Throws rather than returning a half-built bake: a terrain
// that is silently the wrong size reads as a physics bug much later.
export function normalizeBake(meta, heights) {
  const e = validateBakeMeta(meta);
  if (e.length) throw new Error(`bad terrain bake: ${e.join('; ')}`);
  const res = meta.res;
  if (!heights || heights.length !== res * res) {
    throw new Error(`bad terrain bake: expected ${res * res} heights, got ${heights ? heights.length : 0}`);
  }
  const step = bakeStep(meta.size, res);
  return Object.freeze({
    ...meta,
    heights,
    step,
    maxCell: res - 2,          // last cell whose +1 neighbour still exists
    halfSize: meta.size / 2,
    maxX: meta.originX + meta.size,
    maxZ: meta.originZ + meta.size,
  });
}

// Bilinear height. Outside the grid the edge cell is extended (clamp), which is what the GPU's
// clamped integer fetch does too — the world does not end, it just stops changing.
export function sampleBake(bake, x, z) {
  const { heights, res, step, maxCell } = bake;
  const fx = (x - bake.originX) / step;
  const fz = (z - bake.originZ) / step;
  let ix = Math.floor(fx), iz = Math.floor(fz);
  ix = ix < 0 ? 0 : ix > maxCell ? maxCell : ix;
  iz = iz < 0 ? 0 : iz > maxCell ? maxCell : iz;
  let tx = fx - ix, tz = fz - iz;
  tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
  tz = tz < 0 ? 0 : tz > 1 ? 1 : tz;
  const r0 = iz * res + ix, r1 = r0 + res;
  const h00 = heights[r0], h10 = heights[r0 + 1];
  const h01 = heights[r1], h11 = heights[r1 + 1];
  // Written as mix(mix(a,b,t),...) expanded the way GLSL/WGSL expand it — a + (b-a)*t — not as the
  // algebraically equal a*(1-t) + b*t. Same answer in exact arithmetic, different last bits in
  // floating point, and the test demands the twins match to the bit.
  const a0 = h00 + (h10 - h00) * tx;
  const a1 = h01 + (h11 - h01) * tx;
  return a0 + (a1 - a0) * tz;
}

// True while (x,z) is inside the baked square. The sim stays playable outside it, but the ground
// there is an extended edge rather than real terrain, so the viewer says so instead of pretending.
export function insideBake(bake, x, z) {
  return x >= bake.originX && x <= bake.maxX && z >= bake.originZ && z <= bake.maxZ;
}

export function bakeRange(heights) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { min, max };
}

// Sample a point height function onto the grid. Shared by the CLI and the tests so a bake built in
// a test is byte-identical to one built on the command line.
export function bakeHeights(heightFn, { res, size, originX, originZ }) {
  const heights = new Float32Array(res * res);
  const step = bakeStep(size, res);
  for (let iz = 0; iz < res; iz++) {
    const z = originZ + iz * step;
    const row = iz * res;
    for (let ix = 0; ix < res; ix++) heights[row + ix] = heightFn(originX + ix * step, z);
  }
  return heights;
}

// Float32 little-endian, which every target we run on is. Kept as a named pair so a future format
// change has one place to break loudly rather than two places to disagree quietly.
export function bakeToBytes(heights) {
  return heights.buffer.slice(heights.byteOffset, heights.byteOffset + heights.byteLength);
}
export function bakeFromBytes(buffer) { return new Float32Array(buffer); }
