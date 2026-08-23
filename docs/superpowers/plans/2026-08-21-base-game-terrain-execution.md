# Base Game terrain execution plan

STATUS: Phase 1 shipped 2026-08-22 (`terrain-source.js`, `terrain-source-analytic.js`, worker `sourceTile` job, `test-terrain-source.mjs` 65 checks). Phase 2 shipped 2026-08-22 (`terrain-system.js` accepts `source`, `setSource()` swaps with epoch bump + stale-chunk retention, finite-bounds clipping; `test-terrain-system.mjs` cases 7–11, worker test cases 2–3; baseline matrix green). Phase 0A shipped 2026-08-22 (`terrain-project-v5.js`, `terrain-editor-bridge.js`, `base-game-terrain-studio.js`, editor embedded mode + shared normalizer, `-project.json` in `serve.py`/`publish-map.js`, Terrain Studio on start/pause menus + Terrain panel + state/perf wiring; 5 new/extended Node tests green; never opened in a browser). Phase 3 shipped 2026-08-22 (`world-query-heightfield-provider.js`, `test-world-query-heightfield.mjs`). Phase 4 shipped 2026-08-22 (`base-game-terrain.js`, `terrain` world mode + Terrain world panel in `base-game.html`, `test-base-game-terrain.mjs`; never opened in a browser). Phase 7 shipped 2026-08-22 (`createUnboundedFieldSampler`, `prepareStack`/`evaluateStackPoint`, `createClassicHeightPoint`, project algorithm versions + `migrateProjectToUnbounded`, `terrain-source-v5.js`, editor Climate-fields select + worker `unbounded`, Base Game Apply transaction; `test-terrain-source-v5.mjs`; not yet opened in a browser). Phase 8 shipped 2026-08-22 as STREAMED VOLUMETRIC TERRAIN (not a hole list): unbounded 3D density noise, `densityAt`, `volume` tile field with per-chunk marching cubes + gradient normals, `world-query-chunk-mesh-provider.js`, Base Game `terrainVolumetric` toggle; `test-terrain-volume.mjs` fixture (surface / cave at same X/Z / return). Phase 5 shipped 2026-08-22 ahead of the acceptance gate at the user's request: protocol 4 `terrain` config on create, per-room worlds cached by version, heightfield-only (volumetric refused), project body inline in create/joined rather than a published asset key; `test-base-game-rooms-terrain.mjs`. 2026-08-22 later: owner-controlled live world switching (`base:set_terrain`, protocol 5) and volumetric rooms (server-side `terrain-volume-collision.js`) shipped; volumetric fall-through fixed (`surfaceYAt`, provider handoff, `holeAt`). Remaining: 6, 9, asset-key publishing. This continues the terrain track in
`2026-08-21-base-game-player-body-terrain-parallel.md`. Pure source/provider work may proceed under
tests while the multiplayer acceptance gate closes. Terrain must not become an authoritative live
room world until that gate passes.

## Objective

Bring finite and infinite terrain into Base Game through one renderer-independent source contract,
the existing global-coordinate and `worldQuery` contracts, and the repository's proven chunk
streaming code. Start with ordinary culled chunks and the existing analytic field. Add finite maps,
Terrain Generator v5 recipes, caves, and flight-scale visual LOD in that order.

The plan deliberately does not design another terrain generator, player collider, coordinate space,
room protocol, or world-query API.

## Existing systems and exact disposition

