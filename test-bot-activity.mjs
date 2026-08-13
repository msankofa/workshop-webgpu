// Node tests for bot-activity.js (pure combat-bot FSM decision math, Phase 1: sentry).
// Run: node test-bot-activity.mjs
import {
  BOT_PATROL, BOT_SEEK, BOT_PURSUE, BOT_FLEE, BOT_HEAL, BOT_KNIFE, BOT_AIM, BOT_FIRE, BOT_COVER_MOVE, BOT_COVER_HOLD, SENSE_RANGE, AIM_TOLERANCE_RAD, TURN_RATE_RAD_S,
  chooseBotState, aimAnglesTo, aimError, slewAngle, trackStuck, STUCK_MIN_SPEED,
  stepVisibleDebounce, resetVisibleDebounce, VISIBLE_LOSS_GRACE_MS,
  healUnsafeBand, HEAL_UNSAFE_EXIT_BUFFER,
  spreadAnchor, spreadAnchorRadius, botSeedFromId, SEEK_SPREAD_RING_M,
  pursueBreakThreshold, PURSUE_BREAK_JITTER,
  CLOSE_THREAT_RADIUS, shouldTopOffReload, TOP_OFF_MAG_FRAC,
} from './bot-activity.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// states distinct
ok(new Set([BOT_PATROL, BOT_SEEK, BOT_PURSUE, BOT_FLEE, BOT_HEAL, BOT_KNIFE, BOT_AIM, BOT_FIRE, BOT_COVER_MOVE, BOT_COVER_HOLD]).size === 10, 'states distinct');

// no target, no last-known position -> patrol regardless of other ctx
{
  const { state } = chooseBotState({ ctx: { targetVisible: false, aimError: 0, readyToFire: true, hasLastKnown: false } });
  ok(state === BOT_PATROL, 'no visible target and no last-known position yields patrol');
}

// no target, but a remembered last-known position -> seek
{
  const { state } = chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true } });
  ok(state === BOT_SEEK, 'no visible target but a last-known position yields seek');
}

// visible target always wins over seek/patrol, even with a stale last-known position
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: AIM_TOLERANCE_RAD + 0.1, hasLastKnown: true, readyToFire: false } });
  ok(state === BOT_AIM, 'visible target takes priority over hasLastKnown (aim, not seek)');
}

// pursue is NOT the default at range: a distant visible target is fired on where it stands,
// unless the bot keeps missing (and is healthy enough to close the gap).
{
  const distant = { targetVisible: true, targetDistance: 9, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true };
  ok(chooseBotState({ ctx: { ...distant } }).state === BOT_FIRE, 'distant visible target is fired on, not pursued, when landing shots');
  ok(chooseBotState({ ctx: { ...distant, keepsMissing: true, pursueHealthOk: true } }).state === BOT_PURSUE, 'distant target + keeps missing + healthy yields pursue');
  ok(chooseBotState({ ctx: { ...distant, keepsMissing: true, pursueHealthOk: false } }).state === BOT_FIRE, 'keeps missing but too hurt to pursue -> keep firing in place');
}

// lost-target chase (seek) is also health-gated: a hurt bot that loses sight patrols instead
{
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true, pursueHealthOk: true } }).state === BOT_SEEK, 'lost target while healthy yields seek');
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true, pursueHealthOk: false } }).state === BOT_PATROL, 'lost target while hurt patrols instead of chasing');
}

// pursue<->aim hysteresis (only active once the miss-driven pursue is engaged): while pursuing, a
// target just inside pursueDistance stays PURSUE until it clears the exit buffer, so a target
// hovering at the boundary can't flip move<->stop.
{
  const base = { targetVisible: true, pursueDistance: 6, pursueExitBuffer: 0.6, fleeDistance: 2, aimError: 0, readyToFire: true, keepsMissing: true, pursueHealthOk: true };
  // fresh (not already pursuing): inside pursueDistance -> aim/fire immediately, no hold
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...base, targetDistance: 5.8 } }).state === BOT_FIRE, 'entry uses bare pursueDistance (no hysteresis on the way in)');
  // already pursuing, within buffer band (5.4..6): hold PURSUE
  ok(chooseBotState({ current: BOT_PURSUE, ctx: { ...base, targetDistance: 5.8 } }).state === BOT_PURSUE, 'pursuing target in buffer band holds pursue');
  // already pursuing, past the buffer (< pursueDistance - buffer): release to aim/fire
  ok(chooseBotState({ current: BOT_PURSUE, ctx: { ...base, targetDistance: 5.2 } }).state === BOT_FIRE, 'pursuing target past exit buffer releases to fire');
  // buffer defaults to 0 when unset: no behavior change for callers that never pass it
  ok(chooseBotState({ current: BOT_PURSUE, ctx: { targetVisible: true, targetDistance: 5.8, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true, keepsMissing: true, pursueHealthOk: true } }).state === BOT_FIRE, 'unset pursueExitBuffer defaults to 0 (no hold)');
}

// visible target inside personal space -> flee before attempting to aim/fire
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, targetDistance: 1, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true } });
  ok(state === BOT_FLEE, 'near visible target yields flee');
}


// Knife mode has priority over proximity flee, but only below the independent health-retreat chain.
{
  const knife = chooseBotState({ current: BOT_FLEE, ctx: { targetVisible: true, targetDistance: 1, fleeDistance: 2, knifeRequested: true } });
  ok(knife.state === BOT_KNIFE, 'eligible knife mode suppresses proximity flee');
  const healing = chooseBotState({ current: BOT_KNIFE, ctx: { targetVisible: true, targetDistance: 1, fleeDistance: 2, knifeRequested: true, healRequested: true } });
  ok(healing.state === BOT_FLEE, 'health retreat takes priority over knife mode');
  const ended = chooseBotState({ current: BOT_KNIFE, ctx: { targetVisible: true, targetDistance: 1, fleeDistance: 2, knifeRequested: false } });
  ok(ended.state === BOT_FLEE, 'losing knife eligibility restores normal proximity flee');
}

// A low-health request has priority over normal combat and commits its chosen flee route.
{
  const entering = chooseBotState({ current: BOT_AIM, ctx: { healRequested: true, targetVisible: true, readyToFire: true, aimError: 0 } });
  ok(entering.state === BOT_FLEE, 'low-health request enters flee before firing');
  const committed = chooseBotState({ current: BOT_FLEE, ctx: { healRequested: true, healFleeCommitted: true, targetVisible: false } });
  ok(committed.state === BOT_FLEE, 'health retreat keeps its committed route despite LOS loss');
  const ready = chooseBotState({ current: BOT_FLEE, ctx: { healRequested: true, healReady: true, targetVisible: false } });
  ok(ready.state === BOT_HEAL, 'safe completed health retreat enters heal');
}

