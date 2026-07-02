# Terrain generator v4 — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `terrain-generator-v4.html`, a self-contained explainer/generator page (same format as `biome-explainer.html`) covering terrain-v3's full 2D pipeline — noise fields, height composition, erosion simulation, derived masks, biome classification, material masks — with live schema-driven sliders and per-stage canvas previews.

**Architecture:** Widen `biome-classifier-js.js`'s exports (additive only) so a new `terrain-generator-js.js` module can reuse its noise/height/biome math instead of duplicating it, then add the new stages (erosion, remaining derived masks, material masks) plus a full field schema transcribed from `terrain_v3/config.py`. `terrain-generator-v4.html` starts as a copy of `biome-explainer.html` (same CSS/shell) with its sections replaced/extended to cover the whole pipeline in real execution order, all driven by one shared config object and one `generateFullGrid()` call per regenerate.

**Tech Stack:** Vanilla ES modules, `<canvas>` 2D context, no build step, no dependencies. Node (`node --check`, plain `test-*.mjs` scripts) for testing the math module.

**Copy rule (per user instruction):** All page text (hero, section descriptions, captions, button labels) must be plain and literal — state what the pipeline stage does and what it's built from, no marketing language, no metaphors ("tour", "journey", "grow", etc.).

---

## Reference: source files being ported

All paths below are in the separate repo `G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\terrain_v3\`:

- `config.py` — `Terrain2DConfig` dataclass, `FIELD_GROUPS`, `FIELD_RANGES`, `FIELD_LABELS`.
- `stages/noise_fields.py` — already ported into `biome-classifier-js.js`.
- `stages/height_composer.py` — already ported (inline) into `biome-classifier-js.js`'s `generateGrid`.
- `stages/erosion_sim.py` — **not yet ported.** `simulate_erosion`, `flow_accumulation`, `thermal_relax`.
- `stages/derived_maps.py` — slope/beach already ported; **not yet ported:** `sea_mask`, `lake_mask` (`detect_lake_mask`), `mountain_mask`, `rock_mask`, `snow_mask`.
- `stages/material_masks.py` — **not yet ported:** `build_material_masks`.
- `stages/biome_classifier.py` — already ported (`classifyBiomeCell`).
- `preview/color_maps.py` — colormap functions (`diverging`, `signed_map`, `height_map`, `flow_map`, `slope_map`, `mask_map`) — **not yet ported.**

And in this repo:

- `workshop-webgpu/biome-classifier-js.js` — existing JS twin, 294 lines.
- `workshop-webgpu/biome-explainer.html` — existing explainer page, 540 lines.

---

## Task 1: Widen `biome-classifier-js.js`'s export surface

**Files:**
- Modify: `workshop-webgpu/biome-classifier-js.js`
- Test: `workshop-webgpu/test-biome-classifier-js.mjs` (existing file — add assertions, don't remove any)

Purely additive: add the `export` keyword to five already-existing functions/constants and export the two knot arrays. No logic changes.

- [ ] **Step 1: Write the failing test**

Find the existing test file's import line (it currently imports a subset of names) and extend it. Add this block anywhere after the existing imports/assertions in `workshop-webgpu/test-biome-classifier-js.mjs`:

```js
// --- Task 1: widened export surface (additive, biome-explainer.html unaffected) ---
import {
  interp1d, rescaleArray, peaksAndValleys, smoothstep, clamp01,
  CONTINENT_X, CONTINENT_Y, EROSION_X, EROSION_Y,
} from './biome-classifier-js.js';

assert(typeof interp1d === 'function', 'interp1d should be exported');
assert(typeof rescaleArray === 'function', 'rescaleArray should be exported');
assert(typeof peaksAndValleys === 'function', 'peaksAndValleys should be exported');
assert(typeof smoothstep === 'function', 'smoothstep should be exported');
assert(typeof clamp01 === 'function', 'clamp01should be exported'.replace('should', ' should'));
assert(Array.isArray(CONTINENT_X) && CONTINENT_X.length === 7, 'CONTINENT_X should be exported (7 knots)');
assert(Array.isArray(CONTINENT_Y) && CONTINENT_Y.length === 7, 'CONTINENT_Y should be exported (7 knots)');
assert(Array.isArray(EROSION_X) && EROSION_X.length === 5, 'EROSION_X should be exported (5 knots)');
assert(Array.isArray(EROSION_Y) && EROSION_Y.length === 5, 'EROSION_Y should be exported (5 knots)');

