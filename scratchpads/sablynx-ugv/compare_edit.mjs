// Table of every part of the code-built UGV, in the same shape as identify_parts.mjs prints for an
// edited GLB, so the two can be diffed part by part.
import * as THREE from 'three';
import { buildCraftMesh } from '../../flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS } from '../../base-game-vehicles.js';
const M = { standard: (c, e = 0) => new THREE.MeshStandardMaterial({ color: c, emissive: e }),
            basic: (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, opacity: o }) };
const def = BASE_GAME_VEHICLE_DEFS.ugv;
const g = buildCraftMesh('ugv', 0x5c6b3c, M, def);
g.updateMatrixWorld(true);
const rows = [];
g.traverse(o => {
  if (!o.geometry) return;
  const b = new THREE.Box3().setFromObject(o), s = new THREE.Vector3(), c = new THREE.Vector3();
  b.getSize(s); b.getCenter(c);
  const ix = o.geometry.index, pos = o.geometry.attributes.position;
  rows.push({ name: o.name || '(unnamed)', c, s, tris: (ix ? ix.count : pos.count) / 3, vol: s.x * s.y * s.z });
});
rows.sort((a, b) => b.vol - a.vol);
const f = (v) => [v.x, v.y, v.z].map(x => x.toFixed(2).padStart(6)).join(' ');
console.log('name'.padEnd(14), 'centre x,y,z'.padEnd(21), 'size w,h,l'.padEnd(21), 'tris');
for (const r of rows.slice(0, 14)) console.log(r.name.padEnd(14), f(r.c), ' ', f(r.s), ' ', Math.round(r.tris));
const box = new THREE.Box3().setFromObject(g), sz = new THREE.Vector3();
box.getSize(sz);
console.log('\nwhole model  W %s H %s L %s   bottom y %s',
  sz.x.toFixed(3), sz.y.toFixed(3), sz.z.toFixed(3), box.min.y.toFixed(3));
