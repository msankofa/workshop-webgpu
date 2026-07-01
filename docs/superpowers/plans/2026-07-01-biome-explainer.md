# Biome explainer implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `biome-explainer.html`, a standalone interactive page that demonstrates
both halves of the biome system: how terrain-v3 (an external Python tool) assigns a
biome per grid cell via seeded noise fields and a 17-rule priority-ordered classifier,
and how `workshop-webgpu` then consumes that assignment for ground texture / tree
density / grass density.

**Architecture:** A new pure-logic ES module, `biome-classifier-js.js`, ports the
relevant terrain-v3 Python (`noise_fields.py`, `height_composer.py`, `derived_maps.py`,
`biome_classifier.py`) into JS — a "CPU/GPU math twin" in the same spirit as
`forest-cull.js`, not imported by production code, unit-tested directly. A new page,
`biome-explainer.html`, imports that module and renders five sections: a static pipeline
diagram, a live-generated mini-map (canvas + 8 sliders bound to real terrain-v3 config
fields), a priority-rule-stack panel, a real-map viewer (`fetch`es the shipped
`maps/workshop/test_export-data.json`), and static reference tables — with mouse-hover
cross-highlighting biome identity across all of them.

**Tech Stack:** Vanilla JS ES modules, `<canvas>` 2D context, no Three.js/build step —
served via this directory's existing `python serve.py`.

---

## Before you start

Read `docs/superpowers/specs/2026-07-01-biome-explainer-design.md` for the full design
rationale. This plan implements it exactly, with two small corrections found while
writing the plan (both already reflected below, no need to re-read the spec for them):

1. `_rescale` in `height_composer.py` rescales the fixed 7/5-element `CONTINENT_Y`/
   `EROSION_Y` knot arrays to the configured min/max — it does **not** depend on the
   generated noise grid at all. (The spec's wording implied a whole-grid rescale; that
   was a misreading on a first pass. Task 4 below has the correct, much cheaper,
   per-generateGrid-call-once version.)
2. Tracing `classify_biomes`'s rule order shows `swamp` (rule 7: `land & very_wet &
   not hot`) is immediately shadowed by `dark_forest` (rule 9: `land & wet & humidity >
   0.25 & not hot & not cold`) whenever the cell isn't cold, because `very_wet` (humidity
   > 0.45) always implies `humidity > 0.25`. If the cell *is* cold, `taiga` (rule 10)
   shadows it instead. So `swamp` can never be the terminal result of this classifier as
   currently ordered — a real, faithfully-reproduced quirk of the source, not a bug in
   this port. Task 2's tests assert this explicitly (fixture `swamp_condition_shadowed`)
   and Task 7 gives the priority-stack panel a one-line callout about it.

---

## Task 1: `biome-classifier-js.js` — biome identity + default config

**Files:**
- Create: `biome-classifier-js.js`
- Test: `test-biome-classifier-js.mjs`

- [ ] **Step 1: Write the failing test**

Create `test-biome-classifier-js.mjs`:

```js
import { BIOMES, BIOME_INDEX, BIOME_COLORS, DEFAULT_CONFIG } from './biome-classifier-js.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

ok(BIOMES.length === 18, '1: 18 biome names');
ok(BIOMES[0] === 'deep_ocean' && BIOMES[6] === 'plains' && BIOMES[17] === 'meadow', '1: name order matches terrain-loader.js/biome_classifier.py');
ok(BIOME_INDEX.plains === 6 && BIOME_INDEX.meadow === 17, '1: BIOME_INDEX matches array position');
ok(Object.keys(BIOME_INDEX).length === 18, '1: BIOME_INDEX has one entry per biome');
ok(JSON.stringify(BIOME_COLORS.deep_ocean) === JSON.stringify([13, 25, 76]), '1: BIOME_COLORS.deep_ocean matches biome_classifier.py');
ok(JSON.stringify(BIOME_COLORS.meadow) === JSON.stringify([140, 199, 102]), '1: BIOME_COLORS.meadow matches biome_classifier.py');
ok(Object.keys(BIOME_COLORS).length === 18, '1: BIOME_COLORS has one entry per biome');
ok(DEFAULT_CONFIG.sea_level === 0.0, '1: DEFAULT_CONFIG.sea_level matches config.py Terrain2DConfig default');
ok(DEFAULT_CONFIG.continentalness_period === 1180.0, '1: DEFAULT_CONFIG.continentalness_period matches config.py');
ok(DEFAULT_CONFIG.forest_humidity_bias === 0.1, '1: DEFAULT_CONFIG.forest_humidity_bias matches config.py');
ok(DEFAULT_CONFIG.snow_height_start === 74.0 && DEFAULT_CONFIG.snow_height_full === 112.0, '1: DEFAULT_CONFIG snow heights match config.py');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-biome-classifier-js.mjs`
Expected: FAIL — `Cannot find module './biome-classifier-js.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `biome-classifier-js.js`:

```js
// JS port of terrain-v3's biome pipeline (noise_fields.py, height_composer.py,
// derived_maps.py, biome_classifier.py, config.py's Terrain2DConfig defaults).
// terrain-v3 lives in a separate repo (G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\)
// and is the only thing that actually assigns biome ids for a real map export — this
// module exists purely to demonstrate the same algorithm interactively in
// biome-explainer.html. It is a hand-synced math twin (see root CLAUDE.md's
// "CPU/GPU math twins" note re: forest-cull.js/light-cluster.js/post-grade.js), not
// imported by any production file, and not guaranteed bit-exact with a real Python run
// (different seeded PRNG — see the design spec's Non-goals).

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
// preview_resolution are intentionally omitted — this page fixes the sampled world
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
// default (1200). Not exposed as a slider — see design spec's Non-goals.
export const WORLD_EXTENT = 1200;

// Canvas/grid resolution for the generated mini-map (Task 4/6). Independent of
// terrain-v3's own preview_resolution (384) — kept small so every slider drag
// recomputes well within one frame.
export const GRID_RESOLUTION = 128;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-biome-classifier-js.mjs`
Expected: `11 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add biome-classifier-js.js test-biome-classifier-js.mjs
git commit -m "feat(biomes): add biome identity constants and default config (JS port, step 1/4)"
```

---

## Task 2: `classifyBiomeCell` — the priority-rule stack

**Files:**
- Modify: `biome-classifier-js.js`
- Modify: `test-biome-classifier-js.mjs`

- [ ] **Step 1: Add the failing tests**

Append to `test-biome-classifier-js.mjs`, replacing the final `console.log`/`process.exit`
lines (delete those two lines, add the block below, then re-add them at the very end):

