# Vegetation Variety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two vegetation features from `docs/superpowers/specs/2026-07-02-vegetation-variety-design.md`: (A) 5 selectable procedural blade-fiber textures for grass, and (B) 4 species of procedural, GPU-instanced understory plants (chickweed, cleavers, mint, jewelweed), built on a parameterized `plants.js` data model so a future `plant-viewer.html` can expose every knob with no rework.

**Architecture:** Part A bakes 5 canvas-drawn fiber styles into one texture atlas, samples it per-blade via a new `aBladeUV` attribute already shared by `grass.js`/`grass-compute.js`, and exposes a live style switch. Part B adds a `PLANT_DEFAULTS`/`PLANT_PRESETS`/`buildPlantGeometry(opts)` generator (`plants.js`), a biome-gated placement function (`plants-placement.js`, reusing `forest-placement.js`'s RNG), and a single-LOD storage-buffer instancing module (`plants-gpu.js`) that mirrors `forest-gpu.js`'s reset→cull→finalize→indirect-draw spine but without the 4-band LOD split (plants use one distance cull radius, one mesh per variant).

**Tech Stack:** Three.js r0.184 WebGPU backend, TSL (`three/tsl`, `three/webgpu`), plain Node test scripts (no framework), no bundler.

---

## Part A: Grass blade fiber textures

### Task 1: Add per-blade local UV attribute to the shared blade template

**Files:**
- Modify: `grass.js:298-324` (`buildBladeGeometry`)
- Test: `test-grass-blade-uv.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test-grass-blade-uv.mjs
import { buildBladeGeometry } from './grass.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL ') + m); if (!c) fail++; };

const geom = buildBladeGeometry();
const uv = geom.getAttribute('aBladeUV');
ok(!!uv, 'geometry has an aBladeUV attribute');
ok(uv.itemSize === 2, 'aBladeUV is a vec2');
ok(uv.count === 5, 'one aBladeUV per blade vertex (BL,BR,TR,TL,TC)');
// [BL, BR, TR, TL, TC] per grass.js's fixed vertex order
const expected = [0,0, 1,0, 0.75,0.85, 0.25,0.85, 0.5,1];
let matches = true;
for (let i = 0; i < 10; i++) if (Math.abs(uv.array[i] - expected[i]) > 1e-6) matches = false;
ok(matches, 'aBladeUV matches the taper: BL(0,0) BR(1,0) TR(.75,.85) TL(.25,.85) TC(.5,1)');

console.log(fail ? fail + ' FAIL' : 'ALL PASS'); process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-grass-blade-uv.mjs`
Expected: `FAIL geometry has an aBladeUV attribute` (attribute doesn't exist yet), exits 1.

- [ ] **Step 3: Add the attribute in `buildBladeGeometry`**

In `grass.js`, `buildBladeGeometry` currently builds `pos`/`wnd`/`hgt` in a `for (let k = 0; k < 5; k++)` loop (lines 313-317). Add a parallel `aBladeUV` array using the fixed per-vertex layout (`u`: 0=left edge→1=right edge; `v`: 0=base→1=tip, mid vertices at `v=0.85` to match the actual TR/TL height of `h*0.5` relative to tip):

```js
// grass.js — inside buildBladeGeometry(opts = {}), replace the vertex-building block:
export function buildBladeGeometry(opts = {}) {
  const bladeWidth = opts.bladeWidth ?? DEFAULTS.bladeWidth;
  const bladeHeight = opts.bladeHeight ?? DEFAULTS.bladeHeight;
  const tipOffset = opts.tipOffset ?? DEFAULTS.tipOffset;
  const halfW = bladeWidth * 0.5, midW = bladeWidth * 0.25, h = bladeHeight;
  const ox = [-halfW, halfW, midW, -midW, tipOffset];
  const oy = [0, 0, h * 0.5, h * 0.5, h];
  // [BL, BR, TR, TL, TC] local UV for the fiber-texture atlas: u across width, v base->tip.
  const bladeUvTable = [0, 0, 1, 0, 0.75, 0.85, 0.25, 0.85, 0.5, 1];
  const pos = new Float32Array(5 * 3);
  const wnd = new Float32Array(5);
  const hgt = new Float32Array(5);
  const buv = new Float32Array(bladeUvTable);
  for (let k = 0; k < 5; k++) {
    pos[k * 3] = ox[k]; pos[k * 3 + 1] = oy[k]; pos[k * 3 + 2] = 0;
    wnd[k] = WIND_WEIGHT[k];
    hgt[k] = oy[k];
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('aWind', new THREE.BufferAttribute(wnd, 1));
  geom.setAttribute('aHeight', new THREE.BufferAttribute(hgt, 1));
  geom.setAttribute('aBladeUV', new THREE.BufferAttribute(buv, 2));
  geom.setIndex(new THREE.BufferAttribute(new Uint16Array(BLADE_INDICES), 1));
  return geom;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-grass-blade-uv.mjs`
Expected: `ALL PASS`, exits 0.

- [ ] **Step 5: Verify no existing test regressed**

Run: `node test-grass-wind.mjs && node test-forest-gpu-rebuild.mjs`
Expected: both `ALL PASS` / `0 failed` — `buildBladeGeometry` is also called by `grass-compute.js`, so confirm nothing downstream assumed exactly 3 attributes.

- [ ] **Step 6: Commit**

```bash
git add grass.js test-grass-blade-uv.mjs
git commit -m "feat(vegetation): add per-blade local UV attribute to the shared blade template"
```

### Task 2: `grass-textures.js` — pure fiber-style math + atlas bake

**Design note:** TSL's `texture()` node binds to one texture at shader-graph-build time; it can't switch which texture object it samples based on a runtime uniform. So instead of 5 separate textures, all 5 styles are baked side-by-side into ONE atlas texture (5 tiles in a row), and the live style switch just shifts the sampled U range by `styleIndex / 5` — one texture binding, one sample, no shader recompile. This refines (doesn't contradict) the spec's "bake each style to a small tile" — same 5 styles, same math, one runtime-switchable texture object instead of 5.

**Files:**
- Create: `grass-textures.js`
- Test: `test-grass-textures.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test-grass-textures.mjs
import { FIBER_STYLES, STYLE_KEYS, clamp01 } from './grass-textures.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL ') + m); if (!c) fail++; };

ok(STYLE_KEYS.length === 5, 'exactly 5 fiber styles');
ok(STYLE_KEYS.join(',') === 'streaks,dryTip,mottle,vein,highContrast', 'the 5 approved style keys, in order');

// every style's fiber() stays within a sane multiplier range across the UV domain
for (const key of STYLE_KEYS) {
  let inRange = true, allFinite = true;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const v = FIBER_STYLES[key].fiber(i / 10, j / 10, 0.5);
    if (!Number.isFinite(v)) allFinite = false;
    if (v < 0.35 || v > 1.45) inRange = false;
  }
  ok(allFinite, `${key}: fiber() always finite`);
  ok(inRange, `${key}: fiber() stays within [0.35, 1.45]`);
}

// dryTip's dryness ramps up toward the tip (v=1) and is ~0 at the base (v=0), by design
// (clamp01((v-0.55)/0.45) is exactly 0 for v<=0.55) — this is the one style whose tint()
// is deliberately monotonic in v; highContrast's tint is speckle-based, not monotonic,
// so it's only range-checked below, not asserted monotonic.
const dryBase = FIBER_STYLES.dryTip.tint(0.5, 0.0, 0.5);
const dryTip = FIBER_STYLES.dryTip.tint(0.5, 0.95, 0.5);
ok(dryBase === 0, 'dryTip: tint is exactly 0 at the blade base (v=0)');
ok(dryTip > 0, 'dryTip: tint is nonzero near the tip (v=0.95)');

// highContrast.tint() is speckle-based (not monotonic in v) but must stay in [0,1]
let hcInRange = true;
for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
  const t = FIBER_STYLES.highContrast.tint(i / 10, j / 10, 0.5);
  if (t < 0 || t > 1) hcInRange = false;
}
ok(hcInRange, 'highContrast: tint() stays within [0,1]');

// styles without a tint() are fine to omit it (grass.js treats missing tint as 0)
ok(FIBER_STYLES.streaks.tint === undefined, 'streaks has no tint()');
ok(FIBER_STYLES.mottle.tint === undefined, 'mottle has no tint()');
ok(FIBER_STYLES.vein.tint === undefined, 'vein has no tint()');

ok(clamp01(-0.4) === 0 && clamp01(1.6) === 1 && clamp01(0.3) === 0.3, 'clamp01 clamps to [0,1]');

console.log(fail ? fail + ' FAIL' : 'ALL PASS'); process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-grass-textures.mjs`
Expected: `Cannot find module './grass-textures.js'` — file doesn't exist yet.

- [ ] **Step 3: Create `grass-textures.js`**

Ported directly from the validated `grass-texture-mockup.html` prototype (same `fbm`/`hash`/`noise2D` math, same 5 style formulas), plus the atlas-bake step:

```js
// grass-textures.js
// Procedurally-synthesized per-blade "fiber" textures for grass.js/grass-compute.js —
// not photographic. FIBER_STYLES is pure math (Node-testable); createGrassStyleAtlas()
// bakes all 5 into one canvas atlas (5 tiles side by side) so the live style switch is a
// single uniform write, not a texture-binding change. Ported from grass-texture-mockup.html.
import * as THREE from 'three';

const TILE_SIZE = 64;
export const FIBER_REMAP_MIN = 0.4;   // fiber() multiplier range encoded into the atlas' R channel
export const FIBER_REMAP_MAX = 1.4;

function hash(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function noise2D(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}
function fbm(x, y, oct = 3) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < oct; i++) { sum += amp * noise2D(x * freq, y * freq); amp *= 0.5; freq *= 2.1; }
  return sum;
}
export function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// fiber(u,v,seed) -> brightness multiplier (~0.4..1.4). tint(u,v,seed) (optional) -> 0..1
// dryness/speckle amount, blended toward a fixed dry-brown in grass.js's colorNode.
export const FIBER_STYLES = {
  streaks: {
    fiber(u, v, seed) {
      const wobble = fbm(u * 3 + seed, v * 1.5, 2) * 0.06;
      return 1 + Math.sin((u + wobble) * Math.PI * 22) * 0.14;
    },
  },
  dryTip: {
    fiber(u, v, seed) {
      return 1 + Math.sin(u * Math.PI * 20 + fbm(u * 4 + seed, v * 2, 2) * 1.2) * 0.12;
    },
    tint(u, v, seed) {
      return clamp01((v - 0.55) / 0.45) * (0.5 + 0.5 * fbm(u * 5 + seed, 9 + seed, 2));
    },
  },
  mottle: {
    fiber(u, v, seed) {
      return 1 + (fbm(u * 5 + seed, v * 6 + seed, 3) - 0.5) * 0.28;
    },
  },
  vein: {
    fiber(u, v, seed) {
      const distFromCenter = Math.abs(u - 0.5);
      const veinBright = 1 - Math.min(1, distFromCenter / 0.06);
      const band = Math.sin((u + fbm(seed, v * 2, 2) * 0.1) * Math.PI * 6) * 0.08;
      return 1 + veinBright * 0.22 + band;
    },
  },
  highContrast: {
    fiber(u, v, seed) {
      const s = Math.sin(u * Math.PI * 16 + fbm(u * 6 + seed, v * 3, 2) * 1.5);
      const speck = fbm(u * 14 + seed * 3, v * 14 + seed * 3, 2) > 0.72 ? -0.3 : 0;
      return 1 + s * 0.22 + speck;
    },
    tint(u, v, seed) {
      return clamp01(fbm(u * 14 + seed * 3, v * 14 + seed * 3, 2) - 0.55) * 2;
    },
  },
};
export const STYLE_KEYS = ['streaks', 'dryTip', 'mottle', 'vein', 'highContrast'];

// Bakes all 5 styles into one TILE_SIZE*5 x TILE_SIZE canvas atlas. R = fiber multiplier
// remapped to 0..1 (decode: FIBER_REMAP_MIN + r*(FIBER_REMAP_MAX-FIBER_REMAP_MIN)),
// G = tint amount 0..1 (0 for styles with no tint()). Call once at grass-module init.
export function createGrassStyleAtlas() {
  const n = STYLE_KEYS.length;
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE * n;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(TILE_SIZE * n, TILE_SIZE);
  const seed = 0.5;
  STYLE_KEYS.forEach((key, styleIdx) => {
    const style = FIBER_STYLES[key];
    for (let py = 0; py < TILE_SIZE; py++) {
      const v = py / TILE_SIZE;
      for (let px = 0; px < TILE_SIZE; px++) {
        const u = px / TILE_SIZE;
        const fiberMul = style.fiber(u, v, seed);
        const r = clamp01((fiberMul - FIBER_REMAP_MIN) / (FIBER_REMAP_MAX - FIBER_REMAP_MIN));
        const g = style.tint ? clamp01(style.tint(u, v, seed)) : 0;
        const atlasPx = styleIdx * TILE_SIZE + px;
        const idx = (py * TILE_SIZE * n + atlasPx) * 4;
        img.data[idx] = r * 255;
        img.data[idx + 1] = g * 255;
        img.data[idx + 2] = 0;
        img.data[idx + 3] = 255;
      }
    }
  });
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-grass-textures.mjs`
Expected: `ALL PASS`, exits 0. (Note: this only exercises `FIBER_STYLES`/`STYLE_KEYS`/`clamp01` — `createGrassStyleAtlas()` touches `document.createElement`, which isn't called by this test and isn't Node-safe; that's expected and fine, matching Task 4's lazy-singleton design below.)

- [ ] **Step 5: Commit**

```bash
git add grass-textures.js test-grass-textures.mjs
git commit -m "feat(vegetation): add grass-textures.js with 5 procedural fiber styles baked to one atlas"
```

### Task 3: Wire the style atlas into `grass.js`

**Files:**
- Modify: `grass.js` (imports, `DEFAULTS`, `buildMaterial`, `Grass` class)

- [ ] **Step 1: Add the import and a lazy atlas singleton**

The CPU grass path (`makeChunkGrassManager` in `environment-viewer.html`) creates one `Grass` instance **per chunk**, so `buildMaterial()` runs many times. Baking the atlas inside `buildMaterial()` would re-bake it per chunk. Bake it once, lazily, at module scope — lazy (not eager at import time) because `test-grass-wind.mjs` already imports this whole module in Node today and must keep working; an eager `document.createElement` call at import time would break it.

In `grass.js`, near the top (after the existing imports, before `DEFAULTS`):

```js
import { createGrassStyleAtlas, FIBER_REMAP_MIN, FIBER_REMAP_MAX, STYLE_KEYS } from './grass-textures.js';
import { texture } from 'three/tsl';

let _grassStyleAtlas = null;
function getGrassStyleAtlas() {
  if (!_grassStyleAtlas) _grassStyleAtlas = createGrassStyleAtlas();
  return _grassStyleAtlas;
}
```

- [ ] **Step 2: Add `bladeStyle` to `DEFAULTS`**

In the `DEFAULTS` object (around line 41-69), add one field near the color fields:

```js
  baseColor: 0x16240e,     // dark green at the blade base (also reads as ambient occlusion)
  tipColor: 0x5a8a32,      // brighter green at the tip
  bladeStyle: 'streaks',   // one of grass-textures.js's STYLE_KEYS; live-swappable via setBladeStyle()
```

- [ ] **Step 3: Sample the atlas in `buildMaterial` and blend into `colorNode`**

In `buildMaterial(o)`, add the attribute + uniform near the existing `aWind`/`aHeight` attributes (~line 400-402):

```js
  const aWind   = attribute('aWind',   'float');
  const aHeight = attribute('aHeight', 'float');
  const aBladeUV = attribute('aBladeUV', 'vec2');
  const uBladeStyle = uniform(Math.max(0, STYLE_KEYS.indexOf(o.bladeStyle)), 'float');
```

Then replace the `colorNode` construction (currently `const grassColor = mix(uBaseColor, uTipColor, aWind); const colorNode = grassColor.mul(uAmbient.add(uKey)).mul(cloud);`) with:

```js
  // ---- fiber-texture sample: atlas is STYLE_KEYS.length tiles in a row; uBladeStyle
  // shifts which tile's U range aBladeUV.x reads from, so switching styles is one
  // uniform write, no shader recompile / texture rebind.
  const numStyles = float(STYLE_KEYS.length);
  const atlasUv = vec2(uBladeStyle.add(aBladeUV.x).div(numStyles), aBladeUV.y);
  const styleSample = texture(getGrassStyleAtlas(), atlasUv);
  const fiberMul = float(FIBER_REMAP_MIN).add(styleSample.r.mul(FIBER_REMAP_MAX - FIBER_REMAP_MIN));
  const dryColor = vec3(120 / 255, 96 / 255, 40 / 255);

  const grassColorBase = mix(uBaseColor, uTipColor, aWind).mul(fiberMul);
  const grassColor = mix(grassColorBase, dryColor, styleSample.g.mul(0.7));
  const colorNode  = grassColor.mul(uAmbient.add(uKey)).mul(cloud);
```

- [ ] **Step 4: Store the uniform handle and add `setBladeStyle`**

Near the other `mat._uXxx =` assignments in `buildMaterial` (~line 472-481), add:

```js
  mat._uBladeStyle  = uBladeStyle;
```

In the `Grass` class, next to `setAmbient`/`setKey` (~line 501-502), add:

```js
  setBladeStyle(key) {
    const idx = STYLE_KEYS.indexOf(key);
    if (idx < 0) return;
    this.options.bladeStyle = key;
    this.material._uBladeStyle.value = idx;
  }
```

- [ ] **Step 5: Verify existing tests still pass, then eyeball it**

Run: `node test-grass-wind.mjs && node test-grass-blade-uv.mjs && node test-grass-textures.mjs`
Expected: all `ALL PASS`.

Run: `python serve.py 8080`, open `http://127.0.0.1:8080/environment-viewer.html?grass=cpu`. Grass should render with a visible (subtle) fiber pattern instead of a flat gradient. Since `setBladeStyle` isn't wired to UI yet (Task 6), verify from devtools console: `grassRef` isn't exposed globally, so this is a visual sanity check only — full style-switch verification happens in Task 6.

- [ ] **Step 6: Commit**

```bash
git add grass.js
git commit -m "feat(vegetation): sample the fiber-style atlas in grass.js's colorNode"
```

### Task 4: Wire the same style atlas into `grass-compute.js`

**Files:**
- Modify: `grass-compute.js` (imports, `colorNode` construction, returned API)

`grass-compute.js` already imports `buildBladeGeometry` from `grass.js` (line 28) and calls it unmodified (line 340: `const geom = buildBladeGeometry();`), so the `aBladeUV` attribute from Task 1 is already present on `geom` — no change needed there. This task only adds the atlas sample to this module's own `colorNode`.

- [ ] **Step 1: Add the import**

Near the top of `grass-compute.js`, alongside the existing `import { buildBladeGeometry, buildGrassNoiseFns } from './grass.js';` (line 28):

```js
import { createGrassStyleAtlas, FIBER_REMAP_MIN, FIBER_REMAP_MAX, STYLE_KEYS } from './grass-textures.js';
```

`texture` is already imported in this file (line 26, used for `heightTex`/`densityTex`), so no new TSL import is needed.

- [ ] **Step 2: Reuse the same lazy-singleton atlas getter**

`grass.js` already owns a module-scope lazy atlas singleton (Task 3, Step 1) but doesn't export it. Rather than baking a second copy here, export it from `grass.js`:

In `grass.js`, change `function getGrassStyleAtlas()` to `export function getGrassStyleAtlas()`.

In `grass-compute.js`, add to the existing `grass.js` import line:

```js
import { buildBladeGeometry, buildGrassNoiseFns, getGrassStyleAtlas } from './grass.js';
```

- [ ] **Step 3: Sample it in `createComputeGrass`'s color construction**

Replace the existing block (lines 363-369):

```js
  const { noise2D } = buildGrassNoiseFns();
  const uBaseColor = uniform(new THREE.Color(0x16240e));
  const uTipColor  = uniform(new THREE.Color(0x5a8a32));
  const uAmbient = uniform(0.55), uKey = uniform(0.55);
  const uCloudStr = uniform(0.35), uCloudScale = uniform(0.02);
  const cloud = float(1).sub(uCloudStr.mul(noise2D(vec2(base.x, base.z).mul(uCloudScale))));
  const colorNode = mix(uBaseColor, uTipColor, aWind).mul(uAmbient.add(uKey)).mul(cloud);
```

with:

```js
  const { noise2D } = buildGrassNoiseFns();
  const uBaseColor = uniform(new THREE.Color(0x16240e));
  const uTipColor  = uniform(new THREE.Color(0x5a8a32));
  const uAmbient = uniform(0.55), uKey = uniform(0.55);
  const uCloudStr = uniform(0.35), uCloudScale = uniform(0.02);
  const cloud = float(1).sub(uCloudStr.mul(noise2D(vec2(base.x, base.z).mul(uCloudScale))));

  const aBladeUV = attribute('aBladeUV', 'vec2');
  const uBladeStyle = uniform(Math.max(0, STYLE_KEYS.indexOf(opts.bladeStyle || 'streaks')), 'float');
  const numStyles = float(STYLE_KEYS.length);
  const atlasUv = vec2(uBladeStyle.add(aBladeUV.x).div(numStyles), aBladeUV.y);
  const styleSample = texture(getGrassStyleAtlas(), atlasUv);
  const fiberMul = float(FIBER_REMAP_MIN).add(styleSample.r.mul(FIBER_REMAP_MAX - FIBER_REMAP_MIN));
  const dryColor = vec3(120 / 255, 96 / 255, 40 / 255);
  const grassColorBase = mix(uBaseColor, uTipColor, aWind).mul(fiberMul);
  const grassColor = mix(grassColorBase, dryColor, styleSample.g.mul(0.7));
  const colorNode = grassColor.mul(uAmbient.add(uKey)).mul(cloud);
```

- [ ] **Step 4: Expose `setBladeStyle` on the returned API**

In the object returned from `createComputeGrass` (~line 448-540), alongside `setWind` (line 525), add:

```js
    setBladeStyle(key) {
      const idx = STYLE_KEYS.indexOf(key);
      if (idx < 0) return;
      uBladeStyle.value = idx;
    },
```

- [ ] **Step 5: Verify existing tests still pass**

Run: `node test-grass-anchors.mjs && node test-grass-cells.mjs && node test-grass-height-tsl.mjs`
Expected: all pass — none of these touch color construction, so this is a regression check that the new imports/attribute didn't break module load.

- [ ] **Step 6: Commit**

```bash
git add grass.js grass-compute.js
git commit -m "feat(vegetation): sample the fiber-style atlas in grass-compute.js, export shared atlas getter"
```

### Task 5: UI — blade style selector in both grass control panels

**Files:**
- Modify: `environment-viewer.html:2233-2237` (CPU grass block), `environment-viewer.html:2283-2291` (GPU grass block)

- [ ] **Step 1: Add the control to the CPU grass block**

The CPU path's `grassRef` object doesn't currently expose a per-chunk style setter (each chunk is a separate `Grass` instance in the `chunks` Map inside `makeChunkGrassManager`). Add one, then wire the UI control.

In `environment-viewer.html`, inside `makeChunkGrassManager()`'s returned object (line 2222-2229), add a `setBladeStyle` alongside the existing `setWind`:

```js
      return {
        sync,
        update: seconds => { processQueue(); for (const grass of chunks.values()) grass.update(seconds); },
        regenerate: () => sync(true),
        setWind: strength => { for (const grass of chunks.values()) grass.setWind(strength); },
        setBladeStyle: key => { params.grassBladeStyle = key; for (const grass of chunks.values()) grass.setBladeStyle(key); },
        applyFade,
      };
```

Then, right after the existing CPU grass sliders (line 2234-2237), add:

```js
    slider('grassCount', 'Blade count', 0, 1200000, 1000, v => (v / 1000) + 'k', grassRebuild);
    if (loadedMap) slider('mapGrassRadiusChunks', 'Extent (chunks)', 0, 12, 1, drawFmt, grassRebuild);
    slider('grassDistanceCull', 'Distance cull (far fade)', 0, 1, 0.01, f2, () => grassRef.applyFade());
    slider('wind', 'Wind strength', 0, 2.5, 0.01, f2, () => grassRef.setWind(params.wind));
    params.grassBladeStyle = 'streaks';
    select('grassBladeStyle', 'Blade texture', ['streaks', 'dryTip', 'mottle', 'vein', 'highContrast'], () => grassRef.setBladeStyle(params.grassBladeStyle));
```

Also apply the style to each newly-built chunk in `buildGrassJob` (line 2177-2203), right after `grass.setWind(params.wind);` (line 2191):

```js
        grass.setWind(params.wind);
        grass.setBladeStyle(params.grassBladeStyle ?? 'streaks');
```

- [ ] **Step 2: Add the control to the GPU grass block**

Right after the existing GPU grass sliders (line 2284-2291), add:

```js
    slider('grassVerticalOffset', 'Vertical offset', -2.0, 2.0, 0.01, f2, () => cg.setVerticalOffset(params.grassVerticalOffset));
    slider('wind', 'Wind strength', 0, 2.5, 0.01, f2, () => cg.setWind(params.wind));
    params.grassBladeStyle = 'streaks';
    select('grassBladeStyle', 'Blade texture', ['streaks', 'dryTip', 'mottle', 'vein', 'highContrast'], () => cg.setBladeStyle(params.grassBladeStyle));
```

- [ ] **Step 3: Manual verification**

Run: `python serve.py 8080`, open `http://127.0.0.1:8080/environment-viewer.html` (GPU grass, default) and separately `?grass=cpu` (CPU grass). In each, open the Grass panel, confirm a "Blade texture" dropdown with all 5 style names appears, and confirm changing it visibly changes the grass field's texture (subtle streaks vs. mottled vs. dry-tip browning etc.) without a page reload or visible hitch.

- [ ] **Step 4: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(vegetation): add live blade-texture style selector to both grass control panels"
```

---

## Part B: Procedural understory plants

**Scope note on geometry fidelity:** `buildPlantGeometry` below is a first-pass, fully-working, parameterized generator that satisfies every schema field from the design spec (leaf shape/style/leaflet count+parity/arrangement/serration/variegation/colors). It is a genuine port of the mockups' *structural logic* (whorl separation, decussate/alternate arrangement, serration depth tuning) rendered as real 3D triangles rather than canvas paths — it is not a pixel-exact reproduction of the canvas mockups' shading. Fine visual tuning (exact proportions, curve smoothness) is expected as a normal follow-up once the generator exists and can be iterated on live in the viewer, the same way `trees.js` was tuned after it existed.

### Task 6: `plants.js` — `PLANT_DEFAULTS`, `merge()`, `PLANT_PRESETS` data

**Files:**
- Create: `plants.js`
- Test: `test-plants-defaults.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test-plants-defaults.mjs
import { PLANT_DEFAULTS, PLANT_PRESETS, PLANT_BIOME_TAGS } from './plants.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL ') + m); if (!c) fail++; };

