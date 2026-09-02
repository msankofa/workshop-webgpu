// Walking a Pokemon Stadium model that has no walk cycle.
//
// Stadium's models carry idle, attacks, faint and entrance — nothing that travels, because a Pokemon in
// Stadium stands on a battle platform. Follower Pokemon and ambient wild mobs both need locomotion that
// was never in the ROM, so this module drives the legs procedurally from `creature-locomotion.js` — the
// same gait scheduler, foot scan, support polygon and analytic two-bone solve the sim and the SDF bug demo
// use — and retargets the result onto whichever bones `stadium-rig-map.js` identified as legs.
//
// THE ONE THING THAT MAKES THIS DIFFERENT from every other rig this locomotion code has driven: a Stadium
// bone's ORIGIN IS NOT ITS JOINT. A Rattata hind leg's four pivots sit within two units of the body centre
// while their geometry stands eleven units away on the floor. Setting a bone's rotation therefore does NOT
// swing its segment about the joint a viewer sees — it swings it about a point inside the body, and the leg
// comes apart at the seams.
//
// So the retarget does not write rotations. It writes each leg segment's WORLD MATRIX directly: solve where
// the segment should be, then set the bone's local transform to whatever puts its rest geometry exactly
// there. Two consequences worth knowing:
//
//   - Translation is written as well as rotation. That is in-domain rather than a liberty — the ROM's own
//     clips animate translation, rotation and scale channels on these same bones.
//   - Skinning here is RIGID (every vertex has one bone at weight 1.0, verified across all 151 species), so
//     placing a bone places its geometry exactly, with no deformation to get wrong.
//
// The legs are procedural; everything else — spine, head, tail, ears — is left free, so a caller can run a
// ROM clip (the idle is the obvious one) on those bones at the same time and get a creature that walks with
// its own animation playing on top.

import { createCreatureLocomotion, GAITS, cloneGait, LOCOMOTION, lerp, clamp } from './creature-locomotion.js';

/**
 * Scale a gait to a creature of a different size, by Froude similarity rather than by multiplying.
 *
 * Lengths go as `s`, but times and speeds do not, because gravity does not scale with the animal:
 * holding v^2/(gL) constant gives speed and time as sqrt(s) and angular rate as 1/sqrt(s). This is why
 * small animals look frantic and large ones ponderous, and why a gait scaled in space but not in time
 * reads as a shrunken elephant. `demos/bug-rig.js` carries the same rule as `scaleBugGait` with the
 * measurements behind it; this is the quadruped copy, kept local so a root module does not import a demo.
 */
export function scaleGaitFroude(gait, s) {
  if (!(s > 0)) throw new Error('scaleGaitFroude needs a positive scale');
  const t = Math.sqrt(s);
  const g = cloneGait(gait);
  for (const k of ['stepLift', 'scanHeight', 'scanDepth', 'scanGrid', 'restepEpsilon']) {
    if (g[k] != null) g[k] *= s;
  }
  for (const k of ['stationaryTrigger', 'movingTrigger', 'comfort']) {
    if (g[k]) { g[k].h *= s; g[k].v *= s; }
  }
  g.maxSpeed *= t;
  g.stepDuration *= t;
  g.samePairCooldown *= t;
  g.crossPairCooldown *= t;
  g.turnSpeed /= t;
  return g;
}

/** The leg span `GAITS.walk` was authored for: the stock sim creature's femur is 0.58 m, over two bones. */
const REFERENCE_LEG_SPAN = 1.16;

export const WALKER_DEFAULTS = {
  // How tall the creature stands in world units, measured over the model's whole vertical extent. Stadium
  // models are authored around 25 to 70 units tall, so something has to set the scale; a metre-ish default
  // keeps the gait constants in the range they were tuned in.
  worldHeight: 0.5,
  // Foot clearance above the ground. Zero because the mapper's foot joint is already the SOLE — the
  // contact patch of the lowest fifth of the foot's vertices — rather than the ankle.
  footGround: 0.0,
  // Fore/aft swing limit, in radians from the leg's authored direction. Same role as `BUG_LEG_LIMITS.swing`.
  swingLimit: Math.PI / 5,
  // Footholds are placed inside the limit rather than at it, so a leg is not triggered to step the instant
  // it lands. `bug-rig.js` measured what happens without this margin: every leg wants to step at once and
  // the scheduler vetoes all of them.
  placeMargin: 0.7,
  // And footholds are placed inside the reach limit for the same reason: a foot planted exactly at full
  // stretch has nowhere to go as the body walks over it.
  //
  // 0.70 rather than the 0.92 this started at, and the 0.92 was the mistake: it sat ABOVE `reachStress`
  // below, so a foot could be placed at 92% of the reach limit and be flagged as overextended at 90% on
  // the very next frame — every fresh foothold was born already asking to step. Swept across the shipped
  // models, dropping it to 0.70 takes dragging from 3 species to 2, drawn feet straying more than 5% of a
  // leg from 3.65% of planted frames to 0.69%, and makes strides LONGER (33% of leg span against 29%),
  // because a leg that is not stuck reaching covers more ground than one that is.
  reachMargin: 0.70,
  // How much of the reach limit a PLANTED foot may use before it asks to step. Must stay above
  // `reachMargin` — see there.
  reachStress: 0.9,
  // How straight a leg may get. Past this a two-bone leg stops reading as having a knee.
  maxExtension: 0.99,
  // And how straight the tightest leg may be STANDING, which is what sets the ride height: below full
  // stretch by enough that the leg has an arc left to swing through.
  standExtension: 0.90,
  // How far a foot must be from its target before the leg may step, as a fraction of this creature's own
  // stride envelope. MEASURED, not chosen: swept 0.02 to 5 across the fourteen shipped models, dragging
  // holds at 11-13 species out of 14 below 0.7 and falls off a cliff to 4 at 1.2, where it stays. Below
  // one envelope the leg re-places its foot before the body has walked it back through the envelope, so
  // the foot lives at the FRONT edge — the part of the stride where the leg is longest — and rides its
  // reach limit the whole time. Half of all planted frames were past full extension at 0.15.
  restepFraction: 1.2,
  // How far a planted foot may sit from where the gait thinks it is, in leg spans. Must equal `GAIT_LIMITS.strayFraction`.
  strayLimit: 0.05,
  // What to do about a strayed foot: off | slow | restep | accept. Only `slow` helps — `docs/subsystems/stadium.md`.
  strayMode: 'off',
  // Forced re-steps before a leg accepts instead, so an unreachable target cannot loop forever.
  strayRetries: 2,
  // How a foot supports the body: point | patch. `patch` uses the SDF foot proxy — `docs/subsystems/stadium.md`.
  footContact: 'point',
  // Shrinks or grows the patch about its own centre, for a foot bone that owns more than a foot.
  footPatchScale: 1,
  physics: {
    GRAV: LOCOMOTION.GRAV, KP: LOCOMOTION.KP, KD: LOCOMOTION.KD,
    H_DRAG: LOCOMOTION.H_DRAG, BOUNCE: LOCOMOTION.BOUNCE,
    DRIVE: 8.0, FIXED: 1 / 60, MAX_SUBSTEPS: 5,
  },
};

/**
 * Build a walker for one mapped model.
 *
 * `scene` is the loaded glTF scene (a THREE.Object3D). It is re-parented into a container the walker owns
 * and returns as `object`; the caller adds that to its scene. `map` is `mapStadiumRig`'s output.
 * `terrainHeight(x, z)` is any single-valued height function, in world units.
 */
