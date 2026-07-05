# Review: Problem 2 (vegetation draw submission) claims and fixes

*Report by exploratory review agent (Sonnet), 2026-07-04. Saved by parent session.*

Source doc reviewed: `creature-perf-analysis/render-bottleneck-fixes.md` (Problem 2, lines 53-75, 87-91).
Files checked: `forest-gpu.js`, `plants-gpu.js`, `forest-placement.js`, `environment-viewer.html` (vegetation wiring and per-frame update calls).

## Claim verification — all confirmed, no line drift

- `forest-gpu.js:388` — `stats.draws = V*8` (fixed constant). Confirmed.
- `plants-gpu.js:197` — `stats.draws = V` (fixed constant). Confirmed.
- `frustumCulled = false`: `forest-gpu.js:206` (LOD sub-meshes via `drawMesh()`), `forest-gpu.js:285` (billboard mesh), `plants-gpu.js:123`. Confirmed exact lines.
- `instanceCount = CAP`: `forest-gpu.js:203,282`, `plants-gpu.js:120`. Confirmed exact lines.
- No `.visible` gating anywhere in either file — confirmed via grep.
- `countsArray[g]` is computed in both `rebuild()`s (`forest-gpu.js:294,313-337`; `plants-gpu.js:132,143-176`) and is available to drive visibility. Confirmed.
- **Correction to the "8 sub-meshes = 3 LODs × {branches,leaves,shadow} + billboard" claim**: the actual composition (`forest-gpu.js:273-288`) is asymmetric — L0 = branches + leaves + **dedicated shadow-proxy mesh** (3 meshes), L1 = branches + leaves only (2 meshes; the branch mesh's own `castShadow=true` covers shadows), L2 = branches + coarse leaves (2 meshes, same trick), L3 = billboard only, no shadow (1 mesh). Totals 8, but only one dedicated shadow-only draw exists (L0's), not three.

## Fix feasibility

**(a) `mesh.visible = countsArray[g] > 0`** — Sound and low-risk. `.visible = false` does remove the draw from Three's render list (WebGPU renderer included) with zero effect on the compute pipeline — `reset`/`cull`/finalizers operate purely on storage buffers, unaware of mesh visibility, and run unconditionally every frame from `update()`. So hiding a variant doesn't stale its indirect buffer; when it repopulates, `.visible = true` shows correct data immediately. One caveat: `countsArray` and `meshes` are closure-local — the fix must live inside `rebuild()` in each module (not from `environment-viewer.html`, which has no access to per-variant mesh grouping today).

**(b) Reducing the 8× forest fan-out** — Harder than it looks. Each LOD band is a per-instance distance bucket of the *same* variant's pool, so a populated variant will typically have live instances split across multiple bands simultaneously — gating whole LOD tiers requires per-variant/per-band non-empty state, which today only exists as GPU-side atomics never read back to the CPU. Computing an approximate CPU version (as the doc's fix-2 suggests) would need re-bucketing all records by camera distance essentially every frame the camera moves (LOD membership isn't tied to `rebuild()`, which only fires on chunk-set changes) — this risks trading GPU-encode savings for a new per-frame CPU distance loop, roughly a wash. A safer, unconditional win: merge L0's dedicated shadow mesh into the branch mesh's own `castShadow=true` (as L1/L2 already do), cutting fan-out 8→7 for all variants, at the cost of a shadow-shape check.

**(c) Restoring frustum culling** — No bounding-volume infrastructure exists anywhere in `forest-placement.js`/`forest-gpu.js`/`plants-gpu.js` today — chunks carry only flat 2D rects (`xMin/zMin/size`), and each variant's mesh spans the whole active chunk window (not one mesh per chunk), so per-mesh culling would only ever catch "whole window off-screen" cases. Real per-chunk culling would require splitting into per-chunk meshes, undoing the GPU-indirect design's whole point. Correctly deprioritized by the doc.

## Inefficiency audit — key findings

| # | Finding | Location | Severity | Remedy |
|---|---|---|---|---|
| 1 | `rebuild()` does a full rescan of every registered chunk plus `.fill(0)` on the entire `V*CAP*8` array (with `capPerVariant: 2048`, V=12 → 196,608 floats) on *every* `setChunk`/`clearChunk` call, not just the changed chunk | `forest-gpu.js:312-338` | Medium | Incremental per-chunk updates, or debounce rebuilds to once per frame batch. |
| 2 | Same full-rescan pattern, plus a full `Array.sort` over *every* live plant record on every call | `plants-gpu.js:142-176` (sort at `154-160`) | Medium-high | Same as #1; avoid re-sorting unchanged records. |
| 3 | While chunks stream in (continuous camera movement; up to 3 chunks/frame budgeted, window radius 6 = 13×13 chunks), each non-empty batch triggers the full O(n log n) rebuild from #2 **every frame** | `environment-viewer.html:2848-2868` (`processPlantBuildQueue`), called via `2875-2880`; `plantsGPU.update()` per frame at `3666` | **High** | Likely a bigger real-world cost than the "always-on empty draws" framing in the source doc — fix alongside/before the `.visible` gating. |
| 4 | `stats.draws` constants need to become real counters once (a) ships, or the CSV will hide the win | `forest-gpu.js:388`, `plants-gpu.js:197` | — | Doc already flags this correctly. |
| 5 | `allRecords` array reallocated fresh every `rebuild()` | `plants-gpu.js:154-155` | Minor | Negligible next to #2's sort cost. |
| 6 | No O(n²) placement loops in `forest-placement.js` — placement is O(instances-per-chunk), runs once per chunk build, not per frame | — | — | Not a hot-path concern. |

## `countsArray` caveat — confirmed correct

`countsArray[g]` is a pre-cull CPU source count (placed instances before any distance/frustum cull), not the GPU post-cull survivor count. Fix (a) therefore only removes draws for variants with **zero source records anywhere in the active window** — it does nothing for a variant whose source records are all currently far/off-screen on the GPU side. This meaningfully caps the win in dense, spatially-spread scenes where most variants have at least one record somewhere in the window; the "~third of 352 draws" framing is optimistic for typical dense scenes and more accurate for sparse/edge cases.

## Verdict

Problem 2 fix (a) is correctly scoped, cheap, and accurately cited — ship it, but expect a smaller real-world win than the headline number in dense scenes, per the countsArray caveat. Fixes (b)/(c) are real but each has a hidden cost the doc understates (a per-frame CPU LOD-bucket loop for (b); a mesh-splitting architecture change for (c)) — treat both as follow-up investigations, not quick wins. The audit's most actionable new finding, beyond what the doc already covers: **`plants-gpu.js`'s `rebuild()` re-sorts and fully rebuilds the entire live-instance buffer on every frame with pending streamed chunks** — an O(n log n) CPU cost recurring far more often than "always-on empty draws" — a strong candidate to fix in the same pass as the `.visible` gating.
