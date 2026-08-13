// Node tests for bot-state-code.js (9-slot discrete bot state code: encode/decode/legality/diff).
// Run: node test-bot-state-code.mjs
import {
  STATE_CHARS, TIER_CHARS, SCORE_CHARS, ROLE_CHARS, ELEMENT_CHARS, AMMO_CHARS, HEALTH_CHARS,
  PACK_CHARS, LATCH_CHARS, STATE_NAMES, STATE_CLASSES, TIER_NAMES,
  LATCH_FLEE, LATCH_COVER, LATCH_HOLD, LATCH_HEAL_FLEE, LATCH_SIGHT_GRACE, LATCH_LIST, LATCH_MASK,
  SLOTS, RULES, CODE_LENGTH, CORE_LENGTH,
  encodeBotState, decodeBotState, coreCode, describeBotState,
  isLegalCode, illegalReason, enumerateLegalCodes, enumerateCoreStates, diffCodes, changedSlots,
  healthBand, ammoSlot, packSlot, latchBits, latchChar, latchNamesFromBits, tierSlot,
} from './bot-state-code.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// Build a code from named slots so no assertion depends on counting dashes in a literal.
const C = (fsm, tier, score, role, elem, ammo, hp, pack, latch) =>
  fsm + tier + score + role + elem + ammo + hp + pack + latch;
const ARMED_PATROL = C('P', '0', '0', 'r', '-', '1', '0', '0', '0'); // the plainest legal code

// ---- alphabets ---------------------------------------------------------------------------------
ok(STATE_CHARS.length === 13, '13 slot-1 states (11 ladder states + 2 medic-duty overrides)');
ok(new Set(STATE_CHARS).size === 13, 'state chars are distinct');
ok([...STATE_CHARS].every(c => STATE_NAMES[c] && STATE_CLASSES[c]), 'every state char has a name and a class');
ok([...TIER_CHARS].every(c => TIER_NAMES[c]), 'every tier char has a name');
ok(LATCH_CHARS.length === 32 && LATCH_CHARS[0] === '0' && LATCH_CHARS[31] === 'V', 'latch alphabet is base32 0..V');
ok(PACK_CHARS === '01234ABCDE', 'pack alphabet mirrors 0-4 into A-E for the kit flag');
ok(SLOTS.length === CODE_LENGTH && SLOTS.map(s => s.index).join('') === '123456789', 'SLOTS covers all nine positions in order');
ok(LATCH_MASK === (LATCH_FLEE | LATCH_COVER | LATCH_HOLD | LATCH_HEAL_FLEE | LATCH_SIGHT_GRACE), 'LATCH_MASK is the OR of the five bits');
ok(RULES.length === 18, `18 legality rules (got ${RULES.length})`);
ok(new Set(RULES.map(r => r[0])).size === RULES.length, 'rule ids are unique');
ok(isLegalCode(ARMED_PATROL), 'the baseline armed patrolling rifleman is legal');

// ---- encode: defaults and partial descs ----------------------------------------------------------
{
  const IDLE = C('P', '0', '0', 'r', '-', '-', '0', '0', '0');
  ok(encodeBotState() === IDLE, 'a wholly missing desc encodes the calm idle unarmed rifleman');
  ok(encodeBotState({}) === IDLE, 'an empty desc matches the no-arg default');
  ok(encodeBotState(null) === IDLE, 'a null desc is tolerated');
  ok(encodeBotState({ state: 'fire' }).length === CODE_LENGTH, 'a one-field desc still yields a 9-char code');
  ok(encodeBotState({ state: 'fire' }) === C('F', '0', '0', 'r', '-', '-', '0', '0', '0'), 'a partial desc fills only the slot it names');
  ok(encodeBotState({ state: 'sprinting', tier: 'panicked', role: 'sniper', ammo: 'Z', latches: 'zzz' }) === IDLE,
    'junk field values fall back to defaults rather than emitting off-alphabet chars');
}

// ---- encode: long names, slot chars and numbers all accepted --------------------------------------
{
  ok(encodeBotState({ state: 'cover-hold' })[0] === 'G', 'a long state name maps to its char');
  ok(encodeBotState({ state: 'G' })[0] === 'G', 'a slot char passes through unchanged');
  ok(encodeBotState({ state: 'medic-tend' })[0] === 'T', 'medic duty is a slot-1 value, not a separate axis');
  ok(encodeBotState({ tier: 'defensive' })[1] === '3', 'a tier name maps to its char');
  ok(encodeBotState({ tier: 4 })[1] === '4', 'a numeric tier maps to its char');
  ok(encodeBotState({ tier: null })[1] === '0', 'a null tier (no live alert) is calm');
  ok(encodeBotState({ score: 7 })[2] === '7', 'a numeric score maps to its char');
  ok(encodeBotState({ score: 42 })[2] === '9' && encodeBotState({ score: -3 })[2] === '0', 'score clamps into 0-9');
  ok(encodeBotState({ role: 'medic' })[3] === 'm', 'a role name maps to its char');
  ok(encodeBotState({ element: 'base-of-fire' })[4] === 'b', 'an element name maps to its char');
  ok(encodeBotState({ element: null })[4] === '-' && encodeBotState({ element: 'none' })[4] === '-', 'null and "none" are both the empty element');
  ok(encodeBotState({ ammo: 'R' })[5] === 'R', 'an ammo slot char passes through');
  ok(encodeBotState({ health: 3 })[6] === '3', 'a numeric health band maps to its char');
  ok(encodeBotState({ health: 9 })[6] === '4' && encodeBotState({ health: -1 })[6] === '0', 'health band clamps into 0-4');
  ok(encodeBotState({ packs: 2 })[7] === '2', 'a numeric pack count maps to its char');
  ok(encodeBotState({ packs: 2, hasKit: true })[7] === 'C', 'a numeric pack count plus hasKit shifts into A-E');
  ok(encodeBotState({ packs: 'C' })[7] === 'C', 'a pack char passes through (hasKit is only read for numbers)');
  ok(encodeBotState({ packs: 9, hasKit: true })[7] === 'E', 'the pack count clamps before the kit shift');
}

