// terrain-source-v5.js — Terrain Generator v5 project as a streamable terrain source
// (Base Game terrain Phase 7). Accepts only a normalized, runtime-supported project
// (terrain-project-v5.js classifyProject): unbounded algorithm, streamable layers, no
// paint/imports. Height = the layer stack evaluated at a global point, with `classic`
// layers fed by the coordinate-hashed climate sampler. Erosion, hydrology and masks are
// preview-only finishing stages and are NOT applied here (listed in classification.omitted).
// No three.js; runs in terrain-worker.js and under Node.

import { prepareStack, evaluateStackPoint } from './terrain-stack.js';
import { sampleHeightTileBilinear } from './terrain-field.js';
import { createClassicHeightPoint, createDensityPoint, createUnboundedDensityNoiseSampler, marchingCubesGrid } from './terrain-generator-js.js';
import { createUnboundedFieldSampler } from './biome-classifier-js.js';
import { normalizeProject, hashProject, classifyProject, PROJECT_ALGORITHM_UNBOUNDED } from './terrain-project-v5.js';
import { normalizeDescriptor, normalizeTileRequest, validateTileResult, registerSourceKind, TerrainSourceError } from './terrain-source.js';

export const V5_SOURCE_ALGORITHM_VERSION = `${PROJECT_ALGORITHM_UNBOUNDED}/stack-height`;
export const VOLUME_TOP_MARGIN = 12;      // metres of air sampled above the highest surface sample so overhangs/warp close
export const VOLUME_GRADIENT_EPS = 0.35;  // finite-difference step for density-gradient normals
export const VOLUME_Y_SPACING_MULT = 2;   // vertical sample spacing relative to the XZ step (caves are ~10 m features)
const NORMAL_EPSILON = 0.5;   // same central difference as terrain-field.js so seams match the analytic source

// Descriptor for a project: key = project name (or 'v5-project'), sourceVersion = content hash.
export function v5Descriptor(projectLike, { key } = {}) {
  const { project } = normalizeProject(projectLike);
  const cls = classifyProject(project);
  if (!cls.runtimeSupported) throw new TerrainSourceError(`project is not runtime-supported: ${cls.reasons.join('; ')}`);
  const hash = hashProject(project);
  return normalizeDescriptor({
    kind: 'v5-recipe',
    key: key || (project.name ? project.name.replace(/[^A-Za-z0-9_-]+/g, '-') : 'v5-project'),
    sourceVersion: hash.slice(0, 16),
    algorithmVersion: V5_SOURCE_ALGORITHM_VERSION,
    bounds: null,
    capabilities: ['infinite', 'heights', 'normals', 'volume'],
    config: { project, projectHash: hash },
  });
}

