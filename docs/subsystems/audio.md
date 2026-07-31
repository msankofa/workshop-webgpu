# Audio / SFX

Positional SFX + music for the environment viewer, plus the browser tool used to bind
sound files to game events. No build step; everything is plain ES modules served over http.

## Files

| File | Role |
|---|---|
| `environment-audio.js` | The runtime controller. Owns its own Web Audio graph (master→sfx gain, HRTF panners), music playback with effects, settings persistence, and the SFX/music folder loaders. Created once in `environment-viewer.html` as `envAudio`. |
| `sound-events.js` | The single source of truth for event ids. `SOUND_EVENT_DEFS` = `[{id,label}]`; `SOUND_EVENTS` = id array; `soundEventById()`. Both the controller and `sfx-browser.html` import this so their event lists can never drift. |
| `sfx-browser.html` | Standalone assignment tool. Browses a folder of audio files (`.wav`/`.mp3`/`.ogg`/`.m4a`/`.aac`/`.flac`/`.opus`/`.webm`) and binds them to event ids, writing `assets/<eventId><ext>` (source extension preserved) + `sound-map.json`. Imports `SOUND_EVENT_DEFS` (module script — serve over http). |
| `sfx/` | The canonical in-repo sound library both tools point at. See `sfx/README.md`. |
| `asset-paths.js` | `getFileByKey(dirHandle, relPath)`, `extensionOf()` — path helpers over File System Access handles. |
| `file-handles.js` | `createHandleStore(db, store)` — IndexedDB persistence of picked directory handles so folders auto-restore. |
| `live-updates.js` | `subscribeLiveUpdates()` / `rememberLiveMessage()` — the `BroadcastChannel('sfx-game')` (+ localStorage fallback) transport that pushes browser edits into a running viewer. |
| `music-pitch-processor.js` | AudioWorklet for independent pitch shifting of music tracks. |
| `weapon-sfx-synth.js` | Procedural WebAudio voices for weapon events that have no sample assigned. Pure WebAudio (no THREE, no DOM beyond the `AudioContext`), Node-tested against a fake context in `test-weapon-sfx-synth.mjs`. |

## Controller API (`createEnvironmentAudio(options)`)

Constructed with `{ THREE, scene, camera, getPlayerPosition, isGameplayActive, isDucked?,
getSpeakerTargets?, workletUrl, autoplayOnGesture? }`. `autoplayOnGesture: false` (used by
`bot-viewer-v2.html`) makes `noteGesture()` only resume music that was already playing or
autoplay-blocked, never start a track on its own — needed when the active playlist is always
populated, as it is for the `'http'` source. Returns:

- `init()`, `noteGesture()` (unlock audio on user gesture), `update(tMs)` (per-frame listener + music orb).
- `play(eventId, vol?)` — non-positional SFX. No-ops silently if the event has no loaded buffer.
- `playAt(eventId, position, vol?, opts?)` — positional SFX; `opts` is a panner profile from
  `positionalSfxProfiles` (`gunshot`, `heavyGunshot`, `explosion`, `minor`, `spawn`, …).
- `hasSfxEvent(eventId)` — true only when a decoded buffer is actually loaded for the id. Never
  loads anything, never throws before `init()`. This is what lets a caller decide *before* calling
  `playAt` whether a sample exists, and fall back to something else if not.
- `playSynthAt(build, position, opts?)` — plays a **procedural** voice at a world position instead of
  a buffer. Builds the same gain → panner (→ optional stereo) → `sfxGain` chain a positional sample
  gets, so the SFX bus volume, mute and `positionalSfxVolumeScale` all apply, then hands the chain's
  input to `build(ctx, destination, startTime)` and lets it schedule its own nodes. `opts` is
  `{ profile, volume = 0.75, volumeScale, cullDistance }` where `profile` is a panner profile exactly
  as for `playAt`. Returns **`false` without starting anything** when: `build` isn't a function, the
  controller is disposed, **the `AudioContext` is not already `running`** (it deliberately never
  forces a resume — the gesture-unlock rule still holds), master or SFX volume is effectively 0
  (muted), the source is past the cull distance, or the builder returns a non-positive duration. The
  chain is torn down `duration + 0.25 s` later, the margin covering filter/panner ring-out past the
  builder's last scheduled stop.
