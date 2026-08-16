# Terrain generator (authoring tools)

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#terrain)
> Sibling of [terrain.md](terrain.md) (the runtime ground) and [biomes.md](biomes.md) (the
> per-map data grid). This doc covers the in-browser tools that *produce* maps.

## Purpose

`terrain-generator-v5.html` is the map authoring tool: it runs the terrain-v3 pipeline
port (`terrain-generator-js.js`) behind a layered noise stack, adds paint layers,
undo/redo, heightmap import and heightfield/volumetric export, and writes the
`<name>.glb` + `<name>-data.json` pair that `terrain-loader.js` consumes. It merges our
v4 tool with the ideas worth taking from ZyFou/ProceduralTerrains (layer stack in front
of the height field, additive non-destructive delta layers, whole-stroke undo, real-world
heightmap import). Everything heavy runs in a module Web Worker; the page only draws.

`terrain-generator-v4.html` is kept as-is (its export now also writes `heights`).

## Files

| File | Responsibility |
|---|---|
| `terrain-generator-v5.html` | Node-graph canvas UI (forked from v4): panels for noise fields, classic composer, **layer stack**, erosion/hydrology, derived masks, biome rules, material masks, **paint**, **import**, **3D preview**, **export & project**, real-map viewer, reference tables. Owns the worker request queue, history, paint stroke handling, exports. |
| `terrain-gen-worker.js` | Module worker. `{ kind: 'grid' \| 'volume', cfg, resolution, stack, paintHeight, biomeOverride, imports, densityCfg }` → `generateFullGridV5` (+ density field + marching cubes for `volume`, at `density_resolution`, with paint resampled to match). Replies with transferable arrays plus `grassDensity`. |
| `terrain-generator-js.js` | terrain-v3 pipeline port. Now split: `generateNoiseFields(cfg,res)` → `composeClassicHeight(fields,cfg)` → `finishGrid(targetHeight, fields, cfg, res, { paintHeight?, biomeOverride? })`. `generateFullGrid` (v4, unchanged output) and `generateFullGridV5(cfg, res, stackEval, opts)` compose those. `buildDerivedMaps` accepts the flow `receiver` so the O(n log n) sort runs once. |
| `terrain-stack.js` | Layer stack: `LAYER_TYPES` (schema with min/max/step/default/desc per param; `structural` flags), `makeLayer`, `defaultStack`, `normalizeStack`, `structuralSignature`, `evaluateStackGrid(stack, ctx)`, `STACK_PRESETS`, `MAX_LAYERS = 12`. |
| `terrain-noise.js` | Pure primitives: `hash12`, `vnoise2`, `vnoised2` (analytic derivative), `fbm2`/`ridged2`/`billow2` (ROT2 octave rotation, optional gradient-feedback `erosion`/`warp`), `voronoi2`, `terrace`, `domainWarp2`, `seedDomainOffset`, `applyBlend`/`BLEND_MODES`. |
| `terrain-paint.js` | `PaintLayers` (height delta Float32 + biome override Uint8, `NO_OVERRIDE = 255`), `stamp(tool, x, z, brush, ctx)`, five brush shapes, `snapshot`/`restore`, `serialize`/`deserialize` (base64), `resize` resamples. |
| `terrain-history.js` | `History({ getState, restoreState, limit })` — full-state snapshot undo/redo. |
| `terrain-heightmap-io.js` | Pure: `decodeGrayscalePixels`, `resampleToSquare`, `quantizeHeights`, `packRaw16`, `terrariumToMetres`, tile maths, `CURATED_LOCATIONS`. Browser-only: `imageFileToGrid`, `fetchTerrariumGrid` (AWS Terrain Tiles, no key), `heightsToPngBlob`. |
| `biome-classifier-js.js` | Unchanged: noise field sampler, classic composer knots, 17-rule biome classifier. |
| `serve.py` | New `GET /api/list-maps` (every `maps/**/*-data.json`) so the real-map picker sees new exports; `POST /api/save-map` unchanged. |

## Pipeline (one worker job)

```
seed, cfg ──► generateNoiseFields ──► composeClassicHeight ─┐
                                                            ▼
                     layer stack: classic ▸ fbm ▸ ridged ▸ … ▸ terrace   (evaluateStackGrid)
                                                            ▼ targetHeight
                     simulateErosion (flow accumulation + hydraulic + thermal)
                                                            ▼
                     + paint height delta (non-destructive, after erosion)
                                                            ▼
                     buildDerivedMaps ─► classifyBiomeCell (or biome override) ─► buildMaterialMasks
                                                            ▼
                     grid → panels, 3D mesh, export        (volume: + density field + marching cubes)
```

