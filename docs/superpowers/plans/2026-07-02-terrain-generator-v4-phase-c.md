# Terrain generator v4 — Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive Three.js heightfield viewport to `terrain-generator-v4.html` — a direct height-grid-to-mesh conversion of Phase A's output (no voxels, no marching cubes), with its own independent resolution, display-mode vertex coloring, orbit/pan/zoom, wireframe toggle, and hover readout.

**Architecture:** `buildHeightfieldMesh` (new, DOM-free, in `terrain-generator-js.js`) turns a flat height array into position/normal/index typed arrays. `terrain-generator-v4.html` gains a Three.js r0.184 WebGPU setup (same CDN importmap + `OrbitControls` pattern as `tree-viewer.html`), builds a `BufferGeometry` from those arrays, and recolors it per display mode using the same colormap helpers the 2D panels already use.

**Tech Stack:** Vanilla ES modules, Three.js r0.184 (WebGPU renderer, `OrbitControls`) via CDN importmap, no build step. Node for testing the math module.

---

## Reference: current file state

- `terrain-generator-js.js`: 642 lines. Last export is `maskColor` (line 638). New code appends after it.
- `terrain-generator-v4.html`: 745 lines. Section 7 ("Material masks") ends at line 270 (`</section>`). Section 8 ("A real exported map") starts at line 272, currently `<h2>8. A real exported map</h2>`. Section 9 ("Reference tables") starts around line 288, currently `<h2>9. Reference tables</h2>`. The pipeline diagram's dimmed "Heightfield preview" box is at line 159. The final `regenerate();` call (not the per-section randomize one) is the very last line before `</script>`, line 742.
- `test-terrain-generator-js.mjs`: 224 lines, uses a local `ok(condition, message)` counter (not `node:assert`) — match this convention, not `node:assert`.

---

## Task 1: `buildHeightfieldMesh` (DOM-free mesh math)

**Files:**
- Modify: `workshop-webgpu/terrain-generator-js.js`
- Test: `workshop-webgpu/test-terrain-generator-js.mjs`

Converts a flat height array into position/normal/index typed arrays for a `THREE.BufferGeometry`. Normal formula and triangle winding match this codebase's existing conventions (`terrain-field.js`'s `terrainNormalAt`/`buildChunkArrays`), verified by inspection during design — not imported, since `terrain-generator-js.js` stays independent of production terrain code (same "hand-synced twin" rationale as the rest of the file).

- [ ] **Step 1: Write the failing test**

Append to `workshop-webgpu/test-terrain-generator-js.mjs`:

