// Pure, THREE-free encoding of a combat bot's discrete state as a 9-character alphanumeric code,
// so state traces can be logged, diffed, and mined. Unit-tested in test-bot-state-code.mjs.
//
// Why a code: the bot FSM's observable condition is a product of nine independent discrete axes
// (bot-activity.js's ladder state, bot-alert.js's escalation tiering, bot-roles.js/bot-medic.js's
// role duty, plus ammo/health/pack/commit-latch resources). A fixed-width positional code makes a
// frame-by-frame trace greppable, diffable slot-by-slot, and countable without a schema.
//
// Slot model (positional, one char each):
//   1 state    P patrol S seek U pursue E flee H heal K knife A aim F fire
//              C cover-move G cover-hold M medic-move T medic-tend D dead
//   2 tier     0 calm 1 near-miss 2 wary 3 defensive 4 push
//   3 score    alertEscalation score, 0-9 clamped
//   4 role     r rifleman, m medic
//   5 element  - none, b base-of-fire, m moving   (push element)
//   6 ammo     - unarmed, R reloading, 0 empty, 1-4 magazine bands
//   7 health   0-4 health quintile
//   8 packs    0-4 held packs; A-E = the same count while also holding a revive kit
//   9 latches  base32 char of 5 commit bits: 1 flee, 2 cover, 4 held-in-place, 8 heal-flee,
//              16 sight-grace
//
// Medic duty is NOT a parallel axis. bot-viewer-v2.html's `if (duty) state = duty.state` overwrites
// the FSM state, so medic-move/medic-tend are two extra values of slot 1 gated by role=medic. An
// earlier revision of this model treated duty as its own slot and was wrong.
//
// This module owns the buckets (healthBand/ammoSlot/packSlot/latchBits/tierSlot) so quantization
// lives in one testable place; the viewer adapter owns pulling raw fields off a live actor and
// never re-derives a band itself. encodeBotState takes already-discretized fields only.
//
// Of 43,680,000 raw slot products, 395,533 are legal (0.906%) and project onto 458 behavioural
// core states. The 18 legality rules below cite the source predicate or line that motivates each
// one; they are the only record of why a combination is impossible, so keep the citations. Line
// numbers in bot-viewer-v2.html drift, so the weapon rules cite predicate names instead.
// Rules describe COMMIT-time reality, not decision-time: the trace samples at the end of the
// frame, after the state-execution tail has consumed packs, emptied mags, and started reloads.
// Three first-authoring rules (fire-needs-loaded-mag, heal-needs-pack + duty-requires-resource,
// sight-latch-scope) encoded decision-time invariants and were retired 2026-08-01 when live bots
// legally violated all three (see the replacement comments inline below).

// ---- slot alphabets --------------------------------------------------------------------------

export const STATE_CHARS = 'PSUEHKAFCGMTD'; // 11 ladder states + the 2 medic-duty overrides
export const TIER_CHARS = '01234';
export const SCORE_CHARS = '0123456789';
export const ROLE_CHARS = 'rm';
export const ELEMENT_CHARS = '-bm';
export const AMMO_CHARS = '-R01234';
export const HEALTH_CHARS = '01234';
export const PACK_CHARS = '01234ABCDE'; // A-E mirror 0-4 with a revive kit also held
export const LATCH_CHARS = Array.from({ length: 32 }, (_, i) => i.toString(32).toUpperCase()).join('');

