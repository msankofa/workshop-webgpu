# Render submission: fewer, bigger objects, GPU-decided visibility

Date: 2026-09-06. Status: proposed, reviewed by Astra 2026-09-06 (two rounds), not started.
Owner: fps-churn session (workshop-webgpu-73); `forest-gpu.js` shared with the Hi-Z session
(workshop-webgpu-1c).

## Evidence

Base Game captures 2026-09-06 (`research/stats/base-game-performance-log.json`). Standing, no
streaming, 21:28 to 21:29:

| | p50 | p95 | max |
|---|---|---|---|
| Frame | 25 to 27 ms | 47 to 52 ms | 64 to 81 ms |
| Render encode (`passPostMs`) | 21 ms | 34 to 39 ms | 52 to 65 ms |
| GPU render | 1.2 ms | 2.5 ms | 2.8 ms |
| Terrain pass | 0.1 ms | 0.2 ms | 0.5 ms |
| Draw calls | about 325 (was 397 before body instancing and the rung gate) |

The frame is the CPU side of `renderer.render`. **Hypothesis, to be confirmed in step 1:** Three's
WebGPU renderer walks the scene graph, projects and sorts render lists and binds per object at
roughly 55 µs per drawn object with the GPU idle. The `passPostMs` timer covers main, mirror,
shadow and post passes plus any uploads, and the scene census is not a per-pass draw count, so the
per-object figure is an average over all of that. Where the ~325 objects are (census): forest 130
to 140 (16 variants x 7 main + 2 shadow; the rung gate hides few in a dense forest), body 54
buckets (after gear merge), terrain 1 batch per level, sky / weapons / structures / props the rest.

## Design

The AAA shape is GPU-driven rendering: the CPU submits a handful of indirect draws per material
and a compute pass decides what is drawn. Three r184 has the pieces (indirect draw attributes,
storage buffers, `instanceIndex`, compute, render bundles) but no cross-object multi-draw, so the
move within Three is: record stable submissions once where the renderer allows it, and collapse
each big system into a few meshes that pull per-instance data from storage buffers, with
visibility decided by the compute culls that already exist.

**0. Instrumentation.** Before any change, replace the hypothesis with measurements: the existing
`postPlain` / `postMirror`, `postShadow` / `postNoShadow`, `postChain` / `postDirect` splits and
pipeline counters; a CPU trace of one warm frame attributing `renderer.render` to projection, list
sorting, binding and command encoding; GPU timing scopes. Repeated warm captures at the same
camera, settings and seed, compared at p50 / p95 / p99, moving frames and upload costs separated.
Every later step is judged on total frame CPU, not on `passPostMs` alone.

**D. Matrix-walk spike.** `scene.matrixWorldAutoUpdate = false` with explicit `updateMatrixWorld`
on every subtree that moves or is rebased: bodies, weapons, vehicles, lights, helpers, and the
terrain, flora and structure roots on an origin rebase. Three still projects objects and rebuilds
and sorts render lists, so this removes only the matrix pass. Verify origin rebases and the water
reflection. Measured as total frame CPU.

**R. Render bundles spike.** Three r184 ships `BundleGroup` (confirmed in the local
`three.webgpu.js`). It does **not** skip traversal: `_projectObject` still recurses into the
group's children every frame. What it caches is the command recording for that render list, and it
replays the recorded commands when nothing invalidated. The forest's 144 meshes and the static
structures are stable submissions, so a bounded experiment: wrap them, then verify indirect counts
and per-mesh `userData` uniforms still update inside a replayed bundle, shadow and mirror passes
still see them, and invalidation happens on visibility, progressive palette, material or buffer
changes but **not** on plain buffer-content or indirect-count writes. Measure cold (first record,
invalidation) frames separately from warm replay, and measure how often the forest invalidates
after the palette finishes. If replay removes most of the encode, A and C shrink to "keep the
bundles valid".

**A. Forest: compact live-count pulling (fallback after R).** Today each (variant, rung, role) is a
mesh with its own indirect count. Instead one arena buffer per role holding every variant's
geometry with a per-variant `{vertexStart, indexStart, indexCount}` table. After the cull kernel
(unchanged; the Hi-Z session owns it), a small compute pass prefix-sums
`liveCount[v, rung] x indexCount[v, role]` for each role mesh, writes a non-indexed indirect
`vertexCount`, and the vertex node maps `vertexIndex` through the prefix ranges to (variant,
instance, local index) before pulling arena attributes and the instance record. Dead slots are never
drawn, so the cost is bounded by live counts, not by `capPerVariant` (512). Specified up front:
zero-live variants, storage limits and overflow behaviour, arena lifetime across palette rebuilds
and waves, compute-before-draw ordering, and a benchmark of index-cache loss and storage
bandwidth against the current indexed draws. Fixed-capacity pulling (draw every slot, collapse dead
ones to degenerate triangles) is at most a bounded experiment, not the design.

