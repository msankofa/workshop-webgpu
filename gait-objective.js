// A scoreable objective built on the REAL biped gait scheduler in player-procedural-body.js.
// Pure, no THREE, no DOM - Node-testable twin in test-gait-objective.mjs.
//
// Why this exists: spsa.js can search a parameter space but had nothing real to search. This is the
// smallest honest harness - it drives the shipped `stepGait` over a speed sweep on real terrain and
// reduces what actually happens to the foot states into a handful of artifact measurements.
//
// What is being tuned is GAIT_SPEED_MODEL, the least-squares speed->gait fit that was authored in
// body-preview.html, plus the two speed-independent scheduler constants that stepGait reads, plus
// the lean-into-step scale. The repo's own fitted model is the baseline to beat.
//
// Deliberately NOT tuned:
//   * lookAhead - GAIT_DEFAULTS declares it but nothing in player-procedural-body.js reads it.
//   * standSpeed / teleportDistance - thresholds for standing and respawn, inert while walking.

import {
  createGaitScheduler, GAIT_DEFAULTS, GAIT_SPEED_MODEL, LEG_WORKSPACE_DEFAULTS, gaitForSpeed,
  BODY_DESIGN_DEFAULTS, leanAngleForSpeed, stepLeadFor, effectiveStepDuration,
} from './player-procedural-body.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// The rig, as the shipped code actually builds it
// ---------------------------------------------------------------------------
// Three facts from player-procedural-body.js that an earlier version of this file got wrong:
//
//  1. Bone lengths are FIXED at the H=1.8 reference for every body. `legLen = H * legLenRatio` uses
//     a function-local H, not state.height (:724-730), and :1625 says so outright: "limb lengths are
//     fixed at the H=1.8 baseline for every body (only meshes scale)".
//  2. Pelvis height is `state.height * gait.cfg.pelvisHeightRatio` (:1534), and that ratio is
//     SPEED-VARYING - gaitForSpeed writes it every frame (:1502). A fixed pelvis was wrong twice.
//  3. The leg workspace scales with the body: every field is multiplied by height/H (:1513-1519).
//
// Together those mean body height is the axis over-extension varies along: a taller body raises the
// hip socket and widens the workspace while the leg stays 1.116 m long.
export const REFERENCE_HEIGHT = 1.8;      // H in player-procedural-body.js
export const BOT_RADIUS = 0.3;            // DEFAULT_RADIUS in bot-entity.js

export const BONES = Object.freeze({
  thigh: REFERENCE_HEIGHT * BODY_DESIGN_DEFAULTS.legLenRatio * BODY_DESIGN_DEFAULTS.thighFrac,  // 0.580
  shin: REFERENCE_HEIGHT * BODY_DESIGN_DEFAULTS.legLenRatio * BODY_DESIGN_DEFAULTS.shinFrac,    // 0.536
});

// solveTwoBone clamps the end effector to this fraction of full extension (:1328), so a foot target
// further away than LEG_REACH is simply not reached - the drawn foot stops short along the hip->foot
// line. Nothing downstream absorbs it. See the note on penaltyFor.
export const TWO_BONE_CLAMP = 0.999;
export const LEG_REACH = (BONES.thigh + BONES.shin) * TWO_BONE_CLAMP;

// Kept for drawing code: the reference body's bones, and its pelvis at rest.
export const RIG = Object.freeze({
  H: REFERENCE_HEIGHT,
  legLen: BONES.thigh + BONES.shin,
  thighLen: BONES.thigh,
  shinLen: BONES.shin,
  pelvisHeight: REFERENCE_HEIGHT * GAIT_SPEED_MODEL.pelvisHeightRatio.b,   // standing, speed 0
});

