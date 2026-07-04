# Review memo: verification of the three perf-findings reports

Reviewer pass, read-only. Every claim below marked "verified" was independently checked
against the working tree and `node_modules/three/build/three.webgpu.js` (r184 build), and
CSV aggregates were recomputed from `research/stats/perf-2026-07-04T18-17-12-291Z.csv`.

## Verdicts

| Report | Verdict |
|---|---|
| `vegetation-draws-findings.md` | **CONFIRMED** (one wrong mechanism, conclusion unaffected; two minor factual slips) |
| `passpost-renderframe-findings.md` | **PARTIALLY CONFIRMED** (core thesis right; one significant factual error about where the water reflection is timed) |
| `base-scene-draws-findings.md` | **CONFIRMED** (strongest report; §3 triangle-counter reasoning is disputed, headline finding stands) |

---

## 1. Vegetation report — CONFIRMED

Verified correct:
- `forestDraws = V*8` and `plantDraws = V` are compile-time constants: `forest-gpu.js:388`
  (`get stats() { return { draws: V * 8, ... } }`), `plants-gpu.js:197` (`draws: V`).
  Wiring verified at `environment-viewer.html:1009,1011`.
- 96 derivation verified: 8 meshes pushed per variant in the `for (let g = 0; g < V; g++)`
  loop at `forest-gpu.js:230-289` (branchesL0/leavesL0/shadowL0/branchesL1/leavesL1/
  branchesL2/coarseLeavesL2/billboardL3); `species: 3` at `environment-viewer.html:1323`;
  `variantsPerSpecies = 4` default at `forest-palette.js:46`, not overridden at the call
  site `environment-viewer.html:1362`. 3×4×8 = 96. ✔
- 16 derivation verified: one mesh per variant (`plants-gpu.js:113-127`); 4 species in
  `PLANT_PRESETS` (`plants.js:55`); `variantsPerSpecies: 4` at `environment-viewer.html:2721`. ✔
- "No `.visible` skip path" verified: grep for `\.visible` across `forest-gpu.js` and
  `plants-gpu.js` returns **zero** hits; meshes are added unconditionally at
  `environment-viewer.html:1370` and `2731`.
- `frustumCulled = false` verified (`forest-gpu.js:206,285`, `plants-gpu.js:123`);
  `geometry.instanceCount = CAP` verified (`forest-gpu.js:203,282`, `plants-gpu.js:120`).
- three.webgpu.js internals verified: `getDrawParameters` returns `null` only when
  `instanceCount === 0` (`three.webgpu.js:29976`); the indexed path unconditionally calls
  `passEncoderGPU.drawIndexedIndirect(...)` whenever `renderObject.getIndirect()` is
  non-null (`three.webgpu.js:~81494`) with no inspection of the GPU-side count; and
  `info.update()` does `this.render.drawCalls++` unconditionally (`three.webgpu.js:~31291`).
- Proposed fix A is viable: `countsArray[g]` is computed per variant in both `rebuild()`
  functions (`forest-gpu.js:312-338`, `plants-gpu.js:142-176`); forest meshes are pushed
  in fixed 8-per-variant order so `meshes[g*8 .. g*8+7]` maps to variant `g`, and plants
  `meshes[g]` maps 1:1. `mesh.visible = countsArray[g] > 0` would remove the objects from
  the render list — **and also from the water reflection pass and the shadow pass**, since
  all three render the same `scene` graph. That triple effect is not called out in the
  report but strengthens the fix.

Errors / corrections:
1. **Wrong mechanism for the never-firing zero-instance early-out.** The report says the
   early-out never fires "since CAP is always > 0". Actually `getDrawParameters` reads
   `geometry.instanceCount` **only when `geometry.isInstancedBufferGeometry === true`**
   (`three.webgpu.js:29967`). The vegetation geometries are plain cloned `BufferGeometry`
   (verified: `isInstancedBufferGeometry` is `undefined` on a `BufferGeometry` clone even
   after setting `.instanceCount`), and `THREE.Mesh` has no `.count`, so the computed
   `instanceCount` is the fallback **1**, not CAP. Same conclusion (the early-out never
   fires; the draw is always submitted), different reason.
