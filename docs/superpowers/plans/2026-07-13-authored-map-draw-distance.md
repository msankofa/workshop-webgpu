# Authored-map draw distance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the authored-map "Draw distance (chunks)" slider into a real, Minecraft-style master draw distance: ground, water, trees, grass, plants, and rocks all soft-fade out and shader-discard past one configurable radius, while each existing per-system radius slider keeps working as an independent-but-capped maximum.

**Architecture:** One new small shared module, `terrain-draw-distance.js`, provides (a) two pure functions (`clampToMaster`, `fadeLive`) that are the Node-testable CPU twin of the fade math, and (b) a TSL builder (`buildDrawDistanceMask`) that any `NodeMaterial` can wire into its `maskNode` to get a per-fragment stochastic dithered discard. `environment-viewer.html` gets a new `terrain.drawDistance` param (authored maps only) that (1) drives the ground and water discard directly (they have no per-system slider today) and (2) ceiling-clamps the seven existing per-system radius params (`grassRadius`, `plantCullRadius`, `boulderCullRadius`, `screeCullRadius`, `deadfallCullRadius`, `mushroomCullRadius`, and a newly-added `treeMaxDrawRadius` slider) via `Math.min`. Trees additionally gain a soft fade band in `forest-gpu.js`'s existing hard-cutoff cull kernel, mirrored in `forest-cull.js`.

**Tech Stack:** Three.js r0.184 WebGPU renderer, TSL node materials, plain Node `.mjs` test scripts (no framework).

Spec: `docs/superpowers/specs/2026-07-12-authored-map-draw-distance-design.md`

---

## Task 1: `terrain-draw-distance.js` core module

**Files:**
- Create: `terrain-draw-distance.js`
- Test: `test-terrain-draw-distance.mjs`

