# Tree Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `workshop-webgpu/tree-viewer.html`, a standalone single-file tuning tool that exposes `trees.js`'s full procedural-tree parameter surface via a live control panel, with Solo/Grid view modes, a procedural/authored texture toggle, and a JSON export of the current tree options.

**Architecture:** One `<script type="module">` page, no bundler, served by the existing `serve.py`. Reuses `trees.js` (`createTree`), `tree-textures.js` (`createTextureSource`), and `lights.js` (`createLightingRig`) unmodified. Adds its own minimal scene shell (`WebGPURenderer` + `OrbitControls`, new to this codebase) and duplicates the project's lightweight draggable-panel UI pattern (not imported — `environment-viewer.html` isn't a module). A tree is always fully disposed+recreated via `createTree()` on every change (not `.regenerate()`), because `trees.js` only builds materials once in its constructor — color/roughness/map changes would silently no-op if applied via `.regenerate()` alone.

**Tech Stack:** Three.js r0.184 (`three.webgpu.js`/`three.tsl.js`/`OrbitControls` via the existing CDN import map), vanilla DOM for the control panel, Python's stdlib `http.server` via `serve.py`.

**Spec:** `docs/superpowers/specs/2026-06-30-tree-viewer-design.md`

---

## Shared verification command

Every task below that edits `tree-viewer.html` ends with a syntax check. It extracts the
`<script type="module">` body and runs it through `node --check` (pure syntax validation, no
execution — `document`/`window`/`navigator`/bare-specifier `import`s are all fine since the code
never runs, only parses). Run it from `workshop-webgpu/`:

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('tree-viewer.html', 'utf8');
const m = html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);
if (!m) throw new Error('module script not found');
fs.writeFileSync('.script-check.mjs', m[1]);
" && node --check .script-check.mjs && rm .script-check.mjs
```

Expected output: nothing printed (success). A `SyntaxError` with a line number means the most
recent edit broke something — fix it before moving on.

---

### Task 1: Scene shell scaffold

**Files:**
- Create: `workshop-webgpu/tree-viewer.html`

- [ ] **Step 1: Write the initial HTML shell with renderer/scene/camera/controls/lighting/ground**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tree Viewer</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #1a1d23; }
  #info { position: fixed; top: 10px; left: 12px; color: #8a93a3;
    font: 12px/1.5 system-ui, sans-serif; user-select: none; pointer-events: none;
    max-width: calc(100vw - 280px); z-index: 5; }
</style>
</head>
<body>
<div id="info">drag&nbsp;orbit &middot; scroll&nbsp;zoom &mdash; standalone procedural tree tuning tool</div>

<!-- three@0.184.0: same CDN pins as environment-viewer.html -->
<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.tsl.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/"
} }
</script>

<script type="module">
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLightingRig } from './lights.js';
import { createTree } from './trees.js';
import { createTextureSource } from './tree-textures.js';

const infoEl = document.getElementById('info');
function showError(msg) { if (infoEl) { infoEl.innerHTML = '⚠ ' + msg; infoEl.style.color = '#ffb3b3'; } }
addEventListener('error', e => showError(e.message || 'script error'));
addEventListener('unhandledrejection', e => showError((e.reason && e.reason.message) || String(e.reason)));

// ===================== renderer / scene / camera =====================
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d23);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(18, 12, 18);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

// ===================== lighting =====================
const rig = createLightingRig({ scene, ui: false, elevation: 55, azimuth: 45 });
rig.dirLight.castShadow = true;
scene.add(rig.dirLight.target);
rig.dirLight.shadow.mapSize.set(2048, 2048);
rig.dirLight.shadow.camera.near = 1; rig.dirLight.shadow.camera.far = 120;
rig.dirLight.shadow.camera.left = -30; rig.dirLight.shadow.camera.right = 30;
rig.dirLight.shadow.camera.top = 30; rig.dirLight.shadow.camera.bottom = -30;

// ===================== ground =====================
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x3a4a32, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
</script>
</body>
</html>
```

- [ ] **Step 2: Run the syntax check**

