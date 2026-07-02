# Infra / Debug UI

> ðŸ—ºï¸ [View this subsystem in the interactive code map](../../code-map.html#infra)

## Purpose

This subsystem provides per-frame performance instrumentation (`frame-profiler.js`) and the
floating debug/HUD shell (`environment-ui.js`) that displays it. It does **not** own the
scene's tuning controls â€” those sliders live inline in `environment-viewer.html` and are
merely re-parented into the shell's tab layout at runtime (see Architecture notes).

It also includes a small local server control tool (`server-tool.py` +
`server-tool.html`) for starting/stopping the workspace's browser static server and the
multiplayer relay from one dashboard.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `frame-profiler.js` | Tracks CPU pass timings (sync/async) and GPU timestamp/await totals per frame, with EMA smoothing and a flat snapshot for logging/HUD consumption. | 126 |
| `environment-ui.js` | Builds the tabbed `#workshop-ui` shell (Scene/Creatures/Effects/Walk/Perf tabs), re-parents existing DOM panels into it, and builds the read-only "Perf" tab content (live metrics, frame-stage bars, capture controls, raw debug feed). | 648 |
| `server-tool.py` | Local stdlib-only HTTP controller for starting/stopping `serve.py` and `server/server.js`, polling status, and capturing per-process logs. | 244 |
| `server-tool.html` | Browser dashboard served by `server-tool.py`; exposes Start/Restart/Stop/Clear controls, useful launch links, and live logs for each managed server. | 296 |

## Public API

### `frame-profiler.js`

```js
export function createFrameProfiler({ smoothing = 0.2, now = () => performance.now() } = {})
```

Returns:
- `beginFrame()` â€” zeroes the current-frame CPU/GPU pass values (called once at the top of `animate()`).
- `time(name, fn)` â€” runs `fn()` synchronously, records elapsed `now() - t0` under `name`, returns `fn()`'s result.
- `async timeAsync(name, fn)` â€” same as `time` but awaits `fn()`.
- `recordGpu(name, ms)` â€” records a GPU timestamp/duration directly (used for `resolveTimestampsAsync` results and for tagging `postRender`'s GPU cost).
- `markDropped(count = 1)` â€” increments a dropped-frame counter (called when `animate()` re-enters while the previous frame is still in flight).
- `snapshot(prefixMap = DEFAULT_PREFIXES, opts = {})` â€” flattens latest (or, with `{ smooth: true }`, EMA-smoothed) values into an object keyed by the prefix map's mapped names (e.g. `passCreaturesMs`, `gpuGrassMs`), plus a derived `passGpuAwaitMs` (sum of the awaited GPU-bound passes: grass/forest/cdlod/lights/particles/post) and `droppedFrames`.
- `reset()` â€” clears all maps and the dropped-frame counter.

Pass names tracked: `sky, terrainWindow, creatures, water, hud, grassGpu, forestGpu, cdlodGpu, lightsGpu, particlesGpu, postRender` (`DEFAULT_NAMES`). GPU-only counters add `computeTotal` and `renderTotal`.

### `environment-ui.js`

```js
export function createEnvironmentUi({ perfLog } = {})
```

Builds and appends the `#workshop-ui` `<aside>` to `document.body`, installs its stylesheet once (`#workshop-ui-style`), and returns:
- `activate(tabId)` â€” switches the active tab (`scene | creatures | effects | walk | perf`).
- `updatePerf` â€” bound to the internal `host._updatePerf(snapshot)` function built in `buildPerfPanel`; renders one perf-log snapshot into the Perf tab (metrics, sparkline, scene-figures rows, per-stage timing bars, capture button state).

`buildPerfPanel(host, perfLog)` (internal, not exported) constructs the Perf tab's cards: Live overview (FPS/Frame/CPU/GPU/Draws/Tris + sparkline canvas), Scene figures (creatures/terrain/grass/water/forest/memory text rows), Frame stages (one row per `PERF_ROWS` entry with a colored progress bar), Capture (record/CSV/clear buttons wired to `perfLog`), and Raw debug (re-parents the existing `#terrain-debug` element).

`PERF_ROWS` (module-level, not exported): array of `[passId, displayLabel, snapshotKey]` tuples mapping profiler pass ids to HUD labels:
`terrainWindowâ†’"Terrain window"`, `creaturesâ†’"Creatures"`, `waterâ†’"Water"`, `grassGpuâ†’"Grass GPU"`, `forestGpuâ†’"Forest GPU"`, `cdlodGpuâ†’"CDLOD GPU"`, `lightsGpuâ†’"Lights GPU"`, `particlesGpuâ†’"Particles GPU"`, `postRenderâ†’"Render submit"` (relabeled `"Render + post"` when post FX is on), each keyed against `passTerrainWindowMs`, `passCreaturesMs`, etc. (Note: `sky` and `hud` are profiled passes in `frame-profiler.js` but have no row in `PERF_ROWS` â€” they aren't surfaced in the HUD.)

### Server tool

Run:

```powershell
python server-tool.py [port]
```

The tool defaults to `http://127.0.0.1:8099/server-tool.html`. It serves only the
dashboard and JSON API; the dashboard then starts the actual managed processes:

- `static` starts `python serve.py <port>` from the repo root. This is the static
  HTTP server needed by `environment-viewer.html`, `tree-viewer.html`,
  `stellar-viewer.html`, `biome-explainer.html`, and other module-based pages.
- `relay` starts `node server.js` in `server/` with `PORT=<port>`. This is the
  local WebSocket relay used by multiplayer.

Both managed servers default to port `8080`, so for local multiplayer testing the usual
setup is to run the static server on another port, such as `8001`, and leave the relay
on `8080`. The dashboard exposes an "Open with local relay" link when both are running,
using:

```text
http://127.0.0.1:<static-port>/environment-viewer.html?relay=ws://localhost:<relay-port>
```

Implementation notes: `server-tool.py` keeps one `subprocess.Popen` per managed server,
captures stdout/stderr into an in-memory ring buffer, exposes `/api/status`,
`/api/logs`, `/api/start`, `/api/stop`, `/api/restart`, and `/api/clear-logs`, and
terminates managed processes on Ctrl+C. If the relay exits immediately with a missing
`ws` import, install dependencies in `server/` with `npm install`.

## Wiring (`environment-viewer.html`)

Both modules are static imports at the top of the file:
```js
import { createFrameProfiler } from './frame-profiler.js';   // line 46
import { createEnvironmentUi } from './environment-ui.js';   // line 47
```

- `const frameProfiler = createFrameProfiler({ smoothing: 0.2 });` â€” line 334, module-level singleton.
- `environmentUi = createEnvironmentUi({ perfLog });` â€” line 2452, created once the `#ctrl` panel, `#port-creature-ui`, and `#fps` elements already exist in the DOM.

Per-frame, inside `animate()` (~line 2755 onward):
1. `frameProfiler.beginFrame()` (guarded by a `_frameBusy` re-entrancy flag; a dropped/overlapping frame instead calls `frameProfiler.markDropped()`).
2. `frameProfiler.time('sky', â€¦)` â€” sky/moonlight update.
3. `frameProfiler.time('terrainWindow', â€¦)` â€” clouds, FPS-mode player step, terrain window update.
4. `frameProfiler.time('creatures', () => portCreatures.update(rawDt))`.
5. `frameProfiler.time('water', â€¦)` â€” water reflection/refraction/caustics + draw prep.
6. `frameProfiler.time('hud', () => updateTerrainDebug(now))`.
7. `await frameProfiler.timeAsync('grassGpu', () => grassRef.update(...))`.
8. `await frameProfiler.timeAsync('forestGpu', () => forestGPURef.update())`.
9. `await frameProfiler.timeAsync('cdlodGpu', () => cdlodRef.update())`.
10. `await frameProfiler.timeAsync('lightsGpu', () => clusteredLightsRef.update(...))`.
11. `await frameProfiler.timeAsync('particlesGpu', â€¦)` â€” particle field updates.
12. `await frameProfiler.timeAsync('postRender', â€¦)` â€” `postFX.renderAsync()` or plain `renderer.render(scene, camera)`.
13. `await resolveFrameTimestamps()` â€” when `TIMESTAMP_MODE === 'on'`, calls `renderer.resolveTimestampsAsync(...)` for compute/render GPU timestamps and feeds them in via `frameProfiler.recordGpu('computeTotal', â€¦)` / `recordGpu('renderTotal', â€¦)` / `recordGpu('postRender', â€¦)`.

`frameProfiler.reset()` is called from `perfLog.clear()` (~line 539).

Consumption: `perfLog.snapshot(now)` (the page's own perf-log object, ~line 480-508) spreads `...frameProfiler.snapshot()` alongside other scene/terrain/water/forest stats into one flat object written to CSV rows. `updatePerfPanel(now)` (~line 545, throttled to every 250ms) calls `environmentUi.updatePerf(perfLog.snapshot(now))`, which drives the Perf-tab rendering in `environment-ui.js` (`host._updatePerf`). The Frame-stages cards there read `snapshot[key]` for each `PERF_ROWS` entry (e.g. `snapshot.passCreaturesMs`) and color-code bars at >16.7ms (warn) / >33ms (bad).

## Architecture notes

`environment-ui.js` is **not** where the subsystem tuning sliders (terrain, water, grass, forest, sky, lights) are defined â€” confirmed by reading both files. Those are built entirely inline in `environment-viewer.html`'s "control panel" section (~line 1507 onward), which constructs the `#ctrl` floating panel itself (own `<style>` block, drag handling, minimize button) plus a local `slider(key, label, min, max, step, fmt, onChange, obj)` helper and a `header(text)` helper that opens collapsible `.sec` sections. The section titles built there are: `Forest`, `Tree LOD`, `Lighting`, `Scene`, `Post`, `Particles`, `Grass` (x2), `Water`, `Water Reflection`, `Water LOD`, `Clouds (layer 1)`, `Clouds (layer 2)`, `Sky`.

`environment-ui.js`'s `createEnvironmentUi` only builds a tabbed *shell* and, via `mountCtrl()`/`routeSections()` (a `MutationObserver` on `#ctrl-body`), re-parents the already-built `#ctrl` panel's `.sec` children into either its `scene` or `effects` tab panel â€” sorted purely by section title against a hardcoded `effectsNames` set (`Post`, `Particles`, `Water`, `Clouds`, `Sky`; everything else, e.g. `Forest`/`Lighting`/`Scene`/`Grass`, lands in `scene`). A separate `mountFixedUi()` (driven by a `MutationObserver` on `document.body`) re-parents `#port-creature-ui` into the `creatures` tab and `#fps` into the `walk` tab. None of these controls are authored by `environment-ui.js` â€” it only relocates existing DOM and restyles it via CSS overrides (the large `!important` block in `installStyle()`).

The one piece of UI `environment-ui.js` genuinely *builds* (not just re-hosts) is the Perf tab: the live-metrics cards, sparkline, per-stage timing bars, and capture controls â€” all read-only, driven by `perfLog`/`frameProfiler` snapshots, with no sliders or settings of its own.

So the real division of labor: `environment-viewer.html` owns all interactive scene/tuning controls (sliders, dropdowns, toggles) and all per-frame profiler instrumentation calls; `environment-ui.js` owns layout/chrome (tabbed shell + CSS) and the read-only performance HUD, while passively absorbing the other modules' pre-built panels into its tabs.

## Tests

`test-frame-profiler.mjs` (repo root) is a standalone Node script (`node test-frame-profiler.mjs`, no test runner/framework â€” uses a manual `ok(cond, msg)` counter and `process.exit(fail ? 1 : 0)`). It exercises `createFrameProfiler` with an injected fake clock (`now: () => t`, `smoothing: 1`) and checks:
- `time()` returns the wrapped function's result and records elapsed sync time under the given pass name (`passCreaturesMs`).
- Snapshot fields for passes that were never recorded default to `0` (`passGrassMs`).
- `timeAsync()` returns the awaited result and records elapsed async time (`passGrassMs`).
- `recordGpu()` surfaces both a named GPU field (`gpuGrassMs`) and an aggregate field (`gpuComputeMs`).
- `passGpuAwaitMs` sums only the awaited GPU-bound passes (verified as `6.5`, i.e. just the `grassGpu` `timeAsync` call â€” `recordGpu` calls don't contribute to it).
- `markDropped()` (default and with an explicit count) accumulates into `droppedFrames`.
- `reset()` clears both CPU pass fields and GPU fields and zeroes `droppedFrames`.

It does not test `environment-ui.js` (which is DOM-dependent and has no test coverage in this repo).

