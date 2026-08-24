// test-terrain-biome-point.mjs — plants plan F1: biome and moisture on streamed tiles.
// node test-terrain-biome-point.mjs

import { createBiomePoint, slopeAt, localBeachMask, BIOMES, BIOME_INDEX } from './terrain-biome-point.js';
import { createUnboundedFieldSampler, DEFAULT_CONFIG } from './biome-classifier-js.js';
import { BIOME_MOISTURE } from './moisture-proxy.js';
import { normalizeTileRequest, validateTileResult, TILE_FIELDS } from './terrain-source.js';
import { createAnalyticSource, analyticDescriptor, ANALYTIC_BIOME } from './terrain-source-analytic.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(name) { console.log(`\n${name}`); }

const cfg = { ...DEFAULT_CONFIG, sea_level: 0 };
const sampler = createUnboundedFieldSampler(1337);
const biome = createBiomePoint(cfg, sampler, { seaLevel: 0 });

// A deterministic stand-in for a terrain source: a rolling surface with a hill and a shoreline.
function surfaceAt(x, z) {
  return 18 * Math.sin(x / 260) * Math.cos(z / 310) + 6 * Math.sin((x + z) / 90) + 4;
}
function buildTileHeights(originX, originZ, texels, step) {
  const out = new Float32Array(texels * texels);
  for (let iz = 0; iz < texels; iz++) {
    for (let ix = 0; ix < texels; ix++) out[iz * texels + ix] = surfaceAt(originX + ix * step, originZ + iz * step);
  }
  return out;
}

section('slope and beach mask');
{
  const texels = 5, step = 2;
  const flat = new Float32Array(texels * texels).fill(7);
  check('flat ground has zero slope', slopeAt(flat, texels, step, 2, 2) === 0);
  const ramp = new Float32Array(texels * texels);
  for (let iz = 0; iz < texels; iz++) for (let ix = 0; ix < texels; ix++) ramp[iz * texels + ix] = ix * step;  // 1:1 in x
  check('a 45 degree ramp reads slope 1', Math.abs(slopeAt(ramp, texels, step, 2, 2) - 1) < 1e-9,
    `got ${slopeAt(ramp, texels, step, 2, 2)}`);
  check('shore flat ground is fully beach', localBeachMask(0.5, 0, 0, 6) > 0.99);
  check('a cliff at the shore is not beach', localBeachMask(0.5, 1.2, 0, 6) < 1e-6);
  check('high flat ground is not beach', localBeachMask(40, 0, 0, 6) < 1e-6);
}

