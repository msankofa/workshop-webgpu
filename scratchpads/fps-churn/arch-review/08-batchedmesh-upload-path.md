# BatchedMesh upload path on the loaded WebGPU build (r0.184)

Build inspected: `node_modules/three/build/three.webgpu.js` (83,969 lines) and
`node_modules/three/build/three.core.js` (59,732 lines) — `BatchedMesh` itself lives in
`three.core.js` and is re-exported from `three.webgpu.js:7`. Line numbers below are from these
two files as installed, which is the same code the CDN build for r0.184 ships (core class is
backend-independent). No `src/` files were cited.

## Finding 1 — `optimize()` DOES call `addUpdateRange`. The prior report was right; the reviewer looked in the wrong place.

**Classification: measured (Node).**

`three.core.js:26574-26663` is `BatchedMesh.optimize()`. It calls `index.addUpdateRange(nextIndexStart, reservedIndexCount)` at **line 26622** and `attribute.addUpdateRange(nextVertexStart * itemSize, reservedVertexCount * itemSize)` at **line 26643**, immediately followed by `needsUpdate = true` at 26623/26644 in both branches. This is unconditional — every geometry that has to move during a compaction gets its own ranged mark, not a blanket rewrite call.

I constructed a `BatchedMesh` in bare Node (`three.core.js` has no DOM dependency for this path) and measured it directly:

```
4 geometries added (100 verts / 200 idx each, reserved) -> pos ranges=4, idx ranges=4 (one range per addGeometry, as expected from setGeometryAt)
delete geometry[0]; optimize() -> pos ranges: [{start:0,count:300},{start:300,count:300},{start:600,count:300}]
                                   idx ranges: [{start:0,count:200},{start:200,count:200},{start:400,count:200}]
delete geometry[3] (last); optimize() -> pos ranges: []
```
Setup: `scratchpads/fps-churn/arch-review/_bm-probe.mjs` (deleted after the run; reproduce from the block above — `import * as THREE from '.../three.core.js'`, build a `BufferGeometry` with a `position` attribute and `Uint32Array` index, `addGeometry` 4x with explicit reserved counts, clear ranges, delete one, call `optimize()`, inspect `attribute.updateRanges`).

