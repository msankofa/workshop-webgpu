// Node tests for nav-grid.js (pure walkable-grid + A* pathfinding).
// Run: node test-nav-grid.mjs
import { buildNavGrid, finalizeNavGrid, isWalkableCell, worldToCell, findPath, smoothPath, floodFill, regionAt, reachable } from './nav-grid.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

const BOUNDS = { minX: 0, maxX: 20, minZ: 0, maxZ: 10 };
const CELL = 1;

// A vertical wall column at x in [10,11) blocking all z except a doorway gap at z in [8,9).
function wallWithHighDoorway(x, z) {
  if (x >= 10 && x < 11) return z >= 8 && z < 9;
  return true;
}
const grid = buildNavGrid(wallWithHighDoorway, BOUNDS, CELL);

ok(grid.cols === 20 && grid.rows === 10, `grid dimensions match bounds/cellSize (got ${grid.cols}x${grid.rows})`);

// wall cells blocked, doorway cell open
{
  const wallCell = worldToCell(grid, 10.5, 3);
  ok(!isWalkableCell(grid, wallCell.c, wallCell.r), 'wall column cell is blocked');
  const doorCell = worldToCell(grid, 10.5, 8.5);
  ok(isWalkableCell(grid, doorCell.c, doorCell.r), 'doorway gap cell is walkable');
}

// path from left room to right room, both near the bottom (z=2), doorway is near the top
// (z=8) -- forces the path to detour up and back down, not go straight across.
{
  const path = findPath(grid, { x: 2, z: 2 }, { x: 18, z: 2 });
  ok(Array.isArray(path) && path.length > 0, 'path found across the wall via the doorway');
  ok(path[0].x === 2.5 && path[0].z === 2.5, `path starts at the start cell center (got ${JSON.stringify(path[0])})`);
  ok(path[path.length - 1].x === 18.5 && path[path.length - 1].z === 2.5, 'path ends at the goal cell center');
  // every waypoint must be on a walkable cell
  ok(path.every(p => { const c = worldToCell(grid, p.x, p.z); return isWalkableCell(grid, c.c, c.r); }),
    'every path waypoint sits on a walkable cell');
  // must actually pass near the doorway (z close to 8.5) at some point, not go straight through the wall
  ok(path.some(p => Math.abs(p.z - 8.5) < 1.5 && Math.abs(p.x - 10.5) < 2),
    'path routes through the doorway region, not straight across the wall');
}

// unreachable goal: a fully enclosed pocket with no gap returns null
{
  function enclosedPocket(x, z) {
    // A 3x3 pocket at x in [14,17), z in [4,7) walled off on all sides, no door.
    const inPocketRing = x >= 13 && x < 18 && z >= 3 && z < 8 && !(x >= 14 && x < 17 && z >= 4 && z < 7);
    if (inPocketRing) return false; // the ring itself is solid wall
    return true;
  }
  const g2 = buildNavGrid(enclosedPocket, BOUNDS, CELL);
  const path = findPath(g2, { x: 2, z: 2 }, { x: 15.5, z: 5.5 });
  ok(path === null, 'unreachable goal (fully enclosed pocket) returns null');
}

// start/goal exactly on a blocked cell still resolves via nearest-walkable snapping
{
  const path = findPath(grid, { x: 10.5, z: 3 }, { x: 2, z: 2 }); // 10.5,3 is inside the wall column
  ok(Array.isArray(path) && path.length > 0, 'a start point on a blocked cell still finds a path via snapping');
}

// determinism: same inputs -> identical path every time
{
  const a = findPath(grid, { x: 2, z: 2 }, { x: 18, z: 2 });
  const b = findPath(grid, { x: 2, z: 2 }, { x: 18, z: 2 });
  ok(JSON.stringify(a) === JSON.stringify(b), 'findPath is deterministic given identical inputs');
}

