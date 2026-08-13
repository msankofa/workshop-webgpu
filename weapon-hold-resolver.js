// Pure, THREE-free resolution of a third-person weapon hold from (stance x locomotion).
// Imported by bot-viewer-v2.html AND weapon-animation-viewer.html so what the authoring tool shows
// is literally what the game renders. Unit-tested in test-weapon-hold-resolver.mjs.
//
// Two axes, deliberately combined differently:
//
//   STANCE (stand/crouch/kneel/prone) is CONTINUOUS. The rig itself blends those by eased 0..1
//   weights, so the gun must ride the same weights or it detaches from the body mid-transition.
//   Handled by lerping the per-weapon authored holds, exactly as environment-viewer.html does.
//   Each stance needs its OWN authored hold: the mount is fixed at feetY + 1.5 and never moves, so
//   the hold's Y is the only thing expressing how far that stance drops the shoulders.
//
//   LOCOMOTION (idle/walk/run/dash/aim) is an ADDITIVE DELTA on top of that blend. Authoring the
//   cross product would be 5 x 3 = 15 holds per weapon; a delta is 3 per weapon CLASS and composes
//   with any stance for free (crouch-walk = crouchHold + walk delta). The delta is eased toward its
//   target rather than switched, so transitions glide with no per-name bookkeeping.
//
// A carry delta is normally FLAT -- one {position, rotation} that applies unchanged across every
// stance (the common case: most weapons read fine at any stance with the same off-target swing). A
// weapon whose carry has to look different prone vs standing (e.g. a long, back-heavy launcher) can
// opt a single locomotion entry into a { stand?, crouch?, kneel?, prone? } map instead, each a flat
// delta; missing stances fall back along the same chain stance holds use (crouch -> stand, kneel ->
// crouch, prone -> kneel). That map is blended by the SAME eased stance weights the stance holds use,
// via `weights`, the third argument to carryDeltaFor -- so a stance-aware carry never disagrees with
// the stance hold it stacks on mid-transition. See resolveCarryEntry/blendStanceDelta below.
//
// Rotations compose by component-wise addition, not quaternion multiplication. That matches how the
// stance holds are already blended (environment-viewer.html's holdLerp) and, more importantly, it is
// what the authoring sliders manipulate directly -- so the tool stays WYSIWYG.

export const LOCOMOTION_IDLE = 'idle';
export const LOCOMOTION_WALK = 'walk';
export const LOCOMOTION_RUN = 'run';
export const LOCOMOTION_DASH = 'dash';
export const LOCOMOTION_AIM = 'aim';

export const LOCOMOTION_KINDS = [LOCOMOTION_IDLE, LOCOMOTION_WALK, LOCOMOTION_RUN, LOCOMOTION_DASH, LOCOMOTION_AIM];

// Rate (exponential 1/s) the carry delta eases at. ~180 ms to settle, matched to the stance blend
// so a bot that starts running does not get the gun and the body arriving at different times.
export const CARRY_BLEND_RATE = 9;

const ZERO_DELTA = Object.freeze({ position: Object.freeze([0, 0, 0]), rotation: Object.freeze([0, 0, 0]) });
export const DEFAULT_HOLD = Object.freeze({ position: Object.freeze([0, 0, 0]), rotation: Object.freeze([0, 0, 0]), scale: 1 });