// Sanity-check the actual math, not just presence:
assert(Math.abs(interp1d(0.0, CONTINENT_X, CONTINENT_Y) - 4.0) < 1e-9, 'interp1d(0, CONTINENT_X, CONTINENT_Y) should land exactly on the x=0 knot (4.0)');
assert(Math.abs(peaksAndValleys(0.0) - (-1.0)) < 1e-9, 'peaksAndValleys(0) should be -1');
assert(Math.abs(peaksAndValleys(2 / 3) - 1.0) < 1e-9, 'peaksAndValleys(2/3) should be 1 (the ridge)');
assert(Math.abs(smoothstep(0, 1, 0.5) - 0.5) < 1e-9, 'smoothstep midpoint should be 0.5');
assert(clamp01(1.5) === 1 && clamp01(-0.5) === 0, 'clamp01 should clamp to [0,1]');
console.log('Task 1 (widened exports) OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node workshop-webgpu/test-biome-classifier-js.mjs`
Expected: FAIL — `SyntaxError` or `undefined` errors, because `interp1d`/`rescaleArray`/etc. are not yet exported from `biome-classifier-js.js`.

- [ ] **Step 3: Widen the exports**

In `workshop-webgpu/biome-classifier-js.js`, change these declarations (currently private, no `export` keyword) to exported:

```js
export const CONTINENT_X = [-1.0, -0.6, -0.2, 0.0, 0.3, 0.6, 1.0];
export const CONTINENT_Y = [-40.0, -22.0, -4.0, 4.0, 14.0, 32.0, 55.0];
export const EROSION_X = [-1.0, -0.5, 0.0, 0.5, 1.0];
export const EROSION_Y = [90.0, 55.0, 22.0, 7.0, 2.0];
```

```js
export function rescaleArray(values, newMin, newMax) {
```

```js
export function interp1d(x, xs, ys) {
```

```js
export function peaksAndValleys(weird) { return 1.0 - Math.abs(3.0 * Math.abs(weird) - 2.0); }
```

```js
export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(edge1 - edge0, 1e-8)));
  return t * t * (3 - 2 * t);
}
export function clamp01(v) { return Math.min(1, Math.max(0, v)); }
```

Every other line in the file stays exactly as-is — only the five `export` keyword additions and the constant declarations above.

- [ ] **Step 4: Run test to verify it passes**

Run: `node workshop-webgpu/test-biome-classifier-js.mjs`
Expected: PASS, including the pre-existing assertions (unaffected) plus the new "Task 1 (widened exports) OK" line.

- [ ] **Step 5: Commit**

```bash
cd "workshop-webgpu" && git add biome-classifier-js.js test-biome-classifier-js.mjs && git commit -m "feat(terrain-generator): widen biome-classifier-js.js exports for reuse"
```

---

## Task 2: `terrain-generator-js.js` — field schema

**Files:**
- Create: `workshop-webgpu/terrain-generator-js.js`
- Test: `workshop-webgpu/test-terrain-generator-js.mjs`

Transcribe `config.py`'s `Terrain2DConfig` defaults, `FIELD_GROUPS`, `FIELD_RANGES`, `FIELD_LABELS` into JS. This is the first content in the new file.

- [ ] **Step 1: Write the failing test**

Create `workshop-webgpu/test-terrain-generator-js.mjs`:

```js
import assert from 'node:assert';
import {
  DEFAULT_CONFIG, FIELD_GROUPS, FIELD_RANGES, fieldLabel,
} from './terrain-generator-js.js';

// --- Task 2: field schema ---
assert.strictEqual(DEFAULT_CONFIG.seed, 1337);
assert.strictEqual(DEFAULT_CONFIG.world_x, 1200.0);
assert.strictEqual(DEFAULT_CONFIG.world_z, 1200.0);
assert.strictEqual(DEFAULT_CONFIG.preview_resolution, 384);
assert.strictEqual(DEFAULT_CONFIG.sea_level, 0.0);
assert.strictEqual(DEFAULT_CONFIG.hydraulic_erosion_strength, 5.0);
assert.strictEqual(DEFAULT_CONFIG.thermal_erosion_iterations, 3);
assert.strictEqual(DEFAULT_CONFIG.lake_flow_threshold, 0.58);
assert.strictEqual(DEFAULT_CONFIG.lake_bank_height, 2.5);
assert.strictEqual(DEFAULT_CONFIG.snow_height_full, 112.0);

const groupNames = FIELD_GROUPS.map((g) => g.name);
assert.deepStrictEqual(groupNames, ['World', 'Noise Fields', 'Height Composer', 'Erosion Simulation', 'Hydrology', 'Derived Masks']);

const worldGroup = FIELD_GROUPS.find((g) => g.name === 'World');
assert.deepStrictEqual(worldGroup.fields, ['seed', 'world_x', 'world_z', 'preview_resolution', 'sea_level']);

const allFieldNames = FIELD_GROUPS.flatMap((g) => g.fields);
assert.strictEqual(allFieldNames.length, 33, 'six groups should list 33 fields total');
for (const name of allFieldNames) {
  assert.ok(name in DEFAULT_CONFIG, `${name} from FIELD_GROUPS should exist in DEFAULT_CONFIG`);
  assert.ok(name in FIELD_RANGES, `${name} should have a FIELD_RANGES entry`);
}

const [lo, hi, step] = FIELD_RANGES.preview_resolution;
assert.deepStrictEqual([lo, hi, step], [96, 1024, 32]);

assert.strictEqual(fieldLabel('snow_height_start'), 'snow start');
assert.strictEqual(fieldLabel('seed'), 'seed', 'fields with no FIELD_LABELS entry fall back to their raw name');
console.log('Task 2 (field schema) OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: FAIL — `Cannot find module './terrain-generator-js.js'`.

- [ ] **Step 3: Create the module with the field schema**

Create `workshop-webgpu/terrain-generator-js.js`:

```js
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
// default + a "may feel slow" warning banner above WARN_RESOLUTION (see Task 9), it does
// not shrink this range.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: PASS, prints "Task 2 (field schema) OK".

- [ ] **Step 5: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-js.js test-terrain-generator-js.mjs && git commit -m "feat(terrain-generator): add terrain-generator-js.js field schema"
```

---

## Task 3: `gradientMagnitude` + flow accumulation

**Files:**
- Modify: `workshop-webgpu/terrain-generator-js.js`
- Test: `workshop-webgpu/test-terrain-generator-js.mjs`

`gradientMagnitude` is shared by erosion (Task 4) and derived masks (Task 5) — a per-axis central-difference slope, parameterized by `worldX`/`worldZ` instead of the fixed `WORLD_EXTENT` the existing `generateGrid` slope loop uses. `flowAccumulation` is a direct port of `erosion_sim.py`'s D8 steepest-descent + topological accumulation.

- [ ] **Step 1: Write the failing test**

Append to `workshop-webgpu/test-terrain-generator-js.mjs`:

```js
import { gradientMagnitude, flowAccumulation } from './terrain-generator-js.js';

// --- Task 3: gradientMagnitude + flowAccumulation ---
{
  // Flat height -> zero slope everywhere.
  const flat = new Float32Array(9).fill(5.0);
  const slope = gradientMagnitude(flat, 3, 300, 300);
  for (const s of slope) assert.ok(Math.abs(s) < 1e-9, 'flat height should have zero slope');
}
{
  // Simple 3x3 ramp descending toward one corner -> single accumulation sink at the
  // lowest cell, every other cell's flow reaches it (accum sums to n at the sink).
  const res = 3;
  const height = new Float32Array([8, 7, 6, 7, 6, 5, 6, 5, 0]); // (2,2) is the lowest by far
  const { raw, norm } = flowAccumulation(height, res);
  assert.strictEqual(raw.length, 9);
  assert.ok(raw[8] >= 8, `sink cell should accumulate close to all upstream flow, got ${raw[8]}`);
  for (const r of raw) assert.ok(r >= 1, 'every cell accumulates at least itself');
  for (const n of norm) assert.ok(n >= 0 && n <= 1, 'normalized flow should be in [0,1]');
  assert.ok(norm[8] > norm[0], 'the sink should have higher normalized flow than a high corner');
}
console.log('Task 3 (gradientMagnitude + flowAccumulation) OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: FAIL — `gradientMagnitude`/`flowAccumulation` are not exported yet.

- [ ] **Step 3: Implement**

Append to `workshop-webgpu/terrain-generator-js.js`:

```js
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
// exposed so buildDerivedMaps' lake detection (Task 5) can reuse it as the sink mask
// instead of recomputing the same 8-neighbor scan a second time.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: PASS, prints "Task 3 (gradientMagnitude + flowAccumulation) OK".

- [ ] **Step 5: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-js.js test-terrain-generator-js.mjs && git commit -m "feat(terrain-generator): add gradientMagnitude and flowAccumulation"
```

---

## Task 4: erosion simulation (hydraulic + thermal)

**Files:**
- Modify: `workshop-webgpu/terrain-generator-js.js`
- Test: `workshop-webgpu/test-terrain-generator-js.mjs`

Port of `erosion_sim.py`'s `simulate_erosion` (hydraulic incision/deposition) and `thermal_relax`.

- [ ] **Step 1: Write the failing test**

Append to `workshop-webgpu/test-terrain-generator-js.mjs`:

```js
import { simulateErosion } from './terrain-generator-js.js';

// --- Task 4: simulateErosion ---
{
  const res = 5;
  const n = res * res;
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) height[i] = 10 - i * 0.3; // simple downhill ramp

  const cfg = { ...DEFAULT_CONFIG, hydraulic_erosion_strength: 0, thermal_erosion_iterations: 0 };
  const result = simulateErosion(height, res, cfg);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(result.height[i] - height[i]) < 1e-9, 'strength=0/iterations=0 should be a no-op');
    assert.ok(Math.abs(result.erosionDelta[i]) < 1e-9, 'erosionDelta should be zero when erosion is disabled');
  }

  const eroded = simulateErosion(height, res, { ...DEFAULT_CONFIG });
  let anyChanged = false;
  for (let i = 0; i < n; i++) if (Math.abs(eroded.height[i] - height[i]) > 1e-6) anyChanged = true;
  assert.ok(anyChanged, 'default erosion strength should actually change the height field');
  assert.strictEqual(eroded.flowNorm.length, n);

  const again = simulateErosion(height, res, { ...DEFAULT_CONFIG });
  for (let i = 0; i < n; i++) assert.strictEqual(eroded.height[i], again.height[i], 'erosion should be deterministic');
}
console.log('Task 4 (simulateErosion) OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: FAIL — `simulateErosion` not exported yet.

- [ ] **Step 3: Implement**

Append to `workshop-webgpu/terrain-generator-js.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: PASS, prints "Task 4 (simulateErosion) OK".

- [ ] **Step 5: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-js.js test-terrain-generator-js.mjs && git commit -m "feat(terrain-generator): add hydraulic/thermal erosion simulation"
```

---

## Task 5: derived masks (sea/lake/beach/mountain/rock/snow)

**Files:**
- Modify: `workshop-webgpu/terrain-generator-js.js`
- Test: `workshop-webgpu/test-terrain-generator-js.mjs`

Port of `derived_maps.py`'s `build_derived_maps` and `detect_lake_mask`.

- [ ] **Step 1: Write the failing test**

Append to `workshop-webgpu/test-terrain-generator-js.mjs`:

```js
import { buildDerivedMaps } from './terrain-generator-js.js';

// --- Task 5: buildDerivedMaps ---
{
  const res = 5;
  const n = res * res;
  // A bowl: low in the middle (below sea level), rising toward the edges.
  const height = new Float32Array(n);
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const dz = iz - 2, dx = ix - 2;
      height[iz * res + ix] = -10 + (dx * dx + dz * dz) * 5;
    }
  }
  const cfg = { ...DEFAULT_CONFIG, sea_level: 0 };
  const { flowNorm } = simulateErosion(height, res, { ...cfg, hydraulic_erosion_strength: 0, thermal_erosion_iterations: 0 });
  const derived = buildDerivedMaps(height, res, cfg, flowNorm);

  assert.strictEqual(derived.seaMask[12], 1, 'center cell (below sea level) should be sea');
  assert.strictEqual(derived.seaMask[0], 0, 'corner cell (well above sea level) should not be sea');
  for (const m of derived.lakeMask) assert.ok(m === 0 || m === 1, 'lake mask should be 0 or 1');
  for (const m of derived.beachMask) assert.ok(m >= 0 && m <= 1, 'beach mask should be in [0,1]');
  for (const m of derived.mountainMask) assert.ok(m >= 0 && m <= 1, 'mountain mask should be in [0,1]');
  for (const m of derived.rockMask) assert.ok(m >= 0 && m <= 1, 'rock mask should be in [0,1]');
  for (const m of derived.snowMask) assert.ok(m >= 0 && m <= 1, 'snow mask should be in [0,1]');
  assert.strictEqual(derived.slope.length, n);
}
console.log('Task 5 (buildDerivedMaps) OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: FAIL — `buildDerivedMaps` not exported yet.

- [ ] **Step 3: Implement**

Append to `workshop-webgpu/terrain-generator-js.js`:

```js
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
export function buildDerivedMaps(height, resolution, cfg, flowNorm) {
  const n = resolution * resolution;
  const slope = gradientMagnitude(height, resolution, cfg.world_x, cfg.world_z);
  const seaMask = new Float32Array(n);
  for (let i = 0; i < n; i++) seaMask[i] = height[i] <= cfg.sea_level ? 1 : 0;

  // Reuse flowAccumulation's receiver (sink = no strictly-lower neighbor) instead of
  // recomputing a separate sink scan, unlike derived_maps.py's standalone _sink_mask --
  // same semantics (a cell with no strictly-lower 8-neighbor), one fewer full grid pass.
  const { receiver } = flowAccumulation(height, resolution);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: PASS, prints "Task 5 (buildDerivedMaps) OK".

- [ ] **Step 5: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-js.js test-terrain-generator-js.mjs && git commit -m "feat(terrain-generator): add derived masks (sea/lake/beach/mountain/rock/snow)"
```

---

## Task 6: material masks

**Files:**
- Modify: `workshop-webgpu/terrain-generator-js.js`
- Test: `workshop-webgpu/test-terrain-generator-js.mjs`

Port of `material_masks.py`'s `build_material_masks`.

- [ ] **Step 1: Write the failing test**

Append to `workshop-webgpu/test-terrain-generator-js.mjs`:

```js
import { buildMaterialMasks, BIOME_INDEX } from './terrain-generator-js.js';

// --- Task 6: buildMaterialMasks ---
{
  const res = 3;
  const n = res * res;
  const height = new Float32Array(n).fill(20); // all dry land
  const cfg = { ...DEFAULT_CONFIG, sea_level: 0 };
  const derived = {
    slope: new Float32Array(n).fill(0.05),
    seaMask: new Float32Array(n).fill(0),
    lakeMask: new Float32Array(n).fill(0),
    beachMask: new Float32Array(n).fill(0),
    mountainMask: new Float32Array(n).fill(0),
    rockMask: new Float32Array(n).fill(0),
    snowMask: new Float32Array(n).fill(0),
  };
  const biomeIds = new Uint8Array(n).fill(BIOME_INDEX.forest);
  const { masks, rgba } = buildMaterialMasks(height, derived, biomeIds, cfg, res);

  for (let i = 0; i < n; i++) {
    assert.ok(masks.forest[i] > 0.9, `flat low-slope forest-biome land should be mostly forest material, got ${masks.forest[i]}`);
    assert.strictEqual(masks.water[i], 0, 'dry land should have zero water mask');
  }
  assert.strictEqual(rgba.length, n * 4, 'rgba should be one RGBA quad per cell');
  for (let i = 0; i < n; i++) assert.strictEqual(rgba[i * 4 + 3], 255, 'alpha should always be opaque');
}
console.log('Task 6 (buildMaterialMasks) OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: FAIL — `buildMaterialMasks` not exported yet.

- [ ] **Step 3: Implement**

Append to `workshop-webgpu/terrain-generator-js.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: PASS, prints "Task 6 (buildMaterialMasks) OK".

- [ ] **Step 5: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-js.js test-terrain-generator-js.mjs && git commit -m "feat(terrain-generator): add material masks"
```

---

## Task 7: `generateFullGrid` orchestration + regression parity

**Files:**
- Modify: `workshop-webgpu/terrain-generator-js.js`
- Test: `workshop-webgpu/test-terrain-generator-js.mjs`

Wires Tasks 2-6 plus the imported noise/height/biome pieces into one function the HTML page calls per regenerate. Includes a regression check against `biome-classifier-js.js`'s own `generateGrid`.

- [ ] **Step 1: Write the failing test**

Append to `workshop-webgpu/test-terrain-generator-js.mjs`:

```js
import { generateFullGrid } from './terrain-generator-js.js';
import { generateGrid } from './biome-classifier-js.js';

// --- Task 7: generateFullGrid ---
{
  const res = 32;
  const cfg = { ...DEFAULT_CONFIG, world_x: 1200, world_z: 1200, preview_resolution: res };
  const grid = generateFullGrid(cfg, res);

  for (const key of ['continentalness', 'erosion', 'weirdness', 'temperature', 'humidity',
    'targetHeight', 'height', 'erosionDelta', 'flowNorm', 'slope', 'seaMask', 'lakeMask',
    'beachMask', 'mountainMask', 'rockMask', 'snowMask', 'biomeId', 'ruleIndex']) {
    assert.ok(key in grid, `generateFullGrid result should include ${key}`);
    assert.strictEqual(grid[key].length, res * res, `${key} should be one value per cell`);
  }

  const again = generateFullGrid(cfg, res);
  for (let i = 0; i < res * res; i++) {
    assert.strictEqual(grid.height[i], again.height[i], 'generateFullGrid should be deterministic');
  }

  // Regression guard: with erosion fully disabled, Phase A's height output should match
  // biome-classifier-js.js's own generateGrid (WORLD_EXTENT=1200, same seed/knobs),
  // proving the Task 1 export-widening refactor changed nothing.
  const noErosionCfg = { ...cfg, hydraulic_erosion_strength: 0, thermal_erosion_iterations: 0 };
  const fullGrid = generateFullGrid(noErosionCfg, res);
  const legacyGrid = generateGrid({ ...DEFAULT_CONFIG, seed: cfg.seed }, res);
  for (let i = 0; i < res * res; i++) {
    assert.ok(Math.abs(fullGrid.targetHeight[i] - legacyGrid.height[i]) < 1e-4,
      `pre-erosion height should match legacy generateGrid at cell ${i}: ${fullGrid.targetHeight[i]} vs ${legacyGrid.height[i]}`);
  }
}
console.log('Task 7 (generateFullGrid) OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: FAIL — `generateFullGrid` not exported yet.

- [ ] **Step 3: Implement**

Append to `workshop-webgpu/terrain-generator-js.js`:

```js
// ---- full pipeline orchestration ----
// Runs the entire Phase A pipeline once: noise fields -> height composition -> erosion ->
// derived masks -> biome classification -> material masks. World extent is now
// cfg.world_x/cfg.world_z (unlike biome-classifier-js.js's generateGrid, which is fixed
// to WORLD_EXTENT) -- coordinates are sampled over [-world/2, world/2] on each axis to
// match generateGrid's own centering convention.
export function generateFullGrid(cfg, resolution) {
  const n = resolution * resolution;
  const cont = new Float32Array(n);
  const eros = new Float32Array(n);
  const weird = new Float32Array(n);
  const temp = new Float32Array(n);
  const humid = new Float32Array(n);

  const sampler = createFieldSampler(cfg.seed);
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

  const baseKnots = rescaleArray(CONTINENT_Y, cfg.deep_ocean_depth, cfg.far_inland_height);
  const ampKnots = rescaleArray(EROSION_Y, cfg.min_plains_amplitude, cfg.max_mountain_amplitude);
  const targetHeight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const base = interp1d(cont[i], CONTINENT_X, baseKnots);
    const amplitude = interp1d(eros[i], EROSION_X, ampKnots);
    targetHeight[i] = base + peaksAndValleys(weird[i]) * amplitude;
  }

  const { height, erosionDelta, flowRaw, flowNorm } = simulateErosion(targetHeight, resolution, cfg);
  const derived = buildDerivedMaps(height, resolution, cfg, flowNorm);

  const biomeId = new Uint8Array(n);
  const ruleIndex = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const { biome, ruleIndex: r } = classifyBiomeCell({
      height: height[i], slope: derived.slope[i], temp: temp[i], humid: humid[i], weird: weird[i],
      beachMask: derived.beachMask[i], seaLevel: cfg.sea_level, cfg,
    });
    biomeId[i] = BIOME_INDEX[biome];
    ruleIndex[i] = r;
  }

  const { masks: materialMasks, rgba: materialRgba } = buildMaterialMasks(height, derived, biomeId, cfg, resolution);

  return {
    continentalness: cont, erosion: eros, weirdness: weird, temperature: temp, humidity: humid,
    targetHeight, height, erosionDelta, flowRaw, flowNorm,
    slope: derived.slope, seaMask: derived.seaMask, lakeMask: derived.lakeMask,
    beachMask: derived.beachMask, mountainMask: derived.mountainMask,
    rockMask: derived.rockMask, snowMask: derived.snowMask,
    biomeId, ruleIndex, materialMasks, materialRgba,
    resolution,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: PASS, prints "Task 7 (generateFullGrid) OK".

- [ ] **Step 5: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-js.js test-terrain-generator-js.mjs && git commit -m "feat(terrain-generator): add generateFullGrid pipeline orchestration"
```

---

## Task 8: colormap helpers

**Files:**
- Modify: `workshop-webgpu/terrain-generator-js.js`
- Test: `workshop-webgpu/test-terrain-generator-js.mjs`

Port of `preview/color_maps.py`'s `gradient`/`diverging`/`signed_map`/`height_map`/`flow_map`/`slope_map`/`mask_map`. Each takes one scalar and returns `[r, g, b]` — DOM-free (no `ImageData`), so the HTML page loops over a grid and fills its own canvas.

- [ ] **Step 1: Write the failing test**

Append to `workshop-webgpu/test-terrain-generator-js.mjs`:

```js
import { gradientColor, divergingColor, heightColor, maskColor } from './terrain-generator-js.js';

// --- Task 8: colormap helpers ---
{
  const stops = [[0, [0, 0, 0]], [1, [255, 255, 255]]];
  assert.deepStrictEqual(gradientColor(0, stops, 0, 1), [0, 0, 0]);
  assert.deepStrictEqual(gradientColor(1, stops, 0, 1), [255, 255, 255]);
  const mid = gradientColor(0.5, stops, 0, 1);
  assert.ok(Math.abs(mid[0] - 127.5) < 1, 'midpoint should interpolate');

  const lowDiv = divergingColor(-1);
  const highDiv = divergingColor(1);
  assert.deepStrictEqual(lowDiv, [35, 72, 135]);
  assert.deepStrictEqual(highDiv, [142, 65, 45]);

  const seaColor = heightColor(-50, 0);
  const peakColor = heightColor(200, 0);
  assert.notDeepStrictEqual(seaColor, peakColor, 'height colormap should differ well below vs above sea level');

  const off = maskColor(0, [96, 190, 255]);
  const on = maskColor(1, [96, 190, 255]);
  assert.deepStrictEqual(off, [18, 22, 26]);
  assert.deepStrictEqual(on, [96, 190, 255]);
}
console.log('Task 8 (colormap helpers) OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: FAIL — colormap functions not exported yet.

- [ ] **Step 3: Implement**

Append to `workshop-webgpu/terrain-generator-js.js`:

```js
// ---- colormaps (port of preview/color_maps.py) ----
// Each function takes one scalar (+ range where relevant) and returns [r, g, b]
// (0-255 ints). No document/canvas dependency -- the HTML page loops per-cell.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: PASS, prints "Task 8 (colormap helpers) OK".

- [ ] **Step 5: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-js.js test-terrain-generator-js.mjs && git commit -m "feat(terrain-generator): add colormap helpers"
```

---

## Task 9: `terrain-generator-v4.html` — page shell

**Files:**
- Create: `workshop-webgpu/terrain-generator-v4.html` (start as a copy of `biome-explainer.html`)

No automated test — this is a visual page (same rationale as `biome-explainer.html`'s own spec). Verified manually in Task 17.

- [ ] **Step 1: Copy the existing page as a starting point**

```bash
cd "workshop-webgpu" && cp biome-explainer.html terrain-generator-v4.html
```

- [ ] **Step 2: Update the title and hero copy**

In `terrain-generator-v4.html`, replace the `<title>` line:

```html
<title>Terrain generator v4 — workshop-webgpu</title>
```

Replace the `<header class="hero">` block:

```html
<header class="hero">
  <h1>Terrain generator v4</h1>
  <p>An in-browser port of terrain-v3's terrain pipeline (<code>G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\</code>). Each section below runs one pipeline stage and exposes its real config fields as sliders. Not bit-exact with a Python run: same algorithm, different seeded PRNG.</p>
</header>
```

- [ ] **Step 3: Replace the pipeline overview diagram (section 1)**

Replace the `<section class="panel" id="section-overview">` block's inner content with a diagram covering Phases A-E. Keep the outer `<section>` tag and `<h2>` numbering scheme, replace the body:

```html
  <section class="panel" id="section-overview">
    <h2>1. Pipeline overview</h2>
    <div class="pipeline">
      <div class="pipe-box">Noise fields<br><span>continentalness, erosion, weirdness, temperature, humidity</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">Height composer<br><span>continent/erosion knot interpolation + weirdness peaks/valleys</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">Erosion simulation<br><span>hydraulic incision/deposition, thermal relaxation, D8 flow</span></div>
    </div>
    <div class="pipeline-fanout"><div class="pipe-arrow down">&darr;</div></div>
    <div class="pipeline">
      <div class="pipe-box">Derived masks<br><span>sea, lake, beach, mountain, rock, snow</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">Biome classification<br><span>17 ordered rules, last match wins</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">Material masks<br><span>grass, forest, dirt, sand, rock, snow, water</span></div>
    </div>
    <div class="pipeline-fanout"><div class="pipe-arrow down">&darr;</div></div>
    <div class="pipeline">
      <div class="pipe-box small" style="opacity:0.5; border:1px dashed var(--accent);">Paint authoring<br><span>not yet built (Phase B)</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box small" style="opacity:0.5; border:1px dashed var(--accent);">Heightfield preview<br><span>not yet built (Phase C)</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box small" style="opacity:0.5; border:1px dashed var(--accent);">Density field preview<br><span>not yet built (Phase D)</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box small" style="opacity:0.5; border:1px dashed var(--accent);">Marching cubes, water, forest, GLB export<br><span>not yet built (Phase E)</span></div>
    </div>
    <p class="lede" style="margin-top:20px;">Sections 2-7 below cover Phase A (noise fields through material masks). Section 8 shows a real exported map; section 9 lists the reference tables workshop-webgpu reads at runtime.</p>
  </section>
```

- [ ] **Step 4: Delete the old sections 2-5 bodies (kept as empty shells for Tasks 10-16)**

Remove the entire `<section class="panel" id="section-generation">` through `<section class="panel" id="section-tables">` blocks (everything between `</section>` after section-overview and the closing `</main>`), and replace with nine empty section shells:

```html
  <section class="panel" id="section-world-noise">
    <h2>2. World &amp; noise fields</h2>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="world-canvas" width="128" height="128" style="width:420px;height:420px;"></canvas>
        <div id="world-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls">
        <div class="control-row">
          <label for="world-panel-select">Panel</label>
          <select id="world-panel-select">
            <option value="continentalness">continentalness</option>
            <option value="erosion">erosion</option>
            <option value="weirdness">weirdness</option>
            <option value="temperature">temperature</option>
            <option value="humidity">humidity</option>
          </select>
        </div>
        <div id="world-controls"></div>
        <button class="action" id="world-randomize">Randomize seed</button>
      </div>
    </div>
  </section>

  <section class="panel" id="section-height">
    <h2>3. Height composer</h2>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="height-canvas" width="128" height="128" style="width:420px;height:420px;"></canvas>
        <div id="height-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="height-controls"></div>
    </div>
  </section>

  <section class="panel" id="section-erosion">
    <h2>4. Erosion &amp; hydrology</h2>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="erosion-canvas" width="128" height="128" style="width:420px;height:420px;"></canvas>
        <div id="erosion-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls">
        <div class="control-row">
          <label for="erosion-panel-select">Panel</label>
          <select id="erosion-panel-select">
            <option value="erosionDelta">erosion delta</option>
            <option value="flowNorm">flow accumulation</option>
            <option value="lakeMask">lake mask</option>
            <option value="height">eroded height</option>
          </select>
        </div>
        <div id="erosion-controls"></div>
      </div>
    </div>
  </section>

  <section class="panel" id="section-derived">
    <h2>5. Derived masks</h2>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="derived-canvas" width="128" height="128" style="width:420px;height:420px;"></canvas>
        <div id="derived-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls">
        <div class="control-row">
          <label for="derived-panel-select">Panel</label>
          <select id="derived-panel-select">
            <option value="slope">slope</option>
            <option value="seaMask">sea mask</option>
            <option value="beachMask">beach mask</option>
            <option value="mountainMask">mountain mask</option>
          </select>
        </div>
        <div id="derived-controls"></div>
      </div>
    </div>
  </section>

  <section class="panel" id="section-biome">
    <h2>6. Biome classification</h2>
    <p class="lede">17 ordered rules run top to bottom over every cell; whichever one matches <em>last</em> wins.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="biome-canvas" width="128" height="128" style="width:420px;height:420px;"></canvas>
        <div id="biome-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="rule-list"></div>
    </div>
  </section>

  <section class="panel" id="section-material">
    <h2>7. Material masks</h2>
    <p class="lede">Blended surface material from biome id, slope, and height. No dedicated controls: this stage only reads fields already exposed above.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="material-canvas" width="128" height="128" style="width:420px;height:420px;"></canvas>
        <div id="material-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="material-legend"></div>
    </div>
  </section>

  <section class="panel" id="section-consumption">
    <h2>8. A real exported map</h2>
    <div class="control-row" style="max-width:320px;">
      <label for="map-select">Map</label>
      <select id="map-select"></select>
    </div>
    <p class="lede" id="consumption-caption">Loading&hellip;</p>
    <div class="gen-layout" id="consumption-layout" style="display:none;">
      <div class="canvas-frame">
        <canvas id="map-canvas"></canvas>
        <div id="map-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="map-legend"></div>
    </div>
  </section>

  <section class="panel" id="section-tables">
    <h2>9. Reference tables</h2>
    <p class="lede">The two lookup tables workshop-webgpu actually uses at runtime.</p>
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

- [ ] **Step 5: Clear the old `<script type="module">` body**

Replace everything inside `<script type="module"> ... </script>` with just the import line (page-specific wiring gets added in Tasks 10-16):

```html
<script type="module">
  import {
    BIOMES, BIOME_COLORS, DEFAULT_CONFIG, FIELD_GROUPS, FIELD_RANGES, fieldLabel,
    generateFullGrid, divergingColor, signedColor, heightColor, flowColor, slopeColor, maskColor,
  } from './terrain-generator-js.js';

  const genConfig = { ...DEFAULT_CONFIG, preview_resolution: 128 };
  const WARN_RESOLUTION = 256; // above this, show a "may feel slow" note (Task 10)
  let lastGrid = null;
  let regenTimer = null;

  function regenerate() {
    lastGrid = generateFullGrid(genConfig, genConfig.preview_resolution);
    for (const redraw of REDRAW_CALLBACKS) redraw(lastGrid);
  }

  function scheduleRegenerate() {
    clearTimeout(regenTimer);
    regenTimer = setTimeout(regenerate, 150);
  }

  const REDRAW_CALLBACKS = [];
</script>
```

- [ ] **Step 6: Verify the page loads without console errors**

Run: `python workshop-webgpu/serve.py 8080` (background), then open `http://127.0.0.1:8080/terrain-generator-v4.html` in a browser.
Expected: page renders the hero + pipeline diagram + nine empty section shells, no console errors (the `regenerate()`/`scheduleRegenerate()` functions exist but nothing calls them yet — that's fine, later tasks wire them up).

- [ ] **Step 7: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): add terrain-generator-v4.html page shell"
```

---

## Task 10: wire section 2 — World & noise fields

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

- [ ] **Step 1: Add the World + Noise Fields slider builder and canvas renderer**

Inside the `<script type="module">` block, after the `REDRAW_CALLBACKS` declaration, add:

```js
  // ---- shared slider-builder (reused by sections 2-5) ----
  function buildGroupControls(container, groupNames, onChange) {
    container.innerHTML = '';
    for (const group of FIELD_GROUPS) {
      if (!groupNames.includes(group.name)) continue;
      const heading = document.createElement('h3');
      heading.textContent = group.name;
      heading.style.fontSize = '0.95em';
      container.appendChild(heading);
      for (const name of group.fields) {
        const [min, max, step] = FIELD_RANGES[name];
        const row = document.createElement('div');
        row.className = 'control-row';
        const label = document.createElement('label');
        const valueSpan = document.createElement('span');
        valueSpan.textContent = genConfig[name];
        label.textContent = fieldLabel(name) + ' ';
        label.appendChild(valueSpan);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min; input.max = max; input.step = step;
        input.value = genConfig[name];
        input.addEventListener('input', () => {
          genConfig[name] = Number(input.value);
          valueSpan.textContent = input.value;
          onChange();
          scheduleRegenerate();
        });
        row.appendChild(label);
        row.appendChild(input);
        container.appendChild(row);
      }
    }
  }

  function drawScalarPanel(canvas, tooltipEl, grid, field, colorFn, extraLabel) {
    const res = grid.resolution;
    canvas.width = res; canvas.height = res;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(res, res);
    const values = grid[field];
    for (let i = 0; i < values.length; i++) {
      const [r, g, b] = colorFn(values[i]);
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const fx = (ev.clientX - rect.left) / rect.width;
      const fz = (ev.clientY - rect.top) / rect.height;
      const ix = Math.max(0, Math.min(res - 1, Math.floor(fx * res)));
      const iz = Math.max(0, Math.min(res - 1, Math.floor(fz * res)));
      const idx = iz * res + ix;
      tooltipEl.classList.remove('hidden');
      tooltipEl.style.left = ev.offsetX + 'px';
      tooltipEl.style.top = ev.offsetY + 'px';
      tooltipEl.textContent = (extraLabel ?? field) + ': ' + values[idx].toFixed(3);
    };
    canvas.onmouseleave = () => tooltipEl.classList.add('hidden');
  }

  // ---- section 2: World & noise fields ----
  const worldCanvas = document.getElementById('world-canvas');
  const worldTooltip = document.getElementById('world-tooltip');
  const worldPanelSelect = document.getElementById('world-panel-select');
  buildGroupControls(document.getElementById('world-controls'), ['World', 'Noise Fields'], () => {});
  document.getElementById('world-randomize').addEventListener('click', () => {
    genConfig.seed = Math.floor(Math.random() * 100000);
    buildGroupControls(document.getElementById('world-controls'), ['World', 'Noise Fields'], () => {});
    regenerate();
  });
  worldPanelSelect.addEventListener('change', () => { if (lastGrid) drawWorldPanel(lastGrid); });
  function drawWorldPanel(grid) {
    drawScalarPanel(worldCanvas, worldTooltip, grid, worldPanelSelect.value, divergingColor);
  }
  REDRAW_CALLBACKS.push(drawWorldPanel);
```

- [ ] **Step 2: Trigger the first regenerate at the end of the script**

Add at the very end of the `<script type="module">` block (after all section-wiring code from this and later tasks):

```js
  regenerate();
```

(This single call goes at the end of the whole script, added once now and left in place as later tasks add more `REDRAW_CALLBACKS` entries above it.)

- [ ] **Step 3: Verify in the browser**

Reload `http://127.0.0.1:8080/terrain-generator-v4.html`. Expected: section 2 shows a 128x128 diverging-colored canvas, sliders for World + Noise Fields groups, dragging a slider redraws the canvas after ~150ms, the panel-select dropdown switches between the five noise channels, hovering shows raw values.

- [ ] **Step 4: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): wire section 2 (world & noise fields)"
```

---

## Task 11: wire section 3 — Height composer

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

- [ ] **Step 1: Add height section wiring**

Insert after Task 10's `REDRAW_CALLBACKS.push(drawWorldPanel);` line:

```js
  // ---- section 3: Height composer ----
  const heightCanvas = document.getElementById('height-canvas');
  const heightTooltip = document.getElementById('height-tooltip');
  buildGroupControls(document.getElementById('height-controls'), ['Height Composer'], () => {});
  function drawHeightPanel(grid) {
    drawScalarPanel(heightCanvas, heightTooltip, grid, 'targetHeight',
      (v) => heightColor(v, genConfig.sea_level), 'pre-erosion height');
  }
  REDRAW_CALLBACKS.push(drawHeightPanel);
```

- [ ] **Step 2: Verify in the browser**

Reload the page. Expected: section 3 shows a height-colored canvas (blue low, tan/green mid, pale high) and Height Composer sliders that regenerate the whole page on change.

- [ ] **Step 3: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): wire section 3 (height composer)"
```

---

## Task 12: wire section 4 — Erosion & hydrology

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

- [ ] **Step 1: Add erosion section wiring**

Insert after Task 11's `REDRAW_CALLBACKS.push(drawHeightPanel);` line:

```js
  // ---- section 4: Erosion & hydrology ----
  const erosionCanvas = document.getElementById('erosion-canvas');
  const erosionTooltip = document.getElementById('erosion-tooltip');
  const erosionPanelSelect = document.getElementById('erosion-panel-select');
  buildGroupControls(document.getElementById('erosion-controls'), ['Erosion Simulation', 'Hydrology'], () => {});
  erosionPanelSelect.addEventListener('change', () => { if (lastGrid) drawErosionPanel(lastGrid); });
  function drawErosionPanel(grid) {
    const field = erosionPanelSelect.value;
    let colorFn;
    if (field === 'flowNorm') colorFn = flowColor;
    else if (field === 'lakeMask') colorFn = (v) => maskColor(v, [58, 150, 190]);
    else if (field === 'height') colorFn = (v) => heightColor(v, genConfig.sea_level);
    else {
      let maxAbs = 1;
      for (const d of grid.erosionDelta) if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
      colorFn = (v) => signedColor(v, maxAbs);
    }
    drawScalarPanel(erosionCanvas, erosionTooltip, grid, field, colorFn);
  }
  REDRAW_CALLBACKS.push(drawErosionPanel);
```

- [ ] **Step 2: Verify in the browser**

Reload the page. Expected: section 4 shows a canvas, panel-select switches between erosion delta / flow accumulation / lake mask / eroded height, Erosion Simulation + Hydrology sliders regenerate on change (e.g. dragging `hydraulic_erosion_strength` to 0 should visibly flatten the erosion-delta panel toward the signed colormap's midpoint color).

- [ ] **Step 3: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): wire section 4 (erosion & hydrology)"
```

---

## Task 13: wire section 5 — Derived masks

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

- [ ] **Step 1: Add derived-masks section wiring**

Insert after Task 12's `REDRAW_CALLBACKS.push(drawErosionPanel);` line:

```js
  // ---- section 5: Derived masks ----
  const derivedCanvas = document.getElementById('derived-canvas');
  const derivedTooltip = document.getElementById('derived-tooltip');
  const derivedPanelSelect = document.getElementById('derived-panel-select');
  buildGroupControls(document.getElementById('derived-controls'), ['Derived Masks'], () => {});
  derivedPanelSelect.addEventListener('change', () => { if (lastGrid) drawDerivedPanel(lastGrid); });
  const DERIVED_MASK_COLORS = {
    seaMask: [60, 130, 220], beachMask: [224, 205, 130], mountainMask: [214, 160, 82],
  };
  function drawDerivedPanel(grid) {
    const field = derivedPanelSelect.value;
    const colorFn = field === 'slope'
      ? (v) => {
        let maxSlope = 1.2;
        for (const s of grid.slope) if (s > maxSlope) maxSlope = s;
        return slopeColor(v, maxSlope);
      }
      : (v) => maskColor(v, DERIVED_MASK_COLORS[field]);
    drawScalarPanel(derivedCanvas, derivedTooltip, grid, field, colorFn);
  }
  REDRAW_CALLBACKS.push(drawDerivedPanel);
```

- [ ] **Step 2: Verify in the browser**

Reload the page. Expected: section 5 shows slope/sea/beach/mountain mask panels via the dropdown, Derived Masks sliders (`beach_width`, `rock_slope_start/full`, `snow_height_start/full`, `forest_humidity_bias`) regenerate on change.

- [ ] **Step 3: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): wire section 5 (derived masks)"
```

---

## Task 14: wire section 6 — Biome classification

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

Reuses the rule-list content from the old `biome-explainer.html` section 3 (the `RULES` array), now driven by `generateFullGrid`'s output instead of the old simplified `generateGrid`.

- [ ] **Step 1: Add the biome section wiring**

Insert after Task 13's `REDRAW_CALLBACKS.push(drawDerivedPanel);` line:

```js
  // ---- section 6: Biome classification ----
  const RULES = [
    { index: -1, biome: 'plains', text: 'Default. No rule below matched.' },
    { index: 0, biome: 'deep_ocean', text: 'height &lt; sea level &minus; 14' },
    { index: 1, biome: 'ocean', text: 'sea level &minus; 14 &le; height &le; sea level' },
    { index: 2, biome: 'beach', text: 'beach mask &gt; 0.35 (overrides ocean/deep_ocean too)' },
    { index: 3, biome: 'desert', text: 'land &amp; hot &amp; dry' },
    { index: 4, biome: 'badlands', text: 'land &amp; hot &amp; dry &amp; weirdness &gt; 0.38 (overrides desert)' },
    { index: 5, biome: 'savanna', text: 'land &amp; hot &amp; not dry &amp; not very wet' },
    { index: 6, biome: 'jungle', text: 'land &amp; very wet &amp; hot' },
    { index: 7, biome: 'swamp', text: 'land &amp; very wet &amp; not hot' },
    { index: 8, biome: 'forest', text: 'land &amp; wet &amp; not cold &amp; not very wet' },
    { index: 9, biome: 'dark_forest', text: 'land &amp; wet &amp; humidity &gt; 0.25 &amp; not hot &amp; not cold (overrides forest, and swamp)' },
    { index: 10, biome: 'taiga', text: 'land &amp; cold &amp; wet' },
    { index: 11, biome: 'snowy_taiga', text: 'land &amp; cold &amp; wet &amp; high (overrides taiga)' },
    { index: 12, biome: 'snowy_plains', text: 'land &amp; cold &amp; not wet' },
    { index: 13, biome: 'meadow', text: 'land &amp; not hot &amp; not cold &amp; humidity &gt; &minus;0.05 &amp; weirdness &gt; 0.28' },
    { index: 14, biome: 'windswept_hills', text: 'land &amp; steep (overrides almost everything land-based)' },
    { index: 15, biome: 'stony_peaks', text: 'land &amp; high &amp; steep (overrides windswept_hills)' },
    { index: 16, biome: 'snowy_peaks', text: 'height &gt; snow height full &amp; slope &lt; 0.80 (overrides stony_peaks)' },
  ];

  function swatchLabel(name) {
    const [r, g, b] = BIOME_COLORS[name];
    return `<span class="swatch" style="background:rgb(${r},${g},${b})"></span>${name}`;
  }

  function buildRuleList() {
    const wrap = document.getElementById('rule-list');
    wrap.innerHTML = '';
    for (const rule of RULES) {
      const row = document.createElement('div');
      row.className = 'rule-row';
      row.dataset.ruleIndex = String(rule.index);
      row.innerHTML = `<span class="rule-idx">${rule.index}</span>${swatchLabel(rule.biome)} <span class="rule-text">${rule.text}</span>`;
      wrap.appendChild(row);
    }
  }
  buildRuleList();

  function highlightRule(ruleIndex) {
    document.querySelectorAll('#rule-list .rule-row').forEach((row) => {
      row.classList.toggle('active', Number(row.dataset.ruleIndex) === ruleIndex);
    });
  }

  const biomeCanvas = document.getElementById('biome-canvas');
  const biomeTooltip = document.getElementById('biome-tooltip');
  function drawBiomePanel(grid) {
    const res = grid.resolution;
    biomeCanvas.width = res; biomeCanvas.height = res;
    const ctx = biomeCanvas.getContext('2d');
    const img = ctx.createImageData(res, res);
    for (let i = 0; i < grid.biomeId.length; i++) {
      const [r, g, b] = BIOME_COLORS[BIOMES[grid.biomeId[i]]];
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    biomeCanvas.onmousemove = (ev) => {
      const rect = biomeCanvas.getBoundingClientRect();
      const fx = (ev.clientX - rect.left) / rect.width;
      const fz = (ev.clientY - rect.top) / rect.height;
      const ix = Math.max(0, Math.min(res - 1, Math.floor(fx * res)));
      const iz = Math.max(0, Math.min(res - 1, Math.floor(fz * res)));
      const idx = iz * res + ix;
      const biomeName = BIOMES[grid.biomeId[idx]];
      biomeTooltip.classList.remove('hidden');
      biomeTooltip.style.left = ev.offsetX + 'px';
      biomeTooltip.style.top = ev.offsetY + 'px';
      biomeTooltip.textContent = biomeName + '\nrule ' + grid.ruleIndex[idx];
      highlightRule(grid.ruleIndex[idx]);
    };
    biomeCanvas.onmouseleave = () => { biomeTooltip.classList.add('hidden'); highlightRule(-99); };
  }
  REDRAW_CALLBACKS.push(drawBiomePanel);
```

- [ ] **Step 2: Verify in the browser**

Reload the page. Expected: section 6 shows the biome-colored canvas, the 17-rule list, hovering the canvas highlights the matching rule row.

- [ ] **Step 3: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): wire section 6 (biome classification)"
```

---

## Task 15: wire section 7 — Material masks

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

- [ ] **Step 1: Add material section wiring**

Insert after Task 14's `REDRAW_CALLBACKS.push(drawBiomePanel);` line:

```js
  // ---- section 7: Material masks ----
  const materialCanvas = document.getElementById('material-canvas');
  const materialTooltip = document.getElementById('material-tooltip');
  const MATERIAL_LEGEND_COLORS = {
    grass: [92, 156, 72], forest: [50, 104, 54], dirt: [128, 94, 62],
    sand: [210, 190, 122], rock: [126, 126, 132], snow: [235, 241, 246], water: [28, 66, 130],
  };
  function drawMaterialPanel(grid) {
    const res = grid.resolution;
    materialCanvas.width = res; materialCanvas.height = res;
    const ctx = materialCanvas.getContext('2d');
    const img = ctx.createImageData(res, res);
    img.data.set(grid.materialRgba);
    ctx.putImageData(img, 0, 0);
    materialCanvas.onmousemove = (ev) => {
      const rect = materialCanvas.getBoundingClientRect();
      const fx = (ev.clientX - rect.left) / rect.width;
      const fz = (ev.clientY - rect.top) / rect.height;
      const ix = Math.max(0, Math.min(res - 1, Math.floor(fx * res)));
      const iz = Math.max(0, Math.min(res - 1, Math.floor(fz * res)));
      const idx = iz * res + ix;
      const parts = Object.entries(grid.materialMasks).map(([k, arr]) => `${k}: ${arr[idx].toFixed(2)}`);
      materialTooltip.classList.remove('hidden');
      materialTooltip.style.left = ev.offsetX + 'px';
      materialTooltip.style.top = ev.offsetY + 'px';
      materialTooltip.textContent = parts.join('\n');
    };
    materialCanvas.onmouseleave = () => materialTooltip.classList.add('hidden');
  }
  REDRAW_CALLBACKS.push(drawMaterialPanel);

  const materialLegend = document.getElementById('material-legend');
  materialLegend.innerHTML = Object.entries(MATERIAL_LEGEND_COLORS).map(([name, [r, g, b]]) =>
    `<p><span class="swatch" style="background:rgb(${r},${g},${b})"></span>${name}</p>`).join('');
