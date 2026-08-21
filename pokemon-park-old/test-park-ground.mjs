// Node checks for the park's ground mesh, including a headless compile of its TSL graph.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSL from 'three/tsl';
import { buildParkGround, PARK_GROUND_COLORS, bakeBiomeImage } from './park-ground.js';
import { buildPark, PARK_TERRAIN, PARK_BIOMES, PARK_BIOME_COLORS } from './park-biomes.js';
import { buildMaterial } from './tsl-build-check.mjs';

let pass = 0, fail = 0;
const problems = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

const t0 = Date.now();
const park = buildPark({ seed: 4 });
const buildMs = Date.now() - t0;

const t1 = Date.now();
const ground = buildParkGround({ THREE, MeshStandardNodeMaterial, TSL, park, stride: PARK_TERRAIN.meshStride });
const meshMs = Date.now() - t1;

check('every biome has a ground colour',
  PARK_BIOMES.every((b) => PARK_GROUND_COLORS[b]),
  PARK_BIOMES.filter((b) => !PARK_GROUND_COLORS[b]).join(', '));

check('the mesh has geometry', ground.triangles > 0 && ground.vertices > 0);
check('the decimated sheet reaches the far edge', ground.gridSize === Math.floor((PARK_TERRAIN.resolution - 1) / PARK_TERRAIN.meshStride) + 1,
  `${ground.gridSize} across`);

{
  const pos = ground.geometry.getAttribute('position');
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, bad = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) bad++;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  check('no vertex is NaN', bad === 0, `${bad} bad vertices`);
  // A seam at two edges is what you get from `res / stride` instead of `(res - 1) / stride + 1`.
  check('the sheet spans the whole park in x',
    Math.abs(minX + PARK_TERRAIN.worldX / 2) < 1e-3 && Math.abs(maxX - PARK_TERRAIN.worldX / 2) < 1e-3,
    `${minX.toFixed(2)} .. ${maxX.toFixed(2)}`);
  check('and in z',
    Math.abs(minZ + PARK_TERRAIN.worldZ / 2) < 1e-3 && Math.abs(maxZ - PARK_TERRAIN.worldZ / 2) < 1e-3,
    `${minZ.toFixed(2)} .. ${maxZ.toFixed(2)}`);
}

{
  const col = ground.geometry.getAttribute('color');
  let outOfRange = 0, grey = 0;
  for (let i = 0; i < col.count; i++) {
    for (const v of [col.getX(i), col.getY(i), col.getZ(i)]) if (!(v >= 0 && v <= 1)) outOfRange++;
    if (Math.abs(col.getX(i) - col.getY(i)) < 0.005 && Math.abs(col.getY(i) - col.getZ(i)) < 0.005) grey++;
  }
  check('every vertex colour is in gamut', outOfRange === 0, `${outOfRange} components out of 0..1`);
  check('the ground is not uniformly grey', grey / col.count < 0.35, `${((grey / col.count) * 100).toFixed(0)}% grey`);
}

{
  const nrm = ground.geometry.getAttribute('normal');
  let unnormalised = 0, downward = 0;
  for (let i = 0; i < nrm.count; i++) {
    const l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    if (Math.abs(l - 1) > 1e-3) unnormalised++;
    if (nrm.getY(i) <= 0) downward++;
  }
  check('every normal is unit length', unnormalised === 0, `${unnormalised} bad`);
  // A heightfield normal that points down means the cross product was taken the
  check('every normal points up', downward === 0, `${downward} normals point down`);
}

{
  const index = ground.geometry.getIndex();
  check('the index buffer is wide enough for the vertex count',
    ground.vertices <= 65535 || index.array instanceof Uint32Array,
    `${ground.vertices} vertices in a ${index.array.constructor.name}`);
  let outOfBounds = 0;
  for (let i = 0; i < index.count; i++) if (index.getX(i) >= ground.vertices) outOfBounds++;
  check('no index points past the end', outOfBounds === 0, `${outOfBounds}`);
}

