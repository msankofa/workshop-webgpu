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

- [x] 1. Release stale grass reflection exclusions on rebuild and disable. Publish removal
  as well as addition, replace the page's previous reference, and verify repeated lifecycle
  changes leave only the current mesh registered.
- [x] 2. Make diagnostic readbacks opt-in and race-free. Sample only for a visible panel or
  active capture; serialize probes sharing an output buffer; discard stale results after
  replacement/disposal. Verify hidden diagnostics submit no readbacks.
- [x] 3. Cache unchanged flora occlusion renders. Invalidate for camera/projection changes,
  occluder changes, and re-enabling. Restore scene/renderer state on exceptions. Verify
  stationary frames reuse the image and moving cameras update immediately.
- [x] 4. Reject grass candidates before expensive height/occlusion sampling. Use explicit
  shader branches for bounds, distance, cone, fade, and density. Preserve all hashes and
  acceptance predicates. Branch between structure and terrain sampling. Compile both
  occlusion and non-occlusion paths and run placement, wind, and fade checks.
- [x] 5. Cache settings-derived grass telemetry calculations and objects rather than
  recomputing/allocating them each frame. Keep live counters accurate.
- [x] 6. Reduce forest source uploads with changed attribute ranges. Verify additions,
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

Plan committed as `6dbfd35` before implementation. Baseline: 88 flora checks, 87 grass
checks, 26 WGSL build checks, and the panel/profiler gating checks passed. No browser
measurements completed yet.

Fix 1: grass removal notifications now unregister disposed meshes from reflection exclusions.
Validation: 95 flora checks passed, including rebuild, disable/re-enable, and repeated disposal.

Fix 2: diagnostic sampling is opt-in, its shared-buffer probes run sequentially, and retired
samples cannot publish or submit another probe. Validation: 103 flora checks and both panel
and profiler gating checks passed. Fix 1 commit: `d6bdec9`.

Fix 3: Base Game opts into static occlusion caching; other hosts retain dynamic behavior.
Root transforms and visibility invalidate the image; child/geometry edits use markOccluders
or invalidate. Depth revisions now invalidate both grass and plant culls, including edits
with a stationary camera. Render failures restore scene state and retry. Validation: cache
and failure-restoration checks, 90 grass checks, and 103 flora checks passed. Fix 2: `5152c82`.

Fix 4: procedural grass now rejects bounds/radius/cone/fade, then density, before evaluating
height and occlusion. Structure overrides branch around terrain samplers; disabled/off-screen
occlusion avoids depth reads. Hashes, acceptance predicates, five depth taps, blade geometry,
and material shading are unchanged. Validation: 33 WGSL checks (including generated branch
ordering and both procedural/anchor occlusion builds), 103 flora checks, 90 grass checks,
wind/cell checks, and 18,458 anchor assertions passed. Browser visual/GPU validation remains.
Fix 3 commit: `52a3207`.

Fix 5: tiered expected-count integration and tint/fade/handover objects now refresh on settings
or effective-tier changes. Cone calculations reuse scratch storage, and skipped frames retain
the actual last recull reason. Validation: 106 flora checks and 91 grass checks passed.
Fix 4 commit: `a2522b1`.

Fix 6: source records are compared in Float32 precision and only the changed span is scheduled
for upload. Pending ranges survive additional rebuilds before renderer consumption. Unchanged
chunks upload no source data; a one-tree edit uploads 32 bytes. The full CPU placement scan and
insertion-order capacity policy remain. Validation: focused upload/precision/removal/rebase/
overflow/publication checks and 99 forest checks passed. Headless rescan timings were
0.04–0.09 ms; these are not GPU upload measurements. Fix 5 commit: `9d5ecf3`.
