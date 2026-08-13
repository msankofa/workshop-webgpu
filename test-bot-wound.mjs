// test-bot-wound.mjs — per-limb damage accumulation and severing.
//
// The arithmetic here decides whether a bot ever survives losing an arm, so the cases that matter
// most are the ones checked against the game's REAL weapon damage numbers rather than round figures.
//
// Run: node test-bot-wound.mjs

import {
  WOUND_DEFAULTS, WOUND_CLASSES, TRIGGER_ARM, SUPPORT_ARM,
  getWoundConfig, limbThreshold, createWoundState, applyLimbDamage,
  isSevered, severedLimbs, canHoldWeapon, canHoldTwoHanded, weaponResponseFor,
  woundSpeedFactor, woundTurnRateScale, woundSpreadScale, canHeal, canFight,
  LETHAL_LIMBS, isLethalHit, isDecapitated, killingBlowSever,
} from './bot-wound.js';
import { SEVERABLE_LIMBS } from './bot-limb-map.js';

let failures = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
function checkTrue(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${detail}`}`);
}

// The actual numbers from weapons.js, against a 100-health bot.
const DMG = { five_seven: 20, cz_805_bren: 24, m1911: 33, knife: 50, m24: 95, grenade: 95, rpg: 110 };
const BOT_HEALTH = 100;

// ---- 1. the table ----
checkTrue('table: every class row merges the defaults',
  ['human', 'armouredHuman', 'robot'].every((id) => Number.isFinite(getWoundConfig(id).armThreshold)));
check('table: an unknown class falls back rather than throwing', getWoundConfig('griffin').id, 'human');
checkTrue('table: armour raises the bar, robots lower it',
  getWoundConfig('robot').armThreshold < getWoundConfig('human').armThreshold &&
  getWoundConfig('human').armThreshold < getWoundConfig('armouredHuman').armThreshold);
checkTrue('table: rows are frozen against mutation by a consumer', (() => {
  const row = getWoundConfig('human');
  try { row.armThreshold = 1; } catch { /* strict mode throws, which is also fine */ }
  return getWoundConfig('human').armThreshold === WOUND_DEFAULTS.armThreshold;
})());
checkTrue('table: legs are tougher than arms in every class',
  Object.keys(WOUND_CLASSES).every((id) => getWoundConfig(id).legThreshold > getWoundConfig(id).armThreshold));

// ---- 2. thresholds by limb ----
check('threshold: an arm uses the arm number', limbThreshold('leftArm'), WOUND_DEFAULTS.armThreshold);
check('threshold: a leg uses the leg number', limbThreshold('rightLeg'), WOUND_DEFAULTS.legThreshold);
check('threshold: the head has none, because it kills on contact', limbThreshold('head'), 0);
check('threshold: the trunk cannot be severed at all', limbThreshold('core'), Infinity);

// ---- 3. accumulation ----
{
  const s = createWoundState();
  const cfg = getWoundConfig('human');
  const r1 = applyLimbDamage(s, 'leftArm', DMG.cz_805_bren, cfg);
  check('accumulate: one rifle round does not take an arm', r1.severed, null);
  check('accumulate: and the total is recorded', r1.total, 24);
  applyLimbDamage(s, 'leftArm', DMG.cz_805_bren, cfg);
  const r3 = applyLimbDamage(s, 'leftArm', DMG.cz_805_bren, cfg);
  check('accumulate: three rifle rounds into the same arm take it off', r3.severed, 'leftArm');
  check('accumulate: at the total those three rounds actually deal', r3.total, 72);
  checkTrue('accumulate: 3 x 24 clears the 60 threshold', 72 >= WOUND_DEFAULTS.armThreshold);
}
{
  // Damage spread across limbs must NOT sever: this is the difference between a per-limb accumulator
  // and simply re-reading whole-body health.
  const s = createWoundState();
  for (const limb of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg']) {
    applyLimbDamage(s, limb, DMG.cz_805_bren * 2);
  }
  check('accumulate: 96 damage spread over four limbs severs nothing', s.severedCount, 0);
  checkTrue('accumulate: even though it would have killed the bot outright', 96 >= BOT_HEALTH * 0.9);
}
{
  const s = createWoundState();
  check('accumulate: two knife strikes take a leg', (() => {
    applyLimbDamage(s, 'leftLeg', DMG.knife);
    return applyLimbDamage(s, 'leftLeg', DMG.knife).severed;
  })(), 'leftLeg');
}

