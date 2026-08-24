# Base Game plants — full plan

STATUS 2026-08-23: authored, nothing built. Roadmap step 11 ("moisture-driven plants and other
world dressing", `docs/subsystems/base-game.md:358`). Terrain (Phases 1–9) and water (W1–W7) are
shipped; W8 swimming runs in parallel and touches none of these files.

## Goal

Grass, trees and understory plants over the infinite streamed terrain in `base-game.html`: one
placement authority shared by all three, deterministic from the room's seed so every peer sees the
same forest, streamed in a window around the player, gated by the same ground classification the
ground textures already use, and each layer independently toggleable, saved and measured.

## Facts the plan rests on (measured in the code, not assumed)

- **Base Game has no vegetation code at all.** The donors are `environment-viewer.html` (grass,
  forest, plants, dressing — the only host with streaming) and `bot-viewer-v3.html` via
  `bot-trees.js`/`bot-flora.js` (a bounded arena, one chunk, no streaming). The generators
  themselves (`trees.js`, `plants.js`, `grass.js`, `forest-gpu.js`, `plants-gpu.js`,
  `grass-compute.js`, `forest-palette.js`, `forest-placement.js`, `plants-placement.js`) are
  host-agnostic already and are reused unchanged apart from the two API additions below.
- **No source fills a biome field, but every piece needed to fill one exists.**
  `terrain-source-v5.js` exposes only `heightAt`, `heightAtSpacing`, `densityAt`, `surfaceYAt`, and
  `base-game-terrain.js:224` says outright that "biome/material masks from v5 are not streamed yet".
  What is already built:
  - **The tile contract reserves the fields.** `terrain-source.js:8`
    `TILE_FIELDS = ['heights','normals','biomeIds','materialFields','moisture','holeMask','volume']`,
    dimension-validated at `:105`–`:109`, added to the worker transfer list at `:126`, and requested
    per tile through `req.fields` — the same opt-in `buildTile` already uses for `normals`
    (`terrain-source-v5.js:276`). Nothing fills them and `terrain-system.js` never reads them.
  - **The classifier is pure and per-cell.** `biome-classifier-js.js:70`
    `classifyBiomeCell({ height, slope, temp, humid, weird, beachMask, seaLevel, cfg })` returns one
    of 17 biomes and has its own Node test. Production calls it **zero** times.
  - **Its noise inputs are already per-point and already instantiated.**
    `createUnboundedFieldSampler(seed)` samples `temperature`, `humidity` and `weirdness` at any
    `(x, z)`, and `terrain-source-v5.js:114` constructs one for the classic height layer. Slope comes
    from the tile's own grid, whose apron covers the borders. So per-tile classification is seam-free
    with no global pass: every input is a continuous function of position.
  - **The v5 project already carries an authored biome paint layer.** `terrain-project-v5.js:75`
    validates `paint.biomeOverride` (one byte per paint cell, 255 = none), which `finishGrid`'s
    `opts.biomeOverride` consumes in the grid path. A streamed classifier must honour it the same way.
- **What is genuinely not per-point is the flow-dependent half.**
  `terrain-generator-js.js`'s pipeline (`generateNoiseFields` → `simulateErosion` →
  `buildDerivedMaps` → biome → `buildMaterialMasks`) is grid-only and bounded, and
  `buildDerivedMaps`'s `beachMask` multiplies in a `lakeMask` built from `flowAccumulation`'s
  receiver graph. `createClassicHeightPoint` is the only piece ever made unbounded. So flow, lakes
  and erosion-derived materials wait for roadmap step 9; the noise-and-slope biome terms do not.
- **There is a complete consumer precedent, for bounded authored maps only.** `terrain-loader.js` +
  `terrain-textures.js`, documented in `docs/subsystems/biomes.md`: a map's `-data.json` carries
  `biomeIds`/`biomeNames` plus optional `grassDensity`/`treeDensity` grids, and the loader exposes
  `biomeAt(x, z)` (`:216`), `treeDensityAt(x, z)` and `surfaceField(x, z)` (`:243` — feathered
  material weights, moisture proxy, upness, written O(1) so placement loops can call it). Those feed
  the ground texture, the grass `densityTex`/`densityTexBounds`, and the forest's per-candidate
  dart-throw rejection. `moisture-proxy.js` is the moisture term inside that seam. Base Game needs the
  same three functions over streamed tiles rather than a bounded grid.
