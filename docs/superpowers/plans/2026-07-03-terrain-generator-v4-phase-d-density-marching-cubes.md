# Terrain generator v4 Phase D: density field + marching cubes + map export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `node-density` placeholder in `terrain-generator-v4.html` with a real panel that ports terrain-v3's volumetric density-field pipeline, extracts a smooth mesh from it via a from-scratch JS marching-cubes implementation, renders it in its own Three.js viewport, and can export the result as a real playable map into `maps/`.

**Architecture:** New pure functions land in `terrain-generator-js.js` (3D value noise, density field, marching cubes, grass density table) following the file's existing "hand-synced math twin of the Python pipeline" convention. `terrain-generator-v4.html` gets a new `section-density` panel wired the same way `section-heightfield` already is (own Three.js scene/camera/OrbitControls, own resolution field, debounced rebuild). Export is a new client-side GLTFExporter call plus a new `/api/save-map` endpoint in `serve.py`, mirroring the existing `/api/save-family` endpoint.

**Tech Stack:** Vanilla JS ES modules, Three.js r0.184 (WebGPURenderer, OrbitControls, GLTFExporter — all already available via the page's existing `three`/`three/addons` importmap), Python 3 stdlib `http.server` (serve.py).

Full design context: `docs/superpowers/specs/2026-07-03-terrain-generator-v4-phase-d-density-marching-cubes-design.md`.

---

## Task 1: Export the existing 2D noise primitives

`buildLattice3D`/`fbm3` (Task 2) need `mulberry32`, `hashSeed`, and `fade` from
`biome-classifier-js.js`, which currently are module-private (no `export` keyword).

**Files:**
- Modify: `biome-classifier-js.js:114,124,130`
- Test: `test-terrain-generator-js.mjs` (append)

- [ ] **Step 1: Add `export` to the three helpers**

In `biome-classifier-js.js`, change:
```js
function mulberry32(seed) {
```
to:
```js
export function mulberry32(seed) {
```
Change:
```js
function hashSeed(...parts) {
```
to:
```js
export function hashSeed(...parts) {
```
Change:
```js
function fade(t) { return t * t * (3.0 - 2.0 * t); }
```
to:
```js
export function fade(t) { return t * t * (3.0 - 2.0 * t); }
```

- [ ] **Step 2: Verify nothing else broke**

Run: `node test-biome-classifier-js.mjs`
Expected: all existing assertions still pass (this is a pure additive change — behavior is identical, only visibility changed).

- [ ] **Step 3: Commit**

```bash
git add biome-classifier-js.js
git commit -m "refactor: export mulberry32/hashSeed/fade for reuse by terrain-generator-js.js's 3D noise"
```

---

## Task 2: 3D value noise (`buildLattice3D`, `sampleLattice3D`, `createDensityNoiseSampler`)

Ports `_value_noise3`/`_fbm3` from `volumetric_mesh.py` — a trilinear extension of
`biome-classifier-js.js`'s existing 2D lattice noise, sized to the actual extent each
generation needs (not a fixed constant, since `world_x`/`world_z`/`y_min`/`y_max` are all
independently configurable).

**Files:**
- Modify: `terrain-generator-js.js` (append near the bottom, after the heightfield mesh section)
- Test: `test-terrain-generator-js.mjs` (append)

- [ ] **Step 1: Write the failing test**

Append to `test-terrain-generator-js.mjs`:

```js
// --- Task 1 (Phase D): 3D value noise ---
{
  const sampler = createDensityNoiseSampler();
  const v1 = sampler.fbm3(42, 100, 400, 300, 400, 10, 20, 30);
  ok(typeof v1 === 'number' && v1 >= -1 && v1 <= 1, '1 (Phase D): fbm3 returns a number in [-1, 1]');

  const sampler2 = createDensityNoiseSampler();
  const v2 = sampler2.fbm3(42, 100, 400, 300, 400, 10, 20, 30);
  ok(v1 === v2, '1 (Phase D): fbm3 is deterministic for the same seed/period/point');

  const v3 = sampler2.fbm3(43, 100, 400, 300, 400, 10, 20, 30);
  ok(v1 !== v3, '1 (Phase D): fbm3 differs for a different seed');

  const vSame = sampler2.fbm3(42, 100, 400, 300, 400, 10, 20, 30);
  ok(v1 === vSame, '1 (Phase D): repeated calls on the same sampler instance are cached/deterministic');
}
```

Add `createDensityNoiseSampler` to the import list at the top of the file (it will not
exist yet, causing the run below to fail).

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-terrain-generator-js.mjs`
Expected: fails with `createDensityNoiseSampler is not a function` (or an import error), since it doesn't exist yet.

- [ ] **Step 3: Implement `buildLattice3D`, `sampleLattice3D`, `createDensityNoiseSampler`**

In `terrain-generator-js.js`, change the import line to also pull in the newly-exported
helpers:

```js
import {
  BIOMES, BIOME_INDEX, BIOME_COLORS, createFieldSampler, classifyBiomeCell,
  interp1d, rescaleArray, peaksAndValleys, smoothstep, clamp01,
  CONTINENT_X, CONTINENT_Y, EROSION_X, EROSION_Y,
  mulberry32, hashSeed, fade,
} from './biome-classifier-js.js';
```

Append this new section near the end of the file (after the heightfield mesh section,
before the colormaps section is fine, or at the very end — anywhere at module scope):

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-terrain-generator-js.mjs`
Expected: `Task 1 (Phase D)` assertions all pass.

- [ ] **Step 5: Commit**

```bash
git add terrain-generator-js.js test-terrain-generator-js.mjs
git commit -m "feat(terrain): port volumetric_mesh.py's 3D value noise (buildLattice3D/fbm3)"
```

---

## Task 3: Density config schema

Ports `DensityPreviewConfig`/`DENSITY_FIELD_RANGES`/`DENSITY_FIELD_LABELS` from
`density_config.py` (minus `slice_y`/`cross_x`/`cross_z`/`surface_thickness`, which only
the dropped 2D-slice preview used).

**Files:**
- Modify: `terrain-generator-js.js` (append)
- Test: `test-terrain-generator-js.mjs` (append)

- [ ] **Step 1: Write the failing test**

```js
// --- Task 2 (Phase D): density config schema ---
ok(DENSITY_DEFAULT_CONFIG.density_resolution === 96, '2 (Phase D): DENSITY_DEFAULT_CONFIG.density_resolution matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.y_min === -96.0, '2 (Phase D): DENSITY_DEFAULT_CONFIG.y_min matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.y_max === 192.0, '2 (Phase D): DENSITY_DEFAULT_CONFIG.y_max matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.warp_period === 187.0, '2 (Phase D): DENSITY_DEFAULT_CONFIG.warp_period matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.cave_threshold === 0.55, '2 (Phase D): DENSITY_DEFAULT_CONFIG.cave_threshold matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.floor_thickness === 4.0, '2 (Phase D): DENSITY_DEFAULT_CONFIG.floor_thickness matches density_config.py');

const densityGroupNames = DENSITY_FIELD_GROUPS.map((g) => g.name);
ok(JSON.stringify(densityGroupNames) === JSON.stringify(['Grid', 'Warp', 'Caves', 'Floor']),
  '2 (Phase D): DENSITY_FIELD_GROUPS names/order match the design spec');

const densityFieldNames = DENSITY_FIELD_GROUPS.flatMap((g) => g.fields);
ok(densityFieldNames.length === 12, '2 (Phase D): four groups list 12 fields total');
let densityFieldsValid = true;
for (const name of densityFieldNames) {
  if (!(name in DENSITY_DEFAULT_CONFIG)) densityFieldsValid = false;
  if (!(name in DENSITY_FIELD_RANGES)) densityFieldsValid = false;
}
ok(densityFieldsValid, '2 (Phase D): every DENSITY_FIELD_GROUPS field has a DENSITY_DEFAULT_CONFIG value and a DENSITY_FIELD_RANGES entry');

const [dLo, dHi, dStep] = DENSITY_FIELD_RANGES.density_resolution;
ok(dLo === 32 && dHi === 160 && dStep === 8, '2 (Phase D): density_resolution range matches density_config.py (32-160 step 8)');
const [wpLo, wpHi, wpStep] = DENSITY_FIELD_RANGES.warp_period;
ok(wpLo === 20 && wpHi === 600 && wpStep === 1, '2 (Phase D): warp_period range matches density_config.py (20-600 step 1)');
const [cpLo, cpHi, cpStep] = DENSITY_FIELD_RANGES.cave_period;
ok(cpLo === 20 && cpHi === 400 && cpStep === 5, '2 (Phase D): cave_period range matches density_config.py (20-400 step 5)');

ok(densityFieldLabel('density_resolution') === 'voxel res', '2 (Phase D): densityFieldLabel looks up DENSITY_FIELD_LABELS');
ok(densityFieldLabel('cave_threshold') === 'cave threshold', '2 (Phase D): densityFieldLabel looks up DENSITY_FIELD_LABELS (2)');

let everyDensityFieldHasDescription = true;
for (const name of densityFieldNames) {
  const desc = densityFieldDescription(name);
  if (typeof desc !== 'string' || desc.length < 10) everyDensityFieldHasDescription = false;
}
ok(everyDensityFieldHasDescription, '2 (Phase D): every DENSITY_FIELD_GROUPS field has a non-trivial densityFieldDescription');
```

Add `DENSITY_DEFAULT_CONFIG, DENSITY_FIELD_GROUPS, DENSITY_FIELD_RANGES, densityFieldLabel, densityFieldDescription`
to the import list at the top of `test-terrain-generator-js.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-terrain-generator-js.mjs`
Expected: fails with an import error (these exports don't exist yet).

- [ ] **Step 3: Implement the schema**

Append to `terrain-generator-js.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-terrain-generator-js.mjs`
Expected: `Task 2 (Phase D)` assertions all pass.

- [ ] **Step 5: Commit**

```bash
git add terrain-generator-js.js test-terrain-generator-js.mjs
git commit -m "feat(terrain): add density field config schema (port of density_config.py)"
```

---

## Task 4: `buildDensityField3D`

Ports `build_density_field` from `volumetric_mesh.py`.

**Files:**
- Modify: `terrain-generator-js.js` (append)
- Test: `test-terrain-generator-js.mjs` (append)

- [ ] **Step 1: Write the failing test**

```js
// --- Task 3 (Phase D): buildDensityField3D ---
{
  // Flat height field, warp/cave disabled, no floor bias -- density should reduce to the
  // macro height - y - iso_level term: positive (solid) below the flat height, negative
  // (air) above it.
  const res = 8;
  const flatHeight = { height: new Float32Array(res * res).fill(50.0), resolution: res };
  const cfg = {
    ...DENSITY_DEFAULT_CONFIG,
    density_resolution: res, y_min: 0, y_max: 100, iso_level: 0,
    warp_strength_surface: 0, warp_strength_global: 0, cave_strength: 0, floor_thickness: 0,
  };
  const density = buildDensityField3D(flatHeight, cfg, 400, 400, 1337);
  ok(density.length === res * res * res, '3 (Phase D): buildDensityField3D returns a res^3-length array');

  // iy=0 -> y=0 (below the flat height of 50) should be solid (positive)
  ok(density[0 + 0 * res + 0 * res * res] > 0, '3 (Phase D): a voxel well below the flat height is solid (positive density)');
  // iy=res-1 -> y=100 (above the flat height of 50) should be air (negative)
  const topIy = res - 1;
  ok(density[0 + topIy * res + 0 * res * res] < 0, '3 (Phase D): a voxel well above the flat height is air (negative density)');
}
{
  // floor_thickness sanity check: with a large floor_thickness, the bottom-most layer
  // (iy=0, at y_min) must be strongly positive (solid) regardless of height/warp/cave.
  const res = 8;
  const flatHeight = { height: new Float32Array(res * res).fill(-1000.0), resolution: res }; // height far below y_min, so the macro term alone would be very negative (air)
  const cfg = {
    ...DENSITY_DEFAULT_CONFIG,
    density_resolution: res, y_min: 0, y_max: 100, iso_level: 0,
    warp_strength_surface: 0, warp_strength_global: 0, cave_strength: 0, floor_thickness: 20,
  };
  const density = buildDensityField3D(flatHeight, cfg, 400, 400, 1337);
  ok(density[0 + 0 * res + 0 * res * res] > 0, '3 (Phase D): floor_thickness forces the bottom layer solid even when the macro term alone would be air');
}
```

Add `buildDensityField3D` to the import list.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-terrain-generator-js.mjs`
Expected: fails, `buildDensityField3D` doesn't exist yet.

- [ ] **Step 3: Implement `buildDensityField3D`**

Append to `terrain-generator-js.js`:

```js
// ---- Phase D: density field (port of volumetric_mesh.py's build_density_field) ----
// heightGrid2D must be a generateFullGrid() result computed AT densityCfg.density_resolution
// (a fresh, independent regeneration -- same reason heightfield_pipeline.py reruns the 2D
// pipeline at the density resolution: erosion/flow are whole-grid algorithms, so there is
// no per-point height-sampling shortcut). Returns a Float32Array of length res^3, indexed
// density[ix + iy*res + iz*res*res] (x-fastest -- an internal convention, not required to
// match numpy's (z,y,x) C-order axis layout in the Python source). The 6.0/8.0/50.0
// constants below are hardcoded in the Python source too (not config fields).
export function buildDensityField3D(heightGrid2D, densityCfg, worldX, worldZ, seed) {
  const res = densityCfg.density_resolution;
  const density = new Float32Array(res * res * res);
  const noiseSampler = createDensityNoiseSampler();
  const extentY = densityCfg.y_max - densityCfg.y_min;

  for (let iz = 0; iz < res; iz++) {
    const z = (iz / Math.max(1, res - 1) - 0.5) * worldZ;
    for (let iy = 0; iy < res; iy++) {
      const y = densityCfg.y_min + (iy / Math.max(1, res - 1)) * extentY;
      for (let ix = 0; ix < res; ix++) {
        const x = (ix / Math.max(1, res - 1) - 0.5) * worldX;
        const h = heightGrid2D.height[iz * res + ix];
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
        d += floorBias;

        density[ix + iy * res + iz * res * res] = d;
      }
    }
  }
  return density;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-terrain-generator-js.mjs`
Expected: `Task 3 (Phase D)` assertions all pass.

- [ ] **Step 5: Commit**

```bash
git add terrain-generator-js.js test-terrain-generator-js.mjs
git commit -m "feat(terrain): port volumetric_mesh.py's build_density_field to buildDensityField3D"
```

---

## Task 5: Marching cubes

A from-scratch JS port of the classic Lorensen-Cline algorithm. The 256-entry
`EDGE_TABLE`/`TRI_TABLE` below are copied verbatim from Paul Bourke's canonical
"Polygonising a scalar field" reference implementation (public domain, based on tables by
Cory Bloyd) — the same algorithm `skimage.measure.marching_cubes` implements in C, not a
copy of skimage's own code.

**Files:**
- Modify: `terrain-generator-js.js` (append)
- Test: `test-terrain-generator-js.mjs` (append)

- [ ] **Step 1: Write the failing test**

```js
// --- Task 4 (Phase D): marchingCubes ---
{
  // All-positive density (fully solid) -- no surface crossing, expect zero output.
  const res = 4;
  const density = new Float32Array(res * res * res).fill(5.0);
  const { positions, indices } = marchingCubes(density, res, 10, 10, 10, 0, 0, 0, 0.0);
  ok(positions.length === 0 && indices.length === 0, '4 (Phase D): an all-solid density field produces no geometry');
}
{
  // All-negative density (fully air) -- no surface crossing, expect zero output.
  const res = 4;
  const density = new Float32Array(res * res * res).fill(-5.0);
  const { positions, indices } = marchingCubes(density, res, 10, 10, 10, 0, 0, 0, 0.0);
  ok(positions.length === 0 && indices.length === 0, '4 (Phase D): an all-air density field produces no geometry');
}
{
  // Perfect sphere: density = R - distance_from_center. The extracted surface should be
  // very close to radius R from the center at every vertex (the standard marching-cubes
  // sanity check), and the vertex count should be roughly 2x the triangle count / ... in
  // general triangleCount should be positive and vertex-welding should keep vertexCount
  // well below 3*triangleCount (proof the shared-vertex cache is actually deduplicating).
  const res = 24;
  const R = 8;
  const center = (res - 1) / 2;
  const density = new Float32Array(res * res * res);
  for (let iz = 0; iz < res; iz++) {
    for (let iy = 0; iy < res; iy++) {
      for (let ix = 0; ix < res; ix++) {
        const dist = Math.hypot(ix - center, iy - center, iz - center);
        density[ix + iy * res + iz * res * res] = R - dist;
      }
    }
  }
  const originX = -center, originY = -center, originZ = -center;
  const { positions, indices } = marchingCubes(density, res, 1, 1, 1, originX, originY, originZ, 0.0);
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  ok(triangleCount > 0, '4 (Phase D): a sphere density field produces triangles');
  ok(vertexCount < triangleCount * 1.5, '4 (Phase D): shared-vertex welding keeps vertex count well below 3x triangle count');

  let maxError = 0;
  for (let i = 0; i < vertexCount; i++) {
    const dist = Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    maxError = Math.max(maxError, Math.abs(dist - R));
  }
  ok(maxError < 1.0, `4 (Phase D): every extracted vertex is within 1.0 of the true sphere radius (max error ${maxError.toFixed(3)})`);
}
```

Add `marchingCubes` to the import list.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-terrain-generator-js.mjs`
Expected: fails, `marchingCubes` doesn't exist yet.

- [ ] **Step 3: Implement `marchingCubes`**

Append to `terrain-generator-js.js`. First the two lookup tables (paste exactly as shown
— these are the standard 256-entry Lorensen-Cline tables, transcribed from Paul Bourke's
reference implementation):

```js
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
```

Then the algorithm itself, using vertex welding (a `Map` keyed by grid-position + edge
direction) so triangles from adjacent cells share vertices instead of duplicating them —
this is what makes `computeVertexNormals()` produce a smooth surface later, instead of a
faceted/flat-shaded one:

```js
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
  const positions = [];
  const indices = [];
  const vertexCache = new Map();
  const vertlist = new Array(12);

  function densityAt(ix, iy, iz) { return density[ix + iy * res + iz * res * res]; }

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

  for (let iz = 0; iz < res - 1; iz++) {
    for (let iy = 0; iy < res - 1; iy++) {
      for (let ix = 0; ix < res - 1; ix++) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-terrain-generator-js.mjs`
Expected: `Task 4 (Phase D)` assertions all pass. If the sphere test's max-error assertion
fails, double check `MC_EDGE_DIR`/`MC_EDGE_BASE_SLOT` against the corner offsets — a
transposed direction there is the most likely bug (it would still produce triangles, just
with cracks or a lopsided sphere).

- [ ] **Step 5: Commit**

```bash
git add terrain-generator-js.js test-terrain-generator-js.mjs
git commit -m "feat(terrain): add marchingCubes (Lorensen-Cline surface extraction with shared-vertex welding)"
```

---

## Task 6: Grass density table (for export)

Ports `terrain_v3/export/biome_density.py`'s `GRASS_DENSITY`/`grass_density_for_ids`.

**Files:**
- Modify: `terrain-generator-js.js` (append)
- Test: `test-terrain-generator-js.mjs` (append)

- [ ] **Step 1: Write the failing test**

```js
// --- Task 5 (Phase D): grassDensityForIds ---
{
  ok(GRASS_DENSITY.forest === 0.85, '5 (Phase D): GRASS_DENSITY.forest matches biome_density.py');
  ok(GRASS_DENSITY.desert === 0.0, '5 (Phase D): GRASS_DENSITY.desert matches biome_density.py');
  ok(GRASS_DENSITY.jungle === 0.95, '5 (Phase D): GRASS_DENSITY.jungle matches biome_density.py');

  const biomeId = new Uint8Array([BIOME_INDEX.forest, BIOME_INDEX.desert]);
  const waterMask = new Float32Array([0.0, 0.0]);
  const density = grassDensityForIds(biomeId, waterMask);
  ok(Math.abs(density[0] - 0.85) < 1e-6, '5 (Phase D): grassDensityForIds looks up GRASS_DENSITY by biome (dry forest cell)');
  ok(Math.abs(density[1] - 0.0) < 1e-6, '5 (Phase D): grassDensityForIds looks up GRASS_DENSITY by biome (dry desert cell)');

  const wetBiomeId = new Uint8Array([BIOME_INDEX.forest]);
  const fullWater = new Float32Array([1.0]);
  const wetDensity = grassDensityForIds(wetBiomeId, fullWater);
  ok(Math.abs(wetDensity[0]) < 1e-6, '5 (Phase D): grassDensityForIds zeroes out fully-water cells regardless of biome');
}
```

Add `GRASS_DENSITY, grassDensityForIds` to the import list.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-terrain-generator-js.mjs`
Expected: fails, these exports don't exist yet.

- [ ] **Step 3: Implement `GRASS_DENSITY`/`grassDensityForIds`**

Append to `terrain-generator-js.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-terrain-generator-js.mjs`
Expected: `Task 5 (Phase D)` assertions all pass, and the full suite (`Task 1` through `Task
5 (Phase D)`) reports 0 failures.

- [ ] **Step 5: Commit**

```bash
git add terrain-generator-js.js test-terrain-generator-js.mjs
git commit -m "feat(terrain): add GRASS_DENSITY table (port of biome_density.py) for map export"
```

---

## Task 7: Generalize `buildGroupControls` for reuse by the density panel

`terrain-generator-v4.html:708` has a `buildGroupControls(container, groupNames)`
function hardcoded to `genConfig`/`FIELD_GROUPS`/`FIELD_RANGES`/`fieldLabel`/
`fieldDescription`/`scheduleRegenerate`. Give it optional parameters (defaulting to
those exact values) so the 5 existing call sites don't need to change, and the new
density panel (Task 9) can pass its own config/tables instead of a second copy-pasted
slider builder.

**Files:**
- Modify: `terrain-generator-v4.html:708-743`

- [ ] **Step 1: Replace the function signature and body**

Find this in `terrain-generator-v4.html`:
```js
  // ---- shared slider-builder (reused by sections 2-5) ----
  function buildGroupControls(container, groupNames) {
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
        const desc = document.createElement('p');
        desc.className = 'control-desc';
        desc.textContent = fieldDescription(name);
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
          scheduleRegenerate();
        });
        row.appendChild(desc);
        row.appendChild(label);
        row.appendChild(input);
        container.appendChild(row);
      }
    }
  }
