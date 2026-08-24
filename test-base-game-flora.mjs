// test-base-game-flora.mjs — plants plan F5: the grass layer's wiring.
// The blades themselves need a GPU; what is testable here is everything around them — window
// references, the render-local/global boundary, the injected TSL graphs, and the clamps.
// node test-base-game-flora.mjs

import * as THREE from 'three';
import { Fn, float, vec2, uniform } from 'three/tsl';
import { createBaseGameFlora, safeRadiusFor, BASE_GAME_FLORA_DEFAULTS } from './base-game-flora.js';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { analyticDescriptor } from './terrain-source-analytic.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

function rig() {
  const scene = new THREE.Scene();
  const worldQuery = createWorldQueryService();
  const worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene, worldQuery, worldCoordinates,
    source: analyticDescriptor({ key: 'flora-test', seaLevel: 0 }), useWorker: false,
  });
  terrain.setActive(true);
  const flora = createBaseGameFlora({ scene, camera: new THREE.PerspectiveCamera(), terrain, worldCoordinates });
  return { scene, terrain, flora, worldCoordinates };
}
function settle(terrain, at = [0, 0, 0], frames = 60) {
  for (let i = 0; i < frames; i++) { terrain.update(at, 1 / 60); terrain.fieldScheduler.pump(); }
}

section('window references follow the toggle');
{
  const { terrain, flora } = rig();
  check('nothing streams before grass is enabled', terrain.fields === null && terrain.contactField === null);
  flora.setEnabled(true);
  check('enabling takes both the placement and contact windows', terrain.fields !== null && terrain.contactField !== null);
  check('the contact window is the exact one', terrain.contactField.lod === 0, `lod ${terrain.contactField.lod}`);
  check('and the placement window is band-limited', terrain.fields.lod > 0, `lod ${terrain.fields.lod}`);
  check('the contact window is fine, the placement window coarse',
    terrain.contactField.post < terrain.fields.post, `${terrain.contactField.post} vs ${terrain.fields.post}`);
  flora.setEnabled(false);
  check('disabling releases both', terrain.fields === null && terrain.contactField === null);
  check('toggling twice is idempotent', (flora.setEnabled(false), terrain.fields === null));
  terrain.dispose();
}

section('the radius is clamped to what the window can serve');
{
  const { terrain, flora } = rig();
  flora.setEnabled(true);
  settle(terrain);
  const safe = safeRadiusFor(terrain.contactField);
  check('a 160 m window serves a ~56 m circle', Math.abs(safe - 56.57) < 0.5, `safe ${safe.toFixed(2)}`);
  check('the default radius fits inside it', BASE_GAME_FLORA_DEFAULTS.grassRadius <= safe,
    `default ${BASE_GAME_FLORA_DEFAULTS.grassRadius} vs safe ${safe.toFixed(2)}`);
  check('a square window never promises its corners', safe < terrain.contactField.extent / 2);
  flora.setEnabled(false);
  terrain.dispose();
}

section('the injected graphs build');
{
  const { terrain, flora } = rig();
  flora.setEnabled(true);
  settle(terrain);
  // The same shape base-game-flora builds internally: TSL node construction needs no GPU, so a
  // broken graph throws here rather than rendering as an empty field.
  const uOrigin = uniform(new THREE.Vector3(1000, 5, -2000));
  const originXZ = vec2(uOrigin.x, uOrigin.z);
  const height = terrain.contactField.gpuSampler('heights');
  const cover = terrain.fields.gpuSampler('coverGrass');
  let heightNode = null, densityNode = null, err = null;
  try {
    heightNode = Fn(([x, z]) => height(vec2(x, z).add(originXZ), float(-1e5)).sub(uOrigin.y));
    densityNode = Fn(([x, z]) => cover(vec2(x, z).add(originXZ), float(0)).div(255).clamp(0, 1));
    heightNode(float(3), float(4));
    densityNode(float(3), float(4));
  } catch (e) { err = e; }
  check('the height adapter builds and calls', heightNode && !err, String(err?.message ?? ''));
  check('the cover adapter builds and calls', densityNode && !err, String(err?.message ?? ''));

  // grass-compute takes two scalars, not a vec2: a mismatch must fail loudly at construction.
  const { createComputeGrass } = await import('./grass-compute.js');
  let rejected = false;
  try { createComputeGrass({ camera: new THREE.PerspectiveCamera(), heightNode: 'not a node' }); } catch { rejected = true; }
  check('a non-node heightNode is refused at construction', rejected);
  flora.setEnabled(false);
  terrain.dispose();
}

section('the render-local boundary');
{
  const { terrain, flora, worldCoordinates } = rig();
  flora.setEnabled(true);
  settle(terrain, [0, 0, 0]);
  const globalHeight = terrain.contactHeightAt(20, 20);
  check('the contact window resolves near the player', globalHeight !== null);

  // A rebase moves the origin under everything. The window is indexed globally, so the same world
  // point must still read the same height afterwards.
  worldCoordinates.setRenderOrigin([4000, 0, 4000]);
  settle(terrain, [4000, 0, 4000]);
  const afterFar = terrain.contactHeightAt(4020, 4020);
  check('a far point resolves after the rebase', afterFar !== null);
  check('and its height is the terrain height there', Math.abs(afterFar - terrain.groundHeight(4020, 4020)) < 1,
    `window ${afterFar} vs ground ${terrain.groundHeight(4020, 4020)}`);
  flora.setEnabled(false);
  terrain.dispose();
}

section('lifetime guards');
{
  const { terrain, flora } = rig();
  check('update before enabling is a no-op', (await flora.update(0.016)) === false);
  flora.setEnabled(true);
  // No renderer here, so the build cannot complete; it must report false, not throw.
  let threw = false;
  try { await flora.update(0.016); } catch { threw = true; }
  check('update without a renderer reports rather than throws', !threw);
  check('and nothing was built', flora.built === false);
  check('apply() before a build does not throw', (flora.apply({ grassDensity: 3 }), true));
  flora.dispose();
  check('dispose releases the windows', terrain.fields === null && terrain.contactField === null);
  terrain.dispose();
}

section('grass-compute injection points');
{
  const src = await import('node:fs').then(fs => fs.promises.readFile('./grass-compute.js', 'utf8'));
  check('the injected height wins over the texture path', /const heightFn = injectedHeight \? injectedHeight :/.test(src));
  check('the injected density wins too', /const densityFn = injectedDensity \? injectedDensity :/.test(src));
  check('injection disables the authored-map texture path', /const hasHeightTex = !injectedHeight/.test(src));
  check('both are validated', /heightNode must be a TSL node function/.test(src) && /densityNode must be a TSL node function/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
