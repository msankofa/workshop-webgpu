// test-bot-damage-class.mjs — the damage-class table and its two pure decision functions.
//
// Phase 0 is inert: nothing in either viewer reads this module yet. What is worth pinning down now
// is the shape (defaults merge, unknown ids fall back, rows are immutable) and the one rule that is
// easy to get wrong later — the armour-breach latch is one-way, so a healed bot keeps bleeding.
//
// Run: node test-bot-damage-class.mjs

import {
  DAMAGE_CLASS_DEFAULTS, DAMAGE_CLASSES, DAMAGE_CLASS_IDS, DEFAULT_DAMAGE_CLASS,
  getDamageClass, classForActor, shouldShowBlood, shouldShowSmoke,
} from './bot-damage-class.js';

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

// ---- 1. table shape ----
check('table: three classes', DAMAGE_CLASS_IDS.length, 3);
checkTrue('table: human, armouredHuman, robot',
  ['human', 'armouredHuman', 'robot'].every((id) => DAMAGE_CLASS_IDS.includes(id)));
check('table: default class is human', DEFAULT_DAMAGE_CLASS, 'human');

// Every row must carry every default field, or a consumer reading a capability off one class and
// not another gets `undefined` and silently takes the falsy branch.
for (const id of DAMAGE_CLASS_IDS) {
  const row = getDamageClass(id);
  const missing = Object.keys(DAMAGE_CLASS_DEFAULTS).filter((k) => !(k in row));
  checkTrue(`merge: ${id} carries every default field`, missing.length === 0, `missing ${missing}`);
}
check('merge: row keeps its own id', getDamageClass('robot').id, 'robot');
// human overrides nothing but `blood`, so its other fields must be the defaults verbatim.
check('merge: unset field falls through to the default', getDamageClass('human').hitAudio, 'flesh');
check('merge: set field wins over the default', getDamageClass('robot').hitAudio, 'metal');

// A returned row is shared by every consumer, so writing through one would poison the table.
{
  const row = getDamageClass('human');
  try { row.blood = 'never'; } catch { /* strict-mode throw is the other acceptable outcome */ }
  check('merge: rows are frozen', getDamageClass('human').blood, 'always');
}

// ---- 2. unknown ids fall back rather than throwing ----
check('lookup: unknown id falls back to human', getDamageClass('werewolf').id, 'human');
check('lookup: undefined falls back', getDamageClass(undefined).id, 'human');
check('lookup: null falls back', getDamageClass(null).id, 'human');

// ---- 3. classForActor: explicit override first, then body kind ----
check('resolve: soldier body -> human', classForActor(null, 'soldier'), 'human');
check('resolve: armoured body -> armouredHuman', classForActor(null, 'armoured'), 'armouredHuman');
check('resolve: unknown body kind -> default', classForActor(null, 'centaur'), 'human');
check('resolve: no information at all -> default', classForActor(null), 'human');
check('resolve: actor field overrides body kind',
  classForActor({ damageClass: 'robot' }, 'soldier'), 'robot');
check('resolve: entity field is read too',
  classForActor({ entity: { damageClass: 'robot' } }, 'soldier'), 'robot');
check('resolve: a bogus override is ignored, not trusted',
  classForActor({ damageClass: 'werewolf' }, 'armoured'), 'armouredHuman');
check('resolve: actor.bodyKind is used when no kind is passed',
  classForActor({ bodyKind: 'armoured' }), 'armouredHuman');

// ---- 4. shouldShowBlood ----
{
  const human = getDamageClass('human');
  const robot = getDamageClass('robot');
  const armoured = getDamageClass('armouredHuman');

  checkTrue('blood: human bleeds at full health', shouldShowBlood(human, 1.0).show === true);
  checkTrue('blood: human bleeds at death', shouldShowBlood(human, 0).show === true);
  checkTrue('blood: robot never bleeds, even dying', shouldShowBlood(robot, 0).show === false);
  checkTrue('blood: robot is never marked breached', shouldShowBlood(robot, 0, true).breached === false);

  // The gate itself: above the threshold nothing shows, at or below it everything does.
  checkTrue('blood: armoured does not bleed above the threshold',
    shouldShowBlood(armoured, 0.36).show === false);
  checkTrue('blood: armoured bleeds exactly AT the threshold',
    shouldShowBlood(armoured, 0.35).show === true);
  checkTrue('blood: armoured bleeds below the threshold',
    shouldShowBlood(armoured, 0.10).show === true);
  checkTrue('blood: crossing the threshold reports breached',
    shouldShowBlood(armoured, 0.10).breached === true);

  // The latch. This is the rule the whole function exists for.
  const first = shouldShowBlood(armoured, 0.30, false);
  checkTrue('latch: first breach shows blood and latches', first.show && first.breached);
  const healed = shouldShowBlood(armoured, 0.90, first.breached);
  checkTrue('latch: a healed bot still bleeds', healed.show === true);
  checkTrue('latch: and stays breached', healed.breached === true);
  const fresh = shouldShowBlood(armoured, 0.90, false);
  checkTrue('latch: a bot that was never breached does not bleed at the same health',
    fresh.show === false, 'the latch must be the only difference between these two calls');

  // An id works in place of a row, so a caller need not resolve the table itself.
  checkTrue('blood: accepts a class id as well as a row',
    shouldShowBlood('robot', 0).show === false);
  // Missing/garbage health must not read as "dying" and open the gate by accident.
  checkTrue('blood: non-finite health is treated as full health',
    shouldShowBlood(armoured, undefined).show === false);
  checkTrue('blood: NaN health is treated as full health',
    shouldShowBlood(armoured, NaN).show === false);
}

// ---- 5. shouldShowSmoke ----
{
  const human = getDamageClass('human');
  const robot = getDamageClass('robot');
  const armoured = getDamageClass('armouredHuman');
  checkTrue('smoke: human never smokes', shouldShowSmoke(human, 0) === false);
  checkTrue('smoke: robot always smokes', shouldShowSmoke(robot, 1.0) === true);
  checkTrue('smoke: armoured smokes only once hurt', shouldShowSmoke(armoured, 0.9) === false);
  checkTrue('smoke: armoured smokes below the threshold', shouldShowSmoke(armoured, 0.2) === true);
  checkTrue('smoke: armoured keeps smoking once breached', shouldShowSmoke(armoured, 0.9, true) === true);
}

// ---- 6. the no-branching rule, checked mechanically ----
// The table only earns its keep if consumers read capabilities. A row whose fields are identical to
// another's would force call sites back to `if (id === ...)`, so every class must be distinguishable
// by its fields alone.
{
  const sigs = DAMAGE_CLASS_IDS.map((id) => {
    const { id: _drop, ...fields } = getDamageClass(id);
    return JSON.stringify(fields);
  });
  checkTrue('rule: every class is distinguishable by its fields alone',
    new Set(sigs).size === sigs.length);
}
checkTrue('rule: the raw table stores only overrides, so new defaults reach every row',
  Object.keys(DAMAGE_CLASSES.human).length < Object.keys(DAMAGE_CLASS_DEFAULTS).length);

console.log(failures === 0 ? '\nAll damage-class checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
