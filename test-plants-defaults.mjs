// test-plants-defaults.mjs
import { PLANT_DEFAULTS, PLANT_PRESETS, PLANT_BIOME_TAGS, createPlantPalette } from './plants.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL ') + m); if (!c) fail++; };

ok(PLANT_DEFAULTS.leaf.style === 'simple', 'default leaf style is simple');
ok(PLANT_DEFAULTS.leaf.arrangement === 'opposite', 'default arrangement is opposite');
ok(PLANT_DEFAULTS.leaf.serration.teeth === 0, 'default serration is smooth (0 teeth)');
ok(PLANT_DEFAULTS.leaf.variegation.enabled === false, 'variegation off by default');

const keys = Object.keys(PLANT_PRESETS);
ok(keys.length === 4, 'exactly 4 launch presets');
ok(keys.includes('chickweed') && keys.includes('cleavers') && keys.includes('mint') && keys.includes('jewelweed'), 'the 4 named species');

ok(PLANT_PRESETS.cleavers.leaf.style === 'complex', 'cleavers uses a compound leaf');
ok(PLANT_PRESETS.cleavers.leaf.arrangement === 'whorl', 'cleavers leaflets are whorled');
ok(PLANT_PRESETS.cleavers.leaf.leafletCount >= 7, 'cleavers has 7+ leaflets per whorl');
ok(PLANT_PRESETS.mint.leaf.serration.teeth > 0 && PLANT_PRESETS.mint.leaf.serration.depth > 0, 'mint leaves are serrated');
ok(PLANT_PRESETS.jewelweed.leaf.arrangement === 'alternate', 'jewelweed leaves are alternate');
ok(PLANT_PRESETS.chickweed.flower.shape === 'star', 'chickweed has a star flower');
ok(PLANT_PRESETS.jewelweed.flower.shape === 'pouch', 'jewelweed has a pouch flower');

ok(PLANT_BIOME_TAGS.cleavers.biomes.length === 0, 'cleavers is a biome generalist (empty allowlist = matches anywhere)');
ok(PLANT_BIOME_TAGS.jewelweed.biomes.includes('swamp'), 'jewelweed prefers damp biomes');

const palette = createPlantPalette({ variantsPerSpecies: 3, masterSeed: 123 });
ok(palette.variants.length === 4 * 3, 'palette has speciesCount * variantsPerSpecies geometries');
ok(palette.speciesCount === 4, 'palette knows its species count');
ok(palette.speciesTags.length === 4, 'palette carries one biome/density tag per species');
ok(palette.speciesTags[0].key === 'chickweed', 'species order matches PLANT_PRESETS key order');
ok(palette.variants.every(g => g.getAttribute('position').count > 0), 'every baked variant has geometry');

// different seeds per variant -> not all identical
const p0 = Array.from(palette.variants[0].getAttribute('position').array);
const p1 = Array.from(palette.variants[1].getAttribute('position').array);
ok(JSON.stringify(p0) !== JSON.stringify(p1), 'variants of the same species differ (different seeds)');

console.log(fail ? fail + ' FAIL' : 'ALL PASS'); process.exit(fail ? 1 : 0);
