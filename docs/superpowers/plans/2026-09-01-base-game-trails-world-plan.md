# Base Game trails on a world plan

**Status:** plan only, nothing built. Authored 2026-09-01.

The ask: bring the Pokémon Park's automatic trail routing into Base Game, on top of a planning
layer that knows what a large area of ground looks like long before any of it is rendered, so
trails (and later rivers) are decided kilometres ahead of the player. Placeholder sites stand in
for structures until structure worldgen exists.

This plan reuses the repo's existing pieces wherever one fits. The list of what has to be invented
is short and is called out in its own section at the end.

## What already exists, and what each piece does here

| Existing piece | Where | Role in this plan |
|---|---|---|
| Terrain source: `heightAt`, `heightAtSpacing`, `buildTile` | `terrain-source-analytic.js`, `terrain-source-v5.js` | The ground as a pure function. A tile at lod 1 or above is band-limited at its own spacing, so a 30 m plan tile is the smoothed ground, not aliased samples. |
| Toroidal field window | `terrain-clipmap-window.js` | The plan grid's storage: global posts, re-centring without copying, `sampleField`, `resolved`, derived channels. |
| Streamed field window + registry | `terrain-field-window.js` | Fills a window from the worker pool around a focus, one texture per field, CPU and TSL reads. The plan window is one more of these at a coarse post. |
| Field scheduler + priorities | `terrain-field-scheduler.js` | One queue for every window. The plan gets its own priority between water and placement. Runs synchronously in Node for tests. |
| Placement window with derived cover | `base-game-terrain.js` (`openFieldWindow`), `flora-field.js` | 8 m posts over 2 km, carrying `coverGrass`, `coverPlant`, `coverTree`. Trail clearing writes into these three channels; grass and trees already read them and need no change. |
| Trail router | `pokemon-park-old/park-trails.js` | A* over a cell grid: water refusal, grade cap, grade-squared cost, Chaikin smoothing, thinning. Moves to the root and gains a per-cell cost multiplier and a cross-slope test. |
| Road graph, index, meshing | `road-network.js`, `road-index.js`, `road-path.js`, `road-mesh.js` | Unchanged. `addRoadPath` snaps, splits and junctions; the index answers `nearestDistance`; the mesh builders drape on `ground.maxNear`. |
| Road system (THREE side) | `roads.js` | Materials and meshes. Gains an incremental rebuild and a residency radius so a growing network does not rebuild every edge on every commit. |
| Ground envelope | `pokemon-park-old/park-ground.js` (`surfaceMaxNear`) | The `maxNear` sampler over a height function at a cell spacing. Generalised into `road-mesh.js`'s `groundFromHeightFn`. |
| Seeded RNG and hashes | `forest-placement.js` (`rngFrom`, `hash2`) | Site generation per tile. |
| Shared world keys | `base-game-protocol.mjs` | `trailsEnabled`, `trailSeed`, `trailSpacing` join the list; the server relays them through `sanitizeBaseGameWorldPatch` with no per-key code. |
| Settings panel helpers | `base-game.html` (`createSection`, `addToggle`, `addRange`) | The Trails section. Settings persist through the existing slot section to disk. |
| Origin rebasing | `world-coordinates.js`, `base-game.html` `onRebase` | Road meshes are built render-local and the group shifts by the rebase delta, as `traversalLab.root` does. |
| Node test shape | `test-terrain-field-window.mjs`, `test-park-trails.mjs`, `test-roads.mjs` | The new tests copy their fixtures and assertions. |

## Architecture

```
terrain source (pure)                worker pool (terrain-field-scheduler)
        |                                        |
        v                                        v
 plan window  ---- 30 m posts, 16 tiles a side = 7.7 km, priority 25
   fields: heights (band-limited), biomeIds (v5)
   derived: planWalk (u8: 0 water/cliff, 1..255 = grade class + cross-slope class)
        |
        v
 base-game-sites.js   sitesForTile(seed, tx, tz, plan)  -> [{x, z, tier}]
        |
        v
 base-game-trails.js  legs = relative neighbourhood graph over sites in 3x3 tiles
                      route each leg with trail-router.js on a grid cut from the plan window
                      commit polylines to road-network.addRoadPath (one network, unbounded index)
        |                                    |
        v                                    v
 placement window (8 m)             roads.js meshes, incremental, resident within R of the player
   cover channels x trail gate          draped on ground.maxNear over the contact window / groundHeight
        |
        v
 grass-compute and base-game-trees read cover as they already do
```

