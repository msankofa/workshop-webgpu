// bot-flora-place.js — pure placement math for the bot viewer's flora (bot-flora.js).
// No three.js, so test-bot-flora.mjs can exercise all of it in Node. Same split as
// bot-viewer-visuals-style.js / bot-viewer-visuals.js: data and geometry decisions here,
// meshes and materials there.
//
// Two jobs: decide where growth is NOT allowed (inside a wall, inside cover, on a spawn pad),
// and decide where vine strands hang from (the top edges of wall boxes).

// mulberry32 — the seeded generator every other placement pass in this repo uses, so a seed
// reproduces a field exactly.
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── where growth is not allowed ────────────────────────────────────────────

// Wall/cover boxes ({x,z,w,d}) widened by `clearance` metres into keep-out rectangles. The
// clearance is not cosmetic: a blade planted flush against a wall pokes through it from the far
// side, because a blade is a flat card with no thickness and the wall face has no depth bias.
export function blockerRects(boxes, clearance = 0) {
  const out = [];
  for (const b of boxes || []) {
    if (!b || !(b.w > 0) || !(b.d > 0)) continue;
    const hw = b.w / 2 + clearance, hd = b.d / 2 + clearance;
    out.push({ minX: b.x - hw, maxX: b.x + hw, minZ: b.z - hd, maxZ: b.z + hd });
  }
  return out;
}

// Circular keep-outs (spawn pads, goal markers) in the same list, as rects — a rect test against
// a pad is generous by at most the corner, and one uniform test beats two.
export function padRects(pads, extra = 0) {
  const out = [];
  for (const p of pads || []) {
    const r = (p.radius || 0) + extra;
    if (!(r > 0)) continue;
    out.push({ minX: p.x - r, maxX: p.x + r, minZ: p.z - r, maxZ: p.z + r });
  }
  return out;
}

// A uniform grid over the arena bucketing rects by the cells they overlap. A maze layout is ~950
// wall boxes and a grass field is tens of thousands of placement attempts; the linear scan that
// product implies is tens of millions of rect tests per rebuild, which is a visible hitch.
export function buildBlockerIndex(rects, bounds, cell = 2) {
  const size = Math.max(0.25, cell);
  const minX = bounds.minX, minZ = bounds.minZ;
  const nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / size));
  const nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / size));
  const cells = new Array(nx * nz);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor((r.minX - minX) / size));
    const x1 = Math.min(nx - 1, Math.floor((r.maxX - minX) / size));
    const z0 = Math.max(0, Math.floor((r.minZ - minZ) / size));
    const z1 = Math.min(nz - 1, Math.floor((r.maxZ - minZ) / size));
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const k = iz * nx + ix;
        (cells[k] || (cells[k] = [])).push(r);
      }
    }
  }
  return { size, minX, minZ, nx, nz, cells };
}

// True where nothing may grow. Points outside the indexed area are free: the grass field is
// padded a little past the layout bounds on purpose, and there is no geometry out there.
export function isBlocked(index, x, z) {
  if (!index) return false;
  const ix = Math.floor((x - index.minX) / index.size);
  const iz = Math.floor((z - index.minZ) / index.size);
  if (ix < 0 || iz < 0 || ix >= index.nx || iz >= index.nz) return false;
  const bucket = index.cells[iz * index.nx + ix];
  if (!bucket) return false;
  for (const r of bucket) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
  }
  return false;
}

// ─── vines ──────────────────────────────────────────────────────────────────

// Strand anchors along the top edges of wall boxes. `boxes` are the RENDERED boxes (the output of
// the viewer's boxTransformOnTerrain: {x, y, z, w, h, d} with y at the centre), not the layout
// rectangles, so a wall sunk into a hillside gets its vines at its real top rather than at 3 m.
//
// Each of a box's four top edges is walked independently. A wall running along X is a long box
// with a thin depth, so its two long faces collect nearly every strand and its 0.3 m end caps
// collect none — which falls out of the edge length without special-casing wall orientation.
export function vineAnchors(boxes, opts = {}) {
  const density = Math.max(0, opts.density ?? 0);       // strands per metre of top edge
  const length = Math.max(0.1, opts.length ?? 1.5);     // metres of hang before variation
  const lengthVar = Math.min(1, Math.max(0, opts.lengthVar ?? 0.5));
  const minEdge = opts.minEdge ?? 0.6;                  // edges shorter than this grow nothing
  const clump = Math.min(1, Math.max(0, opts.clump ?? 0));
  const rng = makeRng(opts.seed ?? 1);
  const out = [];
  if (density <= 0) return out;
  for (const b of boxes || []) {
    if (!b || !(b.w > 0) || !(b.d > 0) || !(b.h > 0)) continue;
    const top = b.y + b.h / 2;
    // {run} is the edge's own length; {nx,nz} the outward face normal it hangs off.
    const edges = [
      { run: b.w, nx: 0, nz: -1 }, { run: b.w, nx: 0, nz: 1 },
      { run: b.d, nx: -1, nz: 0 }, { run: b.d, nx: 1, nz: 0 },
    ];
    for (const e of edges) {
      if (e.run < minEdge) continue;
      // Fractional strand counts still grow: 0.4 strands is a 40% chance of one, not zero. A
      // floor() here would silently strip every short wall segment out of the whole map.
      const want = e.run * density;
      const n = Math.floor(want) + (rng() < want - Math.floor(want) ? 1 : 0);
      // Bunch centres along the edge; each strand lerps from its even slot toward one of them.
      const nCentres = Math.max(1, Math.round(n / 4));
      const centres = [];
      for (let c = 0; c < nCentres; c++) centres.push(rng() - 0.5);
      for (let i = 0; i < n; i++) {
        const even = (i + rng()) / n - 0.5;
        const centre = centres[Math.floor(rng() * centres.length)];
        const t = clump > 0
          ? Math.max(-0.5, Math.min(0.5, even + (centre - even) * clump + (rng() - 0.5) * 0.06 * clump))
          : even;
        out.push({
          x: e.nx !== 0 ? b.x + e.nx * b.w / 2 : b.x + t * b.w,
          z: e.nz !== 0 ? b.z + e.nz * b.d / 2 : b.z + t * b.d,
          y: top,
          nx: e.nx, nz: e.nz,
          len: length * (1 - lengthVar / 2 + rng() * lengthVar),
          seed: (rng() * 0xffffffff) >>> 0,
        });
      }
    }
  }
  return out;
}