// smoothPath: reduces waypoint count (or stays equal) and every point stays walkable/reachable
{
  const raw = findPath(grid, { x: 2, z: 2 }, { x: 18, z: 2 });
  const smooth = smoothPath(grid, raw);
  ok(smooth.length <= raw.length, `smoothPath does not increase waypoint count (raw=${raw.length}, smooth=${smooth.length})`);
  ok(smooth.length >= 2, 'smoothPath keeps at least start and end');
  ok(smooth[0].x === raw[0].x && smooth[0].z === raw[0].z, 'smoothPath keeps the original start point');
  const last = smooth[smooth.length - 1], rawLast = raw[raw.length - 1];
  ok(last.x === rawLast.x && last.z === rawLast.z, 'smoothPath keeps the original end point');
}

// smoothPath on a trivial 2-point (already-adjacent) path is a no-op
{
  const trivial = [{ x: 1, z: 1 }, { x: 2, z: 1 }];
  const smooth = smoothPath(grid, trivial);
  ok(smooth.length === 2, 'smoothPath leaves a 2-point path unchanged');
}

// start === goal cell: single-point path
{
  const path = findPath(grid, { x: 2.1, z: 2.1 }, { x: 2.4, z: 2.4 });
  ok(Array.isArray(path) && path.length === 1, 'start and goal in the same cell yields a single-point path');
}

// ---- slope costing: a height grid makes searches route around hills, not over them ----
{
  const bounds = { minX: 0, maxX: 40, minZ: 0, maxZ: 24 };
  // One steep dome straddling the direct line; everything is walkable, so only cost can divert a path.
  const domeH = (x, z) => {
    const d = Math.hypot(x - 20, z - 12);
    return d >= 7 ? 0 : 5 * (1 + Math.cos((d / 7) * Math.PI)) / 2;
  };
  const flat = buildNavGrid(() => true, bounds, 1);
  const hilly = buildNavGrid(() => true, bounds, 1, { heightAt: domeH });

  ok(flat.heights === null, 'a grid built without heightAt carries no height array');
  ok(hilly.heights instanceof Float32Array && hilly.heights.length === hilly.cols * hilly.rows,
    'heightAt populates a per-cell height array');

  const from = { x: 2.5, z: 12.5 }, to = { x: 37.5, z: 12.5 };
  const flatPath = findPath(flat, from, to);
  const hillyPath = findPath(hilly, from, to);
  const peakOf = (path) => Math.max(...path.map(p => domeH(p.x, p.z)));
  const walked = (path) => path.reduce((sum, p, i) => sum + (i ? Math.hypot(p.x - path[i - 1].x, p.z - path[i - 1].z) : 0), 0);
  ok(peakOf(flatPath) > 4, `flat-cost path drives straight over the summit (peak ${peakOf(flatPath).toFixed(2)} m)`);
  ok(peakOf(hillyPath) < 1, `slope-costed path stays off the dome (peak ${peakOf(hillyPath).toFixed(2)} m)`);
  ok(walked(hillyPath) > walked(flatPath), 'going around is a longer walk, as expected');

  // ... and the string-pull must not undo it by shortcutting straight back over the summit.
  const smoothed = smoothPath(hilly, hillyPath);
  ok(Math.max(...smoothed.map(p => domeH(p.x, p.z))) < 1, 'smoothPath keeps the detour off the summit');
  ok(smoothed.length < hillyPath.length, 'smoothPath still removes redundant waypoints');

  const gentle = buildNavGrid(() => true, bounds, 1, { heightAt: domeH, slopeCost: { up: 0, down: 0 } });
  ok(peakOf(findPath(gentle, from, to)) > 4, 'zeroed slope weights reproduce the flat-cost route');

  // A flat height grid must not perturb anything: same route as no heights at all.
  const level = buildNavGrid(() => true, bounds, 1, { heightAt: () => 2 });
  const levelPath = findPath(level, from, to);
  ok(levelPath.length === flatPath.length && levelPath.every((p, i) => p.x === flatPath[i].x && p.z === flatPath[i].z),
    'a constant-height grid produces the identical path to a height-less one');
}

// ---- floodFill charges slope too, so flee/goal scoring ranks uphill escapes as costlier ----
{
  const bounds = { minX: 0, maxX: 30, minZ: 0, maxZ: 10 };
  const ramp = buildNavGrid(() => true, bounds, 1, { heightAt: (x) => x * 0.3 });
  const flood = floodFill(ramp, { x: 15.5, z: 5.5 });
  const at = (c, r) => flood.dist[r * ramp.cols + c];
  ok(at(25, 5) > at(5, 5), 'uphill cells cost more than downhill cells at the same distance');
  const flat = floodFill(buildNavGrid(() => true, bounds, 1), { x: 15.5, z: 5.5 });
  ok(Math.abs(flat.dist[5 * 30 + 25] - 10) < 1e-9, 'a height-less grid still measures plain metres');
}

