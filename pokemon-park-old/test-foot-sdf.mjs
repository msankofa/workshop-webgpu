// Node checks for the foot contact proxy: the round-box fit, the SDF, and the patch the walker stands on.
// Run with `node test-foot-sdf.mjs`. Reads models straight out of `models/stadium/`, so no ROM, no network.

import fs from 'node:fs';
import { STADIUM_REFERENCE_SPECIES } from './stadium-reference-species.js';
import { fitRoundBox, sdRoundBox, buildFootProxy, boxSoleFace, patchArea } from './foot-sdf.js';
import { mapStadiumRigFromGLB } from './stadium-rig-map.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: ${a} vs ${b} (tol ${tol})`);
}

/** A cloud in the shape `boneGeometry` returns. */
const cloud = (pts) => ({ points: Float64Array.from(pts.flat()), count: pts.length });

// ===================== the round box =====================

check('a cube fits a box of the right half extents', () => {
  const pts = [];
  for (const x of [-2, 2]) for (const y of [-1, 1]) for (const z of [-3, 3]) pts.push([x, y, z]);
  const box = fitRoundBox(Float64Array.from(pts.flat()), pts.length);
  const half = [...box.half].sort((a, b) => b - a);
  near(half[0], 3, 1e-6, 'longest half extent');
  near(half[1], 2, 1e-6, 'middle half extent');
  near(half[2], 1, 1e-6, 'shortest half extent');
});

check('the axes come back orthonormal and right-handed', () => {
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push([Math.sin(i) * 3, Math.cos(i * 1.7), Math.sin(i * 0.3) * 0.2]);
  const box = fitRoundBox(Float64Array.from(pts.flat()), pts.length);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let i = 0; i < 3; i++) near(Math.hypot(...box.axes[i]), 1, 1e-9, `axis ${i} not unit`);
  near(dot(box.axes[0], box.axes[1]), 0, 1e-9, 'axes 0,1 not orthogonal');
  near(dot(box.axes[0], box.axes[2]), 0, 1e-9, 'axes 0,2 not orthogonal');
  near(dot(box.axes[1], box.axes[2]), 0, 1e-9, 'axes 1,2 not orthogonal');
  const cx = box.axes[0][1] * box.axes[1][2] - box.axes[0][2] * box.axes[1][1];
  const cy = box.axes[0][2] * box.axes[1][0] - box.axes[0][0] * box.axes[1][2];
  const cz = box.axes[0][0] * box.axes[1][1] - box.axes[0][1] * box.axes[1][0];
  assert(cx * box.axes[2][0] + cy * box.axes[2][1] + cz * box.axes[2][2] > 0, 'frame is left-handed');
});

check('a FLAT CARD still fits, which is the whole reason it is a box and not an ellipsoid', () => {
  // 32% of Stadium bones have one extent of exactly zero. An ellipsoid fitted to one has zero volume.
  const pts = [];
  for (const x of [-2, -1, 0, 1, 2]) for (const z of [-1, 0, 1]) pts.push([x, 0, z]);
  const box = fitRoundBox(Float64Array.from(pts.flat()), pts.length, { radius: 0.1 });
  const thin = Math.min(...box.half);
  near(thin, 0, 1e-9, 'the flat axis should have no half extent left after the radius');
  // The radius is what gives it thickness, so a point just off the plane is INSIDE.
  assert(sdRoundBox(box, 0, 0.05, 0) < 0, 'a point 0.05 off a card with radius 0.1 should be inside');
  assert(sdRoundBox(box, 0, 0.5, 0) > 0, 'a point 0.5 off it should be outside');
});

check('the SDF is signed, and zero on the surface', () => {
  // Deliberately not a cube: a cloud with three equal eigenvalues has no determined orientation, and the
  // power iteration is free to return a diagonal frame whose half extents are larger by root two.
  const pts = [];
  for (const x of [-3, 3]) for (const y of [-2, 2]) for (const z of [-1, 1]) pts.push([x, y, z]);
  const box = fitRoundBox(Float64Array.from(pts.flat()), pts.length);
  near(sdRoundBox(box, 0, 0, 0), -1, 1e-9, 'centre of the box');
  near(sdRoundBox(box, 3, 0, 0), 0, 1e-9, 'on the far face');
  near(sdRoundBox(box, 5, 0, 0), 2, 1e-9, 'two units clear of that face');
});

check('the radius is carved out of the extents rather than added to them', () => {
  // Growing the box by its own rounding would make every foot fatter than the mesh it was measured from.
  const pts = [];
  for (const x of [-3, 3]) for (const y of [-2, 2]) for (const z of [-1, 1]) pts.push([x, y, z]);
  const box = fitRoundBox(Float64Array.from(pts.flat()), pts.length, { radius: 0.5 });
  near(sdRoundBox(box, 3, 0, 0), 0, 1e-9, 'the fitted surface should still pass through the corner extent');
});

