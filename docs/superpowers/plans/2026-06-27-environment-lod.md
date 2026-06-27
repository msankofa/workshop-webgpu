# Environment LOD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Player-centered GPU grass for authored maps, four-LOD tree system with billboard fallback cached in IndexedDB, and dual independent cloud layers with camera-follow.

**Architecture:** Three independent workstreams (grass, trees, clouds) that all touch `environment-viewer.html` as the wiring layer. Grass replaces the `grass.js` authored-map branch with `grass-compute.js` fed a baked height texture. Trees extend `forest-gpu.js` with 4 LOD draw-buffer regions per variant plus a billboard mesh baked once per variant from an offscreen render. Clouds add `setExtent()` to `Clouds` and a second independent instance.

**Tech Stack:** Three.js 0.184.0 WebGPU, TSL (Three Shading Language) compute shaders, `IndirectStorageBufferAttribute`, IndexedDB, Node.js (utility tests).

**Spec:** `docs/superpowers/specs/2026-06-27-environment-lod-design.md`

---

## PART A — GRASS UNIFICATION

### Task 1: Height texture bake utility

**Files:**
- Modify: `environment-viewer.html` (add `bakeHeightTexture` after `loadedMap` block, ~line 188)
- Create: `test-height-texture.mjs`

**Background:** `grass-compute.js` uses a closed-form TSL height formula that can't sample authored meshes. We'll bake the authored map's height into a 512×512 `DataTexture` (R32F) at load time and pass it to the compute shader.

- [ ] **Step 1: Write the test**

Create `test-height-texture.mjs`:

```js
// Verifies that bakeHeightTexture samples correctly at corners and center.
// Run: node test-height-texture.mjs

// Minimal THREE stub — only DataTexture + its constants
const THREE = {
  DataTexture: class {
    constructor(data, w, h, format, type) {
      this.image = { data, width: w, height: h };
      this.format = format; this.type = type;
      this.minFilter = this.magFilter = this.wrapS = this.wrapT = null;
    }
  },
  RedFormat: 1,
  FloatType: 2,
  LinearFilter: 3,
  ClampToEdgeWrapping: 4,
};

function bakeHeightTexture(terrainHeight, bounds, resolution = 512) {
  const { minX, minZ, worldX, worldZ } = bounds;
  const data = new Float32Array(resolution * resolution);
  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const wx = minX + (ix / (resolution - 1)) * worldX;
      const wz = minZ + (iz / (resolution - 1)) * worldZ;
      data[iz * resolution + ix] = terrainHeight(wx, wz);
    }
  }
  const tex = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// Test 1: flat terrain (height = 5) → every texel is 5
{
  const tex = bakeHeightTexture(() => 5, { minX: -100, minZ: -100, worldX: 200, worldZ: 200 });
  const data = tex.image.data;
  const allFive = [...data].every(v => v === 5);
  console.assert(allFive, 'flat terrain: all texels should be 5');
  console.log('Test 1 (flat terrain):', allFive ? 'PASS' : 'FAIL');
}

// Test 2: linear terrain h(x,z)=x → sample at right edge equals maxX
{
  const bounds = { minX: 0, minZ: 0, worldX: 100, worldZ: 100 };
  const tex = bakeHeightTexture((x) => x, bounds, 256);
  const data = tex.image.data;
  const topRightIdx = (256 - 1) * 256 + (256 - 1);
  const close = Math.abs(data[topRightIdx] - 100) < 0.01;
  console.assert(close, `right-edge texel should be ~100, got ${data[topRightIdx]}`);
  console.log('Test 2 (linear terrain):', close ? 'PASS' : 'FAIL');
}

// Test 3: resolution preserved in image dimensions
{
  const tex = bakeHeightTexture(() => 0, { minX: 0, minZ: 0, worldX: 50, worldZ: 50 }, 64);
  console.assert(tex.image.width === 64 && tex.image.height === 64, 'resolution mismatch');
  console.log('Test 3 (resolution):', (tex.image.width === 64 && tex.image.height === 64) ? 'PASS' : 'FAIL');
}
```

- [ ] **Step 2: Run — expect 3 PASSes**

```
node test-height-texture.mjs
```
Expected output:
```
Test 1 (flat terrain): PASS
Test 2 (linear terrain): PASS
Test 3 (resolution): PASS
```

- [ ] **Step 3: Add `bakeHeightTexture` to `environment-viewer.html`**

In `environment-viewer.html`, find the block starting at ~line 160:
```js
const _terrainN = [0, 1, 0];
function terrainNormal(x, z) {
```

Insert before it:
```js
function bakeHeightTexture(heightFn, bounds, resolution = 512) {
  const { minX, minZ, worldX, worldZ } = bounds;
  const data = new Float32Array(resolution * resolution);
  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const wx = minX + (ix / (resolution - 1)) * worldX;
      const wz = minZ + (iz / (resolution - 1)) * worldZ;
      data[iz * resolution + ix] = heightFn(wx, wz);
    }
  }
  const tex = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
```

- [ ] **Step 4: Bake the texture at map load time**

Find the block (~line 108):
```js
if (MAP_KEY) {
  showStatus(`loading authored map ${MAP_KEY}...`);
  await nextPaint();
  loadedMap = await loadTerrainMap(MAP_KEY, { scene });
  showStatus(`building authored map collision...`);
  await nextPaint();
  try {
    mapCollider = createMapCollider(loadedMap.root);
    showStatus(`authored map loaded (${mapCollider.triangleCount.toLocaleString()} collision triangles)`);
  } catch (err) {
    mapCollider = null;
    showError(`map loaded, collision disabled: ${err.message || err}`);
  }
}
```

Replace with:
```js
if (MAP_KEY) {
  showStatus(`loading authored map ${MAP_KEY}...`);
  await nextPaint();
  loadedMap = await loadTerrainMap(MAP_KEY, { scene });
  showStatus(`building authored map collision...`);
  await nextPaint();
  try {
    mapCollider = createMapCollider(loadedMap.root);
    showStatus(`authored map loaded (${mapCollider.triangleCount.toLocaleString()} collision triangles)`);
  } catch (err) {
    mapCollider = null;
    showError(`map loaded, collision disabled: ${err.message || err}`);
  }
  // Bake height texture AFTER terrainHeight() is usable (mapCollider set above).
  showStatus('baking height texture for grass...');
  await nextPaint();
  const hBounds = {
    minX: -loadedMap.worldX * 0.5,
    minZ: -loadedMap.worldZ * 0.5,
    worldX: loadedMap.worldX,
    worldZ: loadedMap.worldZ,
  };
  loadedMap.heightTex = bakeHeightTexture(terrainHeight, hBounds);
  loadedMap.heightTexBounds = hBounds;
}
```

- [ ] **Step 5: Commit**

```
git add environment-viewer.html test-height-texture.mjs
git commit -m "feat: bake authored map height to DataTexture for GPU grass"
```

---

### Task 2: grass-compute.js — height texture path + configurable cull gradient + max blades

**Files:**
- Modify: `grass-compute.js`

**Background:** Add three optional features: (1) TSL texture-lookup height when `opts.heightTex` is set (authored maps); (2) `uCullStart` uniform replacing the hardcoded 0.8 dither; (3) `uMaxBlades` atomic guard.

- [ ] **Step 1: Add TSL `texture` to imports**

Find line 18 in `grass-compute.js`:
```js
import {
  Fn, If, instanceIndex, storage, uniform, attribute, float, int, uint, bitcast, modInt,
  vec2, vec3, vec4, sin, cos, floor, mix, clamp, length, positionLocal,
  atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';
```

Replace with:
```js
import {
  Fn, If, instanceIndex, storage, uniform, attribute, float, int, uint, bitcast, modInt,
  vec2, vec3, vec4, sin, cos, floor, mix, clamp, length, positionLocal,
  atomicAdd, atomicStore, atomicLoad, texture,
} from 'three/tsl';
```

- [ ] **Step 2: Add new opts and uniforms inside `createComputeGrass`**

Find (~line 68):
```js
export function createComputeGrass(opts) {
  const { renderer, camera } = opts;
  const recullMode = opts.grassRecull === 'frame' ? 'frame' : 'cell';
  const cellSize = opts.cellSize ?? 2;
  const Kmax     = opts.Kmax ?? 64;
  const maxRadius = opts.maxRadius ?? opts.radius ?? 600;
  const o = {
    density: opts.density ?? 8.0,
    radius:  Math.min(opts.radius ?? 350, maxRadius),
    waterLevel: opts.waterLevel ?? -0.9,
    shoreMargin: opts.shoreMargin ?? 0.1,
    baseAmp: opts.terrainParams?.baseAmp ?? 1.0,
    lake:    opts.terrainParams?.lake ?? 0.45,
    lakeDepth: opts.terrainParams?.lakeDepth ?? 3.2,
  };
```

