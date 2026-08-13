// bot-voice-bank.js: manifest load, per-bot speaker spread, lazy fetch, synth fallback.
// fetch is stubbed, so this asserts the bank's policy rather than the contents of sfx/voice.
import { readFileSync, existsSync } from 'node:fs';
import { createVoiceBank } from './bot-voice-bank.js';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
}

const MANIFEST = existsSync('./sfx/voice/manifest.json')
  ? JSON.parse(readFileSync('./sfx/voice/manifest.json', 'utf8'))
  : { lineIds: ['contact'], sets: [{ set: 'eleven/a', engine: 'eleven', voice: 'a', ext: 'mp3', lines: ['contact'] }] };

let fetches = 0, live = 0, peak = 0, failNext = null;
const attempts = new Map();   // url -> times requested, including the ones that 404
globalThis.fetch = async (url) => {
  if (url.endsWith('manifest.json')) return { ok: true, json: async () => MANIFEST };
  attempts.set(url, (attempts.get(url) || 0) + 1);
  if (failNext && url.includes(failNext)) return { ok: false, status: 404 };
  fetches++; live++; peak = Math.max(peak, live);
  await new Promise(r => setTimeout(r, 1));
  live--;
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
};
const settle = (ms = 1200) => new Promise(r => setTimeout(r, ms));

// Polls until a bank's prefetch queue stops making progress (either everything resolved, or the
// rest is permanently stuck in `failed` -- there is no public way to ask a bank "are you idle", so
// quiescence is inferred from `loaded` no longer changing). A fixed settle() timeout is what this
// replaces: it assumed a small manifest, and stopped being enough once the real on-disk manifest
// grew past a couple hundred takes (2026-08-03's bulk intensity-variant bake took it to 790) --
// prefetch itself was never broken, the test's fixed budget just ran out before a real prefetch of
// that size could finish. Draining to quiescence (rather than a bigger fixed sleep) also matters
// for TEST ISOLATION: every block below shares one mutable `globalThis.fetch`, and a bank whose
// prefetch is still running in the background when a later block reassigns it will keep calling
// whatever the CURRENT stub is, corrupting that later block's own call counts. This is what turned
// into "takeFetches=79" for a block expecting exactly 1, once the real manifest got large enough
// that earlier banks routinely hadn't finished by the time later blocks swapped fetch out.
async function drain(bank, { maxMs = 8000, quietMs = 250 } = {}) {
  const start = Date.now();
  let last = -1, quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    const p = bank.progress();
    if (p.loaded !== last) { last = p.loaded; quietSince = Date.now(); }
    else if (Date.now() - quietSince >= quietMs) return p;
    if (p.total > 0 && p.loaded === p.total) return p;
    await new Promise(r => setTimeout(r, 50));
  }
  return bank.progress();
}

console.log('voice bank');
const bank = createVoiceBank({ decode: async () => ({ duration: 1.2 }) });
await bank.init();
check('manifest resolves to at least one engine', bank.ready() && bank.engines().length > 0, String(bank.error()));

const engine = bank.engines()[0];
bank.setEngine(engine);
const setCount = bank.setNames(engine).length;

// A take that has not arrived must not block the callout; the caller falls back to the synth.
check('a cold take returns null rather than blocking', bank.take('bot7', MANIFEST.lineIds[0]) === null);

const spread = new Set();
for (let i = 0; i < 60; i++) spread.add(bank.setFor(`bot${i}`));
check('bots spread across every speaker in the engine', spread.size === setCount, `${spread.size} of ${setCount}`);
check('no bot is left without a speaker', !spread.has(null));
check('a bot keeps its speaker across calls', bank.setFor('bot7') === bank.setFor('bot7'));

const p = await drain(bank);
check('prefetch warms every take of the engine', p.total > 0 && p.loaded === p.total, JSON.stringify(p));
check('a warm take is returned', !!bank.take('bot7', MANIFEST.lineIds[0]));
check('prefetch respects the concurrency cap', peak <= 6, `peak ${peak}`);

// Re-rolling on switch is what stops every bot keeping an eleven speaker after moving to kokoro.
if (bank.engines().length > 1) {
  const before = bank.setFor('bot7');
  bank.setEngine(bank.engines()[1]);
  check('switching engines re-rolls speakers', bank.setFor('bot7') !== before);
  bank.setEngine(engine);
  check('switching back is instant, decoded takes are kept', !!bank.take('bot7', MANIFEST.lineIds[0]));
}
// Quiesce fully before the next block reassigns globalThis.fetch -- see drain()'s comment above.
await drain(bank);

bank.setEngine(null);
check('the synth source asks the bank for nothing', bank.take('bot7', MANIFEST.lineIds[0]) === null);

// Picking a voice before the audio context exists must hold the queue, not poison every key.
let decoderReady = false;
const bank3 = createVoiceBank({
  decode: async () => (decoderReady ? { duration: 1 } : null),
  canDecode: () => decoderReady,
});
await bank3.init();
attempts.clear();
bank3.setEngine(engine);
await settle(400);
check('nothing is fetched while the decoder is unavailable', attempts.size === 0, `${attempts.size} fetches`);
decoderReady = true;
const p3 = await drain(bank3);
check('the queue drains once the decoder appears', p3.total > 0 && p3.loaded === p3.total, JSON.stringify(p3));

