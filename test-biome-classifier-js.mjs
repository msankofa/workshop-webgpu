import { BIOMES, BIOME_INDEX, BIOME_COLORS, DEFAULT_CONFIG } from './biome-classifier-js.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
