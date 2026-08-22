// terrain-generator-v4's JS port of terrain-v3's full 2D pipeline (config.py,
// stages/erosion_sim.py, stages/derived_maps.py, stages/material_masks.py,
// preview/color_maps.py). terrain-v3 lives in a separate repo
// (G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\) and is the only thing
// that actually produces a real map export -- this module exists purely to run the same
// algorithm interactively in terrain-generator-v4.html. It is a hand-synced math twin
// (see root CLAUDE.md's "CPU/GPU math twins" note), not imported by any production
// file, and not guaranteed bit-exact with a real Python run (different seeded PRNG).
//
// noise-field sampling, height composition primitives, and biome classification are
// reused from biome-classifier-js.js rather than duplicated here (see
// docs/superpowers/specs/2026-07-02-terrain-generator-v4-phase-a-design.md).

import {
  BIOMES, BIOME_INDEX, BIOME_COLORS, createFieldSampler, classifyBiomeCell,
  interp1d, rescaleArray, peaksAndValleys, smoothstep, clamp01,
  CONTINENT_X, CONTINENT_Y, EROSION_X, EROSION_Y,
  mulberry32, hashSeed, fade, createUnboundedFieldSampler,
} from './biome-classifier-js.js';

export {
  BIOMES, BIOME_INDEX, BIOME_COLORS, createFieldSampler, classifyBiomeCell,
};

// terrain_v3/config.py's Terrain2DConfig dataclass defaults, transcribed verbatim.
export const DEFAULT_CONFIG = {
  seed: 1337,
  world_x: 1200.0,
  world_z: 1200.0,
  preview_resolution: 384,
  sea_level: 0.0,

  continentalness_period: 1180.0,
  erosion_period: 820.0,
  weirdness_period: 690.0,
  temperature_period: 1550.0,
  humidity_period: 1300.0,

  continentalness_octaves: 4,
  erosion_octaves: 4,
  weirdness_octaves: 5,
  temperature_octaves: 3,
  humidity_octaves: 3,

  deep_ocean_depth: -42.0,
  far_inland_height: 56.0,
  min_plains_amplitude: 2.0,
  max_mountain_amplitude: 92.0,

  hydraulic_erosion_strength: 5.0,
  thermal_erosion_iterations: 3,
  thermal_erosion_strength: 0.22,
  thermal_talus_angle: 32.0,

  lake_flow_threshold: 0.58,
  lake_max_slope: 0.14,
  lake_expand_iterations: 4,
  lake_bank_height: 2.5,

  beach_width: 9.0,
  rock_slope_start: 0.34,
  rock_slope_full: 0.72,
  snow_height_start: 74.0,
  snow_height_full: 112.0,
  forest_humidity_bias: 0.1,
};

// config.py's FIELD_GROUPS, transcribed verbatim (field lists only -- labels/ranges below).
export const FIELD_GROUPS = [
  { name: 'World', fields: ['seed', 'world_x', 'world_z', 'preview_resolution', 'sea_level'] },
  { name: 'Noise Fields', fields: [
    'continentalness_period', 'erosion_period', 'weirdness_period', 'temperature_period', 'humidity_period',
    'continentalness_octaves', 'erosion_octaves', 'weirdness_octaves', 'temperature_octaves', 'humidity_octaves',
  ] },
  { name: 'Height Composer', fields: [
    'deep_ocean_depth', 'far_inland_height', 'min_plains_amplitude', 'max_mountain_amplitude',
  ] },
  { name: 'Erosion Simulation', fields: [
    'hydraulic_erosion_strength', 'thermal_erosion_iterations', 'thermal_erosion_strength', 'thermal_talus_angle',
  ] },
  { name: 'Hydrology', fields: [
    'lake_flow_threshold', 'lake_max_slope', 'lake_expand_iterations', 'lake_bank_height',
  ] },
  { name: 'Derived Masks', fields: [
    'beach_width', 'rock_slope_start', 'rock_slope_full', 'snow_height_start', 'snow_height_full', 'forest_humidity_bias',
  ] },
];

// config.py's FIELD_RANGES: [min, max, step]. Note preview_resolution's real range
// (96-1024) is exposed here in full -- terrain-generator-v4.html applies its own lower
// default + a "may feel slow" warning banner above WARN_RESOLUTION, it does not shrink
// this range.
export const FIELD_RANGES = {
  seed: [0, 99999, 1],
  world_x: [128.0, 4000.0, 16.0],
  world_z: [128.0, 4000.0, 16.0],
  preview_resolution: [96, 1024, 32],
  sea_level: [-120.0, 120.0, 1.0],
  continentalness_period: [80.0, 4000.0, 4.0],
  erosion_period: [80.0, 4000.0, 4.0],
  weirdness_period: [80.0, 4000.0, 4.0],
  temperature_period: [80.0, 4000.0, 4.0],
  humidity_period: [80.0, 4000.0, 4.0],
  continentalness_octaves: [1, 8, 1],
  erosion_octaves: [1, 8, 1],
  weirdness_octaves: [1, 8, 1],
  temperature_octaves: [1, 8, 1],
  humidity_octaves: [1, 8, 1],
  deep_ocean_depth: [-180.0, 0.0, 1.0],
  far_inland_height: [0.0, 220.0, 1.0],
  min_plains_amplitude: [0.0, 40.0, 0.5],
  max_mountain_amplitude: [0.0, 240.0, 1.0],
  hydraulic_erosion_strength: [0.0, 24.0, 0.25],
  thermal_erosion_iterations: [0, 12, 1],
  thermal_erosion_strength: [0.0, 1.0, 0.01],
  thermal_talus_angle: [18.0, 48.0, 0.5],
  lake_flow_threshold: [0.0, 1.0, 0.01],
  lake_max_slope: [0.0, 0.5, 0.01],
  lake_expand_iterations: [0, 16, 1],
  lake_bank_height: [0.0, 12.0, 0.25],
  beach_width: [0.0, 48.0, 0.5],
  rock_slope_start: [0.0, 1.2, 0.01],
  rock_slope_full: [0.0, 1.6, 0.01],
  snow_height_start: [-40.0, 240.0, 1.0],
  snow_height_full: [-20.0, 320.0, 1.0],
  forest_humidity_bias: [-1.0, 1.0, 0.01],
};

// config.py's FIELD_LABELS. Fields with no entry fall back to name.replace('_', ' ')
// (mirrors schema.py's config_schema()).
const FIELD_LABELS = {
  world_x: 'world width',
  world_z: 'world depth',
  preview_resolution: 'preview res',
  sea_level: 'sea level',
  continentalness_period: 'continent period',
  erosion_period: 'erosion period',
  weirdness_period: 'weirdness period',
  temperature_period: 'temperature period',
  humidity_period: 'humidity period',
  continentalness_octaves: 'continent octaves',
  erosion_octaves: 'erosion octaves',
  weirdness_octaves: 'weirdness octaves',
  temperature_octaves: 'temperature octaves',
  humidity_octaves: 'humidity octaves',
  deep_ocean_depth: 'ocean depth',
  far_inland_height: 'inland height',
  min_plains_amplitude: 'plains amplitude',
  max_mountain_amplitude: 'mountain amplitude',
  hydraulic_erosion_strength: 'hydraulic erosion',
  thermal_erosion_iterations: 'thermal iterations',
  thermal_erosion_strength: 'thermal strength',
  thermal_talus_angle: 'talus angle',
  lake_flow_threshold: 'lake flow',
  lake_max_slope: 'lake slope',
  lake_expand_iterations: 'lake spread',
  lake_bank_height: 'lake bank',
  rock_slope_start: 'rock slope start',
  rock_slope_full: 'rock slope full',
  snow_height_start: 'snow start',
  snow_height_full: 'snow full',
  forest_humidity_bias: 'forest humidity',
};

export function fieldLabel(name) {
  return FIELD_LABELS[name] ?? name.replace(/_/g, ' ');
}

// One-line, factual description of what each field controls, shown under its slider in
// terrain-generator-v4.html. No FIELD_LABELS-style fallback -- every field listed in
// FIELD_GROUPS must have an entry here (checked by test-terrain-generator-js.mjs).
const FIELD_DESCRIPTIONS = {
  seed: 'PRNG seed for every noise field (continentalness, erosion, weirdness, temperature, humidity).',
  world_x: "World width in world units. Sets the x-axis sample extent for every field and the erosion grid's cell spacing.",
  world_z: "World depth in world units. Sets the z-axis sample extent and cell spacing.",
  preview_resolution: 'Grid resolution (cells per axis) for this live preview. Higher values show finer detail but redraw slower.',
  sea_level: 'Height threshold below which cells classify as ocean/lake and above which as land.',

  continentalness_period: 'Wavelength of the continentalness field in world units. Larger values produce fewer, larger continents; smaller values produce more, smaller landmasses.',
  erosion_period: 'Wavelength of the erosion field, which sets local mountain amplitude (see Height Composer).',
  weirdness_period: 'Wavelength of the weirdness field, which drives the peaks-and-valleys ridge/valley pattern layered onto height.',
  temperature_period: 'Wavelength of the temperature field used by biome classification.',
  humidity_period: 'Wavelength of the humidity field used by biome classification.',
  continentalness_octaves: 'Number of fBm octaves summed into the continentalness field. More octaves add finer detail on top of the base wavelength.',
  erosion_octaves: 'Number of fBm octaves summed into the erosion field.',
  weirdness_octaves: 'Number of fBm octaves summed into the weirdness field.',
  temperature_octaves: 'Number of fBm octaves summed into the temperature field.',
  humidity_octaves: 'Number of fBm octaves summed into the humidity field.',

  deep_ocean_depth: 'Height assigned to the most negative continentalness values (deepest ocean floor).',
  far_inland_height: 'Height assigned to the most positive continentalness values (base height of land far from any coast).',
  min_plains_amplitude: 'Peaks-and-valleys amplitude at the calmest erosion values -- how flat plains-like terrain gets.',
  max_mountain_amplitude: 'Peaks-and-valleys amplitude at the roughest erosion values -- how tall mountain terrain gets.',

  hydraulic_erosion_strength: 'Strength of flow-driven incision (carving) and deposition applied to the height field. 0 disables hydraulic erosion.',
  thermal_erosion_iterations: 'Number of thermal-relaxation passes that smooth slopes steeper than the talus angle. 0 disables thermal erosion.',
  thermal_erosion_strength: "Fraction of each pass's excess slope that gets relaxed per iteration.",
  thermal_talus_angle: 'Slope angle in degrees above which thermal relaxation moves material downhill.',

  lake_flow_threshold: 'Minimum normalized flow accumulation required for a low-slope sink cell to seed a lake.',
  lake_max_slope: 'Maximum slope a cell can have and still be eligible to hold or receive lake water.',
  lake_expand_iterations: 'Number of flood-fill passes used to grow seeded lakes outward to neighboring cells.',
  lake_bank_height: "Height above a lake's seed cell that the waterline is allowed to reach.",

  beach_width: 'Height range above sea level over which the beach mask fades out.',
  rock_slope_start: 'Slope at which the rock mask begins to appear.',
  rock_slope_full: 'Slope at which the rock mask reaches full strength.',
  snow_height_start: 'Height at which the snow mask begins to appear.',
  snow_height_full: 'Height at which the snow mask reaches full strength.',
  forest_humidity_bias: "Humidity threshold above which land counts as 'wet' for biome classification (forest/taiga/etc).",
};

