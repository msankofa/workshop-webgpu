// bot-voice-director.js -- arbitration for bot squad chatter. Pure logic: no AudioContext, no
// THREE, no DOM, so the whole policy is Node-testable (test-bot-voice.mjs).
//
// With up to 90 bots every one of which can legitimately have something to say, the interesting
// problem is not synthesis, it is refusal. Seven gates run before a line is allowed to speak:
// distance cull, event dedup, per-bot cooldown, per-team-per-line cooldown, squad rate, global
// rate, and finally the shared concurrency budget (combat-audio-budget.js) which is what lets a
// "grenade!" warning displace an ambient bark at the cap.
//
// Requests are DROPPED, never queued: a callout is a reaction to the current moment, and a line
// that plays two seconds late no longer describes what the bot is doing.

import { createAudioBudget, AUDIO_PRIORITY } from './combat-audio-budget.js';
import { SOUND_PARAMS } from './sound-params.js';
import { REFLEX_LINES } from './bot-voice.js';

// Line ranking. Higher speaks over lower and may preempt it at the cap.
export const LINE_PRIORITY = Object.freeze({
  grenade_warn: 100,
  death: 96,          // a bot's own death cry -- involuntary, must not be routinely drowned out
  man_down: 90,
  grenade_hit: 84,     // self, wounded by blast -- ranks with/above contact, own safety
  contact: 80,
  hit: 78,             // self, wounded by bullet
  enemy_down: 70,
  near_miss: 68,       // self, shot at but not hit
  no_ammo: 66,
  ally_hit: 62,        // witness report: teammate wounded (not killed -- that's man_down)
  cover: 60,
  grenade_out: 58,
  reviving: 55,
  sidearm: 50,
  reloading: 45,
  firing: 40,
  order_ack_squad: 36, // leader confirming a player order for the whole squad -- outranks ambient "moving up"
  moving: 35,
  order_ack: 32,       // a single commanded bot confirming a player order
  overwatch: 30,
  order_follow: 24,    // a squadmate's brief "roger" echo -- pure texture, easily preempted
  spawn: 20,           // flavour only, never worth preempting anything for
});

// Lines at or above this rank are alerts: they map to AUDIO_PRIORITY.voiceAlert and can displace
// barks. Lives in SOUND_PARAMS.director so the studio can move the alert/bark line.
const alertRank = () => SOUND_PARAMS.director.alertRank;

// Ambient flavour -- true squad texture rather than information. The chattiness control silences
// these first, because they are what turns 90 bots into a wall of noise.
export const AMBIENT_LINES = Object.freeze(new Set(['firing', 'moving', 'overwatch', 'reloading', 'spawn']));
const ambientMinChattiness = () => SOUND_PARAMS.director.ambientMinChattiness;

// Per-line-type cooldown, scoped PER TEAM: one side saying "taking cover" must never silence the
// other side saying it. Lines an unlucky listener needs to hear repeat sooner.
export const LINE_COOLDOWN_MS = Object.freeze({
  grenade_warn: 900,
  death: 1000,         // almost never worth silencing -- each bot only ever fires this once
  man_down: 2200,
  contact: 2600,
  enemy_down: 2600,
  grenade_hit: 3200,
  hit: 2800,
  near_miss: 4800,      // the most frequent of the six -- every stray round can trigger this
  no_ammo: 5000,
  ally_hit: 3600,
  cover: 3200,
  grenade_out: 3000,
  reviving: 5000,
  sidearm: 4500,
  reloading: 3400,
  firing: 4200,
  moving: 5200,
  overwatch: 6000,
  spawn: 4000,          // wave spawns can add 10+ bots at once; also chattiness-gated (AMBIENT_LINES)
  // Player-command replies: deliberate and comparatively rare (a mouse click, not an FSM tick), so
  // these stay short -- a long cooldown would swallow a second order given to a different squad
  // moments later, since LINE_COOLDOWN_MS is scoped per team, not per bot.
  order_ack_squad: 2000,
  order_ack: 1500,
  order_follow: 1200,
});

