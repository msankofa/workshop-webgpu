// nav-grid.js — pure, THREE-free 2D walkable grid + A* pathfinding for indoor bot navigation.
// Node-tested in test-nav-grid.mjs. See docs/superpowers/specs/2026-07-13-combat-bot-fsm-design.md
// ("Nav grid"). Consumed by bot-viewer.html's patrol/seek movement; the FSM in bot-activity.js
// never touches grid cells directly, only the waypoint queue this produces.

// Slope costing defaults. A grade of 1 = 45 deg; climbing is charged harder than descending, and
// the factor is never below 1 so findPath's straight-line heuristic stays admissible.
export const SLOPE_COST_DEFAULTS = {
  up: 1.8,          // extra cost per unit of uphill grade
  down: 0.6,        // ... and per unit of downhill grade (braking, not free)
  maxFactor: 6,     // ceiling, so a near-vertical cell can't dominate the whole search
  smoothMaxRise: 0.6, // m a string-pull shortcut may climb above its endpoints before it's rejected
};

// Builds a walkable/blocked grid over `bounds` ({minX,maxX,minZ,maxZ}) at `cellSize` resolution,
// sampling `walkableTest(x, z) -> boolean` at each cell center. One grid per loaded map, built
// once and cached by the caller -- not regenerated per bot or per frame.
// With `heightAt`, the grid also stores per-cell ground height and every search charges slope:
// paths then route around hills instead of straight over them. Omit it for flat maps (no cost).
// `blockers` is the fast path and the one every rect-based map should use. Without it, the bake
// costs cells x rects, because the caller's test has to scan its own rectangle list per cell -- 144
// million tests on a 400x400 grid with 900 walls, which measured 220 ms. Handed the rects instead,
// this rasterizes each one over the cells it covers (the shape buildSightGrid has always used) and
// the caller's test then runs only where no rect already claimed the cell.
//
// Rasterized cells are HARD blocked: `softBlockedTest` is never consulted for them, matching a
// caller whose own test rejects wall points before it ever considers slope. `blockerMargin` grows
// every rect on all sides, which is how the viewer keeps paths off wall surfaces.
// `decks` adds a sparse second (third, ...) walkable surface over chosen columns -- see attachLevels.
// Omit it and the grid is byte-for-byte what it always was.
export function buildNavGrid(walkableTest, bounds, cellSize,
  { heightAt = null, slopeCost = null, softBlockedTest = null, connectRegions: doConnect = true,
    minConnectRegion = 6, blockers = null, blockerMargin = 0, decks = null, levels: levelOpts = null } = {}) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const cells = new Uint8Array(cols * rows);
  const heights = heightAt ? new Float32Array(cols * rows) : null;
  // A blocked cell is blocked for one of two very different reasons, and connectivity repair turns
  // on the difference: a wall is real geometry and must never be opened, while too-steep ground is
  // continuous surface the capsule can still stand on. `softBlockedTest` marks the second kind.
  const soft = softBlockedTest ? new Uint8Array(cols * rows) : null;
  const blocked = blockers ? rasterizeBlockers({ cols, rows, cellSize, minX, minZ }, blockers, blockerMargin) : null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * cellSize;
      const z = minZ + (r + 0.5) * cellSize;
      const k = r * cols + c;
      if (heights) heights[k] = heightAt(x, z);
      if (blocked && blocked[k]) { cells[k] = 0; continue; }   // hard: soft stays 0
      const ok = walkableTest(x, z);
      cells[k] = ok ? 1 : 0;
      if (soft && !ok) soft[k] = softBlockedTest(x, z) ? 1 : 0;
    }
  }
  const grid = { cols, rows, cellSize, minX, minZ, cells, heights, soft, levels: null };
  if (decks && decks.length) attachLevels(grid, decks, levelOpts || {});
  return finalizeNavGrid(grid, { connectRegions: doConnect, minConnectRegion, slopeCost });
}

// Mark every cell whose CENTER falls inside a rect grown by `margin`, which is exactly the
// `|cx - b.x| <= b.w/2 + margin` test a per-cell scan would run, so the two agree cell for cell.
// Same cell-range arithmetic as nav-visibility's buildSightGrid.
export function rasterizeBlockers({ cols, rows, cellSize, minX, minZ }, rects, margin = 0) {
  const blocked = new Uint8Array(cols * rows);
  for (const b of rects) {
    const hw = b.w / 2 + margin, hd = b.d / 2 + margin;
    const c0 = Math.max(0, Math.ceil((b.x - hw - minX) / cellSize - 0.5));
    const c1 = Math.min(cols - 1, Math.floor((b.x + hw - minX) / cellSize - 0.5));
    const r0 = Math.max(0, Math.ceil((b.z - hd - minZ) / cellSize - 0.5));
    const r1 = Math.min(rows - 1, Math.floor((b.z + hd - minZ) / cellSize - 0.5));
    for (let r = r0; r <= r1; r++) {
      const row = r * cols;
      for (let c = c0; c <= c1; c++) blocked[row + c] = 1;
    }
  }
  return blocked;
}

// ---------------------------------------------------------------------------------------------
// Level overlay: a sparse second surface over some columns, so a deck can be walked ON and UNDER.
//
// The base layer keeps its keys (`r * cols + c`, 0 .. cols*rows-1) and every array indexed by them,
// so a map with no decks bakes byte-identically and every existing call site keeps working. Extra
// levels allocate AFTER that range, one key each, chained per column. Most columns never get one.
//
// Two rules make the overlay behave like architecture rather than a second ground:
//  * A step is gated by height ONLY when a level is involved. Base->base stays the continuous
//    ground it has always been (nav charges slope as cost; the caller's own test rejects cliffs),
//    so adding a deck somewhere cannot change how a bot walks up a hill somewhere else.
//  * `levelStep` is the most a body may climb or drop to change surface, so a deck's side excludes
//    itself and the only way up is a chain of rects you deliberately provide -- a ramp is just
//    several thin decks at stepped heights, which needs no ramp concept here at all.
// ---------------------------------------------------------------------------------------------

