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

// Keep-probability edge of the distance fade, the JS twin of grass-compute's fadeEdgeFn: 0 up
// to start, ((d - start) / (end - start))^curve to 1 at end. A blade survives when its fixed
// per-(cell, slot) random exceeds this.
export function fadeEdge(dist, start, end, curve = 1) {
  const band = Math.max(1e-3, end - start);
  const t = Math.min(1, Math.max(0, (dist - start) / band));
  return t ** Math.max(0.01, curve);
}

// Square-ring cell numbering (grass plan phase 3). Ring k >= 1 holds the 8k cells at Chebyshev
// distance k from the camera cell, numbered [(2k-1)^2, (2k+1)^2); cell 0 is the camera cell.
// Near-to-far, so a dispatch in index order fills the survivor buffer from the camera outward and
// the buffer cap truncates at the outer ring instead of along a row. The TSL in grass-compute.js's
// procedural cull is the same arithmetic; ringOfCell corrects the float sqrt by one either way.
export function ringOfCell(cellI) {
  let k = Math.ceil((Math.sqrt(cellI + 1) - 1) / 2);
  if (k > 0 && (2 * k - 1) ** 2 > cellI) k--;
  if ((2 * k + 1) ** 2 <= cellI) k++;
  return k;
}
export function ringCell(cellI) {
  const k = ringOfCell(cellI);
  if (k === 0) return { x: 0, z: 0, ring: 0 };
  const j = cellI - (2 * k - 1) ** 2, L = 2 * k;
  const side = Math.floor(j / L), t = j % L;
  if (side === 0) return { x: -k + t, z: -k, ring: k };
  if (side === 1) return { x: k, z: -k + t, ring: k };
  if (side === 2) return { x: k - t, z: k, ring: k };
  return { x: -k, z: k - t, ring: k };
}
export const cellsWithinRing = (k) => (2 * k + 1) ** 2;

// Tiered thread layout. tiers[t] = { ring, perCell }, ring being the last ring the tier covers
// (the final tier always runs to half). Threads are laid out tier by tier, cell-major within a
// tier; the result is the cumulative cell and thread count at each tier's end.
export function tierLayout(half, tiers) {
  const out = { cells: [], threads: [], perCell: [] };
  let threads = 0, prevCells = 0;
  for (let i = 0; i < tiers.length; i++) {
    const ring = i === tiers.length - 1 ? half : Math.min(half, Math.max(0, tiers[i].ring | 0));
    const cells = Math.max(prevCells, cellsWithinRing(ring));
    const perCell = Math.max(0, tiers[i].perCell | 0);
    threads += (cells - prevCells) * perCell;
    out.cells.push(cells); out.threads.push(threads); out.perCell.push(perCell);
    prevCells = cells;
  }
  return out;
}
// Thin the tiers to a thread budget, outer tiers first, so the grass at your feet is the last
// to go. Returns a new tier list.
export function thinTiers(half, tiers, budget) {
  const t = tiers.map(x => ({ ...x }));
  for (let i = t.length - 1; i >= 0; i--) {
    const lay = tierLayout(half, t);
    if (lay.threads[lay.threads.length - 1] <= budget) break;
    const innerThreads = i > 0 ? lay.threads[i - 1] : 0;
    const tierCells = lay.cells[i] - (i > 0 ? lay.cells[i - 1] : 0);
    const room = Math.max(0, Math.floor((budget - innerThreads) / Math.max(1, tierCells)));
    t[i].perCell = Math.min(t[i].perCell, room);
  }
  return t;
}
