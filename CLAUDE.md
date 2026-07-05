# CLAUDE.md (workshop-webgpu)

Guidance for Claude Code when working in this directory. This is the **WebGPU renderer migration workspace** â€” a separate codebase from the original single-file app documented in `../CLAUDE.md` one level up. It shares the "procedural creature" concept but not the code.

## Running

`environment-viewer.html` makes ES module imports and asset fetches (GLTF maps, textures) that don't work over `file://` â€” it needs a local server:

```
python serve.py [port]   # defaults to 8080
```

then open `http://127.0.0.1:8080/environment-viewer.html`.

For a browser dashboard that can start/stop the static server and multiplayer relay and
show their logs, run:

```
python server-tool.py [port]   # defaults to 8099
```

then open `http://127.0.0.1:8099/server-tool.html`.

`creature-viewer.html` (the legacy app, see below) can be opened directly as a file like the original app.

**Tests** are plain Node scripts, no framework: `node test-<name>.mjs`. They live flat at the repo root, one per subsystem.

**Multiplayer relay server** is a separate Node process: `cd server && npm start` (uses `ws`; deploy config in `server/render.yaml`).

## Architecture

Two unrelated apps live in this directory:

- **`environment-viewer.html`** â€” the active WebGPU app (Three.js r0.184, WebGPU backend, TSL shader nodes). All current development happens here.
- **`creature-viewer.html` + `creature.js`** â€” a legacy WebGL viewer that predates the WebGPU migration. Not wired into `environment-viewer.html` in any way. See `docs/subsystems/legacy.md`.

`environment-viewer.html` is a single `<script type="module">` entry point (~2854 lines) that statically imports ~11 always-on modules and lazily `await import()`s another ~14 (forest, grass, water, sky, clouds, post-fx, CDLOD terrain, clustered lights, particlesâ€¦), gated by mode flags like `GRASS_MODE`/`FOREST_MODE`, several with cache-busting `?v=` query strings from live-tuning sessions. Full breakdown: `docs/subsystems/entry-point.md`.

## Subsystems

The codebase is organized into independently-loadable subsystems, each with a reference doc in `docs/subsystems/`. Open **`code-map.html`** in a browser for an interactive dependency graph â€” search, filter by subsystem, click a node for details and a direct link to its doc.

| Subsystem | Doc | Key files |
|---|---|---|
| Entry / orchestration | `entry-point.md` | `environment-viewer.html` |
| Terrain | `terrain.md` | `terrain-system.js`, `terrain-field.js`, `cdlod-terrain.js`, `collision.js`, `map-collision.js` |
| Vegetation | `vegetation.md` | `trees.js`, `forest-gpu.js`, `forest-placement.js`, `grass.js`, `grass-compute.js` |
| Rocks / scree | `rocks.md` | `rocks.js`, `rocks-placement.js`, `dressing-gpu.js` (standalone; not yet wired into `environment-viewer.html`) |
| Water | `water.md` | `water.js` |
| Sky / atmosphere | `sky.md` | `sky.js`, `sky-field.js`, `clouds.js`, `stars.js`, `celestial-bodies.js` |
| Lighting | `lighting.md` | `lights.js`, `clustered-lights.js` |
| Particles / FX | `fx.md` | `particle-field.js`, `particles.js`, `post-fx.js` |
| Creature sim | `creature.md` | `port-creature-bridge.js`, `port-creature-system.js` |
| Multiplayer | `multiplayer.md` | `multiplayer.js`, `start-screen.js`, `server/server.js` |
| Infra / debug UI | `infra.md` | `frame-profiler.js`, `environment-ui.js`, `world-map.js` |
| Legacy app | `legacy.md` | `creature-viewer.html`, `creature.js` |

## Keeping docs and the activity log current

These are required steps when finishing any code change in this directory, not optional cleanup:

1. **Update the subsystem doc.** If you changed, added, or removed code in a file owned by one of the subsystems above, update that subsystem's `docs/subsystems/<name>.md` in the same change â€” fix any API signatures, wiring, tunable parameters, or architecture notes that drifted. A subsystem doc that doesn't match the code is worse than no doc. If the change spans multiple subsystems, update each one affected. If you added a genuinely new subsystem (new top-level lazy-loaded module group), add a doc for it and a row in the table above and in `code-map.html`'s `DOC_LIST`/`GROUP_DOCS`.
2. **Append to `agent_log.csv`.** Add one row per logical change (not per tool call) with columns `date,subsystem,files,summary`:
   - `date` â€” ISO 8601 (`YYYY-MM-DDTHH:MM`).
   - `subsystem` â€” one of the table keys above (`terrain`, `vegetation`, `water`, `sky`, `lighting`, `fx`, `creature`, `multiplayer`, `infra`, `legacy`, `entry`), or `multi` if it spans several.
   - `files` â€” semicolon-separated list of files touched (quote the field if it contains commas).
   - `summary` â€” one short sentence: what changed and why, not a restatement of the diff.
   Never delete or rewrite existing rows â€” it's an append-only history. If the file grows unwieldy, that's a signal to summarize old entries elsewhere, not to truncate it silently.

## Patterns worth knowing

- **CPU/GPU math twins**: `forest-cull.js`, `light-cluster.js`, and `post-grade.js` are hand-synced CPU reimplementations of TSL/GPU math that actually lives in `forest-gpu.js`, `clustered-lights.js`, and `post-fx.js` respectively. They exist only so that math is unit-testable in Node without a GPU â€” they are **not imported** by the production files they mirror, so keep them in sync manually when the GPU-side math changes.
- **`environment-ui.js` is not where the sliders are.** It's a tabbed shell plus a read-only perf-stats HUD. The actual tuning sliders for every subsystem are built inline in `environment-viewer.html`.
- **Mode flags pick lazy-import variants**, not both at once â€” e.g. `GRASS_MODE` selects `grass.js` (CPU) vs. `grass-compute.js` (GPU); check `environment-viewer.html` before assuming a given module's code path is live.
- **Multiplayer is host-authoritative**: the host runs the real simulation and broadcasts state; guests render interpolated ghosts via `GhostRenderer` and don't currently send input back (see `docs/subsystems/multiplayer.md` for the gap).

## Interaction style

- Do not use the AskUserQuestion tool. Ask directly in plain chat text instead.
- When more than one clarifying question is needed, batch them into a single message rather than asking one at a time.