export const LEVEL_DEFAULTS = {
  // Max height difference for a step onto/off a level. 0.5 m clears everything nav's own slope gate
  // already allows (maxSlope 0.85 over a 0.5 m cell = 0.43 m) without letting a bot off a deck edge.
  step: 0.5,
  // How far a "which surface am I on" query may be from a level before it stops matching. The slab
  // contract forces >=1.8 m of headroom, so 1.0 m separates two levels at one column cleanly.
  tolerance: 1.0,
};

// Stamp `decks` ({x,z,w,d,y} center + full extents, y = walking surface height) onto the grid as
// extra levels. Cell-CENTER coverage, the same rule rasterizeBlockers and buildSightGrid use, so a
// deck edge lands on the same cells everywhere. Two decks at the same height over one column merge.
export function attachLevels(grid, decks, { step = LEVEL_DEFAULTS.step, tolerance = LEVEL_DEFAULTS.tolerance } = {}) {
  const { cols, rows, cellSize, minX, minZ } = grid;
  const n = cols * rows;
  const base = [], y = [];
  const head = new Int32Array(n).fill(-1);
  const next = [];
  for (const d of decks) {
    const hw = d.w / 2, hd = d.d / 2;
    const c0 = Math.max(0, Math.ceil((d.x - hw - minX) / cellSize - 0.5));
    const c1 = Math.min(cols - 1, Math.floor((d.x + hw - minX) / cellSize - 0.5));
    const r0 = Math.max(0, Math.ceil((d.z - hd - minZ) / cellSize - 0.5));
    const r1 = Math.min(rows - 1, Math.floor((d.z + hd - minZ) / cellSize - 0.5));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        let dup = false;
        for (let i = head[k]; i !== -1; i = next[i]) if (Math.abs(y[i] - d.y) < 1e-3) { dup = true; break; }
        if (dup) continue;
        const i = base.length;
        base.push(k); y.push(d.y);
        next.push(head[k]); head[k] = i;
      }
    }
  }
  if (!base.length) { grid.levels = null; return grid; }
  grid.levels = {
    count: base.length,
    base: Int32Array.from(base),
    y: Float32Array.from(y),
    cells: new Uint8Array(base.length).fill(1),
    head, next: Int32Array.from(next),
    step, tolerance,
  };
  return grid;
}

// Total keys addressable on this grid: base columns plus every extra level.
export function keyCount(grid) {
  return grid.cols * grid.rows + (grid.levels ? grid.levels.count : 0);
}
export function keyIsLevel(grid, k) { return k >= grid.cols * grid.rows; }
// Base-column key a key sits over -- itself for a base key, the level's footprint cell otherwise.
export function keyBase(grid, k) {
  const n = grid.cols * grid.rows;
  return k < n ? k : grid.levels.base[k - n];
}
export function keyHeight(grid, k) {
  const n = grid.cols * grid.rows;
  if (k >= n) return grid.levels.y[k - n];
  return grid.heights ? grid.heights[k] : 0;
}
export function keyWalkable(grid, k) {
  const n = grid.cols * grid.rows;
  if (k < 0) return false;
  return k < n ? grid.cells[k] === 1 : grid.levels.cells[k - n] === 1;
}
// World position of a key, including the surface height it stands for.
export function keyToWorld(grid, k) {
  const b = keyBase(grid, k);
  const c = b % grid.cols, r = (b / grid.cols) | 0;
  return { x: grid.minX + (c + 0.5) * grid.cellSize, z: grid.minZ + (r + 0.5) * grid.cellSize, y: keyHeight(grid, k) };
}

// The surface at (x, z) nearest `y`, or -1. THE REFUSAL IS THE POINT: with no level within
// `tolerance` this returns nothing rather than the nearest one, so a bot beneath a deck can never
// be mistaken for a bot standing on it. Pass y = null for the old 2D answer (the base column).
export function keyAt(grid, x, z, y = null, tolerance = null) {
  const c = Math.floor((x - grid.minX) / grid.cellSize);
  const r = Math.floor((z - grid.minZ) / grid.cellSize);
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return -1;
  const k = r * grid.cols + c;
  const lv = grid.levels;
  if (!lv || y === null || y === undefined) return k;
  const tol = tolerance ?? lv.tolerance;
  const n = grid.cols * grid.rows;
  let best = -1, bestD = tol;
  const d0 = Math.abs(y - (grid.heights ? grid.heights[k] : 0));
  if (d0 <= bestD) { best = k; bestD = d0; }
  for (let i = lv.head[k]; i !== -1; i = lv.next[i]) {
    const d = Math.abs(y - lv.y[i]);
    if (d <= bestD) { best = n + i; bestD = d; }
  }
  return best;
}

// keyAt, then a spiral outward over COLUMNS for the nearest walkable surface still within
// tolerance of `y`. Refuses the same way keyAt does: a point with no surface at its height gets -1,
// never the ground under a deck.
export function nearestWalkableKey(grid, x, z, y = null, maxRadius = 4, tolerance = null) {
  const direct = keyAt(grid, x, z, y, tolerance);
  if (direct >= 0 && keyWalkable(grid, direct)) return direct;
  const c0 = Math.floor((x - grid.minX) / grid.cellSize);
  const r0 = Math.floor((z - grid.minZ) / grid.cellSize);
  for (let rad = 1; rad <= maxRadius; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
        const c = c0 + dc, r = r0 + dr;
        if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue;
        const k = keyAt(grid, grid.minX + (c + 0.5) * grid.cellSize, grid.minZ + (r + 0.5) * grid.cellSize, y, tolerance);
        if (k >= 0 && keyWalkable(grid, k)) return k;
      }
    }
  }
  return -1;
}

