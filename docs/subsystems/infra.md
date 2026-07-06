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
| `environment-ui.js` | Builds the tabbed `#workshop-ui` shell (Scene/Creatures/Models/Effects/Walk/Perf/Presets/Audio tabs), re-parents existing DOM panels into it, builds the read-only "Perf" tab content (live metrics, frame-stage bars, capture controls, raw debug feed), builds the "Presets" tab (save/load/delete named slider states via a `sliderState` object passed into `createEnvironmentUi`), and builds the "Audio" tab (SFX folder + volume/mute/output/effects/track controls) when an `audio` controller is passed in. | 1065 |
| `world-map.js` | Bakes the authored terrain map into a selectable data overlay (biome/elevation/slope/material/water/grass/tree) and projects it into the heading-up minimap and the north-up full-screen (M) map. Pure bake/affine/overlay math is unit-tested (`test-world-map.mjs`); canvas/DOM wrappers are browser-only. | 295 |
| `environment-audio.js` | Standalone Web Audio controller (`createEnvironmentAudio(options)`) extracted from the shooter (`html-game-v2/src/game/main.js`) with no `main.js` coupling: mixer + persistence, camera-listener positional SFX, `sound-map.json` folder loading, streamed `music_menu`/`music_game` with processing graph + pitch worklet, and a front/behind/orbit/above speaker orb. Backed by support modules `sound-events.js`, `music-pitch-processor.js` (AudioWorkletProcessor), `asset-paths.js`, `file-handles.js`, `live-updates.js`. | 1050 |
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

Pass names tracked: `sky, terrainWindow, creatures, water, hud, grassGpu, forestGpu, plantsGpu, dressingGpu, cdlodGpu, lightsGpu, particlesGpu, postRender, timestampResolve` (`DEFAULT_NAMES`). GPU-only counters add `computeTotal` and `renderTotal`. `dressingGpu` (snapshot key `passDressingMs`) is the CPU await for the shared rocks/deadfall `dressing-gpu.js` host and folds into `passGpuAwaitMs`; it has a CPU-await prefix only (no GPU-timestamp bucket).

`timestampResolve` â†’ `passTimestampResolveMs` measures the wall-clock cost of `resolveFrameTimestamps()` (the awaited `renderer.resolveTimestampsAsync(...)` calls, only active when `TIMESTAMP_MODE==='on'`). It's zeroed by `beginFrame()` like every other pass, so it reads `0` when timestamps are off. Before this was tracked, that cost (observed ~20ms in timestamps-on captures) was folded silently into `cpuMs` with no corresponding pass column, making `cpuMs` look larger than the sum of all profiled passes.

### `environment-ui.js`

```js
export function createEnvironmentUi({ perfLog, sliderState, audio } = {})
```

Builds and appends the `#workshop-ui` `<aside>` to `document.body`, installs its stylesheet once (`#workshop-ui-style`), and returns:
- `activate(tabId)` â€” switches the active tab (`scene | creatures | models | effects | walk | perf | presets | audio`).
- `updatePerf` â€” bound to the internal `host._updatePerf(snapshot)` function built in `buildPerfPanel`; renders one perf-log snapshot into the Perf tab (metrics, sparkline, scene-figures rows, per-stage timing bars, capture button state).

`sliderState` (optional) is `{ capture(), apply(values), list(), save(name, values), remove(name) }`,
supplied by `environment-viewer.html` (`capture`/`apply` wrap its module-level slider registry;
`list`/`save`/`remove` are re-exported from `slider-state.js`). When omitted, the Presets tab
renders a "Preset saving unavailable" placeholder instead of the save/load UI.

`buildPresetsPanel(host, sliderState)` (internal, not exported) builds the Presets tab: a "Save
current sliders" card (name input + Save button, with an overwrite confirmation if the name
already exists) and a "Saved states" card listing every saved name with a relative timestamp,
a Load button (`sliderState.apply`), and a Delete button (`sliderState.remove`).

`audio` (optional) is an `environment-audio.js`-shaped controller: `{ getState(), subscribe(listener),
pickSfxFolder(), restoreSfxFolder(), setVolume(kind, value), setMuted(kind, muted),
setMusicOutput(mode), setMusicSpeakerBehavior(mode), setMusicEffect(key, value) }`, with `kind` âˆˆ
`{master, music, sfx}`, output `mode` âˆˆ `{global, speaker}`, and speaker behavior âˆˆ
`{front, behind, orbit, above}`. When omitted, the Audio tab renders an "Audio controller
unavailable" placeholder instead.

