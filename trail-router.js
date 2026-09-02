// Pure trail routing over a bounded terrain grid. This is shared by the old Pokemon Park and
// Base Game's streamed world planner; it deliberately has no THREE dependency.

export const TRAIL_DEFAULTS = Object.freeze({
  cell: 30,
  maxGrade: 0.55,
  crossSlope: null,
  gradeWeight: 9,
  waterMargin: 1.2,
  smoothPasses: 3,
  simplifyM: 14,
  width: 3.6,
});

const NEIGHBOURS = Object.freeze([
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
]);

function createIndexHeap(fScore) {
  const items = [];
  return {
    get size() { return items.length; },
    push(index) {
      items.push(index);
      let i = items.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (fScore[items[p]] <= fScore[items[i]]) break;
        [items[p], items[i]] = [items[i], items[p]];
        i = p;
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length) {
        items[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < items.length && fScore[items[l]] < fScore[items[m]]) m = l;
          if (r < items.length && fScore[items[r]] < fScore[items[m]]) m = r;
          if (m === i) break;
          [items[m], items[i]] = [items[i], items[m]];
          i = m;
        }
      }
      return top;
    },
  };
}

function slopeAt(height, nx, nz, cell, ix, iz) {
  const i = iz * nx + ix;
  const l = height[iz * nx + Math.max(0, ix - 1)];
  const r = height[iz * nx + Math.min(nx - 1, ix + 1)];
  const u = height[Math.max(0, iz - 1) * nx + ix];
  const d = height[Math.min(nz - 1, iz + 1) * nx + ix];
  const spanX = (ix > 0 && ix < nx - 1) ? 2 * cell : cell;
  const spanZ = (iz > 0 && iz < nz - 1) ? 2 * cell : cell;
  return [(r - l) / spanX, (d - u) / spanZ, i];
}

function finishGrid({ nx, nz, cell, height, walkable, toWorld, toCell, options, originX, originZ }) {
  const slopeX = new Float32Array(nx * nz);
  const slopeZ = new Float32Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const [sx, sz, i] = slopeAt(height, nx, nz, cell, ix, iz);
    slopeX[i] = sx;
    slopeZ[i] = sz;
  }

  // Preserve the park router's conservative single-steepest-neighbour rule unless callers opt
  // into direction-aware cross-slope checks.
  if (options.crossSlope == null) {
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      if (!walkable[i]) continue;
      let steepest = 0;
      for (const [dx, dz] of NEIGHBOURS) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const run = Math.hypot(dx, dz) * cell;
        steepest = Math.max(steepest, Math.abs(height[jz * nx + jx] - height[i]) / run);
      }
      if (steepest > options.maxGrade) walkable[i] = 0;
    }
  }

  return { nx, nz, cell, height, walkable, slopeX, slopeZ, toWorld, toCell, options, originX, originZ };
}

/** Build a router grid over a world-sized rectangle centred on the origin. */
export function buildTrailGrid({ heightAt, worldX, worldZ, waterLevel = 0, options = {} }) {
  if (typeof heightAt !== 'function') throw new TypeError('trail grid needs heightAt(x, z)');
  const O = { ...TRAIL_DEFAULTS, ...options };
  const halfX = worldX / 2, halfZ = worldZ / 2;
  const nx = Math.max(1, Math.floor(worldX / O.cell));
  const nz = Math.max(1, Math.floor(worldZ / O.cell));
  const height = new Float32Array(nx * nz);
  const walkable = new Uint8Array(nx * nz);
  const toWorld = (ix, iz) => ({ x: -halfX + (ix + 0.5) * O.cell, z: -halfZ + (iz + 0.5) * O.cell });
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const p = toWorld(ix, iz);
    const h = heightAt(p.x, p.z);
    const i = iz * nx + ix;
    height[i] = h;
    walkable[i] = Number.isFinite(h) && h > waterLevel + O.waterMargin ? 1 : 0;
  }
  const toCell = (x, z) => ({
    ix: Math.max(0, Math.min(nx - 1, Math.floor((x + halfX) / O.cell))),
    iz: Math.max(0, Math.min(nz - 1, Math.floor((z + halfZ) / O.cell))),
  });
  return finishGrid({ nx, nz, cell: O.cell, height, walkable, toWorld, toCell, options: O,
    originX: -halfX + O.cell * 0.5, originZ: -halfZ + O.cell * 0.5 });
}