- `pickSfxFolder()` / `restoreSfxFolder()` / `loadSfxFolder(handle)` — load a folder's
  `sound-map.json` and decode its wavs into buffers via the File System Access API (Chrome/Edge
  only, requires a user-granted directory handle). Music folder equivalents also exist.
- `loadMusicHttp({listUrl?, baseUrl?, activate?, select?})` — the third music source (`musicSource:
  'http'`): reads `serve.py`'s `GET /api/list-music` listing of `sfx/music/` and plays tracks
  straight from their served URLs (`./sfx/music/<name>`, per-segment encoded), so a viewer gets a
  full playlist with **no** folder pick and no `sound-map.json` assignment. `select: true` makes
  `'http'` the active source without starting playback; `activate: true` also starts track 1.
  Returns `false` (and leaves the source alone) if the listing is unreachable or has no audio files.
  Unlike the `'game'` source it needs no `sfxDirHandle`, which is what makes it work over plain http.
- `loadSfxHttp(baseUrl?)` — same `sound-map.json` shape, fetched over http instead of a picked
  folder; no permission/gesture needed since it's a same-origin static-file fetch. `restoreSfxFolder()`
  calls this automatically whenever no folder handle is stored or its permission isn't silently
  `'granted'`, so SFX load with zero setup on a fresh browser/profile. A folder picked later via
  `pickSfxFolder()` takes over (and is needed for the live-edit `BroadcastChannel` path from
  `sfx-browser.html`).
- `setVolume(kind,v)`, `setMuted(kind,b)`, music controls, `subscribe()`/`getState()` (drives the
  Audio tab in `environment-ui.js`), `dispose()`.
- `getMusicProgress()` → `{label, path, currentTime, duration, playing}` and `seekMusic(fraction)`
  (0–1 of the duration) — transport position for a progress/seek bar. Deliberately **not** part of
  `getState()`: it changes every frame, while `notify()` only fires on real state changes, so a UI
  polls this instead (`bot-viewer-v2.html` does, at 4 Hz).
- `getAudioLevels()` → a **reused** `{bass, mid, treble, level, beat, playing}` (0–1 each; never
  allocates, so it is safe to call every frame). Fed by an `AnalyserNode` tapped off each music
  track's `effectLimiter` — post-effects, pre-output, so the visuals see what you hear. **Music
  only**: the SFX bus is a separate chain, and gunfire driving the room lights would swamp the
  music. `beat` is a decaying envelope kicked when bass exceeds its own running baseline by 25%
  (with a 120 ms refractory window, so one kick reads as one beat). Everything decays smoothly to
  0 when nothing is playing, rather than snapping. The band split itself is the pure exported
  `spectrumBands(bins, sampleRate, fftSize, out?)` / `SPECTRUM_BANDS`, Node-tested in
  `test-audio-levels.mjs` — the analyser plumbing around it is browser-only.
- `getSpectrum(out)` — fills any array-like with `out.length` **log-spaced** bar magnitudes
  (40 Hz–12 kHz) off the same analyser, for a spectrum display; bars decay by 0.82/call rather
  than snapping flat when playback stops. Pure half is the exported
  `spectrumBars(bins, sampleRate, fftSize, out, {fromHz, toHz})`, also Node-tested. Log spacing is
  what stops the display being one fat bass bar and fifteen empty ones; narrow low bars widen to
  at least one FFT bin so rounding can't starve them.
- `setShuffle(bool)` (+ `shuffle` in `getState()`, `shuffle: true` constructor option) — shuffled
  playback for whichever source is active. The order is a Fisher-Yates permutation of the current
  playlist, rebuilt only when the playlist itself changes, so a pass plays every track exactly once
  before repeating. Running off the end starts a fresh pass (never opening on the track just
  heard); stepping back off the start does **not** reshuffle, so within a pass `prevTrack()` undoes
  `nextTrack()`. `togglePlayback()` from stopped and the folder/http `syncMusicForState` paths open
  on the shuffled head rather than track 1. Default off; `bot-viewer-v2.html` passes `shuffle: true`.