```

Replace it with:
```js
  // ---- shared slider-builder (reused by sections 2-5 and the density panel) ----
  // Defaults reproduce the original hardcoded behavior exactly, so none of the 5 existing
  // call sites below need to change -- only the density panel (Task 9) passes explicit
  // overrides for its own independent config/tables.
  function buildGroupControls(
    container, groupNames,
    cfg = genConfig, fieldGroups = FIELD_GROUPS, fieldRanges = FIELD_RANGES,
    labelFn = fieldLabel, descFn = fieldDescription, onChange = scheduleRegenerate,
  ) {
    container.innerHTML = '';
    for (const group of fieldGroups) {
      if (!groupNames.includes(group.name)) continue;
      const heading = document.createElement('h3');
      heading.textContent = group.name;
      heading.style.fontSize = '0.95em';
      container.appendChild(heading);
      for (const name of group.fields) {
        const [min, max, step] = fieldRanges[name];
        const row = document.createElement('div');
        row.className = 'control-row';
        const desc = document.createElement('p');
        desc.className = 'control-desc';
        desc.textContent = descFn(name);
        const label = document.createElement('label');
        const valueSpan = document.createElement('span');
        valueSpan.textContent = cfg[name];
        label.textContent = labelFn(name) + ' ';
        label.appendChild(valueSpan);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min; input.max = max; input.step = step;
        input.value = cfg[name];
        input.addEventListener('input', () => {
          cfg[name] = Number(input.value);
          valueSpan.textContent = input.value;
          onChange();
        });
        row.appendChild(desc);
        row.appendChild(label);
        row.appendChild(input);
        container.appendChild(row);
      }
    }
  }
