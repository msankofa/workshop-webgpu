# Lens: nav modules (nav-grid / nav-visibility / nav-corners) — model: sonnet

Scope: `nav-grid.js`, `nav-visibility.js`, `nav-corners.js`, read in full. Call-site
frequency established by grepping `bot-viewer.html` for every exported symbol. Only
findings whose cost scales with bot count or per-frame/per-event call frequency are
included; the one-time `buildNavGrid` / `buildVisibilityField` / `buildCornerMap` bake
at map load (`bot-viewer.html:2416-2423`) is excluded on purpose — it runs once per
layout load, not per bot.

## Finding: `findPath` allocates and fills three full-grid typed arrays on every call

**File:** `nav-grid.js`, lines 126-129 (function starts line 114)
```js
  const n = cols * grid.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
```
Every `findPath` call allocates and initializes three arrays sized to the **entire
grid**, regardless of how close start and goal are or how short the resulting path is.
At the default `NAV_CELL = 0.5` (`bot-viewer.html:2154`) on a modest 60×60m map that's
120×120 = 14,400 cells → ~187 KB allocated and two full-array `.fill()` passes touched
*before* any A* work starts.

**Scaling:** cost is O(map cells) per call, and call frequency scales with bot count —
`findPath` is reached through `requestPath` (`bot-viewer.html:2747-2756`), which is
called from patrol re-path (`2991`, `2717`), pursuit (`3258`), knife approach (`3278`),
pack-seek (`3350`), and once per candidate cell inside the muzzle-recovery ring search
(`2865`, see next finding) and the investigation goal search (`3117`/`3174`). With N
bots each triggering several of these per second, the constant per-call allocation
dominates.

**Severity at 100 bots:** high — this is the single most-called expensive primitive in
the module, and every call pays full-map cost independent of path length.

**Fix sketch:** keep pooled/reused scratch `Float64Array`/`Int32Array`/`Uint8Array`
buffers on the grid object (sized once at `buildNavGrid` time) and reset only the
touched cells via a generation counter or an explicit "touched list," instead of a
fresh allocation + full `.fill()` per call.

## Finding: `floodFill` ignores `maxRadius` when sizing/filling its working arrays

**File:** `nav-grid.js`, lines 170-172 (function starts line 166)
```js
  const cols = grid.cols, n = cols * grid.rows;
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
```
`floodFill` accepts a `maxRadius` option that bounds the actual Dijkstra expansion
(line 185: `if (Math.max(Math.abs(nc - start.c), ...) > maxRadius) continue;`), but the
`dist`/`parent` buffers are still allocated and `.fill()`ed for the **whole grid** every
call, not just the bounding box implied by `maxRadius`.

**Scaling:** O(map cells) per call regardless of how small `maxRadius` is. Called once
per bot flee-goal search (`findFleeGoal`, `bot-viewer.html:3299`, `maxSearchRadius`
typically 5-10 cells — a tiny fraction of the grid) and once per medic ally search
(`bot-viewer.html:3529`, throttled by `MEDIC_NAV_FLOOD_MS` so lower frequency). A
firefight in which several wounded bots start fleeing in the same frame multiplies this
full-grid cost by the number of simultaneous flee episodes.

**Severity at 100 bots:** medium-high — bounded conceptually by `maxRadius` but the
implementation doesn't actually exploit that bound for its allocation, so the fix in
finding 1 (pooled buffers) is doubly valuable here, or size the arrays to a bounding box
around `start` sized `2*maxRadius+1` when `maxRadius` is finite.

**Fix sketch:** when `maxRadius` is finite, allocate/index a local `(2*maxRadius+1)^2`
window instead of the full grid; otherwise share the pooled full-grid buffers from
finding 1.

## Finding: `smoothPath` re-tests from a fixed anchor, O(pathLength²) worst case on long straight paths

**File:** `nav-grid.js`, lines 243-255
```js
export function smoothPath(grid, path) {
  if (!path || path.length <= 2) return path ? path.slice() : [];
  const out = [path[0]];
  let anchorIdx = 0;
  for (let i = 1; i < path.length; i++) {
    if (i === path.length - 1) { out.push(path[i]); continue; }
    if (!lineWalkable(grid, path[anchorIdx], path[i + 1])) {
      out.push(path[i]);
      anchorIdx = i;
    }
  }
  return out;
}
```
`anchorIdx` only advances when a `lineWalkable` trace *fails*. Down a long open
corridor (every cell mutually visible, the common case A* produces on open floor) the
anchor never advances, so each loop iteration calls `lineWalkable(path[0], path[i+1])`
— a DDA trace whose length grows with `i`. Total DDA cell-steps summed over the loop is
O(1+2+...+n) = O(n²) for an n-waypoint straight path, not O(n).

