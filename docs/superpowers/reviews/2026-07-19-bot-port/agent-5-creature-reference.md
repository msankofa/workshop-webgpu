# Creature port as reference model for the bot port

Scope: reverse-engineer why `port-creature-bridge.js`/`port-creature-system.js` are correct and
cheap, and identify exactly where the bot port (`bot-entity.js`, `bot-activity.js`, plus the bot
wiring inside `environment-viewer.html` and the render path in `multiplayer.js`) diverges. All
claims below are grounded in code read, with `file:line` citations.

## 1. The creature port's architecture and why it's cheap

### 1.1 One manager, one array, one pass — not N independent objects

`createPortCreatureSystem(...)` (`port-creature-system.js`) owns a single `creatures: Creature[]`
array and a single `update(dt)` entry point (called once per frame from the bridge,
`port-creature-bridge.js:525` → `system.update(dt)`). Inside `update`, every stage — LOD
classification, activity FSM, combat, steering, physics, collision, render — is its own `for (const
c of creatures)` loop (`port-creature-system.js:4989-5182`), not a per-creature `tick()` method
invoked from N separate call sites. This is what makes LOD/throttle gating cheap to apply
uniformly: each loop can skip a creature with one boolean check instead of the check living inside
a deeply nested per-object update chain.

### 1.2 Instanced-mesh batching — 8 draw calls, not thousands of meshes

`createCreaturePartBatches({ scene, capacity })` (`port-creature-system.js:838-941`) allocates
**three shared `BufferGeometry`s** (`box`/`sphere`/`capsule`, `:840-842`) and **eight
`THREE.InstancedMesh` buckets** (`shellBox`, `plateBox`, `trimBox`, `lightBox`, `footBox`,
`jointSphere`, `limbSegment`, `shadowBox`, `:847-859`), each capacity 8192. Every creature's
limb/joint/foot/shadow, for every creature in the roster, is written as one instance-matrix (+
optional per-instance color) into one of these eight meshes via `beginFrame()`/`add*()`/`endFrame()`
(`:892-928`) — regardless of whether there are 6 creatures or 600, the scene graph still only holds
8 draw-call-producing objects (plus small marker/UI meshes). When instancing is on (`parts` mode,
the default — `CREATURE_INSTANCING_MODE` at `:14`), individual creatures don't even get real
`THREE.Mesh` objects for their limbs: they get bare `new THREE.Object3D()` placeholders used purely
as transform nodes (`port-creature-system.js:1506-1573`, e.g. `const hipBall = instancedParts ? new
THREE.Object3D() : new THREE.Mesh(...)`), so no per-creature geometry/material is ever allocated
for the instanced path. `ownerForHit(hit)` (`:918-921`) maps a raycast hit's `instanceId` back to
the owning creature for picking, so instancing doesn't cost the interaction layer anything either.

### 1.3 Zero-allocation hot path — module-scope scratch objects

At module scope, `port-creature-system.js:790-810` pre-allocates every `Vector3`/`Quaternion`/
`Matrix4`/plain-object scratch the physics/steering/IK/instancing code needs per frame (`_com`,
`_near`, `_fabrikDir`, `_armAxis`, `_instMatrix`, `_instPos`, `_hullOut`, `_nearbyScratch`, etc.) and
reuses them across every creature every frame — no `new THREE.Vector3()` inside the hot loops. The
architecture notes in `docs/subsystems/creature.md` ("Per-creature perf caches" section) describe a
second layer of this same discipline applied *per instance*: values constant after construction
(`_collisionRadius`, `_maxArmReach`, `_meleeRadius`, per-leg partner topology) are computed once in
the constructor rather than recomputed on the hot path, and per-arm scratch vectors
(`arm._shoulderWorld`/`_restWorld`/`_localScratch`/...) replace what used to be `.clone()` calls in
`renderArms`/`armRestTarget`.

### 1.4 LOD / distance-based simulation throttling