```js
import { classifyBiomeCell } from './biome-classifier-js.js';

// classifyBiomeCell({ height, slope, temp, humid, weird, beachMask, seaLevel, cfg })
// -> { biome, ruleIndex }. cfg is DEFAULT_CONFIG unless noted. seaLevel = 0 throughout
// (DEFAULT_CONFIG.sea_level). Each fixture's expected biome/ruleIndex was derived by
// hand-tracing biome_classifier.py's classify_biomes() rule order for that input.
const cfg = DEFAULT_CONFIG;
const base = { height: 10, slope: 0, temp: 0, humid: 0, weird: 0, beachMask: 0, seaLevel: 0, cfg };

function classifyOk(overrides, expectedBiome, expectedRuleIndex, label) {
  const result = classifyBiomeCell({ ...base, ...overrides });
  ok(result.biome === expectedBiome, `2: ${label} -> biome (got ${result.biome})`);
  ok(result.ruleIndex === expectedRuleIndex, `2: ${label} -> ruleIndex (got ${result.ruleIndex})`);
}

classifyOk({}, 'plains', -1, 'default_plains (no rule matches)');
classifyOk({ height: -20 }, 'deep_ocean', 0, 'deep_ocean (height < sea-14)');
classifyOk({ height: -5 }, 'ocean', 1, 'ocean (sea-14 <= height <= sea)');
classifyOk({ height: -5, beachMask: 0.5 }, 'beach', 2, 'beach overrides ocean');
classifyOk({ temp: 0.5, humid: -0.5 }, 'desert', 3, 'desert (hot & dry)');
classifyOk({ temp: 0.5, humid: -0.5, weird: 0.5 }, 'badlands', 4, 'badlands overrides desert (weird > 0.38)');
classifyOk({ temp: 0.5, humid: 0 }, 'savanna', 5, 'savanna (hot, not dry, not very wet)');
classifyOk({ temp: 0.5, humid: 0.6 }, 'jungle', 6, 'jungle (hot & very wet)');
classifyOk({ temp: 0, humid: 0.6 }, 'dark_forest', 9, 'swamp_condition_shadowed: very-wet & not-hot & not-cold lands on dark_forest (rule 9), not swamp (rule 7) -- see "Before you start" note 2');
classifyOk({ temp: 0, humid: 0.2 }, 'forest', 8, 'forest (wet, not cold, not very wet, humid <= 0.25 so dark_forest does not also fire)');
classifyOk({ temp: 0, humid: 0.3 }, 'dark_forest', 9, 'dark_forest overrides forest (humid > 0.25)');
classifyOk({ temp: -0.5, humid: 0.2 }, 'taiga', 10, 'taiga (cold & wet, not high)');
classifyOk({ temp: -0.5, humid: 0.2, height: 80 }, 'snowy_taiga', 11, 'snowy_taiga overrides taiga (also high)');
classifyOk({ temp: -0.5, humid: -0.5 }, 'snowy_plains', 12, 'snowy_plains (cold, not wet)');
classifyOk({ humid: 0, weird: 0.5 }, 'meadow', 13, 'meadow (not hot, not cold, humid > -0.05, weird > 0.28)');
classifyOk({ humid: 0, weird: 0.5, slope: 0.5 }, 'windswept_hills', 14, 'windswept_hills overrides meadow (steep)');
classifyOk({ humid: 0, weird: 0.5, slope: 0.5, height: 80 }, 'stony_peaks', 15, 'stony_peaks overrides windswept_hills (also high)');
classifyOk({ humid: 0, weird: 0.5, slope: 0.5, height: 150 }, 'snowy_peaks', 16, 'snowy_peaks overrides stony_peaks (height > snow_height_full, slope < 0.80)');
```

