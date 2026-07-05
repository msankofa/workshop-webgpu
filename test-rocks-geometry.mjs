// test-rocks-geometry.mjs
import * as THREE from 'three';
import { buildRockGeometry, createRockPalette, DEFAULT_ROCK_TYPES } from './rocks.js';
import { rngFrom } from './forest-placement.js';

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// ---- 1: welded -> indexed, fewer unique verts than the raw non-indexed icosahedron ----
const rawDetail1 = new THREE.IcosahedronGeometry(1, 1);
const rawVertCount = rawDetail1.getAttribute('position').count;
rawDetail1.dispose();

const geo = buildRockGeometry(rngFrom(1234), { detail: 1, squash: 0.65 });
ok(geo.getIndex() != null, '1: geometry is indexed (welded)');
ok(geo.getAttribute('position').count < rawVertCount, '1: welding reduced vertex count vs. raw non-indexed icosahedron');
ok(geo.getIndex().count === rawVertCount, '1: index count preserves the original triangle count (same topology, fewer unique verts)');

// ---- 2: finite vertices, unit normals ----
const pos = geo.getAttribute('position');
const nrm = geo.getAttribute('normal');
let allFinite = true, allUnitNormal = true;
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) allFinite = false;
  const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
  const len = Math.hypot(nx, ny, nz);
  if (Math.abs(len - 1) > 1e-3) allUnitNormal = false;
}
ok(allFinite, '2: all vertex positions are finite');
ok(allUnitNormal, '2: all vertex normals are unit length');

// ---- 3: squash applied (Y extent noticeably smaller than X/Z extent for a low squash) ----
function extents(g) {
  const p = g.getAttribute('position');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { xRange: maxX - minX, yRange: maxY - minY, zRange: maxZ - minZ };
}
const squashedGeo = buildRockGeometry(rngFrom(55), { detail: 1, squash: 0.55 });
const unsquashedGeo = buildRockGeometry(rngFrom(55), { detail: 1, squash: 1.0 });
const eSquashed = extents(squashedGeo);
const eUnsquashed = extents(unsquashedGeo);
ok(eSquashed.yRange < eUnsquashed.yRange, '3: squash=0.55 produces a smaller Y extent than squash=1.0 (same seed)');
ok(eSquashed.yRange / eSquashed.xRange < eUnsquashed.yRange / eUnsquashed.xRange, '3: squash lowers the Y/X aspect ratio');

// ---- 4: baked upness/cavity attributes exist and are in [0,1] ----
const up = geo.getAttribute('rockUpness');
const cav = geo.getAttribute('rockCavity');
ok(up != null && cav != null, '4: rockUpness/rockCavity attributes exist');
let upInRange = true, cavInRange = true;
for (let i = 0; i < up.count; i++) {
  const u = up.getX(i), c = cav.getX(i);
  if (u < 0 || u > 1) upInRange = false;
  if (c < 0 || c > 1) cavInRange = false;
}
ok(upInRange, '4: rockUpness values all within [0,1]');
ok(cavInRange, '4: rockCavity values all within [0,1]');
// upness should not be uniformly zero or one across a whole boulder (real variation)
const upVals = Array.from({ length: up.count }, (_, i) => up.getX(i));
ok(Math.max(...upVals) > 0.3 && Math.min(...upVals) < 0.3, '4: rockUpness varies across the boulder surface');

// ---- 5: determinism (same seed -> byte-identical geometry) ----
const gA = buildRockGeometry(rngFrom(777), { detail: 1, squash: 0.7 });
const gB = buildRockGeometry(rngFrom(777), { detail: 1, squash: 0.7 });
ok(
  JSON.stringify(Array.from(gA.getAttribute('position').array)) === JSON.stringify(Array.from(gB.getAttribute('position').array)),
  '5: same seed produces byte-identical positions',
);
ok(
  JSON.stringify(Array.from(gA.getAttribute('rockUpness').array)) === JSON.stringify(Array.from(gB.getAttribute('rockUpness').array)),
  '5: same seed produces byte-identical baked upness',
);
const gDiffSeed = buildRockGeometry(rngFrom(778), { detail: 1, squash: 0.7 });
ok(
  JSON.stringify(Array.from(gA.getAttribute('position').array)) !== JSON.stringify(Array.from(gDiffSeed.getAttribute('position').array)),
  '5: different seed produces different geometry',
);

// ---- 6: createRockPalette is data-driven (no hardcoded variant count) ----
const palette3 = createRockPalette({ masterSeed: 5 });
ok(palette3.types.length === DEFAULT_ROCK_TYPES.length, '6: default palette has DEFAULT_ROCK_TYPES.length types');
ok(palette3.types.some(t => t.scree), '6: default palette includes at least one scree type');
ok(palette3.variants.length === palette3.types.reduce((s, t) => s + t.count, 0), '6: variants length matches sum of per-type seed counts');

const customTypes = [
  { key: 'a', seedsPerType: 2 },
  { key: 'b', seedsPerType: 1 },
  { key: 'c', seedsPerType: 5, scree: true },
  { key: 'd', seedsPerType: 1 },
  { key: 'e', seedsPerType: 1 },
];
const paletteN = createRockPalette({ variants: customTypes, masterSeed: 9 });
ok(paletteN.types.length === 5, '6: an arbitrary 5-type table produces 5 types with zero code changes');
ok(paletteN.variants.length === 2 + 1 + 5 + 1 + 1, '6: arbitrary per-type seed counts are all honored');
ok(paletteN.types[2].scree === true && paletteN.types[2].count === 5, '6: scree flag and count are preserved per type');

// screeVariant shorthand
const paletteShorthand = createRockPalette({ variants: [{ key: 'x', seedsPerType: 1 }, { key: 'y', seedsPerType: 1 }], screeVariant: 'y' });
ok(paletteShorthand.types.find(t => t.key === 'y').scree === true, '6: screeVariant shorthand marks the matching type as scree');
ok(paletteShorthand.types.find(t => t.key === 'x').scree === false, '6: screeVariant shorthand leaves other types as boulders');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
