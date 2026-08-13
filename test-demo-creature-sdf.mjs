// node test-demo-creature-sdf.mjs
//
// Covers `demos/creature-collision.js`, the CPU twin of the creature distance field used to resolve
// the cursor blob against the body in `demos/sdf-creature.html`.
//
// What this CANNOT check: that the twin agrees with the TSL it mirrors. Nothing in Node can run the
// shader. Same limitation `test-post-grade.mjs` and `test-forest-cull.mjs` carry, and the same
// mitigation — the twin is deliberately coarser than the shader, so the surface where drift can
// happen is small and named in the module header.
//
// What it CAN check: that the field behaves like a distance field, that contact resolution actually
// removes penetration, and that the two deformation gains are complementary the way the demo claims.

import {
  collisionSdf, collisionGradient, resolveBlob, restingBlob,
  sdEllipsoid, sdRoundCone, smin, DEFAULT_PARAMS,
} from './demos/creature-collision.js';

// Mirrors MAX_DENT_FRACTION in the module. Kept local because it is asserted as a contract, not
// imported — if the module raises its cap, this test should fail rather than silently follow.
const MAX_DENT = 0.6;

let checks = 0, failures = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error('  FAIL:', msg); }
}
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b} +/- ${tol})`); }
function section(name) { console.log(name); }

// ---------------------------------------------------------------------------
section('1. primitives');
// ---------------------------------------------------------------------------

near(sdEllipsoid(0.5, 0, 0, 0.5, 0.5, 0.5), 0, 1e-9, 'sphere-as-ellipsoid is zero on its surface');
near(sdEllipsoid(0.25, 0, 0, 0.5, 0.5, 0.5), -0.25, 1e-9, 'halfway to a 0.5 sphere surface is -0.25');
ok(sdEllipsoid(0.1, 0, 0, 0.6, 0.3, 0.4) < 0, 'inside an anisotropic ellipsoid is negative');
ok(sdEllipsoid(2, 0, 0, 0.6, 0.3, 0.4) > 0, 'outside an anisotropic ellipsoid is positive');
// iq's bound DEGENERATES at the exact centre: both k0 and k1 vanish and the guarded divide returns
// 0 rather than the negative radius. Recorded here because it is the reason contact is resolved by
// tracing a ray from the camera instead of evaluating the field at the blob's centre.
near(sdEllipsoid(0, 0, 0, 0.5, 0.5, 0.5), 0, 1e-12, 'the bound reads 0 at its own centre, not -r');

// A round cone with equal radii is a capsule: exactly r from the axis anywhere along the shaft.
near(sdRoundCone(0.2, 0.25, 0, 0.2, 0.2, 0.5), 0, 1e-9, 'capsule surface at mid-shaft');
near(sdRoundCone(0, -0.2, 0, 0.2, 0.2, 0.5), 0, 1e-9, 'capsule cap below the base');
near(sdRoundCone(0, 0.7, 0, 0.2, 0.2, 0.5), 0, 1e-9, 'capsule cap above the tip');
ok(sdRoundCone(0, 0.25, 0, 0.2, 0.2, 0.5) < 0, 'axis of a capsule is inside it');
// The tapered case is the one the branchless mix() can get backwards.
ok(sdRoundCone(0, 0.34, 0, 0.10, 0.012, 0.34) < 0, 'horn axis near the tip is inside');
ok(sdRoundCone(0.09, 0.34, 0, 0.10, 0.012, 0.34) > 0,
  'a point at base radius but at tip height is OUTSIDE (the cone really tapers)');

near(smin(0.3, 0.7, 0.2), Math.min(0.3, 0.7), 0.06, 'smin is close to min when far apart');
ok(smin(0.1, 0.1, 0.3) < 0.1, 'smin dips below min where the two shapes meet');
near(smin(5, -0.2, 0.2), -0.2, 1e-9, 'smin returns the near value when the other is far away');

// ---------------------------------------------------------------------------
section('2. the field is a distance field');
// ---------------------------------------------------------------------------

ok(collisionSdf(0, 1.0, 0) < 0, 'the middle of the torso is inside');
ok(collisionSdf(0, 0.15, 0.0) < 0.2, 'the leg region is at or near the surface');
ok(collisionSdf(0, 5, 0) > 3, 'far above the creature is far outside');
ok(collisionSdf(0, 1.0, 4) > 3, 'far in front is far outside');
ok(collisionSdf(0.10, 1.16, 0.32) < 0, 'the eye centre is inside');

// Gradient magnitude: a true SDF has |grad| = 1. The ellipsoid bound and the smooth unions make it
// only approximately so, which is exactly why the march uses a step multiplier below 1. The check
// that matters is that it never EXCEEDS 1 by much, since that is what makes a march overshoot.
let maxGrad = 0, minGrad = Infinity, sampled = 0;
for (let i = 0; i < 12; i++) {
  for (let j = 0; j < 12; j++) {
    for (let k = 0; k < 12; k++) {
      const x = -1.2 + (2.4 * i) / 11, y = -0.2 + (2.4 * j) / 11, z = -1.2 + (2.4 * k) / 11;
      const e = 1e-3;
      const gx = collisionSdf(x + e, y, z) - collisionSdf(x - e, y, z);
      const gy = collisionSdf(x, y + e, z) - collisionSdf(x, y - e, z);
      const gz = collisionSdf(x, y, z + e) - collisionSdf(x, y, z - e);
      const g = Math.hypot(gx, gy, gz) / (2 * e);
      if (!Number.isFinite(g)) { ok(false, `non-finite gradient at ${x},${y},${z}`); continue; }
      maxGrad = Math.max(maxGrad, g); minGrad = Math.min(minGrad, g); sampled++;
    }
  }
}
console.log(`   sampled ${sampled} points, |grad| in [${minGrad.toFixed(3)}, ${maxGrad.toFixed(3)}]`);
ok(maxGrad < 1.35, 'field never grows much faster than distance (march would overshoot)');

// Every returned normal is unit length or the documented fallback.
for (const p of [[0, 2, 0], [0.4, 1.0, 0.5], [0, 1.02, 0], [0.10, 1.16, 0.32], [-3, -3, -3]]) {
  const n = collisionGradient(...p);
  near(Math.hypot(...n), 1, 1e-6, `gradient at ${p} is unit length`);
}

// The idle animation has to move the surface, or the blob rests where the body used to be.
const still = collisionSdf(0, 1.75, 0, { ...DEFAULT_PARAMS, time: 0 });
const later = collisionSdf(0, 1.75, 0, { ...DEFAULT_PARAMS, time: 1.0 });
ok(Math.abs(still - later) > 1e-4, 'the bob/squash actually moves the field over time');

// Anatomy uniforms have to reach the twin, or collision uses the wrong body.
ok(collisionSdf(0.85, 1.02, 0, { ...DEFAULT_PARAMS, bodyWidth: 1.4 })
   < collisionSdf(0.85, 1.02, 0, { ...DEFAULT_PARAMS, bodyWidth: 0.7 }),
  'a wider body reaches further out in x');
ok(collisionSdf(0.30, 1.75, 0, { ...DEFAULT_PARAMS, hornLen: 1.8 })
   < collisionSdf(0.30, 1.75, 0, { ...DEFAULT_PARAMS, hornLen: 0.2 }),
  'longer horns reach higher');

// ---------------------------------------------------------------------------
section('3. contact resolution');
// ---------------------------------------------------------------------------

const R = 0.30;

// A cursor ray aimed at `aim` from `dist` away along `dir`, asking to reach depth `t`.
function rayAt(dir, aim, dist, t) {
  const len = Math.hypot(...dir);
  const rd = [-dir[0] / len, -dir[1] / len, -dir[2] / len];
  const ro = [aim[0] - rd[0] * dist, aim[1] - rd[1] * dist, aim[2] - rd[2] * dist];
  return { ro, rd, t };
}
// Straight at the torso from the front, from 4.3 m out (the demo's default camera distance).
const front = (t) => rayAt([0, 0, 1], [0, 1.0, 0], 4.3, t);

{
  const r = restingBlob([1, 2, 3], R);
  ok(r.pos.join() === '1,2,3' && !r.contact && r.dentAmt === 0 && r.squashS === 1,
    'restingBlob is the identity state');
}

// Phase mode must be a pure passthrough — this is the "unchanged from Drin's original" guard.
{
  const ray = front(4.3);                       // dead centre of the body
  const r = resolveBlob(ray, DEFAULT_PARAMS, { blobR: R, collide: false });
  near(r.pos[2], ray.ro[2] + ray.rd[2] * 4.3, 1e-12, 'phase mode puts the blob exactly where asked');
  ok(r.dentAmt === 0 && r.squashS === 1 && !r.contact, 'phase mode reports no deformation');
  ok(collisionSdf(...r.pos) < 0, 'and phase mode really is inside the body there');
}

// Short of the body: untouched, no contact.
{
  const r = resolveBlob(front(2.0), DEFAULT_PARAMS, { blobR: R });
  ok(!r.contact, 'a blob stopped short of the body reports no contact');
  near(r.t, 2.0, 1e-12, 'and travels the full requested depth');
}

// Rigid body (dentGain 0): the centre comes to rest one blob radius from the surface, from every
// direction, however hard the cursor pushes. This is the core claim of collide mode.
for (const dir of [[0, 0, 1], [1, 0, 0], [-1, 0, 0.4], [0, 1, 0.2], [0.6, -0.4, 0.7]]) {
  for (const push of [4.4, 4.8, 6.0]) {
    const r = resolveBlob(rayAt(dir, [0, 1.0, 0], 4.3, push), DEFAULT_PARAMS, { blobR: R, dentGain: 0 });
    ok(r.contact, `contact detected from ${dir} at depth ${push}`);
    near(collisionSdf(...r.pos), R, 0.01, `rigid contact from ${dir} at ${push} rests one radius out`);
  }
}

// Pushing further must not move the blob further in — that is what "collide" means.
// (Front contact is reached at t ~ 3.38: camera 4.3 out, surface at z ~ 0.62, plus one radius.)
{
  const a = resolveBlob(front(4.5), DEFAULT_PARAMS, { blobR: R, dentGain: 0 });
  const b = resolveBlob(front(9.0), DEFAULT_PARAMS, { blobR: R, dentGain: 0 });
  near(a.t, b.t, 1e-6, 'a rigid contact stops at the same depth however hard it is pushed');

  const soft = resolveBlob(front(3.6), DEFAULT_PARAMS, { blobR: R, dentGain: 0 });
  const firm = resolveBlob(front(4.0), DEFAULT_PARAMS, { blobR: R, dentGain: 0 });
  ok(firm.press > soft.press, 'press grows with how far past contact the cursor asked to go');
  // ...up to the cap, which stops a cursor dragged out the far side from pinning every gain.
  near(a.press, R * 2.5, 1e-12, 'press saturates at the documented cap');
  near(b.press, a.press, 1e-12, 'and stays there however much further it is pushed');
}

// The complementary-split claim: body give and blob standoff trade off against each other.
{
  const rigid = resolveBlob(front(4.6), DEFAULT_PARAMS, { blobR: R, dentGain: 0 });
  const soft = resolveBlob(front(4.6), DEFAULT_PARAMS, { blobR: R, dentGain: 1 });
  ok(soft.t > rigid.t, 'a soft body lets the blob travel further in');
  ok(soft.dentAmt > rigid.dentAmt, 'and dents instead');
  near(rigid.dentAmt, 0, 1e-12, 'a rigid body does not dent at all');
  near(collisionSdf(...soft.pos), R - soft.dentAmt, 0.01,
    'the blob sinks in by exactly the dent depth');
}

// The dent cap is what keeps the shader's march safe, so it is asserted as a hard bound.
for (const push of [4.4, 4.6, 5.2, 8.0]) {
  const r = resolveBlob(front(push), DEFAULT_PARAMS, { blobR: R, dentGain: 1 });
  ok(r.dentAmt <= R * MAX_DENT + 1e-12, `dent stays under the Lipschitz cap at depth ${push}`);
}

// Squash: harder press means flatter blob, and it never collapses.
{
  const light = resolveBlob(front(3.6), DEFAULT_PARAMS, { blobR: R, squashGain: 1 });
  const hard = resolveBlob(front(4.2), DEFAULT_PARAMS, { blobR: R, squashGain: 1 });
  ok(hard.squashS < light.squashS, 'pressing harder flattens the blob more');
  ok(hard.squashS >= 0.35, 'the blob never collapses past the floor');
  const none = resolveBlob(front(5.0), DEFAULT_PARAMS, { blobR: R, squashGain: 0 });
  near(none.squashS, 1, 1e-12, 'zero blob give leaves it perfectly round');
}

// The contact normal has to point out of the body, or the squash axis is backwards.
for (const dir of [[0, 0, 1], [1, 0, 0], [0, 1, 0.3]]) {
  const r = resolveBlob(rayAt(dir, [0, 1.0, 0], 4.3, 5.0), DEFAULT_PARAMS, { blobR: R, dentGain: 0 });
  const n = r.contactN;
  near(Math.hypot(...n), 1, 1e-6, `contact normal from ${dir} is unit length`);
  const outward = collisionSdf(r.pos[0] + n[0] * 0.05, r.pos[1] + n[1] * 0.05, r.pos[2] + n[2] * 0.05);
  const inward = collisionSdf(r.pos[0] - n[0] * 0.05, r.pos[1] - n[1] * 0.05, r.pos[2] - n[2] * 0.05);
  ok(outward > inward, `contact normal from ${dir} points away from the body`);
}

// Nothing may tunnel: sweep the cursor across the whole creature and check the blob never ends up
// inside the body. This is the regression that the gradient-push version failed.
{
  let deepest = Infinity, worstAt = null, allFinite = true;
  for (let i = 0; i < 600; i++) {
    const a = (i / 600) * Math.PI * 2;
    const aim = [Math.cos(a) * 0.5, 0.2 + (i / 600) * 1.6, Math.sin(a) * 0.5];
    const ray = rayAt([Math.cos(a * 1.7), 0.3, Math.sin(a * 1.7)], aim, 4.3, 4.3 + (i % 7) * 0.4);
    const r = resolveBlob(ray, { ...DEFAULT_PARAMS, time: i * 0.03 }, { blobR: R, dentGain: 0 });
    if (![...r.pos, ...r.contactN, r.dentAmt, r.squashS, r.press].every(Number.isFinite)) {
      allFinite = false; console.error('  non-finite result at', ray); break;
    }
    const d = collisionSdf(r.pos[0], r.pos[1], r.pos[2], { ...DEFAULT_PARAMS, time: i * 0.03 });
    if (d < deepest) { deepest = d; worstAt = ray; }
  }
  ok(allFinite, '600 swept cursor rays all resolve finitely');
  console.log(`   closest the blob centre ever got to the surface: ${deepest.toFixed(4)} (radius ${R})`);
  ok(deepest > R - 0.02, 'no swept ray ever pushes the blob centre inside the body');
  if (!(deepest > R - 0.02)) console.error('  worst ray:', worstAt);
}

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
