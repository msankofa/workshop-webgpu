// Vertex-level comparison of an edited GLB against the code build, per named part. Bounding boxes
// and triangle counts both miss a shape change that keeps them: this compares the points.
import fs from 'node:fs';
import * as THREE from 'three';
import { buildCraftMesh, setMeshAuthoring } from '../../flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS } from '../../base-game-vehicles.js';

const file = process.argv[2] || 'export/ugv-3.5.glb';
const kind = process.argv[3] || 'ugv';
// Names differ where a part was duplicated in Blender; map the edit's name onto the code's.
const ALIAS = new Map([
  ['ugv-mast-post', 'ugv-mast-post-r'], ['ugv-mast-post.001', 'ugv-mast-post-l'],
  ['ugv-mast-brace', 'ugv-mast-brace-r'], ['ugv-mast-brace.001', 'ugv-mast-brace-l'],
  ['ugv-receiver.001', 'ugv-receiver'],
]);

const M = { standard: (c, e = 0) => new THREE.MeshStandardMaterial({ color: c, emissive: e }),
            basic: (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, opacity: o }) };
setMeshAuthoring(true);
const g = buildCraftMesh(kind, 0x5c6b3c, M, BASE_GAME_VEHICLE_DEFS[kind]);
setMeshAuthoring(false);
g.updateMatrixWorld(true);

const codeVerts = new Map();
g.traverse((o) => {
  if (!o.geometry || !o.name) return;
  const pos = o.geometry.attributes.position, v = new THREE.Vector3(), out = [];
  for (let i = 0; i < pos.count; i++) out.push(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).toArray());
  codeVerts.set(o.name, out);
});

const buf = fs.readFileSync(file);
const jl = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
const binStart = 20 + jl + 8;
const floats = (acc) => {
  const a = gltf.accessors[acc], bv = gltf.bufferViews[a.bufferView];
  const off = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0);
  return new Float32Array(buf.buffer, buf.byteOffset + off, a.count * 3);
};
const world = new Array(gltf.nodes.length);
const walk = (i, pm) => {
  const n = gltf.nodes[i], local = new THREE.Matrix4();
  if (n.matrix) local.fromArray(n.matrix);
  else local.compose(new THREE.Vector3(...(n.translation || [0, 0, 0])),
    new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1])),
    new THREE.Vector3(...(n.scale || [1, 1, 1])));
  world[i] = new THREE.Matrix4().multiplyMatrices(pm, local);
  for (const c of n.children || []) walk(c, world[i]);
};
for (const r of gltf.scenes[0].nodes) walk(r, new THREE.Matrix4());

const editVerts = new Map();
gltf.nodes.forEach((n, i) => {
  if (n.mesh === undefined || !n.name) return;
  const out = [], v = new THREE.Vector3();
  for (const p of gltf.meshes[n.mesh].primitives) {
    const pos = floats(p.attributes.POSITION);
    for (let k = 0; k < pos.length; k += 3) out.push(v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(world[i]).toArray());
  }
  editVerts.set(ALIAS.get(n.name) || n.name, out);
});

// Nearest-point distance each way, so a moved or reshaped face shows up wherever it went.
const hausdorff = (A, B) => {
  let worst = 0;
  for (const a of A) {
    let best = Infinity;
    for (const b of B) {
      const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return Math.sqrt(worst);
};

const rows = [];
for (const [n, e] of editVerts) {
  const c = codeVerts.get(n);
  if (!c) { rows.push([n, NaN, e.length, 0]); continue; }
  const d = Math.max(hausdorff(e, c), hausdorff(c, e));
  rows.push([n, d, e.length, c.length]);
}
rows.sort((a, b) => (b[1] || 0) - (a[1] || 0));
console.log(`${file}: worst vertex mismatch per part, metres\n`);
let clean = 0;
for (const [n, d, ec, cc] of rows) {
  if (Number.isFinite(d) && d < 0.001) { clean++; continue; }
  console.log('  ', n.padEnd(26), Number.isFinite(d) ? d.toFixed(4) : 'no counterpart',
    ec === cc ? '' : `  verts ${cc} -> ${ec}`);
}
console.log(`\n${clean} of ${rows.length} parts match within 1 mm.`);
