---
name: improve-webgpu
description: Audit and fix a page in this workshop for frame-loop cost, GPU resource leaks, TSL graph rebuilds, and visual defects like z-fighting, shadow acne, wrong color space, and broken resize handling. Measures with the repo's own profiler instead of a React scanner. Use when asked to improve, audit, profile, speed up, or clean up environment-viewer, bot-viewer-v3, a demos/ page, or any Three.js WebGPU/TSL module here, or when the user types /improve-webgpu.
---

# Improve a WebGPU page

Audits one page in this workshop and fixes what actually costs frames or looks wrong. There is no
React and no bundler here, so no static scanner covers this stack — the evidence comes from the
repo's own frame profiler and from looking at the render.

The core principle: severity follows the render loop. Code inside `animate()` runs 60 times a
second, so a small inefficiency there outweighs a large one in a panel builder or a scene rebuild.
Rank every finding by where it runs, not by how ugly it reads.

Scope the audit to one page. `environment-viewer.html`, `bot-viewer-v3.html`, and each
`demos/*.html` have separate loops, separate module sets, and separate perf profiles.

## Step 1: Recon

Read `docs/subsystems/entry-point.md` first, then the page's own `animate()`.

Establish before touching anything:

- Which modules are actually live. Mode flags (`GRASS_MODE`, `FOREST_MODE`, `TIMESTAMP_MODE`, and
  the rest) pick between lazy-imported variants — `grass.js` and `grass-compute.js` are never both
  loaded. Check the flag before profiling a code path.
- Where the loop is. Note every per-frame call site: `animate()`, per-entity `update(dt)` methods,
  compute dispatches, and any `pointermove` or `ResizeObserver` handler.
- Which subsystem docs cover the files you will touch (`docs/subsystems/*.md`, or `code-map.html`
  for the dependency graph). Those docs are part of the change, not cleanup afterwards.

Build a hot-path list from that. Those files get the strict review in Step 3; everything else is
hygiene.

## Step 2: Measure

Never guess at cost. Get numbers first, and record the baseline so Step 6 has something to compare
against.

- **Per-pass CPU and GPU time**: both viewers already wire `createFrameProfiler()` from
  `frame-profiler.js` (`environment-viewer.html:1543`, `bot-viewer-v3.html:18890`). Read the pass
  breakdown rather than total frame time — a 12 ms frame tells you nothing about which pass owns it.
- **The self-profiler**: `bot-viewer-v3.html` accepts `?prof=1` for the live HUD and
  `?autoprofile=1` for an unattended capture. Use these for A/B runs.
- **GPU timestamps**: `TIMESTAMP_MODE='on'` constructs the renderer with `trackTimestamp` and
  enables the `resolveTimestampsAsync()` calls. Awaiting them crosses a vsync boundary, so
  timestamp-on frame totals are not comparable with timestamp-off ones. A/B within one mode.
- **Draw calls and memory**: `renderer.info.render.drawCalls` and `renderer.info.memory` between
  frames. A rising `memory.geometries` or `memory.textures` while the scene is static is a leak,
  not noise.
- **Headless checks**: `node test-<subsystem>.mjs` for the pure modules, and
  `node tsl-build-check.mjs` to compile a NodeMaterial's graph in Node so a broken TSL tree fails
  there instead of as a black screen in the browser. Storage-buffer materials (`grass-compute.js`)
  cannot go through it — that harness needs a real backend for those.

When the user is running the page, ask them for the numbers rather than driving Chrome yourself.

## Step 3: Triage by frame-loop leverage

**HIGH — runs every frame, or leaks GPU memory:**

- **Allocation in the loop**: `new THREE.Vector3()`, `new Color()`, fresh arrays, or object
  literals built per frame per entity. Fix: hoist a scratch instance to module scope and mutate it
  in place. At 90 entities this is the difference between a GC pause and none.
- **Missing disposal on rebuild**: these pages rebuild scenes whenever a slider moves. Every
  geometry, material, texture, and render target created imperatively needs `dispose()` on the
  rebuild path, not only on teardown. Removing a mesh from the scene frees nothing.
- **TSL graph rebuilt per frame**: constructing node expressions, calling `Fn()`, or reassigning
  `material.colorNode` / `material.positionNode` inside the loop forces a shader recompile. Fix:
  build the graph once and drive it through `uniform()` nodes, mutating `.value` per frame. Same
  for `material.needsUpdate = true` in a loop.
- **Per-frame DOM writes**: HUD and panel text updated per entity per frame. Fix: batch into one
  write, or update on an interval. The eye cannot read 60 Hz text anyway.
- **Unstrided work**: full alert scans, nav rebuilds, or LOD reselection for every entity every
  frame. Fix: stagger across frames by entity index, the way the bot think-stagger already does.

**MEDIUM — per-interaction or per-rebuild waste:**

- **Missing instancing**: hundreds of identical meshes as individual objects. This repo already has
  `body-part-batches.js`, `weapon-part-batches.js`, and instanced walls — reuse that pattern rather
  than inventing a third one.
- **Scene-graph churn**: adding and removing objects per frame instead of hiding or pooling them.
  Pooled shot FX exist already; check before writing new spawn code.
- **Raycasting the whole scene** on every pointer move instead of a filtered candidate list, or
  ignoring `bot-spatial-hash.js` where a broad phase already exists.
