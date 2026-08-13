// test-bot-viewer-visuals.mjs -- covers the pure half of the bot-viewer visual system
// (bot-viewer-visuals-style.js). The Three/TSL half needs a GPU and is browser-verified.
// Run: node test-bot-viewer-visuals.mjs
import {
  THEMES, THEME_KEYS, DEFAULT_THEME, DEFAULT_TOGGLES, THEME_SECTIONS,
  getTheme, cloneTheme, togglesFor, randomTheme, validateTheme,
  hexToRgb, rgbToHex, lerpHex, shadeHex, hslHex, makeRng, luma,
  normalizeTheme, flashCurve, pickLightSlots, pickLightSlotsInto, poolScaleForHeight,
  hexToHsl, cycleHueHex, fitShadowBox,
  REACTIVE_TARGETS, REACTIVE_KEYS, REACTIVE_MAX, defaultReactiveTargets, reactiveGain, advanceAudioMix,
} from './bot-viewer-visuals-style.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}
function section(t) { console.log(`\n${t}`); }

// ── colour helpers ──────────────────────────────────────────────────────────
section('colour helpers');
check('hexToRgb/rgbToHex round-trip', rgbToHex(...Object.values(hexToRgb(0x39f0ff))) === 0x39f0ff);
check('rgbToHex clamps out-of-range', rgbToHex(2, -1, 0.5) === 0xff0080,
  `got 0x${rgbToHex(2, -1, 0.5).toString(16)}`);
check('lerpHex t=0 is a', lerpHex(0x102030, 0xffffff, 0) === 0x102030);
check('lerpHex t=1 is b', lerpHex(0x102030, 0xffffff, 1) === 0xffffff);
check('lerpHex midpoint', lerpHex(0x000000, 0xffffff, 0.5) === 0x808080,
  `got 0x${lerpHex(0, 0xffffff, 0.5).toString(16)}`);
check('shadeHex(1) is identity', shadeHex(0x39f0ff, 1) === 0x39f0ff);
check('shadeHex(0) is black', shadeHex(0x39f0ff, 0) === 0x000000);
check('shadeHex(2) is white', shadeHex(0x39f0ff, 2) === 0xffffff);
check('hslHex l=0 is black', hslHex(0.3, 1, 0) === 0x000000);
check('hslHex l=1 is white', hslHex(0.3, 1, 1) === 0xffffff);
check('hslHex s=0 is grey', (() => { const g = hexToRgb(hslHex(0.7, 0, 0.5)); return g.r === g.g && g.g === g.b; })());
check('hslHex hue 0 is red-dominant', (() => { const c = hexToRgb(hslHex(0, 1, 0.5)); return c.r > c.g && c.r > c.b; })());
check('hslHex hue 1/3 is green-dominant', (() => { const c = hexToRgb(hslHex(1 / 3, 1, 0.5)); return c.g > c.r && c.g > c.b; })());

// ── rng ─────────────────────────────────────────────────────────────────────
section('rng');
{
  const a = makeRng(42), b = makeRng(42), c = makeRng(43);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()], seqC = [c(), c(), c()];
  check('same seed reproduces the sequence', seqA.every((v, i) => v === seqB[i]));
  check('different seed diverges', seqA.some((v, i) => v !== seqC[i]));
  check('values stay in [0,1)', seqA.every((v) => v >= 0 && v < 1));
}

// ── built-in themes ─────────────────────────────────────────────────────────
section('built-in themes');
check('at least 5 themes ship', THEME_KEYS.length >= 5, `got ${THEME_KEYS.length}`);
check('DEFAULT_THEME exists', THEME_KEYS.includes(DEFAULT_THEME));
for (const key of THEME_KEYS) {
  const t = THEMES[key];
  const errs = validateTheme(t);
  check(`theme "${key}" validates`, errs.length === 0, errs.slice(0, 4).join('; '));
  check(`theme "${key}" key matches its map slot`, t.key === key, `key=${t.key}`);
  check(`theme "${key}" has a label`, typeof t.label === 'string' && t.label.length > 0);
}
// Same readability rule the procedural roller enforces, applied to the hand-authored themes:
// wherever a theme actually turns an emissive accent on, it has to out-luma its surface.
for (const key of THEME_KEYS) {
  const t = THEMES[key];
  const lit = [
    ['trim/wall', t.mats.wall.trimGain, t.mats.wall.trimColor, t.mats.wall.color],
    ['grid/floor', t.mats.floor.gridGain, t.mats.floor.gridColor, t.mats.floor.color],
    ['scan/floor', t.mats.floor.scanGain, t.mats.floor.scanColor, t.mats.floor.color],
    ['cap/cover', t.mats.cover.capGain, t.mats.cover.capColor, t.mats.cover.color],
    ['stripe/cover', t.mats.cover.stripeGain, t.mats.cover.stripeColor, t.mats.cover.color],
  ].filter(([, gain]) => gain > 0);
  const bad = lit.filter(([, , accent, surface]) => luma(accent) - luma(surface) < 0.15)
    .map(([n, , a, s]) => `${n} gap ${(luma(a) - luma(s)).toFixed(3)}`);
  check(`theme "${key}" keeps its lit accents readable`, bad.length === 0, bad.join('; '));
}
check('getTheme falls back for an unknown key', getTheme('nope-not-a-theme').key === DEFAULT_THEME);
check('every section is present in THEME_SECTIONS order',
  THEME_SECTIONS.every((s) => THEMES[DEFAULT_THEME][s] !== undefined));

