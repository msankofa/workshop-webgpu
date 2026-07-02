# Creature Simulation Subsystem

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#creature)

## Purpose

Drives the procedural creatures (body plans, gaits, IK limbs, behaviors, combat) inside the WebGPU
environment viewer. This is a port of the standalone `creature-viewer.html` app described in the
top-level `CLAUDE.md`: the same data model (body plan + gait + style descriptors), the same
`Creature` class with FABRIK-based `KinematicChain` IK for legs/arms, the same behavior set
(wander, direction, target, forage, combat, race) and combat state machine, now adapted to run
inside the larger terrain/forest/water environment scene with a WebGPU renderer instead of as a
standalone WebGL page.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `port-creature-bridge.js` | Wires the creature system into `environment-viewer.html`: builds/injects the floating toolbar + panel DOM/CSS, derives an arena size from the terrain system, forwards terrain/trunk callbacks into the simulation, handles pointer click/dblclick raycasting (select creature / set target point), and exposes a thin `update`/`reset`/`stats` wrapper (including an "off" mode that zeroes stats and hides creatures without simulating). | 524 |
| `port-creature-system.js` | The ported simulation itself: body plans, gaits, styles, seeded randomization, `KinematicChain` (FABRIK IK), `Creature` class (steering, physics, leg stepping, combat, foraging, rendering), `Grabbable` objects, spatial-grid collision/separation, LOD tiers, and an instanced-mesh batching layer for WebGPU rendering. | 4830 |

## Public API

`port-creature-system.js` has a single top-level export:

- `createPortCreatureSystem({ scene, terrainHeight, resolveTrunks, nearbyTrunks, terrainSettings, rebuildTerrain, camera, lod })` — factory. Returns an object with:
  - `update(dt)` — runs one full sim/render frame.
  - `resetCreatures()` — rebuilds the creature roster from current settings/config.
  - `clearRenderBatches()` — zeroes the instanced-mesh batches (used when creatures are hidden).
  - `spawnRandomObjects(count?)` — (re)spawns `Grabbable` pickup objects.
  - `selectFromRaycaster(raycaster)` — hit-tests creatures/instanced batches for picking.
  - `setTargetPoint(point)` — sets `simTarget` and switches behavior to `'target'`.
  - `setBehavior(b)` — sets the active behavior and syncs the toolbar `<select>`.
  - getters: `stats`, `creatures`, `currentBehavior`.

  (Everything else — `Creature`, `KinematicChain`, `BODY_PLANS`, `GAITS`, `Grabbable`,
  `SpatialGrid`, the instanced batch helper `createCreaturePartBatches`, etc. — is internal/module-scoped,
  not exported; identified via a strategic skim, not a full line-by-line read of all 4830 lines.)

`port-creature-bridge.js` exports one factory:

- `createEnvironmentPortCreatures({ scene, renderer, camera, ground, terrain, terrainSystem, terrainHeight, resolveTrunks, nearbyTrunks, rebuildWorld, isInteractionEnabled, mode })` — returns `{ update(dt), reset(), stats (getter), system }`, where `system` is the object returned by `createPortCreatureSystem`.

## Wiring

In `environment-viewer.html`:

- Static import: `import { createEnvironmentPortCreatures } from './port-creature-bridge.js';` (line 44).
- Construction (line ~351): `const portCreatures = createEnvironmentPortCreatures({ scene, renderer, camera, ground: () => ground, terrain, terrainSystem, terrainHeight, resolveTrunks: (px, pz, r) => trunkIndex.resolve(px, pz, r), nearbyTrunks: (px, pz) => trunkIndex.nearby(px, pz), rebuildWorld, isInteractionEnabled: () => !fpsMode, mode: CREATURE_MODE })`, where `CREATURE_MODE` comes from the `?creatures=` URL param (default `'on'`) and `trunkIndex` is a `createTrunkIndex(...)` from `collision.js`.
- Per-frame call: `frameProfiler.time('creatures', () => portCreatures.update(rawDt));` (line ~2804), profiled under the `'creatures'` pass alongside terrain/water/etc.
- Terrain height: the bridge passes the scene's real `terrainHeight` function straight through to the sim, so creature ground contact follows the actual procedural terrain (not a separate height function). It also derives a synthetic `creatureTerrain` settings object (amplitude/lake/waterLevel/arena size) from the live `terrain`/`terrainSystem` params for the sim's internal "rebuild terrain" UI action, which on rebuild copies values back into the real `terrain` object and calls `rebuildWorld()`.
- Tree collision: `resolveTrunks`/`nearbyTrunks` are forwarded from `trunkIndex` (in `collision.js`) so creatures can avoid/steer around tree trunks; this is separate from the `map-collision.js` `createMapCollider`, which (per a grep of the file) is not referenced by the creature wiring — it appears to serve other movement/collision (e.g. player/vehicle), not creatures.
- Picking/interaction: pointerdown/click/dblclick listeners on `renderer.domElement` call `system.selectFromRaycaster` (single click, gated by `isInteractionEnabled()`/`!fpsMode`) and `system.setTargetPoint` (double-click against the `ground()` mesh) for the `target` behavior.
- Stats are read directly off `portCreatures.stats` for the on-screen terrain/perf debug HUD and the frame-profiler snapshot (`creatureVisible`, `creatures`, `creatureRendered`, etc.).

