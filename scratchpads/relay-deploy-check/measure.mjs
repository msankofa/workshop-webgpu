import * as THREE from 'three';
import { buildCraftMesh } from '../../flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS } from '../../base-game-vehicles.js';
const M = { standard: (c, e = 0) => new THREE.MeshStandardMaterial({ color: c, emissive: e }), basic: (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, opacity: o }) };
const box = new THREE.Box3();
for (const [kind, def] of Object.entries(BASE_GAME_VEHICLE_DEFS)) {
  const g = buildCraftMesh(def.mesh, 0x888888, M, def);
  g.updateMatrixWorld(true);
  box.setFromObject(g);
  console.log(kind,
    'x', box.min.x.toFixed(3), box.max.x.toFixed(3),
    '| y', box.min.y.toFixed(3), box.max.y.toFixed(3),
    '| z', box.min.z.toFixed(3), box.max.z.toFixed(3),
    '| clearance', def.clearance, 'track', def.track, 'wb', def.wheelbase);
}
