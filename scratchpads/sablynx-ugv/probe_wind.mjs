import * as THREE from 'three';
import { buildCraftMesh } from '../../flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS } from '../../base-game-vehicles.js';
const M = { standard:(c,e=0)=>new THREE.MeshStandardMaterial({color:c,emissive:e}), basic:(c,o=1)=>new THREE.MeshBasicMaterial({color:c,opacity:o}) };
function signedVolume(geo){
  const p=geo.attributes.position, idx=geo.index; let v=0;
  const n=idx?idx.count:p.count;
  for(let i=0;i<n;i+=3){
    const a=idx?idx.getX(i):i, b=idx?idx.getX(i+1):i+1, c=idx?idx.getX(i+2):i+2;
    const ax=p.getX(a),ay=p.getY(a),az=p.getZ(a);
    const bx=p.getX(b),by=p.getY(b),bz=p.getZ(b);
    const cx=p.getX(c),cy=p.getY(c),cz=p.getZ(c);
    v += (ax*(by*cz-bz*cy) - ay*(bx*cz-bz*cx) + az*(bx*cy-by*cx))/6;
  }
  return v;
}
for (const kind of ['ugv','buggy']) {
  const def = BASE_GAME_VEHICLE_DEFS[kind];
  const g = buildCraftMesh(kind, 0x6b7a4a, M, def);
  console.log(`\n${kind}:`);
  g.traverse(o=>{ if(o.geometry){
    const v=signedVolume(o.geometry);
    const c=o.material.color.getHexString();
    if (Math.abs(v)>1e-4) console.log(`  #${c}  signed volume ${v>=0?'+':''}${v.toFixed(4)} m3 ${v<0?'  <-- INSIDE-OUT':''}`);
  }});
}