ok(PLANT_DEFAULTS.leaf.style === 'simple', 'default leaf style is simple');
ok(PLANT_DEFAULTS.leaf.arrangement === 'opposite', 'default arrangement is opposite');
ok(PLANT_DEFAULTS.leaf.serration.teeth === 0, 'default serration is smooth (0 teeth)');
ok(PLANT_DEFAULTS.leaf.variegation.enabled === false, 'variegation off by default');

const keys = Object.keys(PLANT_PRESETS);
ok(keys.length === 4, 'exactly 4 launch presets');
ok(keys.includes('chickweed') && keys.includes('cleavers') && keys.includes('mint') && keys.includes('jewelweed'), 'the 4 named species');

ok(PLANT_PRESETS.cleavers.leaf.style === 'complex', 'cleavers uses a compound leaf');
ok(PLANT_PRESETS.cleavers.leaf.arrangement === 'whorl', 'cleavers leaflets are whorled');
ok(PLANT_PRESETS.cleavers.leaf.leafletCount >= 7, 'cleavers has 7+ leaflets per whorl');
ok(PLANT_PRESETS.mint.leaf.serration.teeth > 0 && PLANT_PRESETS.mint.leaf.serration.depth > 0, 'mint leaves are serrated');
ok(PLANT_PRESETS.jewelweed.leaf.arrangement === 'alternate', 'jewelweed leaves are alternate');
ok(PLANT_PRESETS.chickweed.flower.shape === 'star', 'chickweed has a star flower');
ok(PLANT_PRESETS.jewelweed.flower.shape === 'pouch', 'jewelweed has a pouch flower');

