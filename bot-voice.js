// bot-voice.js -- robotic squad-radio voices for combat bots. Pure WebAudio: no THREE, no DOM
// beyond the AudioContext handed to a builder. A builder follows the weapon-sfx-synth.js contract:
// `build(ctx, destination, t0) => durationSeconds`, connects only to `destination`, and schedules
// everything with AudioParam automation from t0 (never setTimeout).
//
// Model: a buzzy glottal carrier (saw + square) at a per-bot fundamental drives three parallel
// bandpass "formant" filters at F1/F2/F3, summed and gated by a per-syllable envelope. That is a
// talkbox/vocoder, so the result reads as a machine speaking rather than as a beep.
//
// Every line carries a deliberately distinct rhythmic signature (syllable count, duration profile,
// total length) so a player learns the vocabulary by ear from half-heard fragments.
// test-bot-voice.mjs guards those signatures against drift.

import { jitter, seededUnit, noiseSource, filterNode, saturator, FLOOR } from './synth-utils.js';
import { SOUND_PARAMS } from './sound-params.js';

// Read at build time, never destructured at module scope: an override applied after import has to
// reach code that already loaded. sound-studio.html edits these live.
const P = () => SOUND_PARAMS.voice;

// Peterson & Barney adult-male steady-state vowel formants, Hz: [F1, F2, F3].
export const VOWEL_FORMANTS = Object.freeze({
  i:  [270, 2290, 3010],   // "beet"
  ih: [390, 1990, 2550],   // "bit"
  eh: [530, 1840, 2480],   // "bet"
  ae: [660, 1720, 2410],   // "bat"
  ah: [730, 1090, 2440],   // "father"
  aw: [570,  840, 2410],   // "bought"
  uh: [440, 1020, 2240],   // "book"
  uu: [300,  870, 2240],   // "boot"
  er: [640, 1190, 2390],   // "but"
  rr: [490, 1350, 1690],   // "bird" (r-coloured)
});

const V = VOWEL_FORMANTS;

// One syllable frame: which vowel colours it, how long it is voiced, the silence after it, and how
// loud its peak is. `gapMs` on the last frame is always 0 -- the phrase ends when its voicing does.
function syl(vowel, durMs, gapMs, peak) {
  return { formant: V[vowel], vowel, durMs, gapMs, peak };
}

