import { cellHash, candidateBlade, windowCellCount, maxInstances, perCellCount, tierLayout, tierRegions, tierDue } from './grass-cells.js';
import { grassHeightRef } from './grass-height-ref.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };
const cfg = { cellSize: 2, Kmax: 8, params };

// Determinism: a blade depends only on (gx,gz,slot), NOT on camera — no swimming.
const b1 = candidateBlade(cfg, 5, -3, 2);
const b2 = candidateBlade(cfg, 5, -3, 2);
ok(b1.x === b2.x && b1.z === b2.z && b1.h === b2.h && b1.yaw === b2.yaw, 'candidate is deterministic');

// Blade sits inside its cell's XZ footprint.
const cx = 5 * cfg.cellSize, cz = -3 * cfg.cellSize;
ok(b1.x >= cx && b1.x < cx + cfg.cellSize && b1.z >= cz && b1.z < cz + cfg.cellSize, 'blade within its cell');

// Blade base y equals the terrain height at its XZ (planted on the ground).
ok(Math.abs(b1.y - grassHeightRef(params, b1.x, b1.z)) < 1e-9, 'blade planted on terrain height');

// Distinct slots in a cell give distinct positions.
ok(candidateBlade(cfg, 0, 0, 0).x !== candidateBlade(cfg, 0, 0, 1).x, 'slots differ within a cell');

// Hash spread: not all cells collide to the same value.
ok(cellHash(0, 0) !== cellHash(1, 0) && cellHash(0, 0) !== cellHash(0, 1), 'cell hash varies');

// Capacity bounds the worst case: windowCellCount(R) * Kmax >= survivors for any camera.
const R = 48;
const cells = windowCellCount(R, cfg.cellSize);
const cap = maxInstances(R, cfg.cellSize, cfg.Kmax);
ok(cap === cells * cfg.Kmax, 'capacity = windowCells * Kmax');
ok(cells >= Math.PI * R * R / (cfg.cellSize * cfg.cellSize), 'window covers the disk of radius R');

// Density → per-cell count maps blades/area to an integer <= Kmax.
ok(perCellCount(0, cfg.cellSize, cfg.Kmax) === 0, 'zero density → 0 blades');
ok(perCellCount(100, cfg.cellSize, cfg.Kmax) === cfg.Kmax, 'high density clamps to Kmax');
const mid = perCellCount(1 / (cfg.cellSize * cfg.cellSize), cfg.cellSize, cfg.Kmax); // 1 blade/cell-area
ok(mid === 1, 'density of 1 blade per cell-area → 1');


// ---- tiered recull (2026-09-06): regions and clocks ----
{
  const lay = tierLayout(10, [{ ring: 2, perCell: 8 }, { ring: 5, perCell: 2 }, { ring: 10, perCell: 4 }]);
  const full = tierRegions(lay, 1e9);
  ok(full[0].base === 0 && full[0].size === lay.threads[0], 'region 0 is tier 0 threads');
  ok(full[1].base === lay.threads[0] && full[1].size === lay.threads[1] - lay.threads[0], 'region 1 follows region 0');
  ok(full[2].base === lay.threads[1] && full[2].size === lay.threads[2] - lay.threads[1], 'region 2 follows region 1');
  const tight = tierRegions(lay, lay.threads[1] + 5);
  ok(tight[0].size === full[0].size && tight[1].size === full[1].size && tight[2].size === 5, 'a small buffer shorts the outer tier only');
  ok(tight.every((r, i) => i === 0 || r.base === tight[i - 1].base + tight[i - 1].size), 'regions never overlap');
  const none = tierRegions(lay, 0);
  ok(none.every(r => r.size === 0), 'no capacity, no regions');
  const clock = { move: 2, turn: 8, frames: 16 };
  const at = (x, z, deg, frame, extra = {}) => ({ x, z, fx: Math.cos(deg * Math.PI / 180), fz: Math.sin(deg * Math.PI / 180), frame, dirty: false, occlusion: true, ...extra });
  const last = at(0, 0, 0, 100);
  ok(tierDue(null, at(0, 0, 0, 100), clock) === true, 'first recull is due');
  ok(tierDue(last, at(0, 0, 0, 101), clock) === false, 'a still camera one frame on is not due');
  ok(tierDue(last, at(0, 0, 0, 116), clock) === true, 'the frame clock fires');
  ok(tierDue(last, at(1.9, 0, 0, 101), clock) === false, 'under the move threshold');
  ok(tierDue(last, at(2, 0, 0, 101), clock) === true, 'at the move threshold');
  ok(tierDue(last, at(0, 0, 7.9, 101), clock) === false, 'under the turn threshold');
  ok(tierDue(last, at(0, 0, 8.1, 101), clock) === true, 'past the turn threshold');
  ok(tierDue(last, at(0.001, 0, 0, 101), { move: 0, turn: 0, frames: 16 }) === true, 'zero move fires on any motion');
  ok(tierDue(last, at(0, 0, 0.01, 101), { move: 0, turn: 0, frames: 16 }) === true, 'zero turn fires on any turn');
  ok(tierDue(last, at(0, 0, 0, 101), { move: 0, turn: 0, frames: 1 }) === true, 'frames 1 is every frame');
  ok(tierDue(last, at(0, 0, 0, 101), { move: 0, turn: 0, frames: 0 }) === true, 'frames 0 counts as 1');
  ok(tierDue(last, at(50, 0, 90, 200, { occlusion: false }), clock) === false, 'without occlusion only dirty fires');
  ok(tierDue(last, at(0, 0, 0, 101, { occlusion: false, dirty: true }), clock) === true, 'dirty fires regardless');
}

process.exit(fail ? 1 : 0);
