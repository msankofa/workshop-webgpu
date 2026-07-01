import { BIOMES, BIOME_INDEX, BIOME_COLORS, DEFAULT_CONFIG, classifyBiomeCell } from './biome-classifier-js.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