// Neighbour expansion shared by every search here. Two implementations of this would drift the
// moment either changed, and they have to agree exactly or a label can promise a route A* refuses.
// Writes destination keys into NB_KEY and the base step cost into NB_STEP; returns the count.
// NB_COL/NB_ROW carry the destination COLUMN, which this already has in hand -- without them A*'s
// heuristic and floodFill's radius test would each pay a keyBase() call per neighbour, which
// measured as most of the cost of routing the searches through here at all.
const NB_MAX = 32;
const NB_KEY = new Int32Array(NB_MAX);
const NB_STEP = new Float64Array(NB_MAX);
const NB_COL = new Int32Array(NB_MAX);
const NB_ROW = new Int32Array(NB_MAX);

// True if `k` can reach ANY surface at column (nc, nr) -- the flanking test for a diagonal.
function stepExists(grid, k, nc, nr, h, withSoft) {
  if (nc < 0 || nr < 0 || nc >= grid.cols || nr >= grid.rows) return false;
  const n = grid.cols * grid.rows;
  const nk = nr * grid.cols + nc;
  const lv = grid.levels;
  const groundOk = grid.cells[nk] === 1 || (withSoft && grid.soft && grid.soft[nk] === 1);
  if (groundOk && (k < n || Math.abs(h - (grid.heights ? grid.heights[nk] : 0)) <= lv.step)) return true;
  if (!lv) return false;
  for (let i = lv.head[nk]; i !== -1; i = lv.next[i]) {
    if (lv.cells[i] === 1 && Math.abs(h - lv.y[i]) <= lv.step) return true;
  }
  return false;
}

// `withSoft` widens what counts as traversable to soft-blocked base cells, which is what
// cheapestSoftLink searches over. A boolean rather than a predicate on purpose: this is the hot
// loop of every search, and a closure argument allocates once per node expansion.
function expandNeighbors(grid, key, withSoft = false) {
  const cols = grid.cols, rows = grid.rows, lv = grid.levels;
  const n = cols * rows;
  const cells = grid.cells, heights = grid.heights;
  const soft = withSoft ? grid.soft : null;
  const base = key < n ? key : lv.base[key - n];
  const cr = (base / cols) | 0, cc = base - cr * cols;
  const isLevel = key >= n;
  const h = isLevel ? lv.y[key - n] : (heights ? heights[base] : 0);
  let out = 0;
  for (let i = 0; i < NB_COUNT; i++) {
    const dc = NB_DC[i], dr = NB_DR[i];
    const nc = cc + dc, nr = cr + dr;
    if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
    const nk = nr * cols + nc;
    // Same corner rule as findPath everywhere: a diagonal needs both flanking columns open. The
    // flat case is spelled out rather than delegated because stepExists costs 8 calls per node,
    // which measured as most of the bake regression from sharing this loop at all.
    if (dc !== 0 && dr !== 0) {
      if (lv) {
        if (!stepExists(grid, key, nc, cr, h, withSoft) || !stepExists(grid, key, cc, nr, h, withSoft)) continue;
      } else {
        const ka = cr * cols + nc, kb = nr * cols + cc;
        if (cells[ka] !== 1 && !(soft && soft[ka] === 1)) continue;
        if (cells[kb] !== 1 && !(soft && soft[kb] === 1)) continue;
      }
    }
    // the ground at the destination column; ungated base->base, so plain terrain is untouched
    const groundOk = cells[nk] === 1 || (soft !== null && soft[nk] === 1);
    if (groundOk && (!isLevel || Math.abs(h - (heights ? heights[nk] : 0)) <= lv.step)) {
      if (out >= NB_MAX) break;
      NB_KEY[out] = nk; NB_STEP[out] = NB_COST[i]; NB_COL[out] = nc; NB_ROW[out] = nr; out++;
    }
    if (!lv) continue;
    for (let j = lv.head[nk]; j !== -1; j = lv.next[j]) {
      if (lv.cells[j] !== 1) continue;
      if (Math.abs(h - lv.y[j]) > lv.step) continue;   // a level is always gated, from either side
      if (out >= NB_MAX) break;
      NB_KEY[out] = n + j; NB_STEP[out] = NB_COST[i]; NB_COL[out] = nc; NB_ROW[out] = nr; out++;
    }
  }
  return out;
}

// Region labelling + connectivity repair for a grid whose cells/heights/soft arrays the CALLER
// filled in. buildNavGrid is this plus the sampling loop; the split exists so a bake too large to
// run inside one frame can sample incrementally and finalize once (environment-viewer-v2's
// terrain combat-zone grid does exactly that).
export function finalizeNavGrid(grid,
  { connectRegions: doConnect = true, minConnectRegion = 6, slopeCost = null } = {}) {
  if (!grid.carved) grid.carved = [];
  if (!grid.slope) grid.slope = { ...SLOPE_COST_DEFAULTS, ...(slopeCost || {}) };
  labelRegions(grid);
  if (doConnect && grid.soft) connectStrandedRegions(grid, minConnectRegion);
  return grid;
}

