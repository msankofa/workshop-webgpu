// demos/bug-rig.js — the walking rig behind demos/sdf-bug-v2.html.
//
// The gait itself is not tested here; it is `creature-locomotion.js`, covered by
// test-creature-locomotion.mjs. What this file checks is the part that is new in v2:
//
//   - six independent legs with an insect's alternating tripod, which v1's mirror made impossible
//   - the parked pose reproducing v1 EXACTLY, cross-checked against v1's own CPU twin rather than
//     against arithmetic restated here
//   - authored space and world space being exact inverses, since the body's field lives in one and its
//     legs live in the other
//   - the feet actually staying on the dome while it walks, at several leaf radii
//   - the bounding sphere the shader marches inside genuinely containing the bug
import * as THREE from 'three';
import {
  createBugRig, bugLegSpecs, domeGround, BUG_LEGS, BUG_GAIT, BUG_LEG_LIMITS, BODY_PIVOT, FOOT_SINK,
} from './demos/bug-rig.js';
// v1's twin, used as an independent oracle for the authored pose.
import { footPos as v1FootPos, LEGS as V1_LEGS, DEFAULT_ANATOMY as V1_ANATOMY } from './demos/bug-sdf.js';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${label}${detail ? ' — ' + detail : ''}`);
  return false;
}
const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, label, `${a} vs ${b} (tol ${tol})`);
const section = (t) => console.log(`\n${t}`);

const seeded = (s0) => { let s = s0 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
const rig = () => createBugRig({ THREE, rng: seeded(4242) });

// ============================================================ 1. six legs, one tripod
section('1. six independent legs, in an alternating tripod');

{
  const specs = bugLegSpecs();
  ok(specs.length === 6, 'three authored pairs become six legs', `${specs.length}`);
  ok(specs.filter(s => s.side < 0).length === 3, 'three on the left');
  ok(specs.filter(s => s.side > 0).length === 3, 'three on the right');
  ok(new Set(specs.map(s => s.row)).size === 3, 'three rows');

  // The tripod is the whole point: each phase must be one leg per row, alternating sides.
  for (const phase of [0, 1]) {
    const group = specs.filter(s => s.phase === phase);
    ok(group.length === 3, `phase ${phase} has three legs`, `${group.length}`);
    ok(new Set(group.map(s => s.row)).size === 3, `phase ${phase} spans all three rows`);
    const sides = group.sort((a, b) => a.row - b.row).map(s => s.side);
    ok(sides[0] !== sides[1] && sides[1] !== sides[2],
      `phase ${phase} alternates sides down the body`, sides.join(','));
  }
  const p0 = specs.filter(s => s.phase === 0).sort((a, b) => a.row - b.row)
    .map(s => `${s.row}${s.side < 0 ? 'L' : 'R'}`).join(',');
  console.log(`   phase 0 = ${p0}`);
  ok(p0 === '0L,1R,2L', 'phase 0 is front-left, middle-right, back-left', p0);

  // Legs must be mirrored in x only. Scaling z as well would move the rows, which is the mistake that
  // once made a leg-spread slider quietly re-space the body.
  for (const row of [0, 1, 2]) {
    const l = specs.find(s => s.row === row && s.side < 0);
    const r = specs.find(s => s.row === row && s.side > 0);
    near(l.hip[2], r.hip[2], 0, `row ${row} hips share a z`);
    near(l.foot[1], r.foot[1], 0, `row ${row} feet share a z`);
    near(l.hip[0], -r.hip[0], 1e-15, `row ${row} hips mirror in x`);
  }
  const wide = bugLegSpecs({ legSpread: 1.4 });
  const narrow = bugLegSpecs({ legSpread: 0.7 });
  ok(Math.abs(wide[0].foot[0]) > Math.abs(narrow[0].foot[0]), 'legSpread widens the stance');
  near(wide[0].foot[1], narrow[0].foot[1], 0, 'and leaves the row depth alone');
}

// ============================================================ 2. the parked pose is v1's pose
section('2. parked, v2 is v1 — checked against v1\'s own twin');

{
  const r = rig();
  r.reset();
  near(r.body.pos.x, BODY_PIVOT[0], 0, 'body parks at the pivot, x');
  near(r.body.pos.y, BODY_PIVOT[1], 0, 'body parks at the pivot, y');
  near(r.body.pos.z, BODY_PIVOT[2], 0, 'body parks at the pivot, z');
  near(r.body.yaw, 0, 0, 'no yaw');
  near(r.body.pitch, 0, 0, 'no pitch');
  near(r.body.roll, 0, 0, 'no roll');

  // Identity rotation is what makes authored space and world space the same thing at rest, which is what
  // makes v2's parked frame v1's picture.
  const m = r.rotation.elements;
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let worstI = 0;
  for (let i = 0; i < 9; i++) worstI = Math.max(worstI, Math.abs(m[i] - I[i]));
  ok(worstI === 0, 'the parked rotation is exactly the identity', worstI.toExponential(2));

  // Feet against v1's twin. This is the check that matters: an independent implementation of the same
  // authored geometry, not a restatement of bug-rig's own arithmetic.
  const anatomy = { ...V1_ANATOMY, legSpread: 1, sproutR: 2.4 };
  let worstFoot = 0;
  for (const leg of r.legs) {
    const v1 = v1FootPos(V1_LEGS[leg.row], anatomy);
    // v1's table is one side; v2's left leg is its mirror.
    const want = [v1[0] * leg.side, v1[1], v1[2]];
    worstFoot = Math.max(worstFoot,
      Math.abs(leg.end.x - want[0]), Math.abs(leg.end.y - want[1]), Math.abs(leg.end.z - want[2]));
  }
  ok(worstFoot < 1e-15, 'every parked foot is where v1 puts it', worstFoot.toExponential(2));
  console.log(`   worst disagreement with v1's twin: ${worstFoot.toExponential(2)}`);

  near(r.worstFootError(), 0, 0, 'and exactly on the dome');

  // FOOT_SINK has to mean the same thing in both files or the feet would float or sink.
  near(FOOT_SINK, 0.35, 0, 'FOOT_SINK matches v1');
  near(r.footClearance, BUG_LEGS[0].r[2] * (1 - FOOT_SINK), 1e-18,
    'foot clearance is the unburied part of the tip');
}

