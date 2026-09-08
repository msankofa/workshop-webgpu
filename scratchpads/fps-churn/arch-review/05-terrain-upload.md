# Terrain geometry integration and upload architecture — review

Scope: `terrain-chunk-batches.js` (commit/fold/compaction), how r184 WebGPU honours
`BufferAttribute.updateRanges`, `base-game-terrain.js` fold/visibility scheduling, and
`terrain-system.js` residency (`unloadMargin`) vs draw count. Read-only, no browser. Evidence
base: source of `terrain-chunk-batches.js`, `terrain-system.js`, `base-game-terrain.js`;
`node_modules/three@0.184.0/src/objects/BatchedMesh.js`, `.../renderers/webgpu/utils/WebGPUAttributeUtils.js`,
`.../renderers/webgpu/WebGPUBackend.js`, `.../renderers/common/Attributes.js`.

## Finding 1 — ranged uploads are real, not a full-buffer rewrite

`terrain-chunk-batches.js:35-37` documents `optimize()` as "rewrites every vertex and index in
the batch and re-uploads it," which is the reason `maxCompactionsPerFrame` exists as a hitch
guard. Reading the actual r184 `BatchedMesh` source shows this is not quite what happens at the
GPU-write level:

- `BatchedMesh.setGeometryAt` (`src/objects/BatchedMesh.js:764,790`) calls
  `dstAttribute.addUpdateRange(vertexStart*itemSize, reservedVertexCount*itemSize)` per attribute,
  and the same for the index buffer. A single `add()` only marks the copied range dirty.
- `BatchedMesh.optimize()` (`BatchedMesh.js:878-960`) also calls `addUpdateRange` per attribute,
  per index buffer, only for geometries whose `vertexStart`/`indexStart` actually shifted
  (`copyWithin` + `addUpdateRange` on the destination range). A geometry already in place is
  skipped entirely — no range, no write.
- `Attributes.update()` (`renderers/common/Attributes.js:99-109`) bumps `version` on any
  `needsUpdate=true` and calls `backend.updateAttribute`.
- `WebGPUAttributeUtils.updateAttribute` (`renderers/webgpu/utils/WebGPUAttributeUtils.js:149-226`)
  branches on `bufferAttribute.updateRanges.length`: **0 ranges → one `writeBuffer` of the whole
  array**; **≥1 ranges → one `writeBuffer` per range, byte-offset and sized to that range**, then
  `clearUpdateRanges()`.