Run (from `workshop-webgpu/`):

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('tree-viewer.html', 'utf8');
const m = html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);
if (!m) throw new Error('module script not found');
fs.writeFileSync('.script-check.mjs', m[1]);
" && node --check .script-check.mjs && rm .script-check.mjs
```

Expected: no output.

- [ ] **Step 3: Manually confirm it loads**

Run: `python serve.py 8090` (background), then `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/tree-viewer.html`
Expected: `200`

- [ ] **Step 4: Commit**

```bash
git add tree-viewer.html
git commit -m "feat(tree-viewer): scaffold standalone scene shell (renderer, camera, controls, lighting, ground)"
```

---

### Task 2: Tree data model and view/regenerate machinery

**Files:**
- Modify: `workshop-webgpu/tree-viewer.html`

- [ ] **Step 1: Insert the data model before the animation loop**

Use Edit with this exact anchor (the end of Task 1's script) — `old_string` is the animation-loop
block, `new_string` prepends the new code before it and keeps the loop last:

old_string:
```js
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

new_string:
```js
// ===================== tree data model =====================
// trees.js's Tree constructor deep-merges user options over its internal DEFAULTS and stores
// the merged result as `.options` — using that (rather than re-declaring DEFAULTS here) keeps
// `opts`'s shape guaranteed identical to what createTree()/regenerate() expect.
const _genTree = createTree({});
const opts = _genTree.options;
_genTree.dispose();

let mode = 'solo';        // 'solo' | 'grid'
let gridSize = 3;
let baseSeed = opts.seed;
let texMode = 'procedural';
let texSet = createTextureSource('procedural');

let soloTree = null;
let gridTrees = [];
let refreshExport = () => {};   // reassigned once the Export section builds its textarea (Task 7)

function disposeTree(t) { scene.remove(t); t.dispose(); }

function makeTree(treeOpts) {
  const t = createTree(treeOpts);
  t.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return t;
}

function fitCameraToBox(box, radiusMult, minDist) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = Math.max(sphere.radius * radiusMult, minDist);
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0.6, 0.5, 0.6).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  controls.update();
}
function fitCameraTo(object3d) { fitCameraToBox(new THREE.Box3().setFromObject(object3d), 2.4, 6); }
function fitCameraToGrid() {
  const box = new THREE.Box3();
  for (const t of gridTrees) box.expandByObject(t);
  fitCameraToBox(box, 1.8, 10);
}

// Materials are built once in the Tree constructor (trees.js never updates them in
// regenerate()), so any change — including bark/leaf color, roughness, or texture maps —
// requires a full dispose+recreate, not just regenerate(). Solo and Grid both always fully
// rebuild on every change; the 130ms debounce (below) keeps that cheap enough for live tuning.
function buildSolo() {
  soloTree = makeTree(opts);
  scene.add(soloTree);
  fitCameraTo(soloTree);
}
function regenerateSolo(refit) {
  if (soloTree) disposeTree(soloTree);
  soloTree = makeTree(opts);
  scene.add(soloTree);
  if (refit) fitCameraTo(soloTree);
}
function buildGrid() {
  for (const t of gridTrees) disposeTree(t);
  gridTrees = [];
  const spacing = Math.max(6, opts.length[0] * 2.5);
  const half = (gridSize - 1) / 2;
  for (let i = 0; i < gridSize * gridSize; i++) {
    const t = makeTree({ ...opts, seed: baseSeed + i });
    t.position.set(((i % gridSize) - half) * spacing, 0, (Math.floor(i / gridSize) - half) * spacing);
    scene.add(t);
    gridTrees.push(t);
  }
  fitCameraToGrid();
}
function disposeCurrent() {
  if (soloTree) { disposeTree(soloTree); soloTree = null; }
  for (const t of gridTrees) disposeTree(t);
  gridTrees = [];
}
// Used for mode switches, grid-size changes, and seed rerolls — anything that should rebuild
// and refit the camera immediately, bypassing the debounce used for slider drags.
function rebuildView() {
  clearTimeout(regenTimer);
  needsRefit = false;
  disposeCurrent();
  if (mode === 'solo') buildSolo(); else buildGrid();
  refreshExport();
}

let regenTimer = null;
let needsRefit = false;
function scheduleRegenerate(refit = false) {
  if (refit) needsRefit = true;
  clearTimeout(regenTimer);
  regenTimer = setTimeout(regenerateAll, 130);
}
function regenerateAll() {
  if (mode === 'solo') regenerateSolo(needsRefit);
  else buildGrid();
  needsRefit = false;
  refreshExport();
}

function applyTexSetToOpts() {
  opts.bark.map = texSet.barkMap || null;
  opts.bark.normalMap = texSet.barkNormalMap || null;
  opts.bark.vScale = texSet.barkVScale ?? opts.bark.vScale;
  opts.leaves.map = texSet.leafMap || null;
  opts.leaves.alphaTest = texSet.leafAlphaTest ?? 0;
}
function applyTextureMode(nextMode) {
  texSet.dispose?.();
  texMode = nextMode;
  texSet = createTextureSource(texMode, { onReady: () => scheduleRegenerate() });
  applyTexSetToOpts();
  scheduleRegenerate();
}

rebuildView();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

- [ ] **Step 2: Run the syntax check** (same command as Task 1 Step 2). Expected: no output.

- [ ] **Step 3: Manually confirm a tree now renders**

With `serve.py` still running, reload `http://127.0.0.1:8080/tree-viewer.html` (or whatever port)
in a browser and confirm a single tree renders on the ground plane with shadows, camera framed on
it, and orbit/zoom work. No controls panel exists yet — that's expected.

