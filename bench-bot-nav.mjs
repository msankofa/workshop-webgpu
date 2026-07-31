// node bench-bot-nav.mjs [--json] [--rugged] [--blockers]
// Sizing benchmark for the Phase D open-terrain nav decision: what does a PERSISTENT nav grid
// (plus its lazy visibility field and corner/crest map) cost at environment-viewer map scales,
// versus the per-request local windows environment-viewer-v2 builds on terrain today?
//
// The synthetic ground is deliberately env-shaped: rolling sine hills over a continental tilt, a
// water level, and a scattered rock/trunk field, so walkable fraction, region fragmentation and
// crest counts land in the same ballpark as a real procedural map. `--rugged` switches to a
// higher-relief profile that actually produces terrain crest cover.
//
// The per-cell walkability PREDICATE is timed separately from module work: in the real viewer that
// predicate also runs a cached capsule-vs-BVH sweep this process cannot, and keeping the two apart
// is what makes these numbers transferable to the browser.
import { performance } from 'node:perf_hooks';
import { buildNavGrid, findPath, floodFill, isWalkableCell } from './nav-grid.js';
import { buildSightGrid, buildLazyVisibilityField, buildVisibilityField, cellIndexAt } from './nav-visibility.js';
import { buildCornerMap } from './nav-corners.js';

const JSON_OUT = process.argv.includes('--json');
const RUGGED = process.argv.includes('--rugged');
const BLOCKER_SWEEP = process.argv.includes('--blockers');
const CREST_SWEEP = process.argv.includes('--crest');

// --- synthetic environment ------------------------------------------------------------------
const WATER = -1.2;
const SLOPE_TOL_PER_M = 0.6;   // metres of rise per metre of run before a cell reads too steep

// rolling: broad valleys, gentle brows (a calm procedural map).
// rugged: same skeleton with short-wavelength relief on top — brows tall enough to hide a 1.6 m eye.
function heightAt(x, z) {
  const base = Math.sin(x * 0.013) * 9 + Math.cos(z * 0.011) * 7
    + Math.sin((x + z) * 0.031) * 3.2 + Math.cos((x - z * 0.7) * 0.062) * 1.4
    + Math.sin(x * 0.0031) * Math.cos(z * 0.0027) * 22;
  if (!RUGGED) return base;
  return base + Math.sin(x * 0.11) * Math.cos(z * 0.09) * 2.2 + Math.sin((x * 0.7 + z) * 0.05) * 1.8;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 0.02 obstacles/m^2 ~= a moderately treed/rocky procedural map (forest-placement's mid densities).
function scatterObstacles(bounds, density = 0.02) {
  const rand = mulberry32(0x5eed);
  const w = bounds.maxX - bounds.minX, d = bounds.maxZ - bounds.minZ;
  const n = Math.round(w * d * density);
  const pts = new Float64Array(n * 2);
  const size = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pts[i * 2] = bounds.minX + rand() * w;
    pts[i * 2 + 1] = bounds.minZ + rand() * d;
    // ~85% thin trunks, ~15% boulder/structure-sized footprints.
    size[i] = rand() < 0.85 ? 0.7 + rand() * 0.6 : 2.2 + rand() * 3.5;
  }
  const cell = 8;
  const cols = Math.ceil(w / cell), rows = Math.ceil(d / cell);
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const c = Math.min(cols - 1, Math.floor((pts[i * 2] - bounds.minX) / cell));
    const r = Math.min(rows - 1, Math.floor((pts[i * 2 + 1] - bounds.minZ) / cell));
    const k = r * cols + c;
    let b = buckets.get(k);
    if (!b) { b = []; buckets.set(k, b); }
    b.push(i);
  }
  return {
    count: n,
    blocked(x, z, radius) {
      const c = Math.floor((x - bounds.minX) / cell), r = Math.floor((z - bounds.minZ) / cell);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const b = buckets.get((r + dr) * cols + (c + dc));
          if (!b) continue;
          for (const i of b) {
            const dx = pts[i * 2] - x, dz = pts[i * 2 + 1] - z;
            const rr = radius + size[i] * 0.5;
            if (dx * dx + dz * dz <= rr * rr) return true;
          }
        }
      }
      return false;
    },
    // Sight-blocker rects, biggest first — mirrors the "footprint >= nav cell, capped" rule the
    // viewer applies when it derives blockers from the rock/dressing/structure indices.
    rects(minSize, limit) {
      const idx = [];
      for (let i = 0; i < n; i++) if (size[i] >= minSize) idx.push(i);
      idx.sort((a, b) => size[b] - size[a]);
      const out = [];
      for (let k = 0; k < idx.length && out.length < limit; k++) {
        const i = idx[k];
        out.push({ x: pts[i * 2], z: pts[i * 2 + 1], w: size[i], d: size[i], h: 3.5 });
      }
      return out;
    },
  };
}

