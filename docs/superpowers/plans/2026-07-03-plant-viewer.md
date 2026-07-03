# Plant Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `plant-viewer.html`, a standalone single-file tuning tool for `plants.js`'s full
parameter surface, with a Family/Species save-breed-tag system, modeled directly on
`tree-viewer.html`.

**Architecture:** Same shape as `tree-viewer.html`: its own minimal `WebGPURenderer`/
`OrbitControls`/`lights.js` scene shell (no terrain/water/sky/grass/multiplayer/creature-sim, not
wired into `environment-viewer.html`), a live `opts` object shaped like `PLANT_DEFAULTS`, Solo/Grid
view modes, a floating-panel controls UI (duplicated inline from tree-viewer.html, not extracted
into a shared library), Mutate/Undo/Redo, and a Species tab with a Family → Species breeding/tagging
system persisted to `localStorage` and exportable to a new `plant-families/` directory via a new
`serve.py` endpoint.

**Tech Stack:** Three.js r0.184 (WebGPU backend, ES modules via CDN import map, same pins as
`tree-viewer.html`/`environment-viewer.html`), vanilla DOM (no framework), Python's
`http.server` (`serve.py`).

**Spec:** `docs/superpowers/specs/2026-07-03-plant-viewer-design.md`

**Commit policy for this plan:** per this session's standing instruction, do **not** run
`git commit` for any task below — the user wants one combined commit across this and other
in-flight work, done manually once everything is ready. Every task ends with a "stage nothing,
just leave the change in the working tree" note instead of a `git commit` step.

---

## Task 1: `serve.py` — add `/api/save-plant-family` endpoint

**Files:**
- Modify: `serve.py` (full file, currently 71 lines)

- [ ] **Step 1: Read the current file to confirm nothing has drifted**

Run: view `serve.py`. It should match the version quoted in the design spec — `FAMILIES_DIR`,
`MANIFEST_PATH`, `slugify()`, a `Handler` class with `do_POST` hardcoded to `/api/save-family`, and
`_send_json`. If it has drifted, re-read before proceeding — the replacement in Step 2 assumes this
exact starting shape.

- [ ] **Step 2: Replace the whole file**

Replace the entire contents of `serve.py` with:

```python
import http.server
import json
import os
import re
import sys


ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

FAMILIES_DIR = os.path.join(ROOT, 'families')
PLANT_FAMILIES_DIR = os.path.join(ROOT, 'plant-families')


def slugify(name):
    slug = re.sub(r'[^a-z0-9]+', '-', (name or '').strip().lower()).strip('-')
    return slug or 'family'


def save_family_to(payload, dir_path):
    filename = f"{slugify(payload.get('name'))}.json"
    os.makedirs(dir_path, exist_ok=True)
    with open(os.path.join(dir_path, filename), 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)

    manifest_path = os.path.join(dir_path, 'manifest.json')
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
        if not isinstance(manifest, list):
            manifest = []
    except (FileNotFoundError, json.JSONDecodeError):
        manifest = []
    if filename not in manifest:
        manifest.append(filename)
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2)
    return filename


class Handler(http.server.SimpleHTTPRequestHandler):
    # tree-viewer.html's "Export family JSON" POSTs to /api/save-family; plant-viewer.html's
    # equivalent POSTs to /api/save-plant-family. Both land straight in their own directory +
    # manifest.json without a manual download/move/edit round trip. Filename is derived
    # server-side via the same slug rule the client uses, so it can never escape the target dir.
    ROUTES = {
        '/api/save-family': FAMILIES_DIR,
        '/api/save-plant-family': PLANT_FAMILIES_DIR,
    }

    def do_POST(self):
        dir_path = self.ROUTES.get(self.path)
        if dir_path is None:
            self.send_error(404)
            return
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 5_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            filename = save_family_to(payload, dir_path)
            self._send_json({'ok': True, 'filename': filename})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    def _send_json(self, payload, status=200):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


http.server.test(
    HandlerClass=Handler,
    port=port,
    bind="127.0.0.1",
)
```

- [ ] **Step 3: Syntax-check**

Run: `python -c "import ast; ast.parse(open('serve.py').read())"`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual smoke test — both endpoints, in the background**

```bash
python serve.py 8091 & echo $! > serve.pid
sleep 1
curl -s -X POST http://127.0.0.1:8091/api/save-family -d '{"name":"zz-smoke-test","species":[]}'
echo
curl -s -X POST http://127.0.0.1:8091/api/save-plant-family -d '{"name":"zz-smoke-test","species":[]}'
echo
kill $(cat serve.pid)
rm serve.pid
```

Expected: both `curl` calls print `{"ok": true, "filename": "zz-smoke-test.json"}`. After this,
`families/zz-smoke-test.json` and `plant-families/zz-smoke-test.json` both exist, and
`families/manifest.json` / `plant-families/manifest.json` both list `"zz-smoke-test.json"`.

- [ ] **Step 5: Clean up the smoke-test artifacts**

```bash
rm -f families/zz-smoke-test.json plant-families/zz-smoke-test.json
node -e "const fs=require('fs');for(const f of ['families/manifest.json','plant-families/manifest.json']){const m=JSON.parse(fs.readFileSync(f));fs.writeFileSync(f, JSON.stringify(m.filter(x=>x!=='zz-smoke-test.json'), null, 2)+'\n');}"
```

Run `git status` afterward and confirm `families/manifest.json` is unchanged from its state before
Step 4 (i.e. the smoke test left no trace there), and that `plant-families/` is either absent or
contains only what step 4 legitimately created and step 5 then removed — it's fine if the now-empty
`plant-families/` directory itself remains (git doesn't track empty directories, so there's nothing
to clean up further).

- [ ] **Step 6: Leave in working tree (no commit)**

Per this plan's commit policy, do not run `git add` or `git commit`. Move to Task 2.

---

## Task 2: `plant-viewer.html` — scene shell

**Files:**
- Create: `plant-viewer.html`

- [ ] **Step 1: Write the file**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plant Viewer</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #1a1d23; }
  #info { position: fixed; top: 10px; left: 12px; color: #8a93a3;
    font: 12px/1.5 system-ui, sans-serif; user-select: none; pointer-events: none;
    max-width: calc(100vw - 280px); z-index: 5; }
</style>
</head>
<body>
<div id="info">drag&nbsp;orbit &middot; scroll&nbsp;zoom &mdash; standalone procedural plant tuning tool</div>

