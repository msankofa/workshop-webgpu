// Headless integration test for the worker-backed TerrainSystem. Stubs a fake
// Worker (which runs the same buildChunkArrays the real worker does, replying
// asynchronously) so we can exercise streaming, movement/unload, epoch
// invalidation on rebuild, pendingBuildCount accounting, and the sync fallback —
// all without a browser. Run: node test-terrain-system.mjs
import { buildChunkArrays, buildChunkArraysFromTile, terrainHeightAt } from './terrain-field.js';
import { createSource, normalizeDescriptor } from './terrain-source.js';
import { analyticDescriptor } from './terrain-source-analytic.js';

let workerShouldThrow = false;
let dispatched = 0;

class FakeWorker {
  constructor() { this.onmessage = null; this.onerror = null; this._alive = true; }
  postMessage(msg) {
    dispatched++;
    setTimeout(() => {
      if (!this._alive || !this.onmessage) return;
      if (msg.jobType === 'sourceTile') {
        // Same contract as the real worker: build the source from its descriptor alone.
        try {
          const tile = createSource(msg.descriptor).buildTile(msg.request);
          this.onmessage({ data: { ...tile, key: msg.key, epoch: msg.epoch, jobType: 'sourceTile', sourceKey: msg.descriptor.key, sourceVersion: msg.descriptor.sourceVersion } });
        } catch (err) {
          this.onmessage({ data: { key: msg.key, epoch: msg.epoch, jobType: 'sourceTile', error: String(err.message), contractError: true } });
        }
        return;
      }
      const a = buildChunkArrays(msg.xMin, msg.zMin, msg.size, msg.segments, msg.params, msg.computeNormals);
      this.onmessage({ data: { key: msg.key, epoch: msg.epoch, positions: a.positions, normals: a.normals, uvs: a.uvs, index: a.index } });
    }, 0);
  }
  terminate() { this._alive = false; }
}
globalThis.Worker = function (url, opts) {
  if (workerShouldThrow) throw new Error('no worker support (simulated)');
  return new FakeWorker(url, opts);
};

const { createTerrainSystem } = await import('./terrain-system.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const tick = () => new Promise((r) => setTimeout(r, 1));

// Drive update()+tick until fully converged: nothing pending to build AND no
// stale chunks left to unload (unloads are rate-limited to maxUnloadsPerUpdate,
// so this mirrors the real per-frame update loop running to completion).
async function settle(sys, cx, cz, maxIters = 600) {
  for (let i = 0; i < maxIters; i++) {
    sys.update(cx, cz);
    await tick();
    const stale = [...sys.chunks.keys()].some((k) => !sys.targetKeys.has(k));
    if (sys.pendingBuildCount === 0 && !stale) return i;
  }
  return maxIters;
}

const baseParams = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2, renderRadius: 1, chunkSize: 30 };
const expected = (r) => (2 * r + 1) ** 2;

// ---------------- 1. worker streaming fills the ring ----------------
console.log('\n[1] worker streaming (renderRadius 1 -> 9 chunks)');
{
  const sys = createTerrainSystem({ params: { ...baseParams } });
  ok(sys.worker !== null, 'worker created');
  ok(sys.primaryMesh !== null, 'cold-start seeded primaryMesh synchronously (non-null after construct)');
  ok(sys.materialPatchTarget !== null, 'materialPatchTarget non-null at construct (water can bind)');
  await settle(sys, 0, 0);
  ok(sys.chunks.size === expected(1), `loaded ${sys.chunks.size}/${expected(1)} chunks`);
  ok(sys.activeChunks.length === expected(1), `activeChunks ${sys.activeChunks.length}/${expected(1)}`);
  ok(sys.pendingBuildCount === 0, `pendingBuildCount ${sys.pendingBuildCount}`);
  ok(sys.targetChunkCount === expected(1), `targetChunkCount ${sys.targetChunkCount}`);
  ok(dispatched > 0, `worker actually used (dispatched ${dispatched} jobs)`);
  // geometry sanity on a streamed chunk
  const anyMesh = [...sys.chunks.values()][0].mesh;
  ok(anyMesh.geometry.attributes.position.count > 0, 'streamed chunk has vertices');
  ok(!!anyMesh.geometry.attributes.normal, 'streamed chunk has normals');
  sys.dispose();
}

