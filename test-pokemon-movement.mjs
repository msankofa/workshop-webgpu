// Class-aware movement facade checks.

import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { readRigFromGLB } from './pokemon-rig.js';
import { mapLabRigForGroundMovement } from './pokemon-lab-ground-map.js';
import { createPokemonMovement, movementLabel, MOVEMENT_LABELS } from './pokemon-movement.js';
import { GAITS } from './creature-locomotion.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (error) { failures++; results.push(`  FAIL ${name}\n       ${error.message}`); }
}
function assert(value, message) { if (!value) throw new Error(message); }

function buildScene(json) {
  const objects = json.nodes.map(node => {
    const object = new THREE.Object3D();
    object.name = node.name || '';
    if (node.translation) object.position.fromArray(node.translation);
    if (node.rotation) object.quaternion.fromArray(node.rotation);
    if (node.scale) object.scale.fromArray(node.scale);
    if (node.matrix) {
      object.matrix.fromArray(node.matrix);
      object.matrix.decompose(object.position, object.quaternion, object.scale);
    }
    return object;
  });
  json.nodes.forEach((node, i) => { for (const child of node.children || []) objects[i].add(objects[child]); });
  const root = new THREE.Group();
  for (const node of json.scenes[0].nodes) root.add(objects[node]);
  return root;
}

check('every movement class has a plain-language label', () => {
  for (const [movement, label] of Object.entries(MOVEMENT_LABELS)) {
    assert(label && !/walker|locomotion/i.test(label), `${movement} has internal wording: ${label}`);
    assert(movementLabel(movement) === label, `${movement} label lookup disagrees`);
  }
});

check('unsupported classes never fall back to walking', () => {
  for (const locomotion of Object.keys(MOVEMENT_LABELS).filter(value => value !== 'walker')) {
    const out = createPokemonMovement({ locomotion, scene: {}, map: {} });
    assert(!out.supported && out.controller === null, `${locomotion} created a controller`);
    assert(out.findings.some(f => f.code === 'movement-not-implemented'), `${locomotion} did not explain itself`);
  }
});

check('missing class and missing ground map are literal failures', () => {
  const missingClass = createPokemonMovement({ locomotion: null });
  assert(missingClass.findings[0].code === 'missing-movement-class', 'missing class was not named');
  const missingMap = createPokemonMovement({ locomotion: 'walker', scene: {} });
  assert(missingMap.findings[0].code === 'missing-ground-map', 'missing ground map was not named');
});

check('Walking delegates to the existing ground controller', () => {
  const bytes = fs.readFileSync('models/stadium/019_rattata.glb');
  const { json, bin } = parseGLB(bytes);
  const guessed = mapStadiumRig(json, bin);
  const facts = readRigFromGLB(bytes, { source: '019_rattata' }).rig;
  const resolved = {
    species: '019_rattata', locomotion: 'walker', posture: 'quadruped',
    root: guessed.body, spine: guessed.spine, head: guessed.head?.bones || [], contacts: [],
    appendages: guessed.legs.map((leg, i) => {
      const contacts = [...leg.footBones];
      return {
        id: `leg${i}`, type: 'leg', side: leg.side < 0 ? 'L' : 'R', row: leg.row,
        mirror: null, chain: [...leg.bones], contacts,
      };
    }),
    neutral: { ground: true, bones: {} }, facts,
  };
  resolved.contacts = resolved.appendages.flatMap(ap => ap.contacts);
  const mapped = mapLabRigForGroundMovement({ annotationRig: resolved, measuredRig: facts, gltf: bytes });
  assert(mapped.map, `Lab map failed: ${mapped.findings.map(f => f.code).join(', ')}`);
  const out = createPokemonMovement({
    locomotion: 'walker', THREE, scene: buildScene(json), map: mapped.map, worldHeight: 0.5, rng: () => 0.5,
  });
  assert(out.supported, `Walking was rejected: ${out.findings[0]?.message || 'unknown'}`);
  assert(out.label === 'Walking', `Walking label was ${out.label}`);
  assert(typeof out.controller.update === 'function' && typeof out.controller.diagnosticFrame === 'function',
    'facade did not return the existing ground controller');
  out.controller.update(1 / 60, { walk: false });
  assert(out.controller.diagnosticFrame().legs.length === resolved.appendages.length,
    'the Lab-mapped legs did not reach the running controller');
  out.controller.update(1 / 60, { walk: true, speed: 0 });
  assert(out.controller.diagnosticFrame().commandedSpeed === 0, 'zero desired speed still commands movement');
  out.controller.update(1 / 60, { walk: true, speed: 0.4 });
  const limited = out.controller.diagnosticFrame();
  assert(limited.commandedSpeed > 0 && limited.commandedSpeed <= limited.maxSpeed * 0.4 + 1e-9,
    'desired speed does not bound the ground controller command');
});

check('a four-legged gallop preserves its row pair', () => {
  const bytes = fs.readFileSync('models/stadium/001_bulbasaur.glb');
  const { json, bin } = parseGLB(bytes);
  const map = mapStadiumRig(json, bin);
  const out = createPokemonMovement({
    locomotion: 'walker', THREE, scene: buildScene(json), map, gait: GAITS.gallop,
    worldHeight: 0.5, rng: () => 0.5,
  });
  assert(out.supported, 'Bulbasaur gallop did not create a controller');
  const walker = out.controller;
  const allowed = Math.floor(walker.legs.length * walker.state.gait.maxConcurrentFraction);
  assert(allowed >= 2, `gallop was reduced to ${allowed} airborne foot`);
  assert(walker.tuning.uprightSupport === 1, 'paired support was treated as a static two-point polygon');
  const lifted = new Set();
  walker.placeAt(0, 0);
  for (let frame = 0; frame < 600; frame++) {
    walker.setTarget(0, 10);
    walker.update(1 / 60, { walk: true, speed: 1 });
    walker.legs.forEach((leg, index) => { if (leg.stepping) lifted.add(index); });
  }
  assert(lifted.size === walker.legs.length, `only ${lifted.size}/${walker.legs.length} gallop legs lifted`);
  assert(walker.body.pos.z > 0.25 && Math.abs(walker.body.pos.x) < walker.body.pos.z * 0.1,
    `gallop did not travel forward: (${walker.body.pos.x.toFixed(3)}, ${walker.body.pos.z.toFixed(3)})`);
});

console.log('pokemon movement facade');
for (const result of results) console.log(result);
if (failures) { console.error(`\n${failures} check(s) failed`); process.exitCode = 1; }
else console.log('\nall checks passed');