/** The per-body quantities update() derives each frame, at movementTuning scales of 1. */
export function rigFor(height = REFERENCE_HEIGHT, radius = BOT_RADIUS) {
  const s = height / REFERENCE_HEIGHT;
  const minLateral = Math.max(radius * 0.32, LEG_WORKSPACE_DEFAULTS.minLateral * s);
  return {
    height, radius, workspaceScale: s,
    hipWidth: radius * 2 * GAIT_DEFAULTS.hipWidthRatio,
    workspace: {
      minLateral,
      maxLateral: Math.max(minLateral + radius * 0.6, LEG_WORKSPACE_DEFAULTS.maxLateral * s),
      forward: LEG_WORKSPACE_DEFAULTS.forward * s,
      backward: LEG_WORKSPACE_DEFAULTS.backward * s,
      maxReach: LEG_WORKSPACE_DEFAULTS.maxReach * s,
    },
  };
}

// Body heights to stay good across. Bots are all exactly 1.8 (bot-viewer-v3.html spawns
// standHeight 1.8 and the rig is handed standHeight + 2*radius), so this band exists for the
// player's Stand slider, which environment-viewer.html lets the user drag from 0.5 to 2.5.
export const HEIGHT_SWEEP = Object.freeze([1.7, 1.8, 1.9]);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
// `base` is the shipped value, so the baseline is exactly what the game runs today. Read by key via
// GAIT_INDEX rather than by position, so appending a parameter cannot silently shift another.
//
// pelvisBase's upper bound is not a guess: GAIT_DEFAULTS says "Keep pelvisHeightRatio below
// legLen/H (0.62) so the feet can reach the ground with bend room". At exactly 0.62 the pelvis sits
// at full leg extension. The 0.55 floor IS a judgement call, and a deliberately tight one: dropping
// the hips is the cheapest way to make over-extension disappear, so a loose floor turns the whole
// search into "crouch more" and the A/B against the shipped model stops being about foot placement.
export const GAIT_PARAMS = Object.freeze([
  { key: 'strideSlope', label: 'Stride vs speed',   min: -0.05, max: 0.02,  base: GAIT_SPEED_MODEL.maxStepDistance.m },
  { key: 'strideBase',  label: 'Stride at rest',    min: 0.40,  max: 1.80,  base: GAIT_SPEED_MODEL.maxStepDistance.b },
  { key: 'liftSlope',   label: 'Lift vs speed',     min: -0.02, max: 0.12,  base: GAIT_SPEED_MODEL.stepLift.m },
  { key: 'liftBase',    label: 'Lift at rest',      min: 0.02,  max: 0.60,  base: GAIT_SPEED_MODEL.stepLift.b },
  { key: 'cadenceA',    label: 'Cadence scale',     min: 0.10,  max: 0.45,  base: GAIT_SPEED_MODEL.stepDuration.A },
  { key: 'cadenceB',    label: 'Cadence exponent',  min: -0.60, max: 0.00,  base: GAIT_SPEED_MODEL.stepDuration.B },
  { key: 'trigger',     label: 'Step trigger',      min: 0.05,  max: 0.60,  base: GAIT_DEFAULTS.triggerDistance },
  // Base is the module default, but bot-viewer-v3.html runs 0.22 and that changes the answer: the
  // best lead falls as overlap rises (0.75 at 0, 0.63 at 0.11, 0.54 at 0.22, 0.37 at 0.33) because
  // an overlapped step shortens the stance phase, so the foot has less time to drag behind.
  { key: 'overlap',     label: 'Step overlap',      min: 0.00,  max: 0.60,  base: GAIT_DEFAULTS.stepOverlap },
  { key: 'leadScale',   label: 'Lean into step',    min: 0.00,  max: 1.50,  base: 0 },
  { key: 'pelvisSlope', label: 'Hip drop vs speed', min: -0.008, max: 0.002, base: GAIT_SPEED_MODEL.pelvisHeightRatio.m },
  { key: 'pelvisBase',  label: 'Hip height at rest', min: 0.55, max: 0.62,  base: GAIT_SPEED_MODEL.pelvisHeightRatio.b },
]);

export const GAIT_INDEX = Object.freeze(
  Object.fromEntries(GAIT_PARAMS.map((p, i) => [p.key, i])));
export const GAIT_BOUNDS = GAIT_PARAMS.map(p => [p.min, p.max]);
export const GAIT_BASELINE = GAIT_PARAMS.map(p => p.base);