// ---- encode: latches in every accepted form ---------------------------------------------------------
{
  ok(encodeBotState({ latches: 0 })[8] === '0', 'no latches is base32 0');
  ok(encodeBotState({ latches: LATCH_COVER | LATCH_HOLD })[8] === '6', 'a bit mask encodes to its base32 char');
  ok(encodeBotState({ latches: ['cover', 'held-in-place'] })[8] === '6', 'an array of latch names encodes to the same char');
  ok(encodeBotState({ latches: ['cover', 'hold'] })[8] === '6', "'hold' still parses as a legacy alias for 'held-in-place'");
  ok(encodeBotState({ latches: { cover: true, hold: true } })[8] === '6', 'a flags object encodes to the same char');
  ok(encodeBotState({ latches: '6' })[8] === '6', 'a base32 char passes through');
  ok(encodeBotState({ latches: 31 })[8] === 'V', 'all five latches is base32 V');
  ok(encodeBotState({ latches: ['nonsense'] })[8] === '0', 'unknown latch names contribute no bits');
}

// ---- encode/decode round-trip ------------------------------------------------------------------------
{
  const descs = [
    {},
    { state: 'patrol' },
    { state: 'fire', tier: 'push', score: 6, role: 'rifleman', element: 'moving', ammo: '3', health: 4, packs: 1 },
    { state: 'pursue', tier: 'push', score: 6, role: 'rifleman', element: 'base-of-fire', ammo: '3', health: 4, packs: 1, latches: ['held-in-place'] },
    { state: 'cover-hold', tier: 'defensive', score: 2, role: 'rifleman', element: null, ammo: '2', health: 2, packs: 0, latches: { cover: true } },
    { state: 'medic-tend', tier: 'wary', score: 1, role: 'medic', ammo: '4', health: 3, packs: 2, hasKit: true },
    { state: 'heal', tier: 'near-miss', role: 'medic', ammo: 'R', health: 0, packs: 4, latches: { healFlee: true } },
    { state: 'flee', role: 'rifleman', ammo: '0', health: 1, packs: 1, latches: { flee: true, healFlee: true, sightGrace: true } },
    { state: 'dead' },
  ];
  for (const desc of descs) {
    const code = encodeBotState(desc);
    const label = JSON.stringify(desc);
    ok(code.length === CODE_LENGTH, `encode yields 9 chars for ${label}`);
    const d = decodeBotState(code);
    ok(d !== null, `decode accepts the code just encoded from ${label}`);
    ok(d.code === code && d.core === coreCode(code), `decode carries the code and its core (${code})`);
    const again = encodeBotState({
      state: d.stateChar, tier: d.tierChar, score: d.score, role: d.roleChar, element: d.elementChar,
      ammo: d.ammoChar, health: d.health, packs: d.packChar, latches: d.latchBits,
    });
    ok(again === code, `re-encoding a decoded code reproduces it (${code} -> ${again})`);
  }
}

// ---- decode: field resolution --------------------------------------------------------------------------
{
  const d = decodeBotState(C('F', '4', '4', 'm', 'm', '2', '4', 'B', '0'));
  ok(d.state === 'fire' && d.stateClass === 'engage', 'decode resolves the state name and class');
  ok(d.tier === 'push' && d.score === 4, 'decode resolves the tier name and numeric score');
  ok(d.role === 'medic' && d.element === 'moving', 'decode resolves the role and push element');
  ok(d.ammoBand === 2 && d.health === 4, 'decode resolves the ammo band and health band');
  ok(d.packs === 1 && d.hasKit === true, "decode splits 'B' into 1 pack plus a revive kit");
  ok(Array.isArray(d.latches) && d.latches.length === 0, 'no latches decodes to an empty list');
  ok(d.legal === true && d.illegalReason === null, 'decode carries the legality verdict');

  const l = decodeBotState(C('E', '0', '0', 'r', '-', '-', '0', '1', 'V'));
  ok(l.latchBits === 31, 'base32 V decodes to all five bits');
  ok(l.latches.join('+') === 'flee+cover+held-in-place+heal-flee+sight-grace', 'the latch list resolves in bit order');
  ok(l.legal === false, 'decode reports an illegal code as illegal rather than refusing it');
  ok(decodeBotState(C('P', '0', '0', 'r', '-', '-', '0', '0', '')) === null, 'a short code decodes to null');
  ok(decodeBotState(C('Z', '0', '0', 'r', '-', '-', '0', '0', '0')) === null, 'an off-alphabet state char decodes to null');
  ok(decodeBotState(C('P', '0', '0', 'r', '-', '-', '0', '0', 'W')) === null, 'an off-alphabet latch char decodes to null');
  ok(decodeBotState(undefined) === null, 'a missing code decodes to null');
}

