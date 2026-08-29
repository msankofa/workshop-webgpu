// test-base-game-sky.mjs — the stellar sky controls in base-game.html.
//
// Three things are worth a guard here. (1) Determinism: two clients that agree on skySeed must
// generate byte-identical bodies, or the "planets are landmarks" argument for sharing the seed is
// void. (2) The shared/local split in the protocol. (3) The wiring class of every control: a
// rebuild-class setting on a live 'input' slider is the WebGPU slider-rebuild crash, so the page
// source itself is checked for which builder each sky key uses.
import { readFile } from 'fs/promises';
import { makeRng, makePalette, generateCelestialBodies, generateStars } from './sky-field.js';
import { BASE_GAME_SHARED_KEYS, sanitizeBaseGameWorldPatch } from './base-game-protocol.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ', m); } else { fail++; console.log('FAIL', m); } };

// ---- 1. determinism: same seed -> same sky, using the exact salts sky.js uses ----
{
  const palette = makePalette({ seed: 987654321, planetCount: 4, moonCount: 3, bodyScale: 1.5 });
  const roll = () => generateCelestialBodies(1000, palette, makeRng((987654321 ^ 0xc0de) >>> 0));
  ok(JSON.stringify(roll()) === JSON.stringify(roll()), 'the same skySeed generates identical celestial bodies');
  const other = generateCelestialBodies(1000, palette, makeRng((11111 ^ 0xc0de) >>> 0));
  ok(JSON.stringify(other) !== JSON.stringify(roll()), 'a different seed generates a different sky');
  const stars = () => generateStars(1000, makePalette({ starCount: 500 }), makeRng((42 ^ 0x5a17) >>> 0));
  ok(JSON.stringify(stars()) === JSON.stringify(stars()), 'the star field is deterministic for a seed too');
}

// ---- 2. count and scale overrides are honored ----
{
  const rng = () => makeRng(7);
  const bodies = generateCelestialBodies(1000, makePalette({ planetCount: 5, moonCount: 2 }), rng());
  ok(bodies.filter(b => b.type === 'planet' && b.scaleClass === 'distant').length === 5, 'planetCount overrides the distant-planet roll');
  ok(bodies.filter(b => b.type === 'moon' && !b.companion).length === 2, 'moonCount overrides the extra-moon roll');
  ok(bodies.filter(b => b.scaleClass === 'near').length === 1, 'exactly one near planet regardless of counts');
  const zero = generateCelestialBodies(1000, makePalette({ planetCount: 0, moonCount: 0 }), rng());
  ok(zero.filter(b => b.scaleClass === 'distant').length === 0 && zero.filter(b => b.type === 'moon' && !b.companion).length === 0,
    'zero counts empty their categories');
  const small = generateCelestialBodies(1000, makePalette({ planetCount: 3, moonCount: 1, bodyScale: 1 }), rng());
  const big = generateCelestialBodies(1000, makePalette({ planetCount: 3, moonCount: 1, bodyScale: 2 }), rng());
  ok(small.every((b, i) => Math.abs(big[i].size - b.size * 2) < 1e-9), 'bodyScale multiplies every generated size');
}

// ---- 3. the shared/local split ----
for (const key of ['skySeed', 'skyPlanetCount', 'skyMoonCount', 'skyBodyScale', 'skyMilkyWay']) {
  ok(BASE_GAME_SHARED_KEYS.includes(key), `${key} is owner-owned`);
}
for (const key of ['skyStarCount', 'skyStarOpacity', 'skyStarColor', 'skyMilkyWayDensity', 'skyMilkyWayIntensity',
  'skySunColor', 'skySunSize', 'skySunOpacity', 'skyMoonColor', 'skyMoonSize', 'skyMoonOpacity', 'skyBodyResolution']) {
  ok(!BASE_GAME_SHARED_KEYS.includes(key), `${key} stays local`);
}