`creaturePerf` (`port-creature-system.js:15-23`) defines a tunable LOD ladder — `detailDistance`,
`bodyOnlyDistance`, `hideDistance`, `ikDistance`, `shadowDistance`, plus **update strides**
(`fullUpdateStride=1`, `bodyUpdateStride=2`, `farUpdateStride=4`) — all overridable via a `lod`
object injected into the factory. Each creature carries a random `lodFrameOffset` (constructor,
`:1679`, `Math.floor(Math.random() * creaturePerf.farUpdateStride)`) so creatures at the same LOD
tier don't all recompute on the same frame (temporal spreading, avoids a stutter spike). Per frame
(`:4955-5010`), squared-distance buckets classify each creature into a tier, set `lodStride`, and
compute `c.lodShouldSim = c.lodVisible && ((frameIndex + c.lodFrameOffset) % c.lodStride === 0)`.
Every subsequent stage — activity FSM (`:5119`), combat (`:5120`), eating (`:5121`), physics
(`:5169`), the second terrain-clearance pass (`:5171`), render (`:5182`) — is gated on
`c.lodShouldSim`/`c.lodVisible`/`c.lodArmsActive`/`c.lodDebugActive`. Far/hidden creatures literally
do not run `physicsStep()` some frames, don't run IK at all past `ikDistance`, and stop casting
shadows past `shadowDistance`. This is a genuine amortized-cost system, not just an on/off cull.

### 1.5 Clean adapter/bridge boundary