// The lexicon. `text` is the English the rhythm was authored from; nothing reads it but a debug
// readout. `contour` is [startMultiplier, endMultiplier] on the fundamental across the phrase --
// a falling contour states, a steep fall shouts, a flat contour reports.
export const VOICE_LINES = Object.freeze({
  // --- alerts: short, front-loaded, unmistakable ---
  grenade_warn: {
    event: 'bot_vo_grenade_warn', text: 'GRENADE!', contour: [1.22, 0.86], drive: 6.5,
    syllables: [syl('rr', 190, 25, 1.0), syl('eh', 85, 0, 0.62)],
  },
  grenade_out: {
    event: 'bot_vo_grenade_out', text: 'frag out', contour: [1.06, 0.92], drive: 5,
    syllables: [syl('ae', 120, 50, 0.85), syl('uh', 200, 0, 0.8)],
  },
  man_down: {
    event: 'bot_vo_man_down', text: 'man down', contour: [1.1, 0.8], drive: 5.5,
    syllables: [syl('ae', 150, 60, 0.92), syl('ah', 230, 0, 0.95)],
  },

  // --- tactical: three beats ---
  firing: {
    event: 'bot_vo_firing', text: 'engaging', contour: [1.04, 0.94], drive: 4,
    syllables: [syl('eh', 105, 25, 0.7), syl('ae', 150, 20, 0.9), syl('ih', 120, 0, 0.6)],
  },
  sidearm: {
    event: 'bot_vo_sidearm', text: 'sidearm', contour: [1.0, 0.9], drive: 4,
    syllables: [syl('ah', 95, 30, 0.7), syl('i', 100, 35, 0.65), syl('rr', 210, 0, 0.8)],
  },
  moving: {
    event: 'bot_vo_moving', text: 'moving up', contour: [1.02, 1.06], drive: 4,
    syllables: [syl('uu', 150, 30, 0.75), syl('ih', 95, 55, 0.6), syl('er', 230, 0, 0.9)],
  },
  reloading: {
    event: 'bot_vo_reloading', text: 'reloading', contour: [1.0, 0.97], drive: 3.5,
    syllables: [syl('i', 180, 55, 0.7), syl('uh', 180, 55, 0.7), syl('ih', 180, 0, 0.7)],
  },

  // --- four beats ---
  reviving: {
    event: 'bot_vo_reviving', text: 'reviving', contour: [1.0, 0.95], drive: 3.5,
    syllables: [syl('i', 95, 25, 0.6), syl('ah', 110, 25, 0.75), syl('ah', 165, 25, 0.7), syl('ih', 110, 0, 0.55)],
  },
  cover: {
    event: 'bot_vo_cover', text: 'taking cover', contour: [1.05, 0.88], drive: 4.5,
    syllables: [syl('eh', 150, 25, 0.85), syl('ih', 95, 50, 0.55), syl('er', 165, 30, 0.85), syl('rr', 145, 0, 0.7)],
  },
  enemy_down: {
    event: 'bot_vo_enemy_down', text: 'enemy down', contour: [1.03, 0.85], drive: 4.5,
    syllables: [syl('eh', 100, 30, 0.7), syl('ih', 95, 30, 0.6), syl('i', 115, 65, 0.65), syl('ah', 355, 0, 0.9)],
  },
  contact: {
    event: 'bot_vo_contact', text: 'target spotted', contour: [1.12, 0.9], drive: 5,
    syllables: [syl('ah', 190, 30, 0.95), syl('eh', 120, 55, 0.6), syl('aw', 200, 30, 0.9), syl('ih', 145, 0, 0.6)],
  },
  no_ammo: {
    event: 'bot_vo_no_ammo', text: 'out of ammo', contour: [1.08, 0.82], drive: 5,
    syllables: [syl('uh', 275, 60, 0.9), syl('er', 95, 35, 0.55), syl('ae', 150, 40, 0.8), syl('uu', 235, 0, 0.7)],
  },
  overwatch: {
    event: 'bot_vo_overwatch', text: 'covering fire', contour: [0.98, 0.92], drive: 3.5,
    syllables: [syl('er', 140, 30, 0.7), syl('rr', 95, 30, 0.55), syl('ih', 130, 70, 0.6), syl('ah', 430, 0, 0.85)],
  },

  // --- reactions: self/ally state, added 2026-08-05 ---
  // Durations deliberately sit well outside the existing per-count clusters (test-bot-voice.mjs's
  // pooled MIN_RHYTHM_DISTANCE check enforces this) rather than following English syllable timing --
  // every line in this file is already a stylised approximation, not a phonetic transcription.
  // One sharp syllable, not two -- and every line here must run longer than grenade_warn (the one
  // that must always read as the fastest to get out), which a clipped "I'm hit" easily undercuts.
  hit: {
    event: 'bot_vo_hit', text: "I'm hit", contour: [1.1, 0.8], drive: 5.5,
    syllables: [syl('ih', 360, 0, 1.0)],
  },
  grenade_hit: {
    event: 'bot_vo_grenade_hit', text: 'frag got me', contour: [1.2, 0.85], drive: 6,
    syllables: [syl('ae', 75, 25, 0.85), syl('aw', 75, 25, 0.85), syl('i', 110, 0, 0.95)],
  },
  near_miss: {
    event: 'bot_vo_near_miss', text: 'taking fire', contour: [1.05, 0.95], drive: 4.5,
    syllables: [syl('eh', 80, 25, 0.7), syl('ih', 80, 25, 0.65), syl('rr', 155, 0, 0.9)],
  },
  spawn: {
    event: 'bot_vo_spawn', text: 'ready to go', contour: [1.02, 1.1], drive: 4,
    syllables: [syl('eh', 70, 20, 0.7), syl('ih', 60, 20, 0.6), syl('uh', 60, 20, 0.6), syl('aw', 150, 0, 0.9)],
  },
  ally_hit: {
    event: 'bot_vo_ally_hit', text: "he's bleeding", contour: [1.0, 0.9], drive: 4.5,
    syllables: [syl('eh', 180, 60, 0.75), syl('i', 310, 0, 0.9)],
  },
  // Not a phrase -- a reflex. One long breaking cry, not syllable beats.
  death: {
    event: 'bot_vo_death', text: 'aagh', contour: [1.1, 0.5], drive: 7,
    syllables: [syl('ah', 420, 0, 1.0)],
  },

  // --- player commands: order acknowledgment, added 2026-08-07 ---
  // Fired from the right-click command menu (bot-viewer-v2.html's issueCommand/announceOrder), not
  // from the FSM -- a deliberate reply to something the player just did, not autonomous chatter.
  // order_ack is a lone/independent bot (or a squad member who isn't the leader) confirming a move
  // order; order_ack_squad is a squad LEADER confirming for the whole squad ("we're..." framing);
  // order_follow is one squadmate's brief call-and-response reply to the leader's callout. All three
  // are ordinary radio chatter (not REFLEX_LINES) -- ordinary chattiness/radio/range rules apply.
  // Durations are picked purely to clear MIN_RHYTHM_DISTANCE and the grenade_warn floor, same as
  // every other line here -- syllable COUNT is what actually keeps a same-count cluster apart (a
  // count mismatch is always maximally distinct; see distanceOf()), so the three deliberately use
  // three different counts (3, 4, 1) rather than competing for room in one bucket.
  order_ack: {
    event: 'bot_vo_order_ack', text: 'moving out', contour: [1.0, 0.95], drive: 3.5,
    syllables: [syl('uu', 220, 50, 0.75), syl('ih', 160, 50, 0.6), syl('aw', 320, 0, 0.9)],
  },
  order_ack_squad: {
    event: 'bot_vo_order_ack_squad', text: "we're moving out", contour: [1.03, 0.92], drive: 4,
    syllables: [syl('er', 90, 20, 0.8), syl('uu', 75, 20, 0.7), syl('ih', 65, 20, 0.65), syl('aw', 180, 0, 0.95)],
  },
  order_follow: {
    event: 'bot_vo_order_follow', text: 'roger', contour: [0.98, 0.9], drive: 3,
    syllables: [syl('aw', 520, 0, 0.85)],
  },
});