// Reconnect walkable pockets that no path can leave, by opening the cheapest chain of SOFT-blocked
// cells between the pocket and the main region. Walls are never opened, so a genuinely sealed room
// stays sealed and its cells stay stranded -- that is a map problem, not something to paper over.
//
// Cost prefers few cells and gentle ground: each opened cell is charged 1 + the height step it adds,
// so the carve crosses a saddle rather than a cliff face. Without that it would happily open the
// steepest cell on the ridge, which the capsule then stalls against -- the slope limit exists for a
// reason, and this only overrides it where the alternative is a bot that can never reach anything.
//
// `grid.carved` records every opened cell so callers can report and draw them: a repaired map should
// be visibly repaired, never silently.
export function connectStrandedRegions(grid, minRegion = 6) {
  const { cells, soft } = grid;
  if (!soft) return grid;
  const n = keyCount(grid);
  const dist = new Float64Array(n);
  const parent = new Int32Array(n);
  // Region IDS are reassigned by every relabel, so a sealed region is remembered by one of its CELLS
  // and its id re-derived each pass. Keying on the id would let a walled-off pocket become eligible
  // again after the next carve and spin the loop.
  const sealedCells = [];
  grid.sealedRegions = [];
  let guard = 0;
  for (;;) {
    if (++guard > 256) break;   // every carve merges >=2 regions, so this cannot legitimately spin
    const main = grid.mainRegion;
    if (main < 0) break;
    const sealedIds = new Set(sealedCells.map(k => grid.regions[k]));
    let target = -1, targetCell = -1;
    for (let k = 0; k < n; k++) {
      const id = grid.regions[k];
      if (id < 0 || id === main || sealedIds.has(id)) continue;
      if (grid.regionSizes[id] >= minRegion) { target = id; targetCell = k; break; }
    }
    if (target < 0) break;   // nothing stranded worth connecting
    const path = cheapestSoftLink(grid, target, dist, parent);
    if (!path) {   // walled off, not merely steep: a map problem, so record it and leave it alone
      // `cell` is a representative index, not an id: ids are reassigned by the next relabel, so this
      // is the only handle that still points at the same pocket once carving continues.
      grid.sealedRegions.push({ cells: grid.regionSizes[target], cell: targetCell });
      sealedCells.push(targetCell);
      continue;
    }
    for (const k of path) { cells[k] = 1; soft[k] = 0; grid.carved.push(k); }
    labelRegions(grid);
  }
  return grid;
}

// Dijkstra out of `fromId` through soft cells only; returns the soft cells to open, or null when the
// pocket cannot be reached without breaking a wall.
function cheapestSoftLink(grid, fromId, dist, parent) {
  const { regions, heights } = grid;
  const total = keyCount(grid);
  dist.fill(Infinity);
  parent.fill(-1);
  const heap = [];
  for (let k = 0; k < total; k++) {
    if (keyWalkable(grid, k) && regions[k] === fromId) { dist[k] = 0; heapPush(heap, k, 0); }
  }
  const settled = new Uint8Array(total);
  while (heap.length) {
    const k = heapPop(heap);
    if (k == null) break;
    if (settled[k]) continue;   // heapPop yields only the key, so staleness is tracked here
    settled[k] = 1;
    const d = dist[k];
    // Reached another region's walkable ground: walk the parents back and collect what to open.
    if (keyWalkable(grid, k) && regions[k] !== fromId && regions[k] >= 0) {
      const out = [];
      for (let p = parent[k]; p !== -1 && !keyWalkable(grid, p); p = parent[p]) out.push(p);
      // Zero carved cells would mean two labelled regions are already connected, which labelRegions
      // rules out -- so this is unreachable rather than a "nothing to do" success.
      return out.length ? out : null;
    }
    // Same corner rule as labelRegions and findPath -- shared, not restated. Without it this would
    // "connect" two regions through a diagonal pinch A* then refuses: a link that reads as fixed
    // and is not. Only levels are never soft, so a deck with no ramp stays sealed rather than carved.
    const m = expandNeighbors(grid, k, true);
    for (let i = 0; i < m; i++) {
      const nk = NB_KEY[i];
      // Opening a cell costs; crossing already-walkable ground is free, so the search hugs the map.
      let step = 0;
      if (!keyWalkable(grid, nk)) {
        const rise = heights ? Math.abs(keyHeight(grid, nk) - keyHeight(grid, k)) : 0;
        step = 1 + rise * 4;   // 4 = how hard a metre of climb is charged against one extra cell
      }
      const nd = d + step;
      if (nd < dist[nk]) { dist[nk] = nd; parent[nk] = k; heapPush(heap, nk, nd); }
    }
  }
  return null;
}

// Connected-component label per cell (-1 = blocked), plus sizes and the index of the largest.
// Two reasons this is baked rather than discovered per search:
//  * A* between two components is the worst case it has -- it exhausts every reachable cell before
//    admitting defeat. A goal handler that re-asks every 300 ms burns that repeatedly, per bot.
//  * A bot whose own region holds none of its goals should pick different goals, not stand still,
//    and it can only know that if reachability is a lookup.
// Uses A*'s own connectivity, corner rule included, so a label can never promise a route the
// search cannot walk.
function labelRegions(grid) {
  const total = keyCount(grid);
  const regions = new Int32Array(total).fill(-1);
  const sizes = [];
  const stack = [];
  for (let s = 0; s < total; s++) {
    if (!keyWalkable(grid, s) || regions[s] >= 0) continue;
    const id = sizes.length;
    let count = 0;
    regions[s] = id;
    stack.push(s);
    while (stack.length > 0) {
      const k = stack.pop();
      count++;
      const m = expandNeighbors(grid, k);
      for (let i = 0; i < m; i++) {
        const nk = NB_KEY[i];
        if (regions[nk] >= 0) continue;
        regions[nk] = id;
        stack.push(nk);
      }
    }
    sizes.push(count);
  }
  let main = -1, best = 0;
  for (let i = 0; i < sizes.length; i++) if (sizes[i] > best) { best = sizes[i]; main = i; }
  grid.regions = regions;
  grid.regionSizes = sizes;
  grid.mainRegion = main;
  return grid;
}

// Region id of the surface nearest (x, z), or -1 if there is none within maxRadius. `y` picks the
// level on a grid that has them; omit it for the ground-level answer.
export function regionAt(grid, x, z, maxRadius = 4, y = null) {
  if (!grid || !grid.regions) return -1;
  if (grid.levels) {
    const k = nearestWalkableKey(grid, x, z, y, maxRadius);
    return k < 0 ? -1 : grid.regions[k];
  }
  const cell = worldToCell(grid, x, z);
  const snapped = nearestWalkable(grid, cell.c, cell.r, maxRadius);
  return snapped ? grid.regions[snapped.r * grid.cols + snapped.c] : -1;
}