ok(PLANT_BIOME_TAGS.cleavers.biomes.length === 0, 'cleavers is a biome generalist (empty allowlist = matches anywhere)');
ok(PLANT_BIOME_TAGS.jewelweed.biomes.includes('swamp'), 'jewelweed prefers damp biomes');

console.log(fail ? fail + ' FAIL' : 'ALL PASS'); process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-plants-defaults.mjs`
Expected: `Cannot find module './plants.js'`.

- [ ] **Step 3: Create `plants.js` with the data model (no geometry yet)**

```js
// plants.js
// Procedural understory plants: one parameterized generator (buildPlantGeometry) driven by
// a PLANT_DEFAULTS-shaped opts object, with the 4 launch species as PLANT_PRESETS overrides
// -- mirrors trees.js's DEFAULTS/createTree(opts) shape so a future plant-viewer.html (like
// tree-viewer.html) can expose every field (leaf shape/style/leaflet count+parity/
// arrangement/serration/variegation/colors) with no changes to this file.
import * as THREE from 'three';

export const PLANT_DEFAULTS = {
  seed: 1,
  stem: {
    nodes: [6, 6],           // [min,max] node count along the stem (inclusive-ish, randomized per plant)
    nodeSpacing: [8, 14],    // gap between nodes, in "mockup px"-equivalent units (see UNIT in Task 7)
    branchProb: 0,           // 0 = single stem; >0 = chance a side branch starts at a node (not yet consumed by geometry; reserved for a future preset)
    sprawl: 0,                // 0 = upright growth, 1 = low sprawling/prostrate growth
  },
  leaf: {
    shape: 'oval',             // 'oval' | 'lance' | 'star' -- base card silhouette before serration is cut in
    style: 'simple',           // 'simple' = one leaf blade per node | 'complex' = compound, built from leafletCount leaflets
    leafletCount: 1,           // only meaningful when style === 'complex'
    leafletParity: 'odd',      // 'odd' = has a terminal leaflet | 'even' = paired leaflets only
    arrangement: 'opposite',   // 'alternate' | 'opposite' | 'whorl' -- phyllotaxy along the stem
    whorlCount: 1,             // only meaningful when arrangement === 'whorl'
    serration: { teeth: 0, depth: 0 },   // teeth=0 -> smooth margin
    variegation: { enabled: false, pattern: 'edge', color: 0xffffff, amount: 0 }, // 'edge' | 'vein' | 'blotch'
    size: [10, 20],           // leaf length range, "mockup px"-equivalent units
    color: 0x3f6b2a,
    veinColor: null,          // null = no visible midrib line; set a hex to enable one
  },
  flower: {
    enabled: false,
    shape: 'star',             // 'star' | 'whorlBall' | 'pouch' | 'burPair'
    petals: 5,
    frequency: 1,               // fraction of eligible (upper-stem) nodes that get a flower
    color: 0xf4f1e6,
    throatColor: null,          // pale "opening" patch; used by pouch-shaped flowers
  },
};

