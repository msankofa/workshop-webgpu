# Base Game hydrology — rivers, lakes, and the water they carry

STATUS 2026-08-27: PLAN, not started. This is roadmap step 9, which was skipped to get step 10
(water rendering) done; the sea shipped as a single global level with no inland water at all.
It also finishes what step 10 still owes — rapids and waterfalls, which need channels to exist —
and it unblocks the plants plan, whose moisture is a proxy and whose beach factor is parked until
lakes exist.

## Goal

Rivers and lakes on the infinite streamed terrain, complete: a deterministic drainage network, the
terrain carved by it so channels sit in real valleys, water surfaces at the right height with
flow, rapids and waterfalls, swimming and currents identical on the client and the server, wet
banks and lake caustics, river sound, and a moisture field that replaces the proxy. Every part is
a pure function of world position and the descriptor, like the rest of this stack.

## Facts the plan rests on (measured in the code, not assumed)

- **Everything downstream of the terrain is a pure function of (x, z).** `terrain-field.js`
  `terrainHeightAt` and `terrain-source-v5.js` `heightAt` are closed-form; the chunk mesh, the
  CDLOD shader, collision, flora, rain and water all query them with no shared mutable state
  (`docs/subsystems/terrain.md:255`). Anything hydrology adds has to keep that property or every
  consumer needs a new synchronisation story.
- **Real hydrology in this repo is bounded and preview-only.** `terrain-generator-js.js` has
  `flowAccumulation(height, resolution)` (:252), `simulateErosion` (:356) and
  `detectLakeMask(height, slope, seaMask, cfg, flowNorm, receiver, resolution)` (:370), all of
  which take a whole grid. `terrain-source-v5.js` refuses to apply them — they are named in
  `classification.omitted`, and `docs/subsystems/terrain.md:95` says so explicitly: "Erosion,
  lakes and flow are global, so the streamed `beachMask` keeps `buildDerivedMaps`' local height
  and slope terms and drops its `lakeMask` factor (regional hydrology, roadmap step 9)."
- **The height stack is per-point and band-limited.** `evaluateStackPoint(prepared, x, z, ctx)`
  takes `ctx.spacing` and fades every noise octave finer than the caller's sample spacing
  (`terrain-stack.js:189`). `heightAtSpacing(x, z, spacing)` is the entry point; lod 0 and every
  collision query are exact. A carve that is not band-limited the same way will alias into
  flickering notches on coarse rings.
- **The volume follows the heightfield.** `densityAt(x, y, z, h)` takes the column height, and
  `surfaceYAt` scans from `heightAt + VOLUME_TOP_MARGIN`, so carving `heightAt` carves the
  marching-cubes surface and the collision volume with no extra work.
- **Tile fields already reserve the words.** `TILE_FIELDS` in `terrain-source.js:11` is
  `['heights','surfaceHeights','normals','biomeIds','materialFields','moisture','holeMask','volume']`.
  `moisture` is filled today by `moisture-proxy.js`, whose own header says the honest input — "a
  true nearest-water distance field is not O(1)" — is the thing it cannot have. Hydrology is that
  field.
- **The water shading is already separable from the ocean grid.** `makeSurfaceShading(P, {...})`
  (`water-hybrid.js:220`) takes explicit nodes for rest position, normal, fold, wave height,
  thickness, bed colour, reflection and foam; `makeRadialGrid` and `createOceanSurface` are the
  only parts that assume a camera-following disc. An inland surface can reuse the shading whole.