// True when a path from `a` to `b` could exist at all. O(1) -- the point is to ask this before
// paying for a search that would otherwise sweep the whole map to return null. `a`/`b` may carry y.
export function reachable(grid, a, b, maxRadius = 4) {
  if (!grid || !grid.regions) return true;
  const ra = regionAt(grid, a.x, a.z, maxRadius, a.y ?? null);
  if (ra < 0) return false;
  return ra === regionAt(grid, b.x, b.z, maxRadius, b.y ?? null);
}

// Per-cell surface cost, on top of slope. Bake one with setNavTravelCost to make searches prefer
// some ground over other ground -- roads over open dirt, say -- without touching walkability.
//
// Costs are clamped to >= 1 on purpose. The A* heuristic below charges one unit per cell, so a
// cost under 1 would make it optimistic and the returned path no longer the cheapest one. Model a
// preferred surface as "everything else is dearer", never as "this is cheaper than walking".
export const NAV_TRAVEL_COST_MAX = 8;

export function setNavTravelCost(grid, costAt) {
  if (!costAt) { grid.travelCost = null; return grid; }
  const cost = new Float32Array(grid.cols * grid.rows);
  const at = { x: 0, z: 0 };
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      cellToWorldInto(grid, c, r, at);
      const v = costAt(at.x, at.z);
      cost[r * grid.cols + c] = !(v >= 1) ? 1 : v > NAV_TRAVEL_COST_MAX ? NAV_TRAVEL_COST_MAX : v;
    }
  }
  grid.travelCost = cost;
  return grid;
}

// Averaged over the step's two cells, so a boundary crossing is charged half in and half out
// rather than jumping the whole way at one cell edge.
function travelFactor(grid, fromKey, toKey) {
  const t = grid.travelCost;
  if (!t) return 1;
  // Surface cost is authored per column, so a level inherits the ground it stands over.
  return (t[keyBase(grid, fromKey)] + t[keyBase(grid, toKey)]) * 0.5;
}

// Multiplier on a step's base cost for the ground it crosses; 1 on a flat or height-less grid.
function slopeFactor(grid, fromKey, toKey, baseCost) {
  const h = grid.heights;
  if (!h) return 1;
  // keyHeight inlined: this runs per neighbour per node, and two calls out measured.
  const n = grid.cols * grid.rows;
  const hf = fromKey < n ? h[fromKey] : grid.levels.y[fromKey - n];
  const ht = toKey < n ? h[toKey] : grid.levels.y[toKey - n];
  const grade = (ht - hf) / (baseCost * grid.cellSize);
  const s = grid.slope;
  const factor = 1 + (grade >= 0 ? s.up * grade : s.down * -grade);
  return factor > s.maxFactor ? s.maxFactor : factor;
}

// Highest a cell along the straight chord a->b stands above the chord's own endpoints. Lets
// smoothPath refuse a shortcut that would climb the very hill the search routed around.
function chordClimb(grid, a, b) {
  const h = grid.heights;
  if (!h) return 0;
  const cell = grid.cellSize;
  let c = Math.floor((a.x - grid.minX) / cell), r = Math.floor((a.z - grid.minZ) / cell);
  const c1 = Math.floor((b.x - grid.minX) / cell), r1 = Math.floor((b.z - grid.minZ) / cell);
  if (!isWalkableCell(grid, c, r) || !isWalkableCell(grid, c1, r1)) return 0;
  const base = Math.max(h[r * grid.cols + c], h[r1 * grid.cols + c1]);
  let worst = 0;
  const dx = b.x - a.x, dz = b.z - a.z;
  const stepC = dx > 0 ? 1 : -1, stepR = dz > 0 ? 1 : -1;
  const tDeltaC = dx !== 0 ? Math.abs(cell / dx) : Infinity;
  const tDeltaR = dz !== 0 ? Math.abs(cell / dz) : Infinity;
  let tMaxC = dx !== 0 ? (grid.minX + (c + (stepC > 0 ? 1 : 0)) * cell - a.x) / dx : Infinity;
  let tMaxR = dz !== 0 ? (grid.minZ + (r + (stepR > 0 ? 1 : 0)) * cell - a.z) / dz : Infinity;
  while (c !== c1 || r !== r1) {
    if (tMaxC < tMaxR) { c += stepC; tMaxC += tDeltaC; } else { r += stepR; tMaxR += tDeltaR; }
    if (!isWalkableCell(grid, c, r)) break;
    const rise = h[r * grid.cols + c] - base;
    if (rise > worst) worst = rise;
  }
  return worst;
}

export function isWalkableCell(grid, c, r) {
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false;
  return grid.cells[r * grid.cols + c] === 1;
}
export function worldToCell(grid, x, z) {
  return worldToCellInto(grid, x, z, { c: 0, r: 0 });
}
export function cellToWorld(grid, c, r) {
  return cellToWorldInto(grid, c, r, { x: 0, z: 0 });
}
// Out-param variants for per-frame hot loops (identical math, no fresh object per call).
export function worldToCellInto(grid, x, z, out) {
  out.c = Math.floor((x - grid.minX) / grid.cellSize);
  out.r = Math.floor((z - grid.minZ) / grid.cellSize);
  return out;
}
export function cellToWorldInto(grid, c, r, out) {
  out.x = grid.minX + (c + 0.5) * grid.cellSize;
  out.z = grid.minZ + (r + 0.5) * grid.cellSize;
  return out;
}