| Existing code | Proven responsibility | Base Game decision |
|---|---|---|
| `terrain-field.js` | Renderer-free analytic `heightAt`, normal, chunk arrays, apron height tiles and bilinear sampling | Reuse unchanged as the first source implementation and compatibility fixture |
| `terrain-worker.js` | Transferable chunk/tile worker transport | Extend to construct the selected pure source from a descriptor; retain the current analytic message path |
| `terrain-system.js` | Nearest-first window, worker lifecycle, epochs, stale-result rejection, bounded build/unload, ordinary chunks and active-chunk metadata | Reuse as the initial renderer/streamer; inject a source instead of hard-coding `terrain-field.js` |
| `collision.js` | Pure heightfield contact and slide math | Reuse inside the one necessary heightfield-to-`worldQuery` adapter |
| `world-query.js` | Synchronous composition of terrain, mesh, cave and dynamic providers | Keep unchanged; terrain registers as one provider |
| `terrain-loader.js` | Browser GLB loading, exported map data, material application and finite samplers | Preserve rendering behavior; extract its pure map-data normalization/sampling so client and server share it |
| `map-collision.js` and `world-query-map-provider.js` | Static 3D mesh/BVH collision | Continue to own buildings, bridges, cave interiors and volumetric finite-map geometry |
| `terrain-stack.js`, `terrain-noise.js` | Pure v5 layer definitions and evaluation | Extend minimally with a shared point evaluator for infinite-compatible layers |
| `terrain-generator-js.js` | Bounded v4/v5 full-grid pipeline, erosion, derived fields, biomes and materials | Preserve for authored finite exports; reuse its pure classifiers where a point/tile equivalent is valid |
| `terrain-gen-worker.js` | Bounded authoring-preview/full-grid worker | Do not use as the moving runtime tile worker |
| `terrain-generator-v5.html` project JSON | Existing recipe/paint/import artifact | Keep as the only recipe format; version it when infinite sampling semantics are added |
| `flight-terrain.js` and `demos/flight-sim.html` | Band-limited analytic height and five snapped geometric clipmap rings | Reuse the ring/snap/band-limit principles after ordinary chunks work |
| `cdlod-select.js` | Tested bounded quadtree selection and morph math | Retain as a possible renderer selector and test reference |
| `cdlod-terrain.js` | One-draw GPU CDLOD tied to a duplicated analytic TSL height function | Do not import as the generic renderer until its embedded height twin is replaced by source tile sampling |
| `bot-terrain.js` | Strong deterministic bounded arena terrain, pads, features and tests | Use as test/design evidence only; do not make it a second Base Game source pipeline |
| Environment Viewer v2 | Runtime orchestration of finite GLB maps and analytic infinite chunks | Extract module ownership, not HTML control flow |
| Bot Viewer v3 | Pure-field and bounded collider-budget practices | Reuse tests/patterns, not its arena-specific field |
| Pokémon Park | Failed integration and performance evidence | Do not import player, terrain, flora or camera plumbing |

## Verified baseline

The following passed before this plan was written:

- `test-terrain-field.mjs`
- `test-terrain-tile-seam.mjs`
- `test-terrain-worker-heighttile.mjs`
- `test-terrain-system.mjs`
- `test-terrain-v5.mjs` — 395 checks
- `test-terrain-generator-js.mjs` — 94 checks
- `test-bot-terrain.mjs` — 44 checks
- `test-cdlod-select.mjs`
- `test-cdlod-morph.mjs`
- `test-cdlod-morton.mjs`

Every phase below preserves this matrix.

## Minimal terrain-source contract

Add `terrain-source.js` as a pure contract/normalization module. A source contains no Three.js,
scene, camera, worker or network object.

```js
{
  descriptor: {
    contractVersion: 1,
    kind: 'analytic' | 'finite-map' | 'v5-recipe',
    key: string,
    sourceVersion: string,
    algorithmVersion: string,
    bounds: null | { minX, maxX, minZ, maxZ },
    capabilities: string[]
  },

  contains(x, z),
  heightAt(x, z),
  normalAt(x, z, out),
  surfaceAt?(x, z, out),
  holeAt?(x, z),
  buildTile(request)
}
```

`buildTile()` is synchronous and pure so it can run inside `terrain-worker.js` or under Node. The
streamer remains asynchronous because it owns the worker and returns completed tiles later. This
matches the existing `buildHeightTile()`/worker split rather than introducing a Promise into the
synchronous world-query path.

The normalized request is:

```js
{
  ix, iz, lod,
  xMin, zMin, size,
  intervals,
  apron,
  fields
}
```

The normalized result keeps the established height-tile names:

```js
{
  key, ix, iz, lod,
  xMin, zMin, size,
  intervals, texels, step, apron,
  originX, originZ,
  heights,
  normals?, biomeIds?, materialFields?, moisture?, holeMask?
}
```

Rules:

- `xMin`, `zMin` and samples are global coordinates.
- Tile keys include source key/version, epoch, LOD and integer tile coordinates.
- `lod: 0` is authoritative full-detail terrain. Higher LODs are presentation data.
- Typed-array dimensions are validated at the worker boundary.
- Missing optional fields are absent, not zero-filled guesses.
- `contains()` is false outside finite bounds and inside an active terrain hole. A finite source does
  not silently create a sea-level floor outside its map.