// A 404 must poison that one key permanently, not retry on every single callout.
failNext = MANIFEST.lineIds[0];
const bank2 = createVoiceBank({ decode: async () => ({ duration: 1 }) });
await bank2.init();
attempts.clear();
bank2.setEngine(engine);
await settle();
// Must be the URL THIS bot asks for; any other set's copy is never re-requested and would pass
// the check no matter what the bank does with a failure.
const deadUrl = [...attempts.keys()].find(u => u.includes(`${bank2.setFor('bot7')}/${failNext}.`));
const afterPrefetch = attempts.get(deadUrl) || 0;
for (let i = 0; i < 20; i++) bank2.take('bot7', MANIFEST.lineIds[0]);
await settle(300);
check('a 404 take is requested once, not once per callout',
  (attempts.get(deadUrl) || 0) === afterPrefetch && afterPrefetch === 1,
  `${attempts.get(deadUrl)} attempts on ${deadUrl}`);
check('a missing take still returns null', bank2.take('bot7', MANIFEST.lineIds[0]) === null);
// Quiesce fully before the next block reassigns globalThis.fetch -- see drain()'s comment above.
await drain(bank2);

// -- invalidate() / refreshManifest(): the authoring tool's whole reason for existing. Without
// these, regenerating a variant's audio changes the file on disk but the bank keeps serving the
// decoded buffer from before the regenerate -- confirmed as the actual bug behind a real report,
// not a hypothetical.
{
  let manifestVersion = 1;
  const liveManifest = () => manifestVersion === 1
    ? { lineIds: ['contact'], sets: [{ set: 'eleven/x', engine: 'eleven', voice: 'x', ext: 'mp3', lines: ['contact'] }] }
    : { lineIds: ['contact'], sets: [{ set: 'eleven/x', engine: 'eleven', voice: 'x', ext: 'mp3', lines: ['contact', 'contact__v1'] }] };
  let takeFetches = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith('manifest.json')) return { ok: true, json: async () => liveManifest() };
    takeFetches++;
    await new Promise(r => setTimeout(r, 1));
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };

  const bank4 = createVoiceBank({ decode: async () => ({ duration: 1.5, fetchNum: takeFetches }) });
  await bank4.init();
  bank4.setEngine('eleven');
  let buf = null;
  for (let i = 0; i < 10 && !buf; i++) { buf = bank4.takeFromSet('eleven/x', 'contact', 0); if (!buf) await settle(200); }
  check('initial take resolves', !!buf);
  const firstFetchCount = buf?.fetchNum;

  // Regenerate happened: same file, new content on disk. Without invalidate(), the cached buffer
  // from the line above must still be returned -- prove that first, so the fix is provably load-
  // bearing rather than assumed.
  const staleBuf = bank4.takeFromSet('eleven/x', 'contact', 0);
  check('without invalidation, a cached take is returned instead of triggering a re-fetch',
    staleBuf === buf && takeFetches === 1, `takeFetches=${takeFetches}`);

  bank4.invalidate('eleven/x', 'contact', 0);
  let refetched = null;
  for (let i = 0; i < 10 && !refetched; i++) { refetched = bank4.takeFromSet('eleven/x', 'contact', 0); if (!refetched) await settle(200); }
  check('after invalidate(), the same key triggers a real re-fetch', refetched !== buf && refetched?.fetchNum > firstFetchCount,
    `first=${firstFetchCount} second=${refetched?.fetchNum}`);

  // A variant index that did not exist in the manifest at init() time (a brand-new variant, just
  // generated) must become resolvable after refreshManifest(), not stay invisible for the session.
  const beforeRefresh = bank4.takeFromSet('eleven/x', 'contact', 1);
  check('a variant not yet in the manifest falls back to the base rather than erroring', beforeRefresh !== null);
  manifestVersion = 2;
  await bank4.refreshManifest();
  let v1 = null;
  for (let i = 0; i < 10 && !v1; i++) {
    v1 = bank4.takeFromSet('eleven/x', 'contact', 1);
    if (!v1) await settle(200);
  }
  check('refreshManifest() picks up a variant that did not exist at init() time', !!v1);
}

// -- takeDefault()/invalidateDefault(): the protected default slot is a SEPARATE lookup from
// takeFromSet's index-0 fallback, on purpose -- if the default was never baked, it must return
// null, not silently substitute whatever the voice's own variant 0 currently says.
{
  let hasDefault = false;
  const manifestWithDefault = () => ({
    lineIds: ['contact'],
    sets: [{ set: 'eleven/y', engine: 'eleven', voice: 'y', ext: 'mp3',
      lines: hasDefault ? ['contact', 'contact__default'] : ['contact'] }],
  });
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith('manifest.json')) return { ok: true, json: async () => manifestWithDefault() };
    fetchCount++;
    await new Promise(r => setTimeout(r, 1));
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const bank5 = createVoiceBank({ decode: async () => ({ duration: 1, tag: 'default-buf' }) });
  await bank5.init();
  check('takeDefault() returns null when no default has been baked for this voice',
    bank5.takeDefault('eleven/y', 'contact') === null);

  hasDefault = true;
  await bank5.refreshManifest();
  let def = null;
  for (let i = 0; i < 10 && !def; i++) { def = bank5.takeDefault('eleven/y', 'contact'); if (!def) await settle(200); }
  check('takeDefault() resolves once the default exists and the manifest is refreshed', !!def);

  const fetchesBefore = fetchCount;
  const cached = bank5.takeDefault('eleven/y', 'contact');
  check('a cached default is returned without a new fetch', cached === def && fetchCount === fetchesBefore);

  bank5.invalidateDefault('eleven/y', 'contact');
  let refetched = null;
  for (let i = 0; i < 10 && !refetched; i++) { refetched = bank5.takeDefault('eleven/y', 'contact'); if (!refetched) await settle(200); }
  check('invalidateDefault() forces a real re-fetch, same as invalidate() does for variants',
    refetched !== def && fetchCount > fetchesBefore);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall voice bank checks passed');
process.exit(failures ? 1 : 0);
