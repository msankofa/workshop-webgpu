// Node tests for bbc-sfx-api.js and sound-environments.js.
// Run: node test-bbc-sfx-api.mjs           (offline; fetch is faked)
//      node test-bbc-sfx-api.mjs --live    (adds one real call to the BBC archive)
import {
  buildSearchBody, normalizeResult, parseSearchResponse, filterResults, mediaUrl,
  slugify, suggestFileName, formatDuration, formatBytes, searchBbcSfx,
  BBC_SEARCH_URL, BBC_PAGE_SIZE,
} from './bbc-sfx-api.js';
import {
  SOUND_ENVIRONMENT_DEFS, SOUND_ENVIRONMENTS, soundEnvironmentById, environmentsOfKind,
  environmentLayerPath, normalizeEnvironmentMap, MAX_ENVIRONMENT_LAYERS,
} from './sound-environments.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// One real archive response, captured from the live API, so the normalizer is tested against the
// actual schema rather than against a shape I invented.
const RAW = {
  id: '07076027',
  file: { small: { name: '07076027', bitrate: '128kbps' }, original: { name: '07076027', bitrate: '' } },
  description: 'Tropical Forest, West Africa at dawn.',
  duration: 507279.637,
  recordedDate: 'unknown',
  categories: [{ className: 'Nature', p: 0.999999, textCoverage: 0.999999 }],
  subCategories: [],
  location: { continent: 'Africa' },
  tags: ['forest', 'west', 'africa', 'dawn', 'tropical'],
  source: 'bbc_archive',
  technicalMetadata: { file_name: '07076027.wav', sample_rate: '44100', bits_per_sample: 16, channels: 2, duration: '507.279637' },
  additionalMetadata: { cdName: 'Tropical Forest: West Africa', locationText: 'Africa', originalCategory: 'Africa: Forest', additionalCategory: 'Nature' },
  fileSizes: { wavFileSize: '89484896', mp3FileSize: '8118174' },
};

// ---- query building ----
{
  const body = buildSearchBody({ query: 'wind', from: 24, size: 12 });
  ok(body.criteria.query === 'wind', 'query passes through');
  ok(body.criteria.from === 24 && body.criteria.size === 12, 'paging passes through');
  ok(body.criteria.durations === null, 'durations is always null: the server ignores it, we filter client-side');
  for (const key of ['tags', 'categories', 'continents', 'sortBy', 'source', 'recordist', 'habitat']) {
    ok(key in body.criteria, `criteria carries ${key} (the API rejects a partial criteria object)`);
  }
  const d = buildSearchBody();
  ok(d.criteria.size === BBC_PAGE_SIZE && d.criteria.from === 0 && d.criteria.query === '', 'defaults are sane');
  ok(buildSearchBody({ from: -5, size: 0 }).criteria.from === 0, 'negative paging is clamped');
}

// ---- normalizing ----
{
  const r = normalizeResult(RAW);
  ok(r.id === '07076027', 'id');
  ok(r.description === 'Tropical Forest, West Africa at dawn.', 'description');
  ok(Math.abs(r.seconds - 507.279637) < 1e-6, 'seconds comes from technicalMetadata, not the ms field');
  ok(r.channels === 2 && r.sampleRate === 44100, 'numeric technical metadata is coerced from strings');
  ok(r.mp3Bytes === 8118174 && r.wavBytes === 89484896, 'file sizes are coerced from strings');
  ok(r.tags.length === 5 && r.categories[0] === 'Nature', 'tags and category class names');
  ok(r.continent === 'Africa' && r.cdName === 'Tropical Forest: West Africa', 'location and CD name');
  ok(normalizeResult(null) === null && normalizeResult({}) === null, 'junk normalizes to null');

  // Falls back to the millisecond field when technicalMetadata is absent.
  const noTech = normalizeResult({ id: 'x', duration: 4000 });
  ok(noTech.seconds === 4, 'ms duration is the fallback');
  ok(noTech.description === 'BBC x', 'a missing description falls back to the id');
}

