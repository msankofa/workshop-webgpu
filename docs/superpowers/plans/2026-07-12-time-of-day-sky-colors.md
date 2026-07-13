# Time-of-day sky colors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the WebGPU dome sky's colors from three keyframed states (day / dusk / night) that cross-fade with the sun's elevation, with live sliders and a directional horizon glow, and no per-frame material rebuild.

**Architecture:** Pure blend math lives in `sky-field.js` (Node-tested). `sky.js` builds the dome material once from GPU **uniforms** and writes them every frame via a new `updateDome(sunElevationDeg)` — no dispose/rebuild (the documented "night freeze" race). A `nightness` scalar derived from the same elevation is exposed as the single source of truth for "how dark is it," and optionally multiplies celestial opacity. New inline UI in `environment-viewer.html` edits the state keyframes / thresholds live.

**Tech Stack:** Three.js r0.184 WebGPU backend, TSL node materials (`three/tsl`), plain-Node test scripts (no framework), single-file inline UI helpers (`slider()`/`select()`/`toggle()`/`header()`).

---

## Background the engineer needs

- **Why uniforms, not a rebuild:** Today `sky.js:makeSkyDomeMaterial(palette)` bakes the four colors and the transition constants directly into the TSL `colorNode`. Changing any of them requires `setPalette()` → `rebuild()`, which disposes and recreates the dome mesh. Doing that per-frame races the async WebGPU submit and crashes ("buffer used in submit while destroyed"). So this feature converts those baked constants into uniforms and only ever writes `.value`, never rebuilds.
- **Sun elevation is degrees.** The lighting rig exposes `rig.elevation` (degrees). `skyLightDir()` in `environment-viewer.html` converts `rig.azimuth`/`rig.elevation` to a unit vector; `sky.js` also derives elevation from `dir.y` via `asin`.
- **`sky-field.js` has no `three` import** — it is the pure, Node-tested source of truth. Keep it that way. All new blend math goes here.
- **Coordination:** a parallel agent owns star / Milky Way / celestial-body internals. This plan's only cross-boundary touch is the celestial-opacity toggle (Task 4), which multiplies existing opacity/intensity handles by `skyRef.nightness`. `nightness` is exposed as the shared interface; do not add a second darkness measure.

## File structure

- **`sky-field.js`** (modify) — add the state keyframes, thresholds, color-lerp helper, and the two pure blend functions. Stays `three`-free and Node-tested.
- **`sky.js`** (modify) — uniform-driven dome material, `updateDome`, `nightness`/`skyStates`/`thresholds` getters, `setCelestialOpacityMode`, `setGlowDirectionality`, `uSunDir` write in `setSunDir`, directional glow in the `colorNode`.
- **`environment-viewer.html`** (modify) — per-frame `updateDome(rig.elevation)` call; new "Sky — time of day" UI block (per-state color inputs + sliders, threshold sliders, glow-directionality slider, celestial-opacity toggle).
- **`test-sky-field.mjs`** (modify) — new cases for the pure functions.
- **`docs/subsystems/sky.md`** (modify) — document the state/blend model, uniform dome, `nightness`, new tunables; correct the stale "single static palette" note.
- **`agent_log.csv`** (modify) — append one row.

---

## Task 1: Pure blend math in `sky-field.js`

**Files:**
- Modify: `sky-field.js` (insert after `makePalette`, ~line 28)
- Test: `test-sky-field.mjs` (insert new blocks before the final summary at ~line 150)

- [ ] **Step 1: Write the failing tests**

In `test-sky-field.mjs`, insert the following **immediately before** the final two lines (`console.log(fail ? ...)` and `process.exit(...)`):