**Scaling:** O(pathLength²) per call, and `smoothPath` runs on every successful
`findPath` result via `requestPath` (`bot-viewer.html:2751`) and `findClosestReachableGoal`
(`bot-viewer.html:3120`) — i.e. on essentially every path a bot requests. More bots
means more path requests means more of these quadratic passes; longer open maps make
each individual pass worse.

**Severity at 100 bots:** medium (map-layout dependent — degrades further on maps with
long unobstructed sightlines/corridors).

**Fix sketch:** binary-search the farthest visible point from the anchor instead of
linear-scanning forward one waypoint at a time, or cap the anchor-to-candidate distance
tested per step.

## Finding: `NEIGHBORS` array-of-arrays with destructuring iteration in the A*/Dijkstra inner loop

**File:** `nav-grid.js`, line 142 (`findPath`) and line 183 (`floodFill`); `NEIGHBORS`
defined lines 52-55
```js
const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];
...
    for (const [dc, dr, cost] of NEIGHBORS) {
```
Both hot loops iterate `NEIGHBORS` — an array of 3-element arrays — via `for...of` with
array destructuring, for every popped node. This pays iterator-protocol + destructure
overhead 8 times per node expansion, on the hottest inner loop of both search
functions.

**Scaling:** multiplies by (nodes expanded) × 8, and nodes-expanded scales with search
size (which grows when start/goal are far apart, or — worst case — when goal is
unreachable and the whole reachable region gets visited). Search frequency scales with
bot count via the same `findPath`/`floodFill` call sites as findings 1-2.

**Severity at 100 bots:** low-medium — a real but smaller constant-factor tax on top of
findings 1-2, most visible on large open searches (unreachable goals, long paths).

**Fix sketch:** replace with flat parallel `Int8Array`s (`NEIGHBOR_DC`, `NEIGHBOR_DR`,
`NEIGHBOR_COST`) indexed by a plain `for (let k = 0; k < 8; k++)` loop.

## Finding: `findMuzzleRecoveryCell` runs a full `findPath` per candidate ring cell instead of one bounded search

**File:** `bot-viewer.html`, lines 2851-2870 (function starts 2841); calls into
`nav-grid.js` `findPath`/`smoothPath` via `requestPath`
```js
  for (let radius = 1; radius <= BOT_RECOVERY_CELL_RADIUS; radius++) {
    const ring = []; // Favor the nearest ring: this is a short firing adjustment, not a flank.
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
        ...
        const path = requestPath(bot, candidate);
        if (path.length === 0) continue;
        const score = pathDistance(start, path);
        ring.push({ ...candidate, c, r, key, path, score, muzzle });
      }
    }
```
`requestPath` is a full `findPath` (+ `smoothPath`) call — see finding 1, each one
allocates/fills full-grid arrays. This loop calls it for **every walkable candidate
cell in the ring**, not just the eventually-chosen one. With `BOT_RECOVERY_CELL_RADIUS
= 2` (`bot-viewer.html:1963`), worst case is up to 8 (radius 1) + 16 (radius 2) = 24
candidate cells, each paying a full A* search, in a single call.

**Scaling:** O(ring cells × full-grid A*) per call. `findMuzzleRecoveryCell` fires via
`beginMuzzleRecovery` (`bot-viewer.html:2943`) any time a bot's blocked-shot streak
crosses `BOT_BLOCKED_SHOT_THRESHOLD = 2` (`bot-viewer.html:1962`) — a routine event for
any bot firing from partial cover, i.e. common in any real firefight. Bot-count scaling
is direct: N bots simultaneously stuck behind partial cover in the same firefight each
trigger up to 24 full A* searches in the same frame window.

**Severity at 100 bots:** high — this is `findFleeGoal`'s "old shape" problem (the
comment at `bot-viewer.html:3298` explicitly notes flee used to do this and was fixed
to use one `floodFill` instead) reintroduced for muzzle recovery.