section('seam: one tile == four quarter tiles');
{
  // The window commits interior posts only; the apron ring is one-sided by design and is
  // replaced by the neighbour's interior. So the interior is what has to agree.
  const step = 4, apron = 1, intervals = 16;
  const originX = -128, originZ = 96;
  const texels = intervals + 1 + apron * 2;
  const whole = biome.classifyTile(buildTileHeights(originX, originZ, texels, step), texels, step, originX, originZ, 0);

  const half = intervals / 2;
  const qTexels = half + 1 + apron * 2;
  let mismatchIds = 0, maxMoistureDelta = 0, compared = 0;
  for (const [qx, qz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const qOriginX = originX + apron * step + qx * half * step - apron * step;
    const qOriginZ = originZ + apron * step + qz * half * step - apron * step;
    const q = biome.classifyTile(buildTileHeights(qOriginX, qOriginZ, qTexels, step), qTexels, step, qOriginX, qOriginZ, 0);
    for (let iz = apron; iz < qTexels - apron; iz++) {
      for (let ix = apron; ix < qTexels - apron; ix++) {
        const wx = apron + qx * half + (ix - apron);
        const wz = apron + qz * half + (iz - apron);
        if (wx >= texels - apron || wz >= texels - apron) continue;
        const a = q.biomeIds[iz * qTexels + ix], b = whole.biomeIds[wz * texels + wx];
        if (a !== b) mismatchIds++;
        maxMoistureDelta = Math.max(maxMoistureDelta, Math.abs(q.moisture[iz * qTexels + ix] - whole.moisture[wz * texels + wx]));
        compared++;
      }
    }
  }
  check('interior cells compared', compared > 200, `compared ${compared}`);
  check('quarter tiles classify identically', mismatchIds === 0, `${mismatchIds} of ${compared} differ`);
  check('quarter tiles agree on moisture', maxMoistureDelta === 0, `max delta ${maxMoistureDelta}`);
}

section('classification');
{
  const deep = biome.classifyPoint(500, -500, -40, 0);
  check('deep water is deep_ocean', deep === 'deep_ocean', `got ${deep}`);
  const shallow = biome.classifyPoint(500, -500, -4, 0);
  check('shallow water is ocean', shallow === 'ocean', `got ${shallow}`);
  const shore = biome.classifyPoint(500, -500, 1.5, 0);
  check('the flat shore band is beach', shore === 'beach', `got ${shore}`);
  check('every id round-trips through the biome table', BIOMES.every((name, i) => BIOME_INDEX[name] === i));

  // Climate varies over kilometres, so a wide sweep must produce more than one land biome.
  const seen = new Set();
  for (let x = -6000; x <= 6000; x += 250) seen.add(biome.classifyPoint(x, 1200, 30, 0.05));
  check('a 12 km sweep finds several biomes', seen.size >= 3, `saw ${[...seen].join(', ')}`);
}

section('band limit');
{
  // Coarse tiles must not dissolve into speckle: at a spacing the climate field cannot resolve,
  // octaves fade to their mean and the tile reads as one biome.
  const ids = new Set();
  for (let x = 0; x < 4000; x += 40) ids.add(biome.classifyPoint(x, 0, 30, 0.05, 400));
  check('a 400 m spacing collapses to one biome', ids.size === 1, `saw ${[...ids].join(', ')}`);
  const exact = new Set();
  for (let x = 0; x < 4000; x += 40) exact.add(biome.classifyPoint(x, 0, 30, 0.05, 0));
  check('the same sweep at spacing 0 keeps detail', exact.size >= 2, `saw ${[...exact].join(', ')}`);
}

section('moisture');
{
  const wet = biome.moistureAt('swamp', 2), dry = biome.moistureAt('desert', 60);
  check('swamp is wetter than desert', wet > dry, `${wet} vs ${dry}`);
  check('swamp moisture tracks the biome table', wet >= BIOME_MOISTURE.swamp - 1e-9 || wet >= 0.9);
  const low = biome.moistureAt('forest', 5), high = biome.moistureAt('forest', 200);
  check('the same biome dries out with height', low > high, `${low} at 5 m vs ${high} at 200 m`);
  const shoreWet = biome.moistureAt('desert', 0);
  check('the shore band reads wet whatever the biome', shoreWet > 0.9, `got ${shoreWet}`);
}

section('tile contract');
{
  check('surfaceHeights is a reserved field', TILE_FIELDS.includes('surfaceHeights'));
  const req = normalizeTileRequest({ ix: 0, iz: 0, xMin: 0, zMin: 0, size: 64, intervals: 16, apron: 1, fields: ['heights', 'surfaceHeights', 'biomeIds', 'moisture'] });
  const texels = req.intervals + 1 + req.apron * 2, n = texels * texels;
  const heights = buildTileHeights(-4, -4, texels, 4);
  const { biomeIds, moisture } = biome.classifyTile(heights, texels, 4, -4, -4, 0);
  const tile = { ix: 0, iz: 0, lod: 0, xMin: 0, zMin: 0, size: 64, intervals: 16, texels, step: 4, apron: 1, originX: -4, originZ: -4, heights, surfaceHeights: heights, biomeIds, moisture };
  let accepted = true, why = '';
  try { validateTileResult(tile, req); } catch (err) { accepted = false; why = err.message; }
  check('a tile carrying the new fields validates', accepted, why);

  let rejected = false;
  try { validateTileResult({ ...tile, surfaceHeights: new Float32Array(n - 1) }, req); } catch { rejected = true; }
  check('a wrongly sized surfaceHeights is rejected', rejected);

  let missing = false;
  try { const t = { ...tile }; delete t.biomeIds; validateTileResult(t, req); } catch { missing = true; }
  check('a requested field cannot be omitted', missing);
}

section('analytic source');
{
  const source = createAnalyticSource(analyticDescriptor({ key: 'test-analytic', seaLevel: 0 }));
  const tile = source.buildTile({ ix: 1, iz: -2, xMin: 30, zMin: -60, size: 30, intervals: 8, apron: 1, fields: ['heights', 'surfaceHeights', 'biomeIds', 'moisture'] });
  check('analytic aliases surfaceHeights to heights', tile.surfaceHeights === tile.heights);
  check('analytic reports one constant biome', tile.biomeIds.every(id => id === BIOME_INDEX[ANALYTIC_BIOME]));
  check('analytic moisture is finite and in range', tile.moisture.every(m => Number.isFinite(m) && m >= 0 && m <= 1));
}

section('visible surface, not base height');
{
  // A volumetric source's carved ground sits below the heightfield. Classifying the base height
  // would call a flooded cave mouth dry land; classifying the visible surface does not.
  const texels = 7, step = 4;
  const base = new Float32Array(texels * texels).fill(30);      // heightfield says a 30 m plateau
  const carved = new Float32Array(texels * texels).fill(-20);   // the density carved it below sea level
  const fromBase = biome.classifyTile(base, texels, step, 0, 0, 0);
  const fromSurface = biome.classifyTile(carved, texels, step, 0, 0, 0);
  const oceanIds = new Set([BIOME_INDEX.ocean, BIOME_INDEX.deep_ocean]);
  check('base height reads as land', !oceanIds.has(fromBase.biomeIds[24]), `got ${BIOMES[fromBase.biomeIds[24]]}`);
  check('the carved surface reads as water', oceanIds.has(fromSurface.biomeIds[24]), `got ${BIOMES[fromSurface.biomeIds[24]]}`);
  check('and it is wetter', fromSurface.moisture[24] > fromBase.moisture[24]);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