// Spiral search outward for the nearest walkable cell to (c0,r0), up to maxRadius cells -- lets
// a from/to point that lands exactly on a wall-adjacent boundary still resolve to a usable
// start/goal instead of findPath failing outright.
export function nearestWalkable(grid, c0, r0, maxRadius = 4) {
  if (isWalkableCell(grid, c0, r0)) return { c: c0, r: r0 };
  for (let rad = 1; rad <= maxRadius; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue; // ring only, not filled square
        if (isWalkableCell(grid, c0 + dc, r0 + dr)) return { c: c0 + dc, r: r0 + dr };
      }
    }
  }
  return null;
}

const SQRT2 = Math.SQRT2;
// Flat parallel neighbour tables (was an array of [dc,dr,cost] tuples) -- same order, so
// tie-breaking and therefore the emitted paths are bit-identical.
const NB_DC = new Int8Array([1, -1, 0, 0, 1, 1, -1, -1]);
const NB_DR = new Int8Array([0, 0, 1, -1, 1, -1, 1, -1]);
const NB_COST = new Float64Array([1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2]);
const NB_COUNT = 8;

// Module-scratch A* buffers, grown to the largest grid seen and reset by bumping a generation
// counter instead of re-filling (a cell is initialised only while stamp[k] === gen).
let scratchLen = 0;
let scratchStamp = null;
let scratchG = null;
let scratchCame = null;
let scratchClosed = null;
let scratchGen = 0;
function acquireScratch(n) {
  if (scratchLen < n) {
    scratchLen = n;
    scratchStamp = new Int32Array(n);
    scratchG = new Float64Array(n);
    scratchCame = new Int32Array(n);
    scratchClosed = new Uint8Array(n);
    scratchGen = 0; // fresh stamps are 0, so generations must restart above it
  }
  scratchGen++;
  if (scratchGen >= 0x7fffffff) { scratchStamp.fill(0); scratchGen = 1; }
  return scratchGen;
}

// Reused open-set heaps (reset via length = 0); pathfinding here is single-threaded and never
// re-entrant, and neither function retains its heap past return.
const pathHeap = [];
const floodHeap = [];

// Binary min-heap keyed on `f`, with lazy deletion (stale entries skipped on pop).
function heapPush(heap, key, f) {
  heap.push(key, f);
  let i = heap.length / 2 - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p * 2 + 1] <= heap[i * 2 + 1]) break;
    swapNodes(heap, i, p);
    i = p;
  }
}
function heapPop(heap) {
  const n = heap.length / 2;
  const key = heap[0];
  if (n === 1) { heap.length = 0; return key; }
  heap[0] = heap[(n - 1) * 2];
  heap[1] = heap[(n - 1) * 2 + 1];
  heap.length -= 2;
  let i = 0;
  const size = n - 1;
  for (;;) {
    const l = i * 2 + 1, r = l + 1;
    let m = i;
    if (l < size && heap[l * 2 + 1] < heap[m * 2 + 1]) m = l;
    if (r < size && heap[r * 2 + 1] < heap[m * 2 + 1]) m = r;
    if (m === i) break;
    swapNodes(heap, i, m);
    i = m;
  }
  return key;
}
function swapNodes(heap, a, b) {
  const k = heap[a * 2], f = heap[a * 2 + 1];
  heap[a * 2] = heap[b * 2]; heap[a * 2 + 1] = heap[b * 2 + 1];
  heap[b * 2] = k; heap[b * 2 + 1] = f;
}

// Waypoints are {x,z} as they have always been, plus `y` (the surface height) once the grid has a
// level overlay -- an extra property, so a 2D consumer reading .x/.z is unaffected either way.
function waypoint(grid, k) {
  if (!grid.levels) {
    const r = Math.floor(k / grid.cols), c = k % grid.cols;
    return cellToWorld(grid, c, r);
  }
  return keyToWorld(grid, k);
}

function reconstruct(grid, cameFrom, startKey, endKey) {
  const path = [];
  let k = endKey;
  while (k !== startKey) {
    path.push(waypoint(grid, k));
    k = cameFrom[k];
    if (k === -1) return null;
  }
  path.push(waypoint(grid, startKey));
  path.reverse();
  return path;
}

// A* over the grid, 8-connected with diagonal corner-cutting disallowed (both flanking
// orthogonal cells must be open for a diagonal step, so paths don't clip through wall corners).
// `from`/`to` are world {x,z}; returns world-space cell-center waypoints start->goal inclusive,
// or null if no path exists. Deterministic -- no randomness, same inputs always give the same
// path. Binary-heap open set + typed-array scores, so maze-scale grids stay sub-millisecond.
// `from`/`to` may carry `y`; on a grid with levels that picks WHICH surface at the point, and a
// point with no surface within tolerance resolves to nothing rather than the nearest one.
export function findPath(grid, from, to) {
  const startKey = resolveKey(grid, from);
  const goalKey = resolveKey(grid, to);
  if (startKey < 0 || goalKey < 0) return null;

  const cols = grid.cols;
  if (startKey === goalKey) return [waypoint(grid, startKey)];
  // Different components: no route exists, and finding that out the long way means expanding every
  // reachable cell first. This is the whole reason the labels are baked.
  if (grid.regions && grid.regions[startKey] !== grid.regions[goalKey]) return null;

  const gb = keyBase(grid, goalKey);
  const gc = gb % cols, gr = (gb / cols) | 0;
  const gen = acquireScratch(keyCount(grid));
  const stamp = scratchStamp, gScore = scratchG, cameFrom = scratchCame, closed = scratchClosed;
  stamp[startKey] = gen; gScore[startKey] = 0; cameFrom[startKey] = -1; closed[startKey] = 0;
  const heap = pathHeap;
  heap.length = 0;
  const sb = keyBase(grid, startKey);
  heapPush(heap, startKey, Math.hypot((sb % cols) - gc, ((sb / cols) | 0) - gr));

  while (heap.length > 0) {
    const curKey = heapPop(heap);
    if (curKey === goalKey) break;
    if (closed[curKey]) continue; // popped keys are always stamped this generation
    closed[curKey] = 1;
    const curG = gScore[curKey];

    const m = expandNeighbors(grid, curKey);
    for (let k = 0; k < m; k++) {
      const nKey = NB_KEY[k], stepCost = NB_STEP[k];
      const seen = stamp[nKey] === gen; // unseen == gScore Infinity, cameFrom -1, closed 0
      if (seen && closed[nKey]) continue;
      const tentativeG = curG + stepCost * slopeFactor(grid, curKey, nKey, stepCost)
        * travelFactor(grid, curKey, nKey);
      if (!seen || tentativeG < gScore[nKey]) {
        if (!seen) { stamp[nKey] = gen; closed[nKey] = 0; }
        cameFrom[nKey] = curKey;
        gScore[nKey] = tentativeG;
        heapPush(heap, nKey, tentativeG + Math.hypot(NB_COL[k] - gc, NB_ROW[k] - gr));
      }
    }
  }

  if (stamp[goalKey] !== gen) return null; // never reached => gScore was Infinity
  return reconstruct(grid, cameFrom, startKey, goalKey);
}

