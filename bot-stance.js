// Pure, THREE-free stance math for the combat bots. Stance ({prone, kneel, crouch, stand, run, dash}) used to be
// one global cosmetic object driven by three UI buttons; this module makes it a per-bot channel
// derived from the resolved FSM state, with real consequences (speed, weapon spread, turn rate, and
// optionally capsule/eye height). Unit-tested in test-bot-stance.mjs.
//
// Stance is deliberately NOT new FSM states: the ladder in bot-activity.js already carries 14 rungs
// and three commitment latches, and folding posture into it would multiply every rung. Stance is an
// orthogonal derived channel computed right after the state ladder resolves, so it can be toggled
// off (or force-overridden from the UI) without touching the ladder at all.
//
// Recognised FSM state strings (compared as plain strings so this module imports nothing):
// 'patrol', 'seek', 'pursue', 'flee', 'heal', 'knife', 'aim', 'fire', 'cover-move', 'cover-hold',
// 'medic-move', 'medic-tend', 'alert'. Anything unrecognised reads as STAND.
//
// stepStanceTransition exists because posture without an exit cost is degenerate: prone is strictly
// dominant for any stationary bot (least spread, smallest silhouette), so with a free stand-up the
// entire roster flops down and never gets back up. Charging standUpMs/crouchUpMs to LEAVE a low
// stance -- while entering one stays instant -- makes going prone a commitment, which is the only
// thing that keeps the posture choice interesting.

export const STANCE_PRONE = 'prone';
// One knee down. Sits between crouch and prone on every axis: steadier and smaller than a crouch,
// but a closed kinematic chain the bot has to unfold before it can move, so it costs more to leave.
export const STANCE_KNEEL = 'kneel';
export const STANCE_CROUCH = 'crouch';
export const STANCE_STAND = 'stand'; // stationary or walking upright
export const STANCE_RUN = 'run';
// All-out sprint clear of a live grenade: one-handed carry, muzzle up, worst spread of any stance.
export const STANCE_DASH = 'dash';