// ============================================================ 3. the two spaces are inverses
section('3. authored space and world space are exact inverses');

{
  const r = rig();
  r.reset();
  // Walk it somewhere with a real rotation before testing, or the identity would flatter the check.
  for (let i = 0; i < 400; i++) r.update(1 / 60, { walk: true });
  ok(Math.abs(r.body.pitch) + Math.abs(r.body.roll) > 1e-4,
    'the body really is tilted for this test', `pitch ${r.body.pitch}, roll ${r.body.roll}`);

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  let worst = 0;
  for (const [x, y, z] of [[0, 0, 0], [1, 2, 3], [-0.4, 0.31, 0.5], [10, -7, 0.001], [0.3, 0.3, 0.3]]) {
    const p = V(x, y, z);
    const back = r.toWorld(r.toAuthored(p, V(0, 0, 0)), V(0, 0, 0));
    worst = Math.max(worst, back.distanceTo(p));
  }
  ok(worst < 1e-12, 'toAuthored then toWorld is the identity', worst.toExponential(3));

  // And the transform must PRESERVE DISTANCE, which is what makes it legal to union a body distance
  // computed in authored space with a leg distance computed in world space.
  let worstD = 0;
  const pairs = [[[0, 0, 0], [1, 0, 0]], [[0.2, 0.4, 0.1], [-0.3, 0.9, 0.7]], [[5, 5, 5], [-5, -5, -5]]];
  for (const [a, b] of pairs) {
    const wa = V(...a), wb = V(...b);
    const aa = r.toAuthored(wa, V(0, 0, 0)), ab = r.toAuthored(wb, V(0, 0, 0));
    worstD = Math.max(worstD, Math.abs(wa.distanceTo(wb) - aa.distanceTo(ab)));
  }
  ok(worstD < 1e-12, 'and it is an isometry', worstD.toExponential(3));
  console.log(`   round trip ${worst.toExponential(2)}, distance drift ${worstD.toExponential(2)}`);

  // The hips must land where the transform says they should.
  let worstHip = 0;
  for (const leg of r.legs) {
    const want = r.toWorld(leg.attachmentLocal.clone().add(r.pivot), V(0, 0, 0));
    worstHip = Math.max(worstHip, leg.hipWorld.distanceTo(want));
  }
  ok(worstHip < 1e-12, 'the IK hips agree with the body transform', worstHip.toExponential(3));
}

