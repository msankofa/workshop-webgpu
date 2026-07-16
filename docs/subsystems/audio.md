# Audio / SFX

Positional SFX + music for the environment viewer, plus the browser tool used to bind
sound files to game events. No build step; everything is plain ES modules served over http.

## Files

| File | Role |
|---|---|
| `environment-audio.js` | The runtime controller. Owns its own Web Audio graph (master→sfx gain, HRTF panners), music playback with effects, settings persistence, and the SFX/music folder loaders. Created once in `environment-viewer.html` as `envAudio`. |
| `sound-events.js` | The single source of truth for event ids. `SOUND_EVENT_DEFS` = `[{id,label}]`; `SOUND_EVENTS` = id array; `soundEventById()`. Both the controller and `sfx-browser.html` import this so their event lists can never drift. |
| `sfx-browser.html` | Standalone assignment tool. Browses a folder of `.wav` files and binds them to event ids, writing `assets/<eventId>.wav` + `sound-map.json`. Imports `SOUND_EVENT_DEFS` (module script — serve over http). |
| `sfx/` | The canonical in-repo sound library both tools point at. See `sfx/README.md`. |
| `asset-paths.js` | `getFileByKey(dirHandle, relPath)`, `extensionOf()` — path helpers over File System Access handles. |
| `file-handles.js` | `createHandleStore(db, store)` — IndexedDB persistence of picked directory handles so folders auto-restore. |
| `live-updates.js` | `subscribeLiveUpdates()` / `rememberLiveMessage()` — the `BroadcastChannel('sfx-game')` (+ localStorage fallback) transport that pushes browser edits into a running viewer. |
| `music-pitch-processor.js` | AudioWorklet for independent pitch shifting of music tracks. |

## Controller API (`createEnvironmentAudio(options)`)

Constructed with `{ THREE, scene, camera, getPlayerPosition, isGameplayActive, isDucked?,
getSpeakerTargets?, workletUrl }`. Returns:

- `init()`, `noteGesture()` (unlock audio on user gesture), `update(tMs)` (per-frame listener + music orb).
- `play(eventId, vol?)` — non-positional SFX. No-ops silently if the event has no loaded buffer.
- `playAt(eventId, position, vol?, opts?)` — positional SFX; `opts` is a panner profile from
  `positionalSfxProfiles` (`gunshot`, `heavyGunshot`, `explosion`, `minor`, `spawn`, …).
- `pickSfxFolder()` / `restoreSfxFolder()` / `loadSfxFolder(handle)` — load a folder's
  `sound-map.json` and decode its wavs into buffers via the File System Access API (Chrome/Edge
  only, requires a user-granted directory handle). Music folder equivalents also exist.
- `loadSfxHttp(baseUrl?)` — same `sound-map.json` shape, fetched over http instead of a picked
  folder; no permission/gesture needed since it's a same-origin static-file fetch. `restoreSfxFolder()`
  calls this automatically whenever no folder handle is stored or its permission isn't silently
  `'granted'`, so SFX load with zero setup on a fresh browser/profile. A folder picked later via
  `pickSfxFolder()` takes over (and is needed for the live-edit `BroadcastChannel` path from
  `sfx-browser.html`).
- `setVolume(kind,v)`, `setMuted(kind,b)`, music controls, `subscribe()`/`getState()` (drives the
  Audio tab in `environment-ui.js`), `dispose()`.

`sound-map.json` shape: `{ version, events: { <id>: "assets/<id>.wav" | [paths] },
sources: {...}, modes: {...}, volumes: {...} }`. Only ids in `SOUND_EVENTS` are loaded.

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

## Multiplayer impact audio

Guests now sound impacts off the replicated `hit_spark` effect upserts they already render: the
guest sim_state callback (~600) plays `enemy_hit` (surface `player`/`creature`/`mob`) or
`bullet_impact` (world surfaces) positionally, once per effect id (tracked in `mpSeenImpactFx`,
pruned to the live id set). Gun *reports* were already replicated (host sounds guest shots in
`applyCombatIntent`; guests sound each other via the broadcast `fireSeq`). The host still plays
its own impacts directly inside `applyCombatIntent`/`spawnShotEffects`.