```js
import { buildHeightfieldMesh } from './terrain-generator-js.js';

// --- Task 1 (Phase C): buildHeightfieldMesh ---
{
  const res = 3;
  const height = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]); // flat
  const { positions, normals, indices } = buildHeightfieldMesh(height, res, 200, 200);

  ok(positions.length === res * res * 3, '1 (Phase C): positions has 3 floats per vertex');
  ok(normals.length === res * res * 3, '1 (Phase C): normals has 3 floats per vertex');
  const quadsPerAxis = res - 1;
  ok(indices.length === quadsPerAxis * quadsPerAxis * 6, '1 (Phase C): indices has 6 per quad');

  // corner (0,0) -> world (-100, 0, -100); center (1,1) -> world (0, 0, 0); corner (2,2) -> (100, 0, 100)
  ok(Math.abs(positions[0] - (-100)) < 1e-6 && Math.abs(positions[1] - 0) < 1e-6 && Math.abs(positions[2] - (-100)) < 1e-6,
    '1 (Phase C): vertex 0 lands at the expected world corner');
  const centerIdx = 4; // (ix=1,iz=1) in a 3x3 grid
  ok(Math.abs(positions[centerIdx * 3] - 0) < 1e-6 && Math.abs(positions[centerIdx * 3 + 2] - 0) < 1e-6,
    '1 (Phase C): center vertex lands at world origin on x/z');

  // Flat terrain -> every normal points straight up.
  let allUp = true;
  for (let i = 0; i < res * res; i++) {
    if (Math.abs(normals[i * 3] - 0) > 1e-5 || Math.abs(normals[i * 3 + 1] - 1) > 1e-5 || Math.abs(normals[i * 3 + 2] - 0) > 1e-5) allUp = false;
  }
  ok(allUp, '1 (Phase C): flat terrain has every normal pointing straight up (0,1,0)');

  // Every normal is unit length.
  let allUnit = true;
  for (let i = 0; i < res * res; i++) {
    const len = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
    if (Math.abs(len - 1) > 1e-5) allUnit = false;
  }
  ok(allUnit, '1 (Phase C): every normal is unit length');
}
{
  // Linear ramp along x: height increases with ix. Normal should tilt in -x.
  const res = 5;
  const height = new Float32Array(res * res);
  for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) height[iz * res + ix] = ix * 10;
  const { normals } = buildHeightfieldMesh(height, res, 400, 400);
  const centerIdx = 2 * res + 2; // interior vertex, away from clamped edges
  ok(normals[centerIdx * 3] < -0.01, '1 (Phase C): a rising-with-x ramp tilts the normal toward -x');
  ok(normals[centerIdx * 3 + 2] > -1e-5 && normals[centerIdx * 3 + 2] < 1e-5, '1 (Phase C): a ramp with no z variation has zero normal.z');
}
console.log('Task 1 (Phase C: buildHeightfieldMesh) OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: FAIL — `buildHeightfieldMesh` not exported yet (SyntaxError on import).

- [ ] **Step 3: Implement**

Append to `workshop-webgpu/terrain-generator-js.js`:

```js
// ---- heightfield mesh (Phase C: direct grid-to-mesh, no voxels) ----
// Normal formula and triangle winding match this codebase's terrain-field.js
// (terrainNormalAt's central-difference sign convention; buildChunkArrays' a/b/c/d
// winding) for consistency, though this function is independent of that file.
export function buildHeightfieldMesh(height, resolution, worldX, worldZ) {
  const n = resolution * resolution;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const dx = worldX / Math.max(1, resolution - 1);
  const dz = worldZ / Math.max(1, resolution - 1);

  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const idx = iz * resolution + ix;
      const x = (ix / Math.max(1, resolution - 1) - 0.5) * worldX;
      const z = (iz / Math.max(1, resolution - 1) - 0.5) * worldZ;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = height[idx];
      positions[idx * 3 + 2] = z;

      const xL = ix > 0 ? height[idx - 1] : height[idx];
      const xR = ix < resolution - 1 ? height[idx + 1] : height[idx];
      const stepX = (ix > 0 && ix < resolution - 1) ? 2 * dx : dx;
      const gradX = (xR - xL) / Math.max(stepX, 1e-6);

      const zT = iz > 0 ? height[idx - resolution] : height[idx];
      const zB = iz < resolution - 1 ? height[idx + resolution] : height[idx];
      const stepZ = (iz > 0 && iz < resolution - 1) ? 2 * dz : dz;
      const gradZ = (zB - zT) / Math.max(stepZ, 1e-6);

      const nx = -gradX, ny = 1, nz = -gradZ;
      const invLen = 1 / (Math.hypot(nx, ny, nz) || 1);
      normals[idx * 3] = nx * invLen;
      normals[idx * 3 + 1] = ny * invLen;
      normals[idx * 3 + 2] = nz * invLen;
    }
  }

  const quadsPerAxis = Math.max(0, resolution - 1);
  const indices = new Uint32Array(quadsPerAxis * quadsPerAxis * 6);
  let o = 0;
  for (let iz = 0; iz < quadsPerAxis; iz++) {
    for (let ix = 0; ix < quadsPerAxis; ix++) {
      const idx = iz * resolution + ix;
      const a = idx;
      const b = idx + resolution;
      const c = idx + resolution + 1;
      const d = idx + 1;
      indices[o++] = a; indices[o++] = b; indices[o++] = d;
      indices[o++] = b; indices[o++] = c; indices[o++] = d;
    }
  }

  return { positions, normals, indices };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: PASS, prints "Task 1 (Phase C: buildHeightfieldMesh) OK".

- [ ] **Step 5: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-js.js test-terrain-generator-js.mjs && git commit -m "feat(terrain-generator): add buildHeightfieldMesh (Phase C mesh math)"
```

---

## Task 2: HTML shell for section 8 + renumbering

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

Structural HTML only — no Three.js wiring yet (Task 3). Inserts the new section, renumbers the two sections after it, and un-dims the pipeline-diagram box.

- [ ] **Step 1: Un-dim the pipeline diagram's "Heightfield preview" box**

In `workshop-webgpu/terrain-generator-v4.html`, find (around line 159):

```html
      <div class="pipe-box small" style="opacity:0.5; border:1px dashed var(--accent);">Heightfield preview<br><span>not yet built (Phase C)</span></div>