export const STATE_NAMES = {
  P: 'patrol', S: 'seek', U: 'pursue', E: 'flee', H: 'heal', K: 'knife', A: 'aim', F: 'fire',
  C: 'cover-move', G: 'cover-hold', M: 'medic-move', T: 'medic-tend', D: 'dead',
};
// Coarse grouping for filtering a trace without listing 13 states.
export const STATE_CLASSES = {
  P: 'idle', S: 'search', U: 'engage', E: 'survive', H: 'survive', K: 'engage', A: 'engage',
  F: 'engage', C: 'defend', G: 'defend', M: 'support', T: 'support', D: 'terminal',
};
export const TIER_NAMES = { 0: 'calm', 1: 'near-miss', 2: 'wary', 3: 'defensive', 4: 'push' };
export const ROLE_NAMES = { r: 'rifleman', m: 'medic' };
export const ELEMENT_NAMES = { '-': 'none', b: 'base-of-fire', m: 'moving' };
export const AMMO_NAMES = {
  '-': 'unarmed', R: 'reloading', 0: 'empty',
  1: 'mag <=25%', 2: 'mag <=50%', 3: 'mag <=75%', 4: 'mag <=100%',
};
export const HEALTH_NAMES = { 0: '0-20%', 1: '20-40%', 2: '40-60%', 3: '60-80%', 4: '80-100%' };

export const LATCH_FLEE = 1;        // bot-activity.js:74  fleeCommitted
export const LATCH_COVER = 2;       // bot-activity.js:79  coverCommitted
// Bit 4 is the viewer's `holding`, i.e. locomotion actually pinned by a hold lease --
// `holdUntil > now && state is PATROL/SEEK/PURSUE` -- NOT the bare lease. A lease persists across
// transitions, so "lease live" would be nearly unconstrained and would not tell a trace reader
// whether the bot is standing still on purpose. The adapter must use the same conjunction.
export const LATCH_HOLD = 4;
export const LATCH_HEAL_FLEE = 8;   // bot-activity.js:63  healFleeCommitted
export const LATCH_SIGHT_GRACE = 16; // bot-activity.js:138 stepVisibleDebounce grace window
export const LATCH_MASK = 31;
export const LATCH_LIST = [
  [LATCH_FLEE, 'flee'], [LATCH_COVER, 'cover'], [LATCH_HOLD, 'held-in-place'],
  [LATCH_HEAL_FLEE, 'heal-flee'], [LATCH_SIGHT_GRACE, 'sight-grace'],
];
// Parsing map for encodeBotState's name-array form; 'hold' stays as a legacy alias for old traces.
export const LATCH_NAMES = { flee: LATCH_FLEE, cover: LATCH_COVER, 'held-in-place': LATCH_HOLD, hold: LATCH_HOLD, 'heal-flee': LATCH_HEAL_FLEE, 'sight-grace': LATCH_SIGHT_GRACE };

export const CODE_LENGTH = 9;
export const CORE_LENGTH = 5;
export const CORE_INDICES = [0, 1, 3, 4, 8]; // state, tier, role, element, latches

// Slot metadata, ordered; the single source for diffing and for decode field names.
export const SLOTS = [
  { index: 1, key: 'state', name: 'state', chars: STATE_CHARS },
  { index: 2, key: 'tier', name: 'alert tier', chars: TIER_CHARS },
  { index: 3, key: 'score', name: 'escalation score', chars: SCORE_CHARS },
  { index: 4, key: 'role', name: 'role', chars: ROLE_CHARS },
  { index: 5, key: 'element', name: 'push element', chars: ELEMENT_CHARS },
  { index: 6, key: 'ammo', name: 'ammo', chars: AMMO_CHARS },
  { index: 7, key: 'health', name: 'health', chars: HEALTH_CHARS },
  { index: 8, key: 'packs', name: 'packs', chars: PACK_CHARS },
  { index: 9, key: 'latches', name: 'latches', chars: LATCH_CHARS },
];

const DUTY_STATES = 'MT';  // medic-duty overrides of slot 1
const COVER_STATES = 'CG';

