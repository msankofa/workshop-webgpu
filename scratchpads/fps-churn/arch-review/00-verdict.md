# Renderer architecture review — verdict, revision 2 (Fable, 2026-09-07 late evening)

Eight read-only Sonnet reports in this folder: 01-06 (one per checklist area) and 07-08 (the two
gaps Astra asked closed: material ownership, BatchedMesh upload path). Labels throughout:
[ran] = I read the code or ran the check myself this session; [reported] = investigator claim I
did not independently re-check; [measured] = a number from a capture, trace or Node run; [hyp] =
no evidence either way.

Revision 2 changes from revision 1: the "microseconds per object" argument is withdrawn (section
2); the BatchedMesh ranged-write question is settled against me (section 3.5); the material audit
is complete (3.2); the allocation cleanups are reclassified after checking retention (3.4); the
dynamic-offset and extension rejections are reworded as evidence gaps, not verdicts (3.6); every
area has a disposition; the sub-phase instrumentation has its semantics specified (section 5).

## 1. Corrections to the investigator reports (checks I ran)

1. Report 01: the "88.8 vs 38.8 ms matrix walk" figure is the `?chunkcull` A/B comment
   (base-game.html:1473-1478, measured 2026-08-26), not the matrix walk. Matrix walk stays at
   0.1-0.4 ms cost, no gain. [ran]
2. Reports 03/05: "terrain submits every resident chunk". Base Game sets `batchFrustumCulled:
   true` (base-game-terrain.js:74, passed at :337/:685, `?chunkcull` default on at
   base-game.html:1479). Per-chunk culling is on; the proposed experiment was done 2026-08-26. [ran]
3. Report 05 F2: "+65% chunks drawn permanently while stationary" overstated. `getMissingKeysSorted`
   iterates `targetKeys` only, so margin chunks are never built for their own sake; only trailing
   in-view leftovers after movement draw. What stands: hide rules (base-game-terrain.js:678-679)
   never test radius, so those leftovers overlap the cascade (overdraw, not a hole; the :93 comment
   says finer draws over coarser). Size unmeasured; hiding them pops the LOD when turning. [ran]
4. Report 03 §1 "3 traversals per frame": planar mirror only. Default reflection `sky`
   (base-game.html:254); newest captures ran `ssr` with reflectPasses 0. Measured sessions: main +
   shadow (shadow lists 240 objects, draws 32). [ran + measured]
5. My own revision-1 error: I searched `three.webgpu.js` for `BatchedMesh.optimize` and found no
   ranged writes. The class lives in `three.core.js`, which the WebGPU build imports (line 6).
   Report 08 measured it in Node; see 3.5. [ran the import check; measurement reported]

## 2. What the sampling already says, and what it does not

From `research/stats/trace-review-20260907.md` (Astra's reconstruction of the DevTools profile,
129,889 samples over ~66 s; inclusive figures overlap and must not be added) [measured]:

| Stack | Sample-weighted time |
|---|---|
| render path, inclusive | 46.2 s |
| `_updateBindings`, inclusive | 17.37 s |
| node `updateNode`, inclusive | 7.13 s |
| uniform-group `update`, inclusive | 6.21 s |
| `writeBuffer`, leaf | 3.97 s (3.29 s via bindings, 0.68 s via attributes) |

So roughly 38% of render-path samples sit under the bindings update (node and uniform-group work
nest inside it), and about 83% of buffer-write leaf time is binding buffers, not geometry. The
remaining ~62% of render-path samples are distributed among matrix operations, node/attribute
access, draw calls and buffer writes with no sub-phase attribution. Revision 1 argued from
operation counts that the per-object work "should" be microseconds; that is withdrawn. Counting
compares does not give elapsed cost. The correct statement: the bindings path is the largest
named slice, it is not the majority, and the remainder is unnamed at sub-phase level. Finer
timings refine attribution; they are not needed to justify work on the bindings path.

## 3. Disposition per checklist area