- [ ] **Step 4: Commit**

```bash
git add tree-viewer.html
git commit -m "feat(tree-viewer): add tree data model, solo/grid build, debounced regenerate, texture-mode plumbing"
```

---

### Task 3: Controls panel scaffold and generic primitives

**Files:**
- Modify: `workshop-webgpu/tree-viewer.html`

- [ ] **Step 1: Insert the panel DOM/CSS and control-building primitives**

old_string:
```js
rebuildView();

renderer.setAnimationLoop(() => {
```

new_string:
```js
rebuildView();

// ===================== controls panel =====================
const panelStyle = document.createElement('style');
panelStyle.textContent = '#ctrl{position:fixed;top:10px;right:10px;width:250px;background:rgba(20,24,30,.86);border:1px solid #333a45;border-radius:8px;color:#c4ccd6;font:12px/1.45 system-ui,sans-serif;user-select:none;z-index:20}#ctrl-bar{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;cursor:move;border-bottom:1px solid #333a45}#ctrl-bar .ttl{font-size:12px;color:#8a93a3;font-weight:600}#ctrl-min{background:none;border:none;color:#8a93a3;font:16px/1 system-ui,sans-serif;cursor:pointer;padding:0 2px}#ctrl-min:hover{color:#c4ccd6}#ctrl-body{padding:2px 12px 10px;max-height:min(82vh,760px);overflow-y:auto}#ctrl.min #ctrl-body{display:none}#ctrl.min #ctrl-bar{border-bottom:none}#ctrl .sec-head{display:flex;justify-content:space-between;align-items:center;cursor:pointer;margin:10px 0 4px;color:#8a93a3}#ctrl .sec-head .caret{font-size:10px;transition:transform .15s}#ctrl .sec.collapsed .caret{transform:rotate(-90deg)}#ctrl .sec.collapsed .sec-body{display:none}#ctrl .row{margin:7px 0 1px;display:flex;justify-content:space-between}#ctrl .row span{color:#7f8a99}#ctrl input[type=range]{width:100%;margin:0}#ctrl input[type=color]{width:100%;height:20px;border:none;background:none;padding:0;cursor:pointer}#ctrl select{width:100%;background:#222831;color:#c4ccd6;border:1px solid #3a434f;border-radius:4px;padding:3px}#ctrl button{width:100%;background:#2a313c;color:#c4ccd6;border:1px solid #3a434f;border-radius:4px;padding:5px;cursor:pointer;margin:4px 0}#ctrl button:hover{background:#333c49}#ctrl textarea{width:100%;height:90px;background:#15181d;color:#9fe39f;border:1px solid #3a434f;border-radius:4px;font:11px/1.4 monospace;resize:vertical}';
document.head.appendChild(panelStyle);

const ctrlBox = document.createElement('div'); ctrlBox.id = 'ctrl'; document.body.appendChild(ctrlBox);
const ctrlBar = document.createElement('div'); ctrlBar.id = 'ctrl-bar';
ctrlBar.innerHTML = '<span class="ttl">Tree controls</span>';
const ctrlMin = document.createElement('button'); ctrlMin.id = 'ctrl-min'; ctrlMin.textContent = '–';
ctrlBar.appendChild(ctrlMin);
const ctrlBody = document.createElement('div'); ctrlBody.id = 'ctrl-body';
ctrlBox.appendChild(ctrlBar); ctrlBox.appendChild(ctrlBody);
let current = ctrlBody;

ctrlMin.addEventListener('click', () => { ctrlMin.textContent = ctrlBox.classList.toggle('min') ? '+' : '–'; });

let ctrlDrag = null;
ctrlBar.addEventListener('pointerdown', e => {
  if (e.target === ctrlMin) return;
  const r = ctrlBox.getBoundingClientRect();
  ctrlDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  ctrlBar.setPointerCapture(e.pointerId);
});
ctrlBar.addEventListener('pointermove', e => {
  if (!ctrlDrag) return;
  ctrlBox.style.right = 'auto';
  const maxX = Math.max(10, window.innerWidth - ctrlBox.offsetWidth - 10);
  const maxY = Math.max(10, window.innerHeight - ctrlBox.offsetHeight - 10);
  ctrlBox.style.left = Math.max(10, Math.min(maxX, e.clientX - ctrlDrag.dx)) + 'px';
  ctrlBox.style.top = Math.max(10, Math.min(maxY, e.clientY - ctrlDrag.dy)) + 'px';
});
ctrlBar.addEventListener('pointerup', e => { ctrlDrag = null; ctrlBar.releasePointerCapture(e.pointerId); });

// Each header() opens a collapsible section; subsequent controls land in it via `current`.
function header(text) {
  const sec = document.createElement('div'); sec.className = 'sec';
  const head = document.createElement('div'); head.className = 'sec-head';
  head.innerHTML = '<span>' + text + '</span><span class="caret">▾</span>';
  const secBody = document.createElement('div'); secBody.className = 'sec-body';
  head.addEventListener('click', () => sec.classList.toggle('collapsed'));
  sec.appendChild(head); sec.appendChild(secBody); ctrlBody.appendChild(sec);
  current = secBody;
  return secBody;
}
// Temporarily redirects `current` to `hostEl` for the duration of `fn` — used to build a
// sub-group of rows (e.g. per-level structure rows) inside a container that can be cleared
// and rebuilt independently of the rest of its section.
function withHost(hostEl, fn) { const prev = current; current = hostEl; fn(); current = prev; }

function row(labelHtml) {
  const r = document.createElement('div'); r.className = 'row'; r.innerHTML = labelHtml;
  current.appendChild(r);
  return r;
}
function rangeControl(label, min, max, step, get, set, fmt, onChange) {
  const r = row('<span style="color:#c4ccd6">' + label + '</span>');
  const val = document.createElement('span'); val.textContent = fmt(get()); r.appendChild(val);
  const inp = document.createElement('input'); inp.type = 'range';
  inp.min = min; inp.max = max; inp.step = step; inp.value = get();
  inp.addEventListener('input', () => { set(parseFloat(inp.value)); val.textContent = fmt(get()); onChange(); });
  current.appendChild(inp);
  return inp;
}
function selectControl(label, choices, get, set, onChange) {
  row('<span style="color:#c4ccd6">' + label + '</span>');
  const sel = document.createElement('select');
  for (const c of choices) {
    const op = document.createElement('option'); op.value = c; op.textContent = c;
    if (c === get()) op.selected = true;
    sel.appendChild(op);
  }
  sel.addEventListener('change', () => { set(sel.value); onChange(); });
  current.appendChild(sel);
  return sel;
}
function toggleControl(label, get, set, onChange) {
  const r = row('<span style="color:#c4ccd6">' + label + '</span>');
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!get(); inp.style.width = 'auto';
  inp.addEventListener('change', () => { set(inp.checked); onChange(); });
  r.appendChild(inp);
  return inp;
}
function colorControl(label, get, set, onChange) {
  row('<span style="color:#c4ccd6">' + label + '</span>');
  const inp = document.createElement('input'); inp.type = 'color';
  inp.value = '#' + get().toString(16).padStart(6, '0');
  inp.addEventListener('input', () => { set(parseInt(inp.value.slice(1), 16)); onChange(); });
  current.appendChild(inp);
  return inp;
}
function buttonControl(label, onClick) {
  const btn = document.createElement('button'); btn.textContent = label;
  btn.addEventListener('click', onClick);
  current.appendChild(btn);
  return btn;
}

function getPath(obj, path) { return path.split('.').reduce((o, k) => o[k], obj); }
function setPath(obj, path, val) {
  const parts = path.split('.'); const last = parts.pop();
  parts.reduce((o, k) => o[k], obj)[last] = val;
}

const f2 = v => v.toFixed(2);
const fi = v => String(Math.round(v));
const pct = v => Math.round(v * 100) + '%';

// Thin wrappers over the primitives above for the common case of a control bound directly
// to a path inside `opts` (as opposed to View/Texture-section controls, which bind to
// page-local state like `mode`/`gridSize`/`texMode`).
function optsSlider(path, label, min, max, step, fmt, refit = false) {
  return rangeControl(label, min, max, step, () => getPath(opts, path), v => setPath(opts, path, v), fmt, () => scheduleRegenerate(refit));
}
function optsSelect(path, label, choices) {
  return selectControl(label, choices, () => getPath(opts, path), v => setPath(opts, path, v), () => scheduleRegenerate());
}
function optsToggle(path, label) {
  return toggleControl(label, () => getPath(opts, path), v => setPath(opts, path, v), () => scheduleRegenerate());
}
function optsColor(path, label) {
  return colorControl(label, () => getPath(opts, path), v => setPath(opts, path, v), () => scheduleRegenerate());
}

renderer.setAnimationLoop(() => {
```

