// Pure, THREE-free decision math for the combat-bot FSM (Phase 1: sentry aim/fire; Phase 2:
// patrol/seek movement). Mirrors creature-activity.js's split (pure decision logic here,
// world-wiring in the importer) but combat states are gated by concrete conditions, not
// weighted-random picks. Unit-tested in test-bot-activity.mjs. See
// docs/superpowers/specs/2026-07-13-combat-bot-fsm-design.md.
//
// Phase 3 adds an independent low-health flee-to-heal chain; health timing remains owned by
// the viewer while this module only makes the deterministic state choice.

export const BOT_PATROL = 'patrol';
export const BOT_SEEK = 'seek';
export const BOT_PURSUE = 'pursue';
export const BOT_FLEE = 'flee';
export const BOT_HEAL = 'heal';
export const BOT_KNIFE = 'knife';
export const BOT_AIM = 'aim';
export const BOT_FIRE = 'fire';
export const BOT_COVER_MOVE = 'cover-move';
export const BOT_COVER_HOLD = 'cover-hold';

export const SENSE_RANGE = 25; // metres; matches creature-activity.js's HUNT_SENSE-style sense constants
export const AIM_TOLERANCE_RAD = 0.03; // ~1.7 degrees -- tight enough to read as "locked on" without float-precision flicker
export const TURN_RATE_RAD_S = 4.5; // full 180-degree turn in ~0.7s: readable, not an instant aimbot snap
export const CLOSE_THREAT_RADIUS = 4; // m; a self-threat this close from outside the FOV cone preempts committed aim (H6a)

// Deterministic transition: no randomness (unlike creature-activity.js's weighted picker)
// because sentry/patrol behavior is fully determined by target visibility/aim/cooldown/last-seen
// state, not drives competing for a roll. `readyToFire` (weapon cooldown elapsed) and
// `hasLastKnown` (a remembered last-seen target position not yet reached) are owned by the
// caller, not this module, so bot-activity.js stays free of wall-clock/position-memory state.
// `current` retains a committed action across transient perception changes. Lower-priority
// investigation must not cancel a retreat whose path is still active.
// Every ctx field defaults to the pre-existing behaviour when absent, so a partial ctx (v1 viewer,
// older tests) walks the identical ladder. `concealedFromTarget` is NOT read here: it rides the
// harness ctx object purely to feed `shouldTopOffReload` below.
export function chooseBotState({ current = BOT_PATROL, ctx = {} } = {}) {
  return { state: chooseBotStateName(current, ctx) };
}

