// scratch probe: why did leg pairing fail on this model?
import fs from 'node:fs';
import { parseGLB, nodeWorldMatrices } from './stadium-glb.js';
import { boneGeometry, pivotTree, extractChains, subtree } from './stadium-rig-map.js';

const { json, bin } = parseGLB(fs.readFileSync(process.argv[2]));
const ctx = nodeWorldMatrices(json);
const geo = boneGeometry(json, bin, ctx);
const tree = pivotTree(json, ctx);
const chains = extractChains(tree);
let floorY = Infinity, topY = -Infinity, spanX = 0;
for (const g of geo.values()) { floorY = Math.min(floorY, g.min.y); topY = Math.max(topY, g.max.y); spanX = Math.max(spanX, Math.abs(g.min.x), Math.abs(g.max.x)); }
const height = topY - floorY;
console.log('height', height.toFixed(1), 'spanX', spanX.toFixed(1), 'floorY', floorY.toFixed(2));
for (const c of chains) {
  let lowest = { y: Infinity }, count = 0;
  for (const b of subtree(tree, c.bones[0])) {
    const g = geo.get(b);
    if (!g) continue;
    count += g.count;
    if (g.lowest.y < lowest.y) lowest = g.lowest;
  }
  if (!count) continue;
  const floorish = (lowest.y - floorY) < height * 0.15;
  console.log(
    (floorish ? 'FLOOR ' : '      ') + c.bones.map(b => json.nodes[b].name).join('>').padEnd(34),
    'n=' + String(c.bones.length).padStart(2),
    'v=' + String(count).padStart(4),
    'low=(' + [lowest.x, lowest.y, lowest.z].map(v => v.toFixed(1).padStart(6)).join(',') + ')');
}
