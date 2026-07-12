# Trees Performance Design

Date: 2026-07-08

## Context

Trees improved significantly when the forest path moved from 96 submitted forest draws to 24 visible-variant draws. Recent stats show:

- July 4 and early July 5: `forestDraws` 96 was common.
- Later July 5 and July 8: `forestDraws` 24, `forestVisibleVariants` 3.
- July 8 baseline: `passForestMs` 0.3, `forestDraws` 24, `computeFrameCalls` 4, `renderDrawCalls` 239.

Trees are probably not the primary July 8 regression, but the remaining forest implementation still has obvious scaling issues. These matter because trees are large alpha/geometry contributors and can be paid again by water reflection and shadow passes.

## Findings

1. GPU forest culling is radial only.

`forest-gpu.js:86-130` resets counters, scans `V * CAP`, computes XZ distance to the camera, and assigns each instance to LOD0/1/2/billboard. There is no camera-frustum, view-cone, occlusion, or max-distance reject. Anything beyond LOD2 becomes LOD3 billboard.

This means trees behind the camera still survive as billboards if they are in the active source window.

2. Forest draw meshes explicitly disable renderer frustum culling.

`drawMesh` sets `mesh.frustumCulled = false` at `forest-gpu.js:201-206`. Billboard meshes also set `frustumCulled = false` at `forest-gpu.js:282-285`.

This is required for indirect instancing unless bounds are maintained, but it means the GPU culler must be strong. Right now it is only radial.

3. The GPU cull dispatch scans full variant capacity when the camera moves.

The compute path dispatches `SRC_TOTAL = V * CAP` (`forest-gpu.js:30-34`, `forest-gpu.js:86-130`). The shader guards `localSlot < srcCounts[g]`, but dispatch size is still full capacity. `update()` reculls whenever camera X/Z changes by more than `EPS` (`forest-gpu.js:399-415`).

Walking usually means a recull every frame. That is acceptable for low instance counts, but it scales badly with more variants, a larger active chunk window, or higher `capPerVariant`.

4. Each visible tree variant submits eight meshes.

The mesh setup pushes branch, leaf, shadow, LOD1, LOD2, coarse leaf, and billboard meshes in `forest-gpu.js:273-285`. The visible-variant gate fixed zero-instance variants, but each surviving variant still submits eight draw surfaces.

At the current three visible variants, that is 24 forest draws. If texture/palette variety increases, draw count rises linearly.

5. Leaves and billboards are double-sided alpha geometry.

`trees.js:141-144` creates the leaf material with `THREE.DoubleSide`. The GPU forest material setup uses double-sided leaf materials in `forest-gpu.js:242-249`, and billboard material uses `THREE.DoubleSide` in `forest-gpu.js:252`.

Double-sided alpha is costly: it increases overdraw and disables the simplest backface rejection. It also makes shadows and reflection more expensive.

6. Tree generation is CPU-heavy and synchronous.

The procedural tree generator stores JS arrays for branch/leaf geometry and commits them to buffer attributes in `trees.js:168-197`. Leaves are spawned across branch sections in `trees.js:294-381`. `forest-palette.js:54-75` generates multiple species/LOD variants synchronously.

This is mostly startup or rebuild cost, not per-frame render cost, but it can hitch palette changes, texture set swaps, or development-time rebuilds.

7. Forest rebuild scans all active chunk records and reuploads source buffers.

The CPU-side rebuild path in `forest-gpu.js:291-355` converts per-chunk records into a global source buffer. It already avoids clearing the full source array, but it still loops records, computes slots, and uploads source/count buffers on chunk changes.

## Design

### 1. Add view-frustum/cone rejection to the GPU culler

Extend each source record or uniform set with camera forward/right vectors and frustum cone values. In the `cull` kernel:

- Reject instances behind the camera beyond a small rear margin.
- Reject instances outside a conservative horizontal FOV cone plus tree radius.
- Keep a safety margin so large canopies do not pop at screen edges.

This should run before LOD selection and before atomic writes.

Acceptance:

- Looking forward in dense forest should reduce LOD3 billboard survivors behind the camera.
- No visible popping when rotating in place.
- Stats should report rejected-by-frustum counts.

### 2. Add a hard far cutoff for forest billboards

Do not send all beyond-LOD2 trees to LOD3 indefinitely. Add `treeLodR3` or `treeMaxDrawRadius`.

Suggested default:

- LOD0: current near radius.
- LOD1: current mid radius.
- LOD2: current far radius.
- LOD3 billboards: current far radius to a bounded max.
- Reject beyond max.

This should be exposed in stats and controls.

### 3. Recull on camera cells, not sub-millimeter movement

The current `EPS` path can recull every walking frame. Change the dirty logic to:

- Recull when the camera moves by a culling cell size, for example 1-2 world units.
- Recull every frame only while rotating if frustum culling is enabled and heading changed past an angular threshold.
- Force recull on chunk changes, LOD distance changes, or quality changes.

This aligns recull frequency with visible LOD/frustum changes rather than floating-point camera drift.

### 4. Reduce submitted tree surfaces per variant

Keep the eight-surface path for high quality, but add a lower-cost default:

- Disable L0 leaf shadow mesh unless shadows are explicitly high.
- Combine L1 leaves into the same material/geometry path as L0 when possible.
- Collapse L2 branches and coarse leaves into a single simplified impostor for medium/low.
- Use billboards earlier for low quality.

Target draw counts:

- Low: <= 3 draws per visible variant.
- Medium: <= 5 draws per visible variant.
- High: current 8 draws per visible variant.

### 5. Fix double-sided leaf and billboard cost

The leaf geometry should not require double-sided rendering as the default.

Options:

- Correct leaf/card winding and use front-side material where possible.
- For cards that must be visible from both sides, generate explicit backface geometry in the mesh once and use front-side material. This shifts work from per-fragment double-sided rasterization to controlled geometry.
- Use alpha test or alpha-to-coverage style material settings where available.
- Keep double-sided only for high-quality close leaves if visual tests justify it.

### 6. Move procedural tree palette generation off the main thread

Palette generation should be asynchronous:

- Generate branch/leaf/shadow geometries in a worker or idle build queue.
- Cache generated variants by seed, species params, texture mode, and LOD ratio.
- Swap in completed palettes after the current frame, using the same delayed-disposal principle already used for sky resources.

### 7. Improve forest rebuild locality

Instead of rebuilding a global source buffer from all active chunks on any chunk mutation:

- Track per-chunk ranges or per-variant append lists.
- Upload only changed chunks where feasible.
- Keep source counts and visible-variant masks incremental.
- Continue batching chunk changes into one rebuild per frame.

This is lower priority than frustum culling and far cutoff, because current rebuilds are not the main measured regression.

## Instrumentation

Add CSV fields:

- `forestReculls`
- `forestSkippedReculls`
- `forestCullDispatchInstances`
- `forestRejectedFrustum`
- `forestRejectedFar`
- `forestLod0Instances`
- `forestLod1Instances`
- `forestLod2Instances`
- `forestBillboardInstances`
- `forestVisibleVariants`
- `forestDraws`
- `forestQuality`
- `treePaletteBuildMs`
- `forestRebuildMs`

## Milestones

1. Forest telemetry

Expose LOD survivor counts and rejection counts from the compute path. This makes every later change measurable.

2. Frustum/cone culling

Add camera direction uniforms and conservative culling in `forest-gpu.js`.

3. Far cutoff

Add `treeMaxDrawRadius` and reject beyond it before billboard assignment.

4. Recull threshold

Replace `EPS` movement recull with cell/angle thresholds while preserving forced reculls for dirty data.

5. Tree quality presets

Add `?treeQuality=low|medium|high` and map it to LOD distances, shadows, leaf sides, and surfaces per variant.

6. Front-side leaves/billboards

Correct geometry/material assumptions so front-side rendering is the default.

7. Async palette/rebuild work

Move startup/rebuild generation to a worker or idle queue and cache results.

## Verification

Run comparable captures with:

- Current defaults.
- `?forest=off` if available, or a temporary forest disable flag.
- `?treeQuality=low`
- `?treeQuality=medium`
- Current high-quality path.
- Camera looking forward, backward, and rotating in place in the same forest area.

Pass targets:

- Frustum culling should reduce submitted forest instances when looking away from dense forest without changing visible output.
- Default tree quality should keep `forestDraws <= 24` for the current scene and reduce billboard survivors behind the camera.
- Forest GPU update should skip reculls on tiny camera movement and only recull on meaningful cell/heading changes.
- Low quality should cut forest draw submissions by at least 35% versus the current eight-surfaces-per-visible-variant path.
- No visible canopy popping at FOV edges during walking or camera rotation.
