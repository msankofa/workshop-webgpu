// test-base-game-shared-keys.mjs — the seam between base-game-protocol.mjs and base-game.html.
//
// Two tables clamp the same numbers: NUMBER_LIMITS in the protocol (applied to every world patch on
// the wire and on the server) and NUMBER_LIMITS in the page (applied when loading a slot or a JSON
// file). If they disagree for a shared key, a value a player can set locally is silently changed the
// moment it crosses the network, which reads as "my setting keeps resetting" and is very hard to see.
// Nothing else checks that, so it is checked here — for every shared key, not just the weather ones.
import { readFile } from 'fs/promises';
import { BASE_GAME_SHARED_KEYS, sanitizeBaseGameWorldPatch, pickBaseGameSharedWorld } from './base-game-protocol.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ', m); } else { fail++; console.log('FAIL', m); } };

const html = await readFile('./base-game.html', 'utf8');
const block = (name) => {
  const match = html.match(new RegExp(`const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`));
  return match ? match[1].split('\n').filter(l => !l.trim().startsWith('//')).join('\n') : '';
};
const pageDefaults = new Set([...block('DEFAULT_SETTINGS').matchAll(/\b(\w+)\s*:/g)].map(m => m[1]));
const pageLimits = Object.fromEntries([...block('NUMBER_LIMITS').matchAll(/\b(\w+):\s*\[\s*(-?[\d.e+]+)\s*,\s*(-?[\d.e+]+)\s*\]/g)]
  .map(m => [m[1], [Number(m[2]), Number(m[3])]]));
const protocolSource = await readFile('./base-game-protocol.mjs', 'utf8');
const protocolLimits = Object.fromEntries([...protocolSource.match(/const NUMBER_LIMITS = Object\.freeze\(\{([\s\S]*?)\n\}\);/)[1]
  .matchAll(/\b(\w+):\s*\[\s*(-?[\d.e+]+)\s*,\s*(-?[\d.e+]+)\s*\]/g)].map(m => [m[1], [Number(m[2]), Number(m[3])]]));

ok(pageDefaults.size > 100, `the page's settings block parsed (${pageDefaults.size} keys)`);
ok(Object.keys(protocolLimits).length > 20, `the protocol's limits parsed (${Object.keys(protocolLimits).length} keys)`);

// 1. Every shared key is a real setting the page owns.
const orphans = BASE_GAME_SHARED_KEYS.filter(k => !pageDefaults.has(k));
ok(orphans.length === 0, `every shared key is a page setting${orphans.length ? `: ${orphans.join(', ')}` : ''}`);

