// Haywire death: a bot whose control goes with it thrashes, fires wild, then twitches out.
// Pure decision and schedule; the caller applies the ragdoll impulses and resolves the shots.
// Randomness is injected so a test is deterministic.

export const HAYWIRE_DEFAULTS = {
  baseChance: 0.10,          // any death
  headChance: 0.65,          // killed by a head hit -- the wildcard's most likely cause
  limbChance: 0.25,          // killed by a hit that also took a limb
  thrashMs: 1300,
  twitchMs: 2400,
  thrashHz: 9,               // random kicks per second while thrashing
  twitchHz: 2.2,
  thrashImpulse: 5.5,
  twitchImpulse: 0.9,
  fireChance: 0.22,          // per thrash kick; a twitching corpse never fires
  fireCap: 5,                // rounds one haywire death may loose, whatever the rolls say
};

export const HAYWIRE_THRASH = 'thrash';
export const HAYWIRE_TWITCH = 'twitch';
export const HAYWIRE_DONE = 'done';

// Odds this death goes haywire. Where the bot was shot is what moves it.
export function haywireChance(cause = {}, cfg = HAYWIRE_DEFAULTS) {
  if (cause.headKill) return cfg.headChance;
  if (cause.severed) return cfg.limbChance;
  return cfg.baseChance;
}

export function rollHaywire(cause = {}, rand = Math.random, cfg = HAYWIRE_DEFAULTS) {
  return rand() < haywireChance(cause, cfg);
}

export function createHaywireState(now, cfg = HAYWIRE_DEFAULTS) {
  return { startedAt: now, nextAt: now, phase: HAYWIRE_THRASH, kicks: 0, shots: 0, cfg };
}

export function haywirePhase(state, now, cfg = HAYWIRE_DEFAULTS) {
  if (!state) return HAYWIRE_DONE;
  const t = now - state.startedAt;
  if (t < cfg.thrashMs) return HAYWIRE_THRASH;
  if (t < cfg.thrashMs + cfg.twitchMs) return HAYWIRE_TWITCH;
  return HAYWIRE_DONE;
}

/**
 * Advance to `now`. Returns `{ phase, kick, impulse, fire }` — `kick` is true on the frames a
 * random impulse is due, and `fire` only ever during the thrash and only up to `fireCap`.
 */
export function stepHaywire(state, now, rand = Math.random, cfg = HAYWIRE_DEFAULTS) {
  const out = { phase: HAYWIRE_DONE, kick: false, impulse: 0, fire: false };
  if (!state) return out;
  const phase = haywirePhase(state, now, cfg);
  out.phase = state.phase = phase;
  if (phase === HAYWIRE_DONE || now < state.nextAt) return out;
  const thrashing = phase === HAYWIRE_THRASH;
  state.nextAt = now + 1000 / Math.max(0.1, thrashing ? cfg.thrashHz : cfg.twitchHz);
  state.kicks++;
  out.kick = true;
  out.impulse = thrashing ? cfg.thrashImpulse : cfg.twitchImpulse;
  if (thrashing && state.shots < cfg.fireCap && rand() < cfg.fireChance) {
    state.shots++;
    out.fire = true;
  }
  return out;
}

// A random unit direction for one kick, biased upward so a corpse flops rather than skidding.
export function haywireImpulseDir(rand = Math.random) {
  const a = rand() * Math.PI * 2;
  const up = 0.35 + rand() * 0.65;
  const flat = Math.sqrt(Math.max(0, 1 - up * up));
  return { x: Math.cos(a) * flat, y: up, z: Math.sin(a) * flat };
}