<!-- three@0.184.0: same CDN pins as tree-viewer.html/environment-viewer.html -->
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
import { PLANT_DEFAULTS, PLANT_PRESETS, PLANT_BIOME_TAGS, mergePlantOpts, buildPlantGeometry } from './plants.js';

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

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(3, 2, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.3, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

// ===================== lighting =====================
const rig = createLightingRig({ scene, ui: false, elevation: 66, azimuth: 9 });
rig.dirLight.castShadow = true;
scene.add(rig.dirLight.target);
rig.dirLight.shadow.mapSize.set(2048, 2048);
rig.dirLight.shadow.camera.near = 0.1; rig.dirLight.shadow.camera.far = 40;
rig.dirLight.shadow.camera.left = -10; rig.dirLight.shadow.camera.right = 10;
rig.dirLight.shadow.camera.top = 10; rig.dirLight.shadow.camera.bottom = -10;

// ===================== ground =====================
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
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

- [ ] **Step 2: Syntax-check the inline script**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: `node --check` prints nothing and exits 0. (This checks syntax only — `import` targets
aren't resolved by `--check`, so this passes even though later tasks haven't added the plant-viewer
UI code that actually uses `PLANT_DEFAULTS` etc. yet; an unused-import warning is not a syntax
error.)

- [ ] **Step 3: Manual visual smoke test**

Run `python serve.py 8080` (or reuse a server you already have running for the main viewer, on a
different port), open `http://127.0.0.1:8080/plant-viewer.html`. Expected: a dark scene with a flat
green-gray ground plane, orbit/zoom working, no error banner in the top-left. This confirms the
scene shell works before any plant-specific code is added — if this environment has no real WebGPU
adapter available (headless/CI), note that explicitly rather than claiming the render was verified.

This step's verification is repeated at the end of Task 12 once the full tool is built — no need to
leave the server running between tasks.

- [ ] **Step 4: Leave in working tree (no commit)**

Move to Task 3.

---

## Task 3: Plant data model — opts, Solo/Grid build, camera fit

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert the data-model block before the render loop**

Find this exact block (the last thing in the `<script type="module">` from Task 2):

```js
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

Insert the following code immediately **before** it (i.e. between the resize handler added in
Task 2 and this block):

```js
// ===================== plant data model =====================
// plants.js has no constructor object to borrow the merged opts shape from (unlike trees.js's
// Tree class, which tree-viewer.html reads `.options` off of) -- a structuredClone of
// PLANT_DEFAULTS is the direct equivalent.
const opts = structuredClone(PLANT_DEFAULTS);
const DEFAULT_OPTS = structuredClone(opts);

let mode = 'solo';        // 'solo' | 'grid'
let gridSize = 3;
let baseSeed = opts.seed;

let soloPlant = null;
let gridPlants = [];
let refreshExport = () => {};   // reassigned once the Export section builds its textarea (Task 10)

// buildPlantGeometry bakes vertex colors directly into the geometry, so unlike trees.js there is
// no separate "materials built once, only geometry regenerates" distinction to preserve -- every
// opts change disposes the old geometry and builds a new one against this single shared material.
const plantMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });

function disposePlant(p) { scene.remove(p); p.geometry.dispose(); }

function makePlant(plantOpts) {
  const geom = buildPlantGeometry(plantOpts);
  const mesh = new THREE.Mesh(geom, plantMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
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
function fitCameraTo(object3d) { fitCameraToBox(new THREE.Box3().setFromObject(object3d), 2.4, 1.2); }
function fitCameraToGrid() {
  const box = new THREE.Box3();
  for (const p of gridPlants) box.expandByObject(p);
  fitCameraToBox(box, 1.8, 2);
}

function buildSolo() {
  soloPlant = makePlant(opts);
  scene.add(soloPlant);
  fitCameraTo(soloPlant);
}
function regenerateSolo(refit) {
  if (soloPlant) disposePlant(soloPlant);
  soloPlant = makePlant(opts);
  scene.add(soloPlant);
  if (refit) fitCameraTo(soloPlant);
}
function buildGrid() {
  for (const p of gridPlants) disposePlant(p);
  gridPlants = [];
  // Measure one throwaway instance to size grid spacing to the current plant's own scale --
  // plants are ~10-50x smaller than trees, so tree-viewer's `opts.length[0] * 2.5` formula
  // doesn't apply; disposed immediately, never added to the scene.
  const probe = makePlant(opts);
  const bounds = new THREE.Box3().setFromObject(probe);
  probe.geometry.dispose();
  const extent = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) || 1;
  const spacing = Math.max(1.5, extent * 3);
  const half = (gridSize - 1) / 2;
  for (let i = 0; i < gridSize * gridSize; i++) {
    const p = makePlant({ ...opts, seed: baseSeed + i });
    p.position.set(((i % gridSize) - half) * spacing, 0, (Math.floor(i / gridSize) - half) * spacing);
    scene.add(p);
    gridPlants.push(p);
  }
  fitCameraToGrid();
}
function disposeCurrent() {
  if (soloPlant) { disposePlant(soloPlant); soloPlant = null; }
  for (const p of gridPlants) disposePlant(p);
  gridPlants = [];
}
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

rebuildView();

```

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Manual visual smoke test**

Reload `plant-viewer.html` in the browser (server from Task 2 Step 3, or a fresh `python serve.py`).
Expected: a single small plant (the `PLANT_DEFAULTS` shape — a plain oval-leaved, opposite-arranged,
unflowered stem) renders near the world origin, camera auto-framed on it, no error banner. If this
environment can't render WebGPU, state that explicitly instead of claiming this was verified.

- [ ] **Step 4: Leave in working tree (no commit)**

Move to Task 4.

---

## Task 4: Controls panel shell — floating panel manager, control primitives

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert the controls-shell block before the render loop**

Find the same anchor as Task 3 (the `renderer.setAnimationLoop(...)` block — it is always the last
thing in the script, since every task inserts immediately before it). Insert the following
immediately before it, after the code Task 3 just added:

```js
// ===================== controls panel =====================
const panelStyle = document.createElement('style');
panelStyle.textContent = '#ctrl{position:fixed;top:10px;right:10px;width:250px;background:rgba(20,24,30,.86);border:1px solid #333a45;border-radius:8px;color:#c4ccd6;font:12px/1.45 system-ui,sans-serif;user-select:none;z-index:20}#ctrl-bar{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;cursor:move;border-bottom:1px solid #333a45}#ctrl-bar .ttl{font-size:12px;color:#8a93a3;font-weight:600}#ctrl-min{background:none;border:none;color:#8a93a3;font:16px/1 system-ui,sans-serif;cursor:pointer;padding:0 2px}#ctrl-min:hover{color:#c4ccd6}#ctrl-body{padding:2px 12px 10px;max-height:min(82vh,760px);overflow-y:auto}#ctrl.min #ctrl-body{display:none}#ctrl.min #ctrl-bar{border-bottom:none}#ctrl .sec-head{display:flex;justify-content:space-between;align-items:center;cursor:pointer;margin:10px 0 4px;color:#8a93a3}#ctrl .sec-head .caret{font-size:10px;transition:transform .15s}#ctrl .sec.collapsed .caret{transform:rotate(-90deg)}#ctrl .sec.collapsed .sec-body{display:none}#ctrl-tabs{display:flex;gap:2px;padding:8px 12px 0}#ctrl-tabs button{width:auto;flex:1;margin:0;font-weight:600;background:#1c2027;color:#7f8a99}#ctrl-tabs button.active{background:#2a313c;color:#c4ccd6}#ctrl .row,.float-panel .row,#mut .row{margin:7px 0 1px;display:flex;justify-content:space-between}#ctrl .row span,.float-panel .row span,#mut .row span{color:#7f8a99}#ctrl input[type=range],.float-panel input[type=range],#mut input[type=range]{width:100%;margin:0}#ctrl input[type=color],.float-panel input[type=color],#mut input[type=color]{width:100%;height:20px;border:none;background:none;padding:0;cursor:pointer}#ctrl select,.float-panel select,#mut select{width:100%;background:#222831;color:#c4ccd6;border:1px solid #3a434f;border-radius:4px;padding:3px}#ctrl button,.float-panel button,#mut button{width:100%;background:#2a313c;color:#c4ccd6;border:1px solid #3a434f;border-radius:4px;padding:5px;cursor:pointer;margin:4px 0}#ctrl button:hover,.float-panel button:hover,#mut button:hover{background:#333c49}#ctrl button:disabled,.float-panel button:disabled,#mut button:disabled{opacity:.4;cursor:default}#ctrl button.mini-btn,.float-panel button.mini-btn{width:auto;display:inline-block;font-size:11px;padding:2px 8px;margin:4px 0 2px}#ctrl textarea,.float-panel textarea,#mut textarea{width:100%;height:90px;background:#15181d;color:#9fe39f;border:1px solid #3a434f;border-radius:4px;font:11px/1.4 monospace;resize:vertical}.sec-row{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:6px 0}.sec-row .sec-label{color:#c4ccd6;cursor:pointer;flex:1}.sec-row .sec-label:hover{color:#fff}.float-panel{position:fixed;width:230px;background:rgba(20,24,30,.86);border:1px solid #333a45;border-radius:8px;color:#c4ccd6;font:12px/1.45 system-ui,sans-serif;user-select:none;z-index:25}.float-panel .fp-bar{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;cursor:move;border-bottom:1px solid #333a45;font-size:12px;color:#8a93a3;font-weight:600}.float-panel .fp-close{background:none;border:none;color:#8a93a3;font:16px/1 system-ui,sans-serif;cursor:pointer;padding:0 2px}.float-panel .fp-close:hover{color:#c4ccd6}.float-panel .fp-body{padding:8px 12px 10px;max-height:70vh;overflow-y:auto}#mut{position:fixed;width:250px;background:rgba(20,24,30,.86);border:1px solid #333a45;border-radius:8px;color:#c4ccd6;font:12px/1.45 system-ui,sans-serif;user-select:none;z-index:20}#mut-bar{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;cursor:move;border-bottom:1px solid #333a45;font-size:12px;color:#8a93a3;font-weight:600}#mut-body{padding:8px 12px 10px}';
document.head.appendChild(panelStyle);

const ctrlBox = document.createElement('div'); ctrlBox.id = 'ctrl'; document.body.appendChild(ctrlBox);
const ctrlBar = document.createElement('div'); ctrlBar.id = 'ctrl-bar';
ctrlBar.innerHTML = '<span class="ttl">Plant controls</span>';
const ctrlMin = document.createElement('button'); ctrlMin.id = 'ctrl-min'; ctrlMin.textContent = '–';
ctrlBar.appendChild(ctrlMin);
const ctrlBody = document.createElement('div'); ctrlBody.id = 'ctrl-body';
ctrlBox.appendChild(ctrlBar); ctrlBox.appendChild(ctrlBody);

const ctrlTabs = document.createElement('div'); ctrlTabs.id = 'ctrl-tabs'; ctrlBox.insertBefore(ctrlTabs, ctrlBody);
const tuningTabBtn = document.createElement('button'); tuningTabBtn.textContent = 'Tuning'; tuningTabBtn.className = 'active';
const speciesTabBtn = document.createElement('button'); speciesTabBtn.textContent = 'Species';
ctrlTabs.appendChild(tuningTabBtn); ctrlTabs.appendChild(speciesTabBtn);

const tuningPage = document.createElement('div');
const speciesPage = document.createElement('div'); speciesPage.style.display = 'none';
ctrlBody.appendChild(tuningPage); ctrlBody.appendChild(speciesPage);

function activateTab(name) {
  const tuning = name === 'tuning';
  tuningPage.style.display = tuning ? '' : 'none';
  speciesPage.style.display = tuning ? 'none' : '';
  tuningTabBtn.classList.toggle('active', tuning);
  speciesTabBtn.classList.toggle('active', !tuning);
}
tuningTabBtn.addEventListener('click', () => activateTab('tuning'));
speciesTabBtn.addEventListener('click', () => activateTab('species'));

let sectionHost = tuningPage;
let current = tuningPage;

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

function header(text) {
  const sec = document.createElement('div'); sec.className = 'sec';
  const head = document.createElement('div'); head.className = 'sec-head';
  head.innerHTML = '<span>' + text + '</span><span class="caret">▾</span>';
  const secBody = document.createElement('div'); secBody.className = 'sec-body';
  head.addEventListener('click', () => sec.classList.toggle('collapsed'));
  sec.appendChild(head); sec.appendChild(secBody); sectionHost.appendChild(sec);
  current = secBody;
  return secBody;
}
function withHost(hostEl, fn) { const prev = current; current = hostEl; fn(); current = prev; }

// ===================== floating panel manager =====================
const FP_WIDTH = 230, FP_GAP = 10;
const floatingPanels = new Map();

function createFloatingPanel(id, title, parentId) {
  const el = document.createElement('div'); el.className = 'float-panel'; el.style.display = 'none';
  const bar = document.createElement('div'); bar.className = 'fp-bar';
  bar.innerHTML = '<span>' + title + '</span>';
  const closeBtn = document.createElement('button'); closeBtn.className = 'fp-close'; closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => closeFloatingPanel(id));
  bar.appendChild(closeBtn);
  const body = document.createElement('div'); body.className = 'fp-body';
  el.appendChild(bar); el.appendChild(body);
  document.body.appendChild(el);

  let drag = null;
  bar.addEventListener('pointerdown', e => {
    if (e.target === closeBtn) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', e => {
    if (!drag) return;
    const fp = floatingPanels.get(id);
    fp.x = e.clientX - drag.dx; fp.y = e.clientY - drag.dy;
    el.style.left = fp.x + 'px'; el.style.top = fp.y + 'px';
  });
  bar.addEventListener('pointerup', e => { drag = null; bar.releasePointerCapture(e.pointerId); });

  const fp = { id, el, body, x: null, y: null, opened: false, parentId };
  floatingPanels.set(id, fp);
  return fp;
}