// ---------------- 2. movement loads new + unloads old, count stays bounded ----------------
console.log('\n[2] movement streams new region and unloads old');
{
  const sys = createTerrainSystem({ params: { ...baseParams } });
  await settle(sys, 0, 0);
  const before = new Set(sys.chunks.keys());
  await settle(sys, 1000, 1000);
  ok(sys.chunks.size === expected(1), `after move chunks.size ${sys.chunks.size}/${expected(1)} (old unloaded)`);
  const after = new Set(sys.chunks.keys());
  let overlap = 0; for (const k of after) if (before.has(k)) overlap++;
  ok(overlap === 0, `no stale chunks from old region (overlap ${overlap})`);
  ok(sys.activeChunks.every((c) => sys.targetKeys.has(c.key)), 'all activeChunks are in targetKeys');
  ok(sys.pendingBuildCount === 0, `pendingBuildCount ${sys.pendingBuildCount}`);
  sys.dispose();
}

// ---------------- 3. rebuild() bumps epoch; stale in-flight results are dropped ----------------
console.log('\n[3] rebuild invalidates in-flight (epoch) and refills');
{
  const sys = createTerrainSystem({ params: { ...baseParams } });
  sys.update(0, 0);                 // dispatches in-flight jobs at epoch E
  const epochBefore = sys.epoch;
  sys.rebuild({ lakeDepth: 5.0 });  // bump epoch, clear chunks/in-flight
  ok(sys.epoch === epochBefore + 1, `epoch bumped ${epochBefore} -> ${sys.epoch}`);
  await tick();                      // let the stale (old-epoch) messages arrive
  // any chunk that slipped through must NOT be from the old epoch — verify by refilling cleanly
  await settle(sys, 0, 0);
  ok(sys.chunks.size === expected(1), `refilled ${sys.chunks.size}/${expected(1)} after rebuild`);
  ok(sys.params.lakeDepth === 5.0, 'rebuild applied new param');
  ok(sys.pendingBuildCount === 0, `pendingBuildCount ${sys.pendingBuildCount}`);
  sys.dispose();
}

// ---------------- 4. renderRadius change at fixed center restreams ----------------
console.log('\n[4] live renderRadius change restreams');
{
  const sys = createTerrainSystem({ params: { ...baseParams } });
  await settle(sys, 0, 0);
  ok(sys.chunks.size === expected(1), `start ${sys.chunks.size}/${expected(1)}`);
  sys.params.renderRadius = 2;       // 5x5 = 25
  await settle(sys, 0, 0);
  ok(sys.chunks.size === expected(2), `grew to ${sys.chunks.size}/${expected(2)}`);
  sys.params.renderRadius = 1;
  await settle(sys, 0, 0);
  ok(sys.chunks.size === expected(1), `shrank to ${sys.chunks.size}/${expected(1)}`);
  sys.dispose();
}

// ---------------- 5. synchronous fallback when Worker construction throws ----------------
console.log('\n[5] sync fallback (no worker)');
{
  workerShouldThrow = true;
  const sys = createTerrainSystem({ params: { ...baseParams } });
  ok(sys.worker === null, 'worker disabled (construction threw)');
  // sync path builds everything within a few updates, no ticks needed
  for (let i = 0; i < 30 && sys.chunks.size < expected(1); i++) sys.update(0, 0);
  ok(sys.chunks.size === expected(1), `sync-built ${sys.chunks.size}/${expected(1)} chunks`);
  ok(sys.pendingBuildCount === 0, `pendingBuildCount ${sys.pendingBuildCount}`);
  ok(sys.activeChunks.length === expected(1), `activeChunks ${sys.activeChunks.length}`);
  sys.dispose();
  workerShouldThrow = false;
}

// ---------------- 6. external visual mode: records only, analytic height still works ----------------
console.log('\n[6] external visual mode (SP3: GPU CDLOD renders the ground)');
{
  const sys = createTerrainSystem({ params: { ...baseParams, visualMode: 'external' } });
  await settle(sys, 0, 0);
  ok(sys.chunks.size === expected(1), `external built ${sys.chunks.size}/${expected(1)} records`);
  ok(sys.activeChunks.length === expected(1), `activeChunks populated ${sys.activeChunks.length}/${expected(1)}`);
  ok([...sys.chunks.values()].every((c) => c.mesh === null), 'no visual chunk meshes created');
  ok(sys.group.children.length === 0, `terrain group has no visible children (${sys.group.children.length})`);
  ok(sys.materialPatchTarget === null, 'materialPatchTarget null (host points ground at CDLOD mesh)');
  ok(Number.isFinite(sys.getHeight(3, 7)), 'analytic getHeight still works (SP5a: collision reads this directly)');
  ok(sys.activeChunks.every((c) => 'centerX' in c && 'size' in c), 'activeChunks carry decoration metadata');
  ok(sys.pendingBuildCount === 0, `pendingBuildCount ${sys.pendingBuildCount}`);
  sys.dispose();
}

