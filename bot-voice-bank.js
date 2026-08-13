// Runtime access to the baked TTS takes in sfx/voice, so a viewer can swap the synthesized robot
// voice for real speech without touching its call sites.
//
// Two things this deliberately does NOT do. It does not decode audio itself -- the caller passes a
// decode function bound to the live AudioContext, because an AudioBuffer belongs to the context
// that made it. And it never blocks a callout: a take that has not arrived yet returns null and
// the caller falls back to the synth for that one line, which is why a bank warming up sounds
// like the old build rather than like silence.
//
// Per-bot variety comes from spreading bots across the sets of the chosen engine by seed, so a
// firefight is ten different speakers rather than one voice actor playing every soldier.

const MANIFEST_URL = './sfx/voice/manifest.json';
const BASE = './sfx/voice';
const FETCH_CONCURRENCY = 6;

// Same hash the rest of the bot audio uses for per-bot seeds; duplicated rather than imported so
// this module has no dependency on the damage track.
function hashId(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

export function createVoiceBank({ manifestUrl = MANIFEST_URL, base = BASE, decode = null, canDecode = () => true } = {}) {
  let manifest = null;
  let loadError = null;
  const buffers = new Map();    // `${set}/${lineId}` -> AudioBuffer
  const pending = new Set();    // keys currently in flight
  const failed = new Set();     // keys that 404'd or failed to decode; never retried
  const assigned = new Map();   // botId -> set name
  let engine = null;            // null = synth; otherwise 'eleven' | 'kokoro' | ...
  let queue = [];
  let inFlight = 0;
  let waitTimer = null;

  const setsOf = (eng) => (manifest?.sets || []).filter(s => s.engine === eng);

  // `force` bypasses the "resolve once" guard. The runtime game only ever wants the guarded path
  // (baked takes are immutable for the life of a match) -- refreshManifest() below is for the one
  // caller where that assumption is false: an authoring tool whose whole job is changing them.
  async function loadManifest(force = false) {
    if (!force && (manifest || loadError)) return manifest;
    try {
      const res = await fetch(manifestUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      manifest = await res.json();
      loadError = null;
    } catch (err) {
      loadError = err.message || String(err);
      console.warn(`[voice-bank] no baked takes: ${loadError}`);
    }
    return manifest;
  }

  function setEntry(name) { return (manifest?.sets || []).find(s => s.set === name) || null; }

  async function fetchTake(setName, lineId) {
    const key = `${setName}/${lineId}`;
    const entry = setEntry(setName);
    if (!entry || !decode) { failed.add(key); return; }
    try {
      // no-store: a regenerate overwrites this exact URL on disk, and the browser's own HTTP cache
      // must not serve the pre-regenerate bytes back once the in-memory cache below is invalidated.
      const res = await fetch(`${base}/${setName}/${lineId}.${entry.ext}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const buf = await decode(await res.arrayBuffer());
      if (buf) buffers.set(key, buf); else failed.add(key);
    } catch (err) {
      failed.add(key);
      console.warn(`[voice-bank] ${key}: ${err.message || err}`);
    }
  }

  // Decoding needs a live AudioContext, which needs a user gesture. Selecting a voice before
  // enabling audio must not burn the whole engine: hold the queue instead of failing every key.
  function waitForDecoder() {
    if (waitTimer) return;
    waitTimer = setInterval(() => {
      if (!canDecode()) return;
      clearInterval(waitTimer); waitTimer = null;
      pump();
    }, 500);
  }

  // Bounded fan-out. Kokoro sets are uncompressed WAV, so an unthrottled prefetch of every set
  // asks the browser for ~30 MB at once and stalls the first few seconds of a match.
  function pump() {
    if (queue.length && !canDecode()) { waitForDecoder(); return; }
    while (inFlight < FETCH_CONCURRENCY && queue.length) {
      const { setName, lineId } = queue.shift();
      const key = `${setName}/${lineId}`;
      if (buffers.has(key) || failed.has(key) || pending.has(key)) continue;
      pending.add(key);
      inFlight++;
      fetchTake(setName, lineId).finally(() => { pending.delete(key); inFlight--; pump(); });
    }
  }

  function want(setName, lineId, urgent = false) {
    const key = `${setName}/${lineId}`;
    if (buffers.has(key) || failed.has(key) || pending.has(key)) return;
    if (queue.some(q => q.setName === setName && q.lineId === lineId)) return;
    if (urgent) queue.unshift({ setName, lineId }); else queue.push({ setName, lineId });
    pump();
  }

  return {
    // Resolve the manifest once; safe to call repeatedly.
    async init() { await loadManifest(); return this.engines(); },
    // Re-fetches the manifest regardless of whether one was already loaded. The runtime game never
    // needs this (a match's baked takes do not change under it) -- an authoring tool does, right
    // after it generates a new one. Without a force option here, generating a variant that was
    // never seen this session (a brand-new voice, or a variant index the manifest never listed)
    // would stay invisible to takeFromSet() forever, since setEntry() only ever consults the
    // manifest snapshot from the very first init().
    async refreshManifest() { await loadManifest(true); },
    ready: () => !!manifest,
    error: () => loadError,
    engines: () => [...new Set((manifest?.sets || []).map(s => s.engine))],
    setNames: (eng) => setsOf(eng).map(s => s.set),
    lineIds: () => manifest?.lineIds ?? [],

    getEngine: () => engine,
    // Switching engines re-rolls every bot's set, drops the prefetch queue, and starts warming the
    // new engine. Decoded buffers are kept: switching back is then instant.
    setEngine(next) {
      const eng = next || null;
      if (eng === engine) return;
      engine = eng && setsOf(eng).length ? eng : null;
      assigned.clear();
      queue = [];
      if (engine) this.prefetch();
    },

    // Which baked speaker this bot uses. Stable for the life of the engine selection.
    setFor(botId) {
      if (!engine) return null;
      let name = assigned.get(botId);
      if (name) return name;
      const list = setsOf(engine);
      if (!list.length) return null;
      name = list[hashId(botId) % list.length].set;
      assigned.set(botId, name);
      return name;
    },

    // `variantIndex` names a specific baked variant file (index 0 is the plain `${lineId}` file
    // that has always existed; index N > 0 is `${lineId}__vN`, baked by bake-voices.mjs when a
    // voice has its own text for that intensity band). If the requested variant is not in this
    // set's manifest entry -- a set baked before variants existed, or never given this specific
    // one -- fall back to index 0 rather than trying and failing to fetch a file that was never
    // going to exist, the same degrade-quietly rule the synth-side picker in bot-voice.js follows
    // for an out-of-range index.
    _resolveTake(setName, lineId, variantIndex) {
      if (!setName) return null;
      const fileId = variantIndex > 0 ? `${lineId}__v${variantIndex}` : lineId;
      const entry = setEntry(setName);
      const resolvedId = entry && entry.lines.includes(fileId) ? fileId : lineId;
      const hit = buffers.get(`${setName}/${resolvedId}`);
      if (hit) return hit;
      want(setName, resolvedId, true);
      return null;
    },

    // The take for this bot's line and variant, or null while it is still loading (the caller falls
    // back to the synth for that one call).
    take(botId, lineId, variantIndex = 0) {
      if (!engine) return null;
      return this._resolveTake(this.setFor(botId), lineId, variantIndex);
    },

    // Same lookup, but for a SPECIFIC set rather than whichever one a bot's id happens to hash to
    // -- the line-authoring tool needs to preview a chosen voice directly, not an assigned one, and
    // does not need setEngine()/setFor() to have run at all first.
    takeFromSet(setName, lineId, variantIndex = 0) {
      return this._resolveTake(setName, lineId, variantIndex);
    },

    // The protected default slot (`${lineId}__default`, bake-voices.mjs#bakeDefaultEleven) -- a
    // separate, dedicated lookup, NOT `_resolveTake`'s fallback-to-index-0 path. That fallback
    // exists because index 0's variant file and the OLD shared plain file used to be the same
    // path; now that the default has its own permanent slot, falling back to index 0 here would be
    // wrong on purpose -- if the default was never baked, say so (null), don't quietly substitute
    // whatever the voice's own variant 0 happens to say.
    takeDefault(setName, lineId) {
      if (!setName) return null;
      const fileId = `${lineId}__default`;
      const entry = setEntry(setName);
      if (!entry || !entry.lines.includes(fileId)) return null;
      const hit = buffers.get(`${setName}/${fileId}`);
      if (hit) return hit;
      want(setName, fileId, true);
      return null;
    },

    // Forgets a specific decoded buffer (and any failed/pending record for it) so the NEXT
    // take()/takeFromSet() call re-fetches from disk instead of returning what is already in
    // memory. Every other method in this bank assumes a baked take never changes once fetched --
    // true for the runtime game, false for whatever just regenerated this exact file. Call
    // refreshManifest() first if the file is new to this session (a brand-new variant/voice); this
    // alone is enough for a file that already existed and was simply overwritten.
    invalidate(setName, lineId, variantIndex = 0) {
      const fileId = variantIndex > 0 ? `${lineId}__v${variantIndex}` : lineId;
      const key = `${setName}/${fileId}`;
      buffers.delete(key);
      failed.delete(key);
      pending.delete(key);
    },

    // Same, for the protected default slot -- called after generate-default/restore-default.
    invalidateDefault(setName, lineId) {
      const key = `${setName}/${lineId}__default`;
      buffers.delete(key);
      failed.delete(key);
      pending.delete(key);
    },

    // Warm every take of the current engine in the background.
    prefetch() {
      if (!engine) return;
      for (const s of setsOf(engine)) for (const id of s.lines) want(s.set, id);
    },

    // `loaded/total` for the current engine, for a UI readout.
    progress() {
      if (!engine) return { loaded: 0, total: 0 };
      let loaded = 0, total = 0;
      for (const s of setsOf(engine)) {
        for (const id of s.lines) { total++; if (buffers.has(`${s.set}/${id}`)) loaded++; }
      }
      return { loaded, total };
    },
  };
}
