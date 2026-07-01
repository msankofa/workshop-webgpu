# Biomes

> Cross-cutting reference, not a standalone subsystem — biome data has no lazy-loaded
> module of its own. It's a per-map data grid produced by an offline authoring pipeline
> and consumed by [terrain](terrain.md) (ground texture, height/grass/tree queries) and
> [vegetation](vegetation.md) (tree placement density, grass blade density).
>
> For an interactive, visual walkthrough of both halves of this system (the offline
> classifier and the runtime consumers), open `../../biome-explainer.html` (via `python
> serve.py`, same as the rest of this directory).

## What a "biome" is here

A biome is just a name (`"forest"`, `"desert"`, ...) attached to one cell of a
`resolution × resolution` grid stored in an authored map's `-data.json` sidecar. There is
no runtime biome *simulation* — no temperature/moisture fields, no blending logic beyond
bilinear sampling of whatever grid values the map file contains. Biomes only exist for
**authored maps** (`loadTerrainMap()` in `terrain-loader.js`); the procedural infinite
terrain (`terrain-system.js` / `cdlod-terrain.js`) has no biome concept at all — it's a
single ground everywhere.

## Canonical biome list

18 names, used consistently across the codebase (order matches `biomeNames` in exported
map data and the `TREE_DENSITY` table below):

```
deep_ocean, ocean, beach, desert, badlands, savanna, plains, forest, dark_forest,
jungle, swamp, taiga, snowy_taiga, snowy_plains, stony_peaks, snowy_peaks,
windswept_hills, meadow
```

These are Minecraft-style biome names inherited from the (external, not-in-this-repo)
map authoring/export pipeline — see `docs/superpowers/plans/2026-06-26-authored-map-pipeline.md`
for the terrain-v3 Python side (`biome_classifier.py`, elevation/temperature/moisture →
biome id) that actually assigns ids. That pipeline is not present in this JS codebase;
this repo only *reads* the grid it produces.

## Data flow

1. **Export.** A map's `-data.json` carries `biomeNames: string[]` (the id → name table)
   and `biomeIds: Uint8Array`-shaped `number[]` (one id per grid cell, row-major
   `resolution × resolution`), alongside `grassDensity` and optionally `treeDensity`
   float grids. Example: `maps/workshop/test_export-data.json`.
2. **Load (`terrain-loader.js`, `loadTerrainMap()`).** Wraps the raw grids in
   `biomeAt(x, z)` (nearest-cell lookup, world→grid via `nearestIndex`, defaults to
   `'plains'` out of bounds or when `biomeIds` is empty) and `treeDensityAt(x, z)`
   (bilinear-samples an explicit `treeDensity` grid if the map shipped one, else falls
   back to the hardcoded `TREE_DENSITY[biomeAt(x, z)]` table below).
3. **Ground texture (`terrain-textures.js`, `applyTerrainTextures()`).** Per-vertex,
   picks a texture layer from `mapData.materialMasks`/`materialWeights` if the map
   authored explicit paint masks; otherwise falls back to `BIOME_MATERIAL[biome]`
   (biome name → one of the 13 `TERRAIN_TEXTURE_LAYERS`), then overrides by slope/sea
   level (steep → `rock`/`dirt`, near `seaLevel` → `beach`/`sand`). Per-triangle the
   three vertex picks are reduced to one dominant material (`dominantMaterial`) and
   geometry is split into index-buffer groups, one per material layer.
4. **Grass density (`environment-viewer.html` → `grass-compute.js`).** If the map
   shipped a `grassDensity` grid, `loadedMap.grassDensityGrid` is baked into a
   `DataTexture` (`makeFloatDataTexture`) and passed as `densityTex`/`densityTexBounds`
   to `createComputeGrass()`. The GPU cull kernel samples it per-blade-slot
   (`densityFn` → `biomeDensity`) and gates survival with `densityRand.lessThan(biomeDensity)`
   — no texture means every cell defaults to density `1.0` (uncapped by biome).
5. **Tree density (`environment-viewer.html` → `forest-placement.js`).** `treeDensityAt`
   is passed straight through as `params.treeDensityAt`; `placementsForChunk()` dart-throws
   each candidate placement against it (`hash2(...) > density` rejects the point), so
   biomes with `TREE_DENSITY = 0` (ocean, desert, snowy peaks) never grow trees even if a
   placement point lands there.

## Biome → texture layer fallback (`terrain-textures.js`)

| Biome | Texture layer |
|---|---|
| `deep_ocean`, `ocean` | `sand` |
| `beach` | `beach` |
| `desert` | `desert` |
| `badlands` | `dirt` |
| `savanna` | `savanna` |
| `plains` | `grass` |
| `forest`, `dark_forest`, `jungle` | `forest` |
| `swamp` | `swamp` |
| `taiga` | `taiga` |
| `snowy_taiga`, `snowy_plains`, `snowy_peaks` | `snow` |
| `stony_peaks` | `rock` |
| `windswept_hills` | `gravel` |
| `meadow` | `meadow` |

Overridden regardless of biome when `worldY <= seaLevel - 0.5` → `sand`,
`seaLevel - 0.5 < worldY <= seaLevel + 1.5` → `beach` (unless already `desert`), or slope
(`1 - |normalY|`) exceeds `0.58` → `rock` (unless already `snow`) / `0.34` on
grass-family layers → `dirt`.

## Biome → tree density fallback (`terrain-loader.js`, `TREE_DENSITY`)

| Biome | Density | Biome | Density |
|---|---|---|---|
| `deep_ocean` | 0.0 | `taiga` | 0.70 |
| `ocean` | 0.0 | `snowy_taiga` | 0.55 |
| `beach` | 0.03 | `snowy_plains` | 0.05 |
| `desert` | 0.0 | `stony_peaks` | 0.03 |
| `badlands` | 0.04 | `snowy_peaks` | 0.0 |
| `savanna` | 0.20 | `windswept_hills` | 0.18 |
| `plains` | 0.10 | `meadow` | 0.16 |
| `forest` | 0.85 | `dark_forest` | 0.95 |
| `jungle` | 0.90 | `swamp` | 0.45 |

Only used when the map's `-data.json` has no explicit `treeDensity` grid — explicit
per-cell density always wins over this table.

## Notes for anyone touching this

- The 18-name list, `TREE_DENSITY`, `BIOME_MATERIAL`, and `MASK_ALIASES` are three
  independently-maintained tables (`terrain-loader.js`, `terrain-textures.js` ×2) keyed
  by the same biome-name strings — there's no shared enum/import. Adding a new biome
  name means updating all of them, or a map exporting that name silently falls back to
  `'grass'`/density `0`.
- `biomeAt`/`treeDensityAt`/`grassDensityAt` are all nearest-cell or bilinear reads over
  a static grid baked at export time — there's no runtime biome editing or blending
  beyond what bilinear sampling gives you for free at cell boundaries.
- No test file exercises biome logic directly today (`test-terrain-*.mjs` cover the
  height field, not `terrain-loader.js`/`terrain-textures.js`).
