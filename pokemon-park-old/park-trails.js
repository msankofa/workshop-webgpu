// Procedural trail routing across the park: an A* walk over a coarse grid that prefers gentle
// ground and refuses water, turned into control polylines for road-network.addRoadPath.

export const TRAIL_DEFAULTS = Object.freeze({
  cell: 30,             // m per search cell
  maxGrade: 0.55,       // rise over run above which a cell is unwalkable
  gradeWeight: 9,       // how much a grade costs relative to distance
  waterMargin: 1.2,     // m above the waterline a cell must sit to carry a trail
  smoothPasses: 3,
  simplifyM: 14,        // control-point spacing handed to the network
  width: 3.6,
});

function key(ix, iz) { return ix * 100003 + iz; }

/** Min-heap keyed by f-score. */
function heap() {
  const a = [];
  return {
    get size() { return a.length; },
    push(node) {
      a.push(node);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p].f <= a[i].f) break;
        [a[p], a[i]] = [a[i], a[p]]; i = p;
      }
    },
    pop() {
      const top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l].f < a[m].f) m = l;
          if (r < a.length && a[r].f < a[m].f) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]]; i = m;
        }
      }
      return top;
    },
  };
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** A grid the router can ask "may a trail cross here, and what does it cost". */
export function buildTrailGrid({ heightAt, worldX, worldZ, waterLevel = 0, options = {} }) {
  const O = { ...TRAIL_DEFAULTS, ...options };
  const halfX = worldX / 2, halfZ = worldZ / 2;
  const nx = Math.floor(worldX / O.cell), nz = Math.floor(worldZ / O.cell);
  const height = new Float32Array(nx * nz);
  const walkable = new Uint8Array(nx * nz);
  const toWorld = (ix, iz) => ({ x: -halfX + (ix + 0.5) * O.cell, z: -halfZ + (iz + 0.5) * O.cell });
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const p = toWorld(ix, iz);
      const h = heightAt(p.x, p.z);
      height[iz * nx + ix] = h;
      walkable[iz * nx + ix] = h > waterLevel + O.waterMargin ? 1 : 0;
    }
  }
  // A cell on a wall is unwalkable regardless of its own height.
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      if (!walkable[i]) continue;
      let steepest = 0;
      for (const [dx, dz] of NEIGHBOURS) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const run = Math.hypot(dx, dz) * O.cell;
        steepest = Math.max(steepest, Math.abs(height[jz * nx + jx] - height[i]) / run);
      }
      if (steepest > O.maxGrade) walkable[i] = 0;
    }
  }
  const toCell = (x, z) => ({
    ix: Math.max(0, Math.min(nx - 1, Math.floor((x + halfX) / O.cell))),
    iz: Math.max(0, Math.min(nz - 1, Math.floor((z + halfZ) / O.cell))),
  });
  return { nx, nz, cell: O.cell, height, walkable, toWorld, toCell, options: O };
}

/** The nearest walkable cell to a point, so an anchor in the lake still starts a trail. */
export function snapToWalkable(grid, x, z, maxRings = 12) {
  const { ix, iz } = grid.toCell(x, z);
  if (grid.walkable[iz * grid.nx + ix]) return { ix, iz };
  for (let r = 1; r <= maxRings; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= grid.nx || jz >= grid.nz) continue;
        if (grid.walkable[jz * grid.nx + jx]) return { ix: jx, iz: jz };
      }
    }
  }
  return null;
}