Everything above the placement window runs kilometres ahead of the render and is a pure function
of the seed and the terrain descriptor, so every client and the room server would compute the same
plan without sending it.

## Steps

Each step is independently testable in Node. Order matters only where noted.

### 1. Move the router to the root: `trail-router.js`

Mechanical. `pokemon-park-old/park-trails.js` becomes `trail-router.js` (about 200 lines, no
THREE). `parkTrailLegs` stays behind in the old folder. Nothing at the root imports the old path
today, so nothing breaks.

Changes to the router itself, all small:

- `routeTrail` multiplies each step cost by `grid.costMul[j]` when the grid carries one. This is
  the hook for the existing-trail discount and for corridor preferences. About 3 lines.
- `buildTrailGrid` gains a `crossSlope` limit beside `maxGrade`: the steepest neighbour across the
  direction of travel rather than the single steepest neighbour. About 15 lines. The park's
  single-steepest test stays as the default when `crossSlope` is unset.
- `smoothPath` gets a `walkable(x, z)` recheck: a Chaikin point that lands in an unwalkable cell
  is pulled back to the original cell centre. The park never checked, and its smoothing could push
  a bend into the lake. About 10 lines.
- New `gridFromWindow(window, bounds, options)`: cuts a bounded `{nx, nz, cell, height, walkable,
  toWorld, toCell, options}` grid out of a field window for a leg's bounding box plus margin, reading
  `heights` and `planWalk`. Returns null when any post in the box is not resident, so a leg is only
  routed once its whole box has streamed. About 40 lines.
- `routeTrail` moves off `Map`, `Set` and per-node objects onto typed arrays sized to the grid:
  `Float64Array` g-scores, `Int32Array` came-from, `Uint8Array` closed, and a heap of cell indices
  keyed by a parallel `Float64Array` of f-scores. The park routed seven legs once at load; here a
  leg routes inside the frame loop, and a 2 km leg is about 6,000 cells, so per-node allocation
  would be a GC pause on every commit. About 40 lines changed, same algorithm, same answers, which
  the moved test asserts against the old implementation's routes on one seed before that
  implementation is deleted.

Test: `test-trail-router.mjs`, moved from `test-park-trails.mjs`, with the park fixture replaced by
the analytic source on a bounded grid. Adds: cross-slope refusal, cost multiplier steers a route,
smoothing never enters water.

### 2. The plan window: one more field window in `base-game-terrain.js`

Mostly mechanical. `openPlanWindow()` beside `openFieldWindow()`, through the same registry:

```
createFieldWindow({ source, scheduler, label: 'plan',
  fields: ['heights', 'biomeIds', 'planWalk'], derived: ['planWalk'], derive: planWalkDerive,
  post: 30, tileIntervals: 16, tilesPerSide: 16, priority: FIELD_PRIORITY.plan })
```

- `WINDOW_FIELD_KINDS` in `terrain-clipmap-window.js` gains `planWalk: { Array: Uint8Array,
  sampling: 'nearest' }`. One line.
- The plan window gets its **own** `createFieldScheduler({ workerCount: 1 })` rather than a
  priority in the shared one. The shared scheduler is one worker with four tiles in flight, and the
  plan's leading edge is sixteen tiles per 480 m walked; on the v5 source those are the most
  expensive tiles anything requests, and at any priority they would either starve the placement
  window (trees and grass arriving late) or be starved by it (the plan falling behind the player).
  A second worker costs one more module instance and nothing per frame. `FIELD_PRIORITY.plan`
  still gets a value for the label.
- `createFieldWindow` gains `gpu: false`: no `DataTexture` per field and no `needsUpdate` on
  commit. Nothing reads the plan on the GPU, and without this every plan tile landing would queue
  a re-upload of three 256 by 256 textures that no shader samples.
- Ordering at startup is handled in step 5 by the cover gate, not by priority.
- `planWalkDerive(tile)` lives in `base-game-plan.js` (new, pure, about 60 lines): per texel,
  water flag from height against sea level plus margin, grade and cross-slope classes from the
  tile's own heights (the apron of one post supplies the neighbour ring), packed into one byte.
  Cliff and water are 0 so the router's walkable test is a single compare.
- The window is acquired by the trail planner (step 4) and streams only while something holds it,
  exactly like the placement window.
- `terrain.stats` reports the plan window's coverage beside the others, so the Terrain world line
  in the panel can say how far ahead the plan has filled.