// ---------------------------------------------------------------------------
// Lean into step
// ---------------------------------------------------------------------------
// The shipped rig has a lean, but on its own it is decorative: body-locomotion.js rotates the spine
// and the scheduler still anchors each foot's rest point directly under the hip. These feed the
// scheduler a BALANCE POINT instead - hip + lead along the heading - which needs no scheduler change
// because the rest anchor follows whatever hip it is handed. Both delegate to the shipped rig
// helpers so the demo and the real body cannot drift apart.
//
// The lead is a fraction of the HIP TRAVEL the foot has to catch up on, not a projection of the
// torso lean. The lean-derived version this replaces could not reach the right value: torsoLean
// saturates at 0.20 rad, so even at the slider maximum it offered 0.32 m at sprint speed where the
// measured requirement is about 0.9 m.
export const leanAngleFor = leanAngleForSpeed;
export const leadFor = (speed, leadScale = 0, cfg = GAIT_DEFAULTS) =>
  stepLeadFor(speed, cfg, leadScale);

// Same clamps gaitForSpeed applies, so a candidate can never ask the scheduler for a gait the
// shipped model could not also have produced.
export function cfgForSpeed(theta, speed) {
  const i = GAIT_INDEX;
  const v = Math.max(0, speed);
  return {
    ...GAIT_DEFAULTS,
    pelvisHeightRatio: clamp(theta[i.pelvisSlope] * v + theta[i.pelvisBase], 0.3, 0.85),
    maxStepDistance: clamp(theta[i.strideSlope] * v + theta[i.strideBase], 0.15, 1.6),
    stepLift: clamp(theta[i.liftSlope] * v + theta[i.liftBase], 0.02, 0.6),
    stepDuration: clamp(theta[i.cadenceA] * Math.pow(Math.max(v, 1e-3), theta[i.cadenceB]), 0.1, 0.45),
    triggerDistance: theta[i.trigger],
    stepOverlap: theta[i.overlap],
  };
}

// Terrain the gait is scored on. The short-wavelength terms are the ones that matter: a swing foot
// travels a straight chord between two ground points, so only bumps at STEP scale (~1-2 m) can rise
// above that chord and be clipped. A first version used 5-9 m wavelengths only, and the clipping
// metric never fired once - which left step lift completely unconstrained.
export const TERRAINS = Object.freeze({
  flat: () => () => 0,
  rolling: (phase = 0) => (x, z) =>
    Math.sin(z * 0.7 + phase) * 0.16
    + Math.cos(x * 0.5 + phase * 0.6) * 0.09
    + Math.sin(z * 3.1 + phase * 1.7) * 0.085     // ~2 m wavelength: crests a stride can catch
    + Math.cos(z * 5.3 + phase * 2.3) * 0.035,    // ~1.2 m wavelength
});

// Cadence is a DON'T-REGRESS constraint, not an absolute target, and that choice is load-bearing.
//
// The rig already steps about twice as fast as a human: 3.75 footfalls/s at 1 m/s against a human's
// ~1.8, advancing 0.27 m per footfall against ~0.55. That is not a tuning mistake, it is the only
// way this geometry works. Forcing human cadence measurably makes things WORSE - at 0.45/-0.436 the
// planted foot slides 0.455 m at sprint against the shipped model's 0.269 - because a longer ground
// contact drags the foot further behind a hip whose leg can only span 0.455 m horizontally. The
// shuffle is how the shipped model buys low slide. Demanding human cadence here would just make the
// objective unsatisfiable and hand back nonsense.
//
// So the rule is: a candidate may not step FASTER than the shipped model does at that speed. The
// reference is the shipped model itself, which is the gait the user already accepts. Its weight in
// penaltyFor is deliberately huge, making it a hard constraint rather than a trade - at a tradeable
// weight the search always bought cadence, because stepping faster genuinely does cut foot slide
// (shorter ground contact, less drag). It reached 7.5 footfalls/s at sprint before this.
//
// It must be measured against the EFFECTIVE duration, not cfg.stepDuration. A first version used
// the configured value and the search exploited it immediately: cfg.stepDuration went to its 0.45
// maximum so the term read zero, while maxStepDistance went to its minimum, which drives stepGait's
// own `maxStepDistance / speed` term down to the 0.12 floor. It scored an 8 Hz shuffle as perfect.
export function shippedStepDuration(speed) {
  return effectiveStepDuration(speed, { ...GAIT_DEFAULTS, ...gaitForSpeed(speed) });
}

