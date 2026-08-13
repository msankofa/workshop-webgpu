# Bot port performance review — why N bots tank the frame rate

Scope: Bug #2 from the bot-port investigation — "bots are a massive performance sink,"
far more expensive than the IK creatures (`port-creature-system.js`). This is a
read-only code audit, no profiler run; all costs below are derived from reading the
actual per-frame call graph and counting allocations/draw calls/iterations.

## TL;DR

The bot FSM/pathing code itself (`bot-entity.js`, `bot-activity.js`, `nav-grid.js`)
is cheap and mostly allocation-free — it was clearly written with performance in
mind. **The cost is almost entirely in how bots are *rendered*.** Each bot does not
reuse the creature system's instanced-draw pipeline at all. Instead every bot gets:

1. its own full `createProceduralPlayerBody` rig (the same IK body used for the
   human player/multiplayer ghosts) — unique geometries, unique materials, ~18-20
   individual `THREE.Mesh` objects, a per-frame gait solve, and 4 independent
   12-iteration FABRIK chains, and
2. its own independently GLTF-loaded weapon model with a *second*, separate
   per-frame IK pass (`weapon-pose-controller.js`) to place hands on the grip.

Where creatures render N bodies through ~8 shared `InstancedMesh` batches (a
constant number of draw calls, no per-creature mesh/material, no per-creature IK
convergence loop beyond the lightweight `KinematicChain` also used here), bots
render N bodies as N *entirely separate, fully unique 3D character rigs* — the
architecture of a "handful of remote multiplayer players," reused unmodified for
"dozens of AI-controlled entities." That mismatch, not the FSM/pathfinding logic,
is why bots don't scale.

## 1. Per-frame-per-bot cost breakdown

Every bot, every frame, host/solo tick (`updateBots`, `environment-viewer.html:2558`):

| Stage | Function | file:line | Cost per bot per frame |
|---|---|---|---|
| FSM decide + aim/fire | `botTickOne` | `environment-viewer.html:2240` | cheap: a handful of scalar ops, `nearestBotCandidate` scans host+guests (small, not bot count) |
| Line-of-sight | `pickBotTarget` → `botHasLineOfSight` | `environment-viewer.html:1907, 1870` | throttled to once/120ms per bot via `BOT_LOS_CHECK_INTERVAL_MS`, but on the ticks it runs: builds a fresh `obstacleColumnsAlongRay` array + `Set` (`environment-viewer.html:8281-8306`) and runs `resolveHitscan` |
| Threat propagation | `propagateBotAlert` | `environment-viewer.html:1951-1958` | **O(N) scan of every other bot**, run unconditionally every tick a bot has a visible target (not just on new alerts) — see offender #5 |
| Movement/pathing | `botTickMovement` → `requestBotPath`/`followBotPath` | `environment-viewer.html:2154, 2049` | cheap when following an existing path; **rebuilds an entire local A* grid from scratch** (~576 cells) whenever a fresh path is needed — see offender #4 |
| Physics | `stepBotPhysics` | `bot-entity.js:41` | cheap, one capsule-vs-BVH resolve |
| Pairwise separation | `pushBotsApart` (once per tick, not per bot, but O(N²)) | `environment-viewer.html:1991` | rebuilds a filtered+mapped array of all live bots from scratch every tick, then does the O(N²) pass |
| **Ghost/body render sync** | `updateHostPlayerGhosts` → `GhostRenderer._updatePlayers` → `_updateProceduralBody` → `createProceduralPlayerBody().update()` | `environment-viewer.html:585-595`, `multiplayer.js:465-581`, `player-procedural-body.js:965-1206` | **by far the largest cost** — see offenders #1/#2 below |
| **Weapon mount sync** | `syncEnvironmentBotWeaponMounts` → `updateEnvironmentBotWeaponMount` | `environment-viewer.html:7941, 7894` | a **second** full IK pass per bot per frame — see offender #3 |

## 2. How it scales with N

- **Draw calls**: linear in N, and large-constant per bot (see §3.1) — this is the
  opposite of creatures, which stay at a constant ~8 draw calls regardless of N.
- **CPU per-frame work**: linear in N for the body/gait/FABRIK/weapon-IK stack
  (§3.1/§3.2), which dwarfs everything else per bot.
- **GC pressure**: linear in N, multiple heap allocations per bot per frame (§3.1,
  §3.4, §3.7) — with 30 bots at 60fps this is hundreds of short-lived objects/arrays
  per second, causing GC pauses on top of the raw CPU cost.
