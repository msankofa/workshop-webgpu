# Base Game structures: from prototype finish to shipping finish

Written 2026-09-06 after the user walked the scattered structures in a browser. Five tracks, each
with a claim, the evidence in the code, the plan, and how it is verified. Nothing here is built
yet. Defaults marked *measure* are unknown until the budgeting track runs.

The shipped pipeline (all in place, Node-tested):

- `base-game-structures.js` — pure: kind per plan tile, seating, nav rects, cover clearance, scatter.
- `base-game-structure-collision.js` — streamed provider, per-tile colliders; `ensure(positions)`
  builds up to `maxBuildsPerCall` tiles nearest first and keeps `keepRadius` tiles.
- `base-game-structures-page.js` — dress: one instanced mesh per material bucket per 32 m cell,
  cover stamp, concrete materials shared with the spawn building, `compileAsync` warmup.
- `server/base-game-rooms.js` + `server/base-game-npcs.js` — the same collider on the server; the
  NPC zone bake takes `navRectsWithin(bounds)` as 2D blockers with `levels: null`.

---

## Track 1: LOD and occlusion

**Claim.** Every resident tile draws every box at full cost at every distance. There is no LOD
and no occlusion for structures.

**Evidence.** `dress()` in `base-game-structures-page.js` emits all buckets for a tile as
instanced boxes and never touches them again; `reconcile()` only adds and removes whole tiles.
`coverRadius` × `spacing` sets the visual reach, and the collider must reach that far too so the
server plan window agrees. The only cull is Three's per-mesh bounding-sphere frustum test on a
32 m cell; a cell behind a hill still draws.

**Why the box representation is the opportunity.** A building is a list of axis-aligned boxes.
That is the cheapest possible input for both LOD and occlusion: a box list merges into a hull
trivially, and a box list is a ready-made occluder set.

**Plan, in order of payoff.**

1. *Distance tiers per tile.* Three representations of the same tile, chosen by distance from
   the render focus each frame:
   - `near` (0 to D1): what exists today, every bucket.
   - `mid` (D1 to D2): walls, plinth, ground and slabs only. Covers, bars, soil, water, planter
     geometry and the scattered small covers are dropped. Same materials, so no new pipelines.
   - `far` (D2 to the cover radius): one box per structure, the footprint × height from
     `structureBounds`, with a flat concrete material (no tie holes, no panels: those are the
     expensive part of the concrete graph). One instanced mesh for all far tiles, rebuilt on
     `reconcile`.
   The tier switch is a visibility flip on pre-built groups, never a rebuild. D1 and D2 are
   sliders (defaults *measure*; guesses 180 m and 500 m). Cost: `dress` builds three groups;
   `update()` gains a tier pass over `groups`. Pure helper `structureLodBuckets(model, tier)` in
   `base-game-structures.js`, tested.
2. *Fade, not pop.* The mid and far tiers overlap by a band where both draw and the outgoing one
   scales its instances toward zero over about half a second. Decide after step 1 is seen: a pop
   at 180 m may be acceptable for a concrete block.
3. *Occlusion.* Two candidates, cheapest first:
   - *Building as occluder for the forest and grass.* `flora-occlusion.js` already takes occluder
     boxes for grass. Register each resident building's `mid` box set with it, and extend it to
     the forest's GPU cull (the forest never reads it today, verified 2026-09-05). This is the
     visible win: a building in front hides hundreds of trees and grass blades behind it.
   - *Terrain occludes buildings.* A low-resolution software depth of the terrain tested against
     the far-tier box. Higher cost, lower payoff on rolling terrain. Defer until the frame
     profiler says structures are the draw cost.
   Structures occluding structures is not worth building: at 480 m spacing they rarely overlap
   on screen.

**Verify.** `test-base-game-structures.mjs`: tier bucket membership, far box equals bounds, tiers
partition all distances. In the browser: the structures card gains near/mid/far counts and draw
calls per tier from `frame-profiler.js`. Pass is the same picture at 100 m and a lower draw count
at 500 m, read off the card.

---

## Track 2: terrain fitting

**Claim.** Structures float or bury on slopes because they are seated on samples and the ground is
never changed to meet them.

**Evidence.** `createStructureModel` calls `createSpawnBuildingModel(heightAt, ...)`, which seats
on `site.baseY` and leaves the ground alone. The spawn building gets away with it because its
site is chosen flat. `structuresForTile` picks a site from `planWalk` (walkable, flat enough),
but flat enough for a walker is not flat under a 40 m slab.

