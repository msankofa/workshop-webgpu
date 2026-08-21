// creature-locomotion.js — the walk cycle extracted from port-creature-system.js.
//
// Two kinds of check here. Most of it exercises the module directly. The last section boots the REAL
// sim in Node behind a stub DOM and walks it, because the extraction is only worth anything if the sim
// still uses it — a module that passes its own unit tests while the sim quietly keeps a private copy
// would look exactly the same from here.
//
// The sections that matter most for demos/sdf-bug-v2 are 3 (the ground function is a parameter, and a
// sphere works) and 8 (the scale mismatch, recorded as numbers rather than as a warning).
import * as THREE from 'three';
import {
  LOCOMOTION, GAITS, cloneGait,
  easeInOut, lerp, clamp, horizontalDistance,
  convexHull, pointInPoly, nearestOnPoly,
  isGrounded, legDisplacement, legBy, adjacentPartners, diagonalPartners, cacheLegPartners,
  canWalkLegMove, canGallopLegMove, startStep, scheduleSteps, advanceLeg,
  bodySupport, orientFromFeet,
  createCreatureLocomotion,
} from './creature-locomotion.js';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(`${label}${detail ? ' — ' + detail : ''}`);
  return false;
}
const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, label, `${a} vs ${b} (tol ${tol})`);
function section(title) { console.log(`\n${title}`); }

const loco = createCreatureLocomotion({ THREE });
const { KinematicChain, rotateXZ, averageVec, orientFromUpForward, createLegSolver } = loco;

// A leg record shaped like the sim's, so the module is tested against the real contract.
function makeLeg({ index = 0, row = 0, side = 1, restLocal = [0.8, 0, 0.6] } = {}) {
  return {
    index, row, side,
    restLocal: new THREE.Vector3(...restLocal),
    end: new THREE.Vector3(), target: new THREE.Vector3(),
    stepStart: new THREE.Vector3(), stepEnd: new THREE.Vector3(),
    groundPosition: new THREE.Vector3(), lookAhead: new THREE.Vector3(),
    scanStart: new THREE.Vector3(), scanEnd: new THREE.Vector3(),
    targetGrounded: true, stepping: false, t: 0,
    timeSinceBeginMove: 999, timeSinceStopMove: 999,
    canMove: false, primary: false, wants: false, uncomfortable: false,
    restX: 0, restY: 0, restZ: 0,
  };
}

// n pairs, front row first, laid out like finalizePlan's output.
function makeLegs(pairs, spread = 0.8, depth = 0.6) {
  const legs = [];
  for (let r = 0; r < pairs; r++) {
    const z = depth - r * (depth * 2 / Math.max(1, pairs - 1 || 1));
    for (const side of [-1, 1]) {
      legs.push(makeLeg({ index: legs.length, row: r, side, restLocal: [spread * side, 0, z] }));
    }
  }
  return cacheLegPartners(legs);
}

const body = (x = 0, y = 1, z = 0, yaw = 0) => ({
  pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), yaw,
  pitch: 0, roll: 0, preferredPitch: 0, preferredRoll: 0,
});

// ============================================================ 1. tuning tables
section('1. gait tables');

ok(GAITS.walk && GAITS.gallop, 'both gaits exist');
ok(GAITS.gallop.rowPairSteps === true && GAITS.walk.rowPairSteps === false,
  'rowPairSteps is what separates the two schedulers');
ok(GAITS.gallop.maxSpeed > GAITS.walk.maxSpeed, 'gallop is faster');
ok(GAITS.gallop.maxConcurrentFraction > GAITS.walk.maxConcurrentFraction,
  'gallop allows more feet off the ground');

const c1 = cloneGait(GAITS.walk);
c1.comfort.h = 999; c1.movingTrigger.h = 999; c1.stationaryTrigger.v = 999;
ok(GAITS.walk.comfort.h !== 999 && GAITS.walk.movingTrigger.h !== 999
  && GAITS.walk.stationaryTrigger.v !== 999,
  'cloneGait deep-copies the nested trigger/comfort objects',
  'a shallow clone lets a UI slider corrupt the stock gait');

for (const k of ['FOOT_GROUND', 'GRAV', 'KP', 'KD', 'H_DRAG', 'BOUNCE', 'BODY_MIN_CLEAR']) {
  ok(Number.isFinite(LOCOMOTION[k]), `LOCOMOTION.${k} is a number`);
}
near(easeInOut(0), 0, 0, 'easeInOut(0) = 0');
near(easeInOut(1), 1, 0, 'easeInOut(1) = 1');
near(easeInOut(0.5), 0.5, 1e-12, 'easeInOut(0.5) = 0.5');
ok(easeInOut(0.26) < 0.26 && easeInOut(0.74) > 0.74, 'easeInOut eases in and out');
near(clamp(5, 0, 1), 1, 0, 'clamp high');
near(clamp(-5, 0, 1), 0, 0, 'clamp low');
near(lerp(2, 4, 0.25), 2.5, 1e-12, 'lerp');
near(horizontalDistance({ x: 3, y: 99, z: 4 }, { x: 0, y: -99, z: 0 }), 5, 1e-12,
  'horizontalDistance ignores y');

// ============================================================ 2. FABRIK
section('2. FABRIK keeps the bones the length they were');

const segs = (lengths) => lengths.map((length, i) => ({
  length, initDirection: new THREE.Vector3(0.4, -1, 0.2 + i * 0.1).normalize(),
}));
const q = new THREE.Quaternion();

function segmentLengthError(chain) {
  let worst = 0;
  for (let i = 0; i < chain.lengths.length; i++) {
    const d = chain.points[i].distanceTo(chain.points[i + 1]);
    worst = Math.max(worst, Math.abs(d - chain.lengths[i]));
  }
  return worst;
}