- Source descriptors contain reproducible configuration, not camera/render settings.
- A source cannot claim `infinite` capability if it depends on finite paint/import grids, bounded
  erosion, lake discovery or volumetric export without a regional solution.

## Terrain authoring and configuration workflow

The complete Terrain Generator v5 project is the terrain source configuration. Base Game must not
grow a second hand-written set of v5 layer controls that can drift from the authoring tool.

### One editor, two hosts

Keep `terrain-generator-v5.html` as the canonical v5 interface and make that same interface available
as a full-screen **Terrain Studio** screen inside Base Game's start and pause menus. The first
integration may host the same-origin editor page in an embedded frame rather than extracting the
entire monolithic UI at once. While Terrain Studio is open, Base Game releases pointer lock, pauses
simulation and suspends its world render; the editor owns the visible WebGPU preview. Closing the
screen resumes the game without rebuilding terrain unless a project was applied.

Standalone Terrain Generator v5 retains its existing Project JSON, GLB export and publish controls.
Embedded mode adds only the host bridge and Apply/Cancel actions. All layer, erosion, paint, import,
density, material and preview controls remain the actual v5 controls.

Extract the project lifecycle currently embedded in the HTML into one renderer-free module used by
both hosts:

- `terrain-project-v5.js` owns project normalization, version migration, validation, canonical
  serialization, content hashing and capability classification.
- It preserves every existing `cfg`, `density`, `stack`, `paint` and `imports` field. Unknown or
  unsupported fields are rejected or explicitly preserved by version policy; they are never silently
  replaced with defaults.
- `terrain-generator-v5.html` uses this module for Project JSON save/load instead of maintaining a
  private second normalizer.
- The eventual `terrain-source-v5.js` accepts only a normalized project produced by this module.

Use a small same-origin message bridge rather than reaching through frame globals:

```js
// Base Game -> editor
{ type: 'terrain-v5:load-project', requestId, project }

// editor -> Base Game
{ type: 'terrain-v5:ready' }
{ type: 'terrain-v5:apply-project', requestId, project }
{ type: 'terrain-v5:close', requestId }
```

Both sides validate `event.origin`, `event.source`, message shape and `requestId`. The returned project
is normalized and hashed again by Base Game; an embedded editor is not an authority boundary.

### Base Game terrain controls

The ordinary Terrain panel stays compact:

- current project name/key, project version, content hash and compatibility status
- **Open Terrain Studio**
- Apply status: unchanged, draft, validating, rebuilding, active or failed
- revert to the last active project
- source-independent visual, LOD, streaming-budget and debug controls

There is no duplicate forest of per-layer sliders in this panel. Terrain Studio is the in-game way
to configure all v5 terrain parameters.

### Apply is a transaction

Editing the Terrain Studio preview does not regenerate the live world on every slider movement.
Pressing Apply performs one explicit transaction:

1. Normalize, validate and capability-classify the project; compute its canonical content hash.
2. Construct a candidate source and generate the spawn/core tile off the frame loop.
3. If validation or generation fails, retain the active source and report the exact unsupported layer
   or invalid field.
4. If it succeeds, bump the terrain epoch and replace chunks under the existing bounded build/install
   budgets. Keep complete old chunks until their replacements are ready.
5. Preserve the player's global position when it remains supported. Use the established safe-spawn
   and respawn path only if the new source leaves that capsule unsupported.

Applying terrain is allowed from a paused Solo game. It never mutates an active multiplayer room
silently. Multiplayer terrain replacement is an explicit room restart/resync operation described
below.

### State files and performance records

A Solo Base Game state file embeds the complete normalized v5 project, including paint and imported
field data, so every configured parameter is loadable without relying on browser-local state. It also
stores the project key, project version, algorithm version and content hash. Loading state validates
the hash and uses the same Apply transaction; it does not directly assign live source internals.

Performance records do not duplicate a potentially large project on every capture. They store the
project key/hash/version, compatibility classification, a compact layer/config summary and the
existing terrain runtime counters. The state file remains the self-contained configuration artifact;
the performance log remains an efficient measurement artifact.

### Publishing and multiplayer ownership

