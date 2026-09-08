# Base Game material-ownership audit (finishing F3 from 02-bindings-uniforms.md)

Scope: read-only. Three r0.184 WebGPU build at `node_modules/three/build/three.webgpu.js`.
No browser driven, no new trace captured.

## Live-module set

`base-game.html` has no lazy `import()` at all — every module it touches is a static `import`
(~90 direct). I built the full transitive closure by following `from './x.js'` statements
recursively from those 90 plus the three `entity-types/*.js` imports, staying inside this
directory (ignoring `three`/`three/addons`). Result: **183 files** are actually live. Script used:
a small Node closure-walker, output list not committed (throwaway, per instructions).

Grepping that exact 183-file set for `new *NodeMaterial(`/`new Mesh*Material(`/`new
SpriteNodeMaterial(`/`new LineBasicNodeMaterial(` found **39 construction call sites** and, more
notably, **zero** `.clone()` calls on a material anywhere in the live closure (one false-positive
match was `matrixWorld.clone()` in `weapon-mount.js:288`). That number is much smaller than the
"~30 unread files" the previous report worried about — most of those 30 files either don't touch
materials at all (they're gameplay/data modules) or share one already read (`concrete-material.js`,
`base-game-spawn-building.js`). This closes F3's open question: there is no widespread per-instance
`.clone()` pattern anywhere reachable from `base-game.html`.

## RenderObject/Pipeline/Bindings keying, read precisely

- `RenderObjects.get(object, material, scene, camera, lightsNode, renderContext, ...)`
  (three.webgpu.js:30399-30416) keys its `ChainMap` on `[object, material, renderContext,
  lightsNode]` — **object identity** is already part of the key, so two meshes sharing one
  material always get two `RenderObject`s regardless of material sharing. Sharing a material does
  not reduce `RenderObject` count; it only affects what happens *inside* each `RenderObject`.
- `Pipelines.getForRender` (31977-32010) looks up `this.programs.vertex.get(nodeBuilderState.
  vertexShader)` / fragment — keyed on the **generated shader source string**, not material
  identity. Two distinct material instances that produce the same TSL graph (same colorNode/
  roughnessNode/etc. wiring, only different uniform *values*) compile to the same shader source and
  share one `ProgrammableStage`/pipeline. So duplicate-but-identical materials do **not** duplicate
  pipeline compilation, as long as the node graph shape (not the uniform values) is identical.