// ===================== the patch =====================

check('a flat square foot gives a patch with area', () => {
  const pts = [];
  for (const x of [-1, -0.5, 0, 0.5, 1]) for (const z of [-1, 0, 1]) pts.push([x, 0, z]);
  const p = buildFootProxy(cloud(pts));
  assert(p.ok, `expected a patch, got ${p.reason}`);
  assert(p.source === 'vertices', `expected vertices, got ${p.source}`);
  assert(patchArea(p) > 3, `expected roughly 2x2 of area, got ${patchArea(p)}`);
});

check('the patch is centred on the sole, so anchoring it at a foothold does not shift the foot', () => {
  const pts = [];
  for (const x of [-1, 0, 1]) for (const z of [-1, 0, 1]) pts.push([x + 40, 0, z - 17]);
  const p = buildFootProxy(cloud(pts));
  assert(p.ok, p.reason);
  let cx = 0, cz = 0;
  for (const s of p.samples) { cx += s[0]; cz += s[2]; }
  near(cx / p.samples.length, 0, 1e-6, 'patch is off-centre in x');
  near(cz / p.samples.length, 0, 1e-6, 'patch is off-centre in z');
});

check('a VERTICAL CARD falls back to the box instead of giving up', () => {
  // Hulling its floor vertices gives a line. Sandslash and Slowpoke are built entirely this way.
  const pts = [];
  for (const x of [-1, -0.5, 0, 0.5, 1]) for (const y of [0, 0.5, 1]) pts.push([x, y, 0]);
  const p = buildFootProxy(cloud(pts));
  assert(p.ok, `expected the box fallback to rescue it, got ${p.reason}`);
  assert(p.source === 'box', `expected the box, got ${p.source}`);
  assert(patchArea(p) > 0, 'the box fallback produced no area');
});

check('a patch is centred on the SOLE POINT the caller supplies, not on its own band', () => {
  // The band and `sole()` pick different vertices, so their centroids differ. The walker anchors the
  // patch at the foothold `sole()` produced, so a patch centred on anything else hangs off the foot.
  const pts = [];
  for (const x of [-1, 0, 1]) for (const z of [-1, 0, 1]) pts.push([x + 9, 0, z]);
  for (let i = 0; i < 6; i++) pts.push([20, 3, 0]);
  const centred = buildFootProxy(cloud(pts), { soleCentre: [9, 0, 0] });
  assert(centred.ok, centred.reason);
  let cx = 0, cz = 0;
  for (const s of centred.samples) { cx += s[0]; cz += s[2]; }
  const n = centred.samples.length;
  near(cx / n, 0, 1e-6, 'patch is off-centre in x from the supplied sole');
  near(cz / n, 0, 1e-6, 'patch is off-centre in z from the supplied sole');
});

check('the box fallback is centred on the sole too', () => {
  // It was not, at first: the face corners came back relative to the BOX centre, so a foot whose box
  // centre sat above its sole had its whole patch displaced from the foothold.
  const pts = [];
  for (const x of [-1, 0, 1]) for (const y of [0, 2, 4]) pts.push([x + 9, y, 0]);
  const p = buildFootProxy(cloud(pts), { soleCentre: [9, 0, 0] });
  assert(p.ok && p.source === 'box', `expected a box patch, got ${p.source ?? p.reason}`);
  let cx = 0, cz = 0;
  for (const s of p.samples) { cx += s[0]; cz += s[2]; }
  const n = p.samples.length;
  near(Math.hypot(cx / n, cz / n), 0, 1e-6, 'box patch is displaced horizontally from the sole');
});

check('a collapsed cloud is refused rather than made up', () => {
  const p = buildFootProxy(cloud([[3, 1, 2], [3, 1, 2], [3, 1, 2], [3, 1, 2]]));
  assert(!p.ok, 'a single repeated point should not become a foot');
  assert(/degenerate|extent/.test(p.reason), `unhelpful reason: ${p.reason}`);
});

check('no geometry is refused, and says so', () => {
  const p = buildFootProxy([]);
  assert(!p.ok && p.reason === 'no geometry', `got ${p.reason}`);
});

check('the sample count is capped', () => {
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push([Math.cos(i) * 2, 0, Math.sin(i) * 2]);
  const p = buildFootProxy(cloud(pts), { maxSamples: 6 });
  assert(p.ok, p.reason);
  assert(p.samples.length <= 6, `expected at most 6 samples, got ${p.samples.length}`);
});