// Live view of SOUND_PARAMS.director in the shape createVoiceDirector expects. Read it, do not
// hold it: sound-studio.html edits the underlying values while a sim is running.
export const VOICE_DIRECTOR_DEFAULTS = {
  get speakerCap() { return SOUND_PARAMS.director.speakerCap; },        // concurrent speakers, via the shared budget
  get botCooldownMs() { return SOUND_PARAMS.director.botCooldownMs; },  // one bot may not speak again inside this
  get dedupMs() { return SOUND_PARAMS.director.dedupMs; },              // one event key produces exactly one speaker
  get maxDistance() { return SOUND_PARAMS.director.maxDistance; },      // beyond this a line is dropped before any node graph
  get globalRate() { return { windowMs: SOUND_PARAMS.director.globalRateWindowMs, max: SOUND_PARAMS.director.globalRateMax }; },
  get squadRate() { return { windowMs: SOUND_PARAMS.director.squadRateWindowMs, max: SOUND_PARAMS.director.squadRateMax }; },
  get chattiness() { return SOUND_PARAMS.director.chattiness; },        // 0 = silent, 1 = default, 2 = talkative
};

// The bucket holds a getter, not a snapshot, so a window edited mid-session takes effect.
function rateBucket(specFn) { return { spec: specFn, start: -Infinity, count: 0 }; }

// Consume one slot if the window allows it. Windows are tumbling, not sliding: cheap and the
// resulting burstiness is inaudible at these rates.
function takeBucket(b, now, maxOverride) {
  const spec = b.spec();
  const max = Number.isFinite(maxOverride) ? maxOverride : spec.max;
  if (max <= 0) return false;
  if (now - b.start > spec.windowMs) { b.start = now; b.count = 0; }
  if (b.count >= max) return false;
  b.count++;
  return true;
}

// An entry in SOUND_PARAMS.linePriority overrides the table above for that line.
// The gate that catches typos must not also reject lines added through the studio. A line counts
// as real if the code ships it, or if the override document defines it or ranks it -- anything
// else is a misspelled id and should still be dropped rather than quietly taking a slot.
export function knownLine(lineId) {
  if (!lineId) return false;
  return lineId in LINE_PRIORITY
    || Object.prototype.hasOwnProperty.call(SOUND_PARAMS.voiceLines || {}, lineId)
    || Object.prototype.hasOwnProperty.call(SOUND_PARAMS.linePriority || {}, lineId);
}

export function linePriority(lineId) {
  const override = SOUND_PARAMS.linePriority?.[lineId];
  if (Number.isFinite(override)) return override;
  return LINE_PRIORITY[lineId] ?? 10;
}

export function lineCooldownMs(lineId) {
  const override = SOUND_PARAMS.lineCooldownMs?.[lineId];
  if (Number.isFinite(override)) return override;
  return LINE_COOLDOWN_MS[lineId] ?? 3000;
}

// Everything at or above the alert rank competes as an alert in the shared budget; the rest are barks.
export function budgetPriorityFor(lineId) {
  return linePriority(lineId) >= alertRank() ? AUDIO_PRIORITY.voiceAlert : AUDIO_PRIORITY.voiceBark;
}

