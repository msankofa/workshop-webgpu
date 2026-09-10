// test-flora-field.mjs — plants plan F3: cover reconciled against the ground texture.
// node test-flora-field.mjs

import { coverAt, createTileCover, quantizeCover, decodeCover, BIOME_GRASS, COVER_CHANNELS, FLORA_COVER_DEFAULTS } from './flora-field.js';
import { splatWeights, STREAMED_SPLAT_DEFAULTS } from './terrain-splat-streamed.js';
import { BIOMES, BIOME_INDEX, treeDensityForBiome } from './terrain-biome-point.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

// A flat, mid-altitude point the splat material paints as grass.
const flatGrass = splatWeights(24, 1, STREAMED_SPLAT_DEFAULTS);
const steepRock = splatWeights(24, 0.2, STREAMED_SPLAT_DEFAULTS);
const highSnow = splatWeights(300, 1, STREAMED_SPLAT_DEFAULTS);
const shoreSand = splatWeights(0.6, 1, STREAMED_SPLAT_DEFAULTS);

section('the ground vetoes the biome');
{
  const onGrass = coverAt('forest', 0.8, flatGrass, { height: 24, normalY: 1 });
  check('a forest on grass-painted ground grows trees', onGrass.tree > 0.3, `tree ${onGrass.tree.toFixed(3)}`);
  const onRock = coverAt('forest', 0.8, steepRock, { height: 24, normalY: 0.2 });
  check('the same forest on a rock face grows nothing', onRock.tree === 0 && onRock.grass === 0 && onRock.plant === 0,
    `tree ${onRock.tree}, grass ${onRock.grass}`);
  const onSnow = coverAt('plains', 0.8, highSnow, { height: 300, normalY: 1 });
  check('snow cover suppresses grass', onSnow.grass < 0.1, `grass ${onSnow.grass.toFixed(3)}`);
  check('sand at the shore is nearly bare', coverAt('plains', 1, shoreSand, { height: 0.6, normalY: 1 }).grass < 0.2);
}

section('water and slope');
{
  const drowned = coverAt('swamp', 1, flatGrass, { height: -2, seaLevel: 0, normalY: 1 });
  check('below the waterline nothing roots', drowned.grass === 0 && drowned.plant === 0 && drowned.tree === 0);
  const atSea = coverAt('plains', 1, flatGrass, { height: 0.1, seaLevel: 0, normalY: 1 });
  check('the water margin holds just above sea level', atSea.grass === 0);
  const above = coverAt('plains', 1, flatGrass, { height: 3, seaLevel: 0, normalY: 1 });
  check('and releases above it', above.grass > 0.5, `grass ${above.grass.toFixed(3)}`);

  // Trees give up on a slope before grass does.
  let treeGone = null, grassGone = null;
  for (let normalY = 1; normalY >= 0.3; normalY -= 0.01) {
    const c = coverAt('forest', 0.9, splatWeights(24, normalY, STREAMED_SPLAT_DEFAULTS), { height: 24, normalY });
    if (treeGone === null && c.tree === 0) treeGone = normalY;
    if (grassGone === null && c.grass === 0) grassGone = normalY;
  }
  check('trees stop on a gentler slope than grass', treeGone > grassGone, `tree ${treeGone?.toFixed(2)} grass ${grassGone?.toFixed(2)}`);
}

section('biome and moisture');
{
  const wet = coverAt('plains', 1, flatGrass, { height: 24, normalY: 1 });
  const dry = coverAt('plains', 0, flatGrass, { height: 24, normalY: 1 });
  check('dry ground thins grass', dry.grass < wet.grass, `${dry.grass.toFixed(3)} vs ${wet.grass.toFixed(3)}`);
  check('and thins understory more', (dry.plant / Math.max(wet.plant, 1e-9)) < (dry.grass / Math.max(wet.grass, 1e-9)));

  const desert = coverAt('desert', 0.1, flatGrass, { height: 24, normalY: 1 });
  const meadow = coverAt('meadow', 0.9, flatGrass, { height: 24, normalY: 1 });
  check('a meadow beats a desert for grass', meadow.grass > desert.grass * 5, `${meadow.grass.toFixed(3)} vs ${desert.grass.toFixed(3)}`);
  check('the ocean grows nothing anywhere', coverAt('ocean', 1, flatGrass, { height: 24, normalY: 1 }).grass === 0);
  check('tree cover never exceeds the biome table', coverAt('dark_forest', 1, flatGrass, { height: 24, normalY: 1 }).tree <= treeDensityForBiome('dark_forest') + 1e-9);
  check('an unknown biome grows nothing', coverAt('atlantis', 1, flatGrass, { height: 24, normalY: 1 }).grass === 0);
  check('a null biome is handled, not thrown', coverAt(null, 1, flatGrass, {}).grass === 0);
}

