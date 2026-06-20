# SP1 — WebGPU Renderer Migration Foundation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `THREE.WebGLRenderer` with `WebGPURenderer` and port the three custom-shader modules (grass, clouds, water) to TSL node materials, so the scene renders **identically** on WebGPU — no new features.

**Architecture:** A *strangler* migration. First stand up `WebGPURenderer` (async init, async render loop) rendering only the standard-material parts of the scene (terrain chunks, trees, lights — these need no porting). Then port the custom shaders one module at a time (grass → clouds → water), each gated on side-by-side visual parity with the WebGL build. The render-mode is selected by a URL flag so the WebGL path stays runnable for comparison until parity is proven.

**Tech Stack:** Three.js WebGPU build (`three/webgpu` + `three/tsl`) via CDN importmap; WGSL under the hood, authored through TSL nodes; `perfStats` HUD (already built) for the perf gate; Node only for syntax/logic checks.

---

## Testing approach for a GPU migration (read first)

GPU rendering **cannot be unit-tested in Node** — there is no WebGPU device, and visual parity is the actual requirement. So this plan's verification is deliberately not classic Node TDD. Each task is gated by one or more of:

- **Node syntax check** (`node --check`, or extracting the inline `<script type="module">` and checking it) — catches typos before a browser round-trip.
- **Node logic test** — only where pure, renderer-independent math can be extracted (e.g. a wind/fade helper); these follow normal TDD.
- **Browser visual-parity checkpoint** — explicit, observable pass/fail criteria, compared against the still-runnable WebGL build (`?renderer=webgl`).
- **`perfStats` trace** — the SP1 spec gate (CPU frame time ≤ WebGL baseline at draw distance 9).

Where a step's verification is a browser checkpoint, that is stated explicitly with criteria. **TSL node code in this plan is written against the node API of the pinned Three.js version chosen in Task 1**; TSL evolves between releases, so the exact node-function names must be confirmed against that version's `three/tsl` exports at implementation time (the GLSL source being ported is the source of truth for behavior).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `environment-viewer.html` | App shell: importmap, renderer creation, render loop, module wiring | **Modify** — importmap → webgpu build; renderer → `WebGPURenderer`; async init + `renderAsync`; `?renderer=` flag |
| `grass.js` | Grass field mesh + material | **Modify** — `ShaderMaterial` (GLSL) → `MeshStandardNodeMaterial` (TSL); keep `createGrass`/`setWind`/`setFade`/`regenerate` API unchanged |
| `clouds.js` | Overhead cloud quad | **Modify** — custom shader → TSL node material; keep public API |
| `water.js` | Reflection + refraction + caustics water | **Modify** — the long pole; reflection/refraction render targets + caustic ground patch → node equivalents |
| `terrain-system.js` | Chunk terrain (standard material in production) | **No change for SP1** — chunk-mode uses `MeshStandardMaterial`, which runs on WebGPURenderer unchanged. The gated instanced `onBeforeCompile` path is out of scope (SP3) |
| `trees.js`, `lights.js` | Trees (vertexColors std material), lights | **No change** — standard materials/lights run unchanged |
| `webgpu-spike.html` | Throwaway spike harness | **Create** (Task 2), delete after |