```

Replace with:

```html
      <div class="pipe-box small">Heightfield preview<br><span>direct grid-to-mesh, no voxels</span></div>
```

- [ ] **Step 2: Insert the new section 8 after Material masks, renumber the rest**

Find (around line 258-273):

```html
  </section>

  <section class="panel" id="section-consumption">
    <h2>8. A real exported map</h2>
```

Replace with:

```html
  </section>

  <section class="panel" id="section-heightfield">
    <h2>8. Heightfield preview</h2>
    <p class="lede">Direct height-grid to mesh conversion (no voxels, no marching cubes) -- a fast 3D check of Phase A's output at its own resolution.</p>
    <p class="callout hidden" id="heightfield-resolution-warning">Heightfield resolution is above 128 -- rebuilding the mesh may be slow.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <div id="heightfield-viewport" style="width:420px;height:420px;border-radius:8px;border:1px solid var(--border);overflow:hidden;"></div>
        <div id="heightfield-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls">
        <div class="control-row">
          <label for="heightfield-mode-select">Display mode</label>
          <select id="heightfield-mode-select">
            <option value="material">material</option>
            <option value="biome">biome</option>
            <option value="height">height</option>
            <option value="slope">slope</option>
            <option value="seaMask">sea mask</option>
            <option value="beachMask">beach mask</option>
            <option value="mountainMask">mountain mask</option>
            <option value="rockMask">rock mask</option>
            <option value="snowMask">snow mask</option>
            <option value="continentalness">continentalness</option>
            <option value="temperature">temperature</option>
            <option value="humidity">humidity</option>
            <option value="flowNorm">flow accumulation</option>
          </select>
        </div>
        <div class="control-row">
          <p class="control-desc">Grid resolution for the 3D mesh, independent of the 2D panels above.</p>
          <label for="heightfield-resolution">resolution <span id="heightfield-resolution-value">64</span></label>
          <input type="range" id="heightfield-resolution" min="16" max="256" step="8" value="64">
        </div>
        <div class="control-row">
          <label><input type="checkbox" id="heightfield-wireframe"> wireframe</label>
        </div>
        <button class="action" id="heightfield-reset-view">Reset view</button>
        <p class="lede" id="heightfield-stats"></p>
      </div>
    </div>
  </section>

  <section class="panel" id="section-consumption">
    <h2>9. A real exported map</h2>
```

- [ ] **Step 3: Renumber the reference tables section**

Find (around line 288-289):

```html
  <section class="panel" id="section-tables">
    <h2>9. Reference tables</h2>
```

Replace with:

```html
  <section class="panel" id="section-tables">
    <h2>10. Reference tables</h2>
```

- [ ] **Step 4: Update the hero pipeline-overview summary line**

Find:

```html
    <p class="lede" style="margin-top:20px;">Sections 2-7 below cover Phase A (noise fields through material masks). Section 8 shows a real exported map; section 9 lists the reference tables workshop-webgpu reads at runtime.</p>
```

Replace with:

```html
    <p class="lede" style="margin-top:20px;">Sections 2-7 below cover Phase A (noise fields through material masks). Section 8 is Phase C's heightfield preview. Section 9 shows a real exported map; section 10 lists the reference tables workshop-webgpu reads at runtime.</p>
```

- [ ] **Step 5: Verify the section renumbering with a quick grep**

Run: `grep -n "<h2>" "workshop-webgpu/terrain-generator-v4.html"`
Expected: sections numbered 1 through 10 in order, with "8. Heightfield preview" appearing between "7. Material masks" and "9. A real exported map".

- [ ] **Step 6: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): add section 8 HTML shell, renumber sections 9-10"
```

---

## Task 3: Three.js setup (importmap, renderer, camera, controls)

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

No automated test (visual/WebGPU). Verified in Task 8's manual pass.

- [ ] **Step 1: Add the importmap**

In `workshop-webgpu/terrain-generator-v4.html`, find:

```html
</style>
</head>
```

Replace with:

```html
</style>
<!-- three@0.184.0: same CDN pins as tree-viewer.html / environment-viewer.html -->
<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.tsl.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/"
} }
</script>
</head>
```

