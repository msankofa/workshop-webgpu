# EasyFire "no fire ever drawn" — root cause and fix plan

**Date:** 2026-08-10
**Page:** `demos/easyfire.html` (three 0.185.1 CDN, threejs-easyfire 0.1.7 CDN)
**Deliverable status:** plan only — no code has been changed.

---

## Root cause (verified by source reading, not yet by running)

**The volume is drawn, but it is drawn with zero light in it. three's `VolumeNodeMaterial`
is a LIT volume: its output is `(light reaching each raymarch sample) × scatteringNode`.
The page's scene contains no light that can reach the fire pass, so the multiplication is
`0 × fire = 0` — black, always, in every mode, immune to every slider.**

Two independent conditions each force the light term to zero on this page, and either alone
is fatal:

1. **No light is on render layer 10.** The library's internal fire pass restricts the camera
   to `renderLayer` (10), and three culls lights against camera layers. The page's two lights
   (HemisphereLight, DirectionalLight — `easyfire.html:244-247`) are on the default layer 0
   only, so the fire pass renders with an empty light list.
2. **Neither light type can contribute anyway.** `VolumetricLightingModel.direct()` ignores
   any light without a `.distance` property — only SpotLight and PointLight qualify.
   DirectionalLight has no `.distance`; HemisphereLight never reaches `direct()` at all.

### The evidence, quoted

three.webgpu.js 0.185.1 build (line numbers from the CDN file):

- `VolumeNodeMaterial` (line ~29266) sets `this.lights = true` and uses
  `VolumetricLightingModel` — there is no unlit path.
- `VolumetricLightingModel.start` (line ~29068), inside the raymarch `Loop`:
  ```js
  scatteringDensity.assign( 0 );
  ...
  super.start( builder );              // -> LightingModel.start -> lightsNode.setupLights -> per-light direct()
  if ( scatteringNode ) {
      scatteringDensity.mulAssign( scatteringNode );   // MULTIPLY — scattering is not a source
  }
  const stepLight = scatteringDensity.mul( 0.01 ).toVar();
  ```
  Only `scatteringLight()` ever adds to `scatteringDensity`, and only `direct()` /
  `directRectArea()` call it.
- `VolumetricLightingModel.direct()`:
  ```js
  // Ignore non-analytical lights and lights with infinite distance
  if ( lightNode.isAnalyticLightNode !== true || lightNode.light.distance === undefined ) return;
  ```
  SpotLight/PointLight have `distance` (default `0`, which is *defined*); DirectionalLight
  does not. HemisphereLight contributes via irradiance, never via `direct()`.
- `PassNode.updateBefore` (line ~40994): `camera.layers.mask = this._layers.mask;` — the
  library's `volumetricPass.setLayers(layer 10 only)` therefore restricts the pass camera.
- Light culling (line ~60154): `if ( object.isLight && object.layers.test( camera.layers ) )`
  — a layer-0 light fails the test against a layer-10-only camera and is dropped from the pass.
- The shipped `threejs-easyfire.js` 0.1.7 bundle contains exactly one occurrence of
  `scatteringNode` (the assignment in the EasyFire constructor) and **zero** occurrences of
  `scatteringEmissiveNode` — the one hook that would bypass lighting is unused. (Verified by
  grep of the local bundle copy; repo `main` is at version 0.1.7 and matches.)

The author's demo works because of two lines the page does not have
(`demo/demo.ts`, repo main):

```ts
const spotLight = new SpotLight(0xffffff, 5);      // line 34 — has .distance (0), qualifies
...
spotLight.layers.enable(LAYER_VOLUMETRIC_LIGHTING); // line 47 — puts it INTO the fire pass
```

(He also sets `myFire.keyLightPosition = spotLight.position` — line 125 — but
`uKeyLightPosition` is declared and never read in 0.1.7; it is not load-bearing.)

### Why this explains every symptom

| Symptom | Explanation |
|---|---|
| No console errors | The node graph is legal; multiplying by zero is not an error. |
| Scene renders, no fire | Fire pass output is exactly 0; additive composite adds nothing. |
| "Fire only" is pure black | Same zero, displayed directly. Not a compositing bug — the earlier framing "black means composite is at fault" in the panel text is wrong. |
| Every slider dead (density, temperature, speed, buoyancy, grids, steps) | They all feed `scatteringNode` or the sim behind it — the multiplied-by-zero side. |
| `?volnoise=1` untested | **Prediction: it is ALSO black.** Noise debug swaps `scatteringNode`'s source but the result is still multiplied by zero light. This makes it the decisive cheap test. |