Cost, measured before shipping rather than assumed: 256 tiles of 17 by 17 posts is about 74,000
band-limited samples for a full window, and the ring that streams as the player walks is a
fraction of that. The analytic source will be well under a frame in the worker. The v5 source's
`heightAtSpacing` is a multi-sample average and could be tens of microseconds per post, which is
seconds per full window in one worker. That is fine for a window that runs kilometres ahead, but
the number goes in the doc.

Test: `test-base-game-plan.mjs`. A window over the analytic source filled synchronously through the
scheduler; every water post is 0; a post next to a sea-level cliff is 0; the same tile derived twice
is byte-identical; tile arrival order does not change any byte.

### 3. Placeholder sites: `base-game-sites.js`

Invented, small (about 60 lines), pure. `sitesForTile(seed, tx, tz, plan)`:

- `rngFrom(hash2(tx, tz, seed))` from `forest-placement.js` jitters one candidate around the tile
  centre.
- The candidate walks to the flattest walkable post within a fixed radius (a small ring scan on
  `planWalk`, the same shape as the router's `snapToWalkable`).
- A tile with no walkable post within the radius yields no site. Gaps are wanted.
- Every site is tier 1. Spawn (0, 0) is always a site.
- Returns null, not an empty list, when the tile's plan posts are not all resident, so the caller
  defers rather than records a site invented from missing data. This is the placement rule the
  terrain doc already states for cover.

The interface is the seam structure worldgen later replaces: `{x, z, tier}` in, nothing else out.

Test: `test-base-game-sites.mjs`. Determinism across calls and across tile order; no site in water;
a tile of open sea yields none; spawn is present.

### 4. The planner: `base-game-trails.js`

The one genuinely new module (about 200 lines). It owns the plan window handle, the site cache,
the leg schedule, and one `createRoadNetwork` instance.

Per update, given the player's global position:

1. Recentre the plan window (the registry does this for every window already).
2. Only when the plan window's `version` has changed since the last scan: walk the tiles of the
   window once, in a preallocated order, and site any newly resident tile with `sitesForTile`.
   The scan never runs on a frame where no tile landed, and it never allocates: tile keys are
   integers packed the way `road-index.js` packs cells, not strings.
3. For every sited tile whose eight neighbours are also sited and which has not been "legged",
   build the legs: the relative neighbourhood graph over the sites of the 3 by 3 block, keeping only
   edges whose nearer endpoint lies in this tile. That rule gives each edge exactly one owner tile,
   so no leg is routed twice and the set of legs is a pure function of the seed.
4. Route **one** pending leg per update, and only when the frame has budget (the planner is
   handed the same `yieldTask`-style budget the forest builder uses). Candidates are ordered by
   canonical key (tier, then owner tile key, then endpoint key). A leg is eligible only when
   `gridFromWindow` returns a grid for its bounding box plus margin, **and** every leg with a lower
   key whose box intersects its box has already been routed or was dropped. That dependency rule
   is what makes the result independent of which direction the player approached from: without
   it, the existing-trail discount in step 5 would let peer A route leg 1 before leg 2 and peer B
   the reverse, and the two networks would differ. Legs longer than a cap (2 km) are dropped at
   graph time, never routed.
5. Before routing, fill `grid.costMul` from the network's index: a post within a road's clear
   margin costs 0.35 of open ground. That is the existing-trail discount and is what makes legs
   merge into a network instead of running parallel. `NAV_TRAVEL_COST_MAX`'s comment in
   `nav-grid.js` warns that a discount below 1 breaks A*'s optimality guarantee; here that is
   acceptable, the route only has to be plausible, and the multiplier applies to the g-score, not
   the heuristic, so A* still terminates with a valid path.
6. Refine the routed polyline: resample at 6 m and drop each point onto the plan's band-limited
   height, then hand it to `network.addRoadPath`. The road stack's own `samplePathOnGround`
   resamples against the real ground at mesh time.
7. Stamp the trail into the placement window's cover channels (step 5).
8. Prune: when an owner tile leaves the plan window, its legs' edges are deleted from the network
   (`deleteEdge` and `pruneOrphans` exist) and the tile is forgotten, so the network, the index
   buckets and the site cache stay bounded by the window rather than by how far the player has
   walked. A tile that comes back is re-sited and re-legged from the seed and routes identically,
   by the dependency rule above.

Determinism across peers: the network's node and edge ids depend on commit order, but nothing that
crosses the wire uses them. Trails as geometry are identical for the same seed and terrain
descriptor. A test asserts that two planners fed the same tiles in different orders, and one
planner that prunes a tile and gets it back, produce the same set of sampled edge polylines.

What is not in this step: rivers, tiers, sites with any meaning, NPCs preferring trails.

Test: `test-base-game-trails.mjs`. A planner over the analytic source filled synchronously; legs
route; no sampled point is under water; the grade along every edge is under the cap; at least one
junction exists on a seed chosen to produce one; order independence as above.

### 5. Clearing: write trail cover into the placement window

Small changes in three files, and no change to grass or trees:

- `terrain-clipmap-window.js`: `touch()` bumps `version` so the field window re-uploads the
  texture after an in-place write. Three lines.
- `terrain-field-window.js`: expose `touch` and a `stampAlong(names, polyline, radius, fn)` that
  walks only the resident posts within `radius` of each sampled point of the polyline and lets
  `fn(x, z, value)` return the new value. Along the path, never over the leg's bounding box: a 2 km
  leg's box is 62,500 posts at 8 m, each needing a distance query, which is tens of milliseconds on
  the frame that commits the leg. Along the path it is a few posts per sample. About 25 lines.
- `flora-field.js`: `createTileCover` accepts an optional `clearance(x, z)` returning 0..1, applied
  as a multiplier to all three channels in `derive`. About 6 lines. `base-game-terrain.js` passes
  `clearance: (x, z) => trails.clearanceAt(x, z)`, which is 0 within the clear margin of any
  committed trail, ramping to 1 over a fade distance, from the road index's `nearestDistance`.

Two orders are possible and both are handled with no deferral:

- Trail committed first, placement tile arrives later: `derive` calls `clearance` and the tile
  lands already cleared.
- Placement tile resident first, trail committed later: the planner calls `stampAlong` with the
  same clearance rule and touches the window.

Trees placed before a late trail: `base-game-trees.js` already defers a chunk whose cover reads
null, and never re-places a chunk on its own. So `terrain.coverAt` returns null while the plan is
not **settled** around the point, where settled means every leg whose box covers the point has been
routed or dropped, which the planner answers from its per-tile state in constant time. Trees then
wait for the plan the way they already wait for the field, and no tree is ever placed on a trail
that arrives later. Grass reads the GPU texture, not `coverAt`, so it is not gated; a blade that
sprouts before the stamp disappears on the next recull, and grass keeps no records. This replaces
the "known gap" an earlier draft of this plan carried, with no change to the trees module.

Resolution note: 8 m posts sampled bilinearly turn a 3.6 m trail into a roughly 8 to 10 m cleared
band with soft edges. That reads as a clearing with the path down the middle, which is acceptable
for a first version. The contact window at 1.25 m posts could carry the same stamp later for a
crisp verge near the player.

Test: extend `test-flora-field.mjs` with the clearance multiplier, and `test-base-game-trails.mjs`
with a stamp-then-read on a window.

### 6. Meshes: `roads.js` grows an incremental rebuild and residency

Mostly mechanical, in the one THREE file of the road stack:

- `rebuild()` keeps a `Map<edgeId, {builtRevision, meshes}>` and a matching one for nodes.
  Unchanged edges keep their meshes; new or changed ones build; edges gone from the network
  dispose geometry (materials are shared and live for the system's lifetime). Today it disposes
  and rebuilds everything, which is fine for a hand-drawn arena and wrong for a network that
  grows every few seconds.
- Building is budgeted: **one edge or node patch per update**, taken from a queue, so a junction
  with three arms arriving in the residency ring costs four frames, never one. The roads doc
  measured 3.8 ms and 11k vertices for one road on the bot viewer, which is already most of a
  frame.
- `setResidency(x, z, radius)`: only edges with a sampled point within `radius` hold meshes.
  Evaluated when the player has moved more than a tile-sized stride (16 m) since the last
  evaluation, not per frame, and through the index's bucket query for the radius, not a walk of
  every edge. Beyond the radius the network exists (index, clearing, later nav) but draws
  nothing. The far clipmap is not asked to show trails in this plan.
- Meshes are built render-local: the ground callback receives global coordinates, the vertex
  buffer stores position minus the render origin, and `base-game.html`'s existing `onRebase`
  handler adds the delta to the road group like it does for the lab root.
- `groundFromHeightFn(heightAt, { cell })` in `road-mesh.js` gains the park's `surfaceMaxNear`
  ring scan when a `cell` is given, so a host with only a height function still gets an envelope.
  About 15 lines moved, not written.
- A distance fade on the road material, one `uniform` for the fade start driven from the
  residency radius, so an edge entering the ring grows in over the last 20 m instead of popping.
  The feather already carries a `roadAlpha` attribute; the fade multiplies it.

**The ground the road drapes on is the contact window, not `groundHeight`.** `groundHeight` in
volumetric mode is `surfaceYAt`, a bisection scan the terrain module measures at about 26 µs per
call. `maxNear` calls the height nine to twenty-five times per vertex, and an edge has thousands
of vertices, so one edge would cost on the order of a second of main-thread time. The contact
window already holds `surfaceHeights` (volumetric) or `heights` at 1.25 m posts, lod 0, over 160 m,
which is exactly the field the near chunks are built from, and `terrain.contactHeightAt` reads it
bilinearly for nanoseconds. So the ground is
`{ heightAt: terrain.contactHeightAt, maxNear }` with `cell` equal to the near chunk's vertex
spacing (30 m over 22 segments, about 1.36 m, read from `terrain.system.chunkSegments`), and an
edge is eligible for a mesh only when `terrain.contactReady` holds at both its ends. Residency
radius defaults to the contact window's safe reach (about 70 m), which is inside the exact-chunk
draw radius of 90 m, so no road mesh is ever built over ground that has not been drawn or
sampled.

Whether the chunk triangulation departs from the contact field by more than the road lift, as the
bot viewer's did by 0.21 m, is a measurement to make in the browser, and the roads doc explains
what to do if it does.

Test: extend `test-roads.mjs` for the incremental map (add an edge, only it builds; delete one,
only it disposes; a second rebuild with nothing changed builds nothing) and for
`groundFromHeightFn` with a cell.

### 7. Wiring in `base-game.html`

Snapshot to `versions/` first. Then:

- Imports for the planner and `createRoadSystem`; construct the planner after `terrain`, before
  `flora` and `forest` so the placement window's derive sees the clearance hook.
- `planner.update(playerGlobal)` in the frame loop beside `terrain.update`; `roads.setResidency`
  from the same position.
- Settings: `trailsEnabled` (default on), `trailSeed`, `trailSpacing` (metres between sites, the
  plan tile size by default), `trailWidth`, `trailMaxGrade`, `trailShow` (local look). A Trails
  section using `addToggle` and `addRange`, following the Terrain world section. A note line with
  plan coverage, sites, legs routed, legs pending, edges resident, refreshed on the same
  `runtimeStatusNextMs` interval the terrain runtime line uses, never per frame.
- Shared keys in `base-game-protocol.mjs`: `trailsEnabled` in `BOOLEAN_KEYS`; `trailSeed`
  `[0, 1e9]` rounded like the other seeds; `trailSpacing`, `trailWidth`, `trailMaxGrade` in
  `NUMBER_LIMITS`. The server already relays whatever passes the sanitizer.
- A seed or spacing change clears the planner (sites, legs, network, meshes) and re-stamps cover by
  clearing the placement window, the same way a sea level change does today.
- Vision modes: road materials get the same heat tag the terrain gets, so a trail is not a hole in
  the thermal view. One call, wherever the terrain does it.

### 8. Docs and log

- `docs/subsystems/roads.md`: a "Trail routing" section replacing the park paragraph, the router's
  new options, the incremental rebuild and residency.
- `docs/subsystems/base-game.md`: a "World plan and trails" section under the roadmap: the plan
  window, its priority and cost, the site seam, the clearing path, the known tree gap, and the
  rivers follow-up.
- `docs/subsystems/terrain.md`: the plan window in the field window list and the `planWalk` field.
- `docs/subsystems/vegetation.md`: cover now carries trail clearance.
- `CLAUDE.md` Roads row: add `trail-router.js`, `base-game-plan.js`, `base-game-sites.js`,
  `base-game-trails.js`.
- `agent_log.csv`: one row per step above.

## Frame-loop audit of this plan (improve-webgpu, 2026-09-01)

The plan was reviewed against the frame-loop checklist before any code exists, so these are
inferred from the design and the repo's own measurements, not measured. Each one changed the step
it names.

| Severity | Finding in the first draft | Where it would have run | Amendment |
|---|---|---|---|
| High | Road meshes draped on `groundHeight`, which is a 26 µs bisection scan per call in volumetric mode, called nine to twenty-five times per vertex by `maxNear` | Every edge build, on the main thread | Drape on the contact window's arrays through `contactHeightAt` (step 6) |
| High | Cover stamping over a leg's bounding box: 62,500 posts and a distance query each for a 2 km leg | The frame that commits a leg | `stampAlong` the polyline only (step 5) |
| High | Router allocating a `Map` entry, a `Set` entry and a heap object per expanded cell, thousands per leg | The frame that routes a leg | Typed-array A* (step 1) |
| High | Unbounded edge builds per rebuild: a junction arriving could build four meshes in one frame at several milliseconds each | Residency changes | One build per update from a queue (step 6) |
| High | Planner scanning 256 plan tiles per frame with string keys to find newly resident ones | Every frame | Scan only when the window's version changed, integer keys (step 4) |
| Medium | Plan tiles competing in the shared one-worker field scheduler with placement tiles | Streaming while walking | Own scheduler and worker (step 2) |
| Medium | Three plan textures re-uploaded on every tile commit though no shader reads them | Every plan tile landing | `gpu: false` on the window (step 2) |
| Medium | Residency by walking every edge with a distance test | Every frame | Index bucket query on a 16 m movement stride (step 6) |
| Medium | Network, index and site cache growing with distance walked | Memory | Prune by owner tile leaving the plan window (step 4) |
| Medium | Road meshes popping at the residency radius | Visual, inferred | Distance fade uniform (step 6) |
| Low | Trails note line rewritten per frame | Every frame | Existing status interval (step 7) |

One correctness finding came out of the same pass: the existing-trail discount made routes depend
on which leg a peer happened to route first, which the approach direction decides. Step 4's
dependency rule (a leg waits for every lower-keyed leg whose box intersects its own) removes the
order dependence, and the determinism test now covers approach order and prune-and-return.

Visual rubric rows that cannot be checked until it renders, and what to look at when it does:
scale and contact (trail floating or sunk against the chunk mesh, the 0.21 m question), image
stability (feather edge shimmer at grazing angles, since the shoulder alpha is per vertex),
transparency (the feather's `depthWrite` against grass blades), and the thermal view (the road
material's heat tag).

## What is invented, in full

- `base-game-trails.js`, the planner: tile siting, leg ownership, canonical order, routing
  budget, cover stamping. About 200 lines.
- The relative neighbourhood graph. Not in the repo. About 25 lines inside the planner.
- `base-game-sites.js`. About 60 lines.
- `planWalkDerive` in `base-game-plan.js`. About 60 lines.
- Incremental rebuild and residency in `roads.js`. About 80 lines replacing the current rebuild.
- The router's typed-array rewrite of its open and closed sets, about 40 lines changed.
- Small hooks: `costMul` and cross slope in the router, `touch` and `stampAlong` on the windows,
  `gpu: false` on the field window, `clearance` in the tile cover, `cell` in `groundFromHeightFn`,
  the distance-fade uniform on the road material, one field kind, one priority.

Everything else is an import.

## What is uncertain

- **Ground agreement.** Whether the chunk mesh departs from `groundHeight` by more than the road
  lift, on both the analytic and v5 sources, and in volumetric mode. A browser measurement, and the
  roads doc already has the two remedies.
- **v5 plan tile cost.** How long a 17 by 17 band-limited tile takes on the v5 source. Measured in
  Node in step 2's test, reported in the doc; if it is too slow the plan post goes to 60 m, which
  the router's cell option already allows.
- **Look of the clearing at 8 m posts.** Whether a 3.6 m trail in an 8 to 10 m soft clearing
  reads right, or the contact window needs the stamp too. A browser judgement after step 7.
- **Trail density.** One site per 480 m tile and a relative neighbourhood graph is a guess at a
  pleasant density. `trailSpacing` is the one knob, and it is shared.

## After this plan

- **Rivers.** `bot-terrain.js`'s `erodeGrid` already has the flow accumulation and pit filling
  over a bounded grid. On the plan window it becomes a per-tile-block pass that writes a `flow`
  channel; rivers are the posts above a flow threshold, and the router's water rule reads them
  through `planWalk`, with fords where flow is low and banks are gentle. The window and the derive
  hook are the same ones this plan builds.
- **Tiers and sites with meaning.** Structure worldgen replaces `sitesForTile` and the planner's
  width comes from the tier.
- **NPCs on trails.** `nav-grid.js` already has `setNavTravelCost`; the bot viewer biases bots
  onto roads with it. Base Game's server would need the same network, which the determinism
  argument above makes possible without sending it.
- **Per-chunk tree re-place** for the late-trail gap.
