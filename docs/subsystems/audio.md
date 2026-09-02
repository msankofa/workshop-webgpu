# Audio / SFX

Positional SFX + music for the environment viewer, plus the browser tool used to bind
sound files to game events. No build step; everything is plain ES modules served over http.

## Files

| File | Role |
|---|---|
| `environment-audio.js` | The runtime controller. Owns its own Web Audio graph (master→sfx gain, HRTF panners), music playback with effects, settings persistence, and the SFX/music folder loaders. Created once in `environment-viewer.html` as `envAudio`. |
| `sound-events.js` | The single source of truth for event ids. `SOUND_EVENT_DEFS` = `[{id,label}]`; `SOUND_EVENTS` = id array; `soundEventById()`. Both the controller and `sfx-browser.html` import this so their event lists can never drift. |
| `bbc-sfx-api.js` | Client for the BBC Sound Effects archive: query building, response normalization, client-side duration/channel filtering, media URLs and download naming. Pure except `searchBbcSfx`, whose `fetch` is injected. Node-tested in `test-bbc-sfx-api.mjs` (`--live` adds one real call). |
| `sound-environments.js` | The ambience registry — looping `ambience` beds and positional `location` emitters, each holding up to `MAX_ENVIRONMENT_LAYERS` layers. Same single-source-of-truth contract as `sound-events.js`. Nothing plays these yet. |
| `sfx-browser.html` | Standalone assignment tool. Browses a folder of audio files (`.wav`/`.mp3`/`.ogg`/`.m4a`/`.aac`/`.flac`/`.opus`/`.webm`) and binds them to event ids, writing `assets/<eventId><ext>` (source extension preserved) + `sound-map.json`. Imports `SOUND_EVENT_DEFS` (module script — serve over http). |
| `sfx/` | The canonical in-repo sound library both tools point at. See `sfx/README.md`. |
| `asset-paths.js` | `getFileByKey(dirHandle, relPath)`, `extensionOf()` — path helpers over File System Access handles. |
| `file-handles.js` | `createHandleStore(db, store)` — IndexedDB persistence of picked directory handles so folders auto-restore. |
| `live-updates.js` | `subscribeLiveUpdates()` / `rememberLiveMessage()` — the `BroadcastChannel('sfx-game')` (+ localStorage fallback) transport that pushes browser edits into a running viewer. |
| `music-pitch-processor.js` | AudioWorklet for independent pitch shifting of music tracks. |
| `weapon-sfx-synth.js` | Procedural WebAudio voices for weapon events that have no sample assigned. Pure WebAudio (no THREE, no DOM beyond the `AudioContext`), Node-tested against a fake context in `test-weapon-sfx-synth.mjs`. |
| `bot-damage-audio.js` | Mechanical bot hit/damage/death voices (one-shot **and** sustained), the pure hit-tier function, and the controller that decides which plays. Node-tested in `test-bot-damage-audio.mjs` (voices + tier table) and `test-bot-damage-audio-controller.mjs` (siren lifecycle, eviction, budget/slot reclamation, teardown — every world query and audio call is an injected fake, so no `AudioContext`). See "Bot damage / death audio" below. |
| `bot-voice.js` | The robotic callout lexicon (22 phrases, Peterson & Barney vowel formants) and its formant-bank synthesis. Pure WebAudio. See "Bot voices and squad chatter" below. |
| `bot-voice-director.js` | Arbitration for those callouts: concurrency cap, cooldowns, dedup, rate limits, distance culling. Pure logic, no WebAudio. Both are Node-tested in `test-bot-voice.mjs`. |
| `sound-params.js` | **Every authored number the procedural audio depends on, in one editable place.** Imports nothing, so the synth modules, both viewers, the studio and the Node tests can all read it without a cycle or a file read. See "Sound parameter registry" below. |
| `sound-params.json` | The override document the studio writes and both v2 viewers fetch at boot. Holds only what differs from the schema defaults. Validated by `test-sound-params.mjs`. |
| `sound-studio.html` | Standalone design tool for the procedural voices: bench + offline analyzer, lexicon editor, distance/masking measurement, and a headless firefight simulation of the trigger rules. Imports the real modules, so what it measures is what the game produces. Needs http (`python serve.py`). |

## Controller API (`createEnvironmentAudio(options)`)

Constructed with `{ THREE, scene, camera, getPlayerPosition, isGameplayActive, isDucked?,
getSpeakerTargets?, workletUrl, autoplayOnGesture? }`. `autoplayOnGesture: false` (used by
`bot-viewer-v2.html`) makes `noteGesture()` only resume music that was already playing or
autoplay-blocked, never start a track on its own — needed when the active playlist is always
populated, as it is for the `'http'` source. Returns:

- `init()`, `noteGesture()` (unlock audio on user gesture), `update(tMs)` (per-frame listener + music orb;
  the listener update reuses two module-scope scratch vectors, so it allocates nothing per frame).
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
- `playSynthLoop(build, position, opts?)` — the **sustained** sibling of `playSynthAt`, for voices
  that end on an *event* rather than after a known duration (a death siren stops when the bot is
  revived or the revive window closes). The builder contract differs: `build(ctx, destination, t0)`
  returns **a stop handle `{ stop(atCtxTime) }`**, not a duration. Same gain → panner → `sfxGain`
  chain and the same refusal conditions as `playSynthAt`, plus one more: it refuses once
  `LOOP_VOICE_CAP` (8, imported from `combat-audio-budget.js`) sustained voices are already live.
  Returns a controller handle, or `false` when nothing started:
  - `stop(fadeOutS = 0.15)` — ramps the shared gain down, calls `inner.stop(now + fade)`, drops the
    chain `fade + 0.25 s` later. Idempotent, so the owner and the sweep can both call it.
  - `setTargetVolume(v, rampS = 0.2)` — how a caller ducks a pile-up (e.g. `1/sqrt(activeCount)`)
    without rebuilding the voice.
  - `updatePosition(pos)`, `id`, `stopped`.
  `opts` adds `{ isAlive, getPosition }` on top of `playSynthAt`'s. Those drive a per-frame sweep
  inside `update()` that force-stops orphaned loops (owner culled mid-siren, scene reset) and
  follows a moving source. The sweep is a **backstop**, not the primary teardown: the owning module
  still stops its own loops, because only it knows whether an ending deserves a fade, a power-down
  or a hard cut. `dispose()` force-stops every live loop; `activeLoopCount()` reports the count.
  Its only consumer today is `bot-damage-audio.js` (below).
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
  `listUrl`/`baseUrl` point it at any served folder: `pokemon-lab.html` passes serve.py's
  `GET /api/list-pokemon-music` (the `pokemon/Stadium Music/` rip; `GET /api/list-pokemon-cries` is
  the sibling listing of `pokemon/poke_cries/`, both served by the shared `_handle_list_audio_dir`).
- `loadSfxHttp(baseUrl?)` — same `sound-map.json` shape, fetched over http instead of a picked
  folder; no permission/gesture needed since it's a same-origin static-file fetch. `restoreSfxFolder()`
  calls this automatically whenever no folder handle is stored or its permission isn't silently
  `'granted'`, so SFX load with zero setup on a fresh browser/profile. A folder picked later via
  `pickSfxFolder()` takes over (and is needed for the live-edit `BroadcastChannel` path from
  `sfx-browser.html`).
- `setUnderwater(on)` swings a master-bus low-pass between 620 Hz (submerged) and 20 kHz (bypassed); Base Game calls it when the camera crosses the water surface.
- `setVolume(kind,v)`, `setMuted(kind,b)`, music controls, `subscribe()`/`getState()` (drives the
  Audio tab in `environment-ui.js`), `dispose()`.
- `playBufferAt(buffer, position, vol?, opts?)` — the positional chain `playAt` uses, for a buffer
  the caller decoded itself (via the exported `decodeAudio`) instead of a registered event.
  `pokemon-lab.html` plays cries through it, decoded lazily per species. `opts.playbackRate` sets the
  source rate (tempo, dragging pitch with it) and `opts.pitchRatio` is the pitch the caller wants: the
  difference is made up by a `music-pitch-processor` worklet node (0.5–2×, so extreme combinations stop
  short) inserted only when it matters and only once the module has loaded — `preparePitchWorklet()`
  loads it ahead of the first press. `opts.offset`/`opts.duration` (seconds into the buffer) and `opts.delay` (seconds from
  now) play a slice on a schedule, and `opts.insert(ctx, input, { source, startTime, duration })` lets the
  caller put its own nodes between the source and the panner and return the chain's output — the lab's
  bass shelf, vibrato, tremolo and envelope live there, not in the controller.
- `setMusicSpeakerBehavior` accepts a fifth behavior, **`'fixed'`**: the orb holds a world position
  instead of following the player/camera (seeded in front of the camera, or wherever the orb was when
  switched). `setMusicSpeakerPosition(pos)` sets that position directly — it also forces the behavior
  to `'fixed'` and snaps the orb, which is what a host's drag calls per pointer move.
  `getMusicSpeakerObject()` returns the orb group so a host can raycast it to make it draggable.
- `setWorldScale(s)` (also the `worldScale` construction option, default 1): multiplies every distance in
  the speaker path — the orb's follow offsets and size, and the music panner's `refDistance`/`maxDistance`
  — for a scene whose units are not metres. `pokemon-lab.html` sets it per species from the measured rig
  (span / 1.8; the models are 9–147 units tall), which is what made the orb audible there at all. A held
  `fixed` position is dropped on rescale.
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

## Pulling sounds from the BBC archive

`sfx-browser.html`'s **BBC SOUNDS** tab searches the BBC Sound Effects archive in-page. Both the
search API and the media CDN send `Access-Control-Allow-Origin: *`, so there is no `serve.py` proxy
and no API key. Playing streams from the CDN; DOWNLOAD writes into `sfx/bbc/` and registers the
handle so the file behaves like any other library sound with no reload.