- [ ] **Step 2: Import Three.js pieces alongside the existing module import**

Find:

```js
  import {
    BIOMES, BIOME_COLORS, DEFAULT_CONFIG, FIELD_GROUPS, FIELD_RANGES, fieldLabel, fieldDescription,
    generateFullGrid, divergingColor, signedColor, heightColor, flowColor, slopeColor, maskColor,
  } from './terrain-generator-js.js';
```

Replace with:

```js
  import {
    BIOMES, BIOME_COLORS, DEFAULT_CONFIG, FIELD_GROUPS, FIELD_RANGES, fieldLabel, fieldDescription,
    generateFullGrid, buildHeightfieldMesh, divergingColor, signedColor, heightColor, flowColor, slopeColor, maskColor,
  } from './terrain-generator-js.js';
  import * as THREE from 'three';
  import { WebGPURenderer } from 'three/webgpu';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
```

- [ ] **Step 3: Add the renderer/scene/camera/controls setup**

Insert directly after the `const REDRAW_CALLBACKS = [];` line (from the existing shared regenerate/scheduleRegenerate block):

```js
  // ---- section 8: Heightfield preview -- Three.js setup ----
  const hfViewport = document.getElementById('heightfield-viewport');
  const hfRenderer = new WebGPURenderer({ antialias: true });
  hfRenderer.setSize(420, 420);
  hfViewport.appendChild(hfRenderer.domElement);
  await hfRenderer.init();

  const hfScene = new THREE.Scene();
  hfScene.background = new THREE.Color(0xfaf6ef);

  const hfCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  const HF_INITIAL_CAMERA_POS = new THREE.Vector3(700, 500, 700);
  const HF_INITIAL_TARGET = new THREE.Vector3(0, 0, 0);
  hfCamera.position.copy(HF_INITIAL_CAMERA_POS);

  const hfControls = new OrbitControls(hfCamera, hfRenderer.domElement);
  hfControls.target.copy(HF_INITIAL_TARGET);
  hfControls.enableDamping = true;
  hfControls.dampingFactor = 0.08;
  hfControls.update();

  const hfAmbient = new THREE.AmbientLight(0xffffff, 0.6);
  const hfDirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  hfDirLight.position.set(400, 600, 200);
  hfScene.add(hfAmbient, hfDirLight);

  document.getElementById('heightfield-reset-view').addEventListener('click', () => {
    hfCamera.position.copy(HF_INITIAL_CAMERA_POS);
    hfControls.target.copy(HF_INITIAL_TARGET);
    hfControls.update();
  });

  hfRenderer.setAnimationLoop(() => {
    hfControls.update();
    hfRenderer.render(hfScene, hfCamera);
  });
```

- [ ] **Step 4: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): add Three.js viewport setup for section 8"
```

---

## Task 4: Mesh construction, resolution control, debounced rebuild

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

- [ ] **Step 1: Add the mesh geometry/material, resolution state, and `regenerateHeightfield`**

Insert directly after Task 3's `hfRenderer.setAnimationLoop(...)` block:

```js
  let heightfieldResolution = 64;
  const HF_WARN_RESOLUTION = 128;
  let hfRegenTimer = null;
  let hfLastGrid = null;

  const hfGeometry = new THREE.BufferGeometry();
  const hfMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const hfMesh = new THREE.Mesh(hfGeometry, hfMaterial);
  hfScene.add(hfMesh);

  function updateHeightfieldResolutionWarning() {
    document.getElementById('heightfield-resolution-warning').classList.toggle('hidden', heightfieldResolution <= HF_WARN_RESOLUTION);
  }

  function rebuildHeightfieldMesh() {
    hfLastGrid = generateFullGrid(genConfig, heightfieldResolution);
    const { positions, normals, indices } = buildHeightfieldMesh(hfLastGrid.height, heightfieldResolution, genConfig.world_x, genConfig.world_z);
    hfGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    hfGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    hfGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    applyHeightfieldColors(hfLastGrid);
    hfGeometry.computeBoundingSphere();
    updateHeightfieldStats(hfLastGrid);
  }

  function scheduleHeightfieldRegenerate() {
    clearTimeout(hfRegenTimer);
    hfRegenTimer = setTimeout(rebuildHeightfieldMesh, 300);
  }
  REDRAW_CALLBACKS.push(() => { updateHeightfieldResolutionWarning(); scheduleHeightfieldRegenerate(); });

  const hfResolutionInput = document.getElementById('heightfield-resolution');
  const hfResolutionValue = document.getElementById('heightfield-resolution-value');
  hfResolutionInput.addEventListener('input', () => {
    heightfieldResolution = Number(hfResolutionInput.value);
    hfResolutionValue.textContent = heightfieldResolution;
    updateHeightfieldResolutionWarning();
    scheduleHeightfieldRegenerate();
  });

  document.getElementById('heightfield-wireframe').addEventListener('change', (ev) => {
    hfMaterial.wireframe = ev.target.checked;
  });

  function updateHeightfieldStats(grid) {
    const res = grid.resolution;
    const vertexCount = res * res;
    const triangleCount = Math.max(0, (res - 1) * (res - 1) * 2);
    let heightMin = Infinity, heightMax = -Infinity;
    for (const h of grid.height) { if (h < heightMin) heightMin = h; if (h > heightMax) heightMax = h; }
    const cellX = genConfig.world_x / Math.max(1, res - 1);
    const cellZ = genConfig.world_z / Math.max(1, res - 1);
    document.getElementById('heightfield-stats').textContent =
      `${vertexCount} vertices, ${triangleCount} triangles -- height ${heightMin.toFixed(1)} to ${heightMax.toFixed(1)} -- cell ${cellX.toFixed(1)}x${cellZ.toFixed(1)}`;
  }