// ---- response parsing ----
{
  const parsed = parseSearchResponse({ total: 4944, results: [RAW, null, { nope: true }] });
  ok(parsed.total === 4944, 'total');
  ok(parsed.results.length === 1, 'unusable rows are dropped, not returned as holes');
  ok(parseSearchResponse(null).total === 0, 'a null response is empty, not a throw');
  ok(parseSearchResponse({ results: [RAW] }).total === 1, 'a missing total falls back to the row count');
}

// ---- client-side duration filtering (the server ignores its own durations criterion) ----
{
  const rows = [
    { id: 'a', seconds: 2, channels: 2 },
    { id: 'b', seconds: 140, channels: 2 },
    { id: 'c', seconds: 507, channels: 1 },
  ];
  ok(filterResults(rows, { minSeconds: 60 }).length === 2, 'minSeconds drops the short gust');
  ok(filterResults(rows, { minSeconds: 60, stereoOnly: true }).length === 1, 'stereoOnly drops the mono forest');
  ok(filterResults(rows, { maxSeconds: 10 })[0].id === 'a', 'maxSeconds keeps only the short one');
  ok(filterResults(rows).length === 3, 'no options is a pass-through');
  ok(filterResults(null).length === 0, 'null input is empty');
}

// ---- media URLs and naming ----
{
  ok(mediaUrl('07076027') === 'https://sound-effects-media.bbcrewind.co.uk/mp3/07076027.mp3', 'mp3 url');
  ok(mediaUrl('07076027', 'wav') === 'https://sound-effects-media.bbcrewind.co.uk/wav/07076027.wav', 'wav url');
  ok(mediaUrl('07076027', 'flac').endsWith('.mp3'), 'an unknown format falls back to mp3');
  ok(slugify('Tropical Forest, West Africa at dawn.') === 'tropical-forest-west-africa-at-dawn', 'slug');
  ok(slugify('  ...  ') === '', 'punctuation-only slugs collapse to empty');
  ok(!slugify('a'.repeat(80)).endsWith('-'), 'a truncated slug never ends in a dash');
  const name = suggestFileName(normalizeResult(RAW));
  ok(name === 'bbc-07076027-tropical-forest-west-africa-at-dawn.mp3', `filename carries id + slug (got ${name})`);
  ok(suggestFileName(normalizeResult(RAW), 'wav').endsWith('.wav'), 'wav extension');
  ok(suggestFileName({ id: 'z' }) === 'bbc-z.mp3', 'no description still yields a usable name');
}

// ---- formatting ----
{
  ok(formatDuration(507) === '8:27', 'duration mm:ss');
  ok(formatDuration(5) === '0:05', 'seconds are zero-padded');
  ok(formatDuration(null) === '0:00', 'null duration');
  ok(formatBytes(8118174) === '7.7 MB', 'megabytes');
  ok(formatBytes(2048) === '2 KB', 'kilobytes');
  ok(formatBytes(0) === '?', 'unknown size');
}

// ---- searchBbcSfx with an injected fetch ----
{
  let seenUrl = null, seenInit = null;
  const fakeFetch = async (url, init) => {
    seenUrl = url; seenInit = init;
    return { ok: true, json: async () => ({ total: 1, results: [RAW] }) };
  };
  const out = await searchBbcSfx({ query: 'forest birds' }, { fetchImpl: fakeFetch });
  ok(seenUrl === BBC_SEARCH_URL, 'posts to the search endpoint');
  ok(seenInit.method === 'POST' && seenInit.headers['Content-Type'] === 'application/json', 'posts JSON');
  ok(JSON.parse(seenInit.body).criteria.query === 'forest birds', 'body carries the query');
  ok(out.results[0].id === '07076027', 'returns normalized rows');

  let threw = false;
  try { await searchBbcSfx({}, { fetchImpl: async () => ({ ok: false, status: 503 }) }); } catch { threw = true; }
  ok(threw, 'a failed response throws rather than returning empty');
  let threwNoFetch = false;
  try { await searchBbcSfx({}, { fetchImpl: null }); } catch { threwNoFetch = true; }
  ok(threwNoFetch, 'a missing fetch throws');
}

