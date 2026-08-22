// player-procedural-body.js
//
// Procedural player body: a generated humanoid rig (pelvis/torso/head boxes,
// two leg IK chains, stub arm IK chains) driven purely from player state —
// it never writes back to the controller. See:
//   docs/subsystems/procedural-body-weapon-contracts.md (Contracts 1-3, normative)
//   docs/superpowers/specs/2026-07-06-procedural-player-body-design.md
//
// THREE is injected (never imported here) so the pure gait-scheduler section
// below can be unit tested headlessly under plain node — see
// test-player-body-gait.mjs, which imports only createGaitScheduler /
// createFeetState / stepGait / GAIT_DEFAULTS and never touches THREE.
//
// Do not import the Creature class from port-creature-system.js: its
// physicsStep() moves the creature from its own feet/balance, which would
// fight the player controller. The KinematicChain FABRIK solver and
// terrainNormal helper below are narrow copies, not imports.

// The cyclic locomotion layer (arm swing, hip roll, ankle roll-through) lives in its own module
// because it is likewise THREE-free; it reads this file's foot states and returns pose offsets.
import { createLocomotion, LOCOMOTION_DEFAULTS } from './body-locomotion.js';
// Primitive vocabulary and the shared geometry cache. Also THREE-free at module scope, so the
// headless gait test above still imports this file without a renderer.
import { createGeometryCache, createPrimitiveFactory, GEAR_LOD_SEG } from './model-primitives.js';

// ============================================================================
// ===================== Pure gait scheduler (no THREE) ======================
// ============================================================================

const MIN_STEP_DURATION = 0.12; // fastest a single step may play, so sprints don't jitter

// Body geometry is identical across all instances (built from the fixed H/R constants and sized
// per-instance via mesh.scale), so one BufferGeometry per shape+dims is shared across every body.
// Keyed by a signature string; tagged userData.shared so destroy() never disposes a shared buffer.
// The cache lives in model-primitives.js so bodies and every other model target share one pool.
const _sharedBodyGeo = createGeometryCache();

// Design tools rebuild bodies hundreds of times per session with slightly different dimensions.
// Every distinct dimension mints a new cache entry (keyed by content), and each new geometry also
// mints a new InstancedMesh bucket downstream, so an unbounded cache leaks both here and in the
// batch pool. Callers that tear down every live body may clear it. NEVER call this while a body
// is alive: survivors hold references to geometries this drops, and rebuilding would duplicate.
export function clearSharedBodyGeometry() {
  _sharedBodyGeo.clear();
}

export const GAIT_DEFAULTS = Object.freeze({
  // Baseline = the authored "walk" profile. Keep pelvisHeightRatio below legLen/H (0.62) so the
  // feet can reach the ground with bend room.
  stepDuration: 0.31,
  stepLift: 0.45,
  triggerDistance: 0.28,
  maxStepDistance: 1.35,
  lookAhead: 0.16,
  pelvisHeightRatio: 0.58,
  hipWidthRatio: 0.42,
  // Not in Contract 3's baseline list but required to implement its
  // "settle-under-hips" and "teleport reset" behaviors:
  standSpeed: 0.12,       // horizontal speed (m/s) below which feet settle under hips
  teleportDistance: 2.5,  // horizontal hip jump (m) that forces an instant foot reset
  // Fraction of a swing the trailing foot may still have left when the next foot lifts. 0 is the
  // original strict alternation (one foot down at all times), which gives a plant-pause-plant
  // stride with no roll-through. Small values overlap the steps the way a real walk does.
  stepOverlap: 0,
  // Forward stride multiplies how far ahead of its rest spot a foot aims. maxBehind (m) is how
  // far a planted foot may trail behind the hip along the travel direction before it must lift;
  // 0 leaves that to triggerDistance alone.
  forwardStride: 1,
  maxBehind: 0,
});

// Per-foot horizontal workspace relative to the pelvis. The scheduler projects every planned
// step into this asymmetric volume before it can start, keeping feet on their own side and
// stopping the wide/crossed poses that unconstrained IK would otherwise allow.
export const LEG_WORKSPACE_DEFAULTS = Object.freeze({
  minLateral: 0.11,
  maxLateral: 0.48,
  forward: 0.62,
  backward: 0.46,
  maxReach: 0.76,
});

// Authored locomotion profiles (tuned in body-preview.html). `speed` is only a reference pace
// for standalone/preview movement; in-game the real controller supplies velocity. `gait` fields
// override GAIT_DEFAULTS for that mode (apply onto a body's `gait.cfg`).
export const LOCO_PROFILES = Object.freeze({
  walk: Object.freeze({ speed: 2.05, gait: Object.freeze({ pelvisHeightRatio: 0.58, maxStepDistance: 1.35, stepLift: 0.45, stepDuration: 0.31 }) }),
  run:  Object.freeze({ speed: 4.2,  gait: Object.freeze({ pelvisHeightRatio: 0.52, maxStepDistance: 1.35, stepLift: 0.45, stepDuration: 0.23 }) }),
});

// Continuous speed -> gait model, least-squares fit over sample gaits tuned across 0.5..7.7 m/s
// in body-preview.html (see its "Speed -> gait model" panel). pelvis/stride/lift are linear in
// speed; stepDuration is a power law (dur = A*v^B) so cadence tracks ~1/speed and never crosses
// zero when extrapolated fast. This supersedes the two-profile walk/run switch: a body created
// with `adaptGaitToSpeed:true` blends smoothly across the whole speed range.
export const GAIT_SPEED_MODEL = Object.freeze({
  pelvisHeightRatio: Object.freeze({ m: -0.0044077, b: 0.5884228 }), // linear: m*v + b
  maxStepDistance:   Object.freeze({ m: -0.0056028, b: 1.3602401 }),
  stepLift:          Object.freeze({ m: 0.0396757,  b: 0.3004214 }),
  stepDuration:      Object.freeze({ A: 0.2433621,  B: -0.1337564 }), // power law: A*v^B
});
const _clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/**
 * Evaluate the fitted speed->gait model. Pure (no THREE); returns the four speed-varying gait
 * fields clamped to the same sane ranges the preview enforces. Overlay onto a body's gait.cfg.
 * @param {number} speed  horizontal speed (m/s)
 * @param {object} [model] fit coefficients (defaults to GAIT_SPEED_MODEL)
 */
export function gaitForSpeed(speed, model = GAIT_SPEED_MODEL) {
  const v = Math.max(0, speed);
  return {
    pelvisHeightRatio: _clampN(model.pelvisHeightRatio.m * v + model.pelvisHeightRatio.b, 0.3, 0.85),
    maxStepDistance:   _clampN(model.maxStepDistance.m * v + model.maxStepDistance.b, 0.15, 1.6),
    stepLift:          _clampN(model.stepLift.m * v + model.stepLift.b, 0.02, 0.6),
    stepDuration:      _clampN(model.stepDuration.A * Math.pow(Math.max(v, 1e-3), model.stepDuration.B), 0.1, 0.45),
  };
}

// Selectable gait models, so a candidate can be compared against the shipped one on a live body
// rather than swapped in and hoped for. `movementTuning.gaitModel` names one of these keys.
//
// `tuned` came out of SPSA against gait-objective.js (run it with `node tune-gait.mjs`). Its speed
// fits are IDENTICAL to shipped, which is the result, not an oversight: an 11-parameter search
// scored 3.16 on the clean reference while adding the lead term alone scored 3.84, so the
// least-squares fit authored in body-preview.html is already good and the only thing missing from
// it was that the feet never accounted for hip travel during a swing.
//
// update() reads only `speed`. `triggerDistance`, `stepOverlap` and `stepLeadScale` are
// RECOMMENDATIONS for the UI to copy into its sliders - bot-viewer-v3.html already writes overlap
// straight onto gait.cfg every frame, so applying them here would fight the panel.
export const GAIT_MODELS = Object.freeze({
  shipped: Object.freeze({
    label: 'Shipped',
    note: 'The least-squares fit authored in body-preview.html. Feet land under the hips.',
    speed: GAIT_SPEED_MODEL,
    triggerDistance: GAIT_DEFAULTS.triggerDistance,
    stepOverlap: GAIT_DEFAULTS.stepOverlap,
    stepLeadScale: 0,
  }),
  tuned: Object.freeze({
    label: 'Tuned (lead)',
    note: 'Same coefficients, feet aimed at the hip travel they have to catch up on. At a dash the '
      + 'planted foot ends up 0.004 m past leg reach instead of 0.099 m, and is past it on 8% of '
      + 'ticks instead of 47%. Cadence, stride, hip height and lift are untouched.',
    speed: GAIT_SPEED_MODEL,
    triggerDistance: GAIT_DEFAULTS.triggerDistance,
    stepOverlap: GAIT_DEFAULTS.stepOverlap,
    // Tuned at bot-viewer-v3's stepOverlap of 0.22. The optimum falls as overlap rises (0.76 at 0,
    // 0.54 at 0.22, 0.38 at 0.33), so a viewer running a different overlap wants a different value.
    stepLeadScale: 0.55,
  }),
});

// ---- Lean into step (pure; see test-player-body-gait.mjs) --------------------------------
// A step's landing point is chosen at LIFT-OFF and never revised, so by the time the foot lands the
// hip has moved on by a full step of travel and the foot lands BEHIND it. Measured at 5.2 m/s the
// planted foot ranges from 0.36 m to 1.46 m behind the hip and is never once under it. These let
// update() anchor steps at a balance point ahead of the pelvis instead. Scale 0 = today's rig.
// Rationale and measurements in docs/subsystems/procedural-body-weapon-contracts.md.

/** Forward pitch the cyclic locomotion layer applies at this speed, in radians. */
export function leanAngleForSpeed(speed, cfg = LOCOMOTION_DEFAULTS) {
  return Math.min(cfg.torsoLeanMax, cfg.torsoLean * Math.max(0, speed));
}

/** What stepGait will actually use for this step's duration. Mirrors its effStepDur. */
export function effectiveStepDuration(speed, cfg = GAIT_DEFAULTS) {
  if (speed < cfg.standSpeed) return cfg.stepDuration;
  return Math.max(MIN_STEP_DURATION, Math.min(cfg.stepDuration, cfg.maxStepDistance / Math.max(speed, 0.5)));
}

/**
 * Metres to plant the feet ahead of the pelvis, as a fraction of the hip travel the foot has to
 * catch up on. 1 centres the planted foot under the hip; 0 (the default) is the shipped behaviour.
 */
export function stepLeadFor(speed, gaitCfg = GAIT_DEFAULTS, leadScale = 0) {
  if (!(leadScale > 0) || !(speed > 0)) return 0;
  // Capped at one stride. Step duration bottoms out at MIN_STEP_DURATION, so without this the lead
  // grows without limit with speed, and a launched or ragdolling body would aim its feet metres
  // into the distance. You cannot reach further ahead than a whole step.
  return Math.min(gaitCfg.maxStepDistance, leadScale * speed * effectiveStepDuration(speed, gaitCfg));
}

function easeInOut(t) { return t * t * (3 - 2 * t); }
function hyp(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep01(t) { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); }

// Rotates a body-local (x, 0, z) offset into world space by yaw. Matches the
// rotateXZ convention in port-creature-system.js: local +z is forward.
function rotateYawXZ(lx, lz, yaw) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return { x: lx * cy + lz * sy, z: -lx * sy + lz * cy };
}

// Projects a world-space foot candidate into one leg's permitted pelvis-local workspace.
// `side` is -1 for left and +1 for right, so the center-plane bound is asymmetric by design:
// feet can travel outward freely but never cross into the other leg's volume.
export function constrainFootTarget(target, hip, yaw, side, workspace = LEG_WORKSPACE_DEFAULTS) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const dx = target.x - hip.x, dz = target.z - hip.z;
  let lx = dx * cy - dz * sy;
  let lz = dx * sy + dz * cy;
  const sign = side < 0 ? -1 : 1;
  let lateral = sign * lx;
  lateral = Math.max(workspace.minLateral, Math.min(workspace.maxLateral, lateral));
  lz = Math.max(-workspace.backward, Math.min(workspace.forward, lz));
  const reach = Math.hypot(lateral, lz);
  if (reach > workspace.maxReach) {
    const scale = workspace.maxReach / reach;
    lateral *= scale;
    lz *= scale;
  }
  // maxReach may have pulled the point slightly inward; preserve the no-crossing plane.
  lateral = Math.max(workspace.minLateral, lateral);
  const world = rotateYawXZ(sign * lateral, lz, yaw);
  return { x: hip.x + world.x, y: target.y, z: hip.z + world.z };
}

function makeFootState(side) {
  return {
    side,                     // -1 left, +1 right
    current: { x: 0, y: 0, z: 0 },
    target: { x: 0, y: 0, z: 0 },
    rest: { x: 0, y: 0, z: 0 },
    stepStart: { x: 0, y: 0, z: 0 },
    stepEnd: { x: 0, y: 0, z: 0 },
    stepping: false,
    t: 0,
    stepDur: 0.2,             // this step's duration (speed-scaled), set at step start
    liftScale: 1,             // per-step lift multiplier, set from step distance at step start
    initialized: false,
  };
}

export function createFeetState() {
  return { left: makeFootState(-1), right: makeFootState(1) };
}

function snapFoot(foot, wx, wy, wz) {
  foot.rest.x = wx; foot.rest.y = wy; foot.rest.z = wz;
  foot.current.x = wx; foot.current.y = wy; foot.current.z = wz;
  foot.target.x = wx; foot.target.y = wy; foot.target.z = wz;
  foot.stepStart.x = wx; foot.stepStart.y = wy; foot.stepStart.z = wz;
  foot.stepEnd.x = wx; foot.stepEnd.y = wy; foot.stepEnd.z = wz;
  foot.stepping = false;
  foot.t = 0;
  foot.initialized = true;
}

/**
 * Advances a biped foot-step scheduler by one tick. Pure array/number math —
 * no THREE — so it can be exercised headlessly under plain node.
 *
 * @param {{left:object,right:object}} feet  from createFeetState()
 * @param {number} dt
 * @param {object} input  { hip:{x,y,z}, yaw, velocity:{x,y,z}, hipWidth }
 * @param {(x:number,z:number)=>number} terrainHeight
 * @param {object} cfg  merged GAIT_DEFAULTS (see createGaitScheduler)
 * @param {{lastHip:{x,y,z}|null}} memo  scratch the caller keeps across calls
 * @returns {{left:object,right:object}} the same `feet` object, mutated
 */
