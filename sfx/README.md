# sfx/ — canonical sound library

Self-contained SFX library for this workspace. Both `sfx-browser.html` (the assignment
tool) and the environment viewer's Audio tab point at **this folder**.

## Layout

```
sfx/
  <category>/*.wav   ← your raw source sounds, in any subfolders you like (e.g. guns/, footsteps/)
  bbc/               ← auto-generated: downloads from the BBC archive tab land here
  assets/            ← auto-generated: sfx-browser copies the assigned sound here as <eventId>.wav
  assets/env/        ← auto-generated: ambience layers, as <environmentId>__<sourceFile>
  sound-map.json     ← auto-generated: event ids -> assets/<eventId>.wav, plus `environments`
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

## The BBC SOUNDS tab

The **BBC SOUNDS** tab searches the BBC Sound Effects archive (~33,000 recordings) from inside the
browser. Its search API and media CDN both send `Access-Control-Allow-Origin: *`, so the page calls
them directly: no API key, no account, and no `serve.py` proxy.

1. Type a query (`wind`, `dawn chorus`, `river`, `forest at night`) and press Enter.
2. **PLAY** streams the recording from the BBC. Nothing is written to disk.
3. **⬇ DOWNLOAD** saves it into `sfx/bbc/` and adds it to the sidebar immediately. From that point
   it is an ordinary library sound — favourite it, assign it, and it appears in the UMAP plot.

The length and stereo filters are applied **in the page**, not by the server: the archive accepts a
`durations` criterion and then ignores it, so a page of 24 results is narrowed here and the status
line says how many were dropped. That is also why a filtered page can look sparse — press LOAD MORE.

`mp3` (128 kbps) is the default download and is right for almost everything. `wav` is the untouched
original — the same forest recording is 8 MB as mp3 and 89 MB as wav.

**Licence.** The archive is RemArc-licensed: free for personal, educational and research use, and
*not* cleared for general commercial use. Downloaded filenames keep the BBC id (`bbc-07076027-…`)
so provenance survives in the library.

## Environments and locations

Alongside the one-shot game events, the assign popup has **ENVIRONMENTS** and **LOCATIONS** — the
ambience slots defined in `sound-environments.js`. They differ from events in two ways:

- They hold up to four sounds, because a forest is wind plus birds plus distant water. Clicking an environment *adds* the sound as a layer instead of replacing what is there;
  clicking a slot the sound is already in removes that layer.
- Their assets go to `assets/env/<environmentId>__<sourceFile>` rather than `assets/<eventId><ext>`,
  and they are written to a separate `environments` key in `sound-map.json`.

`environments` is additive — `environment-audio.js` reads only `events`, so it ignores the new key.
**Nothing plays these yet.** The editor writes them; wiring a runtime that picks a bed by time of
day, terrain and weather is a separate job.

See `docs/subsystems/audio.md` for the code-side wiring.
