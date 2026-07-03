# Terrain generator v4 — Phase D: density field + marching cubes preview, with map export

## Purpose

Phase D replaces the `node-density` placeholder in `terrain-generator-v4.html`'s node
canvas with a real panel: a JS port of terrain-v3's actual volumetric export pipeline
(`terrain_v3/export/volumetric_mesh.py`'s `build_density_field` + `build_volumetric_glb`),
rendered live as a smooth marching-cubes mesh in its own Three.js viewport (same chrome
pattern as Phase C's heightfield preview), plus the ability to write the result straight
into `maps/` as a real, game-loadable map — the same thing terrain-v3's own
`/v3/export/map` endpoint produces.

This corrects an earlier direction in this same design pass: a blocky/instanced-cube
voxel-cutaway rendering was proposed and rejected in favor of real marching-cubes surface
extraction, because (a) `build_density_field` never reads the fields (`slice_y`,
`cross_x`, `cross_z`, `surface_thickness`) that would have justified a movable-window/2D
approach, and (b) a smooth extracted mesh is both more useful and more faithful to what
the real export pipeline produces than an invented voxel rendering style.

## Non-goals

- **No Phase B (paint authoring).** Still deferred, unrelated to this work.
- **No water simulation or forest/grass placement.** Those remain Phase E's job. This
  phase's export writes the same `map-data.json` fields terrain-v3's real export writes
  (`grassDensity`, `lakeMask`, `materialMasks`, etc.) computed the same way the real
  pipeline computes them today (biome/water-gated lookup tables, no actual grass mesh
  placement or hydraulic water surface) — Phase E's remaining scope is real water
  rendering and forest scatter on top of the exported mesh, not mesh export itself, since
  that's now covered here.
- **No author-layer / paint-mask input to the density field.** Matches the current
  pipeline's real capability (Phase B doesn't exist yet, so `author_layers` stays absent,
  same as it already is for the 2D pipeline).
- **No bit-exact match with a real Python/skimage run.** Same precedent as the existing
  2D noise port: same algorithm (value noise, fBm, marching cubes), JS-native PRNG and
  triangulation implementation, not numerically identical.
- **No second/higher "export quality" resolution.** Export uses whatever density
  resolution is currently set on the panel — no separate offline high-res pass.
- **No display-mode dropdown for the density mesh.** Vertex coloring is always the
  material-mask color sampling (matching `_sample_vertex_colors`, which is also the only
  coloring the real export ever produces) — unlike Phase C's heightfield preview, which
  exists specifically to debug multiple derived fields.
- **No multi-map / batch export.** One folder+name pair, one export button, one map
  written per click.

## Architecture

### Density config schema (`terrain-generator-js.js`)

A second, independent config object (mirrors `DensityPreviewConfig` in
`terrain_v3/density_config.py`), separate from `genConfig` / `DEFAULT_CONFIG` — its own
resolution, not tied to the 2D preview or heightfield resolutions:

```js
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

// [min, max, step] -- transcribed verbatim from density_config.py's DENSITY_FIELD_RANGES,
// same convention as FIELD_RANGES: the real Python range is exposed in full even where
// the panel's own default/slider-start is lower (see "Viewport" section below).
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

// density_config.py's DENSITY_FIELD_LABELS, transcribed verbatim (minus the
// slice_y/cross_x/cross_z/surface_thickness entries, which this port drops).
const DENSITY_FIELD_LABELS = {
  density_resolution: 'voxel res', y_min: 'y min', y_max: 'y max', iso_level: 'iso level',
  warp_period: 'warp period', warp_strength_surface: 'surface warp', warp_strength_global: 'global warp',
  warp_surface_band_sigma: 'warp band', cave_period: 'cave period', cave_threshold: 'cave threshold',
  cave_strength: 'cave strength', floor_thickness: 'floor seal',
};
export function densityFieldLabel(name) { return DENSITY_FIELD_LABELS[name] ?? name.replace(/_/g, ' '); }
export function densityFieldDescription(name) { /* same FIELD_DESCRIPTIONS pattern as fieldDescription; every field in DENSITY_FIELD_GROUPS must have one, checked by the test file same as the existing fieldDescription check */ }
```

`buildGroupControls` in `terrain-generator-v4.html` is generalized to take the config
object, field-groups table, and ranges table as parameters (currently hardcoded to
`genConfig`/`FIELD_GROUPS`/`FIELD_RANGES`), so both the existing 2D panels and the new
density panel share one slider-builder instead of a second copy-pasted version:

```js
function buildGroupControls(container, groupNames, cfg, fieldGroups, fieldRanges, labelFn, descFn, onChange) { ... }
```

Existing call sites pass `genConfig, FIELD_GROUPS, FIELD_RANGES, fieldLabel, fieldDescription, scheduleRegenerate` explicitly; the density panel passes its own config/tables/`scheduleDensityRegenerate`.

### 3D value noise (`terrain-generator-js.js`)

Ports `_value_noise3` / `_fbm3` from `volumetric_mesh.py`: a 3D extension of the existing
2D lattice-noise pattern in `biome-classifier-js.js` (`fade`, `hashSeed`, `mulberry32`),
which are exported (adding the `export` keyword to those three — currently
module-private) so this file can reuse them instead of re-implementing a second
hash/PRNG. `buildLattice3D`/`sampleLattice3D`/`fbm3Sample` are new, local to
`terrain-generator-js.js` (2D lattice helpers stay 2D-specific and untouched):

```js
// Trilinear-interpolated 3D value-noise lattice, sized to the actual extent it needs to
// cover (worldX/worldY/worldZ for this density-field generation) rather than a fixed
// constant -- unlike buildLattice's WORLD_EXTENT-sized 2D lattice, there's no existing
// fixed extent this can safely assume, since y_min/y_max/world_x/world_z are all
// independently configurable per generation.
function buildLattice3D(seed, period, extentX, extentY, extentZ) { ... }
function sampleLattice3D(lattice, x, y, z) { ... } // trilinear + fade, same shape as sampleLattice's bilinear
function fbm3(seed, period, extentX, extentY, extentZ, x, y, z, octaves = 3) {
  // 3 octaves, seed + octave*1299721, period halved per octave, sum/ampSum * 1.35,
  // clamp [-1, 1] -- same normalization as biome-classifier-js.js's sample()
}
```

Called once per voxel for the warp field (seed offset `+201`) and once per voxel for the
cave field (seed offset `+202`), matching `volumetric_mesh.py`'s two independent
`_fbm3` calls.

### Density field (`buildDensityField3D`)

```js
// Mirrors volumetric_mesh.py's build_density_field. heightGrid2D is a generateFullGrid()
// result computed AT densityCfg.density_resolution (a fresh, independent regeneration --
// same reason heightfield_pipeline.py reruns the 2D pipeline at the density resolution:
// erosion/flow are whole-grid algorithms, so there is no per-point height sampling
// shortcut). Returns a Float32Array of length res^3, indexed
// density[ix + iy*res + iz*res*res] (x-fastest -- an internal convention, not required
// to match numpy's (z,y,x) C-order axis layout in the Python source).
export function buildDensityField3D(heightGrid2D, densityCfg, worldX, worldZ, seed) {
  const res = densityCfg.density_resolution;
  const density = new Float32Array(res * res * res);
  for (let iz = 0; iz < res; iz++) {
    const z = (iz / Math.max(1, res - 1) - 0.5) * worldZ;
    for (let iy = 0; iy < res; iy++) {
      const y = densityCfg.y_min + (iy / Math.max(1, res - 1)) * (densityCfg.y_max - densityCfg.y_min);
      for (let ix = 0; ix < res; ix++) {
        const x = (ix / Math.max(1, res - 1) - 0.5) * worldX;
        const h = heightGrid2D.height[iz * res + ix]; // heightGrid2D is res x res, iz-major matching generateFullGrid's own idx = iz*res+ix
        let d = h - y - densityCfg.iso_level;

        const warp = fbm3(seed + 201, densityCfg.warp_period, worldX, densityCfg.y_max - densityCfg.y_min, worldZ, x, y, z);
        const surfaceBand = Math.exp(-((y - h) ** 2) / (densityCfg.warp_surface_band_sigma ** 2));
        d += warp * densityCfg.warp_strength_surface * surfaceBand + warp * densityCfg.warp_strength_global;

        const caveN = fbm3(seed + 202, densityCfg.cave_period, worldX, densityCfg.y_max - densityCfg.y_min, worldZ, x, y, z);
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

`x`/`z` per-voxel world coordinates use the same centering convention as
`buildHeightfieldMesh` (`(i/(res-1) - 0.5) * worldExtent`). The `6.0`/`8.0`/`50.0`
constants in the cave-mask-strength and floor-bias terms are hardcoded in the Python
source too (not config fields) — transcribed as literals here, not new config surface.

### Marching cubes (`terrain-generator-js.js`)

A from-scratch JS port of the classic Lorensen-Cline algorithm (public domain, the same
one `skimage.measure.marching_cubes` implements in C) — no such implementation exists in
this codebase or its `three`/`three/addons` CDN imports, so this is new code:

```js
// Standard 256-entry edge table + triangle table (Lorensen & Cline 1987). Walks every
// cell of the res^3 density grid, classifies its 8 corners against level=0 into one of
// 256 cases, interpolates edge-crossing points linearly along density value, and emits
// triangles per the triangle table. Not a port of skimage's exact code (which is
// C-optimized and licensed separately) -- same public-domain algorithm, independent JS
// implementation, consistent with this codebase's "same algorithm, not bit-exact"
// precedent for the noise functions.
export function marchingCubes(density, res, spacingX, spacingY, spacingZ, originX, originY, originZ) {
  // returns { positions: Float32Array, indices: Uint32Array } -- no normals (computed
  // separately, per-face or via BufferGeometry.computeVertexNormals() in the caller,
  // same as how Phase C's Three.js side already calls computeBoundingSphere() itself)
}
```

Output vertex positions are placed directly in final world space
(`originX + ix_interpolated * spacingX`, etc.) so the caller doesn't need a second
coordinate-remapping pass — `originX/originZ` are `-worldX/2`/`-worldZ/2` (centering, same
convention as the rest of the page) and `originY` is `densityCfg.y_min`.

### Vertex coloring

Ports `_sample_vertex_colors`: for each output vertex, nearest-cell-sample the *same*
`materialRgba` grid the Material masks panel already computes (from the density-resolution
regeneration, not a second grid) using `(vx/worldX + 0.5)`/`(vz/worldZ + 0.5)` fractional
lookup, clamped to grid bounds — identical math to the Python version, just resolved
against the JS-computed grid instead of `hf["colors"]`.

### Grass density (for export)

Ports `terrain_v3/export/biome_density.py`'s `GRASS_DENSITY` table (17 biome names) and
`grass_density_for_ids`, new to `terrain-generator-js.js`:

```js
export const GRASS_DENSITY = {
  deep_ocean: 0.0, ocean: 0.0, beach: 0.15, desert: 0.0, badlands: 0.05, savanna: 0.45,
  plains: 0.75, forest: 0.85, dark_forest: 0.90, jungle: 0.95, swamp: 0.60, taiga: 0.40,
  snowy_taiga: 0.20, snowy_plains: 0.10, stony_peaks: 0.05, snowy_peaks: 0.0,
  windswept_hills: 0.20, meadow: 0.80,
};
export function grassDensityForIds(biomeId, waterMask) {
  // grassDensity[i] = GRASS_DENSITY[BIOMES[biomeId[i]]] * (1 - clamp01(waterMask[i]))
}
```

This is a separate table from `docs/subsystems/biomes.md`'s `TREE_DENSITY` (trees) — both
already independently exist in the real pipeline for different purposes (`biomes.md`
explicitly documents `TREE_DENSITY`/`BIOME_MATERIAL`/`MASK_ALIASES` as three
independently-maintained tables; `GRASS_DENSITY` becomes a fourth, used only by this
export path).

### HTML: `node-density` → `section-density`

`node-density` (currently a dimmed, non-interactive placeholder `<div>`) is replaced with
a real `<section class="panel" id="section-density">`, in place, at the same node-canvas
position/id — no `DEFAULT_LAYOUT`/`CONNECTOR_EDGES` changes needed since the id already
has an entry. Structure mirrors `section-heightfield`:

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

### Viewport chrome

Identical pattern to Phase C's `initHeightfieldViewport` (own `WebGPURenderer`, `Scene`,
`PerspectiveCamera`, `OrbitControls`, ambient+directional light, non-awaited async init
function so a slow/failed WebGPU init can't block the rest of the page, "Reset view"
button restoring a fixed initial camera position/target). Differences:

- Initial density resolution: `64` (not Python's `96` default) with
  `DENSITY_WARN_RESOLUTION = 96` — same "lower default + warning above threshold" pattern
  already used for `preview_resolution` (default 128, warn above 256) and heightfield
  resolution (default 64, warn above 128). Marching cubes over a `res^3` grid in
  single-threaded JS is substantially heavier per cell than either of those, hence the
  lower default despite `DENSITY_FIELD_RANGES` exposing Python's real `32-160` range in
  full.
- Debounce: 500ms (vs. heightfield's 300ms) — same `setTimeout`-based
  `scheduleDensityRegenerate` pattern, just a longer delay given the heavier rebuild.
- No display-mode dropdown, no wireframe checkbox, no hover/tooltip raycast (none of
  these exist for the real export either — the mesh is just material-colored and that's
  the whole point of previewing it).
- Stats line shows: vertex count, triangle count, density min/max, matching the real
  `mesh_stats` the Python export already returns.

### Export

**Client side**, on `density-export-btn` click:

1. Validate `density-export-folder`/`density-export-name` against
   `/^[A-Za-z0-9 _-]+$/` (same charset `map_bundle.py`'s `_SAFE_SEGMENT` enforces) and
   non-empty; show an inline error in `density-export-status` and stop if invalid.
2. Build `mapData` from the current density-resolution grid + mesh:
   ```js
   {
     terrainKind: 'volumetric',
     worldX: genConfig.world_x, worldZ: genConfig.world_z,
     worldYMin: densityCfg.y_min, worldYMax: densityCfg.y_max,
     seaLevel: genConfig.sea_level,
     resolution: densityCfg.density_resolution,
     heightMin, heightMax, // from the density-resolution height grid
     biomeNames: BIOMES,
     biomeIds: Array.from(grid.biomeId),
     grassDensity: Array.from(grassDensityForIds(grid.biomeId, grid.materialMasks.water)),
     lakeMask: Array.from(grid.lakeMask),
     materialMasks: { grass, forest, dirt, sand, rock, snow, water }, // Array.from each, same subset export_map() writes
     density: {
       resolution: densityCfg.density_resolution, isoLevel: densityCfg.iso_level,
       caveStrength: densityCfg.cave_strength, caveThreshold: densityCfg.cave_threshold,
     },
   }
   ```
3. Lazily `import('three/addons/exporters/GLTFExporter.js')`, run
   `new GLTFExporter().parse(densityMesh, onDone, onError, { binary: true })` to get an
   `ArrayBuffer`.
4. Base64-encode the buffer (chunked, 0x8000 bytes per `String.fromCharCode(...)` call,
   to avoid call-stack overflow on large buffers) and `POST` one JSON body
   `{ folder, name, glbBase64, mapData }` to `/api/save-map`.
5. On success (`{ok:true, mapKey, writtenTo}`): show
   `Exported to maps/<mapKey> (<vertexCount> vertices, <triangleCount> triangles, <bytes> bytes)`
   in `density-export-status`.
6. On failure (network error, 404, or `{ok:false, error}`): fall back to triggering two
   plain browser downloads (Blob + `<a download>`, immediately revoked) — `<name>.glb` and
   `<name>-data.json` — same fallback precedent as tree-viewer.html's family export, and
   note in the status line that it fell back to manual download.

**Server side** (`serve.py`), new `/api/save-map` POST handler, following the exact
pattern already established by `/api/save-family` in the same file:

```python
MAPS_DIR = os.path.join(ROOT, 'maps')
_SAFE_MAP_SEGMENT = re.compile(r'^[A-Za-z0-9 _-]+$')

def _safe_under_maps(*segments):
    for seg in segments:
        if not seg or not _SAFE_MAP_SEGMENT.match(seg):
            raise ValueError(f'unsafe path segment: {seg!r}')
    base = os.path.abspath(MAPS_DIR)
    target = os.path.abspath(os.path.join(base, *segments))
    if target != base and not target.startswith(base + os.sep):
        raise ValueError('path escapes maps/')
    return target
```

`do_POST` gains a second branch for `/api/save-map` (content-length cap `60_000_000`,
generous enough for a base64-inflated GLB at the top of the resolution range): decode
the JSON body, `base64.b64decode(glbBase64)`, `_safe_under_maps(folder)` +
`_SAFE_MAP_SEGMENT.match(name)`, write `<folder>/<name>.glb` and
`<folder>/<name>-data.json` (`json.dump(mapData, f, indent=2)`), then upsert
`maps/map-config.json`: load-or-`{}`, ensure `cfg['maps']` dict, and if
`f"{folder}/{name}.glb"` isn't already a key, insert the same default shape
`map_bundle.write()` uses (`displayName`/`gameName` from `name` with `_`/`-` replaced by
spaces and title-cased, `image: ''`, `playable: true`, `mapScale: 1`, `snapStep: 0.5`).
Response: `{'ok': True, 'mapKey': ..., 'writtenTo': ...}` or
`{'ok': False, 'error': str(exc)}` with status 400, matching the family handler's
try/except shape.

## Testing

`test-terrain-generator-js.mjs` gains new assertions (new `--- Task N ---` sections,
following the file's existing plain pass/fail-counter convention, no framework):

- `DENSITY_DEFAULT_CONFIG`/`DENSITY_FIELD_GROUPS`/`DENSITY_FIELD_RANGES` values match this
  spec's transcription of `density_config.py` (spot-check a handful, same style as the
  existing `DEFAULT_CONFIG` spot-checks).
- Every field in `DENSITY_FIELD_GROUPS` has a `DENSITY_DEFAULT_CONFIG` value, a
  `DENSITY_FIELD_RANGES` entry, and a non-trivial `densityFieldDescription`.
- `buildDensityField3D` on a flat height grid (all cells the same height, warp/cave
  strengths set to 0) produces a density field that is positive below that height and
  negative above it (sanity check on the macro `height - y - iso_level` term in
  isolation).
- `buildDensityField3D` with `floor_thickness` > 0 produces strongly positive (solid)
  density at `y_min` regardless of height/warp/cave settings (floor-bias sanity check).
- `marchingCubes` on a synthetic density field that is a perfect sphere (`density = R -
  distance_from_center`) at `level 0` produces vertices whose distance from center is
  close to `R` (within a resolution-dependent tolerance) and a triangle count > 0 —
  the standard sanity check for a marching-cubes implementation.
- `marchingCubes` on an all-positive or all-negative density field produces zero
  vertices/triangles (no crossing).
- `grassDensityForIds` matches `GRASS_DENSITY` table lookups and zeroes out fully-water
  cells.

No test coverage for the export button's network call, GLB serialization, or `serve.py`
endpoint itself (manual/browser-only, same rationale as the rest of this page's UI
wiring) — verified manually per the checklist below instead.

Manual verification (headless Chrome screenshot + DOM dump, same workflow established for
the node-canvas layout): `section-density` renders with a non-empty mesh at default
settings, dragging a slider triggers a debounced rebuild, the resolution warning banner
toggles at the right threshold, "Reset view" restores the camera, and (with `serve.py`
running) clicking "Export to maps/" with a fresh folder/name writes a `.glb` +
`-data.json` pair under `maps/` and adds an entry to `maps/map-config.json` — confirmed by
reading those files after the click, not just trusting the success message.

## Docs / logging

- `docs/subsystems/biomes.md`: add `GRASS_DENSITY` to the "three independently-maintained
  tables" note (becomes four), and mention that `terrain-generator-v4.html` can now write
  real playable maps into `maps/` directly (update the existing paragraph that currently
  only says the page "covers the same generation pipeline... in more depth").
- One `agent_log.csv` row, subsystem `terrain`, files
  `terrain-generator-v4.html;terrain-generator-js.js;serve.py;test-terrain-generator-js.mjs;docs/subsystems/biomes.md`.
