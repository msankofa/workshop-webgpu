import * as THREE from 'three';
import { buildCraftMesh } from '../../flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS } from '../../base-game-vehicles.js';
const M = { standard:(c,e=0)=>new THREE.MeshStandardMaterial({color:c,emissive:e}), basic:(c,o=1)=>new THREE.MeshBasicMaterial({color:c,opacity:o}) };
const def = BASE_GAME_VEHICLE_DEFS.ugv;
const g = buildCraftMesh('ugv', 0x6b7a4a, M, def);
g.updateMatrixWorld(true);
const box=new THREE.Box3().setFromObject(g), size=new THREE.Vector3(); box.getSize(size);
let meshes=0,tris=0; g.traverse(o=>{ if(o.geometry){meshes++; const i=o.geometry.index; tris+=(i?i.count:o.geometry.attributes.position.count)/3;} });
console.log(`meshes ${meshes}  tris ${Math.round(tris)}`);
console.log(`bbox  L ${size.z.toFixed(2)}  W ${size.x.toFixed(2)}  H ${size.y.toFixed(2)}`);
console.log(`      z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)}   y ${box.min.y.toFixed(3)}..${box.max.y.toFixed(2)}`);
console.log(`turret group present: ${!!g.userData.turret}  wheels: ${g.userData.wheels.length}`);
// hull loft winding: normals must point away from the hull axis
const hull = [...g.children].find(c=>c.geometry && c.geometry.attributes.normal && c.material.color.getHex()===0x6b7a4a);
const D = def.wheelbase*0.55;
const ratio = y => ((y + def.clearance)/D).toFixed(2);
console.log(`bands: tyre-bottom ${ratio(box.min.y)}D   top ${ratio(box.max.y)}D  (want 0.00 and ~3.40)`);
// outward-normal check on the tub: sample the merged body mesh
let out=0,inn=0;
for (const c of g.children) {
  const geo=c.geometry; if(!geo?.attributes?.normal) continue;
  const p=geo.attributes.position, n=geo.attributes.normal;
  for (let i=0;i<p.count;i+=Math.max(1,Math.floor(p.count/400))) {
    const x=p.getX(i), y=p.getY(i), z=p.getZ(i);
    if (Math.abs(y-0.3)>0.25 || Math.abs(z)>0.5) continue;   // hull side band only
    const d=x*n.getX(i);
    if (Math.abs(x)>0.15) { if(d>0) out++; else inn++; }
  }
}
console.log(`hull side normals: ${out} outward / ${inn} inward  (inward means the loft is inside-out)`);
