# Render bottleneck: two problems, priorities, and fixes

## How we know

Clean baseline capture with GPU timestamps **off** (`research/stats/perf-2026-07-05T00-13-18-054Z-baseline.csv`, 164 samples). Timestamp mode was adding ~10–20 ms/frame of `resolveTimestampsAsync` overhead, so it is not a valid frame-pacing baseline — this capture is. Baseline averages:

| Metric | Value |
|---|---|
| fps | 37.3 |
| cpuMs | 24.35 ms |
| passPostMs | 20.79 ms (85% of the frame) |
| waterReflectionLastMs | 10.57 ms |
| all other timed passes combined | ~4.3 ms |
| renderDrawCalls | 352 |
| triangles | 1.54 M |
| gpuRenderMs (from a separate timestamp probe) | ~4.2 ms |

Two facts frame everything below:

1. **The frame is CPU-encode-bound, not GPU-bound.** The GPU finishes rendering in ~4.2 ms; the CPU spends 24.4 ms building and submitting the frame. Shader-side optimisation will not move the number — reducing CPU render work will.
2. **`passPostMs` is the whole frame.** It is not post-processing. It wraps the full base-scene `renderer.render()` call (and the shadow passes and the water reflection that run nested inside it). Everything else the app does per frame adds up to ~4.3 ms.

So the target is the ~20.8 ms spent inside the main render call. It has two large, separable components.

---

## Problem 1 (highest priority): the water reflection re-renders the whole scene every frame

**Cost: ~10.6 ms/frame — roughly half of `passPostMs` and ~43% of the entire CPU frame.**

### What happens

The water surface uses a TSL `reflector()` node (`water.js:555`). Its `reflector` runs a full `renderer.render(scene, virtualCamera)` from a mirrored camera inside its `updateBefore()` hook (`water.js:541-570`), every frame, at full resolution. That is a second complete scene submission — all the terrain, vegetation, and creature draw commands are encoded twice per frame.

The reflection is created with default options, so no resolution downscale and no frame throttling is applied. Its per-frame cost is already measured: `reflectionRenderStats.lastMs` (`water.js:566-569`), reported to the CSV as `waterReflectionLastMs` — 10.57 ms average, up to 33 ms.

### Why it is #1

It is the single largest line item by a wide margin, it is measured directly (not inferred), and the insertion point for a fix already exists — the `updateBefore` override at `water.js:560-570` already gates on `reflectionEnabled` and already times the call, so throttling or downscaling is a localized change.

### Suggested fixes, in order of preference

1. **Half-resolution reflection target (lowest risk, do first).** Pass a resolution scale to the reflector: `reflector({ resolutionScale: 0.5 })` at `water.js:555`. Three r184 still accepts `resolution` as a deprecated alias, but `resolutionScale` is the canonical option (`three.webgpu.js:36884,37029,37071-37075`). The reflection is already distorted by the ripple normal (`uvNode.add(N.xz...)`, `water.js:572`) and blended by Fresnel, so a half-res mirror texture is very hard to notice. Halving both dimensions cuts the reflection's fill and encode cost substantially. Expected recovery: a few ms.

2. **Render the reflection every other frame and reuse the last texture.** In the `updateBefore` override (`water.js:560-570`), skip `renderReflection(frame)` on odd frames and leave the previous render target bound. The mirror camera moves slowly relative to the ripple animation, so a 30 Hz reflection under a 60 Hz surface is generally imperceptible. Expected recovery: ~5 ms averaged. Combine with (1) for the largest win.

3. **Distance / view gate.** Skip the reflection entirely when the camera is far from any water or looking away from it. Cheap when it applies, no visual cost, but only helps in scenes/positions where water is off-screen.

Start with (1), re-capture, then add (2) if more headroom is needed. (3) is opportunistic.

---

## Problem 2 (second priority): base-scene draw submission, including always-on empty vegetation draws

**Cost: the remaining ~10 ms of `passPostMs` — the main draw list (352 draw calls, 1.54 M triangles) plus the shadow pass.**

### What happens

Because the app is CPU-encode-bound, the number of draw calls submitted per frame matters directly — each draw costs CPU render-list traversal, pipeline bind, and command encoding regardless of how cheap it is on the GPU. A concrete, fixable slice of this is vegetation:

- The forest submits a **fixed 96 draws** (`forest-gpu.js:388`, `draws: V * 8` with V = 12 variants) and plants submit a **fixed 16 draws** (`plants-gpu.js:197`, `draws: V`), **every frame regardless of how many instances are actually present.**
- Every vegetation mesh is added to the scene with `frustumCulled = false` (`forest-gpu.js:206,285`, `plants-gpu.js:123`) and its `instanceCount` pinned to the fixed capacity (`forest-gpu.js:203,282`, `plants-gpu.js:120`), not the live survivor count (which lives in a GPU indirect buffer the CPU never reads back).
- There is no `.visible` gating anywhere in the vegetation path. So a variant with zero live instances still submits its draw call.