Two things about the API worth knowing before touching `bbc-sfx-api.js`:

- Its `criteria` object must be sent **whole** — a partial one is rejected — which is why
  `buildSearchBody()` always emits every key.
- It accepts a `durations` criterion and then **ignores** it (`["0-5"]` returns the same 2,061 wind
  results as no filter), so length and channel narrowing happen client-side in `filterResults()`.

The archive is RemArc-licensed: personal, educational and research use, not general commercial use.

## Ambience slots (`sound-environments.js`)

A second registry beside `sound-events.js`, for looping background sound rather than one-shots. Each slot is an
`ambience` (chosen by world condition) or a `location` (positional emitter) and holds up to four
layers, each `{path, source, gain, loop}`. `sfx-browser.html` writes them into a new `environments`
key in `sound-map.json`; `normalizeEnvironmentMap()` drops unknown ids and malformed layers on the
way back in. The key is additive — `environment-audio.js` reads only `events` and ignores it.

**No runtime consumes these yet.** The editor and the data format exist; picking a bed from time of
day, terrain and weather and crossfading it is the next job.

## Wiring in `base-game.html`

Same controller, driven through the pure `base-game-audio.js` director (local/remote footsteps,
jump/landing, reload/draw handling, pause menu, per-event budget, cull, sample-or-synth). See the
"Audio" section of `base-game.md`. `weapon-sfx-synth.js` gained `weapon_reload`, `weapon_draw`,
`footstep`, `jump` and `landing` voices for it (the last three ported from html-game-v2's
fallbacks), the first two ids are new in `sound-events.js`, and `sfx/` now holds html-game-v2's
footstep/jump variant sets plus landing, pause and weapon-switch files.

Firing (weapons phase 3, 2026-08-23): the director's `localFire(weaponId)` now plays on every
predicted shot, `updateRemote`'s `action === 2` report plays for remote shots (the server keeps the
fire action stamped for 12 ticks so a 20 Hz snapshot sees it), and two calls were added for the
server's hit events: `localDamage()` (`player_damage`, non-positional) when the local player is the
victim and `hitAt(position)` (`enemy_hit` at the hit point, handling profile) for anyone else.
With tracers and projectiles (same day) came `impactAt(position)` (`bullet_impact` at a world hit,
environment-audio's `minor` numbers) and `explosionAt(position)` (`explosion`, environment-audio's
`largeExplosion` numbers so a blast carries across open terrain). Melee and the feedback layer added
`impactAt(eventId, position)` — the id comes from `ballistic-audio.js`'s `pickImpactVoice`, so a
ricochet replaces the impact instead of stacking — and `whizzAt(position, voice)`, where `voice` is
that round's `createWhizzVoice(pass)`. `emit()` therefore takes an optional voice override: there is
no single whizz sample, since the synth encodes the miss distance and the time of flight.

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

## Ballistic audio (`ballistic-audio.js`)

Incoming-round audio: the whizz of a bullet passing you, and a ricochet that replaces the
ordinary impact when a round glances off something hard. Pure math + WebAudio — no THREE, no DOM.
Node-tested in `test-ballistic-audio.mjs`. Wired into `environment-viewer-v2.html` and
`bot-viewer-v2.html`; `environment-viewer.html` (the older viewer, no gating layer) is untouched.

### Geometry

`closestApproach(origin, dir, travelled, listenerPos) -> { t, point, distance }` is a superset of
`bot-alert.js`'s `shotMissDistance`: identical clamped dot-product projection onto the shot
segment, plus the segment parameter `t` (which drives the arrival delay) and the closest point
(which is where the voice is panned). The test cross-checks the two over 2000 randomized shots so
they cannot drift. Both `[x,y,z]` and `{x,y,z}` vectors are accepted, since `combat.js` speaks
arrays and the viewers speak `THREE.Vector3`.

### Whizz gating

```
evaluateWhizz({ origin, dir, travelled, listenerPos, shooterId, listenerId, weapon, maxDist })
  -> null | { point, distance, delaySeconds, t, maxDist }
```

- Gate 1: `shooterId === listenerId` — your own round never whizzes past you. Skipped when either
  id is null (the bot harness has no bot-bound listener unless the camera is following one).
- Gate 2: perpendicular miss distance `> maxDist` (`WHIZZ_MAX_DIST` 6 m).
- `travelled` is how far the round actually got (`hit.distance`, or the weapon range on a clean
  miss), so a round that stopped in a wall never whizzes past someone standing behind it.
- `delaySeconds = t / bulletSpeedFor(weapon)`, clamped to `WHIZZ_MAX_DELAY_S` 0.6 s.
  **`bulletSpeedFor` reads `weapon.tracerFx.speed` — that is a VISUAL tracer speed (m1911 350,
  cz_805_bren 820, m24 850, default 750) used here as a muzzle-velocity proxy.** It is the only
  per-weapon speed that exists in the codebase; real ballistics (drag, transonic delay) are not
  modelled, and the number should not be read as one.

### Ricochet gating

```
surfaceClass(hit)              -> 'flesh'|'terrain'|'world'|'rock'|'wood'|'obstacle'|null
grazingFactor(dir, normal)     -> clamp(1 - |dot(dir, normal)|, 0, 1)
ricochetChance(hit, dir)       -> RICOCHET_BASE[class] * grazingFactor ** 3
evaluateRicochet({ hit, dir, rng })  -> boolean          (rng is injectable for tests)
pickImpactVoice(hit, dir, rng) -> 'bullet_ricochet' | 'bullet_impact' | 'enemy_hit' | null
```

- **Flesh never ricochets.** For `player`/`creature`/`mob`, `combat.js` synthesizes the "normal"
  from the capsule's outward XZ vector — it is not a real surface, so a grazing angle against it
  means nothing. Chance is hard-zero, not merely small.
- The cubed grazing curve is what makes a near-perpendicular hit essentially never ricochet
  (10 degrees off perpendicular on the hardest surface is under 0.1 %).
- `RICOCHET_BASE`: world 0.55, rock 0.50, obstacle 0.22, wood 0.08, terrain 0.05.
- **Surface hardness is inferred, not tagged.** There is no material tag anywhere in this
  codebase. The only signals are `hit.kind` and the obstacle id prefix that
  `obstacleColumnsAlongRay` stamps in `environment-viewer-v2.html` — `t:` for tall trunk columns
  (scored wood), `r:` for the short dressing index (scored rock). Caveat: that dressing index
  also holds stumps and logs, so some wood is scored as rock; nothing in the data distinguishes
  them. Terrain hits additionally always carry a straight-up normal, because `resolveWorldShot`
  passes `heightAt` but no `normalAt`, so the terrain graze angle is only approximate — its low
  base chance keeps that from mattering much.
- A ricochet **replaces** the impact voice; it is never a second voice on top of it. It also draws
  from the impact's rate-limit window (`SFX_BUDGET_ALIAS` in both viewers), so the impact class
  keeps the budget it always had instead of quietly getting two windows.

### Projectiles

Rockets and grenades are real stepped bodies on curved, bouncing paths, so the straight-ray
closest-approach math above is simply wrong for them. `createProjectileWhizzTracker({ radius })`
(default `PROJECTILE_WHIZZ_RADIUS` 7 m) instead samples each live projectile per tick and fires
**once**, on the tick it starts receding inside the radius, reporting the closest distance seen.
`retain(liveKeys)` prunes state for projectiles that no longer exist.

### Voices

Same builder contract as `weapon-sfx-synth.js`: `build(ctx, destination, t0) => durationSeconds`,
connects only to `destination`, schedules only via AudioParam automation, never `setTimeout`.
Envelope/noise/filter plumbing is imported from `synth-utils.js`.

- `bullet_whizz` — band-passed noise with a Doppler downsweep. A closer pass is louder, brighter
  (bandpass centre 900 Hz to 4.1 kHz across the 6 m range), shorter, and has a sharper attack;
  passes inside ~45 % of the range add a supersonic snap layer. Duration is 0.12–0.19 s **plus**
  the arrival delay, which is scheduled inside the voice.
  `playSynthAt` only ever passes three arguments, so per-shot parameters arrive via
  `createWhizzVoice({ distance, delaySeconds, maxDist })`, a factory returning a conforming 3-arg
  builder. `buildBulletWhizz` is the parameter-free registry default.
- `bullet_ricochet` — 0.42 s: strike tick, two detuned falling whines, band-passed air tail.
- `synthVoice(eventId)` / `SYNTH_EVENT_IDS` mirror the `weapon-sfx-synth.js` registry shape. Both
  viewers import it aliased as `ballisticSynthVoice` and chain it after `synthVoice`, so a
  ballistic id always resolves to *some* voice even with no per-call override.

### Wiring

Both viewers keep their own `playAtCulled`, which now takes an optional trailing `synthBuild`
builder. The two signatures genuinely differ and were left that way:

| | `bot-viewer-v2.html` | `environment-viewer-v2.html` |
|---|---|---|
| signature | `(eventId, position, profile, maxPerWindow, maxDist, synthBuild)` | `(eventId, position, kind, maxPerWindow, synthBuild)` |
| listener | `camera.position` (orbit or bot POV) | `playerCollider.end` |
| `listenerId` | `cameraFollowActor?.entity?.id ?? null` | `localPlayerId()` |
| whizz panner | `BOT_SFX_WHIZZ` (local const) | `kind: 'whizz'` in `ARENA_SFX`/`OUTDOOR_SFX` |

- `bot-viewer-v2.html`: `playBallisticWhizz` (~190) is called from `fireBotShot` right after
  `recordNearMisses` (~8932); the impact play at ~8939 now selects via `pickImpactVoice`. The
  projectile pass runs inside `updateProjectiles` (~9148).
