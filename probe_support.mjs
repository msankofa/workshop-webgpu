// scratch probe: does the body ever sink onto its hard floor, and how accurate are planted feet?
import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { createStadiumWalker } from './stadium-walker.js';

const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function build(json) {
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
  return scene;
}

for (const name of ['019_rattata', '058_growlithe', '077_ponyta', '128_tauros']) {
  const { json, bin } = parseGLB(fs.readFileSync(`models/stadium/${name}.glb`));
  const map = mapStadiumRig(json, bin);
  let lowest = Infinity, ride = 0, errs = [], groundedMin = 99, frames = 0, sagFrames = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const scene = build(json);
    const walker = createStadiumWalker({ THREE, scene, map, worldHeight: 0.5, rng: seeded(seed * 977) });
    ride = map.rideHeight * walker.unitScale;
    for (let i = 0; i < 600; i++) {
      const sup = walker.fixedStep(1 / 60, true);
      if (i > 30) {
        lowest = Math.min(lowest, walker.body.pos.y);
        groundedMin = Math.min(groundedMin, sup.groundedCount);
        frames++;
        if (walker.body.pos.y < map.rideHeight * walker.unitScale * 0.8) sagFrames++;
      }
      if (i % 5 || i < 120) continue;
      walker.applyPose();
      for (const leg of walker.legs) {
        if (leg.stepping) continue;
        const L = map.legs[leg.index];
        const footBone = L.bones[L.bones.length - 1];
        const inv = new THREE.Matrix4().fromArray(map.restWorld[footBone]).invert();
        const sole = new THREE.Vector3(L.foot.x, L.foot.y, L.foot.z).applyMatrix4(inv)
          .applyMatrix4(scene.getObjectByName(map.names[footBone]).matrixWorld);
        errs.push(sole.distanceTo(leg.end) / leg.span);
      }
    }
  }
  errs.sort((a, b) => a - b);
  const p = (q) => errs[Math.floor(errs.length * q)];
  console.log(name.padEnd(14),
    `bodyLow/ride=${(lowest / ride * 100).toFixed(0)}%`, `sag<80%=${(sagFrames / frames * 100).toFixed(2)}%`,
    `minGrounded=${groundedMin}`,
    `p95=${(p(0.95) * 100).toFixed(2)}%`,
    `p99=${(p(0.99) * 100).toFixed(2)}%`,
    `max=${(errs[errs.length - 1] * 100).toFixed(1)}%`,
    `over5%=${(errs.filter(e => e > 0.05).length / errs.length * 100).toFixed(2)}%`);
}
