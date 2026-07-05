// test-rocks-placement.mjs
import { rockPlacementRecords, boulderCirclesFromRecords, rocknessOf } from './rocks-placement.js';

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

const chunks = [{ key: '0,0', xMin: 0, zMin: 0, size: 60, centerX: 30, centerZ: 30 }];
const table = [
  { key: 'boulderA', density: 1, sizeRange: [0.3, 2.2] },
  { key: 'scree', scree: true, density: 1, sizeRange: [0.05, 0.28] },
];
const flatHeightAt = () => 0;
const flatSurfaceField = () => ({ moisture: 0.5, upness: 0.9, materialWeights: { indices: [0], weights: [1], layers: ['grass'] } });

const params = { masterSeed: 20260705, waterLevel: -1, boulderDensity: 0.02, screeDensity: 0.2, rockTypeTable: table };

// ---- 1: determinism ----
const a = rockPlacementRecords(chunks, params, flatHeightAt, flatSurfaceField);
const b = rockPlacementRecords(chunks, params, flatHeightAt, flatSurfaceField);
ok(a.length > 0, '1: places some rocks');
ok(JSON.stringify(a) === JSON.stringify(b), '1: deterministic for the same seed/params');

// ---- 2: record shape ----
ok(a.every(r => typeof r.x === 'number' && typeof r.z === 'number' && typeof r.y === 'number'), '2: records have x/y/z');
ok(a.every(r => typeof r.scale === 'number' && r.scale > 0), '2: records have positive scale');
ok(a.every(r => typeof r.yaw === 'number' && typeof r.tiltX === 'number' && typeof r.tiltZ === 'number'), '2: records have yaw/tiltX/tiltZ');
ok(a.every(r => typeof r.moisture === 'number' && r.moisture >= 0 && r.moisture <= 1), '2: moisture sampled and bounded');
ok(a.every(r => 'variant' in r && typeof r.scree === 'boolean'), '2: records carry variant + scree flag');

// ---- 3: gating: on a flat, non-rocky, non-steep field (upness 0.9, no rock/gravel layer),
//     scree is heavily rejected relative to a rocky/steep field ----
const rockySurfaceField = () => ({ moisture: 0.5, upness: 0.1, materialWeights: { indices: [0], weights: [1], layers: ['rock'] } });
const flatOnly = rockPlacementRecords(chunks, { ...params, boulderDensity: 0 }, flatHeightAt, flatSurfaceField);
const rockyOnly = rockPlacementRecords(chunks, { ...params, boulderDensity: 0 }, flatHeightAt, rockySurfaceField);
ok(flatOnly.every(r => r.scree), '3: only scree records remain when boulderDensity=0');
ok(rockyOnly.length > flatOnly.length, '3: scree concentrates on steep/rocky ground vs. flat/non-rocky ground');
ok(flatOnly.length < params.screeDensity * 60 * 60 * 0.5, '3: flat non-rocky ground strongly suppresses scree acceptance');

// ---- 4: slope contributes to the gate even with a non-rock material ----
const steepGrassSurfaceField = () => ({ moisture: 0.5, upness: 0.05, materialWeights: { indices: [0], weights: [1], layers: ['grass'] } });
const steepGrassOnly = rockPlacementRecords(chunks, { ...params, boulderDensity: 0 }, flatHeightAt, steepGrassSurfaceField);
ok(steepGrassOnly.length > flatOnly.length, '4: steep slope alone (no rock layer) still raises scree acceptance vs. flat');

// ---- 5: boulders reject under water; scree also rejects under water ----
const underwaterHeightAt = () => -5;
const wet = rockPlacementRecords(chunks, params, underwaterHeightAt, flatSurfaceField);
ok(wet.length === 0, '5: nothing places when the whole chunk is submerged');

