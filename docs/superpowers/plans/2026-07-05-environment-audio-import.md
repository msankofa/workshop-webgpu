# Environment viewer audio import - combined spec and plan

**Date:** 2026-07-05
**Subsystems:** environment viewer, UI, audio, SFX tooling
**Source system:** `G:\My Drive\Scripts\html game\html-game-v2`

This is a single combined document: the **Spec** section defines the target contract and
adaptation boundaries; the **Plan** section is the implementation checklist.

---

## Spec

### Goal

Import the browser audio system documented in
`G:\My Drive\Scripts\html game\html-game-v2\HTML_GAME.md` into the environment viewer without
coupling `environment-viewer.html` to the shooter runtime.

The imported system must support:

1. Short SFX playback by named event ID.
2. Positional SFX at world coordinates, using the viewer camera as the Web Audio listener.
3. Loading the existing `M Prime SFX/sound-map.json` format through a browser folder picker.
4. Streamed music events (`music_menu`, `music_game`) plus optional folder music.
5. Music processing: bass, echo, reverb, tempo, independent pitch, global output, and speaker-orb
   positional output.
6. Viewer UI controls for folder selection, status, volume, mute, output mode, and processing
   sliders.

### Why this must be an extraction, not a direct import

Do not import `src/game/main.js` from the source game.

Source reference:

- `HTML_GAME.md:143-145` describes sound loading, playback helpers, runtime music state,
  effects, and routing as part of `src/game/main.js`.
- `src/game/main.js:1624-3314` contains the audio implementation, but it is embedded in the
  arena shooter module.
- `src/game/main.js:2049-2067` depends on shooter state (`gameRunning`, `gamePaused`,
  music-player pause ownership) to decide music event and volume.
- `src/game/main.js:2067-2137` creates a speaker orb using shooter scene globals and airship
  fallback helpers.
- `src/game/main.js:2330-2378` optionally targets enemies for speaker-orb behavior.
- `src/game/main.js:25462-25526` binds controls to shooter DOM IDs from `index.html`.
- `src/game/main.js:25548` binds the source `SFX FOLDER` button.

Target reference:

- `environment-viewer.html:26-64` is a single inline ES module with local imports.
- `environment-viewer.html:844` creates the viewer camera.
- `environment-viewer.html:3997` creates the docked environment UI.
- `environment-ui.js:548-625` owns the docked tab shell.

The correct import shape is a new local module with a small controller API:

```js
import { createEnvironmentAudio } from './environment-audio.js';

const envAudio = createEnvironmentAudio({
  THREE,
  scene,
  camera,
  getPlayerPosition,
  isGameplayActive,
  workletUrl: './music-pitch-processor.js?v=1',
});
```

### New local module boundary

Create `environment-audio.js`.

It exports `createEnvironmentAudio(options)` and returns:

- `init()`
- `noteGesture()`
- `update(timestampMs)`
- `loadSfxFolder(dirHandle)`
- `pickSfxFolder()`
- `restoreSfxFolder()`
- `play(eventId, volume?)`
- `playAt(eventId, position, volume?, options?)`
- `setVolume(kind, value)`
- `setMuted(kind, muted)`
- `setMusicOutput(mode)`
- `setMusicSpeakerBehavior(mode)`
- `setMusicEffect(key, value)`
- `getState()`
- `subscribe(listener)`
- `dispose()`

`kind` is `master`, `music`, or `sfx`.

`mode` for music output is initially `global` or `speaker`. `airship` is intentionally omitted
for the environment viewer unless a future environment aircraft object is added.

### Components and adaptation notes

#### Audio context and mixer

Source references:

- `src/game/main.js:1624-1632` declares audio context, master gain, SFX gain, and loaded buffers.
- `src/game/main.js:1700-1739` loads and persists audio settings.
- `src/game/config.js:722-734` defines `audioMasterReferenceGain = 0.22` and full-volume defaults.
- `src/game/main.js:1757-1767` applies gain values.
- `src/game/main.js:1833-1858` initializes `AudioContext`, `masterGain`, and `sfxGain`.

Target:

- Copy the mixer behavior into `environment-audio.js`.
- Store preferences under a viewer-specific key, for example
  `environment-viewer-audio-settings`.

