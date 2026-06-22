// Headless integration test for the worker-backed TerrainSystem. Stubs a fake
// Worker (which runs the same buildChunkArrays the real worker does, replying
// asynchronously) so we can exercise streaming, movement/unload, epoch
// invalidation on rebuild, pendingBuildCount accounting, and the sync fallback —
// all without a browser. Run: node test-terrain-system.mjs
import { buildChunkArrays } from './terrain-field.js';

let workerShouldThrow = false;
let dispatched = 0;

class FakeWorker {
  constructor() { this.onmessage = null; this.onerror = null; this._alive = true; }
  postMessage(msg) {
    dispatched++;
    setTimeout(() => {
      if (!this._alive || !this.onmessage) return;
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

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