Replace with:
```js
export function createComputeGrass(opts) {
  const { renderer, camera } = opts;
  const recullMode = opts.grassRecull === 'frame' ? 'frame' : 'cell';
  const cellSize = opts.cellSize ?? 2;
  const Kmax     = opts.Kmax ?? 64;
  const maxRadius = opts.maxRadius ?? opts.radius ?? 600;
  const o = {
    density: opts.density ?? 8.0,
    radius:  Math.min(opts.radius ?? 350, maxRadius),
    waterLevel: opts.waterLevel ?? -0.9,
    shoreMargin: opts.shoreMargin ?? 0.1,
    baseAmp: opts.terrainParams?.baseAmp ?? 1.0,
    lake:    opts.terrainParams?.lake ?? 0.45,
    lakeDepth: opts.terrainParams?.lakeDepth ?? 3.2,
    cullStart: opts.cullStart ?? null,   // world-units; null = 0.8*radius (legacy)
    maxBlades: opts.maxBlades ?? 0,      // 0 = unlimited
  };
  // height texture path (authored maps)
  const hasHeightTex = !!(opts.heightTex && opts.heightTexBounds);
  const uHeightTex = hasHeightTex ? uniform(opts.heightTex) : null;
  const uBoundsMinX = hasHeightTex ? uniform(opts.heightTexBounds.minX) : null;
  const uBoundsMinZ = hasHeightTex ? uniform(opts.heightTexBounds.minZ) : null;
  const uBoundsW    = hasHeightTex ? uniform(opts.heightTexBounds.worldX) : null;
  const uBoundsH    = hasHeightTex ? uniform(opts.heightTexBounds.worldZ) : null;
```

- [ ] **Step 3: Add `uCullStart` and `uMaxBlades` uniforms**

Find (~line 91):
```js
  const uCam      = uniform(new THREE.Vector2());
  const uRadius   = uniform(o.radius);
```

After `uRadius   = uniform(o.radius);`, add:
```js
  const uCullStart = uniform(o.cullStart !== null ? o.cullStart : o.radius * 0.8);
  const uMaxBlades = uniform(o.maxBlades, 'uint');
```

- [ ] **Step 4: Replace `heightFn` with conditional height node**

Find the block (~line 121):
```js
  // TSL terrain height (transcription of grass-height-ref.js)
  const heightFn = Fn(([x, z]) => {
    const h = sin(x.mul(0.10)).mul(1.1)
      .add(cos(z.mul(0.085)).mul(1.0))
      .add(sin(x.add(z).mul(0.16)).mul(0.5))
      .add(cos(x.sub(z).mul(0.22).add(0.8)).mul(0.35))
      .add(sin(x.mul(0.38).add(z.mul(0.27))).mul(0.18))
      .add(cos(z.mul(0.44).sub(x.mul(0.19))).mul(0.14))
      .mul(uBaseAmp);
    const t = float(1).sub(uLake);
    const nz = lakeNoiseFn(x.mul(0.045).add(10.5), z.mul(0.045).sub(7.2));
    const basin = clamp(nz.sub(t).div(0.15), 0, 1);
    const basinSS = basin.mul(basin).mul(float(3).sub(basin.mul(2)));
    return h.sub(basinSS.mul(uLakeDepth));
  });
```

Replace with:
```js
  // TSL terrain height — texture path for authored maps, closed-form for procedural.
  const heightFn = hasHeightTex
    ? Fn(([x, z]) => {
        const u = x.sub(uBoundsMinX).div(uBoundsW).clamp(0, 1);
        const v = z.sub(uBoundsMinZ).div(uBoundsH).clamp(0, 1);
        return texture(uHeightTex, vec2(u, v)).r;
      })
    : Fn(([x, z]) => {
        const h = sin(x.mul(0.10)).mul(1.1)
          .add(cos(z.mul(0.085)).mul(1.0))
          .add(sin(x.add(z).mul(0.16)).mul(0.5))
          .add(cos(x.sub(z).mul(0.22).add(0.8)).mul(0.35))
          .add(sin(x.mul(0.38).add(z.mul(0.27))).mul(0.18))
          .add(cos(z.mul(0.44).sub(x.mul(0.19))).mul(0.14))
          .mul(uBaseAmp);
        const t = float(1).sub(uLake);
        const nz = lakeNoiseFn(x.mul(0.045).add(10.5), z.mul(0.045).sub(7.2));
        const basin = clamp(nz.sub(t).div(0.15), 0, 1);
        const basinSS = basin.mul(basin).mul(float(3).sub(basin.mul(2)));
        return h.sub(basinSS.mul(uLakeDepth));
      });
```

- [ ] **Step 5: Replace hardcoded cull gradient and add max-blades guard in cull kernel**

Find in the cull kernel (~line 158):
```js
      const dist = length(vec2(wx.sub(uCam.x), wz.sub(uCam.y)));
      // density falloff: dither out the outer 20% of R so the ring has no hard edge
      const edge = clamp(dist.div(uRadius).sub(0.8).div(0.2), 0, 1);
      const keepRand = slotRandFn(gx, gz, slot, int(7));
      const live = wy.greaterThan(uWaterMin)
        .and(dist.lessThan(uRadius))
        .and(keepRand.greaterThan(edge));
      If(live, () => {
        const s = atomicAdd(counter.element(0), uint(1));   // u32 atomic; literal must be uint
        const base2 = s.mul(uint(2));
```

Replace with:
```js
      const dist = length(vec2(wx.sub(uCam.x), wz.sub(uCam.y)));
      // gradient density descent: linear probability drop from uCullStart → uRadius
      const gradRange = uRadius.sub(uCullStart).max(float(0.001));
      const edge = dist.sub(uCullStart).div(gradRange).clamp(0, 1);
      const keepRand = slotRandFn(gx, gz, slot, int(7));
      const live = wy.greaterThan(uWaterMin)
        .and(dist.lessThan(uRadius))
        .and(keepRand.greaterThan(edge));
      If(live, () => {
        const s = atomicAdd(counter.element(0), uint(1));
        // max-blades cap: don't write beyond uMaxBlades (0 = unlimited)
        const withinCap = uMaxBlades.equal(uint(0)).or(s.lessThan(uMaxBlades));
        If(withinCap, () => {
          const base2 = s.mul(uint(2));
```

Then close the new `If(withinCap)` block. Find the closing of the original `If(live)`:
```js
        inst.element(base2).assign(vec4(wx, wy, wz, bh));
        inst.element(base2.add(uint(1))).assign(vec4(yaw, 0, 0, 0));
      });
```

Replace with:
```js
          inst.element(base2).assign(vec4(wx, wy, wz, bh));
          inst.element(base2.add(uint(1))).assign(vec4(yaw, 0, 0, 0));
        });
      });
```

- [ ] **Step 6: Expose `setCullStart` and `setMaxBlades` on the returned API**

Find the return object (~line 248):
```js
    setRadius(r) {
      r = Math.min(r, maxRadius);
      const half = Math.ceil(r / cellSize) | 0;
      if (uRadius.value === r && uHalf.value === half && uSide.value === 2 * half + 1) return;
      uRadius.value = r; uHalf.value = half; uSide.value = 2 * half + 1;
      markDirty();
    },
```

After `setRadius`, add:
```js
    setCullStart(wu) {
      const v = Math.max(0, Math.min(wu, uRadius.value));
      if (uCullStart.value === v) return;
      uCullStart.value = v;
      markDirty();
    },
    setMaxBlades(n) {
      const v = Math.max(0, n) >>> 0;
      if (uMaxBlades.value === v) return;
      uMaxBlades.value = v;
      markDirty();
    },
```

- [ ] **Step 7: Verify in browser on procedural terrain**

Open `environment-viewer.html` (no `?map=` param). Check:
- Grass renders as normal (no regression).
- No console errors.

- [ ] **Step 8: Commit**

```
git add grass-compute.js
git commit -m "feat: grass-compute - height texture path, configurable cull gradient, max blades cap"
```

---

### Task 3: environment-viewer.html — wire authored map to GPU grass + new sliders

**Files:**
- Modify: `environment-viewer.html`

**Background:** Remove the `if (loadedMap || GRASS_MODE === 'cpu')` branch for authored maps. Authored map now uses GPU compute grass with the baked height texture. Add the four new sliders.

- [ ] **Step 1: Remove the authored-map grass.js branch and extend GPU grass block**

Find (~line 1530):
```js
  // ---- grass: GPU compute (default) or legacy per-chunk CPU meshes (?grass=cpu) ----
  if (loadedMap || GRASS_MODE === 'cpu') import('./grass.js?v=density-fix-4').then(({ createGrass }) => {
    Object.assign(params, { grassCount: 40000, grassDistanceCull: 0, wind: 1.0 });
    function makeChunkGrassManager() {
```

