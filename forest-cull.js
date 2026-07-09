// forest-cull.js — pure cull predicates for forest instances. The TSL compute in
// forest-gpu.js transcribes this exactly (hand-synced twin — this file is NOT imported by
// forest-gpu.js, same not-imported convention as dressing-cull.js/dressing-gpu.js).
//
// cullInstance: v1 camera-centered radial distance cull (mirrors the SP2 grass result that
// per-instance frustum culling was unnecessary at the time):
//   dx*dx + dz*dz <= maxDist*maxDist
//
// classifyInstance / shouldRecull: Milestones 2-4 of
// docs/superpowers/specs/2026-07-08-trees-performance-design.md — frustum/cone rejection, a
// hard far cutoff, and a threshold-gated recull predicate. Same shape as dressing-cull.js's
// classifyInstance/shouldRecull, but trees get a WIDER cone margin than dressing's 0.35
// default (trees are large; canopy clipping at screen edges is very visible) and a
// per-instance angular radius pad (canopy half-width / distance) on top of the flat cosine
// margin, since a fixed cosine margin alone doesn't scale with how much screen-space a huge
// nearby canopy occupies.
export function cullInstance(rec, cam, maxDist) {
  const dx = rec.x - cam.x, dz = rec.z - cam.z;
  return dx * dx + dz * dz <= maxDist * maxDist;
}

// params: {
//   coneEnabled = true,        // perfAB "Forest frustum cull" toggle
//   fovCos,                    // cos(camera horizontal-ish half-FOV)
//   coneMargin = 0.5,          // cosine padding subtracted from fovCos -- WIDE by design
//                               // (perfAB "Forest cone margin" slider); more conservative than
//                               // dressing's 0.35 because tree canopies are large and popping
//                               // at the padded edge is very visible.
//   rearMargin = 0.1,          // small extra cosine tolerance so instances sitting almost
//                               // exactly at the perpendicular (fwdDot ~ 0) aren't treated as
//                               // "behind" by float noise; folded into the same coneCos test
//                               // (fwdDot >= coneCos - rearMargin), matching the single unified
//                               // threshold shape the TSL kernel is cheapest to express.
//   treeRadius = 0,            // per-variant canopy half-width (world units) at scale=1 --
//                               // the instance's own footprint, so the cone check pads itself
//                               // by how much screen space this specific tree occupies.
//   scale = 1,                 // per-instance uniform scale (rec0.w) -- world radius is
//                               // treeRadius*scale.
//   maxDrawRadius = Infinity,  // Milestone 3 hard far cutoff (world units); instances beyond
//                               // this are rejected outright rather than falling through to an
//                               // ever-growing billboard population.
// }
export function classifyInstance(rec, cam, params) {
  const dx = rec.x - cam.x;
  const dz = rec.z - cam.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  const maxDrawRadius = params.maxDrawRadius ?? Infinity;
  const farLive = dist <= maxDrawRadius;

  let coneLive = true;
  if (params.coneEnabled) {
    if (dist < 1e-6) {
      // Instance effectively at the camera position — direction is undefined; never reject.
      coneLive = true;
    } else {
      const nx = dx / dist;
      const nz = dz / dist;
      const fwdDot = nx * cam.fx + nz * cam.fz;
      const coneMargin = params.coneMargin ?? 0.5;
      const rearMargin = params.rearMargin ?? 0.1;
      const treeRadius = (params.treeRadius ?? 0) * (params.scale ?? 1);
      // Angular half-width the tree's own canopy subtends at this distance, converted to a
      // cosine reduction via a small-angle-safe atan2 (exact, not an approximation).
      const angularPad = Math.atan2(treeRadius, Math.max(dist, 1e-6));
      const baseCos = clamp((params.fovCos ?? 1) - coneMargin, -1, 1);
      const coneCos = Math.cos(Math.min(Math.PI, Math.acos(baseCos) + angularPad)) - rearMargin;
      coneLive = fwdDot >= coneCos;
    }
  }

  return { dist, farLive, coneLive, live: farLive && coneLive };
}

// Threshold-gated recull predicate (Milestone 4). Exact float-equality dirty checks recull
// EVERY frame under first-person mouse-look/walking, because forward/position drift by tiny
// amounts each frame. Instead, only recull when the camera has moved or turned enough to
// matter — now that culling is view-dependent (Milestone 2), a stale recull can leave
// instances wrongly culled/kept at the frustum edge, not just at the LOD radius edge.
//
// prev/next: { x, z, fx, fz } — XZ camera position + NORMALIZED XZ forward, prev being the
// state at the last executed recull. thresholds: { moveDist = 1.5 (world units),
// headingCos = cos(2 degrees) }.
//
// COUPLING WARNING: these defaults are coupled to forest-gpu.js's cone padding (uConeMargin
// default 0.5, plus the per-instance angular radius pad above). The padded cone must
// comfortably cover the worst-case staleness between reculls — up to 1.5 units of camera
// travel plus 2 degrees of heading change plus the instance's own radius — so instances never
// pop inside the visible frustum before the next recull fires. Do NOT shrink the cone margin
// without tightening these thresholds, and vice versa. forest-gpu.js's update() hand-syncs
// this predicate (same not-imported convention as classifyInstance above); data-driven forced
// reculls (the host's `dirty` flag, e.g. chunk mutations or LOD/quality changes) bypass it
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