// ---- coreCode ---------------------------------------------------------------------------------------
{
  const full = C('F', '4', '3', 'r', 'm', '2', '4', '0', 'A');
  ok(coreCode(full) === 'F4rmA', 'core keeps slots 1,2,4,5,9');
  ok(coreCode(full).length === CORE_LENGTH, 'core is 5 chars');
  ok(coreCode('F4rmA') === 'F4rmA', 'an already-core code passes through');
  ok(coreCode('nope') === '' && coreCode(null) === '', 'a malformed code has no core');
  ok(coreCode(full) === coreCode(C('F', '4', '9', 'r', 'm', '4', '1', '0', 'A')), 'score/ammo/health/packs sit outside the core');
}

// ---- describeBotState ------------------------------------------------------------------------------
{
  ok(describeBotState(C('P', '0', '0', 'r', '-', '-', '0', '0', '0')) === 'Rifleman walking its patrol ring.', 'calm patrol reads plainly');
  ok(describeBotState(C('T', '2', '0', 'm', '-', '4', '4', 'C', '0')) === 'Medic channelling a heal or revive, on a fresh wary call-out.', 'medic tend under a wary call-out reads correctly');
  const push = describeBotState(C('U', '4', '4', 'r', 'b', '3', '4', '0', 'K'));
  ok(push.includes('in a squad push as the base-of-fire element'), 'the push tier names the element');
  ok(push.includes('[held-in-place+sight-grace latched]'), 'latched commits are appended');
  ok(isLegalCode(C('U', '4', '4', 'r', 'b', '3', '4', '0', 'K')), 'the described push code is a real state');
  ok(describeBotState(C('E', '0', '0', 'r', '-', '-', '0', '1', '1')) === 'Rifleman retreating [flee latched].', 'a single latch reads without a tier clause');
  ok(describeBotState(C('P', '1', '0', 'r', '-', '-', '0', '0', '0')).includes('after a round whistled past'), 'the near-miss tier has its own clause');
  ok(describeBotState(C('P', '3', '2', 'r', '-', '-', '0', '0', '0')).includes('under a defensive squad alert'), 'the defensive tier has its own clause');
  ok(describeBotState(C('T', '2', '0', 'm', '-', '4', '4', 'C', '0')) === describeBotState('T2m-0'), 'a core code reads identically to its full code');
  ok(describeBotState('junk') === '' && describeBotState(null) === '', 'a malformed code has no reading');
}

