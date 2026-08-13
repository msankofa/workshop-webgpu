// node test-explosion-tier.mjs
//
// Covers `explosion-tier.js`, the port of html-game-v2's `reserveExplosionVisualTier`.
//
// The point of these checks is FIDELITY TO THE ORIGINAL, not that the code runs. The constants are
// the whole value of the port — 320 ms, 2 full / 5 medium for primary, 1 / 4 for secondary — so
// they are asserted as literals rather than read back from the module. If someone retunes the
// module, this fails and they have to decide deliberately whether the game and the demo are
// diverging from html-game-v2.

import {
  createExplosionBudget, scaledEffectCount, DEFAULT_WINDOW_MS, DEFAULT_LIMITS, TIERS,
} from './explosion-tier.js';

let checks = 0, failures = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.error('  FAIL:', msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (s) => console.log(s);

// A clock we drive by hand, so nothing here sleeps or depends on wall time.
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; } };
}

// ---------------------------------------------------------------------------
section('1. the constants are html-game-v2\'s');
// ---------------------------------------------------------------------------

eq(DEFAULT_WINDOW_MS, 320, 'budget window is 320 ms');
eq(DEFAULT_LIMITS.primary.full, 2, 'two primary blasts render full');
eq(DEFAULT_LIMITS.primary.medium, 5, 'primary medium cut-off is 5');
eq(DEFAULT_LIMITS.secondary.full, 1, 'one secondary blast renders full');
eq(DEFAULT_LIMITS.secondary.medium, 4, 'secondary medium cut-off is 4');
eq(TIERS.join(','), 'full,medium,lite', 'three tiers, best first');

// ---------------------------------------------------------------------------
section('2. a volley degrades in the documented order');
// ---------------------------------------------------------------------------

{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now });
  // Eight blasts in the same instant — the volley case the system exists for.
  const got = Array.from({ length: 8 }, () => b.reserve('primary'));
  eq(got.join(','), 'full,full,medium,medium,medium,lite,lite,lite',
    'primary volley: 2 full, 3 medium, rest lite');
  eq(b.used, 8, 'every blast claimed a slot');
}

{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now });
  const got = Array.from({ length: 6 }, () => b.reserve('secondary'));
  eq(got.join(','), 'full,medium,medium,medium,lite,lite',
    'secondary volley degrades one slot earlier');
}

// Priority is per call, not per budget: a primary blast arriving late in a busy window is still
// subject to the same count. This is the original's behaviour and worth pinning down.
{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now });
  b.reserve('secondary'); b.reserve('secondary');       // count is now 2
  eq(b.reserve('primary'), 'medium', 'a primary blast arriving third is medium, not full');
}

// ---------------------------------------------------------------------------
section('3. the window restarts rather than slides');
// ---------------------------------------------------------------------------

{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now });
  eq(b.reserve(), 'full', 'first blast is full');
  eq(b.reserve(), 'full', 'second is full');
  eq(b.reserve(), 'medium', 'third is medium');

  clock.advance(319);
  eq(b.reserve(), 'medium', 'still inside the window at 319 ms');

  clock.advance(2);                                     // 321 ms since the window opened
  eq(b.reserve(), 'full', 'past 320 ms the window restarts and quality recovers');
  eq(b.used, 1, 'and the count restarts with it');
}

// Sustained slow fire must never degrade — this is the property that makes a restart the right
// choice over a sliding window.
{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now });
  let allFull = true;
  for (let i = 0; i < 40; i++) {
    if (b.reserve() !== 'full') allFull = false;
    clock.advance(400);
  }
  ok(allFull, '40 blasts fired 400 ms apart are all full quality');
}

// A burst inside every window degrades every window, i.e. the budget does not leak across.
{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now });
  for (let w = 0; w < 3; w++) {
    const got = Array.from({ length: 4 }, () => b.reserve());
    eq(got.join(','), 'full,full,medium,medium', `window ${w} degrades identically`);
    clock.advance(500);
  }
}

// ---------------------------------------------------------------------------
section('4. reset, custom limits, edge cases');
// ---------------------------------------------------------------------------

{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now });
  b.reserve(); b.reserve(); b.reserve();
  b.reset();
  eq(b.used, 0, 'reset clears the count');
  eq(b.reserve(), 'full', 'and the next blast is full again');
}

{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now, limits: { primary: { full: 0, medium: 1 } } });
  eq(b.reserve(), 'medium', 'a zero full-limit admits nothing at full');
  eq(b.reserve(), 'lite', 'and drops straight to lite after the medium slot');
}

{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now, windowMs: 1000 });
  b.reserve(); b.reserve(); b.reserve();
  clock.advance(900);
  eq(b.reserve(), 'medium', 'a custom window length is respected');
}

{
  const clock = fakeClock();
  const b = createExplosionBudget({ now: clock.now });
  eq(b.reserve('nonsense'), 'full', 'an unknown priority falls back to primary rather than throwing');
}

// ---------------------------------------------------------------------------
section('5. scaledEffectCount');
// ---------------------------------------------------------------------------

eq(scaledEffectCount(22, 'full'), 22, 'full tier keeps every piece');
eq(scaledEffectCount(22, 'medium'), 12, '22 pieces at 0.55 rounds to 12');
eq(scaledEffectCount(22, 'lite'), 6, '22 pieces at 0.25 rounds to 6');
eq(scaledEffectCount(3, 'medium'), 2, 'a small count survives medium instead of vanishing');
eq(scaledEffectCount(0, 'full'), 0, 'zero stays zero');
eq(scaledEffectCount(10, 'medium', 0.9, 0.1), 9, 'custom scales are honoured');
eq(scaledEffectCount(-5, 'full'), 0, 'a negative count clamps to zero rather than going negative');

// Monotonic: a worse tier never yields more pieces, at any count.
{
  let monotone = true;
  for (let n = 0; n <= 400; n++) {
    const f = scaledEffectCount(n, 'full');
    const m = scaledEffectCount(n, 'medium');
    const l = scaledEffectCount(n, 'lite');
    if (!(f >= m && m >= l)) { monotone = false; console.error('  non-monotone at', n, f, m, l); break; }
  }
  ok(monotone, 'full >= medium >= lite for every count up to 400');
}

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
