// test-flight-terrain-stream.mjs — the scrolling window: rectangle subtraction, toroidal wrapping,
// and the property that actually matters — a scrolled window answers exactly what the generator
// would have, no matter how far or how oddly it travelled.
//
//   node test-flight-terrain-stream.mjs

import {
  STREAM_DEFAULTS, createTerrainStream, subtractWindow, fillSpan, spanPostCount,
} from './flight-terrain-stream.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Seeded, so a run that passes passes for everyone. Math.random made the seam check flake between
// 4.8 and 6.4 m and there is no way to tell a flaky threshold from an intermittent bug.
let _seed = 0x2f6e2b1;
const rnd = () => { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; };

// A generator with no symmetry, so a wrap bug cannot accidentally land on the right answer.
const gen = (x, z) => Math.sin(x * 0.0031) * 120 + Math.cos(z * 0.0017) * 80 + Math.sin((x + z) * 0.00071) * 40;

// Drive a stream to a position the way the viewer does: plan, fill, commit.
function fly(s, x, z) {
  const plan = s.plan(x, z);
  if (!plan) return 0;
  const data = plan.spans.map((sp) => fillSpan(sp, s.post, gen));
  s.commit(plan, data);
  return spanPostCount(plan);
}

console.log('\n1. rectangle subtraction');
{
  const R = 10;
  const area = (spans) => spans.reduce((n, s) => n + s.w * s.h, 0);
  const cells = (spans) => {
    const set = new Set();
    for (const s of spans) for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) set.add(`${s.px + i},${s.pz + j}`);
    return set;
  };
  const expect = (nx, nz, ox, oz) => {
    const want = new Set();
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const gx = nx + i, gz = nz + j;
      if (gx < ox || gx > ox + R - 1 || gz < oz || gz > oz + R - 1) want.add(`${gx},${gz}`);
    }
    return want;
  };
  const same = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));

  let allOk = true, noOverlap = true;
  // every relative offset from fully-disjoint to identical, both axes
  for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
    const spans = subtractWindow(100 + dx, 200 + dz, 100, 200, R);
    if (!same(cells(spans), expect(100 + dx, 200 + dz, 100, 200))) allOk = false;
    if (area(spans) !== cells(spans).size) noOverlap = false;   // area == unique cells => disjoint
  }
  ok('covers exactly the newly exposed cells, over 625 offsets', allOk);
  ok('the pieces never overlap', noOverlap);
  ok('no movement means no work', subtractWindow(5, 5, 5, 5, R).length === 0);
  ok('a disjoint jump is one full rectangle', (() => {
    const s = subtractWindow(500, 500, 0, 0, R);
    return s.length === 1 && s[0].w === R && s[0].h === R;
  })());
  ok('a one-post slide is one column', (() => {
    const s = subtractWindow(1, 0, 0, 0, R);
    return area(s) === R && s.length === 1 && s[0].w === 1 && s[0].h === R;
  })());
  ok('a diagonal slide is two strips, L-shaped', (() => {
    const s = subtractWindow(1, 1, 0, 0, R);
    return area(s) === R + R - 1;
  })());
}

console.log('\n2. the window tracks the plane');
{
  const s = createTerrainStream({ res: 65, post: 20, blockPosts: 8 });
  ok('starts unfilled', !s.filled && !s.covers(0, 0));
  ok('window size is res * post', s.size === 65 * 20);

  const first = fly(s, 0, 0);
  ok('the first plan fills the whole window', first === 65 * 65);
  ok('now filled', s.filled && s.covers(0, 0));
  ok('the plane sits inside', 0 > s.minX && 0 < s.maxX && 0 > s.minZ && 0 < s.maxZ);

  ok('a small move needs no work', s.plan(10, 10) === null);

  // The window here is 65 * 20 = 1300 m, so fly a fraction of that: a move further than the window
  // legitimately makes every post new, and would prove nothing about incremental fill.
  const before = { px: s.originPX, pz: s.originPZ };
  const moved = fly(s, 400, 0);
  ok('crossing a block scrolls the window', s.originPX !== before.px);
  ok('and regenerates only a strip, not the window',
    moved > 0 && moved < 65 * 65 * 0.5, `${moved} posts of ${65 * 65}`);
  ok('the plane is still inside after scrolling', s.covers(400, 0));

  const far = fly(s, 90000, 90000);
  ok('a jump beyond the window rebuilds it whole', far === 65 * 65);
}