```

Note: `applyHeightfieldColors` is defined in Task 5 — this file will not run correctly until that task lands (expected; Tasks 4 and 5 are meant to be applied together before verifying in a browser).

- [ ] **Step 2: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): add heightfield mesh rebuild + independent resolution control"
```

---

## Task 5: Display-mode vertex coloring

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

- [ ] **Step 1: Add `applyHeightfieldColors` and wire the mode dropdown**

Insert directly after Task 4's `updateHeightfieldStats` function:

```js
  const hfModeSelect = document.getElementById('heightfield-mode-select');
  hfModeSelect.addEventListener('change', () => { if (hfLastGrid) { applyHeightfieldColors(hfLastGrid); } });

  const HF_MASK_COLORS = {
    seaMask: [60, 130, 220], beachMask: [224, 205, 130], mountainMask: [214, 160, 82],
    rockMask: [164, 164, 170], snowMask: [240, 246, 255],
  };

  function applyHeightfieldColors(grid) {
    const mode = hfModeSelect.value;
    const n = grid.resolution * grid.resolution;
    const colors = new Float32Array(n * 3);

    if (mode === 'material') {
      for (let i = 0; i < n; i++) {
        colors[i * 3] = grid.materialRgba[i * 4] / 255;
        colors[i * 3 + 1] = grid.materialRgba[i * 4 + 1] / 255;
        colors[i * 3 + 2] = grid.materialRgba[i * 4 + 2] / 255;
      }
    } else if (mode === 'biome') {
      for (let i = 0; i < n; i++) {
        const [r, g, b] = BIOME_COLORS[BIOMES[grid.biomeId[i]]];
        colors[i * 3] = r / 255; colors[i * 3 + 1] = g / 255; colors[i * 3 + 2] = b / 255;
      }
    } else if (mode === 'height') {
      for (let i = 0; i < n; i++) {
        const [r, g, b] = heightColor(grid.height[i], genConfig.sea_level);
        colors[i * 3] = r / 255; colors[i * 3 + 1] = g / 255; colors[i * 3 + 2] = b / 255;
      }
    } else if (mode === 'slope') {
      let maxSlope = 1.2;
      for (const s of grid.slope) if (s > maxSlope) maxSlope = s;
      for (let i = 0; i < n; i++) {
        const [r, g, b] = slopeColor(grid.slope[i], maxSlope);
        colors[i * 3] = r / 255; colors[i * 3 + 1] = g / 255; colors[i * 3 + 2] = b / 255;
      }
    } else if (mode in HF_MASK_COLORS) {
      const field = grid[mode];
      const targetColor = HF_MASK_COLORS[mode];
      for (let i = 0; i < n; i++) {
        const [r, g, b] = maskColor(field[i], targetColor);
        colors[i * 3] = r / 255; colors[i * 3 + 1] = g / 255; colors[i * 3 + 2] = b / 255;
      }
    } else if (mode === 'continentalness' || mode === 'temperature' || mode === 'humidity') {
      const field = grid[mode];
      for (let i = 0; i < n; i++) {
        const [r, g, b] = divergingColor(field[i]);
        colors[i * 3] = r / 255; colors[i * 3 + 1] = g / 255; colors[i * 3 + 2] = b / 255;
      }
    } else if (mode === 'flowNorm') {
      for (let i = 0; i < n; i++) {
        const [r, g, b] = flowColor(grid.flowNorm[i]);
        colors[i * 3] = r / 255; colors[i * 3 + 1] = g / 255; colors[i * 3 + 2] = b / 255;
      }
    }

    hfGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
```

