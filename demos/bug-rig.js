// The walking rig behind demos/sdf-bug-v2.html.
//
// This is the CPU half of that demo: it owns the six legs, runs the gait, and hands out the joint
// positions and body pose the shader uploads as uniforms. The shader knows nothing about walking — it
// reads eighteen points and a rotation.
//
// It is a module rather than inline script for two reasons. The demo's own tests can reach it in Node,
// and more importantly the walk cycle itself is NOT here: it is imported from `../creature-locomotion.js`,
// the same code `port-creature-system.js` runs. That was the point of extracting it.
//
// ---------------------------------------------------------------------------------------------------
// THREE THINGS V1 DID THAT A WALKING BUG CANNOT
//
//   1. THE MIRROR HAS TO GO. Every paired thing in `sdf-bug.html` is one expression evaluated at
//      abs(p.x) — three leg expressions standing in for six legs. A gait is left/right asymmetric by
//      definition, so the legs must be six independent evaluations. The eyes and antennae stay mirrored
//      because they stay symmetric.
//   2. THE FEET WERE PINNED ON PURPOSE. v1's idle bob is applied to the body, hips and head rather than
//      to a warp of p, specifically so the feet do not move. Animating them inverts that decision, so
//      the bob here is breathing only and the feet are driven by the gait.
//   3. THE BODY HAS TO MOVE AND TILT. v1's primitives sit at fixed authored positions. Here the sample
//      point is carried into authored space instead, so every primitive is untouched and the whole body
//      moves for free. A rotation is an isometry, so the field stays a true distance field.
//
// AUTHORED SPACE IS THE FIXED POINT OF ALL OF THIS. `pAuthored = BODY_PIVOT + Rt * (pWorld - bodyPos)`,
// and hips go the other way. At rest `bodyPos === BODY_PIVOT` and `R === I`, so authored space IS world
// space and v2's first frame is v1's image exactly. That equality is a test, not a coincidence.
//
// SCALE IS THE PART THAT DOES NOT PORT. The stock gait is metres for a creature whose femur is 0.58;
// the bug's is 0.206. Geometry scales freely but `stepDuration`/`stepLift`/`maxSpeed` and the trigger
// thresholds do not come along, so BUG_GAIT below is authored against the bug's own leg length rather
// than scaled from GAITS.walk. The numbers are a starting point tuned by eye in the sliders, not
// derived from anything.

import {
  createCreatureLocomotion, cacheLegPartners, scheduleSteps, advanceLeg,
  bodySupport, orientFromFeet, cloneGait, lerp, clamp, LOCOMOTION,
} from '../creature-locomotion.js';

/**
 * How far the joints may leave the pose the legs were drawn in.
 *
 * These are the answer to a measured defect, not a precaution. FABRIK left the knee below the hip-to-foot
 * chord 63% of a 60 s walk (84% on the front legs) with the femur pointing DOWN at a median -28 degrees
 * against +24 as authored, and the femur swinging through a full 180 degrees of azimuth. Nothing bounded
 * any of it: the gait's comfort box is 0.20 m of horizontal slack on a 0.38 m leg, which is that whole
 * sweep, and the solver itself has no preferred side to bend toward.
 *
 * TWO LIMITS, ENFORCED IN DIFFERENT PLACES, and which place turned out to matter more than the numbers:
 *
 *   `swing` bounds where a FOOTHOLD may be placed and asks for a step once a planted foot drifts past it.
 *   `reach` bounds the SOLVE only. It is deliberately not a placement bound — see PLACE below, where
 *           clamping footholds by reach walked the bug off a steep leaf.
 *
 * 0.99 rather than a rounder number because the cap is what decides how straight the leg may get, and the
 * cost curve has a corner: at 0.99 the drawn foot is a median 0 mm and a p95 14 mm from its target with no
 * near-straight leg ever, while 0.999 buys 4 mm of that back and returns the straight-leg snap on 7 to 8%
 * of planted samples. Tighter is not free either — 0.94 triples the foot error to 43 mm at p95.
 *
 * `rise` was a third limit, capping how far above its hip a foot could go. Removed rather than defaulted
 * off: on a convex leaf the feet are always below the hips, so it never once fired in any measurement.
 */
export const BUG_LEG_LIMITS = {
  swing: Math.PI / 4,   // +/-45 degrees of fore/aft rotation from the authored leg direction
  reach: 0.99,          // and 99% of straight, which is where the knee stops reading as a knee
};

// The three authored leg pairs, transcribed from `sdf-bug.html`'s LEGS table. Row 0 is the front pair.
// `foot` is (x, z) only — its height is solved from the dome, which is why v1 could restand the bug at
// any leg spread or leaf radius without re-authoring anything.
export const BUG_LEGS = [
  { hip: [0.150, 0.170, 0.290], knee: [0.290, 0.255, 0.415], foot: [0.345, 0.500], r: [0.033, 0.024, 0.010] },
  { hip: [0.175, 0.160, 0.045], knee: [0.345, 0.245, 0.080], foot: [0.420, 0.120], r: [0.033, 0.024, 0.010] },
  { hip: [0.165, 0.160, -0.180], knee: [0.320, 0.235, -0.320], foot: [0.385, -0.435], r: [0.031, 0.023, 0.010] },
];

/** How far the foot's tip sinks into the ground, as a fraction of its radius. Matches v1's FOOT_SINK. */
export const FOOT_SINK = 0.35;

/** The point the body rotates about, in authored space — roughly the pronotum/abdomen centre. */
export const BODY_PIVOT = [0, 0.31, 0];