So: deleting the *first* geometry and compacting produces **one `addUpdateRange` call per geometry that shifted** (3 ranges, each sized to that geometry's reserved space) — not a single whole-buffer range, and not zero. Deleting the *last* geometry and compacting produces **zero ranges** — nothing had to move, `optimize()` is a no-op write-wise for that case. The previous report's "finding 1" (that `optimize()` uses ranged writes) is correct. The reviewer who couldn't find `addUpdateRange` in `optimize()` most likely grepped `three.module.js`/`three.webgpu.js` for `BatchedMesh`, which doesn't define the class at all (see below) — the class lives only in `three.core.js`, re-exported.

## Finding 2 — how ranges reach the GPU: `WebGPUAttributeUtils.updateAttribute`, `three.webgpu.js:77684-77765`

**Classification: code-supported (read directly; also matches Finding 1's Node output going into a fresh test of `Attributes.update`).**

- `Attributes.update` (`three.webgpu.js:30695-30736`) only calls `backend.updateAttribute(attribute)` when `data.version < bufferAttribute.version` (or the attribute is `DynamicDrawUsage`). `needsUpdate = true` bumps `version` (`three.core.js` BufferAttribute setter, ~16820). So a geometry op that never sets `needsUpdate` never reaches the backend at all, regardless of `updateRanges` content.
- Inside `WebGPUAttributeUtils.updateAttribute` (`three.webgpu.js:77684`):
  - `updateRanges.length === 0` (**line 77714**) → **one `device.queue.writeBuffer(buffer, 0, array, 0)`** — the *entire* backing array, offset 0, no size argument (whole buffer).
  - `updateRanges.length > 0` (**line 77725**) → loops the ranges (**77730**), computing byte offset/size per range and issuing **one `device.queue.writeBuffer(buffer, bufferOffset, array, dataOffset, size)` per range** (**77751**). No coalescing of adjacent/overlapping ranges.
  - `bufferAttribute.clearUpdateRanges()` is called once at the end of the ranged branch (**line 77761**) — ranges are cleared only after a successful upload, not eagerly, so ranges pushed between frames without a render pass accumulate correctly (checked in Finding 1's probe: ranges only clear when I called `clearUpdateRanges()` myself).
  - No resize/usage-driven full-buffer fallback exists in this function; a buffer resize is a separate code path (`createAttribute`/backend buffer allocation), not visible from `updateAttribute`.

This settles item 2 of the task precisely as asked: 0 ranges = whole-buffer write, >0 ranges = one `writeBuffer` per range, no coalescing, ranges cleared post-upload.

## Finding 3 — `setMatrixAt`/`setColorAt`/`setVisibleAt`/`onBeforeRender`'s per-frame texture and JS cost

**Classification: code-supported.**

- `setMatrixAt` (`three.core.js:26770-26781`) writes into `_matricesTexture.image.data` (a `Float32Array` sized `size*size*4`, `size = ceil(sqrt(maxInstanceCount*4)/4)*4`, see `_initMatricesTexture` **26030-26048**) and sets `matricesTexture.needsUpdate = true` — a **whole-texture** dirty flag; `Texture` has an `addUpdateRange` too (`three.core.js:7651`) but `BatchedMesh` never calls it for the matrices/colors/indirect textures. There is no ranged-texture-upload path exercised here.
- `setColorAt` (26804-26819) and `setVisibleAt` (26858-26873) behave the same way for the colors texture; `setVisibleAt` only flips `_visibilityChanged`, no texture touch.
- `onBeforeRender` (`three.core.js:27214-27368`) is the actual per-frame hot path. It early-outs (**line 27218**) only when `! this._visibilityChanged && ! perObjectFrustumCulled && ! sortObjects`. `terrain-chunk-batches.js` sets `sortObjects = false` and defaults `perObjectFrustumCulled = false` (config default, line ~19-21), so a quiet frame (no adds/removes/visibility flips) does early-out — confirmed independently by `test-terrain-chunk-batches.mjs`'s passing case "quiet frame: onBeforeRender early-outs, no per-instance cull loop".
- When it does NOT early out (any visibility change, or `sortObjects`/`perObjectFrustumCulled` true), it iterates **every instance** (`instanceInfo.length`, active or not) calling `getMatrixAt` + `getBoundingSphereAt` + a frustum test per instance if culling is on, or just a sort-key computation if `sortObjects` is on (**27273-27362**). This is pure JS, O(instances), once per camera per pass (main pass + each shadow pass via `onBeforeShadow` at 27370-27373, which forwards into the same function). With `perObjectFrustumCulled: true` (the non-default opt-in) this cost recurs on every frame regardless of visibility change, because... no — actually the early-out is gated on `_visibilityChanged` too, so if `perObjectFrustumCulled` is true the object exits early only when *neither* culling nor sorting is wanted; with `perObjectFrustumCulled: true` the early-out condition (`!perObjectFrustumCulled`) is false, so it **runs every frame** unconditionally, once per camera/pass. That is a real, unavoidable per-instance JS cost while that flag is on — exactly what the config comment at `terrain-chunk-batches.js:19-21` describes.
- Regardless of branch taken, `indirectTexture.needsUpdate = true` is set unconditionally whenever `onBeforeRender` doesn't early-out (**line 27364**), which forces one whole-texture `writeBuffer`-equivalent GPU upload of the indirect texture (see Finding 4) every such frame — sized `ceil(sqrt(maxInstanceCount))²` `Uint32`s, i.e. 256 slots → 16×16×4 bytes ≈ 1KB. Small in bytes, but it's a distinct upload the terrain code doesn't currently count.

## Finding 4 — WebGPU draw path for `BatchedMesh`: one `drawIndexed` per visible instance in a JS loop, confirmed; no indirect/multi-draw path on this backend

**Classification: code-supported (directly read; matches `terrain-chunk-batches.js`'s own header claim).**

`three.webgpu.js:81451-81479` (inside the WebGPU `RenderPipeline`/backend's draw routine — the surrounding function sets bind groups/vertex+index buffers just above, 81400-81441):

```
if ( object.isBatchedMesh === true ) {
  ...
  for ( let i = 0; i < drawCount; i ++ ) {
    if ( hasIndex === true ) {
      passEncoderGPU.drawIndexed( counts[ i ], 1, starts[ i ] / bytesPerElement, 0, i );
    } else {
      passEncoderGPU.draw( counts[ i ], 1, starts[ i ], i );
    }
    info.update( object, counts[ i ], 1 );
  }
}
```
One `drawIndexed`/`draw` call per visible instance (`drawCount` = `_multiDrawCount`, computed by `onBeforeRender`), each with `instanceCount = 1` and `firstInstance = i` (used to index the per-draw-id uniform/texture row, not real GPU instancing). There is **no** `drawIndexedIndirect`/multi-draw path for `BatchedMesh` on this WebGPU backend build — the indirect path that exists in this file (`renderObject.getIndirect()`, ~81485-81498) is a different, non-batched code path guarded by `else if (hasIndex === true)`, never reached when `object.isBatchedMesh === true`. (The WebGL fallback backend, `three.webgpu.js:70279-70316`, does have a `renderMultiDraw` branch gated on the `WEBGL_multi_draw` extension — that is WebGL-only and not relevant to the WebGPU code path the page actually uses.)

This matches `terrain-chunk-batches.js:2-3`'s header claim verbatim: "On the WebGPU backend this does NOT reduce draw calls... no multi-draw path exists in WebGPU." **That comment is accurate.**

## Finding 5 — mapping onto `terrain-chunk-batches.js` (~150 lines, read in full) and the header/config comments

**Classification: code-supported + one measured correction.**

- Header (`terrain-chunk-batches.js:1-8`): accurate per Finding 4. What a batch buys is fewer scene objects/pipeline+bind-group sets, not fewer draw calls, on this backend.
- `perObjectFrustumCulled: false` comment (`:19-21`, "off: onBeforeRender early-outs... instead of a per-instance sphere/frustum loop"): accurate per Finding 3 and confirmed by the existing passing test `test-terrain-chunk-batches.mjs` ("quiet frame: onBeforeRender early-outs, no per-instance cull loop").
- `maxCompactionsPerFrame: 0` comment (`:18`, "optimize() rewrites the whole buffer") and the `compact()` comment (`:32-33`, "optimize() rewrites every vertex and index in the batch and re-uploads it"): **imprecise, not wrong in the worst case.** Per Finding 1's measurement, `optimize()` only touches geometries whose `vertexStart` actually moved — deleting and compacting the *last* geometry in a batch produces zero ranges and no upload at all; deleting geometry 0 (worst case) does end up touching every geometry after it, which for a batch that's mostly full is effectively the whole buffer, and it's the worst case a chunk-streaming batch (delete-from-anywhere, mostly full) will hit often. So the comment describes the worst case correctly but overstates the typical case — a batch with only trailing entries deleted compacts for free. This is worth a one-line correction in the comment (say "worst case: shifts every geometry after the earliest gap") but not a functional bug.
- Per-ordinary-chunk-add bytes: `terrain-chunk-batches.js` defaults `vertices: 600_000`, and a chunk is "~2.3k [vertices] per chunk" per the same comment (`:13`). `setGeometryAt` (`three.core.js:26439-26462`) marks ranges per-attribute at `[vertexStart*itemSize, reservedVertexCount*itemSize]`; for a heightfield chunk with `position`(12B/vert) + `normal`(12B/vert) + `uv`(8B/vert) that's roughly `2300 * 32 bytes ≈ 73.6 KB` of vertex data plus the index range (`~5.5 indices/vertex` per the defaults comment, so `2300*5.5*4 bytes ≈ 50.6 KB` for a `Uint32` index) — **≈124 KB of `writeBuffer` calls per ordinary chunk add**, as several separate ranged writes (one per vertex attribute + one for the index), not one call.
- `optimize()` cost: per Finding 1, this is *not* "all geometries" unconditionally — it's every geometry from the earliest active gap onward. For a batch near its `compactWhenUnusedFraction` threshold (0.35 of `vertices` dead) the worst case is close to a full-buffer rewrite; the best case (only trailing chunks evicted) is free. The code's `maxCompactionsPerFrame: 0` / ration comments already treat it as "unlimited but rationed if configured," so the practical behavior (opt-in throttling) is unaffected by this precision gap — only the comment wording is loose.

## What I could not verify
- I did not load the full `three.webgpu.js` `WebGPUBackend` in Node (it needs a real `GPUDevice`/`navigator.gpu`), so Findings 2-4's exact runtime call sequence (`Attributes.update` → `backend.updateAttribute` → `WebGPUAttributeUtils.updateAttribute`) is read, not executed end-to-end; only the pure-JS `BatchedMesh`/`BufferAttribute` layer (Finding 1) was actually run.
- I did not measure real terrain-chunk vertex/attribute layout from `terrain-source-v5.js`/`terrain-worker.js` — the "12B/12B/8B" attribute-byte estimate in Finding 5 is inferred from the "~2.3k per chunk" and "~5.5 indices/vertex" comments already in the file, not from reading the actual chunk-mesh generator, so treat the 124 KB/chunk figure as an estimate, not a measurement.
- I did not run in a browser or capture a real WebGPU trace; everything here is static-code-plus-Node-microbenchmark evidence, no live GPU timings.

## Exactly what I inspected
- `node_modules/three/build/three.webgpu.js` — lines 7, 30638-30736 (`Attributes`), 30915-31031 (`Geometries.updateForRender`/`updateAttributes`), 33741-33900 (`Textures.updateTexture`), 70268-70316 (WebGL fallback `_draw`, for contrast only), 73408-73477 (`WebGPUTextureUtils.updateTexture`), 77574-77765 (`WebGPUAttributeUtils.updateAttribute`), 81400-81499 (WebGPU backend draw / `BatchedMesh` branch).
- `node_modules/three/build/three.core.js` — lines 7645-7664 (`Texture.addUpdateRange`), 16847-16862 (`BufferAttribute.addUpdateRange`), 25878-26030 (constructor), 26030-26074 (texture inits), 26076-26320 (`_initializeGeometry`/`_validateGeometry`/id validators), 26322-26663 (`addGeometry`/`setGeometryAt`/`deleteGeometry`/`deleteInstance`/`optimize`), 26770-26887 (`setMatrixAt`/`setColorAt`/`setVisibleAt`), 27214-27373 (`onBeforeRender`/`onBeforeShadow`).
- `terrain-chunk-batches.js` — full file (150 lines).
- Ran `node test-terrain-chunk-batches.mjs` (existing suite, all pass, used as corroboration for the early-out and draw-count claims).
- Wrote and ran a throwaway Node probe (`scratchpads/fps-churn/arch-review/_bm-probe.mjs`, deleted after use) importing `three.core.js` directly to construct a `BatchedMesh`, add/delete geometries, call `optimize()`, and inspect `updateRanges` on the resulting attributes — output reproduced verbatim in Finding 1.