// ---------------- 7. injected source streams through the worker ----------------
const srcParamsA = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };
const srcParamsB = { baseAmp: 2.5, lake: 0.2, lakeDepth: 1.0 };
const descA = analyticDescriptor({ key: 'lab', sourceVersion: 'A', params: srcParamsA });
const descB = analyticDescriptor({ key: 'lab', sourceVersion: 'B', params: srcParamsB });
const chunkMeta = (sys) => [...sys.chunks.values()].map((c) => c.meta);

console.log('\n[7] injected source (descriptor) streams chunks from source tiles');
{
  const sys = createTerrainSystem({ params: { ...baseParams }, source: JSON.parse(JSON.stringify(descA)) });
  ok(sys.source && sys.source.descriptor.key === 'lab', 'source built from a plain JSON descriptor');
  ok(sys.sourceInfo.kind === 'analytic' && sys.sourceInfo.version === 'A', `sourceInfo ${sys.sourceInfo.kind}@${sys.sourceInfo.version}`);
  await settle(sys, 0, 0);
  ok(sys.chunks.size === expected(1), `loaded ${sys.chunks.size}/${expected(1)} chunks`);
  ok(dispatched > 0, 'worker used');
  ok(chunkMeta(sys).every((m) => m.sourceKey === 'lab' && m.sourceVersion === 'A' && m.lod === 0), 'chunk metadata carries source key/version/lod');
  ok(chunkMeta(sys).every((m) => m.tileKey === `lab@A|e${sys.epoch}|l0|${m.key}`), 'chunk metadata carries the full tile key');
  ok(sys.activeChunks.every((c) => c.sourceVersion === 'A' && c.stale === false), 'activeChunks expose source identity');
  // geometry equals the legacy builder for the same field (source tiles are bit-identical to terrain-field)
  const c = sys.chunks.get('0,0');
  const seg = c.meta.segments;
  const ref = buildChunkArrays(0, 0, 30, seg, srcParamsA, true);
  const pos = c.mesh.geometry.attributes.position.array;
  let maxD = 0; for (let i = 0; i < ref.positions.length; i++) maxD = Math.max(maxD, Math.abs(pos[i] - ref.positions[i]));
  ok(maxD === 0, `source-built chunk positions identical to buildChunkArrays (delta ${maxD})`);
  ok(sys.getHeight(4, 9) === terrainHeightAt(srcParamsA, 4, 9), 'getHeight reads the source');
  sys.dispose();
}

// ---------------- 8. setSource: stale in-flight results from the old source are dropped ----------------
console.log('\n[8] setSource drops old-source in-flight results (epoch)');
{
  const sys = createTerrainSystem({ params: { ...baseParams }, source: descA });
  sys.update(0, 0);                   // dispatch jobs for source A
  const epochBefore = sys.epoch;
  sys.setSource(descB);
  ok(sys.epoch === epochBefore + 1, `epoch bumped ${epochBefore} -> ${sys.epoch}`);
  await tick();                       // old-epoch replies land now
  ok([...sys.chunks.values()].every((c) => c.stale || c.meta.sourceVersion === 'B'), 'no fresh chunk from source A after the swap');
  await settle(sys, 0, 0);
  ok(sys.chunks.size === expected(1), `refilled ${sys.chunks.size}/${expected(1)}`);
  ok(chunkMeta(sys).every((m) => m.sourceVersion === 'B'), 'every chunk now from source B');
  ok([...sys.chunks.values()].every((c) => !c.stale), 'no stale chunks remain');
  ok(sys.getHeight(4, 9) === terrainHeightAt(srcParamsB, 4, 9), 'getHeight switched to source B');
  sys.dispose();
}

