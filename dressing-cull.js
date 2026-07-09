// dressing-cull.js -- pure CPU classification twin for dressing-gpu.js's cull kernel
// (P4/Milestone 5, docs/superpowers/specs/2026-07-08-terrain-dressing-performance-design.md).
// MUST STAY HAND-SYNCED with the TSL cull kernel in dressing-gpu.js (same convention as
// forest-cull.js/forest-gpu.js) -- this file exists only so the classification math is
// unit-testable in Node without a GPU; it is NOT imported by dressing-gpu.js.
//
// Order of checks mirrors the kernel exactly: radial distance + dithered edge fade (unchanged,
// pre-existing) computed first, then ANDed with the new camera forward/cone check. `keepRand`
// is passed in rather than recomputed here -- the dither hash itself (posRandFn in
// dressing-gpu.js) is untouched by this milestone and stays private to that file; tests supply
// a fixed keepRand to exercise the fade band deterministically.
//
// params: {
//   cullRadius, cullStart,   // world units -- existing radial limit + fade-band start
//   keepRand,                // [0,1) dither draw for the fade band (caller-supplied in tests;
//                             // the GPU kernel derives it from posRandFn(rec.x, rec.z, 7))
//   coneEnabled = true,       // perfAB "Dressing frustum cull" toggle
//   fovCos,                   // cos(cameraHalfFov) -- how wide the camera's real view cone is
//   coneMargin = 0.35,        // cosine padding subtracted from fovCos -- WIDE/generous by
//                             // design (perfAB "Dressing cone margin" slider); instances are
//                             // small and dense so any popping at the padded edge is very
//                             // visible, hence "do not be aggressive" per the design doc.
// }
export function classifyInstance(rec, cam, params) {
  const dx = rec.x - cam.x;
  const dz = rec.z - cam.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  const cullRadius = params.cullRadius;
  const cullStart = params.cullStart;
  const gradRange = Math.max(cullRadius - cullStart, 0.001);
  const edge = clamp01((dist - cullStart) / gradRange);
  const keepRand = params.keepRand;
  const radialLive = dist < cullRadius && keepRand > edge;

  let coneLive = true;
  if (params.coneEnabled) {
    if (dist < 1e-6) {
      // Instance effectively at the camera position -- direction is undefined; never reject.
      coneLive = true;
    } else {
      const nx = dx / dist;
      const nz = dz / dist;
      const fwdDot = nx * cam.fx + nz * cam.fz;
      const coneMargin = params.coneMargin ?? 0.35;
      const coneCos = clamp(params.fovCos - coneMargin, -1, 1);
      coneLive = fwdDot >= coneCos;
    }
  }

  return { dist, edge, radialLive, coneLive, live: radialLive && coneLive };
}

// Threshold-gated recull predicate (orchestrator follow-up on Milestone 5; same disease the
// trees spec -- docs/superpowers/specs/2026-07-08-trees-performance-design.md finding 3 --
// diagnoses for forest-gpu.js): exact float-equality dirty checks recull EVERY frame under
// first-person mouse-look/walking, because forward/position drift by tiny amounts each frame.
// Instead, only recull when the camera has moved or turned enough to matter.
//
// prev/next: { x, z, fx, fz } -- XZ camera position + NORMALIZED XZ forward, prev being the
// state at the last executed recull. thresholds: { moveDist = 1.5 (world units),
// headingCos = cos(2 degrees) }.
//
// COUPLING WARNING: these defaults are coupled to dressing-gpu.js's cone padding
// (uConeMargin default 0.35). The padded cone must comfortably cover the worst-case staleness
// between reculls -- up to 1.5 units of camera travel plus 2 degrees of heading change plus the
// instance's own radius -- so instances never pop inside the visible frustum before the next
// recull fires. Do NOT shrink the cone margin without tightening these thresholds, and vice
// versa. dressing-gpu.js's update() hand-syncs this predicate (same not-imported convention as
// classifyInstance above); data-driven forced reculls (the host's `dirty` flag) bypass it
// entirely and always fire immediately.
export function shouldRecull(prev, next, thresholds = {}) {
  // First frame / no valid previous recull state: always recull.
  if (!Number.isFinite(prev.x) || !Number.isFinite(prev.z)
    || !Number.isFinite(prev.fx) || !Number.isFinite(prev.fz)) return true;
  const moveDist = thresholds.moveDist ?? 1.5;
  const headingCos = thresholds.headingCos ?? Math.cos(2 * Math.PI / 180);
  const dx = next.x - prev.x, dz = next.z - prev.z;
  if (dx * dx + dz * dz > moveDist * moveDist) return true;
  const dot = next.fx * prev.fx + next.fz * prev.fz;
  if (dot < headingCos) return true;
  return false;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function clamp01(v) { return clamp(v, 0, 1); }