export function stepGait(feet, dt, input, terrainHeight, cfg, memo) {
  const hip = input.hip;
  const hipWidth = input.hipWidth ?? 0.34;
  const yaw = input.yaw || 0;
  const vx = input.velocity?.x || 0;
  const vz = input.velocity?.z || 0;
  const speed = Math.hypot(vx, vz);
  const workspace = input.workspace || LEG_WORKSPACE_DEFAULTS;
  const turnAmount = Math.abs(input.turnAmount || 0);
  const turnStepAngle = input.turnStepAngle ?? 0.20;

  const first = !feet.left.initialized || !feet.right.initialized;
  const teleported = !first && memo.lastHip &&
    hyp(hip.x, hip.z, memo.lastHip.x, memo.lastHip.z) > cfg.teleportDistance;

  // Rest (under-hip) anchors, recomputed every tick from the live hip pose.
  for (const foot of [feet.left, feet.right]) {
    const local = rotateYawXZ(foot.side * hipWidth * 0.5, 0, yaw);
    const wx = hip.x + local.x, wz = hip.z + local.z;
    const wy = terrainHeight(wx, wz);
    if (first || teleported) {
      snapFoot(foot, wx, wy, wz);
    } else {
      foot.rest.x = wx; foot.rest.y = wy; foot.rest.z = wz;
    }
  }

  memo.lastHip = { x: hip.x, y: hip.y, z: hip.z };
  if (first || teleported) return feet;

  const standing = speed < cfg.standSpeed;
  const moveDir = standing ? rotateYawXZ(0, 1, yaw) : { x: vx / speed, z: vz / speed };
  // Cadence scales with speed: faster movement -> quicker steps so the feet keep up with the
  // hip instead of stretching far ahead and looking frozen. cfg.stepDuration is the SLOW-speed
  // cap (the authored look); MIN_STEP_DURATION floors it so a sprint doesn't jitter.
  const effStepDur = standing
    ? cfg.stepDuration
    : Math.max(MIN_STEP_DURATION, Math.min(cfg.stepDuration, cfg.maxStepDistance / Math.max(speed, 0.5)));
  // Foot reaches ~one step ahead of the hip (where the hip will be when it plants).
  const aheadDist = standing ? 0 : Math.min(cfg.maxStepDistance, speed * effStepDur) * (cfg.forwardStride ?? 1);
  // While standing, tighten the step deadband so feet tidy up under the hips instead of
  // freezing wherever they last landed within the (larger) walking trigger distance.
  const turning = standing && turnAmount > turnStepAngle;
  const trigger = turning ? cfg.triggerDistance * 0.16 : (standing ? cfg.triggerDistance * 0.35 : cfg.triggerDistance);

  const fwdStride = cfg.forwardStride ?? 1;
  const strideWorkspace = fwdStride === 1 ? workspace
    : { ...workspace, forward: workspace.forward * fwdStride, maxReach: workspace.maxReach * Math.max(1, fwdStride) };
  const desired = {};
  for (const key of ['left', 'right']) {
    const foot = feet[key];
    const dx = foot.rest.x + moveDir.x * aheadDist;
    const dz = foot.rest.z + moveDir.z * aheadDist;
    const candidate = { x: dx, y: terrainHeight(dx, dz), z: dz };
    const constrained = constrainFootTarget(candidate, hip, yaw, foot.side, strideWorkspace);
    constrained.y = terrainHeight(constrained.x, constrained.z);
    desired[key] = constrained;
  }

  // Advance any foot currently mid-step.
  for (const key of ['left', 'right']) {
    const foot = feet[key];
    if (!foot.stepping) continue;
    foot.t += dt / (foot.stepDur || cfg.stepDuration);
    const tc = Math.min(foot.t, 1);
    const e = easeInOut(tc);
    foot.current.x = lerp(foot.stepStart.x, foot.stepEnd.x, e);
    foot.current.y = lerp(foot.stepStart.y, foot.stepEnd.y, e) + Math.sin(Math.PI * tc) * cfg.stepLift * foot.liftScale;
    foot.current.z = lerp(foot.stepStart.z, foot.stepEnd.z, e);
    if (foot.t >= 1) {
      foot.stepping = false;
      foot.t = 0;
      foot.current.x = foot.stepEnd.x;
      foot.current.y = foot.stepEnd.y;
      foot.current.z = foot.stepEnd.z;
    }
  }

  // Feet alternate: only one foot may begin a new step per tick, and never while the other is
  // already mid-step — unless stepOverlap allows the trailing foot to lift while the leading one
  // is finishing (its last `stepOverlap` fraction), which is what removes the plant-pause-plant
  // cadence. The airborne foot is already easing into its plant by then, so this never reads as
  // both feet flying: at the default 0 the gate is exactly the original one.
  const overlap = cfg.stepOverlap || 0;
  const blocking = (foot) => foot.stepping && foot.t < 1 - overlap;
  const anyStepping = blocking(feet.left) || blocking(feet.right);
  const wanters = [];
  for (const key of ['left', 'right']) {
    const foot = feet[key];
    const target = desired[key];
    foot.target.x = target.x; foot.target.y = target.y; foot.target.z = target.z;
    if (foot.stepping) continue;
    const dh = hyp(foot.current.x, foot.current.z, target.x, target.z);
    const dv = Math.abs(foot.current.y - target.y);
    // Signed distance the foot trails behind the hip along the travel direction.
    const behind = standing || !(cfg.maxBehind > 0) ? 0
      : -((foot.current.x - hip.x) * moveDir.x + (foot.current.z - hip.z) * moveDir.z);
    if (dh > trigger || dv > trigger * 0.6 || behind > cfg.maxBehind) wanters.push({ key, dh, urgent: behind > cfg.maxBehind });
  }
  // A foot trailing past maxBehind may lift while the other is still past mid-swing: that is the
  // flight phase of a run, and the only way a behind cap can hold at high cadence.
  const urgent = wanters.find(w => w.urgent);
  const otherPastMid = (key) => { const o = feet[key === 'left' ? 'right' : 'left']; return !o.stepping || o.t >= 0.5; };
  if ((!anyStepping || (urgent && otherPastMid(urgent.key))) && wanters.length) {
    // Alternate. Prefer the foot that did NOT step most recently, so a foot can't restart
    // the same tick it lands (the advance loop clears its `stepping` flag above, which would
    // otherwise let the first-checked foot re-take the single step slot forever and starve
    // the other one). A lone wanter (e.g. a large drift correction) steps unconditionally.
    let pick;
    if (anyStepping && urgent) {
      pick = urgent.key;
    } else if (wanters.length === 1) {
      pick = wanters[0].key;
    } else {
      pick = (wanters.find((w) => w.key !== memo.lastStepper) || wanters[0]).key;
    }
    const foot = feet[pick];
    foot.stepping = true;
    foot.t = 0;
    foot.stepStart.x = foot.current.x; foot.stepStart.y = foot.current.y; foot.stepStart.z = foot.current.z;
    foot.stepEnd.x = foot.target.x; foot.stepEnd.y = foot.target.y; foot.stepEnd.z = foot.target.z;
    // Scale lift by how far this step travels, so short turn/adjust steps don't float up to the
    // full stride height. A step of ~40% of max stride (or more) gets full lift.
    const stepDist = hyp(foot.stepStart.x, foot.stepStart.z, foot.stepEnd.x, foot.stepEnd.z);
    foot.liftScale = Math.min(1, Math.max(0.12, stepDist / Math.max(0.15, cfg.maxStepDistance * 0.4)));
    foot.stepDur = effStepDur;
    memo.lastStepper = pick;
  }

  return feet;
}

/**
 * Convenience wrapper bundling feet state + config + last-hip memo. Still
 * THREE-free; this is what both the headless test and the THREE rig below use.
 */
export function createGaitScheduler(overrides = {}) {
  const cfg = { ...GAIT_DEFAULTS, ...overrides };
  const feet = createFeetState();
  const memo = { lastHip: null };
  return {
    feet,
    cfg,
    update(dt, input, terrainHeight) {
      return stepGait(feet, dt, input, terrainHeight, cfg, memo);
    },
    // Forces both feet to re-plant under the hips on the next update (landing, teleport).
    resetFeet() {
      feet.left.initialized = false;
      feet.right.initialized = false;
      memo.lastHip = null;
    },
  };
}

// ============================================================================
// ================ Pure torso-capsule math (no THREE) — arm IK ==============
// ============================================================================
// Body-awareness for solveArm's elbow: the torso is modeled as a vertical
// capsule (axis-aligned to world Y, centered on the spine). These helpers only
// need plain {x,y,z} objects with the Vector3 subset used below (set/copy/sub
// /dot/normalize/length are all a caller could reasonably provide); the THREE
// rig section calls them with real THREE.Vector3 scratch instances.

// Tunables: capsule radius = body radius + margin (room for limb thickness so
// the forearm doesn't clip even when the elbow is exactly on the surface);
// vertical span is a fraction of height below/above the pelvis/shoulder line.
export const TORSO_CAPSULE_RADIUS_MARGIN = 0.10;
export const TORSO_CAPSULE_Y_PAD = 0.06;

/** Horizontal (XZ) distance from `point` to the capsule's vertical axis. */
function _torsoAxisDist(point, capsule) {
  const dx = point.x - capsule.x, dz = point.z - capsule.z;
  return Math.hypot(dx, dz);
}

/**
 * True if `point` is inside the vertical torso capsule. Pure/no-THREE.
 * @param {{x:number,y:number,z:number}} point
 * @param {{x:number,z:number,yMin:number,yMax:number,radius:number}} capsule
 */
export function capsuleContainsPoint(point, capsule) {
  if (point.y < capsule.yMin || point.y > capsule.yMax) return false;
  return _torsoAxisDist(point, capsule) < capsule.radius;
}

/**
 * If `point` is inside the capsule, pushes it radially outward (in XZ, away
 * from the axis) to exactly the surface and writes the result into `out`
 * (defaults to `point`); y is never touched. No-op (returns false) if the
 * point is already outside or exactly on the axis (degenerate — no outward
 * direction to push along). Returns true iff `out` was moved.
 */
export function pushPointOutOfCapsule(point, capsule, out = point) {
  if (point.y < capsule.yMin || point.y > capsule.yMax) return false;
  const dx = point.x - capsule.x, dz = point.z - capsule.z;
  const dist = Math.hypot(dx, dz);
  if (dist >= capsule.radius || dist < 1e-6) return false;
  const s = capsule.radius / dist;
  out.x = capsule.x + dx * s;
  out.y = point.y;
  out.z = capsule.z + dz * s;
  return true;
}

/**
 * Projects `point` onto the infinite line through `root` in direction `dir`
 * (`dir` must already be unit-length — both `solveTwoBone` and `solveArm`
 * always have one in hand) and writes the result into `out`. Used by
 * Correction 3 to find the elbow's position *along the root->target axis*,
 * isolated from its bend offset — see `deriveOutwardPole`'s `force` doc for
 * why that isolation matters (the raw elbow's outward direction is dominated
 * by the axis term, not the much smaller bend term, so deriving "outward"
 * from the raw elbow barely redirects the bend).
 * @param {{x:number,y:number,z:number}} point
 * @param {{x:number,y:number,z:number}} root
 * @param {{x:number,y:number,z:number}} dir  unit direction
 * @param {{x:number,y:number,z:number}} [out]
 */
export function projectOntoAxis(point, root, dir, out = { x: 0, y: 0, z: 0 }) {
  const rx = point.x - root.x, ry = point.y - root.y, rz = point.z - root.z;
  const t = rx * dir.x + ry * dir.y + rz * dir.z;
  out.x = root.x + dir.x * t;
  out.y = root.y + dir.y * t;
  out.z = root.z + dir.z * t;
  return out;
}

/**
 * Derives an outward-biased pole direction for the elbow/knee bend. Takes the
 * limb's current pole candidate (`poleDir`, unit-ish) and the point it's meant
 * to bias (typically the shoulder or the just-solved/clamped elbow), and
 * rewrites its horizontal (away-from-axis) component to point away from the
 * torso capsule's spine axis, preserving `poleDir`'s vertical (y) component
 * (the downward bias) unchanged.
 *
 * By default (`force` false — Correction 2, the adaptive-pole pass before the
 * first solve) this is a no-op — copies `poleDir` straight through — when its
 * horizontal component already points outward (dot with the outward radial
 * direction is >= 0, with a small epsilon so a horizontally-perpendicular
 * pole, which is what the idle pose's fixed pole reduces to by construction,
 * isn't flipped by rotation-matrix floating-point noise around exactly
 * zero). This keeps an already-correct idle pole bit-for-bit alone.
 *
 * With `force: true` (Correction 3 — after the elbow has been clamped to the
 * capsule surface, we already KNOW the unconditional bend was wrong) the
 * horizontal component is unconditionally set to point outward from `point`,
 * regardless of its current sign: the first solve's pole can be exactly
 * perpendicular to "outward" (a no-op for Correction 2) and still produce a
 * penetrating elbow, so the re-solve pole must be forced, not conditionally
 * nudged, or the second solveTwoBone call reproduces the identical
 * (still-penetrating) result.
 *
 * `out` defaults to a new plain object; pass a scratch object to avoid
 * allocating.
 * @param {{x:number,y:number,z:number}} poleDir  candidate pole direction
 * @param {{x:number,y:number,z:number}} point  where outward is measured from (elbow or shoulder)
 * @param {{x:number,z:number}} capsule  torso axis center (yMin/yMax/radius unused here)
 * @param {{x:number,y:number,z:number}} [out]
 * @param {boolean} [force]  unconditionally rebuild outward (Correction 3) instead of no-op-if-outward (Correction 2)
 */
export function deriveOutwardPole(poleDir, point, capsule, out = { x: 0, y: 0, z: 0 }, force = false) {
  const ax = point.x - capsule.x, az = point.z - capsule.z;
  const axDist = Math.hypot(ax, az);
  out.x = poleDir.x; out.y = poleDir.y; out.z = poleDir.z;
  if (axDist < 1e-6) return out; // on-axis: no outward direction to correct toward
  const ox = ax / axDist, oz = az / axDist; // unit outward radial dir at `point`
  let horizLen = Math.hypot(poleDir.x, poleDir.z);
  if (horizLen < 1e-6) {
    if (!force) return out; // pole is purely vertical: nothing to redirect
    horizLen = 1; // force still needs a nonzero horizontal magnitude to redirect
  }
  if (!force) {
    const outwardDot = (poleDir.x * ox + poleDir.z * oz) / horizLen;
    // Small negative epsilon (not a strict >=0) so a horizontally-perpendicular pole — the idle
    // pose's, by construction — reads as "already fine" instead of having its sign decided by
    // rotation-matrix floating-point noise around exactly zero.
    if (outwardDot >= -1e-9) return out; // already outward (or neutral): no-op
  }
  // Set the horizontal component to point outward, keeping its magnitude and the pole's y
  // (downward bias) untouched.
  out.x = ox * horizLen;
  out.z = oz * horizLen;
  return out;
}

// ============================================================================
// ===================== THREE-dependent rig (Contract 2) ====================
// ============================================================================

const DEFAULT_STYLE = {
  shell: 0x6d7686,
  plate: 0x3a4148,
  trim: 0x9aa4b2,
  accent: 0xc8d2e0,   // secondary tinted role (defaults near trim)
  metal: 0x6f7681,    // untinted hardware (keep metalness low: no IBL to reflect)
  fabric: 0x8d7c58,   // untinted tan webbing/pouches: the mid-tone between shell and bare metal
  rubber: 0x14171b,   // untinted matte (soles, grips, seals)
  visor: 0x2a1e08,    // untinted dark tinted glass (kept DARKER than the shell on purpose)
  // Human-face roles (bot-face.js). skin and hair are PER-BODY tints, not team tints: setTint()
  // deliberately skips them, so a squad varies in skin tone without varying in team colour.
  skin: 0xc98d63,
  hair: 0x2a1d14,
  cloth: 0x5c6046,    // uniform fabric: per-body tint, matte, and deliberately non-glowing
  sclera: 0xe6ded0,   // untinted eye white
  pupil: 0x141110,    // untinted iris/pupil
  mouth: 0x6b3630,    // untinted lips / mouth interior
  limbShape: 'mannequin',  // 'mannequin' | 'box' | 'capsule' | 'cylinder'
  head: true,
};

function mergeStyle(style) {
  return { ...DEFAULT_STYLE, ...(style || {}) };
}

// Data-driven appearance spec. Every value matches the previously-hardcoded geometry exactly, so
// omitting `design` (every existing caller) renders the identical body. Lathe profiles are [r, y]
// pairs in R/H units (hand profile in limbThickness units); joint fields are limbThickness
// multiples. `gear` is a list of accessory descriptors — see the gear block in the body factory.

// Kneel pose tuning (state.kneel 0..1) — kneeling on ONE knee, the firing position: rear knee
// on the ground under the hip, front foot planted with the thigh horizontal and the shin
// vertical, torso upright. Unlike proneCfg's absolute metres, every offset here is a MULTIPLE
// of thighLen/shinLen: a kneel is a closed kinematic chain, and fixed metres would stretch the
// limbs on any body whose skeleton differs from the H=1.8 baseline. The defaults below close
// both chains to within ~2% of true bone length.
export const KNEEL_DEFAULTS = Object.freeze({
  side: 1,               // +1 = right knee down (right-handed default); -1 mirrors
  hipHeight: 1.00,       // pelvis above ground, × thighLen (1.0 = rear thigh vertical)
  hipYaw: 0.28,          // pelvis squares toward the rear leg (rad)
  lean: 0.12,            // upper-body forward pitch (rad)
  fwd: 0.05,             // upper-body forward shift (m along the heading)
  rearKneeSpread: 0.24,  // × thighLen, lateral from the body centre
  rearKneeHeight: 0.00,  // × thighLen
  rearFootBack: 1.00,    // ankle behind the knee, × shinLen (1.0 = shin flat on the ground)
  rearFootHeight: 0.12,  // × shinLen
  rearAnklePitch: 0.90,  // toes-down so the instep lies along the shin (rad)
  frontKneeFwd: 0.99,    // × thighLen
  frontKneeHeight: 1.00, // × thighLen (= hipHeight puts the thigh horizontal)
  frontFootSpread: 0.34, // × shinLen
  frontFootHeight: 0.08, // × shinLen; the foot sits directly under the front knee
  frontAnklePitch: 0.00,
  torsoDrop: 0.03, headDrop: 0.04, shoulderDrop: 0.06,
});

// Free-arm pose model. Each gait authors the upper-arm pitch (`raise`, rad forward of hanging),
// elbow bend (rad), outward spread (rad), contralateral swing amplitude (rad) and forearm pump
// (rad of extra bend at the forward extreme). Idle->walk->run blend by horizontal speed; the
// jump terms ride the body's air weight and landing absorb. Weapon-holding arms are unaffected
// because solveArm blends this pose out by the weapon target's weight.
export const ARM_POSE_PRESETS = Object.freeze({
  relaxed: Object.freeze({
    idle: Object.freeze({ raise: 0.02, bend: 0.19, spread: 0.16, swing: 0, pump: 0 }),
    walk: Object.freeze({ raise: 0.00, bend: 0.28, spread: 0.10, swing: 0.62, pump: 0.12 }),
    run: Object.freeze({ raise: 0.12, bend: 1.15, spread: 0.06, swing: 0.85, pump: 0.15 }),
    walkSpeed: 1.4, runSpeedLo: 5.2, runSpeedHi: 7.8,
    jumpLift: 1.6, jumpSpread: 0.5, landSwing: 0.7, fallLift: 2.4, fallSpeedRef: 8, fallTimeRef: 0.7,
  }),
  brisk: Object.freeze({
    idle: Object.freeze({ raise: 0.05, bend: 0.20, spread: 0.14, swing: 0, pump: 0 }),
    walk: Object.freeze({ raise: 0.05, bend: 0.45, spread: 0.08, swing: 0.80, pump: 0.20 }),
    run: Object.freeze({ raise: 0.18, bend: 1.30, spread: 0.05, swing: 1.00, pump: 0.22 }),
    walkSpeed: 1.2, runSpeedLo: 4.8, runSpeedHi: 7.2,
    jumpLift: 1.9, jumpSpread: 0.6, landSwing: 0.9, fallLift: 2.6, fallSpeedRef: 8, fallTimeRef: 0.6,
  }),
  sprinter: Object.freeze({
    idle: Object.freeze({ raise: 0.03, bend: 0.15, spread: 0.15, swing: 0, pump: 0 }),
    walk: Object.freeze({ raise: 0.02, bend: 0.35, spread: 0.09, swing: 0.70, pump: 0.15 }),
    run: Object.freeze({ raise: 0.25, bend: 1.45, spread: 0.04, swing: 1.20, pump: 0.30 }),
    walkSpeed: 1.4, runSpeedLo: 5.0, runSpeedHi: 7.0,
    jumpLift: 2.2, jumpSpread: 0.7, landSwing: 1.1, fallLift: 2.8, fallSpeedRef: 7, fallTimeRef: 0.55,
  }),
});