```

- [ ] **Step 2: Verify in the browser**

Reload the page. Expected: section 7 shows the blended material-color canvas and a swatch legend, hovering shows per-material weights for that cell.

- [ ] **Step 3: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): wire section 7 (material masks)"
```

---

## Task 16: wire sections 8-9 — real exported map + reference tables

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

Ports the unchanged logic from the old `biome-explainer.html` sections 4-5 (map loading, cross-highlighting, reference tables) — same code, updated to this page's element IDs where they differ (they don't — IDs were kept identical in Task 9's shell).

- [ ] **Step 1: Add sections 8-9 wiring**

Task 9 Step 5 cleared the entire old script body, so `bilinearGrid`, `MAP_FILES`, `TREE_DENSITY`, `BIOME_MATERIAL`, `FALLBACK_COLORS`, `initMapSelect`, `loadRealMap`, `renderRealMap`, `renderMapLegend`, `buildReferenceTables`, `highlightBiomeRows`, `clearBiomeHighlight` no longer exist in `terrain-generator-v4.html` and must be re-added now.

Insert after Task 15's `materialLegend.innerHTML = ...` line: copy `biome-explainer.html`'s lines 371-533 (from the `bilinearGrid` comment through the closing brace of `clearBiomeHighlight`) verbatim, **except** omit the `function swatchLabel(name) { ... }` block (lines 499-502 in `biome-explainer.html`) — Task 14 already defined `swatchLabel` for section 6, and a second top-level `function swatchLabel` declaration in the same module throws `SyntaxError: Identifier 'swatchLabel' has already been declared`. Every other copied function (`renderMapLegend`, `buildReferenceTables`, etc.) calls `swatchLabel(...)`, which still resolves correctly to Task 14's definition since both live in the same module scope.