`buildAudioPanel(host, audio)` (internal, not exported) builds the Audio tab:
- **SFX folder** card â€” `#audio-sfx-pick` (calls `audio.pickSfxFolder()`), `#audio-sfx-restore`
  (calls `audio.restoreSfxFolder()`), and a `#audio-sfx-status` status line.
- **Volume** card â€” one slider + mute checkbox per `kind` âˆˆ `{master, music, sfx}`: sliders
  `#audio-vol-master` / `#audio-vol-music` / `#audio-vol-sfx` (0..1, call `audio.setVolume(kind, v)`)
  and checkboxes `#audio-mute-master` / `#audio-mute-music` / `#audio-mute-sfx` (call
  `audio.setMuted(kind, checked)`).
- **Music output** card â€” a segmented control `#audio-output-group` with buttons
  `#audio-output-global` / `#audio-output-speaker` (call `audio.setMusicOutput(mode)`), and a
  speaker-behavior segmented control `#audio-speaker-group` with buttons `#audio-speaker-front` /
  `#audio-speaker-behind` / `#audio-speaker-orbit` / `#audio-speaker-above` (call
  `audio.setMusicSpeakerBehavior(mode)`).
- **Music processing** card â€” sliders `#audio-fx-bass`, `#audio-fx-echo`, `#audio-fx-reverb`,
  `#audio-fx-attenuation` (each 0..1), `#audio-fx-tempo` (0.5..2), `#audio-fx-pitch` (-12..12
  semitones); each calls `audio.setMusicEffect(key, value)` on input.
- **Track** card (optional playlist browsing) â€” `#audio-track-label` display span plus
  `#audio-track-prev` / `#audio-track-play` / `#audio-track-next` buttons, calling
  `audio.prevTrack() / audio.togglePlayback() / audio.nextTrack()` if the controller implements
  them (guarded with `?.()`; these three methods are not part of the frozen contract listed
  above, so they no-op silently until/unless `environment-audio.js` adds them).

All inputs/buttons render from and refresh via `audio.getState()` (called once at build time, then
again on every `audio.subscribe(listener)` callback). The panel assumes this state shape:
```js
{
  masterVolume, musicVolume, sfxVolume,       // 0..1
  masterMuted, musicMuted, sfxMuted,          // bool
  musicOutput,                                 // 'global' | 'speaker'
  speakerBehavior,                              // 'front' | 'behind' | 'orbit' | 'above'
  effects: { bass, echo, reverb, attenuation, tempo, pitch },
  sfxFolderStatus,                              // display string
  currentTrackLabel,                            // display string
  musicPlaying,                                 // bool
}
```
Any field not present falls back to a sensible default (1 for volumes, `false` for mutes, `'global'`/`'front'`
for output/behavior) rather than throwing, so a partially-implemented controller still renders.

Every pointer (`pointerdown/up/move`, `click`) and keyboard (`keydown/up`, `keypress`) event
originating inside the Audio tab has its propagation stopped at the host panel, so the viewer's
global keyboard shortcuts (`KeyM`/`KeyQ`/`KeyF`/etc., bound at `window`/`document` level in
`environment-viewer.html`) never fire while a user is dragging a slider or typing into an audio
control.

`buildPerfPanel(host, perfLog)` (internal, not exported) constructs the Perf tab's cards: Live overview (FPS/Frame/CPU/GPU/Draws/Tris + sparkline canvas), Scene figures (creatures/terrain/grass/water/forest/memory text rows), Frame stages (one row per `PERF_ROWS` entry with a colored progress bar), Capture (record/CSV/clear buttons wired to `perfLog`), and Raw debug (re-parents the existing `#terrain-debug` element).