2. **CAP values.** The report cites the module defaults (forest 512 at `forest-gpu.js:30`,
   plants 256 at `plants-gpu.js:41`) but the live call sites pass `capPerVariant: 2048`
   (`environment-viewer.html:1367`) and `capPerVariant: 512` (`environment-viewer.html:2728`).
   Cosmetic — the argument only needs CAP > 0.
3. **Consequence missed by all three reports:** because `drawParams.instanceCount` is 1 for
   these indirect meshes, `info.update(object, indexCount, 1)` means the CSV `triangles`
   counter counts each vegetation mesh's full geometry **once, as a constant**, completely
   blind to the GPU-side survivor counts. See §3 of the base-scene review below.

Supporting CSV fact (recomputed): **214/231 rows have `forestInstances == 0` and 197/231
have `plantInstances == 0`** — the empty-variant case the fix targets is the dominant state
in this capture, not an edge case.

---

## 2. passPostMs report — PARTIALLY CONFIRMED

Verified correct:
- The timed block is exactly as quoted (`environment-viewer.html:3668-3671`): with post-fx
  off it is a bare `renderer.render(scene, camera)`; with post-fx on, `postFX.renderAsync()`
  evaluates `pass(scene, camera)` as the first node (`post-fx.js:25-27,71-72`), so the base
  scene render is always inside the `passPostMs` region. **"passPostMs is mislabeled" is
  correct.**
- Shadow maps render nested inside the main render: `ShadowNode.renderShadow` calls
  `renderer.render(scene, shadow.camera)` (`three.webgpu.js:~44567`), fired from node
  `updateBefore` processing during the main render. ✔
- `renderFrameCalls` = `renderer.info.render.frameCalls` (`environment-viewer.html:929`),
  reset once per RAF tick in `Animation.start()` *before* the app's `animate()` runs
  (`three.webgpu.js:~29196`, `renderer.setAnimationLoop(animate)` at
  `environment-viewer.html:3689`). It is a structural pass count. ✔ (Pedantic note: CSV
  values are 15 and 16, not perfectly fixed at 16.)
- GPU-timing conflation verified: `resolveFrameTimestamps` writes the same aggregate RENDER
  timestamp into both `renderTotal` and `postRender` (`environment-viewer.html:3581-3585`).
  Note the CSV has `gpuPostMs`/`gpuRenderMs` = 0 for all rows — timestamps were **off** in
  this capture, so no GPU-side numbers exist to lean on.
- Profiler name/key mapping verified (`frame-profiler.js:13,28`); HUD relabel verified
  (`environment-ui.js:11,801-802`).

**Significant error — the water reflection IS inside `passPostMs`, not `passWaterMs`.**
The report claims (§1, last bullet) that the reflection render-to-texture runs "earlier,
inside the separately-timed `water` block", citing `water.js:557-569` and the tooltip at
`environment-ui.js:43`. That is wrong:

- `waterRef.update(time)` (`water.js:969-975`) only sets `tsl_uTime`, updates the camera
  matrix, checks ring snaps, and drains disposals. It never renders anything.
- The reflection render lives in `reflectorBase.updateBefore` (`water.js:559-570` wraps it;
  the original does `renderer.render(scene, virtualCamera)` at `three.webgpu.js:~37386`).
  `updateBefore` is a node hook with `updateBeforeType = NodeUpdateType.RENDER` (bounces
  defaults `true`, `three.webgpu.js:37118`), invoked by the node frame **during the main
  scene render** — i.e. inside the `postRender` timed block at
  `environment-viewer.html:3668-3671`.
- The CSV proves it: `passWaterMs` averages **0.72 ms** while `waterReflectionLastMs`
  (measured around the actual reflection render, `water.js:566-569`) averages **7.79 ms**.
  A 7.79 ms sub-step cannot live inside a 0.72 ms block. It lives inside `passPostMs`
  (avg 17.56 ms).
