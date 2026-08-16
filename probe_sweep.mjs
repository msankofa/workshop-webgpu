// scratch probe: sweep the placement reach margin against planted accuracy and achieved speed
import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { createStadiumWalker, WALKER_DEFAULTS } from './stadium-walker.js';

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

const models = ['019_rattata', '058_growlithe', '077_ponyta', '128_tauros'].map(name => {
  const { json, bin } = parseGLB(fs.readFileSync(`models/stadium/${name}.glb`));
  return { name, json, bin, map: mapStadiumRig(json, bin) };
});

for (const margin of [0.92, 0.88, 0.84, 0.80, 0.75]) {
  WALKER_DEFAULTS.reachMargin = margin;
  const line = [];
  for (const { name, json, map } of models) {
    let worst = 0, speed = 0, frames = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const scene = build(json);
      const walker = createStadiumWalker({ THREE, scene, map, worldHeight: 0.5, rng: seeded(seed * 977) });
      for (let i = 0; i < 600; i++) {
        walker.fixedStep(1 / 60, true);
        speed += Math.hypot(walker.body.vel.x, walker.body.vel.z);
        frames++;
        if (i % 15 || i < 120) continue;
        walker.applyPose();
        for (const leg of walker.legs) {
          if (leg.stepping) continue;
          const L = map.legs[leg.index];
          const footBone = L.bones[L.bones.length - 1];
          const inv = new THREE.Matrix4().fromArray(map.restWorld[footBone]).invert();
          const sole = new THREE.Vector3(L.foot.x, L.foot.y, L.foot.z).applyMatrix4(inv)
            .applyMatrix4(scene.getObjectByName(map.names[footBone]).matrixWorld);
          worst = Math.max(worst, sole.distanceTo(leg.end) / leg.span);
        }
      }
    }
    line.push(`${name.slice(4, 12).padEnd(9)} err=${(worst * 100).toFixed(1).padStart(5)}% v=${(speed / frames).toFixed(3)}`);
  }
  console.log(`reachMargin ${margin.toFixed(2)}  ` + line.join('  '));
}