- **Quadratic in N**: `propagateBotAlert` (§3.5) and `pushBotsApart` (§3.6) are
  O(N²), but at the bot counts described (~30) these are individually cheap
  (≤900 iterations) — real but not the dominant term. They matter mainly because
  `propagateBotAlert` runs on **every** tick a bot can see the player (i.e.
  continuously during any firefight), not just on state transitions.
- **Path-rebuild cost**: not per-frame-per-bot, but per-path-request-per-bot; scales
  with how often bots reach waypoints/replan, which itself scales with N (more bots
  patrolling/seeking → more concurrent path requests → more full grid rebuilds per
  second).

## 3. Ranked list of offenders

### #1 — Every bot gets a full, unshared procedural-body rig (biggest offender)

`multiplayer.js:531-539` (`GhostRenderer._updateProceduralBody`) calls
`createProceduralPlayerBody({ ... style: item.isBot ? {...} : {} })` lazily the
first time a bot is seen, and it is invoked identically for **bots** and **remote
human players** — the code has no bot-specific "cheap" path at all.

`player-procedural-body.js:538-541` creates 4 **brand-new, per-instance**
`THREE.MeshStandardMaterial`s (`shellMat`, `plateMat`, `trimMat`, `eyeMat`) — not
shared across bots, so even identical-looking bots can never batch.

`player-procedural-body.js:596-700` builds the mesh hierarchy per instance:
`pelvis`, `waist`, `torso`, `neck`, `head` (5 `LatheGeometry`/`CylinderGeometry`
meshes), 2 eyes (`SphereGeometry`), 2 legs × (upper + lower + foot = 3 meshes) = 6,
2 arms × (upper + lower + hand = 3 meshes) = 6. **~19 unique `THREE.Mesh` objects,
each with its own freshly-tessellated geometry**, created at bot-spawn time. None
of this is pooled or shared — 30 bots means 30× everything here (~570 unique
meshes/geometries versus a fixed ~8 `InstancedMesh` batches for the entire
creature population, see §4).

Per-frame cost (`update()`, `player-procedural-body.js:965-1206`), run once per
bot per frame:
- `gait.update()` — foot-step planning, includes `terrainNormal()`
  (`player-procedural-body.js:514-521`) which samples `terrainHeight()` **4 times**
  via finite differencing whenever it runs.
- 2× `solveLeg` + 2× `solveArm`, each driving a `KinematicChain.solve()`
  (`player-procedural-body.js:472-511`) with `maxIterations = 12`
  (`player-procedural-body.js:460`) — up to **48 FABRIK iterations per bot per
  frame** (each iteration does several `Vector3` ops: `subVectors`, `normalize`,
  `addScaledVector`, `distanceToSquared`).
- **Allocations inside the per-frame hot path**, despite the file otherwise
  carefully pre-allocating ~30 scratch `Vector3`/`Quaternion` objects per instance
  (`player-procedural-body.js:792-820`) precisely to avoid this: `update()` itself
  calls `new THREE.Vector3(...)` at **lines 1169, 1170, 1184, 1185, 1195** — 4 of
  those inside the 2-iteration leg/arm side loops, so **~6 fresh Vector3 objects
  every bot every frame**, none of them reused. At 30 bots × 60fps that's ~10,800
  throwaway `Vector3` allocations/sec just from this one function.

Estimated cost: this single subsystem is likely 80%+ of the "bots are slow" symptom
— it is a full player-character animation rig (materials + geometry + FABRIK +
allocations) multiplied by the bot count, where the intended use (`multiplayer.js`)
was "a handful of remote human players," not "up to dozens of AI bots."

### #2 — Zero draw-call sharing / no instancing for bot bodies

