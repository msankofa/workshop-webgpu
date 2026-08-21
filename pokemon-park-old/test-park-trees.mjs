// Node checks for the park's tree species table, including a real palette bake and measure.

import * as THREE from 'three';
import { createTree } from './trees.js';
import { createForestPalette } from './forest-palette.js';
import { placementRecords } from './forest-placement.js';
import { EZ_TREE_FAMILIES } from './tree-presets.js';
import { LEAF_FILES } from './tree-textures.js';
import { PARK_TREE_SPECIES, buildParkTreeTable, applyMeasuredHeights, sizeRangeFor, biomesCovered } from './park-trees.js';
import { buildPark, PARK_TERRAIN, PARK_TREE_DENSITY, PARK_BIOMES } from './park-biomes.js';

let pass = 0, fail = 0;
const problems = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

const SIZE_VAR = 0.6;
const table = buildParkTreeTable(EZ_TREE_FAMILIES);

// ===================== the table =====================

check('every authored species is in the table',
  table.length === Object.keys(PARK_TREE_SPECIES).length, `${table.length}`);
check('the trellis preset is left out — there is nothing for it to climb',
  !table.some((sp) => sp._tag.id.includes('trellis')));
check('every entry carries a trees.js opts object', table.every((sp) => Array.isArray(sp.length) && sp.bark && sp.leaves));
check('every entry names at least one biome', table.every((sp) => sp._tag.biomes.length > 0));
check('every named biome is a real park biome',
  table.every((sp) => sp._tag.biomes.every((b) => PARK_BIOMES.includes(b))),
  table.flatMap((sp) => sp._tag.biomes).filter((b) => !PARK_BIOMES.includes(b)).join(', '));
check('every species is shorter at its low end than its high end',
  table.every((sp) => sp._tag.minM > 0 && sp._tag.minM < sp._tag.maxM));

{
  // A biome that grows trees but has no species falls back to "any species", which is exactly the
  // one-forest-everywhere look this table exists to end.
  const covered = new Set(biomesCovered(table));
  const wants = PARK_BIOMES.filter((b) => (PARK_TREE_DENSITY[b] ?? 0) > 0);
  const missing = wants.filter((b) => !covered.has(b));
  check('every biome that grows trees has species of its own', missing.length === 0, missing.join(', '));
}

check('the lake grows nothing', !table.some((sp) => sp._tag.biomes.includes('lake')));

// ===================== the height inversion =====================

{
  const [lo, hi] = sizeRangeFor(10, 20, 40, 0.6);
  const k = 1 - 0.6;
  check('sizeRangeFor puts the top of the span at the target height', Math.abs(hi * 40 - 20) < 1e-9);
  check('and the realised bottom at the low target', Math.abs((lo + k * (hi - lo)) * 40 - 10) < 1e-9,
    `${((lo + k * (hi - lo)) * 40).toFixed(3)} m`);
  const [flo, fhi] = sizeRangeFor(10, 20, 40, 0);
  check('with no variation both ends collapse to the top', flo === fhi);
  check('and a zero natural height does not produce Infinity', Number.isFinite(sizeRangeFor(10, 20, 0, 0.6)[1]));
}

// ===================== the authored leaf atlas =====================

{
  // forest-palette reads sp.leaves.atlas.cell only when a texture set is present. Passing none
  // gives every species a procedural silhouette, which is what shipped first and why the pines
  // grew broadleaves and the trees came out white.
  const byCell = new Map();
  for (const sp of table) byCell.set(sp._tag.id, sp.leaves?.atlas?.cell);
  check('every species names an atlas cell', [...byCell.values()].every((c) => Number.isInteger(c) && c >= 0 && c < 4),
    [...byCell].filter(([, c]) => !Number.isInteger(c)).map(([k]) => k).join(', '));
  check('every pine points at the pine leaf',
    ['ez-pine_small', 'ez-pine_medium', 'ez-pine_large'].every((id) => LEAF_FILES[byCell.get(id)] === 'pine'),
    ['ez-pine_small', 'ez-pine_medium', 'ez-pine_large'].map((id) => `${id}=${LEAF_FILES[byCell.get(id)]}`).join(' '));
  check('and each broadleaf family points at its own',
    LEAF_FILES[byCell.get('ez-oak_large')] === 'oak'
    && LEAF_FILES[byCell.get('ez-ash_large')] === 'ash'
    && LEAF_FILES[byCell.get('ez-aspen_large')] === 'aspen');
}

