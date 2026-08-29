# Base Game plants — full plan

STATUS 2026-08-24: **F1-F5 shipped; F6 (trees) is next.** F3 `flora-field.js` (cover reconciled
against splatWeights, derived per texel at tile commit into three u8 channels — no TSL ecology twin
exists to drift), F4 `flora-chunks.js` (the env-viewer host generalized, plus readiness deferral),
F5 `base-game-flora.js` + injected `heightNode`/`densityNode` on `grass-compute.js` + the Plants
panel section in `base-game.html`. Tests: `test-flora-field.mjs` 28/28, `test-flora-chunks.mjs`
31/31, `test-base-game-flora.mjs` 25/25. **Nothing has been seen in a browser yet** — F5 is the
first phase that draws anything, and its stop-gate capture needs the page. Previously: **F1 and F2
shipped.** F2: the payload/lod generalization of
`terrain-clipmap-window.js`, `terrain-field-scheduler.js` (one pool, deduped, priority-ordered,
cancellable), `terrain-field-window.js` (per-field textures, wrap-aware CPU and TSL readers,
reference-counted registry), and the facade seam on `base-game-terrain.js`;
`test-terrain-field-window.mjs` 38/38 and `test-base-game-terrain-biomes.mjs` 30/30, thirteen
terrain and water suites green. Its stop gate is measured in `terrain.md`: the queue peaks at 0
outstanding, the window is 576 KB, and `update()` costs 0.036 ms/frame standing and 0.518 ms mean
while flying, in the Node path where tiles build on the caller. F3 (`flora-field.js`) is next.
Previously: **F1 shipped** (`terrain-biome-point.js`, `surfaceHeights`/`biomeIds`/`moisture`
on the tile contract, the sampler band limit, `test-terrain-biome-point.mjs` 29/29, twelve terrain
suites still green). Its Node half of the stop gate is measured and recorded in `terrain.md`; the
worker-queue half is owed at F2, since nothing requests the fields yet. F2 is next. Roadmap step 11
("moisture-driven plants and other world dressing", `docs/subsystems/base-game.md:358`). Terrain
(Phases 1–9), water (W1–W8), and weather C1/C2 are shipped; the rain height-window work remains a
shared dependency rather than a second implementation.

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
  - **Authored biome paint is not available to the infinite source.** The finite v5 project format
    carries `paint.biomeOverride`, but `terrain-project-v5.js` rejects paint when it classifies a
    project for the infinite runtime. F1 therefore must not pretend it can honour that finite-grid
    override. The later finite-map source owns that feature.
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
- **Streaming work already has two worker owners.** `terrain-system.js` owns the exact/collision
  tile worker pool (up to four workers), while the sea-depth window owns another source-tile worker.
  Adding independent rain, flora-height, biome and moisture workers would compete with the terrain
  the player is standing on. New field windows must share one terrain-owned scheduler and give exact
  collision/visible terrain priority.
- **The v5 tile height is not always the visible walking surface.** In analytic/heightfield mode
  `tile.heights` is the surface, but the default volumetric source can expose a different open-sky
  `surfaceYAt`. Flora, rain and feet must share that visible surface field. Generating volume meshes
  merely to recover it would be redundant; the tile contract needs an optional `surfaceHeights`
  field, with analytic sources aliasing ordinary heights. **It is not cheap and there is no
  lightweight sampler to fill it**: `surfaceYAt` (`terrain-source-v5.js:179`) scans down in 1 m steps
  from `heightAt + 12` until the density turns solid, then bisects eight times — roughly 20 to 30
  `densityPoint` evaluations per post, so a 33-post tile with its apron costs on the order of 25,000
  3D-noise evaluations. That is the number F1's gate has to survive, and it is why the field is
  optional, requested only in volumetric mode, and filled at the coarse placement resolution rather
  than the fine one.
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
- **The donor renderers have hard scaling multipliers.** `grass-compute.js` allocates its candidate
  capacity from the maximum configured radius, so an artificially wide slider can reserve a large
  buffer even when the current radius is small. Each populated forest variant can add up to eight
  submitted draws across geometry, leaves, billboards and shadows. Radius, variants and enabled
  render parts therefore belong in the resource budget, not only in visual tuning.

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
  It remains pure JS and Node-tested. When a streamed field tile commits, that function precomputes
  compact scalar grass/plant/tree cover channels from biome, moisture, visible-surface slope and
  splat weights. Grass reads the scalar grass channel with one wrap-aware texture load; it does not
  repeat the classifier and splat algebra for every candidate or introduce a hand-synchronized TSL
  ecology twin.
