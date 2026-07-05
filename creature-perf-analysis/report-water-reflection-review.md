# Review: Problem 1 (water reflection) claims and fixes

*Report by exploratory review agent (Sonnet), 2026-07-04. Saved by parent session.*

Source doc reviewed: `creature-perf-analysis/render-bottleneck-fixes.md` (Problem 1, lines 27-49, 81-85).
Files checked: `water.js` (1117 lines, full read), `node_modules/three/build/three.webgpu.js` (ReflectorNode/ReflectorBaseNode, lines 36871-37447), `environment-viewer.html` (render loop, ~lines 3640-3705; water wiring ~lines 2892-2933).

## Claim verification

| # | Claim | Verdict | Actual location |
|---|---|---|---|
| 1 | Reflector created via TSL `reflector()` at `water.js:555` | **Confirmed**, exact line match | `water.js:555` — `const tsl_reflector = reflector();` |
| 2 | Reflector's `updateBefore()` runs a full `renderer.render(scene, virtualCamera)` inside its own hook | **Confirmed** | `ReflectorBaseNode.updateBefore()` calls `renderer.render(scene, virtualCamera)` at `three.webgpu.js:37386`. Same `scene` object as the outer render — a second full traversal, not a filtered subset. |
| 3 | App-side wrapper at `water.js:541-570` gates on `reflectionEnabled` and times the call | **Confirmed**, minor line drift | The actual wrapper (`reflectorBase.updateBefore = (frame) => {...}`) is `water.js:560-570`. Lines 541-559 are comments/setup, not the wrapper itself. `reflectionRenderStats.lastMs`/`.passes` update exactly as described. |
| 4 | Reflection created with default options — no downscale, no throttling | **Confirmed** | `reflector()` called with zero arguments at `water.js:555`; `resolutionScale` defaults to `1` (`three.webgpu.js:37041,37069`); no skip logic anywhere. |
| 5 | `setReflectRate()` is a retained no-op | **Confirmed** | `water.js:976-980`. Only sets local `reflectEvery` (`water.js:968,980`), which is never read elsewhere. Inline comment (977-979) admits throttling is deferred. |
| 6 | r184 reflector's canonical option is `resolutionScale`, `resolution` is deprecated alias | **Confirmed, more precise location** | Doc's option lives on `ReflectorBaseNode` (not `ReflectorNode`): default `resolutionScale = 1` at `three.webgpu.js:37041`, assigned `37069`, constructor-arg deprecation shim at `37073-37075`. There's also a separate property-accessor shim (`get`/`set resolution`) at `37413-37427` not cited by the doc — relevant if code ever sets `.resolution` post-construction. |
| 7 | Ripple distortion (`uvNode.add(N.xz...)`) at `water.js:572` | **Confirmed**, exact match | `water.js:572` |

All load-bearing claims hold up; only two supplementary citations have trivial drift (wrapper line span, and the `resolution` accessor-shim line).

## Additional facts

- **No layer/scene-subset mechanism exists anywhere in the codebase.** `grep` for `.layers.`/`camera.layers`/`LayersNode` across all `*.js` returns zero matches. So "exclude grass/particles/creatures via camera.layers" is not an existing capability — it would need to be built: tag objects into a reflection-excluded layer and call `virtualCamera.layers.disable(N)` on each reflection, since `getVirtualCamera()` (`three.webgpu.js:37202-37216`) clones the main camera fresh and wouldn't inherit a persistent mask.
- The reflector's inner render is a plain `renderer.render(scene, virtualCamera)`, so it can also trigger the renderer's shadow-map pass (`three.webgpu.js:44712`, `renderShadow` at `44554`/`44985`) if shadows are due for an update — i.e. it can double shadow cost too, not just base-color draws.
- Confirmed where the reflection actually fires in the frame: `waterRef.update()` (the `'water'` profiler bucket, `environment-viewer.html:3657-3659`) only advances ring LOD/geometry — it does not trigger the GPU render. The reflection render happens as a side effect of TSL node evaluation when the water surface mesh (added to `scene` at `environment-viewer.html:2910`) is traversed inside the `'postRender'` bucket (`environment-viewer.html:3681-3684`, wrapping `postFX.renderAsync()` or `renderer.render(scene, camera)`) — confirming `waterReflectionLastMs` is nested inside `passPostMs`, not a sibling.

## Fix feasibility assessment

