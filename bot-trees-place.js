// bot-trees-place.js — pure placement math for the bot viewer's trees (bot-trees.js).
// No three.js, so test-bot-trees.mjs exercises all of it in Node. Same split as
// bot-flora-place.js / bot-flora.js: where trees go and what they cost decided here, meshes there.
//
// Exclusion, chunking and the blocker index are NOT duplicated here — bot-flora-place.js already
// owns blockerRects/padRects/buildBlockerIndex/isBlocked/inRect/floraChunk and trees reuse them
// unchanged.

// ─── trunk geometry, and why the collider only ever sees a proxy ─────────────

// An 8-sided open cylinder: 16 triangles. Open because a capsule and a bullet both approach a
// trunk from the side, and caps would cost 12 more triangles per tree for a shot straight down.
export const TRUNK_SIDES = 8;

// createMapCollider THROWS above its cap (250k) rather than degrading, and it counts every
// InstancedMesh instance separately. Measured 2026-08-15: a rendered tree is 1,112-13,674 triangles,
// so putting render geometry in the BVH caps the forest around 27 trees. A 16-triangle proxy puts
// the same headroom at thousands. This is why trunks collide and canopies do not.
export function trunkProxyTriangles(sides = TRUNK_SIDES) {
  return Math.max(3, Math.round(sides)) * 2;
}

export function trunkTriangleCost(treeCount, sides = TRUNK_SIDES) {
  return Math.max(0, Math.floor(treeCount)) * trunkProxyTriangles(sides);
}

// How many trees fit the triangles left over after terrain, walls and covers have taken theirs.
export function maxTreesForBudget(freeTriangles, sides = TRUNK_SIDES) {
  return Math.max(0, Math.floor(freeTriangles / trunkProxyTriangles(sides)));
}

// ─── how many trees to ask the scatter for ──────────────────────────────────

// Trees the scatter should REQUEST so the arena ends up at `density` trees per 100 m^2.
//
// Same correction bot-flora-place.js's bladeBudget makes, and for the same reason: placement runs
// over a SQUARE covering the padded bounds, while an arena is generally a rectangle, and every
// point landing outside it (or inside a wall, or in a clear zone) is dropped afterwards. Sizing the
// request to the rectangle's area would thin the forest by the aspect ratio. So it is sized to the
// square and the overspill is discarded.
//
// This is why the panel asks for a density rather than a count: a count means a different forest on
// every map size, and it was never the number of trees you actually got.
export const TREE_CAP = 600;

export function treeBudget(rect, density, cap = TREE_CAP) {
  const w = Math.max(0, (rect?.maxX ?? 0) - (rect?.minX ?? 0));
  const d = Math.max(0, (rect?.maxZ ?? 0) - (rect?.minZ ?? 0));
  const extent = Math.max(w, d);
  const want = Math.floor(extent * extent * Math.max(0, density || 0) / 100);
  return Math.min(Math.max(0, Math.floor(cap)), Math.max(0, want));
}

// Inverse, used once: to carry a saved slot's old absolute `count` over to a density without
// silently resizing somebody's forest.
export function densityForCount(rect, count) {
  const w = Math.max(0, (rect?.maxX ?? 0) - (rect?.minX ?? 0));
  const d = Math.max(0, (rect?.maxZ ?? 0) - (rect?.minZ ?? 0));
  const extent = Math.max(w, d);
  if (extent <= 0) return 0;
  return Math.max(0, count || 0) * 100 / (extent * extent);
}

// The trunk as it actually RENDERS: trees.js draws level 0 at radius[0], tapering upward, scaled by
// the placement record's scale. Collision derived from anything else would drift from the picture.
export function trunkRadiusFor(opts, scale = 1) {
  const r = Array.isArray(opts?.radius) ? opts.radius[0] : opts?.radius;
  return Math.max(0.01, (Number.isFinite(r) ? r : 1) * Math.max(0.01, scale));
}

export function trunkHeightFor(opts, scale = 1) {
  const l = Array.isArray(opts?.length) ? opts.length[0] : opts?.length;
  return Math.max(0.1, (Number.isFinite(l) ? l : 1) * Math.max(0.01, scale));
}

// ─── nav ────────────────────────────────────────────────────────────────────

// Trunk footprints as {x,z,w,d} rects for nav-grid's blocker list, widened by the bot capsule
// radius so a bot routes around the trunk instead of clipping it and being pushed out by the BVH.
//
// These go into `blockers` only, never `sightBlockers`: bots.md:6709-6728 records that thin trunk
// rects occlude nothing at grid pitch while still emitting up to 8 corner records each. Bullets
// still stop on trunks, because that comes from the BVH proxy, not from the tactical field.
export function trunkNavRects(records, speciesTable, capsuleRadius = 0.4) {
  const out = [];
  for (const r of records || []) {
    const sp = speciesTable?.[r.speciesIdx];
    if (!sp) continue;
    const rad = trunkRadiusFor(sp, r.scale) + Math.max(0, capsuleRadius);
    out.push({ x: r.x, z: r.z, w: rad * 2, d: rad * 2 });
  }
  return out;
}