// Healing is committed until either an explicit safety failure or completion clears the request.
{
  const holding = chooseBotState({ current: BOT_HEAL, ctx: { healRequested: true, targetVisible: true, readyToFire: true, aimError: 0 } });
  ok(holding.state === BOT_HEAL, 'visible enemy alone does not interrupt committed healing');
  const interrupted = chooseBotState({ current: BOT_HEAL, ctx: { healRequested: true, healUnsafe: true } });
  ok(interrupted.state === BOT_FLEE, 'unsafe healing returns to flee');
  const completed = chooseBotState({ current: BOT_HEAL, ctx: { healRequested: false, targetVisible: false, hasLastKnown: true } });
  ok(completed.state === BOT_SEEK, 'completed healing re-enters ordinary target-memory behavior');
}

// Safety dominates readiness: if a caller ever reports healReady AND healUnsafe at once, the FSM
// must deterministically prefer flee (never HEAL) so the two survival signals can't thrash HEAL<->FLEE.
{
  const fromHeal = chooseBotState({ current: BOT_HEAL, ctx: { healRequested: true, healReady: true, healUnsafe: true } });
  ok(fromHeal.state === BOT_FLEE, 'contradictory ready+unsafe leaves heal (safety wins)');
  const fromFlee = chooseBotState({ current: BOT_FLEE, ctx: { healRequested: true, healReady: true, healUnsafe: true, targetVisible: false } });
  ok(fromFlee.state === BOT_FLEE, 'contradictory ready+unsafe does not re-enter heal from flee');
}
// Healing requires a consumable pack: a wounded, safe, arrived bot with no pack stays fleeing,
// and a bot mid-heal that just emptied its last pack drops back to flee.
{
  const noPack = chooseBotState({ current: BOT_FLEE, ctx: { healRequested: true, healReady: true, targetVisible: false, hasHealResource: false } });
  ok(noPack.state === BOT_FLEE, 'safe+ready but packless bot cannot enter heal');
  const withPack = chooseBotState({ current: BOT_FLEE, ctx: { healRequested: true, healReady: true, targetVisible: false, hasHealResource: true } });
  ok(withPack.state === BOT_HEAL, 'safe+ready bot with a pack enters heal');
  const emptied = chooseBotState({ current: BOT_HEAL, ctx: { healRequested: true, targetVisible: false, hasHealResource: false } });
  ok(emptied.state === BOT_FLEE, 'a heal that just emptied its last pack falls back to flee');
  // hasHealResource defaults to true so existing callers/behaviour are unchanged.
  const legacy = chooseBotState({ current: BOT_FLEE, ctx: { healRequested: true, healReady: true, targetVisible: false } });
  ok(legacy.state === BOT_HEAL, 'hasHealResource defaults to true (no behaviour change for old callers)');
}

// Cover entry on engagement: a visible target plus an available corner breaks for cover instead
// of standing to trade fire, but sits below the kite-flee and miss-driven pursue rungs.
{
  const engaged = { targetVisible: true, targetDistance: 9, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true };
  ok(chooseBotState({ ctx: { ...engaged, coverAvailable: true } }).state === BOT_COVER_MOVE, 'engaged with a corner available enters cover-move instead of firing');
  ok(chooseBotState({ ctx: { ...engaged } }).state === BOT_FIRE, 'no corner available keeps the normal fire rung');
  ok(chooseBotState({ ctx: { ...engaged, targetDistance: 1, coverAvailable: true } }).state === BOT_FLEE, 'proximity kite-flee still outranks cover entry');
  ok(chooseBotState({ ctx: { ...engaged, keepsMissing: true, pursueHealthOk: true, coverAvailable: true } }).state === BOT_PURSUE, 'miss-driven pursue outranks cover entry');
}

// Cover entry on ally-hit: an out-of-sight bot moves on a nearby ally's attacker when a corner
// against that threat exists; without one it falls through to seek/patrol as before.
{
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: false, allyHitNearby: true, coverAvailable: true } }).state === BOT_COVER_MOVE, 'ally hit nearby with a corner available enters cover-move');
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: false, allyHitNearby: true } }).state === BOT_PATROL, 'ally hit without a usable corner falls through to patrol');
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true, pursueHealthOk: true, allyHitNearby: true, coverAvailable: true } }).state === BOT_COVER_MOVE, 'ally-hit cover outranks last-known seek');
}

// Committed cover persists (mirrors fleeCommitted): the anchor hides the threat, so LOS loss must
// not break it; MOVE promotes to HOLD at the anchor, and a pushed-off HOLD drops back to MOVE.
{
  const committed = { coverCommitted: true, coverValid: true, targetVisible: false };
  ok(chooseBotState({ current: BOT_COVER_MOVE, ctx: { ...committed } }).state === BOT_COVER_MOVE, 'committed cover-move holds without LOS');
  ok(chooseBotState({ current: BOT_COVER_MOVE, ctx: { ...committed, atCoverAnchor: true } }).state === BOT_COVER_HOLD, 'reaching the anchor promotes move to hold');
  ok(chooseBotState({ current: BOT_COVER_HOLD, ctx: { ...committed, atCoverAnchor: true } }).state === BOT_COVER_HOLD, 'holding at the anchor persists');
  ok(chooseBotState({ current: BOT_COVER_HOLD, ctx: { ...committed, atCoverAnchor: false } }).state === BOT_COVER_MOVE, 'pushed off the anchor drops hold back to move');
  const peeking = chooseBotState({ current: BOT_COVER_HOLD, ctx: { ...committed, atCoverAnchor: true, targetVisible: true, aimError: 0, readyToFire: true } });
  ok(peeking.state === BOT_COVER_HOLD, 'a visible target alone does not break a valid hold (peek gating is viewer-side)');
}