function positionNewPanel(fp, anchorEl) {
  const anchorRect = anchorEl.getBoundingClientRect();
  let x = anchorRect.left - FP_WIDTH - FP_GAP;
  let y = anchorRect.top;

  fp.el.style.visibility = 'hidden';
  fp.el.style.left = x + 'px'; fp.el.style.top = y + 'px';
  const height = fp.el.offsetHeight || 150;

  const colliders = [...floatingPanels.values()]
    .filter(o => o !== fp && o.opened && o.x != null && Math.abs(o.x - x) < FP_WIDTH)
    .sort((a, b) => a.y - b.y);
  for (const o of colliders) {
    const oBottom = o.y + (o.el.offsetHeight || 150);
    if (y < oBottom && y + height > o.y) y = oBottom + FP_GAP;
  }

  const maxY = window.innerHeight - height - FP_GAP;
  y = Math.max(FP_GAP, Math.min(maxY, y));
  x = Math.max(FP_GAP, x);
  fp.x = x; fp.y = y;
  fp.el.style.visibility = 'visible';
}

function openFloatingPanel(id, anchorEl) {
  const fp = floatingPanels.get(id);
  if (fp.opened) return;
  fp.opened = true;
  fp.el.style.display = 'block';
  if (fp.x == null) positionNewPanel(fp, anchorEl);
  fp.el.style.left = fp.x + 'px'; fp.el.style.top = fp.y + 'px';
}
function closeFloatingPanel(id) {
  const fp = floatingPanels.get(id);
  if (!fp || !fp.opened) return;
  fp.opened = false;
  fp.el.style.display = 'none';
  for (const child of floatingPanels.values()) if (child.parentId === id) closeFloatingPanel(child.id);
}
function toggleFloatingPanel(id, anchorEl) {
  const fp = floatingPanels.get(id);
  if (fp.opened) closeFloatingPanel(id); else openFloatingPanel(id, anchorEl);
}

function panelSection(id, label, mutateFn, parentContainer = tuningPage, parentId = null) {
  const anchorEl = parentId ? floatingPanels.get(parentId).el : ctrlBox;
  const fp = createFloatingPanel(id, label, parentId);

  const rowEl = document.createElement('div'); rowEl.className = 'sec-row';
  const labelSpan = document.createElement('span'); labelSpan.className = 'sec-label'; labelSpan.textContent = label;
  labelSpan.addEventListener('click', () => toggleFloatingPanel(id, anchorEl));
  rowEl.appendChild(labelSpan);
  if (mutateFn) {
    const mutateBtn = document.createElement('button'); mutateBtn.className = 'mini-btn'; mutateBtn.textContent = 'Mutate';
    mutateBtn.addEventListener('click', () => mutateFn());
    rowEl.appendChild(mutateBtn);
  }
  parentContainer.appendChild(rowEl);

  current = fp.body;
  return fp.body;
}