After the copied block, add:

```js
  initMapSelect();
  loadRealMap();
  buildReferenceTables();
```

- [ ] **Step 2: Verify in the browser**

Reload the page. Expected: section 8 loads `test_export` by default, the map picker dropdown switches maps, hovering shows biome/texture/tree/grass density; section 9 shows both reference tables; hovering any of sections 6/8/9 cross-highlights matching rows (same as the original `biome-explainer.html` behavior).

- [ ] **Step 3: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): wire sections 8-9 (real map + reference tables)"
```

---

## Task 17: resolution warning banner + full manual verification pass

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

- [ ] **Step 1: Add the "may feel slow" banner**

In the section 2 controls block (inside `buildGroupControls`'s call site or right after it in Task 10's wiring), add a banner element and its update logic. In the HTML shell (Task 9, Step 4's section-world-noise block), add right after the `<h2>`:

```html
    <p class="callout hidden" id="resolution-warning">Preview resolution is above 256 — dragging sliders may feel slow.</p>
```

In the script (after Task 10's `buildGroupControls` call for World/Noise Fields), add:

```js
  function updateResolutionWarning() {
    document.getElementById('resolution-warning').classList.toggle('hidden', genConfig.preview_resolution <= WARN_RESOLUTION);
  }
  updateResolutionWarning();
  REDRAW_CALLBACKS.push(updateResolutionWarning);