```

- [ ] **Step 2: Verify the syntax is valid and existing panels still work**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('terrain-generator-v4.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*)<\/script>/);fs.writeFileSync('_tg4-check.mjs', m[1]);" && node --check _tg4-check.mjs && rm _tg4-check.mjs
```
Expected: no syntax errors.

Then open `terrain-generator-v4.html` via `python serve.py` in a browser and confirm the
World & noise fields, Height composer, Erosion & hydrology, and Derived masks panels'
sliders still render and still trigger a regenerate on drag (the 5 existing call sites
are unchanged, so this should behave identically to before).

- [ ] **Step 3: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "refactor: generalize buildGroupControls with defaulted params for reuse by the density panel"
```

---

## Task 8: Replace the `node-density` placeholder with `section-density`

**Files:**
- Modify: `terrain-generator-v4.html:336-339`

- [ ] **Step 1: Replace the placeholder div**

Find:
```html
  <div class="panel placeholder" id="node-density">
    <h2>Density field preview</h2>
    <p class="lede">Not yet built (Phase D) — the real cave/warp-aware 3D density field, not the 2D-only preview stand-in.</p>
  </div>
```

Replace with:
```html
  <section class="panel" id="section-density">
    <h2>Density field preview</h2>
    <p class="lede">The real cave/warp-aware 3D density field, marching-cubes-extracted into a smooth mesh -- the same math the real map export uses.</p>
    <p class="callout hidden" id="density-resolution-warning">Density resolution is above 96 -- rebuilding may take a few seconds.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <div id="density-viewport" style="width:420px;height:420px;border-radius:8px;border:1px solid var(--border);overflow:hidden;"></div>
      </div>
      <div class="controls" id="density-controls"></div>
    </div>
    <button class="action" id="density-reset-view">Reset view</button>
    <p class="lede" id="density-stats"></p>
    <h3>Export</h3>
    <div class="control-row">
      <label for="density-export-folder">Folder</label>
      <input type="text" id="density-export-folder" value="workshop">
    </div>
    <div class="control-row">
      <label for="density-export-name">Name</label>
      <input type="text" id="density-export-name" value="terrain-generator-export">
    </div>
    <button class="action" id="density-export-btn">Export to maps/</button>
    <p class="lede" id="density-export-status"></p>
  </section>
