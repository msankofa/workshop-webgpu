// body-locomotion.js — cyclic locomotion pose layer for the procedural body.
//
// The gait scheduler in player-procedural-body.js is REACTIVE: a foot sits until its error from
// the under-hip rest point crosses a trigger, then swings. That places feet well on terrain but
// produces no walk CYCLE, so nothing above the ankles knows a stride is happening — arms hang,
// hips stay square, feet stay flat, and the body reads as a puppet on strings.
//
// This module derives a continuous stride phase FROM the scheduler's own footfalls (it does not
// run its own clock, which would drift out of sync with the planted feet) and turns that phase
// into pose offsets for the arms, pelvis, shoulders, torso and ankles.
//
// Pure number math — no THREE — so test-body-locomotion.mjs can exercise it headlessly.

// Phase convention: 0 = left foot lifts, 0.5 = right foot lifts. `swingFrac` is the share of a
// stride a foot spends in the air, measured live, so a foot plants at phase `swingFrac`.

export const LOCOMOTION_DEFAULTS = Object.freeze({
  enabled: false,       // off by default: env-viewer and bot-viewer keep the old look until flipped
  // amplitude ramp with speed
  minSpeed: 0.15,       // below this the whole layer fades out (standing bodies stay neutral)
  speedRef: 3.0,        // speed at which amplitude reaches full
  fadeRate: 6,          // 1/s ease on the amplitude weight, so start/stop doesn't pop
  // phase lock
  syncRate: 7,          // 1/s pull of the phase toward an observed footfall
  strideSmoothing: 0.35,// EMA weight for each new stride-period measurement
  minStride: 0.34,      // clamps on the measured stride period (s)
  maxStride: 2.2,
  // arms (contralateral swing; radians of shoulder rotation at full amplitude)
  armSwing: 0.62,
  armAsym: 0.8,         // the backward half of the swing is this fraction of the forward half
  armSpread: 0.05,      // outward drift (m) at the extremes, so arms don't scythe the hips
  // pelvis / shoulders (radians at full amplitude)
  pelvisRoll: 0.085,    // hip drops over the unsupported (swinging) leg
  pelvisYaw: 0.10,      // pelvis rotates to carry the swinging leg forward
  shoulderCounter: 0.75,// shoulders counter-rotate by this fraction of pelvisYaw
  torsoLean: 0.030,     // forward lean, radians per m/s (not phase-driven)
  torsoLeanMax: 0.20,
  // vertical / lateral travel of the mass
  bob: 0.034,           // m peak-to-peak; highest at mid-stance, lowest at double support
  sway: 0.055,          // fraction of body radius, toward the stance foot
  // ankles (radians)
  heelStrike: 0.30,     // toes-up at plant
  toeOff: 0.42,         // toes-down at lift
});

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
const wrap01 = (v) => v - Math.floor(v);
// Shortest signed distance from `from` to `to` on a unit circle, in (-0.5, 0.5].
const phaseErr = (from, to) => { let d = wrap01(to - from); if (d > 0.5) d -= 1; return d; };

export function createLocomotionState() {
  return {
    phase: 0,           // 0..1 stride phase, locked to observed footfalls
    stridePeriod: 0.9,  // s per full stride (both feet), measured
    swingFrac: 0.4,     // share of a stride a foot is airborne, measured
    weight: 0,          // 0..1 eased amplitude
    err: 0,             // outstanding phase correction, bled in over time
    clock: 0,
    lastLift: { left: -1, right: -1 },
    wasStepping: { left: false, right: false },
    started: false,     // true once a footfall has been seen, so phase means something
    pose: {
      weight: 0, phase: 0, stridePeriod: 0.9, swingFrac: 0.4,
      // signed 0..1-ish signals, useful for debug readouts
      legForward: { left: 0, right: 0 },
      // applied pose offsets
      armSwing: { left: 0, right: 0 },   // rad, + = shoulder forward
      armSpread: { left: 0, right: 0 },  // m, + = outward from the spine
      anklePitch: { left: 0, right: 0 }, // rad about the body's local X, + = toes down
      pelvisRoll: 0,      // rad about the body's local +Z (forward); + drops the LEFT side
      pelvisYaw: 0,       // rad about the body's local +Y (up), right-handed
      shoulderYaw: 0,     // rad about local +Y, counter to pelvisYaw
      torsoLean: 0,       // rad about local +X, + = lean forward
      bob: 0,             // m, added to pelvis height
      sway: 0,            // fraction of radius, + = toward the body's local +X (right)
    },
  };
}

// Ankle pitch across one foot's own cycle. `fp` is that foot's phase (0 at its lift), so the
// curve runs toe-off -> airborne neutral -> toes-up at plant -> flat through stance -> toe-off.
// Continuous at both boundaries: both branches meet at -heelStrike (plant) and +toeOff (lift).
function ankleCurve(fp, swingFrac, cfg) {
  if (fp < swingFrac) {
    const s = swingFrac > 1e-4 ? fp / swingFrac : 0;
    return cfg.toeOff * (1 - smoothstep(0, 0.38, s)) - cfg.heelStrike * smoothstep(0.55, 1, s);
  }
  const t = (fp - swingFrac) / Math.max(1e-4, 1 - swingFrac);
  return -cfg.heelStrike * (1 - smoothstep(0, 0.28, t)) + cfg.toeOff * smoothstep(0.74, 1, t);
}