- **The window must request `lod: 0`, or everything it plants floats.**
  `terrain-clipmap-window.js:70` hard-codes `lod: level + 1` ("lod 0 is reserved for exact collision
  tiles"), so a window is band-limited at its own spacing — while the near chunks the player actually
  sees request `lod: 0` (`terrain-system.js:252`, `params.lod` default 0) and are built from exact
  `heightAt`. Planting from a band-limited surface onto an exact one is the roads lesson again: a
  crest is smoothed away in the window and the blades hang in the air over the drawn rock.
  `tileRequest` gains an explicit lod option and the flora/rain window asks for 0. What is left after
  that is only the gap between the mesh's linear interpolation between posts and the field's true
  curve, which is sub-post-scale and absorbed by the bias below.
- **Bias low, never high.** Flora carries a small negative vertical offset
  (`grass-compute.js`'s existing `setVerticalOffset`, and the same constant on trunk and plant
  records). A blade sunk five centimetres is invisible; a blade floating five centimetres shows
  daylight under it. Same asymmetry the rain plan's R1b reasons from.
- **Terrain owns one family of shared field windows,** not one worker/window per feature. The
  underlying clipmap-window machinery gains payload adapters for visible-surface height, biome,
  moisture and precomputed cover, while `terrain-sea-depth.js` keeps its existing public API as the
  water adapter; a rename buys nothing and creates migration churn. A terrain-owned scheduler shares
  workers and a per-frame/job budget across coarse and fine requests, prioritizes exact/collision
  tiles, and reference-counts both resolutions across water, weather and flora. The fine window uses
  the weather plan's R1b footprint (`post: 1.25`, 160 m), requests `lod: 0`, and streams whenever any
  consumer holds it, including when water is disabled.
- **Placement waits for its canonical field; rendering may refine only Y.** A neutral fallback is
  valid for diagnostics but cannot permanently decide that a candidate exists. Forest and plant
  chunks defer/requeue until their required biome/cover and coarse visible-surface fields are
  resident. Candidate identity, species and ecological acceptance use one fixed placement
  resolution, independent of which visual LOD happens to be resident, so approaching a chunk cannot
  repopulate it. Fine-window arrival may only correct record Y before re-upload, with no RNG redraw.
- **Placement records are stored global and uploaded render-local.** The chunk host keeps every
  record in global coordinates (the roadmap's canonical frame); on upload it subtracts the current
  render origin. `worldCoordinates.onRebase` re-uploads the resident chunks with the new origin — no
  re-placement, no RNG re-draw, no module change to `forest-gpu.js`/`plants-gpu.js`, and the
  billboard/`uCam` frame stays consistent. Flora meshes stay parented to the scene, never to a
  shifted root.
- **Grass field sampling crosses the render/global boundary explicitly.** Grass candidates and the
  camera are render-local, while toroidal field windows are indexed globally. The injected adapters
  add `renderOrigin.xz` before height/density lookup and subtract `renderOrigin.y` from sampled
  height. The origin is a uniform mutated on rebase; no TSL graph rebuild occurs.
- **The chunk host is extracted once as code, but instantiated per streamed layer.**
  `flora-chunks.js` (pure, no three.js) owns desired-set diff, clear/build queues, per-frame chunk and
  millisecond budgets, readiness deferral and `rebuildAll`. Forest and understory use separate host
  instances because a kilometre tree radius must not force kilometre-scale understory residency;
  grass remains its existing GPU procedural window and uses no chunk host. The env-viewer copies are
  left alone.
- **Two small additions to shipped modules**, both default-off so no existing host changes
  behaviour: `grass-compute.js` accepts an injected `heightNode(xz)` TSL function (used instead of
  building its own `heightFn`) and a `densityNode(xz)`. Nothing else in the donors changes.
- **v1 flora does not collide and is not replicated.** Placement is a pure function of the terrain
  descriptor, owner-controlled seed offset, canonical field, chunk and slot, so every peer computes
  the same forest with no instance traffic. Every parameter that can alter candidate identity,
  species or acceptance is shared and folded into `worldVersion`; draw distance, LOD, shadows,
  sidedness and layer visibility remain local. Trunk colliders would require the same placement on
  the server and remain a later phase.
- **Species come from the procedural generator** (`buildSpecies`) as env-viewer does, with
  `params.speciesTable` left as the seam. Authored families are a follow-on that needs a
  `/api/list-families` route and a file loader — never localStorage.
- Every layer is a toggle in the Base Game panel, in `DEFAULT_SETTINGS`, in the state file, and in
  the performance capture. Ranges are bounded by measured field coverage and an explicit resource
  estimate; increasing a capacity beyond that is a paused/loading rebuild, never a hidden live
  allocation.

## Phases

### F1 — Biome and moisture fields in the terrain source

- New `terrain-biome-point.js` (pure, no three.js): `createBiomePoint(cfg, sampler, { seaLevel })` →
  `classifyTile(surfaceHeights, texels, step, originX, originZ, spacing)` returning `{ biomeIds:
  Uint8Array, moisture: Float32Array }`. Per cell: slope by central difference over the visible
  open-sky surface (the apron supplies the borders), `temperature`/`humidity`/`weirdness` from the
  unbounded sampler at `cfg`'s periods and octaves, a local `beachMask` (`buildDerivedMaps`'s height
  and slope terms without the lake factor), then `classifyBiomeCell`, then
  `moistureProxyForBiome(biome, height, seaLevel)`. Band-limited exactly like the sampled surface:
  at `lod >= 1` the slope and noise periods use the tile's spacing, so a coarse tile reads as one
  large biome instead of dissolving into speckle. Infinite runtime paint remains unsupported.
- `terrain-source-v5.js` `buildTile` gains `if (req.fields.includes('biomeIds'))` /
  `('moisture')` blocks beside the existing `normals` block. The reserved tile contract gains the
  optional `surfaceHeights` field: v5 fills it from `surfaceYAt` at the cost measured above, while
  `terrain-source-analytic.js` aliases it to `heights` and returns a constant biome so the analytic
  world and Traversal Lab stay valid consumers. The source also exposes per-point `biomeAt(x,z)` /
  `moistureAt(x,z)` for exceptional CPU queries, not placement loops.
- Tests `test-terrain-biome-point.mjs`: a tile's classification is identical whether it is computed
  as one tile or as four quarter-tiles with aprons (the seam test); a point below sea level
  classifies as ocean; moisture follows the biome wetness table and is monotone with height above
  sea level; `validateTileResult` accepts `surfaceHeights`, `biomeIds` and `moisture`; volumetric and
  analytic fixtures prove classification uses their visible surface rather than blindly using base
  height.
- **F1 stop gate:** capture tile generation time, worker queue depth, transferred bytes and exact
  terrain latency with fields off and on, and separately for heightfield and volumetric sources —
  `surfaceHeights` is the expensive one and only the volumetric path pays it. Do not proceed if background field work starves visible or
  collision tiles, even though nothing is visible yet.

### F2 — The streamed biome seam on the terrain facade

- Generalize the existing clipmap-window implementation through payload adapters without replacing
  `terrain-sea-depth.js`'s public water adapter. One terrain-owned scheduler services coarse and
  fine visible-surface, biome, moisture and cover requests; it shares workers, cancellation and a
  budget with deterministic priority below exact/collision tiles. Coarse and fine windows are each
  reference-counted across water, weather and flora.
- Flora does not also request biome/moisture on every render chunk merely because those fields are
  already reserved there; that would compute and transfer the same ecology twice. A later ground
  material consumer may opt render chunks into them for its own reason.
- The coarse toroidal payload carries visible-surface height, biome and moisture at the canonical
  placement resolution. Its biome texture is `RedFormat` + `UnsignedByteType` (`R8Unorm`) rather
  than an integer texture (see TSL specifics). The fine payload serves contact-height consumers and
  requests `lod: 0`.
- `base-game-terrain.js` exposes `biomeAt`, `moistureAt`, `treeDensityAt` (the `TREE_DENSITY` table
  from `terrain-loader.js`, or an authored grid later) and `surfaceFieldAt`, each falling back to a
  neutral default for non-authoritative diagnostics. It also exposes residency/readiness so
  placement defers and requeues instead of baking missing-data defaults into world records.
- The ground material can now take biome masks; that is left as a follow-on so this phase stays
  about the field, not about textures.
- Test `test-base-game-terrain-biomes.mjs`: the facade's `biomeAt` agrees with the source's at
  sampled resident points; wrap-aware reads survive recentres and seams; missing placement fields
  report not-ready; worker priority keeps exact/collision requests ahead of field requests; water,
  weather and flora share rather than duplicate an identical window.
- **F2 stop gate:** capture moving and stationary worker utilization, queue latency, upload bytes,
  field memory and frame time. F2 does not pass with an unbounded queue, duplicate tile requests, a
  growing `renderer.info.memory`, or visible terrain starvation.

### F3 — `flora-field.js`: reconciling cover with the ground texture

- `coverAt(biome, moisture, weights)` over `splatWeights()` → `{ grass, plant, tree }`; the biome
  sets the ambition, the splat weights veto it on rock, sand and snow.
- At field-tile commit, evaluate `coverAt` once per texel and publish compact scalar grass, plant and
  tree cover channels. The grass channel is an `R8Unorm` toroidal texture read with `textureLoad`;
  CPU placement reads the matching scalar arrays. Keep biome available for consumers that need ids,
  but do not make every blade rerun biome/splat classification.
- Test `test-flora-field.mjs`: a forest biome on a rock-weight slope grows nothing; below sea level
  is bare; the grass band peaks where `splatWeights` says grass; scalar cover generation is
  deterministic and wrap-aware GPU loads decode the same quantized value as CPU reads.

### F4 — `flora-chunks.js`: the streaming host

- `createFloraChunks({ chunkSize, radiusChunks, budgetChunks, budgetMs })` → `syncToFocus(x, z,
  rebuildExisting)`, `drain(now)`, `onBuild(cb)`, `onClear(cb)`, `resident`, `stats`. Lifted from
  `environment-viewer.html:5584`–`5650`, generalized only with a `ready(key)`/defer seam, no
  three.js import. Forest and understory instantiate it separately with independently measured
  chunk sizes, radii and budgets. Benchmark a larger logical tree chunk than the donor's 30 m cell
  before accepting thousands of nearly empty far chunks.
- Test `test-flora-chunks.mjs`: window diff on a cell crossing, budget honoured, `rebuildExisting`
  clears then requeues, not-ready keys defer without busy-looping, and keys never leak between the
  build and clear queues.

### F5 — Grass (`base-game-flora.js`, grass layer)

- `terrain.heightWindow` (built here if the rain phase has not already built it); `grass-compute.js`
  gets `heightNode` and `densityNode` as `Fn(([x, z]) => ...)` adapters over the windows' wrap-aware
  samplers (see TSL specifics). The adapter converts render-local candidate XZ to global XZ with the
  render-origin uniform, samples fine-over-coarse visible-surface height and scalar grass cover, then
  converts height back to render-local Y. The grass radius is clamped to the fine window's safe
  half-extent; no outside-window fallback is accepted as ecological placement.
- Water gate from `terrain.seaLevel` (`setWaterLevel`), wind and sun from the lighting rig,
  `grass-look.js` toggles exposed (sway, curl, coverage, root shade, translucency).
- Built once, tuned through setters only (see the review section). Before allocation, compute and log
  candidate/storage bytes from the supported radius and max density. A larger maximum requires a
  paused/loading rebuild after old resources are disposed; a cosmetic slider cannot silently reserve
  for an arbitrary wide maximum.
- Frame loop: `grassWindow.recentre/update` then `grass.update(seconds)` inside a `grass` profiler
  slot; the layer is skipped entirely when disabled or when the world mode is not terrain.
- Panel: enable, density, radius, cull start, blade height/width, style, wind, look toggles.
- Test: a `tsl-build-check.mjs` case for the injected-node grass material; the injected `heightNode`
  and scalar `densityNode` paths asserted against CPU reads at sampled cells before and after a
  toroidal recentre and a non-zero world-origin rebase. Invalid injected node functions throw during
  construction.
- **F5 stop gate:** capture disabled, zero-density, normal, radius-limit, stationary, moving,
  field-recentre and world-rebase cases. Check grass pass time, draws, candidates, visible blades,
  allocated bytes and frame-time spikes before trees begin.

### F6 — Trees (forest layer)

**SUPERSEDED 2026-08-27 by `2026-08-27-base-game-trees.md`.** A comparison of the three existing
tree implementations against this phase found it right about the wiring and silent about the risk:
it derives LOD from `farExtent` (6.1 km, or 0 with far LOD off), inherits a billboard rung that has
no bake path on procedural terrain, uses `coverTree` as a zero-veto so slope and moisture never
thin the forest, keeps `treeCountForChunk`'s window-relative density (which breaks its own F8
determinism test), and says nothing about shadows, wind, the water mirror or the draw-call budget.
The section below is kept as written for provenance; build from the dedicated plan.