- **The sea's physics is one shared module on the tick clock.** `base-game-water-sim.js`
  `heightAt(x, z, t)` is imported by both `base-game.html` and `server/base-game-rooms.js`, and
  the controller's `waterSurfaceAt` hook makes a step a pure function of `(position, velocity,
  config, tick)`. Inland water has to enter through the same door or swimming desyncs.
- **Descriptor identity already carries world parameters.** `seaLevel` is a descriptor field
  tagged onto `worldVersion` (`:sea<n>`), and the v5 project body is hashed whole, so new
  `cfg.*` keys travel with no protocol change. `sanitizeBaseGameTerrainConfig` re-normalises and
  re-hashes, so a client cannot smuggle different rivers.
- **The v5 project has lake parameters but no river ones**: `lake_flow_threshold`,
  `lake_max_slope`, `lake_expand_iterations`, `lake_bank_height` (`terrain-generator-js.js:32`),
  all consumed by the bounded preview only.
- **Base Game's default ground is the analytic source**, not v5 (`base-game.html`
  `TERRAIN_SOURCE_DESCRIPTOR`). Its `lake`/`lakeDepth` params are a smoothstep-gated noise basin
  in the closed-form field — a shape, not a water body, and nothing reads them as water.

## Standing direction this plan answers to

Prior plans already set terms for this step, and they are constraints, not context:

- The roadmap calls it **regional** river and lake hydrology (`docs/subsystems/base-game.md:390`).
- `2026-08-21-base-game-terrain-execution.md:125` makes it a rule of the source contract: "A source
  cannot claim `infinite` capability if it depends on finite paint/import grids, bounded erosion,
  lake discovery or volumetric export **without a regional solution**", and its list of
  "finite/regional only until their own later phase" items is "flow accumulation, lake discovery
  and hydrology" (:494). This is that later phase, and the world map is that regional solution:
  a bounded board the bounded algorithms already run on, with the infinite terrain streamed inside
  it.
- The same plan's LOD phase (:529) requires that "height, biome, material, moisture, hydrology and
  hole fields use the same LOD level" in the prefiltered tile pyramid, and that procedural
  evaluation "drops frequencies smaller than the requested sample spacing". H2's band-limit rule
  and H3's tile field are how this plan meets that; H3 carries the field through the pyramid with
  the others rather than inventing a private path.
- `2026-08-23-base-game-plants.md:155` fixes where moisture changes hands: the proxy "holds until
  hydrology publishes a real field. The swap then happens inside `buildTile` and nothing else
  moves." H8 does exactly that and nothing more.

## The approach

This is a solved problem in games, and the solution is boring: **compute the drainage once, at world
creation, on a bounded coarse world map, and stream infinite detail inside it.** Dwarf Fortress,
Songs of Syx and RimWorld all generate a world grid up front and hand the detailed view a lookup.
Nothing here needs a new idea.

- The map is a square grid centred on the origin: `worldCells` × `worldCells` (default 256) at
  `cellSize` metres (default 2048), so 512 km across. A player sprinting in a straight line takes
  about fifteen hours to reach the edge.
- Cell elevation is `heightAtSpacing(centre, cellSize)` — the band-limited field, so the map sees
  landforms rather than the noise on them.
- Drainage is `flowAccumulation(height, resolution)` from `terrain-generator-js.js:252`, unchanged:
  D8 receivers, a descending-height sweep, log-normalised accumulation. It is already written and
  already tested. Rivers are the cells whose accumulation clears `riverThreshold`, traced down the
  receiver chain, so catchments are as large as the map allows and tributaries join the way real
  ones do.
- Depressions are filled by a standard priority flood, which gives every basin its true spill
  level; `detectLakeMask`'s parameters (`lake_flow_threshold`, `lake_max_slope`,
  `lake_bank_height`) carry over.
- The map is built once per source, from the seed and the parameters alone, so the client, the
  server and every terrain worker compute the same arrays without talking. It is immutable
  afterwards, which keeps `carveAt` and `waterAt` pure functions of position.

Between two cell centres a channel is refined by a bounded steepest-descent walk on the actual
height field, from the cell's entry point to its exit, so a river sits in the gully that is already
there instead of cutting its own line across a slope. Local pits inside a cell get a bounded step
toward the exit. This is the only part with any subtlety in it.

Costs, to be measured in H1 rather than trusted here: the accumulation and flood are O(n log n) on
65,536 cells, which is milliseconds. The real cost is sampling 65,536 coarse heights — cheap on the
analytic field, an estimated fraction of a second on a v5 stack. If that lands badly, the map is
built once on the main thread and transferred to the workers as typed arrays through the init
message they already have.

## Decisions

- **Hydrology is one shared module, applied by both sources.** `terrain-hydrology.js` is pure JS
  (no three.js) and owns the graph, the carve and the water query. `terrain-source-analytic.js`
  and `terrain-source-v5.js` both apply it to their base height, so there is one implementation
  and no twin to drift. It is *not* a stack layer type: the carve needs the base height as input
  and has to run after every layer, including terrace and warp.
- **Rivers carve the terrain.** `heightAt` returns the carved height. Collision, the chunk mesh,
  the CDLOD shader, flora placement, rain and feet then agree for free, because they all already
  read that one function. Nothing is carved after the fact.
- **The carve is band-limited by the same rule as the noise.** When the sample spacing exceeds the
  channel width, the channel term fades and only the valley remains, so a coarse ring shows a
  broad valley rather than an aliasing notch.
- **The water surface is a lookup, not a runtime simulation.** `waterAt(x, z)` returns
  `{ level, kind, depth, flowX, flowZ, speed }` from the world map. Nothing floods while the game
  runs, so the server, the client and the terrain worker all answer the same thing without talking.
- **Hydrology is bounded even though terrain is not.** Outside the world map there are no rivers
  and no lakes; the ground is unchanged and still infinite. The source keeps its `infinite`
  capability because the height field is still defined everywhere.
- **No new streamed field window.** `waterAt` is cheap and pure, so physics, audio and moisture
  call it directly; only the *mesh* is baked, as a new `water` tile field the worker fills while
  it already has the tile — prefiltered at the same LOD levels as height, biome, material and
  moisture, as the terrain execution plan's LOD phase requires, not on a private schedule. `terrain-sea-depth.js` stays as it is — it answers a different
  question (is any ground in the window below sea level) at a coarser resolution than a 6 m
  channel needs.
- **Sea and inland water are one query.** `base-game-water-sim.js` answers
  `max(sea surface with waves, inland level)`, and the carve fades out below sea level so a river
  mouth opens into the sea instead of trenching the seabed.
- **Parameters are descriptor/project fields**, so they ride `worldVersion` and the project hash
  with no protocol change, and are owner-only online like the rest of the terrain config.
- Every part is a panel toggle, saved with the page state; ranges never narrow on performance
  grounds.

## Phases

### H1 — `terrain-hydrology.js`: the world map, carve and water query

- `createHydrology({ heightAtSpacing, seed, params })` → `{ map, carveAt, waterAt, flowAt,
  nearestChannel, stats }`. Pure, Node-testable, no three.js.
- Params (finite-validated, defaults in `HYDROLOGY_DEFAULTS`): `enabled`, `worldCells` 256,
  `cellSize` 2048, `riverThreshold`, `channelWidth` (base and per-accumulation growth),
  `channelDepth`, `bankWidth`, `lakeEnabled`, `lakeBankHeight`, `fallSlope`, `seed`.
- Build (once, at source creation): sample the coarse heights, priority-flood the depressions to
  get basin spill levels, run `flowAccumulation` on the filled surface, keep `receiver`, `accum`,
  the lake level per cell, and the channel polylines refined by the per-cell steepest-descent walk.
  Reuses `terrain-generator-js.js` rather than reimplementing it.
- `carveAt(x, z, baseHeight, spacing)` → carved height: distance to the nearest channel polyline in
  the 3×3 cell neighbourhood, a channel profile pushed down to the segment's interpolated bed
  elevation, banks feathered over `bankWidth`, lake bowls floored at their spill level, all faded
  by the spacing rule and by sea level.
- `waterAt(x, z)` → level, kind, depth, flow direction and speed. A lake's shoreline is not stored:
  it is where the spill level meets the real ground, so lakes have fine-scale shores for free.
- Tests (`test-terrain-hydrology.mjs`): the map is identical for the same seed and parameters,
  and independent of query order; no receiver cycles; every channel is monotone downhill along its
  whole path including the refined walk; lake levels never exceed their pass; the carve is
  continuous across cell borders; `carveAt` at spacing much larger than the channel width returns
  the valley, not the notch; the carve is exactly zero outside the map. Build time and per-sample
  query cost measured and recorded, not guessed.

### H2 — The sources carve, and the world identity says so

- `terrain-source.js`: `hydrology` descriptor field, normalised and frozen like `seaLevel`, and a
  `water` entry in `TILE_FIELDS`.
- `terrain-source-analytic.js`: `analyticDescriptor({ ..., hydrology })`; `heightAt`,
  `heightAtSpacing`, `normalAt` and `buildTile` all run the carve. The existing `lake`/`lakeDepth`
  shape params stay untouched — they are landform, not water.
- `terrain-source-v5.js`: the same, from new `cfg.river_*` / `cfg.lake_*` project keys, so the
  project hash covers them. The volume path needs no change: `densityAt(x, y, z, h)` takes the
  carved `h` and `surfaceYAt` scans from the carved height, so caves, marching-cubes tiles and
  the collision volume follow. Verified by test, not assumed.
- `base-game-protocol.mjs`: `worldVersion` gains a hydrology tag when enabled, the way `:sea<n>`
  works, and the sanitizer clamps every parameter.
- Tests: `test-terrain-hydrology-source.mjs` — the same column through `heightAt`,
  `heightAtSpacing(0)`, a lod-0 tile and a collision query returns one number; tile seams stay
  matched across a region border; a v5 volume tile's surface sits under the river bed where a
  channel crosses it; `worldVersion` changes when a parameter does.

### H3 — The `water` tile field and the terrain facade

- The worker fills `water` while it has the tile: per texel a level, a kind (none / river / lake /
  sea), and a packed flow direction and speed, plus the tile's channel polylines for the mesh
  builder. Sized so a 6 m channel has real texels; measured against tile build time.
- The field is part of the tile pyramid, at the same LOD levels as height, biome, material and
  moisture (`2026-08-21-base-game-terrain-execution.md:529`). A lod > 0 tile's water field is the
  band-limited carve at that tile's spacing, so a coarse ring's water agrees with its own ground
  rather than with lod 0's.
- `base-game-terrain.js` grows `waterAt(x, z)`, `nearestChannel(x, z)` and a `hydrology` getter,
  and carries the new field through the chunk commit path the way `surfaceHeights` and `moisture`
  already are.
- Tests: field values agree with `waterAt` at the same coordinates; tile build time delta
  recorded in the terrain performance numbers.

### H4 — Rendering inland water

- `base-game-inland-water.js`: a chunk pool keyed to the terrain's own chunk keys, each mesh built
  from the tile's `water` field (a skirted strip along channels, a bowl polygon for lakes), using
  `makeSurfaceShading` unchanged so lakes and rivers are lit, reflected and refracted exactly like
  the sea.
- Flow: a two-phase scrolling normal along the baked flow direction (the standard flow-map
  crossfade), so a river reads as moving water rather than a lake with waves. Wave displacement is
  scaled to zero on rivers and kept small on lakes.
- Shoreline: the same per-pixel depth-buffer thickness the sea uses (`viewportDepthTexture`), so
  the water ends where the drawn ground rises through it, including where a river meets the sea.
- LOD: channels drop out with the chunk cascade; lakes survive further out as flat polygons. The
  sea's visibility gate stays; inland water has its own, per chunk.
- Reflection: inland surfaces read the sky and the SSR path. The planar mirror is a single plane
  at sea level, so it is not used for lakes at other levels — stated in the doc rather than
  silently wrong.

### H5 — Rapids and waterfalls (the rest of roadmap step 10)

- Channel slope comes from the graph, so whitewater is a shading term: above a slope threshold the
  foam energy rises and the flow speed scales.
- A waterfall is a channel segment whose drop over its length exceeds `fallSlope`: a vertical
  sheet mesh from the lip to the plunge point, a spray emitter at the base through
  `particle-field.js`, and a plunge-pool foam ring.
- Tests: a synthetic cliff-crossing channel produces exactly one fall segment with the right lip
  and base; the classification is stable across a region border.

### H6 — Swimming, currents and the server

- `base-game-water-sim.js` gains the hydrology and answers `heightAt(x, z, t)` as
  `max(sea, inland)`, plus `flowAt(x, z)` (metres per second, world XZ).
- `base-game-player-controller.js`: while swimming or wading, the current is added as a velocity
  the same way buoyancy is — a pure function of position and the config, so the tick clock still
  makes the step reproducible. New finite-validated config keys (`currentStrength`,
  `wadeCurrentStrength`), and no water tuning in the local player-config panel, for the same
  reason buoyancy is not there: those sliders are local-only and would desync a swim.
- `server/base-game-rooms.js`: the room's water sim is built from the same descriptor, so nothing
  new crosses the wire.
- Tests: `test-base-game-rooms-water.mjs` grows a river case — one input script through the server
  and a predicting client, entering a river, riding the current, and climbing out, identical to
  1e-9, with a control client whose hydrology is off drifting away.

### H7 — The ground the water touches

- Wet banks: the tide-line band the sea already draws, driven by `waterAt` instead of the global
  sea level, so a lake shore and a river bank read wet too.
- Caustics: the existing analytic Snell caustic in the splat material takes a per-fragment water
  level instead of the scene-wide one.
- River beds: the splat gets a bed material where the channel is, so a dry-season bank and a bed
  are not the same sand.
- `terrain-biome-point.js`: `localBeachMask` gets its `lakeMask` factor back, from `waterAt`, and
  the note in `docs/subsystems/terrain.md:95` is retired.

### H8 — Moisture, and the plants that wanted it

- Real moisture: distance to the nearest water plus elevation above the local water table, from
  `nearestChannel`, replacing `moistureProxyForBiome` in the streamed `moisture` field. The swap
  happens inside `buildTile` and nothing else moves, which is the handover the plants plan
  specified (`2026-08-23-base-game-plants.md:155`). The proxy
  module stays for loaded finite maps, which have no hydrology.
- `flora-field.js` consumes it unchanged (it already takes moisture as an input), so riverbanks
  grow differently from ridges without touching the placement code.
- Coordinate with the plants track before landing: F6 (trees) is live in another session.
- Tests: moisture rises toward a channel and falls with height above it; the field is continuous
  across tile and region borders.

### H9 — Sound

- `environment-audio.js`: a positional loop at the nearest channel point, gain and filter from the
  channel's flow speed, plus a louder waterfall loop at fall segments. One emitter each, moved
  rather than respawned, the way the rain bed already works.

### H10 — Panel, persistence, capture, generator preview, docs

- A Hydrology section in the Base Game panel: enable, region size, river threshold, channel width
  and depth, meander, lakes on/off, lake bank height, waterfall threshold, plus render toggles for
  inland water, flow, rapids and spray. Owner-only online, saved with the page state.
- `terrain-generator-v5.html` gains an unbounded-hydrology preview field so what is authored is
  what the runtime carves. The bounded erosion and lake preview stays as it is and stays labelled
  preview-only.
- Performance capture: a `hydrology` context block (region cache hits, prepared blocks, channel
  count in view) and the inland surface's own profiler slot beside `passWaterMs`.
- Docs: `terrain.md` (the carve, the band-limit rule, the tile field), `water.md` (inland
  surfaces), `base-game.md` (the roadmap step, the panel, the physics), `biomes.md` (moisture and
  the restored lake factor), `multiplayer.md` (parameters ride the world version), plus a row in
  `agent_log.csv` per phase.

## Order and parallelism

H1 → H2 → H3, then H4 → H5 and H6 in parallel (they share only `waterAt`), H7 and H8 in parallel
after H3, H9 after H4, H10 closes. H8 lands only after checking in with the plants track.

## Known limits to state, not hide

- Hydrology stops at the edge of the world map (512 km across by default). Terrain past it is
  unchanged and still infinite, but it has no rivers or lakes. Raising `worldCells` costs build
  time and memory quadratically.
- The drainage is real but the ground is not eroded by it. Channels are carved into the existing
  height field, so there are no V-notches, alluvial fans or erosion-graded slopes, and the
  generator's bounded erosion preview will not match the runtime carve.
- The map is computed from the band-limited height at `cellSize`, so a basin narrower than a cell
  is invisible to it. Fine-scale ponds are not modelled.
- A channel crossing a cave mouth pours into it. The mesh and the physics agree — the water is
  where the surface is — but nothing drains, and the cave does not fill.
- Lakes have one level each and no seasonal or dynamic change; nothing rises, falls or floods.
- The planar mirror is a single plane at sea level, so lakes at other levels reflect via sky or
  SSR only.
- Loaded finite maps get no hydrology: their heights are baked, so there is nothing to carve.
  They keep the moisture proxy.