- `environment-viewer-v2.html`: `playBallisticWhizz` (~1415) is called from `applyCombatIntent`
  right after `recordBotNearMisses` (~12913), hitscan only — a knife arc is not a round in
  flight. `spawnShotEffects` gained a trailing `shotDir` parameter and selects its impact voice
  via `pickImpactVoice` (~12650). `stepProjectileWhizz` (~1428) runs from `lgUpdateLights`
  immediately after `entityRegistry.tick` (~13268).
- Whizz budget is 6 per 100 ms window in both files; the panner profile is deliberately tight
  (refDistance 2 m, maxDistance 24 m, rolloff 1.6) so a distant miss cannot read as a round past
  your ear. Cull radius is 24 m in both the arena and outdoor tables — the whizz radius is
  body-scale, so map size is irrelevant.
- Both ids are registered in `sound-events.js` with no sample assigned, so they run on the synth
  path today. If a sample is ever assigned, `hasSfxEvent` wins and the whizz loses its per-shot
  distance/delay shaping — that is the documented trade, not a bug.

### Multiplayer gap (not shipped)

Combat resolves **host-side only** (`applyCombatIntent`), so `playBallisticWhizz` only ever runs
on the host/solo machine and is only ever judged against the *host's* listener. **A guest hears no
whizz at all**, and no guest ricochets either: the guest impact path sounds off replicated
`hit_spark` upserts, whose wire carries `surface` and `normal` but not the shot direction, so the
grazing angle a ricochet needs cannot be reconstructed there. Closing either gap needs the shot
ray (or a resolved per-listener whizz event) on the wire — deliberately not invented here, since
adding a wire message is a multiplayer-protocol change, not an audio one.

## Bot damage / death audio (`bot-damage-audio.js`)

Bots are **robots**. The sampled `enemy_hit` is `body-impact.wav` (flesh) and `pain-grunt.wav` is
human breath, so neither is right for one. This module supplies synthesized mechanical equivalents
plus the policy layer that decides which voice plays, how often, and how many at once. It is
viewer-agnostic: every world query is an injected accessor keyed by bot id, so the same controller
serves `bot-viewer-v2.html` (actor registry) and `environment-viewer-v2.html` (`botPlayers` recs).

**`enemy_hit` is suppressed for bots** so the flesh sample and the struck-metal tier never stack on
one hit: `applyCombatDamage` skips it when `target.botActor` is set, and `applyHitDamage` skips it
when `botPlayers.has(hit.id)`. Creatures, mobs and the human host are flesh and keep it.

The five `bot_hit_*` ids share ONE burst window via each viewer's `SFX_BUDGET_ALIAS` (they alias to
`bot_hit_light`). Per-id windows would have let the "bot was struck" class burst five times its
intended rate, since `sfxBudgetOk` is keyed by event id.

### Hit tiers — `botHitTier(amount, hpBefore01, hpAfter01, cause, cfg)`

Pure and table-tested, so the thresholds are checkable without an `AudioContext`. Order of rules:

| Result | Rule | Sound |
|---|---|---|
| `bot_hit_blast` | `cause` is `blast`/`explosion` | Muffled concussive thud, deliberately dark so it layers **under** the `explosion` voice instead of competing with it |
| `bot_hit_ricochet` | `cause === 'ricochet'`, or `amount01 <= 0.10` | Bright ping, everything highpassed — no low end at all |
| `bot_hit_critical` | `amount01 >= 0.50`, or `hpAfter01 <= threshold01 * 0.5` | Heavy clang + a damaged-electronics stutter (rapid gating of a descending square) |
| `bot_hit_heavy` | `hpAfter01 <= threshold01` | Deep clang + struck-metal ring (inharmonic partials through a soft clip) |
| `bot_hit_light` | otherwise | Short metallic tink |

`threshold01` is **the game's own number**, read live from each viewer's `botHealthSettings.threshold01`
— the HP fraction at which a bot breaks off to heal (0.60 in `bot-viewer-v2.html`, 0.35 in
`environment-viewer-v2.html`). Move that slider and the light/heavy boundary moves with it. The
critical band is derived from it (`* criticalHpScale`), not invented separately.

`amount01` is `amount / maxHp` (100), so the real per-weapon numbers in `weapons.js` land where you
would expect: five_seven 20 and cz_805_bren 24 are light off a full bar, m1911 33 is light, knife 50
and m24 95 are critical, grenade/rpg route to blast by cause. When `amount` is not a finite positive
number the function falls back to `hpBefore01 - hpAfter01`.

**There is no hit-location or armour data anywhere in this codebase.** Tiers derive from damage
amount and the resulting HP fraction only; nothing here should be read as a hit-zone system.

### Damage-state tell

Default is **intermittent one-shots** (`bot_damage_spark`), not a loop per wounded bot: at 90 bots
15-30 are wounded simultaneously, and that many live node graphs is both a real cost and guaranteed
mix-mud. Cadence is a seeded per-bot value (`botAudioSeed(id)` fed to `seededUnit`) interpolated from
`sparkSlowMs` 3600 at the heal threshold to `sparkFastMs` 900 at 0 HP, plus or minus 35%, so the tell
speeds up as a bot bleeds out and no two bots tick in lockstep.

The sustained `bot_damage_loop` (arcing short over a failing servo) is reserved for the
`maxDamageLoops` (2) **closest** bots below `threshold01 * 0.5`, taken under the shared loop budget
at `AUDIO_PRIORITY.damageLoop`. Everything is re-decided on a `scanIntervalMs` (250 ms) poll, not
per frame.

### Death, the siren, and its three endings

The state model, verified in code, is: **there is no downed-but-standing state.** A bot goes
alive to dead instantly (`killCombatBot` in the harness, the `!combat.alive` edge in the v2 viewer),
then exists as a *time-boxed revivable corpse* stamped with `diedAt`. So death audio is two things:

1. `bot_death_sting` at the killing blow. It is **not** rate-limited: it bypasses the 100 ms
   `sfxBudgetOk` window (`maxPerWindow: Infinity`) and is gated on *concurrent* death voices
   instead, via `budget.reserveOrPreempt('damage', AUDIO_PRIORITY.death)`. A kill is rare and
   high-value; rate-limiting it like a common impact would drop exactly the information the player
   most needs. The fatal hit's own tier one-shot is skipped so the sting is not doubled up.
2. `bot_death_siren` — a sustained distress **beacon** for as long as the corpse is revivable.
   A downed bot is a machine reporting a fault, not an animal in pain: square-wave beeps in
   high-low pairs with real silence between them, the pitch stepping down in four discrete
   power-down stages and the rest between chirps stretching (0.45 s to 1.3 s) as the level falls.
   The whole pattern is scheduled up front as AudioParam automation: the revive window is a known
   maximum life, so no per-frame timer is needed.

   **The first version was rejected and why matters.** It was two detuned sawtooths a fifth apart,
   cross-faded continuously while gliding downward — which is literally air-raid siren synthesis,
   and it read as horror rather than hardware. A continuous glide plus detune beating is what makes
   a sound *wail*. Discrete beeps, no portamento, and full gate closure between them are what make
   it read as a machine. `test-bot-damage-audio.mjs` asserts those three properties directly (no
   pitch ramps, more than two distinct stepped pitches, the gate fully closing), so the wail cannot
   come back by accident. Tunables live in `SOUND_PARAMS.siren`.

Three endings, distinguishable with your back turned:

| Ending | Trigger | Sound |
|---|---|---|
| Revived | `onBotRevived` (harness) / the `reviveCombatBot` call site (v2 viewer) | `stop(0.18)` fast fade + `bot_revived`, a rising three-note chime |
| Bled out | `now - diedAt >= MEDIC_DEFAULTS.reviveWindowMs` | `stop(0.35)` + `bot_death_powerdown`: one low tone dropping an octave into a dull thump |
| Culled / reset / respawned | corpse gone, roster cleared, or the bot is alive again without an explicit revive | `stop(0)` — hard cut, no flourish. A teardown is not a narrative beat. |

**The siren stops at the revive-window boundary, not when the corpse disappears.** These are
different moments: `cullDeadBots` in `bot-viewer-v2.html` explicitly *spares* corpses still inside
`MEDIC_DEFAULTS.reviveWindowMs` (12 s), so a corpse always outlives its own siren. In
`environment-viewer-v2.html` the opposite skew exists — `BOT_RESPAWN_MS` is 4 s, shorter than the
12 s window — so an auto-respawn usually ends the siren first; that path is a hard cut, because a
respawn is not a revive.

Mass death is the failure mode most likely to sound terrible, so: concurrent sirens are capped at
`maxSirens` 3, well below `LOOP_VOICE_CAP` 8; a death denied a siren slot still gets its sting, so
no kill is ever silent; and every live siren is ducked to `sirenBaseVolume / sqrt(activeCount)` via
the handle's `setTargetVolume`, so five deaths are not five times the loudness of one.

### Wiring

Both viewers subscribe to their existing damage/death hooks rather than adding inline calls:

- `bot-viewer-v2.html` — `onBotDamaged` / `onBotDied` / `onBotRevived`, right after the emitters.
  `playAtCulled` gained `|| botDamageVoice(eventId)` at the end of its fallback chain (a loaded
  sample still wins), and a `playLoopCulled()` sibling wraps `envAudio.playSynthLoop`.
  `removeAllBots()` calls `botDamageAudio.stopAll()`; `animate()` calls `update(now)` inside the
  profiler's `audio` block.
- `environment-viewer-v2.html` — `onBotDamaged` / `onBotDied`. It has no revive hook, so
  `reviveCombatBot` reports directly (one call). Same `playAtCulled` chain extension and
  `playLoopCulled` sibling; `update(now)` runs next to `envAudio.update(now)`.

Sirens carry further than the clang that caused them: a new `distress` panner class sits alongside
`impact`/`gunshot` (harness `BOT_SFX.distress` refDistance 14 / maxDistance 120; the v2 viewer adds
arena 14/120 and outdoor 26/200, culled at 110 m / 220 m).