// ============================================================ 4. it walks, and stays on the leaf
section('4. it walks, and the planted feet stay on the leaf');

for (const [name, preset] of Object.entries({
  scurry: BUG_GAIT,
  creep: { ...BUG_GAIT, maxSpeed: 0.14, stepDuration: 0.20, stepLift: 0.026, maxConcurrentFraction: 0.34 },
  dash: { ...BUG_GAIT, maxSpeed: 0.62, stepDuration: 0.085, stepLift: 0.050,
          movingTrigger: { h: 0.15, v: 0.075 }, comfort: { h: 0.24, v: 0.15 } },
})) {
  const r = createBugRig({ THREE, rng: seeded(77), gait: preset });
  r.reset();
  const cap = Math.max(1, Math.floor(6 * r.state.gait.maxConcurrentFraction));
  let odo = 0, worstAir = 0, allAir = 0, worstOffDome = 0, footfalls = 0, minClear = Infinity;
  let sank = 0, nonFinite = 0, worstStretch = 0;
  const prevStep = new Map();
  const prev = r.body.pos.clone();

  for (let i = 0; i < 1800; i++) {
    r.update(1 / 60, { walk: true });
    odo += Math.hypot(r.body.pos.x - prev.x, r.body.pos.z - prev.z);
    prev.copy(r.body.pos);

    const air = r.legs.filter(l => l.stepping).length;
    worstAir = Math.max(worstAir, air);
    if (air === 6) allAir++;
    worstOffDome = Math.max(worstOffDome, r.worstFootError());
    for (const l of r.legs) {
      if (prevStep.get(l) && !l.stepping) footfalls++;
      prevStep.set(l, l.stepping);
      // FABRIK must not stretch the bones, or the legs would visibly grow mid-step.
      for (let k = 0; k < l.chain.lengths.length; k++) {
        const d = l.chain.points[k].distanceTo(l.chain.points[k + 1]);
        worstStretch = Math.max(worstStretch, Math.abs(d - l.chain.lengths[k]));
      }
      if (!l.chain.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) nonFinite++;
    }
    const clear = r.body.pos.y - r.state.ground(r.body.pos.x, r.body.pos.z);
    minClear = Math.min(minClear, clear);
    if (clear < 0) sank++;
  }

  console.log(`   ${name.padEnd(7)} travelled ${odo.toFixed(2)} in 30s, ${footfalls} footfalls, `
    + `peak ${worstAir}/6 airborne (cap ${cap}), feet ${(worstOffDome * 1000).toFixed(3)}mm off the dome`);
  ok(odo > 1.0, `${name}: actually travels`, `${odo.toFixed(2)} units`);
  ok(footfalls > 50, `${name}: takes real steps`, `${footfalls} footfalls`);
  ok(worstAir <= cap, `${name}: never exceeds the concurrent-step cap`, `${worstAir} > ${cap}`);
  ok(allAir === 0, `${name}: never has all six feet off the ground`, `${allAir} frames`);
  ok(worstOffDome < 1e-12, `${name}: planted feet stay exactly on the dome`, worstOffDome.toExponential(3));
  ok(sank === 0, `${name}: the body never sinks through the leaf`, `${sank} frames, min ${minClear.toFixed(4)}`);
  ok(nonFinite === 0, `${name}: nothing goes non-finite`, `${nonFinite}`);
  ok(worstStretch < 1e-9, `${name}: FABRIK does not stretch the bones`, worstStretch.toExponential(3));
}

// ============================================================ 5. it stays on the leaf it is given
section('5. it stays on the leaf, at any radius');

