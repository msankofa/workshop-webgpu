// A scalar objective for the bug's gait, so `../spsa.js` can tune it instead of my eye.
//
// This is the bug's answer to `../gait-objective.js`, and it is a separate file rather than a
// generalisation of it because almost nothing in that one transfers. Its `RIG` is derived from a 1.8 m
// humanoid, its parameters are the player's speed-model coefficients (a different gait model entirely),
// and one of its penalty terms is INVERTED here: it charges 8.0 for `airborne`, meaning "both feet off
// the ground in a walk", whereas three feet off the ground is exactly what a correct insect tripod does.
// What transfers is the shape of the harness and its hard-won lessons, which are reproduced below.
//
// ---------------------------------------------------------------------------------------------------
// WHAT IS OPTIMISED, AND WHAT DELIBERATELY IS NOT
//
// SPEED IS A CONDITION, NOT A PARAMETER. If the optimiser could choose `maxSpeed` it would discover that
// standing still has no artifacts at all, and win. The gait has to work across a swept range instead.
//
// `maxConcurrentFraction` IS EXCLUDED. It reaches the scheduler as `floor(legs.length * f)`, so the
// objective is piecewise constant in it: SPSA's two-point gradient estimate is exactly zero almost
// everywhere and garbage at the three steps. It is a preset choice, not a continuous parameter.
//
// LEAF RADIUS IS THE TERRAIN. Curvature is what makes footholds hard here — a small leaf is a steep dome
// — so it is swept the way the player objective sweeps terrain.
//
// SEEDS ARE SWEPT TOO, AND THIS IS THE IMPORTANT ONE. The wander target decides the turn pattern, and
// turning is what strands a planted foot. The player objective records that a single terrain phase left
// its clipping metric reading exactly zero at every lift value, silently unconstraining step lift; the
// same trap here is a single wander seed that happens not to turn hard.
//
// ---------------------------------------------------------------------------------------------------
// WHY `reach` IS THE LOUDEST TERM
//
// Because it is the one term already known to catch a real, visible defect in this rig rather than a
// hypothetical one. Before the steering guard was ported from `physicsStep`, a planted foot was outside
// its leg's reach 15% of the time by a median of 138 mm on a 548 mm leg, and occasionally by more than
// twice the leg's length for over a second. FABRIK cannot reach an unreachable target, so it straightens:
// the leg snaps into a line and the drawn foot leaves the leaf. That was found by hand, an hour after
// shipping. This term is what would have said so immediately.
//
// ---------------------------------------------------------------------------------------------------
// WHAT THIS OBJECTIVE CANNOT DO
//
// It cannot tell you whether the bug reads as a beetle. `gait-objective.js` documents that its score
// SATURATES — once every artifact is zero there is no gradient left, and separate seeds settle on visibly
// different gaits that all score the maximum, so the metrics do not pick a winner among them. The same
// applies here, and the bug's remaining open question is exactly the aesthetic one. Treat a good score as
// "nothing is visibly broken", not as "this looks right".
//
// STEP LIFT IS ONLY CONSTRAINED FROM BELOW, and I first wrote the opposite here. The leaf is convex, so
// the chord a swing foot travels along dips beneath the surface and too little lift drags the foot through
// it. That is real, but measured across the conditions it only fires in the bottom few percent of the
// range: worst clipping is 84.7% of swing ticks at lift 0.0005, 20.6% at 0.004 (the parameter's floor),
// 0.2% at 0.008 and EXACTLY ZERO from 0.02 up. So `clip` is a floor on lift and nothing more — above
// 0.008 the objective has no opinion about where lift sits, which is the same weakness
// `gait-objective.js` documents, just with a working floor.
//
// The claim was wrong the first time because I measured it before the steering guard was fixed. With the
// body turning away from pinned feet it took longer strides, the chords were longer, and they dipped
// further. Fixing the rig moved the numbers the objective was described by.

import { BUG_GAIT, createBugRig } from './bug-rig.js';
import { mulberry32 } from '../spsa.js';

// ---------------------------------------------------------------------------
// The parameter vector
// ---------------------------------------------------------------------------

