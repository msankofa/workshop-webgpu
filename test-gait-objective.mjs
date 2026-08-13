// Tests for the real-gait scoring harness. Run: node test-gait-objective.mjs
//
// This exercises the SHIPPED scheduler in player-procedural-body.js, so a failure here means either
// the harness drifted or the gait scheduler changed behaviour.
import {
  GAIT_PARAMS, GAIT_BOUNDS, GAIT_BASELINE, GAIT_INDEX, SPEED_SWEEP, HEIGHT_SWEEP, REFERENCE_PHASES,
  TERRAINS, RIG, BONES, LEG_REACH, TWO_BONE_CLAMP, REFERENCE_HEIGHT, BOT_RADIUS, CROUCH_FLOOR,
  WALK_SPEED, RUN_SPEED, rigFor, reachCliffHeight, shippedStepDuration,
  cfgForSpeed, simulateWalk, penaltyFor, sampleGait, scoreGait, profileGait,
  baselineTheta, agreesWithShippedModel, createWalker, leanAngleFor, leadFor,
} from './gait-objective.js';
import {
  GAIT_DEFAULTS, GAIT_SPEED_MODEL, LEG_WORKSPACE_DEFAULTS, BODY_DESIGN_DEFAULTS,
  effectiveStepDuration,
} from './player-procedural-body.js';
import { LOCOMOTION_DEFAULTS } from './body-locomotion.js';
import { mulberry32 } from './spsa.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name); }
}
const set = (k, v) => { const t = GAIT_BASELINE.slice(); t[GAIT_INDEX[k]] = v; return t; };

// The parameter vector must actually BE the shipped model, or the baseline is a straw man.
{
  check('11 tunable parameters', GAIT_PARAMS.length === 11 && GAIT_BOUNDS.length === 11);
  check('GAIT_INDEX covers every parameter',
    GAIT_PARAMS.every((p, i) => GAIT_INDEX[p.key] === i) && Object.keys(GAIT_INDEX).length === 11);
  check('every base value sits inside its bounds',
    GAIT_PARAMS.every(p => p.base >= p.min && p.base <= p.max));
  check('cfgForSpeed reproduces the shipped gaitForSpeed exactly',
    SPEED_SWEEP.every(agreesWithShippedModel) && [0.5, 1.7, 4.4, 7.7].every(agreesWithShippedModel));
  check('baselineTheta is a copy, not the shared array',
    baselineTheta() !== GAIT_BASELINE && baselineTheta().every((v, i) => v === GAIT_BASELINE[i]));
}

// Only parameters the rig actually reads may be tuned.
{
  const keys = GAIT_PARAMS.map(p => p.key);
  check('lookAhead is not tuned (nothing in the module reads it)', !keys.some(k => /look/i.test(k)));
  // pelvisHeightRatio IS tuned now: update() writes it from the speed model every frame (:1502)
  // and it is the single biggest lever on whether a leg can reach the ground.
  check('pelvis height is tuned', keys.includes('pelvisBase') && keys.includes('pelvisSlope'));
  check('pelvis params reproduce the shipped fit',
    GAIT_PARAMS[GAIT_INDEX.pelvisBase].base === GAIT_SPEED_MODEL.pelvisHeightRatio.b
    && GAIT_PARAMS[GAIT_INDEX.pelvisSlope].base === GAIT_SPEED_MODEL.pelvisHeightRatio.m);
  // The module's own words: "Keep pelvisHeightRatio below legLen/H (0.62)".
  check('pelvis upper bound is the module stated limit', GAIT_PARAMS[GAIT_INDEX.pelvisBase].max === 0.62);
  const cfg = cfgForSpeed(GAIT_BASELINE, 2.40);
  check('cfg carries the scheduler defaults it does not override',
    cfg.standSpeed === GAIT_DEFAULTS.standSpeed && cfg.teleportDistance === GAIT_DEFAULTS.teleportDistance);
  check('cfg clamps stay inside the shipped ranges',
    cfgForSpeed(GAIT_BASELINE, 99).stepDuration >= 0.1 && cfgForSpeed(GAIT_BASELINE, 99).maxStepDistance >= 0.15);
}