function boundsValues(bounds) {
  const minX = bounds.minX ?? bounds.xMin ?? Math.min(bounds.from?.x ?? 0, bounds.to?.x ?? 0);
  const maxX = bounds.maxX ?? bounds.xMax ?? Math.max(bounds.from?.x ?? 0, bounds.to?.x ?? 0);
  const minZ = bounds.minZ ?? bounds.zMin ?? Math.min(bounds.from?.z ?? 0, bounds.to?.z ?? 0);
  const maxZ = bounds.maxZ ?? bounds.zMax ?? Math.max(bounds.from?.z ?? 0, bounds.to?.z ?? 0);
  if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) throw new TypeError('trail grid bounds must be finite');
  return { minX: Math.min(minX, maxX), maxX: Math.max(minX, maxX), minZ: Math.min(minZ, maxZ), maxZ: Math.max(minZ, maxZ) };
}

/** Cut a bounded routing grid from a streamed field window. Returns null until every post exists. */
export function gridFromWindow(window, bounds, options = {}) {
  if (!window || typeof window.sampleAt !== 'function') throw new TypeError('gridFromWindow needs a field window');
  const O = { ...TRAIL_DEFAULTS, cell: window.post ?? TRAIL_DEFAULTS.cell, ...options };
  const b = boundsValues(bounds);
  const margin = Math.max(0, options.margin ?? O.cell * 4);
  const originX = Math.floor((b.minX - margin) / O.cell) * O.cell;
  const originZ = Math.floor((b.minZ - margin) / O.cell) * O.cell;
  const endX = Math.ceil((b.maxX + margin) / O.cell) * O.cell;
  const endZ = Math.ceil((b.maxZ + margin) / O.cell) * O.cell;
  const nx = Math.max(2, Math.round((endX - originX) / O.cell) + 1);
  const nz = Math.max(2, Math.round((endZ - originZ) / O.cell) + 1);
  const height = new Float32Array(nx * nz);
  const walkable = new Uint8Array(nx * nz);
  const toWorld = (ix, iz) => ({ x: originX + ix * O.cell, z: originZ + iz * O.cell });
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const p = toWorld(ix, iz);
    const h = window.sampleAt('heights', p.x, p.z);
    const nav = window.sampleAt('planWalk', p.x, p.z);
    if (h == null || nav == null) return null;
    const i = iz * nx + ix;
    height[i] = h;
    walkable[i] = nav > 0 ? 1 : 0;
  }
  const toCell = (x, z) => ({
    ix: Math.max(0, Math.min(nx - 1, Math.round((x - originX) / O.cell))),
    iz: Math.max(0, Math.min(nz - 1, Math.round((z - originZ) / O.cell))),
  });
  return finishGrid({ nx, nz, cell: O.cell, height, walkable, toWorld, toCell, options: O, originX, originZ });
}

/** Nearest walkable cell to a point, allowing anchors to be nudged off water or rock. */
export function snapToWalkable(grid, x, z, maxRings = 12) {
  const { ix, iz } = grid.toCell(x, z);
  if (grid.walkable[iz * grid.nx + ix]) return { ix, iz };
  for (let r = 1; r <= maxRings; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const jx = ix + dx, jz = iz + dz;
    if (jx < 0 || jz < 0 || jx >= grid.nx || jz >= grid.nz) continue;
    if (grid.walkable[jz * grid.nx + jx]) return { ix: jx, iz: jz };
  }
  return null;
}

function moveAllowed(grid, fromIndex, toIndex, dx, dz, run) {
  const grade = Math.abs(grid.height[toIndex] - grid.height[fromIndex]) / run;
  if (grade > grid.options.maxGrade) return false;
  const limit = grid.options.crossSlope;
  if (limit == null) return true;
  const inv = 1 / Math.hypot(dx, dz);
  const acrossX = -dz * inv, acrossZ = dx * inv;
  const sx = (grid.slopeX[fromIndex] + grid.slopeX[toIndex]) * 0.5;
  const sz = (grid.slopeZ[fromIndex] + grid.slopeZ[toIndex]) * 0.5;
  return Math.abs(sx * acrossX + sz * acrossZ) <= limit;
}

