# Base Game vegetation performance fixes

Date: 2026-09-04

## Goal and constraints

Reduce movement-related vegetation work and resource retention while preserving placement,
density, geometry, shading, wind, shadows, and the existing visibility rules. Commit the plan
first, then commit each fix separately with its validation. Preserve unrelated workspace edits.

The audit establishes code paths, not browser frame-time attribution. The headless forest
benchmark measured 0.009–0.015 ms idle updates and 0.05–0.07 ms CPU rescans. Its fake renderer
does not measure uploads, GPU execution, or browser frame pacing.

## Bug-fixing checklist and sequence

- [ ] 1. Release stale grass reflection exclusions on rebuild and disable. Publish removal
  as well as addition, replace the page's previous reference, and verify repeated lifecycle
  changes leave only the current mesh registered.
- [ ] 2. Make diagnostic readbacks opt-in and race-free. Sample only for a visible panel or
  active capture; serialize probes sharing an output buffer; discard stale results after
  replacement/disposal. Verify hidden diagnostics submit no readbacks.
- [ ] 3. Cache unchanged flora occlusion renders. Invalidate for camera/projection changes,
  occluder changes, and re-enabling. Restore scene/renderer state on exceptions. Verify
  stationary frames reuse the image and moving cameras update immediately.
- [ ] 4. Reject grass candidates before expensive height/occlusion sampling. Use explicit
  shader branches for bounds, distance, cone, fade, and density. Preserve all hashes and
  acceptance predicates. Branch between structure and terrain sampling. Compile both
  occlusion and non-occlusion paths and run placement, wind, and fade checks.
- [ ] 5. Cache settings-derived grass telemetry calculations and objects rather than
  recomputing/allocating them each frame. Keep live counters accurate.
- [ ] 6. Reduce forest source uploads with changed attribute ranges. Verify additions,
  removals, rebases, overflow, and variant publication. Stable chunk slots are a larger
  follow-up, not a prerequisite for partial uploads.
- [ ] 7. Share immutable tree geometry attributes while retaining separate indirect draw
  state and explicit shared-resource ownership. Verify replacement/disposal and compare
  geometry bytes with the forest benchmark.

## Larger changes and profiling gates

- [ ] 8. Separate persistent grass generation from camera-dependent visibility. First
  capture standing, turning, and walking frames. Design a bounded candidate cache with
  invalidation for fields, structures, rebases, tiers, and settings. Keep camera-relative
  near/far height blending live. Cache overflow must not remove blades the old path kept.
- [ ] 9. Measure global atomic contention, then evaluate workgroup/subgroup compaction.
  Preserve device fallback, capacity behavior, and nearby blades under overflow.
- [ ] 10. Measure first-use pipeline creation and shadow costs before targeted warmup.
  Lambert shading, reduced density, weaker shadows, and simpler geometry are excluded
  from these appearance-preserving fixes.

## Validation

For each fix: run relevant existing checks and focused behavioral regressions, record results
below, and commit only that fix and its tests. WGSL compilation is not device bind-time or
visual validation. Do not claim GPU speedups from headless tests.

Browser acceptance covers standing, turning, walking across cells, building entry/exit,
terrain changes, toggles, rebuilds, wind extremes, and screen/wall edges. Match camera and
settings for image comparisons. Record CPU and actual GPU timestamps, occlusion renders,
reculls, readbacks, retained memory, and p50/p95/p99 frame time.

## Completed work

Plan recorded before implementation. No fixes or browser measurements completed yet.
