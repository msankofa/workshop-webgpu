// terrain-chunk-batches.js — resident terrain chunks pooled into BatchedMesh. On the WebGPU
// backend this does NOT reduce draw calls: WebGPUBackend._draw issues one drawIndexed per visible
// geometry in a JS loop (no multi-draw path exists in WebGPU). What a batch buys is one scene
// object instead of one per chunk — one RenderObject, one pipeline + bind-group set, no per-mesh
// matrix uploads — and the add/remove/compact lifecycle for streamed chunks. A chunk is copied in
// when it lands and deleted when it unloads; batches are allocated on demand with a fixed
// slot/vertex budget and compacted with optimize() once deletions have fragmented them.
// Geometry stays global: every instance matrix is identity, so object-space == world-space.

import * as THREE from 'three';

export const CHUNK_BATCH_DEFAULTS = Object.freeze({
  slots: 256,             // geometries per batch
  vertices: 600_000,      // vertex budget per batch (~2.3k per chunk)
  indices: 3_600_000,     // heightfield chunks run ~5.5 indices per vertex
  maxBatches: 64,         // beyond this chunks fall back to their own mesh
  compactWhenUnusedFraction: 0.35,   // optimize() a batch once this much of its space is dead
  maxCompactionsPerFrame: 0,         // optimize() rewrites the whole buffer; 0 = unlimited
                                     // Opt in with a positive value AND a beginFrame() per frame:
                                     // without the reset the ration would never refill.
  perObjectFrustumCulled: false,     // off: onBeforeRender early-outs (with sortObjects false)
                                     // instead of a per-instance sphere/frustum loop per camera
                                     // per pass; every visible chunk is submitted (one drawIndexed
                                     // each on WebGPU either way). true restores per-chunk culling.
});

export function createChunkBatcher({ material, name = 'terrain-chunk-batches', ...opts } = {}) {
  const cfg = { ...CHUNK_BATCH_DEFAULTS, ...opts };
  const group = new THREE.Group();
  group.name = name;
  const batches = [];          // { mesh, entries: Map key -> { geometryId, instanceId }, deadVertices }
  const byKey = new Map();     // key -> batch
  let currentMaterial = material;
  const stats = { adds: 0, removes: 0, fallbacks: 0, compactions: 0, compactionsDeferred: 0 };
  // optimize() rewrites every vertex and index in the batch and re-uploads it. More than one in a
  // frame is what turns a chunk landing into a visible hitch, so they are rationed; a caller that
  // cannot compact just leaves the chunk drawing its own mesh for a frame.
  let compactionsThisFrame = 0;
  const canCompact = () => cfg.maxCompactionsPerFrame <= 0 || compactionsThisFrame < cfg.maxCompactionsPerFrame;
  function compact(batch) {
    batch.mesh.optimize();
    batch.deadVertices = 0;
    batch.deadIndices = 0;
    stats.compactions++;
    compactionsThisFrame++;
  }

  function newBatch() {
    const mesh = new THREE.BatchedMesh(cfg.slots, cfg.vertices, cfg.indices, currentMaterial);
    mesh.name = `${name}-${batches.length}`;
    mesh.frustumCulled = false;        // whole-batch bounds never maintained
    mesh.perObjectFrustumCulled = !!cfg.perObjectFrustumCulled;
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
      if (!canCompact()) { stats.compactionsDeferred++; return false; }
      compact(batch);
      if (batch.mesh.unusedVertexCount < verts || batch.mesh.unusedIndexCount < idx) return false;
    }
    let geometryId;
    try { geometryId = batch.mesh.addGeometry(geometry); }
    catch {
      // unused space exists but is fragmented: compact and retry once
      if (!canCompact()) { stats.compactionsDeferred++; return false; }
      compact(batch);
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
    } else if (batch.deadVertices > cfg.vertices * cfg.compactWhenUnusedFraction && canCompact()) {
      // Opportunistic only: skipping it leaves deadVertices over the threshold, so the next
      // remove or add compacts instead.
      compact(batch);
    }
    return true;
  }

  // The pair of setVisible: whether a batched chunk is currently drawn.
  function isVisible(key) {
    const batch = byKey.get(key);
    if (!batch) return false;
    return batch.mesh.getVisibleAt(batch.entries.get(key).instanceId);
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
    add, remove, setVisible, isVisible, setMaterial,
    // Refills the per-frame compaction ration. Required whenever maxCompactionsPerFrame > 0.
    beginFrame() { compactionsThisFrame = 0; },
    has: key => byKey.has(key),
    get batchCount() { return batches.length; },
    get chunkCount() { return byKey.size; },
    // GPU draw calls these batches submit: one drawIndexed per visible instance on WebGPU
    // (pre-frustum-cull upper bound when perObjectFrustumCulled is true).
    get drawCount() {
      let n = 0;
      for (const b of batches) for (const e of b.entries.values()) if (b.mesh.getVisibleAt(e.instanceId)) n++;
      return n;
    },
    get material() { return currentMaterial; },
    get stats() {
      let used = 0, capacity = 0;
      for (const b of batches) { used += cfg.vertices - b.mesh.unusedVertexCount; capacity += cfg.vertices; }
      return { batches: batches.length, chunks: byKey.size, draws: this.drawCount, verticesUsed: used, verticesCapacity: capacity, ...stats };
    },
    clear() { for (const b of batches) { group.remove(b.mesh); b.mesh.dispose(); } batches.length = 0; byKey.clear(); },
    dispose() { this.clear(); group.removeFromParent(); },
  };
}
