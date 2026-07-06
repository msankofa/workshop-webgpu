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
- **Per-creature perf caches** (Phase 1 of `creature-perf-analysis/plan.md`): several values that are constant after construction are precomputed in the `Creature` constructor (after `this.legs`/`this.arms` are built) instead of being recomputed on the hot path: `_collisionRadius`/`_maxArmReach`/`_meleeRadius` (the `collisionRadius()`/`maxArmReach()`/`meleeRadius()` methods are now thin accessors over these), and per-leg partner topology (`leg.adjacentPartnersCached`/`diagonalPartnersCached`/`rowMateCached`/`crossRowsCached`, consumed by `canWalkLegMove`/`canGallopLegMove`). If legs/arms ever become mutable at runtime these caches must be rebuilt. Two per-frame render optimizations also rely on per-leg fields: `leg._hipWorld` (reused `localToWorld` target) and a cached `leg._footQuat` foot orientation that is only recomputed when the foot moves or the creature turns (`_normSampleX/_normSampleZ/_normYaw`). The second `applyBodyTerrainClearance()` pass in the fixed-step loop now runs only for creatures flagged `_collisionMoved` by `resolveCreatureCollisions` (physicsStep still clears every simmed creature once). Phase 2 adds more pooling on the same hot paths: per-arm scratch vectors (`arm._shoulderWorld/_restWorld/_localScratch/_pointScratch/_carryWorld`) replace the `.clone()` calls in `renderArms`/`armRestTarget`/`constrainArmTarget`/`constrainArmPoint` (combat-punch and `chooseArmObject` clones are deliberately left as-is), and `convexHull` now writes the support polygon into a module-scope pooled buffer (`_hullOut`, via reused `_hullP/_hullLo/_hullUp`) instead of allocating arrays per fixed step.

## Tunable parameters

`environment-ui.js` does not define its own creature-specific numeric sliders. It only:
- Relocates the creature system's own DOM panel (`#port-creature-ui`, built by `ensurePortCreatureUi()` in the bridge) into the workshop UI's "Creatures" panel host (`environment-ui.js:488-489`).
- Surfaces read-only creature perf stats in its debug snapshot/HUD: `creatureVisible`, `creatures`, `creatureRendered` (`environment-ui.js:618`) and a `passCreaturesMs` frame-profiler entry (`environment-ui.js:3`).

The actual tunables live in the creature system's own toolbar/panels (built in `port-creature-bridge.js`'s `CREATURE_UI_HTML`/`CREATURE_UI_STYLE` and populated dynamically by `port-creature-system.js`'s `renderOptions()`/`renderModelOptions()`/random-group functions): Preset, Gait, Count, Objects, Team Size, Mode (behavior), Scene (uniform/varied), Seed, Debug toggle, plus the Gait Controls / Model + Terrain panels and the lettered randomize-group buttons (S/G/M/A/T) inherited from the original app's `RANDOM_GROUPS` system.

## Second creature system: the ClaudeCraft mob simulation

The viewer runs a **second, fully independent creature system** alongside the IK
`port-creature-system.js` one: the vendored **World of ClaudeCraft** deterministic mob
simulation. The two systems share **no code** and never touch each other's state. They
coexist only by (a) both drawing into the same `scene` and (b) both contributing entries to
the same host-authoritative multiplayer snapshot. The IK creatures are untouched by this work.

### What it is

ClaudeCraft's `src/sim/` is a pure, engine-free TypeScript core (zero Three.js imports, fixed
20 Hz tick, all randomness through a seeded `Rng`) that spawns a families-based mob roster
(beasts, spiders, mudfins, burrowers, humanoids, trolls, ogres, undead, elementals, dragonkin,
demons) and drives their AI/movement/combat. It is host-authoritative and deterministic, which
matches the workshop's existing "host simulates, guests interpolate ghosts" model exactly.

### Files

