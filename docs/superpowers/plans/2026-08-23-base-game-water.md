# Base Game water — full plan

STATUS 2026-08-23: planned, nothing started. Follows the terrain plan
(`2026-08-21-base-game-terrain-execution.md`, Phases 1–9 shipped) and closes this version's terrain
step. Weapons and body tracks run in parallel and do not touch these files.

## Goal

A global sea over the infinite streamed volumetric terrain in `base-game.html`, complete: wave
surface, planar reflection, refraction with per-pixel depth colour, shoreline and crest foam,
caustics on the ground, an underwater view, and swimming that is identical on the client and the
server. Sea level is part of the terrain project, so rooms share it through the existing hash.

## Facts the plan rests on (measured in the code, not assumed)

- Base Game has no water code at all. The ground is many materials (one splat instance per LOD
  level, `BatchedMesh` pools) that `applyMaterials()` reassigns on residency change, so `water.js`'s
  single-`ground.material` caustic injection and its synchronous `heightFn` do not fit. Its
  reflection (TSL `reflector()`), its throttle pattern (`water-pass-scheduler.js`) and its
  refraction (`viewportSharedTexture`) do, and are reused as techniques.
- `water-hybrid.js` `createOceanSurface` is the camera-following infinite surface used by the flight
  sim; it needs a GPU `depthAt(xz)` for thickness, which Base Game does not have (no TSL twin of the
  v5 stack). `water-waves.js` `surfaceAt` is the CPU wave sampler.
- `cfg.sea_level` already exists in every v5 project (`terrain-generator-js.js:32`, range −120..120),
  is authored in the generator's World group, normalised by `terrain-project-v5.js`, and is inside
  `hashProject`, so it already travels through `worldVersion` and `base:set_terrain`. Nothing reads
  it yet. `colorizeGeometry` tints `y < 0` as water today; that 0 becomes `sea_level`.
- The player controller is shared verbatim with the server and stepped in lockstep from the same
  inputs; `captureState` carries `position/previousPosition/velocity/grounded`. Swimming must be a
  pure function of `(position, velocity, config)` — the flat sea level, never the animated wave
  height, so prediction and authority stay bit-identical.
- Render path: `renderer.render` normally, `postPipeline` (`pass()` + DOF) when `dofEnabled`.

## Decisions

- **Sea level = `cfg.sea_level`** for v5 projects; 0 for the analytic source and the lab. One
  uniform, one number on the terrain facade (`terrain.seaLevel`). No protocol change.
- **Physics water is flat** at sea level; waves are visual only. Below sea level = in water,
  including inside caves: a cave below sea level is flooded, which is also what the surface mesh
  shows, so render and physics agree.
- **Depth comes from a streamed sea-depth map**, not from the ground mesh: a small world-space
  heightfield texture around the player (like `terrain-lod-coverage.js`, one texel per N metres)
  filled by `heightAtSpacing` worker jobs. It drives thickness, shore foam, dry-land opacity and the
  "is any water visible" gate. Near the camera thickness is per-pixel from the depth buffer.
- **Caustics are per-fragment inside the splat material** (water-demo mode 2, analytic Snell
  reverse-trace), so every splat instance gets them through `splatFor()` and nothing is injected
  after the fact. No caustic render target.
- Reflection, refraction, caustics, foam and underwater are each a toggle in the Base Game panel
  and saved with the other settings; all default on. Ranges never narrow on perf grounds.

## Phases

### W1 — Sea level through the terrain facade (mechanical)

- `base-game-terrain.js`: `seaLevel` getter from the source descriptor's project cfg (`sea_level`),
  0 otherwise; `colorizeGeometry` water band uses it; `spawnPosition` lands on
  `max(ground, seaLevel) + clearance`; `setSource` updates it.
- `terrain-source-v5.js` descriptor exposes `seaLevel` (read-only, from cfg) so the server reads
  the same number without re-parsing the project.
- `base-game.html`: the terrain studio surfaces the existing v5 field in its World group; owner
  changes ship through `base:set_terrain` as today.
- Test: `test-base-game-terrain-sea-level.mjs` — v5 project with `sea_level: 12` reports 12,
  analytic reports 0, spawn sits above water, source swap updates.

### W2 — Sea-depth map (new module `terrain-sea-depth.js`)

- `createSeaDepthMap({ texels: 256, spacing: 16 })` → float `DataTexture` of ground height around
  the player, recentred by the player's cell, filled by worker jobs at `spacing` (band-limited
  `heightAtSpacing`, the same math the far cascade uses, so shorelines match the far ground). Tiles
  are requested as the window moves; stale texels keep their value until replaced.
- API: `texture`, `origin`, `spacing`, `texels`, `recentre`, `update(dt)` (drains finished tiles),
  `heightAt(x,z)` (CPU bilinear, for gates and audio), `minHeightInWindow()` for the visibility
  gate, `clear()`, `dispose()`.
- `terrain-system.js` / worker: a `sourceHeights` job (grid of `heightAtSpacing`) beside
  `sourceTile`.
- Test: `test-terrain-sea-depth.mjs` — fill from a synthetic source, bilinear correct, recentre
  keeps values, gate false when the window is entirely above sea level.

### W3 — Surface (new module `base-game-water.js`)

- `createBaseGameWater({ renderer, scene, camera, terrain, sky, lights, settings })` wrapping
  `createOceanSurface` with `profile = makeWaterProfile(...)` + `applyWaterPreset('hybrid')`,
  `level = terrain.seaLevel`, grid `r1 = terrain.farExtent`, `dispFade`/`normalFade` scaled to the
  far extent, `sky(dir)` from `sky.js`, sun from the lighting rig.
