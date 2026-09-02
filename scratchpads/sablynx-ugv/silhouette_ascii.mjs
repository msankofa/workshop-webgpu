import * as THREE from 'three';
import { buildCraftMesh } from '../../flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS } from '../../base-game-vehicles.js';
const M = { standard:(c,e=0)=>new THREE.MeshStandardMaterial({color:c,emissive:e}), basic:(c,o=1)=>new THREE.MeshBasicMaterial({color:c,opacity:o}) };
const kind = process.argv[2] || 'ugv';
const def = BASE_GAME_VEHICLE_DEFS[kind];
const g = buildCraftMesh(kind, 0x6b7a4a, M, def); g.updateMatrixWorld(true);
const tris=[]; const v=new THREE.Vector3();
g.traverse(o=>{ if(!o.geometry) return; const p=o.geometry.attributes.position, ix=o.geometry.index;
  const n = ix?ix.count:p.count;
  for(let i=0;i<n;i+=3){ const t=[];
    for(let k=0;k<3;k++){ const a=ix?ix.getX(i+k):i+k; v.fromBufferAttribute(p,a).applyMatrix4(o.matrixWorld); t.push([v.x,v.y,v.z]); }
    tris.push(t); } });
const box=new THREE.Box3().setFromObject(g);
function view(name, hAxis, vAxis, W, H, flipH){
  const h0=box.min.getComponent(hAxis), h1=box.max.getComponent(hAxis);
  const v0=box.min.getComponent(vAxis), v1=box.max.getComponent(vAxis);
  const grid=Array.from({length:H},()=>new Array(W).fill(0));
  for(const t of tris){
    const hs=t.map(p=>p[hAxis]), vs=t.map(p=>p[vAxis]);
    let c0=Math.floor((Math.min(...hs)-h0)/(h1-h0)*(W-1)), c1=Math.ceil((Math.max(...hs)-h0)/(h1-h0)*(W-1));
    let r0=Math.floor((v1-Math.max(...vs))/(v1-v0)*(H-1)), r1=Math.ceil((v1-Math.min(...vs))/(v1-v0)*(H-1));
    for(let r=Math.max(0,r0);r<=Math.min(H-1,r1);r++) for(let c=Math.max(0,c0);c<=Math.min(W-1,c1);c++) grid[r][c]=1;
  }
  const D=def.wheelbase*0.55;
  console.log(`\n${name}   ${(h1-h0).toFixed(2)} x ${(v1-v0).toFixed(2)} m`);
  grid.forEach((row,r)=>{
    const y = v1-(r/(H-1))*(v1-v0);
    const lab = vAxis===1 ? `${((y+def.clearance)/D).toFixed(2)}D` : '     ';
    const line = (flipH?[...row].reverse():row).map(x=>x?'#':' ').join('');
    console.log(`${lab.padStart(6)} |${line}|`);
  });
}
view('SIDE (nose left, looking from port)', 2, 1, 92, 34, true);
view('FRONT (looking down +Z)', 0, 1, 46, 30, false);
