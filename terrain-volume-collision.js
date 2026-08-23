// terrain-volume-collision.js — headless volumetric collision for a terrain source with a
// density field (the server side of multiplayer volumetric terrain). Builds the same lod-0
// `volume` tiles the client streams (same chunk size / intervals / apron, so the marching-cubes
// meshes are bit-identical) and holds them in a chunk-mesh world-query provider around the
// positions it is asked to cover. Synchronous: a tile costs tens of milliseconds, so coverage
// is a small ring and chunks far from everyone are dropped. No renderer.

import * as THREE from 'three';
import { createChunkMeshWorldQueryProvider } from './world-query-chunk-mesh-provider.js';

export const VOLUME_COLLISION_DEFAULTS = Object.freeze({
  chunkSize: 30,
  minSegmentsPerChunk: 14,   // terrain-system.js DEFAULTS, so intervals match the client
  coverRadius: 1,            // chunks built around each covered position (1 = 3x3)
  keepRadius: 3,             // chunks kept before pruning
  maxBuildsPerCall: 4,       // synchronous tile builds per ensure() call
});

export function volumeChunkIntervals(chunkSize, minSegmentsPerChunk = VOLUME_COLLISION_DEFAULTS.minSegmentsPerChunk) {
  return Math.max(minSegmentsPerChunk, Math.round(chunkSize * 0.75));
}

export function createVolumeCollision(source, { worldQuery = null, providerId = 'terrain-volume', priority = 50, ...opts } = {}) {
  if (!source || typeof source.buildTile !== 'function' || typeof source.densityAt !== 'function') {
    throw new TypeError('volume collision needs a terrain source with buildTile() and densityAt()');
  }
  const cfg = { ...VOLUME_COLLISION_DEFAULTS, ...opts };
  const intervals = volumeChunkIntervals(cfg.chunkSize, cfg.minSegmentsPerChunk);
  const provider = createChunkMeshWorldQueryProvider({ id: providerId, priority });
  const unregister = worldQuery ? worldQuery.registerProvider(provider) : () => {};
  const chunks = new Map();   // key -> { ix, iz, triangles, buildMs }
  let buildMsTotal = 0;

  const keyOf = (ix, iz) => `${ix},${iz}`;
  function chunkIndex(v) { return Math.floor(v / cfg.chunkSize); }

  function build(ix, iz) {
    const key = keyOf(ix, iz);
    if (chunks.has(key)) return false;
    const t0 = performance.now();
    const tile = source.buildTile({ ix, iz, lod: 0, xMin: ix * cfg.chunkSize, zMin: iz * cfg.chunkSize, size: cfg.chunkSize, intervals, apron: 1, fields: ['heights', 'volume'] });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(tile.volume.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(tile.volume.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(tile.volume.indices, 1));
    provider.setChunk(key, geo, { sourceVersion: source.descriptor?.sourceVersion ?? null });
    const buildMs = performance.now() - t0;
    buildMsTotal += buildMs;
    chunks.set(key, { ix, iz, triangles: tile.volume.indices.length / 3, buildMs });
    return true;
  }

  // Build the ring around each position (nearest first, bounded per call) and drop chunks that
  // are outside keepRadius of every position. Returns the number of chunks built.
  function ensure(positions) {
    const wanted = [];
    const keep = new Set();
    for (const p of positions) {
      const cx = chunkIndex(p[0]), cz = chunkIndex(p[2]);
      for (let dz = -cfg.keepRadius; dz <= cfg.keepRadius; dz++) for (let dx = -cfg.keepRadius; dx <= cfg.keepRadius; dx++) keep.add(keyOf(cx + dx, cz + dz));
      for (let dz = -cfg.coverRadius; dz <= cfg.coverRadius; dz++) for (let dx = -cfg.coverRadius; dx <= cfg.coverRadius; dx++) {
        const ix = cx + dx, iz = cz + dz;
        if (!chunks.has(keyOf(ix, iz))) wanted.push({ ix, iz, d: dx * dx + dz * dz });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    let built = 0;
    for (const w of wanted) {
      if (built >= cfg.maxBuildsPerCall) break;
      if (build(w.ix, w.iz)) built++;
    }
    for (const key of [...chunks.keys()]) if (!keep.has(key)) { provider.removeChunk(key); chunks.delete(key); }
    return built;
  }

  // True when the chunk under (x, z) is collidable: movement there is safe to simulate.
  function covers(x, z) { return chunks.has(keyOf(chunkIndex(x), chunkIndex(z))); }

  return {
    provider,
    intervals,
    get chunkSize() { return cfg.chunkSize; },
    get chunkCount() { return chunks.size; },
    get stats() { return { chunks: chunks.size, triangles: provider.triangleCount, buildMsTotal }; },
    ensure,
    covers,
    build,
    hasChunk: key => chunks.has(key),
    clear() { provider.clear(); chunks.clear(); },
    dispose() { provider.clear(); chunks.clear(); unregister(); },
  };
}