// Allocation-free variant: same ladder, returns the bare state string (hot-loop callers can
// reuse one ctx object instead of paying a fresh literal + {state} wrapper per bot per frame).
export function chooseBotStateName(current = BOT_PATROL, ctx = {}) {
  const { targetVisible = false, aimError = Infinity, readyToFire = false, hasLastKnown = false,
    targetDistance = Infinity, pursueDistance = Infinity, pursueExitBuffer = 0,
    fleeDistance = 0, fleeExitBuffer = 0,
    fleeCommitted = false, healRequested = false, healFleeCommitted = false,
    knifeRequested = false,
    keepsMissing = false, pursueHealthOk = true,
    healReady = false, healUnsafe = false, hasHealResource = true,
    coverAvailable = false, atCoverAnchor = false, coverValid = false,
    allyHitNearby = false, coverCommitted = false,
    fireCapable = true, knifeCapable = false,
    closeSelfThreat = false, reloading = false, orderOverride = false } = ctx;
  // Health retreat is a committed two-step survival action. Once a bot reaches HEAL,
  // normal target perception cannot pull it back into combat; only explicit danger does.
  // HEAL also requires a consumable pack: a bot that just spent its last pack falls back to
  // flee (the caller clears healRequested once the pack is gone).
  if (current === BOT_HEAL && healRequested && hasHealResource) {
    if (healUnsafe) return BOT_FLEE;
    return BOT_HEAL;
  }
  if (healRequested) {
    if (current === BOT_FLEE && healFleeCommitted) return BOT_FLEE;
    if (healUnsafe) return BOT_FLEE; // safety dominates readiness even if a caller sends both
    // A wounded bot with no pack keeps fleeing (and, in the viewer, seeking a dropped pack)
    // rather than dropping into a stationary heal it can't perform.
    if (healReady && hasHealResource) return BOT_HEAL;
    return BOT_FLEE;
  }
  if (knifeRequested) return BOT_KNIFE;
  // Flee is a safety action, not a one-frame reaction. Once a retreat route is selected it
  // remains authoritative until that route finishes; a wall briefly hiding the threat may stop
  // aim/fire, but cannot replace the escape route with an investigation route.
  if (current === BOT_FLEE && fleeCommitted) return BOT_FLEE;
  // Cover is a committed defensive action (mirrors fleeCommitted): the anchor deliberately hides
  // the threat, so LOS loss must not break it -- only the caller's per-frame validity bit test
  // (threat flanked / dead / commit timeout, all folded into coverValid) or the heal/knife rungs
  // above can. Off-anchor HOLD drops back to MOVE so a pushed-away bot re-paths.
  if ((current === BOT_COVER_MOVE || current === BOT_COVER_HOLD) && coverCommitted && coverValid) {
    return atCoverAnchor ? BOT_COVER_HOLD : BOT_COVER_MOVE;
  }
  // H6a: knifed from outside the cone -- turn (caller aims at the bearing, which then clears the bit).
  if (closeSelfThreat) return BOT_AIM;
  // A9: one predicate, two rungs below -- below the flee rungs, above pursue/aim/fire.
  const reloadToCover = reloading && fireCapable && coverAvailable && !coverCommitted;
  if (targetVisible) {
    // A bot that can't fire must not camp the stationary AIM/FIRE rungs or take fresh cover; knife rung above handles armed melee.
    if (!fireCapable) return BOT_FLEE;
    // Clear a distance buffer before leaving retreat. This avoids aim/flee oscillation at
    // the exact range boundary, which otherwise discards and recreates the current path.
    if (current === BOT_FLEE && targetDistance < fleeDistance + Math.max(0, fleeExitBuffer)) {
      return BOT_FLEE;
    }
    if (targetDistance < fleeDistance) return BOT_FLEE;
    if (reloadToCover) return BOT_COVER_MOVE; // duck behind the corner for the mag change
    // Break-contact order: once self-preservation is clear (flee/heal/knife/cover-commit/close-threat
    // all sit above this), a manual squad/point command can pull the bot out of the firefight-reflex
    // tier -- pursue, fresh cover entry, aim/fire -- back to BOT_PATROL, where whatever movement
    // command is active (see bot-viewer-v2.html's updateCommandMovement) takes over. The bot stops
    // shooting while it disengages; this is a deliberate "pull back now" order, not a graceful kite.
    if (orderOverride) return BOT_PATROL;
    // Pursue is no longer the default at range -- a healthy bot fires on sight from any distance it
    // can see. It only breaks off to close the gap when it's above the health floor AND keeps
    // whiffing from here (get in range to actually land shots). Hysteresis mirrors the flee buffer:
    // hold PURSUE until buffer-closer than pursueDistance so a target at the boundary can't flip
    // PURSUE(move)<->AIM/FIRE(stop) every tick.
    if (pursueHealthOk && keepsMissing) {
      if (current === BOT_PURSUE && targetDistance > pursueDistance - Math.max(0, pursueExitBuffer)) return BOT_PURSUE;
      if (targetDistance > pursueDistance) return BOT_PURSUE;
    }
    // Engaged with a valid corner nearby: break for it instead of trading fire in the open.
    // Sits below the kite-flee/pursue rungs and above the stationary AIM/FIRE rungs.
    if (coverAvailable && !coverCommitted) return BOT_COVER_MOVE;
    if (aimError > AIM_TOLERANCE_RAD) return BOT_AIM;
    return readyToFire ? BOT_FIRE : BOT_AIM;
  }
  if (reloadToCover) return BOT_COVER_MOVE; // same rung with nobody in sight: reload behind cover, don't walk while dry
  // Same break-contact order, no target in sight: also skips the ally-hit cover reaction and the
  // lost-sight chase below, straight to BOT_PATROL/the active movement command.
  if (orderOverride) return BOT_PATROL;
  // Out of sight but an ally just took fire nearby: move on the reported threat's cover corner.
  if (coverAvailable && !coverCommitted && allyHitNearby && fireCapable) return BOT_COVER_MOVE;
  // Lost sight: chase last-known only while healthy AND able to fight there (ammo or knife); else hold/patrol.
  return (hasLastKnown && pursueHealthOk && (fireCapable || knifeCapable)) ? BOT_SEEK : BOT_PATROL;
}

