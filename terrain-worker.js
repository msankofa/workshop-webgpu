// terrain-worker.js — module Web Worker.
// Builds chunk geometry arrays off the render thread and returns them as
// transferables (zero-copy). The main-thread side lives in terrain-system.js,
// which falls back to synchronous building if this worker can't be created
// (e.g. opened over file://).
//
// Three job paths: legacy chunk arrays (default), legacy 'heightTile', and
// 'sourceTile', which builds the pure terrain-source named by a descriptor.

import { buildChunkArrays, buildHeightTile } from './terrain-field.js';
import { createSource, normalizeDescriptor, tileKey, tileTransferables, TerrainSourceError } from './terrain-source.js';
import './terrain-source-analytic.js';
import './terrain-source-v5.js';

const sources = new Map();   // normalized-descriptor JSON -> source (a changed descriptor never reuses a stale source)

function sourceFor(descriptor) {
  const id = JSON.stringify(normalizeDescriptor(descriptor));
  let s = sources.get(id);
  if (!s) { s = createSource(descriptor); sources.set(id, s); }
  return s;
}

self.onmessage = (e) => {
  const { key, epoch, xMin, zMin, size, segments, params, computeNormals, jobType, texelWorld, apron } = e.data;

  if (jobType === 'sourceTile') {
    const { descriptor, request } = e.data;
    try {
      const source = sourceFor(descriptor);
      const tile = source.buildTile(request);
      const k = key ?? tileKey(source.descriptor, epoch, tile.lod, tile.ix, tile.iz);
      self.postMessage(
        { ...tile, key: k, epoch, jobType, sourceKey: source.descriptor.key, sourceVersion: source.descriptor.sourceVersion },
        tileTransferables(tile),
      );
    } catch (err) {
      self.postMessage({ key, epoch, jobType, error: String((err && err.message) || err), contractError: err instanceof TerrainSourceError });
    }
    return;
  }

  if (jobType === 'heightTile') {
    const tile = buildHeightTile(xMin, zMin, size, texelWorld, params, apron);
    self.postMessage(
      { key, epoch, jobType, heights: tile.heights, texels: tile.texels, intervals: tile.intervals, step: tile.step, apron: tile.apron, xMin, zMin, size, originX: tile.originX, originZ: tile.originZ },
      [tile.heights.buffer],
    );
    return;
  }

  const a = buildChunkArrays(xMin, zMin, size, segments, params, computeNormals);

  const transfer = [a.positions.buffer, a.uvs.buffer, a.index.buffer];
  if (a.normals) transfer.push(a.normals.buffer);

  self.postMessage(
    { key, epoch, positions: a.positions, normals: a.normals, uvs: a.uvs, index: a.index },
    transfer,
  );
};