// The sweeps must describe the thing being tuned for, not an invented spread.
{
  check('four swept speeds', SPEED_SWEEP.length === 4);
  // BOT_MOVE_SPEED 2.4, runMultiplier 1.7, crouchSpeedFactor 0.55, dashSpeedBonus 1.15.
  check('speeds are the real bot speeds',
    Math.abs(SPEED_SWEEP[0] - 2.4 * 0.55) < 0.01 && Math.abs(SPEED_SWEEP[1] - 2.4) < 1e-12
    && Math.abs(SPEED_SWEEP[2] - 2.4 * 1.7) < 0.01 && Math.abs(SPEED_SWEEP[3] - 2.4 * 1.7 * 1.15) < 0.01);
  check('heights bracket the reference body',
    HEIGHT_SWEEP.includes(REFERENCE_HEIGHT) && Math.min(...HEIGHT_SWEEP) < REFERENCE_HEIGHT
    && Math.max(...HEIGHT_SWEEP) > REFERENCE_HEIGHT);
}

// Rig proportions must follow the shipped design defaults, not be hardcoded.
{
  check('bones follow BODY_DESIGN_DEFAULTS',
    Math.abs(BONES.thigh + BONES.shin - REFERENCE_HEIGHT * BODY_DESIGN_DEFAULTS.legLenRatio) < 1e-12);
  check('thigh and shin are unequal (0.52 / 0.48 split)', Math.abs(BONES.thigh - BONES.shin) > 0.02);
  check('LEG_REACH is the solver clamp, not full extension',
    Math.abs(LEG_REACH - (BONES.thigh + BONES.shin) * TWO_BONE_CLAMP) < 1e-12 && TWO_BONE_CLAMP < 1);
  check('RIG.pelvisHeight is the standing pelvis from the speed model',
    Math.abs(RIG.pelvisHeight - REFERENCE_HEIGHT * GAIT_SPEED_MODEL.pelvisHeightRatio.b) < 1e-12);
  check('pelvis sits below full leg extension', RIG.pelvisHeight < LEG_REACH);

  // Bones do NOT scale with body height (:724-730, :1625) but the workspace does (:1513-1519).
  const tall = rigFor(2.0), short = rigFor(1.6);
  check('workspace scales with body height', tall.workspace.forward > short.workspace.forward);
  check('workspace scale is exactly height/H',
    Math.abs(tall.workspace.forward - LEG_WORKSPACE_DEFAULTS.forward * (2.0 / REFERENCE_HEIGHT)) < 1e-12);
  check('the reference body gets the unscaled workspace',
    rigFor(REFERENCE_HEIGHT).workspace.forward === LEG_WORKSPACE_DEFAULTS.forward);
  check('hip width comes from the bot radius and hipWidthRatio',
    Math.abs(rigFor().hipWidth - BOT_RADIUS * 2 * GAIT_DEFAULTS.hipWidthRatio) < 1e-12);

  // The planning workspace is far wider than a straight leg spans horizontally. This is the whole
  // reason planted feet end up past reach, and constrainFootTarget cannot catch it because its
  // maxReach bound is purely horizontal (:152) and never sees the drop to the ground.
  const span = Math.sqrt(LEG_REACH ** 2 - RIG.pelvisHeight ** 2);
  check('a straight leg spans ~0.35 m horizontally', Math.abs(span - 0.348) < 0.01);
  check('planning workspace far exceeds anatomical reach', LEG_WORKSPACE_DEFAULTS.maxReach > span * 1.8);
  // Above this height a standing leg cannot touch the ground at all, and the player's Stand slider
  // in environment-viewer.html goes to 2.5.
  check('the reach cliff is ~1.895 m', Math.abs(reachCliffHeight() - 1.895) < 0.005);
  // The top of the sweep is deliberately PAST the cliff. At 1.9 m the standing pelvis sits at
  // 1.118 m and the leg reaches 1.115 m, so the foot cannot touch the ground at all - the height
  // band is chosen to include that failure rather than to avoid it.
  check('the sweep reaches past the cliff on purpose', Math.max(...HEIGHT_SWEEP) > reachCliffHeight());
  check('the reference body is comfortably under it', REFERENCE_HEIGHT < reachCliffHeight());
}