console.log('\n3. scrolled content equals the generator — the whole point');
{
  const s = createTerrainStream({ res: 129, post: 20, blockPosts: 16 });
  fly(s, 0, 0);

  // A deliberately awkward flight: diagonals, reversals, and a teleport far beyond the window.
  const WINDOW = 129 * 20;
  const legs = [[0, 0], [900, 300], [-1200, 700], [600, -1100], [40000, 40000], [40600, 40300], [-500, -500]];
  let worst = 0, checked = 0;
  let worstShortLeg = 0;
  let prev = [0, 0];
  for (const [x, z] of legs) {
    const cost = fly(s, x, z);
    if (Math.hypot(x - prev[0], z - prev[1]) < WINDOW * 0.5) worstShortLeg = Math.max(worstShortLeg, cost);
    prev = [x, z];
    for (let i = 0; i < 400; i++) {
      const sx = x + (rnd() - 0.5) * 1200, sz = z + (rnd() - 0.5) * 1200;
      if (!s.covers(sx, sz)) continue;
      worst = Math.max(worst, Math.abs(s.sample(sx, sz) - referenceBilinear(sx, sz, s.post)));
      checked++;
    }
  }
  // Exact, not approximate: the reference rounds through float32 the way the storage does, so any
  // residue would be a wrapping or indexing bug rather than the format.
  ok('every sample matches an independent bilinear of the generator', worst === 0, `worst ${worst} over ${checked}`);
  ok('a leg shorter than half the window never costs a full rebuild',
    worstShortLeg < 129 * 129, `${worstShortLeg} posts of ${129 * 129}`);

  ok('outside the window is refused rather than answered wrongly',
    !s.covers(s.maxX + 1, 0) && !s.covers(0, s.minZ - 1));
}

// Bilinear over the generator's own post lattice, written without reference to the stream.
// Math.fround because the window stores Float32: comparing float64 maths against float32 storage
// shows ~7e-6 m of pure format error and hides whatever it is this test exists to catch.
function referenceBilinear(x, z, post) {
  const fx = x / post, fz = z / post;
  const cx = Math.floor(fx), cz = Math.floor(fz);
  const tx = fx - cx, tz = fz - cz;
  const g = (px, pz) => Math.fround(gen(px * post, pz * post));
  const h00 = g(cx, cz), h10 = g(cx + 1, cz), h01 = g(cx, cz + 1), h11 = g(cx + 1, cz + 1);
  const a0 = h00 + (h10 - h00) * tx;
  const a1 = h01 + (h11 - h01) * tx;
  return a0 + (a1 - a0) * tz;
}

console.log('\n4. wrapping is real, not incidental');
{
  const res = 33;
  const s = createTerrainStream({ res, post: 20, blockPosts: 4 });
  fly(s, 0, 0);
  const snapshot = Float32Array.from(s.heights);

  // Travel exactly one full window: every texel should be rewritten, and the array must be the
  // same object (no reallocation) — that is what makes scrolling free.
  fly(s, res * 20, 0);
  ok('the backing array is never reallocated', s.heights.length === res * res);
  let changed = 0;
  for (let i = 0; i < s.heights.length; i++) if (s.heights[i] !== snapshot[i]) changed++;
  ok('a full-window move rewrites essentially everything', changed > res * res * 0.9, `${changed}/${res * res}`);

  // Travelling a whole world and coming back must reproduce the original window bit-for-bit.
  const home = createTerrainStream({ res, post: 20, blockPosts: 4 });
  fly(home, 0, 0);
  const homeSnap = Float32Array.from(home.heights);
  fly(home, 500000, -500000);
  fly(home, 0, 0);
  let identical = true;
  for (let i = 0; i < homeSnap.length; i++) if (home.heights[i] !== homeSnap[i]) { identical = false; break; }
  ok('leaving and returning reproduces the same window exactly', identical);
}

console.log('\n5. guards');
{
  let threw = 0;
  for (const bad of [{ res: 2 }, { post: 0 }, { blockPosts: 0 }]) {
    try { createTerrainStream(bad); } catch { threw++; }
  }
  ok('bad geometry is refused', threw === 3);
  const s = createTerrainStream({ res: 17, post: 10, blockPosts: 4 });
  let sizeThrew = false;
  try { s.writeSpan({ px: 0, pz: 0, w: 4, h: 4 }, new Float32Array(3)); } catch { sizeThrew = true; }
  ok('a short span is refused rather than written partially', sizeThrew);
  ok('defaults give a window wider than the clipmap reach',
    STREAM_DEFAULTS.res * STREAM_DEFAULTS.post > 2 * 8192,
    `${STREAM_DEFAULTS.res * STREAM_DEFAULTS.post} m`);
}

