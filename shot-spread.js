// shot-spread.js — how inaccurate a shot is, in one place.
//
// bot-aim.js builds the cone from a weapon's authored `spreadRad` plus five terms that were
// AIM_DEFAULTS constants: numbers tuned for BOTS, read by the player's trigger only because that
// was the one spread model in the repo. They are the game's feel, so they are tunable in
// base-game.html and saved to shot-spread.json. The FILE is the default; the block below is the
// fallback for a page or relay that has no file.
//
// Both sides must read the same numbers. The relay loads the file at startup, the page fetches it,
// and base-game-fire.js draws from setShotSpread() -- if they disagree the shooter's predicted
// tracer draws a ray the server never fired. Nothing here is replicated per room on purpose: this
// is tuned once and committed, not adjusted per match.

export const SHOT_SPREAD_VERSION = 1;
export const SHOT_SPREAD_PATH = 'shot-spread.json';

// The values in force before this file existed: AIM_DEFAULTS' spread terms, weapon cone unscaled.
export const SHOT_SPREAD_DEFAULTS = Object.freeze({
  spreadScale: 1,                 // multiplies each weapon's authored spreadRad (weapons.js)
  moveSpreadDeg: 2.5,             // added at full sprint
  firstShotSpreadDeg: 2.0,        // added the instant the trigger or aim goes down, decays over settleMs
  settleMs: 800,                  // how long a held aim takes to earn the tight cone
  bloomPerShotDeg: 0.45,          // cone growth per round
  bloomMaxDeg: 4.0,               // widest sustained fire gets
  bloomDecayDegPerSecond: 3.0,    // how fast it tightens once you stop
});

// Generous on purpose: these are for finding the feel, not for fencing it in.
export const SHOT_SPREAD_LIMITS = Object.freeze({
  spreadScale: [0, 8],
  moveSpreadDeg: [0, 10],
  firstShotSpreadDeg: [0, 10],
  settleMs: [0, 3000],
  bloomPerShotDeg: [0, 2],
  bloomMaxDeg: [0, 12],
  bloomDecayDegPerSecond: [0, 12],
});

export const SHOT_SPREAD_KEYS = Object.freeze(Object.keys(SHOT_SPREAD_DEFAULTS));

// Any shape in (a fetched file, a settings object, nothing) -> a complete, finite, clamped set.
export function normalizeShotSpread(raw) {
  const out = { ...SHOT_SPREAD_DEFAULTS };
  const source = raw && typeof raw === 'object' ? (raw.spread && typeof raw.spread === 'object' ? raw.spread : raw) : null;
  if (!source) return out;
  for (const key of SHOT_SPREAD_KEYS) {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) continue;
    const [lo, hi] = SHOT_SPREAD_LIMITS[key];
    out[key] = Math.max(lo, Math.min(hi, value));
  }
  return out;
}

// What the page writes to disk: the numbers plus enough to read the file cold.
export function shotSpreadFile(values) {
  return { version: SHOT_SPREAD_VERSION, savedAt: new Date().toISOString(), spread: normalizeShotSpread(values) };
}
