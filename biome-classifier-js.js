// JS port of terrain-v3's biome pipeline (noise_fields.py, height_composer.py,
// derived_maps.py, biome_classifier.py, config.py's Terrain2DConfig defaults).
// terrain-v3 lives in a separate repo (G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\)
// and is the only thing that actually assigns biome ids for a real map export -- this
// module exists purely to demonstrate the same algorithm interactively in
// biome-explainer.html. It is a hand-synced math twin (see root CLAUDE.md's
// "CPU/GPU math twins" note re: forest-cull.js/light-cluster.js/post-grade.js), not
// imported by any production file, and not guaranteed bit-exact with a real Python run
// (different seeded PRNG -- see the design spec's Non-goals).

export const BIOMES = [
  'deep_ocean', 'ocean', 'beach', 'desert', 'badlands', 'savanna', 'plains', 'forest',
  'dark_forest', 'jungle', 'swamp', 'taiga', 'snowy_taiga', 'snowy_plains', 'stony_peaks',
  'snowy_peaks', 'windswept_hills', 'meadow',
];

export const BIOME_INDEX = Object.fromEntries(BIOMES.map((name, i) => [name, i]));

export const BIOME_COLORS = {
  deep_ocean: [13, 25, 76], ocean: [26, 51, 115], beach: [219, 204, 140],
  desert: [230, 198, 115], badlands: [188, 107, 56], savanna: [188, 178, 77],
  plains: [128, 184, 82], forest: [56, 140, 64], dark_forest: [31, 92, 46],
  jungle: [46, 158, 71], swamp: [89, 115, 71], taiga: [77, 128, 102],
  snowy_taiga: [199, 217, 224], snowy_plains: [235, 240, 245], stony_peaks: [140, 140, 148],
  snowy_peaks: [245, 247, 255], windswept_hills: [115, 140, 115], meadow: [140, 199, 102],
};

// terrain_v3/config.py's Terrain2DConfig dataclass defaults. world_x/world_z/
// preview_resolution are intentionally omitted -- this page fixes the sampled world
// extent to WORLD_EXTENT (below) and its own GRID_RESOLUTION rather than exposing them.
export const DEFAULT_CONFIG = {
  seed: 1337,
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
  beach_width: 9.0,
  rock_slope_start: 0.34,
  rock_slope_full: 0.72,
  snow_height_start: 74.0,
  snow_height_full: 112.0,
  forest_humidity_bias: 0.1,
};

// World extent sampled by generateGrid (Task 4), matching config.py's world_x/world_z
// default (1200). Not exposed as a slider -- see design spec's Non-goals.
export const WORLD_EXTENT = 1200;

// Canvas/grid resolution for the generated mini-map (Task 4/6). Independent of
// terrain-v3's own preview_resolution (384) -- kept small so every slider drag
// recomputes well within one frame.
export const GRID_RESOLUTION = 128;
