// Node smoke tests for bot-stance.js (per-bot posture channel derived from the FSM state).
import assert from 'node:assert/strict';
import {
  STANCE_PRONE, STANCE_KNEEL, STANCE_CROUCH, STANCE_STAND, STANCE_RUN, STANCE_DASH, STANCE_DEFAULTS,
  chooseBotStance, stepStanceTransition, stanceSpeedFactor, stanceSpreadScale,
  stanceHeightScale, stanceTurnRateScale, resolveStanceOverride, stanceCapsuleHeightScale,
  stepStanceWeights, blendStanceHeightScale,
} from './bot-stance.js';

let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

// Kneel ships OFF, because a viewer that picks kneel without wiring the rig's kneel channel renders
// a kneeling bot standing. So the bare defaults are the pre-kneel baseline, and KNEEL_ON is opt-in --
// mirroring bot-viewer-v3.html, the only viewer that has wired it.
const KNEEL_ON = { ...STANCE_DEFAULTS, kneelEnabled: true };
const KNEEL_OFF = STANCE_DEFAULTS;
const PRONE_ON = { ...KNEEL_ON, proneEnabled: true };
const PRONE_ON_KNEEL_OFF = { ...STANCE_DEFAULTS, proneEnabled: true };
const KNEEL_OFF_PRONE_ON = PRONE_ON_KNEEL_OFF;
const HEIGHT_ON = { ...STANCE_DEFAULTS, heightEnabled: true };
const HEIGHT_OFF = { ...STANCE_DEFAULTS, heightEnabled: false };

// --- rung 1: master gate ---
const off = { ...STANCE_DEFAULTS, enabled: false, proneEnabled: true };
check(chooseBotStance('pursue', {}, off) === STANCE_STAND, 'disabled module reads stand for a run state');
check(chooseBotStance('heal', { forcedCrouch: true, holding: true }, off) === STANCE_STAND, 'disabled module outranks even forcedCrouch');

// --- rung 2: forcedCrouch ---
check(chooseBotStance('patrol', { forcedCrouch: true }) === STANCE_CROUCH, 'forcedCrouch crouches on patrol');
check(chooseBotStance('pursue', { forcedCrouch: true }) === STANCE_CROUCH, 'forcedCrouch beats a RUN state');
check(chooseBotStance('flee', { forcedCrouch: true, holding: true, holdElapsedMs: 9999 }, PRONE_ON) === STANCE_CROUCH,
  'forcedCrouch beats a prone-eligible hold');

// --- rung 3+4: heal and medic-tend, both role-blind and both always low ---
// The two split on POSTURE even though they share a rung's worth of precedence: a medic works on
// someone else at arm's length and wants a stable base, a bot patching itself wants to be able to run.
check(chooseBotStance('heal') === STANCE_CROUCH, 'a self-healing bot crouches');
check(chooseBotStance('heal', { alertHeld: true }) === STANCE_CROUCH, 'heal is decided before the alert rung');
check(chooseBotStance('medic-tend', {}, KNEEL_ON) === STANCE_KNEEL, 'a tending medic kneels');
check(chooseBotStance('medic-tend', {}, KNEEL_OFF) === STANCE_CROUCH, 'with kneel off the tend rung is the old crouch');
// No ctx field moves either rung any more. These pin that: the medic flags the viewer used to pass
// (medicTend / tendUnderFire / reviving) now decide the POSE only -- weapon out or holstered, press or
// compressions -- and must never buy back a standing tend. Unknown ctx keys are ignored by design.
for (const ctx of [{ medicTend: true }, { medicTend: true, tendUnderFire: true },
                   { medicTend: true, tendUnderFire: true, reviving: true },
                   { medicTend: true, reviving: true }]) {
  check(chooseBotStance('heal', ctx) === STANCE_CROUCH, `self-heal stays low for ${JSON.stringify(ctx)}`);
  check(chooseBotStance('medic-tend', ctx, KNEEL_ON) === STANCE_KNEEL, `tend stays low for ${JSON.stringify(ctx)}`);
}
check(chooseBotStance('medic-tend', { forcedCrouch: true }) === STANCE_CROUCH, 'forcedCrouch still outranks the tending medic');
check(chooseBotStance('medic-tend', { evading: true }) === STANCE_DASH, 'a live blast still outranks the tending medic');

// --- rung 5: commanded hold ---
// Kneel is the rung a held bot actually reaches: prone is opt-in AND needs proneMinHoldMs of
// sustained hold, so before kneel existed an overwatching bot just crouched indefinitely.
check(chooseBotStance('aim', { holding: true, holdElapsedMs: 9999 }, KNEEL_ON) === STANCE_KNEEL, 'a hold kneels while prone is disabled');
check(chooseBotStance('aim', { holding: true, holdElapsedMs: 9999 }, KNEEL_OFF) === STANCE_CROUCH,
  'with kneel off too, a hold is the old crouch');
check(chooseBotStance('aim', { holding: true, holdElapsedMs: 9999 }, PRONE_ON) === STANCE_PRONE, 'a long hold goes prone when prone is enabled');
check(chooseBotStance('aim', { holding: true, holdElapsedMs: STANCE_DEFAULTS.proneMinHoldMs }, PRONE_ON) === STANCE_PRONE,
  'exactly proneMinHoldMs is enough to justify prone');
check(chooseBotStance('aim', { holding: true, holdElapsedMs: STANCE_DEFAULTS.proneMinHoldMs - 1 }, PRONE_ON) === STANCE_KNEEL,
  'a hold that has not lasted long enough yet kneels on the way to prone');
check(chooseBotStance('aim', { holding: true, holdElapsedMs: STANCE_DEFAULTS.proneMinHoldMs - 1 }, KNEEL_OFF_PRONE_ON) === STANCE_CROUCH,
  '...and crouches instead when kneel is off');
// Regression: the gate used to read REMAINING lease time. Both issuers re-grant a 500 ms lease every
// frame, so remaining is pinned near 500 and prone was unreachable at any proneMinHoldMs above it.
check(chooseBotStance('aim', { holding: true, holdElapsedMs: 500 }, PRONE_ON) === STANCE_KNEEL,
  'a 500 ms lease window alone does not justify prone');
check(chooseBotStance('aim', { holding: true, holdElapsedMs: 4000 }, PRONE_ON) === STANCE_PRONE,
  'a hold sustained across many lease renewals does go prone');
check(chooseBotStance('aim', { holding: true }, PRONE_ON) === STANCE_KNEEL, 'a hold with no elapsed time reported only kneels');
check(chooseBotStance('cover-hold', { holding: true, peekExposed: true }, KNEEL_ON) === STANCE_KNEEL, 'holding beats cover-hold');
check(chooseBotStance('pursue', { holding: true }, KNEEL_ON) === STANCE_KNEEL, 'holding beats a RUN state');
check(chooseBotStance('pursue', { holding: true }, KNEEL_OFF) === STANCE_CROUCH, '...and is the old crouch with kneel off');