## Architecture notes

Preserved from the original `creature-viewer.html` (per top-level `CLAUDE.md`):
- The body-plan/gait/style descriptor model (`BODY_PLANS`, `GAITS`, style objects), `pair()`/`finalizePlan()`/`editPlanWithSettings()`/`armSpecsForPlan()` construction pipeline.
- `KinematicChain` FABRIK solver (`port-creature-system.js:642`) for leg/arm IK, including pole-vector elbow/knee bias.
- The `Creature` class (`port-creature-system.js:1359`) with the same per-frame pipeline described in the top-level docs: combat → eating → forage state → steering → fixed-timestep physics/leg-stepping → collision resolution → render.
- The same behavior set (wander/direction/target/forage/combat/race) and combat state machine, `Grabbable` object interaction (reserve/grab/carry/stow), and JSON export/import of full scene config.
- Seeded randomization (`seededRandom`, `RANDOM_GROUPS`-style `numParam`/`gaitParam`/`spreadParam`/`countParam` helpers) and the toolbar/options/model/inspector panel UI, now built dynamically into DOM injected by `ensurePortCreatureUi()` rather than living in the original page's static HTML.

WebGPU/integration-specific adaptations identified:
- **Instanced batch rendering**: `createCreaturePartBatches()` (`port-creature-system.js:805`) replaces (or supplements) per-creature meshes with shared `THREE.InstancedMesh` buckets (`shellBox`, `plateBox`, `trimBox`, `lightBox`, `footBox`, `jointSphere`, `limbSegment`, `shadowBox`) of capacity 8192, populated per-frame via `beginFrame()`/`add*()`/`endFrame()` and used for both rendering and raycaster picking (`ownerForHit`). Toggleable via `?creatureInstancing=` URL param (`'parts'` default, `'off'` falls back to non-instanced — not verified by full read which path that fallback takes).
- **LOD system**: `creaturePerf` distance/stride tuning (`detailDistance`, `bodyOnlyDistance`, `hideDistance`, `fullUpdateStride`, `bodyUpdateStride`, `farUpdateStride`, `ikDistance`, `shadowDistance`) gates simulation/IK/shadow cost by camera distance, tracked per-creature as `lodShouldSim`/`lodVisible`/`lodDebugActive`/`lodArmsActive` flags — not present in the original standalone viewer's CLAUDE.md description.
- **Perf instrumentation**: a `creatureStats`/`stats` object tracks per-stage timings (`lodMs`, `objectsMs`, `behaviorMs`, `steeringMs`, `physicsMs`, `renderMs`, `selectionMs`, `updateMs`) and counts (visible/sim/rendered/bodyOnly/armsActive/shadowCasters/ikFull/ikCheap/instanced* /tiers), consumed by `environment-viewer.html`'s debug HUD and `frame-profiler.js`.
- **External terrain/forest hookup**: `terrainHeight`, `resolveTrunks`, `nearbyTrunks` are injected dependencies from the shared environment systems (`terrain-system.js`, `collision.js`) rather than the standalone app's own closed-form terrain function.
- **Mode toggle**: `port-creature-bridge.js`'s `update(dt)` supports a `mode: 'off'` short-circuit that hides all creature groups and zeroes every stat field without calling into the sim at all, for cheaply disabling creatures via the `?creatures=` URL flag.

## Tunable parameters

`environment-ui.js` does not define its own creature-specific numeric sliders. It only:
- Relocates the creature system's own DOM panel (`#port-creature-ui`, built by `ensurePortCreatureUi()` in the bridge) into the workshop UI's "Creatures" panel host (`environment-ui.js:488-489`).
- Surfaces read-only creature perf stats in its debug snapshot/HUD: `creatureVisible`, `creatures`, `creatureRendered` (`environment-ui.js:618`) and a `passCreaturesMs` frame-profiler entry (`environment-ui.js:3`).

The actual tunables live in the creature system's own toolbar/panels (built in `port-creature-bridge.js`'s `CREATURE_UI_HTML`/`CREATURE_UI_STYLE` and populated dynamically by `port-creature-system.js`'s `renderOptions()`/`renderModelOptions()`/random-group functions): Preset, Gait, Count, Objects, Team Size, Mode (behavior), Scene (uniform/varied), Seed, Debug toggle, plus the Gait Controls / Model + Terrain panels and the lettered randomize-group buttons (S/G/M/A/T) inherited from the original app's `RANDOM_GROUPS` system.

## Tests

No dedicated test file exists for this subsystem in `workshop-webgpu`. The repo root contains test files for terrain, grass, forest, collision, light-cluster, post-grade, sky, particle-field, frame-profiler, and CDLOD systems (e.g. `test-collision.mjs`, `test-forest-cull.mjs`, `test-terrain-system.mjs`), but none named `test-creature*.mjs` or covering `port-creature-bridge.js` / `port-creature-system.js`.