// ---- legality: rule scoping ---------------------------------------------------------------------------
{
  // commit latches are only read for the state that sets them
  ok(isLegalCode(C('C', '0', '0', 'r', '-', '1', '0', '0', '2')), 'cover-move with the cover latch is legal');
  ok(illegalReason(C('P', '0', '0', 'r', '-', '1', '0', '0', '2')) === 'cover-latch-scope', 'a cover latch on patrol is illegal');
  ok(illegalReason(C('F', '0', '0', 'r', '-', '1', '0', '0', '2')) === 'cover-latch-scope', 'a cover latch while firing is illegal');
  ok(illegalReason(C('G', '0', '0', 'r', '-', '1', '0', '0', '0')) === 'coverhold-needs-latch', 'cover-hold without its cover latch is illegal');
  ok(illegalReason(C('P', '0', '0', 'r', '-', '1', '0', '0', '1')) === 'flee-latch-scope', 'the flee latch only exists in flee');
  ok(illegalReason(C('U', '0', '0', 'r', '-', '1', '0', '0', '8')) === 'healflee-latch-scope', 'the heal-flee latch only exists in flee/heal');
  ok(isLegalCode(C('E', '0', '0', 'r', '-', '1', '0', '0', '8')), 'heal-flee latched while fleeing is legal');
  // bit 4 is the viewer's `holding` (locomotion actually pinned), not a bare hold lease
  ok(isLegalCode(C('P', '0', '0', 'r', '-', '1', '0', '0', '4')), 'a held-in-place patroller is legal');
  ok(isLegalCode(C('S', '0', '0', 'r', '-', '1', '0', '0', '4')) && isLegalCode(C('U', '0', '0', 'r', '-', '1', '0', '0', '4')), 'seek and pursue can also be pinned in place');
  ok(illegalReason(C('F', '0', '0', 'r', '-', '1', '0', '0', '4')) === 'hold-latch-scope', 'a firing bot is already stationary, so the hold bit never sets');
  ok(illegalReason(C('G', '0', '0', 'r', '-', '1', '0', '0', '6')) === 'hold-latch-scope', 'cover-hold pins itself; a hold lease does not apply');
  ok(illegalReason(C('U', '4', '4', 'r', 'b', '1', '0', '0', '4')) === null, 'a base-of-fire pursuer can be pinned');
  ok(illegalReason(C('F', '4', '4', 'r', 'b', '1', '0', '0', '4')) === 'hold-latch-scope', 'the base-of-fire element alone no longer licenses the hold bit');
  // sweep every state: wherever the code is otherwise legal, the hold bit is what decides it
  for (const s of STATE_CHARS) {
    const bare = C(s, '0', '0', 'm', '-', '1', '0', '1', '0');
    const held = C(s, '0', '0', 'm', '-', '1', '0', '1', '4');
    if (illegalReason(bare) !== null) continue; // ruled out for an unrelated reason
    ok(illegalReason(held) === ('PSU'.includes(s) ? null : 'hold-latch-scope'),
      `the hold bit is legal in ${s} only if it is patrol/seek/pursue (got ${illegalReason(held)})`);
  }
  ok(isLegalCode(C('P', '0', '0', 'r', '-', '1', '0', '0', 'G')),
    'sight-grace can ride P: reposition and alert-hold frames encode as patrol with the grace open');

  // medic duty is a role-gated value of slot 1, not a parallel slot
  ok(isLegalCode(C('M', '0', '0', 'm', '-', '1', '0', '1', '0')), 'a medic with a pack can be in medic-move');
  ok(illegalReason(C('M', '0', '0', 'r', '-', '1', '0', '1', '0')) === 'duty-requires-medic', 'medic-move on a rifleman is illegal');
  ok(illegalReason(C('T', '0', '0', 'r', '-', '1', '0', '1', '0')) === 'duty-requires-medic', 'medic-tend on a rifleman is illegal');
  ok(isLegalCode(C('M', '0', '0', 'm', '-', '1', '0', '0', '0')),
    'medic duty with empty hands is legal at commit time: the completing tend spent the last pack this frame');

  // heal ENTRY needs a pack, but the commit-time frame that completes a heal has already eaten it
  ok(isLegalCode(C('H', '0', '0', 'r', '-', '1', '0', '1', '0')), 'heal with one pack is legal');
  ok(isLegalCode(C('H', '0', '0', 'r', '-', '1', '0', '0', '0')), 'heal with no packs is legal (consuming frame)');
  ok(isLegalCode(C('H', '0', '0', 'm', '-', '1', '0', 'A', '0')), 'heal holding only a revive kit is legal (consuming frame)');

  // alert block
  ok(illegalReason(C('P', '0', '1', 'r', '-', '1', '0', '0', '0')) === 'score-zero-without-tier', 'a calm bot cannot carry an escalation score');
  ok(illegalReason(C('P', '2', '2', 'r', '-', '1', '0', '0', '0')) === 'wary-score-band', 'wary caps below the defensive score');
  ok(illegalReason(C('P', '3', '1', 'r', '-', '1', '0', '0', '0')) === 'defensive-score-band', 'defensive needs at least score 2');
  ok(illegalReason(C('P', '4', '3', 'r', 'b', '1', '0', '0', '0')) === 'push-score-band', 'push needs at least score 4');
  ok(illegalReason(C('P', '4', '4', 'r', '-', '1', '0', '0', '0')) === 'element-requires-push', 'a push without an element is illegal');
  ok(illegalReason(C('P', '0', '0', 'r', 'b', '1', '0', '0', '0')) === 'element-requires-push', 'an element without a push is illegal');
  ok(isLegalCode(C('P', '4', '4', 'r', 'b', '1', '0', '0', '0')), 'a push with an element and a qualifying score is legal');

  // role resource caps
  ok(illegalReason(C('P', '0', '0', 'r', '-', '1', '0', 'A', '0')) === 'kit-medic-only', 'only a medic fuses a revive kit');
  ok(illegalReason(C('P', '0', '0', 'r', '-', '1', '0', '3', '0')) === 'rifleman-pack-cap', 'a rifleman cannot hold more than 2 packs');
  ok(isLegalCode(C('P', '0', '0', 'm', '-', '1', '0', '3', '0')), 'a medic can hold 3 packs');

  // weapon slots: FIRE goes through readyToFire (mag > 0 and not reloading); AIM only needs a gun,
  // because an empty mag with reserve left keeps fireCapable true and reloading holds AIM.
  ok(isLegalCode(C('F', '0', '0', 'r', '-', 'R', '0', '0', '0')), 'FIRE with R is legal: the emptying shot starts a reload in the same frame (A9 tail)');
  ok(isLegalCode(C('F', '0', '0', 'r', '-', '0', '0', '0', '0')), 'FIRE with an empty mag is legal: the commit samples after the emptying shot');
  ok(illegalReason(C('F', '0', '0', 'r', '-', '-', '0', '0', '0')) === 'fire-needs-weapon', 'firing unarmed is still illegal');
  ok(isLegalCode(C('F', '0', '0', 'r', '-', '1', '0', '0', '0')), 'firing on a loaded mag is legal');
  ok(illegalReason(C('A', '0', '0', 'r', '-', '-', '0', '0', '0')) === 'aim-needs-weapon', 'aiming with no weapon at all is illegal');
  ok(isLegalCode(C('A', '0', '0', 'r', '-', 'R', '0', '0', '0')), 'a reloading bot with no free corner holds AIM (bot-activity ladder)');
  ok(isLegalCode(C('A', '0', '0', 'r', '-', '0', '0', '0', '0')), 'an empty mag with reserve left still aims (slot 6 encodes the mag only)');
  ok(illegalReason(C('C', '0', '0', 'r', '-', '-', '0', '0', '2')) === 'cover-needs-weapon', 'an unarmed bot never takes cover');
  ok(isLegalCode(C('C', '0', '0', 'r', '-', '0', '0', '0', '2')), 'an empty mag with reserve left can still take cover');
  ok(illegalReason(C('K', '0', '0', 'r', '-', 'R', '0', '0', '0')) === 'knife-needs-dry', 'a knifing bot is not also reloading');
  ok(illegalReason(C('K', '0', '0', 'r', '-', '2', '0', '0', '0')) === 'knife-needs-dry', 'knifing requires attackerOutOfAmmo, so rounds in the mag rule it out');
  ok(isLegalCode(C('K', '0', '0', 'r', '-', '0', '0', '0', '0')) && isLegalCode(C('K', '0', '0', 'r', '-', '-', '0', '0', '0')), 'knifing is legal only on a dry or absent primary');

  // death collapses the rest of the code
  ok(isLegalCode(C('D', '0', '0', 'r', '-', '-', '0', '0', '0')), 'the collapsed dead code is legal');
  ok(illegalReason(C('D', '0', '0', 'r', '-', '1', '0', '0', '0')) === 'dead-collapses', 'a dead bot cannot still have ammo');
  ok(illegalReason(C('D', '0', '0', 'r', '-', '-', '1', '0', '0')) === 'dead-collapses', 'a dead bot cannot still have health');

  // malformed input
  ok(illegalReason(C('P', '0', '0', 'r', '-', '-', '0', '0', '')) === 'bad-length', 'a short code reports bad-length');
  ok(illegalReason('') === 'bad-length' && illegalReason(null) === 'bad-length', 'an empty or missing code reports bad-length');
  ok(illegalReason(C('Q', '0', '0', 'r', '-', '1', '0', '0', '0')) === 'bad-slot-state', 'an off-alphabet state reports its slot');
  ok(illegalReason(C('P', '0', '0', 'x', '-', '1', '0', '0', '0')) === 'bad-slot-role', 'an off-alphabet role reports its slot');
  ok(isLegalCode('nope') === false, 'isLegalCode is false for malformed input');
}

