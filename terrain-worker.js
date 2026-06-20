// terrain-worker.js — module Web Worker.
// Builds chunk geometry arrays off the render thread and returns them as
// transferables (zero-copy). The main-thread side lives in terrain-system.js,
// which falls back to synchronous building if this worker can't be created
// (e.g. opened over file://).

import { buildChunkArrays, buildHeightTile } from './terrain-field.js';

self.onmessage = (e) => {
  const { key, epoch, xMin, zMin, size, segments, params, computeNormals, jobType, texelWorld, apron } = e.data;

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
