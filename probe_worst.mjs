// scratch probe: dissect the worst planted-foot placement error
import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { createStadiumWalker } from './stadium-walker.js';

const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
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
const walker = createStadiumWalker({ THREE, scene, map, worldHeight: 0.5, rng: seeded(4 * 977) });
console.log('heightScale', walker.state.heightScale.toFixed(3), 'strideEnvelope', walker.state.strideEnvelope.toFixed(4));
console.log('gait comfort.h', walker.state.gait.comfort.h.toFixed(4), 'movingTrigger.h', walker.state.gait.movingTrigger.h.toFixed(4),
  'stepLift', walker.state.gait.stepLift.toFixed(4), 'maxSpeed', walker.state.gait.maxSpeed.toFixed(3));

let worst = 0, at = null;
for (let i = 0; i < 900; i++) {
  walker.fixedStep(1 / 60, true);
  if (i < 120) continue;
  walker.applyPose();
  for (const leg of walker.legs) {
    if (leg.stepping) continue;
    const L = map.legs[leg.index];
    const footBone = L.bones[L.bones.length - 1];
    const inv = new THREE.Matrix4().fromArray(map.restWorld[footBone]).invert();
    const sole = new THREE.Vector3(L.foot.x, L.foot.y, L.foot.z).applyMatrix4(inv)
      .applyMatrix4(scene.getObjectByName(map.names[footBone]).matrixWorld);
    const hip = leg.attachmentLocal.clone().applyMatrix3(walker.state.rot ?? new THREE.Matrix3()).add(walker.body.pos);
    const ratio = sole.distanceTo(leg.end) / leg.span;
    if (ratio > worst) {
      worst = ratio;
      at = {
        t: (i / 60).toFixed(2), leg: L.name, l1: leg.l1, l2: leg.l2, span: leg.span,
        inner: Math.abs(leg.l1 - leg.l2), outer: (leg.l1 + leg.l2) * 0.99,
        reach: hip.distanceTo(leg.end), err: sole.distanceTo(leg.end),
        soleY: sole.y, endY: leg.end.y, wants: leg.wants, uncomfortable: leg.uncomfortable,
      };
    }
  }
}
console.log('worst planted', (worst * 100).toFixed(1) + '%', at);