// --- proneEnabled: false is absolute ---
{
  const states = ['patrol', 'seek', 'pursue', 'flee', 'heal', 'knife', 'aim', 'fire',
    'cover-move', 'cover-hold', 'medic-move', 'medic-tend', 'alert', 'nonsense'];
  let anyProne = false;
  for (const st of states) {
    for (const holding of [false, true]) {
      for (const forcedCrouch of [false, true]) {
        const got = chooseBotStance(st, { holding, forcedCrouch, holdElapsedMs: 1e6, targetVisible: true, targetDistance: 99, distanceToLastKnown: 0 });
        if (got === STANCE_PRONE) anyProne = true;
      }
    }
  }
  check(!anyProne, 'proneEnabled:false never yields prone from any state/ctx combination');
}

// --- kneelEnabled: false is absolute, and the bare defaults ARE kneel-off ---
// This is the property bot-viewer-v2 and environment-viewer-v2 depend on: neither wires the rig's
// kneel channel, so a single leaked KNEEL would render one of their bots standing while the stance
// system believes it is kneeling. Swept over the whole ctx surface, not just the three kneel rungs.
{
  const states = ['patrol', 'seek', 'pursue', 'flee', 'heal', 'knife', 'aim', 'fire',
    'cover-move', 'cover-hold', 'medic-move', 'medic-tend', 'alert', 'nonsense'];
  let anyKneel = 0;
  for (const st of states) {
    for (const holding of [false, true]) {
      for (const forcedCrouch of [false, true]) {
        for (const dist of [0, 5, 12, 40, 1e6]) {
          for (const settings of [undefined, STANCE_DEFAULTS, PRONE_ON_KNEEL_OFF]) {
            const got = chooseBotStance(st, {
              holding, forcedCrouch, holdElapsedMs: 1e6, targetVisible: true, targetDistance: dist,
              distanceToLastKnown: dist, alreadyKneeling: true, alreadyCrouched: true,
            }, settings);
            if (got === STANCE_KNEEL) anyKneel++;
          }
        }
      }
    }
  }
  check(anyKneel === 0, 'the shipped defaults never yield kneel from any state/ctx combination');
  // ...and the same sweep with kneel ON must actually reach it, or the sweep proves nothing.
  check(chooseBotStance('medic-tend', {}, KNEEL_ON) === STANCE_KNEEL, 'the same sweep with kneel on does reach kneel');
}

// --- rung 6: cover-hold peek phases ---
check(chooseBotStance('cover-hold', { peekPhase: 'in' }) === STANCE_CROUCH, 'tucked behind cover = crouch');
check(chooseBotStance('cover-hold', { peekExposed: true }) === STANCE_STAND, 'fully exposed on the peek = stand');
check(chooseBotStance('cover-hold', { peekPhase: 'in', peekExposed: true }) === STANCE_CROUCH, 'the tucked phase wins over a stale exposed bit');
check(chooseBotStance('cover-hold', { peekPhase: 'out' }) === STANCE_CROUCH, 'mid-slide out of cover still crouches');
check(chooseBotStance('cover-hold') === STANCE_CROUCH, 'cover-hold with no peek info crouches');

// --- rung 7: alert ---
check(chooseBotStance('alert') === STANCE_CROUCH, 'the alert state crouches');
check(chooseBotStance('patrol', { alertHeld: true }) === STANCE_CROUCH, 'alertHeld crouches from any lower rung');
check(chooseBotStance('pursue', { alertHeld: true }) === STANCE_CROUCH, 'alertHeld outranks the run states');
check(chooseBotStance('alert', { holding: true, holdElapsedMs: 5000 }, PRONE_ON) === STANCE_PRONE, 'a commanded hold outranks the alert rung');

// --- rung 8: run states ---
for (const st of ['pursue', 'flee', 'cover-move', 'medic-move', 'knife']) {
  check(chooseBotStance(st) === STANCE_RUN, `${st} runs`);
}

// --- rung 8b: double time (a manual point command run out of combat, see bot-viewer-v2's
// updateCommandMovement) only ever applies while the resolved state is 'patrol' ---
check(chooseBotStance('patrol', { doubleTime: true }) === STANCE_RUN, 'double time runs a patrolling bot');
check(chooseBotStance('patrol') === STANCE_STAND, 'no doubleTime flag, patrol still just walks');
check(chooseBotStance('seek', { doubleTime: true }) === STANCE_STAND, 'doubleTime is inert outside patrol (seek keeps its own table)');
check(chooseBotStance('aim', { doubleTime: true, targetVisible: true, targetDistance: 99 }, KNEEL_ON) === STANCE_KNEEL,
  'doubleTime never overrides the aim/fire posture table');
check(chooseBotStance('patrol', { doubleTime: true, forcedCrouch: true }) === STANCE_CROUCH, 'forcedCrouch still outranks double time');
check(chooseBotStance('patrol', { doubleTime: true, holding: true }, KNEEL_ON) === STANCE_KNEEL, 'a hold still outranks double time');

// --- rung 9: aim / fire ---
const farShot = { targetVisible: true, targetDistance: STANCE_DEFAULTS.aimCrouchDistance + 2 };
const nearShot = { targetVisible: true, targetDistance: 2 };
check(chooseBotStance('aim', farShot) === STANCE_CROUCH, 'a long shot is steadied from a crouch');
check(chooseBotStance('fire', farShot) === STANCE_CROUCH, 'firing at range crouches too');
check(chooseBotStance('aim', nearShot) === STANCE_STAND, 'a close target is engaged standing');
check(chooseBotStance('aim', { targetVisible: true, targetDistance: STANCE_DEFAULTS.aimCrouchDistance }) === STANCE_CROUCH,
  'exactly aimCrouchDistance crouches');
check(chooseBotStance('aim', { targetVisible: false, targetDistance: 99 }) === STANCE_STAND, 'no visible target = no crouch');
check(chooseBotStance('aim') === STANCE_STAND, 'aim with an empty ctx stands');