for (const R of [1.1, 2.4, 5.0]) {
  const r = createBugRig({ THREE, rng: seeded(31), sproutR: R });
  r.reset();
  near(r.worstFootError(), 0, 0, `R=${R}: parks on the dome`);
  let maxOut = 0, offDome = 0;
  for (let i = 0; i < 1500; i++) {
    r.update(1 / 60, { walk: true });
    maxOut = Math.max(maxOut, Math.hypot(r.body.pos.x, r.body.pos.z));
    offDome = Math.max(offDome, r.worstFootError());
  }
  // The dome is only a height function on its upper hemisphere, so the bug has to stay well inside it.
  ok(maxOut < R * 0.9, `R=${R}: never wanders past the leaf's shoulder`,
    `${maxOut.toFixed(3)} vs ${(R * 0.9).toFixed(3)}`);
  ok(offDome < 1e-12, `R=${R}: feet stay on the surface`, offDome.toExponential(3));
  console.log(`   R=${R}: roamed to ${maxOut.toFixed(3)} (roamRadius ${r.state.roamRadius.toFixed(3)})`);
}
{
  // Changing the radius must re-solve the feet, not leave them on the old surface.
  const r = rig();
  r.reset();
  r.setSproutR(4.0);
  r.reset();
  near(r.worstFootError(), 0, 0, 'setSproutR re-solves the feet onto the new dome');
  const g = domeGround(4.0);
  near(r.legs[0].end.y, g(r.legs[0].end.x, r.legs[0].end.z) + r.footClearance, 1e-15,
    'against the new radius specifically');
}

// ============================================================ 6. the shader's bounding sphere holds
section('6. the bounding sphere the shader marches inside contains the bug');

{
  // Reproduces sdf-bug-v2.html's pushPose. If this is ever wrong the bug gets clipped, and a clipped
  // limb looks like a modelling bug rather than a bounds bug, which is why it is worth asserting.
  const BODY_EXTENT = 0.68;
  const r = rig();
  r.reset();
  let worstSlack = Infinity, checks = 0;
  const buf = [];
  for (let i = 0; i < 1200; i++) {
    r.update(1 / 60, { walk: true });
    r.joints(buf);
    let far = BODY_EXTENT;
    for (let j = 0; j < buf.length / 3; j++) {
      const d = Math.hypot(buf[j * 3] - r.body.pos.x, buf[j * 3 + 1] - r.body.pos.y, buf[j * 3 + 2] - r.body.pos.z);
      far = Math.max(far, d + 0.02);
    }
    // Every joint, plus its own capsule radius, must be inside.
    for (const leg of r.legs) {
      for (let k = 0; k < leg.chain.points.length; k++) {
        const p = leg.chain.points[k];
        const rad = leg.r[Math.min(k, leg.r.length - 1)];
        const slack = far - (p.distanceTo(r.body.pos) + rad);
        worstSlack = Math.min(worstSlack, slack);
        checks++;
      }
    }
  }
  ok(worstSlack >= 0, 'no joint ever falls outside the bounding sphere',
    `tightest slack ${worstSlack.toExponential(3)} over ${checks} checks`);
  console.log(`   ${checks} joint/frame checks, tightest slack ${(worstSlack * 1000).toFixed(2)} mm`);
}

// ============================================================ 7. the frame rate does not change the gait
section('7. the gait does not depend on the frame rate');

