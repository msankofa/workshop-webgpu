// The wound-centre mask: one source of truth for the darkening a blood decal gets at its middle, so
// the two decal materials that implement it in TSL (effect-renderer.js's quad pool and
// projected-decals.js's depth-projected boxes) cannot drift apart, and so the math is testable in
// Node without a GPU — the CPU/GPU-twin convention CLAUDE.md describes for post-grade.js and friends,
// except that here the constants really are imported by both materials rather than hand-synced.
//
// Why the mix is driven by the decal's own geometry and NOT by the stain texture's alpha: the mask
// in makeStainTexture is deliberately irregular — seven fused lobes sit at r 0.10-0.26 from centre
// with radii up to ~0.20, so alpha reaches 1 in patches well away from the middle. Driving colour
// from alpha would paint several dark blotches scattered across the stain instead of one wound at
// the centre, which is the wrong shape for "blood radiating from a puncture".

// Distances are in the decal's own half-width units: the quad spans +/-0.5, so 0.5 is its edge and
// ~0.707 its corner. On a fitted forearm stain (~0.052 m half-width) the fully dark core is roughly
// a 6 mm-radius puncture that fades out by ~30 mm.
export const WOUND_DEFAULTS = {
  inner: 0.06,    // at or inside this, fully the dark core colour
  outer: 0.28,    // at or outside this, the decal's own colour, untouched
  darken: 0.25,   // multiplier applied to instColor at the core; 1 disables the effect entirely
};

/**
 * How much of the core colour applies at `dist` from the decal centre: 1 at the middle, 0 at and
 * beyond `outer`. Matches the TSL `1 - smoothstep(inner, outer, dist)` in both materials exactly,
 * including the degenerate inner >= outer case, where GLSL/WGSL smoothstep is undefined and both
 * materials therefore must not be fed one.
 */
export function woundCoreFactor(dist, inner = WOUND_DEFAULTS.inner, outer = WOUND_DEFAULTS.outer) {
  const d = Number.isFinite(dist) ? dist : 0;
  if (!(outer > inner)) return d <= inner ? 1 : 0;   // hard step, the only sane reading of a zero band
  const t = Math.max(0, Math.min(1, (d - inner) / (outer - inner)));
  return 1 - t * t * (3 - 2 * t);
}