// ── validation actually rejects ─────────────────────────────────────────────
section('validateTheme rejects malformed themes');
check('null is rejected', validateTheme(null).length > 0);
check('missing section is reported', (() => {
  const t = cloneTheme(THEMES[DEFAULT_THEME]); delete t.mats;
  return validateTheme(t).some((e) => e.includes('mats'));
})());
check('missing leaf field is reported', (() => {
  const t = cloneTheme(THEMES[DEFAULT_THEME]); delete t.mats.wall.trimGain;
  return validateTheme(t).some((e) => e.includes('trimGain'));
})());
check('bad tone operator is reported', (() => {
  const t = cloneTheme(THEMES[DEFAULT_THEME]); t.post.tone = 'filmic';
  return validateTheme(t).some((e) => e.includes('post.tone'));
})());
check('non-numeric bg is reported', (() => {
  const t = cloneTheme(THEMES[DEFAULT_THEME]); t.bg = '#fff';
  return validateTheme(t).some((e) => e.includes('bg'));
})());

// ── cloneTheme isolation ────────────────────────────────────────────────────
section('cloneTheme');
{
  const clone = cloneTheme(THEMES.internetcore);
  clone.mats.wall.trimGain = 999;
  clone.sky.planet.size = 0.99;
  check('mutating a clone does not touch THEMES', THEMES.internetcore.mats.wall.trimGain !== 999);
  check('nested objects are deep-copied', THEMES.internetcore.sky.planet.size !== 0.99);
}

// ── toggles ─────────────────────────────────────────────────────────────────
section('togglesFor');
{
  const base = togglesFor({});
  check('a theme with no toggles gets every default', Object.keys(DEFAULT_TOGGLES).every((k) => base[k] === DEFAULT_TOGGLES[k]));
  const merged = togglesFor(THEMES.hangar);
  check('theme overrides win', merged.sky === false && merged.trim === false);
  check('unspecified keys keep the default', merged.shadows === DEFAULT_TOGGLES.shadows);
  check('every theme toggle key is a known toggle', THEME_KEYS.every((k) =>
    Object.keys(THEMES[k].toggles || {}).every((tk) => tk in DEFAULT_TOGGLES)),
    'a theme declares a toggle the system does not know about');
}

