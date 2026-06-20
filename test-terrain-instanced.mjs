// Headless integration checks for the instanced terrain render path.
// The worker-backed chunk stream is still used for compatibility metadata and
// collision, but renderable terrain should stay collapsed to one InstancedMesh.
import { buildChunkArrays, buildHeightTile } from './terrain-field.js';

class FakeWorker {
  constructor() { this.onmessage = null; this._alive = true; }
  postMessage(msg) {
    setTimeout(() => {
      if (!this._alive || !this.onmessage) return;
      if (msg.jobType === 'heightTile') {
        const t = buildHeightTile(msg.xMin, msg.zMin, msg.size, msg.texelWorld, msg.params, msg.apron);
        this.onmessage({ data: { key: msg.key, epoch: msg.epoch, jobType: 'heightTile', heights: t.heights, texels: t.texels } });
        return;
      }
      const a = buildChunkArrays(msg.xMin, msg.zMin, msg.size, msg.segments, msg.params, msg.computeNormals);
      this.onmessage({ data: { key: msg.key, epoch: msg.epoch, positions: a.positions, normals: a.normals, uvs: a.uvs, index: a.index } });
    }, 0);
  }
  terminate() { this._alive = false; }
}
globalThis.Worker = function () { return new FakeWorker(); };

const { createTerrainSystem } = await import('./terrain-system.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const tick = () => new Promise((r) => setTimeout(r, 1));
const expected = (r) => (2 * r + 1) ** 2;

async function settle(sys, cx, cz, maxIters = 600) {
  for (let i = 0; i < maxIters; i++) {
    sys.update(cx, cz);
    await tick();
    const stale = [...sys.chunks.keys()].some((k) => !sys.targetKeys.has(k));
    if (sys.pendingBuildCount === 0 && !stale) return i;
  }
  return maxIters;
}

function terrainRenderChildren(sys) {
  return sys.group.children.filter((child) => child.name.startsWith('Terrain'));
}

console.log('\n[1] instanced mode keeps one render object while chunks stream');
{
  const safe = createTerrainSystem({
    params: { baseAmp: 1, lake: 0.45, lakeDepth: 3.2, renderRadius: 1, chunkSize: 30, renderMode: 'instanced' },
  });
  ok(safe.renderMode === 'chunks', 'instanced requests fall back to chunks unless experimentalInstancedTerrain is set');
  safe.dispose();

  const sys = createTerrainSystem({
    params: { baseAmp: 1, lake: 0.45, lakeDepth: 3.2, renderRadius: 2, chunkSize: 30, renderMode: 'instanced', experimentalInstancedTerrain: true },
  });
  ok(sys.renderMode === 'instanced', `renderMode ${sys.renderMode}`);
  ok(sys.instancedTerrain !== null, 'instanced terrain mesh created during initial update');
  ok(sys.instancedTerrain.count === expected(2), `instance count ${sys.instancedTerrain.count}/${expected(2)}`);
  ok(terrainRenderChildren(sys).length === 1, `terrain render children ${terrainRenderChildren(sys).length}`);

  await settle(sys, 0, 0);
  ok(sys.chunks.size === expected(2), `compat chunks loaded ${sys.chunks.size}/${expected(2)}`);
  ok(sys.activeChunks.length === expected(2), `activeChunks ${sys.activeChunks.length}/${expected(2)}`);
  ok(terrainRenderChildren(sys).length === 1, `terrain render children after streaming ${terrainRenderChildren(sys).length}`);
  ok(sys.atlasSlots.size === expected(2), `atlas slots assigned ${sys.atlasSlots.size}/${expected(2)}`);
  ok(sys.heightAtlasData.some((v) => v !== 0), 'height atlas populated from worker height-tile jobs');
  ok(!sys.group.children.some((child) => child.name.startsWith('TerrainChunk:')), 'chunk meshes are not attached to render group');
  sys.dispose();
  ok(sys.group.children.length === 0, `render group empty after dispose (${sys.group.children.length})`);
}

console.log('\n[2] draw distance changes update instance count without adding render objects');
{
  const sys = createTerrainSystem({
    params: { baseAmp: 1, lake: 0.45, lakeDepth: 3.2, renderRadius: 1, chunkSize: 30, renderMode: 'instanced', experimentalInstancedTerrain: true },
  });
  ok(sys.instancedTerrain.count === expected(1), `initial instance count ${sys.instancedTerrain.count}/${expected(1)}`);
  sys.params.renderRadius = 3;
  sys.update(0, 0);
  ok(sys.instancedTerrain.count === expected(3), `grown instance count ${sys.instancedTerrain.count}/${expected(3)}`);
  ok(terrainRenderChildren(sys).length === 1, `terrain render children after grow ${terrainRenderChildren(sys).length}`);
  sys.dispose();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