### Verified vs inferred

- **Verified (read in source):** everything quoted above; plus the cleared-suspects list below.
- **Inferred (high confidence, not yet run):** that the zero-light multiply is the *only*
  thing standing between this page and visible fire; that `?volnoise=1` is currently black;
  that adding a layer-10 spot light makes the fire appear. Nothing here has been observed in
  a browser.

### Suspects investigated and cleared this pass (do not re-litigate)

- **`getFireFor` after `initialize()` (page) vs before (author):** immaterial.
  `EmitterManager.getFireFor` only flips `active` and options on a pre-allocated pool
  instance; per-frame `EmitterManager.update()` (called from `fire.update`) uploads matrices,
  `emitMultiplier`, and the active flag every frame regardless of registration order.
  `initialize()` itself only runs the curl-noise compute and defines `update` — it snapshots
  nothing about emitters.
- **`emitterTemplate.visible = false`:** vertex extraction happens in the `EmitterManager`
  constructor via `traverse`, and `updateMatrixWorld` recurses invisible objects; both paths
  are visibility-independent.
- **Dye ping-pong breaking under captured references:** `swap()` exchanges the underlying
  `Storage3DTexture` between the two wrapper objects via `setTexture` (it swaps
  `readOnlyNode.value` / `writeOnlyNode.value`), so every compute pass and the render sampler
  see the swap. Correct.
- **Emission math:** with the page's values, deposit is `0.031 × 0.2 × 21 ≈ 0.13`
  density per vertex-voxel per step, temperature `12 × 0.05 = 0.6` — plenty. The emit pass
  gates only on `uEmitTemperature > 0` and `densityBaseVal > 0`, both satisfied.
- **Emitter inside bounds:** sphere spans y ∈ [−0.15, 1.55]; volume spans y ∈ [−0.4, 5.6].
  Inside. `invWorldMatrix` is synced each `fire.update()` before the sim steps.
- **`renderer.init()` timing, scene fog, ACES tone mapping, shallow config merge, RenderPipeline
  outputNode switching:** all either match the author or cannot produce a black-only result.
- **Solo-mode depth texture staleness:** `scenePass.getTextureNode('depth')` returns a
  `PassTextureNode`, whose `setup` registers `properties.passNode = this.passNode` — sampling
  it pulls the scenePass into the update graph, so depth is rendered even in solo mode. Minor,
  and moot given the root cause.

---

## Ordered plan

Each step: change → evidence → observable. User checks renders in the browser (do not drive
Chrome; play the notification sound when their look is needed).

### Step 0 — decisive diagnostic, zero code: run `?volnoise=1`

Open `http://127.0.0.1:8080/demos/easyfire.html?volnoise=1`.

- **Hypothesis predicts: still black.** The noise sample is multiplied by the same zero
  light term.
- **If anything IS visible**, the lighting hypothesis is refuted — stop and reassess (see
  "If the plan fails"). This is the cheapest possible falsifier and should be run first
  precisely because the hypothesis makes a non-obvious prediction here.

Optionally alongside: open the author's hosted demo (the repo deploys via
`.github/workflows/deploy.yml`, i.e. `https://bandinopla.github.io/threejs-easyfire/`) in the
same browser as an environment control. Author demo burning = machine/browser are fine.

### Step 1 — the fix: add a qualifying light to the fire pass

In `demos/easyfire.html`, after the lights section (~line 247), add author-parity key light:

```js
// VolumeNodeMaterial is a LIT volume: scatteringNode is multiplied by incoming light from
// Spot/Point lights on the fire's render layer. Without one, the volume is black. demo.ts:34-51.
const fireLight = new THREE.SpotLight(0xffffff, 5);
fireLight.position.set(0, 12, 0);
fireLight.angle = Math.PI / 2;
fireLight.penumbra = 1;
fireLight.decay = 1;        // author's value; default 2 would attenuate hard at this range
fireLight.distance = 0;     // 0 = unlimited, and crucially DEFINED — the direct() filter needs it
fireLight.layers.enable(10); // the line that puts it into the volumetric pass (demo.ts:47)
scene.add(fireLight);
```

Notes:
- `layers.enable(10)` keeps the light on layer 0 too (author parity), which slightly relights
  the baseline scene. For measurement hygiene on this cost-eval page, prefer the surgical
  variant: `fireLight.layers.disableAll(); fireLight.layers.enable(10);` — then the main pass
  never sees it and the "Scene only" baseline is untouched. Either works; pick one and say
  which in the page comment.
