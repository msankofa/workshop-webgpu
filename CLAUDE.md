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
| Terrain | `terrain.md` | `terrain-system.js`, `terrain-field.js`, `terrain-source.js`, `terrain-source-analytic.js`, `terrain-source-v5.js`, `terrain-worker.js`, `world-query-heightfield-provider.js`, `world-query-chunk-mesh-provider.js`, `terrain-volume-collision.js`, `terrain-clipmap-window.js`, `terrain-clipmap.js`, `terrain-splat-streamed.js`, `terrain-chunk-batches.js`, `terrain-lod-coverage.js`, `cdlod-terrain.js`, `collision.js`, `map-collision.js`, `soil-shade.js` |
| Terrain generator (authoring) | `terrain-generator.md` | `terrain-generator-v5.html`, `terrain-gen-worker.js`, `terrain-generator-js.js`, `terrain-stack.js`, `terrain-noise.js`, `terrain-paint.js`, `terrain-history.js`, `terrain-heightmap-io.js`, `terrain-project-v5.js`, `terrain-editor-bridge.js` (`terrain-generator-v4.html` kept as-is) |
| Vegetation | `vegetation.md` | `trees.js`, `forest-gpu.js`, `forest-placement.js`, `grass.js`, `grass-compute.js`, `grass-look.js` |
| Rocks / scree | `rocks.md` | `rocks.js`, `rocks-placement.js`, `dressing-gpu.js` (standalone; not yet wired into `environment-viewer.html`) |
| Water | `water.md` | `water.js`, `water-hybrid.js`, `water-waves.js` |
| Sky / atmosphere | `sky.md` | `sky.js`, `sky-field.js`, `clouds.js`, `stars.js`, `celestial-bodies.js` |
| Lighting | `lighting.md` | `lights.js`, `clustered-lights.js` |
| Particles / FX | `fx.md` | `particle-field.js`, `particles.js`, `post-fx.js`, `effect-renderer.js`, `projected-decals.js`, `wound-mask.js`, `blood-tuning.js`, `entity-types/effect.js`, `vision-modes.js` (RGB/NVG/thermal where heat is a material property), `damage-simulator.html` (standalone single-bot harness for tuning hit effects), `explosion-tier.js`, `blast-debris-sim.js`, `blast-debris.js`, `demos/volumetric-smoke.html` (explosion viewer: marched volume + html-game-v2 debris port) |
| Creature sim | `creature.md` | `port-creature-bridge.js`, `port-creature-system.js`, `creature-plan.js`, `creature-locomotion.js` |
| Model studio (spec + gates) | `model-studio.md` | `model-primitives.js`, `model-modifiers.js`, `model-csg.js`, `model-spec.js`, `model-targets/` |
| Roads | `roads.md` | `roads.js`, `road-network.js`, `road-index.js`, `road-mesh.js`, `road-path.js` (wired into `bot-viewer-v3.html`) |
| Shoot house map | `shoot-house.md` | `shoot-house.js`, `shoot-house-layout.js` |
| Combat bots (wired) | `bots.md` | `bot-entity.js`, `bot-forensics.js`, `bot-activity.js`, `bot-aim-blend.js`, `nav-grid.js`, `bot-body-design.js`, `bot-body-hit.js`, `bot-limb-map.js`, `bot-wound.js`, `bot-bleed.js`, `bot-haywire.js`, `bot-damage-class.js`, `bot-face.js`, `bot-body-versions.js`, `bot-drones.js`, `bot-destruction.js` (pure; not wired yet), `mocap-retarget.js` (pure; camera pose → `setRagdollPose`, demo-only), `bot-viewer-v3.html` (the live standalone harness — all new bot work goes here; `bot-viewer-v2.html` is a frozen snapshot as of 2026-08-08 and `bot-viewer.html` is the older v1) |
| Bot design studio (workflow) | `design-studio.md` | `bot-design-studio.html` (FROZEN 2026-08-15 — infra donor for the NPC suite) |
| NPC design suite | `npc-suite.md` | `npc-suite.html`, `npc-suite-shell.js`, `npc-suite-core.js` (one UI hosting the body-cluster tools as modes over a persistent NPC; step 1 shell shipped) |
| Multiplayer | `multiplayer.md` | `multiplayer.js`, `start-screen.js`, `server/server.js` |
| Audio / SFX | `audio.md` | `environment-audio.js`, `sound-events.js`, `sfx-browser.html`, `sfx/` |
| Procedural audio + sound params | `audio.md` | `bot-voice.js`, `bot-voice-intensity.js`, `bot-voice-director.js`, `bot-voice-bank.js`, `bot-damage-audio.js`, `ballistic-audio.js`, `combat-audio-budget.js`, `synth-utils.js`, `sound-params.js`, `sound-params.json`, `sound-studio.html`, `voice-line-studio.html`, `bake-voices.mjs`, `voice-bake-server.mjs` |
| Materials (TSL demos) | `materials.md` | `materials/index.js`, `materials/material-demo-api.js`, `materials/dissolve.js`, `materials/hologram-visor.js`, `materials/damage-overheat.js`, `materials/foliage-sss.js`, `material-viewer.html` |
| Infra / debug UI | `infra.md` | `frame-profiler.js`, `environment-ui.js`, `world-map.js`, `disk-store.js`, `tools/filesystem-map.html` (WebGPU/TSL holographic 3D force-directed node-link map of the repo filesystem, filterable by type/date, served by `serve.py`'s `/api/fs-scan`) |
| Code ordination | `ordination.md` | `ordination-steps.html` (the step viewer: one tab per stage, each showing its input and output), `ordination-annotate.js`, `ordination-explain.js`, `code-ordination.html` (the finished map), `ordination-pipeline.js`, `ordination-extract.js`, `ordination-represent.js`, `ordination-embed.js`, `ordination-vectors.js`, `ordination-score.js` |
| Weapon GLB compression | `weapon-compression.md` | `glb-shrink-server/index.mjs`, `glb-shrink-presets.mjs`, `weapon-viewer-v2.html` |
| Flight | `flight.md` | `flight-model.js`, `flight-airframes.js`, `flight-terrain.js`, `flight-ai.js`, `flight-combat.js`, `flight-drones.js`, `flight-autopilot.js`, `flight-meshes.js`, `water-hybrid.js`, `demos/flight-sim.html` (blast debris via `blast-debris-sim.js`/`blast-debris.js`) |
| Aircraft studio | `aircraft-studio.md` | `aircraft-studio.html`, `aircraft-layout.js`, `aircraft-meshes.js`, `aircraft-library.js` |
| Stadium models | `stadium.md` | `stadium-glb.js`, `stadium-rig-map.js`, `stadium-rig-roles.js`, `stadium-pose.js`, `stadium-stance.js`, `stadium-species.js`, `foot-sdf.js`, `stadium-walker.js`, `gait-diagnostics.js`, `stage-roster.js`, `gait-search.js`, `trial-log.js`, `rig-audit.js`, `sweep-gait.mjs`, `demos/stadium-walker-v2.html` (staged: rig → stand → walk → trial, and the only editor of a stance), `demos/stadium-walker.html` (v1), `demos/sdf-pikachu.html`, `demos/sdf-mesh-bake.js`, `models/stadium/` |
| Pokémon Park | `pokemon-park.md` | `park-species.js`, `park-biomes.js`, `park-ground.js`, `park-spawn.js`, `park-movement.js`, `park-creature.js`, `park-flora.js`, `park-trees.js`, `park-trails.js`, `park-atlas.js`, `demos/pokemon-park.html` (all 151 species now in `models/stadium/`) |
| Pokémon moves | `pokemon-moves.md` | `moves/move-core.js`, `moves/move-parts.js`, `moves/move-registry.js`, sixteen `moves/fx-*.js` effects (bolt, stream, crystals, fissure, aurora, cloud, orb, blade, shock, ring, vortex, skyfall, dome, tether, field, aura), `demos/pokemon-moves.html` |
| Pokémon Lab | `pokemon-lab.md` | `pokemon-lab.html` (the page; browse mode shipped), `pokemon-rig.js` (facts about a skeleton), `pokemon-annotation.js` (what a person decided each part is), `pokemon-lab-io.js` (the one file, plus the dex list), `pokemon-pose.js` (how far apart two poses are; pure, not wired in), `pokemon-select.js` (picking bones and chains), `pokemon-ik.js` (FABRIK, and which bones answer a drag), `pokemon-hang.js` (a ragdoll built from a rig, stepped by `ragdoll.js`, whose cone solver gained an optional `min` and per-cone `stiffness` — both default to its old behaviour); v1 plan in `docs/pokemon-lab/v1-plan.md`, the maths and its limits in `docs/pokemon-lab/math.md`. Replaces the stadium-walker line for new work — v1 is browse/annotate/pose only, v2 is movement, v3 is moves |
| Sabosugi reference + hybrids | `sabosugi.md` | `sabosugi-visuals/VISUALS_INDEX.md` (the catalog, and the source of truth), `sabosugi-visuals/gallery.html`, `sabosugi-visuals/build-manifest.py`, `sabosugi-visuals/pens-manifest.json` (generated), `sabosugi-visuals/hybrids/` (seven of our own recombinations), served out of their zips by `serve.py`'s `/sabosugi/<slug>/<file>`; reference only, not wired into any app |
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

## Saving state — a file, never `localStorage`

**Anything a person authors or tunes in one of these pages must be saved to a file on disk**, autosaved on
change or behind a save button, from the first version of the page rather than added later. `localStorage`
is scoped to the origin, so it dies when site data is cleared or the static server comes up on a different
port, and it is invisible to git — hours of tuning kept there is not backed up, not diffable, and not
shareable between pages.

Use `disk-store.js`: it GETs a JSON file, POSTs it back through a `serve.py` route, and keeps web storage
only as the fallback a page opened without the server can still read. `serve.py` already has write routes
for maps, stats, traces, layouts, notes, slot saves, body tuning, damage tuning, water config and stadium
tuning — add one there rather than inventing a new mechanism. `demos/stadium-walker.html` is the worked
example; `docs/subsystems/stadium.md` explains the arrangement.

## Patterns worth knowing

- **CPU/GPU math twins**: `forest-cull.js`, `light-cluster.js`, and `post-grade.js` are hand-synced CPU reimplementations of TSL/GPU math that actually lives in `forest-gpu.js`, `clustered-lights.js`, and `post-fx.js` respectively. They exist only so that math is unit-testable in Node without a GPU â€” they are **not imported** by the production files they mirror, so keep them in sync manually when the GPU-side math changes.
- **`environment-ui.js` is not where the sliders are.** It's a tabbed shell plus a read-only perf-stats HUD. The actual tuning sliders for every subsystem are built inline in `environment-viewer.html`.
- **Mode flags pick lazy-import variants**, not both at once â€” e.g. `GRASS_MODE` selects `grass.js` (CPU) vs. `grass-compute.js` (GPU); check `environment-viewer.html` before assuming a given module's code path is live.
- **Multiplayer is host-authoritative**: the host runs the real simulation and broadcasts state; guests render interpolated ghosts via `GhostRenderer` and don't currently send input back (see `docs/subsystems/multiplayer.md` for the gap).

## Interaction style

- Do not use the AskUserQuestion tool. Ask directly in plain chat text instead.
- When more than one clarifying question is needed, batch them into a single message rather than asking one at a time.

