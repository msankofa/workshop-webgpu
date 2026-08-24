// Weapon accuracy tuning: the file shape, the clamps, and that the numbers actually reach the cone
// base-game-fire.js draws. The point of the module is that the relay and the page agree, so what is
// tested here is that one setter moves both the dispersion and the recoil climb.
import { readFileSync } from 'node:fs';
import {
  SHOT_SPREAD_DEFAULTS, SHOT_SPREAD_LIMITS, SHOT_SPREAD_KEYS, SHOT_SPREAD_PATH, SHOT_SPREAD_VERSION,
  normalizeShotSpread, shotSpreadFile,
} from './shot-spread.js';
import { createTriggerState, stepTrigger, shotDirectionFor, setShotSpread, getShotSpread, lookDirection } from './base-game-fire.js';
import { createAmmoStore } from './player-ammo.js';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };

// ---- the data ----
ok(SHOT_SPREAD_KEYS.every(key => Array.isArray(SHOT_SPREAD_LIMITS[key])), 'every tunable has a range');
ok(Object.isFrozen(SHOT_SPREAD_DEFAULTS), 'the fallback defaults cannot be mutated by a caller');
{
  const clamped = normalizeShotSpread({ spreadScale: 1e9, moveSpreadDeg: -5, settleMs: 'nonsense', bloomMaxDeg: 6 });
  ok(clamped.spreadScale === SHOT_SPREAD_LIMITS.spreadScale[1], 'a value over the range is clamped, not rejected');
  ok(clamped.moveSpreadDeg === 0, 'a negative value clamps to the floor');
  ok(clamped.settleMs === SHOT_SPREAD_DEFAULTS.settleMs, 'a non-numeric value falls back to the default');
  ok(clamped.bloomMaxDeg === 6, 'a value inside the range survives');
  ok(SHOT_SPREAD_KEYS.every(key => Number.isFinite(clamped[key])), 'the result is always complete and finite');
}
ok(normalizeShotSpread(null).moveSpreadDeg === SHOT_SPREAD_DEFAULTS.moveSpreadDeg, 'no file at all gives the built-in defaults');
ok(normalizeShotSpread({ spread: { spreadScale: 2 } }).spreadScale === 2, 'a saved file is read through its `spread` block');
{
  const file = shotSpreadFile({ spreadScale: 3 });
  ok(file.version === SHOT_SPREAD_VERSION && file.spread.spreadScale === 3 && typeof file.savedAt === 'string', 'the saved file carries a version, a stamp and the clamped numbers');
  ok(normalizeShotSpread(JSON.parse(JSON.stringify(file))).spreadScale === 3, 'a saved file round-trips through JSON');
}

// ---- the committed file is real, and is what the relay and the page will load ----
{
  const raw = JSON.parse(readFileSync(new URL(`./${SHOT_SPREAD_PATH}`, import.meta.url), 'utf8'));
  const loaded = normalizeShotSpread(raw);
  ok(raw.version === SHOT_SPREAD_VERSION, `${SHOT_SPREAD_PATH} is the version this build reads`);
  ok(SHOT_SPREAD_KEYS.every(key => Number.isFinite(loaded[key])), 'the committed file normalizes to a complete set');
}

// ---- the numbers reach the cone ----
const off = (dir, yaw, pitch) => { const look = lookDirection(yaw, pitch); return Math.acos(Math.min(1, dir[0] * look[0] + dir[1] * look[1] + dir[2] * look[2])); };
const widest = (seedFrom, seedTo) => {
  let max = 0;
  for (let tick = seedFrom; tick <= seedTo; tick++) max = Math.max(max, off(shotDirectionFor(createTriggerState(), { yaw: 0.2, pitch: 0.1, weaponId: 'cz_805_bren', tick, seed: 5 }), 0.2, 0.1));
  return max;
};
try {
  setShotSpread(SHOT_SPREAD_DEFAULTS);
  const before = widest(1, 60);
  setShotSpread({ ...SHOT_SPREAD_DEFAULTS, spreadScale: 6 });
  ok(widest(1, 60) > before, 'raising the weapon cone multiplier widens the shot');
  ok(getShotSpread().spreadScale === 6, 'the setter is readable back');

  // Recoil climb: bloom after a burst follows bloomPerShotDeg / bloomMaxDeg.
  const burst = (spread) => {
    setShotSpread(spread);
    const ammo = createAmmoStore(), trigger = createTriggerState();
    for (let tick = 1; tick <= 40; tick++) stepTrigger(trigger, ammo, { playerId: 'p', weaponId: 'cz_805_bren', tick, fire: true, reload: false, aim: true });
    return trigger.bloomDeg;
  };
  const slow = burst({ ...SHOT_SPREAD_DEFAULTS, bloomPerShotDeg: 0.1 });
  const fast = burst({ ...SHOT_SPREAD_DEFAULTS, bloomPerShotDeg: 1.5 });
  ok(fast > slow, 'more recoil per shot climbs the cone faster over the same burst');
  ok(burst({ ...SHOT_SPREAD_DEFAULTS, bloomPerShotDeg: 1.5, bloomMaxDeg: 0.5 }) <= 0.5 + 1e-9, 'the recoil cap holds the climb');
  ok(normalizeShotSpread(getShotSpread()).bloomMaxDeg === 0.5, 'the live values round-trip through the normalizer');
} finally {
  setShotSpread(SHOT_SPREAD_DEFAULTS);   // other suites in the same process expect the shipped cone
}

// ---- wiring ----
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  for (const marker of ['shot-spread.js', 'loadShotSpread(', 'saveShotSpread(', 'applyShotSpread(', 'Weapon spread']) {
    ok(html.includes(marker), `base-game.html wires ${marker}`);
  }
  const server = readFileSync(new URL('./server/server.js', import.meta.url), 'utf8');
  ok(server.includes('SHOT_SPREAD_PATH') && server.includes('setShotSpread('), 'the relay loads the same file');
  const serve = readFileSync(new URL('./serve.py', import.meta.url), 'utf8');
  ok(serve.includes('/api/save-shot-spread') && serve.includes('shot-spread.json'), 'serve.py has the write route');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