- `depthAt(xz)` samples the sea-depth map: `seaLevel − texture(map, uv)`; outside the map, a
  constant deep value (flight-sim pattern) so the edge never punches holes.
- Visibility gate: mesh hidden and all heavy passes skipped when
  `seaDepth.minHeightInWindow() > seaLevel` (no water anywhere in view).
- `update(dt, cameraPos)`: time/wind uniforms, recentre, sea-depth update, gate.
- Wave config loads `water-config.json` (`ocean` body) through `loadWaterConfig` and refreshes from
  the panel; Base Game tuning saves to `water-config.json` too (`serve.py` route exists).
- `base-game.html`: create after terrain, `water.update` each frame before render, `renderOrder`
  after terrain, `setSource` → `water.setLevel`.
- Test: `tsl-build-check` of the surface material with a depth-map `depthAt`; gate logic.

### W4 — Refraction and per-pixel depth

- Refraction through `viewportSharedTexture(uv + normal.xz * strength)` (water.js technique).
- Thickness: near = `viewZ(water) − viewZ(viewportDepthTexture(uv))` per pixel; far = depth-map
  value; blended by distance so the shoreline is exact underfoot and cheap at range. Feeds the
  Beer-Lambert colour law and shore foam already in `makeSurfaceShading`.
- DOF path: when `dofEnabled`, confirm `viewportSharedTexture`/`viewportDepthTexture` resolve inside
  `pass()`; if not, the DOF path renders a pre-water colour+depth target (water-demo `refrMode 1`)
  and the surface samples that. This is the one uncertain step in the phase and is checked first.

### W5 — Reflection

- TSL `reflector({ resolutionScale: 0.5, bounces: false })`, target rotated to world +Y at sea
  level, uv distorted by the wave normal, mixed by fresnel (`makeSurfaceShading` takes
  `reflection`).
- Throttle: `water-pass-scheduler.js` pattern — every Nth frame (default 2), skipped when gated or
  when the camera is below the surface; water and the player's own first-person mesh excluded from
  the mirror render.
- Modes: sky only (no mirror pass), planar (default), SSR against the depth buffer (the 32-step
  march from the demo). One switch in the panel.

### W6 — Caustics and wet band on the ground

- `terrain-splat-streamed.js`: optional `water: { level, sunDir, time, wave uniforms }` — an
  emissive term per fragment below sea level: reverse-trace the sun ray through the flat surface
  with the wave normal from the same wave table (`makeWaveFns` of the profile), screen-derivative
  area ratio, depth fade, light-elevation gate. Every instance created by `splatFor()` gets it, so
  it survives `applyMaterials()`.
- Wet band: darker albedo and higher gloss in `[seaLevel, seaLevel + 0.6]` (tide line).
- Shore foam lives in the surface (W3); crest foam from wave height/fold is already in the profile.
- Test: `test-terrain-splat-streamed.mjs` gains a caustic build case; `tsl-build-check`.

### W7 — Underwater

- Camera below `seaLevel + waveAt(camera)` (visual, from `surfaceAt`): surface drawn from below
  (double-sided, inverted fresnel, sky replaced by the refracted ground), scene tint and distance
  fog (a `fogNode` active only underwater — Base Game's first fog), reflection pass skipped, sky
  dome hidden behind the tint.
- Audio: low-pass on the master bus when underwater (`environment-audio.js` has the graph).
- Breath/damage is gameplay and out of scope here.

### W8 — Swimming (client + server, deterministic)

- `base-game-player-controller.js`: `waterLevelAt(x,z)` hook (flat sea level, or `null`);
  `swimming` when the capsule's chest point is below it. In water: gravity replaced by `buoyancy`
  toward the surface with `waterDrag`, horizontal speed × `swimSpeedMultiplier` (0.65), jump = swim
  up, crouch = swim down, surfaces when the head breaks the level, exits to grounded when
  `resolveCapsule` reports ground with the chest above water. New config keys finite-validated;
  `captureState`/`applyState` carry `swimming`.
- Server: `defaultWorldFactory` reads `seaLevel` from the descriptor (W1) and passes the same hook;
  volumetric rooms unchanged otherwise. Kill plane unchanged.
- Spawn/respawn above water (W1). Remote players: a `swim` pose channel is the body track's job;
  until then the existing pose with the capsule at the surface.
- Tests: `test-base-game-player-controller.mjs` swim cases (enters, floats, exits, drag), and
  `test-base-game-rooms-water.mjs`: the same input script on the client and server controllers
  produces identical positions through a water entry and exit.

### W9 — Panel, persistence, docs, perf record

- Base Game panel: water section — enable, reflection mode, refraction, caustics, foam, underwater
  fog, wave preset, sea level (owner-only online). Saved with the page state file; wave tuning in
  `water-config.json`.
- Performance captures include water pass timings (reflection, surface) in the existing
  `research/stats/base-game-performance-log.json` entries.
- Docs: `docs/subsystems/base-game.md` water section, `water.md` cross-link, `terrain.md` for the
  sea-depth job, `multiplayer.md` note that sea level rides the project hash; `agent_log.csv` rows
  per phase.

## Order and parallelism

W1 → W2 → W3 → W4 → W5 → W6 → W7 → W9, with W8 parallel from W1 on (it needs only the sea level).
W4's DOF check runs first inside W4 because it decides whether a pre-pass exists.

## Known limits to state, not hide

- Thickness under a cave roof uses the open-sky heightfield, so depth colour inside a flooded cave
  is approximate; the surface itself and the physics are correct there.
- Waves are visual; a body on a crest is still at flat sea level in the lockstep.
- The analytic source has no authored sea level; it is 0.
- The planar mirror reflects the far cascade beyond the exact window, the same as the camera sees.
