# Slider State Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user save the current values of every scene-tuning slider/select/toggle under a
name, list/load/delete saved states from a new "Presets" tab in the workshop UI, and pick a saved
state from the start menu before the world loads.

**Architecture:** A new `slider-state.js` module owns `localStorage` persistence. The existing
`slider()`/`select()`/`toggle()` factories in `environment-viewer.html` self-register every
control they build into a module-level `controlRegistry`; two functions (`captureSliderState`,
`applySliderState`) read/write that registry. `environment-ui.js` gains a 6th "Presets" tab that
calls into those functions (passed in as a `sliderState` object). `start-screen.js` gains a
preset `<select>` on the role-picker screen whose choice is applied once, right before the render
loop starts.

**Tech Stack:** Vanilla JS ES modules, `localStorage`, no build step, no framework — matches the
rest of this directory.

**Design doc:** `docs/superpowers/specs/2026-07-01-slider-state-presets-design.md`

---

### Task 1: `slider-state.js` storage module

**Files:**
- Create: `slider-state.js`
- Test: `test-slider-state.mjs`

- [x] **Step 1: Write the failing test**

Create `test-slider-state.mjs`:

```js
import { listStates, saveState, deleteState } from './slider-state.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (cond) pass++; else fail++;
}

// Node has no localStorage global — stub it before calling anything that touches it.
globalThis.localStorage = (() => {
  let store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
})();

ok(Object.keys(listStates()).length === 0, 'listStates starts empty');

saveState('sunset', { 'params.count': 18, 'rigP.elevation': 12 });
let states = listStates();
ok(Object.keys(states).length === 1, 'saveState adds one entry');
ok(states.sunset.values['rigP.elevation'] === 12, 'saveState stores the values object');
ok(typeof states.sunset.savedAt === 'string' && states.sunset.savedAt.length > 0, 'saveState stamps savedAt');

saveState('sunset', { 'params.count': 99 });
states = listStates();
ok(Object.keys(states).length === 1, 'saveState overwrites an existing name in place');
ok(states.sunset.values['params.count'] === 99, 'overwrite replaces the values object');

saveState('noon', { 'params.count': 5 });
ok(Object.keys(listStates()).length === 2, 'a second distinct name adds a second entry');

deleteState('sunset');
states = listStates();
ok(Object.keys(states).length === 1 && !states.sunset, 'deleteState removes only the named entry');
ok(!!states.noon, 'deleteState leaves other entries untouched');

deleteState('does-not-exist');
ok(Object.keys(listStates()).length === 1, 'deleteState on an unknown name is a no-op');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [x] **Step 2: Run test to verify it fails**

Run: `node test-slider-state.mjs`
Expected: FAIL — `Cannot find module './slider-state.js'` (file doesn't exist yet).

- [x] **Step 3: Write the implementation**

Create `slider-state.js`:

```js
const STORAGE_KEY = 'pcw:sliderStates';

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

// -> { [name]: { savedAt: isoString, values: { [controlName]: number|string|boolean } } }
export function listStates() {
  return readStore();
}

export function saveState(name, values) {
  const store = readStore();
  store[name] = { savedAt: new Date().toISOString(), values };
  writeStore(store);
}