- **The ground already classifies itself.** `terrain-splat-streamed.js` `splatWeights(height,
  normalY, cfg)` is the CPU twin of the shader's `[sand, grass, dirt, rock, snow]` weights, and it
  is what the terrain is textured with. Any second definition of "where grass grows" would visibly
  disagree with the ground under it.
- **A streamed height window already exists and is generic.** `terrain-sea-depth.js`
  `createSeaDepthMap({ source, spacing, tileIntervals, tilesPerSide })` is a thin wrapper over
  `terrain-clipmap-window.js`: a toroidal window filled by `sourceTile` worker jobs at a chosen post
  spacing, exposing `heightAt(x,z)` (CPU bilinear), `gpuHeightAt(xz, fallback)` (TSL bilinear),
  `covers`, `minHeight`, `recentre`, `update`, `setSource`. The water instance runs at 16 m posts
  over 5.1 km. Nothing about it is water-specific.
- **`grass-compute.js` cannot follow a moving height window today.** Its TSL `heightFn` is chosen at
  construction: `heightTex` + `heightTexBounds` (fixed authored-map bounds, no setter in the
  returned API) or the closed-form `terrain-field` twin. It also has a `densityTex`/
  `densityTexBounds` path already wired into both cull kernels — that is where a moisture mask
  belongs.
- **`forest-gpu.js` writes world positions straight out of `positionNode`** (`instanceNodes`,
  `:231`), the billboard node reads the TSL `cameraPosition` (`:250`), and `grass-compute.js` /
  `plants-gpu.js` cull against a `uCam` uniform fed from `camera.position` (`grass-compute.js:491`,
  `plants-gpu.js:285`). All four are therefore in the *render-local* frame, which is only the same
  as the global frame while the render origin is `(0,0,0)`. `base-game-terrain.js:221` handles a
  rebase by shifting its root; a flora root cannot do that, because shifting the root would move the
  instances out from under `uCam` and `cameraPosition`.
- **The streaming host is inline in `environment-viewer.html`, three times.** `syncPlantsToFocus` /
  `processPlantBuildQueue` (`:5584`–`:5650`) is a windowed chunk lifecycle — desired-key set from a
  camera cell, clear queue, build queue with a per-frame chunk/ms budget — duplicated with small
  edits for the forest and the dressing. It is good code in the wrong place.
- **Authored families are empty and localStorage-bound.** `families/manifest.json` and
  `plant-families/manifest.json` are both `[]`; the only host that consumes authored species,
  `bot-viewer-v3.html`, reads `tree-viewer.html`'s localStorage through `tree-families-store.js`.
  `serve.py` writes both directories but has no list route for either.
- **Terrain scale.** Near heightfield chunks are 30 m at radius 3 (±105 m) and are drawn at
  `round(30 × 0.75) = 23` segments, about **1.3 m posts**; everything past that is the clipmap far
  LOD (post0 2 m) or the volume cascade. So trees at any useful draw distance stand over the far
  rings, not over near chunks.
- **The weather plan already specifies the fine height window this needs.**
  `2026-08-23-base-game-weather.md` R1b builds a second `createSeaDepthMap`-style window at
  `post: 1.25`, `tileIntervals: 16`, `tilesPerSide: 8` (128² posts, a 160 m window, 64 KB) and
  composes it over the 16 m water window through `gpuHeightAt`'s existing fallback node. It also
  records the caveat that `terrain-clipmap-window.js:72` requests `lod: level + 1`, so a window is
  band-limited at its own spacing while the exact chunks request lod 0. Rain and flora want the same
  surface; there must be one window, not two.
- **`terrain.groundHeight(x,z)` is `source.heightAt`** — a full v5 stack evaluation on the main
  thread, per call. Fine for one spawn, not for thousands of placement samples per chunk.

## Decisions

- **The terrain source classifies biomes; flora only consumes them.** `terrain-source-v5.js`
  fills `tile.biomeIds` and `tile.moisture` when the request asks for those fields, using the
  classifier that already exists rather than a flora-private rule set. Filling a reserved field with
  the module written for it beats adding a parallel definition of what grows where, and the ground
  material gets biome masks out of the same work — the gap `base-game-terrain.js:224` names.
- **Flora consumes the `terrain-loader.js` seam, not a new one.** `base-game-terrain.js` exposes
  `biomeAt(x, z)`, `moistureAt(x, z)`, `treeDensityAt(x, z)` and `surfaceFieldAt(x, z)` with the
  same shapes and defaults the authored-map loader already gives `forest-placement.js` and
  `grass-compute.js`. Both consumers are then wired the way they are wired today, and an authored map
  and streamed terrain look the same to them.