export function createVoiceDirector(options = {}) {
  // A field passed in `options` is PINNED to that value; everything else tracks SOUND_PARAMS
  // live, so the studio can retune a director the viewers already built.
  const pin = {};
  for (const key of ['speakerCap', 'botCooldownMs', 'dedupMs', 'maxDistance', 'chattiness']) {
    if (options[key] !== undefined) pin[key] = options[key];
  }
  const cfg = {
    enabled: options.enabled,
    get speakerCap() { return pin.speakerCap ?? VOICE_DIRECTOR_DEFAULTS.speakerCap; },
    set speakerCap(v) { pin.speakerCap = v; },
    get botCooldownMs() { return pin.botCooldownMs ?? VOICE_DIRECTOR_DEFAULTS.botCooldownMs; },
    get dedupMs() { return pin.dedupMs ?? VOICE_DIRECTOR_DEFAULTS.dedupMs; },
    get maxDistance() { return pin.maxDistance ?? VOICE_DIRECTOR_DEFAULTS.maxDistance; },
    set maxDistance(v) { pin.maxDistance = v; },
    get chattiness() { return pin.chattiness ?? VOICE_DIRECTOR_DEFAULTS.chattiness; },
    set chattiness(v) { pin.chattiness = v; },
    get globalRate() { return { ...VOICE_DIRECTOR_DEFAULTS.globalRate, ...(options.globalRate || {}) }; },
    get squadRate() { return { ...VOICE_DIRECTOR_DEFAULTS.squadRate, ...(options.squadRate || {}) }; },
  };

  // The budget owns the concurrency ceiling so voice competes with the other combat audio tracks
  // on one number instead of policing itself in isolation.
  // No setLimits() here any more: the budget's voice cap already IS director.speakerCap, read
  // live. Pinning it at construction is what used to freeze the cap at its boot-time value.
  const budget = options.budget || createAudioBudget();
  if (pin.speakerCap !== undefined) budget.setLimits({ categoryCaps: { voice: pin.speakerCap } });

  const botCooldownUntil = new Map();   // botId -> ms
  const lineCooldownUntil = new Map();  // `${team}|${lineId}` -> ms
  const dedupUntil = new Map();         // eventKey -> ms
  const squadBuckets = new Map();       // squadId -> bucket
  const globalBucket = rateBucket(() => cfg.globalRate);
  const active = new Map();             // token -> { botId, lineId, endsAt, priority }
  const stats = { spoken: 0, dropped: 0, byReason: Object.create(null) };

  function chatScale() { return Math.max(0, cfg.chattiness); }

  // Louder chattiness means more lines AND shorter silences between them.
  function cooldownScale() {
    const c = chatScale();
    return c <= 0 ? Infinity : 1 / Math.min(2, Math.max(0.25, c));
  }

  function drop(reason) {
    stats.dropped++;
    stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
    return { ok: false, reason };
  }

  function pruneMap(map, now) {
    for (const [k, until] of map) if (now >= until) map.delete(k);
  }

  // Retire finished speakers; their budget tokens must come back or the cap leaks. The cooldown
  // maps are swept on the same tick (throttled) so a viewer never has to remember to call prune.
  const PRUNE_INTERVAL_MS = 5000;
  let lastPruneAt = -Infinity;
  function update(now) {
    for (const [token, rec] of active) {
      if (now >= rec.endsAt) { active.delete(token); budget.release(token); }
    }
    if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      pruneMap(botCooldownUntil, now); pruneMap(lineCooldownUntil, now); pruneMap(dedupUntil, now);
    }
  }

  // `req`: { lineId, botId, teamId, squadId, eventKey, now, distance, durationS }
  // Returns { ok:true, token, lineId, botId, evicted } or { ok:false, reason }.
  function request(req) {
    const now = Number.isFinite(req?.now) ? req.now : 0;
    update(now);

    const lineId = req?.lineId;
    if (!knownLine(lineId)) return drop('unknownLine');
    if (cfg.enabled === false) return drop('disabled');
    const reflex = REFLEX_LINES.has(lineId);
    const chat = chatScale();
    // Reflex lines (pain/death) are a body doing something, not a squad choosing to talk more or
    // less -- the chattiness dial must never be able to silence one outright.
    if (chat <= 0 && !reflex) return drop('chattiness');
    if (AMBIENT_LINES.has(lineId) && chat < ambientMinChattiness()) return drop('ambientGated');

    const distance = Number.isFinite(req.distance) ? req.distance : 0;
    if (distance > cfg.maxDistance) return drop('distance');

    const botId = req.botId ?? null;
    const teamId = req.teamId ?? 'none';
    const eventKey = req.eventKey || null;

    if (eventKey && (dedupUntil.get(eventKey) ?? -Infinity) > now) return drop('dedup');
    if ((botCooldownUntil.get(botId) ?? -Infinity) > now) return drop('botCooldown');

    const lineKey = `${teamId}|${lineId}`;
    if ((lineCooldownUntil.get(lineKey) ?? -Infinity) > now) return drop('lineCooldown');

    // Rate buckets scale to zero max at chattiness 0 (by design, for ordinary chatter) -- a reflex
    // line skips them entirely rather than being scaled, for the same reason it skips the mute above.
    // Cooldown, dedup and the speaker-cap budget below still apply, so this isn't unlimited.
    if (!reflex) {
      const squadId = req.squadId ?? null;
      if (squadId != null) {
        let b = squadBuckets.get(squadId);
        if (!b) { b = rateBucket(() => cfg.squadRate); squadBuckets.set(squadId, b); }
        if (!takeBucket(b, now, Math.round(cfg.squadRate.max * Math.min(2, chat)))) return drop('squadRate');
      }
      if (!takeBucket(globalBucket, now, Math.round(cfg.globalRate.max * Math.min(2, chat)))) return drop('globalRate');
    }

    const priority = linePriority(lineId);
    const granted = budget.reserveOrPreempt('voice', budgetPriorityFor(lineId), { botId, lineId }, { sustained: false });
    if (!granted) return drop('busy');

    // A preempted speaker loses its slot immediately. Its already-scheduled one-shot finishes on
    // its own -- WebAudio one-shots cannot be recalled -- but nothing new queues behind it.
    let evicted = null;
    if (granted.evicted != null) {
      evicted = active.get(granted.evicted) || granted.evictedMeta || null;
      active.delete(granted.evicted);
    }

    const durationS = Number.isFinite(req.durationS) && req.durationS > 0 ? req.durationS : 1;
    active.set(granted.token, { botId, lineId, endsAt: now + durationS * 1000, priority });

    // Reflex lines keep their raw cooldown rather than the chattiness-stretched one -- otherwise a
    // low-but-nonzero chattiness setting could still leave a bot unable to yell in pain for many
    // seconds after being hit, which is the same "controlled by chattiness" problem as the mute above.
    const scale = reflex ? 1 : cooldownScale();
    botCooldownUntil.set(botId, now + cfg.botCooldownMs * scale);
    lineCooldownUntil.set(lineKey, now + lineCooldownMs(lineId) * scale);
    if (eventKey) dedupUntil.set(eventKey, now + cfg.dedupMs);

    stats.spoken++;
    return { ok: true, token: granted.token, lineId, botId, priority, evicted };
  }

  // Several bots can legitimately report the same event. The nearest to the listener speaks; the
  // event-key dedup then silences the rest, so the callout comes from where the player is looking.
  function requestBest(requests) {
    const list = (requests || []).filter(Boolean)
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    let last = drop('noCandidates');
    for (const req of list) {
      last = request(req);
      if (last.ok) return last;
    }
    return last;
  }

  // Called when a voice actually ends early (or failed to start after being granted).
  function release(token) {
    if (token == null) return false;
    active.delete(token);
    return budget.release(token);
  }

  return {
    request,
    requestBest,
    release,
    update,
    // Housekeeping for long sessions: retire finished speakers, then drop expired timestamps
    // (the three cooldown/dedup maps are the only unbounded state).
    prune(now) {
      update(now);
      pruneMap(botCooldownUntil, now); pruneMap(lineCooldownUntil, now); pruneMap(dedupUntil, now);
    },
    activeCount: () => active.size,
    activeSpeakers: () => Array.from(active.values()),
    setChattiness(v) { cfg.chattiness = Math.max(0, Number(v) || 0); },
    getChattiness: () => cfg.chattiness,
    setMaxDistance(v) { if (Number.isFinite(v) && v > 0) cfg.maxDistance = v; },
    setSpeakerCap(v) {
      if (!Number.isFinite(v) || v < 1) return;
      cfg.speakerCap = Math.round(v);          // pins it; the budget must be pinned to match
      budget.setLimits({ categoryCaps: { voice: cfg.speakerCap } });
    },
    getConfig: () => ({ ...cfg }),
    getStats: () => ({ spoken: stats.spoken, dropped: stats.dropped, byReason: { ...stats.byReason } }),
    reset() {
      for (const token of active.keys()) budget.release(token);
      active.clear(); botCooldownUntil.clear(); lineCooldownUntil.clear(); dedupUntil.clear();
      squadBuckets.clear(); globalBucket.start = -Infinity; globalBucket.count = 0;
      stats.spoken = 0; stats.dropped = 0; stats.byReason = Object.create(null);
    },
  };
}