// ── procedural themes ───────────────────────────────────────────────────────
section('randomTheme');
{
  const seeds = [1, 7, 99, 12345, 0xdeadbeef, 2 ** 31, 0];
  for (const s of seeds) {
    const errs = validateTheme(randomTheme(s));
    check(`randomTheme(${s}) validates`, errs.length === 0, errs.slice(0, 4).join('; '));
  }
  const a = JSON.stringify(randomTheme(2024)), b = JSON.stringify(randomTheme(2024));
  check('same seed is reproducible', a === b);
  check('different seeds differ', a !== JSON.stringify(randomTheme(2025)));

  // 200 rolls: every generated look must stay inside the ranges the panel sliders assume,
  // so a roll can never produce a black screen or a blown-out one.
  let worst = null;
  for (let s = 1; s <= 200 && !worst; s++) {
    const t = randomTheme(s * 7919);
    const bad = [];
    if (!(t.post.exposure > 0.5 && t.post.exposure < 2.5)) bad.push(`exposure ${t.post.exposure}`);
    if (!(t.post.bloom.strength >= 0 && t.post.bloom.strength <= 1.2)) bad.push(`bloom ${t.post.bloom.strength}`);
    if (!(t.post.grade.saturation > 0 && t.post.grade.saturation <= 2)) bad.push(`sat ${t.post.grade.saturation}`);
    if (!(t.post.grade.vignette >= 0 && t.post.grade.vignette < 0.85)) bad.push(`vignette ${t.post.grade.vignette}`);
    if (!(t.fog.density > 0 && t.fog.density < 0.08)) bad.push(`fog ${t.fog.density}`);
    if (!(t.sky.planet.size > 0 && t.sky.planet.size < 1)) bad.push(`planet ${t.sky.planet.size}`);
    if (!(t.lights.key.intensity > 0 && t.lights.key.intensity < 6)) bad.push(`key ${t.lights.key.intensity}`);
    if (!(t.mats.floor.roughness >= 0 && t.mats.floor.roughness <= 1)) bad.push(`floor rough ${t.mats.floor.roughness}`);
    if (!(t.mats.wall.metalness >= 0 && t.mats.wall.metalness <= 1)) bad.push(`wall metal ${t.mats.wall.metalness}`);
    if (!(t.mats.floor.reflectRoughness >= 0 && t.mats.floor.reflectRoughness <= 1)) bad.push(`refl rough ${t.mats.floor.reflectRoughness}`);
    if (t.sky.planet.azimuth < 0 || t.sky.planet.azimuth > 360) bad.push(`azimuth ${t.sky.planet.azimuth}`);
    if (bad.length) worst = `seed ${s * 7919}: ${bad.join(', ')}`;
  }
  check('200 rolls stay inside slider ranges', worst === null, worst);

  // A roll must never come out flat -- every emissive accent has to out-luma the surface it
  // sits on, or the neon vanishes into the wall/deck/cover it is supposed to outline.
  let flat = null;
  for (let s = 1; s <= 400 && !flat; s++) {
    const t = randomTheme(s * 104729);
    const pairs = [
      ['trim/wall', t.mats.wall.trimColor, t.mats.wall.color],
      ['grid/floor', t.mats.floor.gridColor, t.mats.floor.color],
      ['cap/cover', t.mats.cover.capColor, t.mats.cover.color],
      ['stripe/cover', t.mats.cover.stripeColor, t.mats.cover.color],
    ];
    for (const [name, accent, surface] of pairs) {
      const gap = luma(accent) - luma(surface);
      if (gap < 0.15) { flat = `seed ${s * 104729}: ${name} luma gap ${gap.toFixed(3)}`; break; }
    }
  }
  check('400 rolls keep every emissive accent readable', flat === null, flat);

  check('random themes only use known toggle keys', (() => {
    for (let s = 1; s <= 50; s++) {
      const t = randomTheme(s * 31);
      for (const k of Object.keys(t.toggles || {})) if (!(k in DEFAULT_TOGGLES)) return false;
    }
    return true;
  })());
}