- [ ] **Step 2: Run the syntax check**. Expected: no output.

- [ ] **Step 3: Manually confirm the empty panel appears**

Reload the page. Confirm a "Tree controls" panel appears top-right, is draggable by its title bar,
and the minimize button collapses/expands it. It will have no sections yet.

- [ ] **Step 4: Commit**

```bash
git add tree-viewer.html
git commit -m "feat(tree-viewer): add draggable controls panel shell and generic control primitives"
```

---

### Task 4: View and Texture sections

**Files:**
- Modify: `workshop-webgpu/tree-viewer.html`

- [ ] **Step 1: Insert the View and Texture panel sections**

old_string:
```js
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

new_string:
```js
// ===================== View / Texture sections =====================
header('View');
let seedLabel;
{
  const r = row('<span style="color:#c4ccd6">Seed</span>');
  seedLabel = document.createElement('span');
  r.appendChild(seedLabel);
}
function refreshSeedLabel() { seedLabel.textContent = String(mode === 'solo' ? opts.seed : baseSeed); }
refreshSeedLabel();

selectControl('Mode', ['solo', 'grid'], () => mode, v => { mode = v; }, () => {
  gridSizeWrap.style.display = mode === 'grid' ? '' : 'none';
  refreshSeedLabel();
  rebuildView();
});