The current v5 local export and hosted publish paths save baked GLB/map-data but not the project JSON.
Extend those existing paths to write a sibling `-project.json` artifact and its canonical hash. Do not
invent a separate terrain registry while the map registry can own this immutable source artifact.

Multiplayer room descriptors carry only a validated project asset key, content hash, project version
and algorithm version. They do not put full projects, paint rasters or import grids into snapshots or
WebSocket messages. The server loads the published project, normalizes it through the shared module
and constructs the authoritative source. A draft must be published before it can start or replace a
multiplayer room. Initially, **Apply to multiplayer** means confirm, restart the room world, rebuild
the source, respawn/resync all players, and expose the new hash before accepting movement.

## Shared versus local settings

The source of authoritative collision must be room-owned. Rendering quality must not be.

Shared and server-validated:

- `worldMode`: `empty`, `traversalLab`, or `terrain`
- `terrainSourceKind`
- `terrainSourceKey`
- `terrainSourceVersion`/content hash
- source seed or normalized analytic parameters when they are the complete source artifact

Local, saved, and captured but never authoritative:

- terrain visual visibility
- Terrain Studio draft state while it is open
- ordinary-chunk draw radius
- selected visual LOD renderer
- wireframe, normals, tile-boundary and collision debug views
- texture/shader quality
- worker/build budget within server-approved minimum residency rules

A player may hide terrain for diagnosis, but doing so does not disable server collision.

## File-by-file implementation sequence

### Phase 0A — shared v5 project model and embedded-editor bridge

This phase may proceed independently of runtime v5 tile evaluation. It establishes configuration
ownership early, while Phase 1's already-shipped analytic source remains the terrain contract fixture.

Create:

- `terrain-project-v5.js`
- `terrain-editor-bridge.js`
- `test-terrain-project-v5.mjs`
- `test-terrain-editor-bridge.mjs`

Modify:

- `terrain-generator-v5.html` to use the shared project module and expose same-origin embedded mode
- Base Game menu/state modules to host the full-screen Terrain Studio, pause/suspend the game while it
  is open, and retain an unapplied draft separately from the active source
- `serve.py` and `server/publish-map.js` so local export and hosted publication persist and serve the
  sibling `-project.json` plus content hash
- existing save/publish tests for project round-trip, malformed project rejection and path safety

Required checks:

- A standalone v5 project save/load round-trip remains byte-equivalent after canonicalization.
- Every current v5 configuration category survives editor -> Base Game -> state save -> state load ->
  editor without resetting to defaults.
- The embedded and standalone editors produce the same normalized project and hash.
- Closing without Apply leaves the active source and epoch unchanged.
- Opening Terrain Studio pauses simulation, releases pointer lock and suspends Base Game world draws;
  closing it restores the previous menu/game state.
- Cross-origin, stale-request and malformed bridge messages are rejected.
- Local and hosted publication write a retrievable project artifact whose bytes match its hash.
- V5 Apply remains disabled with a precise status until `terrain-source-v5.js` lands in Phase 7; the
  editor, project/state round-trip and publication paths are still usable before then.

### Phase 1 — pure source contract and analytic adapter

Create:

- `terrain-source.js` — descriptor/request/result validation, tile key helpers and source factory
- `terrain-source-analytic.js` — adapter over `terrain-field.js`
- `test-terrain-source.mjs`

Modify:

- `terrain-field.js` only if a small argument-normalization export is needed; do not rewrite its math
- `terrain-worker.js` to accept a normalized source descriptor while retaining current messages

Required checks:

- Analytic source point heights and normals exactly match `terrainHeightAt`/`terrainNormalAt`.
- Its LOD-0 tiles exactly match `buildHeightTile`.
- Negative tile coordinates, diagonal corners and aprons remain seam-identical.
- Descriptor and tile validation rejects non-finite coordinates, malformed dimensions and unknown
  source kinds.
- The source imports under Node and the worker produces transferable arrays.

No Base Game HTML or collision changes occur in this phase.

### Phase 2 — source-injected ordinary chunk streaming

Modify `terrain-system.js` rather than creating another chunk manager:

- Add an optional `source`/source-descriptor input.
- Preserve the current parameter-only construction as the Environment Viewer compatibility path.
- Keep nearest-first target selection, worker reuse, epoch invalidation, stale-result rejection,
  bounded builds/unloads, active chunk metadata, cold-start behavior and ordinary frustum culling.