- The tooltip at `environment-ui.js:43` ("Reflection and caustics are timed in the Water
  stage, not Render submit") is itself factually wrong and should be fixed — the report
  treated in-code prose as evidence.

Consequence: the report's bottom line ("dominant cost is base scene render + shadow maps")
under-attributes. `passPostMs` = main color pass + nested shadow pass(es) + **full-scene
water reflection pass** + post chain, and the reflection alone is ~44% of the average.

---

## 3. Base-scene report — CONFIRMED (headline), §3 mechanism DISPUTED

Verified correct:
- **CSV table recomputed and matches exactly** (231 samples, 17 expensive rows at
  `passPostMs >= 25`; renderDrawCalls 382.6/363.0/364.5; triangles 1,407,479/1,359,174;
  creatureShadows 4.94/2.99; forestInstances 71.5/18.5; plantInstances 254.6/65.7;
  forest/plant/terrain draws constant at 96/16/25; postMode 'on' every row).
- **Water reflector claims all verified**: `water.js:555` calls `reflector()` with no
  parameters → `resolutionScale = 1` default (`three.webgpu.js:37041`) and `bounces = true`
  → `updateBeforeType = RENDER` (`three.webgpu.js:37118`); `updateBefore` hides only the
  water material (`material.visible = false`) then re-renders the **entire scene** from the
  mirrored camera (`renderer.render(scene, virtualCamera)`, `three.webgpu.js:~37386`).
  Pass rate verified: `waterReflectionPasses` 6,235 → 16,376 over t = 0 → 232.81 s
  = **43.6 passes/s** ≈ frame rate. One full-scene, full-resolution re-render per frame. ✔
- **Creature shadows verified**: default instancing mode `'parts'`
  (`port-creature-system.js:4`), `creatureBatches` truthy (`port-creature-system.js:923-925`),
  so each in-range creature adds exactly 1 to `shadowCasters`
  (`port-creature-system.js:4739-4741`); the only `castShadow = true` bucket is the single
  shared `shadowBox` `InstancedMesh` (`port-creature-system.js:835-837,847-849`), with
  `colorWrite = false`. `creatureInstancedShadows == creatureShadows` in **all 231 rows**
  (verified). Creature shadow cost is one instanced 12-tri-box draw — correctly dismissed
  as a symptom, not a cause. ✔
- Draw decomposition inputs verified: terrain `chunkSize: 30`, `renderRadius: 2`
  (`terrain-system.js:14-16`) → 25 chunks; forest shadow casters are 4 of 8 mesh types per
  variant (castShadow flags at `forest-gpu.js:273-279`: branchesL0, shadowL0, branchesL1,
  branchesL2 = true) → 48; plants `castShadow = false` (`plants-gpu.js:124`). The
  ≈ 151 + 149 + 49 ≈ 349 decomposition is arithmetically sound against the observed ~364.

Overstatements / disputes:
1. **"Unconditionally" re-renders**: the reflection is gated by `reflectionEnabled`
   (`water.js:557,560-565`, requires `reflectMix > 0 && reflectBrightness > 0`) — there is
   a kill switch, it just was on for the whole capture. The report's real point (no
   distance/visibility/resolution/frequency gating) is correct.
