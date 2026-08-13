// Temporal quality budget for explosions — a port of html-game-v2's `reserveExplosionVisualTier`
// (`src/game/main.js`, around line 15691), constants and all.
//
// WHAT PROBLEM IT SOLVES. When several blasts land inside a few frames, something has to give. The
// two codebases answer that differently and one answer is clearly better:
//
//   - `effect-renderer.js` (this repo) lets its shared pools overflow. GLOW_POOL is 220, SMOKE_POOL
//     260, and both are immediate-mode with silent drops. A volley therefore removes RANDOM
//     sub-particles from EVERY live blast at once — every explosion on screen gets subtly worse and
//     none of them looks deliberate.
//   - html-game-v2 reserves a tier per blast up front. The first two in a 320 ms window render in
//     full, the next three at medium, the rest lite. Later blasts degrade WHOLE and coherently
//     while the first ones stay pristine, which is the one the eye forgives.
//
// This module is the second one, extracted so it can be unit-tested and so the demo that argues for
// it and the game that eventually adopts it cannot drift apart. It is pure: no THREE, no DOM, and
// the clock is injected so a test does not have to sleep.
//
// Not yet wired into anything. `demos/volumetric-smoke.html` is its first caller, where the tiers
// drive raymarch step counts (full march / half march with no light pass / billboard fallback) —
// step count being the only quality dial a raymarch really has.

/** html-game-v2's window length. Roughly a fifth of a second: long enough to catch a volley, short
 * enough that sustained fire recovers to full quality between bursts. */
export const DEFAULT_WINDOW_MS = 320;

/** Per-priority admission counts, verbatim from the original. A `primary` blast is the one the
 * player caused or is looking at; `secondary` is incidental (a death explosion in a crowd), and it
 * is admitted one slot earlier into each degraded tier. */
export const DEFAULT_LIMITS = {
  primary: { full: 2, medium: 5 },
  secondary: { full: 1, medium: 4 },
};

export const TIERS = ['full', 'medium', 'lite'];

/**
 * @param {object} [opts]
 * @param {number} [opts.windowMs]  budget window length in ms
 * @param {() => number} [opts.now] clock, injected for tests; defaults to performance.now
 * @param {object} [opts.limits]    {primary:{full,medium}, secondary:{full,medium}}
 */
export function createExplosionBudget(opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_WINDOW_MS;
  const now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const limits = {
    primary: { ...DEFAULT_LIMITS.primary, ...(opts.limits?.primary) },
    secondary: { ...DEFAULT_LIMITS.secondary, ...(opts.limits?.secondary) },
  };

  let windowStartedAt = 0;
  let count = 0;

  return {
    limits,

    /** Claim a slot for one blast and get the quality it is allowed. Call exactly once per blast,
     * at spawn — the tier has to be fixed for the blast's whole life or it will visibly change
     * quality mid-flight. */
    reserve(priority = 'primary') {
      const t = now();
      // A window that has aged out restarts rather than sliding, which is what makes sustained fire
      // recover: two blasts a second apart are both 'full', ten in one frame are not.
      if (!windowStartedAt || t - windowStartedAt > windowMs) {
        windowStartedAt = t;
        count = 0;
      }
      count++;
      const lim = limits[priority] || limits.primary;
      if (count <= lim.full) return 'full';
      if (count <= lim.medium) return 'medium';
      return 'lite';
    },

    /** Drop the window. The original calls this on level load, so a blast from the previous scene
     * cannot make the first blast of the next one arrive already degraded. */
    reset() { windowStartedAt = 0; count = 0; },

    /** Blasts admitted in the current window, for a HUD or a test. */
    get used() { return count; },
  };
}

/**
 * Scale a particle count by tier. Ported unchanged, including the default scales — a medium blast
 * keeps 55% of its pieces and a lite one 25%.
 *
 * Rounds rather than floors, so a small count does not vanish entirely at medium: 3 pieces stay 2.
 */
export function scaledEffectCount(count, tier, mediumScale = 0.55, liteScale = 0.25) {
  const scale = tier === 'full' ? 1 : tier === 'medium' ? mediumScale : liteScale;
  return Math.max(0, Math.round(count * scale));
}
