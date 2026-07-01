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

// Literal transcription of biome_classifier.py's classify_biomes(), applied to one
// cell at a time. Each `if` below is one `ids[mask] = X` line in the Python source, in
// the exact same order -- later ifs unconditionally overwrite the biome chosen by
// earlier ones when both match, which is the entire point of this page (see the
// priority-stack panel, Task 7).
export function classifyBiomeCell({ height, slope, temp, humid, weird, beachMask, seaLevel, cfg }) {
  let biome = 'plains';
  let ruleIndex = -1;
  const set = (name, idx) => { biome = name; ruleIndex = idx; };

  if (height < seaLevel - 14.0) set('deep_ocean', 0);
  if (height >= seaLevel - 14.0 && height <= seaLevel) set('ocean', 1);
  if (beachMask > 0.35) set('beach', 2);

  const land = height > seaLevel + 0.5;
  const hot = temp > 0.30;
  const cold = temp < -0.35;
  const wet = humid > cfg.forest_humidity_bias;
  const veryWet = humid > 0.45;
  const dry = humid < -0.20;
  const high = height > cfg.snow_height_start;
  const steep = slope > 0.42;

  if (land && hot && dry) set('desert', 3);
  if (land && hot && dry && weird > 0.38) set('badlands', 4);
  if (land && hot && !dry && !veryWet) set('savanna', 5);
  if (land && veryWet && hot) set('jungle', 6);
  if (land && veryWet && !hot) set('swamp', 7);
  if (land && wet && !cold && !veryWet) set('forest', 8);
  if (land && wet && humid > 0.25 && !hot && !cold) set('dark_forest', 9);
  if (land && cold && wet) set('taiga', 10);
  if (land && cold && wet && high) set('snowy_taiga', 11);
  if (land && cold && !wet) set('snowy_plains', 12);
  if (land && !hot && !cold && humid > -0.05 && weird > 0.28) set('meadow', 13);
  if (land && steep) set('windswept_hills', 14);
  if (land && high && steep) set('stony_peaks', 15);
  if (land && height > cfg.snow_height_full && slope < 0.80) set('snowy_peaks', 16);

  return { biome, ruleIndex };
}

// ---- seeded value-noise fBm (port of noise_fields.py's _value_noise/_fbm) ----
// Same algorithm as the Python (fade-interpolated bilinear lattice noise, summed over
// octaves at halving amplitude), but the lattice itself is filled from a JS-native
// mulberry32 PRNG rather than numpy's PCG64 (np.random.default_rng) -- see the design
// spec's Non-goals: same character, not bit-identical to a real terrain-v3 export.

const CHANNEL_OFFSETS = { continentalness: 101, erosion: 211, weirdness: 307, temperature: 401, humidity: 503 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) h = Math.imul(h ^ (p | 0), 16777619) >>> 0;
  return h >>> 0;
}

function fade(t) { return t * t * (3.0 - 2.0 * t); }

function buildLattice(seed, period) {
  const cellsPerAxis = Math.max(2, Math.ceil(WORLD_EXTENT / Math.max(period, 1e-6)) + 4);
  const rand = mulberry32(seed);
  const values = new Float64Array(cellsPerAxis * cellsPerAxis);
  for (let i = 0; i < values.length; i++) values[i] = rand() * 2 - 1;
  return { size: cellsPerAxis, values };
}

function clampIndex(i, size) { return i < 0 ? 0 : i >= size ? size - 1 : i; }

function sampleLattice(lattice, xCoord, zCoord) {
  const { size, values } = lattice;
  const half = size >> 1;
  const x0f = Math.floor(xCoord);
  const z0f = Math.floor(zCoord);
  const tx = fade(xCoord - x0f);
  const tz = fade(zCoord - z0f);
  const x0 = clampIndex(x0f + half, size);
  const x1 = clampIndex(x0f + half + 1, size);
  const z0 = clampIndex(z0f + half, size);
  const z1 = clampIndex(z0f + half + 1, size);
  const v00 = values[z0 * size + x0];
  const v10 = values[z0 * size + x1];
  const v01 = values[z1 * size + x0];
  const v11 = values[z1 * size + x1];
  const vx0 = v00 * (1 - tx) + v10 * tx;
  const vx1 = v01 * (1 - tx) + v11 * tx;
  return vx0 * (1 - tz) + vx1 * tz;
}

export function createFieldSampler(seed) {
  const latticeCache = new Map();
  function getLattice(channel, basePeriod, octave, octavePeriod) {
    const key = channel + ':' + basePeriod + ':' + octave;
    let lat = latticeCache.get(key);
    if (!lat) {
      const octaveSeed = hashSeed(seed, CHANNEL_OFFSETS[channel], octave * 1299721);
      lat = buildLattice(octaveSeed, octavePeriod);
      latticeCache.set(key, lat);
    }
    return lat;
  }
  function sample(channel, x, z, period, octaves) {
    const oct = Math.max(1, Math.floor(octaves));
    let total = 0, ampSum = 0, amp = 1;
    for (let o = 0; o < oct; o++) {
      const octavePeriod = Math.max(period / Math.pow(2, o), 1e-6);
      const lat = getLattice(channel, period, o, octavePeriod);
      total += sampleLattice(lat, x / octavePeriod, z / octavePeriod) * amp;
      ampSum += amp;
      amp *= 0.5;
    }
    const v = (total / Math.max(ampSum, 1e-8)) * 1.35;
    return Math.min(1, Math.max(-1, v));
  }
  return { sample };
}