- Build visible geometry from completed source tile heights rather than calling a hard-coded field.
- Keep old complete chunks until the same-key replacement is ready.
- Store source key/version, tile LOD and global bounds in chunk metadata.
- Do not synchronously regenerate all chunks when a source parameter changes; bump epoch and replace
  them under the existing budget.

Extend:

- `test-terrain-system.mjs` with injected-source, stale-source-epoch, replacement-without-hole and
  finite-bounds cases.
- `test-terrain-worker-heighttile.mjs` with descriptor round-trip and bad-result rejection.

The first rendered source remains the existing analytic field. This phase proves the seam before
introducing v5 complexity.

### Phase 3 — heightfield world-query provider

Create:

- `world-query-heightfield-provider.js`
- `test-world-query-heightfield.mjs`

The provider reuses `collision.js` and exposes only established world-query capabilities:

- `groundProbe` samples `heightAt`/`normalAt`, respects finite bounds, holes, maximum distance and
  slope limit, and returns the source/collider identity.
- `resolveCapsule` uses the existing ground-contact and slide math to seat the capsule and remove only
  velocity into the surface.
- `acceptsQuery` rejects queries outside finite source bounds before sampling.
- It never returns a ceiling or wall. Terrain overhangs, cave interiors and buildings are mesh-BVH
  providers.

Required checks:

- Capsule rest, penetration correction, slope slide, jump preservation and no-hit behavior.
- Ground probes select terrain only when it is below the supplied 3D origin and inside max distance.
- Holes return no terrain hit, allowing a lower cave-mesh provider to answer.
- A bridge/cave mesh provider and terrain provider compose without changing `worldQuery.js`.
- Provider methods are synchronous and allocate no per-step source objects.

Do not build a terrain BVH merely to collide with an ordinary 2.5D outdoor heightfield.

### Phase 4 — Base Game Solo vertical slice

Create `base-game-terrain.js` as the presentation/runtime owner. It may own the injected
`terrain-system`, scene group, source descriptor, worker state and world-query registration. It does
not own the player, camera, networking or state-file implementation.

Modify:

- `base-game.html` — add `terrain` world mode, visual/debug controls and runtime update/disposal
- Base Game state registration — register every new local/shared setting through the existing system
- performance capture — add source key/version, resident/target tiles, queue/in-flight counts,
  terrain draws/triangles, generation/installation time, LOD and collision-provider status
- `docs/subsystems/base-game.md`

Coordinate rules:

- Streaming focus is the player's global position.
- Chunk keys and source sampling remain global.
- Ordinary chunk geometry may remain global under one terrain root translated by
  `-renderOrigin`, matching the Traversal Lab rebase pattern.
- Rebasing moves presentation only; it does not request different tiles or rebuild collision.

Initial controls:

- world mode: Empty / Traversal Lab / Terrain
- terrain visual toggle
- draw radius
- wireframe, normals, tile bounds and terrain-collision debug toggles
- source readout (analytic v1 initially; not a fake generic source selector)

Required checks in `test-base-game-terrain.mjs`:

- Terrain can replace Empty/Traversal Lab and be removed without rebuilding the player controller.
- The capsule walks, jumps, slopes, respawns and crosses chunk boundaries using the terrain provider.
- Visual off leaves authoritative collision active.
- A render-origin shift changes only render-local mesh coordinates.
- State save/load restores all terrain settings and performance records identify the source.

### Phase 5 — authoritative multiplayer terrain ownership

This phase begins only after the current multiplayer gate passes.

The server currently owns one lazily built Traversal Lab world for every room. Terrain selection
requires room-specific world ownership; a client-only `worldMode` toggle is not acceptable.

Modify:

- `base-game-protocol.mjs` — add sanitized shared world/source descriptor fields and bump protocol
  when client/server terrain selection lands
- `server/base-game-rooms.js` — move `simulationWorld`, readiness and world version from service-global
  state to each room, or to an immutable descriptor-keyed cache referenced by each room
- room world factory — accept the sanitized descriptor and construct the same pure terrain source plus
  heightfield provider used by Solo
- `base-game-session.mjs`/snapshots — expose room-specific readiness and source version/hash
- replication, room and relay tests

