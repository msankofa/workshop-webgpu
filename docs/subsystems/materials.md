# Materials (portable TSL demos)

Reusable TSL material effects authored as standalone modules, plus a viewer that loads them.

The organizing constraint is **portability**: a demo is written once and consumed unchanged by both
`material-viewer.html` (parameters bound to sliders) and the game (parameters bound to entity
state). Nothing in `materials/` imports a viewer, a scene, or the DOM.

Background and the source survey behind these effects:
`research/materials/tsl-material-portability-synthesis.html`.

## Files

| File | Role |
|---|---|
| `materials/material-demo-api.js` | The contract: `paramDefaults`, `resolveParams`, `paramSpec`, `uniformSeed`, `buildHandle`. |
| `materials/index.js` | `DEMOS` registry, `demoEntry(id)`, `loadDemo(id, opts)`. Lazy `import()` per demo. |
| `materials/dissolve.js` | Noise-threshold dissolve with a glowing burn edge. |
| `materials/hologram-visor.js` | Fresnel rim, object-space scanlines, flicker. |
| `materials/damage-overheat.js` | Scorch spread and emissive cracks driven by health. |
| `materials/foliage-sss.js` | Wrapped translucency (fake subsurface) for backlit vegetation. |
| `material-viewer.html` | Demo loader and tuning viewer. Needs `serve.py`; WebGPU required. |
| `test-materials.mjs` | Contract tests. `node test-materials.mjs`. |

## The demo contract

Every module in `materials/` exports exactly two things.

```js
export const meta = {
  id, name, blurb, targets, cost,   // cost: 'low' | 'medium' | 'hero'
  base,                             // e.g. 'MeshStandardNodeMaterial'
  notes,                            // how the game should drive it
  rebuildOn,                        // optional: param keys baked into the graph
  params: [ { key, label, type, value, min, max, step, hint } ],
};

export function create({ params } = {}) -> handle
```

`type` is `'float'`, `'color'` (hex number or css string) or `'vec3'` (array or `{x,y,z}`).
`min`/`max`/`step` drive the viewer's sliders only; the game ignores them.

The handle:

```js
{
  meta, material, uniforms, params,
  setParam(key, value),      // false if the key is not declared
  setParams(obj),
  update(dt, elapsed),
  dispose(),
}
```

### rebuildOn

Some parameters are shader loop bounds rather than uniforms, for example the octave count passed to
`mx_fractal_noise_float`. Those keys are listed in `meta.rebuildOn`, are **not** present in
`handle.uniforms`, and are baked at `create()` time. Changing one means constructing a new handle.
`material-viewer.html` does this automatically and preserves the rest of the tuning.

## Using a demo in the game

```js
import { create } from './materials/dissolve.js';

const fx = create({ params: { edgeColor: 0x59f2c8, edgeIntensity: 4.0 } });
mesh.material = fx.material;

// per frame
fx.setParam('progress', spawnTimer);

// teardown
fx.dispose();
```

The Port tab in the viewer generates this snippet from the current tuning, emitting only the
parameters that differ from the module's defaults.

## Demos

### `dissolve`
Fractal noise blended toward a vertical wipe, thresholded against `progress`. `progress` 1.0 is the
untouched base material and 0.0 is fully gone, so one scalar covers spawn-in and death. Fragments
are **discarded**, not alpha-blended, because bot shells are instanced and self-occluding and alpha
blending would impose a sort order. `Discard()` is recorded inside an `Fn()` body; called at top
level it silently does nothing.

### `hologram-visor`
Fresnel rim from `normalView` against `positionViewDirection`, plus scanlines and a travelling sweep
on **object-space** Y so they stay glued to the visor under camera motion. Emissive deliberately
exceeds 1.0 to drive the existing TSL `bloom` node (`post-fx.js`). `tint` is the natural per-team
hook. `body-part-batches.js:38` notes the lit visor lives outside the instanced batch table, which is
the seam this attaches to.

### `damage-overheat`
Two independent inputs. `damage` is permanent accumulation: scorch blotches spread, roughness climbs
toward 0.95, metalness burns off. `heat` is transient and lights the ridged-noise cracks; decay it
after each hit. Cracks are gated on `damage` as well as `heat`, so an undamaged bot never glows.
Wire `damage` to `1 - health / maxHealth`.

### `foliage-sss`
Wrapped-translucency approximation: bend the light vector by the surface normal, then take a
view-dependent lobe and add it as emissive. No extra pass and no backbuffer read. `lightDirection` is
the direction from the surface **toward** the light, which is a normalized `DirectionalLight`
position. Aimed at vegetation rather than bots on purpose, see below.

## Why none of these target the instanced bot path

`body-part-batches.js:29-48` builds the instanced bot rig from plain `THREE.MeshStandardMaterial`
with per-instance colour. It is not on the node system at all. `bot-viewer-visuals.js` is the path
that uses `MeshStandardNodeMaterial` / `MeshBasicNodeMaterial`.

Adding `MeshPhysicalNodeMaterial` features (iridescence, anisotropy, clearcoat) to bot shells
therefore means migrating the instanced batch path to a more expensive shading model, on the path
that produced the measured 37fps at 90 bots. That is a performance project, not a material change,
and it is deliberately not attempted here.

## Testing

`node test-materials.mjs` builds every demo's real `NodeMaterial` headlessly (`three/webgpu`
resolves in Node) and asserts the API contract, per-type parameter writes, rejection of undeclared
keys, construction-time overrides, and that every `rebuildOn` key is absent from `uniforms`. It also
fails if a `DEMOS` registry summary drifts from its module's `meta`.

It compiles no shaders and measures no frames. A graph that assembles in Node can still fail to
compile to WGSL, and whether an effect looks right is a browser question.

## Adding a demo

1. Write `materials/<id>.js` exporting `meta` and `create()`.
2. Add an entry to `DEMOS` in `materials/index.js` with a matching `id`, `name`, `blurb`, `targets`
   and `cost`. The test fails if these drift from `meta`.
3. Run `node test-materials.mjs`.
4. Check it in `material-viewer.html`.

Verify any TSL node function against the pinned build before using it. Several plausible-sounding
node names are not exported at r0.184, including `curlNoise`, `fbm`, `hexTile` and `textureGrad`;
the post-FX nodes (`bloom`, `ao`, `dof`, `fsr1`) live in `three/addons/tsl/display/`, not
`three/tsl`. The shipped noise set is the MaterialX `mx_*` family plus `triNoise3D`,
`interleavedGradientNoise` and `hash`.

## Viewer

`material-viewer.html` uses the 3D-viewer shell shared with `tree-viewer.html` / `plant-viewer.html`
(WebGPURenderer, OrbitControls, `lights.js` rig) and the in-game inspector language of
`environment-viewer.html`: right-docked collapsible strip, vertical tab rail, uppercase card
headers, the same `--wui-*` tokens. It omits `backdrop-filter` deliberately, following the note in
`environment-ui.js` that blurring a full-height strip over a live canvas costs frame rate.

Tabs: **Demos** (picker), **Params** (sliders, with a per-parameter `loop` toggle that oscillates a
value), **Stage** (subject shape including a bot stand-in and leaf cards, sun, background, ground),
**Port** (generated snippet plus copy button).

The bot stand-in is built from primitives rather than importing the real rig, so the viewer stays
standalone for the same reason the demos do.