// ---- legality rules --------------------------------------------------------------------------
// Each entry is [id, predicate]; the predicate returns true when the combination is IMPOSSIBLE.
// Order matters: illegalReason reports the first match.
export const RULES = [
  // --- alert block -------------------------------------------------------------------
  ['score-zero-without-tier', c => '01'.includes(c.tier) && c.score !== '0'],          // viewer:5719
  ['wary-score-band',         c => c.tier === '2' && +c.score >= 2],                   // bot-alert.js:122
  ['defensive-score-band',    c => c.tier === '3' && +c.score < 2],                    // bot-alert.js:122
  ['push-score-band',         c => c.tier === '4' && +c.score < 4],                    // bot-alert.js:123
  ['element-requires-push',   c => (c.tier === '4') !== (c.elem !== '-')],             // viewer:5697
  // --- role / resources --------------------------------------------------------------
  ['duty-requires-medic',     c => DUTY_STATES.includes(c.fsm) && c.role !== 'm'],     // viewer:5852
  // NO duty-requires-resource / heal-needs-pack rules: entry into H/M/T does require the resource
  // (bot-activity.js:58, bot-medic.js:88,92), but the trace samples at COMMIT time -- the frame a
  // heal/tend completes has already consumed the last pack/kit while the state slot still says H/T.
  ['kit-medic-only',          c => c.role === 'r' && c.pack >= 'A'],                   // bot-roles.js:30
  ['rifleman-pack-cap',       c => c.role === 'r' && '34'.includes(c.pack)],           // bot-roles.js:29
  // --- weapon ------------------------------------------------------------------------
  // FIRE is DECIDED through `readyToFire` (no reload, mag > 0), but the commit samples after the
  // post-shot tail (A9): the emptying shot starts a reload or sidearm swap in the same frame, so
  // F legally reads R or 0 at commit. Only a truly absent weapon is impossible.
  ['fire-needs-weapon',       c => c.fsm === 'F' && c.ammo === '-'],
  // AIM only needs a gun: reloading holds AIM when no corner is free, and an empty mag with reserve
  // left keeps `fireCapable` true (`attackerOutOfAmmo` needs mag empty AND no reserve). Slot 6 '0'
  // encodes the magazine only, never the reserve.
  ['aim-needs-weapon',        c => c.fsm === 'A' && c.ammo === '-'],
  // Both cover rungs are gated on `fireCapable`, so C/G with an empty mag but reserve left is real.
  ['cover-needs-weapon',      c => COVER_STATES.includes(c.fsm) && c.ammo === '-'],
  // `knifeRequested` requires `attackerOutOfAmmo` (hence `primaryEmpty`) and `botReloadUntil == null`.
  ['knife-needs-dry',         c => c.fsm === 'K' && !'-0'.includes(c.ammo)],
  // --- commit latches: each is only read for its own state ----------------------------
  ['flee-latch-scope',        c => (c.bits & LATCH_FLEE) && c.fsm !== 'E'],            // bot-activity.js:74
  ['cover-latch-scope',       c => (c.bits & LATCH_COVER) && !COVER_STATES.includes(c.fsm)], // bot-activity.js:79
  ['healflee-latch-scope',    c => (c.bits & LATCH_HEAL_FLEE) && !'EH'.includes(c.fsm)], // bot-activity.js:63
  ['coverhold-needs-latch',   c => c.fsm === 'G' && !(c.bits & LATCH_COVER)],
  // viewer `holding` = holdUntil > now && (state is PATROL || SEEK || PURSUE); a lease is inert elsewhere.
  ['hold-latch-scope',        c => (c.bits & LATCH_HOLD) && !'PSU'.includes(c.fsm)],
  // NO sight-latch-scope rule: the ladder's debounced-visibility bit does keep a graced bot off
  // the PATROL rung, but slot 1 'P' is not only ladder-PATROL -- the muzzle-recovery 'reposition'
  // stamp and the 'alert' hold both encode as P (they bypass/override the ladder), and either can
  // commit while the grace window is open. Sight-grace on D is still banned by dead-collapses.
  // --- death collapses: the other slots are frozen leftovers, not state ---------------
  ['dead-collapses', c => c.fsm === 'D' && !(c.tier === '0' && c.score === '0'
      && c.elem === '-' && c.ammo === '-' && c.hp === '0' && c.bits === 0)],
];

// ---- quantization helpers (the viewer adapter's only bucketing) --------------------------------

function clampInt(v, lo, hi) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

