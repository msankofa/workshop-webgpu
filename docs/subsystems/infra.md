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

`serve.py` (repo root, not itself under `docs/subsystems/` naming but documented here since
it's the thing `perfLog`'s auto-save POSTs to) also owns the `/api/save-stats` endpoint that
lets perf captures save themselves into `research/stats/` — see "Perf capture auto-save" below.
`POST /api/save-bot-state?filename=bot-state-trace-<YYYYMMDD-HHMMSS>.tsv` is the same pattern for
`bot-viewer-v2.html`'s state recorder, writing into `bot-states/` (filename validated against
`_SAFE_BOT_STATE_FILENAME`, `-N` suffix on collision) — see `docs/subsystems/bot-state-codes.md`.
`GET /api/fs-scan` (2026-08-21) walks the whole repo (skipping `node_modules`, `__pycache__`, and
any dotfile/dotdir) and returns every file/dir as a flat `{path, type, size, mtime, ctime}` list —
the data source for `tools/filesystem-map.html`'s 3D node map, so the map is always live rather
than reading a committed manifest that could go stale. `ctime` (`os.stat().st_ctime`) is creation
time on this repo's Windows dev platform but metadata-change time on POSIX, and even on Windows a
moved/re-checked-out file's `ctime` doesn't necessarily match when it was first authored — the
growth-timeline feature treats it as a best-effort "born at" signal, not an authoritative one.
It also owns `GET /api/list-states` (see "Folder seeding" below) and `GET /api/list-music`
(enumerates `sfx/music/*.{mp3,wav,ogg,m4a,flac,opus,webm}`, no client input involved — see
`docs/subsystems/audio.md`'s "Start-screen menu music" for the consumer, `start-screen.js`'s
`_musicPicker`). `GET /api/list-maze-layouts` + `POST /api/save-maze-layout?filename=layout-<kind>-<stamp>.json`
(2026-07-30) are the same list/save pair for `maze layouts/`: the harness's "Export layout JSON"
button saves pcw-layout worlds there, and `start-screen.js`'s Maze Layouts card lists them
(filename validated against `_SAFE_MAZE_LAYOUT_FILENAME`, body must parse as JSON, `-N` suffix on
collision). Every response also carries `Document-Policy: js-profiling`, which opts served
pages into Chrome's JS self-profiling API (`new Profiler(...)`) for ad-hoc perf traces.

- **`bot-diag-<stamp>.json`** (added 2026-07-29) — counters saved beside each trace through the same
  `POST /api/save-bot-state` endpoint; `_SAFE_BOT_STATE_FILENAME` now accepts either
  `bot-state-trace-YYYYMMDD-HHMMSS.tsv` or `bot-diag-YYYYMMDD-HHMMSS.json` and still rejects anything
  else (basename-reduced, regex-validated, `-N` collision suffix). Kept out of the TSV on purpose:
  comment lines or extra rows there break consumers that read the trace by column index.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `frame-profiler.js` | Tracks CPU pass timings (sync/async) and GPU timestamp/await totals per frame, with EMA smoothing and a flat snapshot for logging/HUD consumption. | 140 |