Modules **not** touched: `terrain-field.js`, `terrain-worker.js`, `tree-textures.js`, and all `test-terrain-*.mjs` (their Node tests must stay green — they don't import a renderer).

---

## Task 1: Pin the WebGPU build and add a renderer flag

**Files:**
- Modify: `environment-viewer.html` (importmap lines 16–21; renderer creation ~line 42)

- [ ] **Step 1: Choose and record the Three.js version**

Use the **latest stable** Three.js release that ships a mature `three/webgpu` + `three/tsl` (any recent r0.17x+ in 2026). Confirm the two ESM entry points exist at the CDN, e.g.:
`https://cdn.jsdelivr.net/npm/three@<VERSION>/build/three.webgpu.js`
`https://cdn.jsdelivr.net/npm/three@<VERSION>/build/three.tsl.js`
Record `<VERSION>` in a comment; every subsequent CDN URL uses it.

- [ ] **Step 2: Update the importmap to the WebGPU build**

Replace the importmap (`environment-viewer.html` lines 16–21):

```html
<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@<VERSION>/build/three.webgpu.js",
    "three/webgpu": "https://cdn.jsdelivr.net/npm/three@<VERSION>/build/three.webgpu.js",
    "three/tsl": "https://cdn.jsdelivr.net/npm/three@<VERSION>/build/three.tsl.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@<VERSION>/examples/jsm/"
} }
</script>
```

Note: `three.webgpu.js` re-exports the full core under `import * as THREE from 'three'`, so existing `THREE.*` usage keeps resolving; it additionally exposes `WebGPURenderer` and the node materials.

- [ ] **Step 3: Add a `?renderer=` flag (keep WebGL path runnable)**

Immediately after the existing imports in the module script, add:

```js
const RENDERER_BACKEND = new URLSearchParams(location.search).get('renderer') || 'webgpu';
```

This lets you open `?renderer=webgl` for the legacy path and `?renderer=webgpu` (default) for the new one during the migration. (The WebGL branch is removed in Task 8.)

- [ ] **Step 4: Syntax check**

Run:
```bash
node -e "const fs=require('fs');const h=fs.readFileSync('environment-viewer.html','utf8');const m=h.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('.__c.mjs',m[1]);" && node --check .__c.mjs && echo OK && rm -f .__c.mjs
```
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add environment-viewer.html
git commit -m "build(webgpu): point importmap at three/webgpu + three/tsl, add ?renderer flag"
```

---

## Task 2: WebGPU spike — confirm the device initializes on target hardware

**Files:**
- Create: `webgpu-spike.html` (throwaway)

- [ ] **Step 1: Write the spike**

Create `webgpu-spike.html` — a bare page that inits `WebGPURenderer`, draws one lit rotating box, and prints adapter/device setup time:

```html
<!doctype html><meta charset="utf-8"><body style="margin:0">
<pre id="log" style="position:fixed;top:8px;left:8px;color:#0f0;font:12px monospace"></pre>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@<VERSION>/build/three.webgpu.js",
  "three/webgpu": "https://cdn.jsdelivr.net/npm/three@<VERSION>/build/three.webgpu.js"
} }
</script>
<script type="module">
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
const log = (m) => document.getElementById('log').textContent += m + '\n';
if (!navigator.gpu) { log('NO navigator.gpu — WebGPU unavailable'); throw new Error('no webgpu'); }
const t0 = performance.now();
const renderer = new WebGPURenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init();
log('renderer.init() took ' + (performance.now() - t0).toFixed(0) + ' ms');
log('backend: ' + (renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback'));
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(50, innerWidth/innerHeight, 0.1, 100); cam.position.z = 4;
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const d = new THREE.DirectionalLight(0xffffff, 1); d.position.set(2,3,4); scene.add(d);
const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x4488ff }));
scene.add(box);
renderer.setAnimationLoop(() => { box.rotation.y += 0.01; renderer.render(scene, cam); });
</script>
```

- [ ] **Step 2: Browser checkpoint**

Serve and open `webgpu-spike.html`. **Pass criteria:**
- A blue box renders and rotates (no errors in console).
- The log shows `backend: WebGPU` (if it shows `WebGL2 fallback`, note it — the migration still works, but the SP2/SP3 compute features will need the WebGPU backend; investigate browser/flags).
- Record the `renderer.init()` time (expect a few hundred ms; this is the one-time setup the literature flags).

- [ ] **Step 3: Commit the spike result**

```bash
git add webgpu-spike.html
git commit -m "spike(webgpu): bare WebGPURenderer renders + reports backend/setup time"
```

> **Gate:** the spike must show `backend: WebGPU` (or a clearly-understood reason for fallback) before continuing. If WebGPU is unavailable on the target browser/hardware, stop and resolve that first.

---

## Task 3: Swap the renderer; render the standard-material scene only

Bring up `WebGPURenderer` in the real app with grass/clouds/water **temporarily disabled**, so terrain chunks + trees + lights + camera + FPS-walk are validated in isolation before porting any shader.

**Files:**
- Modify: `environment-viewer.html` (renderer creation ~line 42; render loop ~line 1323; temporarily guard the grass/clouds/water dynamic imports)

- [ ] **Step 1: Replace renderer creation with async WebGPURenderer**

Replace lines 42–47 (`const renderer = new THREE.WebGLRenderer(...)` … `document.body.appendChild(renderer.domElement);`) with:

```js
import { WebGPURenderer } from 'three/webgpu';
const renderer = new WebGPURenderer({ antialias: true, forceWebGL: RENDERER_BACKEND === 'webgl' });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
await renderer.init();   // module scripts are async-capable; top-level await is fine
```

(`WebGPURenderer` supports `shadowMap`, `setSize`, `setPixelRatio`, `.domElement`, `.info` — the surface this file uses. `forceWebGL` gives the `?renderer=webgl` comparison path.)

- [ ] **Step 2: Make the render loop async-safe**

`WebGPURenderer.render()` returns a promise; the simplest robust change is to use the renderer's own loop and `renderAsync`. Replace the `requestAnimationFrame(animate)` call at the top of `animate()` and the final `renderer.render(scene, camera);` (line ~1323):

- Remove the manual `requestAnimationFrame(animate);` line inside `animate()`.
- Change the final draw to: `await renderer.renderAsync(scene, camera);`
- Replace the bottom `animate();` invocation with: `renderer.setAnimationLoop(animate);` and make `animate` `async function animate() { … }`.

This keeps one in-flight frame and avoids overlapping async renders.

- [ ] **Step 3: Temporarily disable the custom-shader modules**

Wrap the three dynamic imports so they no-op for now (they're ported in Tasks 4–6). Find each `import('./grass.js…')`, `import('./clouds.js')`, `import('./water.js…')` block and gate it:

```js
const PORTED = { grass: false, clouds: false, water: false }; // flip true as each is ported
if (PORTED.grass) { import('./grass.js?v=...') /* ...existing .then chain... */ }
```

(Do the same for clouds and water. Leave terrain, trees, lights, octree untouched.)

- [ ] **Step 4: Syntax check**

Run the extract-and-`--check` command from Task 1 Step 4. Expected: `OK`.

- [ ] **Step 5: Browser checkpoint — base scene parity**

Open `environment-viewer.html` (default `?renderer=webgpu`). **Pass criteria:**
- Terrain chunks render with correct shading and shadows; trees render with their vertex colors; the sun lights the scene.
- Orbit drag, scroll zoom, and **F walk mode** (Octree/Capsule collision) all work.
- The `perfStats` HUD updates (calls/triangles/fps). Open `?renderer=webgl` in another tab and confirm the base scene looks the same (minus grass/clouds/water, which are off in both if you also gate them, or just compare terrain/trees).

- [ ] **Step 6: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(webgpu): render standard-material scene on WebGPURenderer (grass/clouds/water gated off)"
```

