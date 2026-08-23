// test-base-game-water.mjs — water W3: the Base Game surface builds headless over the sea-depth
// map and the sky dome, follows the sea level and the wave keys, gates on the depth window, and
// its CPU surface height tracks the wave table.
import * as THREE from 'three';
import { createBaseGameWater } from './base-game-water.js';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { vec3, mix, clamp } from 'three/tsl';
import { createLightingRig } from './lights.js';
import { buildMaterial } from './tsl-build-check.mjs';
import { waveOptionsFromWorld } from './base-game-protocol.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: analyticDescriptor({ key: 'a', sourceVersion: '1', seaLevel: 4 }), useWorker: false, params: { renderRadius: 1 } });
terrain.setActive(true);
// sky.js needs a DOM for its sprites; the water only needs colorAlong(dir), so stub the dome gradient
const sky = { colorAlong: dir => mix(vec3(0.7, 0.8, 0.9), vec3(0.2, 0.4, 0.7), clamp(dir.y, 0, 1)) };
const rig = createLightingRig({ scene, ui: false });
const water = createBaseGameWater({ scene, terrain, sky, rig, worldCoordinates });

console.log('\n[1] build and wiring');
{
  let built = null; try { built = await buildMaterial(water.material, water.mesh.geometry); } catch (e) { built = e; }
  ok(built && built.fragment && built.vertex, `surface material builds headless (${built?.message ?? 'ok'})`);
  ok(water.level === 4 && scene.children.includes(water.mesh), 'sits at the terrain sea level, in the scene');
  water.setLevel(-3);
  ok(water.level === -3 && water.uniforms.level.value === -3, 'setLevel updates the uniform');
  ok(water.setWaves(waveOptionsFromWorld({ waveCount: 9, waveWindDeg: 90 })) === true && water.profile.wave.count === 9 && water.profile.count.value === 9 && Math.abs(water.uniforms.wind.value.y - 1) < 1e-9, 'wave keys rebuild the table and the wind');
  ok(water.setWaves(waveOptionsFromWorld({ waveCount: 9 })) === false, 'unchanged keys are a no-op');
}

console.log('\n[2] visibility gate and CPU surface');
{
  water.update(0.016, camera.position);
  ok(water.state.visible === false && water.state.reason === 'no data', 'hidden until the depth window has data');
  for (let i = 0; i < 30; i++) { terrain.update([0, 0, 0], 0.1); }
  water.setLevel(-1000); water.update(0.016, camera.position);
  ok(water.state.visible === false && water.state.reason === 'all ground above sea level', 'hidden when nothing in the window is below sea level');
  water.setLevel(1000); water.update(0.016, camera.position);
  ok(water.state.visible === true && water.mesh.visible, 'shown when ground lies below sea level');
  water.setLevel(0);
  const h0 = water.surfaceHeightAt(10, 10);
  water.update(0.5, camera.position);
  const h1 = water.surfaceHeightAt(10, 10);
  ok(Number.isFinite(h0) && Number.isFinite(h1) && h0 !== h1 && Math.abs(h1) < 50, `surface height moves with the clock (${h0.toFixed(2)} → ${h1.toFixed(2)})`);
  water.setEnabled(false); water.update(0.016, camera.position);
  ok(!water.mesh.visible, 'disabled hides the mesh');
}

water.dispose(); terrain.dispose();
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