// ===================== a real bake =====================

// Enough of a texture set to drive the atlas path; the palette reads no actual maps.
const FAKE_TEX = { mode: 'authored', ready: true, leafAtlas: { cols: 2, rows: 2 }, leafAlphaTest: 0.5, barkVScale: 0.35 };
const BAKE_PARAMS = { speciesTable: table, leafSize: 1, leafShadowPct: 0.3, coarseLeafRatio: 0.25, coarseLeafSizeMult: 2.5 };

const t0 = Date.now();
const palette = createForestPalette({
  createTree, params: BAKE_PARAMS,
  masterSeed: 20260616, texSet: FAKE_TEX, variantsPerSpecies: 2,
});
const bakeMs = Date.now() - t0;

{
  // Atlas cards are quads: four verts and six indices per leaf. A procedural silhouette is not.
  const flat = createForestPalette({
    createTree, params: BAKE_PARAMS, masterSeed: 20260616, texSet: null, variantsPerSpecies: 1,
  });
  const atlasLeaves = palette.variants[0].leaves.attributes.position.count;
  const plainLeaves = flat.variants[0].leaves.attributes.position.count;
  check('an authored set changes the leaf geometry', atlasLeaves !== plainLeaves,
    `${atlasLeaves} vs ${plainLeaves} leaf vertices`);
  check('and gives every leaf card a uv to address its cell with',
    !!palette.variants[0].leaves.getAttribute('uv'));
  const uv = palette.variants[0].leaves.getAttribute('uv');
  let outside = 0;
  for (let i = 0; i < uv.count; i++) if (uv.getX(i) < -1e-6 || uv.getX(i) > 1 + 1e-6 || uv.getY(i) < -1e-6 || uv.getY(i) > 1 + 1e-6) outside++;
  check('every leaf uv stays inside the sheet', outside === 0, `${outside} of ${uv.count}`);
  // A card that spans the whole sheet draws all four species at once.
  let spanU = 0, spanV = 0;
  {
    let minU = 1, maxU = 0, minV = 1, maxV = 0;
    for (let i = 0; i < Math.min(uv.count, 4); i++) {
      minU = Math.min(minU, uv.getX(i)); maxU = Math.max(maxU, uv.getX(i));
      minV = Math.min(minV, uv.getY(i)); maxV = Math.max(maxV, uv.getY(i));
    }
    spanU = maxU - minU; spanV = maxV - minV;
  }
  check('a leaf card addresses one cell, not the whole sheet', spanU <= 0.51 && spanV <= 0.51,
    `spans ${spanU.toFixed(2)} x ${spanV.toFixed(2)} of the atlas`);
}

check('the palette has two variants of every species', palette.variants.length === table.length * 2, `${palette.variants.length}`);
check('every variant has branches and leaves',
  palette.variants.every((v) => v.branches.attributes.position.count > 0 && v.leaves.attributes.position.count > 0));

const box = new THREE.Box3();
const natural = [];
for (const v of palette.variants) {
  let hi = -Infinity, lo = Infinity;
  for (const g of [v.branches, v.leaves]) {
    if (!g?.attributes.position.count) continue;
    g.computeBoundingBox();
    box.copy(g.boundingBox);
    hi = Math.max(hi, box.max.y); lo = Math.min(lo, box.min.y);
  }
  natural[v.speciesIdx] = Math.max(natural[v.speciesIdx] ?? 0, hi - lo);
}
check('every species measures a finite natural height', natural.every((h) => Number.isFinite(h) && h > 0));
check('the stock presets really do differ in size', Math.max(...natural) / Math.min(...natural) > 2,
  `${Math.min(...natural).toFixed(0)} to ${Math.max(...natural).toFixed(0)} units`);