/**
 * The ten numbers the optimiser moves. `base` is what `BUG_GAIT` ships, so the baseline is exactly the
 * gait the demo runs today and any improvement is measured against the real starting point.
 *
 * `path` is where the value lives in a gait object; two levels because the trigger and comfort limits are
 * nested. Bounds are generous but keep the gait physically interpretable — a `stepDuration` of 0.5 s on a
 * beetle is not a gait worth finding.
 */
export const BUG_GAIT_PARAMS = Object.freeze([
  { key: 'stepDuration', path: ['stepDuration'], label: 'Step duration', min: 0.05, max: 0.30, base: BUG_GAIT.stepDuration },
  { key: 'stepLift', path: ['stepLift'], label: 'Step lift', min: 0.004, max: 0.11, base: BUG_GAIT.stepLift },
  { key: 'triggerH', path: ['movingTrigger', 'h'], label: 'Step trigger, moving', min: 0.03, max: 0.26, base: BUG_GAIT.movingTrigger.h },
  { key: 'triggerV', path: ['movingTrigger', 'v'], label: 'Step trigger, vertical', min: 0.02, max: 0.20, base: BUG_GAIT.movingTrigger.v },
  { key: 'restTriggerH', path: ['stationaryTrigger', 'h'], label: 'Step trigger, at rest', min: 0.01, max: 0.14, base: BUG_GAIT.stationaryTrigger.h },
  { key: 'comfortH', path: ['comfort', 'h'], label: 'Reach limit', min: 0.08, max: 0.38, base: BUG_GAIT.comfort.h },
  { key: 'comfortV', path: ['comfort', 'v'], label: 'Reach limit, vertical', min: 0.05, max: 0.30, base: BUG_GAIT.comfort.v },
  { key: 'lookAhead', path: ['lookAhead'], label: 'Look-ahead', min: 0.05, max: 0.60, base: BUG_GAIT.lookAhead },
  { key: 'turnSpeed', path: ['turnSpeed'], label: 'Turn rate', min: 0.4, max: 5.0, base: BUG_GAIT.turnSpeed },
  { key: 'uncomfy', path: ['uncomfortableSpeedMultiplier'], label: 'Slow-down when pinned', min: 0.05, max: 1.0, base: BUG_GAIT.uncomfortableSpeedMultiplier },
]);

export const BUG_GAIT_BOUNDS = BUG_GAIT_PARAMS.map(p => [p.min, p.max]);
export const BUG_GAIT_BASELINE = BUG_GAIT_PARAMS.map(p => p.base);

/** Build a gait object from a theta vector. Everything not in `BUG_GAIT_PARAMS` comes from `BUG_GAIT`. */
export function thetaToGait(theta, speed = null) {
  const g = {
    ...BUG_GAIT,
    stationaryTrigger: { ...BUG_GAIT.stationaryTrigger },
    movingTrigger: { ...BUG_GAIT.movingTrigger },
    comfort: { ...BUG_GAIT.comfort },
  };
  BUG_GAIT_PARAMS.forEach((p, i) => {
    const v = theta[i];
    if (p.path.length === 1) g[p.path[0]] = v;
    else g[p.path[0]][p.path[1]] = v;
  });
  // The stationary trigger must not exceed the moving one, or a standing bug is twitchier than a walking
  // one. Enforced here rather than left to the optimiser to discover, because it is a modelling fact.
  g.stationaryTrigger.h = Math.min(g.stationaryTrigger.h, g.movingTrigger.h);
  if (speed != null) g.maxSpeed = speed;
  return g;
}

