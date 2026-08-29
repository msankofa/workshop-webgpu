// grass-cells.js
// Pure, renderer-independent math for the world-anchored grass cell grid. grass-compute.js uses
// maxInstances()/perCellCount() to size its buffers and its per-recull dispatch, and those two ARE
// load-bearing. Node-tested.
//
// candidateBlade() is NOT a twin of the shader. It is a readable reference for the placement
// SCHEME -- jitter within a cell, planted on the height, deterministic per (cell, slot) -- and
// nothing imports it but this module's own test. The hashes genuinely differ: slotRandFn in
// grass-compute.js salts with 2246822519 where slotRand here uses 0x85ebca6b, folds slot and salt
// in before the xor-shift cellHash() applies inside itself, and runs an extra multiply round. Do
// not write a test that expects the two to agree on a blade position; they never have.

import { grassHeightRef } from './grass-height-ref.js';

// Integer cell hash -> uint in [0, 2^32). Same family as terrain-field lakeHash. The shader's
// hash is a relative, not a copy: see the header.
export function cellHash(gx, gz) {
  let h = (Math.imul(gx | 0, 1597334677) ^ Math.imul(gz | 0, 3812015801)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0);
}

// A per-(cell,slot) pseudo-random in [0,1). Mixing slot keeps slots independent.
function slotRand(gx, gz, slot, salt) {
  let h = (cellHash(gx, gz) ^ Math.imul((slot | 0) + 1, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Deterministic candidate blade for (gx,gz,slot): position jittered within the cell,
// planted on the terrain, with yaw/height variation. Pure function of its indices
// (and terrain params) — independent of camera, so blades never swim.
export function candidateBlade(cfg, gx, gz, slot) {
  const C = cfg.cellSize;
  const jx = slotRand(gx, gz, slot, 1);
  const jz = slotRand(gx, gz, slot, 2);
  const x = gx * C + jx * C;
  const z = gz * C + jz * C;
  const y = grassHeightRef(cfg.params, x, z);
  const yaw = slotRand(gx, gz, slot, 3) * Math.PI * 2;
  const tipYaw = slotRand(gx, gz, slot, 4) * Math.PI * 2;
  const h = 0.8 + slotRand(gx, gz, slot, 5) * 0.6; // bladeHeight + heightVariation (grass.js DEFAULTS)
  return { x, y, z, yaw, tipYaw, h };
}

// Number of cells whose center lies within radius R (square window that covers the
// disk; the kernel still distance-culls to a circle). Square side = 2*ceil(R/C)+1.
export function windowCellCount(R, cellSize) {
  const half = Math.ceil(R / cellSize);
  const side = 2 * half + 1;
  return side * side;
}

// Worst-case survivor capacity for buffer sizing.
export function maxInstances(R, cellSize, Kmax) {
  return windowCellCount(R, cellSize) * Kmax;
}

// blades-per-unit-area → integer blades per cell, clamped to [0, Kmax].
export function perCellCount(density, cellSize, Kmax) {
  const per = Math.round(density * cellSize * cellSize);
  return Math.max(0, Math.min(Kmax, per));
}
