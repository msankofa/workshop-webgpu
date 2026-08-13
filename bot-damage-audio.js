// Mechanical damage / death voices for bots, plus the controller that decides which one plays.
// Bots are robots: the sampled `enemy_hit` (body-impact.wav) and `pain-grunt.wav` are flesh and
// breath, so every voice here is synthesized struck metal, arcing electronics or a distress siren.
//
// Two builder contracts, both from synth-utils.js:
//   one-shot   `build(ctx, destination, t0) => durationSeconds`      (envAudio.playSynthAt)
//   sustained  `build(ctx, destination, t0) => { stop(atCtxTime) }`  (envAudio.playSynthLoop)
// Pure WebAudio in the builders: no THREE, no DOM. Node-tested in test-bot-damage-audio.mjs.

import {
  jitter, seededUnit, envGain, noiseSource, noiseBed, filterNode, saturator, FLOOR,
} from './synth-utils.js';
import { createAudioBudget, AUDIO_PRIORITY } from './combat-audio-budget.js';
import { SOUND_PARAMS } from './sound-params.js';

const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));

// Stable per-bot variation from a string id (FNV-1a), fed to seededUnit.
export function botAudioSeed(id) {
  const s = String(id ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; }
  return h >>> 0;
}

// Every number the mix depends on now lives in SOUND_PARAMS.damage (see sound-params.js for each
// field's range and rationale). This is the same object, not a copy: overrides are applied in
// place, so a caller spreading `{...BOT_DAMAGE_TUNING}` always spreads the current values.
export const BOT_DAMAGE_TUNING = SOUND_PARAMS.damage;

// Tier selection: pure, so the thresholds are table-testable without an AudioContext.
// `cfg.threshold01` is the game's own heal-retreat fraction (bot-viewer-v2 botHealthSettings),
// not an invented number. There is no hit-location or armour data in this codebase, so damage
// amount and the resulting HP fraction are all a tier can legitimately derive from.
export function botHitTier(amount, hpBefore01, hpAfter01, cause, cfg = {}) {
  const t = { ...BOT_DAMAGE_TUNING, ...cfg };
  const maxHp = Number(cfg.maxHp) > 0 ? Number(cfg.maxHp) : 100;
  const before = clamp01(hpBefore01);
  const after = clamp01(hpAfter01);
  const threshold01 = clamp01(cfg.threshold01 ?? 0.6);
  const raw = Number(amount);
  // Fall back to the HP delta when the caller has no absolute amount (blast falloff, heals).
  const amount01 = Number.isFinite(raw) && raw > 0 ? raw / maxHp : Math.max(0, before - after);
  if (cause === 'blast' || cause === 'explosion') return 'bot_hit_blast';
  if (cause === 'ricochet' || amount01 <= t.ricochetMax01) return 'bot_hit_ricochet';
  if (amount01 >= t.criticalAmount01 || after <= threshold01 * t.criticalHpScale) return 'bot_hit_critical';
  if (after <= threshold01) return 'bot_hit_heavy';
  return 'bot_hit_light';
}

// ---------------------------------------------------------------------------
// One-shot voices
// ---------------------------------------------------------------------------

// Struck-metal partials. Inharmonic ratios are what separate "hit plate" from "bell".
function clangPartials(ctx, dest, t0, base, dur, peak, ratios) {
  for (let i = 0; i < ratios.length; i++) {
    const j = jitter();
    const life = dur * (1 - i * 0.15);
    const g = envGain(ctx, dest, peak * (1 - i * 0.22), t0, 0.003, life);
    const osc = ctx.createOscillator();
    osc.type = i === 0 ? 'triangle' : 'sine';
    const f = base * ratios[i] * (0.98 + j * 0.04);
    osc.frequency.setValueAtTime(f, t0);
    osc.frequency.exponentialRampToValueAtTime(f * 0.93, t0 + life);
    osc.connect(g);
    osc.start(t0);
    osc.stop(t0 + life);
  }
}

// Short metallic tink: a healthy shell taking a round.
function buildHitLight(ctx, destination, t0) {
  const DUR = 0.16;
  const a = jitter(); const b = jitter(); const c = jitter();
  const tickDur = 0.03 + a * 0.008;
  const tickGain = envGain(ctx, destination, 0.45, t0, 0.001, tickDur);
  const hp = filterNode(ctx, 'highpass', 2600 + a * 900, t0, 0.8);
  hp.connect(tickGain);
  noiseSource(ctx, t0, tickDur, a * 1.4).connect(hp);
  clangPartials(ctx, destination, t0, 2280 + b * 420, 0.12 + c * 0.02, 0.34, [1, 1.71]);
  return DUR;
}