Parity is defined before mesh totals are promised: normals, UVs, vertex colours, leaf sway,
texture sets and the side / alpha policy per role are preserved by construction; the two
shadow-only roles keep their own light-view survivors (main-camera survivors cannot stand in for
them); billboards have one baked material per variant, so they need an atlas or stay separate
draws. Role merging is not a free fallback: roles differ in material, side, alpha and shadow flags.
The target is one mesh per role per pass, with the count quoted per pass once parity is defined.

**B. Body arena.** One draw per compatible material group across all bodies of a design, not one
per body: the pool's `roleMaterials` carry many PBR values plus Basic double-sided eyes, so a
per-part material representation (a material id per vertex indexing a small parameter buffer) has
to be proven first, and any role that cannot be represented stays a separate draw. Part matrices
live in a storage buffer indexed by a `partId` vertex attribute; uploads are batched across bodies
and measured in bytes and calls. Preserve normal transforms under non-uniform scale, per-body
colour, heat tags, visibility, raycast identity, ownership and eviction. Lands as `body-arena.js`
beside `body-part-batches.js` with the pool's contract (`beginFrame / add / endFrame`, lifecycle,
`raycast`), chosen by option; Bot Viewer v3 uses the same pool.

**C. Static arenas.** Structures, props and spawn building parts into arenas partitioned by cell,
one mesh per material group. An indirect count selects a prefix, so visibility needs compaction of
visible ranges or records per camera (main, mirror, shadow), with transparency kept separate. A
world-sized single arena erases the culling win, so the cell size is chosen from the census.

## Order

1. **0 + D**: instrumentation, then the matrix-walk spike.
2. **R**: render bundles on forest and statics, cold vs warm measured.
3. **A** compact pulling behind `forestDrawMode: 'pulled' | 'variants'`, only if R leaves it
   necessary.
4. **B** body arena behind the existing `instancedLocal` style option.
5. **C** partitioned static arenas, only if the census still warrants it.

## Steps (0, D and R; A onward get their own step lists when reached)

- [ ] 1. Capture the pass splits above in `base-game.html`'s performance record if any are
  missing; add a one-frame CPU trace hook (`?trace=1`) that logs the renderer's phase timings via
  `performance.mark`. Three warm standing captures at the usual spot. Write the numbers into this
  file's Evidence section replacing the hypothesis.
- [ ] 2. Matrix-walk spike behind `?matrixauto=0`: the explicit update list, rebase and
  reflection checks; three captures each arm.
- [ ] 3. `BundleGroup` around the forest root and the structures root behind `?bundles=1`;
  verification list from R; cold and warm captures; invalidation count in the record.
- [ ] 4. Decide A / B / C from the numbers. Docs (`vegetation.md`, `base-game.md`, `infra.md`),
  `agent_log.csv`.

## Validation

- Headless: `node tsl-build-check.mjs` for any new material; the forest and body test suites for
  any option added.
- Browser (the user): standing capture at the usual spot; total frame CPU p50 / p95 and draw
  calls before vs after in the same scene; trees look the same in all rungs, shadows still cast,
  the reflection still shows them.

## What this does not fix

Anything per-object in Three's renderer outside the big systems (sky, weapon, HUD) stays at its
per-object cost; the census caps how far this can go. The floor is the renderer's fixed cost per
`render()` call, about 3 calls per frame today (mirror, shadow, main).

## Review rationale (Astra, 2026-09-06, two rounds)

Kept as the reasons behind the design above.

- Fixed-capacity pulling runs the vertex shader for every dead slot up to `capPerVariant`.
  Hence the prefix-sum compact form.
- Draw totals were promised before parity was defined; shadow survivors, billboard materials and
  role differences were glossed. Hence the parity paragraph.
- Per-body arenas ignore the material variety in `roleMaterials`; grouping is by material across
  bodies. The pool contract was misquoted (`place / flush`); it is `beginFrame / add / endFrame`.
- Static arenas need partitions because an indirect count is a prefix.
- The matrix-walk spike must list every rebased subtree and be measured as total frame CPU.
- 55 µs per object and "GPU idle" come from one timer over several passes. Hence step 0.
- `BundleGroup` caches command recording, not traversal. Hence R's wording and the cold vs warm
  split.

Reference: `https://raw.githubusercontent.com/mrdoob/three.js/r184/src/renderers/common/Renderer.js`
(matrix update ~1489, projection ~1550, bundles ~2961).