// Health quintile char. Bands are (0,20%] (1) .. (80%,100%] (4) with dead/0 folded into band 0;
// ceil-based so a bot at exactly 20% reads as the bottom fifth, not the second.
export function healthBand(hp, maxHp = 100) {
  const max = Number(maxHp);
  const cur = Number(hp);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(cur) || cur <= 0) return '0';
  const band = Math.ceil((cur / max) * 5) - 1;
  return HEALTH_CHARS[band < 0 ? 0 : band > 4 ? 4 : band];
}

// Ammo slot char. Unarmed beats reloading beats empty; a nonzero mag never reads as empty
// (ceil-based bands), so slot '0' means a genuinely dry gun.
export function ammoSlot({ mag = 0, magazineSize = 0, reloading = false, hasWeapon = true } = {}) {
  if (!hasWeapon) return '-';
  if (reloading) return 'R';
  const rounds = Number(mag);
  if (!Number.isFinite(rounds) || rounds <= 0) return '0';
  const size = Number(magazineSize);
  if (!Number.isFinite(size) || size <= 0) return '4'; // unknown capacity: a loaded gun is "full"
  const band = Math.ceil((rounds / size) * 4);
  return AMMO_CHARS[2 + (band < 1 ? 1 : band > 4 ? 4 : band)];
}

// Pack slot char: 0-4 held packs, shifted into A-E when a fused revive kit is also carried.
export function packSlot(packCount, hasKit = false) {
  const n = clampInt(packCount, 0, 4);
  return hasKit ? PACK_CHARS[5 + n] : PACK_CHARS[n];
}

// Pack the five commit latches into a 5-bit mask.
export function latchBits({ flee = false, cover = false, hold = false, healFlee = false, sightGrace = false } = {}) {
  return (flee ? LATCH_FLEE : 0) | (cover ? LATCH_COVER : 0) | (hold ? LATCH_HOLD : 0)
    | (healFlee ? LATCH_HEAL_FLEE : 0) | (sightGrace ? LATCH_SIGHT_GRACE : 0);
}

// Base32 char for a latch mask, and its inverse.
export function latchChar(bits) { return LATCH_CHARS[clampInt(bits, 0, 31)]; }
export function latchNamesFromBits(bits) {
  const b = clampInt(bits, 0, 31);
  return LATCH_LIST.filter(([m]) => b & m).map(([, n]) => n);
}

// Alert tier char. `alertTierLast` is the viewer's null|'wary'|'defensive'|'push'; near-miss only
// registers when no tier is live (viewer:5882 already nulls it, but a live tier wins here too).
export function tierSlot(alertTierLast, nearMiss = false) {
  if (alertTierLast === 'push') return '4';
  if (alertTierLast === 'defensive') return '3';
  if (alertTierLast === 'wary') return '2';
  return nearMiss ? '1' : '0';
}

// ---- encode ------------------------------------------------------------------------------------

const STATE_BY_NAME = invert(STATE_NAMES);
const TIER_BY_NAME = invert(TIER_NAMES);
const ROLE_BY_NAME = invert(ROLE_NAMES);
const ELEMENT_BY_NAME = invert(ELEMENT_NAMES);

function invert(map) {
  const out = {};
  for (const k of Object.keys(map)) out[map[k]] = k;
  return out;
}

function fromChars(v, chars, byName, fallback) {
  if (typeof v === 'string') {
    if (v.length === 1 && chars.includes(v)) return v;
    if (byName && Object.prototype.hasOwnProperty.call(byName, v)) return byName[v];
  }
  return fallback;
}