### 3.1 Data ownership and update frequency (report 01)
- Examined [ran]: `NodeFrame` dedup (three.webgpu.js:53044-53084): FRAME/RENDER scoped nodes update
  once per frame/pass via WeakMap; OBJECT scoped nodes have no dedup and run per RenderObject.
  `materialEnvIntensity`/`materialRefractionRatio` are `onObjectUpdate` (15157-15168) although
  material-scoped. Our TSL declares no OBJECT-scope nodes (grep, [reported]). Shadow gating and
  the absence of `material.needsUpdate` in animate() [reported, plausible from my own reads].
- Supported weakness: material-scoped values recomputed per object is Three's design; the cost
  is inside the 7.13 s `updateNode` slice but not separable from it.
- Replacement: none from userland; the update type is fixed by the node class. A vendor-side
  change (RENDER scope for material-reference uniforms) is possible in principle; see 3.6.
- Disposition: existing design appropriate at our scale until the sub-phase split says otherwise.

### 3.2 Bindings, uniforms, material ownership (reports 02, 07)
- Examined [ran]: `Pipelines.updateForRender` runs outside the `needsRefresh` gate (61315) and
  reaches `backend.needsRenderUpdate` (81690): four render-context lookups plus ~30 field
  compares per object per frame, cached fields rewritten only on change. `Pipelines.getForRender`
  keys programs on the generated shader source string (31977+). `RenderObjects.get` keys on
  [object, material, renderContext, lightsNode] [reported, consistent with my read of the
  cache-key sites].
- Material audit complete [reported, spot-checked]: 183 live files, 39 material construction
  sites, zero material `.clone()` calls. Sharing a material never reduces RenderObject count;
  identical-but-distinct materials share the pipeline but each own a bind group and uniform
  buffer, plus their share of per-object bookkeeping. One avoidable duplication found:
  `flight-meshes.js` craft builders create 3-6 materials per spawned craft through the
  `CRAFT_MATERIALS` factory (base-game-drone-view.js:13-16), most with hard-coded literal colours
  identical across every craft of a kind [ran: read the factory and `buildDrone`]. Live craft
  count per match unknown, so the win is unsized. `effect-renderer.js` and `blast-debris.js`
  already use instanced attributes instead of per-instance materials, the reference pattern.
  `base-game-remote-players.js` has one material per remote player (colour differs; bounded by
  lobby size) [reported].
- Supported weakness: per-craft material duplication. Small, real, correctness-neutral.
- Replacement: hoist kind-invariant craft materials to module singletons in flight-meshes.js
  (shared with the flight demo, so the cache lives there), keep the tint slot per instance or
  cache by tint. Tradeoff: no later per-craft dark/rim tint without reintroducing a fork.
- Disposition: supported direct improvement, maintainability and GPU memory; FPS effect unsized.
- Dynamic offsets: zero hits for `dynamicOffset` in the build [ran]. This says the facility is
  absent, not that adding it would be inferior; see 3.6.

### 3.3 Draw submission and scene organization (report 03)
- Examined [reported + my reads of the call sites]: `_projectObject` walks the whole graph per
  `render()` call; BundleGroup caches command recording, not traversal; the WebGPU backend has
  real `drawIndexedIndirect` (81485-81521) and forest and grass already use it per mesh; no
  multi-draw for BatchedMesh on WebGPU (one `drawIndexed` per visible instance, report 08
  confirms at 81451-81479). Forest is 130-140 meshes because of variants x roles, each already
  indirect; the plan's arena + prefix-sum is the only way in this build to merge roles.
- Supported weakness: object count in the forest is the largest single contributor to the
  per-object path (about 130 of ~202 main-scene objects, from the plan census [measured earlier]).
- Replacement: the forest arena (plan step A). Costs the plan does not budget, to be measured not
  assumed: per-vertex range remap ALU; culling granularity change (per-role instead of
  per-variant-role); material merging across variants; visual parity check (same seeded window,
  pulled vs variants, pixel diff plus screenshot).
- Disposition: larger architectural change needing a design decision. It is a candidate, not an
  automatic consequence of a binding-heavy profile: the binding slice is per RenderObject, so
  fewer RenderObjects reduces it, but the remap and merged-material costs land elsewhere.
- Terrain and bodies: BatchedMesh and InstancedMesh at tens of instances; not indirect; no change
  proposed. Render-list sort: default painter sort, unmeasured, not worth an experiment.