- [ ] **Step 2: Trigger the first mesh build at the end of the script**

Find the final line of the script (the shared `regenerate();` call, currently the last statement before `</script>`):

```js
  regenerate();
</script>
```

Replace with:

```js
  regenerate();
  updateHeightfieldResolutionWarning();
  rebuildHeightfieldMesh();
</script>
```

- [ ] **Step 3: Verify the module has no syntax errors**

Run:

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('workshop-webgpu/terrain-generator-v4.html', 'utf8');
const match = html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);
fs.writeFileSync('workshop-webgpu/.tmp-check.mjs', match[1]);
"
node --check workshop-webgpu/.tmp-check.mjs && rm workshop-webgpu/.tmp-check.mjs
```

Expected: no output from `node --check` (syntax valid), file removed after.

- [ ] **Step 4: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): add heightfield display-mode vertex coloring"
```

---

## Task 6: Hover raycast tooltip

**Files:**
- Modify: `workshop-webgpu/terrain-generator-v4.html`

- [ ] **Step 1: Add raycasting on pointer move over the viewport**

Insert directly after Task 5's `applyHeightfieldColors` function (before Task 5 Step 2's final `regenerate();` block, i.e. still inside the module script):

```js
  const hfRaycaster = new THREE.Raycaster();
  const hfPointerNdc = new THREE.Vector2();
  const hfTooltip = document.getElementById('heightfield-tooltip');

  hfRenderer.domElement.addEventListener('pointermove', (ev) => {
    if (!hfLastGrid) return;
    const rect = hfRenderer.domElement.getBoundingClientRect();
    hfPointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    hfPointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    hfRaycaster.setFromCamera(hfPointerNdc, hfCamera);
    const hits = hfRaycaster.intersectObject(hfMesh);
    if (hits.length === 0) { hfTooltip.classList.add('hidden'); return; }

    const point = hits[0].point;
    const res = hfLastGrid.resolution;
    const fx = (point.x / genConfig.world_x + 0.5) * (res - 1);
    const fz = (point.z / genConfig.world_z + 0.5) * (res - 1);
    const ix = Math.max(0, Math.min(res - 1, Math.round(fx)));
    const iz = Math.max(0, Math.min(res - 1, Math.round(fz)));
    const idx = iz * res + ix;
    const mode = hfModeSelect.value;
    const modeValue = mode in hfLastGrid ? hfLastGrid[mode][idx] : undefined;

    hfTooltip.classList.remove('hidden');
    hfTooltip.style.left = (ev.clientX - rect.left) + 'px';
    hfTooltip.style.top = (ev.clientY - rect.top) + 'px';
    hfTooltip.textContent =
      `x ${point.x.toFixed(1)}  z ${point.z.toFixed(1)}\nheight ${hfLastGrid.height[idx].toFixed(2)}` +
      (modeValue !== undefined ? `\n${mode}: ${modeValue.toFixed(3)}` : '');
  });
  hfRenderer.domElement.addEventListener('pointerleave', () => hfTooltip.classList.add('hidden'));
```

- [ ] **Step 2: Verify syntax**