Direct consequence of #1: with N bots each owning ~19 unique meshes (body) + the
weapon rig meshes (#3), the renderer issues **on the order of N × 20-25 draw calls**
for bots alone. At 30 bots that's 600-750+ draw calls just for bot visuals, before
terrain/vegetation/water/lighting. Compare directly to creatures in §4.

### #3 — A second, independent per-bot weapon-IK system, plus per-bot GLTF loads

`environment-viewer.html:7769` `createEnvironmentBotWeaponMount` does
`await new GLTFLoader().loadAsync(def.model)` (`environment-viewer.html:7796`) —
**once per bot, with no cache/sharing across bots**. Every bot that equips a weapon
triggers its own network fetch + GLTF parse + fresh `BufferGeometry`/materials for
what is very likely the *same* weapon model file every other bot is also loading.
30 bots spawning together means 30 concurrent GLTF loads/parses of duplicate
geometry, each producing its own GPU buffers.

Per-frame (`updateEnvironmentBotWeaponMount`, `environment-viewer.html:7894-7939`),
run once per bot per frame:
- `mount.controller.update(dt, ...)` (`weapon-pose-controller.js`, via
  `createWeaponPoseController`) — a **second, independent IK pass** placing the
  bot's hands on the weapon grips, on top of the body's own arm FABRIK solve in #1.
  When aiming (`lockAimedPosition`), it's called **twice** in the same frame
  (`environment-viewer.html:7934-7937`, the second call to resolve hands after
  `alignEnvironmentBotWeaponToPoint` reorients the gun).
- `new THREE.Euler(...)` allocated fresh every bot every frame at
  `environment-viewer.html:7920` (`mount.weaponAdjust.quaternion.setFromEuler(new
  THREE.Euler(...mount.def.thirdPersonHold.rotation))`) instead of reusing a scratch
  Euler.
- `alignEnvironmentBotWeaponToPoint` (`environment-viewer.html:7872-7884`) allocates
  a `new THREE.Vector3(...)` and `new THREE.Quaternion()` every call while aiming.

### #4 — `requestBotPath` rebuilds a full local A* grid from scratch per request

`environment-viewer.html:2049-2086`. On any map without a static baked nav grid
(i.e. any open/authored terrain map — shoot-house is the only map with a pre-baked
`botNavGrid`, see `environment-viewer.html:1774-1777`), every time a bot needs a
new path it calls `buildNavGrid(botTerrainWalkable, bounds, BOT_LOCAL_NAV_CELL)`
(`environment-viewer.html:2068`) — a **fresh ~24×24 = 576-cell grid**
(`BOT_LOCAL_NAV_RADIUS=18`, `BOT_LOCAL_NAV_CELL=1.5`,
`environment-viewer.html:1683-1686`), where every cell runs `botTerrainWalkable`
(`environment-viewer.html:1746-1760`): 2 `terrainHeight()` slope samples, a
`trunkIndex.resolve()` spatial query, a `dressingIndexRef.resolve()` spatial query,
and a (cached-after-first-hit) `botMeshBlockedAt()` BVH capsule test. This is not
gated per-frame, but it *is* gated per-path-request, and paths get consumed and
re-requested continuously as patrol waypoints are reached
(`environment-viewer.html:2213-2230`) or a seek/target changes
(`environment-viewer.html:2159-2162`). With N bots simultaneously patrolling on an
open map, this is N independent 576-cell A* grid rebuilds scattered across frames,
each with 2×576 spatial-index queries — the nav-grid module's own docstring
(`nav-grid.js:8`) explicitly assumes "one grid per loaded map, built once and
cached... not regenerated per bot or per frame," which the open-terrain path
directly violates by construction (per the comment at
`environment-viewer.html:2043-2048`, this was a deliberate tradeoff for map size,
but it's still a real per-bot recurring cost that scales with bot count).

### #5 — `propagateBotAlert`: O(N) scan run every tick per bot-with-visible-target

`environment-viewer.html:2254` calls `propagateBotAlert(rec, ...)` unconditionally
whenever `targetVisible` is true for that bot — not just when a *new* alert fires.
`propagateBotAlert` (`environment-viewer.html:1951-1958`) then iterates **every
other bot** (`for (const other of botPlayers.values())`) computing a distance check.
Result: during any firefight where multiple bots can see the player at once, this
is O(N²) every tick (not amortized/throttled at all, unlike the LOS raycast in
offender-adjacent `pickBotTarget`). At 30 bots this is ≤900 iterations/tick — not
huge in isolation, but it's continuous (every tick of combat, not once per event)
and stacks on top of everything else.

### #6 — `pushBotsApart`: O(N²) plus a fresh array allocation every tick

`environment-viewer.html:1991-2021`. Two issues: (a) the O(N²) pairwise
separation pass itself (the code's own comment at `environment-viewer.html:1987-1989`
assumes N is "capped at 10," but the reported repro is ~30 bots — 3x past the
assumption baked into "trivial even every frame"); (b) line 1992,
`[...botPlayers.entries()].filter(...).map(...)`, **allocates a brand-new array
every single tick** regardless of whether any bots actually need separating.

### #7 — Per-frame ghost-state allocation in `updateHostPlayerGhosts`

`environment-viewer.html:585-595`, called every `updateBots` tick. Line 591:
`[...botPlayers.entries()].map(([id, rec]) => ({ ...botToWirePose(rec.bot), alive:
... }))` — allocates a new array **and** a new object per bot per frame (the
object-spread `{...botToWirePose(rec.bot), alive}`). `botToWirePose`
(`bot-entity.js:69-87`) itself allocates a `Vector3.clone()`
(`bot-entity.js:72`) plus 3 new plain arrays (`p`, `q`, `velocity`,
`bot-entity.js:75-82`) every call. With N bots this is `4×N` heap allocations every
frame purely to shuttle position/rotation data into the renderer, with no pooling.

### #8 (minor) — `obstacleColumnsAlongRay` allocates per LOS check

`environment-viewer.html:8281-8306`. Throttled to once/120ms per bot (via
`BOT_LOS_CHECK_INTERVAL_MS`, `environment-viewer.html:1898`), so not a top offender,
but each call allocates a fresh `cols` array, `seen` `Set`, and `scratch` array —
worth pooling if LOS checking is ever un-throttled or the interval shortened.

## 4. Why creatures are cheap by comparison

`port-creature-system.js:838-930` (`createCreaturePartBatches`) builds **exactly 8
`THREE.InstancedMesh` batches at startup** — `shellBox`, `plateBox`, `trimBox`,
`lightBox`, `footBox`, `jointSphere`, `limbSegment`, `shadowBox`
(`port-creature-system.js:846-856`) — each with one shared `BufferGeometry` and one
shared `Material`, sized to a fixed `capacity` (default 4096 instances). Every
creature, every frame, does not create or destroy any mesh/material/geometry: it
calls `add(bucketName, matrix, color, owner)` (`port-creature-system.js:878-886`),
which just writes a computed `Matrix4` into the next free instance slot
(`mesh.setMatrixAt`) and an optional per-instance color. `endFrame()`
(`port-creature-system.js:922-928`) flips `needsUpdate` once per batch.

Net effect: **N creatures → the same constant ~8 draw calls**, no per-creature
material/geometry, no per-creature GLTF load, and the only per-creature CPU cost is
matrix math into a pre-sized typed-array buffer (plus creatures' own
`KinematicChain` FABRIK solves for legs/arms — the same solver class bots use, so
that part of the cost is actually comparable per-limb; the difference is entirely
in the *rendering* representation, not the IK math itself). There is no per-creature
weapon GLTF load, no per-creature IK-hands-on-weapon second pass, and no per-frame
array/object churn analogous to `updateHostPlayerGhosts`/`botToWirePose`.

Bots, by contrast, render through `GhostRenderer` — a class designed for "a
handful of remote multiplayer humans" (per its own doc comment,
`multiplayer.js:383-389`) — with `useProceduralBody: true` giving every entity a
full unshared character rig. The bot port reused this path wholesale
(`environment-viewer.html:1635-1639`: "reusing the human combat/player pipeline as
-is") instead of routing bot visuals through the creature system's instanced-batch
renderer. That architectural choice — one full unique character rig + one
independently-loaded weapon rig per bot, versus a shared instanced-batch pool per
body-part-type — is the entire story of why bots cost so much more than creatures
per entity.

## Suggested priority for a fix pass (not implemented here, read-only review)

1. Move bot body rendering onto an instanced/shared-geometry pipeline (reuse the
   creature system's batch approach, or at minimum share geometries/materials
   across all bot rigs and cut FABRIK iteration count / update frequency).
2. Cache the weapon GLTF load once per `weaponId` and clone/reuse a shared skinned
   mesh (or instance it) across all bots holding the same weapon, instead of one
   `GLTFLoader().loadAsync()` per bot.
3. Cache/reuse the local A* nav grid per bot (or a shared grid keyed by map region)
   instead of rebuilding a fresh 576-cell grid on every path request.
4. Throttle or restructure `propagateBotAlert` so it isn't a full O(N) scan run
   unconditionally every tick of every engaged bot.
5. Pool the per-frame allocations in `updateHostPlayerGhosts`/`botToWirePose` and
   the stray `new THREE.Vector3()`/`new THREE.Euler()` calls inside
   `player-procedural-body.js:update()` and the weapon-mount sync path.