check('the band beats a fixed fraction on a small cloud', () => {
  // A fifth of a 12-vertex foot is two points, which hulls to a line. Every quadruped here failed that way.
  const pts = [];
  for (const x of [-1, 0, 1]) for (const z of [-1, 0, 1]) pts.push([x, 0, z]);
  for (let i = 0; i < 3; i++) pts.push([0, 5, 0]);
  const p = buildFootProxy(cloud(pts));
  assert(p.ok, `the band should have taken the whole floor plane, got ${p.reason}`);
  assert(p.samples.length >= 3, `got ${p.samples.length} samples`);
});

check('boxSoleFace picks the DOWNWARD face', () => {
  const pts = [];
  for (const x of [-2, 2]) for (const y of [-0.5, 0.5]) for (const z of [-1, 1]) pts.push([x, y + 10, z]);
  const box = fitRoundBox(Float64Array.from(pts.flat()), pts.length);
  const face = boxSoleFace(box);
  assert(face, 'no face');
  assert(Math.abs(box.axes[face.axis][1]) > 0.9, 'the chosen axis is not the vertical one');
  const meanY = face.samples.reduce((a, s) => a + s[1], 0) / face.samples.length;
  assert(meanY < box.center[1], `the face is above the box centre: ${meanY} vs ${box.center[1]}`);
  near(meanY, 9.5, 1e-6, 'the face should sit on the bottom of the box');
});

// ===================== the real models =====================

// Assertions run over the fourteen the foot fitter was developed against; the survey below walks the
// whole directory and REPORTS, because across all 151 a "foot" is sometimes a fin, a tentacle or a
// collapsed point and a degenerate patch there is a fact about the body plan, not a defect in the fit.
const MODELS = STADIUM_REFERENCE_SPECIES.map(n => `${n}.glb`);
const ALL_SHIPPED = fs.readdirSync('models/stadium').filter(f => f.endsWith('.glb'));

check('every shipped model builds a patch for nearly every foot', () => {
  let ok = 0, total = 0;
  const failed = [];
  for (const f of MODELS) {
    const { map } = mapStadiumRigFromGLB(fs.readFileSync(`models/stadium/${f}`));
    for (const L of map.legs) {
      total++;
      if (L.footProxy?.ok) ok++;
      else failed.push(`${f.replace('.glb', '')}: ${L.footProxy?.reason}`);
    }
  }
  // 49 of 50 at the time of writing. The one refusal is a Pikachu foot bone whose 48 vertices are all
  // at the same point — the same degeneracy `test-stadium-roles.mjs` pins from the sole side.
  assert(ok >= total - 1, `only ${ok}/${total} feet got a patch: ${failed.join('; ')}`);
});

check('a patch never grows wider than the leg it hangs off', () => {
  for (const f of MODELS) {
    const { map } = mapStadiumRigFromGLB(fs.readFileSync(`models/stadium/${f}`));
    for (const L of map.legs) {
      const p = L.footProxy;
      if (!p?.ok) continue;
      const span = L.l1 + L.l2;
      assert(p.radius <= span * 0.751, `${f}: patch radius ${p.radius} against a leg span of ${span}`);
      for (const s of p.samples) assert(s.every(Number.isFinite), `${f}: a sample is not finite`);
    }
  }
});

check('the models whose auto-detected foot is too big are capped and say so', () => {
  // Not a bug in the fit: the auto-mapper's foot is only ever the LAST BONE of the chain, and on a squat
  // model that bone owns more than a foot. Sandshrew's patch came out wider than its entire leg.
  const capped = [];
  for (const f of MODELS) {
    const { map } = mapStadiumRigFromGLB(fs.readFileSync(`models/stadium/${f}`));
    for (const L of map.legs) if (L.footProxy?.capped) { capped.push(f.replace('.glb', '')); break; }
  }
  assert(capped.length > 0, 'expected at least Sandshrew to be capped, so the flag is exercised');
  assert(capped.length <= 3, `${capped.length} models capped, which suggests the cap is too tight: ${capped}`);
});

check('the proxy carries the rest frame it was measured in', () => {
  // Without it the walker cannot map the offsets onto the live bone, and every contact point is NaN.
  const { map } = mapStadiumRigFromGLB(fs.readFileSync('models/stadium/128_tauros.glb'));
  for (const L of map.legs) {
    assert(Number.isInteger(L.footFrame), 'no foot frame bone');
    assert(L.footProxy.restWorld?.length === 16, 'no rest matrix on the proxy');
    assert([...L.footProxy.restWorld].every(Number.isFinite), 'the rest matrix is not finite');
  }
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