/** Typed-array A* between two world points. */
export function routeTrail(grid, from, to) {
  const a = snapToWalkable(grid, from.x, from.z);
  const b = snapToWalkable(grid, to.x, to.z);
  if (!a || !b) return null;
  const { nx, nz, cell, height, walkable } = grid;
  const count = nx * nz;
  const start = a.iz * nx + a.ix;
  const goal = b.iz * nx + b.ix;
  const gScore = new Float64Array(count); gScore.fill(Infinity);
  const fScore = new Float64Array(count); fScore.fill(Infinity);
  const cameFrom = new Int32Array(count); cameFrom.fill(-1);
  const closed = new Uint8Array(count);
  const open = createIndexHeap(fScore);
  const heuristic = (ix, iz) => Math.hypot(ix - b.ix, iz - b.iz) * cell;
  gScore[start] = 0;
  fScore[start] = heuristic(a.ix, a.iz);
  open.push(start);

  while (open.size) {
    const current = open.pop();
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goal) break;
    const ix = current % nx, iz = Math.floor(current / nx);
    for (const [dx, dz] of NEIGHBOURS) {
      const jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
      const j = jz * nx + jx;
      if (!walkable[j] || closed[j]) continue;
      // Do not cut diagonally through two blocked cardinal cells.
      if (dx && dz && (!walkable[iz * nx + jx] || !walkable[jz * nx + ix])) continue;
      const run = Math.hypot(dx, dz) * cell;
      if (!moveAllowed(grid, current, j, dx, dz, run)) continue;
      const grade = Math.abs(height[j] - height[current]) / run;
      const mul = grid.costMul ? Math.max(0.001, Number(grid.costMul[j]) || 1) : 1;
      const candidate = gScore[current] + run * (1 + grid.options.gradeWeight * grade * grade) * mul;
      if (candidate >= gScore[j]) continue;
      cameFrom[j] = current;
      gScore[j] = candidate;
      fScore[j] = candidate + heuristic(jx, jz);
      open.push(j);
    }
  }
  if (goal !== start && cameFrom[goal] < 0) return null;
  const cells = [];
  for (let i = goal; i >= 0; i = cameFrom[i]) {
    cells.push(i);
    if (i === start) break;
  }
  cells.reverse();
  return cells.map(i => grid.toWorld(i % nx, Math.floor(i / nx)));
}

/** Chaikin smoothing with optional validation. Invalid generated points stay at the source point. */
export function smoothPath(points, passes = 3, walkable = null) {
  let pts = points;
  for (let pass = 0; pass < passes; pass++) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const q = { x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 };
      const r = { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 };
      out.push(!walkable || walkable(q.x, q.z) ? q : { ...a });
      out.push(!walkable || walkable(r.x, r.z) ? r : { ...b });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

export function thinPath(points, minDist) {
  if (points.length < 3) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(points[i].x - last.x, points[i].z - last.z) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function buildTrails({ grid, legs, options = {} }) {
  const O = { ...TRAIL_DEFAULTS, ...grid.options, ...options };
  const isWalkable = (x, z) => {
    const { ix, iz } = grid.toCell(x, z);
    return grid.walkable[iz * grid.nx + ix] > 0;
  };
  const paths = [], skipped = [];
  for (const leg of legs) {
    const cells = routeTrail(grid, leg.from, leg.to);
    if (!cells || cells.length < 2) { skipped.push(leg.name || `${leg.from.x},${leg.from.z}`); continue; }
    const pts = thinPath(smoothPath(cells, O.smoothPasses, isWalkable), O.simplifyM);
    if (pts.length < 2) { skipped.push(leg.name || 'short'); continue; }
    paths.push({ name: leg.name || '', width: leg.width || O.width, points: pts });
  }
  return { paths, skipped };
}