- Do not enable `castShadow` (the page has no shadow map enabled; the demo's shadow setup is
  not load-bearing for visibility).
- Optionally `fire.keyLightPosition = fireLight.position;` for author parity (verified unused
  in 0.1.7; harmless).

**Observable:** "Fire + sim" shows a plume within a second or two; "Fire only" shows the
plume on black; `?volnoise=1` now shows the curl-noise field filling the box. All three flip
from black together — that co-flip is itself confirmation the light term was the single
blocker.

### Step 2 — correct the page's own diagnostic text

The panel says "black means nothing is in the volume, anything at all means the composite is
at fault", and the `?volnoise=1` comment says "Visible here means drawing is fine and emission
is the fault." Both interpretations are wrong under a lit-volume model — black can also mean
"no light", and volnoise needs the light too. Rewrite both to include the lighting leg, so
the page stops steering future debugging into the two dead ends it steered this one into.
(Precedent for the rule: comments in this file have been confidently wrong before — the page
history note about `getTextureNode()` compositing.)

### Step 3 — tuning pass (only after fire is visible)

The page inherits library defaults the author overrides in his snapshot (`demo.ts:178-261`).
Two matter enough to set immediately:

- `fire.temperatureAtMaxColor = 10;` — library default is 1 (`EasyFire.ts:307`), so with emit
  temperature 12 the whole plume saturates into tier-3 white; the author uses 10.
- `fire.colorRadianceMultiplier = 78.39;` — default 15; the author's brightness.

Worth considering afterwards, from the same snapshot: `simulationSpeed 1.5`,
`vorticityConfinementStrength 11.87`, `cooling 0.4831`, `buoyancy 2.3729`,
`densityDissipation 1.02`, tier2 stop `{0.34, 0.8675}`, tier3 stop `{0.96, 1}`. These are
aesthetics, not visibility — do not mix them into the fix commit.

### Step 4 — bookkeeping

Append one `agent_log.csv` row (subsystem `fx`, files `demos/easyfire.html`) summarizing:
lit-volume root cause, spot light fix. `demos/easyfire.html` is not in the subsystem table,
so no subsystem doc owns it; if the evaluation writes a verdict anywhere, the verdict doc
should carry the "VolumeNodeMaterial requires a layer-matched Spot/Point light" finding — it
is the one integration cost nobody's README states.

---

## If the plan fails

Failure modes and what each proves:

1. **Step 0 shows the noise field today (pre-fix).** The lighting hypothesis is refuted —
   something does light the volume. Re-open the investigation at the emission/dye side with
   that runtime fact; the cleared-suspects list above still stands.
2. **Step 1's light is added and `?volnoise=1` still shows nothing.** Escalate intensity to
   500 once (cheap over-test); check the RIG line in the stats panel still reports the mesh
   on layer 10 and `?volbox=1` still places the box in frame. If a 500-intensity layer-10
   spot light cannot make even the noise-debug volume visible, the raymarch itself is not
   producing output on this machine, with the page now matching the author's demo in every
   material respect (light, layers, pass wiring, config, three version). At that point run
   the environment control: the author's hosted demo in the same browser.
   - Author's demo black too → three 0.185.1 WebGPU volume path does not work on this
     GPU/driver/browser. Library unusable HERE regardless of wiring. Close the evaluation.
   - Author's demo burns, local page (with light) does not → the remaining delta is real but
     lives outside everything examined (page-vs-demo diff is exhausted at this point:
     lighting was the last material difference). Cap further effort: the page's own
     cost analysis already argues the library does not fit the explosion use case (11 3D
     textures per instance, fixed per-frame compute, no degradation tiers) — the evaluation
     can be closed on cost grounds with "visibility never achieved locally" recorded
     honestly, rather than pursued further.
3. **Fire appears but is unusably dim/ugly after Step 3.** That is tuning, not a bug — the
   evaluation proceeds to its actual purpose: the three-way A/B cost measurement.

## Closure criterion

The evaluation's real question is cost, not beauty. Once fire is visible, measure the
Scene-only / sim-frozen / full gaps at the default grids and at max grids, record them in the
verdict, and stop. If visibility cannot be achieved after Step 1 + fallback checks, record
"not usable as wired on this stack" with the environment-control result, and stop. Either
way, this page should not absorb another investigation round beyond that.