- `createForestPalette` bake at startup (variants × species), `forest-gpu.js` renderer, records from
  `placementRecords(chunks, params, heightAt, biomeAt)` — the facade's `biomeAt` and
  `treeDensityAt`, passed as `params.treeDensityAt` so `placementsForChunk()` dart-throws candidates
  exactly as it does on an authored map. `flora-field.js`'s `coverAt` is the second gate, vetoing
  what the splat weights say is bare.
- Candidate identity, species and cover acceptance use the resident canonical coarse field. A chunk
  entering the fine window has only record Y re-sampled and re-uploaded; ecology and RNG do not run
  again.
- LOD distances and `maxDrawRadius` derived from the terrain's `farExtent`, not hardcoded.
- Rebase: re-upload resident chunks with the new origin (Decisions).
- Reuse the renderer's existing controls: `setRenderParts` for bark/leaves/billboards and separate
  bark/leaf shadows, `setTreeScale`, `setLeafScale`, `setFarLeavesDoubleSided`, `setLodDistances`,
  `setMaxDrawRadius`, and cone-cull controls. The panel adds no duplicate material/render path.
- Start with the smallest useful procedural species and variant count. Palette bake and first shader
  construction run during a loading/paused transition, with elapsed time recorded, never on the
  first chunk boundary crossed during play.
