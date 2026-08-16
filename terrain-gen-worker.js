// Module Web Worker for terrain-generator-v5: runs the whole grid pipeline (noise fields ->
// layer stack -> erosion -> masks -> biome -> materials) and, on request, the volumetric
// density field + marching cubes, off the main thread. Replies carry transferable arrays.
// Message: { id, kind: 'grid' | 'volume', cfg, resolution, stack, paintHeight?, biomeOverride?,
//            imports?, densityCfg? (volume only) }.

import { generateFullGridV5, buildDensityField3D, marchingCubes, grassDensityForIds } from './terrain-generator-js.js';
import { evaluateStackGrid, normalizeStack } from './terrain-stack.js';

function transferables(grid) {
  const set = new Set();
  for (const v of Object.values(grid)) {
    if (ArrayBuffer.isView(v)) set.add(v.buffer);
    else if (v && typeof v === 'object') for (const w of Object.values(v)) if (ArrayBuffer.isView(w)) set.add(w.buffer);
  }
  return [...set];
}

function resampleFloat(src, r0, r1) {
  if (r0 === r1) return src;
  const out = new Float32Array(r1 * r1);
  for (let iz = 0; iz < r1; iz++) {
    const gz = (iz / Math.max(1, r1 - 1)) * (r0 - 1), z0 = Math.min(r0 - 2, Math.floor(gz)), tz = gz - z0;
    for (let ix = 0; ix < r1; ix++) {
      const gx = (ix / Math.max(1, r1 - 1)) * (r0 - 1), x0 = Math.min(r0 - 2, Math.floor(gx)), tx = gx - x0;
      const a = src[z0 * r0 + x0], b = src[z0 * r0 + x0 + 1], c = src[(z0 + 1) * r0 + x0], d = src[(z0 + 1) * r0 + x0 + 1];
      out[iz * r1 + ix] = a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
    }
  }
  return out;
}
function resampleNearest(src, r0, r1) {
  if (r0 === r1) return src;
  const out = new Uint8Array(r1 * r1);
  for (let iz = 0; iz < r1; iz++) for (let ix = 0; ix < r1; ix++) {
    out[iz * r1 + ix] = src[Math.round(iz / Math.max(1, r1 - 1) * (r0 - 1)) * r0 + Math.round(ix / Math.max(1, r1 - 1) * (r0 - 1))];
  }
  return out;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  const t0 = performance.now();
  try {
    const stack = normalizeStack(msg.stack);
    const cfg = msg.cfg;
    // Volume jobs run at the density grid's own resolution (cubic cost), so paint layers
    // authored at the preview resolution are resampled to match.
    const resolution = msg.kind === 'volume' ? msg.densityCfg.density_resolution : msg.resolution;
    const paintHeight = msg.paintHeight ? resampleFloat(msg.paintHeight, msg.resolution, resolution) : null;
    const biomeOverride = msg.biomeOverride ? resampleNearest(msg.biomeOverride, msg.resolution, resolution) : null;
    const stackEval = (classicHeight) => evaluateStackGrid(stack, {
      resolution, worldX: cfg.world_x, worldZ: cfg.world_z, seed: cfg.seed, classicHeight, imports: msg.imports || {},
    });
    const grid = generateFullGridV5(cfg, resolution, stackEval, { paintHeight, biomeOverride });
    const reply = { id: msg.id, kind: msg.kind, grid, ms: 0 };
    if (msg.kind === 'volume') {
      const d = msg.densityCfg;
      const density = buildDensityField3D(grid, d, cfg.world_x, cfg.world_z, cfg.seed);
      const res = resolution;
      const spacingX = cfg.world_x / Math.max(1, res - 1);
      const spacingY = (d.y_max - d.y_min) / Math.max(1, res - 1);
      const spacingZ = cfg.world_z / Math.max(1, res - 1);
      const mc = marchingCubes(density, res, spacingX, spacingY, spacingZ, -cfg.world_x / 2, d.y_min, -cfg.world_z / 2, d.iso_level ?? 0);
      reply.volume = { positions: mc.positions, indices: mc.indices };
    }
    reply.grassDensity = grassDensityForIds(grid.biomeId, grid.materialMasks.water);
    reply.ms = performance.now() - t0;
    const tr = new Set(transferables(grid));
    if (reply.volume) { tr.add(reply.volume.positions.buffer); tr.add(reply.volume.indices.buffer); }
    tr.add(reply.grassDensity.buffer);
    self.postMessage(reply, [...tr]);
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.stack || err) });
  }
};