```js
import { DEFAULT_SKY_STATES, makeSkyStates, DEFAULT_THRESHOLDS,
  lerpHex, domeParamsAtElevation, nightnessAtElevation } from './sky-field.js';

// ---- makeSkyStates: per-state defaults-merge, fresh object ----
{
  ok(makeSkyStates().night.top === DEFAULT_SKY_STATES.night.top, 'makeSkyStates() clones defaults');
  ok(makeSkyStates({ day: { top: '#123456' } }).day.top === '#123456', 'makeSkyStates() applies per-state override');
  ok(makeSkyStates({ day: { top: '#123456' } }).day.glowWidth === DEFAULT_SKY_STATES.day.glowWidth, 'unspecified state fields keep defaults');
  ok(makeSkyStates() !== DEFAULT_SKY_STATES, 'makeSkyStates() returns a fresh object');
}

// ---- lerpHex: endpoints exact, midpoint componentwise, identity ----
{
  ok(lerpHex('#000000', '#ffffff', 0) === '#000000', 'lerpHex t=0 returns first color');
  ok(lerpHex('#000000', '#ffffff', 1) === '#ffffff', 'lerpHex t=1 returns second color');
  ok(lerpHex('#000000', '#ffffff', 0.5) === '#808080', 'lerpHex midpoint is componentwise mid');
  ok(lerpHex('#204060', '#204060', 0.37) === '#204060', 'lerpHex of equal colors is identity');
}

// ---- domeParamsAtElevation: anchor identity, interpolation, clamp, determinism ----
{
  const th = DEFAULT_THRESHOLDS;                 // { dayAbove:8, duskPeak:0, nightBelow:-8 }
  const S = DEFAULT_SKY_STATES;
  const atDay   = domeParamsAtElevation(th.dayAbove,   th, S);
  const atDusk  = domeParamsAtElevation(th.duskPeak,   th, S);
  const atNight = domeParamsAtElevation(th.nightBelow, th, S);
  ok(atDay.top === S.day.top && atDay.glowStrength === S.day.glowStrength, 'exact day params at dayAbove');
  ok(atDusk.top === S.dusk.top && atDusk.glowWidth === S.dusk.glowWidth, 'exact dusk params at duskPeak');
  ok(atNight.top === S.night.top && atNight.horizon === S.night.horizon, 'exact night params at nightBelow');
  ok(domeParamsAtElevation(90, th, S).top === S.day.top, 'above dayAbove clamps to day');
  ok(domeParamsAtElevation(-90, th, S).bottom === S.night.bottom, 'below nightBelow clamps to night');
  const mid = domeParamsAtElevation((th.duskPeak + th.dayAbove) / 2, th, S);
  const lo = Math.min(S.dusk.glowStrength, S.day.glowStrength), hi = Math.max(S.dusk.glowStrength, S.day.glowStrength);
  ok(mid.glowStrength > lo && mid.glowStrength < hi, 'dusk<->day glowStrength interpolates between');
  const mid2 = domeParamsAtElevation((th.nightBelow + th.duskPeak) / 2, th, S);
  ok(mid2.glowWidth !== S.night.glowWidth && mid2.glowWidth !== S.dusk.glowWidth, 'night<->dusk params interpolate');
  ok(domeParamsAtElevation(3, th, S).horizon === domeParamsAtElevation(3, th, S).horizon, 'deterministic per elevation');
}

// ---- nightnessAtElevation: endpoints + monotonic non-increasing in elevation ----
{
  const th = DEFAULT_THRESHOLDS;
  ok(nightnessAtElevation(th.dayAbove, th) === 0, 'nightness 0 at dayAbove');
  ok(nightnessAtElevation(20, th) === 0, 'nightness 0 well above dayAbove');
  ok(nightnessAtElevation(th.nightBelow, th) === 1, 'nightness 1 at nightBelow');
  ok(nightnessAtElevation(-20, th) === 1, 'nightness 1 well below nightBelow');
  let mono = true, prev = -Infinity;
  for (let e = 20; e >= -20; e -= 0.5) {          // falling elevation -> non-decreasing nightness
    const n = nightnessAtElevation(e, th);
    if (n < prev - 1e-9) mono = false;
    prev = n;
  }
  ok(mono, 'nightness is monotonic non-decreasing as elevation falls');
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test-sky-field.mjs`
Expected: FAIL — throws at the new `import` (`SyntaxError: ... does not provide an export named 'DEFAULT_SKY_STATES'`), because the functions don't exist yet.

- [ ] **Step 3: Implement the pure functions**

In `sky-field.js`, insert this block immediately after the `makePalette` function (after its closing `}` at ~line 28, before `export function skyRadius`):