{
  const distanceAt = (dt, steps) => {
    const r = createBugRig({ THREE, rng: seeded(5) });
    r.reset();
    let odo = 0;
    const prev = r.body.pos.clone();
    for (let i = 0; i < steps; i++) {
      r.update(dt, { walk: true });
      odo += Math.hypot(r.body.pos.x - prev.x, r.body.pos.z - prev.z);
      prev.copy(r.body.pos);
    }
    return odo;
  };
  const at60 = distanceAt(1 / 60, 1200);       // 20s
  const at120 = distanceAt(1 / 120, 2400);     // 20s
  const at30 = distanceAt(1 / 30, 600);        // 20s
  console.log(`   20s of walking: ${at60.toFixed(2)} at 60fps, ${at120.toFixed(2)} at 120, ${at30.toFixed(2)} at 30`);
  // The accumulator makes these agree to within one substep's worth of travel, not exactly: a 120fps
  // caller runs a substep every other frame, so the sampling of `walk` and the wander target differs.
  const spread = Math.max(at60, at120, at30) - Math.min(at60, at120, at30);
  ok(spread / at60 < 0.15, 'distance travelled is within 15% across frame rates',
    `spread ${spread.toFixed(3)} on ${at60.toFixed(3)}`);
  ok(at30 > 0.5 && at120 > 0.5, 'and it walks at every frame rate');
}
{
  // A long stall must not be caught up by simulating it all at once.
  const r = rig();
  r.reset();
  const res = r.update(5.0, { walk: true });
  ok(res.steps <= 5, 'a 5-second hitch is capped at MAX_SUBSTEPS', `${res.steps} substeps`);
  ok(Number.isFinite(r.body.pos.x) && r.worstFootError() < 1e-9,
    'and leaves the rig in a sane state');
}

// ============================================================ 8. parked means parked
section('8. parked means parked');

{
  const r = rig();
  r.reset();
  const before = r.legs.map(l => l.end.clone());
  for (let i = 0; i < 600; i++) r.update(1 / 60, { walk: false });
  let moved = 0;
  for (let i = 0; i < before.length; i++) moved = Math.max(moved, before[i].distanceTo(r.legs[i].end));
  ok(moved < 1e-9, 'with walk off, no foot moves', moved.toExponential(3));
  ok(r.legs.every(l => !l.stepping), 'and no leg is mid-step');
  const speed = Math.hypot(r.body.vel.x, r.body.vel.z);
  ok(speed < 0.02, 'and the body is not drifting', `speed ${speed.toExponential(2)}`);
}
ok((() => { try { createBugRig({}); return false; } catch { return true; } })(),
  'createBugRig rejects a missing THREE');

// ============================================================ 9. the drawn foot is the foot
section('9. the DRAWN foot, not just the target');