A zero-instance indirect draw is nearly free on the GPU, but it is **not** free on the CPU — it still traverses the render list, binds its pipeline, and encodes a command. 112 fixed vegetation draws is roughly a third of the 352 total.

### Suggested fixes, in order of preference

1. **Skip zero-instance vegetation variants with `.visible` (low risk, uses data already on hand).** Both `rebuild()` paths already compute per-variant CPU-side placement counts (`countsArray[g]` in `forest-gpu.js` and `plants-gpu.js`) — the same source that feeds the CSV `forestInstances`/`plantInstances`. After rebuild, set `mesh.visible = countsArray[g] > 0` on each variant's mesh(es). Three then drops empty variants from the render list entirely. No GPU readback needed. This removes only the *empty* draws, which is safe and correct; how much it recovers depends on how sparse the current view is (the baseline had forest ~1758 and plant ~656 live instances, so many variants are populated — the win is larger in sparser scenes and when looking at open terrain).

2. **Reduce the fixed forest draw fan-out.** 96 forest draws come from 12 variants × 8 meshes each (3 LODs × {branches, leaves, shadow} + billboard). If some of those 8 sub-meshes are consistently empty or redundant at a given distance, gating them (or merging LOD sub-meshes) cuts draws for *every* variant, not just empty ones. This needs a closer look at which of the 8 are actually carrying instances at typical camera distances before acting.

3. **Re-enable frustum culling where it is safe.** `frustumCulled = false` is currently forced on vegetation because the CPU has no bounding info for GPU-culled instances. If a per-chunk world-space bound is available (or cheap to compute), restoring frustum culling would drop off-screen chunks' draws. Larger change; evaluate after (1) and (2).

Do (1) first — it is small and self-contained. (2) and (3) need a short investigation into the per-variant/per-LOD draw composition before committing.

---

## Problem 3 (found in review): vegetation rebuild churn during chunk streaming

**Cost: not isolated in the baseline CSV (it hides inside `cpuMs`/frame spikes during camera movement), but structurally the largest recurring CPU loop outside the render call.** Found by the code-review pass (see `report-vegetation-draws-review.md`); the baseline capture above was largely stationary, so this cost is underrepresented in it.

### What happens

- **Plants:** while chunks stream in during camera movement, `processPlantBuildQueue` (`environment-viewer.html:2848-2868`, budgeted up to 3 chunks/frame over a 13×13-chunk window) feeds `plants-gpu.js`'s `rebuild()` (`plants-gpu.js:142-176`), which does a **full rescan of every registered chunk plus an O(n log n) `Array.sort` over every live plant record** (`plants-gpu.js:154-160`) — and this runs **every frame** there is a pending batch, not once per settled window.
- **Forest:** `forest-gpu.js`'s `rebuild()` (`forest-gpu.js:312-338`) has the same full-rescan pattern, plus a `.fill(0)` over the entire `V*CAP*8` instance array (~196,608 floats at `capPerVariant: 2048`, V=12) on **every** `setChunk`/`clearChunk` call, not just for the changed chunk.

During continuous movement this is an O(n log n) sort plus two full-window rescans recurring per frame — plausibly a larger real-world contributor to hitching than the always-on empty draws in Problem 2, and a likely source of the `passPostMs`-adjacent frame spikes noted in the caveats.

### Suggested fixes, in order of preference

1. **Debounce rebuilds to at most one per frame batch.** Collect all `setChunk`/`clearChunk` calls made in a frame and run a single `rebuild()` after the batch, instead of one full rebuild per chunk event. Small, local change in both modules (or at the call sites in `environment-viewer.html`).
2. **Make rebuilds incremental per chunk.** Track per-chunk record ranges so a chunk add/remove touches only its slice of the instance buffer instead of rescanning the window and re-zeroing/re-sorting everything. For plants, sort only when the record set actually changed, or maintain sorted insertion.
3. **Skip the redundant work inside rebuild:** avoid re-zeroing the full capacity array (only the tail past the new count needs clearing), and avoid reallocating the `allRecords` array each call (`plants-gpu.js:154-155`).

Do (1) first — it caps the churn at one rebuild per frame regardless of streaming rate and pairs naturally with the Problem 2 `.visible` fix (same functions). (2) is the real fix but needs bookkeeping; (3) is opportunistic cleanup inside either.

---

## Secondary findings (from review; not frame-rate critical)