// Cover invalidation: the caller's per-frame bit test flipping coverValid off (flank, threat dead,
// or viewer-side commit timeout) drops straight through the ladder; a caller-side re-pick then
// re-enters via the normal entry rung.
{
  const invalid = { coverCommitted: true, coverValid: false, targetVisible: true, targetDistance: 9, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true };
  ok(chooseBotState({ current: BOT_COVER_HOLD, ctx: { ...invalid } }).state === BOT_FIRE, 'invalidated hold falls through to normal fire');
  ok(chooseBotState({ current: BOT_COVER_MOVE, ctx: { ...invalid, targetVisible: false, hasLastKnown: false } }).state === BOT_PATROL, 'invalidated cover with no threat left falls to patrol');
  // caller re-picked a fresh corner: commitment cleared, availability re-asserted -> re-enter
  ok(chooseBotState({ current: BOT_COVER_HOLD, ctx: { ...invalid, coverCommitted: false, coverAvailable: true } }).state === BOT_COVER_MOVE, 'a re-picked corner re-enters cover-move');
  // commit timeout honored: after the viewer times out it clears both flags, so a still-visible
  // target resumes plain aim/fire rather than re-holding the dead commitment
  ok(chooseBotState({ current: BOT_COVER_MOVE, ctx: { ...invalid, coverCommitted: false, coverAvailable: false } }).state === BOT_FIRE, 'timed-out commitment (flags cleared) resumes aim/fire');
}

// Heal and knife outrank cover, matching their rungs above the cover block.
{
  ok(chooseBotState({ current: BOT_COVER_HOLD, ctx: { coverCommitted: true, coverValid: true, atCoverAnchor: true, healRequested: true } }).state === BOT_FLEE, 'heal request breaks a committed hold into the retreat chain');
  ok(chooseBotState({ current: BOT_COVER_MOVE, ctx: { coverCommitted: true, coverValid: true, targetVisible: true, knifeRequested: true } }).state === BOT_KNIFE, 'knife eligibility outranks committed cover');
  ok(chooseBotState({ ctx: { targetVisible: true, healRequested: true, coverAvailable: true } }).state === BOT_FLEE, 'heal request suppresses cover entry');
}

// fireCapable/knifeCapable (2026-07-23 cover-limbo fix): a bot with a dry gun must never park in
// the stationary AIM/FIRE rungs or take fresh cover -- shot-driven exits need shots to exist.
{
  const dry = { targetVisible: true, targetDistance: 14, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: false, fireCapable: false };
  ok(chooseBotState({ ctx: dry }).state === BOT_FLEE, 'dry gun + visible enemy retreats instead of camping AIM');
  ok(chooseBotState({ ctx: { ...dry, knifeRequested: true } }).state === BOT_KNIFE, 'knife rung outranks the dry-gun retreat');
  ok(chooseBotState({ ctx: { ...dry, coverAvailable: true } }).state === BOT_FLEE, 'dry gun never enters cover');
  ok(chooseBotState({ ctx: { targetVisible: false, coverAvailable: true, allyHitNearby: true, fireCapable: false } }).state !== BOT_COVER_MOVE, 'dry gun ignores ally-hit cover entry');
  ok(chooseBotState({ current: BOT_COVER_HOLD, ctx: { coverCommitted: true, coverValid: true, atCoverAnchor: true, fireCapable: false } }).state === BOT_COVER_HOLD,
    'committed dry hold persists (viewer drought exit owns the break)');
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true, fireCapable: false, knifeCapable: false } }).state === BOT_PATROL, 'fully disarmed bot patrols, not chases');
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true, fireCapable: false, knifeCapable: true } }).state === BOT_SEEK, 'knife-armed dry bot still investigates');
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true } }).state === BOT_SEEK, 'fireCapable defaults true: legacy ctx unchanged');
}

// visible but not aimed -> aim
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: AIM_TOLERANCE_RAD + 0.1, readyToFire: true } });
  ok(state === BOT_AIM, 'large aim error yields aim state even when ready to fire');
}

// visible, aimed, but cooldown not ready -> aim (holds aim, doesn't fire early)
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: 0, readyToFire: false } });
  ok(state === BOT_AIM, 'aimed but not ready to fire holds aim state');
}

// visible, aimed, ready -> fire
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: 0, readyToFire: true } });
  ok(state === BOT_FIRE, 'aimed and ready to fire yields fire state');
}

// aim tolerance boundary: exactly at tolerance is not "aimed enough" (strict >)
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: AIM_TOLERANCE_RAD, readyToFire: true } });
  ok(state === BOT_FIRE, 'aim error exactly at tolerance counts as aimed');
}