// --- rung 9a: kneel and crouch COEXIST on the aim rung, split by a second, longer threshold ---
{
  const D = STANCE_DEFAULTS;
  check(D.aimKneelDistance > D.aimCrouchDistance, 'the kneel band starts beyond the crouch band, or one shadows the other');
  const at = (m, extra = {}) => chooseBotStance('aim', { targetVisible: true, targetDistance: m, ...extra }, KNEEL_ON);
  check(at(2) === STANCE_STAND, 'close in: stand');
  check(at(D.aimCrouchDistance + 1) === STANCE_CROUCH, 'mid range: crouch, unchanged from before kneel existed');
  check(at(D.aimKneelDistance) === STANCE_KNEEL, 'exactly aimKneelDistance kneels');
  check(at(D.aimKneelDistance + 20) === STANCE_KNEEL, 'a very long shot kneels');
  check(at(D.aimKneelDistance - 0.01) === STANCE_CROUCH, 'one cm short of the kneel band is still a crouch');
  check(chooseBotStance('fire', { targetVisible: true, targetDistance: D.aimKneelDistance + 5 }, KNEEL_ON) === STANCE_KNEEL,
    'firing at long range kneels too, not just aiming');
  check(at(99, { targetVisible: false }) === STANCE_STAND, 'no visible target never kneels, however large the stale range');
  // The whole band collapses back to the pre-kneel table when the toggle is off.
  const off = (m) => chooseBotStance('aim', { targetVisible: true, targetDistance: m }, KNEEL_OFF);
  check(off(D.aimKneelDistance + 20) === STANCE_CROUCH, 'kneel off: a long shot is the old crouch');
  check(off(2) === STANCE_STAND, 'kneel off: close in is still stand');
  // Kneel hysteresis is its own dead band, wider than the crouch one because standing up costs more.
  check(D.aimKneelHysteresisM > D.aimCrouchHysteresisM, 'the kneel dead band is wider than the crouch one');
  const inBand = D.aimKneelDistance - D.aimKneelHysteresisM + 0.01;
  const pastBand = D.aimKneelDistance - D.aimKneelHysteresisM - 0.01;
  check(at(inBand) === STANCE_CROUCH, 'not yet kneeling: the bare kneel threshold applies');
  check(at(inBand, { alreadyKneeling: true }) === STANCE_KNEEL, 'already kneeling: inside the dead band stays kneeling');
  check(at(pastBand, { alreadyKneeling: true }) === STANCE_CROUCH, 'already kneeling: clearing the band drops to a crouch');
  check(at(D.aimKneelDistance, { alreadyKneeling: true }) === STANCE_KNEEL, 'already kneeling: at the bare threshold stays kneeling');
  check(chooseBotStance('aim', { targetVisible: true, targetDistance: inBand, alreadyKneeling: true },
    { ...KNEEL_ON, aimKneelHysteresisM: NaN }) === STANCE_CROUCH,
    'a junk kneel hysteresis margin degrades to the bare threshold, not a wider or negative band');
  // A bot dropping out of the kneel band lands in the crouch band, never skips straight to standing.
  check(at(pastBand, { alreadyKneeling: true }) !== STANCE_STAND, 'leaving a long-range kneel does not jump to standing');
}

// --- rung 9b: aim/fire hysteresis (dead-band against boundary chatter) ---
{
  const justPastTrigger = { targetVisible: true, targetDistance: STANCE_DEFAULTS.aimCrouchDistance + 0.01 };
  const justInsideTrigger = { targetVisible: true, targetDistance: STANCE_DEFAULTS.aimCrouchDistance - 0.01 };
  const wellInsideBand = { targetVisible: true, targetDistance: STANCE_DEFAULTS.aimCrouchDistance - STANCE_DEFAULTS.aimCrouchHysteresisM + 0.01 };
  const pastBand = { targetVisible: true, targetDistance: STANCE_DEFAULTS.aimCrouchDistance - STANCE_DEFAULTS.aimCrouchHysteresisM - 0.01 };
  check(chooseBotStance('aim', justInsideTrigger) === STANCE_STAND, 'not yet crouched: bare threshold still applies (no alreadyCrouched)');
  check(chooseBotStance('aim', { ...justPastTrigger, alreadyCrouched: false }) === STANCE_CROUCH, 'not yet crouched: bare threshold triggers crouch');
  check(chooseBotStance('aim', { ...wellInsideBand, alreadyCrouched: true }) === STANCE_CROUCH,
    'already crouched: inside the bare threshold but still within the hysteresis band stays crouched');
  check(chooseBotStance('aim', { ...pastBand, alreadyCrouched: true }) === STANCE_STAND,
    'already crouched: only clearing the full hysteresis band stands back up');
  check(chooseBotStance('aim', { targetVisible: true, targetDistance: STANCE_DEFAULTS.aimCrouchDistance, alreadyCrouched: true }) === STANCE_CROUCH,
    'already crouched: exactly at the bare threshold stays crouched (band not yet cleared)');
}

// --- rung 10: seek ---
check(chooseBotStance('seek', { distanceToLastKnown: 1 }) === STANCE_CROUCH, 'searching near the last-known point crouches');
check(chooseBotStance('seek', { distanceToLastKnown: STANCE_DEFAULTS.seekCrouchRadius }) === STANCE_CROUCH, 'exactly seekCrouchRadius crouches');
check(chooseBotStance('seek', { distanceToLastKnown: STANCE_DEFAULTS.seekCrouchRadius + 0.1 }) === STANCE_STAND, 'still far from the point, stay upright');
check(chooseBotStance('seek') === STANCE_STAND, 'seek with no distance reported stands');

// --- rung 10b: seek hysteresis (dead-band against boundary chatter) ---
{
  const justPastRadius = STANCE_DEFAULTS.seekCrouchRadius + 0.1;
  const wellInsideBand = STANCE_DEFAULTS.seekCrouchRadius + STANCE_DEFAULTS.seekCrouchHysteresisM - 0.01;
  const pastBand = STANCE_DEFAULTS.seekCrouchRadius + STANCE_DEFAULTS.seekCrouchHysteresisM + 0.01;
  check(chooseBotStance('seek', { distanceToLastKnown: justPastRadius }) === STANCE_STAND, 'not yet crouched: bare radius still applies (no alreadyCrouched)');
  check(chooseBotStance('seek', { distanceToLastKnown: justPastRadius, alreadyCrouched: true }) === STANCE_CROUCH,
    'already crouched: just past the bare radius but still within the hysteresis band stays crouched');
  check(chooseBotStance('seek', { distanceToLastKnown: wellInsideBand, alreadyCrouched: true }) === STANCE_CROUCH,
    'already crouched: inside the hysteresis band stays crouched');
  check(chooseBotStance('seek', { distanceToLastKnown: pastBand, alreadyCrouched: true }) === STANCE_STAND,
    'already crouched: only clearing the full hysteresis band stands back up');
}
// junk hysteresis margin must not invert the band (NaN -> num() -> 0, band collapses to the bare threshold, never negative)
check(chooseBotStance('seek', { distanceToLastKnown: STANCE_DEFAULTS.seekCrouchRadius + 0.1, alreadyCrouched: true },
  { ...STANCE_DEFAULTS, seekCrouchHysteresisM: NaN }) === STANCE_STAND, 'a junk hysteresis margin degrades to the bare threshold, not a wider or negative band');
