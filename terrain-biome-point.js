// terrain-biome-point.js — per-tile biome and moisture for the streamed terrain (plants plan F1).
// Pure JS, no three.js: a terrain source calls classifyTile() on a worker, the tile carries the
// result, and flora/ground consumers read it. The classifier itself is biome-classifier-js.js's
// classifyBiomeCell; nothing here re-decides what a biome is.
//
// Every input is a continuous function of position — slope from the tile's own surface grid (the
// apron supplies the borders), climate from the unbounded sampler — so a cell classifies the same
// whichever tile it lands in. That is what makes streamed biomes seam-free without a global pass.
//
// Not here: erosion, lakes and flow. buildDerivedMaps' beach term multiplies in a lakeMask built
// from flowAccumulation's receiver graph, which is global; the local height and slope terms are
// kept and the lake factor waits for regional hydrology (roadmap step 9).

import { classifyBiomeCell, BIOMES, BIOME_INDEX, smoothstep, clamp01 } from './biome-classifier-js.js';
import { moistureProxyForBiome } from './moisture-proxy.js';

export { BIOMES, BIOME_INDEX };

// Biome -> tree density, the fallback an authored map's own treeDensity grid overrides. It lived in
// terrain-loader.js, which is unreachable from a streamed/Node consumer (it imports GLTFLoader), so
// it lives here now and terrain-loader.js imports it. One table, both paths — see biomes.md.
export const BIOME_TREE_DENSITY = Object.freeze({
  deep_ocean: 0.0,
  ocean: 0.0,
  beach: 0.03,
  desert: 0.0,
  badlands: 0.04,
  savanna: 0.20,
  plains: 0.10,
  forest: 0.85,
  dark_forest: 0.95,
  jungle: 0.90,
  swamp: 0.45,
  taiga: 0.70,
  snowy_taiga: 0.55,
  snowy_plains: 0.05,
  stony_peaks: 0.03,
  snowy_peaks: 0.0,
  windswept_hills: 0.18,
  meadow: 0.16,
});

export function treeDensityForBiome(biome) { return BIOME_TREE_DENSITY[biome] ?? 0; }
export const BIOME_ID_MAX = BIOMES.length - 1;

// Climate channels the classifier needs, with the cfg keys holding their period and octave count.
const CLIMATE_CHANNELS = Object.freeze([
  ['temperature', 'temperature_period', 'temperature_octaves'],
  ['humidity', 'humidity_period', 'humidity_octaves'],
  ['weirdness', 'weirdness_period', 'weirdness_octaves'],
]);

// Local half of buildDerivedMaps' beachMask: shore height band x flatness, no lake factor.
//
// The waterline term is ours, and it is a deliberate divergence: classifyBiomeCell applies beach
// AFTER ocean in its priority stack, and detectLakeMask excludes sea cells (land = seaMask < 0.5),
// so a flat seabed scores beachMask ~1 and the whole ocean floor comes back 'beach'. Beach is the
// strip above the waterline, so the term is local knowledge, not a second opinion about biomes.
export function localBeachMask(height, slope, seaLevel, beachWidth) {
  const band = 1 - smoothstep(seaLevel + 1.0, seaLevel + beachWidth, height);
  const aboveWater = smoothstep(seaLevel - 0.5, seaLevel + 0.5, height);
  return clamp01(band * aboveWater * (1 - smoothstep(0.22, 0.52, slope)));
}

// Central difference on a square grid, one-sided on the outer ring (gradientMagnitude's rule).
export function slopeAt(heights, texels, step, ix, iz) {
  const idx = iz * texels + ix;
  const left = ix > 0 ? heights[idx - 1] : heights[idx];
  const right = ix < texels - 1 ? heights[idx + 1] : heights[idx];
  const spanX = (ix > 0 && ix < texels - 1) ? 2 * step : step;
  const up = iz > 0 ? heights[idx - texels] : heights[idx];
  const down = iz < texels - 1 ? heights[idx + texels] : heights[idx];
  const spanZ = (iz > 0 && iz < texels - 1) ? 2 * step : step;
  const gx = (right - left) / Math.max(spanX, 1e-6);
  const gz = (down - up) / Math.max(spanZ, 1e-6);
  return Math.sqrt(gx * gx + gz * gz);
}

export function createBiomePoint(cfg, sampler, { seaLevel = null } = {}) {
  if (!cfg || typeof cfg !== 'object') throw new TypeError('biome point needs a terrain cfg');
  if (!sampler || typeof sampler.sample !== 'function') throw new TypeError('biome point needs a field sampler');
  const sea = Number.isFinite(seaLevel) ? seaLevel : (cfg.sea_level ?? 0);
  const beachWidth = cfg.beach_width ?? 6;
  const climate = { temperature: 0, humidity: 0, weirdness: 0 };

  // spacing > 0 fades noise octaves the sampler cannot resolve, so a coarse tile reads as one
  // large biome instead of speckle. spacing 0 is the exact field.
  function sampleClimate(x, z, spacing) {
    for (const [channel, periodKey, octaveKey] of CLIMATE_CHANNELS) {
      climate[channel] = sampler.sample(channel, x, z, cfg[periodKey], cfg[octaveKey], spacing);
    }
    return climate;
  }

  function classifyPoint(x, z, height, slope, spacing = 0) {
    const c = sampleClimate(x, z, spacing);
    const { biome } = classifyBiomeCell({
      height,
      slope,
      temp: c.temperature,
      humid: c.humidity,
      weird: c.weirdness,
      beachMask: localBeachMask(height, slope, sea, beachWidth),
      seaLevel: sea,
      cfg,
    });
    return biome;
  }

  return {
    seaLevel: sea,
    classifyPoint,
    moistureAt(biome, height) { return moistureProxyForBiome(biome, height, sea); },
    // `surfaceHeights` is the VISIBLE open-sky surface, which is not the base heightfield on a
    // volumetric source: a cave mouth's ground is lower than heightAt says.
    classifyTile(surfaceHeights, texels, step, originX, originZ, spacing = 0, want = { biomeIds: true, moisture: true }) {
      const n = texels * texels;
      if (!surfaceHeights || surfaceHeights.length !== n) throw new TypeError('classifyTile: heights do not match texels^2');
      const biomeIds = want.biomeIds === false ? null : new Uint8Array(n);
      const moisture = want.moisture === false ? null : new Float32Array(n);
      for (let iz = 0; iz < texels; iz++) {
        const z = originZ + iz * step;
        for (let ix = 0; ix < texels; ix++) {
          const idx = iz * texels + ix;
          const height = surfaceHeights[idx];
          const biome = classifyPoint(originX + ix * step, z, height, slopeAt(surfaceHeights, texels, step, ix, iz), spacing);
          if (biomeIds) biomeIds[idx] = BIOME_INDEX[biome];
          if (moisture) moisture[idx] = moistureProxyForBiome(biome, height, sea);
        }
      }
      return { biomeIds, moisture };
    },
  };
}
