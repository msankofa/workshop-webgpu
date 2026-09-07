// Compare an edited GLB against the code build by part NAME: what moved, what is new, what is gone.
// Names come from setMeshAuthoring(true), so this is the readable round trip.
import fs from 'node:fs';
import * as THREE from 'three';
import { buildCraftMesh, setMeshAuthoring } from '../../flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS } from '../../base-game-vehicles.js';

const file = process.argv[2] || 'export/ugv-3.glb';
const kind = process.argv[3] || 'ugv';

const M = { standard: (c, e = 0) => new THREE.MeshStandardMaterial({ color: c, emissive: e }),
            basic: (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, opacity: o }) };
setMeshAuthoring(true);
const g = buildCraftMesh(kind, 0x5c6b3c, M, BASE_GAME_VEHICLE_DEFS[kind]);
setMeshAuthoring(false);
g.updateMatrixWorld(true);

const code = new Map();
{
  const box = new THREE.Box3(), s = new THREE.Vector3(), c = new THREE.Vector3();
  g.traverse((o) => {
    if (!o.geometry) return;
    box.setFromObject(o); box.getSize(s); box.getCenter(c);
    const ix = o.geometry.index, pos = o.geometry.attributes.position;
    code.set(o.name, { size: [s.x, s.y, s.z], at: [c.x, c.y, c.z], tris: (ix ? ix.count : pos.count) / 3 });
  });
}

const buf = fs.readFileSync(file);
const jl = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
// Full node matrices, not just translations: a rotated cylinder's world box is not its local box,
// and comparing the two makes every rotated part look resized.
const world = new Array(gltf.nodes.length);
const parent = new Array(gltf.nodes.length).fill(null);
const walk = (i, pm) => {
  const n = gltf.nodes[i];
  const local = new THREE.Matrix4();
  if (n.matrix) local.fromArray(n.matrix);
  else local.compose(
    new THREE.Vector3(...(n.translation || [0, 0, 0])),
    new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1])),
    new THREE.Vector3(...(n.scale || [1, 1, 1])));
  world[i] = new THREE.Matrix4().multiplyMatrices(pm, local);
  for (const c of n.children || []) { parent[c] = i; walk(c, world[i]); }
};
for (const r of gltf.scenes[0].nodes) walk(r, new THREE.Matrix4());

const edit = new Map();
gltf.nodes.forEach((n, i) => {
  if (n.mesh === undefined || !n.name) return;
  const box = new THREE.Box3();
  let tris = 0;
  for (const p of gltf.meshes[n.mesh].primitives) {
    const a = gltf.accessors[p.attributes.POSITION];
    // Every corner of the local box through the world matrix, so rotation is accounted for.
    for (let c = 0; c < 8; c++) {
      box.expandByPoint(new THREE.Vector3(
        c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2],
      ).applyMatrix4(world[i]));
    }
    tris += (p.indices !== undefined ? gltf.accessors[p.indices].count : a.count) / 3;
  }
  const bs = new THREE.Vector3(), bc = new THREE.Vector3();
  box.getSize(bs); box.getCenter(bc);
  // Named parents are the groups the game trains: report which one a part hangs off.
  let owner = 'root', up = parent[i];
  while (up !== null && up !== undefined) {
    const nm = gltf.nodes[up].name || '';
    if (/wheel|turret|elevation/i.test(nm)) { owner = nm; break; }
    up = parent[up];
  }
  edit.set(n.name, {
    size: [bs.x, bs.y, bs.z], at: [bc.x, bc.y, bc.z],
    tris, owner, rot: gltf.nodes[i].rotation || null,
  });
});

const f = (v) => v.map(x => (x >= 0 ? ' ' : '') + x.toFixed(3)).join(' ');
const moved = [], resized = [], reshaped = [], added = [], removed = [];
for (const [n, e] of edit) {
  const c = code.get(n);
  if (!c) { added.push([n, e]); continue; }
  const d = e.at.map((v, k) => v - c.at[k]);
  const ds = e.size.map((v, k) => v - c.size[k]);
  if (Math.max(...d.map(Math.abs)) > 0.002) moved.push([n, d, e]);
  if (Math.max(...ds.map(Math.abs)) > 0.002) resized.push([n, ds]);
  // A box and a bevelled box can share a bounding box. Triangle count is what catches that.
  if (Math.round(e.tris) !== Math.round(c.tris)) reshaped.push([n, c.tris, e.tris]);
}
for (const n of code.keys()) if (!edit.has(n)) removed.push(n);

console.log(`${file}: ${edit.size} named parts vs ${code.size} in the code\n`);
console.log(`moved (${moved.length}):`);
for (const [n, d, e] of moved) console.log('  ', n.padEnd(26), f(d), e.rot ? ' rotated' : '');
console.log(`\nresized (${resized.length}):`);
for (const [n, d] of resized) console.log('  ', n.padEnd(26), f(d));
console.log(`\nreshaped — same box, different geometry (${reshaped.length}):`);
for (const [n, a, b] of reshaped) console.log('  ', n.padEnd(26), `${Math.round(a)} tris in the code -> ${Math.round(b)} in the edit`);
console.log(`\nnew (${added.length}):`);
for (const [n, e] of added) console.log('  ', n.padEnd(26), 'tris', String(Math.round(e.tris)).padEnd(5),
  'size', f(e.size), ' at', f(e.at), ' on', e.owner);
console.log(`\ngone (${removed.length}):`);
for (const n of removed) console.log('  ', n);