// ── bot lighting section ────────────────────────────────────────────────────
section('bot lighting theme data');
{
  for (const k of THEME_KEYS) {
    const b = THEMES[k].bots;
    check(`${k} bot glows are non-negative`,
      b.shellGlow >= 0 && b.plateGlow >= 0 && b.trimGlow >= 0 && b.eyeGlow >= 0);
    check(`${k} beam angle stays a sane half-angle`, b.beamAngle > 0 && b.beamAngle < 45,
      `got ${b.beamAngle}`);
    check(`${k} flash life is a real duration`, b.flashLife > 0 && b.flashLife < 1, `got ${b.flashLife}`);
  }
  // The team colour lives in the SHELL parts (plate/trim are authored near-black in this rig), so
  // shellGlow is the term that actually decides whether a bot reads in the dark.
  check('every theme puts the emission on the shell role', THEME_KEYS.every(
    (k) => THEMES[k].bots.shellGlow >= THEMES[k].bots.plateGlow));
  // The readable daylight theme is the one that must NOT add emission on top of real light.
  check('daybreak keeps bot emission off', THEMES.daybreak.bots.shellGlow <= 0.15
    && THEMES.daybreak.bots.poolGain === 0);
  // Blacksite is the darkest rig, so it must be the one leaning hardest on self-lighting.
  check('blacksite leans hardest on bot emission',
    THEMES.blacksite.bots.shellGlow >= Math.max(...THEME_KEYS.map((k) => THEMES[k].bots.shellGlow)));

  // A muzzle flash is burning propellant, so it is warm on EVERY map — it is the one bot-lighting
  // colour that must not follow the theme accent. Warm here means an incandescent ramp: red is the
  // strongest channel, blue the weakest. (The first cut keyed it to the palette, which gave
  // internetcore a blue flash and toxic a green one.)
  const isWarm = (hex) => {
    const { r, g, b } = hexToRgb(hex);
    return r > b && r >= g && g >= b;
  };
  for (const k of THEME_KEYS) {
    check(`${k} muzzle flash is a warm colour`, isWarm(THEMES[k].bots.flashColor),
      `got #${THEMES[k].bots.flashColor.toString(16).padStart(6, '0')}`);
  }
  check('flashes are warm on 300 random rolls', (() => {
    for (let s = 1; s <= 300; s++) if (!isWarm(randomTheme(s * 7919).bots.flashColor)) return false;
    return true;
  })());

  // The tint is the deliberate escape hatch from the warmth rule, so it is exempt from isWarm —
  // but it still has to be present and sane on every theme or the picker has nothing to bind to.
  for (const k of THEME_KEYS) {
    const b = THEMES[k].bots;
    check(`${k} ships a flash tint colour`, Number.isInteger(b.flashTintColor)
      && b.flashTintColor >= 0 && b.flashTintColor <= 0xffffff);
    check(`${k} flash hue cycle is a sane rate`, b.flashTintCycle >= 0 && b.flashTintCycle <= 2,
      `got ${b.flashTintCycle}`);
  }
  check('coloured flashes are off by default', DEFAULT_TOGGLES.flashTint === false);
  check('random rolls keep the hue cycle in range', (() => {
    for (let s = 1; s <= 200; s++) {
      const b = randomTheme(s * 104729).bots;
      if (!(b.flashTintCycle >= 0 && b.flashTintCycle <= 2)) return false;
      if (!Number.isInteger(b.flashTintColor)) return false;
    }
    return true;
  })());

  // The visor has its own colour slot rather than borrowing bots.rimColor, so a theme can pair a
  // warm rim with a cold visor. Every theme must fill it or the material renders black.
  for (const k of THEME_KEYS) {
    const b = THEMES[k].bots;
    check(`${k} ships a visor colour`, Number.isInteger(b.eyeColor)
      && b.eyeColor >= 0 && b.eyeColor <= 0xffffff, `got ${b.eyeColor}`);
  }
  check('the slot is actually used — some theme diverges from its rim',
    THEME_KEYS.some((k) => THEMES[k].bots.eyeColor !== THEMES[k].bots.rimColor));
  check('random rolls pair visor and rim rather than repeating one colour', (() => {
    let paired = 0;
    for (let s = 1; s <= 200; s++) {
      const b = randomTheme(s * 15485863).bots;
      if (!Number.isInteger(b.eyeColor)) return false;
      if (b.eyeColor !== b.rimColor) paired++;
    }
    return paired > 190;   // accent and second can collide, but only rarely
  })());

  check('validateTheme rejects a theme with no bots section', (() => {
    const t = cloneTheme(THEMES.internetcore);
    delete t.bots;
    return validateTheme(t).length > 0;
  })());
  check('validateTheme rejects a partial bots section', (() => {
    const t = cloneTheme(THEMES.internetcore);
    delete t.bots.beamAngle;
    return validateTheme(t).some((e) => e.includes('beamAngle'));
  })());

  let badRoll = null;
  for (let s = 1; s <= 200 && !badRoll; s++) {
    const b = randomTheme(s * 7919).bots;
    if (!(b.beamAngle > 0 && b.beamAngle < 45)) badRoll = `seed ${s * 7919}: beamAngle ${b.beamAngle}`;
    else if (!(b.flashLife > 0 && b.flashLife < 1)) badRoll = `seed ${s * 7919}: flashLife ${b.flashLife}`;
    else if (b.poolGain < 0 || b.poolRadius <= 0) badRoll = `seed ${s * 7919}: pool ${b.poolGain}/${b.poolRadius}`;
  }
  check('200 rolls produce usable bot lighting', badRoll === null, badRoll);
}

