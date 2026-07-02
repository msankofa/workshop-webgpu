import { placementRecords, buildSpeciesFromFamilies } from './forest-placement.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// flat ground at y=0 everywhere (dry); one 30-unit chunk at origin.
const heightAt = () => 0;
const chunks = [{ key: '0,0', xMin: 0, zMin: 0, size: 30, centerX: 15, centerZ: 15 }];
const params = { count: 12, placement: 'random', species: 3, diversity: 0.5, generalization: 0.5,
  maxSize: 0.55, sizeVar: 0.6, skew: 0, shoreMargin: 0.1, treeBaseOffset: -0.1, masterSeed: 20260616, waterLevel: -0.9 };

const a = placementRecords(chunks, params, heightAt);
const b = placementRecords(chunks, params, heightAt);
ok(a.length > 0 && a.length <= 12, '1: places up to count trees');
ok(JSON.stringify(a) === JSON.stringify(b), '1: deterministic for same seed/params');
ok(a.every(r => r.x >= 0 && r.x <= 30 && r.z >= 0 && r.z <= 30), '1: within chunk bounds');
ok(a.every(r => typeof r.scale === 'number' && r.scale > 0), '1: positive scale');
ok(a.every(r => r.speciesIdx >= 0 && r.speciesIdx < params.species), '1: valid speciesIdx');
ok(a.every(r => typeof r.yaw === 'number'), '1: has yaw');

// water rejection: ground below waterLevel+shoreMargin -> no placements.
const wet = placementRecords(chunks, { ...params }, () => -5);
ok(wet.length === 0, '1: rejects submerged ground');

// ---- authored species table: biome-filtered, density-weighted selection ----
const families = [{
  id: 'f1',
  species: [
    { name: 'Forest Oak', opts: { levels: 3 }, biomes: ['forest'], density: 5, sizeRange: [2, 3] },
    { name: 'Desert Cactus', opts: { levels: 1 }, biomes: ['desert'], density: 1, sizeRange: [0.1, 0.2] },
  ],
}];
const table = buildSpeciesFromFamilies(families);
ok(table.length === 2, '2: flattens families into a species table');
ok(table[0].levels === 3 && table[0]._tag.biomes[0] === 'forest', '2: species entry keeps opts + tag');

const denseChunks = [{ key: '0,0', xMin: 0, zMin: 0, size: 30, centerX: 15, centerZ: 15 }];
const denseParams = { ...params, count: 40, speciesTable: table };
const alwaysForest = () => 'forest';
const biomeRecs = placementRecords(denseChunks, denseParams, heightAt, alwaysForest);
ok(biomeRecs.length > 0, '2: places trees with a species table');
ok(biomeRecs.every(r => r.speciesIdx === 0), "2: only the 'forest'-tagged species is ever picked in an all-forest biome");
ok(biomeRecs.every(r => r.scale >= 2 && r.scale <= 3), '2: scale stays within the winning species\' sizeRange');

// no biomeAt: every species is a density-weighted candidate everywhere (procedural infinite terrain has no biomes).
const noBiomeRecs = placementRecords(denseChunks, denseParams, heightAt);
const seenIdx = new Set(noBiomeRecs.map(r => r.speciesIdx));
ok(seenIdx.has(0) || seenIdx.has(1), '2: without biomeAt, species table is still consulted');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