The entire authored-map grass block ends just before:
```js
  else import('./grass-compute.js').then(({ createComputeGrass }) => {
```

Delete everything from `if (loadedMap || GRASS_MODE === 'cpu') import('./grass.js` through (and including) `}).catch(() => { /* grass is optional */ });` that closes the grass.js block. Leave only the GPU compute block.

Then change the GPU compute block from:
```js
  else import('./grass-compute.js').then(({ createComputeGrass }) => {
    Object.assign(params, { grassDensity: 8.0, grassRadius: 350, wind: 1.0 });
    const cg = createComputeGrass({
      renderer, camera,
      terrainParams: { baseAmp: terrain.baseAmp, lake: terrain.lake, lakeDepth: terrain.lakeDepth },
      waterLevel: terrain.waterLevel, density: params.grassDensity, radius: params.grassRadius,
      grassRecull: GRASS_RECULL_MODE,
      maxRadius: 600,
      addEmissive: clusteredLightsRef ? (p, n) => clusteredLightsRef.pointLightTerm(p, n) : null,
    });
    scene.add(cg.mesh);
    grassRef = {
      update: (s) => cg.update(s),
      stats: cg.stats,
      sync: () => {}, regenerate: () => {}, applyFade: () => {},
```

To (remove the `else`, always use GPU grass, pass height texture when present):
```js
  if (GRASS_MODE !== 'cpu') import('./grass-compute.js').then(({ createComputeGrass }) => {
    Object.assign(params, {
      grassDensity: 8.0,
      grassRadius: loadedMap ? 200 : 350,
      grassCullStart: loadedMap ? 150 : 280,
      grassMaxBlades: 200000,
      wind: 1.0,
    });
    const cg = createComputeGrass({
      renderer, camera,
      terrainParams: { baseAmp: terrain.baseAmp, lake: terrain.lake, lakeDepth: terrain.lakeDepth },
      waterLevel: terrain.waterLevel,
      density: params.grassDensity,
      radius: params.grassRadius,
      cullStart: params.grassCullStart,
      maxBlades: params.grassMaxBlades,
      grassRecull: GRASS_RECULL_MODE,
      maxRadius: 600,
      // authored map: feed the baked height texture instead of the closed-form formula
      heightTex: loadedMap?.heightTex ?? null,
      heightTexBounds: loadedMap?.heightTexBounds ?? null,
      addEmissive: clusteredLightsRef ? (p, n) => clusteredLightsRef.pointLightTerm(p, n) : null,
    });
    scene.add(cg.mesh);
    grassRef = {
      update: (s) => cg.update(s),
      stats: cg.stats,
      sync: () => {}, regenerate: () => {}, applyFade: () => {},
```

- [ ] **Step 2: Replace old grass sliders with the four new ones**

Find the slider block inside the GPU compute `.then` callback:
```js
    header('Grass');
    slider('grassDensity', 'Density (blades/m²)', 0, 16, 0.05, f2, () => cg.setDensity(params.grassDensity));
    slider('grassRadius', 'Radius', 8, 600, 1, fi, () => cg.setRadius(params.grassRadius));
    slider('wind', 'Wind strength', 0, 2.5, 0.01, f2, () => cg.setWind(params.wind));
```

Replace with:
```js
    header('Grass');
    slider('grassRadius', 'Radius', 8, 600, 1, fi, () => cg.setRadius(params.grassRadius));
    slider('grassCullStart', 'Cull start', 0, 600, 1, fi, () => cg.setCullStart(params.grassCullStart));
    slider('grassDensity', 'Density (blades/m²)', 0, 16, 0.05, f2, () => cg.setDensity(params.grassDensity));
    slider('grassMaxBlades', 'Max blades', 0, 500000, 1000, v => (v / 1000).toFixed(0) + 'k', () => cg.setMaxBlades(params.grassMaxBlades));
    slider('wind', 'Wind strength', 0, 2.5, 0.01, f2, () => cg.setWind(params.wind));
```

- [ ] **Step 3: Verify in browser on authored map**

Open `environment-viewer.html?map=<your-map-key>`. Check:
- Grass appears, follows player position.
- Radius slider changes the grass ring size.
- Cull start slider thins grass toward the edge.
- Max blades slider hard-caps blade count.
- No `grass.js` errors in console.

- [ ] **Step 4: Commit**

```
git add environment-viewer.html
git commit -m "feat: authored map uses GPU compute grass with height texture; add radius/cull/density/max-blades sliders"
```

---

## PART B — TREE LOD

### Task 4: forest-palette.js — coarse leaf geometry

**Files:**
- Modify: `forest-palette.js`

**Background:** Add a `leavesCoarse` geometry per variant baked with fewer, larger leaves. The existing `leaves` geometry is unchanged. Two new params: `coarseLeafRatio` (fraction of `leafCount`) and `coarseLeafSizeMult` (multiplier on `leafSize`).

- [ ] **Step 1: Add coarse leaf bake inside the variant loop**

Find the variant push (~line 57):
```js
      gen.regenerate({ ...sp, seed, leaves: leafOpts, bark: barkOpts });
      variants.push({
        speciesIdx: s,
        variant: v,
        branches: bakeFlatColor(gen.branchesMesh.geometry, sp.bark.color),
        leaves:   bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint),
        shadow:   bakeFlatColor(gen.leavesShadowMesh.geometry, sp.leaves.tint),
      });
```

Replace with:
```js
      gen.regenerate({ ...sp, seed, leaves: leafOpts, bark: barkOpts });
      const branchesGeo     = bakeFlatColor(gen.branchesMesh.geometry, sp.bark.color);
      const leavesGeo       = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);
      const shadowGeo       = bakeFlatColor(gen.leavesShadowMesh.geometry, sp.leaves.tint);

      // coarse leaf geometry: fewer, bigger leaves for LOD 2
      const ratio = Math.max(0.05, Math.min(1.0, params.coarseLeafRatio ?? 0.25));
      const sizeMult = Math.max(1.0, params.coarseLeafSizeMult ?? 2.5);
      const coarseLeafOpts = {
        ...leafOpts,
        count: Math.max(1, Math.round(leafOpts.count * ratio)),
        size: leafOpts.size * sizeMult,
        shadowFraction: 0,   // no shadow subset needed for LOD 2
      };
      gen.regenerate({ ...sp, seed, leaves: coarseLeafOpts, bark: barkOpts });
      const leavesCoarseGeo = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);

      variants.push({
        speciesIdx: s,
        variant: v,
        branches:     branchesGeo,
        leaves:       leavesGeo,
        shadow:       shadowGeo,
        leavesCoarse: leavesCoarseGeo,
      });
```

- [ ] **Step 2: Verify in browser**

Open environment-viewer.html. No console errors. Trees still render (palette bake runs on startup). The `leavesCoarse` geometry won't be visible yet — that's wired in Task 5.

- [ ] **Step 3: Commit**

```
git add forest-palette.js
git commit -m "feat: forest-palette bakes leavesCoarse geometry per variant (fewer, bigger leaves)"
```

---

### Task 5: forest-gpu.js — 4-LOD buffer layout and draw meshes

**Files:**
- Modify: `forest-gpu.js`

**Background:** Extend the draw buffer to 4 LOD regions per variant, add 4 atomic counters per variant, create 8 indirect buffers per variant (branches-L0, leaves-L0, shadow-L0, branches-L1, leaves-L1, branches-L2, coarseLeaves-L2, billboard-L3), and build all 8 mesh types. The billboard material starts with a placeholder texture; Task 6 wires the baked atlas.

- [ ] **Step 1: Add LOD uniforms and expand buffer sizes**

Find (~line 29):
```js
  const CAP = opts.capPerVariant ?? 512;
  const maxDist = opts.maxDist ?? 350;
  const V = palette.variants.length;
  const TOTAL = V * CAP;
```

Replace with:
```js
  const CAP = opts.capPerVariant ?? 512;
  const V = palette.variants.length;
  // 4 LOD regions per variant: LOD0=[g*4*CAP], LOD1=[g*4*CAP+CAP], LOD2=[+2*CAP], LOD3=[+3*CAP]
  const LODS = 4;
  const TOTAL = V * LODS * CAP;

  // LOD distance uniforms (squared stored at runtime, but set as plain world-unit distances)
  const uLodR0 = uniform(opts.lodR0 ?? 60);
  const uLodR1 = uniform(opts.lodR1 ?? 120);
  const uLodR2 = uniform(opts.lodR2 ?? 220);
```

- [ ] **Step 2: Expand draw buffer and survivor counters**