// ---- 4. sever fires exactly once ----
{
  const s = createWoundState();
  applyLimbDamage(s, 'rightArm', 200);
  const again = applyLimbDamage(s, 'rightArm', 200);
  check('once: the first crossing reports the sever', isSevered(s, 'rightArm'), true);
  check('once: a later hit on a missing limb reports nothing', again.severed, null);
  check('once: and does not double-count the limb', s.severedCount, 1);
  check('once: nor keep growing its total', again.total, 200);
}

// ---- 5. only severable limbs accumulate ----
{
  const s = createWoundState();
  check('scope: a torso hit never severs anything', applyLimbDamage(s, 'core', 500).severed, null);
  check('scope: and is not recorded as severed', s.severedCount, 0);
  check('scope: the trunk is not lethal on contact either', applyLimbDamage(s, 'core', 500).lethal, false);
  checkTrue('scope: the severable set is exactly the four limbs',
    SEVERABLE_LIMBS.size === 4 && [...SEVERABLE_LIMBS].every((l) => /Arm|Leg$/.test(l)));
}

// ---- 6. no decay, no healing ----
{
  const s = createWoundState();
  applyLimbDamage(s, 'leftArm', 50);
  applyLimbDamage(s, 'leftArm', -999);       // a "heal" must not credit the limb back
  check('no heal: negative damage does not reduce the total', s.damage.leftArm, 50);
  check('no heal: the next real hit still finishes the limb',
    applyLimbDamage(s, 'leftArm', 10).severed, 'leftArm');
}

// ---- 7. what a sever means for the weapon ----
{
  const s = createWoundState();
  check('weapon: an intact bot needs no response', weaponResponseFor(s), null);
  checkTrue('weapon: and can hold a two-handed gun', canHoldTwoHanded(s) && canHoldWeapon(s));

  const support = createWoundState();
  applyLimbDamage(support, SUPPORT_ARM, 999);
  check('weapon: losing the support arm asks for the one-handed carry',
    weaponResponseFor(support), 'oneHanded');
  check('weapon: and the gun is still held', canHoldWeapon(support), true);
  check('weapon: but not with two hands', canHoldTwoHanded(support), false);

  const trigger = createWoundState();
  applyLimbDamage(trigger, TRIGGER_ARM, 999);
  check('weapon: losing the trigger arm asks for the sidearm',
    weaponResponseFor(trigger), 'sidearm');
  check('weapon: because nothing can work the trigger', canHoldWeapon(trigger), false);

  const both = createWoundState();
  applyLimbDamage(both, TRIGGER_ARM, 999);
  applyLimbDamage(both, SUPPORT_ARM, 999);
  check('weapon: losing both arms disarms the bot entirely', weaponResponseFor(both), 'disarm');

  const legs = createWoundState();
  applyLimbDamage(legs, 'leftLeg', 999);
  check('weapon: a lost leg does not touch the loadout', weaponResponseFor(legs), null);
}
check('weapon: the trigger arm is the visual right', TRIGGER_ARM, 'rightArm');
check('weapon: the support arm is the visual left, which the dash carry already frees', SUPPORT_ARM, 'leftArm');