/**
 * The bug's gait.
 *
 * `rowPairSteps: false` selects the walk scheduler, and that plus `maxConcurrentFraction: 0.5` is what
 * produces an insect's ALTERNATING TRIPOD — and it falls out of the existing code rather than needing
 * new code. The scheduler spreads steps across `leg.phase`, which the sim computes as
 * `(row + (side > 0 ? 1 : 0)) % 2`. For three rows that is:
 *
 *     phase 0 = front-left, middle-right, back-left
 *     phase 1 = front-right, middle-left, back-right
 *
 * which is exactly the tripod. The cap of 0.5 lets one whole tripod leave the ground at once, and the
 * scheduler's "don't step two legs of the same phase" rule is gated on `legs.length <= 4`, so at six legs
 * it correctly does not apply.
 */
export const BUG_GAIT = {
  label: 'Scurry',
  maxSpeed: 0.34,
  turnSpeed: 2.6,
  stationaryHeight: 1.00,
  movingHeight: 1.04,
  stationaryTrigger: { h: 0.040, v: 0.045 },
  movingTrigger: { h: 0.115, v: 0.060 },
  comfort: { h: 0.20, v: 0.13 },
  stepDuration: 0.115,          // insects step fast; this is the single biggest departure from GAITS.walk
  stepLift: 0.038,
  lookAhead: 0.22,
  scanHeight: 0.26,
  scanDepth: 0.55,
  scanGrid: 0.032,
  scanHeightBias: 0.34,
  maxConcurrentFraction: 0.5,   // 6 legs -> 3 airborne: one tripod
  restepEpsilon: 0.012,         // the sim's 0.1 m is wider than this bug's whole stride

  samePairCooldown: 0.05,
  crossPairCooldown: 0.04,
  uncomfortableSpeedMultiplier: 0.35,
  rowPairSteps: false,
  rotationLerp: 0.22,
  preferredRotationLerp: 0.18,
  preferredPitchLeeway: Math.PI / 7,
};

/** Body physics, scaled off the stock constants where they transfer and re-authored where they do not. */
export const BUG_PHYSICS = {
  GRAV: LOCOMOTION.GRAV,
  KP: LOCOMOTION.KP,
  KD: LOCOMOTION.KD,
  H_DRAG: LOCOMOTION.H_DRAG,
  BOUNCE: LOCOMOTION.BOUNCE,
  BODY_MIN_CLEAR: 0.11,   // 0.30 would hold the bug a body-height above the leaf
  DRIVE: 8.0,
  FIXED: 1 / 60,
  MAX_SUBSTEPS: 5,
};

/**
 * The leaf's surface as a height function.
 *
 * A sphere is single-valued in (x, z) only on its upper hemisphere, and a height function is all the foot
 * scan ever asks for. Past the equator this clamps to -R, which reads as a cliff and makes the scan
 * correctly report no reachable ground — so the bug will not walk off the underside of the leaf. Keeping
 * it inside `roamRadius` is what stops it trying.
 */
export function domeGround(sproutR) {
  return (x, z) => Math.sqrt(Math.max(sproutR * sproutR - x * x - z * z, 0)) - sproutR;
}

/**
 * A flat leaf: the plane y = 0.
 *
 * Trivial as a function, and that is the point — it is the same seam `domeGround` uses, so nothing in the
 * gait, the scan or the solver learns about it. What it is FOR is diagnostic as much as scenic: curvature
 * is the confounder in every measurement of this rig, and a plane removes it. The knee-inversion bug was
 * confirmed to be the solver rather than the dome by measuring it here first — 56% on flat ground against
 * 63% on the dome, where a terrain cause would have collapsed toward zero.
 *
 * It takes the radius so the two grounds have the same signature, and ignores it: containment is the
 * shader's disc and the rig's `roamRadius`, not the height function. This one never reports a cliff, so a
 * bug that wanders past the edge would keep walking on nothing — `roamRadius` is what prevents that, and it
 * is doing more work here than on the dome.
 */
export function flatGround(_sproutR) {
  return () => 0;
}

/** The two grounds by name, so a caller can switch without knowing how either is built. */
export const GROUNDS = { dome: domeGround, flat: flatGround };

/**
 * Scale a gait for a bug of a different size — and NOT by multiplying everything by the scale.
 *
 * This module's own header records that scale is the part which does not port: `GAITS.walk` is metres for a
 * creature whose femur is 0.58, and "a gait scaled in space but not in time reads as a shrunken elephant".
 * The same trap applies within one species. Lengths go as `s`, but times and speeds do not, because gravity
 * does not scale with the bug:
 *
 *     Froude similarity, v²/(gL) held constant  ->  speed ∝ √s, time ∝ √s, angular rate ∝ 1/√s
 *
 * So a half-size bug steps 1/√2 as far in 1/√2 the time and turns √2 as fast — which is why small insects
 * look frantic and large ones ponderous. Multiplying `stepDuration` by `s` instead would make every size
 * take the same number of strides per metre travelled, and they would all move like the original.
 *
 * Dimensionless numbers are left alone, and getting that list right is most of the work here:
 * `stationaryHeight`/`movingHeight` are fractions of the leg, `lookAhead` multiplies a trigger distance,
 * `maxConcurrentFraction` and `uncomfortableSpeedMultiplier` are ratios, and the rotation lerps are
 * per-frame blend factors rather than rates.
 */
