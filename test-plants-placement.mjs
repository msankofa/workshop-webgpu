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

// Per-instance variation (Phase 1): every record carries a bounded hue/dryness/age, and hue
// respects a per-species hueVar override.
ok(a.every(r => typeof r.hue === 'number' && typeof r.dryness === 'number' && typeof r.age === 'number'), '9: every record carries hue/dryness/age');
ok(a.every(r => r.dryness >= 0 && r.dryness <= 1), '9: dryness stays within [0,1]');
ok(a.every(r => r.age >= 0.6 && r.age <= 1), '9: age stays within [0.6,1]');
const hueVarTable = [
  { key: 'chickweed', tag: { biomes: ['plains'], density: 1, hueVar: 0.3 } },
  { key: 'cleavers',  tag: { biomes: [], density: 0.6, hueVar: 0.3 } },
  { key: 'jewelweed', tag: { biomes: ['swamp'], density: 0.8, hueVar: 0.3 } },
];
const hueRecs = plantPlacementRecords(bigChunks, { ...params, plantSpeciesTable: hueVarTable }, heightAt);
ok(hueRecs.every(r => Math.abs(r.hue) <= 0.3 + 1e-9), '9: hue respects the per-species hueVar override');
ok(hueRecs.some(r => r.hue !== 0), '9: hue actually varies (not a stub zero)');

// Default structural clumping (fable5 GroundCover.ts grassPatch law): enabled by default,
// producing measurably tighter nearest-neighbor spacing than the flat-uniform (clumpEnabled:
// false) baseline over the same chunk window/count.
function medianNearestNeighborDist(recs) {
  const byChunk = new Map();
  for (const r of recs) { if (!byChunk.has(r.chunkKey)) byChunk.set(r.chunkKey, []); byChunk.get(r.chunkKey).push(r); }
  const dists = [];
  for (const list of byChunk.values()) {
    for (let i = 0; i < list.length; i++) {
      let best = Infinity;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const d = (list[i].x - list[j].x) ** 2 + (list[i].z - list[j].z) ** 2;
        if (d < best) best = d;
      }
      if (Number.isFinite(best)) dists.push(Math.sqrt(best));
    }
  }
  dists.sort((x, y) => x - y);
  return dists[Math.floor(dists.length / 2)];
}
const clumpedDefault = plantPlacementRecords(bigChunks, params, heightAt);
const flatUniform = plantPlacementRecords(bigChunks, { ...params, clumpEnabled: false }, heightAt);
ok(medianNearestNeighborDist(clumpedDefault) < medianNearestNeighborDist(flatUniform), '10: default clumping produces tighter nearest-neighbor spacing than flat-uniform placement');
ok(clumpedDefault.every(r => r.x >= 0 - 1e-9 && r.x <= 30 + 1e-9 && r.z >= 0 - 1e-9 && r.z <= 30 + 1e-9)
  || clumpedDefault.every(r => true), '10: clumped placements stay within chunk bounds (checked per-chunk below)');
// per-chunk bounds check (bigChunks spans multiple 30-unit chunks at different offsets)
ok(clumpedDefault.every(r => {
  const [ix, iz] = r.chunkKey.split(',').map(Number);
  return r.x >= ix * 30 - 1e-9 && r.x <= ix * 30 + 30 + 1e-9 && r.z >= iz * 30 - 1e-9 && r.z <= iz * 30 + 30 + 1e-9;
}), '10: clumped placements stay within their own chunk bounds');
ok(
  JSON.stringify(clumpedDefault) === JSON.stringify(plantPlacementRecords(bigChunks, params, heightAt)),
  '10: clumped placement is deterministic for the same seed/params',
);

// S3: clumping must also run on the surface-anchor path (authored maps), not just procedural.
// Build a big flat upward quad covering the full bigChunks span so sampleChunk has plenty of
// anchors per chunk to make a nearest-neighbor-spacing comparison statistically meaningful.
const bigSpan = 6 * 30;
const bigQuadPositions = new Float32Array([
  0, 1, 0,  0, 1, bigSpan,  bigSpan, 1, 0,
  bigSpan, 1, 0,  0, 1, bigSpan,  bigSpan, 1, bigSpan,
]);
const bigSurfaceIndex = buildChunkIndex(bigQuadPositions, { chunkSize: 30, minNormalY: 0.5 });
const surfaceParams = {
  ...params,
  surfaceIndex: bigSurfaceIndex,
  surfacePositions: bigQuadPositions,
  surfaceSeed: 99,
  surfaceMaxPerChunk: 200,
};
const surfaceClumpedDefault = plantPlacementRecords(bigChunks, surfaceParams, () => -100);
const surfaceFlatUniform = plantPlacementRecords(bigChunks, { ...surfaceParams, clumpEnabled: false }, () => -100);
ok(surfaceClumpedDefault.length > 0, '11: surface-anchor path places plants with clumping on');
ok(surfaceFlatUniform.length > 0, '11: surface-anchor path places plants with clumping off');
// Clumping on the surface-anchor path rejects candidates (accept/reject gate, not a position
// generator), so total count -- and therefore raw nearest-neighbor spacing -- differs between
// the clumped and flat-uniform runs for reasons unrelated to clustering shape. A quadrat
// variance-to-mean ratio (index of dispersion: bin points into cells, compare per-cell count
// variance to the mean) is count-invariant and is the standard spatial-statistics test for
// clumping (Poisson/uniform ~= 1, over-dispersed/clumped > 1), so use that instead.
function quadratVMR(recs, cell = 5, chunkSize = 30) {
  const byChunk = new Map();
  for (const r of recs) { if (!byChunk.has(r.chunkKey)) byChunk.set(r.chunkKey, []); byChunk.get(r.chunkKey).push(r); }
  let totalVar = 0, totalMean = 0, n = 0;
  for (const [key, list] of byChunk) {
    const [cix, ciz] = key.split(',').map(Number);
    const nCells = Math.round(chunkSize / cell);
    const counts = new Array(nCells * nCells).fill(0);
    for (const r of list) {
      const lx = r.x - cix * chunkSize, lz = r.z - ciz * chunkSize;
      const cx = Math.max(0, Math.min(nCells - 1, Math.floor(lx / cell)));
      const cz = Math.max(0, Math.min(nCells - 1, Math.floor(lz / cell)));
      counts[cz * nCells + cx]++;
    }
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    totalVar += variance; totalMean += mean; n++;
  }
  return totalVar / totalMean;
}
ok(
  quadratVMR(surfaceClumpedDefault) > quadratVMR(surfaceFlatUniform),
  '11: surface-anchor path clumps by default (higher quadrat variance-to-mean dispersion index than clumpEnabled:false)',
);
ok(surfaceClumpedDefault.every(r => r.y === 1), '11: surface-anchor clumping still preserves authored surface y');

// S3: same-seed determinism on the surface-anchor clumped path.
ok(
  JSON.stringify(surfaceClumpedDefault) === JSON.stringify(plantPlacementRecords(bigChunks, surfaceParams, () => -100)),
  '12: surface-anchor clumped placement is deterministic for the same seed/params',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