Find (~line 36):
```js
  // draw (compute-written survivors; backs the instanced draws)
  const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(TOTAL * 8), 8);
  const draw = storage(drawAttr, 'vec4', TOTAL * 2);
  // per-variant live source count (CPU-uploaded), and per-variant survivor counter (atomic)
  const countsAttr = new StorageBufferAttribute(new Uint32Array(V), 1);
  const srcCounts = storage(countsAttr, 'uint', V);
  const survCounters = storage(new StorageBufferAttribute(new Uint32Array(V), 1), 'uint', V).toAtomic();
```

Replace with:
```js
  // draw buffer: 4 LOD regions per variant, each CAP instances × 2 vec4
  const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(TOTAL * 8), 8);
  const draw = storage(drawAttr, 'vec4', TOTAL * 2);
  // per-variant source counts (CPU-uploaded)
  const countsAttr = new StorageBufferAttribute(new Uint32Array(V), 1);
  const srcCounts = storage(countsAttr, 'uint', V);
  // survivor counters: V × 4 (one per LOD per variant)
  const survAtomics = storage(new StorageBufferAttribute(new Uint32Array(V * LODS), 1), 'uint', V * LODS).toAtomic();
```

- [ ] **Step 3: Rebuild indirect buffer arrays for 8 buffers per variant**

Find (~line 46):
```js
  const indirectAttrs = [];     // [g] = { branches, leaves, shadow } IndirectStorageBufferAttribute
  const indirectNodes = [];     // [g] = { branches, leaves, shadow } storage nodes
  for (let g = 0; g < V; g++) {
    const variant = palette.variants[g];
    const mk = (geo) => new IndirectStorageBufferAttribute(new Uint32Array([geo.index.count, 0, 0, 0, 0]), 5);
    const a = { branches: mk(variant.branches), leaves: mk(variant.leaves), shadow: mk(variant.shadow) };
    indirectAttrs.push(a);
    indirectNodes.push({
      branches: storage(a.branches, 'uint', 5),
      leaves: storage(a.leaves, 'uint', 5),
      shadow: storage(a.shadow, 'uint', 5),
    });
  }
```

Replace with:
```js
  // 8 indirect buffers per variant (branches/leaves/shadow at L0, branches/leaves at L1,
  // branches/coarseLeaves at L2, billboard at L3).
  // WebGPU binds ≤8 storage buffers per compute stage; finalize is split into A (L0+L1)
  // and B (L2+L3) to stay at 6 and 4 bindings respectively.
  const indirectAttrs = [];
  const indirectNodes = [];
  for (let g = 0; g < V; g++) {
    const v = palette.variants[g];
    const mk = (geo) => new IndirectStorageBufferAttribute(new Uint32Array([geo.index.count, 0, 0, 0, 0]), 5);
    // billboard uses a PlaneGeometry(1,1) → 6 indices
    const mkBill = () => new IndirectStorageBufferAttribute(new Uint32Array([6, 0, 0, 0, 0]), 5);
    const a = {
      branchesL0:     mk(v.branches),
      leavesL0:       mk(v.leaves),
      shadowL0:       mk(v.shadow),
      branchesL1:     mk(v.branches),
      leavesL1:       mk(v.leaves),
      branchesL2:     mk(v.branches),
      coarseLeavesL2: mk(v.leavesCoarse),
      billboardL3:    mkBill(),
    };
    indirectAttrs.push(a);
    const sn = (attr) => storage(attr, 'uint', 5);
    indirectNodes.push({
      branchesL0:     sn(a.branchesL0),
      leavesL0:       sn(a.leavesL0),
      shadowL0:       sn(a.shadowL0),
      branchesL1:     sn(a.branchesL1),
      leavesL1:       sn(a.leavesL1),
      branchesL2:     sn(a.branchesL2),
      coarseLeavesL2: sn(a.coarseLeavesL2),
      billboardL3:    sn(a.billboardL3),
    });
  }
```

- [ ] **Step 4: Rewrite the reset kernel**

Find (~line 66):
```js
  const reset = Fn(() => { atomicStore(survCounters.element(instanceIndex), uint(0)); })().compute(V);
```

Replace with:
```js
  const reset = Fn(() => { atomicStore(survAtomics.element(instanceIndex), uint(0)); })().compute(V * LODS);
```

- [ ] **Step 5: Rewrite the cull kernel for 4 LOD regions**

Find the entire cull kernel (~line 68):
```js
  const cull = Fn(() => {
    const idx = int(instanceIndex);                 // 0 .. V*CAP-1
    const cap = int(CAP);
    const localSlot = modInt(idx, cap);
    const g = idx.sub(localSlot).div(cap);          // integer div by exact multiple (grass pattern)
    If(localSlot.lessThan(int(srcCounts.element(g))), () => {
      const rec0 = src.element(idx.mul(uint(2)));   // (x,y,z,scale)
      const dx = rec0.x.sub(uCam.x);
      const dz = rec0.z.sub(uCam.y);
      If(dx.mul(dx).add(dz.mul(dz)).lessThanEqual(uMaxDist.mul(uMaxDist)), () => {
        const s = atomicAdd(survCounters.element(g), uint(1));   // survivor index within variant g
        const outBase = uint(g.mul(cap)).add(s).mul(uint(2));    // global draw slot for variant g
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(src.element(idx.mul(uint(2)).add(uint(1))));
      });
    });
  })().compute(TOTAL);
```

Wait — `TOTAL` is now `V * LODS * CAP`, but we only have `V * CAP` source instances. We need to keep the compute dispatch at `V * CAP` (one thread per source slot). Fix `TOTAL` usage:

Replace `})().compute(TOTAL);` → `})().compute(V * CAP);` **and** update the kernel:

```js
  const SRC_TOTAL = V * CAP;   // source buffer size (unchanged from original)
  const cull = Fn(() => {
    const idx = int(instanceIndex);          // 0 .. V*CAP-1
    const cap = int(CAP);
    const localSlot = modInt(idx, cap);
    const g = idx.sub(localSlot).div(cap);
    If(localSlot.lessThan(int(srcCounts.element(g))), () => {
      const rec0 = src.element(idx.mul(uint(2)));
      const rec1 = src.element(idx.mul(uint(2)).add(uint(1)));
      const dx = rec0.x.sub(uCam.x);
      const dz = rec0.z.sub(uCam.y);
      const dist2 = dx.mul(dx).add(dz.mul(dz));
      const r0sq = uLodR0.mul(uLodR0);
      const r1sq = uLodR1.mul(uLodR1);
      const r2sq = uLodR2.mul(uLodR2);
      const lodCap = int(LODS * CAP);
      const varBase = g.mul(lodCap);   // start of this variant's 4 LOD regions in draw buffer

      If(dist2.lessThanEqual(r0sq), () => {
        const ci = uint(g.mul(int(LODS)));                        // survAtomics[g*4 + 0]
        const s = atomicAdd(survAtomics.element(ci), uint(1));
        const outBase = uint(varBase).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      }).ElseIf(dist2.lessThanEqual(r1sq), () => {
        const ci = uint(g.mul(int(LODS)).add(int(1)));            // g*4 + 1
        const s = atomicAdd(survAtomics.element(ci), uint(1));
        const outBase = uint(varBase.add(int(CAP))).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      }).ElseIf(dist2.lessThanEqual(r2sq), () => {
        const ci = uint(g.mul(int(LODS)).add(int(2)));            // g*4 + 2
        const s = atomicAdd(survAtomics.element(ci), uint(1));
        const outBase = uint(varBase.add(int(2 * CAP))).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      }).Else(() => {
        const ci = uint(g.mul(int(LODS)).add(int(3)));            // g*4 + 3
        const s = atomicAdd(survAtomics.element(ci), uint(1));
        const outBase = uint(varBase.add(int(3 * CAP))).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      });
    });
  })().compute(SRC_TOTAL);
```

- [ ] **Step 6: Rewrite finalizers (split A + B per variant)**

Find:
```js
  const finalizers = [];
  for (let g = 0; g < V; g++) {
    const nodes = indirectNodes[g];
    finalizers.push(Fn(() => {
      const c = atomicLoad(survCounters.element(g));
      nodes.branches.element(1).assign(c);
      nodes.leaves.element(1).assign(c);
      nodes.shadow.element(1).assign(c);
    })().compute(1));
  }
```