(The `ok` helper and `import { DEFAULT_CONFIG, ... }` already exist from Task 1 — just
add `classifyBiomeCell` to that same import line instead of a second `import` statement
from the same module. `import { classifyBiomeCell } from './biome-classifier-js.js';`
above is written standalone here only to show what's new; when editing the file, merge
it into the existing `import { BIOMES, BIOME_INDEX, BIOME_COLORS, DEFAULT_CONFIG } from
'./biome-classifier-js.js';` line from Task 1 instead of adding a duplicate import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-biome-classifier-js.mjs`
Expected: FAIL — `classifyBiomeCell is not a function` (or a SyntaxError if the import
line wasn't merged correctly — merge it, don't duplicate the import statement).

- [ ] **Step 3: Write the implementation**

Append to `biome-classifier-js.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-biome-classifier-js.mjs`
Expected: `47 passed, 0 failed` (11 from Task 1 + 18 fixtures × 2 assertions each = 36; `11 + 36 = 47`).

- [ ] **Step 5: Commit**

```bash
git add biome-classifier-js.js test-biome-classifier-js.mjs
git commit -m "feat(biomes): add classifyBiomeCell priority-rule stack (JS port, step 2/4)"
```

---

## Task 3: `createFieldSampler` — seeded value-noise fBm

**Files:**
- Modify: `biome-classifier-js.js`
- Modify: `test-biome-classifier-js.mjs`

- [ ] **Step 1: Add the failing tests**

Add `createFieldSampler` to the existing import line, then append before the final
`console.log`/`process.exit`:

```js
const sampler = createFieldSampler(1337);
const v1 = sampler.sample('temperature', 100, 200, 1550, 3);
const v2 = sampler.sample('temperature', 100, 200, 1550, 3);
ok(v1 === v2, '3: sample() is deterministic for identical inputs');
ok(v1 >= -1 && v1 <= 1, '3: sample() stays within [-1, 1]');

const differentCoord = sampler.sample('temperature', 900, 400, 1550, 3);
ok(differentCoord !== v1, '3: sample() varies across coordinates');

const differentChannel = sampler.sample('humidity', 100, 200, 1300, 3);
ok(differentChannel !== v1, '3: different channels are independent (not the same noise field)');

const samplerB = createFieldSampler(9999);
const v1b = samplerB.sample('temperature', 100, 200, 1550, 3);
ok(v1b !== v1, '3: different seeds produce different fields');

const samplerA2 = createFieldSampler(1337);
const v1a2 = samplerA2.sample('temperature', 100, 200, 1550, 3);
ok(v1a2 === v1, '3: same seed reproduces the same field across sampler instances');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-biome-classifier-js.mjs`
Expected: FAIL — `createFieldSampler is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `biome-classifier-js.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-biome-classifier-js.mjs`
Expected: `53 passed, 0 failed` (47 from Task 2 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add biome-classifier-js.js test-biome-classifier-js.mjs
git commit -m "feat(biomes): add createFieldSampler seeded noise fBm (JS port, step 3/4)"
```

---

## Task 4: `generateGrid` — full per-cell pipeline

**Files:**
- Modify: `biome-classifier-js.js`
- Modify: `test-biome-classifier-js.mjs`

- [ ] **Step 1: Add the failing tests**

Add `generateGrid` to the existing import line, then append before the final
`console.log`/`process.exit`:

```js
const RES = 16; // small grid for fast test iteration; production uses GRID_RESOLUTION (128)
const gridA = generateGrid(DEFAULT_CONFIG, RES);
ok(gridA.height.length === RES * RES, '4: height array is resolution^2');
ok(gridA.slope.length === RES * RES, '4: slope array is resolution^2');
ok(gridA.biomeId.length === RES * RES, '4: biomeId array is resolution^2');
ok(gridA.ruleIndex.length === RES * RES, '4: ruleIndex array is resolution^2');

let allBiomeIdsValid = true, allRuleIndicesValid = true;
for (let i = 0; i < gridA.biomeId.length; i++) {
  if (gridA.biomeId[i] < 0 || gridA.biomeId[i] > 17) allBiomeIdsValid = false;
  if (gridA.ruleIndex[i] < -1 || gridA.ruleIndex[i] > 16) allRuleIndicesValid = false;
}
ok(allBiomeIdsValid, '4: every biomeId is a valid BIOMES index (0-17)');
ok(allRuleIndicesValid, '4: every ruleIndex is in [-1, 16]');

const gridA2 = generateGrid(DEFAULT_CONFIG, RES);
ok(gridA2.height.every((v, i) => v === gridA.height[i]), '4: generateGrid is deterministic for identical cfg/resolution');
ok(gridA2.biomeId.every((v, i) => v === gridA.biomeId[i]), '4: biomeId output is deterministic');

const gridB = generateGrid({ ...DEFAULT_CONFIG, seed: 42 }, RES);
ok(!gridB.height.every((v, i) => v === gridA.height[i]), '4: changing seed changes the generated height field');

const gridSeaHigh = generateGrid({ ...DEFAULT_CONFIG, sea_level: 200 }, RES);
const allOceanOrDeepOcean = Array.from(gridSeaHigh.biomeId).every((id) => id === BIOME_INDEX.deep_ocean || id === BIOME_INDEX.ocean || id === BIOME_INDEX.beach);
ok(allOceanOrDeepOcean, '4: an absurdly high sea_level floods every cell to deep_ocean/ocean/beach');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-biome-classifier-js.mjs`
Expected: FAIL — `generateGrid is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `biome-classifier-js.js`:

```js
// ---- height composition (port of height_composer.py's compose_height) ----
const CONTINENT_X = [-1.0, -0.6, -0.2, 0.0, 0.3, 0.6, 1.0];
const CONTINENT_Y = [-40.0, -22.0, -4.0, 4.0, 14.0, 32.0, 55.0];
const EROSION_X = [-1.0, -0.5, 0.0, 0.5, 1.0];
const EROSION_Y = [90.0, 55.0, 22.0, 7.0, 2.0];

// NOTE: this rescales the fixed CONTINENT_Y/EROSION_Y knot arrays themselves (7 and 5
// numbers) to the configured min/max -- it does NOT depend on the generated grid, so
// it only needs to run once per generateGrid() call, not once per cell.
function rescaleArray(values, newMin, newMax) {
  const oldMin = Math.min(...values);
  const oldMax = Math.max(...values);
  const span = Math.max(oldMax - oldMin, 1e-8);
  return values.map((v) => newMin + ((v - oldMin) / span) * (newMax - newMin));
}

function interp1d(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] + t * (ys[i + 1] - ys[i]);
    }
  }
  return ys[ys.length - 1];
}

function peaksAndValleys(weird) { return 1.0 - Math.abs(3.0 * Math.abs(weird) - 2.0); }

// ---- derived maps (port of derived_maps.py's slope + beach_mask) ----
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(edge1 - edge0, 1e-8)));
  return t * t * (3 - 2 * t);
}
function clamp01(v) { return Math.min(1, Math.max(0, v)); }

// ---- full per-cell pipeline: noise fields -> height -> slope/beach -> biome ----
export function generateGrid(cfg, resolution) {
  const n = resolution * resolution;
  const cont = new Float32Array(n);
  const eros = new Float32Array(n);
  const weird = new Float32Array(n);
  const temp = new Float32Array(n);
  const humid = new Float32Array(n);
  const height = new Float32Array(n);
  const slope = new Float32Array(n);
  const biomeId = new Uint8Array(n);
  const ruleIndex = new Int8Array(n);

  const sampler = createFieldSampler(cfg.seed);
  for (let iz = 0; iz < resolution; iz++) {
    const z = (iz / (resolution - 1) - 0.5) * WORLD_EXTENT;
    for (let ix = 0; ix < resolution; ix++) {
      const x = (ix / (resolution - 1) - 0.5) * WORLD_EXTENT;
      const idx = iz * resolution + ix;
      cont[idx] = sampler.sample('continentalness', x, z, cfg.continentalness_period, cfg.continentalness_octaves);
      eros[idx] = sampler.sample('erosion', x, z, cfg.erosion_period, cfg.erosion_octaves);
      weird[idx] = sampler.sample('weirdness', x, z, cfg.weirdness_period, cfg.weirdness_octaves);
      temp[idx] = sampler.sample('temperature', x, z, cfg.temperature_period, cfg.temperature_octaves);
      humid[idx] = sampler.sample('humidity', x, z, cfg.humidity_period, cfg.humidity_octaves);
    }
  }

  const baseKnots = rescaleArray(CONTINENT_Y, cfg.deep_ocean_depth, cfg.far_inland_height);
  const ampKnots = rescaleArray(EROSION_Y, cfg.min_plains_amplitude, cfg.max_mountain_amplitude);
  for (let i = 0; i < n; i++) {
    const bse = interp1d(cont[i], CONTINENT_X, baseKnots);
    const amplitude = interp1d(eros[i], EROSION_X, ampKnots);
    height[i] = bse + peaksAndValleys(weird[i]) * amplitude;
  }

  const dx = WORLD_EXTENT / Math.max(1, resolution - 1);
  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const idx = iz * resolution + ix;
      const xL = ix > 0 ? height[idx - 1] : height[idx];
      const xR = ix < resolution - 1 ? height[idx + 1] : height[idx];
      const stepX = (ix > 0 && ix < resolution - 1) ? 2 * dx : dx;
      const gradX = (xR - xL) / Math.max(stepX, 1e-6);

      const zL = iz > 0 ? height[idx - resolution] : height[idx];
      const zR = iz < resolution - 1 ? height[idx + resolution] : height[idx];
      const stepZ = (iz > 0 && iz < resolution - 1) ? 2 * dx : dx;
      const gradZ = (zR - zL) / Math.max(stepZ, 1e-6);

      slope[idx] = Math.sqrt(gradX * gradX + gradZ * gradZ);
    }
  }

  for (let i = 0; i < n; i++) {
    const beach1 = 1.0 - smoothstep(cfg.sea_level + 1.0, cfg.sea_level + cfg.beach_width, height[i]);
    const beach2 = 1.0 - smoothstep(0.22, 0.52, slope[i]);
    const beachMask = clamp01(beach1 * beach2);
    const { biome, ruleIndex: r } = classifyBiomeCell({
      height: height[i], slope: slope[i], temp: temp[i], humid: humid[i], weird: weird[i],
      beachMask, seaLevel: cfg.sea_level, cfg,
    });
    biomeId[i] = BIOME_INDEX[biome];
    ruleIndex[i] = r;
  }

  return { height, slope, temp, humid, weird, biomeId, ruleIndex, resolution };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-biome-classifier-js.mjs`
Expected: `63 passed, 0 failed` (53 from Task 3 + 10 new: 4 length checks, `allBiomeIdsValid`,
`allRuleIndicesValid`, 2 determinism checks, the seed-sensitivity check, and the flooded-map check).

- [ ] **Step 5: Commit**

```bash
git add biome-classifier-js.js test-biome-classifier-js.mjs
git commit -m "feat(biomes): add generateGrid full per-cell pipeline (JS port, step 4/4)"
```

---

## Task 5: `biome-explainer.html` — skeleton, shared styles, overview diagram

**Files:**
- Create: `biome-explainer.html`

- [ ] **Step 1: Create the file**

Create `biome-explainer.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Biome explainer — workshop-webgpu</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --paper: #faf6ef;
    --ink: #2b2620;
    --accent: #b5502f;
    --accent-soft: #e7c9ba;
    --card: #ffffff;
    --border: #e4dccb;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: -apple-system, Segoe UI, Roboto, sans-serif;
    font-size: 16px;
    line-height: 1.5;
  }
  h1, h2, h3 {
    font-family: Georgia, 'Times New Roman', serif;
    font-weight: 700;
    margin: 0 0 8px;
  }
  header.hero {
    padding: 48px 24px 24px;
    text-align: center;
  }
  header.hero h1 { font-size: 2.2em; color: var(--accent); }
  header.hero p { max-width: 640px; margin: 8px auto 0; opacity: 0.8; }
  main {
    max-width: 980px;
    margin: 0 auto;
    padding: 0 24px 64px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
  .panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px 32px;
    box-shadow: 0 2px 10px rgba(43, 38, 32, 0.05);
  }
  .panel h2 { font-size: 1.5em; }
  .lede { opacity: 0.75; margin: 4px 0 20px; }
  .swatch {
    display: inline-block;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1px solid rgba(0,0,0,0.15);
    vertical-align: middle;
    margin-right: 6px;
  }
  .pipeline {
    display: flex;
    align-items: stretch;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .pipe-box {
    background: var(--accent-soft);
    border-radius: 10px;
    padding: 12px 14px;
    font-weight: 600;
    text-align: center;
    flex: 1 1 160px;
    font-size: 0.92em;
  }
  .pipe-box.small { font-size: 0.82em; background: #f1e9dc; }
  .pipe-box span { display: block; font-weight: 400; opacity: 0.75; font-size: 0.85em; margin-top: 4px; }
  .pipe-arrow { align-self: center; font-size: 1.4em; color: var(--accent); }
  .pipe-arrow.down { width: 100%; text-align: center; }
  .pipeline-fanout { display: flex; justify-content: center; }
  .gen-layout { display: flex; gap: 24px; flex-wrap: wrap; }
  .canvas-frame { position: relative; flex: 0 0 auto; }
  canvas { border-radius: 8px; border: 1px solid var(--border); image-rendering: pixelated; cursor: crosshair; }
  .controls { flex: 1 1 260px; display: flex; flex-direction: column; gap: 10px; }
  .control-row { display: flex; flex-direction: column; gap: 2px; font-size: 0.9em; }
  .control-row label { display: flex; justify-content: space-between; opacity: 0.85; }
  .tooltip {
    position: absolute;
    pointer-events: none;
    background: var(--ink);
    color: var(--paper);
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 0.82em;
    line-height: 1.4;
    white-space: pre;
    z-index: 10;
    transform: translate(12px, 12px);
  }
  .tooltip.hidden { display: none; }
  button.action {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    cursor: pointer;
    font-size: 0.9em;
  }
  table.ref-table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  table.ref-table th, table.ref-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  table.ref-table tr.active { background: var(--accent-soft); }
  .rule-list { display: flex; flex-direction: column; gap: 4px; font-size: 0.88em; }
  .rule-row { display: flex; gap: 10px; align-items: center; padding: 6px 8px; border-radius: 6px; }
  .rule-row.active { background: var(--accent-soft); }
  .rule-row .rule-idx { opacity: 0.5; width: 2.2em; flex: none; }
  .rule-row .rule-text { opacity: 0.85; }
  .callout { background: #f1e9dc; border-left: 3px solid var(--accent); padding: 10px 14px; border-radius: 6px; font-size: 0.88em; margin-top: 10px; }
</style>
</head>
<body>
<header class="hero">
  <h1>How a biome is born</h1>
  <p>A visual tour of workshop-webgpu's biome system: an external tool assigns a biome to every grid cell of an authored map, and the game reads that assignment to pick ground textures and gate tree/grass density. Companion to <code>docs/subsystems/biomes.md</code>.</p>
</header>
<main>
  <section class="panel" id="section-overview">
    <h2>1. How a biome is born</h2>
    <div class="pipeline">
      <div class="pipe-box">Noise fields<br><span>continentalness · erosion · weirdness · temperature · humidity</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">Height, slope &amp; beach mask<br><span>derived from the fields above</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">classify_biomes priority stack<br><span>17 ordered rules, last match wins</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">biomeIds + biomeNames<br><span>baked into &lt;map&gt;-data.json</span></div>
    </div>
    <div class="pipeline-fanout"><div class="pipe-arrow down">&darr;</div></div>
    <div class="pipeline">
      <div class="pipe-box small">terrain-loader.js<br><span>biomeAt / treeDensityAt</span></div>
      <div class="pipe-box small">terrain-textures.js<br><span>ground texture fallback</span></div>
      <div class="pipe-box small">grass-compute.js<br><span>grass density gate</span></div>
      <div class="pipe-box small">forest-placement.js<br><span>tree density gate</span></div>
    </div>
    <p class="lede" style="margin-top:20px;">Sections 2&ndash;3 below demonstrate the top half (generation, run offline by a separate tool, terrain-v3). Sections 4&ndash;5 demonstrate the bottom half (what this game actually reads at runtime).</p>
  </section>

  <section class="panel" id="section-generation">
    <h2>2. Grow a map</h2>
    <p class="lede">Loading…</p>
  </section>

  <section class="panel" id="section-rules">
    <h2>3. The priority stack</h2>
    <p class="lede">Loading…</p>
  </section>

  <section class="panel" id="section-consumption">
    <h2>4. A real exported map</h2>
    <p class="lede">Loading…</p>
  </section>

  <section class="panel" id="section-tables">
    <h2>5. Reference tables</h2>
    <p class="lede">Loading…</p>
  </section>
</main>
<script type="module">
  import * as BiomeClassifier from './biome-classifier-js.js';
  window.__biomeClassifier = BiomeClassifier; // temporary, removed once sections 2-5 wire in directly (Tasks 6-9)
  console.log('biome-classifier-js.js loaded:', Object.keys(BiomeClassifier));
</script>
</body>
</html>
```

- [ ] **Step 2: Manual verification**

Run `python serve.py`, open `http://127.0.0.1:8080/biome-explainer.html`. Confirm: page
loads with no console errors, section 1's pipeline diagram renders with boxes and
arrows, sections 2&ndash;5 show placeholder "Loading…" text, and the console logs
`biome-classifier-js.js loaded: [...]` listing all Task 1&ndash;4 exports.

- [ ] **Step 3: Commit**

```bash
git add biome-explainer.html
git commit -m "feat(biomes): add biome-explainer.html skeleton + overview diagram"
```

---

## Task 6: Section 2 — generated mini-map

**Files:**
- Modify: `biome-explainer.html`

- [ ] **Step 1: Replace the section 2 placeholder markup**

In `biome-explainer.html`, replace:

```html
  <section class="panel" id="section-generation">
    <h2>2. Grow a map</h2>
    <p class="lede">Loading…</p>
  </section>
```

with:

```html
  <section class="panel" id="section-generation">
    <h2>2. Grow a map</h2>
    <p class="lede">Move the sliders &mdash; each one is a real terrain-v3 <code>Terrain2DConfig</code> field, at its real authoring range. Everything else stays fixed at terrain-v3's own defaults.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="gen-canvas" width="128" height="128" style="width:420px;height:420px;"></canvas>
        <div id="gen-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="gen-controls"></div>
    </div>
  </section>
```

- [ ] **Step 2: Replace the bootstrap script**

Replace the `<script type="module">` block at the bottom of `biome-explainer.html`
(the one that currently just logs to console) with:

```html
<script type="module">
  import {
    BIOMES, BIOME_COLORS, DEFAULT_CONFIG, GRID_RESOLUTION, generateGrid,
  } from './biome-classifier-js.js';

  // ---- Section 2: generated mini-map ----
  const GEN_FIELDS = [
    { key: 'seed', label: 'Seed', min: 0, max: 99999, step: 1 },
    { key: 'sea_level', label: 'Sea level', min: -120, max: 120, step: 1 },
    { key: 'continentalness_period', label: 'Continent period', min: 80, max: 4000, step: 4 },
    { key: 'erosion_period', label: 'Erosion period', min: 80, max: 4000, step: 4 },
    { key: 'temperature_period', label: 'Temperature period', min: 80, max: 4000, step: 4 },
    { key: 'humidity_period', label: 'Humidity period', min: 80, max: 4000, step: 4 },
    { key: 'forest_humidity_bias', label: 'Forest humidity bias', min: -1, max: 1, step: 0.01 },
    { key: 'snow_height_start', label: 'Snow height start', min: -40, max: 240, step: 1 },
  ];

  const genConfig = { ...DEFAULT_CONFIG };
  const genCanvas = document.getElementById('gen-canvas');
  const genCtx = genCanvas.getContext('2d');
  const genTooltip = document.getElementById('gen-tooltip');
  let lastGenGrid = null;
  let genDebounceTimer = null;

  function renderGenGrid() {
    const grid = generateGrid(genConfig, GRID_RESOLUTION);
    lastGenGrid = grid;
    const img = genCtx.createImageData(GRID_RESOLUTION, GRID_RESOLUTION);
    for (let i = 0; i < grid.biomeId.length; i++) {
      const [r, g, b] = BIOME_COLORS[BIOMES[grid.biomeId[i]]];
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    genCtx.putImageData(img, 0, 0);
  }

  function scheduleGenRender() {
    clearTimeout(genDebounceTimer);
    genDebounceTimer = setTimeout(renderGenGrid, 150);
  }

  function buildGenControls() {
    const wrap = document.getElementById('gen-controls');
    wrap.innerHTML = '';
    for (const field of GEN_FIELDS) {
      const row = document.createElement('div');
      row.className = 'control-row';
      const label = document.createElement('label');
      const valueSpan = document.createElement('span');
      valueSpan.textContent = genConfig[field.key];
      label.textContent = field.label + ' ';
      label.appendChild(valueSpan);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = field.min;
      input.max = field.max;
      input.step = field.step;
      input.value = genConfig[field.key];
      input.addEventListener('input', () => {
        genConfig[field.key] = Number(input.value);
        valueSpan.textContent = input.value;
        scheduleGenRender();
      });
      row.appendChild(label);
      row.appendChild(input);
      wrap.appendChild(row);
      field._input = input;
      field._valueSpan = valueSpan;
    }
    const randomizeBtn = document.createElement('button');
    randomizeBtn.className = 'action';
    randomizeBtn.textContent = 'Randomize seed';
    randomizeBtn.addEventListener('click', () => {
      genConfig.seed = Math.floor(Math.random() * 100000);
      const seedField = GEN_FIELDS.find((f) => f.key === 'seed');
      seedField._input.value = genConfig.seed;
      seedField._valueSpan.textContent = genConfig.seed;
      renderGenGrid();
    });
    wrap.appendChild(randomizeBtn);
  }

  function genCellFromEvent(ev) {
    const rect = genCanvas.getBoundingClientRect();
    const fx = (ev.clientX - rect.left) / rect.width;
    const fz = (ev.clientY - rect.top) / rect.height;
    const ix = Math.max(0, Math.min(GRID_RESOLUTION - 1, Math.floor(fx * GRID_RESOLUTION)));
    const iz = Math.max(0, Math.min(GRID_RESOLUTION - 1, Math.floor(fz * GRID_RESOLUTION)));
    return { ix, iz, idx: iz * GRID_RESOLUTION + ix };
  }

  genCanvas.addEventListener('mousemove', (ev) => {
    if (!lastGenGrid) return;
    const { idx } = genCellFromEvent(ev);
    const biomeName = BIOMES[lastGenGrid.biomeId[idx]];
    genTooltip.classList.remove('hidden');
    genTooltip.style.left = ev.offsetX + 'px';
    genTooltip.style.top = ev.offsetY + 'px';
    genTooltip.textContent =
      `${biomeName}\nheight ${lastGenGrid.height[idx].toFixed(1)}  slope ${lastGenGrid.slope[idx].toFixed(2)}\n` +
      `temp ${lastGenGrid.temp[idx].toFixed(2)}  humid ${lastGenGrid.humid[idx].toFixed(2)}  weird ${lastGenGrid.weird[idx].toFixed(2)}`;
  });
  genCanvas.addEventListener('mouseleave', () => {
    genTooltip.classList.add('hidden');
  });

  buildGenControls();
  renderGenGrid();
</script>
```

- [ ] **Step 2: Manual verification**

Reload `http://127.0.0.1:8080/biome-explainer.html`. Confirm: section 2 renders a
128&times;128 colored biome map immediately on load, dragging any of the 8 sliders
updates the map after a short pause, "Randomize seed" changes the map immediately,
hovering the canvas shows a tooltip with biome name + raw field values that changes as
the mouse moves, and there are no console errors.

- [ ] **Step 3: Commit**

```bash
git add biome-explainer.html
git commit -m "feat(biomes): wire section 2 generated mini-map + sliders"
```

---

## Task 7: Section 3 — priority-stack panel + cross-highlight with section 2

**Files:**
- Modify: `biome-explainer.html`

- [ ] **Step 1: Replace the section 3 placeholder markup**

Replace:

```html
  <section class="panel" id="section-rules">
    <h2>3. The priority stack</h2>
    <p class="lede">Loading…</p>
  </section>
```

with:

```html
  <section class="panel" id="section-rules">
    <h2>3. The priority stack</h2>
    <p class="lede">17 ordered rules run top to bottom over every cell; whichever one matches <em>last</em> wins &mdash; hover the map above (or the real map below) to see which rule fired for a given cell.</p>
    <div class="rule-list" id="rule-list"></div>
    <div class="callout">Rule 7 (<span class="swatch" style="background:rgb(89,115,71)"></span>swamp) looks like it should apply to warm, very-wet, non-cold land &mdash; but rule 9 (dark_forest) matches every one of those cells too and runs right after it. Try hovering a very-wet, not-hot, not-cold cell above: you'll land on dark_forest, not swamp, every time. <code>swamp</code> is a real (if surprising) casualty of rule order in the source classifier.</div>
  </section>
```

- [ ] **Step 2: Add the rule list data + rendering + highlight wiring**

In the `<script type="module">` block, insert the following directly after the
`buildGenControls();` / `renderGenGrid();` lines from Task 6 (keep those two calls in
place; add this new code after them):

```js
  // ---- Section 3: priority-stack panel ----
  const RULES = [
    { index: -1, biome: 'plains', text: 'Default &mdash; no rule below matched.' },
    { index: 0, biome: 'deep_ocean', text: 'height &lt; sea level &minus; 14' },
    { index: 1, biome: 'ocean', text: 'sea level &minus; 14 &le; height &le; sea level' },
    { index: 2, biome: 'beach', text: 'beach mask &gt; 0.35 (overrides ocean/deep_ocean too)' },
    { index: 3, biome: 'desert', text: 'land &amp; hot &amp; dry' },
    { index: 4, biome: 'badlands', text: 'land &amp; hot &amp; dry &amp; weirdness &gt; 0.38 (overrides desert)' },
    { index: 5, biome: 'savanna', text: 'land &amp; hot &amp; not dry &amp; not very wet' },
    { index: 6, biome: 'jungle', text: 'land &amp; very wet &amp; hot' },
    { index: 7, biome: 'swamp', text: 'land &amp; very wet &amp; not hot (see callout below)' },
    { index: 8, biome: 'forest', text: 'land &amp; wet &amp; not cold &amp; not very wet' },
    { index: 9, biome: 'dark_forest', text: 'land &amp; wet &amp; humidity &gt; 0.25 &amp; not hot &amp; not cold (overrides forest, and in practice swamp)' },
    { index: 10, biome: 'taiga', text: 'land &amp; cold &amp; wet' },
    { index: 11, biome: 'snowy_taiga', text: 'land &amp; cold &amp; wet &amp; high (overrides taiga)' },
    { index: 12, biome: 'snowy_plains', text: 'land &amp; cold &amp; not wet' },
    { index: 13, biome: 'meadow', text: 'land &amp; not hot &amp; not cold &amp; humidity &gt; &minus;0.05 &amp; weirdness &gt; 0.28' },
    { index: 14, biome: 'windswept_hills', text: 'land &amp; steep (overrides almost everything land-based)' },
    { index: 15, biome: 'stony_peaks', text: 'land &amp; high &amp; steep (overrides windswept_hills)' },
    { index: 16, biome: 'snowy_peaks', text: 'height &gt; snow height full &amp; slope &lt; 0.80 (overrides stony_peaks)' },
  ];

  function buildRuleList() {
    const wrap = document.getElementById('rule-list');
    wrap.innerHTML = '';
    for (const rule of RULES) {
      const row = document.createElement('div');
      row.className = 'rule-row';
      row.dataset.ruleIndex = String(rule.index);
      const [r, g, b] = BIOME_COLORS[rule.biome];
      row.innerHTML =
        `<span class="rule-idx">${rule.index}</span>` +
        `<span class="swatch" style="background:rgb(${r},${g},${b})"></span>` +
        `<span class="rule-text"><strong>${rule.biome}</strong> &mdash; ${rule.text}</span>`;
      wrap.appendChild(row);
    }
  }

  function highlightRule(ruleIndex) {
    document.querySelectorAll('#rule-list .rule-row').forEach((row) => {
      row.classList.toggle('active', Number(row.dataset.ruleIndex) === ruleIndex);
    });
  }

  function clearRuleHighlight() {
    document.querySelectorAll('#rule-list .rule-row.active').forEach((row) => row.classList.remove('active'));
  }

  buildRuleList();
```

- [ ] **Step 3: Wire section 2's hover to call `highlightRule`**

In the same `<script type="module">` block, find the `genCanvas.addEventListener('mousemove', ...)`
handler added in Task 6 and add one line inside it (after the `genTooltip.textContent = ...`
assignment, before the closing `});`):

```js
    highlightRule(lastGenGrid.ruleIndex[idx]);
```

The full handler now reads:

```js
  genCanvas.addEventListener('mousemove', (ev) => {
    if (!lastGenGrid) return;
    const { idx } = genCellFromEvent(ev);
    const biomeName = BIOMES[lastGenGrid.biomeId[idx]];
    genTooltip.classList.remove('hidden');
    genTooltip.style.left = ev.offsetX + 'px';
    genTooltip.style.top = ev.offsetY + 'px';
    genTooltip.textContent =
      `${biomeName}\nheight ${lastGenGrid.height[idx].toFixed(1)}  slope ${lastGenGrid.slope[idx].toFixed(2)}\n` +
      `temp ${lastGenGrid.temp[idx].toFixed(2)}  humid ${lastGenGrid.humid[idx].toFixed(2)}  weird ${lastGenGrid.weird[idx].toFixed(2)}`;
    highlightRule(lastGenGrid.ruleIndex[idx]);
  });
```

Also update the `mouseleave` handler to clear the rule highlight:

```js
  genCanvas.addEventListener('mouseleave', () => {
    genTooltip.classList.add('hidden');
    clearRuleHighlight();
  });
```

- [ ] **Step 4: Manual verification**

Reload the page. Confirm: section 3 shows 18 rows (default + 17 rules), each with a
color swatch matching its biome; hovering section 2's canvas highlights the matching row
in section 3 and un-highlights on mouse-leave; hovering a very-wet/not-hot/not-cold cell
(try dragging humidity period down and watching for humid, warm-ish blue-green regions)
lands on the `dark_forest` row, never the `swamp` row, matching the callout text.

- [ ] **Step 5: Commit**

```bash
git add biome-explainer.html
git commit -m "feat(biomes): add section 3 priority-stack panel, cross-highlight with section 2"
```

---

## Task 8: Section 4 — real exported map viewer

**Files:**
- Modify: `biome-explainer.html`

- [ ] **Step 1: Replace the section 4 placeholder markup**

Replace:

```html
  <section class="panel" id="section-consumption">
    <h2>4. A real exported map</h2>
    <p class="lede">Loading…</p>
  </section>
```

with:

```html
  <section class="panel" id="section-consumption">
    <h2>4. A real exported map</h2>
    <p class="lede" id="consumption-caption">Loading maps/workshop/test_export-data.json&hellip;</p>
    <div class="gen-layout" id="consumption-layout" style="display:none;">
      <div class="canvas-frame">
        <canvas id="map-canvas"></canvas>
        <div id="map-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="map-legend"></div>
    </div>
  </section>
```

- [ ] **Step 2: Add the fetch, render, and hover logic**

In the `<script type="module">` block, insert the following after `buildRuleList();`
from Task 7:

```js
  // ---- Section 4: real exported map ----
  const TREE_DENSITY = {
    deep_ocean: 0.0, ocean: 0.0, beach: 0.03, desert: 0.0, badlands: 0.04, savanna: 0.20,
    plains: 0.10, forest: 0.85, dark_forest: 0.95, jungle: 0.90, swamp: 0.45, taiga: 0.70,
    snowy_taiga: 0.55, snowy_plains: 0.05, stony_peaks: 0.03, snowy_peaks: 0.0,
    windswept_hills: 0.18, meadow: 0.16,
  };
  const BIOME_MATERIAL = {
    deep_ocean: 'sand', ocean: 'sand', beach: 'beach', desert: 'desert', badlands: 'dirt', savanna: 'savanna',
    plains: 'grass', forest: 'forest', dark_forest: 'forest', jungle: 'forest', swamp: 'swamp', taiga: 'taiga',
    snowy_taiga: 'snow', snowy_plains: 'snow', stony_peaks: 'rock', snowy_peaks: 'snow',
    windswept_hills: 'gravel', meadow: 'meadow',
  };
  const FALLBACK_COLORS = {
    grass: 0x6f8f45, forest: 0x4f6d38, meadow: 0x82a84f, taiga: 0x536b48, dirt: 0x7b5a3a,
    savanna: 0x9b8a4a, swamp: 0x4b5435, sand: 0xd8be7c, beach: 0xd7c18a, desert: 0xcfae68,
    gravel: 0x808080, rock: 0x6f6c64, snow: 0xdde2df,
  };

  function bilinearGrid(grid, resolution, gx, gz) {
    const ix = Math.max(0, Math.min(resolution - 2, Math.floor(gx)));
    const iz = Math.max(0, Math.min(resolution - 2, Math.floor(gz)));
    const tx = Math.max(0, Math.min(1, gx - ix));
    const tz = Math.max(0, Math.min(1, gz - iz));
    const a = grid[iz * resolution + ix] ?? 0;
    const b = grid[iz * resolution + ix + 1] ?? a;
    const c = grid[(iz + 1) * resolution + ix] ?? a;
    const d = grid[(iz + 1) * resolution + ix + 1] ?? c;
    return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
  }

  let realMap = null;

  async function loadRealMap() {
    const caption = document.getElementById('consumption-caption');
    const layout = document.getElementById('consumption-layout');
    try {
      const res = await fetch('maps/workshop/test_export-data.json');
      if (!res.ok) throw new Error(`fetch failed (${res.status})`);
      const mapData = await res.json();
      realMap = mapData;
      caption.textContent = `maps/workshop/test_export.glb (${mapData.resolution}×${mapData.resolution} biome grid, ${mapData.worldX}×${mapData.worldZ} world units).`;
      layout.style.display = '';
      renderRealMap(mapData);
      renderMapLegend(mapData);
    } catch (err) {
      caption.textContent = `Couldn't load maps/workshop/test_export-data.json (${err.message}). Run "python serve.py" and open this page via http://, not file://. Sections 1-3 above still work without it.`;
    }
  }

  function renderRealMap(mapData) {
    const canvas = document.getElementById('map-canvas');
    const res = mapData.resolution;
    canvas.width = res;
    canvas.height = res;
    const aspect = mapData.worldZ / mapData.worldX;
    canvas.style.width = '480px';
    canvas.style.height = Math.round(480 * aspect) + 'px';
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(res, res);
    for (let i = 0; i < mapData.biomeIds.length; i++) {
      const name = mapData.biomeNames[mapData.biomeIds[i]] || 'plains';
      const [r, g, b] = BIOME_COLORS[name] || BIOME_COLORS.plains;
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    const tooltip = document.getElementById('map-tooltip');
    canvas.addEventListener('mousemove', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const gx = ((ev.clientX - rect.left) / rect.width) * (res - 1);
      const gz = ((ev.clientY - rect.top) / rect.height) * (res - 1);
      const ix = Math.max(0, Math.min(res - 1, Math.round(gx)));
      const iz = Math.max(0, Math.min(res - 1, Math.round(gz)));
      const idx = iz * res + ix;
      const biomeName = mapData.biomeNames[mapData.biomeIds[idx]] || 'plains';
      const grass = mapData.grassDensity ? bilinearGrid(mapData.grassDensity, res, gx, gz) : null;
      const tree = TREE_DENSITY[biomeName] ?? 0;
      const texture = BIOME_MATERIAL[biomeName] ?? 'grass';
      tooltip.classList.remove('hidden');
      tooltip.style.left = ev.offsetX + 'px';
      tooltip.style.top = ev.offsetY + 'px';
      tooltip.textContent =
        `${biomeName}\ntexture (fallback): ${texture}\ntree density: ${tree.toFixed(2)}` +
        (grass !== null ? `\ngrass density: ${grass.toFixed(2)}` : '');
      highlightBiomeRows(biomeName);
    });
    canvas.addEventListener('mouseleave', () => {
      tooltip.classList.add('hidden');
      clearBiomeHighlight();
    });
  }

  function renderMapLegend(mapData) {
    const wrap = document.getElementById('map-legend');
    const present = new Set();
    for (const id of mapData.biomeIds) present.add(mapData.biomeNames[id]);
    const unused = BIOMES.filter((name) => !present.has(name));
    wrap.innerHTML =
      `<p><strong>Present in this map (${present.size}/18):</strong><br>` +
      Array.from(present).map((name) => swatchLabel(name)).join(' ') + `</p>` +
      `<p><strong>Defined but unused here (${unused.length}/18):</strong><br>` +
      unused.map((name) => swatchLabel(name)).join(' ') + `</p>`;
  }

  function swatchLabel(name) {
    const [r, g, b] = BIOME_COLORS[name];
    return `<span class="swatch" style="background:rgb(${r},${g},${b})"></span>${name}`;
  }

  loadRealMap();