check(chooseBotStance('aim', { targetVisible: true, targetDistance: STANCE_DEFAULTS.aimCrouchDistance - 0.1, alreadyCrouched: true },
  { ...STANCE_DEFAULTS, aimCrouchHysteresisM: NaN }) === STANCE_STAND, 'a junk aim hysteresis margin degrades to the bare threshold too');

// --- rung 11: patrol / unknown / junk ---
check(chooseBotStance('patrol') === STANCE_STAND, 'patrol stands');
check(chooseBotStance('who-knows') === STANCE_STAND, 'an unrecognised state stands');
check(chooseBotStance(undefined) === STANCE_STAND, 'a missing state stands');
check(chooseBotStance('seek', null) === STANCE_STAND, 'a null ctx is safe');
check(chooseBotStance('aim', { targetVisible: true, targetDistance: NaN }) === STANCE_STAND, 'a NaN range does not fake a long shot');
check(chooseBotStance('seek', { distanceToLastKnown: NaN }) === STANCE_STAND, 'a NaN search range does not fake proximity');
// null is the trap: Number(null) is a finite 0, which would read as "standing on the last-known point".
check(chooseBotStance('seek', { distanceToLastKnown: null }) === STANCE_STAND, 'a null search range does not fake proximity');
check(chooseBotStance('seek', { distanceToLastKnown: undefined }) === STANCE_STAND, 'an absent search range does not fake proximity');
check(chooseBotStance('aim', { holding: true, holdElapsedMs: 'junk' }, PRONE_ON) === STANCE_KNEEL, 'a junk hold duration cannot buy prone');

// --- stepStanceTransition ---
{
  const st = {};
  check(stepStanceTransition(st, STANCE_CROUCH, 0) === STANCE_CROUCH, 'a fresh st adopts the desired stance immediately');
  check(st.stance === STANCE_CROUCH && st.changedAt === 0, 'the latch writes stance and changedAt');
}
check(stepStanceTransition(null, STANCE_PRONE, 0) === STANCE_PRONE, 'a null st is safe and just echoes the desire');
check(stepStanceTransition(null, 'garbage', 0) === STANCE_STAND, 'a null st normalises an unrecognised desire');
{
  // Going lower costs nothing.
  const st = { stance: STANCE_STAND, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(st, STANCE_CROUCH, 100) === STANCE_CROUCH, 'stand -> crouch is instant');
  check(stepStanceTransition(st, STANCE_PRONE, 200) === STANCE_PRONE, 'crouch -> prone is instant');
}
{
  // Leaving prone costs standUpMs exactly.
  const st = { stance: STANCE_PRONE, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(st, STANCE_STAND, 0) === STANCE_PRONE, 'the stand-up starts but the bot is still prone');
  check(stepStanceTransition(st, STANCE_STAND, STANCE_DEFAULTS.standUpMs - 1) === STANCE_PRONE, 'still prone one ms before the cost is paid');
  check(stepStanceTransition(st, STANCE_STAND, STANCE_DEFAULTS.standUpMs) === STANCE_STAND, 'exactly at standUpMs the bot is up');
  check(st.blockedUntil === 0 && st.changedAt === STANCE_DEFAULTS.standUpMs, 'the latch clears once the transition commits');
}
{
  // Leaving crouch is cheaper than leaving prone.
  const st = { stance: STANCE_CROUCH, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(st, STANCE_RUN, 0) === STANCE_CROUCH, 'crouch -> run pays a cost too');
  check(stepStanceTransition(st, STANCE_RUN, STANCE_DEFAULTS.crouchUpMs - 1) === STANCE_CROUCH, 'still crouched inside the window');
  check(stepStanceTransition(st, STANCE_RUN, STANCE_DEFAULTS.crouchUpMs) === STANCE_RUN, 'released after crouchUpMs');
  check(STANCE_DEFAULTS.crouchUpMs < STANCE_DEFAULTS.standUpMs, 'getting off the deck costs more than getting off a knee');
}
{
  // Kneel sits between crouch and prone on the exit-cost ladder, and the ladder is what makes each
  // stance a real commitment rather than a free cosmetic swap.
  check(STANCE_DEFAULTS.crouchUpMs < STANCE_DEFAULTS.kneelUpMs, 'rising from a knee costs more than from a crouch');
  check(STANCE_DEFAULTS.kneelUpMs < STANCE_DEFAULTS.standUpMs, '...and less than getting off the deck');
  const st = { stance: STANCE_KNEEL, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(st, STANCE_RUN, 0) === STANCE_KNEEL, 'kneel -> run pays kneelUpMs');
  check(stepStanceTransition(st, STANCE_RUN, STANCE_DEFAULTS.kneelUpMs - 1) === STANCE_KNEEL, 'still kneeling inside the window');
  check(stepStanceTransition(st, STANCE_RUN, STANCE_DEFAULTS.kneelUpMs) === STANCE_RUN, 'released after kneelUpMs');
}
{
  // Going LOWER is free at every step of stand -> crouch -> kneel -> prone, in any combination.
  const order = [STANCE_STAND, STANCE_CROUCH, STANCE_KNEEL, STANCE_PRONE];
  let t = 0, allFree = true;
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const st = { stance: order[i], changedAt: 0, blockedUntil: 0 };
      if (stepStanceTransition(st, order[j], t += 10, PRONE_ON) !== order[j]) allFree = false;
    }
  }
  check(allFree, 'dropping to any lower stance is instant, from any higher one');
  // ...and rising out of kneel is charged whatever it rises to.
  let allCharged = true;
  for (const want of [STANCE_CROUCH, STANCE_STAND, STANCE_RUN]) {
    const st = { stance: STANCE_KNEEL, changedAt: 0, blockedUntil: 0 };
    if (stepStanceTransition(st, want, 0) !== STANCE_KNEEL) allCharged = false;
  }
  check(allCharged, 'rising out of a kneel is charged whatever it rises to');
  const dash = { stance: STANCE_KNEEL, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(dash, STANCE_DASH, 0) === STANCE_DASH, '...except a blast evade, which is always free');
}
{
  // A prone bot that changes its mind mid-stand-up cancels the clock.
  const st = { stance: STANCE_PRONE, changedAt: 0, blockedUntil: 0 };
  stepStanceTransition(st, STANCE_STAND, 0);
  check(st.blockedUntil > 0, 'the stand-up clock is armed');
  check(stepStanceTransition(st, STANCE_PRONE, 100) === STANCE_PRONE, 're-choosing prone keeps it prone');
  check(st.blockedUntil === 0, 're-choosing the current stance cancels the pending exit');
}
{
  // Prone -> crouch is still an exit from prone, so it pays standUpMs.
  const st = { stance: STANCE_PRONE, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(st, STANCE_CROUCH, 10) === STANCE_PRONE, 'prone -> crouch is not free either');
  check(stepStanceTransition(st, STANCE_CROUCH, 10 + STANCE_DEFAULTS.standUpMs) === STANCE_CROUCH, 'prone -> crouch completes after standUpMs');
}
{
  // Stand <-> run has no posture cost.
  const st = { stance: STANCE_STAND, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(st, STANCE_RUN, 5) === STANCE_RUN, 'stand -> run is instant');
  check(stepStanceTransition(st, STANCE_STAND, 6) === STANCE_STAND, 'run -> stand is instant');
}
{
  // Called every frame with a stable desire, the latch must settle, not oscillate.
  const st = {};
  let last = null;
  for (let t = 0; t <= 2000; t += 16) last = stepStanceTransition(st, STANCE_PRONE, t, PRONE_ON);
  check(last === STANCE_PRONE, 'a stable desire holds across a long frame loop');
  for (let t = 2000; t <= 2000 + STANCE_DEFAULTS.standUpMs + 32; t += 16) last = stepStanceTransition(st, STANCE_RUN, t, PRONE_ON);
  check(last === STANCE_RUN, 'the bot eventually gets up and runs');
}
{
  const st = { stance: 'garbage' };
  check(stepStanceTransition(st, STANCE_STAND, 0) === STANCE_STAND, 'a junk stored stance normalises to stand without a cost');
}
{
  const st = { stance: STANCE_PRONE, changedAt: 0, blockedUntil: 0 };
  const free = { ...STANCE_DEFAULTS, standUpMs: 0 };
  check(stepStanceTransition(st, STANCE_STAND, 0, free) === STANCE_STAND, 'a zero cost setting makes the stand-up instant');
}
{
  const st = { stance: STANCE_PRONE, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(st, STANCE_STAND, NaN) === STANCE_PRONE, 'a junk clock does not teleport the bot upright');
  check(Number.isFinite(st.blockedUntil), 'a junk clock still leaves a finite latch');
}