export function deleteState(name) {
  const store = readStore();
  delete store[name];
  writeStore(store);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node test-slider-state.mjs`
Expected: `9 passed, 0 failed`

- [x] **Step 5: Commit**

```bash
git add slider-state.js test-slider-state.mjs
git commit -m "feat(infra): add slider-state.js for named localStorage slider presets"
```

---

### Task 2: Control registry + capture/apply in `environment-viewer.html`

**Files:**
- Modify: `environment-viewer.html:37-52` (imports)
- Modify: `environment-viewer.html:778-780` (insert registry + capture/apply before `_forestPromise`)
- Modify: `environment-viewer.html:1567-1600` (`slider()`, `select()`, `toggle()` factories)
- Modify: `environment-viewer.html:1654-1657, 1668, 1681-1684` (thread `objName` through `rigP`/`terrain` slider calls)
- Modify: `environment-viewer.html:2271-2273` (thread `objName` through `SKY_PARAMS` slider calls)

This task has no isolated automated test — `environment-viewer.html` is a single DOM/three.js
script with no test harness (same as the rest of this file; see `infra.md`'s note that
`environment-ui.js` has no automated coverage for the same reason). Steps 1-6 are the
implementation; Step 7 is a manual verification pass in the browser, which stands in for the
"run it and check" cycle here.

- [x] **Step 1: Add the `slider-state.js` import**

In `environment-viewer.html`, after the existing import at line 52
(`import { createHostSession, createGuestSession, GhostRenderer } from './multiplayer.js';`),
add:

```js
import { listStates as listSliderStates, saveState as saveSliderState, deleteState as deleteSliderState } from './slider-state.js';
```

- [x] **Step 2: Add `controlRegistry` and capture/apply at module top level**

The `slider()`/`select()`/`toggle()` factory functions are defined *inside* the
`_forestPromise.then(async (...) => { ... })` callback (they close over the `params` object
declared there), but `createEnvironmentUi(...)` is called later, *outside* that callback. So the
registry and the two functions that read/write it must live at the outer module scope — they'll
be reached by closure from inside the callback (for registration) and called directly from
outside it (for the Presets tab and the start-menu preset).

Immediately before the line:

```js
const _forestPromise = Promise.all([import('./trees.js'), import('./tree-textures.js')]).then(async ([{ createTree }, { createTextureSource }]) => {
```

insert:

```js
// ---- slider-state presets: every slider()/select()/toggle() control below self-registers
// here so a saved preset can be captured/replayed without hand-listing every param. ----
const controlRegistry = [];
function captureSliderState() {
  const values = {};
  for (const c of controlRegistry) values[c.name] = c.obj[c.key];
  return values;
}
function applySliderState(values) {
  if (!values) return;
  for (const c of controlRegistry) {
    if (!(c.name in values)) continue;
    c.obj[c.key] = values[c.name];
    c.sync();
  }
  const fired = new Set();
  for (const c of controlRegistry) {
    if (!(c.name in values) || fired.has(c.onChange)) continue;
    fired.add(c.onChange);
    c.onChange();
  }
}
```

- [x] **Step 3: Register controls inside `slider()`**

Find (around line 1567):

```js
  function slider(key, label, min, max, step, fmt, onChange, obj) {
    const P = obj || params;
    const row = document.createElement('div'); row.className = 'row';
    const val = document.createElement('span'); val.textContent = fmt(P[key]);
    row.innerHTML = '<span style="color:#c4ccd6">' + label + '</span>'; row.appendChild(val);
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = P[key];
    inp.addEventListener('input', () => { P[key] = parseFloat(inp.value); val.textContent = fmt(P[key]); (onChange || apply)(); });
    current.appendChild(row); current.appendChild(inp);
  }
```

Replace with:

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
  }
```

(`handler` replaces the inline `(onChange || apply)()` — same value, computed once instead of on
every `input` event, so it can also be used as the registry's dedupe key in `applySliderState`.)

- [x] **Step 4: Register controls inside `select()` and `toggle()`**

Find (around line 1586):

```js
  function select(key, label, opts, onChange) {
    const row = document.createElement('div'); row.className = 'row'; row.innerHTML = '<span style="color:#c4ccd6">' + label + '</span>'; current.appendChild(row);
    const sel = document.createElement('select');
    for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = o; if (o === params[key]) op.selected = true; sel.appendChild(op); }
    sel.addEventListener('change', () => { params[key] = sel.value; (onChange || apply)(); });
    current.appendChild(sel);
  }
  function toggle(key, label, onChange) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<span style="color:#c4ccd6">' + label + '</span>';
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!params[key]; inp.style.width = 'auto';
    inp.addEventListener('change', () => { params[key] = inp.checked; onChange(); });
    row.appendChild(inp); current.appendChild(row);
    return inp;
  }
```

Replace with:

```js
  function select(key, label, opts, onChange) {
    const row = document.createElement('div'); row.className = 'row'; row.innerHTML = '<span style="color:#c4ccd6">' + label + '</span>'; current.appendChild(row);
    const sel = document.createElement('select');
    for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = o; if (o === params[key]) op.selected = true; sel.appendChild(op); }
    const handler = onChange || apply;
    sel.addEventListener('change', () => { params[key] = sel.value; handler(); });
    current.appendChild(sel);
    controlRegistry.push({
      name: 'params.' + key, obj: params, key, onChange: handler,
      sync: () => { sel.value = params[key]; },
    });
  }
  function toggle(key, label, onChange) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<span style="color:#c4ccd6">' + label + '</span>';
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!params[key]; inp.style.width = 'auto';
    inp.addEventListener('change', () => { params[key] = inp.checked; onChange(); });
    row.appendChild(inp); current.appendChild(row);
    controlRegistry.push({
      name: 'params.' + key, obj: params, key, onChange,
      sync: () => { inp.checked = !!params[key]; },
    });
    return inp;
  }
```

- [x] **Step 5: Thread `objName` through the `rigP` and `terrain` slider calls**

These are the only `slider()` call sites that pass a custom `obj` and therefore need the matching
name so their registry entries read `rigP.<key>` / `terrain.<key>` instead of `params.<key>`
(which would silently collide with unrelated `params` keys of the same name).

Find (around line 1654):

```js
  slider('elevation',        'Sun elevation',  2, 88,  1,    fi,  () => rig.setElevation(rigP.elevation),               rigP);
  slider('azimuth',          'Azimuth',        0, 360, 1,    fi,  () => rig.setAzimuth(rigP.azimuth),                   rigP);
  slider('sunIntensity',     'Sun intensity',  0, 4,   0.05, f2,  () => { rig.setSunIntensity(rigP.sunIntensity); forestGPURef?.setBillboardBrightness(billBrightness()); },         rigP);
  slider('ambientIntensity', 'Ambient',        0, 2,   0.05, f2,  () => { rig.setAmbientIntensity(rigP.ambientIntensity); forestGPURef?.setBillboardBrightness(billBrightness()); }, rigP);
```

Replace with:

```js
  slider('elevation',        'Sun elevation',  2, 88,  1,    fi,  () => rig.setElevation(rigP.elevation),               rigP, 'rigP');
  slider('azimuth',          'Azimuth',        0, 360, 1,    fi,  () => rig.setAzimuth(rigP.azimuth),                   rigP, 'rigP');
  slider('sunIntensity',     'Sun intensity',  0, 4,   0.05, f2,  () => { rig.setSunIntensity(rigP.sunIntensity); forestGPURef?.setBillboardBrightness(billBrightness()); },         rigP, 'rigP');
  slider('ambientIntensity', 'Ambient',        0, 2,   0.05, f2,  () => { rig.setAmbientIntensity(rigP.ambientIntensity); forestGPURef?.setBillboardBrightness(billBrightness()); }, rigP, 'rigP');
```

Find (around line 1668):

```js
  slider('size', 'View distance', 200, 1000, 10, fi, () => updateDrawDistance(), terrain);
```

Replace with:

```js
  slider('size', 'View distance', 200, 1000, 10, fi, () => updateDrawDistance(), terrain, 'terrain');
```

Find (around line 1681):

```js
  slider('renderRadius', 'Draw distance (chunks)', 1, 12, 1, drawFmt, drawDistanceChange, terrain);
  slider('lake', 'Lake coverage', 0, 1, 0.01, f2, worldRebuild, terrain);
  slider('lakeDepth', 'Lake depth', 0, 6, 0.1, f2, worldRebuild, terrain);
  slider('waterLevel', 'Water level', -3, 1, 0.05, f2, worldRebuild, terrain);
```

Replace with:

```js
  slider('renderRadius', 'Draw distance (chunks)', 1, 12, 1, drawFmt, drawDistanceChange, terrain, 'terrain');
  slider('lake', 'Lake coverage', 0, 1, 0.01, f2, worldRebuild, terrain, 'terrain');
  slider('lakeDepth', 'Lake depth', 0, 6, 0.1, f2, worldRebuild, terrain, 'terrain');
  slider('waterLevel', 'Water level', -3, 1, 0.05, f2, worldRebuild, terrain, 'terrain');
```

- [x] **Step 6: Thread `objName` through the `SKY_PARAMS` slider calls**

Find (around line 2271):

```js
    slider('starCount', 'Star count', 200, 3000, 50, fi, () => skyRef && skyRef.setStarCount(SKY_PARAMS.starCount), SKY_PARAMS);
    slider('sunSize', 'Body size', 0.02, 0.2, 0.005, f2, () => skyRef && skyRef.setSunSize(SKY_PARAMS.sunSize), SKY_PARAMS);
    slider('milkyWayIntensity', 'Milky Way', 0, 1.5, 0.05, f2, () => skyRef && skyRef.setMilkyWayIntensity(SKY_PARAMS.milkyWayIntensity), SKY_PARAMS);
```

Replace with:

```js
    slider('starCount', 'Star count', 200, 3000, 50, fi, () => skyRef && skyRef.setStarCount(SKY_PARAMS.starCount), SKY_PARAMS, 'SKY_PARAMS');
    slider('sunSize', 'Body size', 0.02, 0.2, 0.005, f2, () => skyRef && skyRef.setSunSize(SKY_PARAMS.sunSize), SKY_PARAMS, 'SKY_PARAMS');
    slider('milkyWayIntensity', 'Milky Way', 0, 1.5, 0.05, f2, () => skyRef && skyRef.setMilkyWayIntensity(SKY_PARAMS.milkyWayIntensity), SKY_PARAMS, 'SKY_PARAMS');
```

- [x] **Step 7: Manual smoke check**

Run: `python serve.py` from `workshop-webgpu/`, open `http://127.0.0.1:8080/environment-viewer.html`,
pick Solo → Infinite World. Open the browser devtools console and run:

```js
// paste in console once the scene has loaded
window.__csTest = undefined; // placeholder — actual check below doesn't need a global
```

Since `captureSliderState`/`applySliderState`/`controlRegistry` are module-scoped (not on
`window`), verify indirectly instead: drag any slider in the "Scene controls" panel (e.g. Sun
elevation), confirm the scene still updates live exactly as before this change (no regression —
these steps only added registration side effects, the existing `input`/`change` listeners are
unchanged). No console errors. This step will get a real functional check once Task 3 exposes
capture/apply through the Presets tab UI.

- [x] **Step 8: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(entry): register scene sliders into a capture/apply state registry"
```

---

### Task 3: "Presets" tab in `environment-ui.js`

**Files:**
- Modify: `environment-ui.js:128-133` (`.wui-tabs` CSS grid)
- Modify: `environment-ui.js:308-315` (extend styled-input selector to include text inputs)
- Modify: `environment-ui.js:398-405` (media query tab grid)
- Modify: `environment-ui.js:410-503` (`createEnvironmentUi` — tab defs, panel host, wiring)
- Modify: `environment-ui.js` (new `buildPresetsPanel` function, alongside `buildPerfPanel`)
- Modify: `environment-viewer.html:2554` (pass `sliderState` into `createEnvironmentUi`)

No automated test — DOM-dependent, same rationale as Task 2. Verified manually in Step 6.

- [x] **Step 1: Add the 6th tab slot and grid CSS**

In `environment-ui.js`, find:

```css
    .wui-tabs {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      border-bottom: 1px solid var(--wui-line);
      background: rgba(255,255,255,0.035);
    }
```

Replace with:

```css
    .wui-tabs {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      border-bottom: 1px solid var(--wui-line);
      background: rgba(255,255,255,0.035);
    }
```

Find:

```css
    @media (max-width: 720px) {
      #workshop-ui {
        left: 10px;
        width: auto;
      }
      .wui-tabs { grid-template-columns: repeat(5, minmax(0, 1fr)); }
      .wui-tab { font-size: 11px; }
    }
```

Replace with:

```css
    @media (max-width: 720px) {
      #workshop-ui {
        left: 10px;
        width: auto;
      }
      .wui-tabs { grid-template-columns: repeat(6, minmax(0, 1fr)); }
      .wui-tab { font-size: 11px; }
    }
```

- [x] **Step 2: Style the preset name text input**

Find:

```css
    #workshop-ui select,
    #workshop-ui input[type=number] {
      background: #20252d !important;
      color: var(--wui-text) !important;
      border: 1px solid var(--wui-line) !important;
      border-radius: 5px !important;
      min-height: 26px;
    }
```

Replace with:

```css
    #workshop-ui select,
    #workshop-ui input[type=number],
    #workshop-ui input[type=text] {
      background: #20252d !important;
      color: var(--wui-text) !important;
      border: 1px solid var(--wui-line) !important;
      border-radius: 5px !important;
      min-height: 26px;
    }