/** The inverse, so a hand-tuned gait can be scored against an optimised one. */
export function gaitToTheta(gait) {
  return BUG_GAIT_PARAMS.map(p => (p.path.length === 1 ? gait[p.path[0]] : gait[p.path[0]][p.path[1]]));
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** Leaf radii: a steep dome, the demo's default, and a nearly flat one. */
export const RADII = Object.freeze([1.4, 2.4, 4.5]);
/** Commanded speeds, spanning the three gait presets on the page. */
export const SPEEDS = Object.freeze([0.12, 0.34, 0.62]);
/** Wander seeds the clean reference averages over. More than one, for the reason in the header. */
export const REFERENCE_SEEDS = Object.freeze([1, 7, 42]);

/** Every (radius, speed) pair. The clean score averages over these crossed with REFERENCE_SEEDS. */
export const CONDITIONS = Object.freeze(RADII.flatMap(r => SPEEDS.map(s => ({ sproutR: r, speed: s }))));

/** A stride this short is a vibration, not a step. Two foot radii. */
export const JITTER_FLOOR = 0.02;

// ---------------------------------------------------------------------------
// Simulation and artifact counting
// ---------------------------------------------------------------------------

/**
 * Walk one gait under one condition and return RAW ARTIFACT COUNTS, not a score.
 *
 * Kept separate from the scoring so the weights can be argued about without re-running anything, and so
 * `profileBugGait` can show what a score is actually made of.
 */
export function simulateBugWalk(theta, { sproutR = 2.4, speed = 0.34, seed = 1, duration = 6, settle = 0.5 } = {}) {
  const gait = thetaToGait(theta, speed);
  const rig = createBugRig({ THREE: _THREE, sproutR, gait, rng: mulberry32(seed) });
  rig.reset();
  const ground = rig.state.ground;
  const legSpan = rig.legs[0].chain.lengths.reduce((a, b) => a + b, 0);

  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const steps = Math.round(duration * 60);
  const settleSteps = Math.round(settle * 60);

  let frames = 0, legTicks = 0, plantedTicks = 0;
  let reachTicks = 0, reachWorst = 0, reachSum = 0;
  let clipSum = 0, clipTicks = 0, swingTicks = 0;
  let allAirFrames = 0, tripodFrames = 0, impureFrames = 0;
  let stallTicks = 0, scanFailTicks = 0;
  const strides = [], strideBySide = { '-1': [], '1': [] };
  const stepFrom = new Map();
  let odo = 0, measuredTime = 0, commandedSum = 0;
  let pinnedFrames = 0;
  const speeds = [];
  const prev = rig.body.pos.clone();

  for (let i = 0; i < steps; i++) {
    rig.update(1 / 60, { walk: true });
    const measuring = i >= settleSteps;
    if (!measuring) { prev.copy(rig.body.pos); continue; }

    frames++;
    measuredTime += 1 / 60;
    odo += Math.hypot(rig.body.pos.x - prev.x, rig.body.pos.z - prev.z);
    prev.copy(rig.body.pos);
    commandedSum += rig.body.commandedSpeed;
    speeds.push(Math.hypot(rig.body.vel.x, rig.body.vel.z));
    // The emergency-brake state: any PLANTED foot outside the comfort envelope. Counted because
    // `comfort.h` is a controller threshold, not a physical limit - see the note on `pinned` below.
    if (rig.legs.some(l => l.uncomfortable && !l.stepping)) pinnedFrames++;

    const airborne = rig.legs.filter(l => l.stepping);
    if (airborne.length === rig.legs.length) allAirFrames++;
    if (airborne.length >= 2) {
      tripodFrames++;
      // A clean tripod lifts one phase group at a time. Mixed phases is a broken tripod, and it is the
      // insect-specific analogue of the player objective's left/right asymmetry term.
      if (new Set(airborne.map(l => l.phase)).size > 1) impureFrames++;
    }

    for (const leg of rig.legs) {
      legTicks++;
      if (leg.wants && !leg.canMove) stallTicks++;
      if (!leg.targetGrounded) scanFailTicks++;

      if (leg.stepping) {
        swingTicks++;
        // A swinging foot below the leaf's surface. The dome is convex, so the chord between two footholds
        // dips beneath it and too little lift drags the foot through the leaf.
        const surf = ground(leg.end.x, leg.end.z) + rig.footClearance;
        const above = leg.end.y - surf;
        if (above < 0) { clipTicks++; clipSum += -above; }
        if (!stepFrom.has(leg)) stepFrom.set(leg, leg.stepStart.clone());
      } else {
        plantedTicks++;
        // The loud one: a planted foot the leg cannot span, so the drawn foot is not where the target is.
        const need = leg.hipWorld.distanceTo(leg.end);
        if (need > legSpan) {
          reachTicks++;
          const over = need - legSpan;
          reachSum += over;
          reachWorst = Math.max(reachWorst, over);
        }
        const from = stepFrom.get(leg);
        if (from) {
          const d = from.distanceTo(leg.end);
          strides.push(d);
          strideBySide[String(leg.side)].push(d);
          stepFrom.delete(leg);
        }
      }
    }
  }

  const strideMean = mean(strides);
  const strideSd = strides.length
    ? Math.sqrt(mean(strides.map(v => (v - strideMean) ** 2)))
    : 0;
  const leftMean = mean(strideBySide['-1']), rightMean = mean(strideBySide['1']);
  const achieved = measuredTime > 0 ? odo / measuredTime : 0;
  const commanded = frames > 0 ? commandedSum / frames : 0;
  const speedMean = mean(speeds);
  const speedCv = speedMean > 1e-6
    ? Math.sqrt(mean(speeds.map(v => (v - speedMean) ** 2))) / speedMean
    : 0;

  return {
    // Normalised by leg span wherever a length is involved, so the weights are scale-free.
    reach: plantedTicks ? reachTicks / plantedTicks : 0,
    reachDepth: plantedTicks ? (reachSum / plantedTicks) / legSpan : 0,
    reachWorst: reachWorst / legSpan,
    clip: swingTicks ? (clipSum / swingTicks) / legSpan : 0,
    clipFrac: swingTicks ? clipTicks / swingTicks : 0,
    allAir: frames ? allAirFrames / frames : 0,
    tripodImpurity: tripodFrames ? impureFrames / tripodFrames : 0,
    stall: legTicks ? stallTicks / legTicks : 0,
    scanFail: legTicks ? scanFailTicks / legTicks : 0,
    irregularity: strideMean > 1e-6 ? strideSd / strideMean : 0,
    asymmetry: strideMean > 1e-6 ? Math.abs(leftMean - rightMean) / strideMean : 0,
    jitter: strides.length ? strides.filter(d => d < JITTER_FLOOR).length / strides.length : 0,
    // A gait that cannot deliver the speed it was asked for is a bad gait, however clean it looks - but
    // "asked for" means what the CONTROLLER commanded, not maxSpeed. This model deliberately slows to
    // 0.35x when turning away from its target and further when a foot is pinned, so measuring against
    // maxSpeed reads 0.46 on the shipped gait and would dominate the whole penalty with a number that
    // describes the steering model working correctly. Against the commanded speed it measures the thing
    // that is actually a gait fault: legs not keeping up, which cuts drive through the grounded fraction.
    speedShortfall: commanded > 1e-6 ? Math.max(0, 1 - achieved / commanded) : 0,
    pinned: frames ? pinnedFrames / frames : 0,
    speedCv,
    stalled: strides.length === 0,
    // Diagnostics, not scored.
    strides: strides.length,
    strideMean,
    achieved,
    commanded,
    speedMean,
    legSpan,
  };
}

/**
 * Artifact counts to a penalty. Higher is worse, 0 is a clean gait.
 *
 * The weights are a judgement, not a measurement. What justifies the ordering: `reach` is the only term
 * here already shown to catch a real visible defect, `clip` and `allAir` are the two other ways the model
 * stops being physical, and the rest are quality-of-motion terms that should not be able to outvote them.
 * `stall` and `scanFail` are DIAGNOSTIC ONLY — see below.
 */
export function penaltyForBug(m) {
  return 16.0 * m.reach                  // planted foot the leg cannot span: the drawn foot leaves the leaf
    + 10.0 * m.reachDepth                // and how far, so the optimiser can tell 1 mm from 100 mm
    + 4.0 * m.reachWorst                 // with the worst case named, since a rare bad frame is what reads
    + 8.0 * m.clipFrac                   // how OFTEN a swinging foot is under the leaf's surface
    + 12.0 * m.clip                      // and how deep, which alone is far too small to matter
    + 9.0 * m.allAir                     // every foot off the ground: a hexapod is not meant to hop
    + 5.0 * m.tripodImpurity             // the tripod broken up across phases
    + 3.0 * m.irregularity               // stride length wandering step to step
    + 2.5 * m.asymmetry                  // one side striding further than the other
    + 7.0 * m.jitter                     // steps too short to read as steps
    + 3.0 * m.speedShortfall             // lags what the controller asked for; a tiebreaker, see below
    + 4.0 * m.pinned                     // time spent in the emergency-brake state; closes the loophole below
    + 2.5 * m.speedCv                    // stop-start motion, which is what the loophole looked like
    + (m.stalled ? 12.0 : 0);            // degenerate: never stepped at all
}

// `pinned` AND `speedCv` EXIST BECAUSE THE FIRST TUNED GAIT GAMED THE OBJECTIVE, and it took looking at
// something other than the score to notice.
//
// The tuned result scored 1.25 -> 2.48 on held-out seeds and looked like a clear win. It was not. Measured
// separately: it spent 48% of frames with a planted foot outside the comfort envelope (baseline 29%), its
// speed CV nearly doubled from 0.37 to 0.68, and it walked 30% slower - all to move `reach` from 4.50% to
// 3.41%. It would have read as a hesitant, stuttering bug.
//
// The exploit is that `comfort.h` IS NOT A PHYSICAL LIMIT. It is the threshold at which the controller
// declares a foot uncomfortable and applies `uncomfortableSpeedMultiplier`. Tightening it makes the bug
// brake sooner, which genuinely reduces true overextension - so `reach` fell - while the optimiser also
// drove `uncomfy` to 0.055, a near-total stop. It was buying the metric with an emergency brake rather
// than by placing feet better, and nothing in the penalty charged it for that.
//
// `pinned` charges for how OFTEN the brake is needed, which tightening `comfort.h` makes worse rather than
// better, so the two now pull against each other. `speedCv` charges for the visible symptom directly.
// Neither can be satisfied by braking harder.

// `clipFrac` was added after the test caught the depth term being powerless. `clip` is a mean penetration
// depth normalised by leg span, and the depths involved are sub-millimetre: at lift 0.004, where a swinging
// foot is under the surface 20.6% of the time, `12.0 * m.clip` contributes 0.011 to the penalty. It could
// not push step lift anywhere, and the assertion that it did was the thing that failed. The FRACTION of
// swing time spent below the surface is scale-free and worth 1.65 at the same point, which is a signal.
//
// `speedShortfall` is weighted DOWN on purpose, and it took two passes to get right.
//
// Measured against `maxSpeed` it read 0.46 on the shipped gait and contributed 2.75 of a 4.18 penalty -
// dominating the objective with a number that mostly described the steering model working as designed,
// since this model deliberately slows to 0.35x while turning. Measured against the commanded speed it
// reads 0.19, which is a real effect: drive is scaled by the grounded fraction, so a gait with more feet
// in the air accelerates less.
//
// But that is also why it cannot carry much weight. Pushing it down rewards keeping feet on the ground,
// which is in direct tension with the alternating tripod - the thing the gait exists to produce. At 6.0
// it was still 44% of the penalty and would have bought speed by dismantling the tripod. At 3.0 it breaks
// ties between otherwise clean gaits, which is all it should do.

// `stall` is deliberately absent from the penalty. It is the fraction of leg-ticks where a leg wants to
// step and the scheduler refuses, and on this rig it sits near 20% BY DESIGN: the concurrent-step cap
// exists to refuse legs, so a gait with no stalling is a gait with no tripod. Penalising it would push
// the optimiser to raise the cap and destroy the thing the gait is for. It is reported instead.
//
// `scanFail` is absent for a different reason: inside `roamRadius` on a smooth dome it is identically
// zero, so it contributes no gradient and only costs weight-tuning attention. It would matter on a bumpy
// leaf, which this demo does not have yet.

/** Best possible score, so a score reads as a distance from clean rather than as a raw penalty. */
export const CLEAN_SCORE = 4.0;

/** One noisy draw: a single condition and seed. Fine for random search; NOT for SPSA — see below. */
export function sampleBugGait(theta, rng, { duration = 5 } = {}) {
  const cond = CONDITIONS[Math.floor(rng() * CONDITIONS.length) % CONDITIONS.length];
  const seed = 1 + Math.floor(rng() * 100000);
  return CLEAN_SCORE - penaltyForBug(simulateBugWalk(theta, { ...cond, seed, duration }));
}

/**
 * A PAIRED sampler: consecutive calls share their condition and seed.
 *
 * This exists because SPSA made literally zero progress with `sampleBugGait` while random search beat it
 * on the same budget — the control doing exactly the job it is in the harness for. The reason is that the
 * "noise" in this objective is not measurement noise, it is CONDITION VARIANCE: a run at R=1.4/0.62 scores
 * about 2.5 worse than one at R=4.5/0.12 regardless of the gait, and conditions differ from one another
 * far more than neighbouring gaits do. SPSA forms its gradient from `(y+ - y-)`, so drawing a different
 * condition for each probe means that difference is mostly "which condition came up", and the gait signal
 * is buried. `calibrateSpsa` then measured a noise sd of 0.76 and set `c` to match, which in normalised
 * space perturbs every parameter by 76% of its range — not a local gradient probe at all.
 *
 * Sharing the condition across the pair is the standard common-random-numbers fix: the condition term
 * cancels in the difference and what is left is the effect of the perturbation. Nothing about SPSA needed
 * changing; the objective was handing it noise it could not average away two evaluations at a time.
 */
export function createPairedSampler({ seed = 1, duration = 5, conditions = CONDITIONS } = {}) {
  const rng = mulberry32(seed);
  let held = null, calls = 0;
  return (theta) => {
    if (calls % 2 === 0) {
      held = {
        cond: conditions[Math.floor(rng() * conditions.length) % conditions.length],
        runSeed: 1 + Math.floor(rng() * 100000),
      };
    }
    calls++;
    return CLEAN_SCORE - penaltyForBug(
      simulateBugWalk(theta, { ...held.cond, seed: held.runSeed, duration }));
  };
}

/** The clean reference: every condition crossed with every reference seed, averaged. Deterministic. */
export function scoreBugGait(theta, { duration = 7, seeds = REFERENCE_SEEDS } = {}) {
  let penalty = 0, n = 0;
  for (const cond of CONDITIONS) {
    for (const seed of seeds) {
      penalty += penaltyForBug(simulateBugWalk(theta, { ...cond, seed, duration }));
      n++;
    }
  }
  return CLEAN_SCORE - penalty / n;
}

/** Per-condition breakdown of what a score is made of. */
export function profileBugGait(theta, { duration = 7, seeds = REFERENCE_SEEDS } = {}) {
  const rows = [];
  for (const cond of CONDITIONS) {
    const runs = seeds.map(seed => simulateBugWalk(theta, { ...cond, seed, duration }));
    const avg = (k) => runs.reduce((s, r) => s + r[k], 0) / runs.length;
    rows.push({
      ...cond,
      reach: avg('reach'), reachWorst: avg('reachWorst'), clip: avg('clip'),
      allAir: avg('allAir'), tripodImpurity: avg('tripodImpurity'),
      irregularity: avg('irregularity'), asymmetry: avg('asymmetry'), jitter: avg('jitter'),
      speedShortfall: avg('speedShortfall'), stall: avg('stall'), scanFail: avg('scanFail'),
      achieved: avg('achieved'), strides: avg('strides'),
      penalty: runs.reduce((s, r) => s + penaltyForBug(r), 0) / runs.length,
    });
  }
  return rows;
}

// THREE is injected once rather than per call, because every simulate() needs it and threading it through
// the optimiser's objective closure would put a renderer dependency in the middle of the maths.
let _THREE = null;
export function useThree(THREE) {
  if (!THREE?.Vector3) throw new Error('useThree needs the three namespace');
  _THREE = THREE;
}