```

The DOM id changes from `node-density` to `section-density`, and the node-canvas layout
keys panels by DOM id, so every other reference to `'node-density'` in the file must be
renamed to `'section-density'` too: one entry in `DEFAULT_LAYOUT` and two edges in
`CONNECTOR_EDGES` (search the file for `node-density` to find all three). There is no
separate CSS rule keyed by this id, since `.panel` styling is shared.

- [ ] **Step 2: Verify syntax and layout wiring**

Run the same `node --check` extraction command as Task 7 Step 2.

Then in a browser (via `python serve.py`), confirm the canvas still loads without a
console error, the density panel now renders as a normal (non-dimmed) panel at its
existing grid position, and the connector arrows into/out of it still draw (they'll
still be correct since `edgePath`/`renderConnectors` read positions by id from
`panelPositions`, which is now keyed `section-density` consistently).

- [ ] **Step 3: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "feat(terrain): replace node-density placeholder with a real section-density panel shell"
```

---

## Task 9: Wire the density viewport (Three.js scene, mesh rebuild, sliders, reset)

Mirrors `initHeightfieldViewport` (`terrain-generator-v4.html:513-705`) — same chrome
pattern, own scene/camera/controls, non-awaited async init.

**Files:**
- Modify: `terrain-generator-v4.html` (add imports, add a new `initDensityViewport`
  function, call it, wire `density-controls`)