// A search endpoint -> the key to start/end on, or -1. Without a level overlay this is exactly the
// old worldToCell + nearestWalkable spiral; with one, `y` selects the surface and its absence keeps
// the 2D answer, so a caller that never learned about decks behaves as it always did.
function resolveKey(grid, pt) {
  if (!grid.levels) {
    const p = worldToCell(grid, pt.x, pt.z);
    const hit = nearestWalkable(grid, p.c, p.r);
    return hit ? hit.r * grid.cols + hit.c : -1;
  }
  return nearestWalkableKey(grid, pt.x, pt.z, pt.y ?? null);
}

// Pooled flood buffers: a pooled result is valid only until the next floodFill call -- a caller that
// retains one across frames must pass its own `out` buffer pair instead. Grown, never shrunk.
let floodLen = 0;
let floodDist = null;
let floodParent = null;
let floodBand = null; // cells the last pooled run could have dirtied; cleared on the next entry

// Restores band to Infinity/-1. A bounded run rejects a neighbour outside maxRadius *before* it
// writes dist/parent, so its writes never leave the start's Chebyshev window -- clearing that
// window (not window+1) is enough, and every other cell still reads Infinity/-1.
function clearFloodBand(dist, parent, band) {
  if (!band) return;
  if (band.all) { dist.fill(Infinity); parent.fill(-1); return; }
  for (let r = band.r0; r <= band.r1; r++) {
    const base = r * band.cols;
    for (let c = band.c0; c <= band.c1; c++) { dist[base + c] = Infinity; parent[base + c] = -1; }
  }
}

// Band a run from `start` with this maxRadius may write, clamped to the grid.
function floodBandFor(grid, start, maxRadius) {
  // A (c,r) window cannot describe which OVERLAY keys a run touched, so a level grid clears whole.
  if (!Number.isFinite(maxRadius) || grid.levels) return { all: true };
  const rad = Math.max(0, Math.floor(maxRadius));
  return {
    cols: grid.cols,
    c0: Math.max(0, start.c - rad), c1: Math.min(grid.cols - 1, start.c + rad),
    r0: Math.max(0, start.r - rad), r1: Math.min(grid.rows - 1, start.r + rad),
  };
}

// Bounded Dijkstra from `from`: one pass computes path distance (world metres) and a parent link
// for every reachable cell within `maxRadius` Chebyshev rings of the start. Callers scoring many
// candidate goals (flee/retreat) use this instead of one A* per candidate.
// `out` is an optional caller-owned `{}` the buffers are allocated into once and reused, for callers
// that keep the result past the next floodFill call; omit it to use the shared pool.
export function floodFill(grid, from, { maxRadius = Infinity, out = null } = {}) {
  const startKey = resolveKey(grid, from);
  if (startKey < 0) return null;
  const cols = grid.cols;
  const sb = keyBase(grid, startKey);
  const start = { c: sb % cols, r: (sb / cols) | 0 };
  const n = keyCount(grid);
  let dist, parent;
  if (out) {
    if (!out.dist || out.dist.length < n) {
      out.dist = new Float64Array(n).fill(Infinity);
      out.parent = new Int32Array(n).fill(-1);
      out.band = null;
    } else clearFloodBand(out.dist, out.parent, out.band);
    out.band = floodBandFor(grid, start, maxRadius);
    dist = out.dist; parent = out.parent;
  } else {
    if (floodLen < n) {
      floodLen = n;
      floodDist = new Float64Array(n).fill(Infinity);
      floodParent = new Int32Array(n).fill(-1);
      floodBand = null;
    } else clearFloodBand(floodDist, floodParent, floodBand);
    floodBand = floodBandFor(grid, start, maxRadius);
    dist = floodDist; parent = floodParent;
  }
  dist[startKey] = 0;
  const heap = floodHeap;
  heap.length = 0;
  heapPush(heap, startKey, 0);

  while (heap.length > 0) {
    const popD = heap[1]; // root's f, read before the pop reshuffles the heap
    const curKey = heapPop(heap);
    const curD = dist[curKey];
    if (popD > curD) continue; // stale duplicate: a shorter route already expanded this cell

    const m = expandNeighbors(grid, curKey);
    for (let k = 0; k < m; k++) {
      const nKey = NB_KEY[k], stepCost = NB_STEP[k];
      if (Math.max(Math.abs(NB_COL[k] - start.c), Math.abs(NB_ROW[k] - start.r)) > maxRadius) continue;
      // On a height grid this is effort-metres, not plain metres: callers rank candidates by it.
      const nd = curD + stepCost * grid.cellSize * slopeFactor(grid, curKey, nKey, stepCost)
        * travelFactor(grid, curKey, nKey);
      if (nd < dist[nKey]) {
        parent[nKey] = curKey;
        dist[nKey] = nd;
        heapPush(heap, nKey, nd);
      }
    }
  }

  return { dist, parent, start, startKey };
}