```js

// ---- Time-of-day dome states -------------------------------------------------
// Three keyframed dome parameter sets blended by sun elevation. `night` reproduces
// today's DEFAULT_PALETTE look plus the transition constants that used to be baked into
// sky.js's colorNode (zenithSoftness 0.55, glowWidth ~= 1/9, glowStrength 0.4).
export const DEFAULT_SKY_STATES = {
  day:   { top: '#2b6bd6', horizon: '#bcd4f0', bottom: '#7fa8d8', glow: '#e8eef6',
           horizonHeight: 0.0, zenithSoftness: 0.55, glowWidth: 0.11, glowStrength: 0.25 },
  dusk:  { top: '#1a2a5c', horizon: '#c85a3c', bottom: '#2a1a3e', glow: '#ff8a4a',
           horizonHeight: 0.0, zenithSoftness: 0.50, glowWidth: 0.18, glowStrength: 0.60 },
  night: { top: '#0a1026', horizon: '#243b66', bottom: '#0b1430', glow: '#3a5a8c',
           horizonHeight: 0.0, zenithSoftness: 0.55, glowWidth: 0.11, glowStrength: 0.40 },
};

// Sun-elevation anchors (degrees) that select / blend the states.
export const DEFAULT_THRESHOLDS = { dayAbove: 8, duskPeak: 0, nightBelow: -8 };

const SKY_COLOR_KEYS = ['top', 'horizon', 'bottom', 'glow'];
const SKY_NUM_KEYS = ['horizonHeight', 'zenithSoftness', 'glowWidth', 'glowStrength'];

export function makeSkyStates(overrides = {}) {
  const out = {};
  for (const k of ['day', 'dusk', 'night']) out[k] = Object.assign({}, DEFAULT_SKY_STATES[k], overrides[k] || {});
  return out;
}

function hex2rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function ch(v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }
// Linear RGB-space hex interpolation. Endpoints are exact (integer identity), so a state
// returned at its own anchor elevation is byte-for-byte that state's color.
export function lerpHex(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b);
  return '#' + ch(A[0] + (B[0] - A[0]) * t) + ch(A[1] + (B[1] - A[1]) * t) + ch(A[2] + (B[2] - A[2]) * t);
}

function lerpState(a, b, t) {
  const out = {};
  for (const k of SKY_COLOR_KEYS) out[k] = lerpHex(a[k], b[k], t);
  for (const k of SKY_NUM_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

// Dome parameter set for a sun elevation. Only ever blends ADJACENT, explicitly-authored
// states (day<->dusk, dusk<->night), so colors never take a muddy direct blue->red
// midpoint. Clamps to day above `dayAbove` and to night below `nightBelow`.
export function domeParamsAtElevation(elevDeg, thresholds = DEFAULT_THRESHOLDS, states = DEFAULT_SKY_STATES) {
  const { dayAbove, duskPeak, nightBelow } = thresholds;
  const { day, dusk, night } = states;
  if (elevDeg >= dayAbove) return lerpState(day, day, 0);
  if (elevDeg <= nightBelow) return lerpState(night, night, 0);
  if (elevDeg >= duskPeak) return lerpState(dusk, day, (elevDeg - duskPeak) / (dayAbove - duskPeak));
  return lerpState(night, dusk, (elevDeg - nightBelow) / (duskPeak - nightBelow));
}

function smooth01(e0, e1, x) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
// 0 in full day, 1 in full night, smooth through dusk. Monotonic non-increasing in elevation.
export function nightnessAtElevation(elevDeg, thresholds = DEFAULT_THRESHOLDS) {
  return 1 - smooth01(thresholds.nightBelow, thresholds.dayAbove, elevDeg);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test-sky-field.mjs`
Expected: PASS — final line `all passed`, exit 0. (All prior cases still pass; the new blocks pass too.)

- [ ] **Step 5: Commit**

```bash
git add sky-field.js test-sky-field.mjs
git commit -m "$(cat <<'EOF'
feat(sky): time-of-day dome state blend math

Add DEFAULT_SKY_STATES/makeSkyStates, DEFAULT_THRESHOLDS, lerpHex,
domeParamsAtElevation, nightnessAtElevation to the pure sky-field layer,
with Node tests. No three.js dependency.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Uniform-driven dome + `updateDome` + `nightness` in `sky.js`

No automated test exists for `sky.js` (it imports `three/webgpu` and can't run in Node — consistent with the rest of the rendering layer). Verification is: the Node tests still pass (unaffected) and a manual viewer check.

**Files:**
- Modify: `sky.js` (imports line 8-10; `makeSkyDomeMaterial` lines 18-33; `createSky` internals lines 75-226)

- [ ] **Step 1: Extend the TSL and sky-field imports**

Replace line 8:

```js
import { Fn, float, vec3, mix, smoothstep, positionLocal, normalize, pow, max, abs } from 'three/tsl';
```

with:

```js
import { Fn, float, vec3, mix, smoothstep, positionLocal, normalize, pow, max, abs, dot, uniform } from 'three/tsl';
```

Replace lines 9-10:

```js
import { makePalette, skyRadius, isMoonBody, sunSpritePlacement, makeRng,
  generateStars, generateMilkyWay, generateCelestialBodies } from './sky-field.js?v=sp7-hdplanets';
```

with:

```js
import { makePalette, skyRadius, isMoonBody, sunSpritePlacement, makeRng,
  generateStars, generateMilkyWay, generateCelestialBodies,
  makeSkyStates, DEFAULT_THRESHOLDS, domeParamsAtElevation, nightnessAtElevation } from './sky-field.js?v=sp7-hdplanets';