- [ ] **Step 1: Add new imports**

Find the import line:
```js
  import {
    BIOMES, BIOME_COLORS, DEFAULT_CONFIG, FIELD_GROUPS, FIELD_RANGES, fieldLabel, fieldDescription,
    generateFullGrid, buildHeightfieldMesh, divergingColor, signedColor, heightColor, flowColor, slopeColor, maskColor,
  } from './terrain-generator-js.js';
```

Replace with:
```js
  import {
    BIOMES, BIOME_COLORS, DEFAULT_CONFIG, FIELD_GROUPS, FIELD_RANGES, fieldLabel, fieldDescription,
    generateFullGrid, buildHeightfieldMesh, divergingColor, signedColor, heightColor, flowColor, slopeColor, maskColor,
    DENSITY_DEFAULT_CONFIG, DENSITY_FIELD_GROUPS, DENSITY_FIELD_RANGES, densityFieldLabel, densityFieldDescription,
    buildDensityField3D, marchingCubes, grassDensityForIds,
  } from './terrain-generator-js.js';
```

- [ ] **Step 2: Add the density config object and viewport function**

Add this right after the `initHeightfieldViewport().catch(...)` block (around
`terrain-generator-v4.html:701-705`, before the `// ---- shared slider-builder ----`
comment):

