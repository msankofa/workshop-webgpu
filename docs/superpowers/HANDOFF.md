# HANDOFF — WebGPU migration of the procedural creature world

_Last updated 2026-06-22. Working tree clean; everything below is committed on branch
`sp1-webgpu-renderer-migration`._

## 1. Where you are
- **Repo / branch:** `workshop-webgpu/` (a fork), branch `sp1-webgpu-renderer-migration`.
- **Sibling `../workshop/`** is a mirror used for **shared research docs only**. Do not touch
  its code. When you change the paper or migration notes, copy them into
  `../workshop/research/webgpu/` too (that is the only sync).
- **App:** `environment-viewer.html` (the live WebGPU world; imports ES modules via a CDN
  importmap). Open it over **http** (`http://localhost:8001/environment-viewer.html`); modules
  will not load from `file://`. A static server on `:8001` is the norm (`python -m http.server 8001`).
- **`creature-viewer.html`** is the OLD standalone WebGL app (Three r0.160). It is NOT migrated
  and shares no code with the environment viewer. Leave it unless asked.
- **Three.js r0.184.0** via importmap: `three`/`three/webgpu`/`three/tsl` (jsDelivr) + `three/addons/`.
  The local `node_modules/three` is a reference copy; **addon files there are empty stubs** (real
  ones load from CDN at runtime), so you cannot Node-parse modules that import addons.

## 2. What is done (SP1-SP4, all complete and committed)
- **SP1** renderer migration: `WebGLRenderer` -> `WebGPURenderer`, materials ported to TSL node
  materials. CPU frame time -27..46%.
- **SP2** compute grass: `grass-compute.js` (+ `grass-cells.js`, `grass-height-ref.js`).
  Per-frame compute generate+cull -> one `drawIndexedIndirect`. `?grass=cpu` keeps the legacy path.
- **SP3** GPU CDLOD terrain: `cdlod-terrain.js` + `cdlod-select.js` (Node-tested). `terrain-system.js`
  gained `visualMode:'external'` (records + colliders only). `?terrain=gpu|chunks`. Terrain = 1 draw,
  flat triangle cost vs distance.
- **SP4** lights/particles/post:
  - **4a** `clustered-lights.js` + `light-cluster.js`: froxel clustered forward+ GGX point lights. `?lights=on|off`.
  - **4b** `particles.js` + `particle-field.js`: compute-simulated embers + dust, indirect billboards. `?particles=on|off`.
  - **4c** `post-fx.js` + `post-grade.js`: bloom + switchable tone mapping + full color grade, ~16 live
    controls in the "Post" panel. `?post=on|off`.
- **Paper:** `research/webgpu/webgpu-parallelism-over-serial-synthesis.html` (now has section 7
  Discussion + section 8 Conclusion with a click-to-launch inline iframe of the viewer; editorializing
  and em-dashes removed). **Migration notes:** `research/webgpu/sp1-migration-notes.md`. **dd9 perf
  CSVs:** `research/stats/`. **Specs/plans:** `docs/superpowers/specs/`, `docs/superpowers/plans/`.

## 3. Hard constraints (read before editing)
- **No headless WebGPU here.** It crashes in headless Chrome. So: prove all you can in **Node**
  (pure-JS math twins, run `node test-*.mjs`), then hand GPU/TSL code to a **browser checkpoint** (a
  human reloads and reports). Expect 1-3 iterations per GPU module.
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
  Small, frequent commits.
- **Style:** no em-dashes, no editorializing in the paper (the maintainer removed both; keep it that way).
- **Discipline that worked:** brainstorm -> spec (`docs/superpowers/specs`) -> plan -> implement; Node
  TDD first for any GPU math; one browser checkpoint per GPU module; a **dd9 A/B perf trace**
  (`window.perfStats` -> "rec" + CSV button, dropped in `research/stats`) as each subsystem's gate;
  fold results into notes + paper, sync `workshop/`.

## 4. TSL / WebGPU gotchas already learned (will save hours)
- Integer indices: cast `int(instanceIndex)` first; use `modInt` + **exact-multiple** integer `.div`.
  Never `.mod`/`.div` in the float domain on uints ("expected a uint").
- Hashes that must bit-match the field: `bitcast(node,'uint')` (NOT `uint(node)`, which value-converts).
- **`await renderer.computeAsync(node)` before `renderer.render`** every frame; unawaited compute races
  the draw and flickers. `animate()` is `async`.
- Atomics: `atomicStore` to reset, `atomicAdd` a counter, then `atomicLoad(counter)` ->
  `indirect.element(1)` in a finalize pass. `atomicAdd` cannot target the indirect buffer directly.
  `atomicOr` is unconfirmed in this TSL build (avoid; culls use per-cell index lists instead).
