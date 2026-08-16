// scratch probe: where does the retargeted sole actually land?
import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { createStadiumWalker } from './stadium-walker.js';

const { json, bin } = parseGLB(fs.readFileSync('models/stadium/019_rattata.glb'));
const map = mapStadiumRig(json, bin);
const objs = json.nodes.map((n) => {
  const o = new THREE.Object3D();
  o.name = n.name || '';
  if (n.translation) o.position.fromArray(n.translation);
  if (n.rotation) o.quaternion.fromArray(n.rotation);
  if (n.scale) o.scale.fromArray(n.scale);
  return o;
});
json.nodes.forEach((n, i) => { for (const c of n.children || []) objs[i].add(objs[c]); });
const scene = new THREE.Group();
for (const r of json.scenes[0].nodes) scene.add(objs[r]);

const walker = createStadiumWalker({ THREE, scene, map, worldHeight: 0.5 });
for (let i = 0; i < 240; i++) walker.fixedStep(1 / 60, true);
walker.applyPose();

for (const leg of walker.legs) {
  const L = map.legs[leg.index];
  const footBone = L.bones[L.bones.length - 1];
  const obj = scene.getObjectByName(map.names[footBone]);
  const inv = new THREE.Matrix4().fromArray(map.restWorld[footBone]).invert();
  const soleNow = new THREE.Vector3(L.foot.x, L.foot.y, L.foot.z).applyMatrix4(inv).applyMatrix4(obj.matrixWorld);

  const hipW = new THREE.Vector3(...[L.hip.x, L.hip.y, L.hip.z]).applyMatrix4(scene.matrixWorld);
  const reach = hipW.distanceTo(leg.end);
  console.log(
    L.name.padEnd(8),
    'kneeIdx=' + L.kneeIndex, 'upper=[' + leg.upper.map(b => map.names[b]) + ']', 'lower=[' + leg.lower.map(b => map.names[b]) + ']',
    '\n   target=', leg.end.toArray().map(v => v.toFixed(3)),
    'sole=', soleNow.toArray().map(v => v.toFixed(3)),
    'err=' + (soleNow.distanceTo(leg.end) * 1000).toFixed(1) + 'mm',
    '\n   hip=', hipW.toArray().map(v => v.toFixed(3)),
    'reach=' + reach.toFixed(3), 'l1+l2=' + (leg.l1 + leg.l2).toFixed(3), 'stepping=' + leg.stepping);
}