// ---- environment registry ----
{
  ok(SOUND_ENVIRONMENTS.length === SOUND_ENVIRONMENT_DEFS.length, 'id list matches defs');
  ok(new Set(SOUND_ENVIRONMENTS).size === SOUND_ENVIRONMENTS.length, 'environment ids are unique');
  ok(SOUND_ENVIRONMENT_DEFS.every(e => e.id && e.label && e.hint), 'every slot has an id, label and hint');
  ok(SOUND_ENVIRONMENT_DEFS.every(e => e.kind === 'ambience' || e.kind === 'location'), 'kind is one of the two');
  ok(environmentsOfKind('ambience').length > 0 && environmentsOfKind('location').length > 0, 'both kinds are populated');
  ok(soundEnvironmentById('amb_forest_day')?.kind === 'ambience', 'lookup by id');
  ok(soundEnvironmentById('nope') === null, 'unknown id yields null');
  ok(environmentLayerPath('amb_forest_day', 'bbc-07076027-forest.mp3') === 'assets/env/amb_forest_day__bbc-07076027-forest.mp3', 'layer path is named after its source, not its index');
  ok(environmentLayerPath('x', 'a b/c*.wav') === 'assets/env/x__a_b_c_.wav', 'unsafe filename characters are replaced');
  ok(environmentLayerPath('x') === 'assets/env/x__layer', 'a missing filename still yields a path');
}

// ---- environment map normalizing ----
{
  const clean = normalizeEnvironmentMap({
    amb_forest_day: { layers: [{ path: 'assets/env/amb_forest_day-0.mp3', source: 'bbc/x.mp3', gain: 0.8 }] },
    not_a_real_env: { layers: [{ path: 'assets/env/whatever.mp3' }] },
    amb_rain: { layers: [{ nope: 1 }, { path: '' }] },
  });
  ok(Object.keys(clean).length === 1, 'unknown ids and layerless slots are dropped');
  ok(clean.amb_forest_day.layers[0].gain === 0.8, 'gain survives');
  ok(clean.amb_forest_day.layers[0].loop === true, 'loop defaults to true');
  ok(normalizeEnvironmentMap({ amb_rain: { layers: [{ path: 'a.mp3', gain: 99 }] } }).amb_rain.layers[0].gain === 2, 'gain is clamped');
  ok(normalizeEnvironmentMap({ amb_rain: { layers: [{ path: 'a.mp3', loop: false }] } }).amb_rain.layers[0].loop === false, 'loop:false is respected');
  const many = normalizeEnvironmentMap({ amb_rain: { layers: Array.from({ length: 9 }, (_, i) => ({ path: `${i}.mp3` })) } });
  ok(many.amb_rain.layers.length === MAX_ENVIRONMENT_LAYERS, 'layers are capped');
  ok(Object.keys(normalizeEnvironmentMap(null)).length === 0, 'null map is empty');
  // A bare array is the shorthand a hand-edited file is likely to use.
  ok(normalizeEnvironmentMap({ amb_rain: [{ path: 'a.mp3' }] }).amb_rain.layers.length === 1, 'a bare array of layers is accepted');
}

// ---- optional live check: does the archive still answer the shape we parse? ----
if (process.argv.includes('--live')) {
  try {
    const live = await searchBbcSfx({ query: 'wind', size: 3 });
    ok(live.total > 0, `live search returns results (total ${live.total})`);
    ok(live.results.length > 0 && live.results[0].id, 'live rows normalize with an id');
    ok(live.results.every(r => r.seconds > 0), 'live rows all carry a duration');
    console.log(`  live: ${live.total} hits for "wind"; first = ${live.results[0].description}`);
  } catch (e) {
    failed++;
    console.error('FAIL: live BBC search threw:', e.message);
  }
}

if (failed) { console.error(`bbc-sfx-api: ${failed} assertion(s) failed`); process.exit(1); }
console.log('bbc-sfx-api: all assertions passed.');