`[ADAPTATION]` Replace imports from source `config.js` with local constants:

```js
const audioMasterReferenceGain = 0.22;
const audioDefaultSettings = {
  masterVol: 1,
  musicVol: 1,
  sfxVol: 1,
  masterMuted: false,
  musicMuted: false,
  sfxMuted: false,
};
```

#### Camera listener and positional SFX

Source references:

- `src/game/main.js:1883-1914` updates the Web Audio listener from the source camera.
- `src/game/main.js:1914-1967` configures panners and plays buffers at positions.
- `src/game/main.js:1740-1755` defines positional SFX profiles.

Target references:

- `environment-viewer.html:844` creates `camera`.
- `environment-viewer.html:4447-4562` runs the frame loop.
- `environment-viewer.html:4488` updates the first-person player before render.

`[ADAPTATION]` Move listener updates behind `envAudio.update(timestampMs)`, called once per
viewer frame after camera/player movement. Use the injected `camera`, not a module global.

`[ADAPTATION]` Keep source panner profiles but expose them as exported/default options so
environment events can choose profiles (`gunshot`, `explosion`, `minor`, `spawn`) without
depending on shooter weapon code.

#### Named SFX events

Source references:

- `HTML_GAME.md:558-560` states that `src/shared/sound-events.js` defines named sound and
  music events.
- `src/shared/sound-events.js:1-116` defines `SOUND_EVENT_DEFS`.
- `src/game/main.js:1696-1698` derives valid sound and music event sets.
- `src/game/main.js:1984-2023` creates SFX entries and plays event buffers.

Target:

- Add `sound-events.js` to the environment repo.
- Start with a full copy for compatibility with existing `sound-map.json`.
- The environment viewer will initially call a subset:
  `vr_ui_click`, `vr_light_spawn`, `vr_light_toggle`, `vr_model_spawn`,
  `weapon_switch`, `jump`, `landing`, `footstep`, `beam_quick`, `enemy_hit`,
  `player_damage`, `music_menu`, `music_game`.

`[ADAPTATION]` Do not require every source event to be used by the viewer. Unknown or unplayed
events can remain valid so existing maps load without pruning.

#### SFX folder loading and `sound-map.json`

Source references:

- `HTML_GAME.md:576-578` documents `M Prime SFX/sound-map.json` and `M Prime SFX/assets/`.
- `HTML_GAME.md:608-620` documents event assignment, sequence/random mode, and music event
  behavior.
- `src/game/main.js:3131-3225` decodes SFX, warms music, reads `sound-map.json`, and saves the
  selected folder handle.
- `src/shared/asset-paths.js:1-15` provides `getFileByKey()` and extension helpers.
- `src/shared/file-handles.js:1-42` provides IndexedDB handle persistence.

Target:

- Copy or inline the small helpers from `asset-paths.js` and `file-handles.js`.
- `environment-audio.js` should accept `M Prime SFX` via `showDirectoryPicker()`.
- The viewer must display load status in the Audio tab.

`[ADAPTATION]` Browser security prevents direct file access to
`G:\My Drive\Scripts\html game\html-game-v2\M Prime SFX`. The user must select that folder
through the folder picker, or the assets must be copied under the served workspace.

`[ADAPTATION]` Use a viewer-specific picker ID and handle store:

- picker ID: `environment-audio-sfx-folder`
- IndexedDB database: `environment-audio-handles`
- key: `sfx-root-directory`

Do not reuse the source game IDs unless shared browser persistence with the source game is
explicitly desired.

#### Live SFX updates from the source SFX browser

Source references:

- `HTML_GAME.md:813-825` documents `sfx-game` live updates.
- `src/shared/live-updates.js:1-49` provides BroadcastChannel/localStorage fallback helpers.
- `src/game/main.js:1689-1692` defines `sfx-game` channel and storage keys.
- `src/game/main.js:3228-3314` applies live SFX updates.

Target:

- Optional but recommended for parity with the source SFX browser.
- Copy `live-updates.js` or inline equivalent helpers.

`[ADAPTATION]` Keep the same channel/storage names (`sfx-game`, `sfx-game-update`) if the
environment viewer should receive edits from the existing `sfx-browser.html`.