// Waypoint path (start->goal inclusive, findPath-shaped) to cell (c,r) out of a floodFill result,
// or null if the cell was not reached.
export function floodPath(grid, flood, c, r) {
  return floodPathToKey(grid, flood, r * grid.cols + c);
}

// Same, addressed by key rather than column, so a caller ranking candidates on a level grid can
// route to the surface it actually scored instead of the ground beneath it.
export function floodPathToKey(grid, flood, key) {
  if (key < 0 || key >= flood.dist.length || flood.dist[key] === Infinity) return null;
  if (key === flood.startKey) return [waypoint(grid, key)];
  return reconstruct(grid, flood.parent, flood.startKey, key);
}

// True if EVERY cell the straight segment a->b touches is walkable (supercover DDA). Point
// sampling missed short corner-graze chords through blocked cells, letting smoothed paths cut
// wall corners. Exact corner crossings require both flanking cells open, matching findPath's
// no-corner-cutting diagonal rule (errs blocked, the opposite of the vis-field's errs-visible).
export function lineWalkable(grid, a, b) {
  let c = Math.floor((a.x - grid.minX) / grid.cellSize);
  let r = Math.floor((a.z - grid.minZ) / grid.cellSize);
  const c1 = Math.floor((b.x - grid.minX) / grid.cellSize);
  const r1 = Math.floor((b.z - grid.minZ) / grid.cellSize);
  if (!isWalkableCell(grid, c, r)) return false;
  const dx = b.x - a.x, dz = b.z - a.z;
  const stepC = dx > 0 ? 1 : -1, stepR = dz > 0 ? 1 : -1;
  const tDeltaC = dx !== 0 ? Math.abs(grid.cellSize / dx) : Infinity;
  const tDeltaR = dz !== 0 ? Math.abs(grid.cellSize / dz) : Infinity;
  let tMaxC = dx !== 0 ? (grid.minX + (c + (stepC > 0 ? 1 : 0)) * grid.cellSize - a.x) / dx : Infinity;
  let tMaxR = dz !== 0 ? (grid.minZ + (r + (stepR > 0 ? 1 : 0)) * grid.cellSize - a.z) / dz : Infinity;
  while (c !== c1 || r !== r1) {
    const diff = tMaxC - tMaxR;
    if (Math.abs(diff) <= 1e-9) {
      if (!isWalkableCell(grid, c + stepC, r) || !isWalkableCell(grid, c, r + stepR)) return false;
      c += stepC; r += stepR; tMaxC += tDeltaC; tMaxR += tDeltaR;
    } else if (diff < 0) { c += stepC; tMaxC += tDeltaC; }
    else { r += stepR; tMaxR += tDeltaR; }
    if (!isWalkableCell(grid, c, r)) return false;
  }
  return true;
}

// Greedy string-pull: drops waypoints the bot could walk straight through anyway, so movement
// doesn't hug the grid's staircase diagonal pattern. path[0] and the last point always survive;
// interior points only survive when skipping past them isn't walkable — or, on a height grid,
// when the shortcut would climb over the hill the slope-costed search just routed around.
// maxLookahead caps how far the anchor can trail behind i (default Infinity = unbounded, prior behavior), bounding worst-case DDA cell-steps down long open corridors.
export function smoothPath(grid, path, maxLookahead = Infinity) {
  if (!path || path.length <= 2) return path ? path.slice() : [];
  const out = [path[0]];
  let anchorIdx = 0;
  for (let i = 1; i < path.length; i++) {
    if (i === path.length - 1) { out.push(path[i]); continue; }
    // lineWalkable and chordClimb are 2D, so on a level grid a shortcut may only join two waypoints
    // on the SAME surface -- otherwise a string-pull would cut straight off a deck edge.
    const levelChange = grid.levels && path[anchorIdx].y !== undefined
      && Math.abs((path[i + 1].y ?? 0) - (path[anchorIdx].y ?? 0)) > 1e-3;
    if (levelChange || i - anchorIdx >= maxLookahead || !lineWalkable(grid, path[anchorIdx], path[i + 1])
      || chordClimb(grid, path[anchorIdx], path[i + 1]) > (grid.slope?.smoothMaxRise ?? Infinity)) {
      out.push(path[i]);
      anchorIdx = i;
    }
  }
  return out;
}

// Waypoint-advance contract shared by bot capsules and creature bodies: pops every waypoint the
// body has already reached and returns the one to steer at, or null once the path is spent.
// Mutates `path` in place (shift), so the caller's array is the live queue. Options, all optional:
//   relaxRadius  extra reach granted only while `contested` says a neighbor squats the waypoint
//   contested(waypoint, dist) -> bool  crowd predicate; omit and the relax band is never entered
//   canSkipTo(pos, next) -> bool  veto for a relaxed pop that would skip a load-bearing corner
//                                 waypoint; omit for no veto (vacuous when path.length === 1)
export function advancePath(pos, path, reachRadius, opts = {}) {
  if (!path) return null;
  const relaxRadius = opts.relaxRadius || 0;
  const contested = opts.contested || null;
  const canSkipTo = opts.canSkipTo || null;
  while (path.length > 0) {
    const target = path[0];
    const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
    let pop = dist < reachRadius;
    if (!pop && contested && dist < reachRadius + relaxRadius) {
      // Past the base reach a pop is legal only if the leg to the NEXT waypoint is walkable too.
      const skipOk = path.length === 1 || !canSkipTo || canSkipTo(pos, path[1]);
      pop = skipOk && !!contested(target, dist);
    }
    if (!pop) return target;
    path.shift();
  }
  return null;
}
