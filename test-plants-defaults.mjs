// test-plants-defaults.mjs
import { PLANT_DEFAULTS, PLANT_PRESETS, PLANT_BIOME_TAGS, createPlantPalette } from './plants.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL ') + m); if (!c) fail++; };

ok(PLANT_DEFAULTS.leaf.style === 'simple', 'default leaf style is simple');
ok(PLANT_DEFAULTS.leaf.arrangement === 'opposite', 'default arrangement is opposite');
ok(PLANT_DEFAULTS.leaf.serration.teeth === 0, 'default serration is smooth (0 teeth)');
ok(PLANT_DEFAULTS.leaf.variegation.enabled === false, 'variegation off by default');
ok(PLANT_DEFAULTS.leaf.blossom === null, 'blossom off by default');

const SPECIES_COUNT = 6; // 4 herbs (launch) + 2 shrub starters (Phase 1 understory overhaul)
const keys = Object.keys(PLANT_PRESETS);
ok(keys.length === SPECIES_COUNT, `exactly ${SPECIES_COUNT} launch presets (4 herbs + 2 shrub starters)`);
ok(keys.includes('chickweed') && keys.includes('cleavers') && keys.includes('mint') && keys.includes('jewelweed'), 'the 4 named herb species');
ok(keys.includes('juniperMound') && keys.includes('pinkflowerBush'), 'the 2 named shrub species');

ok(PLANT_PRESETS.cleavers.leaf.style === 'complex', 'cleavers uses a compound leaf');
ok(PLANT_PRESETS.cleavers.leaf.arrangement === 'whorl', 'cleavers leaflets are whorled');
ok(PLANT_PRESETS.cleavers.leaf.leafletCount >= 7, 'cleavers has 7+ leaflets per whorl');
ok(PLANT_PRESETS.mint.leaf.serration.teeth > 0 && PLANT_PRESETS.mint.leaf.serration.depth > 0, 'mint leaves are serrated');
ok(PLANT_PRESETS.jewelweed.leaf.arrangement === 'alternate', 'jewelweed leaves are alternate');
ok(PLANT_PRESETS.chickweed.flower.shape === 'star', 'chickweed has a star flower');
ok(PLANT_PRESETS.jewelweed.flower.shape === 'pouch', 'jewelweed has a pouch flower');

// shrub presets: sprigClump geometry style (SeedThree scrub.js-derived), ground-lit crossed
// quads rather than the herb leaf pipeline; pinkflowerBush also carries a blossom tint.
ok(PLANT_PRESETS.juniperMound.leaf.style === 'sprigClump', 'juniperMound uses the sprigClump shrub geometry style');
ok(PLANT_PRESETS.pinkflowerBush.leaf.style === 'sprigClump', 'pinkflowerBush uses the sprigClump shrub geometry style');
ok(PLANT_PRESETS.pinkflowerBush.leaf.blossom && PLANT_PRESETS.pinkflowerBush.leaf.blossom.frac > 0, 'pinkflowerBush carries a blossom tint fraction');
ok(!PLANT_PRESETS.juniperMound.leaf.blossom, 'juniperMound has no blossom (not a flowering shrub)');

ok(PLANT_BIOME_TAGS.cleavers.biomes.length === 0, 'cleavers is a biome generalist (empty allowlist = matches anywhere)');
ok(PLANT_BIOME_TAGS.jewelweed.biomes.includes('swamp'), 'jewelweed prefers damp biomes');
ok(Object.values(PLANT_BIOME_TAGS).every(t => typeof t.hueVar === 'number' && t.hueVar > 0), 'every species carries a positive hueVar (per-instance variation knob)');

const palette = createPlantPalette({ variantsPerSpecies: 3, masterSeed: 123 });
ok(palette.variants.length === SPECIES_COUNT * 3, 'palette has speciesCount * variantsPerSpecies geometries');
ok(palette.speciesCount === SPECIES_COUNT, 'palette knows its species count');
ok(palette.speciesTags.length === SPECIES_COUNT, 'palette carries one biome/density tag per species');
ok(palette.speciesTags[0].key === 'chickweed', 'species order matches PLANT_PRESETS key order');
ok(palette.variants.every(g => g.getAttribute('position').count > 0), 'every baked variant has geometry');

// different seeds per variant -> not all identical
const p0 = Array.from(palette.variants[0].getAttribute('position').array);
const p1 = Array.from(palette.variants[1].getAttribute('position').array);
ok(JSON.stringify(p0) !== JSON.stringify(p1), 'variants of the same species differ (different seeds)');

// shrub variants (sprigClump) bake forced ground-plane (0,1,0) normals on the clump geometry
// (the stem ribbon underneath keeps its own computed normals -- only check the LAST node's
// clump, which is exactly the trailing sprigQuads*6 vertices since attachLeavesAtNode appends
// one clump per node, in node order, after buildStemQuads writes the stem first).
const shrubIdx = keys.indexOf('juniperMound');
const shrubVariant = palette.variants[shrubIdx * 3];
const normAttr = shrubVariant.getAttribute('normal');
const clumpVertCount = PLANT_PRESETS.juniperMound.leaf.sprigQuads * 6;
let allUp = true;
const EPS = 1e-5;
for (let i = normAttr.count - clumpVertCount; i < normAttr.count; i++) {
  if (Math.abs(normAttr.getX(i)) > EPS || Math.abs(normAttr.getY(i) - 1) > EPS || Math.abs(normAttr.getZ(i)) > EPS) { allUp = false; break; }
}
ok(allUp, 'sprigClump geometry bakes forced ground-plane (0,1,0) normals on clump vertices');

console.log(fail ? fail + ' FAIL' : 'ALL PASS'); process.exit(fail ? 1 : 0);
