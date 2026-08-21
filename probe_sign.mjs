import fs from 'node:fs';
import { parseGLB } from './stadium-glb.js';
import { skinnedTriangles, normaliseTriangles, trianglesByBone, insideField, insideAt, tileExtent, bakeTile } from './demos/sdf-mesh-bake.js';
import { bake, TILE_RES, TILE_PAD } from './demos/sdf-pikachu-field.js';

const m = process.argv[2] ?? '006_charizard';
const { json, bin } = parseGLB(fs.readFileSync(`models/stadium/${m}.glb`));
const baked = bake(json, bin);
const tris = normaliseTriangles(skinnedTriangles(json, bin), baked.mid, baked.scale);
const byBone = trianglesByBone(tris);

for (const res of [48, 64, 96, 128]) {
  const f = insideField(tris, [-0.8, -0.1, -0.8], [0.8, 1.1, 0.8], res);
  const step = Math.max(...f.cell) * 1.5;
  let hits = 0, tried = 0;
  for (let t = 0; t < tris.count; t++) {
    const o = t * 9;
    const ux = tris.xyz[o + 3] - tris.xyz[o], uy = tris.xyz[o + 4] - tris.xyz[o + 1], uz = tris.xyz[o + 5] - tris.xyz[o + 2];
    const vx = tris.xyz[o + 6] - tris.xyz[o], vy = tris.xyz[o + 7] - tris.xyz[o + 1], vz = tris.xyz[o + 8] - tris.xyz[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    const cx = (tris.xyz[o] + tris.xyz[o + 3] + tris.xyz[o + 6]) / 3;
    const cy = (tris.xyz[o + 1] + tris.xyz[o + 4] + tris.xyz[o + 7]) / 3;
    const cz = (tris.xyz[o + 2] + tris.xyz[o + 5] + tris.xyz[o + 8]) / 3;
    tried++;
    if (insideAt(f, cx - nx / len * step, cy - ny / len * step, cz - nz / len * step)) hits++;
  }
  console.log(`${m} sign res ${res}: ${(hits / tried * 100).toFixed(0)}% of ${tried} triangles have an inside under them, cell ${f.cell[0].toFixed(4)}`);
}

const inside = insideField(tris, [-0.8, -0.1, -0.8], [0.8, 1.1, 0.8], 96);
let hollow = 0;
for (const bone of baked.bones) {
  const idx = byBone.get(bone.pivot);
  if (!idx?.length) continue;
  const half = tileExtent(tris, idx, bone.box, TILE_PAD);
  const cube = bakeTile(tris, idx, bone.box, { res: TILE_RES, half, inside });
  let neg = 0;
  for (const v of cube) if (v < 0) neg++;
  if (!neg) { hollow++; console.log(`  no interior: bone ${bone.pivot}, ${idx.length} tris, half ${half.map(h => h.toFixed(3)).join(',')}`); }
}
console.log(`${hollow} of ${baked.bones.length} bones have no interior at all`);