// deep-merge user options over defaults (arrays/primitives replace; plain objects merge) --
// same convention as trees.js/grass.js's merge().
function merge(base, over) {
  if (over == null) return base;
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    const b = base[k], o = over[k];
    const bothPlainObjects = b && typeof b === 'object' && !Array.isArray(b)
      && o && typeof o === 'object' && !Array.isArray(o);
    out[k] = bothPlainObjects ? merge(b, o) : (o !== undefined ? o : b);
  }
  return out;
}
export { merge as mergePlantOpts };

export const PLANT_PRESETS = {
  chickweed: {
    stem: { nodes: [6, 8], nodeSpacing: [8, 12], branchProb: 0, sprawl: 1 },
    leaf: {
      shape: 'oval', style: 'simple', arrangement: 'opposite',
      serration: { teeth: 0, depth: 0 },
      size: [6, 10], color: 0x4c7a34, veinColor: null,
    },
    flower: { enabled: true, shape: 'star', petals: 10, frequency: 0.25, color: 0xf4f1e6, throatColor: 0xf9e77a },
  },
  cleavers: {
    stem: { nodes: [5, 5], nodeSpacing: [22, 28], branchProb: 0, sprawl: 0.15 },
    leaf: {
      shape: 'lance', style: 'complex', leafletCount: 7, leafletParity: 'odd',
      arrangement: 'whorl', whorlCount: 7,
      serration: { teeth: 0, depth: 0 },
      size: [7, 9], color: 0x4a7a3a, veinColor: null,
    },
    flower: { enabled: true, shape: 'burPair', petals: 2, frequency: 1, color: 0x5e8a44, throatColor: null },
  },
  mint: {
    stem: { nodes: [7, 7], nodeSpacing: [10, 14], branchProb: 0, sprawl: 0 },
    leaf: {
      shape: 'oval', style: 'simple', arrangement: 'opposite',
      serration: { teeth: 6, depth: 0.58 },
      size: [9, 13], color: 0x3d6b2e, veinColor: 0x2a4d20,
    },
    flower: { enabled: true, shape: 'whorlBall', petals: 12, frequency: 0.5, color: 0x8a6fb0, throatColor: null },
  },
  jewelweed: {
    stem: { nodes: [8, 8], nodeSpacing: [10, 14], branchProb: 0.3, sprawl: 0 },
    leaf: {
      shape: 'oval', style: 'simple', arrangement: 'alternate',
      serration: { teeth: 5, depth: 0.4 },
      size: [8, 12], color: 0x4f8a3d, veinColor: null,
    },
    flower: { enabled: true, shape: 'pouch', petals: 1, frequency: 0.4, color: 0xe8922e, throatColor: 0xfcd9a0 },
  },
};

// Placement metadata: biomes empty array = matches every biome (a generalist, like
// cleavers); density weights candidates the same way forest-placement.js's speciesTable does.
export const PLANT_BIOME_TAGS = {
  chickweed: { biomes: ['plains', 'forest'], density: 1 },
  cleavers:  { biomes: [], density: 0.6 },
  mint:      { biomes: ['plains', 'swamp', 'forest'], density: 1 },
  jewelweed: { biomes: ['swamp', 'forest'], density: 0.8 },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-plants-defaults.mjs`
Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add plants.js test-plants-defaults.mjs
git commit -m "feat(vegetation): add plants.js data model (PLANT_DEFAULTS + 4 species presets)"
```

### Task 7: `plants.js` — stem + leaf geometry, `buildPlantGeometry` core

**Files:**
- Modify: `plants.js` (add geometry-building functions and `buildPlantGeometry`)
- Test: `test-plants-geometry.mjs` (started here, extended in Task 8)

- [ ] **Step 1: Write the failing test**

```js
// test-plants-geometry.mjs
import { buildPlantGeometry, PLANT_PRESETS } from './plants.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL ') + m); if (!c) fail++; };

function checkGeom(geom, label) {
  ok(!!geom.getAttribute('position'), `${label}: has position attribute`);
  ok(!!geom.getAttribute('normal'), `${label}: has normal attribute`);
  ok(!!geom.getAttribute('color'), `${label}: has color attribute`);
  const posCount = geom.getAttribute('position').count;
  ok(posCount > 0, `${label}: non-empty geometry (${posCount} verts)`);
  ok(posCount % 3 === 0, `${label}: vertex count is a multiple of 3 (all triangles)`);
  ok(!!geom.index && geom.index.count === posCount, `${label}: has a sequential index matching vertex count (required by plants-gpu.js's indirect draw)`);
}

// simple, opposite-arrangement leaves (chickweed shape family)
checkGeom(buildPlantGeometry({ ...PLANT_PRESETS.chickweed, flower: { enabled: false } }), 'chickweed (no flower)');
// complex/whorled compound leaves (cleavers shape family)
checkGeom(buildPlantGeometry({ ...PLANT_PRESETS.cleavers, flower: { enabled: false } }), 'cleavers (no flower)');
// serrated + veined leaves (mint shape family)
checkGeom(buildPlantGeometry({ ...PLANT_PRESETS.mint, flower: { enabled: false } }), 'mint (no flower)');
// alternate arrangement, branching stem (jewelweed shape family)
checkGeom(buildPlantGeometry({ ...PLANT_PRESETS.jewelweed, flower: { enabled: false } }), 'jewelweed (no flower)');

// determinism: same seed -> identical geometry
const a = buildPlantGeometry({ ...PLANT_PRESETS.mint, seed: 42 });
const b = buildPlantGeometry({ ...PLANT_PRESETS.mint, seed: 42 });
ok(JSON.stringify(Array.from(a.getAttribute('position').array)) === JSON.stringify(Array.from(b.getAttribute('position').array)),
  'same seed produces identical geometry');

// schema edge cases the 4 launch presets don't exercise, per the design spec
checkGeom(buildPlantGeometry({ leaf: { leafletParity: 'even', style: 'complex', leafletCount: 6, arrangement: 'whorl' } }), 'even-pinnate compound leaf (schema-only case)');
checkGeom(buildPlantGeometry({ leaf: { variegation: { enabled: true, pattern: 'blotch', color: 0xffffff, amount: 0.6 } } }), 'variegated leaf (schema-only case)');
checkGeom(buildPlantGeometry({ leaf: { shape: 'star' } }), 'star-shaped leaf (schema-only case)');

console.log(fail ? fail + ' FAIL' : 'ALL PASS'); process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-plants-geometry.mjs`
Expected: `buildPlantGeometry is not a function` (or similar), exits 1.

- [ ] **Step 3: Add RNG, math helpers, and vertex-buffer helpers to `plants.js`**

Append to `plants.js`, after the `PLANT_BIOME_TAGS` export:

```js
// ---- seeded RNG (mulberry32) -- same convention as grass.js/forest-placement.js ----
function makeRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function hexToRgb01(hex) { return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]; }

// "mockup px"-equivalent -> world units, so PLANT_DEFAULTS' numeric ranges (matching the
// canvas mockup's pixel scale, ~6-60) map to plant sizes comparable to grass blades (~0.2-1.5
// world units) and smaller than trees.
const UNIT = 1 / 30;

// push one flat-shaded triangle (a,b,c are [x,y,z]) with a single vertex color.
function pushTri(positions, normals, colors, a, b, c, color) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  for (const p of [a, b, c]) { positions.push(p[0], p[1], p[2]); normals.push(nx, ny, nz); }
  for (let i = 0; i < 3; i++) colors.push(color[0], color[1], color[2]);
}

// transform a local-space {positions,normals,colors} triple by a THREE.Matrix4 and append
// it into dstPos/dstNorm/dstCol (world-space merge target).
const _v = new THREE.Vector3(), _n = new THREE.Vector3();
function appendTransformed(dstPos, dstNorm, dstCol, local, matrix4) {
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix4);
  for (let i = 0; i < local.positions.length; i += 3) {
    _v.set(local.positions[i], local.positions[i + 1], local.positions[i + 2]).applyMatrix4(matrix4);
    _n.set(local.normals[i], local.normals[i + 1], local.normals[i + 2]).applyMatrix3(normalMatrix).normalize();
    dstPos.push(_v.x, _v.y, _v.z);
    dstNorm.push(_n.x, _n.y, _n.z);
  }
  for (let i = 0; i < local.colors.length; i++) dstCol.push(local.colors[i]);
}
```

- [ ] **Step 4: Add the leaf-outline triangulation**

A leaf blade is a tapered, optionally-toothed card: a fan of triangles from the base/petiole point (0,0,0) around a symmetric boundary loop in local XY (x = 0..len along the leaf's length axis, y = ±halfwidth). `shape` picks the taper curve; `serration.teeth`/`depth` cut a repeating notch into it (teeth=0 leaves it smooth). Append:

```js
// boundary points around a leaf's silhouette, base(0,0) implied, x=length axis 0..len, y=+-halfW.
// shape picks the taper envelope: 'oval' widest at mid-length, 'lance' widest near the base and
// pointed, 'star' narrow and sharply pointed (fewer boundary points -> a spikier outline).
function leafEnvelope(shape, t, halfW) {
  if (shape === 'lance') return Math.sin(t * Math.PI * 0.7) * halfW * (1 - t * 0.3);
  if (shape === 'star')  return Math.pow(Math.sin(t * Math.PI), 2.2) * halfW;
  return Math.sin(t * Math.PI) * halfW; // 'oval' (default)
}
function leafOutlinePoints(shape, len, width, teeth, depth) {
  const halfW = width * 0.5;
  const steps = Math.max(teeth > 0 ? teeth * 4 : 10, 10);
  const side = (signY) => {
    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      let y = leafEnvelope(shape, t, halfW);
      if (teeth > 0) {
        const phase = (t * teeth) % 1;
        const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;   // 0..1..0 sawtooth per tooth
        y *= 1 - depth * (1 - tri);
      }
      pts.push([t * len, signY * y]);
    }
    return pts;
  };
  const right = side(1);
  const left = side(-1).reverse();
  left.pop();   // drop the duplicate tip point where the two sides meet
  return right.concat(left);
}