export const TOP_OFF_MAG_FRAC = 0.35; // reload a partial mag during a lull rather than waiting for the click

// A9: harness signal (not a rung) -- top up a partial mag only while nothing can shoot back.
// Junk/absent magFrac is inert, so an unwired caller keeps the old mag=0-only reload start.
export function shouldTopOffReload({ magFrac, targetVisible = false, concealed = false } = {}) {
  if (typeof magFrac !== 'number' || !(magFrac < TOP_OFF_MAG_FRAC)) return false; // typeof guard: null would coerce to 0
  return !targetVisible || !!concealed;
}

// ---- ladder-input shapers (C8/C13): hysteresis on the two perception bits that own a path ----
// These exist because a raw per-frame bit flip on either one discards and rebuilds a route
// (SEEK frontier / flee flood-fill), so a target at a boundary costs frame time every other tick.

export const VISIBLE_LOSS_GRACE_MS = 250; // occlusion shorter than this must not drop the bot out of contact

// Debounces LOSS of sight only (mutates st = {lastTrueAt}); GAIN is instant, because a bot that
// sees you should react this frame. Returns true while rawVisible and for up to
// VISIBLE_LOSS_GRACE_MS after the last true frame (strictly less than: exactly-grace reads false).
// Feed the result to the state ladder and investigation teardown ONLY -- aiming and firing must
// keep using raw visibility, since you cannot shoot what is currently occluded.
export function stepVisibleDebounce(st, rawVisible, now) {
  if (rawVisible) { st.lastTrueAt = now; return true; }
  if (st.lastTrueAt == null) return false;
  if (now - st.lastTrueAt < VISIBLE_LOSS_GRACE_MS) return true;
  st.lastTrueAt = null;
  return false;
}

// Hard clear for discontinuities (target died, target identity changed): grace describes ONE
// opponent's occlusion and must never carry across a target switch.
export function resetVisibleDebounce(st) { if (st) st.lastTrueAt = null; }

export const HEAL_UNSAFE_EXIT_BUFFER = 1.5; // m to regain past safeDistance before a heal reads safe again

// Banded heal-safety verdict: unsafe ENTERS below safeDistance, clears only past
// safeDistance + buffer; inside the band the previous verdict holds. Mirrors the flee/pursue exit
// buffers above -- without it a target parked at safeDistance pumps HEAL<->FLEE, one flee
// flood-fill per cycle. Distance-only: compose with the (debounced) visibility bit at the caller.
export function healUnsafeBand(dist, wasUnsafe, safeDistance, buffer = HEAL_UNSAFE_EXIT_BUFFER) {
  if (dist < safeDistance) return true;
  if (!wasUnsafe) return false;
  return dist <= safeDistance + Math.max(0, buffer);
}

// ---- per-bot de-synchronization (H5/L6): seed-deterministic, never Math.random ----
// Squads share every input a lone bot has (same last-known point, same miss cadence) and the
// decision math is deterministic, so identical inputs produce identical plans -- N bots single-file
// through one doorway. These two shift the *inputs* per bot instead of randomizing the decision.

export const SEEK_SPREAD_RING_M = 1.5; // default offset radius applied to a shared search anchor
const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5)); // 2.39996: consecutive seeds land far apart
const SPREAD_RING_STEPS = 4; // radius saturates at sqrt(4) = 2x ringM, so an offset stays bounded

