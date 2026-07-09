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

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function clamp01(v) { return clamp(v, 0, 1); }