// --- stanceSpeedFactor ---
check(stanceSpeedFactor(STANCE_STAND) === 1, 'standing is full speed');
check(stanceSpeedFactor(STANCE_CROUCH) === STANCE_DEFAULTS.crouchSpeedFactor, 'crouch speed comes from settings');
check(stanceSpeedFactor(STANCE_PRONE) === STANCE_DEFAULTS.proneSpeedFactor, 'prone speed comes from settings');
check(stanceSpeedFactor(STANCE_PRONE) < stanceSpeedFactor(STANCE_CROUCH), 'prone is slower than crouch');
check(stanceSpeedFactor(STANCE_RUN, STANCE_DEFAULTS, 1.8) === 1.8, 'run uses the caller run multiplier');
check(stanceSpeedFactor(STANCE_RUN) === 1, 'run with no multiplier supplied is plain walk speed');
check(stanceSpeedFactor(STANCE_RUN, STANCE_DEFAULTS, -3) === 0, 'a negative run multiplier clamps to zero');
check(stanceSpeedFactor(STANCE_RUN, STANCE_DEFAULTS, NaN) === 0, 'a NaN run multiplier is zero, not NaN');
check(stanceSpeedFactor('garbage') === 1, 'an unknown stance is full speed');
check(stanceSpeedFactor(undefined) === 1, 'a missing stance is full speed');
check(stanceSpeedFactor(STANCE_CROUCH, { crouchSpeedFactor: 'junk' }) === 0, 'a junk setting is zero, not NaN');
check(stanceSpeedFactor(STANCE_CROUCH, { crouchSpeedFactor: -1 }) === 0, 'a negative setting clamps to zero');
check(stanceSpeedFactor(STANCE_CROUCH, {}) === STANCE_DEFAULTS.crouchSpeedFactor, 'a partial settings object falls back to defaults');

// --- stanceSpreadScale ---
check(stanceSpreadScale(STANCE_STAND) === 1, 'standing is the baseline cone');
check(stanceSpreadScale(STANCE_CROUCH) === STANCE_DEFAULTS.crouchSpreadScale, 'crouch tightens the cone');
check(stanceSpreadScale(STANCE_PRONE) === STANCE_DEFAULTS.proneSpreadScale, 'prone tightens it further');
check(stanceSpreadScale(STANCE_PRONE) < stanceSpreadScale(STANCE_CROUCH), 'prone is steadier than crouch');
check(stanceSpreadScale(STANCE_RUN) > 1, 'running throws the shot');
check(stanceSpreadScale('garbage') === 1, 'an unknown stance is the baseline cone');
check(stanceSpreadScale(STANCE_RUN, { runSpreadScale: NaN }) === 0, 'a junk spread setting is not NaN');

// --- stanceHeightScale ---
check(stanceHeightScale(STANCE_PRONE, HEIGHT_OFF) === 1, 'flat height scaling is inert when disabled');
check(stanceHeightScale(STANCE_CROUCH, HEIGHT_OFF) === 1, 'flat crouch height is pinned while disabled');
check(stanceHeightScale(STANCE_STAND, HEIGHT_ON) === 1, 'standing is full height');
check(stanceHeightScale(STANCE_CROUCH, HEIGHT_ON) === STANCE_DEFAULTS.crouchHeightScale, 'crouch shrinks the capsule when enabled');
check(stanceHeightScale(STANCE_PRONE, HEIGHT_ON) === STANCE_DEFAULTS.proneHeightScale, 'prone shrinks it further when enabled');
check(stanceHeightScale(STANCE_RUN, HEIGHT_ON) === 1, 'running is full height');
check(stanceHeightScale('garbage', HEIGHT_ON) === 1, 'an unknown stance is full height');
check(stanceHeightScale(STANCE_PRONE, { ...HEIGHT_ON, proneHeightScale: undefined }) === STANCE_DEFAULTS.proneHeightScale, 'an unset height setting falls back to the default, not zero');
check(stanceHeightScale(STANCE_PRONE, { ...HEIGHT_ON, proneHeightScale: NaN }) === 0, 'a junk height setting is not NaN');

// --- stanceTurnRateScale ---
check(stanceTurnRateScale(STANCE_STAND) === 1, 'standing turns at full rate');
check(stanceTurnRateScale(STANCE_RUN) === 1, 'running turns at full rate');
check(stanceTurnRateScale(STANCE_CROUCH) === STANCE_DEFAULTS.crouchTurnRateScale, 'crouch slows the turn');
check(stanceTurnRateScale(STANCE_PRONE) === STANCE_DEFAULTS.proneTurnRateScale, 'prone slows it hard');
check(stanceTurnRateScale(STANCE_PRONE) < stanceTurnRateScale(STANCE_CROUCH), 'a prone bot cannot whip around');
check(stanceTurnRateScale('garbage') === 1, 'an unknown stance turns at full rate');
check(stanceTurnRateScale(STANCE_PRONE, { proneTurnRateScale: 'junk' }) === 0, 'a junk turn setting is not NaN');