**Fix sketch:** replace the per-candidate `requestPath` calls with one bounded
`floodFill` from the bot's position (as `findFleeGoal` already does), then score/filter
ring candidates from the flood's `dist`/`parent` result and call `floodPath` only once,
on the winning cell.

## Finding: `followPath` computes the same `lineWalkable` trace twice in one call

**File:** `bot-viewer.html`, lines 2702 and 2712-2713 (function starts 2692)
```js
    const relaxedPopOk = path.length === 1 || !navGrid || lineWalkable(navGrid, p, path[1]);
    ...
    if (navGrid && !ownBlocked && !lineWalkable(navGrid, p, target)) {
      if (path.length > 1 && lineWalkable(navGrid, p, path[1])) { path.shift(); continue; }
```
When `path.length > 1`, line 2702 already computes `lineWalkable(navGrid, p, path[1])`
to decide `relaxedPopOk`. If the bot then falls into the "target line blocked" branch,
line 2713 recomputes the exact same `lineWalkable(navGrid, p, path[1])` call — same
grid, same two points — redoing the whole DDA trace (`nav-grid.js:216-238`) a second
time.

**Scaling:** doubles the DDA-trace cost of that branch, and `followPath` is the shared
movement-stepping function called once per bot per frame across essentially every
bot movement state (patrol `3013`, pursue `3262`, knife `3282`, pack-seek `3356`, flee
`3384`, cover-related states `3454`/`3653`/`3708`, dummy roam `1823`). The blocked-line
branch is hit whenever a bot's straight line to its next waypoint clips a wall corner —
common near doorways/corners, which is exactly where corridor maps concentrate bots.

**Severity at 100 bots:** medium — small per-occurrence cost (one extra DDA trace, a
few cell-steps typically) but paid every frame by every bot currently navigating near a
corner.

**Fix sketch:** compute `lineWalkable(navGrid, p, path[1])` once into a local and reuse
it at both call sites instead of recomputing.

## Finding: `reachableInvestigationCells` reimplements flood-fill with a slower, unbounded structure

**File:** `bot-viewer.html`, lines 2778-2803
```js
function reachableInvestigationCells(start) {
  const startCell = nearestWalkableNavCell(worldToCell(navGrid, start.x, start.z));
  if (!startCell) return [];
  const cells = [];
  const visited = new Set([navCellKey(startCell.c, startCell.r)]);
  const queue = [startCell];
  ...
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    cells.push(current);
    for (const [dc, dr] of neighbors) {
      const c = current.c + dc, r = current.r + dr;
      const key = navCellKey(c, r);
      if (visited.has(key) || !isWalkableCell(navGrid, c, r)) continue;
      ...
      visited.add(key);
      queue.push({ c, r });
    }
  }
  return cells;
}
```
This hand-rolled BFS duplicates what `nav-grid.js`'s `floodFill` already does (same
8-connected, no-corner-cutting rule — the comment at line 2784 even says "Match
nav-grid.js"), but uses a `Set<string>` keyed on template-string cell keys
(`navCellKey`, `` `${c},${r}` ``) instead of `floodFill`'s typed-array
`Int32Array`/`Float64Array` bookkeeping, and — unlike `findFleeGoal`'s bounded
`floodFill(..., {maxRadius})` — has **no radius bound**: it walks every reachable
walkable cell on the whole map.

**Scaling:** O(all reachable walkable cells), each with a string allocation +
hash-set insert, vs. `floodFill`'s O(reachable cells within maxRadius) with typed-array
writes. Runs once per `beginInvestigation` call (`bot-viewer.html:3104`), which fires
whenever a bot loses sight of its target and enters seek/investigate — a routine,
frequent event in any multi-bot firefight (every bot that breaks LOS re-triggers it).

**Severity at 100 bots:** medium-high on large open maps (more reachable cells, more
string-keyed Set churn); scales with both bot count (more simultaneous investigations)
and map openness.

**Fix sketch:** call `nav-grid.js`'s `floodFill` (with a generous but finite
`maxRadius`, or unbounded if truly needed) and iterate its typed-array result instead
of the bespoke `Set`/string-key BFS.

## Finding: `orderInvestigationFrontier` scores every reachable cell (unbounded) on each ranking pass