// Where a flight phase stops being a bug and starts being a run. Humans switch gait around 2 m/s;
// the band is faded rather than stepped so a candidate cannot win by sitting on one side of it.
export const WALK_SPEED = 2.0;
export const RUN_SPEED = 3.0;

// The pelvis ratio below which the walk reads as a crouch rather than a stride. Lowering the hips
// is the cheapest way to make over-extension go away - the search took the pelvis to 0.40 of body
// height, a Groucho walk, and scored it 3.99. Unlike the 0.62 ceiling (which GAIT_DEFAULTS states
// outright) this floor is a judgement call.
export const CROUCH_FLOOR = 0.50;

/**
 * Walk the real scheduler in a straight line at one speed and measure what the feet actually did.
 * Returns raw artifact counts, not a score.
 */
export function simulateWalk(theta, {
  speed = 2.0, terrain = TERRAINS.flat(), duration = 2.4, dt = 1 / 60,
  height = REFERENCE_HEIGHT, radius = BOT_RADIUS, warmup = 0.6,
} = {}) {
  const cfg = cfgForSpeed(theta, speed);
  const rig = rigFor(height, radius);
  const pelvisHeight = height * cfg.pelvisHeightRatio;
  const halfHip = rig.hipWidth * 0.5;
  const gait = createGaitScheduler(cfg);
  const hip = { x: 0, y: 0, z: 0 };          // the real pelvis, and what the leg measures from
  const anchor = { x: 0, y: 0, z: 0 };       // the balance point the scheduler is handed
  const lead = stepLeadFor(speed, cfg, theta[GAIT_INDEX.leadScale] ?? 0);
  const velocity = { x: 0, y: 0, z: speed };

  let ticks = 0, airborneTicks = 0, clipDepth = 0, reachExcess = 0, liftSum = 0;
  let legTicks = 0, overTicks = 0, overWorst = 0;
  let plantTicks = 0, plantExcess = 0, swingTicks = 0, swingExcess = 0;
  const stepsBySide = { '-1': [], '1': [] };
  const wasStepping = { left: false, right: false };
  let peakThisStep = { left: 0, right: 0 };

  const total = Math.round((duration + warmup) / dt);
  const warmTicks = Math.round(warmup / dt);

  for (let i = 0; i < total; i++) {
    hip.z += speed * dt;
    hip.y = terrain(hip.x, hip.z) + pelvisHeight;
    anchor.x = hip.x; anchor.z = hip.z + lead; anchor.y = hip.y;   // heading is +z here
    gait.update(dt, { hip: anchor, yaw: 0, velocity, hipWidth: rig.hipWidth, workspace: rig.workspace }, terrain);

    const measuring = i >= warmTicks;   // let the scheduler settle before anything counts
    let planted = 0;

    for (const key of ['left', 'right']) {
      const foot = gait.feet[key];
      const ground = terrain(foot.current.x, foot.current.z);
      if (foot.stepping) {
        const above = foot.current.y - ground;
        if (measuring && above < 0) clipDepth += -above;          // swinging foot inside the ground
        if (above > peakThisStep[key]) peakThisStep[key] = above;
      } else {
        planted++;
        const d = Math.hypot(foot.current.x - hip.x, foot.current.z - hip.z);
        if (measuring && d > rig.workspace.maxReach) reachExcess += d - rig.workspace.maxReach;
      }
      // How far past full leg extension the foot target sits, measured from the HIP SOCKET the leg
      // actually hangs off (pelvis offset laterally by half the hip width, :1735) rather than the
      // pelvis centre. The excess is literally how far the drawn foot ends up from the planned one.
      if (measuring) {
        const sx = hip.x + foot.side * halfHip;
        const reach3d = Math.hypot(foot.current.x - sx, foot.current.z - hip.z, foot.current.y - hip.y);
        const excess = Math.max(0, reach3d - LEG_REACH);
        legTicks++;
        if (excess > 0) { overTicks++; overWorst = Math.max(overWorst, excess); }
        if (foot.stepping) { swingTicks++; swingExcess += excess; }
        else { plantTicks++; plantExcess += excess; }
      }
      // A step just finished: record its length and how high it arced.
      if (wasStepping[key] && !foot.stepping) {
        if (measuring) {
          stepsBySide[String(foot.side)].push(
            Math.hypot(foot.stepEnd.x - foot.stepStart.x, foot.stepEnd.z - foot.stepStart.z));
          liftSum += peakThisStep[key];
        }
        peakThisStep[key] = 0;
      }
      wasStepping[key] = foot.stepping;
    }

    if (measuring) { ticks++; if (planted === 0) airborneTicks++; }
  }

  const left = stepsBySide['-1'], right = stepsBySide['1'];
  const all = left.concat(right);
  const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const meanAll = mean(all);
  const sd = all.length > 1
    ? Math.sqrt(all.reduce((s, v) => s + (v - meanAll) ** 2, 0) / (all.length - 1)) : 0;

  const distance = speed * duration;
  return {
    speed, height,
    steps: all.length,
    clip: ticks ? clipDepth / ticks : 0,
    reach: ticks ? reachExcess / ticks : 0,
    airborne: ticks ? airborneTicks / ticks : 0,
    // Only a defect at WALKING speed. A run has a flight phase by definition, and bot-viewer-v3
    // deliberately runs stepOverlap 0.22 to get one - scoring that as an artifact punished the
    // setting the user tuned by eye and dropped the whole objective by more than a point.
    airborne: (ticks ? airborneTicks / ticks : 0) * clamp((RUN_SPEED - speed) / (RUN_SPEED - WALK_SPEED), 0, 1),
    asymmetry: Math.abs(mean(left) - mean(right)),
    irregularity: sd,
    meanStep: meanAll,
    meanLift: all.length ? liftSum / all.length : 0,
    stepsPerMetre: distance > 0 ? all.length / distance : 0,
    stepRate: duration > 0 ? all.length / duration : 0,   // footfalls per second; ~2 Hz is human
    // Two-sided pressure on the two parameters that would otherwise run to a bound: clipping pushes
    // lift up so float has to push it back down, and reach pushes cadence up so jitter caps it.
    float: all.length ? Math.max(0, (liftSum / all.length) - 0.5 * meanAll) : 0,
    jitter: Math.max(0, shippedStepDuration(speed) - effectiveStepDuration(speed, cfg)),
    crouch: Math.max(0, CROUCH_FLOOR - cfg.pelvisHeightRatio),
    stalled: all.length === 0,     // never took a step: the gait is not walking at all
    slidePlanted: plantTicks ? plantExcess / plantTicks : 0,
    slideSwing: swingTicks ? swingExcess / swingTicks : 0,
    overextend: legTicks ? overTicks / legTicks : 0,
    overextendWorst: overWorst,
    pelvisHeight,
  };
}