// 2. Numeric shared keys are clamped on both sides, to the same range. The boolean and string sets
// are read out of the protocol rather than restated here, so this test cannot go stale behind it.
const listBetween = (source, re, item) => new Set([...(source.match(re)?.[1] ?? '').matchAll(item)].map(m => m[1]));
const booleans = listBetween(protocolSource, /const BOOLEAN_KEYS = new Set\(\[([^\]]*)\]\)/, /'(\w+)'/g);
const strings = listBetween(protocolSource, /const STRING_VALUES = Object\.freeze\(\{([\s\S]*?)\}\);/, /(\w+):\s*\[/g);
ok(booleans.size >= 3 && strings.size >= 1, `the protocol's boolean and string key sets parsed (${booleans.size} / ${strings.size})`);
const numericShared = BASE_GAME_SHARED_KEYS.filter(k => !booleans.has(k) && !strings.has(k));
const missingProtocol = numericShared.filter(k => !protocolLimits[k]);
const missingPage = numericShared.filter(k => !pageLimits[k]);
ok(missingProtocol.length === 0, `every numeric shared key is clamped on the wire${missingProtocol.length ? `: ${missingProtocol.join(', ')}` : ''}`);
ok(missingPage.length === 0, `every numeric shared key is clamped on load${missingPage.length ? `: ${missingPage.join(', ')}` : ''}`);
const mismatched = numericShared
  .filter(k => protocolLimits[k] && pageLimits[k])
  .filter(k => protocolLimits[k][0] !== pageLimits[k][0] || protocolLimits[k][1] !== pageLimits[k][1])
  .map(k => `${k} wire ${JSON.stringify(protocolLimits[k])} vs page ${JSON.stringify(pageLimits[k])}`);
ok(mismatched.length === 0, `the two limit tables agree${mismatched.length ? `: ${mismatched.join('; ')}` : ''}`);

// 3. The weather keys specifically: the ones that decide what everyone sees, and no more.
const weatherShared = BASE_GAME_SHARED_KEYS.filter(k => /^weather|^cloud/.test(k));
ok(weatherShared.length === 10, `ten weather keys are shared (found ${weatherShared.length}: ${weatherShared.join(', ')})`);
for (const key of ['weatherRain', 'weatherOvercast', 'cloudACover', 'cloudAHeight', 'cloudBCover', 'cloudBHeight',
  'weatherWindDeg', 'weatherWindSpeed', 'weatherGust', 'weatherGustPeriod']) {
  ok(weatherShared.includes(key), `${key} is owner-owned`);
}
// Response curves and look stay local: a guest may run its own fog and drop budget.
for (const key of ['overcastPerRain', 'sunDimPerRain', 'weatherFogPerRain', 'weatherFogColor', 'cloudAOctaves', 'cloudAExtent', 'cloudsEnabled',
  'weatherWindFollowsWaves', 'rainMaxDrops', 'rainSplashEnabled', 'rainGroundConservative', 'rainSkyTint']) {
  ok(!BASE_GAME_SHARED_KEYS.includes(key), `${key} stays local`);
}

// 4. Round trip: pick, clamp, and reject nonsense.
{
  const settings = { weatherRain: 0.4, weatherOvercast: 0.2, cloudACover: 0.5, cloudAHeight: 1200, cloudBCover: 0.3, cloudBHeight: 3000, cloudAExtent: 20000, sunIntensity: 2 };
  const picked = pickBaseGameSharedWorld(settings);
  ok(picked.weatherRain === 0.4 && picked.cloudAHeight === 1200, 'the weather keys survive a pick');
  ok(!('cloudAExtent' in picked), 'a local key is not picked up by the pick');

  const clean = sanitizeBaseGameWorldPatch({ weatherRain: 5, weatherOvercast: -3, cloudAHeight: 1e9, cloudBCover: 0.7 });
  ok(clean.weatherRain === 1, 'an over-range master clamps to 1');
  ok(clean.weatherOvercast === 0, 'a negative overcast clamps to 0');
  ok(clean.cloudAHeight === 10000, 'an absurd deck height clamps to the ceiling');
  ok(clean.cloudBCover === 0.7, 'a legal value passes through');

  const junk = sanitizeBaseGameWorldPatch({ weatherRain: 'wet', cloudAHeight: NaN, cloudBHeight: Infinity, cloudACover: null });
  ok(!('weatherRain' in junk), 'a non-numeric master is dropped, not coerced');
  ok(!('cloudAHeight' in junk) && !('cloudBHeight' in junk) && !('cloudACover' in junk), 'NaN, Infinity and null are dropped');

  ok(Object.keys(sanitizeBaseGameWorldPatch({})).length === 0, 'an empty patch stays empty, so the server can skip the broadcast');
  ok(Object.keys(sanitizeBaseGameWorldPatch({ cloudAExtent: 5000, rainDropsEnabled: false })).length === 0,
    'a patch of only local keys is empty, so a guest cannot smuggle look settings into the room');
}

// 5. A client that predates these keys stays compatible: the sanitizer omits what it is not sent,
// so an old owner's world simply carries no weather and every client keeps its own.
{
  const old = sanitizeBaseGameWorldPatch({ todHour: 9, sunIntensity: 2 });
  ok(!('weatherRain' in old), 'a world from a client without weather carries no weather keys');
  ok(old.todHour === 9, 'and the keys it does send still arrive');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
