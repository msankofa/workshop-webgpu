# sfx/ — canonical sound library

Self-contained SFX library for this workspace. Both `sfx-browser.html` (the assignment
tool) and the environment viewer's Audio tab point at **this folder**.

## Layout

```
sfx/
  <category>/*.wav   ← your raw source sounds, in any subfolders you like (e.g. guns/, footsteps/)
  assets/            ← auto-generated: sfx-browser copies the assigned sound here as <eventId>.wav
  sound-map.json     ← auto-generated: maps game event ids -> assets/<eventId>.wav (+ source path)
```

`sfx-browser.html`'s folder scan skips `assets/`, so only your raw source sounds show up as
browsable cards — the assigned copies never pollute the browser.

## Workflow

1. Serve the workspace: `python serve.py` (File System Access + module imports need http, not file://).
2. Drop `.wav` files into subfolders here (e.g. `sfx/guns/pistol_01.wav`).
3. Open `http://127.0.0.1:8080/sfx-browser.html`, click **OPEN FOLDER**, pick **this `sfx/` folder**.
4. On a sound card, click **+ (ASSIGN EVENT)** and bind it to an event id — e.g.
   `pistol_shoot` (m1911), `sniper_shoot` (m24), `enemy_hit` (bullet hits flesh),
   `bullet_impact` (bullet hits terrain/rock/tree), `footstep`, `jump`, `landing`,
   `pause_open`, `map_menu_open`, `vr_light_spawn`, …
   The assignable list is `sound-events.js` (`SOUND_EVENT_DEFS`), curated to exactly the events
   this game fires — the browser imports it, so there are no dead options.
5. In the viewer's **Audio** tab, click the SFX-folder picker and choose **this same `sfx/` folder**.
   It reads `sound-map.json` and decodes the assigned wavs. Both tools also share a live
   `BroadcastChannel('sfx-game')`, so assignments made in the browser update a running viewer
   instantly — no reload.

The two tools persist their folder choice independently (separate IndexedDB stores), so you
pick this folder once in each.

See `docs/subsystems/audio.md` for the code-side wiring.
