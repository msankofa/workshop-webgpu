// terrain-source-analytic.js — terrain-source adapter over terrain-field.js.
// Point heights/normals and LOD-0 tiles are bit-identical to terrainHeightAt /
// terrainNormalAt / buildHeightTile. No three.js.

import { terrainHeightAt, terrainHeightAtSpacing, terrainNormalAt, buildHeightTile } from './terrain-field.js';
import { normalizeDescriptor, normalizeTileRequest, validateTileResult, registerSourceKind, TerrainSourceError } from './terrain-source.js';

export const ANALYTIC_ALGORITHM_VERSION = 'terrain-field-1';
export const DEFAULT_ANALYTIC_PARAMS = Object.freeze({ baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 });

function normalizeParams(p) {
  const out = { ...DEFAULT_ANALYTIC_PARAMS, ...(p || {}) };
  for (const k of ['baseAmp', 'lake', 'lakeDepth']) {
    if (typeof out[k] !== 'number' || !Number.isFinite(out[k])) throw new TerrainSourceError(`analytic param ${k} must be finite`);
  }
  return out;
}

// Builds the descriptor for an analytic source; `params` is the complete artifact.
export function analyticDescriptor({ key = 'analytic', sourceVersion = '1', params } = {}) {
  return normalizeDescriptor({
    kind: 'analytic',
    key,
    sourceVersion,
    algorithmVersion: ANALYTIC_ALGORITHM_VERSION,
    bounds: null,
    capabilities: ['infinite', 'heights', 'normals'],
    config: { params: normalizeParams(params) },
  });
}

export function createAnalyticSource(descriptorLike) {
  const descriptor = descriptorLike && descriptorLike.kind ? normalizeDescriptor(descriptorLike) : analyticDescriptor(descriptorLike);
  if (descriptor.algorithmVersion !== ANALYTIC_ALGORITHM_VERSION) throw new TerrainSourceError(`analytic algorithmVersion ${descriptor.algorithmVersion} unsupported`);
  const params = normalizeParams(descriptor.config.params);

  return {
    descriptor,
    params,
    contains(x, z) {
      const b = descriptor.bounds;
      return !b || (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ);
    },
    heightAt(x, z) { return terrainHeightAt(params, x, z); },
    normalAt(x, z, out = [0, 0, 0]) { return terrainNormalAt(params, x, z, out); },
    // Any lod: the request's own spacing (size / intervals) band-limits the field for lod > 0;
    // lod 0 is the exact field. Normals are lod-0 only (coarse rings shade from their heights).
    heightAtSpacing(x, z, spacing) { return terrainHeightAtSpacing(params, x, z, spacing); },
    buildTile(request) {
      const req = normalizeTileRequest(request);
      if (req.lod !== 0 && req.fields.includes('normals')) throw new TerrainSourceError('analytic source builds normals at lod 0 only');
      const spacing = req.lod === 0 ? 0 : req.size / req.intervals;
      const tile = buildHeightTile(req.xMin, req.zMin, req.size, req.size / req.intervals, params, req.apron, spacing > 0 ? (x, z) => terrainHeightAtSpacing(params, x, z, spacing) : null);
      const out = { ...tile, ix: req.ix, iz: req.iz, lod: req.lod };
      if (req.fields.includes('normals')) {
        const n = [0, 0, 0];
        const normals = new Float32Array(tile.texels * tile.texels * 3);
        for (let iz = 0; iz < tile.texels; iz++) {
          for (let ix = 0; ix < tile.texels; ix++) {
            terrainNormalAt(params, tile.originX + ix * tile.step, tile.originZ + iz * tile.step, n);
            const o = (iz * tile.texels + ix) * 3;
            normals[o] = n[0]; normals[o + 1] = n[1]; normals[o + 2] = n[2];
          }
        }
        out.normals = normals;
      }
      return validateTileResult(out, req);
    },
  };
}

registerSourceKind('analytic', createAnalyticSource);