```

- [ ] **Step 2: Replace `makeSkyDomeMaterial` with a uniform-driven version + a uniform-bundle builder**

Replace the whole function (lines 17-33) with:

```js
// Gradient dome: bottom->horizon->top by view-direction Y, plus a directional horizon glow.
// All colors + transition params + sun direction are UNIFORMS so the per-frame time-of-day
// blend and every slider write .value with no material rebuild (rebuild races the WebGPU submit).
function makeSkyDomeMaterial(u) {
  const mat = new MeshBasicNodeMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false });
  mat.fog = false;
  mat.colorNode = Fn(() => {
    const p = normalize(positionLocal);
    const y = p.y.sub(u.horizonHeight);                          // horizon band shifts with time of day
    const up = smoothstep(0.0, u.zenithSoftness, y);            // horizon -> zenith
    const down = smoothstep(0.0, -0.5, y);                      // horizon -> nadir
    const aboveCol = mix(u.horizon, u.top, up);
    const belowCol = mix(u.horizon, u.bottom, down);
    const base = mix(aboveCol, belowCol, smoothstep(0.05, -0.05, y));  // soft horizon crossover
    const band = pow(max(float(1).sub(abs(y).div(u.glowWidth)), float(0)), float(2.0)); // horizon glow falloff
    // Bias the glow toward the sun azimuth: dot of horizontal dome dir vs sun dir, mapped [0,1].
    const align = dot(normalize(p.xz), normalize(u.sunDir.xz)).mul(0.5).add(0.5);
    const glowAmt = band.mul(mix(float(1.0), align, u.glowDirectionality)).mul(u.glowStrength);
    return mix(base, u.glow, glowAmt);
  })();
  return mat;
}

// Build the persistent dome uniform bundle from an initial dome parameter set.
function makeDomeUniforms(state) {
  return {
    top: uniform(new THREE.Color(state.top)),
    horizon: uniform(new THREE.Color(state.horizon)),
    bottom: uniform(new THREE.Color(state.bottom)),
    glow: uniform(new THREE.Color(state.glow)),
    horizonHeight: uniform(state.horizonHeight),
    zenithSoftness: uniform(state.zenithSoftness),
    glowWidth: uniform(state.glowWidth),
    glowStrength: uniform(state.glowStrength),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    glowDirectionality: uniform(0.35),
  };
}
```

- [ ] **Step 3: Add the time-of-day state, uniforms, and the `applyDome` writer inside `createSky`**

In `createSky`, find the declaration line (currently line 82):

```js
  let dome, sunSprite, moonSprite, starsPoints, starsMax, milkyGas;
```

Replace it with (adds `bodiesGroup` and the time-of-day state, then the hoisted writer functions):

```js
  let dome, sunSprite, moonSprite, starsPoints, starsMax, milkyGas, bodiesGroup;

  // Time-of-day: keyframed states + elevation thresholds live here (the UI mutates these
  // objects in place via the getters below; updateDome reads them every frame).
  let skyStates = makeSkyStates(overrides && overrides.skyStates);
  let thresholds = Object.assign({}, DEFAULT_THRESHOLDS, overrides && overrides.thresholds);
  const domeU = makeDomeUniforms(domeParamsAtElevation(elevFromDir(), thresholds, skyStates));
  domeU.sunDir.value.copy(dir);
  let _nightness = nightnessAtElevation(elevFromDir(), thresholds);
  let celestialFollowTime = false;

  function elevFromDir() { return Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI; }

  // Write the blended dome params for a sun elevation into the uniforms + scene.background,
  // cache nightness, and (when enabled) fade celestials by nightness. Pure uniform/opacity
  // writes — no rebuild, no dispose.
  function applyDome(elevDeg) {
    const pr = domeParamsAtElevation(elevDeg, thresholds, skyStates);
    domeU.top.value.set(pr.top); domeU.horizon.value.set(pr.horizon);
    domeU.bottom.value.set(pr.bottom); domeU.glow.value.set(pr.glow);
    domeU.horizonHeight.value = pr.horizonHeight; domeU.zenithSoftness.value = pr.zenithSoftness;
    domeU.glowWidth.value = pr.glowWidth; domeU.glowStrength.value = pr.glowStrength;
    _nightness = nightnessAtElevation(elevDeg, thresholds);
    if (scene && scene.background && scene.background.isColor) scene.background.set(pr.bottom);
    const f = celestialFollowTime ? _nightness : 1;
    if (starsPoints && starsPoints.material._uOpacity) starsPoints.material._uOpacity.value = (palette.starOpacity ?? 1) * f;
    if (milkyGas && milkyGas.material._uIntensity) milkyGas.material._uIntensity.value = (palette.milkyWayIntensity ?? 0.7) * f;
    if (bodiesGroup) bodiesGroup.traverse(o => { if (o.isSprite && o.material) o.material.opacity = f; });
  }
```

- [ ] **Step 4: Point the dome mesh at the uniform bundle and capture the celestial group**

In `build()`, replace the dome-mesh line (currently line 86):

```js
    dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 18), makeSkyDomeMaterial(palette));
```

with:

```js
    dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 18), makeSkyDomeMaterial(domeU));
```

Replace the celestial-bodies block (currently lines 118-122):

```js
    // celestial bodies (night/dusk only — gate on milkyWay flag as the night marker)
    if (parts.bodies !== false && palette.milkyWay) {
      group.add(createCelestialBodies(generateCelestialBodies(radius, palette, makeRng((seed ^ 0xc0de) >>> 0)),
        { resScale: palette.bodyResolution ?? 1 }));
    }