// Numeric per-bot seed from a string id, matching the harness's replanJitterMs convention ('bot-7' -> 7).
export function botSeedFromId(id) {
  return Math.abs(parseInt(String(id).replace(/\D/g, ''), 10) || 0);
}

// Offset distance for `seed`: 0 sits on the anchor, then a Vogel spiral fans outward and saturates
// at 2x ringM. Exported so a caller can widen a region gate by exactly this bot's displacement.
export function spreadAnchorRadius(seed, ringM = SEEK_SPREAD_RING_M) {
  const s = Math.floor(Math.abs(Number(seed) || 0));
  if (s === 0) return 0;
  return Math.max(0, ringM) * Math.sqrt(Math.min(s, SPREAD_RING_STEPS));
}

// Deterministic per-bot offset of a SHARED anchor (H5). Golden-angle bearing + saturating radius
// keeps any 8 consecutive seeds >= 1.5 m apart at ring 1.5 (>= 1.0 m for any 12). Writes {x,z} into
// `into` when given so hot loops allocate nothing; seed 0 returns the anchor unchanged.
export function spreadAnchor(anchorXZ, botSeed, ringM = SEEK_SPREAD_RING_M, into = null) {
  const out = into || { x: 0, z: 0 };
  out.x = anchorXZ.x; out.z = anchorXZ.z;
  const s = Math.floor(Math.abs(Number(botSeed) || 0));
  const radius = spreadAnchorRadius(s, ringM);
  if (!(radius > 0)) return out;
  const angle = s * GOLDEN_ANGLE_RAD;
  out.x += Math.cos(angle) * radius;
  out.z += Math.sin(angle) * radius;
  return out;
}

export const PURSUE_BREAK_JITTER = 3; // threshold spread: base + 0..PURSUE_BREAK_JITTER-1

// Integer hash (Knuth multiply + xorshift folds): consecutive bot ids must not fall into a pattern,
// which a bare seed % 3 would do for evenly-interleaved team rosters.
function hashSeed32(seed) {
  let x = Math.imul(seed | 0, 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return x >>> 0;
}

// L6: per-bot miss-streak threshold for the pursue break, so a squad whiffing on one target doesn't
// all charge on the same tick. Deterministic integer in [baseStreak, baseStreak + JITTER - 1].
export function pursueBreakThreshold(baseStreak, botSeed) {
  const base = Math.max(0, Math.floor(Number(baseStreak) || 0));
  const s = Math.floor(Math.abs(Number(botSeed) || 0));
  return base + hashSeed32(s) % PURSUE_BREAK_JITTER;
}

// Yaw (around Y, atan2(dx,dz) so 0 = +Z -- the convention bot.yaw is stored in everywhere in this
// module and in the movement/fire code that reads it) and pitch (around X, positive = looking
// up) from `from` toward `to`. bot-entity.js's toWirePose applies a +pi offset when converting
// this to the wire quaternion, since that convention is camera-relative (0 = -Z-forward).
export function aimAnglesTo(from, to, out) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const horiz = Math.hypot(dx, dz);
  if (!out) return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, horiz) };
  out.yaw = Math.atan2(dx, dz); out.pitch = Math.atan2(dy, horiz); // optional out-param: hot loops reuse one object
  return out;
}

export const STUCK_MIN_SPEED = 0.15; // m/s -- below this while patrol/seek counts as "not moving"

// `moving` = true while the bot's fsmState implies it should be making progress (patrol/seek);
// aim/fire/dead states are deliberately stationary and shouldn't read as stuck. Latches
// stuckSince on first below-speed tick so the caller can report how long it's been stuck.
export function trackStuck({ speed, moving, stuckSince = null, nowMs }) {
  if (!moving || speed >= STUCK_MIN_SPEED) return { stuckSince: null, stuckMs: 0 };
  const since = stuckSince ?? nowMs;
  return { stuckSince: since, stuckMs: nowMs - since };
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
