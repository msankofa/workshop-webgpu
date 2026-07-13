import { DEFAULT_PALETTE, makePalette, skyRadius, isMoonBody, sunSpritePlacement } from './sky-field.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---- palette ----
ok(DEFAULT_PALETTE.celestialType === 'sun', 'default body is the sun');
ok(makePalette().starCount === DEFAULT_PALETTE.starCount, 'makePalette() clones defaults');
ok(makePalette({ starCount: 42 }).starCount === 42, 'makePalette() applies overrides');
ok(makePalette({ starCount: 42 }).top === DEFAULT_PALETTE.top, 'unspecified fields keep defaults');
ok(makePalette() !== DEFAULT_PALETTE, 'makePalette() returns a fresh object');

// ---- radius: min(far*0.88, max(420, size*2.65)) ----
ok(skyRadius(1000, 120) === Math.min(880, 420), 'small size clamps to floor 420');
ok(skyRadius(1000, 300) === Math.min(880, 795), 'far*0.88 wins when nearer than size band');
ok(skyRadius(2000, 300) === Math.min(1760, 795), 'size band wins when far is huge');
ok(skyRadius(100, 0) === Math.min(88, 420), 'zero/undefined size falls back to 120 floor');

// ---- isMoonBody: explicit type, else sunOpacity<0.6 inference ----
ok(isMoonBody({ celestialType: 'moon', sunOpacity: 1 }) === true, 'explicit moon type');
ok(isMoonBody({ celestialType: 'sun', sunOpacity: 0.1 }) === false, 'explicit sun type overrides opacity');
ok(isMoonBody({ sunOpacity: 0.4 }) === true, 'low opacity infers moon');
ok(isMoonBody({ sunOpacity: 0.9 }) === false, 'high opacity infers sun');

// ---- sprite placement: pos = dir*radius*0.74; scale = radius*sunSize*2.15*(moon?2.4:1) ----
{
  const dir = [0.6, 0.55, 0.58];
  const len = Math.hypot(...dir);
  const p = sunSpritePlacement(dir, 1000, { sunSize: 0.06, celestialType: 'sun', sunOpacity: 1 });
  ok(approx(p.position.x, dir[0] / len * 740) && approx(p.position.y, dir[1] / len * 740), 'sun sits along normalized dir at 0.74R');
  ok(approx(p.scale, 1000 * 0.06 * 2.15), 'sun scale = R*sunSize*2.15');
  const m = sunSpritePlacement(dir, 1000, { sunSize: 0.06, celestialType: 'moon', sunOpacity: 1 });
  ok(approx(m.scale, 1000 * 0.06 * 2.15 * 2.4), 'moon scale is 2.4x the sun');
}

import { makeRng, generateStars } from './sky-field.js';

// ---- makeRng: deterministic, in [0,1) ----
{
  const a = makeRng(7), b = makeRng(7);
  const va = [a(), a(), a()], vb = [b(), b(), b()];
  ok(va.every((v, i) => v === vb[i]), 'same seed → same stream');
  ok(va.every(v => v >= 0 && v < 1), 'rng values in [0,1)');
  ok(makeRng(8)() !== va[0], 'different seed → different stream');
}

// ---- generateStars: counts, hemisphere, radius shell, attribute ranges ----
{
  const pal = makePalette({ starCount: 1000, starSize: 2 });
  const s = generateStars(1000, pal, makeRng(1));
  ok(s.count === 1000, 'star count matches palette');
  ok(s.position.length === 3000 && s.size.length === 1000, 'typed arrays sized to count');
  let aboveHorizon = true, onShell = true, brightOk = true;
  const R = 1000 * 0.83;
  for (let i = 0; i < s.count; i++) {
    const x = s.position[i * 3], y = s.position[i * 3 + 1], z = s.position[i * 3 + 2];
    if (y < 0.06 * R - 1e-3) aboveHorizon = false;        // upper hemisphere only
    if (Math.abs(Math.hypot(x, y, z) - R) > 1e-2) onShell = false;
    if (s.brightness[i] < 0.62 - 1e-6 || s.brightness[i] > 1.0 + 1e-6) brightOk = false;
  }
  ok(aboveHorizon, 'all stars above the horizon (y >= 0.06R)');
  ok(onShell, 'all stars on the 0.83R shell');
  ok(brightOk, 'brightness within [0.62, 1.0]');
  ok(generateStars(1000, pal, makeRng(1)).position[0] === s.position[0], 'generation is deterministic per seed');
  ok(s.clusterCount >= 1 && s.clusterCount <= 3, 'dense sky reserves 1-3 clusters');
  const sparse = generateStars(1000, makePalette({ starCount: 200 }), makeRng(1));
  ok(sparse.clusterCount === 0, 'sparse sky reserves no clusters');
}

import { generateMilkyWay, generateCelestialBodies } from './sky-field.js';