// Deep clang plus a struck-metal ring: the same shell, but the round went through something.
function buildHitHeavy(ctx, destination, t0) {
  const DUR = 0.62;
  const a = jitter(); const b = jitter(); const c = jitter();
  const drive = saturator(ctx, 2.6);          // soft clip gives the ring its grit
  drive.connect(destination);
  clangPartials(ctx, drive, t0, 188 + a * 34, 0.5 + b * 0.05, 0.85, [1, 1.67, 2.39]);

  const thumpDur = 0.24 + c * 0.03;
  const thumpGain = envGain(ctx, destination, 0.7, t0, 0.004, thumpDur);
  const thump = ctx.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(126 + c * 16, t0);
  thump.frequency.exponentialRampToValueAtTime(58 + a * 8, t0 + thumpDur);
  thump.connect(thumpGain);
  thump.start(t0);
  thump.stop(t0 + thumpDur);

  const strikeDur = 0.05 + b * 0.012;
  const strikeGain = envGain(ctx, destination, 0.5, t0, 0.001, strikeDur);
  const bp = filterNode(ctx, 'bandpass', 1500 + b * 500, t0, 1.4);
  bp.connect(strikeGain);
  noiseSource(ctx, t0, strikeDur, c * 1.4).connect(bp);
  return DUR;
}

// Heavy clang plus damaged electronics: a descending square gated on and off at audio-rate-ish speed.
function buildHitCritical(ctx, destination, t0) {
  const DUR = 0.8;
  const a = jitter(); const b = jitter(); const c = jitter();
  const drive = saturator(ctx, 3.2);
  drive.connect(destination);
  clangPartials(ctx, drive, t0, 176 + a * 30, 0.48 + b * 0.05, 0.9, [1, 1.63, 2.44]);

  const start = t0 + 0.06;
  const stutterDur = 0.6 + c * 0.04;
  const gate = ctx.createGain();
  gate.gain.setValueAtTime(FLOOR, start);
  const lp = filterNode(ctx, 'lowpass', 2600 + a * 700, start, 3.0);
  lp.frequency.exponentialRampToValueAtTime(700 + b * 260, start + stutterDur);
  gate.connect(lp);
  lp.connect(destination);
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(880 + b * 260, start);
  osc.frequency.exponentialRampToValueAtTime(148 + c * 40, start + stutterDur);
  osc.connect(gate);
  osc.start(start);
  osc.stop(start + stutterDur);

  const step = 0.026 + a * 0.008;
  const salt = 7 + Math.floor(c * 64);
  for (let t = 0, i = 0; t < stutterDur; t += step, i++) {
    const open = i % 2 === 0 && seededUnit(i, salt) > 0.22;
    gate.gain.setValueAtTime(open ? 0.42 * (1 - t / stutterDur) + 0.02 : FLOOR, start + t);
  }
  return DUR;
}

// Bright ping, deliberately no low end: everything runs through a highpass.
function buildHitRicochet(ctx, destination, t0) {
  const DUR = 0.3;
  const a = jitter(); const b = jitter(); const c = jitter();
  const hp = filterNode(ctx, 'highpass', 1200 + a * 300, t0, 0.7);
  hp.connect(destination);

  const tickDur = 0.028 + a * 0.006;
  const tickGain = envGain(ctx, hp, 0.5, t0, 0.001, tickDur);
  const bp = filterNode(ctx, 'bandpass', 3400 + b * 1200, t0, 1.6);
  bp.connect(tickGain);
  noiseSource(ctx, t0, tickDur, b * 1.4).connect(bp);

  for (let i = 0; i < 2; i++) {
    const start = t0 + i * (0.012 + c * 0.006);
    const life = 0.22 - i * 0.06;
    const g = envGain(ctx, hp, i ? 0.24 : 0.4, start, 0.002, life);
    const osc = ctx.createOscillator();
    osc.type = i ? 'sine' : 'triangle';
    const f = (2850 + b * 700) * (i ? 1.48 : 1);
    osc.frequency.setValueAtTime(f, start);
    osc.frequency.exponentialRampToValueAtTime(f * 0.42, start + life);
    osc.connect(g);
    osc.start(start);
    osc.stop(start + life);
  }
  return DUR;
}