- Indirect draw: `new IndirectStorageBufferAttribute([indexCount,0,0,0,0],5)`; `geometry.indirect = attr`
  (a property, not a method); `geometry.instanceCount = CAP`.
- The GPU-written indirect `instanceCount` is **not** synced back to the CPU array; for HUD counts,
  recompute the (cheap) CPU mirror.
- Request the adapter's **own max** `maxStorageBufferBindingSize`/`maxBufferSize` via `requiredLimits`
  at renderer creation (default 128 MB is too small at large radius).
- A plain JS number cannot be a TSL receiver (`PI.mul(...)` throws); pass it as the arg or `float(PI)`.
- `renderOutput(...)` returns a **vec4**; do color grading on `.rgb`.
- The terrain `emissiveNode` is the additive injection slot; `water.js` composes (`prior.add(cEmit)`)
  rather than clobbering. Any new emissive contributor must compose too.
- Heavy stress (maxed grass + lights + particles together) can trigger a WebGPU **device loss**;
  recovery is a full browser restart, not a reload.

## 5. Next work (recommended order)
1. **SP5 - hybrid collision:** spec `docs/superpowers/specs/2026-06-21-sp5-analytic-player-collision-design.md`,
   Phase A plan `docs/superpowers/plans/2026-06-22-sp5a-analytic-terrain-collision.md`.
   Three phases sharing one `collision.js`:
   - **A: DONE (complete, browser-checkpointed).** `collision.js` (`groundContact` + `slideVelocity`,
     Node-tested in `test-collision.mjs`) replaced `worldOctree.capsuleIntersect` in `updateFPSPlayer`;
     the octree + the `terrain-system.js` collider machinery are retired (`getHeight` stays). dd9 result:
     octree-rebuild spike gone (cpuMs max 108->32 ms, p95 39->31 ms, `octreeMs` column removed). Trace
     `research/stats/perf-2026-06-22T23-33-03-053Z-collision-phase-a.csv`; folded into notes + paper.
   - **B: DONE (player; complete, browser-checkpointed).** `resolveTrunks` + `createTrunkIndex` in
     `collision.js` (Node-tested, 25 asserts). Forest baking registers `{x,z,r=1.2*scale}` per chunk
     (`finishTreeJob`/`disposeTreeChunk`); `updateFPSPlayer` does lateral trunk push-out. Trunks are
     now solid for the player. **Follow-up:** creature trunk push-out (thread `trunkIndex.resolve`
     into `port-creature-system.js:2386`); deferred to keep the creature sim untouched.
   - **C (next):** rock/obstacle BVH via `three-mesh-bvh` (addon; pin to r0.184) for walk-on + walls,
     folded into a `supportAt`/`WorldCollision` abstraction. `collision.js` is structured to grow into this.
   Cull math is Node-testable first (the `light-cluster.js` pattern). A and B (player) done; C is next.
2. **Tree/forest GPU optimization** (the other half of the residual per-chunk scaling). Likely
   instanced/GPU-driven like grass; the current forest is baked per chunk in `trees.js`.
3. **GTAO (post v2):** addon `ao(depth, normal, camera)`; needs an MRT(output, normal) scene `pass`. Deferred.
4. **Sky / weather SP:** rain/snow + a real sky (the "C" particle option set aside).
5. **Bake post-FX defaults** once a look is dialed in (currently a neutral no-op baseline).
6. **Creature clustered-lighting:** the creature materials (in `creature.js`) are plain
   `MeshStandardMaterial`; to receive the SP4a clustered point lights they must become
   `MeshStandardNodeMaterial` with `clusteredLightsRef.pointLightTerm(positionWorld, normalWorld)`
   added to `emissiveNode`.

## 6. Accuracy note for the paper
The paper claims **subsystem-scoped** flatness only (terrain = 1 draw, flat tris). Overall fps still
declines with draw distance because the **forest and collision octree** still scale per-chunk; section 1
and the SP3 callout state this. Do not let any future edit overclaim "flat fps."

## 7. Quick commands
```
# run all logic tests
node test-cdlod-morton.mjs && node test-cdlod-select.mjs && node test-cdlod-morph.mjs \
  && node test-light-cluster.mjs && node test-particle-field.mjs && node test-post-grade.mjs \
  && node test-terrain-system.mjs
# serve for browser checkpoints
python -m http.server 8001        # then open /environment-viewer.html
# URL flags: ?terrain=gpu|chunks  ?grass=gpu|cpu  ?lights=on|off  ?particles=on|off  ?post=on|off
```
