// test-grass-textures.mjs
import { FIBER_STYLES, STYLE_KEYS, clamp01 } from './grass-textures.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL ') + m); if (!c) fail++; };

ok(STYLE_KEYS.length === 5, 'exactly 5 fiber styles');
ok(STYLE_KEYS.join(',') === 'streaks,dryTip,mottle,vein,highContrast', 'the 5 approved style keys, in order');

// every style's fiber() stays within a sane multiplier range across the UV domain
for (const key of STYLE_KEYS) {
  let inRange = true, allFinite = true;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const v = FIBER_STYLES[key].fiber(i / 10, j / 10, 0.5);
    if (!Number.isFinite(v)) allFinite = false;
    if (v < 0.35 || v > 1.45) inRange = false;
  }
  ok(allFinite, `${key}: fiber() always finite`);
  ok(inRange, `${key}: fiber() stays within [0.35, 1.45]`);
}

// dryTip's dryness ramps up toward the tip (v=1) and is ~0 at the base (v=0), by design
// (clamp01((v-0.55)/0.45) is exactly 0 for v<=0.55) — this is the one style whose tint()
// is deliberately monotonic in v; highContrast's tint is speckle-based, not monotonic,
// so it's only range-checked below, not asserted monotonic.
const dryBase = FIBER_STYLES.dryTip.tint(0.5, 0.0, 0.5);
const dryTip = FIBER_STYLES.dryTip.tint(0.5, 0.95, 0.5);
ok(dryBase === 0, 'dryTip: tint is exactly 0 at the blade base (v=0)');
ok(dryTip > 0, 'dryTip: tint is nonzero near the tip (v=0.95)');

// highContrast.tint() is speckle-based (not monotonic in v) but must stay in [0,1]
let hcInRange = true;
for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
  const t = FIBER_STYLES.highContrast.tint(i / 10, j / 10, 0.5);
  if (t < 0 || t > 1) hcInRange = false;
}
ok(hcInRange, 'highContrast: tint() stays within [0,1]');

// styles without a tint() are fine to omit it (grass.js treats missing tint as 0)
ok(FIBER_STYLES.streaks.tint === undefined, 'streaks has no tint()');
ok(FIBER_STYLES.mottle.tint === undefined, 'mottle has no tint()');
ok(FIBER_STYLES.vein.tint === undefined, 'vein has no tint()');

ok(clamp01(-0.4) === 0 && clamp01(1.6) === 1 && clamp01(0.3) === 0.3, 'clamp01 clamps to [0,1]');

console.log(fail ? fail + ' FAIL' : 'ALL PASS'); process.exit(fail ? 1 : 0);