2. **§3 triangle attribution mechanism is wrong.** The report claims the CSV `triangles`
   metric scales with the GPU-side indirect survivor counts ("the GPU-side indirect-draw
   instance counts … are what's actually scaling triangle throughput"). It cannot:
   `info.update(object, indexCount, instanceCount)` receives the CPU-side
   `drawParams.instanceCount`, which for these plain-`BufferGeometry` indirect meshes is
   **1** (see vegetation review, correction 1) — the counter never sees the indirect
   buffer. Vegetation's contribution to the CSV `triangles` number is therefore a large
   **constant** (each variant geometry counted once per pass it appears in), and the
   *varying* ±48K between normal/expensive frames must come from non-indirect draws —
   primarily the creature `InstancedMesh` buckets, whose `mesh.count` varies per frame
   (`port-creature-system.js:902-908`). The physical conclusion ("vegetation dominates real
   GPU triangles when instances are dense") is plausible but is **not established by this
   counter**; it would need GPU timestamps or a survivor-count readback.

---

## Reconciling the reports — what actually moves `passPostMs`

The vegetation report (112 empty indirect draws) and the base-scene report (~149-draw
reflection pass) are not competing explanations; they compound:

- The reflection pass re-renders the same scene, so the 112 empty vegetation draws are
  encoded **twice** per frame (plus 48 forest meshes a third time in the shadow pass).
- The reflection pass is *measured* at avg **7.79 ms** (`waterReflectionLastMs`) out of avg
  `passPostMs` **17.56 ms** — ~44% of the average frame's render-submit cost, and it is
  inside `passPostMs` (see report-2 correction). That is direct measurement, not estimate.
- The empty-draw overhead is *estimated* (per-draw CPU encode, ~10-30 µs/draw): 112 draws
  × 2 passes + 48 shadow draws ≈ 270 encodes ≈ **~2-5 ms** in fully-empty regions —
  material given 214/231 rows had zero forest instances, but smaller than the reflection.

**Unexplained residual worth flagging:** on expensive frames `passPostMs` rises +11.8 ms
(16.69 → 28.51) while `waterReflectionLastMs` rises only +1.2 ms (7.71 → 8.89). The spike
delta is therefore NOT the reflection baseline; it coincides with nonzero vegetation and
more LOD0 creatures. Since CPU encode cost does not scale with *instance* counts,
candidates none of the reports examined: (a) vegetation `rebuild()` buffer re-uploads on
chunk-change frames (`srcAttr` is 12×2048×8 floats ≈ 786 KB for forest,
`srcAttr.needsUpdate = true` at `forest-gpu.js:335`); (b) pipeline/bind-group creation when
variant materials first become populated; (c) the creature batches upload their full
8192-capacity `instanceMatrix` (8 buckets × 8192 × 64 B ≈ 4.2 MB) every frame —
`needsUpdate = true` unconditionally in `endFrame()` (`port-creature-system.js:902-908`)
with no update-range narrowing; (d) GPU backpressure on submit. Needs a capture with
`TIMESTAMP_MODE = 'on'` (the CSV's `gpuPostMs`/`gpuRenderMs` are all 0 — timestamps were
off) to separate CPU encode from GPU stall.

## Ranked fixes by expected impact on `passPostMs`

1. **Mitigate the water planar reflection pass** (biggest, directly measured: 7.79 ms avg,
   ~44% of `passPostMs`). Options in ascending invasiveness: pass `resolutionScale`
   (e.g. 0.25-0.5) to `reflector()` at `water.js:555`; throttle via `updateBeforeType`
   manipulation (the hook wrapper at `water.js:559-570` is already the right seam, and
   `setReflectRate` at `water.js:976-981` is an existing no-op API waiting for exactly
   this); exclude expensive layers (vegetation, creatures) from the mirrored render via
   camera layers; disable when the water surface is off-screen or distant. Even halving it
   is ~4 ms off the average frame.
2. **`mesh.visible = countsArray[g] > 0` for empty vegetation variants** (est. ~2-5 ms in
   empty regions, which were 85-93% of this capture). Cheap, data already computed in both
   `rebuild()` functions; also shrinks the reflection and shadow passes automatically.
   Correct as specified in the vegetation report §4A.
3. **Narrow creature `instanceMatrix` uploads** (unquantified, potentially ~1-2 ms): upload
   only `count` instances per bucket instead of full 8192 capacity every frame
   (`port-creature-system.js:902-908`). Missed by all three reports.
4. **Fix instrumentation, no direct perf gain but prevents the next misdiagnosis**: rename
   or split `passPostMs` (time `renderer.render` vs post chain separately), correct the
   wrong tooltip at `environment-ui.js:43`, and surface `waterReflectionLastMs` in the HUD
   next to Render submit. Enable `TIMESTAMP_MODE='on'` for the next capture.
5. **Do NOT spend time on creature shadows or the bloom/grade chain** — the former is one
   instanced draw of 12-tri boxes (verified), and the latter defaults to a visual no-op
   (`bloomStrength ?? 0.0`, `post-fx.js:29`) stacked on the same submit.

## What the agents missed / next steps

- The `triangles` CSV counter is blind to indirect instance counts (constant for all 112
  vegetation meshes) — worth documenting so nobody tunes against it.
- The full-capacity per-frame creature `instanceMatrix` upload (item 3 above).
- The +11.8 ms expensive-frame residual is unexplained by any report; needs a
  timestamps-on capture and ideally a marker on `rebuild()` frames to test the
  buffer-upload hypothesis.
- Verify whether the reflection pass also triggers nested shadow-map re-renders per frame
  (would inflate its cost further); `renderFrameCalls` = 15-16 gives the structural budget
  to decompose.