{
  const lengths = [0.58, 0.48, 0.32];
  let worstSeg = 0, worstTip = 0, unreachableStraight = 0, cases = 0;
  const root = new THREE.Vector3(0, 1.2, 0);
  for (let i = 0; i <= 12; i++) {
    for (let j = 0; j <= 12; j++) {
      const chain = new KinematicChain(segs(lengths));
      const a = (i / 12) * Math.PI * 2;
      const reach = (j / 12) * 2.4;                 // total length is 1.38, so half of these are out of reach
      const target = new THREE.Vector3(root.x + Math.cos(a) * reach, root.y - 0.9, root.z + Math.sin(a) * reach);
      chain.solve(root, target, q);
      cases++;
      worstSeg = Math.max(worstSeg, segmentLengthError(chain));
      const tip = chain.points[chain.points.length - 1];
      const dist = root.distanceTo(target);
      if (dist < chain.totalLength - 1e-3) {
        worstTip = Math.max(worstTip, tip.distanceTo(target));
      } else {
        // Out of reach: the chain should be straight along root -> target.
        const dir = target.clone().sub(root).normalize();
        const want = root.clone().addScaledVector(dir, chain.totalLength);
        unreachableStraight = Math.max(unreachableStraight, tip.distanceTo(want));
      }
      ok(chain.points[0].distanceTo(root) < 1e-12, 'root stays put');
    }
  }
  console.log(`   ${cases} solves, worst segment-length error ${worstSeg.toExponential(2)}`);
  ok(worstSeg < 1e-9, 'segment lengths preserved everywhere', worstSeg.toExponential(3));
  ok(worstTip < 0.02, 'reachable targets are reached', `worst miss ${worstTip.toExponential(3)}`);
  ok(unreachableStraight < 1e-9, 'unreachable targets straighten the chain',
    unreachableStraight.toExponential(3));
  console.log(`   reachable tip error ${worstTip.toExponential(2)}, `
    + `unreachable straightness ${unreachableStraight.toExponential(2)}`);
}
{
  // Degenerate: target on the root. Must not produce NaN.
  const chain = new KinematicChain(segs([0.5, 0.4]));
  const root = new THREE.Vector3(1, 1, 1);
  chain.solve(root, root.clone(), q);
  const finite = chain.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  ok(finite, 'target coincident with root stays finite');
  ok(segmentLengthError(chain) < 1e-9, 'and still keeps segment lengths');
}
{
  // FABRIK is iterative and stops at `tolerance`, so re-solving the same target does NOT reproduce the
  // same points - it resumes from them and converges further. The invariant is monotone improvement.
  const chain = new KinematicChain(segs([0.5, 0.4]));
  const root = new THREE.Vector3();
  const target = new THREE.Vector3(0.3, -0.5, 0);
  const errors = [];
  for (let i = 0; i < 8; i++) {
    chain.solve(root, target, q);
    errors.push(chain.points[chain.points.length - 1].distanceTo(target));
  }
  let regressions = 0;
  for (let i = 1; i < errors.length; i++) if (errors[i] > errors[i - 1] + 1e-12) regressions++;
  ok(regressions === 0, 'repeated solves never get worse', regressions + ' regressions');
  ok(errors[errors.length - 1] <= errors[0], 'and end at least as close');
  ok(segmentLengthError(chain) < 1e-9, 'with segment lengths still intact');
  console.log(`   re-solve tip error ${errors[0].toExponential(2)} -> ${errors[errors.length - 1].toExponential(2)}`);
}

// ============================================================ 3. the ground function is a parameter
section('3. the foot scan works on any height function');