const gridSizeWrap = document.createElement('div');
current.appendChild(gridSizeWrap);
withHost(gridSizeWrap, () => {
  rangeControl('Grid size', 2, 5, 1, () => gridSize, v => { gridSize = Math.round(v); }, fi, () => { if (mode === 'grid') rebuildView(); });
});
gridSizeWrap.style.display = mode === 'grid' ? '' : 'none';

buttonControl('Reroll seed', () => {
  if (mode === 'solo') opts.seed = (Math.random() * 1e9) | 0;
  else baseSeed = (Math.random() * 1e9) | 0;
  refreshSeedLabel();
  rebuildView();
});

header('Texture');
selectControl('Texture mode', ['procedural', 'authored'], () => texMode, applyTextureMode, () => {});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

- [ ] **Step 2: Run the syntax check**. Expected: no output.

- [ ] **Step 3: Manually confirm View/Texture controls work**

Reload the page. In the "View" section: confirm "Grid size" is hidden while Mode is "solo";
switch Mode to "grid" and confirm a grid of trees appears and "Grid size" becomes visible;
changing "Grid size" rebuilds the grid; "Reroll seed" changes the tree(s)' shape. In "Texture":
switching to "authored" should (after a moment) show bark/leaf textures on the tree(s); switching
back to "procedural" should remove them.

- [ ] **Step 4: Commit**

```bash
git add tree-viewer.html
git commit -m "feat(tree-viewer): add View (solo/grid, seed) and Texture mode panel sections"
```

---

### Task 5: Structure section (per-level branch params)

**Files:**
- Modify: `workshop-webgpu/tree-viewer.html`

- [ ] **Step 1: Insert the Structure section**

old_string:
```js
header('Texture');
selectControl('Texture mode', ['procedural', 'authored'], () => texMode, applyTextureMode, () => {});

renderer.setAnimationLoop(() => {
```