console.log('\n6. the GPU twin');
{
  const THREE = await import('three/webgpu');
  const { MeshStandardNodeMaterial } = THREE;
  const {
    Fn, uniform, attribute, vec2, vec3, float, ivec2, clamp, mix, floor, normalize, textureLoad,
  } = await import('three/tsl');
  const { buildMaterial } = await import('./tsl-build-check.mjs');

  const s = createTerrainStream({ res: 65, post: 20, blockPosts: 8 });
  fly(s, 3000, -7000);   // a scrolled, wrapped window, not a fresh one

  // The shader wraps with n - floor(n / r) * r because TSL's mod follows the sign of its argument.
  // The CPU wraps with ((i % r) + r) % r. Same map or the picture comes from the wrong hemisphere.
  const gpuWrap = (n, r) => n - Math.floor(n / r) * r;
  const cpuWrap = (n, r) => ((n % r) + r) % r;
  let wrapOk = true;
  for (let n = -5000; n <= 5000; n++) if (gpuWrap(n, 65) !== cpuWrap(n, 65)) wrapOk = false;
  ok('the two wraps agree over 10,001 posts either side of zero', wrapOk);

  // Full re-derivation of tslStream, in JS, compared against the stream's own sampler.
  const asShader = (x, z) => {
    const r = s.res, post = s.post;
    const fx = x / post, fz = z / post;
    const gx = Math.floor(fx), gz = Math.floor(fz);
    const cx = Math.min(Math.max(gx, s.originPX), s.originPX + r - 2);
    const cz = Math.min(Math.max(gz, s.originPZ), s.originPZ + r - 2);
    const tx = Math.min(Math.max(fx - cx, 0), 1), tz = Math.min(Math.max(fz - cz, 0), 1);
    const at = (a, b) => s.heights[gpuWrap(b, r) * r + gpuWrap(a, r)];
    const a0 = at(cx, cz) + (at(cx + 1, cz) - at(cx, cz)) * tx;
    const a1 = at(cx, cz + 1) + (at(cx + 1, cz + 1) - at(cx, cz + 1)) * tx;
    return a0 + (a1 - a0) * tz;
  };
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const x = 3000 + (rnd() - 0.5) * s.size * 1.6;   // deliberately overruns the window
    const z = -7000 + (rnd() - 0.5) * s.size * 1.6;
    worst = Math.max(worst, Math.abs(s.sample(x, z) - asShader(x, z)));
  }
  ok('sampler and shader formulation agree on a wrapped window', worst === 0, `worst ${worst}`);

  const tex = new THREE.DataTexture(s.heights, s.res, s.res, THREE.RedFormat, THREE.FloatType);
  tex.needsUpdate = true;
  const uOrigin = uniform(new THREE.Vector2(s.originPX, s.originPZ));
  const uPost = uniform(s.post), uRes = uniform(s.res);
  const tslStream = Fn(([p]) => {
    const f = p.div(uPost);
    const hi = uOrigin.add(uRes).sub(2);
    const c = clamp(floor(f), uOrigin, hi);
    const t = clamp(f.sub(c), vec2(0, 0), vec2(1, 1));
    const r = uRes;
    const w = (n) => ivec2(n.sub(floor(n.div(r)).mul(r)));
    const i0 = w(c), i1 = w(c.add(1));
    const h00 = textureLoad(tex, ivec2(i0.x, i0.y)).x;
    const h10 = textureLoad(tex, ivec2(i1.x, i0.y)).x;
    const h01 = textureLoad(tex, ivec2(i0.x, i1.y)).x;
    const h11 = textureLoad(tex, ivec2(i1.x, i1.y)).x;
    return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
  });

  const aPos = attribute('position', 'vec3');
  const uHalf = uniform(512), uCenter = uniform(new THREE.Vector2());
  const worldPos = Fn(() => {
    const xz = aPos.xz.mul(uHalf).add(uCenter);
    return vec3(xz.x, tslStream(xz), xz.y);
  })();
  const eps = 20;
  const nrm = Fn(() => {
    const xz = aPos.xz.mul(uHalf).add(uCenter);
    const hL = tslStream(xz.add(vec2(-eps, 0))), hR = tslStream(xz.add(vec2(eps, 0)));
    const hD = tslStream(xz.add(vec2(0, -eps))), hU = tslStream(xz.add(vec2(0, eps)));
    return normalize(vec3(hL.sub(hR), float(2 * eps), hD.sub(hU)));
  })();
  const mat = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  mat.positionNode = worldPos;
  mat.normalNode = nrm;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));

  let built = null, err = null;
  try { built = await buildMaterial(mat, geo); } catch (e) { err = e; }
  ok('the streaming terrain material compiles', built != null && !err, err ? err.message : '');

  // f32 holds integers exactly to 2^24, and the shader wraps in global POST space, so the world is
  // exact out to 2^24 posts. Worth stating: it is the real edge of this design.
  ok('exact-integer reach is far beyond any flight',
    Math.pow(2, 24) * STREAM_DEFAULTS.post > 3e8,
    `${(Math.pow(2, 24) * STREAM_DEFAULTS.post / 1000).toExponential(1)} km`);
}