Replace with:
```js
  // Two finalize passes per variant to stay ≤8 storage bindings per compute stage:
  //   A: reads survAtomics (1) + writes 5 indirect buffers for LOD 0+1 = 6 bindings
  //   B: reads survAtomics (1) + writes 3 indirect buffers for LOD 2+3 = 4 bindings
  const finalizersA = [], finalizersB = [];
  for (let g = 0; g < V; g++) {
    const nodes = indirectNodes[g];
    const c0idx = g * LODS + 0, c1idx = g * LODS + 1;
    const c2idx = g * LODS + 2, c3idx = g * LODS + 3;
    finalizersA.push(Fn(() => {
      const c0 = atomicLoad(survAtomics.element(c0idx));
      const c1 = atomicLoad(survAtomics.element(c1idx));
      nodes.branchesL0.element(1).assign(c0);
      nodes.leavesL0.element(1).assign(c0);
      nodes.shadowL0.element(1).assign(c0);
      nodes.branchesL1.element(1).assign(c1);
      nodes.leavesL1.element(1).assign(c1);
    })().compute(1));
    finalizersB.push(Fn(() => {
      const c2 = atomicLoad(survAtomics.element(c2idx));
      const c3 = atomicLoad(survAtomics.element(c3idx));
      nodes.branchesL2.element(1).assign(c2);
      nodes.coarseLeavesL2.element(1).assign(c2);
      nodes.billboardL3.element(1).assign(c3);
    })().compute(1));
  }
```

- [ ] **Step 7: Build instance node helpers for each LOD region**

Find:
```js
  function instanceNodes(offset) {
    const recBase = uint(offset).add(instanceIndex).mul(uint(2));
    const rec0 = draw.element(recBase);                  // (x,y,z,scale)
    const rec1 = draw.element(recBase.add(uint(1)));     // (yaw,...)
    const scale = rec0.w, yaw = rec1.x;
    const cy = cos(yaw), sy = sin(yaw);
    const px = positionLocal.x, py = positionLocal.y, pz = positionLocal.z;
    const rx = px.mul(cy).add(pz.mul(sy));
    const rz = pz.mul(cy).sub(px.mul(sy));
    const world = vec3(
      rec0.x.add(rx.mul(scale)),
      rec0.y.add(py.mul(scale)),
      rec0.z.add(rz.mul(scale)),
    );
    const nx = normalLocal.x, ny = normalLocal.y, nz = normalLocal.z;
    const nWorld = vec3(nx.mul(cy).add(nz.mul(sy)), ny, nz.mul(cy).sub(nx.mul(sy)));
    return { world, nWorld };
  }
```

Replace with (same logic, takes slot-offset in terms of instance slots, not element indices):
```js
  function instanceNodes(slotOffset) {
    // slotOffset: first instance slot index in draw buffer for this LOD/variant region
    const recBase = uint(slotOffset).add(instanceIndex).mul(uint(2));
    const rec0 = draw.element(recBase);
    const rec1 = draw.element(recBase.add(uint(1)));
    const scale = rec0.w, yaw = rec1.x;
    const cy = cos(yaw), sy = sin(yaw);
    const px = positionLocal.x, py = positionLocal.y, pz = positionLocal.z;
    const rx = px.mul(cy).add(pz.mul(sy));
    const rz = pz.mul(cy).sub(px.mul(sy));
    const world = vec3(
      rec0.x.add(rx.mul(scale)),
      rec0.y.add(py.mul(scale)),
      rec0.z.add(rz.mul(scale)),
    );
    const nx = normalLocal.x, ny = normalLocal.y, nz = normalLocal.z;
    const nWorld = vec3(nx.mul(cy).add(nz.mul(sy)), ny, nz.mul(cy).sub(nx.mul(sy)));
    return { world, nWorld };
  }
  // slotOffset for variant g, LOD l
  function lodSlotOffset(g, l) { return g * LODS * CAP + l * CAP; }
```

- [ ] **Step 8: Rebuild per-variant draw meshes for all 8 LOD mesh types**

Find the existing per-variant mesh build loop:
```js
  const branchMats = [], leafMats = [], meshes = [];
  for (let g = 0; g < V; g++) {
    const variant = palette.variants[g];
    const { world, nWorld } = instanceNodes(g * CAP);
    ...
    meshes.push(drawMesh(variant.branches, branchMat, indirectAttrs[g].branches, true));
    meshes.push(drawMesh(variant.leaves, leafMat, indirectAttrs[g].leaves, false));
    meshes.push(drawMesh(variant.shadow, leafMat, indirectAttrs[g].shadow, true));
  }
```

Replace with:
```js
  const branchMats = [], leafMats = [], coarseLeafMats = [], billboardMats = [], meshes = [];

  // Cross-quad billboard geometry: two PlaneGeometry(1,1) quads merged at 90° in XY/ZY planes.
  function buildCrossQuadGeo() {
    const g1 = new THREE.PlaneGeometry(1, 1);   // XY plane (faces +Z)
    const g2 = new THREE.PlaneGeometry(1, 1);   // ZY plane (faces +X)
    g2.rotateY(Math.PI / 2);
    const merged = THREE.BufferGeometryUtils.mergeGeometries([g1, g2]);
    return merged;
  }
  const crossQuadGeo = buildCrossQuadGeo();

  for (let g = 0; g < V; g++) {
    const variant = palette.variants[g];
    // LOD 0 nodes
    const n0 = instanceNodes(lodSlotOffset(g, 0));
    // LOD 1 nodes
    const n1 = instanceNodes(lodSlotOffset(g, 1));
    // LOD 2 nodes
    const n2 = instanceNodes(lodSlotOffset(g, 2));
    // LOD 3 nodes (billboard)
    const n3 = instanceNodes(lodSlotOffset(g, 3));

    function makeMat(roughness, doubleSide) {
      const m = new MeshStandardNodeMaterial({ vertexColors: true, roughness, metalness: 0.0, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
      return m;
    }
    const branchMat = makeMat(0.9, false);
    const leafMat   = makeMat(1.0, true);
    const coarseMat = makeMat(1.0, true);
    const billMat   = new MeshBasicNodeMaterial({ transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });

    // Apply positionNode/normalNode per LOD
    branchMat.positionNode = n0.world; branchMat.normalNode = n0.nWorld;   // LOD 0 branches
    leafMat.positionNode   = n0.world; leafMat.normalNode   = n0.nWorld;   // shared for LOD 0 leaves + shadow

    // LOD 1 needs separate mats (different draw buffer region)
    const branchMat1 = makeMat(0.9, false);
    branchMat1.positionNode = n1.world; branchMat1.normalNode = n1.nWorld;
    const leafMat1   = makeMat(1.0, true);
    leafMat1.positionNode   = n1.world; leafMat1.normalNode   = n1.nWorld;

    // LOD 2 mats
    const branchMat2 = makeMat(0.9, false);
    branchMat2.positionNode = n2.world; branchMat2.normalNode = n2.nWorld;
    coarseMat.positionNode  = n2.world; coarseMat.normalNode  = n2.nWorld;

    // LOD 3 billboard — positionNode scales local vertex by scale, places at world position
    // Billboard faces camera via cross-quad geometry (no camera-align needed)
    billMat.positionNode = n3.world;

    if (opts.addEmissive) {
      for (const m of [branchMat, leafMat, branchMat1, leafMat1, branchMat2, coarseMat]) {
        m.emissiveNode = opts.addEmissive(m.positionNode, m.normalNode);
      }
    }

    branchMats.push({ L0: branchMat, L1: branchMat1, L2: branchMat2 });
    leafMats.push({ L0: leafMat, L1: leafMat1 });
    coarseLeafMats.push(coarseMat);
    billboardMats.push(billMat);

    // LOD 0: branches, leaves, shadow
    meshes.push(drawMesh(variant.branches, branchMat,  indirectAttrs[g].branchesL0, true));
    meshes.push(drawMesh(variant.leaves,   leafMat,    indirectAttrs[g].leavesL0,   false));
    meshes.push(drawMesh(variant.shadow,   leafMat,    indirectAttrs[g].shadowL0,   true));
    // LOD 1: branches, leaves
    meshes.push(drawMesh(variant.branches, branchMat1, indirectAttrs[g].branchesL1, true));
    meshes.push(drawMesh(variant.leaves,   leafMat1,   indirectAttrs[g].leavesL1,   false));
    // LOD 2: branches, coarse leaves
    meshes.push(drawMesh(variant.branches, branchMat2, indirectAttrs[g].branchesL2, true));
    meshes.push(drawMesh(variant.leavesCoarse, coarseMat, indirectAttrs[g].coarseLeavesL2, false));
    // LOD 3: billboard (placeholder map, replaced by bake in Task 6)
    const billGeo = crossQuadGeo.clone();
    billGeo.instanceCount = CAP;
    billGeo.indirect = indirectAttrs[g].billboardL3;
    const billMesh = new THREE.Mesh(billGeo, billMat);
    billMesh.frustumCulled = false;
    meshes.push(billMesh);
  }
```

