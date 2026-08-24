// flora-field.js — what grows where (plants plan F3). Pure JS, no three.js.
//
// The biome says what the climate wants; `terrain-splat-streamed.js`'s splatWeights says what the
// ground is actually painted as. This reconciles the two, so a forest biome cannot grow trees on a
// cliff the terrain is drawing as bare rock, and grass cannot sprout out of snow.
//
// Cover is computed ONCE per field texel, when a tile commits, and published as three scalar
// channels. A blade or a trunk then reads one number instead of re-running the classifier and the
// splat algebra per candidate — and there is no second copy of this math in TSL to drift.

import { treeDensityForBiome } from './terrain-biome-point.js';
import { splatWeights, STREAMED_SPLAT_DEFAULTS } from './terrain-splat-streamed.js';

// How much ground cover each biome wants, before the ground itself gets a veto. Trees come from
// BIOME_TREE_DENSITY (biomes.md's table); these two are the same idea for the other layers.
export const BIOME_GRASS = Object.freeze({
  deep_ocean: 0, ocean: 0, beach: 0.12, desert: 0.03, badlands: 0.08, savanna: 0.85,
  plains: 1.0, forest: 0.75, dark_forest: 0.5, jungle: 0.7, swamp: 0.65, taiga: 0.55,
  snowy_taiga: 0.3, snowy_plains: 0.25, stony_peaks: 0.05, snowy_peaks: 0, windswept_hills: 0.4,
  meadow: 1.0,
});
export const BIOME_PLANTS = Object.freeze({
  deep_ocean: 0, ocean: 0, beach: 0.05, desert: 0.04, badlands: 0.06, savanna: 0.3,
  plains: 0.35, forest: 0.8, dark_forest: 0.9, jungle: 1.0, swamp: 0.85, taiga: 0.5,
  snowy_taiga: 0.25, snowy_plains: 0.12, stony_peaks: 0.05, snowy_peaks: 0, windswept_hills: 0.2,
  meadow: 0.6,
});

export const FLORA_COVER_DEFAULTS = Object.freeze({
  // Ground the layer will grow on at all. Rock, sand and snow veto; dirt is a partial welcome.
  grassGround: { grass: 1, dirt: 0.55, sand: 0.1, rock: 0, snow: 0 },
  plantGround: { grass: 1, dirt: 0.7, sand: 0.08, rock: 0, snow: 0 },
  treeGround: { grass: 1, dirt: 0.85, sand: 0.15, rock: 0, snow: 0.05 },
  // Slope past which nothing roots, as normalY (1 = flat). Trees give up before grass does.
  grassMinNormalY: 0.45,
  plantMinNormalY: 0.5,
  treeMinNormalY: 0.62,
  // How much dryness thins each layer: 0 ignores moisture, 1 means bone-dry ground is bare.
  grassMoisture: 0.55,
  plantMoisture: 0.9,
  treeMoisture: 0.5,
  waterMargin: 0.4,      // metres above sea level before anything roots
});

export const COVER_CHANNELS = Object.freeze(['coverGrass', 'coverPlant', 'coverTree']);

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
// u8 channels read back 0..255 on both the CPU and the GPU; one decode, in one place.
export const quantizeCover = v => Math.round(clamp01(v) * 255);
export const decodeCover = v => (v == null ? null : v / 255);

function groundWelcome(weights, table) {
  // weights is [sand, grass, dirt, rock, snow] — splatWeights' order.
  return clamp01(weights[1] * table.grass + weights[2] * table.dirt + weights[0] * table.sand
    + weights[3] * table.rock + weights[4] * table.snow);
}

function slopeGate(normalY, minNormalY) {
  if (normalY >= 1) return 1;
  return clamp01((normalY - minNormalY) / Math.max(1e-6, 1 - minNormalY));
}