section('normalizeTheme (legacy look slots)');
{
  const legacy = cloneTheme(THEMES.internetcore);
  delete legacy.bots;                       // a slot saved before the section existed
  const fixed = normalizeTheme(legacy);
  check('backfills a missing section', validateTheme(fixed).length === 0,
    validateTheme(fixed).join(', '));
  check('backfilled section is a copy, not a shared reference', (() => {
    const a = normalizeTheme(legacy), b2 = normalizeTheme(legacy);
    a.bots.trimGlow = 99;
    return b2.bots.trimGlow !== 99 && THEMES[DEFAULT_THEME].bots.trimGlow !== 99;
  })());
  check('backfills a single missing key', (() => {
    const t = cloneTheme(THEMES.noir);
    delete t.bots.beamAngle;
    return normalizeTheme(t).bots.beamAngle === THEMES[DEFAULT_THEME].bots.beamAngle;
  })());
  check('keeps every value the theme did supply', (() => {
    const t = cloneTheme(THEMES.toxic);
    delete t.bots;
    const n = normalizeTheme(t);
    return n.mats.wall.trimColor === THEMES.toxic.mats.wall.trimColor && n.bg === THEMES.toxic.bg;
  })());
  check('a complete theme survives untouched', () => true
    && JSON.stringify(normalizeTheme(THEMES.orbital)) === JSON.stringify(cloneTheme(THEMES.orbital)));
  check('garbage in still yields a valid theme', validateTheme(normalizeTheme(null)).length === 0);
  // A look state saved before the visor slot existed had its visor painted with the rim colour.
  // The generic backfill would hand it the DEFAULT theme's visor instead, silently repainting
  // somebody's saved theme, so eyeColor gets restored from the save's own rim.
  check('a pre-visor save keeps its own visor colour', (() => {
    const t = cloneTheme(THEMES.toxic);
    delete t.bots.eyeColor;
    return normalizeTheme(t).bots.eyeColor === THEMES.toxic.bots.rimColor;
  })());
  check('that fallback does not fire when the save has a visor', (() => {
    const t = cloneTheme(THEMES.blacksite);
    return normalizeTheme(t).bots.eyeColor === THEMES.blacksite.bots.eyeColor;
  })());
}

section('fitShadowBox');
{
  const box = (w, d, cx = 0, cz = 0) => ({
    minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2,
  });
  const f = fitShadowBox(box(30, 30), 10);
  check('centres on the arena', f.cx === 0 && f.cz === 0);
  check('lifts the aim point to mid-height', f.cy === 5);
  check('half-extent covers the bounding sphere',
    Math.abs(f.radius - 0.5 * Math.hypot(30, 30, 10)) < 1e-9, `got ${f.radius}`);
  check('light sits outside the sphere by the margin', Math.abs(f.dist - (f.radius + 10)) < 1e-9);
  check('near/far bracket the whole sphere', f.near <= f.dist - f.radius + 1e-9
    && f.far >= f.dist + f.radius - 1e-9);
  check('near never goes non-positive', fitShadowBox(box(4, 4), 2, 0).near > 0);

  // The regression this replaced: a fixed +/-12 box aimed at the origin, with far 40 while the
  // light sat 50 out. Both failures have to be impossible for any layout the viewer can build.
  const corner = (b, fit) => Math.hypot(b.maxX - fit.cx, b.maxZ - fit.cz);
  let bad = null;
  for (const [w, d, cx, cz] of [[20, 20, 0, 0], [30, 30, 0, 0], [30, 30, 40, -25], [60, 12, -8, 8], [6, 6, 0, 0]]) {
    const b = box(w, d, cx, cz), fit = fitShadowBox(b, 10);
    if (corner(b, fit) > fit.radius) bad = `${w}x${d} at ${cx},${cz}: corner outside ortho box`;
    // Everything in the arena lies within `radius` of the aim point, so the far plane must clear it.
    else if (fit.far < fit.dist + corner(b, fit)) bad = `${w}x${d} at ${cx},${cz}: arena past far plane`;
    else if (fit.near > fit.dist - corner(b, fit)) bad = `${w}x${d} at ${cx},${cz}: arena in front of near plane`;
  }
  check('every layout shape is fully inside the frustum', bad === null, bad);
  check('an off-centre arena moves the light with it', (() => {
    const fit = fitShadowBox(box(30, 30, 40, -25), 10);
    return fit.cx === 40 && fit.cz === -25;
  })());
  check('a bigger arena gets a bigger box', fitShadowBox(box(60, 60), 10).radius
    > fitShadowBox(box(30, 30), 10).radius);
}

section('flashCurve');
{
  check('peaks at age 0', flashCurve(0, 0.08) === 1);
  check('zero at end of life', flashCurve(0.08, 0.08) === 0);
  check('zero past end of life', flashCurve(0.2, 0.08) === 0);
  check('zero for a negative age', flashCurve(-0.01, 0.08) === 0);
  check('zero for a zero life', flashCurve(0, 0) === 0);
  check('decays monotonically', (() => {
    let prev = Infinity;
    for (let a = 0; a < 0.08; a += 0.002) {
      const v = flashCurve(a, 0.08);
      if (v > prev) return false;
      prev = v;
    }
    return true;
  })());
  check('decays faster than linear (a discharge, not a lamp)', flashCurve(0.04, 0.08) < 0.5);
}