new_string:
```js
header('Texture');
selectControl('Texture mode', ['procedural', 'authored'], () => texMode, applyTextureMode, () => {});

// ===================== Structure section =====================
header('Structure');
rangeControl('Levels', 0, 3, 1, () => opts.levels, v => { opts.levels = Math.round(v); }, fi, () => {
  rebuildStructureRows();
  scheduleRegenerate(true);
});

const LEVEL_PARAMS = [
  { key: 'length', label: 'Length', min: 1, max: 30, step: 0.5, fmt: f2 },
  { key: 'radius', label: 'Radius', min: 0.05, max: 2, step: 0.01, fmt: f2 },
  { key: 'taper', label: 'Taper', min: 0, max: 1, step: 0.01, fmt: f2 },
  { key: 'children', label: 'Children', min: 0, max: 10, step: 1, fmt: fi },
  { key: 'branchStart', label: 'Branch start', min: 0, max: 1, step: 0.01, fmt: f2 },
  { key: 'angle', label: 'Angle', min: 0, max: 90, step: 1, fmt: fi },
  { key: 'gnarliness', label: 'Gnarliness', min: 0, max: 1, step: 0.01, fmt: f2 },
  { key: 'twist', label: 'Twist', min: -1, max: 1, step: 0.01, fmt: f2 },
  { key: 'sections', label: 'Sections', min: 3, max: 16, step: 1, fmt: fi },
  { key: 'segments', label: 'Segments', min: 3, max: 16, step: 1, fmt: fi },
];

const structureHost = document.createElement('div');
current.appendChild(structureHost);

// trees.js's per-level arrays already have one entry per level 0-3 (DEFAULTS), matching the
// Levels slider's 0-3 range, so no array-growing logic is needed here — only re-rendering
// which rows (0..opts.levels) are shown.
function rebuildStructureRows() {
  structureHost.innerHTML = '';
  withHost(structureHost, () => {
    for (const p of LEVEL_PARAMS) {
      for (let level = 0; level <= opts.levels; level++) {
        optsSlider(`${p.key}.${level}`, `${p.label} L${level}`, p.min, p.max, p.step, p.fmt);
      }
    }
  });
}
rebuildStructureRows();

renderer.setAnimationLoop(() => {
```

- [ ] **Step 2: Run the syntax check**. Expected: no output.

- [ ] **Step 3: Manually confirm the Structure section**

Reload the page. Confirm "Structure" shows a "Levels" slider plus 10 rows per level (Length,
Radius, Taper, Children, Branch start, Angle, Gnarliness, Twist, Sections, Segments) repeated for
each level from 0 to the current `Levels` value. Dragging "Levels" down to 0 should leave only the
L0 row of each param and immediately reshape the tree to a trunk with no branches; dragging it
back up should restore the lower rows.

- [ ] **Step 4: Commit**

```bash
git add tree-viewer.html
git commit -m "feat(tree-viewer): add Structure section with per-level branch parameter rows"
```

---

### Task 6: Force, Bark, and Leaves sections

**Files:**
- Modify: `workshop-webgpu/tree-viewer.html`

- [ ] **Step 1: Insert the Force, Bark, and Leaves sections**

old_string:
```js
rebuildStructureRows();

renderer.setAnimationLoop(() => {
```