// A walk on flat ground with the shipped model must be clean by every measure.
{
  const m = simulateWalk(GAIT_BASELINE, { speed: 2.40, terrain: TERRAINS.flat(), duration: 4 });
  check('baseline walks on flat ground', m.steps > 4 && !m.stalled);
  check('flat ground: no clipping', m.clip === 0);
  check('flat ground: never airborne at default overlap', m.airborne === 0);
  check('flat ground: feet alternate evenly', m.asymmetry < 0.02);
  check('flat ground: stride is regular', m.irregularity < 0.05);
  check('flat ground: hips are not crouched', m.crouch === 0);
  check('all metrics finite', Object.values(m).every(v => typeof v !== 'number' || Number.isFinite(v)));
}

// Faster walking must produce longer strides - a basic sanity check on the sweep.
{
  const slow = simulateWalk(GAIT_BASELINE, { speed: 1.32, terrain: TERRAINS.flat(), duration: 4 });
  const fast = simulateWalk(GAIT_BASELINE, { speed: 4.69, terrain: TERRAINS.flat(), duration: 4 });
  check('stride grows with speed', fast.meanStep > slow.meanStep * 1.5);
  check('steps per metre falls with speed', fast.stepsPerMetre < slow.stepsPerMetre);
  check('step rate is reported', slow.stepRate > 0 && fast.stepRate > slow.stepRate);
}

// Each penalty term has to actually fire on something, or it is not constraining anything.
{
  // overlap lets both feet leave the ground. Only a defect at walking speed, so it is checked there.
  const air = simulateWalk(set('overlap', 0.6), { speed: 1.32, terrain: TERRAINS.rolling(1.7), duration: 4 });
  check('overlap 0.6 puts both feet airborne at a walk', air.airborne > 0.05);
  check('airborne is penalised', scoreGait(set('overlap', 0.6)) < scoreGait(GAIT_BASELINE));

  // ...but a flight phase at RUN speed is running, not a bug, and must not be scored as one.
  const fastAir = simulateWalk(set('overlap', 0.6), { speed: 4.69, terrain: TERRAINS.flat(), duration: 4 });
  check('a flight phase above RUN_SPEED is not penalised', fastAir.airborne === 0);
  check('the walk/run band is ordered and non-degenerate', WALK_SPEED < RUN_SPEED);

  // minimum lift over short-wavelength crests is the clipping term
  let clipped = 0;
  for (const phase of [0, 1.05, 2.1, 3.15, 4.2, 5.25]) {
    const m = simulateWalk(set('liftBase', 0.02), { speed: 2.40, terrain: TERRAINS.rolling(phase), duration: 4 });
    if (m.clip > 0) clipped++;
  }
  check('minimum lift clips through crests on some phases', clipped >= 2);
  check('excessive lift is penalised by float', scoreGait(set('liftBase', 0.6)) < scoreGait(GAIT_BASELINE));

  // very slow cadence lets the hip outrun the planted foot
  const slowCad = simulateWalk(set('cadenceA', 0.45), { speed: 4.69, terrain: TERRAINS.flat(), duration: 4 });
  check('slow cadence causes reach violation', slowCad.reach > 0.01);

  // Cadence is a don't-regress rule measured against the shipped model at that same speed, using
  // the EFFECTIVE duration. Checking cfg.stepDuration instead let the search set it high while
  // driving the effective value to the floor through maxStepDistance.
  const fastCad = simulateWalk(set('cadenceA', 0.10), { speed: 4.69, terrain: TERRAINS.flat(), duration: 4 });
  check('faster-than-shipped cadence trips the jitter term', fastCad.jitter > 0);
  check('the shipped model never trips its own cadence rule',
    SPEED_SWEEP.every(v => simulateWalk(GAIT_BASELINE, { speed: v, terrain: TERRAINS.flat(), duration: 4 }).jitter === 0));
  check('shippedStepDuration matches the module on the shipped cfg',
    SPEED_SWEEP.every(v => Math.abs(shippedStepDuration(v)
      - effectiveStepDuration(v, { ...GAIT_DEFAULTS, ...cfgForSpeed(GAIT_BASELINE, v) })) < 1e-12));
  // The exploit this closes: a high configured duration with a tiny stride cap still steps fast.
  const sneaky = GAIT_BASELINE.slice();
  sneaky[GAIT_INDEX.cadenceA] = 0.45; sneaky[GAIT_INDEX.cadenceB] = 0;
  sneaky[GAIT_INDEX.strideBase] = 0.40; sneaky[GAIT_INDEX.strideSlope] = 0;
  const sneakyM = simulateWalk(sneaky, { speed: 4.69, terrain: TERRAINS.flat(), duration: 4 });
  check('a long configured duration with a tiny stride still trips jitter', sneakyM.jitter > 0);

  // Dropping the hips is the cheapest way to fake good foot placement, so it costs. The term is
  // now a BACKSTOP rather than the working constraint: the pelvis bounds were tightened after the
  // search squatted to 0.40 of body height, and they alone already keep the ratio above the floor.
  // Both facts are asserted, so widening the bounds later re-arms the penalty instead of silently
  // reopening the exploit.
  const lowest = GAIT_PARAMS[GAIT_INDEX.pelvisBase].min
    + GAIT_PARAMS[GAIT_INDEX.pelvisSlope].min * Math.max(...SPEED_SWEEP);
  check('the pelvis bounds alone keep the hips above the crouch floor', lowest > CROUCH_FLOOR);
  check('the crouch term does fire below the floor',
    penaltyFor({ clip: 0, reach: 0, airborne: 0, asymmetry: 0, irregularity: 0, float: 0, jitter: 0,
      crouch: CROUCH_FLOOR - 0.4, slidePlanted: 0, slideSwing: 0, stalled: false }) > 0);
  check('the shipped model never trips the crouch rule',
    SPEED_SWEEP.every(v => simulateWalk(GAIT_BASELINE, { speed: v, terrain: TERRAINS.flat(), duration: 4 }).crouch === 0));
  check('crouch floor is below the shipped standing hip', CROUCH_FLOOR < GAIT_SPEED_MODEL.pelvisHeightRatio.b);
}