**Vendored sim (TypeScript, bundled):**
- `claudecraft-sim/` — verbatim copy of ClaudeCraft `src/sim/`, edited only for three injected
  seams: `world.ts` (`setHeightProvider`/`setWaterLevelProvider`, `nearSteepWalls` disabled),
  `colliders.ts` (`setExternalColliderResolver`), `sim.ts`+`types.ts` (external-player support:
  `PlayerMeta.external`, `setPlayerPose`, `reviveExternalPlayer`, movement integration skipped
  for external players). Entry: `claudecraft-sim/sim-entry.ts`.
- `claudecraft-sim.bundle.js` — **committed** esbuild output (`npm run build:claudecraft-sim`).
  Exports `Sim`, `MOBS`, `createMob`, `setActiveWorldContent`/`getActiveWorldContent`,
  `setHeightProvider`, `setWaterLevelProvider`, `setExternalColliderResolver`.

**Bridge (plain JS, in `claudecraft-bridge/`, unit-tested):**
- `sim-scale.js` — `makeScale(workshopPlayerHeight)` → `{ SCALE, toWorld, toSim }`. One scale
  factor `SCALE = workshopPlayerHeight / 2.6` (the sim humanoid reference height in yards). The
  sim runs entirely in yard-space; conversion happens only at the bridge boundary.
- `sim-world-content.js` — `buildClaudecraftWorldContent(...)` builds a minimal `WorldContent`
  (one flat zone, camps converted from workshop coords to sim yards, no NPCs/props/doors).
- `sim-mob-snapshot.js` — `serializeMobs(entities, scale)` → wire shape
  `{ id, tid, p:[x,y,z], q:[x,y,z,w], hp:0..1, dead }` (yards → world, hp normalized, pure-yaw quat).
- `claudecraft-creatures.js` — the top-level factory `createClaudecraftCreatures(...)`. Owns the
  `Sim`, the fixed-20 Hz step loop (spiral-of-death guarded: clamp dt to 0.25 s, max 5 catch-up
  steps/frame), wires the three seams, mirrors player poses in, and reads combat back out. Also
  exposes the **player-combat facade adapter** surface (`ensurePlayer`, `getPlayerCombat`,
  `damagePlayer`, `revivePlayer`, `removeExternalPlayer`) that `player-combat.js` delegates to.

**Render adapter (plain JS, in `claudecraft-render/`):**
- `anim_state.js` — verbatim port of ClaudeCraft `render/characters/anim_state.ts`
  (`desiredBaseState`/`locomotionTimeScale`, pure/three-free).
- `manifest.js` — mob-scoped port of `manifest.ts`: ClipMap factories, the `VISUALS` table for
  every key a mob can resolve to, and `visualKeyForMob(tid)` (via `MOBS[tid].family`). Asset base
  repointed to `claudecraft-assets/models/`. Players/npcs/weapon-attach/skins/tints are out of scope.
- `visual.js` — `createClaudecraftVisuals({ scene, worldScale })`: per-mob GLB `CharacterVisual`
  using the workshop's `GLTFLoader` + `SkeletonUtils.clone` + `AnimationMixer`, driving idle/walk/run
  crossfades under the r184 WebGPU backend. Async, guarded: a mob keeps its placeholder box until
  its GLB resolves (or forever, if load fails). `dispose()` releases only the clone's mixer/skeleton.
- `claudecraft-assets/models/` — copied GLBs (creatures/enemies/players/weapons).

### The three injected seams

1. **Terrain height** — `setHeightProvider` repoints the sim's `terrainHeight`/`groundHeight` at the
   workshop's real `terrainHeight(x,z)` (procedural AND authored maps), round-tripping through
   `toWorld`/`toSim`. Downstream `terrainSteepness`/`downhill`/`nearSteepWalls` follow automatically.
2. **Collision** — `setExternalColliderResolver` consults `trunkIndex.resolve` (from `collision.js`)
   after the sim's own prop resolution, so mobs slide around workshop tree trunks.