**Precedent.** `bot-terrain.js` line 130: `flatten` is a list of `{x, z, radius}` pads levelled
after erosion and before the nav bake, bucketed so the per-sample cost is O(1), with a hard lesson
in the comment near line 232 (overlapping pads stepped 753 mm across 5 cm and the nav gate read it
as a wall). `bot-viewer-v3.html` `terrainPadsForLayout` derives pads from the layout: spawns,
cover footprints, building slabs.

**Plan.** The same pad mechanism, moved to where the base game's heights come from.

1. *Pads are a terrain layer, not a post-process.* Heights here come from the v5 source evaluated
   per tile on a worker (`terrain-source-v5.js`), and the clipmap reads them on the GPU. A pad
   must therefore be evaluated inside the source so the page, the server and the GPU clipmap all
   see the same ground. Add a `pads` modifier to the source: input a list of `{x, z, w, d, y,
   fade}` rects, output height blended toward `y` inside the rect, linear over `fade` outside.
   The rect list is deterministic from seed and spacing, so the source can compute it from the
   world identity. The hard part: the source would need the site before the plan exists. The
   resolution is that the pad rect uses only the *candidate* site from the seed (position and
   footprint), which needs heights only at the footprint corners; the source evaluates those
   from the un-padded stack first, then pads. Two passes per sample, bounded by the bucket count.
2. *Pad height.* The highest footprint sample, as `bot-viewer-v3` does for decks (the comment at
   `rebuildDeckSurfaces`), so a slab never dives into the hill. Cut on the uphill side reads as a
   retaining wall; the plinth grows to cover the fill on the downhill side.
   `createSpawnBuildingModel` gets a `plinthDepth` from the range under the footprint.
3. *No overlapping pads.* Structures are one per tile at 480 m; scatter pieces cluster within
   110 m of the anchor. Scatter pieces get their own smaller pads at the anchor's `y`, merged into
   the anchor's rect union so there is one plateau, not several. That avoids the v3 step bug by
   construction.
4. *World identity.* The pad layer is part of the terrain config hash (`:structs1:seed:spacing`
   already is), so every client and the server bake identical ground.

**Verify.** `test-terrain-source-v5.mjs`: a padded sample equals `y` inside the rect, blends over
`fade`, matches un-padded beyond. `test-base-game-structures.mjs`: pad rects for a tile are a pure
function of the seed. Page versus server: `test-base-game-rooms-terrain.mjs` compares
`groundHeight` at ten footprint points between the room's source and a page-style source.

---

## Track 3: NPCs on upper floors

**Claim.** NPCs treat a building as a 2D obstacle and never go above the ground slab.

**Evidence.** `server/base-game-npcs.js` line 192 passes `levels: null` to `finalizeNavGrid`.
`structureNavRects` deliberately drops anything whose base is more than `walkUnder` above the
floor datum. But `nav-grid.js` already supports 3D: `attachLevels(grid, decks)` stamps sparse
extra walkable surfaces per column (line 108), `bot-brain.js` line 1423 reads `navGrid.levels`,
and `bot-viewer-v3.html` feeds it decks plus `rampDecks(ramp, rise)` for ramps. The layout has a
stair (`base-game-spawn-layout.js` line 41, `stair()`) and a mezzanine (line 141).

**Plan.** Feed the same decks from the structure model.

1. *Pure: `structureNavDecks(model)`* in `base-game-structures.js`. Every horizontal slab above
   the datum with headroom (wide, thin, at least 1.8 m under the next slab) becomes a deck
   `{x, z, w, d, y}`. Every `stair()` becomes a run of step decks the way `rampDecks` turns a ramp
   into steps; tread and rise are known, so emit one deck per step. Scatter ramps from the
   bot-viewer kinds already come in centre form; reuse `rampDecks` directly.
2. *Server bake.* `navRectsWithin` gains a sibling `navDecksWithin`; the zone bake passes `decks`
   and `levels` to `finalizeNavGrid`. The sight grid needs the level heights so a bot on a
   mezzanine sees over the rail; `attachLevels` already writes them on the grid.
3. *Blockers on levels.* Walls standing on an upper floor are rects with a base above the datum,
   which `structureNavRects` drops today. Emit them with their level's `y` so `rasterizeBlockers`
   blocks cells on that level only. Check whether `bot-viewer-v3` already does this for its
   lintels (the elevated geometry comment near line 1122) before adding it to `nav-grid.js`.
4. *Behaviour.* Nothing new. Cover corners and patrol points come from the grid, so a mezzanine
   corner is a cover corner. Confirm `patrolRing` reaches level cells, else add the head of each
   stair as a patrol point.

