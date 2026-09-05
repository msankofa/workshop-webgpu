# Tree startup latency

Preserve species, deterministic placement, geometry, shading, and final density. Commit each
fix separately. Existing unrelated worktree edits remain untouched.

- [x] Instrument Base Game setup, variant installation, scheduler wait count/time, first
  scene publication, total completion, and wave count. Existing palette/render/compute
  timings remain available in forest stats and performance captures.
- [ ] Remove redundant first-wave geometry replacement; verify original wrappers survive
  through compilation and later placeholders still get replaced.
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
renderers cannot measure shader compilation or GPU execution. Palette CPU timing currently
excludes generator construction, so it is not all generation cost.

Both environment viewers use the same palette/GPU modules but publish without Base Game's
explicit per-wave warmup. Their initial forest promise also runs behind the loading screen.
Default content differs; comparing default wall times alone cannot attribute the cause.

No browser automation connection is available in this session. Browser measurements and
visual verification remain pending; source-level work counts are not FPS claims.