// ---- 4. the wire sanitizer ----
{
  const clean = sanitizeBaseGameWorldPatch({ skySeed: 1234.6, skyPlanetCount: 99, skyMoonCount: -3, skyBodyScale: 0, skyMilkyWay: false, skyStarColor: '#123456' });
  ok(clean.skySeed === 1235, 'the seed rounds on the wire');
  ok(clean.skyPlanetCount === 16, 'an absurd planet count clamps to the ceiling');
  ok(clean.skyMoonCount === 0, 'a negative moon count clamps to 0');
  ok(clean.skyBodyScale === 0.1, 'a zero body scale clamps to the floor');
  ok(clean.skyMilkyWay === false, 'the Milky Way flag passes as a boolean');
  ok(!('skyStarColor' in clean), 'a local look key is rejected from the patch');
}

// ---- 5. the page wiring: rebuild-class keys are never live sliders ----
const html = await readFile('./base-game.html', 'utf8');
const rebuildKeys = [...(html.match(/const SKY_REBUILD_KEYS = \[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/'(\w+)'/g)].map(m => m[1]);
const liveKeys = [...(html.match(/const SKY_LIVE_KEYS = \{([\s\S]*?)\n\};/)?.[1] ?? '').matchAll(/\n\s*(\w+):/g)].map(m => m[1]);
ok(rebuildKeys.length === 7, `the applier names seven rebuild keys (found ${rebuildKeys.length})`);
ok(liveKeys.length === 10, `the applier names ten live keys (found ${liveKeys.length})`);
for (const key of rebuildKeys.filter(k => k !== 'skyMilkyWay')) {
  ok(new RegExp(`addCommitRange\\([^)]*'${key}'`).test(html), `${key} is wired commit-on-release`);
  ok(!new RegExp(`addRange\\([^)]*'${key}'`).test(html), `${key} is NOT wired to a live-drag slider`);
}
ok(/addToggle\([^)]*'skyMilkyWay'/.test(html), 'skyMilkyWay is a toggle (a discrete click, not a drag)');
for (const key of liveKeys) {
  ok(new RegExp(`add(Range|Color)\\([^)]*'${key}'`).test(html), `${key} has a live control`);
}
// The commit slider's 'input' handler must only update the readout — no settings write, no changed().
const commitBody = html.match(/function addCommitRange\(([\s\S]*?)\n\}/)?.[0] ?? '';
const inputLine = commitBody.match(/addEventListener\('input',([^\n]*)/)?.[1] ?? 'MISSING';
ok(!/settings\[|changed\(/.test(inputLine), "addCommitRange's drag handler never commits the setting");
ok(/addEventListener\('change'/.test(commitBody), 'addCommitRange commits on release');
// One rebuild path: setPalette is called exactly once in the page, from the diff applier.
ok((html.match(/sky\.setPalette\(/g) ?? []).length === 1, 'sky.setPalette has exactly one call site (the applier)');
ok(/bodies: true/.test(html.match(/function skyPaletteOverrides[\s\S]*?\n\}/)?.[0] ?? ''), 'the palette keeps bodies when the shared Milky Way is off');

// ---- 6. sky.js: the new live setters avoid the dispose race by construction ----
const skySrc = await readFile('./sky.js', 'utf8');
ok(/palette\.milkyWay \|\| palette\.bodies === true/.test(skySrc), 'sky.js gates bodies on milkyWay OR the explicit bodies flag');
for (const name of ['setMoonSize', 'setSunColor', 'setMoonColor', 'setSunOpacity', 'setMoonOpacity']) {
  ok(new RegExp(`${name}\\(`).test(skySrc), `sky.js exposes ${name}`);
}
const colorSetters = skySrc.match(/setSunColor[\s\S]*?setMoonColor[^\n]*\n/)?.[0] ?? '';
ok(/needsUpdate = true/.test(colorSetters) && !/dispose/.test(colorSetters), 'disc colour repaints in place (needsUpdate), never disposes');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