// ─── cluster stamp ──────────────────────────────────────────────────────────

// Radius + count + jitter in one gesture. Nothing in the repo did this before: forest-placement's
// 'clustered' mode only infers cluster count as count/5 and cannot be aimed at a point, and
// plants-placement's clumpRadius is per-chunk rather than per-click.
//
// `falloff` 0 scatters uniformly across the disc (sqrt keeps it uniform by AREA, since a plain
// rng()*radius bunches everything at the centre); 1 pulls hard toward the middle for a copse.
// `minSeparation` rejects overlaps, with a bounded attempt count so a too-tight ask thins out
// rather than spinning.
export function stampCluster(center, opts, rng) {
  const count = Math.max(0, Math.floor(opts?.count ?? 1));
  const radius = Math.max(0, opts?.radius ?? 0);
  const falloff = Math.min(1, Math.max(0, opts?.falloff ?? 0));
  const minSep = Math.max(0, opts?.minSeparation ?? 0);
  const accept = opts?.accept ?? null;
  const out = [];
  if (count === 0) return out;
  // A single tree, or a zero-radius brush, lands exactly where it was clicked. Returning here also
  // keeps a zero radius from falling into the loop and stacking every tree on one point.
  if (radius === 0 || count === 1) {
    if (!accept || accept(center.x, center.z)) out.push({ x: center.x, z: center.z });
    return out;
  }
  const maxAttempts = count * 12;
  for (let a = 0; a < maxAttempts && out.length < count; a++) {
    const ang = rng() * Math.PI * 2;
    const u = rng();
    // sqrt(u) is uniform over the disc; u itself is the fully centre-weighted extreme.
    const t = falloff > 0 ? Math.sqrt(u) * (1 - falloff) + u * falloff : Math.sqrt(u);
    const x = center.x + Math.cos(ang) * radius * t;
    const z = center.z + Math.sin(ang) * radius * t;
    if (accept && !accept(x, z)) continue;
    if (minSep > 0) {
      let clash = false;
      for (const p of out) {
        if ((p.x - x) ** 2 + (p.z - z) ** 2 < minSep * minSep) { clash = true; break; }
      }
      if (clash) continue;
    }
    out.push({ x, z });
  }
  return out;
}

// ─── records ────────────────────────────────────────────────────────────────

// A hand-placed tree stores a species ID, never an index: indices shift the moment the user adds or
// removes a family in tree-viewer, which would silently repaint a saved forest with wrong species.
// Records whose species is no longer present are dropped rather than remapped to something else.
export function resolvePlacedRecords(placed, speciesTable, heightAt) {
  const out = [];
  for (const p of placed || []) {
    let idx = -1;
    for (let i = 0; i < speciesTable.length; i++) {
      if (speciesTable[i]._tag?.id === p.speciesId) { idx = i; break; }
    }
    if (idx < 0) continue;
    out.push({
      x: p.x,
      z: p.z,
      y: heightAt ? heightAt(p.x, p.z) : 0,
      scale: Number.isFinite(p.scale) ? p.scale : 1,
      yaw: Number.isFinite(p.yaw) ? p.yaw : 0,
      speciesIdx: idx,
      speciesId: p.speciesId,
      origin: 'placed',
    });
  }
  return out;
}

// Auto records carry no y either: placementRecords works in XZ and the ground is sampled here, so a
// forest saved on one terrain re-drapes onto whatever ground the slot restores. Same reasoning as
// road-network.js storing control points only.
export function tagAutoRecords(records, speciesTable, heightAt) {
  const out = [];
  for (const r of records || []) {
    const sp = speciesTable?.[r.speciesIdx];
    out.push({
      ...r,
      y: heightAt ? heightAt(r.x, r.z) : 0,
      speciesId: sp?._tag?.id ?? null,
      origin: 'auto',
    });
  }
  return out;
}

// Only hand-placed trees are persisted; auto ones regenerate from the seed, exactly as
// bot-viewer-v3 already filters spawn markers by origin === 'placed'.
export function serializePlaced(records) {
  return (records || [])
    .filter(r => r.origin === 'placed' && r.speciesId)
    .map(r => ({
      x: round3(r.x), z: round3(r.z), speciesId: r.speciesId,
      scale: round3(r.scale), yaw: round3(r.yaw),
    }));
}

function round3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

// Nearest hand-placed tree within `radius`, for click-to-erase. Auto trees are not erasable
// individually: they are a function of the seed, so removing one would come back on the next
// rebuild. Returns an index into `records` or -1.
export function nearestPlacedIndex(records, x, z, radius) {
  let best = -1, bestD = radius * radius;
  for (let i = 0; i < (records?.length || 0); i++) {
    const r = records[i];
    if (r.origin !== 'placed') continue;
    const d = (r.x - x) ** 2 + (r.z - z) ** 2;
    // Strictly nearer, so an exact tie keeps the first match and the pick stays stable.
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