// Foot slide past leg reach. This IS scored, unlike the earlier `overextend` diagnostic it replaced:
// solveTwoBone clamps the end effector to 0.999 of full extension (:1328) and there is no FABRIK on
// the legs, so an out-of-reach target means the drawn foot is not where the simulation put it.
{
  const slow = simulateWalk(GAIT_BASELINE, { speed: 1.32, terrain: TERRAINS.rolling(0), duration: 4 });
  const fast = simulateWalk(GAIT_BASELINE, { speed: 4.69, terrain: TERRAINS.rolling(0), duration: 4 });
  check('slide is measured for planted and swinging feet separately',
    Number.isFinite(slow.slidePlanted) && Number.isFinite(slow.slideSwing));
  check('slide is non-negative', slow.slidePlanted >= 0 && slow.slideSwing >= 0);
  check('slide rises sharply with speed', fast.slidePlanted > slow.slidePlanted * 5);
  check('overextend is still reported as a fraction',
    fast.overextend > slow.overextend && fast.overextend <= 1 && slow.overextend >= 0);

  const clean = {
    clip: 0, reach: 0, airborne: 0, asymmetry: 0, irregularity: 0, float: 0, jitter: 0,
    crouch: 0, slidePlanted: 0, slideSwing: 0, stalled: false,
  };
  check('planted slide costs more than swing slide',
    penaltyFor({ ...clean, slidePlanted: 0.1 }) > penaltyFor({ ...clean, slideSwing: 0.1 }));
  check('planted slide is weighted near ground clipping',
    penaltyFor({ ...clean, slidePlanted: 0.1 }) > penaltyFor({ ...clean, clip: 0.1 }) * 0.5);
  // overextend is now a readout only: moving it alone must not move the penalty.
  check('overextend itself does not enter the penalty',
    penaltyFor({ ...clean, overextend: 0 }) === penaltyFor({ ...clean, overextend: 1, overextendWorst: 5 }));
  check('profileGait reports slide and overextend',
    profileGait(GAIT_BASELINE).every(r => Number.isFinite(r.slidePlanted) && Number.isFinite(r.overextend)));

  // Measured from the HIP SOCKET, not the pelvis centre: the leg hangs off a socket offset
  // laterally by half the hip width (:1735). Measuring from the centre overstates the lateral term.
  const wide = simulateWalk(GAIT_BASELINE, { speed: 4.69, terrain: TERRAINS.rolling(0), duration: 4, radius: 0.6 });
  check('hip width enters the slide measurement', wide.slidePlanted !== fast.slidePlanted);
}