section('quantization is the same number on both sides');
{
  for (const v of [0, 0.004, 0.25, 0.5, 0.999, 1]) {
    const round = decodeCover(quantizeCover(v));
    if (Math.abs(round - v) > 1 / 255) { check(`round trip ${v}`, false, `got ${round}`); break; }
  }
  check('a cover value survives the u8 round trip within one step', Math.abs(decodeCover(quantizeCover(0.63)) - 0.63) <= 1 / 255);
  check('quantize clamps out of range', quantizeCover(-3) === 0 && quantizeCover(9) === 255);
  check('the GPU decode matches the CPU decode', decodeCover(quantizeCover(0.42)) === quantizeCover(0.42) / 255);
}

section('tile derive');
{
  const texels = 9, step = 8;
  const heights = new Float32Array(texels * texels);
  const biomeIds = new Uint8Array(texels * texels).fill(BIOME_INDEX.forest);
  const moisture = new Float32Array(texels * texels).fill(0.8);
  for (let iz = 0; iz < texels; iz++) for (let ix = 0; ix < texels; ix++) heights[iz * texels + ix] = 30 + ix * 0.5;
  const cover = createTileCover({ seaLevel: 0, biomeNames: BIOMES });

  const tile = cover.derive({ heights, biomeIds, moisture, texels, step });
  check('derive attaches every channel', COVER_CHANNELS.every(c => tile[c] instanceof Uint8Array && tile[c].length === texels * texels));
  check('a forest tile has tree cover', tile.coverTree[40] > 0, `got ${tile.coverTree[40]}`);
  check('and grass under it', tile.coverGrass[40] > 0);

  // Deterministic: the same tile derives the same numbers.
  const again = cover.derive({ heights, biomeIds, moisture, texels, step });
  check('derive is deterministic', COVER_CHANNELS.every(c => again[c].every((v, i) => v === tile[c][i])));

  // surfaceHeights wins over heights: a carved tile is classified where the ground actually is.
  const carved = new Float32Array(texels * texels).fill(-30);
  const drowned = cover.derive({ heights, surfaceHeights: carved, biomeIds, moisture, texels, step });
  check('the visible surface decides, not the base height', drowned.coverTree.every(v => v === 0) && drowned.coverGrass.every(v => v === 0));

  // A tile with no biome ids cannot be covered; it must not invent any.
  const bare = cover.derive({ heights, biomeIds: null, moisture, texels, step });
  check('a tile without biomes gets no cover channels', bare.coverGrass === undefined);

  // Sea level moves the waterline the whole tile is judged against.
  cover.setSeaLevel(100);
  const raised = cover.derive({ heights, biomeIds, moisture, texels, step });
  check('raising sea level drowns the tile', raised.coverGrass.every(v => v === 0));
  cover.setSeaLevel(0);

  const cleared = createTileCover({ seaLevel: 0, biomeNames: BIOMES,
    clearance: (x) => x < 32 ? 0 : 1 });
  const clearedTile = cleared.derive({ heights, biomeIds, moisture, texels, step, originX: 0, originZ: 0 });
  check('trail clearance multiplies all three cover channels',
    clearedTile.coverGrass[2] === 0 && clearedTile.coverPlant[2] === 0 && clearedTile.coverTree[2] === 0
      && clearedTile.coverGrass[6] > 0);
}

section('defaults are sane');
{
  check('every biome has a grass affinity', BIOMES.every(b => typeof BIOME_GRASS[b] === 'number'));
  check('affinities are 0..1', BIOMES.every(b => BIOME_GRASS[b] >= 0 && BIOME_GRASS[b] <= 1));
  check('rock is a hard veto for all three layers',
    FLORA_COVER_DEFAULTS.grassGround.rock === 0 && FLORA_COVER_DEFAULTS.plantGround.rock === 0 && FLORA_COVER_DEFAULTS.treeGround.rock === 0);
}