```

`highlightBiomeRows`/`clearBiomeHighlight` are added in Task 9 (section 5's tables are
what actually gets highlighted); Task 8's code calling them will start working once
Task 9 defines them — until then they'll throw `ReferenceError` on hover, which is
expected and fixed by the very next task. Do not skip ahead; verify Task 8's canvas
rendering/fetch/tooltip-text behavior first without hovering-triggered highlighting.

- [ ] **Step 3: Manual verification (partial — highlighting arrives in Task 9)**

Reload the page. Confirm: section 4's caption updates to the loaded-map summary, the
real map renders as a colored canvas roughly 480px wide and proportionally short (test
map is 2880&times;1248 world units, so &asymp;480&times;208px), the legend lists 7
present biomes (`deep_ocean, ocean, beach, plains, snowy_plains, stony_peaks,
windswept_hills`) and 11 unused ones. Do **not** hover the canvas yet — that will throw
in the console until Task 9 lands (expected, per Step 2's note).

- [ ] **Step 4: Commit**

```bash
git add biome-explainer.html
git commit -m "feat(biomes): wire section 4 real map viewer (fetch + render + legend)"
```

---

## Task 9: Section 5 — reference tables + cross-highlight wiring

**Files:**
- Modify: `biome-explainer.html`

- [ ] **Step 1: Replace the section 5 placeholder markup**

Replace:

```html
  <section class="panel" id="section-tables">
    <h2>5. Reference tables</h2>
    <p class="lede">Loading…</p>
  </section>