export function createStadiumWalker({
  THREE,
  scene,
  map,
  terrainHeight = () => 0,
  gait = GAITS.walk,
  worldHeight = WALKER_DEFAULTS.worldHeight,
  footGround = WALKER_DEFAULTS.footGround,
  swingLimit = WALKER_DEFAULTS.swingLimit,
  maxExtension = WALKER_DEFAULTS.maxExtension,
  standExtension = WALKER_DEFAULTS.standExtension,
  placeMargin = WALKER_DEFAULTS.placeMargin,
  reachMargin = WALKER_DEFAULTS.reachMargin,
  reachStress = WALKER_DEFAULTS.reachStress,
  restepFraction = WALKER_DEFAULTS.restepFraction,
  strayLimit = WALKER_DEFAULTS.strayLimit,
  strayMode = WALKER_DEFAULTS.strayMode,
  strayRetries = WALKER_DEFAULTS.strayRetries,
  footContact = WALKER_DEFAULTS.footContact,
  footPatchScale = WALKER_DEFAULTS.footPatchScale,
  uprightSupport = null,
  physics = WALKER_DEFAULTS.physics,
  roamRadius = 6,
  rng = Math.random,
} = {}) {
  if (!THREE?.Vector3) throw new Error('createStadiumWalker needs { THREE }');
  if (!map?.legs?.length) throw new Error('createStadiumWalker needs a map with legs');

  const loco = createCreatureLocomotion({ THREE });
  const {
    createLegSolver, solveTwoBone, clampLegTarget, rotateXZ,
    cacheLegPartners, scheduleSteps, startStep, advanceLeg, bodySupport, orientFromFeet,
  } = loco;

  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

  // --- scale ---------------------------------------------------------------------------------------
  // One number converts the model's authored units into world units; everything below is world.
  const unitScale = worldHeight / map.units.height;
  // Scaled off the SHORTEST leg, not the longest or the average. The gait's stride and comfort box are
  // fractions of a leg, and every leg gets the same ones; sizing them to a Rattata's long hind legs asks
  // its short front legs for footholds 20 mm beyond their reach, and a leg that cannot reach its foothold
  // straightens instead.
  const legSpanWorld = Math.min(...map.legs.map(l => l.span)) * unitScale;
  // ...and the LONGEST leg, for the one constraint that runs the other way. Reach is limited by the
  // shortest leg, because a foothold the short leg cannot make is a foothold nobody can use. Timing is
  // limited by the longest, because a longer pendulum swings slower, so it is the long leg that decides
  // how briefly a step may last. Sizing the step-duration floor off the short leg let Growlithe, whose
  // legs differ by 44% in span, cycle at a stride number of 0.60 against a 0.50 ceiling.
  const legSpanLongest = Math.max(...map.legs.map(l => l.span)) * unitScale;
  // HOW HIGH THIS ANIMAL MAY RIDE, AND HOW FAR IT MAY STEP — both read off its own rest pose rather than
  // assumed, because the assumption baked into `GAITS.walk` does not hold for these models.
  //
  // The stock gait sizes a stride as a fraction of LEG LENGTH and lifts the body 8% while moving. That is
  // free on the sim's own creature, whose legs are well bent standing still. It is not free here: Rattata
  // is posed with its forelegs 97% EXTENDED, so a leg-length-sized foothold sits far outside the annulus
  // two bones can actually cover, and the drawn foot ends up as much as two-thirds of a leg away from the
  // foot the gait believes it planted.
  //
  // Two numbers come out of the rest pose and fix it:
  //
  //   `heightScale` — the tightest leg must sit at `standExtension` rather than at full stretch, which for
  //     a straight-legged model means the body settles a little. A real quadruped does exactly this when
  //     it starts walking; a stiff-legged one cannot swing its legs at all.
  //   `strideEnvelope` — with the body at that height, how far a foot may move horizontally from its rest
  //     position before the leg runs out. That, not leg length, is what the comfort box and step triggers
  //     are worth.
  const restHeight = (map.bodyCentroid.y - map.units.floorY) * unitScale;
  const legEnvelope = map.legs.map(l => ({
    span: (l.l1 + l.l2) * unitScale,
    drop: (l.hip.y - l.foot.y) * unitScale,
    horiz: Math.hypot(l.hip.x - l.foot.x, l.hip.z - l.foot.z) * unitScale,
  }));

  // EVERY KNOB LIVES HERE, and `retune()` re-derives the gait from them without rebuilding the rig. They
  // were constructor arguments first, which put the whole set out of reach of a viewer — and these are
  // exactly the numbers that have to be draggable, because most of them interact: raising
  // `standExtension` shrinks the stride envelope, which lowers the top speed, which changes how far a
  // planted foot drifts before its leg is rescued.
  const tuning = {
    standExtension, maxExtension, swingLimit, placeMargin, reachMargin, reachStress, restepFraction,
    strayLimit, strayMode, strayRetries,
    footContact, footPatchScale,
    footGround, roamRadius, base: gait,
    // Deliberate overrides ON TOP of the derived values, for pulling a model away from what its own
    // geometry implies. 1 means "whatever was derived".
    speedScale: 1, stepDurationScale: 1, stepLiftScale: 1, strideScale: 1,
    // TWO FLOORS UNDER THE STEP DURATION, both of which the Froude scaling on its own walks straight
    // through on models this small. They exist because a step here comes out at three to seven RENDERED
    // FRAMES: `advanceLeg` lerps the foot along its arc and adds a half-sine lift, and with 2.8 frames of
    // gallop the whole arc is two interior samples. What gets drawn is a triangular spike, and it reads
    // as a leg teleporting rather than swinging — which is exactly what it is, at that sample rate.
    //
    // `strideNumberMax` is the biomechanical one. A leg is a pendulum, so its natural rate goes as the
    // square root of length over gravity, and stride frequency x sqrt(span/g) is the dimensionless number
    // that makes rates comparable across models differing threefold in size. Real animals sit around
    // 0.2-0.4 walking and up to about 0.6 at a gallop. Measured here, walk lands at 0.25-0.54 and gallop
    // at 0.68-1.00 — gallop is off the top of the biological range, and that is the same fact as the
    // three-frame step.
    strideNumberMax: 0.5,
    // How many feet should stay down. Walking a quadruped keeps three; a paired gait cannot be reduced to
    // one airborne foot without splitting the pair and permanently stranding its follower. In that case
    // the structural pair wins and `uprightSupport` handles the two-foot support line.
    supportPolygonFloor: 3,
    // ...and the perceptual one, which does not scale, because the eye does not. Below roughly a tenth of
    // a second a limb reads as having jumped however small the animal is, and no amount of correct
    // pendulum physics fixes that. Also the frame-rate floor in disguise: 0.1 s is six frames at 60 Hz,
    // which is the fewest an eased arc survives.
    minStepSeconds: 0.10,
    // How much of the body may be airborne at once, scaling the gait's own fraction. This is the number
    // that decides whether tapping is even POSSIBLE: with one leg of four allowed up, no leg can be
    // airborne more than a quarter of the time, so no leg can have a stance short enough to tap however
    // the other knobs are set. Raising it is how the sweep reaches the tapping regime at all.
    concurrentScale: 1,
    // The turn-taking cooldowns, scaled together. They hold a fixed ratio to `stepDuration` through
    // Froude scaling, so a leg cannot re-step until its partners have had their turn. Together with
    // `concurrentScale` and `restepFraction` these are the gait's three independent sources of
    // hysteresis, and the sweep needs to be able to switch each off to find out which one is load-bearing.
    cooldownScale: 1,
    // How far past the gait's own top speed the support normal may push the body sideways before its
    // horizontal component fades out. See the support block in `fixedStep`. Swept 0.25 to unbounded: on
    // the two species that overspeed, clamped planted frames go 60% unbounded, 62% at 1.5, 6% at 0.5,
    // 4% at 0.25, while the twelve healthy ones do not move at all. Tight, because the thing being
    // bounded is an artefact and the creatures that never hit the bound cannot tell it is there.
    supportPushLimit: 0.5,
    // See the support-normal block in `fixedStep`. Fully on for two legs, which can never form a support
    // polygon at all, and half on above that. Half rather than zero because two of ten shipped quadrupeds
    // — Seel and Sandslash, both splay-limbed — otherwise walk at 64% and 79% of their own ride height;
    // half rather than one because letting an overreaching creature topple is a real feature of the sim's
    // support model, and 0 restores it exactly.
    // A biped and a paired gait both spend their working phase on a line between two feet. A static
    // support polygon has no interior there; full upright support supplies the ankle/body control the
    // kinematic gait does not simulate and prevents its support normal from shoving travel sideways.
    uprightSupport: uprightSupport ?? (map.legs.length <= 2 || gait.rowPairSteps ? 1 : 0.5),
  };

  const state = {
    unitScale, legSpanWorld, restHeight, tuning,
    terrainHeight,
    physics: { ...physics, BODY_MIN_CLEAR: map.rideHeight * unitScale * 0.35 },
    gait: null, heightScale: 1, strideEnvelope: 0,
    elapsed: 0, bodyTravel: 0,
    // Stray-gate counters, since page load. `strayFrames` counts planted FRAMES past the limit; the other
    // two count actions taken. Rates are the caller's job.
    landings: 0, strayFrames: 0, strayForced: 0, strayAccepted: 0, strayThrottled: 0,
    // Support-polygon counters. `supportedFrames` is when the polygon had an interior at all, which on a
    // biped standing on point-feet is never — that degeneracy is what the contact patch is for.
    contactCount: 0, haveSupport: false, comInside: false,
    supportFrames: 0, supportedFrames: 0, comInsideFrames: 0,
    bodyClearance: 0, belowMinimumClearanceFrames: 0,
    droppedTimeFrame: 0, droppedTimeTotal: 0, substepCapHits: 0, maxInputDt: 0,
  };

  /**
   * Turn the knobs into a gait, using this model's own rest pose.
   *
   * Four of `GAITS.walk`'s numbers are replaced, because it is authored for a metre-tall creature with
   * well-bent legs and neither holds here:
   *
   *   `heightScale`    settle the body until the tightest leg is at `standExtension` rather than at full
   *                    stretch — Rattata's forelegs are 97% extended standing still and cannot swing at
   *                    all until it does.
   *   `strideEnvelope` how far a foot may move horizontally from its rest position at that height before
   *                    the leg runs out. This, not leg length, is what a stride is worth.
   *   `maxSpeed`       a body travels only as fast as its feet get picked up and put down.
   *   `lookAhead`      land the foot at the FRONT of its envelope, so it has the whole envelope to give
   *                    back as the body walks over it.
   */
  function deriveTuning() {
    const t = tuning;
    const heightScale = Math.min(1, ...legEnvelope.map(({ span, drop, horiz }) => {
      const reach = Math.sqrt(Math.max(0, (t.standExtension * span) ** 2 - horiz ** 2));
      return 1 + (reach - drop) / Math.max(1e-9, restHeight);
    }));
    const strideEnvelope = Math.min(...legEnvelope.map(({ span, drop, horiz }) => {
      const droppedTo = drop + (heightScale - 1) * restHeight;
      return Math.sqrt(Math.max(0, (t.maxExtension * span) ** 2 - droppedTo ** 2)) - horiz;
    })) * t.strideScale;

    const sized = scaleGaitFroude(t.base, legSpanWorld / REFERENCE_LEG_SPAN);
    sized.stepDuration *= t.stepDurationScale;

    // The step-duration floors. They go in ahead of the top speed and the trigger sizing, both of which
    // read `stepDuration`, so that everything downstream describes the gait that will actually run.
    //
    // A leg's cycle is `stepDuration x legCount / concurrent`, so its stride frequency is the inverse of
    // that, and holding the dimensionless frequency under `strideNumberMax` is a floor on the duration.
    // Note this is the frequency the SCHEDULER would allow, not the one it achieves: the cooldowns and
    // the concurrency cap mean legs do not always take their turn the instant it comes up, and measured
    // rates run about 60% of this. The default is set from the measurement rather than from the formula.
    sized.stepLift *= t.stepLiftScale;
    sized.maxConcurrentFraction = clamp(sized.maxConcurrentFraction * t.concurrentScale, 0.01, 1);
    // Applied AFTER `concurrentScale`, so it is the last word — and only where enough legs exist for it
    // to mean anything. A biped can never keep three feet down and is held up by `uprightSupport` instead.
    if (t.supportPolygonFloor > 0 && map.legs.length > t.supportPolygonFloor) {
      let allowedLegs = map.legs.length - t.supportPolygonFloor;
      if (sized.rowPairSteps) allowedLegs = Math.max(2, allowedLegs);
      const allowed = allowedLegs / map.legs.length;
      sized.maxConcurrentFraction = Math.min(sized.maxConcurrentFraction, allowed);
    }
    const concurrentLegs = Math.max(1, Math.floor(map.legs.length * sized.maxConcurrentFraction));
    const pendulum = Math.sqrt(Math.max(1e-9, legSpanLongest / 9.81));
    const byPendulum = t.strideNumberMax > 1e-9
      ? (concurrentLegs / map.legs.length) * pendulum / t.strideNumberMax : 0;
    const beforeFloor = sized.stepDuration;
    sized.stepDuration = Math.max(sized.stepDuration, byPendulum, t.minStepSeconds);
    // The cooldowns hold a fixed ratio to the step duration through Froude scaling, and that ratio is the
    // turn-taking: a leg may not re-step until its partners have had theirs. Stretching the step without
    // stretching them would quietly hand back hysteresis the floor was not meant to touch.
    const floorStretch = sized.stepDuration / Math.max(1e-9, beforeFloor);
    sized.samePairCooldown *= t.cooldownScale * floorStretch;
    sized.crossPairCooldown *= t.cooldownScale * floorStretch;
    sized.stationaryHeight = Math.min(sized.stationaryHeight, heightScale);
    sized.movingHeight = Math.min(sized.movingHeight, heightScale);
    if (strideEnvelope > 0) {
      // The trigger sits INSIDE the envelope. `comfort` is deliberately NOT clamped to it: comfort is the
      // "this leg is overextended, slow the whole body to 28%" flag, one leg tripping it slows everything,
      // and with an envelope this small some leg trips it almost always — the creature then crawls at a
      // third of its speed while its feet are working perfectly. The hard bounds elsewhere do that job.
      sized.movingTrigger.h = Math.min(sized.movingTrigger.h, strideEnvelope * 0.6);
      sized.stationaryTrigger.h = Math.min(sized.stationaryTrigger.h, strideEnvelope * 0.3);

      // Each leg covers two envelopes of ground per cycle, and a cycle is as long as it takes every leg
      // to get its turn — `maxConcurrentFraction` caps how many are airborne at once. The 0.8 is the part
      // of the envelope a stride actually uses: the foot lands short of the front edge, and the body keeps
      // moving during the step itself. Left at the Froude speed, Rattata's body travelled 27 mm during a
      // 20 mm step and dragged its own planted feet.
      const concurrent = Math.max(1, Math.floor(map.legs.length * sized.maxConcurrentFraction));
      const cycleTime = sized.stepDuration * map.legs.length / concurrent;
      sized.maxSpeed = Math.min(sized.maxSpeed, 0.8 * 2 * strideEnvelope / cycleTime);
      sized.lookAhead = (strideEnvelope * 0.8) / (3 * Math.max(1e-9, sized.movingTrigger.h));

      // THE ONE THAT WAS SILENTLY WRONG FOR EVERY MODEL. `canWalkLegMove` refuses to start a step whose
      // target is within `restepEpsilon` of the foot — a "you are already there, do not bother" guard —
      // and it defaults to a flat 0.1 m, sized for a creature with a 0.58 m femur. Rattata's entire
      // stride envelope is 20.5 mm, so the guard was five envelopes wide: no leg could step until the
      // body had dragged it 100 mm, which is most of a leg. Measured across the shipped models, eight of
      // fourteen had a median step travel of 100-104 mm whatever their size, which is the guard's number
      // and not any property of the animal.
      //
      // It is also the gait's ONLY hysteresis, which is why it cannot simply be deleted. Making it small
      // lets a leg re-step the instant it lands; making it large drags the feet. `restepFraction` is
      // where on that trade this creature sits, as a fraction of its own stride envelope.
      sized.restepEpsilon = strideEnvelope * t.restepFraction;
    }
    // Applied last, and deliberately outside the derivation: this is the knob that BREAKS the
    // relationship above, so that what breaks is visible. Push it past 1 and the feet start dragging.
    sized.maxSpeed *= t.speedScale;

    state.gait = sized;
    state.heightScale = heightScale;
    state.strideEnvelope = strideEnvelope;
    return sized;
  }
  deriveTuning();

  // --- objects -------------------------------------------------------------------------------------
  // The container is what the sim moves, so its origin has to be the point the sim thinks it is moving:
  // the BODY CENTROID. A Stadium model's own origin is the floor between its feet, so parenting it
  // straight in would lift the whole animal by a body height and leave its feet reaching down at targets
  // it could never reach. The inner offset below is what puts the centroid on the container's origin.
  //
  // The same offset carries the facing correction, for the handful of models whose head does not point
  // down +z.
  const container = new THREE.Group();
  container.name = 'stadium-walker';
  const yawOffset = map.forward.axis === 'z'
    ? (map.forward.sign > 0 ? 0 : Math.PI)
    : (map.forward.sign > 0 ? -Math.PI / 2 : Math.PI / 2);
  scene.scale.multiplyScalar(unitScale);
  scene.quaternion.setFromEuler(new THREE.Euler(0, yawOffset, 0));
  scene.position
    .set(-map.bodyCentroid.x * unitScale, -map.bodyCentroid.y * unitScale, -map.bodyCentroid.z * unitScale)
    .applyQuaternion(scene.quaternion);
  container.add(scene);

  const byName = new Map();
  scene.traverse(o => { if (o.name) byName.set(o.name, o); });
  const objectOf = (nodeId) => {
    const o = byName.get(map.names[nodeId]);
    if (!o) throw new Error(`rig map names node ${nodeId} as ${map.names[nodeId]}, which is not in the scene`);
    return o;
  };

  // --- legs ----------------------------------------------------------------------------------------
  //
  // Row and side become the scheduler's `phase` by the sim's own formula, which is what produces a
  // quadruped's diagonal pairs: front-left steps with hind-right.
  const bodyCentroid = V(map.bodyCentroid.x, map.bodyCentroid.y, map.bodyCentroid.z).multiplyScalar(unitScale);
  const legs = map.legs.map((L, i) => {
    const s = unitScale;
    const attachInv = new THREE.Matrix4().fromArray(map.restWorld[L.attach]).invert();
    const hip = V(L.hip.x, L.hip.y, L.hip.z).multiplyScalar(s);
    const knee = V(L.knee.x, L.knee.y, L.knee.z).multiplyScalar(s);
    const foot = V(L.foot.x, L.foot.y, L.foot.z).multiplyScalar(s);
    const jointBones = L.jointBones || L.bones;
    const upper = jointBones.slice(0, L.kneeIndex);
    const lower = [...jointBones.slice(L.kneeIndex), ...L.bones.filter(b => !jointBones.includes(b))];
    const restChord = V().subVectors(foot, hip).normalize();
    const restPole = V().subVectors(knee, hip);
    restPole.addScaledVector(restChord, -restPole.dot(restChord));
    if (restPole.lengthSq() < 1e-12) restPole.set(L.pole.x, L.pole.y, L.pole.z);
    restPole.normalize().applyQuaternion(scene.quaternion);
    const diagnosticUpper = upper[0];
    const diagnosticLower = lower[lower.length - 1];
    const pointInBone = (nodeId, point) => V(point.x, point.y, point.z)
      .applyMatrix4(new THREE.Matrix4().fromArray(map.restWorld[nodeId]).invert());
    return {
      index: i, row: L.row, side: L.side,
      phase: (L.row + (L.side > 0 ? 1 : 0)) % 2,
      primary: L.row === 0,
      // Body-local rest positions: the hip the leg hangs from, and the foothold it stands on.
      // Body-local, in the frame the SIM works in — which is the model frame turned by `yawOffset` so
      // that the creature's nose points down +z like every other body this locomotion code drives.
      attachmentLocal: hip.clone().sub(bodyCentroid).applyQuaternion(scene.quaternion),
      restLocal: V(foot.x - bodyCentroid.x, 0, foot.z - bodyCentroid.z).applyQuaternion(scene.quaternion),
      restDirLocal: V(L.restDir.x, 0, L.restDir.z).applyQuaternion(scene.quaternion),
      poleLocal: V(L.pole.x, L.pole.y, L.pole.z).applyQuaternion(scene.quaternion),
      restPoleLocal: restPole,
      poleSource: L.poleSource ?? 'unknown',
      poleConfidence: Number.isFinite(L.poleConfidence) ? L.poleConfidence : 0,
      l1: L.l1 * s, l2: L.l2 * s, span: L.span * s,
      // TWO COPIES OF THE SAME THREE POINTS, in two different spaces, and mixing them up is the easy
      // mistake here. The locomotion sim works in world units, so `attachmentLocal`/`restLocal` above are
      // scaled. The retarget instead works RELATIVE TO THE ATTACH BONE — the shoulder or hip the leg hangs
      // off — so these are the rest joints expressed in that bone's own frame, in model units.
      //
      // Relative to the attach bone rather than to the model, because the attach bone MOVES. It is a spine
      // bone, and the whole point of leaving the spine free is that a ROM clip can play on it while the
      // legs walk; anchoring the leg to the model's rest pose would leave it hanging in the air the moment
      // the idle animation breathed.
      hipLocal: V(L.hip.x, L.hip.y, L.hip.z).applyMatrix4(attachInv),
      kneeLocal: V(L.knee.x, L.knee.y, L.knee.z).applyMatrix4(attachInv),
      footLocal: V(L.foot.x, L.foot.y, L.foot.z).applyMatrix4(attachInv),
      // And each driven bone's rest pose in the same frame.
      restRelAttach: new Map(L.bones.map(b => [b,
        new THREE.Matrix4().multiplyMatrices(attachInv, new THREE.Matrix4().fromArray(map.restWorld[b]))])),
      upper, lower, jointBones, attach: L.attach,
      // Rest points in the two drawn bone frames. After retargeting these reveal whether the matrices a
      // viewer sees still meet at the knee and preserve the two solved lengths.
      diagnosticUpper, diagnosticLower,
      hipInUpper: pointInBone(diagnosticUpper, L.hip),
      kneeInUpper: pointInBone(diagnosticUpper, L.knee),
      kneeInLower: pointInBone(diagnosticLower, L.knee),
      footInLower: pointInBone(diagnosticLower, L.foot),
      // Carried for the overlay and for an ankle that does not exist yet: `lower` still runs knee to sole
      // as one rigid group, so the foot cannot articulate and the sole pitches with the shank.
      footBones: L.footBones || [], ankleIndex: L.ankleIndex ?? null,
      // The contact patch, and the frame it was measured in. `contacts` is what `bodySupport` reads.
      footProxy: L.footProxy || null,
      footFrame: L.footFrame ?? null,
      restInvFoot: L.footFrame != null && map.restWorld[L.footFrame]
        ? new THREE.Matrix4().fromArray(map.restWorld[L.footFrame]).invert() : null,
      patch: (L.footProxy?.samples || []).map(() => V()),
      contacts: null,
      // Live state the locomotion module reads and writes.
      hipWorld: V(), kneeWorld: V(), drawnFoot: V(), drawnPrev: V(), drawnValid: false,
      renderedHip: V(), renderedKneeUpper: V(), renderedKneeLower: V(), renderedFoot: V(),
      poleWorld: V(), bendSign: 0, kneeAngle: 0, kneeAngleDelta: 0, kneeAngleValid: false,
      upperLengthError: 0, lowerLengthError: 0,
      jointContinuityError: 0, jointContinuityRelative: 0, renderedGroundError: null,
      end: foot.clone(), target: foot.clone(), groundPosition: foot.clone(),
      stepStart: foot.clone(), stepEnd: foot.clone(),
      lookAhead: V(), scanStart: V(), scanEnd: V(),
      targetGrounded: true, stepping: false, t: 0,
      // Stray gate. Set in the fixed step, consumed in `applyPose` where the drawn foot exists.
      justLanded: false, forceStep: false, strayTries: 0, strayNow: 0, strayFlag: false,
      // Named diagnostic causes. These do not participate in movement; they record the decisions the
      // walker already makes so a caller can tell terrain, reach, scheduling and retry failures apart.
      terrainMisses: 0, terrainMissNow: false,
      reachClamps: 0, reachClampedNow: false,
      schedulerWaitFrames: 0, schedulerWaitCurrent: 0, schedulerWaitMax: 0,
      schedulerStarvations: 0, schedulerWaiting: false, schedulerStarved: false,
      forcedResteps: 0, forcedRestepNow: false,
      exhaustedResteps: 0, retryExhaustedNow: false,
      timeSinceBeginMove: 999, timeSinceStopMove: 999,
      canMove: false, wants: false, uncomfortable: false,
      restX: foot.x, restY: foot.y, restZ: foot.z,
    };
  });
  cacheLegPartners(legs);

  let solver = createLegSolver({ terrainHeight: state.terrainHeight, footGround: tuning.footGround });

  /**
   * Re-derive everything the knobs control, in place — the creature keeps walking, only the numbers
   * change. The ground function and the base gait go through here too, because both are baked into
   * things that are otherwise built once.
   */
  function retune(patch = {}) {
    const { terrainHeight: ground, ...rest } = patch;
    if (ground) state.terrainHeight = ground;
    Object.assign(tuning, rest);
    deriveTuning();
    solver = createLegSolver({ terrainHeight: state.terrainHeight, footGround: tuning.footGround });
    return state;
  }

  // --- body ----------------------------------------------------------------------------------------
  const bodyHeight = (map.bodyCentroid.y - map.units.floorY) * unitScale;
  const body = {
    // Spawned at the SETTLED height, not the rest height. Starting at the rest height puts every leg at
    // full stretch on frame one, the forced lift below then picks feet up to fix it, and the creature
    // spends its first five seconds recovering from a pose it was born into.
    pos: V(0, bodyHeight * state.gait.stationaryHeight, 0), vel: V(), yaw: 0,
    pitch: 0, roll: 0, preferredPitch: 0, preferredRoll: 0,
    desiredDir: V(0, 0, 1),
    bodyHeight,
    commandedSpeed: 0,
  };
  // Feet start under the body wherever it stands, or the first frame solves every leg from a target
  // the width of the map away. Also the way to move a creature: `placeAt` re-seeds feet with the body.
  function seedFeet() {
    for (const leg of legs) {
      rotateXZ(leg.restLocal, body.yaw, leg.end);
      leg.end.add(body.pos).setY(state.terrainHeight(leg.end.x, leg.end.z) + tuning.footGround);
      leg.target.copy(leg.end); leg.groundPosition.copy(leg.end);
      leg.stepStart.copy(leg.end); leg.stepEnd.copy(leg.end);
      leg.stepping = false;
    }
  }
  function placeAt(x, z, yaw = body.yaw) {
    body.pos.x = x; body.pos.z = z; body.yaw = yaw; body.vel.set(0, 0, 0);
    seedFeet();
  }
  seedFeet();

  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _rot = new THREE.Matrix3();
  const _inv = new THREE.Matrix3();
  const _m4 = new THREE.Matrix4();
  function refreshRotation() {
    _e.set(body.pitch, body.yaw, body.roll, 'YXZ');
    _q.setFromEuler(_e);
    _m4.makeRotationFromQuaternion(_q);
    _rot.setFromMatrix4(_m4);
    _inv.copy(_rot).transpose();
  }
  refreshRotation();

  // --- steering ------------------------------------------------------------------------------------
  const _target = V(0, 0, 1);
  const _steer = V();
  let haveTarget = false;
  function pickTarget() {
    const r = tuning.roamRadius * (0.35 + 0.6 * rng());
    const a = rng() * Math.PI * 2;
    _target.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    haveTarget = true;
  }
  function steer() {
    if (!haveTarget) pickTarget();
    const dx = _target.x - body.pos.x, dz = _target.z - body.pos.z;
    if (Math.hypot(dx, dz) < tuning.roamRadius * 0.08) pickTarget();
    if (Math.hypot(body.pos.x, body.pos.z) > tuning.roamRadius * 1.15) {
      body.desiredDir.set(-body.pos.x, 0, -body.pos.z).normalize();
      return;
    }
    body.desiredDir.set(dx, 0, dz);
    if (body.desiredDir.lengthSq() < 1e-9) body.desiredDir.set(Math.sin(body.yaw), 0, Math.cos(body.yaw));
    body.desiredDir.normalize();
  }

  // --- one fixed step ------------------------------------------------------------------------------
  const _clampScratch = V();
  function clampTargetToLimits(leg, target, reground) {
    if (tuning.swingLimit == null) return target;
    for (let pass = 0; pass < (reground ? 2 : 1); pass++) {
      _clampScratch.copy(target).sub(body.pos).applyMatrix3(_inv);
      // REACH BOUNDS PLACEMENT HERE, and `demos/bug-rig.js` reaches the opposite conclusion — worth
      // spelling out, because the difference is the body and not the code. There, clamping reach crowded
      // the feet under the bug, shrank the support polygon, and let it slide off the curved leaf; the
      // conclusion "reach is enforced in the solve alone" was measured on a dome. Two things differ. The
      // ground here is flat, so a small support polygon has nothing to slide down. And these legs have
      // almost no slack — Rattata stands with its forelegs 97% extended — so a foothold the gait sizes
      // from the leg's LENGTH lands well outside the annulus the leg can actually cover, and without this
      // clamp the drawn foot misses the gait's foot by up to two-thirds of a leg.
      clampLegTarget(leg.attachmentLocal, _clampScratch, leg.restDirLocal, leg.l1 + leg.l2, {
        maxSwing: tuning.swingLimit * tuning.placeMargin,
        maxRise: null,
        maxReach: tuning.maxExtension * tuning.reachMargin,
      });
      target.copy(_clampScratch).applyMatrix3(_rot).add(body.pos);
      if (reground) target.y = state.terrainHeight(target.x, target.z) + tuning.footGround;
    }
    return target;
  }

  /**
   * Ask a planted foot to step once it is nearly out of reach.
   *
   * Bounding where a foot MAY LAND is not enough on its own, because the body then walks and turns over
   * a foot that is already down: the hip rotates away from it while the scheduler is still refusing to
   * let it lift. `bug-rig.js` found the same thing and fixed it the same way — the limit becomes a step
   * trigger as well as a bound. Dragging the foot back inside the envelope instead would be a planted
   * foot sliding across the ground, which is the artefact everything here exists to avoid.
   */
  const _hipScratch = V();
  /** How far this leg's foot is from its hip, right now, in world units. */
  function reachOf(leg) {
    _hipScratch.copy(leg.attachmentLocal).applyMatrix3(_rot).add(body.pos);
    return _hipScratch.distanceTo(leg.end);
  }
  function flagReachStress(leg) {
    if (leg.stepping) return;
    if (reachOf(leg) > (leg.l1 + leg.l2) * tuning.maxExtension * tuning.reachStress) leg.wants = true;
  }

  /** A foot touched down. Counted in `applyStrayGate`. */
  function markLanded(leg) { leg.justLanded = true; }

  function fixedStep(h, walk, desiredSpeed = 1) {
    const g = state.gait, P = state.physics;
    const speed = Math.hypot(body.vel.x, body.vel.z);
    const speedFraction = clamp(speed / Math.max(0.001, g.maxSpeed), 0, 1);
    const targetHeight = body.bodyHeight * lerp(g.stationaryHeight, g.movingHeight, speedFraction);
    const triggerH = lerp(g.stationaryTrigger.h, g.movingTrigger.h, speedFraction);
    const triggerV = lerp(g.stationaryTrigger.v, g.movingTrigger.v, speedFraction);

    if (walk) steer();
    else body.desiredDir.set(Math.sin(body.yaw), 0, Math.cos(body.yaw));

    // Do not turn while a planted foot is already overextended — the body rotates away from a foot the
    // scheduler will not yet let step, and the leg straightens to reach it. Lifted from `bug-rig.js`,
    // where removing it was a visible defect rather than a subtlety.
    const pinned = legs.some(l => l.uncomfortable && !l.stepping);
    const steerDir = pinned ? _steer.set(Math.sin(body.yaw), 0, Math.cos(body.yaw)) : body.desiredDir;
    const desiredYaw = Math.atan2(steerDir.x, steerDir.z);
    const diff = Math.atan2(Math.sin(desiredYaw - body.yaw), Math.cos(desiredYaw - body.yaw));
    body.yaw += clamp(diff, -g.turnSpeed * h, g.turnSpeed * h);

    for (const leg of legs) {
      leg.timeSinceBeginMove += h;
      leg.timeSinceStopMove += h;
      const rest = solver.solveLegTarget(leg, g, triggerH, true, body);
      leg.terrainMissNow = !leg.targetGrounded;
      if (leg.terrainMissNow) leg.terrainMisses++;
      clampTargetToLimits(leg, leg.target, leg.targetGrounded);
      advanceLeg(leg, g, h, triggerH, triggerV, rest, markLanded);
      if (leg.strayFlag) leg.uncomfortable = true;
      flagReachStress(leg);
    }
    if (walk) scheduleSteps(legs, g);

    // A leg that is genuinely out of reach LIFTS, even if the scheduler's turn-taking says it is not its
    // turn. Wanting to step is not enough: with four legs and one airborne at a time, a stressed leg waits
    // up to three step durations for a slot, and the body keeps walking out from over it the whole while —
    // measured at 8 mm past full stretch on Rattata's short forelegs, which the solver can only answer by
    // holding the drawn foot short of the ground. Two feet are always kept down so the body still has
    // something to stand on.
    // Three feet stay down on a quadruped, not two: two grounded feet are a LINE, the support polygon
    // collapses, and `bodySupport` correctly reports it has nothing to push against — the body then sinks
    // onto its hard floor and takes seconds to climb back out.
    const minGrounded = Math.min(3, Math.max(1, legs.length - 1));
    for (const leg of legs) {
      if (leg.stepping) continue;
      if (legs.filter(l => !l.stepping).length <= minGrounded) break;
      // A landing the gate rejected goes through the same override, so a forced re-step can never take the
      // creature below its support floor. It keeps the flag if it is refused and tries again next substep.
      if (leg.forceStep || reachOf(leg) > (leg.l1 + leg.l2) * tuning.maxExtension) {
        startStep(leg);
        leg.forceStep = false;
      }
    }

    // Waiting for a partner or a support slot is ordinary gait scheduling, not a failure: the default
    // reference creatures spend most wanted frames doing exactly that. Starvation starts only when a leg
    // was ELIGIBLE (`canMove`) but was passed over for longer than a complete nominal opportunity cycle.
    const concurrent = Math.max(1, Math.floor(legs.length * g.maxConcurrentFraction));
    const opportunityCycle = g.stepDuration * legs.length / concurrent;
    for (const leg of legs) {
      leg.schedulerWaiting = !!(walk && leg.wants && leg.canMove && !leg.stepping);
      if (!leg.schedulerWaiting) {
        leg.schedulerWaitCurrent = 0;
        leg.schedulerStarved = false;
        continue;
      }
      leg.schedulerWaitFrames++;
      leg.schedulerWaitCurrent += h;
      leg.schedulerWaitMax = Math.max(leg.schedulerWaitMax, leg.schedulerWaitCurrent);
      if (!leg.schedulerStarved && leg.schedulerWaitCurrent > opportunityCycle + 1e-9) {
        leg.schedulerStarved = true;
        leg.schedulerStarvations++;
      }
    }

    const sup = bodySupport(legs, body.pos);
    state.contactCount = sup.contactCount ?? sup.groundedCount;
    state.haveSupport = sup.haveSupport;
    state.comInside = sup.comInside;
    if (sup.haveSupport) state.supportedFrames++;
    if (sup.comInside) state.comInsideFrames++;
    state.supportFrames++;

    // THE HEIGHT SPRING READS THE VELOCITY BEFORE GRAVITY IS APPLIED, and the order is not cosmetic.
    // Damping against a velocity that already contains this step's gravity impulse biases the resting
    // height upward by KD*GRAV*h/KP — 44 mm with the stock constants, whatever the creature is. On the
    // metre-tall body those constants were tuned for that is a 4% error nobody would see. On a Rattata
    // riding 142 mm off the floor it is a third of the ride height: the body floats, every leg is asked
    // for a foothold beyond its reach, and the feet trail underneath it.
    if (sup.haveNormal) {
      const preferredY = sup.cy + targetHeight;
      let mag = P.GRAV + P.KP * (preferredY - body.pos.y) - P.KD * body.vel.y;
      mag = clamp(mag, 0, P.GRAV * 4 * sup.fG);

      // WHEN THE SUPPORT POLYGON IS DEGENERATE, how much do we assume the creature can still hold itself
      // up? On three or more feet the question does not arise. On two the polygon is a line and on one it
      // is a point, and the sim's normal then runs from the foot to the centre of mass — which is nearly
      // horizontal whenever the body is low, so a body that has dropped can never push itself back up.
      // Bipeds live in that state permanently: Charizard, Pikachu and Sandshrew all sat on their hard
      // floor 100% of the time, walking on their bellies.
      //
      // A real biped holds itself up with ankle torque, which nothing here models. `uprightSupport` is
      // that torque as a single number: 1 assumes the creature can always stand, 0 is the sim's original
      // behaviour of letting it topple. It defaults to on for two legs and off for more, and it is a
      // slider because it is an ASSUMPTION rather than a derivation.
      let nx = sup.nx, ny = sup.ny, nz = sup.nz;
      if (tuning.uprightSupport > 0 && (sup.groundedCount < 3 || !sup.comInside)) {
        const k = tuning.uprightSupport;
        nx = lerp(nx, 0, k); ny = lerp(ny, 1, k); nz = lerp(nz, 0, k);
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
      }
      let ax = nx * mag, ay = ny * mag, az = nz * mag;
      // A support normal tilted past 45 degrees gets its SIDEWAYS part clamped, not the whole force
      // thrown away. The sim drops it entirely, which is survivable on four legs — the normal only tilts
      // that far in a transient — and fatal on two: a biped stands on one or two feet almost always, its
      // support polygon is a point or a line, so the normal is tilted almost always, and the creature
      // simply falls through its own legs onto the hard floor and stays there. Clamping keeps the body
      // up while still leaning it toward the feet, which is what the tilt is for.
      const lateral = Math.hypot(ax, az);
      if (lateral > ay) {
        const k = ay / Math.max(1e-9, lateral);
        ax *= k; az *= k;
      }

      // AND THE SUPPORT NORMAL IS NOT A MOTOR. Holding the body up is its whole job; the sideways part is
      // a lean, not thrust. Nothing bounded it before, and the numbers say what that is worth: the
      // magnitude is capped at 4g, the clamp above lets as much as 4g/sqrt(2) of it point sideways, and
      // against `H_DRAG` that settles at about 24 m/s — on creatures whose gait tops out near 0.1 m/s.
      // Measured, Ivysaur and Seel ran at 608% and 963% of the speed they were commanded, which no
      // arrangement of the feet can keep up with, so they clamped 63% of their planted frames and dragged.
      // Fading the sideways part out above a small multiple of the gait's own top speed still lets an
      // overreaching creature lean and topple, which is a real feature of the support model, while
      // stopping it from being launched.
      const lateralCap = g.maxSpeed * tuning.supportPushLimit;
      const horizNow = Math.hypot(body.vel.x, body.vel.z);
      if (horizNow > lateralCap) {
        const k = Math.max(0, 1 - (horizNow - lateralCap) / Math.max(1e-9, lateralCap));
        ax *= k; az *= k;
      }
      body.vel.x += ax * h; body.vel.y += ay * h; body.vel.z += az * h;
    }
    body.vel.y -= P.GRAV * h;

    const anyUncomfortable = legs.some(l => l.uncomfortable && !l.stepping);
    const commandFraction = clamp(Number.isFinite(desiredSpeed) ? desiredSpeed : 1, 0, 1);
    const wanted = walk
      ? g.maxSpeed * commandFraction * (0.35 + 0.65 * Math.max(0, Math.cos(diff)))
        * (anyUncomfortable ? g.uncomfortableSpeedMultiplier : 1)
      : 0;
    body.commandedSpeed = wanted;
    const drive = P.DRIVE * sup.fG;
    body.vel.x += (Math.sin(body.yaw) * wanted - body.vel.x) * drive * h;
    body.vel.z += (Math.cos(body.yaw) * wanted - body.vel.z) * drive * h;
    body.vel.x *= (1 - P.H_DRAG * h);
    body.vel.z *= (1 - P.H_DRAG * h);
    body.pos.addScaledVector(body.vel, h);

    const floor = state.terrainHeight(body.pos.x, body.pos.z) + P.BODY_MIN_CLEAR;
    if (body.pos.y < floor) {
      state.belowMinimumClearanceFrames++;
      body.pos.y = floor;
      if (body.vel.y < 0) body.vel.y *= -P.BOUNCE;
    }
    state.bodyClearance = body.pos.y - state.terrainHeight(body.pos.x, body.pos.z);

    orientFromFeet(legs, g, body);
    refreshRotation();
    // Kept so a debug overlay can draw the polygon the sim actually balanced on, rather than build its
    // own from the feet and quietly disagree. It is `bodySupport`'s reused object: valid until the next
    // step, which is exactly the frame anything drawing it cares about.
    state.support = sup;
    return sup;
  }

  // --- writing the pose onto the rig ---------------------------------------------------------------
  const _hipW = new THREE.Vector3(), _kneeW = new THREE.Vector3(), _footW = new THREE.Vector3();
  const _kneeSolved = new THREE.Vector3(), _poleW = new THREE.Vector3();
  const _restA = new THREE.Vector3(), _restB = new THREE.Vector3();
  const _diagAxis = new THREE.Vector3(), _diagBend = new THREE.Vector3();
  const _diagRestBend = new THREE.Vector3();
  const _diagUpper = new THREE.Vector3(), _diagLower = new THREE.Vector3();
  const _dirRest = new THREE.Vector3(), _dirNow = new THREE.Vector3();
  const _rotQ = new THREE.Quaternion();
  const _seg = new THREE.Matrix4(), _tmp = new THREE.Matrix4(), _parentInv = new THREE.Matrix4();
  const _desired = new Map();   // nodeId -> world matrix for this frame

  /**
   * Rigidly move a group of bones so that the segment `restA -> restB` lands on `nowA -> nowB`.
   *
   * The rotation is taken about `nowA`, so the group pivots at the joint a viewer sees rather than at
   * whatever arbitrary point the bone's origin happens to be. Lengths are preserved because the solver
   * hands back a `nowB` exactly one rest-length from `nowA`.
   */
  function placeGroup(leg, bones, restA, restB, nowA, nowB) {
    _dirRest.subVectors(restB, restA).normalize();
    _dirNow.subVectors(nowB, nowA).normalize();
    if (_dirRest.lengthSq() < 1e-12 || _dirNow.lengthSq() < 1e-12) return;
    _rotQ.setFromUnitVectors(_dirRest, _dirNow);
    _seg.compose(nowA, _rotQ, { x: 1, y: 1, z: 1 });
    _tmp.makeTranslation(-restA.x, -restA.y, -restA.z);
    _seg.multiply(_tmp);
    const attachWorld = objectOf(leg.attach).matrixWorld;
    for (const b of bones) {
      const rest = leg.restRelAttach.get(b);
      if (!rest) continue;
      // world = segmentTransform * (attachBoneNow * restRelativeToAttach)
      const world = new THREE.Matrix4().multiplyMatrices(attachWorld, rest);
      _desired.set(b, world.premultiply(_seg));
    }
  }

  const _patchM4 = new THREE.Matrix4();
  const _patchM3 = new THREE.Matrix3();

  /**
   * Put the foot's contact patch in world space, anchored at the gait's foothold.
   *
   * Anchored at `leg.end` rather than at the drawn foot on purpose: the patch then only ever changes the
   * SIZE of the support polygon, never where it sits, so turning it on cannot reopen the foot-drag
   * question the stray gate's `accept` mode already lost. Orientation comes from the live foot bone, so a
   * foot that pitches with the shank tilts its patch with it.
   */
  function updateContactPatch(leg) {
    const p = leg.footProxy;
    if (tuning.footContact !== 'patch' || !p?.ok || !leg.restInvFoot) { leg.contacts = null; return; }
    const world = _desired.get(leg.footFrame) ?? objectOf(leg.footFrame)?.matrixWorld;
    if (!world) { leg.contacts = null; return; }
    _patchM4.multiplyMatrices(world, leg.restInvFoot);
    _patchM3.setFromMatrix4(_patchM4);
    // Defaulted rather than trusted: `tuning` is a hand-listed literal, so a knob added to
    // `WALKER_DEFAULTS` and not to it arrives undefined, and every contact point becomes NaN.
    const k = Number.isFinite(tuning.footPatchScale) ? tuning.footPatchScale : 1;
    for (let i = 0; i < p.samples.length; i++) {
      const o = p.samples[i];
      leg.patch[i].set(o[0] * k, o[1] * k, o[2] * k).applyMatrix3(_patchM3).add(leg.end);
    }
    leg.contacts = leg.patch;
  }

  const _bodyDrawnPrev = V();
  let _bodyDrawnValid = false;

  /**
   * Act on planted feet that are not where the gait thinks they are. Planted frames, not landings — a
   * foothold is clamped into reach before the step starts, so landings never stray. Runs in `applyPose`
   * because the drawn foot does not exist until the pose is written.
   */
  function applyStrayGate() {
    const t = tuning;
    for (const leg of legs) {
      leg.forcedRestepNow = false;
      leg.retryExhaustedNow = false;
      if (leg.justLanded) { leg.justLanded = false; state.landings++; }
      // A leg in the air has no claim to be anywhere, and lifting resets its patience.
      if (leg.stepping || !leg.targetGrounded) { leg.strayTries = 0; leg.strayFlag = false; continue; }
      if (leg.strayNow <= t.strayLimit) { leg.strayFlag = false; continue; }
      state.strayFrames++;
      if (t.strayMode === 'off') continue;
      // Sticky, because `advanceLeg` recomputes `uncomfortable` every substep and would wipe it.
      if (t.strayMode === 'slow') { leg.strayFlag = true; state.strayThrottled++; continue; }
      // Falls through to accept once the retries are spent, so an unreachable target terminates.
      if (t.strayMode === 'restep' && leg.strayTries < t.strayRetries) {
        leg.strayTries++;
        leg.forceStep = true;
        leg.forcedResteps++;
        leg.forcedRestepNow = true;
        state.strayForced++;
        continue;
      }
      if (t.strayMode === 'restep') {
        leg.exhaustedResteps++;
        leg.retryExhaustedNow = true;
      }
      // The sim balances on the feet a viewer can see. Does not stop the slide, only makes it visible.
      leg.end.copy(leg.drawnFoot);
      state.strayAccepted++;
    }
  }

  function applyPose() {
    // Body travel since the LAST pose, not since the last fixed step: the drawn feet only move when a pose
    // is written, so a skate measurement has to compare the two over the same interval.
    if (_bodyDrawnValid) state.bodyTravel = Math.hypot(body.pos.x - _bodyDrawnPrev.x, body.pos.z - _bodyDrawnPrev.z);
    else state.bodyTravel = 0;
    _bodyDrawnPrev.copy(body.pos);
    _bodyDrawnValid = true;

    container.position.copy(body.pos);
    container.quaternion.copy(_q);
    container.updateMatrixWorld(true);
    _desired.clear();

    for (const leg of legs) {
      // The hip travels with whatever the leg hangs off — the body, plus any clip playing on the spine.
      const attachWorld = objectOf(leg.attach).matrixWorld;
      _hipW.copy(leg.hipLocal).applyMatrix4(attachWorld);
      _footW.copy(leg.end);
      _poleW.copy(leg.poleLocal).applyMatrix3(_rot);
      leg.poleWorld.copy(_poleW).normalize();

      const solved = solveTwoBone(
        _hipW, _footW, _poleW, leg.l1, leg.l2, _kneeSolved, null,
        { maxExtension: tuning.maxExtension },
      );
      // `solveTwoBone` leaves the foot short of an unreachable target rather than straightening the leg,
      // so take the foot from the solved geometry rather than from the target.
      _kneeW.copy(_kneeSolved);
      const dirToFoot = _footW.clone().sub(_hipW);
      const reach = dirToFoot.length();
      const used = Math.min(reach, (leg.l1 + leg.l2) * tuning.maxExtension);
      leg.reachClampedNow = solved.clamped && reach > (leg.l1 + leg.l2) * tuning.maxExtension + 1e-9;
      if (leg.reachClampedNow) leg.reachClamps++;
      const footSolved = _hipW.clone().addScaledVector(dirToFoot.normalize(), used);

      // Which side of the rest bend the solved knee landed on. Comparing with rest geometry rather than
      // with the supplied pole is intentional: a reversed pole must read as negative, not validate itself.
      _diagAxis.subVectors(footSolved, _hipW).normalize();
      _diagBend.subVectors(_kneeW, _hipW)
        .addScaledVector(_diagAxis, -_diagBend.dot(_diagAxis));
      _diagRestBend.copy(leg.restPoleLocal).applyMatrix3(_rot)
        .addScaledVector(_diagAxis, -_diagRestBend.dot(_diagAxis));
      leg.bendSign = _diagBend.lengthSq() > 1e-12 && _diagRestBend.lengthSq() > 1e-12
        ? _diagBend.normalize().dot(_diagRestBend.normalize())
        : 0;

      _diagUpper.subVectors(_hipW, _kneeW).normalize();
      _diagLower.subVectors(footSolved, _kneeW).normalize();
      const kneeAngle = Math.acos(Math.max(-1, Math.min(1, _diagUpper.dot(_diagLower))));
      leg.kneeAngleDelta = leg.kneeAngleValid ? Math.abs(kneeAngle - leg.kneeAngle) : 0;
      leg.kneeAngle = kneeAngle;
      leg.kneeAngleValid = true;

      _restA.copy(leg.hipLocal).applyMatrix4(attachWorld);
      _restB.copy(leg.kneeLocal).applyMatrix4(attachWorld);
      placeGroup(leg, leg.upper, _restA, _restB, _hipW, _kneeW);

      _restA.copy(leg.kneeLocal).applyMatrix4(attachWorld);
      _restB.copy(leg.footLocal).applyMatrix4(attachWorld);
      placeGroup(leg, leg.lower, _restA, _restB, _kneeW, footSolved);

      // Kept for anything drawing the rig: where this frame's hip and knee ended up, in world space.
      leg.hipWorld.copy(_hipW);
      leg.kneeWorld.copy(_kneeW);
      // And the DRAWN foot, which is not `leg.end`. `solveTwoBone` clamps an unreachable target into the
      // annulus, so whenever the gait asks for a foothold the leg cannot cover, the rendered foot sits
      // short of it — and then travels with the hip while the gait believes the foot is planted. That gap
      // is the whole of foot drag, and it was being computed here and thrown away.
      if (leg.drawnValid) leg.drawnPrev.copy(leg.drawnFoot);
      leg.drawnFoot.copy(footSolved);
      if (!leg.drawnValid) { leg.drawnPrev.copy(footSolved); leg.drawnValid = true; }
      leg.reachAsked = reach;
      leg.reachUsed = used;
      // `l1 + l2`, the same span `gait-diagnostics` normalises its gap by, or the two would disagree.
      const boneSpan = leg.l1 + leg.l2;
      leg.strayNow = boneSpan > 0 ? _footW.distanceTo(footSolved) / boneSpan : 0;

      updateContactPatch(leg);
    }

    applyStrayGate();

    // Locals last, parents before children, so a driven bone under another driven bone sees the parent's
    // new world rather than its rest one.
    const ordered = [...(_desired.keys())].sort((a, b) => depthOf(a) - depthOf(b));
    for (const id of ordered) {
      const obj = objectOf(id);
      const parentWorld = obj.parent.matrixWorld;
      _parentInv.copy(parentWorld).invert();
      obj.matrix.copy(_parentInv.multiply(_desired.get(id)));
      obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
      obj.updateMatrixWorld(true);
    }

    // Measure what the scene graph now renders, separately from the analytic solution above. These four
    // points expose a matrix-retarget defect even when the solver itself returned valid geometry.
    for (const leg of legs) {
      leg.renderedHip.copy(leg.hipInUpper).applyMatrix4(objectOf(leg.diagnosticUpper).matrixWorld);
      leg.renderedKneeUpper.copy(leg.kneeInUpper).applyMatrix4(objectOf(leg.diagnosticUpper).matrixWorld);
      leg.renderedKneeLower.copy(leg.kneeInLower).applyMatrix4(objectOf(leg.diagnosticLower).matrixWorld);
      leg.renderedFoot.copy(leg.footInLower).applyMatrix4(objectOf(leg.diagnosticLower).matrixWorld);
      leg.upperLengthError = leg.l1 > 0
        ? Math.abs(leg.renderedHip.distanceTo(leg.renderedKneeUpper) - leg.l1) / leg.l1 : 0;
      leg.lowerLengthError = leg.l2 > 0
        ? Math.abs(leg.renderedKneeLower.distanceTo(leg.renderedFoot) - leg.l2) / leg.l2 : 0;
      leg.jointContinuityError = leg.renderedKneeUpper.distanceTo(leg.renderedKneeLower);
      leg.jointContinuityRelative = (leg.l1 + leg.l2) > 0
        ? leg.jointContinuityError / (leg.l1 + leg.l2) : 0;
      const ground = state.terrainHeight(leg.renderedFoot.x, leg.renderedFoot.z);
      leg.renderedGroundError = Number.isFinite(ground)
        ? leg.renderedFoot.y - (ground + tuning.footGround) : null;
    }
  }

  const depthCache = new Map();
  function depthOf(id) {
    if (depthCache.has(id)) return depthCache.get(id);
    let d = 0, o = objectOf(id);
    while (o.parent) { d++; o = o.parent; }
    depthCache.set(id, d);
    return d;
  }

  // --- public surface ------------------------------------------------------------------------------
  let acc = 0;
  function update(dt, { walk = true, speed = 1 } = {}) {
    const P = state.physics;
    const inputDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    state.maxInputDt = Math.max(state.maxInputDt, inputDt);
    const cap = P.FIXED * P.MAX_SUBSTEPS;
    const available = acc + inputDt;
    state.droppedTimeFrame = Math.max(0, available - cap);
    if (state.droppedTimeFrame > 0) {
      state.droppedTimeTotal += state.droppedTimeFrame;
      state.substepCapHits++;
    }
    acc = Math.min(available, cap);
    let steps = 0;
    while (acc >= P.FIXED && steps < P.MAX_SUBSTEPS) {
      fixedStep(P.FIXED, walk, speed);
      acc -= P.FIXED;
      steps++;
    }
    state.frameDt = steps * P.FIXED;
    state.elapsed += state.frameDt;
    applyPose();
    return steps;
  }

  /**
   * One frame of gait telemetry, as plain numbers.
   *
   * Deliberately free of THREE types so `gait-diagnostics.js` can stay a pure module and the detectors can
   * be tested against hand-written traces. Read it AFTER `update`, once per rendered frame — `drawnStep`
   * is a delta since the previous pose, so sampling it twice in a frame reports zero the second time.
   */
  function diagnosticFrame() {
    const g = state.gait;
    return {
      t: state.elapsed,
      dt: state.frameDt,
      bodyTravel: state.bodyTravel,
      speed: Math.hypot(body.vel.x, body.vel.z),
      commandedSpeed: body.commandedSpeed ?? 0,
      maxSpeed: g.maxSpeed,
      stepDuration: g.stepDuration,
      strideEnvelope: state.strideEnvelope,
      legSpan: legSpanWorld,
      // The three numbers a stride budget is made of, so `gaitHeadroom` can predict drag from the tuning
      // alone instead of waiting for a window of frames to observe it.
      legCount: legs.length,
      // The LONGEST leg, which is what sets the timing floor — see `legSpanLongest` above. `legSpan` next
      // to it is the shortest, which is what sets the reach limits. Both are here because the panel has to
      // agree with the walker about which one each rule uses.
      legSpanLongest,
      maxConcurrentFraction: g.maxConcurrentFraction,
      restepEpsilon: g.restepEpsilon ?? 0,
      triggerH: g.movingTrigger?.h ?? 0,
      reachMargin: tuning.reachMargin,
      reachStress: tuning.reachStress,
      // The stray gate, so a panel can state the threshold it is reporting against rather than assume it.
      strayLimit: tuning.strayLimit,
      footContact: tuning.footContact,
      footPatchScale: tuning.footPatchScale,
      contactCount: state.contactCount,
      haveSupport: state.haveSupport,
      comInside: state.comInside,
      supportFrames: state.supportFrames,
      supportedFrames: state.supportedFrames,
      comInsideFrames: state.comInsideFrames,
      supportMargin: state.support?.supportMargin ?? null,
      supportPointCount: state.contactCount,
      bodyClearance: state.bodyClearance,
      minimumBodyClearance: state.physics.BODY_MIN_CLEAR,
      belowMinimumClearanceFrames: state.belowMinimumClearanceFrames,
      droppedTimeFrame: state.droppedTimeFrame,
      droppedTimeTotal: state.droppedTimeTotal,
      substepCapHits: state.substepCapHits,
      maxInputDt: state.maxInputDt,
      strayMode: tuning.strayMode,
      landings: state.landings,
      strayFrames: state.strayFrames,
      strayForced: state.strayForced,
      strayAccepted: state.strayAccepted,
      strayThrottled: state.strayThrottled,
      failures: {
        terrainMisses: legs.reduce((sum, leg) => sum + leg.terrainMisses, 0),
        reachClamps: legs.reduce((sum, leg) => sum + leg.reachClamps, 0),
        schedulerWaitFrames: legs.reduce((sum, leg) => sum + leg.schedulerWaitFrames, 0),
        schedulerStarvations: legs.reduce((sum, leg) => sum + leg.schedulerStarvations, 0),
        forcedResteps: legs.reduce((sum, leg) => sum + leg.forcedResteps, 0),
        exhaustedResteps: legs.reduce((sum, leg) => sum + leg.exhaustedResteps, 0),
      },
      bodyY: body.pos.y,
      groundY: state.terrainHeight(body.pos.x, body.pos.z),
      legs: legs.map(leg => {
        const limit = (leg.l1 + leg.l2) * tuning.maxExtension;
        return {
          index: leg.index, row: leg.row, side: leg.side,
          stepping: leg.stepping,
          phase: leg.stepping ? Math.min(1, leg.t) : 1,
          wants: !!leg.wants,
          canMove: !!leg.canMove,
          targetGrounded: !!leg.targetGrounded,
          uncomfortable: !!leg.uncomfortable,
          failure: leg.retryExhaustedNow ? 'retry-exhausted'
            : leg.terrainMissNow ? 'terrain'
              : leg.reachClampedNow ? 'reach'
                : leg.schedulerStarved ? 'scheduler-starvation' : null,
          terrainMissNow: leg.terrainMissNow,
          terrainMisses: leg.terrainMisses,
          reachClampedNow: leg.reachClampedNow,
          reachClamps: leg.reachClamps,
          schedulerWaiting: leg.schedulerWaiting,
          schedulerWaitFrames: leg.schedulerWaitFrames,
          schedulerWaitCurrent: leg.schedulerWaitCurrent,
          schedulerWaitMax: leg.schedulerWaitMax,
          schedulerStarved: leg.schedulerStarved,
          schedulerStarvations: leg.schedulerStarvations,
          forcedRestepNow: leg.forcedRestepNow,
          forcedResteps: leg.forcedResteps,
          retryExhaustedNow: leg.retryExhaustedNow,
          exhaustedResteps: leg.exhaustedResteps,
          planted: !leg.stepping && !!leg.targetGrounded,
          endX: leg.end.x, endY: leg.end.y, endZ: leg.end.z,
          drawnX: leg.drawnFoot.x, drawnY: leg.drawnFoot.y, drawnZ: leg.drawnFoot.z,
          solvedHipX: leg.hipWorld.x, solvedHipY: leg.hipWorld.y, solvedHipZ: leg.hipWorld.z,
          solvedKneeX: leg.kneeWorld.x, solvedKneeY: leg.kneeWorld.y, solvedKneeZ: leg.kneeWorld.z,
          renderedHipX: leg.renderedHip.x, renderedHipY: leg.renderedHip.y, renderedHipZ: leg.renderedHip.z,
          renderedKneeUpperX: leg.renderedKneeUpper.x,
          renderedKneeUpperY: leg.renderedKneeUpper.y,
          renderedKneeUpperZ: leg.renderedKneeUpper.z,
          renderedKneeLowerX: leg.renderedKneeLower.x,
          renderedKneeLowerY: leg.renderedKneeLower.y,
          renderedKneeLowerZ: leg.renderedKneeLower.z,
          renderedFootX: leg.renderedFoot.x,
          renderedFootY: leg.renderedFoot.y,
          renderedFootZ: leg.renderedFoot.z,
          poleX: leg.poleWorld.x, poleY: leg.poleWorld.y, poleZ: leg.poleWorld.z,
          poleSource: leg.poleSource,
          poleConfidence: leg.poleConfidence,
          bendSign: leg.bendSign,
          kneeAngle: leg.kneeAngle,
          kneeAngleDelta: leg.kneeAngleDelta,
          upperLengthError: leg.upperLengthError,
          lowerLengthError: leg.lowerLengthError,
          jointContinuityError: leg.jointContinuityError,
          jointContinuityRelative: leg.jointContinuityRelative,
          renderedGroundError: leg.renderedGroundError,
          // How far the RENDERED foot slid since the last pose. On a planted foot this should be zero.
          drawnStep: Math.hypot(leg.drawnFoot.x - leg.drawnPrev.x, leg.drawnFoot.z - leg.drawnPrev.z),
          // How far the rendered foot is from where the gait believes it is. Non-zero means the solver
          // clamped an unreachable target, and the foot is being carried rather than standing.
          gap: Math.hypot(leg.drawnFoot.x - leg.end.x, leg.drawnFoot.y - leg.end.y, leg.drawnFoot.z - leg.end.z),
          // The same distance as `gap`, already divided by this leg's own span — the number the gate judges.
          strayNow: leg.strayNow ?? 0,
          clamped: (leg.reachAsked ?? 0) > limit + 1e-9,
          reach: leg.reachAsked ?? 0,
          reachLimit: limit,
          span: leg.l1 + leg.l2,
          // The contact patch: how many points it contributes now, and how wide it was measured to be.
          patchPoints: leg.contacts ? leg.contacts.length : 0,
          patchRadius: leg.footProxy?.ok ? leg.footProxy.radius * unitScale * tuning.footPatchScale : 0,
          patchSource: leg.footProxy?.ok ? leg.footProxy.source : (leg.footProxy?.reason ?? 'none'),
        };
      }),
    };
  }

  /** How far each foot is from the ground it should be standing on — the contact assertion's input. */
  function footContactError() {
    return legs.map(leg => ({
      index: leg.index, row: leg.row, side: leg.side, stepping: leg.stepping,
      error: leg.end.y - (state.terrainHeight(leg.end.x, leg.end.z) + tuning.footGround),
    }));
  }

  return {
    object: container,
    scene,
    body, legs, state,
    unitScale,
    update, fixedStep, applyPose, footContactError, diagnosticFrame, retune, tuning,
    setTarget(x, z) { _target.set(x, 0, z); haveTarget = true; },
    placeAt,
  };
}
