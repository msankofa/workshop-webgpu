// Pure, THREE-free decision math for the combat-bot FSM (Phase 1: sentry aim/fire; Phase 2:
// patrol/seek movement). Mirrors creature-activity.js's split (pure decision logic here,
// world-wiring in the importer) but combat states are gated by concrete conditions, not
// weighted-random picks. Unit-tested in test-bot-activity.mjs. See
// docs/superpowers/specs/2026-07-13-combat-bot-fsm-design.md.
//
// retreat (back off when hp01 is low) still isn't implemented -- no bot HP model exists yet
// (Phase 3 per the spec).

export const BOT_PATROL = 'patrol';
export const BOT_SEEK = 'seek';
export const BOT_AIM = 'aim';
export const BOT_FIRE = 'fire';

export const SENSE_RANGE = 25; // metres; matches creature-activity.js's HUNT_SENSE-style sense constants
export const AIM_TOLERANCE_RAD = 0.03; // ~1.7 degrees -- tight enough to read as "locked on" without float-precision flicker
export const TURN_RATE_RAD_S = 4.5; // full 180-degree turn in ~0.7s: readable, not an instant aimbot snap

// Deterministic transition: no randomness (unlike creature-activity.js's weighted picker)
// because sentry/patrol behavior is fully determined by target visibility/aim/cooldown/last-seen
// state, not drives competing for a roll. `readyToFire` (weapon cooldown elapsed) and
// `hasLastKnown` (a remembered last-seen target position not yet reached) are owned by the
// caller, not this module, so bot-activity.js stays free of wall-clock/position-memory state.
// `current` is accepted for API symmetry with creature-activity.js's chooseActivity call site;
// this module's rules don't reference it (no anti-repeat bias needed for a deterministic FSM).
export function chooseBotState({ current = BOT_PATROL, ctx = {} } = {}) {
  const { targetVisible = false, aimError = Infinity, readyToFire = false, hasLastKnown = false } = ctx;
  if (targetVisible) {
    if (aimError > AIM_TOLERANCE_RAD) return { state: BOT_AIM };
    return { state: readyToFire ? BOT_FIRE : BOT_AIM };
  }
  return { state: hasLastKnown ? BOT_SEEK : BOT_PATROL };
}

// Yaw (around Y, atan2(dx,dz) so 0 = +Z -- the convention bot.yaw is stored in everywhere in this
// module and in the movement/fire code that reads it) and pitch (around X, positive = looking
// up) from `from` toward `to`. bot-entity.js's toWirePose applies a +pi offset when converting
// this to the wire quaternion, since that convention is camera-relative (0 = -Z-forward).
export function aimAnglesTo(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const horiz = Math.hypot(dx, dz);
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, horiz) };
}

// Normalize an angle to (-PI, PI].
function wrapAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

// Combined yaw+pitch angular error (radians), shortest-way-around for yaw.
export function aimError(currentYaw, currentPitch, targetYaw, targetPitch) {
  const dy = wrapAngle(targetYaw - currentYaw);
  const dp = targetPitch - currentPitch;
  return Math.hypot(dy, dp);
}

// Turn-rate-capped slew of one angle toward a target, shortest direction around the circle.
export function slewAngle(current, target, maxDeltaRad) {
  const diff = wrapAngle(target - current);
  const clamped = Math.max(-maxDeltaRad, Math.min(maxDeltaRad, diff));
  return wrapAngle(current + clamped);
}