function makePredicates(cellSize, obstacles) {
  const steep = (x, z) => {
    const h = heightAt(x, z);
    const dhx = Math.abs(heightAt(x + cellSize, z) - h);
    const dhz = Math.abs(heightAt(x, z + cellSize) - h);
    return Math.max(dhx, dhz) >= SLOPE_TOL_PER_M * cellSize;
  };
  const walkable = (x, z) => {
    const h = heightAt(x, z);
    if (h <= WATER + 0.15) return false;
    if (steep(x, z)) return false;
    if (obstacles.blocked(x, z, 0.3)) return false;
    return true;
  };
  // Soft = too steep but still continuous ground: connectStrandedRegions may carve these, walls never.
  const softBlocked = (x, z) => heightAt(x, z) > WATER + 0.15 && steep(x, z);
  return { walkable, softBlocked };
}

// --- measurement helpers --------------------------------------------------------------------
function once(fn) { const t = performance.now(); const v = fn(); return { ms: performance.now() - t, v }; }
// Median of `n` timed runs after one warmup — the query/path numbers are small enough that a single
// cold run measures the JIT, not the code.
function med(fn, n = 5) {
  fn();
  const xs = [];
  let v;
  for (let i = 0; i < n; i++) { const t = performance.now(); v = fn(); xs.push(performance.now() - t); }
  xs.sort((a, b) => a - b);
  return { ms: xs[xs.length >> 1], v };
}
function mb(bytes) { return bytes / (1024 * 1024); }
function fmt(n, d = 1) { return n == null ? '-' : n.toFixed(d); }
function gridBytes(grid) {
  return grid.cells.byteLength + (grid.heights?.byteLength || 0) + (grid.soft?.byteLength || 0)
    + (grid.regions?.byteLength || 0);
}