```

with (capture the group so `applyDome` can fade it):

```js
    // celestial bodies (night/dusk only — gate on milkyWay flag as the night marker)
    bodiesGroup = null;
    if (parts.bodies !== false && palette.milkyWay) {
      bodiesGroup = createCelestialBodies(generateCelestialBodies(radius, palette, makeRng((seed ^ 0xc0de) >>> 0)),
        { resScale: palette.bodyResolution ?? 1 });
      group.add(bodiesGroup);
    }
```

Replace the final line of `build()` (currently line 123):

```js
    if (scene) scene.background = _c(palette.bottom);
```

with (ensure a mutable Color, then let `applyDome` fill dome uniforms + background on every build/rebuild):

```js
    if (scene && (!scene.background || !scene.background.isColor)) scene.background = new THREE.Color();
    applyDome(elevFromDir());
```

- [ ] **Step 5: Write `uSunDir` in `setSunDir` and add the new API on the returned object**

Replace `setSunDir` (currently line 192):

```js
    setSunDir(v) { dir.copy(v).normalize(); placeSun(); },
```

with:

```js
    setSunDir(v) { dir.copy(v).normalize(); domeU.sunDir.value.copy(dir); placeSun(); },
```

Then, in the returned object, add these members (place them right after the `setSunDir` line):

```js
    // Time-of-day: blend the dome to the given sun elevation (degrees). Uniform writes only.
    updateDome(elevDeg) { applyDome(elevDeg); },
    // When true, celestial (stars/Milky Way/bodies) opacity is multiplied by nightness.
    setCelestialOpacityMode(on) { celestialFollowTime = !!on; },
    // Directional horizon glow: 0 = even ring, 1 = fully concentrated toward the sun.
    setGlowDirectionality(v) { domeU.glowDirectionality.value = v; },
    get nightness() { return _nightness; },
    get skyStates() { return skyStates; },
    get thresholds() { return thresholds; },
```

- [ ] **Step 6: Verify the Node tests are unaffected, then verify live**

Run: `node test-sky-field.mjs`
Expected: PASS (`all passed`) — `sky.js` changes don't touch the pure layer.

Then start the server and open the viewer:

Run: `python serve.py`
Open: `http://127.0.0.1:8080/environment-viewer.html`
Expected: sky renders with no console errors; the dome looks like today's night sky at the default sun elevation. (Time-of-day blending is wired in Task 3; UI in Task 4. The dome now reads its colors from uniforms — a regression here would show as a black/incorrect dome or a WebGPU validation error in the console.)

- [ ] **Step 7: Commit**

```bash
git add sky.js
git commit -m "$(cat <<'EOF'
feat(sky): uniform-driven dome + updateDome + nightness

Build the dome material once from color/transition/sun uniforms; add
updateDome(elevationDeg) to blend the day/dusk/night states per frame with
no rebuild, a directional horizon glow, a nightness getter as the shared
darkness source of truth, and an opt-in celestial-opacity mode.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Drive `updateDome` every frame from the rig elevation

**Files:**
- Modify: `environment-viewer.html` (the per-frame sky block, near `skyRef.setSunDir(d);` ~line 7055)

- [ ] **Step 1: Add the per-frame call**

Find this block (currently ~lines 7053-7055):

```js
    if (skyRef.group.userData.followCamera) skyRef.group.position.copy(camera.position);
    const d = skyLightDir();
    skyRef.setSunDir(d);
```

Replace it with:

```js
    if (skyRef.group.userData.followCamera) skyRef.group.position.copy(camera.position);
    const d = skyLightDir();
    skyRef.setSunDir(d);
    skyRef.updateDome(rig.elevation);   // blend day/dusk/night by sun elevation (uniform writes only)
```

- [ ] **Step 2: Verify live**

Run: `python serve.py`
Open: `http://127.0.0.1:8080/environment-viewer.html`
Find the sun-elevation control (lighting rig / "Sun elevation" slider) and drag it from high to below the horizon.
Expected: the dome cross-fades day → dusk (reddish horizon) → night; `scene.background` tracks the horizon-below color; no console errors, no frame hitch (uniform writes, no rebuild).

- [ ] **Step 3: Commit**