// aimAnglesTo: straight ahead (+Z) is yaw 0, pitch 0
{
  const { yaw, pitch } = aimAnglesTo({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
  ok(Math.abs(yaw) < 1e-9, `yaw toward +Z is 0 (got ${yaw})`);
  ok(Math.abs(pitch) < 1e-9, `pitch toward level target is 0 (got ${pitch})`);
}
// aimAnglesTo: due +X is yaw +PI/2
{
  const { yaw } = aimAnglesTo({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
  ok(Math.abs(yaw - Math.PI / 2) < 1e-9, `yaw toward +X is PI/2 (got ${yaw})`);
}
// aimAnglesTo: target above is positive pitch
{
  const { pitch } = aimAnglesTo({ x: 0, y: 0, z: 0 }, { x: 0, y: 5, z: 5 });
  ok(pitch > 0, `pitch toward a target above is positive (got ${pitch})`);
}

// aimError: identical angles -> zero error
ok(aimError(0.4, 0.1, 0.4, 0.1) === 0, 'aimError is zero for identical yaw/pitch');
// aimError: wraps the short way around the circle (near +-PI boundary)
{
  const e = aimError(Math.PI - 0.05, 0, -Math.PI + 0.05, 0);
  ok(e < 0.2, `aimError takes the short way around the +-PI wrap (got ${e})`);
}

// slewAngle: step smaller than max reaches target exactly
{
  const a = slewAngle(0, 0.1, 0.5);
  ok(Math.abs(a - 0.1) < 1e-9, `slewAngle reaches target when within max delta (got ${a})`);
}
// slewAngle: step larger than max is capped, doesn't overshoot
{
  const a = slewAngle(0, 2, 0.2);
  ok(Math.abs(a - 0.2) < 1e-9, `slewAngle caps the step at maxDeltaRad (got ${a})`);
}
// slewAngle: takes the short way around the wrap
{
  const a = slewAngle(3.1, -3.1, 1); // shortest path crosses +-PI, not through 0
  ok(a > 3.1 || a < -3.1 + 1e-6, `slewAngle crosses the +-PI wrap the short way (got ${a})`);
}
// slewAngle: repeated stepping converges to target without overshoot oscillation
{
  let cur = 0;
  const target = 1.7;
  for (let i = 0; i < 200; i++) cur = slewAngle(cur, target, 0.05);
  ok(Math.abs(cur - target) < 1e-6, `repeated slewAngle steps converge to target (got ${cur})`);
}

// SENSE_RANGE is a sane positive metres value
ok(SENSE_RANGE > 0 && SENSE_RANGE < 200, 'SENSE_RANGE is a plausible in-map distance');
// TURN_RATE_RAD_S is positive and finite
ok(TURN_RATE_RAD_S > 0 && Number.isFinite(TURN_RATE_RAD_S), 'TURN_RATE_RAD_S is a positive finite rate');

// trackStuck: fast enough, or deliberately stationary (aim/fire) -> never stuck
{
  const a = trackStuck({ speed: 1, moving: true, stuckSince: null, nowMs: 1000 });
  ok(a.stuckSince === null && a.stuckMs === 0, 'above STUCK_MIN_SPEED clears stuck state');
  const b = trackStuck({ speed: 0, moving: false, stuckSince: null, nowMs: 1000 });
  ok(b.stuckSince === null, 'not moving by design (aim/fire) is never flagged stuck');
}
// trackStuck: below-speed while moving latches stuckSince on first tick, then accumulates
{
  const first = trackStuck({ speed: 0.02, moving: true, stuckSince: null, nowMs: 1000 });
  ok(first.stuckSince === 1000 && first.stuckMs === 0, 'first below-speed tick latches stuckSince to nowMs');
  const later = trackStuck({ speed: 0.02, moving: true, stuckSince: first.stuckSince, nowMs: 1800 });
  ok(later.stuckSince === 1000 && later.stuckMs === 800, 'stuckSince persists, stuckMs grows with elapsed time');
  const recovered = trackStuck({ speed: 1, moving: true, stuckSince: later.stuckSince, nowMs: 2000 });
  ok(recovered.stuckSince === null, 'moving fast again clears the latch');
}
ok(STUCK_MIN_SPEED > 0, 'STUCK_MIN_SPEED is a plausible positive threshold');

// stepVisibleDebounce (C8): a doorframe flicker must not drop the ladder out of contact, but
// regaining sight is instant. Timeline: see -> 1 frame occluded -> still visible -> grace expiry.
{
  const st = {};
  ok(stepVisibleDebounce(st, false, 0) === false, 'never-seen bot starts not visible');
  ok(stepVisibleDebounce(st, true, 100) === true, 'raw visible reports visible');
  ok(stepVisibleDebounce(st, false, 116) === true, 'one occluded frame stays visible (inside grace)');
  ok(stepVisibleDebounce(st, false, 200) === true, 'still visible partway through the grace window');
  ok(stepVisibleDebounce(st, true, 216) === true, 'regained sight inside the grace window');
  ok(st.lastTrueAt === 216, 'a true frame restamps the grace window');
  ok(stepVisibleDebounce(st, false, 216 + VISIBLE_LOSS_GRACE_MS - 1) === true, 'just under the grace window is still visible');
  ok(stepVisibleDebounce(st, false, 216 + VISIBLE_LOSS_GRACE_MS) === false, 'grace expiry (exactly at the window) drops visibility');
  ok(st.lastTrueAt === null, 'expiry clears the stamp so the next loss starts clean');
  ok(stepVisibleDebounce(st, false, 9999) === false, 'stays lost while occluded');
  ok(stepVisibleDebounce(st, true, 10000) === true, 'gain is instant, with no re-acquire delay');
}
// A grace window describes one opponent: death/target-switch clears it so no stale contact carries.
{
  const st = {};
  stepVisibleDebounce(st, true, 500);
  resetVisibleDebounce(st);
  ok(st.lastTrueAt === null, 'reset clears the stamp');
  ok(stepVisibleDebounce(st, false, 510) === false, 'reset drops visibility immediately, ignoring the grace');
  resetVisibleDebounce(undefined); // tolerate a not-yet-created state bag
}

// healUnsafeBand (C13): unsafe enters below safeDistance, exits only past safeDistance + buffer,
// so a target hovering at the boundary can't pump HEAL<->FLEE (one flee flood-fill per cycle).
{
  const SAFE = 8.5, B = HEAL_UNSAFE_EXIT_BUFFER;
  ok(healUnsafeBand(8.0, false, SAFE, B) === true, 'inside safeDistance enters unsafe');
  ok(healUnsafeBand(9.0, false, SAFE, B) === false, 'outside safeDistance while already safe stays safe');
  ok(healUnsafeBand(9.0, true, SAFE, B) === true, 'in the exit band while unsafe stays unsafe');
  ok(healUnsafeBand(SAFE + B + 0.01, true, SAFE, B) === false, 'past safeDistance + buffer clears unsafe');
  // boundaries: entry is strict (< safeDistance), exit is strict (> safeDistance + buffer)
  ok(healUnsafeBand(SAFE, false, SAFE, B) === false, 'exactly at safeDistance does not enter unsafe');
  ok(healUnsafeBand(SAFE, true, SAFE, B) === true, 'exactly at safeDistance holds an existing unsafe verdict');
  ok(healUnsafeBand(SAFE + B, true, SAFE, B) === true, 'exactly at the exit boundary is not yet safe');
  // no oscillation across the old bare threshold: a target parked at ~safeDistance keeps one verdict
  {
    let unsafe = false, flips = 0;
    for (const d of [8.4, 8.6, 8.4, 8.6, 8.55, 8.45]) {
      const next = healUnsafeBand(d, unsafe, SAFE, B);
      if (next !== unsafe) flips++;
      unsafe = next;
    }
    ok(flips === 1 && unsafe === true, `boundary hover flips once into unsafe and stays (flips ${flips})`);
  }
  ok(healUnsafeBand(Infinity, true, SAFE, B) === false, 'no target (infinite distance) is safe even when latched');
  ok(healUnsafeBand(9.5, true, SAFE) === true, 'buffer defaults to HEAL_UNSAFE_EXIT_BUFFER');
  ok(healUnsafeBand(9.0, true, SAFE, 0) === false, 'zero buffer reproduces the old bare-threshold behaviour');
  ok(HEAL_UNSAFE_EXIT_BUFFER > 0 && HEAL_UNSAFE_EXIT_BUFFER < 5, 'HEAL_UNSAFE_EXIT_BUFFER is a plausible metre buffer');
  ok(VISIBLE_LOSS_GRACE_MS > 0 && VISIBLE_LOSS_GRACE_MS < 2000, 'VISIBLE_LOSS_GRACE_MS is a plausible sub-second grace');
}

// spreadAnchor (H5): the same shared last-known point must resolve to a different search point per
// bot, deterministically -- ring 0 is what makes N seekers file through one doorway.
{
  const anchor = { x: 12, z: -4 };
  const a = spreadAnchor(anchor, 3, SEEK_SPREAD_RING_M);
  const b = spreadAnchor(anchor, 3, SEEK_SPREAD_RING_M);
  ok(a !== b && a.x === b.x && a.z === b.z, 'same seed yields the same offset (deterministic, fresh object)');
  ok(a.x !== anchor.x || a.z !== anchor.z, 'a nonzero seed actually moves off the shared anchor');
  ok(anchor.x === 12 && anchor.z === -4, 'the input anchor is never mutated');
  const zero = spreadAnchor(anchor, 0, SEEK_SPREAD_RING_M);
  ok(zero.x === anchor.x && zero.z === anchor.z, 'seed 0 keeps the shared anchor (one bot takes ring 0)');
  ok(spreadAnchorRadius(0) === 0, 'seed 0 has zero offset radius');
  ok(Math.abs(spreadAnchorRadius(1, 1.5) - 1.5) < 1e-9, 'seed 1 sits exactly on the ring');
  // radius saturates so a spread anchor can never wander outside the investigation region
  for (let s = 1; s < 40; s++) ok(spreadAnchorRadius(s, 1.5) <= 3 + 1e-9, `offset radius stays <= 2x ring (seed ${s})`);
  // ringM scales linearly, and a zero/negative ring degenerates to no spread at all
  ok(Math.abs(spreadAnchorRadius(2, 3) - 2 * spreadAnchorRadius(2, 1.5)) < 1e-9, 'offset radius scales with ringM');
  const flat = spreadAnchor(anchor, 5, 0);
  ok(flat.x === anchor.x && flat.z === anchor.z, 'ring 0 disables the spread (integrator kill switch)');
  // default ringM matches the exported tunable
  const dflt = spreadAnchor(anchor, 2);
  const explicit = spreadAnchor(anchor, 2, SEEK_SPREAD_RING_M);
  ok(dflt.x === explicit.x && dflt.z === explicit.z, 'ringM defaults to SEEK_SPREAD_RING_M');
  ok(SEEK_SPREAD_RING_M > 0 && SEEK_SPREAD_RING_M < 5, 'SEEK_SPREAD_RING_M is a plausible metre ring');
}
// Minimum separation: a squad handed one anchor must not stack. Checked over sliding seed windows
// because live bot ids are consecutive-ish but never start at 0 (bot-17..bot-24 must fan out too).
{
  const anchor = { x: 0, z: 0 };
  const worstOver = (count) => {
    let worst = Infinity;
    for (let off = 0; off <= 40; off++) {
      const pts = [];
      for (let k = 0; k < count; k++) pts.push(spreadAnchor(anchor, off + k, 1.5));
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          worst = Math.min(worst, Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z));
        }
      }
    }
    return worst;
  };
  const eight = worstOver(8);
  ok(eight >= 1.0, `any 8 consecutive seeds stay >= 1 m apart at ring 1.5 (got ${eight.toFixed(3)})`);
  const twelve = worstOver(12);
  ok(twelve >= 1.0, `even 12 consecutive seeds stay >= 1 m apart at ring 1.5 (got ${twelve.toFixed(3)})`);
}
// into-reuse: hot-loop callers pass a scratch object and must get it back, fully overwritten.
{
  const scratch = { x: 999, z: 999, tag: 'keepme' };
  const out = spreadAnchor({ x: 5, z: 5 }, 4, SEEK_SPREAD_RING_M, scratch);
  ok(out === scratch, 'into is returned, not a fresh object');
  ok(out.x !== 999 && out.z !== 999, 'into is fully overwritten (no stale coordinate leaks through)');
  ok(out.tag === 'keepme', 'unrelated fields on the scratch object are left alone');
  const fresh = spreadAnchor({ x: 5, z: 5 }, 4, SEEK_SPREAD_RING_M);
  ok(out.x === fresh.x && out.z === fresh.z, 'into-reuse and fresh-alloc paths agree');
  // reused across seeds: no accumulation from the previous call
  spreadAnchor({ x: 5, z: 5 }, 0, SEEK_SPREAD_RING_M, scratch);
  ok(scratch.x === 5 && scratch.z === 5, 'a reused scratch resets to the anchor for seed 0');
}
// Degenerate seeds must not produce NaN goals (ids can miss digits; sliders can hand over junk).
{
  const anchor = { x: 2, z: 3 };
  for (const bad of [undefined, null, NaN, -7, 2.7]) {
    const p = spreadAnchor(anchor, bad, SEEK_SPREAD_RING_M);
    ok(Number.isFinite(p.x) && Number.isFinite(p.z), `seed ${String(bad)} yields a finite point`);
  }
  ok(botSeedFromId('bot-7') === 7, 'botSeedFromId reads the digits out of a bot id');
  ok(botSeedFromId('bot-12') === 12, 'botSeedFromId handles multi-digit ids');
  ok(botSeedFromId('player') === 0, 'a digit-free id falls back to seed 0');
  ok(botSeedFromId(undefined) === 0, 'a missing id falls back to seed 0');
}

// pursueBreakThreshold (L6): squadmates whiffing on the same target on the same cadence must not
// all break into PURSUE on the same tick, so the streak threshold is jittered per bot.
{
  ok(pursueBreakThreshold(3, 5) === pursueBreakThreshold(3, 5), 'same base+seed is deterministic');
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const thresholds = seeds.map((s) => pursueBreakThreshold(3, s));
  for (const t of thresholds) {
    ok(Number.isInteger(t), `threshold is an integer (got ${t})`);
    ok(t >= 3 && t <= 3 + PURSUE_BREAK_JITTER - 1, `threshold stays in [base, base+${PURSUE_BREAK_JITTER - 1}] (got ${t})`);
  }
  ok(new Set(thresholds).size >= 2, `8 bots do not all share one threshold (${thresholds.join(',')})`);
  // the actual desync claim: with one shared miss cadence, bots break across >= 2 different streaks
  const breakAt = (streak) => thresholds.filter((t) => streak >= t).length;
  ok(breakAt(3) > 0 && breakAt(3) < seeds.length, 'at the base streak only some of the squad breaks off');
  ok(breakAt(3 + PURSUE_BREAK_JITTER - 1) === seeds.length, 'by the top of the jitter band the whole squad has broken');
  // base is honoured, including the degenerate/tuning-slider cases
  ok(pursueBreakThreshold(0, 4) >= 0 && pursueBreakThreshold(0, 4) < PURSUE_BREAK_JITTER, 'base 0 stays inside the jitter band');
  ok(pursueBreakThreshold(3.7, 4) === pursueBreakThreshold(3, 4), 'a fractional base (slider value) floors');
  ok(pursueBreakThreshold(-2, 4) >= 0, 'a negative base clamps to 0 rather than going negative');
  for (const bad of [undefined, null, NaN, -3]) {
    const t = pursueBreakThreshold(3, bad);
    ok(t >= 3 && t <= 3 + PURSUE_BREAK_JITTER - 1, `junk seed ${String(bad)} still yields an in-band threshold`);
  }
  ok(PURSUE_BREAK_JITTER >= 2 && PURSUE_BREAK_JITTER <= 5, 'PURSUE_BREAK_JITTER is a plausible small spread');
}

// ---- H6a: spin on a close self-threat from outside the FOV cone ----------------------------
// The audit's worst tunnel-vision case: a bot in AIM/FIRE can be knifed from behind and no cue
// reaches the ladder. The rung returns AIM (the caller aims at the self-threat bearing) and sits
// above every target-driven rung but below the survival commitments.
{
  const engaged = { targetVisible: true, targetDistance: 12, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true };
  // preempts the target-driven rungs, from whatever state the bot was committed to
  ok(chooseBotState({ current: BOT_FIRE, ctx: { ...engaged, closeSelfThreat: true } }).state === BOT_AIM, 'close self-threat preempts FIRE');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, closeSelfThreat: true } }).state === BOT_AIM, 'close self-threat holds AIM (facing switches caller-side)');
  ok(chooseBotState({ current: BOT_PURSUE, ctx: { ...engaged, keepsMissing: true, pursueHealthOk: true, closeSelfThreat: true } }).state === BOT_AIM, 'close self-threat preempts a miss-driven PURSUE');
  ok(chooseBotState({ current: BOT_SEEK, ctx: { targetVisible: false, hasLastKnown: true, closeSelfThreat: true } }).state === BOT_AIM, 'close self-threat preempts SEEK');
  ok(chooseBotState({ current: BOT_PATROL, ctx: { targetVisible: false, closeSelfThreat: true } }).state === BOT_AIM, 'close self-threat preempts PATROL');
  ok(chooseBotState({ current: BOT_PATROL, ctx: { targetVisible: false, allyHitNearby: true, coverAvailable: true, closeSelfThreat: true } }).state === BOT_AIM, 'close self-threat preempts the ally-hit cover entry');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, coverAvailable: true, closeSelfThreat: true } }).state === BOT_AIM, 'close self-threat preempts a fresh cover entry');
  // ...but never the commitments above it
  ok(chooseBotState({ current: BOT_HEAL, ctx: { healRequested: true, hasHealResource: true, closeSelfThreat: true } }).state === BOT_HEAL, 'a committed self-heal outranks the spin');
  ok(chooseBotState({ current: BOT_AIM, ctx: { healRequested: true, healReady: true, closeSelfThreat: true } }).state === BOT_HEAL, 'the health-retreat chain outranks the spin (safe+ready still heals)');
  ok(chooseBotState({ current: BOT_AIM, ctx: { healRequested: true, healReady: false, closeSelfThreat: true } }).state === BOT_FLEE, 'a not-yet-safe health retreat also outranks the spin');
  ok(chooseBotState({ current: BOT_KNIFE, ctx: { ...engaged, targetDistance: 1, knifeRequested: true, closeSelfThreat: true } }).state === BOT_KNIFE, 'getting knifed while knifing does not break our own melee');
  ok(chooseBotState({ current: BOT_FLEE, ctx: { targetVisible: false, fleeCommitted: true, closeSelfThreat: true } }).state === BOT_FLEE, 'a committed retreat route outranks the spin');
  ok(chooseBotState({ current: BOT_COVER_HOLD, ctx: { coverCommitted: true, coverValid: true, atCoverAnchor: true, closeSelfThreat: true } }).state === BOT_COVER_HOLD,
    'a committed cover route outranks the spin (its facing already prefers the self-threat)');
  ok(chooseBotState({ current: BOT_COVER_MOVE, ctx: { coverCommitted: true, coverValid: true, closeSelfThreat: true } }).state === BOT_COVER_MOVE, 'committed cover-move also survives the spin rung');
  // The rung is self-terminating: once the bot has turned, the bearing is inside the cone, the
  // harness stops setting the bit, and the ladder resumes normally. It is a turn, not a state lock.
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, closeSelfThreat: false } }).state === BOT_FIRE, 'the spin releases to normal combat once the threat is inside the cone');
  // A dry bot spins first, then flees on the next evaluation (never camps AIM with no ammo).
  const dryClose = { targetVisible: true, targetDistance: 12, fleeDistance: 2, aimError: 0, fireCapable: false };
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...dryClose, closeSelfThreat: true } }).state === BOT_AIM, 'a dry bot still turns to look at what is stabbing it');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...dryClose, closeSelfThreat: false } }).state === BOT_FLEE, 'once faced, the dry bot resumes its retreat (no AIM camping)');
  ok(CLOSE_THREAT_RADIUS > 0 && CLOSE_THREAT_RADIUS < 10, 'CLOSE_THREAT_RADIUS is a plausible knife-range metre radius');
}

