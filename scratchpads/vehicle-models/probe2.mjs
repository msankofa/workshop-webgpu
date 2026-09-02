import * as THREE from 'three';
import { buildCraftMesh, CRAFT_KINDS } from '../../flight-meshes.js';
const M = { standard: (c, e = 0) => new THREE.MeshStandardMaterial({ color: c, emissive: e }), basic: (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, opacity: o }) };
for (const k of CRAFT_KINDS) {
  const g = buildCraftMesh(k, 0x888888, M);
  let meshes = 0, tris = 0;
  g.traverse(o => { if (o.geometry) { meshes++; const i = o.geometry.index; tris += (i ? i.count : o.geometry.attributes.position.count) / 3; } });
  console.log(`${k.padEnd(9)} ${String(meshes).padStart(3)} meshes  ${String(Math.round(tris)).padStart(5)} tris`);
}