// --- kneel scalars: every axis sits between crouch and prone, which is the whole claim of the pose ---
{
  check(stanceSpeedFactor(STANCE_KNEEL) === STANCE_DEFAULTS.kneelSpeedFactor, 'kneel speed comes from settings');
  check(stanceSpeedFactor(STANCE_KNEEL) < stanceSpeedFactor(STANCE_CROUCH), 'a kneeling bot is slower than a crouching one');
  check(stanceSpreadScale(STANCE_KNEEL) < stanceSpreadScale(STANCE_CROUCH), 'kneel is steadier than crouch');
  check(stanceSpreadScale(STANCE_KNEEL) > stanceSpreadScale(STANCE_PRONE), '...and less steady than prone');
  check(stanceTurnRateScale(STANCE_KNEEL) < stanceTurnRateScale(STANCE_CROUCH), 'the planted knee slows the turn');
  check(stanceTurnRateScale(STANCE_KNEEL) > stanceTurnRateScale(STANCE_PRONE), '...but not as much as lying down');
  check(stanceHeightScale(STANCE_KNEEL, HEIGHT_ON) === STANCE_DEFAULTS.kneelHeightScale, 'flat kneel height comes from settings');
  // The flat fallback must agree in ORDER with the rig-derived scale below, or turning off the
  // procedural body would silently flip which of crouch/kneel is the taller target.
  check(stanceHeightScale(STANCE_KNEEL, HEIGHT_ON) > stanceHeightScale(STANCE_CROUCH, HEIGHT_ON),
    'the flat kneel fallback is taller than crouch, matching the rig-derived order');
  check(stanceHeightScale(STANCE_KNEEL, HEIGHT_ON) < 1, '...and still below standing');
  check(stanceHeightScale(STANCE_KNEEL, HEIGHT_OFF) === 1, 'kneel height is inert while height scaling is off');
  check(stanceSpeedFactor(STANCE_KNEEL, { kneelSpeedFactor: NaN }) === 0, 'a junk kneel speed is not NaN');
  check(resolveStanceOverride(STANCE_KNEEL, STANCE_RUN) === STANCE_KNEEL, 'the UI can force a kneel');
}

// No helper may ever emit NaN, whatever it is fed.
{
  const stances = [STANCE_STAND, STANCE_CROUCH, STANCE_KNEEL, STANCE_PRONE, STANCE_RUN, 'garbage', null, undefined, 7];
  const settingsList = [undefined, {}, STANCE_DEFAULTS, HEIGHT_ON, { crouchSpeedFactor: NaN, proneSpreadScale: 'x', proneHeightScale: null, crouchTurnRateScale: undefined, heightEnabled: true }];
  let bad = 0;
  for (const st of stances) {
    for (const s of settingsList) {
      for (const mult of [undefined, 1, NaN, 'x', -2]) {
        if (!Number.isFinite(stanceSpeedFactor(st, s, mult))) bad++;
        if (!Number.isFinite(stanceSpreadScale(st, s))) bad++;
        if (!Number.isFinite(stanceHeightScale(st, s))) bad++;
        if (!Number.isFinite(stanceTurnRateScale(st, s))) bad++;
      }
    }
  }
  check(bad === 0, 'no scalar helper returns NaN for any junk input');
}

// --- resolveStanceOverride ---
check(resolveStanceOverride('auto', STANCE_RUN) === STANCE_RUN, 'auto defers to the derived stance');
check(resolveStanceOverride(null, STANCE_CROUCH) === STANCE_CROUCH, 'null defers');
check(resolveStanceOverride(undefined, STANCE_PRONE) === STANCE_PRONE, 'undefined defers');
check(resolveStanceOverride('lying-down', STANCE_STAND) === STANCE_STAND, 'an unrecognised override defers');
check(resolveStanceOverride('', STANCE_RUN) === STANCE_RUN, 'an empty override defers');
check(resolveStanceOverride(STANCE_PRONE, STANCE_RUN) === STANCE_PRONE, 'a prone override wins');
check(resolveStanceOverride(STANCE_STAND, STANCE_PRONE) === STANCE_STAND, 'a stand override wins');
check(resolveStanceOverride(STANCE_CROUCH, STANCE_RUN) === STANCE_CROUCH, 'a crouch override wins');
check(resolveStanceOverride(STANCE_RUN, STANCE_CROUCH) === STANCE_RUN, 'a run override wins');

// --- end-to-end: derived stance -> latch -> scalars ---
{
  const st = {};
  const desired = chooseBotStance('cover-move', {});
  const eff = stepStanceTransition(st, resolveStanceOverride('auto', desired), 0);
  check(eff === STANCE_RUN && stanceSpreadScale(eff) > 1, 'a bot breaking for cover runs with a wider cone');
  const held = chooseBotStance('cover-hold', { holding: true, holdElapsedMs: 5000 }, PRONE_ON);
  check(held === STANCE_PRONE, 'the same bot goes prone once it is holding at the anchor');
  check(stepStanceTransition(st, held, 16, PRONE_ON) === STANCE_PRONE, 'dropping to prone from run is immediate');
  check(stepStanceTransition(st, STANCE_RUN, 32, PRONE_ON) === STANCE_PRONE, 'and it cannot bounce straight back up');
}


// --- stanceCapsuleHeightScale: derived from the rig, not guessed ---
// Real player-procedural-body.js values: pelvisHeightRatio 0.58 (walk) / 0.52 (run),
// crouchCfg.pelvisDrop 0.62, crouchCfg.headDrop 0.10, proneCfg.hipHeight 0.25, proneCfg.headUp 0.16.
// kneelHipHeight is thighLen(0.580) * KNEEL_DEFAULTS.hipHeight(1.00); kneelHeadDrop is its headDrop.
const RIG = { pelvisHeightRatio: 0.58, pelvisDrop: 0.62, headDrop: 0.10, hipHeight: 0.25, headUp: 0.16,
  kneelHipHeight: 0.580, kneelHeadDrop: 0.04 };
const RIG_RUN = { ...RIG, pelvisHeightRatio: 0.52 };
const H = 1.8;   // standTotalHeight = straight section + both caps

check(stanceCapsuleHeightScale(STANCE_CROUCH, RIG, H, HEIGHT_OFF) === 1, 'derived height is inert while heightEnabled is off');
const crouchScale = stanceCapsuleHeightScale(STANCE_CROUCH, RIG, H, HEIGHT_ON);
const expectCrouch = (0.58 * (1 - 0.62) + 0.48 * (1 - 0.10)) / (0.58 + 0.48);
check(Math.abs(crouchScale - expectCrouch) < 1e-9, 'crouch scale matches the rig head-top formula');
check(Math.abs(crouchScale - 0.6155) < 1e-3, 'crouch scale is ~0.615, not the guessed 0.68');
check(stanceCapsuleHeightScale(STANCE_STAND, RIG, H, HEIGHT_ON) === 1, 'standing is unscaled');
check(stanceCapsuleHeightScale(STANCE_RUN, RIG, H, HEIGHT_ON) === 1, 'running is unscaled');
// Speed-adaptive pelvis ratio must move the answer -- that is why it cannot be a constant.
check(stanceCapsuleHeightScale(STANCE_CROUCH, RIG_RUN, H, HEIGHT_ON) !== crouchScale,
  'a run-gait pelvis ratio yields a different crouch scale');
