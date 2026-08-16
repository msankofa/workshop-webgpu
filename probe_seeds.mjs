// scratch probe: worst rendered-sole error over many seeds and both reference quadrupeds
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
  let worstRatio = 0, worstContact = 0, worstAt = '';
  for (let seed = 1; seed <= 8; seed++) {
    const scene = build(json);
    const walker = createStadiumWalker({ THREE, scene, map, worldHeight: 0.5, rng: seeded(seed * 977) });
    for (let i = 0; i < 600; i++) {
      walker.fixedStep(1 / 60, true);
      for (const f of walker.footContactError()) if (!f.stepping) worstContact = Math.max(worstContact, Math.abs(f.error));
      if (i % 20 || i < 120) continue;   // skip the settle-in from the spawn pose
      walker.applyPose();
      for (const leg of walker.legs) {
        const L = map.legs[leg.index];
        const footBone = L.bones[L.bones.length - 1];
        const inv = new THREE.Matrix4().fromArray(map.restWorld[footBone]).invert();
        const sole = new THREE.Vector3(L.foot.x, L.foot.y, L.foot.z)
          .applyMatrix4(inv)
          .applyMatrix4(scene.getObjectByName(map.names[footBone]).matrixWorld);
        const ratio = sole.distanceTo(leg.end) / leg.span;
        if (leg.stepping) continue;
        if (ratio > worstRatio) { worstRatio = ratio; worstAt = `${L.name} seed${seed} t=${(i / 60).toFixed(1)} planted`; }
      }
    }
  }
  console.log(name.padEnd(14),
    'worst sole error = ' + (worstRatio * 100).toFixed(1) + '% of leg span', '(' + worstAt + ')',
    '| worst planted-foot ground error = ' + (worstContact * 1000).toFixed(2) + ' mm');
}
