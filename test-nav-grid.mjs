// Node tests for nav-grid.js (pure walkable-grid + A* pathfinding).
// Run: node test-nav-grid.mjs
import { buildNavGrid, isWalkableCell, worldToCell, findPath, smoothPath } from './nav-grid.js';

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

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('nav-grid: all assertions passed');
