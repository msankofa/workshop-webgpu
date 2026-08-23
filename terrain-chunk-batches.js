// terrain-chunk-batches.js — resident terrain chunks as a few BatchedMesh draws instead of one
// draw each. A streamed chunk is copied into a batch when it lands and deleted when it unloads;
// batches are allocated on demand with a fixed slot/vertex budget (so a 65×65-chunk draw radius
// does not preallocate hundreds of megabytes) and compacted with optimize() once deletions have
// fragmented them. Per-geometry frustum culling is BatchedMesh's own. Geometry stays global:
// every instance matrix is identity, so object-space == world-space for the materials.

import * as THREE from 'three';

export const CHUNK_BATCH_DEFAULTS = Object.freeze({
  slots: 256,             // geometries per batch
  vertices: 600_000,      // vertex budget per batch (~2.3k per chunk)
  indices: 3_600_000,     // heightfield chunks run ~5.5 indices per vertex
  maxBatches: 64,         // beyond this chunks fall back to their own mesh
  compactWhenUnusedFraction: 0.35,   // optimize() a batch once this much of its space is dead
});

export function createChunkBatcher({ material, name = 'terrain-chunk-batches', ...opts } = {}) {
  const cfg = { ...CHUNK_BATCH_DEFAULTS, ...opts };
  const group = new THREE.Group();
  group.name = name;
  const batches = [];          // { mesh, entries: Map key -> { geometryId, instanceId }, deadVertices }
  const byKey = new Map();     // key -> batch
  let currentMaterial = material;
  const stats = { adds: 0, removes: 0, fallbacks: 0, compactions: 0 };

  function newBatch() {
    const mesh = new THREE.BatchedMesh(cfg.slots, cfg.vertices, cfg.indices, currentMaterial);
    mesh.name = `${name}-${batches.length}`;
    mesh.frustumCulled = false;        // whole-batch bounds never maintained; per-geometry culling is on
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = false;
    mesh.receiveShadow = true;
    const batch = { mesh, entries: new Map(), deadVertices: 0, deadIndices: 0 };
    batches.push(batch);
    group.add(mesh);
    return batch;
  }

  function tryAdd(batch, key, geometry) {
    if (batch.entries.size >= cfg.slots) return false;
    const verts = geometry.attributes.position.count, idx = geometry.index ? geometry.index.count : verts;
    if (batch.mesh.unusedVertexCount < verts || batch.mesh.unusedIndexCount < idx) {
      // deleted geometry only frees its space on optimize(); compact when that would be enough
      if (batch.mesh.unusedVertexCount + batch.deadVertices < verts || batch.mesh.unusedIndexCount + batch.deadIndices < idx) return false;
      batch.mesh.optimize(); batch.deadVertices = 0; batch.deadIndices = 0; stats.compactions++;
      if (batch.mesh.unusedVertexCount < verts || batch.mesh.unusedIndexCount < idx) return false;
    }
    let geometryId;
    try { geometryId = batch.mesh.addGeometry(geometry); }
    catch {
      // unused space exists but is fragmented: compact and retry once
      batch.mesh.optimize(); batch.deadVertices = 0; batch.deadIndices = 0; stats.compactions++;
      try { geometryId = batch.mesh.addGeometry(geometry); } catch { return false; }
    }
    const instanceId = batch.mesh.addInstance(geometryId);
    batch.entries.set(key, { geometryId, instanceId, vertices: verts, indices: idx });
    byKey.set(key, batch);
    return true;
  }

  // Copy a chunk geometry into a batch. Returns false when no batch can take it (caller keeps
  // drawing its own mesh).
  function add(key, geometry) {
    if (byKey.has(key)) remove(key);
    if (!geometry?.attributes?.position || geometry.attributes.position.count === 0) return false;
    for (const batch of batches) if (tryAdd(batch, key, geometry)) { stats.adds++; return true; }
    if (batches.length < cfg.maxBatches && tryAdd(newBatch(), key, geometry)) { stats.adds++; return true; }
    stats.fallbacks++;
    return false;
  }

  function remove(key) {
    const batch = byKey.get(key);
    if (!batch) return false;
    const e = batch.entries.get(key);
    batch.mesh.deleteInstance(e.instanceId);
    batch.mesh.deleteGeometry(e.geometryId);
    batch.entries.delete(key);
    byKey.delete(key);
    batch.deadVertices += e.vertices; batch.deadIndices += e.indices;
    stats.removes++;
    if (batch.entries.size === 0) {
      group.remove(batch.mesh); batch.mesh.dispose(); batches.splice(batches.indexOf(batch), 1);
    } else if (batch.deadVertices > cfg.vertices * cfg.compactWhenUnusedFraction) {
      batch.mesh.optimize(); batch.deadVertices = 0; batch.deadIndices = 0; stats.compactions++;
    }
    return true;
  }

  function setVisible(key, visible) {
    const batch = byKey.get(key);
    if (!batch) return false;
    batch.mesh.setVisibleAt(batch.entries.get(key).instanceId, !!visible);
    return true;
  }

  function setMaterial(mat) {
    currentMaterial = mat;
    for (const b of batches) b.mesh.material = mat;
  }

  return {
    group,
    add, remove, setVisible, setMaterial,
    has: key => byKey.has(key),
    get batchCount() { return batches.length; },
    get chunkCount() { return byKey.size; },
    get material() { return currentMaterial; },
    get stats() {
      let used = 0, capacity = 0;
      for (const b of batches) { used += cfg.vertices - b.mesh.unusedVertexCount; capacity += cfg.vertices; }
      return { batches: batches.length, chunks: byKey.size, verticesUsed: used, verticesCapacity: capacity, ...stats };
    },
    clear() { for (const b of batches) { group.remove(b.mesh); b.mesh.dispose(); } batches.length = 0; byKey.clear(); },
    dispose() { this.clear(); group.removeFromParent(); },
  };
}