// Lean into step. Must default to a no-op, and must be a fraction of hip travel rather than a
// projection of the torso lean - the lean saturates at torsoLeanMax and cannot reach far enough.
{
  const iLead = GAIT_INDEX.leadScale;
  check('leadScale defaults to 0 (no behaviour change)', GAIT_PARAMS[iLead].base === 0);

  check('lean angle comes from LOCOMOTION_DEFAULTS',
    Math.abs(leanAngleFor(2) - LOCOMOTION_DEFAULTS.torsoLean * 2) < 1e-12);
  check('lean angle caps at torsoLeanMax', leanAngleFor(1000) === LOCOMOTION_DEFAULTS.torsoLeanMax);
  check('lean angle is 0 at rest and never negative', leanAngleFor(0) === 0 && leanAngleFor(-5) === 0);

  const cfg = cfgForSpeed(GAIT_BASELINE, 4.69);
  check('lead is zero at scale 0', leadFor(4.69, 0, cfg) === 0);
  check('lead grows with scale', leadFor(4.69, 0.8, cfg) > leadFor(4.69, 0.4, cfg));
  check('lead grows with speed',
    leadFor(4.69, 0.5, cfgForSpeed(GAIT_BASELINE, 4.69)) > leadFor(1.32, 0.5, cfgForSpeed(GAIT_BASELINE, 1.32)));
  check('lead is scale * speed * effective step duration',
    Math.abs(leadFor(4.69, 0.5, cfg) - 0.5 * 4.69 * effectiveStepDuration(4.69, cfg)) < 1e-12);
  // The point of replacing the lean projection: it could never have offered enough.
  check('lead exceeds anything the lean projection could reach',
    leadFor(4.69, 1, cfg) > 3 * RIG.pelvisHeight * Math.tan(LOCOMOTION_DEFAULTS.torsoLeanMax));

  // scale 0 must reproduce the pre-existing behaviour bit for bit
  const a = simulateWalk(set('leadScale', 0), { speed: 4.08, terrain: TERRAINS.rolling(1.7), duration: 3 });
  const b = simulateWalk(GAIT_BASELINE, { speed: 4.08, terrain: TERRAINS.rolling(1.7), duration: 3 });
  check('leadScale 0 is exactly the baseline',
    a.clip === b.clip && a.reach === b.reach && a.meanStep === b.meanStep && a.slidePlanted === b.slidePlanted);

  // and turning it up must actually move the feet forward, cutting the drag on planted legs
  const off = simulateWalk(set('leadScale', 0), { speed: 4.69, terrain: TERRAINS.rolling(0), duration: 4 });
  const on = simulateWalk(set('leadScale', 0.75), { speed: 4.69, terrain: TERRAINS.rolling(0), duration: 4 });
  check('leaning in cuts planted slide by most of it', on.slidePlanted < off.slidePlanted * 0.2);
  check('leaning in cuts over-extension', on.overextend < off.overextend);
  check('leaning in improves the score', scoreGait(set('leadScale', 0.75)) > scoreGait(GAIT_BASELINE) + 1);
  check('leaning in leaves cadence alone', on.stepRate === off.stepRate);
  check('leaning in leaves the hips alone', on.pelvisHeight === off.pelvisHeight);
  // Too much lead overshoots the other way, so the optimum is interior rather than at a bound.
  check('the lead optimum is interior',
    scoreGait(set('leadScale', 0.55)) > scoreGait(set('leadScale', GAIT_PARAMS[iLead].max)));

  // the live walker must expose what the drawing needs
  const w = createWalker(set('leadScale', 1), { speed: 4.08 });
  check('walker exposes lean', Math.abs(w.lean - leanAngleFor(4.08)) < 1e-12);
  check('walker exposes lead',
    Math.abs(w.lead - leadFor(4.08, 1, cfgForSpeed(set('leadScale', 1), 4.08))) < 1e-12);
  check('walker exposes a live pelvis height',
    Math.abs(w.pelvisHeight - REFERENCE_HEIGHT * cfgForSpeed(GAIT_BASELINE, 4.08).pelvisHeightRatio) < 1e-12);
  w.setSpeed(1.32);
  check('walker pelvis follows a speed change (the hip drops with speed)',
    w.pelvisHeight > REFERENCE_HEIGHT * cfgForSpeed(GAIT_BASELINE, 4.08).pelvisHeightRatio);
  w.setTheta(GAIT_BASELINE);
  check('walker lead follows a theta change', w.lead === 0);
}