`PERF_ROWS` (module-level, not exported): array of `[passId, displayLabel, snapshotKey]` tuples mapping profiler pass ids to HUD labels:
`terrainWindowâ†’"Terrain window"`, `creaturesâ†’"Creatures"`, `waterâ†’"Water"`, `grassGpuâ†’"Grass GPU"`, `forestGpuâ†’"Forest GPU"`, `cdlodGpuâ†’"CDLOD GPU"`, `lightsGpuâ†’"Lights GPU"`, `particlesGpuâ†’"Particles GPU"`, `postRenderâ†’"Render submit"` (relabeled `"Render + post"` when post FX is on), each keyed against `passTerrainWindowMs`, `passCreaturesMs`, etc. (Note: `sky` and `hud` are profiled passes in `frame-profiler.js` but have no row in `PERF_ROWS` â€” they aren't surfaced in the HUD.)

### `environment-audio.js`

`createEnvironmentAudio(options)` returns a controller; the environment viewer owns the audio
mixer/state and the Audio tab in `environment-ui.js` only reads/drives it. Extracted from the
shooter's inline audio block (`html-game-v2/src/game/main.js` ~1624-3314) so **none** of the
shooter runtime is imported — all viewer state is injected through `options`.

Options: `THREE` (required), `scene`, `camera`, `getPlayerPosition()`, `isGameplayActive()`,
optional `isDucked()`, optional `getSpeakerTargets()` (reserved for a future creature-follow
speaker mode), and `workletUrl` (default `./music-pitch-processor.js?v=1`).

Returned methods: `init()`, `noteGesture()`, `update(timestampMs)` (call once per frame after
camera/player movement — refreshes the Web Audio listener and speaker-orb follow),
`loadSfxFolder(dirHandle)`, `pickSfxFolder()`, `restoreSfxFolder()`, `play(eventId, volume?)`,
`playAt(eventId, position, volume?, options?)`, `setVolume(kind, value)` /
`setMuted(kind, muted)` (`kind` = `master`|`music`|`sfx`), `setMusicOutput(mode)`
(`global`|`speaker`), `setMusicSpeakerBehavior(mode)` (`front`|`behind`|`orbit`|`above`),
`setMusicEffect(key, value)` (`bass`|`echo`|`reverb`|`attenuation`|`tempo`|`pitch`),
`getState()`, `subscribe(listener)` (returns an unsubscribe fn), `dispose()`, plus optional
transport `prevTrack()` / `togglePlayback()` / `nextTrack()`.

`getState()` read contract (consumed by the Audio tab; missing keys fall back to UI defaults):
`masterVolume`, `musicVolume`, `sfxVolume`, `masterMuted`, `musicMuted`, `sfxMuted`,
`musicOutput`, `speakerBehavior`, `effects{bass,echo,reverb,attenuation,tempo,pitch}`,
`sfxFolderStatus`, `currentTrackLabel`, `musicPlaying` (plus extra diagnostic fields:
`ready`, `sfxFolderName`, `loadedEvents`, `loadedMusicEvents`, `playlist`, `pendingMusicRetry`,
`pitchAvailable`).

Persistence keys are viewer-specific: settings under `environment-viewer-audio-settings`
(localStorage), the SFX root folder handle under IndexedDB DB `environment-audio-handles` /
key `sfx-root-directory`, folder picker id `environment-audio-sfx-folder`. Live SFX edits from
the source `sfx-browser.html` are received on BroadcastChannel/localStorage `sfx-game` /
`sfx-game-update` (same-origin only). Music base volumes: `0.14` gameplay / `0.16` menu, with
optional `0.06` ducking via `isDucked()`. Deviations from the source: airship music output and
the enemy-follow speaker behavior are omitted. Source compatibility notes live in
`docs/superpowers/plans/2026-07-05-environment-audio-import.md` and `html-game-v2/HTML_GAME.md`.

### `world-map.js`

Renders the authored terrain map into the HUD. Split into pure math (unit-tested in Node) and
browser-only canvas/DOM wrappers.

```js
export function bakeMapPixels({ res, cellWorld, sampleBiomeColor, sampleHeight, isWater, shaded = true })
export function minimapImageAffine({ s, heading, px, pz, cx, cy, wx0, wz0, sxu, szv })
export function bigMapImageAffine({ scale, cx, cy, wx0, wz0, sxu, szv })
export function worldToBigMap(wx, wz, { scale, cx, cy })
export const MAP_OVERLAYS               // [{ id, label }, …] display order for the layer menu
export function overlayColorizer(loadedMap, overlayId)   // { shaded, color(x,z)->[r,g,b] 0..255 }
export function bakeMapCanvas(loadedMap, { res = 384, overlayId = 'biome' } = {})
export function createWorldMapOverlay({ getBake, getLocal, getRemotes, getHeading, getFacing, getOverlayLabel })
```

- `bakeMapPixels` — pure. Builds an RGBA image coloring each cell via `sampleBiomeColor` and, when
  `shaded` (default), multiplying by a Lambert hillshade from the height gradient (`isWater` flattens
  shade on water). Data overlays pass `shaded: false` so their color ramp reads at face value.
- `MAP_OVERLAYS` / `overlayColorizer` — the selectable minimap data layers, all derived from a loaded
  authored map: **biome** (`BIOME_COLORS`, shaded — the default), **elevation** (`heightColor`, shaded),
  **slope** (`slopeColor` of the height gradient, flat), **material** (`surfaceField().materialColor`,
  shaded), **water depth** / **grass density** / **tree density** (ramp colors, flat). `heightColor`
  and `slopeColor` are imported from `terrain-generator-js.js` so the layers match the generator
  preview. The generator also previews continentalness/temperature/humidity/flowNorm, but those noise
  grids are **not** in the exported map data — adding them needs a generator export change + re-export.
- `minimapImageAffine` — pure. Returns the canvas `setTransform` params `[a,b,c,d,e,f]` to blit the
  baked image into the **heading-up** minimap. Derived to agree exactly with the finder's marker
  projection (`X = cx − s·cosh·(wx−px) − s·sinh·(wz−pz)`, `Y = cy + s·sinh·(wx−px) − s·cosh·(wz−pz)`,
  `s` = px/world-unit = `70/view`), so terrain and friend dots stay aligned. This alignment is the
  invariant `test-world-map.mjs` guards against the marker formula.
- `bigMapImageAffine` / `worldToBigMap` — pure. **North-up** projection (N = +Z up, E = −X right,
  same handedness as the compass) for the full-screen map.
- `bakeMapCanvas` — browser. Samples the chosen `overlayId`'s colorizer on a `res × res` grid
  (upsamples past the ~96-cell source for a crisp big map) and returns `{ canvas, worldX, worldZ,
  wx0, wz0, sxu, szv, res, overlayId }`.
- `createWorldMapOverlay` — browser. Builds a hidden full-screen `#world-map` panel; returns
  `toggle()`, `close()`, `isOpen()`, `update()`. `update()` redraws only while open, and labels the
  active overlay via `getOverlayLabel`. The data getters are passed in so the module stays decoupled
  from `environment-viewer.html` globals.

Wiring in `environment-viewer.html`: `worldMapBake` is filled by `rebakeWorldMap()`
(`bakeMapCanvas(loadedMap, { overlayId: mapOverlayId })`) after the map loads (null for
procedural/no-map worlds); the finder's `update()` blits it under the rings. The minimap sits in an
`#mp-dock` flex row with a **Layers** tab nub that expands `#mp-map-menu` to the right; picking a
layer sets `mapOverlayId`, calls `rebakeWorldMap()`, and both the minimap and the M map pick it up.
`createWorldMapOverlay` is toggled by **M**; opening it enters the cursor-free pause (frozen
first-person view + free mouse), and **M**/**Esc** close it and re-lock.

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

- `const frameProfiler = createFrameProfiler({ smoothing: 0.2 });` â€” line 1005, module-level singleton.
- `environmentUi = createEnvironmentUi({ perfLog, sliderState: { capture, apply, list, save, remove } });` â€” line 3859, created once the `#ctrl` panel, `#port-creature-ui`, and `#fps` elements already exist in the DOM. The `sliderState` methods wrap `captureSliderState`/`applySliderState` (module-level, see the "Slider state presets" section of `entry-point.md`) and the re-exported `listStates`/`saveState`/`deleteState` from `slider-state.js`.

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
13. Immediately after that block closes, the frame's `renderer.info` per-frame counters are snapshotted into a module-level `lastFrameRenderInfo` holder (`{ frameCalls, drawCalls, triangles, computeFrameCalls }`) â€” see the fix note below.
14. `await frameProfiler.timeAsync('timestampResolve', () => resolveFrameTimestamps())` â€” when `TIMESTAMP_MODE === 'on'`, calls `renderer.resolveTimestampsAsync(...)` for compute/render GPU timestamps and feeds them in via `frameProfiler.recordGpu('computeTotal', â€¦)` / `recordGpu('renderTotal', â€¦)` / `recordGpu('postRender', â€¦)`. Wrapping this call in `timeAsync` (rather than leaving it bare, as before) attributes its wall-clock cost to `passTimestampResolveMs` instead of letting it silently inflate `cpuMs`.

`frameProfiler.reset()` is called from `perfLog.clear()` (~line 539).

Consumption: `perfLog.snapshot(now)` (the page's own perf-log object, ~line 480-508) spreads `...frameProfiler.snapshot()` alongside other scene/terrain/water/forest stats into one flat object written to CSV rows. `updatePerfPanel(now)` (~line 545, throttled to every 250ms) calls `environmentUi.updatePerf(perfLog.snapshot(now))`, which drives the Perf-tab rendering in `environment-ui.js` (`host._updatePerf`). The Frame-stages cards there read `snapshot[key]` for each `PERF_ROWS` entry (e.g. `snapshot.passCreaturesMs`) and color-code bars at >16.7ms (warn) / >33ms (bad). `perfLog.toCSV()` derives its column list from `Object.keys(this.samples[0])`, so any new key merged into a snapshot (like `passTimestampResolveMs`) appears in the CSV automatically with no separate header change needed.

**Render-counter zeroing fix (timestamps-on mode):** `perfLog.snapshot()`'s `renderFrameCalls`, `renderDrawCalls`, `triangles`, and `computeFrameCalls` fields used to read `renderer.info` live. With `TIMESTAMP_MODE === 'on'`, the awaited `resolveTimestampsAsync()` calls inside `resolveFrameTimestamps()` cross a vsync boundary, and WebGPURenderer resets its per-frame `info` counters before `perfLog.snapshot()` ran (the cumulative `calls`/`renderCallsTotal`/`computeCallsTotal` counters aren't reset per-frame, so those stayed correct). Those four fields now read from `lastFrameRenderInfo` (captured right after the frame's draw/compute submit, before the timestamp-resolve await) and fall back to a live `renderer.info` read (or `0`) for the very first frame before the holder is populated. This has no effect when `TIMESTAMP_MODE` is off, since the holder's values equal what a live read would give at that point in the frame.

## Architecture notes

`environment-ui.js` is **not** where the subsystem tuning sliders (terrain, water, grass, forest, sky, lights) are defined â€” confirmed by reading both files. Those are built entirely inline in `environment-viewer.html`'s "control panel" section (~line 1507 onward), which constructs the `#ctrl` floating panel itself (own `<style>` block, drag handling, minimize button) plus a local `slider(key, label, min, max, step, fmt, onChange, obj)` helper and a `header(text)` helper that opens collapsible `.sec` sections. The section titles built there are: `Forest`, `Tree LOD`, `Lighting`, `Scene`, `Post`, `Particles`, `Grass` (x2), `Water`, `Water Reflection`, `Water LOD`, `Clouds (layer 1)`, `Clouds (layer 2)`, `Sky`.

`environment-ui.js`'s `createEnvironmentUi` only builds a tabbed *shell* and, via `mountCtrl()`/`routeSections()` (a `MutationObserver` on `#ctrl-body`), re-parents the already-built `#ctrl` panel's `.sec` children into either its `scene` or `effects` tab panel â€” sorted purely by section title against a hardcoded `effectsNames` set (`Post`, `Particles`, `Water`, `Clouds`, `Sky`; everything else, e.g. `Forest`/`Lighting`/`Scene`/`Grass`, lands in `scene`). A separate `mountFixedUi()` (driven by a `MutationObserver` on `document.body`) re-parents `#port-creature-ui` into the `creatures` tab and `#fps` into the `walk` tab. None of these controls are authored by `environment-ui.js` â€” it only relocates existing DOM and restyles it via CSS overrides (the large `!important` block in `installStyle()`).

The pieces of UI `environment-ui.js` genuinely *builds* (not just re-hosts) are the Perf tab (live-metrics cards, sparkline, per-stage timing bars, capture controls â€” all read-only, driven by `perfLog`/`frameProfiler` snapshots), the Presets tab (`buildPresetsPanel`, save/load/delete named slider states via the `sliderState` param), and the Audio tab (`buildAudioPanel`, folder/volume/mute/output/effects/track controls driven by the `audio` param â€” see the Public API section above for its full control-ID surface).

So the real division of labor: `environment-viewer.html` owns all interactive scene/tuning controls (sliders, dropdowns, toggles), the `controlRegistry`/`captureSliderState`/`applySliderState` machinery those controls self-register into, and all per-frame profiler instrumentation calls; `environment-audio.js` (when present) owns the actual audio mixer/state; `environment-ui.js` owns layout/chrome (tabbed shell + CSS), the read-only performance HUD, the Presets tab's save/load/delete UI, and the Audio tab's controls (both of which only call into the `sliderState`/`audio` objects handed to them, with no storage/mixing logic of their own), while passively absorbing the other modules' pre-built panels into its remaining tabs.

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

`test-world-map.mjs` (repo root, `node test-world-map.mjs`, same manual-`ok` style) covers
`world-map.js`'s pure math: the `minimapImageAffine` projection agrees with a replica of the finder's
own marker formula across several headings/positions (the terrain↔dots alignment invariant), the
big-map projection is north-up/east-right, and `bakeMapPixels` brightens flat ground by ambient light,
shades slopes directionally, flattens water, and (with `shaded: false`) emits the sampled color
verbatim. It also checks `overlayColorizer` returns a valid `[r,g,b]` 0..255 + `shaded` flag for every
`MAP_OVERLAYS` id and that the water/grass/material layers track their underlying data (30 assertions).
The browser wrappers (`bakeMapCanvas`, `createWorldMapOverlay`) are canvas/DOM-dependent and untested.