// build one leaf blade in local space: fan-triangulated from the base point, colored with an
// optional vein line, optional variegation pattern, and a simple length-wise shade gradient.
function buildLeafLocal(leafOpts, len, width) {
  const { shape, serration, variegation, color, veinColor } = leafOpts;
  const pts = leafOutlinePoints(shape, len, width, serration.teeth, serration.depth);
  const base = [0, 0, 0];
  const baseRgb = hexToRgb01(color);
  const veinRgb = veinColor != null ? hexToRgb01(veinColor) : null;
  const varRgb = variegation.enabled ? hexToRgb01(variegation.color) : null;
  const halfW = width * 0.5;
  const positions = [], normals = [], colors = [];
  const colorAt = (x, y) => {
    let c = baseRgb;
    if (veinRgb) {
      const veinMix = clamp01(1 - (Math.abs(y) / (halfW + 1e-4)) * 3);
      c = [lerp(c[0], veinRgb[0], veinMix), lerp(c[1], veinRgb[1], veinMix), lerp(c[2], veinRgb[2], veinMix)];
    }
    if (varRgb) {
      let m;
      if (variegation.pattern === 'edge') m = clamp01(1 - (halfW - Math.abs(y)) / (halfW * 0.5 + 1e-4));
      else if (variegation.pattern === 'vein') m = clamp01(1 - Math.abs(y) / (halfW * 0.6 + 1e-4));
      else m = Math.abs(Math.sin(x * 3.1 + y * 5.7)) > 0.6 ? 1 : 0;   // 'blotch'
      m *= variegation.amount;
      c = [lerp(c[0], varRgb[0], m), lerp(c[1], varRgb[1], m), lerp(c[2], varRgb[2], m)];
    }
    const shade = 0.75 + 0.25 * (x / len);   // subtle base->tip brightening
    return [c[0] * shade, c[1] * shade, c[2] * shade];
  };
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
    pushTri(positions, normals, colors, base, [p0[0], p0[1], 0], [p1[0], p1[1], 0], colorAt(p0[0], p0[1]));
  }
  return { positions, normals, colors };
}
```

- [ ] **Step 5: Add compound-leaf assembly and stem generation**

```js
// a compound ('complex') leaf: leafletCount smaller leaflet cards fanned along a shared
// rachis. leafletParity 'odd' adds one terminal leaflet at the tip; 'even' stops at pairs.
function buildCompoundLeafLocal(leafOpts, len, width) {
  const count = Math.max(2, Math.round(leafOpts.leafletCount));
  const hasTerminal = leafOpts.leafletParity === 'odd';
  const pairCount = Math.max(1, hasTerminal ? Math.floor((count - 1) / 2) : Math.floor(count / 2));
  const leafletLen = len / (pairCount + (hasTerminal ? 1 : 0.5));
  const merged = { positions: [], normals: [], colors: [] };
  for (let i = 0; i < pairCount; i++) {
    const t = (i + 1) / (pairCount + (hasTerminal ? 1 : 0.5));
    for (const side of [-1, 1]) {
      const leaflet = buildLeafLocal(leafOpts, leafletLen, width * 0.5);
      const m = new THREE.Matrix4().makeRotationZ(side * 0.9);
      m.setPosition(t * len, 0, 0);
      appendTransformed(merged.positions, merged.normals, merged.colors, leaflet, m);
    }
  }
  if (hasTerminal) {
    const leaflet = buildLeafLocal(leafOpts, leafletLen, width * 0.5);
    appendTransformed(merged.positions, merged.normals, merged.colors, leaflet, new THREE.Matrix4().setPosition(len, 0, 0));
  }
  return merged;
}

// stem node path: mostly-vertical growth (sprawl=0) blending toward wandering, near-horizontal
// growth (sprawl=1, chickweed). yaw wanders per node; nodeCount/nodeSpacing may be a fixed
// number or a [min,max] range (randomized once per plant).
function resolveRange(v, rng) { return Array.isArray(v) ? lerp(v[0], v[1], rng()) : v; }
function buildStemPath(stemOpts, rng) {
  const nodeCount = Math.max(1, Math.round(resolveRange(stemOpts.nodes, rng())));
  const pitch = lerp(Math.PI * 0.45, Math.PI * 0.12, stemOpts.sprawl);   // elevation angle: near-vertical .. near-horizontal
  let x = 0, y = 0, z = 0, yaw = rng() * Math.PI * 2;
  const nodes = [{ pos: [0, 0, 0], yaw }];
  for (let i = 1; i <= nodeCount; i++) {
    const spacing = resolveRange(stemOpts.nodeSpacing, rng()) * UNIT;
    yaw += (rng() - 0.5) * 0.6;
    x += Math.cos(yaw) * Math.cos(pitch) * spacing;
    z += Math.sin(yaw) * Math.cos(pitch) * spacing;
    y += Math.sin(pitch) * spacing;
    nodes.push({ pos: [x, y, z], yaw });
  }
  return nodes;
}

// thin quad ribbon connecting consecutive stem nodes (double-sided material handles visibility
// from any angle, matching grass's flat-blade convention rather than a full cylinder).
function buildStemQuads(dst, nodes, width) {
  const color = [0.30, 0.42, 0.20];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1].pos, b = nodes[i].pos;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * width * 0.5, nz = (dx / len) * width * 0.5;
    const p0 = [a[0] - nx, a[1], a[2] - nz], p1 = [a[0] + nx, a[1], a[2] + nz];
    const p2 = [b[0] + nx, b[1], b[2] + nz], p3 = [b[0] - nx, b[1], b[2] - nz];
    pushTri(dst.positions, dst.normals, dst.colors, p0, p1, p2, color);
    pushTri(dst.positions, dst.normals, dst.colors, p0, p2, p3, color);
  }
}

// attach this node's leaf/leaflet-whorl per the arrangement rule:
//  - 'opposite': two leaves at 180 deg, rotated 90 deg node-to-node (decussate, like real mint)
//  - 'whorl': whorlCount leaflets/leaves evenly spaced radially around the node
//  - 'alternate' (default): one leaf per node, staggered by a fixed angle node-to-node
function attachLeavesAtNode(dst, node, nodeIndex, leafOpts, rng) {
  const len = lerp(leafOpts.size[0], leafOpts.size[1], rng()) * UNIT;
  const width = len * 0.55;
  const localLeaf = leafOpts.style === 'complex'
    ? buildCompoundLeafLocal(leafOpts, len, width)
    : buildLeafLocal(leafOpts, len, width);
  const placements = [];
  if (leafOpts.arrangement === 'opposite') {
    const base = (nodeIndex % 2) * (Math.PI / 2);
    placements.push({ angle: base }, { angle: base + Math.PI });
  } else if (leafOpts.arrangement === 'whorl') {
    const count = Math.max(1, Math.round(leafOpts.whorlCount));
    for (let i = 0; i < count; i++) placements.push({ angle: (i / count) * Math.PI * 2 });
  } else {
    placements.push({ angle: nodeIndex * 2.399 });   // golden-angle-ish stagger
  }
  for (const p of placements) {
    const yaw = node.yaw + p.angle;
    const tilt = -0.35;   // leaves droop slightly outward/downward from the stem
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(tilt, yaw, 0, 'YXZ'));
    m.setPosition(node.pos[0], node.pos[1], node.pos[2]);
    appendTransformed(dst.positions, dst.normals, dst.colors, localLeaf, m);
  }
}
```

- [ ] **Step 6: Add `buildPlantGeometry` (flowers stubbed to a no-op for now; Task 8 fills them in)**

```js
export function buildPlantGeometry(opts = {}) {
  const o = merge(PLANT_DEFAULTS, opts);
  const rng = makeRNG(o.seed);
  const nodes = buildStemPath(o.stem, rng);
  const dst = { positions: [], normals: [], colors: [] };
  buildStemQuads(dst, nodes, 0.4 * UNIT);
  for (let i = 1; i < nodes.length; i++) attachLeavesAtNode(dst, nodes[i], i, o.leaf, rng);
  if (o.flower.enabled) attachFlowers(dst, nodes, o.flower, rng);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(dst.positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(dst.normals, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(dst.colors, 3));
  // Trivial sequential index (no vertex sharing/dedup): plants-gpu.js's indirect draw args
  // read geo.index.count (indexCount), matching grass.js/forest-gpu.js's indexed-geometry
  // convention for IndirectStorageBufferAttribute -- an unindexed geometry would break it.
  const vertCount = dst.positions.length / 3;
  const indexArray = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) indexArray[i] = i;
  geom.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geom.computeBoundingSphere();
  return geom;
}

// placeholder until Task 8 -- keeps buildPlantGeometry callable/testable now.
function attachFlowers() {}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node test-plants-geometry.mjs`
Expected: `ALL PASS` (all `flower: { enabled: false }` cases and the 3 schema-only cases, which don't set `flower.enabled`, so they use `PLANT_DEFAULTS.flower.enabled = false` — all exercise geometry that doesn't depend on `attachFlowers` yet).

- [ ] **Step 8: Commit**

```bash
git add plants.js test-plants-geometry.mjs
git commit -m "feat(vegetation): add stem/leaf geometry generation to buildPlantGeometry"
```

### Task 8: `plants.js` — flower shapes, finish `buildPlantGeometry`

**Files:**
- Modify: `plants.js` (replace the `attachFlowers` stub)
- Modify: `test-plants-geometry.mjs` (add flower-enabled assertions)

- [ ] **Step 1: Extend the test to cover flowers**

Add to `test-plants-geometry.mjs`, before the `console.log(fail ? ...)` line:

```js
// flowers enabled (all 4 shapes: star, burPair, whorlBall, pouch)
checkGeom(buildPlantGeometry(PLANT_PRESETS.chickweed), 'chickweed (with star flowers)');
checkGeom(buildPlantGeometry(PLANT_PRESETS.cleavers), 'cleavers (with burPair)');
checkGeom(buildPlantGeometry(PLANT_PRESETS.mint), 'mint (with whorlBall flowers)');
checkGeom(buildPlantGeometry(PLANT_PRESETS.jewelweed), 'jewelweed (with pouch flowers)');

