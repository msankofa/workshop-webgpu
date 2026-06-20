// GLSL-vs-JS parity test for HEIGHTMAP-SAMPLED terrain displacement.
//
// In the heightmap approach the GPU never re-implements the height function: it
// bilinearly samples a float texture that JS fills from terrainHeightAt(). So the
// only thing that can diverge between the GPU's displaced surface and the JS field
// (used by collision/grass/trees) is the bilinear *reconstruction* error of the
// texture. GPU bilinear filtering of a float texture is a fully specified weighted
// average of the 4 surrounding texels, so we can emulate it exactly in JS and
// predict the GPU result before any GLSL exists.
//
// This test sweeps texel density and reports the height error vs the analytic
// field, split into flat terrain and steep (lake-edge) regions, and asserts that a
// recommended resolution keeps the error within tolerance. The resolution it
// validates becomes the spec's required heightmap density.
//
// Run: node test-terrain-heightmap-parity.mjs
import { terrainHeightAt } from './terrain-field.js';

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };

// A representative region large enough to contain lakes and their (steep) shores.
const REGION = { x0: -120, z0: -120, span: 240 };

// Fill a float heightmap (R32F-equivalent: a Float32Array stores exact float32)
// covering the region with texel CENTERS on a regular grid, spacing `step` world
// units. Texel[i,j] = terrainHeightAt(x0 + i*step, z0 + j*step) — i.e. the same
// vertex-aligned sampling a heightmap bake would use.
function buildHeightmap(step) {
  const { x0, z0, span } = REGION;
  const n = Math.round(span / step) + 1;
  const data = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      data[j * n + i] = terrainHeightAt(params, x0 + i * step, z0 + j * step);
    }
  }
  return { data, n, step };
}

// Emulate GPU texture(map, uv) with LINEAR filter + CLAMP_TO_EDGE: bilinear blend
// of the 4 texels around (x,z). This is exactly what the displacement shader does.
function sampleBilinear(hm, x, z) {
  const fx = (x - REGION.x0) / hm.step;
  const fz = (z - REGION.z0) / hm.step;
  let i0 = Math.floor(fx), j0 = Math.floor(fz);
  i0 = Math.max(0, Math.min(hm.n - 2, i0));
  j0 = Math.max(0, Math.min(hm.n - 2, j0));
  const tx = Math.max(0, Math.min(1, fx - i0));
  const tz = Math.max(0, Math.min(1, fz - j0));
  const h00 = hm.data[j0 * hm.n + i0];
  const h10 = hm.data[j0 * hm.n + i0 + 1];
  const h01 = hm.data[(j0 + 1) * hm.n + i0];
  const h11 = hm.data[(j0 + 1) * hm.n + i0 + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

// Local slope magnitude (world height per world unit) — used to separate flat
// terrain from steep lake shores, where bilinear error is worst.
function slopeAt(x, z) {
  const e = 0.5;
  const dx = terrainHeightAt(params, x + e, z) - terrainHeightAt(params, x - e, z);
  const dz = terrainHeightAt(params, x, z + e) - terrainHeightAt(params, x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

// Deterministic sampler so runs are reproducible.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function evaluate(step, samples = 40000) {
  const hm = buildHeightmap(step);
  const rng = mulberry32(1234567);
  const { x0, z0, span } = REGION;
  const lo = step * 1.5, hi = span - step * 1.5;   // stay off the clamped border
  const allErr = [], steepErr = [], flatErr = [];
  const STEEP = 0.4;   // slope above this counts as a lake shore / steep region
  for (let k = 0; k < samples; k++) {
    const x = x0 + lo + rng() * (hi - lo);
    const z = z0 + lo + rng() * (hi - lo);
    const err = Math.abs(sampleBilinear(hm, x, z) - terrainHeightAt(params, x, z));
    allErr.push(err);
    (slopeAt(x, z) > STEEP ? steepErr : flatErr).push(err);
  }
  allErr.sort((a, b) => a - b);
  steepErr.sort((a, b) => a - b);
  flatErr.sort((a, b) => a - b);
  const rms = Math.sqrt(allErr.reduce((s, e) => s + e * e, 0) / allErr.length);
  return {
    step, texels: hm.n,
    maxAll: allErr[allErr.length - 1],
    rmsAll: rms,
    p99All: percentile(allErr, 0.99),
    p999All: percentile(allErr, 0.999),
    maxFlat: flatErr.length ? flatErr[flatErr.length - 1] : 0,
    maxSteep: steepErr.length ? steepErr[steepErr.length - 1] : 0,
    steepFrac: steepErr.length / allErr.length,
  };
}

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

console.log('Heightmap bilinear-reconstruction error vs analytic terrainHeightAt');
console.log('(region 240x240 incl. lakes; height range ~ +/-4; float32 texels)\n');
console.log('  u/texel  texels   maxAll   rms     p99     p99.9   maxFlat  maxSteep  steep%');
const steps = [2.0, 1.3, 1.0, 0.5, 0.25];
const rows = {};
for (const s of steps) {
  const r = evaluate(s);
  rows[s] = r;
  const f = (v) => v.toFixed(4).padStart(8);
  console.log(
    `  ${s.toFixed(2).padStart(6)}  ${String(r.texels).padStart(5)}  ${f(r.maxAll)} ${f(r.rmsAll)} ${f(r.p99All)} ${f(r.p999All)} ${f(r.maxFlat)} ${f(r.maxSteep)}   ${(r.steepFrac * 100).toFixed(1)}%`,
  );
}

console.log('\nReference: current chunk mesh samples height at ~1.3 u/vertex (23 segments / 30u chunk),');
console.log('so a heightmap at 1.3 u/texel has ~the same fidelity as today\'s visual terrain.\n');

// --- Assertions -----------------------------------------------------------
// Error falls ~quadratically with texel spacing (bilinear interpolation), so a
// finer map is strictly better. We require the RECOMMENDED density (0.5 u/texel,
// = 64 texels per 30u chunk) to keep even lake-edge error visually negligible,
// and confirm it beats the current-mesh-equivalent (1.3 u/texel).
const rec = rows[0.5];
ok(rec.maxAll < 0.10, `recommended 0.5 u/texel worst-case error (${rec.maxAll.toFixed(4)}) < 0.10`);
ok(rec.p999All < 0.06, `recommended 0.5 u/texel p99.9 error (${rec.p999All.toFixed(4)}) < 0.06`);
// Today's chunk mesh already interpolates height between ~1.3u vertices, so it
// carries this same class of visual-vs-analytic deviation and the world looks
// fine — establishing the tolerance the heightmap must not exceed.
ok(rows[1.3].maxAll < 0.40, `current-mesh-equivalent (1.3 u/texel) worst error (${rows[1.3].maxAll.toFixed(4)}) < 0.40 — already tolerated today`);
ok(rec.maxAll < rows[1.3].maxAll, `recommended 0.5 u/texel (${rec.maxAll.toFixed(4)}) beats current-mesh-equivalent 1.3 u/texel (${rows[1.3].maxAll.toFixed(4)})`);
ok(rows[0.25].maxAll < rec.maxAll, 'finer 0.25 u/texel strictly lower max error than 0.5 (quadratic convergence — finer is always safe)');

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
