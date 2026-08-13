# Agent 4: env-viewer integration seam for combat bots

Scope: how bots are instantiated/updated/rendered inside `environment-viewer.html`, where that
wiring diverges from the `bot-viewer.html` harness, and how it compares to the creature bridge
(`port-creature-bridge.js` / `port-creature-system.js`) as a model of a port that stayed cheap and
correct. All line numbers are current-tree (`sp1-webgpu-renderer-migration`).

## 1. The integration path: spawn -> update -> render

**No mode flag, no lazy import, no adapter module.** Unlike every other subsystem in this repo
(`GRASS_MODE`, `CREATURE_MODE`, `DRESSING_MODE`, ...), bots have no gating flag and no
`port-bot-bridge.js`. `bot-entity.js`, `bot-activity.js`, and `nav-grid.js` are statically imported
at the top of `environment-viewer.html` (`:78`, `:82-83`) and roughly 1,700 lines of spawn/FSM/nav/
weapon-mount/inspector/stats-logging code live inline in the file itself (`:1634` "Combat bots"
section through `:7943`). `docs/subsystems/bots.md:49` calls this out explicitly: "the live wiring
... no new files" was the actual design decision, not an oversight — but it means there is no
seam where a shared-resource adapter (the creature bridge's role) could have been inserted later
without touching call sites scattered across the whole file.

**Spawn** (`spawnBotAt`, `environment-viewer.html:1788-1817`): `createBotEntity(id, {x,y,z})` from
`bot-entity.js` builds a bare capsule + velocity + yaw/pitch state object — no mesh, no geometry,
no material. It's inserted into `botPlayers` (a `Map`) alongside the FSM/pathing bookkeeping, and
registered with `playerCombat.ensurePlayer` so it participates in the human-combat pipeline
(`docs/subsystems/bots.md:52-59` — "combat is player-id-generic", the one part of this port that
*did* generalize cleanly).

**Update** (`updateBots(dt)`, `:2558-2598`, called once per rendered frame from `animate()` at
`:9249`: `frameProfiler.time('bots', () => updateBots(rawDt))`): this is the **render loop**, not a
fixed-timestep sub-loop. `rawDt` is `Math.min(clock.getDelta(), 0.1)` (`:9055`) — the same clamped
per-frame delta the sky/creature/claudecraft systems get, and notably *not* the FPS player's
`STEPS_PER_FRAME`-substepped fixed timestep (`:9092-9099`) used for `updateFPSPlayer`. Per bot,
`botTickOne` (`:2240-2348`) drives target acquisition, FSM transitions, `stepBotPhysics` (gravity +
capsule/BVH resolve), stuck detection, then `updateSquads()`, `pushBotsApart()` (O(n^2) pairwise
capsule correction), `updateHostPlayerGhosts()`, and `syncEnvironmentBotWeaponMounts(dt)` run once
per tick after the per-bot loop.

**Render**: bots have no dedicated bot-mesh code path. Their capsule pose is converted via
`botToWirePose` (`bot-entity.js:69-87`) into the same wire-pose shape a networked human player
uses, pushed into `mpGhostRenderer.update({ players: [...guestPoses, ...botPoses] })`
(`updateHostPlayerGhosts`, `:587-595`), and rendered by `GhostRenderer` (`multiplayer.js:378+`) —
the exact class that renders **remote human players** over the network. Each bot gets a full
`createProceduralPlayerBody({ mode: 'remote', ... })` instance
(`multiplayer.js:528-540`/`_updateProceduralBody`), created lazily the first time
`_updatePlayers` sees that id and cached on `g.userData.bodyProc` for the group's lifetime. On top
of that, weapon visuals are a **second, entirely separate mount system**
(`createEnvironmentBotWeaponMount`, `:7769-7846`) that is not part of `GhostRenderer` at all — the
comment at `:7743-7745` says as much: "This is not a GhostRenderer feature: each mount belongs to
a live bot body and is created, updated, and destroyed from the bot lifecycle."

## 2. Where the wiring diverges from `bot-viewer.html`

The harness (`bot-viewer.html`) only ever manages **one bot** (`spawnBot`, `:556-572`, id
`'bot-1'`) plus one WASD dummy. Its weapon-mount code
(`createBotWeaponMount`/`updateBotWeaponMount`, `:409-522`) was copy-pasted almost verbatim into
`environment-viewer.html`'s `createEnvironmentBotWeaponMount`/`updateEnvironmentBotWeaponMount`
(`:7769-7939`) — same GLTF-load-and-bake sequence, same `weaponRig`/`weaponAdjust`/`weaponFrame`/
`weaponView` group nesting, same `torso`-relative Y-offset math, same aim-lock/re-solve-twice
pattern at the end of `updateEnvironmentBotWeaponMount` (`:7933-7938`). This is a faithful "drag
and drop" port of the single-bot code, per the wiring comment at `:1638` — but it was **never
adapted for the N-bot case**, and that gap is the wiring's core defect:

- **No shared weapon-model cache for bots.** `createEnvironmentBotWeaponMount` calls
  `new GLTFLoader().loadAsync(def.model)` fresh, uncached, **per bot, per mount** (`:7796`) — an
  exact copy of the harness's `createBotWeaponMount` (`bot-viewer.html:435`). At n=1 this is
  invisible. At n>1 (round-mode target up to 10 via the panel slider, `:4837`
  `targetInp.max = 10`; squads spawn `SQUAD_MIN_SIZE=5` at once, `:1654`; a 20-bot session is
  documented as tested in `docs/subsystems/bots.md:467`) it means every squad/round batch that
  shares a weapon triggers that many concurrent, independent fetches + GLTF parses + fresh
  geometry/material allocations of the *same* GLB file, with nothing disposed or reused between
  bots.
  This is a **self-inflicted regression relative to code sitting 90 lines above it in the same
  file**: `buildLocalWeaponMount` (`:7681-7736`, the local player's third-person weapon mount)
  *does* cache the loaded, normalized template in `lbWeaponModelCache` (`:7609`, a
  `Map<weaponId, Group>`) and clones it per-mount via `skeletonClone` (SkeletonUtils.clone, needed
  because a plain `Object3D.clone(true)` doesn't rebind `SkinnedMesh -> Skeleton` — this exact bug
  was already found and fixed for the local player on 2026-07-10, see `agent_log.csv` row
  `2026-07-10T18:05`: "Fix m1911 ... being invisible in-game ... clone sites now use
  SkeletonUtils.clone"). The bot mount code, written **four days later** (`agent_log.csv`
  `2026-07-14T10:30`), reused neither the cache nor the clone call. `createEnvironmentBotWeaponMount`
  loads `gltf.scene` directly (`:7798`) with no clone at all — each bot gets its own freshly
  parsed original, so it doesn't hit the *specific* skinned-mesh-clone bug, but it inherits none of
  the memory/parse-cost savings the local-player path already proved out, and — see next point —
  none of its failure-recovery either.

- **No throttled retry on a failed/slow mount, unlike the local player's path.** In
  `updateEnvironmentBotWeaponMount` (`:7894-7907`): if `mount` is falsy (still loading, or the
  previous attempt failed/bailed), the branch at `:7903-7907` calls
  `requestEnvironmentBotWeaponMount` again **every single frame** with no backoff. Contrast with
  `initLocalWeaponMount` (`:7668-7680`), which on failure sets `lbWeaponMountRetryAfter =
  performance.now() + 800` and the call site at `:9176` gates the next attempt behind
  `performance.now() >= lbWeaponMountRetryAfter`. `requestEnvironmentBotWeaponMount`
  (`:7848-7856`) only dedupes a request that is **currently in flight** (`pending?.bodyRef ===
  bodyRef && pending.weaponId === weaponId`); once that promise settles — success or failure —
  `botVisualWeaponMountRequests.delete(id)` runs in the `.finally()`, clearing the guard. If the
  GLTF load is failing repeatedly for any bot (bad token race, transient fetch failure, or simply
  enough concurrent squad-mount contention that a `token` check on `:7778`/`:7797` invalidates a
  slow in-flight load — `botVisualWeaponMountTokens` is bumped by `destroyEnvironmentBotWeaponMount`
  and by every new `requestEnvironmentBotWeaponMount`), that bot **re-issues a full,
  network+parse-cost GLTFLoader().loadAsync() every frame, forever**, which both worsens the perf
  picture and keeps that bot's weapon (and, see below, arms) permanently invisible.

- **Arms depend on the same mount.** `player-procedural-body.js:1182` — arms render an "idle stub
  pose; weapon track drives via `setArmTarget`". The hand/arm IK targets are set by
  `weapon-pose-controller.js`'s `controller.update()`, which only exists once
  `createEnvironmentBotWeaponMount` has resolved and attached a `controller` to the mount
  (`:7824-7836`). While a bot has no mount — during the initial async load window, or forever if
  stuck in the frame-by-frame retry loop above — `syncEnvironmentBotWeaponMounts` /
  `updateEnvironmentBotWeaponMount` returns early at `:7899-7902` and never calls
  `mount.controller.update()`, so the body's arms stay in that idle stub pose while the weapon
  itself is simply absent (`weaponRig` was never created, or is hidden). This is the direct
  wiring-level mechanism for the reported "invisible arms/weapons" symptom: both are downstream of
  the same never-resolved (or never-retried-with-backoff) per-bot GLTF load.

- **No bot-vs-bot model reuse means N x the per-frame matrix/traverse cost too.** Every bot's
  `weaponRig` is a distinct `THREE.Group` subtree with its own `model` (a full copy of the GLB
  scene graph, meshes included), so `mount.weaponRig.updateMatrixWorld(true)` at `:7922` — called
  twice per aiming bot per frame, once at `:7934` and again at `:7937` after the barrel-alignment
  correction — walks a full independent hierarchy per bot instead of an instanced draw.

- **Bot yaw convention correctly matches the harness, no divergence there.** `bot-viewer.html`'s
  `updateBot` passes `yaw: bot.yaw + Math.PI` directly to `botProceduralBody.update()`
  (`bot-viewer.html:603`). `environment-viewer.html`'s path goes through `toWirePose`
  (`bot-entity.js:69-77`, bakes `bot.yaw + Math.PI` into the wire quaternion) and
  `GhostRenderer._updateProceduralBody` (`multiplayer.js:562-563`, recovers yaw via `atan2` from
  that same quaternion) — algebraically the same offset, just round-tripped through the network
  wire-pose shape. This was a real, already-fixed bug (`agent_log.csv 2026-07-14T14:00`,
  `docs/subsystems/bots.md:31-38`), not a currently-live divergence.

## 3. Contrast with the creature bridge (`port-creature-bridge.js` / `port-creature-system.js`)

The creature port is cheap and correct precisely because it was built as a **many-instance system
from the start**, with a real adapter layer:

- **`port-creature-bridge.js`** (`createEnvironmentPortCreatures`, `:410-535`) is a genuine
  adapter: it owns UI wiring, translates env-viewer's `terrain`/`terrainSystem` shapes into the
  creature system's own `terrainSettings`, injects `resolveTrunks`/`nearbyTrunks`/`getPlayerPose`/
  `damagePlayer`/`getWorldBounds` as callbacks instead of reaching into env-viewer globals, and
  exposes exactly three calls to the host: `update(dt)`, `reset()`, `stats`. Bots have no
  equivalent — `spawnBotAt`, `updateBots`, `destroyEnvironmentBotWeaponMount`, and 20+ other
  bot-only functions are free functions closed over `environment-viewer.html`'s own module scope,
  reaching directly into `scene`, `mapCollider`, `terrainHeight`, `trunkIndex`, etc.
- **Shared geometry, not per-instance geometry.** `port-creature-system.js:759-780`
  (`geometryCache`/`sharedGeometry`) memoizes every `BoxGeometry`/`SphereGeometry`/
  `CapsuleGeometry` by its dimensions so N creatures with the same limb proportions share one
  `BufferGeometry`. The bot body, by contrast, calls `createProceduralPlayerBody` once per bot
  (`multiplayer.js:531-535`), which builds its **own fresh set** of `MeshStandardMaterial`s
  (`shellMat`/`plateMat`/`trimMat`/`eyeMat`, `player-procedural-body.js:538-543`) and geometries
  (`makeLatheGeometry`/`makeMannequinLimbGeometry`, `:545-559`) with no cache — confirmed no
  `geometryCache`/`sharedGeometry`-equivalent exists anywhere in `player-procedural-body.js`.
- **Instancing.** `createCreaturePartBatches` (`port-creature-system.js:838-869`) builds one
  `THREE.InstancedMesh` per part type (`shellBox`, `plateBox`, `trimBox`, `lightBox`, `footBox`,
  `jointSphere`, `limbSegment`, `shadowBox`) at `capacity = 4096`, and every creature at the
  appropriate LOD tier writes its transform + color into an instance slot instead of getting its
  own `Mesh`. The system tracks and reports LOD-tier stats (`instancedBoxes`, `instancedLimbs`,
  `instancedJoints`, `instancedHandsFeet`, `instancedShadows`, `tiers[]`,
  `port-creature-bridge.js:513-522`) — i.e., LOD/instancing is a first-class, measured part of the
  design. Bots have **no InstancedMesh usage and no LOD tiers** anywhere in their render path; every
  bot is a full, independent procedural-body mesh hierarchy plus a full independent weapon-model
  mesh hierarchy, always at maximum detail regardless of distance or count.
- **A cached-template + cheap-clone pattern for GLB assets already exists in this codebase** (the
  local player's `lbWeaponModelCache` + `skeletonClone`, `:7609`/`:7699-7712`) but was not reused
  for bots — the creature system doesn't need this pattern (it's fully procedural, no GLB assets),
  but the *bot* weapon-mount code sits right next to a working example of exactly the fix it needs
  and didn't adopt it.

In short: the creature port succeeded because whoever wrote `port-creature-system.js` treated
"there will be many of these" as a first-order design constraint (shared geometry cache +
InstancedMesh + LOD tiers, all present from early in the file). The bot port treated "there will be
many of these" as an afterthought — it is `bot-viewer.html`'s single-bot code relocated into
`environment-viewer.html` with the FSM/nav/combat logic correctly generalized (via the
already-player-id-generic combat pipeline) but the *rendering/asset* half left exactly as it was
tuned for n=1.

## 4. Suspected wiring-level causes of the two bugs

**Severe perf**, ranked by expected impact:
1. Zero geometry/material sharing for bot bodies (`createProceduralPlayerBody` called once per
   bot, no cache) — N complete procedural-mesh hierarchies (LatheGeometry limbs, 4 unique
   materials each) instead of the creature system's shared-geometry + InstancedMesh pool.
2. Zero weapon-model sharing/instancing — N uncached `GLTFLoader().loadAsync()` calls of the same
   GLB per weapon-per-squad/round batch (`:7796`), each producing an independent, never-disposed,
   never-reused scene graph, vs. the local player's one-cached-template-then-clone pattern that
   already exists in the same file.
3. No backoff on mount-request retry (`:7903-7907` re-fires every frame while `mount` is falsy) —
   a stuck or contended bot can turn into a permanent per-frame GLTF reload loop, which is far
   worse than a one-time N x cost.
4. No LOD: every bot runs full FABRIK IK + full weapon-pose-controller update every frame
   regardless of distance/count, unlike creatures' tiered `bodyOnly`/`armsActive`/`ikFull`/
   `ikCheap` stats-tracked degradation.

**Invisible arms/weapons**: both are downstream of the same root — a bot's weapon mount
(`botVisualWeaponMounts.get(id)`) never resolving. While unresolved, `updateEnvironmentBotWeaponMount`
returns before creating/updating `weaponRig` (weapon invisible) and never calls
`mount.controller.update()`, so the procedural body's arm IK targets are never driven off their
idle stub pose (arms invisible-looking/frozen). The mount can fail to resolve either transiently
(never recovers because of the missing retry throttle, #3 above) or simply take a long time to
resolve under load (many bots' concurrent uncached GLTF loads competing for fetch/parse time, #2
above) — in a round/squad spawn burst this is exactly the condition most likely to produce visibly
"invisible" bots on spawn.

## Key files / line references

| File | Relevant lines |
|---|---|
| `environment-viewer.html` | `:78,82-83` imports; `:1634-2598` bot state/spawn/FSM/update section; `:2558-2598` `updateBots`; `:7609,7681-7736` local-player cached weapon mount (the pattern not reused); `:7743-7939` bot weapon-mount system (uncached); `:9249` `updateBots(rawDt)` call site in `animate()` |
| `bot-entity.js` | `:13-29` `createBotEntity` (no mesh); `:41-59` `stepBotPhysics`; `:69-87` `toWirePose` |
| `bot-viewer.html` | `:409-522` single-bot weapon-mount source the env-viewer copy was drawn from; `:556-621` single-bot spawn/update |
| `multiplayer.js` | `:378-660` `GhostRenderer`; `:528-581` `_updateProceduralBody` (per-bot body creation, no cache) |
| `player-procedural-body.js` | `:445-559` per-call material/geometry construction, no shared cache |
| `port-creature-bridge.js` | `:410-535` `createEnvironmentPortCreatures` — clean adapter |
| `port-creature-system.js` | `:759-780` shared geometry cache; `:838-869` `InstancedMesh` batches, `capacity=4096` |
| `docs/subsystems/bots.md` | `:1-20,49` wiring status/design note ("no new files"); no mention of asset caching anywhere |