`environment-viewer.html` is deliberately **out of scope**: its `player-combat.js` layer has no
revivable-corpse state to hang a distress siren on.

### Known gaps

- **Sustained event ids have no sample-backed path.** `envAudio.playAt` is one-shot only, so
  `bot_damage_loop` and `bot_death_siren` are **synth-only**: assigning a wav to those ids in
  `sfx-browser.html` will do nothing. The one-shot ids (`bot_hit_*`, `bot_damage_spark`,
  `bot_death_sting`, `bot_death_powerdown`, `bot_revived`) all take a sample normally.
- **No multiplayer replication.** Damage/death audio is host/solo only. Both hooks fire inside the
  host-side damage path, and guests receive no death or revive signal on the wire (`sim_state`
  carries `hit_spark` effects, from which `mpSeenImpactFx` sounds impacts — there is no equivalent
  death effect). Replicating it would need a new host-owned effect kind; when that lands, the
  dedup key must be **bot id + `diedAt`**, not bot id alone, because bots are revivable and an
  id-only key would permanently suppress every death after the first.
- The `bot_damage_loop` flicker automation is scheduled over a bounded `maxSeconds` (14 s). Past
  that the bed holds its last level rather than going silent — audible only for a bot that stays
  in the badly-hurt band, inside a panner's audible radius, for longer than that.

## Bot voices and squad chatter (`bot-voice.js` + `bot-voice-director.js`)

Bots speak robotic callouts driven by their real FSM state. Two modules, split along the line that
matters for testing: `bot-voice.js` is pure WebAudio (what a line sounds like), `bot-voice-director.js`
is pure logic (whether a line is allowed to happen at all). Neither imports THREE or touches the DOM.
Both are Node-tested in `test-bot-voice.mjs`.

Wired into `bot-viewer-v2.html` and `environment-viewer-v2.html`. `environment-viewer.html` is
deliberately **out of scope**: it runs the older 7-state `chooseBotState` with no cover, medic,
squad, grenade or sidearm state, so most of the vocabulary has no signal there.

### Synthesis (`bot-voice.js`)

A buzzy glottal carrier (sawtooth + square at a per-bot fundamental, 90-160 Hz) drives three
parallel bandpass resonators at F1/F2/F3 (Q 5/6/7), summed and gated by a per-syllable envelope.
Formant targets glide between syllable frames. That is a talkbox/vocoder topology, so the result
reads as a machine speaking rather than as a beep. Vowel formants are the Peterson & Barney
adult-male steady-state table, exported as `VOWEL_FORMANTS` and used unmodified.

**Gain staging is the reason the callouts were once inaudible, and it is all measured, not guessed.**
A three-band bank passes only what fits in its bands, so Q buys vowel character at the cost of
level: Q=[9,11,12] threw away 15.8 dB, Q=[5,6,7] costs 12.4 dB and still reads as formants.
`voice.makeup` (2.5) restores the rest — but makeup alone drags the transient peaks to 0 dBFS
against an RMS near -30, a ~30 dB crest factor, so the loudest lines clipped on their own before
any mixing. `voice.outputDrive` (1.6) is a tanh soft clip **after** the makeup gain: measured in
`sound-studio.html` it adds 3.4-4.6 dB of RMS across the lexicon with no increase in peak. Against
a 4 shots/second bed of the real `rifle_shoot` sample at 40 m, the speech-band margin runs
-26.4 dB at makeup 1 with no limiter, -18.8 dB at makeup 2.5, and -13.9 dB as shipped. Raising
`outputDrive` to 3.0 buys another ~3 dB at the cost of more grit.

Builders follow the `weapon-sfx-synth.js` contract exactly: `build(ctx, destination, t0) =>
durationSeconds`, connect only to `destination`, schedule via AudioParam automation from `t0`,
never `setTimeout`. Envelope/noise/filter/saturator plumbing comes from `synth-utils.js`.

**Radio treatment is a flag, not a default.** `buildVoiceLine(lineId, identity, { radio })` adds a
300-3000 Hz comms band, a `saturator()` drive stage, a tighter 1450 Hz resonance, squelch clicks at
key-down and key-up, and a short hiss tail. `radio: false` is the clean voice (a QA aid, exposed as
a viewer toggle) and allocates no noise buffer at all.

**Rhythm is the recognition channel.** Each line has a deliberately distinct syllable count,
duration profile and total length, so a player learns the vocabulary by ear from half-heard
fragments. `rhythmSignature(lineId)` normalises a line to `{count, totalMs, onsets[], durs[]}` and
`rhythmDistance(a, b)` scores two lines 0..1; the test asserts **every** pair clears
`MIN_RHYTHM_DISTANCE` (0.12). The closest pair today is `contact` / `no_ammo` at 0.135. Retune a
line's timing and that test is what tells you it now sounds like another one.

`grenade_warn` is the extreme case and has its own assertions: shortest phrase in the lexicon
(300 ms), front-loaded in both duration and level. `reloading` is the counterexample -- long and
metrically even.

**Per-bot identity.** `voiceIdentity(botId, teamId)` is deterministic via `seededUnit`: fundamental,
formant scale, speaking rate and saw/square buzz mix. `voiceSeedFromId` matches `bot-activity.js`'s
`botSeedFromId` convention (`'bot-7'` to 7) so a bot's voice and its behavioural jitter share one
number. A coarser per-team offset sits on top of that (pitch +/-7%, vocal-tract scale +/-4.5%) so
the two sides are distinguishable by ear.

### Arbitration (`bot-voice-director.js`)

With 90 bots the interesting problem is refusal, not synthesis. `createVoiceDirector(options)`
runs seven gates in order and **drops rather than queues** -- a callout reacts to the current
moment, and a line that plays 2 s late no longer matches what the bot is doing:

1. chattiness (0 silences everything; ambient flavour lines need at least 0.35)
2. distance cull (`maxDistance`, before any node graph is built)
3. event-key dedup (`dedupMs` 2500)
4. per-bot cooldown (`botCooldownMs` 4000)
5. per-line-type cooldown, **scoped per team** -- one side's "taking cover" must never silence the other's
6. squad rate bucket, then global rate bucket
7. the shared `combat-audio-budget.js` reservation (`reserveOrPreempt('voice', ...)`)

The budget is what makes the concurrency ceiling (`speakerCap`, default 3) shared with the damage
track instead of self-policed — both viewers create one `createAudioBudget()` and pass it to both
`createVoiceDirector` and `createBotDamageAudio`. (The ballistic one-shots do **not** reserve from
it; they are rate-limited by `sfxBudgetOk` alone, and `AUDIO_PRIORITY.ballistic*` is reserved for a
future wiring.) It is what lets a `grenade_warn` (mapped to
`AUDIO_PRIORITY.voiceAlert`) displace an ambient bark (`voiceBark`) at the cap. Preemption frees the
**slot** immediately; the evicted line's already-scheduled one-shot finishes on its own, because a
WebAudio one-shot cannot be recalled. Lines are at most ~1.2 s, so the overlap is brief.

`requestBest(candidates)` is how several witnesses to one event collapse to one speaker: candidates
are sorted by listener distance and tried in order, so the nearest bot speaks and the dedup key
silences the rest. That is what "man down" uses.

`update(now)` retires finished speakers and hands their tokens back; it also sweeps the cooldown
maps every 5 s, so a viewer never has to remember to call `prune`.

### Callout to trigger map

Every line rides an FSM edge the brain already publishes. Squad communication **rides** the existing
propagation rather than duplicating it: the bot that publishes a report is the one that speaks, and
receivers react but stay silent.