applyMeasuredHeights(table, natural, SIZE_VAR);
{
  const k = Math.max(0.12, 1 - SIZE_VAR);
  let worst = 0;
  for (let i = 0; i < table.length; i++) {
    const tag = table[i]._tag;
    const top = tag.sizeRange[1] * natural[i];
    const bottom = (tag.sizeRange[0] + k * (tag.sizeRange[1] - tag.sizeRange[0])) * natural[i];
    worst = Math.max(worst, Math.abs(top - tag.maxM), Math.abs(bottom - tag.minM));
  }
  check('every measured species lands on its authored metres', worst < 0.01, `worst ${worst.toFixed(4)} m off`);
}

// ===================== placement =====================

const park = buildPark({ seed: 4 });
const params = {
  count: 40000, placement: 'random', masterSeed: 20260616,
  maxSize: 1, sizeVar: SIZE_VAR, skew: 0, varPattern: 'random',
  shoreMargin: 0.35, waterLevel: PARK_TERRAIN.waterLevel,
  speciesTable: table, targetChunkCount: 1024,
  treeDensityAt: (x, z) => PARK_TREE_DENSITY[park.map.biomeAt(x, z)] ?? 0,
};
const CH = 75;
const chunks = [];
for (let iz = -16; iz <= 15; iz++) {
  for (let ix = -16; ix <= 15; ix++) {
    chunks.push({ key: `${ix},${iz}`, xMin: ix * CH, zMin: iz * CH, size: CH, centerX: ix * CH + CH / 2, centerZ: iz * CH + CH / 2 });
  }
}
const recs = placementRecords(chunks, params, park.map.heightAt, (x, z) => park.map.biomeAt(x, z));

check('the park plants a forest', recs.length > 5000, `${recs.length} trees`);
{
  const used = new Set(recs.map((r) => r.speciesIdx));
  check('and uses more than one species', used.size >= table.length - 2, `${used.size} of ${table.length}`);
}
{
  // The whole point: a tree standing in a biome its species does not grow in.
  let wrong = 0;
  const offenders = new Set();
  for (const r of recs) {
    const biome = park.map.biomeAt(r.x, r.z);
    const tag = table[r.speciesIdx]._tag;
    if (!tag.biomes.includes(biome)) { wrong++; offenders.add(`${tag.id} in ${biome}`); }
  }
  check('no tree grows in a biome its species does not', wrong === 0, [...offenders].slice(0, 4).join(', '));
}
{
  const pines = recs.filter((r) => table[r.speciesIdx]._tag.id.startsWith('ez-pine'));
  const onMountain = pines.filter((r) => park.map.biomeAt(r.x, r.z) === 'mountain').length;
  check('pines are the mountain tree', pines.length > 100 && onMountain > 0, `${pines.length} pines, ${onMountain} on the mountain`);
  const mountainRecs = recs.filter((r) => park.map.biomeAt(r.x, r.z) === 'mountain');
  const pineShare = mountainRecs.length ? onMountain / mountainRecs.length : 0;
  check('and most of what grows on the mountain is pine or scrub', pineShare > 0.4, `${(pineShare * 100).toFixed(0)}%`);
}
{
  let tallest = 0, shortest = Infinity;
  for (const r of recs) {
    const h = r.scale * natural[r.speciesIdx];
    tallest = Math.max(tallest, h); shortest = Math.min(shortest, h);
  }
  check('the tallest tree in the park is a real tree', tallest > 18 && tallest < 30, `${tallest.toFixed(1)} m`);
  check('and the shortest is a bush, not a sapling of nothing', shortest > 0.4, `${shortest.toFixed(2)} m`);
}
{
  const a = placementRecords(chunks.slice(0, 40), params, park.map.heightAt, (x, z) => park.map.biomeAt(x, z));
  const b = placementRecords(chunks.slice(0, 40), params, park.map.heightAt, (x, z) => park.map.biomeAt(x, z));
  check('placement is deterministic', JSON.stringify(a) === JSON.stringify(b));
}

console.log(`\npark trees: ${pass}/${pass + fail} checks passed`);
console.log(`  ${table.length} species, ${palette.variants.length} variants baked in ${bakeMs} ms, ${recs.length} trees placed`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