// encodeBotState(desc) -> 9-char code. `desc` holds ALREADY-DISCRETIZED fields; nothing here
// quantizes a raw game value beyond clamping an integer into range. Every field is optional and
// defaults to the calm/idle/unarmed value, so a partial desc still encodes.
//   state    'patrol'|...|'dead' or its slot char        (default 'P')
//   tier     'calm'|...|'push', 0-4, its slot char, null (default '0')
//   score    integer 0-9 (clamped) or its slot char      (default '0')
//   role     'rifleman'|'medic' or 'r'|'m'               (default 'r')
//   element  null|'none'|'base-of-fire'|'moving' or char (default '-')
//   ammo     slot char from AMMO_CHARS (see ammoSlot)    (default '-')
//   health   integer 0-4 band (see healthBand) or char   (default '0')
//   packs    slot char, or an integer 0-4 combined with desc.hasKit (default '0')
//   hasKit   boolean, only read when `packs` is numeric
//   latches  bit mask, array of latch names, {flee,cover,...} flags, or a base32 char (default 0)
export function encodeBotState(desc = {}) {
  const d = desc || {};
  const state = fromChars(d.state, STATE_CHARS, STATE_BY_NAME, 'P');
  const tier = typeof d.tier === 'number' ? TIER_CHARS[clampInt(d.tier, 0, 4)]
    : fromChars(d.tier, TIER_CHARS, TIER_BY_NAME, '0');
  const score = typeof d.score === 'number' ? SCORE_CHARS[clampInt(d.score, 0, 9)]
    : fromChars(d.score, SCORE_CHARS, null, '0');
  const role = fromChars(d.role, ROLE_CHARS, ROLE_BY_NAME, 'r');
  const element = d.element == null ? '-' : fromChars(d.element, ELEMENT_CHARS, ELEMENT_BY_NAME, '-');
  const ammo = fromChars(d.ammo, AMMO_CHARS, null, '-');
  const health = typeof d.health === 'number' ? HEALTH_CHARS[clampInt(d.health, 0, 4)]
    : fromChars(d.health, HEALTH_CHARS, null, '0');
  const packs = typeof d.packs === 'number' ? packSlot(d.packs, !!d.hasKit)
    : fromChars(d.packs, PACK_CHARS, null, '0');
  return state + tier + score + role + element + ammo + health + packs + encodeLatchSlot(d.latches);
}

function encodeLatchSlot(v) {
  if (v == null) return '0';
  if (typeof v === 'number') return latchChar(v);
  if (typeof v === 'string') return v.length === 1 && LATCH_CHARS.includes(v) ? v : '0';
  if (Array.isArray(v)) return latchChar(v.reduce((b, n) => b | (LATCH_NAMES[n] || 0), 0));
  return latchChar(latchBits(v));
}

// ---- decode ------------------------------------------------------------------------------------

// Split a well-formed code into the raw shape the rule predicates read; null if malformed.
function slotsOf(code) {
  const c = typeof code === 'string' ? code : '';
  if (c.length !== CODE_LENGTH) return null;
  for (let i = 0; i < CODE_LENGTH; i++) if (!SLOTS[i].chars.includes(c[i])) return null;
  return { fsm: c[0], tier: c[1], score: c[2], role: c[3], elem: c[4], ammo: c[5], hp: c[6],
    pack: c[7], latch: c[8], bits: LATCH_CHARS.indexOf(c[8]) };
}

// decodeBotState(code) -> structured fields + resolved latch list, or null for a malformed code.
// Works on legal and illegal codes alike; check `legal`/`illegalReason` for the verdict.
export function decodeBotState(code) {
  const s = slotsOf(code);
  if (!s) return null;
  const packIndex = PACK_CHARS.indexOf(s.pack);
  const reason = illegalReason(code); // one rule scan feeds both fields
  return {
    code, core: coreCode(code),
    stateChar: s.fsm, state: STATE_NAMES[s.fsm], stateClass: STATE_CLASSES[s.fsm],
    tierChar: s.tier, tier: TIER_NAMES[s.tier],
    scoreChar: s.score, score: +s.score,
    roleChar: s.role, role: ROLE_NAMES[s.role],
    elementChar: s.elem, element: ELEMENT_NAMES[s.elem],
    ammoChar: s.ammo, ammo: AMMO_NAMES[s.ammo], ammoBand: '01234'.includes(s.ammo) ? +s.ammo : null,
    healthChar: s.hp, health: +s.hp, healthRange: HEALTH_NAMES[s.hp],
    packChar: s.pack, packs: packIndex % 5, hasKit: packIndex >= 5,
    latchChar: s.latch, latchBits: s.bits, latches: latchNamesFromBits(s.bits),
    legal: reason === null, illegalReason: reason,
  };
}

