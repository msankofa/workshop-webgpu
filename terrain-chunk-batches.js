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
  maxCompactionsPerFrame: 0,         // optimize() shifts and re-uploads only the geometries after
                                     // the earliest gap (one ranged write each); 0 = unlimited
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
  // Upload accounting. Every byte here is LOGICAL: the size of the update ranges this module made
  // dirty, not what the renderer submitted. The backend issues one writeBuffer per range and does
  // not coalesce, so submitted bytes are >= these; agent A counts the submitted side.
  const newUpload = () => ({
    firstUploads: 0, firstUploadBytes: 0,      // a chunk copied into a batch for the first time
    visibilityFlips: 0,                        // setVisibleAt calls that changed a value
    fallbacks: 0,                              // did not fit any batch: the chunk drew its own mesh
    compactions: 0, compactionShifts: 0, compactionBytes: 0,   // geometries moved by optimize()
  });
  const upload = newUpload();       // cumulative since creation
  const frameUpload = newUpload();  // since the last takeFrameUpload()
  const bump = (field, n) => { upload[field] += n; frameUpload[field] += n; };
  // Sum the update ranges a mutation appended to the batch geometry, in bytes. Ranges are cleared
  // by the renderer after upload, so lengths are only compared inside one synchronous call.
  function measureRanges(mesh, run) {
    // Read the parts AFTER the run too: the first addGeometry is what creates them.
    const partsOf = () => { const g = mesh.geometry; return [['index', g.index], ...Object.entries(g.attributes)].filter(p => p[1]); };
    const before = new Map(partsOf().map(([k, p]) => [k, p.updateRanges.length]));
    run();
    let bytes = 0, ranges = 0;
    for (const [k, p] of partsOf()) {
      for (let i = before.get(k) ?? 0; i < p.updateRanges.length; i++) { bytes += p.updateRanges[i].count * p.array.BYTES_PER_ELEMENT; ranges++; }
    }
    return { bytes, ranges };
  }
  // optimize() shifts every geometry after the earliest gap and marks one range per shifted
  // geometry; the worst case is the whole tail, the typical case is smaller and a batch whose only
  // dead entries are trailing compacts for free. The throttle stays because the CPU copyWithin and
  // that tail case are both real.
  let compactionsThisFrame = 0;
  const canCompact = () => cfg.maxCompactionsPerFrame <= 0 || compactionsThisFrame < cfg.maxCompactionsPerFrame;
  function compact(batch) {
    // one position range per shifted geometry, so count position ranges rather than all attributes
    const pos = batch.mesh.geometry.attributes.position;
    const posBefore = pos ? pos.updateRanges.length : 0;
    const m = measureRanges(batch.mesh, () => batch.mesh.optimize());
    batch.deadVertices = 0;
    batch.deadIndices = 0;
    stats.compactions++;
    compactionsThisFrame++;
    bump('compactions', 1);
    bump('compactionShifts', pos ? pos.updateRanges.length - posBefore : 0);
    bump('compactionBytes', m.bytes);
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
    let geometryId, wrote = 0;
    const run = () => { const m = measureRanges(batch.mesh, () => { geometryId = batch.mesh.addGeometry(geometry); }); wrote = m.bytes; };
    try { run(); }
    catch {
      // unused space exists but is fragmented: compact and retry once
      if (!canCompact()) { stats.compactionsDeferred++; return false; }
      compact(batch);
      try { run(); } catch { return false; }
    }
    bump('firstUploads', 1);
    bump('firstUploadBytes', wrote);
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
    bump('fallbacks', 1);
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
    const id = batch.entries.get(key).instanceId;
    // A flip is the module's only in-place mutation: it costs a whole indirect-texture upload and
    // an onBeforeRender that cannot early-out, so it is counted even though no attribute is dirtied.
    if (batch.mesh.getVisibleAt(id) !== !!visible) bump('visibilityFlips', 1);
    batch.mesh.setVisibleAt(id, !!visible);
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
    // Read-and-clear this frame's upload counters. Separate from beginFrame() on purpose: the page
    // calls beginFrame twice per frame (two material passes), which would zero them mid-frame.
    takeFrameUpload() {
      const out = { ...frameUpload };
      Object.assign(frameUpload, newUpload());
      return out;
    },
    has: key => byKey.has(key),
    get batchCount() { return batches.length; },
    get chunkCount() { return byKey.size; },
    // Chunks currently holding a batch slot. Same number as chunkCount, named for the residency
    // reading (resident vs the streamer's target set) that sizes margin-chunk overdraw.
    get residentCount() { return byKey.size; },
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
      return { batches: batches.length, chunks: byKey.size, resident: byKey.size, draws: this.drawCount,
        verticesUsed: used, verticesCapacity: capacity, ...stats, upload: { ...upload } };
    },
    clear() { for (const b of batches) { group.remove(b.mesh); b.mesh.dispose(); } batches.length = 0; byKey.clear(); },
    dispose() { this.clear(); group.removeFromParent(); },
  };
}
