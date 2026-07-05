# Critique of `render-bottleneck-fixes.md` (Opus + Codex plan)

*Consolidated review, 2026-07-04. Parent session (Fable) verified the baseline data directly; two Sonnet exploration agents verified the code claims — full detail in `report-water-reflection-review.md` and `report-vegetation-draws-review.md`.*

## Bottom line

The plan is sound and unusually well-cited: **every load-bearing claim and line reference checked out against the current code**, and every baseline number checked out against the CSV. The recommended order (reflection first, then vegetation `.visible` gating) is right. Two substantive critiques change how the fixes should land, and the audit surfaced one significant new bottleneck the plan misses entirely.

## Baseline data verification (done directly against the CSV)

Recomputed from `research/stats/perf-2026-07-05T00-13-18-054Z-baseline.csv` (164 samples): fps 37.3 ✓, cpuMs 24.35 ✓, passPostMs 20.79 (max 98.2) ✓, waterReflectionLastMs 10.57 (max 33.0) ✓, drawCalls 352 ✓, triangles 1.54 M ✓, all-other-passes sum 4.27 ms ✓, forestDraws/plantDraws constant at 96/16 in every row ✓.

Discrepancies (cosmetic): the doc quotes forest instances ~1758 but the capture averages ~1165 (plants ~694 vs ~656). Also `gpuRenderMs` is 0 in this timestamps-off capture, so the ~4.2 ms GPU figure — the number underpinning the whole "CPU-encode-bound" framing — rests entirely on the separate timestamp probe and is not verifiable from this file. The framing is still almost certainly right (the reflection and draw-count arithmetic independently supports it), but re-probe GPU time after the fixes land.

## Critique 1 — Problem 1's fix ordering is arguably backwards

The doc says "start with half-resolution, then add frame-skip if needed." But the doc's own diagnosis is that the frame is **CPU-encode-bound**: `resolutionScale: 0.5` shrinks the render target (GPU fill), while the same 350-ish draws are still traversed and encoded on the CPU for the mirror pass. The frame-skip (fix 2) is the change that mechanically halves CPU encode work, and the agent verified it is safe — the reflector only reassigns `textureNode.value` when a render actually runs (`three.webgpu.js:37356`), so skipping leaves the previous texture validly bound.

**Recommendation:** implement both together, or lead with the frame-skip. Measure `waterReflectionLastMs` after half-res alone before crediting it. All three proposed fixes are otherwise confirmed feasible; `resolutionScale` is real and correctly plumbed in r184, `setReflectRate()` is confirmed dead (`water.js:976-980`) and is the natural API to resurrect for the frame-skip. Note also the mirror render can trigger a second shadow-map pass, so the reflection is even more expensive than "base draws × 2" suggests. No `camera.layers` machinery exists anywhere in the codebase, so a scene-subset reflection would be new infrastructure — not a quick win.

## Critique 2 — Problem 2's headline win is overstated for dense scenes

Fix (a) (`mesh.visible = countsArray[g] > 0`) is confirmed safe: visibility gating doesn't disturb the GPU cull/indirect pipeline, which runs off storage buffers regardless. But `countsArray` is a **pre-cull source count**, so the fix only drops variants with zero placed instances anywhere in the 13×13-chunk window. In the baseline scene most variants are populated, so "112 fixed draws, a third of the total" is the ceiling, not the expectation. The doc half-acknowledges this; the framing in the priority table doesn't.

Two corrections to the doc's model of the forest fan-out (`forest-gpu.js:273-288`): the 8 sub-meshes are **not** 3 LODs × {branches, leaves, shadow} + billboard. Actual layout: L0 = branches+leaves+dedicated shadow proxy (3), L1 = branches+leaves (2), L2 = branches+coarse leaves (2), L3 = billboard (1). Only one dedicated shadow draw exists. Consequences:

- Doc fix (2) (gating LOD sub-meshes by CPU-side per-band counts) is **worse than it sounds**: LOD band membership changes with camera distance every frame, not on rebuild, so CPU-side band counts would need a per-frame re-bucketing loop over all records — likely a wash. Treat as investigation, not a quick win.
- A cheaper unconditional cut the doc misses: fold L0's dedicated shadow-proxy mesh into the branch mesh's `castShadow=true` (as L1/L2 already do) — 8→7 draws for every variant.
- Doc fix (3) (frustum culling) is correctly deprioritized: each variant's mesh spans the whole active window, so per-mesh culling catches almost nothing without a per-chunk mesh split that would undo the GPU-indirect design.

Implementation note the doc gets right and deserves emphasis: `countsArray`/`meshes` are closure-local, so the visibility fix must live inside each module's `rebuild()`, and `stats.draws` must become a real counter or the CSV will hide the win.

## New finding the plan misses: per-frame plant rebuild churn (high severity)

The single most actionable thing the audit found that is **not in the plan**: while chunks stream in during camera movement, `processPlantBuildQueue` (`environment-viewer.html:2848-2868`) feeds `plants-gpu.js`'s `rebuild()` (`plants-gpu.js:142-176`), which **re-sorts and fully rebuilds the entire live plant buffer — full rescan of every chunk plus an O(n log n) sort over every record — every frame there's a pending batch**. `forest-gpu.js:312-338` has the same full-rescan pattern (plus a 196k-float `.fill(0)`) on every `setChunk`/`clearChunk`, without the sort. This recurring CPU cost during movement is plausibly a larger real-world contributor to hitching than the always-on empty draws, and it should be fixed in the same pass as (or before) the `.visible` gating: debounce rebuilds to one per frame batch and make them incremental per-chunk.

## Secondary inefficiencies found (see per-file reports for detail)

| Finding | Location | Severity |
|---|---|---|
| Plant rebuild sort/rescan every streamed frame | `plants-gpu.js:142-176`, `environment-viewer.html:2848-2868` | High |
| Forest rebuild full rescan + 196k `.fill(0)` per chunk event | `forest-gpu.js:312-338` | Medium |
| Water height cache grows unbounded over long sessions (cleared only on terrain change) | `water.js:275-292,795-801` | Medium |
| String-key allocation per height-cache lookup, redundant `cellSize` prefix | `water.js:280-282` | Low-medium |
| Dead code: `setReflectRate()` no-op, `buildGeometry()` unused | `water.js:976-980,199-240` | Low |
| No O(n²) loops found in water ring building or forest placement | — | — |

## Revised recommended order

1. Reflection frame-skip **and** `resolutionScale: 0.5` together (resurrect `setReflectRate` as the API). Re-capture.
2. `.visible` gating in both `rebuild()`s + real `draws` counters. Same pass: debounce/incrementalize the plant and forest rebuilds (the new high-severity finding). Re-capture.
3. Fold L0's shadow proxy into branch `castShadow` (8→7 fan-out).
4. Only then evaluate LOD-band gating / distance gating with fresh numbers.