// ---- 6: seating uses the lowest of 5 footprint samples ----
// A cliff at x=30: height 0 for x<30, height -3 for x>=30. A boulder whose CENTER sits on the
// high (0) side but whose footprint reaches across the cliff should seat using the lower
// footprint sample, not just its own center height -- proving seating samples footprint
// offsets, not only the center point.
function cliffHeightAt(x) { return x < 30 ? 0 : -3; }
const seatingRecs = rockPlacementRecords(chunks, { ...params, screeDensity: 0, boulderDensity: 0.5 }, (x, z) => cliffHeightAt(x), flatSurfaceField);
// footprint = scale * 0.8 (default footprintScale); need x + footprint >= 30 while x < 30.
const straddling = seatingRecs.filter(r => r.x < 30 && r.x + r.scale * 0.8 >= 30);
ok(straddling.length > 0, '6: setup sanity: at least one boulder straddles the cliff footprint');
ok(straddling.every(r => r.y < -1), '6: a boulder whose footprint reaches the low side seats near the LOW height, not its own center height (0)');
const nonStraddling = seatingRecs.filter(r => r.x < 30 && r.x + r.scale * 0.8 < 30);
ok(nonStraddling.length > 0, '6: setup sanity: some boulders stay entirely on the high side');
ok(nonStraddling.every(r => r.y >= 0), '6: a boulder whose footprint stays on the high side seats at/above the high (0) height');

// scree sinks ~30% of its scale into the dirt on flat ground
const screeOnlyRecs = rockPlacementRecords(chunks, { ...params, boulderDensity: 0, screeDensity: 0.5 }, flatHeightAt, rockySurfaceField);
ok(screeOnlyRecs.length > 0, '6: setup sanity: scree placed on rocky ground');
ok(screeOnlyRecs.every(r => Math.abs(r.y - (0 - r.scale * 0.3)) < 1e-9), '6: scree sinks exactly scale*0.3 into flat ground');

// ---- 7: trunkQuery rejection (optional, not hard-wired by default) ----
const noTrunkQuery = rockPlacementRecords(chunks, { ...params, screeDensity: 0 }, flatHeightAt, flatSurfaceField);
const allOccupied = rockPlacementRecords(chunks, { ...params, screeDensity: 0 }, flatHeightAt, flatSurfaceField, { trunkQuery: () => true });
ok(noTrunkQuery.length > 0, '7: setup sanity: boulders place without a trunkQuery');
ok(allOccupied.length === 0, '7: an always-true trunkQuery rejects every boulder candidate');

// ---- 8: boulderCirclesFromRecords excludes scree ----
const mixed = rockPlacementRecords(chunks, params, flatHeightAt, rockySurfaceField);
const circles = boulderCirclesFromRecords(mixed);
ok(circles.length > 0 && circles.length === mixed.filter(r => !r.scree).length, '8: circle list matches non-scree record count');
ok(circles.every(c => typeof c.x === 'number' && typeof c.z === 'number' && c.r > 0), '8: circles have positive radius');

// ---- 9: rocknessOf helper ----
ok(rocknessOf({ indices: [0, 1], weights: [0.6, 0.4], layers: ['rock', 'grass'] }) === 0.6, '9: rocknessOf sums only rock/gravel layer weights');
ok(rocknessOf(null) === 0, '9: rocknessOf handles missing materialWeights');
ok(rocknessOf({ indices: [0], weights: [1], layers: ['sand'] }) === 0, '9: rocknessOf is 0 with no rock/gravel layer present');
// realistic surfaceField contract: indices are GLOBAL layer indices (rock=11, gravel=10),
// layers is the parallel per-slot name array -- rockness must key off slot i, not indices[i].
ok(rocknessOf({ indices: [11, 0], weights: [0.6, 0.4], layers: ['rock', 'grass'] }) === 0.6, '9: rocknessOf reads parallel layers[i] under real global indices');
ok(rocknessOf({ indices: [10, 3, 5], weights: [0.5, 0.3, 0.2], layers: ['gravel', 'grass', 'dirt'] }) === 0.5, '9: rocknessOf handles global gravel index');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