// The whole rule, for one point. `weights` comes from splatWeights(height, normalY, splatCfg).
export function coverAt(biome, moisture, weights, { height = null, seaLevel = 0, normalY = 1, opts = FLORA_COVER_DEFAULTS } = {}) {
  const o = opts === FLORA_COVER_DEFAULTS ? opts : { ...FLORA_COVER_DEFAULTS, ...opts };
  if (biome == null || !weights) return { grass: 0, plant: 0, tree: 0 };
  const wet = clamp01(moisture ?? 0);
  const drowned = height != null && height < seaLevel + o.waterMargin;
  if (drowned) return { grass: 0, plant: 0, tree: 0 };
  const moistureFactor = (strength) => 1 - strength * (1 - wet);
  const grass = clamp01((BIOME_GRASS[biome] ?? 0) * groundWelcome(weights, o.grassGround)
    * slopeGate(normalY, o.grassMinNormalY) * moistureFactor(o.grassMoisture));
  const plant = clamp01((BIOME_PLANTS[biome] ?? 0) * groundWelcome(weights, o.plantGround)
    * slopeGate(normalY, o.plantMinNormalY) * moistureFactor(o.plantMoisture));
  const tree = clamp01(treeDensityForBiome(biome) * groundWelcome(weights, o.treeGround)
    * slopeGate(normalY, o.treeMinNormalY) * moistureFactor(o.treeMoisture));
  return { grass, plant, tree };
}

// Central difference on a tile's own grid, one-sided at the border (the apron covers the interior).
function normalYFromTile(heights, texels, step, ix, iz) {
  const idx = iz * texels + ix;
  const l = ix > 0 ? heights[idx - 1] : heights[idx];
  const r = ix < texels - 1 ? heights[idx + 1] : heights[idx];
  const spanX = (ix > 0 && ix < texels - 1) ? 2 * step : step;
  const u = iz > 0 ? heights[idx - texels] : heights[idx];
  const d = iz < texels - 1 ? heights[idx + texels] : heights[idx];
  const spanZ = (iz > 0 && iz < texels - 1) ? 2 * step : step;
  const gx = (r - l) / Math.max(spanX, 1e-6);
  const gz = (d - u) / Math.max(spanZ, 1e-6);
  return 1 / Math.sqrt(gx * gx + gz * gz + 1);
}

// Builds the derive step a field window runs when a tile lands: one coverAt per texel, written into
// three u8 channels the window then treats like any other field.
export function createTileCover({ seaLevel = 0, splatCfg = STREAMED_SPLAT_DEFAULTS, opts = FLORA_COVER_DEFAULTS, biomeNames } = {}) {
  if (!Array.isArray(biomeNames)) throw new TypeError('tile cover needs the biome id -> name table');
  const merged = opts === FLORA_COVER_DEFAULTS ? FLORA_COVER_DEFAULTS : { ...FLORA_COVER_DEFAULTS, ...opts };
  let cfg = splatCfg;
  let sea = seaLevel;
  return {
    get splatCfg() { return cfg; },
    setSplatCfg(next) { cfg = next ?? STREAMED_SPLAT_DEFAULTS; },
    setSeaLevel(next) { sea = Number.isFinite(next) ? next : sea; },
    channels: COVER_CHANNELS,
    // Mutates the tile, attaching the three channels. Returns it so it can sit in a pipeline.
    derive(tile) {
      const heights = tile.surfaceHeights ?? tile.heights;
      const { biomeIds, moisture, texels, step } = tile;
      if (!heights || !biomeIds) return tile;
      const n = texels * texels;
      const grass = new Uint8Array(n), plant = new Uint8Array(n), tree = new Uint8Array(n);
      for (let iz = 0; iz < texels; iz++) {
        for (let ix = 0; ix < texels; ix++) {
          const i = iz * texels + ix;
          const height = heights[i];
          const normalY = normalYFromTile(heights, texels, step, ix, iz);
          const cover = coverAt(biomeNames[biomeIds[i]] ?? null, moisture ? moisture[i] : 0,
            splatWeights(height, normalY, cfg), { height, seaLevel: sea, normalY, opts: merged });
          grass[i] = quantizeCover(cover.grass);
          plant[i] = quantizeCover(cover.plant);
          tree[i] = quantizeCover(cover.tree);
        }
      }
      tile.coverGrass = grass;
      tile.coverPlant = plant;
      tile.coverTree = tree;
      return tile;
    },
  };
}