{
  // The drawn surface and the field agree at the sheet's own vertices and nowhere else.
  const half = PARK_TERRAIN.worldX / 2;
  const step = PARK_TERRAIN.worldX / (ground.gridSize - 1);
  let worstAtVertex = 0;
  for (let j = 0; j < ground.gridSize; j += 7) {
    for (let i = 0; i < ground.gridSize; i += 7) {
      const x = -half + i * step, z = -half + j * step;
      worstAtVertex = Math.max(worstAtVertex, Math.abs(ground.surfaceHeightAt(x, z) - park.map.heightAt(x, z)));
    }
  }
  check('the drawn surface matches the field at its own vertices', worstAtVertex < 0.02,
    `worst ${worstAtVertex.toFixed(4)} m`);

  let worstBetween = 0;
  for (let j = 0; j < ground.gridSize - 1; j += 7) {
    for (let i = 0; i < ground.gridSize - 1; i += 7) {
      const x = -half + (i + 0.5) * step, z = -half + (j + 0.5) * step;
      worstBetween = Math.max(worstBetween, Math.abs(ground.surfaceHeightAt(x, z) - park.map.heightAt(x, z)));
    }
  }
  check('and departs from it between them, which is why both exist', worstBetween > 0.005,
    `worst ${worstBetween.toFixed(4)} m — if this is zero the sampler is reading the field, not the mesh`);
  console.log(`  surface vs field: ${worstAtVertex.toFixed(4)} m at vertices, ${worstBetween.toFixed(3)} m between`);
}

{
  const h = ground.surfaceHeightAt(0, 0);
  check('surfaceHeightAt clamps outside the park rather than returning NaN',
    Number.isFinite(ground.surfaceHeightAt(1e6, -1e6)) && Number.isFinite(h));
  const near = ground.surfaceMaxNear(0, 0, 12);
  check('surfaceMaxNear is at least the point itself', near >= h - 1e-6, `${near} vs ${h}`);
  check('and a wider reach never returns less', ground.surfaceMaxNear(0, 0, 40) >= near - 1e-6);
}

{
  // Stepping by a whole cell rather than by r reads far outside the radius asked for, which lifts
  // anything draped on the sheet off a slope. Roads pass reaches well under one cell.
  const cell = PARK_TERRAIN.worldX / (PARK_TERRAIN.resolution - 1) * PARK_TERRAIN.meshStride;
  let worstTight = 0, worstWide = 0;
  for (let k = 0; k < 3000; k++) {
    const x = ((k * 7919) % 2200) - 1100, z = ((k * 104729) % 2200) - 1100;
    const at = ground.surfaceHeightAt(x, z);
    worstTight = Math.max(worstTight, ground.surfaceMaxNear(x, z, 0.9) - at);
    worstWide = Math.max(worstWide, ground.surfaceMaxNear(x, z, cell * 2) - at);
  }
  check('a sub-cell reach stays much tighter than a multi-cell one', worstTight < worstWide * 0.6,
    `${worstTight.toFixed(2)} m over 0.9 m vs ${worstWide.toFixed(2)} m over ${(cell * 2).toFixed(1)} m`);
  console.log(`  maxNear lift: ${worstTight.toFixed(2)} m at r=0.9, ${worstWide.toFixed(2)} m at r=${(cell * 2).toFixed(1)}`);
}

{
  const img = bakeBiomeImage(park.map, PARK_BIOME_COLORS);
  check('the minimap image is the right size', img.data.length === img.width * img.height * 4);
  check('and is fully opaque', img.data[3] === 255 && img.data[img.data.length - 1] === 255);
}

// ===================== the TSL graph =====================

{
  let built = null, err = null;
  try {
    built = await buildMaterial(ground.material, ground.geometry);
  } catch (e) { err = e; }
  check('the ground material compiles', !!built, err ? String(err.message).slice(0, 200) : '');
  if (built) {
    check('the fragment shader carries the noise breakup', /mx_fractal_noise/.test(built.fragment) || /noise/i.test(built.fragment));
    check('and reads the vertex colour', /vColor|color/i.test(built.fragment));
    check('and the lighting path survived', /diffuse|irradiance|reflectedLight/i.test(built.fragment),
      'a dead-code-eliminated lighting path means the material proves nothing');
  }
}

console.log(`\npark ground: ${pass}/${pass + fail} checks passed`);
console.log(`  field ${PARK_TERRAIN.resolution}^2 in ${buildMs} ms · mesh ${ground.gridSize}^2 = ${(ground.triangles / 1000).toFixed(0)}k triangles in ${meshMs} ms`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