- **Moisture is one term, not a system.** `moisture-proxy.js`'s shore band and elevation dryness,
  keyed by the streamed biome through the existing `BIOME_MOISTURE` table, are what `tile.moisture`
  holds until hydrology publishes a real field. The swap then happens inside `buildTile` and nothing
  downstream changes.
- **Cover still reconciles with the ground texture.** `flora-field.js` shrinks to the reconciliation
  layer: `coverAt(biome, moisture, splatWeights(height, normalY))` → `{ grass, plant, tree }`, so a
  biome that says forest cannot grow trees on ground the splat material is painting as bare rock.
  Pure JS, Node-tested, with a hand-synced TSL twin for the grass density mask, declared as a CPU/GPU
  twin in the repo's existing sense (`forest-cull.js`, `light-cluster.js`, `post-grade.js`).
- **Height comes from one shared fine window owned by the terrain facade,** not from
  `source.heightAt` and not from the ground mesh. `terrain-sea-depth.js` is renamed
  `terrain-height-window.js` (export `createHeightWindow`, `createSeaDepthMap` kept as a re-export so
  the water call site is untouched), and `base-game-terrain.js` grows `terrain.heightWindow` at the
  weather plan's R1b settings (`post: 1.25`, 160 m) with reference counting: rain and flora each ask
  for it, it streams while anyone holds it, and it is independent of `setSeaDepthActive` so flora
  works with water disabled. Whichever of the two plans lands first builds it. Its CPU `heightAt`
  serves placement, its `gpuHeightAt` serves grass, composed over the coarse water window by the same
  fallback node R1b uses.
- **Trees are placed on the coarse window and corrected on approach.** The fine window is 160 m and
  trees draw to a kilometre, so a distant chunk is placed against the 16 m window (band-limited, so
  a cliff-top trunk can be metres out) and its records are re-uploaded with fine-window heights when
  the chunk enters the fine window — the same re-upload path the rebase uses, no re-placement and no
  RNG re-draw. Error at distance is invisible; error underfoot is corrected before it can be seen.
- **Placement records are stored global and uploaded render-local.** The chunk host keeps every
  record in global coordinates (the roadmap's canonical frame); on upload it subtracts the current
  render origin. `worldCoordinates.onRebase` re-uploads the resident chunks with the new origin — no
  re-placement, no RNG re-draw, no module change to `forest-gpu.js`/`plants-gpu.js`, and the
  billboard/`uCam` frame stays consistent. Flora meshes stay parented to the scene, never to a
  shifted root.
- **The chunk host is extracted once**, as `flora-chunks.js` (pure, no three.js): desired-set diff
  from a camera cell, clear/build queues, per-frame chunk and millisecond budgets, `rebuildAll`.
  `base-game-flora.js` owns the three layers over it. The env-viewer copies are left alone —
  porting them is not this plan's job.
- **Two small additions to shipped modules**, both default-off so no existing host changes
  behaviour: `grass-compute.js` accepts an injected `heightNode(xz)` TSL function (used instead of
  building its own `heightFn`) and a `densityNode(xz)`. Nothing else in the donors changes.
- **v1 flora does not collide and is not replicated.** Placement is a pure function of
  `(floraSeed, chunk, slot)`, so every peer computes the same forest from the room's seed with no
  network traffic. Trunk colliders would have to exist on the server too, which means running
  placement server-side; that is a later phase, listed under limits, not smuggled in here.
- **Species come from the procedural generator** (`buildSpecies`) as env-viewer does, with
  `params.speciesTable` left as the seam. Authored families are a follow-on that needs a
  `/api/list-families` route and a file loader — never localStorage.
- Every layer is a toggle in the Base Game panel, in `DEFAULT_SETTINGS`, in the state file, and in
  the performance capture. Slider ranges are set wide and never narrowed for performance.

## Phases

### F1 — Biome and moisture fields in the terrain source

- New `terrain-biome-point.js` (pure, no three.js): `createBiomePoint(cfg, sampler, { seaLevel })` →
  `classifyTile(heights, texels, step, originX, originZ, spacing)` returning `{ biomeIds:
  Uint8Array, moisture: Float32Array }`. Per cell: slope by central difference over the tile grid
  (the apron supplies the borders), `temperature`/`humidity`/`weirdness` from the unbounded sampler
  at `cfg`'s periods and octaves, a local `beachMask` (`buildDerivedMaps`'s height and slope terms
  without the lake factor), then `classifyBiomeCell`, then `moistureProxyForBiome(biome, height,
  seaLevel)`. `paint.biomeOverride` wins per cell where the project has one, as `finishGrid` does.
  Band-limited exactly like the heights: at `lod >= 1` the slope and the noise periods use the tile's
  `spacing`, so a coarse tile reads as one large biome instead of dissolving into speckle.