{
  const flatY = 2.5;
  const solver = createLegSolver({ terrainHeight: () => flatY, footGround: LOCOMOTION.FOOT_GROUND });
  const leg = makeLeg();
  const b = body(0, flatY + 1, 0, 0);
  const rest = solver.solveLegTarget(leg, GAITS.walk, 0.3, true, b);
  near(leg.target.y, flatY + LOCOMOTION.FOOT_GROUND, 1e-12, 'flat ground: foot sits footGround above it');
  near(rest.y, flatY + LOCOMOTION.FOOT_GROUND, 1e-12, 'rest point too');
  ok(leg.targetGrounded, 'flat ground is always reachable');
}
{
  // footGround is honoured — the reason it had to stop being the constant 0.06.
  const tiny = 0.004;
  const solver = createLegSolver({ terrainHeight: () => 0, footGround: tiny });
  const leg = makeLeg();
  solver.solveLegTarget(leg, GAITS.walk, 0.3, true, body(0, 1, 0, 0));
  near(leg.target.y, tiny, 1e-12, 'a bug-sized footGround is used, not the creature default');
  ok(Math.abs(leg.target.y - LOCOMOTION.FOOT_GROUND) > 0.05,
    'and it is nowhere near the creature default', `${leg.target.y} vs ${LOCOMOTION.FOOT_GROUND}`);
}
{
  // The sdf-bug case: standing on a sphere. groundY(x,z) = sqrt(R^2 - x^2 - z^2) - R.
  const R = 3.2;
  const sphereGround = (x, z) => Math.sqrt(Math.max(R * R - x * x - z * z, 0)) - R;
  const solver = createLegSolver({ terrainHeight: sphereGround, footGround: 0.006 });
  const legs = makeLegs(3, 0.5, 0.4);
  const b = body(0, 0.4, 0, 0.6);
  let worstOffSphere = 0, grounded = 0;
  for (const leg of legs) {
    solver.solveLegTarget(leg, GAITS.walk, 0.25, true, b);
    if (!leg.targetGrounded) continue;
    grounded++;
    // The foot's own (x, z) must put it on the sphere, minus the clearance.
    const want = sphereGround(leg.target.x, leg.target.z) + 0.006;
    worstOffSphere = Math.max(worstOffSphere, Math.abs(leg.target.y - want));
  }
  ok(grounded === legs.length, 'every foot finds the dome', `${grounded}/${legs.length}`);
  ok(worstOffSphere < 1e-12, 'and lands exactly on it', worstOffSphere.toExponential(3));
  console.log(`   sphere ground: ${grounded}/${legs.length} feet placed, `
    + `worst deviation ${worstOffSphere.toExponential(2)}`);
}
{
  // Reaching out over a chasm: every scanned cell falls below the scan slab, so nothing qualifies.
  //
  // Getting here needs the look-ahead pushed clear of the rest point. A first attempt used a terrain
  // that ignored z, which put the grid's centre column at exactly the rest height where it always
  // qualified - the scan never failed and the assertion passed for the wrong reason.
  const chasm = (x, z) => (z > 1 ? -50 : 0);
  const solver = createLegSolver({ terrainHeight: chasm, footGround: 0.06 });
  const leg = makeLeg();
  const triggerH = 5;   // look-ahead = triggerH * gait.lookAhead * 3 = 3.0, well past the rest point
  solver.solveLegTarget(leg, GAITS.walk, triggerH, true, body(0, 0, 0, 0));
  ok(leg.lookAhead.z > 1, 'the look-ahead really is out over the chasm', 'z = ' + leg.lookAhead.z);
  ok(leg.scanEnd.y > -50, 'and the chasm floor is below the scan slab', 'slab bottom ' + leg.scanEnd.y);
  ok(!leg.targetGrounded, 'unreachable ground reports targetGrounded false');
  near(leg.target.y, leg.restY, 1e-12, 'and the target falls back to the rest height');
}
{
  // The look-ahead leads in the direction of travel, which is what makes a step land ahead of the foot.
  const solver = createLegSolver({ terrainHeight: () => 0, footGround: 0.06 });
  // The property is that the look-ahead LEADS the rest point along the direction of travel. Comparing
  // "+z travel" against "standing still facing +z" would compare two identical cases, because a still
  // body falls back to its facing for the direction - which is how the first version of this passed
  // while asserting 0.9 > 0.9.
  let worstAlignment = 1;
  for (const [vx, vz] of [[0, 3], [0, -3], [3, 0], [-3, 0], [2, 2], [-1.5, 2.5]]) {
    const leg = makeLeg();
    const b = body(0, 1, 0, 0); b.vel.set(vx, 0, vz);
    solver.solveLegTarget(leg, GAITS.walk, 0.5, true, b);
    const lx = leg.lookAhead.x - leg.restX, lz = leg.lookAhead.z - leg.restZ;
    const len = Math.hypot(lx, lz) || 1e-9;
    const alignment = (lx * vx + lz * vz) / (len * Math.hypot(vx, vz));
    worstAlignment = Math.min(worstAlignment, alignment);
  }
  near(worstAlignment, 1, 1e-9, 'the look-ahead leads along the direction of travel',
    'worst alignment ' + worstAlignment);

  // A still body leads along its FACING instead.
  const legStill = makeLeg();
  solver.solveLegTarget(legStill, GAITS.walk, 0.5, true, body(0, 1, 0, Math.PI / 2));
  ok(legStill.lookAhead.x - legStill.restX > 0.01, 'a still body leads along its facing',
    'lead x = ' + (legStill.lookAhead.x - legStill.restX));
}
{
  // The cheap path skips the grid and takes the look-ahead point directly.
  const solver = createLegSolver({ terrainHeight: (x, z) => Math.sin(x) * 0.4 + Math.cos(z) * 0.3, footGround: 0.06 });
  const leg = makeLeg();
  const b = body(1.3, 1, -0.7, 0.9); b.vel.set(0.5, 0, 0.5);
  solver.solveLegTarget(leg, GAITS.walk, 0.4, false, b);
  near(leg.target.x, leg.lookAhead.x, 1e-12, 'cheap scan: target x is the look-ahead');
  near(leg.target.z, leg.lookAhead.z, 1e-12, 'cheap scan: target z is the look-ahead');
  ok(leg.targetGrounded, 'cheap scan always claims ground');
}
{
  // The scan must never pick a cell outside the comfort envelope.
  const solver = createLegSolver({ terrainHeight: (x, z) => Math.sin(x * 2.2) * 1.4 + Math.cos(z * 1.7) * 1.1, footGround: 0.06 });
  let checked = 0, violations = 0;
  for (let i = 0; i < 60; i++) {
    const leg = makeLeg();
    const b = body(i * 0.37, 1, -i * 0.29, i * 0.21);
    b.vel.set(Math.sin(i) * 2, 0, Math.cos(i) * 2);
    solver.solveLegTarget(leg, GAITS.walk, 0.4, true, b);
    if (!leg.targetGrounded) continue;
    checked++;
    const dh = Math.hypot(leg.target.x - leg.restX, leg.target.z - leg.restZ);
    const dv = Math.abs(leg.target.y - leg.restY);
    if (dh > GAITS.walk.comfort.h + 1e-9 || dv > GAITS.walk.comfort.v + 0.15 + 1e-9) violations++;
  }
  ok(violations === 0, 'a chosen foothold is always inside the comfort envelope',
    `${violations} of ${checked} outside`);
  console.log(`   ${checked} footholds chosen on rough ground, ${violations} outside comfort`);
}

// ============================================================ 4. step scheduling
section('4. scheduling never lifts too many feet at once');