- `base-game-flora.js` disposes the previous palette's geometries before baking a replacement —
  `forest-gpu.js`'s own `dispose()` does not reach them.
- Test `test-base-game-flora.mjs`: same seed and chunk → identical records; a record's height equals
  the canonical window's `heightAt`; records never land where scalar tree cover is zero; a desert
  chunk and an ocean chunk produce none; fine-window arrival and render-origin rebase preserve ids,
  species and global XZ exactly.
- **F6 stop gate:** record bark only, leaves only, billboards, bark shadows and leaf shadows
  independently, then the intended combination. Include variants-per-species, populated variants,
  draws, triangles, instances, palette bake time, steady movement and chunk-boundary spikes.

### F7 — Understory plants

- `createPlantPalette` + `plantPlacementRecords` + `plants-gpu.js` on its own `flora-chunks` host and
  the same canonical records pipeline, density read from scalar plant cover so wet ground reads lush
  and ridges read bare — the visible payoff of step 11's "moisture-driven" without inheriting the
  forest's kilometre residency.
- Panel: enable, density, cull radius/start, clustering, variation, wind.
- **F7 stop gate:** capture disabled, normal and maximum supported density while stationary and
  crossing understory chunk boundaries. Record its independent resident-chunk count, build queue,
  instances, draws, triangles, pass time and frame-time spikes; verify changing the tree radius does
  not change understory residency.