1. **`resolutionScale: 0.5` at `water.js:555`** — Low risk, one-line change; the option is real and correctly plumbed via `_updateResolution()` (`three.webgpu.js:37162-37170`). It shrinks GPU fill/target size but does **not** reduce draw-call count or CPU render-list traversal — the same objects are still traversed and encoded. Since the doc's own framing says the bottleneck is CPU-encode-bound (GPU ~4.2ms vs CPU 24.4ms), this fix may recover less than expected unless `waterReflectionLastMs` (a CPU wall-clock measurement) is dominated by GPU-fill-adjacent CPU work.
2. **Skip `renderReflection` every other frame** — Feasible, and safe for texture binding: if the wrapper returns early, `this.textureNode.value` simply isn't reassigned, so the previous render target's texture stays bound (verified in `three.webgpu.js:37356` — only set when the render actually runs). No dangling-texture risk after the first real render. This is the fix most directly proportional to the CPU-encode bottleneck since it literally halves full-scene traversals per second.
3. **Distance/view gating** — Low risk, situational only, as the doc says. Three's own reflector already has a built-in "facing away" bail-out (`three.webgpu.js:37283-37299`) independent of any app change. App-level distance gating is easy via the existing `reflectionEnabled` boolean (`water.js:557`, toggled through `setReflectionTuning()` at `1028-1038`).

**Net read:** all three fixes are implementable without restructuring the reflector. Fix (2) aligns best with the stated CPU bottleneck; fix (1) should be measured in isolation before assuming it alone will move `passPostMs`.

## Inefficiency audit (water.js)

| Finding | Location | Severity | Remedy |
|---|---|---|---|
| Dead no-op `setReflectRate()`/`reflectEvery` | `water.js:968, 976-980` | Low | Wire into the `updateBefore` wrapper (fix 2) or remove the misleading API. |
| `buildGeometry()` appears to be dead code — only `createRingGeometryJob` is used at runtime | `water.js:199-240` | Low | Confirmed via repo-wide grep: no call sites. Safe to delete or mark legacy. |
| Per-lookup string-key allocation in height cache (`` `${cellSize}:${qx},${qz}` ``) | `water.js:282`, called from `317,326-329,352` | Low-medium | Amortized by the existing build budget (`buildBudgetMs`, `water.js:926-928`), so not hot today, but avoidable GC churn — `cellSize` prefix is redundant since each LOD ring already has its own `heightCaches[n]` Map (`water.js:670`). Use an integer-packed key instead. |
| Unbounded height-cache growth over long sessions | `water.js:275-292`, cleared only in `clearHeightCaches()` (`795-801`) on terrain-signature change (`1002-1006`) | Medium | As the camera roams a static map, each LOD `Map` accumulates entries forever — real memory leak over long play sessions. Add an eviction/LRU policy. |
| Excessive quantization precision (`Math.round(x*1000)`) | `water.js:280-281` | Low | Inputs are already grid-aligned to `cellSize` (1/4/16); 1/1000-unit quantization does no useful work, just extra `Math.round`/string cost per sample. |
| `getStats()` allocates a new object per call (`{...stats,...}`) | `water.js:1067-1112` | Low, mitigated | Caller `updateTerrainDebug` throttles to once/250ms (`environment-viewer.html:880-882`), so not actually hot. |
| No O(n²) loops found in `water.js` | — | — | Ring/vertex loops are linear in grid cell count, incrementally budgeted via `processRingQueue()` (`water.js:925-942`). |

No reflection-specific inefficiencies found in `environment-viewer.html` beyond config wiring (`2916-2928`) and throttled stats reads (`993-1019`, `1255-1284`) — no layer/scene-subset logic exists there either.

## Verdict

Problem 1's diagnosis and fix plan are sound. Every code citation checked out (only trivial line-span drift on two supplementary citations). The reflector genuinely does a full, un-throttled, full-resolution scene re-render every frame with no scene-subset mechanism available anywhere in the codebase, and `setReflectRate()` is genuinely dead. All three fixes are implementable without restructuring the reflector, and fix (2)'s frame-skip is provably safe for the bound texture. The one actionable caveat: verify `resolutionScale: 0.5` actually moves `waterReflectionLastMs` before treating it as sufficient on its own — the stated bottleneck is CPU encode time, and downscaling primarily helps GPU fill cost, so fix (2) is the fix most mechanically guaranteed to reduce CPU time.