new_string:
```js
rebuildStructureRows();

// ===================== Force section =====================
header('Force');
let forceAz = Math.atan2(opts.force.direction[0], opts.force.direction[2]) * 180 / Math.PI;
let forceEl = Math.asin(Math.max(-1, Math.min(1, opts.force.direction[1]))) * 180 / Math.PI;
function applyForceDirection() {
  const a = forceAz * Math.PI / 180, e = forceEl * Math.PI / 180;
  opts.force.direction = [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}
rangeControl('Direction azimuth', 0, 360, 1, () => forceAz, v => { forceAz = v; applyForceDirection(); }, fi, () => scheduleRegenerate());
rangeControl('Direction elevation', -90, 90, 1, () => forceEl, v => { forceEl = v; applyForceDirection(); }, fi, () => scheduleRegenerate());
optsSlider('force.strength', 'Strength', 0, 0.2, 0.001, v => v.toFixed(3));

// ===================== Bark section =====================
header('Bark');
optsColor('bark.color', 'Color');
optsSlider('bark.roughness', 'Roughness', 0, 1, 0.01, f2);
optsToggle('bark.flatShading', 'Flat shading');
optsSlider('bark.vScale', 'Texture V scale', 0.05, 2, 0.01, f2);

// ===================== Leaves section =====================
header('Leaves');
optsToggle('leaves.enabled', 'Enabled');
optsSlider('leaves.count', 'Count', 0, 40, 1, fi);
optsSlider('leaves.size', 'Size', 0.2, 3, 0.01, f2);
optsSlider('leaves.sizeVariance', 'Size variance', 0, 1, 0.01, f2);
optsSlider('leaves.start', 'Start', 0, 0.9, 0.01, f2);
optsSlider('leaves.spread', 'Spread', 0, 1, 0.01, f2);
optsSlider('leaves.angle', 'Angle', 0, 90, 1, fi);
optsToggle('leaves.doubleBillboard', 'Double billboard');
optsToggle('leaves.roundedNormals', 'Rounded normals');
optsSelect('leaves.shape', 'Shape', ['quad', 'simple']);

// The leaf atlas cell pin only has a visible effect once 'authored' texture mode has loaded a
// leaf atlas (procedural mode has no leafMap to sample a cell from), but the controls are
// always shown — toggling them is harmless either way.
let atlasPinned = false;
let atlasCell = 0;
function applyAtlas() { opts.leaves.atlas = atlasPinned ? { cols: 2, rows: 2, cell: atlasCell } : null; }
toggleControl('Pin leaf atlas cell (authored mode only)', () => atlasPinned, v => { atlasPinned = v; applyAtlas(); }, () => scheduleRegenerate());
rangeControl('Atlas cell', 0, 3, 1, () => atlasCell, v => { atlasCell = Math.round(v); applyAtlas(); }, fi, () => scheduleRegenerate());

optsSlider('leaves.shadowFraction', 'Shadow fraction', 0, 1, 0.01, pct);
optsColor('leaves.tint', 'Tint');
optsSlider('leaves.roughness', 'Roughness', 0, 1, 0.01, f2);
optsSlider('leaves.alphaTest', 'Alpha test', 0, 1, 0.01, f2);

renderer.setAnimationLoop(() => {
```

- [ ] **Step 2: Run the syntax check**. Expected: no output.

- [ ] **Step 3: Manually confirm Force/Bark/Leaves controls**

Reload the page. Confirm "Force" direction sliders visibly bend the tree's growth direction;
"Bark" color picker changes trunk/branch color; "Leaves" count/size/tint sliders visibly change
the canopy; toggling "Enabled" off removes all leaves.

- [ ] **Step 4: Commit**

```bash
git add tree-viewer.html
git commit -m "feat(tree-viewer): add Force, Bark, and Leaves panel sections"
```

---

### Task 7: Export section

**Files:**
- Modify: `workshop-webgpu/tree-viewer.html`

- [ ] **Step 1: Insert the Export section**

old_string:
```js
optsSlider('leaves.alphaTest', 'Alpha test', 0, 1, 0.01, f2);

renderer.setAnimationLoop(() => {
```

new_string:
```js
optsSlider('leaves.alphaTest', 'Alpha test', 0, 1, 0.01, f2);

// ===================== Export section =====================
header('Export');
const exportArea = document.createElement('textarea');
exportArea.readOnly = true;
current.appendChild(exportArea);
// `map`/`normalMap` hold live THREE.Texture objects in authored texture mode — not
// meaningfully JSON-serializable (and not useful as a reusable createTree() preset anyway),
// so the replacer omits them from the export rather than letting JSON.stringify choke on them.
refreshExport = () => {
  exportArea.value = JSON.stringify(opts, (key, val) => (key === 'map' || key === 'normalMap' ? undefined : val), 2);
};
buttonControl('Copy tree JSON', () => {
  refreshExport();
  navigator.clipboard?.writeText(exportArea.value).catch(() => {});
});
refreshExport();

renderer.setAnimationLoop(() => {
```

- [ ] **Step 2: Run the syntax check**. Expected: no output.

- [ ] **Step 3: Manually confirm Export**

Reload the page. Confirm the "Export" section's textarea shows the current tree's JSON options
and updates as sliders change (after the 130ms debounce). Click "Copy tree JSON" and paste
somewhere to confirm valid JSON was copied. Confirm pasting that JSON works as `createTree`
options by running, in the browser console:

```js
JSON.parse(document.querySelector('#ctrl textarea').value).levels
```

Expected: a number (the current Levels value), confirming the textarea contains valid,
round-trippable JSON.