```js
  // ---- section 9: Density field preview -- Phase D ----
  const densityConfig = { ...DENSITY_DEFAULT_CONFIG };
  const DENSITY_WARN_RESOLUTION = 96;
  let densityLastGrid = null;
  let densityLastDensity = null;
  let densityMesh = null;
  let densityGeometry = null;

  async function initDensityViewport() {
  const densityViewport = document.getElementById('density-viewport');
  const densityRenderer = new WebGPURenderer({ antialias: true });
  densityRenderer.setSize(420, 420);
  densityViewport.appendChild(densityRenderer.domElement);
  await densityRenderer.init();

  const densityScene = new THREE.Scene();
  densityScene.background = new THREE.Color(0xfaf6ef);

  const densityCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  const DENSITY_INITIAL_CAMERA_POS = new THREE.Vector3(700, 500, 700);
  const DENSITY_INITIAL_TARGET = new THREE.Vector3(0, 0, 0);
  densityCamera.position.copy(DENSITY_INITIAL_CAMERA_POS);

  const densityControls3d = new OrbitControls(densityCamera, densityRenderer.domElement);
  densityControls3d.target.copy(DENSITY_INITIAL_TARGET);
  densityControls3d.enableDamping = true;
  densityControls3d.dampingFactor = 0.08;
  densityControls3d.update();

  const densityAmbient = new THREE.AmbientLight(0xffffff, 0.6);
  const densityDirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  densityDirLight.position.set(400, 600, 200);
  densityScene.add(densityAmbient, densityDirLight);

  document.getElementById('density-reset-view').addEventListener('click', () => {
    densityCamera.position.copy(DENSITY_INITIAL_CAMERA_POS);
    densityControls3d.target.copy(DENSITY_INITIAL_TARGET);
    densityControls3d.update();
  });

  densityRenderer.setAnimationLoop(() => {
    densityControls3d.update();
    densityRenderer.render(densityScene, densityCamera);
  });

  densityGeometry = new THREE.BufferGeometry();
  const densityMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
  densityMesh = new THREE.Mesh(densityGeometry, densityMaterial);
  densityScene.add(densityMesh);

  let densityRegenTimer = null;

  function updateDensityResolutionWarning() {
    document.getElementById('density-resolution-warning').classList.toggle('hidden', densityConfig.density_resolution <= DENSITY_WARN_RESOLUTION);
  }

  function applyDensityColors(grid, positions) {
    const res = grid.resolution;
    const vertexCount = positions.length / 3;
    const colors = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      const vx = positions[i * 3], vz = positions[i * 3 + 2];
      const fx = (vx / genConfig.world_x + 0.5) * (res - 1);
      const fz = (vz / genConfig.world_z + 0.5) * (res - 1);
      const ix = Math.max(0, Math.min(res - 1, Math.round(fx)));
      const iz = Math.max(0, Math.min(res - 1, Math.round(fz)));
      const idx = iz * res + ix;
      colors[i * 3] = grid.materialRgba[idx * 4] / 255;
      colors[i * 3 + 1] = grid.materialRgba[idx * 4 + 1] / 255;
      colors[i * 3 + 2] = grid.materialRgba[idx * 4 + 2] / 255;
    }
    densityGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  function updateDensityStats(positions, indices, density) {
    let densityMin = Infinity, densityMax = -Infinity;
    for (const d of density) { if (d < densityMin) densityMin = d; if (d > densityMax) densityMax = d; }
    document.getElementById('density-stats').textContent =
      `${positions.length / 3} vertices, ${indices.length / 3} triangles -- density ${densityMin.toFixed(2)} to ${densityMax.toFixed(2)}`;
  }

  function rebuildDensityMesh() {
    densityLastGrid = generateFullGrid(genConfig, densityConfig.density_resolution);
    densityLastDensity = buildDensityField3D(densityLastGrid, densityConfig, genConfig.world_x, genConfig.world_z, genConfig.seed);
    const res = densityConfig.density_resolution;
    const spacingX = genConfig.world_x / Math.max(1, res - 1);
    const spacingY = (densityConfig.y_max - densityConfig.y_min) / Math.max(1, res - 1);
    const spacingZ = genConfig.world_z / Math.max(1, res - 1);
    const originX = -genConfig.world_x / 2;
    const originY = densityConfig.y_min;
    const originZ = -genConfig.world_z / 2;
    const { positions, indices } = marchingCubes(densityLastDensity, res, spacingX, spacingY, spacingZ, originX, originY, originZ, 0.0);

    densityGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    densityGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    applyDensityColors(densityLastGrid, positions);
    densityGeometry.computeVertexNormals();
    densityGeometry.computeBoundingSphere();
    updateDensityStats(positions, indices, densityLastDensity);
  }

  function scheduleDensityRegenerate() {
    clearTimeout(densityRegenTimer);
    densityRegenTimer = setTimeout(rebuildDensityMesh, 500);
  }

  function onDensityConfigChange() {
    updateDensityResolutionWarning();
    scheduleDensityRegenerate();
  }

  buildGroupControls(
    document.getElementById('density-controls'), ['Grid', 'Warp', 'Caves', 'Floor'],
    densityConfig, DENSITY_FIELD_GROUPS, DENSITY_FIELD_RANGES,
    densityFieldLabel, densityFieldDescription, onDensityConfigChange,
  );

  updateDensityResolutionWarning();
  rebuildDensityMesh();
  }

  initDensityViewport().catch((err) => {
    console.error('Density viewport failed to initialize:', err);
    document.getElementById('density-viewport').textContent =
      'Density viewport unavailable (WebGPU init failed: ' + err.message + ').';
  });
```

Note: `buildGroupControls` is called here before it is defined further down the file —
this is fine in a module-scope `function` declaration (hoisted), same as
`initHeightfieldViewport` already calling functions defined later in the file.

- [ ] **Step 3: Verify syntax**

Run the same `node --check` extraction command as Task 7 Step 2.

- [ ] **Step 4: Manual browser check**

Via `python serve.py`, open the page, pan/zoom to `section-density`, and confirm:
- A mesh renders in the viewport at default settings (not a blank/black box).
- Dragging any of the 12 sliders (e.g. `cave_strength`) triggers a rebuild after ~500ms
  (watch `density-stats` update).
- Dragging `density_resolution` above 96 shows the resolution warning banner.
- "Reset view" restores the initial camera framing after orbiting away from it.

