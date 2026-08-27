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

## The hard problem, and the decision

Flow accumulation and basin filling are **global** algorithms: a cell's drainage depends on every
cell upstream of it, and a basin's spill level on every cell around it. The world is infinite and
streamed in 30 m tiles. Two ways out:

**A — simulate on streamed regional grids with an apron.** Each region runs `flowAccumulation` on
its own grid plus a margin. Rejected: the answer at a border cell depends on terrain outside the
apron, so two neighbouring regions disagree about the same river, and the disagreement moves as
the player moves. That is exactly the non-determinism this codebase spent the terrain plan
removing, and it breaks multiplayer, where the server and every client must carve identically.

**B — a deterministic drainage graph over a coarse region lattice.** Decided. Rivers are not
simulated; they are *derived from a bounded neighbourhood* of the large-scale height field, which
is smooth and cheap to sample:

- The world is a lattice of region cells (`regionSize`, default 2048 m). A cell's elevation is
  `heightAtSpacing(centre, regionSize)` — the band-limited field, so it is the landform, not the
  noise on it.
- A cell drains to the lowest of its eight neighbours when that neighbour is lower; otherwise it
  is a sink. This is a pure function of ten height samples.
- Upstream accumulation is summed over a fixed radius `reach` (default 6 cells ≈ 12 km) by
  sweeping that block in descending elevation order. Bounded, deterministic, cacheable per cell.
  A channel exists on an edge whose accumulation clears `riverThreshold`, and its width and depth
  grow with accumulation.
- A sink becomes a lake. Its level is the lowest pass out of the basin, found by a bounded flood
  inside the same `reach` block; if no pass is found the lake is capped at the block's rim
  minimum. Bounded, deterministic.
- Between cell centres the channel is a Catmull-Rom spline through hash-jittered nodes, so rivers
  meander instead of running cell-to-cell in straight lines. Node elevation is monotone
  decreasing along the path by construction, which is what makes the water surface downhill
  everywhere without a second pass.

The cost of B is stated, not hidden: a river's basin never exceeds `reach`, so rivers saturate at
a size a 12 km catchment justifies. A second, coarser lattice level would lift that; it is
deliberately not in this plan (see Known limits).

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
- **The water surface is a function, not a simulation.** `waterAt(x, z)` returns
  `{ level, kind, depth, flowX, flowZ, speed }` from the graph. Nothing floods at runtime, so the
  server, the client and the terrain worker all answer the same thing without talking.
- **No new streamed field window.** `waterAt` is cheap and pure, so physics, audio and moisture
  call it directly; only the *mesh* is baked, as a new `water` tile field the worker fills while
  it already has the tile. `terrain-sea-depth.js` stays as it is — it answers a different
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

### H1 — `terrain-hydrology.js`: the network, carve and water query

- `createHydrology({ heightAtSpacing, seed, params })` → `{ regionAt, carveAt, waterAt, flowAt,
  nearestChannel, stats }`. Pure, Node-testable, no three.js.
- Params (all finite-validated, defaults in `HYDROLOGY_DEFAULTS`): `enabled`, `regionSize` 2048,
  `reach` 6, `riverThreshold`, `channelWidth` (base and per-order growth), `channelDepth`,
  `bankWidth`, `meander`, `lakeEnabled`, `lakeBankHeight`, `minSlope`, `seed`.
- Internals: an LRU of prepared region blocks keyed by cell, each holding the block's coarse
  heights, receivers, accumulation, sinks with their lake levels, and the spline nodes for every
  channel edge that clears the threshold. One block serves every query inside its cell.
- `carveAt(x, z, baseHeight, spacing)` → carved height: distance to the nearest channel polyline
  in the 3×3 cell neighbourhood, a channel profile pushed down to the segment's interpolated bed
  elevation, banks feathered over `bankWidth`, lake bowls floored at their spill level minus a
  depth, all faded by the spacing rule and by sea level.
- Tests (`test-terrain-hydrology.mjs`): determinism (same seed and position → identical result,
  and independent of which cell is queried first); a channel's elevation is monotone downhill
  along its whole path; no receiver cycles over a swept region; lake levels never exceed their
  pass; the carve is continuous across region borders (sample a fine line across a border, assert
  no step); `carveAt` at spacing ≫ width returns the valley, not the notch; cost per sample
  measured and recorded, not guessed.

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
  `nearestChannel`, replacing `moistureProxyForBiome` in the streamed `moisture` field. The proxy
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

- A river's catchment is bounded by `reach`, so rivers saturate at the size a 12 km basin implies;
  there are no continent-scale trunk rivers. A second, coarser lattice level would lift it and is
  not in this plan.
- The network is derived from the large-scale height field, not simulated on it. Channels sit in
  real valleys and always run downhill, but they are not the drainage a full erosion pass would
  produce, and the generator's bounded erosion preview will not match the runtime carve.
- A channel crossing a cave mouth pours into it. The mesh and the physics agree — the water is
  where the surface is — but nothing drains, and the cave does not fill.
- Lakes have one level each and no seasonal or dynamic change; nothing rises, falls or floods.
- The planar mirror is a single plane at sea level, so lakes at other levels reflect via sky or
  SSR only.
- Loaded finite maps get no hydrology: their heights are baked, so there is nothing to carve.
  They keep the moisture proxy.
