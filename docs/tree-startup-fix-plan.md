# Tree startup latency

Preserve species, deterministic placement, geometry, shading, and final density. Commit each
fix separately. Existing unrelated worktree edits remain untouched.

- [x] Instrument Base Game setup, variant installation, scheduler wait count/time, first
  scene publication, total completion, and wave count. Existing palette/render/compute
  timings remain available in forest stats and performance captures.
- [x] Remove redundant first-wave geometry replacement; verify original wrappers survive
  through compilation and later placeholders still get replaced.
- [x] Remove discarded default-tree generation from the shared palette baker; compare all
  output geometry bytes against the former constructor/regenerate sequence.
- [ ] Compare matching species, seeds, texture mode, variants, and LOD geometry in the viewer
  and Base Game. Capture cold and warm browser runs, first rendered trees and complete forest.
- [ ] Target measured compilation/generation bottlenecks; evaluate pipeline consolidation,
  bounded geometry caching, and publication scheduling without introducing startup freezes.
- [ ] Validate browser screenshots and frame-time percentiles before claiming improvement.

## Timing interpretation

`forest.stats.startup` is also included in the existing performance capture's trees object.
`firstPublicationMs` means meshes entered the scene, not first pixels; it excludes lazy module
loading before buildAsync and terrain streaming after publication. `totalMs` remains null
until all waves finish. `yieldMs` includes other work scheduled during waits and overlaps
the existing compute warmup elapsed time: do not add these fields as disjoint stages.
Setup is CPU construction/binding, not actual GPU buffer upload time. Headless benchmark
renderers cannot measure shader compilation or GPU execution. Palette CPU timing now includes
the generator constructor inside the first variant bake; older timings excluded that work.

Both environment viewers use the same palette/GPU modules but publish without Base Game's
explicit per-wave warmup. Their initial forest promise also runs behind the loading screen.
Default content differs; comparing default wall times alone cannot attribute the cause.

No browser automation connection is available in this session. Browser measurements and
visual verification remain pending; source-level work counts are not FPS claims.

## Results

Instrumentation commit: `d5bff78`; 101 forest checks passed. The initial headless benchmark
reported 3.5-6.0 ms in variant installation across three scenarios, but asynchronous elapsed
startup/warmup figures include terrain work interleaved by the harness, not GPU compilation.

First-wave fix: the default three-species forest avoids 27 redundant draw-wrapper replacements
and their disposal, plus redundant indirect-buffer dirtying, before its first publication.
All later variants still replace their placeholders. Geometry, materials, wave composition,
warmup ordering and final placement are unchanged. Regression checks count installations and
verify wrapper identity for both initial and replacement waves.

First-wave fix commit: `c82540c`; 104 forest checks and shared-geometry lifecycle checks pass.
The palette baker now constructs its generator with the first real variant, avoiding one full
discarded default-tree generation per palette. This benefits both viewers and Base Game; it
is shared waste, not an explanation for their entire latency difference. Tests verify byte-identical
indices, attributes, and bounding spheres for procedural and authored palettes, trunk LODs,
sync/async ordering, and no generator work when already cancelled.