3. **Players** — each workshop player is mirrored into the sim as an `external` player entity whose
   position is written in each tick while the sim owns its combat (HP/threat/death) and does NOT
   integrate its movement. The local player maps to the sim's primary player; remote guests are added
   as external sim players so host-side mobs aggro them too.

### Scale model

`SCALE = workshopPlayerHeight / 2.6`. Applied at exactly four boundaries: the terrain-height
provider, the collider provider, mob render transforms (`visual.js` `worldScale`), and player-pose
mirroring + spawn placement. The sim never sees `SCALE`. Runtime rescale of a running sim is out of
scope (changing player size would require rebuilding the sim).

### Wiring in `environment-viewer.html`

- Static imports: `createClaudecraftCreatures` (`claudecraft-bridge/claudecraft-creatures.js`) and
  `createClaudecraftVisuals` (`claudecraft-render/visual.js`).
- Construction (after `portCreatures`, host/solo only via `if (mpRole !== 'guest')`):
  `claudecraftCreatures = createClaudecraftCreatures({ workshopPlayerHeight: capsuleH, terrainHeight,
  waterLevelWorld: terrain.waterLevel, trunkResolve: (x,z,r)=>trunkIndex.resolve(x,z,r), camps, ... })`
  then `claudecraftVisuals = createClaudecraftVisuals({ scene, worldScale: claudecraftCreatures.scale.SCALE })`.
- Per-frame (profiled under `'claudecraft'`, right after the `'creatures'` pass): mirror the local
  player pose (`getLocalPlayerWorldPose()`, built from `getLocalPlayerState('host')` + camera yaw) and
  the remote guest poses (`remoteClaudecraftPlayers()`), step the sim, drive `claudecraftVisuals.update`
  (returns the set of mob ids with a live GLB), draw placeholder boxes for the rest, then
  `applyClaudecraftCombatToPlayer(now)`.
- **Combat**: `player-combat.js`'s facade is constructed delegated to a lazy adapter
  (`claudecraftCombatAdapter`) forwarding to the bridge, so gun damage and mob damage share ONE player
  HP pool owned by the sim. The HUD (`localHudState` → `mergePlayerCombatFields` → `playerCombat`)
  therefore shows mob damage automatically. `applyClaudecraftCombatToPlayer` handles the death edge
  (no dedicated respawn screen exists: it shows a status line and auto-revives at the current pose
  after `CC_RESPAWN_MS`).
- **Multiplayer**: `getState()` publishes `mobs: claudecraftCreatures.mobs()` (world-space wire shape).
  `multiplayer.js` `InterpolationBuffer._lerpMobs` matches mobs by id (lerp p/hp, slerp q, carry
  tid/dead) and `GhostRenderer` renders guest mob boxes. Guests never construct or step the sim; they
  receive mobs inside `sim_state` and render the interpolated snapshot. Guest→host aggro works because
  `guest_joined` → `playerCombat.ensurePlayer(clientId)` adds the guest as an external sim player.

### Tests

`node test-claudecraft-scale.mjs`, `test-claudecraft-worldcontent.mjs`, `test-claudecraft-seams.mjs`,
`test-claudecraft-mob-snapshot.mjs`, `test-claudecraft-boot.mjs`, and the mob-interpolation block in
`multiplayer-test.mjs` all run headless in `node`. The in-page render/combat/replication paths (M5/M6)
require the browser and are verified manually (see the plan's "Manual verification" steps).

## Tests

No dedicated test file exists for this subsystem in `workshop-webgpu`. The repo root contains test files for terrain, grass, forest, collision, light-cluster, post-grade, sky, particle-field, frame-profiler, and CDLOD systems (e.g. `test-collision.mjs`, `test-forest-cull.mjs`, `test-terrain-system.mjs`), but none named `test-creature*.mjs` or covering `port-creature-bridge.js` / `port-creature-system.js`.