// --- one configuration ----------------------------------------------------------------------
function runCase(span, cellSize, { blockerLimit = 1200, eagerLimit = 4000, corners = true,
  crestSpanM = 2, crestFarM = 12, crestMinRise = 0.6 } = {}) {
  const half = span / 2;
  const bounds = { minX: -half, maxX: half, minZ: -half, maxZ: half };
  const obstacles = scatterObstacles(bounds);
  const { walkable, softBlocked } = makePredicates(cellSize, obstacles);
  const cols = Math.ceil(span / cellSize);
  const cellCount = cols * cols;

  const sampleN = Math.min(cellCount, 20000);
  const tPred = performance.now();
  for (let i = 0; i < sampleN; i++) {
    const c = i % cols, r = (i / cols) | 0;
    walkable(bounds.minX + (c + 0.5) * cellSize, bounds.minZ + (r + 0.5) * cellSize);
  }
  const predUs = ((performance.now() - tPred) / sampleN) * 1000;

  const built = once(() => buildNavGrid(walkable, bounds, cellSize, { heightAt, softBlockedTest: softBlocked }));
  const grid = built.v;
  let walkableCount = 0;
  for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i]) walkableCount++;

  // Blockers big enough to actually mark a sight cell (buildSightGrid needs cell-CENTER coverage),
  // capped: thin trunks generate corner records without occluding anything at these pitches.
  const sightRects = obstacles.rects(Math.max(1.2, cellSize), blockerLimit);
  const sg = once(() => buildSightGrid(grid, sightRects));
  const lazy = once(() => buildLazyVisibilityField(grid, sg.v, { terrain: { heights: grid.heights } }));
  const field = lazy.v;

  let threatIdx = -1;
  for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i]) { threatIdx = i; break; }
  const centreIdx = Math.max(0, cellIndexAt(grid, 0, 0));
  const c0 = centreIdx % cols, r0 = (centreIdx / cols) | 0;
  // Flee/hide scan: (2R+1)^2 candidates, all against ONE threat cell — the hot vis consumer.
  const R = 20;
  const fleeQ = med(() => {
    let hits = 0;
    for (let dr = -R; dr <= R; dr++) {
      for (let dc = -R; dc <= R; dc++) {
        const c = c0 + dc, r = r0 + dr;
        if (!isWalkableCell(grid, c, r)) continue;
        if (field.canSee(threatIdx, r * cols + c)) hits++;
      }
    }
    return hits;
  }, 3);
  const rowQ = once(() => field.rowFor(threatIdx));   // cold: the cache is per-cell, one build each

  const path = med(() => findPath(grid, { x: -half * 0.8, z: -half * 0.8 }, { x: half * 0.8, z: half * 0.8 }));
  const flood = med(() => floodFill(grid, { x: 0, z: 0 }, { maxRadius: 40 }));

  let cornerMs = 0, cornerCount = 0, crestCount = 0, crestCapped = false;
  if (corners) {
    const perM = 1 / cellSize;
    const cm = once(() => buildCornerMap(grid, sightRects, field, {
      heights: grid.heights,
      crest: {
        minRise: crestMinRise, maxSpan: Math.max(1, Math.round(crestSpanM * perM)),
        farCells: Math.max(2, Math.round(crestFarM * perM)),
        spacingCells: Math.max(1, Math.round(4 * perM)), stride: cols > 220 ? 2 : 1,
      },
    }));
    cornerMs = cm.ms;
    cornerCount = cm.v.corners.length;
    crestCount = cm.v.corners.reduce((n, x) => n + (x.kind === 'crest' ? 1 : 0), 0);
    crestCapped = cm.v.crestCapped;
  }

  const eagerBytes = walkableCount * Math.ceil(walkableCount / 32) * 4;
  const eagerMs = walkableCount <= eagerLimit ? once(() => buildVisibilityField(grid, sg.v, { terrain: { heights: grid.heights } })).ms : null;
  const lazyRowBytes = field.wordsPerRow * 4;

  return {
    span, cellSize, cols, cellCount, walkableCount,
    walkablePct: (walkableCount / cellCount) * 100,
    predUs,
    buildMs: built.ms,
    buildModuleMs: Math.max(0, built.ms - (predUs * cellCount) / 1000),
    gridMB: mb(gridBytes(grid)),
    carved: grid.carved.length,
    sealed: (grid.sealedRegions || []).length,
    regions: grid.regionSizes ? grid.regionSizes.length : 0,
    sightRects: sightRects.length,
    sightMs: sg.ms,
    lazyMs: lazy.ms,
    lazyRowKB: lazyRowBytes / 1024,
    lazyCache64MB: mb(lazyRowBytes * 64),
    fleeScanMs: fleeQ.ms,
    rowForMs: rowQ.ms,
    pathMs: path.ms,
    floodMs: flood.ms,
    cornerMs, cornerCount, crestCount, crestCapped,
    eagerMB: mb(eagerBytes),
    eagerMs,
  };
}

// Today's terrain regime: one throwaway grid per path request, no cover, no danger, no regions.
function runLocalWindow(radius = 18, cellSize = 1.5) {
  const bounds = { minX: -radius, maxX: radius, minZ: -radius, maxZ: radius };
  const obstacles = scatterObstacles({ minX: -600, maxX: 600, minZ: -600, maxZ: 600 });
  const { walkable } = makePredicates(cellSize, obstacles);
  const r = med(() => {
    const grid = buildNavGrid(walkable, bounds, cellSize);
    return findPath(grid, { x: 0, z: 0 }, { x: radius - cellSize, z: radius - cellSize });
  }, 9);
  const cols = Math.ceil((radius * 2) / cellSize);
  return { cells: cols * cols, ms: r.ms };
}

// --- report -----------------------------------------------------------------------------------
const CASES = [
  [64, 0.5], [128, 0.5],                            // shoot-house scale reference
  [128, 1.5], [256, 1.5], [384, 1.5], [512, 1.5],   // combat-zone candidates at the local pitch
  [256, 1.0], [256, 2.0], [512, 2.0], [512, 3.0],
  [1024, 2.0], [1024, 3.0],
  [1200, 1.5],                                      // "whole small map at the local pitch"
];

const rows = CASES.map(([span, cell]) => runCase(span, cell));
const local = runLocalWindow();

