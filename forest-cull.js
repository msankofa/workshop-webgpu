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
//   shadowReach = 0,           // shadow list radius (2026-08-30): an instance within it is a
//                               // shadow caster whether or not the cone keeps it -- the light
//                               // does not look where the camera looks. 0 = no shadow list.
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

  const shadowReach = params.shadowReach ?? 0;
  const shadowLive = shadowReach > 0 && dist <= shadowReach;

  return { dist, farLive, coneLive, live: farLive && coneLive, shadowLive };
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

// The cosine of the widest XZ angle between the camera's forward and any corner of its view,
// which is what the cone test above compares against. cos(vfov/2) alone is the top and bottom
// edge of a square screen looking level: a wide screen sees further to the sides, and a camera
// pitched down sees the ground over a wider XZ angle still (straight down sees all of it).
// Corner rays in a yaw-free frame are (±a·t, ±t·sin p − cos p) on the ground, t = tan(vfov/2),
// a = aspect, p = pitch; the widest one has −Z = cos p − t·|sin p|. When that is not positive a
// corner points behind the camera and the cone must open to everything: −1.
export function frustumConeCos(fovDeg, aspect = 1, forwardY = 0) {
  if (!Number.isFinite(fovDeg) || fovDeg <= 0) return -1;
  const t = Math.tan((fovDeg * Math.PI / 180) / 2);
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const sinP = Math.max(-1, Math.min(1, forwardY || 0));
  const cosP = Math.sqrt(Math.max(0, 1 - sinP * sinP));
  const ahead = cosP - t * Math.abs(sinP);
  if (ahead <= 1e-6) return -1;
  return ahead / Math.hypot(a * t, ahead);
}

// occludedByHiZ (2026-09-06): CPU twin of hiz-test.js's occluded(). `pyramid` is
// { levels: [{ data, width, height }], viewProj: 16 column-major floats, tanHalfFov, aspect },
// with level 0 holding view distance at HIZ_BASE_DIVISOR-th the frame and each level the 2x2
// max of the one below. `bounds` is { min: [x,y,z], max: [x,y,z] } in world space.
export const HIZ_BIAS_FLOOR = 0.05;
export const HIZ_NEAR_W = 0.05;
export function occludedByHiZ(bounds, pyramid) {
  const m = pyramid.viewProj;
  let loX = Infinity, loY = Infinity, hiX = -Infinity, hiY = -Infinity, nearest = Infinity;
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? bounds.max[0] : bounds.min[0], y = c & 2 ? bounds.max[1] : bounds.min[1], z = c & 4 ? bounds.max[2] : bounds.min[2];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w < HIZ_NEAR_W) return false;   // straddles the near plane: never hidden
    const nx = cx / w, ny = cy / w;
    loX = Math.min(loX, nx); hiX = Math.max(hiX, nx); loY = Math.min(loY, ny); hiY = Math.max(hiY, ny);
    nearest = Math.min(nearest, w);
  }
  if (!(hiX > -1 && loX < 1 && hiY > -1 && loY < 1)) return false;   // off screen: the cone owns it
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const uLo = clamp01(loX * 0.5 + 0.5), uHi = clamp01(hiX * 0.5 + 0.5);
  const vLo = clamp01(0.5 - hiY * 0.5), vHi = clamp01(0.5 - loY * 0.5);
  const l0 = pyramid.levels[0];
  const extent = Math.max((uHi - uLo) * l0.width, (vHi - vLo) * l0.height);
  let level = 0;
  while (level < pyramid.levels.length - 1 && extent > 2 * (1 << level)) level++;
  const lv = pyramid.levels[level];
  const ax = Math.min(lv.width - 1, Math.floor(uLo * lv.width)), bx = Math.min(lv.width - 1, Math.floor(uHi * lv.width));
  const ay = Math.min(lv.height - 1, Math.floor(vLo * lv.height)), by = Math.min(lv.height - 1, Math.floor(vHi * lv.height));
  const farthest = Math.max(lv.data[ay * lv.width + ax], lv.data[ay * lv.width + bx], lv.data[by * lv.width + ax], lv.data[by * lv.width + bx]);
  const texelWorld = (2 * pyramid.tanHalfFov * pyramid.aspect) / l0.width;
  const bias = nearest * texelWorld * (1 << level) + HIZ_BIAS_FLOOR;
  return nearest > farthest + bias;
}
