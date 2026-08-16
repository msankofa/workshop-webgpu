import fs from 'node:fs';
import { parseGLB, nodeWorldMatrices, readSkinnedVertices } from './stadium-glb.js';

const file = process.argv[2];
const { json, bin } = parseGLB(fs.readFileSync(file));
const { world, parent } = nodeWorldMatrices(json);
const verts = readSkinnedVertices(json, bin, { world });

const stats = new Map();
for (let i = 0; i < verts.count; i++) {
  const j = verts.joint[i];
  let s = stats.get(j);
  if (!s) stats.set(j, s = { n: 0, x: 0, y: 0, z: 0, minY: Infinity });
  s.n++; s.x += verts.position[i * 3]; s.y += verts.position[i * 3 + 1]; s.z += verts.position[i * 3 + 2];
  s.minY = Math.min(s.minY, verts.position[i * 3 + 1]);
}

const isPivot = (i) => /^bone\d+$/.test(json.nodes[i].name || '');
const pivots = json.nodes.map((_, i) => i).filter(isPivot);
const pos = (i) => [world[i][12], world[i][13], world[i][14]];
const kids = (i) => (json.nodes[i].children || []).filter(isPivot);
console.log(file, 'pivots', pivots.length, 'verts', verts.count);
for (const i of pivots) {
  const p = pos(i);
  const leaf = (json.nodes[i].children || []).find(c => /_scale$/.test(json.nodes[c].name || ''));
  const s = stats.get(leaf);
  console.log(
    json.nodes[i].name.padEnd(7),
    'par=' + (json.nodes[parent[i]]?.name || '-').padEnd(7),
    'kids=[' + kids(i).map(c => json.nodes[c].name).join(',').padEnd(20) + ']',
    'p=(' + p.map(v => v.toFixed(2).padStart(7)).join(',') + ')',
    s ? `v=${String(s.n).padStart(4)} c=(${(s.x / s.n).toFixed(2).padStart(6)},${(s.y / s.n).toFixed(2).padStart(6)},${(s.z / s.n).toFixed(2).padStart(6)}) minY=${s.minY.toFixed(2)}` : 'v=   0'
  );
}