- `prevTrack()` / `nextTrack()` / `togglePlayback()` / `playTrack(entry)` — playlist controls for
  whichever music source is active (`musicSource`: `'game'` = the `sound-map.json` `music_menu`/
  `music_game` events, `'folder'` = a folder picked via `pickMusicFolder()`). `playTrack(entry)`
  jumps straight to one `{eventId, path, label}` entry instead of stepping; entries come from
  `getState().playlist` (`activeMusicPlaylist()` internally). `getState()` also exposes
  `currentTrackPath` so a UI can highlight which playlist entry is currently playing.

`sound-map.json` shape: `{ version, events: { <id>: "assets/<id><ext>" | [paths] },
sources: {...}, modes: {...}, volumes: {...} }`. Only ids in `SOUND_EVENTS` are loaded. `<ext>` is
whatever the assigned source file actually was (`sfx-browser.html` preserves it instead of forcing
`.wav`) — matters for `music_menu`/`music_game`, which are typically mp3/ogg, not wav.

## Wiring in `environment-viewer.html`

`envAudio` is created ~line 1054. Event fire points:

- **Weapons** — `weaponFireEvent(weaponId)` maps `m24 → sniper_shoot`, `cz_805_bren → rifle_shoot`,
  `rpg → rocket_launch`, `grenade → grenade_throw`, `knife → knife_swing`, everything else (incl.
  default `m1911`, `five_seven`) `→ pistol_shoot`. Fired non-positionally for the local shot
  (`envAudio.play`) and positionally for host/remote shots (`envAudio.playAt(..., gunshot)`).
  `resolveWorldShot` returns a `hit.kind` of `player`/`creature`/`mob`/`terrain`/`obstacle`/
  `none`: entity hits play `enemy_hit` at the hit point plus `player_damage` if the
  local player was hit; world-surface hits (terrain/rock/tree) play `bullet_impact` in
  `spawnShotEffects` / `spawnMeleeImpact`, gated so it never doubles the entity `enemy_hit`.
  Explosions (grenade/RPG detonation) play `explosion` positionally at the blast center with the
  `largeExplosion` profile in `applyExplosionBlast`.
- **Movement** — `jump`, `landing`, and stride-cadence `footstep` in `animate()` (~6021–6031).
- **Menu / interaction** — `pause_open/close`, `map_menu_open/close`, `vr_drive_on/off`,
  `vr_model_snap`, `vr_light_spawn`, `beam_quick` (~5470–5798).

The Audio tab (`environment-ui.js`, SFX/music pickers ~1099/1117) calls `envAudio.pickSfxFolder()`
etc.; folders auto-restore on load (~5028).

**Track list.** The Audio tab's "Track" card (`buildAudioPanel`) has a scrollable `.wui-list` of
every entry in `state.playlist`, not just prev/next/play transport buttons — clicking a row calls
`audio.playTrack(entry)` directly. Rows are rebuilt only when the playlist's `eventId|path` keys
change (`lastPlaylistKey`), so the active-row highlight (`state.currentTrackPath`) can update every
`subscribe()` tick without full DOM churn. What shows up depends on **Music source**:
- `Game` — whatever's assigned to `music_menu`/`music_game` in `sound-map.json` (usually 0-2
  tracks; playback additionally requires an SFX folder picked via `pickSfxFolder()`, since
  `cacheMusicPath()` reads through `sfxDirHandle` — the zero-setup `loadSfxHttp()` path loads SFX
  buffers fine but does not populate playable music paths).
- `Folder` — every track in whatever folder was picked via "Choose music folder…" (Music folder
  card, File System Access). Pointing this at `sfx/music/` gives the same standard track set the
  start-screen song list uses, fully routed through the real audio graph (spatial output, effects,
  pitch/tempo) instead of start-screen.js's plain `<audio>` element.
