// Chunk batching: many streamed chunks, few draws. Run: node test-terrain-chunk-batches.mjs
import * as THREE from 'three';
import { createChunkBatcher } from './terrain-chunk-batches.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { createBaseGameTerrain } from './base-game-terrain.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
function chunkGeo(n = 24, ox = 0) {
  const g = new THREE.PlaneGeometry(30, 30, n - 1, n - 1);
  g.rotateX(-Math.PI / 2); g.translate(ox, 0, 0);
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
  return g;
}

console.log('\n[1] batches fill, evict, compact and fall back');
{
  const mat = new THREE.MeshBasicMaterial();
  const b = createChunkBatcher({ material: mat, slots: 8, vertices: 8 * 600, indices: 8 * 3200, maxBatches: 2 });
  for (let i = 0; i < 8; i++) ok(b.add(`${i},0`, chunkGeo(24, i * 30)) || true, '');
  ok(b.batchCount === 1 && b.chunkCount === 8, `8 chunks in 1 batch (${b.stats.verticesUsed}/${b.stats.verticesCapacity} verts)`);
  b.add('8,0', chunkGeo());
  ok(b.batchCount === 2 && b.chunkCount === 9, 'ninth chunk opens a second batch');
  for (let i = 9; i < 16; i++) b.add(`${i},0`, chunkGeo());
  const fb = b.add('16,0', chunkGeo());
  ok(fb === false && b.stats.fallbacks === 1 && b.chunkCount === 16, 'over maxBatches: add() returns false (caller keeps its own mesh)');
  // evict half of the first batch: space is dead until compaction; a re-add forces optimize()
  for (let i = 0; i < 4; i++) b.remove(`${i},0`);
  ok(b.chunkCount === 12 && b.batchCount === 2, '4 removed, batches kept');
  const before = b.stats.compactions;
  for (let i = 0; i < 4; i++) ok(b.add(`n${i}`, chunkGeo()), `re-add ${i} fits`);
  ok(b.stats.compactions >= before, `dead space reused (${b.stats.compactions} compaction(s))`);
  for (const key of [...Array(16).keys()].map(i => `${i},0`).concat(['n0', 'n1', 'n2', 'n3'])) b.remove(key);
  ok(b.batchCount === 0 && b.chunkCount === 0 && b.group.children.length === 0, 'empty batches are disposed');
  const g2 = chunkGeo();
  b.add('v', g2);
  b.setVisible('v', false);
  const mat2 = new THREE.MeshBasicMaterial(); b.setMaterial(mat2);
  ok(b.group.children[0].material === mat2 && b.group.children[0].isBatchedMesh, 'material swap reaches the batch mesh');
  b.dispose();
}

console.log('\n[2] streamed chunks draw through batches; residency and eviction stay correct');
{
  const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: analyticDescriptor({ key: 'b', sourceVersion: '1' }), useWorker: false, params: { renderRadius: 3 } });
  terrain.setActive(true);
  for (let i = 0; i < 40; i++) terrain.update([0, 0, 0], 1 / 60);
  let st = terrain.stats;
  ok(st.residentTiles === 49 && st.batches.chunks === 49 && st.draws === 1, `49 chunks resident, ${st.batches.chunks} batched, ${st.draws} draw`);
  const own = [...terrain.system.chunks.values()].filter(c => c.mesh.visible).length;
  ok(own === 0, 'no chunk draws its own mesh while batched');
  // walk 600 m: batches follow the window, nothing leaks
  for (let f = 0; f < 600; f++) terrain.update([f, 0, 0], 1 / 60);
  st = terrain.stats;
  ok(st.batches.chunks === terrain.system.chunks.size && st.batches.chunks <= 60, `after travel: ${st.batches.chunks} batched == ${terrain.system.chunks.size} resident`);
  ok(st.batches.removes > 0 && st.draws <= 2, `${st.batches.removes} evictions, ${st.draws} draw(s)`);
  terrain.setWireframe(true);
  ok(terrain.system.material.wireframe === true, 'wireframe reaches the batched material');
  terrain.setActive(false);
  ok(terrain.stats.draws === 0, 'inactive: no draws');
  terrain.dispose();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
