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
import { tintArrayColors, tintTileColors, boundsFromPositions } from './terrain-tint.js';
import './terrain-source-analytic.js';
import './terrain-source-v5.js';

const sources = new Map();   // normalized-descriptor JSON -> source (a changed descriptor never reuses a stale source)

// Finish the chunk here: vertex colours and the bounding sphere, so the main thread adopts
// them instead of walking every vertex twice in the frame the result lands.
function finishTile(tile, tint) {
  if (!tint) return null;
  const t0 = performance.now();
  let colors = null, bounds = null;
  if (tile.volume && tile.volume.positions) {
    colors = tintArrayColors(tile.volume.positions, tile.volume.normals, tint.seaLevel);
    bounds = boundsFromPositions(tile.volume.positions);
  } else if (tile.heights) {
    colors = tintTileColors(tile, tint.seaLevel);
  }
  return { colors, bounds, tintRevision: tint.revision, tintMs: performance.now() - t0 };
}

function sourceFor(descriptor) {
  const id = JSON.stringify(normalizeDescriptor(descriptor));
  let s = sources.get(id);
  if (!s) { s = createSource(descriptor); sources.set(id, s); }
  return s;
}

self.onmessage = (e) => {
  const { key, epoch, xMin, zMin, size, segments, params, computeNormals, jobType, texelWorld, apron, tint } = e.data;

  if (jobType === 'sourceTile') {
    const { descriptor, request } = e.data;
    try {
      const source = sourceFor(descriptor);
      const tile = source.buildTile(request);
      const k = key ?? tileKey(source.descriptor, epoch, tile.lod, tile.ix, tile.iz);
      const finished = finishTile(tile, tint);
      const transfer = tileTransferables(tile);
      if (finished?.colors) transfer.push(finished.colors.buffer);
      self.postMessage(
        { ...tile, ...(finished || {}), key: k, epoch, jobType, sourceKey: source.descriptor.key, sourceVersion: source.descriptor.sourceVersion },
        transfer,
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
  let colors = null, bounds = null, tintMs = 0;
  if (tint) {
    const t0 = performance.now();
    colors = tintArrayColors(a.positions, a.normals, tint.seaLevel);
    bounds = boundsFromPositions(a.positions);
    tintMs = performance.now() - t0;
    transfer.push(colors.buffer);
  }

  self.postMessage(
    { key, epoch, positions: a.positions, normals: a.normals, uvs: a.uvs, index: a.index, colors, bounds, tintRevision: tint ? tint.revision : null, tintMs },
    transfer,
  );
};