export function fieldDescription(name) {
  return FIELD_DESCRIPTIONS[name] ?? '';
}

// ---- shared slope helper (port of derived_maps.py / erosion_sim.py's np.gradient use) ----
// Per-axis central difference (forward/backward at edges), unlike biome-classifier-js.js's
// generateGrid which uses one shared dx for both axes tied to a fixed WORLD_EXTENT --
// here world_x/world_z are independently configurable, so each axis gets its own spacing.
export function gradientMagnitude(height, resolution, worldX, worldZ) {
  const dx = worldX / Math.max(1, resolution - 1);
  const dz = worldZ / Math.max(1, resolution - 1);
  const slope = new Float32Array(resolution * resolution);
  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const idx = iz * resolution + ix;
      const xL = ix > 0 ? height[idx - 1] : height[idx];
      const xR = ix < resolution - 1 ? height[idx + 1] : height[idx];
      const stepX = (ix > 0 && ix < resolution - 1) ? 2 * dx : dx;
      const gradX = (xR - xL) / Math.max(stepX, 1e-6);

      const zT = iz > 0 ? height[idx - resolution] : height[idx];
      const zB = iz < resolution - 1 ? height[idx + resolution] : height[idx];
      const stepZ = (iz > 0 && iz < resolution - 1) ? 2 * dz : dz;
      const gradZ = (zB - zT) / Math.max(stepZ, 1e-6);

      slope[idx] = Math.sqrt(gradX * gradX + gradZ * gradZ);
    }
  }
  return slope;
}

// ---- flow accumulation (port of erosion_sim.py's flow_accumulation/_steepest_lower_receivers) ----
const FLOW_DIRS_8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

// Returns { raw, norm, receiver }. receiver[idx] is the index of idx's single steepest
// strictly-lower neighbor, or -1 if idx is a local sink (no strictly lower neighbor) --
// exposed so buildDerivedMaps' lake detection can reuse it as the sink mask instead of
// recomputing the same 8-neighbor scan a second time.
export function flowAccumulation(height, resolution) {
  const n = resolution * resolution;
  const receiver = new Int32Array(n).fill(-1);
  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const idx = iz * resolution + ix;
      let minVal = Infinity;
      let minIdx = -1;
      for (const [dz, dx] of FLOW_DIRS_8) {
        const nz = iz + dz;
        const nx = ix + dx;
        if (nz < 0 || nz >= resolution || nx < 0 || nx >= resolution) continue;
        const nIdx = nz * resolution + nx;
        if (height[nIdx] < minVal) { minVal = height[nIdx]; minIdx = nIdx; }
      }
      receiver[idx] = (minIdx >= 0 && minVal < height[idx] - 1e-5) ? minIdx : -1;
    }
  }

  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => height[b] - height[a]); // descending height, matches np.argsort(-flat_height)

  const accum = new Float64Array(n).fill(1);
  for (const idx of order) {
    const dst = receiver[idx];
    if (dst >= 0) accum[dst] += accum[idx];
  }

  const scaled = new Float64Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    scaled[i] = Math.log1p(accum[i]);
    if (scaled[i] < lo) lo = scaled[i];
    if (scaled[i] > hi) hi = scaled[i];
  }
  const norm = new Float32Array(n);
  const span = hi - lo;
  for (let i = 0; i < n; i++) {
    norm[i] = span <= 1e-8 ? 0 : Math.min(1, Math.max(0, (scaled[i] - lo) / span));
  }

  return { raw: accum, norm, receiver };
}

// ---- erosion simulation (port of erosion_sim.py) ----
function hydraulicErode(height, resolution, cfg, flowNorm) {
  const strength = Math.max(0, cfg.hydraulic_erosion_strength);
  if (strength <= 0) return height.slice();
  const slope = gradientMagnitude(height, resolution, cfg.world_x, cfg.world_z);
  const out = new Float64Array(height.length);
  for (let i = 0; i < height.length; i++) {
    const slopeGate = smoothstep(0.015, 0.18, slope[i]);
    const channel = Math.pow(flowNorm[i], 1.35);
    const incision = strength * channel * (0.35 + 0.65 * slopeGate);
    const deposit = strength * 0.18 * channel * (1.0 - slopeGate) * smoothstep(0.35, 0.75, flowNorm[i]);
    out[i] = height[i] - incision + deposit;
  }
  return out;
}

function thermalRelax(height, resolution, cfg) {
  const iterations = Math.max(0, cfg.thermal_erosion_iterations | 0);
  const strength = clamp01(cfg.thermal_erosion_strength);
  if (iterations <= 0 || strength <= 0) return height.slice();

  const cellX = cfg.world_x / Math.max(1, resolution - 1);
  const cellZ = cfg.world_z / Math.max(1, resolution - 1);
  const angleRad = (cfg.thermal_talus_angle * Math.PI) / 180;
  const talusX = Math.max(0.25, Math.tan(angleRad) * cellX);
  const talusZ = Math.max(0.25, Math.tan(angleRad) * cellZ);

  let h = Float64Array.from(height);
  for (let iter = 0; iter < iterations; iter++) {
    const delta = new Float64Array(h.length);
    for (let iz = 0; iz < resolution; iz++) {
      for (let ix = 0; ix < resolution - 1; ix++) {
        const li = iz * resolution + ix;
        const ri = li + 1;
        const diff = h[li] - h[ri];
        const excess = Math.max(Math.abs(diff) - talusX, 0) * 0.5 * strength;
        const move = diff > 0 ? excess : -excess;
        delta[li] -= move;
        delta[ri] += move;
      }
    }
    for (let iz = 0; iz < resolution - 1; iz++) {
      for (let ix = 0; ix < resolution; ix++) {
        const ti = iz * resolution + ix;
        const bi = ti + resolution;
        const diff = h[ti] - h[bi];
        const excess = Math.max(Math.abs(diff) - talusZ, 0) * 0.5 * strength;
        const move = diff > 0 ? excess : -excess;
        delta[ti] -= move;
        delta[bi] += move;
      }
    }
    for (let i = 0; i < h.length; i++) h[i] += delta[i];
  }
  return h;
}

// Returns { height, erosionDelta, flowRaw, flowNorm, receiver } (Float32/Float64Arrays).
export function simulateErosion(originalHeight, resolution, cfg) {
  const { raw: flowRaw, norm: flowNorm, receiver } = flowAccumulation(originalHeight, resolution);
  let height = hydraulicErode(originalHeight, resolution, cfg, flowNorm);
  height = thermalRelax(height, resolution, cfg);

  const erosionDelta = new Float32Array(height.length);
  for (let i = 0; i < height.length; i++) erosionDelta[i] = height[i] - originalHeight[i];

  return { height: Float32Array.from(height), erosionDelta, flowRaw, flowNorm, receiver };
}

// ---- derived masks (port of derived_maps.py) ----
const LAKE_DIRS_8 = FLOW_DIRS_8;