// ---- break-contact order: a manual squad/point command pulling a bot out of a fight ---------
// bot-viewer-v2.html sets orderOverride while a "break contact" command is active on this bot (or
// its squad). It sits below every self-preservation rung but above the whole firefight-reflex
// tier (pursue / fresh cover entry / aim / fire / ally-hit cover-move / lost-sight chase), landing
// on BOT_PATROL so the active movement command (updateCommandMovement) takes over immediately.
{
  const engaged = { targetVisible: true, targetDistance: 9, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true };
  ok(chooseBotState({ current: BOT_FIRE, ctx: { ...engaged, orderOverride: true } }).state === BOT_PATROL, 'break-contact preempts FIRE');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, aimError: AIM_TOLERANCE_RAD + 0.1, orderOverride: true } }).state === BOT_PATROL, 'break-contact preempts AIM');
  ok(chooseBotState({ current: BOT_PURSUE, ctx: { ...engaged, keepsMissing: true, pursueHealthOk: true, orderOverride: true } }).state === BOT_PATROL, 'break-contact preempts a miss-driven PURSUE');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, coverAvailable: true, orderOverride: true } }).state === BOT_PATROL, 'break-contact preempts a fresh cover entry');
  ok(chooseBotState({ current: BOT_PATROL, ctx: { targetVisible: false, hasLastKnown: true, orderOverride: true } }).state === BOT_PATROL, 'break-contact preempts the lost-sight SEEK chase');
  ok(chooseBotState({ current: BOT_PATROL, ctx: { targetVisible: false, allyHitNearby: true, coverAvailable: true, fireCapable: true, orderOverride: true } }).state === BOT_PATROL, 'break-contact preempts the ally-hit cover-move reaction');
  // ...but never the commitments above it
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, targetDistance: 1, orderOverride: true } }).state === BOT_FLEE, 'proximity flee still outranks break-contact');
  ok(chooseBotState({ current: BOT_FLEE, ctx: { ...engaged, targetDistance: 2.4, fleeExitBuffer: 0.6, orderOverride: true } }).state === BOT_FLEE, 'the flee exit buffer still outranks break-contact');
  ok(chooseBotState({ current: BOT_FLEE, ctx: { targetVisible: false, fleeCommitted: true, orderOverride: true } }).state === BOT_FLEE, 'a committed retreat route outranks break-contact');
  ok(chooseBotState({ current: BOT_AIM, ctx: { healRequested: true, healReady: true, orderOverride: true } }).state === BOT_HEAL, 'the health-retreat chain outranks break-contact');
  ok(chooseBotState({ current: BOT_KNIFE, ctx: { ...engaged, targetDistance: 1, knifeRequested: true, orderOverride: true } }).state === BOT_KNIFE, 'an eligible knife rung outranks break-contact');
  ok(chooseBotState({ current: BOT_COVER_HOLD, ctx: { coverCommitted: true, coverValid: true, atCoverAnchor: true, orderOverride: true } }).state === BOT_COVER_HOLD, 'a committed cover route outranks break-contact');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, closeSelfThreat: true, orderOverride: true } }).state === BOT_AIM, 'the close-self-threat spin still outranks break-contact');
  // off: the whole rung is inert when the flag is unset, and no other rung reads it
  ok(chooseBotState({ current: BOT_FIRE, ctx: { ...engaged, orderOverride: false } }).state === BOT_FIRE, 'orderOverride:false changes nothing (normal combat)');
  ok(chooseBotState({ current: BOT_FIRE, ctx: { ...engaged } }).state === BOT_FIRE, 'orderOverride defaults to false for unwired callers');
}