section('pickLightSlots');
{
  const reqs = [{ weight: 1, id: 'a' }, { weight: 9, id: 'b' }, { weight: 5, id: 'c' }];
  check('returns the loudest first', pickLightSlots(reqs, 3).map((r) => r.id).join('') === 'bca');
  check('honours capacity', pickLightSlots(reqs, 2).map((r) => r.id).join('') === 'bc');
  check('capacity above the request count is fine', pickLightSlots(reqs, 99).length === 3);
  check('zero capacity yields nothing', pickLightSlots(reqs, 0).length === 0);
  check('non-array input yields nothing', pickLightSlots(null, 4).length === 0);
  check('does not mutate the input order', reqs[0].id === 'a' && reqs[1].id === 'b');
  // A tie must not let a newcomer evict an equal light already burning, or the pool strobes.
  check('ties keep insertion order', (() => {
    const tied = [{ weight: 4, id: 'old' }, { weight: 4, id: 'new' }];
    return pickLightSlots(tied, 1)[0].id === 'old';
  })());
}

// The per-frame path is the *Into variant; the sort-and-slice form allocated 3 arrays plus a
// wrapper per request on every frame of every firefight. It must agree exactly with the old one.
section('pickLightSlotsInto (allocation-free)');
{
  const out = [];
  const reqs = [{ weight: 1, id: 'a' }, { weight: 9, id: 'b' }, { weight: 5, id: 'c' }];
  check('same order as pickLightSlots', pickLightSlotsInto(reqs, 3, out).map((r) => r.id).join('') === 'bca');
  check('returns the caller array', pickLightSlotsInto(reqs, 3, out) === out);
  check('honours capacity', pickLightSlotsInto(reqs, 2, out).map((r) => r.id).join('') === 'bc');
  check('reusing the array clears the previous pick', out.length === 2);
  check('zero capacity empties the array', pickLightSlotsInto(reqs, 0, out).length === 0);
  check('non-array input empties the array', pickLightSlotsInto(null, 4, out).length === 0);
  check('does not mutate the input order', reqs[0].id === 'a' && reqs[1].id === 'b');
  check('ties keep insertion order', (() => {
    const tied = [{ weight: 4, id: 'old' }, { weight: 4, id: 'new' }];
    return pickLightSlotsInto(tied, 1, out)[0].id === 'old';
  })());
  // Fuzz against the reference implementation — insertion sort is easy to get subtly wrong at the
  // capacity boundary, and the failure mode (a flash silently never lit) is invisible in motion.
  check('agrees with the reference over 500 random cases', (() => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
    for (let t = 0; t < 500; t++) {
      const n = Math.floor(rnd() * 9);
      const cap = 1 + Math.floor(rnd() * 5);
      const list = [];
      for (let i = 0; i < n; i++) list.push({ weight: Math.floor(rnd() * 4), id: i });
      const a = pickLightSlots(list, cap).map((r) => r.id).join(',');
      const b = pickLightSlotsInto(list, cap, out).map((r) => r.id).join(',');
      if (a !== b) return false;
    }
    return true;
  })());
}

section('hue wheel (hexToHsl / cycleHueHex)');
{
  const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
  check('pure red is hue 0', near(hexToHsl(0xff0000).h, 0));
  check('pure green is hue 1/3', near(hexToHsl(0x00ff00).h, 1 / 3));
  check('pure blue is hue 2/3', near(hexToHsl(0x0000ff).h, 2 / 3));
  check('grey has no hue and no saturation', (() => {
    const c = hexToHsl(0x808080);
    return c.s === 0 && c.h === 0 && near(c.l, 0.5);
  })());
  check('black and white survive', hexToHsl(0x000000).l === 0 && hexToHsl(0xffffff).l === 1);
  // Round-tripping through hslHex is what the cycle relies on, so it must not drift the colour.
  check('hexToHsl -> hslHex round-trips the built-in flash tints', THEME_KEYS.every((k) => {
    const hex = THEMES[k].bots.flashTintColor;
    const c = hexToHsl(hex);
    const back = hslHex(c.h, c.s, c.l);
    const a = hexToRgb(hex), b = hexToRgb(back);
    return near(a.r, b.r, 0.01) && near(a.g, b.g, 0.01) && near(a.b, b.b, 0.01);
  }));
  check('a zero rotation is the identity', cycleHueHex(0x39f0ff, 0) === 0x39f0ff);
  check('a full turn returns to the start', (() => {
    const out = cycleHueHex(0x39f0ff, 1);
    const a = hexToRgb(0x39f0ff), b = hexToRgb(out);
    return near(a.r, b.r, 0.01) && near(a.g, b.g, 0.01) && near(a.b, b.b, 0.01);
  })());
  check('a third of a turn moves red toward green', (() => {
    const c = hexToHsl(cycleHueHex(0xff0000, 1 / 3));
    return near(c.h, 1 / 3);
  })());
  // The cycle is driven by elapsed*rate, which grows without bound — negatives and large turns
  // both have to wrap rather than clamp, or the flash colour would stick at one end of the wheel.
  check('large and negative rotations wrap', (() => {
    const a = hexToHsl(cycleHueHex(0xff0000, 37.25)).h;
    const b = hexToHsl(cycleHueHex(0xff0000, -0.75)).h;
    return near(a, 0.25) && near(b, 0.25);
  })());
  check('rotation preserves saturation and lightness', (() => {
    const src = hexToHsl(0x7dff5a), out = hexToHsl(cycleHueHex(0x7dff5a, 0.42));
    return near(src.s, out.s, 0.02) && near(src.l, out.l, 0.02);
  })());
}