// This section exists because section 4 passed while the demo had a visible bug. It asserts planted feet
// are exactly on the dome — and it checks `leg.end`, the TARGET. What gets drawn is the last point of the
// FABRIK chain, and when a target is out of the leg's reach the solver straightens instead of reaching, so
// the two diverge and the visible foot leaves the leaf. Measured before the fix: some planted foot was out
// of reach 15% of the time, median 138 mm on a 548 mm leg, worst 1118 mm, for up to 1.28 s at a stretch.
//
// The cause was an omission, not a subtlety: `physicsStep` stops steering while any planted foot is
// overextended, and the first version of the rig did not port that. Turning is what strands a pinned foot,
// because the body rotates away from it while the scheduler is still refusing to let it step.
{
  const r = rig();
  r.reset();
  const span = r.legs[0].chain.lengths.reduce((a, b) => a + b, 0);
  const shortfalls = [];
  let planted = 0, worstTipMiss = 0, worstRun = 0;
  const run = new Map();
  for (let i = 0; i < 3600; i++) {
    r.update(1 / 60, { walk: true });
    for (const leg of r.legs) {
      if (leg.stepping) { run.set(leg, 0); continue; }
      planted++;
      const legSpan = leg.chain.lengths.reduce((a, b) => a + b, 0);
      const need = leg.hipWorld.distanceTo(leg.end);
      const tip = leg.chain.points[leg.chain.points.length - 1];
      worstTipMiss = Math.max(worstTipMiss, tip.distanceTo(leg.end));
      if (need > legSpan) {
        shortfalls.push(need - legSpan);
        run.set(leg, (run.get(leg) || 0) + 1);
        worstRun = Math.max(worstRun, run.get(leg));
      } else {
        run.set(leg, 0);
      }
    }
  }
  shortfalls.sort((a, b) => a - b);
  const frac = shortfalls.length / planted;
  const median = shortfalls.length ? shortfalls[Math.floor(shortfalls.length / 2)] : 0;
  const worstShort = shortfalls.length ? shortfalls[shortfalls.length - 1] : 0;
  console.log(`   60s: planted feet out of reach ${(frac * 100).toFixed(2)}%, `
    + `median ${(median * 1000).toFixed(1)}mm and worst ${(worstShort * 1000).toFixed(1)}mm `
    + `on a ${(span * 1000).toFixed(0)}mm leg, longest run ${worstRun} frames`);
  console.log(`   worst gap between the drawn foot and its target: ${(worstTipMiss * 1000).toFixed(1)}mm`);

  // BOUNDS, NOT A CLAIM OF ZERO. Some overextension is inherent to a reactive gait on a curved surface.
  //
  // The bounds come from a spread of twelve seeds, not from one run. A first version was tuned to a single
  // seed at 5.09%/107mm and two other seeds would have failed it — a flaky test asserting nothing.
  // Across those seeds: fraction 2.8-9.3%, median 12.7-20.4mm, worst 64-143mm, longest run 22-33 frames.
  //
  // THE MEDIAN IS THE ASSERTION THAT MATTERS. It is by far the most stable statistic and it moved most:
  // 137.7mm before the fix against 12.7-20.4mm after, so a bound at 45mm has real headroom in both
  // directions. The FRACTION is the weakest signal — 9.3% after the fix against 14.7% before is barely a
  // separation, so it is bounded loosely and nothing is inferred from it.
  ok(median < 0.045, 'a foot out of reach is out of reach only slightly',
    `median ${(median * 1000).toFixed(1)}mm (pre-fix 137.7mm)`);
  ok(worstShort < 0.22, 'and never by half a leg', `${(worstShort * 1000).toFixed(1)}mm (pre-fix 1118mm)`);
  ok(worstRun < 50, 'and never for anything like a second', `${worstRun} frames (pre-fix 77)`);
  ok(frac < 0.13, 'planted feet are usually within reach', `${(frac * 100).toFixed(2)}%`);
  ok(worstTipMiss < 0.22, 'so the drawn foot stays near its target', `${(worstTipMiss * 1000).toFixed(1)}mm`);

  // The guard itself, asserted directly: with a foot pinned uncomfortably, the body must not turn.
  const r2 = rig();
  r2.reset();
  for (const leg of r2.legs) leg.uncomfortable = true;
  const yaw0 = r2.body.yaw;
  r2.body.desiredDir.set(1, 0, 0);           // demand a 90-degree turn
  r2.update(1 / 60, { walk: false });
  near(r2.body.yaw, yaw0, 1e-12, 'a pinned uncomfortable foot stops the body turning');
}

// ============================================================ 11. joint limits
section('11. the legs bend like legs');

