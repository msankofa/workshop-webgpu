// node test-base-game-spawn-building.mjs -- the page-side spawn building builds headless: chunked
// meshes, a registered provider that follows visibility, a rebuild on a new ground, and a concrete
// material whose graph compiles through the TSL harness.
import * as THREE from 'three';
import { createWorldQueryService } from './world-query.js';
import { createBaseGameSpawnBuilding, SPAWN_BUILDING_CHUNK } from './base-game-spawn-building.js';
import { createConcreteMaterial } from './concrete-material.js';
import { buildMaterial } from './tsl-build-check.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

const flat = () => 2;
const hills = (x, z) => 2 + Math.sin(x * 0.1) * 3;
const scene = new THREE.Scene();
const worldQuery = createWorldQueryService();
const building = createBaseGameSpawnBuilding({ THREE, scene, worldQuery, heightAt: flat, seaLevel: 0 });

ok(scene.children.includes(building.root) && building.root.name === 'spawn-building', 'root is in the scene under its visor name');
ok(building.stats.chunks > 20, `concrete is chunked into ${building.stats.chunks} instanced meshes`);
const meshes = [];
building.root.traverse((o) => { if (o.isInstancedMesh) meshes.push(o); });
ok(meshes.length === building.stats.chunks, 'one instanced mesh per chunk');
ok(meshes.every((m) => m.frustumCulled && m.geometry.boundingSphere), 'every chunk is frustum-cullable on its own bounds');
// The plinth is one 80 by 100 m box on purpose; every other chunk stays near its cell.
const radii = meshes.filter((m) => m.count > 1).map((m) => ({ r: m.boundingSphere?.radius ?? 0, n: m.count }));
const worst = radii.reduce((a, b) => (b.r > a.r ? b : a), { r: 0, n: 0 });
ok(worst.r > 0 && worst.r < SPAWN_BUILDING_CHUNK * 1.6, `multi-box chunk bounds stay near their cell (largest radius ${worst.r.toFixed(1)} m over ${worst.n} boxes)`);
ok(building.materials.length === 5, 'five materials exposed for the rain decorator');
ok(Math.abs(building.stats.baseY - 2.05) < 1e-6, 'flat ground at 2 m puts the floor datum at 2.05');
ok(Math.abs(building.spawn[1] - 2.05) < 1e-6, 'spawn is on the plaza at the datum');

const down = [0, -1, 0];
const castAtSpawn = () => worldQuery.raycast({ origin: [building.spawn[0], building.spawn[1] + 3, building.spawn[2]], direction: down, maxDistance: 20 });
ok(!!castAtSpawn(), 'the provider is registered and answers at the spawn');
building.setVisible(false);
ok(!castAtSpawn() && building.root.visible === false, 'hidden means no collision either');
building.setVisible(true);
ok(!!castAtSpawn(), 'visible again means collision again');

building.rebuild(hills, 0);
ok(building.stats.baseY > 2.05 + 1, `a rebuild on hills lifts the datum to ${building.stats.baseY.toFixed(2)}`);
ok(!!castAtSpawn() && Math.abs(castAtSpawn().point[1] - building.stats.baseY) < 0.02, 'the rebuilt provider answers at the new datum');
ok(building.footprintContains(0, 0) && !building.footprintContains(500, 500), 'footprint test');

// The concrete graph compiles standalone, with the weathering on.
{
  const mat = createConcreteMaterial({ THREE, color: 0x9c9e9a, block: { gain: 1, mossGain: 0.3 } });
  let built = null;
  try { built = await buildMaterial(mat, new THREE.BoxGeometry(1, 1, 1)); } catch (e) { console.error('   ', e.message); }
  ok(built && built.fragment.length > 2000, 'concrete material builds through the TSL harness');
  ok(mat.userData.concrete.gain.value === 1 && mat.userData.concrete.mossGain.value === 0.3, 'the block reached the uniforms');
}

building.dispose();
ok(!castAtSpawn() && !scene.children.includes(building.root), 'dispose unregisters and removes the root');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