`port-creature-bridge.js` is the *only* place that touches `environment-viewer.html`'s globals. It:
- Injects ambient context as **plain callbacks**, not shared mutable state: `terrainHeight`,
  `resolveTrunks`/`nearbyTrunks` (tree collision, from `collision.js`'s `trunkIndex`),
  `getPlayerPose`/`damagePlayer` (host/solo only), `getWorldBounds` (`:410-460`).
- Derives a synthetic `creatureTerrain` settings object from the live terrain/terrainSystem params
  (`creatureArenaSize`, `:404-408`) instead of letting the sim reach into the real terrain object
  directly; `rebuildTerrain` writes back explicitly (`:451-459`) rather than sharing references.
- Owns its own pointer/raycaster wiring (click = select, dblclick = set target,
  `:462-488`) gated by an injected `isInteractionEnabled()` predicate — the sim never touches
  `renderer.domElement` itself.
- Exposes exactly 3 verbs to the host app: `update(dt)`, `reset()`, `stats` getter, plus the raw
  `system` for the few call sites (HUD, keybinds) that need deeper access. A `mode: 'off'` short
  circuit (`:497-524`) hides everything and zeroes every stat field **without calling into the sim
  at all** — disabling creatures is O(creature count) for one frame, not a sustained cost.

`dt`/clock handling: the bridge takes `dt` as a plain function argument passed in from
`environment-viewer.html`'s own frame clock (`frameProfiler.time('creatures', () =>
portCreatures.update(rawDt))`, per `docs/subsystems/creature.md:61`) — no separate clock owned by
the creature system, no drift between systems.

## 2. Shared body/limb/weapon infrastructure — and why bots don't get its benefits

**Creatures and bots do not share rendering code, and that divergence is by design on the creature
side but accidental/unaddressed on the bot side.**

- Creatures use their own `KinematicChain` (FABRIK, `port-creature-system.js:642` per
  `docs/subsystems/creature.md:306`), instanced into the 8-bucket batch system above.
- The player/bot body rig is a **second, independent** implementation:
  `createProceduralPlayerBody` in `player-procedural-body.js` explicitly does **not** import the
  creature system — see the file's own header comment (`player-procedural-body.js:14-17`): *"Do not
  import the Creature class from port-creature-system.js: its physicsStep() moves the creature from
  its own feet/balance, which would fight the player controller. The KinematicChain FABRIK solver
  and terrainNormal helper below are narrow copies, not imports."* So there's a deliberate,
  documented fork of the FABRIK solver (`player-procedural-body.js:452-820`, `solveLeg` at `:872`,
  `solveArm` at `:894`) — reasonable, since a player-driven biped has different constraints than a
  free-roaming quadruped/hexapod. This part of the divergence is fine.
- What's **not** fine: `createProceduralPlayerBody` never adopted any of the instancing/LOD/
  scratch-reuse discipline described in section 1. Per call it:
  - Builds unique `BufferGeometry` via local closures `makeLatheGeometry`/`makeLimbGeometry`
    (`player-procedural-body.js:545`, `:566`) — **not** cached at module scope, so every body
    (every remote player *and every bot*) re-tessellates its own pelvis/torso/head lathe profiles
    and ~8 limb capsule-ish geometries from scratch.
  - Builds 4 unique `MeshStandardMaterial`/`MeshBasicMaterial` instances per body
    (`:538-541`, `tintMaterials`/`materials` arrays at `:542-543`) — not shared across bodies, so
    per-body material count scales linearly with body count.
  - Creates ~15-18 individual `THREE.Mesh` objects per body (pelvis, waist, torso, neck, head, 2
    eyes, 2×(upper/lower/foot) legs, 2×(upper/lower/hand) arms — `:596-699`), each added straight to
    `scene` (via the body's own `group`), each a separate draw call — **no instancing at all**.
  - Allocates a few `new THREE.Vector3(...)` per frame inside `update()` (`player-procedural-body.js
    :1169-1170, :1184-1185, :1195` — per-leg `hipAttach`/`local`, per-arm `local`, and the two
    `idleLocalLeft`/`idleLocalRight` constants, which don't even need to be recreated every call)
    — a small but real per-frame GC cost the creature system avoids entirely.
  - Has **no LOD or update-stride mechanism whatsoever** — grepping the file for
    `lod|LOD|throttle|stride|distanceTo.*camera` turns up nothing; every body's full IK/gait
    scheduler runs every frame regardless of camera distance.

- **Weapon rendering is a second independent system on top of that** (`weapon-pose-controller.js`),
  wired per-body via `createWeaponPoseController({ THREE, body, weaponView, getWeaponDef })`. The
  **local player's** third-person mount caches its loaded GLB template and reuses it:
  `lbWeaponModelCache.get(weaponId)` / `.set(weaponId, template)`
  (`environment-viewer.html:7699-7706`), then clones per-mount via `skeletonClone(template)`
  (`:7712`, using `SkeletonUtils.clone` — required for skinned-mesh GLBs per the 2026-07-10 fix
  logged in `agent_log.csv:142`, since a plain `Object3D.clone(true)` does not rebind
  `SkinnedMesh→Skeleton` and silently renders nothing).
  **The bot weapon mount does not do this.** `createEnvironmentBotWeaponMount(id, bodyRef,
  weaponId)` (`environment-viewer.html:7769-7846`) calls `new GLTFLoader().loadAsync(def.model)`
  directly every time a bot needs a mount (`:7796`) — **no cache lookup, no `skeletonClone`, no
  shared template** — it uses the freshly-loaded `gltf.scene` (`:7798`) directly as the model. This
  means: (a) every bot spawn triggers a brand-new network fetch + GLTF parse for its weapon, even if
  20 other live bots are already holding the identical weapon; (b) round-mode spawning (which can
  create several bots in the same tick, `environment-viewer.html:2561-2566`) fires that many
  concurrent uncached loads at once; (c) because each load is independent there's no
  cross-bot-sharing possible even in principle without adding the cache, unlike creatures where
  geometry is shared by construction. This is very likely a direct contributor to "invisible
  weapons" symptoms under load — a bot whose mount request is still in flight (or whose token got
  invalidated by a respawn/despawn racing the load, see the `token !== ...` bail-outs at
  `:7778`/`:7797`) simply never gets a weapon model attached, and the fallback capsule-ghost's
  placeholder "held" box is deliberately hidden whenever `useProceduralBody` is on
  (`multiplayer.js:505`: `g.userData.held.visible = !useProc && g.userData.held.visible`), so
  there is no visible fallback at all while a mount is pending or fails — the bot just appears
  unarmed with static idle arms.
- **Arms only pose correctly when a weapon mount's controller is actively calling
  `body.setArmTarget(side, target)`.** `createProceduralPlayerBody`'s own arm code
  (`player-procedural-body.js:1182`: *"arms (stub idle pose; weapon track drives via
  setArmTarget)"*) renders a static idle diagonal pose (`:1184-1185`) whenever nothing calls
  `setArmTarget`. For the **local player** that's fine because `setLocalBodyMode` unconditionally
  creates a `createWeaponPoseController` the moment third-person mode is entered
  (`environment-viewer.html:7955-7962`). For **bots**, arm-posing is entirely contingent on
  `createEnvironmentBotWeaponMount` having succeeded and `syncEnvironmentBotWeaponMounts(dt)`
  (`:7941-7943`) finding a live `mount` for that bot — any gap (loading race, `def.model`/
  `def.thirdPersonHold` missing, a `bodyRef` mismatch after a body gets recreated) silently leaves
  that bot's arms in the static stub pose with the gun/hand geometry attached nowhere, i.e.
  exactly the "invisible arms/weapons" symptom.
- **Remote players (guests) share this exact same body/mount machinery** — this isn't a bot-only
  code path, it's the generic `GhostRenderer`-driven remote-body path (`useProceduralBody: true` is
  set at all three `GhostRenderer` construction sites: `environment-viewer.html:631, 638, 678`).
  Bots are simply the highest-volume consumer of it (up to 30 concurrent instances vs. a handful of
  human guests), which is why the bot port is where the cost and the bug both become visible first.

## 3. Concrete patterns the bot port should adopt

In descending order of expected impact on the "unplayable at 30 bots" complaint:

1. **Cache the loaded GLB template per weapon id, clone per bot.** Mirror
   `lbWeaponModelCache`/`skeletonClone` (`environment-viewer.html:7699-7712`) inside
   `createEnvironmentBotWeaponMount` instead of a bare `new GLTFLoader().loadAsync(def.model)` per
   bot (`:7796-7798`). This alone removes N redundant network fetches + GLTF parses and fixes the
   most likely cause of races that leave a bot's weapon mount silently unattached.

2. **Share geometry/materials for the humanoid rig, the way `createCreaturePartBatches` shares
   `box`/`sphere`/`capsule`.** Hoist `makeLatheGeometry`/`makeLimbGeometry`'s outputs and the 4
   materials in `player-procedural-body.js:538-543` to module scope (or a factory-level cache keyed
   by the body's size/style parameters, since body dimensions vary by player height), so 30 bots
   don't each carry their own copy of ~15 unique geometries and 4 unique materials. This is the
   single biggest lever on bot draw-call count and GC pressure, matching the creature port's core
   insight (section 1.2).

3. **Instance the bot body rig, or at minimum instance identical-weapon bots' weapon meshes.** A
   full FABRIK/instancing port matching `createCreaturePartBatches` may be too large a lift given
   the biped rig's per-limb IK, but even a partial win — instancing the static (non-IK-posed)
   torso/pelvis/head boxes across all bots via `InstancedMesh`, à la the creature system's
   `shellBox`/`plateBox`/`trimBox` buckets — would cut a meaningful fraction of the ~15
   meshes/body draw calls.

4. **Add an LOD/update-stride gate for bot bodies and weapon mounts**, modeled directly on
   `creaturePerf` (`port-creature-system.js:15-23`) and the `lodShouldSim` gating pattern
   (`:4989-5182`). Concretely: skip `_updateProceduralBody`'s full IK solve
   (`multiplayer.js:528-581`) and `updateEnvironmentBotWeaponMount`'s controller update
   (`environment-viewer.html:7894-7939`) for bots beyond a tunable distance from the camera, or run
   them on a stride (every 2nd/4th frame) the way `bodyUpdateStride`/`farUpdateStride` do for
   creatures. At 30 bots with zero distance culling today, this is likely the second-biggest lever
   after (1)/(2) since it directly caps the per-frame IK/controller cost regardless of mesh count.

5. **Pre-allocate scratch `Vector3`/`Quaternion` for per-frame body-update math**, closing the small
   per-frame-per-bot allocation gap at `player-procedural-body.js:1169-1170, 1184-1185, 1195`
   (hoist the two idle-pose constants out of the function entirely; reuse a closure-scoped scratch
   `Vector3` for the per-leg/per-arm `local`/`hipAttach` the way `_uPos`/`_pPos`/`_orient` etc.
   already are at `:792-819`). Small relative to items 1-4, but zero-cost to fix and consistent with
   the creature system's discipline (section 1.3).

6. **Route bot ambient context through an explicit adapter, not ad hoc globals**, per section 4
   below — this doesn't reduce per-frame cost directly, but it's what let the creature port's
   `mode: 'off'` short-circuit (`port-creature-bridge.js:497-524`) exist cheaply, and an equivalent
   `mode: 'off'` for bots (skip `updateBots` and hide `botPlayers` entirely) would give the bot
   system the same emergency-cheap-disable path creatures already have, useful both as a perf
   escape hatch and for the invisible-weapons bug's blast radius (nothing to desync if bots are
   fully off).

## 4. The bridge/adapter interface bots are missing

`port-creature-bridge.js` proves the pattern; bots currently have no analogous module — all bot
logic lives inline in `environment-viewer.html` (`botPlayers` Map, `updateBots`, `pushBotsApart`,
`syncEnvironmentBotWeaponMounts`, the nav-grid bake, the spawn/despawn helpers, the weapon-mount
lifecycle) rather than behind a factory boundary. A `port-bot-bridge.js` analogous to
`createEnvironmentPortCreatures` (`port-creature-bridge.js:410-535`) would want to expose:

- **Construction-time injected context** (mirroring `createEnvironmentPortCreatures`'s params,
  `port-creature-bridge.js:410-426`): `scene`, `renderer`/`camera` (for future picking/inspector
  parity), `terrainHeight`, `resolveTrunks`/`nearbyTrunks` (bots currently skip tree/rock physical
  collision entirely per `docs/subsystems/bots.md:482-497` — `stepBotPhysics` never consults
  `trunkIndex`/`dressingIndexRef`, only nav-planning does), `mapCollider` accessor, `getPlayerPose`-
  style accessors for host/guest positions (today scattered as direct reads of `mpGuestPlayers`/
  `getLocalPlayerState` inline), and a `mode` flag (`'on'|'off'`) for the cheap-disable path.
- **A single `update(dt)` entry point** wrapping today's `updateBots(dt)` +
  `syncEnvironmentBotWeaponMounts(dt)` + `updateBotInspector(nowMs)` into one call, profiled the
  same way (`frameProfiler.time('bots', ...)` already exists at `environment-viewer.html:9249` —
  the bridge should own that call, not the host file).
- **A `reset()`/`despawnAll()` verb** mirroring `resetCreatures()`, and spawn verbs
  (`spawnBotAt`/`spawnSquadAtSlot`) exposed the same way `spawnCreatureAt`/`despawnCreature` are on
  the creature system's public API (`docs/subsystems/creature.md:43-44`), instead of being bare
  module-level functions in the host file.
- **A `stats` getter** exposing bot counts/LOD tiers/mount-load state analogous to
  `system.stats` (`creatureVisible`, `creatures`, `creatureRendered`, etc., per
  `docs/subsystems/creature.md:66`), so the debug HUD and `frame-profiler.js` can read bot cost the
  same way they read creature cost — today bot perf is only visible via the ad hoc
  `botStatsLog`/Bot Inspector panel (`docs/subsystems/bots.md:298-366`), not the frame-profiler
  pass breakdown creatures get.
- **Ownership of the weapon-mount cache** (item 1 in section 3) — the bridge is the natural owner
  of a shared `GLTFLoader`/template cache keyed by weapon id, exactly as
  `port-creature-system.js`'s module scope owns the shared `geometries`/`defs` for
  `createCreaturePartBatches` (`:838-855`).

None of this requires touching `bot-activity.js` (already pure/THREE-free/Node-tested, a good
model in its own right) or `nav-grid.js` — the gap is entirely in the THREE-facing
render/instancing/LOD layer that the creature port solved with `port-creature-system.js`'s
instanced batches + LOD ladder, and that `player-procedural-body.js` +
`environment-viewer.html`'s bot wiring never adopted.