`[ADAPTATION]` Live updates only work when both pages are served from the same HTTP origin.
This matches the source guide at `HTML_GAME.md:819-825`.

#### Streamed music and music playlist state

Source references:

- `HTML_GAME.md:615-624` documents `music_menu`, `music_game`, and state-driven music.
- `src/game/main.js:2025-2067` picks music paths and target music volume.
- `src/game/main.js:2476-2700` handles music cache, activation, retry, and state sync.
- `src/game/main.js:2721-2807` lists/selects playlist entries and folder tracks.

Target:

- Keep the source `music_menu` / `music_game` event model.
- In the environment viewer, `isGameplayActive()` should normally return `true` after the
  start screen dismisses.
- If no `music_game` is assigned, fall back to `music_menu`, matching source behavior.

`[ADAPTATION]` Replace shooter `desiredMusicEvent()` with a viewer callback:

```js
function desiredMusicEvent() {
  return options.isGameplayActive?.() && musicEntryPaths(musicPaths.music_game).length
    ? 'music_game'
    : 'music_menu';
}
```

`[ADAPTATION]` Replace shooter pause/game volume with environment defaults:

- active gameplay base music volume: `0.14`
- non-game/menu base music volume: `0.16`
- optional cursor-free/map-open ducking can be added later through an `isDucked()` option.

#### Music processing and pitch worklet

Source references:

- `HTML_GAME.md:672-696` documents the music processing graph and sliders.
- `HTML_GAME.md:698-704` documents `music-pitch-processor.js`.
- `src/game/music-pitch-processor.js:1-80` defines the AudioWorkletProcessor.
- `src/game/main.js:2146-2188` updates effect nodes, tempo, pitch, and loads the worklet.
- `src/game/main.js:2227-2322` builds the processing graph.

Target:

- Copy `src/game/music-pitch-processor.js` to local `music-pitch-processor.js`.
- Keep the processing graph: media element source, pitch worklet, low shelf, echo, reverb,
  compressor, global gain, and positional speaker output.

`[ADAPTATION]` Change the worklet module URL from
`src/game/music-pitch-processor.js?v=3` to an injected local `workletUrl`, defaulting to
`./music-pitch-processor.js?v=1`.

`[ADAPTATION]` Replace `appendDebugLog()` calls with the audio controller status channel.
The source calls appear at `src/game/main.js:2181` and `src/game/main.js:2320`.

#### Music speaker orb

Source references:

- `HTML_GAME.md:640-658` documents speaker-orb output and listener behavior.
- `src/game/main.js:2067-2137` builds speaker orb and output position.
- `src/game/main.js:2330-2420` updates speaker behavior and panner position.

Target references:

- `environment-viewer.html:844` has the camera needed for front/behind/orbit/above behavior.
- `environment-viewer.html:129` and `environment-viewer.html:4029` provide player collider
  state after start.

`[ADAPTATION]` Keep speaker behaviors:

- `front`
- `behind`
- `orbit`
- `above`

`[ADAPTATION]` Omit or defer source `enemies` behavior until it is mapped to environment
creatures. The source implementation depends on shooter `enemies`, `player.position`, and
`gunshipMarkPosition()` at `src/game/main.js:2330-2378`.

`[ADAPTATION]` Omit source `airship` output. The source output depends on `airSupportCraft`
and `ensureAirSupportCraft()` at `src/game/main.js:2131-2137`.

`[ADAPTATION]` Remove `rememberMaterialBase()` from the source speaker-orb helper. That helper
does not exist in this repo and is not needed by the environment viewer.

#### Audio UI

Source references:

- `index.html:73-145` defines the source music-player DOM.
- `index.html:383-384` defines source SFX folder status controls.
- `src/game/main.js:1771-1830` builds volume/mute audio panels.
- `src/game/main.js:2898-2976` renders music-player state and track list.
- `src/game/main.js:25462-25526` wires source music-player DOM listeners.
- `src/game/main.js:25548` wires source SFX folder button.

Target references:

- `environment-ui.js:548-625` creates tabs and panel hosts.
- `environment-viewer.html:3997-4005` calls `createEnvironmentUi(...)`.
- `environment-viewer.html:4110-4152` owns keyboard handlers that may conflict with music
  panel controls.