```

with:

```html
  <section class="panel" id="section-tables">
    <h2>5. Reference tables</h2>
    <p class="lede">The two lookup tables workshop-webgpu actually uses at runtime. Hover the generated map (section 2) or the real map (section 4) to highlight a row here.</p>
    <div class="gen-layout">
      <div style="flex:1 1 320px;">
        <h3>Ground texture fallback</h3>
        <table class="ref-table" id="table-material"></table>
      </div>
      <div style="flex:1 1 260px;">
        <h3>Tree density</h3>
        <table class="ref-table" id="table-density"></table>
      </div>
    </div>
  </section>
```

- [ ] **Step 2: Add the table rendering + cross-highlight functions**

In the `<script type="module">` block, insert the following after the
`function swatchLabel(name) { ... }` block from Task 8 (and before the `loadRealMap();`
call — move `loadRealMap();` to the very end of the script if it isn't already last):

```js
  // ---- Section 5: reference tables + cross-highlight ----
  function buildReferenceTables() {
    const materialTable = document.getElementById('table-material');
    materialTable.innerHTML =
      '<tr><th>Biome</th><th>Texture layer</th></tr>' +
      BIOMES.map((name) => {
        const layer = BIOME_MATERIAL[name] ?? 'grass';
        const hex = (FALLBACK_COLORS[layer] ?? 0x808080).toString(16).padStart(6, '0');
        return `<tr data-biome="${name}"><td>${swatchLabel(name)}</td><td><span class="swatch" style="background:#${hex}"></span>${layer}</td></tr>`;
      }).join('');

    const densityTable = document.getElementById('table-density');
    densityTable.innerHTML =
      '<tr><th>Biome</th><th>Tree density</th></tr>' +
      BIOMES.map((name) => {
        const density = TREE_DENSITY[name] ?? 0;
        return `<tr data-biome="${name}"><td>${swatchLabel(name)}</td><td>${density.toFixed(2)}</td></tr>`;
      }).join('');
  }

  function highlightBiomeRows(biomeName) {
    document.querySelectorAll('#table-material tr[data-biome], #table-density tr[data-biome]').forEach((row) => {
      row.classList.toggle('active', row.dataset.biome === biomeName);
    });
  }

  function clearBiomeHighlight() {
    document.querySelectorAll('#table-material tr.active, #table-density tr.active').forEach((row) => row.classList.remove('active'));
  }

  buildReferenceTables();