// ---- Milky Way: only for night/dusk palettes; band on a tilted great circle ----
{
  const mw = generateMilkyWay(1000, makePalette({ milkyWay: true }), makeRng(2));
  ok(mw && mw.bandCount > 0, 'milky way present when enabled');
  ok(mw.position.length === mw.bandCount * 3, 'band positions sized to count');
  ok(typeof mw.tilt === 'number', 'band carries a tilt angle');
  let onShell = true;
  for (let i = 0; i < mw.bandCount; i++) {
    const x = mw.position[i*3], y = mw.position[i*3+1], z = mw.position[i*3+2];
    if (Math.abs(Math.hypot(x, y, z) - 1000 * 0.82) > 2) onShell = false;
  }
  ok(onShell, 'band stars lie on the ~0.82R shell');
  ok(generateMilkyWay(1000, makePalette({ milkyWay: false }), makeRng(2)) === null, 'no band when disabled');
}

// ---- Celestial bodies: counts within spec ranges, near planet has companions ----
{
  const bodies = generateCelestialBodies(1000, makePalette(), makeRng(3));
  const moons = bodies.filter(b => b.type === 'moon' && !b.companion);
  const distant = bodies.filter(b => b.type === 'planet' && b.scaleClass === 'distant');
  const near = bodies.filter(b => b.type === 'planet' && b.scaleClass === 'near');
  const comp = bodies.filter(b => b.companion);
  ok(moons.length >= 1 && moons.length <= 2, '1-2 extra moons');
  ok(distant.length >= 2 && distant.length <= 4, '2-4 distant planets');
  ok(near.length === 1, 'exactly one near planet');
  ok(comp.length >= 1 && comp.length <= 3, '1-3 companion moons on the near planet');
  ok(bodies.every(b => Math.abs(Math.hypot(b.position.x, b.position.y, b.position.z) - b.radius) < 1e-3), 'each body sits on its own radius');
  ok(generateCelestialBodies(1000, makePalette(), makeRng(3)).length === bodies.length, 'deterministic per seed');

  ok(bodies.every(b => typeof b.kind === 'string'), 'every body has a kind string');
  ok(moons.every(b => ['ice', 'rocky'].includes(b.kind)), 'extra moons only roll ice/rocky kinds');
  ok(comp.every(b => ['ice', 'rocky'].includes(b.kind)), 'companion moons only roll ice/rocky kinds');
  ok(distant.every(b => ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'].includes(b.kind)), 'distant planets roll from the full kind set');
  ok(near.every(b => ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'].includes(b.kind)), 'near planet rolls from the full kind set');
  ok(distant.every(b => b.detail === 'low'), 'distant planets are low detail');
  ok(moons.every(b => b.detail === 'low'), 'extra moons are low detail');
  ok(near.every(b => b.detail === 'high'), 'near planet is high detail');
  ok(comp.every(b => b.detail === 'high'), 'companion moons are high detail');
  ok(bodies.every(b => b.gas === (b.kind === 'gas')), 'gas boolean stays derived from kind (paintBodySimple compat)');
  ok(bodies.every(b => typeof b.seed === 'number' && b.seed >= 0 && b.seed < 1), 'every body carries a [0,1) seed');
  ok(bodies.every(b => typeof b.color2 === 'string' && b.color2.startsWith('#')), 'every body carries a color2 for multi-hue surface patches');
}

// ---- Celestial body kind variety: all 5 planet kinds appear over many seeds ----
{
  const seen = new Set();
  for (let s = 0; s < 200; s++) {
    const bodies = generateCelestialBodies(1000, makePalette(), makeRng(1000 + s));
    for (const b of bodies) if (b.type === 'planet') seen.add(b.kind);
  }
  ok(['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'].every(k => seen.has(k)), 'all 5 planet kinds appear across 200 seeds');
}

// ---- Palette-driven controls: counts, body scale, Milky Way density ----
{
  // Count overrides pin the generated counts regardless of seed.
  const b = generateCelestialBodies(1000, makePalette({ planetCount: 6, moonCount: 3 }), makeRng(3));
  ok(b.filter(x => x.type === 'planet' && x.scaleClass === 'distant').length === 6, 'planetCount overrides distant-planet count');
  ok(b.filter(x => x.type === 'moon' && !x.companion).length === 3, 'moonCount overrides extra-moon count');
  const zero = generateCelestialBodies(1000, makePalette({ planetCount: 0, moonCount: 0 }), makeRng(3));
  ok(zero.filter(x => x.type === 'planet' && x.scaleClass === 'distant').length === 0, 'planetCount 0 yields no distant planets');
  ok(zero.filter(x => x.type === 'moon' && !x.companion).length === 0, 'moonCount 0 yields no extra moons');

  // bodyScale multiplies every body's size; the near planet stays exactly one near planet.
  const s1 = generateCelestialBodies(1000, makePalette({ bodyScale: 1 }), makeRng(4));
  const s2 = generateCelestialBodies(1000, makePalette({ bodyScale: 2 }), makeRng(4));
  const near1 = s1.find(x => x.scaleClass === 'near'), near2 = s2.find(x => x.scaleClass === 'near');
  ok(approx(near2.size, near1.size * 2, 1e-9), 'bodyScale scales body size linearly');

  // Milky Way density scales the band point count off the star count.
  const mwA = generateMilkyWay(1000, makePalette({ starCount: 1000, milkyWayDensity: 1 }), makeRng(2));
  const mwB = generateMilkyWay(1000, makePalette({ starCount: 1000, milkyWayDensity: 2 }), makeRng(2));
  ok(mwA.bandCount === 1000 && mwB.bandCount === 2000, 'milkyWayDensity scales band count off starCount');
  const mwDefault = generateMilkyWay(1000, makePalette({ starCount: 1000 }), makeRng(2));
  ok(mwDefault.bandCount === 1100, 'unset milkyWayDensity keeps the historic 1.1x');
}

import { DEFAULT_SKY_STATES, makeSkyStates, DEFAULT_THRESHOLDS,
  lerpHex, domeParamsAtElevation, nightnessAtElevation } from './sky-field.js';

// ---- makeSkyStates: per-state defaults-merge, fresh object ----
{
  ok(makeSkyStates().night.top === DEFAULT_SKY_STATES.night.top, 'makeSkyStates() clones defaults');
  ok(makeSkyStates({ day: { top: '#123456' } }).day.top === '#123456', 'makeSkyStates() applies per-state override');
  ok(makeSkyStates({ day: { top: '#123456' } }).day.glowWidth === DEFAULT_SKY_STATES.day.glowWidth, 'unspecified state fields keep defaults');
  ok(makeSkyStates() !== DEFAULT_SKY_STATES, 'makeSkyStates() returns a fresh object');
}

// ---- lerpHex: endpoints exact, midpoint componentwise, identity ----
{
  ok(lerpHex('#000000', '#ffffff', 0) === '#000000', 'lerpHex t=0 returns first color');
  ok(lerpHex('#000000', '#ffffff', 1) === '#ffffff', 'lerpHex t=1 returns second color');
  ok(lerpHex('#000000', '#ffffff', 0.5) === '#808080', 'lerpHex midpoint is componentwise mid');
  ok(lerpHex('#204060', '#204060', 0.37) === '#204060', 'lerpHex of equal colors is identity');
}

// ---- domeParamsAtElevation: anchor identity, interpolation, clamp, determinism ----
{
  const th = DEFAULT_THRESHOLDS;                 // { dayAbove:8, duskPeak:0, nightBelow:-8 }
  const S = DEFAULT_SKY_STATES;
  const atDay   = domeParamsAtElevation(th.dayAbove,   th, S);
  const atDusk  = domeParamsAtElevation(th.duskPeak,   th, S);
  const atNight = domeParamsAtElevation(th.nightBelow, th, S);
  ok(atDay.top === S.day.top && atDay.glowStrength === S.day.glowStrength, 'exact day params at dayAbove');
  ok(atDusk.top === S.dusk.top && atDusk.glowWidth === S.dusk.glowWidth, 'exact dusk params at duskPeak');
  ok(atNight.top === S.night.top && atNight.horizon === S.night.horizon, 'exact night params at nightBelow');
  ok(domeParamsAtElevation(90, th, S).top === S.day.top, 'above dayAbove clamps to day');
  ok(domeParamsAtElevation(-90, th, S).bottom === S.night.bottom, 'below nightBelow clamps to night');
  const mid = domeParamsAtElevation((th.duskPeak + th.dayAbove) / 2, th, S);
  const lo = Math.min(S.dusk.glowStrength, S.day.glowStrength), hi = Math.max(S.dusk.glowStrength, S.day.glowStrength);
  ok(mid.glowStrength > lo && mid.glowStrength < hi, 'dusk<->day glowStrength interpolates between');
  const mid2 = domeParamsAtElevation((th.nightBelow + th.duskPeak) / 2, th, S);
  ok(mid2.glowWidth !== S.night.glowWidth && mid2.glowWidth !== S.dusk.glowWidth, 'night<->dusk params interpolate');
  ok(domeParamsAtElevation(3, th, S).horizon === domeParamsAtElevation(3, th, S).horizon, 'deterministic per elevation');
}

// ---- nightnessAtElevation: endpoints + monotonic non-increasing in elevation ----
{
  const th = DEFAULT_THRESHOLDS;
  ok(nightnessAtElevation(th.dayAbove, th) === 0, 'nightness 0 at dayAbove');
  ok(nightnessAtElevation(20, th) === 0, 'nightness 0 well above dayAbove');
  ok(nightnessAtElevation(th.nightBelow, th) === 1, 'nightness 1 at nightBelow');
  ok(nightnessAtElevation(-20, th) === 1, 'nightness 1 well below nightBelow');
  let mono = true, prev = -Infinity;
  for (let e = 20; e >= -20; e -= 0.5) {          // falling elevation -> non-decreasing nightness
    const n = nightnessAtElevation(e, th);
    if (n < prev - 1e-9) mono = false;
    prev = n;
  }
  ok(mono, 'nightness is monotonic non-decreasing as elevation falls');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
