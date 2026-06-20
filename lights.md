# Lighting System

All scene lighting is driven from a single `LightingRig` instance. Changing a slider or calling a setter on the rig automatically propagates the new values to the water system and every grass instance — nothing else needs updating per-frame.

---

## Files

| File | Role |
|------|------|
| `lights.js` | Rig factory — creates Three.js lights, optional UI panel, drives connected systems |
| `water.js` | Consumes `lightDir` for specular highlights and caustic projection |
| `grass.js` | Consumes flat `ambient` + `key` scalars; custom ShaderMaterial receives shadows |
| `creature-viewer.html` | Creates the rig, configures shadows, wires sliders, calls `rig.connect()` |

---

## lights.js

**Entry point:** `createLightingRig(options)` → returns `rig` object.

### What it creates
- `THREE.DirectionalLight` (`rig.dirLight`) — the sun
- `THREE.AmbientLight` (`rig.ambLight`) — sky fill

Both are added to `options.scene` immediately.

### Sun direction math (`toDir`, line 28)
Azimuth/elevation degrees → unit `THREE.Vector3`:
```
x = sin(az) * cos(el)
y = sin(el)
z = cos(az) * cos(el)
```
`dirLight.position` is set to `toDir(...) * 50` (distance doesn't matter for directional lights, just direction).

### Internal `push()` function (line 48)
Called on every slider change and after `connect()`. Recomputes sun direction and pushes to all registered systems:
- **water:** `w.setLightDir(d)` with the new unit vector
- **grass:** `g.setAmbient(ambientIntensity * 0.9)` and `g.setKey(sunIntensity * sin(elevation) * 0.37)` — key light naturally dims toward the horizon

### `connect(water, grass)` (line 61)
Registers a water system and/or one or more grass instances. Calls `push()` immediately so they sync on registration. Safe to call with `null` for either argument (e.g. `rig.connect(null, grassRef)` when water isn't loaded yet).

### UI panel (`buildUI`, line 108)
Standalone collapsible panel, `position:fixed; top:16px; right:16px`. Built when `ui: true` (default). In `creature-viewer.html` the rig is created with `ui: false` and sliders are added to the existing `#ctrl` panel instead (see below).

### Rig API surface
```js
rig.dirLight            // THREE.DirectionalLight — configure shadows on this
rig.ambLight            // THREE.AmbientLight
rig.connect(water, grass)
rig.setAzimuth(deg)
rig.setElevation(deg)
rig.setSunColor(hex)
rig.setSunIntensity(v)
rig.setAmbientColor(hex)
rig.setAmbientIntensity(v)
rig.azimuth             // getter
rig.elevation           // getter
rig.dispose()
```

---

## water.js — light integration

**Relevant section:** `createWaterSystem()` closure, line 221 onwards.

The water keeps an internal `lightDir` Vector3 (line 224). Both `surfaceMat.uniforms.uLightDir` and `causticMat.uniforms.uLightDir` point to **the same object**, so mutating it in place updates both materials automatically.

### `setLightDir(v)` (line 447)
Added to the returned object. Called by the rig's `push()`.
1. `lightDir.copy(v).normalize()` — mutates the shared Vector3 (both shader uniforms update automatically)
2. `refractVec(...)` — recomputes `refractedFlat`, the flat-surface refracted light ray used by the ground caustic shader (`groundUniforms.uRefractedLightG`)

The caustic projection onto the ground terrain depends on `refractedFlat`, so it must be recomputed whenever the sun moves.

---

## grass.js — light integration

**Lighting uniforms in `DEFAULTS`** (line 46–47): `ambient: 0.55`, `key: 0.55`

The grass shader uses flat lighting — no normals, no directional calculation:
```glsl
float light = uAmbient + uKey;  // FRAG_SHADER, ~line 141
gl_FragColor = vec4(col * light * cloud * shadow, 1.0);
```

### `setAmbient(v)` / `setKey(v)` (lines 281–282)
One-liners on the `Grass` class that write directly into the ShaderMaterial uniforms. Called by the rig's `push()`.

### Shadow receiving (VERT_SHADER lines 87–108, FRAG_SHADER lines 123–157)

Grass uses `lights: true` on its ShaderMaterial so Three.js binds the `directionalLightShadows` struct uniform (needed for shadow bias/radius). The geometry has **no normal attribute**, so `#include <shadowmap_vertex>` cannot be used — instead shadow coords are assigned manually without normal bias:

```glsl
// vertex shader
vec4 worldPosition = modelMatrix * vec4(cpos, 1.0);  // cpos = wind-deformed position
#pragma unroll_loop_start
for (int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i++) {
  vDirectionalShadowCoord[i] = directionalShadowMatrix[i] * worldPosition;
}
#pragma unroll_loop_end
```

Fragment shader includes `#include <packing>` then `#include <shadowmap_pars_fragment>`. `<packing>` must come first — `shadowmap_pars_fragment` calls `unpackRGBAToDepth` which is defined there.

**`buildMaterial` uniforms** (line ~240) use `THREE.UniformsUtils.merge([THREE.UniformsLib.lights, { ...custom }])` — required when `lights: true` so Three.js has slots to write ambient/directional/shadow data into. Without this merge, Three.js throws `Cannot set properties of undefined (setting 'value')`.

---

## creature-viewer.html — wiring

```js
// line 53 — rig created after scene, before terrain
const rig = createLightingRig({ scene, ui: false });
rig.dirLight.castShadow = true;
rig.dirLight.shadow.mapSize.set(2048, 2048);
// shadow camera frustum lines 56–58

// line 430 — inside trees .then() where the ctrl panel helpers exist
const rigP = { elevation, azimuth, sunIntensity, ambientIntensity };
slider(...)  // four sliders added to existing #ctrl panel

// line 452 — inside grass .then()
rig.connect(null, grassRef);

// line 464 — inside water .then()
rig.connect(waterRef, null);
```

The rig is created early (synchronously) so its lights are in the scene from frame 1. Water and grass load asynchronously; `connect()` is safe to call later — it pushes current rig state immediately on registration.

---

## Adding a new system that responds to lighting

1. Add a `setLightDir(v: THREE.Vector3)` method to the system if it needs sun direction, and/or `setAmbient(v)` / `setKey(v)` for flat-lit shaders.
2. Call `rig.connect(yourSystem, null)` (or `rig.connect(null, yourSystem)` for grass-style) after the system is ready.
3. The rig calls `push()` on every slider change — no per-frame work needed.
