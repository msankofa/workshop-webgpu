// nav-corners.js — pure, THREE-free baked corner map: cover anchors + peek points off sight-blocker rects.
// Node-tested in test-nav-corners.mjs. See docs/superpowers/plans/2026-07-23-bot-cover-corners-plan.md.
// Only rects tall enough to block sight (h >= SIGHT_BLOCK_HEIGHT, missing h = full height) produce
// corners; each rect corner yields up to 2 anchor records, one per adjoining face. Culls: corner
// buried inside another sight-blocking rect, anchor/peek snaps to no walkable cell, or the
// field's anchor<->peek canSee cross-check fails (snapping artifact).
//
// GROUND ONLY, like the visibility field it is built against: anchorCell/peekCell are base column
// keys, `walkable` reads navGrid.cells, and crest detection scans one height per column. A deck
// from nav-grid's level overlay contributes no cover records — see nav-visibility's `levelsIgnored`.

import { SIGHT_BLOCK_HEIGHT } from './nav-visibility.js';
import { nearestWalkable } from './nav-grid.js';

// Anchor placement (metres): inset along the wall face from the corner, offset off the face.
export const ANCHOR_INSET = 0.6;
export const ANCHOR_OFFACE = 0.4;
// Peek point sits this far past the corner edge along the lean direction.
export const PEEK_PAST = 0.5;

const SNAP_RADIUS_CELLS = 2;
const BURY_EPS = 1e-6;

function walkable(grid, c, r) {
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false;
  return grid.cells[r * grid.cols + c] === 1;
}

// World point -> {cell, x, z} on a walkable cell via nav-grid's spiral snap, or null.
// Keeps the exact point when its own cell is walkable, else the snapped cell's center.
function snapWalkable(grid, x, z) {
  const c0 = Math.floor((x - grid.minX) / grid.cellSize);
  const r0 = Math.floor((z - grid.minZ) / grid.cellSize);
  if (walkable(grid, c0, r0)) return { cell: r0 * grid.cols + c0, x, z };
  const hit = nearestWalkable(grid, c0, r0, SNAP_RADIUS_CELLS);
  if (!hit) return null;
  return { cell: hit.r * grid.cols + hit.c, x: grid.minX + (hit.c + 0.5) * grid.cellSize, z: grid.minZ + (hit.r + 0.5) * grid.cellSize };
}

// True if (x,z) lies inside (boundary-inclusive) any tall rect other than `self` — so corners
// shared by abutting rects are culled, but freestanding pillar corners survive.
function pointBuried(rects, self, x, z) {
  for (const b of rects) {
    if (b === self) continue;
    if (Math.abs(x - b.x) <= b.w / 2 + BURY_EPS && Math.abs(z - b.z) <= b.d / 2 + BURY_EPS) return true;
  }
  return false;
}

// Bake the corner map. `sightBlockerRects` are bot-viewer-format {x,z,w,d,h} center + full
// extents; `field` is a buildVisibilityField result used for the anchor<->peek cross-check.
// `heights` (nav-visibility's buildHeightGrid) additionally emits terrain crest cover — pass the
// same grid the field was built with, or omit it for wall-only cover.
// `inset`/`offFace`/`peekPast` default to the authored metre values, which assume a fine (~0.5 m)
// grid: on a coarser grid anchor and peek snap to the SAME cell and every record self-culls, so a
// caller baking at a bigger pitch scales them up.
export function buildCornerMap(navGrid, sightBlockerRects, field,
  { heights = null, crest = {}, inset = ANCHOR_INSET, offFace = ANCHOR_OFFACE, peekPast = PEEK_PAST } = {}) {
  const tall = tallRects(sightBlockerRects);
  const corners = [];
  for (const b of tall) emitRectCorners(corners, b, tall, navGrid, field, inset, offFace, peekPast);
  let crestCapped = false;
  if (heights) {
    const crests = buildCrestCorners(navGrid, heights, field, crest);
    crestCapped = crests.length >= (crest.maxRecords ?? CREST_DEFAULTS.maxRecords);
    corners.push(...crests);
  }
  return { corners, crestCapped };
}

export function tallRects(rects) {
  return rects.filter(b => (b.h === undefined ? Infinity : b.h) >= SIGHT_BLOCK_HEIGHT);
}