function detectLakeMask(height, slope, seaMask, cfg, flowNorm, receiver, resolution) {
  const n = resolution * resolution;
  const land = new Uint8Array(n);
  const lowSlope = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    land[i] = seaMask[i] < 0.5 ? 1 : 0;
    lowSlope[i] = slope[i] <= cfg.lake_max_slope ? 1 : 0;
  }
  const flowThreshold = cfg.lake_flow_threshold;
  const bankHeight = Math.max(0, cfg.lake_bank_height);

  const pooled = new Uint8Array(n);
  const waterline = new Float64Array(n).fill(Infinity);
  let anySeed = false;
  for (let i = 0; i < n; i++) {
    const isSink = receiver[i] === -1;
    if (land[i] && lowSlope[i] && flowNorm[i] >= flowThreshold && isSink) {
      pooled[i] = 1;
      waterline[i] = height[i] + bankHeight;
      anySeed = true;
    }
  }
  if (!anySeed) return new Float32Array(n);

  const iterations = Math.max(0, cfg.lake_expand_iterations | 0);
  const secondaryFlow = Math.max(0.18, flowThreshold * 0.45);

  for (let iter = 0; iter < iterations; iter++) {
    const nextPooled = pooled.slice();
    const nextWaterline = waterline.slice();
    let changed = false;
    for (let iz = 0; iz < resolution; iz++) {
      for (let ix = 0; ix < resolution; ix++) {
        const idx = iz * resolution + ix;
        if (!land[idx] || !lowSlope[idx]) continue;
        for (const [dz, dx] of LAKE_DIRS_8) {
          const sz = iz - dz;
          const sx = ix - dx;
          if (sz < 0 || sz >= resolution || sx < 0 || sx >= resolution) continue;
          const sIdx = sz * resolution + sx;
          if (!pooled[sIdx]) continue;
          if (height[idx] > waterline[sIdx]) continue;
          if (flowNorm[idx] < secondaryFlow) continue;
          if (!nextPooled[idx]) { nextPooled[idx] = 1; changed = true; }
          if (waterline[sIdx] < nextWaterline[idx]) nextWaterline[idx] = waterline[sIdx];
        }
      }
    }
    if (!changed) break;
    for (let i = 0; i < n; i++) {
      pooled[i] = nextPooled[i];
      if (nextWaterline[i] < waterline[i]) waterline[i] = nextWaterline[i];
    }
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pooled[i];
  return out;
}

// Returns { slope, seaMask, lakeMask, beachMask, mountainMask, rockMask, snowMask }
// (all Float32Array, length resolution*resolution).
export function buildDerivedMaps(height, resolution, cfg, flowNorm, receiverIn = null) {
  const n = resolution * resolution;
  const slope = gradientMagnitude(height, resolution, cfg.world_x, cfg.world_z);
  const seaMask = new Float32Array(n);
  for (let i = 0; i < n; i++) seaMask[i] = height[i] <= cfg.sea_level ? 1 : 0;

  // Sink = no strictly-lower 8-neighbor, which is exactly flowAccumulation's receiver;
  // callers that already ran the flow sort pass it in so it is not sorted twice.
  const receiver = receiverIn ?? flowAccumulation(height, resolution).receiver;
  const lakeMask = detectLakeMask(height, slope, seaMask, cfg, flowNorm, receiver, resolution);

  const beachMask = new Float32Array(n);
  const mountainMask = new Float32Array(n);
  const rockMask = new Float32Array(n);
  const snowMask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sea = cfg.sea_level;
    let beach = (1.0 - smoothstep(sea + 1.0, sea + cfg.beach_width, height[i]));
    beach *= (1.0 - smoothstep(0.22, 0.52, slope[i]));
    beach *= (1.0 - lakeMask[i]);
    beachMask[i] = clamp01(beach);

    mountainMask[i] = clamp01(smoothstep(sea + 38.0, sea + 112.0, height[i]) * smoothstep(0.16, 0.72, slope[i]));
    rockMask[i] = clamp01(smoothstep(cfg.rock_slope_start, cfg.rock_slope_full, slope[i]));
    snowMask[i] = clamp01(smoothstep(cfg.snow_height_start, cfg.snow_height_full, height[i]));
  }

  return { slope, seaMask, lakeMask, beachMask, mountainMask, rockMask, snowMask };
}

// ---- material masks (port of material_masks.py) ----
const MATERIAL_COLORS = {
  grass: [92, 156, 72], forest: [50, 104, 54], dirt: [128, 94, 62],
  sand: [210, 190, 122], rock: [126, 126, 132], snow: [235, 241, 246],
};
const FOREST_BIOME_IDS = new Set(
  ['forest', 'dark_forest', 'jungle', 'taiga', 'swamp'].map((name) => BIOME_INDEX[name]),
);

// Returns { masks: {grass, forest, dirt, sand, rock, snow, water}, rgba: Uint8ClampedArray }.
export function buildMaterialMasks(height, derived, biomeIds, cfg, resolution) {
  const n = resolution * resolution;
  const grass = new Float32Array(n);
  const forest = new Float32Array(n);
  const dirt = new Float32Array(n);
  const sand = new Float32Array(n);
  const rock = new Float32Array(n);
  const snow = new Float32Array(n);
  const water = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const seaWater = height[i] <= cfg.sea_level ? 1 : 0;
    const w = Math.max(seaWater, clamp01(derived.lakeMask[i]));
    water[i] = w;
    const dry = 1.0 - w;

    const sandV = clamp01(derived.beachMask[i]) * dry;
    const rockV = clamp01(derived.rockMask[i]) * dry;
    const snowV = clamp01(derived.snowMask[i]) * (1.0 - sandV) * dry;
    const dirtV = clamp01((derived.slope[i] - 0.10) / 0.36) * (1.0 - rockV) * (1.0 - sandV);
    const isForestBiome = FOREST_BIOME_IDS.has(biomeIds[i]);
    const forestV = (isForestBiome ? 1 : 0) * (1.0 - rockV) * (1.0 - snowV) * (1.0 - sandV) * dry;
    const grassV = clamp01(1.0 - sandV - rockV - snowV - dirtV * 0.65) * dry;

    sand[i] = sandV; rock[i] = rockV; snow[i] = snowV; dirt[i] = dirtV; forest[i] = forestV; grass[i] = grassV;
  }

  const masks = { grass, forest, dirt, sand, rock, snow, water };
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    let r = 0, g = 0, b = 0, total = 0;
    for (const key of ['grass', 'forest', 'dirt', 'sand', 'rock', 'snow']) {
      const wgt = masks[key][i];
      const [cr, cg, cb] = MATERIAL_COLORS[key];
      r += cr * wgt; g += cg * wgt; b += cb * wgt; total += wgt;
    }
    if (total > 1e-4) { r /= total; g /= total; b /= total; }
    const wv = water[i];
    r = r * (1 - wv) + 28 * wv;
    g = g * (1 - wv) + 66 * wv;
    b = b * (1 - wv) + 130 * wv;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }

  return { masks, rgba };
}

// ---- full pipeline orchestration ----
// Runs the entire Phase A pipeline once: noise fields -> height composition -> erosion ->
// derived masks -> biome classification -> material masks. World extent is
// cfg.world_x/cfg.world_z (unlike biome-classifier-js.js's generateGrid, which is fixed
// to WORLD_EXTENT) -- coordinates are sampled over [-world/2, world/2] on each axis to
// match generateGrid's own centering convention.
// Stage 1: the five climate noise fields on a res x res grid.
export function generateNoiseFields(cfg, resolution, { unbounded = false } = {}) {
  const n = resolution * resolution;
  const cont = new Float32Array(n);
  const eros = new Float32Array(n);
  const weird = new Float32Array(n);
  const temp = new Float32Array(n);
  const humid = new Float32Array(n);

  const sampler = unbounded ? createUnboundedFieldSampler(cfg.seed) : createFieldSampler(cfg.seed);
  for (let iz = 0; iz < resolution; iz++) {
    const z = (iz / Math.max(1, resolution - 1) - 0.5) * cfg.world_z;
    for (let ix = 0; ix < resolution; ix++) {
      const x = (ix / Math.max(1, resolution - 1) - 0.5) * cfg.world_x;
      const idx = iz * resolution + ix;
      cont[idx] = sampler.sample('continentalness', x, z, cfg.continentalness_period, cfg.continentalness_octaves);
      eros[idx] = sampler.sample('erosion', x, z, cfg.erosion_period, cfg.erosion_octaves);
      weird[idx] = sampler.sample('weirdness', x, z, cfg.weirdness_period, cfg.weirdness_octaves);
      temp[idx] = sampler.sample('temperature', x, z, cfg.temperature_period, cfg.temperature_octaves);
      humid[idx] = sampler.sample('humidity', x, z, cfg.humidity_period, cfg.humidity_octaves);
    }
  }
  return { continentalness: cont, erosion: eros, weirdness: weird, temperature: temp, humidity: humid };
}

// Point form of stages 1-2 for the unbounded runtime source: classic composer height at
// one global coordinate. `sampler` is a field sampler (normally the unbounded one).
export function createClassicHeightPoint(cfg, sampler) {
  const baseKnots = rescaleArray(CONTINENT_Y, cfg.deep_ocean_depth, cfg.far_inland_height);
  const ampKnots = rescaleArray(EROSION_Y, cfg.min_plains_amplitude, cfg.max_mountain_amplitude);
  return function classicHeightAt(x, z) {
    const cont = sampler.sample('continentalness', x, z, cfg.continentalness_period, cfg.continentalness_octaves);
    const eros = sampler.sample('erosion', x, z, cfg.erosion_period, cfg.erosion_octaves);
    const weird = sampler.sample('weirdness', x, z, cfg.weirdness_period, cfg.weirdness_octaves);
    const base = interp1d(cont, CONTINENT_X, baseKnots);
    const amplitude = interp1d(eros, EROSION_X, ampKnots);
    return base + peaksAndValleys(weird) * amplitude;
  };
}

// Stage 2: v4's height composer, continentalness x erosion x weirdness -> world-unit height.
export function composeClassicHeight(fields, cfg) {
  const { continentalness: cont, erosion: eros, weirdness: weird } = fields;
  const n = cont.length;
  const baseKnots = rescaleArray(CONTINENT_Y, cfg.deep_ocean_depth, cfg.far_inland_height);
  const ampKnots = rescaleArray(EROSION_Y, cfg.min_plains_amplitude, cfg.max_mountain_amplitude);
  const targetHeight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const base = interp1d(cont[i], CONTINENT_X, baseKnots);
    const amplitude = interp1d(eros[i], EROSION_X, ampKnots);
    targetHeight[i] = base + peaksAndValleys(weird[i]) * amplitude;
  }
  return targetHeight;
}