// ---- quantization: healthBand -------------------------------------------------------------------------
{
  ok(healthBand(0, 100) === '0', 'dead is health band 0');
  ok(healthBand(-5, 100) === '0', 'overkill damage clamps to band 0');
  ok(healthBand(1, 100) === '0', 'a sliver of health is still band 0');
  ok(healthBand(20, 100) === '0', 'exactly 20% is the bottom quintile (ceil banding)');
  ok(healthBand(20.01, 100) === '1', 'just over 20% enters band 1');
  ok(healthBand(40, 100) === '1' && healthBand(40.01, 100) === '2', 'the 40% boundary sits in the lower band');
  ok(healthBand(60, 100) === '2' && healthBand(80, 100) === '3', 'the 60% and 80% boundaries sit in the lower band');
  ok(healthBand(100, 100) === '4' && healthBand(150, 100) === '4', 'full health and overheal are band 4');
  ok(healthBand(50, 200) === '1', 'the band is a fraction of maxHp, not an absolute');
  ok(healthBand(50) === '2', 'maxHp defaults to 100');
  ok(healthBand(50, 0) === '0', 'a zero maxHp cannot produce a band');
  for (const bad of [undefined, null, NaN, 'half']) ok(healthBand(bad, 100) === '0', `junk hp ${String(bad)} reads as band 0`);
  ok([...HEALTH_CHARS].every(c => HEALTH_CHARS.includes(healthBand(+c * 20 + 5, 100))), 'every health band char stays in the alphabet');
}