```

- [ ] **Step 3: Wire section 2's hover to also cross-highlight the tables**

Find the `genCanvas.addEventListener('mousemove', ...)` handler (last touched in Task 7)
and add one line right after the `highlightRule(...)` call:

```js
    highlightBiomeRows(biomeName);
```

And in its `mouseleave` handler, add a call to `clearBiomeHighlight()` alongside the
existing `clearRuleHighlight()`:

```js
  genCanvas.addEventListener('mouseleave', () => {
    genTooltip.classList.add('hidden');
    clearRuleHighlight();
    clearBiomeHighlight();
  });
```

- [ ] **Step 4: Ensure script ordering is correct, then verify**

`buildReferenceTables()` must run before `loadRealMap()` is called (so
`highlightBiomeRows`/`clearBiomeHighlight` exist before section 4's hover handlers can
call them) — confirm `loadRealMap();` is the very last statement in the script block; if
Task 8 left it earlier, move it to the end.

Reload the page. Confirm: section 5 shows two 18-row tables with swatches; hovering
section 2's canvas highlights matching rows in both tables; hovering section 4's real
map (now that Task 9's functions exist) highlights matching rows too and no longer
throws; mouse-leave on either canvas clears all highlighting (tables and rule list).

- [ ] **Step 5: Commit**

```bash
git add biome-explainer.html
git commit -m "feat(biomes): add section 5 reference tables, finish cross-highlight wiring"
```

---

## Task 10: Docs and logging

**Files:**
- Modify: `docs/subsystems/biomes.md`
- Modify: `code-map.html`
- Modify: `agent_log.csv`

- [ ] **Step 1: Link from `biomes.md`**

In `docs/subsystems/biomes.md`, find the header block:

```markdown
# Biomes