- `Bindings.getForRender` (32389-32409) calls `renderObject.getBindings()` and does `this.get(
  bindGroup)` per bind group, creating (`backend.createBindings`) on first sight of that bind-group
  object. Each `RenderObject` normally owns its own bind group instance (built from its own
  material's uniform nodes), so N materials-with-identical-values still cost **N separate bind
  groups and N separate uniform buffers** (GPU memory + N bind-group creations + N sets of
  per-frame `NodeManager.updateGroup` checks from `02-bindings-uniforms.md`'s F1/F3) — the pipeline
  is shared, the bindings are not.
- Net correction to F3's hypothesis: unshared-but-identical materials are a **binding/uniform-buffer
  and bookkeeping cost, not a shader-compile cost**. Worth stating precisely since "consolidate
  materials to save pipeline compiles" would have been the wrong justification.

## Inventory and classification of the 39 sites

### (a) One shared material reused by many meshes — the common and correct pattern

`sky.js:58` (dome), `sky.js:238` (moon/sun sprite), `clouds.js:239` (cloud plane), `rain.js:127`
(streaks), `rain.js:181` (splashes), `rain.js:348`/`380` (height-probe/generic), `water-hybrid.js:
349` (ocean surface), `terrain-clipmap.js:202` (one material per LOD ring — ring count is small and
fixed, ~5-7), `terrain-splat-streamed.js:582` (one ground material for the whole streamed splat
system), `terrain-system.js:181` (fallback/instanced terrain material, module-scoped on the class),
`base-game-water.js:158` (fog plane), `base-game-terrain.js:589` (debug normal-material, one
instance), `flora-occlusion.js:28` (one depth material for the whole occluder pass),
`weapon-laser.js:108` (one beam material per laser instance — laser count = weapon mount count, not
per-shot), `base-game-vehicle-lights.js:87` (lens-disc materials cached in a `discMaterials[name]`
object keyed by switch name — correctly memoized, confirmed by reading `discMaterial()` at line 88:
it returns the cached entry if present), `roads.js:96/103/109/112` (4 materials for the whole road
network: core/feather/previewValid/previewInvalid — shared across every road segment mesh),
`base-game-spawn-building.js:80-82` + `base-game-structures-page.js:28-30` (deliberately shared:
structures-page takes `materials: spawnBuilding.bucketMaterials` from `base-game.html:1498` and
falls back to its own `new` only when unshared — comment at `base-game-structures-page.js:19-22`
explains this is so the scattered structures reuse the spawn building's already-warmed pipeline;
read both call sites, confirmed this is not duplicated in practice on this page),
`concrete-material.js:146` (factory called once per distinct concrete "block" config, not per mesh
— `createConcreteMaterial` is invoked from `base-game-spawn-building.js`/`base-game-structures-page
.js` a handful of times for named surface types).

`effect-renderer.js:217/289` and `blast-debris.js:48/53/56/59/85` are GPU-instanced sprite/mesh
pools: one `SpriteNodeMaterial`/`MeshBasicNodeMaterial`/`MeshStandardNodeMaterial` per pool
(glow/smoke/blood-decal/shrapnel/rubble/sparks), with per-particle state carried entirely as
instanced buffer attributes (`instPos`/`instColor`/`instSize`/`instAlpha`/`instTan`/`instBit`) read
back through `positionNode`/`colorNode`/`opacityNode`. This is exactly the "instance attribute
instead of N materials" design F3 speculated about, already built and in active use — `effect-
renderer.js:211-224`'s own comment records that blood decals used to be N separate `Mesh`es with N
`MeshBasicMaterial`s and were rewritten into one instanced draw for this reason. Nothing to propose
here; it's the reference pattern the other (c) finding below should move toward.

`traversal-lab-collider.js` (feeding `base-game-traversal-lab.js:17`'s `new
MeshStandardNodeMaterial` loop) merges geometry into buckets **by** `materialName` before handing
back `meshes`, so the loop's mesh count already equals the distinct-material count by construction
(`traversal-lab-collider.js:26-47`) — verified this is not per-source-mesh, it's per-bucket. Not a
duplication site; flagged in case a future reader greps the same loop and assumes otherwise.

### (b) Per-instance material where per-instance state genuinely differs — sized as (b) not (c)

- `base-game-remote-players.js:89` — `acquireMesh(id)` pops from a pool; on a pool miss it builds
  one `MeshStandardNodeMaterial` and thereafter only recolors it (`mesh.material.color.copy(...)`,
  line 97) per acquire. State that varies: `color` (per remote player id), pose (via the mesh
  transform, not the material). This is legitimate — it needs a real, richer material (capsule mesh,
  shadows) per player, and remote-player count is small and bounded by the lobby size. It *could*
  become one `InstancedMesh` with an `instanceColor` attribute (the same move `blast-debris.js`
  already made for its pools), which would collapse N `RenderObject`s to 1 and N bind groups to 1 —
  worth doing if remote-player counts grow past a handful, not urgent at typical lobby sizes.
  Priority: bounded experiment, not safe-direct (touches shadow casting per-instance, which
  `InstancedMesh` handles fine but changes the code shape).
- `base-game-player-view.js:38` and `base-game-traversal-lab.js:17` build one material per debug/
  diagnostic mesh, each a singleton (no loop over many instances) — correctly (a)-shaped, listed
  here only because at first glance the traversal-lab one looks like a loop; see above.

### (c) Avoidable duplication

**`base-game-drone-view.js:14-16` → `flight-meshes.js` craft builders — confirmed, file:line
evidence below.**

- Path: `base-game-drone-view.js:50-60` `buildMesh(kind, tint)` is called once per spawned drone/
  vehicle entity (`base-game-drone-view.js:78` for world-owned drones/vehicles, `:178` for the
  player's held craft), each call invoking `buildCraftMesh(def.mesh, tint, CRAFT_MATERIALS, ...)`
  (`flight-meshes.js:947-951`), which dispatches to a per-kind builder that calls
  `m.standard(...)`/`m.basic(...)` — i.e. `CRAFT_MATERIALS.standard`/`.basic`
  (`base-game-drone-view.js:15-16`) — 3 to 6 times per craft:
  - `buildDrone` (`flight-meshes.js:45-68`): 3 materials (`body` from tint, `dark` at `0x1d2228`,
    `cam` at `0x0d1116`/emissive `0x102030`), plus a `basic` disc material at line 60.
  - `buildUgv` (`flight-meshes.js:304-311`): 6 materials — `body` (tint), `dark`, `rim`, `deckMat`,
    `lens`, `panel` (tint again, second copy).
  - `buildBuggy` (`flight-meshes.js:560-567`): 6 materials — same shape as `buildUgv`.
  - `buildPlane` (`flight-meshes.js:14-38`): 4 materials plus a `basic` flame material.
  - Every one of these except the `tint`-colored slot is a **hard-coded literal color** (`0x1d2228`,
    `0x23252a`, `0x39322a`, …) — identical across every craft of that kind, every time.
- Classification: **measured redundancy** (the literal colors are read directly from the source,
  not inferred) for the non-tint materials; **code-supported weakness** (not measured against a
  running scene) for how often two same-kind crafts are actually alive at once — I did not run the
  game to count live drones/vehicles per match.
- Cost, precisely: this is not a pipeline-compile cost (same graph shape → same shader source,
  shared `ProgrammableStage` per the keying analysis above). It is N separate bind groups/uniform
  buffers per identical-valued material (one GPU buffer per `dark`/`rim`/`lens`/etc. slot per craft
  instance) plus N `RenderObject`s' worth of the per-object `ChainMap` bookkeeping documented in
  `02-bindings-uniforms.md` F1 — proportional to (crafts alive) × (materials per craft kind), not to
  distinct visual outcomes.
- Proposed change: hoist the kind-invariant materials (everything but the `tint`-colored slot) to
  module-level singletons in `flight-meshes.js`, shared across every craft of a kind — e.g. one
  `darkMat`/`rimMat`/`lensMat` per kind, created once, referenced by every `buildX()` call; only the
  tint-colored slot(s) stay per-instance (and could additionally be deduped by tint value with a
  small `Map<tint, material>` cache in `base-game-drone-view.js`, since tint is usually one of a
  handful of team/owner colors, not arbitrary). This fits the file's own existing pattern
  (`CRAFT_MATERIALS` is already a shared factory table) — it's a narrowing of scope, not a new
  concept.
- Benefit: fewer bind groups/uniform buffers and fewer `RenderObject`s per craft kind when more than
  one craft of that kind is alive (drones + vehicles can both be spawned per player, and multiple
  players' drones coexist in multiplayer) — GPU memory and the F1-documented per-object CPU
  bookkeeping both scale down. Correctness is unaffected since the values are literally identical.
- Tradeoffs: shared materials must never be mutated per-instance afterward (no code currently does
  `body.color.set(...)` post-construction outside the constructor call, so this is safe as read,
  but it does remove the option of later giving one craft a unique dark/rim tint without
  re-introducing a fork). Also couples `flight-meshes.js` module state across the flight-sim demo
  and this page (it's already shared code per `flight-meshes.js:3`'s own comment about materials
  being shared with the bot viewer/sim), so the singleton cache must live in a scope both callers
  can share without leaking demo-only state into base-game.html, or vice versa — the tint-keyed
  cache should probably live in `flight-meshes.js` itself rather than `base-game-drone-view.js` so
  `demos/flight-sim.html` gets the same benefit and doesn't fork the pattern.
- Overlap: same class of finding as `02-bindings-uniforms.md` F1 (per-object `ChainMap` cost scales
  with object/material count) and F3 (this *is* the concrete case F3 asked someone to go find).
- Priority: **bounded experiment** — the fix is mechanical and low-risk, but I have not counted how
  many drones/vehicles are typically alive at once in a real match, so I can't size the actual
  win. Worth doing opportunistically; not worth blocking on a trace capture first since the change
  is safe regardless of the count.

No other `.js` file in the 183-file live closure showed a loop constructing structurally-identical
materials per mesh; the remaining 30-ish material-touching files not explicitly named above (things
like `base-game-vehicles.js`, `bot-*` files reachable only via `flight-meshes.js`'s shared builders,
`terrain-source-*.js`) were checked by the same 39-site grep and contained zero `new *Material(`
calls — they consume materials built elsewhere or don't touch rendering materials at all.

## What I could not verify

- Live drone/vehicle counts per match (needed to size the `base-game-drone-view.js` (c) finding's
  actual GPU-memory/bind-group win) — no browser was driven.
- Whether the WebGPU backend's `createBindings` cost per bind group is cheap or expensive in wall
  time; I read only the caching/keying logic (`Bindings.getForRender`), not the backend
  implementation that actually allocates a `GPUBindGroup`.
- Whether `NodeBuilder`'s shader-source string comparison for `Pipelines.getForRender` is exact
  string equality or some canonicalized/hashed form — I read the call site
  (`this.programs.vertex.get(nodeBuilderState.vertexShader)`) but not `NodeBuilder`'s
  `vertexShader` getter/generation path, so "same graph shape → same string" is inferred from the
  Map-key usage, not from reading the string-generation code itself.
- Runtime confirmation that no code path mutates the module-level shared materials listed under (a)
  after construction (e.g. via `userData`-driven tuning UI) — I grepped for `.colorNode =`/`.color.
  set(` assignments at the sites read above but did not exhaustively trace every caller of every
  shared material handle across the 183-file closure.