// Lines that come out of a bot's body, not its radio: pain grunts and a death cry, not a deliberate
// call to the squad. A soldier doesn't key a radio to scream -- so unlike every other line, these
// always play clean (never the `radio` comms-band treatment) and always positional in the local
// area around the bot (never flat/earpiece, even for a bot sharing the listener's net), and they
// are exempt from the chattiness dial's silence/scaling: chattiness models radio discipline, and a
// reflex is not a discipline choice. Consumed by both viewers (playBotVoice/botVoiceDurationS) and
// by bot-voice-director.js (imported there for the chattiness exemption).
export const REFLEX_LINES = Object.freeze(new Set(['hit', 'grenade_hit', 'near_miss', 'death']));

// The lines this module ships. Callers that must see studio-authored additions want lineIds().
export const LINE_IDS = Object.freeze(Object.keys(VOICE_LINES));

// Every line that currently exists: the authored ones plus anything added through the override
// map. New ids sort last so the built-in vocabulary keeps a stable order in every list that
// renders it.
export function lineIds() {
  const extra = Object.keys(SOUND_PARAMS.voiceLines || {}).filter(id => !(id in VOICE_LINES));
  return extra.length ? [...LINE_IDS, ...extra] : [...LINE_IDS];
}

// What the line says, in words. Only the TTS bake reads this, but an added line has no authored
// default, so the override has to be able to carry it.
export function lineText(lineId) {
  return SOUND_PARAMS.voiceLines?.[lineId]?.text ?? VOICE_LINES[lineId]?.text ?? String(lineId).replace(/_/g, ' ');
}

// SFX event id for a line, so a caller can prefer a loaded sample over the synth voice.
export function voiceEventId(lineId) {
  return SOUND_PARAMS.voiceLines?.[lineId]?.event ?? VOICE_LINES[lineId]?.event ?? null;
}

// An entry in SOUND_PARAMS.voiceLines replaces the authored default for that line. The studio
// writes those; this module stays the authority on the defaults themselves.
export function voiceLine(lineId) {
  if (!lineId) return null;
  const override = SOUND_PARAMS.voiceLines?.[lineId];
  if (override && Array.isArray(override.syllables) && override.syllables.length) return override;
  if (!Object.prototype.hasOwnProperty.call(VOICE_LINES, lineId)) return null;
  return VOICE_LINES[lineId];
}

// Resolve a vowel name to formants, so an override may name vowels instead of repeating numbers.
export function formantsFor(vowel) {
  return VOWEL_FORMANTS[vowel] ? VOWEL_FORMANTS[vowel].slice() : null;
}

// ---- variant diversity + intensity ------------------------------------------------------------
// A line's canonical text/contour/drive/syllables (above) is variant 0, implicit intensity 0.5.
// `voiceLine(id).variants` (or its SOUND_PARAMS.voiceLines[id].variants override mirror) adds more:
// { text, contour?, drive?, syllables?, intensity }. Shared by the studio's ADD VARIANT flow and
// the runtime picker, so both agree on what a valid variant looks like.