- **Uncached asset loads**: textures or GLBs loaded per call site instead of through the shared
  loader path, losing the cache.
- **Shadows or post-processing enabled globally** when one part of the scene needs them.

**LOW — hygiene:** oversized textures, dead uniforms, debug meshes left in the loop, `console.log`
inside `animate()`.

## Step 4: Visual audit

Inspect what the page actually renders. Every visual finding needs evidence: a screenshot, a
capture, or the user's own report. Never assert a visual defect from reading source alone; if you
have not seen it, label it inferred and say so.

A row fails only when the evidence shows the failure condition.

| Area | Check | Fail when |
| --- | --- | --- |
| Render sanity | The page reaches a stable frame after load | Black canvas, WebGPU adapter or shader-compile errors in the console, or geometry that never appears |
| Geometry | Move the camera along seams, edges, and terrain chunk boundaries | Gaps, missing faces, visible backfaces, or two surfaces flickering at one depth |
| Transparency and depth | Cross depth-order boundaries with overlapping or transmissive surfaces | Wrong sort order, halos, or flicker at grazing angles |
| Textures | View mapped surfaces close, far, and at grazing angles | Missing textures, stretching, seams, moire, shimmer, or washed-out color |
| Materials and lighting | Change light and view direction on lit surfaces | Surfaces that ignore light direction, or metals with nothing to reflect |
| Shadows | Move casters, receivers, and the light through their range | Acne, detached or floating shadows, flicker at rest, or shadows outliving their caster |
| Camera | Follow the subject through movement and transitions | Subject leaves frame, camera clips into geometry, or foreground blocks the play area |
| Scale and contact | Compare object scale and resting contact against surroundings | Objects float above, sink into, or intersect their support surface |
| Image stability | Pan slowly at supported resolutions | Thin geometry or highlights that crawl, sparkle, or ghost |
| Resize and DPR | Change window size, zoom, and device pixel ratio | Distortion, blur, stretched output, or content leaving the viewport |

Usual code-level causes, checked in this order when a row fails:

- **Washed-out or too-dark color**: `renderer.outputColorSpace`, `toneMapping`, or `colorSpace` set
  on a data texture (normal, roughness, mask) that must stay linear. Only color maps are sRGB.
- **Black or flat TSL material**: a node graph that failed to compile. Check the console for the
  shader error, then run the material through `tsl-build-check.mjs`.
- **Wrong-looking normals**: `transformNormalToView` expects an object-space normal, and a custom
  `normalNode` gets no automatic double-sided flip. This has bitten this repo before.
- **Z-fighting**: coplanar geometry needing a position nudge or `polygonOffset`, or a near plane far
  too small for the scene scale.
- **Shadow acne or floating shadows**: `shadow.bias` and `shadow.normalBias` untuned, or a shadow
  camera frustum far larger than the scene.
- **Blurry or stretched canvas**: renderer size not synced to the canvas CSS size, `setPixelRatio`
  never called, or a resize path that forgets `camera.updateProjectionMatrix()`.
- **Black metals**: `metalness: 1` with no `scene.environment`. Several viewers set an IBL, others
  do not.
- **Transparency sorting glitches**: large transparent meshes needing `depthWrite: false`, an
  explicit `renderOrder`, or a split into smaller meshes.
- **Things floating above the ground**: anything draped on terrain must sample the rendered mesh,
  not the terrain field. The two disagree, and the roads work proved it.
- **Shimmer and crawl**: missing texture anisotropy, MSAA off, or thin geometry that needs thicker
  forms.

## Step 5: Fix

Fix in severity order: HIGH findings and failed rubric rows before anything else.

Repo rules that apply to the fix itself:

- Snapshot before a significant edit: copy the file into `versions/` as
  `versions/<name>-before-<description>-<YYYYMMDD-HHMMSS>.<ext>`.
- One-line comments at most. The reasoning goes in the chat and the log, never inline.
- Anything a person tunes on the page is saved to a file through `disk-store.js` and a `serve.py`
  route. Never `localStorage` as the source of truth.
- If a CPU/GPU math twin covers the code you changed (`forest-cull.js`, `light-cluster.js`,
  `post-grade.js`), hand-sync it. Nothing imports those, so nothing catches the drift.

## Step 6: Validate

- Re-run the affected `node test-*.mjs` scripts, and `node tsl-build-check.mjs` if a material graph
  changed.
- Re-measure with the same profiler and the same scene as the Step 2 baseline, and report the pass
  breakdown, not just total fps. Say which numbers moved and which did not.
- Re-check every rubric row that failed, from the same viewpoint as the original evidence.
- Watch `renderer.info.memory` while the page idles. Rising counts mean a disposal leak survived.
- Hand the page to the user for the visual verdict. Their look at it is the browser QA. Do not write
  that browser testing is still pending, and do not drive Chrome to check the render yourself.

Then finish the change properly: update every `docs/subsystems/*.md` the change touched, and append
one row to `agent_log.csv` (`date,subsystem,files,summary`).

## Checks nothing automated will catch here

Review these by hand on every audit:

- `dispose()` coverage on the rebuild path for every imperatively created GPU resource
- Allocations inside `animate()` and inside per-entity `update(dt)` methods
- Event listeners and `ResizeObserver`s added on rebuild without a matching removal
- TSL uniforms rebuilt instead of mutated
- Compute dispatches that run every frame when the data changes rarely
- Color space on the renderer and on every texture, split by color map versus data map