// Muffled concussive thud. Deliberately dark so it layers UNDER the `explosion` voice.
function buildHitBlast(ctx, destination, t0) {
  const DUR = 0.52;
  const a = jitter(); const b = jitter(); const c = jitter();
  const bodyDur = 0.3 + a * 0.04;
  const bodyGain = envGain(ctx, destination, 0.9, t0, 0.006, bodyDur);
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(78 + a * 10, t0);
  body.frequency.exponentialRampToValueAtTime(34 + b * 6, t0 + bodyDur);
  body.connect(bodyGain);
  body.start(t0);
  body.stop(t0 + bodyDur);

  const rumbleDur = 0.44 + c * 0.04;
  const rumbleGain = envGain(ctx, destination, 0.55, t0, 0.02, rumbleDur);
  const lp = filterNode(ctx, 'lowpass', 300 + b * 90, t0, 1.1);
  lp.frequency.exponentialRampToValueAtTime(88 + c * 30, t0 + rumbleDur);
  lp.connect(rumbleGain);
  noiseSource(ctx, t0, rumbleDur, c * 1.4).connect(lp);
  return DUR;
}

// Intermittent damage tell: a couple of arc grains plus a dying-circuit blip.
function buildDamageSpark(ctx, destination, t0) {
  const DUR = 0.24;
  const a = jitter(); const b = jitter(); const c = jitter();
  const hp = filterNode(ctx, 'highpass', 1800 + a * 600, t0, 0.7);
  hp.connect(destination);

  const grains = b > 0.55 ? 3 : 2;
  for (let i = 0; i < grains; i++) {
    const start = t0 + i * (0.035 + c * 0.02);
    const life = 0.018 + a * 0.01;
    const g = envGain(ctx, hp, 0.5 - i * 0.12, start, 0.001, life);
    const bp = filterNode(ctx, 'bandpass', 2600 + i * 900 + b * 700, start, 2.2);
    bp.connect(g);
    noiseSource(ctx, start, life, ((a + i * 0.31) % 1) * 1.4).connect(bp);
  }

  const blipStart = t0 + 0.01 + b * 0.02;
  const blipDur = 0.05 + c * 0.012;
  const blipGain = envGain(ctx, hp, 0.28, blipStart, 0.002, blipDur);
  const blip = ctx.createOscillator();
  blip.type = 'square';
  blip.frequency.setValueAtTime(1150 + c * 380, blipStart);
  blip.frequency.exponentialRampToValueAtTime(380 + a * 120, blipStart + blipDur);
  blip.connect(blipGain);
  blip.start(blipStart);
  blip.stop(blipStart + blipDur);
  return DUR;
}

// The killing blow: a hard clank, a downward swoop and a noise thump.
function buildDeathSting(ctx, destination, t0) {
  const DUR = 0.72;
  const a = jitter(); const b = jitter(); const c = jitter();
  const drive = saturator(ctx, 3.6);
  drive.connect(destination);
  clangPartials(ctx, drive, t0, 210 + a * 40, 0.34 + b * 0.04, 0.95, [1, 1.59, 2.31]);

  const swoopDur = 0.5 + c * 0.05;
  const lp = filterNode(ctx, 'lowpass', 3200 + a * 800, t0, 2.2);
  lp.frequency.exponentialRampToValueAtTime(320 + b * 120, t0 + swoopDur);
  const swoopGain = envGain(ctx, destination, 0.6, t0, 0.008, swoopDur);
  lp.connect(swoopGain);
  const swoop = ctx.createOscillator();
  swoop.type = 'sawtooth';
  swoop.frequency.setValueAtTime(430 + b * 90, t0);
  swoop.frequency.exponentialRampToValueAtTime(92 + c * 18, t0 + swoopDur);
  swoop.connect(lp);
  swoop.start(t0);
  swoop.stop(t0 + swoopDur);

  const thumpDur = 0.34 + a * 0.04;
  const thumpGain = envGain(ctx, destination, 0.55, t0, 0.01, thumpDur);
  const thumpLp = filterNode(ctx, 'lowpass', 520 + c * 160, t0, 1.2);
  thumpLp.frequency.exponentialRampToValueAtTime(110 + a * 40, t0 + thumpDur);
  thumpLp.connect(thumpGain);
  noiseSource(ctx, t0, thumpDur, b * 1.4).connect(thumpLp);
  return DUR;
}