// THE DEFECT THIS SECTION EXISTS FOR, stated as the measurement that found it: with the old FABRIK solve
// the knee sat BELOW the hip-to-foot chord for 63% of a 60 s walk — 84% on the front legs — with the femur
// pointing down at a median -28 degrees where the drawn pose has it up at +24. Every one of those poses
// satisfies the two constraints FABRIK solves for, so no amount of iterating would have found it. Only a
// measurement of WHICH solution came back would, and that is what this is.
{
  const deg = (r) => r * 180 / Math.PI;
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };

  // The parked pose first: the limits must not disturb it, or v1 parity is gone.
  {
    const r = rig();
    r.reset();
    const rest = r.legPose();
    ok(rest.every(p => !p.inverted), 'no knee is inverted at the authored pose');
    ok(rest.every(p => Math.abs(p.swing) < 1e-12), 'and no leg is swung away from its authored direction');
    const worstReach = Math.max(...rest.map(p => p.reach));
    ok(worstReach < BUG_LEG_LIMITS.reach, 'the drawn stance is comfortably inside the reach limit',
      `${worstReach.toFixed(3)} of span vs ${BUG_LEG_LIMITS.reach}`);
    ok(rest.every(p => p.shortfall < 1e-9), 'and every foot reaches its target exactly');
  }

  // Then the walk, at three curvatures, because the dome's steepness is what strands a foot.
  for (const sproutR of [1.4, 2.4, 4.5]) {
    const r = createBugRig({ THREE, sproutR, rng: seeded(4242) });
    r.reset();
    let inverted = 0, samples = 0;
    const shortfalls = [], swings = [];
    for (let i = 0; i < 3600; i++) {
      r.update(1 / 60, { walk: true });
      if (i < 60) continue;
      for (const p of r.legPose()) {
        samples++;
        if (p.inverted) inverted++;
        if (!p.stepping) { shortfalls.push(p.shortfall * 1000); swings.push(Math.abs(deg(p.swing))); }
      }
    }
    const radial = Math.hypot(r.body.pos.x, r.body.pos.z);
    console.log(`   R=${sproutR}: inverted ${(100 * inverted / samples).toFixed(2)}% of ${samples}, `
      + `foot short p95 ${q(shortfalls, 0.95).toFixed(0)}mm, swing p95 ${q(swings, 0.95).toFixed(0)}deg, `
      + `body ${radial.toFixed(2)} from centre`);
    ok(inverted === 0, `R=${sproutR}: the knee never inverts over 60 s`, `${inverted}/${samples}`);
    ok(q(shortfalls, 0.95) < 40, `R=${sproutR}: the drawn foot stays near its target`,
      `p95 ${q(shortfalls, 0.95).toFixed(1)}mm`);
    // A CONTAINMENT CHECK, not a nicety. Three of the five things tried while fixing this walked the bug
    // off the leaf, and each time the joint numbers looked plausible right up to the moment it left: a
    // falling bug reports swing of 180 degrees and a foot two metres from its target. Anything measured
    // past the equator is measured on a bug in free fall, so this has to be asserted alongside.
    ok(radial < sproutR, `R=${sproutR}: and the bug is still on the leaf`, radial.toFixed(2));
  }

  // The old behaviour must be one setting away, or the panel's comparison is a lie — and the assertion
  // that it is WORSE is what proves the limits are doing something.
  {
    // BOTH have to go back, and finding that out was the point of writing this check. Relaxing the limits
    // alone left the inversion rate at zero, because the pole — not the bound — is what fixes the knee. The
    // page's toggle had to be corrected to switch the solver too, or it was offering a false comparison.
    const r = createBugRig({
      THREE, sproutR: 2.4, rng: seeded(4242),
      legSolver: 'fabrik', limits: { swing: null, reach: 0.999 },
    });
    r.reset();
    let inverted = 0, samples = 0, straight = 0;
    for (let i = 0; i < 1800; i++) {
      r.update(1 / 60, { walk: true });
      if (i < 60) continue;
      for (const p of r.legPose()) { samples++; if (p.inverted) inverted++; }
      for (const leg of r.legs) {
        if (leg.stepping) continue;
        const f = leg.chain.points[1].clone().sub(leg.chain.points[0]);
        const t = leg.chain.points[2].clone().sub(leg.chain.points[1]);
        if (180 - deg(f.angleTo(t)) > 172) straight++;
      }
    }
    const rate = 100 * inverted / samples;
    console.log(`   limits off: inverted ${rate.toFixed(1)}%, near-straight legs ${straight} samples`);
    ok(rate > 20, 'with the limits off the knee inverts on a large fraction of samples',
      `${rate.toFixed(1)}%`);
    ok(straight > 0, 'and legs snap straight, which the reach limit is what prevents', `${straight}`);
  }

  // The scale fix in the shared scheduler. 0.1 m was a literal there; on this bug it is wider than a
  // whole stride, so it forbade the step and the leg stayed stranded.
  {
    ok(BUG_GAIT.restepEpsilon != null, 'the bug sets its own re-step epsilon');
    const span = rig().legs[0].span;
    ok(BUG_GAIT.restepEpsilon < span * 0.1, 'and it is small relative to the leg',
      `${BUG_GAIT.restepEpsilon} on a ${span.toFixed(3)} leg`);
    ok(0.1 > span * 0.15, "while the shared default is a sixth of this leg's whole span",
      `0.1 m vs span ${span.toFixed(3)} m = ${(100 * 0.1 / span).toFixed(0)}%`);
  }
}

// ============================================================ summary
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