| `environment-ui.js` | Builds the six-destination `#workshop-ui` in-game inspector (World, Entities, Player, Assets, Audio, Tools), re-parents the existing live panels, and builds the performance, preset, and audio control content. | 1300 |
| `world-map.js` | Bakes the authored terrain map into a selectable data overlay (biome/elevation/slope/material/water/grass/tree) and projects it into the heading-up minimap and the north-up full-screen (M) map. Pure bake/affine/overlay math is unit-tested (`test-world-map.mjs`); canvas/DOM wrappers are browser-only. | 295 |
| `environment-audio.js` | Standalone Web Audio controller (`createEnvironmentAudio(options)`) extracted from the shooter (`html-game-v2/src/game/main.js`) with no `main.js` coupling: mixer + persistence, camera-listener positional SFX, `sound-map.json` folder loading, streamed `music_menu`/`music_game` with processing graph + pitch worklet, and a front/behind/orbit/above speaker orb. Backed by support modules `sound-events.js`, `music-pitch-processor.js` (AudioWorkletProcessor), `asset-paths.js`, `file-handles.js`, `live-updates.js`. | 1050 |
| `disk-store.js` | A JSON document backed by a file on disk. GETs it, POSTs it back through a `serve.py` route, debounced autosave with serialised writes, and `localStorage` kept only as a fallback cache. Both sides are injected, so it is fully Node-tested (`test-disk-store.mjs`). | 160 |
| `server-tool.py` | Local stdlib-only HTTP controller for starting/stopping `serve.py` and `server/server.js`, polling status, and capturing per-process logs. | 244 |
| `server-tool.html` | Browser dashboard served by `server-tool.py`; exposes Start/Restart/Stop/Clear controls, useful launch links, and live logs for each managed server. | 296 |
| `tools/filesystem-map.html` | Standalone holographic 3D **node-link** map of the repo filesystem — WebGPURenderer + TSL `PostProcessing`/`bloom`/`dof` (repo convention, not the WebGL EffectComposer addons; DOF via three's own `dof()` TSL node reading the scene pass's real depth buffer, not the hand-rolled CoC pass from `demos/sdf-bug-v2.html` that inspired it — that demo raymarches and has no depth buffer to read). Directories are laid out with a Coulomb-repulsion + Hooke-spring simulation in 3D (organic volumetric clustering, not a flat ring/grid), damped rather than cooling-scheduled so it can also run live or be scoped to an `active[]` subset; each folder's files are scattered onto a Fibonacci sphere stored as a *local offset* from its hub (so a moving hub carries its files for free), never entering the O(n²) physics themselves. Node materials are opaque (not additive) with real depth writes so dense clusters stay legible instead of clipping to a white blob; tone mapping is ACES; fog is linear and tied to camera range, not layout radius. The Render/DOF/Layout/Style HUD panel (collapsible, like Filters) exposes live sliders for exposure/bloom/DOF focus-distance-focal-length-bokeh (with an auto-focus-on-orbit-target option) and edge length, a "live rearrange" toggle, shuffle/re-layout buttons, and toggles for node size (file size vs. uniform) and color (extension vs. relative/absolute file age). A separate Growth Timeline panel replays the repo's construction in chronological order using each file's creation time (`ctime` — best-effort, not authoritative; see `/api/fs-scan` below) as its "birth": directories reveal and physically emerge from their already-active parent as playback crosses their birth time, restricting `forceStep()` to the currently-active subset so the graph visibly reorganizes as it grows, not just reveals at pre-settled positions. Clicking a node smoothly flies the camera to focus on it (position+target lerp composes with `OrbitControls.update()` since it re-derives its spherical state from `camera.position` each call). Filters by file extension, modified-date range, and name; fetches `GET /api/fs-scan` live, no manifest to regenerate. | 830 |

## Public API

### `frame-profiler.js`

```js
export function createFrameProfiler({ smoothing = 0.2, now = () => performance.now() } = {})
```

Returns:
- `beginFrame()` â€” zeroes the current-frame CPU/GPU pass values (called once at the top of `animate()`). Since 2026-08-04 it zeroes **every name recorded so far** (each key already in the internal `latest` / `gpuLatest` maps) *plus* `DEFAULT_NAMES` / `DEFAULT_GPU_NAMES`, not just the defaults. That matters for any app whose pass names aren't the environment viewer's: `bot-viewer-v2.html` records `sim`, `bodyFlush`, `weaponFlush`, `botFx`, `visuals`, `fx`, `audio`, `panelFx`, `ui*`, `render`, and before this change `beginFrame()` was a no-op for them, so a conditionally-executed phase reported the *previous* frame's value instead of 0. The environment viewers are unaffected: they record every default name every frame, so iterating the recorded keys is a superset of the old loop. The smoothed (`{ smooth: true }`) maps are deliberately **not** zeroed â€” the HUD's EMA is supposed to decay across a skipped frame, not snap to zero.
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
- `activate(tabId)` â€” switches the active tab (`world | entities | player | assets | audio | tools`).
- `updatePerf` â€” bound to the internal `host._updatePerf(snapshot)` function built in `buildPerfPanel`; renders one perf-log snapshot into the Perf tab (metrics, sparkline, scene-figures rows, per-stage timing bars, capture button state).

`sliderState` (optional) is `{ capture(), apply(values), list(), save(name, values), remove(name), import(obj, { overwrite }) }`,
supplied by `environment-viewer.html` (`capture`/`apply` wrap its module-level slider registry;
`list`/`save`/`remove`/`import` are re-exported from `slider-state.js`). When omitted, the Presets tab
renders a "Preset saving unavailable" placeholder instead of the save/load UI.

`buildPresetsPanel(host, sliderState)` (internal, not exported) builds the Presets tab: a "Save
current sliders" card (name input + Save button, with an overwrite confirmation if the name
already exists), a "Backup" card (Export all / Import buttons — download all states as a JSON
file, or merge an exported file back in via `sliderState.import`, with an overwrite-existing
confirmation), and a "Saved states" card listing every saved name with a relative timestamp,
a Load button (`sliderState.apply`), a per-row Export button (downloads that one state), and a
Delete button (`sliderState.remove`). Since presets live only in `localStorage` (`pcw:sliderStates`),
Export/Import is the only way to move them between browsers or back them up.