// Bled out: the siren collapses to one low tone that drops an octave into a dull thump.
function buildDeathPowerdown(ctx, destination, t0) {
  const DUR = 1.35;
  const a = jitter(); const b = jitter(); const c = jitter();
  const toneDur = 0.72 + a * 0.06;
  const lp = filterNode(ctx, 'lowpass', 1400 + a * 400, t0, 1.4);
  lp.frequency.exponentialRampToValueAtTime(220 + b * 70, t0 + toneDur);
  const toneGain = envGain(ctx, destination, 0.75, t0, 0.02, toneDur);
  lp.connect(toneGain);
  const tone = ctx.createOscillator();
  tone.type = 'sawtooth';
  const f0 = 172 + a * 20;
  tone.frequency.setValueAtTime(f0, t0);
  tone.frequency.exponentialRampToValueAtTime(f0 * 0.5, t0 + toneDur * 0.8);   // the octave drop
  tone.frequency.exponentialRampToValueAtTime(f0 * 0.34, t0 + toneDur);
  tone.connect(lp);
  tone.start(t0);
  tone.stop(t0 + toneDur);

  const thumpStart = t0 + toneDur * 0.86;
  const thumpDur = 0.4 + c * 0.05;
  const thumpGain = envGain(ctx, destination, 0.6, thumpStart, 0.012, thumpDur);
  const thumpLp = filterNode(ctx, 'lowpass', 420 + c * 120, thumpStart, 1.1);
  thumpLp.frequency.exponentialRampToValueAtTime(78 + b * 24, thumpStart + thumpDur);
  thumpLp.connect(thumpGain);
  noiseSource(ctx, thumpStart, thumpDur, b * 1.4).connect(thumpLp);
  return DUR;
}

// Revived: a rising three-note chime over a rising filtered swell.
function buildRevived(ctx, destination, t0) {
  const DUR = 0.9;
  const a = jitter(); const b = jitter(); const c = jitter();
  const notes = [392, 523, 784];
  for (let i = 0; i < notes.length; i++) {
    const start = t0 + i * (0.075 + a * 0.02);
    const life = 0.34 + i * 0.06;
    const g = envGain(ctx, destination, 0.42 - i * 0.05, start, 0.008, life);
    const osc = ctx.createOscillator();
    osc.type = i === 2 ? 'sine' : 'triangle';
    const f = notes[i] * (0.995 + b * 0.01);
    osc.frequency.setValueAtTime(f, start);
    osc.frequency.exponentialRampToValueAtTime(f * 1.02, start + life);
    osc.connect(g);
    osc.start(start);
    osc.stop(start + life);
  }
  const swellDur = 0.5 + c * 0.05;
  const swellGain = envGain(ctx, destination, 0.3, t0, 0.12, swellDur);
  const bp = filterNode(ctx, 'bandpass', 420 + c * 120, t0, 1.6);
  bp.frequency.exponentialRampToValueAtTime(3600 + b * 800, t0 + swellDur);
  bp.connect(swellGain);
  noiseSource(ctx, t0, swellDur, b * 1.4).connect(bp);
  return DUR;
}

const ONE_SHOTS = {
  bot_hit_light: buildHitLight,
  bot_hit_heavy: buildHitHeavy,
  bot_hit_critical: buildHitCritical,
  bot_hit_ricochet: buildHitRicochet,
  bot_hit_blast: buildHitBlast,
  bot_damage_spark: buildDamageSpark,
  bot_death_sting: buildDeathSting,
  bot_death_powerdown: buildDeathPowerdown,
  bot_revived: buildRevived,
};

export const BOT_DAMAGE_EVENT_IDS = Object.keys(ONE_SHOTS);
export const BOT_HIT_TIER_IDS = [
  'bot_hit_light', 'bot_hit_heavy', 'bot_hit_critical', 'bot_hit_ricochet', 'bot_hit_blast',
];

// Returns a one-shot builder for the id, or null. Mirrors synthVoice() so a viewer's
// playAtCulled can chain the two lookups.
export function botDamageVoice(eventId) {
  if (!eventId || !Object.prototype.hasOwnProperty.call(ONE_SHOTS, eventId)) return null;
  return ONE_SHOTS[eventId];
}

// ---------------------------------------------------------------------------
// Sustained voices
// ---------------------------------------------------------------------------

