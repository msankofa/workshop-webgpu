// Procedural WebAudio weapon voices -- the fallback used when no sample is loaded for an event id.
// Pure WebAudio: no THREE, no DOM beyond the AudioContext handed to the builder.
// A builder is `build(ctx, destination, t0) => durationSeconds`; it connects only to `destination`
// and schedules everything with AudioParam automation from t0 (never setTimeout).

// Envelope/noise/filter plumbing is shared with the other procedural voice modules.
import { jitter, envGain, noiseSource, filterNode } from './synth-utils.js';

// Ignition crack + low thump + a swept-lowpass whoosh as the rocket leaves the tube.
function buildRocketLaunch(ctx, destination, t0) {
  const DUR = 0.8;
  const a = jitter(); const b = jitter(); const c = jitter(); const d = jitter();

  const igniteDur = 0.28 + a * 0.05;
  const igniteGain = envGain(ctx, destination, 0.85, t0, 0.006, igniteDur);
  const bp = filterNode(ctx, 'bandpass', 290 + a * 70, t0, 1.0 + b * 0.7);
  bp.frequency.exponentialRampToValueAtTime(2700 + b * 700, t0 + 0.17 + a * 0.03);
  bp.connect(igniteGain);
  noiseSource(ctx, t0, igniteDur, a * 1.4).connect(bp);

  const thumpDur = 0.3 + b * 0.04;
  const thumpGain = envGain(ctx, destination, 0.9, t0, 0.01, thumpDur);
  const thump = ctx.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(88 + c * 8, t0);
  thump.frequency.exponentialRampToValueAtTime(43 + c * 5, t0 + thumpDur * 0.85);
  thump.connect(thumpGain);
  thump.start(t0);
  thump.stop(t0 + thumpDur);

  const tailStart = t0 + 0.13 + c * 0.03;
  const tailDur = 0.57 + d * 0.02;
  const tailGain = envGain(ctx, destination, 0.5, tailStart, 0.04, tailDur);
  const lp = filterNode(ctx, 'lowpass', 6200 + d * 900, tailStart, 0.9);
  lp.frequency.exponentialRampToValueAtTime(360 + d * 120, tailStart + tailDur);
  lp.connect(tailGain);
  noiseSource(ctx, tailStart, tailDur, d * 1.4).connect(lp);

  return DUR;
}

// Sine body drop + resonant-lowpass crackle over a long low tail.
function buildExplosion(ctx, destination, t0) {
  const DUR = 1.4;
  const a = jitter(); const b = jitter(); const c = jitter(); const d = jitter();

  const bodyDur = 0.85 + a * 0.05;
  const bodyGain = envGain(ctx, destination, 0.95, t0, 0.008, bodyDur);
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(68 + a * 8, t0);
  body.frequency.exponentialRampToValueAtTime(23 + a * 5, t0 + 0.5 + b * 0.05);
  body.connect(bodyGain);
  body.start(t0);
  body.stop(t0 + bodyDur);

  const crackDur = 0.42 + b * 0.06;
  const crackGain = envGain(ctx, destination, 0.8, t0, 0.004, crackDur);
  const crackLp = filterNode(ctx, 'lowpass', 2300 + b * 700, t0, 6.0 + c * 2.5);
  crackLp.frequency.exponentialRampToValueAtTime(240 + c * 120, t0 + crackDur);
  crackLp.connect(crackGain);
  noiseSource(ctx, t0, crackDur, b * 1.4).connect(crackLp);

  const tailDur = 1.18 + d * 0.05;
  const tailGain = envGain(ctx, destination, 0.42, t0, 0.06, tailDur);
  const tailLp = filterNode(ctx, 'lowpass', 520 + d * 160, t0, 1.2);
  tailLp.frequency.exponentialRampToValueAtTime(105 + d * 40, t0 + tailDur);
  tailLp.connect(tailGain);
  noiseSource(ctx, t0, tailDur, c * 1.4).connect(tailLp);

  return DUR;
}

// Short cloth/handling swish as the grenade leaves the hand.
function buildGrenadeThrow(ctx, destination, t0) {
  const DUR = 0.25;
  const a = jitter(); const b = jitter();

  const swishDur = 0.2 + a * 0.02;
  const gain = envGain(ctx, destination, 0.55, t0, 0.03 + a * 0.01, swishDur);
  const bp = filterNode(ctx, 'bandpass', 560 + a * 180, t0, 1.2 + b * 0.6);
  bp.frequency.exponentialRampToValueAtTime(1700 + b * 500, t0 + swishDur);
  bp.connect(gain);
  noiseSource(ctx, t0, swishDur, b * 1.4).connect(bp);

  return DUR;
}

// Filtered noise pop plus a pitched click for the grenade hitting a surface.
function buildGrenadeBounce(ctx, destination, t0) {
  const DUR = 0.12;
  const a = jitter(); const b = jitter();

  const popDur = 0.075 + a * 0.01;
  const popGain = envGain(ctx, destination, 0.6, t0, 0.002, popDur);
  const lp = filterNode(ctx, 'lowpass', 1700 + a * 600, t0, 3.0 + b * 1.5);
  lp.frequency.exponentialRampToValueAtTime(520 + b * 220, t0 + popDur);
  lp.connect(popGain);
  noiseSource(ctx, t0, popDur, a * 1.4).connect(lp);

  const clickDur = 0.045 + b * 0.01;
  const clickGain = envGain(ctx, destination, 0.4, t0, 0.002, clickDur);
  const click = ctx.createOscillator();
  click.type = 'triangle';
  click.frequency.setValueAtTime(430 + b * 120, t0);
  click.frequency.exponentialRampToValueAtTime(160 + a * 60, t0 + clickDur);
  click.connect(clickGain);
  click.start(t0);
  click.stop(t0 + clickDur);

  return DUR;
}

const VOICES = {
  rocket_launch: buildRocketLaunch,
  explosion: buildExplosion,
  grenade_throw: buildGrenadeThrow,
  grenade_bounce: buildGrenadeBounce,
};

export const SYNTH_EVENT_IDS = Object.keys(VOICES);

// Returns a builder for the id, or null when there is no synth voice for it.
export function synthVoice(eventId) {
  if (!eventId || !Object.prototype.hasOwnProperty.call(VOICES, eventId)) return null;
  return VOICES[eventId];
}