// Seed a new variant/line with a plausible rhythm rather than an empty one: one syllable per vowel
// group in the text, so a phrase already has roughly the right beat count before anyone tunes it.
// Moved here from sound-studio.html so bot-voice.js's own lineVariants() can auto-seed a variant
// that only specified text -- the studio and the runtime resolver must agree on one heuristic, not
// keep two that can drift.
const VOWEL_GUESS = { a: 'ah', e: 'eh', i: 'ih', o: 'oh', u: 'uh', y: 'ih' };
export function seedSyllables(text) {
  const groups = String(text).toLowerCase().match(/[aeiouy]+/g) || ['a'];
  const n = Math.min(6, groups.length);
  return groups.slice(0, n).map((g, i) => ({
    vowel: VOWEL_GUESS[g[0]] || 'ah',
    durMs: i === n - 1 ? 260 : 150,          // phrases land on their last syllable
    gapMs: i === n - 1 ? 0 : 45,
    peak: i === 0 ? 0.85 : 0.7,
  }));
}

// A candidate is only usable if its intensity is a real 0..1 number -- anything else is excluded
// from the picker's pool rather than treated as an error. The base (index 0) always validates,
// which is what guarantees the pool is never empty: worst case every authored variant fails and
// selection degrades to "always speak the base," exactly today's behavior.
function validIntensity(v) {
  return Number.isFinite(v?.intensity) && v.intensity >= 0 && v.intensity <= 1;
}

// All variants of a line for the SYNTH voice (the shared/global lexicon -- VOICE_LINES plus its
// SOUND_PARAMS.voiceLines override, unaffected by per-ElevenLabs-voice lexicons). Index 0 is
// always the canonical text/contour/drive/syllables with an implicit intensity of 0.5. A missing
// `syllables` on an authored variant is auto-seeded from its text, same heuristic a brand-new line
// already gets.
export function lineVariants(lineId) {
  const line = voiceLine(lineId);
  if (!line) return [];
  const base = { text: line.text, contour: line.contour, drive: line.drive, syllables: line.syllables, intensity: 0.5 };
  const extra = (Array.isArray(line.variants) ? line.variants : [])
    .filter(validIntensity)
    .map(v => ({
      text: v.text, contour: v.contour || line.contour, drive: v.drive ?? line.drive,
      syllables: Array.isArray(v.syllables) && v.syllables.length ? v.syllables : seedSyllables(v.text || line.text),
      intensity: v.intensity,
    }));
  return [base, ...extra];
}

// All variants of a line for a specific ElevenLabs voice's baked TTS. Text-only (no syllables --
// the audio is already recorded); falls back to the shared lexicon's text when this voice has
// nothing authored for this line, so a voice with partial content still speaks every event. See
// docs/superpowers/plans/2026-08-03-bot-voice-intensity-plan.md Appendix B.
export function voiceLexiconVariants(voiceId, lineId) {
  const custom = SOUND_PARAMS.voiceLexicon?.[voiceId]?.[lineId]?.variants;
  if (Array.isArray(custom) && custom.length) {
    const valid = custom.filter(v => typeof v.text === 'string' && v.text && validIntensity(v));
    if (valid.length) return valid.map(v => ({ text: v.text, intensity: v.intensity }));
  }
  return lineVariants(lineId).map(v => ({ text: v.text, intensity: v.intensity }));
}

// Round-robin rotation state, per (rotationKey, lineId): only advances on a variant that actually
// got spoken (see commitVariantIndex), so a request the director dropped never burns a step -- the
// next peek re-offers the same index rather than silently skipping ahead.
const lastVariantIdx = new Map();

// The index `pickVariantIndex` would return right now, WITHOUT mutating rotation state. Callers
// that need a duration estimate before knowing whether a request will be granted (the director's
// two-step request/play split) must peek, not pick, so an estimate and the eventual playback agree.
export function peekVariantIndex(variants, targetIntensity, rotationKey) {
  if (!Array.isArray(variants) || !variants.length) return 0;
  if (variants.length === 1) return 0;
  let bestDist = Infinity;
  for (const v of variants) bestDist = Math.min(bestDist, Math.abs(v.intensity - targetIntensity));
  const epsilon = SOUND_PARAMS.voiceIntensity.tieEpsilon;
  const tieSet = [];
  variants.forEach((v, i) => { if (Math.abs(v.intensity - targetIntensity) - bestDist <= epsilon) tieSet.push(i); });
  if (tieSet.length === 1) return tieSet[0];
  const last = lastVariantIdx.get(rotationKey);
  const lastPos = last == null ? -1 : tieSet.indexOf(last);
  return tieSet[(lastPos + 1) % tieSet.length];
}

// Commits a peeked index into the rotation, so the NEXT peek for this key advances rather than
// re-offering the same variant. Call only after the line actually played.
export function commitVariantIndex(rotationKey, index) {
  lastVariantIdx.set(rotationKey, index);
}

// Test isolation / scene teardown. Module-level state, mirrors bot-voice-director.js's reset().
export function resetVariantRotation() {
  lastVariantIdx.clear();
}

