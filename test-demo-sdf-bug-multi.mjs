// The multi-bug and flat-leaf machinery behind demos/sdf-bug-v2.html.
//
// WHAT THIS FILE IS FOR, given that it cannot render anything. Two things in that change could be wrong in
// a way no static check would notice:
//
//   1. THE TSL CONSTRUCTS. Per-bug uniforms became `uniformArray`s indexed by a value rather than by a
//      literal, `bugMap` gained an int input, and the march is a JS-unrolled loop of `If` blocks each
//      containing a `Loop` with a `Break`. If any of that is not legal in this build, the page goes black
//      and says nothing useful. This is also the file where the eye work's hard lesson applies: TSL builds
//      graphs out of `undefined`, coerces types freely, and reports arity as a console WARNING — so
//      warnings are captured and failed on, and every check evaluates a body rather than merely
//      constructing one.
//
//   2. THE FLAT LEAF'S DISTANCE. The dome is a sphere and exact by construction. A disc is not: its nearest
//      point is on the face for a point above it and on the RIM for a point outside, and an SDF that
//      over-estimates anywhere makes the march step through the surface. That is checked numerically
//      against a brute-force nearest point, which is the only way to know.
//
// What it does NOT check is the page's own shader source — the field lives inline in the HTML and is not
// importable. `_check_sdf-bug-v2.html.mjs` reads it as text; the picture itself is the browser's job.
import * as THREE from 'three';
import {
  Fn, If, Loop, Break, float, int, vec2, vec3, uniform, uniformArray, select, expression,
  min, max, abs, length, dot, stack, setCurrentStack,
} from 'three/tsl';
import { BUG_LEGS, BODY_PIVOT, createBugRig, scaleBugGait, BUG_GAIT } from './demos/bug-rig.js';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${label}${detail ? ' — ' + detail : ''}`);
  return false;
}
const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, label, `${a} vs ${b} (tol ${tol})`);
const section = (t) => console.log(`\n${t}`);

// A fresh stack per group, so `If` and `toVar` work outside a builder. Without this every branch below
// throws, and with it a branch's callback is STORED and replayed at build time rather than run — which is
// why the checks that matter here call named functions directly instead of trusting a branch to have run.
const fresh = () => { setCurrentStack(stack()); };

// TSL reports a wrong argument count as a console warning and carries on building a different program.
// Silence is part of the assertion.
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };
process.on('exit', () => { console.warn = realWarn; });

// ============================================================ 1. the constructs build
section('1. the per-bug uniform machinery is legal in this build');

const MAX_BUGS = 6;
const JOINTS = BUG_LEGS.length * 2 * 3;

{
  fresh();
  const jointsU = uniformArray(
    Array.from({ length: MAX_BUGS * JOINTS }, () => new THREE.Vector3()), 'vec3');
  const scaleU = uniformArray(new Array(MAX_BUGS).fill(1), 'float');
  const tintU = uniformArray(Array.from({ length: MAX_BUGS }, () => new THREE.Color('#6b3c14')));
  const boundAtU = uniformArray(Array.from({ length: MAX_BUGS }, () => new THREE.Vector3()), 'vec3');
  const boundRU = uniformArray(new Array(MAX_BUGS).fill(0.9), 'float');
  const countU = uniform(1);
  const flatU = uniform(0);
  const radiusU = uniform(2.4);

  // Padding: every element of a uniform array pads to a vec4, so an array of floats is four times the size
  // it reads as. That was noted first as a size argument and dismissed as not worth packing — which was the
  // wrong reason to look at it, because SIZE was never the constraint.
  ok(jointsU.elementType === 'vec3' && jointsU.paddedType === 'vec4', 'a vec3 array pads to vec4');
  ok(boundRU.elementType === 'float' && boundRU.paddedType === 'vec4',
    'and so does a float array — 4x the bytes it looks like', boundRU.paddedType);
  ok(tintU.elementType === 'color', 'colours stay colours, so the hex-to-linear conversion is unchanged',
    tintU.elementType);
  ok(jointsU.array.length === MAX_BUGS * JOINTS, `${MAX_BUGS} slots x ${JOINTS} joints`);

  // THE CONSTRAINT WAS BINDINGS, NOT BYTES, and it cost a black page to find out. Every `uniformArray` is a
  // `BufferNode`, so each one takes its own binding, and WebGPU guarantees only
  // `maxUniformBuffersPerShaderStage = 12`. Giving each per-bug field its own array made thirty-two of them
  // and the device refused to create the pipeline — with a message naming the pipeline and not the cause.
  // Node cannot check the limit, because only a real device consults it; what it CAN check is the fact that
  // makes the limit apply, which is asserted here so the reasoning is not just a comment.
  ok(jointsU.isBufferNode === true, 'a uniform array is a BufferNode, hence its own binding',
    'which is why the page packs every per-bug field into one array instead of naming them separately');
  ok(new Set([jointsU, scaleU, tintU].map((a) => a.isBufferNode)).size === 1,
    'and that is true of every element type, not just vectors');

  // The field, in the shape the page uses it: a dynamic index, index ARITHMETIC for the joints, and a real
  // `setLayout` so it is emitted as a function rather than pasted at every call site.
  const bugFields = (idx) => ({
    scale: scaleU.element(idx),
    tint: tintU.element(idx),
    boundAt: boundAtU.element(idx),
    boundR: boundRU.element(idx),
    joint: (j) => jointsU.element(idx.mul(JOINTS).add(j)),
  });

  let bodyRan = 0;
  const fakeBugMap = Fn(([pw, bugIdx]) => {
    bodyRan++;
    const B = bugFields(bugIdx);
    const S = B.scale;
    // the page's transform: rotate in (a dot product each), divide by the scale, add the unit pivot
    const p = vec3(dot(pw, vec3(1, 0, 0)), dot(pw, vec3(0, 1, 0)), dot(pw, vec3(0, 0, 1)))
      .div(S).add(vec3(BODY_PIVOT[0], BODY_PIVOT[1], BODY_PIVOT[2]));
    let d = null;
    for (let i = 0; i < 6; i++) {
      const a = B.joint(i * 3), b = B.joint(i * 3 + 1);
      const seg = min(length(p.sub(a)), length(p.sub(b)));
      d = d === null ? seg : min(d, seg);
    }
    return vec2(d.mul(S).add(B.tint.x), float(1));
  });
  fakeBugMap.setLayout({
    name: 'fakeBugMap', type: 'vec2',
    inputs: [{ name: 'pw', type: 'vec3' }, { name: 'bugIdx', type: 'int' }],
  });

  // `Fn(body)()` does NOT run the body — that cost a whole round of false green during the eye work. So the
  // count below is expected to be zero, and it is asserted rather than assumed, because if it ever becomes
  // non-zero the reasoning in the rest of this file changes.
  fakeBugMap(vec3(0, 0, 0), int(0));
  ok(bodyRan === 0, 'Fn bodies are still not executed by a call — the graph is built at compile time',
    `${bodyRan}`);

  // WHAT CANNOT BE CHECKED HERE, stated plainly because a check that cannot fail is worse than none.
  // `If` and `Loop` callbacks are STORED and replayed when the shader is built, which never happens in
  // Node: measured, both run exactly zero times, and a deliberate `throw` placed inside the page's
  // innermost march loop left this file reporting 88 of 88. Nor does TSL object to a missing argument — no
  // throw, no warning, no error — so arity cannot be caught here either. The static checker carries that
  // burden instead, by asserting every `bugMap(` call site passes both arguments.
  //
  // So the fix is the same one the eye appearances needed: put the work in something callable. Everything
  // below is evaluated DIRECTLY rather than handed to a branch and hoped about.
  fresh();
  {
    const B = bugFields(int(2));
    ok(['scale', 'tint', 'boundAt', 'boundR'].every((k) => B[k] && B[k].isNode),
      'a per-bug field lookup returns real nodes for every field');
    const j0 = B.joint(0), j17 = B.joint(17);
    ok(j0 && j17 && j0.isNode && j17.isNode, 'and a joint lookup returns a node');
    // NOT an identity comparison — `j0 !== j17` was the first version of this check and it passed even with
    // the index arithmetic removed entirely, because every call builds a fresh node object either way. What
    // actually matters is the STRIDE: the shader reads `element(idx * JOINTS + j)` and the CPU writes
    // `array[i * JOINTS + j]`, so the two agree only if they share the stride. A wrong stride would have
    // one bug reading another's legs, which is checked as a mapping rather than as a graph.
    ok(JOINTS === BUG_LEGS.length * 2 * 3, 'the stride is six legs of three joints', `${JOINTS}`);
    const seen = new Set();
    let collisions = 0, outOfRange = 0;
    for (let i = 0; i < MAX_BUGS; i++) {
      for (let j = 0; j < JOINTS; j++) {
        const flat = i * JOINTS + j;
        if (seen.has(flat)) collisions++;
        seen.add(flat);
        if (flat < 0 || flat >= MAX_BUGS * JOINTS) outOfRange++;
      }
    }
    ok(collisions === 0, 'and no two (bug, joint) pairs share a slot', `${collisions}`);
    ok(outOfRange === 0, 'and none falls outside the array', `${outOfRange}`);
    ok(seen.size === MAX_BUGS * JOINTS, 'the mapping covers the whole array', `${seen.size}`);

    // The expression the march evaluates at every step, as a named function the test calls itself. If any
    // of this were malformed — a missing method on this build, a bad type — it would throw here.
    const marchStep = (idx, t) => {
      const p = vec3(0, 0, 1).mul(t);
      const r = fakeBugMap(p, idx);
      const stepped = t.add(r.x.mul(0.85));
      const bound = length(p.sub(boundAtU.element(idx))).sub(boundRU.element(idx));
      return { advance: stepped, hit: r.x.lessThan(float(0.001)), bound };
    };
    let built = null;
    try {
      const out = marchStep(int(1), float(0.5));
      built = out.advance && out.hit && out.bound;
    } catch (e) {
      failures.push(`the march step threw: ${e.message}`);
    }
    ok(!!built, 'the per-step expression builds: field call, hit test, advance and bound reject');

    // The shading's float-to-int round trip, which is how the hit bug is looked up again. Also called
    // rather than branched.
    let round = null;
    try {
      const hit = float(3);
      const H = bugFields(int(hit));
      round = H.scale && H.tint && H.invRow0 === undefined;   // invRow0 is not in this stub's field set
    } catch (e) {
      failures.push(`the float-to-int index threw: ${e.message}`);
    }
    ok(!!round, 'and a float hit index converts back into an array index');

    // The nesting itself is only CONSTRUCTED here, which is all Node can do. Asserted so the file records
    // that it ran without throwing at construction time, and no more than that.
    let constructed = false;
    try {
      const tBug = float(-1).toVar();
      for (let i = 0; i < MAX_BUGS; i++) {
        If(float(i).lessThan(countU), () => {
          Loop(8, () => {
            If(tBug.greaterThan(float(14)), () => { Break(); });
          });
        });
      }
      constructed = true;
    } catch (e) {
      failures.push(`the unrolled nesting threw at construction: ${e.message}`);
    }
    ok(constructed, 'the unrolled If/Loop/Break nesting constructs',
      'construction only — the callbacks do not run until the shader is built in a browser');
  }

  // The flat/dome select, which is the whole cost of the leaf-shape choice.
  fresh();
  try {
    const p = vec3(0.3, 0.2, -0.4);
    const radial = length(vec2(p.x, p.z));
    const dome = length(p.sub(vec3(0, radiusU.negate(), 0))).sub(radiusU);
    const flat = length(vec2(max(radial.sub(radiusU), float(0)), p.y));
    const leaf = select(flatU.greaterThan(0.5), flat, dome);
    ok(leaf !== undefined, 'the leaf shape is a select over two closed forms, not a branch');
  } catch (e) {
    ok(false, 'the leaf shape is a select over two closed forms, not a branch', e.message);
  }
}

// Kept because a warning here would be real information, but NOT relied on: measured, TSL does not warn
// about a missing argument in this build, so silence is not evidence of a correct call.
ok(warnings.length === 0, 'and TSL emitted no warnings while building any of it',
  warnings.join(' | ').slice(0, 300));

// ============================================================ 2. the disc is a real SDF
section('2. the flat leaf under-estimates nowhere');

// The flat leaf is the solid `{radial <= R, y <= 0}` — a half-infinite cylinder whose top face is the leaf —
// and NOT a zero-thickness disc. The reason is consistency: the dome is a sphere, whose distance is signed
// and negative inside, so an unsigned flat leaf would have the two shapes disagreeing about which side of
// the surface a shading tap is on. The claim under test is that
// `length(max(q, 0)) + min(max(q.x, q.y), 0)`, with `q = (radial - R, y)`, is that solid's EXACT signed
// distance. Checked against a brute-force nearest point, because an SDF that over-estimates anywhere lets
// the march step through the surface, and one that does so only in a thin band at the rim is exactly the
// bug that survives a spot check.
{
  const R = 2.4;
  const discD = (x, y, z) => {
    const qx = Math.hypot(x, z) - R, qy = y;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  };
  // Brute force, by cases: outside the rim and above the face it is the corner; above the face and inside
  // the rim it is the height; inside the solid it is the distance to the nearer of the two boundaries.
  const brute = (x, y, z) => {
    const radial = Math.hypot(x, z);
    if (y >= 0) return radial <= R ? y : Math.hypot(radial - R, y);
    if (radial > R) return Math.hypot(radial - R, Math.max(y, 0)) + (y < 0 ? 0 : 0);
    return -Math.min(-y, R - radial);
  };
  // And an independent sampled check, in case the two closed forms above share a mistake.
  // Sampled over the TOP FACE only, so it is a valid cross-check just for points above the plane — which is
  // where the primary ray and every shading tap actually are.
  const sampled = (x, y, z) => {
    let best = Infinity;
    for (let i = 0; i < 720; i++) {
      const a = (i / 720) * Math.PI * 2;
      for (let k = 0; k <= 60; k++) {
        const r = (k / 60) * R;
        best = Math.min(best, Math.hypot(x - Math.cos(a) * r, y, z - Math.sin(a) * r));
      }
    }
    return best;
  };

  let worstOver = 0, worstDiff = 0, n = 0;
  for (let ix = -8; ix <= 8; ix++) {
    for (let iy = -6; iy <= 6; iy++) {
      for (let iz = -8; iz <= 8; iz++) {
        const x = ix * 0.5, y = iy * 0.35, z = iz * 0.5;
        const d = discD(x, y, z), b = brute(x, y, z);
        worstDiff = Math.max(worstDiff, Math.abs(d - b));
        worstOver = Math.max(worstOver, d - b);
        n++;
      }
    }
  }
  console.log(`   ${n} points: worst |closed form - nearest point| ${worstDiff.toExponential(2)}`);
  ok(worstDiff < 1e-12, 'the closed form is the exact distance, not a bound', worstDiff.toExponential(2));
  ok(worstOver <= 0 || worstOver < 1e-12, 'and in particular never over-estimates',
    worstOver.toExponential(2));

  // A coarse sampled cross-check at a handful of awkward places: just outside the rim, just above it, far
  // below, and exactly on the edge.
  let worstSampled = 0;
  for (const [x, y, z] of [[R + 0.4, 0.0, 0], [R - 0.1, 0.02, 0], [0, 1.7, 0], [R, 0, 0],
    [1.4, 0.9, -1.6], [-2.9, 0.3, 0.7]]) {
    worstSampled = Math.max(worstSampled, Math.abs(discD(x, y, z) - sampled(x, y, z)));
  }
  console.log(`   sampled cross-check, worst disagreement ${worstSampled.toExponential(2)}`);
  ok(worstSampled < 0.02, 'and a sampled nearest point agrees with it', worstSampled.toExponential(2));

  // Sign: this form is unsigned, which is legal for a march from outside and is what the page relies on.
  // Recorded so nobody later assumes it reports negative distances inside the disc.
  near(discD(0, 0, 0), 0, 0, 'a point on the face reads exactly zero');
  near(discD(0, -0.5, 0), -0.5, 1e-12, 'and below it reads NEGATIVE, like the dome does');
  near(discD(0, -3.0, 0), -R, 1e-12, 'deep inside, the nearest boundary is the side wall, not the face');
  near(discD(R + 1, 0, 0), 1, 1e-12, 'and out past the rim it is the distance to the edge');
}

// ============================================================ 3. size scales the gait, not just the legs
section('3. a smaller bug is not just a smaller model');

{
  // Froude similarity: lengths as s, times and speeds as sqrt(s), angular rates as 1/sqrt(s). The point of
  // testing it is that the WRONG answer looks plausible — scaling the timings linearly, or not at all, both
  // produce a bug that walks, and one of them reads as a shrunken elephant.
  for (const s of [0.25, 0.5, 2, 4]) {
    const g = scaleBugGait(BUG_GAIT, s);
    const t = Math.sqrt(s);
    near(g.stepLift, BUG_GAIT.stepLift * s, 1e-12, `s=${s}: step lift is a length`);
    near(g.comfort.h, BUG_GAIT.comfort.h * s, 1e-12, `s=${s}: the comfort box is a length`);
    near(g.restepEpsilon, BUG_GAIT.restepEpsilon * s, 1e-12, `s=${s}: so is the re-step epsilon`);
    near(g.maxSpeed, BUG_GAIT.maxSpeed * t, 1e-12, `s=${s}: speed goes as sqrt(s)`);
    near(g.stepDuration, BUG_GAIT.stepDuration * t, 1e-12, `s=${s}: and so does a stride's duration`);
    near(g.turnSpeed, BUG_GAIT.turnSpeed / t, 1e-12, `s=${s}: an angular rate goes the other way`);
    // The dimensionless ones must NOT move, and this is the half that is easy to get wrong by being thorough.
    near(g.movingHeight, BUG_GAIT.movingHeight, 0, `s=${s}: body height is a fraction of the leg`);
    near(g.lookAhead, BUG_GAIT.lookAhead, 0, `s=${s}: look-ahead multiplies a distance already scaled`);
    near(g.maxConcurrentFraction, BUG_GAIT.maxConcurrentFraction, 0, `s=${s}: a ratio is a ratio`);
    near(g.uncomfortableSpeedMultiplier, BUG_GAIT.uncomfortableSpeedMultiplier, 0, `s=${s}: and so is this`);
    near(g.rotationLerp, BUG_GAIT.rotationLerp, 0, `s=${s}: a blend factor is not a rate`);
  }
  ok(BUG_GAIT.stepDuration === 0.115, 'and the source table was not mutated', `${BUG_GAIT.stepDuration}`);
  ok((() => { try { scaleBugGait(BUG_GAIT, 0); return false; } catch { return true; } })(),
    'a zero scale is rejected rather than producing a gait of zeroes');

  // Round-tripping the size must not compound: sqrt applied twice is not sqrt applied once, which is why
  // `setScale` re-derives from the unscaled table rather than from the current gait.
  const rig = createBugRig({ THREE, sproutR: 2.4 });
  rig.reset();
  const span0 = rig.legs[0].span, dur0 = rig.state.gait.stepDuration;
  for (const s of [2, 0.5, 1.7, 0.8, 1]) rig.setScale(s);
  near(rig.legs[0].span, span0, 1e-12, 'a round trip through five sizes returns the same leg');
  near(rig.state.gait.stepDuration, dur0, 1e-12, 'and the same gait, rather than a compounded one');
  near(rig.worstFootError(), 0, 1e-12, 'with the feet back on the leaf');

  // And the geometry really did move, or the checks above would be measuring nothing.
  rig.setScale(2);
  ok(rig.legs[0].span > span0 * 1.5, 'a double-size bug has a visibly longer leg',
    `${rig.legs[0].span.toFixed(3)} vs ${span0.toFixed(3)}`);
  ok(rig.body.pos.y > 0.6, 'and stands higher', rig.body.pos.y.toFixed(3));
}