Run:

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('workshop-webgpu/terrain-generator-v4.html', 'utf8');
const match = html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);
fs.writeFileSync('workshop-webgpu/.tmp-check.mjs', match[1]);
"
node --check workshop-webgpu/.tmp-check.mjs && rm workshop-webgpu/.tmp-check.mjs
```

Expected: no output, file removed.

- [ ] **Step 3: Commit**

```bash
cd "workshop-webgpu" && git add terrain-generator-v4.html && git commit -m "feat(terrain-generator): add heightfield hover raycast tooltip"
```

---

## Task 7: Full test suite + manual verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full Node test suite**

Run: `node workshop-webgpu/test-biome-classifier-js.mjs && node workshop-webgpu/test-terrain-generator-js.mjs`
Expected: both print all "OK" lines, 0 failures.

- [ ] **Step 2: Manual browser verification**

With `python workshop-webgpu/serve.py 8080` running, open `http://127.0.0.1:8080/terrain-generator-v4.html` and confirm:
- Section 8 ("Heightfield preview") renders a 3D terrain mesh matching section 3's height panel shape.
- Dragging to orbit, scrolling to zoom, and right-drag to pan all work.
- The display-mode dropdown recolors the mesh without rebuilding it (instant, no debounce delay).
- Dragging the resolution slider above 128 shows the warning banner and rebuilds the mesh after ~300ms.
- The wireframe checkbox toggles wireframe rendering.
- "Reset view" restores the initial camera angle after orbiting/panning away.
- Hovering the mesh shows a tooltip with world x/z, height, and the active mode's value.
- The stats line shows vertex/triangle counts and height range matching the current resolution.
- No console errors.
- If headless-Chrome verification is used instead of a live browser: WebGPU may not render under `--disable-gpu`, so treat a DOM-structure-only check (canvas element present inside `#heightfield-viewport`, no console errors) as sufficient — do not treat a blank/black screenshot as a failure on that basis alone.

- [ ] **Step 3: Fix any issues found, re-run Steps 1-2**

If verification surfaces a bug, fix it in the relevant file from Tasks 1-6, re-run the full test suite, and re-check in the browser before proceeding.

---

## Task 8: Docs and logging

**Files:**
- Modify: `workshop-webgpu/docs/subsystems/biomes.md`
- Modify: `workshop-webgpu/agent_log.csv`

- [ ] **Step 1: Update the `biomes.md` link description**

Open `workshop-webgpu/docs/subsystems/biomes.md`, find the `terrain-generator-v4.html` paragraph added during Phase A:

```markdown
> `../../terrain-generator-v4.html` covers the same generation pipeline in more depth
> (erosion simulation, sea/lake/mountain/rock/snow masks, material masks) with the full
> `config.py` field surface exposed as sliders.
```

Replace with:

```markdown
> `../../terrain-generator-v4.html` covers the same generation pipeline in more depth
> (erosion simulation, sea/lake/mountain/rock/snow masks, material masks) with the full
> `config.py` field surface exposed as sliders, plus an interactive Three.js heightfield
> viewport (direct grid-to-mesh, independent resolution, orbit/pan/zoom, display-mode
> vertex coloring).
```

- [ ] **Step 2: Append the `agent_log.csv` row**

Append to `workshop-webgpu/agent_log.csv`:

```csv
2026-07-02T22:30,terrain,"terrain-generator-v4.html;terrain-generator-js.js;test-terrain-generator-js.mjs;docs/subsystems/biomes.md",Added Phase C to terrain-generator-v4.html: an interactive Three.js heightfield viewport (direct 2D-height-grid to mesh, no voxels) with independent resolution, orbit/pan/zoom via OrbitControls, wireframe toggle, hover raycast, and per-vertex display-mode coloring reusing Phase A's colormap helpers.
```

- [ ] **Step 3: Commit**

```bash
cd "workshop-webgpu" && git add docs/subsystems/biomes.md agent_log.csv && git commit -m "docs(terrain-generator): document Phase C heightfield viewport"
```

---

## Plan self-review notes

- **Spec coverage:** `buildHeightfieldMesh` (Task 1) covers the mesh-math section; independent resolution + debounced rebuild (Task 4) covers the update-wiring section; Three.js/OrbitControls setup (Task 3) covers the viewport-setup section; all 13 display modes (Task 5) cover the display-modes section; hover raycast + stats (Task 6, Task 4's `updateHeightfieldStats`) covers interaction & stats; section placement after 7, renumbering 8/9 to 9/10 (Task 2) covers page placement.
- **Non-goals respected:** no paint-in-3D, no density field/marching cubes anywhere in the plan.
- **Type consistency:** `buildHeightfieldMesh(height, resolution, worldX, worldZ)` signature is identical between Task 1's implementation and Task 4's call site. `applyHeightfieldColors(grid)` is defined in Task 5 and called from Task 4's `rebuildHeightfieldMesh` and Task 5's own mode-change listener — same name throughout.