```

- [x] **Step 3: Add the `presets` tab definition and panel host**

Find:

```js
export function createEnvironmentUi({ perfLog } = {}) {
  installStyle();

  const shell = makeEl('aside');
  shell.id = 'workshop-ui';
  shell.setAttribute('aria-label', 'Workshop controls');

  const tabs = makeEl('nav', 'wui-tabs');
  const tabDefs = [
    ['scene', 'Scene'],
    ['creatures', 'Creatures'],
    ['effects', 'Effects'],
    ['walk', 'Walk'],
    ['perf', 'Perf'],
  ];
```

Replace with:

```js
export function createEnvironmentUi({ perfLog, sliderState } = {}) {
  installStyle();

  const shell = makeEl('aside');
  shell.id = 'workshop-ui';
  shell.setAttribute('aria-label', 'Workshop controls');

  const tabs = makeEl('nav', 'wui-tabs');
  const tabDefs = [
    ['scene', 'Scene'],
    ['creatures', 'Creatures'],
    ['effects', 'Effects'],
    ['walk', 'Walk'],
    ['perf', 'Perf'],
    ['presets', 'Presets'],
  ];
```

Find:

```js
  const sceneHost = panelEls.get('scene');
  const effectsHost = panelEls.get('effects');
  const walkHost = panelEls.get('walk');
  const creaturesHost = panelEls.get('creatures');
  const perfHost = panelEls.get('perf');
  sceneHost.id = 'scene-section-host';
  effectsHost.id = 'effects-section-host';
```

Replace with:

```js
  const sceneHost = panelEls.get('scene');
  const effectsHost = panelEls.get('effects');
  const walkHost = panelEls.get('walk');
  const creaturesHost = panelEls.get('creatures');
  const perfHost = panelEls.get('perf');
  const presetsHost = panelEls.get('presets');
  sceneHost.id = 'scene-section-host';
  effectsHost.id = 'effects-section-host';
```

Find:

```js
  buildPerfPanel(perfHost, perfLog);

  return {
    activate,
    updatePerf: perfHost._updatePerf,
  };
}
```

Replace with:

```js
  buildPerfPanel(perfHost, perfLog);
  buildPresetsPanel(presetsHost, sliderState);

  return {
    activate,
    updatePerf: perfHost._updatePerf,
  };
}
```

- [x] **Step 4: Add `buildPresetsPanel`**

Add this new function after `buildPerfPanel` (at the end of the file, after its closing `}`):

```js
function buildPresetsPanel(host, sliderState) {
  if (!sliderState) {
    host.appendChild(makeEl('div', 'wui-empty', 'Preset saving unavailable.'));
    return;
  }

  const saveCard = makeEl('div', 'wui-card');
  saveCard.appendChild(makeEl('div', 'wui-card-title', 'Save current sliders'));
  const saveBody = makeEl('div', 'wui-card-body wui-capture');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'State name';
  nameInput.style.flex = '1 1 140px';
  nameInput.style.minWidth = '0';
  const saveBtn = makeEl('button', '', 'Save');
  saveBody.append(nameInput, saveBtn);
  saveCard.appendChild(saveBody);

  const listCard = makeEl('div', 'wui-card');
  listCard.appendChild(makeEl('div', 'wui-card-title', 'Saved states'));
  const listBody = makeEl('div', 'wui-card-body');
  listCard.appendChild(listBody);

  host.append(saveCard, listCard);

  function fmtAgo(iso) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  function renderList() {
    listBody.innerHTML = '';
    const entries = Object.entries(sliderState.list());
    if (entries.length === 0) {
      listBody.appendChild(makeEl('div', 'wui-empty', 'No saved states yet.'));
      return;
    }
    entries.sort((a, b) => b[1].savedAt.localeCompare(a[1].savedAt));
    for (const [name, entry] of entries) {
      const row = makeEl('div', 'wui-capture');
      row.style.marginBottom = '6px';
      const label = makeEl('span', '', `${name} · ${fmtAgo(entry.savedAt)}`);
      label.style.flex = '1 1 100%';
      const loadBtn = makeEl('button', '', 'Load');
      const delBtn = makeEl('button', '', 'Delete');
      loadBtn.addEventListener('click', () => sliderState.apply(entry.values));
      delBtn.addEventListener('click', () => { sliderState.remove(name); renderList(); });
      row.append(label, loadBtn, delBtn);
      listBody.appendChild(row);
    }
  }

  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const existing = sliderState.list();
    if (existing[name] && !window.confirm(`Overwrite saved state "${name}"?`)) return;
    sliderState.save(name, sliderState.capture());
    nameInput.value = '';
    renderList();
  });

  renderList();
}
```

- [x] **Step 5: Wire `sliderState` into the `createEnvironmentUi(...)` call site**

In `environment-viewer.html`, find:

```js
environmentUi = createEnvironmentUi({ perfLog });
```

Replace with:

```js
environmentUi = createEnvironmentUi({
  perfLog,
  sliderState: {
    capture: captureSliderState,
    apply: applySliderState,
    list: listSliderStates,
    save: saveSliderState,
    remove: deleteSliderState,
  },
});
```

- [x] **Step 6: Manual verification**

Run: `python serve.py` from `workshop-webgpu/`, open
`http://127.0.0.1:8080/environment-viewer.html`, Solo → Infinite World. In the workshop panel:

1. Click the new **Presets** tab — confirm it shows "No saved states yet."
2. Go to the Scene tab, change a few sliders (e.g. Sun elevation, Wind strength, Lake coverage).
3. Back in Presets, type a name (e.g. `test1`) and click **Save** — confirm it appears in the
   list with a "just now" timestamp.
4. Change those same sliders to different values.
5. Click **Load** on `test1` — confirm the sliders visibly snap back to the saved values *and*
   the live scene updates (sun angle moves, lake visibly changes, etc.) without a page reload.
6. Click **Save** again with the same name `test1` — confirm a native confirm dialog appears
   ("Overwrite saved state..."); cancel it and confirm the entry is unchanged; save again and
   accept, confirm the timestamp updates.
7. Click **Delete** on `test1` — confirm it disappears and the panel falls back to the empty state.
8. Check the browser console for errors throughout.

- [x] **Step 7: Commit**

```bash
git add environment-ui.js environment-viewer.html
git commit -m "feat(infra): add Presets tab for saving/loading slider states"
```

---

### Task 4: Start-menu preset selector

**Files:**
- Modify: `start-screen.js` (imports, `_roleStep`, `showStartScreen`)
- Modify: `environment-viewer.html:68` (destructure `presetName`)
- Modify: `environment-viewer.html:2947-2952` (apply preset before `dismiss()`)

