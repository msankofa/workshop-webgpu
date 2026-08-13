# Weapon GLB Compression — Spec + Implementation Plan

> **For agentic workers:** Execute inline (`superpowers:executing-plans` style — direct Edit/
> Write/Bash in the main session). Steps use checkbox (`- [ ]`) syntax for tracking. This doc is
> both the spec and the plan (no separate spec file) — the Goal/Architecture/Layout sections below
> are the design; everything from Task 1 onward is the build order.

## Goal

Weapon models in `models/guns/*.glb` (69KB–1.6MB currently) are large enough to contribute to
runtime lag. Port the compression pipeline from `research/glb-shrink-main.zip` (mesh simplify +
Draco geometry compression + WebP textures, built on `@gltf-transform`/`meshoptimizer`/`sharp`)
into this repo as a local Node service, and add a **Compress** panel to a new
`weapon-viewer-v2.html` (a copy of `weapon-anchor-editor.html`, which is left untouched) that lets
you compress the currently-loaded weapon's `.glb` in place, see before/after stats, and roll back
to any earlier version.

## Architecture

Three new pieces, two extended:

1. **`glb-shrink-server/`** — new Node/Express service (own `package.json`, sibling to `server/`),
   adapted from `glb-shrink-main`'s `server/compress.mjs` / `inspect.mjs`. Operates on files
   already in `models/guns/` by repo-relative path (no upload step — the caller already knows the
   weapon's model path from `weapons.js`).
2. **`glb-shrink-presets.mjs`** (repo root) — the compression-quality preset math (`SMALLEST` /
   `BALANCED` / `SHARPEST`, 0–100 fine-tune interpolation, hint text), ported unchanged from the
   zip's `server/presets.mjs`. It's pure/dependency-free, so it's imported directly by both the
   Node server and `weapon-viewer-v2.html` (served statically) — one copy, not a manually-synced
   twin.
3. **`weapon-viewer-v2.html`** — copy of `weapon-anchor-editor.html` plus a new Compress panel
   section.
4. **`server-tool.py` / `server-tool.html`** — gain a third managed process (`compress`, alongside
   `static` and `relay`) so the compression server starts/stops/logs from the same dashboard.
5. **Docs** — new subsystem doc, `infra.md` update, root `CLAUDE.md` table row, `code-map.html`
   entries.

Every compression run reads from the archived **original**, never from whatever is currently live
— otherwise re-compressing an already-simplified/WebP'd mesh would compound quality loss run after
run. This means every past run is always derivable losslessly (relative to itself) and presets can
be experimented with freely.

## Storage & versioning layout

For `models/guns/low-poly_m1911.glb`:

```
models/guns/.glb-shrink/low-poly_m1911/
  original.glb          # pristine backup, written once on first-ever compress of this file
  runs/
    2026-07-20T01-15-22-000Z-balanced.glb
    2026-07-20T01-18-40-000Z-sharpest.glb
    ...                  # every compressed output ever generated, kept
  index.json             # ordered log: one record per compress/restore action
```

`models/guns/low-poly_m1911.glb` itself (the live file `weapons.js` points at) is overwritten in
place — no path/reference changes needed elsewhere in the codebase. This archive directory is
committed to git, same as the weapon models themselves (not gitignored).

`index.json` record shapes:
```json
{ "timestamp": "2026-07-20T01:15:22.000Z", "action": "compress", "quality": 50,
  "profile": { "simplifyRatio": 0.008, "simplifyError": 0.02, "textureEdge": 384 },
  "sourceSize": 1699000, "outputSize": 210000, "sourceTris": 84213, "finalTris": 6100,
  "runFile": "2026-07-20T01-15-22-000Z-balanced.glb" }
```
```json
{ "timestamp": "2026-07-20T01:20:00.000Z", "action": "restore", "restoredFrom": "original.glb" }
```

## Non-goals

- No change to `weapon-anchor-editor.html` (stays as the v1 tool, untouched).
- No automatic re-placement of anchors after compression — mesh shape shifts slightly (fewer
  triangles, rebaked normals); you use the existing anchor-placement tools in the new viewer to
  nudge anything that drifted. `weapon-anchors.json` itself is unaffected by compression (separate
  file, keyed by weapon id).
- No drag-and-drop upload of arbitrary files — the panel only ever operates on the weapon currently
  selected in the viewer, resolved through `weapons.js`'s `WEAPONS[id].model`.

---

## Task 1: Shared presets module

**Files:**
- Create: `glb-shrink-presets.mjs` (repo root)

- [ ] **Step 1:** Extract the preset logic unchanged from the research zip:
  ```
  unzip -p research/glb-shrink-main.zip glb-shrink-main/server/presets.mjs > glb-shrink-presets.mjs
  ```
  Verify it exports `PRESETS`, `resolveSettings(qualityInput)`, `getPresetHint(quality)` — no
  edits needed, it has zero imports.

## Task 2: `glb-shrink-server/` — compression pipeline + package scaffold

**Files:**
- Create: `glb-shrink-server/package.json`
- Create: `glb-shrink-server/compress.mjs`
- Create: `glb-shrink-server/inspect.mjs`

- [ ] **Step 1:** Extract the pipeline files unchanged (they're pure buffer-in/buffer-out modules,
  no changes needed — `compress.mjs` doesn't import the presets module itself, it just takes a
  `profile` object from the caller):
  ```
  mkdir -p glb-shrink-server
  unzip -p research/glb-shrink-main.zip glb-shrink-main/server/compress.mjs > glb-shrink-server/compress.mjs
  unzip -p research/glb-shrink-main.zip glb-shrink-main/server/inspect.mjs > glb-shrink-server/inspect.mjs
  ```

- [ ] **Step 2:** Write `glb-shrink-server/package.json`:
  ```json
  {
    "name": "glb-shrink-server",
    "version": "1.0.0",
    "type": "module",
    "private": true,
    "scripts": { "start": "node index.mjs" },
    "dependencies": {
      "@gltf-transform/core": "^4.3.0",
      "@gltf-transform/extensions": "^4.3.0",
      "@gltf-transform/functions": "^4.3.0",
      "cors": "^2.8.5",
      "draco3dgltf": "^1.5.7",
      "express": "^4.21.2",
      "meshoptimizer": "^1.1.1",
      "sharp": "^0.34.5"
    },
    "engines": { "node": ">=18" }
  }
  ```
  (Dropped `multer` — no upload endpoint needed. Kept `cors` since `weapon-viewer-v2.html` and this
  server run on different ports.)

## Task 3: `glb-shrink-server/index.mjs` — archive-aware API

**Files:**
- Create: `glb-shrink-server/index.mjs`

- [ ] **Step 1:** Write the server. Path safety mirrors `serve.py`'s `_safe_under_maps` pattern
  (resolve, then require the result to stay under `models/guns/`):

  ```js
  import express from 'express';
  import cors from 'cors';
  import path from 'node:path';
  import fs from 'node:fs/promises';
  import { fileURLToPath } from 'node:url';
  import { compressBuffer } from './compress.mjs';
  import { inspectBuffer } from './inspect.mjs';
  import { PRESETS, resolveSettings, getPresetHint } from '../glb-shrink-presets.mjs';

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(__dirname, '..');
  const GUNS_DIR = path.join(ROOT, 'models', 'guns');
  const PORT = Number(process.env.PORT) || 3847;

  function resolveGlbPath(relPath) {
    if (typeof relPath !== 'string' || !relPath.toLowerCase().endsWith('.glb')) {
      throw new Error('path must be a .glb file');
    }
    const cleaned = relPath.replace(/^models[\\/]guns[\\/]/, '');
    const abs = path.resolve(GUNS_DIR, cleaned);
    if (abs !== GUNS_DIR && !abs.startsWith(GUNS_DIR + path.sep)) {
      throw new Error('path escapes models/guns/');
    }
    return abs;
  }

  function archiveDirFor(absPath) {
    return path.join(GUNS_DIR, '.glb-shrink', path.basename(absPath, '.glb'));
  }

  async function exists(p) {
    return fs.access(p).then(() => true, () => false);
  }
  async function readIndex(archiveDir) {
    try {
      return JSON.parse(await fs.readFile(path.join(archiveDir, 'index.json'), 'utf-8'));
    } catch {
      return [];
    }
  }
  async function writeIndex(archiveDir, records) {
    await fs.writeFile(path.join(archiveDir, 'index.json'), JSON.stringify(records, null, 2));
  }
  function timestampId() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/presets', (_req, res) => {
    res.json(PRESETS.map(({ id, label, hint, quality }) => ({ id, label, hint, quality })));
  });

  app.post('/api/inspect', async (req, res) => {
    try {
      const abs = resolveGlbPath(req.body.path);
      const buffer = await fs.readFile(abs);
      const stats = await inspectBuffer(buffer);
      res.json({ path: req.body.path, fileSize: buffer.length, ...stats });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/history', async (req, res) => {
    try {
      const abs = resolveGlbPath(req.query.path);
      const archiveDir = archiveDirFor(abs);
      const records = await readIndex(archiveDir);
      const hasOriginal = await exists(path.join(archiveDir, 'original.glb'));
      res.json({ hasOriginal, records });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/compress', async (req, res) => {
    try {
      const abs = resolveGlbPath(req.body.path);
      const archiveDir = archiveDirFor(abs);
      const runsDir = path.join(archiveDir, 'runs');
      await fs.mkdir(runsDir, { recursive: true });

      const originalPath = path.join(archiveDir, 'original.glb');
      if (!(await exists(originalPath))) await fs.copyFile(abs, originalPath);

      const settings = resolveSettings(req.body.quality);
      const { quality, ...profile } = settings;
      const sourceBuffer = await fs.readFile(originalPath);
      const { buffer, stats } = await compressBuffer(sourceBuffer, profile);

      const preset = PRESETS.find(p => p.quality === Math.round(quality));
      const label = preset ? preset.id : `q${Math.round(quality)}`;
      const runFile = `${timestampId()}-${label}.glb`;
      await fs.writeFile(path.join(runsDir, runFile), buffer);
      await fs.copyFile(path.join(runsDir, runFile), abs);

      const records = await readIndex(archiveDir);
      const record = {
        timestamp: new Date().toISOString(),
        action: 'compress',
        quality,
        profile,
        sourceSize: sourceBuffer.length,
        outputSize: buffer.length,
        sourceTris: stats.sourceTris,
        finalTris: stats.finalTris,
        runFile,
      };
      records.push(record);
      await writeIndex(archiveDir, records);

      res.json({ ok: true, record, hint: getPresetHint(quality) });
    } catch (err) {
      console.error('compress failed:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/restore', async (req, res) => {
    try {
      const abs = resolveGlbPath(req.body.path);
      const archiveDir = archiveDirFor(abs);
      const runFile = req.body.runFile;
      let sourcePath;
      if (runFile === 'original.glb') {
        sourcePath = path.join(archiveDir, 'original.glb');
      } else {
        const records = await readIndex(archiveDir);
        if (!records.some(r => r.runFile === runFile)) throw new Error('unknown run file');
        sourcePath = path.join(archiveDir, 'runs', runFile);
      }
      await fs.copyFile(sourcePath, abs);

      const records = await readIndex(archiveDir);
      records.push({ timestamp: new Date().toISOString(), action: 'restore', restoredFrom: runFile });
      await writeIndex(archiveDir, records);

      const stats = await inspectBuffer(await fs.readFile(abs));
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`glb-shrink-server listening on http://127.0.0.1:${PORT}`);
  });
  ```

- [ ] **Step 2:** `cd glb-shrink-server && npm install` — confirm it completes (sharp/draco3dgltf
  pull prebuilt native binaries, no local compiler needed on Windows).

## Task 4: `server-tool.py` — third managed process

**Files:**
- Modify: `server-tool.py`

- [ ] **Step 1:** Add a `"compress"` entry to `SERVERS` (after `"relay"`):
  ```python
  "compress": {
      "label": "GLB compression",
      "description": "Runs glb-shrink-server for the weapon-viewer-v2 Compress panel.",
      "defaultPort": 3847,
      "urlPath": "",
  },
  ```

- [ ] **Step 2:** In `ManagedProcess.start()`, add a branch alongside `"relay"`:
  ```python
  elif self.server_id == "compress":
      command = ["node", "index.mjs"]
      cwd = ROOT / "glb-shrink-server"
      env = os.environ.copy()
      env["PORT"] = str(self.port)
  ```

## Task 5: `server-tool.html` — card wiring for the new process

**Files:**
- Modify: `server-tool.html`

- [ ] **Step 1:** In `serverUrl(id, port)`, add:
  ```js
  if (id === "compress") return `http://127.0.0.1:${port}/api/health`;
  ```

- [ ] **Step 2:** In `detailText(id, st)`, extend the final ternary into an explicit check so
  `"compress"` gets its own hint instead of falling into the static-server text:
  ```js
  if (id === "relay") return "Requires Node and server/node_modules/ws. If it exits immediately, run npm install in server/.";
  if (id === "compress") return "Requires Node and glb-shrink-server/node_modules. If it exits immediately, run npm install in glb-shrink-server/.";
  return "Serves browser entry points such as environment-viewer.html, tree-viewer.html, and biome-explainer.html.";
  ```

## Task 6: `weapon-viewer-v2.html` — copy + Compress panel

**Files:**
- Create: `weapon-viewer-v2.html` (copy of `weapon-anchor-editor.html`)

- [ ] **Step 1:** Copy the file:
  ```
  cp weapon-anchor-editor.html weapon-viewer-v2.html
  ```

- [ ] **Step 2:** In `weapon-viewer-v2.html`, add the presets import alongside the existing
  imports (near `import { WEAPONS } from './weapons.js';`):
  ```js
  import { PRESETS, getPresetHint } from './glb-shrink-presets.mjs';
  ```

- [ ] **Step 3:** Insert a new panel section right after the existing `filePicker` wiring block
  (after the `filePicker.addEventListener('change', ...)` block, before the `// --- Anchor
  section ---` comment). Uses the file's existing `h2()`/`row()`/`hint()` panel-builder helpers so
  it matches the rest of the panel's construction style:

  ```js
  // --- Compress section ---
  h2('Compress');
  const compressPortRow = row();
  const compressPortLbl = document.createElement('span');
  compressPortLbl.className = 'lbl';
  compressPortLbl.textContent = 'API port';
  const compressPortInput = document.createElement('input');
  compressPortInput.type = 'number';
  compressPortInput.style.width = '70px';
  compressPortInput.value = localStorage.getItem('pcw:glbShrinkPort') || '3847';
  compressPortRow.appendChild(compressPortLbl);
  compressPortRow.appendChild(compressPortInput);
  function compressApiBase() { return `http://127.0.0.1:${compressPortInput.value}`; }
  compressPortInput.addEventListener('change', () => {
    localStorage.setItem('pcw:glbShrinkPort', compressPortInput.value);
    refreshCompressStats();
  });

  hint('Requires glb-shrink-server running (server-tool.py "GLB compression", or `node glb-shrink-server/index.mjs`).');
  const compressStatsEl = hint('—');

  const presetGrid = document.createElement('div');
  presetGrid.className = 'btn-grid3';
  panel.appendChild(presetGrid);
  for (const preset of PRESETS) {
    const btn = document.createElement('button');
    btn.textContent = preset.label;
    btn.title = preset.hint;
    btn.addEventListener('click', () => { qualitySlider.value = preset.quality; updateQualityHint(); });
    presetGrid.appendChild(btn);
  }

  const qualitySlider = document.createElement('input');
  qualitySlider.type = 'range';
  qualitySlider.min = '0';
  qualitySlider.max = '100';
  qualitySlider.value = '50';
  qualitySlider.style.width = '100%';
  panel.appendChild(qualitySlider);
  const qualityHintEl = hint('');
  function updateQualityHint() { qualityHintEl.textContent = getPresetHint(qualitySlider.value); }
  qualitySlider.addEventListener('input', updateQualityHint);
  updateQualityHint();

  const compressRow = row();
  const compressBtn = document.createElement('button');
  compressBtn.textContent = 'Compress model';
  compressBtn.className = 'full';
  compressRow.appendChild(compressBtn);
  const compressResultEl = hint('');

  h2('Compression history');
  const historyListEl = document.createElement('div');
  panel.appendChild(historyListEl);

  function currentWeaponModelPath() {
    return WEAPONS[currentWeaponId]?.model || null;
  }

  function historyRow(label, btnLabel, onClick) {
    const r = document.createElement('div');
    r.className = 'row';
    const span = document.createElement('span');
    span.className = 'lbl';
    span.textContent = label;
    const btn = document.createElement('button');
    btn.textContent = btnLabel;
    btn.addEventListener('click', onClick);
    r.appendChild(span);
    r.appendChild(btn);
    return r;
  }

  async function refreshCompressStats() {
    const modelPath = currentWeaponModelPath();
    if (!modelPath) { compressStatsEl.textContent = 'No model for this weapon.'; return; }
    try {
      const res = await fetch(compressApiBase() + '/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: modelPath }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
      compressStatsEl.textContent = `${(data.fileSize / 1024).toFixed(0)} KB, ${data.tris.toLocaleString()} tris`;
    } catch (err) {
      compressStatsEl.textContent = 'Compression server not reachable on port ' + compressPortInput.value + '.';
    }
    await refreshHistory();
  }

  async function refreshHistory() {
    const modelPath = currentWeaponModelPath();
    historyListEl.innerHTML = '';
    if (!modelPath) return;
    try {
      const res = await fetch(compressApiBase() + '/api/history?path=' + encodeURIComponent(modelPath));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      if (data.hasOriginal) {
        historyListEl.appendChild(historyRow('Original (uncompressed)', 'Restore', () => restoreRun('original.glb')));
      }
      const compresses = data.records.filter(r => r.action === 'compress').slice().reverse();
      for (const rec of compresses) {
        const label = `${rec.timestamp.slice(0, 16).replace('T', ' ')} — ${(rec.outputSize / 1024).toFixed(0)} KB, ${rec.finalTris.toLocaleString()} tris`;
        historyListEl.appendChild(historyRow(label, 'Restore', () => restoreRun(rec.runFile)));
      }
      if (!data.hasOriginal && compresses.length === 0) historyListEl.textContent = 'No compressions yet.';
    } catch {
      historyListEl.textContent = '';
    }
  }

  compressBtn.addEventListener('click', async () => {
    const modelPath = currentWeaponModelPath();
    if (!modelPath) return;
    if (!confirm(`Compress ${modelPath}? The live file will be overwritten (original + every past run are kept and restorable below).`)) return;
    compressBtn.disabled = true;
    compressResultEl.textContent = 'Compressing…';
    try {
      const res = await fetch(compressApiBase() + '/api/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: modelPath, quality: Number(qualitySlider.value) }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
      const pct = 100 - Math.round((data.record.outputSize / data.record.sourceSize) * 100);
      compressResultEl.textContent = `${(data.record.sourceSize / 1024).toFixed(0)}KB -> ${(data.record.outputSize / 1024).toFixed(0)}KB (-${pct}%), ${data.record.sourceTris.toLocaleString()} -> ${data.record.finalTris.toLocaleString()} tris.`;
      await loadModelFromUrl(modelPath + '?v=' + Date.now());
      await refreshCompressStats();
    } catch (err) {
      compressResultEl.textContent = 'Compress failed: ' + err.message;
    } finally {
      compressBtn.disabled = false;
    }
  });

  async function restoreRun(runFile) {
    const modelPath = currentWeaponModelPath();
    if (!modelPath) return;
    const what = runFile === 'original.glb' ? 'the original uncompressed model' : 'this compressed version';
    if (!confirm(`Restore ${what}? This overwrites the current live file.`)) return;
    try {
      const res = await fetch(compressApiBase() + '/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: modelPath, runFile }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
      compressResultEl.textContent = 'Restored.';
      await loadModelFromUrl(modelPath + '?v=' + Date.now());
      await refreshCompressStats();
    } catch (err) {
      showError('Restore failed: ' + err.message);
    }
  }

  weaponSelect.addEventListener('change', refreshCompressStats);
  ```

- [ ] **Step 4:** In the existing `// ===================== init =====================` block at
  the bottom of the file, add a call to seed the panel on load:
  ```js
  rebuildMarkersForCurrentWeapon();
  loadModelFromUrl(WEAPONS[currentWeaponId].model).catch(err => showError('Failed to load default model: ' + err.message));
  refreshCompressStats();
  ```

- [ ] **Step 5:** Update the `#info` banner text and `<title>` in `weapon-viewer-v2.html` to
  distinguish it from v1 (e.g. title `Weapon Viewer v2`, info line mentioning the Compress panel).

## Task 7: Docs

- [ ] **Step 1:** Create `docs/subsystems/weapon-compression.md` covering: purpose, the
  `glb-shrink-server` API (`/api/inspect`, `/api/history`, `/api/compress`, `/api/restore`), the
  `models/guns/.glb-shrink/<weapon>/` archive layout and `index.json` record shape, the
  "always compress from `original.glb`" invariant, the shared `glb-shrink-presets.mjs` module, and
  the `weapon-viewer-v2.html` Compress panel's controls.

- [ ] **Step 2:** Update `docs/subsystems/infra.md`'s "Server tool" section to list the third
  managed process (`compress` → `glb-shrink-server/index.mjs`, default port 3847) alongside
  `static` and `relay`.

- [ ] **Step 3:** Add a `weapon-compression` row to the subsystem table in
  `workshop-webgpu/CLAUDE.md`, pointing at `weapon-compression.md` /
  `glb-shrink-server.js, weapon-viewer-v2.html`.

- [ ] **Step 4:** Add `weapon-compression.md` to `code-map.html`'s `DOC_LIST` and add
  `glb-shrink-server/index.mjs`, `glb-shrink-presets.mjs`, `weapon-viewer-v2.html` to
  `GROUP_DOCS` under the new subsystem, following the existing entries' shape.

- [ ] **Step 5:** Append a row to `agent_log.csv`:
  `<ISO date>,multi,"glb-shrink-server/*;glb-shrink-presets.mjs;weapon-viewer-v2.html;server-tool.py;server-tool.html;docs/subsystems/weapon-compression.md;docs/subsystems/infra.md;CLAUDE.md;code-map.html",Added weapon GLB compression pipeline (Draco+WebP) with versioned original/run archive, wired into a new weapon-viewer-v2.html Compress panel.`

## Task 8: Manual verification

- [ ] **Step 1:** `cd glb-shrink-server && npm install` (if not already done in Task 3).
- [ ] **Step 2:** `python server-tool.py`, open the dashboard, start `static` and `compress`.
- [ ] **Step 3:** Open `http://127.0.0.1:<static-port>/weapon-viewer-v2.html`. Confirm the Compress
  panel shows file size/tri count for the default weapon (no "not reachable" message).
- [ ] **Step 4:** Switch to `low-poly_cz_805_bren` (currently the largest, ~1.6MB). Click
  "Balanced", then "Compress model". Confirm: the result line shows a size/tri reduction, the 3D
  view reloads the (now-simplified) model, and `models/guns/.glb-shrink/low-poly_cz_805_bren/`
  now contains `original.glb`, `runs/<...>-balanced.glb`, and `index.json`.
- [ ] **Step 5:** Confirm `models/guns/low-poly_cz_805_bren.glb` on disk actually shrank (compare
  file size to before).
- [ ] **Step 6:** In the History list, click "Restore" on "Original (uncompressed)". Confirm the
  live file and 3D view revert, and `index.json` gained a `restore` record.
- [ ] **Step 7:** Re-open the anchor placement tools (unchanged from v1) and confirm you can still
  select/move/place anchors on the reloaded geometry.
- [ ] **Step 8:** Stop `compress` in the dashboard, reload `weapon-viewer-v2.html`, confirm the
  Compress panel degrades gracefully (shows "not reachable", doesn't throw / block the rest of the
  editor).