Target UI contract:

- Add an `Audio` tab to `environment-ui.js`.
- `createEnvironmentUi({ audio, perfLog, sliderState })` should build the audio panel if
  `audio` exists.
- The panel should include:
  - SFX folder picker
  - load/status text
  - master/music/SFX sliders
  - master/music/SFX mute toggles
  - game/folder music source controls if folder music is implemented in phase 1
  - global/speaker output control
  - speaker behavior segmented control
  - bass, echo, reverb, attenuation, tempo, pitch sliders
  - simple current track and previous/play/next controls if playlist browsing is included

`[ADAPTATION]` Do not copy the source music-player overlay wholesale. The viewer already has
a docked control shell; put controls in `environment-ui.js` instead.

`[ADAPTATION]` Stop propagation for pointer and key controls inside the Audio tab so keyboard
shortcuts in `environment-viewer.html:4110-4152` do not trigger while editing sliders or
pressing audio buttons.

#### Viewer event hooks

Target references:

- `environment-viewer.html:4110-4152` handles `KeyM`, `Escape`, `KeyQ`, `KeyH`, `KeyR`, `KeyF`,
  crouch, and prone.
- `environment-viewer.html:4166-4174` handles light place/fire mouse actions.
- `environment-viewer.html:4185-4221` validates and resolves hitscan weapon damage.
- `environment-viewer.html:4282-4297` applies light entity intents.
- `environment-viewer.html:4335-4344` applies jump input while grounded.
- `environment-viewer.html:4367-4397` updates player grounded state and collision resolution.

Initial event mapping:

- `KeyF` enter/exit first person: `weapon_switch` or `vr_drive_on` / `vr_drive_off`.
- `KeyQ` cursor-free toggle: `pause_open` / `pause_close` or `vr_ui_click`.
- `KeyM` map open/close: `map_menu_open` / `map_menu_close`.
- `KeyR` reset: `vr_model_snap` or a new viewer-specific reset event if added later.
- light placement: `vr_light_spawn`.
- light projectile fire: `beam_quick` or `vr_light_toggle`.
- successful hitscan fire: source weapon event matching current weapon if assigned.
- damage applied to another player: `enemy_hit`.
- local player damage: `player_damage`.
- jump: `jump`.
- landing transition: `landing`.
- walking/running cadence: `footstep`.

`[ADAPTATION]` Add a local previous-grounded state around `updateFPSPlayer()` so landing SFX
fires only on false-to-true grounded transitions.

`[ADAPTATION]` Add a footstep timer based on horizontal velocity while `playerOnFloor` is true;
do not play every frame.

`[ADAPTATION]` Multiplayer remote shots and damage should be sounded only once per replicated
intent/state change. Use existing sequence fields such as `fireSeq` from
`environment-viewer.html:203-206` where applicable.

### Non-goals

- No direct filesystem path reads from the browser.
- No direct import of the source shooter `main.js`.
- No full source music-player overlay in the viewer.
- No airship output in phase 1.
- No enemy-following speaker behavior in phase 1 unless mapped to environment creatures.
- No new sound authoring UI. Continue using the source `sfx-browser.html` for assignments.

---

## Plan

### Task 1: Add local audio support modules

- [ ] Add `sound-events.js` from `src/shared/sound-events.js`.
- [ ] Add `music-pitch-processor.js` from `src/game/music-pitch-processor.js`.
- [ ] Add or inline `asset-paths.js` helpers from `src/shared/asset-paths.js`.
- [ ] Add or inline `file-handles.js` helpers from `src/shared/file-handles.js`.
- [ ] Optionally add `live-updates.js` from `src/shared/live-updates.js`.

Verification:

- [ ] `node --check sound-events.js`
- [ ] `node --check music-pitch-processor.js`
- [ ] `node --check environment-audio.js` after Task 2

### Task 2: Implement `environment-audio.js`

- [ ] Build `createEnvironmentAudio(options)`.
- [ ] Port mixer settings and persistence with viewer-specific localStorage key.
- [ ] Port `initAudio()`, `setAudioParamValue()`, `playBuffer()`, `playBufferAt()`.
- [ ] Port SFX entry loading and `sound-map.json` parsing.
- [ ] Port music path caching, streamed playback, retry-after-gesture, and playlist stepping.
- [ ] Port music processing graph and update `workletUrl`.
- [ ] Port speaker-orb rendering with environment-only behaviors.
- [ ] Expose subscription/status updates for UI.
- [ ] Add `dispose()` to disconnect nodes, revoke object URLs, and hide/remove the speaker orb.