// penaltyFor is non-negative and zero only for a clean walk.
{
  const cleanish = {
    clip: 0, reach: 0, airborne: 0, asymmetry: 0, irregularity: 0, float: 0, jitter: 0,
    crouch: 0, slidePlanted: 0, slideSwing: 0, stalled: false,
  };
  check('clean metrics carry no penalty', penaltyFor(cleanish) === 0);
  for (const k of ['clip', 'reach', 'airborne', 'asymmetry', 'irregularity', 'float', 'jitter',
    'crouch', 'slidePlanted', 'slideSwing']) {
    check(`${k} increases the penalty`, penaltyFor({ ...cleanish, [k]: 0.5 }) > 0);
  }
  check('a stalled gait is penalised', penaltyFor({ ...cleanish, stalled: true }) > 0);
}

// The reference score must average over terrain phases - one phase hides the clipping term entirely.
{
  check('more than one reference phase', REFERENCE_PHASES.length >= 3);
  const lowLift = set('liftBase', 0.02);
  lowLift[GAIT_INDEX.liftSlope] = 0;
  const anyClip = REFERENCE_PHASES.some(phase =>
    SPEED_SWEEP.some(speed => simulateWalk(lowLift, { speed, terrain: TERRAINS.rolling(phase), duration: 4 }).clip > 0));
  check('the reference phase set does expose clipping', anyClip);
}

// Score shape and stability.
{
  const base = scoreGait(GAIT_BASELINE);
  check('the shipped model leaves real room to improve', base > 2 && base < 3);
  check('score is deterministic', scoreGait(GAIT_BASELINE) === base);
  check('shorter reference walks roughly agree with longer ones',
    Math.abs(scoreGait(GAIT_BASELINE, { duration: 1.6 }) - scoreGait(GAIT_BASELINE, { duration: 2.4 })) < 0.06);
  check('score never exceeds the ceiling', base <= 4 + 1e-12);
  // The score has to average over heights, or it is tuning for one body.
  check('the score spans the height sweep',
    scoreGait(GAIT_BASELINE, { heights: [1.7] }) !== scoreGait(GAIT_BASELINE, { heights: [1.9] }));
}

// The noisy sample is genuinely noisy, and unbiased enough to optimise against.
{
  const rng = mulberry32(5);
  const xs = Array.from({ length: 400 }, () => sampleGait(GAIT_BASELINE, rng, { duration: 1.6 }));
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
  check('sampled score varies run to run', sd > 0.01);
  check('sampled mean is near the clean reference', Math.abs(mean - scoreGait(GAIT_BASELINE)) < 0.5);
  check('sampled score respects the ceiling', xs.every(v => v <= 4 + 1e-12));
}

// profileGait reports one row per swept speed.
{
  const rows = profileGait(GAIT_BASELINE);
  check('one profile row per speed', rows.length === SPEED_SWEEP.length);
  check('profile speeds match the sweep', rows.every((r, i) => r.speed === SPEED_SWEEP[i]));
  check('profile penalties are non-negative', rows.every(r => r.penalty >= -1e-12));
}

// The live walker must reproduce what the scorer simulates, and retune without resetting.
{
  const w = createWalker(GAIT_BASELINE, { speed: 2.40, terrainPhase: 0 });
  for (let i = 0; i < 240; i++) w.advance(1 / 60);
  check('walker advances down +z', w.hip.z > 6);
  check('walker keeps a foot on the ground', !(w.feet.left.stepping && w.feet.right.stepping));
  check('walker feet track the hip', Math.abs(w.feet.left.current.z - w.hip.z) < LEG_WORKSPACE_DEFAULTS.maxReach + 0.5);
  check('walker exposes the scaled rig', w.rig.workspace.forward === LEG_WORKSPACE_DEFAULTS.forward);

  const before = { z: w.feet.left.current.z, stepping: w.feet.left.stepping };
  const faster = set('cadenceA', 0.16);
  w.setTheta(faster);
  check('setTheta rewrites cfg in place', Math.abs(w.cfg.stepDuration - cfgForSpeed(faster, 2.40).stepDuration) < 1e-12);
  check('setTheta does not reset the feet',
    w.feet.left.current.z === before.z && w.feet.left.stepping === before.stepping);
  w.setSpeed(4.08);
  check('setSpeed updates cfg', Math.abs(w.cfg.stepDuration - cfgForSpeed(faster, 4.08).stepDuration) < 1e-12);
  for (let i = 0; i < 60; i++) w.advance(1 / 60);
  check('walker still walks after retuning', w.hip.z > 6);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