// ---- A9: reload-aware cover rung -----------------------------------------------------------
// Reloading is ~1-2 s of being a stationary target. If a corner is going spare, take it.
{
  const engaged = { targetVisible: true, targetDistance: 12, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: false };
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, reloading: true, coverAvailable: true } }).state === BOT_COVER_MOVE, 'reloading with a corner available breaks for cover');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, reloading: true } }).state === BOT_AIM, 'reloading without a corner falls through to AIM, exactly as before');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, reloading: false, coverAvailable: true } }).state === BOT_COVER_MOVE, 'not reloading, the ordinary cover-entry rung produces the same move');
  // out of sight: this is the case the old ladder had no rung for at all (only ally-hit reports did)
  ok(chooseBotState({ current: BOT_SEEK, ctx: { targetVisible: false, hasLastKnown: true, reloading: true, coverAvailable: true } }).state === BOT_COVER_MOVE, 'a reloading seeker ducks to cover instead of walking dry');
  ok(chooseBotState({ current: BOT_SEEK, ctx: { targetVisible: false, hasLastKnown: true, reloading: true } }).state === BOT_SEEK, 'no corner: the reloading seeker keeps investigating');
  ok(chooseBotState({ current: BOT_PATROL, ctx: { targetVisible: false, reloading: true, coverAvailable: true } }).state === BOT_COVER_MOVE, 'a reloading patroller takes the corner too');
  // rung position: below the flee rungs, above pursue/aim/fire
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, targetDistance: 1, reloading: true, coverAvailable: true } }).state === BOT_FLEE, 'a knife-range enemy still outranks the reload rung');
  ok(chooseBotState({ current: BOT_FLEE, ctx: { ...engaged, targetDistance: 2.4, fleeExitBuffer: 0.6, reloading: true, coverAvailable: true } }).state === BOT_FLEE, 'the flee exit buffer still outranks the reload rung');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, keepsMissing: true, pursueHealthOk: true, reloading: true, coverAvailable: true } }).state === BOT_COVER_MOVE, 'the reload rung outranks pursue: never charge with an empty gun');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, keepsMissing: true, pursueHealthOk: true, reloading: true } }).state === BOT_PURSUE, 'without a corner the reloading bot still pursues (rung is cover-only)');
  // commitments and capability gates behave like the neighbouring cover rungs
  ok(chooseBotState({ current: BOT_COVER_HOLD, ctx: { coverCommitted: true, coverValid: true, atCoverAnchor: true, reloading: true, coverAvailable: true } }).state === BOT_COVER_HOLD, 'a bot already seated in cover reloads where it is (no re-pick)');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, reloading: true, coverAvailable: true, healRequested: true } }).state === BOT_FLEE, 'the health retreat outranks the reload rung');
  ok(chooseBotState({ current: BOT_AIM, ctx: { targetVisible: false, reloading: true, coverAvailable: true, fireCapable: false } }).state !== BOT_COVER_MOVE, 'a truly dry gun never enters cover to "reload"');
  ok(chooseBotState({ current: BOT_AIM, ctx: { ...engaged, reloading: true, coverAvailable: true, closeSelfThreat: true } }).state === BOT_AIM, 'a knife in the back outranks the reload rung');
}