console.log('\n7. a real v5 project, streamed');
{
  const { createV5Source } = await import('./terrain-source-v5.js');
  const { DEFAULT_CONFIG } = await import('./terrain-generator-js.js');
  const { STACK_PRESETS } = await import('./terrain-stack.js');

  const SEA = 40, SCALE = 1.25;
  const project = {
    app: 'terrain-generator-v5', version: 1, algorithmVersion: 'v5-unbounded-1', name: 'alpine',
    cfg: { ...DEFAULT_CONFIG, world_x: 16384, world_z: 16384, sea_level: SEA },
    stack: STACK_PRESETS['alpine ridges'](),
  };
  const src = createV5Source(project);
  ok('the preset is streamable at all', src.descriptor.capabilities.includes('infinite'));

  // The transform belongs to the source. The window is filled through it, and points outside the
  // window are answered by it directly; if the two disagreed the ground would step at the window
  // edge — invisible in a screenshot, fatal to a plane flying across it.
  const heightAt = (x, z) => (src.heightAt(x, z) - SEA) * SCALE;
  const s = createTerrainStream({ res: 129, post: 20, blockPosts: 16 });
  const p0 = s.plan(0, 0);
  s.commit(p0, p0.spans.map((sp) => fillSpan(sp, s.post, heightAt)));

  // Crossing the window edge goes from bilinear (inside) to exact (outside), so SOME step is
  // unavoidable — on ridged terrain with 20 m posts it is metres, and an absolute threshold here is
  // just a guess about the preset. What must not happen is a step from a mismatched transform, which
  // would be a constant SEA * SCALE = 50 m. So measure the interpolation error well inside the
  // window and require the seam to be the same size as it.
  const edge = s.maxX;
  let interior = 0, seam = 0;
  for (let i = 0; i < 300; i++) {
    const z = (rnd() - 0.5) * s.size * 0.8;
    const x = s.minX + s.size * 0.25 + rnd() * s.size * 0.3;
    interior = Math.max(interior, Math.abs(s.sample(x, z) - heightAt(x, z)));
    seam = Math.max(seam, Math.abs(s.sample(edge - 0.5, z) - heightAt(edge + 0.5, z)));
  }
  ok('the seam step is only interpolation error, not a transform mismatch',
    seam <= interior * 1.5 + 1, `seam ${seam.toFixed(2)} m vs interior ${interior.toFixed(2)} m`);

  // Positive control: the check above is worthless unless it fails when the bug it exists for is
  // present. This is the bug — the worker filling raw heights while the fallback shifts them.
  const wrong = createTerrainStream({ res: 129, post: 20, blockPosts: 16 });
  const pw = wrong.plan(0, 0);
  wrong.commit(pw, pw.spans.map((sp) => fillSpan(sp, wrong.post, (x, z) => src.heightAt(x, z))));
  let wrongSeam = 0;
  for (let i = 0; i < 60; i++) {
    const z = (rnd() - 0.5) * wrong.size * 0.8;
    wrongSeam = Math.max(wrongSeam, Math.abs(wrong.sample(wrong.maxX - 0.5, z) - heightAt(wrong.maxX + 0.5, z)));
  }
  ok('and it does catch an unshifted fill', wrongSeam > interior * 1.5 + 1, `${wrongSeam.toFixed(1)} m step`);

  const mid = heightAt(123, -456);
  ok('the sea shift and height scale are applied',
    Math.abs(mid - (src.heightAt(123, -456) - SEA) * SCALE) < 1e-12);
  ok('sampling inside the window matches the transformed generator to bilinear error',
    Math.abs(s.sample(123, -456) - mid) < 20, `${Math.abs(s.sample(123, -456) - mid).toFixed(2)} m`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