// Stages 3-7: erosion -> derived masks -> biome -> material masks, from a target height.
// opts.paintHeight (Float32Array, world units) is added after erosion as a non-destructive
// delta; opts.biomeOverride (Uint8Array, 255 = none) replaces the classifier per cell.
export function finishGrid(targetHeight, fields, cfg, resolution, opts = {}) {
  const n = resolution * resolution;
  const { weirdness: weird, temperature: temp, humidity: humid } = fields;
  const eroded = simulateErosion(targetHeight, resolution, cfg);
  let { height } = eroded;
  const { erosionDelta, flowRaw, flowNorm, receiver } = eroded;
  let receiverForMasks = receiver;
  if (opts.paintHeight) {
    height = Float32Array.from(height);
    for (let i = 0; i < n; i++) height[i] += opts.paintHeight[i];
    receiverForMasks = null;
  }
  const derived = buildDerivedMaps(height, resolution, cfg, flowNorm, receiverForMasks);

  const biomeId = new Uint8Array(n);
  const ruleIndex = new Int8Array(n);
  const override = opts.biomeOverride || null;
  for (let i = 0; i < n; i++) {
    if (override && override[i] !== 255 && override[i] < BIOMES.length) {
      biomeId[i] = override[i]; ruleIndex[i] = -2; continue;
    }
    const { biome, ruleIndex: r } = classifyBiomeCell({
      height: height[i], slope: derived.slope[i], temp: temp[i], humid: humid[i], weird: weird[i],
      beachMask: derived.beachMask[i], seaLevel: cfg.sea_level, cfg,
    });
    biomeId[i] = BIOME_INDEX[biome];
    ruleIndex[i] = r;
  }

  const { masks: materialMasks, rgba: materialRgba } = buildMaterialMasks(height, derived, biomeId, cfg, resolution);

  return {
    ...fields,
    targetHeight, height, erosionDelta, flowRaw, flowNorm,
    slope: derived.slope, seaMask: derived.seaMask, lakeMask: derived.lakeMask,
    beachMask: derived.beachMask, mountainMask: derived.mountainMask,
    rockMask: derived.rockMask, snowMask: derived.snowMask,
    biomeId, ruleIndex, materialMasks, materialRgba,
    resolution,
  };
}

// v4's whole pipeline in one call (unchanged behaviour; terrain-generator-v4.html uses it).
export function generateFullGrid(cfg, resolution) {
  const fields = generateNoiseFields(cfg, resolution);
  const targetHeight = composeClassicHeight(fields, cfg);
  return finishGrid(targetHeight, fields, cfg, resolution);
}

// v5: the target height comes from a layer stack (terrain-stack.js) whose `classic`
// layers read the v4 composer. `stackEval(classicHeight, fields) -> Float32Array` is
// injected so this module stays free of the stack import; opts as for finishGrid.
export function generateFullGridV5(cfg, resolution, stackEval, opts = {}) {
  const fields = generateNoiseFields(cfg, resolution, { unbounded: !!opts.unbounded });
  const classicHeight = composeClassicHeight(fields, cfg);
  const targetHeight = stackEval ? stackEval(classicHeight, fields) : classicHeight;
  const grid = finishGrid(targetHeight, fields, cfg, resolution, opts);
  grid.classicHeight = classicHeight;
  return grid;
}

// ---- colormaps (port of preview/color_maps.py) ----
// Each function takes one scalar (+ range where relevant) and returns [r, g, b]
// (0-255 numbers). No document/canvas dependency -- the HTML page loops per-cell.
function lerp(a, b, t) { return a + (b - a) * t; }

export function gradientColor(value, stops, lo, hi) {
  const span = Math.max(hi - lo, 1e-8);
  const t = clamp01((value - lo) / span);
  if (t <= stops[0][0]) return stops[0][1].slice();
  if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1].slice();
  for (let i = 0; i < stops.length - 1; i++) {
    const [pos, color] = stops[i];
    const [nextPos, nextColor] = stops[i + 1];
    if (t >= pos && t <= nextPos) {
      const local = clamp01((t - pos) / Math.max(nextPos - pos, 1e-8));
      return [
        lerp(color[0], nextColor[0], local),
        lerp(color[1], nextColor[1], local),
        lerp(color[2], nextColor[2], local),
      ];
    }
  }
  return stops[stops.length - 1][1].slice();
}

export function divergingColor(value) {
  return gradientColor(value, [[0.0, [35, 72, 135]], [0.5, [218, 222, 205]], [1.0, [142, 65, 45]]], -1.0, 1.0);
}

export function signedColor(value, limit) {
  const l = Math.max(1.0, Math.abs(limit));
  return gradientColor(value, [[0.0, [48, 112, 184]], [0.5, [24, 28, 26]], [1.0, [224, 132, 72]]], -l, l);
}

export function heightColor(height, seaLevel) {
  const lo = Math.min(height, seaLevel - 20.0);
  const hi = Math.max(height, seaLevel + 80.0);
  return gradientColor(height, [
    [0.00, [18, 40, 94]], [0.32, [40, 92, 150]], [0.38, [216, 199, 132]],
    [0.52, [82, 150, 72]], [0.72, [126, 118, 95]], [1.00, [238, 242, 246]],
  ], lo, hi);
}

export function flowColor(flow) {
  return gradientColor(flow, [
    [0.0, [16, 20, 24]], [0.35, [42, 88, 128]], [0.72, [74, 176, 178]], [1.0, [235, 226, 150]],
  ], 0.0, 1.0);
}

export function slopeColor(slope, maxSlope) {
  const hi = Math.max(1.2, maxSlope);
  return gradientColor(slope, [
    [0.0, [32, 56, 62]], [0.35, [100, 158, 90]], [0.65, [204, 154, 76]], [1.0, [240, 236, 220]],
  ], 0.0, hi);
}

export function maskColor(mask, color) {
  const m = clamp01(mask);
  const base = [18, 22, 26];
  return [lerp(base[0], color[0], m), lerp(base[1], color[1], m), lerp(base[2], color[2], m)];
}

// ---- heightfield mesh (Phase C: direct grid-to-mesh, no voxels) ----
// Normal formula and triangle winding match this codebase's terrain-field.js
// (terrainNormalAt's central-difference sign convention; buildChunkArrays' a/b/c/d
// winding) for consistency, though this function is independent of that file.
export function buildHeightfieldMesh(height, resolution, worldX, worldZ) {
  const n = resolution * resolution;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const dx = worldX / Math.max(1, resolution - 1);
  const dz = worldZ / Math.max(1, resolution - 1);

  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const idx = iz * resolution + ix;
      const x = (ix / Math.max(1, resolution - 1) - 0.5) * worldX;
      const z = (iz / Math.max(1, resolution - 1) - 0.5) * worldZ;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = height[idx];
      positions[idx * 3 + 2] = z;

      const xL = ix > 0 ? height[idx - 1] : height[idx];
      const xR = ix < resolution - 1 ? height[idx + 1] : height[idx];
      const stepX = (ix > 0 && ix < resolution - 1) ? 2 * dx : dx;
      const gradX = (xR - xL) / Math.max(stepX, 1e-6);

      const zT = iz > 0 ? height[idx - resolution] : height[idx];
      const zB = iz < resolution - 1 ? height[idx + resolution] : height[idx];
      const stepZ = (iz > 0 && iz < resolution - 1) ? 2 * dz : dz;
      const gradZ = (zB - zT) / Math.max(stepZ, 1e-6);

      const nx = -gradX, ny = 1, nz = -gradZ;
      const invLen = 1 / (Math.hypot(nx, ny, nz) || 1);
      normals[idx * 3] = nx * invLen;
      normals[idx * 3 + 1] = ny * invLen;
      normals[idx * 3 + 2] = nz * invLen;
    }
  }

  const quadsPerAxis = Math.max(0, resolution - 1);
  const indices = new Uint32Array(quadsPerAxis * quadsPerAxis * 6);
  let o = 0;
  for (let iz = 0; iz < quadsPerAxis; iz++) {
    for (let ix = 0; ix < quadsPerAxis; ix++) {
      const idx = iz * resolution + ix;
      const a = idx;
      const b = idx + resolution;
      const c = idx + resolution + 1;
      const d = idx + 1;
      indices[o++] = a; indices[o++] = b; indices[o++] = d;
      indices[o++] = b; indices[o++] = c; indices[o++] = d;
    }
  }

  return { positions, normals, indices };
}

// ---- 3D value noise (port of volumetric_mesh.py's _value_noise3 / _fbm3) ----
// Same fade-interpolated lattice-noise algorithm as biome-classifier-js.js's 2D
// buildLattice/sampleLattice, extended to trilinear 3D. Unlike buildLattice's
// WORLD_EXTENT-sized 2D lattice, there's no fixed extent this can assume -- world_x,
// world_z, and y_min/y_max are all independently configurable per generation -- so the
// lattice is sized to the actual extent it needs to cover, passed in explicitly.
function buildLattice3D(seed, period, extentX, extentY, extentZ) {
  const cellsX = Math.max(2, Math.ceil(extentX / Math.max(period, 1e-6)) + 4);
  const cellsY = Math.max(2, Math.ceil(extentY / Math.max(period, 1e-6)) + 4);
  const cellsZ = Math.max(2, Math.ceil(extentZ / Math.max(period, 1e-6)) + 4);
  const rand = mulberry32(seed);
  const values = new Float64Array(cellsX * cellsY * cellsZ);
  for (let i = 0; i < values.length; i++) values[i] = rand() * 2 - 1;
  return { sizeX: cellsX, sizeY: cellsY, sizeZ: cellsZ, values };
}

function clampIndex3(i, size) { return i < 0 ? 0 : i >= size ? size - 1 : i; }