export const STANCE_DEFAULTS = {
  enabled: true,                 // master gate: false => every bot reads STANCE_STAND
  proneEnabled: false,           // prone is opt-in; default off until QA'd
  // Kneel is opt-in for the same reason prone is, plus a harder one: a caller that picks kneel
  // without wiring the rig's `kneel` channel and the kneel01 weight renders a KNEELING bot STANDING.
  // bot-viewer-v3.html opts in; bot-viewer-v2 and environment-viewer-v2 have not been wired, so the
  // default has to leave them on exactly the behaviour they had.
  kneelEnabled: false,
  heightEnabled: true,           // scale the LOS/hit capsule with the pose; derived from the rig, not guessed
  crouchSpeedFactor: 0.55,
  kneelSpeedFactor: 0.28,        // below prone's: a kneeling bot shuffles, it does not crawl
  proneSpeedFactor: 0.30,
  crouchSpreadScale: 0.75,
  kneelSpreadScale: 0.60,
  proneSpreadScale: 0.50,
  runSpreadScale: 1.25,
  dashSpeedBonus: 1.15,          // multiplier ON TOP of the caller's run multiplier
  dashSpreadScale: 1.9,          // one-handed at a dead sprint: worst cone in the table
  dashTurnRateScale: 1,          // an evading bot must still be able to turn
  crouchHeightScale: 0.68,
  // ABOVE crouch, not below it: this rig's crouch is a deep squat that parks the hip lower than a
  // kneel does. Kneel wins on stability (a planted base), not on silhouette -- measured, not guessed.
  kneelHeightScale: 0.75,
  proneHeightScale: 0.35,
  crouchTurnRateScale: 0.80,
  kneelTurnRateScale: 0.55,      // the planted knee is a pivot, so worse than a crouch, better than prone
  proneTurnRateScale: 0.35,
  standUpMs: 700,                // transition cost leaving prone, so prone is not free
  kneelUpMs: 420,                // ... and leaving kneel, between crouch and prone
  crouchUpMs: 220,               // shorter transition cost leaving crouch
  proneMinHoldMs: 1200,          // how long a bot must ALREADY have been held before prone is justified
  seekCrouchRadius: 4,           // m from the last-known point where a searching bot crouches
  aimCrouchDistance: 8,          // m: beyond this a stationary aiming bot crouches to steady the shot
  // Kneel and crouch COEXIST on the aim rung rather than replacing one another: crouch is the
  // mid-range posture a bot can rise out of quickly, kneel is the committed long-range firing
  // position. Beyond this second, longer threshold the shot is worth the slower stand-up.
  aimKneelDistance: 16,
  // Dead-band margins: a bot hovering right at a bare threshold for longer than crouchUpMs (the
  // transition latch's own damping window) will visibly toggle crouch/stand. Entry keeps the bare
  // value above; a bot that is ALREADY crouched only stands back up once it clears this much further.
  seekCrouchHysteresisM: 1,      // m: extra distance beyond seekCrouchRadius required to stand back up
  aimCrouchHysteresisM: 1.5,     // m: extra distance short of aimCrouchDistance required to stand back up
  aimKneelHysteresisM: 2.5,      // wider than the crouch band: standing out of a kneel costs more
  crouchBlendRate: 9,            // exponential 1/s toward a crouch pose (~180 ms to settle)
  kneelBlendRate: 6,             // ... toward kneel, between the two
  proneBlendRate: 5,             // ... and toward prone, slower because it is a bigger move
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Junk/missing range must not fake proximity. null is spelled out: Number(null) is a finite 0, which
// would land inside seekCrouchRadius and crouch every searching bot that has no last-known point.
const far = (v) => (v == null || !Number.isFinite(Number(v)) ? Infinity : Number(v));
// Per-key fallback instead of a merged copy: these run per bot per frame, and the viewer mutates its
// live settings object from sliders, so neither allocating nor caching a merge is acceptable.
const opt = (s, k) => { const v = s == null ? undefined : s[k]; return v === undefined ? STANCE_DEFAULTS[k] : v; };

// Unrecognised / missing posture reads as STAND, never as a low stance.
function normalizeStance(stance) {
  return (stance === STANCE_PRONE || stance === STANCE_KNEEL || stance === STANCE_CROUCH
    || stance === STANCE_RUN || stance === STANCE_DASH)
    ? stance : STANCE_STAND;
}

// Desired stance for a resolved FSM state. Pure: the caller owns all state, this owns the table.
export function chooseBotStance(state, ctx = {}, settings = STANCE_DEFAULTS) {
  if (!opt(settings, 'enabled')) return STANCE_STAND;
  const { forcedCrouch = false, holding = false, holdElapsedMs = 0,
    peekPhase = null, peekExposed = false,
    targetVisible = false, targetDistance = 0,
    distanceToLastKnown = Infinity, alertHeld = false, evading = false,
    alreadyCrouched = false, alreadyKneeling = false, doubleTime = false } = ctx || {};
  // Every kneel rung degrades to what it returned before kneel existed, so the toggle is a true
  // baseline switch rather than a stance the ladder silently skips.
  const kneelOr = (fallback) => (opt(settings, 'kneelEnabled') ? STANCE_KNEEL : fallback);
  // Matches updateGrenadeEvade's precedence in the viewer: a live blast outranks every other
  // consideration, including the heal/pack dip, so the posture must not disagree with the movement.
  if (evading) return STANCE_DASH;
  if (forcedCrouch) return STANCE_CROUCH; // pack-pickup dip / any self-heal outranks the table
  // Both heal rungs are role-blind and always low. Treating a casualty means being pinned in the open
  // beside them, so there is no case where standing to do it is right -- least of all in a firefight,
  // which is the one that used to stand. What combat changes is the WEAPON, not the posture: the
  // viewer's `tendUnderFire` keeps the sidearm out and the work one-handed, and holsters it for a
  // two-handed job once nothing is shooting. Same for a revive, which differs only in its motion.
  //
  // Tending kneels and self-healing crouches, and the split is not cosmetic: the medic is working on
  // someone else at arm's length, which needs a stable base and both hands forward, while a bot
  // patching itself wants to be able to break and run. (The forcedCrouch rung above already caught
  // 'heal' -- this arm only runs when that gate is off.)
  if (state === 'heal') return STANCE_CROUCH;
  if (state === 'medic-tend') return kneelOr(STANCE_CROUCH);
  // Gate on time ALREADY held, not time remaining: both hold issuers grant a short lease refreshed
  // every frame, so "remaining" is a constant ~500 ms and never evidences a sustained hold.
  //
  // Kneel is the middle rung a held bot actually reaches: prone is opt-in AND needs proneMinHoldMs
  // of sustained hold, so before kneel existed an overwatching bot just crouched indefinitely.
  if (holding) {
    const canProne = opt(settings, 'proneEnabled') && num(holdElapsedMs) >= num(opt(settings, 'proneMinHoldMs'));
    return canProne ? STANCE_PRONE : kneelOr(STANCE_CROUCH);
  }
  if (state === 'cover-hold') {
    if (peekPhase === 'in') return STANCE_CROUCH; // tucked behind the corner
    return peekExposed ? STANCE_STAND : STANCE_CROUCH;
  }
  if (state === 'alert' || alertHeld) return STANCE_CROUCH;
  if (state === 'pursue' || state === 'flee' || state === 'cover-move' || state === 'medic-move' || state === 'knife') return STANCE_RUN;
  // A "double time" command only ever applies out of combat (state reads 'patrol' while under one --
  // see updateCommandMovement in the viewer), so this can't fight the aim/seek crouch logic below.
  if (state === 'patrol' && doubleTime) return STANCE_RUN;
  if (state === 'aim' || state === 'fire') {
    // Two nested bands, longest first: stand up close, crouch at mid range, kneel for the long shot.
    // Dead-band on each: once low for range, standing back up needs the shot to close by a further
    // margin, not just tick back under the bare trigger -- else hovering at the boundary flickers.
    if (!targetVisible) return STANCE_STAND;
    const d = num(targetDistance);
    if (opt(settings, 'kneelEnabled')) {
      const kneelAt = num(opt(settings, 'aimKneelDistance')) -
        (alreadyKneeling ? num(opt(settings, 'aimKneelHysteresisM')) : 0);
      if (d >= kneelAt) return STANCE_KNEEL;
    }
    const trigger = num(opt(settings, 'aimCrouchDistance')) -
      (alreadyCrouched ? num(opt(settings, 'aimCrouchHysteresisM')) : 0);
    return d >= trigger ? STANCE_CROUCH : STANCE_STAND;
  }
  if (state === 'seek') {
    const trigger = num(opt(settings, 'seekCrouchRadius')) +
      (alreadyCrouched ? num(opt(settings, 'seekCrouchHysteresisM')) : 0);
    return far(distanceToLastKnown) <= trigger ? STANCE_CROUCH : STANCE_STAND;
  }
  return STANCE_STAND;
}

// How low a posture sits, for the "going lower is free" rule. Only the low stances rank; everything
// upright shares 0, so stand -> run -> dash costs nothing in either direction.
function stanceDepth(stance) {
  if (stance === STANCE_PRONE) return 3;
  if (stance === STANCE_KNEEL) return 2;
  if (stance === STANCE_CROUCH) return 1;
  return 0;
}

// ms owed before `cur` may be abandoned for `want`. Going lower (stand -> crouch -> kneel -> prone)
// is free; only rising out of a low stance is charged.
function exitCostMs(cur, want, settings) {
  if (cur === want) return 0;
  // Dash is the blast-evade emergency: it pays no exit cost, or a prone bot would keep sprinting in
  // the prone pose for the whole stand-up window while updateGrenadeEvade already moved it.
  if (want === STANCE_DASH) return 0;
  if (stanceDepth(want) > stanceDepth(cur)) return 0;   // dropping lower is always instant
  if (cur === STANCE_PRONE) return Math.max(0, num(opt(settings, 'standUpMs')));
  if (cur === STANCE_KNEEL) return Math.max(0, num(opt(settings, 'kneelUpMs')));
  if (cur === STANCE_CROUCH) return Math.max(0, num(opt(settings, 'crouchUpMs')));
  return 0;
}

// Mutating latch over a caller-owned { stance, changedAt, blockedUntil } object (fields are created
// if absent). Returns -- and writes to st.stance -- the EFFECTIVE stance: the old one while an exit
// cost is still owed, the desired one once it is paid. Safe with a null or fresh st, every frame.
export function stepStanceTransition(st, desired, now, settings = STANCE_DEFAULTS) {
  const want = normalizeStance(desired);
  const t = num(now);
  if (!st) return want;
  if (st.stance == null) { st.stance = want; st.changedAt = t; st.blockedUntil = 0; return want; }
  st.stance = normalizeStance(st.stance);
  if (st.stance === want) { st.blockedUntil = 0; return st.stance; } // held or re-chosen: cancel any pending exit
  const cost = exitCostMs(st.stance, want, settings);
  if (cost > 0) {
    if (!(num(st.blockedUntil) > 0)) st.blockedUntil = t + cost; // start the stand-up clock
    if (t < num(st.blockedUntil)) return st.stance;              // still committed to the old posture
  }
  st.stance = want; st.changedAt = t; st.blockedUntil = 0;
  return want;
}

// Movement-speed multiplier. RUN uses the caller's own run multiplier so the existing UI slider wins.
export function stanceSpeedFactor(stance, settings = STANCE_DEFAULTS, runMultiplier = 1) {
  switch (normalizeStance(stance)) {
    case STANCE_CROUCH: return Math.max(0, num(opt(settings, 'crouchSpeedFactor')));
    case STANCE_KNEEL: return Math.max(0, num(opt(settings, 'kneelSpeedFactor')));
    case STANCE_PRONE: return Math.max(0, num(opt(settings, 'proneSpeedFactor')));
    case STANCE_RUN: return Math.max(0, num(runMultiplier));
    case STANCE_DASH: return Math.max(0, num(runMultiplier)) * Math.max(0, num(opt(settings, 'dashSpeedBonus')));
    default: return 1;
  }
}

// Multiplier on the bot-aim.js spread cone: low stances steady the shot, running throws it.
export function stanceSpreadScale(stance, settings = STANCE_DEFAULTS) {
  switch (normalizeStance(stance)) {
    case STANCE_CROUCH: return Math.max(0, num(opt(settings, 'crouchSpreadScale')));
    case STANCE_KNEEL: return Math.max(0, num(opt(settings, 'kneelSpreadScale')));
    case STANCE_PRONE: return Math.max(0, num(opt(settings, 'proneSpreadScale')));
    case STANCE_RUN: return Math.max(0, num(opt(settings, 'runSpreadScale')));
    case STANCE_DASH: return Math.max(0, num(opt(settings, 'dashSpreadScale')));
    default: return 1;
  }
}

// Capsule/eye-height multiplier; pinned to 1 unless heightEnabled, since nav assumes a fixed profile.
export function stanceHeightScale(stance, settings = STANCE_DEFAULTS) {
  if (!opt(settings, 'heightEnabled')) return 1;
  switch (normalizeStance(stance)) {
    case STANCE_CROUCH: return Math.max(0, num(opt(settings, 'crouchHeightScale')));
    case STANCE_KNEEL: return Math.max(0, num(opt(settings, 'kneelHeightScale')));
    case STANCE_PRONE: return Math.max(0, num(opt(settings, 'proneHeightScale')));
    default: return 1;
  }
}

// Fraction of `height` the rig puts the top of the head above the pelvis (player-procedural-body.js
// head placement: pelvisY + height * 0.48 * (1 - crouch * headDrop)).
export const RIG_HEAD_TOP_FACTOR = 0.48;

// Capsule scale DERIVED from what the rig actually renders, rather than the guessed *HeightScale
// constants -- so the collision/LOS capsule shrinks by the same fraction the visible body does and
// the two cannot drift. `rig` mirrors the body's live config:
//   { pelvisHeightRatio, pelvisDrop, headDrop, hipHeight, headUp, kneelHipHeight, kneelHeadDrop }
// pelvisHeightRatio must be the LIVE gait value (it is speed-adaptive, 0.58 walk -> 0.52 run), not a
// constant. Prone is special: the rig parks the hip at an ABSOLUTE hipHeight, so its scale depends on
// the bot's own standing height and cannot be a fixed ratio at all. Kneel is the same: its hip sits
// at a multiple of THIGH length off the FIXED skeleton, so it is also absolute metres here and the
// caller does the limb arithmetic rather than this module guessing the proportions.
// Returns 1 (no change) when heightEnabled is off or the rig numbers are unusable.
export function stanceCapsuleHeightScale(stance, rig, standTotalHeight, settings = STANCE_DEFAULTS) {
  if (!opt(settings, 'heightEnabled')) return 1;
  const s = normalizeStance(stance);
  if (s === STANCE_STAND || s === STANCE_RUN || s === STANCE_DASH) return 1; // upright: full profile
  const r = num(rig?.pelvisHeightRatio);
  const standTop = r + RIG_HEAD_TOP_FACTOR;      // multiples of `height`, above ground
  if (!(standTop > 0)) return 1;
  if (s === STANCE_CROUCH) {
    const crouchTop = r * (1 - num(rig?.pelvisDrop)) + RIG_HEAD_TOP_FACTOR * (1 - num(rig?.headDrop));
    return clampScale(crouchTop / standTop);
  }
  const total = num(standTotalHeight);
  if (!(total > 0)) return 1;
  if (s === STANCE_KNEEL) {
    const hip = num(rig?.kneelHipHeight);
    if (!(hip > 0)) return stanceHeightScale(s, settings);   // no rig kneel data: fall back to the flat setting
    const kneelTop = hip / total + RIG_HEAD_TOP_FACTOR * (1 - num(rig?.kneelHeadDrop));
    return clampScale(kneelTop / standTop);
  }
  return clampScale((num(rig?.hipHeight) + num(rig?.headUp)) / (total * standTop));
}

// A derived scale is only trusted inside a sane band: junk rig config must not invert or erase a bot.
function clampScale(v) {
  return Number.isFinite(v) && v > 0.05 && v <= 1 ? v : 1;
}

// Continuous 0..1 pose weights, eased toward the current stance. The rig already accepts fractional
// crouch/prone; feeding it a bare 0/1 is what made posture pop. One shared pair of weights drives the
// visual pose AND the capsule scale, so the silhouette and the hitbox can never disagree mid-blend.
// Mutates and returns `w` = { crouch01, kneel01, prone01 }; safe with a fresh {} or null.
export function stepStanceWeights(w, stance, dt, settings = STANCE_DEFAULTS) {
  const out = w || { crouch01: 0, kneel01: 0, prone01: 0 };
  const s = normalizeStance(stance);
  const step = (cur, target, rate) => {
    const c = num(cur), t = num(target), k = Math.max(0, num(rate)) * Math.max(0, num(dt));
    if (!(k > 0)) return c;
    return c + (t - c) * (1 - Math.exp(-k));
  };
  out.crouch01 = step(out.crouch01, s === STANCE_CROUCH ? 1 : 0, opt(settings, 'crouchBlendRate'));
  out.kneel01 = step(out.kneel01, s === STANCE_KNEEL ? 1 : 0, opt(settings, 'kneelBlendRate'));
  out.prone01 = step(out.prone01, s === STANCE_PRONE ? 1 : 0, opt(settings, 'proneBlendRate'));
  return out;
}

// Blend the derived scales by the live pose weights, mirroring the rig's own precedence: prone
// dominates, kneel takes what prone left, crouch takes what is still free. 1 means full standing
// height. Kneel is a TRAILING optional pair rather than sitting in stance order, so the three
// viewers that predate it keep calling this correctly with four arguments and no kneel term.
export function blendStanceHeightScale(crouchScale, proneScale, crouch01, prone01, kneelScale = 1, kneel01 = 0) {
  const pw = clamp01(num(prone01));
  const kw = clamp01(num(kneel01)) * (1 - pw);
  const cw = clamp01(num(crouch01)) * (1 - pw) * (1 - kw);
  const cs = num(crouchScale) || 1, ks = num(kneelScale) || 1, ps = num(proneScale) || 1;
  return 1 + (cs - 1) * cw + (ks - 1) * kw + (ps - 1) * pw;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Yaw slew multiplier: a prone bot cannot whip around, a running one is unpenalised.
export function stanceTurnRateScale(stance, settings = STANCE_DEFAULTS) {
  switch (normalizeStance(stance)) {
    case STANCE_CROUCH: return Math.max(0, num(opt(settings, 'crouchTurnRateScale')));
    case STANCE_KNEEL: return Math.max(0, num(opt(settings, 'kneelTurnRateScale')));
    case STANCE_PRONE: return Math.max(0, num(opt(settings, 'proneTurnRateScale')));
    case STANCE_DASH: return Math.max(0, num(opt(settings, 'dashTurnRateScale')));
    default: return 1;
  }
}

// UI force-override: 'auto' (or anything unrecognised) defers to the derived stance.
export function resolveStanceOverride(override, autoStance) {
  if (override === STANCE_STAND || override === STANCE_CROUCH || override === STANCE_KNEEL
    || override === STANCE_PRONE || override === STANCE_RUN || override === STANCE_DASH) return override;
  return autoStance;
}