### 3.4 Hot-path allocation, caches, lifecycle (report 04)
- Examined [ran]: grass `now` record (grass-compute.js:943) is read only by `tierDue`
  (grass-cells.js:152), a pure comparison; it does not escape. `tierLast[t]` records (:974) are
  stored and compared next frame, so a scratch replacement needs per-tier storage (parallel
  arrays). The prediction-step spread (base-game.html:6705) is copied field by field into a
  history `entry` that `advance()` allocates anyway, together with a `stepOnce` literal
  (base-game-prediction.js:59-95); the spread is one of three allocations per fixed step and
  `drone` is retained by reference either way.
- Caches [reported]: forest `chunkRecords`, effect `firstSeen` (TTL sweep), batch `byKey`, grass
  residency all have eviction paths; the terrain-swap -> forest `clearChunk` link was not traced
  end to end.
- Disposition: existing design appropriate. The two cleanups are safe as read but save a handful
  of small young-generation objects per frame on paths the trace did not implicate; not worth a
  change on their own. Reclassified from "direct improvement" to "no change needed".
- Remaining gap: no long-session (30 min) `renderer.info.memory` or heap trend was recorded;
  the capture's `heapMB` column exists but was not analysed for drift.

### 3.5 Terrain geometry integration and upload (reports 05, 08)
- Examined [reported, measured in Node by report 08]: `optimize()` calls `addUpdateRange` per
  shifted geometry (three.core.js:26622, 26643); deleting the first of four geometries and
  compacting produced 3 ranges, deleting the last produced 0. `WebGPUAttributeUtils.updateAttribute`
  (three.webgpu.js:77684-77765): 0 ranges = one whole-buffer `writeBuffer`; >0 = one `writeBuffer`
  per range, no coalescing, ranges cleared after upload. `setMatrixAt`/`setColorAt` mark the
  whole data texture; no ranged texture update. `onBeforeRender` early-outs only when visibility
  is unchanged and per-object culling and sorting are off; Base Game runs with per-chunk culling
  on, so it pays a matrix + bounding-sphere + frustum test per resident chunk per pass (the
  2026-08-26 A/B chose this for the tail).
- Supported finding: the terrain-chunk-batches.js:18 and :32-33 comments describe the worst case
  (earliest gap shifts everything after it) as the typical case. Comment correction only. The
  throttle stays; a mostly-full streaming batch with deletes anywhere hits the worst case often.
- Margin-chunk overdraw (correction 3): needs the batcher's `drawCount` in the capture context
  before deciding; the LOD pop is a visible cost. Bounded measurement, not a change.
- Constraints preserved: collision-critical progress, stale-result handling, bounded queues,
  target-key coverage are all tested (test-terrain-*.mjs); nothing here touches them.
- Disposition: comment fix (direct, maintainability); overdraw count (bounded measurement).

### 3.6 Three abstraction costs and extension strategy (report 06)
- Examined [ran]: the per-object chain `_renderObjectDirect` -> `needsRefresh` -> nodes /
  geometries / bindings updates -> `Pipelines.updateForRender` (unconditional) -> `backend.draw`.
  `RenderObject.needsUpdate` -> `getDynamicCacheKey` -> `Nodes.getCacheKey` is memoised per pass
  on `info.calls` [reported, I read the memo key]. The `object.static` fast path is commented out
  at 30243 [reported]. `setRenderObjectFunction` exists (60427) and is unused by us [reported].
- Strategies, reworded: (a) usage improvements have the only evidence so far (3.2, 3.3). (b) a
  narrow extension via `setRenderObjectFunction` would let us skip refresh checks for objects we
  declare static; its cost is reimplementing ~100 lines of dispatch that must be re-verified per
  Three release. (c) a maintained patch of the vendored build (for example RENDER-scoping the
  material-reference uniforms, or a dynamic-offset uniform arena) means leaving the CDN and
  rebasing a 84k-line file per release; the repo has no tooling for that today. (d) a custom
  submission path for terrain or forest through `renderer.backend.device` duplicates bind-group,
  pipeline-cache and node-update machinery Three does for us. None of (b)-(d) is shown inferior;
  none is justified by current evidence, because the sub-phase split that would show which stage
  they remove has not been run. No renderer rewrite is proposed or requested.
- Disposition: larger changes deferred pending section 5; (a) proceeds.