// Every record one rect contributes. Split out of buildCornerMap so the local update below emits
// through the identical path — two implementations of this would drift the moment either changed.
// `all` is the FULL tall list, not the dirty subset: the buried test asks whether some other rect
// covers this corner, and a rect outside the dirty region can still be the one burying it.
function emitRectCorners(out, b, all, navGrid, field, inset, offFace, peekPast) {
  const hw = b.w / 2, hd = b.d / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = b.x + sx * hw, pz = b.z + sz * hd;
      if (pointBuried(all, b, px, pz)) continue;
      const wallDirA = { x: -sx, z: 0 }, wallDirB = { x: 0, z: -sz };
      // one candidate per adjoining face: inset direction, outward face normal, lean direction
      const faces = [
        { along: wallDirA, normal: { x: 0, z: sz }, peek: { x: sx, z: 0 } },
        { along: wallDirB, normal: { x: sx, z: 0 }, peek: { x: 0, z: sz } },
      ];
      for (const f of faces) {
        const a = snapWalkable(navGrid,
          px + f.along.x * inset + f.normal.x * offFace,
          pz + f.along.z * inset + f.normal.z * offFace);
        const p = snapWalkable(navGrid,
          px + f.peek.x * peekPast + f.normal.x * offFace,
          pz + f.peek.z * peekPast + f.normal.z * offFace);
        if (!a || !p) continue;
        if (a.cell === p.cell) continue;   // anchor and peek quantized together: no lean to make
        if (!field.canSee(a.cell, p.cell)) continue; // snapping artifact — drop
        out.push({
          kind: 'wall',
          corner: { x: px, z: pz },
          wallDirA, wallDirB,
          anchorCell: a.cell, anchorPos: { x: a.x, z: a.z },
          peekCell: p.cell, peekPos: { x: p.x, z: p.z },
          peekDir: f.peek,
          claimedBy: null,
        });
      }
    }
  }
  return out;
}

// How far outside a changed footprint a WALL record can be affected, in metres. A record sits at
// most inset+offFace (or peekPast+offFace) off its rect's corner, then snaps up to SNAP_RADIUS_CELLS
// further, and its only field query is anchor->peek. Nothing else about it reads geometry, so
// beyond this radius a wall record cannot change. Verified by the equivalence test.
export function wallCornerReach(cellSize, { inset = ANCHOR_INSET, offFace = ANCHOR_OFFACE, peekPast = PEEK_PAST } = {}) {
  return Math.max(inset, peekPast) + offFace + SNAP_RADIUS_CELLS * cellSize + cellSize;
}