| Line | Trigger | `bot-viewer-v2.html` | `environment-viewer-v2.html` |
|---|---|---|---|
| `contact` | rising edge of raw target acquisition, at the `recordContact` reporter site | `sayBotContact` after `recordContact` | same |
| `firing` | entering `BOT_FIRE` (state edge, **never** per shot) | `updateBotVoiceState`, before the `botState` stamp | same |
| `cover` | entering `BOT_COVER_MOVE` | same | same |
| `moving` | entering `BOT_PURSUE` | same | same |
| `overwatch` | rising edge of `holdReason === 'overwatch'` (S11 base-of-fire lease) | same | same |
| `reviving` | rising edge of `medicTendTargetId` while in `MEDIC_TEND` | same | same |
| `no_ammo` | rising edge of `botOutOfAllAmmo()` (both guns dry) | same | same |
| `reloading` | `reloadBotWeapon` actually starting a reload | in `reloadBotWeapon` | in `updateBotReload` (both start paths) |
| `sidearm` | `swapBotWeaponSlot('sidearm')` returning true | in `swapBotWeaponSlot` | same |
| `grenade_out` | `releaseGrenade` | in `releaseGrenade` | same |
| `grenade_warn` | `grenadeEvade` returning a threat, deduped on the grenade's projectile id | in `updateGrenadeEvade` | same |
| `man_down` | `onBotDied`, then the nearest living same-team bot within `CONTACT_SHARE_RADIUS` | death-hook subscriber | same |
| `enemy_down` | `onBotDied`, when the killer is a bot on another team | death-hook subscriber | same |
| `death` | `onBotDied`, the victim itself -- fires alongside `man_down`/`enemy_down`, not instead of them | death-hook subscriber | same |
| `hit` | non-fatal `onBotDamaged`, victim itself, `cause !== 'blast'` | damage-hook subscriber | same |
| `grenade_hit` | non-fatal `onBotDamaged`, victim itself, `cause === 'blast'` | damage-hook subscriber | same |
| `ally_hit` | non-fatal `onBotDamaged`, nearest living same-team bot within `CONTACT_SHARE_RADIUS` (mirrors `man_down`'s witness scan, keyed off a wound instead of a death) | damage-hook subscriber | same |
| `near_miss` | a fresh (non-refresh) near-miss report for that bot, at the same site the near-miss ring itself is written | `_nmVisit` | same |
| `spawn` | a bot entity finishing setup | end of the per-bot spawn loop in `spawnBots` | end of `spawnBotAt` |
| `order_ack` | player right-clicks "Move here" on a bot that is either independent or a squad member who isn't the leader | `issueCommand` -> `announceOrder` | *(no command menu yet -- see below)* |
| `order_ack_squad` | same click, but the commanded bot IS a squad leader with at least one other living squadmate | same | *(no command menu yet)* |
| `order_follow` | ~350-650 ms after `order_ack_squad`, the nearest living squadmate (excluding the leader) replies | same, via a `setTimeout` in `announceOrder` | *(no command menu yet)* |

Casualty and death lines subscribe to `onBotDamaged` / `onBotDied` / `onBotRevived` rather than
editing the damage functions, for the same reason `bot-damage-audio.js` does.

**The three order-acknowledgment lines added 2026-08-07** (`order_ack`, `order_ack_squad`,
`order_follow`) are the only lines in the lexicon triggered by a direct player action (the right-click
"Move here" command in `bot-viewer-v2.html`'s command menu) rather than by the bots' own FSM or combat
events. `environment-viewer-v2.html` has no equivalent command menu yet, so these three are
`bot-viewer-v2.html`-only for now. `announceOrder(actor)` decides which line plays: if the commanded
bot is a squad leader with squadmates still alive, it speaks `order_ack_squad` ("we're moving out"
style, plural-framed) and one squadmate echoes back `order_follow` ("roger"/"yes ma'am"/"hooah") after
a randomized 350-650 ms wall-clock delay -- a real `setTimeout`, not scheduled through the sim clock,
because WebAudio's one-shot builders have no "start later" hook on this codepath and the delay is
purely a call-and-response beat, not simulation state. Both the leader lookup at fire time and the
squadmate roster re-check inside the delayed callback guard against a scene reset or squad wipe mid-
delay. Any other commanded bot (independent, or a non-leader squad member -- commanding a follower
just pulls it out of formation, it doesn't speak for the squad) speaks the solo `order_ack` line. Only
`move` orders are voiced; `hold` orders have no acknowledgment vocabulary yet. None of the three are
in `VOICE_INTENSITY_FRESH_LINES`, unlike the six reaction lines -- a player's click doesn't change the
bot's combat situation, so the sentry tick's cached `alertTierLast` is exactly as fresh as a
recomputation would be, and it is what makes a bot commanded mid-firefight bark a shouted "GOT IT!"
instead of the same calm "affirmative" it would use on a quiet patrol. Wording variety (the fuller
"moving out" / "oscar mike" / "on the move" / "on my way" / "going" / "right" / "got it" / "affirmative"
pool for `order_ack`, its pluralized counterparts for `order_ack_squad`, and the three replies for
`order_follow`) lives only in the per-voice ElevenLabs `voiceLexicon`, baked via `bake-order-lines.mjs`
-- same single-pass pattern as `bake-reaction-lines.mjs`. The synth (robot) voice always speaks each
line's one canonical phrase from `VOICE_LINES` regardless of bake status, so the feature is audible
immediately; baking only adds the human-voice wording variety. Baked for all 10 ElevenLabs voices
2026-08-07 (170 lines, 0 failed; manifest grew to 26 sets / 1588 takes).

**The six reaction lines added 2026-08-05** (`spawn`, `hit`, `grenade_hit`, `near_miss`, `ally_hit`,
`death`) all fire from event handlers rather than from inside the per-bot sentry tick, so all six
are in `VOICE_INTENSITY_FRESH_LINES` alongside the original six (`contact`, `man_down`,
`enemy_down`, `grenade_out`, `sidearm`, `reloading`) -- none of them can read the sentry-cadence
lines' cached `alertTierLast`, for the same staleness reason documented in the intensity plan.
Intensity reuses the existing alert-tier signal for all six; a separate HP-fraction-driven
intensity path was considered and deliberately not built, since alert tier already reads as a
reasonable proxy for "how bad is this moment" and adding a second driver would mean new plumbing
for a distinction the existing signal already mostly captures.

`death`'s lines are written as pure vocalizations (`AAAGH`, `NOOO`, wordless gasps), not phrases --
a death cry is a reflex, not communication, so it deliberately carries no tactical wording the way
every other line does. `hit`/`grenade_hit` mix wordless pain reactions with tactical follow-through
in their intensity-variant pool rather than always narrating the wound out loud (e.g. `hit`'s mid
band round-robins between `gah--`, `unh, took one--`, and `I'm hit`). Baked for all 10 ElevenLabs
voices via `bake-reaction-lines.mjs` (420 lines, 0 failed, 2026-08-05) -- same single-pass
write-lexicon-then-bake pattern as `bake-intensity-variants.mjs`, kept as a separate script since
these six lineIds started with zero existing customization (no dedup skips possible) rather than
extending an already-populated lexicon.

**Reflex lines bypass radio treatment, flat/net playback, and the chattiness dial entirely**
(`REFLEX_LINES` in `bot-voice.js`: `hit`, `grenade_hit`, `near_miss`, `death` -- not `ally_hit` or
`spawn`, which are deliberate radio chatter, not a body making a sound). A soldier doesn't key a
radio to scream, so these four always play clean and positional in the local area around the bot,
regardless of the radio toggle or whether the bot is on the listener's net (`environment-viewer-v2.html`
only -- `bot-viewer-v2.html` has no net/flat concept, so it only needed the radio-treatment bypass).
They are also exempt from the director's chattiness gate in `bot-voice-director.js`: chattiness
models radio discipline (how much a squad chooses to talk), and a reflex is not a discipline choice.
Three separate chattiness effects all needed the exemption, not just the obvious one -- the hard
`chattiness <= 0` mute, the squad/global rate buckets (which independently scale their max to zero
at chattiness 0), and `cooldownScale()` (which stretches a line's cooldown well past its raw
`LINE_COOLDOWN_MS` at low-but-nonzero chattiness). Cooldown, dedup and the shared speaker-cap budget
still apply to reflex lines -- only the chattiness-specific gating is bypassed, so a mass-casualty
moment still can't blow the speaker budget wide open.

**Two lines were deliberately not built.** "Flanking" has no signal -- nothing in the FSM
distinguishes a flanking approach from any other `BOT_PURSUE` / `BOT_SEEK` path. Squad-leader orders
have no signal either: `bot-squad.js` elects a leader and assigns formation ranks, but no bot ever
issues an order another bot receives, so there is nothing to voice. Both would have to be invented
rather than observed.

### Positional vs flat

In `bot-viewer-v2.html` the camera is a free/POV debug cam with no player fiction, so **every** line
is positional. In `environment-viewer-v2.html` the mechanism for flat (earpiece) playback exists:
`botVoiceNetTeam()` names the bot team that shares the player's radio net, and a line from that team
plays non-positional at zero distance. It currently returns `null`, because `HUMAN_TEAM` is a third
party hostile to *every* bot team (see `BOT_TEAM_DEFS`), so no bot is on the player's net and every
line is positional today. That one function is the seam to flip when a player-allied bot team lands.

### Controls

Both viewers expose the same seven controls next to the existing bot-audio toggles (built inline in
the viewers, not in `environment-ui.js`): chatter on/off, radio/clean voice, chatter volume,
chattiness, **voice source**, **vocode baked speech**, and **death beacon**. Chattiness is the
density control -- it scales the director's rate limits and shortens its cooldowns, and below 0.35
it drops the ambient flavour lines (`firing`, `moving`, `overwatch`, `reloading`, `spawn`) so only
information survives. `bot-viewer-v2.html` round-trips all of them through its UI save/load slots.

**Reflex range / reflex volume** (added 2026-08-05) are two more sliders next to chattiness, unique
to the four `REFLEX_LINES`. The general chatter-volume slider and `BOT_SFX_VOICE`/`botVoiceProfile()`
panner profile (ref ~14 m, max ~95-110 m, same falloff as ordinary radio callouts) made reflex lines
audible across most of the map -- a pain grunt should read as something you only catch standing right
next to the bot. Both viewers now carry a separate `REFLEX_SFX_VOICE` panner object (default
refDistance 2.5 m, maxDistance 12 m, rolloffFactor 2.5, distinct from `SOUND_PARAMS.ranges` so the
sliders can retune it live in-session without a reload) and a separate `botReflexVolume` (default
0.6). `playBotVoice` picks `REFLEX_SFX_VOICE`/`botReflexVolume` over the normal profile/volume when
`REFLEX_LINES.has(lineId)`. `sayBotLine`/`sayBestBotLine` also pre-filter reflex requests against
`botReflexRange` *before* calling the director, rather than relying on `envAudio`'s own
distance-cull inside `playSynthAt`/`playAt` -- the director stamps a line's cooldown/dedup the
moment it grants a request, and `release()` on a silent/culled playback does not undo that stamp, so
letting an inaudible far-away reflex request through the director would have quietly burned that
line's cooldown for a hit nobody heard. `bot-viewer-v2.html` round-trips `reflexRange`/`reflexVolume`
through its UI save/load slots; `environment-viewer-v2.html` has no chatter-settings persistence at
all (chatter volume/chattiness aren't saved there either), so reflex range/volume follow that same
session-only behavior.

**Voice source** picks where the words come from: `robot` is the synthesized formant voice, and every
other option is a TTS engine baked into `sfx/voice` (see `createVoiceBank` below). **Vocode baked
speech** runs a baked human take through the robot vocoder -- real speech timing, machine timbre --
and is disabled for the synth source, which is already a machine. **Death beacon** gates the downed
bot distress beeping from `bot-damage-audio.js` and now defaults to **off**: it is the only sustained
periodic tone in the mix, and with several bodies down at once it masks everything else. The gate is
`createBotDamageAudio({ sirenEnabled })`, kept separate from `enabled` so the rest of the damage
track survives turning it off; toggling it off mid-match fades live sirens rather than waiting out
the revive window.

### Known gaps

- **No multiplayer replication.** Bot simulation is host/solo only, so a guest has no FSM to derive
  callouts from -- replicated pose and HP cannot tell you that a bot entered `BOT_COVER_MOVE` or
  started a reload. Replicating chatter would need a host-owned "bot said line X" event on the wire;
  its dedup key would have to be **bot id + line id + timestamp**, since one bot legitimately repeats
  a line many times across a match.
- **Preemption does not silence audio already scheduled.** It frees the slot, not the sound.
- **Voice type is a global toggle, not a bot property.** "Robot or human" is chosen once for the
  whole match. It should belong to the bot or its team, so a machine chassis and a human-looking one
  can share a firefight. `botVoiceBank.setFor(botId)` is already per-bot, so the seam exists.

### Playing baked takes at runtime (`bot-voice-bank.js`)

`createVoiceBank({ decode, canDecode, manifestUrl, base })` is what lets a viewer swap the synth for
real speech without touching a single call site. It reads `sfx/voice/manifest.json`, assigns each bot
one of the chosen engine's speakers by seeded hash, and lazily fetches and decodes takes.

| Method | Purpose |
|---|---|
| `init()` | fetch the manifest once; resolves to the engine list |
| `engines()` / `setNames(engine)` | what was baked |
| `setEngine(name\|null)` | `null` = synth; switching re-rolls speakers and warms the new engine |
| `setFor(botId)` | this bot's speaker, stable for the life of the selection |
| `take(botId, lineId, variantIndex = 0)` | the decoded `AudioBuffer` for that variant, or `null` while it loads |
| `progress()` | `{loaded, total}` for the UI readout |

`variantIndex` names a specific baked file: `0` is the plain `${lineId}` file that has always
existed, `N > 0` is `${lineId}__vN`, baked when a voice has its own wording for that intensity band
(see "Line variants and situational intensity" below). If the requested variant is not in this
set's manifest entry -- a partial re-bake, or a set baked before variants existed -- `take()` falls
back to index 0 rather than requesting a file that was never going to exist.

Four constraints drove the design, and each one is a bug if you drop it:

- **It never blocks a callout.** A take that has not arrived returns `null` and the caller falls back
  to the synth for that one line, so a warming bank sounds like the old build rather than like
  silence.
- **It does not own an AudioContext.** An `AudioBuffer` belongs to the context that created it, so
  the caller injects `decode`, bound to the live context via `envAudio.decodeAudio()` (added to
  `environment-audio.js` for exactly this).
- **It waits for the decoder.** Decoding needs a context, which needs a user gesture. Without the
  `canDecode` gate, selecting a voice before enabling audio marks all 130 keys permanently failed and
  the engine never plays at all -- verified by mutation, not reasoning.
- **Prefetch is capped at 6 concurrent.** Kokoro sets are uncompressed WAV; an unthrottled warm asks
  the browser for ~30 MB at once.

A failed key (404, undecodable) is remembered and never retried, so a missing file costs one request
rather than one per callout.

Call sites read the take's real length for the director's `durationS` (`botVoiceDurationS()` in both
viewers). TTS lines run well past the synth estimate, and using the estimate frees the speaker slot
while the bot is still talking. A baked take also takes priority over `hasSfxEvent(bot_vo_*)`,
because the bank is a deliberate choice and `hasSfxEvent` only reports that some loaded folder
happened to contain a matching filename.

Covered by `test-bot-voice-bank.mjs` (fetch stubbed, so it asserts policy rather than the contents
of `sfx/voice`).

### Line variants and situational intensity (`bot-voice-intensity.js`)

Full design history in `docs/superpowers/plans/2026-08-03-bot-voice-intensity-plan.md`. Summary of
what shipped:

**Data shape.** `VOICE_LINES[id].variants` (mirrored by `SOUND_PARAMS.voiceLines[id].variants`) is
an optional array of `{ text, contour?, drive?, syllables?, intensity }`. The line's existing
top-level fields are variant 0, with an implicit `intensity: 0.5` -- a line with no authored
variants behaves exactly as before. A variant missing `syllables` gets them auto-seeded from `text`
via `seedSyllables()` (moved into `bot-voice.js` from `sound-studio.html` so both the studio and the
runtime resolver share one heuristic). `bot-voice.js#lineVariants(lineId)` resolves the full list;
an invalid candidate (`intensity` not a finite 0..1 number) is excluded from the pool rather than
treated as an error, and the base variant's always-valid default is what guarantees the pool is
never empty.

**Per-voice lexicon, ElevenLabs only.** `SOUND_PARAMS.voiceLexicon[voiceId][lineId].variants` (a
separate map section from `voiceLines`, not a reshape of it -- `voiceLines` still backs the
"add a line" feature and the `knownLine()` gate) lets a specific ElevenLabs voice (keyed by the
manifest `set` string, e.g. `eleven/harry`) carry its own wording per event. Kokoro and the synth
stay on the shared lexicon; scoped that way deliberately, see the plan doc's Appendix B.
`bot-voice.js#voiceLexiconVariants(voiceId, lineId)` resolves it, falling back to the shared
lexicon's text when a voice has nothing authored for that line, so a voice with partial content
still speaks every event.

**Selection.** `resolveVoiceIntensity({ lineId, alertTier })` (the new module) maps a bot's alert
tier to a 0..1 target via `SOUND_PARAMS.voiceIntensity`'s anchor table (evenly spaced by default,
explicitly provisional pending actually listening to baked variants), floored at the `defensive`
anchor for any line at the director's alert rank (`budgetPriorityFor(lineId) === voiceAlert`) so a
genuinely urgent line can never resolve to a calm-tagged variant. `bot-voice.js#peekVariantIndex`
picks the variant closest to that target, breaking ties (within `voiceIntensity.tieEpsilon`) with a
round-robin so wording still varies among equally-good matches. Peek is non-mutating on purpose --
the director's request/grant split needs a duration estimate before it decides whether a line even
gets to play, so `commitVariantIndex()` only advances the rotation after the line actually spoke; a
dropped request re-offers the same variant next time rather than silently skipping ahead.

**Where the target intensity comes from.** Both viewers already compute and cache `alertTierLast` on
a bot's actor once per sentry tick, before any voice line is decided. Lines driven from inside that
same tick (`firing`, `cover`, `moving`, `overwatch`, `reviving`, `no_ammo`) read the cached value for
free. Six lines fire from OUTSIDE that tick -- bullet/projectile/death handling that runs after the
tick already stamped the cached tier -- and reading it there would be blind to the very event that
triggered the line: `contact`, `man_down`, `enemy_down`, `grenade_out`, `sidearm`, `reloading`. Those
six call a fresh `alertEscalation()` and convert its score with the new `bot-alert.js#tierForScore()`
instead. `tierForScore` is a deliberate simplification of the real sentry-tick ladder, not a shared
implementation of it -- the real ladder also gates `push` on a living-teammate support count and
`wary` on a per-bot timestamp, neither reconstructible from a bare score and neither relevant to
"how urgent should this sound" (that's a behavior question, not a delivery one). Confirmed by direct
line-number verification during implementation, not from the original design's assumption: `contact`
(`sayBotContact`) turned out to fire BEFORE the tick's tier write despite being inside the same
function, and `grenade_warn` (`updateGrenadeEvade`) turned out to fire AFTER it -- the opposite of
what the initial classification assumed.

**Baking.** `bake-voices.mjs` bakes on `eleven_v3` (not v2 -- confirmed against ElevenLabs' own docs
that this is the correct model id, same `/v1/text-to-speech/{voice_id}` endpoint, before the change
was made), specifically so a variant's wording can carry an inline delivery tag (`[whispers]`,
`[shouts]`, ...). Its bake loop now iterates `voiceLexiconVariants(voiceId, lineId)` per ElevenLabs
voice (Kokoro iterates `lineVariants(lineId)`, the shared lexicon only), writing index 0 to the
existing `${lineId}.ext` filename and index N > 0 to `${lineId}__vN.ext`. Variant order is
append-only by convention: reordering or deleting a middle variant desyncs an already-baked file
from the text it no longer corresponds to. `writeManifest()`'s membership filter strips the `__vN`
suffix before checking `lineIds()`.

**Testing scope, stated honestly.** `test-bot-voice.mjs` and the new `test-bot-voice-intensity.mjs`
prove the pure functions (`tierForScore`, `resolveVoiceIntensity`, `peekVariantIndex`,
`lineVariants`, `voiceLexiconVariants`) are correct given their inputs. They cannot prove the
viewer's frame loop delivers the right inputs at the right time -- that the six event-triggered
lines actually call the fresh path at the right call sites is a code-review check against the line
numbers recorded in the plan doc, not something either suite exercises. Separately: pooling
`MIN_RHYTHM_DISTANCE` across every AUTO-SEEDED variant of every line does not hold, confirmed
directly -- `seedSyllables`'s timing depends only on vowel-group count (6 possible buckets), so two
different texts with the same count are rhythmically identical regardless of wording (`"GRENADE!"`
and `"engaging"` both seed to the same three-syllable timing). The guarantee holds for
hand-authored variants (their `syllables` are explicit, not auto-seeded); auto-seeding is a
convenience path for quick authoring, not a promise of rhythm diversity, and the studio's existing
nearest-neighbour warning is what flags a collision when one occurs -- it does not prevent one.

**Deferred, not built.** HP as a secondary intensity input (flagged in the plan doc's Chapter 1 as
an addition beyond what was asked).

### The line-authoring tool (`voice-line-studio.html` + `voice-bake-server.mjs`)

Built per the plan doc's Appendix A/B: a standalone tool separate from `sound-studio.html`'s
LEXICON tab (which had grown to six tabs and 1848 lines doing five different jobs -- DSP tuning,
line authoring, arbitration simulation, take auditioning, JSON export -- in one file). This tool
does exactly one of those jobs. Voice-first flow: pick an ElevenLabs voice (left pane, read from
`sfx/voice/manifest.json` -- **not** a live account listing, since that needs the API key and the
key must never reach the browser; a voice that has never been baked at least once cannot be
authored for here yet), pick one of its 13 events (middle pane, tagged `customized` vs. `shared`),
write/tag variants (right pane) against `SOUND_PARAMS.voiceLexicon`, same data model as the runtime
resolver. No syllable/formant fields anywhere in the default flow -- variants are TTS text, not
synth rhythm, and exposing that surface was exactly what made LEXICON feel bloated.

**Two real corrections made during the build, not in the original plan:**

- The plan's Appendix A assumed the browser could call `bake-voices.mjs`'s `elevenCatalog()` to list
  the full account. It cannot -- that needs the API key. The manifest is the actual source of truth
  for "which voices exist to author for" here.
- Previewing a not-yet-saved variant's text through the synth needed a new export,
  `buildAdHocVoiceLine(text, identity, opts)` in `bot-voice.js` -- `buildVoiceLine` only resolves
  text through a registered `lineId`/`variantIndex`, and an unsaved variant has neither yet.
  `bot-voice.js`'s synthesis chain was split into an internal `buildFromLine` both functions share,
  so this did not duplicate the formant/vocoder/radio-channel code.

**Generation, not just authoring.** `voice-bake-server.mjs` is a small local relay (`node
voice-bake-server.mjs [port]`, defaults to 8097) the studio's GENERATE button calls, following the
same pattern `glb-shrink-server/` already established: a browser tool cannot safely hold a secret,
so a local server holds it instead. Built on plain `node:http`, not express/cors, specifically to
avoid a fresh npm install on this Drive-hosted repo (large installs are unreliable here, see
`../../CLAUDE.md`). The relay reuses `bake-voices.mjs`'s own `elevenKey`/`elevenCatalog`/
`bakeOneEleven`/`writeManifest` rather than duplicating the ElevenLabs call -- which required
guarding `bake-voices.mjs`'s CLI argument-parsing block behind an
`import.meta.url === pathToFileURL(process.argv[1]).href` check, since it used to run
unconditionally on module load; importing it from the relay server used to trigger a full paid bake
of every combat voice as a side effect before that guard existed.

The GENERATE request carries the variant's text exactly as currently shown in the tool, not a
lookup against `sound-params.json` on disk -- the studio holds edits in memory until you explicitly
save/download, and the relay is a separate process with no visibility into that browser state;
reading from disk would silently generate stale text for anything edited but not yet saved.

**Bake-status detection, and its real limit.** A voice's *first* customized variant writes to the
same filename its shared-lexicon bake already used before any customization existed, so file
existence alone cannot tell "this file has the new text" from "this file still has the old shared
text nobody has re-baked yet" -- confirmed as a real bug during testing, not a theoretical one: a
freshly-added variant showed as already baked. Fixed with session-scoped dirty tracking (any
`(voiceId, lineId)` pair edited since the page loaded reports unbaked regardless of what is on
disk) rather than true content verification, which would need the manifest to record per-file
text hashes -- not built. A manifest refresh (the footer's "↻ refresh bake status" button, or a
generate succeeding) clears the flag.

**Known gaps:** a voice with no prior bake at all cannot be onboarded from this tool (needs
`node bake-voices.mjs --engine=eleven --voice=<slug>` run once first, so it appears in the
manifest); Kokoro and the synth voice have no per-voice lexicon or authoring UI here at all, by the
same ElevenLabs-only scope decision as the runtime system; the relay server has no auth beyond
listening on localhost, matching every other local tool server in this repo.

## Sound parameter registry (`sound-params.js` + `sound-params.json` + `sound-studio.html`)

Every authored number the procedural audio depends on lives in one schema instead of being spread
across five modules as private consts. That is what makes the sound designable: a value you can
find is a value you can tune, and a value with a declared range is one a tool can put on a slider.

### The three pieces

`sound-params.js` holds `SOUND_PARAM_SCHEMA` (the declaration) and `SOUND_PARAMS` (the live
values). **It imports nothing.** That is deliberate and load-bearing: the synth modules, both
viewers, the studio and the Node tests all read it, so any import of its own would risk a cycle,
and any file read would break Node tests that must run without I/O.

`sound-params.json` is an **override document**, not a config file. It holds only what differs from
the schema defaults, so a key absent from it means "whatever the code ships." Both v2 viewers fetch
and apply it at boot, before anything reads `SOUND_PARAMS`:

```js
const res = await loadSoundParams();
if (!res.ok) console.info('sound-params.json not applied:', res.reason);
```

A missing or malformed file is not an error — the defaults simply stand. Node cannot `fetch` a
`file:` URL, which is exactly why the JSON is never a hard dependency of a synth module;
`test-sound-params.mjs` reads it with `fs` instead and validates it against the schema, so the two
cannot drift silently.

`sound-studio.html` is the editor. It **imports the real shipping modules** rather than
reimplementing them, so what it measures is what the game produces. Needs http
(`python serve.py`), like the other module-based pages.

### Sections

Eight numeric sections: `voice`, `siren`, `damageLoop`, `damage`, `ballistic`, `director`,
`budget`, `ranges`. Each param declares `default`, `min`, `max`, `step`, `label` and usually a
`note` recording *why* the number is what it is — `formantQ`'s note carries the measurement that
Q=[9,11,12] cost 15.8 dB and was inaudible over gunfire. Array params (`formantQ`, `formantGain`)
also carry `itemLabels`.

Three further sections in `OVERRIDE_MAP_SECTIONS` are open-ended maps rather than fixed keys:
`voiceLines` (the lexicon), `linePriority`, `lineCooldownMs`. They start **empty**; an entry
overrides the owning module's default for that one key and leaves the rest alone. A `voiceLines`
override may name vowels instead of restating formant numbers, because `bot-voice.js` exposes
`formantsFor(vowel)`.

`ranges` deserves a note: it is the panner distance table (`ref`/`max`/`rolloff` per category)
that both viewers previously hardcoded. `BOT_SFX`, `ARENA_SFX`, `OUTDOOR_SFX` and the whizz/voice
profiles are now all built from a local `panner(ref, max, roll)` helper reading this section.

### The rule that makes live editing work

**Read `SOUND_PARAMS` at build time. Never destructure it at module scope.** `applyParamOverrides`
mutates the section objects **in place** and never reassigns them, so a reference captured at
import time stays valid. The idiom throughout is a getter:

```js
const P = () => SOUND_PARAMS.voice;          // bot-voice.js
export const BOT_DAMAGE_TUNING = SOUND_PARAMS.damage;   // the live object already IS the thing
```

Anything that snapshots into a local const at module load will freeze at the defaults and quietly
ignore every edit. `test-sound-params.mjs` guards this with a held-reference test: it grabs a
reference before an override, applies one, and asserts the old reference reads the new value.

### Pinned vs live

Constructors take explicit options, and those options **pin** a field; fields left unset track
`SOUND_PARAMS` live. `createAudioBudget()` and `createVoiceDirector()` both implement this with
getter/setter pairs over a `pinned` object:

```js
get globalCap() { return pinned.globalCap ?? SOUND_PARAMS.budget.globalCap; }
```

`capFor(category)` is the allocation-free hot-path variant — `reserve()` runs dozens of times a
second, so it must not build a merged object per call.

This pattern is also what surfaced a real bug. `budget.voiceCap` and `director.speakerCap` both
claimed to govern voice concurrency, and the director overwrote the budget's copy at construction,
so editing `voiceCap` did nothing at all. There is now **one** number: `voiceCap` is gone from the
schema, `capFor('voice')` returns `director.speakerCap`, and a test asserts the key stays absent.

### `auditParams()`

Range checks catch a bad number; the audit catches numbers that are each individually legal but
wrong **together**. It returns a list of human-readable issues, and the studio shows them live:

- `ranges.voiceMax < ranges.gunshotMax` — callouts masked by fire the listener can still hear
- `director.maxDistance < ranges.voiceMax` — an unpinned director drops audible callouts
- `damage.maxSirens + damage.maxDamageLoops > budget.loopCap` — loops that can never all start
- `damage.sparkFastMs > damage.sparkSlowMs` — the damage tell reads backwards
- `voice.radioHighpassHz >= voice.radioLowpassHz` — the radio chain passes nothing
- the category caps summing below `budget.globalCap` — a global cap nothing can reach

The shipped defaults pass clean, and the test suite asserts both that they pass and that the audit
actually fires on deliberately broken input.

### The studio's five tabs

| Tab | What it does |
|---|---|
| BENCH | Every synth voice with play, plus an `OfflineAudioContext` render analyzed for peak, RMS, crest factor and spectrum. Offline rendering means the measurement uses the real browser filters rather than a hand-written DSP twin. |
| LEXICON | Per-line syllable editor with rhythm-distance readout against every other line, so retiming a line shows immediately when it starts sounding like another one. |
| MIX | Distance falloff curves from `ranges`, and a masking test that plays a line against a real gunshot bed at a chosen distance and density, reporting the speech-band margin. |
| TRIGGERS | A headless firefight simulation that runs the actual director and budget, reporting what spoke, what was dropped and at which gate. Pins `maxDistance` to `ranges.voiceMax` exactly as the viewers do. |
| EXPORT | Diff against defaults, the audit result, and the `sound-params.json` text to save. |

The masking readout's band levels are unnormalised FFT magnitudes, so **only the margin between
them means anything** — the absolute numbers are not dBFS.

## Baked TTS voices (`bake-voices.mjs`)

The formant synth is the fallback, not the ceiling. Real speech carries timing and coarticulation
that a formant table cannot fake, so the lexicon can also be baked through a TTS engine and played
back through the same channel.

**Two axes, and they are independent.** Voice type (human or machine) is not the same thing as
channel (radio or open air). A bot speaking over the squad net sounds like radio because it *is*
radio; a bot speaking out loud sounds clear. Both voice types can do both. The code has always
modelled this correctly — `radio` is a flag on the builder, unrelated to identity.

**Takes are baked dry.** Never bake a channel treatment into a file, or that file can only ever
play over comms. The radio chain and the vocoder are runtime inserts.

### `bake-voices.mjs`

```
node bake-voices.mjs --list                        what each engine offers, and what is baked
node bake-voices.mjs --engine=eleven --voice=all   the curated combat set
node bake-voices.mjs --engine=kokoro --voice=all   every voice Kokoro grades C or better
node bake-voices.mjs --engine=kokoro --voice=every all 28, slow
node bake-voices.mjs --manifest                    rebuild the index without baking
```

Writes `sfx/voice/<engine>/<voice>/<lineId>.<ext>`, driven by `lineText(lineId)`. The whole lexicon
is 125 characters, so a full ElevenLabs set costs almost nothing.

**26 sets / 338 takes are baked today**: 10 ElevenLabs and 16 Kokoro.

The ElevenLabs voice list is **fetched from the account** rather than hardcoded, so a voice added in
the dashboard is immediately available by its first name. `ELEVEN_COMBAT` names the curated subset
that `--voice=all` bakes; `--voice=every` bakes the whole account. The key comes from
`ELEVENLABS_API_KEY` or a **gitignored** `.eleven-key` at the repo root — never commit it.

Kokoro publishes a quality grade per voice, so `--voice=all` filters to grades A–C and skips the
D/F voices rather than making you audition them.

### `sfx/voice/manifest.json`

Rewritten after every bake, listing each set with its file extension and the lines it covers. The
studio reads this instead of probing a hardcoded list, so **baking a new voice makes it appear in
the studio with no code edit anywhere**.

### Installing Kokoro: not in this directory

Installing kokoro-js **here** failed: it pulls ~411 MB across hundreds of packages including native
binaries, and on this Google Drive filesystem npm's rename and rmdir calls came back
`EPERM`/`EBADF` partway through, leaving a half-written `node_modules`. A no-op `npm install` that
writes nothing is fine, so this is about the size of the tree being written, not about npm being
unusable here. It was observed once and not retried, so treat it as "large installs are unreliable
on this filesystem" rather than a guaranteed failure. Install off-Drive instead:

```
mkdir -p "$PCW_TTS_HOME" && cd "$PCW_TTS_HOME"
echo '{"type":"module"}' > package.json && npm install kokoro-js
```

`bake-voices.mjs` tries a normal `import('kokoro-js')` first and falls back to `PCW_TTS_HOME`
(default `C:/Users/msankofa/AppData/Local/pcw-tts`). The install is ~411 MB, most of it
onnxruntime binaries for every platform, plus an 82 MB model fetched on first run. `npm audit`
reports high-severity findings in `sharp`, pulled in transitively by `@huggingface/transformers` —
`sharp` is an image library, unused by TTS, and this is a local bake tool that never runs in the
browser.

### `buildSampleVoiceLine(buffer, identity, opts)`

Returns a builder honouring the same one-shot contract as `buildVoiceLine`, so the director, the
budget and the panner all keep working with no change at any call site. Options are
`{ radio, gain, robot, drive }`.

Per-bot identity works differently for a sample than for the synth. Played dry, the only knob is
resampling speed, bounded to ±8% — past that a take stops sounding like a different speaker and
starts sounding like the same speaker on the wrong tape speed. Vocoded, identity lives in the
**carrier**, which is seeded per bot exactly as the synth is, so 90 bots can share one file without
sounding like one throat. That is the main argument for the vocoder beyond timbre.

### The vocoder (`SOUND_PARAMS.vocoder`)

A channel vocoder: 14 log-spaced bands, each splitting the take, rectifying it through a WaveShaper
(the only way to get `abs()` without an AudioWorklet), smoothing at 18 Hz, and using that signal as
the control voltage on a `GainNode.gain` for the matching carrier band. Connecting an audio node
straight to an AudioParam is what makes this work without a worklet.

The carrier is the synth's own glottal source, plus a band of highpassed noise — a purely tonal
carrier cannot render an "s" at all, and `sibilanceLevel` is what gives it one.

The studio's vocoder panel is built around **explaining** these numbers rather than listing them.
Four groups, each with its own canvas showing what that group does:

1. **Bands** — every band drawn as a bell on a log axis, with the radio passband shaded so you can
   see which high bands the comms filter will throw away anyway. It reports the adjacent-edge
   ratio: below 1.0 the −3 dB points overlap, above ~1.25 there is a real hole. Defaults sit at
   1.007, so the bands just meet. That is reported as "just meet", not as a fault, because a biquad
   skirt runs well past −3 dB.
2. **Follower** — the take's true loudness in grey against what the follower's lowpass tracks in
   green, so `followHz` and `followGain` have a visible consequence.
3. **Carrier** — the sliders that decide what the machine sounds like.
4. **Output** — the take's spectrum against the vocoded result, both offline-rendered.

### Adding lines

The lexicon is extensible from the studio. **ADD LINE** on the LEXICON tab writes a new entry into
`SOUND_PARAMS.voiceLines`, which is exported to `sound-params.json` like any other override, so no
code change is needed to add vocabulary. `lineIds()` and `lineText()` are the live accessors that
see additions; the frozen `LINE_IDS` export is only the built-in set, and callers that must see
studio-authored lines use `lineIds()`.

A new line is seeded with one syllable per vowel group in its text and a generic rhythm. **It will
usually fail the rhythm-distance check until you retime it** — a two-syllable addition lands about
0.05 from `man_down` against a 0.12 floor. That is the guard working, not a bug, and the studio
says so when the line is created. Built-in lines cannot be deleted, only reverted; added lines
cannot be reverted, only deleted, since they have no code default to revert to.

Three things have to agree for an added line to reach the game, and two of them were originally
broken:

- **The director's typo gate.** `request()` rejects an id it does not recognise, which originally
  meant "present in `LINE_PRIORITY`" — a table of the (now 19) built-ins. An added line lives only in
  the override document, so it synthesised fine and was then dropped as `unknownLine` on every single
  request. `knownLine()` now accepts a line that appears in `LINE_PRIORITY`, `voiceLines`, or
  `linePriority`, so a typo is still refused while an authored addition is not. Added lines take
  the default priority of 10 unless ranked in `linePriority`.
- **The bake script.** `bake-voices.mjs` reads `lineIds()`, which only sees additions once the
  override document is applied. It now loads `sound-params.json` with `fs` before baking — Node's
  `fetch` cannot read a `file:` URL, so `loadSoundParams()` is not usable there. Without this it
  silently rebaked the built-in set and produced nothing for the line you added it for.
- **A call site.** Nothing speaks a line until some FSM edge asks for it. That is still manual.

### Gain staging, measured

TTS output is already normalised and the synth is not, which is why they cannot share a makeup
gain. Measured on a `river` take of `contact`:

| | peak | RMS |
|---|---|---|
| raw file | −5.3 dB | −23.4 dB |
| through `voice.makeup` (2.5) | **0.0 dB** (clipped) | −15.3 dB |
| through `voice.sampleMakeup` (1.0) | −1.1 dB | −20.3 dB |

Hence `sampleMakeup` as a separate parameter. The band split also costs the vocoder about 3 dB the
way the formant bank does, so `vocoder.outGain` (2.2) brings a vocoded take back level with the same
take played dry. Across all four voices nothing now exceeds −0.1 dB peak, and every take sits 1–9 dB
louder in RMS than the synth, so a baked line carries over gunfire without extra help.

### Engine options considered

| Engine | Where it runs | Note |
|---|---|---|
| **ElevenLabs** | Cloud, bake only | Best delivery, especially on `man_down` and `grenade_warn`. Costs credits, so bake rather than call at runtime. Baked on `eleven_v3` (not v2) since 2026-08-03, specifically for its inline delivery tags (`[whispers]`, `[shouts]`) -- see "Line variants and situational intensity" above. |
| **Kokoro (82M)** | Local bake, or WASM in-browser | Apache-2.0 and small. Installed and baked. The only option that could also run at runtime and unlock dynamic phrases. |
| **Piper** | Local bake | Permissive and fast, prosody flatter than the others. |
| Browser `speechSynthesis` | Runtime | Bypasses the `AudioContext` entirely, so no panner, no distance falloff, no radio chain and no budget accounting. Useful as a studio reference only, never for gameplay. |

### Known gaps

- **Voice type is not a bot property yet.** `robot` is a per-match toggle in both viewers, not a
  field on the bot or its team, so human-model and robot-model bots cannot coexist in one firefight.
- **Only `enemy_down` has no `bot_vo_*` event id** in `sound-events.js`, so it is baked but has no
  sample-event route.
- **Kokoro takes are uncompressed.** `sfx/voice` is ~32 MB, of which `kokoro` is 30 MB of WAV
  (~146 KB/take) against `eleven` at 2.3 MB of MP3 (~19 KB/take). Encoding them would cut the tree to
  roughly 3 MB, but it needs `ffmpeg`, which is not installed here.
- **`sound-studio.html` cannot bake.** Baking is a Node script because the key must not reach the
  browser.

## Sound parameter registry known gaps

- **Edits are not hot-applied to a running viewer.** The JSON is read once at boot; retuning means
  saving the file and reloading the page.
- **Saving is a manual copy step.** EXPORT offers copy-to-clipboard and a download, but a browser
  page cannot write into the repo, so the last move is always moving the file into this directory
  yourself.
- **`weapon-sfx-synth.js` is not in the registry yet.** The weapon voices still carry their own
  private constants, so the studio can play them but not edit them.