### F8 — Determinism across peers

- Derive the default flora seed from the terrain descriptor/hash and expose only an owner-controlled
  seed offset. The offset plus every identity/placement input — tree/plant density, canonical
  placement resolution, clustering, species preset and shoreline/cover gates — joins
  `BASE_GAME_SHARED_KEYS`, is sanitized, owner-only online, and is folded into `worldVersion`.
  Visibility, grass radius, tree draw radius, LODs, shadows, sidedness and quality remain local.
- Test `test-base-game-rooms-flora.mjs`: the same descriptor and shared placement settings produce
  identical records on independently constructed peers even when their local quality settings
  differ; changing one shared placement value changes `worldVersion`; malformed values sanitize to
  the same result. No per-instance replication.

### F9 — Panel, persistence, docs, perf record

- One "Plants" section: the three enables plus each layer's block, saved with the page state file.
- Performance captures gain grass/forest/plant draw counts, instance counts and layer timings beside
  the existing terrain and water blocks, plus worker queue/latency, field bytes, grass candidate and
  buffer capacity, forest populated variants, triangles and palette-build time.
- Docs: a plants section in `docs/subsystems/base-game.md`; the two API additions and the new
  modules in `vegetation.md`; the tile fields, biome point module and shared field-window scheduler in
  `terrain.md` and `water.md`; and `biomes.md`, whose "the procedural infinite terrain has no biome
  concept at all" stops being true at F1 — it becomes the page that documents both paths.
  `agent_log.csv` rows per phase.