// a plant with flowers has strictly more geometry than the same plant without
const noFlower = buildPlantGeometry({ ...PLANT_PRESETS.mint, seed: 7, flower: { enabled: false } });
const withFlower = buildPlantGeometry({ ...PLANT_PRESETS.mint, seed: 7 });
ok(withFlower.getAttribute('position').count > noFlower.getAttribute('position').count, 'enabling flowers adds geometry');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-plants-geometry.mjs`
Expected: last new assertion fails (`enabling flowers adds geometry` — currently `attachFlowers` is a no-op, so counts are equal).

- [ ] **Step 3: Replace the `attachFlowers` stub with a real shared petal-cluster generator**

All 4 flower shapes (star/whorlBall/pouch/burPair) reuse `buildLeafLocal` at small petal scale rather than 4 bespoke shape algorithms — a star flower is petals=10 thin flat cards in a ring, a bur pair is petals=2 short round cards with no curl, a whorl-ball is petals=12 short cards curled inward, a pouch is 1 elongated curled card. In `plants.js`, replace `function attachFlowers() {}` with:

```js
const FLOWER_SHAPE_PARAMS = {
  star:      { petalLen: 0.10, petalWidth: 0.035, curl: 0.0, countOverride: null },
  whorlBall: { petalLen: 0.05, petalWidth: 0.05,  curl: 0.4, countOverride: null },
  pouch:     { petalLen: 0.16, petalWidth: 0.08,  curl: 0.6, countOverride: 1 },
  burPair:   { petalLen: 0.05, petalWidth: 0.05,  curl: 0.0, countOverride: 2 },
};

// one flower/bur cluster in local space, centered at the origin.
function buildFlowerLocal(flowerOpts) {
  const params = FLOWER_SHAPE_PARAMS[flowerOpts.shape] || FLOWER_SHAPE_PARAMS.star;
  const count = params.countOverride ?? Math.max(1, Math.round(flowerOpts.petals));
  const petalLeafOpts = {
    shape: 'oval', serration: { teeth: 0, depth: 0 },
    variegation: { enabled: false, pattern: 'edge', color: 0, amount: 0 },
    color: flowerOpts.color, veinColor: null,
  };
  const merged = { positions: [], normals: [], colors: [] };
  for (let i = 0; i < count; i++) {
    const petal = buildLeafLocal(petalLeafOpts, params.petalLen, params.petalWidth);
    const angle = (i / count) * Math.PI * 2;
    const tilt = -params.curl * Math.PI * 0.5;
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(tilt, angle, 0, 'YXZ'));
    appendTransformed(merged.positions, merged.normals, merged.colors, petal, m);
  }
  if (flowerOpts.throatColor != null) {
    const throatOpts = { ...petalLeafOpts, color: flowerOpts.throatColor };
    const throat = buildLeafLocal(throatOpts, params.petalLen * 0.4, params.petalWidth * 1.2);
    appendTransformed(merged.positions, merged.normals, merged.colors, throat, new THREE.Matrix4());
  }
  return merged;
}