/** A* between two world points. Returns world-space cell centres, or null if nothing connects. */
export function routeTrail(grid, from, to) {
  const a = snapToWalkable(grid, from.x, from.z);
  const b = snapToWalkable(grid, to.x, to.z);
  if (!a || !b) return null;
  const { nx, nz, cell, height, walkable } = grid;
  const O = grid.options;
  const goal = b.iz * nx + b.ix;
  const gScore = new Map();
  const cameFrom = new Map();
  const open = heap();
  const hEuclid = (ix, iz) => Math.hypot(ix - b.ix, iz - b.iz) * cell;
  const start = a.iz * nx + a.ix;
  gScore.set(start, 0);
  open.push({ i: start, ix: a.ix, iz: a.iz, f: hEuclid(a.ix, a.iz) });
  const closed = new Set();
  while (open.size) {
    const cur = open.pop();
    if (closed.has(cur.i)) continue;
    closed.add(cur.i);
    if (cur.i === goal) break;
    const g0 = gScore.get(cur.i);
    for (const [dx, dz] of NEIGHBOURS) {
      const jx = cur.ix + dx, jz = cur.iz + dz;
      if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
      const j = jz * nx + jx;
      if (!walkable[j] || closed.has(j)) continue;
      const run = Math.hypot(dx, dz) * cell;
      const grade = Math.abs(height[j] - height[cur.i]) / run;
      const g = g0 + run * (1 + O.gradeWeight * grade * grade);
      if (gScore.has(j) && gScore.get(j) <= g) continue;
      gScore.set(j, g);
      cameFrom.set(j, cur.i);
      open.push({ i: j, ix: jx, iz: jz, f: g + hEuclid(jx, jz) });
    }
  }
  if (!cameFrom.has(goal) && goal !== start) return null;
  const cells = [];
  for (let i = goal; i !== undefined; i = cameFrom.get(i)) {
    cells.push(i);
    if (i === start) break;
  }
  cells.reverse();
  return cells.map((i) => grid.toWorld(i % nx, Math.floor(i / nx)));
}

/** Chaikin-style smoothing, with the ends pinned. */
export function smoothPath(points, passes = 3) {
  let pts = points;
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/** Drop points closer together than `minDist`, keeping both ends. */
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

/**
 * Route every leg, returning `{paths, skipped}`. `legs` is a list of `{from, to, width?}` in
 * world coordinates; a leg whose ends do not connect is reported rather than dropped silently.
 */
export function buildTrails({ grid, legs, options = {} }) {
  const O = { ...TRAIL_DEFAULTS, ...grid.options, ...options };
  const paths = [];
  const skipped = [];
  for (const leg of legs) {
    const cells = routeTrail(grid, leg.from, leg.to);
    if (!cells || cells.length < 2) { skipped.push(leg.name || `${leg.from.x},${leg.from.z}`); continue; }
    const pts = thinPath(smoothPath(cells, O.smoothPasses), O.simplifyM);
    if (pts.length < 2) { skipped.push(leg.name || 'short'); continue; }
    paths.push({ name: leg.name || '', width: leg.width || O.width, points: pts });
  }
  return { paths, skipped };
}

/** The park's own trail plan: a spine from the gate to the peak, plus spurs. */
export function parkTrailLegs(terrain) {
  const H = terrain.worldX / 2;
  const at = (fx, fz) => ({ x: fx * H, z: fz * H });
  const gate = at(terrain.townPad.x, terrain.townPad.z);
  const lakeHead = at(terrain.lake.x - terrain.lake.radius * 1.2, terrain.lake.z);
  const lakeFoot = at(terrain.lake.x + terrain.lake.radius * 0.2, terrain.lake.z + terrain.lake.radius * 1.15);
  const tarn = at(terrain.tarn.x + terrain.tarn.radius * 1.7, terrain.tarn.z);
  const saddle = at(terrain.peak.x * 0.66, terrain.peak.z * 0.66);
  return [
    { name: 'gate to the lake', from: gate, to: lakeHead, width: 4.2 },
    { name: 'lake shore', from: lakeHead, to: lakeFoot, width: 3.2 },
    { name: 'lake to the tarn', from: lakeHead, to: tarn, width: 3.4 },
    { name: 'tarn to the saddle', from: tarn, to: saddle, width: 2.8 },
    { name: 'east meadow', from: gate, to: at(0.86, -0.12), width: 3.2 },
    { name: 'south wood', from: gate, to: at(-0.72, 0.86), width: 3.0 },
    { name: 'west loop', from: lakeFoot, to: at(-0.84, 0.1), width: 2.8 },
  ];
}
