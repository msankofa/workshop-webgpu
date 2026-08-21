// node test-blast-debris-render.mjs
// Covers blast-debris.js, which test-blast-debris-sim.mjs cannot reach: it needs THREE.
//
// Two things are checked, both of which have burned us before. First, that every material the
// renderer builds actually COMPILES as a TSL graph (tsl-build-check.mjs), including the smoke's
// instanced sprite path — a SpriteNodeMaterial reading per-instance attributes is exactly the shape
// that failed silently on InstancedMesh in the Pokemon-moves work. Second, that sync() writes the
// live counts and leaves the pools consistent, including the demos/flight-sim.html heat tagging,
// where the smoke's own colour graph has to survive being wrapped for the thermal view.

import * as THREE from 'three/webgpu';
import { buildMaterial } from './tsl-build-check.mjs';
import { createDebrisSim } from './blast-debris-sim.js';
import { createDebrisRenderer } from './blast-debris.js';
import { heatTag, heatMix, HEAT } from './vision-modes.js';

let checks = 0, failures = 0;
const ok = (c, m) => { checks++; if (c) console.log('ok  ', m); else { failures++; console.error('FAIL', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// demos/flight-sim.html's tagger, verbatim in behaviour: the smoke keeps its own colour graph and is
// wrapped, everything else goes through heatTag.
function tagLikeFlightSim(mat, role) {
  if (role === 'smoke') {
    mat.colorNode = heatMix(mat.colorNode, HEAT.smoke);
    mat.userData.irTagged = true;
    return;
  }
  heatTag(mat, role === 'rubble' ? HEAT.warm : HEAT.fire);
}

function makeRig({ tagMaterial = null } = {}) {
  const scene = new THREE.Scene();
  const sim = createDebrisSim({ groundAt: () => 0, random: mulberry(11) });
  const softTexture = new THREE.Texture();   // no canvas in Node; the graph only needs the object
  const renderer = createDebrisRenderer({ THREE, scene, sim, lightCount: 2, softTexture, tagMaterial });
  return { scene, sim, renderer };
}

console.log('scene graph');
{
  const { scene, renderer } = makeRig();
  // six draws: shrapnel + its glow, rubble + its glow, sparks, smoke
  const meshes = Object.values(renderer.meshes);
  eq(meshes.length, 6, 'six meshes');
  eq(scene.children.filter((o) => o.isMesh || o.isInstancedMesh).length, 6, 'all six added to the scene');
  eq(scene.children.filter((o) => o.isLight).length, 2, 'lightCount lights added');
  ok(meshes.every((m) => m.frustumCulled === false), 'nothing is frustum-culled (positions live in attributes)');
  eq(renderer.meshes.shrapnelMesh.count, 0, 'starts empty');
  renderer.dispose();
  eq(scene.children.length, 0, 'dispose removes everything it added');
}

console.log('\nmaterials compile as TSL graphs');
for (const tag of [null, tagLikeFlightSim]) {
  const label = tag ? 'flight-sim heat tagging' : 'untagged';
  const { renderer } = makeRig({ tagMaterial: tag });
  for (const [name, mesh] of Object.entries(renderer.meshes)) {
    let built = null, err = null;
    try { built = await buildMaterial(mesh.material, mesh.geometry); } catch (e) { err = e; }
    ok(built && built.fragment && built.vertex, `${name} compiles (${label})${err ? ' — ' + err.message : ''}`);
  }
  renderer.dispose();
}

console.log('\nthe smoke keeps its per-instance colour after tagging');
{
  const { renderer } = makeRig({ tagMaterial: tagLikeFlightSim });
  const built = await buildMaterial(renderer.meshes.smoke.material, renderer.meshes.smoke.geometry);
  const src = built.vertex + built.fragment;
  ok(/instColor/.test(src), 'instColor survives the heatMix wrap');
  ok(/instSize/.test(src) && /instPos/.test(src), 'the billboard still reads its position and size attributes');
  ok(/instAlpha/.test(src), 'and its per-instance alpha');
  renderer.dispose();
}

console.log('\nsync() writes live counts');
{
  const { sim, renderer } = makeRig();
  sim.spawnBlastShrapnel(0, 40, 0, 24);
  sim.spawnRubble(0, 40, 0, 4, [1, 0]);
  sim.step(1 / 60);
  renderer.sync();
  const s = renderer.stats;
  eq(s.shrapnel, sim.shrapnel.length, 'shrapnel count matches the pool');
  eq(s.rubble, sim.rubble.length, 'rubble count matches the pool');
  eq(renderer.meshes.shrapnelMesh.count, sim.shrapnel.length, 'InstancedMesh.count is the live length');
  eq(renderer.meshes.rubbleMesh.count, sim.rubble.length, 'and for rubble');
  ok(s.smoke > 0, `dust is drawn (${s.smoke} puffs)`);
  eq(renderer.meshes.smoke.geometry.instanceCount, s.smoke, 'smoke instanceCount matches');
  ok(renderer.meshes.smoke.visible, 'smoke mesh visible while it has instances');
  // a matrix was actually written, not left at identity
  const m = new THREE.Matrix4();
  renderer.meshes.shrapnelMesh.getMatrixAt(0, m);
  ok(m.elements[12] !== 0 || m.elements[13] !== 0 || m.elements[14] !== 0, 'instance matrices carry positions');

  console.log('\nGPU uploads are bounded to the live count, not the pool cap');
  for (const [label, attr, stride, live] of [
    ['shrapnel matrices', renderer.meshes.shrapnelMesh.instanceMatrix, 16, sim.shrapnel.length],
    ['shrapnel colours', renderer.meshes.shrapnelMesh.instanceColor, 3, sim.shrapnel.length],
    ['rubble matrices', renderer.meshes.rubbleMesh.instanceMatrix, 16, sim.rubble.length],
    ['smoke positions', renderer.meshes.smoke.geometry.attributes.instPos, 3, s.smoke],
  ]) {
    const r = attr.updateRanges;
    ok(r && r.length === 1 && r[0].start === 0 && r[0].count === live * stride,
      `${label}: one range covering ${live * stride} of ${attr.array.length} (${JSON.stringify(r)})`);
    ok(live * stride < attr.array.length, `${label}: and that is less than the whole buffer`);
  }
  renderer.sync(); renderer.sync();
  eq(renderer.meshes.shrapnelMesh.instanceMatrix.updateRanges.length, 1,
    'ranges are cleared each frame, not appended');

  console.log('\nhiding a pool empties its draw, and clearing empties everything');
  renderer.show.shrapnel = false;
  renderer.sync();
  eq(renderer.meshes.shrapnelMesh.count, 0, 'hidden shrapnel draws nothing');
  eq(renderer.meshes.rubbleMesh.count, sim.rubble.length, 'but rubble is untouched');
  renderer.show.shrapnel = true;
  sim.clear();
  renderer.sync();
  eq(renderer.meshes.rubbleMesh.count, 0, 'cleared');
  eq(renderer.meshes.smoke.visible, false, 'the smoke mesh hides rather than drawing zero instances');
  eq(renderer.stats.lights, 0, 'no lit rubble left');
  renderer.dispose();
}

console.log('\nlights follow the hottest rubble and park when there is none');
{
  const { sim, renderer } = makeRig();
  const sim2 = sim;
  sim2.settings.rubbleSmolderChance = 1;
  sim2.spawnRubble(0, 3, 0, 4, [1, 0]);
  for (let i = 0; i < 120; i++) sim2.step(1 / 60);
  renderer.sync();
  eq(renderer.stats.lights, 2, 'both light slots taken by smouldering pieces');
  ok(renderer.lights.every((l) => l.intensity > 0), 'both are actually lit');
  const hottest = sim2.hottestRubble(2);
  ok(Math.abs(renderer.lights[0].position.y - (hottest[0].y + hottest[0].radius * 0.45)) < 1e-6,
    'a light sits just above its piece');
  renderer.show.lights = false;
  renderer.sync();
  ok(renderer.lights.every((l) => l.intensity === 0), 'toggling lights off drops them to zero');
  ok(renderer.lights.every((l) => l.position.y === -999), 'and parks them out of the world');
  renderer.dispose();
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