## 4. Revised implementation checklist

Supported direct improvements (no FPS claim; correctness or maintainability):
1. Hoist kind-invariant craft materials in flight-meshes.js to module singletons; tint slot per
   instance or tint-keyed cache. Check: no caller mutates a craft material after construction
   (report 07 grepped assignments at the sites read, not every handle; do the full grep first).
2. Correct the two compaction comments in terrain-chunk-batches.js (worst case, not typical).

Bounded experiments and measurements:
3. Sub-phase instrumentation in render-trace.js behind `?trace=1` (semantics in section 5),
   validated in Node before any capture. The user's moving route is the capture; no standing
   plants-on/off gate.
4. Add the near batcher's `drawCount` and the resident/target chunk counts to the capture
   context to size margin overdraw before proposing a hide rule.
5. Count live crafts per match from a capture (sizes item 1's win; does not gate it).

Larger architectural changes needing a design decision:
6. Forest arena (plan step A), with the remap ALU, culling granularity, merged materials and
   visual parity costed in the plan before a go decision. Candidate, not consequence.
7. Static-object fast path via `setRenderObjectFunction`, or a vendored patch, only if item 3
   attributes a large share to stages those would remove. Neither is rejected on principle.

Rejected: re-running the chunk-cull toggle, bundles, matrix walk; the +65%/+96% margin figures.

## 5. Sub-phase instrumentation: semantics before code

- Timers wrap `Nodes.updateBefore`, `Geometries.updateForRender`, `Nodes.updateForRender`,
  `Bindings.updateForRender`, `Pipelines.updateForRender` and `backend.draw` on the renderer's
  instances, the same `wrapPhase` pattern render-trace.js uses (depth counter per phase so a
  re-entrant call is not timed twice; time charged to the innermost scene entry on the stack).
- Nested scene renders (a `renderer.render` inside a node's `updateBefore`, as the reflector
  does) push their own entry; the parent's open phases subtract the child's time exactly as
  `wrapScene` already does for project/sort/objects/encode. The new phases join `PHASES` so the
  existing subtraction covers them.
- Ownership: aggregate per scene entry (main, shadow, reflect, post are already told apart by
  `describe(scene, camera)`), plus per-(object, material) rows for the two heaviest phases only,
  so the `top` table does not sextuple. A refresh counter per scene (how many objects took the
  `needsRefresh` branch) and a unique-material count per scene.
- Overhead: two `performance.now()` calls per phase per object, about 1,200 per main-scene frame;
  measure the wrapper's own cost by running the trace with the timers installed but the phases
  disabled, and report it in the capture.
- Alignment: rows carry the same `atMs` convention as the series (the frame BEFORE the stamp).
- Validation in Node: a fake renderer with nested `_renderScene` calls and known sleeps, asserting
  exclusive sums equal the known durations, as `test-render-trace.mjs` does for the current phases.

## 6. Non-FPS benefits collected

- Material singletons: less GPU memory per craft, one place to change a craft's palette.
- Comment corrections: the compaction cost model stops misleading the next tuning decision.
- Instrumentation: a per-stage attribution that any later Three upgrade can be checked against.

## 7. Remaining evidence gaps

- Sub-phase attribution of the ~62% of render-path samples not under `_updateBindings`.
- Live craft counts; margin overdraw size; long-session heap trend.
- Whether `NodeBuilder` shader-string equality is exact string equality (pipeline sharing claim).
- Whether any code mutates a shared module-level material after construction (full-closure grep).
- Session-to-session idle drift; why 4 terrain threads hurt on 10+ cores; vehicle speed at 2.

## 8. Verified by me vs read from an investigator

Verified [ran]: corrections 1-5; `Pipelines.updateForRender` body and `backend.needsRenderUpdate`;
OBJECT-scope no-dedup lines; `dynamicOffset` absence; `three.core.js` import; the craft material
factory and `buildDrone`; `tierDue` purity and `advance()` retention; render-trace.js wrap
mechanics; reflection mode in the newest captures. Read from investigators: the 183-file closure
and 39-site count; the Node BatchedMesh measurement; `setRenderObjectFunction` and the commented
`static` check; the cache eviction paths; the indirect-draw line ranges.