function sampleLattice3D(lattice, x, y, z) {
  const { sizeX, sizeY, sizeZ, values } = lattice;
  const halfX = sizeX >> 1, halfY = sizeY >> 1, halfZ = sizeZ >> 1;
  const x0f = Math.floor(x), y0f = Math.floor(y), z0f = Math.floor(z);
  const tx = fade(x - x0f), ty = fade(y - y0f), tz = fade(z - z0f);
  const x0 = clampIndex3(x0f + halfX, sizeX), x1 = clampIndex3(x0f + halfX + 1, sizeX);
  const y0 = clampIndex3(y0f + halfY, sizeY), y1 = clampIndex3(y0f + halfY + 1, sizeY);
  const z0 = clampIndex3(z0f + halfZ, sizeZ), z1 = clampIndex3(z0f + halfZ + 1, sizeZ);

  const idx = (xi, yi, zi) => (zi * sizeY + yi) * sizeX + xi;
  const c000 = values[idx(x0, y0, z0)], c100 = values[idx(x1, y0, z0)];
  const c010 = values[idx(x0, y1, z0)], c110 = values[idx(x1, y1, z0)];
  const c001 = values[idx(x0, y0, z1)], c101 = values[idx(x1, y0, z1)];
  const c011 = values[idx(x0, y1, z1)], c111 = values[idx(x1, y1, z1)];

  const c00 = c000 * (1 - tx) + c100 * tx;
  const c10 = c010 * (1 - tx) + c110 * tx;
  const c01 = c001 * (1 - tx) + c101 * tx;
  const c11 = c011 * (1 - tx) + c111 * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

// Factory (not a singleton) so every buildDensityField3D() call gets a fresh lattice
// cache scoped to that generation's extents -- mirrors createFieldSampler's per-call Map
// cache in biome-classifier-js.js, avoiding stale lattices if world_x/world_z/y range
// change between generations.
export function createDensityNoiseSampler() {
  const latticeCache = new Map();
  function fbm3(seed, period, extentX, extentY, extentZ, x, y, z, octaves = 3) {
    const oct = Math.max(1, Math.floor(octaves));
    let total = 0, ampSum = 0, amp = 1;
    for (let o = 0; o < oct; o++) {
      const octavePeriod = Math.max(period / Math.pow(2, o), 1e-6);
      const cacheKey = seed + ':' + period + ':' + o;
      let lat = latticeCache.get(cacheKey);
      if (!lat) {
        const octaveSeed = hashSeed(seed, o * 1299721);
        lat = buildLattice3D(octaveSeed, octavePeriod, extentX, extentY, extentZ);
        latticeCache.set(cacheKey, lat);
      }
      total += sampleLattice3D(lat, x / octavePeriod, y / octavePeriod, z / octavePeriod) * amp;
      ampSum += amp;
      amp *= 0.5;
    }
    return Math.min(1, Math.max(-1, (total / Math.max(ampSum, 1e-8)) * 1.35));
  }
  return { fbm3 };
}

// ---- Phase D: density field config (port of density_config.py's DensityPreviewConfig) ----
// A second, independent config -- its own resolution, not tied to preview_resolution or
// the heightfield viewport's resolution. slice_y/cross_x/cross_z/surface_thickness are
// dropped: build_density_field never reads them, they only positioned the 2D-slice
// preview images this port replaces with a real marching-cubes mesh.
export const DENSITY_DEFAULT_CONFIG = {
  density_resolution: 96,
  y_min: -96.0,
  y_max: 192.0,
  iso_level: 0.0,
  warp_period: 187.0,
  warp_strength_surface: 8.0,
  warp_strength_global: 2.0,
  warp_surface_band_sigma: 40.0,
  cave_period: 140.0,
  cave_threshold: 0.55,
  cave_strength: 12.0,
  floor_thickness: 4.0,
};

export const DENSITY_FIELD_GROUPS = [
  { name: 'Grid', fields: ['density_resolution', 'y_min', 'y_max', 'iso_level'] },
  { name: 'Warp', fields: ['warp_period', 'warp_strength_surface', 'warp_strength_global', 'warp_surface_band_sigma'] },
  { name: 'Caves', fields: ['cave_period', 'cave_threshold', 'cave_strength'] },
  { name: 'Floor', fields: ['floor_thickness'] },
];

// [min, max, step] -- transcribed verbatim from density_config.py's DENSITY_FIELD_RANGES.
export const DENSITY_FIELD_RANGES = {
  density_resolution: [32, 160, 8],
  y_min: [-256.0, 64.0, 4.0],
  y_max: [-64.0, 384.0, 4.0],
  iso_level: [-64.0, 64.0, 1.0],
  warp_period: [20.0, 600.0, 1.0],
  warp_strength_surface: [0.0, 30.0, 0.5],
  warp_strength_global: [0.0, 20.0, 0.5],
  warp_surface_band_sigma: [5.0, 120.0, 1.0],
  cave_period: [20.0, 400.0, 5.0],
  cave_threshold: [0.0, 1.0, 0.01],
  cave_strength: [0.0, 30.0, 0.5],
  floor_thickness: [0.0, 30.0, 0.5],
};

// density_config.py's DENSITY_FIELD_LABELS, transcribed verbatim (minus the dropped fields).
const DENSITY_FIELD_LABELS = {
  density_resolution: 'voxel res', y_min: 'y min', y_max: 'y max', iso_level: 'iso level',
  warp_period: 'warp period', warp_strength_surface: 'surface warp', warp_strength_global: 'global warp',
  warp_surface_band_sigma: 'warp band', cave_period: 'cave period', cave_threshold: 'cave threshold',
  cave_strength: 'cave strength', floor_thickness: 'floor seal',
};
export function densityFieldLabel(name) { return DENSITY_FIELD_LABELS[name] ?? name.replace(/_/g, ' '); }

const DENSITY_FIELD_DESCRIPTIONS = {
  density_resolution: 'Grid resolution (cells per axis) for the 3D density field and its marching-cubes mesh. Higher values resolve finer cave/warp detail but rebuild slower.',
  y_min: "Lowest y (height) sampled by the density grid -- also the floor the exported mesh is sealed at.",
  y_max: 'Highest y (height) sampled by the density grid.',
  iso_level: 'Offset added to the height-vs-y term before marching cubes extracts the surface at value 0 -- raises or lowers the macro surface.',
  warp_period: 'Wavelength of the 3D warp noise that displaces the macro surface into overhangs.',
  warp_strength_surface: 'Warp strength applied only near the macro surface (inside the warp_surface_band_sigma band).',
  warp_strength_global: 'Warp strength applied uniformly throughout the whole volume.',
  warp_surface_band_sigma: 'Width of the band around the macro surface where warp_strength_surface applies.',
  cave_period: 'Wavelength of the ridged 3D noise used to carve caves.',
  cave_threshold: 'Ridged-noise value above which material is carved into a cave -- higher values carve fewer, sparser caves.',
  cave_strength: 'How much density is subtracted where the cave-carve term is active -- higher values carve deeper/wider caves.',
  floor_thickness: 'Thickness of the hard-solid seal forced in at y_min so the bottom of the exported mesh is never open.',
};
export function densityFieldDescription(name) { return DENSITY_FIELD_DESCRIPTIONS[name] ?? ''; }

// ---- Phase D: density field (port of volumetric_mesh.py's build_density_field) ----
// heightGrid2D must be a generateFullGrid() result computed AT densityCfg.density_resolution
// (a fresh, independent regeneration -- same reason heightfield_pipeline.py reruns the 2D
// pipeline at the density resolution: erosion/flow are whole-grid algorithms, so there is
// no per-point height-sampling shortcut). Returns a Float32Array of length res^3, indexed
// density[ix + iy*res + iz*res*res] (x-fastest -- an internal convention, not required to
// match numpy's (z,y,x) C-order axis layout in the Python source). The 6.0/8.0/50.0
// constants below are hardcoded in the Python source too (not config fields).
// Unbounded twin of createDensityNoiseSampler: 3D lattice values hashed per integer cell,
// so density can be sampled at any global (x, y, z). Same signature (extents are ignored).
function hashedCell3(octaveSeed, ix, iy, iz) {
  let h = hashSeed(octaveSeed, ix, iy, iz);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296 * 2 - 1;
}
export function createUnboundedDensityNoiseSampler() {
  const seeds = new Map();
  function sample(octaveSeed, xc, yc, zc) {
    const x0 = Math.floor(xc), y0 = Math.floor(yc), z0 = Math.floor(zc);
    const tx = fade(xc - x0), ty = fade(yc - y0), tz = fade(zc - z0);
    const c = (dx, dy, dz) => hashedCell3(octaveSeed, x0 + dx, y0 + dy, z0 + dz);
    const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * tx;
    const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * tx;
    const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * tx;
    const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * tx;
    const y0v = x00 + (x10 - x00) * ty, y1v = x01 + (x11 - x01) * ty;
    return y0v + (y1v - y0v) * tz;
  }
  function fbm3(seed, period, extentX, extentY, extentZ, x, y, z, octaves = 3) {
    const oct = Math.max(1, Math.floor(octaves));
    let total = 0, ampSum = 0, amp = 1;
    for (let o = 0; o < oct; o++) {
      const octavePeriod = Math.max(period / Math.pow(2, o), 1e-6);
      const key = seed + ':' + o;
      let os = seeds.get(key);
      if (os === undefined) { os = hashSeed(seed, o * 1299721); seeds.set(key, os); }
      total += sample(os, x / octavePeriod, y / octavePeriod, z / octavePeriod) * amp;
      ampSum += amp;
      amp *= 0.5;
    }
    return Math.min(1, Math.max(-1, (total / Math.max(ampSum, 1e-8)) * 1.35));
  }
  return { fbm3, unbounded: true };
}

// Point form of buildDensityField3D: density at one global (x, y, z) given the surface height
// there. Positive is solid. Shared by the bounded preview (with opts.unbounded) and the
// streamed volume tiles so both carve the same caves.
export function createDensityPoint(densityCfg, seed, noiseSampler, worldX = 0, worldZ = 0) {
  const extentY = densityCfg.y_max - densityCfg.y_min;
  return function densityAt(x, y, z, h) {
    let d = h - y - densityCfg.iso_level;
    const warp = noiseSampler.fbm3(seed + 201, densityCfg.warp_period, worldX, extentY, worldZ, x, y, z);
    const surfaceBand = Math.exp(-((y - h) ** 2) / (densityCfg.warp_surface_band_sigma ** 2));
    d += warp * densityCfg.warp_strength_surface * surfaceBand + warp * densityCfg.warp_strength_global;
    const caveN = noiseSampler.fbm3(seed + 202, densityCfg.cave_period, worldX, extentY, worldZ, x, y, z);
    const caveRidged = 1.0 - Math.abs(caveN) * 2.0;
    const depthBelowSurface = h - y;
    const caveMaskStrength = clamp01(depthBelowSurface / 6.0) * clamp01((y - (densityCfg.y_min + 6.0)) / 8.0);
    const caveCarve = clamp01(caveRidged - densityCfg.cave_threshold) * caveMaskStrength;
    d -= caveCarve * densityCfg.cave_strength;
    const floorBias = Math.max(0.0, (densityCfg.y_min + densityCfg.floor_thickness) - y) * 50.0;
    return d + floorBias;
  };
}

export function buildDensityField3D(heightGrid2D, densityCfg, worldX, worldZ, seed, { unbounded = false } = {}) {
  const res = densityCfg.density_resolution;
  const density = new Float32Array(res * res * res);
  const noiseSampler = unbounded ? createUnboundedDensityNoiseSampler() : createDensityNoiseSampler();
  const densityAt = createDensityPoint(densityCfg, seed, noiseSampler, worldX, worldZ);
  const extentY = densityCfg.y_max - densityCfg.y_min;

  for (let iz = 0; iz < res; iz++) {
    const z = (iz / Math.max(1, res - 1) - 0.5) * worldZ;
    for (let iy = 0; iy < res; iy++) {
      const y = densityCfg.y_min + (iy / Math.max(1, res - 1)) * extentY;
      for (let ix = 0; ix < res; ix++) {
        const x = (ix / Math.max(1, res - 1) - 0.5) * worldX;
        density[ix + iy * res + iz * res * res] = densityAt(x, y, z, heightGrid2D.height[iz * res + ix]);
      }
    }
  }
  return density;
}

// ---- Phase D: marching cubes ----
// Standard 256-entry edge/triangle tables (Lorensen & Cline 1987), as published by Paul
// Bourke (http://paulbourke.net/geometry/polygonise/), based on tables by Cory Bloyd.
// Public domain reference algorithm -- independent JS implementation, not a port of
// skimage's C code.
const EDGE_TABLE = [
  0x0, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c,
  0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03, 0xe09, 0xf00,
  0x190, 0x99, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c,
  0x99c, 0x895, 0xb9f, 0xa96, 0xd9a, 0xc93, 0xf99, 0xe90,
  0x230, 0x339, 0x33, 0x13a, 0x636, 0x73f, 0x435, 0x53c,
  0xa3c, 0xb35, 0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30,
  0x3a0, 0x2a9, 0x1a3, 0xaa, 0x7a6, 0x6af, 0x5a5, 0x4ac,
  0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0,
  0x460, 0x569, 0x663, 0x76a, 0x66, 0x16f, 0x265, 0x36c,
  0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60,
  0x5f0, 0x4f9, 0x7f3, 0x6fa, 0x1f6, 0xff, 0x3f5, 0x2fc,
  0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0,
  0x650, 0x759, 0x453, 0x55a, 0x256, 0x35f, 0x55, 0x15c,
  0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
  0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0xcc,
  0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3, 0x9c9, 0x8c0,
  0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc,
  0xcc, 0x1c5, 0x2cf, 0x3c6, 0x4ca, 0x5c3, 0x6c9, 0x7c0,
  0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c,
  0x15c, 0x55, 0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650,
  0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc,
  0x2fc, 0x3f5, 0xff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0,
  0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f, 0xd65, 0xc6c,
  0x36c, 0x265, 0x16f, 0x66, 0x76a, 0x663, 0x569, 0x460,
  0xca0, 0xda9, 0xea3, 0xfaa, 0x8a6, 0x9af, 0xaa5, 0xbac,
  0x4ac, 0x5a5, 0x6af, 0x7a6, 0xaa, 0x1a3, 0x2a9, 0x3a0,
  0xd30, 0xc39, 0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c,
  0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x33, 0x339, 0x230,
  0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c,
  0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393, 0x99, 0x190,
  0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c,
  0x70c, 0x605, 0x50f, 0x406, 0x30a, 0x203, 0x109, 0x0,
];

const TRI_TABLE = [
  [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,1,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,8,3,9,8,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,2,10,0,2,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,8,3,2,10,8,10,9,8,-1,-1,-1,-1,-1,-1,-1],
  [3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,11,2,8,11,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,9,0,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,11,2,1,9,11,9,8,11,-1,-1,-1,-1,-1,-1,-1],
  [3,10,1,11,10,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,10,1,0,8,10,8,11,10,-1,-1,-1,-1,-1,-1,-1],
  [3,9,0,3,11,9,11,10,9,-1,-1,-1,-1,-1,-1,-1],
  [9,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,3,0,7,3,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,1,9,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,1,9,4,7,1,7,3,1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,4,7,3,0,4,1,2,10,-1,-1,-1,-1,-1,-1,-1],
  [9,2,10,9,0,2,8,4,7,-1,-1,-1,-1,-1,-1,-1],
  [2,10,9,2,9,7,2,7,3,7,9,4,-1,-1,-1,-1],
  [8,4,7,3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [11,4,7,11,2,4,2,0,4,-1,-1,-1,-1,-1,-1,-1],
  [9,0,1,8,4,7,2,3,11,-1,-1,-1,-1,-1,-1,-1],
  [4,7,11,9,4,11,9,11,2,9,2,1,-1,-1,-1,-1],
  [3,10,1,3,11,10,7,8,4,-1,-1,-1,-1,-1,-1,-1],
  [1,11,10,1,4,11,1,0,4,7,11,4,-1,-1,-1,-1],
  [4,7,8,9,0,11,9,11,10,11,0,3,-1,-1,-1,-1],
  [4,7,11,4,11,9,9,11,10,-1,-1,-1,-1,-1,-1,-1],
  [9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,5,4,0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,5,4,1,5,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [8,5,4,8,3,5,3,1,5,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,0,8,1,2,10,4,9,5,-1,-1,-1,-1,-1,-1,-1],
  [5,2,10,5,4,2,4,0,2,-1,-1,-1,-1,-1,-1,-1],
  [2,10,5,3,2,5,3,5,4,3,4,8,-1,-1,-1,-1],
  [9,5,4,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,11,2,0,8,11,4,9,5,-1,-1,-1,-1,-1,-1,-1],
  [0,5,4,0,1,5,2,3,11,-1,-1,-1,-1,-1,-1,-1],
  [2,1,5,2,5,8,2,8,11,4,8,5,-1,-1,-1,-1],
  [10,3,11,10,1,3,9,5,4,-1,-1,-1,-1,-1,-1,-1],
  [4,9,5,0,8,1,8,10,1,8,11,10,-1,-1,-1,-1],
  [5,4,0,5,0,11,5,11,10,11,0,3,-1,-1,-1,-1],
  [5,4,8,5,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1],
  [9,7,8,5,7,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,3,0,9,5,3,5,7,3,-1,-1,-1,-1,-1,-1,-1],
  [0,7,8,0,1,7,1,5,7,-1,-1,-1,-1,-1,-1,-1],
  [1,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,7,8,9,5,7,10,1,2,-1,-1,-1,-1,-1,-1,-1],
  [10,1,2,9,5,0,5,3,0,5,7,3,-1,-1,-1,-1],
  [8,0,2,8,2,5,8,5,7,10,5,2,-1,-1,-1,-1],
  [2,10,5,2,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1],
  [7,9,5,7,8,9,3,11,2,-1,-1,-1,-1,-1,-1,-1],
  [9,5,7,9,7,2,9,2,0,2,7,11,-1,-1,-1,-1],
  [2,3,11,0,1,8,1,7,8,1,5,7,-1,-1,-1,-1],
  [11,2,1,11,1,7,7,1,5,-1,-1,-1,-1,-1,-1,-1],
  [9,5,8,8,5,7,10,1,3,10,3,11,-1,-1,-1,-1],
  [5,7,0,5,0,9,7,11,0,1,0,10,11,10,0,-1],
  [11,10,0,11,0,3,10,5,0,8,0,7,5,7,0,-1],
  [11,10,5,7,11,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,0,1,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,8,3,1,9,8,5,10,6,-1,-1,-1,-1,-1,-1,-1],
  [1,6,5,2,6,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,6,5,1,2,6,3,0,8,-1,-1,-1,-1,-1,-1,-1],
  [9,6,5,9,0,6,0,2,6,-1,-1,-1,-1,-1,-1,-1],
  [5,9,8,5,8,2,5,2,6,3,2,8,-1,-1,-1,-1],
  [2,3,11,10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [11,0,8,11,2,0,10,6,5,-1,-1,-1,-1,-1,-1,-1],
  [0,1,9,2,3,11,5,10,6,-1,-1,-1,-1,-1,-1,-1],
  [5,10,6,1,9,2,9,11,2,9,8,11,-1,-1,-1,-1],
  [6,3,11,6,5,3,5,1,3,-1,-1,-1,-1,-1,-1,-1],
  [0,8,11,0,11,5,0,5,1,5,11,6,-1,-1,-1,-1],
  [3,11,6,0,3,6,0,6,5,0,5,9,-1,-1,-1,-1],
  [6,5,9,6,9,11,11,9,8,-1,-1,-1,-1,-1,-1,-1],
  [5,10,6,4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,3,0,4,7,3,6,5,10,-1,-1,-1,-1,-1,-1,-1],
  [1,9,0,5,10,6,8,4,7,-1,-1,-1,-1,-1,-1,-1],
  [10,6,5,1,9,7,1,7,3,7,9,4,-1,-1,-1,-1],
  [6,1,2,6,5,1,4,7,8,-1,-1,-1,-1,-1,-1,-1],
  [1,2,5,5,2,6,3,0,4,3,4,7,-1,-1,-1,-1],
  [8,4,7,9,0,5,0,6,5,0,2,6,-1,-1,-1,-1],
  [7,3,9,7,9,4,3,2,9,5,9,6,2,6,9,-1],
  [3,11,2,7,8,4,10,6,5,-1,-1,-1,-1,-1,-1,-1],
  [5,10,6,4,7,2,4,2,0,2,7,11,-1,-1,-1,-1],
  [0,1,9,4,7,8,2,3,11,5,10,6,-1,-1,-1,-1],
  [9,2,1,9,11,2,9,4,11,7,11,4,5,10,6,-1],
  [8,4,7,3,11,5,3,5,1,5,11,6,-1,-1,-1,-1],
  [5,1,11,5,11,6,1,0,11,7,11,4,0,4,11,-1],
  [0,5,9,0,6,5,0,3,6,11,6,3,8,4,7,-1],
  [6,5,9,6,9,11,4,7,9,7,11,9,-1,-1,-1,-1],
  [10,4,9,6,4,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,10,6,4,9,10,0,8,3,-1,-1,-1,-1,-1,-1,-1],
  [10,0,1,10,6,0,6,4,0,-1,-1,-1,-1,-1,-1,-1],
  [8,3,1,8,1,6,8,6,4,6,1,10,-1,-1,-1,-1],
  [1,4,9,1,2,4,2,6,4,-1,-1,-1,-1,-1,-1,-1],
  [3,0,8,1,2,9,2,4,9,2,6,4,-1,-1,-1,-1],
  [0,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [8,3,2,8,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1],
  [10,4,9,10,6,4,11,2,3,-1,-1,-1,-1,-1,-1,-1],
  [0,8,2,2,8,11,4,9,10,4,10,6,-1,-1,-1,-1],
  [3,11,2,0,1,6,0,6,4,6,1,10,-1,-1,-1,-1],
  [6,4,1,6,1,10,4,8,1,2,1,11,8,11,1,-1],
  [9,6,4,9,3,6,9,1,3,11,6,3,-1,-1,-1,-1],
  [8,11,1,8,1,0,11,6,1,9,1,4,6,4,1,-1],
  [3,11,6,3,6,0,0,6,4,-1,-1,-1,-1,-1,-1,-1],
  [6,4,8,11,6,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [7,10,6,7,8,10,8,9,10,-1,-1,-1,-1,-1,-1,-1],
  [0,7,3,0,10,7,0,9,10,6,7,10,-1,-1,-1,-1],
  [10,6,7,1,10,7,1,7,8,1,8,0,-1,-1,-1,-1],
  [10,6,7,10,7,1,1,7,3,-1,-1,-1,-1,-1,-1,-1],
  [1,2,6,1,6,8,1,8,9,8,6,7,-1,-1,-1,-1],
  [2,6,9,2,9,1,6,7,9,0,9,3,7,3,9,-1],
  [7,8,0,7,0,6,6,0,2,-1,-1,-1,-1,-1,-1,-1],
  [7,3,2,6,7,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,3,11,10,6,8,10,8,9,8,6,7,-1,-1,-1,-1],
  [2,0,7,2,7,11,0,9,7,6,7,10,9,10,7,-1],
  [1,8,0,1,7,8,1,10,7,6,7,10,2,3,11,-1],
  [11,2,1,11,1,7,10,6,1,6,7,1,-1,-1,-1,-1],
  [8,9,6,8,6,7,9,1,6,11,6,3,1,3,6,-1],
  [0,9,1,11,6,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [7,8,0,7,0,6,3,11,0,11,6,0,-1,-1,-1,-1],
  [7,11,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,0,8,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,1,9,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [8,1,9,8,3,1,11,7,6,-1,-1,-1,-1,-1,-1,-1],
  [10,1,2,6,11,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,3,0,8,6,11,7,-1,-1,-1,-1,-1,-1,-1],
  [2,9,0,2,10,9,6,11,7,-1,-1,-1,-1,-1,-1,-1],
  [6,11,7,2,10,3,10,8,3,10,9,8,-1,-1,-1,-1],
  [7,2,3,6,2,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [7,0,8,7,6,0,6,2,0,-1,-1,-1,-1,-1,-1,-1],
  [2,7,6,2,3,7,0,1,9,-1,-1,-1,-1,-1,-1,-1],
  [1,6,2,1,8,6,1,9,8,8,7,6,-1,-1,-1,-1],
  [10,7,6,10,1,7,1,3,7,-1,-1,-1,-1,-1,-1,-1],
  [10,7,6,1,7,10,1,8,7,1,0,8,-1,-1,-1,-1],
  [0,3,7,0,7,10,0,10,9,6,10,7,-1,-1,-1,-1],
  [7,6,10,7,10,8,8,10,9,-1,-1,-1,-1,-1,-1,-1],
  [6,8,4,11,8,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,6,11,3,0,6,0,4,6,-1,-1,-1,-1,-1,-1,-1],
  [8,6,11,8,4,6,9,0,1,-1,-1,-1,-1,-1,-1,-1],
  [9,4,6,9,6,3,9,3,1,11,3,6,-1,-1,-1,-1],
  [6,8,4,6,11,8,2,10,1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,3,0,11,0,6,11,0,4,6,-1,-1,-1,-1],
  [4,11,8,4,6,11,0,2,9,2,10,9,-1,-1,-1,-1],
  [10,9,3,10,3,2,9,4,3,11,3,6,4,6,3,-1],
  [8,2,3,8,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1],
  [0,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,9,0,2,3,4,2,4,6,4,3,8,-1,-1,-1,-1],
  [1,9,4,1,4,2,2,4,6,-1,-1,-1,-1,-1,-1,-1],
  [8,1,3,8,6,1,8,4,6,6,10,1,-1,-1,-1,-1],
  [10,1,0,10,0,6,6,0,4,-1,-1,-1,-1,-1,-1,-1],
  [4,6,3,4,3,8,6,10,3,0,3,9,10,9,3,-1],
  [10,9,4,6,10,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,9,5,7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,4,9,5,11,7,6,-1,-1,-1,-1,-1,-1,-1],
  [5,0,1,5,4,0,7,6,11,-1,-1,-1,-1,-1,-1,-1],
  [11,7,6,8,3,4,3,5,4,3,1,5,-1,-1,-1,-1],
  [9,5,4,10,1,2,7,6,11,-1,-1,-1,-1,-1,-1,-1],
  [6,11,7,1,2,10,0,8,3,4,9,5,-1,-1,-1,-1],
  [7,6,11,5,4,10,4,2,10,4,0,2,-1,-1,-1,-1],
  [3,4,8,3,5,4,3,2,5,10,5,2,11,7,6,-1],
  [7,2,3,7,6,2,5,4,9,-1,-1,-1,-1,-1,-1,-1],
  [9,5,4,0,8,6,0,6,2,6,8,7,-1,-1,-1,-1],
  [3,6,2,3,7,6,1,5,0,5,4,0,-1,-1,-1,-1],
  [6,2,8,6,8,7,2,1,8,4,8,5,1,5,8,-1],
  [9,5,4,10,1,6,1,7,6,1,3,7,-1,-1,-1,-1],
  [1,6,10,1,7,6,1,0,7,8,7,0,9,5,4,-1],
  [4,0,10,4,10,5,0,3,10,6,10,7,3,7,10,-1],
  [7,6,10,7,10,8,5,4,10,4,8,10,-1,-1,-1,-1],
  [6,9,5,6,11,9,11,8,9,-1,-1,-1,-1,-1,-1,-1],
  [3,6,11,0,6,3,0,5,6,0,9,5,-1,-1,-1,-1],
  [0,11,8,0,5,11,0,1,5,5,6,11,-1,-1,-1,-1],
  [6,11,3,6,3,5,5,3,1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,10,9,5,11,9,11,8,11,5,6,-1,-1,-1,-1],
  [0,11,3,0,6,11,0,9,6,5,6,9,1,2,10,-1],
  [11,8,5,11,5,6,8,0,5,10,5,2,0,2,5,-1],
  [6,11,3,6,3,5,2,10,3,10,5,3,-1,-1,-1,-1],
  [5,8,9,5,2,8,5,6,2,3,8,2,-1,-1,-1,-1],
  [9,5,6,9,6,0,0,6,2,-1,-1,-1,-1,-1,-1,-1],
  [1,5,8,1,8,0,5,6,8,3,8,2,6,2,8,-1],
  [1,5,6,2,1,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,3,6,1,6,10,3,8,6,5,6,9,8,9,6,-1],
  [10,1,0,10,0,6,9,5,0,5,6,0,-1,-1,-1,-1],
  [0,3,8,5,6,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [10,5,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [11,5,10,7,5,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [11,5,10,11,7,5,8,3,0,-1,-1,-1,-1,-1,-1,-1],
  [5,11,7,5,10,11,1,9,0,-1,-1,-1,-1,-1,-1,-1],
  [10,7,5,10,11,7,9,8,1,8,3,1,-1,-1,-1,-1],
  [11,1,2,11,7,1,7,5,1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,1,2,7,1,7,5,7,2,11,-1,-1,-1,-1],
  [9,7,5,9,2,7,9,0,2,2,11,7,-1,-1,-1,-1],
  [7,5,2,7,2,11,5,9,2,3,2,8,9,8,2,-1],
  [2,5,10,2,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1],
  [8,2,0,8,5,2,8,7,5,10,2,5,-1,-1,-1,-1],
  [9,0,1,5,10,3,5,3,7,3,10,2,-1,-1,-1,-1],
  [9,8,2,9,2,1,8,7,2,10,2,5,7,5,2,-1],
  [1,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,8,7,0,7,1,1,7,5,-1,-1,-1,-1,-1,-1,-1],
  [9,0,3,9,3,5,5,3,7,-1,-1,-1,-1,-1,-1,-1],
  [9,8,7,5,9,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [5,8,4,5,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1],
  [5,0,4,5,11,0,5,10,11,11,3,0,-1,-1,-1,-1],
  [0,1,9,8,4,10,8,10,11,10,4,5,-1,-1,-1,-1],
  [10,11,4,10,4,5,11,3,4,9,4,1,3,1,4,-1],
  [2,5,1,2,8,5,2,11,8,4,5,8,-1,-1,-1,-1],
  [0,4,11,0,11,3,4,5,11,2,11,1,5,1,11,-1],
  [0,2,5,0,5,9,2,11,5,4,5,8,11,8,5,-1],
  [9,4,5,2,11,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,5,10,3,5,2,3,4,5,3,8,4,-1,-1,-1,-1],
  [5,10,2,5,2,4,4,2,0,-1,-1,-1,-1,-1,-1,-1],
  [3,10,2,3,5,10,3,8,5,4,5,8,0,1,9,-1],
  [5,10,2,5,2,4,1,9,2,9,4,2,-1,-1,-1,-1],
  [8,4,5,8,5,3,3,5,1,-1,-1,-1,-1,-1,-1,-1],
  [0,4,5,1,0,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [8,4,5,8,5,3,9,0,5,0,3,5,-1,-1,-1,-1],
  [9,4,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,11,7,4,9,11,9,10,11,-1,-1,-1,-1,-1,-1,-1],
  [0,8,3,4,9,7,9,11,7,9,10,11,-1,-1,-1,-1],
  [1,10,11,1,11,4,1,4,0,7,4,11,-1,-1,-1,-1],
  [3,1,4,3,4,8,1,10,4,7,4,11,10,11,4,-1],
  [4,11,7,9,11,4,9,2,11,9,1,2,-1,-1,-1,-1],
  [9,7,4,9,11,7,9,1,11,2,11,1,0,8,3,-1],
  [11,7,4,11,4,2,2,4,0,-1,-1,-1,-1,-1,-1,-1],
  [11,7,4,11,4,2,8,3,4,3,2,4,-1,-1,-1,-1],
  [2,9,10,2,7,9,2,3,7,7,4,9,-1,-1,-1,-1],
  [9,10,7,9,7,4,10,2,7,8,7,0,2,0,7,-1],
  [3,7,10,3,10,2,7,4,10,1,10,0,4,0,10,-1],
  [1,10,2,8,7,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,9,1,4,1,7,7,1,3,-1,-1,-1,-1,-1,-1,-1],
  [4,9,1,4,1,7,0,8,1,8,7,1,-1,-1,-1,-1],
  [4,0,3,7,4,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [4,8,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [9,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,0,9,3,9,11,11,9,10,-1,-1,-1,-1,-1,-1,-1],
  [0,1,10,0,10,8,8,10,11,-1,-1,-1,-1,-1,-1,-1],
  [3,1,10,11,3,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,2,11,1,11,9,9,11,8,-1,-1,-1,-1,-1,-1,-1],
  [3,0,9,3,9,11,1,2,9,2,11,9,-1,-1,-1,-1],
  [0,2,11,8,0,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [3,2,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,3,8,2,8,10,10,8,9,-1,-1,-1,-1,-1,-1,-1],
  [9,10,2,0,9,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [2,3,8,2,8,10,0,1,8,1,10,8,-1,-1,-1,-1],
  [1,10,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,3,8,9,1,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,9,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [0,3,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
];

// Corner offsets within a unit cell (standard Bourke/Lorensen-Cline numbering) and which
// two corners each of the 12 edges connects.
const MC_CORNER_DX = [0, 1, 1, 0, 0, 1, 1, 0];
const MC_CORNER_DY = [0, 0, 1, 1, 0, 0, 1, 1];
const MC_CORNER_DZ = [0, 0, 0, 0, 1, 1, 1, 1];
const MC_EDGE_CORNERS = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
// Which axis each edge runs along (0=x, 1=y, 2=z) and which of its two corners (index
// into MC_EDGE_CORNERS[e]) has the lower coordinate along that axis -- used to build a
// canonical dedup key so edges shared between adjacent cells resolve to the same vertex.
const MC_EDGE_DIR = [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2];
const MC_EDGE_BASE_SLOT = [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0];

// density is a res^3 Float32Array indexed density[ix + iy*res + iz*res*res] (matching
// buildDensityField3D's layout). spacingX/Y/Z scale grid-index space into world units;
// originX/Y/Z offset it into final world position, so callers don't need a second
// coordinate-remapping pass. Returns { positions: Float32Array, indices: Uint32Array } --
// no normals (call geometry.computeVertexNormals() on the resulting BufferGeometry).
export function marchingCubes(density, res, spacingX, spacingY, spacingZ, originX, originY, originZ, level = 0.0) {
  return marchingCubesGrid(density, res, res, res, spacingX, spacingY, spacingZ, originX, originY, originZ, level);
}

// Non-cubic grid (nx, ny, nz samples, index ix + iy*nx + iz*nx*ny). Streamed volume tiles
// are tall thin columns, so the cubic entry above is now a wrapper around this.
export function marchingCubesGrid(density, nx, ny, nz, spacingX, spacingY, spacingZ, originX, originY, originZ, level = 0.0) {
  const positions = [];
  const indices = [];
  const vertexCache = new Map();
  const vertlist = new Array(12);
  const nxy = nx * ny;

  function densityAt(ix, iy, iz) { return density[ix + iy * nx + iz * nxy]; }

  function getEdgeVertex(e, cx, cy, cz, val) {
    const [a, b] = MC_EDGE_CORNERS[e];
    const baseCorner = MC_EDGE_BASE_SLOT[e] === 0 ? a : b;
    const key = cx[baseCorner] + ',' + cy[baseCorner] + ',' + cz[baseCorner] + ',' + MC_EDGE_DIR[e];
    const cached = vertexCache.get(key);
    if (cached !== undefined) return cached;

    const va = val[a], vb = val[b];
    let mu;
    if (Math.abs(level - va) < 1e-5) mu = 0.0;
    else if (Math.abs(level - vb) < 1e-5) mu = 1.0;
    else if (Math.abs(va - vb) < 1e-5) mu = 0.0;
    else mu = (level - va) / (vb - va);

    const gx = cx[a] + mu * (cx[b] - cx[a]);
    const gy = cy[a] + mu * (cy[b] - cy[a]);
    const gz = cz[a] + mu * (cz[b] - cz[a]);
    positions.push(originX + gx * spacingX, originY + gy * spacingY, originZ + gz * spacingZ);
    const idx = positions.length / 3 - 1;
    vertexCache.set(key, idx);
    return idx;
  }

  for (let iz = 0; iz < nz - 1; iz++) {
    for (let iy = 0; iy < ny - 1; iy++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const cx = new Array(8), cy = new Array(8), cz = new Array(8), val = new Array(8);
        for (let c = 0; c < 8; c++) {
          cx[c] = ix + MC_CORNER_DX[c];
          cy[c] = iy + MC_CORNER_DY[c];
          cz[c] = iz + MC_CORNER_DZ[c];
          val[c] = densityAt(cx[c], cy[c], cz[c]);
        }

        let cubeindex = 0;
        for (let c = 0; c < 8; c++) if (val[c] < level) cubeindex |= (1 << c);
        const edgeFlags = EDGE_TABLE[cubeindex];
        if (edgeFlags === 0) continue;

        for (let e = 0; e < 12; e++) {
          if (edgeFlags & (1 << e)) vertlist[e] = getEdgeVertex(e, cx, cy, cz, val);
        }

        const tri = TRI_TABLE[cubeindex];
        for (let t = 0; t < 16 && tri[t] !== -1; t += 3) {
          indices.push(vertlist[tri[t]], vertlist[tri[t + 1]], vertlist[tri[t + 2]]);
        }
      }
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// ---- Phase D export: grass density (port of terrain_v3/export/biome_density.py) ----
// A separate table from docs/subsystems/biomes.md's TREE_DENSITY (trees, used at runtime
// by terrain-loader.js) -- both independently exist in the real pipeline for different
// purposes. Only used by the map-export path (Task 10), not by any live preview panel.
export const GRASS_DENSITY = {
  deep_ocean: 0.0, ocean: 0.0, beach: 0.15, desert: 0.0, badlands: 0.05, savanna: 0.45,
  plains: 0.75, forest: 0.85, dark_forest: 0.90, jungle: 0.95, swamp: 0.60, taiga: 0.40,
  snowy_taiga: 0.20, snowy_plains: 0.10, stony_peaks: 0.05, snowy_peaks: 0.0,
  windswept_hills: 0.20, meadow: 0.80,
};

export function grassDensityForIds(biomeId, waterMask) {
  const n = biomeId.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const density = GRASS_DENSITY[BIOMES[biomeId[i]]] ?? 0.0;
    out[i] = density * (1.0 - clamp01(waterMask[i]));
  }
  return out;
}