// shouldTopOffReload (A9, harness signal not a rung): top up a partial mag only while nothing can
// shoot back -- no visible target, or concealed behind an anchor mid-peek-in.
{
  const T = TOP_OFF_MAG_FRAC;
  ok(shouldTopOffReload({ magFrac: 0.2, targetVisible: false, concealed: false }) === true, 'partial mag with no visible target tops off');
  ok(shouldTopOffReload({ magFrac: 0.2, targetVisible: true, concealed: true }) === true, 'partial mag while concealed from a visible target tops off');
  ok(shouldTopOffReload({ magFrac: 0.2, targetVisible: true, concealed: false }) === false, 'never top off while exposed to a visible target');
  ok(shouldTopOffReload({ magFrac: 0.9, targetVisible: false, concealed: false }) === false, 'a nearly full mag is not worth a reload animation');
  ok(shouldTopOffReload({ magFrac: T, targetVisible: false }) === false, 'exactly at the threshold does not top off (strict <)');
  ok(shouldTopOffReload({ magFrac: T - 0.01, targetVisible: false }) === true, 'just under the threshold tops off');
  ok(shouldTopOffReload({ magFrac: 0, targetVisible: false }) === true, 'an empty mag is trivially eligible (updateBotReload starts it anyway)');
  ok(shouldTopOffReload({ magFrac: 1, targetVisible: false }) === false, 'a full mag never tops off');
  // default-safe: an unwired or junk caller keeps the old mag=0-only reload start
  ok(shouldTopOffReload() === false, 'no argument at all is inert');
  ok(shouldTopOffReload({}) === false, 'a missing magFrac is inert');
  for (const bad of [undefined, null, NaN, 'half']) ok(shouldTopOffReload({ magFrac: bad, targetVisible: false }) === false, `junk magFrac ${String(bad)} is inert`);
  ok(TOP_OFF_MAG_FRAC > 0 && TOP_OFF_MAG_FRAC < 1, 'TOP_OFF_MAG_FRAC is a plausible magazine fraction');
}