```

- [ ] **Step 2: Run the full test suite**

Run: `node workshop-webgpu/test-biome-classifier-js.mjs && node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: both print all their "OK" lines with no assertion errors.

- [ ] **Step 3: Manual verification pass**

With `python workshop-webgpu/serve.py 8080` running, open `http://127.0.0.1:8080/terrain-generator-v4.html` and confirm:
- All 9 sections render with no console errors.
- Dragging `preview_resolution` above 256 shows the warning banner; below, it hides.
- Dragging any slider in any section redraws every section's canvas (since all sections share `generateFullGrid`'s output) after the debounce.
- Section 6 (biome) hover-highlights the matching rule row.
- Section 8 loads a real map and its dropdown switches maps.
- Sections 6/8/9 cross-highlight on hover.

- [ ] **Step 4: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): add resolution warning banner"
```

---

## Task 18: docs and logging

**Files:**
- Modify: `workshop-webgpu/docs/subsystems/biomes.md`
- Modify: `workshop-webgpu/code-map.html`
- Modify: `workshop-webgpu/agent_log.csv`

- [ ] **Step 1: Link from `biomes.md`**

Open `workshop-webgpu/docs/subsystems/biomes.md`, find the existing link/mention of `biome-explainer.html` near the top, and add a line directly after it:

```markdown
[terrain-generator-v4.html](../../terrain-generator-v4.html) covers the same generation
pipeline in more depth (erosion simulation, sea/lake/mountain/rock/snow masks, material
masks) with the full `config.py` field surface exposed as sliders.
```

- [ ] **Step 2: Add to `code-map.html`'s `TOOL_LINKS`**

In `workshop-webgpu/code-map.html`, find:

```js
const TOOL_LINKS = [
  ['biome-explainer.html', 'Biome explainer (interactive)'],
];
```

Change to:

```js
const TOOL_LINKS = [
  ['biome-explainer.html', 'Biome explainer (interactive)'],
  ['terrain-generator-v4.html', 'Terrain generator v4 (interactive)'],
];
```

- [ ] **Step 3: Append the `agent_log.csv` row**

Append one row to `workshop-webgpu/agent_log.csv` (match the existing column order `date,subsystem,files,summary`; quote the `files` field since it contains commas):

```csv
2026-07-02T00:00,terrain,"terrain-generator-v4.html;terrain-generator-js.js;biome-classifier-js.js;test-terrain-generator-js.mjs;docs/subsystems/biomes.md;code-map.html",Added terrain-generator-v4.html (Phase A of a port of terrain-v3's pipeline into biome-explainer.html's format): noise fields through material masks, live schema-driven sliders, ported erosion simulation and remaining derived/material masks in terrain-generator-js.js.
```

- [ ] **Step 4: Commit**

```bash
cd "workshop-webgpu" && git add docs/subsystems/biomes.md code-map.html agent_log.csv && git commit -m "docs(terrain-generator): link terrain-generator-v4.html from biomes.md and code-map.html"
```

---

## Plan self-review notes

- **Spec coverage:** every Phase A stage from the design spec (noise, height, erosion, derived masks, biome, material masks) has a task (3-8 for the math, 10-15 for the wiring); the schema/sliders requirement is Task 2 + `buildGroupControls`; the shared-pipeline-run requirement is Task 7's `generateFullGrid` + Task 9's single `regenerate()`/`scheduleRegenerate()`; the resolution-warning requirement is Task 17; docs/logging requirements are Task 18.
- **Non-goals respected:** no task adds paint authoring, density-field preview, heightfield viewport, or marching cubes/water/forest/export — the Task 9 pipeline diagram explicitly marks those as not-yet-built.
- **Copy style:** Task 9's hero/section text is declarative (what the page does, what it's built from), not narrative/marketing — matches the no-hypespeak instruction.