export function createV5Source(descriptorLike) {
  const descriptor = descriptorLike && descriptorLike.kind ? normalizeDescriptor(descriptorLike) : v5Descriptor(descriptorLike);
  if (descriptor.kind !== 'v5-recipe') throw new TerrainSourceError(`expected kind v5-recipe, got ${descriptor.kind}`);
  if (descriptor.algorithmVersion !== V5_SOURCE_ALGORITHM_VERSION) throw new TerrainSourceError(`v5 algorithmVersion ${descriptor.algorithmVersion} unsupported`);
  const { project } = normalizeProject(descriptor.config.project);
  const cls = classifyProject(project);
  if (!cls.runtimeSupported) throw new TerrainSourceError(`project is not runtime-supported: ${cls.reasons.join('; ')}`);
  const hash = hashProject(project);
  if (descriptor.config.projectHash && descriptor.config.projectHash !== hash) throw new TerrainSourceError('descriptor projectHash does not match its project');

  const cfg = project.cfg;
  const density = project.density;
  const sampler = createUnboundedFieldSampler(cfg.seed);
  const densityNoise = createUnboundedDensityNoiseSampler();
  const densityPoint = createDensityPoint(density, cfg.seed, densityNoise, cfg.world_x, cfg.world_z);
  const classicAt = createClassicHeightPoint(cfg, sampler);
  const hasClassic = project.stack.layers.some(l => l.enabled && l.type === 'classic');
  const prepared = prepareStack(project.stack, { seed: cfg.seed });
  const pointCtx = { classic: 0, importUV: null };
  // The classic height is the only per-point input the stack needs; compute it once per sample.
  function heightAt(x, z) {
    pointCtx.classic = hasClassic ? classicAt(x, z) : 0;
    return evaluateStackPoint(prepared, x, z, pointCtx);
  }
  function normalAt(x, z, out = [0, 0, 0]) {
    const e = NORMAL_EPSILON;
    const nx = heightAt(x - e, z) - heightAt(x + e, z);
    const ny = 2 * e;
    const nz = heightAt(x, z - e) - heightAt(x, z + e);
    const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
    out[0] = nx * inv; out[1] = ny * inv; out[2] = nz * inv;
    return out;
  }

  // Signed density at a global point (positive = solid); `h` may be passed to skip the height eval.
  function densityAt(x, y, z, h = heightAt(x, z)) { return densityPoint(x, y, z, h); }
  // The density's real surface at (x, z): the highest solid sample scanning down from above the
  // heightfield, refined by bisection. The warp moves it up to ~warp_strength from heightAt, so
  // anything that places a body on volumetric ground must use this, not heightAt. Never null:
  // the floor seal at y_min is always solid.
  const SURFACE_SCAN_STEP = 1;
  function surfaceYAt(x, z, h = heightAt(x, z)) {
    const top = h + VOLUME_TOP_MARGIN;
    let yAir = top, yRock = null;
    for (let y = top; y >= density.y_min; y -= SURFACE_SCAN_STEP) {
      if (densityAt(x, y, z, h) >= 0) { yRock = y; break; }
      yAir = y;
    }
    if (yRock === null) return density.y_min;
    for (let i = 0; i < 8; i++) {
      const mid = (yAir + yRock) * 0.5;
      if (densityAt(x, mid, z, h) >= 0) yRock = mid; else yAir = mid;
    }
    return (yAir + yRock) * 0.5;
  }
  // True where the heightfield is not the real ground: the density surface lies deeper below it
  // than the warp alone can move it (a carved cave mouth), so a heightfield collider would float.
  const warpReach = density.warp_strength_surface + density.warp_strength_global + 2;
  function holeAt(x, z) {
    const h = heightAt(x, z);
    return surfaceYAt(x, z, h) < h - warpReach;
  }

  // Marching cubes over one tile column: samples at the tile's XZ grid (apron included), rows
  // from density.y_min up to the column's highest surface + margin. Normals come from the
  // density gradient, so they agree across tile borders without knowing the neighbour mesh.
  function buildVolume(tile) {
    const { texels, step, heights, apron: pad } = tile;
    const yMin = density.y_min;
    let maxH = -Infinity;
    for (let i = 0; i < heights.length; i++) if (heights[i] > maxH) maxH = heights[i];
    const sy = step * VOLUME_Y_SPACING_MULT;
    const yMax = Math.max(yMin + sy * 2, maxH + VOLUME_TOP_MARGIN);
    const ny = Math.ceil((yMax - yMin) / sy) + 1;
    // Cubes run over the interior samples only, so neighbouring tiles meet exactly on the
    // shared plane; the apron serves the gradient taps near the border.
    const nx = texels - 2 * pad, nz = texels - 2 * pad;
    const field = new Float32Array(nx * ny * nz);
    for (let iz = 0; iz < nz; iz++) {
      const z = tile.zMin + iz * step;
      for (let ix = 0; ix < nx; ix++) {
        const x = tile.xMin + ix * step;
        const h = heights[(iz + pad) * texels + (ix + pad)];
        for (let iy = 0; iy < ny; iy++) field[ix + iy * nx + iz * nx * ny] = densityAt(x, yMin + iy * sy, z, h);
      }
    }
    const mc = marchingCubesGrid(field, nx, ny, nz, step, sy, step, tile.xMin, yMin, tile.zMin, 0);
    const normals = new Float32Array(mc.positions.length);
    const e = VOLUME_GRADIENT_EPS;
    // Surface height for the gradient taps comes from the tile itself (bilinear), not the stack.
    const hAt = (x, z) => sampleHeightTileBilinear(tile, x, z);
    for (let i = 0; i < mc.positions.length; i += 3) {
      const x = mc.positions[i], y = mc.positions[i + 1], z = mc.positions[i + 2];
      const hx0 = hAt(x - e, z), hx1 = hAt(x + e, z), hz0 = hAt(x, z - e), hz1 = hAt(x, z + e), h = hAt(x, z);
      const gx = densityAt(x + e, y, z, hx1) - densityAt(x - e, y, z, hx0);
      const gy = densityAt(x, y + e, z, h) - densityAt(x, y - e, z, h);
      const gz = densityAt(x, y, z + e, hz1) - densityAt(x, y, z - e, hz0);
      const inv = -1 / (Math.hypot(gx, gy, gz) || 1);   // density grows inward; normal points out
      normals[i] = gx * inv; normals[i + 1] = gy * inv; normals[i + 2] = gz * inv;
    }
    return { positions: mc.positions, normals, indices: mc.indices, yMin, yMax: yMin + (ny - 1) * sy, spacing: step, spacingY: sy, rows: ny };
  }

  return {
    descriptor,
    project,
    projectHash: hash,
    classification: cls,
    contains() { return true; },
    heightAt,
    normalAt,
    densityAt,
    surfaceYAt,
    holeAt,
    buildTile(request) {
      const req = normalizeTileRequest(request);
      if (req.lod !== 0) throw new TerrainSourceError('v5 source builds lod 0 only');
      const step = req.size / req.intervals;
      const pad = req.apron;
      const texels = req.intervals + 1 + pad * 2;
      const originX = req.xMin - pad * step;
      const originZ = req.zMin - pad * step;
      const heights = new Float32Array(texels * texels);
      for (let iz = 0; iz < texels; iz++) {
        const z = originZ + iz * step;
        for (let ix = 0; ix < texels; ix++) heights[iz * texels + ix] = heightAt(originX + ix * step, z);
      }
      const out = { ix: req.ix, iz: req.iz, lod: 0, xMin: req.xMin, zMin: req.zMin, size: req.size, intervals: req.intervals, texels, step, apron: pad, originX, originZ, heights };
      if (req.fields.includes('normals')) {
        const n = [0, 0, 0];
        const normals = new Float32Array(texels * texels * 3);
        for (let iz = 0; iz < texels; iz++) {
          for (let ix = 0; ix < texels; ix++) {
            normalAt(originX + ix * step, originZ + iz * step, n);
            const o = (iz * texels + ix) * 3;
            normals[o] = n[0]; normals[o + 1] = n[1]; normals[o + 2] = n[2];
          }
        }
        out.normals = normals;
      }
      if (req.fields.includes('volume')) out.volume = buildVolume(out);
      return validateTileResult(out, req);
    },
  };
}

registerSourceKind('v5-recipe', createV5Source);