## Frame-loop and render review

Run over this plan with `/improve-webgpu` before any of it was built, because the cheapest place to
fix a per-frame allocation or a leaked buffer is in the design. Severity follows the render loop.

### Costs this plan puts inside the frame

Every flora layer is per-frame work. Each gets its own `frameProfiler` slot (`grass`, `forest`,
`plants`) so the pass breakdown, not the frame total, is what any tuning argues from — and each is
skipped whole when its toggle is off or the world mode is not terrain.

- **The chunk host runs every frame and must allocate nothing on the common path.** The donor
  (`environment-viewer.html:5584`) is already shaped for this: `syncPlantsToFocus` returns on an
  unchanged window key before it builds the candidate list, and `processPlantBuildQueue` returns
  before its `new Map()` when both queues are empty. `flora-chunks.js` must keep both early returns
  — they are why the host is free on the frames where the player has not crossed a cell — and its
  `stats` object is mutated, never rebuilt.
- **Builds are budgeted, including rebuilds.** `budgetChunks` and `budgetMs` apply to first build,
  readiness retries and `rebuildExisting`; a density or seed change may invalidate everything but
  may not synchronously drain the queue during play.
- **Per-frame `setChunk` calls are batched.** The donor collects a frame's builds into one map and
  makes a single `setChunks` call; `forest-gpu.js` then debounces its own storage rebuild to once
  per frame at the top of `update()`. Calling `setChunk` per chunk per frame defeats that.
- **Placement never calls `source.heightAt` from the frame thread.** It reads resident canonical
  field arrays; the near-ring correction reads the shared fine visible-surface window. Both are the
  same surface contract the player's ground query consumes, so a trunk and a footstep agree.
- **Panel counters are strided.** Flora instance and draw counts follow the existing 15-frame stride
  that `refreshTerrainRuntimeLine()` uses, not a per-frame `textContent` write.

### GPU resources this plan creates, and who frees them

Two disposal gaps exist in the donors today. The plan works around both rather than pretending they
are not there, and says where a later cleanup belongs.

- `forest-gpu.js`'s `dispose()` (`:749`) frees the cloned draw geometries and their materials, but
  **not** the palette geometries `createForestPalette` baked (`variant.branches` / `leaves` /
  `shadow`). Anything that rebuilds the palette — a species-count or variant slider — leaks them.
  `base-game-flora.js` owns palette disposal explicitly: it keeps the variant list and disposes
  every geometry in it before baking a replacement.
- `grass-compute.js`'s `dispose()` frees one geometry and one material and leaves its storage
  buffers and compute pipelines to the GC. So grass is **built once and tuned through its setters**
  (`setDensity`, `setRadius`, `setMaxBlades`, `setBladeHeight`, `setLook`), never torn down and
  rebuilt from a live slider. The supported cap is calculated and logged before its one construction,
  after saved state is loaded; the UI cannot request a radius/density beyond that cap. Raising the
  supported cap is a page/loading configuration change until the donor gains explicit storage-buffer
  disposal.