// ---- pooled flood buffers: a bounded run must leave no trace outside its own window ----
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 10 };
  const open = buildNavGrid(() => true, bounds, 1);
  // Cheapest 8-connected cost between two cells on a flat open grid.
  const ideal = (dc, dr) => {
    const a = Math.abs(dc), b = Math.abs(dr);
    return Math.SQRT2 * Math.min(a, b) + (Math.max(a, b) - Math.min(a, b));
  };
  const R = 2;
  const a = floodFill(open, { x: 2.5, z: 2.5 }, { maxRadius: R });
  ok(Math.abs(a.dist[2 * open.cols + 4] - ideal(2, 0)) < 1e-9, 'bounded flood measures cells inside its window');
  const b = floodFill(open, { x: 15.5, z: 7.5 }, { maxRadius: R });
  // Every cell the first flood wrote must read as untouched to the second one.
  let leaked = 0;
  for (let r = 0; r <= 4; r++) {
    for (let c = 0; c <= 4; c++) {
      if (b.dist[r * open.cols + c] !== Infinity || b.parent[r * open.cols + c] !== -1) leaked++;
    }
  }
  ok(leaked === 0, `a later flood sees no leftovers from the previous one (${leaked} stale cells)`);
  ok(Math.abs(b.dist[7 * open.cols + 13] - ideal(2, 0)) < 1e-9, 'the second bounded flood is itself correct');
  ok(b.parent[7 * open.cols + 14] === 7 * open.cols + 15, 'parent links point back toward the second start');
  // An unbounded run then wipes the whole buffer, not just a window.
  floodFill(open, { x: 10.5, z: 5.5 }, {});
  const c2 = floodFill(open, { x: 1.5, z: 1.5 }, { maxRadius: 1 });
  let wide = 0;
  for (let k = 0; k < open.cols * open.rows; k++) if (c2.dist[k] !== Infinity) wide++;
  ok(wide === 9, `after an unbounded run a radius-1 flood still reports only its 9 cells (got ${wide})`);
}

// ---- the `out` buffer pair survives intervening pooled floods (medics hold results across frames) ----
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 10 };
  const open = buildNavGrid(() => true, bounds, 1);
  const buf = {};
  const held = floodFill(open, { x: 4.5, z: 4.5 }, { maxRadius: 3, out: buf });
  ok(held.dist === buf.dist && buf.dist.length === open.cols * open.rows, 'out buffers are allocated into the caller object');
  const before = Array.from(held.dist);
  floodFill(open, { x: 4.5, z: 4.5 }, { maxRadius: 3 });        // same window, pooled
  floodFill(open, { x: 16.5, z: 8.5 }, { maxRadius: 3 });       // ... and elsewhere
  ok(before.every((d, k) => d === held.dist[k]), 'a retained out-flood is untouched by later pooled floods');
  ok(Math.abs(held.dist[4 * open.cols + 7] - 3) < 1e-9, 'the retained flood still measures its own distances');
  // Reusing the same buffers clears the previous run's window rather than reallocating.
  const dist0 = buf.dist;
  const again = floodFill(open, { x: 15.5, z: 5.5 }, { maxRadius: 2, out: buf });
  ok(again.dist === dist0, 'a second out-flood reuses the already-allocated buffers');
  let stale = 0;
  for (let r = 1; r <= 7; r++) for (let c = 1; c <= 7; c++) if (again.dist[r * open.cols + c] !== Infinity) stale++;
  ok(stale === 0, `reusing an out buffer clears the earlier window (${stale} stale cells)`);
}