// A downed bot is a machine reporting a fault, not an animal in pain. Deliberately NOT a wail:
// no continuous tone, no portamento, no detune beating -- a swept, detuned sawtooth pair gliding
// downward is literally how you build an air-raid siren, and the first version read as horror
// rather than hardware. This is a distress BEACON: square-wave beeps with real silence between
// them, pitch stepping in discrete jumps, the pattern slowing and thinning as the power fails.
//
// The whole pattern is scheduled up front -- the revive window is a known maximum life, and
// AudioParam automation beats a per-frame timer. Tunables live in SOUND_PARAMS.siren.
export function botDeathSirenVoice({ seed = 0, windowS = 12, baseHz = null } = {}) {
  return (ctx, destination, t0) => {
    const p = SOUND_PARAMS.siren;
    const tail = SOUND_PARAMS.damageLoop.sustainTailS;
    const s = seededUnit(seed, 11);
    const span = Math.max(1, Number(windowS) || 12);

    const out = ctx.createGain();
    out.gain.setValueAtTime(FLOOR, t0);
    out.gain.exponentialRampToValueAtTime(Math.max(p.outPeak, FLOOR * 2), t0 + 0.02);
    out.connect(destination);

    // A little low-pass keeps the square from being shrill without softening its edge.
    const tone = filterNode(ctx, 'lowpass', p.lowpassHz, t0, 0.7);
    tone.connect(out);

    // Per-beep gate. Fast but not instant: ~3 ms reads as a clean digital edge, 0 ms clicks.
    const gate = ctx.createGain();
    gate.gain.setValueAtTime(FLOOR, t0);
    gate.connect(tone);

    const osc = ctx.createOscillator();
    osc.type = 'square';
    const base = Number(baseHz) > 0 ? Number(baseHz) : p.baseHz;
    const hiHz = base * (1 - p.seedSpread * 0.5 + s * p.seedSpread);
    osc.frequency.setValueAtTime(hiHz, t0);
    osc.connect(gate);
    osc.start(t0);

    // Two-beep chirp, rest, repeat. Both the pitch and the cadence degrade in steps, so the beacon
    // audibly runs down instead of sliding down.
    const BEEP = p.beepS, GAP = p.gapS;
    const edge = Math.min(p.edgeS, BEEP * 0.4);   // a gate edge longer than half the beep has no beep left
    let t = 0;
    let last = t0;
    while (t < span) {
      const decay = t / span;                             // 0 at death, 1 at the window's end
      const step = Math.floor(decay * p.steps);           // discrete power-down stages
      const hz = hiHz * Math.pow(p.stepRatio, step);      // each stage drops a fixed interval
      const level = p.onLevel * (1 - decay * p.levelDecay);   // and gets quieter
      for (let b = 0; b < 2; b++) {
        const at = t0 + t;
        if (t >= span) break;
        osc.frequency.setValueAtTime(b === 0 ? hz : hz * p.pairRatio, at);   // high-low pair
        gate.gain.setValueAtTime(FLOOR, at);
        gate.gain.linearRampToValueAtTime(Math.max(level, FLOOR * 2), at + edge);
        gate.gain.setValueAtTime(Math.max(level, FLOOR * 2), at + BEEP - edge);
        gate.gain.linearRampToValueAtTime(FLOOR, at + BEEP);
        last = at + BEEP;
        t += BEEP + GAP;
      }
      t += p.restBaseS + decay * p.restGrowthS;           // the rest between chirps stretches as it fails
    }

    let stopped = false;
    return {
      stop(atCtxTime) {
        if (stopped) return;
        stopped = true;
        const at = Math.max(Number(atCtxTime) || 0, t0);
        const end = at + tail;
        gate.gain.cancelScheduledValues(at);
        gate.gain.setValueAtTime(Math.min(gate.gain.value, p.onLevel), at);
        gate.gain.linearRampToValueAtTime(FLOOR, end);
        out.gain.cancelScheduledValues(at);
        out.gain.setValueAtTime(Math.max(p.outPeak, FLOOR * 2), at);
        out.gain.linearRampToValueAtTime(FLOOR, end);
        osc.stop(Math.max(end, last));
      },
    };
  };
}