// Prone is absolute: the same rig on a taller bot must shrink PROPORTIONALLY MORE.
const proneTall = stanceCapsuleHeightScale(STANCE_PRONE, RIG, 2.4, HEIGHT_ON);
const proneShort = stanceCapsuleHeightScale(STANCE_PRONE, RIG, 1.2, HEIGHT_ON);
check(proneTall < proneShort, 'absolute prone height means a taller bot scales down further');
check(Math.abs(stanceCapsuleHeightScale(STANCE_PRONE, RIG, H, HEIGHT_ON) - (0.25 + 0.16) / (H * 1.06)) < 1e-9,
  'prone scale is (hipHeight + headUp) over the standing head top');
check(stanceCapsuleHeightScale(STANCE_PRONE, RIG, H, HEIGHT_ON) < crouchScale, 'prone is lower than crouch');
// Kneel, like prone, parks the hip at an ABSOLUTE height (a multiple of thigh length off the fixed
// skeleton), so it is the caller's metres and must scale with the bot's own standing height.
{
  const kneelScale = stanceCapsuleHeightScale(STANCE_KNEEL, RIG, H, HEIGHT_ON);
  const expectKneel = (0.580 / H + 0.48 * (1 - 0.04)) / (0.58 + 0.48);
  check(Math.abs(kneelScale - expectKneel) < 1e-9, 'kneel scale matches the absolute-hip head-top formula');
  // Deliberately NOT "kneel is smaller than crouch". This rig's crouch is a deep squat that parks the
  // hip at 0.58*0.38 = 0.22 of height, below the kneel's thigh-length hip -- so a kneeling bot is the
  // TALLER target. Kneel earns the long-range aim rung on stability, never on silhouette; asserting
  // it the intuitive way round would be asserting something the rig does not do.
  check(kneelScale > crouchScale, 'a kneeling bot is a taller target than this rig\'s deep crouch');
  check(kneelScale < 1, '...but still shorter than standing');
  check(kneelScale > stanceCapsuleHeightScale(STANCE_PRONE, RIG, H, HEIGHT_ON), 'and taller than a prone bot');
  check(stanceCapsuleHeightScale(STANCE_KNEEL, RIG, 2.4, HEIGHT_ON) < stanceCapsuleHeightScale(STANCE_KNEEL, RIG, 1.2, HEIGHT_ON),
    'absolute kneel height means a taller bot scales down further');
  check(stanceCapsuleHeightScale(STANCE_KNEEL, RIG, H, HEIGHT_OFF) === 1, 'derived kneel height is inert while height scaling is off');
  // A rig with no kneel data at all (an older body, or one built before kneelCfg existed) must fall
  // back to the flat setting rather than silently reporting full standing height.
  const noKneel = { ...RIG, kneelHipHeight: 0 };
  check(stanceCapsuleHeightScale(STANCE_KNEEL, noKneel, H, HEIGHT_ON) === STANCE_DEFAULTS.kneelHeightScale,
    'a rig with no kneel data falls back to the flat kneel setting, not to full height');
}
// Junk rig data must never invert, zero, or NaN a bot's capsule.
for (const bad of [null, undefined, {}, { pelvisHeightRatio: NaN }, { pelvisHeightRatio: -5, pelvisDrop: 9 },
  { pelvisHeightRatio: 'x', headDrop: 'y', hipHeight: 'z', headUp: 'w' }]) {
  for (const st of [STANCE_CROUCH, STANCE_KNEEL, STANCE_PRONE]) {
    const v = stanceCapsuleHeightScale(st, bad, H, HEIGHT_ON);
    check(Number.isFinite(v) && v > 0 && v <= 1, `junk rig config yields a sane scale (${st})`);
  }
}
check(stanceCapsuleHeightScale(STANCE_PRONE, RIG, 0, HEIGHT_ON) === 1, 'a zero standing height cannot divide by zero');
check(stanceCapsuleHeightScale(STANCE_PRONE, RIG, -3, HEIGHT_ON) === 1, 'a negative standing height is rejected');

// --- stepStanceWeights: eased 0..1 pose weights ---
{
  const w = {};
  stepStanceWeights(w, STANCE_CROUCH, 0.016);
  check(w.crouch01 > 0 && w.crouch01 < 1, 'a single frame eases partway into a crouch, never snaps');
  check(w.prone01 === 0, 'crouching does not raise the prone weight');
  for (let i = 0; i < 120; i++) stepStanceWeights(w, STANCE_CROUCH, 0.016);
  check(w.crouch01 > 0.99, 'holding the stance settles the weight at 1');
  for (let i = 0; i < 120; i++) stepStanceWeights(w, STANCE_STAND, 0.016);
  check(w.crouch01 < 0.01, 'standing back up decays the weight to 0');
  // Prone eases slower than crouch by default -- it is a bigger move.
  const a = stepStanceWeights({}, STANCE_CROUCH, 0.1).crouch01;
  const b = stepStanceWeights({}, STANCE_PRONE, 0.1).prone01;
  check(b < a, 'prone blends in slower than crouch');
  check(stepStanceWeights(null, STANCE_CROUCH, 0.016).crouch01 > 0, 'a null weight object is safe');
  const z = stepStanceWeights({}, STANCE_CROUCH, 0);
  check(z.crouch01 === 0, 'a zero dt moves nothing');
  const j = stepStanceWeights({ crouch01: NaN, kneel01: 'y', prone01: 'x' }, STANCE_CROUCH, 0.016);
  check(Number.isFinite(j.crouch01) && Number.isFinite(j.kneel01) && Number.isFinite(j.prone01), 'junk weights recover to finite values');
  for (let i = 0; i < 400; i++) stepStanceWeights(w, STANCE_PRONE, 0.016);
  check(w.prone01 > 0.99 && w.prone01 <= 1, 'weights never overshoot past 1');
}
{
  // Kneel is a third independent channel: raising it must not raise the other two, or the rig gets
  // two poses at once and blends into something that is neither.
  const w = {};
  for (let i = 0; i < 200; i++) stepStanceWeights(w, STANCE_KNEEL, 0.016);
  check(w.kneel01 > 0.99, 'holding a kneel settles its weight at 1');
  check(w.crouch01 < 0.01 && w.prone01 < 0.01, 'kneeling raises neither the crouch nor the prone weight');
  for (let i = 0; i < 200; i++) stepStanceWeights(w, STANCE_CROUCH, 0.016);
  check(w.kneel01 < 0.01 && w.crouch01 > 0.99, 'crossing kneel -> crouch swaps which weight is live');
  const k = stepStanceWeights({}, STANCE_KNEEL, 0.1).kneel01;
  const c = stepStanceWeights({}, STANCE_CROUCH, 0.1).crouch01;
  const p = stepStanceWeights({}, STANCE_PRONE, 0.1).prone01;
  check(k < c && k > p, 'kneel blends slower than crouch and faster than prone');
}