section('poolScaleForHeight');
{
  check('a standing bot gets the base scale', Math.abs(poolScaleForHeight(1.7) - 0.9) < 1e-9);
  check('a crouched bot spreads wider', poolScaleForHeight(1.0) > poolScaleForHeight(1.7));
  check('a prone bot spreads wider still', poolScaleForHeight(0.5) > poolScaleForHeight(1.0));
  check('never exceeds the clamp', poolScaleForHeight(0.001) <= 1.6);
  check('taller than standing does not shrink below base',
    Math.abs(poolScaleForHeight(3.0) - 0.9) < 1e-9);
  check('degenerate heights fall back to 1', poolScaleForHeight(0) === 1 && poolScaleForHeight(-2) === 1);
  check('monotonically decreasing in height', (() => {
    let prev = Infinity;
    for (let h = 0.2; h <= 2.0; h += 0.05) {
      const v = poolScaleForHeight(h);
      if (v > prev + 1e-12) return false;
      prev = v;
    }
    return true;
  })());
}

// ── audio-reactive routing ──────────────────────────────────────────────────
const BANDS = ['bass', 'mid', 'treble', 'level', 'beat'];
const mixOf = (o = {}) => ({ bass: 0, mid: 0, treble: 0, level: 0, beat: 0, ...o });

section('REACTIVE_TARGETS table');
{
  check('REACTIVE_KEYS mirrors the table', REACTIVE_KEYS.join(',') === Object.keys(REACTIVE_TARGETS).join(','));
  check('every target is actually driven by something', REACTIVE_KEYS.every(
    k => BANDS.some(b => (REACTIVE_TARGETS[k][b] || 0) > 0)));
  check('no negative weights or depths', REACTIVE_KEYS.every(k => {
    const t = REACTIVE_TARGETS[k];
    return BANDS.every(b => (t[b] || 0) >= 0) && t.depth > 0;
  }));
  check('every target carries a label and a hint for the panel', REACTIVE_KEYS.every(
    k => typeof REACTIVE_TARGETS[k].label === 'string' && typeof REACTIVE_TARGETS[k].hint === 'string'));
  // The point of the routing table: the scene must not move as one blob. Kick-only music has to
  // leave the bots alone, and a hi-hat has to leave the corner lights alone.
  check('a pure kick does not move the bots', reactiveGain(mixOf({ bass: 1 }), REACTIVE_TARGETS.bots, 1) === 0);
  check('pure treble does not move the accent lights', reactiveGain(mixOf({ treble: 1 }), REACTIVE_TARGETS.lights, 1) === 0);
}

section('defaultReactiveTargets');
{
  const d = defaultReactiveTargets();
  check('covers every routed group', REACTIVE_KEYS.every(k => typeof d[k] === 'boolean'));
  check('sky is opt-in, the rest ship on', d.sky === false && d.lights && d.bloom && d.neon && d.bots);
  d.lights = false;
  check('hands back a fresh object each call', defaultReactiveTargets().lights === true);
}