// Sustained damage bed for the few closest badly-hurt bots: an arcing short over a failing servo.
// `maxSeconds` only bounds the scheduled flicker; past it the bed simply holds its last level.
export function botDamageLoopVoice({ seed = 0, severity01 = 0.5, maxSeconds = 14 } = {}) {
  return (ctx, destination, t0) => {
    const p = SOUND_PARAMS.damageLoop;
    const s = seededUnit(seed, 5);
    const sev = clamp01(severity01);
    const span = Math.max(1, Number(maxSeconds) || 14);
    const peak = Math.max(p.outBase + sev * p.outSev, FLOOR * 2);

    const out = ctx.createGain();
    out.gain.setValueAtTime(FLOOR, t0);
    out.gain.exponentialRampToValueAtTime(peak, t0 + 0.25);
    out.connect(destination);

    const flicker = ctx.createGain();
    flicker.gain.setValueAtTime(FLOOR, t0);
    flicker.connect(out);
    const bp = filterNode(ctx, 'bandpass', p.bandHz + s * p.bandSpan, t0, p.bandQ);
    bp.connect(flicker);
    const bed = noiseBed(ctx, t0, s * 1.6);
    bed.connect(bp);

    const buzzGain = ctx.createGain();
    buzzGain.gain.setValueAtTime(p.buzzLevel + sev * p.buzzSevLevel, t0);
    buzzGain.connect(out);
    const lp = filterNode(ctx, 'lowpass', p.buzzLowpassHz + s * 120, t0, 1.2);
    lp.connect(buzzGain);
    const buzz = ctx.createOscillator();
    buzz.type = 'sawtooth';
    buzz.frequency.setValueAtTime(p.buzzHz + s * p.buzzSpan, t0);
    buzz.connect(lp);
    buzz.start(t0);

    const step = p.flickerStepS + s * p.flickerStepSpan;
    for (let t = 0, i = 0; t < span; t += step, i++) {
      const u = seededUnit(seed, 101 + i);
      const open = u > p.flickerOpenBase - sev * p.flickerOpenSev;
      flicker.gain.setValueAtTime(open ? 0.25 + u * 0.4 : FLOOR, t0 + t);
    }

    let stopped = false;
    return {
      stop(atCtxTime) {
        if (stopped) return;
        stopped = true;
        const at = Math.max(Number(atCtxTime) || 0, t0);
        const end = at + p.sustainTailS;
        out.gain.cancelScheduledValues(at);
        out.gain.setValueAtTime(peak, at);
        out.gain.linearRampToValueAtTime(FLOOR, end);
        bed.stop(end);
        buzz.stop(end);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const STING_SECONDS = 0.72;

// Viewer-agnostic: every world query is an injected accessor keyed by bot id, so the same
// controller serves bot-viewer-v2 (actor registry) and environment-viewer-v2 (botPlayers recs).
export function createBotDamageAudio(options = {}) {
  const cfg = { ...BOT_DAMAGE_TUNING, ...(options.tuning || {}) };
  const nowMs = options.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const enabled = options.enabled || (() => true);
  const playOneShot = options.playOneShot || (() => {});
  const playPriorityOneShot = options.playPriorityOneShot || playOneShot;
  const playLoop = options.playLoop || (() => false);
  const getPosition = options.getPosition || (() => null);
  const getHp01 = options.getHp01 || (() => null);
  const isAlive = options.isAlive || (() => false);
  const exists = options.exists || (() => false);
  const getListenerPosition = options.getListenerPosition || (() => null);
  const getThreshold01 = options.getThreshold01 || (() => 0.6);
  // The beacon is the one sustained beeping in the mix, and with several bodies down it is all you
  // hear. Gated separately from `enabled` so the rest of the damage track survives turning it off.
  const sirenEnabled = options.sirenEnabled || (() => true);
  const getReviveWindowMs = options.getReviveWindowMs || (() => options.reviveWindowMs ?? 12000);
  const maxHp = Number(options.maxHp) > 0 ? Number(options.maxHp) : 100;
  const budget = options.budget || createAudioBudget();
  const defer = options.setTimer || ((fn, ms) => (typeof setTimeout === 'function' ? setTimeout(fn, ms) : null));

  const wounded = new Map();   // id -> { hp01, nextSparkAt, loop, token }
  const sirens = new Map();    // id -> { diedAt, handle, token }
  let lastScanAt = -Infinity;

  function distanceTo(pos) {
    const l = getListenerPosition();
    if (!l || !pos) return Infinity;
    const dx = pos.x - l.x, dy = pos.y - l.y, dz = pos.z - l.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Sirens sum badly: five deaths must not be five times as loud as one.
  function duckSirens() {
    const n = sirens.size;
    if (!n) return;
    const v = cfg.sirenBaseVolume / Math.sqrt(n);
    for (const rec of sirens.values()) rec.handle?.setTargetVolume?.(v, 0.25);
  }

  function endSiren(id, fadeS) {
    const rec = sirens.get(id);
    if (!rec) return null;
    sirens.delete(id);
    budget.release(rec.token);
    rec.handle?.stop?.(fadeS);
    duckSirens();
    return rec;
  }

  function stopLoop(id, fadeS = 0.12) {
    const rec = wounded.get(id);
    if (!rec?.loop) return;
    budget.release(rec.token);
    rec.loop.stop?.(fadeS);
    rec.loop = null;
    rec.token = null;
  }

  function sparkIntervalFor(id, hp01) {
    const threshold01 = clamp01(getThreshold01());
    const hurt = threshold01 > 0 ? clamp01(1 - hp01 / threshold01) : 1;   // 0 at the threshold, 1 at 0 HP
    const base = cfg.sparkSlowMs + (cfg.sparkFastMs - cfg.sparkSlowMs) * hurt;
    const wobble = (seededUnit(botAudioSeed(id), 3) * 2 - 1) * cfg.sparkJitter;
    return Math.max(200, base * (1 + wobble));
  }

  function trackWounded(id, hp01, now) {
    let rec = wounded.get(id);
    if (!rec) {
      rec = { hp01, nextSparkAt: now + sparkIntervalFor(id, hp01) * 0.5, loop: null, token: null };
      wounded.set(id, rec);
    }
    rec.hp01 = hp01;
    return rec;
  }

  function dropWounded(id) {
    stopLoop(id);
    wounded.delete(id);
  }

  function onDamaged(evt) {
    if (!evt || !enabled()) return;
    const id = evt.id;
    const tier = botHitTier(evt.amount, evt.hpBefore01, evt.hpAfter01, evt.cause, {
      ...cfg, maxHp, threshold01: getThreshold01(),
    });
    // A fatal hit hands the moment to bot_death_sting; stacking a clang on top is mix mud.
    if (!evt.fatal) playOneShot(tier, evt.position || getPosition(id));
    if (evt.fatal) return;
    const hp01 = clamp01(evt.hpAfter01);
    if (hp01 >= 1) dropWounded(id);
    else trackWounded(id, hp01, nowMs());
  }

  function onDied(evt) {
    if (!evt || !enabled()) return;
    const id = evt.id;
    dropWounded(id);
    const pos = evt.position || getPosition(id);

    // The sting is gated on CONCURRENT death voices, never on the 100ms rate window -- a kill is
    // rare and high-value, and rate-limiting it like a common impact drops the one thing the
    // player most needs to hear.
    const sting = budget.reserveOrPreempt('damage', AUDIO_PRIORITY.death, { kind: 'sting' });
    if (sting) {
      // At the category cap the eviction can land on a sustained bed; it must actually stop.
      if (sting.evictedMeta?.kind === 'loop') stopLoop(sting.evictedMeta.id, 0.1);
      else if (sting.evictedMeta?.kind === 'siren') endSiren(sting.evictedMeta.id, 0.1);
      playPriorityOneShot('bot_death_sting', pos);
      defer(() => budget.release(sting.token), STING_SECONDS * 1000);
    }

    if (!sirenEnabled() || evt.revivable === false || sirens.size >= cfg.maxSirens) return;
    const meta = { kind: 'siren', id };
    const grant = budget.reserveOrPreempt('damage', AUDIO_PRIORITY.death, meta, { sustained: true });
    if (!grant) return;
    // A displaced ambient damage bed has to actually stop, not just lose its token.
    if (grant.evictedMeta?.kind === 'loop') stopLoop(grant.evictedMeta.id, 0.1);
    else if (grant.evictedMeta?.kind === 'siren') endSiren(grant.evictedMeta.id, 0.1);

    const diedAt = Number.isFinite(evt.diedAt) ? evt.diedAt : nowMs();
    const windowS = getReviveWindowMs() / 1000;
    const handle = playLoop(
      botDeathSirenVoice({ seed: botAudioSeed(id), windowS }),
      pos,
      {
        volume: cfg.sirenBaseVolume,
        isAlive: () => sirens.has(id) && exists(id),
        getPosition: () => getPosition(id),
      },
    );
    if (!handle) { budget.release(grant.token); return; }
    sirens.set(id, { diedAt, handle, token: grant.token });
    duckSirens();
  }

  // Medic revive: fast fade plus a rising power-up chime. A plain respawn is NOT this -- update()
  // hard-cuts that instead, because a respawn is a teardown rather than a narrative beat.
  function onRevived(evt) {
    const id = evt?.id ?? evt;
    const rec = endSiren(id, 0.18);
    if (rec && enabled()) playPriorityOneShot('bot_revived', getPosition(id));
    dropWounded(id);
  }

  function sweepSirens(now) {
    const windowMs = getReviveWindowMs();
    for (const [id, rec] of [...sirens]) {
      // The audio layer's own sweep can stop a handle (distance cull); reclaim the slot + token.
      if (rec.handle?.stopped) { endSiren(id, 0); continue; }
      if (!sirenEnabled()) { endSiren(id, 0.2); continue; }   // toggled off mid-match: fade, don't wait out the window
      if (!exists(id) || isAlive(id)) { endSiren(id, 0); continue; }   // culled / respawned: hard cut
      if (now - rec.diedAt >= windowMs) {
        endSiren(id, 0.35);
        if (enabled()) playPriorityOneShot('bot_death_powerdown', getPosition(id));
      }
    }
  }

  function sweepWounded(now) {
    const threshold01 = clamp01(getThreshold01());
    const loopBand = threshold01 * cfg.loopHpScale;
    const candidates = [];
    for (const [id, rec] of [...wounded]) {
      if (!exists(id) || !isAlive(id)) { dropWounded(id); continue; }
      const hp01 = getHp01(id);
      if (hp01 == null || hp01 >= 1) { dropWounded(id); continue; }
      rec.hp01 = clamp01(hp01);
      const pos = getPosition(id);
      if (now >= rec.nextSparkAt) {
        rec.nextSparkAt = now + sparkIntervalFor(id, rec.hp01);
        if (enabled()) playOneShot('bot_damage_spark', pos);
      }
      if (rec.hp01 <= loopBand) candidates.push({ id, rec, d: distanceTo(pos), pos });
    }
    // Sustained beds go to the closest few only: 15-30 wounded bots at 90 is guaranteed mix-mud.
    candidates.sort((a, b) => a.d - b.d);
    const keep = new Set(candidates.slice(0, cfg.maxDamageLoops).map(c => c.id));
    for (const [id, rec] of wounded) if (rec.loop && !keep.has(id)) stopLoop(id);
    if (!enabled()) return;
    for (const c of candidates.slice(0, cfg.maxDamageLoops)) {
      // A bed the audio sweep already stopped (distance cull) must not block this slot forever.
      if (c.rec.loop?.stopped) stopLoop(c.id, 0);
      if (c.rec.loop || !c.pos) continue;
      const meta = { kind: 'loop', id: c.id };
      const grant = budget.reserveOrPreempt('damage', AUDIO_PRIORITY.damageLoop, meta, { sustained: true });
      if (!grant) continue;
      if (grant.evictedMeta?.kind === 'loop') stopLoop(grant.evictedMeta.id, 0.1);
      const severity01 = loopBand > 0 ? clamp01(1 - c.rec.hp01 / loopBand) : 1;
      const handle = playLoop(
        botDamageLoopVoice({ seed: botAudioSeed(c.id), severity01 }),
        c.pos,
        {
          volume: cfg.loopBaseVolume,
          isAlive: () => wounded.get(c.id)?.loop != null && isAlive(c.id),
          getPosition: () => getPosition(c.id),
        },
      );
      if (!handle) { budget.release(grant.token); continue; }
      c.rec.loop = handle;
      c.rec.token = grant.token;
    }
  }

  function update(now = nowMs()) {
    if (now - lastScanAt < cfg.scanIntervalMs) return;
    lastScanAt = now;
    sweepSirens(now);
    sweepWounded(now);
  }

  // Scene reset / teardown: hard cut everything, no flourish.
  function stopAll() {
    for (const id of [...sirens.keys()]) endSiren(id, 0);
    for (const id of [...wounded.keys()]) dropWounded(id);
  }

  return {
    onDamaged, onDied, onRevived, update, stopAll,
    dispose: stopAll,
    stats: () => ({ wounded: wounded.size, sirens: sirens.size, loops: [...wounded.values()].filter(r => r.loop).length }),
  };
}