Rules:

- The room owner selects the descriptor at create time.
- Hot source replacement is initially disallowed. A later explicit rebuild must respawn/resync all
  players; it cannot mutate ground beneath live lockstep simulation silently.
- Server and clients compare source/algorithm versions before movement begins.
- A client missing the room source fails the handshake rather than predicting against substitute
  ground.
- Visual draw radius and LOD remain per-client.
- The project/finite-map key is validated as an asset key, never accepted as an arbitrary path or URL.

Required multiplayer checks:

- Two rooms can use different sources without sharing collision or readiness.
- Server and predicted client agree while crossing a terrain tile seam and walking a slope.
- A reconnect restores the same source descriptor before replaying movement.
- Source-version mismatch is rejected deterministically.
- Sixteen players do not multiply terrain generation work; immutable source/tile results are shared
  by descriptor where safe.

### Phase 6 — finite map source

Extract, do not duplicate, the pure portion of `terrain-loader.js`:

- Create `terrain-map-data.js` for map-data validation, typed arrays, bounds, bilinear/nearest
  sampling, biome/density/surface fields and finite chunk enumeration.
- Make `terrain-loader.js` consume that module while retaining GLB loading, materials and scene
  ownership.
- Create `terrain-source-finite.js` as the common-source adapter over normalized map data.
- Add `test-terrain-map-data.mjs` and `test-terrain-source-finite.mjs` using existing map JSON fixtures.

Initial finite authority uses exported height arrays for outdoor terrain. The GLB is the client
render artifact. Buildings, bridges, cave interiors and volumetric geometry register separately
through the existing mesh-BVH path.

Required checks:

- Loader and source return identical height/biome/surface values inside bounds.
- Outside bounds is absent, not an implicit sea-level floor.
- Existing Environment Viewer finite-map tests remain unchanged and green.
- Finite chunks at partial edge bounds do not expose collision outside the map.
- Client GLB surface and server height array agree within the export's declared tolerance.

### Phase 7 — Terrain Generator v5 infinite recipe source

Do not run `terrain-gen-worker.js`'s complete bounded pipeline for every moving tile. Split only the
parts that are mathematically streamable.

This phase activates Apply for infinite-compatible projects authored in Terrain Studio. It consumes
the shared normalized project and hash from Phase 0A; it does not add another project parser or
another set of terrain controls.

Modify pure modules:

- Add coordinate-hashed unbounded field sampling beside the current fixed 1,200 m lattice in
  `biome-classifier-js.js`; preserve legacy bounded behavior for old projects.
- Refactor `terrain-stack.js` so grid and new point evaluation share one prepared-layer evaluator.
  Add `evaluateStackPoint` rather than copying the layer switch.
- Add a project normalizer/capability classifier. A project is infinite-compatible only when every
  enabled source/modifier has unbounded semantics.
- Create `terrain-source-v5.js` to evaluate compatible recipes at global points and tile grids.
- Version project JSON. Legacy v1 projects remain finite unless explicitly migrated to the
  coordinate-hash algorithm version.

Infinite-compatible in the first pass:

- fBm, ridged, billow, Voronoi, constants, domain warp, terrace, blend modes and height-band masks
- classic climate/composer only after it uses the unbounded coordinate-hashed sampler
- deterministic slope/normal and point-classifiable biome/material fields

Finite/regional only until their own later phase:

- paint rasters and imported grids
- hydraulic/thermal operations requiring a bounded whole board when no regional boundary contract
  exists
- flow accumulation, lake discovery and hydrology
- finite density/marching-cubes exports

Required tests in `test-terrain-source-v5.mjs`:

- Point and tile evaluation agree exactly at tile samples.
- Adjacent borders/corners agree for positive and negative global coordinates.
- Generation order and worker count do not change output.
- Same project/seed/algorithm version survives save/load exactly.
- Migrated finite preview and infinite source agree over the preview bounds.
- Capability classification rejects unsupported layers instead of silently approximating them.
- Coordinates well beyond ±600 m do not clamp into repeated edge values.

### Phase 8 — terrain holes, cave entrances and structures

- Add optional hole-mask sampling to the terrain tile/source result.
- Make the heightfield provider return no hit where the authoritative near-field hole is open.
- Register cave/building/bridge geometry through the existing mesh-BVH provider.
- Keep separate provider/collider IDs so support identity, footsteps, projectiles and later navigation
  know which surface answered.