// ---- 7b. consequences ----
// Shaped like bot-stance.js's factors: multiplied onto what is already there, never replacing it.
{
  const intact = createWoundState();
  check('consequence: an intact bot moves at full speed', woundSpeedFactor(intact), 1);
  check('consequence: turns at full rate', woundTurnRateScale(intact), 1);
  check('consequence: and shoots at its normal spread', woundSpreadScale(intact), 1);

  const oneLeg = createWoundState();
  applyLimbDamage(oneLeg, 'leftLeg', 999);
  check('consequence: one leg gone is a limp', woundSpeedFactor(oneLeg), WOUND_DEFAULTS.legSpeedFactor);
  check('consequence: and a slower pivot', woundTurnRateScale(oneLeg), WOUND_DEFAULTS.legTurnScale);
  check('consequence: legs do not affect aim', woundSpreadScale(oneLeg), 1);

  const bothLegs = createWoundState();
  applyLimbDamage(bothLegs, 'leftLeg', 999);
  applyLimbDamage(bothLegs, 'rightLeg', 999);
  check('consequence: both legs is a crawl, not the square of one',
    woundSpeedFactor(bothLegs), WOUND_DEFAULTS.bothLegsSpeedFactor);
  checkTrue('consequence: which is slower than losing one',
    woundSpeedFactor(bothLegs) < woundSpeedFactor(oneLeg));

  const oneArm = createWoundState();
  applyLimbDamage(oneArm, SUPPORT_ARM, 999);
  check('consequence: one arm gone widens the spread', woundSpreadScale(oneArm), WOUND_DEFAULTS.armSpreadScale);
  check('consequence: arms do not affect speed', woundSpeedFactor(oneArm), 1);

  const bothArms = createWoundState();
  applyLimbDamage(bothArms, TRIGGER_ARM, 999);
  applyLimbDamage(bothArms, SUPPORT_ARM, 999);
  checkTrue('consequence: two arms gone is worse still',
    woundSpreadScale(bothArms) > woundSpreadScale(oneArm));

  // Every factor must stay finite and positive, or a multiply at the call site produces NaN speed.
  const all = createWoundState();
  for (const l of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg']) applyLimbDamage(all, l, 999);
  checkTrue('consequence: every factor stays finite and positive with nothing left',
    [woundSpeedFactor(all), woundTurnRateScale(all), woundSpreadScale(all)]
      .every((v) => Number.isFinite(v) && v > 0));
  checkTrue('consequence: a null state is neutral in every factor',
    woundSpeedFactor(null) === 1 && woundTurnRateScale(null) === 1 && woundSpreadScale(null) === 1);
}

// ---- 7c. capability gates ----
{
  const intact = createWoundState();
  checkTrue('gate: an intact bot can heal and fight', canHeal(intact) && canFight(intact));

  // Healing is two-handed — the heal pose holds the pack in one hand and dabs with the other — so
  // EITHER arm ends it, not just the trigger arm.
  const support = createWoundState();
  applyLimbDamage(support, SUPPORT_ARM, 999);
  check('gate: losing the support arm ends a medic', canHeal(support), false);
  check('gate: but it can still fight one-handed', canFight(support), true);

  const trigger = createWoundState();
  applyLimbDamage(trigger, TRIGGER_ARM, 999);
  check('gate: losing the trigger arm also ends a medic', canHeal(trigger), false);
  check('gate: and it fights on with the sidearm', canFight(trigger), true);

  const both = createWoundState();
  applyLimbDamage(both, TRIGGER_ARM, 999);
  applyLimbDamage(both, SUPPORT_ARM, 999);
  check('gate: with both arms gone it cannot fight at all', canFight(both), false);

  const legs = createWoundState();
  applyLimbDamage(legs, 'leftLeg', 999);
  applyLimbDamage(legs, 'rightLeg', 999);
  checkTrue('gate: legs never stop a bot healing or fighting', canHeal(legs) && canFight(legs));
}

// ---- 8. reporting and robustness ----
{
  const s = createWoundState();
  applyLimbDamage(s, 'leftArm', 999);
  applyLimbDamage(s, 'rightLeg', 999);
  const list = severedLimbs(s).sort();
  checkTrue('report: severedLimbs lists exactly what is gone',
    list.length === 2 && list[0] === 'leftArm' && list[1] === 'rightLeg', `${list}`);
  check('report: a fresh state reports nothing', severedLimbs(createWoundState()).length, 0);
  check('robust: a null state is inert', applyLimbDamage(null, 'leftArm', 50).severed, null);
  check('robust: an unknown limb is inert', applyLimbDamage(s, 'wing', 50).severed, null);
  check('robust: NaN damage does not corrupt a total', (() => {
    const t = createWoundState();
    applyLimbDamage(t, 'leftArm', NaN);
    return t.damage.leftArm;
  })(), 0);
  check('robust: isSevered on a null state is false', isSevered(null, 'leftArm'), false);
  check('robust: canHoldWeapon on a null state is true', canHoldWeapon(null), true);
}

// ---- 8b. the head kills on contact ----
// The weakest weapon must be as lethal to a head as the strongest.
{
  checkTrue('head: the head is a lethal limb, not a severable one',
    LETHAL_LIMBS.has('head') && !SEVERABLE_LIMBS.has('head'));
  check('head: its threshold is zero, so nothing has to be accumulated', limbThreshold('head'), 0);
  const weakest = createWoundState();
  const first = applyLimbDamage(weakest, 'head', DMG.five_seven);
  checkTrue('head: one round from the weakest weapon in the game is lethal', first.lethal);
  check('head: the lethal hit also takes the head off', first.severed, 'head');
  check('head: and is reported as a decapitation', isDecapitated(weakest), true);
  check('head: the damage is still recorded', weakest.damage.head, DMG.five_seven);
  const again = applyLimbDamage(weakest, 'head', DMG.m24);
  check('head: a second hit does not re-sever it', again.severed, null);
  checkTrue('head: nor does it report lethal twice', !again.lethal);

  // Losing the head must not read as losing an arm or a leg: a corpse should not also be limping.
  checkTrue('head: decapitation leaves the arms alone', canFight(weakest) && canHeal(weakest));
  check('head: decapitation leaves movement alone', woundSpeedFactor(weakest), 1);
  check('head: decapitation demands nothing of the weapon', weaponResponseFor(weakest), null);

  // The per-class seam: a config that turns head lethality off records the hit and nothing else.
  const survivor = createWoundState();
  const cfg = { ...WOUND_DEFAULTS, headLethal: false };
  const res = applyLimbDamage(survivor, 'head', DMG.rpg, cfg);
  checkTrue('head: headLethal false makes a head hit ordinary', !res.lethal && res.severed === null);
  check('head: and the hit is still recorded for the readout', survivor.damage.head, DMG.rpg);
  check('head: isLethalHit follows the config, not the limb id', isLethalHit('head', cfg), false);
  check('head: only the head is lethal', isLethalHit('core'), false);
}

// ---- 8c. the killing blow ----
// Hit shares are measured by test-bot-wound-attribution.mjs against a real rig.
const HIT_SHARE = { core: 0.73, leg: 0.123, arm: 0.005 };   // from the capsule-gated ray sweep
{
  const s = createWoundState();
  check('kill: the fatal round takes the limb it found', killingBlowSever(s, 'leftArm'), 'leftArm');
  check('kill: and that is recorded as severed', isSevered(s, 'leftArm'), true);
  check('kill: a limb already gone is not taken twice', killingBlowSever(s, 'leftArm'), null);
  check('kill: and does not double-count', s.severedCount, 1);
  check('kill: a torso hit takes nothing', killingBlowSever(createWoundState(), 'core'), null);
  check('kill: nor does a head hit, which has its own rule', killingBlowSever(createWoundState(), 'head'), null);
  check('kill: the flag can turn it off',
    killingBlowSever(createWoundState(), 'leftLeg', { ...WOUND_DEFAULTS, severOnKillingBlow: false }), null);
  check('kill: a null state is inert', killingBlowSever(null, 'leftArm'), null);

  // If a threshold ever drops far enough for the accumulator to work alone, these fail.
  const armExpected = BOT_HEALTH * HIT_SHARE.arm;
  checkTrue('kill: an arm cannot fill its own threshold before the bot dies',
    armExpected < WOUND_DEFAULTS.armThreshold,
    `arm expects ${armExpected.toFixed(1)} damage against a ${WOUND_DEFAULTS.armThreshold} threshold`);
  const legExpected = BOT_HEALTH * HIT_SHARE.leg;
  checkTrue('kill: nor can a leg', legExpected < WOUND_DEFAULTS.legThreshold,
    `leg expects ${legExpected.toFixed(1)} against ${WOUND_DEFAULTS.legThreshold}`);
  console.log(`     (note: over a bot's whole 100 health, one arm expects ${armExpected.toFixed(1)} damage and one leg ${legExpected.toFixed(1)})`);
}

// ---- 9. the honest limitation, asserted so it cannot be forgotten ----
// With flat damage, an arm and the bot cross their thresholds together. This is not a bug in the
// module — it is why limbDamageScale exists as a seam — but it should fail loudly if someone changes
// a threshold to a number that makes surviving a sever arithmetically impossible.
{
  const armCost = WOUND_DEFAULTS.armThreshold * WOUND_DEFAULTS.limbDamageScale;
  checkTrue('limitation: an arm can be lost before the body dies, if only barely',
    armCost < BOT_HEALTH, `arm costs ${armCost} of ${BOT_HEALTH} health`);
  check('limitation: the scale seam defaults to no change at all', WOUND_DEFAULTS.limbDamageScale, 1);
  console.log(`     (note: at scale 1 a bot losing an arm is down to ${BOT_HEALTH - armCost} health)`);
}

console.log(failures === 0 ? '\nAll wound checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