```bash
git add environment-viewer.html
git commit -m "$(cat <<'EOF'
feat(sky): blend dome by sun elevation each frame

Call skyRef.updateDome(rig.elevation) in the per-frame sky block so the
day/dusk/night states cross-fade with the sun.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Time-of-day UI (states, thresholds, glow, celestial toggle)

**Files:**
- Modify: `environment-viewer.html` (after the sky regeneration controls, right after the last `regenRow(...)` call ~line 4709, still inside the `import('./sky.js...').then(...)` callback)

The inline helpers available here: `header(text)` opens a new collapsible section; `toggle(key, label, onChange)` reads/writes `params[key]`. `skyRef.skyStates` / `skyRef.thresholds` return the live objects `sky.js` blends from — mutating them takes effect on the next `updateDome`. Color inputs and per-state sliders are built by hand (like the existing "Star color" row) since they bind to nested state objects, not a flat `params` key.

- [ ] **Step 1: Add the UI block**

Immediately after the last regeneration control line (`regenRow('milkyWayDensity', 'Milky Way density', 0.2, 3, 0.05, false);`, ~line 4709), insert:

```js
    // ---- Time-of-day sky colors (live: mutate skyRef.skyStates / thresholds in place). ----
    header('Sky — time of day');
    const S = skyRef.skyStates;
    const colorRow = (label, get, set) => {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = '<span style="color:#c4ccd6">' + label + '</span>';
      const inp = document.createElement('input'); inp.type = 'color'; inp.value = get();
      inp.style.cssText = 'width:48px;height:20px;background:#222831;border:1px solid #3a434f;border-radius:4px;cursor:pointer';
      inp.addEventListener('input', () => set(inp.value));
      row.appendChild(inp); current.appendChild(row);
    };
    const stateSlider = (st, key, label, min, max, step) => {
      const row = document.createElement('div'); row.className = 'row';
      const val = document.createElement('span'); val.textContent = (+st[key]).toFixed(2);
      row.innerHTML = '<span style="color:#c4ccd6">' + label + '</span>'; row.appendChild(val);
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = st[key];
      inp.addEventListener('input', () => { st[key] = parseFloat(inp.value); val.textContent = (+st[key]).toFixed(2); });
      current.appendChild(row); current.appendChild(inp);
    };
    for (const name of ['day', 'dusk', 'night']) {
      const st = S[name];
      const lbl = document.createElement('div'); lbl.className = 'row';
      lbl.innerHTML = '<span style="color:#8892a0;font-size:11px;text-transform:uppercase">' + name + '</span>';
      current.appendChild(lbl);
      colorRow('top', () => st.top, v => st.top = v);
      colorRow('horizon', () => st.horizon, v => st.horizon = v);
      colorRow('bottom', () => st.bottom, v => st.bottom = v);
      colorRow('glow', () => st.glow, v => st.glow = v);
      stateSlider(st, 'horizonHeight', 'horizon pos', -0.4, 0.4, 0.01);
      stateSlider(st, 'zenithSoftness', 'zenith softness', 0.1, 1.0, 0.01);
      stateSlider(st, 'glowWidth', 'glow width', 0.02, 0.4, 0.01);
      stateSlider(st, 'glowStrength', 'glow strength', 0, 1, 0.02);
    }
    // Sun -> time-of-day mapping (elevation anchors, degrees).
    const TH = skyRef.thresholds;
    const threshSlider = (key, label, min, max) => {
      const row = document.createElement('div'); row.className = 'row';
      const val = document.createElement('span'); val.textContent = (+TH[key]).toFixed(0) + '°';
      row.innerHTML = '<span style="color:#c4ccd6">' + label + '</span>'; row.appendChild(val);
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = 1; inp.value = TH[key];
      inp.addEventListener('input', () => { TH[key] = parseFloat(inp.value); val.textContent = (+TH[key]).toFixed(0) + '°'; });
      current.appendChild(row); current.appendChild(inp);
    };
    threshSlider('dayAbove', 'day above', 0, 30);
    threshSlider('duskPeak', 'dusk peak', -15, 15);
    threshSlider('nightBelow', 'night below', -30, 0);
    // Directional glow strength toward the sun (0 = even ring, 1 = concentrated).
    {
      const row = document.createElement('div'); row.className = 'row';
      const val = document.createElement('span'); val.textContent = '0.35';
      row.innerHTML = '<span style="color:#c4ccd6">glow toward sun</span>'; row.appendChild(val);
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = 0; inp.max = 1; inp.step = 0.02; inp.value = 0.35;
      inp.addEventListener('input', () => { const v = parseFloat(inp.value); val.textContent = v.toFixed(2); skyRef.setGlowDirectionality(v); });
      current.appendChild(row); current.appendChild(inp);
    }
    // Celestial opacity follows time of day (stars/Milky Way/bodies fade in at night).
    params.celestialFollowTime = false;
    toggle('celestialFollowTime', 'Celestial opacity follows time', () => skyRef.setCelestialOpacityMode(params.celestialFollowTime));
```

- [ ] **Step 2: Verify live**

Run: `python serve.py`
Open: `http://127.0.0.1:8080/environment-viewer.html`
Open the "Sky — time of day" section (Effects tab). Check each:
- Editing a state's **top/horizon/bottom/glow** color and moving the sun elevation into that state changes the dome color.
- **horizon pos / zenith softness / glow width / glow strength** sliders visibly change the gradient shape / glow.
- **day above / dusk peak / night below** sliders move where the transitions happen as the sun moves.
- **glow toward sun** slider concentrates the horizon glow toward the sun's azimuth (rotate the sun / camera to confirm it's directional, not a full ring).
- **Celestial opacity follows time** toggle: on → stars/bodies fade out in daylight and back in at night; off → constant opacity.
Expected: all live, no rebuild, no console errors.