- For finite volumetric exports, load the same collision geometry or a validated collision proxy on
  the server; a client-only cave mesh is not traversable multiplayer terrain.

The integration fixture combines outdoor terrain with the existing stacked-floor, bridge and tunnel
cases plus one cut entrance. A player must walk from terrain into the cave, occupy the same X/Z at
different Y levels and return without a height snap.

### Phase 9 — flight-scale visual LOD

Do this only after ordinary source tiles, collision and multiplayer are correct.

- Extract the flight demo's ring geometry and two-cell camera snapping into a source-independent
  clipmap renderer.
- Feed it a height/field atlas built from the same source tile results rather than transcribing the
  source into TSL. This removes the flight demo and `cdlod-terrain.js` CPU/GPU height twins.
- Build or request a prefiltered tile pyramid. Height, biome, material, moisture, hydrology and hole
  fields use the same LOD level.
- Procedural source evaluation drops frequencies smaller than the requested sample spacing; sampled
  finite/regional fields use actual prefiltering.
- Keep LOD-0 collision near each relevant player/aircraft. Distant rings and any horizon shell are
  visual only.
- Preserve global source coordinates through render-origin rebasing by passing render origin
  separately to the renderer; do not fold it into source keys.

Do not generalize `cdlod-terrain.js` by copying another source-specific shader height function.
It becomes eligible only if it samples the same source atlas/pyramid.

Required checks in `test-terrain-clipmap.mjs` plus browser performance captures:

- Ring coverage has no gaps or cracks while moving and rebasing.
- Snapped centers prevent terrain swimming.
- LOD transitions preserve topology and bounded height error.
- Distant high frequencies do not alias, shimmer or create false landforms.
- Draw and triangle counts remain approximately constant during ground and 250 m/s flight travel.
- Nearby player/aircraft collision remains LOD 0 regardless of visual ring level.

## First implementation slice

The first coding pass stops after Phase 4 and contains only:

1. Shared v5 project normalization plus the embedded Terrain Studio/state/publication bridge; v5
   live Apply remains gated until Phase 7.
2. Analytic source adapter over `terrain-field.js`.
3. Source descriptor support in the existing worker/terrain streamer.
4. One heightfield world-query provider using existing collision math.
5. Base Game Solo Terrain mode with ordinary chunks, state controls, diagnostics and performance
   capture.
6. Existing Traversal Lab remains available unchanged.

It does not include live v5 recipe terrain evaluation, finite maps, caves, clipmaps, water, plants,
textures beyond the existing simple material, or multiplayer terrain authority. The editor and full
project round-trip land early so configuration is not retrofitted after runtime terrain; the narrow
analytic slice still proves the source contracts every later generator reuses.

## Stop conditions

Do not advance to the next phase if:

- player/controller code starts calling a terrain source directly;
- a source or worker imports Three.js;
- client and server construct different height math from the same descriptor;
- a source swap occurs without epoch invalidation and old-tile retention;
- a finite map creates collision outside its bounds;
- an unsupported v5 operation is labeled infinite;
- a v5 parameter exists in the editor but is omitted or defaulted by state round-trip;
- Base Game duplicates v5's layer controls instead of hosting the canonical editor;
- a multiplayer room accepts an unpublished project blob from a client;
- visual LOD changes authoritative collision;
- render-origin changes alter global tile keys;
- terrain generation or collider rebuilding appears as an unbounded frame-loop task;
- the performance record cannot identify which source, tile counts and LOD produced its result.

## Completion gate before water or plants

- Analytic, finite and compatible v5 sources use the same source/streamer/world-query boundary.
- Solo and deployed multiplayer clients agree with server terrain collision.
- Terrain, Traversal Lab and a terrain-cut cave can be selected or composed without rebuilding the
  player controller.
- Stacked surfaces remain distinct at shared X/Z.
- State files restore source identity and every terrain control.
- Performance records include terrain source/version, draws, triangles, resident/queued tiles and
  generation timing.
- Ground travel, render-origin rebasing and flight-scale travel pass their respective seam and cost
  gates.
- All pre-terrain player, body, coordinate, room, relay and terrain baseline tests remain green.