// coreCode(code) -> the 5-char behavioural-core projection (slots 1,2,4,5,9): what the bot is
// doing and why, with the resource levels that merely modulate it dropped.
export function coreCode(code) {
  const c = typeof code === 'string' ? code : '';
  if (c.length === CORE_LENGTH) return c;
  if (c.length !== CODE_LENGTH) return '';
  return c[0] + c[1] + c[3] + c[4] + c[8];
}

// ---- legality ------------------------------------------------------------------------------------

// illegalReason(code) -> id of the first rule violated, 'bad-length'/'bad-slot-<key>' for a
// malformed code, or null when the code is legal.
export function illegalReason(code) {
  const c = typeof code === 'string' ? code : '';
  if (c.length !== CODE_LENGTH) return 'bad-length';
  for (let i = 0; i < CODE_LENGTH; i++) if (!SLOTS[i].chars.includes(c[i])) return `bad-slot-${SLOTS[i].key}`;
  const s = slotsOf(c);
  for (const [id, pred] of RULES) if (pred(s)) return id;
  return null;
}

export function isLegalCode(code) { return illegalReason(code) === null; }

// ---- reading ------------------------------------------------------------------------------------

const DOING = {
  P: 'walking its patrol ring', S: 'moving on a last-known position', U: 'closing on a visible target',
  E: 'retreating', H: 'holding still to heal', K: 'committed to a melee strike',
  A: 'slewing onto the target', F: 'shooting', C: 'breaking for a cover corner',
  G: 'holding a cover anchor', M: 'moving to a wounded or fallen ally',
  T: 'channelling a heal or revive', D: 'down',
};

// describeBotState(code) -> one-line English reading, composed from the core slots only (a 9-char
// or 5-char code both work; the resource slots deliberately don't appear in the prose).
export function describeBotState(code) {
  const c = coreCode(code);
  if (c.length !== CORE_LENGTH) return '';
  const [fsm, tier, role, elem, latchCh] = c;
  return glossParts(fsm, tier, role, elem, latchNamesFromBits(LATCH_CHARS.indexOf(latchCh)));
}

function glossParts(fsm, tier, role, elem, latches) {
  const alert = tier === '0' ? '' : tier === '1' ? ', after a round whistled past'
    : tier === '2' ? ', on a fresh wary call-out' : tier === '3' ? ', under a defensive squad alert'
    : `, in a squad push as the ${ELEMENT_NAMES[elem]} element`;
  const latch = latches.length ? ` [${latches.join('+')} latched]` : '';
  return `${role === 'm' ? 'Medic' : 'Rifleman'} ${DOING[fsm]}${alert}${latch}.`;
}

// ---- enumeration ------------------------------------------------------------------------------

let _legalCache = null;
let _coreCache = null;

// enumerateLegalCodes() -> every legal 9-char code (354,013 of 43,680,000 raw products).
// Cached and shared across calls: treat the returned array as read-only.
export function enumerateLegalCodes() {
  if (_legalCache) return _legalCache;
  const out = [];
  const c = { fsm: '', tier: '', score: '', role: '', elem: '', ammo: '', hp: '', pack: '', latch: '', bits: 0 };
  for (const fsm of STATE_CHARS) { c.fsm = fsm;
  for (const tier of TIER_CHARS) { c.tier = tier;
  for (const score of SCORE_CHARS) { c.score = score;
  for (const role of ROLE_CHARS) { c.role = role;
  for (const elem of ELEMENT_CHARS) { c.elem = elem;
  for (const ammo of AMMO_CHARS) { c.ammo = ammo;
  for (const hp of HEALTH_CHARS) { c.hp = hp;
  for (const pack of PACK_CHARS) { c.pack = pack;
  for (let bits = 0; bits < 32; bits++) {
    c.bits = bits; c.latch = LATCH_CHARS[bits];
    let bad = false;
    for (let i = 0; i < RULES.length; i++) if (RULES[i][1](c)) { bad = true; break; }
    if (!bad) out.push(fsm + tier + score + role + elem + ammo + hp + pack + c.latch);
  } } } } } } } } }
  _legalCache = out;
  return out;
}