- [ ] **Step 3: Commit**

```bash
git add environment-viewer.html
git commit -m "$(cat <<'EOF'
feat(sky): time-of-day sky color UI

Add a "Sky - time of day" panel: per-state (day/dusk/night) color inputs and
transition sliders, elevation-threshold sliders, a directional-glow slider, and
a celestial-opacity-follows-time toggle. All controls mutate live state/uniforms.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Docs + activity log

Required by `CLAUDE.md` (workshop-webgpu): update the affected subsystem doc and append one `agent_log.csv` row.

**Files:**
- Modify: `docs/subsystems/sky.md`
- Modify: `agent_log.csv`

- [ ] **Step 1: Update the sky.js Public API block**

In `docs/subsystems/sky.md`, replace the sky.js API paragraph (currently ~lines 33-37, the "Returns an object with:" sentence) with:

```md
Returns an object with: `group`, `setSunDir(v)`, `setPalette(o)`, `setCelestialType(type)`,
`setStarCount(n)`, `setStarOpacity(v)`, `setStarColor(hex)`, `setSunSize(v)`,
`setMilkyWayIntensity(v)`, `setSeed(n)`, `setRadius()`, `rebuild(r)`, `update()`,
`updateDome(elevationDeg)`, `setCelestialOpacityMode(on)`, `setGlowDirectionality(v)`,
`flushDisposals()`, `dispose()`, getters `radius`, `isMoon`, `nightness`, `skyStates`,
`thresholds`. `setStarOpacity`/`setStarColor` are live uniform writes (no rebuild), like
`setMilkyWayIntensity`. `updateDome(elevationDeg)` blends the day/dusk/night dome states by
sun elevation and writes uniforms only — never rebuilds. `nightness` (0 in day, 1 at night)
is the single shared "how dark is it" scalar; `setCelestialOpacityMode(true)` multiplies
star/Milky-Way/body opacity by it.
```

- [ ] **Step 2: Add the sky-field.js exports**

In `docs/subsystems/sky.md`, in the **sky-field.js** API code block (currently ~lines 40-53), add these lines before the closing ``` (after the `randomKindColor` line):

```md
export const DEFAULT_SKY_STATES   // { day, dusk, night } dome keyframes (colors + transition params)
export const DEFAULT_THRESHOLDS   // { dayAbove:8, duskPeak:0, nightBelow:-8 } sun-elevation anchors (deg)
export function makeSkyStates(overrides = {})            // per-state defaults-merge, fresh object
export function lerpHex(a, b, t)                         // RGB-space hex interpolation (exact endpoints)
export function domeParamsAtElevation(elevDeg, thresholds, states)  // blend adjacent states by elevation
export function nightnessAtElevation(elevDeg, thresholds)           // 1 - smoothstep(nightBelow, dayAbove)
```

- [ ] **Step 3: Rewrite the stale "Day/night palette system" architecture note**

In `docs/subsystems/sky.md`, replace the first architecture bullet (currently ~lines 121-127, the "**Day/night palette system**" bullet describing a single static palette) with:

```md
- **Time-of-day dome states**: the dome gradient is no longer a single static palette.
  `sky-field.js` defines three keyframed states — `DEFAULT_SKY_STATES.day` / `.dusk` /
  `.night` — each carrying dome colors (`top`/`horizon`/`bottom`/`glow`) and transition
  params (`horizonHeight`, `zenithSoftness`, `glowWidth`, `glowStrength`). `night`
  reproduces the historic `DEFAULT_PALETTE` look plus the constants that used to be baked
  into `sky.js`'s `colorNode` (`zenithSoftness 0.55`, `glowWidth ~= 1/9`, `glowStrength
  0.4`). Every frame the viewer calls `skyRef.updateDome(rig.elevation)`;
  `domeParamsAtElevation(elevDeg, thresholds, states)` blends the two ADJACENT states around
  the current sun elevation (day<->dusk above `duskPeak`, dusk<->night below it), clamping to
  `day` above `dayAbove` and `night` below `nightBelow` (`DEFAULT_THRESHOLDS = { dayAbove:8,
  duskPeak:0, nightBelow:-8 }` degrees). Because only adjacent, authored states ever blend,
  colors never take a muddy direct blue->red midpoint. The dome material is built once from
  a persistent uniform bundle (`makeDomeUniforms`: 4 color + 4 transition + `sunDir` +
  `glowDirectionality`), so `updateDome` and every slider are pure `.value` writes — the same
  no-rebuild discipline that protects the star/body path. `nightnessAtElevation` returns a
  monotonic 0(day)->1(night) scalar exposed as `skyRef.nightness`, the shared darkness source
  of truth; the "Celestial opacity follows time" toggle multiplies star/Milky-Way/body
  opacity by it. The still-single `DEFAULT_PALETTE` remains for the sun/moon disc colors,
  sizes, `celestialType`, and star/Milky-Way tuning; `makePalette(overrides)` still never
  mutates it.
- **Directional horizon glow**: the glow band in the dome `colorNode` is biased toward the
  sun's azimuth via `dot(normalize(pos.xz), normalize(uSunDir.xz))` mapped to `[0,1]` and
  mixed by `uGlowDirectionality` (0 = even ring, 1 = concentrated toward the sun). `sunDir`
  is updated in `setSunDir`.
```

