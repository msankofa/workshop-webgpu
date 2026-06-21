import { cellHash, candidateBlade, windowCellCount, maxInstances, perCellCount } from './grass-cells.js';
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

process.exit(fail ? 1 : 0);