// ---- quantization: ammoSlot -----------------------------------------------------------------------------
{
  ok(ammoSlot({ hasWeapon: false }) === '-', 'no weapon is unarmed');
  ok(ammoSlot({ hasWeapon: false, mag: 30, magazineSize: 30 }) === '-', 'unarmed wins over a stale mag count');
  ok(ammoSlot({ hasWeapon: false, reloading: true }) === '-', 'unarmed wins over reloading');
  ok(ammoSlot({ reloading: true, mag: 12, magazineSize: 30 }) === 'R', 'reloading wins over the mag band');
  ok(ammoSlot({ mag: 0, magazineSize: 30 }) === '0', 'an empty mag is slot 0');
  ok(ammoSlot({ mag: 1, magazineSize: 30 }) === '1', 'one round is band 1, never empty');
  ok(ammoSlot({ mag: 7.5, magazineSize: 30 }) === '1' && ammoSlot({ mag: 8, magazineSize: 30 }) === '2', 'exactly 25% is band 1, just over enters band 2');
  ok(ammoSlot({ mag: 15, magazineSize: 30 }) === '2' && ammoSlot({ mag: 16, magazineSize: 30 }) === '3', 'exactly 50% is band 2, just over enters band 3');
  ok(ammoSlot({ mag: 30, magazineSize: 30 }) === '4' && ammoSlot({ mag: 40, magazineSize: 30 }) === '4', 'a full or over-full mag is band 4');
  ok(ammoSlot({ mag: 5 }) === '4', 'an unknown magazine size treats a loaded gun as full');
  ok(ammoSlot() === '0', 'a no-arg call is an armed, empty gun');
  ok(ammoSlot({ mag: -3, magazineSize: 30 }) === '0', 'a negative mag reads as empty');
  for (const bad of [undefined, null, NaN, 'lots']) ok(AMMO_CHARS.includes(ammoSlot({ mag: bad, magazineSize: 30 })), `junk mag ${String(bad)} stays in the alphabet`);
}

// ---- quantization: packSlot ------------------------------------------------------------------------------
{
  ok(packSlot(0) === '0' && packSlot(4) === '4', 'plain pack counts map straight through');
  ok(packSlot(0, true) === 'A' && packSlot(4, true) === 'E', 'the kit flag shifts the same count into A-E');
  ok(packSlot(2, true) === 'C', 'A-E preserves the count offset');
  ok(packSlot(9) === '4' && packSlot(-2) === '0', 'pack counts clamp into 0-4');
  ok(packSlot(9, true) === 'E', 'the clamp happens before the kit shift');
  ok(packSlot(undefined) === '0' && packSlot(NaN) === '0', 'a junk count reads as no packs');
  ok(PACK_CHARS.indexOf(packSlot(3, true)) - 5 === 3, 'the A-E index recovers the count');
}

// ---- quantization: latchBits / latchChar / latchNamesFromBits ------------------------------------------------
{
  ok(latchBits() === 0, 'no flags packs to 0');
  ok(latchBits({ flee: true }) === LATCH_FLEE, 'flee is bit 1');
  ok(latchBits({ cover: true }) === LATCH_COVER, 'cover is bit 2');
  ok(latchBits({ hold: true }) === LATCH_HOLD, 'hold is bit 4');
  ok(latchBits({ healFlee: true }) === LATCH_HEAL_FLEE, 'heal-flee is bit 8');
  ok(latchBits({ sightGrace: true }) === LATCH_SIGHT_GRACE, 'sight-grace is bit 16');
  ok(latchBits({ flee: true, cover: true, hold: true, healFlee: true, sightGrace: true }) === 31, 'all five flags pack to 31');
  ok(latchBits({ flee: 1, cover: 0 }) === LATCH_FLEE, 'truthy/falsy values work like booleans');
  for (let b = 0; b < 32; b++) {
    const ch = latchChar(b);
    ok(LATCH_CHARS.indexOf(ch) === b, `latchChar(${b}) round-trips through the base32 alphabet`);
    ok(latchNamesFromBits(b).length === LATCH_LIST.filter(([m]) => b & m).length, `bits ${b} resolve to the right number of latch names`);
    const flags = { flee: !!(b & 1), cover: !!(b & 2), hold: !!(b & 4), healFlee: !!(b & 8), sightGrace: !!(b & 16) };
    ok(latchBits(flags) === b, `flags round-trip back to bits ${b}`);
  }
  ok(latchChar(99) === 'V' && latchChar(-1) === '0', 'out-of-range masks clamp into the alphabet');
  ok(latchNamesFromBits(0).length === 0, 'zero bits resolve to no latches');
}

// ---- quantization: tierSlot ---------------------------------------------------------------------------------
{
  ok(tierSlot(null, false) === '0', 'no tier and no near miss is calm');
  ok(tierSlot(null) === '0', 'nearMiss defaults to false');
  ok(tierSlot(null, true) === '1', 'a near miss with no live tier is tier 1');
  ok(tierSlot('wary', false) === '2', 'wary is tier 2');
  ok(tierSlot('defensive', false) === '3', 'defensive is tier 3');
  ok(tierSlot('push', false) === '4', 'push is tier 4');
  ok(tierSlot('wary', true) === '2', 'a live tier outranks a near miss (viewer:5882 already nulls it)');
  ok(tierSlot(undefined, false) === '0' && tierSlot('nonsense', false) === '0', 'an unset or unknown tier reads as calm');
  ok(tierSlot(null, { at: 1 }) === '1', 'a near-miss report object counts as a near miss');
}

