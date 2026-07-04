// test-plants-placement.mjs
import { plantPlacementRecords } from './plants-placement.js';
import { buildChunkIndex } from './grass-anchors.js';
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

// clustering: strength 0 (default/omitted) reproduces the unclustered baseline exactly
const bigChunks = [];
for (let ix = 0; ix < 6; ix++) for (let iz = 0; iz < 6; iz++) {
  bigChunks.push({ key: `${ix},${iz}`, xMin: ix * 30, zMin: iz * 30, size: 30, centerX: ix * 30 + 15, centerZ: iz * 30 + 15 });
}
const baseline = plantPlacementRecords(bigChunks, params, heightAt);
const explicitZero = plantPlacementRecords(bigChunks, { ...params, clusterStrength: 0 }, heightAt);
ok(JSON.stringify(baseline) === JSON.stringify(explicitZero), '5: clusterStrength 0 matches omitted-param baseline exactly');

const clustered = plantPlacementRecords(bigChunks, { ...params, clusterStrength: 1, clusterScale: 40 }, heightAt);
ok(clustered.length < baseline.length, '6: full clustering (strength 1) rejects some candidates the baseline kept');
ok(clustered.length > 0, '6: full clustering still places some plants');
ok(
  JSON.stringify(clustered) === JSON.stringify(plantPlacementRecords(bigChunks, { ...params, clusterStrength: 1, clusterScale: 40 }, heightAt)),
  '6: clustering is deterministic for the same seed/params',
);

// authored density mask: zero mask rejects every otherwise-valid candidate
const maskedOut = plantPlacementRecords(chunks, { ...params, densityAt: () => 0 }, heightAt);
ok(maskedOut.length === 0, '7: densityAt zero mask rejects all candidates');
const maskedFull = plantPlacementRecords(chunks, { ...params, densityAt: () => 1 }, heightAt);
ok(maskedFull.length === a.length, '7: densityAt full mask preserves candidate count');

// authored surface mode: sample real upward mesh triangles and preserve their y coordinate
const quadPositions = new Float32Array([
  0, 1, 0,  0, 1, 30,  30, 1, 0,
  30, 1, 0,  0, 1, 30,  30, 1, 30,
]);
const surfaceIndex = buildChunkIndex(quadPositions, { chunkSize: 30, minNormalY: 0.5 });
const surfaceRecs = plantPlacementRecords(chunks, {
  ...params,
  surfaceIndex,
  surfacePositions: quadPositions,
  surfaceSeed: 99,
}, () => -100);
ok(surfaceRecs.length > 0, '8: surface mode samples authored mesh anchors');
ok(surfaceRecs.every(r => r.y === 1), '8: surface mode preserves authored surface y');
ok(surfaceRecs.every(r => r.x >= 0 && r.x <= 30 && r.z >= 0 && r.z <= 30), '8: surface anchors stay inside chunk bounds');
const surfaceWet = plantPlacementRecords(chunks, {
  ...params,
  waterLevel: 2,
  surfaceIndex,
  surfacePositions: quadPositions,
  surfaceSeed: 99,
}, () => -100);
ok(surfaceWet.length === 0, '8: surface mode still rejects submerged authored surfaces');
const surfaceCaveDry = plantPlacementRecords(chunks, {
  ...params,
  waterLevel: 2,
  waterEnvelopeAt: () => 3,
  surfaceIndex,
  surfacePositions: quadPositions,
  surfaceSeed: 99,
}, () => -100);
ok(surfaceCaveDry.length === surfaceRecs.length, '8: water envelope can keep below-water anchored cave surfaces dry');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
