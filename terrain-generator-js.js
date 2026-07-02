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
