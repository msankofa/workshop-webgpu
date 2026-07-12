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

// ============================================================================
// ===================== Pure gait scheduler (no THREE) ======================
// ============================================================================

const MIN_STEP_DURATION = 0.12; // fastest a single step may play, so sprints don't jitter

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

function easeInOut(t) { return t * t * (3 - 2 * t); }
function hyp(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }
function lerp(a, b, t) { return a + (b - a) * t; }

// Rotates a body-local (x, 0, z) offset into world space by yaw. Matches the
// rotateXZ convention in port-creature-system.js: local +z is forward.
function rotateYawXZ(lx, lz, yaw) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return { x: lx * cy + lz * sy, z: -lx * sy + lz * cy };
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
  const aheadDist = standing ? 0 : Math.min(cfg.maxStepDistance, speed * effStepDur);
  // While standing, tighten the step deadband so feet tidy up under the hips instead of
  // freezing wherever they last landed within the (larger) walking trigger distance.
  const trigger = standing ? cfg.triggerDistance * 0.35 : cfg.triggerDistance;

  const desired = {};
  for (const key of ['left', 'right']) {
    const foot = feet[key];
    const dx = foot.rest.x + moveDir.x * aheadDist;
    const dz = foot.rest.z + moveDir.z * aheadDist;
    desired[key] = { x: dx, y: terrainHeight(dx, dz), z: dz };
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

  // Feet alternate: only one foot may begin a new step per tick, and never
  // while the other is already mid-step.
  const anyStepping = feet.left.stepping || feet.right.stepping;
  const wanters = [];
  for (const key of ['left', 'right']) {
    const foot = feet[key];
    const target = desired[key];
    foot.target.x = target.x; foot.target.y = target.y; foot.target.z = target.z;
    if (foot.stepping) continue;
    const dh = hyp(foot.current.x, foot.current.z, target.x, target.z);
    const dv = Math.abs(foot.current.y - target.y);
    if (dh > trigger || dv > trigger * 0.6) wanters.push({ key, dh });
  }
  if (!anyStepping && wanters.length) {
    // Alternate. Prefer the foot that did NOT step most recently, so a foot can't restart
    // the same tick it lands (the advance loop clears its `stepping` flag above, which would
    // otherwise let the first-checked foot re-take the single step slot forever and starve
    // the other one). A lone wanter (e.g. a large drift correction) steps unconditionally.
    let pick;
    if (wanters.length === 1) {
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
  limbShape: 'mannequin',  // 'mannequin' | 'box' | 'capsule' | 'cylinder'
  head: true,
};

function mergeStyle(style) {
  return { ...DEFAULT_STYLE, ...(style || {}) };
}

export function createProceduralPlayerBody({ THREE, scene, terrainHeight, mode = 'remote', style, adaptGaitToSpeed = false }) {
  const palette = mergeStyle(style);
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
  const legLen = H * 0.62;
  const thighLen = legLen * 0.52;
  const shinLen = legLen * 0.48;
  const armLen = H * 0.42;
  const upperArmLen = armLen * 0.5;
  const forearmLen = armLen * 0.5;
  const limbThickness = R * 0.32;

  // ------------------------------ materials --------------------------------
  const shellMat = new THREE.MeshStandardMaterial({ color: palette.shell, roughness: 0.65, metalness: 0.05 });
  const plateMat = new THREE.MeshStandardMaterial({ color: palette.plate, roughness: 0.55, metalness: 0.1 });
  const trimMat = new THREE.MeshStandardMaterial({ color: palette.trim, roughness: 0.4, metalness: 0.15 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x080808, side: THREE.DoubleSide });
  const tintMaterials = [shellMat, plateMat, trimMat];
  const materials = [shellMat, plateMat, trimMat, eyeMat];

  function makeLatheGeometry(profile, radialSegments = 18) {
    const points = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y));
    const geo = new THREE.LatheGeometry(points, radialSegments);
    geo.computeVertexNormals();
    return geo;
  }

  function makeMannequinLimbGeometry(length, thickness) {
    const r = thickness * 0.5;
    const cap = Math.min(length * 0.22, thickness * 1.15);
    return makeLatheGeometry([
      [r * 0.12, -length * 0.5],
      [r * 0.72, -length * 0.5 + cap * 0.18],
      [r * 0.98, -length * 0.5 + cap * 0.62],
      [r * 0.78, 0],
      [r * 0.92, length * 0.5 - cap * 0.62],
      [r * 0.66, length * 0.5 - cap * 0.18],
      [r * 0.12, length * 0.5],
    ], 14);
  }

  function makeLimbGeometry(length, thickness) {
    if (palette.limbShape === 'mannequin') {
      const geo = makeMannequinLimbGeometry(length, thickness);
      geo.userData.proceduralLimb = { baseLength: length, baseThickness: thickness };
      return geo;
    }
    if (palette.limbShape === 'capsule') {
      return new THREE.CapsuleGeometry(thickness * 0.5, Math.max(0.001, length - thickness), 4, 8);
    }
    if (palette.limbShape === 'cylinder') {
      // Height axis is Y (same as the box path), so placeSegment stretches it along the bone.
      return new THREE.CylinderGeometry(thickness * 0.5, thickness * 0.5, length, 12);
    }
    return new THREE.BoxGeometry(thickness, length, thickness);
  }

  // ------------------------------- group -----------------------------------
  const group = new THREE.Group();
  group.name = 'proceduralPlayerBody';
  if (scene) scene.add(group);

  // Body root anchor: a parent-less node kept at chest height + facing yaw each frame. The rig
  // itself writes meshes in absolute world space (group stays at the origin), so this node — NOT
  // group — is the frame the weapon track resolves body-space hand targets against (belt/magwell/
  // toss refs in the reload sequence). Without it those targets ignore player position + facing.
  const rootAnchor = new THREE.Object3D();
  rootAnchor.name = 'proceduralPlayerBodyRoot';

  // Mannequin-like torso/pelvis profiles. placeSegment isn't involved; update() positions and
  // orients these directly, so the scale set here sticks.
  const pelvis = new THREE.Mesh(makeLatheGeometry([
    [R * 0.20, -H * 0.095],
    [R * 0.55, -H * 0.082],
    [R * 0.72, -H * 0.018],
    [R * 0.62, H * 0.064],
    [R * 0.30, H * 0.095],
  ], 22), plateMat);
  pelvis.scale.set(1, 1, 0.68);
  group.add(pelvis);

  const waist = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.28, R * 0.34, H * 0.052, 18), trimMat);
  waist.scale.set(1, 1, 0.72);
  group.add(waist);

  const torso = new THREE.Mesh(makeLatheGeometry([
    [R * 0.22, -H * 0.145],
    [R * 0.40, -H * 0.120],
    [R * 0.62, -H * 0.020],
    [R * 0.72, H * 0.082],
    [R * 0.58, H * 0.142],
    [R * 0.28, H * 0.156],
  ], 24), shellMat);
  torso.scale.set(1, 1, 0.54);
  group.add(torso);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.16, R * 0.18, H * 0.070, 16), trimMat);
  neck.scale.set(1, 1, 0.82);
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
  function applyEyeConfig() {
    if (!eyes) return;
    const halfSpacing = eyeCfg.spacing * 0.5;
    eyes.left.position.set(eyeCfg.x - halfSpacing, eyeCfg.y, eyeCfg.z);
    eyes.right.position.set(eyeCfg.x + halfSpacing, eyeCfg.y, eyeCfg.z);
    eyes.left.scale.set(eyeCfg.width, eyeCfg.length, eyeCfg.depth);
    eyes.right.scale.copy(eyes.left.scale);
  }
  if (palette.head !== false) {
    head = new THREE.Mesh(makeLatheGeometry([
      [R * 0.08, -H * 0.092],
      [R * 0.28, -H * 0.078],
      [R * 0.38, -H * 0.008],
      [R * 0.34, H * 0.066],
      [R * 0.18, H * 0.098],
      [R * 0.04, H * 0.105],
    ], 18), trimMat);
    head.scale.set(1, 1, 0.82);
    group.add(head);

    const eyeGeo = new THREE.SphereGeometry(1, 12, 8);
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    head.add(leftEye, rightEye);
    eyes = { left: leftEye, right: rightEye };
    applyEyeConfig();
  }

  function makeJoint(radius, mat = trimMat) {
    return new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), mat);
  }

  function makeLeg() {
    const chain = new KinematicChain([
      { length: thighLen, initDirection: new THREE.Vector3(0, -1, 0.15 * kneeSign).normalize() },
      { length: shinLen, initDirection: new THREE.Vector3(0, -1, -0.1 * kneeSign).normalize() },
    ]);
    const upper = new THREE.Mesh(makeLimbGeometry(thighLen, limbThickness), shellMat);
    const lower = new THREE.Mesh(makeLimbGeometry(shinLen, limbThickness), shellMat);
    const hip = makeJoint(limbThickness * 0.62, trimMat);
    const knee = makeJoint(limbThickness * 0.56, trimMat);
    const ankle = makeJoint(limbThickness * 0.45, trimMat);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), plateMat);
    foot.scale.set(limbThickness * 0.72, limbThickness * 0.28, limbThickness * 1.55);
    group.add(upper, lower, hip, knee, ankle, foot);
    return { chain, upper, lower, hip, knee, ankle, foot };
  }
  const legs = { left: makeLeg(), right: makeLeg() };

  function makeArm() {
    const chain = new KinematicChain([
      { length: upperArmLen, initDirection: new THREE.Vector3(0, -1, 0).normalize() },
      { length: forearmLen, initDirection: new THREE.Vector3(0, -1, 0.2 * elbowSign).normalize() },
    ]);
    const upper = new THREE.Mesh(makeLimbGeometry(upperArmLen, limbThickness * 0.85), shellMat);
    const lower = new THREE.Mesh(makeLimbGeometry(forearmLen, limbThickness * 0.85), shellMat);
    const shoulder = makeJoint(limbThickness * 0.72, trimMat);
    const elbow = makeJoint(limbThickness * 0.50, trimMat);
    const wrist = makeJoint(limbThickness * 0.40, trimMat);
    const hand = new THREE.Mesh(makeLatheGeometry([
      [limbThickness * 0.04, -limbThickness * 0.86],
      [limbThickness * 0.28, -limbThickness * 0.58],
      [limbThickness * 0.36, limbThickness * 0.05],
      [limbThickness * 0.20, limbThickness * 0.46],
      [limbThickness * 0.04, limbThickness * 0.55],
    ], 12), trimMat);
    hand.scale.set(1, 1, 0.58);
    group.add(upper, lower, shoulder, elbow, wrist, hand);
    return { chain, upper, lower, shoulder, elbow, wrist, hand, target: null };
  }
  const arms = { left: makeArm(), right: makeArm() };

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

  // Crouch pose tuning (state.crouch 0..1 squashes the upright stack). The *drop fields are the
  // fraction each joint lowers at crouch=1; lean pitches the upper body forward (rad) and fwd
  // shifts it forward along the heading, so crouch reads as a hunch, not a pure vertical squash.
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
  const _groundQ = new THREE.Quaternion();
  const _qx = new THREE.Quaternion();
  const _X = new THREE.Vector3(1, 0, 0);
  const _uPos = new THREE.Vector3();
  const _pPos = new THREE.Vector3();
  const _footU = new THREE.Vector3();
  const _footP = new THREE.Vector3();
  let hasLastPos = false;
  let _groundRefY = null; // body-center height last time the player was grounded (auto-calibrated)
  let internalVisible = true;

  // Torso capsule (body-awareness for arm IK, see solveArm below), rebuilt once per update().
  const _torsoCapsule = { x: 0, z: 0, yMin: 0, yMax: 0, radius: 0 };
  const _outPole = { x: 0, y: 0, z: 0 };   // scratch for deriveOutwardPole's plain-object out param
  const _axisPt = { x: 0, y: 0, z: 0 };    // scratch for projectOntoAxis's plain-object out param

  function placeSegment(mesh, a, b, thickness) {
    _mid.copy(a).add(b).multiplyScalar(0.5);
    mesh.position.copy(_mid);
    const length = Math.max(0.001, a.distanceTo(b));
    _dir.subVectors(b, a).normalize();
    mesh.quaternion.setFromUnitVectors(_up, _dir);
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

  function solveLeg(leg, side, hipAttach, footTarget, orientation, thickness, pw) {
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
    placeSegment(leg.upper, _root, _joint, thickness);
    placeSegment(leg.lower, _joint, _end, thickness);
    leg.hip.position.copy(_root);
    leg.knee.position.copy(_joint);
    leg.ankle.position.copy(_end);
    leg.foot.position.copy(_end);
    terrainNormal(_end.x, _end.z, _dir);
    _groundQ.setFromUnitVectors(_up, _dir);
    leg.foot.quaternion.copy(_groundQ).multiply(orientation);
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
    // Correction 2 (no backward bend): redirect the pole's horizontal component outward from the
    // spine if it would otherwise bend the elbow inward; no-op when already outward (idle pose,
    // whose fixed pole is already outward+down, is bit-for-bit unchanged).
    if (torsoCapsule) {
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
    if (torsoCapsule && capsuleContainsPoint(_joint, torsoCapsule)) {
      projectOntoAxis(_joint, _root, _axis, _axisPt);
      deriveOutwardPole(_pole, _axisPt, torsoCapsule, _outPole, true);
      _pole.set(_outPole.x, _outPole.y, _outPole.z);
      solveTwoBone(_root, _target, arm.chain.lengths[0], arm.chain.lengths[1], _pole, _joint, _end);
    }
    placeSegment(arm.upper, _root, _joint, thickness);
    placeSegment(arm.lower, _joint, _end, thickness);
    arm.shoulder.position.copy(_root);
    arm.elbow.position.copy(_joint);
    arm.wrist.position.copy(_end);
    arm.hand.position.copy(_end);
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

    const height = state.height ?? H;
    const radius = state.radius ?? R;
    // Body faces -Z at yaw 0 to match the game/camera facing convention (camera looks down -Z).
    // Both the rig orientation and the gait use this, so feet/facing stay consistent.
    const yaw = (state.yaw || 0) + Math.PI;
    const crouch = Math.max(0, Math.min(1, state.crouch || 0));
    const pos = state.position;

    let vx = 0, vz = 0;
    if (state.velocity) {
      vx = state.velocity.x || 0;
      vz = state.velocity.z || 0;
    } else if (hasLastPos && dt > 0) {
      vx = (pos.x - _lastHipPos.x) / dt;
      vz = (pos.z - _lastHipPos.z) / dt;
    }
    _lastHipPos.copy(pos);
    hasLastPos = true;

    // Speed-adaptive gait: derive the four speed-varying gait fields from this body's own speed
    // via the baked model, so legs blend continuously across walk..run. Written into gait.cfg
    // before it's read below. Callers that tune gait.cfg manually should leave this flag false.
    if (adaptGaitToSpeed) {
      const g = gaitForSpeed(Math.hypot(vx, vz));
      gait.cfg.pelvisHeightRatio = g.pelvisHeightRatio;
      gait.cfg.maxStepDistance = g.maxStepDistance;
      gait.cfg.stepLift = g.stepLift;
      gait.cfg.stepDuration = g.stepDuration;
    }

    _orient.setFromAxisAngle(_up, yaw);

    const pelvisHeightRatio = gait.cfg.pelvisHeightRatio * (1 - crouch * crouchCfg.pelvisDrop);
    const hipWidth = radius * 2 * gait.cfg.hipWidthRatio;
    const groundY = terrainHeight(pos.x, pos.z);
    // Airborne lift for jumps. `onFloor` is authoritative; the ground reference auto-calibrates
    // to the player's body-center height whenever grounded, so the physics capsule floating above
    // the terrain by its radius does NOT read as a permanent jump (which would freeze the legs in
    // the tuck pose). bodyLift is 0 while grounded; only a real jump raises the rig / tucks legs.
    const onFloorFlag = state.onFloor !== false;
    const py = pos.y != null ? pos.y : groundY + height * 0.5;
    if (onFloorFlag || _groundRefY == null) _groundRefY = py;
    const bodyLift = onFloorFlag ? 0 : Math.max(0, py - _groundRefY);
    const airborne = !onFloorFlag && bodyLift > 0.05;
    const pelvisY = groundY + height * pelvisHeightRatio + bodyLift;

    // Keep the body-space anchor at the chest, facing the body's heading, so the weapon track's
    // belt/toss/magwell hand targets translate with the player and rotate with facing.
    rootAnchor.position.set(pos.x, pelvisY + height * 0.30, pos.z);
    rootAnchor.quaternion.copy(_orient);
    rootAnchor.updateMatrixWorld(true);

    gait.update(dt, {
      hip: { x: pos.x, y: pelvisY, z: pos.z },
      yaw,
      velocity: { x: vx, z: vz },
      hipWidth,
    }, terrainHeight);

    // --- stance blend: prone (0..1) lays the body horizontal along its heading -------------
    // pw=0 reproduces the upright path exactly; pw>0 lerps positions and slerps orientation
    // toward the prone pose (pitched body, hips low, limbs fore/aft) via proneCfg.
    const pw = Math.max(0, Math.min(1, state.prone || 0));
    const pelvisYP = pw > 0 ? lerp(pelvisY, groundY + proneCfg.hipHeight, pw) : pelvisY;
    _F.set(0, 0, 1).applyQuaternion(_orient);   // body forward (heading)
    _Rt.set(1, 0, 0).applyQuaternion(_orient);  // body right
    _proneQuat.copy(_orient).multiply(_qx.setFromAxisAngle(_X, proneCfg.pitch)); // pitch forward
    _bodyQ.copy(_orient);
    if (pw > 0) _bodyQ.slerp(_proneQuat, pw);

    // Crouch hunch: pitch the upper body forward and shift it along the heading. Gated by
    // (1-pw) so prone (which owns the full body pitch) wins when both are somehow set.
    const cw = crouch * (1 - pw);
    const cFwd = crouchCfg.fwd * cw;
    _upperQ.copy(_bodyQ);
    if (cw > 0 && crouchCfg.lean !== 0) _upperQ.multiply(_qx.setFromAxisAngle(_X, crouchCfg.lean * cw));

    // body meshes
    pelvis.position.set(pos.x, pelvisYP, pos.z);
    pelvis.quaternion.copy(_bodyQ);

    _uPos.set(pos.x, pelvisY + height * 0.10 * (1 - crouch * crouchCfg.torsoDrop), pos.z).addScaledVector(_F, cFwd);
    if (pw > 0) {
      _pPos.set(pos.x, pelvisYP, pos.z).addScaledVector(_F, proneCfg.torsoFwd * 0.35).addScaledVector(_up, proneCfg.torsoUp * 0.5);
      _uPos.lerp(_pPos, pw);
    }
    waist.position.copy(_uPos);
    waist.quaternion.copy(_upperQ);

    _uPos.set(pos.x, pelvisY + height * 0.22 * (1 - crouch * crouchCfg.torsoDrop), pos.z).addScaledVector(_F, cFwd);
    if (pw > 0) {
      _pPos.set(pos.x, pelvisYP, pos.z).addScaledVector(_F, proneCfg.torsoFwd).addScaledVector(_up, proneCfg.torsoUp);
      _uPos.lerp(_pPos, pw);
    }
    torso.position.copy(_uPos);
    torso.quaternion.copy(_upperQ);

    _uPos.set(pos.x, pelvisY + height * 0.37 * (1 - crouch * crouchCfg.headDrop), pos.z).addScaledVector(_F, cFwd);
    if (pw > 0) {
      _pPos.set(pos.x, pelvisYP, pos.z).addScaledVector(_F, proneCfg.headFwd * 0.7).addScaledVector(_up, proneCfg.headUp * 0.75);
      _uPos.lerp(_pPos, pw);
    }
    neck.position.copy(_uPos);
    neck.quaternion.copy(_upperQ);

    if (head) {
      _uPos.set(pos.x, pelvisY + height * 0.48 * (1 - crouch * crouchCfg.headDrop), pos.z).addScaledVector(_F, cFwd);
      if (pw > 0) {
        _pPos.set(pos.x, pelvisYP, pos.z).addScaledVector(_F, proneCfg.headFwd).addScaledVector(_up, proneCfg.headUp);
        _uPos.lerp(_pPos, pw);
      }
      head.position.copy(_uPos);
      head.quaternion.copy(_upperQ).multiply(_qx.setFromAxisAngle(_X, (state.aimPitch || 0) + proneCfg.headPitch * pw));
      applyEyeConfig();
    }

    // legs (foot targets lerp from gait/air anchors to behind-pelvis prone anchors)
    const legScale = limbThickness;
    for (const side of ['left', 'right']) {
      const sideSign = side === 'left' ? -1 : 1;
      const local = new THREE.Vector3(sideSign * hipWidth * 0.5, 0, 0).applyQuaternion(_orient);
      const hipAttach = new THREE.Vector3(pos.x + local.x, pelvisYP, pos.z + local.z);
      const cur = gait.feet[side].current;
      _footU.set(cur.x, cur.y, cur.z);
      if (airborne) _footU.set(hipAttach.x, pelvisYP - legLen * 0.72, hipAttach.z);
      if (pw > 0) {
        _footP.set(pos.x, pelvisYP, pos.z).addScaledVector(_F, -proneCfg.footBack).addScaledVector(_Rt, sideSign * proneCfg.footSpread);
        _footP.y = terrainHeight(_footP.x, _footP.z) + proneCfg.footHeight;
        _footU.lerp(_footP, pw);
      }
      solveLeg(legs[side], side, hipAttach, _footU, _bodyQ, legScale, pw);
    }

    // arms (stub idle pose; weapon track drives via setArmTarget). Shoulders brace forward when prone.
    const shoulderY = pelvisY + height * 0.34 * (1 - crouch * crouchCfg.shoulderDrop);
    const idleLocalLeft = new THREE.Vector3(-1, -1.1, 0.1).normalize().multiplyScalar(armLen * 0.7);
    const idleLocalRight = new THREE.Vector3(1, -1.1, 0.1).normalize().multiplyScalar(armLen * 0.7);
    // Torso capsule for arm body-awareness (Correction 2/3 in solveArm): vertical, centered on the
    // spine, spanning pelvis..shoulders with a little padding, radius = body radius + limb margin.
    _torsoCapsule.x = pos.x;
    _torsoCapsule.z = pos.z;
    _torsoCapsule.yMin = Math.min(pelvisY, shoulderY) - TORSO_CAPSULE_Y_PAD;
    _torsoCapsule.yMax = Math.max(pelvisY, shoulderY) + TORSO_CAPSULE_Y_PAD;
    _torsoCapsule.radius = radius + TORSO_CAPSULE_RADIUS_MARGIN;
    for (const side of ['left', 'right']) {
      const sideSign = side === 'left' ? -1 : 1;
      const local = new THREE.Vector3(sideSign * radius * 0.66, 0, 0).applyQuaternion(_orient);
      _uPos.set(pos.x + local.x, shoulderY, pos.z + local.z).addScaledVector(_F, cFwd);
      if (pw > 0) {
        _pPos.set(pos.x, pelvisYP, pos.z)
          .addScaledVector(_F, proneCfg.shoulderFwd)
          .addScaledVector(_Rt, sideSign * radius * proneCfg.shoulderSpread)
          .addScaledVector(_up, proneCfg.shoulderUp);
        _uPos.lerp(_pPos, pw);
      }
      solveArm(side, arms[side], _uPos, side === 'left' ? idleLocalLeft : idleLocalRight, _bodyQ, limbThickness * 0.85, pw, _torsoCapsule);
    }
  }

  function setArmTarget(side, target) {
    if (side !== 'left' && side !== 'right') return;
    // Internal rig sides are mirrored by the yaw+PI facing spin; swap so 'left' drives the visually-left arm.
    arms[side === 'left' ? 'right' : 'left'].target = target || null;
  }

  function setVisible(v) {
    internalVisible = !!v;
    group.visible = internalVisible;
  }

  function setTint(hsl) {
    if (!hsl) return;
    const { h = 0, s = 0.5, l = 0.5 } = hsl;
    for (const mat of tintMaterials) mat.color.setHSL(h, s, l);
  }

  function destroy() {
    if (group.parent) group.parent.remove(group);
    group.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
    });
    for (const mat of materials) mat.dispose();
  }

  // `gait` is exposed so callers/tools can live-tune cfg (stepLift, maxStepDistance,
  // pelvisHeightRatio, …) without a rebuild; treat as read-mostly.
  return { group, rootAnchor, update, setArmTarget, setVisible, setTint, destroy, gait, proneCfg, crouchCfg, eyeCfg, ikCfg, joints };
}
