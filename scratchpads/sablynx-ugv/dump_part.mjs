// Unique world-space corners of named parts in a GLB, so a reshaped part can be read off directly.
import fs from 'node:fs';
import * as THREE from 'three';

const file = process.argv[2];
const wanted = process.argv.slice(3);
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
  const n = gltf.nodes[i], l = new THREE.Matrix4();
  if (n.matrix) l.fromArray(n.matrix);
  else l.compose(new THREE.Vector3(...(n.translation || [0, 0, 0])),
    new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1])),
    new THREE.Vector3(...(n.scale || [1, 1, 1])));
  world[i] = new THREE.Matrix4().multiplyMatrices(pm, l);
  for (const c of n.children || []) walk(c, world[i]);
};
for (const r of gltf.scenes[0].nodes) walk(r, new THREE.Matrix4());

gltf.nodes.forEach((n, i) => {
  if (n.mesh === undefined || !n.name) return;
  if (wanted.length && !wanted.includes(n.name)) return;
  const seen = new Set(), v = new THREE.Vector3();
  let tris = 0;
  for (const p of gltf.meshes[n.mesh].primitives) {
    const pos = floats(p.attributes.POSITION);
    tris += (p.indices !== undefined ? gltf.accessors[p.indices].count : pos.length / 3) / 3;
    for (let k = 0; k < pos.length; k += 3) {
      v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(world[i]);
      seen.add([v.x, v.y, v.z].map(x => x.toFixed(3)).join(' '));
    }
  }
  console.log(`\n${n.name}  ${seen.size} unique corners, ${Math.round(tris)} tris`);
  for (const s of [...seen].sort()) console.log('  ', s);
});