- `http` — the same `sfx/music/` track set as `Folder` but sourced from `GET /api/list-music`
  instead of a directory handle, so it needs no picker and no permission. This is what
  `bot-viewer-v2.html` selects at startup; the environment viewer's Audio tab does not expose it
  yet (its Music source control still offers Game/Folder only).

## Wiring in `bot-viewer-v2.html`

The bot harness runs the same controller (~line 75). Differences from the environment viewer, all
because there is no local player and the arena is ~40 m across, not ~1 km:

- **Listener** is the camera itself (`getPlayerPosition: () => camera.position`), which covers both
  orbit and bot-POV modes. `isGameplayActive` is constant `true`, so the gameplay-transition music
  sync in `update()` never fires, and `autoplayOnGesture: false` keeps clicks in the viewport from
  starting music. Nothing plays until ▶ or a track row is clicked.
- **Every SFX is positional** and goes through `playAtCulled(eventId, pos, profile, maxPerWindow,
  maxDist)`, which adds three things `playAt` doesn't have: a `botAudioEnabled` master switch (the
  panel's "Bot SFX" button), a distance cull, and a per-event voice budget (N starts per 100 ms) —
  30 bots on full auto would otherwise request hundreds of shots a second.
- **`BOT_SFX`** is a local panner-profile set (gunshot `refDistance` 8 vs. the shared profile's 25)
  so distance actually attenuates inside a shoot house. Only `positionalSfxProfiles.short` is reused.
- Fire points: `fireBotShot` (weapon report via the same `weaponFireEvent` map + `bullet_impact`
  for world hits), `applyCombatDamage` (`enemy_hit`), `fireBotKnife` (`knife_swing`),
  `detonateBlast` (`explosion`), and `updateBotFootstep` (per-bot stride-cadence `footstep`,
  culled to the panner's own audible radius). `player_damage`/`jump`/`landing`/menu ids are unused
  here. `knife_swing`, `grenade_throw`, and `rocket_launch` have no asset assigned in
  `sfx/sound-map.json` yet; `grenade_throw` and `rocket_launch` now take the procedural fallback
  below instead of going silent, and `knife_swing` is still a silent no-op (no synth voice exists
  for it).
- **Sample first, synth second.** `playAtCulled` ends with
  `if (envAudio.hasSfxEvent(id)) { envAudio.playAt(...); return; }` and only then reaches for
  `synthVoice(id)` + `envAudio.playSynthAt(voice, pos, { profile })`. So assigning a wav to an event
  in `sfx-browser.html` silently takes over from the synth with no code change, and the
  `botSynthSfxEnabled` toggle ("Synth SFX fallback", in the panel's **Explosives** section) only ever
  affects events that have no sample. The distance cull and the per-event voice budget are applied
  before either path, so the fallback is under the same budget as a real sample.
- **Panel**: an "Audio" section in `#ctrl` — master/music/sfx sliders, mute, Bot SFX toggle, the
  music-reactive lighting toggle + drive slider, then the player: source select → **display** →
  transport keys → playlist. The six effect sliders plus the music-output and speaker-behavior
  selects live in their own collapsible **Music FX** section, and the status line and the two
  optional folder pickers sit below the playlist.
- **The display** (`.mp3` + `.scr-*`, styled by a local `<style>` appended after
  `installPanelTheme` so it wins the cascade) is an amber VFD-style screen sunk into the otherwise
  light panel: a lit status strip (`PLAY`/`PAUSE`/`STOP`, `SHUF`, `nn/nn`, source), the track
  title with an overflow-only marquee, a **live spectrum analyser** on a canvas, an LED-segment
  seek strip, and the clock. Interactive bits: the seek strip scrubs on click *and* drag (pointer
  capture, so a drag that leaves the strip keeps working), the `SHUF` segment toggles shuffle, and
  clicking the clock swaps total duration for time remaining. The transport keys below light up
  (`.lit`) for play and shuffle state.
- The spectrum is `getSpectrum()` into a reused `Float32Array` (28 log-spaced bars) drawn **every
  frame** — 4 Hz is fine for a clock but not for an analyser — with slowly falling peak caps. Its
  mean level is written to the card's `--lit` CSS custom property, which drives the screen's inner
  glow, the title's text-shadow and the bloom wash, so the whole display breathes with the music.

  Four rules keep a per-frame canvas in a debug panel from costing frame time, all of them things
  the first version got wrong:
  1. **No layout reads in the draw.** `offsetParent` and `clientWidth` are forced-layout reads and
     writing `--lit` dirties style, so doing both per frame flushed the panel's layout every frame.
     Both measurements moved to `measureSpectrum()`, called from the 4 Hz poll.
  2. **One gradient, built on resize.** `createLinearGradient` per bar per frame was 28 allocations
     a frame; the display now shares one absolute top-to-bottom ramp (which is how a hardware
     analyser reads anyway).
  3. **Fills batched by style** — 3 `fillStyle` changes for the whole display, not 3 per bar.
  4. **Idle frames repaint nothing.** Once playback stops and the peak caps have fallen, the canvas
     already shows that exact frame, so the draw returns before touching it. `--lit` is quantised
     to 2% steps for the same reason — each distinct value costs a style recalc of the card.

  Drawing is skipped entirely when the card is off screen (section collapsed or panel hidden), and
  the analyser read no-ops when nothing is playing, so a quiet display costs nothing.
- **One analyser read per frame, shared.** `getAudioLevels()` (lights) and `getSpectrum()`
  (display) both want `getByteFrequencyData`, which rebuilds the magnitude spectrum on every call.
  `refreshAnalyserBins()` gates it to one read per 4 ms, so calling both in a frame costs one.
- **Now-playing HUD**: `#nowplaying` sits in `#hud-bottom` next to the fps counter (one flex row,
  so it doesn't hard-code the counter's width) and fades in for ~5 s whenever `currentTrackPath`
  changes to a new track, driven from the same `subscribe()` callback.
- The transport readout is **polled**, not notified — `getMusicProgress()` is read at 4 Hz from the
  frame loop, because `notify()` only fires on real state changes and a seek bar needs to move
  between them.
- **Audio-reactive lighting**: `createVisualSystem({... getAudioLevels})` in
  `bot-viewer-visuals.js`. Its `update(dt)` smooths the analyser bands (`advanceAudioMix`, so
  toggling ramps and a paused track fades out) and routes them to **five independent groups** —
  see "Reactive routing" below. The effect lives in the visuals module but its **controls sit in
  the Audio panel section** ("Reactive lights" + "reactive drive" + a row of group chips, under
  Bot SFX), reading and writing `visuals.audioReactive` / `visuals.audioDrive` /
  `visuals.audioTargets` through `setAudioReactive()` / `setAudioDrive()` / `setAudioTarget()`
  — it is driven by music, and it is not a look property, so `buildPanel()` deliberately does not
  own it. All three ride along in the UI slot's `visuals` look state, so the slot-apply
  path calls `syncReactiveLightsUi()` after `applyLookState()` to refresh widgets `buildPanel()`
  no longer syncs. Default off, and when off `getAudioLevels()` is not called at all, so the
  analyser costs nothing.

### Reactive routing (`REACTIVE_TARGETS`)

The routing table lives in `bot-viewer-visuals-style.js` (the Node-testable half) so the panel
chips and the update loop read the same source. Each group has per-band weights plus a `depth`:
the bands say *when* it moves, `depth` says *how far*. Splitting them is the whole point — on one
shared envelope the scene pumps as a single blob, which reads as a brightness bug rather than as
music.

| Group | Driven by | Depth | Scales |
|---|---|---|---|
| `lights` | bass 0.9 + beat 0.7 | 1 | accent-light intensity, on top of the existing sine breathe |
| `bloom` | level 0.5 + beat 0.35 | 1 | `postFX.setBloom` strength |
| `neon` | bass 0.55 + mid 0.25 + beat 0.5 | 0.6 | `gridGain scanGain trimGain stripeGain capGain pulseGain` |
| `bots` | mid 0.3 + treble 0.7 + beat 0.55 | 0.7 | `shellGlow plateGlow trimGlow eyeGlow botRimGain poolGain` |
| `sky` | bass 0.2 + treble 0.25 + level 0.35 | 0.5 | `nebGain starGain sunGain` |

`lights` and `bloom` reproduce the original single-envelope formulas exactly, so the change does
not retune a look that was already dialled in. `sky` is **off by default** (a pulsing starfield is
a taste call, and it moves the whole image at once); the rest ship on.

Rules the implementation keeps to:

- **Multiply, never set.** `reactiveGain()` returns an additive boost applied as
  `base * (1 + gain)`, where `base` is captured by `applySky()` / `applyMaterials()` / `applyBots()`
  at the moment they write the theme value. So a slider you moved is still the ceiling, anything
  the theme leaves at 0 stays off however loud the track is, and the pump can never compound off
  its own previous output.
- **Write only while pumping**, plus one restoring write when a group stops — an idle group costs
  zero uniform writes per frame and never fights the panel's sliders. `captureBase()` also records
  which uniforms in a group are actually non-zero, and only those are written: pumping a uniform
  the theme has switched off would dirty that material's uniform buffer every frame to write 0.
- **Nothing is read when the feature is off.** `getAudioLevels()` is only called while
  `audioReactive` is true, so the analyser and the whole routing path cost nothing by default.
- **Clamped at `REACTIVE_MAX` (2.0).** Drive tops out at 2.5 and weights sum to ~1.6, so without
  the clamp a loud passage would take neon to ~4× and flatten the map to white.
- **Per-group enable is ramped, not switched** (~0.125 s), so turning a chip off mid-track fades
  it back to the theme value instead of cutting.
- **Shuffle is on by default here** (`shuffle: true` at construction) — harness sessions run long
  and the sfx/music/ listing is meant to be background. 🔀 turns it off; the env viewer's Audio tab
  now has the same button but still defaults to off.

`test-audio-levels.mjs` covers the spectrum band split (`spectrumBands`) that drives the reactive
lighting; `test-bot-viewer-visuals.mjs` covers the routing on top of it (`REACTIVE_TARGETS`,
`reactiveGain`, `advanceAudioMix` — including that `lights`/`bloom` still match the pre-routing
formulas, that band separation actually separates, and that the clamp holds). `test-audio-http-music.mjs` covers the `'http'` source (listing → playlist, extension filtering,
URL encoding, prev/next walking, `select` vs. `activate`, empty/offline listings) **and shuffle**
(opt-in, full-pass coverage, no repeat on wrap, prev-undoes-next, single-track playlists) by
running the real controller against DOM stubs with no `AudioContext`.

## Music effect units (fixed 2026-07-25)

`setMusicEffect(key, value)` takes the controller's own units, and they are **not** normalized:
`bass` is lowshelf dB `[0,18]`, `echo`/`reverb` are percent `[0,100]`, `attenuation` is percent of
normal `[0,200]` (default 100), `tempo` is percent of normal `[50,200]` (default 100), `pitch` is
semitones `[-12,12]`. `environment-ui.js`'s `AUDIO_EFFECT_DEFS` used to declare 0–1 / 0.5–2 ranges,
so every slider in the Audio tab fed `setMusicEffect` a value it clamped to the floor — dragging
Tempo to its middle asked for 1, which clamped to 50 and played at half speed, while `refresh()`
wrote the real 100 back into a 0.5–2 input and pinned the readout at "2.00x". Both panels now use
the real ranges.

## Procedural weapon voices (`weapon-sfx-synth.js`)

The explosives work in `bot-viewer-v2.html` needed launch/blast/throw sounds that the in-repo sfx
library has no files for. Rather than ship placeholder wavs, `weapon-sfx-synth.js` synthesizes them
from oscillators and filtered noise, and the controller grew `hasSfxEvent` / `playSynthAt` (above) so
a caller can prefer a real sample and fall back to a voice.

- `SYNTH_EVENT_IDS` — `['rocket_launch', 'explosion', 'grenade_throw', 'grenade_bounce']`.
- `synthVoice(eventId)` — returns `build(ctx, destination, t0) => durationSeconds`, or `null` for an
  id with no voice. A builder connects **only** to the `destination` it is handed and schedules
  everything with `AudioParam` automation from `t0` — never `setTimeout`, so a voice can't outlive or
  desync from the chain `playSynthAt` tears down after it.

| Voice | Duration | Made of |
|---|---|---|
| `rocket_launch` | 0.80 s | bandpass noise ignition crack, sine thump 88→43 Hz, swept-lowpass whoosh tail |
| `explosion` | 1.40 s | sine body 68→23 Hz, resonant-lowpass noise crackle, long low noise tail |
| `grenade_throw` | 0.25 s | one short bandpass noise swish (cloth/handling) |
| `grenade_bounce` | 0.12 s | lowpass noise pop + a pitched triangle click |

Two implementation details that matter at firefight volume: the white-noise buffer is **created once
per `AudioContext`** and cached in a `WeakMap` (dozens of voices a second would otherwise allocate a
2-second buffer each), and per-shot variation comes from a **deterministic counter hash**, not
`Math.random()` — repeats differ from each other but a session is reproducible.

`grenade_bounce` is deliberately **not** in `sound-events.js` — it is a synth-only id, so it can never
be assigned a sample and always takes the synth path. It currently has **no call site**: the voice
exists ahead of the bounce hook in the projectile manager. `test-weapon-sfx-synth.mjs` runs every
builder against a fake `AudioContext`, asserting the documented durations, that each node's signal
actually reaches the destination, that scheduling stays inside the reported window, that the noise
buffer is built once per context, that repeats vary, and that a builder touches nothing outside the
ctx/destination it was handed.

## Event catalog

`sound-events.js` is **curated to this workspace** — every id is fired by a real call site (see
above), not inherited from the arena shooter it was ported from. Reconcile with:

```
node -e 'import("./sound-events.js").then(m=>console.log(m.SOUND_EVENTS.length))'
```

New sounds are a two-step add: put the id in `sound-events.js`, then fire it from
`environment-viewer.html`. An id must exist in `sound-events.js` to be both assignable (browser
picker) *and* loadable (`environment-audio` skips ids not in the list).

## Known gaps

- **`music_menu`/`music_game`** are driven by the music system (`desiredMusicEvent`), not `play()`.
  `desiredMusicEvent()` picks `music_game` during gameplay only if a track is actually assigned to
  it; otherwise it returns `''` (silence), not `music_menu` — the menu track intentionally does not
  bleed into gameplay just because no game track exists yet.
- **`envAudio` never autoplays music on its own.** `loadSfxHttp()`/`loadSfxSounds()` (run
  automatically at startup via `restoreSfxFolder()`) load SFX/music buffers but deliberately do
  *not* call `syncMusicForState()` afterward — that used to auto-start the `music_menu` track the
  moment loading finished, which meant it played through the entire "Loading world systems…"
  sequence (already showing the orbit-camera world preview) and only cut out once `gameplayActive`
  flipped, well after the player felt like they were already "in the game." Automatic playback is
  now start-screen.js's job exclusively (see below), scoped to the role/map picker only. The only
  remaining automatic trigger inside `envAudio` is the gameplay-state transition in `update()`,
  which plays `music_game` if (and only if) one has been explicitly assigned — nothing plays by
  default. Manual controls (Audio tab `Source: Game` toggle, live sfx-browser.html edits) still
  work; they call `syncMusicForState`/`playMusicEvent` directly in response to an explicit action.

## Start-screen menu music

`start-screen.js` plays a track during the role/map picker (`_startMenuMusic()`), before
`environment-viewer.html` has constructed `envAudio` at all — it can't reuse the controller, so it's
a standalone `<audio loop>` element. It reads
`localStorage['environment-viewer-audio-settings']` (`masterVol`/`musicVol`/`*Muted`) read-only so
menu volume matches the in-game Audio tab, scaled by the same 0.16 base menu volume
`environment-audio.js` uses. It stops (0.25s fade) right before the loading step begins, not on
`dismiss()` — `envAudio`'s own `music_menu` playback starts as soon as it initializes during
loading, so leaving the start-screen copy running any longer would double it up. A "Restart" resume
(`resumeConfig` set) skips it entirely since that path goes straight to loading.

**Autoplay is menu-only.** The first track in `sfx/music/` (alphabetical, per `GET /api/list-music`)
starts playing as soon as the listing resolves — this is the one place autoplay is wanted. Gameplay
never falls back to it: `environment-audio.js`'s `desiredMusicEvent()` returns silence during
gameplay if no `music_game` track is assigned (see "Known gaps" below), so this autoplay can never
bleed into actual play.

**Track selection** — a scrollable song list on the role/map picker (`_musicPicker()`), not a
dropdown, so it stays usable as `sfx/music/` grows: one row per file in `sfx/music/`, listed via
`GET /api/list-music` (`serve.py`) so any track dropped in that folder is selectable (and
autoplayable) with no assignment step. There is no separate `sfx-browser.html`
`music_menu`-event path here anymore — that indirection was redundant with the folder listing and
was removed.

Clicking a row switches `menuMusic` to it (`setTrack()` swaps `audio.src` live); clicking the
currently-playing row again stops it (`setTrack('off')`). Selection is not persisted — every visit
to the start screen restarts from the first track. Silent if `sfx/music/` is empty.

## Multiplayer impact audio

Guests now sound impacts off the replicated `hit_spark` effect upserts they already render: the
guest sim_state callback (~600) plays `enemy_hit` (surface `player`/`creature`/`mob`) or
`bullet_impact` (world surfaces) positionally, once per effect id (tracked in `mpSeenImpactFx`,
pruned to the live id set). Gun *reports* were already replicated (host sounds guest shots in
`applyCombatIntent`; guests sound each other via the broadcast `fireSeq`). The host still plays
its own impacts directly inside `applyCombatIntent`/`spawnShotEffects`.

## Combat SFX gating layer (environment-viewer-v2.html)

Positional *combat* voices in the v2 viewer do not call `envAudio.playAt` directly any more — they
go through `playAtCulled(eventId, position, kind, maxPerWindow)`, a port of the bot-viewer-v2 layer
(`bot-viewer-v2.html:140-177`). Ninety bots on full auto otherwise request hundreds of voices a
second.

```
playAtCulled(eventId, position, kind, maxPerWindow = 6)
  1. botAudioEnabled gate (panel checkbox)
  2. squared-distance cull vs the listener, radius = audioCullDist(kind)
  3. sfxBudgetOk(eventId, maxPerWindow, 100ms)  -- one rolling window per event id
  4. envAudio.hasSfxEvent(eventId) ? playAt(..., combatSfxProfile(kind))
     : botSynthSfxEnabled && synthVoice(eventId) ? playSynthAt(voice, ..., { profile })
     : silence
```

- `kind` is one of `gunshot | launch | explosion | impact | step`. It selects both the panner
  profile (`combatSfxProfile`, arena-vs-outdoor as before) and the cull radius.
- Cull radii: `AUDIO_CULL_ARENA` (shoot house, harness parity) = gunshot/launch/explosion 70,
  impact 60, step 26. `AUDIO_CULL_OUTDOOR` (1 km map) = gunshot 250, launch 220, explosion 420,
  impact 100, step 30 — each class culls at its own profile's `maxDistance`, because an `inverse`
  panner clamps there rather than fading to zero. `largeExplosion` clamps at 1100 m and never fades,
  so its 420 m value is a budget bound instead.
- Budgets (per 100 ms, shared across all bots): gunshot 8, impact 8, launch 4, `knife_swing` 4,
  `footstep` 4, explosion 3.
- Fallback voices come from `weapon-sfx-synth.js` (`synthVoice`): `rocket_launch`, `explosion`,
  `grenade_throw`, `grenade_bounce`. **A loaded sample always wins.**

**Never gated:** the local player's own first-person weapon report and `player_damage` are
`envAudio.play(...)` — non-positional, and neither distance-culled nor budget-culled.

Bot footsteps use the same gate (`updateBotFootstepSfx`, 1.7 m stride per bot off the capsule
position, every frame from the bot loop). Panel toggles: `botAudioEnabled`, `botSynthSfxEnabled`.
