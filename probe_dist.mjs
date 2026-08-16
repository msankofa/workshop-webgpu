// scratch probe: distribution of planted-foot placement error, not just its worst case
import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { createStadiumWalker } from './stadium-walker.js';

const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

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
  const errs = [];
  const perLeg = new Map();
  for (let seed = 1; seed <= 8; seed++) {
    const scene = build(json);
    const walker = createStadiumWalker({ THREE, scene, map, worldHeight: 0.5, rng: seeded(seed * 977) });
    for (let i = 0; i < 600; i++) {
      walker.fixedStep(1 / 60, true);
      if (i % 5 || i < 120) continue;
      walker.applyPose();
      for (const leg of walker.legs) {
        if (leg.stepping) continue;
        const L = map.legs[leg.index];
        const footBone = L.bones[L.bones.length - 1];
        const inv = new THREE.Matrix4().fromArray(map.restWorld[footBone]).invert();
        const sole = new THREE.Vector3(L.foot.x, L.foot.y, L.foot.z).applyMatrix4(inv)
          .applyMatrix4(scene.getObjectByName(map.names[footBone]).matrixWorld);
        const r = sole.distanceTo(leg.end) / leg.span;
        errs.push(r);
        perLeg.set(L.name, Math.max(perLeg.get(L.name) ?? 0, r));
      }
    }
  }
  errs.sort((a, b) => a - b);
  const over = errs.filter(e => e > 0.05).length;
  console.log(name.padEnd(14),
    `n=${errs.length}`,
    `p50=${(pct(errs, 0.5) * 100).toFixed(2)}%`,
    `p95=${(pct(errs, 0.95) * 100).toFixed(2)}%`,
    `p99=${(pct(errs, 0.99) * 100).toFixed(2)}%`,
    `max=${(errs[errs.length - 1] * 100).toFixed(1)}%`,
    `over5%=${(over / errs.length * 100).toFixed(2)}%`,
    '| worst per leg:', [...perLeg].map(([k, v]) => `${k}:${(v * 100).toFixed(1)}`).join(' '));
}
