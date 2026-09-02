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
import { createBiomePoint } from './terrain-biome-point.js';
import { normalizeProject, hashProject, classifyProject, PROJECT_ALGORITHM_UNBOUNDED } from './terrain-project-v5.js';
import { normalizeDescriptor, normalizeTileRequest, validateTileResult, registerSourceKind, TerrainSourceError } from './terrain-source.js';

export const V5_SOURCE_ALGORITHM_VERSION = `${PROJECT_ALGORITHM_UNBOUNDED}/stack-height`;
export const VOLUME_TOP_MARGIN = 12;      // metres of air sampled above the highest surface sample so overhangs/warp close
export const VOLUME_GRADIENT_EPS = 0.35;  // finite-difference step for density-gradient normals
export const VOLUME_Y_SPACING_MULT = 2;   // vertical sample spacing relative to the XZ step (caves are ~10 m features)
export const VOLUME_Y_SPACING_MAX = 8;    // metres; coarser rows misplace the iso-surface (the density is not linear in y over the floor seal and cave mask)
const NORMAL_EPSILON = 0.5;

// Append vertical skirt strips to a marching-cubes tile mesh along its four border planes,
// but only where the border contour is the open-sky surface (within 1.5 cells of the column's
// topmost air→rock crossing). Mutates mc.{positions,indices} (skirt normals are horizontal,
// filled by the caller's gradient loop only for the original verts, so they are appended here).
function addBorderSkirts(mc, field, nx, ny, nz, step, sy, xMin, yMin, zMin, depth) {
  const xMax = xMin + (nx - 1) * step, zMax = zMin + (nz - 1) * step;
  const eps = Math.min(step, sy) * 1e-3;
  // topmost rock sample per border column, scanned once
  const topAt = (ix, iz) => { for (let iy = ny - 1; iy >= 0; iy--) if (field[ix + iy * nx + iz * nx * ny] > 0) return yMin + iy * sy; return -Infinity; };
  const colX = i => Math.max(0, Math.min(nx - 1, Math.round((i - xMin) / step)));
  const colZ = i => Math.max(0, Math.min(nz - 1, Math.round((i - zMin) / step)));
  const pos = mc.positions, idx = mc.indices;
  // undirected open edges
  const counts = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const sideOf = i => {
    const x = pos[i * 3], z = pos[i * 3 + 2];
    if (Math.abs(x - xMin) < eps) return 0;
    if (Math.abs(x - xMax) < eps) return 1;
    if (Math.abs(z - zMin) < eps) return 2;
    if (Math.abs(z - zMax) < eps) return 3;
    return -1;
  };
  const outward = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const newPos = [], newNrm = [], newIdx = [];
  let base = pos.length / 3;
  for (const [key, count] of counts) {
    if (count !== 1) continue;
    const a = Math.floor(key / 4294967296), b = key % 4294967296;
    const sa = sideOf(a), sb = sideOf(b);
    if (sa < 0 || sa !== sb) continue;
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const my = (ay + by) / 2, mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const top = sa < 2
      ? Math.max(topAt(colX(mx), Math.max(0, colZ(mz) - 1)), topAt(colX(mx), colZ(mz)), topAt(colX(mx), Math.min(nz - 1, colZ(mz) + 1)))
      : Math.max(topAt(Math.max(0, colX(mx) - 1), colZ(mz)), topAt(colX(mx), colZ(mz)), topAt(Math.min(nx - 1, colX(mx) + 1), colZ(mz)));
    if (my < top - 1.5 * sy) continue;   // a cave contour, not the open-sky surface
    const [ox, oz] = outward[sa];
    // a, b, and their dropped copies; wind the two triangles to face outward
    newPos.push(ax, ay, az, bx, by, bz, ax, ay - depth, az, bx, by - depth, bz);
    for (let k = 0; k < 4; k++) newNrm.push(ox, 0, oz);
    const A = base, B = base + 1, A2 = base + 2, B2 = base + 3;
    const ex = bx - ax, ez = bz - az;
    // cross((b-a), (0,-depth,0)) = (ez*depth, 0, -ex*depth) → dot with outward
    const facing = (ez * ox - ex * oz) >= 0;
    if (facing) newIdx.push(A, B, B2, A, B2, A2); else newIdx.push(B, A, A2, B, A2, B2);
    base += 4;
  }
  if (!newPos.length) return;
  const p2 = new Float32Array(pos.length + newPos.length); p2.set(pos); p2.set(newPos, pos.length);
  const IndexArray = idx.constructor;
  const i2 = new IndexArray(idx.length + newIdx.length); i2.set(idx); i2.set(newIdx, idx.length);
  mc.positions = p2; mc.skirtIndexStart = idx.length; mc.indices = i2; mc.skirtVertexStart = pos.length / 3; mc.skirtNormals = newNrm;
}   // same central difference as terrain-field.js so seams match the analytic source

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
    seaLevel: project.cfg.sea_level ?? 0,   // authored in the generator's World group
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
  // Band-limited density per sample spacing (coarse volume LOD tiles); built on demand.
  const densityBySpacing = new Map();
  function densityPointFor(spacing) {
    if (!(spacing > 0)) return densityPoint;
    let fn = densityBySpacing.get(spacing);
    if (!fn) { fn = createDensityPoint(density, cfg.seed, densityNoise, cfg.world_x, cfg.world_z, spacing); densityBySpacing.set(spacing, fn); }
    return fn;
  }
  const classicAt = createClassicHeightPoint(cfg, sampler);
  const hasClassic = project.stack.layers.some(l => l.enabled && l.type === 'classic');
  const prepared = prepareStack(project.stack, { seed: cfg.seed });
  const pointCtx = { classic: 0, importUV: null };
  // The classic height is the only per-point input the stack needs; compute it once per sample.
  function heightAt(x, z) {
    pointCtx.classic = hasClassic ? classicAt(x, z) : 0;
    pointCtx.spacing = 0;
    return evaluateStackPoint(prepared, x, z, pointCtx);
  }
  // Band-limited height for a caller sampling every `spacing` metres (far clipmap rings): noise
  // layers drop octaves finer than ~4 samples per wavelength. The classic (v4 climate) layer is
  // not band-limited yet; it is low-frequency by construction. spacing 0 = heightAt.
  function bandLimitedAt(x, z, spacing) {
    pointCtx.classic = hasClassic ? classicAt(x, z) : 0;
    pointCtx.spacing = spacing > 0 ? spacing : 0;
    const h = evaluateStackPoint(prepared, x, z, pointCtx);
    pointCtx.spacing = 0;
    return h;
  }
  // Above SUPERSAMPLE_ABOVE the octave fade alone drifts (a masked ridged layer's dropped octaves
  // are replaced by a global mean that is not the local one), so the coarse post is a Gaussian-
  // weighted average of SS×SS sub-samples over a two-cell footprint, each band-limited at half
  // the spacing: the sub-fade removes what the footprint cannot, the footprint removes the rest
  // and keeps the local mean honest. Sigma is half the output spacing, the usual antialiasing
  // kernel; the wider one first used here (σ = 1 spacing) rounded summits off by 10 m at 80 m.
  // Measured: a 2.5-sample wave keeps 23%, an 8-sample wave ~90%, 80 m drift −0.2 m.
  const SUPERSAMPLE_ABOVE = 6, SS = 6, SS_FOOTPRINT = 2.0, SS_SIGMA = 0.5;
  const ssWeights = (() => { const w = []; let sum = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const u = ((i + 0.5) / SS - 0.5) * SS_FOOTPRINT, v = ((j + 0.5) / SS - 0.5) * SS_FOOTPRINT; const g = Math.exp(-(u * u + v * v) / (2 * SS_SIGMA * SS_SIGMA)); w.push([u, v, g]); sum += g; } return w.map(([u, v, g]) => [u, v, g / sum]); })();
  function heightAtSpacing(x, z, spacing) {
    if (!(spacing > SUPERSAMPLE_ABOVE)) return bandLimitedAt(x, z, spacing);
    const sub = spacing * 0.5;
    let acc = 0;
    for (const [u, v, g] of ssWeights) acc += g * bandLimitedAt(x + u * spacing, z + v * spacing, sub);
    return acc;
  }
  function normalAt(x, z, out = [0, 0, 0], spacing = 0) {
    const e = spacing > 0 ? Math.max(NORMAL_EPSILON, spacing * 0.5) : NORMAL_EPSILON;
    const hAt = spacing > 0 ? (px, pz) => heightAtSpacing(px, pz, spacing) : heightAt;
    const nx = hAt(x - e, z) - hAt(x + e, z);
    const ny = 2 * e;
    const nz = hAt(x, z - e) - hAt(x, z + e);
    const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
    out[0] = nx * inv; out[1] = ny * inv; out[2] = nz * inv;
    return out;
  }

  // Signed density at a global point (positive = solid); `h` may be passed to skip the height eval.
  // Biome/moisture for streamed tiles. Paint is not available here: classifyProject rejects a
  // painted project for the infinite runtime, so this is the noise-and-slope half only.
  const biomePoint = createBiomePoint(cfg, sampler, { seaLevel: cfg.sea_level });
  function biomeAtPoint(x, z, h = surfaceYAt(x, z)) {
    const e = NORMAL_EPSILON;
    const gx = (surfaceYAt(x + e, z) - surfaceYAt(x - e, z)) / (2 * e);
    const gz = (surfaceYAt(x, z + e) - surfaceYAt(x, z - e)) / (2 * e);
    return biomePoint.classifyPoint(x, z, h, Math.hypot(gx, gz));
  }
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
  // The hole test only needs to know whether rock exists above h - warpReach, so the scan stops
  // there instead of at y_min. Collider queries repeat exact X/Z points several times per step;
  // a fixed direct-mapped cache removes those scans without sharing an answer across distinct
  // points near a cave boundary. A collision merely recomputes and replaces the slot.
  const HOLE_CACHE_SIZE = 1 << 16, HOLE_CACHE_MASK = HOLE_CACHE_SIZE - 1;
  const holeCacheX = new Float64Array(HOLE_CACHE_SIZE);
  const holeCacheZ = new Float64Array(HOLE_CACHE_SIZE);
  const holeCacheState = new Uint8Array(HOLE_CACHE_SIZE); // 0 empty, 1 false, 2 true
  function holeAtUncached(x, z) {
    const h = heightAt(x, z);
    const floor = Math.max(density.y_min, h - warpReach);
    for (let y = h + VOLUME_TOP_MARGIN; y >= floor; y -= SURFACE_SCAN_STEP) if (densityAt(x, y, z, h) >= 0) return false;
    return densityAt(x, floor, z, h) < 0;
  }
  function holeAt(x, z) {
    const qx = Math.round(x * 2), qz = Math.round(z * 2);
    const slot = (Math.imul(qx, 73856093) ^ Math.imul(qz, 19349663)) & HOLE_CACHE_MASK;
    const state = holeCacheState[slot];
    if (state && holeCacheX[slot] === x && holeCacheZ[slot] === z) return state === 2;
    const v = holeAtUncached(x, z);
    holeCacheX[slot] = x; holeCacheZ[slot] = z; holeCacheState[slot] = v ? 2 : 1;
    return v;
  }

  // Marching cubes over one tile column: samples at the tile's XZ grid (apron included), rows
  // from density.y_min up to the column's highest surface + margin. Normals come from the
  // density gradient, so they agree across tile borders without knowing the neighbour mesh.
  function buildVolume(tile, spacing = 0, skirtDepth = 0) {
    const { texels, step, heights, apron: pad } = tile;
    const densityAt = (x, y, z, h) => densityPointFor(spacing)(x, y, z, h);
    const yMin = density.y_min;
    let maxH = -Infinity;
    for (let i = 0; i < heights.length; i++) if (heights[i] > maxH) maxH = heights[i];
    const sy = Math.min(step * VOLUME_Y_SPACING_MULT, VOLUME_Y_SPACING_MAX);
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
    // LOD skirts (chunked-LOD standard): a strip hangs from the tile border's OPEN-SKY surface
    // contour so a coarser level never shows a crack against a finer one. Cave contours on the
    // border are left alone (a skirt there would curtain the cave mouth), told apart by the
    // topmost air→rock crossing of each border column of the field.
    if (skirtDepth > 0) addBorderSkirts(mc, field, nx, ny, nz, step, sy, tile.xMin, yMin, tile.zMin, skirtDepth);
    const gradEnd = mc.skirtVertexStart != null ? mc.skirtVertexStart * 3 : mc.positions.length;
    const normals = new Float32Array(mc.positions.length);
    if (mc.skirtNormals) normals.set(mc.skirtNormals, gradEnd);
    const e = VOLUME_GRADIENT_EPS;
    // Surface height for the gradient taps comes from the tile itself (bilinear), not the stack.
    const hAt = (x, z) => sampleHeightTileBilinear(tile, x, z);
    for (let i = 0; i < gradEnd; i += 3) {
      const x = mc.positions[i], y = mc.positions[i + 1], z = mc.positions[i + 2];
      const hx0 = hAt(x - e, z), hx1 = hAt(x + e, z), hz0 = hAt(x, z - e), hz1 = hAt(x, z + e), h = hAt(x, z);
      const gx = densityAt(x + e, y, z, hx1) - densityAt(x - e, y, z, hx0);
      const gy = densityAt(x, y + e, z, h) - densityAt(x, y - e, z, h);
      const gz = densityAt(x, y, z + e, hz1) - densityAt(x, y, z - e, hz0);
      const inv = -1 / (Math.hypot(gx, gy, gz) || 1);   // density grows inward; normal points out
      normals[i] = gx * inv; normals[i + 1] = gy * inv; normals[i + 2] = gz * inv;
    }
    return { positions: mc.positions, normals, indices: mc.indices, yMin, yMax: yMin + (ny - 1) * sy, spacing: step, spacingY: sy, rows: ny,
      skirtIndexStart: mc.skirtIndexStart ?? mc.indices.length,
      skirtVertexStart: mc.skirtVertexStart ?? mc.positions.length / 3 };
  }

  return {
    descriptor,
    project,
    projectHash: hash,
    classification: cls,
    contains() { return true; },
    heightAt,
    heightAtSpacing,
    // One-off CPU queries (a debug readout, a spawn point). Placement reads streamed tile fields:
    // this pays a surfaceYAt scan plus four heightAt evaluations for the slope, per call.
    biomeAt: biomeAtPoint,
    moistureAt(x, z) { const h = surfaceYAt(x, z); return biomePoint.moistureAt(biomeAtPoint(x, z, h), h); },
    normalAt,
    densityAt,
    surfaceYAt,
    holeAt,
    buildTile(request) {
      const req = normalizeTileRequest(request);
      const step = req.size / req.intervals;
      const pad = req.apron;
      const texels = req.intervals + 1 + pad * 2;
      const originX = req.xMin - pad * step;
      const originZ = req.zMin - pad * step;
      const heights = new Float32Array(texels * texels);
      const spacing = req.lod === 0 ? 0 : step;
      for (let iz = 0; iz < texels; iz++) {
        const z = originZ + iz * step;
        for (let ix = 0; ix < texels; ix++) heights[iz * texels + ix] = spacing > 0 ? heightAtSpacing(originX + ix * step, z, spacing) : heightAt(originX + ix * step, z);
      }
      const out = { ix: req.ix, iz: req.iz, lod: req.lod, xMin: req.xMin, zMin: req.zMin, size: req.size, intervals: req.intervals, texels, step, apron: pad, originX, originZ, heights };
      if (req.fields.includes('normals')) {
        const n = [0, 0, 0];
        const normals = new Float32Array(texels * texels * 3);
        for (let iz = 0; iz < texels; iz++) {
          for (let ix = 0; ix < texels; ix++) {
            normalAt(originX + ix * step, originZ + iz * step, n, spacing);
            const o = (iz * texels + ix) * 3;
            normals[o] = n[0]; normals[o + 1] = n[1]; normals[o + 2] = n[2];
          }
        }
        out.normals = normals;
      }
      // The visible open-sky surface. Expensive (surfaceYAt scans down from h + VOLUME_TOP_MARGIN
      // in 1 m steps, then bisects 8 times), so it is filled only when a consumer asks for it.
      if (req.fields.includes('surfaceHeights')) {
        const surface = new Float32Array(texels * texels);
        for (let iz = 0; iz < texels; iz++) {
          const z = originZ + iz * step;
          for (let ix = 0; ix < texels; ix++) {
            const i = iz * texels + ix;
            surface[i] = surfaceYAt(originX + ix * step, z, heights[i]);
          }
        }
        out.surfaceHeights = surface;
      }
      if (req.fields.includes('biomeIds') || req.fields.includes('moisture')) {
        const { biomeIds, moisture } = biomePoint.classifyTile(
          out.surfaceHeights ?? heights, texels, step, originX, originZ, spacing,
          { biomeIds: req.fields.includes('biomeIds'), moisture: req.fields.includes('moisture') },
        );
        if (biomeIds) out.biomeIds = biomeIds;
        if (moisture) out.moisture = moisture;
      }
      // Every visual tile gets skirts (the exact window's edge cracks against the cascade too);
      // collision consumers slice the index at volume.skirtIndexStart. The server's collision
      // tiles come through createVolumeCollision, which passes skirtDepth 0 explicitly.
      if (req.fields.includes('volume')) out.volume = buildVolume(out, spacing, req.skirtDepth ?? (req.lod >= 1 ? Math.max(4, spacing * 0.2 + VOLUME_Y_SPACING_MAX) : 6));
      return validateTileResult(out, req);
    },
  };
}

registerSourceKind('v5-recipe', createV5Source);
