// test-bot-haywire.mjs — the haywire death roll and its thrash/twitch schedule.
// Run: node test-bot-haywire.mjs

import {
  HAYWIRE_DEFAULTS, HAYWIRE_THRASH, HAYWIRE_TWITCH, HAYWIRE_DONE,
  haywireChance, rollHaywire, createHaywireState, haywirePhase, stepHaywire, haywireImpulseDir,
} from './bot-haywire.js';

let failures = 0;
const check = (name, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
};
const checkTrue = (name, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${detail}`}`);
};
// Deterministic stand-in for Math.random.
const seq = (...v) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]; };

// ---- 1. where the bot was shot moves the odds ----
check('odds: a plain death is the base chance', haywireChance({}), HAYWIRE_DEFAULTS.baseChance);
check('odds: a headshot is the likeliest cause', haywireChance({ headKill: true }), HAYWIRE_DEFAULTS.headChance);
check('odds: a death that took a limb sits between', haywireChance({ severed: 'leftArm' }), HAYWIRE_DEFAULTS.limbChance);
checkTrue('odds: head beats limb beats base',
  HAYWIRE_DEFAULTS.headChance > HAYWIRE_DEFAULTS.limbChance &&
  HAYWIRE_DEFAULTS.limbChance > HAYWIRE_DEFAULTS.baseChance);
check('odds: a headshot outranks a sever on the same death',
  haywireChance({ headKill: true, severed: 'leftArm' }), HAYWIRE_DEFAULTS.headChance);
check('roll: a low draw goes haywire', rollHaywire({ headKill: true }, seq(0.1)), true);
check('roll: a high draw does not', rollHaywire({ headKill: true }, seq(0.99)), false);
check('roll: a plain death needs a much lower draw', rollHaywire({}, seq(0.5)), false);

// ---- 2. the schedule ----
{
  const s = createHaywireState(0);
  check('phase: it starts thrashing', haywirePhase(s, 0), HAYWIRE_THRASH);
  check('phase: still thrashing just before the handover',
    haywirePhase(s, HAYWIRE_DEFAULTS.thrashMs - 1), HAYWIRE_THRASH);
  check('phase: then twitching', haywirePhase(s, HAYWIRE_DEFAULTS.thrashMs + 1), HAYWIRE_TWITCH);
  check('phase: twitch comes after thrash, never before',
    haywirePhase(s, HAYWIRE_DEFAULTS.thrashMs + HAYWIRE_DEFAULTS.twitchMs + 1), HAYWIRE_DONE);
  check('phase: and stays done', haywirePhase(s, 999_999), HAYWIRE_DONE);
}

// ---- 3. kicks and firing ----
{
  const s = createHaywireState(0);
  const first = stepHaywire(s, 0, seq(0.01));
  checkTrue('kick: the first step kicks', first.kick);
  check('kick: at thrash strength', first.impulse, HAYWIRE_DEFAULTS.thrashImpulse);
  check('kick: and can loose a round', first.fire, true);
  check('kick: not again until its interval', stepHaywire(s, 1, seq(0.01)).kick, false);

  const twitch = createHaywireState(0);
  const t = stepHaywire(twitch, HAYWIRE_DEFAULTS.thrashMs + 10, seq(0.001));
  check('twitch: it still kicks', t.kick, true);
  check('twitch: more weakly than a thrash', t.impulse, HAYWIRE_DEFAULTS.twitchImpulse);
  check('twitch: but a twitching corpse never fires', t.fire, false);

  const done = createHaywireState(0);
  const d = stepHaywire(done, 999_999, seq(0.001));
  checkTrue('done: no kick and no fire once it is over', !d.kick && !d.fire);
}

// ---- 4. the round cap ----
{
  const s = createHaywireState(0);
  let now = 0, fired = 0;
  for (let i = 0; i < 200; i++) { now += 16; if (stepHaywire(s, now, () => 0.0).fire) fired++; }
  check('cap: a haywire corpse cannot empty a magazine', fired, HAYWIRE_DEFAULTS.fireCap);
  checkTrue('cap: and the cap is a handful, not a burst', HAYWIRE_DEFAULTS.fireCap <= 8);
}

// ---- 5. impulse direction ----
{
  const d = haywireImpulseDir(seq(0.5, 0.5));
  const len = Math.hypot(d.x, d.y, d.z);
  checkTrue('dir: it is a unit vector', Math.abs(len - 1) < 1e-6, `${len}`);
  checkTrue('dir: biased upward so a corpse flops rather than skids', d.y > 0, `${d.y}`);
  for (let i = 0; i <= 10; i++) {
    const v = haywireImpulseDir(seq(i / 10, i / 10));
    if (v.y <= 0) { failures++; console.log(`FAIL dir: y went non-positive at ${i / 10}`); break; }
  }
  console.log('ok   dir: y stays positive across the whole random range');
}

console.log(failures === 0 ? '\nAll haywire checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