if (JSON_OUT) {
  console.log(JSON.stringify({ profile: RUGGED ? 'rugged' : 'rolling', local, rows }, null, 2));
} else {
  const head = ['span', 'cell', 'cells', 'walk', 'walk%', 'rgn', 'carv', 'pred us', 'build ms', 'mod ms',
    'grid MB', 'rects', 'lazy ms', 'row KB', 'cache MB', 'flee ms', 'rowFor ms', 'A* ms', 'flood ms',
    'corner ms', 'corners', 'crest', 'EAGER MB'];
  const body = rows.map(r => [
    `${r.span}`, `${r.cellSize}`, `${r.cellCount}`, `${r.walkableCount}`, fmt(r.walkablePct, 0),
    `${r.regions}`, `${r.carved}`, fmt(r.predUs, 2), fmt(r.buildMs, 0), fmt(r.buildModuleMs, 0),
    fmt(r.gridMB, 1), `${r.sightRects}`, fmt(r.lazyMs, 1), fmt(r.lazyRowKB, 1), fmt(r.lazyCache64MB, 1),
    fmt(r.fleeScanMs, 2), fmt(r.rowForMs, 1), fmt(r.pathMs, 2), fmt(r.floodMs, 2),
    fmt(r.cornerMs, 0), `${r.cornerCount}`, `${r.crestCount}${r.crestCapped ? '*' : ''}`, fmt(r.eagerMB, 0),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  const line = cells => cells.map((v, i) => v.padStart(widths[i])).join('  ');
  console.log(`\nbench-bot-nav — persistent nav grid cost at env-viewer map scales [${RUGGED ? 'rugged' : 'rolling'} terrain]`);
  console.log(line(head));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const b of body) console.log(line(b));
  console.log(`\n  local window today: ${local.cells} cells, ${fmt(local.ms, 2)} ms per PATH REQUEST (rebuilt every time)`);
  console.log('  pred us = per-cell walkability predicate (synthetic; the viewer adds a cached');
  console.log('            capsule-vs-BVH sweep on top). mod ms = build ms minus predicate time.');
  console.log('  cache MB = worst case for the lazy field\'s 64-row FIFO cache. rgn/carv = nav regions / carved cells.');
  console.log('  EAGER MB = what buildVisibilityField would cost (walkableCount^2 bits) — the wall.');
  console.log('  * = crest record cap hit (terrain cover truncated).\n');
  for (const r of rows) {
    if (r.eagerMs != null) console.log(`  eager vis bake @${r.span}m/${r.cellSize}m: ${fmt(r.eagerMs, 0)} ms, ${fmt(r.eagerMB, 1)} MB for ${r.walkableCount} walkable cells`);
  }
  if (BLOCKER_SWEEP) {
    console.log('\n  sight-blocker cap sweep @384 m / 1.5 m cell:');
    for (const limit of [200, 600, 1200, 2400, 6000]) {
      const r = runCase(384, 1.5, { blockerLimit: limit });
      console.log(`    cap ${String(limit).padStart(5)}: ${String(r.sightRects).padStart(5)} rects  corner bake ${fmt(r.cornerMs, 0).padStart(5)} ms  ${String(r.cornerCount).padStart(6)} corners  flee scan ${fmt(r.fleeScanMs, 2)} ms`);
    }
  }
  if (CREST_SWEEP) {
    // Crest cover is the whole point of a terrain bake, and the harness's 2 m uphill span was
    // authored for a 0.5 m grid: on a coarse grid a 2 m span is ~1 cell, and one cell of legal
    // slope cannot lift a brow above a 1.6 m eye, so nothing ever qualifies.
    console.log('\n  crest-parameter sweep @384 m / 1.5 m cell (uphill span x threat-probe distance):');
    for (const spanM of [2, 3, 4.5, 6, 9]) {
      const line = [];
      for (const farM of [12, 18, 24]) {
        const r = runCase(384, 1.5, { crestSpanM: spanM, crestFarM: farM });
        line.push(`far ${String(farM).padStart(2)} m: ${String(r.crestCount).padStart(4)} crest${r.crestCapped ? '*' : ' '} (${fmt(r.cornerMs, 0)} ms)`);
      }
      console.log(`    span ${String(spanM).padStart(3)} m  ${line.join('   ')}`);
    }
  }
  console.log('');
}