export function scaleBugGait(gait, s) {
  if (!(s > 0)) throw new Error('scaleBugGait needs a positive scale');
  const t = Math.sqrt(s);
  const g = cloneGait(gait);
  for (const k of ['stepLift', 'scanHeight', 'scanDepth', 'scanGrid', 'restepEpsilon']) {
    if (g[k] != null) g[k] *= s;
  }
  for (const k of ['stationaryTrigger', 'movingTrigger', 'comfort']) {
    if (g[k]) { g[k].h *= s; g[k].v *= s; }
  }
  g.maxSpeed *= t;                       // speed ∝ √s
  g.stepDuration *= t;                   // and so is a stride's duration
  g.samePairCooldown *= t;
  g.crossPairCooldown *= t;
  g.turnSpeed /= t;                      // an angular rate goes the other way
  return g;
}

/** Mirror the authored pairs into six legs, front row first, matching finalizePlan's row/side ordering. */
export function bugLegSpecs({ legSpread = 1 } = {}) {
  const specs = [];
  for (let row = 0; row < BUG_LEGS.length; row++) {
    const L = BUG_LEGS[row];
    for (const side of [-1, 1]) {
      specs.push({
        row, side,
        // legSpread scales x only, exactly as v1's shader does — scaling z as well moves the rows.
        hip: [L.hip[0] * side, L.hip[1], L.hip[2]],
        knee: [L.knee[0] * legSpread * side, L.knee[1], L.knee[2]],
        foot: [L.foot[0] * legSpread * side, L.foot[1]],
        r: L.r.slice(),
        // The tripod comes from this, and it is the sim's own formula.
        phase: (row + (side > 0 ? 1 : 0)) % 2,
      });
    }
  }
  return specs;
}

/**
 * Build the rig.
 *
 * `THREE` is injected for the same reason `creature-locomotion.js` injects it: the demo page loads three
 * from a CDN importmap and should not resolve a second copy.
 */