let allControls = [];
function refreshAllControls() {
  allControls = allControls.filter(c => c.el.isConnected);
  for (const c of allControls) c.refresh();
}

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
  allControls.push({ el: inp, refresh: () => { inp.value = get(); val.textContent = fmt(get()); } });
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
  allControls.push({ el: sel, refresh: () => { sel.value = get(); } });
  return sel;
}
function toggleControl(label, get, set, onChange) {
  const r = row('<span style="color:#c4ccd6">' + label + '</span>');
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!get(); inp.style.width = 'auto';
  inp.addEventListener('change', () => { set(inp.checked); onChange(); });
  r.appendChild(inp);
  allControls.push({ el: inp, refresh: () => { inp.checked = !!get(); } });
  return inp;
}
function colorControl(label, get, set, onChange) {
  row('<span style="color:#c4ccd6">' + label + '</span>');
  const inp = document.createElement('input'); inp.type = 'color';
  inp.value = '#' + get().toString(16).padStart(6, '0');
  inp.addEventListener('input', () => { set(parseInt(inp.value.slice(1), 16)); onChange(); });
  current.appendChild(inp);
  allControls.push({ el: inp, refresh: () => { inp.value = '#' + get().toString(16).padStart(6, '0'); } });
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

```

Note: `getPath`/`setPath` work unchanged for `[min, max]`-shaped array fields (`stem.nodes`,
`stem.nodeSpacing`, `leaf.size`) — `'stem.nodes.0'.split('.')` yields `['stem', 'nodes', '0']`, and
`obj['0']` on a JS array is a valid index access, so no new control primitive is needed for those
fields in later tasks.

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Leave in working tree (no commit)**

Move to Task 5. (No visual smoke test this task — the panel shell has no sections registered yet,
so nothing new is visible until Task 5 adds the first `panelSection` calls.)

---

## Task 5: View + Lighting sections

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert before the render loop**

```js
// ===================== View / Lighting sections =====================
panelSection('view', 'View', null);
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
  pushUndo();
  if (mode === 'solo') opts.seed = (Math.random() * 1e9) | 0;
  else baseSeed = (Math.random() * 1e9) | 0;
  refreshSeedLabel();
  rebuildView();
});

panelSection('lighting', 'Lighting', null);
let sunColor = '#fff4e0', sunIntensity = 4, ambientColor = '#8ab4e8', ambientIntensity = 1.05;
rangeControl('Elevation', 2, 88, 1, () => rig.elevation, v => rig.setElevation(v), fi, () => {});
rangeControl('Azimuth', 0, 360, 1, () => rig.azimuth, v => rig.setAzimuth(v), fi, () => {});
rangeControl('Sun intensity', 0, 4, 0.05, () => sunIntensity, v => { sunIntensity = v; rig.setSunIntensity(v); }, f2, () => {});
rangeControl('Ambient intensity', 0, 2, 0.05, () => ambientIntensity, v => { ambientIntensity = v; rig.setAmbientIntensity(v); }, f2, () => {});
colorControl('Sun color', () => parseInt(sunColor.slice(1), 16), v => { sunColor = '#' + v.toString(16).padStart(6, '0'); rig.setSunColor(sunColor); }, () => {});
colorControl('Ambient color', () => parseInt(ambientColor.slice(1), 16), v => { ambientColor = '#' + v.toString(16).padStart(6, '0'); rig.setAmbientColor(ambientColor); }, () => {});

```

Note: `pushUndo` (used by "Reroll seed") is not defined until Task 6. This is safe — it's a plain
`function pushUndo() {...}` declaration, hoisted to the top of the module, and it's only ever
*called* from inside a `click` handler, which can't fire until the whole module (including Task 6's
code) has finished its first synchronous pass. Every other forward-reference in this plan
(`loadOpts`, `stemMutateList`, etc.) relies on the same guarantee.

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Leave in working tree (no commit)**

Move to Task 6.

---

## Task 6: Mutation dock — mutate lists, Undo/Redo, Restart

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert before the render loop**

```js
// ===================== Mutation panel (docked, separate from the tabbed panel) =====================
const mutBox = document.createElement('div'); mutBox.id = 'mut'; document.body.appendChild(mutBox);
const mutBar = document.createElement('div'); mutBar.id = 'mut-bar';
mutBar.innerHTML = '<span class="ttl">Mutation</span>';
const mutBody = document.createElement('div'); mutBody.id = 'mut-body';
mutBox.appendChild(mutBar); mutBox.appendChild(mutBody);
function positionMutBoxInitial() {
  const r = ctrlBox.getBoundingClientRect();
  mutBox.style.left = r.left + 'px';
  mutBox.style.top = (r.bottom + 10) + 'px';
}
let mutDrag = null;
mutBar.addEventListener('pointerdown', e => {
  const r = mutBox.getBoundingClientRect();
  mutDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  mutBar.setPointerCapture(e.pointerId);
});
mutBar.addEventListener('pointermove', e => {
  if (!mutDrag) return;
  mutBox.style.left = Math.max(10, e.clientX - mutDrag.dx) + 'px';
  mutBox.style.top = Math.max(10, e.clientY - mutDrag.dy) + 'px';
});
mutBar.addEventListener('pointerup', e => { mutDrag = null; mutBar.releasePointerCapture(e.pointerId); });

current = mutBody;
let mutationDegree = 0.2;
rangeControl('Mutation degree', 0, 1, 0.01, () => mutationDegree, v => { mutationDegree = v; }, pct, () => {});

function optsMutateEntry(path, min, max) {
  return { min, max, get: () => getPath(opts, path), set: v => setPath(opts, path, v) };
}
function mutateParams(list) {
  for (const p of list) {
    const range = p.max - p.min;
    const delta = (Math.random() * 2 - 1) * mutationDegree * range;
    p.set(Math.max(p.min, Math.min(p.max, p.get() + delta)));
  }
}
function mutateSection(list) {
  pushUndo();
  mutateParams(list);
  refreshAllControls();
  rebuildView();
}

// Mutate-list definitions live here (not inside each trait's own section below) so they're all
// in one place, matching tree-viewer.html's own layout -- Stem/Leaf/Flower's row-level "Mutate"
// buttons (Tasks 7-9) and "Mutate all" below just call these.
function stemMutateList() {
  return [
    optsMutateEntry('stem.nodes.0', 1, 12),
    optsMutateEntry('stem.nodes.1', 1, 12),
    optsMutateEntry('stem.nodeSpacing.0', 4, 40),
    optsMutateEntry('stem.nodeSpacing.1', 4, 40),
    optsMutateEntry('stem.branchProb', 0, 1),
    optsMutateEntry('stem.sprawl', 0, 1),
  ];
}
function leafMutateList() {
  return [
    optsMutateEntry('leaf.leafletCount', 1, 12),
    optsMutateEntry('leaf.whorlCount', 1, 12),
    optsMutateEntry('leaf.serration.teeth', 0, 12),
    optsMutateEntry('leaf.serration.depth', 0, 1),
    optsMutateEntry('leaf.variegation.amount', 0, 1),
    optsMutateEntry('leaf.size.0', 3, 30),
    optsMutateEntry('leaf.size.1', 3, 30),
  ];
}
function flowerMutateList() {
  return [
    optsMutateEntry('flower.petals', 1, 16),
    optsMutateEntry('flower.frequency', 0, 1),
  ];
}