// Normalise a syllable from either form: {vowel} or an explicit {formant:[F1,F2,F3]}.
function frameFormant(s) {
  if (Array.isArray(s.formant) && s.formant.length === 3) return s.formant;
  return VOWEL_FORMANTS[s.vowel] || VOWEL_FORMANTS.ah;
}

// ---- rhythm ----------------------------------------------------------------------------------
// A phrase's identity by ear is its beat pattern, not its vowels. These two functions define what
// "recognisably different" means, and the test asserts every pair of lines clears MIN_RHYTHM_DISTANCE.

export const MIN_RHYTHM_DISTANCE = 0.12;

// Shared by rhythmSignature(lineId) (the canonical line) and anything checking a resolved variant
// object directly (test-bot-voice.mjs pools every variant of every line, not just each line's
// canonical phrase -- a variant's rhythm must stay distinguishable from every OTHER line's variants
// too, or the "learn the vocabulary by ear" guarantee this file's header describes silently breaks).
export function signatureOf(line) {
  if (!line || !Array.isArray(line.syllables) || !line.syllables.length) return null;
  const onsetsMs = [];
  let t = 0;
  for (const s of line.syllables) { onsetsMs.push(t); t += s.durMs + s.gapMs; }
  const totalMs = t - line.syllables[line.syllables.length - 1].gapMs;
  return {
    count: line.syllables.length,
    totalMs,
    onsets: onsetsMs.map(v => v / totalMs),
    durs: line.syllables.map(s => s.durMs / totalMs),
  };
}

// { count, totalMs, onsets[], durs[] } with onsets/durs normalised by the phrase length.
export function rhythmSignature(lineId) {
  return signatureOf(voiceLine(lineId));
}

// 0 = indistinguishable, 1 = definitely different. A differing syllable count is already a
// different phrase; otherwise the worst of (relative length, onset drift, duration profile) wins.
function distanceOf(a, b) {
  if (!a || !b) return 0;
  if (a.count !== b.count) return 1;
  let d = Math.abs(a.totalMs - b.totalMs) / Math.max(a.totalMs, b.totalMs);
  for (let i = 0; i < a.count; i++) {
    d = Math.max(d, Math.abs(a.onsets[i] - b.onsets[i]), Math.abs(a.durs[i] - b.durs[i]));
  }
  return d;
}

export function rhythmDistance(lineIdA, lineIdB) {
  return distanceOf(rhythmSignature(lineIdA), rhythmSignature(lineIdB));
}

// Same distance metric, for two already-resolved variant objects (e.g. from lineVariants()).
export function variantRhythmDistance(lineA, lineB) {
  return distanceOf(signatureOf(lineA), signatureOf(lineB));
}

// ---- per-bot identity ------------------------------------------------------------------------
// Matches bot-activity.js's botSeedFromId convention ('bot-7' -> 7) so a bot's voice and its
// behavioural jitter come from the same number.
export function voiceSeedFromId(id) {
  if (typeof id === 'number' && Number.isFinite(id)) return Math.abs(Math.trunc(id));
  return Math.abs(parseInt(String(id ?? '').replace(/\D/g, ''), 10) || 0);
}

// Deterministic voice identity. Same (botId, teamId) always yields the same numbers; different
// bots differ in pitch and vocal-tract scale, and the two sides differ coarsely on top of that.
export function voiceIdentity(botId, teamId = 0) {
  const p = P();
  const seed = voiceSeedFromId(botId);
  const teamSeed = voiceSeedFromId(teamId) + 1;
  const teamPitch = 1 + (seededUnit(teamSeed, 0x51) - 0.5) * p.teamF0Spread;
  const teamFormant = 1 + (seededUnit(teamSeed, 0x77) - 0.5) * p.teamFormantSpread;
  return {
    seed,
    teamSeed,
    f0: (p.f0Min + seededUnit(seed, 0x11) * p.f0Span) * teamPitch,
    formantScale: (p.formantScaleMin + seededUnit(seed, 0x23) * p.formantScaleSpan) * teamFormant,
    rate: p.rateMin + seededUnit(seed, 0x37) * p.rateSpan,   // speaking rate
    buzz: p.buzzMin + seededUnit(seed, 0x59) * p.buzzSpan,   // square/saw mix -- how mechanical the timbre is
  };
}

// Not frozen at import: a params change must move the fallback identity too.
function defaultIdentity() { return voiceIdentity(0, 0); }

// ---- synthesis -------------------------------------------------------------------------------

// Measured: a 3-band bank on a 120 Hz saw passes only what fits in its bands, so Q buys character
// at the cost of level. Q=[9,11,12] threw away 15.8 dB and the lines were inaudible over gunfire;
// [5,6,7] costs 12.4 dB and still reads as formants. voice.makeup restores the rest.
// Every number below now lives in SOUND_PARAMS.voice -- sound-studio.html measures and edits them.

