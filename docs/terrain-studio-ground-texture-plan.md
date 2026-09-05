# Terrain studio decides which texture the ground gets

STATUS: slices 1 to 3 shipped and seen working in the browser 2026-09-05. Slice 4 not started.

## The goal

A person picks, in the terrain studio, which texture each kind of ground receives, and the Base
Game shows it. The test case: assign moon textures to every kind of ground and get a moon.

## What exists

- **The runtime has five slots**, not five textures. `terrain-splat-streamed.js` blends sand,
  grass, dirt, rock and snow by height and slope. The names are only folder names: the loader
  fetches `textures/ground/<name>/color.jpg` and `normal.jpg` for each slot. Nothing else in the
  shader cares what the picture is.
- **The texture library is already on disk.** `textures/ground/` holds thirteen role folders
  (grass, forest, meadow, taiga, dirt, savanna, swamp, sand, beach, desert, gravel, rock, snow)
  plus `library/` with raw ambientCG packs (Grass004, Gravel023, Ground003 and so on).
  `catalog.json` records each one's source. Every folder has `color.jpg` and `normal.jpg`.
- **The studio's Material masks step has no inputs.** It computes a seven-way blend (grass,
  forest, dirt, sand, rock, snow, water) from biome, slope and height for the preview, and the
  streamed source drops it: `classifyProject` in `terrain-project-v5.js` lists material masks
  as "not streamed yet".
- **The project file round-trips whole** through `serve.py`, so a new optional top-level key
  reaches the game with no server change.

So the missing piece is one table, saved in the project and read by the game:

```
slot   -> texture folder
sand   -> library/Gravel023
grass  -> library/Ground003
dirt   -> library/Ground023
rock   -> rock
snow   -> library/Gravel041
```

That table is a moon. The thresholds that decide where each slot appears are a second, lesser
control and come after.

## Slices

### Slice 1. The assignment table, end to end

Project gets an optional `material` block:

```
material: {
  version: 1,
  slots: { sand: 'sand', grass: 'grass', dirt: 'dirt', rock: 'rock', snow: 'snow' }
}
```

Missing block or missing slot means today's folder, so every existing project loads unchanged.

Files:

- `terrain-project-v5.js`: `normalizeMaterial` beside `normalizePaint`, `'material'` in
  `TOP_KEYS`. A slot value is a relative folder path with no `..`. About 25 lines.
- `terrain-splat-streamed.js`: `loadStreamedSplatTextures` takes `slots` (a name to folder map)
  instead of assuming folder equals slot. Roughly a five-line change. Keep `basePath`.
- `serve.py`: one GET route `/api/list-ground-textures` that lists every folder under
  `textures/ground/` (top level and `library/`) that has a colour map, with its catalog title
  when there is one. About 20 lines.
- `terrain-generator-v5.html`, Material masks panel: five selects, one per slot, fed by that
  route, bound to `project.material.slots`. A change marks the project dirty and autosaves
  through the existing project store. Show a thumbnail swatch per select so the choice is
  visible without opening the game.
- `base-game.html`, `applyTerrainProjectAtRuntime`: load the project's slots and swap the images
  in place (`replaceStreamedSplatImages`, exposed as `terrain.swapSplatTextures`). The bound
  `THREE.Texture` objects keep their identity, so every splat instance and the grass ground node
  keep their shader graphs and only the pictures and average colours change. No rebuild, so the
  tile, fade, water and rain bindings are untouched. The first load reads the active project's
  slots too.
- Tests: the normaliser (accept, default, reject a `..` path) in `test-terrain-project-v5.mjs`;
  the loader's URL construction in a small new `test-terrain-splat-streamed.mjs` if none exists.
- Docs: `terrain.md`, `terrain-generator.md`, `base-game.md`.

Shipped 2026-09-05. Unseen in a browser: the thing to look at is a slot change while the game
is running, since the in-place image swap relies on three.js re-uploading a texture whose
`image` changed.

### Slice 2. The studio preview shows the chosen textures

Today the material canvas paints flat legend colours. Sample the average colour of each chosen
texture (the loader already computes `average` from the 8x8 downsample) and use those as the
legend colours, and tint the 3D preview mesh's vertex colours the same way. A moon project then
looks grey in the studio before it is ever opened in the game.

Files: `terrain-generator-v5.html` (legend colours from the loaded averages, about 30 lines),
`terrain-generator-js.js` (`buildMaterialMasks` takes a colour table instead of the fixed
`MATERIAL_LEGEND_COLORS`).

Shipped 2026-09-05: `materialRgbaFromMasks(masks, table, out)` recolours the worker's masks on the
page; the averages come from an 8x8 canvas downsample of each chosen `color.jpg`.

### Slice 3. Where each slot appears

Thresholds, so a person can push snow to the whole map or remove sand. The splat already holds
all of them as live uniforms (`shoreTop`, `grassTop`, `dirtTop`, `snowBottom`, `snowTop`,
`rockSlope`, `rockFull`), and `updateStreamedSplat` patches them.

Add them to `material` with the same names, sliders in the studio's Material masks panel and in
the Base Game Terrain section, both writing to the project. The studio's own `rock_slope_*` and
`snow_height_*` cfg values become the defaults when the block does not set them. Slope needs
one conversion, gradient magnitude to `normal.y`.

Files: `terrain-splat-streamed.js` (`splatConfigFromProject`, pure), both pages (sliders),
`terrain-generator-js.js` (preview honours `grassTop`/`dirtTop`), the CPU twin test.

Shipped 2026-09-05 with two narrowings from the text above: the sliders live in the studio only
(the Base Game applies the project's rules but has no sliders for them yet, since a project is a
hashed record and a write-back would need a draft flow), and the studio's material canvas still
draws its own biome/slope masks rather than the splat's height rules. Both are open follow-ups.

### Slice 4. Per-biome assignment (optional, later)

Five slots cannot say "taiga gets this, desert gets that". Tiles already carry `biomeIds`, so a
biome coverage texture beside the LOD coverage maps would let each biome remap slots, or pick
its own texture from a larger array texture. This is the point where the shader changes shape
(a `DataArrayTexture` of up to N layers, which is what shimmered in the old authored splat), so
it is its own plan once slices 1 to 3 are in and a real need shows up.

## What a moon also needs, outside this plan

Textures alone give grey ground. A moon also wants no water plane, no grass, no trees and a
black sky, which are all existing toggles in the Base Game panel. Saving those with the project
would be a "world preset" and is a separate ask.

## Order

1, then 2, then 3. 4 only on request.

## Verification

- Node: the project normaliser test and the loader URL test, and `node test-page-syntax.mjs` on
  both pages before any commit.
- Browser: the user picks a set in the studio, opens the Base Game, and the ground matches.