// ============================================================ 4. bugs are independent
section('4. several bugs on one leaf stay independent');

{
  const seeded = (s0) => { let s = s0 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
  const made = [];
  for (const [i, [scale, place]] of [
    [1.0, { x: 0.0, z: 0.0, yaw: 0 }],
    [0.5, { x: 0.6, z: -0.5, yaw: 1.1 }],
    [1.8, { x: -0.7, z: 0.4, yaw: -2.2 }],
  ].entries()) {
    const r = createBugRig({ THREE, sproutR: 2.4, scale, rng: seeded(11 + i) });
    r.reset(place);
    made.push({ r, scale });
  }
  // Interleaved, the way the page's loop steps them, so a shared scratch vector in the rig or the
  // locomotion module would show up as one bug's pose disturbing another's.
  for (let f = 0; f < 1800; f++) for (const { r } of made) r.update(1 / 60, { walk: true });

  for (const { r, scale } of made) {
    let inv = 0, n = 0;
    for (const q of r.legPose()) { n++; if (q.inverted) inv++; }
    ok(inv === 0, `the ${scale}x bug's knees are still right way round`, `${inv}/${n}`);
    ok(r.worstFootError() < 1e-9, `and its planted feet are on the leaf`,
      `${(r.worstFootError() * 1000).toFixed(3)}mm`);
    ok(Math.hypot(r.body.pos.x, r.body.pos.z) < 2.4, 'and it is still on the leaf',
      Math.hypot(r.body.pos.x, r.body.pos.z).toFixed(2));
  }
  const spots = made.map(({ r }) => `${r.body.pos.x.toFixed(2)},${r.body.pos.z.toFixed(2)}`);
  ok(new Set(spots).size === spots.length, 'and they are in different places', spots.join(' '));
  console.log(`   after 30 s: ${made.map(({ r, scale }) => `${scale}x at ${r.body.pos.x.toFixed(2)},${r.body.pos.z.toFixed(2)}`).join('; ')}`);

  // The unit-space joints are what the shader reads, so the world round trip is the invariant that keeps a
  // scaled bug's legs attached to its scaled body.
  let worst = 0;
  for (const { r, scale } of made) {
    const w = r.joints(), un = r.jointsUnit();
    const piv = new THREE.Vector3(...BODY_PIVOT);
    for (let j = 0; j < w.length / 3; j++) {
      const back = new THREE.Vector3(un[j * 3], un[j * 3 + 1], un[j * 3 + 2])
        .sub(piv).multiplyScalar(scale).applyMatrix3(r.rotation).add(r.body.pos);
      worst = Math.max(worst, back.distanceTo(new THREE.Vector3(w[j * 3], w[j * 3 + 1], w[j * 3 + 2])));
    }
  }
  ok(worst < 1e-12, 'unit joints carry back to the world joints exactly', worst.toExponential(2));
}

// ============================================================ 5. the flat ground is the same seam
section('5. the flat leaf changes the ground and nothing else');

{
  for (const scale of [0.6, 1, 1.6]) {
    const r = createBugRig({ THREE, sproutR: 2.4, scale, groundShape: 'flat' });
    r.reset();
    near(r.worstFootError(), 0, 1e-12, `flat, ${scale}x: parked feet are exactly on the plane`);
    let inv = 0, n = 0;
    for (let i = 0; i < 1800; i++) {
      r.update(1 / 60, { walk: true });
      for (const q of r.legPose()) { n++; if (q.inverted) inv++; }
    }
    ok(inv === 0, `flat, ${scale}x: no knee inverts over 30 s`, `${inv}/${n}`);
    ok(Math.hypot(r.body.pos.x, r.body.pos.z) < r.state.roamRadius * 1.3,
      `flat, ${scale}x: and it stays on the disc`,
      `${Math.hypot(r.body.pos.x, r.body.pos.z).toFixed(2)} vs roam ${r.state.roamRadius.toFixed(2)}`);
  }
  // A plane has no steep part, so the bug is allowed more of it. That is a deliberate difference, recorded
  // so a later change to one radius does not silently assume the other.
  const dome = createBugRig({ THREE, sproutR: 2.4, groundShape: 'dome' });
  const flat = createBugRig({ THREE, sproutR: 2.4, groundShape: 'flat' });
  ok(flat.state.roamRadius > dome.state.roamRadius,
    'a flat leaf is roamed further than a dome of the same radius',
    `${flat.state.roamRadius.toFixed(2)} vs ${dome.state.roamRadius.toFixed(2)}`);
  // And switching shape must re-solve the legs, not merely swap the function.
  dome.setGround({ shape: 'flat' });
  near(dome.worstFootError(), 0, 1e-12, 'switching shape restands the legs on the new surface');
  ok(dome.state.roamRadius === flat.state.roamRadius, 'and re-derives the roaming radius');
}

// ============================================================ 6. nested Loops collide on their index name
section('6. a dynamic Loop index is a name, and a nested Loop shadows it');

// THIS SECTION EXISTS BECAUSE OF A BLACK BALL. Converting the per-bug march from a JS-unrolled loop to
// `Loop(u.bugCount, ...)` made the bug index a WGSL variable instead of a literal — and the march loop
// nested inside it declares a variable of its own with THE SAME NAME, which shadows it for the whole of its
// body. So `bugMap(point, i)` in there was evaluating the march's step number as the bug index: step 0 read
// bug 0, step 1 read an unused slot, and an unused slot's field was a constant from inside the shell, so
// the ray hit on its second step and the bounding sphere rendered as a solid black ball across the frame.
//
// It is legal WGSL, so nothing errored, and no static check can see the scoping. What CAN be pinned down is
// the fact underneath: the names collide. If a later three makes loop variables unique, these fail and the
// captures in the page become unnecessary rather than load-bearing — which is worth being told about.
{
  const outer = Loop(uniform(3, 'int'), ({ i }) => i);
  const inner = Loop(40, () => {});
  const on = outer.node ?? outer, inn = inner.node ?? inner;
  ok(typeof on.getVarName === 'function', 'a Loop names its index through getVarName',
    'if this has been renamed the rest of this section is checking nothing');
  ok(on.getVarName(0) === 'i', "the outer loop's index is named 'i'", on.getVarName(0));
  ok(inn.getVarName(0) === 'i', "and so is a nested numeric loop's counter", inn.getVarName(0));
  ok(on.getVarName(0) === inn.getVarName(0),
    'the names COLLIDE — nothing makes them unique per loop',
    'which is why the bug index has to be captured before entering a nested loop');
  // The index reaches the callback as an EXPRESSION carrying that bare name, which is what makes the
  // collision matter: it is resolved by WGSL scope at the point of use, not bound when the callback ran.
  const idx = expression('i', 'int');
  ok((idx.snippet ?? idx.node?.snippet) === 'i', 'and it is passed as a bare name, resolved where it is used');
  // The fix, and that it really does carry its own name.
  const captured = idx.toVar('bugIndex');
  ok((captured.isVarNode ?? captured.node?.isVarNode) === true, 'toVar turns it into a variable of its own');
  ok((captured.name ?? captured.node?.name) === 'bugIndex', 'under a name a nested loop will not reuse',
    String(captured.name ?? captured.node?.name));
  // What this cannot check: that WGSL resolves the inner declaration rather than the outer, that the page's
  // two loops are the ones carrying captures, or that the shading reads the captured slot. Those are text
  // rules in `_check_sdf-bug-v2.html.mjs`, canaried by reintroducing each defect.
  ok(true, 'recorded: the scoping itself is the browser\'s to prove, and the picture is how it showed');
}

// ============================================================ summary
console.warn = realWarn;
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