for (const gaitKey of ['walk', 'gallop']) {
  const gait = GAITS[gaitKey];
  for (const pairs of [1, 2, 3, 4, 8]) {
    const legs = makeLegs(pairs);
    const maxConcurrent = Math.max(1, Math.floor(legs.length * gait.maxConcurrentFraction));
    let worstAirborne = 0, everGroundless = 0, movedWithoutWanting = 0;
    // Every leg wants to move, every frame — the worst case for the cap.
    for (let frame = 0; frame < 200; frame++) {
      for (const leg of legs) {
        if (!leg.stepping) {
          leg.wants = true;
          leg.target.set(leg.restLocal.x + 0.9, 0, leg.restLocal.z + 0.9);
        }
        leg.timeSinceBeginMove += 1 / 60;
        leg.timeSinceStopMove += 1 / 60;
      }
      const wanted = legs.map(l => l.wants);
      scheduleSteps(legs, gait);
      for (let i = 0; i < legs.length; i++) {
        if (legs[i].stepping && legs[i].t === 0 && !wanted[i]) movedWithoutWanting++;
      }
      for (const leg of legs) {
        if (leg.stepping) {
          leg.t += (1 / 60) / gait.stepDuration;
          if (leg.t >= 1) { leg.stepping = false; leg.end.copy(leg.target); leg.timeSinceStopMove = 0; }
        }
      }
      const airborne = legs.filter(l => l.stepping).length;
      worstAirborne = Math.max(worstAirborne, airborne);
      if (airborne === legs.length) everGroundless++;
    }
    ok(worstAirborne <= maxConcurrent, `${gaitKey}/${legs.length} legs: never exceeds the cap`,
      `${worstAirborne} > ${maxConcurrent}`);
    ok(movedWithoutWanting === 0, `${gaitKey}/${legs.length} legs: no leg steps unbidden`,
      `${movedWithoutWanting} did`);
    if (legs.length > 2) {
      ok(everGroundless === 0, `${gaitKey}/${legs.length} legs: never all airborne`,
        `${everGroundless} frames`);
    }
  }
}
{
  // A grounded leg that has not asked to move is never scheduled.
  const legs = makeLegs(3);
  for (const leg of legs) { leg.wants = false; leg.targetGrounded = true; }
  scheduleSteps(legs, GAITS.walk);
  ok(legs.every(l => !l.stepping), 'nothing steps when nothing wants to');
}
{
  // Topology helpers.
  const legs = makeLegs(3);
  const frontLeft = legs.find(l => l.row === 0 && l.side === -1);
  ok(legBy(legs, 0, 1) === legs.find(l => l.row === 0 && l.side === 1), 'legBy finds by row and side');
  ok(legBy(legs, 99, 1) === null, 'legBy returns null for a row that does not exist');
  const adj = adjacentPartners(legs, frontLeft);
  ok(adj.includes(legBy(legs, 0, 1)), 'adjacent includes the same-row mate');
  ok(adj.includes(legBy(legs, 1, -1)), 'adjacent includes the next row, same side');
  ok(!adj.includes(legBy(legs, 2, -1)), 'adjacent excludes two rows away');
  const diag = diagonalPartners(legs, frontLeft);
  ok(diag.every(l => l.side === -frontLeft.side), 'diagonals are all on the other side');
  ok(diag.every(l => Math.abs(l.row - frontLeft.row) === 1), 'and one row away');
  ok(diagonalPartners(makeLegs(1), makeLegs(1)[0]).length === 0, 'a single row has no diagonals');
  ok(legs.every(l => l.adjacentPartnersCached && l.diagonalPartnersCached && l.crossRowsCached),
    'cacheLegPartners fills every cache');
  const uncached = makeLeg();
  ok(!isGrounded({ ...uncached, stepping: true, targetGrounded: true }), 'a stepping leg is not grounded');
  ok(!isGrounded({ ...uncached, stepping: false, targetGrounded: false }), 'nor one with no ground');
  ok(isGrounded({ ...uncached, stepping: false, targetGrounded: true }), 'a planted leg is grounded');
  const l2 = makeLeg(); l2.end.set(0, 5, 0); l2.target.set(3, -99, 4);
  near(legDisplacement(l2), 5, 1e-12, 'legDisplacement is horizontal only');
}

// ============================================================ 5. the step arc
section('5. the step arc lifts, then lands exactly on target');

{
  const gait = GAITS.walk;
  const leg = makeLeg();
  leg.end.set(0, 0, 0);
  leg.target.set(0.6, 0, 0.4);
  leg.wants = true;
  startStep(leg);
  ok(leg.stepping && leg.t === 0, 'startStep arms the leg');
  ok(leg.stepStart.distanceTo(new THREE.Vector3(0, 0, 0)) < 1e-12, 'from where the foot was');
  ok(leg.stepEnd.distanceTo(leg.target) < 1e-12, 'to where the target is');

  let footfalls = 0, peakLift = 0, frames = 0;
  const h = 1 / 240;
  const rest = new THREE.Vector3(0, 0, 0);
  while (leg.stepping && frames < 10000) {
    advanceLeg(leg, gait, h, 0.3, 0.3, rest, () => footfalls++);
    frames++;
    const groundLine = leg.stepStart.clone().lerp(leg.stepEnd, Math.min(leg.t, 1));
    peakLift = Math.max(peakLift, leg.end.y - groundLine.y);
  }
  ok(footfalls === 1, 'onFootfall fires exactly once per step', `${footfalls} times`);
  ok(leg.end.distanceTo(leg.target) < 1e-12, 'the foot lands exactly on the target',
    leg.end.distanceTo(leg.target).toExponential(3));
  near(peakLift, gait.stepLift, gait.stepLift * 0.02, 'the arc peaks at stepLift');
  ok(!leg.wants, 'a landed foot no longer wants to move');
  near(leg.timeSinceStopMove, 0, 1e-12, 'and its stop clock resets');
  console.log(`   step took ${frames} sub-steps, peak lift ${peakLift.toFixed(4)} `
    + `(stepLift ${gait.stepLift})`);
}
{
  // A planted foot dragged past the trigger asks to move; inside it, it does not.
  const leg = makeLeg();
  const rest = new THREE.Vector3(0, 0, 0);
  leg.end.set(0, 0, 0); leg.target.set(0.1, 0, 0);
  advanceLeg(leg, GAITS.walk, 1 / 60, 0.3, 0.3, rest);
  ok(!leg.wants, 'a foot close to its target does not ask to move');
  leg.target.set(0.9, 0, 0);
  advanceLeg(leg, GAITS.walk, 1 / 60, 0.3, 0.3, rest);
  ok(leg.wants, 'a foot dragged past triggerH does');
  leg.target.set(0, 0.9, 0);
  advanceLeg(leg, GAITS.walk, 1 / 60, 0.3, 0.3, rest);
  ok(leg.wants, 'and so does one dragged past triggerV');

  const leg2 = makeLeg();
  leg2.end.set(0, 0, 0); leg2.target.set(0.05, 0, 0); leg2.targetGrounded = false;
  advanceLeg(leg2, GAITS.walk, 1 / 60, 0.3, 0.3, rest);
  ok(leg2.wants, 'a foot with no ground under it always wants to move');
}
{
  // Overextension is measured against BOTH the target and the rest point.
  const leg = makeLeg();
  leg.end.set(0, 0, 0); leg.target.set(0.05, 0, 0);
  advanceLeg(leg, GAITS.walk, 1 / 60, 0.3, 0.3, new THREE.Vector3(0, 0, 0));
  ok(!leg.uncomfortable, 'a foot near both target and rest is comfortable');
  advanceLeg(leg, GAITS.walk, 1 / 60, 0.3, 0.3, new THREE.Vector3(GAITS.walk.comfort.h + 0.5, 0, 0));
  ok(leg.uncomfortable, 'a foot far from its REST point is uncomfortable even if its target is close');
}

// ============================================================ 6. support polygon
section('6. the body is held up from the right place');