Note: `THREE.BufferGeometryUtils` needs to be imported. Add to the imports at the top of `forest-gpu.js`:
```js
import { BufferGeometryUtils } from 'three/addons/utils/BufferGeometryUtils.js';
```
And replace `THREE.BufferGeometryUtils.mergeGeometries` → `BufferGeometryUtils.mergeGeometries`.

- [ ] **Step 9: Fix the update() method to use new compute arrays**

Find:
```js
    async update() {
      ...
      await renderer.computeAsync([reset, cull, ...finalizers]);
```

Replace with:
```js
    async update() {
      ...
      await renderer.computeAsync([reset, cull, ...finalizersA, ...finalizersB]);
```

- [ ] **Step 10: Expose LOD distance setters on the returned API**

Find `setMaxDist(d)` in the return object and replace with:
```js
    setLodDistances(r0, r1, r2) {
      let dirty = false;
      if (uLodR0.value !== r0) { uLodR0.value = r0; dirty = true; }
      if (uLodR1.value !== r1) { uLodR1.value = r1; dirty = true; }
      if (uLodR2.value !== r2) { uLodR2.value = r2; dirty = true; }
      if (dirty) this.dirty = true;
    },
```

Also remove `uMaxDist` uniform (no longer used — LOD 3 catches all beyond R2).

- [ ] **Step 11: Fix `applyTextureSet` to iterate new mat structure**

Find:
```js
    applyTextureSet(fn) { for (let g = 0; g < V; g++) fn(branchMats[g], leafMats[g]); },
```

Replace with:
```js
    applyTextureSet(fn) {
      for (let g = 0; g < V; g++) {
        const bm = branchMats[g], lm = leafMats[g];
        fn(bm.L0, lm.L0);
        fn(bm.L1, lm.L1);
        fn(bm.L2, coarseLeafMats[g]);
      }
    },
    get billboardMaterials() { return billboardMats; },
```

- [ ] **Step 12: Verify in browser on authored map**

Open `environment-viewer.html?map=<key>`. Check:
- Trees render without errors. At close range (LOD 0) you should see full trees with shadows. As you move back you should see leaves disappear (LOD 3 billboard crosses will be invisible until Task 6 wires textures).
- No `Cannot read properties` or binding errors in console.

- [ ] **Step 13: Commit**

```
git add forest-gpu.js
git commit -m "feat: forest-gpu 4-LOD buffer layout, LOD cull kernel, split A/B finalize, per-LOD draw meshes"
```

---

### Task 6: Billboard bake + IndexedDB cache

**Files:**
- Modify: `environment-viewer.html`

**Background:** After `rebuildForestGPU` runs, bake each variant's LOD-0 geometry to an offscreen texture, store as PNG in IndexedDB. On reload, skip bake if cache hit. Wire a toggle between cross-quad and 8-angle atlas modes.

- [ ] **Step 1: Add billboard bake helpers after the forest import block**

In `environment-viewer.html`, find the section after `rebuildForestGPU` is defined (~line 714). Add a new block:

```js
  // ---- billboard atlas bake + IndexedDB cache ----
  const BILLBOARD_DB = 'forest-billboards';
  const BILLBOARD_DB_VERSION = 1;

  function billboardCacheKey(mode) {
    const p = params;
    return `${MASTER_SEED}|${p.leafCount}|${p.leafSize}|${p.species}|${p.diversity}|${p.generalization}|${p.variantsPerSpecies ?? 4}|${mode}`;
  }

  function openBillboardDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(BILLBOARD_DB, BILLBOARD_DB_VERSION);
      req.onupgradeneeded = e => e.target.result.createObjectStore('atlases');
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function saveBillboardCache(key, blobs) {
    const db = await openBillboardDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('atlases', 'readwrite');
      tx.objectStore('atlases').put(blobs, key);
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function loadBillboardCache(key) {
    const db = await openBillboardDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('atlases', 'readonly').objectStore('atlases').get(key);
      req.onsuccess = e => resolve(e.result ?? null);
      req.onerror = e => reject(e.target.error);
    });
  }

  // Render a variant's LOD-0 mesh to an offscreen target from `captureCount` yaw angles.
  // Returns an array of PNG Blobs, one per angle.
  async function bakeVariantBillboard(variant, captureCount) {
    const SIZE = 256;
    const target = new THREE.WebGPURenderTarget(SIZE, SIZE * captureCount, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

    const bakeScene = new THREE.Scene();
    bakeScene.background = new THREE.Color(0, 0, 0);

    // Build a temporary mesh from variant LOD-0 geometry using a plain material
    const tmpBranchMat = new THREE.MeshStandardMaterial({ vertexColors: true });
    const tmpLeafMat   = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const branchMesh   = new THREE.Mesh(variant.branches, tmpBranchMat);
    const leafMesh     = new THREE.Mesh(variant.leaves,   tmpLeafMat);
    bakeScene.add(branchMesh, leafMesh);

    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(2, 4, 3);
    bakeScene.add(sun, new THREE.AmbientLight(0xffffff, 0.4));

    // Orthographic camera sized to the tree's bounding box
    const bbox = new THREE.Box3().setFromObject(branchMesh).expandByObject(leafMesh);
    const size = new THREE.Vector3(); bbox.getSize(size);
    const center = new THREE.Vector3(); bbox.getCenter(center);
    const halfH = size.y * 0.55, halfW = Math.max(size.x, size.z) * 0.55;
    const bakeCamera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 500);

    const blobs = [];
    for (let i = 0; i < captureCount; i++) {
      const yaw = (i / captureCount) * Math.PI * 2;
      const dist = Math.max(size.x, size.z) * 2;
      bakeCamera.position.set(
        center.x + Math.sin(yaw) * dist,
        center.y + size.y * 0.1,
        center.z + Math.cos(yaw) * dist,
      );
      bakeCamera.lookAt(center);
      renderer.setRenderTarget(target);
      await renderer.renderAsync(bakeScene, bakeCamera);
      renderer.setRenderTarget(null);

      // Read pixels from a SIZE×SIZE region (offset by i*SIZE rows)
      const pixels = new Uint8Array(SIZE * SIZE * 4);
      renderer.readRenderTargetPixels(target, 0, i * SIZE, SIZE, SIZE, pixels);

      const canvas = document.createElement('canvas');
      canvas.width = SIZE; canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(SIZE, SIZE);
      // WebGPU readback is flipped vertically — un-flip
      for (let row = 0; row < SIZE; row++) {
        const srcRow = (SIZE - 1 - row) * SIZE * 4;
        imgData.data.set(pixels.subarray(srcRow, srcRow + SIZE * 4), row * SIZE * 4);
      }
      ctx.putImageData(imgData, 0, 0);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      blobs.push(blob);
    }

    target.dispose();
    tmpBranchMat.dispose(); tmpLeafMat.dispose();
    return blobs;
  }

  // Load PNG Blob array → array of THREE.Texture
  function blobsToTextures(blobs) {
    return blobs.map(blob => {
      const url = URL.createObjectURL(blob);
      const tex = new THREE.TextureLoader().load(url, () => URL.revokeObjectURL(url));
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
  }

  // Build an 8-angle atlas texture from 8 individual blob textures (packed 4×2)
  function buildAtlasTexture(blobs) {
    const SIZE = 256;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE * 4; canvas.height = SIZE * 2;
    const ctx = canvas.getContext('2d');
    const draws = blobs.map(blob => {
      const url = URL.createObjectURL(blob);
      return new Promise(res => {
        const img = new Image(); img.onload = () => { URL.revokeObjectURL(url); res(img); };
        img.src = url;
      });
    });
    return Promise.all(draws).then(imgs => {
      imgs.forEach((img, i) => ctx.drawImage(img, (i % 4) * SIZE, Math.floor(i / 4) * SIZE, SIZE, SIZE));
      return new Promise(res => canvas.toBlob(res, 'image/png'));
    }).then(atlasBlob => {
      const url = URL.createObjectURL(atlasBlob);
      const tex = new THREE.TextureLoader().load(url, () => URL.revokeObjectURL(url));
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
  }

  // Assign baked textures to billboard materials. Mode determines layout.
  async function applyBillboardTextures(variantTextures, mode) {
    if (!forestGPU) return;
    const mats = forestGPU.billboardMaterials;
    for (let g = 0; g < mats.length; g++) {
      const mat = mats[g];
      if (mode === '8way') {
        const atlas = await buildAtlasTexture(variantTextures[g]);
        mat.map = atlas;
      } else {
        const tex = blobsToTextures([variantTextures[g][0]])[0];
        mat.map = tex;
      }
      mat.needsUpdate = true;
    }
  }

  // Top-level: check cache, bake if needed, apply.
  async function syncBillboards(mode) {
    if (!forestGPU || !loadedMap) return;
    const key = billboardCacheKey(mode);
    let cached = null;
    try { cached = await loadBillboardCache(key); } catch (e) { /* ignore */ }
    if (cached) {
      await applyBillboardTextures(cached, mode);
      return;
    }
    showStatus('baking billboard atlases...');
    const palette = forestGPU._palette;
    if (!palette) { showStatus(''); return; }
    const captureCount = mode === '8way' ? 8 : 1;
    const variantBlobs = [];
    for (const variant of palette.variants) {
      variantBlobs.push(await bakeVariantBillboard(variant, captureCount));
    }
    try { await saveBillboardCache(key, variantBlobs); } catch (e) { console.warn('billboard cache write failed', e); }
    await applyBillboardTextures(variantBlobs, mode);
    showStatus('');
  }
```