- [ ] **Step 5: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "feat(terrain): wire the density field viewport (marching-cubes mesh, sliders, reset view)"
```

---

## Task 10: Export button (client side)

**Files:**
- Modify: `terrain-generator-v4.html` (add export wiring inside `initDensityViewport`,
  after `rebuildDensityMesh()` is defined)

- [ ] **Step 1: Add export helpers and the click handler**

Add this inside `initDensityViewport`, after the `rebuildDensityMesh`/
`scheduleDensityRegenerate`/`onDensityConfigChange` definitions and before the
`buildGroupControls(...)` call:

```js
  function validateMapSegment(value) {
    return /^[A-Za-z0-9 _-]+$/.test(value.trim()) && value.trim().length > 0;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function buildDensityMapData() {
    const grid = densityLastGrid;
    const res = densityConfig.density_resolution;
    let heightMin = Infinity, heightMax = -Infinity;
    for (const h of grid.height) { if (h < heightMin) heightMin = h; if (h > heightMax) heightMax = h; }
    const water = grid.materialMasks.water;
    return {
      terrainKind: 'volumetric',
      worldX: genConfig.world_x, worldZ: genConfig.world_z,
      worldYMin: densityConfig.y_min, worldYMax: densityConfig.y_max,
      seaLevel: genConfig.sea_level,
      resolution: res,
      heightMin, heightMax,
      biomeNames: BIOMES,
      biomeIds: Array.from(grid.biomeId),
      grassDensity: Array.from(grassDensityForIds(grid.biomeId, water)),
      lakeMask: Array.from(grid.lakeMask),
      materialMasks: {
        grass: Array.from(grid.materialMasks.grass),
        forest: Array.from(grid.materialMasks.forest),
        dirt: Array.from(grid.materialMasks.dirt),
        sand: Array.from(grid.materialMasks.sand),
        rock: Array.from(grid.materialMasks.rock),
        snow: Array.from(grid.materialMasks.snow),
        water: Array.from(water),
      },
      density: {
        resolution: res, isoLevel: densityConfig.iso_level,
        caveStrength: densityConfig.cave_strength, caveThreshold: densityConfig.cave_threshold,
      },
    };
  }

  document.getElementById('density-export-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('density-export-status');
    const folder = document.getElementById('density-export-folder').value;
    const name = document.getElementById('density-export-name').value;
    if (!validateMapSegment(folder) || !validateMapSegment(name)) {
      statusEl.textContent = 'Folder and name must be non-empty and use only letters, digits, spaces, underscores, or hyphens.';
      return;
    }
    if (!densityLastGrid) { statusEl.textContent = 'Nothing to export yet.'; return; }
    statusEl.textContent = 'Exporting...';

    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const glbBuffer = await new Promise((resolve, reject) => {
      new GLTFExporter().parse(densityMesh, resolve, reject, { binary: true });
    });
    const mapData = buildDensityMapData();

    try {
      const response = await fetch('/api/save-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: folder.trim(), name: name.trim(), glbBase64: arrayBufferToBase64(glbBuffer), mapData }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
      statusEl.textContent = `Exported to maps/${body.mapKey} (${body.bytes} bytes)`;
    } catch (err) {
      downloadBlob(`${name.trim()}.glb`, new Blob([glbBuffer], { type: 'model/gltf-binary' }));
      downloadBlob(`${name.trim()}-data.json`, new Blob([JSON.stringify(mapData, null, 2)], { type: 'application/json' }));
      statusEl.textContent = `Server export unavailable (${err.message}) -- downloaded ${name.trim()}.glb and ${name.trim()}-data.json instead.`;
    }
  });
```

- [ ] **Step 2: Verify syntax**

Run the same `node --check` extraction command as Task 7 Step 2.

- [ ] **Step 3: Manual browser check (before the server endpoint exists — expect the fallback)**

Via `python serve.py`, click "Export to maps/" with the default folder/name. Since
`/api/save-map` doesn't exist yet (Task 11), expect: two files download
(`terrain-generator-export.glb`, `terrain-generator-export-data.json`) and the status
line reports the server-export-unavailable fallback message. Confirm the downloaded
`-data.json` is valid JSON with the expected keys (`terrainKind`, `biomeIds`, etc.) by
opening it.

- [ ] **Step 4: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "feat(terrain): add density panel's Export to maps/ button (GLTFExporter + fallback download)"
```

---

## Task 11: `/api/save-map` endpoint (`serve.py`)

**Files:**
- Modify: `serve.py`

- [ ] **Step 1: Add the import, MAPS_DIR constant, and path-safety helper**

Find:
```python
import http.server
import json
import os
import re
import sys
```
Replace with:
```python
import base64
import http.server
import json
import os
import re
import sys
```

Find:
```python
FAMILIES_DIR = os.path.join(ROOT, 'families')
MANIFEST_PATH = os.path.join(FAMILIES_DIR, 'manifest.json')
```
Replace with:
```python
FAMILIES_DIR = os.path.join(ROOT, 'families')
MANIFEST_PATH = os.path.join(FAMILIES_DIR, 'manifest.json')
MAPS_DIR = os.path.join(ROOT, 'maps')
_SAFE_MAP_SEGMENT = re.compile(r'^[A-Za-z0-9 _-]+$')


def _safe_under_maps(*segments):
    # Mirrors terrain-v3's map_bundle.py _safe_under_maps: reject empty/unsafe segments
    # and any path that resolves outside MAPS_DIR (defense against folder='../../etc').
    for seg in segments:
        if not seg or not _SAFE_MAP_SEGMENT.match(seg):
            raise ValueError(f'unsafe path segment: {seg!r}')
    base = os.path.abspath(MAPS_DIR)
    target = os.path.abspath(os.path.join(base, *segments))
    if target != base and not target.startswith(base + os.sep):
        raise ValueError('path escapes maps/')
    return target
```

- [ ] **Step 2: Split `do_POST` into a dispatcher plus two handlers**

Find:
```python
    def do_POST(self):
        if self.path != '/api/save-family':
            self.send_error(404)
            return
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 5_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            family = json.loads(self.rfile.read(length).decode('utf-8'))
            filename = f"{slugify(family.get('name'))}.json"
            os.makedirs(FAMILIES_DIR, exist_ok=True)
            with open(os.path.join(FAMILIES_DIR, filename), 'w', encoding='utf-8') as f:
                json.dump(family, f, indent=2)

            try:
                with open(MANIFEST_PATH, 'r', encoding='utf-8') as f:
                    manifest = json.load(f)
                if not isinstance(manifest, list):
                    manifest = []
            except (FileNotFoundError, json.JSONDecodeError):
                manifest = []
            if filename not in manifest:
                manifest.append(filename)
                with open(MANIFEST_PATH, 'w', encoding='utf-8') as f:
                    json.dump(manifest, f, indent=2)

            self._send_json({'ok': True, 'filename': filename})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)
```

Replace with:
```python
    def do_POST(self):
        if self.path == '/api/save-family':
            self._handle_save_family()
        elif self.path == '/api/save-map':
            self._handle_save_map()
        else:
            self.send_error(404)

    def _handle_save_family(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 5_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            family = json.loads(self.rfile.read(length).decode('utf-8'))
            filename = f"{slugify(family.get('name'))}.json"
            os.makedirs(FAMILIES_DIR, exist_ok=True)
            with open(os.path.join(FAMILIES_DIR, filename), 'w', encoding='utf-8') as f:
                json.dump(family, f, indent=2)

            try:
                with open(MANIFEST_PATH, 'r', encoding='utf-8') as f:
                    manifest = json.load(f)
                if not isinstance(manifest, list):
                    manifest = []
            except (FileNotFoundError, json.JSONDecodeError):
                manifest = []
            if filename not in manifest:
                manifest.append(filename)
                with open(MANIFEST_PATH, 'w', encoding='utf-8') as f:
                    json.dump(manifest, f, indent=2)

            self._send_json({'ok': True, 'filename': filename})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # terrain-generator-v4.html's density panel "Export to maps/" button POSTs here so a
    # marching-cubes GLB + map-data.json land directly under maps/ (the same directory
    # terrain-v3's own /v3/export/map endpoint auto-detects and writes into), and
    # map-config.json gets an entry so the map shows up in the game's map picker.
    def _handle_save_map(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 60_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            folder = str(body.get('folder', '')).strip()
            name = str(body.get('name', '')).strip()
            glb_base64 = body.get('glbBase64', '')
            map_data = body.get('mapData', {})
            if not _SAFE_MAP_SEGMENT.match(name):
                raise ValueError(f'unsafe name: {name!r}')
            folder_path = _safe_under_maps(folder)
            glb_bytes = base64.b64decode(glb_base64)

            os.makedirs(folder_path, exist_ok=True)
            with open(os.path.join(folder_path, f'{name}.glb'), 'wb') as f:
                f.write(glb_bytes)
            with open(os.path.join(folder_path, f'{name}-data.json'), 'w', encoding='utf-8') as f:
                json.dump(map_data, f, indent=2)

            map_key = f'{folder}/{name}.glb'
            config_path = os.path.join(MAPS_DIR, 'map-config.json')
            try:
                with open(config_path, 'r', encoding='utf-8') as f:
                    cfg = json.load(f)
                if not isinstance(cfg, dict):
                    cfg = {}
            except (FileNotFoundError, json.JSONDecodeError):
                cfg = {}
            maps = cfg.setdefault('maps', {})
            if not isinstance(maps, dict):
                cfg['maps'] = maps = {}
            if map_key not in maps:
                display = name.replace('_', ' ').replace('-', ' ').strip().title()
                maps[map_key] = {
                    'displayName': display, 'gameName': display, 'image': '',
                    'playable': True, 'mapScale': 1, 'snapStep': 0.5,
                }
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, indent=2)

            self._send_json({
                'ok': True, 'mapKey': map_key,
                'writtenTo': os.path.join(folder_path, f'{name}.glb'),
                'bytes': len(glb_bytes),
            })
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)
```

- [ ] **Step 3: Syntax check**

Run: `python -c "import ast; ast.parse(open('serve.py', encoding='utf-8').read())"`
Expected: no output (valid syntax).

- [ ] **Step 4: Manual end-to-end check**

Start the server: `python serve.py`. Open `terrain-generator-v4.html`, go to the density
panel, set folder `workshop` and a fresh name (e.g. `phase-d-test`), click "Export to
maps/". Expected: status line reads `Exported to maps/workshop/phase-d-test.glb (N
bytes)` (not the fallback-download message this time). Verify on disk:
```bash
ls maps/workshop/phase-d-test.glb maps/workshop/phase-d-test-data.json
python -c "import json; d=json.load(open('maps/map-config.json')); print('workshop/phase-d-test.glb' in d['maps'])"
```
Expected: both files exist, and the last command prints `True`.

Click export again with the *same* folder/name — expected: it overwrites the `.glb`/
`-data.json` but does not duplicate or reset the `map-config.json` entry (the `if map_key
not in maps` guard leaves an already-present entry's `displayName`/etc. untouched, same
as the Python export tool's own behavior).

- [ ] **Step 5: Commit**

```bash
git add serve.py
git commit -m "feat(infra): add /api/save-map endpoint so terrain-generator-v4.html can export real maps into maps/"
```

---

## Task 12: Manual verification, docs, and final log entry

**Files:**
- Modify: `docs/subsystems/biomes.md`
- Modify: `agent_log.csv`

- [ ] **Step 1: Full headless-Chrome verification pass**

Kill any stray Chrome processes first (established pattern for this repo):
```bash
powershell -Command "Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force"
```
With `python serve.py` running, use headless Chrome to screenshot the density panel and
dump its DOM, confirming: `section-density` exists (not `node-density`), is not dimmed
(no `.placeholder` class), the viewport `<canvas>` inside `#density-viewport` has
non-zero size, and `density-stats` contains a non-empty vertex/triangle count string
after the page settles (use `--virtual-time-budget=6000`, longer than the heightfield
check's 4000, since the density rebuild is heavier).

```bash
chrome.exe --headless=new --disable-gpu --no-sandbox --virtual-time-budget=6000 \
  --screenshot="density_shot.png" --window-size=1400,1000 \
  "http://127.0.0.1:8080/terrain-generator-v4.html"
```
Expected: a non-blank screenshot (verify by checking the file size is well above a few KB).

- [ ] **Step 2: Update `docs/subsystems/biomes.md`**

Find this paragraph:
```
> `../../terrain-generator-v4.html` covers the same generation pipeline in more depth
> (erosion simulation, sea/lake/mountain/rock/snow masks, material masks) with the full
> `config.py` field surface exposed as sliders, plus an interactive Three.js heightfield
> viewport (direct grid-to-mesh, independent resolution, orbit/pan/zoom, display-mode
> vertex coloring).
```
Replace with:
```
> `../../terrain-generator-v4.html` covers the same generation pipeline in more depth
> (erosion simulation, sea/lake/mountain/rock/snow masks, material masks) with the full
> `config.py` field surface exposed as sliders, an interactive Three.js heightfield
> viewport (direct grid-to-mesh, independent resolution, orbit/pan/zoom, display-mode
> vertex coloring), and a density-field panel that marching-cubes-extracts the real
> cave/warp-aware volumetric pipeline (`volumetric_mesh.py`'s `build_density_field`) into
> a smooth mesh, with an "Export to maps/" button that writes a real playable map (GLB +
> `-data.json` + a `map-config.json` entry) via a local `serve.py` endpoint -- the same
> `maps/` directory `terrain-loader.js` reads at runtime.
```

Find:
```
- The 18-name list, `TREE_DENSITY`, `BIOME_MATERIAL`, and `MASK_ALIASES` are three
  independently-maintained tables (`terrain-loader.js`, `terrain-textures.js` ×2) keyed
  by the same biome-name strings — there's no shared enum/import. Adding a new biome
  name means updating all of them, or a map exporting that name silently falls back to
  `'grass'`/density `0`.
```
Replace with:
```
- The 18-name list, `TREE_DENSITY`, `BIOME_MATERIAL`, and `MASK_ALIASES` are three
  independently-maintained tables (`terrain-loader.js`, `terrain-textures.js` ×2) keyed
  by the same biome-name strings — there's no shared enum/import. Adding a new biome
  name means updating all of them, or a map exporting that name silently falls back to
  `'grass'`/density `0`. `terrain-generator-js.js`'s `GRASS_DENSITY` (used only by
  `terrain-generator-v4.html`'s map-export path) is a fourth, separate table for a
  different purpose (export-time grass density vs. `TREE_DENSITY`'s runtime tree density).
```

- [ ] **Step 3: Append to `agent_log.csv`**

Add one row:
```
2026-07-03T12:00,terrain,"terrain-generator-v4.html;terrain-generator-js.js;biome-classifier-js.js;serve.py;test-terrain-generator-js.mjs;docs/subsystems/biomes.md","Added Phase D to terrain-generator-v4.html: a density-field panel that ports volumetric_mesh.py's cave/warp density field and extracts it with a from-scratch JS marching-cubes implementation into a smooth Three.js mesh, plus an Export to maps/ button (GLTFExporter + a new serve.py /api/save-map endpoint) that writes real playable maps."
```

- [ ] **Step 4: Run the full test suite one more time**

Run: `node test-terrain-generator-js.mjs`
Expected: all tasks pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add docs/subsystems/biomes.md agent_log.csv
git commit -m "docs(terrain): document Phase D's density-field panel and map export in biomes.md, log the change"
```
