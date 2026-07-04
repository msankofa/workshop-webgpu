# Findings: what `passPostMs` and `renderFrameCalls` actually measure

Investigation scope: read-only. No code was changed. All claims cite file:line.

## Summary

- **`passPostMs` is mislabeled.** The timed region named `postRender` wraps the *entire*
  main scene render (including automatic shadow-map sub-passes for every shadow-casting
  object), not just bloom/tonemap/grade post-processing. Post-processing is only ever an
  *addition* on top of the same timed region — it is never rendered separately from the
  base scene draw.
- **`renderFrameCalls` is a pass-count, not a load metric.** It is `renderer.info.render.frameCalls`,
  which counts how many times three.js's internal `render()` method was invoked during the
  whole animation-frame callback (shadow passes + water reflection + main pass + any
  post-processing sub-passes) — reset to 0 once per `requestAnimationFrame` tick, *before*
  `animate()` runs. It does not count draw calls or triangles, so it stays constant (16) as
  long as the same set of lights/passes fire each frame, even though the number of objects
  drawn *inside* each pass (forest/plant/creature instance counts, `drawCalls`, `triangles`)
  varies a lot.
- Conclusion: the dominant cost the CSV attributes to "post" (`passPostMs` avg 17.56ms, p95
  26ms) is overwhelmingly the **base scene render + shadow maps**, correlating with forest/plant
  instance counts and creature shadow casters — not the bloom/grade/tonemap chain, which is a
  cheap addition on top of the same timed block.

---

## 1. How is `passPostMs` measured?

`frame-profiler.js` defines the name→CSV-key mapping:

```
frame-profiler.js:13   'postRender',                 // DEFAULT_NAMES entry
frame-profiler.js:28   postRender: 'passPostMs',      // DEFAULT_PREFIXES
```

The timed region itself, in the render loop (`environment-viewer.html`):

```
3667   // SP4c: composite through the post stack when enabled, else plain render.
3668   await frameProfiler.timeAsync('postRender', async () => {
3669     if (postFX && postFX.enabled) await postFX.renderAsync();
3670     else renderer.render(scene, camera);
3671   });
```

This is the crux: even when post-processing is **completely disabled**
(`postFX.enabled === false`), the exact same `passPostMs`-timed block still executes
`renderer.render(scene, camera)` — the full base-scene draw. The "post" name only describes
what gets bolted on top when `postFX.enabled` is true; the region is never *just* post-fx.

When post-fx *is* enabled, `postFX.renderAsync()` runs three's `PostProcessing.renderAsync()`
graph, whose first node is the scene pass itself:

```
post-fx.js:25   const pp = new PostProcessing(renderer);
post-fx.js:26   const scenePass = pass(scene, camera);
post-fx.js:27   const scenePassColor = scenePass.getTextureNode();
...
post-fx.js:71   const hdr = scenePassColor.add(bloomPass);
post-fx.js:72   pp.outputNode = gradeNode(renderOutput(hdr));
```

`pass(scene, camera)` is three.js's lazy scene-render node: it is evaluated (i.e. the base
scene is actually drawn) *inside* `pp.renderAsync()`, not before it. So whether or not
post-fx is on, the `passPostMs` timed block always contains the full base-scene render;
bloom/grade/tonemap are extra work stacked on the same call when enabled. This matches
`docs/subsystems/fx.md:22`, which already describes the pipeline as
"scene pass → bloom → tone mapping → inline color grade → output" — the scene pass is the
first stage of the very thing being timed as "post".

First-party corroboration — the perf HUD itself already flags this ambiguity by
relabeling the row depending on mode, while keeping the same underlying stat key
(`passPostMs`):

```
environment-ui.js:11    ['postRender', 'Render submit', 'passPostMs'],
environment-ui.js:801-802
    if (id === 'postRender') {
      row.querySelector('span').textContent = snapshot.postMode === 'off' ? 'Render submit' : 'Render + post';
    }
```

i.e. the developers already knew this stage is "Render submit" (base draw) at minimum, and
"Render + post" only when post-fx adds work on top of that same submit.

Additionally, **shadow-map rendering for every shadow-casting object happens inside this
same timed block**, as an automatic side effect of three.js's node-graph evaluation of
`renderer.render(scene, camera)`. Three's `ShadowNode.updateBefore()` runs during the main
render call and issues a nested `renderer.render(scene, shadow.camera)` per shadow-casting
light:

```
node_modules/three/build/three.webgpu.js:44554-44571   renderShadow(frame) { ... renderer.render( scene, shadow.camera ); ... }
node_modules/three/build/three.webgpu.js:44708-44736   updateBefore(frame) { ... this.updateShadow(frame); ... }  // invoked nested inside the main render
```

This directly explains the correlation in the CSV between high `passPostMs` samples and
`creatureShadows` (4.9 vs 2.8 shadow casters): more shadow-casting creatures means more
per-object shadow-map draw work nested inside the exact region being timed as "post".
`creatureShadows` itself is `cs.shadowCasters` from the creature system:

```
environment-viewer.html:963   creatureShadows: cs.shadowCasters,
```

Water's own reflection/refraction render-to-texture pass is *not* part of `passPostMs` — it
runs earlier, inside the separately-timed `water` block (`passWaterMs`):

```
environment-viewer.html:3644-3646   frameProfiler.time('water', () => { if (waterRef) { waterRef.update(now / 1000); } });
water.js:557-569                    reflectionEnabled ... reflectionRenderStats.passes++ ...
environment-ui.js:43                'Reflection and caustics are timed in the Water stage, not Render submit.'
```

## 2. What is `renderFrameCalls`, and why is it fixed at 16?

```
environment-viewer.html:929   renderFrameCalls: r?.render?.frameCalls ?? 0,
```
where `r = renderer.info` (`environment-viewer.html:917`).

`render.frameCalls` is a three.js WebGPURenderer internal counter, documented and
implemented in the bundled build:

```
node_modules/three/build/three.webgpu.js:31196-31207
  * @property {number} frameCalls - The number of render calls of the current frame.
  this.render = { calls: 0, frameCalls: 0, drawCalls: 0, triangles: 0, points: 0, ... };

node_modules/three/build/three.webgpu.js:31320-31324   reset() { this.render.drawCalls = 0; this.render.frameCalls = 0; this.compute.frameCalls = 0; ... }

node_modules/three/build/three.webgpu.js:59260-59264
  this.info.calls ++;
  this.info.render.calls ++;
  this.info.render.frameCalls ++;      // incremented on every internal render() invocation
```

Critically, the reset happens **once per `requestAnimationFrame` tick, before the app's own
animate callback runs at all** — not once per `passPostMs` block:

```
node_modules/three/build/three.webgpu.js:29190-29204
  start() {
    const update = ( time, xrFrame ) => {
      this._requestId = this._context.requestAnimationFrame( update );
      if ( this.info.autoReset === true ) this.info.reset();   // <-- reset here
      this.nodes.nodeFrame.update();
      ...
      if ( this._animationLoop !== null ) this._animationLoop( time, xrFrame );  // <-- our animate()
```

`this._animationLoop` is exactly the callback registered via:

```
environment-viewer.html:3689   renderer.setAnimationLoop(animate);
```

So `renderFrameCalls` is a **count of every internal `render()` invocation across the whole
`animate()` frame** — shadow-map passes (one per shadow-casting light, `three.webgpu.js:44567`),
the water reflection pass (`water.js`), the main scene pass, and any post-processing
sub-passes — not scoped to the post block alone, and not a count of draw calls or GPU
render targets in the "post chain" specifically.

It stays pinned at **16** because it counts *how many times render() was invoked* (a
function of which lights/passes are structurally active this session — same directional
light shadow, same water reflection toggle, same bloom mip-chain node graph), not *how much
work* happened inside each invocation. Forest/plant/creature instance counts, triangles, and
draw calls change per frame (these are tracked by the separate `drawCalls`/`triangles`
counters, also reset every frame in `Info.reset()` above and read at
`environment-viewer.html:930,933`), but the number of distinct render() calls does not
change unless a light/pass is added or removed. That is exactly why `renderFrameCalls`
shows zero variance in the high-vs-normal `passPostMs` comparison while `drawCalls`,
`triangles`, `forestInstances`, `plantInstances`, and `creatureShadows` all shift.

## 3. How are the WebGPU timings captured?

Both CPU wall-clock and (optionally) GPU timestamp queries are used, for different columns:

- **CPU wall-clock** (`passPostMs`, and all other `passXMs` columns) — `frame-profiler.js:67-83`
  (`time`/`timeAsync`) simply does `now() - t0` around the awaited block, where
  `now = performance.now` by default (`frame-profiler.js:47`). For `timeAsync('postRender', …)`
  this measures CPU time to encode + submit the command buffer(s) for the whole
  render — it returns before the GPU has actually finished the work
  (confirmed in-code: `environment-viewer.html:3676-3677`, "CPU frame time = sim + scene
  update + command encoding/submit (render() returns before the GPU finishes)").
- **GPU timestamp queries** (`gpuPostMs`, `gpuRenderMs`, `gpuComputeMs`) — only when
  `TIMESTAMP_MODE === 'on'`, via `renderer.resolveTimestampsAsync(...)`:

  ```
  environment-viewer.html:3571-3589
  async function resolveFrameTimestamps() {
    if (TIMESTAMP_MODE !== 'on') return;
    ...
    const renderMs = await renderer.resolveTimestampsAsync(THREE.TimestampQuery?.RENDER || 'render');
    if (Number.isFinite(renderMs)) {
      frameProfiler.recordGpu('renderTotal', renderMs);
      frameProfiler.recordGpu('postRender', renderMs);   // <-- same GPU total is stored as "postRender"
    }
  }
  ```

  Note `recordGpu('postRender', renderMs)` writes the **same** aggregate GPU `RENDER`
  timestamp (which covers *all* render-type GPU work for the frame: shadow maps + main +
  post, as one pipeline timestamp query scope, not a scoped "post-only" query) into both
  `gpuRenderMs` and `gpuPostMs`. So on the GPU-timing side too, "post" is really "all render
  work," by construction — there is no separate GPU timestamp scope isolating bloom/grade
  from the base draw.

- **Is `passPostMs` misattributing async/deferred GPU work?** Not exactly "misattributed to
  the wrong CPU region" — `passPostMs` (CPU) is honestly timing the CPU cost of encoding and
  submitting the full render (including nested shadow-map submits), which does scale with
  scene complexity (more objects → more command encoding, not just "waiting"). The
  mislabeling is about *scope* (it includes the base scene + shadows, not just bloom/tonemap/
  grade), not about attributing GPU-async wait time to the wrong place. `renderer.info` (used
  for `renderFrameCalls`/`drawCalls`/`triangles`) is a plain synchronous CPU-side counter
  incremented as render calls are issued — not a GPU query at all — so it's not subject to
  async misattribution either.

## 4. Per-frame passes enumerated (environment-viewer.html:3590-3683, `animate()`)

| Order | Code region | Profiler name → CSV key | What it does | Render/compute call? |
|---|---|---|---|---|
| 1 | `3603-3615` | `sky` → `passSkyMs` | Sky/moonlight direction update, camera-follow | CPU only |
| 2 | `3616-3641` | `terrainWindow` → `passTerrainWindowMs` | Clouds position, FPS controls, terrain streaming window, multiplayer sync | CPU only |
| 3 | `3642` | `creatures` → `passCreaturesMs` | `portCreatures.update(rawDt)` — creature sim/IK/skinning | CPU only |
| 4 | `3644-3646` | `water` → `passWaterMs` | `waterRef.update()` — includes reflection/refraction render-to-texture pass | render (own RT) |
| 5 | `3647` | `hud` → `passHudMs` | Debug text update | CPU only |
| 6 | `3650` | `grassGpu` → `passGrassMs`/`gpuGrassMs` | Grass GPU compute cull/generate | compute |
| 7 | `3652` | `forestGpu` → `passForestMs`/`gpuForestMs` | Forest GPU cull→indirect | compute |
| 8 | `3653` | `plantsGpu` → `passPlantsMs`/`gpuPlantsMs` | Plants GPU cull→indirect | compute |
| 9 | `3656` | `cdlodGpu` → `passCdlodMs`/`gpuCdlodMs` | CDLOD terrain select→indirect | compute |
| 10 | `3662` | `lightsGpu` → `passLightsMs`/`gpuLightsMs` | Clustered light froxel cull | compute |
| 11 | `3664-3666` | `particlesGpu` → `passParticlesMs`/`gpuParticlesMs` | GPU particle sim update | compute |
| 12 | `3668-3671` | `postRender` → `passPostMs`/`gpuPostMs` | **Main scene color pass** (terrain/forest/plants/grass/creatures/water-surface geometry) **+ nested shadow-map pass(es) per shadow-casting light** (`three.webgpu.js:44567`, triggered automatically via `ShadowNode.updateBefore`) **+ (if enabled) bloom → tonemap → grade → output composite** (`post-fx.js:71-72`) | render (+ nested render calls) |
| 13 | `3672` (`resolveFrameTimestamps`, `3571-3589`) | n/a → `gpuComputeMs`/`gpuRenderMs`/`gpuPostMs` | Resolves aggregate GPU timestamp queries for the whole frame's compute/render scopes | diagnostic read-back |

`renderFrameCalls` (`environment-viewer.html:929`) counts internal `render()` invocations
across steps 4 and 12 combined (water reflection + shadow map(s) + main pass + any
post-fx sub-passes) — reset once at the top of the whole frame (step 0, before step 1),
not scoped to any single row above. `drawCalls`/`triangles` (`environment-viewer.html:930,933`)
are the per-object-draw counters that actually vary with forest/plant/creature instance
counts within those same passes.

## Bottom line for the perf finding

- The correlation observed (`passPostMs` rising with draw calls, triangles, forest/plant
  instances, and creature shadow casters) is fully explained by the fact that `passPostMs`
  times the base scene render (plus its nested automatic shadow passes), not an isolated
  post-processing stage. Those counters are exactly what scales the cost of "step 12" in the
  table above.
- `renderFrameCalls` staying flat at 16 is expected and not contradictory: it's a
  structural pass count (how many times `render()` fired this frame), unaffected by how many
  objects are drawn inside each of those fixed passes.
- The dominant cost is **base scene rendering + shadow maps**, not the bloom/tonemap/grade
  chain. To confirm the post-fx chain itself is cheap, compare `gpuPostMs`/`passPostMs`
  between `postFX.enabled = true` vs `false` sessions, or look at `snapshot.postMode` in the
  CSV if captured — the mode-dependent relabeling in `environment-ui.js:802` shows the code
  already distinguishes "Render submit" (post off) vs "Render + post" (post on) for the same
  stat, which would be the fastest way to isolate the two costs without new instrumentation.