// ---- back-compat: a wave-2-era ctx (none of wave 4's fields) must walk the identical ladder ----
// bot-viewer.html (v1) is deliberately not patched in this remediation and constructs ctx objects
// without closeSelfThreat/reloading; absent fields must default to inert, not merely "usually inert".
{
  const legacyCases = [
    ['patrol', BOT_PATROL, { targetVisible: false, aimError: 0, readyToFire: true, hasLastKnown: false }, BOT_PATROL],
    ['seek', BOT_PATROL, { targetVisible: false, hasLastKnown: true }, BOT_SEEK],
    ['aim', BOT_PATROL, { targetVisible: true, aimError: 1, readyToFire: false }, BOT_AIM],
    ['fire', BOT_AIM, { targetVisible: true, aimError: 0, readyToFire: true }, BOT_FIRE],
    ['pursue', BOT_AIM, { targetVisible: true, targetDistance: 9, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true, keepsMissing: true, pursueHealthOk: true }, BOT_PURSUE],
    ['pursue hysteresis', BOT_PURSUE, { targetVisible: true, targetDistance: 5.8, pursueDistance: 6, pursueExitBuffer: 0.6, fleeDistance: 2, aimError: 0, readyToFire: true, keepsMissing: true, pursueHealthOk: true }, BOT_PURSUE],
    ['kite flee', BOT_AIM, { targetVisible: true, targetDistance: 1, fleeDistance: 2, aimError: 0, readyToFire: true }, BOT_FLEE],
    ['flee commit', BOT_FLEE, { targetVisible: false, fleeCommitted: true }, BOT_FLEE],
    ['knife', BOT_FLEE, { targetVisible: true, targetDistance: 1, fleeDistance: 2, knifeRequested: true }, BOT_KNIFE],
    ['heal enter', BOT_AIM, { healRequested: true, targetVisible: true, readyToFire: true, aimError: 0 }, BOT_FLEE],
    ['heal hold', BOT_HEAL, { healRequested: true, targetVisible: true, readyToFire: true, aimError: 0 }, BOT_HEAL],
    ['heal unsafe', BOT_HEAL, { healRequested: true, healUnsafe: true }, BOT_FLEE],
    ['heal ready', BOT_FLEE, { healRequested: true, healReady: true, targetVisible: false }, BOT_HEAL],
    ['packless heal', BOT_FLEE, { healRequested: true, healReady: true, targetVisible: false, hasHealResource: false }, BOT_FLEE],
    ['cover entry', BOT_AIM, { targetVisible: true, targetDistance: 9, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true, coverAvailable: true }, BOT_COVER_MOVE],
    ['cover hold', BOT_COVER_MOVE, { coverCommitted: true, coverValid: true, atCoverAnchor: true, targetVisible: false }, BOT_COVER_HOLD],
    ['cover move off-anchor', BOT_COVER_HOLD, { coverCommitted: true, coverValid: true, atCoverAnchor: false, targetVisible: false }, BOT_COVER_MOVE],
    ['cover invalidated', BOT_COVER_HOLD, { coverCommitted: true, coverValid: false, targetVisible: true, targetDistance: 9, pursueDistance: 6, fleeDistance: 2, aimError: 0, readyToFire: true }, BOT_FIRE],
    ['ally-hit cover', BOT_PATROL, { targetVisible: false, allyHitNearby: true, coverAvailable: true }, BOT_COVER_MOVE],
    ['dry gun retreat', BOT_AIM, { targetVisible: true, targetDistance: 14, fleeDistance: 2, aimError: 0, readyToFire: false, fireCapable: false }, BOT_FLEE],
    ['disarmed patrol', BOT_PATROL, { targetVisible: false, hasLastKnown: true, fireCapable: false, knifeCapable: false }, BOT_PATROL],
  ];
  for (const [name, current, ctx, expected] of legacyCases) {
    ok(chooseBotState({ current, ctx }).state === expected, `wave-2 ctx unchanged: ${name} still yields ${expected}`);
    // explicitly-false new fields must be indistinguishable from absent ones
    const explicit = chooseBotState({ current, ctx: { ...ctx, closeSelfThreat: false, reloading: false, concealedFromTarget: false } }).state;
    ok(explicit === expected, `explicit-false wave-4 fields match absent ones: ${name}`);
  }
  // an empty ctx and an unknown-field ctx both stay on the bottom rung
  ok(chooseBotState({ ctx: {} }).state === BOT_PATROL, 'an empty ctx patrols');
  ok(chooseBotState({}).state === BOT_PATROL, 'a wholly missing ctx patrols');
  // concealedFromTarget is documented as inert in the ladder (it only feeds shouldTopOffReload)
  ok(chooseBotState({ current: BOT_AIM, ctx: { targetVisible: true, aimError: 0, readyToFire: true, concealedFromTarget: true } }).state === BOT_FIRE, 'concealedFromTarget never changes a ladder decision');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-activity: all assertions passed');