export function armPoseFromPreset(name) {
  const preset = ARM_POSE_PRESETS[name] || ARM_POSE_PRESETS.relaxed;
  return {
    enabled: true,
    preset: ARM_POSE_PRESETS[name] ? name : 'relaxed',
    idle: { ...preset.idle }, walk: { ...preset.walk }, run: { ...preset.run },
    walkSpeed: preset.walkSpeed, runSpeedLo: preset.runSpeedLo, runSpeedHi: preset.runSpeedHi,
    jumpLift: preset.jumpLift, jumpSpread: preset.jumpSpread, landSwing: preset.landSwing,
    fallLift: preset.fallLift, fallSpeedRef: preset.fallSpeedRef, fallTimeRef: preset.fallTimeRef,
    // Seconds for the idle/walk/run arm blend to follow a speed change (time constant).
    poseSmoothing: preset.poseSmoothing ?? 0.35,
  };
}

/**
 * Pure: hand position relative to the shoulder in the body's local frame (+X right, +Y up,
 * +Z forward) for an articulated arm pose. `sideSign` -1 left / +1 right.
 */
export function armPoseHandLocal({ raise, bend, spread, swingAngle = 0 }, sideSign, upperLen, foreLen, out = { x: 0, y: 0, z: 0 }) {
  const pitch = raise + swingAngle;
  // Upper arm: hang straight down, spread outward about Z, then pitch forward about X.
  const ux = sideSign * Math.sin(spread);
  const uyHang = -Math.cos(spread);
  const uy = uyHang * Math.cos(pitch);
  const uz = -uyHang * Math.sin(pitch);
  // Forearm: the upper-arm direction pitched further forward by the elbow bend.
  const fPitch = pitch + bend;
  const fy = uyHang * Math.cos(fPitch);
  const fz = -uyHang * Math.sin(fPitch);
  out.x = ux * upperLen + ux * foreLen;
  out.y = uy * upperLen + fy * foreLen;
  out.z = uz * upperLen + fz * foreLen;
  return out;
}

export const BODY_DESIGN_DEFAULTS = Object.freeze({
  legLenRatio: 0.62,        // legLen = H * legLenRatio
  thighFrac: 0.52,          // thighLen = legLen * thighFrac
  shinFrac: 0.48,
  armLenRatio: 0.42,        // armLen = H * armLenRatio
  upperArmFrac: 0.5,
  forearmFrac: 0.5,
  limbThicknessRatio: 0.32, // limbThickness = R * limbThicknessRatio
  armThickScale: 0.85,      // arm thickness = limbThickness * armThickScale
  pelvisProfile: [[0.20, -0.095], [0.55, -0.082], [0.72, -0.018], [0.62, 0.064], [0.30, 0.095]],
  pelvisRadial: 22, pelvisZScale: 0.68,
  waist: { rTop: 0.28, rBot: 0.34, h: 0.052, radial: 18, zScale: 0.72 },
  torsoProfile: [[0.22, -0.145], [0.40, -0.120], [0.62, -0.020], [0.72, 0.082], [0.58, 0.142], [0.28, 0.156]],
  torsoRadial: 24, torsoZScale: 0.54,
  neck: { rTop: 0.16, rBot: 0.18, h: 0.070, radial: 16, zScale: 0.82 },
  // Where the upper-body stack SITS, as fractions of capsule height above the pelvis. These were
  // hardcoded in update(), which meant `neck.h` sized the neck mesh without moving the head — so
  // shortening a neck opened a gap instead of lowering the head onto the shoulders. Defaults are the
  // former literals, so every existing caller renders identically.
  torsoYRatio: 0.22, neckYRatio: 0.37, headYRatio: 0.48,
  headProfile: [[0.08, -0.092], [0.28, -0.078], [0.38, -0.008], [0.34, 0.066], [0.18, 0.098], [0.04, 0.105]],
  headRadial: 18, headZScale: 0.82,
  hipJoint: 0.62, kneeJoint: 0.56, ankleJoint: 0.45,
  shoulderJoint: 0.72, elbowJoint: 0.50, wristJoint: 0.40,
  jointRadial: 12, jointSeg: 8,     // joint-sphere tessellation
  limbRadial: null,                 // null keeps the mannequin builder's 14
  // null uses the built-in mannequin taper; otherwise [rMul(of half-thickness), yFrac(-0.5..0.5)] pairs
  limbProfile: null,
  // Per-limb overrides of limbProfile. yFrac -0.5 is the PROXIMAL end (hip/shoulder) and +0.5 the
  // DISTAL one (knee/wrist) — placeSegment maps local +Y onto the proximal->distal direction. One
  // profile shared by all four limbs is what makes a rig read as segmented tubing: a thigh and a
  // calf taper in OPPOSITE directions, and no single symmetric spindle can be both.
  thighProfile: null, shinProfile: null, upperArmProfile: null, forearmProfile: null,
  footShape: 'sphere',              // 'sphere' (legacy blob) | 'boot' (extruded side profile)
  footScale: [0.72, 0.28, 1.55],
  // boot side profile, [length(heel -1 → toe +1), height(sole 0 → top)]; extruded across the width
  footProfile: [
    [-0.95, 0.06], [-1.00, 0.42], [-0.86, 0.85], [-0.62, 1.00],
    [-0.10, 0.96], [0.34, 0.60], [0.76, 0.44], [1.00, 0.24], [0.94, 0.02], [-0.60, 0.00],
  ],
  footSegments: 3,                  // bevel/curve segments on the boot
  footLift: -0.10,                  // normalized Y shift; slight sink so the sole never floats
  // Normalized +Z shift. The boot normalizes to [-1,1] about its centre, which puts the ankle
  // halfway along the foot — an anatomical ankle sits ~25% back, and a centred one reads as a
  // backwards/flipper foot because as much boot trails the leg as leads it.
  footForwardBias: 0,
  handShape: 'lathe',               // 'lathe' (legacy blob) | 'glove' (extruded outline)
  // Shift of the glove along its own length, in limbThickness units. The glove outline is centred on
  // the wrist, so half the hand sits BACK along the forearm — a hand growing through the joint
  // rather than off it, which also puts any sleeve cuff inside the hand. This is the hand's
  // equivalent of footForwardBias, and defaults to 0 so existing callers are unchanged.
  handWristBias: 0,
  handProfile: [[0.04, -0.86], [0.28, -0.58], [0.36, 0.05], [0.20, 0.46], [0.04, 0.55]],
  handRadial: 12, handZScale: 0.58,
  // glove outline in limbThickness units, [x across palm (+ = thumb side), y along fingers]
  handOutline: [
    [-0.34, -0.80], [0.34, -0.80], [0.46, -0.44], [0.74, -0.14], [0.46, 0.06],
    [0.40, 0.34], [0.34, 0.66], [-0.34, 0.62], [-0.40, 0.20],
  ],
  handThickness: 0.42,              // glove extrude depth (palm front-to-back)
  handFingerAxis: 1,                // +1 fingers along local +Y, -1 flips the glove
  handPalmFacing: 'z',              // palm normal: 'z' (front/back) | 'x' (inward, natural at rest)
  handSegments: 2,
  eye: null,   // optional partial eyeCfg override (width/length/depth/x/y/z/spacing, meters)
  eyeRadial: 12, eyeSeg: 8,
  // Material role per core part; same role names as gear. Defaults reproduce the legacy assignment.
  roles: {
    pelvis: 'plate', waist: 'trim', torso: 'shell', neck: 'trim', head: 'trim',
    limb: 'shell', joint: 'trim', foot: 'plate', hand: 'trim', eye: 'eye',
  },
  // Lathe profiles and extruded outlines are authored as a few control points and interpolated
  // LINEARLY, so a 6-point profile renders as 5 flat bands however high the radial count is.
  // profileSmooth resamples every profile through a spline to this many points (0 = off).
  profileSmooth: 0,
  outlineSmooth: false,   // extruded outlines (boot/glove) follow a spline instead of straight edges
  gear: [],
});

function mergeDesign(design) {
  const d = { ...BODY_DESIGN_DEFAULTS, ...(design || {}) };
  d.waist = { ...BODY_DESIGN_DEFAULTS.waist, ...(design?.waist || {}) };
  d.neck = { ...BODY_DESIGN_DEFAULTS.neck, ...(design?.neck || {}) };
  d.roles = { ...BODY_DESIGN_DEFAULTS.roles, ...(design?.roles || {}) };
  return d;
}

