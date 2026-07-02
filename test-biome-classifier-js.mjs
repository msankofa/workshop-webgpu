import {
  BIOMES, BIOME_INDEX, BIOME_COLORS, DEFAULT_CONFIG, classifyBiomeCell, createFieldSampler, generateGrid,
  interp1d, rescaleArray, peaksAndValleys, smoothstep, clamp01,
  CONTINENT_X, CONTINENT_Y, EROSION_X, EROSION_Y,
} from './biome-classifier-js.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

ok(BIOMES.length === 18, '1: 18 biome names');
ok(BIOMES[0] === 'deep_ocean' && BIOMES[6] === 'plains' && BIOMES[17] === 'meadow', '1: name order matches terrain-loader.js/biome_classifier.py');
ok(BIOME_INDEX.plains === 6 && BIOME_INDEX.meadow === 17, '1: BIOME_INDEX matches array position');
ok(Object.keys(BIOME_INDEX).length === 18, '1: BIOME_INDEX has one entry per biome');
ok(JSON.stringify(BIOME_COLORS.deep_ocean) === JSON.stringify([13, 25, 76]), '1: BIOME_COLORS.deep_ocean matches biome_classifier.py');
ok(JSON.stringify(BIOME_COLORS.meadow) === JSON.stringify([140, 199, 102]), '1: BIOME_COLORS.meadow matches biome_classifier.py');
ok(Object.keys(BIOME_COLORS).length === 18, '1: BIOME_COLORS has one entry per biome');
ok(DEFAULT_CONFIG.sea_level === 0.0, '1: DEFAULT_CONFIG.sea_level matches config.py Terrain2DConfig default');
ok(DEFAULT_CONFIG.continentalness_period === 1180.0, '1: DEFAULT_CONFIG.continentalness_period matches config.py');
ok(DEFAULT_CONFIG.forest_humidity_bias === 0.1, '1: DEFAULT_CONFIG.forest_humidity_bias matches config.py');
ok(DEFAULT_CONFIG.snow_height_start === 74.0 && DEFAULT_CONFIG.snow_height_full === 112.0, '1: DEFAULT_CONFIG snow heights match config.py');

// classifyBiomeCell({ height, slope, temp, humid, weird, beachMask, seaLevel, cfg })
// -> { biome, ruleIndex }. cfg is DEFAULT_CONFIG unless noted. seaLevel = 0 throughout
// (DEFAULT_CONFIG.sea_level). Each fixture's expected biome/ruleIndex was derived by
// hand-tracing biome_classifier.py's classify_biomes() rule order for that input.
const cfg = DEFAULT_CONFIG;
const base = { height: 10, slope: 0, temp: 0, humid: 0, weird: 0, beachMask: 0, seaLevel: 0, cfg };

function classifyOk(overrides, expectedBiome, expectedRuleIndex, label) {
  const result = classifyBiomeCell({ ...base, ...overrides });
  ok(result.biome === expectedBiome, `2: ${label} -> biome (got ${result.biome})`);
  ok(result.ruleIndex === expectedRuleIndex, `2: ${label} -> ruleIndex (got ${result.ruleIndex})`);
}

classifyOk({}, 'plains', -1, 'default_plains (no rule matches)');
classifyOk({ height: -20 }, 'deep_ocean', 0, 'deep_ocean (height < sea-14)');
classifyOk({ height: -5 }, 'ocean', 1, 'ocean (sea-14 <= height <= sea)');
classifyOk({ height: -5, beachMask: 0.5 }, 'beach', 2, 'beach overrides ocean');
classifyOk({ temp: 0.5, humid: -0.5 }, 'desert', 3, 'desert (hot & dry)');
classifyOk({ temp: 0.5, humid: -0.5, weird: 0.5 }, 'badlands', 4, 'badlands overrides desert (weird > 0.38)');
classifyOk({ temp: 0.5, humid: 0 }, 'savanna', 5, 'savanna (hot, not dry, not very wet)');
classifyOk({ temp: 0.5, humid: 0.6 }, 'jungle', 6, 'jungle (hot & very wet)');
classifyOk({ temp: 0, humid: 0.6 }, 'dark_forest', 9, 'swamp_condition_shadowed: very-wet & not-hot & not-cold lands on dark_forest (rule 9), not swamp (rule 7) -- see "Before you start" note 2');
classifyOk({ temp: 0, humid: 0.2 }, 'forest', 8, 'forest (wet, not cold, not very wet, humid <= 0.25 so dark_forest does not also fire)');
classifyOk({ temp: 0, humid: 0.3 }, 'dark_forest', 9, 'dark_forest overrides forest (humid > 0.25)');
classifyOk({ temp: -0.5, humid: 0.2 }, 'taiga', 10, 'taiga (cold & wet, not high)');
classifyOk({ temp: -0.5, humid: 0.2, height: 80 }, 'snowy_taiga', 11, 'snowy_taiga overrides taiga (also high)');
classifyOk({ temp: -0.5, humid: -0.5 }, 'snowy_plains', 12, 'snowy_plains (cold, not wet)');
classifyOk({ humid: 0, weird: 0.5 }, 'meadow', 13, 'meadow (not hot, not cold, humid > -0.05, weird > 0.28)');
classifyOk({ humid: 0, weird: 0.5, slope: 0.5 }, 'windswept_hills', 14, 'windswept_hills overrides meadow (steep)');
classifyOk({ humid: 0, weird: 0.5, slope: 0.5, height: 80 }, 'stony_peaks', 15, 'stony_peaks overrides windswept_hills (also high)');
classifyOk({ humid: 0, weird: 0.5, slope: 0.5, height: 150 }, 'snowy_peaks', 16, 'snowy_peaks overrides stony_peaks (height > snow_height_full, slope < 0.80)');