**Verify.** `test-base-game-structures.mjs`: a kind with a mezzanine yields decks above the datum
and step decks rising monotonically at the stair's rise. `test-base-game-npcs-room.mjs`: a bot at
the stair foot with a goal on the mezzanine finds a path through level cells. In the browser:
spawn NPCs by a building and watch one climb.

---

## Track 4: identical placement for every player

**Claim.** Placement is already identical; residency is not.

**Evidence.** Kind, site and scatter are pure functions of `(seed, tx, tz, plan)`, and the plan is
a pure function of the terrain descriptor. Two clients holding the same plan tile build the same
building. The gap is on the server: `ensure(positions)` in `base-game-structure-collision.js`
line 107 recentres its private plan window on the players' centroid. At `planTilesPerSide` tiles
of 128 m the window is about 1.5 km across, so players further apart than that put one of them
outside the server's collider. That player walks through buildings the page draws, and NPCs near
them bake without those buildings.

**Plan.**

1. *Per-player windows on the server.* One plan window per connected player (cheap: no GPU,
   `useWorker: false`) sharing one scheduler. Tiles are keyed by world coordinate, so two windows
   over one area build a tile once through the shared `tiles` map. `ensure` unions the keep sets.
2. *Bounded cost.* Windows are capped by the room's player cap; builds per call stay at
   `maxBuildsPerCall` across all windows, nearest-to-any-player first.
3. *Parity check.* A debug message from the page: a hash of `(kind, x, z, baseY)` for the nearest
   structure, compared against the server's on request, shown on the structures card as
   "server agrees" or the first differing field. The only way to see a desync.
4. *Terrain pads are part of this.* Track 2 puts pads in the source, so the ground agrees too. A
   page-side height stamp would break parity here, which is why Track 2 is designed that way.

**Verify.** `test-base-game-rooms-terrain.mjs`: two players 3 km apart both get a collider under
their nearest building. Existing single-player tests unchanged.

---

## Track 5: budgeting

**Claim.** Structures have counts but no budget: nothing limits what a frame spends on them, and
nothing reports what it spent.

**Evidence.** `stats` in `base-game-structures-page.js` counts tiles, meshes, triangles and total
bake ms. `ensure` caps *builds* per call, but one build is unbounded (model, collider
triangulation and scatter for a tile, on the main thread). Dress is unbudgeted: a tile with
scatter emits up to about 20 instanced meshes in one frame. The forest and flora both budget by
milliseconds (`flora-chunks.js` line 19, `budgetChunks` and `budgetMs`); structures do not.

**Plan.** Measure first, tune second.

1. *Measure.* Add per-frame `buildMs`, `dressMs`, `stampMs` and draw calls per tier to `stats`,
   with a rolling max. Show them on the structures card and in `frame-profiler.js` as a
   `structures` bucket beside terrain and flora. This alone says whether spikes are model,
   collider, dress or stamp.
2. *Split the build.* `build(tx, tz)` becomes a three-phase job like the NPC zone bake
   (model, collider, scatter), one phase per `ensure` call, so no frame carries all three. A frame
   budget `structuresBudgetMs` (slider, default *measure*, guess 1.5 ms) with the flora rule: at
   least one phase per frame so progress never stalls.
3. *Dress off the frame.* Keep the `compileAsync` warmup and add a per-frame cap on new groups
   (`dressPerFrame`, default 1). Far-tier rebuilds from Track 1 batch into one mesh, so they are
   one upload per reconcile, not one per tile.
4. *Memory.* Report resident collider triangles against `maxTrianglesPerChunk` × tiles, and the
   instanced-mesh count. Derive `keepRadius` from a memory target once the per-tile number is
   known.
5. *Server.* The same phase split in the room's `prepare`, so one player's arrival does not stall
   the tick. The NPC bake is already sliced this way.

**Verify.** Node: a build under budget runs at most one phase per call and completes in three.
Browser: the card's rolling max during a fast fly-through, and the profiler's structures bucket
under the slider.

---

## Order

Measure (5.1) first, because every other track is judged by it. Then LOD tiers (1.1) and
per-player windows (4.1), which are independent and mechanical. Then terrain pads (2), the one
track with a design risk (the source needing the site before the plan). Then upper-floor nav (3),
which builds on the model only and can run alongside 2. Occlusion (1.3) last, after the profiler
says where the draw cost is.

Each track is one or two commits, each with its test, the "Scattered structures" section of
`docs/subsystems/base-game.md` updated, and a row in `agent_log.csv`.