buttonControl('Mutate all', () => mutateSection([
  ...stemMutateList(), ...leafMutateList(), ...flowerMutateList(),
]));

// ---- undo / redo / restart ----
const UNDO_LIMIT = 15;
let undoStack = [];
let redoStack = [];
function snapshotState() { return { opts: snapshotOpts(), mode, gridSize, baseSeed }; }
function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
  updateUndoRedoButtons();
}
function applyOptsAndRefresh() {
  refreshAllControls();
  refreshSeedLabel();
  rebuildView();
}
function restoreState(state) {
  for (const k of Object.keys(opts)) delete opts[k];
  Object.assign(opts, structuredClone(state.opts));
  mode = state.mode; gridSize = state.gridSize; baseSeed = state.baseSeed;
  gridSizeWrap.style.display = mode === 'grid' ? '' : 'none';
  applyOptsAndRefresh();
}
function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(snapshotState());
  if (redoStack.length > UNDO_LIMIT) redoStack.shift();
  restoreState(undoStack.pop());
  updateUndoRedoButtons();
}
function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  restoreState(redoStack.pop());
  updateUndoRedoButtons();
}
let undoBtn, redoBtn;
const undoRedoRow = document.createElement('div'); undoRedoRow.style.cssText = 'display:flex;gap:6px';
current.appendChild(undoRedoRow);
withHost(undoRedoRow, () => { undoBtn = buttonControl('Undo', undo); redoBtn = buttonControl('Redo', redo); });
undoBtn.style.width = redoBtn.style.width = 'auto'; undoBtn.style.flex = redoBtn.style.flex = '1';
function updateUndoRedoButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}
updateUndoRedoButtons();

buttonControl('Restart', () => loadOpts(DEFAULT_OPTS));

current = tuningPage; // restore before Stem/Leaf/Flower/Export sections continue building below

```

`snapshotOpts` and `loadOpts` aren't defined until Task 11 (Species tab) — safe for the same
hoisting reason noted in Task 5.

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Leave in working tree (no commit)**

Move to Task 7.

---

## Task 7: Stem section

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert before the render loop**

```js
// ===================== Stem section =====================
panelSection('stem', 'Stem', () => mutateSection(stemMutateList()));
optsSlider('stem.nodes.0', 'Nodes min', 1, 12, 1, fi);
optsSlider('stem.nodes.1', 'Nodes max', 1, 12, 1, fi);
optsSlider('stem.nodeSpacing.0', 'Spacing min', 4, 40, 1, fi);
optsSlider('stem.nodeSpacing.1', 'Spacing max', 4, 40, 1, fi);
optsSlider('stem.branchProb', 'Branch probability', 0, 1, 0.01, pct);
optsSlider('stem.sprawl', 'Sprawl', 0, 1, 0.01, pct);

```

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Manual visual smoke test**

Reload `plant-viewer.html`. Expected: "Plant controls" panel visible top-right with View/Lighting/
Stem row labels; clicking "Stem" opens a floating panel with 6 sliders; dragging "Nodes max" changes
the rendered plant's stem length after a short debounce; "Mutation" panel visible docked below the
main panel with a working Mutate-all/Undo/Redo/Restart (Stem's own row-level Mutate button also
works, jittering just the stem sliders).

- [ ] **Step 4: Leave in working tree (no commit)**

Move to Task 8.

---

## Task 8: Leaf section

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert before the render loop**

```js
// ===================== Leaf section =====================
panelSection('leaf', 'Leaf', () => mutateSection(leafMutateList()));
optsSelect('leaf.shape', 'Shape', ['oval', 'lance', 'star']);
optsSelect('leaf.style', 'Style', ['simple', 'complex']);
optsSlider('leaf.leafletCount', 'Leaflet count (complex only)', 1, 12, 1, fi);
optsSelect('leaf.leafletParity', 'Leaflet parity (complex only)', ['odd', 'even']);
optsSelect('leaf.arrangement', 'Arrangement', ['alternate', 'opposite', 'whorl']);
optsSlider('leaf.whorlCount', 'Whorl count (whorl only)', 1, 12, 1, fi);
optsSlider('leaf.serration.teeth', 'Serration teeth', 0, 12, 1, fi);
optsSlider('leaf.serration.depth', 'Serration depth', 0, 1, 0.01, pct);
optsToggle('leaf.variegation.enabled', 'Variegation enabled');
optsSelect('leaf.variegation.pattern', 'Variegation pattern', ['edge', 'vein', 'blotch']);
optsColor('leaf.variegation.color', 'Variegation color');
optsSlider('leaf.variegation.amount', 'Variegation amount', 0, 1, 0.01, pct);
optsSlider('leaf.size.0', 'Size min', 3, 30, 0.5, f2);
optsSlider('leaf.size.1', 'Size max', 3, 30, 0.5, f2);
optsColor('leaf.color', 'Color');

// leaf.veinColor is nullable (null = no visible midrib) -- a plain colorControl can't represent
// that, so an "enable" toggle gates it, remembering the last picked color across on/off so it
// isn't lost while disabled (same pattern tree-viewer.html uses for its leaf-atlas cell pin).
let veinColorValue = opts.leaf.veinColor ?? 0x2a4d20;
toggleControl('Enable vein color', () => opts.leaf.veinColor != null, v => {
  opts.leaf.veinColor = v ? veinColorValue : null;
}, () => scheduleRegenerate());
colorControl('Vein color', () => veinColorValue, v => {
  veinColorValue = v;
  if (opts.leaf.veinColor != null) opts.leaf.veinColor = v;
}, () => scheduleRegenerate());

```

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Manual visual smoke test**

Reload. Open the "Leaf" panel. Expected: changing Shape/Style/Arrangement visibly changes leaf
geometry; toggling "Enable vein color" on and setting a contrasting color shows a visible midrib
line on each leaf; toggling it off removes the vein but the color picker keeps its last value;
setting Style to `complex` and adjusting Leaflet count/parity produces a compound leaf.

- [ ] **Step 4: Leave in working tree (no commit)**

Move to Task 9.

---

## Task 9: Flower section

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert before the render loop**

```js
// ===================== Flower section =====================
panelSection('flower', 'Flower', () => mutateSection(flowerMutateList()));
optsToggle('flower.enabled', 'Enabled');
optsSelect('flower.shape', 'Shape', ['star', 'whorlBall', 'pouch', 'burPair']);
optsSlider('flower.petals', 'Petals', 1, 16, 1, fi);
optsSlider('flower.frequency', 'Frequency', 0, 1, 0.01, pct);
optsColor('flower.color', 'Color');

// Same null-gated pattern as leaf.veinColor above -- flower.throatColor is nullable.
let throatColorValue = opts.flower.throatColor ?? 0xffe0b0;
toggleControl('Enable throat color', () => opts.flower.throatColor != null, v => {
  opts.flower.throatColor = v ? throatColorValue : null;
}, () => scheduleRegenerate());
colorControl('Throat color', () => throatColorValue, v => {
  throatColorValue = v;
  if (opts.flower.throatColor != null) opts.flower.throatColor = v;
}, () => scheduleRegenerate());