- Buffers are capped and the cap is stated in the perf record: `capPerVariant x LODs x variants x 2`
  vec4s for the forest, `maxInstances(radius, cellSize, Kmax)` blades for grass, `R8Unorm` biome and
  cover channels, and float visible-surface/moisture windows. The capture records calculated bytes,
  not only instance counts. A rising `renderer.info.memory` while the page idles means one of these
  paths is rebuilding where it should be mutating.

### TSL graphs

- `heightNode` and `densityNode` are injected **once** at construction. The windows they read are
  already uniform-driven (`terrain-sea-depth.js` keeps `origin`, `res` and `post` as `uniform()`s and
  recentres by mutating them), so a moving window never touches the graph. Window resolution is
  therefore fixed for the life of the page: changing it means a rebuild, so it is a startup constant,
  not a slider.
- Ecology has no hand-synchronized TSL twin. `coverAt` is evaluated while a field tile commits, and
  the GPU node only performs coordinate conversion plus a wrap-aware scalar load. The injected-node
  construction test catches graph-shape failures; the compute path still needs the browser visual
  gate because storage-buffer materials cannot use the ordinary material harness.

### TSL specifics, checked against the shipped build

`node_modules/three/build` is r184, the same revision `base-game.html`'s importmap pulls from the
CDN, so it is evidence rather than recollection. Three things the plan asserted needed correcting.

- **The biome window is `RedFormat` + `UnsignedByteType` (`r8unorm`), decoded with `x255`.** The
  obvious choice — an integer texture of biome ids — does not work here: r184's WebGPU backend maps
  `RedIntegerFormat` only for `IntType` (`r32sint`) and `UnsignedIntType` (`r32uint`)
  (`three.webgpu.js:74504`), and errors on anything else, so a `Uint8Array` integer texture is
  rejected outright. `RedFormat` + `UnsignedByteType` is explicitly mapped to `R8Unorm`
  (`:74393`), which is one byte per texel — a quarter of the `r32uint` alternative — and reads back
  as a normalized float that `mul(255).round()` turns into the id. 17 biomes fit in 255 values with
  room to spare.
- **A toroidal window can never be sampled with uv `texture()`.** `grass-compute.js`'s existing
  `densityFn` samples `densityTex` through normalized uv, which is correct for an authored map's
  fixed world bounds and wrong for a clipmap window: the window wraps, so the texel under a uv moves
  as the window recentres, and the seam smears across the whole field. Both injected nodes must use
  the window's own wrap-aware `textureLoad` path (`terrain-sea-depth.js`'s `gpuHeightAt` is the
  worked example: floor/fract for the bilinear weights, `wrap()` on the integer indices, `select()`
  for the outside-the-window fallback).
- **The injected nodes are `Fn` instances taking two scalars, not the window's method.**
  `grass-compute.js` calls `heightFn(wx, wz)` (`:263`, `:301`) while the window exposes
  `gpuHeightAt(xz, fallback)` on a vec2. Passing the method straight in would hand a scalar to a
  parameter typed as a vector. Because those scalars are render-local and the windows are global,
  the adapter also performs the origin conversion and fine/coarse composition. `renderOrigin` is a
  vec3 uniform mutated on rebase:

  ```js
  const heightNode = Fn(([x, z]) => {
    const globalXZ = vec2(x, z).add(renderOrigin.xz);
    const coarseY = coarse.gpuHeightAt(globalXZ, float(-1000));
    return fine.gpuHeightAt(globalXZ, coarseY).sub(renderOrigin.y);
  });
  const densityNode = Fn(([x, z]) => {
    const globalXZ = vec2(x, z).add(renderOrigin.xz);
    return cover.gpuGrassAt(globalXZ, float(0));
  });
  ```

  `createComputeGrass` validates that what it is handed is a TSL node function before it builds a
  kernel around it, so the failure is a thrown error at construction rather than a shader that will
  not compile.

### Visual rubric rows this plan has to pass

Each is a gate on the phase that introduces it, checked from a stated viewpoint. None of it is
asserted from source — the user's look at the page is the verdict.