---

## Task 4: Port grass `ShaderMaterial` → TSL node material

Grass is the cleanest custom shader (self-contained vertex wind/fade + fragment color/cloud, declared in `grass.js`). Port it to a `MeshStandardNodeMaterial` so lighting/shadows are inherited and the look matches.

**Files:**
- Modify: `grass.js` (the `VERT_SHADER`/`FRAG_SHADER` strings + `buildMaterial` + the `set*` uniform methods)
- Test: `test-grass-wind.mjs` (Create — pure-logic parity for the wind/fade math)

- [ ] **Step 1: Extract the wind/fade math and Node-test it**

The wind phase and distance-fade are pure functions of `(worldX, uTime, uWindSpeed, uWaveSize, uInvExtent)` and `(camDist, uFadeStart, uFadeEnd, aHeight)`. Extract them into a tiny exported helper in `grass.js` (e.g. `grassWindOffset(...)`, `grassFadeKeep(...)`) used by *both* the future TSL graph (as the reference) and a Node test. Create `test-grass-wind.mjs`:

```js
import { grassWindOffset, grassFadeKeep } from './grass.js';
let fail = 0; const ok = (c,m)=>{ console.log((c?'ok  ':'FAIL ')+m); if(!c) fail++; };
// wind is continuous in world X (no per-chunk reset)
const w = (x)=>grassWindOffset(x, 1.0, 2.0, 10.0, 1/30);
ok(Math.abs(w(30.0) - w(30.0)) === 0, 'wind deterministic');
ok(Math.abs(w(29.99) - w(30.01)) < 0.05, 'wind continuous across a chunk boundary');
// fade collapses with distance
ok(grassFadeKeep(0, 50, 100) === 1, 'near keeps full height');
ok(grassFadeKeep(100, 50, 100) === 0, 'far collapses to base');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test-grass-wind.mjs`
Expected: FAIL — `grassWindOffset`/`grassFadeKeep` not exported yet.

