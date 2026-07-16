// nav-grid.js — pure, THREE-free 2D walkable grid + A* pathfinding for indoor bot navigation.
// Node-tested in test-nav-grid.mjs. See docs/superpowers/specs/2026-07-13-combat-bot-fsm-design.md
// ("Nav grid"). Consumed by bot-viewer.html's patrol/seek movement; the FSM in bot-activity.js
// never touches grid cells directly, only the waypoint queue this produces.

// Builds a walkable/blocked grid over `bounds` ({minX,maxX,minZ,maxZ}) at `cellSize` resolution,
// sampling `walkableTest(x, z) -> boolean` at each cell center. One grid per loaded map, built
// once and cached by the caller -- not regenerated per bot or per frame.
export function buildNavGrid(walkableTest, bounds, cellSize) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const cells = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * cellSize;
      const z = minZ + (r + 0.5) * cellSize;
      cells[r * cols + c] = walkableTest(x, z) ? 1 : 0;
    }
  }
  return { cols, rows, cellSize, minX, minZ, cells };
}

export function isWalkableCell(grid, c, r) {
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false;
  return grid.cells[r * grid.cols + c] === 1;
}
export function worldToCell(grid, x, z) {
  return { c: Math.floor((x - grid.minX) / grid.cellSize), r: Math.floor((z - grid.minZ) / grid.cellSize) };
}
export function cellToWorld(grid, c, r) {
  return { x: grid.minX + (c + 0.5) * grid.cellSize, z: grid.minZ + (r + 0.5) * grid.cellSize };
}

// Spiral search outward for the nearest walkable cell to (c0,r0), up to maxRadius cells -- lets
// a from/to point that lands exactly on a wall-adjacent boundary still resolve to a usable
// start/goal instead of findPath failing outright.
function nearestWalkable(grid, c0, r0, maxRadius = 4) {
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
const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

// A* over the grid, 8-connected with diagonal corner-cutting disallowed (both flanking
// orthogonal cells must be open for a diagonal step, so paths don't clip through wall corners).
// `from`/`to` are world {x,z}; returns world-space cell-center waypoints start->goal inclusive,
// or null if no path exists. Deterministic -- no randomness, same inputs always give the same
// path. Not heap-optimized (linear scan of the open set); fine at harness/room-scale grids.
export function findPath(grid, from, to) {
  const f0 = worldToCell(grid, from.x, from.z);
  const t0 = worldToCell(grid, to.x, to.z);
  const start = nearestWalkable(grid, f0.c, f0.r);
  const goal = nearestWalkable(grid, t0.c, t0.r);
  if (!start || !goal) return null;

  const startKey = start.r * grid.cols + start.c;
  const goalKey = goal.r * grid.cols + goal.c;
  if (startKey === goalKey) return [cellToWorld(grid, start.c, start.r)];

  const open = new Map();
  const cameFrom = new Map();
  const gScore = new Map([[startKey, 0]]);
  const heuristic = (c, r) => Math.hypot(c - goal.c, r - goal.r);
  open.set(startKey, { c: start.c, r: start.r, f: heuristic(start.c, start.r) });
  const closed = new Set();

  while (open.size > 0) {
    let curKey = null, cur = null;
    for (const [k, v] of open) { if (cur === null || v.f < cur.f) { cur = v; curKey = k; } }
    open.delete(curKey);
    if (curKey === goalKey) break;
    closed.add(curKey);

    for (const [dc, dr, cost] of NEIGHBORS) {
      const nc = cur.c + dc, nr = cur.r + dr;
      if (!isWalkableCell(grid, nc, nr)) continue;
      if (dc !== 0 && dr !== 0) {
        if (!isWalkableCell(grid, cur.c + dc, cur.r) || !isWalkableCell(grid, cur.c, cur.r + dr)) continue;
      }
      const nKey = nr * grid.cols + nc;
      if (closed.has(nKey)) continue;
      const tentativeG = (gScore.get(curKey) ?? 0) + cost;
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, curKey);
        gScore.set(nKey, tentativeG);
        open.set(nKey, { c: nc, r: nr, f: tentativeG + heuristic(nc, nr) });
      }
    }
  }

  if (!gScore.has(goalKey)) return null;
  const path = [];
  let k = goalKey;
  while (k !== startKey) {
    const r = Math.floor(k / grid.cols), c = k % grid.cols;
    path.push(cellToWorld(grid, c, r));
    const prev = cameFrom.get(k);
    if (prev === undefined) return null;
    k = prev;
  }
  path.push(cellToWorld(grid, start.c, start.r));
  path.reverse();
  return path;
}

// True if every point sampled along the straight segment a->b lands on a walkable cell.
function lineWalkable(grid, a, b) {
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(dist / (grid.cellSize * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const { c, r } = worldToCell(grid, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (!isWalkableCell(grid, c, r)) return false;
  }
  return true;
}

// Greedy string-pull: drops waypoints the bot could walk straight through anyway, so movement
// doesn't hug the grid's staircase diagonal pattern. path[0] and the last point always survive;
// interior points only survive when skipping past them isn't walkable.
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