| Row | Phase | Fails when |
| --- | --- | --- |
| Scale and contact | F1, F5, F6 | Blades or trunks float above the drawn ground, or a trunk sinks to its first branch. The visible-surface lod-0 window and low bias are the fix; a volumetric mismatch means `surfaceHeights` was bypassed. |
| Geometry and seams | F1, F5 | A biome or density edge lands exactly on a tile border, or grass thins in a grid. The seam test covers classification; the visual check is walking a tile boundary. |
| Transparency and depth | F5, F6 | Leaf cards and blades halo or sort wrongly against each other and against the water surface. Leaf side policy follows `forest-gpu.js` Milestone 6 (FrontSide on L1/coarse-L2 and billboards); grass keeps its existing alpha handling. |
| Image stability | F5, F6 | Blades shimmer or crawl when panning, or billboards pop at an LOD ring. Blade fade and LOD distances are the tuning surface; the blade atlas needs anisotropy. |
| Shadows | F6 | Tree shadows flicker, detach, or cost more than they add. The forest bakes a dedicated shadow mesh per variant with `castShadow` on (`forest-gpu.js:392`) plus a bark-shadow toggle, so foliage shadows are a panel toggle with the cost recorded on both settings. |
| Materials and lighting | F5, F7 | Foliage reads flat against the sun. `grass-look.js`'s translucency and root shade are the levers, driven by the same sun direction the sky and water already use. |
| Render sanity | every phase | A shader-compile error in the console, or a layer that never appears — the failure mode a lazily-imported module hides behind a `.catch()`. Each import logs rather than silently degrading. |

### Baseline and A/B

`research/stats/base-game-performance-log.json` gets a no-field baseline before F1, a field-only A/B
after F1/F2, all-layers-off before F5, and the stop-gate captures listed for F5/F6/F7. Each reports
the pass breakdown, queue/field metrics, resources, draws, triangles and instances rather than only
frame total, and says which numbers did not move as well as which did. Every moving test crosses a
field/chunk boundary; every coordinate test includes a render-origin rebase. Water and clouds are
also tested on because they compete for the same frame and field infrastructure. Timestamp mode
changes frame pacing, so an A/B stays inside one mode.

## Order and parallelism

F1 → F2 → F3 → F4 → F8 → F5 → F6 → F7 → F9. F4 and the F8 room/state contract may proceed in
parallel after the canonical field shape is fixed, but visible placement does not land before both.
Forest and understory share placement modules and field data, not resident hosts or radii. F1/F2
field-only captures are the first performance gate; F5 is the first visible one. F1 and F2 outlive
this plan because the ground material, minimap and later ecology read them too.

## Known limits to state, not hide

- Moisture is a proxy until regional hydrology (roadmap step 9) exists. It is shaped like the real
  thing and enters through one function, but it is not derived from flow.
- The streamed `beachMask` drops `buildDerivedMaps`'s lake factor, which needs a global flow graph,
  so inland depressions can read as beach until hydrology lands. Sea beaches are correct.
- Canonical placement is intentionally band-limited. Fine visual data may move a record vertically
  but cannot change its species or existence; very small biome features below the canonical spacing
  therefore do not get unique vegetation.
- Flora reads the visible open-sky `surfaceHeights` field in volumetric mode, so cave roofs are
  handled, but cave floors, undersides and stacked traversable surfaces at the same XZ are not.
  `grass-compute.js`'s anchor mode or mesh-surface anchors are the later 3D answer.
- Nothing collides: the player walks through trunks in v1.
- Species are procedural. The authored families in `families/`/`plant-families/` are empty on disk
  and reachable only through another tool's localStorage.
- Even at `lod: 0` the window samples the field where the mesh draws flat triangles between its
  posts, so flora sits a fraction of a post off the drawn surface on curved ground. The low bias
  hides it. Anything narrower than a post — a boulder, a ledge — is invisible to the window anyway.
- Trees beyond 160 m use canonical coarse visible-surface Y until the player approaches. On a bluff
  that can be metres of error; fine arrival corrects only Y, and the F6 boundary test rejects a
  visible correction pop.