// Speeds the model has to serve at once. This is the whole point of a speed->gait fit: one set of
// coefficients covering a walk through a sprint, so scoring at a single speed would be meaningless.
//
// These are the four speeds a v3 bot actually moves at, not a made-up spread: BOT_MOVE_SPEED is
// 2.4 m/s, botMovementSettings.runMultiplier is 1.7, STANCE_DEFAULTS.crouchSpeedFactor is 0.55 and
// dashSpeedBonus is 1.15. So crouch 1.32, walk 2.40, run 4.08, dash 4.69.
export const SPEED_SWEEP = Object.freeze([1.32, 2.40, 4.08, 4.69]);

// Turn one walk's artifact counts into a penalty. Higher is worse; 0 is a clean gait.
//
// `slidePlanted` and `slideSwing` are new, and they replace a diagnostic that used to be excluded
// on the grounds that "the real rig may absorb it". It does not. The legs are solved by an analytic
// two-bone IK (solveTwoBone, :1324) that clamps the end effector to 0.999 of full extension and
// places it along the hip->target line. There is no FABRIK on the legs and nothing else stretches
// the bones, so an out-of-reach target means the DRAWN foot is not where the simulation thinks it
// is. On a planted foot that is visible skating - the foot slides while it is supposed to be stuck
// to the ground - which is why it carries roughly the same weight as ground clipping. On a swing
// foot the error is a mid-air pose, so it is weighted far lower.
//
// The scheduler's workspace cannot prevent this on its own: constrainFootTarget's maxReach is a
// purely HORIZONTAL bound (:152), so it never accounts for the vertical drop to the ground.
export function penaltyFor(m) {
  return 14.0 * m.clip                                   // foot through the ground: the loudest artifact
    + 12.0 * m.slidePlanted                              // planted foot past leg reach: it skates
    + 6.0 * m.reach                                      // planted foot dragged outside the workspace
    + 8.0 * m.airborne                                   // both feet off the ground in a walk
    + 3.0 * m.asymmetry                                  // one leg striding further than the other
    + 2.0 * m.irregularity                               // stride length wandering step to step
    + 2.0 * m.slideSwing                                 // swing foot past leg reach: bad pose only
    + 1.6 * m.float                                      // lifting far higher than the stride needs
    + 200.0 * m.jitter                                   // stepping faster than the shipped model
    + 9.0 * m.crouch                                     // hips dropped low enough to read as a squat
    + (m.stalled ? 6.0 : 0);                             // degenerate: never stepped at all
}