**File:** `bot-viewer.html`, lines 3123-3153; call sites lines 3112 and 3194
```js
function orderInvestigationFrontier(investigation) {
  const pending = [];
  const anchorIdx = visField && investigation.anchor ? cellIndexAt(navGrid, investigation.anchor.x, investigation.anchor.z) : -1;
  for (const cell of investigation.cells) {
    ...
    const point = cellToWorld(navGrid, cell.c, cell.r);
    ...
    if (anchorIdx !== -1 && visField.canSee(cellIdxOf(cell.c, cell.r), anchorIdx)) alignment += INVESTIGATE_LOS_BONUS;
    pending.push({ ...cell, key, ring, alignment, distanceSq });
  }
  pending.sort((a, b) => ...);
```
`investigation.cells` is the full unbounded output of `reachableInvestigationCells`
(previous finding), so this does a `cellToWorld` + `canSee` + object-spread allocation
for **every reachable cell on the map**, then sorts the entire list — even though
`chooseNextInvestigationCell` (line 3155-3165) only ever consumes a handful of cells
near the front before the expanding-radius gate (`investigationCellIsWithinRegion`)
stops it. This full pass runs twice per investigation episode: once at
`beginInvestigation` (line 3112) and again from `updateInvestigationPreferenceAfterFlee`
(line 3194) whenever a flee interrupts a search.

**Scaling:** O(all reachable cells × log(cells)) for the sort, per investigation start
and per flee-interrupt-during-investigation, i.e. scales with both bot count (more
concurrent investigations) and map size.

**Severity at 100 bots:** medium — same root cause as the previous finding
(`investigation.cells` being unbounded); fixing that finding's radius bound shrinks
this one proportionally.

**Fix sketch:** bound `reachableInvestigationCells` (or its replacement `floodFill`
call) by the investigation's max search radius up front, so this scoring/sort pass
only ever processes cells that could actually be reached before
`chooseNextInvestigationCell` would gate them out anyway.

## Finding: hot-path nav-grid helpers allocate a fresh object on every call

**File:** `nav-grid.js`, lines 28-33 (`worldToCell`, `cellToWorld`) and 38-49
(`nearestWalkable`)
```js
export function worldToCell(grid, x, z) {
  return { c: Math.floor((x - grid.minX) / grid.cellSize), r: Math.floor((z - grid.minZ) / grid.cellSize) };
}
export function cellToWorld(grid, c, r) {
  return { x: grid.minX + (c + 0.5) * grid.cellSize, z: grid.minZ + (r + 0.5) * grid.cellSize };
}
```
```js
export function nearestWalkable(grid, c0, r0, maxRadius = 4) {
  if (isWalkableCell(grid, c0, r0)) return { c: c0, r: r0 };
  for (let rad = 1; rad <= maxRadius; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
        if (isWalkableCell(grid, c0 + dc, r0 + dr)) return { c: c0 + dc, r: r0 + dr };
      }
    }
  }
  return null;
}
```
Every call to `worldToCell`/`cellToWorld` allocates a new plain object; `nearestWalkable`
allocates one too (and is itself called twice — start and goal — inside every single
`findPath`/`floodFill` call). These are the module's most-used primitives: grepping
`bot-viewer.html` turns up 30+ call sites, including inside per-frame hot loops —
`navBlockedAhead` (`bot-viewer.html:2742-2746`, called from `followPath`'s separation
steering every frame per moving bot), the muzzle-recovery ring scan
(`bot-viewer.html:2861`, up to 24 calls per invocation per finding 5), the flee-goal
candidate scan (`bot-viewer.html:3315`, up to `(2·maxSearchRadius+1)²` calls per flee
episode), and `reachableInvestigationCells`'s BFS (`bot-viewer.html:2778-2803`, one
call per visited cell).

**Scaling:** each call is O(1) work but O(1) *garbage* too; multiplied across N bots ×
several hot-path call sites per frame, this becomes thousands of short-lived object
allocations per frame, adding GC pressure/pause risk on top of the CPU cost already
counted in the other findings.

**Severity at 100 bots:** medium — not a hot-loop CPU bottleneck by itself, but a
steady tax that compounds with every other finding in this doc since nearly all of them
route through these helpers.

**Fix sketch:** add out-parameter variants (`worldToCellInto(grid, x, z, out)`) for the
identified hot-path call sites, or return packed integers (`r * cols + c`) instead of
`{c, r}` objects where callers only need the cell key.