section('reactiveGain');
{
  // The two pre-existing groups must be bit-for-bit what the single-envelope version did, or
  // switching to the table silently retunes a look people already dialled in.
  check('lights reproduces the original bass*0.9 + beat*0.7',
    Math.abs(reactiveGain(mixOf({ bass: 0.5, beat: 0.2 }), REACTIVE_TARGETS.lights, 1) - (0.5 * 0.9 + 0.2 * 0.7)) < 1e-12);
  check('bloom reproduces the original level*0.5 + beat*0.35',
    Math.abs(reactiveGain(mixOf({ level: 0.6, beat: 0.4 }), REACTIVE_TARGETS.bloom, 1) - (0.6 * 0.5 + 0.4 * 0.35)) < 1e-12);

  check('silence is no boost at all', reactiveGain(mixOf(), REACTIVE_TARGETS.lights, 1) === 0);
  check('drive 0 disables the group', reactiveGain(mixOf({ bass: 1 }), REACTIVE_TARGETS.lights, 0) === 0);
  check('negative or non-finite drive reads as 0',
    reactiveGain(mixOf({ bass: 1 }), REACTIVE_TARGETS.lights, -3) === 0
    && reactiveGain(mixOf({ bass: 1 }), REACTIVE_TARGETS.lights, NaN) === 0);
  check('missing mix or weights is 0, not NaN',
    reactiveGain(null, REACTIVE_TARGETS.lights, 1) === 0 && reactiveGain(mixOf({ bass: 1 }), null, 1) === 0);
  check('a mix missing fields treats them as 0',
    Math.abs(reactiveGain({ bass: 1 }, REACTIVE_TARGETS.lights, 1) - 0.9) < 1e-12);

  check('depth scales the group', (() => {
    const raw = 0.55 + 0.25 + 0.5;                    // neon's bass+mid+beat at full
    const g = reactiveGain(mixOf({ bass: 1, mid: 1, beat: 1 }), REACTIVE_TARGETS.neon, 1);
    return Math.abs(g - raw * REACTIVE_TARGETS.neon.depth) < 1e-12;
  })());

  check('monotonically increasing in drive', (() => {
    const m = mixOf({ bass: 0.3, beat: 0.2 });
    let prev = -1;
    for (let d = 0; d <= 2.5; d += 0.1) {
      const g = reactiveGain(m, REACTIVE_TARGETS.lights, d);
      if (g < prev - 1e-12) return false;
      prev = g;
    }
    return true;
  })());

  // Without the clamp, a loud passage at max drive takes neon to ~4x and the map goes white.
  check('clamped at REACTIVE_MAX however loud and however hard the drive', REACTIVE_KEYS.every(
    k => reactiveGain(mixOf({ bass: 1, mid: 1, treble: 1, level: 1, beat: 1 }), REACTIVE_TARGETS[k], 100) <= REACTIVE_MAX + 1e-12));
  check('full-scale everything at max drive does reach the clamp',
    Math.abs(reactiveGain(mixOf({ bass: 1, mid: 1, treble: 1, level: 1, beat: 1 }), REACTIVE_TARGETS.lights, 2.5) - REACTIVE_MAX) < 1e-12);
}

section('advanceAudioMix');
{
  check('mutates in place and returns the same object', (() => {
    const m = mixOf();
    return advanceAudioMix(m, { bass: 1 }, 1 / 60) === m && m.bass > 0;
  })());

  check('rises toward the input without overshooting', (() => {
    const m = mixOf();
    for (let i = 0; i < 600; i++) {
      advanceAudioMix(m, { bass: 0.6, mid: 0.6, treble: 0.6, level: 0.6, beat: 0.6 }, 1 / 60);
      if (m.bass > 0.6 + 1e-9) return false;
    }
    return Math.abs(m.bass - 0.6) < 1e-3 && Math.abs(m.level - 0.6) < 1e-3;
  })());

  // This is what makes switching the feature off fade rather than cut: the caller stops handing
  // over levels and the mix walks itself back down.
  check('null levels decay the mix monotonically to rest', (() => {
    const m = mixOf({ bass: 1, mid: 1, treble: 1, level: 1, beat: 1 });
    let prev = Infinity;
    for (let i = 0; i < 600; i++) {
      advanceAudioMix(m, null, 1 / 60);
      if (m.bass > prev + 1e-12) return false;
      prev = m.bass;
    }
    return BANDS.every(b => m[b] < 1e-3);
  })());

  check('a beat lands faster than a band swells', (() => {
    const m = mixOf();
    advanceAudioMix(m, { bass: 1, beat: 1 }, 1 / 60);
    return m.beat > m.bass;
  })());

  check('fields absent from levels decay rather than hold', (() => {
    const m = mixOf({ treble: 1 });
    advanceAudioMix(m, { bass: 1 }, 1 / 60);
    return m.treble < 1 && m.bass > 0;
  })());

  check('dt 0 / negative / non-finite is a no-op', (() => {
    const base = mixOf({ bass: 0.4, beat: 0.2 });
    for (const dt of [0, -1, NaN, undefined]) {
      const m = { ...base };
      advanceAudioMix(m, { bass: 1, beat: 1 }, dt);
      if (BANDS.some(b => Math.abs(m[b] - base[b]) > 1e-12)) return false;
    }
    return true;
  })());

  check('a huge dt snaps to the target instead of overshooting', (() => {
    const m = mixOf({ bass: 1 });
    advanceAudioMix(m, { bass: 0.2, beat: 0.5 }, 10);
    return Math.abs(m.bass - 0.2) < 1e-12 && Math.abs(m.beat - 0.5) < 1e-12;
  })());
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