- [ ] **Step 2: Expose `_palette` from `forest-gpu.js`**

In `forest-gpu.js`, add to the return object:
```js
    _palette: palette,   // for billboard bake access
```

- [ ] **Step 3: Call `syncBillboards` after `rebuildForestGPU`**

Find `rebuildForestGPU`:
```js
  function rebuildForestGPU(texSet) {
    ...
    forestPaletteMode = texSet ? texSet.mode : 'procedural';
    gpuTreeChunks.clear();
    regenerateGPU(true);
  }
```

Add after `regenerateGPU(true);`:
```js
    syncBillboards(params.billboardMode ?? 'cross');
```

- [ ] **Step 4: Add billboard mode toggle slider**

In the Trees slider block, add after the LOD distance sliders (Task 7 wires these — add a placeholder for now, or add both here):
```js
    // billboard mode toggle
    Object.assign(params, { billboardMode: 'cross' });
    const billToggleBtn = document.createElement('button');
    billToggleBtn.textContent = 'Billboard: cross-quad';
    billToggleBtn.style.cssText = 'margin:4px 0;padding:4px 8px;cursor:pointer;width:100%';
    billToggleBtn.onclick = () => {
      params.billboardMode = params.billboardMode === 'cross' ? '8way' : 'cross';
      billToggleBtn.textContent = `Billboard: ${params.billboardMode === 'cross' ? 'cross-quad' : '8-angle atlas'}`;
      syncBillboards(params.billboardMode);
    };
    // insert into the panel — find the forest/trees section header element
    fi.appendChild(billToggleBtn);
```

(Replace `fi.appendChild` with the correct panel-insertion pattern matching how `slider()` works in the existing UI code.)

- [ ] **Step 5: Verify in browser**

Open `environment-viewer.html?map=<key>`. Check:
- On first load: console shows "baking billboard atlases..." status briefly.
- Trees far beyond R2 show billboard crosses.
- On reload: bake is skipped (check DevTools → Application → IndexedDB → forest-billboards).
- Toggle button switches between cross-quad and 8-angle atlas modes.

- [ ] **Step 6: Commit**

```
git add environment-viewer.html forest-gpu.js
git commit -m "feat: billboard bake pipeline with IndexedDB cache, cross-quad/8-angle toggle"
```

---

### Task 7: environment-viewer.html — tree LOD + coarse leaf sliders

**Files:**
- Modify: `environment-viewer.html`

**Background:** Wire the LOD distance sliders (R0, R1, R2) and coarse leaf tuning sliders (ratio, size mult). Coarse leaf changes trigger a palette rebuild via `rebuildForestGPU`.

- [ ] **Step 1: Add LOD distance params and sliders**

Find the trees params block (~line 661):
```js
  const params = {
    count: loadedMap ? 500 : 18, placement: 'random', maxSize: 0.55, ...
  };
```

Add LOD params:
```js
    treeLodR0: 60, treeLodR1: 120, treeLodR2: 220,
    coarseLeafRatio: 0.25, coarseLeafSizeMult: 2.5,
```

- [ ] **Step 2: Pass coarse leaf params to `rebuildForestGPU`**

Find `paramsForRecords`:
```js
  const paramsForRecords = () => ({
    ...params, masterSeed: MASTER_SEED, waterLevel: terrain.waterLevel,
    targetChunkCount: forestTargetChunkCount(),
    treeDensityAt: loadedMap ? (x, z) => loadedMap.treeDensityAt(x, z) : null,
  });
```

No change needed here (palette params flow through `params` already).

Find `rebuildForestGPU`:
```js
    const palette = createForestPalette({ createTree, params, masterSeed: MASTER_SEED, texSet });
```

`params` already includes `coarseLeafRatio` and `coarseLeafSizeMult` — they flow through automatically.

- [ ] **Step 3: Wire LOD sliders in the Trees panel**

Find the existing tree count/species sliders area. Add the new sliders in the Trees header section:

```js
    if (loadedMap && forestGPU) {
      header('Tree LOD');
      const updateLod = () => forestGPU.setLodDistances(params.treeLodR0, params.treeLodR1, params.treeLodR2);
      slider('treeLodR0', 'LOD 0→1 (full→no shadow)', 10, 300, 1, fi, updateLod);
      slider('treeLodR1', 'LOD 1→2 (no shadow→coarse leaves)', 20, 400, 1, fi, updateLod);
      slider('treeLodR2', 'LOD 2→3 (coarse→billboard)', 40, 600, 1, fi, updateLod);
      let coarseRebuildTimer;
      const scheduleCoarseRebuild = () => {
        clearTimeout(coarseRebuildTimer);
        coarseRebuildTimer = setTimeout(() => rebuildForestGPU(currentTexSet()), 400);
      };
      slider('coarseLeafRatio', 'Coarse leaf ratio', 0.05, 0.6, 0.01, f2, scheduleCoarseRebuild);
      slider('coarseLeafSizeMult', 'Coarse leaf size ×', 1.0, 5.0, 0.1, f2, scheduleCoarseRebuild);
    }
```

(Note: `currentTexSet()` should return the active texSet — check how `bindTextureSet` / `syncTextureSet` tracks the current set in the existing code and use the same pattern.)

- [ ] **Step 4: Also update `forestCullDist` / remove `updateForestCull`**

The old `updateForestCull` called `forestGPU.setMaxDist(...)`. Since `setMaxDist` no longer exists (replaced by `setLodDistances`), remove or guard any calls to it:

Find and remove:
```js
  const updateForestCull = () => { if (forestGPU) forestGPU.setMaxDist(forestCullDist()); };
```

And any call sites like `updateForestCull()` in `updateDrawDistance`.

- [ ] **Step 5: Verify LOD transitions in browser**

Open `environment-viewer.html?map=<key>`. Walk away from trees slowly:
- At R0: shadows disappear.
- At R1: full leaves replaced by coarse (bigger, fewer).
- At R2: billboards replace geometry.
- Coarse leaf ratio slider rebuilds palette + updates appearance.

- [ ] **Step 6: Commit**

```
git add environment-viewer.html
git commit -m "feat: tree LOD distance sliders, coarse leaf tuning sliders wired to forest rebuild"
```

---

## PART C — CLOUDS

### Task 8: clouds.js — add setExtent()

**Files:**
- Modify: `clouds.js`

- [ ] **Step 1: Add `setExtent` method**

Find the public API at the bottom of `clouds.js`:
```js
  setSpeed(speed)       { this.speed = speed; }
  setOpacity(opacity)   { this.material._uOpacity.value = opacity; }
  setCoverage(coverage) { this.material._uCoverage.value = coverage; }
  setPuff(puff)         { this.material._uPuff.value = puff; }
  setSoftness(softness) { this.material._uSoftness.value = softness; }
  setFade(fade)         { this.material._uFade.value = fade; }
```

Add after `setFade`:
```js
  // Resize the cloud quad. Base size is 2000 world units; extent scales relative to that.
  setExtent(worldUnits) {
    const s = worldUnits / 2000;
    this.scale.set(s, 1, s);
  }
```

- [ ] **Step 2: Verify no regression**

Open `environment-viewer.html`. Clouds render as before. No errors.

- [ ] **Step 3: Commit**

```
git add clouds.js
git commit -m "feat: Clouds.setExtent() scales quad relative to 2000-unit base"
```

---

### Task 9: environment-viewer.html — camera-follow, extent slider, second cloud layer

**Files:**
- Modify: `environment-viewer.html`

- [ ] **Step 1: Add camera XZ follow in the animate loop**

Find in the animate loop:
```js
  if (cloudsRef) cloudsRef.update(now / 1000);
```

Replace with:
```js
  if (cloudsRef) {
    cloudsRef.position.x = camera.position.x;
    cloudsRef.position.z = camera.position.z;
    cloudsRef.update(now / 1000);
  }
  if (clouds2Ref) {
    clouds2Ref.position.x = camera.position.x;
    clouds2Ref.position.z = camera.position.z;
    clouds2Ref.update(now / 1000);
  }
```