- `terrain-source-v5.js` `buildTile` gains `if (req.fields.includes('biomeIds'))` /
  `('moisture')` blocks beside the existing `normals` block, and the source gains per-point
  `biomeAt(x, z)` / `moistureAt(x, z)` for CPU queries that are not tile-shaped.
  `terrain-source-analytic.js` returns a single constant biome so the analytic world and the
  Traversal Lab stay valid consumers.
- Tests `test-terrain-biome-point.mjs`: a tile's classification is identical whether it is computed
  as one tile or as four quarter-tiles with aprons (the seam test); a biome-override cell wins; a
  point below sea level classifies as ocean; moisture is monotone in height and in shore distance;
  `validateTileResult` accepts the new fields.

### F2 — The streamed biome seam on the terrain facade

- `terrain-system.js` keeps `biomeIds`/`moisture` on the resident chunk (it already receives the
  whole tile), and requests them only while a consumer has asked for them, the way the sea-depth
  window is streamed only while water is on.
- Beyond the resident chunks, a `createHeightWindow`-style window carries biome and moisture at a
  coarse spacing so placement past the near ring still has a field to read — the same toroidal
  machinery, a `Uint8` payload beside the float one.
- `base-game-terrain.js` exposes `biomeAt`, `moistureAt`, `treeDensityAt` (the `TREE_DENSITY` table
  from `terrain-loader.js`, or an authored grid later) and `surfaceFieldAt`, each falling back to a
  neutral default where nothing has streamed yet, so a placement loop never blocks on residency.
- The ground material can now take biome masks; that is left as a follow-on so this phase stays
  about the field, not about textures.
- Test `test-base-game-terrain-biomes.mjs`: the facade's `biomeAt` agrees with the source's at
  sampled points inside and outside the resident window; defaults where nothing is resident.

### F3 — `flora-field.js`: reconciling cover with the ground texture

- `coverAt(biome, moisture, weights)` over `splatWeights()` → `{ grass, plant, tree }`; the biome
  sets the ambition, the splat weights veto it on rock, sand and snow.
- TSL twin `floraDensityNode(...)` for the grass mask, same constants, same order of operations.
- Test `test-flora-field.mjs`: a forest biome on a rock-weight slope grows nothing; below sea level
  is bare; the grass band peaks where `splatWeights` says grass; CPU/GPU twins agree at sampled
  points (via `tsl-build-check.mjs`).

### F4 — `flora-chunks.js`: the streaming host

- `createFloraChunks({ chunkSize, radiusChunks, budgetChunks, budgetMs })` → `syncToFocus(x, z,
  rebuildExisting)`, `drain(now)`, `onBuild(cb)`, `onClear(cb)`, `resident`, `stats`. Lifted from
  `environment-viewer.html:5584`–`5650`, generalized, no three.js import.
- Test `test-flora-chunks.mjs`: window diff on a cell crossing, budget honoured, `rebuildExisting`
  clears then requeues, keys never leak between the build and clear queues.

### F5 — Grass (`base-game-flora.js`, grass layer)

- `terrain.heightWindow` (built here if the rain phase has not already built it); `grass-compute.js`
  gets `heightNode: window.gpuHeightAt` and `densityNode: floraDensityNode(biomeWindow)` — the same
  per-blade density gate an authored map drives through `densityTex` today, fed by the streamed
  biome and moisture instead of a baked `grassDensity` grid. The grass radius is clamped to the fine
  window's half-extent, since beyond it blades would plant on a 16 m surface.
- Water gate from `terrain.seaLevel` (`setWaterLevel`), wind and sun from the lighting rig,
  `grass-look.js` toggles exposed (sway, curl, coverage, root shade, translucency).
- Frame loop: `grassWindow.recentre/update` then `grass.update(seconds)` inside a `grass` profiler
  slot; the layer is skipped entirely when disabled or when the world mode is not terrain.
