// Dedicated source-backed road projection worker. Input position buffers are transferred in,
// mutated in place, and transferred back beside freshly computed density-surface normals.

import { createSource, normalizeDescriptor } from './terrain-source.js';
import { projectRoadPositions } from './road-projection.js';
import './terrain-source-analytic.js';
import './terrain-source-v5.js';

const sources = new Map();
function sourceFor(descriptor) {
  const normalized = normalizeDescriptor(descriptor);
  const key = JSON.stringify(normalized);
  let source = sources.get(key);
  if (!source) { source = createSource(normalized); sources.set(key, source); }
  return source;
}

self.onmessage = event => {
  const { jobType, batchId, terrainEpoch, descriptor, options, edges } = event.data;
  if (jobType !== 'projectRoadBatch') return;
  try {
    const source = sourceFor(descriptor);
    const projected = [];
    const transfer = [];
    for (const edge of edges) {
      const surfaces = [];
      for (const surface of edge.surfaces) {
        const normals = projectRoadPositions(source, surface.positions, options);
        surfaces.push({ name: surface.name, positions: surface.positions, normals });
        transfer.push(surface.positions.buffer, normals.buffer);
      }
      projected.push({ edgeId: edge.edgeId, edgeRevision: edge.edgeRevision, surfaces });
    }
    self.postMessage({ jobType, batchId, terrainEpoch, edges: projected }, transfer);
  } catch (error) {
    self.postMessage({ jobType, batchId, terrainEpoch, error: String(error?.message ?? error) });
  }
};