function clampHz(hz) {
  const p = P();
  return Math.min(p.clampHzMax, Math.max(p.clampHzMin, hz));
}

// Absolute schedule for one phrase at a given speaking rate.
function scheduleFor(line, rate, t0) {
  const frames = [];
  let t = t0;
  for (const s of line.syllables) {
    const dur = (s.durMs / 1000) / rate;
    frames.push({ start: t, dur, peak: s.peak, formant: frameFormant(s) });
    t += dur + (s.gapMs / 1000) / rate;
  }
  const last = frames[frames.length - 1];
  return { frames, end: last.start + last.dur };
}

// Total wall time of a line for this identity, including the radio tail when radio is on.
// `variantIndex` must match whatever buildVoiceLine will actually play for this same request --
// variants differ in syllable count/length, so a mismatched index desyncs the director's speaker
// slot from the audio actually playing (see the plan doc's Chapter 2 Part 2 staleness finding).
export function voiceLineDurationS(lineId, identity = null, { radio = true, variantIndex = 0 } = {}) {
  const variants = lineVariants(lineId);
  const line = variants[variantIndex] || variants[0];
  if (!line) return 0;
  const p = P();
  const rate = (identity || defaultIdentity()).rate || 1;
  const { frames, end } = scheduleFor(line, rate, 0);
  void frames;
  return end + (radio ? (p.squelchMs + p.radioTailMs) / 1000 : 0.03);
}

// Short filtered noise burst -- the PTT click at both ends of a radio transmission.
function squelchClick(ctx, destination, t, peak) {
  const dur = P().squelchMs / 1000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(FLOOR, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, FLOOR * 2), t + 0.004);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
  g.connect(destination);
  const bp = filterNode(ctx, 'bandpass', 1800 + jitter() * 900, t, 1.4);
  bp.connect(g);
  noiseSource(ctx, t, dur, jitter() * 1.4).connect(bp);
}

// Builds the radio channel: comms bandwidth, soft-clip drive, then a tighter resonance.
// Returns the node the dry voice should be fed into.
function radioChain(ctx, destination, t0, drive) {
  const p = P();
  const out = ctx.createGain();
  out.gain.setValueAtTime(p.radioOutGain, t0);
  out.connect(destination);

  const tight = filterNode(ctx, 'bandpass', p.radioTightHz + jitter() * 260, t0, p.radioTightQ);
  tight.connect(out);

  const shaper = saturator(ctx, drive);
  shaper.connect(tight);

  const lo = filterNode(ctx, 'highpass', p.radioHighpassHz, t0, 0.7);
  const hi = filterNode(ctx, 'lowpass', p.radioLowpassHz, t0, 0.7);
  lo.connect(hi);
  hi.connect(shaper);
  return lo;
}

// The squad-net treatment around a dry voice: squelch in, hiss tail out. Shared by the synth and
// sample paths so a baked take gets the identical channel.
function radioTopAndTail(ctx, master, t0, endT) {
  const p = P();
  squelchClick(ctx, master, t0, p.squelchInPeak);
  squelchClick(ctx, master, endT, p.squelchOutPeak);
  const tailS = p.radioTailMs / 1000;
  const tail = ctx.createGain();
  tail.gain.setValueAtTime(Math.max(p.tailPeak, FLOOR * 2), endT);
  tail.gain.exponentialRampToValueAtTime(FLOOR, endT + tailS);
  tail.connect(master);
  const hiss = filterNode(ctx, 'bandpass', p.tailBandHz + jitter() * 500, endT, 1.1);
  hiss.connect(tail);
  noiseSource(ctx, endT, tailS, jitter() * 1.4).connect(hiss);
}

// Rectifier for the envelope followers. WaveShaper is the only way to get abs() without a worklet.
let ABS_CURVE = null;
function absCurve() {
  if (!ABS_CURVE) {
    ABS_CURVE = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) ABS_CURVE[i] = Math.abs(-1 + (2 * i) / 1023);
  }
  return ABS_CURVE;
}