// Distance from (x, z) to the nearest keep-out rectangle, saturating at `maxR`. Since the rects
// are already widened by the clearance, this is distance from the edge of GROWABLE ground, which
// is what the wall-affinity mask below wants. Searches the index cells within maxR, so cost is
// bounded by the reach and not by the number of rects on the map.
export function nearestBlockerDist(index, x, z, maxR) {
  if (!index || !(maxR > 0)) return maxR;
  const span = Math.ceil(maxR / index.size);
  const ix = Math.floor((x - index.minX) / index.size);
  const iz = Math.floor((z - index.minZ) / index.size);
  let best = maxR;
  for (let jz = iz - span; jz <= iz + span; jz++) {
    if (jz < 0 || jz >= index.nz) continue;
    for (let jx = ix - span; jx <= ix + span; jx++) {
      if (jx < 0 || jx >= index.nx) continue;
      const bucket = index.cells[jz * index.nx + jx];
      if (!bucket) continue;
      for (const r of bucket) {
        // Point-to-AABB distance; 0 on either axis when the point is level with the rect.
        const dx = Math.max(r.minX - x, 0, x - r.maxX);
        const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
        const d = Math.hypot(dx, dz);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// A 0..1 density mask for plants-placement.js's `densityAt`, concentrating growth against the
// concrete. Every reference photograph has the understory massed at the base of a wall with the
// open ground comparatively bare; a flat density reads as lawn weeds and says nothing about the
// architecture. Quadratic falloff so the band hugs the wall rather than washing across the map.
//
// Note this only ever REMOVES plants (densityAt is a rejection gate), so the theme's plantDensity
// is the near-wall density, not the average.
export function wallAffinityMask(index, reach, openFloor) {
  const R = Math.max(0.01, reach);
  const floorV = Math.min(1, Math.max(0, openFloor));
  return (x, z) => {
    const t = Math.min(1, nearestBlockerDist(index, x, z, R) / R);
    const near = (1 - t) * (1 - t);
    return floorV + (1 - floorV) * near;
  };
}

// ─── plants ─────────────────────────────────────────────────────────────────

// plants-placement.js works in forest-placement.js-style chunk descriptors. The arena is small
// and fully in view, so one chunk covering the whole padded bounds replaces env-viewer's
// streaming window entirely — there is nothing to stream to.
//
// A chunk is necessarily SQUARE (the placer scatters over `size` on both axes), and an arena is
// generally a rectangle, so the square must be CENTRED on the arena — anchoring it at the corner
// dumps the entire overspill past one edge, which reads as a band of plants growing off the side
// of the map. The overspill still has to be rejected by the caller either way; centring only
// makes it symmetric. Same square-versus-rectangle problem `bladeBudget` solves for grass.
export function floraChunk(bounds, pad = 0, key = 'arena') {
  const minX = bounds.minX - pad, maxX = bounds.maxX + pad;
  const minZ = bounds.minZ - pad, maxZ = bounds.maxZ + pad;
  const size = Math.max(maxX - minX, maxZ - minZ);
  const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  return { key, xMin: centerX - size / 2, zMin: centerZ - size / 2, size, centerX, centerZ };
}

// True when a point lies inside a rectangle. The plant filter needs this for the same reason the
// grass acceptFn does: a square placement area over a rectangular arena overspills, and outside
// the arena is not "open ground" — it is off the map, where `isBlocked` correctly reports nothing
// blocking because there is nothing there at all.
export function inRect(rect, x, z) {
  return x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
}

// Blades to ASK createGrass for, so that the padded rectangle ends up at `density` per m^2.
//
// The subtlety worth stating: createGrass's square mode scatters uniformly over a SQUARE of the
// given extent, and an arena is generally a rectangle. Sizing the request to the rectangle's area
// would thin the field by the rectangle's aspect ratio, because those blades get spread over the
// larger square instead. So the request is sized to the square, and the overspill outside the
// rectangle is dropped by the same acceptFn that drops blades inside walls.
//
// Capped, so a huge open-terrain layout can't ask for a geometry that takes seconds to build.
// One merged mesh, so this ceiling is memory, not draw calls: ~7 floats x 5 verts x 9 indices per
// blade puts 720k blades at roughly 125 MB of buffers. Above it the field thins instead of growing,
// which is why the panel reports the density it ACTUALLY built at rather than the one asked for.
export const BLADE_CAP = 720000;

export function bladeBudget(padded, density, cap = BLADE_CAP) {
  const w = Math.max(0, padded.maxX - padded.minX);
  const d = Math.max(0, padded.maxZ - padded.minZ);
  const extent = Math.max(w, d);
  return Math.min(cap, Math.max(0, Math.floor(extent * extent * Math.max(0, density))));
}
