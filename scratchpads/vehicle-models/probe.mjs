import * as THREE from 'three';
import { buildCraftMesh } from '../../flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS } from '../../base-game-vehicles.js';

const M = {
  standard: (c, e = 0) => new THREE.MeshStandardMaterial({ color: c, emissive: e }),
  basic: (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, opacity: o }),
};
const box = new THREE.Box3(), size = new THREE.Vector3();
for (const [kind, def] of Object.entries(BASE_GAME_VEHICLE_DEFS)) {
  const g = buildCraftMesh(def.mesh, 0x8ea2b8, M, def);
  g.updateMatrixWorld(true);
  box.setFromObject(g).getSize(size);
  let tris = 0, meshes = 0, geos = new Set();
  g.traverse(o => { if (o.geometry) { meshes++; geos.add(o.geometry); const i = o.geometry.index; tris += (i ? i.count : o.geometry.attributes.position.count) / 3; } });
  const w = g.userData.wheels;
  const lows = w.map(x => { const p = new THREE.Vector3(); x.pivot.getWorldPosition(p); return +(p.y - x.radius).toFixed(4); });
  const zs = [...new Set(w.map(x => +x.pivot.position.z.toFixed(3)))].sort((a, b) => a - b);
  const xs = [...new Set(w.map(x => +x.pivot.position.x.toFixed(3)))].sort((a, b) => a - b);
  console.log(`\n${kind}: ${meshes} meshes, ${geos.size} geometries, ${Math.round(tris)} tris`);
  console.log(`  bbox L=${size.z.toFixed(2)} W=${size.x.toFixed(2)} H=${size.y.toFixed(2)}  span=${Math.max(size.x, size.z).toFixed(2)}`);
  console.log(`  mesh wheelbase ${(zs[1] - zs[0]).toFixed(3)} vs physics ${def.wheelbase}   track ${(xs[1] - xs[0]).toFixed(3)} vs ${def.track}`);
  console.log(`  wheel bottoms ${lows.join(', ')}  (want -clearance = ${-def.clearance})`);
  console.log(`  front flags ${w.map(x => x.front).join(',')}  (front is -Z)`);
  const bad = [];
  g.traverse(o => { if (o.geometry) { const a = o.geometry.attributes.position.array; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { bad.push(o.name || o.type); break; } } });
  console.log(`  non-finite vertices: ${bad.length ? bad.join(',') : 'none'}`);
}