No automated test — DOM-dependent. Verified manually in Step 4.

- [x] **Step 1: Import `listStates` and add the preset selector to the role-select screen**

In `start-screen.js`, find:

```js
import { RELAY_URL } from './multiplayer.js';
```

Replace with:

```js
import { RELAY_URL } from './multiplayer.js';
import { listStates } from './slider-state.js';
```

Find the `_errorEl` helper (so the new helper lands in the same "small DOM builders" section):

```js
function _errorEl() {
  const el = document.createElement('div');
  Object.assign(el.style, { fontSize: '11px', color: '#e05c5c', display: 'none' });
  return el;
}
```

Immediately after it, add:

```js
function _presetSelect() {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '12px', color: '#98a5b5',
  });
  const label = document.createElement('span');
  label.textContent = 'Load preset:';
  const sel = document.createElement('select');
  Object.assign(sel.style, {
    padding: '5px 8px', border: '1px solid #354050', borderRadius: '5px',
    background: '#20252d', color: '#d8dee9', fontSize: '12px',
  });
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'None';
  sel.appendChild(noneOpt);
  for (const name of Object.keys(listStates()).sort()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  wrap.append(label, sel);
  return { wrap, sel };
}
```

- [x] **Step 2: Thread the selected preset name through `_roleStep`'s three resolve paths**

Find:

```js
async function _roleStep(overlay) {
  return new Promise(resolve => {
    _clear(overlay);
    const s = _shell();
    s.appendChild(_title('Creature Workshop'));

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
      gap: '10px',
    });

    // Solo
    grid.appendChild(_mapCard('Solo', 'Play alone, choose your own map', () => {
      resolve({ mpRole: 'solo', roomCode: null, guestMapKey: null });
    }));
```

Replace with:

```js
async function _roleStep(overlay) {
  return new Promise(resolve => {
    _clear(overlay);
    const s = _shell();
    s.appendChild(_title('Creature Workshop'));

    const { wrap: presetWrap, sel: presetSel } = _presetSelect();
    s.appendChild(presetWrap);

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
      gap: '10px',
    });

    // Solo
    grid.appendChild(_mapCard('Solo', 'Play alone, choose your own map', () => {
      resolve({ mpRole: 'solo', roomCode: null, guestMapKey: null, presetName: presetSel.value || null });
    }));
```

Find:

```js
    hb.addEventListener('click', () => {
      const code = hi.value.trim().toUpperCase();
      if (!code) { he.textContent = 'Enter a room code'; he.style.display = ''; return; }
      he.style.display = 'none';
      resolve({ mpRole: 'host', roomCode: code, guestMapKey: null });
    });
```

Replace with:

```js
    hb.addEventListener('click', () => {
      const code = hi.value.trim().toUpperCase();
      if (!code) { he.textContent = 'Enter a room code'; he.style.display = ''; return; }
      he.style.display = 'none';
      resolve({ mpRole: 'host', roomCode: code, guestMapKey: null, presetName: presetSel.value || null });
    });
```

Find:

```js
        resolve({ mpRole: 'guest', roomCode: code, guestMapKey: mapKey });
```

Replace with:

```js
        resolve({ mpRole: 'guest', roomCode: code, guestMapKey: mapKey, presetName: presetSel.value || null });
```

- [x] **Step 3: Return `presetName` from `showStartScreen()`**

Find:

```js
  const { mpRole, roomCode, guestMapKey } = await _roleStep(overlay);
```

Replace with:

```js
  const { mpRole, roomCode, guestMapKey, presetName } = await _roleStep(overlay);
```

Find:

```js
  return {
    mapKey,
    mpRole,
    roomCode,
    setStatus,
    dismiss: () => overlay.remove(),
  };
```

Replace with:

```js
  return {
    mapKey,
    mpRole,
    roomCode,
    presetName,
    setStatus,
    dismiss: () => overlay.remove(),
  };
```

- [x] **Step 4: Capture `presetName` and apply it before the render loop starts**

In `environment-viewer.html`, find:

```js
const { mapKey, mpRole, roomCode, setStatus, dismiss } = await showStartScreen();
```

Replace with:

```js
const { mapKey, mpRole, roomCode, presetName, setStatus, dismiss } = await showStartScreen();
```

Find:

```js
setStatus('Loading world systems…');
await nextPaint();
await _forestPromise;
await Promise.all([_grassPromise, _waterPromise, _cloudsPromise, _skyPromise]);
dismiss();
renderer.setAnimationLoop(animate);
```

Replace with:

```js
setStatus('Loading world systems…');
await nextPaint();
await _forestPromise;
await Promise.all([_grassPromise, _waterPromise, _cloudsPromise, _skyPromise]);
if (presetName) applySliderState(listSliderStates()[presetName]?.values);
dismiss();
renderer.setAnimationLoop(animate);
```

This runs after every panel (including the async grass/water/clouds/sky sections) has finished
registering its controls, so `controlRegistry` is complete by the time `applySliderState` reads it.

- [x] **Step 5: Manual verification**

1. In the browser, open the Presets tab and save a state named `startmenu-test` with a few
   sliders changed from default (e.g. Sun elevation to something unusual, Wind strength to max).
2. Reload the page. On the role-select screen, confirm the "Load preset" dropdown now lists
   `startmenu-test` alongside "None".
3. Select `startmenu-test`, choose Solo → Infinite World.
4. Once the world loads, open the Scene tab and confirm the sliders reflect the saved values
   (not defaults), and the scene itself visibly matches (sun angle, wind).
5. Reload again, this time leave "None" selected — confirm the world loads with default slider
   values (no regression to the no-preset path).
6. Check the browser console for errors throughout.

- [x] **Step 6: Commit**

```bash
git add start-screen.js environment-viewer.html
git commit -m "feat(multi): load a saved slider preset from the start menu"
```

---

### Task 5: Docs and activity log

Per this directory's `CLAUDE.md`, doc/log updates are part of finishing the change, not optional
cleanup.

**Files:**
- Modify: `docs/subsystems/infra.md`
- Modify: `docs/subsystems/entry-point.md`
- Modify: `docs/subsystems/multiplayer.md`
- Modify: `agent_log.csv`

- [x] **Step 1: Update `docs/subsystems/infra.md`**

In the `environment-ui.js` file-responsibility row (around line 17), update the description to
mention the Presets tab. Find:

```
| `environment-ui.js` | Builds the tabbed `#workshop-ui` shell (Scene/Creatures/Effects/Walk/Perf tabs), re-parents existing DOM panels into it, and builds the read-only "Perf" tab content (live metrics, frame-stage bars, capture controls, raw debug feed). | 648 |
```

Replace with (line count will differ after Task 3's edits — update to the actual new line count
after running `wc -l environment-ui.js` or equivalent):

```
| `environment-ui.js` | Builds the tabbed `#workshop-ui` shell (Scene/Creatures/Effects/Walk/Perf/Presets tabs), re-parents existing DOM panels into it, builds the read-only "Perf" tab content (live metrics, frame-stage bars, capture controls, raw debug feed), and builds the "Presets" tab (save/load/delete named slider states via a `sliderState` object passed into `createEnvironmentUi`). | <NEW_LINE_COUNT> |
```

In the `createEnvironmentUi` public API section, update the signature and returns description.
Find:

```
### `environment-ui.js`

```js
export function createEnvironmentUi({ perfLog } = {})
```

Builds and appends the `#workshop-ui` `<aside>` to `document.body`, installs its stylesheet once (`#workshop-ui-style`), and returns:
- `activate(tabId)` — switches the active tab (`scene | creatures | effects | walk | perf`).
- `updatePerf` — bound to the internal `host._updatePerf(snapshot)` function built in `buildPerfPanel`; renders one perf-log snapshot into the Perf tab (metrics, sparkline, scene-figures rows, per-stage timing bars, capture button state).
```

Replace with:

```
### `environment-ui.js`

```js
export function createEnvironmentUi({ perfLog, sliderState } = {})
```

Builds and appends the `#workshop-ui` `<aside>` to `document.body`, installs its stylesheet once (`#workshop-ui-style`), and returns:
- `activate(tabId)` — switches the active tab (`scene | creatures | effects | walk | perf | presets`).
- `updatePerf` — bound to the internal `host._updatePerf(snapshot)` function built in `buildPerfPanel`; renders one perf-log snapshot into the Perf tab (metrics, sparkline, scene-figures rows, per-stage timing bars, capture button state).

`sliderState` (optional) is `{ capture(), apply(values), list(), save(name, values), remove(name) }`,
supplied by `environment-viewer.html` (`capture`/`apply` wrap its module-level slider registry;
`list`/`save`/`remove` are re-exported from `slider-state.js`). When omitted, the Presets tab
renders a "Preset saving unavailable" placeholder instead of the save/load UI.

`buildPresetsPanel(host, sliderState)` (internal, not exported) builds the Presets tab: a "Save
current sliders" card (name input + Save button, with an overwrite confirmation if the name
already exists) and a "Saved states" card listing every saved name with a relative timestamp,
a Load button (`sliderState.apply`), and a Delete button (`sliderState.remove`).
```

- [x] **Step 2: Update `docs/subsystems/entry-point.md`**

In the static imports table, add a row after the `multiplayer.js` import row:

```
| `{ listStates, saveState, deleteState }` from `./slider-state.js` (aliased `listSliderStates`/`saveSliderState`/`deleteSliderState`) | named `localStorage`-backed slider-preset storage, shared with `start-screen.js` |
```

In the "UI integration point" section, find:

```
`environment-ui.js`'s `createEnvironmentUi({ perfLog })` is called once, at line 2452, after all
```

Replace with:

```
`environment-ui.js`'s `createEnvironmentUi({ perfLog, sliderState })` is called once, at line
2452 (now shifted by the edits in this change), after all
```

At the end of the "Startup sequence" section, after item 17's description, add a new note:

```
Also at step 17, immediately before `dismiss()`: if the start screen returned a `presetName`
(chosen from the "Load preset" dropdown on the role-select screen), `applySliderState(...)` is
called against that saved state's values. This is the earliest point every slider/select/toggle
control — including the ones built inside the async grass/water/clouds/sky sub-promises — is
guaranteed to have finished registering itself into `controlRegistry` (see the new
"Slider state presets" section below).
```

Add a new section near the end of the doc, after "Camera / control modes":

```markdown
## Slider state presets

Every control built via the `slider()`/`select()`/`toggle()` factories (Forest, Lighting,
Terrain/Water, Post FX, Grass, Clouds, Sky sections — everything in the "Scene controls"/`#ctrl`
panel) self-registers into a module-level `controlRegistry` array as it's built:
`{ name, obj, key, sync, onChange }`, where `name` is `'<objName>.<key>'` (`objName` defaults to
`'params'`; the `rigP`/`terrain`/`SKY_PARAMS` slider calls pass it explicitly).

- `captureSliderState()` reads `obj[key]` off every registered control into a flat
  `{ [name]: value }` object.
- `applySliderState(values)` writes matching values back into each control's `obj[key]`, calls
  its `sync()` to update the DOM widget, then fires each distinct `onChange` handler once
  (deduped by function identity, since many sliders in one group share a handler like
  `worldRebuild`) so the live subsystem picks up the change.