This is the shared fade/clamp math, following the exact "pure JS twin, hand-synced with a TSL kernel, not imported by it" convention already used by `forest-cull.js`/`forest-gpu.js` and `dressing-cull.js`/`dressing-gpu.js`. Per that convention (see `dressing-cull.js`'s comment), the dither draw (`keepRand`) is passed into the pure function rather than recomputed there — only the TSL builder computes the actual hash, on the GPU.

- [ ] **Step 1: Write the failing test**

Create `test-terrain-draw-distance.mjs`:

```js
import { clampToMaster, fadeLive } from './terrain-draw-distance.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const near = (a, b, eps, m) => { if (Math.abs(a - b) <= eps) pass++; else { fail++; console.error('FAIL:', m, `(got ${a}, want ~${b})`); } };

// ---- clampToMaster(individual, master) ----
ok(clampToMaster(150, 900) === 150, 'individual below master passes through unchanged');
ok(clampToMaster(900, 300) === 300, 'individual above master is clamped down to master');
ok(clampToMaster(500, 500) === 500, 'individual equal to master is unchanged');

// ---- fadeLive({ dist, cullStart, cullRadius, keepRand }) ----
// Same shape/semantics as dressing-cull.js's radialLive: dist < cullRadius && keepRand > edge.
{
  const r = fadeLive({ dist: 10, cullStart: 70, cullRadius: 100, keepRand: 0.0 });
  ok(r.edge === 0, 'fully inside cullStart: edge is 0');
  ok(r.live === true, 'fully inside cullStart: always live regardless of keepRand');
}
{
  const r = fadeLive({ dist: 150, cullStart: 70, cullRadius: 100, keepRand: 0.999 });
  ok(r.live === false, 'beyond cullRadius: never live even with a winning keepRand');
}
{
  // dist=85 is the midpoint of [cullStart=70, cullRadius=100] -> edge=0.5.
  const atEdge = fadeLive({ dist: 85, cullStart: 70, cullRadius: 100, keepRand: 0.5 });
  near(atEdge.edge, 0.5, 1e-9, 'fade-band midpoint edge fraction is 0.5');
  ok(atEdge.live === false, 'keepRand equal to edge does not beat the dither (strict greaterThan)');
  const winsEdge = fadeLive({ dist: 85, cullStart: 70, cullRadius: 100, keepRand: 0.51 });
  ok(winsEdge.live === true, 'keepRand just above edge survives the dither');
}
{
  // Degenerate case: cullStart >= cullRadius (e.g. an individual slider dragged past the
  // ceiling before clampToMaster runs) must not divide by zero or invert.
  const r = fadeLive({ dist: 50, cullStart: 100, cullRadius: 100, keepRand: 0.0 });
  ok(Number.isFinite(r.edge), 'degenerate cullStart==cullRadius still returns a finite edge');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-terrain-draw-distance.mjs`
Expected: FAIL — `Cannot find module './terrain-draw-distance.js'`

- [ ] **Step 3: Write the pure-function half of the module**

Create `terrain-draw-distance.js`:

```js
// terrain-draw-distance.js — shared authored-map draw-distance fade/discard math.
//
// clampToMaster/fadeLive are the pure-JS twin of buildDrawDistanceMask's TSL kernel below —
// same hand-synced-but-not-imported convention as forest-cull.js/forest-gpu.js and
// dressing-cull.js/dressing-gpu.js. `keepRand` is passed in rather than recomputed here (the
// hash itself only exists on the GPU side, in buildDrawDistanceMask) — tests supply a fixed
// keepRand to exercise the fade band deterministically, same as dressing-cull.js.
//
// docs/superpowers/specs/2026-07-12-authored-map-draw-distance-design.md

export function clampToMaster(individual, master) {
  return Math.min(individual, master);
}

// { dist, cullStart, cullRadius, keepRand } -> { edge, live }
// edge: 0 at/before cullStart, 1 at/after cullRadius (linear ramp between).
// live: dist < cullRadius && keepRand > edge — identical shape to dressing-cull.js's radialLive.
export function fadeLive({ dist, cullStart, cullRadius, keepRand }) {
  const gradRange = Math.max(cullRadius - cullStart, 0.001);
  const edge = clamp01((dist - cullStart) / gradRange);
  const live = dist < cullRadius && keepRand > edge;
  return { edge, live };
}

function clamp01(v) { return Math.min(1, Math.max(0, v)); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-terrain-draw-distance.mjs`
Expected: `9 passed, 0 failed`

- [ ] **Step 5: Add the TSL builder to the same module**

Append to `terrain-draw-distance.js` (this half is not Node-testable — it imports `three/tsl` —
but stays in the same file as its pure twin so the two can't drift apart silently):

```js
// ---- TSL side: buildDrawDistanceMask({ worldPosNode, cullRadius, cullStart, salt }) ----
// Returns { uCullRadius, uCullStart, maskNode }. maskNode is a boolean TSL node meant to be
// assigned to a NodeMaterial's `material.maskNode` (three.webgpu.js's built-in "discard the
// fragment if maskNode is false" hook — the same mechanism alphaTest/alphaHash use internally,
// just driven by our own condition instead of alpha). uCullRadius/uCullStart are live uniforms:
// callers keep the returned handles and mutate `.value` on slider change; no material rebuild.
//
// worldPosNode defaults to TSL's `positionWorld` (per-fragment world position) — every caller
// today (ground, water) wants a per-fragment fade, not per-instance, since neither is GPU-
// instanced. Distance is measured against TSL's built-in `cameraPosition` (auto-updated every
// frame by the renderer) rather than a manually-synced uCam uniform like the instanced cull
// kernels use — ground/water have no existing per-frame update() hook to sync a uCam uniform
// from, and cameraPosition is exactly that, built in.
//
// Fade dither hash: same integer-hash shape as dressing-gpu.js's posRandFn (small standalone
// copy, same "not exported, not cross-imported" convention that file documents), keyed by
// world XZ so the discard pattern is stable across frames (no shimmer under camera motion) —
// only cullRadius/cullStart changing (slider drag) moves the visible edge. `salt` decorrelates
// the dither cell pattern between independent callers (e.g. ground vs. water) sharing the same
// radius, so their fade edges don't align into a visible seam.
import { Fn, If, uniform, int, uint, float, clamp, length, positionWorld, cameraPosition, bitcast, floor } from 'three/tsl';

const asU = (iNode) => bitcast(iNode, 'uint');
const posRandFn = Fn(([x, z, salt]) => {
  const ix = asU(int(floor(x.mul(8.0))));
  const iz = asU(int(floor(z.mul(8.0))));
  let h = ix.mul(uint(1597334677)).bitXor(iz.mul(uint(3812015801)));
  h = h.bitXor(h.shiftRight(uint(15))).mul(uint(2246822519));
  h = h.bitXor(asU(salt).mul(uint(2654435761)));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(3266489917));
  h = h.bitXor(h.shiftRight(uint(16)));
  return h.toFloat().div(4294967296.0);
});

export function buildDrawDistanceMask({ worldPosNode = positionWorld, cullRadius, cullStart, salt = 7 } = {}) {
  const uCullRadius = uniform(cullRadius);
  const uCullStart = uniform(cullStart ?? cullRadius * 0.7);
  const dx = worldPosNode.x.sub(cameraPosition.x);
  const dz = worldPosNode.z.sub(cameraPosition.z);
  const dist = length(dx, dz);
  const gradRange = uCullRadius.sub(uCullStart).max(float(0.001));
  const edge = clamp(dist.sub(uCullStart).div(gradRange), 0, 1);
  const keepRand = posRandFn(worldPosNode.x, worldPosNode.z, int(salt));
  const maskNode = dist.lessThan(uCullRadius).and(keepRand.greaterThan(edge));
  return { uCullRadius, uCullStart, maskNode };
}
```

- [ ] **Step 6: Run the test again (the TSL half must not break Node execution)**

Run: `node test-terrain-draw-distance.mjs`
Expected: `9 passed, 0 failed` — importing `three/tsl` at module load must not throw in Node
(the codebase's other TSL modules, e.g. `dressing-gpu.js`, are only ever imported from the
browser bundle, not from a `.mjs` test; confirm `three/tsl` resolves in plain Node here too — if
it does not, split the TSL half into `terrain-draw-distance-gpu.js` and re-run this test against
only `clampToMaster`/`fadeLive` from `terrain-draw-distance.js`).

- [ ] **Step 7: Commit**

```bash
git add terrain-draw-distance.js test-terrain-draw-distance.mjs
git commit -m "feat(terrain): add shared draw-distance fade/discard module"
```

---

## Task 2: Master `terrain.drawDistance` param + UI slider + far-plane/fog

**Files:**
- Modify: `environment-viewer.html:1199` (terrain param object)
- Modify: `environment-viewer.html:2092-2101` (`updateDrawDistance`)
- Modify: `environment-viewer.html:3288-3296` (draw-distance slider)

- [ ] **Step 1: Add the param**

At `environment-viewer.html:1199`:

```js
const terrain = { size: 300, baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2, waterLevel: -0.9, renderRadius: 2, renderMode: 'chunks', drawDistance: 900 };
```

- [ ] **Step 2: Branch `updateDrawDistance()` on `loadedMap`**

Replace `environment-viewer.html:2092-2101`:

```js
function updateDrawDistance() {
  // Farthest rendered chunk corner × (radius + 1) chunks out; ×2 covers the
  // diagonal across the whole loaded ring from the opposite side.
  const terrainFar = loadedMap
    ? Math.max(200, terrain.drawDistance)
    : Math.max(200, terrain.size, (terrainSystem.params.renderRadius + 1) * terrainSystem.params.chunkSize * 2);
  const far = Math.max(terrainFar, cloudFar1, cloudFar2);
  camera.far = far; camera.updateProjectionMatrix();
  worldFog.far = terrainFar; worldFog.near = terrainFar * 0.4;
  if (skyRef) skyRef.setRadius();   // re-size the sky by scaling the group (no rebuild/disposal)
}
```

(On authored maps this replaces the old `chunkSpan` approximation with the exact new visible
edge; procedural terrain's branch is untouched — same expression as before.)

- [ ] **Step 3: Branch the slider, and let `slider()` return its `<input>`**

At `environment-viewer.html:3113`, add a `return inp;` at the end of the `slider()` function body
(it currently has no return statement; every existing call site ignores the return value, so this
is additive and safe):

```js
  function slider(key, label, min, max, step, fmt, onChange, obj, objName) {
    const P = obj || params;
    const row = document.createElement('div'); row.className = 'row';
    const val = document.createElement('span'); val.textContent = fmt(P[key]);
    row.innerHTML = '<span style="color:#c4ccd6">' + label + '</span>'; row.appendChild(val);
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = P[key];
    const handler = onChange || apply;
    inp.addEventListener('input', () => { P[key] = parseFloat(inp.value); val.textContent = fmt(P[key]); handler(); });
    current.appendChild(row); current.appendChild(inp);
    controlRegistry.push({
      name: (objName || 'params') + '.' + key, obj: P, key, onChange: handler,
      sync: () => { inp.value = P[key]; val.textContent = fmt(P[key]); },
    });
    return inp;
  }
```

- [ ] **Step 4: Add the ceiling-clamp registry, declared once near the top of the same closure**

Just after the `const params = { ... };` object literal at `environment-viewer.html:2335` (end of
the object that starts at line 2322), add:

```js
  // Draw-distance master ceiling: every key here has its own slider elsewhere in this file whose
  // `max` must never exceed terrain.drawDistance, and whose live value gets pulled down if the
  // master shrinks below it. Populated with each slider's <input> as it's built (see the
  // `ceilingInputs.<key> = slider(...)` call sites below); read by applyDrawDistanceCeiling().
  const ceilingInputs = {};
  const CEILING_CLAMPED_KEYS = ['grassRadius', 'plantCullRadius', 'boulderCullRadius', 'screeCullRadius', 'deadfallCullRadius', 'mushroomCullRadius', 'treeMaxDrawRadius'];
  function applyDrawDistanceCeiling() {
    const master = terrain.drawDistance;
    for (const key of CEILING_CLAMPED_KEYS) {
      const inp = ceilingInputs[key];
      if (!inp) continue;
      inp.max = master;
      if (params[key] > master) {
        params[key] = master;
        const entry = controlRegistry.find(c => c.obj === params && c.key === key);
        entry?.sync?.();
        entry?.onChange?.();
      }
    }
  }
```

- [ ] **Step 5: Branch the "Draw distance" slider on `loadedMap`, and drive the ground/water masks**

Replace `environment-viewer.html:3288-3296`:

```js
  const drawFmt = r => { const n = 2 * Math.round(r) + 1; return Math.round(r) + ' · ' + n + '×' + n; };
  const drawDistanceChange = () => {
    terrainSystem.params.renderRadius = Math.round(terrain.renderRadius);
    if (waterRef) syncWaterChunks(true, { size: terrain.size });
    updateDrawDistance();
    if (cdlodRef) cdlodRef.setViewDistance(2 + Math.round(terrain.renderRadius));
  };
  if (loadedMap) {
    const metersChange = () => {
      terrainSystem.params.renderRadius = Math.ceil(terrain.drawDistance / (terrainSystem.params.chunkSize || 30));
      updateDrawDistance();
      applyDrawDistanceCeiling();
      loadedMap.setGroundDrawDistance?.(terrain.drawDistance);
      waterRef?.setDrawDistance?.(terrain.drawDistance);
    };
    slider('drawDistance', 'Draw distance (m)', 50, 1000, 10, v => Math.round(v) + 'm', metersChange, terrain, 'terrain');
  } else {
    slider('renderRadius', 'Draw distance (chunks)', 1, 12, 1, drawFmt, drawDistanceChange, terrain, 'terrain');
  }
```

`loadedMap.setGroundDrawDistance` and `waterRef.setDrawDistance` are added in Tasks 5 and 6;
until then this line is a harmless no-op via the `?.` guards. `applyDrawDistanceCeiling` is a
no-op until Tasks 3/4 populate `ceilingInputs`, for the same reason.

- [ ] **Step 6: Manually verify in the browser**

Run `python serve.py`, open an authored map, confirm the panel now shows "Draw distance (m)"
with a 50–1000 range instead of "Draw distance (chunks)". Dragging it should not yet visibly
change anything (ground/water/tree/grass/plant/rock wiring lands in later tasks) — this step
only confirms the slider renders, the param updates, and no console errors appear.

- [ ] **Step 7: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(terrain): add authored-map master draw-distance param and slider"
```

---

## Task 3: Ceiling clamp on grass/plants/rocks sliders

**Files:**
- Modify: `environment-viewer.html:3868` (grass)
- Modify: `environment-viewer.html:4054` (plants)
- Modify: `environment-viewer.html:4427-4430` (rocks/deadfall/mushroom)

For each of these six sliders, change the `max` argument from its current fixed number to
`terrain.drawDistance`, and capture the slider's returned `<input>` into `ceilingInputs`.

- [ ] **Step 1: Grass**

At `environment-viewer.html:3868`, replace:

```js
    slider('grassRadius', 'Radius', 8, 600, 1, fi, () => cg.setRadius(params.grassRadius));
```

with:

```js
    ceilingInputs.grassRadius = slider('grassRadius', 'Radius', 8, terrain.drawDistance, 1, fi, () => cg.setRadius(params.grassRadius));
```

- [ ] **Step 2: Plants**

At `environment-viewer.html:4054`, replace:

```js
    slider('plantCullRadius', 'Cull radius', 10, 300, 1, fi, () => plantsGPU.setCullRadius(params.plantCullRadius));
```

with:

```js
    ceilingInputs.plantCullRadius = slider('plantCullRadius', 'Cull radius', 10, terrain.drawDistance, 1, fi, () => plantsGPU.setCullRadius(params.plantCullRadius));
```

(Leave the `plantCullStart` slider on the next line untouched — it's the fade-start param, not
one of the seven ceiling-clamped maximums.)

- [ ] **Step 3: Rocks/deadfall/mushroom**

At `environment-viewer.html:4427-4430`, replace:

```js
    slider('boulderCullRadius', 'Boulder range', 20, 800, 5, fi, () => setCull('boulder', params.boulderCullRadius));
    slider('screeCullRadius', 'Scree range', 20, 400, 5, fi, () => setCull('scree', params.screeCullRadius));
    slider('deadfallCullRadius', 'Log/stump range', 20, 700, 5, fi, () => setCull('deadwood', params.deadfallCullRadius));
    slider('mushroomCullRadius', 'Mushroom range', 20, 400, 5, fi, () => setCull('mushroom', params.mushroomCullRadius));
```

with:

```js
    ceilingInputs.boulderCullRadius = slider('boulderCullRadius', 'Boulder range', 20, terrain.drawDistance, 5, fi, () => setCull('boulder', params.boulderCullRadius));
    ceilingInputs.screeCullRadius = slider('screeCullRadius', 'Scree range', 20, terrain.drawDistance, 5, fi, () => setCull('scree', params.screeCullRadius));
    ceilingInputs.deadfallCullRadius = slider('deadfallCullRadius', 'Log/stump range', 20, terrain.drawDistance, 5, fi, () => setCull('deadwood', params.deadfallCullRadius));
    ceilingInputs.mushroomCullRadius = slider('mushroomCullRadius', 'Mushroom range', 20, terrain.drawDistance, 5, fi, () => setCull('mushroom', params.mushroomCullRadius));
```

- [ ] **Step 4: Manually verify in the browser**

On an authored map, drag "Draw distance (m)" down to e.g. 200. Confirm: the Grass/Plants/
Dressing panel sliders' thumbs/max shrink to 200 and any of the six params that were above 200
snap down to 200 (label updates, and grass/plants/rocks visibly thin out at the new range).
Drag the master back up to 900 — the sliders' max grows back to 900 but the values that were
force-clamped stay wherever they were left (they do not auto-restore), matching the design.

- [ ] **Step 5: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(terrain): ceiling-clamp grass/plant/rock draw-distance sliders to the master"
```

---

## Task 4: Trees — soft fade band + ceiling clamp

**Files:**
- Modify: `forest-cull.js` (`classifyInstance`)
- Modify: `test-forest-cull.mjs`
- Modify: `forest-gpu.js`
- Modify: `environment-viewer.html` (params object, `createForestGPU` call, new slider)

Trees currently have a hard `maxDrawRadius` cutoff (`farLive = dist <= maxDrawRadius`), the one
system in the table that doesn't fade. This task gives it the same `cullStart`/dithered-edge
shape as `dressing-cull.js`'s `radialLive`, then wires it into the master ceiling like the other
six.

- [ ] **Step 1: Update the failing test first**

In `test-forest-cull.mjs`, replace the `baseParams` block and part (d) (lines ~22-30, ~68-81) —
the existing hard-cutoff assertions at dist=1000/800 must become fade-aware:

```js
const baseParams = {
  coneEnabled: true,
  coneMargin: 0.5,
  fovCos,
  rearMargin: 0.1,
  treeRadius: 4,
  scale: 1,
  maxDrawRadius: 900,
  maxDrawStart: 630, // 0.7 * maxDrawRadius, same ratio dressing-gpu.js documents as convention
  keepRand: 0.999,   // always "wins" the dither roll unless edge is also ~1
};
```

Replace part (d) with:

```js
// (d) beyond max draw radius rejected outright, even dead-ahead and well inside the cone.
{
  const rec = { x: 0, z: -1000 }; // straight ahead, past maxDrawRadius=900
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.farLive === false, 'd: beyond-max-radius instance rejected by far cutoff');
  ok(r.live === false, 'd: beyond-max-radius instance not live overall');
}
{
  const rec = { x: 0, z: -500 }; // well within maxDrawStart=630
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.farLive === true, 'd: within-fade-start instance passes far cutoff regardless of keepRand');
}
{
  // dist=765 is the midpoint of [maxDrawStart=630, maxDrawRadius=900] -> edge=0.5.
  const faded = classifyInstance({ x: 0, z: -765 }, cam, { ...baseParams, keepRand: 0.5 });
  ok(faded.farEdge === 0.5, 'd: fade-band midpoint edge fraction is 0.5');
  ok(faded.farLive === false, 'd: keepRand equal to edge does not beat the dither');
  const fadedWin = classifyInstance({ x: 0, z: -765 }, cam, { ...baseParams, keepRand: 0.51 });
  ok(fadedWin.farLive === true, 'd: keepRand just above edge survives the dither');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-forest-cull.mjs`
Expected: FAIL — `farEdge` is `undefined`, and the dist=-500/-765 assertions don't match the old
hard-cutoff `farLive` value (still computed without `keepRand`/`maxDrawStart`).

- [ ] **Step 3: Update `classifyInstance` in `forest-cull.js`**

Replace the `maxDrawRadius`/`farLive` lines (around `forest-cull.js:48-49`):

```js
  const maxDrawRadius = params.maxDrawRadius ?? Infinity;
  const maxDrawStart = params.maxDrawStart ?? maxDrawRadius * 0.7;
  const farGradRange = Math.max(maxDrawRadius - maxDrawStart, 0.001);
  const farEdge = clamp((dist - maxDrawStart) / farGradRange, 0, 1);
  const farLive = dist < maxDrawRadius && (params.keepRand ?? 1) > farEdge;
```

And update the return statement (`forest-cull.js:72`) to include `farEdge`:

```js
  return { dist, farLive, farEdge, coneLive, live: farLive && coneLive };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-forest-cull.mjs`
Expected: all tests pass (existing (a)/(b)/(c)/(e)/(f) cases are untouched by this change since
`(params.keepRand ?? 1) > farEdge` defaults to always-live when a test doesn't pass `keepRand`,
preserving every case that isn't specifically testing the fade band).

- [ ] **Step 5: Mirror the same change in `forest-gpu.js`'s TSL cull kernel**

Add a `posRandFn` (same standalone-copy convention as `dressing-gpu.js`'s) near the top of
`forest-gpu.js`, after the existing imports:

```js
import { bitcast, floor } from 'three/tsl'; // add to the existing three/tsl import list

const asU = (iNode) => bitcast(iNode, 'uint');
const posRandFn = Fn(([x, z, salt]) => {
  const ix = asU(int(floor(x.mul(8.0))));
  const iz = asU(int(floor(z.mul(8.0))));
  let h = ix.mul(uint(1597334677)).bitXor(iz.mul(uint(3812015801)));
  h = h.bitXor(h.shiftRight(uint(15))).mul(uint(2246822519));
  h = h.bitXor(asU(salt).mul(uint(2654435761)));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(3266489917));
  h = h.bitXor(h.shiftRight(uint(16)));
  return h.toFloat().div(4294967296.0);
});
```

Add a paired `uMaxDrawStart` uniform next to `uMaxDrawRadius` (`forest-gpu.js:98`):

```js
  const uMaxDrawRadius = uniform(opts.maxDrawRadius ?? (uLodR2.value * 1.5));
  const uMaxDrawStart = uniform(opts.maxDrawStart ?? (uMaxDrawRadius.value * 0.7));
```

Replace the hard cutoff at `forest-gpu.js:141`:

```js
      // ---- Milestone 3 + draw-distance fade: dithered far cutoff (before LOD/cone work) ----
      const farGradRange = uMaxDrawRadius.sub(uMaxDrawStart).max(float(0.001));
      const farEdge = clamp(dist.sub(uMaxDrawStart).div(farGradRange), 0, 1);
      const farKeepRand = posRandFn(rec0.x, rec0.z, int(13));
      const farLive = dist.lessThan(uMaxDrawRadius).and(farKeepRand.greaterThan(farEdge));
```

- [ ] **Step 6: Add a public setter and wire the perfAB slider to it**

Replace the `setMaxDrawRadius` method (`forest-gpu.js:658-660`) to also retune `uMaxDrawStart`
by the same 0.7 ratio, and update the perfAB slider registration (`forest-gpu.js:539-542`):

```js
    setMaxDrawRadius(r, start) {
      if (uMaxDrawRadius.value !== r) { uMaxDrawRadius.value = r; markDirty(); }
      const s = start ?? r * 0.7;
      if (uMaxDrawStart.value !== s) { uMaxDrawStart.value = s; markDirty(); }
    },
```

```js
  globalThis.window?.perfAB?.addSlider('Tree max draw radius', uMaxDrawRadius.value, uLodR2.value, uLodR2.value * 3, 5, (v) => {
    uMaxDrawRadius.value = v;
    uMaxDrawStart.value = v * 0.7;
    markDirty();
  });
```

- [ ] **Step 7: Wire `treeMaxDrawRadius` into the viewer's params + the master ceiling**

In `environment-viewer.html`, add to the forest `params` object literal (line 2332, same line as
`treeLodR0`):

```js
    treeLodR0: 258, treeLodR1: 400, treeLodR2: 583, treeMaxDrawRadius: 875,
```

Pass it into the `createForestGPU()` call (`environment-viewer.html:2364-2369`):

```js
    forestGPU = createForestGPU({
      renderer, camera, palette, heightAt: terrainHeight,
      treeBaseOffset: params.treeBaseOffset,
      lodR0: params.treeLodR0, lodR1: params.treeLodR1, lodR2: params.treeLodR2,
      maxDrawRadius: params.treeMaxDrawRadius,
      capPerVariant: 2048,
    });
```

Add a slider next to the existing LOD sliders (`environment-viewer.html:3233-3236`):

```js
    const updateLod = () => { if (forestGPU) forestGPU.setLodDistances(params.treeLodR0, params.treeLodR1, params.treeLodR2); };
    slider('treeLodR0', 'LOD 0 to 1', 10, 300, 1, fi, updateLod);
    slider('treeLodR1', 'LOD 1 to 2', 20, 400, 1, fi, updateLod);
    slider('treeLodR2', 'LOD 2 to billboard', 40, 600, 1, fi, updateLod);
    ceilingInputs.treeMaxDrawRadius = slider('treeMaxDrawRadius', 'Max draw radius', 40, terrain.drawDistance, 5, fi, () => forestGPU?.setMaxDrawRadius(params.treeMaxDrawRadius));
```

Note: `ceilingInputs` is declared in Task 2 Step 4, inside the same closure as this Trees panel
code, so it is already in scope here — no new import/declaration needed. This slider is
promoted from perfAB-only to the main Trees panel so the ceiling clamp has a real UI control to
clamp against on authored maps; the perfAB "Tree max draw radius" slider from Step 6 continues
to exist independently for perf A/B captures on procedural terrain.

- [ ] **Step 8: Manually verify in the browser**

On an authored map with trees near the current `treeMaxDrawRadius`, confirm distant trees now
visibly thin out over a band rather than popping at a hard edge, and that dragging the master
"Draw distance (m)" slider down clamps the new "Max draw radius" slider the same way it does
grass/plants/rocks.

- [ ] **Step 9: Commit**

```bash
git add forest-cull.js test-forest-cull.mjs forest-gpu.js environment-viewer.html
git commit -m "feat(vegetation): give tree far-cutoff a soft fade band, wire into draw-distance ceiling"
```

---

## Task 5: Ground mesh discard

**Files:**
- Modify: `terrain-loader.js:132-134` (signature), `:178-189` (fallback material), `:373-` (return object)
- Modify: `terrain-textures.js:555` (`makeSplatMaterial` signature), `:674` (before its `return mat`), `:690-696` (`fullMeta`), `:725-753` (`applyFlatTerrain`), `:770-773` and `:804-807` and `:870` (`applySplatTerrain`)
- Modify: `environment-viewer.html:1115`

Scope decision: `applyLegacyTerrain` (the `?terrainTexture=legacy` / splat-build-exception
fallback path) builds a plain `THREE.MeshStandardMaterial` per-triangle multi-material array, not
a `NodeMaterial` — it has no `maskNode` hook. Converting that whole per-triangle legacy system to
node materials is a separate, larger refactor outside this feature's scope; legacy-textured
authored maps simply keep rendering ground at full distance (documented in Task 7 and Task 8).
The three default-path materials (`applyFlatTerrain`, `makeSplatMaterial`'s two variants, and the
loader's own inline fallback) all already are, or become, `MeshStandardNodeMaterial` and get the
discard.

- [ ] **Step 1: Thread `drawDistance` from the viewer down to `loadTerrainMap`**

At `environment-viewer.html:1115`, replace:

```js
    loadedMap = await loadTerrainMap(mapKey, { scene, textureMode: TERRAIN_TEXTURE_MODE });
```

with:

```js
    loadedMap = await loadTerrainMap(mapKey, { scene, textureMode: TERRAIN_TEXTURE_MODE, drawDistance: terrain.drawDistance });
```

At `terrain-loader.js:132-134`, add `drawDistance` to the destructured options:

```js
export async function loadTerrainMap(mapKey, {
  scene, textureMode, maxShaderLayers, slopeCutoff, shaderQuality, prebuildVariants, drawDistance,
} = {}) {
```

- [ ] **Step 2: Convert `terrain-loader.js`'s own inline fallback material and collect its uniform handle**

Replace `terrain-loader.js:178-189`:

```js
  const groundDrawDistanceUniforms = [];
  if (!textureInfo) {
    const { MeshStandardNodeMaterial } = await import('three/webgpu');
    const { buildDrawDistanceMask } = await import('./terrain-draw-distance.js');
    terrainRoot.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.receiveShadow = true;
      obj.castShadow = false;
      const mat = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.0 });
      const { uCullRadius, uCullStart, maskNode } = buildDrawDistanceMask({ cullRadius: drawDistance ?? 900, salt: 101 });
      mat.maskNode = maskNode;
      groundDrawDistanceUniforms.push({ uCullRadius, uCullStart });
      obj.material = mat;
    });
  }
  if (textureInfo?.drawDistanceUniforms) groundDrawDistanceUniforms.push(...textureInfo.drawDistanceUniforms);
```

(`groundDrawDistanceUniforms` is declared here, at function scope, so both this block and the
return statement in Step 5 can see it.)

- [ ] **Step 3: Add `mat.maskNode` to `applyFlatTerrain` in `terrain-textures.js`**

Replace `terrain-textures.js:725-737`:

```js
async function applyFlatTerrain(root, meta) {
  let webgpu, drawDistanceMod;
  try {
    [webgpu, drawDistanceMod] = await Promise.all([import('three/webgpu'), import('./terrain-draw-distance.js')]);
  } catch (err) {
    console.warn('[terrain-textures] flat material unavailable, falling back:', err?.message || err);
    return null;
  }
  const { uCullRadius, uCullStart, maskNode } = drawDistanceMod.buildDrawDistanceMask({ cullRadius: meta.drawDistance ?? 900, salt: 101 });
  const material = new webgpu.MeshStandardNodeMaterial({
    color: new THREE.Color(FALLBACK_COLORS.grass),
    roughness: 0.95,
    metalness: 0.0,
  });
  material.maskNode = maskNode;
```

Replace the existing return statement `terrain-textures.js:753` (`return { material,
texturedMeshes, mode: 'flat', activeLayers: [] };`) with:

```js
  return { material, texturedMeshes, mode: 'flat', activeLayers: [], drawDistanceUniforms: [{ uCullRadius, uCullStart }] };
```

Thread `drawDistance` into `meta` so `applyFlatTerrain(root, fullMeta)` (called from
`applyTerrainTextures`) can see it: at `terrain-textures.js:690-696`, replace the `fullMeta`
object literal:

```js
  const fullMeta = {
    resolution,
    worldX,
    worldZ,
    seaLevel: Number(meta.seaLevel ?? mapData.seaLevel ?? 0),
    biomeNames: meta.biomeNames || mapData.biomeNames || [],
    drawDistance: Number(meta.drawDistance ?? mapData.drawDistance ?? 900),
  };
```

And thread `drawDistance` from `terrain-loader.js`'s call into that `meta` argument
(`terrain-loader.js:164-170`, the `applyTerrainTextures(terrainRoot, mapData, { resolution,
worldX, worldZ, seaLevel: ..., biomeNames }, { ... })` call) by adding `drawDistance,` to the
third-argument object literal there (the `meta`-shaped one, not the `options`-shaped fourth
argument).

- [ ] **Step 4: Add `mat.maskNode` to `makeSplatMaterial` in `terrain-textures.js`**

Change the `makeSplatMaterial` signature at `terrain-textures.js:555`:

```js
function makeSplatMaterial(arrays, activeLayers, tsl, webgpu, uniforms, shaderLayers = activeLayers, drawDistanceMod, meta) {
```

Right before `return mat;` at `terrain-textures.js:674`, add:

```js
  const { uCullRadius, uCullStart, maskNode } = drawDistanceMod.buildDrawDistanceMask({
    cullRadius: meta?.drawDistance ?? 900, salt: 101,
  });
  mat.maskNode = maskNode;
  mat.userData.drawDistanceUniforms = { uCullRadius, uCullStart };
```

(`buildDrawDistanceMask` defaults its `worldPosNode` to its own statically-imported
`positionWorld` from `three/tsl` — no need to pass `tsl`'s copy in; both resolve to the same
module.)

In `applySplatTerrain`, change the parallel import at `terrain-textures.js:771-773`:

```js
  const [webgpu, tsl, mossMod, drawDistanceMod] = await Promise.all([
    import('three/webgpu'), import('three/tsl'), import('./moss-tint.js'), import('./terrain-draw-distance.js'),
  ]);
```

Change the two `makeSplatMaterial` call sites at `terrain-textures.js:804-807`:

```js
  const reducedMaterial = makeSplatMaterial(arrays, activeLayers, tsl, webgpu, splatUniformOptions, reducedLayers, drawDistanceMod, meta);
  const fullMaterial = (usingReduced && prebuildVariants)
    ? makeSplatMaterial(arrays, activeLayers, tsl, webgpu, splatUniformOptions, activeLayers, drawDistanceMod, meta)
    : reducedMaterial;
```

Change the final return statement at `terrain-textures.js:870`:

```js
  const drawDistanceUniforms = fullMaterial !== reducedMaterial
    ? [reducedMaterial.userData.drawDistanceUniforms, fullMaterial.userData.drawDistanceUniforms]
    : [reducedMaterial.userData.drawDistanceUniforms];
  return { material, texturedMeshes, mode: 'splat', activeLayers: activeNames, drawDistanceUniforms };
```

(Both the reduced and full material variants need their own live uniforms kept in sync, because
the "Terrain shader" perfAB select can swap `mesh.material` between them at any time — see
`terrain-textures.js:856-864`.)

- [ ] **Step 5: Wire `loadedMap.setGroundDrawDistance`**

At `terrain-loader.js:373` (the `return { key: mapKey, root: terrainRoot, ... }` object), add a
new method:

```js
    setGroundDrawDistance(r) {
      for (const u of groundDrawDistanceUniforms) { u.uCullRadius.value = r; u.uCullStart.value = r * 0.7; }
    },
```

- [ ] **Step 6: Manually verify in the browser**

Load an authored map (default splat texture path), drag "Draw distance (m)" down to e.g. 150.
Confirm the ground visibly stochastically dissolves past ~105m (0.7×150) and fully discards past
150m, revealing the skybox/void, with no hard pop edge. Test with `?terrainTexture=flat` too
(exercises `applyFlatTerrain`'s path specifically).

- [ ] **Step 7: Commit**

```bash
git add terrain-loader.js terrain-textures.js environment-viewer.html
git commit -m "feat(terrain): shader-discard ground mesh past the master draw distance"
```

---

## Task 6: Water discard

**Files:**
- Modify: `water.js`
- Modify: `environment-viewer.html`

- [ ] **Step 1: Import the helper and build the mask in `createWaterSystem`**

In `water.js`, add to the top-level imports (near line 39):

```js
import { buildDrawDistanceMask } from './terrain-draw-distance.js';
```

After `surfaceMat.opacityNode = opacityNode;` (`water.js:731`), add:

```js
  const { uCullRadius: uDrawCullRadius, uCullStart: uDrawCullStart, maskNode: drawDistanceMask } =
    buildDrawDistanceMask({ cullRadius: o.drawDistance ?? o.size, salt: 102 });
  surfaceMat.maskNode = drawDistanceMask;
```

Add `drawDistance: undefined` to `DEFAULTS` (`water.js:45-87`, alongside `extentX`/`extentZ`) so
`merge()` accepts the option without a stray `undefined` key warning; the `?? o.size` fallback
above keeps existing callers (that never pass `drawDistance`) behaving exactly as before (surface
never discards, matching current no-cutoff behavior).

- [ ] **Step 2: Expose a public setter**

Replace the final return statement, `water.js:1354-1362`:

```js
  return {
    surface, version: WATER_VERSION, update, resize, regenerate, setWaves, setCaustic,
    setReflectionTuning, setReflectRate, setLightDir, setLodDistances, getChunkCount, getStats,
    dispose,
    // perf (2026-07-08 Wave 0): pass-through setters, see the block above setLightDir.
    setReflectionEnabled, setCausticsEnabled, setCausticRate, setCausticRes, setQuality,
    // perf (2026-07-09, water-performance-design.md §3): master gate toggle, see its definition.
    setVisibilityGatesEnabled,
    setDrawDistance(r) {
      uDrawCullRadius.value = r;
      uDrawCullStart.value = r * 0.7;
    },
  };
}
```

- [ ] **Step 3: Pass the initial value and confirm the master wiring from Task 2 now does something**

In `environment-viewer.html`, at the `createWaterSystem({...})` call (`environment-viewer.html:4466-4468`),
add `drawDistance: terrain.drawDistance,` to the options object (only meaningful on authored
maps; procedural terrain's `terrain.drawDistance` still exists as a param but nothing reads it on
that path, so this is harmless there too — water on procedural terrain keeps its current
never-discards behavior since `updateDrawDistance`'s procedural branch never calls
`waterRef.setDrawDistance`).

- [ ] **Step 4: Manually verify in the browser**

On an authored map with a visible lake, drag "Draw distance (m)" down below the lake's distance
from spawn. Confirm the water surface stochastically dissolves and fully discards past the
radius, matching the ground's fade band, instead of staying visible out to the map edge.

- [ ] **Step 5: Commit**

```bash
git add water.js environment-viewer.html
git commit -m "feat(water): shader-discard water surface past the master draw distance"
```

---

## Task 7: Full manual verification pass

No files change in this task — it's a checklist run in the browser (`python serve.py`, open an
authored map) before moving to docs, since Tasks 2-6 individually verified their own piece in
isolation.

- [ ] **Step 1:** Set "Draw distance (m)" to 1000 (near-max). Confirm the scene looks unchanged
  from before this feature existed (ground/water/trees/grass/plants/rocks all still visible out
  to their old defaults, nothing newly clipped).
- [ ] **Step 2:** Drag it down to 300. Confirm ground, water, trees, grass, plants, and rocks all
  now fade out at roughly the same ~300m ring, all via a soft dithered band (no hard pops), and
  that each per-system slider's thumb/max has visibly shrunk to 300.
- [ ] **Step 3:** Drag one per-system slider (e.g. "Boulder range") below 300 independently.
  Confirm it can go lower than the master and rocks fade closer than everything else.
  Drag it back up — confirm its max stops at 300 (can't exceed the master).
- [ ] **Step 4:** Switch to a procedural (non-authored) scene. Confirm the panel still shows the
  old "Draw distance (chunks)" slider (not meters), and that ground/water/vegetation behave
  exactly as they did before this feature (this system is authored-map-only, per the spec's
  explicit scope).
- [ ] **Step 5:** Reload with `?terrainTexture=legacy`. Confirm ground does NOT fade (documented,
  out-of-scope exception from Task 5) but everything else (water/trees/grass/plants/rocks) still
  does.
- [ ] **Step 6:** Check the browser console for errors/warnings across all of the above.

---

## Task 8: Docs + agent log

**Files:**
- Modify: `docs/subsystems/terrain.md`
- Modify: `docs/subsystems/vegetation.md`
- Modify: `docs/subsystems/rocks.md`
- Modify: `docs/subsystems/water.md`
- Modify: `agent_log.csv`

- [ ] **Step 1: `docs/subsystems/terrain.md`**

Add a section documenting: `terrain.drawDistance` (authored maps only, 50-1000m, default 900m,
replaces the old chunk-based slider's UI slot on authored maps), that it drives
`terrainSystem.params.renderRadius` via `Math.ceil(drawDistance / chunkSize)` for the existing
chunk-window consumers, that it sets the camera far plane/fog directly (no more chunk-span
approximation) on authored maps, and that ground materials (except the legacy per-triangle path)
now shader-discard past it with a 0.7×radius soft fade start. Reference
`terrain-draw-distance.js` as the shared fade/discard module and note the legacy-path exception
from Task 5.

- [ ] **Step 2: `docs/subsystems/vegetation.md`**

Document: `grassRadius`/`plantCullRadius` are now ceiling-clamped to `terrain.drawDistance` on
authored maps (their UI `max` live-shrinks with the master); trees' `maxDrawRadius` gained a soft
dithered fade band (`maxDrawStart`, default 0.7×radius) replacing the old hard cutoff, is now
also exposed as a main "Trees" panel slider (`treeMaxDrawRadius`, previously perfAB-only) and is
likewise ceiling-clamped. Update the Milestone-3 "hard far cutoff" language wherever it currently
describes trees as a hard pop.

- [ ] **Step 3: `docs/subsystems/rocks.md`**

Document that `boulderCullRadius`/`screeCullRadius`/`deadfallCullRadius`/`mushroomCullRadius` are
now ceiling-clamped to `terrain.drawDistance` on authored maps, same mechanism as grass/plants.

- [ ] **Step 4: `docs/subsystems/water.md`**

Document the new `setDrawDistance(r)` / `drawDistance` option: water's surface material now
shader-discards past `terrain.drawDistance` on authored maps (no independent slider — it follows
the master 1:1), via the shared `terrain-draw-distance.js` helper. Note the caustic mesh is
intentionally NOT given the same mask (it renders to an offscreen top-down RT sampled by the
terrain's emissive node, not directly to camera — discarding it there wouldn't affect what the
player sees at the visible cutoff and would only add complexity for no visible benefit). Note the
ring-extent CPU-side clamp (`water.js:388-394`'s existing `extentX`/`extentZ` clamp) is NOT
touched by this change — it remains a possible follow-up perf optimization (build less ring
geometry that the shader would discard anyway), out of scope here.

- [ ] **Step 5: `agent_log.csv`**

Append one row (append-only — do not edit or reorder existing rows):

```
2026-07-13T00:00,multi,"terrain-draw-distance.js;test-terrain-draw-distance.mjs;environment-viewer.html;forest-cull.js;test-forest-cull.mjs;forest-gpu.js;terrain-loader.js;terrain-textures.js;water.js",Added a master authored-map draw-distance slider that shader-discards ground/water and ceiling-clamps grass/plant/rock/tree draw radii, replacing the old chunk-only slider that didn't affect rendering.
```

(Use the actual date the work is committed, in `YYYY-MM-DDTHH:MM` form, not the placeholder
above.)

- [ ] **Step 6: Commit**

```bash
git add docs/subsystems/terrain.md docs/subsystems/vegetation.md docs/subsystems/rocks.md docs/subsystems/water.md agent_log.csv
git commit -m "docs: document authored-map master draw distance"
```