- [ ] **Step 2: Declare `clouds2Ref` alongside `cloudsRef`**

Find:
```js
let grassRef = null, waterRef = null, regenTrees = null, cloudsRef = null, forestGPURef = null;
```

Replace with:
```js
let grassRef = null, waterRef = null, regenTrees = null, cloudsRef = null, clouds2Ref = null, forestGPURef = null;
```

- [ ] **Step 3: Add extent slider to layer 1 and wire layer 2 in the clouds block**

Find the clouds `.then` block:
```js
  import('./clouds.js').then(({ Clouds }) => {
    Object.assign(params, { cloudHeight: 120, cloudCover: 0.4, cloudOpacity: 0.9, cloudSpeed: 1.0,
      cloudPuff: 1.0, cloudSoftness: 0.3, cloudFade: 0.01 });
    cloudsRef = new Clouds();
    cloudsRef.rotation.x = -Math.PI / 2;
    cloudsRef.position.y = params.cloudHeight;
    cloudsRef.setCoverage(params.cloudCover);
    cloudsRef.setOpacity(params.cloudOpacity);
    cloudsRef.setSpeed(params.cloudSpeed);
    cloudsRef.setPuff(params.cloudPuff);
    cloudsRef.setSoftness(params.cloudSoftness);
    cloudsRef.setFade(params.cloudFade);
    scene.add(cloudsRef);
    header('Clouds');
    slider('cloudHeight', 'Height', 20, 200, 1, fi, () => cloudsRef.position.y = params.cloudHeight);
    slider('cloudCover', 'Coverage', 0, 0.9, 0.01, f2, () => cloudsRef.setCoverage(params.cloudCover));
    slider('cloudPuff', 'Puff size', 0.3, 3, 0.01, f2, () => cloudsRef.setPuff(params.cloudPuff));
    slider('cloudSoftness', 'Softness', 0.05, 0.5, 0.01, f2, () => cloudsRef.setSoftness(params.cloudSoftness));
    slider('cloudOpacity', 'Opacity', 0, 1, 0.01, f2, () => cloudsRef.setOpacity(params.cloudOpacity));
    slider('cloudFade', 'Horizon fade', 0.002, 0.05, 0.001, v => v.toFixed(3), () => cloudsRef.setFade(params.cloudFade));
    slider('cloudSpeed', 'Drift speed', 0, 4, 0.01, f2, () => cloudsRef.setSpeed(params.cloudSpeed));
  }).catch(() => { /* clouds are optional */ });
```

Replace with:
```js
  import('./clouds.js').then(({ Clouds }) => {
    // ---- Layer 1 ----
    Object.assign(params, {
      cloudHeight: 120, cloudExtent: 2000,
      cloudCover: 0.4, cloudOpacity: 0.9, cloudSpeed: 1.0,
      cloudPuff: 1.0, cloudSoftness: 0.3, cloudFade: 0.01,
    });
    cloudsRef = new Clouds();
    cloudsRef.rotation.x = -Math.PI / 2;
    cloudsRef.position.y = params.cloudHeight;
    cloudsRef.setExtent(params.cloudExtent);
    cloudsRef.setCoverage(params.cloudCover);
    cloudsRef.setOpacity(params.cloudOpacity);
    cloudsRef.setSpeed(params.cloudSpeed);
    cloudsRef.setPuff(params.cloudPuff);
    cloudsRef.setSoftness(params.cloudSoftness);
    cloudsRef.setFade(params.cloudFade);
    scene.add(cloudsRef);

    header('Clouds (layer 1)');
    slider('cloudHeight',  'Height',       20, 400, 1,     fi,  () => cloudsRef.position.y = params.cloudHeight);
    slider('cloudExtent',  'Extent',       500, 8000, 10,  fi,  () => cloudsRef.setExtent(params.cloudExtent));
    slider('cloudCover',   'Coverage',     0, 0.9, 0.01,   f2,  () => cloudsRef.setCoverage(params.cloudCover));
    slider('cloudPuff',    'Puff size',    0.3, 3, 0.01,   f2,  () => cloudsRef.setPuff(params.cloudPuff));
    slider('cloudSoftness','Softness',     0.05, 0.5, 0.01,f2,  () => cloudsRef.setSoftness(params.cloudSoftness));
    slider('cloudOpacity', 'Opacity',      0, 1, 0.01,     f2,  () => cloudsRef.setOpacity(params.cloudOpacity));
    slider('cloudFade',    'Horizon fade', 0.002, 0.05, 0.001, v => v.toFixed(3), () => cloudsRef.setFade(params.cloudFade));
    slider('cloudSpeed',   'Drift speed',  0, 4, 0.01,     f2,  () => cloudsRef.setSpeed(params.cloudSpeed));

    // ---- Layer 2 ----
    Object.assign(params, {
      cloud2Height: 280, cloud2Extent: 4000,
      cloud2Cover: 0.3, cloud2Opacity: 0.5, cloud2Speed: 0.6,
      cloud2Puff: 3.0, cloud2Softness: 0.3,
    });
    clouds2Ref = new Clouds();
    clouds2Ref.rotation.x = -Math.PI / 2;
    clouds2Ref.position.y = params.cloud2Height;
    clouds2Ref.setExtent(params.cloud2Extent);
    clouds2Ref.setCoverage(params.cloud2Cover);
    clouds2Ref.setOpacity(params.cloud2Opacity);
    clouds2Ref.setSpeed(params.cloud2Speed);
    clouds2Ref.setPuff(params.cloud2Puff);
    clouds2Ref.setSoftness(params.cloud2Softness);
    scene.add(clouds2Ref);

    header('Clouds (layer 2)');
    slider('cloud2Height',  'Height',   20, 600, 1,     fi,  () => clouds2Ref.position.y = params.cloud2Height);
    slider('cloud2Extent',  'Extent',   500, 8000, 10,  fi,  () => clouds2Ref.setExtent(params.cloud2Extent));
    slider('cloud2Cover',   'Coverage', 0, 0.9, 0.01,   f2,  () => clouds2Ref.setCoverage(params.cloud2Cover));
    slider('cloud2Puff',    'Puff size',0.3, 6, 0.01,   f2,  () => clouds2Ref.setPuff(params.cloud2Puff));
    slider('cloud2Softness','Softness', 0.05, 0.5, 0.01,f2,  () => clouds2Ref.setSoftness(params.cloud2Softness));
    slider('cloud2Opacity', 'Opacity',  0, 1, 0.01,     f2,  () => clouds2Ref.setOpacity(params.cloud2Opacity));
    slider('cloud2Speed',   'Drift speed',0, 4, 0.01,   f2,  () => clouds2Ref.setSpeed(params.cloud2Speed));
  }).catch(() => { /* clouds are optional */ });
```

- [ ] **Step 4: Verify in browser**

Open `environment-viewer.html`. Check:
- Both cloud layers visible, drifting independently.
- Clouds follow camera XZ (walk around — clouds move with you, no gap at map edges).
- Extent sliders resize each layer's quad.
- Layer 2 Puff/Softness/Speed sliders work independently of layer 1.

- [ ] **Step 5: Commit**

```
git add environment-viewer.html
git commit -m "feat: clouds camera-follow, extent slider, independent second cloud layer"
```

---

## Self-Review Checklist

- [x] **Grass radius + cull-start + density + max-blades sliders** → Task 3
- [x] **Authored map uses GPU compute grass** → Tasks 1, 2, 3
- [x] **Grass follows player (camera-centered cells)** → already inherent in grass-compute.js; `uCam` is set from `camera.position` in `update()`
- [x] **Cull gradient is density descent (not alpha fade)** → Task 2 Step 5 (`keepRand.greaterThan(edge)`)
- [x] **LOD 0 = full + shadow, LOD 1 = no shadow, LOD 2 = coarse leaves, LOD 3 = billboard** → Tasks 5, 4
- [x] **Each LOD distance has a slider** → Task 7
- [x] **Coarse leaf ratio + size mult sliders (temporary)** → Task 7
- [x] **Billboard baked once, cached in IndexedDB** → Task 6
- [x] **Cross-quad and 8-angle atlas both implemented** → Tasks 5, 6
- [x] **In-game toggle between billboard modes** → Task 6 Step 4
- [x] **Clouds camera-follow XZ** → Task 9 Step 1
- [x] **Layer 1 gets extent slider** → Task 9 Step 3
- [x] **Layer 2 fully independent with all sliders** → Task 9 Step 3
- [x] **WebGPU 8-binding limit respected in finalize** → Task 5 Step 6 (split A+B)
- [x] **`BufferGeometryUtils` imported in forest-gpu.js** → Task 5 Step 8
- [x] **`updateForestCull` / `setMaxDist` removed** → Task 7 Step 4