- [ ] **Step 4: Add the tunables to the "Tunable parameters" section**

In `docs/subsystems/sky.md`, in the **Sky** tunables area (after the "Regeneration" list, ~line 297, before the "Star point *size*..." paragraph), insert:

```md

Time of day (`header('Sky — time of day')`, live — mutate `skyRef.skyStates` /
`skyRef.thresholds` in place, applied by the per-frame `updateDome`, no rebuild):
- Per state `day` / `dusk` / `night`: colour inputs `top` / `horizon` / `bottom` / `glow`
  and sliders `horizonHeight` (−0.4..0.4), `zenithSoftness` (0.1..1.0), `glowWidth`
  (0.02..0.4), `glowStrength` (0..1).
- Sun→time mapping: `dayAbove` (0..30°), `duskPeak` (−15..15°), `nightBelow` (−30..0°).
- `glow toward sun` (0..1) → `skyRef.setGlowDirectionality()`.
- `Celestial opacity follows time` (toggle) → `skyRef.setCelestialOpacityMode()`.
```

- [ ] **Step 5: Add the new test coverage note**

In `docs/subsystems/sky.md`, in the `test-sky-field.mjs` coverage list (the bullets under "## Tests", ~lines 318-341), add one bullet at the end of that list:

```md
- Time-of-day blend math: `makeSkyStates` (per-state defaults-merge, fresh object), `lerpHex`
  (exact endpoints, componentwise midpoint, identity), `domeParamsAtElevation` (exact state
  params at each anchor, interpolation between adjacent states, clamping outside the range,
  determinism), and `nightnessAtElevation` (0 at/above `dayAbove`, 1 at/below `nightBelow`,
  monotonic across the band).
```

- [ ] **Step 6: Append the activity-log row**

Add exactly one new line at the end of `agent_log.csv`:

```
2026-07-12T00:00,sky,sky-field.js;sky.js;environment-viewer.html;test-sky-field.mjs;docs/subsystems/sky.md,Add time-of-day dome color system: day/dusk/night states blended by sun elevation via GPU uniforms (no rebuild) plus directional horizon glow nightness scalar and live UI.
```

(Replace `00:00` with the actual current `HH:MM` when running.)

- [ ] **Step 7: Verify tests still pass and commit**

Run: `node test-sky-field.mjs`
Expected: PASS (`all passed`).

```bash
git add docs/subsystems/sky.md agent_log.csv
git commit -m "$(cat <<'EOF'
docs(sky): document time-of-day dome states, nightness, tunables

Update sky.md API/architecture/tunables/tests for the state-blend dome, uniform
rendering, nightness interface, and new UI; append agent_log.csv row.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review (completed while writing)

- **Spec coverage:** §1 data model → Task 1 (`DEFAULT_SKY_STATES`/`makeSkyStates`/`domeParamsAtElevation`/`nightnessAtElevation`/`lerpHex`). §2 uniform dome + `updateDome` → Task 2. §3 directional glow → Task 2 (`colorNode` `align` term + `setGlowDirectionality`) and Task 4 slider. §4 nightness→celestial opacity → Task 2 (`nightness` getter, `setCelestialOpacityMode`, `applyDome` fade) + Task 4 toggle; coordination note preserved (nightness is the single shared scalar). §5 UI → Task 4. §6 file-by-file → Tasks 1-5. §7 testing → Task 1 test block. All spec sections map to a task.
- **Type/name consistency:** `skyStates`/`thresholds`/`domeU`/`applyDome`/`elevFromDir`/`bodiesGroup`/`celestialFollowTime`/`_nightness` are defined once in Task 2 and used consistently; `updateDome`/`setCelestialOpacityMode`/`setGlowDirectionality`/`nightness`/`skyStates`/`thresholds` names match across sky.js (Task 2), the viewer wiring (Task 3), the UI (Task 4), and the doc (Task 5). `glowWidth ≈ 0.11` maps the historic `1 - |y|*9` falloff (`abs(y).div(glowWidth)`), consistent with the spec.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code; the only fill-in is the real `HH:MM` timestamp in the log row (explicitly flagged).
- **Scope:** single subsystem (sky), one plan.