section('derive pauses at a deadline');
{
  const texels = 9, step = 8;
  const heights = new Float32Array(texels * texels);
  const biomeIds = new Uint8Array(texels * texels).fill(BIOME_INDEX.forest);
  const moisture = new Float32Array(texels * texels).fill(0.8);
  for (let iz = 0; iz < texels; iz++) for (let ix = 0; ix < texels; ix++) heights[iz * texels + ix] = 30 + ix * 0.5;
  let queries = 0;
  const cover = createTileCover({ seaLevel: 0, biomeNames: BIOMES, clearance: (x, z) => { queries++; return x > 20 ? 1 : 0.5; } });
  const whole = cover.derive({ heights, biomeIds, moisture, texels, step });
  const paused = { heights, biomeIds, moisture, texels, step };
  let pauses = 0;
  while (cover.derive(paused, -Infinity) === false) { pauses++; check(`no channel is attached while paused (${pauses})`, paused.coverGrass === undefined); if (pauses > 20) break; }
  check('a past deadline pauses once per row', pauses === texels - 1, `${pauses} pauses`);
  check('the paused tile carries every channel at the end', COVER_CHANNELS.every(c => paused[c] instanceof Uint8Array));
  check('and the same numbers as the one-shot derive', COVER_CHANNELS.every(c => paused[c].every((v, i) => v === whole[c][i])));
  check('every texel asked for clearance exactly once per derive', queries === 2 * texels * texels, `${queries}`);
}

section('allocation pass: derive is byte-identical to the pre-scratch implementation');
{
  // The checksum below was computed from versions/flora-field-before-allocation-pass-20260909-223107.js
  // BEFORE derive started reusing scratch objects, over exactly the tile built here. If a future
  // change to the cover rule moves it, that is a deliberate change to what the channels contain and
  // this line has to be re-derived from the new rule, not just updated to whatever the code prints.
  const EXPECTED = 2676199228;
  const texels = 64, step = 8, n = texels * texels;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const heights = new Float32Array(n), moisture = new Float32Array(n), biomeIds = new Uint8Array(n);
  for (let i = 0; i < n; i++) { heights[i] = -20 + rnd() * 320; moisture[i] = rnd(); biomeIds[i] = Math.floor(rnd() * BIOMES.length); }
  const cover = createTileCover({ seaLevel: 3, biomeNames: BIOMES, clearance: (x, z) => ((x + z) % 97 < 20 ? 0.25 : 1) });
  const tile = cover.derive({ heights, biomeIds, moisture, texels, step, originX: -128, originZ: 64 });
  let h = 2166136261 >>> 0;
  for (const c of COVER_CHANNELS) for (let i = 0; i < n; i++) { h ^= tile[c][i]; h = Math.imul(h, 16777619) >>> 0; }
  check('the three cover channels hash to the pre-change value', h === EXPECTED, `got ${h}, want ${EXPECTED}`);

  // The scratch path and the allocating path must be the same rule, not two.
  let same = true;
  const out = { grass: 0, plant: 0, tree: 0 }, w = [0, 0, 0, 0, 0];
  for (let i = 0; i < 400; i++) {
    const height = -30 + rnd() * 340, normalY = rnd(), wet = rnd(), biome = BIOMES[Math.floor(rnd() * BIOMES.length)];
    const fresh = coverAt(biome, wet, splatWeights(height, normalY, STREAMED_SPLAT_DEFAULTS), { height, seaLevel: 2, normalY });
    const reused = coverAt(biome, wet, splatWeights(height, normalY, STREAMED_SPLAT_DEFAULTS, w), { height, seaLevel: 2, normalY, out });
    if (reused !== out || fresh.grass !== reused.grass || fresh.plant !== reused.plant || fresh.tree !== reused.tree) same = false;
  }
  check('coverAt and splatWeights give the same numbers with an out parameter as without', same);
  check('splatWeights still allocates a fresh array when no out is given',
    splatWeights(24, 1, STREAMED_SPLAT_DEFAULTS) !== splatWeights(24, 1, STREAMED_SPLAT_DEFAULTS));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