{
  const legs = makeLegs(2, 1.0, 1.0);   // a square of four feet around the origin
  for (const leg of legs) {
    leg.end.set(leg.restLocal.x, 0, leg.restLocal.z);
    leg.targetGrounded = true; leg.stepping = false;
  }
  const s = bodySupport(legs, new THREE.Vector3(0, 1, 0));
  ok(s.haveNormal, 'four feet down gives a normal');
  ok(s.haveSupport, 'and a polygon');
  ok(s.comInside, 'the COM is inside it');
  near(s.ny, 1, 1e-12, 'so the spring pushes straight up');
  near(s.nx, 0, 1e-12, 'with no x lean');
  near(s.nz, 0, 1e-12, 'and no z lean');
  near(s.fG, 1, 1e-12, 'all feet grounded');
  near(s.cy, 0, 1e-12, 'mean foot height is 0');
}
{
  // Shove the body far off the foot square: the normal must lean back toward the polygon.
  const legs = makeLegs(2, 1.0, 1.0);
  for (const leg of legs) { leg.end.set(leg.restLocal.x, 0, leg.restLocal.z); leg.targetGrounded = true; }
  const s = bodySupport(legs, new THREE.Vector3(40, 1, 0));
  ok(!s.comInside, 'a COM way outside the polygon is detected');
  ok(s.nx > 0.5, 'and the normal leans the way the body toppled', `nx = ${s.nx}`);
  near(Math.hypot(s.nx, s.ny, s.nz), 1, 1e-12, 'the normal is a unit vector');
}
{
  const legs = makeLegs(2, 1.0, 1.0);
  for (const leg of legs) { leg.end.set(leg.restLocal.x, 0, leg.restLocal.z); leg.stepping = true; }
  const s = bodySupport(legs, new THREE.Vector3(0, 1, 0));
  ok(!s.haveNormal, 'every foot airborne means no support at all');
  near(s.fG, 0, 1e-12, 'grounded fraction is zero');
}
{
  const legs = makeLegs(2, 1.0, 1.0);
  for (const leg of legs) { leg.end.set(leg.restLocal.x, 0, leg.restLocal.z); leg.targetGrounded = true; }
  for (let i = 1; i < legs.length; i++) legs[i].stepping = true;
  const s = bodySupport(legs, new THREE.Vector3(0.4, 1, 0.4));
  ok(s.haveNormal && !s.haveSupport, 'one foot down: a normal but no polygon');
  ok(s.firstGroundedEnd === legs[0].end, 'and it is the foot that is down');
  near(Math.hypot(s.nx, s.ny, s.nz), 1, 1e-12, 'still a unit normal');
}
{
  // 16 legs is the sim's hard maximum (8 pairs) and exactly fills the pooled buffer.
  const legs = makeLegs(8, 1.0, 1.4);
  ok(legs.length === 16, '8 pairs is 16 legs');
  for (const leg of legs) { leg.end.set(leg.restLocal.x, 0, leg.restLocal.z); leg.targetGrounded = true; }
  const s = bodySupport(legs, new THREE.Vector3(0, 1, 0));
  ok(s.groundedCount === 16, 'all 16 fit in the pooled buffer', `${s.groundedCount}`);
  ok(s.comInside && Number.isFinite(s.ny), 'and the result is sane');
  // Past that the buffer is capped rather than overrunning: not reachable from the sim, but the
  // module is now importable by callers that pick their own leg count.
  const many = makeLegs(12, 1.0, 1.4);
  for (const leg of many) { leg.end.set(leg.restLocal.x, 0, leg.restLocal.z); leg.targetGrounded = true; }
  const s2 = bodySupport(many, new THREE.Vector3(0, 1, 0));
  // `groundedCount` counts LEGS and `contactCount` counts polygon points. They were one number until a
  // leg could offer a contact patch, and it was the buffer size that clamped both — so a 24-legged
  // creature standing on everything reported a grounded fraction of 16/24.
  ok(s2.groundedCount === 24, '24 grounded legs are all counted as legs', `${s2.groundedCount}`);
  ok(s2.fG === 1, 'and the grounded fraction is 1, not 16/24', `${s2.fG}`);
  ok(s2.contactCount <= LOCOMOTION.MAX_CONTACTS, 'the polygon buffer is not overrun', `${s2.contactCount}`);
  ok(Number.isFinite(s2.ny) && Number.isFinite(s2.comX), 'and stays finite');

  // Patches are what can actually fill that buffer: 24 legs at 8 points each is 192 against 160 slots.
  const patched = makeLegs(12, 1.0, 1.4);
  for (const leg of patched) {
    leg.end.set(leg.restLocal.x, 0, leg.restLocal.z);
    leg.targetGrounded = true;
    leg.contacts = Array.from({ length: 8 }, (_, k) => ({
      x: leg.end.x + Math.cos(k) * 0.1, y: 0, z: leg.end.z + Math.sin(k) * 0.1,
    }));
  }
  const s3 = bodySupport(patched, new THREE.Vector3(0, 1, 0));
  ok(s3.contactCount === LOCOMOTION.MAX_CONTACTS, 'contact points clamp to the buffer', `${s3.contactCount}`);
  ok(s3.groundedCount === 24, 'while the leg count is still the leg count', `${s3.groundedCount}`);
  ok(Number.isFinite(s3.ny) && s3.haveSupport, 'and the polygon is still usable');
}
{
  // Hull edge cases.
  const pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }];
  const out = [];
  convexHull(pts, 3, out);
  ok(out.length <= 3, 'collinear points do not blow up the hull', `${out.length}`);
  ok(!pointInPoly(0.5, 0, out) || out.length >= 3, 'a degenerate hull is not treated as an area');
  const sq = [{ x: -1, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 1 }, { x: -1, z: 1 }];
  ok(pointInPoly(0, 0, sq), 'centre is inside the square');
  ok(!pointInPoly(5, 0, sq), 'far outside is outside');
  ok(!pointInPoly(0, 0, [{ x: 0, z: 0 }, { x: 1, z: 0 }]), 'a 2-point poly has no interior');
  const n = nearestOnPoly(5, 0, sq, { x: 0, z: 0 });
  near(n.x, 1, 1e-12, 'nearest point on the square clamps to the edge');
  const two = [];
  convexHull([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }], 2, two);
  ok(two.length === 2, 'fewer than 3 points passes them through');
}

// ============================================================ 7. body orientation
section('7. pitch and roll come from the feet');