So both `add()` and `optimize()` go through the ranged path, not the "whole buffer" path — the
GPU transfer for `optimize()` is proportional to the vertices/indices that actually moved (the
tail past the first hole), not the full batch capacity. The full-buffer path only fires for an
attribute whose code path sets `needsUpdate=true` without ever calling `addUpdateRange` — that is
not this batcher's code, and I found no such call in `terrain-chunic-batches.js` or
`terrain-system.js`. The `maxCompactionsPerFrame` throttle is still reasonable (CPU-side
`copyWithin` + JS attribute walk + colorize passthrough scale with what shifted, and a batch with
one big hole near the start can shift most of its live chunks), but the stated cost model ("rewrites
the whole buffer") overstates the GPU-transfer part of it.

- Classification: code-supported correction to an inline comment (verified against the installed
  three.js source, not measured with a profiler).
- Proposed change: soften the comment at `terrain-chunk-batches.js:35-37` to say "shifts and
  re-uploads only the geometries that moved (ranged writes), not the whole buffer" — the CPU
  `copyWithin` work over shifted geometries is still real and still worth rationing, so keep
  `maxCompactionsPerFrame`.
- Benefit: prevents a future change (e.g. "let's raise `maxCompactionsPerFrame` because it's
  cheap" or the reverse, "compaction is expensive so avoid it entirely") from being made on a
  wrong cost model. No runtime change implied.
- Dependency/overlap: none with other areas; this is purely the comment and the mental model
  behind the throttle.
- Correctness check: instrument `WebGPUAttributeUtils.updateAttribute` (or wrap
  `device.queue.writeBuffer` in a dev build) to log `size` per call during a `compact()`; compare
  the summed bytes written against the batch's total buffer size for a batch with, say, 20% dead
  space fragmented at the front. Cannot do this without a live WebGPU device — untested here.
- Priority/scope: safe direct improvement (comment only).

## Finding 2 — `unloadMargin` chunks are drawn, not just retained

`terrain-system.js:46-50` documents `unloadMargin` as pure hysteresis: "chunks are kept this many
beyond renderRadius before unloading, so a body loitering on a boundary does not thrash." But
`update()` builds two different key sets from the same `ringKeys()` helper (a full square, not an
annulus, despite the name — `terrain-system.js:695-703`):

- `targetKeys = ringKeys(cx, cz, radius)` — the chunks the streamer actually wants visible
  (`terrain-system.js:422`).
- `keepKeys = ringKeys(cx, cz, radius + unloadMargin)` — the resident set that is exempt from
  eviction (`terrain-system.js:423-424`, used at `terrain-system.js:472`:
  `if (this.keepKeys.has(key)) continue;` in the unload loop).

`getMissingKeysSorted()` only iterates `targetKeys` (`terrain-system.js:755-768`), so margin-ring
chunks are never freshly built for their own sake — they are leftover chunks from a previous
frame's `targetKeys` that the body has since moved away from, kept alive only so a boundary
crossing back doesn't rebuild them. That part matches the doc's intent and is fine.

The problem is on the render side. `base-game-terrain.js:640-653` (`syncBatchVisibility`) and
`base-game-terrain.js:654-667` (`foldOne`) iterate `sys.chunks` — which contains everything in
`keepKeys`, margin ring included — and decide visibility with `hideRule(chunk)`:

- Near system: `nearHideRule = chunk => chunk.stale && volumetricMode && !chunk.meta.volumetric && farLodMode`
  (`base-game-terrain.js:678`). This hides a *stale* chunk under a specific volumetric/far-LOD
  condition; it has nothing to do with whether the chunk is inside `radius` or only inside
  `radius+unloadMargin`.
- Cascade systems: `cascadeHideRule = () => false` (`base-game-terrain.js:679`) — never hides
  anything.

So a chunk that is resident purely for hysteresis (outside the streamer's own `targetKeys`) is
folded into its batch the same as any other chunk (`nextFoldKey` walks all of `sys.chunks`,
`base-game-terrain.js:669-677`) and, once folded, is visible and drawn every frame like the rest
of the ring — one more `drawIndexed` call, its vertices submitted, its triangles rasterized —
even though the streamer's own target radius no longer wants it displayed.

Quantified from the config, not measured: near system `renderRadius: 3, unloadMargin: 1`
(`base-game-terrain.js:30,61`). `ringKeys` is a full square, so:
- target set: `(2*3+1)^2 = 49` chunks
- kept/drawn set: `(2*(3+1)+1)^2 = 81` chunks
- **+32 chunks (+65%)** drawn beyond the streamer's own visible radius, permanently (this is the
  steady-state ring while stationary, not a transient).

Each cascade level (`chunkSize: 120/480/1920`, all `renderRadius: 2`, same `unloadMargin: 1` via
`...streamParams` at `base-game-terrain.js:346`):
- target: `(2*2+1)^2 = 25`; kept/drawn: `(2*3+1)^2 = 49` → **+24 chunks (+96%)**, ×3 cascade
  levels.

- Classification: code-supported architectural weakness (residency hysteresis leaking into
  render visibility). Not reproduced in a browser; the chunk counts above are computed from the
  documented `ringKeys`/`getTargetKeys` logic and the shipped config values, not a captured trace.
  `research/stats/base-game-performance-log.json`'s per-frame `terrainInFlight`/`terrainBusyWorkers`
  columns don't carry a drawn-chunk-count series, so I could not cross-check against a capture —
  see "what I could not verify."
- Proposed replacement: give `hideRule` (or a new one) an `outsideRadius(chunk)` test — e.g. tag
  each chunk at creation with the `(ix,iz)` distance-in-rings from the center at build time (or
  recompute against `targetKeys.has(key)` each `update()`), and hide (not evict) any chunk whose
  key is in `keepKeys` but not `targetKeys`. This keeps the hysteresis benefit (no rebuild churn,
  no batch add/remove thrash, collision data if any stays live) while cutting the extra draws.
  `chunk.mesh.visible` and `b.setVisible(key, false)` already exist as the mechanism
  (`base-game-terrain.js:645-649`); this only changes what `hideRule` tests.
- Expected benefit: fewer `drawIndexed` calls and fewer vertices/triangles submitted at steady
  state (roughly the percentages above, per system/level) with no correctness change — the
  streamer's own definition of "should be visible" already excludes these chunks; only the
  batcher's visibility flag currently disagrees with it.
  Tradeoff: a chunk crossing back from margin into `targetKeys` needs its visibility flipped back
  on (cheap — `setVisible` is a single write, `base-game-terrain.js:647`), and a chunk that
  straddles the batch's frustum-cull assumptions (`frustumCulled=false` on the batch mesh,
  `terrain-chunk-batches.js:51`) must not have its now-hidden geometry counted toward any
  whole-batch bounding logic that assumes visible==relevant — I did not find such a case, but
  didn't exhaustively check every consumer of `batcher.stats`/`chunkCount`.
- Dependencies/overlap: shares `hideRule`/`syncBatchVisibility` with whatever other area covers
  the volumetric/far-LOD visibility rules (same function, different condition) — coordinate
  before editing so the two hide-conditions are OR'd, not replaced. No overlap with draw
  submission internals (Finding 3) or allocation (batch slot budget) beyond "fewer visible
  instances lowers `drawCount`."
- Correctness check: `test-terrain-*.mjs` already exercises target-key coverage and residency
  (per the task brief); a bounded check for this change is a headless test that calls
  `system.update()` at a boundary crossing, reads `system.targetKeys` and the batcher's `isVisible`
  state per key, and asserts every key in `keepKeys - targetKeys` is resident but not visible.
  Performance comparison would need `research/stats/base-game-performance-log.json` (or a new
  capture) to add a drawn-chunk-count column before/after — I could not produce that here.
- Priority/scope: bounded experiment (small, localized change to `hideRule`; verify with the
  headless test above before touching the render path further).

## Finding 3 — draw count model (confirmed accurate, no action)

`terrain-chunk-batches.js:1-8` and `:143-149`'s `drawCount` getter claim WebGPU has no multi-draw
path for `BatchedMesh` and issues one `drawIndexed` per visible instance in a JS loop. Checked
against `WebGPUBackend.js:1600-1628`: `if (object.isBatchedMesh === true)` loops
`for (i = 0; i < drawCount; i++)` calling `passEncoderGPU.drawIndexed(...)` per entry — confirmed,
this is exactly what the comment says. The `drawIndexedIndirect` path a few lines below
(`WebGPUBackend.js:1636-1646`) is a different branch, only reached for non-`BatchedMesh` objects
with an attached indirect buffer; it is not available to this batcher today. No finding, no
action — recorded so the "is GPU-driven multi-draw available" question isn't re-asked by a later
review without re-deriving it.

## Bytes-per-commit (computed, not measured)

`terrain-system.js:81-88` sets `position`(3), `uv`(2), `normal`(3), `color`(3) — 11 floats × 4
bytes = 44 bytes/vertex. At the batcher's documented ~2.3k vertices/chunk
(`terrain-chunk-batches.js:14`) and ~5.5 indices/vertex (`terrain-chunk-batches.js:15`, ~12.6k
indices, 4 bytes each if the index buffer is `Uint32Array`, which `BatchedMesh` requires once
`maxVertexCount` exceeds 65535 — plausible at `indices: 3_600_000` capacity):

- ~101 KB across 4 vertex-attribute `writeBuffer` calls
- ~50 KB in 1 index `writeBuffer` call
- **~150 KB, 5 GPU writes, per chunk commit** (order-of-magnitude estimate from the two files'
  own documented budgets, not a captured number — I did not run a headless test that constructs a
  real chunk and counts bytes, because `terrain-worker.js`'s marching-cubes path needs a
  source/field setup I did not want to fake for an estimate that the comments already state
  directly).
- This is small relative to a frame budget (a 12 MB/s upload bandwidth floor easily clears one
  chunk's ~150 KB), so it does not look like a per-commit bottleneck on its own; it matters mainly
  as a multiplier if Finding 2's extra margin-ring chunks are also being freshly folded (they are
  not freshly *built*, per Finding 2, but they are folded into batches once, same 150 KB one-time
  cost — not a per-frame cost).

## What I could not verify

- No browser or WebGPU device available: Findings 1 and 3's GPU-side behavior are read from the
  installed `three@0.184.0` source, not observed via a captured trace or a `writeBuffer` call
  count.
- `research/stats/base-game-performance-log.json`'s per-frame series does not carry a
  terrain-drawn-chunk-count or terrain-bytes-uploaded column, so Finding 2's chunk-count math
  is arithmetic from the shipped config and residency logic, not cross-checked against a capture.
- Did not run `node test-terrain-*.mjs` — the brief allows running these, but none of the existing
  tests (by name) appear to assert draw/visibility counts specifically, and I did not want to
  claim coverage I hadn't actually read line-by-line; a follow-up should grep the test files for
  `keepKeys`/`hideRule`/`setVisible` coverage before writing the new test in Finding 2's
  correctness check.
- Did not check whether `foldOne`'s `colorizeGeometry` call (`base-game-terrain.js:659`) has its
  own cost for margin-ring chunks beyond the one-time fold — that overlaps the material/colorize
  area, not this one, and I did not want to double count it.
- Compaction frequency in practice (how often `compactWhenUnusedFraction` trips, how many
  geometries typically shift per `optimize()`) is not something I measured; the task brief states
  captures showed 0-1 compactions, which is consistent with Finding 1's ranged-write model being
  cheap enough not to show up, but I did not independently re-derive that number.