// Rebuild only the corner records a change inside `dirty` could have altered, reusing the rest.
//
// Exact for wall records: they are locally determined (see wallCornerReach). Crest records are NOT
// locally determined in the same clean way -- buildCrestCorners claims one block slot per direction
// in a global row-major scan under a hard cap, so which cell represents a slot depends on scan
// order. This rescans only the dirty window with `taken` seeded from the surviving crests, which
// keeps every survivor and never invents cover, but can pick a different representative cell inside
// the window than a full bake would. `crestExact` in the return says whether crests were touched at
// all, so a caller that needs a byte-identical map knows when to fall back to buildCornerMap.
//
// `dirty` is world-space {minX, maxX, minZ, maxZ}. `sightBlockerRects` is the CURRENT full list.
export function updateCornerMapInBounds(prev, navGrid, sightBlockerRects, field, dirty,
  { heights = null, crest = {}, inset = ANCHOR_INSET, offFace = ANCHOR_OFFACE, peekPast = PEEK_PAST } = {}) {
  const { cellSize } = navGrid;
  const tall = tallRects(sightBlockerRects);
  const reach = wallCornerReach(cellSize, { inset, offFace, peekPast });
  const wallZone = expand(dirty, reach);

  // Crest reach: a crest reads ground and visibility up to farCells out along one axis, plus the
  // uphill span, so a change that far away can flip one.
  const crestOpts = { ...CREST_DEFAULTS, ...crest };
  const crestReach = (crestOpts.farCells + crestOpts.maxSpan + 1) * cellSize;
  const crestZone = expand(dirty, crestReach);

  const kept = [];
  const keptCrestSlots = new Set();
  let touchedCrests = false;
  for (const rec of prev.corners) {
    if (rec.kind === 'crest') {
      if (inside(crestZone, rec.anchorPos) || inside(crestZone, rec.peekPos)) { touchedCrests = true; continue; }
      kept.push(rec);
      keptCrestSlots.add(crestSlotOf(rec, navGrid, crestOpts));
    } else {
      if (inside(wallZone, rec.corner) || inside(wallZone, rec.anchorPos) || inside(wallZone, rec.peekPos)) continue;
      kept.push(rec);
    }
  }

  const fresh = [];
  for (const b of tall) {
    if (!rectIntersects(wallZone, b)) continue;
    emitRectCorners(fresh, b, tall, navGrid, field, inset, offFace, peekPast);
  }
  // A rect wholly outside the zone can still own a corner inside it only if the rect itself reaches
  // in, which rectIntersects already covers. Records emitted outside the zone would duplicate kept
  // ones, so drop them.
  const added = fresh.filter(rec => inside(wallZone, rec.corner) || inside(wallZone, rec.anchorPos) || inside(wallZone, rec.peekPos));

  let crestCapped = prev.crestCapped ?? false;
  if (heights && touchedCrests) {
    const window = cellWindow(navGrid, crestZone);
    const room = Math.max(0, (crestOpts.maxRecords ?? CREST_DEFAULTS.maxRecords) - kept.filter(r => r.kind === 'crest').length);
    const crests = buildCrestCorners(navGrid, heights, field,
      { ...crestOpts, maxRecords: room, window, taken: keptCrestSlots });
    crestCapped = crests.length >= room;
    added.push(...crests);
  }

  return { corners: kept.concat(added), crestCapped, crestExact: !touchedCrests };
}

function expand(r, m) { return { minX: r.minX - m, maxX: r.maxX + m, minZ: r.minZ - m, maxZ: r.maxZ + m }; }
function inside(r, p) { return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ; }
function rectIntersects(r, b) {
  return Math.abs(b.x - (r.minX + r.maxX) / 2) <= b.w / 2 + (r.maxX - r.minX) / 2
    && Math.abs(b.z - (r.minZ + r.maxZ) / 2) <= b.d / 2 + (r.maxZ - r.minZ) / 2;
}
// Cell window covering a world rect, clamped to the grid.
function cellWindow(grid, r) {
  return {
    c0: Math.max(0, Math.floor((r.minX - grid.minX) / grid.cellSize)),
    c1: Math.min(grid.cols - 1, Math.ceil((r.maxX - grid.minX) / grid.cellSize)),
    r0: Math.max(0, Math.floor((r.minZ - grid.minZ) / grid.cellSize)),
    r1: Math.min(grid.rows - 1, Math.ceil((r.maxZ - grid.minZ) / grid.cellSize)),
  };
}
// The block slot a crest record occupies, so a partial rescan can honour spacing against survivors.
function crestSlotOf(rec, grid, opts) {
  const block = Math.max(1, (opts.spacingCells | 0) || 1);
  const c = rec.anchorCell % grid.cols, r = (rec.anchorCell / grid.cols) | 0;
  const d = CREST_DIRS.findIndex(dir => dir.c === rec.peekDir.x && dir.r === rec.peekDir.z);
  return `${d}:${(c / block) | 0}:${(r / block) | 0}`;
}

// Terrain cover defaults (metres / cells).
export const CREST_DEFAULTS = {
  minRise: 0.5,      // ground must climb this much from anchor to crest for the pair to be a candidate
  maxSpan: 3,        // cells uphill searched for the crest itself
  farCells: 10,      // how far past the crest the "threat side" probe sits
  spacingCells: 4,   // one record per this-sized block per direction, so a rolling field can't flood the map
  // Hard cap, row-major scan order -> deterministic. Raised from 400 once eroded/terraced terrain
  // started producing ~380 crests on a single 172 m map; `crestCapped` on the corner map says when
  // it bites, so truncation never passes for "that is all the cover there is".
  maxRecords: 800,
  stride: 1,         // sample every Nth cell (2+ trades coverage for bake time on huge grids)
};