- [ ] **Step 3: Implement the helpers (mirror the existing GLSL)**

In `grass.js`, export the two helpers replicating the current `VERT_SHADER` math exactly: `wave = sin(uTime*uWindSpeed + worldX*uWaveSize*uInvExtent)` and the fade `keep = 1 - clamp((camDist-start)/(end-start),0,1)`. These become the behavioral spec the TSL graph must match.

- [ ] **Step 4: Run it to verify it passes**

Run: `node test-grass-wind.mjs`
Expected: PASS (all 4).

- [ ] **Step 5: Replace `buildMaterial` with a TSL node material**

Rewrite `buildMaterial` to return a `MeshStandardNodeMaterial` (imported from `three/webgpu`) with TSL node graphs built from `three/tsl` functions, reproducing the existing shader:
- `positionNode` / `material.positionNode`: displace `positionLocal` — apply the world-space wind offset to `x` (from the same expression as `grassWindOffset`) and the distance-fade collapse of height (using `cameraPosition`, `aHeight` attribute, and `uFadeStart/uFadeEnd` uniforms).
- `colorNode`: base→tip gradient by `aWind`, times the flat ambient/key term and the scrolling cloud-shadow value-noise (world-XZ based), matching `FRAG_SHADER`.
- Re-expose `setWind(strength)`, `setFade(start,end)`, `setAmbient`, `setKey`, `update(seconds)` by writing to TSL `uniform(...)` handles instead of `material.uniforms.*`.
Keep `createGrass`, `regenerate`, `dispose`, the per-vertex attributes (`aWind`, `aHeight`), and the geometry builder unchanged. *(Exact TSL function names per the Task-1 version's `three/tsl`; the GLSL in `grass.js` + the Step-3 helpers are the behavioral source of truth.)*

- [ ] **Step 6: Re-enable grass and verify**

In `environment-viewer.html` set `PORTED.grass = true`. Run the Task-1 syntax check (`OK`), then **browser checkpoint**: grass renders with the same color gradient, **wind sways continuously across chunk borders** (the seam fix must survive the port), the **distance fade** still thins grass smoothly with the "Distance cull" slider, and grass sits off the lakebeds. Compare against `?renderer=webgl`.

- [ ] **Step 7: Commit**

```bash
git add grass.js test-grass-wind.mjs environment-viewer.html
git commit -m "feat(webgpu): port grass to a TSL node material (wind/fade/cloud parity)"
```

---

## Task 5: Port clouds → TSL node material

**Files:**
- Modify: `clouds.js` (its custom shader material + public setters)
- Modify: `environment-viewer.html` (`PORTED.clouds = true`)

- [ ] **Step 1: Identify the shader surface**

Read `clouds.js`: it lays a large overhead quad with a noise-driven coverage/opacity shader and setters (`setCoverage`, `setOpacity`, `setSpeed`, `setPuff`, `setSoftness`, `setFade`, `update`). The fragment shader is the behavioral spec.

- [ ] **Step 2: Port to a node material**

Replace the cloud `ShaderMaterial` with a node material (a `MeshBasicNodeMaterial`/`NodeMaterial` with `transparent: true`), reproducing the coverage/opacity/softness/drift noise in a TSL `colorNode`/`opacityNode`. Re-expose every setter by writing to `uniform(...)` handles. Keep the `Clouds` class shape and `update(seconds)` unchanged. *(Exact TSL per the pinned version; the existing GLSL is the source of truth.)*

- [ ] **Step 3: Syntax check + browser checkpoint**

Run the Task-1 syntax check (`OK`). Set `PORTED.clouds = true`. **Browser pass criteria:** clouds drift overhead with the same coverage/opacity/softness; the Clouds panel sliders still change them live; horizon fade looks the same as `?renderer=webgl`.

- [ ] **Step 4: Commit**

```bash
git add clouds.js environment-viewer.html
git commit -m "feat(webgpu): port clouds to a TSL node material"
```

---

## Task 6: Port water (reflection + refraction + caustics) — the long pole

Water is the hardest port: a planar reflection camera, a refraction render target, caustics, and a **ground-material patch** (the `onBeforeCompile` caustic projection that does not exist in TSL). Split into three checkpoints.

**Files:**
- Modify: `water.js` (reflection/refraction targets, surface material, the ground caustic patch)
- Modify: `environment-viewer.html` (`PORTED.water = true`)

- [ ] **Step 1: Port the water *surface* material (no reflection yet)**

Replace the water surface `ShaderMaterial` with a node material reproducing the wave normal perturbation, color, and transparency from the existing GLSL. Temporarily feed it a flat reflection/refraction color so the surface renders. **Browser checkpoint:** the lake surface appears at the right level with wave motion and the right tint (reflection will be flat/placeholder). Commit:
```bash
git add water.js environment-viewer.html
git commit -m "feat(webgpu): port water surface material to TSL (flat reflection placeholder)"
```

- [ ] **Step 2: Restore reflection + refraction**

Re-implement the planar reflection (mirror camera + reflection render target) and the refraction target on `WebGPURenderer`. Prefer Three.js's node-based reflection if the pinned version provides it (e.g. a `reflector(...)` node / `three/addons` WebGPU `Reflector`); otherwise render the reflection pass manually with `renderer.renderAsync` to a `RenderTarget` and sample it in the surface `colorNode`. Keep `setReflectRate(n)` (reflect every N frames). **Browser checkpoint:** reflections and refraction look equivalent to `?renderer=webgl`; `Reflect every N frames` still works. Commit:
```bash
git add water.js
git commit -m "feat(webgpu): restore water planar reflection + refraction on WebGPU"
```

- [ ] **Step 3: Restore caustics (the `onBeforeCompile` replacement)**

The caustic projection currently patches the **ground** material via `onBeforeCompile` (reverse-projecting bed positions and sampling the caustic texture; see `water.js` ground block) — invalid in TSL. Re-express it as a TSL graph contribution on the terrain material: add the caustic sample to the terrain's `colorNode`/`outputNode` for fragments below `waterLevel`, using the caustic render target, refracted-light direction, and world position. Because terrain in production is a shared `MeshStandardMaterial`, convert it to a `MeshStandardNodeMaterial` and attach the caustic node (this is the SP1 equivalent of the `materialPatchTarget` contract). Keep `setCaustic`, `setWaves`. **Browser checkpoint:** caustics ripple on the lakebed/shore exactly as in `?renderer=webgl`. Commit:
```bash
git add water.js terrain-system.js
git commit -m "feat(webgpu): restore caustics via terrain node material (replaces onBeforeCompile)"
```

---

## Task 7: Full-scene parity pass + the SP1 perf gate

**Files:**
- Modify: `environment-viewer.html` (`PORTED` all true; HUD already shows backend if added)

- [ ] **Step 1: Enable everything**

Set `PORTED.grass = PORTED.clouds = PORTED.water = true`. Add the backend to the HUD: in `updateTerrainDebug`, append `\nbackend ${renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2'}`.

- [ ] **Step 2: Confirm Node test suite still green (no renderer coupling)**

Run:
```bash
for t in test-terrain-field test-terrain-system test-terrain-instanced test-terrain-heightmap-parity test-terrain-tile-seam test-terrain-worker-heighttile test-grass-wind; do printf "%-34s " "$t"; node "$t.mjs" >/dev/null 2>&1 && echo PASS || echo FAIL; done
```
Expected: all PASS (these don't touch the renderer; the migration must not have broken them).

- [ ] **Step 3: Browser full-scene parity checkpoint**

Open `?renderer=webgpu` and `?renderer=webgl` side by side. **Pass criteria — equivalent in both:** terrain shading/shadows, lakes, **water reflection/refraction/caustics**, grass (wind continuity + distance fade + off-water), trees, clouds, fog toggle, FPS-walk collision. No console errors; HUD shows `backend webgpu`.

- [ ] **Step 4: The SP1 perf gate — `perfStats` at draw distance 9**

In `?renderer=webgpu`: set Draw distance 9, `perfStats.clear(); perfStats.intervalMs = 250;`, pan ~20s, save the CSV to `research/stats/`. Repeat in `?renderer=webgl`. **Gate:** WebGPU **CPU frame time ≤ WebGL** at dd9 (the SP1 spec's success criterion — the migration must not regress CPU-bound submission; a clear improvement is expected per the literature). Record both traces.

- [ ] **Step 5: Commit**

```bash
git add environment-viewer.html research/stats/
git commit -m "feat(webgpu): full-scene parity on WebGPURenderer + dd9 perf gate traces"
```

> **SP1 acceptance:** Steps 2–4 all pass. If the dd9 CPU-frame-time gate is *not* met, do not proceed to SP2 — investigate (most likely a per-frame buffer upload stall per the GEM'24 caveat, or an unported material silently falling back).

---

## Task 8: Remove the WebGL path and document

**Files:**
- Modify: `environment-viewer.html` (drop the `?renderer=webgl` branch + `forceWebGL`)
- Create: `research/webgpu/sp1-migration-notes.md`

- [ ] **Step 1: Remove the legacy branch**

Once SP1 is accepted, delete the `RENDERER_BACKEND`/`forceWebGL` comparison plumbing and the `PORTED` gates (everything is ported). Delete `webgpu-spike.html`.

- [ ] **Step 2: Write migration notes**

Create `research/webgpu/sp1-migration-notes.md` recording: the pinned Three.js version, the `init()` setup time measured, which TSL node functions replaced which GLSL, the water reflection approach chosen, and the dd9 with/without CPU-frame-time numbers. This seeds SP2/SP3.

- [ ] **Step 3: Final syntax check + commit**

Run the Task-1 syntax check (`OK`).
```bash
git add environment-viewer.html research/webgpu/sp1-migration-notes.md
git rm webgpu-spike.html
git commit -m "chore(webgpu): remove legacy WebGL path; document SP1 migration"
```

---

## Self-Review

**Spec coverage (SP1 = "render identically on WebGPU; no new features; gate = visual parity + dd9 CPU-frame-time ≤ baseline; fix materialPatchTarget-equivalent for caustics"):**
- Renderer swap → Task 3. Importmap/version → Task 1. Spike/validation → Task 2.
- The three custom shaders (grass/clouds/water) → Tasks 4/5/6. Standard materials (terrain/trees/lights) explicitly need no port → noted in File Structure + Task 3.
- The `onBeforeCompile` caustic patch (the thing TSL can't do) → Task 6 Step 3, re-expressed as a terrain node material.
- Visual parity gate → Tasks 4–7 checkpoints. dd9 CPU-frame-time gate → Task 7 Step 4.
- "Supersedes Codex's WebGL heightmap shader" → terrain stays standard-material in SP1; the gated instanced GLSL path is explicitly out of scope.

**Placeholder scan:** No "TBD/handle-edge-cases." The TSL ports (Tasks 4–6) intentionally reference the existing GLSL as the behavioral source of truth and note exact TSL is version-pinned — this is a stated domain reality (GPU code is browser-validated, not Node-testable), not a lazy placeholder; each carries explicit browser pass/criteria.

**Type/API consistency:** `RENDERER_BACKEND`, `PORTED`, `forceWebGL`, the public module APIs (`createGrass/setWind/setFade/regenerate`, cloud setters, water `setReflectRate/setCaustic/setWaves`) are referenced consistently and preserved across tasks. `renderAsync`/`setAnimationLoop`/`renderer.init()` used consistently.

**Scope:** Single subsystem (the renderer foundation + material ports). No compute, no LOD, no new visuals — those are SP2–SP4. Focused.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-20-sp1-webgpu-renderer-migration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Caveat for this plan: tasks gated by **browser checkpoints** need a human (or browser-capable agent) to observe parity — a Node-only subagent can do the syntax/logic steps and prep the diffs, but the visual gates require eyes on the screen.

**2. Inline Execution** — execute in this session with checkpoints, pausing at each browser-parity gate for you to confirm before continuing.

Which approach?