```

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Manual visual smoke test**

Reload. Open "Flower", toggle Enabled on, try each Shape. Expected: a `star` cluster is visible near
the top of the stem; `pouch` gives one asymmetric bloom per eligible node; increasing Frequency
increases how many upper-stem nodes bloom.

- [ ] **Step 4: Leave in working tree (no commit)**

Move to Task 10.

---

## Task 10: Export section

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert before the render loop**

```js
// ===================== Export section =====================
panelSection('export', 'Export', null);
const exportArea = document.createElement('textarea');
exportArea.readOnly = true;
current.appendChild(exportArea);
// Plant opts never hold live Texture objects (unlike tree opts' bark.map/leaves.map), so unlike
// tree-viewer.html's exporter this needs no JSON.stringify replacer.
refreshExport = () => {
  exportArea.value = JSON.stringify(opts, null, 2);
};
buttonControl('Copy plant JSON', () => {
  refreshExport();
  navigator.clipboard?.writeText(exportArea.value).catch(() => {});
});
refreshExport();

```

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Manual visual smoke test**

Reload. Open "Export". Expected: textarea shows the current `opts` as pretty-printed JSON; clicking
"Copy plant JSON" doesn't throw (clipboard write may silently no-op in some browser/permission
contexts — that's fine, the `.catch(() => {})` is intentional); editing any Tuning-tab slider
updates the textarea content within ~130ms.

- [ ] **Step 4: Leave in working tree (no commit)**

Move to Task 11.

---

## Task 11: Species tab, part 1 — families, first-launch seeding, Family panel

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert before the render loop**

```js
// ===================== Species tab: families, species, biome/density/size =====================
const BIOME_NAMES = [
  'deep_ocean', 'ocean', 'beach', 'desert', 'badlands', 'savanna', 'plains', 'forest',
  'dark_forest', 'jungle', 'swamp', 'taiga', 'snowy_taiga', 'snowy_plains', 'stony_peaks',
  'snowy_peaks', 'windswept_hills', 'meadow',
];
const FAMILIES_KEY = 'plant-viewer:families';
function newId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function snapshotOpts() {
  return JSON.parse(JSON.stringify(opts));
}

// First-launch seeding: localStorage.getItem returns null only when the key has never been set
// (as opposed to '[]', which means the user deliberately cleared everything) -- so this only ever
// runs once, on a genuinely fresh install. Unlike tree-viewer.html there's no prior save format
// to migrate from, but there IS ready-made starting data (PLANT_PRESETS), so seed a starter
// family instead of starting empty.
const rawFamilies = localStorage.getItem(FAMILIES_KEY);
let families;
if (rawFamilies == null) {
  const starterKeys = Object.keys(PLANT_PRESETS);
  families = [{
    id: newId(), name: 'Wildflowers',
    species: starterKeys.map((key, i) => ({
      id: newId(), name: key,
      // Seed formula matches createPlantPalette's own convention in plants.js.
      opts: { ...mergePlantOpts(PLANT_DEFAULTS, PLANT_PRESETS[key]), seed: 1 + i * 977 },
      parentSpeciesId: null,
      biomes: [...PLANT_BIOME_TAGS[key].biomes],
      density: PLANT_BIOME_TAGS[key].density,
      sizeRange: [0.85, 1.15],
    })),
  }];
} else {
  try { families = JSON.parse(rawFamilies); } catch { families = []; }
  if (!Array.isArray(families)) families = [];
}
function persistFamilies() { localStorage.setItem(FAMILIES_KEY, JSON.stringify(families)); }
function familyById(id) { return families.find(f => f.id === id); }

let currentFamilyId = families[0]?.id ?? null;
let currentSpeciesId = null;

// Fully replaces `opts`'s contents in place (never reassigns the `opts` binding) so every closure
// holding a reference to `opts` keeps working; deep-clones so editing the loaded plant can never
// mutate the stored species.
function loadOpts(savedOpts) {
  pushUndo();
  for (const k of Object.keys(opts)) delete opts[k];
  Object.assign(opts, structuredClone(savedOpts));
  baseSeed = opts.seed;
  mode = 'solo';
  gridSizeWrap.style.display = 'none';
  applyOptsAndRefresh();
  activateTab('tuning');
}
// Like loadOpts's core, but no undo/tab-switch/render -- used between batch-generated mutations
// (see "Auto-add mutations" in Task 12), not a user-facing load.
function resetOptsQuiet(source) {
  for (const k of Object.keys(opts)) delete opts[k];
  Object.assign(opts, structuredClone(source));
}

sectionHost = speciesPage;