> Cross-cutting reference, not a standalone subsystem — biome data has no lazy-loaded
> module of its own. It's a per-map data grid produced by an offline authoring pipeline
> and consumed by [terrain](terrain.md) (ground texture, height/grass/tree queries) and
> [vegetation](vegetation.md) (tree placement density, grass blade density).
```

Replace it with:

```markdown
# Biomes

> Cross-cutting reference, not a standalone subsystem — biome data has no lazy-loaded
> module of its own. It's a per-map data grid produced by an offline authoring pipeline
> and consumed by [terrain](terrain.md) (ground texture, height/grass/tree queries) and
> [vegetation](vegetation.md) (tree placement density, grass blade density).
>
> For an interactive, visual walkthrough of both halves of this system (the offline
> classifier and the runtime consumers), open `../../biome-explainer.html` (via `python
> serve.py`, same as the rest of this directory).
```

- [ ] **Step 2: Add a `TOOL_LINKS` sidebar entry in `code-map.html`**

Find the `DOC_LIST.forEach(...)` rendering block (added right after `const docLinksWrap
= document.getElementById('doc-links');`):

```js
const docLinksWrap = document.getElementById('doc-links');
DOC_LIST.forEach(([file, label, group]) => {
  const a = document.createElement('a');
  a.className = 'doc-link';
  a.href = `docs/subsystems/${file}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.innerHTML = `<span class="dot" style="background:${GROUPS[group].color}"></span>${label}`;
  docLinksWrap.appendChild(a);
});
```

Add immediately after that block (same `<script>`, not a new `DOC_LIST` entry — see the
design spec's note that `DOC_LIST`'s href template assumes `docs/subsystems/`, which
doesn't fit a repo-root tool page):

```js
const TOOL_LINKS = [
  ['biome-explainer.html', 'Biome explainer (interactive)'],
];
TOOL_LINKS.forEach(([file, label]) => {
  const a = document.createElement('a');
  a.className = 'doc-link';
  a.href = file;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = label;
  docLinksWrap.appendChild(a);
});
```

- [ ] **Step 3: Manual verification**

Run `python serve.py`, open `http://127.0.0.1:8080/code-map.html`, confirm the sidebar
doc-links list now includes a "Biome explainer (interactive)" entry that opens
`biome-explainer.html` in a new tab. Open `docs/subsystems/biomes.md` in a Markdown
viewer (or GitHub) and confirm the new paragraph renders correctly.

- [ ] **Step 4: Append the `agent_log.csv` row**

Run (adjust the leading date/time to the actual moment you run this):

```bash
printf '2026-07-01T02:00,multi,"biome-explainer.html;biome-classifier-js.js;test-biome-classifier-js.mjs;docs/subsystems/biomes.md;code-map.html",Added an interactive biome-explainer.html walkthrough (JS port of terrain-v3'"'"'s noise+classifier pipeline in biome-classifier-js.js, plus the existing workshop-webgpu consumption tables) with hover cross-highlighting across a generated mini-map, the real exported map, and reference tables.\n' >> agent_log.csv
```

- [ ] **Step 5: Commit**

```bash
git add docs/subsystems/biomes.md code-map.html agent_log.csv
git commit -m "docs(biomes): link biome-explainer.html from biomes.md and code-map.html, log the addition"
```

---

## Final verification checklist

After Task 10, do one full manual pass:

- [ ] `node test-biome-classifier-js.mjs` prints `63 passed, 0 failed`.
- [ ] `python serve.py`, open `http://127.0.0.1:8080/biome-explainer.html` — no console
      errors on load.
- [ ] Section 2: drag every one of the 8 sliders, confirm the map visibly changes for
      each; "Randomize seed" changes it instantly.
- [ ] Section 2 &harr; Section 3: hovering the generated map highlights exactly one row
      in the priority-stack panel (or none, for a cell with `ruleIndex === -1`, which
      should highlight the "Default" row).
- [ ] Section 2 &harr; Section 5: hovering the generated map highlights the matching row
      in both reference tables.
- [ ] Section 4 loads the real map, shows the 7-present/11-unused legend, and hovering
      it updates the tooltip (biome, texture, tree density, grass density) and
      highlights the section 5 tables.
- [ ] Rename `maps/workshop/test_export-data.json` temporarily, reload the page, confirm
      section 4 shows the fetch-failure message while sections 1&ndash;3 still work;
      rename the file back afterward.
- [ ] `code-map.html`'s sidebar links to `biome-explainer.html`; `biomes.md` links to it
      too.
