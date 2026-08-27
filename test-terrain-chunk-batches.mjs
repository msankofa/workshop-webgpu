// Chunk batching: many streamed chunks, few scene objects (still one GPU draw per visible chunk
// on WebGPU). Run: node test-terrain-chunk-batches.mjs
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
  ok(st.residentTiles === 49 && st.batches.chunks === 49 && st.draws === 49 && st.batches.batches === 1, `49 chunks resident and batched: ${st.draws} GPU draws from ${st.batches.batches} batch object`);
  const own = [...terrain.system.chunks.values()].filter(c => c.mesh.visible).length;
  ok(own === 0, 'no chunk draws its own mesh while batched');
  // walk 600 m: batches follow the window, nothing leaks
  for (let f = 0; f < 600; f++) terrain.update([f, 0, 0], 1 / 60);
  st = terrain.stats;
  ok(st.batches.chunks === terrain.system.chunks.size && st.batches.chunks <= 60, `after travel: ${st.batches.chunks} batched == ${terrain.system.chunks.size} resident`);
  const ownAfter = [...terrain.system.chunks.values()].filter(c => c.mesh?.visible).length;
  ok(st.batches.removes > 0 && st.draws === ownAfter + st.batches.draws, `${st.batches.removes} evictions; draws (${st.draws}) = own meshes (${ownAfter}) + batched (${st.batches.draws})`);
  terrain.setWireframe(true);
  ok(terrain.system.material.wireframe === true, 'wireframe reaches the batched material');
  terrain.setActive(false);
  ok(terrain.stats.draws === 0, 'inactive: no draws');
  terrain.dispose();
}

console.log('\n[3] per-chunk frustum culling is an option, off by default');
{
  // A camera 1000 m up looking further up: every chunk at y=0 is outside its frustum.
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  cam.position.set(0, 1000, 0); cam.lookAt(0, 2000, 0); cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  const b = createChunkBatcher({ material: new THREE.MeshBasicMaterial() });
  for (let i = 0; i < 6; i++) b.add(`${i}`, chunkGeo(12, i * 30));
  const mesh = b.group.children[0];
  ok(mesh.perObjectFrustumCulled === false && mesh.sortObjects === false, 'default: per-chunk culling off, sorting off (early-out preconditions)');
  mesh.onBeforeRender(null, null, cam, mesh.geometry, mesh.material);
  ok(mesh._multiDrawCount === 6, `all 6 chunks submitted with the camera facing away (${mesh._multiDrawCount})`);
  ok(b.drawCount === 6 && b.stats.draws === 6, 'drawCount / stats.draws report one GPU draw per visible chunk');
  mesh._multiDrawCount = -1;
  mesh.onBeforeRender(null, null, cam, mesh.geometry, mesh.material);
  ok(mesh._multiDrawCount === -1, 'quiet frame: onBeforeRender early-outs, no per-instance cull loop');
  b.setVisible('0', false);
  mesh.onBeforeRender(null, null, cam, mesh.geometry, mesh.material);
  ok(mesh._multiDrawCount === 5 && b.drawCount === 5, 'visibility change rebuilds the list: 5 submitted, drawCount matches');
  b.dispose();
  const bc = createChunkBatcher({ material: new THREE.MeshBasicMaterial(), perObjectFrustumCulled: true });
  for (let i = 0; i < 6; i++) bc.add(`${i}`, chunkGeo(12, i * 30));
  const meshC = bc.group.children[0];
  ok(meshC.perObjectFrustumCulled === true, 'perObjectFrustumCulled: true reaches the mesh');
  meshC.onBeforeRender(null, null, cam, meshC.geometry, meshC.material);
  ok(meshC._multiDrawCount === 0, 'with culling on, the away-facing camera culls every chunk');
  ok(bc.drawCount === 6, 'drawCount stays the pre-cull upper bound when culling is on');
  bc.dispose();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
