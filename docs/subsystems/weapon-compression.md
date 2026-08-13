# Weapon GLB compression

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#weapon-compression)

## Purpose

Weapon models in `models/guns/*.glb` are large enough to contribute to runtime lag (up to ~1.6MB,
tens of thousands of triangles, uncompressed textures). This subsystem ports the compression
pipeline from `research/glb-shrink-main.zip` (mesh simplification via `MeshoptSimplifier`, Draco
geometry compression, WebP textures — see `@gltf-transform`) into a small local Node service,
`glb-shrink-server/`, and exposes it as a **Compress** panel inside `weapon-viewer-v2.html` (a
copy of `weapon-anchor-editor.html` with the panel added).

## Files

| File | Responsibility |
|---|---|
| `glb-shrink-presets.mjs` | Dependency-free quality-preset math shared by the server and the browser panel: `PRESETS` (`smallest`/`balanced`/`sharpest`), `resolveSettings(quality)` (0–100 fine-tune interpolation between presets), `getPresetHint(quality)` (plain-English hint text). |
| `glb-shrink-server/compress.mjs` | The actual compression pipeline (ported unchanged from `glb-shrink-main`): strip existing Draco/meshopt/quantization extensions, weld, `MeshoptSimplifier` simplify, dedup/prune, rebake smooth normals, `textureCompress` (via `sharp`, WebP output), Draco-encode. `compressBuffer(buffer, profile) -> { buffer, stats }`. |
| `glb-shrink-server/inspect.mjs` | `inspectBuffer(buffer)` — mesh/vertex/triangle counts, bbox, texture list, extensions used. Ported unchanged. |
| `glb-shrink-server/index.mjs` | Express API: path-safe file access under `models/guns/`, the original/run archive, `index.json` history log. |
| `weapon-viewer-v2.html` | Copy of `weapon-anchor-editor.html` + the Compress panel (preset buttons, quality slider, Compress button, restorable history list). |
| `draco-loader.js` | `attachDracoLoader(gltfLoader)` — wires a shared `DRACOLoader` (decoder path pinned to the `three@0.184.0` CDN build) onto a `GLTFLoader` instance. **Required** by every consumer that might load a weapon model, since a compressed weapon carries `KHR_draco_mesh_compression` and `GLTFLoader.parse()` throws without it. |

## Archive & versioning layout

For `models/guns/<name>.glb`:

```
models/guns/.glb-shrink/<name>/
  original.glb          # pristine backup, written once on first-ever compress of this file
  runs/
    <ISO-timestamp>-<preset>.glb   # every compressed output ever generated, kept
  index.json             # ordered log: one record per compress/restore action
```

The live `models/guns/<name>.glb` is overwritten in place on every compress/restore, so
`weapons.js`'s `model` path references never change. This archive directory is committed to git
like the weapon models themselves (not gitignored).

**Invariant:** every compression run reads from `original.glb`, never from whatever is currently
live. Re-compressing an already-simplified/WebP'd file would otherwise compound quality loss
across repeated experiments — the original stays the single source of truth, and every past run
remains restorable losslessly relative to itself.

`index.json` records:
```json
{ "timestamp": "2026-07-20T01:15:22.000Z", "action": "compress", "quality": 50,
  "profile": { "simplifyRatio": 0.008, "simplifyError": 0.02, "textureEdge": 384 },
  "sourceSize": 1699000, "outputSize": 210000, "sourceTris": 84213, "finalTris": 6100,
  "runFile": "2026-07-20T01-15-22-000Z-balanced.glb" }
```
```json
{ "timestamp": "2026-07-20T01:20:00.000Z", "action": "restore", "restoredFrom": "original.glb" }
```

## API (`glb-shrink-server`, default port 3847)

All `path`/`path` query params must be a `models/guns/*.glb`-relative path; anything resolving
outside `models/guns/` is rejected (mirrors `serve.py`'s `_safe_under_maps` pattern).

- `GET /api/health` — `{ ok: true }`
- `GET /api/presets` — `PRESETS` (id/label/hint/quality only)
- `POST /api/inspect { path }` — live-file stats via `inspectBuffer`
- `GET /api/history?path=...` — `{ hasOriginal, records }` from that weapon's `index.json`
- `POST /api/compress { path, quality }` — creates `original.glb` if absent, compresses from it,
  archives the run, overwrites the live file, appends an `index.json` record, returns the record
  + a hint string
- `POST /api/restore { path, runFile }` — `runFile: 'original.glb'` or any archived run filename;
  copies it back over the live file, appends a `restore` record

## Consumers must attach a DRACOLoader

A weapon compressed via this pipeline gets re-encoded with `KHR_draco_mesh_compression`. Three.js's
`GLTFLoader` throws `"No DRACOLoader instance provided"` when it hits that extension without one
attached — this bit every existing weapon-model loader in the repo the first time a real weapon
(`low-poly_cz_805_bren.glb`) was compressed and left compressed, since **nothing previously wired a
DRACOLoader anywhere**. Every `GLTFLoader` that might load a `models/guns/*.glb` must use
`attachDracoLoader()` from `draco-loader.js`:

```js
import { attachDracoLoader } from './draco-loader.js';
const loader = attachDracoLoader(new GLTFLoader());
```

Currently wired: `environment-viewer.html` (`createLocalWeaponViewModel`'s loader, the third-person
local-view weapon-mount loader, and the bot visual weapon-mount loader — three separate
`GLTFLoader` instances), `bot-viewer.html` (weapon-mount loader), `weapon-anchor-editor.html` and
`weapon-viewer-v2.html` (main model loader), `body-preview.html`, `body-preview-v2.html`, and
`body-preview-v3.html` (weapon preview loader). **Any new place that loads a `WEAPONS[id].model`
GLB must do the same** — an uncompressed weapon works fine without it, but there's no way to know
in advance which weapons a future compress pass will touch.

## `weapon-viewer-v2.html` Compress panel

Below the existing Weapon section: an editable API port field (persisted to
`localStorage['pcw:glbShrinkPort']`, default `3847`), live file-size/tri-count stats for the
selected weapon, three preset buttons + a 0–100 fine-tune slider (mirrors `glb-shrink`'s own UX,
same math via `glb-shrink-presets.mjs`), a **Compress model** button (confirms, then POSTs,
reloads the model into the 3D view on success), and a **Compression history** list — one row per
past run (timestamp, size, tri count) plus an "Original (uncompressed)" row, each with a
**Restore** button. If the compression server isn't reachable, the stats line says so and the rest
of the editor (anchor placement, JSON export) still works normally.

Compression changes mesh shape slightly (fewer triangles, rebaked normals), so an anchor placed
before compressing may sit a little off the new surface — `weapon-anchors.json` itself is
untouched by compression (separate file, keyed by weapon id); re-verify/nudge anchors with the
existing placement tools (Anchors section) after compressing, same as any other manual anchor
correction.

## Server tool

`glb-shrink-server` is a third process managed by `server-tool.py`/`server-tool.html` (id
`compress`, default port 3847), alongside `static` and `relay` — see `infra.md`'s Server tool
section. If it exits immediately, run `npm install` in `glb-shrink-server/`.

**Windows/Google-Drive note:** `npm install` in `glb-shrink-server/` pulls `sharp` (many
per-platform prebuilt binary packages). If the repo lives on a Google Drive–synced path, npm's
tarball extraction there can fail with `EBADF`/`EPERM` errors from the streaming filesystem. If
that happens, run `npm install` in a plain local directory (e.g. a temp folder) and copy the
resulting `node_modules/` + `package-lock.json` into `glb-shrink-server/` instead of installing
directly on the synced path.