Everything shares one grid at `preview_resolution` (default 160, slider 96–1024). Requests
are coalesced: one job in flight, the newest pending request wins, a pending `volume`
request is never downgraded by a later `grid` request. Timings measured in Node
(2026-08-16): 160² ≈ 130–190 ms, 256² ≈ 270–320 ms per full pipeline; 64³ volume ≈ 700 ms.

## Layer stack semantics

- Sources produce world-unit values: noise types return `[0,1]` (fbm/billow/voronoi are
  recentred to `−0.5..0.5`) × `amplitude`; `classic` is the composer height × `gain`;
  `constant` is `amplitude`; `import` is `grid × amplitude + offset`.
- Each source folds into the running height with `blendMode` (add/subtract/multiply/max/
  min/replace/overlay/carve/flatten) × `opacity` × the optional **height-band mask**
  (`lo..hi` with `feather`, evaluated on the running height *before* the layer).
- Modifiers: `domainWarp` displaces the sample coordinates for every later layer;
  `terrace` quantizes the running height.
- Seeding: `seedDomainOffset(seed)` (integer avalanche hash → ±1024 domain offset) plus a
  per-layer offset from `seedOffset`; no `Math.random()` anywhere in evaluation.
- `structuralSignature(stack)` changes only when layer list shape, blend modes, masks or
  `structural` params (octaves, voronoi modes) change — the hook for a future TSL twin
  that recompiles on structure and streams continuous params as uniforms.

## Paint

Paint lives on the map grid (resampled on resolution change). Tools: raise, lower,
smooth, flatten (to the height under the first stamp), biome (override id), erase. During
a stroke the viewport rewrites vertex Y from `grid.height − paintUsed + paint.heightDelta`
for instant feedback; on pointer-up the grid regenerates (biomes/masks respond) and the
whole stroke is one undo step. Height paint is added *after* erosion, so erosion never
eats a painted feature; biome paint shows as rule `−2` in the biome panel.

## Undo / redo

`History` snapshots `{ cfg, stack, paint (base64), density }` on every committed change
(slider `change`, layer add/remove/reorder/blend/mask, stroke end, preset, import, load).
Slider `input` events regenerate without recording. Ctrl+Z / Ctrl+Y (or Shift+Ctrl+Z).
Imports (raw grids) are not in history; they travel with the project JSON.

## Import

- Image file → luminance → normalized square grid (≤1024²) → new `import` layer.
- Real-world: `fetchTerrariumGrid(lat, lon, km)` picks the zoom that keeps ≤ 6×6 tiles,
  stitches AWS terrarium PNGs, decodes metres, normalizes, and sets the new layer's
  amplitude to the real relief scaled to the world size. Depends on the public S3
  bucket being reachable with CORS; failures surface in the panel status.

## Export contract (unchanged keys, plus `heights`)

Both kinds write `terrainKind`, `worldX/Z`, `worldYMin/Max`, `seaLevel`, `resolution`,
`heightMin/Max`, **`heights`** (row-major, exact), `biomeNames`, `biomeIds`,
`grassDensity`, `lakeMask`, `materialMasks{grass,forest,dirt,sand,rock,snow,water}`, and a
`generator` note. Volumetric adds `density{…}` and exports the marching-cubes mesh at
`density_resolution`; heightfield exports the grid mesh with material vertex colours.
Same `POST /api/save-map` and hosted `publish-map` paths as v4, same download fallback.
Extra downloads: 8-bit heightmap PNG, little-endian RAW16, project JSON (round-trips
config, stack, paint, imports).

## Tests

`node test-terrain-v5.mjs` (395 checks: primitives incl. analytic derivative vs finite
difference, blend modes, stack evaluation/masks/presets/normalize, pipeline split
equivalence with v4, paint tools/serialize/resize, history, heightmap io) and
`node test-terrain-generator-js.mjs` (v4 pipeline, still green).

## Known gaps / next

- No TSL/GPU twin of the noise stack yet; the CPU worker is fast enough at ≤ 256².
- No droplet (particle) erosion; the flow-accumulation model is the only one. ZyFou's
  droplet sim is the reference if a "high quality" mode is wanted.
- Single bounded board; no tiles/infinite/planet modes.
- `bot-viewer-v3.html` does not load maps; only `environment-viewer.html?map=` does.