export function createProceduralPlayerBody({ THREE, scene, terrainHeight, mode = 'remote', style, design: designIn = null, adaptGaitToSpeed = false, movementDynamics = false, naturalLocomotion = false, batches = null, cache = null, mergeGear = false }) {
  const palette = mergeStyle(style);
  const design = mergeDesign(designIn);
  // Instanced mode (Phase 4): when a `batches` pool is injected, parts become transform-only
  // Object3D placeholders and the body emits their world matrices into shared InstancedMeshes via
  // flush() instead of owning real Meshes. Bots only; local/human bodies keep the mesh path.
  const instanced = !!batches;
  const _instanceParts = [];  // flat list of every placeholder, flushed each frame
  // Set by every path that moves the rig; flush ORs it with the caller's hint so a pose write can
  // never render a stride late even if a caller wrongly claims nothing moved.
  let _poseDirty = true;
  const _lodParts = [];   // gear placeholders that carry a cheap twin (rbox only)
  let _gearLod = 0;
  const _roleColor = instanced ? {
    shell: new THREE.Color(palette.shell),
    plate: new THREE.Color(palette.plate),
    trim: new THREE.Color(palette.trim),
    accent: new THREE.Color(palette.accent ?? palette.trim),
    // eye/metal/rubber are never tinted: their buckets keep the material's own colour
    eye: null, metal: null, rubber: null, fabric: null,
    sclera: null, pupil: null, mouth: null,
    // skin/hair ARE per-instance tinted, from this body's palette rather than its team colour
    skin: new THREE.Color(palette.skin),
    hair: new THREE.Color(palette.hair),
    cloth: new THREE.Color(palette.cloth),
  } : null;
  // Bend-direction bias for the 2-bone IK chains. +1 bends knees/elbows one way, -1 the other;
  // flip if a rig reads as reverse-jointed. Seeds the FABRIK solve's initial pose.
  const kneeSign = style?.kneeSign ?? 1;
  const elbowSign = style?.elbowSign ?? 1;

  // ---- narrow FABRIK copy (Contract 3) — closes over the injected THREE ----
  const _fabrikDir = new THREE.Vector3();
  class KinematicChain {
    constructor(segments) {
      this.lengths = segments.map(s => s.length);
      this.totalLength = this.lengths.reduce((s, n) => s + n, 0);
      this.initDirections = segments.map(s => s.initDirection.clone());
      this.points = [];
      this.maxIterations = 12;
      this.tolerance = 0.0001;
    }

    reset(root, orientation) {
      this.points = [root.clone()];
      for (let i = 0; i < this.lengths.length; i++) {
        const dir = this.initDirections[i].clone().applyQuaternion(orientation).normalize();
        this.points.push(this.points[i].clone().addScaledVector(dir, this.lengths[i]));
      }
    }

    solve(root, target, orientation) {
      if (this.points.length !== this.lengths.length + 1) this.reset(root, orientation);

      this.points[0].copy(root);
      const total = this.totalLength;
      const distance = root.distanceTo(target);

      if (distance >= total - 1e-5) {
        _fabrikDir.subVectors(target, root).normalize();
        for (let i = 0; i < this.lengths.length; i++) {
          this.points[i + 1].copy(this.points[i]).addScaledVector(_fabrikDir, this.lengths[i]);
        }
        return this.points;
      }

      for (let i = 1; i < this.points.length; i++) {
        if (this.points[i].distanceToSquared(this.points[i - 1]) < 1e-8) {
          _fabrikDir.copy(this.initDirections[i - 1]).applyQuaternion(orientation).normalize();
          this.points[i].copy(this.points[i - 1]).addScaledVector(_fabrikDir, this.lengths[i - 1]);
        }
      }

      for (let iter = 0; iter < this.maxIterations; iter++) {
        this.points[this.points.length - 1].copy(target);
        for (let i = this.points.length - 2; i >= 0; i--) {
          _fabrikDir.subVectors(this.points[i], this.points[i + 1]).normalize();
          this.points[i].copy(this.points[i + 1]).addScaledVector(_fabrikDir, this.lengths[i]);
        }

        this.points[0].copy(root);
        for (let i = 0; i < this.lengths.length; i++) {
          _fabrikDir.subVectors(this.points[i + 1], this.points[i]).normalize();
          this.points[i + 1].copy(this.points[i]).addScaledVector(_fabrikDir, this.lengths[i]);
        }

        if (this.points[this.points.length - 1].distanceToSquared(target) < this.tolerance) break;
      }

      return this.points;
    }
  }

  const _normal = new THREE.Vector3();
  function terrainNormal(x, z, out = _normal) {
    const e = 0.12;
    return out.set(
      terrainHeight(x - e, z) - terrainHeight(x + e, z),
      2 * e,
      terrainHeight(x, z - e) - terrainHeight(x, z + e)
    ).normalize();
  }

  // ---------------------------- rig proportions ----------------------------
  const H = 1.8;        // reference capsule height; real height comes from state each frame
  const R = 0.35;
  // Legs long enough that a high hip (pelvisHeightRatio up to ~0.6) still reaches the ground
  // with bend room, instead of the feet floating.
  const legLen = H * design.legLenRatio;
  const thighLen = legLen * design.thighFrac;
  const shinLen = legLen * design.shinFrac;
  const armLen = H * design.armLenRatio;
  const upperArmLen = armLen * design.upperArmFrac;
  const forearmLen = armLen * design.forearmFrac;
  const limbThickness = R * design.limbThicknessRatio;
  const armThick = limbThickness * design.armThickScale;

  // ------------------------------ materials --------------------------------
  // In instanced mode the shared batch pool owns the materials; each body only carries role
  // colors (above), so skip per-body material allocation entirely.
  const shellMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.shell, roughness: 0.65, metalness: 0.05 });
  const plateMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.plate, roughness: 0.55, metalness: 0.1 });
  const trimMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.trim, roughness: 0.4, metalness: 0.15 });
  const eyeMat = instanced ? null : new THREE.MeshBasicMaterial({ color: 0x080808, side: THREE.DoubleSide });
  const accentMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.5, metalness: 0.2 });
  const metalMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.metal, roughness: 0.3, metalness: 0.25 });
  const rubberMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.rubber, roughness: 0.95, metalness: 0 });
  const fabricMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.fabric, roughness: 0.98, metalness: 0 });
  const visorMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.visor, roughness: 0.1, metalness: 0.3 });
  // Face roles. Kept out of tintMaterials on purpose: a team recolour must not repaint skin.
  const skinMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.72, metalness: 0 });
  const hairMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.hair, roughness: 0.85, metalness: 0 });
  const scleraMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.sclera, roughness: 0.35, metalness: 0 });
  const pupilMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.pupil, roughness: 0.30, metalness: 0 });
  const mouthMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.mouth, roughness: 0.55, metalness: 0 });
  const clothMat = instanced ? null : new THREE.MeshStandardMaterial({ color: palette.cloth, roughness: 0.94, metalness: 0 });
  const tintMaterials = instanced ? [] : [shellMat, plateMat, trimMat, accentMat];
  const materials = instanced ? [] : [shellMat, plateMat, trimMat, eyeMat, accentMat, metalMat, rubberMat, fabricMat, visorMat,
    skinMat, hairMat, scleraMat, pupilMat, mouthMat, clothMat];
  const roleMatTable = { shell: shellMat, plate: plateMat, trim: trimMat, eye: eyeMat, accent: accentMat, metal: metalMat, rubber: rubberMat, fabric: fabricMat, visor: visorMat,
    skin: skinMat, hair: hairMat, sclera: scleraMat, pupil: pupilMat, mouth: mouthMat, cloth: clothMat };

  // Role -> material. Declared before the parts so every core part can honour design.roles;
  // roleMat() is the single lookup both core parts and gear go through.
  function roleMat(role) {
    return roleMatTable[role] ?? roleMatTable.trim;
  }
  // Resolves a core part's role through design.roles, falling back to the legacy assignment.
  function partRole(key, fallback) {
    const r = design.roles?.[key];
    return typeof r === 'string' ? r : fallback;
  }

  // Creates a renderable part: a real Mesh in mesh mode, or a transform-only Object3D placeholder
  // (tagged with its shared geometry + role) in instanced mode. Placeholders still get added to
  // `group` and positioned by update() exactly like meshes; flush() reads their world matrices.
  function makePart(geometry, mat, role) {
    if (!instanced) return new THREE.Mesh(geometry, mat);
    const p = new THREE.Object3D();
    p.geometry = geometry;   // carried for placeSegment's parameters/userData reads; never rendered
    p._role = role;
    _instanceParts.push(p);
    return p;
  }

  // `design` is bound once above, so capturing its smoothing settings as factory defaults is safe.
  // A caller may inject its own cache (the NPC suite owns one with retain/release/sweep); default is
  // the module-global pool. Record every geometry this body touches so destroy() releases exactly it.
  const _bodyGeoCache = cache || _sharedBodyGeo;
  const _prims = createPrimitiveFactory({
    THREE,
    cache: _bodyGeoCache,
    defaults: { outlineSmooth: design.outlineSmooth, profileSmooth: design.profileSmooth },
  });
  _bodyGeoCache.beginRecord?.();
  let _heldGeoKeys = null;
  const sharedGeo = _prims.sharedGeo;
  const smoothProfile = _prims.smoothProfile;
  const makeLatheGeometry = (profile, radialSegments = 18) => _prims.latheGeometry(profile, radialSegments);

  function makeMannequinLimbGeometry(length, thickness, kind = null) {
    const r = thickness * 0.5;
    const radial = design.limbRadial ?? 14;
    // Authored profile is pure fractions: [rMul of half-thickness, yFrac of length]. The per-limb
    // one wins; limbProfile is the shared fallback. No cache key change needed — makeLatheGeometry
    // keys on the resolved points, so two limbs with different profiles never collide.
    const profile = (kind && design[kind + 'Profile']) || design.limbProfile;
    if (profile) {
      return makeLatheGeometry(profile.map(([rm, yf]) => [r * rm, length * yf]), radial);
    }
    const cap = Math.min(length * 0.22, thickness * 1.15);
    return makeLatheGeometry([
      [r * 0.12, -length * 0.5],
      [r * 0.72, -length * 0.5 + cap * 0.18],
      [r * 0.98, -length * 0.5 + cap * 0.62],
      [r * 0.78, 0],
      [r * 0.92, length * 0.5 - cap * 0.62],
      [r * 0.66, length * 0.5 - cap * 0.18],
      [r * 0.12, length * 0.5],
    ], radial);
  }

  // Extrudes a closed 2D outline and returns the geometry, normalized into a caller-chosen box.
  // `normalize` gets the raw bounding box and returns {center:[x,y,z] shift, scale:[x,y,z]}.
  const extrudeOutline = _prims.extrudeOutline;

  // Boot: side profile extruded across the width, then normalized so x/z span [-1,1] and the sole
  // sits at y=0 — the same scale meaning as the legacy sphere, but with a real foot silhouette.
  function makeBootGeometry() {
    const key = `boot|${JSON.stringify(design.footProfile)}|${design.footSegments}|${design.footLift}|${design.footForwardBias}`;
    return sharedGeo(key, () => {
      const geo = extrudeOutline(design.footProfile, 1.6, design.footSegments, 0.10);
      geo.rotateY(-Math.PI / 2);   // profile X (heel→toe) becomes +Z (body forward)
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const size = new THREE.Vector3(); bb.getSize(size);
      const center = new THREE.Vector3(); bb.getCenter(center);
      geo.translate(-center.x, -bb.min.y, -center.z);          // sole to y=0, centered in x/z
      geo.scale(2 / Math.max(size.x, 1e-6), 2 / Math.max(size.y, 1e-6), 2 / Math.max(size.z, 1e-6));
      geo.translate(0, design.footLift, design.footForwardBias);
      geo.computeVertexNormals();
      return geo;
    });
  }

  // Glove: palm+thumb outline extruded to palm thickness. Authored in limbThickness units, so it
  // renders at scale 1 (unlike the lathe hand, which carries a z-squash).
  function makeGloveGeometry(thickness) {
    const key = `glove|${JSON.stringify(design.handOutline)}|${design.handThickness}|${design.handSegments}|${design.handFingerAxis}|${design.handPalmFacing}|${design.handWristBias}|${thickness}`;
    return sharedGeo(key, () => {
      const pts = design.handOutline.map(([x, y]) => [x * thickness, y * thickness]);
      const depth = design.handThickness * thickness;
      const geo = extrudeOutline(pts, depth, design.handSegments, thickness * 0.06);
      geo.translate(0, 0, -depth * 0.5);   // centre the palm on the wrist frame
      // Flip by rotating (not by negating the outline, which would reverse the winding).
      if (design.handFingerAxis < 0) geo.rotateZ(Math.PI);
      // Turn the palm to face inward (normal along X) — how a hand hangs at rest.
      if (design.handPalmFacing === 'x') geo.rotateY(Math.PI / 2);
      // Push the hand off the wrist along the bone. Applied AFTER the rotations so the sign always
      // means the same thing regardless of handFingerAxis/handPalmFacing.
      if (design.handWristBias) geo.translate(0, design.handWristBias * thickness, 0);
      geo.computeVertexNormals();
      return geo;
    });
  }

  function makeLimbGeometry(length, thickness, kind = null) {
    if (palette.limbShape === 'mannequin') {
      const geo = makeMannequinLimbGeometry(length, thickness, kind);
      geo.userData.proceduralLimb = { baseLength: length, baseThickness: thickness };
      return geo;
    }
    if (palette.limbShape === 'capsule') {
      return sharedGeo(`capsule|${thickness}|${length}`, () => new THREE.CapsuleGeometry(thickness * 0.5, Math.max(0.001, length - thickness), 4, 8));
    }
    if (palette.limbShape === 'cylinder') {
      // Height axis is Y (same as the box path), so placeSegment stretches it along the bone.
      return sharedGeo(`cyl|${thickness}|${length}`, () => new THREE.CylinderGeometry(thickness * 0.5, thickness * 0.5, length, 12));
    }
    return sharedGeo(`box|${thickness}|${length}`, () => new THREE.BoxGeometry(thickness, length, thickness));
  }

  // ------------------------------- group -----------------------------------
  const group = new THREE.Group();
  group.name = 'proceduralPlayerBody';
  // In instanced mode the group is a transform/visibility holder only (its placeholder children
  // render nothing), so it is never added to the scene — flush() walks it via updateMatrixWorld.
  if (scene && !instanced) scene.add(group);

  // Body root anchor: a parent-less node kept at chest height + facing yaw each frame. The rig
  // itself writes meshes in absolute world space (group stays at the origin), so this node — NOT
  // group — is the frame the weapon track resolves body-space hand targets against (belt/magwell/
  // toss refs in the reload sequence). Without it those targets ignore player position + facing.
  const rootAnchor = new THREE.Object3D();
  rootAnchor.name = 'proceduralPlayerBodyRoot';

  // Mannequin-like torso/pelvis profiles. placeSegment isn't involved; update() positions and
  // orients these directly, so the scale set here sticks.
  // Profiles are authored in R/H units in the design spec; scale to meters here.
  const scaleProfile = (profile) => profile.map(([r, y]) => [R * r, H * y]);
  const pelvisRole = partRole('pelvis', 'plate');
  const pelvis = makePart(makeLatheGeometry(scaleProfile(design.pelvisProfile), design.pelvisRadial), roleMat(pelvisRole), pelvisRole);
  pelvis.scale.set(1, 1, design.pelvisZScale);
  group.add(pelvis);

  const wc = design.waist;
  const waistRole = partRole('waist', 'trim');
  const waist = makePart(sharedGeo(`waistCyl|${wc.rTop}|${wc.rBot}|${wc.h}|${wc.radial}`,
    () => new THREE.CylinderGeometry(R * wc.rTop, R * wc.rBot, H * wc.h, wc.radial)), roleMat(waistRole), waistRole);
  waist.scale.set(1, 1, wc.zScale);
  group.add(waist);

  const torsoRole = partRole('torso', 'shell');
  const torso = makePart(makeLatheGeometry(scaleProfile(design.torsoProfile), design.torsoRadial), roleMat(torsoRole), torsoRole);
  torso.scale.set(1, 1, design.torsoZScale);
  group.add(torso);

  const nc = design.neck;
  const neckRole = partRole('neck', 'trim');
  const neck = makePart(sharedGeo(`neckCyl|${nc.rTop}|${nc.rBot}|${nc.h}|${nc.radial}`,
    () => new THREE.CylinderGeometry(R * nc.rTop, R * nc.rBot, H * nc.h, nc.radial)), roleMat(neckRole), neckRole);
  neck.scale.set(1, 1, nc.zScale);
  group.add(neck);

  let head = null;
  let eyes = null;
  const eyeCfg = {
    width: R * 0.126,    // 0.044 m at R=0.35 (tuned in body-preview.html)
    length: H * 0.027,   // 0.049 m at H=1.8
    depth: R * 0.086,    // 0.030 m
    x: 0,
    y: H * 0.0294,       // 0.053 m
    z: R * 0.291,        // 0.102 m
    spacing: R * 0.343,  // 0.120 m
  };
  if (design.eye) Object.assign(eyeCfg, design.eye);
  function applyEyeConfig() {
    if (!eyes) return;
    const halfSpacing = eyeCfg.spacing * 0.5;
    eyes.left.position.set(eyeCfg.x - halfSpacing, eyeCfg.y, eyeCfg.z);
    eyes.right.position.set(eyeCfg.x + halfSpacing, eyeCfg.y, eyeCfg.z);
    eyes.left.scale.set(eyeCfg.width, eyeCfg.length, eyeCfg.depth);
    eyes.right.scale.copy(eyes.left.scale);
  }
  if (palette.head !== false) {
    const headRole = partRole('head', 'trim');
    head = makePart(makeLatheGeometry(scaleProfile(design.headProfile), design.headRadial), roleMat(headRole), headRole);
    head.scale.set(1, 1, design.headZScale);
    group.add(head);

    const eyeGeo = sharedGeo(`eyeSphere|${design.eyeRadial}|${design.eyeSeg}`,
      () => new THREE.SphereGeometry(1, design.eyeRadial, design.eyeSeg));
    const eyeRole = partRole('eye', 'eye');
    const leftEye = makePart(eyeGeo, roleMat(eyeRole), eyeRole);
    const rightEye = makePart(eyeGeo, roleMat(eyeRole), eyeRole);
    head.add(leftEye, rightEye);
    eyes = { left: leftEye, right: rightEye };
    applyEyeConfig();
  }

  function makeJoint(radius, mat = null, role = null) {
    const w = design.jointRadial, h = design.jointSeg;
    const r = role || partRole('joint', 'trim');
    return makePart(sharedGeo(`sphere|${radius}|${w}|${h}`, () => new THREE.SphereGeometry(radius, w, h)), mat || roleMat(r), r);
  }

  function makeLeg() {
    const chain = new KinematicChain([
      { length: thighLen, initDirection: new THREE.Vector3(0, -1, 0.15 * kneeSign).normalize() },
      { length: shinLen, initDirection: new THREE.Vector3(0, -1, -0.1 * kneeSign).normalize() },
    ]);
    const limbRole = partRole('limb', 'shell');
    const upper = makePart(makeLimbGeometry(thighLen, limbThickness, 'thigh'), roleMat(limbRole), limbRole);
    const lower = makePart(makeLimbGeometry(shinLen, limbThickness, 'shin'), roleMat(limbRole), limbRole);
    const hip = makeJoint(limbThickness * design.hipJoint);
    const knee = makeJoint(limbThickness * design.kneeJoint);
    const ankle = makeJoint(limbThickness * design.ankleJoint);
    const bootShape = design.footShape === 'boot';
    const footGeo = bootShape ? makeBootGeometry() : sharedGeo('footSphere', () => new THREE.SphereGeometry(1, 16, 8));
    const footRole = partRole('foot', 'plate');
    const foot = makePart(footGeo, roleMat(footRole), footRole);
    foot.scale.set(limbThickness * design.footScale[0], limbThickness * design.footScale[1], limbThickness * design.footScale[2]);
    group.add(upper, lower, hip, knee, ankle, foot);
    return { chain, upper, lower, hip, knee, ankle, foot };
  }
  const legs = { left: makeLeg(), right: makeLeg() };

  function makeArm() {
    const chain = new KinematicChain([
      { length: upperArmLen, initDirection: new THREE.Vector3(0, -1, 0).normalize() },
      { length: forearmLen, initDirection: new THREE.Vector3(0, -1, 0.2 * elbowSign).normalize() },
    ]);
    const limbRole = partRole('limb', 'shell');
    const upper = makePart(makeLimbGeometry(upperArmLen, armThick, 'upperArm'), roleMat(limbRole), limbRole);
    const lower = makePart(makeLimbGeometry(forearmLen, armThick, 'forearm'), roleMat(limbRole), limbRole);
    const shoulder = makeJoint(limbThickness * design.shoulderJoint);
    const elbow = makeJoint(limbThickness * design.elbowJoint);
    const wrist = makeJoint(limbThickness * design.wristJoint);
    const glove = design.handShape === 'glove';
    const handRole = partRole('hand', 'trim');
    const hand = glove
      ? makePart(makeGloveGeometry(limbThickness), roleMat(handRole), handRole)
      : makePart(makeLatheGeometry(
          design.handProfile.map(([r, y]) => [limbThickness * r, limbThickness * y]), design.handRadial), roleMat(handRole), handRole);
    if (!glove) hand.scale.set(1, 1, design.handZScale);
    group.add(upper, lower, shoulder, elbow, wrist, hand);
    return { chain, upper, lower, shoulder, elbow, wrist, hand, target: null };
  }
  const arms = { left: makeArm(), right: makeArm() };

  // ------------------------------- gear ------------------------------------
  // Accessory parts from design.gear, parented to a core part through an inverse-scale anchor so
  // gear is authored in true part-local meters (core parts carry a z-squash the anchor undoes).
  // Descriptor: { anchor: 'pelvis'|'waist'|'torso'|'neck'|'head', type, role, position, rotation,
  // scale, size, profile, radial, seg }. Geometry is shared via sharedGeo keyed on the descriptor.
  // Limb hosts use VISUAL side naming (the rig's internal sides are mirrored — see setArmTarget).
  const gearHosts = {
    pelvis, waist, torso, neck, head,
    footL: legs.right.foot, footR: legs.left.foot,
    handL: arms.right.hand, handR: arms.left.hand,
    kneeL: legs.right.knee, kneeR: legs.left.knee,
    elbowL: arms.right.elbow, elbowR: arms.left.elbow,
    shoulderL: arms.right.shoulder, shoulderR: arms.left.shoulder,
    hipL: legs.right.hip, hipR: legs.left.hip,
  };
  // Side-less names expand to both sides, with x mirrored on the left.
  const GEAR_PAIRS = { foot: 'foot', hand: 'hand', knee: 'knee', elbow: 'elbow', shoulder: 'shoulder', hip: 'hip' };
  // The joint each limb-joint anchor points AT, for the bone direction a body-facing anchor needs.
  const gearBoneChild = {
    kneeL: () => legs.right.ankle, kneeR: () => legs.left.ankle,
    elbowL: () => arms.right.wrist, elbowR: () => arms.left.wrist,
    hipL: () => legs.right.knee, hipR: () => legs.left.knee,
    shoulderL: () => arms.right.elbow, shoulderR: () => arms.left.elbow,
  };
  const gearAnchors = {};
  const _faceAnchors = [];   // body-facing anchors, re-oriented every frame (see orientFaceAnchors)
  function gearAnchor(name, faceBody = false) {
    const host = gearHosts[name];
    if (!host) return null;
    const key = faceBody ? name + '#face' : name;
    let a = gearAnchors[key];
    if (!a) {
      a = new THREE.Object3D();
      a.scale.set(1 / host.scale.x, 1 / host.scale.y, 1 / host.scale.z);
      host.add(a);
      gearAnchors[key] = a;
      // A body-facing anchor only means anything on a limb JOINT — everything else already has a
      // stable frame. Registering it here is what makes orientFaceAnchors cheap: no search per frame.
      if (faceBody && gearBoneChild[name]) _faceAnchors.push({ anchor: a, host, child: gearBoneChild[name] });
    }
    return a;
  }
  // Geometry for one gear descriptor; segOverride builds the cheaper LOD twin (GEAR_LOD_SEG).
  const gearGeometry = _prims.geometryFor;
  // Every gear placeholder, tagged with the index it occupies in design.gear — that index is what
  // an authoring tool edits, so tools can name, find, measure and audit an individual piece.
  const gearParts = [];
  function addGearPart(g, anchorName, mirror, index) {
    // `faceBody` puts the piece on a second anchor whose roll is locked to the body's forward, so a
    // shell can sit on the FRONT of a joint instead of having to wrap it. Joints only.
    const anchor = gearAnchor(anchorName, !!g.faceBody);
    if (!anchor) return;  // e.g. head gear on a headless style
    const role = Object.prototype.hasOwnProperty.call(roleMatTable, g.role) ? g.role : 'trim';
    const part = makePart(gearGeometry(g), roleMat(role), role);
    // rbox is the armour primitive and, at the default seg=3, 828 triangles a piece -- two thirds
    // of a bot's whole triangle budget. Only rbox gets a twin; lathes/domes/faces keep theirs.
    if (instanced && g.type === 'rbox') {
      part.userData.lodGeo = [part.geometry, gearGeometry(g, GEAR_LOD_SEG)];
      _lodParts.push(part);
    }
    const mx = mirror ? -1 : 1;
    if (g.position) part.position.set(g.position[0] * mx, g.position[1], g.position[2]);
    if (g.rotation) part.rotation.set(g.rotation[0], g.rotation[1] * mx, g.rotation[2] * mx);
    if (g.scale != null) {
      if (Array.isArray(g.scale)) part.scale.set(g.scale[0], g.scale[1], g.scale[2]);
      else part.scale.setScalar(g.scale);
    }
    part.userData.gear = { index, id: g.id ?? null, anchor: anchorName, mirror, role, type: g.type, descriptor: g };
    gearParts.push(part);
    anchor.add(part);
  }
  // Merged gear (instanced only): every piece on one (anchor, role) bakes into a single geometry,
  // cutting the flush matrix walk, pool adds, and bucket count without changing the rendered look.
  // Per-piece OBBs ride along in userData.mergedPieces so bot-body-hit.js keeps piece precision.
  const _mergeGroups = new Map();
  const _gearMerged = mergeGear && instanced;
  function collectGearPiece(g, anchorName, mirror, index) {
    if (!gearHosts[anchorName]) return;
    const role = Object.prototype.hasOwnProperty.call(roleMatTable, g.role) ? g.role : 'trim';
    const key = anchorName + (g.faceBody ? '#face' : '') + '|' + role;
    let grp = _mergeGroups.get(key);
    if (!grp) { grp = { anchorName, faceBody: !!g.faceBody, role, pieces: [] }; _mergeGroups.set(key, grp); }
    grp.pieces.push({ g, mirror, index });
  }
  // Same transform addGearPart writes onto an individual piece, as one local matrix.
  function pieceLocalMatrix(g, mirror) {
    const mx = mirror ? -1 : 1;
    const p = g.position || [0, 0, 0], r = g.rotation || [0, 0, 0];
    const scl = g.scale == null ? new THREE.Vector3(1, 1, 1)
      : Array.isArray(g.scale) ? new THREE.Vector3(g.scale[0], g.scale[1], g.scale[2])
      : new THREE.Vector3(g.scale, g.scale, g.scale);
    return new THREE.Matrix4().compose(
      new THREE.Vector3(p[0] * mx, p[1], p[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1] * mx, r[2] * mx, 'XYZ')),
      scl);
  }
  // Bakes one group into a single indexed position+normal geometry; lod=1 uses the rbox seg-1 twin.
  function buildMergedGeometry(grp, lod) {
    const pos = [], nrm = [], idx = [];
    let base = 0;
    for (const { g, mirror } of grp.pieces) {
      const src = (lod && g.type === 'rbox') ? gearGeometry(g, GEAR_LOD_SEG) : gearGeometry(g);
      const baked = src.clone().applyMatrix4(pieceLocalMatrix(g, mirror));
      const p = baked.getAttribute('position'), n = baked.getAttribute('normal');
      for (let i = 0; i < p.count; i++) {
        pos.push(p.getX(i), p.getY(i), p.getZ(i));
        if (n) nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      }
      if (baked.index) for (let i = 0; i < baked.index.count; i++) idx.push(baked.index.getX(i) + base);
      else for (let i = 0; i < p.count; i++) idx.push(base + i);
      base += p.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (nrm.length === pos.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
  function addMergedGearParts() {
    for (const grp of _mergeGroups.values()) {
      const anchor = gearAnchor(grp.anchorName, grp.faceBody);
      if (!anchor) continue;
      const baseKey = 'gearmerge|' + grp.anchorName + (grp.faceBody ? '#face' : '') + '|' + grp.role
        + '|' + JSON.stringify(grp.pieces.map(({ g, mirror }) => [g, mirror ? 1 : 0]));
      const full = sharedGeo(baseKey + '|0', () => buildMergedGeometry(grp, 0));
      const part = makePart(full, roleMat(grp.role), grp.role);
      if (grp.pieces.some(({ g }) => g.type === 'rbox')) {
        part.userData.lodGeo = [full, sharedGeo(baseKey + '|1', () => buildMergedGeometry(grp, 1))];
        _lodParts.push(part);
      }
      part.userData.mergedPieces = grp.pieces.map(({ g, mirror, index }) => {
        const src = gearGeometry(g);
        if (!src.boundingBox) src.computeBoundingBox();
        const matrix = pieceLocalMatrix(g, mirror);
        return { box: src.boundingBox, matrix, inverse: matrix.clone().invert(), index };
      });
      part.userData.gear = { merged: true, anchor: grp.anchorName, role: grp.role, indices: grp.pieces.map(pc => pc.index) };
      gearParts.push(part);
      anchor.add(part);
    }
  }
  const _addGear = _gearMerged ? collectGearPiece : addGearPart;
  (design.gear || []).forEach((g, index) => {
    const name = g.anchor || 'torso';
    if (GEAR_PAIRS[name]) { _addGear(g, name + 'L', true, index); _addGear(g, name + 'R', false, index); }
    else _addGear(g, name, false, index);
  });
  if (_gearMerged) addMergedGearParts();

  // Picking targets for body-preview.html; VISUAL side naming (swap matches setArmTarget).
  const joints = {
    leftShoulder: arms.right.shoulder, leftElbow: arms.right.elbow, leftWrist: arms.right.wrist, leftHand: arms.right.hand,
    rightShoulder: arms.left.shoulder, rightElbow: arms.left.elbow, rightWrist: arms.left.wrist, rightHand: arms.left.hand,
    leftHip: legs.right.hip, leftKnee: legs.right.knee, leftAnkle: legs.right.ankle, leftFoot: legs.right.foot,
    rightHip: legs.left.hip, rightKnee: legs.left.knee, rightAnkle: legs.left.ankle, rightFoot: legs.left.foot,
    pelvis, waist, torso, neck, head,
  };

  // ------------------------------ gait state --------------------------------
  const gait = createGaitScheduler();
  // Cyclic pose layer on top of the foot scheduler. Off unless the caller asks for it, so the
  // env/bot viewers keep their current look until the tuning done in body-preview.html is adopted.
  const locomotion = createLocomotion({ enabled: !!naturalLocomotion });
  const turnCfg = {
    enabled: !!movementDynamics,
    stiffness: 30,
    damping: 10,
    maxSpeed: 6,
    maxLag: 0.48,
    turnStepAngle: 0.20,
  };
  const headTurnCfg = {
    enabled: !!movementDynamics,
    maxYaw: Math.PI * 0.25,
    followRate: 18,
  };
  const legWorkspace = { ...LEG_WORKSPACE_DEFAULTS };
  const movementTuning = {
    bobScale: 1,
    swayScale: 1,
    workspaceWidthScale: 1,
    workspaceForwardScale: 1,
    // Visual pelvis/chest may lead the planted support by this many metres. The clamp is
    // render-only: it never modifies controller physics or the gait's desired step targets.
    maxForwardLead: 0.32,
    maxLateralLead: 0.22,
    // Fraction of a swing's hip travel the FEET aim ahead by. 0 = feet land under the hip.
    stepLeadScale: 0,
    // Which GAIT_MODELS entry adaptGaitToSpeed reads. Unknown names fall back to 'shipped'.
    gaitModel: 'shipped',
    bodyFollowRate: 11,
    // Multiply the speed model's stride and cadence so sliders survive adaptGaitToSpeed.
    strideScale: 1,
    cadenceScale: 1,
  };
  const motion = {
    targetYaw: 0, visualYaw: 0, yawLag: 0, yawVelocity: 0,
    bob: 0, sway: 0, turning: false, workspace: legWorkspace,
    supportPosition: { x: 0, y: 0, z: 0 }, bodyPosition: { x: 0, y: 0, z: 0 },
    forwardLead: 0, lateralLead: 0, headYaw: 0, headYawTarget: 0,
  };
  let visualYaw = 0;
  let visualYawVelocity = 0;
  let visualYawInitialized = false;
  let visualBodyX = 0;
  let visualHeadYaw = 0;
  let visualBodyZ = 0;
  let visualBodyInitialized = false;


  // Prone pose tuning (all live-tunable, e.g. from body-preview.html). Blended in by the
  // state.prone (0..1) weight: pelvis drops to hipHeight, the body pitches `pitch` rad toward
  // horizontal along its heading, torso/head extend forward, feet trail behind the pelvis, and
  // the shoulders brace forward. Distances are meters (heading/up), except shoulderSpread which
  // is a multiple of radius. Overwrite fields to retune; do not replace the object.
  const proneCfg = {
    hipHeight: 0.25,      // pelvis height above terrain when fully prone
    pitch: 1.46,          // body pitch toward horizontal (rad; ~84deg)
    torsoFwd: 0.33, torsoUp: 0.02,
    headFwd: 0.75, headUp: 0.16, headPitch: -1.28,
    footBack: 1.06, footSpread: 0.5, footHeight: 0.04,
    shoulderFwd: 0.58, shoulderUp: 0.02, shoulderSpread: 0.9,
  };

  const kneelCfg = { ...KNEEL_DEFAULTS };


  // Crouch pose tuning (state.crouch 0..1 squashes the upright stack). The *drop fields are the
  // fraction each joint lowers at crouch=1; lean pitches the upper body forward (rad) and fwd
  // shifts it forward along the heading, so crouch reads as a hunch, not a pure vertical squash.
  // Jump/fall pose. airW is a blended air weight (0 grounded .. 1 airborne) instead of a boolean,
  // so legs ease into and out of the tuck; the tuck itself is shaped by vertical velocity (legs
  // trail while rising, reach for the floor while falling); landing drops the pelvis by impact
  // speed and springs back while both feet re-plant together.
  const jumpCfg = {
    enabled: true,
    riseRate: 14,        // air weight rise (1/s): ~80 ms to full tuck
    fallRate: 9,         // air weight decay (1/s) after landing
    tuckRise: 0.58,      // foot distance below hip as a leg-length fraction while rising
    tuckFall: 0.86,      // ... while falling (legs extend toward the ground)
    vyScale: 0.14,       // how quickly vertical velocity moves the tuck between the two
    footForward: 0.10,   // leg-length fraction the feet trail behind the hip while rising
    absorbDrop: 0.035,   // pelvis drop per m/s of landing speed (m)
    absorbMax: 0.20,     // cap on that drop (m)
    absorbRecover: 9,    // spring-back rate (1/s)
    landHold: 0.10,      // seconds the gait holds both planted feet after landing
    armRaise: 0.55,      // rad the idle arms lift while rising
    armLand: 0.35,       // rad the idle arms swing forward on the landing absorb
  };
  const crouchCfg = {
    pelvisDrop: 0.62,    // pelvisHeightRatio *= (1 - pelvisDrop*crouch)
    torsoDrop: 0.25,     // waist + torso vertical squash
    headDrop: 0.10,      // neck + head vertical squash
    shoulderDrop: 0.19,  // shoulder (arm root) vertical squash
    lean: 0.10,          // forward pitch of upper body at crouch=1 (rad)
    fwd: 0.0,            // forward shift of upper body at crouch=1 (m, along heading)
  };

  // Per-limb elbow/knee pole rotation (rad) around the root->end axis; live-tunable from body-preview.html's joint picker. VISUAL side naming (see setArmTarget's swap comment).
  const ikCfg = {
    leftArmPole: 1.98, rightArmPole: -1.4, leftArmPoleProne: -2.02, rightArmPoleProne: 1.76,
    leftLegPole: 0, rightLegPole: 0, leftLegPoleProne: 0, rightLegPoleProne: 0,
  };

  // scratch vectors
  const _root = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _orient = new THREE.Quaternion();
  const _up = new THREE.Vector3(0, 1, 0);
  const _dir = new THREE.Vector3();
  const _mid = new THREE.Vector3();
  const _axis = new THREE.Vector3();
  const _pole = new THREE.Vector3();
  const _poleQuat = new THREE.Quaternion();
  const _segDir = new THREE.Vector3();        // bone direction expressed in body space
  const _segInvQ = new THREE.Quaternion();    // inverse of the body orientation placeSegment rolls against
  const _bend = new THREE.Vector3();
  const _joint = new THREE.Vector3();
  const _end = new THREE.Vector3();
  const _footAir = new THREE.Vector3();
  const _lastHipPos = new THREE.Vector3();
  // Prone-blend scratch (heading basis, pitched orientation, lerped positions).
  const _F = new THREE.Vector3();
  const _Rt = new THREE.Vector3();
  const _proneQuat = new THREE.Quaternion();
  const _bodyQ = new THREE.Quaternion();
  const _upperQ = new THREE.Quaternion();
  const _pelvisQ = new THREE.Quaternion();  // pelvis MESH: body orientation + locomotion roll/yaw
  const _hipQ = new THREE.Quaternion();     // hip SOCKETS: upright orientation + locomotion roll/yaw
  const _locoQ = new THREE.Quaternion();    // scratch for one locomotion axis-angle at a time
  const _ankleQ = new THREE.Quaternion();   // separate scratch: solveLeg runs after _locoQ's users
  const _shoulderQ = new THREE.Quaternion();
  const _segQ = new THREE.Quaternion();     // one spine segment's orientation, rebuilt per segment
  const _upperBaseQ = new THREE.Quaternion();
  const _armSwingV = new THREE.Vector3();
  const _kneeK = new THREE.Vector3();
  const _footK = new THREE.Vector3();

  // Spine gradient: how much of the locomotion twist/lean each segment carries, as its height above
  // the pelvis over the shoulder line's. Without this the whole upper body turns as one block and
  // the twist reads as a hinge at the hips.
  const SHOULDER_Y_RATIO = 0.34;
  const _spineFrac = { waist: 0, torso: 0, neck: 1 };
  // `frac` is the live fraction table, exposed so debug overlays read the real values instead of
  // recomputing the curve and drifting from it.
  const spineCfg = { falloff: 1, frac: _spineFrac };   // >1 keeps the twist high in the chest
  function refreshSpineFractions() {
    const f = (yRatio) => Math.pow(Math.min(1, Math.max(0, yRatio / SHOULDER_Y_RATIO)), spineCfg.falloff);
    _spineFrac.waist = f(0.10);
    _spineFrac.torso = f(design.torsoYRatio);
    _spineFrac.neck = f(design.neckYRatio);
  }
  refreshSpineFractions();
  let _lastFalloff = spineCfg.falloff;

  // Filled by update() so spineOrient() stays allocation-free.
  let _spineLw = 0, _spineLean = 0, _spineYaw = 0;
  // Aim twist/lean, on the same height gradient but NOT on the locomotion weight: that weight is
  // zero when kneeling or prone, and those are the stances that most need a braced torso.
  let _aimYaw = 0, _aimLean = 0;
  function spineOrient(out, frac) {
    out.copy(_upperBaseQ);
    if (frac <= 0) return out;
    if (_spineLw > 0) {
      const w = _spineLw * frac;
      if (_spineLean) out.multiply(_locoQ.setFromAxisAngle(_X, _spineLean * w));
      if (_spineYaw) out.multiply(_locoQ.setFromAxisAngle(_up, _spineYaw * w));
    }
    if (_aimLean) out.multiply(_locoQ.setFromAxisAngle(_X, _aimLean * frac));
    if (_aimYaw) out.multiply(_locoQ.setFromAxisAngle(_up, _aimYaw * frac));
    return out;
  }
  const _Z = new THREE.Vector3(0, 0, 1);
  const _groundQ = new THREE.Quaternion();
  const _qx = new THREE.Quaternion();
  const _X = new THREE.Vector3(1, 0, 0);
  const _uPos = new THREE.Vector3();
  const _pPos = new THREE.Vector3();
  const _headYawQ = new THREE.Quaternion();
  const _headPitchQ = new THREE.Quaternion();
  const _footU = new THREE.Vector3();
  const _footP = new THREE.Vector3();
  let hasLastPos = false;
  let _groundRefY = null; // body-center height last time the player was grounded (auto-calibrated)
  let _airW = 0;          // blended air weight
  let _wasOnFloor = true;
  let _absorb = 0;        // current landing pelvis drop (m)
  let _landHold = 0;      // seconds left holding feet after landing
  let _lastPosY = null;
  let _lastVy = 0;
  let _fallTime = 0;      // seconds spent falling (airborne with vy < 0)
  let internalVisible = true;

  // Torso capsule (body-awareness for arm IK, see solveArm below), rebuilt once per update().
  const _torsoCapsule = { x: 0, z: 0, yMin: 0, yMax: 0, radius: 0 };
  // Per-frame scratch for the leg/arm attach math (was allocating fresh Vector3s each side each frame).
  const _legLocal = new THREE.Vector3();
  const _hipAttach = new THREE.Vector3();
  const _armLocal = new THREE.Vector3();
  // Idle arm offsets are loop-invariant (depend only on the constant armLen); solveArm reads them read-only.
  const _idleArmLeft = new THREE.Vector3(-1, -1.1, 0.1).normalize().multiplyScalar(armLen * 0.7);
  const _idleArmRight = new THREE.Vector3(1, -1.1, 0.1).normalize().multiplyScalar(armLen * 0.7);
  const armCfg = armPoseFromPreset('relaxed');   // live; armCfg.enabled=false restores the fixed idle vector
  const _armPose = { raise: 0, bend: 0, spread: 0, swingAngle: 0 };
  const _armHand = { x: 0, y: 0, z: 0 };
  let _armSpeed = 0;      // smoothed horizontal speed that drives the arm pose blend
  const _outPole = { x: 0, y: 0, z: 0 };   // scratch for deriveOutwardPole's plain-object out param
  const _axisPt = { x: 0, y: 0, z: 0 };    // scratch for projectOntoAxis's plain-object out param
  // Ragdoll-pose scratch (setRagdollPose): joint Vector3 cache + basis for torso orientation.
  const _rdNames = ['head', 'neck', 'chest', 'pelvis', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'handL', 'handR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR'];
  const _rdJ = {}; for (const n of _rdNames) _rdJ[n] = new THREE.Vector3();
  const _rdRight = new THREE.Vector3(), _rdUp = new THREE.Vector3(), _rdFwd = new THREE.Vector3();
  const _rdMat = new THREE.Matrix4(), _rdBodyQ = new THREE.Quaternion(), _rdHeadQ = new THREE.Quaternion();

  // Builds a joint frame with +Y along the bone (from->to) and the remaining roll resolved against
  // the body orientation, so +X is body-right and +Z is body-forward. Without this the roll is
  // arbitrary and gear offsets ("put the piston outboard") land in unpredictable directions.
  const _jfUp = new THREE.Vector3(), _jfRight = new THREE.Vector3(), _jfFwd = new THREE.Vector3();
  const _jfRef = new THREE.Vector3(), _jfMat = new THREE.Matrix4();
  function jointFrame(node, from, to, orientation) {
    _jfUp.subVectors(to, from);
    if (_jfUp.lengthSq() < 1e-10) _jfUp.set(0, 1, 0); else _jfUp.normalize();
    _jfRef.set(0, 0, 1).applyQuaternion(orientation);          // body forward
    _jfRight.crossVectors(_jfUp, _jfRef);
    if (_jfRight.lengthSq() < 1e-8) {                          // bone parallel to forward
      _jfRef.set(1, 0, 0).applyQuaternion(orientation);
      _jfRight.crossVectors(_jfUp, _jfRef);
      if (_jfRight.lengthSq() < 1e-8) _jfRight.set(1, 0, 0);
    }
    _jfRight.normalize();
    _jfFwd.crossVectors(_jfRight, _jfUp).normalize();
    _jfMat.makeBasis(_jfRight, _jfUp, _jfFwd);
    node.quaternion.setFromRotationMatrix(_jfMat);
  }

  // `orientation` is the body's facing. Roll about the bone must follow the BODY, not the world:
  // setFromUnitVectors gives the SHORTEST ARC, which carries no roll at all, so a near-vertical
  // thigh gets a near-identity rotation whichever way the bot is facing and the segment's local
  // frame ends up world-locked. Anything pinned in that frame (a blood decal) then stays put in
  // world space while the body turns around it. Doing the same shortest-arc solve in BODY space and
  // rotating the result by the orientation keeps the rule identical while making the frame rigid
  // with the body. Invisible on the mesh: limb geometry is a lathe about Y and placeSegment scales
  // X and Z equally, so a segment is exactly rotationally symmetric about the axis being rolled.
  function placeSegment(mesh, a, b, thickness, orientation = null) {
    _mid.copy(a).add(b).multiplyScalar(0.5);
    mesh.position.copy(_mid);
    const length = Math.max(0.001, a.distanceTo(b));
    _dir.subVectors(b, a).normalize();
    if (orientation) {
      _segDir.copy(_dir).applyQuaternion(_segInvQ.copy(orientation).invert());
      mesh.quaternion.setFromUnitVectors(_up, _segDir).premultiply(orientation);
    } else {
      mesh.quaternion.setFromUnitVectors(_up, _dir);
    }
    const limbMeta = mesh.geometry.userData?.proceduralLimb;
    if (limbMeta) {
      mesh.scale.set(thickness / limbMeta.baseThickness, length / limbMeta.baseLength, thickness / limbMeta.baseThickness);
    } else if (palette.limbShape === 'capsule') {
      mesh.scale.set(1, 1, 1);
    } else if (palette.limbShape === 'cylinder') {
      const p = mesh.geometry.parameters;
      const d = p.radiusTop * 2;
      mesh.scale.set(thickness / d, length / p.height, thickness / d);
    } else {
      mesh.scale.set(thickness / mesh.geometry.parameters.width, length / mesh.geometry.parameters.height, thickness / mesh.geometry.parameters.depth);
    }
  }

  // Analytic 2-bone IK. Unlike FABRIK this places the mid-joint DETERMINISTICALLY toward
  // `poleDir`, so a knee/elbow can only ever bend one way (no per-frame flip), and the bend
  // is naturally limited by reach (a far target straightens the limb; a close one folds it).
  // Writes the mid joint into outJoint and the (reach-clamped) end into outEnd.
  function solveTwoBone(root, target, L1, L2, poleDir, outJoint, outEnd) {
    _axis.subVectors(target, root);
    let d = _axis.length();
    if (d < 1e-6) { _axis.set(0, -1, 0); d = 1e-6; } else _axis.multiplyScalar(1 / d);
    const dc = Math.min((L1 + L2) * 0.999, Math.max(Math.abs(L1 - L2) + 1e-4, d));
    outEnd.copy(root).addScaledVector(_axis, dc);
    const a = (dc * dc + L1 * L1 - L2 * L2) / (2 * dc);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // bend direction = component of poleDir perpendicular to the root->end axis
    _bend.copy(poleDir).addScaledVector(_axis, -poleDir.dot(_axis));
    if (_bend.lengthSq() < 1e-8) {
      _bend.set(0, 1, 0).addScaledVector(_axis, -_axis.y);
      if (_bend.lengthSq() < 1e-8) _bend.set(1, 0, 0);
    }
    _bend.normalize();
    outJoint.copy(root).addScaledVector(_axis, a).addScaledVector(_bend, h);
  }

  function solveLeg(leg, side, hipAttach, footTarget, orientation, thickness, pw, anklePitch = 0, kneeTarget = null, kneeWeight = 0) {
    _root.copy(hipAttach);
    _target.set(footTarget.x, footTarget.y, footTarget.z);
    _pole.set(0, 0, kneeSign).applyQuaternion(orientation); // knees bend toward body-forward
    const visSide = side === 'left' ? 'right' : 'left'; // internal side is mirrored vs visual
    const poleAngle = lerp(ikCfg[visSide + 'LegPole'], ikCfg[visSide + 'LegPoleProne'], pw);
    if (poleAngle) {
      _axis.subVectors(_target, _root).normalize();
      _pole.applyQuaternion(_poleQuat.setFromAxisAngle(_axis, poleAngle));
    }
    solveTwoBone(_root, _target, leg.chain.lengths[0], leg.chain.lengths[1], _pole, _joint, _end);
    // Authored knee (kneeling). placeSegment stretch-fits, so the small bone-length error while
    // the blend is mid-way is absorbed; at weight 1 the authored chain closes on its own.
    if (kneeTarget && kneeWeight > 0) _joint.lerp(kneeTarget, kneeWeight);
    placeSegment(leg.upper, _root, _joint, thickness, orientation);
    placeSegment(leg.lower, _joint, _end, thickness, orientation);
    leg.hip.position.copy(_root);
    leg.knee.position.copy(_joint);
    leg.ankle.position.copy(_end);
    leg.foot.position.copy(_end);
    // Joint frames for gear (design.gear `hip`/`knee`/`ankle`). Borrowing the bone's own quaternion
    // gives +Y along the bone but an ARBITRARY ROLL (placeSegment builds it with
    // setFromUnitVectors), so an "outward" X offset landed wherever the roll happened to point —
    // that is why outboard leg pistons rendered front-centre. jointFrame re-rolls the basis against
    // the body orientation, so +X is body-right and +Z is body-forward for every joint.
    jointFrame(leg.hip, _root, _joint, orientation);
    jointFrame(leg.knee, _joint, _end, orientation);
    jointFrame(leg.ankle, _joint, _end, orientation);
    terrainNormal(_end.x, _end.z, _dir);
    _groundQ.setFromUnitVectors(_up, _dir);
    leg.foot.quaternion.copy(_groundQ).multiply(orientation);
    // Heel strike / toe-off. Without this the foot stays flat to the ground normal for the whole
    // cycle, which is what makes the feet read as sliding rather than rolling through a step.
    if (anklePitch) leg.foot.quaternion.multiply(_ankleQ.setFromAxisAngle(_X, anklePitch));
  }

  function solveArm(side, arm, shoulderAttach, idleLocal, orientation, thickness, pw, torsoCapsule) {
    _root.copy(shoulderAttach);
    const weight = arm.target ? (arm.target.weight ?? 1) : 0;
    if (arm.target && weight > 0) {
      _target.copy(arm.target.position);
      if (weight < 1) {
        const idleWorld = idleLocal.clone().applyQuaternion(orientation).add(shoulderAttach);
        _target.lerp(idleWorld, 1 - weight);
      }
    } else {
      _target.copy(idleLocal).applyQuaternion(orientation).add(shoulderAttach);
    }
    _pole.set(0, -0.4, -elbowSign).applyQuaternion(orientation); // elbows bend down/back
    const visSide = side === 'left' ? 'right' : 'left'; // internal side is mirrored vs visual
    const poleAngle = lerp(ikCfg[visSide + 'ArmPole'], ikCfg[visSide + 'ArmPoleProne'], pw);
    if (poleAngle) {
      _axis.subVectors(_target, _root).normalize();
      _pole.applyQuaternion(_poleQuat.setFromAxisAngle(_axis, poleAngle));
    }
    // Corrections 2/3 exist for weapon holds (hands in front of the chest). The torso capsule is
    // wider than the shoulder span, so a free arm bent backward always reads as "inside" and gets
    // forced outward; the authored free-arm pose already clears the body, so it keeps the pole.
    const bodyAware = torsoCapsule && weight > 0;
    // Correction 2 (no backward bend): redirect the pole's horizontal component outward from the
    // spine if it would otherwise bend the elbow inward; no-op when already outward (idle pose,
    // whose fixed pole is already outward+down, is bit-for-bit unchanged).
    if (bodyAware) {
      deriveOutwardPole(_pole, _root, torsoCapsule, _outPole);
      _pole.set(_outPole.x, _outPole.y, _outPole.z);
    }
    solveTwoBone(_root, _target, arm.chain.lengths[0], arm.chain.lengths[1], _pole, _joint, _end);
    // Correction 3 (no torso penetration): if the analytic solve put the elbow inside the torso
    // capsule, rebuild the pole and re-solve once. The outward direction is derived from the
    // elbow's projection onto the root->target axis (_axis, left normalized by solveTwoBone above),
    // NOT the raw elbow position — the raw elbow's offset from the spine is dominated by how far
    // along that axis it sits (fixed by root/target/bone lengths), while the much smaller bend
    // term is what the pole actually controls, so deriving "outward" from the raw elbow barely
    // redirects it. Projecting onto the axis first isolates the true bend freedom. Only the pole
    // moves and we re-solve once — bone lengths and the hand target stay exact, per the "never
    // translate a joint directly" rule (pushPointOutOfCapsule is for the pure/tested clamp itself,
    // not used here to avoid stretching the upper-arm bone).
    if (bodyAware && capsuleContainsPoint(_joint, torsoCapsule)) {
      projectOntoAxis(_joint, _root, _axis, _axisPt);
      deriveOutwardPole(_pole, _axisPt, torsoCapsule, _outPole, true);
      _pole.set(_outPole.x, _outPole.y, _outPole.z);
      solveTwoBone(_root, _target, arm.chain.lengths[0], arm.chain.lengths[1], _pole, _joint, _end);
    }
    placeSegment(arm.upper, _root, _joint, thickness, orientation);
    placeSegment(arm.lower, _joint, _end, thickness, orientation);
    arm.shoulder.position.copy(_root);
    arm.elbow.position.copy(_joint);
    arm.wrist.position.copy(_end);
    arm.hand.position.copy(_end);
    // See the matching comment in solveLeg: roll-stabilised so gear offsets mean body-right/forward.
    jointFrame(arm.shoulder, _root, _joint, orientation);
    jointFrame(arm.elbow, _joint, _end, orientation);
    jointFrame(arm.wrist, _joint, _end, orientation);
    if (arm.target?.quaternion) arm.hand.quaternion.copy(arm.target.quaternion);
    else arm.hand.quaternion.copy(orientation);
  }

  function applyModeVisibility() {
    const lowerOnly = mode === 'local-lower-body';
    waist.visible = !lowerOnly;
    torso.visible = !lowerOnly;
    neck.visible = !lowerOnly;
    if (head) head.visible = !lowerOnly;
    for (const side of ['left', 'right']) {
      arms[side].shoulder.visible = !lowerOnly;
      arms[side].upper.visible = !lowerOnly;
      arms[side].elbow.visible = !lowerOnly;
      arms[side].lower.visible = !lowerOnly;
      arms[side].wrist.visible = !lowerOnly;
      arms[side].hand.visible = !lowerOnly;
    }
    // pelvis + legs always visible in every mode.
  }
  applyModeVisibility();

  function update(dt, state) {
    if (!state) return;
    group.visible = internalVisible && state.alive !== false;
    if (!group.visible) return;
    _poseDirty = true;

    const height = state.height ?? H;
    const radius = state.radius ?? R;
    // Body faces -Z at yaw 0 to match the game/camera facing convention (camera looks down -Z).
    // Both the rig orientation and the gait use this, so feet/facing stay consistent.
    const targetYaw = (state.yaw || 0) + Math.PI;
    if (!visualYawInitialized) {
      visualYaw = targetYaw;
      visualYawInitialized = true;
    }
    const yawError = Math.atan2(Math.sin(targetYaw - visualYaw), Math.cos(targetYaw - visualYaw));
    if (turnCfg.enabled) {
      visualYawVelocity += (yawError * turnCfg.stiffness - visualYawVelocity * turnCfg.damping) * Math.max(0, dt);
      visualYawVelocity = Math.max(-turnCfg.maxSpeed, Math.min(turnCfg.maxSpeed, visualYawVelocity));
      visualYaw += visualYawVelocity * Math.max(0, dt);
    } else {
      visualYaw = targetYaw;
      visualYawVelocity = 0;
    }
    const yaw = visualYaw;
    const rawHeadYawTarget = Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw));
    const anticipateYaw = headTurnCfg.enabled
      ? Math.max(-headTurnCfg.maxYaw, Math.min(headTurnCfg.maxYaw, rawHeadYawTarget)) : 0;
    // Look-at blends OVER the turn anticipation rather than replacing it, so patrol and idle
    // scanning are untouched at lookWeight 0. lookYaw is relative to the (possibly aim-twisted)
    // spine, because that is what the head hangs off.
    const lookWeight = Math.max(0, Math.min(1, state.lookWeight || 0));
    const headYawTarget = lookWeight > 0
      ? anticipateYaw + (Math.max(-headTurnCfg.maxYaw, Math.min(headTurnCfg.maxYaw, state.lookYaw || 0)) - anticipateYaw) * lookWeight
      : anticipateYaw;
    const headFollow = 1 - Math.exp(-headTurnCfg.followRate * Math.max(0, dt));
    visualHeadYaw += (headYawTarget - visualHeadYaw) * headFollow;
    motion.headYaw = visualHeadYaw;
    const crouch = Math.max(0, Math.min(1, state.crouch || 0));
    const pos = state.position;

    let vx = 0, vz = 0, vy = 0;
    if (state.velocity) {
      vx = state.velocity.x || 0;
      vz = state.velocity.z || 0;
      vy = state.velocity.y || 0;
    } else if (hasLastPos && dt > 0) {
      vx = (pos.x - _lastHipPos.x) / dt;
      vz = (pos.z - _lastHipPos.z) / dt;
    }
    if (!state.velocity && _lastPosY != null && dt > 0 && pos.y != null) vy = (pos.y - _lastPosY) / dt;
    if (pos.y != null) _lastPosY = pos.y;
    _lastHipPos.copy(pos);
    hasLastPos = true;

    // Speed-adaptive gait: derive the four speed-varying gait fields from this body's own speed
    // via the baked model, so legs blend continuously across walk..run. Written into gait.cfg
    // before it's read below. Callers that tune gait.cfg manually should leave this flag false.
    if (adaptGaitToSpeed) {
      const model = GAIT_MODELS[movementTuning.gaitModel] || GAIT_MODELS.shipped;
      const g = gaitForSpeed(Math.hypot(vx, vz), model.speed);
      gait.cfg.pelvisHeightRatio = g.pelvisHeightRatio;
      gait.cfg.maxStepDistance = g.maxStepDistance * movementTuning.strideScale;
      gait.cfg.stepLift = g.stepLift;
      gait.cfg.stepDuration = g.stepDuration * movementTuning.cadenceScale;
    }

    _orient.setFromAxisAngle(_up, yaw);

    const pelvisHeightRatio = gait.cfg.pelvisHeightRatio * (1 - crouch * crouchCfg.pelvisDrop);
    const hipWidth = radius * 2 * gait.cfg.hipWidthRatio;
    const workspaceScale = height / H;
    const reachScale = Math.max(movementTuning.workspaceWidthScale, movementTuning.workspaceForwardScale);
    legWorkspace.minLateral = Math.max(radius * 0.32, LEG_WORKSPACE_DEFAULTS.minLateral * workspaceScale * movementTuning.workspaceWidthScale);
    legWorkspace.maxLateral = Math.max(legWorkspace.minLateral + radius * 0.6, LEG_WORKSPACE_DEFAULTS.maxLateral * workspaceScale * movementTuning.workspaceWidthScale);
    legWorkspace.forward = LEG_WORKSPACE_DEFAULTS.forward * workspaceScale * movementTuning.workspaceForwardScale;
    legWorkspace.backward = LEG_WORKSPACE_DEFAULTS.backward * workspaceScale * movementTuning.workspaceForwardScale;
    legWorkspace.maxReach = LEG_WORKSPACE_DEFAULTS.maxReach * workspaceScale * reachScale;
    motion.targetYaw = targetYaw;
    motion.visualYaw = yaw;
    motion.yawLag = Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw));
    motion.yawVelocity = visualYawVelocity;
    const groundY = terrainHeight(pos.x, pos.z);
    // Airborne lift for jumps. `onFloor` is authoritative; the ground reference auto-calibrates
    // to the player's body-center height whenever grounded, so the physics capsule floating above
    // the terrain by its radius does NOT read as a permanent jump (which would freeze the legs in
    // the tuck pose). bodyLift is 0 while grounded; only a real jump raises the rig / tucks legs.
    const onFloorFlag = state.onFloor !== false;
    const py = pos.y != null ? pos.y : groundY + height * 0.5;
    if (onFloorFlag || _groundRefY == null) _groundRefY = py;
    const safeDt = Math.max(0, dt);
    if (jumpCfg.enabled) {
      // Landing edge: absorb by impact speed and re-plant both feet together.
      if (onFloorFlag && !_wasOnFloor && _airW > 0.2) {
        const impact = Math.max(0, -_lastVy);
        _absorb = Math.min(jumpCfg.absorbMax, _absorb + impact * jumpCfg.absorbDrop);
        _landHold = jumpCfg.landHold;
        gait.resetFeet();
      }
      const airTarget = onFloorFlag ? 0 : 1;
      const rate = onFloorFlag ? jumpCfg.fallRate : jumpCfg.riseRate;
      _airW += (airTarget - _airW) * (1 - Math.exp(-rate * safeDt));
      if (_airW < 1e-3) _airW = 0;
      _absorb *= Math.exp(-jumpCfg.absorbRecover * safeDt);
      if (_absorb < 1e-4) _absorb = 0;
      _landHold = Math.max(0, _landHold - safeDt);
    } else {
      _airW = onFloorFlag ? 0 : 1;
      _absorb = 0;
      _landHold = 0;
    }
    _wasOnFloor = onFloorFlag;
    _lastVy = vy;
    _fallTime = !onFloorFlag && vy < 0 ? _fallTime + safeDt : 0;
    const airW = _airW;
    // Falling: 0 while rising fast, 1 while falling fast. Shapes the tuck and the arm pose.
    const fallT = Math.max(0, Math.min(1, 0.5 - vy * jumpCfg.vyScale));
    // Grounded bodies keep the ground-anchored pelvis; in the air the pelvis follows the capsule
    // itself (authoritative), so rises and falls both track without a lift clamp.
    const groundPelvisY = groundY + height * pelvisHeightRatio;
    const capsulePelvisY = py - height * 0.5 + height * pelvisHeightRatio;
    let pelvisY = lerp(groundPelvisY, capsulePelvisY, airW) - _absorb;
    motion.airWeight = airW;
    motion.landingAbsorb = _absorb;

    // Keep the body-space anchor at the chest, facing the body's heading, so the weapon track's
    // belt/toss/magwell hand targets translate with the player and rotate with facing.
    rootAnchor.position.set(pos.x, pelvisY + height * 0.30, pos.z);
    rootAnchor.quaternion.copy(_orient);
    rootAnchor.updateMatrixWorld(true);

    // Aim the feet at the balance point rather than straight under the hips. Along the direction
    // of travel, since that is where the mass is going (the spine's lean follows facing instead).
    const moveSpeed = Math.hypot(vx, vz);
    const stepLead = stepLeadFor(moveSpeed, gait.cfg, movementTuning.stepLeadScale);
    const leadX = moveSpeed > 1e-4 ? (vx / moveSpeed) * stepLead : 0;
    const leadZ = moveSpeed > 1e-4 ? (vz / moveSpeed) * stepLead : 0;
    // While the landing holds, feet stay planted where they touched down; the first update after
    // resetFeet() has already snapped them under the hips.
    const gaitDt = _landHold > 0 && gait.feet.left.initialized ? 0 : dt;
    gait.update(gaitDt, {
      hip: { x: pos.x + leadX, y: pelvisY, z: pos.z + leadZ },
      yaw,
      velocity: { x: vx, z: vz },
      hipWidth,
      workspace: legWorkspace,
      turnAmount: motion.yawLag,
      turnStepAngle: turnCfg.turnStepAngle,
    }, terrainHeight);
    // Cyclic layer: reads the feet the scheduler just placed and returns whole-body pose offsets.
    // When it is off we zero its weight so re-enabling fades in from neutral instead of popping.
    let loco = null;
    if (locomotion.cfg.enabled) {
      loco = locomotion.update(dt, { speed: Math.hypot(vx, vz), feet: gait.feet });
    } else if (locomotion.state.weight !== 0) {
      locomotion.state.weight = 0;
      locomotion.state.started = false;
    }
    motion.locomotion = loco;

    const steppingFoot = gait.feet.left.stepping ? gait.feet.left : (gait.feet.right.stepping ? gait.feet.right : null);
    const stepPhase = steppingFoot ? Math.max(0, Math.min(1, steppingFoot.t)) : 0;
    const supportSign = steppingFoot ? -steppingFoot.side : 0;
    if (loco) {
      // Continuous across double support, unlike the per-step sine below, which drops to zero
      // whenever neither foot is swinging and so ticks once per stride.
      motion.bob = loco.bob * (height / H) * movementTuning.bobScale;
      motion.sway = loco.sway * radius * movementTuning.swayScale;
    } else {
      motion.bob = turnCfg.enabled ? Math.sin(Math.PI * stepPhase) * Math.min(0.035, height * 0.018) * movementTuning.bobScale : 0;
      motion.sway = turnCfg.enabled ? supportSign * radius * 0.055 * Math.sin(Math.PI * stepPhase) * movementTuning.swayScale : 0;
    }
    motion.turning = Math.abs(motion.yawLag) > turnCfg.turnStepAngle;
    pelvisY += motion.bob;

    // A midpoint of both feet is continuous while a foot begins/ends its swing. The old
    // one-foot support switched references at those boundaries, which made the chest jerk.
    const supportFeet = [gait.feet.left, gait.feet.right];
    const supportX = supportFeet.reduce((sum, foot) => sum + foot.current.x, 0) / supportFeet.length;
    const supportZ = supportFeet.reduce((sum, foot) => sum + foot.current.z, 0) / supportFeet.length;
    const forwardX = Math.sin(yaw), forwardZ = Math.cos(yaw);
    const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);
    let targetForwardLead = (pos.x - supportX) * forwardX + (pos.z - supportZ) * forwardZ;
    let targetLateralLead = (pos.x - supportX) * rightX + (pos.z - supportZ) * rightZ;
    if (turnCfg.enabled) {
      targetForwardLead = Math.min(targetForwardLead, movementTuning.maxForwardLead);
      targetLateralLead = Math.max(-movementTuning.maxLateralLead, Math.min(movementTuning.maxLateralLead, targetLateralLead));
    }
    const targetBodyX = supportX + forwardX * targetForwardLead + rightX * targetLateralLead;
    const targetBodyZ = supportZ + forwardZ * targetForwardLead + rightZ * targetLateralLead;
    if (!visualBodyInitialized || Math.hypot(pos.x - visualBodyX, pos.z - visualBodyZ) > gait.cfg.teleportDistance) {
      visualBodyX = targetBodyX;
      visualBodyZ = targetBodyZ;
      visualBodyInitialized = true;
    } else {
      const follow = 1 - Math.exp(-movementTuning.bodyFollowRate * Math.max(0, dt));
      visualBodyX += (targetBodyX - visualBodyX) * follow;
      visualBodyZ += (targetBodyZ - visualBodyZ) * follow;
    }
    const bodyX = visualBodyX, bodyZ = visualBodyZ;
    const forwardLead = (bodyX - supportX) * forwardX + (bodyZ - supportZ) * forwardZ;
    const lateralLead = (bodyX - supportX) * rightX + (bodyZ - supportZ) * rightZ;
    motion.supportPosition.x = supportX; motion.supportPosition.y = terrainHeight(supportX, supportZ); motion.supportPosition.z = supportZ;
    motion.bodyPosition.x = bodyX; motion.bodyPosition.y = pelvisY; motion.bodyPosition.z = bodyZ;
    motion.forwardLead = forwardLead;
    motion.lateralLead = lateralLead;
    rootAnchor.position.set(bodyX, pelvisY + height * 0.30, bodyZ);
    rootAnchor.quaternion.copy(_orient);
    rootAnchor.updateMatrixWorld(true);

    // --- stance blend: prone (0..1) lays the body horizontal along its heading -------------
    // pw=0 reproduces the upright path exactly; pw>0 lerps positions and slerps orientation
    // toward the prone pose (pitched body, hips low, limbs fore/aft) via proneCfg.
    const pw = Math.max(0, Math.min(1, state.prone || 0));
    // Stance precedence is prone > kneel > crouch: each gates the ones below it, so two stances
    // can never both claim the pelvis. kw is the kneel weight already yielded to prone.
    const kw = Math.max(0, Math.min(1, state.kneel || 0)) * (1 - pw);
    // Kneel height is in SKELETON units (thighLen), not state.height: limb lengths are fixed at
    // the H=1.8 baseline for every body (only meshes scale), so a height-scaled hip would leave
    // the rear thigh unable to reach the ground.
    // pelvisYK is the kneel-adjusted hip height. The whole upper-body stack hangs off it, not off
    // the standing pelvisY, or the torso would float in place while the hips dropped away.
    // pelvisYP adds prone on top and is what the pelvis mesh and the legs use.
    const pelvisYK = kw > 0 ? lerp(pelvisY, groundY + thighLen * kneelCfg.hipHeight, kw) : pelvisY;
    const pelvisYP = pw > 0 ? lerp(pelvisYK, groundY + proneCfg.hipHeight, pw) : pelvisYK;
    _F.set(0, 0, 1).applyQuaternion(_orient);   // body forward (heading)
    _Rt.set(1, 0, 0).applyQuaternion(_orient);  // body right
    _proneQuat.copy(_orient).multiply(_qx.setFromAxisAngle(_X, proneCfg.pitch)); // pitch forward
    _bodyQ.copy(_orient);
    if (pw > 0) _bodyQ.slerp(_proneQuat, pw);

    // Crouch hunch: pitch the upper body forward and shift it along the heading. Gated by
    // (1-pw) so prone (which owns the full body pitch) wins when both are somehow set.
    const cw = crouch * (1 - pw) * (1 - kw);
    const cFwd = crouchCfg.fwd * cw + kneelCfg.fwd * kw;
    // Per-joint vertical squash, summed across whichever stances are active. With kw = 0 these
    // reduce to exactly the old `crouch * crouchCfg.*Drop` terms.
    const dropTorso = crouch * (1 - kw) * crouchCfg.torsoDrop + kw * kneelCfg.torsoDrop;
    const dropHead = crouch * (1 - kw) * crouchCfg.headDrop + kw * kneelCfg.headDrop;
    const dropShoulder = crouch * (1 - kw) * crouchCfg.shoulderDrop + kw * kneelCfg.shoulderDrop;
    // Base = body orientation + the crouch hunch, which is NOT graded (it is a whole-torso pose).
    _upperBaseQ.copy(_bodyQ);
    const upperLean = crouchCfg.lean * cw + kneelCfg.lean * kw;
    if (upperLean !== 0) _upperBaseQ.multiply(_qx.setFromAxisAngle(_X, upperLean));

    // Locomotion rotations, all in the body's local frame (+X right, +Y up, +Z heading) and all
    // faded out by prone, which owns the whole-body pose. The pelvis and the shoulders turn in
    // OPPOSITE directions — that counter-rotation is most of what separates a walking torso from
    // a rigid block being slid along.
    // _pelvisQ orients the pelvis MESH (so it inherits the prone blend in _bodyQ); _hipQ places the
    // hip SOCKETS and must stay on the upright _orient the legs have always used, or prone hips
    // would swing out even with this layer off. Both pick up the same locomotion rotation.
    const lw = loco ? (1 - pw) * (1 - kw) : 0;
    _pelvisQ.copy(_bodyQ);
    _hipQ.copy(_orient);
    if (lw > 0) {
      if (loco.pelvisYaw) {
        _locoQ.setFromAxisAngle(_up, loco.pelvisYaw * lw);
        _pelvisQ.multiply(_locoQ); _hipQ.multiply(_locoQ);
      }
      if (loco.pelvisRoll) {
        _locoQ.setFromAxisAngle(_Z, loco.pelvisRoll * lw);
        _pelvisQ.multiply(_locoQ); _hipQ.multiply(_locoQ);
      }
    }
    if (kw > 0 && kneelCfg.hipYaw) {
      // Squares the hips toward the rear leg. Applied to the sockets too, so the legs follow.
      _locoQ.setFromAxisAngle(_up, kneelCfg.hipYaw * kw * (kneelCfg.side < 0 ? -1 : 1));
      _pelvisQ.multiply(_locoQ); _hipQ.multiply(_locoQ);
    }
    // _upperQ is the FULL (shoulder-line) rotation; each spine segment takes its own share below.
    if (spineCfg.falloff !== _lastFalloff) { _lastFalloff = spineCfg.falloff; refreshSpineFractions(); }
    _spineLw = lw;
    _spineLean = lw > 0 ? loco.torsoLean : 0;
    _spineYaw = lw > 0 ? loco.shoulderYaw : 0;
    // Aim channels, in the body's local frame. Absent (every caller but bot-viewer-v3) they are 0
    // and the spine renders exactly as it did before they existed.
    _aimYaw = state.aimYaw || 0;
    _aimLean = state.aimLean || 0;
    motion.aimYaw = _aimYaw;
    motion.aimLean = _aimLean;
    spineOrient(_upperQ, 1);

    // body meshes
    const lateralSway = motion.sway * (1 - pw);
    pelvis.position.set(bodyX, pelvisYP, bodyZ).addScaledVector(_Rt, lateralSway);
    pelvis.quaternion.copy(_pelvisQ);

    _uPos.set(bodyX, pelvisYK + height * 0.10 * (1 - dropTorso), bodyZ).addScaledVector(_F, cFwd);
    if (pw > 0) {
      _pPos.set(bodyX, pelvisYP, bodyZ).addScaledVector(_F, proneCfg.torsoFwd * 0.35).addScaledVector(_up, proneCfg.torsoUp * 0.5);
      _uPos.lerp(_pPos, pw);
    }
    waist.position.copy(_uPos).addScaledVector(_Rt, lateralSway);
    waist.quaternion.copy(spineOrient(_segQ, _spineFrac.waist));

    _uPos.set(bodyX, pelvisYK + height * design.torsoYRatio * (1 - dropTorso), bodyZ).addScaledVector(_F, cFwd);
    if (pw > 0) {
      _pPos.set(bodyX, pelvisYP, bodyZ).addScaledVector(_F, proneCfg.torsoFwd).addScaledVector(_up, proneCfg.torsoUp);
      _uPos.lerp(_pPos, pw);
    }
    torso.position.copy(_uPos).addScaledVector(_Rt, lateralSway);
    torso.quaternion.copy(spineOrient(_segQ, _spineFrac.torso));

    _uPos.set(bodyX, pelvisYK + height * design.neckYRatio * (1 - dropHead), bodyZ).addScaledVector(_F, cFwd);
    if (pw > 0) {
      _pPos.set(bodyX, pelvisYP, bodyZ).addScaledVector(_F, proneCfg.headFwd * 0.7).addScaledVector(_up, proneCfg.headUp * 0.75);
      _uPos.lerp(_pPos, pw);
    }
    neck.position.copy(_uPos).addScaledVector(_Rt, lateralSway);
    neck.quaternion.copy(spineOrient(_segQ, _spineFrac.neck));

    if (head) {
      _uPos.set(bodyX, pelvisYK + height * design.headYRatio * (1 - dropHead), bodyZ).addScaledVector(_F, cFwd);
      if (pw > 0) {
        _pPos.set(bodyX, pelvisYP, bodyZ).addScaledVector(_F, proneCfg.headFwd).addScaledVector(_up, proneCfg.headUp);
        _uPos.lerp(_pPos, pw);
      }
      head.position.copy(_uPos).addScaledVector(_Rt, lateralSway);
      head.quaternion.copy(_upperQ)
        .multiply(_headYawQ.setFromAxisAngle(_up, visualHeadYaw))
        .multiply(_headPitchQ.setFromAxisAngle(_X, (state.aimPitch || 0) + proneCfg.headPitch * pw));
      applyEyeConfig();
    }

    // legs (foot targets lerp from gait/air anchors to behind-pelvis prone anchors)
    const legScale = limbThickness;
    for (const side of ['left', 'right']) {
      const sideSign = side === 'left' ? -1 : 1;
      // Hip sockets ride the PELVIS, not the raw body orientation, so its roll/yaw actually
      // carries the legs (a pelvis mesh that rotated alone would just detach from them). The
      // roll puts a vertical component into the offset, which is the hip drop over the swing leg.
      const local = _legLocal.set(sideSign * hipWidth * 0.5, 0, 0).applyQuaternion(_hipQ);
      const hipAttach = _hipAttach.set(bodyX + local.x, pelvisYP + local.y, bodyZ + local.z);
      // The pelvis mesh has always swayed laterally while the sockets did not; with the cyclic
      // layer on, the sway is large enough that the legs have to ride with it.
      if (lw > 0) hipAttach.addScaledVector(_Rt, lateralSway);
      const cur = gait.feet[side].current;
      _footU.set(cur.x, cur.y, cur.z);
      if (airW > 0) {
        const tuck = lerp(jumpCfg.tuckRise, jumpCfg.tuckFall, fallT);
        _footK.set(hipAttach.x, pelvisYP - legLen * tuck, hipAttach.z)
          .addScaledVector(_F, -legLen * jumpCfg.footForward * (1 - fallT));
        _footU.lerp(_footK, airW);
      }

      // Kneel authors the KNEE as well as the foot. Prone can lerp only the foot and let IK find
      // the knee, but a kneeling knee has to be on the ground under the hip and no pole angle
      // reliably puts it there — so solveLeg takes both and blends the solved joint toward it.
      let kneeK = null, ankleK = 0;
      if (kw > 0) {
        const rear = sideSign === (kneelCfg.side < 0 ? -1 : 1);
        const g = terrainHeight(bodyX, bodyZ);
        if (rear) {
          _kneeK.set(bodyX, g + thighLen * kneelCfg.rearKneeHeight, bodyZ)
            .addScaledVector(_Rt, sideSign * thighLen * kneelCfg.rearKneeSpread);
          _footK.copy(_kneeK)
            .addScaledVector(_F, -shinLen * kneelCfg.rearFootBack)
            .addScaledVector(_up, shinLen * kneelCfg.rearFootHeight);
          ankleK = kneelCfg.rearAnklePitch;
        } else {
          _kneeK.set(bodyX, g + thighLen * kneelCfg.frontKneeHeight, bodyZ)
            .addScaledVector(_Rt, sideSign * shinLen * kneelCfg.frontFootSpread)
            .addScaledVector(_F, thighLen * kneelCfg.frontKneeFwd);
          _footK.copy(_kneeK);
          _footK.y = g + shinLen * kneelCfg.frontFootHeight;   // foot sits directly under the knee
          ankleK = kneelCfg.frontAnklePitch;
        }
        _footU.lerp(_footK, kw);
        kneeK = _kneeK;
      }

      if (pw > 0) {
        _footP.set(bodyX, pelvisYP, bodyZ).addScaledVector(_F, -proneCfg.footBack).addScaledVector(_Rt, sideSign * proneCfg.footSpread);
        _footP.y = terrainHeight(_footP.x, _footP.z) + proneCfg.footHeight;
        _footU.lerp(_footP, pw);
      }
      const anklePitch = (lw > 0 ? loco.anklePitch[side] * lw : 0) + ankleK * kw;
      if (legGone(side)) continue;   // stump joints stay where they were; gait.feet still ticks
      solveLeg(legs[side], side, hipAttach, _footU, _bodyQ, legScale, pw, anklePitch, kneeK, kw);
    }

    // arms (stub idle pose; weapon track drives via setArmTarget). Shoulders brace forward when prone.
    const shoulderY = pelvisYK + height * 0.34 * (1 - dropShoulder);
    // Torso capsule for arm body-awareness (Correction 2/3 in solveArm): vertical, centered on the
    // spine, spanning pelvis..shoulders with a little padding, radius = body radius + limb margin.
    _torsoCapsule.x = bodyX;
    _torsoCapsule.z = bodyZ;
    _torsoCapsule.yMin = Math.min(pelvisYK, shoulderY) - TORSO_CAPSULE_Y_PAD;
    _torsoCapsule.yMax = Math.max(pelvisYK, shoulderY) + TORSO_CAPSULE_Y_PAD;
    _torsoCapsule.radius = radius + TORSO_CAPSULE_RADIUS_MARGIN;
    // Shoulder sockets carry the counter-rotation, so the chest turns as a unit with the arms on it.
    _shoulderQ.copy(_orient);
    if (lw > 0 && loco.shoulderYaw) _shoulderQ.multiply(_locoQ.setFromAxisAngle(_up, loco.shoulderYaw * lw));
    // Sockets take the FULL aim twist, like the shoulder-line _upperQ: a spine that twists without
    // them would leave the arms hanging off the old chest facing.
    if (_aimYaw) _shoulderQ.multiply(_locoQ.setFromAxisAngle(_up, _aimYaw));
    for (const side of ['left', 'right']) {
      const sideSign = side === 'left' ? -1 : 1;
      const local = _armLocal.set(sideSign * radius * 0.66, 0, 0).applyQuaternion(_shoulderQ);
      _uPos.set(bodyX + local.x, shoulderY, bodyZ + local.z).addScaledVector(_F, cFwd);
      if (pw > 0) {
        _pPos.set(bodyX, pelvisYP, bodyZ)
          .addScaledVector(_F, proneCfg.shoulderFwd)
          .addScaledVector(_Rt, sideSign * radius * proneCfg.shoulderSpread)
          .addScaledVector(_up, proneCfg.shoulderUp);
        _uPos.lerp(_pPos, pw);
      }
      // Contralateral arm swing, applied to the IDLE target only: solveArm already blends idle out
      // by the weapon target's weight, so an aiming body keeps its hands on the gun and only a
      // free arm swings. Rotating about local +X by -angle carries the hanging hand forward.
      let idleLocal = side === 'left' ? _idleArmLeft : _idleArmRight;
      if (armCfg.enabled) {
        // Gait blend by horizontal speed, then the contralateral swing signal from the locomotion
        // layer (-1..1, already weighted and asymmetric) scaled by this gait's own amplitude.
        // The pose blend follows a smoothed speed so tapping sprint fades the arms in over a few
        // strides instead of snapping with the controller's near-instant acceleration.
        const rawSpeedH = Math.hypot(vx, vz);
        const tau = Math.max(0, armCfg.poseSmoothing || 0);
        _armSpeed = tau > 0 ? _armSpeed + (rawSpeedH - _armSpeed) * (1 - Math.exp(-safeDt / tau)) : rawSpeedH;
        const speedH = _armSpeed;
        motion.armPoseSpeed = speedH;
        const wWalk = smoothstep01(speedH / Math.max(1e-3, armCfg.walkSpeed));
        const wRun = smoothstep01((speedH - armCfg.runSpeedLo) / Math.max(1e-3, armCfg.runSpeedHi - armCfg.runSpeedLo));
        const gaitMix = (key) => lerp(lerp(armCfg.idle[key], armCfg.walk[key], wWalk), armCfg.run[key], wRun);
        const swingSignal = lw > 0 && locomotion.cfg.armSwing > 0 ? (loco.armSwing[side] / locomotion.cfg.armSwing) * lw : 0;
        const absorbNorm = _absorb / Math.max(1e-6, jumpCfg.absorbMax);
        // Falling: arms come up and out with fall speed AND time, so a long drop reads as a flail
        // that keeps building, while a short hop barely moves them.
        const fallSpeedW = smoothstep01(Math.max(0, -vy) / Math.max(1e-3, armCfg.fallSpeedRef));
        const fallTimeW = smoothstep01(_fallTime / Math.max(1e-3, armCfg.fallTimeRef));
        const fallW = airW * Math.max(fallSpeedW * 0.5 + fallTimeW * 0.5, fallSpeedW * fallTimeW);
        _armPose.raise = gaitMix('raise') + armCfg.jumpLift * airW * (1 - fallT) + armCfg.fallLift * fallW - armCfg.landSwing * absorbNorm * 0.5;
        _armPose.bend = gaitMix('bend') + gaitMix('pump') * Math.max(0, swingSignal) + armCfg.landSwing * absorbNorm * 0.6;
        _armPose.spread = gaitMix('spread') + armCfg.jumpSpread * airW + armCfg.jumpSpread * fallW;
        _armPose.swingAngle = gaitMix('swing') * swingSignal * (1 - airW);
        armPoseHandLocal(_armPose, sideSign, upperArmLen, forearmLen, _armHand);
        _armSwingV.set(_armHand.x, _armHand.y, _armHand.z);
        idleLocal = _armSwingV;
      } else {
        if (lw > 0 && (loco.armSwing[side] || loco.armSpread[side])) {
          _armSwingV.copy(idleLocal).applyQuaternion(_locoQ.setFromAxisAngle(_X, -loco.armSwing[side] * lw));
          _armSwingV.x += sideSign * loco.armSpread[side] * lw;
          idleLocal = _armSwingV;
        }
        const jumpArm = jumpCfg.armRaise * airW * (1 - fallT) * 0.5 + jumpCfg.armLand * (_absorb / Math.max(1e-6, jumpCfg.absorbMax));
        if (jumpArm > 1e-4) {
          if (idleLocal !== _armSwingV) _armSwingV.copy(idleLocal);
          _armSwingV.applyQuaternion(_locoQ.setFromAxisAngle(_X, -jumpArm));
          idleLocal = _armSwingV;
        }
      }
      if (armGone(side)) continue;   // a missing arm has nothing to reach with, weapon target or not
      solveArm(side, arms[side], _uPos, idleLocal, _bodyQ, armThick, pw, _torsoCapsule);
    }

    // After every limb is posed: joints have moved, so any body-facing gear on them must be re-rolled.
    if (_faceAnchors.length) orientFaceAnchors(_F);
  }

  // Re-roll every body-facing gear anchor so its +Y runs down the bone and its +Z points as close to
  // the body's forward as that allows.
  //
  // WHY THIS EXISTS. Limb-joint frames come from setFromUnitVectors(up, boneDir), whose roll about
  // the bone is whatever the minimal arc happens to give — and near a straight-down leg that arc is
  // ~180 degrees, where the axis is degenerate and the roll can flip. So a pad placed on the "front"
  // of a knee would drift off the front as the leg swings and snap when it straightens. Everything
  // at a joint therefore had to be symmetric about the bone, which is why knee pads came out as
  // 360-degree wraps that read as compression sleeves rather than shells.
  //
  // Gram-Schmidt against the body forward is deterministic and pose-independent: the roll is chosen,
  // not inherited. Falls back to the body's right when the bone is parallel to forward (a leg raised
  // straight ahead), where "forward" has no perpendicular component to keep.
  const _faQ = new THREE.Quaternion(), _faM = new THREE.Matrix4();
  const _faY = new THREE.Vector3(), _faZ = new THREE.Vector3(), _faX = new THREE.Vector3();
  const _faHostQ = new THREE.Quaternion(), _faA = new THREE.Vector3(), _faB = new THREE.Vector3();
  function orientFaceAnchors(bodyFwd) {
    for (const fa of _faceAnchors) {
      const child = fa.child();
      if (!child) continue;
      fa.host.getWorldPosition(_faA);
      child.getWorldPosition(_faB);
      _faY.subVectors(_faB, _faA);
      if (_faY.lengthSq() < 1e-8) continue;
      _faY.normalize();
      _faZ.copy(bodyFwd).addScaledVector(_faY, -bodyFwd.dot(_faY));
      if (_faZ.lengthSq() < 1e-6) _faZ.set(bodyFwd.z, 0, -bodyFwd.x);   // bone || forward
      _faZ.normalize();
      _faX.crossVectors(_faY, _faZ).normalize();
      _faM.makeBasis(_faX, _faY, _faZ);
      _faQ.setFromRotationMatrix(_faM);
      // The anchor is a CHILD of the host, so convert the world orientation into host-local space.
      fa.host.getWorldQuaternion(_faHostQ);
      fa.anchor.quaternion.copy(_faHostQ.invert()).multiply(_faQ);
    }
  }

  function setArmTarget(side, target) {
    if (side !== 'left' && side !== 'right') return;
    // Internal rig sides are mirrored by the yaw+PI facing spin; swap so 'left' drives the visually-left arm.
    arms[side === 'left' ? 'right' : 'left'].target = target || null;
  }

  /**
   * Amputation flags, in VISUAL limb naming to match `parts` and setArmTarget. The solve for a
   * missing limb is skipped, which leaves its joints frozen at their last pose rather than chasing a
   * target with no endpoint — and is a cost REDUCTION, since it skips a FABRIK solve.
   *
   * Hiding the parts is the caller's job (bot-limb-map.js knows which parts belong to a limb);
   * flush() already skips anything invisible, so nothing else is needed to make it disappear.
   *
   * Body lean is unaffected: it comes from a midpoint of `gait.feet`, which the gait scheduler keeps
   * updating whether or not the leg is solved, so a missing leg does not tilt the torso.
   */
  const _amputated = { leftArm: false, rightArm: false, leftLeg: false, rightLeg: false };
  function setAmputated(limb, on = true) {
    if (!(limb in _amputated)) return false;
    _amputated[limb] = !!on;
    _poseDirty = true;
    return true;
  }
  const armGone = (internalSide) => _amputated[internalSide === 'left' ? 'rightArm' : 'leftArm'];
  const legGone = (internalSide) => _amputated[internalSide === 'left' ? 'rightLeg' : 'leftLeg'];

  /** Swap the rbox pieces to their cheap twin (1) or back to full detail (0). Instanced mode only. */
  function setGearLod(level) {
    const l = level ? 1 : 0;
    if (l === _gearLod || !_lodParts.length) return;
    _gearLod = l;
    for (const p of _lodParts) p.geometry = p.userData.lodGeo[l];
  }

  function setVisible(v) {
    internalVisible = !!v;
    group.visible = internalVisible;
    _poseDirty = true;   // matrices went stale while hidden; the first frame back must rebuild them
  }

  function setTint(hsl) {
    if (!hsl) return;
    const { h = 0, s = 0.5, l = 0.5 } = hsl;
    if (instanced) {
      _roleColor.shell.setHSL(h, s, l);
      _roleColor.plate.setHSL(h, s, l);
      _roleColor.trim.setHSL(h, s, l);
      return;
    }
    for (const mat of tintMaterials) mat.color.setHSL(h, s, l);
  }

  // Instanced mode: emit every visible part's world matrix + per-role color into the shared batch
  // pool. Called once per frame per visible body AFTER update() (or after a skipped strided update,
  // so the held pose persists). No-op in mesh mode or when the whole body is hidden.
  function flush(pool, refreshMatrices = true) {
    if (!instanced || !pool || !group.visible) return;
    // The walk is the single most expensive thing here (~170 nodes/bot), so it runs only when the
    // pose actually moved. The caller's hint is advisory; _poseDirty is the authority.
    if (refreshMatrices || _poseDirty) { group.updateMatrixWorld(true); _poseDirty = false; }
    for (const part of _instanceParts) {
      if (!part.visible) continue;
      pool.add(part.geometry, part._role, part.matrixWorld, _roleColor[part._role]);
    }
  }

  // Pose the whole rig directly from 16 ragdoll joint world positions instead of the IK/gait solve
  // — used for the death flop. Reuses placeSegment so limbs stretch identically; torso orientation
  // comes from a spine-up + shoulder-right basis. Symmetric geometry makes L/R mesh assignment
  // cosmetic. Call in place of update() each frame while dead; works in mesh and instanced mode.
  function rdBasis(upFromName, upToName, out) {
    _rdUp.subVectors(_rdJ[upToName], _rdJ[upFromName]);
    if (_rdUp.lengthSq() < 1e-8) _rdUp.set(0, 1, 0); else _rdUp.normalize();
    _rdRight.subVectors(_rdJ.shoulderR, _rdJ.shoulderL);   // lateral (visual-right side)
    if (_rdRight.lengthSq() < 1e-8) _rdRight.set(1, 0, 0); else _rdRight.normalize();
    // Forward = up × lateral, matching the body's hardcoded +PI facing (eyes sit on the head's -Z at
    // yaw 0). cross(lateral, up) faces the opposite way — that's what snapped the head 180° on death.
    _rdFwd.crossVectors(_rdUp, _rdRight);
    if (_rdFwd.lengthSq() < 1e-6) _rdFwd.set(0, 0, -1); else _rdFwd.normalize();
    _rdRight.crossVectors(_rdUp, _rdFwd).normalize();
    _rdMat.makeBasis(_rdRight, _rdUp, _rdFwd);
    out.setFromRotationMatrix(_rdMat);
  }
  function poseLimb(seg1, seg2, jRoot, jMid, jEnd, joints3, thickness, orientation = null) {
    placeSegment(seg1, jRoot, jMid, thickness, orientation);
    placeSegment(seg2, jMid, jEnd, thickness, orientation);
    joints3[0].position.copy(jRoot); joints3[1].position.copy(jMid);
    joints3[2].position.copy(jEnd); joints3[3].position.copy(jEnd);
    _dir.subVectors(jEnd, jMid).normalize();
    joints3[3].quaternion.setFromUnitVectors(_up, _dir);
  }
  function setRagdollPose(P) {
    for (const n of _rdNames) if (P[n]) _rdJ[n].copy(P[n]);
    rdBasis('pelvis', 'neck', _rdBodyQ);
    rdBasis('neck', 'head', _rdHeadQ);
    pelvis.position.copy(_rdJ.pelvis); pelvis.quaternion.copy(_rdBodyQ);
    waist.position.lerpVectors(_rdJ.pelvis, _rdJ.chest, 0.30); waist.quaternion.copy(_rdBodyQ);
    torso.position.lerpVectors(_rdJ.pelvis, _rdJ.chest, 0.72); torso.quaternion.copy(_rdBodyQ);
    neck.position.copy(_rdJ.neck); neck.quaternion.copy(_rdHeadQ);
    if (head) { head.position.copy(_rdJ.head); head.quaternion.copy(_rdHeadQ); }
    poseLimb(legs.left.upper, legs.left.lower, _rdJ.hipL, _rdJ.kneeL, _rdJ.footL, [legs.left.hip, legs.left.knee, legs.left.ankle, legs.left.foot], limbThickness, _rdBodyQ);
    poseLimb(legs.right.upper, legs.right.lower, _rdJ.hipR, _rdJ.kneeR, _rdJ.footR, [legs.right.hip, legs.right.knee, legs.right.ankle, legs.right.foot], limbThickness, _rdBodyQ);
    poseLimb(arms.left.upper, arms.left.lower, _rdJ.shoulderL, _rdJ.elbowL, _rdJ.handL, [arms.left.shoulder, arms.left.elbow, arms.left.wrist, arms.left.hand], armThick, _rdBodyQ);
    poseLimb(arms.right.upper, arms.right.lower, _rdJ.shoulderR, _rdJ.elbowR, _rdJ.handR, [arms.right.shoulder, arms.right.elbow, arms.right.wrist, arms.right.hand], armThick, _rdBodyQ);
    _poseDirty = true;
  }

  function destroy() {
    _bodyGeoCache.releaseAll?.(_heldGeoKeys); _heldGeoKeys = null;  // drop this body's cache holds (both modes); null guards double-destroy
    if (instanced) { _instanceParts.length = 0; return; }  // no scene node, no owned geometry/materials
    if (group.parent) group.parent.remove(group);
    group.traverse(obj => {
      if (obj.geometry && !obj.geometry.userData.shared) obj.geometry.dispose();
    });
    for (const mat of materials) mat.dispose();
  }

  // `gait` is exposed so callers/tools can live-tune cfg (stepLift, maxStepDistance,
  // pelvisHeightRatio, …) without a rebuild; treat as read-mostly.
  // `parts` is the full placeholder registry for authoring/inspection tools. `joints` only ever
  // exposed pickable joints and core parts — limb SEGMENTS and gear were unreachable from outside,
  // and gear cannot be identified by geometry (equal-length bones share one cached BufferGeometry).
  // VISUAL side naming throughout, matching `joints` (internal sides are mirrored).
  const parts = {
    core: { pelvis, waist, torso, neck, head, eyes },
    arms: { left: arms.right, right: arms.left },
    legs: { left: legs.right, right: legs.left },
    gear: gearParts,
    all: instanced ? _instanceParts : null,
  };

  // Close the record span: every sharedGeo() call above (core, gear, LOD twins, boot/eye) is now
  // captured, so this handle is exactly the geometry set destroy() must release.
  _heldGeoKeys = _bodyGeoCache.endRecord?.() || [];

  return { group, rootAnchor, update, setRagdollPose, setArmTarget, setAmputated, setVisible, setGearLod, setTint, flush, destroy, gait, locomotion, spineCfg, motion, turnCfg,
    // limbLengths: the fixed skeleton the kneel offsets are multiples of, so tools can show closure
    limbLengths: { legLen, thighLen, shinLen, armLen },
    headTurnCfg, legWorkspace, movementTuning, proneCfg, kneelCfg, crouchCfg, jumpCfg, armCfg, eyeCfg, ikCfg, joints, parts,
    // Copies a named preset into armCfg (live). Returns the applied preset name.
    setArmPreset(name) { Object.assign(armCfg, armPoseFromPreset(name)); return armCfg.preset; } };
}