// ---- connected-component labels: reachability as a lookup, not as a failed search ----
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 10 };
  // Two rooms with no door between them.
  const split = buildNavGrid((x) => x < 9 || x > 11, bounds, 1);
  ok(split.regionSizes.length === 2, `a walled-off map should label 2 regions, got ${split.regionSizes.length}`);
  const left = { x: 2.5, z: 5.5 }, right = { x: 17.5, z: 5.5 };
  ok(regionAt(split, left.x, left.z) !== regionAt(split, right.x, right.z), 'the two rooms carry different labels');
  ok(!reachable(split, left, right), 'reachable() sees through the wall');
  ok(findPath(split, left, right) === null, 'findPath refuses a cross-region route');
  // ... and the label must never promise a route the search cannot walk.
  const open = buildNavGrid(() => true, bounds, 1);
  ok(open.regionSizes.length === 1 && open.mainRegion === 0, 'an open map is one region');
  ok(reachable(open, left, right) && findPath(open, left, right), 'an open map stays fully reachable');

  // Diagonal-only contact is not connectivity: A* refuses to cut that corner, so the labels must too.
  const pinch = buildNavGrid((x, z) => {
    const c = Math.floor(x), r = Math.floor(z);
    return (c <= 4 && r <= 4) || (c >= 5 && r >= 5);
  }, { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 1);
  ok(pinch.regionSizes.length === 2, `two blocks touching at a corner must stay 2 regions, got ${pinch.regionSizes.length}`);
  ok(findPath(pinch, { x: 1.5, z: 1.5 }, { x: 8.5, z: 8.5 }) === null, 'no route through a diagonal pinch');

  // The point of baking them: the answer arrives without expanding the whole component.
  const big = buildNavGrid((x) => x < 99 || x > 101, { minX: 0, maxX: 200, minZ: 0, maxZ: 200 }, 1);
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) findPath(big, { x: 5.5, z: 5.5 }, { x: 195.5, z: 195.5 });
  const perCall = (performance.now() - t0) / 50;
  ok(perCall < 0.05, `an unreachable-goal search should be a lookup, took ${perCall.toFixed(3)} ms`);
}

// finalizeNavGrid: the same grid, whether the sampling loop ran inside buildNavGrid or the caller
// filled the arrays itself across several frames (environment-viewer-v2's terrain zone bake).
{
  const bounds = { minX: 0, maxX: 16, minZ: 0, maxZ: 16 };
  const cell = 1;
  const height = (x, z) => Math.sin(x * 0.4) * 2 + Math.cos(z * 0.3) * 1.5;
  const steep = (x, z) => Math.abs(height(x + cell, z) - height(x, z)) >= 1.2;
  const walk = (x, z) => !(x >= 7 && x < 9) && !steep(x, z);
  const soft = (x, z) => !(x >= 7 && x < 9) && steep(x, z);
  const built = buildNavGrid(walk, bounds, cell, { heightAt: height, softBlockedTest: soft });

  const cols = 16, rows = 16;
  const manual = { cols, rows, cellSize: cell, minX: 0, minZ: 0,
    cells: new Uint8Array(cols * rows), heights: new Float32Array(cols * rows), soft: new Uint8Array(cols * rows) };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cell, z = (r + 0.5) * cell, k = r * cols + c;
      const okCell = walk(x, z);
      manual.cells[k] = okCell ? 1 : 0;
      if (!okCell) manual.soft[k] = soft(x, z) ? 1 : 0;
      manual.heights[k] = height(x, z);
    }
  }
  finalizeNavGrid(manual);
  ok(manual.cells.every((v, i) => v === built.cells[i]), 'finalizeNavGrid: carving matches buildNavGrid');
  ok(manual.mainRegion === built.mainRegion && manual.regionSizes.length === built.regionSizes.length,
    'finalizeNavGrid: region labels match buildNavGrid');
  ok(manual.carved.length === built.carved.length, 'finalizeNavGrid: same cells carved');
  ok(manual.slope && manual.slope.up > 0, 'finalizeNavGrid: fills in slope-cost defaults');
  const a = findPath(manual, { x: 1.5, z: 1.5 }, { x: 14.5, z: 14.5 });
  const b = findPath(built, { x: 1.5, z: 1.5 }, { x: 14.5, z: 14.5 });
  ok(JSON.stringify(a) === JSON.stringify(b), 'finalizeNavGrid: identical paths out of both grids');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('nav-grid: all assertions passed');