/**
 * Advance the locomotion phase and rebuild the pose offsets. Mutates and returns `state.pose`.
 *
 * @param {object} state  from createLocomotionState()
 * @param {number} dt
 * @param {{speed:number, feet:{left:object,right:object}}} input  `feet` are the gait scheduler's
 *        foot states; only `.stepping` and `.stepDur` are read.
 * @param {object} cfg  merged LOCOMOTION_DEFAULTS
 */
export function stepLocomotion(state, dt, input, cfg) {
  const pose = state.pose;
  const speed = Math.max(0, input.speed || 0);
  const feet = input.feet;
  state.clock += dt;

  // --- lock the phase to real footfalls ------------------------------------------------------
  // A lift (stepping false->true) is the event: left lifts at phase 0, right at 0.5. The gap
  // between alternating lifts is half a stride, which is also the freshest cadence measurement.
  for (const key of ['left', 'right']) {
    const stepping = !!feet?.[key]?.stepping;
    const lifted = stepping && !state.wasStepping[key];
    state.wasStepping[key] = stepping;
    if (!lifted) continue;
    const other = key === 'left' ? 'right' : 'left';
    if (state.lastLift[other] >= 0) {
      const half = state.clock - state.lastLift[other];
      if (half > 1e-3) {
        const measured = clamp(half * 2, cfg.minStride, cfg.maxStride);
        state.stridePeriod += (measured - state.stridePeriod) * cfg.strideSmoothing;
      }
    }
    state.lastLift[key] = state.clock;
    const dur = feet[key].stepDur;
    // Eased, not assigned: swingFrac positions both the leg's forward peak and the ankle curve's
    // stance/swing boundary, so stepping it would step the whole pose with it.
    if (dur > 0) {
      const measured = clamp(dur / state.stridePeriod, 0.15, 0.75);
      state.swingFrac += (measured - state.swingFrac) * cfg.strideSmoothing;
    }
    const target = key === 'left' ? 0 : 0.5;
    if (!state.started) { state.phase = target; state.err = 0; state.started = true; }
    else state.err = phaseErr(state.phase, target);
  }

  state.phase = wrap01(state.phase + dt / Math.max(1e-3, state.stridePeriod));
  // Bleed the outstanding correction in rather than snapping — a snap is itself a visible hitch.
  if (state.err !== 0) {
    const corr = state.err * Math.min(1, cfg.syncRate * dt);
    state.phase = wrap01(state.phase + corr);
    state.err -= corr;
    if (Math.abs(state.err) < 1e-5) state.err = 0;
  }

  // --- amplitude ------------------------------------------------------------------------------
  const targetW = clamp01((speed - cfg.minSpeed) / Math.max(1e-3, cfg.speedRef - cfg.minSpeed));
  state.weight += (targetW - state.weight) * (1 - Math.exp(-cfg.fadeRate * Math.max(0, dt)));
  const w = state.weight;

  // --- signals --------------------------------------------------------------------------------
  // Offset so a leg's forward peak lands where it actually plants (phase == swingFrac) instead of
  // at an assumed half-cycle. legForward is +1 fully forward, -1 fully behind.
  const off = 0.5 - state.swingFrac;
  const th = TAU * (state.phase + off);
  const legL = -Math.cos(th);
  const legR = -legL;
  const swingSide = Math.sin(TAU * state.phase);   // +1 when the LEFT leg is mid-swing

  pose.weight = w;
  pose.phase = state.phase;
  pose.stridePeriod = state.stridePeriod;
  pose.swingFrac = state.swingFrac;
  pose.legForward.left = legL;
  pose.legForward.right = legR;

  // Arms swing opposite their own leg. The backward half is damped: a real arm trails less than
  // it leads, and a symmetric swing reads as a pendulum.
  for (const key of ['left', 'right']) {
    const a = key === 'left' ? -legL : -legR;
    pose.armSwing[key] = cfg.armSwing * w * (a >= 0 ? a : a * cfg.armAsym);
    pose.armSpread[key] = cfg.armSpread * w * Math.abs(a);
  }

  pose.pelvisRoll = cfg.pelvisRoll * w * swingSide;
  pose.pelvisYaw = -cfg.pelvisYaw * w * legL;
  pose.shoulderYaw = -pose.pelvisYaw * cfg.shoulderCounter;
  pose.torsoLean = Math.min(cfg.torsoLeanMax, cfg.torsoLean * speed) * w;
  // Two dips per stride. The mass is HIGHEST at mid-stance and lowest at double support, which is
  // the opposite of a per-step sine that collapses to zero whenever both feet are down.
  pose.bob = -Math.cos(2 * TAU * state.phase) * cfg.bob * 0.5 * w;
  pose.sway = cfg.sway * w * swingSide;

  pose.anklePitch.left = ankleCurve(state.phase, state.swingFrac, cfg) * w;
  pose.anklePitch.right = ankleCurve(wrap01(state.phase - 0.5), state.swingFrac, cfg) * w;

  return pose;
}

/** Bundles state + config, mirroring createGaitScheduler's shape. */
export function createLocomotion(overrides = {}) {
  const cfg = { ...LOCOMOTION_DEFAULTS, ...overrides };
  const state = createLocomotionState();
  return {
    cfg,
    state,
    get pose() { return state.pose; },
    update(dt, input) { return stepLocomotion(state, dt, input, cfg); },
  };
}