// ---- adapter composition: the helpers feed encode with no further quantization -----------------------------------
{
  const code = encodeBotState({
    state: 'cover-hold',
    tier: tierSlot('defensive', false),
    score: 3,
    role: 'medic',
    element: null,
    ammo: ammoSlot({ mag: 9, magazineSize: 30, reloading: false, hasWeapon: true }),
    health: +healthBand(55, 100),
    packs: packSlot(2, true),
    latches: latchBits({ cover: true }),
  });
  ok(code === C('G', '3', '3', 'm', '-', '2', '2', 'C', '2'), `the helper-composed code is as expected (got ${code})`);
  ok(isLegalCode(code), 'the helper-composed code is legal');
  const d = decodeBotState(code);
  ok(d.state === 'cover-hold' && d.role === 'medic' && d.hasKit && d.packs === 2, 'decode reads the composed code back');
}

// ---- enumeration: the full legal space -------------------------------------------------------------------------
{
  const all = enumerateLegalCodes();
  ok(all.length === 395533, `395,533 legal 9-slot codes (got ${all.length})`);
  ok(all === enumerateLegalCodes(), 'enumerateLegalCodes is cached across calls');
  ok(all.every(c => c.length === CODE_LENGTH), 'every enumerated code is 9 chars');
  ok(new Set(all).size === all.length, 'enumerated codes are unique');
  let bad = 0, undecodable = 0;
  for (const c of all) { if (!isLegalCode(c)) bad++; if (!decodeBotState(c)) undecodable++; }
  ok(bad === 0, `every enumerated code passes isLegalCode (${bad} failures)`);
  ok(undecodable === 0, `every enumerated code decodes (${undecodable} failures)`);
  const raw = STATE_CHARS.length * TIER_CHARS.length * SCORE_CHARS.length * ROLE_CHARS.length
    * ELEMENT_CHARS.length * AMMO_CHARS.length * HEALTH_CHARS.length * PACK_CHARS.length * LATCH_CHARS.length;
  ok(raw === 43680000, `the raw slot product is 43,680,000 (got ${raw})`);
  ok(all.length < raw, 'the rules actually remove combinations');
  const set = new Set(all);
  ok(set.has(ARMED_PATROL), 'a plain armed patrolling rifleman is in the enumeration');
  ok(!set.has(C('P', '0', '0', 'r', '-', '1', '0', '0', '2')), 'an out-of-scope cover latch never appears in the enumeration');
  ok(!set.has(C('T', '0', '0', 'r', '-', '1', '0', '1', '0')), 'medic duty on a rifleman never appears in the enumeration');
}

// ---- enumeration: the behavioural core -------------------------------------------------------------------------
{
  const rows = enumerateCoreStates();
  ok(rows.length === 458, `458 behavioural core states (got ${rows.length})`);
  ok(rows === enumerateCoreStates(), 'enumerateCoreStates is cached across calls');
  ok(rows.every(r => r.code.length === CORE_LENGTH), 'every core row is a 5-char code');
  ok(new Set(rows.map(r => r.code)).size === rows.length, 'core codes are unique');
  ok(rows.every((r, i) => r.n === i + 1), 'row numbers are 1-based and contiguous');
  ok(rows.reduce((a, r) => a + r.fullCodes, 0) === enumerateLegalCodes().length, 'fullCodes sums back to the full legal count');
  ok(rows.every(r => r.fullCodes > 0), 'no core row expands to zero full codes');
  ok(new Set(enumerateLegalCodes().map(coreCode)).size === rows.length, 'core rows are exactly the distinct projections of the legal codes');
  const keys = Object.keys(rows[0]).sort().join(',');
  ok(keys === 'class,code,element,fullCodes,latches,n,reading,role,state,tier', `the row shape is stable (got ${keys})`);
  ok(rows[0].state === 'patrol' && rows[0].tier === 'calm', 'rows are ordered by state, starting at calm patrol');
  ok(rows[rows.length - 1].state === 'dead', 'dead sorts last, matching the state alphabet order');
  ok(rows.every(r => Object.values(STATE_NAMES).includes(r.state)), 'every row names a known state');
  ok(rows.every(r => Array.isArray(r.latches) && r.reading.endsWith('.')), 'every row has a latch list and a one-line reading');
  ok(rows.every(r => r.reading === describeBotState(r.code)), 'row readings match describeBotState');
  // ammo (slot 6) is outside the core, so the weapon rules move full counts only; the hold bit
  // lives in slot 9, which IS in the core, so its scope change moves both.
  const coreBy = {}, fullBy = {};
  for (const r of rows) coreBy[r.state] = (coreBy[r.state] || 0) + 1;
  for (const c of enumerateLegalCodes()) fullBy[c[0]] = (fullBy[c[0]] || 0) + 1;
  ok(coreBy.aim === 24 && coreBy.fire === 24 && coreBy.knife === 24, 'aim/fire/knife core counts');
  ok(coreBy.patrol === 48 && coreBy.seek === 48 && coreBy.pursue === 48,
    'patrol/seek/pursue carry the held-in-place rows; patrol also carries sight-grace (reposition/alert frames)');
  ok(fullBy.F === 18720, `FIRE expands over 6 ammo values -- R/0 are the emptying shot's commit frame (got ${fullBy.F})`);
  ok(fullBy.A === fullBy.F, `AIM and FIRE both expand over the same 6 ammo values (got ${fullBy.A})`);
  ok(fullBy.K === 6240, `KNIFE expands over the 2 dry ammo values only (got ${fullBy.K})`);
  const dead = rows.filter(r => r.state === 'dead');
  ok(dead.length === 2 && dead.every(r => r.latches.length === 0 && r.tier === 'calm'), 'death collapses to one core row per role');
  ok(rows.filter(r => r.role === 'medic' && (r.state === 'medic-move' || r.state === 'medic-tend')).length
    === rows.filter(r => r.state === 'medic-move' || r.state === 'medic-tend').length, 'every medic-duty core row is a medic');
}