- Panel: enable, density, radius, cull start, blade height/width, style, wind, look toggles.
- Test: a `tsl-build-check.mjs` case for the injected-node grass material; the injected `heightNode`
  path asserted against the window's CPU `heightAt` at sampled cells.

### F6 — Trees (forest layer)

- `createForestPalette` bake at startup (variants × species), `forest-gpu.js` renderer, records from
  `placementRecords(chunks, params, heightAt, biomeAt)` — the facade's `biomeAt` and
  `treeDensityAt`, passed as `params.treeDensityAt` so `placementsForChunk()` dart-throws candidates
  exactly as it does on an authored map. `flora-field.js`'s `coverAt` is the second gate, vetoing
  what the splat weights say is bare.
- Height correction on approach: a chunk entering the fine window has its records' Y re-sampled and
  re-uploaded (Decisions).
- LOD distances and `maxDrawRadius` derived from the terrain's `farExtent`, not hardcoded.
- Rebase: re-upload resident chunks with the new origin (Decisions).
- Panel: enable, density, draw radius, LOD distances, scale, cone cull, leaves double-sided, shadow
  casting.
- Test `test-base-game-flora.mjs`: same seed and chunk → identical records; a record's height equals
  the window's `heightAt`; records never land where `coverAt().tree` is zero; a desert chunk and an
  ocean chunk produce none.

### F7 — Understory plants

- `createPlantPalette` + `plantPlacementRecords` + `plants-gpu.js` on the same host and the same
  records pipeline, density scaled by `moisture` so wet ground reads lush and ridges read bare —
  the visible payoff of step 11's "moisture-driven".
- Panel: enable, density, cull radius/start, clustering, variation, wind.

### F8 — Determinism across peers

- `floraSeed` joins `BASE_GAME_SHARED_KEYS` (owner-only online, sanitized, folded into
  `worldVersion`) so a room's forest is one forest. No per-instance replication.
- Test `test-base-game-rooms-flora.mjs`: the same seed and terrain descriptor produce identical
  chunk records on two independently constructed hosts.

### F9 — Panel, persistence, docs, perf record

- One "Plants" section: the three enables plus each layer's block, saved with the page state file.
- Performance captures gain grass/forest/plant draw counts, instance counts and layer timings beside
  the existing terrain and water blocks.
- Docs: a plants section in `docs/subsystems/base-game.md`; the two API additions and the new
  modules in `vegetation.md`; the tile fields, the biome point module and the window rename in
  `terrain.md` and `water.md`; and `biomes.md`, whose "the procedural infinite terrain has no biome
  concept at all" stops being true at F1 — it becomes the page that documents both paths.
  `agent_log.csv` rows per phase.

## Order and parallelism

F1 → F2 → F3 → F4 → F5 → F6 → F7 → F9, with F8 available from F1 (it is one shared key and a test)
and F6/F7 sharing everything but the palette. F5 is the first thing visible in the browser and the
first honest performance number. F1 and F2 are the phases that outlive this plan: they are what the
ground material, the minimap and any later ecology read too.

## Known limits to state, not hide

- Moisture is a proxy until regional hydrology (roadmap step 9) exists. It is shaped like the real
  thing and enters through one function, but it is not derived from flow.
- The streamed `beachMask` drops `buildDerivedMaps`'s lake factor, which needs a global flow graph,
  so inland depressions can read as beach until hydrology lands. Sea beaches are correct.
- Biomes on coarse LOD tiles are classified from band-limited height and slope, so a distant
  hillside can carry a different biome than it will once the fine tile arrives. It changes ground
  tint and species mix at range, not placement, because flora places from the near field.
- Flora reads the open-sky heightfield, so in volumetric mode nothing grows on cave floors or
  overhangs, and a tree may stand over a cave roof that `surfaceYAt` would have placed lower.
  `grass-compute.js`'s anchor mode is the eventual answer and needs chunk-mesh anchors.
- Nothing collides: the player walks through trunks in v1.
- Species are procedural. The authored families in `families/`/`plant-families/` are empty on disk
  and reachable only through another tool's localStorage.
- The fine window is band-limited at its own 1.25 m spacing (the `lod: level + 1` caveat in R1b)
  while the exact chunks request lod 0, so a blade on a sharp crest can still float or sink by a few
  centimetres. Anything narrower than a post — a boulder, a ledge — is invisible to it.
- Trees beyond 160 m stand on the 16 m surface until the player walks toward them. On a bluff that is
  metres of error, visible as a trunk correcting its height at the window edge if the correction pass
  is ever skipped.