// Per-CLASS carry vocabulary. Weapons opt in with `carryClass: 'rifle' | 'pistol'` in weapons.js and
// may override any single entry with their own `carryHolds`. Deltas are relative to that weapon's
// blended stance hold, so they read the same on a 2x rifle mount and a 0.68x pistol mount.
//
// Sign conventions in this mount space (verified against weapon-pose-controller.js's recoil, which
// raises the muzzle with `r[0] - kick`): +rotation[0] pitches the MUZZLE DOWN, +rotation[1] yaws the
// weapon ACROSS the body toward perpendicular, +rotation[2] rolls it clockwise from behind.
export const CARRY_PRESETS = Object.freeze({
  rifle: Object.freeze({
    // Patrol carry: rolled hard across the chest and carried out on the support side -- the roll,
    // not the pitch, is what reads as "slung across the body" on a long gun.
    walk: Object.freeze({ position: Object.freeze([-0.39, 0.14, 0.25]), rotation: Object.freeze([1.34, 0.53, -1.16]) }),
    // Running carry: the same rolled cross-body shape as walk, pulled further onto the support side
    // and yawed harder across, so the long gun clears the legs at a sprint.
    run: Object.freeze({ position: Object.freeze([-1.02, 0.30, 0.37]), rotation: Object.freeze([0.95, 1.09, -0.67]) }),
    // Blast-evade sprint: one hand, muzzle near-vertical (-1.47 ~= -84 deg) and the whole weapon
    // dropped to the hip -- carried low, not up at the shoulder, so the barrel clears the head.
    dash: Object.freeze({ position: Object.freeze([-0.40, -1.57, 0.01]), rotation: Object.freeze([-1.47, 0.03, 0.44]) }),
  }),
  pistol: Object.freeze({
    // NOT a scaled-down rifle carry: a pistol low-ready hangs at the thigh pointing straight down
    // (pitch 1.13 ~= 65 deg, dropped 0.39) with essentially no cross-body yaw. Only long guns need
    // to be swung across the chest to keep the barrel out of the way.
    walk: Object.freeze({ position: Object.freeze([-0.08, -0.39, 0.03]), rotation: Object.freeze([1.13, -0.10, 0.06]) }),
    run: Object.freeze({ position: Object.freeze([-0.05, -0.14, -0.10]), rotation: Object.freeze([0.90, 0.55, 0.16]) }),
    // Drawn in across the body rather than held out wide -- a pistol muzzle-up at arm's length
    // clips the head on the circle, so the dash tuck pulls it in and back.
    dash: Object.freeze({ position: Object.freeze([-0.52, -0.13, -0.60]), rotation: Object.freeze([-1.18, 0.18, 0.26]) }),
  }),
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp01 = (v) => Math.min(1, Math.max(0, num(v)));
const vec3 = (a) => (Array.isArray(a) && a.length >= 3 ? a : ZERO_DELTA.position);

// A hold that is missing entirely must not collapse the weapon to the mount origin: fall back along
// the authored chain (prone -> stand -> identity) the way the viewers already do individually.
function holdOr(primary, fallback) {
  return primary || fallback || DEFAULT_HOLD;
}

// Shared stance-blend weights, in the rig's own precedence: prone > kneel > crouch, each gating the
// ones below it (blendStanceHeightScale computes the identical triple). Used both for stance holds
// (resolveWeaponHold) and for stance-aware carry deltas (blendStanceDelta) so the two axes agree.
//
// Kneel used to fold into the crouch weight, on the assumption that a kneeling body puts the gun at
// roughly the crouch hold's height. Measured, it does not: this rig's crouch parks the hip in a deep
// squat at 0.40 m while a kneel sits it at a full thigh length, 0.58 m, and the shoulder drop is 0.06
// against crouch's 0.19 -- so kneeling shoulders ride 0.26 m HIGHER than crouching ones. Sharing the
// hold left a kneeling rifle half a metre below where the hands are. Kneel now has its own slot.
function stanceBlendWeights(weights) {
  const pw = clamp01(weights?.prone01);
  const kw = clamp01(weights?.kneel01) * (1 - pw);
  const cw = clamp01(weights?.crouch01) * (1 - pw) * (1 - kw);
  return { cw, kw, pw };
}

// Blends a { position, rotation } triple across stand -> crouch -> kneel -> prone with the same
// nested lerp resolveWeaponHold uses, so a stance-aware carry composes identically. Missing entries
// fall back along the chain (crouch -> stand, kneel -> crouch, prone -> kneel), matching holdOr.
function blendStanceDelta(weights, standD, crouchD, proneD, kneelD) {
  const stand = standD || ZERO_DELTA;
  const crouch = crouchD || stand;
  const kneel = kneelD || crouch;
  const prone = proneD || kneel;
  const { cw, kw, pw } = stanceBlendWeights(weights);
  const position = [0, 0, 0], rotation = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const sp = num(stand.position[i]), sr = num(stand.rotation[i]);
    const mp = sp + (num(crouch.position[i]) - sp) * cw;
    const mr = sr + (num(crouch.rotation[i]) - sr) * cw;
    const kp = mp + (num(kneel.position[i]) - mp) * kw;
    const kr = mr + (num(kneel.rotation[i]) - mr) * kw;
    position[i] = kp + (num(prone.position[i]) - kp) * pw;
    rotation[i] = kr + (num(prone.rotation[i]) - kr) * pw;
  }
  return { position, rotation };
}

// A carry entry is either a flat { position, rotation } delta (uniform across every stance -- the
// original shape, still the default) or a { stand?, crouch?, prone? } map of flat deltas, opted into
// per locomotion entry for a weapon whose carry has to look different prone vs standing. Resolved with
// the caller's stance weights so the composed pose never disagrees with the stance hold it stacks on.
function resolveCarryEntry(entry, weights) {
  if (!entry) return null;
  if (entry.position) return entry;   // flat: unchanged across stance, frozen reference preserved
  return blendStanceDelta(weights, entry.stand, entry.crouch, entry.prone, entry.kneel);
}

// idle/aim carry no delta: those ARE the authored stance holds. Unknown names read as idle. `weights`
// is the same eased {crouch01, prone01} resolveWeaponHold takes -- only consulted when an entry opts
// into the stance-aware map shape; the common flat entry ignores it entirely.
export function carryDeltaFor(def, locomotion, weights) {
  if (locomotion !== LOCOMOTION_WALK && locomotion !== LOCOMOTION_RUN && locomotion !== LOCOMOTION_DASH) return ZERO_DELTA;
  const own = resolveCarryEntry(def?.carryHolds?.[locomotion], weights);
  if (own) return own;
  const preset = CARRY_PRESETS[def?.carryClass];
  return resolveCarryEntry(preset && preset[locomotion], weights) || ZERO_DELTA;
}

// Weapons with no carry vocabulary at all (melee, thrown) keep their authored stance hold in every
// locomotion state rather than inheriting a rifle's muzzle-down swing.
export function hasCarryVocabulary(def) {
  return !!(def && (def.carryHolds || CARRY_PRESETS[def.carryClass]));
}

// Which carry a bot should show. Pure so the authoring tool and the sim agree on the mapping, not
// just on the poses. `aiming` wins over everything: a bot that is shooting holds the gun up even at
// a sprint, or it would fire from a muzzle-down carry.
export function locomotionFor({ stance = 'stand', aiming = false, moving = false } = {}) {
  if (aiming) return LOCOMOTION_AIM;
  if (stance === 'dash') return LOCOMOTION_DASH;
  if (stance === 'run') return LOCOMOTION_RUN;
  return moving ? LOCOMOTION_WALK : LOCOMOTION_IDLE;
}

// Carry states hold the weapon off-target; barrel-solving one onto an aim point would undo the whole
// pose. The viewer gates alignMountedWeaponToPoint on this.
export function isCarryLocomotion(locomotion) {
  return locomotion === LOCOMOTION_WALK || locomotion === LOCOMOTION_RUN || locomotion === LOCOMOTION_DASH;
}

// Dash is the one-handed carry: the support hand comes off the weapon and tucks at the chest.
export function isOneHanded(locomotion) {
  return locomotion === LOCOMOTION_DASH;
}

// Mutating exponential ease of a caller-owned { position:[3], rotation:[3] } toward `target`.
// Safe with a null/fresh state; returns the state so callers can assign on first use.
export function stepCarryBlend(st, target, dt, rate = CARRY_BLEND_RATE) {
  const out = st || { position: [0, 0, 0], rotation: [0, 0, 0] };
  const tp = vec3(target?.position), tr = vec3(target?.rotation);
  const k = Math.max(0, num(rate)) * Math.max(0, num(dt));
  if (!(k > 0)) return out;
  const a = 1 - Math.exp(-k);
  for (let i = 0; i < 3; i++) {
    out.position[i] = num(out.position[i]) + (num(tp[i]) - num(out.position[i])) * a;
    out.rotation[i] = num(out.rotation[i]) + (num(tr[i]) - num(out.rotation[i])) * a;
  }
  return out;
}

// Snap the blend straight onto a target (weapon swap, teleport, first frame) so nothing glides in
// from a stale pose.
export function snapCarryBlend(st, target) {
  const out = st || { position: [0, 0, 0], rotation: [0, 0, 0] };
  const tp = vec3(target?.position), tr = vec3(target?.rotation);
  for (let i = 0; i < 3; i++) { out.position[i] = num(tp[i]); out.rotation[i] = num(tr[i]); }
  return out;
}

// The resolve. `weights` are the SAME eased {crouch01, prone01} the rig poses with (bot-stance.js's
// stepStanceWeights), and `carry` is the eased delta from stepCarryBlend (pass null for none).
// Writes into `out` when given, so the per-frame path allocates nothing.
export function resolveWeaponHold(def, weights, carry, out) {
  const target = out || { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const stand = holdOr(def?.thirdPersonHold, DEFAULT_HOLD);
  const crouch = holdOr(def?.crouchHold, stand);
  // A weapon with no kneel hold falls back to crouch, which is what every weapon did before the
  // slot existed -- wrong by ~0.26 m, but no worse than it was, and never collapsed to the origin.
  const kneel = holdOr(def?.kneelHold, crouch);
  const prone = holdOr(def?.proneHold, stand);
  const { cw, kw, pw } = stanceBlendWeights(weights);
  const cp = vec3(carry?.position), cr = vec3(carry?.rotation);
  for (let i = 0; i < 3; i++) {
    const sp = num(stand.position[i]), sr = num(stand.rotation[i]);
    const mp = sp + (num(crouch.position[i]) - sp) * cw;
    const mr = sr + (num(crouch.rotation[i]) - sr) * cw;
    const kp = mp + (num(kneel.position[i]) - mp) * kw;
    const kr = mr + (num(kneel.rotation[i]) - mr) * kw;
    target.position[i] = kp + (num(prone.position[i]) - kp) * pw + num(cp[i]);
    target.rotation[i] = kr + (num(prone.rotation[i]) - kr) * pw + num(cr[i]);
  }
  const ss = stand.scale ?? 1;
  const mid = ss + ((crouch.scale ?? ss) - ss) * cw;
  const midK = mid + ((kneel.scale ?? ss) - mid) * kw;
  target.scale = midK + ((prone.scale ?? ss) - midK) * pw;
  return target;
}