// flowers appear on the upper ~60% of the stem's nodes, gated by flower.frequency (a random
// draw per eligible node, so frequency=1 doesn't mean "every node", it means "every eligible
// node passes the roll" -- matches the mockups' "denser bloom toward the top" look when
// combined with a stem that has more nodes than flowers).
function attachFlowers(dst, nodes, flowerOpts, rng) {
  const startIdx = Math.max(1, Math.floor(nodes.length * 0.4));
  for (let i = startIdx; i < nodes.length; i++) {
    if (rng() > flowerOpts.frequency) continue;
    const local = buildFlowerLocal(flowerOpts);
    const m = new THREE.Matrix4().setPosition(nodes[i].pos[0], nodes[i].pos[1], nodes[i].pos[2]);
    appendTransformed(dst.positions, dst.normals, dst.colors, local, m);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-plants-geometry.mjs`
Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add plants.js test-plants-geometry.mjs
git commit -m "feat(vegetation): add flower geometry (star/whorlBall/pouch/burPair) to buildPlantGeometry"
```

### Task 9: `plants.js` — `createPlantPalette` (bake N variants per species)

**Files:**
- Modify: `plants.js` (add `createPlantPalette`)
- Modify: `test-plants-defaults.mjs` (add palette assertions)

- [ ] **Step 1: Extend the test**

Add to `test-plants-defaults.mjs`, before `console.log(fail ? ...)`:

```js
const palette = createPlantPalette({ variantsPerSpecies: 3, masterSeed: 123 });
ok(palette.variants.length === 4 * 3, 'palette has speciesCount * variantsPerSpecies geometries');
ok(palette.speciesCount === 4, 'palette knows its species count');
ok(palette.speciesTags.length === 4, 'palette carries one biome/density tag per species');
ok(palette.speciesTags[0].key === 'chickweed', 'species order matches PLANT_PRESETS key order');
ok(palette.variants.every(g => g.getAttribute('position').count > 0), 'every baked variant has geometry');

// different seeds per variant -> not all identical
const p0 = Array.from(palette.variants[0].getAttribute('position').array);
const p1 = Array.from(palette.variants[1].getAttribute('position').array);
ok(JSON.stringify(p0) !== JSON.stringify(p1), 'variants of the same species differ (different seeds)');
```

And update the import line at the top:

```js
import { PLANT_DEFAULTS, PLANT_PRESETS, PLANT_BIOME_TAGS, createPlantPalette } from './plants.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-plants-defaults.mjs`
Expected: `createPlantPalette is not a function`.

- [ ] **Step 3: Add `createPlantPalette` to `plants.js`**

Append:

```js
// Bake variantsPerSpecies fixed geometries per PLANT_PRESETS species, once, at startup --
// mirrors forest-palette.js's role but with no separate color-bake step: buildPlantGeometry
// already writes final vertex colors, so palette baking is just "call the generator N times".
export function createPlantPalette({ variantsPerSpecies = 4, masterSeed = 1 } = {}) {
  const keys = Object.keys(PLANT_PRESETS);
  const variants = [];
  const speciesTags = [];
  for (let s = 0; s < keys.length; s++) {
    const key = keys[s];
    speciesTags.push({ key, tag: PLANT_BIOME_TAGS[key] });
    for (let v = 0; v < variantsPerSpecies; v++) {
      const seed = masterSeed + s * 977 + v * 131;
      variants.push(buildPlantGeometry({ ...PLANT_PRESETS[key], seed }));
    }
  }
  return { variants, variantsPerSpecies, speciesCount: keys.length, speciesTags };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-plants-defaults.mjs`
Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add plants.js test-plants-defaults.mjs
git commit -m "feat(vegetation): add createPlantPalette to bake per-species instance variants"
```

### Task 10: `plants-placement.js` — biome-gated placement records

**Files:**
- Create: `plants-placement.js`
- Test: `test-plants-placement.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test-plants-placement.mjs
import { plantPlacementRecords } from './plants-placement.js';
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

const heightAt = () => 0;
const chunks = [{ key: '0,0', xMin: 0, zMin: 0, size: 30, centerX: 15, centerZ: 15 }];
const speciesTable = [
  { key: 'chickweed', tag: { biomes: ['plains'], density: 1 } },
  { key: 'cleavers',  tag: { biomes: [], density: 0.6 } },
  { key: 'jewelweed', tag: { biomes: ['swamp'], density: 0.8 } },
];
const params = { masterSeed: 20260702, waterLevel: -0.9, shoreMargin: 0.1, plantDensity: 0.3, plantSpeciesTable: speciesTable };

const a = plantPlacementRecords(chunks, params, heightAt);
const b = plantPlacementRecords(chunks, params, heightAt);
ok(a.length > 0, '1: places some plants');
ok(JSON.stringify(a) === JSON.stringify(b), '1: deterministic for the same seed/params');
ok(a.every(r => r.x >= 0 && r.x <= 30 && r.z >= 0 && r.z <= 30), '1: within chunk bounds');
ok(a.every(r => r.speciesIdx >= 0 && r.speciesIdx < speciesTable.length), '1: valid speciesIdx');
ok(a.every(r => typeof r.scale === 'number' && r.scale > 0 && typeof r.yaw === 'number'), '1: has scale + yaw');

// water rejection
const wet = plantPlacementRecords(chunks, params, () => -5);
ok(wet.length === 0, '2: rejects submerged ground');

// biome gating: in an all-desert biome, only the generalist (cleavers, empty biomes) places
const alwaysDesert = () => 'desert';
const desertRecs = plantPlacementRecords(chunks, params, heightAt, alwaysDesert);
ok(desertRecs.length > 0, '3: generalist species still places in an unmatched biome');
ok(desertRecs.every(r => speciesTable[r.speciesIdx].key === 'cleavers'), '3: only the biome-generalist species is picked in an all-desert biome');

// in an all-plains biome, chickweed (and the generalist cleavers) can place, but not jewelweed
const alwaysPlains = () => 'plains';
const plainsRecs = plantPlacementRecords(chunks, params, heightAt, alwaysPlains);
ok(plainsRecs.every(r => speciesTable[r.speciesIdx].key !== 'jewelweed'), '4: swamp-only species never placed in an all-plains biome');
ok(plainsRecs.some(r => speciesTable[r.speciesIdx].key === 'chickweed'), '4: plains-tagged species does place in a plains biome');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-plants-placement.mjs`
Expected: `Cannot find module './plants-placement.js'`.

- [ ] **Step 3: Create `plants-placement.js`**

```js
// plants-placement.js -- pure placement logic for understory plants, mirroring
// forest-placement.js's placementRecords shape. Reuses forest-placement.js's rngFrom/hash2
// (identical determinism convention; no reason to duplicate).
import { rngFrom, hash2 } from './forest-placement.js';

// chunks: forest-placement.js-style chunk descriptors ({key,xMin,zMin,size,...}).
// params: { masterSeed, waterLevel, shoreMargin, plantDensity (plants per world-unit^2),
//           plantSpeciesTable: [{ key, tag: { biomes: string[], density } }, ...] }.
// biomeAt(x,z) (optional): when omitted, every species is a candidate everywhere (matches
// forest-placement.js's convention for procedural/no-biome terrain).
// Returns, per plant: { x, z, scale, yaw, speciesIdx, chunkKey, slot }.
export function plantPlacementRecords(chunks, params, heightAt, biomeAt) {
  const out = [];
  const speciesTable = params.plantSpeciesTable || [];
  if (speciesTable.length === 0) return out;
  const density = Math.max(0, params.plantDensity ?? 0);
  const minBaseY = params.waterLevel + (params.shoreMargin ?? 0.1);
  for (const chunk of chunks) {
    const count = Math.floor(density * chunk.size * chunk.size);
    if (count <= 0) continue;
    const [ix, iz] = chunk.key.split(',').map(Number);
    const crng = rngFrom(Math.floor(hash2(ix, iz, params.masterSeed + 8191) * 0xffffffff));
    for (let slot = 0; slot < count; slot++) {
      const x = chunk.xMin + crng.next() * chunk.size;
      const z = chunk.zMin + crng.next() * chunk.size;
      if (heightAt(x, z) < minBaseY) continue;
      const biome = biomeAt ? biomeAt(x, z) : null;
      const candidates = [];
      for (let i = 0; i < speciesTable.length; i++) {
        const tags = speciesTable[i].tag;
        if (biome === null || !tags.biomes.length || tags.biomes.includes(biome)) candidates.push(i);
      }
      if (candidates.length === 0) continue;   // no species valid at this spot -> skip it (unlike
                                                 // forest, which falls back to "any species"; plants
                                                 // are allowed to be sparse/absent in a biome)
      let total = 0;
      for (const i of candidates) total += Math.max(0, speciesTable[i].tag.density);
      let speciesIdx;
      if (total <= 0) {
        speciesIdx = candidates[Math.floor(crng.next() * candidates.length)];
      } else {
        const r = crng.next() * total;
        let acc = 0; speciesIdx = candidates[candidates.length - 1];
        for (const i of candidates) { acc += Math.max(0, speciesTable[i].tag.density); if (r <= acc) { speciesIdx = i; break; } }
      }
      const scale = 0.85 + crng.next() * 0.3;
      const yaw = crng.next() * Math.PI * 2;
      out.push({ x, z, scale, yaw, speciesIdx, chunkKey: chunk.key, slot });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-plants-placement.mjs`
Expected: all pass, `0 failed`.

- [ ] **Step 5: Verify `forest-placement.js`'s own tests didn't regress**

Run: `node test-forest-placement.mjs`
Expected: unaffected (this task only reads `rngFrom`/`hash2` from it, no changes to that file).

- [ ] **Step 6: Commit**

```bash
git add plants-placement.js test-plants-placement.mjs
git commit -m "feat(vegetation): add plants-placement.js with biome-gated density-weighted placement"
```

### Task 11: `plants-gpu.js` — single-LOD GPU instancing

**Files:**
- Create: `plants-gpu.js`

This mirrors `forest-gpu.js`'s reset→cull→finalize→indirect-draw spine, simplified: one distance-cull band (not 4 LOD bands), one mesh per variant (`buildPlantGeometry` already bakes stem+leaves+flowers+vertex-color into ONE geometry, unlike forest's separate branches/leaves/shadow meshes). No Node test — this is WebGPU-compute code with no pure-math logic worth extracting (same reasoning `forest-gpu.js` itself has no dedicated test file; its CPU-testable math twin is `forest-cull.js`, not itself).

- [ ] **Step 1: Create `plants-gpu.js`**

```js
// plants-gpu.js -- GPU-instanced procedural plants. Mirrors forest-gpu.js's
// reset -> cull -> finalize -> indirect-draw spine, simplified to a single distance-cull
// band and one mesh per variant (buildPlantGeometry bakes stem+leaves+flowers+vertex-color
// into ONE geometry per variant, unlike forest's separate branches/leaves/shadow meshes).
import * as THREE from 'three';
import {
  MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, int, uint,
  vec3, cos, sin, modInt, positionLocal, normalLocal,
  atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';

// opts: { renderer, camera, palette (from plants.js's createPlantPalette), heightAt,
//         capPerVariant, cullRadius }
export function createPlantsGPU(opts) {
  const { renderer, camera, palette } = opts;
  const heightAt = opts.heightAt || (() => 0);
  const CAP = opts.capPerVariant ?? 256;
  const V = palette.variants.length;

  // source (CPU-filled on chunk change) and draw (compute-written survivors) buffers:
  // V*CAP instances x 2 vec4 -> rec0=(x,y,z,scale), rec1=(yaw,_,_,_).
  const srcAttr = new StorageInstancedBufferAttribute(new Float32Array(V * CAP * 8), 8);
  const src = storage(srcAttr, 'vec4', V * CAP * 2);
  const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(V * CAP * 8), 8);
  const draw = storage(drawAttr, 'vec4', V * CAP * 2);
  const countsAttr = new StorageBufferAttribute(new Uint32Array(V), 1);
  const srcCounts = storage(countsAttr, 'uint', V);
  const survAtomics = storage(new StorageBufferAttribute(new Uint32Array(V), 1), 'uint', V).toAtomic();

  // geo.index.count (indexCount) -- buildPlantGeometry always sets a trivial sequential
  // index, matching grass.js/forest-gpu.js's indexed-geometry convention here.
  const indirectAttrs = palette.variants.map(g => new IndirectStorageBufferAttribute(new Uint32Array([g.index.count, 0, 0, 0, 0]), 5));
  const indirectNodes = indirectAttrs.map(a => storage(a, 'uint', 5));

  const uCam = uniform(new THREE.Vector2());
  const uCullRadius = uniform(opts.cullRadius ?? 45);

  const reset = Fn(() => { atomicStore(survAtomics.element(instanceIndex), uint(0)); })().compute(V);

  const cull = Fn(() => {
    const idx = int(instanceIndex);
    const cap = int(CAP);
    const localSlot = modInt(idx, cap);
    const g = idx.sub(localSlot).div(cap);
    If(localSlot.lessThan(int(srcCounts.element(g))), () => {
      const rec0 = src.element(idx.mul(uint(2)));
      const rec1 = src.element(idx.mul(uint(2)).add(uint(1)));
      const dx = rec0.x.sub(uCam.x);
      const dz = rec0.z.sub(uCam.y);
      const dist2 = dx.mul(dx).add(dz.mul(dz));
      If(dist2.lessThanEqual(uCullRadius.mul(uCullRadius)), () => {
        const s = atomicAdd(survAtomics.element(uint(g)), uint(1));
        const outBase = uint(g).mul(uint(CAP)).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      });
    });
  })().compute(V * CAP);

  const finalizers = [];
  for (let g = 0; g < V; g++) {
    const node = indirectNodes[g];
    finalizers.push(Fn(() => { node.element(1).assign(atomicLoad(survAtomics.element(uint(g)))); })().compute(1));
  }

  function instanceNodes(g) {
    const recBase = uint(g).mul(uint(CAP)).add(instanceIndex).mul(uint(2));
    const rec0 = draw.element(recBase);
    const rec1 = draw.element(recBase.add(uint(1)));
    const scale = rec0.w, yaw = rec1.x;
    const cy = cos(yaw), sy = sin(yaw);
    const px = positionLocal.x, py = positionLocal.y, pz = positionLocal.z;
    const rx = px.mul(cy).add(pz.mul(sy));
    const rz = pz.mul(cy).sub(px.mul(sy));
    const world = vec3(rec0.x.add(rx.mul(scale)), rec0.y.add(py.mul(scale)), rec0.z.add(rz.mul(scale)));
    const nx = normalLocal.x, ny = normalLocal.y, nz = normalLocal.z;
    const nWorld = vec3(nx.mul(cy).add(nz.mul(sy)), ny, nz.mul(cy).sub(nx.mul(sy)));
    return { world, nWorld };
  }

  const meshes = [];
  for (let g = 0; g < V; g++) {
    const mat = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide });
    const n = instanceNodes(g);
    mat.positionNode = n.world;
    mat.normalNode = n.nWorld;
    const geom = palette.variants[g].clone();
    geom.instanceCount = CAP;
    geom.indirect = indirectAttrs[g];
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    meshes.push(mesh);
  }

  // ---- CPU: per-chunk placement records -> global source buffer ----
  const chunkRecords = new Map();
  const srcArray = srcAttr.array;
  const countsArray = countsAttr.array;
  let cpuInstances = 0;
  let dirty = true, lastCamX = NaN, lastCamZ = NaN;

  // deterministic variant pick within a species (0 .. variantsPerSpecies-1) -- same formula
  // forest-gpu.js uses, so repeated `slot` values pick the same variant consistently.
  function variantSel(slot) {
    return (Math.imul(slot + 1, 2654435761) >>> 0) % palette.variantsPerSpecies;
  }

  function rebuild() {
    countsArray.fill(0);
    srcArray.fill(0);
    let total = 0;
    for (const records of chunkRecords.values()) {
      for (const r of records) {
        const g = r.speciesIdx * palette.variantsPerSpecies + variantSel(r.slot);
        if (g < 0 || g >= V) continue;
        const slot = countsArray[g];
        if (slot >= CAP) continue;   // variant window full; drop extras (same policy as forest-gpu.js)
        countsArray[g] = slot + 1;
        const base = (g * CAP + slot) * 8;
        srcArray[base] = r.x; srcArray[base + 1] = heightAt(r.x, r.z); srcArray[base + 2] = r.z; srcArray[base + 3] = r.scale;
        srcArray[base + 4] = r.yaw;
        total++;
      }
    }
    cpuInstances = total;
    srcAttr.needsUpdate = true;
    countsAttr.needsUpdate = true;
    dirty = true;
  }

  return {
    meshes,
    setChunk(key, records) { chunkRecords.set(key, records); rebuild(); },
    clearChunk(key) { if (chunkRecords.delete(key)) rebuild(); },
    setCullRadius(r) { if (uCullRadius.value !== r) { uCullRadius.value = r; dirty = true; } },
    async update() {
      const camX = camera.position.x, camZ = camera.position.z;
      if (!dirty && camX === lastCamX && camZ === lastCamZ) return;
      uCam.value.set(camX, camZ);
      await renderer.computeAsync([reset, cull, ...finalizers]);
      lastCamX = camX; lastCamZ = camZ; dirty = false;
    },
    get stats() { return { draws: V, instances: cpuInstances, variants: V }; },
    dispose() {
      const mats = new Set();
      meshes.forEach(m => { m.geometry.dispose(); mats.add(m.material); });
      mats.forEach(m => m.dispose());
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add plants-gpu.js
git commit -m "feat(vegetation): add plants-gpu.js single-LOD storage-buffer instancing"
```

### Task 12: Wire plants into `environment-viewer.html`

**Files:**
- Modify: `environment-viewer.html` (global var declaration, plants lazy-import block, chunk-window hook, render-loop update)

- [ ] **Step 1: Declare the plants globals**

Next to the existing `let grassRef = null, waterRef = null, regenTrees = null, ...` (line 860), add `plantsGPURef` and `regenPlants`:

```js
let grassRef = null, waterRef = null, regenTrees = null, cloudsRef = null, clouds2Ref = null, forestGPURef = null, plantsGPURef = null, regenPlants = null;
```

- [ ] **Step 2: Add the plants lazy-import block**

Right after the grass wiring's closing `}).catch(err => { showError(...) });` (line 2292), before the water wiring (`_waterPromise = ...`, line 2295), add:

```js
  // ---- plants: single-LOD GPU-instanced understory (chickweed/cleavers/mint/jewelweed) ----
  const PLANTS_MODE = new URLSearchParams(location.search).get('plants') || 'gpu';
  if (PLANTS_MODE === 'gpu') {
    const { createPlantPalette } = await import('./plants.js');
    const { plantPlacementRecords } = await import('./plants-placement.js');
    const { createPlantsGPU } = await import('./plants-gpu.js');
    Object.assign(params, { plantDensity: 0.02, plantCullRadius: 45 });
    const plantPalette = createPlantPalette({ variantsPerSpecies: 4, masterSeed: MASTER_SEED });
    const plantsGPU = createPlantsGPU({
      renderer, camera, palette: plantPalette, heightAt: terrainHeight,
      cullRadius: params.plantCullRadius, capPerVariant: 256,
    });
    plantsGPURef = plantsGPU;
    scene.add(...plantsGPU.meshes);
    const plantChunks = new Set();
    function regeneratePlantsGPU(rebuildExisting) {
      const active = forestChunksForPlacement().slice();
      const activeKeys = new Set(active.map(c => c.key));
      for (const key of [...plantChunks]) {
        if (!activeKeys.has(key)) { plantsGPU.clearChunk(key); plantChunks.delete(key); }
      }
      const pr = {
        masterSeed: MASTER_SEED, waterLevel: terrain.waterLevel,
        plantDensity: params.plantDensity, plantSpeciesTable: plantPalette.speciesTags,
      };
      for (const chunk of active) {
        if (!rebuildExisting && plantChunks.has(chunk.key)) continue;
        const recs = plantPlacementRecords([chunk], pr, terrainHeight, loadedMap?.biomeAt);
        plantsGPU.setChunk(chunk.key, recs);
        plantChunks.add(chunk.key);
      }
    }
    regeneratePlantsGPU(true);
    regenPlants = (rebuildExisting = false) => regeneratePlantsGPU(rebuildExisting);
    header('Plants');
    slider('plantDensity', 'Density (plants/m²)', 0, 0.2, 0.005, v => v.toFixed(3), () => regeneratePlantsGPU(true));
    slider('plantCullRadius', 'Cull radius', 10, 150, 1, fi, () => plantsGPU.setCullRadius(params.plantCullRadius));
  }
```

This block relies on `forestChunksForPlacement`, `terrainHeight`, `MASTER_SEED`, `loadedMap`, `header`, `slider`, `fi` all already being in scope by this point in the file (the forest and grass wiring above it already use every one of them).

- [ ] **Step 3: Hook chunk-window changes**

In `updateTerrainWindow` (line 945), right after `if (regenTrees) regenTrees(terrainDecorationsRebuildAll);`, add:

```js
  if (regenTrees) regenTrees(terrainDecorationsRebuildAll);
  if (regenPlants) regenPlants(terrainDecorationsRebuildAll);
```

- [ ] **Step 4: Hook the per-frame compute update**

Right after the existing `if (forestGPURef) await frameProfiler.timeAsync('forestGpu', () => forestGPURef.update());` (line 3222), add:

```js
  if (forestGPURef) await frameProfiler.timeAsync('forestGpu', () => forestGPURef.update());
  if (plantsGPURef) await frameProfiler.timeAsync('plantsGpu', () => plantsGPURef.update());
```

- [ ] **Step 5: Manual verification**

Run: `python serve.py 8080`, open `http://127.0.0.1:8080/environment-viewer.html`. Confirm small plants appear scattered among the grass (denser than trees, sparser than grass blades), confirm a "Plants" panel with Density/Cull radius sliders, confirm moving the camera streams plants in/out at the terrain's chunk edges without errors in the console, and confirm the Density slider visibly changes plant count.

- [ ] **Step 6: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(vegetation): wire procedural plants into environment-viewer.html (?plants=gpu)"
```

### Task 13: Docs and activity log

**Files:**
- Modify: `docs/subsystems/vegetation.md`
- Modify: `agent_log.csv`

- [ ] **Step 1: Read the current doc structure**

Run: `python -c "print(open('docs/subsystems/vegetation.md').read()[:3000])"` (or open the file) to see the existing Files table, Public API section, Wiring section, and Tunable parameters section headings, so the additions below land in the right place and match the existing formatting.

- [ ] **Step 2: Add plants + grass-textures rows to the Files table**

Add two rows to the subsystem's Files table (alongside the existing `grass.js`, `forest-gpu.js`, etc. rows):

```
| `grass-textures.js` | 5 procedurally-synthesized blade fiber styles, baked to one atlas texture |
| `plants.js` | Parameterized procedural plant generator (`PLANT_DEFAULTS`/`PLANT_PRESETS`/`buildPlantGeometry`); 4 species: chickweed, cleavers, mint, jewelweed |
| `plants-placement.js` | Biome-gated, density-weighted plant placement (mirrors `forest-placement.js`) |
| `plants-gpu.js` | Single-LOD GPU-instanced plant rendering (mirrors `forest-gpu.js`, one distance-cull band) |
```

Also correct the two stale line counts found during design (`forest-placement.js` is 234 lines, not 183; `forest-palette.js` is 86, not 84) while editing this table.

- [ ] **Step 3: Add a "Grass blade textures" note to the Public API section**

```
### Grass blade fiber textures (`grass-textures.js`)

`FIBER_STYLES` / `STYLE_KEYS` (5 keys: `streaks`, `dryTip`, `mottle`, `vein`, `highContrast`) are
pure `fiber(u,v,seed)`/`tint(u,v,seed)` functions, Node-testable without a DOM. `createGrassStyleAtlas()`
bakes all 5 into one canvas atlas (5 tiles in a row); `grass.js` owns a lazy module-scope singleton
(`getGrassStyleAtlas()`, exported) so the atlas is baked once regardless of how many `Grass` instances
exist (CPU mode creates one per chunk). Both `Grass` (grass.js) and the object returned by
`createComputeGrass` (grass-compute.js) expose `setBladeStyle(key)` for a live, no-rebuild style swap.
```

- [ ] **Step 4: Add a "Plants" section**

```
### Plants (`plants.js` / `plants-placement.js` / `plants-gpu.js`)

Procedural understory plants, parameterized like `trees.js` rather than hardcoded per species:
`PLANT_DEFAULTS` is a schema (stem node count/spacing/sprawl; leaf shape/style/leaflet
count+parity/arrangement/serration/variegation/color; flower shape/petals/frequency/color) and
`PLANT_PRESETS.{chickweed,cleavers,mint,jewelweed}` are named overrides. `buildPlantGeometry(opts)`
returns one `THREE.BufferGeometry` per plant with baked vertex colors (stem + leaves + flowers all in
one mesh, no separate materials). `createPlantPalette({variantsPerSpecies, masterSeed})` bakes a fixed
set of variant geometries once at startup. `plantPlacementRecords(chunks, params, heightAt, biomeAt)`
mirrors `forest-placement.js`'s shape (reuses its `rngFrom`/`hash2`); each preset carries a
`PLANT_BIOME_TAGS` allowlist (`cleavers` has an empty allowlist, i.e. it's a biome generalist).
`createPlantsGPU(opts)` mirrors `forest-gpu.js`'s reset->cull->finalize->indirect-draw compute spine
but with a single distance-cull band (no LOD levels) and one mesh per variant. Wired in
`environment-viewer.html` behind `?plants=gpu` (default on); density/cull-radius sliders in the
"Plants" panel.

**Future tooling (not yet built):** because `plants.js`'s data model is fully parameterized, a
`plant-viewer.html` standalone tuning tool (mirroring `tree-viewer.html`'s Solo/Grid/export pattern)
can be added later with no changes to `plants.js` itself.
```

- [ ] **Step 5: Append `agent_log.csv` rows**

Run this from the repo root (one row per logical change across both parts of this plan; append-only, do not touch existing rows):

```bash
python -c "
import csv, datetime
rows = [
  ['2026-07-02T00:00', 'vegetation', 'grass.js;grass-compute.js;grass-textures.js;test-grass-blade-uv.mjs;test-grass-textures.mjs;environment-viewer.html', 'Added 5 selectable procedural blade-fiber textures (atlas-baked, live-swappable) to both grass render paths.'],
  ['2026-07-02T00:00', 'vegetation', 'plants.js;plants-placement.js;plants-gpu.js;test-plants-defaults.mjs;test-plants-geometry.mjs;test-plants-placement.mjs;environment-viewer.html', 'Added a parameterized procedural-plant generator (chickweed/cleavers/mint/jewelweed) with biome-gated placement and single-LOD GPU instancing.'],
]
with open('agent_log.csv', 'a', newline='') as f:
    csv.writer(f).writerows(rows)
print('appended', len(rows), 'rows')
"
```

- [ ] **Step 6: Commit**

```bash
git add docs/subsystems/vegetation.md agent_log.csv
git commit -m "docs(vegetation): document grass fiber textures and procedural plants subsystems"
```

---

## Self-Review Notes

- **Spec coverage:** Part A implements the 5-style live selector (grass-textures.js + wiring + UI, Tasks 1-5) exactly as specced. Part B implements the parameterized `PLANT_DEFAULTS`/`PLANT_PRESETS` schema with every field the user asked for (leaf shape, style simple/complex, leaflet count+parity, arrangement alternate/opposite/whorl, serration, variegation, colors) consumed by real code, plus biome-gated placement and single-LOD GPU instancing (Tasks 6-12), plus doc/log updates (Task 13). The `plant-viewer.html` future tool itself is explicitly out of scope per the spec — only its enabling data model is built here.
- **Placeholder scan:** no TBD/TODO; the one intentional stub (`function attachFlowers() {}` in Task 7, Step 6) is immediately replaced in Task 8 and is covered by a test that would fail if left in place.
- **Type consistency:** `buildPlantGeometry`, `createPlantPalette`, `plantPlacementRecords`, `createPlantsGPU`, `setBladeStyle` are named and shaped consistently everywhere they're referenced across tasks (checked against each task's own code, not just written once and assumed).