{
  const legs = makeLegs(2, 1.0, 1.0);
  for (const leg of legs) leg.end.set(leg.restLocal.x, 0, leg.restLocal.z);
  const b = body();
  const changed = orientFromFeet(legs, GAITS.walk, b);
  ok(changed, 'a full set of feet produces an orientation');
  near(b.pitch, 0, 1e-12, 'level ground is level');
  near(b.roll, 0, 1e-12, 'and unrolled');
}
{
  // Front feet lower than back: the body should pitch consistently and in one direction only.
  const legs = makeLegs(2, 1.0, 1.0);
  for (const leg of legs) leg.end.set(leg.restLocal.x, leg.restLocal.z > 0 ? -0.5 : 0, leg.restLocal.z);
  const b = body();
  for (let i = 0; i < 400; i++) orientFromFeet(legs, GAITS.walk, b);
  ok(Math.abs(b.pitch) > 1e-3, 'a front-down stance pitches the body', `pitch ${b.pitch}`);
  const downhill = b.pitch;

  const legs2 = makeLegs(2, 1.0, 1.0);
  for (const leg of legs2) leg.end.set(leg.restLocal.x, leg.restLocal.z > 0 ? 0 : -0.5, leg.restLocal.z);
  const b2 = body();
  for (let i = 0; i < 400; i++) orientFromFeet(legs2, GAITS.walk, b2);
  ok(Math.sign(b2.pitch) === -Math.sign(downhill), 'and a back-down stance pitches the other way',
    `${b2.pitch} vs ${downhill}`);

  const legs3 = makeLegs(2, 1.0, 1.0);
  for (const leg of legs3) leg.end.set(leg.restLocal.x, leg.side > 0 ? -0.5 : 0, leg.restLocal.z);
  const b3 = body();
  for (let i = 0; i < 400; i++) orientFromFeet(legs3, GAITS.walk, b3);
  ok(Math.abs(b3.roll) > 1e-3, 'a one-side-down stance rolls the body', `roll ${b3.roll}`);
  near(b3.pitch, 0, 1e-6, 'without pitching it');
}
{
  // Clamped by the gait's leeway, however extreme the ground.
  const legs = makeLegs(2, 1.0, 1.0);
  for (const leg of legs) leg.end.set(leg.restLocal.x, leg.restLocal.z > 0 ? -80 : 80, leg.restLocal.z);
  const b = body();
  for (let i = 0; i < 2000; i++) orientFromFeet(legs, GAITS.walk, b);
  ok(Math.abs(b.pitch) <= GAITS.walk.preferredPitchLeeway + 1e-9,
    'pitch is clamped to preferredPitchLeeway', `${b.pitch} vs ${GAITS.walk.preferredPitchLeeway}`);
  ok(Math.abs(b.roll) <= Math.PI / 5 + 1e-9, 'roll is clamped to 36 degrees', `${b.roll}`);
}
{
  // A creature with no front row cannot be oriented, and must be left alone rather than guessed at.
  const legs = makeLegs(1, 1.0, -0.6);   // both feet behind the origin
  for (const leg of legs) leg.end.set(leg.restLocal.x, 0.3, leg.restLocal.z);
  const b = body();
  b.pitch = 0.123; b.roll = -0.456;
  const changed = orientFromFeet(legs, GAITS.walk, b);
  ok(changed === false, 'a creature missing a foot group reports no orientation');
  near(b.pitch, 0.123, 0, 'and its pitch is untouched');
  near(b.roll, -0.456, 0, 'and its roll');
}
{
  // Vector helpers.
  const out = rotateXZ(new THREE.Vector3(1, 7, 0), Math.PI / 2);
  near(out.x, 0, 1e-12, 'rotateXZ 90deg: x -> 0');
  near(out.z, -1, 1e-12, 'rotateXZ 90deg: z -> -1');
  near(out.y, 7, 0, 'rotateXZ leaves y alone');
  const avg = averageVec([new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 4, 6)]);
  near(avg.x, 1, 1e-12, 'averageVec x');
  near(avg.y, 2, 1e-12, 'averageVec y');
  ok(averageVec([]).lengthSq() === 0, 'averageVec of nothing is zero');
  const qq = orientFromUpForward(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Quaternion());
  near(qq.length(), 1, 1e-9, 'orientFromUpForward returns a unit quaternion');
  const degenerate = orientFromUpForward(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0), new THREE.Quaternion());
  ok(Number.isFinite(degenerate.x) && Number.isFinite(degenerate.w),
    'up parallel to forward does not produce NaN');
}
ok((() => { try { createCreatureLocomotion({}); return false; } catch { return true; } })(),
  'createCreatureLocomotion rejects a missing THREE');
ok((() => { try { createLegSolver({}); return false; } catch { return true; } })(),
  'createLegSolver rejects a missing terrainHeight');

// ============================================================ 8. scale, recorded not asserted
section('8. the scale gap between the creatures and demos/sdf-bug');

{
  // From port-creature-system's stock plan and demos/sdf-bug.html's LEGS table.
  const creatureFemur = 0.58;
  const bugFemur = Math.hypot(0.290 - 0.150, 0.255 - 0.170, 0.415 - 0.290);
  const ratio = creatureFemur / bugFemur;
  console.log(`   creature femur ${creatureFemur} vs bug femur ${bugFemur.toFixed(3)} — ${ratio.toFixed(1)}x`);
  console.log(`   default footGround ${LOCOMOTION.FOOT_GROUND} is `
    + `${(LOCOMOTION.FOOT_GROUND / 0.010).toFixed(0)}x the bug's foot radius (0.010)`);
  console.log(`   walk stepLift ${GAITS.walk.stepLift} is `
    + `${(GAITS.walk.stepLift / bugFemur).toFixed(1)}x the bug's whole femur`);
  console.log('   -> geometry scales, but stepDuration/stepLift/maxSpeed and the triggers do not.');
  ok(ratio > 2, 'the mismatch is real and worth a tuning pass, not a silent rescale',
    `${ratio.toFixed(2)}x`);
}

// ============================================================ 9. the sim really uses this module
section('9. the sim still walks, driven by this module');