const CREST_DIRS = [{ c: 1, r: 0 }, { c: -1, r: 0 }, { c: 0, r: 1 }, { c: 0, r: -1 }];

// Terrain cover: a bot in dead ground behind a brow is hidden, and stepping up to the brow gives
// it the shot. That is the wall-corner contract exactly, so crests emit the same record shape and
// the cover FSM needs no changes. Qualification is measured, not assumed — the anchor must be
// hidden from a probe cell out on the threat side while the crest can see it — which only works
// because the visibility field itself is terrain-aware (opts.terrain in buildLazyVisibilityField).
// `window` ({c0,c1,r0,r1}) restricts the scan to part of the grid and `taken` pre-claims block slots
// held by records the caller is keeping — together they let updateCornerMapInBounds rescan a patch
// without the survivors outside it being re-emitted or crowded out. Both default to a full bake.
export function buildCrestCorners(navGrid, heights, field, opts = {}) {
  const { minRise, maxSpan, farCells, spacingCells, maxRecords, stride, window = null, taken: seed = null } = { ...CREST_DEFAULTS, ...opts };
  const { cols, rows, cellSize, minX, minZ } = navGrid;
  const center = (c, r) => ({ x: minX + (c + 0.5) * cellSize, z: minZ + (r + 0.5) * cellSize });
  const step = Math.max(1, stride | 0);
  const block = Math.max(1, spacingCells | 0);
  const taken = seed ? new Set(seed) : new Set();
  const out = [];
  // A window must stay on the same stride phase as a full bake, or a partial rescan samples cells
  // the full bake never visits and emits crests that could not otherwise exist.
  const rStart = window ? Math.ceil(window.r0 / step) * step : 0;
  const cStart = window ? Math.ceil(window.c0 / step) * step : 0;
  const rEnd = window ? Math.min(rows, window.r1 + 1) : rows;
  const cEnd = window ? Math.min(cols, window.c1 + 1) : cols;
  for (let r = rStart; r < rEnd && out.length < maxRecords; r += step) {
    for (let c = cStart; c < cEnd && out.length < maxRecords; c += step) {
      if (!walkable(navGrid, c, r)) continue;
      const anchorKey = r * cols + c;
      const anchorH = heights[anchorKey];
      for (let d = 0; d < CREST_DIRS.length; d++) {
        const dir = CREST_DIRS[d];
        const slot = `${d}:${(c / block) | 0}:${(r / block) | 0}`;
        if (taken.has(slot)) continue;
        // Walk uphill for the brow: the highest walkable cell within maxSpan along this direction.
        let pc = -1, pr = -1, peakH = anchorH;
        for (let s = 1; s <= maxSpan; s++) {
          const nc = c + dir.c * s, nr = r + dir.r * s;
          if (!walkable(navGrid, nc, nr)) break;
          const h = heights[nr * cols + nc];
          if (h <= peakH) break;              // past the brow (or flat) — stop at the last rise
          peakH = h; pc = nc; pr = nr;
        }
        if (pc < 0 || peakH - anchorH < minRise) continue;
        // Threat-side probe, pulled back toward the crest until it lands on a walkable cell.
        let fc = -1, fr = -1;
        for (let s = farCells; s > maxSpan; s--) {
          const nc = c + dir.c * s, nr = r + dir.r * s;
          if (walkable(navGrid, nc, nr)) { fc = nc; fr = nr; break; }
        }
        if (fc < 0) continue;
        const peekKey = pr * cols + pc, farKey = fr * cols + fc;
        if (field.canSee(anchorKey, farKey)) continue;   // not actually dead ground
        if (!field.canSee(peekKey, farKey)) continue;    // brow can't shoot back — useless as cover
        const a = center(c, r), p = center(pc, pr);
        taken.add(slot);
        out.push({
          kind: 'crest',
          corner: { x: p.x, z: p.z },
          wallDirA: { x: dir.r, z: dir.c }, wallDirB: { x: -dir.r, z: -dir.c }, // along the brow
          anchorCell: anchorKey, anchorPos: a,
          peekCell: peekKey, peekPos: p,
          peekDir: { x: dir.c, z: dir.r },
          claimedBy: null,
        });
        if (out.length >= maxRecords) break;
      }
    }
  }
  return out;
}
