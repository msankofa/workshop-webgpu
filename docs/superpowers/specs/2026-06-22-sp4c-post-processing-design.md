# SP4c — Node post-processing stack (bloom + GTAO + tonemap + grade) · Design Spec

**Date:** 2026-06-22
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** scoped; proceeding to plan + implement under the `a→b→c` goal (4c, last).
**Part of:** SP4 (lights/effects/post): 4a lighting ✓ · 4b particles ✓ · **4c post**.

## Goal

A **configurable** node-based post-processing stack on the WebGPU backend, composed from three's
own `PostProcessing` node pipeline, replacing the final `renderer.render`. The stack: scene pass
→ **bloom** → **GTAO** (ambient occlusion) → **tone mapping** (runtime-switchable AgX/ACES/…) →
**color grade** → output. All effect parameters are live UI controls; the tone-mapping operator
is switchable at runtime.

## What three r0.184 provides (confirmed)

Built-in (`three/webgpu` + `three/tsl`): `PostProcessing`, `pass()`/`PassNode`, tone-mapping
nodes (`agxToneMapping`, `acesFilmicToneMapping`, `reinhardToneMapping`, `neutralToneMapping`),
`AONode`/`builtinAOContext`, `depthPass`, `renderOutput`/`output`. In addons (importmap already
maps `three/addons/` → examples/jsm): `bloom` (`three/addons/tsl/display/BloomNode.js`) and
`gtao` (`three/addons/tsl/display/GTAONode.js`). So 4c is mostly *composing* existing nodes —
the lowest-novelty SP4 sub-project. Exact addon export names/paths are confirmed at implementation.

## Architecture

```
scenePass = pass(scene, camera)              // color; also exposes depth + normal for AO
ao        = gtao(scenePass.depth, scenePass.normal, camera) * uAoIntensity   // 1.0 = full, 0 = off
lit       = scenePass.rgb * mix(1, ao, uAoEnabled)
bloomed   = lit + bloom(lit, uBloomStrength, uBloomRadius, uBloomThreshold)
toned     = <operator>(bloomed * uExposure)  // operator chosen by setToneMapping()
graded    = grade(toned, uContrast, uSaturation, uVignette)
postProcessing.outputNode = graded
```
- `postProcessing.renderAsync()` replaces `renderer.render(scene, camera)` in `animate()` (it
  runs after the awaited grass/cdlod/lights/particle computes). When the master toggle is off,
  fall back to `renderer.render` (zero post cost, true A/B baseline).
- **Live params are uniforms** (no rebuild). **Tone operator switch** rebuilds `outputNode` with
  the new operator node and reassigns it (rare; on dropdown change).
- AO needs depth+normal from the scene pass (`scenePass.getTextureNode('depth')` + normal pass).
  GTAO is the most expensive node; `uAoIntensity`/toggle let it be dialed or disabled live.

## Configurable controls (new "Post" UI section, using the panel's `slider`/`select`/`toggle`)

| control | type | range / options | effect |
|---|---|---|---|
| Post FX | toggle | on/off | master; off → plain `renderer.render` |
| Tone mapping | select | **AgX** (default), ACES, Reinhard, Neutral, None | `setToneMapping()` (rebuild) |
| Exposure | slider | 0.1–3.0 | `uExposure` |
| Bloom strength | slider | 0–2 | `uBloomStrength` |
| Bloom radius | slider | 0–1 | `uBloomRadius` |
| Bloom threshold | slider | 0–1.5 | `uBloomThreshold` |
| AO intensity | slider | 0–1 (0 disables) | `uAoIntensity` |
| Contrast | slider | 0.5–1.5 | `uContrast` |
| Saturation | slider | 0–2 | `uSaturation` |
| Vignette | slider | 0–1 | `uVignette` |

## Components / files

### `post-fx.js` (NEW, GPU/TSL)
`createPostFX({ renderer, scene, camera, params })` → `{ renderAsync(), resize(w,h), setEnabled,
setToneMapping(name), setExposure, setBloom(s,r,t), setAO(intensity), setGrade(contrast,sat,vig),
get enabled }`. Owns the `PostProcessing` instance, the `pass`/`bloom`/`gtao`/tonemap/grade node
graph, and the live uniforms. `setToneMapping` rebuilds `outputNode`.

### `post-grade.js` (NEW, pure JS — the one Node-testable bit)
`grade(rgb, contrast, saturation, vignetteAmt, uv)` reference math (contrast around 0.5, luma-
based saturation, radial vignette) — transcribed to TSL in `post-fx.js`, Node-tested for the
known identities.

### `environment-viewer.html` (MODIFY — shared with Codex; stage SP4c hunks only)
- Construct `createPostFX(...)` after the scene/effects exist; behind `?post=on|off` (default on).
- `animate()`: `if (postFX?.enabled) await postFX.renderAsync(); else renderer.render(scene, camera);`
- Resize hook → `postFX.resize(...)`.
- Add the **Post** control section.

## Gate (success criteria)
1. **Visible, correct stack:** bloom glows the lights/embers/water; GTAO darkens crevices/contact;
   tone mapping maps HDR cleanly; grade shifts mood. No obvious artifacts (bloom fireflies,
   AO halos) at default settings.
2. **Configurable + switchable:** all controls live; **AgX⇄ACES⇄…** switch works at runtime.
3. **No CPU-bound regression:** post runs as GPU node passes after the awaited computes; `?post=off`
   A/B shows the cost is GPU-side, cpuMs not spiking (the SP4 gate: "composited without
   reintroducing CPU-bound passes").
4. **Grade math Node-tested.**

## Testing
- **Node (`test-post-grade.mjs`):** contrast=1 & saturation=1 & vignette=0 → identity; saturation=0
  → luma grey; contrast>1 pushes away from 0.5; vignette darkens edges more than center.
- **Browser checkpoint:** toggle Post; sweep bloom/AO/exposure/grade; switch AgX↔ACES (and others)
  and confirm the look changes without error. **dd9:** post on vs off.

## Out of scope (4c)
- TAA / SMAA / FXAA, SSR, depth-of-field, motion blur, chromatic aberration — beyond-scope polish.
- HDR display output; sky/weather (separate future SP).
- Per-object post (selective bloom masks) — global bloom only.