{
  // Minimal DOM so the sim's panel building can run headless.
  function fakeEl(id = '') {
    const store = { value: '', checked: false, textContent: '', id, disabled: false, selectedIndex: 0 };
    const kids = [], listeners = new Map();
    const self = new Proxy(function () { return fakeEl(); }, {
      get(_t, prop) {
        if (prop in store) return store[prop];
        switch (prop) {
          case 'style': return store.__s ??= {};
          case 'dataset': return store.__d ??= {};
          case 'classList': return store.__c ??= { add() {}, remove() {}, toggle() {}, contains: () => false };
          case 'children': case 'options': case 'childNodes': return kids;
          case 'parentElement': case 'parentNode': return store.__p ??= fakeEl();
          case 'appendChild': case 'append': case 'insertBefore': return (c) => (kids.push(c), c);
          case 'addEventListener': return (t, fn) => {
            if (!listeners.has(t)) listeners.set(t, []);
            listeners.get(t).push(fn);
          };
          case '_fire': return (t) => { for (const fn of listeners.get(t) ?? []) fn({ target: self }); };
          case 'getAttribute': return () => null;
          case 'hasAttribute': case 'contains': return () => false;
          case 'querySelector': case 'closest': return () => fakeEl();
          case 'querySelectorAll': case 'getElementsByTagName': return () => [];
          case 'getBoundingClientRect': return () => ({ x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 });
          case Symbol.toPrimitive: return () => '[el]';
          default: return function () { return fakeEl(); };
        }
      },
      set(_t, prop, v) { store[prop] = v; return true; },
      has() { return true; },
    });
    return self;
  }
  const byId = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, fakeEl(id));
      return byId.get(id);
    },
    createElement: () => fakeEl(), createElementNS: () => fakeEl(), createTextNode: () => fakeEl(),
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    get body() { return fakeEl(); }, get documentElement() { return fakeEl(); },
  };
  globalThis.window ??= globalThis;
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(0), 0);
  globalThis.location ??= { search: '' };

  const terrainHeight = (x, z) => Math.sin(x * 0.3) * 0.6 + Math.cos(z * 0.24) * 0.45;
  document.getElementById('count').value = '3';
  document.getElementById('seed').value = '7';

  const { createPortCreatureSystem } = await import('./port-creature-system.js');
  const sys = createPortCreatureSystem({
    scene: new THREE.Scene(), terrainHeight, terrainSettings: {}, rebuildTerrain() {},
  });
  ok(sys.creatures.length > 0, 'the sim spawns creatures headless', `${sys.creatures.length}`);

  const c = sys.creatures[0];
  ok(c.legs.length > 0, 'with legs');
  // The load-bearing check: the sim's chains must be THIS module's class, not a private copy. It only
  // works because createCreatureLocomotion is memoised per THREE instance - an unmemoised factory mints
  // a fresh class per call, and then this can never pass however correct the wiring is.
  ok(c.legs[0].chain instanceof KinematicChain,
    'the sim\'s IK chains are THIS module\'s KinematicChain',
    'the sim is still using a private copy');
  ok(loco.GAITS === GAITS, 'and its gait table is this module\'s');

  // And the sim no longer carries its own copy of anything that moved.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./port-creature-system.js', import.meta.url), 'utf8');
  ok(src.includes("from './creature-locomotion.js'"), 'the sim imports the module');
  for (const [what, pattern] of [
    ['class KinematicChain', /\bclass KinematicChain\b/],
    ['const GAITS', /\bconst GAITS = \{/],
    ['cloneGait', /\bfunction cloneGait\b/],
    ['convexHull', /\bfunction convexHull\b/],
    ['pointInPoly', /\bfunction pointInPoly\b/],
    ['nearestOnPoly', /\bfunction nearestOnPoly\b/],
    ['easeInOut', /\bfunction easeInOut\b/],
    ['rotateXZ', /\bfunction rotateXZ\b/],
    ['orientFromUpForward', /\bfunction orientFromUpForward\b/],
  ]) {
    ok(!pattern.test(src), `and no longer defines its own ${what}`);
  }

  const start = c.pos.clone();
  let steps = 0, footfalls = 0, worstClearance = Infinity, everStepped = false;
  const prevStepping = new Map();
  for (let i = 0; i < 600; i++) {
    sys.update(1 / 60);
    steps++;
    for (const leg of c.legs) {
      if (leg.stepping) everStepped = true;
      if (prevStepping.get(leg) && !leg.stepping) footfalls++;
      prevStepping.set(leg, leg.stepping);
    }
    const above = c.pos.y - terrainHeight(c.pos.x, c.pos.z);
    worstClearance = Math.min(worstClearance, above);
  }
  ok(everStepped, 'legs take steps over 600 frames');
  ok(footfalls > 0, 'and land', `${footfalls} footfalls`);
  ok(c.pos.distanceTo(start) > 0.1, 'the creature travels', `moved ${c.pos.distanceTo(start).toFixed(2)}`);
  ok(worstClearance > 0, 'and never sinks through the ground',
    `worst clearance ${worstClearance.toFixed(3)}`);
  ok(Number.isFinite(c.pos.x) && Number.isFinite(c.pitch) && Number.isFinite(c.roll),
    'position and orientation stay finite');
  for (const leg of c.legs) {
    ok(leg.chain.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)),
      `leg ${leg.index} joints stay finite`);
  }
  console.log(`   ${steps} frames: moved ${c.pos.distanceTo(start).toFixed(2)}, `
    + `${footfalls} footfalls, min body clearance ${worstClearance.toFixed(3)}`);
}

// ============================================================ 10. the two-bone solver
section('10. solveTwoBone puts the knee where it is told');