export function createBugRig({
  THREE,
  sproutR = 2.4,
  legSpread = 1,
  roamRadius = null,
  groundShape = 'dome',
  gait = BUG_GAIT,
  physics = BUG_PHYSICS,
  limits = BUG_LEG_LIMITS,
  legSolver = 'two-bone',
  scale = 1,
  rng = Math.random,
} = {}) {
  if (!THREE?.Vector3) throw new Error('createBugRig needs { THREE }');
  const loco = createCreatureLocomotion({ THREE });
  const { KinematicChain, rotateXZ, createLegSolver, solveTwoBone, clampLegTarget } = loco;

  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  // BODY_PIVOT is authored unit-size like everything else, so the rig's own pivot is the scaled one. The
  // unit value is still what the SHADER wants, since its primitives are authored unit-size too — see
  // `jointsUnit`, which is the seam between the two.
  // `let`, because the size is a slider: see `setScale`. Everything derived from the scale is recomputed
  // there rather than baked in, which is the same reason `buildLegs` exists for the leg spread.
  let pivotAt = BODY_PIVOT.map((v) => v * scale);
  const state = {
    sproutR,
    legSpread,
    // Default: half the leaf radius, which keeps the bug on the mild part of the cap.
    // Flat gets more of the leaf than the dome does. On a dome the outer part is the steep part, and
    // 0.42 keeps the bug on the mild cap; a plane has no steep part, so the only thing the radius is
    // holding it back from is the edge.
    roamRadius: roamRadius ?? sproutR * (groundShape === 'flat' ? 0.75 : 0.42),
    groundShape,
    // Scaled here rather than at the call site, so a caller cannot ask for a half-size bug and forget that
    // its gait has to change too. scaleBugGait clones, so the caller's table is untouched.
    gait: scaleBugGait(gait, scale),
    // BODY_MIN_CLEAR is a length — the hard floor under the body — so it scales. The spring constants and
    // gravity do not: they are already in the units the integrator works in.
    physics: { ...physics, BODY_MIN_CLEAR: physics.BODY_MIN_CLEAR * scale },
    limits: { ...limits },
    // 'fabrik' is kept reachable ONLY so the demo can show what it looked like before. It is the old
    // KinematicChain solve, unbounded, and it is what left the knee inverted for most of a walk.
    legSolver,
    scale,
    ground: (GROUNDS[groundShape] ?? domeGround)(sproutR),
  };
  if (!(scale > 0)) throw new Error('createBugRig needs a positive scale');

  // The foot's tip sinks by FOOT_SINK of its radius, so the clearance is the rest of it. This is v1's
  // `groundY(fx, fz) + leg.r[2] * (1 - FOOT_SINK)` restated as the solver's footGround.
  // Scaled with the bug: a foot half the size sinks half as far, so a fixed clearance would plant a small
  // bug in the leaf and float a large one above it.
  let footClearance = BUG_LEGS[0].r[2] * (1 - FOOT_SINK) * scale;
  // The unscaled gait, kept so a later size change re-derives from the original rather than compounding
  // square roots. Scaling an already-scaled gait twice by sqrt is not the same as scaling it once.
  let baseGait = cloneGait(gait);
  let solver = createLegSolver({ terrainHeight: state.ground, footGround: footClearance });

  // --- legs ------------------------------------------------------------------------------------------
  const legs = [];

  /**
   * Build (or rebuild) the six legs at the current leg spread.
   *
   * Rebuildable because the stance is a slider on the page and the SEGMENT LENGTHS depend on it: a wider
   * stance is a longer tibia, not the same leg moved sideways. Nothing short of rebuilding the chains
   * would honour that, and a slider that silently did nothing would be worse than no slider.
   */
  function buildLegs() {
    legs.length = 0;
    const S = state.scale;
    for (const spec of bugLegSpecs({ legSpread: state.legSpread })) {
      // The authored table is unit-size, so everything derived from it — segment lengths, the pole, the
      // rest position — comes out scaled without any of those needing to know about the scale.
      const hipA = V(spec.hip[0] * S, spec.hip[1] * S, spec.hip[2] * S);
      const kneeA = V(spec.knee[0] * S, spec.knee[1] * S, spec.knee[2] * S);
      const fx = spec.foot[0] * S, fz = spec.foot[1] * S;
      const footA = V(fx, state.ground(fx, fz) + footClearance, fz);

      const segments = [
        { length: kneeA.distanceTo(hipA), initDirection: kneeA.clone().sub(hipA).normalize() },
        { length: footA.distanceTo(kneeA), initDirection: footA.clone().sub(kneeA).normalize() },
      ];

      // THE POLE IS MEASURED, NOT CHOSEN. It is the authored knee's own offset from the authored
      // hip-to-foot chord, so the analytic solve reproduces the drawn pose exactly at rest and keeps
      // bending to that same side everywhere else. Picking a pole by hand (say, straight up) would have
      // changed v1's silhouette, which the parity test would then have to be loosened to accept.
      const chord = footA.clone().sub(hipA);
      const pole = kneeA.clone().sub(hipA);
      pole.addScaledVector(chord, -pole.dot(chord) / Math.max(1e-12, chord.lengthSq())).normalize();
      // Fore/aft direction the leg was drawn along, which is what the swing limit is measured from.
      const restDir = new THREE.Vector3(footA.x - hipA.x, 0, footA.z - hipA.z).normalize();

      const leg = {
        index: legs.length, row: spec.row, side: spec.side, phase: spec.phase,
        // World-space radii. The SHADER wants the unit ones and reads them straight off BUG_LEGS, since a
        // radius does not depend on the leg spread; these exist for the bounding sphere, which is world.
        r: spec.r.map((v) => v * S),
        // Body-local, i.e. authored position relative to the pivot.
        attachmentLocal: hipA.clone().sub(V(...pivotAt)),
        restLocal: V(spec.foot[0] * S, 0, spec.foot[1] * S),
        chain: new KinematicChain(segments),
        poleLocal: pole, restDirLocal: restDir,
        l1: segments[0].length, l2: segments[1].length,
        span: segments[0].length + segments[1].length,
        hipWorld: hipA.clone(),
        end: footA.clone(),
        target: footA.clone(), groundPosition: footA.clone(),
        stepStart: footA.clone(), stepEnd: footA.clone(),
        lookAhead: V(), scanStart: V(), scanEnd: V(),
        targetGrounded: true, stepping: false, t: 0,
        timeSinceBeginMove: 999, timeSinceStopMove: 999,
        canMove: false, primary: false, wants: false, uncomfortable: false,
        restX: footA.x, restY: footA.y, restZ: footA.z,
      };
      // Seed the chain at the authored pose so the knee bends the way it was drawn: FABRIK on two
      // segments has a circle of valid solutions and picks by resuming from wherever it already is.
      leg.chain.points = [hipA.clone(), kneeA.clone(), footA.clone()];
      legs.push(leg);
    }
    cacheLegPartners(legs);
    // Body height is derived, not authored: the pivot's authored height above the feet it was drawn
    // with. It has to be re-derived here, because a wider stance puts the feet lower on the dome.
    const restFootY = legs.reduce((s, l) => s + l.end.y, 0) / legs.length;
    return pivotAt[1] - restFootY;
  }

  const bodyHeight = buildLegs();

  // --- body ------------------------------------------------------------------------------------------
  const body = {
    pos: V(...pivotAt), vel: V(), yaw: 0,
    pitch: 0, roll: 0, preferredPitch: 0, preferredRoll: 0,
    desiredDir: V(0, 0, 1),
    bodyHeight,
    commandedSpeed: 0,   // what the controller asked for this step; read by demos/bug-gait-objective.js
  };

  const pivot = V(...pivotAt);   // kept in step with pivotAt by setScale
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _m = new THREE.Matrix4();
  const _rot = new THREE.Matrix3();          // body rotation
  const _inv = new THREE.Matrix3();          // and its transpose, which is what the shader wants
  const _pole = V();                         // the knee-side hint, carried into world each solve

  const _target = V(0, 0, 1);
  const _steer = V(0, 0, 1);
  let haveTarget = false;

  function refreshRotation() {
    // YXZ: yaw first, then the terrain-derived pitch and roll, which is the order the sim's meshes use.
    _e.set(body.pitch, body.yaw, body.roll, 'YXZ');
    _q.setFromEuler(_e);
    _m.makeRotationFromQuaternion(_q);
    _rot.setFromMatrix4(_m);
    _inv.copy(_rot).transpose();
  }
  refreshRotation();

  /** Authored space -> world. Hips travel this way. */
  function toWorld(authored, out = V()) {
    return out.copy(authored).sub(pivot).applyMatrix3(_rot).add(body.pos);
  }

  /** World -> authored space. The shader carries its sample point this way. */
  function toAuthored(world, out = V()) {
    return out.copy(world).sub(body.pos).applyMatrix3(_inv).add(pivot);
  }

  function pickTarget() {
    const r = state.roamRadius * (0.35 + 0.6 * rng());
    const a = rng() * Math.PI * 2;
    _target.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    haveTarget = true;
  }

  function steer() {
    if (!haveTarget) pickTarget();
    const dx = _target.x - body.pos.x, dz = _target.z - body.pos.z;
    if (Math.hypot(dx, dz) < 0.12) pickTarget();

    // Hard turn back if the bug has wandered toward the rim, where the dome stops being walkable.
    const out = Math.hypot(body.pos.x, body.pos.z);
    if (out > state.roamRadius * 1.15) {
      body.desiredDir.set(-body.pos.x, 0, -body.pos.z).normalize();
      return;
    }
    body.desiredDir.set(_target.x - body.pos.x, 0, _target.z - body.pos.z);
    if (body.desiredDir.lengthSq() < 1e-9) body.desiredDir.set(Math.sin(body.yaw), 0, Math.cos(body.yaw));
    body.desiredDir.normalize();
  }

  let acc = 0;

  /**
   * Advance one fixed step. Mirrors the order in `port-creature-system.js`'s `physicsStep`: turn, solve
   * every foot target, advance the arcs, schedule new steps, find the support, integrate, then orient.
   */
  function fixedStep(h, walk) {
    const g = state.gait;
    const P = state.physics;
    const speed2 = Math.hypot(body.vel.x, body.vel.z);
    const speedFraction = clamp(speed2 / Math.max(0.001, g.maxSpeed), 0, 1);
    const targetHeight = body.bodyHeight * lerp(g.stationaryHeight, g.movingHeight, speedFraction);
    const triggerH = lerp(g.stationaryTrigger.h, g.movingTrigger.h, speedFraction);
    const triggerV = lerp(g.stationaryTrigger.v, g.movingTrigger.v, speedFraction);

    if (walk) steer();
    else body.desiredDir.set(Math.sin(body.yaw), 0, Math.cos(body.yaw));

    // STOP TURNING while a planted foot is already overextended. This guard exists in the sim's
    // physicsStep and the first version of this rig omitted it, which was a real and visible defect
    // rather than a subtlety: turning is what strands a pinned foot, because the body rotates away from
    // it while the scheduler is still refusing to let it step. Measured over 60 s, some planted foot was
    // out of its leg's reach 15% of the time, by a median of 138 mm on a 548 mm leg and occasionally by
    // more than twice the leg's length for over a second. FABRIK cannot reach an unreachable target, so
    // it straightens instead: the leg snaps into a straight line and the drawn foot leaves the leaf.
    // `uncomfortableSpeedMultiplier` alone did not save it - slowing down still lets the body rotate.
    const pinned = legs.some(l => l.uncomfortable && !l.stepping);
    const steerDir = pinned
      ? _steer.set(Math.sin(body.yaw), 0, Math.cos(body.yaw))
      : body.desiredDir;

    const desiredYaw = Math.atan2(steerDir.x, steerDir.z);
    const diff = Math.atan2(Math.sin(desiredYaw - body.yaw), Math.cos(desiredYaw - body.yaw));
    // A TURN BRAKE WAS TRIED HERE AND REMOVED, because it did not work and the measurement says so.
    // Turning under planted feet is what produces the wide hip swing, so slowing the turn in proportion to
    // how much swing the planted legs had left looked like the fix. Swept over its whole useful range
    // (brake floor 1.0 meaning off, down to 0.2) it moved p95 swing from 49.3 to 45.9 degrees — noise —
    // while one setting, 0.6, left the bug unable to turn back from a small leaf's rim at all: it reached
    // 2.24 m on a leaf whose roam radius is 0.59 and dragged a foot 762 mm from its target. A knob that
    // buys 3 degrees and can do that is worse than no knob. Bounding hip swing properly is a gait-level
    // problem — how much yaw may happen per stance period — and it is not solved.
    body.yaw += clamp(diff, -g.turnSpeed * h, g.turnSpeed * h);

    for (const leg of legs) {
      leg.timeSinceBeginMove += h;
      leg.timeSinceStopMove += h;
      const rest = solver.solveLegTarget(leg, g, triggerH, true, body);
      // Clamp the FOOTHOLD, not the drawn pose. Clamping the pose every frame would drag a planted foot
      // along with the body, which is skating; clamping where the foot is allowed to land means the gait
      // then schedules a step instead, because an unreachable target is what `uncomfortable` already
      // watches for.
      clampTargetToLimits(leg, leg.target, leg.targetGrounded);
      advanceLeg(leg, g, h, triggerH, triggerV, rest);
      flagLimitStress(leg);
    }
    if (walk) scheduleSteps(legs, g);

    const sup = bodySupport(legs, body.pos);

    // Gravity, then the height spring along the support normal. Straight up while the centre of mass is
    // over the support polygon, tilting off it once it is not, which is what makes an overreaching bug
    // lean rather than hover.
    body.vel.y -= P.GRAV * h;
    if (sup.haveNormal) {
      const preferredY = sup.cy + targetHeight;
      let mag = P.GRAV + P.KP * (preferredY - body.pos.y) - P.KD * body.vel.y;
      mag = clamp(mag, 0, P.GRAV * 4 * sup.fG);
      let ax = sup.nx * mag, ay = sup.ny * mag, az = sup.nz * mag;
      if (Math.hypot(ax, az) > ay) { ax = 0; ay = 0; az = 0; }
      body.vel.x += ax * h;
      body.vel.y += ay * h;
      body.vel.z += az * h;
    }

    const anyUncomfortable = legs.some(l => l.uncomfortable && !l.stepping);
    const wanted = walk
      ? g.maxSpeed * (0.35 + 0.65 * Math.max(0, Math.cos(diff)))
        * (anyUncomfortable ? g.uncomfortableSpeedMultiplier : 1)
      : 0;
    // Recorded for the gait objective. It has to compare achieved speed against what the CONTROLLER asked
    // for, not against maxSpeed: this model slows deliberately when turning and when a foot is pinned, so
    // measuring against maxSpeed would charge the gait for the steering model's own decisions and push an
    // optimiser to defeat them rather than to fix anything.
    body.commandedSpeed = wanted;
    const drive = P.DRIVE * sup.fG;
    body.vel.x += (Math.sin(body.yaw) * wanted - body.vel.x) * drive * h;
    body.vel.z += (Math.cos(body.yaw) * wanted - body.vel.z) * drive * h;
    body.vel.x *= (1 - P.H_DRAG * h);
    body.vel.z *= (1 - P.H_DRAG * h);

    body.pos.addScaledVector(body.vel, h);

    const floorY = state.ground(body.pos.x, body.pos.z) + P.BODY_MIN_CLEAR;
    if (body.pos.y < floorY) {
      body.pos.y = floorY;
      if (body.vel.y < 0) body.vel.y *= -P.BOUNCE;
    }

    orientFromFeet(legs, g, body);
    refreshRotation();
    return sup;
  }

  const _clampScratch = V();

  /**
   * Footholds are chosen INSIDE the joint's range, not at the edge of it.
   *
   * This is the whole difference between the limits working and the limits making the demo worse. With
   * placement and trigger both at the limit, a foot landed at 44 degrees of swing and the trigger fired at
   * 36, so two or three legs wanted to step at every instant; the scheduler's adjacency rules then vetoed
   * all of them (`canMove` sat at 0), the body outran its feet by 510 mm and eventually left the leaf.
   *
   * ONLY SWING IS A PLACEMENT LIMIT. `reach` was too, and that was a regression: pulling a
   * foothold in toward the hip crowds the feet under the body, which shrinks the support polygon, and on a
   * steep dome the body's centre then leaves it and the bug slides downhill off the leaf. Measured over
   * five wander seeds on a 1.4 m leaf, three escaped past the equator with reach clamped and none did with
   * it removed — while swing alone and the step epsilon alone were both clean.
   *
   * Reach is still bounded, in the place it belongs: `solveTwoBone` refuses to extend past it and keeps the
   * leg bent instead, which is the actual defect (a leg snapping straight), and the step trigger below asks
   * for a step before it gets there. Neither moves the foot.
   */
  const PLACE = { swing: 0.70 };

  // A REACH TRIGGER WAS ALSO TRIED AND REMOVED. Once reach stopped bounding placement, nothing kept a
  // planted foot inside it, so the trigger fired continuously for the outermost legs: `wants` was set on
  // legs that could do nothing about it, the scheduler's adjacency rules then vetoed every candidate, and
  // all five wander seeds walked off the leaf. A limit may drive a step trigger only if something also
  // keeps the value near it. Reach has no such thing, so reach is enforced in the solve alone.

  /**
   * Clamp a world-space foot target into what the leg can hold.
   *
   * The limits are angles about the BODY's axes, so the work happens in body-local space — measuring
   * swing in world space would count the body's own pitch and roll as leg rotation, and on a leaf that is
   * most of the tilt there is.
   *
   * `reground` re-drops the clamped point onto the leaf, then re-clamps, because moving a point sideways
   * changes the height it should stand at. Two passes: the second correction is second-order in the
   * surface's curvature, and `worstFootError` is what would say otherwise.
   */
  function clampTargetToLimits(leg, target, reground) {
    const lim = state.limits;
    if (!lim || lim.swing == null) return target;
    for (let pass = 0; pass < (reground ? 2 : 1); pass++) {
      _clampScratch.copy(target).sub(body.pos).applyMatrix3(_inv);
      clampLegTarget(leg.attachmentLocal, _clampScratch, leg.restDirLocal, leg.span, {
        maxSwing: lim.swing == null ? null : lim.swing * PLACE.swing,
        maxRise: null, maxReach: null,
      });
      target.copy(_clampScratch).applyMatrix3(_rot).add(body.pos);
      if (reground) target.y = state.ground(target.x, target.z) + footClearance;
    }
    return target;
  }

  /**
   * Tell the gait that a leg is running out of joint, so it lifts instead of stranding.
   *
   * Clamping where a foot MAY land is not enough on its own: the foothold is chosen once and then the body
   * walks past it, so a planted foot keeps rotating relative to the hip. Measured with the clamp alone,
   * swing still reached 73 degrees against a 45-degree limit. Forcing the foot back inside the cone every
   * frame is not the answer either — that is a planted foot sliding across the leaf.
   *
   * So the limit becomes a step TRIGGER as well as a bound: it sets `wants`, the flag the scheduler reads.
   * The margins are below 1 so a leg asks to step before it hits the wall rather than after.
   *
   * It deliberately does NOT set `uncomfortable`. That flag also freezes steering and cuts speed, and
   * setting it here made the demo visibly worse rather than better — the bug could no longer turn at all,
   * so it walked straight off the leaf's rim, where the height function clamps to a cliff. Measured: swing
   * 140 degrees and a foot 713 mm from its target, against 73 mm and 90 mm with no trigger at all.
   */
  function flagLimitStress(leg) {
    if (leg.stepping) return;
    const lim = state.limits;
    if (lim.swing == null) return;
    _clampScratch.copy(leg.end).sub(body.pos).applyMatrix3(_inv).sub(leg.attachmentLocal);
    const a = Math.atan2(_clampScratch.x, _clampScratch.z)
      - Math.atan2(leg.restDirLocal.x, leg.restDirLocal.z);
    leg.swing = Math.atan2(Math.sin(a), Math.cos(a));
    if (Math.abs(leg.swing) > lim.swing) leg.wants = true;
  }


  /**
   * Solve every leg against its current foot target. Leaves the answers in `leg.chain.points`, which is
   * still what the shader reads, so the uniform path did not change.
   *
   * `solveTwoBone` replaces the FABRIK solve here. Both satisfy the same two constraints; the difference
   * is that this one is told WHICH of the circle of valid knees to pick, and the measured inversion rate
   * is the reason it needs to be. Segment lengths come out exact rather than iterated to a tolerance.
   */
  function solveIk() {
    const fabrik = state.legSolver === 'fabrik';
    for (const leg of legs) {
      // attachmentLocal is already authored-minus-pivot, so it only needs rotating and translating.
      leg.hipWorld.copy(leg.attachmentLocal).applyMatrix3(_rot).add(body.pos);
      if (fabrik) {
        leg.chain.solve(leg.hipWorld, leg.end, _q);
        leg.solved = null;
        continue;
      }
      _pole.copy(leg.poleLocal).applyMatrix3(_rot);
      const pts = leg.chain.points;
      if (pts.length !== 3) leg.chain.reset(leg.hipWorld, _q);
      pts[0].copy(leg.hipWorld);
      leg.solved = solveTwoBone(
        leg.hipWorld, leg.end, _pole, leg.l1, leg.l2, pts[1], pts[2],
        { maxExtension: state.limits?.reach ?? 0.999 },
      );
    }
  }

  return {
    THREE, legs, body, state, loco,
    bodyHeight, footClearance, pivot,
    get rotation() { return _rot; },
    get inverseRotation() { return _inv; },
    toWorld, toAuthored,

    /** Fixed-timestep accumulator, so the gait does not change with the frame rate. */
    update(dt, { walk = true } = {}) {
      const P = state.physics;
      acc = Math.min(acc + dt, P.FIXED * P.MAX_SUBSTEPS * 2);
      let steps = 0;
      let sup = null;
      while (acc >= P.FIXED && steps < P.MAX_SUBSTEPS) {
        sup = fixedStep(P.FIXED, walk);
        acc -= P.FIXED;
        steps++;
      }
      if (steps) solveIk();
      return { steps, support: sup };
    },

    /**
     * Re-derive the ground and the solver, then restand the legs on it.
     *
     * One entry point for both the radius and the shape, because they cannot be changed independently:
     * the solver closes over the height function and the leg SEGMENT LENGTHS are solved against it, so
     * either change means rebuilding both. A setter that only swapped the function would leave the legs
     * the wrong length for the surface they are standing on.
     */
    setGround({ sproutR: r = state.sproutR, shape = state.groundShape } = {}) {
      state.sproutR = r;
      state.groundShape = shape;
      state.ground = (GROUNDS[shape] ?? domeGround)(r);
      state.roamRadius = r * (shape === 'flat' ? 0.75 : 0.42);
      solver = createLegSolver({ terrainHeight: state.ground, footGround: footClearance });
      body.bodyHeight = buildLegs();
    },

    /** Kept because the page and the tests call it; the radius is the common case. */
    setSproutR(r) { this.setGround({ sproutR: r }); },

    /** Loosen or tighten the joint limits live. Pass any subset; `null` for a key removes that limit. */
    setLimits(partial) {
      Object.assign(state.limits, partial);
    },

    /**
     * What the joints are actually doing, in body-local space. A diagnostic for the page's readout and
     * for the tests, and the measurement that justified the solver change in the first place.
     *
     * `inverted` counts legs whose knee has fallen BELOW the hip-to-foot chord, which is the pose that
     * reads as a backwards-bending leg. `swing` is in radians from the authored direction.
     */
    legPose() {
      const out = [];
      for (const leg of legs) {
        const h = _clampScratch.copy(leg.chain.points[0]).sub(body.pos).applyMatrix3(_inv).clone();
        const k = _clampScratch.copy(leg.chain.points[1]).sub(body.pos).applyMatrix3(_inv).clone();
        const f = _clampScratch.copy(leg.chain.points[2]).sub(body.pos).applyMatrix3(_inv).clone();
        const chord = f.clone().sub(h);
        const s = chord.lengthSq() > 1e-12 ? k.clone().sub(h).dot(chord) / chord.lengthSq() : 0;
        const swing = Math.atan2(f.x - h.x, f.z - h.z) - Math.atan2(leg.restDirLocal.x, leg.restDirLocal.z);
        out.push({
          index: leg.index, row: leg.row, side: leg.side, stepping: leg.stepping,
          inverted: k.y < h.y + chord.y * s,
          kneeAboveChord: k.y - (h.y + chord.y * s),
          swing: Math.atan2(Math.sin(swing), Math.cos(swing)),
          reach: h.distanceTo(f) / leg.span,
          rise: (f.y - h.y) / leg.span,
          // Under FABRIK there is no reported shortfall, so measure the drawn tip against the target.
        shortfall: leg.solved ? leg.solved.reach - leg.solved.used : f.distanceTo(
          _clampScratch.copy(leg.end).sub(body.pos).applyMatrix3(_inv)),
        });
      }
      return out;
    },

    /**
     * Swap the gait, at whatever size this bug is.
     *
     * The preset tables are authored at size 1, so handing one straight to `state.gait` would undo the size
     * scaling — a half-size bug would silently get a full-size bug's step timing. Going through
     * `scaleBugGait` is what keeps the two independent.
     */
    setGait(g) {
      baseGait = cloneGait(g);
      state.gait = scaleBugGait(baseGait, state.scale);
      return state.gait;
    },

    /**
     * Resize the bug in place.
     *
     * Not a matter of multiplying a number: the segment lengths, the foot clearance, the pivot height, the
     * hard floor under the body and the whole gait all move, and the gait does NOT move linearly — see
     * `scaleBugGait`. Re-derived from `baseGait` rather than from the current one, so dragging the slider
     * back and forth does not compound.
     *
     * Any manual gait edits are lost, exactly as they are when the gait preset changes. That is honest: a
     * gait tuned for one size is not the same gait at another.
     */
    setScale(s) {
      if (!(s > 0)) throw new Error('setScale needs a positive scale');
      const at = { x: body.pos.x, z: body.pos.z, yaw: body.yaw };
      state.scale = s;
      pivotAt = BODY_PIVOT.map((v) => v * s);
      pivot.set(...pivotAt);
      footClearance = BUG_LEGS[0].r[2] * (1 - FOOT_SINK) * s;
      state.gait = scaleBugGait(baseGait, s);
      state.physics.BODY_MIN_CLEAR = physics.BODY_MIN_CLEAR * s;
      solver = createLegSolver({ terrainHeight: state.ground, footGround: footClearance });
      body.bodyHeight = buildLegs();
      this.reset(at);
    },

    /** Rebuild the legs at a new stance width. The segment lengths change, so the chains are remade. */
    setLegSpread(v) {
      state.legSpread = v;
      body.bodyHeight = buildLegs();
    },

    /**
     * Park the bug at the authored pose. With no argument that is the authored PLACE too — the state in
     * which v2 must reproduce v1 exactly, which is asserted rather than assumed.
     *
     * With a place, the same stance is built around a different point and heading, so several bugs can stand
     * on one leaf without being stacked at the origin. The body's height is the authored height ABOVE THE
     * GROUND AT THE PIVOT rather than an absolute y, which is what makes the default case land on exactly
     * `pivotAt[1]` — an absolute y would have been wrong everywhere else, and a ground-relative height would
     * have been a hair off at the origin and broken the v1 parity test.
     */
    reset({ x = pivotAt[0], z = pivotAt[2], yaw = 0 } = {}) {
      const lift = pivotAt[1] - state.ground(pivotAt[0], pivotAt[2]);
      body.pos.set(x, state.ground(x, z) + lift, z);
      body.vel.set(0, 0, 0);
      body.yaw = yaw; body.pitch = 0; body.roll = 0;
      body.preferredPitch = 0; body.preferredRoll = 0;
      haveTarget = false;
      acc = 0;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      for (const leg of legs) {
        // The rest position is body-local, so it turns with the heading. rotateXZ is the sim's own formula,
        // and the same one `solveLegTarget` uses, so a placed bug's feet are where the scan expects them.
        const rx = leg.restLocal.x * cy + leg.restLocal.z * sy;
        const rz = -leg.restLocal.x * sy + leg.restLocal.z * cy;
        const fx = x + rx, fz = z + rz;
        const fy = state.ground(fx, fz) + footClearance;
        leg.end.set(fx, fy, fz);
        leg.target.copy(leg.end);
        leg.stepping = false; leg.t = 0; leg.wants = false;
        leg.targetGrounded = true; leg.uncomfortable = false;
        leg.timeSinceBeginMove = 999; leg.timeSinceStopMove = 999;
      }
      refreshRotation();
      solveIk();
    },

    /** Flat [x,y,z] × 3 joints × 6 legs in WORLD space, in the order the shader's uniforms expect. */
    joints(out = []) {
      out.length = 0;
      for (const leg of legs) {
        for (const p of leg.chain.points) out.push(p.x, p.y, p.z);
      }
      return out;
    },

    /**
     * The same joints in UNIT AUTHORED space — the frame the shader's primitives are written in.
     *
     * `unit = BODY_PIVOT + Rᵀ(world − bodyPos) / scale`, which is the page's own sample transform applied
     * to the joints instead of to the ray. Doing it here rather than in the shader is what lets the field
     * evaluate the ENTIRE bug in one frame at one size: the body was always in authored space and the legs
     * were always in world space, and mixing the two is exactly the class of mistake that made the eyes
     * render as flat discs. It also means the scale is one multiply at the very end of the field rather
     * than a factor threaded through every primitive.
     *
     * The transform is a similarity, so a distance measured in unit space times `scale` is the true
     * distance — which is what keeps the march safe.
     */
    jointsUnit(out = []) {
      out.length = 0;
      const inv = 1 / state.scale;
      for (const leg of legs) {
        for (const p of leg.chain.points) {
          _clampScratch.copy(p).sub(body.pos).applyMatrix3(_inv).multiplyScalar(inv);
          out.push(
            _clampScratch.x + BODY_PIVOT[0],
            _clampScratch.y + BODY_PIVOT[1],
            _clampScratch.z + BODY_PIVOT[2],
          );
        }
      }
      return out;
    },


    /** How far any foot is from the dome it is supposed to be standing on. A diagnostic, not a guess. */
    worstFootError() {
      let worst = 0;
      for (const leg of legs) {
        if (leg.stepping) continue;
        const want = state.ground(leg.end.x, leg.end.z) + footClearance;
        worst = Math.max(worst, Math.abs(leg.end.y - want));
      }
      return worst;
    },
  };
}