**Folder seeding:** on startup (`environment-viewer.html`, just before `createEnvironmentUi`) the viewer
fetches `serve.py`'s `GET /api/list-states` (which enumerates `*.json` in the repo's `states/`
directory), fetches each file via `states/<name>`, and merges them into `localStorage` with
`importStates(..., { overwrite: false })` — so any preset already in `localStorage` wins and the
folder acts as a restore-on-clear backup. Files may be either a full exported store
(`{ name: { savedAt, values } }`) or a single-preset export (same shape, one key). Seeding is
skipped silently if the endpoint is absent (e.g. the page was opened without `serve.py`).

**Weapon tuning is part of the preset system too.** The FPS panel's "Weapon control" sliders
(Position/Rotation/Scale + recoil/fire-rate/damage/range/magazine/reserve/spread) mutate the in-memory
`weapons.js` defs. Each enabled weapon's tunable fields self-register into `controlRegistry` under
`weapon.<id>.<field>[.<index>]` names, so `captureSliderState`/`applySliderState` carry them into named
presets and the `states/*.json` export exactly like the world sliders. The `weapon.` prefix keeps them
out of the MP shared-world broadcast (`captureSharedWorldSettings` only syncs `terrain.`/`params.`).
Separately, every weapon-slider change mirrors the current `weapon.*` values to `localStorage`
(`pcw:weaponTuning`) and that mirror is re-applied at load (in the eager `#fps` panel block, after the
fields register), so a plain refresh keeps weapon tuning without loading a named preset. The baked
per-weapon defaults in `weapons.js` are the base these overrides sit on top of. Both the save and the
load side are gated behind the `?tune=1` query param (`TUNE_MODE`): without it, weapon-slider edits
never write to `pcw:weaponTuning` and any existing entry is never read back. This exists because the
mirror has no versioning — a saved override would otherwise silently keep masking `weapons.js` updates
forever for anyone whose browser had ever written one (a real incident: a stale local override made a
weapons.js aim-pose fix look like it hadn't deployed). Add `?tune=1` to the URL to opt back into
live-tuning persistence.

**First-person view feel** (`view-feel.js` + the FPS panel's "View feel" sliders). `view-feel.js` is a
pure, THREE-free math module (same convention as `weapon-sequence.js`, unit-tested by
`test-view-feel.mjs`): run/gun bob axis, trauma screen-shake sampling/decay, `easeToward`, momentum-lean
target, HUD-drag target, and `clampLookPitch`. `environment-viewer.html` owns the runtime state in two
objects near the `fp` movement config: `feel` (tunables) and `look` (per-frame state). The key
architectural point is that **mouse look writes authoritative `look.yaw`/`look.pitch`, not
`camera.rotation`** — each fps frame `updateViewFeel()` composes `camera.rotation` (YXZ) from those plus
visual-only offsets (strafe tilt roll, momentum lean pitch, trauma shake, view-recoil kick). Anything
that needs the *true* aim reads `look.*`: `getLocalPlayerState` (wire yaw/aimPitch), `fireGunFromCamera`
(bullet direction, built from a `look`-only Euler), the local procedural body's facing, and the
third-person weapon-rig yaw — so shake/tilt/lean never deflect shots or leak to other players. Trauma is
added on every shot (scaled by weapon recoil), on local damage (`localDamageFeedback`), and on nearby
explosions (`addWorldImpactShake`, distance-falloff; also exposed as `window.addViewShake`). The
`feel.*` sliders self-register into `controlRegistry` under `feel.<key>` names (ride presets + the
`states/*.json` export; the `feel.` prefix keeps them out of the MP shared-world sync) and mirror to
`localStorage` (`pcw:viewFeel`) for plain-refresh persistence, same pattern as weapon tuning. The
run/gun weapon bob itself is applied in the FP weapon viewmodel's `applyToolTransform`
(`environment-viewer.html`) and exposed via `getViewBob()` so the orb-hands (`player-hands.js`) inherit
it at `HAND_BOB_FOLLOW`.

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
speaker mode), `workletUrl` (default `./music-pitch-processor.js?v=1`), and two flags used by
`bot-viewer-v2.html`: `autoplayOnGesture` (default `true`; `false` stops a user gesture from
starting music that wasn't already playing) and `shuffle` (default `false`).

Returned methods: `init()`, `noteGesture()`, `update(timestampMs)` (call once per frame after
camera/player movement — refreshes the Web Audio listener and speaker-orb follow),
`loadSfxFolder(dirHandle)`, `pickSfxFolder()`, `restoreSfxFolder()`, `play(eventId, volume?)`,
`playAt(eventId, position, volume?, options?)`, `setVolume(kind, value)` /
`setMuted(kind, muted)` (`kind` = `master`|`music`|`sfx`), `setMusicOutput(mode)`
(`global`|`speaker`), `setMusicSpeakerBehavior(mode)` (`front`|`behind`|`orbit`|`above`),
`setMusicEffect(key, value)` (`bass` dB 0-18 | `echo`/`reverb` % 0-100 | `attenuation` % 0-200 |
`tempo` % 50-200 | `pitch` semitones ±12 — these are raw controller units, not 0-1),
`loadMusicHttp(opts)` (the `sfx/music/` listing source), `setShuffle(bool)`,
`getMusicProgress()` / `seekMusic(fraction)` (polled transport position — not in `getState()`),
`getState()`, `subscribe(listener)` (returns an unsubscribe fn), `dispose()`, plus optional
transport `prevTrack()` / `togglePlayback()` / `nextTrack()`.

`getState()` read contract (consumed by the Audio tab; missing keys fall back to UI defaults):
`masterVolume`, `musicVolume`, `sfxVolume`, `masterMuted`, `musicMuted`, `sfxMuted`,
`musicOutput`, `speakerBehavior`, `shuffle`, `effects{bass,echo,reverb,attenuation,tempo,pitch}`,
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
- `compress` starts `node index.mjs` in `glb-shrink-server/` with `PORT=<port>`
  (default `3847`). This is the local API used by `weapon-viewer-v2.html`'s Compress panel to
  shrink weapon `.glb` files (Draco geometry + WebP textures) — see
  `docs/subsystems/weapon-compression.md`.

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
`ws` import, install dependencies in `server/` with `npm install`. Same for `compress`
exiting immediately with a missing module — `npm install` in `glb-shrink-server/` (see that
folder's note in `weapon-compression.md` about Google-Drive-synced paths and `sharp`).

## Wiring (`environment-viewer.html`)

Both modules are static imports at the top of the file:
```js
import { createFrameProfiler } from './frame-profiler.js';   // line 46
import { createEnvironmentUi } from './environment-ui.js';   // line 47
```

- `const frameProfiler = createFrameProfiler({ smoothing: 0.2 });` â€” line 1005, module-level singleton.
- `environmentUi = createEnvironmentUi({ perfLog, sliderState: { capture, apply, list, save, remove, import } });` â€” line 3859, created once the `#ctrl` panel, `#port-creature-ui`, and `#fps` elements already exist in the DOM. The `sliderState` methods wrap `captureSliderState`/`applySliderState` (module-level, see the "Slider state presets" section of `entry-point.md`) and the re-exported `listStates`/`saveState`/`deleteState`/`importStates` from `slider-state.js`.

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

`environment-ui.js`'s `createEnvironmentUi` builds the compact inspector shell and, via `mountCtrl()`/`routeSections()` (a `MutationObserver` on `#ctrl-body`), re-parents already-built `#ctrl` `.sec` elements into World, Entities, Player, or Tools according to their title. World receives terrain, biome, water, vegetation, dressing, atmosphere, and image-FX sections; Entities receives ClaudeCraft and combat sections; Player receives the Player utilities section; Tools receives Perf A/B. `mountFixedUi()` re-parents `#port-creature-ui` under the parent `Procedural Creatures` accordion and `#fps` into Player. The stats UI is hosted in the creature accordion's `Analytics` child. None of these controls are authored by `environment-ui.js` -- it only relocates existing DOM and restyles it.
The pieces of UI `environment-ui.js` genuinely *builds* (not just re-hosts) are the Perf tab (live-metrics cards, sparkline, per-stage timing bars, capture controls â€” all read-only, driven by `perfLog`/`frameProfiler` snapshots), the Presets tab (`buildPresetsPanel`, save/load/delete named slider states via the `sliderState` param), and the Audio tab (`buildAudioPanel`, folder/volume/mute/output/effects/track controls driven by the `audio` param â€” see the Public API section above for its full control-ID surface).

So the real division of labor: `environment-viewer.html` owns all interactive scene/tuning controls (sliders, dropdowns, toggles), the `controlRegistry`/`captureSliderState`/`applySliderState` machinery those controls self-register into, and all per-frame profiler instrumentation calls; `environment-audio.js` (when present) owns the actual audio mixer/state; `environment-ui.js` owns layout/chrome (tabbed shell + CSS), the read-only performance HUD, the Presets tab's save/load/delete UI, and the Audio tab's controls (both of which only call into the `sliderState`/`audio` objects handed to them, with no storage/mixing logic of their own), while passively absorbing the other modules' pre-built panels into its remaining tabs.

## Perf CSV fields (2026-07-08, perf-recovery Wave 0)

`terrain-dressing-performance-design.md` Milestone 0 and `water-performance-design.md` §1 add
columns to `perfLog.snapshot()` (`environment-viewer.html`, ~line 1500 onward) so a downloaded
`perf-<timestamp>.csv` can distinguish terrain/dressing/water A-B modes without re-reading the
URL. Since `perfLog.toCSV()` derives its header from `Object.keys(this.samples[0])`, adding a
key to the snapshot object is sufficient — no separate CSV header change:

| Column | Source | Notes |
|---|---|---|
| `terrainTextureMode` | `loadedMap.terrainTextureMode` (`terrain-loader.js`, set from `applyTerrainTextures`'s result) | `'splat'` (default) \| `'legacy'` \| `'flat'` \| `'none'` (no authored map / textures failed). Mirrors `?terrainTexture=`. |
| `terrainActiveSplatLayers` | `loadedMap.terrainActiveSplatLayers` | Count of layers the splat material actually blends (`<= MAX_ACTIVE_LAYERS`, 6); `0` outside splat mode. |
| `terrainTextureMeshes` | `loadedMap.terrainTextureMeshes` | Count of meshes assigned the terrain material (pre-existing field, now also read here). |
| `dressingDraws` / `dressingGroups` / `dressingInstances` | `dressingGPURef.stats.{draws,groups,instances}` (`dressing-gpu.js`) | Pre-existing `stats` fields (see `rocks.md`); this task is the first thing to plumb them into the CSV. `0` when dressing is off. |
| `dressingMode` | top-level `DRESSING_MODE` const | Mirrors `?dressing=gpu\|off`. Hoisted to true top-level (near `GRASS_MODE`/`FOREST_MODE`) specifically so this top-level `perfLog` closure can read it — the `DRESSING_MODE`-gated host-build block further down the file reuses the same const rather than re-declaring it. |
| `waterQuality` | `waterRef.getStats().qualityPreset` | Mirrors `?waterQuality=` or the current Perf A/B value once quality tiers exist (Wave 0: stored setting only, see `water.md`). |
| `waterCausticRate` | `waterRef.getStats().causticRate` | Mirrors `?waterCausticRate=` or the live Perf A/B "Caustic rate" slider value — read **live** every sample (see "Perf A/B control registry" below), not the flag's initial value. |

`waterReflectionRate` / `waterReflectionResolutionScale` / `waterReflectionLastMs` and the rest
of the `water*` columns already existed before this task (see `water.md`'s Public API) — Wave 0
only adds the two columns above plus the water URL flags/setters that let their values actually
move.

## Perf capture auto-save (2026-07-09)

Perf CSVs used to require a manual "CSV" button download followed by moving/renaming the file
into `research/stats/` by hand (the existing files there, e.g.
`perf-2026-06-21T04-30-44-809Z-webgl.csv`, were all named this way manually). `perfLog` now
saves itself.

**Endpoint** (`serve.py`): `POST /api/save-stats?filename=<name>[&mode=append]` — body is raw
CSV text.
- Filename sanitization: reduced to a basename (`\` normalized to `/` first) and must match
  `^(?:perf|bots)-[A-Za-z0-9T:\-=&.]+\.csv$` (2026-07-16: added the `bots-` prefix for
  `botStatsLog`, see `docs/subsystems/bots.md`); anything else (including `..`) gets **400**.
  Mirrors the `_safe_under_maps` pattern used by `/api/save-map`. Target dir `research/stats/`
  (created if missing).
- Default mode never overwrites: an existing name gets a `-2`, `-3`, ... suffix.
- `mode=append` (2026-07-09) appends the body to the named file, creating it if absent — no
  collision suffix, so a session's incremental flushes all land in one file. Session filenames
  are unique per recording (ms-precision timestamp), so appends can't collide across sessions.
- On success: **200** `{ ok: true, path: "research/stats/<name>.csv" }`; on rejection: **400**
  `{ ok: false, error: "..." }`.

**Client (`environment-viewer.html`, `perfLog`)** — incremental streaming (2026-07-09; replaced
the original single-shot `autoUpload()` after long sessions silently lost their capture:
`navigator.sendBeacon` rejects payloads over ~64 KB, so an 11-minute CSV sent at tab close never
arrived, and `maxSamples: 600` ring-trimming also drops the start of anything longer):
- `sessionFilename` is built once per recording start via `buildFilename()`
  (`perf-<ISO timestamp>-<sanitized location.search>.csv`; must stay accepted by serve.py's
  `_SAFE_STATS_FILENAME`).
- `_pendingRowsCSV()` serializes only rows not yet delivered (`_totalRows - _flushedRows`,
  clamped to what the ring buffer still holds). Column order is locked at first flush
  (`_flushCols`) so appended rows stay aligned; the header is sent only in the first chunk.
- `flush()` — fetch POST with `mode=append`, called from `maybeSample()` every
  `flushIntervalMs` (30 s, first flush at the 5th sample) and awaited on `setRecording(false)`.
  Advances `_flushedRows` only on a 200; failed chunks stay queued for the next flush.
  `uploadStatus` shows `saved <n> rows → <file>` or `save failed: <msg>` in the bottom-left
  perf strip.
- `beaconUpload()` — same chunk via `sendBeacon`, wired to `pagehide`/`beforeunload`/
  `visibilitychange→hidden`. Because periodic flushes carry the bulk, the beacon only ever
  holds the last ≤30 s of rows, which always fits the payload cap. No response is available
  during teardown, so it advances `_flushedRows` optimistically on queue success.
- `clear()` resets the flush state and blanks `sessionFilename`; if recording continues, the
  next flush starts a fresh file and the old partial is left in place.
- The manual "CSV" download button is unchanged (whole in-memory buffer, browser download).

**New per-sample context columns** (added to `perfLog.snapshot()`, so `toCSV()` picks them up
automatically the same way the Wave 0 columns above did — no separate header change):

| Column | Source | Notes |
|---|---|---|
| `queryString` | `location.search` | Raw, unsanitized (unlike the filename's sanitized copy) — constant across all rows in one capture. |
| `camX` / `camY` / `camZ` | `camera.position.{x,y,z}` | 1 decimal. `camera` is a true top-level module-scope `const` (declared ~line 1029, before `perfLog` at ~line 1503), so `snapshot()`'s closure reads it directly — no `setContextProvider` indirection needed. |
| `camHeading` | `headingDegrees(camera.rotation.y)` (existing helper, ~line 961, already used by the compass/minimap) | Integer degrees, 0-359. |
| `camSpeed` | Derived: Euclidean distance between this sample's rounded camera position and the previous sample's, divided by elapsed wall-clock seconds (`performance.now()` deltas) | 1 decimal, world-units/sec. `perfLog._lastCamPos`/`_lastCamT` track state between samples and are reset (`_lastCamPos = null`) whenever `setRecording(true)` starts a new run, so the first sample of a run never reports a stale speed from a previous capture. |
| `fpsCap` (2026-07-09) | top-level `fpsCapValue` variable | `'off'`\|`'60'`\|`'40'`\|`'30'` — the global frame cap's **current** live setting (Perf A/B "FPS cap" select can change it mid-run), not the `?fpsCap=` flag's initial value. See "Global frame cap" below. |

## Perf A/B control registry (`window.perfAB`)

A live runtime-comparison panel, introduced 2026-07-08 (perf-recovery Wave 0, orchestration plan
rule 7) alongside the URL flags above. URL flags set the **starting** state for a reproducible
capture run; `window.perfAB` sliders/toggles/selects mutate live state **on top**, so two
settings can be A/B'd in one running session without a reload. Any module — static import or a
lazily `await import()`ed one — can register a control without editing `environment-viewer.html`:

```js
window.perfAB?.addToggle(label, initial, onChange)
window.perfAB?.addSlider(label, initial, min, max, step, onChange)
window.perfAB?.addSelect(label, initial, options, onChange)   // options: string[]
```

This is a **frozen API** other subsystems depend on (later perf-recovery waves register terrain
shader mode, scree material tier, deadfall double-sided toggle, forest/dressing frustum-cull
controls, etc. from their own module files via these exact three calls) — do not rename or
change the argument order.

Implementation (`environment-viewer.html`, near the other top-level URL flags, ~line 118):
`window.perfAB` is installed as an IIFE-built object at true top-level, before any lazy module
could possibly run. Each `addX` call pushes a plain `{ kind, label, initial, ..., onChange,
value }` entry into an internal queue and returns a `{ get value() }` accessor; if the "Perf A/B"
panel section already exists (see below) the entry is mounted into the DOM immediately, otherwise
it waits in the queue. `onChange` fires with the new value on every user interaction and also
updates `entry.value`, which is what CSV-coupled snapshot fields should read (see the
`waterCausticRate`/`waterQuality` example above) — always the **current** live value, not the
`initial` one, so a capture taken mid-toggle stays interpretable.

The "Perf A/B" panel section itself is built inline in `environment-viewer.html`'s `#ctrl`
panel-construction closure (same `header`/`slider`/`select`/`toggle` machinery as every other
section — see Architecture notes above), immediately after the `toggle()` helper is defined and
before the first real section (`Forest`). `header('Perf A/B')` opens the section and its `secBody`
element is captured into a local `perfAbBody` binding — controls registered later (e.g. from the
Water block, or from a genuinely separate lazy module loaded after other `header()` calls have
moved the shared `current` pointer elsewhere) still land inside the Perf A/B section, not wherever
`current` happens to point at registration time. `window.perfAB._attachPanel({ mount })` is called
once, right after `mountPerfAbControl` is defined, flushing every already-queued entry.

Wave 0 itself registers six water controls from the water-loader block (see `water.md`'s "URL
flags + Perf A/B panel" section for the full label/range list and which setter each one calls):
"Water reflection", "Reflect rate", "Reflect scale", "Caustics", "Caustic rate", "Caustic res".
The 2026-07-09 water milestone adds a seventh water control, **"Water visibility gates"**
(`addToggle`, default `true` -> `waterRef.setVisibilityGatesEnabled(v)` — see `water.md`'s
"Visibility/strength gates"), and one loop-level control registered at true top level in
`environment-viewer.html` (right after `setFpsCap` is defined, queued until the panel mounts):
**"FPS cap"** (`addSelect`, `['off','60','40','30']`, initial position from `?fpsCap=` else
`'60'` -> `setFpsCap(v)` — see "Global frame cap" below).

A later wave (2026-07-09, terrain-dressing-performance-design.md Milestones 3B/3C) adds two more,
registered from `terrain-textures.js`'s `applySplatTerrain` (called via `terrain-loader.js`'s
static import, not from `environment-viewer.html`) — proof the "any module, static or lazy" claim
above holds: `"Terrain shader"` (`addSelect`, `['reduced','full']`) swaps `mesh.material` between
two prebuilt splat-material variants (top-K reduced vs. all-active-layers full) instantly, and
`"Triplanar slope cutoff"` (`addSlider`, 0..1 step 0.01) drives the live `uSlopeCutoff` uniform
shared by both variants. The terrain-mode swap (`?terrainTexture=splat|legacy|flat`) itself is
still URL-flag-only — those three paths build structurally different materials/mesh state (not
just a shader-loop trim), so prebuilding all three for instant swap remains future work.

Perf A/B controls are **not** part of the `controlRegistry`/preset-save system (`captureSliderState`/
`applySliderState`) — they're a live scratch pad for comparison, not saved/restored slider state.

## Global frame cap (2026-07-09, water-performance-design.md follow-on)

`?fpsCap=60|40|30|off`, **default `60`** (any other value falls back to `60`). Caps how often
the main rAF loop in `environment-viewer.html` (`animate()`, the loop ending in
`perfLog.maybeSample`) runs its sim+render body. Purpose: on a thermally-throttling GPU
(the dev machine's RTX 3060 Laptop), an uncapped loop pegs the GPU at whatever peak FPS the
scene allows and then sags under sustained load — the cap **intentionally trades peak FPS for
thermal headroom**, so `fps` median at cap 60 should read ~60 in a capture (not more), and a
capped run's value is steadier sustained frame pacing, not a higher number.

Implementation (all in `environment-viewer.html`):

- `FPS_CAP_URL` is parsed once at top level (near `WATER_URL_FLAGS`); `fpsCapValue` (live
  setting) and `fpsCapMs` (precomputed `1000/cap` budget, `Infinity` when `'off'`) live next to
  the `animate()` loop state; `setFpsCap(value)` revalidates and recomputes both — called by the
  Perf A/B **"FPS cap"** select, so the cap is live-switchable without a reload.
- The check is the **first thing in `animate()` after the `_frameBusy` re-entrancy guard**
  (which must stay first — it's a WebGPU submit-safety serializer, not per-frame work): if
  `performance.now() - lastRenderedFrameTime < fpsCapMs - 0.5`, the callback returns
  immediately — the entire sim+render body is skipped before `frameProfiler.beginFrame()` or
  any other work, so a skipped tick costs one `performance.now()` call and one comparison. rAF
  itself keeps firing every vsync (no `setTimeout` chains); `lastRenderedFrameTime` is only
  stamped on frames that actually run, so the comparison measures real rendered-frame spacing.
- **The 0.5ms tolerance prevents vsync beating**: a 60Hz display delivers rAF ticks at ~16.667ms
  spacing with sub-ms jitter. A hard `< 16.667` test would intermittently measure e.g. 16.4ms,
  skip that tick, and catch the next one at ~33ms — locking to 30 FPS. With the effective
  threshold at `16.667 - 0.5 = 16.167ms`, any elapsed time of at least one true vsync interval
  always passes, so cap 60 on a 60Hz display renders every vsync (~60 FPS median).
- **What the skip path bypasses (audited 2026-07-09):** nothing time-critical. The host's
  multiplayer broadcast runs on its own `setInterval` in `multiplayer.js` (`BROADCAST_MS` 50ms),
  fully outside `animate()` — its `getState()` just reads the last-simulated positions. The
  guest's `player_state` send (`syncMultiplayerPlayer`, called inside the loop body, own 50ms
  `MP_PLAYER_SEND_MS` gate) and `mpGhostRenderer.tick(now)` (wall-clock-interpolated) run
  slightly less often under a low cap — at cap 30 (33.3ms frame spacing) the guest send cadence
  degrades from 50ms to at worst ~66ms, equivalent to what any 30 FPS device already produces.
  `envAudio.update()` only refreshes the Web Audio listener pose and speaker-orb follow —
  actual playback is scheduled on the audio thread, not rAF. Nothing was hoisted above the cap
  check because nothing inside the body needs per-rAF execution.
- CSV: the `fpsCap` context column (see the per-sample context columns table above) records the
  live value per sample.

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


## Inspector layout (2026-07-18)

`environment-ui.js` now presents the live controls as a right-docked in-game inspector: a 56px icon rail remains visible when closed, and the open state is a 400px-or-less scrollable column. The six destinations are `world`, `entities`, `player`, `assets`, `audio`, and `tools`; clicking an active rail icon closes the drawer. Each icon has an accessible label and a hover tooltip.

`routeSections()` still re-parents existing `#ctrl` sections, but now routes terrain, biome, water, vegetation, dressing, atmosphere, and image-FX controls into World; ClaudeCraft and combat controls into Entities; Player utilities into Player; and Perf A/B into Tools. The pre-existing procedural-creature UI is nested below a parent `Procedural Creatures` accordion, with the stats UI nested below `Analytics`; no slider bindings or runtime control ownership moved out of their source modules.

On viewports at or below 720px the dock becomes a bottom sheet with a horizontal icon strip. CSS transitions handle drawer, tab, accordion, hover, slider-readout, toggle, and compact action-toast feedback without taking focus from gameplay.

The host/solo #creature-command-hud (pets, threats, wildlife, and interaction-key summary) is also re-parented into the Procedural Creatures body, so it no longer floats over the game or competes with the dock. Population uses an explicit subheading instead of an overlaid pseudo-element; the collapsed dock explicitly removes its panel layer.
The rail is stacked above the panel and permits its hover tooltip to escape the collapsed dock boundary, so labels remain readable.

The inspector starts collapsed. When open on desktop, its left-edge resize nub supports pointer and Arrow-key resizing across the available viewport and persists the preferred width in `pcw:inspectorWidth`.

## Theme controls (2026-07-18)

The inspector's Theme destination persists its state under `pcw:uiTheme`. Its component picker edits Settings panel, Map, or Health / ammo surface, border, text, and accent colors with a native color picker, hex input, surface-opacity slider, and bundled color-map presets. Paint mode sets a brush cursor and captures a click on `#workshop-ui`, `#mp-dock`/`#world-map`, or `#combat-hud` to select the corresponding component and element. The Theme module only changes CSS variables; it does not alter map data, combat values, or gameplay controls.
Paint-mode pointer and click events are consumed after selection, so the clicked UI control cannot also activate.

A paint-picked target receives a persistent outline and remains the active color-editor target after paint mode is disabled; while painting, only the color picker and surface-opacity slider stay interactive.

Theme paint uses right-click for target selection and consumes that context action only; ordinary left-click interactions remain available while paint mode is on.

### `POST /api/save-water-config`

`demos/water-demo.html` writes `water-config.json` at the repo root through this route, and
`demos/flight-sim.html` re-reads that file behind its refresh button. Overwrites in place rather
than keeping a history, because it is a single current state and not a set of takes — the same
arrangement as `/api/save-damage-tuning` and `damage-tuning.json`. The body must parse as JSON
before anything is written, so a malformed post cannot truncate the file. See
`docs/subsystems/flight.md` and `docs/subsystems/water.md`.

### `POST /api/save-stadium?filename=<name>`

`demos/stadium-walker.html` autosaves its whole session here through `disk-store.js`. Three filenames are
accepted and nothing else: `stadium-tuning.json` (setpoints, poses, hand-assigned bone roles, panel state),
`stadium-trials.json` (the trial log), and `stadium-tuning-<YYYYMMDD-HHMMSS>.json` from the snapshot button.
All land in `stadium-saves/`. The two live files are overwritten in place because they are one current
state; only the timestamped name gets a `-N` collision suffix, so two snapshots taken in the same second
both survive. The body must parse as JSON before anything is written. This exists because the page
previously kept hours of gait tuning in `localStorage`, where a cleared browser or a different port lost it
silently — see the standing rule in `CLAUDE.md` and `docs/subsystems/stadium.md`.