// --- blendStanceHeightScale ---
// Signature is (crouchScale, proneScale, crouch01, prone01, kneelScale?, kneel01?) -- kneel trails so
// the three viewers that predate it keep calling it correctly with four arguments.
check(blendStanceHeightScale(0.6, 0.2, 0, 0) === 1, 'no pose weight = full standing height');
check(Math.abs(blendStanceHeightScale(0.6, 0.2, 1, 0) - 0.6) < 1e-9, 'full crouch weight = the crouch scale');
check(Math.abs(blendStanceHeightScale(0.6, 0.2, 0, 1) - 0.2) < 1e-9, 'full prone weight = the prone scale');
check(Math.abs(blendStanceHeightScale(0.6, 0.2, 1, 1) - 0.2) < 1e-9, 'prone dominates a simultaneous crouch, like the rig');
{
  const mid = blendStanceHeightScale(0.6, 0.2, 0.5, 0);
  check(mid > 0.6 && mid < 1, 'a half-blended crouch sits between the two heights');
}
check(Math.abs(blendStanceHeightScale(0.6, 0.2, -3, 9) - 0.2) < 1e-9, 'out-of-range weights clamp instead of extrapolating');
check(blendStanceHeightScale(NaN, NaN, 1, 0) === 1, 'junk scales fall back to standing height');
// A four-argument call is exactly the pre-kneel curve: this is what keeps bot-viewer-v2 and
// environment-viewer-v2 correct rather than merely not-crashing.
{
  let drift = 0;
  for (const c of [0, 0.25, 0.5, 1]) {
    for (const p of [0, 0.25, 0.5, 1]) {
      const four = blendStanceHeightScale(0.6, 0.2, c, p);
      const six = blendStanceHeightScale(0.6, 0.2, c, p, 1, 0);
      if (Math.abs(four - six) > 1e-12) drift++;
    }
  }
  check(drift === 0, 'omitting the kneel pair is identical to passing an inert one');
}
// --- kneel term ---
check(Math.abs(blendStanceHeightScale(0.6, 0.2, 0, 0, 0.4, 1) - 0.4) < 1e-9, 'full kneel weight = the kneel scale');
check(Math.abs(blendStanceHeightScale(0.6, 0.2, 1, 1, 0.4, 1) - 0.2) < 1e-9, 'prone dominates everything, like the rig');
check(Math.abs(blendStanceHeightScale(0.6, 0.2, 1, 0, 0.4, 1) - 0.4) < 1e-9, 'kneel dominates a simultaneous crouch, like the rig');
{
  // Mid-transition crouch -> kneel: both weights partly up. The result must stay inside the band the
  // two endpoints define, never bulge above the crouch height or below the kneel one.
  const cross = blendStanceHeightScale(0.6, 0.2, 0.5, 0, 0.4, 0.5);
  check(cross <= 0.6 + 1e-9 && cross >= 0.4 - 1e-9, 'a crouch/kneel crossfade stays between the two heights');
}
check(Math.abs(blendStanceHeightScale(0.6, 0.2, -3, 9, 0.4, 9) - 0.2) < 1e-9, 'out-of-range kneel weights clamp too');
check(blendStanceHeightScale(0.6, 0.2, 0, 0, NaN, 1) === 1, 'a junk kneel scale falls back to standing height');

// --- dash: the grenade-evade sprint ---
check(chooseBotStance('patrol', { evading: true }) === STANCE_DASH, 'a live blast dashes from any state');
check(chooseBotStance('heal', { evading: true, forcedCrouch: true }) === STANCE_DASH,
  'evading outranks forcedCrouch, matching updateGrenadeEvade beating every movement handler');
check(chooseBotStance('flee', { evading: true, holding: true, holdElapsedMs: 9999 }, PRONE_ON) === STANCE_DASH,
  'evading outranks a prone-eligible hold');
check(chooseBotStance('patrol', { evading: true }, { ...STANCE_DEFAULTS, enabled: false }) === STANCE_STAND,
  'the master gate still outranks a dash');
check(chooseBotStance('patrol', {}) === STANCE_STAND, 'no evade flag leaves the table untouched');
{
  // Dash pays no exit cost: a prone bot must leave the pose the instant the movement code sprints it.
  const latch = { stance: STANCE_PRONE, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(latch, STANCE_DASH, 10, PRONE_ON) === STANCE_DASH, 'prone -> dash is free');
  const slow = { stance: STANCE_PRONE, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(slow, STANCE_STAND, 10, PRONE_ON) === STANCE_PRONE, '...but prone -> stand still is not');
}
{
  const latch = { stance: STANCE_DASH, changedAt: 0, blockedUntil: 0 };
  check(stepStanceTransition(latch, STANCE_STAND, 10, PRONE_ON) === STANCE_STAND, 'leaving dash is free too');
}
check(stanceSpeedFactor(STANCE_DASH, STANCE_DEFAULTS, 2) > stanceSpeedFactor(STANCE_RUN, STANCE_DEFAULTS, 2),
  'a dash outruns a run');
check(stanceSpreadScale(STANCE_DASH) > stanceSpreadScale(STANCE_RUN), 'one-handed at a sprint is the worst cone');
check(stanceTurnRateScale(STANCE_DASH) === 1, 'an evading bot turns unpenalised');
check(stanceHeightScale(STANCE_DASH, HEIGHT_ON) === 1, 'dash is upright: full height');
check(stanceCapsuleHeightScale(STANCE_DASH, { pelvisHeightRatio: 0.55, pelvisDrop: 0.3, headDrop: 0.3 }, 1.8, HEIGHT_ON) === 1,
  'dash keeps the full capsule, like stand and run');
check(resolveStanceOverride(STANCE_DASH, STANCE_STAND) === STANCE_DASH, 'the UI can force a dash');
{
  const w = stepStanceWeights({ crouch01: 1, kneel01: 1, prone01: 1 }, STANCE_DASH, 1e3);
  check(w.crouch01 < 1e-6 && w.kneel01 < 1e-6 && w.prone01 < 1e-6, 'dash eases every pose weight to upright');
}

console.log(`bot-stance: ${checks} checks passed`);