- **Unbounded water height cache** (`water.js:275-292`): per-LOD `Map`s only cleared on terrain-signature change (`water.js:795-801, 1002-1006`), so they grow forever as the camera roams a static map — a slow memory leak over long sessions. Add eviction/LRU. Medium severity, not a per-frame cost.
- **String-key allocation per height-cache lookup** (`water.js:280-282`): builds a `` `${cellSize}:${qx},${qz}` `` string per sample; the `cellSize` prefix is redundant (each LOD ring has its own map) and the ×1000 quantization does no useful work on grid-aligned inputs. Use integer-packed keys. Low-medium; amortized by the build budget today.
- **Dead code in `water.js`:** `setReflectRate()` is a retained no-op (`water.js:976-980`) — resurrect it as the seam for the Problem 1 frame-skip fix, or remove it. `buildGeometry()` (`water.js:199-240`) has no call sites.
- **Forest L0 shadow proxy** (`forest-gpu.js:273-288`): the 8-mesh fan-out is asymmetric — only L0 carries a dedicated shadow-only mesh; L1/L2 rely on the branch mesh's own `castShadow=true`. Folding L0's shadow proxy into the same pattern cuts fan-out 8→7 for *every* variant unconditionally — a cheaper, safer draw reduction than the LOD-band gating floated in Problem 2 fix (2), which would require a per-frame CPU re-bucketing loop (LOD band membership shifts with camera distance every frame, not on rebuild) and is likely a wash.
- No O(n²) loops were found in water ring building or forest placement; those paths are linear and budget-amortized.

---

## Implementation notes to avoid false wins

### Reflection

- Use `resolutionScale`, not `resolution`, when coding the half-res reflector. The old `resolution` name works in r184 only through a deprecation shim and will produce a warning path.
- If implementing every-other-frame reflection, the existing `setReflectRate()` API is currently retained but explicitly no-op (`water.js:976-980`). The real seam is the `reflectorBase.updateBefore` wrapper at `water.js:560-570`: count frames there, skip `renderReflection(frame)` on non-render frames, and leave the previous reflector texture in place.
- When re-capturing, track both `passPostMs` and `waterReflectionLastMs`. If `waterReflectionLastMs` drops but `passPostMs` does not, the reflection render target got cheaper but the main-pass command encode is still the bottleneck.

### Vegetation

- `countsArray[g]` in `forest-gpu.js` / `plants-gpu.js` is a CPU-side source-count per variant, before the GPU cull/finalizer writes indirect survivor counts. So `mesh.visible = countsArray[g] > 0` removes variants with no source records in the active window; it does **not** remove LOD/material sub-draws for a populated variant whose GPU survivor count is zero after distance/frustum culling.
- For forest specifically, variant-level visibility still leaves all 8 meshes visible for any populated variant. That is safe and low risk, but it will not reduce the 8x fan-out in dense windows where every variant has at least one source record. A follow-up draw-fanout fix should compute approximate per-variant/per-LOD CPU source counts during `rebuild()` and gate `meshes[g * 8 + submesh]` separately.
- Update the reported stats when adding visibility gates. `forestDraws` and `plantDraws` currently report constants (`V * 8`, `V`), so after the fix they should report visible/submitted draw counts, plus optionally `visibleVariants`, otherwise the CSV will hide the win.

---
## Priority summary

| # | Problem | Measured cost | First fix | Risk |
|---|---|---|---|---|
| 1 | Water reflection re-renders whole scene every frame | ~10.6 ms | Frame-skip + half-res reflection target (`reflector({ resolutionScale: 0.5 })`) | Low |
| 2 | Always-on vegetation draws + base draw list | ~10 ms (shared with shadows) | `.visible` skip for zero-instance variants | Low |
| 3 | Vegetation rebuild churn during chunk streaming | not isolated (hides in movement-frame spikes) | Debounce to one rebuild per frame batch | Low |

**Recommended order:** ship Problem 1 fixes (1)+(2) together (the frame is CPU-encode-bound, so the frame-skip is the part guaranteed to move `waterReflectionLastMs`; half-res alone mainly cuts GPU fill) → re-capture baseline → ship Problem 2 fix (1) and Problem 3 fix (1) together (same functions) → re-capture, including a capture taken while moving the camera to expose the Problem 3 win. Each step is independently measurable against `passPostMs` and `waterReflectionLastMs`, which are now trustworthy after the instrumentation fixes (`fix(infra): correct timestamps-on perf logging`).

At 24.4 ms/frame (37 fps), the reflection fix alone plausibly moves the frame toward the 16.7 ms / 60 fps line; the draw-list work closes the rest.

## Notes and caveats

- `creatureShadows` (avg 0.54, up to 6) is an instance count feeding a single shared shadow-box InstancedMesh — one shadow draw total, not a per-creature pass. It correlates with expensive frames but is not itself a cost driver. Do not spend effort here.
- Occasional `passPostMs` spikes (max 98 ms in the baseline) are one-off hitches — likely shader compiles or buffer uploads on rebuild frames — not the steady-state cost. Problem 3 (vegetation rebuild churn) is the most likely structural source of movement-correlated hitches; address it there before investigating further.
- All numbers here are from the timestamps-off baseline. Validate fixes against a timestamps-off capture; use timestamp mode only for short GPU-specific probes.