// ---- diffCodes ----------------------------------------------------------------------------------------------------
{
  ok(diffCodes(ARMED_PATROL, ARMED_PATROL).length === 0, 'identical codes diff to nothing');
  const one = diffCodes(ARMED_PATROL, C('F', '0', '0', 'r', '-', '1', '0', '0', '0'));
  ok(one.length === 1 && one[0].slot === 1 && one[0].key === 'state', 'a state change reports exactly slot 1');
  ok(one[0].from === 'P' && one[0].to === 'F', 'diff carries the raw chars');
  ok(one[0].fromLabel === 'patrol' && one[0].toLabel === 'fire', 'diff resolves human labels');

  // patrol -> cover-move under a defensive alert, cover latched, a round spent, a pack used
  const many = diffCodes(C('P', '0', '0', 'r', '-', '2', '0', '1', '0'), C('C', '3', '2', 'r', '-', '1', '0', '0', '2'));
  ok(many.map(d => d.slot).join(',') === '1,2,3,6,8,9', `only the changed slots appear (got ${many.map(d => d.slot).join(',')})`);
  ok(many.every(d => d.from !== d.to), 'no unchanged slot leaks into the diff');
  ok(many.every(d => typeof d.name === 'string' && d.name.length > 0), 'every diff row names its slot');

  const latch = diffCodes(C('E', '0', '0', 'r', '-', '1', '0', '0', '1'), C('E', '0', '0', 'r', '-', '1', '0', '0', '9'));
  ok(latch.length === 1 && latch[0].slot === 9, 'a latch-only change reports exactly slot 9');
  ok(latch[0].fromLabel === 'flee' && latch[0].toLabel === 'flee+heal-flee', 'latch labels expand to names');

  const packs = diffCodes(C('P', '0', '0', 'm', '-', '1', '0', '1', '0'), C('P', '0', '0', 'm', '-', '1', '0', 'B', '0'));
  ok(packs.length === 1 && packs[0].toLabel === '1 pack(s) + kit', 'the pack label surfaces the kit flag');

  const nine = diffCodes(C('P', '0', '0', 'r', '-', '-', '0', '0', '0'), C('F', '4', '4', 'm', 'b', '2', '4', 'B', '1'));
  ok(nine.length === 9 && nine.map(d => d.slot).join(',') === '1,2,3,4,5,6,7,8,9', 'all nine slots can differ, reported in slot order');
  ok(diffCodes(ARMED_PATROL, 'short').length === 0, 'a malformed operand diffs to nothing');
  ok(diffCodes(null, undefined).length === 0, 'missing operands diff to nothing');
}

// changedSlots is the allocation-free form the per-frame trace recorder calls instead of diffCodes,
// so it has to agree with diffCodes on every input or the trace's slot labels drift from the tooltip.
{
  const keys = (a, b) => diffCodes(a, b).map(s => s.key).join('+');
  const codes = enumerateLegalCodes();
  let mismatch = null;
  for (let i = 0; i < 20000 && !mismatch; i++) {
    const a = codes[(i * 7919) % codes.length], b = codes[(i * 104729 + 13) % codes.length];
    if (changedSlots(a, b) !== keys(a, b)) mismatch = `${a} -> ${b}: ${changedSlots(a, b)} vs ${keys(a, b)}`;
  }
  ok(!mismatch, `changedSlots agrees with diffCodes over 20k legal pairs (${mismatch})`);
  ok(changedSlots(ARMED_PATROL, ARMED_PATROL) === '', 'an unchanged code yields no slot keys');
  ok(changedSlots(ARMED_PATROL, 'short') === '' && changedSlots(null, undefined) === '',
    'malformed operands yield no slot keys');
  ok(changedSlots(C('P', '0', '0', 'r', '-', '-', '0', '0', '0'), C('F', '4', '4', 'm', 'b', '2', '4', 'B', '1'))
    === SLOTS.map(s => s.key).join('+'), 'an all-slot change lists every key in slot order');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-state-code: all assertions passed');