// Terrain phases the clean reference averages over. One fixed phase is NOT enough: whether a swing
// foot clips depends on where the crests fall relative to the stride, and at phase 0 alone the
// clipping metric reads exactly zero at every lift value, which silently unconstrains step lift.
export const REFERENCE_PHASES = Object.freeze([0, 1.7, 3.9]);

/**
 * The cheap NOISY evaluation the optimiser sees: one random speed, height and terrain phase, one
 * short walk. This is the only function the search is allowed to call.
 */
export function sampleGait(theta, rng, { duration = 2.0 } = {}) {
  const speed = SPEED_SWEEP[Math.floor(rng() * SPEED_SWEEP.length)] * (0.9 + 0.2 * rng());
  const height = HEIGHT_SWEEP[Math.floor(rng() * HEIGHT_SWEEP.length)];
  const terrain = TERRAINS.rolling(rng() * 6.283);
  return 4.0 - penaltyFor(simulateWalk(theta, { speed, height, terrain, duration }));
}

/**
 * The clean REFERENCE score: every speed against every height and reference terrain phase, no
 * noise. Charts and readouts only - never shown to the optimiser. Higher is better, 4.0 is clean.
 */
export function scoreGait(theta, {
  duration = 2.4, phases = REFERENCE_PHASES, heights = HEIGHT_SWEEP,
} = {}) {
  let penalty = 0, n = 0;
  for (const height of heights) {
    for (const phase of phases) {
      const terrain = TERRAINS.rolling(phase);
      for (const speed of SPEED_SWEEP) {
        penalty += penaltyFor(simulateWalk(theta, { speed, height, terrain, duration })); n++;
      }
    }
  }
  return 4.0 - penalty / n;
}

const METRIC_KEYS = ['steps', 'clip', 'reach', 'airborne', 'asymmetry', 'irregularity', 'meanStep',
  'meanLift', 'stepsPerMetre', 'float', 'jitter', 'crouch', 'slidePlanted', 'slideSwing',
  'overextend', 'overextendWorst', 'pelvisHeight', 'stepRate'];

// Per-speed detail for readouts, averaged over the reference phases and heights the score uses.
export function profileGait(theta, {
  duration = 2.4, phases = REFERENCE_PHASES, heights = HEIGHT_SWEEP,
} = {}) {
  return SPEED_SWEEP.map(speed => {
    const runs = [];
    for (const height of heights) {
      for (const phase of phases) {
        runs.push(simulateWalk(theta, { speed, height, terrain: TERRAINS.rolling(phase), duration }));
      }
    }
    const avg = key => runs.reduce((s, r) => s + r[key], 0) / runs.length;
    const out = { speed, penalty: runs.reduce((s, r) => s + penaltyFor(r), 0) / runs.length };
    for (const key of METRIC_KEYS) out[key] = avg(key);
    return out;
  });
}

