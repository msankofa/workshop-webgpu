// test-plants-placement.mjs
import { plantPlacementRecords } from './plants-placement.js';
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

const heightAt = () => 0;
const chunks = [{ key: '0,0', xMin: 0, zMin: 0, size: 30, centerX: 15, centerZ: 15 }];
const speciesTable = [
  { key: 'chickweed', tag: { biomes: ['plains'], density: 1 } },
  { key: 'cleavers',  tag: { biomes: [], density: 0.6 } },
  { key: 'jewelweed', tag: { biomes: ['swamp'], density: 0.8 } },
];
const params = { masterSeed: 20260702, waterLevel: -0.9, shoreMargin: 0.1, plantDensity: 0.3, plantSpeciesTable: speciesTable };

const a = plantPlacementRecords(chunks, params, heightAt);
const b = plantPlacementRecords(chunks, params, heightAt);
ok(a.length > 0, '1: places some plants');
ok(JSON.stringify(a) === JSON.stringify(b), '1: deterministic for the same seed/params');
ok(a.every(r => r.x >= 0 && r.x <= 30 && r.z >= 0 && r.z <= 30), '1: within chunk bounds');
ok(a.every(r => r.speciesIdx >= 0 && r.speciesIdx < speciesTable.length), '1: valid speciesIdx');
ok(a.every(r => typeof r.scale === 'number' && r.scale > 0 && typeof r.yaw === 'number'), '1: has scale + yaw');

// water rejection
const wet = plantPlacementRecords(chunks, params, () => -5);
ok(wet.length === 0, '2: rejects submerged ground');

// biome gating: in an all-desert biome, only the generalist (cleavers, empty biomes) places
const alwaysDesert = () => 'desert';
const desertRecs = plantPlacementRecords(chunks, params, heightAt, alwaysDesert);
ok(desertRecs.length > 0, '3: generalist species still places in an unmatched biome');
ok(desertRecs.every(r => speciesTable[r.speciesIdx].key === 'cleavers'), '3: only the biome-generalist species is picked in an all-desert biome');

// in an all-plains biome, chickweed (and the generalist cleavers) can place, but not jewelweed
const alwaysPlains = () => 'plains';
const plainsRecs = plantPlacementRecords(chunks, params, heightAt, alwaysPlains);
ok(plainsRecs.every(r => speciesTable[r.speciesIdx].key !== 'jewelweed'), '4: swamp-only species never placed in an all-plains biome');
ok(plainsRecs.some(r => speciesTable[r.speciesIdx].key === 'chickweed'), '4: plains-tagged species does place in a plains biome');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
