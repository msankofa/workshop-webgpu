// Priority-aware voice budget shared by every combat audio track (ballistic, voice, damage).
// Pure logic: no WebAudio, no THREE, no DOM -- Node-testable in isolation.
//
// Callers reserve() before building a voice and release() when it ends. The point is that the
// tracks compete for one ceiling instead of each policing itself: a death siren must be able to
// displace an ambient crackle. Today the viewers share one instance between the voice and damage
// tracks; the ballistic one-shots stay on sfxBudgetOk alone (their priorities here are unused).
//
// Rate limiting (bursts inside a 100ms window) stays where it already lives -- each viewer's
// sfxBudgetOk. This module governs CONCURRENT count, which is the different failure mode.

import { SOUND_PARAMS } from './sound-params.js';

// Hard ceiling on sustained voices. environment-audio.js calls this rather than keeping its own
// copy, so there is exactly one number to tune -- and it is read live, so sound-studio.html can
// move it without a reload.
export function loopVoiceCap() { return SOUND_PARAMS.budget.loopCap; }

export const AUDIO_PRIORITY = {
  death: 100,
  voiceAlert: 90,
  damageCritical: 70,
  voiceBark: 60,
  damageHit: 50,
  damageLoop: 40,
  ballisticImpact: 30,
  ballisticGunshot: 20,
};

// Snapshot of the live caps. Call it -- do not hold the result across a params change.
// The voice cap is director.speakerCap: one number governs how many bots may talk at once.
export function audioBudgetDefaults() {
  const b = SOUND_PARAMS.budget;
  return {
    globalCap: b.globalCap,
    categoryCaps: { ballistic: b.ballisticCap, voice: SOUND_PARAMS.director.speakerCap, damage: b.damageCap },
    loopCap: b.loopCap,
  };
}

// A budget created without explicit caps tracks SOUND_PARAMS live; one created WITH them pins
// only the fields it named. That is what lets the studio retune a running mix.
function normalizeConfig(config) {
  const pinned = {
    globalCap: Number.isFinite(config?.globalCap) ? config.globalCap : null,
    loopCap: Number.isFinite(config?.loopCap) ? config.loopCap : null,
    categoryCaps: { ...(config?.categoryCaps || {}) },
  };
  return {
    get globalCap() { return pinned.globalCap ?? SOUND_PARAMS.budget.globalCap; },
    set globalCap(v) { pinned.globalCap = v; },
    get loopCap() { return pinned.loopCap ?? SOUND_PARAMS.budget.loopCap; },
    set loopCap(v) { pinned.loopCap = v; },
    get categoryCaps() { return { ...audioBudgetDefaults().categoryCaps, ...pinned.categoryCaps }; },
    pinCategoryCaps(partial) { Object.assign(pinned.categoryCaps, partial); },
    // Allocation-free lookup for the hot path -- reserve() runs dozens of times a second.
    capFor(category) {
      if (Number.isFinite(pinned.categoryCaps[category])) return pinned.categoryCaps[category];
      const b = SOUND_PARAMS.budget;
      if (category === 'ballistic') return b.ballisticCap;
      if (category === 'voice') return SOUND_PARAMS.director.speakerCap;
      if (category === 'damage') return b.damageCap;
      return null;
    },
  };
}

export function createAudioBudget(config = {}) {
  const cfg = normalizeConfig(config);
  const active = new Map();   // token -> { category, priority, sustained, seq, meta }
  let nextToken = 1;
  let seq = 0;

  function countIn(category) {
    let n = 0;
    for (const rec of active.values()) if (rec.category === category) n++;
    return n;
  }

  function countSustained() {
    let n = 0;
    for (const rec of active.values()) if (rec.sustained) n++;
    return n;
  }

  function capFor(category) {
    const cap = cfg.capFor(category);
    return Number.isFinite(cap) ? cap : cfg.globalCap;
  }

  // Which limit (if any) blocks a request. Null when there is room.
  function blockingLimit(category, sustained) {
    if (active.size >= cfg.globalCap) return 'global';
    if (countIn(category) >= capFor(category)) return 'category';
    if (sustained && countSustained() >= cfg.loopCap) return 'loop';
    return null;
  }

  // Oldest strictly-lower-priority token that would actually free the blocked limit.
  function evictionCandidate(limit, category, priority, sustained) {
    let best = null;
    for (const [token, rec] of active) {
      if (rec.priority >= priority) continue;
      if (limit === 'category' && rec.category !== category) continue;
      if (limit === 'loop' && !rec.sustained) continue;
      if (!best || rec.seq < best.rec.seq) best = { token, rec };
    }
    return best;
  }

  function grant(category, priority, sustained, meta) {
    const token = nextToken++;
    active.set(token, { category, priority, sustained, seq: seq++, meta });
    return token;
  }

  return {
    // Soft: refuses at cap, never displaces anything.
    reserve(category, priority, meta = null, { sustained = false } = {}) {
      if (blockingLimit(category, sustained)) return null;
      return grant(category, priority, sustained, meta);
    },

    // Displaces the oldest strictly-lower-priority voice when that frees the blocked limit.
    // Returns { token, evicted } or null. `evicted` is the displaced token, or null.
    reserveOrPreempt(category, priority, meta = null, { sustained = false } = {}) {
      const limit = blockingLimit(category, sustained);
      if (!limit) return { token: grant(category, priority, sustained, meta), evicted: null };

      const victim = evictionCandidate(limit, category, priority, sustained);
      if (!victim) return null;
      const evictedMeta = victim.rec.meta;
      active.delete(victim.token);

      // Displacing one voice can still leave a different limit blocking.
      if (blockingLimit(category, sustained)) {
        active.set(victim.token, victim.rec);
        return null;
      }
      return { token: grant(category, priority, sustained, meta), evicted: victim.token, evictedMeta };
    },

    release(token) {
      if (token == null) return false;
      return active.delete(token);
    },

    activeCount(category) {
      if (category === undefined) return active.size;
      return countIn(category);
    },

    sustainedCount: countSustained,

    metaFor(token) {
      return active.get(token)?.meta ?? null;
    },

    // Reclamps future reservations. Tokens already held stay valid. A cap set here is PINNED:
    // it stops tracking SOUND_PARAMS for that field.
    setLimits(partial = {}) {
      if (Number.isFinite(partial.globalCap)) cfg.globalCap = partial.globalCap;
      if (Number.isFinite(partial.loopCap)) cfg.loopCap = partial.loopCap;
      if (partial.categoryCaps) cfg.pinCategoryCaps(partial.categoryCaps);
    },

    getLimits() {
      return { globalCap: cfg.globalCap, loopCap: cfg.loopCap, categoryCaps: { ...cfg.categoryCaps } };
    },

    reset() {
      active.clear();
    },
  };
}