// The shipped model, expressed in this parameter vector - what the game walks with today.
export function baselineTheta() { return GAIT_BASELINE.slice(); }

/**
 * The body height above which a standing leg cannot reach the ground at all, for a given hip ratio.
 * At the shipped 0.5884 this is 1.895 m, which is inside the player's Stand slider range.
 */
export function reachCliffHeight(pelvisRatio = GAIT_SPEED_MODEL.pelvisHeightRatio.b) {
  return LEG_REACH / pelvisRatio;
}

// Re-exported so a consumer needs only this module to both score and draw a gait.
export { createGaitScheduler, LEG_WORKSPACE_DEFAULTS } from './player-procedural-body.js';

/**
 * A live walker for previewing a candidate: the same stepGait the score uses, advanced in real time.
 * setTheta/setSpeed rewrite the config in place rather than rebuilding, so retuning mid-stride does
 * not reset the feet and stutter the walk.
 */
export function createWalker(theta, {
  speed = 2.05, terrainPhase = 0, height = REFERENCE_HEIGHT, radius = BOT_RADIUS,
} = {}) {
  const terrain = TERRAINS.rolling(terrainPhase);
  const rig = rigFor(height, radius);
  const scheduler = createGaitScheduler(cfgForSpeed(theta, speed));
  const hip = { x: 0, y: 0, z: 0 };
  const anchor = { x: 0, y: 0, z: 0 };
  const velocity = { x: 0, y: 0, z: speed };
  const state = { speed, theta: theta.slice(), lead: 0, lean: 0, pelvisHeight: 0 };

  const resync = () => {
    const cfg = cfgForSpeed(state.theta, state.speed);
    Object.assign(scheduler.cfg, cfg);
    velocity.z = state.speed;
    state.pelvisHeight = height * cfg.pelvisHeightRatio;
    state.lean = leanAngleFor(state.speed);
    state.lead = stepLeadFor(state.speed, cfg, state.theta[GAIT_INDEX.leadScale] ?? 0);
  };
  resync();

  return {
    scheduler, hip, terrain, rig,
    get feet() { return scheduler.feet; },
    get cfg() { return scheduler.cfg; },
    get speed() { return state.speed; },
    get lean() { return state.lean; },                    // radians the torso pitches forward
    get lead() { return state.lead; },                    // metres the balance point sits ahead
    get pelvisHeight() { return state.pelvisHeight; },    // live, because the hip drops with speed
    get hipWidth() { return rig.hipWidth; },
    setTheta(next) { state.theta = next.slice(); resync(); },
    setSpeed(next) { state.speed = next; resync(); },
    advance(dt) {
      hip.z += state.speed * dt;
      hip.y = terrain(hip.x, hip.z) + state.pelvisHeight;
      anchor.x = hip.x; anchor.z = hip.z + state.lead; anchor.y = hip.y;
      scheduler.update(dt, { hip: anchor, yaw: 0, velocity, hipWidth: rig.hipWidth, workspace: rig.workspace }, terrain);
      return scheduler.feet;
    },
  };
}

// Cross-check: cfgForSpeed must reproduce gaitForSpeed on the shipped coefficients, or the
// parameter vector has drifted away from the model it claims to represent.
export function agreesWithShippedModel(speed) {
  const mine = cfgForSpeed(GAIT_BASELINE, speed);
  const theirs = gaitForSpeed(speed);
  return Math.abs(mine.pelvisHeightRatio - theirs.pelvisHeightRatio) < 1e-12
    && Math.abs(mine.maxStepDistance - theirs.maxStepDistance) < 1e-12
    && Math.abs(mine.stepLift - theirs.stepLift) < 1e-12
    && Math.abs(mine.stepDuration - theirs.stepDuration) < 1e-12;
}