// ---------------- 9. setSource keeps old chunks until replacements are ready (no hole) ----------------
console.log('\n[9] setSource drops the old chunks at once; restream({ drop: false }) keeps them until replaced');
{
  const sysDrop = createTerrainSystem({ params: { ...baseParams }, source: descA });
  await settle(sysDrop, 0, 0);
  sysDrop.setSource(descB);
  ok(sysDrop.chunks.size === 0 && sysDrop.group.children.length === 0, 'default swap: no old chunk survives, scene group empty');
  await settle(sysDrop, 0, 0);
  ok(sysDrop.chunks.size === expected(1) && chunkMeta(sysDrop).every((m) => m.sourceVersion === 'B'), `refilled from source B (${sysDrop.chunks.size})`);
  sysDrop.dispose();

  const { createSource } = await import('./terrain-source.js');
  const sys = createTerrainSystem({ params: { ...baseParams }, source: descA });
  await settle(sys, 0, 0);
  const meshesBefore = new Map([...sys.chunks].map(([k, c]) => [k, c.mesh]));
  sys.source = createSource(descB);
  sys.restream({ drop: false });
  ok(sys.chunks.size === expected(1), `drop:false keeps the chunks (${sys.chunks.size})`);
  ok([...sys.chunks.values()].every((c) => c.stale), 'retained chunks are marked stale');
  ok(sys.group.children.length === expected(1), 'retained meshes still in the scene group');
  let minResident = Infinity, replacedCount = 0;
  for (let i = 0; i < 600; i++) {
    sys.update(0, 0);
    await tick();
    minResident = Math.min(minResident, [...sys.chunks.keys()].filter((k) => sys.targetKeys.has(k)).length);
    replacedCount = [...sys.chunks].filter(([k, c]) => meshesBefore.get(k) !== c.mesh).length;
    if (sys.pendingBuildCount === 0 && replacedCount === expected(1)) break;
  }
  ok(minResident === expected(1), `resident target chunks never dropped below ${expected(1)} (min ${minResident})`);
  ok(replacedCount === expected(1), `all ${replacedCount}/${expected(1)} chunks replaced with new meshes`);
  ok(sys.group.children.length === expected(1), `scene group holds exactly ${sys.group.children.length} meshes (old disposed)`);
  ok(chunkMeta(sys).every((m) => m.sourceVersion === 'B'), 'replacements are from source B');
  sys.dispose();
}

// ---------------- 10. finite bounds: no chunks outside the source's map ----------------
console.log('\n[10] finite source bounds limit the target window');
{
  const finite = normalizeDescriptor({ ...descA, capabilities: ['heights', 'normals'], bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 } });
  const sys = createTerrainSystem({ params: { ...baseParams }, source: finite });
  await settle(sys, 0, 0);
  ok(sys.targetChunkCount === 4, `target chunks ${sys.targetChunkCount}/4 (2x2 inside ±30)`);
  ok(sys.chunks.size === 4, `loaded ${sys.chunks.size}/4`);
  ok([...sys.chunks.values()].every((c) => c.xMin >= -30 && c.xMin + c.size <= 30 && c.zMin >= -30 && c.zMin + c.size <= 30), 'every chunk lies inside bounds');
  await settle(sys, 500, 500);
  ok(sys.targetChunkCount === 0 && sys.chunks.size === 0, `far outside bounds: ${sys.targetChunkCount} targets, ${sys.chunks.size} chunks`);
  ok(sys.source.contains(500, 500) === false && sys.source.contains(0, 0) === true, 'contains() respects bounds');
  sys.dispose();
}

// ---------------- 11. injected source, sync fallback + external mode ----------------
console.log('\n[11] injected source on the sync fallback and external visual mode');
{
  workerShouldThrow = true;
  const sys = createTerrainSystem({ params: { ...baseParams }, source: descA });
  for (let i = 0; i < 30 && sys.chunks.size < expected(1); i++) sys.update(0, 0);
  ok(sys.chunks.size === expected(1), `sync-built ${sys.chunks.size}/${expected(1)} from the source`);
  ok(chunkMeta(sys).every((m) => m.sourceVersion === 'A'), 'sync chunks carry source identity');
  sys.dispose();
  const ext = createTerrainSystem({ params: { ...baseParams, visualMode: 'external' }, source: descA });
  for (let i = 0; i < 30 && ext.chunks.size < expected(1); i++) ext.update(0, 0);
  ok(ext.chunks.size === expected(1) && [...ext.chunks.values()].every((c) => c.mesh === null), 'external mode keeps records only');
  ext.dispose();
  workerShouldThrow = false;
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