`[ADAPTATION]` Inject all viewer state through options:

- `THREE`
- `scene`
- `camera`
- `getPlayerPosition()`
- `isGameplayActive()`
- optional `isDucked()`
- optional `getSpeakerTargets()` for future creature-follow mode

### Task 3: Add Audio tab to `environment-ui.js`

- [ ] Add `['audio', 'Audio']` to `tabDefs` at `environment-ui.js:558-566`.
- [ ] Accept `audio` in `createEnvironmentUi({ perfLog, sliderState, audio } = {})`.
- [ ] Build an audio panel with folder picker, status, volume/mute rows, output controls,
      speaker behavior controls, music effect sliders, and optional track controls.
- [ ] Subscribe to `audio.subscribe(...)` and refresh controls from `audio.getState()`.
- [ ] Stop event propagation from audio controls.

`[ADAPTATION]` Match the existing docked UI style rather than copying `index.html:73-145`.

### Task 4: Wire audio into `environment-viewer.html`

- [ ] Import `createEnvironmentAudio` near `environment-viewer.html:47`.
- [ ] Instantiate `envAudio` after `scene` and `camera` exist, around
      `environment-viewer.html:844`.
- [ ] Pass `envAudio` into `createEnvironmentUi(...)` at `environment-viewer.html:3997`.
- [ ] Call `envAudio.noteGesture()` from keydown, mousedown, and pointer-lock entry paths.
- [ ] Call `envAudio.update(performance.now())` once per frame after camera movement in
      `animate()`.
- [ ] Call `envAudio.restoreSfxFolder()` after UI creation, if permission is still granted.

### Task 5: Wire initial environment events

- [ ] Add map open/close SFX to `KeyM` handling at `environment-viewer.html:4111-4118`.
- [ ] Add cursor-free toggle SFX to `KeyQ` handling at `environment-viewer.html:4136-4140`.
- [ ] Add first-person enter/exit SFX to `KeyF` handling at `environment-viewer.html:4141-4147`.
- [ ] Add reset SFX to `KeyR` handling at `environment-viewer.html:4132-4135`.
- [ ] Add light placement/fire SFX at `environment-viewer.html:4166-4174`.
- [ ] Add local hitscan shot and hit SFX around `environment-viewer.html:4185-4221`.
- [ ] Add jump, landing, and footstep SFX around `environment-viewer.html:4335-4397`.

### Task 6: Live-update compatibility

- [ ] If `live-updates.js` is included, subscribe to `sfx-game` / `sfx-game-update`.
- [ ] Reuse source payload handling from `src/game/main.js:3228-3314`, adapted to the local
      controller state.
- [ ] Confirm updates from the source `sfx-browser.html` apply when both pages share origin.

### Task 7: Verification

- [ ] Serve the workspace over HTTP. Do not use `file://`.
- [ ] Open `environment-viewer.html`.
- [ ] Select `G:\My Drive\Scripts\html game\html-game-v2\M Prime SFX` from the Audio tab.
- [ ] Confirm status reports loaded SFX events and music tracks.
- [ ] Trigger `KeyF`, `KeyQ`, `KeyM`, light placement, light fire, jump, landing.
- [ ] Confirm global music playback after a user gesture.
- [ ] Switch to speaker output and confirm the orb appears and positional audio follows camera.
- [ ] Move bass, echo, reverb, tempo, and pitch sliders and confirm they affect active music.
- [ ] Reload and verify handle restoration when browser permission allows it.
- [ ] Run JS syntax checks for changed modules.

### Task 8: Documentation follow-up

- [ ] Add a short `docs/subsystems/infra.md` note describing `environment-audio.js`.
- [ ] Add a source compatibility note pointing to this plan and the source `HTML_GAME.md`
      audio sections.
- [ ] If new event IDs are added, document them in `sound-events.js` and update the SFX browser
      source project if shared assignment is required.