Both functions, plus `controlRegistry` itself, are declared at the top level of the module
(immediately before `_forestPromise`) rather than inside it, specifically so they're reachable
both from inside the promise chain (where the controls are registered) and from the
`createEnvironmentUi(...)` call site and the final startup gate (where they're consumed) —
`slider()`/`select()`/`toggle()` themselves are defined inside `_forestPromise`'s callback and
close over the outer `controlRegistry`.

Consumers: the Presets tab in `environment-ui.js` (save/load/delete UI) and the start screen's
"Load preset" dropdown (applied once, at the final startup gate, before `dismiss()`).
```

- [x] **Step 3: Update `docs/subsystems/multiplayer.md`**

Find:

```
| `start-screen.js` | Pre-game modal UI: Solo/Host/Join role picker, map picker, loading screen; resolves `{ mapKey, mpRole, roomCode }` before the sim boots | 253 |
```

Replace with (update the line count to the actual new value after editing):

```
| `start-screen.js` | Pre-game modal UI: Solo/Host/Join role picker (with a "Load preset" slider-state dropdown), map picker, loading screen; resolves `{ mapKey, mpRole, roomCode, presetName }` before the sim boots | <NEW_LINE_COUNT> |
```

Find:

```
- `export async function showStartScreen(): Promise<{ mapKey, mpRole, roomCode, setStatus(msg), dismiss() }>`
  — builds a full-screen DOM overlay (no Three.js dependency), walks the user through: role
  choice (Solo / Host / Join) → map choice (host/solo only — guests inherit the host's map) →
  a loading panel, then resolves with the chosen role/room/map and helpers to update the loading
  status text or dismiss the overlay. Internally fetches `maps/map-config.json` for the map list
```

Replace with:

```
- `export async function showStartScreen(): Promise<{ mapKey, mpRole, roomCode, presetName, setStatus(msg), dismiss() }>`
  — builds a full-screen DOM overlay (no Three.js dependency), walks the user through: role
  choice (Solo / Host / Join), each with a "Load preset" dropdown (populated from
  `slider-state.js`'s `listStates()`) that sets `presetName` (or `null` for "None") → map choice
  (host/solo only — guests inherit the host's map) → a loading panel, then resolves with the
  chosen role/room/map/preset and helpers to update the loading status text or dismiss the
  overlay. Internally fetches `maps/map-config.json` for the map list
```

Find:

```
1. `const { mapKey, mpRole, roomCode, setStatus, dismiss } = await showStartScreen();` — blocks
   scene setup until the user picks a role (and map, for host/solo). The resolved `mapKey` is
   later used by `loadTerrainMap`.
```

Replace with:

```
1. `const { mapKey, mpRole, roomCode, presetName, setStatus, dismiss } = await showStartScreen();`
   — blocks scene setup until the user picks a role (and map, for host/solo). The resolved
   `mapKey` is later used by `loadTerrainMap`; `presetName`, if set, is applied via
   `applySliderState(...)` at the very end of startup, right before `dismiss()` (see
   `entry-point.md`'s "Slider state presets" section — this is deferred that late because the
   slider registry isn't complete until every panel, including the async grass/water/clouds/sky
   ones, has been built).
```

- [x] **Step 4: Append to `agent_log.csv`**

Add one row (adjust the date/time to when this step actually runs):

```
2026-07-01T00:00,multi,"slider-state.js;test-slider-state.mjs;environment-viewer.html;environment-ui.js;start-screen.js;docs/subsystems/infra.md;docs/subsystems/entry-point.md;docs/subsystems/multiplayer.md",Added named slider-state presets: a new Presets tab to save/load/delete scene-slider values, plus a start-menu dropdown to load one before the world boots.
```

- [x] **Step 5: Commit**

```bash
git add docs/subsystems/infra.md docs/subsystems/entry-point.md docs/subsystems/multiplayer.md agent_log.csv
git commit -m "docs(infra,entry,multi): document slider-state presets"
```

---

## Self-review notes

- **Spec coverage:** storage module (Task 1), capture/apply registry (Task 2), Presets tab
  (Task 3), start-menu integration (Task 4), overwrite confirmation (Task 3 Step 4), docs/log
  (Task 5) — all design sections have a corresponding task.
- **Naming consistency:** `captureSliderState`/`applySliderState`/`controlRegistry` (Task 2) are
  the exact names referenced by Task 3's `createEnvironmentUi(...)` call site and Task 4's final
  gate — checked against each other, no drift. `listStates`/`saveState`/`deleteState` (Task 1)
  are imported under aliases `listSliderStates`/`saveSliderState`/`deleteSliderState` in
  `environment-viewer.html` (Task 2 Step 1) and used consistently under those aliases in Task 3
  Step 5 and Task 4 Step 4; `start-screen.js` imports `listStates` directly (unaliased, no
  collision risk in that file) in Task 4 Step 1.
- **No placeholders:** every step has literal code. The two doc-table "line count" placeholders
  in Task 5 are intentional — they depend on the exact diff size of prior tasks and are meant to
  be filled from `wc -l` (or equivalent) at doc-update time, not guessed in advance.