header('Family');
let familySelectEl, newFamilyNameValue = '';
{
  row('<span style="color:#c4ccd6">Family</span>');
  familySelectEl = document.createElement('select');
  familySelectEl.addEventListener('change', () => {
    currentFamilyId = familySelectEl.value || null;
    currentSpeciesId = null;
    renderFamilyPanel();
  });
  current.appendChild(familySelectEl);
}
{
  row('<span style="color:#c4ccd6">New family name</span>');
  const nameInp = document.createElement('input'); nameInp.type = 'text'; nameInp.style.width = '100%';
  nameInp.addEventListener('input', () => { newFamilyNameValue = nameInp.value; });
  current.appendChild(nameInp);
  buttonControl('+ New family', () => {
    const name = newFamilyNameValue.trim() || `Family ${families.length + 1}`;
    const fam = { id: newId(), name, species: [] };
    families.push(fam);
    persistFamilies();
    currentFamilyId = fam.id;
    currentSpeciesId = null;
    nameInp.value = ''; newFamilyNameValue = '';
    renderFamilyPanel();
  });
}
{
  // POSTs to serve.py's /api/save-plant-family (Task 1), same slug-derived filename + manifest
  // append as tree-viewer.html's /api/save-family, falling back to a manual download.
  const statusEl = document.createElement('span');
  statusEl.style.cssText = 'margin-left:8px;color:#8fa;font-size:12px;';
  buttonControl('Export family JSON', () => {
    const fam = currentFamilyId ? familyById(currentFamilyId) : null;
    if (!fam) return;
    const slug = fam.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'family';
    const json = JSON.stringify(fam, null, 2);
    statusEl.textContent = 'Saving...';
    fetch('/api/save-plant-family', { method: 'POST', body: json })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((res) => {
        statusEl.textContent = `Saved plant-families/${res.filename} + updated manifest.json`;
      })
      .catch(() => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${slug}.json`;
        a.click();
        URL.revokeObjectURL(url);
        statusEl.textContent = `Server save unavailable — downloaded ${slug}.json, move it into plant-families/ and add to manifest.json manually`;
      });
  });
  current.appendChild(statusEl);
}

```

`renderFamilyPanel` isn't defined until Task 12 — same forward-reference-via-hoisting pattern as
earlier tasks.

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Leave in working tree (no commit)**

Move to Task 12. (No visual smoke test yet — the Species tab has no rendering call for its dynamic
hosts until `renderFamilyPanel()` is defined and invoked in Task 12; clicking the "Species" tab
button right now would show an empty page below the Family row.)

---

## Task 12: Species tab, part 2 — Grow family, Species list/edit, final wiring

**Files:**
- Modify: `plant-viewer.html`

- [ ] **Step 1: Insert before the render loop**

```js
header('Grow family');
const growHost = document.createElement('div');
current.appendChild(growHost);

header('Species');
const speciesListHost = document.createElement('div');
current.appendChild(speciesListHost);

header('Edit species');
const speciesEditHost = document.createElement('div');
current.appendChild(speciesEditHost);

// Rebuilds the family <select>'s options plus the three dynamic hosts above from current state.
// Called after any add/remove/select action.
function renderFamilyPanel() {
  familySelectEl.innerHTML = '';
  for (const f of families) {
    const op = document.createElement('option'); op.value = f.id; op.textContent = f.name;
    familySelectEl.appendChild(op);
  }
  if (currentFamilyId && !familyById(currentFamilyId)) currentFamilyId = null;
  if (!currentFamilyId && families.length) currentFamilyId = families[0].id;
  if (currentFamilyId) familySelectEl.value = currentFamilyId;

  renderGrowHost();
  renderSpeciesList();
  renderSpeciesEdit();
}

function renderGrowHost() {
  growHost.innerHTML = '';
  withHost(growHost, () => {
    const fam = currentFamilyId ? familyById(currentFamilyId) : null;
    if (!fam) { row('<span style="color:#7f8a99">Create a family to start growing species.</span>'); return; }

    // Auto: batch-mutate the currently-loaded plant N times from the SAME baseline (not
    // cumulative drift) and save every result as a new species, without rendering each
    // intermediate mutation -- only the final restore-to-baseline is rendered.
    let mutationCount = 5;
    rangeControl('Auto-add count', 1, 20, 1, () => mutationCount, v => { mutationCount = Math.round(v); }, fi, () => {});
    buttonControl('Auto-add mutations', () => {
      const baseline = snapshotOpts();
      const added = [];
      for (let i = 0; i < mutationCount; i++) {
        resetOptsQuiet(baseline);
        mutateParams([...stemMutateList(), ...leafMutateList(), ...flowerMutateList()]);
        added.push({
          id: newId(), name: `${fam.name} ${fam.species.length + added.length + 1}`,
          opts: snapshotOpts(), parentSpeciesId: currentSpeciesId,
          biomes: [], density: 1, sizeRange: [0.85, 1.15],
        });
      }
      fam.species.push(...added);
      persistFamilies();
      resetOptsQuiet(baseline);
      refreshAllControls();
      rebuildView();
      renderSpeciesList();
    });

    // Manual: use the tool exactly as it already works (any Mutate button, sliders, whatever),
    // then keep the result. Never hitting this is how a bad mutation gets discarded.
    let keepNameValue = '';
    {
      row('<span style="color:#c4ccd6">New species name</span>');
      const inp = document.createElement('input'); inp.type = 'text'; inp.style.width = '100%';
      inp.addEventListener('input', () => { keepNameValue = inp.value; });
      current.appendChild(inp);
    }
    buttonControl('Keep current plant as new species', () => {
      const name = keepNameValue.trim() || `${fam.name} ${fam.species.length + 1}`;
      fam.species.push({
        id: newId(), name, opts: snapshotOpts(), parentSpeciesId: currentSpeciesId,
        biomes: [], density: 1, sizeRange: [0.85, 1.15],
      });
      persistFamilies();
      keepNameValue = '';
      renderSpeciesList();
    });
  });
}

function renderSpeciesList() {
  speciesListHost.innerHTML = '';
  withHost(speciesListHost, () => {
    const fam = currentFamilyId ? familyById(currentFamilyId) : null;
    if (!fam || fam.species.length === 0) { row('<span style="color:#7f8a99">No species yet.</span>'); return; }
    fam.species.forEach(sp => {
      const label = sp.name + (sp.biomes.length ? ' · ' + sp.biomes.join(',') : '');
      const r = row('<span style="color:#c4ccd6;cursor:pointer">' + label + '</span>');
      const delBtn = document.createElement('span');
      delBtn.textContent = '×'; delBtn.style.cssText = 'cursor:pointer;color:#c47;padding:0 4px';
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        fam.species = fam.species.filter(s => s.id !== sp.id);
        if (currentSpeciesId === sp.id) currentSpeciesId = null;
        persistFamilies();
        renderSpeciesList();
        renderSpeciesEdit();
      });
      r.appendChild(delBtn);
      // Clicking a row both loads it into the live Solo plant AND selects it for editing.
      r.addEventListener('click', () => {
        currentSpeciesId = sp.id;
        loadOpts(sp.opts);
        renderSpeciesEdit();
      });
    });
  });
}

function renderSpeciesEdit() {
  speciesEditHost.innerHTML = '';
  withHost(speciesEditHost, () => {
    const fam = currentFamilyId ? familyById(currentFamilyId) : null;
    const sp = fam && currentSpeciesId ? fam.species.find(s => s.id === currentSpeciesId) : null;
    if (!sp) { row('<span style="color:#7f8a99">Select a species from the list to edit it.</span>'); return; }

    {
      row('<span style="color:#c4ccd6">Name</span>');
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = sp.name; inp.style.width = '100%';
      inp.addEventListener('input', () => { sp.name = inp.value; persistFamilies(); });
      current.appendChild(inp);
    }

    row('<span style="color:#8a93a3">Biomes</span>');
    for (const b of BIOME_NAMES) {
      const r = row('<span style="color:#c4ccd6">' + b + '</span>');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sp.biomes.includes(b); cb.style.width = 'auto';
      cb.addEventListener('change', () => {
        if (cb.checked) { if (!sp.biomes.includes(b)) sp.biomes.push(b); }
        else sp.biomes = sp.biomes.filter(x => x !== b);
        persistFamilies();
      });
      r.appendChild(cb);
    }

    rangeControl('Density', 0, 5, 0.1, () => sp.density, v => { sp.density = v; persistFamilies(); }, f2, () => {});
    rangeControl('Size min', 0.1, 3, 0.05, () => sp.sizeRange[0], v => { sp.sizeRange[0] = Math.min(v, sp.sizeRange[1]); persistFamilies(); }, f2, () => {});
    rangeControl('Size max', 0.1, 3, 0.05, () => sp.sizeRange[1], v => { sp.sizeRange[1] = Math.max(v, sp.sizeRange[0]); persistFamilies(); }, f2, () => {});
  });
}

renderFamilyPanel();

positionMutBoxInitial();

```

- [ ] **Step 2: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('plant-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('plant-viewer.check.mjs', s)"
node --check plant-viewer.check.mjs
rm plant-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Full manual smoke test**

```bash
python serve.py 8092 & echo $! > serve.pid
sleep 1
```

Open `http://127.0.0.1:8092/plant-viewer.html`. Walk through:

1. No error banner on load; ground plane + one plant render.
2. Tuning tab: open every floating panel (View, Lighting, Stem, Leaf, Flower, Export) — each opens
   without overlapping, drags independently, closes on ×.
3. Switch Mode to `grid`; a grid of plants appears, all distinct (different seeds), camera refits.
   Switch back to `solo`.
4. "Reroll seed" changes the plant and is undoable via the Mutation panel's Undo button.
5. "Mutate all" visibly changes the plant; Undo reverts it; Redo restores it.
6. "Restart" returns to the exact `PLANT_DEFAULTS` shape (verify via the Export textarea).
7. Switch to the Species tab. A "Wildflowers" family should already be selected with 4 species
   (chickweed, cleavers, mint, jewelweed) listed. Click each one — the Solo plant changes to match,
   and its Biomes checkboxes/Density/Size sliders in "Edit species" reflect that species' tags.
8. In "Grow family", set Auto-add count to 2 and click "Auto-add mutations" — 2 new species appear
   in the list under the current family; clicking one loads it.
9. Tune a plant by hand on the Tuning tab, switch to Species, type a name under "New species name",
   click "Keep current plant as new species" — it appears in the list.
10. Click "Export family JSON" on the Wildflowers family (or a new test family, not Wildflowers, to
    avoid overwriting real starter data if this step doesn't get cleaned up) — status text confirms
    a save to `plant-families/`.
11. Refresh the page — the Species tab's family list should persist (localStorage), and the
    first-launch seeding should NOT run again (no duplicate "Wildflowers" family).

If this environment has no real WebGPU adapter and rendering can't be observed, note that
explicitly and fall back to checking the DOM structure (via `--dump-dom` or similar) and the
absence of any error banner / console errors instead of claiming the render was visually verified.

```bash
kill $(cat serve.pid)
rm serve.pid
```

- [ ] **Step 4: Clean up smoke-test artifacts**

If Step 3 created a test family under `plant-families/` (e.g. via Export family JSON on a
non-"Wildflowers" family), remove that file and its manifest entry the same way Task 1 Step 5 did.
Also clear the browser's `localStorage` entry for `plant-viewer:families` if you created throwaway
species during manual testing that shouldn't ship as the tool's first-run state for other
developers opening it fresh (this is local browser state, not a repo file, so no `git` action is
needed either way).

- [ ] **Step 5: Leave in working tree (no commit)**

`plant-viewer.html` is now feature-complete per the spec. Move to Task 13.

---

## Task 13: Docs — `vegetation.md` + `agent_log.csv`

**Files:**
- Modify: `docs/subsystems/vegetation.md`
- Modify: `agent_log.csv`

- [ ] **Step 1: Replace the "Future tooling" paragraph**

Find this exact block in `docs/subsystems/vegetation.md` (currently around line 298):

```markdown
**Future tooling (not yet built).** Because `plants.js`'s data model is fully parameterized (every
field `PLANT_DEFAULTS` exposes — leaf shape, simple/complex style, leaflet count/parity, arrangement,
serration, variegation, colors), a `plant-viewer.html` standalone tuning tool mirroring
`tree-viewer.html`'s Solo/Grid/export pattern could be added later with no changes to `plants.js`
itself. Not scheduled; noted here only so the data-model choice's payoff is documented.
```

Replace it with:

```markdown
**Standalone tuning tool.** `plants.js`'s data model is fully parameterized specifically so a
standalone tool could expose it — see `plant-viewer.html` under "Standalone tooling" below.
```

- [ ] **Step 2: Append a `plant-viewer.html` subsection**

At the very end of `docs/subsystems/vegetation.md` (after the existing "### Game integration:
authored families replace procedural species" subsection, which currently ends the file), append:

```markdown

### plant-viewer.html

`plant-viewer.html` is `tree-viewer.html`'s direct counterpart for `plants.js`: a standalone
single-file tuning tool with its own minimal `WebGPURenderer`/`OrbitControls`/`lights.js` scene
shell (not wired into `environment-viewer.html`), Solo/Grid view modes, the same duplicated-inline
floating-panel controls kit, Mutate/Undo/Redo/Restart, and a Family/Species tab persisted to
`localStorage` under `plant-viewer:families`. Run via `python serve.py` like the main viewer.

Two things tree-viewer.html has that this tool deliberately omits: a texture-mode toggle (`plants.js`
geometry has no texture maps — colors are baked directly into vertex colors) and an age-preview
slider / per-species age range (`plants.js` has no growth model analogous to `tree-age.js`'s
`applyAge` yet).

Tuning-tab sections: View, Lighting (identical to tree-viewer.html), Stem (`stem.nodes`/
`nodeSpacing` min-max, `branchProb`, `sprawl`), Leaf (`shape`/`style`/`leafletCount`/
`leafletParity`/`arrangement`/`whorlCount`/serration/variegation/`size`/`color`, plus a toggle-gated
vein color since `leaf.veinColor` is nullable), Flower (`enabled`/`shape`/`petals`/`frequency`/
`color`, plus a toggle-gated throat color for the same nullable-field reason), and Export ("Copy
plant JSON", no texture replacer needed since plant opts never hold live `Texture` objects).

Species tab: unlike tree-viewer.html's one-time migration of a legacy flat saved-tree list,
plant-viewer.html has no prior save format — instead, on a genuinely fresh `localStorage` (the
`plant-viewer:families` key was never set, not merely emptied), it seeds one starter family,
**"Wildflowers"**, containing the 4 `PLANT_PRESETS` species (chickweed, cleavers, mint, jewelweed)
with their `PLANT_BIOME_TAGS` biome/density values pre-filled and a `sizeRange` of `[0.85, 1.15]`
(matching `plants-placement.js`'s existing hardcoded scale jitter — now editable per-species rather
than a single global constant). "Grow family" (Auto-add mutations / Keep current plant as new
species) and the Species list/edit panel work identically to tree-viewer.html, using
`stemMutateList`/`leafMutateList`/`flowerMutateList` in place of tree-viewer's structure/force/
bark/leaves lists. Species metadata is `name`/`biomes[]`/`density`/`sizeRange` — no `ageRange`
field (dropped; see above).

"Export family JSON" POSTs to a new `serve.py` route, `/api/save-plant-family`, which writes into
its own `plant-families/` directory + `plant-families/manifest.json` — kept fully separate from
tree-viewer.html's `families/` so the two tools' saved data can never collide on disk. `serve.py`
factors the shared slugify-filename/write-file/update-manifest logic both routes need into one
`save_family_to(payload, dir_path)` helper. Nothing in `environment-viewer.html`'s forest-placement
pipeline reads `plant-families/` yet — the "fetch manifest → buildSpeciesFromFamilies → wire into
placementRecords" game-integration step `families/` already has for trees has no plant equivalent
yet; that would be a separate follow-on, not part of this tool.
```

- [ ] **Step 3: Append the `agent_log.csv` row**

Read the last line of `agent_log.csv` to confirm the exact column order and quoting convention
still matches (`date,subsystem,files,summary`), then append one row (use today's date):

```
2026-07-03T00:00,vegetation,"plant-viewer.html;serve.py;docs/subsystems/vegetation.md",Added plant-viewer.html standalone tuning tool for plants.js (Family/Species save-breed-tag system) modeled on tree-viewer.html, plus a new /api/save-plant-family serve.py endpoint.
```

Adjust the timestamp to the actual time this task is executed, in `YYYY-MM-DDTHH:MM` form. Do not
rewrite or reorder any existing row — append only.

- [ ] **Step 4: Verify the docs render sensibly**

Read back the modified section of `vegetation.md` to confirm the Markdown didn't break (no
mismatched backticks, no orphaned heading) and that the new subsection sits after the "Game
integration" subsection with a blank line separating them, consistent with the rest of the file's
spacing.

- [ ] **Step 5: Leave in working tree (no commit)**

This completes the plan. Per this plan's commit policy, everything from Task 1 through Task 13
(serve.py, plant-viewer.html, vegetation.md, agent_log.csv) stays uncommitted in the working tree
until the user gives explicit go-ahead for one combined commit.

---

## Self-review notes (from writing this plan)

**Spec coverage:** every section of `docs/superpowers/specs/2026-07-03-plant-viewer-design.md` maps
to a task — scene shell (Task 2), data model (Task 3), controls shell (Task 4), View/Lighting
(Task 5), Mutation dock (Task 6), Stem/Leaf/Flower (Tasks 7-9), Export (Task 10), Species tab
(Tasks 11-12), server endpoint (Task 1), docs (Task 13). No spec requirement without a task.

**Placeholder scan:** no "TBD"/"TODO" strings; every code step has complete, runnable code, not a
description of what to write.

**Type/name consistency check:** `stemMutateList`/`leafMutateList`/`flowerMutateList` (defined
Task 6) are called with those exact names in Tasks 7-9's `panelSection` mutateFn args and in
Task 12's Auto-add mutations handler. `loadOpts`/`resetOptsQuiet`/`snapshotOpts` (defined Task 11)
are called with those exact names in Task 6 (Restart button) and Task 12 (Grow family, species-list
click handler). `renderFamilyPanel`/`renderGrowHost`/`renderSpeciesList`/`renderSpeciesEdit`
(all defined Task 12) are called consistently by name from within each other and from Task 11's
family-select/new-family handlers. `PLANT_FAMILIES_DIR`/`save_family_to` (Task 1) match the names
used in the spec's server-change section exactly. Confirmed no drift.