// WHAT THIS SECTION IS FOR. `KinematicChain` satisfies the same two constraints and still produced a
// visibly wrong leg, because two segments and a target admit a whole circle of knees and FABRIK picks by
// resuming from wherever it already was. Measured on demos/sdf-bug-v2, the knee sat below the hip-to-foot
// chord for 63% of a 60 s walk. So the property worth testing is not "the tip reaches the target" — FABRIK
// passed that — it is WHICH SOLUTION comes back.
{
  const { solveTwoBone, clampLegTarget } = loco;
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const l1 = 0.206, l2 = 0.170, span = l1 + l2;
  const knee = V(), foot = V();

  // Every direction, every reachable distance, and both poles. The knee must land on the pole's side of
  // the root-to-target line in every one of them, and the bones must keep their exact lengths.
  {
    let worstLen = 0, wrongSide = 0, cases = 0, worstTip = 0;
    for (let a = 0; a < 16; a++) {
      for (let e = -3; e <= 3; e++) {
        for (const frac of [0.15, 0.4, 0.7, 0.9, 0.98]) {
          for (const pole of [V(0, 1, 0), V(1, 0, 0), V(0, -1, 0), V(0.3, 0.8, -0.5)]) {
            const th = a * Math.PI / 8, ph = e * 0.4;
            const dir = V(Math.cos(th) * Math.cos(ph), Math.sin(ph), Math.sin(th) * Math.cos(ph));
            const root = V(0.1, 0.4, -0.2);
            const target = root.clone().addScaledVector(dir, span * frac);
            solveTwoBone(root, target, pole, l1, l2, knee, foot);
            cases++;
            worstLen = Math.max(worstLen,
              Math.abs(knee.distanceTo(root) - l1), Math.abs(foot.distanceTo(knee) - l2));
            worstTip = Math.max(worstTip, foot.distanceTo(target));
            // the knee's offset from the chord must have a positive component along the pole
            const axis = target.clone().sub(root).normalize();
            const off = knee.clone().sub(root);
            off.addScaledVector(axis, -off.dot(axis));
            const across = pole.clone();
            across.addScaledVector(axis, -across.dot(axis));
            if (across.lengthSq() > 1e-8 && off.dot(across) <= 0) wrongSide++;
          }
        }
      }
    }
    console.log(`   ${cases} poses: worst bone-length error ${worstLen.toExponential(1)}, `
      + `worst tip miss ${worstTip.toExponential(1)}, knee on the wrong side ${wrongSide} times`);
    ok(worstLen < 1e-9, 'bone lengths are exact, not iterated', worstLen.toExponential(2));
    ok(worstTip < 1e-9, 'and the tip lands on a reachable target', worstTip.toExponential(2));
    ok(wrongSide === 0, 'the knee is never on the wrong side of the pole', `${wrongSide}/${cases}`);
  }

  // Unreachable targets: the leg must stay BENT at the extension limit rather than snap into a line, which
  // is the second half of the defect. FABRIK straightens here by design.
  {
    const root = V(), pole = V(0, 1, 0);
    const target = V(0, 0, span * 3);
    const r = solveTwoBone(root, target, pole, l1, l2, knee, foot, { maxExtension: 0.99 });
    const femur = knee.clone().sub(root), tibia = foot.clone().sub(knee);
    const interior = 180 - femur.angleTo(tibia) * 180 / Math.PI;
    console.log(`   target at 3x reach: solved to ${(r.used / span).toFixed(3)} of span, `
      + `knee angle ${interior.toFixed(1)} degrees`);
    ok(r.clamped, 'an unreachable target reports itself clamped');
    near(r.used, span * 0.99, 1e-9, 'clamped to exactly the extension limit');
    ok(interior < 175, 'and the leg stays bent rather than straightening', `${interior.toFixed(1)} deg`);
    ok(Math.abs(knee.distanceTo(root) - l1) < 1e-9, 'with the femur still its own length');
  }

  // Degenerate inputs, because a pole parallel to the leg has no side to be on.
  {
    const root = V();
    for (const [label, target, pole] of [
      ['pole along the leg', V(0, 0, 0.3), V(0, 0, 1)],
      ['pole is zero', V(0, 0, 0.3), V(0, 0, 0)],
      ['target on the root', V(0, 0, 0), V(0, 1, 0)],
      ['pole along a vertical leg', V(0, -0.3, 0), V(0, 1, 0)],
    ]) {
      solveTwoBone(root, target, pole, l1, l2, knee, foot);
      ok([knee, foot].every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
        && Math.abs(knee.distanceTo(root) - l1) < 1e-9,
        `${label} still yields a finite leg of the right length`);
    }
  }

  // clampLegTarget: the three limits, and the order they are applied in.
  {
    const hip = V(0.17, 0.16, 0.05), restDir = V(1, 0, 0);
    const swung = V(hip.x + 0.2, hip.y - 0.1, hip.z + 0.2);   // about 45 degrees off restDir
    const t = swung.clone();
    clampLegTarget(hip, t, restDir, span, { maxSwing: Math.PI / 12 });
    const ang = Math.atan2(t.x - hip.x, t.z - hip.z) - Math.atan2(restDir.x, restDir.z);
    near(Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang))), Math.PI / 12, 1e-9,
      'the swing limit lands the target exactly on the cone');
    near(t.distanceTo(hip), swung.distanceTo(hip), 1e-9,
      'and rotates rather than shortens — the distance is untouched');

    const far = V(hip.x + span * 2, hip.y, hip.z);
    const t2 = far.clone();
    clampLegTarget(hip, t2, restDir, span, { maxReach: 0.9 });
    near(t2.distanceTo(hip), span * 0.9, 1e-9, 'the reach limit pulls the target in to the limit');

    const high = V(hip.x + 0.1, hip.y + 0.5, hip.z);
    const t3 = high.clone();
    clampLegTarget(hip, t3, restDir, span, { maxRise: 0.1 });
    near(t3.y - hip.y, span * 0.1, 1e-9, 'the rise limit caps height above the hip');

    // Order matters: reach last means a target pulled in cannot be pushed back out by the swing rotation.
    const t4 = V(hip.x + span * 3, hip.y, hip.z + span * 3);
    clampLegTarget(hip, t4, restDir, span, { maxSwing: Math.PI / 8, maxReach: 0.8 });
    ok(t4.distanceTo(hip) <= span * 0.8 + 1e-9, 'both limits hold together, reach applied last',
      `${(t4.distanceTo(hip) / span).toFixed(4)} of span`);

    const t5 = swung.clone();
    clampLegTarget(hip, t5, restDir, span, {});
    near(t5.distanceTo(swung), 0, 0, 'no limits given is a no-op');
  }

  // The old solver is still exported and still behaves as it did, because the sim uses it.
  {
    const chain = new loco.KinematicChain([
      { length: l1, initDirection: V(1, 0, 0) },
      { length: l2, initDirection: V(0, -1, 0) },
    ]);
    const q = new THREE.Quaternion();
    chain.solve(V(), V(0.2, -0.2, 0), q);
    ok(chain.points.length === 3 && chain.points.every(p => Number.isFinite(p.x)),
      'KinematicChain is untouched and still solves');
  }
}

// ============================================================ summary
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