// The glottal carrier the synth voice uses, on its own -- the machine half of a vocoded take.
// Per-bot identity lives here, which is why one baked file can serve every bot.
function glottalCarrier(ctx, t0, endT, id, level) {
  const p = SOUND_PARAMS.vocoder;
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(Math.max(level, FLOOR), t0);
  for (const [type, mixLevel, detune] of [['sawtooth', 1 - id.buzz * 0.5, 0], ['square', id.buzz * 0.5, 7]]) {
    const mix = ctx.createGain();
    mix.gain.setValueAtTime(Math.max(mixLevel, FLOOR), t0);
    mix.connect(bus);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.setValueAtTime(detune, t0);
    osc.frequency.setValueAtTime(id.f0, t0);
    osc.connect(mix);
    osc.start(t0);
    osc.stop(endT);
  }
  // A purely tonal carrier has no way to render an "s". This is what gives it one.
  if (p.sibilanceLevel > 0) {
    const hiss = ctx.createGain();
    hiss.gain.setValueAtTime(Math.max(p.sibilanceLevel * level, FLOOR), t0);
    hiss.connect(bus);
    const hp = filterNode(ctx, 'highpass', p.sibilanceHz, t0, 0.7);
    hp.connect(hiss);
    noiseSource(ctx, t0, Math.max(endT - t0, 0.02), jitter() * 1.4).connect(hp);
  }
  return bus;
}

// Channel vocoder: per band, the modulator's own level opens a VCA on the matching carrier band.
// Connecting an audio node straight to a GainNode's .gain param is what makes this work without
// a worklet -- the follower signal IS the control voltage.
function vocode(ctx, modulator, destination, t0, endT, id) {
  const p = SOUND_PARAMS.vocoder;
  const carrier = glottalCarrier(ctx, t0, endT, id, p.carrierGain);
  const out = ctx.createGain();
  out.gain.setValueAtTime(p.outGain, t0);
  out.connect(destination);
  const n = Math.max(2, Math.round(p.bands));
  for (let i = 0; i < n; i++) {
    const hz = p.loHz * Math.pow(p.hiHz / p.loHz, i / (n - 1));
    const analyse = filterNode(ctx, 'bandpass', hz, t0, p.bandQ);
    modulator.connect(analyse);
    const rect = ctx.createWaveShaper();
    rect.curve = absCurve();
    analyse.connect(rect);
    const follow = filterNode(ctx, 'lowpass', p.followHz, t0, 0.7);
    rect.connect(follow);
    const makeup = ctx.createGain();
    makeup.gain.setValueAtTime(p.followGain, t0);
    follow.connect(makeup);

    const synth = filterNode(ctx, 'bandpass', hz, t0, p.bandQ);
    carrier.connect(synth);
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);   // silent until the follower opens it
    makeup.connect(vca.gain);
    synth.connect(vca);
    vca.connect(out);
  }
}

// A baked TTS take played through the same channel as the synth voice. Takes are baked DRY, so the
// radio treatment and the robot vocoder are runtime inserts -- one file plays over comms or out
// loud, as a human or as a machine. Returns a builder honouring the one-shot synth contract.
export function buildSampleVoiceLine(buffer, identity = null, { radio = true, gain = 1, robot = false, drive = 4 } = {}) {
  if (!buffer || !(buffer.duration > 0)) return null;

  return function build(ctx, destination, t0) {
    const p = P();
    const id = identity || defaultIdentity();
    // One knob: WebAudio folds detune into playbackRate, so pitch and pace move together. Bounded,
    // because past roughly +/-8% a resampled take stops sounding like a different speaker and
    // starts sounding like the same speaker on the wrong tape speed.
    const speed = robot ? 1 : Math.min(1.08, Math.max(0.92, (id.rate || 1) * (0.99 + jitter() * 0.02)));
    const phraseDur = buffer.duration / speed;
    const endT = t0 + phraseDur;
    const tailS = radio ? (p.squelchMs + p.radioTailMs) / 1000 : 0.03;

    const limiter = saturator(ctx, p.outputDrive);
    limiter.connect(destination);
    const master = ctx.createGain();
    master.gain.setValueAtTime(Math.max(gain * p.sampleMakeup, FLOOR), t0);
    master.connect(limiter);

    const voiceIn = radio ? radioChain(ctx, master, t0, drive) : master;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.setValueAtTime(speed, t0);
    if (robot) vocode(ctx, src, voiceIn, t0, endT, id);
    else src.connect(voiceIn);
    src.start(t0);
    src.stop(endT + 0.01);

    if (radio) radioTopAndTail(ctx, master, t0, endT);
    return phraseDur + tailS;
  };
}