- [ ] **Step 4: Commit**

```bash
git add tree-viewer.html
git commit -m "feat(tree-viewer): add Export section (copy tree JSON)"
```

---

### Task 8: Docs and activity log

**Files:**
- Modify: `workshop-webgpu/docs/subsystems/vegetation.md`
- Modify: `workshop-webgpu/agent_log.csv`

- [ ] **Step 1: Add a "Standalone tooling" section to vegetation.md**

Use Edit with this anchor (the last line of the file, from the Testing section's table):

old_string:
```
| `test-cdlod-morph.mjs` (relevant parts only) | Imports `grassHeightRef` from `grass-height-ref.js` to verify a CDLOD terrain-morph crack-free property: a fully-morphed fine-LOD edge vertex's height (via `grassHeightRef`) matches the coarser neighboring LOD's height at the same world position, within `1e-6`. The rest of the file (`morphGridCoord`, `nodeSize` from `cdlod-select.js`) is terrain LOD logic outside this subsystem; `grass-height-ref.js`'s only role here is as the shared height oracle used to prove no vertical crack. |
```

new_string:
```
| `test-cdlod-morph.mjs` (relevant parts only) | Imports `grassHeightRef` from `grass-height-ref.js` to verify a CDLOD terrain-morph crack-free property: a fully-morphed fine-LOD edge vertex's height (via `grassHeightRef`) matches the coarser neighboring LOD's height at the same world position, within `1e-6`. The rest of the file (`morphGridCoord`, `nodeSize` from `cdlod-select.js`) is terrain LOD logic outside this subsystem; `grass-height-ref.js`'s only role here is as the shared height oracle used to prove no vertical crack. |

## Standalone tooling

`tree-viewer.html` is a standalone single-file tuning tool for `trees.js`'s full procedural-tree
parameter surface (per-level branch structure, force, bark, leaves), with Solo/Grid view modes,
a procedural/authored texture toggle, and a "copy tree JSON" export. It imports `trees.js`
(`createTree`), `tree-textures.js` (`createTextureSource`), and `lights.js` (`createLightingRig`)
directly, with its own minimal `WebGPURenderer`/`OrbitControls` scene shell — it is **not**
wired into `environment-viewer.html` in any way, and `environment-viewer.html`'s own Forest panel
sliders are unaffected by it. Run via `python serve.py` like the main viewer (see the directory's
`CLAUDE.md`).
```

- [ ] **Step 2: Append one row to agent_log.csv**

Use Edit with this anchor (the header-only file's single line):

old_string:
```
date,subsystem,files,summary
```

new_string:
```
date,subsystem,files,summary
2026-06-30T00:00,vegetation,"tree-viewer.html;docs/subsystems/vegetation.md",Added standalone tree-viewer.html exposing trees.js's full parameter surface for live tuning outside the full environment viewer.
```

- [ ] **Step 3: Commit**

```bash
git add docs/subsystems/vegetation.md agent_log.csv
git commit -m "docs(vegetation): document tree-viewer.html standalone tool and log the change"
```

---

### Task 9: Final end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the server**

Run: `python serve.py 8090` (background if not already running from earlier tasks)

- [ ] **Step 2: Load the page and exercise every section**

Open `http://127.0.0.1:8090/tree-viewer.html` in a browser (or use the project's `run` skill to
drive it). Confirm, with no console errors at any point:

1. A tree renders on load, camera framed on it, orbit/zoom work, shadows visible on the ground.
2. Every section (View, Texture, Structure, Force, Bark, Leaves, Export) is present, collapsible,
   and its controls visibly affect the tree(s).
3. Switching to Grid mode, changing Grid size 2-5, and Reroll seed all work without errors.
4. Switching Texture mode to `authored` loads real bark/leaf textures (allow a moment for the
   network fetch); switching back to `procedural` removes them.
5. Setting `Levels` to 0 produces a trunk with no branches; setting it back to 3 restores them.
6. "Copy tree JSON" produces valid JSON matching the current panel state.

- [ ] **Step 3: Fix any issues found, then re-run the syntax check** (command from the top of
this plan) one final time to confirm the file is still syntactically valid after any fixes.

- [ ] **Step 4: If fixes were needed, commit them**

```bash
git add tree-viewer.html
git commit -m "fix(tree-viewer): address issues found in end-to-end verification"
```

(Skip this step if no fixes were needed.)
