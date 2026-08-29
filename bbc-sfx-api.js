// BBC Sound Effects archive client (sound-effects.bbcrewind.co.uk).
//
// The archive's search API and its media CDN both send `Access-Control-Allow-Origin: *`, so the
// browser talks to them directly -- there is no serve.py proxy in this path and no API key.
// Everything here is pure except `searchBbcSfx`, whose `fetch` is injectable, so the query
// building, response normalization, filtering and naming are all Node-testable.
//
// Licence: the archive is RemArc-licensed -- free for personal, educational and research use.
// Keep that in mind before this material goes anywhere commercial.

export const BBC_SEARCH_URL = 'https://sound-effects-api.bbcrewind.co.uk/api/sfx/search';
export const BBC_MEDIA_BASE = 'https://sound-effects-media.bbcrewind.co.uk';
export const BBC_PAGE_SIZE = 24;

// The API accepts every key below; `durations` is accepted and then ignored server-side (a
// "0-5" filter returns the same 2061 wind results as no filter), so duration narrowing happens
// in filterResults() instead, off the duration each result already carries.
export function buildSearchBody({
  query = '', from = 0, size = BBC_PAGE_SIZE, tags = null, categories = null,
  continents = null, sortBy = null, source = null, recordist = null, habitat = null,
} = {}) {
  return {
    criteria: {
      from: Math.max(0, Math.trunc(from) || 0),
      size: Math.max(1, Math.trunc(size) || BBC_PAGE_SIZE),
      query: String(query ?? ''),
      tags, categories, durations: null, continents, sortBy, source, recordist, habitat,
    },
  };
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// One search hit, flattened to the fields the browser actually shows or needs to download.
export function normalizeResult(raw) {
  if (!raw?.id) return null;
  const tech = raw.technicalMetadata || {};
  const extra = raw.additionalMetadata || {};
  const sizes = raw.fileSizes || {};
  // `duration` at the top level is milliseconds; technicalMetadata.duration is seconds.
  const seconds = numberOr(tech.duration, numberOr(raw.duration, 0) / 1000);
  return {
    id: String(raw.id),
    description: String(raw.description || '').trim() || `BBC ${raw.id}`,
    seconds,
    tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean).map(String) : [],
    categories: Array.isArray(raw.categories) ? raw.categories.map(c => String(c?.className || '')).filter(Boolean) : [],
    continent: String(raw.location?.continent || '').trim(),
    locationText: String(extra.locationText || '').trim(),
    cdName: String(extra.cdName || '').trim(),
    recordist: String(raw.recordist || extra.recordist || '').trim(),
    source: String(raw.source || '').trim(),
    sampleRate: numberOr(tech.sample_rate, 0),
    channels: numberOr(tech.channels, 0),
    mp3Bytes: numberOr(sizes.mp3FileSize, 0),
    wavBytes: numberOr(sizes.wavFileSize, 0),
  };
}

export function parseSearchResponse(json) {
  const results = Array.isArray(json?.results) ? json.results.map(normalizeResult).filter(Boolean) : [];
  return { total: numberOr(json?.total, results.length), results };
}

// Duration bands, applied here because the server ignores its own `durations` criterion. `minSeconds`
// is what matters for ambience: a two-second gust cannot carry a bed, a five-minute forest can.
export function filterResults(results, { minSeconds = 0, maxSeconds = Infinity, stereoOnly = false } = {}) {
  return (results || []).filter(r => {
    if (!r) return false;
    if (r.seconds < minSeconds) return false;
    if (r.seconds > maxSeconds) return false;
    if (stereoOnly && r.channels < 2) return false;
    return true;
  });
}

export function mediaUrl(id, format = 'mp3') {
  const kind = format === 'wav' ? 'wav' : 'mp3';
  return `${BBC_MEDIA_BASE}/${kind}/${encodeURIComponent(String(id))}.${kind}`;
}

export function slugify(text, maxLength = 48) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

// Provenance lives in the filename, the way the html-game-v2 library already records it.
export function suggestFileName(result, format = 'mp3') {
  const ext = format === 'wav' ? 'wav' : 'mp3';
  const slug = slugify(result?.description);
  return `bbc-${result?.id ?? 'unknown'}${slug ? `-${slug}` : ''}.${ext}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(numberOr(seconds, 0)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  const n = numberOr(bytes, 0);
  if (n <= 0) return '?';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The one impure export. `fetchImpl` is injected so tests never touch the network.
export async function searchBbcSfx(criteria = {}, { fetchImpl = globalThis.fetch, signal = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('searchBbcSfx needs a fetch implementation');
  const response = await fetchImpl(BBC_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSearchBody(criteria)),
    signal,
  });
  if (!response?.ok) throw new Error(`BBC search failed: ${response?.status ?? 'no response'}`);
  return parseSearchResponse(await response.json());
}