// The actual synth, shared by every caller that has already resolved a line descriptor
// ({text, contour, drive, syllables}) -- buildVoiceLine (an id + variant index into the shipped
// lexicon) and buildAdHocVoiceLine (raw text an author is previewing before it is registered
// anywhere, e.g. a variant not yet saved). Neither needs its own copy of this synthesis chain.
function buildFromLine(line, identity, { radio = true, gain = 1 } = {}) {
  if (!line) return null;

  return function build(ctx, destination, t0) {
    const p = P();
    const id = identity || defaultIdentity();
    const rate = (id.rate || 1) * (0.98 + jitter() * 0.04);   // per-utterance micro timing wobble
    const { frames, end } = scheduleFor(line, rate, t0);
    const phraseDur = end - t0;
    const tailS = radio ? (p.squelchMs + p.radioTailMs) / 1000 : 0.03;
    const duration = phraseDur + tailS;

    // Soft clip on the way out. The makeup gain lifts RMS from -38 to -30 dBFS, which is what
    // makes a callout carry over gunfire, but it also drags the transient peaks to 0 dBFS -- a
    // ~30 dB crest factor, so the loudest lines clipped on their own before any mixing.
    const limiter = saturator(ctx, p.outputDrive);
    limiter.connect(destination);

    const master = ctx.createGain();
    master.gain.setValueAtTime(Math.max(gain * p.makeup, FLOOR), t0);
    master.connect(limiter);

    const voiceIn = radio ? radioChain(ctx, master, t0, line.drive ?? 4) : master;

    // Syllable envelope: one gain node carrying every frame's attack/decay.
    const env = ctx.createGain();
    env.gain.setValueAtTime(FLOOR, t0);
    for (const f of frames) {
      const attack = Math.min(p.attackMaxS, f.dur * p.attackFraction);
      env.gain.setValueAtTime(FLOOR, f.start);
      env.gain.exponentialRampToValueAtTime(Math.max(f.peak, FLOOR * 2), f.start + attack);
      env.gain.exponentialRampToValueAtTime(FLOOR, f.start + f.dur);
    }

    // Three parallel formant resonators, each gliding between successive vowel targets.
    for (let k = 0; k < 3; k++) {
      const fg = ctx.createGain();
      fg.gain.setValueAtTime(p.formantGain[k], t0);
      fg.connect(voiceIn);
      const bp = filterNode(ctx, 'bandpass', clampHz(frames[0].formant[k] * id.formantScale), t0, p.formantQ[k]);
      bp.connect(fg);
      bp.frequency.linearRampToValueAtTime(clampHz(frames[0].formant[k] * id.formantScale), frames[0].start + frames[0].dur);
      for (let i = 1; i < frames.length; i++) {
        const hz = clampHz(frames[i].formant[k] * id.formantScale);
        bp.frequency.linearRampToValueAtTime(hz, frames[i].start);        // glide across the gap
        bp.frequency.linearRampToValueAtTime(hz, frames[i].start + frames[i].dur);  // hold through it
      }
      env.connect(bp);
    }

    // Glottal carrier: saw for the harmonic ladder, square for the mechanical edge.
    const contour = line.contour || [1, 1];
    const f0 = id.f0 * (0.99 + jitter() * 0.02);
    for (const [type, level, detune] of [['sawtooth', 1 - id.buzz * 0.5, 0], ['square', id.buzz * 0.5, 7]]) {
      const mix = ctx.createGain();
      mix.gain.setValueAtTime(Math.max(level, FLOOR), t0);
      mix.connect(env);
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.detune.setValueAtTime(detune, t0);
      osc.frequency.setValueAtTime(f0 * contour[0], t0);
      osc.frequency.linearRampToValueAtTime(f0 * contour[1], end);
      osc.connect(mix);
      osc.start(t0);
      osc.stop(end);
    }

    if (radio) radioTopAndTail(ctx, master, t0, end);

    return duration;
  };
}

// `identity` comes from voiceIdentity(); `radio` adds the squad-net treatment (bandwidth, drive,
// squelch clicks, hiss tail). `variantIndex` selects among lineVariants(lineId), clamped to the
// base (0) when out of range rather than throwing -- a stale/phantom index must degrade quietly,
// same rule the baked-audio path already follows on a missing file. Returns a builder honouring
// the one-shot synth contract.
export function buildVoiceLine(lineId, identity = null, { radio = true, gain = 1, variantIndex = 0 } = {}) {
  const variants = lineVariants(lineId);
  return buildFromLine(variants[variantIndex] || variants[0], identity, { radio, gain });
}

// Preview raw text through the synth voice before it is saved as a registered variant anywhere --
// the line-authoring tool's whole point is letting an author hear a change before baking it, and a
// not-yet-saved variant has no lineId/variantIndex to resolve through buildVoiceLine. `contour` and
// `drive` fall back to values borrowed from a generic tactical bark rather than requiring the
// caller to always supply them.
export function buildAdHocVoiceLine(text, identity = null, { radio = true, gain = 1, contour = [1, 0.95], drive = 4 } = {}) {
  if (!text) return null;
  return buildFromLine({ text, contour, drive, syllables: seedSyllables(text) }, identity, { radio, gain });
}