// enumerateCoreStates() -> the 434 behavioural-core rows the reference table is generated from,
// ordered by state, then tier, medic-before-rifleman, element, latch mask.
// Row: { n, code, state, class, tier, role, element, latches, fullCodes, reading }.
export function enumerateCoreStates() {
  if (_coreCache) return _coreCache;
  const expand = new Map();
  for (const full of enumerateLegalCodes()) {
    const k = coreCode(full);
    expand.set(k, (expand.get(k) ?? 0) + 1);
  }
  const rows = [...expand.keys()].map(code => {
    const [fsm, tier, role, elem, latchCh] = code;
    const bits = LATCH_CHARS.indexOf(latchCh);
    return { code, fsm, tier, role, elem, bits, latches: latchNamesFromBits(bits), fullCodes: expand.get(code) };
  });
  rows.sort((a, b) => STATE_CHARS.indexOf(a.fsm) - STATE_CHARS.indexOf(b.fsm)
    || a.tier.localeCompare(b.tier) || b.role.localeCompare(a.role)
    || a.elem.localeCompare(b.elem) || a.bits - b.bits);
  _coreCache = rows.map((r, i) => ({
    n: i + 1, code: r.code, state: STATE_NAMES[r.fsm], class: STATE_CLASSES[r.fsm],
    tier: TIER_NAMES[r.tier], role: ROLE_NAMES[r.role], element: ELEMENT_NAMES[r.elem],
    latches: r.latches, fullCodes: r.fullCodes,
    reading: glossParts(r.fsm, r.tier, r.role, r.elem, r.latches),
  }));
  return _coreCache;
}

// ---- diff ----------------------------------------------------------------------------------------

const SLOT_LABEL = [
  ch => STATE_NAMES[ch], ch => TIER_NAMES[ch], ch => ch, ch => ROLE_NAMES[ch],
  ch => ELEMENT_NAMES[ch], ch => AMMO_NAMES[ch], ch => HEALTH_NAMES[ch],
  ch => `${PACK_CHARS.indexOf(ch) % 5} pack(s)${PACK_CHARS.indexOf(ch) >= 5 ? ' + kit' : ''}`,
  ch => latchNamesFromBits(LATCH_CHARS.indexOf(ch)).join('+') || 'none',
];

// diffCodes(a, b) -> [{ slot, key, name, from, to, fromLabel, toLabel }] for changed slots only;
// this is the per-transition row a trace viewer renders. Returns [] for equal or malformed input.
export function diffCodes(a, b) {
  const x = typeof a === 'string' ? a : '';
  const y = typeof b === 'string' ? b : '';
  if (x.length !== CODE_LENGTH || y.length !== CODE_LENGTH) return [];
  const out = [];
  for (let i = 0; i < CODE_LENGTH; i++) {
    if (x[i] === y[i]) continue;
    const s = SLOTS[i];
    out.push({ slot: s.index, key: s.key, name: s.name, from: x[i], to: y[i],
      fromLabel: SLOT_LABEL[i](x[i]), toLabel: SLOT_LABEL[i](y[i]) });
  }
  return out;
}

// Just the changed slot keys, '+'-joined. Allocates one string where diffCodes allocates a labelled
// object per slot, so this is the form the per-frame trace recorder uses.
export function changedSlots(a, b) {
  const x = typeof a === 'string' ? a : '';
  const y = typeof b === 'string' ? b : '';
  if (x.length !== CODE_LENGTH || y.length !== CODE_LENGTH) return '';
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    if (x[i] === y[i]) continue;
    out += (out ? '+' : '') + SLOTS[i].key;
  }
  return out;
}