const sampler = createFieldSampler(1337);
const v1 = sampler.sample('temperature', 100, 200, 1550, 3);
const v2 = sampler.sample('temperature', 100, 200, 1550, 3);
ok(v1 === v2, '3: sample() is deterministic for identical inputs');
ok(v1 >= -1 && v1 <= 1, '3: sample() stays within [-1, 1]');

const differentCoord = sampler.sample('temperature', 900, 400, 1550, 3);
ok(differentCoord !== v1, '3: sample() varies across coordinates');

const differentChannel = sampler.sample('humidity', 100, 200, 1300, 3);
ok(differentChannel !== v1, '3: different channels are independent (not the same noise field)');

const samplerB = createFieldSampler(9999);
const v1b = samplerB.sample('temperature', 100, 200, 1550, 3);
ok(v1b !== v1, '3: different seeds produce different fields');

const samplerA2 = createFieldSampler(1337);
const v1a2 = samplerA2.sample('temperature', 100, 200, 1550, 3);
ok(v1a2 === v1, '3: same seed reproduces the same field across sampler instances');

const RES = 16; // small grid for fast test iteration; production uses GRID_RESOLUTION (128)
const gridA = generateGrid(DEFAULT_CONFIG, RES);
ok(gridA.height.length === RES * RES, '4: height array is resolution^2');
ok(gridA.slope.length === RES * RES, '4: slope array is resolution^2');
ok(gridA.biomeId.length === RES * RES, '4: biomeId array is resolution^2');
ok(gridA.ruleIndex.length === RES * RES, '4: ruleIndex array is resolution^2');

let allBiomeIdsValid = true, allRuleIndicesValid = true;
for (let i = 0; i < gridA.biomeId.length; i++) {
  if (gridA.biomeId[i] < 0 || gridA.biomeId[i] > 17) allBiomeIdsValid = false;
  if (gridA.ruleIndex[i] < -1 || gridA.ruleIndex[i] > 16) allRuleIndicesValid = false;
}
ok(allBiomeIdsValid, '4: every biomeId is a valid BIOMES index (0-17)');
ok(allRuleIndicesValid, '4: every ruleIndex is in [-1, 16]');

const gridA2 = generateGrid(DEFAULT_CONFIG, RES);
ok(gridA2.height.every((v, i) => v === gridA.height[i]), '4: generateGrid is deterministic for identical cfg/resolution');
ok(gridA2.biomeId.every((v, i) => v === gridA.biomeId[i]), '4: biomeId output is deterministic');

const gridB = generateGrid({ ...DEFAULT_CONFIG, seed: 42 }, RES);
ok(!gridB.height.every((v, i) => v === gridA.height[i]), '4: changing seed changes the generated height field');

const gridSeaHigh = generateGrid({ ...DEFAULT_CONFIG, sea_level: 200 }, RES);
const allOceanOrDeepOcean = Array.from(gridSeaHigh.biomeId).every((id) => id === BIOME_INDEX.deep_ocean || id === BIOME_INDEX.ocean || id === BIOME_INDEX.beach);
ok(allOceanOrDeepOcean, '4: an absurdly high sea_level floods every cell to deep_ocean/ocean/beach');

// --- widened export surface (additive, for terrain-generator-js.js reuse) ---
ok(typeof interp1d === 'function', '5: interp1d is exported');
ok(typeof rescaleArray === 'function', '5: rescaleArray is exported');
ok(typeof peaksAndValleys === 'function', '5: peaksAndValleys is exported');
ok(typeof smoothstep === 'function', '5: smoothstep is exported');
ok(typeof clamp01 === 'function', '5: clamp01 is exported');
ok(Array.isArray(CONTINENT_X) && CONTINENT_X.length === 7, '5: CONTINENT_X is exported (7 knots)');
ok(Array.isArray(CONTINENT_Y) && CONTINENT_Y.length === 7, '5: CONTINENT_Y is exported (7 knots)');
ok(Array.isArray(EROSION_X) && EROSION_X.length === 5, '5: EROSION_X is exported (5 knots)');
ok(Array.isArray(EROSION_Y) && EROSION_Y.length === 5, '5: EROSION_Y is exported (5 knots)');
ok(Math.abs(interp1d(0.0, CONTINENT_X, CONTINENT_Y) - 4.0) < 1e-9, '5: interp1d(0, CONTINENT_X, CONTINENT_Y) lands exactly on the x=0 knot (4.0)');
ok(Math.abs(peaksAndValleys(0.0) - (-1.0)) < 1e-9, '5: peaksAndValleys(0) is -1');
ok(Math.abs(peaksAndValleys(2 / 3) - 1.0) < 1e-9, '5: peaksAndValleys(2/3) is 1 (the ridge)');
ok(Math.abs(smoothstep(0, 1, 0.5) - 0.5) < 1e-9, '5: smoothstep midpoint is 0.5');
ok(clamp01(1.5) === 1 && clamp01(-0.5) === 0, '5: clamp01 clamps to [0,1]');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
