# Combat bots

> **Harness generations (2026-08-08).** `bot-viewer-v3.html` is the live harness and the only one
> that should be edited from now on. `bot-viewer-v2.html` was copied to make it and is now a frozen,
> playable snapshot of the 2026-08-07 game state — do not change it. `bot-viewer.html` (v1) remains
> the older harness. Everything below that says "in `bot-viewer-v2.html`" describes code that v3
> inherited verbatim at the fork; read those sections as describing v3 unless they are dated after
> 2026-08-08. Shared modules (`bot-activity.js`, `nav-grid.js`, `effect-renderer.js`, …) reach every
> generation; anything written inline in v3 reaches v3 only.

Status: **wired into `environment-viewer.html`** (2026-07-14), with four follow-up polish passes
the same day: (1) facing bug, bot/player collision, a fall-over death pose, a respawn toggle, a
weapon-type select, behavior sliders, and local A* pathing on non-shoot-house maps; (2) a smooth
(not snapped) death fall, a player immortality toggle, threat awareness/alerting (bots react to
being shot or shot-at and share that awareness with nearby squadmates), and a first-person-only
visibility gate so bots can't perceive or hit the local player while they're in third-person body
view or the orbit/dev camera; (3) real ammo/reload (bots used to reload instantly, effectively
unlimited ammo), tree/rock-aware line of sight and pathing (bots used to see and path straight
through forest/rocks), and notice-time + accuracy sliders (bots used to snap-aim and fire with
perfect accuracy the instant they spotted you); (4) a code-review pass on (3) that throttled the
now-expensive LOS raycast to a fixed cadence instead of every frame, and gave the notice-time
clock a short grace window so briefly ducking behind a branch doesn't cheat a free reset. Plus a
same-day Phase 1 of a squads/outposts/ammo-economy layer — see "Squads (Phase 1)" below. See
`docs/superpowers/specs/2026-07-13-combat-bot-fsm-design.md` for the base FSM design/phasing,
`docs/superpowers/specs/2026-07-14-squad-outpost-ammo-economy-design.md` for the squads/outposts
design and phasing, `docs/superpowers/plans/2026-07-13-combat-bot-phase0-viewer.md` for how Phase 0
was built, and `bot-viewer.html` for the standalone dev harness these modules were tuned in (still
functional, kept as the fast iteration loop for future FSM/nav changes).

## What exists today

- `bot-entity.js` — capsule state (`createBotEntity`), gravity + physics step
  (`stepBotPhysics`), and conversion to the game's player wire-pose shape (`toWirePose`).
  `stepBotPhysics` resolves against a BVH `mapCollider` when one exists (shoot-house / any
  authored map); on open procedural terrain (no `mapKey`, so no `mapCollider` is ever built) it
  falls back to an optional `heightAt(x,z)` flat ground-snap so bots don't fall through the
  world — added for the wiring step, since the harness always has a `mapCollider` and never
  exercised that path. A third, separate option, `rescueHeightAt(x,z)`, opts a caller into the
  below-terrain rescue inside the `mapCollider` branch (see "Below-terrain floor rescue" below).
  A fourth, `forensics`, opts a caller into the per-bot physics ring recorder (see "Terrain-tunnelling
  forensic ring" below).
  Browser/THREE first, but a stub collider makes the physics step Node-testable
  (`test-bot-entity-rescue.mjs`).
  **Forensic ring**: `bot-forensics.js` is the pure, THREE-free recorder behind that option —
  `createBotForensics()` plus the `F_*` field offsets and `FLAG_*` bits, re-exported by
  `bot-entity.js` the way `bot-separation.js` is so consumers keep one entity-module import.
  Node-tested in `test-bot-forensics.mjs`.
  **Facing bug (fixed 2026-07-14)**: `bot.yaw` is stored in `bot-activity.js`'s convention
  (`atan2(dx,dz)`, 0 = +Z-forward — the convention `aimAnglesTo`, movement, and fire direction
  all use), but the wire quaternion's convention matches `camera.rotation.y` (0 = -Z-forward, the
  direction THREE's default camera looks). `toWirePose` previously built the quaternion straight
  from `bot.yaw` with no conversion, so a bot's rendered mesh (eyes/hands sit on the ghost's -Z
  face, see `multiplayer.js`) faced exactly opposite its actual aim/movement direction — it shot
  and walked correctly, but visually appeared to do so backwards. Fixed by adding a `+ Math.PI`
  offset before halving for the quaternion (`toWirePose`'s `halfYaw`).
- `bot-activity.js` — pure, THREE-free FSM: `chooseBotState` (patrol/seek/pursue/aim/fire/flee/
  heal/knife), a strict first-match priority ladder gated by target visibility + aim error +
  caller-owned fire-cooldown readiness + a "last-known target position" flag + caller-owned commit
  flags (`fleeCommitted`, `healFleeCommitted`, `knifeRequested`) and heal signals. **Pursue is not
  the default at range (changed 2026-07-23):** a visible target is fired on where it stands from any
  distance the bot can see; the FSM only breaks off to PURSUE (close the gap) when `pursueHealthOk`
  (caller: HP above `pursueHealthThreshold01`, default 60%) **and** `keepsMissing` (caller: `missStreak
  >= pursueMissStreak`, default 3 non-hitting shots). Lost-sight chase is likewise health-gated — a
  hurt bot that loses the target patrols instead of SEEKing. Both new ctx params default pursue-safe
  (`keepsMissing=false`, `pursueHealthOk=true`) so the still-old env-viewer call site keeps SEEK until
  its rewrite (see `bot-viewer.html` is authoritative). Two stability properties live here, not in the
  caller: (1) **hysteresis** — flee holds until the target clears `fleeDistance + fleeExitBuffer`, and
  pursue (once miss-triggered) symmetrically holds until the target is buffer-closer than
  `pursueDistance - pursueExitBuffer` (both buffers only widen the band while already in that state, so
  entry uses the bare threshold — a Schmitt trigger that stops boundary flip-flop between a moving and
  a stationary state); (2) **safety dominates readiness** — if `healUnsafe` is set the
  FSM never picks HEAL even when `healReady` is also set, so contradictory heal signals can't thrash
  HEAL↔FLEE; (3) **HEAL needs a consumable pack (added 2026-07-23)** — `hasHealResource` (ctx, defaults
  `true` for old callers) gates both the entry (`healReady && hasHealResource`) and the committed hold;
  a bot that just spent its last pack drops back to FLEE. `reposition`/`dead` are *not* FSM states — they're viewer-level overrides that wrap the
  pure function (muzzle-recovery pre-empt and death). Also `aimAnglesTo`/`aimError`/`slewAngle`
  (turn-rate-capped yaw/pitch tracking). Allocation-free variants (added 2026-07-25, M1):
  `chooseBotStateName(current, ctx)` returns the bare state string (`chooseBotState` now delegates
  to it and just wraps the result in `{state}` — same ladder, zero behavior change for old callers),
  and `aimAnglesTo(from, to, out?)` takes an optional out-param object; omitted, it returns a fresh
  `{yaw, pitch}` exactly as before. Node-tested (`test-bot-activity.mjs`).
- `nav-grid.js` — pure, THREE-free 2D walkable grid + A* pathfinding: `buildNavGrid`, `findPath`
  (8-connected, no corner-cutting), `smoothPath` (string-pull), and `floodFill`/`floodPath`
  (bounded Dijkstra: one pass yields path distance + parent link for every reachable cell within a
  Chebyshev radius — for scoring many candidate goals without one A* per candidate). `findPath` uses
  a binary-heap open set over typed-array scores (2026-07-23; the old linear-scan open set made
  maze-scale calls cost milliseconds each). Both searches reuse module-scratch state instead of
  reallocating per call (2026-07-25): `findPath`'s `gScore`/`cameFrom`/`closed` are module buffers
  grown to the largest grid seen and reset by bumping a generation counter against an `Int32Array`
  stamp (unstamped == Infinity / -1 / open) rather than `.fill()`; both share reused heap arrays and
  flat `Int8Array`/`Float64Array` neighbour tables; `floodFill` skips stale heap pops. `floodFill`
  pools its `dist`/`parent` arrays too (2026-07-27): module buffers grown to the largest grid seen,
  with a **deferred band clear** — a run records the Chebyshev window `[start ± maxRadius]` it could
  have written (the radius test rejects a neighbour *before* any write, so the window is exactly
  `maxRadius`, not `+1`; `maxRadius: Infinity` records the whole buffer) and the *next* call clears
  that window on entry. Consequence: **a pooled result is only valid until the next `floodFill`
  call.** Same-frame consumers (`findMuzzleRecoveryCell`, `findFleeGoal`, `choosePatrolResumeGoal`)
  use the pool; a caller that keeps the result across frames must pass its own buffer pair as the
  `out` option (`floodFill(grid, from, { maxRadius, out })` allocates into `out` once and reuses it,
  clearing only its own previous window) — the medic flood cache is the one such caller. Indexing
  stays full-grid, so `flood.dist[r * cols + c]` and `floodPath` are unchanged. All of this is
  behaviour-preserving: paths are byte-identical to the pre-2026-07-25 implementation.
  Out-param variants `worldToCellInto(grid, x, z, out)` / `cellToWorldInto(grid, c, r, out)` (added
  2026-07-25, M1) share the math with `worldToCell`/`cellToWorld` (which delegate to them), for
  per-frame hot callers that reuse a scratch `{c,r}`/`{x,z}`. Node-tested (`test-nav-grid.mjs`).
- `bot-health-packs.js` — pure, THREE-free consumable-pack inventory + charge math (added
  2026-07-23): `makePack`/`packHp`/`packsTotalHp`/`hasHealResource`/`canHold`/`addPack`/`drawFromPacks`.
  A pack is a `{ charge01 }` record; a full (`charge01 = 1`) pack is worth `PACK_FULL_HEAL_HP` (100) HP
  of cumulative healing, `MAX_HELD_PACKS = 2` (the default cap; `canHold`/`addPack` take a per-holder
  `max` so a medic can carry 4). `drawFromPacks` spends charge front-to-back, so a small heal leaves a
  partially-used pack (exactly what gets dropped on death). Revive kits: `hasReviveMaterials` /
  `consumeRevivePacks` fuse `REVIVE_KIT_PACK_COST` (3) whole packs into one kit. Node-tested
  (`test-bot-health-packs.mjs`). **Only `bot-viewer.html` wires this so far** (env-viewer port pending).
- `bot-structures.js` — pure, THREE-free **map-content generators** (added 2026-07-26): the maze
  carve (`generateMazeCells`, lifted out of `bot-viewer-v2.html`) + `mazeCellWalls`, and
  `generateStructures` — buildings, maze pockets and obstacle fields scattered over open ground, so
  the wall-less layout mode has something to fight over. Node-tested (`test-bot-structures.mjs`).
  Full section: "Large open maps: structures + the fly camera".
- `bot-roles.js` — pure, THREE-free **role registry** (added 2026-07-23), the substrate the squad
  system builds on. `ROLES` maps a role id to a descriptor (`maxPacks`, `startingPacks`, `weapon`,
  `insignia`, `canRevive`, `leadership`, `support`, plus the loadout/perception block `sidearm` /
  `sightScale` / `bonusGrenades` / `swapOnDryMag` / `closeRange`, defaulted from `ROLE_DEFAULTS`);
  `getRole`/`roleMaxPacks`/`assignRolesToBatch` (spreads `medicPercent` + a `mix` of other
  specialists across a spawn batch, deterministically) / `pickSquadLeader` (chooses a squad's leader
  by highest `leadership`). Adding a role = one descriptor here (+ a behaviour module only if it
  needs one). Node-tested (`test-bot-roles.mjs`). Roles today: rifleman, medic, squad leader,
  sniper, technical — see "Sniper and technical roles".
- `bot-medic.js` — pure, THREE-free **medic decision math** (added 2026-07-23): `selectHealTarget` /
  `selectReviveTarget` / `decideMedicAction` (revive outranks heal, each gated by its resource; within
  `tendRadius` → `MEDIC_TEND` else `MEDIC_MOVE`) / `teamCentroid` / `cohesionTarget` (loose
  keep-together regroup). `MEDIC_DEFAULTS` holds the radii/thresholds. Node-tested
  (`test-bot-medic.mjs`). The viewer snapshots allies/corpses each frame and hands them here.
- `bot-state-code.js` — pure, THREE-free **discrete state encoding** (added 2026-07-26): a bot's
  condition as a 9-character positional code (FSM state, alert tier, escalation score, role, push
  element, ammo, health, packs, commit latches) so state traces can be logged, diffed slot-by-slot
  (`diffCodes`) and mined for pathologies like cover-thrash or flee-boundary oscillation.
  `encodeBotState`/`decodeBotState`/`coreCode`/`describeBotState`/`isLegalCode`/`illegalReason`,
  plus the quantizers (`healthBand`/`ammoSlot`/`packSlot`/`latchBits`/`tierSlot`) so bucketing lives
  in one testable place. 21 legality rules — each a citable claim about what this FSM can and cannot
  do — cut the raw slot product to 354,013 legal codes, projecting onto 434 behavioural-core states.
  Node-tested (`test-bot-state-code.mjs`). **Wired into `bot-viewer-v2.html`** 2026-07-26
  (`botStateDescriptor` adapter, change detection at the tail of `commitBotActor`, recorded lines +
  a state-code TSV export — clipboard copy, or `saveBotStateTrace()` writing a timestamped
  `bot-state-trace-<stamp>.tsv` into `bot-states/` via `serve.py`'s `/api/save-bot-state` (download
  fallback off-server) — deduped illegal-code `console.warn`); browser QA pending. Four rules have
  since been proven wrong — the fourth, `hold-latch-scope`, by the adapter emitting a code that
  failed the rules at wiring time, which is why the warning exists. Full reference (slot table, all
  21 rules, projections, viewer wiring, generated state table):
  **[`bot-state-codes.md`](bot-state-codes.md)**.
- `weapon-part-batches.js` — instanced-render pool for held weapon GLBs (2026-07-23), sibling of
  `body-part-batches.js`: one `InstancedMesh` bucket per distinct sub-mesh geometry, keeping the
  template's own GLB material (no per-instance color). Bot mounts no longer clone the weapon model
  at all — `createBotWeaponMount` keeps a transform-only rig (groups + muzzle/grip markers) and
  each frame `flushWeaponMount` (per actor, from the animate loop) emits
  `weaponView.matrixWorld × bakedSubMeshLocal` into the pool,
  so N bots holding the same weapon cost ~subMeshCount draws total, not per bot. Skinned weapon
  meshes (m1911, cz_805_bren, mk2_grenade) get `bakeSkinnedGeometry` at template load: their
  authored node pose is NOT the skinned pose (bones rotate the gun into place — rendering raw
  geometry shows guns rotated out of the hands), so the never-animated bone pose is frozen into
  static geometry once (positions + normals, per-vertex blend, shader-exact; validated against
  three's `applyBoneTransform` in the test). This killed the `SkeletonUtils.clone` dependency.
  Heal-holstering (`weaponRig.visible = false`) and destroyed
  mounts simply skip the flush. Default capacity 2048 instances/bucket (matches the body pool's
  ~2048-bot ceiling), soft-fail with `stats.dropped`. Node-tested (`test-weapon-part-batches.mjs`).
- **Gunfight perf pass (2026-07-23)** in `bot-viewer.html`: `findFleeGoal` now runs one bounded
  `floodFill` and scores all candidate cells from it (was one full A* per ring cell — 100–830 ms
  spikes on maze maps whenever a bot fled or heal-retreated; now sub-ms, so no time-slicing needed);
  healing cover raycasts were capped to the `FLEE_COVER_RAYCAST_CAP` best-scored candidates
  (superseded 2026-07-23: cover scoring now reads the baked visibility field for every candidate on
  every flee — see "Visibility field & cover" below; the cap is gone). Shot FX
  (tracers, bullet meshes, hit impacts) are pooled — permanent scene residents toggling `visible`,
  no per-shot geometry/material construction. Per-shot DOM (ammo buttons, shot log) and the
  state-record textarea flush at most once per frame (`flushShotUi`/`flushBotStateRecord`, the
  latter append-only instead of re-joining the whole log per event).
- `bot-viewer.html` — standalone harness, unchanged by this pass: swappable rooms/maze test maps,
  spawn/remove panel, WASD dummy target, full FSM+nav debug overlay. An **"Auto-add bots"** panel
  section (`updateBotAutoAdd`, driven from the animation loop) periodically spawns waves: a toggle,
  a target cycler (`Both`/Alpha/Bravo → `botAutoAddTeams`), `bots / wave` (`botAutoAddCount`, per
  targeted team) and `every (s)` (`botAutoAddInterval`); enabling fires the first wave immediately.
  It honors the panel's `medic %` via a **per-team fractional accumulator** (`botAutoAddMedicAccum`)
  rather than `spawnBots`' per-batch rounding — otherwise small waves (`round(1 * 25% ) = 0`) would
  never yield a medic; the accumulator carries the fraction forward and builds an explicit `roles`
  array per wave.
  **Population caps** (2026-07-27, `bot-viewer-v2.html` only): `max / team` (`botAutoAddTeamCap`,
  default 30) and `max total` (`botAutoAddTotalCap`, default 50) clamp each wave to the remaining
  headroom instead of skipping it, so a wave can spawn a partial batch. Counts are **living bots**
  (`countLivingByTeam`) — corpses are governed by the separate cull cap. When both teams are
  targeted the emptier one is served first, so a tight total cap can't starve one side; the medic
  accumulator charges the spawned count, not the requested one. A wave that spawns nothing flips
  `botAutoAddCapped` and the toggle reads `Auto-add: On (at cap)`. Manual spawn buttons are
  deliberately uncapped. Both caps persist in the save/load slots (`autoAdd.teamCap`/`.totalCap`).
  Two viewer defaults flipped 2026-07-24: **procedural body On** and **tactical nav debug Off**.
  Still the place to iterate on
  FSM/nav-grid changes before they land in the real wiring below. The maze generator
  (`generateMazeCells(cols, rows, { loopChance, straightness, braid, rooms, entrances, rng })`,
  which lives in `bot-structures.js` since 2026-07-26, +
  `buildMazeLayout`) is a seeded recursive-backtracker exposed through live Map-layout controls:
  rectangular `mazeCols`/`mazeRows`, `mazeCellSize` (hall width = `mazeCellSize − WALL_T`), mutable
  `WALL_T`/`WALL_H`, and sliders for `mazeLoopChance` (open extra internal walls → loops),
  `mazeStraightness` (DFS heading bias → longer straight runs), and `mazeBraid` (fraction of dead
  ends knocked through). `mazeSeed` (mulberry32 via `makeRng`) makes any (seed, size, params) combo
  regenerate an identical maze; the 🎲 button and "Maze layout (new)" reroll it, and the Test
  condition preset pins `mazeSeed = 1337` for a reproducible 30×30 map. A **Maze structure** block
  adds higher-payoff knobs: **open rooms** (`mazeRoomsOn`/`Count`/`Size` — merge NxN cell blocks
  into arenas), **cover pieces** (`mazeCoverOn`/`Density`/`Height` — partial-height boxes added as
  `layout.covers`, rendered short so the shared `mapCollider` raycast passes *over* them → real
  shoot/see-over cover while still blocking movement via `pointInWall`/`activeCovers`), **perimeter
  entrances** (`mazeEntrances` — opens outer walls onto a one-cell walkable apron for flanking), and
  a **start/goal** dropdown (`mazeStartGoal`: `corners`/`center`/`random`, using a seed-offset RNG
  so placement never perturbs the maze structure).
  A **walls** dropdown (`mazeWallMode`, added 2026-07-26) picks the wall vocabulary the same grid
  emits: `maze` (carved corridors, the default), `perimeter` (boundary ring only — an open arena,
  still honoring the entrance gaps), or `open` (no walls at all, so terrain + cover pieces are the
  whole map — the mode for testing on generated ground). The grid still sizes the map, places
  spawns/patrol points and drives cover density in every mode; `open` also drops the entrance apron
  from `bounds` (there is no ring to punch) and scatters cover freely inside each cell instead of
  into the corridor-safe quadrant offset. Carve-only controls (loop/straightness/braid, open rooms,
  and in `open` also perimeter entrances) grey out when they can't apply, and "Maze layout (new)"
  reads "Open layout (new)" in `open`. Test condition pins `mazeWallMode = 'maze'`.

  **Health packs (viewer-only, added 2026-07-23).** Bots heal from consumable packs instead of
  free regen. Each actor carries `healthPacks: [{charge01}]` (spawns with one full pack, cap 2 via
  `bot-health-packs.js`). Behavior:
  - **Crouch + heal pose** — pose selection in `updateBot` is driven by `actor.poseMode`
    (`'none'`/`'rifleHeal'`/`'medicHold'`); `endBotPose` cleans up on every transition (hides the held
    pack, releases arm targets, un-holsters). A **rifleman** self-healing (`botState === BOT_HEAL`,
    non-medic) crouches (the rig's `crouch` channel is forced on over the UI toggle) and
    `updateHealPose` holsters the gun (`weaponMount.weaponRig.visible = false`) and drives both arms:
    **left hand** holds the pack (`actor.heldPackMesh`, `buildHealthPackMesh`) on the **left knee**
    (`joints.leftKnee`), **right hand** dabs between pack and chest (`joints.torso`) on a ~0.8 Hz
    cosine. The pack is pinned to the solved `joints.leftHand` so it stays in-grip under IK
    reach-clamp. `updateBotHealing` draws HP via `drawFromPacks` (spends charge, leaves partials),
    stopping at `resume01` or when packs empty.
  - **Drop on death** — `killCombatBot` calls `dropActorHealthPacks`, scattering each still-held pack
    (with its remaining charge) as a `worldHealthPacks` pickup near the corpse. `spawnWorldHealthPack`
    runs every drop through `snapToWalkable` (nearest walkable nav cell) so a pack never lands inside a
    wall — otherwise a seeker paths to the closest reachable cell and then pins against the wall trying
    to close the last metre it can never stand on (fixed 2026-07-23).
  - **Pickup + seek** — `collectPacksUnderfoot` grabs any pack within `botPackSettings.pickupRadius`
    (if under the 2-cap), triggering a brief crouch dip (`packPickupCrouchUntil`, `pickupCrouchMs`). `nearestSeekablePack` picks a target the bot will *walk to*: it must have
    room, pass `botCanSeePack` (sight-range + LOS, 360° FOV), and be either wanted-by-a-wounded-bot
    (distance-agnostic) or within `shortProximity` for a healthy top-up. A wounded, packless bot
    redirects its heal-retreat to the pack (`updatePackSeekMovement`, `pathMode='packseek'`, 1.24×
    speed) instead of generic cover; a healthy bot only detours from patrol. A wounded bot that
    reaches safety with no pack and none in sight abandons the retreat (rejoins; a later hit
    re-triggers it) rather than flee-locking. Tunables live in `botPackSettings`
    (`pickupRadius`, `shortProximity`, `dropScatter`, `pickupCrouchMs`). A **"Drop test pack ahead of bot"** button
    (Debug panel) spawns a pack for QA without needing a kill.
  - **List hygiene (v2 viewer, 2026-07-25)** — in `bot-viewer-v2.html`, ground packs despawn after
    60 s (`PACK_DESPAWN_MS`) and the list is hard-capped at 64 (`PACK_CAP`, oldest-first eviction);
    packs whose nav cell is goal-claimed by a living bot (a seeker en route) are skipped by both
    unless the cap can't be met otherwise. `nearestSeekablePack`/`collectPacksUnderfoot` query a
    second `createBotSpatialHash` over the pack records (rebuilt only on add/remove, packs don't
    move) instead of scanning the whole list; selection/pickup order matches the old linear scans
    via a per-pack spawn `seq` stamp.

  **Roles + the medic (viewer-only, added 2026-07-23).** The first entry in a general **role system**
  (`bot-roles.js`): each actor carries a `role` + role-derived `maxPacks`/loadout, set at spawn by
  `assignRolesToBatch` from a **`medic %`** toolbar input (`botMedicPercent`) plus a **"Spawn medic"**
  button. Roles are the substrate for the coming squad system — the descriptor's `leadership` weight
  and `pickSquadLeader` are the (unwired) seam a squad will use to elect its leader. Medic specifics:
  - **Loadout/identity** — a medic carries up to **4 packs** (per-holder `canHold`/`addPack` `max`),
    spawns with 2, is issued a **`five_seven` sidearm**, and floats a red **cross insignia**
    (`buildRoleInsignia`, billboarded above the head in `updateRoleInsignia`).
  - **Decisions** (`bot-medic.js`, pure) — each frame `decideMedicDuty` snapshots living allies +
    fresh corpses and calls `decideMedicAction`. Two filters keep medics from clustering: **fellow
    medics are never heal candidates** (support self-heals from its own packs; medic-on-medic healing
    makes them converge and can mutual-heal-deadlock), and a **patient claim** (`medicClaimBy`/
    `medicClaimUntil`, `medicClaimLeaseMs`) makes a medic skip a patient another living medic has
    already committed to, so medics spread across the wounded instead of piling on one (sequential
    per-actor updates make the same-frame claim stick; a stale lease self-clears in <1 s). Fallen
    medics are still valid **revive** targets. Selection is **wall-aware**: `attachMedicNavCost` tags
    each candidate with a nav **path** distance from one bounded `floodFill` off the medic's cell
    (Euclidean prefilter first; recompute throttled to `MEDIC_NAV_FLOOD_MS`, into the medic's own
    `medicFloodBuf` `out` buffers since the cache outlives other bots' floods — see `nav-grid.js`
    above), the pure selectors rank
    by that `cost`, and **unreachable candidates are dropped** — so a medic never picks (or pins on a
    wall chasing) an ally that's close only in a straight line, and won't tend one through a wall
    (`MEDIC_TEND` gates on path cost too). Without a nav grid it falls back to straight-line.
    The danger-field surcharge rides in a separate `bias` field that `bot-medic.js`'s `preference()`
    adds **for ranking only** — it must never be folded into `cost`, because `cost` gates
    `responseRadius`/`reviveRadius` and the tend radius, and a death paints `DANGER_DEATH_WEIGHT` on
    the corpse's own cell: at `DANGER_PATROL_SCALE` that is a 4 m surcharge against a 1.7 m tend
    radius, so every corpse read as out of tend range and no revive could ever fire. This **layers on top of the combat FSM** in
    `updateBotSentry`: after `chooseBotState`, a medic that isn't self-preserving (`!botHealRequested`)
    and isn't in a committed `BOT_FLEE`/`BOT_KNIFE` may override its state to `MEDIC_MOVE` (approach a
    wounded/fallen ally) or `MEDIC_TEND` (channel in place). It still aims and **fires while
    moving/tending** (the fire-if-aimed clause mirrors `BOT_FLEE`).
  - **Heal-ally pose** — **every tend kneels**, and as of the kneel stance that is literal rather than
    loose language: the `medic-tend` rung in `bot-stance.js` returns `STANCE_KNEEL` (falling back to
    `STANCE_CROUCH` when `kneelEnabled` is off), while self-`heal` keeps `STANCE_CROUCH`. The split is
    not cosmetic — a medic works on someone else at arm's length and wants a stable base with both
    hands forward, while a bot patching itself wants to be able to break and run. Neither rung reads
    any medic field: treating a casualty
    means being pinned in the open beside them, so standing to do it is never right, least of all in a
    firefight. What combat changes is the **weapon**, not the posture — so `actor.tendUnderFire` (a
    visible enemy, someone shooting the medic, a live cover threat, or an enemy seen within
    `MEDIC_TEND_COMBAT_MS` = 5 s) picks the pose only:
    - `medicHold` (**under fire**): the sidearm stays in the **right hand** (weapon visible, aim/fire
      intact) and `updateMedicHoldOverlay` overrides only the **left-arm** target, working
      **on the patient** (run *after* `updateBotWeaponMount` so it wins the frame).
    - `medicAid` (**out of combat**): nothing to answer, so the weapon rig is hidden and
      `updateMedicAidPose` *replaces* the weapon mount (like `rifleHeal`), putting **both** hands on
      the casualty.

    **Heal vs revive read differently**, which is the point of `medicWorkPoint`: a heal is a steady
    press (hand on the contact, ~0.8 Hz settle, plain white-cross pack in hand), a revive is chest
    compressions — a triangle-eased pump at ~1.7 Hz, both hands stacked on the sternum in `medicAid`,
    and the cyan fused kit (`buildReviveKitMesh`, matching the HUD's cyan `◆` kit pip) in hand instead
    of a pack. `showMedicHeldItem` owns the swap; both meshes are hidden on death, on any pose
    transition (`endBotPose`), and freed in `disposeBotActor`.

    Both reach a real contact point: `medicTendContactPoint` returns a living ally's chest off its
    **live** capsule (so a crouched patient is met at its own chest) or, for a revive, the death site
    at ground + 0.3 m. `setArmTargetOnPatient` clamps the target along the shoulder→patient ray to
    `ARM_REACH_M` (0.62), so a medic still closing reads as reaching rather than as a broken IK solve;
    the pack mesh is pinned to the **solved** hand afterwards. Note `setArmTarget` stores the position
    **by reference**, so the two arms must never share a scratch vector.

    **Self-heal is role-blind.** A medic patching itself uses `rifleHeal` and crouches exactly like
    anyone else — same holstered two-handed pack pose, and `forcedCrouch` now covers any `BOT_HEAL`
    rather than exempting medics. Only tending *someone else* is medic-specific. (`medicHold` keeps a
    self-cradle fallback for a patient that vanishes mid-frame, when `medicTendContactPoint` is null.)

    Historical note, since it was twice a live bug: the `medic-tend` rung used to return `STANCE_STAND`
    for any medic, then briefly for a medic under fire. Nothing in `chooseBotStance` is medic-aware any
    more — if a future change wants a standing tend back, it needs a new ctx field, not the old ones.

### The kneel stance (`STANCE_KNEEL`)

One knee down, sitting between crouch and prone on the exit-cost ladder and on speed, spread, and
turn rate. The pose itself lives in `player-procedural-body.js` (`KNEEL_DEFAULTS`, `state.kneel`) and
had been fully built but driven by nothing until this wiring.

Three rungs take it, and the third is the interesting one:

- **`medic-tend`** — replaces the crouch outright, as above.
- **Commanded hold** — kneel now, prone once `proneMinHoldMs` (1200 ms) has elapsed *and*
  `proneEnabled` is on. Prone is opt-in and time-gated, so before kneel existed an overwatching bot
  simply crouched indefinitely; kneel is the rung it actually reaches.
- **Long-range `aim`/`fire`** — kneel and crouch **coexist** rather than one replacing the other.
  Stand up close, crouch past `aimCrouchDistance` (8 m), kneel past `aimKneelDistance` (16 m). Kneel
  is the committed firing position that earns the longest shots; crouch stays the posture a bot can
  rise out of quickly. Each band has its own hysteresis, and the kneel band's is wider
  (`aimKneelHysteresisM` 2.5 m vs 1.5 m) because standing out of a kneel costs more.

Two things worth knowing before tuning it:

- **A kneeling bot is a TALLER target than a crouching one.** This rig's crouch is a deep squat
  (`crouchCfg.pelvisDrop` 0.62 parks the hip at ~0.40 m) while the kneel hip sits at a full thigh
  length, ~0.58 m. The derived capsule scales are ~0.74 kneel vs ~0.62 crouch. Kneel earns the
  long-range rung on **stability**, never on silhouette — the flat `kneelHeightScale` fallback (0.75)
  is deliberately above `crouchHeightScale` (0.68) so the two paths agree on the ordering.
- **`kneelEnabled` ships OFF and `bot-viewer-v3.html` opts in.** A viewer that lets the ladder pick
  kneel without wiring the rig's `kneel` channel and the `kneel01` weight renders a kneeling bot
  *standing*. `bot-viewer-v2.html` and `environment-viewer-v2.html` are not wired, so the module
  default has to leave them on exactly the behaviour they had. `blendStanceHeightScale` takes its
  kneel pair as **trailing optional arguments** for the same reason: their four-argument calls stay
  correct, not merely non-crashing.

**Kneel has its own authored weapon hold (`kneelHold`), added 2026-08-11.** The first wiring folded
`kneel01` into the crouch weight on the assumption that a kneeling body puts the gun at roughly the
crouch hold's height. Measured against the rig, it does not: kneeling shoulders ride 0.26 m *higher*
than crouching ones, so sharing the hold left a kneeling rifle 0.51 m below its own hands. Because
the mount is pinned at `feetY + 1.5` and never moves with stance, hold Y is the only thing that can
express a stance's shoulder drop — every stance therefore needs its own. Derivation, the numbers, and
the flat −0.09 `crouchHold` that the same shortcut had already baked in are in Contract 6 of
`docs/subsystems/procedural-body-weapon-contracts.md`.
  - **Tend contact distance** — the tend radius is the latch threshold for *starting* the channel
    (loose on purpose, and wider still for a fleeing patient), **not** a working distance. `updateMedicTend`
    calls `creepToContact`, a straight-line shuffle at `MEDIC_CONTACT_CREEP` (0.45) of move speed that
    closes to `MEDIC_CONTACT_RADIUS` (0.85 m) and then holds — without it the medic stopped up to 1.7 m
    short and treated an ally from beyond arm's length. Two 0.3 m capsules bottom out at 0.6 m under
    the pair pushout, so 0.85 m is always reachable and leaves the arm ~0.25 m to cover. Corpses are
    not in the living hash, so a revive has no pushout floor at all.

    `updateMedicTend` transfers `healAllyPerSecond` HP from the medic's packs into the ally;
    `stickyHealTend` keeps topping an ally past the (lower) select threshold up to `allyResumeHp01`.
  - **Heal-hold** — so the medic can actually close on a moving patient, `decideMedicDuty` leases a
    short hold on its heal target once within `healHoldRadius` (or already tending):
    `allyActor.healHoldUntil = now + healHoldLeaseMs` (+`healMedicXZ`). In the ally's own sentry a
    `beingHealed` guard makes the four **locomotion** states (`PATROL`/`SEEK`/`PURSUE`/`FLEE`) hold
    position (zero velocity, drop the path, face the medic) while still aiming/firing at a visible
    threat — `AIM`/`FIRE`/`KNIFE`/`COVER_HOLD` are already stationary and its own `BOT_HEAL` keeps
    priority. The lease auto-expires when the medic stops servicing. When a medic tops an ally back to
    `resume01`, it also clears that ally's own heal-retreat latch so it doesn't flee once released.
  - **Revive** — `maybeBuildReviveKit` fuses 3 packs into one `reviveKits` when full or when a
    revivable ally is down nearby. `MEDIC_TEND` on a corpse channels `reviveChannelMs`, then
    `reviveCombatBot` reverses `killCombatBot`'s teardown (rebuilds body + weapon or drops the ragdoll,
    restores visuals) and stands the ally up at `reviveHp`. A corpse is revivable for `reviveWindowMs`
    after death (`actor.diedAt`/`deathXZ`, stamped in `killCombatBot`).
  - **Cohesion** — out of combat a medic regroups toward its **local** group instead of patrolling
    (`updateMedicCohesionMovement` → `cohesionTarget`): the centroid is over teammates within
    `cohesionNeighborRadius` only (a global centroid would park a medic at the empty midpoint between
    two map-separated groups), and **fellow medics are excluded** from the snapshot so support units
    anchor on the fighting line rather than pair-bonding. If **no** teammate is within perception it
    returns null and the medic just patrols — deliberately **no across-map "nearest teammate"
    fallback**, since that turned every isolated medic into a homing pull toward the same far fighter
    and funneled them into one clump at a chokepoint far from anyone (the "isolated medics, no
    patients" bug). Moves only past `cohesionRadius`, stops `cohesionDeadzone` short (loose
    keep-together, not a follow tail). Trade-off: a medic that drifts fully clear of the team patrols
    until it (or the team) wanders back into perception, rather than actively chasing across the map.
  - **Tunables** — `botMedicSettings` (`healAllyPerSecond`, `reviveChannelMs`, `reviveHp`) in the
    viewer; radii/thresholds in `MEDIC_DEFAULTS` (`bot-medic.js`). State colors: `MEDIC_MOVE`/`MEDIC_TEND`
    are the mint/teal orbs.
  - **Known gap** — a global weapon change / "Randomize weapons" still overwrites a medic's sidearm
    (roles don't lock the loadout yet); env-viewer has no medic port.
- `environment-viewer.html` — the live wiring (host/solo only; bots never run on a guest):
  - **State**: a `botPlayers` Map (id → `{ bot, fsmState, lastFireAt, lastKnownTarget, lastSeenAt,
    pathMode, currentPath, patrolIdx, spawnPos, deadSince, wanderTarget, weaponId }`), alongside
    the existing `mpGuestPlayers` Map. `getKnownPlayerState`, `currentCombatPlayers`, and
    `getState`'s player list all fold bots in exactly like guests — this is the payoff of the
    spec's "combat is player-id-generic" finding: no branching needed in `applyCombatIntent`,
    `resolveWorldShot`, `mergePlayerCombatFields`, ammo, or `player-combat.js`. Bots are hittable
    by humans (and vice versa) and count toward explosion blast damage for free — except the host
    player specifically, who is only perceivable/hittable by bots while first-person-visible (see
    "Player visibility gate" below); that carve-out lives in `resolveWorldShot`/`pickBotTarget`,
    not here.
  - **Rendering**: `mpGhostRenderer` (previously only constructed for `host`/`guest`) is now also
    constructed for `solo`, since bots are host/solo-only sim and need somewhere to render even
    with no multiplayer session. `updateHostPlayerGhosts()` folds bot wire-poses in alongside
    guest poses and is called every `updateBots()` tick (previously only guest-state-driven); it
    also merges each bot's `playerCombat.getSnapshot(id).alive` into the pose so
    `GhostRenderer`'s death-pose handling (below) picks it up.
    Since 2026-07-27 that end-of-`updateBots()` call is the **only** one: spawn/despawn and every
    resolved shot (`applyCombatIntent`, which `botFire` goes through per bullet) just set
    `hostGhostsDirty`, so the pass runs once per frame instead of once per bullet — see
    `docs/subsystems/multiplayer.md` "Host/solo ghost refresh cadence".
  - **Nav grid**: a static full-map A* bake at map-load time, **shoot-house maps only**
    (`NO_ENVIRONMENT && mapCollider && loadedMap.bounds`) — `shoot-house.js`'s adapter exposes
    `bounds` (`{minX,maxX,minZ,maxZ}`, the absolute footprint) for this. The walkability test
    (`botNavWalkable`) samples `terrainHeight(x,z)` (a `mapCollider.raycastDown` probe) and
    accepts only points close to the map's constant floor height (0 on shoot-house) — a
    wall/pillar/cover top reads much higher and is correctly excluded, without needing to expose
    shoot-house's internal wall primitives. Walkable cells are also sampled (spread subset) as
    both bot spawn points and patrol stops.
    **Open/authored terrain maps** (2026-07-14) get real A* pathing too, just not a static bake —
    the maps in `maps/*-data.json` run 1200–4000m across, far too large to grid at any reasonable
    cell size. Instead `requestBotPath` builds a small window (`BOT_LOCAL_NAV_RADIUS` = 18m,
    `BOT_LOCAL_NAV_CELL` = 1.5m cells) centered on the bot fresh each time a path is requested,
    walkability from `botTerrainWalkable` (rejects underwater points — checked against
    `terrain.waterLevel`, which is synced from `loadedMap.seaLevel` on authored maps so the same
    test covers both — and points whose height differs too sharply from their neighbors —
    `BOT_TERRAIN_SLOPE_TOLERANCE` — so steep slopes and cliffs are excluded the same way shoot-house
    walls are, via a height discontinuity rather than a "near-zero floor" heuristic), and the goal
    clamped into that window. Once the window's path is consumed the bot is close enough to its old
    goal that a fresh window naturally makes progress toward a far-off target over several replans,
    without ever pathing the whole map at once. This applies uniformly to authored terrain maps
    (bounded, but far too big to bake) and fully open procedural terrain (unbounded — `terrainHeight`
    still resolves via the CPU height field/`loadedMap.heightAt` fallback either way). The debug
    panel shows a note when a session has no *static* nav grid, since the local-window approach is
    invisible from the outside.
    **Squad member terrain-trap fix (2026-07-15)**: `requestBotPath`'s local-window fallback used to
    beeline the bot straight to the raw goal (`[toXZ]`, ignoring walkability entirely) whenever A*
    found no walkable route to it. This was a latent gap since Phase 0 but bit hard once squad
    followers started chasing `squadMemberGoal`'s continuously-moving formation-ring point (Squads
    Phase 1, see below) — a formation point on the downhill/far side of a slope from a roaming
    leader hits this fallback far more often than the old fixed patrol/wander targets ever did, and
    the direct-line walk would take the bot straight down into a depression or across a slope it
    couldn't climb back out of, alive and still fighting the whole time, just visually buried up to
    the eyes. `requestBotPath` now retargets to `nearestWalkableInGrid`'s nearest walkable cell to
    the goal instead, only truly holding position (empty path, velocity zeroed) if that also fails.
    A per-bot `pathRetryAt` throttle (`BOT_PATH_RETRY_MS` = 500ms) stops a genuinely-stuck bot from
    rebuilding the local nav grid every single tick. Separately, `botTerrainWalkable`'s underwater
    check only ever looked at `loadedMap?.seaLevel`, which is `undefined` on open procedural
    terrain — bots could path straight into a lake there with no rejection at all; fixed by checking
    the unified `terrain.waterLevel` instead (same value, kept in sync for both cases already).
    **Retreat rally-point clump fix (2026-07-15)**: separately from the two spawn/path bugs above,
    an *already-active* squad could still visually clump after taking losses — `squad.order ===
    'retreat'` sent every surviving member's goal straight to the literal same `squad.spawnPos`
    point (the leader's XZ at squad-formation time), bypassing `squadMemberGoal`'s formation ring
    entirely, so the whole squad beelined onto one coordinate and `pushBotsApart` only separated
    them the bare minimum. Retreating non-leaders now keep their formation-ring offset
    (`formationOffset(squad.spawnPos, rec.formationAngle, SQUAD_FORMATION_RADIUS)`) around the
    rally point instead of the literal point itself; only the leader walks to `squad.spawnPos`
    directly.
    **Escape hatch for a bad-position (not just bad-goal) stall**: retargeting to the nearest
    walkable cell only fixes an unreachable *goal* — if the bot's own actual position ever falls
    outside `findPath`'s 6m start-snap radius (e.g. shoved there by `pushBotsApart`'s XZ-only
    collision correction), every retry fails identically regardless of goal, which would otherwise
    be a permanent stall. `rec.pathFailCount` counts consecutive throttled failures; at
    `BOT_STUCK_ESCAPE_RETRIES` (6, ~3s) the bot bypasses the nav grid and steers straight for
    `rec.lastSafePos` (see "Fall-through-map recovery" below) until either it arrives (resets the
    counter, normal pathing resumes) or a retry succeeds first. This is a bounded one-off recovery,
    not a substitute for real pathfinding. It used to target `rec.spawnPos`; see 2026-07-17 fix below
    for why that changed.
  - **FSM tick** (`updateBots(dt)`, called from `animate()` alongside the creature update):
    per bot, picks the nearest alive human (host + guests, never other bots or ClaudeCraft mobs)
    within `botSightRange` (panel-tunable, live) with an unobstructed `mapCollider.raycast` line
    of sight, drives `bot-activity.js`'s aim/fire/patrol/seek exactly as the harness does, fires
    by building the same `combat_intent` shape `fireGunFromCamera` builds (using `rec.weaponId`,
    the bot's own assigned weapon) and calling `applyCombatIntent(intent, botId)` directly
    (host-local), and steps physics via `stepBotPhysics`. "Seek tenacity" (`botSeekTenacitySec`,
    panel-tunable) bounds how long a bot keeps chasing a lost target's last-known position
    (tracked via `rec.lastSeenAt`) before giving up and returning to patrol.
  - **Bot/player collision** (2026-07-14): `pushBotsApart()`, called once per `updateBots()` tick
    after the FSM loop, does pairwise XZ position correction between every pair of alive bots and
    between each bot and the local human player — same style as the legacy creature viewer's
    `resolveCreatureCollisions`, O(n²) but trivial at the round-mode cap of 10 bots. Dead
    (fallen) bots are excluded. Bots do not push against guest players (their positions are
    network-interpolated ghosts, not something the host can correct).
  - **Death/respawn**: dead bots (`playerCombat` HP hits 0) sit inert. If `botRespawnEnabled`
    (panel checkbox, default on) they revive after `BOT_RESPAWN_MS` (4000, matching the existing
    ClaudeCraft `CC_RESPAWN_MS` human-death convention) at their original spawn point via
    `playerCombat.revive`, with a freshly-created bot entity carrying the same `rec.weaponId`.
    With respawn disabled, dead bots stay fallen indefinitely — in round mode this also means a
    dead bot keeps its slot (the round-mode top-up loop counts `botPlayers.size`, not "alive"
    bots), so round mode won't backfill a bot that dies with respawn off. Visually, a dead bot
    smoothly tips over (450ms, `tick()`-driven, not a snap) via `GhostRenderer`'s death pose (see
    `multiplayer.js` above) rather than just standing inert or vanishing.
  - **Threat awareness / alerting** (2026-07-14): getting shot, or even just shot *at* (a miss
    that passes within `BOT_NEAR_MISS_RADIUS` = 2.5m of a bot's capsule), sets that bot's
    `lastKnownTarget`/`lastSeenAt` to the shooter's current position — the exact same fields
    normal LOS-based spotting uses — so the existing SEEK state (and its `botSeekTenacitySec`
    decay) handles "go find out what's happening" for free, no separate alert-timeout system
    needed. `alertBotsToShot`, called from `applyCombatIntent` right after every hitscan/melee
    shot resolves (hit or miss), checks the shot's ray against every living bot's capsule (3D
    point-to-segment distance, clamped to the hit distance) and alerts anything close enough.
    Explosions alert the same way from `applyExplosionBlast`, using the thrower's position (or the
    blast center if the thrower's pose isn't resolvable) as the threat. `propagateBotAlert` then
    shares that same threat position with every other living bot within `BOT_ALERT_PROPAGATE_RADIUS`
    = 15m (a squad awareness radius), and the same propagation fires whenever a bot acquires a
    live LOS target (`botTickOne`'s `targetVisible` branch) — so a bot actively fighting also pulls
    in nearby squadmates, not just one that gets hit. While seeking a `lastKnownTarget` (as opposed
    to patrolling), `botFaceTarget` keeps the bot's yaw locked onto the threat's direction every
    tick (independent of `botFaceMovement`'s velocity-direction facing), so a bot advancing on
    a shooter visibly "looks toward" them the whole way in, and starts firing back the instant
    `pickBotTarget`'s normal LOS check clears (no special-cased "blind fire" — a bot still needs
    real line of sight to actually shoot).
  - **Player visibility gate** (2026-07-14): `hostVisibleToBots()` (`fpsMode && !localBodyThird`,
    the same predicate the FP viewmodel's own visibility already used, see `showVM` elsewhere in
    the file) gates the local host player out of bot perception AND hit-testing whenever they're
    not actually looking through their own eyes — third-person body view (`localBodyThird`, the
    'B' key) or the orbit/dev camera (`fpsMode === false`) both make the player invisible to bots.
    `pickBotTarget` simply never offers the host as a candidate while not visible; `resolveWorldShot`
    additionally strips 'host' out of the hit-test capsule list for any shot fired by a bot
    (`botPlayers.has(shooterId)`) while invisible, so a bot's shot can't physically register a hit
    on a body it was never allowed to aim at either. This carve-out is bot-specific — it does not
    affect human-vs-human (guest) combat or human-vs-creature/mob combat, and guests are unaffected
    entirely (bots never target guests differently based on this).
  - **Player immortality toggle** (2026-07-14, "Player" panel section, host/solo only):
    `playerImmortal` gates the two places host damage is actually applied —
    `applyHitDamage` (hitscan/melee) and `applyExplosionBlast` — skipping `playerCombat.applyDamage`
    and the hit-feedback audio/screen-shake when `hit.id === 'host'` / `pl.id === 'host'` and the
    toggle is on. Bot alerting still fires normally even when immortal (getting shot still counts
    as "shot at" for awareness purposes, it just does zero damage). Host/solo-local only — a guest
    toggling this has no effect, since guest damage decisions are made host-side, not locally.
  - **Spawn modes** (debug panel, "Combat Bots" section, host/solo only): **manual** (a "+ Spawn
    bot" button drops one bot at the next sampled spawn point / near the player on open terrain;
    "Despawn all bots" clears them) and **round** (auto-maintains a target count, topping back up
    every tick if a bot is removed — dying alone never lowers the live count when respawn is on).
    Both modes are switchable at runtime from the same panel (explicit product decision,
    2026-07-14 — the original spec left "hand-placed vs. round-based" as an open question; the
    answer is "both, toggleable").
  - **Body** (same panel, below Weapon; 2026-08-01): "Armoured bot" or "Human soldier", calling
    `setBotBodyKind` and then `GhostRenderer.rebuildBotBodies()`. Unlike the Weapon dropdown above
    it, this DOES apply to bots already on the field — the design is appearance only, so the live
    rigs are torn down and remade rather than leaving half the squad in the old body until it dies.
    `?botBody=soldier` sets it at load, applied before the `GhostRenderer` is constructed so the
    first bodies come out right instead of being built armoured and immediately rebuilt.
    bot-viewer-v2 has the same control as a cycling **Body:** button in its Body & ragdoll section,
    backed by `rebuildBotProceduralBodies()` and the same URL parameter.
    **Coincident-spawn fix for squads on open terrain (2026-07-15)**: `botSpawnSlot(index)` falls
    back to a fixed `pose.x + 6, pose.z` point (ignoring `index` entirely) whenever there's no
    authored map to sample `botSpawnPoints` from — true for all open procedural terrain. Since
    `spawnSquadAtSlot` calls it once per squad member with consecutive indices, every member of a
    squad spawned this way, until this fix, landed on the exact same point; `pushBotsApart`'s
    pairwise correction only pushes overlapping capsules the bare minimum apart, so the squad
    stayed visually clumped together indefinitely instead of spreading onto the formation ring.
    The fallback now spreads slots around the player using a golden-angle spiral (`ang = index *
    2.399963`, radius `6 + (index % 4) * 2.5`) so squad members spawn already separated.
  - **Weapon select** (2026-07-14): a dropdown of `weapons.js`'s hitscan weapons
    (`enabledWeapons().filter(w => w.mode === 'hitscan')` — melee/projectile weapons aren't wired
    into the bot FSM's aim/fire model) sets `botWeaponId`. Applied at spawn time only and
    remembered per-bot as `rec.weaponId`; changing the dropdown doesn't retroactively re-equip
    bots already on the field, including through a respawn (the respawned bot keeps `rec.weaponId`
    from its original spawn, not whatever the dropdown currently shows).
  - **Behavior/trait sliders** (2026-07-14, panel): Health (`botMaxHp`, spawn-time trait, passed
    to `playerCombat.ensurePlayer`'s `maxHp`/`hp` opts — existing bots keep whatever max they
    spawned with), Move speed (`botMoveSpeed`), Sight range (`botSightRange`), Seek tenacity
    (`botSeekTenacitySec`), Notice time (`botNoticeTimeSec`), and Accuracy (`botAccuracy`) — all
    six except Health are read live every tick by all active bots, so moving those sliders affects
    bots already on the field immediately.
  - **Ammo/reload** (2026-07-14 third pass): `botFire` no longer calls `ensureAmmo`/`reloadAmmo`
    itself — `botTickOne` checks ammo before allowing `readyToFire`, and an empty mag starts a
    `BOT_RELOAD_MS` (1800ms) timer instead of refilling instantly. While reloading, `readyToFire`
    is false, so `chooseBotState` keeps the bot in `BOT_AIM` (tracking the target, not firing)
    until the timer elapses and the mag actually refills. Previously `botFire` called
    `reloadAmmo` the instant the mag hit 0, right before firing again — bots never ran dry.
  - **Tree/rock-aware perception and pathing** (2026-07-14 third pass): `botHasLineOfSight`
    previously only raycast against `mapCollider` (map/wall geometry) — trees and rocks
    (`trunkIndex`/`dressingIndexRef`, the same spatial indices the player's own movement collision
    uses) weren't checked at all, so a bot could lock onto and fire at someone standing behind a
    tree or boulder as if it wasn't there. It now runs the exact same occlusion pipeline a real
    shot resolves against (`resolveHitscan` with `obstacleColumnsAlongRay`'s tree/rock columns
    plus the map BVH occluder). `botTerrainWalkable` (the local-window nav test, see above)
    likewise now rejects any cell within `BOT_NAV_OBSTACLE_RADIUS` (0.3m, matching the bot
    capsule's own radius) of a trunk or rock circle (`trunkIndex.resolve`/`dressingIndexRef.resolve`),
    so `requestBotPath` routes around forest/rocks instead of clipping straight through them.
    Shoot-house's static bake (`botNavWalkable`) is unchanged — it's an indoor map with no forest.
  - **Notice time and accuracy** (2026-07-14 third pass): a freshly-spotted target isn't
    fireable-at immediately, even at zero aim error — `rec.targetAcquiredAt` is stamped on first
    spotting a target (`targetVisible` transitioning false→true) and `readyToFire` additionally
    requires `botNoticeTimeSec` (default 0.6s, panel slider 0-3s) to have elapsed since; losing
    sight resets the clock, so re-spotting notices again. `botAccuracy` (0-100%, default 60,
    panel slider) jitters only the *fired shot's* direction in `botFire` (up to
    `BOT_MAX_SPREAD_RAD` = 0.15 rad at 0% accuracy) — the bot's own visible aim (`bot.yaw`/`pitch`)
    stays exactly on target, so a low-accuracy bot still visibly aims right at you, it just doesn't
    always land the hit. Previously bots fired the instant `aimError` cleared tolerance with zero
    spread, which could mean an instant, perfectly-accurate shot the moment a target came into view
    at close range.
  - **LOS check throttled, notice-time grace window** (2026-07-14 fourth pass, code review of the
    third pass): `botHasLineOfSight` reuses the real shot-resolution pipeline
    (`resolveHitscan`/`obstacleColumnsAlongRay`), which is correct but not cheap — it was being
    re-run every single frame for every bot × every candidate (host + guests) via `pickBotTarget`,
    where before this pass that pipeline only ran when a shot was actually fired. `pickBotTarget`
    now splits into `nearestBotCandidate` (cheap, distance-only, still called every frame so aim
    tracking stays smooth) and a throttled raycast cached per bot (`rec.losVisible`/
    `rec.losTargetId`/`rec.nextLosCheckAt`, `BOT_LOS_CHECK_INTERVAL_MS` = 120ms) that's forced to
    refresh immediately if the nearest-candidate identity changes. Separately, `rec.targetAcquiredAt`
    (the notice-time clock) used to reset to `null` the instant `targetVisible` went false for even
    one tick — a target strafing behind a branch or doorframe could keep re-triggering the reaction
    delay and never let a bot reach `readyToFire`. `rec.lastVisibleAt` now tracks the last tick the
    target was actually seen, and the clock only resets after `BOT_NOTICE_GRACE_MS` (400ms) of
    continuous invisibility, not the first missed tick.

## Bot weapon rendering / third-person mount (2026-07-19)

Bots hold a visible third-person weapon via a **per-bot mount**, separate from `GhostRenderer`'s
body: each mount is a `weaponRig` group (added directly to `scene`) carrying a cloned weapon model
plus muzzle/barrel markers, driven by a `weapon-pose-controller.js` instance that resolves both hand
IK targets from the gun's live world transform. Lifecycle lives in `environment-viewer.html`
(`createEnvironmentBotWeaponMount` / `requestEnvironmentBotWeaponMount` /
`updateEnvironmentBotWeaponMount` / `destroyEnvironmentBotWeaponMount`, ~`:7746-7943`;
`syncEnvironmentBotWeaponMounts` runs it per bot each `updateBots` tick). This is a near-copy of
`bot-viewer.html`'s single-bot mount, and the port went poorly — see
`docs/superpowers/reviews/2026-07-19-bot-port/` (five investigation docs + `PLAN-fable-review.md`).
Phase 1 of that plan (this pass) fixed the two shipped bugs:

- **Invisible arms/weapon — terrain-relative rig Y.** The mount used to cache
  `bodyMountOffsetY = 1.5 - torso.y` and place the rig at `torso.y + bodyMountOffsetY`, copied
  verbatim from `bot-viewer.html`, whose body is built with `terrainHeight: () => 0` on a y=0 floor.
  On real terrain that pins the rig (gun + **both** grip-driven arm IK targets) to absolute y≈1.5 —
  i.e. buried under the ground by the terrain height, so the gun renders underground and the arms
  reach-clamp straight down inside the torso column (reload's body-relative left-hand keys still
  animate at the chest, the one visible motion; shots still fire from the capsule eye). Fixed to
  `weaponY = terrainHeight(weaponX, weaponZ) + 1.5`, matching the local player mount (the authored
  `thirdPersonHold` offset carries the vertical drop). `bot-viewer.html` is left as-is — floor=0
  makes the two conventions equivalent there.
- **Per-bot uncached GLTF load → shared template cache.** Each bot used to run its own
  `new GLTFLoader().loadAsync(def.model)` with no cache and no `skeletonClone`. Now bots reuse the
  local player's `lbWeaponModelCache` (normalize-once template) and clone per mount via
  `skeletonClone` (skinned-mesh-safe, shares geometry/materials) — N network fetches + N parses
  collapse to one per weapon id. Because geometry/materials are now shared, neither
  `destroyEnvironmentBotWeaponMount` nor the local player's `teardownLocalWeaponMount` disposes them
  (they only `scene.remove` the rig) — disposing a clone frees GPU buffers out from under every other
  live clone of that weapon.
- **Retry backoff.** A failed/bailed mount build used to re-request every frame (a per-frame GLB
  reload loop if a load persistently failed). `botVisualWeaponMountRetryAfter` (id → `perf.now()`
  gate, mirroring `lbWeaponMountRetryAfter`) throttles re-requests to 800ms after a failure and is
  cleared on success or `destroy` — degrading a persistent failure to "idle arms, no gun".
- **Inspector mount readout.** The Bot Inspector's selected-bot text now shows a `mount:` line
  (`ready`/`building`/`retry Ns`/`none`, `rigY`, `muzzleY`, `terrainY`) so this class of bug is a
  glance instead of a console dig.

**DRACOLoader (2026-07-20).** Every weapon-mount `GLTFLoader` — `bot-viewer.html`'s and both of
`environment-viewer.html`'s (local third-person + bot visual mount) — now wraps its loader with
`attachDracoLoader()` from `draco-loader.js`. Weapons compressed via the new
`weapon-viewer-v2.html` Compress panel carry `KHR_draco_mesh_compression`, which a bare
`GLTFLoader` can't parse; see `docs/subsystems/weapon-compression.md`.

### Phase 2 perf — geometry sharing + bots-only render LOD (2026-07-19)

Bots render through `GhostRenderer` → `createProceduralPlayerBody` (one full rig per bot, ~31 meshes).
Phase 2 cut the per-frame and per-spawn cost without changing the (still per-mesh, non-instanced)
draw-call count — that's Phase 4:

- **Shared body geometry** (`player-procedural-body.js`): every body tessellates identical geometry
  from the fixed `H=1.8/R=0.35` constants (sized per-instance only via `mesh.scale`), so a
  module-scope `_sharedBodyGeo` cache now hands every body one `BufferGeometry` per shape+dims
  instead of rebuilding ~31 per body. Shared geos are tagged `userData.shared`; `destroy()` skips
  disposing them. Cuts N× lathe tessellations + GPU buffers at spawn, zero visual change. **Materials
  stay per-body** (per-bot color is a design requirement — do not collapse to one shared material;
  true material sharing is deferred to Phase 4's per-instance color attribute).
  - **Cache lifecycle (NPC-suite prep, P1).** `createProceduralPlayerBody` takes an optional
    `cache` (default `_sharedBodyGeo`), so a permanently-alive consumer can inject its own pool. Each
    body records the geometry keys it touches at build (`beginRecord`/`endRecord`) and releases them
    in `destroy()` — in **both** mesh and instanced mode, before the instanced early-return — so the
    consumer can `sweep()` only truly-unreferenced geometry instead of the nuclear
    `clearSharedBodyGeometry()`. Liveness is declared at build, so the LOD twin at `:1112` (minted but
    never drawn) is retained for free. Node-covered by `test-geometry-cache.mjs`.
- **Bots-only body LOD** (`multiplayer.js` `GhostRenderer`): constructed with `getCameraPos` +
  `botLod` ({`nearD2,midD2,hideD2`}, set in `environment-viewer.html`'s `BOT_RENDER_LOD` =
  45/100/240 m). `_updateProceduralBodyLod` runs the full procedural solve every frame under 45 m,
  every 2nd frame under 100 m, every 4th under 240 m (staggered by a per-ghost `lodPhase`), and hides
  the body entirely past 240 m. Humans/local players and dead actors are exempt (full detail always).
  This caps per-frame CPU regardless of bot count — the load-bearing change for high counts.
- **Held-weapon LOD** (`updateEnvironmentBotWeaponMount`): the same distance tiers gate the weapon
  mount so the gun freezes/hides in step with its body; skipped-frame `dt` is accumulated so reload
  animation still plays at wall-clock rate. `botWeaponLodFrame`/`botLodPhase(id)` drive the stagger.
- **Allocation hygiene** (`player-procedural-body.js` `update()`): the per-side leg/arm attach
  vectors and the loop-invariant idle-arm offsets no longer allocate fresh `Vector3`s each frame
  (hoisted to factory scratch/constants; `solveLeg`/`solveArm` read them read-only).

Deferred within Phase 2: secondary sim throttles (`propagateBotAlert` cadence, per-bot nav-window
cache) — minor at current counts.

### Phase 4 perf — instanced bot rig with per-instance color (2026-07-19)

The load-bearing draw-call fix for unbounded bots. Before this, each bot body was ~31 individual
draw calls (`player-procedural-body.js`'s per-part meshes); N bots ⇒ ~31·N draw calls. Phase 4
collapses every bot's body parts into a shared `InstancedMesh` pool so N bots cost ~one draw call
**per part type** total, independent of bot count. Mirrors the creature system's
`createCreaturePartBatches` (`port-creature-system.js`).

- **`body-part-batches.js`** (new) — `createBodyPartBatches({ THREE, scene, capacity=8192 })`. One
  `InstancedMesh` bucket per distinct shared body geometry (keyed by `geometry.uuid`; bodies already
  share geometry via Phase 2's `_sharedBodyGeo`), 4 shared role materials (shell/plate/trim = white
  + per-instance color; eye = flat black, never colored so its `instanceColor` stays unallocated).
  Immediate mode: `beginFrame()` zeros counts, each visible bot `add()`s its parts, `endFrame()`
  uploads. Soft-fails past `capacity` (drops instances, counts `stats.dropped`) — the hard-cap
  policy for now. Geometry is never disposed here (owned by the body cache).
  **`dropBucket(geometry)` / `dropBuckets(geometries)`** (NPC-suite prep, P1b) — evict the bucket(s)
  for specific geometries on demand instead of after `evictAfter` empty frames. A shell-owned pool
  that must survive mode switches can't dispose-and-recreate the whole pool the way the two current
  clear sites do; this lets it drop exactly the buckets whose geometry the cache is sweeping, in the
  same tick. Pairs with `createGeometryCache().sweep(keep, onDispose)` — pass
  `geo => batches.dropBucket(geo)` as `onDispose`. Never disposes the geometry (the cache owns that);
  safe in either order since a geometry's uuid survives its own `dispose()`. Frame-count eviction and
  this share one internal `evictBucket` helper. Node-covered by `test-body-part-batches-drop.mjs`.
  **`raycast(raycaster) -> {point, normal, role, distance, instanceId} | null`** (added for
  `damage-simulator.html`) — closest hit across every bucket, tried each in turn since
  `Raycaster.intersectObjects` has no way to attribute a hit back to a bucket's role. `role` is the
  bucket's **material** role (shell/plate/skin/…), not an anatomical part — there is no per-instance
  body-part label anywhere in this pool (see `player-procedural-body.js`'s `flush()`: `add()` only
  ever receives `part._role`). `normal` comes back rotated into world space by hand (that instance's
  `getMatrixAt` composed with the bucket mesh's `matrixWorld`) since `InstancedMesh` raycasts return
  the hit face's normal in the instance's local geometry space, not pre-transformed.
- **`player-procedural-body.js`** — new `batches` option turns on instanced mode. Parts become
  transform-only `Object3D` placeholders (carry their shared geometry + a role tag; never rendered);
  `update()`'s IK/pose math is byte-for-byte unchanged. A new `flush(pool, refreshMatrices = true)`
  walks the group via `updateMatrixWorld(true)` (skippable — see the Phase 5 M10 note) and emits
  each visible part's world matrix + role color into the pool.
  No per-body materials or scene node are created in instanced mode; `destroy()` just drops the
  placeholder list. **Bots only** — the local player and human ghosts keep the proven per-mesh path
  (gated by `batches` being null), so the visually-scrutinized cases carry zero regression risk.
- **`multiplayer.js` `GhostRenderer`** — new `instanceBots: true` option (set in all three
  `environment-viewer.html` constructions). Lazily builds one shared `_bodyBatches` on the first bot
  body; `_updatePlayers` wraps the loop in `beginFrame()`/`endFrame()`; `_updateProceduralBodyLod`
  flushes every **visible** bot every frame (even on IK-strided frames, so the held pose persists;
  hidden bots aren't flushed → absent from the batch). Per-bot color comes from `botBodyStyle(id)`
  (distinct hue per id hash → shell/plate/trim), fed as the body `style` and read back as the
  instance colors.
- **Not instanced:** the held weapon (a cloned skinned GLB per bot — skinned meshes don't instance
  cheaply; already one-parse-then-clone via the Phase 1 template cache). That per-bot weapon draw is
  the remaining tail at very high counts (accept, or add a distant-weapon LOD cut later).

Tests: `test-body-part-batches.mjs` (bucketing/immediate-mode/soft-fail/dispose). Existing
`test-player-body-{gait,ik}.mjs`, `test-ghost-renderer.mjs`, `multiplayer-test.mjs` stay green (mesh
path unchanged when `batches` is null). **Browser QA pending** — instanced render is runtime-only.

Phase 3 (`port-bot-bridge.js` adapter) was folded into the clean `body-part-batches.js` module
boundary rather than a full host-file extraction (no perf value; high code-motion risk).

### bot-viewer.html perf pass (2026-07-20)

The standalone harness lagged with bot count, worse with mesh-heavy weapons (RPG GLB = 50 meshes /
104 nodes, CZ = 16 meshes / 12 materials, vs. M24 = 5 / 9). Same root causes as the main viewer,
fixed the same way:

- **Weapon template cache** (`loadBotWeaponTemplate`): each weapon GLB is loaded + normalized +
  anchor-baked once into `botWeaponTemplateCache`; every mount is a `skeletonClone(template)`
  (SkeletonUtils) sharing geometry/materials. Plain `clone(true)` breaks the skinned GLBs
  (m1911, cz_805_bren, mk2_grenade): clones stay bound to the template's bones, so every bot's
  rifle renders stacked at the bind pose, detached from the rigs. `destroyBotWeaponMount` no
  longer disposes (assets are cache-owned for the page lifetime; a failed load evicts its cache
  entry for retry).
- **Shadows**: the overhead point light no longer casts shadow (was 6 cube-face passes/frame —
  every weapon mesh of every bot rendered 8×/frame). The directional light keeps its shadow; the
  point light stays as fill. Weapon meshes keep `frustumCulled = false` (matches
  environment-viewer's mounts: skinned meshes cull by bind-pose bounds, not bone-driven
  vertices, so culling makes held guns blink out) — they now cost 2 passes instead of 8.
- **Instanced bodies**: `createBotProceduralBody` now passes a lazily-created shared
  `createBodyPartBatches` pool (`botBodyBatches`); the animation loop brackets `updateAllBots` with
  `beginFrame()`/`endFrame()` and flushes every `actor.body` each frame (immediate mode: an
  unflushed body vanishes for that frame; dead bots have `actor.body === null` so they drop out
  naturally).
- **Matrix/alloc cost** (`weapon-pose-controller.js`, shared with the main viewer): the per-update
  forced full-subtree `updateMatrixWorld(true)` walks became ancestor-only
  `updateWorldMatrix(true, false)` (only `matrixWorld` of the queried node is ever read), and the
  hot path reuses controller-scoped scratch objects (`worldTransformOf`/`toThree`/pose Euler)
  instead of allocating per frame. `updateBotWeaponMount`'s and `alignMountedWeaponToPoint`'s
  forced rig walks were dropped/shrunk to match. Public API and pose math unchanged
  (`test-weapon-pose-controller.mjs` green).

**Browser QA pending** — render-side effects (culling, shared GLB clones, instanced bodies in the
harness) are runtime-only; Node suites (`test-weapons`, `test-weapon-pose-controller`,
`test-bot-activity`, `test-body-part-batches`, `test-player-body-gait`) all pass.

## Squads (Phase 1)

Pure decision logic lives in `squad-activity.js` (THREE-free, Node-tested via
`test-squad-activity.mjs`), wired into `environment-viewer.html`:

- `SQUAD_LOSS_THRESHOLD` (0.4), `rollTemperament(min, max, rand)`, `tickSquadLossDecision(...)`
  (edge-triggered, latched loss-retreat roll — see the module for exact latch semantics),
  `formationAngleFor(memberIndex, memberCount)`, `formationOffset(leaderPos, angleRad, radius)`,
  `columnOffset(leaderPos, headingRad, memberIndex, spacing)`,
  `chooseFormationKind({ manual, engaged, corridorClear })`, `pickExploreGoal({...})` — the latter
  three added 2026-07-19, see "Exploration & formations" below.
- **State**: `botSquadModeEnabled` (panel toggle), `botTemperamentMin`/`Max` (panel sliders,
  default 0.15/0.85), `SQUAD_MIN_SIZE` (5), `SQUAD_FORMATION_RADIUS` (8m), `SQUAD_COLUMN_SPACING`
  (3m), `BOT_RETREAT_SPEED_MULT` (1.45), a `squads` Map (`squadId -> { id, outpostId: null,
  teamId: 'bots', leaderId, memberIds, initialSize, order, orderTarget, lossRetreatDecided,
  spawnPos, formationMode }` — `outpostId`/`teamId` are placeholders for Phase 4, unused this
  phase; `formationMode` is `'auto' | 'ring' | 'column'`, see below). Every bot rec (squadded or
  not) gets `squadId`, `isLeader`, `temperament` (rolled once at spawn between the temperament
  sliders), `formationAngle`, and `memberIndex` (rank within the squad, 0 = leader — used for the
  column formation's spacing).
- **Formation**: `formSquad(botIds)` builds a squad record from a batch of already-spawned bot
  ids (first id is the leader), assigns each member's `formationAngle`/`memberIndex`, and captures
  the leader's spawn position as `squad.spawnPos`. `spawnSquadAtSlot` spawns `SQUAD_MIN_SIZE` bots
  via the existing `spawnBotAtSlot` and forms them. When `botSquadModeEnabled`, both manual spawn
  and round-mode top-up spawn in squad batches instead of one bot at a time; with the toggle off,
  spawning is byte-identical to the pre-squads behavior.
- **Movement**: `squadMemberGoal(rec)` — a non-leader with no patrol path in flight orbits the
  live leader position on a ring or trails it in single file (`chooseFormationKind`, see below),
  falling back to the existing `nextPatrolTarget` (exploration, see below) only if unsquadded or
  leaderless. Any squad member (leader included) heads for `squad.spawnPos` (ring offset, not the
  literal point) instead when `squad.order === 'retreat'`. `followBotPath` (the sole
  `botMoveSpeed` read site) multiplies by `BOT_RETREAT_SPEED_MULT` for a retreating bot's squad.
- **Per-tick squad logic**: `updateSquads()`, called from `updateBots` right after the per-bot FSM
  loop (before `pushBotsApart()`). Per squad: computes `aliveCount` from `playerCombat.getSnapshot`,
  calls `tickSquadLossDecision` with the leader's `temperament` (cautious/low-temperament leaders
  retreat more readily once ≥40% of `initialSize` is lost), sets `order = 'retreat'` on a true
  roll, and promotes the first other alive member to leader when the current leader is dead
  (flips `isLeader` on both). Attack/hold orders otherwise come only from the panel's manual
  per-squad Retreat/Attack buttons — no AI outpost-leader exists yet (Phase 4).
- **Panel**: "Squads & Outposts" section — squad-mode checkbox, temperament min/max sliders, a
  live per-squad roster readout (id, alive/total, current order), manual Retreat/Attack buttons,
  and a Ring/Column/Auto formation dropdown per squad.
- **Scope**: squads only, uniform spawn placement (no density gradient yet), no ammo/medkit
  economy, no outposts, no drops — see the design spec's Phasing section for Phases 2-4.
  Interactive browser verification (formation-follow, retreat behavior, leader succession, the
  loss-threshold auto-retreat roll) is still outstanding — the above was verified via `node
  --check`, the full `test-*.mjs` suite, and static code reading, not an in-browser playtest.

### Exploration & formations (2026-07-19)

Replaced the old "random point within a leash radius of spawn" wander (`nextPatrolTarget`'s
open-terrain branch) with directional exploration, and added a single-file formation alongside the
existing ring — both driven by new pure functions in `squad-activity.js`
(`pickExploreGoal`/`chooseFormationKind`/`columnOffset`, Node-tested in `test-squad-activity.mjs`).
Applies to unsquadded bots and squad leaders; squad members are unaffected (they always follow
their formation slot). Shoot-house's fixed round-robin spawn-point patrol (`botSpawnPoints`) is
unchanged — this only replaces the open/authored-terrain branch of `nextPatrolTarget`.

- **Exploration**: every bot rolls a fixed `exploreHeading` (random compass angle) once at spawn
  and keeps it for its lifetime. `nextExploreGoal(rec)` hands `pickExploreGoal` the bot's *current*
  position (not spawn), so goals chain outward hop by hop rather than orbiting one point: each hop
  is `BOT_EXPLORE_MIN_DIST`-`BOT_EXPLORE_MAX_DIST` (80-300m) out, jittered up to
  `BOT_EXPLORE_CONE_JITTER` (±30°) off the fixed heading, rejected and re-rolled (up to a handful
  of attempts) if it lands within `BOT_EXPLORE_EXCLUSION_RADIUS` (50m) of any of the last
  `BOT_EXPLORE_HISTORY_SIZE` (6) goals so a bot doesn't immediately double back over ground it just
  covered. A new goal is picked on arrival (`BOT_EXPLORE_ARRIVE_DIST`, 5m) or when the stuck-escape
  hatch resolves (`botTickMovement`'s escape-recovery branch now also clears `rec.exploreGoal`, so
  a bot that got stuck heading for one goal doesn't immediately re-request it). No water/map-bounds
  handling lives in `pickExploreGoal` itself — the raw candidate is handed straight to the existing
  `requestBotPath`, whose local-window A* already retargets an unreachable goal (water, a cliff, off
  the map edge) to the nearest walkable cell within its search window and re-centers that window on
  the bot every replan as it walks, which was already the right behavior for a goal that's initially
  out of range.
- **Formations**: `SQUAD_FORMATION_RADIUS` widened 5m → 8m. New `columnOffset(leaderPos,
  headingRad, memberIndex, spacing)` places single-file members `SQUAD_COLUMN_SPACING` (3m) apart,
  trailing directly behind the leader along its *live movement heading* (`bot.yaw`), not the fixed
  exploration heading, so the line bends naturally through corridors instead of staying
  compass-locked. `chooseFormationKind({ manual, engaged, corridorClear })` decides ring vs. column
  every tick, in priority order: (1) a squad's `formationMode` (`'ring' | 'column'`, set via the
  panel dropdown) wins outright over anything else; (2) with `formationMode: 'auto'`, active
  combat (`leaderRec.fsmState !== BOT_PATROL`) forces ring — coverage matters more than corridor-fit
  mid-fight; (3) otherwise `squadCorridorClear` samples walkability `SQUAD_FORMATION_RADIUS`
  perpendicular to the leader's heading on both sides (via `botNavWalkable` or `botTerrainWalkable`,
  whichever backs the active map) — clear on both sides picks ring, blocked on either side picks
  column. `squadMemberGoal` applies the chosen kind's offset each tick.

Not yet done: interactive browser verification (goal chaining actually covers ground over a long
session, the exclusion radius visibly prevents backtracking, the auto ring/column switch triggers
correctly at a real corridor mouth) — verified so far only via the pure-function unit tests, `node
--check`, and the full `test-*.mjs` suite, same caveat as the rest of this Squads section.

## Squads in the v2 harness (2026-07-26, `bot-viewer-v2.html`)

A **second, unrelated** squad implementation. The Phase 1 system above is wired into
`environment-viewer.html` on top of that viewer's older bot FSM; this one is built on the v2
harness's authoritative FSM (cover, alerts, roles, medic, bounding overwatch). They share no code.
The intent is that this one absorbs the Phase 1 feature set (temperament, loss-retreat, outposts,
ammo) and both ship together via `docs/superpowers/plans/2026-07-26-bot-v2-env-viewer-port-plan.md`
— at which point `squad-activity.js` retires. **Status (2026-07-30):** retired inside
`environment-viewer-v2.html` by the Phase C½ port below; `environment-viewer.html` (v1) still
imports it, so the module and its test stay. Temperament and loss-retreat were dropped rather than
absorbed — the v2 model expresses morale through succession shock and the flee/heal ladder.

### Design rule

Squad state is a **bias source, never an override**. `updateSquadFormationMovement` is only reached
from the out-of-combat branch of `updateBot` (after pack-seek, before medic cohesion and patrol), so
a squad can only ever redirect movement that was already idle. Nothing in the squad layer writes to
a bot's FSM state, cover state, or aim. A leaderless squad simply falls through to patrolling.

### `bot-squad.js` (pure, THREE-free, Node-tested via `test-bot-squad.mjs`)

- `SQUAD_MAX_SIZE` (8), `SQUAD_MIN_SIZE` (2), `SUCCESSION_SHOCK_MS` (1800),
  `FORMATION_KINDS` (`wedge`/`column`/`line`/`ring`), `SQUAD_DEFAULTS`
  (`spacing` 2.4 m, `ringScale` 2.5, `slotArrive` 1.2 m, `leash` 22 m).
- `partitionSquadSizes(count, maxSize)` — balanced split (11 → `[6,5]`, never `[8,3]`).
- `squadRoleTemplate(size, { medicPercent, mix })` — slot 0 is always `ROLE_SQUAD_LEADER`; the tail
  inherits `assignRolesToBatch`'s specialist spread.
- `dealSquadChunks(members, sizes, isLeader)` — splits a spawned batch into per-squad chunks,
  seeding each with a leader-role member first. A caller-supplied role list has no per-squad layout,
  so a plain slice could hand one chunk every leader and leave the next leaderless.
- `electSquadLeader(members)` — highest `leadership` among **living** members, ties on lowest id.
- `stepSquadSuccession({ leaderId, members, now, shockUntil, shockMs })` — pure state step. A dead
  leader leaves the squad leaderless for `shockMs` **before** anyone is promoted, so decapitating a
  squad costs it something. Returns `{ leaderId, shockUntil, shocked, changed }`.
- `chooseFormationKind({ manual, engaged, corridorClear })` — manual wins; contact → `line`;
  narrow corridor → `column`; else `wedge`.
- `formationOffsetLocal(kind, rank, count, spacing)` → `{ right, back }` in the leader's frame.
- `squadSlotWorld({...})` — world XZ. `headingRad` follows `bot.yaw` (0 = +Z), so forward is
  `(sin, cos)` and right is `forward × up` = `(-cos, sin)`. **`ring` is world-anchored** (fixed
  per-rank angle) so it does not spin as the leader turns; the other three rotate with the heading.
- `squadMemberGoal({...})` → `{ x, z, arrived, regrouping }`. Past `leash` from the leader a member
  heads for the leader itself — its slot may be through a wall by then.
- `formationHalfWidth(kind, count, spacing)` — what the corridor probe has to fit.

### Wiring in `bot-viewer-v2.html`

- **State**: a `squads` Map (`squadId -> { id, team, memberIds:Set, leaderId, successionShockUntil,
  shocked, liveCount, kind, engaged, leaderPos, leaderYaw, hasLeaderPos, corridorClear,
  corridorAt }`), `squadIdSeq`, `botSquadModeEnabled` (default off), `botSquadSize` (default 8),
  `botSquadFormation` (`'auto'`), `botSquadSettings` (`SQUAD_DEFAULTS` + `slotRepath` 1.0,
  `corridorProbeMs` 300). Per-actor: `squadId`, `squadRank` (rank among **living** members, `-1`
  when dead/unsquadded).
- **Spawn**: `spawnBots` calls `planSquadIntake(team, total)` → reinforcements first top up
  understrength same-team squads (`fillSquadOpenings`, oldest squad first, spawning as
  riflemen/medics), and the remainder is split by `dealSquadChunks` and bound by `formSquad`.
  This stops a drip of auto-add waves from shattering a team into two-bot squads. `formSquad`
  elects immediately — leaving it to the first tick would read as a dead leader and open the
  squad's life inside a succession shock.
- **Every spawn path forms squads**, not just the ones that let `spawnBots` pick roles. Rostering is
  gated on `botSquadModeEnabled` alone; a caller supplying its own `roles` (auto-add waves, a scene
  shuffle replaying a captured roster) keeps its roles and gets rosters anyway, with `formSquad`
  electing a leader out of whoever landed in the chunk. Only the role *layout* comes from `intake`.
- **Per frame**: `updateSquads(now)` runs in `updateAllBots` right after `updateWorldHealthPacks`
  and **before** the actor loop, so leaders/ranks/formations settle before any member reads them.
  It prunes departed members, deletes empty squads, runs succession, restamps `squadRank` over the
  living only (so a formation closes up over its casualties), sets `engaged`, and resolves `kind`.
- **Heading**: the formation hangs off the leader's `patrolTravelHeading`, **not** `entity.yaw` —
  aim yaw sweeps on every A4 scan glance and would slide the squad sideways. Falls back to
  `entity.yaw` when the leader is stationary.
- **Corridor probe**: `squadCorridorClear` samples the nav grid at ±`formationHalfWidth` either side,
  `SQUAD_CORRIDOR_LOOKAHEAD` (1.5 m) ahead. Throttled to `corridorProbeMs` — probing every frame
  makes the formation flap between wedge and column in a doorway.
- **Chevron**: gold, built by `buildRoleInsignia('chevron')`. As of 2026-08-07 it's a marker
  independent of role, stored on `actor.leaderInsignia` (separate from `actor.roleInsignia`, the
  class marker): `setSquadLeaderMark` grows it on whoever `squad.leaderId` currently is and removes it
  on demotion, regardless of role — so a promoted rifleman shows its diamond *and* the chevron, and a
  spawned `ROLE_SQUAD_LEADER` (whose own class insignia is also a chevron) shows both stacked while
  it's actually leading. `updateRoleInsignia` positions the two independently, stacking the leader
  chevron above the class marker when both are present; `updateAlertMark`'s height accounts for either
  or both being on screen.
- **`applyPushElement` (S11)** now reads the roster's `squadRank` when the bot is squadded, and only
  falls back to the original emergent `squadMembersNear` + sort + `indexOf` when it is not — that
  fallback ran per bot per frame during a push, so rosters are also the cheaper path.
- **Panel**: a "Squads" section — `Squads: On/Off`, `squad size` (2..8), `formation`
  (auto/wedge/column/line/ring), `spacing (m)`, `Form squads from existing bots`,
  `Squad overlay: On/Off`, and a live roster list. Persisted in the bots save/load slot under
  `squad: { enabled, size, formation, spacing }` (the overlay flag rides `debug.squadOverlay`).
  Toggling squad mode only affects **future** spawns, so it is safe mid-fight.
- **HUD**: the focused bot's health line gains `· squad-N (leader|#rank) [leaderless] · <kind>`.

### Debug visuals (2026-07-27)

Squad membership is otherwise invisible — bots in one roster look exactly like bots that happen to be
walking together, which made the first QA pass unreadable. Three readouts, all off by default:

- **`updateSquadDebug(now)`** (next to `updateInvestigationDebug`, called from the render loop) draws
  per squad: a colour-coded ground ring under every living member (the leader's at 1.5× scale), a
  tether from each follower to its `squadSlotWorld` slot, a dim ring on the slot itself, and a label
  sprite over the leader reading `squad-N  <kind>  live/roster`, which turns red and reads
  `LEADERLESS <countdown>` during a succession shock. Colours come from `squadDebugHex(squad.seq)`
  (golden-angle hues, so adjacent squads never collide).
- Debug objects are built lazily per squad, pooled (rings/slots grow to the largest roster seen and
  are then hidden, never destroyed), write tether vertices into a persistent `Float32Array` rather
  than `setFromPoints`, and repaint the label canvas only when its text changes. `disposeSquadDebug`
  is called both where `updateSquads` deletes an empty squad and in `removeAllBots`.
- **Roster list** in the panel: one row per squad (`squad-N  team  live/roster  kind  lead <id>`),
  coloured to match the 3D rings, polled at 4 Hz. This is the readout that works with the camera
  nowhere near the fight.
- **`formSquadsFromExisting()`** behind the `Form squads from existing bots` button — squad mode only
  shapes new spawns, so without this the only way to try squads was to clear the field first. It tops
  up understrength rosters before partitioning the rest. `formSquad` now also calls
  `setSquadLeaderMark` on the bot it elects: a squad formed this way has no spawned
  `ROLE_SQUAD_LEADER`, so its leader would otherwise wear no leader chevron until it died.

### Consolidation: the reconciler, detachments and succession (2026-07-27)

Membership used to be decided only at spawn. That made squad mode a spawn-time flag rather than a
property of the world — turning it on did nothing to bots already fighting, attrition left a team as
a scatter of two-man remnants that nothing ever merged, and every new spawn path had to remember to
opt in. `reconcileSquads(now)` runs the same consolidation continuously instead, at the end of
`updateSquads` (on the leader positions that pass just refreshed, so its edits land next tick rather
than under the loop still reading them), throttled to `SQUAD_RECONCILE_MS` (700).

It is safe to run mid-firefight *because* of the bias-not-override rule: merging is pure bookkeeping,
it never moves a bot, and formation movement is reachable only out of combat. The one live effect is
`applyPushElement` re-reading `squadRank`, which self-corrects on the next push.

`planSquadReconcile({ squads, loose, radius, coreMax, ... })` in `bot-squad.js` is pure — it takes
snapshots and returns an ordered op list (`split`, `mergeDetachments`, `merge`, `absorb`) that
`applySquadOp` applies. Passes run in that order so each works on ground the last one cleared:

- **split** — a detachment at `DETACHMENT_MIN` (4) leaves as its own squad under its own commander.
  With a core of 8 that is the twelfth bot, i.e. `SQUAD_SPLIT_TOTAL`.
- **mergeDetachments** — two squads in range pool detachments that are each too small to stand alone,
  once the sum reaches 4. The **older detachment's** commander (lower `detachSeq`) leads the result.
- **merge** — a squad at or below `SQUAD_MERGE_MAX` (4) folds into the nearest same-team squad within
  `SQUAD_MERGE_RADIUS` (20 m, leader-to-leader). The **older squad** (lower `seq`) keeps command and
  its id; the younger is deleted. Only a squad with **core room** is a merge target — merging into a
  full core would just park everyone in a detachment that splits straight back out, and the two would
  trade members forever.
- **absorb** — leftover independents join the nearest squad in range, core first, detachment if full.

Whoever the plan cannot place is out of reach of every squad, and forms up among themselves via
`formSquadsFromExisting({ fillExisting: false })` — the reconciler has already offered them every
squad within reach, so anything still loose should not be teleported onto a distant roster.

**Leadership on a merge** follows seniority throughout. The relieved leader keeps its claim on
command: it joins `heirIds` (the named line of succession, which `stepSquadSuccession` now prefers
over a plain election) when the merge fits inside the core, and takes the detachment it will lead out
again when it does not. Squad records gained `detachIds` (a subset of `memberIds`), `detachLeaderId`,
`detachSeq` and `heirIds`; the debug overlay sizes rings by that rank (leader 1.5×, detachment
commander 1.15×, core 1×, detachment 0.7×) and both the label and the roster row show `+N det`.

### Sides and home bases (2026-07-27)

Spawning put every bot at a random walkable cell, so a replacement could appear across the map from
the squad it was joining and spend its life walking. Placement is now resolved most-specific-first in
`findBotSpawnPoint({ near, spread, region })`, each stage falling through rather than failing:

1. **beside the squad it is joining** (`botSpawnNearSquad`, on by default) — `planSpawnAnchors`
   resolves one anchor per batch index, index-aligned with the role layout. A genuinely new squad
   gets a single shared anchor so it arrives as a group, not a scatter.
2. **on its team's own side** (`botSideModeEnabled`, off by default) — `teamSideRegions(bounds)` in
   `bot-structures.js` splits the map across its **long** axis so the two sides face each other
   across the width, and sets each home in off its own edge. Derived from the live `activeBounds`
   (cached by identity), not baked into the layout, so toggling side mode needs no map rebuild.
3. **anywhere walkable** — the original behaviour.

`generateHomeBase(region)` builds the physical compound: a three-sided shell with a gateway the
door's width in the front wall and two cover blocks inside it, emitted as ordinary axis-aligned
walls/covers plus a levelling pad, so it lands in the map collider and the nav bake with no
special-casing. It is a **separate toggle** (`botBaseStructuresEnabled`) because it is scenery baked
into the layout and so needs a rebuild, while the spawn rules alone take effect on the next spawn.
`homeBaseSizeFor` shrinks it toward the bounds and returns null when the map is too small to hold one
(the rooms layout, for instance) — the side spawn rules still apply there.

`squadOpeningTargets(team, limit)` is the single source of the reinforcement fill order; counting
(`planSquadIntake`), filling (`fillSquadOpenings`) and spawn placement (`planSpawnAnchors`) all read
it, so they cannot disagree about which squad a given reinforcement is joining.

### Spawn markers and garrisons (2026-08-08, bot-viewer-v3)

Side mode was the only spatial control over spawning, and it is a hard half-and-half split of the
map. **Spawn markers** replace it as the general mechanism: a marker is a team-owned point that
team's bots appear at, and *a base is a spawn marker with a compound built around it* — one record,
one vocabulary, whether the marker was placed by hand or derived from the bounds.

`bot-spawn-markers.js` is the pure half (store CRUD, picking, hit-testing, serialization, compound
orientation, garrison geometry), Node-tested by `test-bot-spawn-markers.mjs` and written to be
imported unchanged by the environment viewer. `bot-viewer-v3.html` owns the meshes, the click tool
and the panel.

**Placing them.** Two armed tools in the squad panel, committed by a left-click on empty ground
through the same `wheelArmedGoal` path the command wheel uses (so they never collide with select,
alt-click focus, the right-click menu or the wheel):

- *Place spawn marker* — drops a marker for the tool's team; clicking one of that team's markers
  removes it. The tool stays armed across clicks, since placing is a repeated gesture. Escape
  disarms.
- *Place bot* — spawns one bot of the tool's team exactly where the click landed. It still goes
  through `findBotSpawnPoint` (`spawnBots(..., { at })`, `SPAWN_TOOL_SPREAD` of slack) so a click on
  a wall lands on walkable ground beside it rather than inside it.

**Placement cascade.** `findBotSpawnPoint` gained a marker stage between the squad anchor and the
team side: a team that owns markers spawns at them. It re-picks a marker per pass rather than
committing to one, so a marker that ended up on unwalkable ground cannot starve the others. Squads
and individuals both use it — `planSpawnAnchors` seeds each new squad on one marker (the whole squad
shares it), and with squad mode off the per-bot stage does the same job.

**Side mode markers** are now just markers: `refreshSideModeMarkersFor(bounds)` re-derives one per
team from `sideModeMarkers()` on every map build, tagged `origin: 'side'` so clearing them never
touches anything hand-placed. Only `origin: 'placed'` markers are saved into a slot.

**Base build** (`botBaseStructuresEnabled`) now builds a compound at *every* marker, not only at the
two side-mode home points, and `markerRegion(bounds, marker)` orients each gateway toward the middle
of the map along whichever axis the marker sits furthest out on. `homeBaseSizeFor` still returns null
on a map too small to hold one.

Compounds are emitted by the layout generator, so a new marker's walls only exist after an
`applyLayout` pass. `commitSpawnTool` therefore runs that rebuild itself when base build is on and
the maze layout is active — placing a marker raises its walls immediately instead of leaving the user
to find a control that happens to trigger a rebuild. It forces `keepBots: true` regardless of the
rebuild toggle, because placing a marker is not a change of map and must not clear the roster.

The rebuild is whole-map, and most of it is unnecessary for adding a few boxes: only the cells under
the compound change walkability, only nearby corners are added, and the visibility field is already
lazy. Region labelling is the one genuinely global part, since a wall can cut the map in two. If the
bake time `applyLayout` logs turns out to be too slow to sit behind a click, the fix is an
incremental path into the nav grid and corner map rather than avoiding the rebuild.

#### Rasterized nav blockers

`buildNavGrid`'s `blockers` option is the fast path and the one every rect-based map should take.
Without it the bake costs cells × rects, because the caller's predicate scans its own rectangle list
once per cell: 160,000 cells against 900 walls is 144 million rectangle tests, measured at **224 ms**.
Handed the rects instead, `rasterizeBlockers` walks each rect's cell range — the shape
`buildSightGrid` has always used — and the predicate then runs only where no rect claimed the cell.
**17 ms for a byte-identical grid**, verified in `test-nav-grid.mjs` across 36 random maps at three
margins and three cell sizes, and benchmarked by `bench-corners.mjs`.

`blockerMargin` grows every rect on all sides, which is how the viewer keeps paths off wall surfaces
(`WALL_MARGIN`, 0.55 m). Rasterized cells are **hard** blocked and never reach `softBlockedTest`, so
`connectStrandedRegions` can still carve through steep ground but never through a wall. In
`bot-viewer-v3.html` this left `navWalkable` with the ground half only — bounds and slope — and
`pointInWall` was deleted rather than left as an uncalled function implying nav still tests rects
per cell.

The callback-only form is unchanged, and `environment-viewer.html`'s three call sites still use it.

#### `updateCornerMapInBounds(prev, navGrid, rects, field, dirty, opts)`

Rebuilds only the corner records a change inside `dirty` (world-space bounds) could have altered.
**1.5 ms against a 65 ms full bake** on a 200 m 900-wall map.

It is **exact for wall records**, not an approximation, because a wall record is locally determined:
it depends on its own rect, the buried test against overlapping rects, a 2-cell walkable snap, and
one `canSee` between anchor and peek about a metre apart. Long-range visibility only enters at query
time, in `coverCornerValid`. `test-nav-corners.mjs` proves it by comparing against a full rebake over
every single-wall removal, a wall shortened below `SIGHT_BLOCK_HEIGHT`, and a wall split in two —
the shape a breach takes — with zero divergence, and `bench-corners.mjs` re-checks it at map scale.

Crest records are **not** exact. `buildCrestCorners` claims one block slot per direction in a global
row-major scan under a hard cap, so which cell represents a slot depends on scan order. The partial
rescan takes a cell `window` and a pre-seeded `taken` set so survivors keep their slots and stay
un-re-emitted, and it holds the stride phase of a full bake so it cannot sample cells a full bake
never visits. It never invents or loses cover, but it can pick a different representative cell inside
the window. `crestExact` in the return says whether crests were touched at all, so a caller needing a
byte-identical map knows when to fall back to `buildCornerMap`.

### Wall destruction (`bot-destruction.js`, `test-bot-destruction.mjs`)

Pure and THREE-free. Plan: `docs/wall-destruction-plan.md`.

**Wired into `bot-viewer-v3.html` as far as CRACKED**, behind the *Wall damage* toggle in the
explosives row (**off** by default). The set is rebuilt per layout from `activeWalls` in
`applyLayout`, and `destructionSettings.maxState` pins the ladder at `CRACKED`: walls take real
damage and show it, but never change shape, so nothing downstream can go stale while the geometry
rebuild is still unwritten. Lifting that one field is what turns crumbling on.

Damage enters at three points. `damageWallAtHit(point, normal, amount)` handles bullets, called from
`fireBotShot` and the haywire fire path on `hit.kind === 'world'` — that string is the map collider's
own branch in `resolveHitscan` (`combat.js:211`). `damageWallsInBlast(center, radius, damage)`
handles explosions from `detonateBlast`, and needs no attribution because it sweeps the rects
directly; falloff is measured to the rect, not its centre, so a charge against one end of a long wall
is not shrugged off. A hit that lands on terrain or a slab attributes to no wall and is ignored.

Two known rough edges. Attribution is a linear scan over every wall per world hit, where the plan
calls for a cell raster; it is deferred so its invalidation is built once, alongside the other local
updates. And because the rect test is 2D, a hit on a lintel directly above a wall attributes to the
wall beneath it.

The state ladder, decided with the user:

| state | what is left | what rebakes |
|---|---|---|
| `CRACKED` | the original rect, unchanged | nothing — a material or decal swap only |
| `CRUMBLED` | half of it, on a horizontal, vertical or diagonal cut | geometry, and whatever the cut moved |
| `CRUSHED` | no solid at all, just rubble | everything in the footprint; the ground opens |

A breach is the same machinery with a different child list and is deliberately not built yet.

`fracture(rect, pattern, opts)` turns one rect into `{solids, rubble}`. The three cuts behave very
differently for the AI, which is the point of having them:

- **horizontal** — full footprint, height dropped to `stubHeight` (1.4 m). Deliberately *below*
  `SIGHT_BLOCK_HEIGHT` rather than an exact half of 3 m, because the sight test is `h >= 1.5` and an
  exact half would still block sight. New firing lines open and the wall's cover anchors vanish,
  since `buildCornerMap` ignores rects under 1.5 m.
- **vertical** — half the length at full height. This is the interesting one: the surviving end is a
  new free corner, so the corner bake *manufactures* cover that was not there before.
- **diagonal** — a descending staircase of `stairSteps` rects. Nothing downstream reads a slant
  (`pointInWall`'s successor, `buildSightGrid`, `buildCornerMap` and `boxOnGround` are all
  axis-aligned rect tests), so the sim reads the staircase while the rendered mesh may be a real cut.

`rubble` output is **descriptive geometry for the renderer only**. Feeding it to the nav blockers or
the collider would produce a crushed wall that still blocks, which is the one thing the crushed state
exists to avoid.

Determinism follows the `plants.js` convention: a fixed-length draw vector per builder, taken whether
or not the branch that uses it fires, and a per-wall stream from `makeWallRng(seed, id)` so wall 37
breaks the same way regardless of how many walls broke before it. The test asserts that directly.

`applyWallDamage` returns `null` when nothing observable changed and otherwise a transition carrying
`geometryChanged` and a `dirty` region. `geometryChanged: false` is the common case — a crack — and
it is what keeps most hits off the rebuild path entirely.

`wallAtPoint(set, point, normal)` exists because the map collider bakes every mesh into one triangle
soup and its raycast returns only `{distance, point, normal}`, so a bullet hit carries no wall
identity. Stepping into the surface along the normal is what disambiguates a hit on a face shared by
two abutting rects; the test covers both sides of exactly that case.

#### `rebuildDerived(dirty, {label})` — the rebuild seam

Everything derived from the wall and cover rects lives in one function behind one flag per stage:
`geometry` (teardown, floor mesh, the terrain-sunk box lists, the instanced meshes), `flora`,
`collider`, `nav`, `vis`, `corners`. `applyLayout` calls it with every flag set; a partial rebuild —
a wall coming down mid-fight — calls it with the subset that changed. It exists so those stages have
exactly one definition and one place to measure.

The order is fixed by real dependencies: boxes feed both the collider and flora's vine anchors, nav
feeds the visibility field's `walkIndex`, and the field feeds the corner bake's anchor-to-peek
cross-check. Region reporting and the nav overlay run whenever nav or corners moved.

`visField` is **rebuilt, never patched**, even when nav did not move. `nav-visibility.js` documents
its pair memo as needing no invalidation on the grounds that a built field never changes its
answers, and reconstruction is one O(cells) pass with no traces — so honouring that assumption costs
less than breaking it.

Each call logs `[rebuild <label>]` with the wall count, walkable-cell count, corner count and a
per-stage millisecond breakdown, and leaves the same numbers in `lastRebuildTimings`.

**Garrison** (`botGarrisonEnabled`, on by default) is the standing hold a squad gets at the marker it
spawned from — `squad.garrisonMarkerId`, stamped in `spawnBots` from the anchor's marker id.

- Out of combat, `updateGarrisonMovement` replaces patrol outright (it sits between the manual
  command and formation rungs and always returns true), walking each member to its
  `garrisonSlot(marker, rank, liveCount)`: rank 0 on the marker, the rest on a ring at 55% of the
  radius. An unreachable slot parks the bot where it stands rather than letting it patrol away.
- It does not gate fighting: every combat state sits above that branch, so intruders are engaged
  normally. `clampBotGoalToGarrison` only pulls the *pursuit* goal back onto the ring
  (+`GARRISON_CHASE_SLACK`), which is what stops a chase running off the map.
- It clears on a manual order only (`releaseGarrison`, called from `commandBotTo`), and it clears for
  the whole squad — an ordered squad must not walk itself home the moment the order completes.

### Support roles inside a squad (2026-07-27)

A medic was being treated as just another rifle in three places. Roles gained a `support` flag
(medic only) and each site now reads it:

- **Formation slot.** `updateSquads` ranks with `formationRanks` instead of `squadRanks`. Plain rank
  ordering is by id, which put the medic on the leading edge of the wedge as often as not — a medic
  walking point. Support now falls in behind the whole fighting line; the leader still takes point,
  and an all-support squad still puts its elected leader there.
- **Bounding overwatch.** `applyPushElement` no longer runs `boundingRole` for a support role — it
  pins them to the base element, so a medic never draws the maneuver bound and leads the assault.
  The existing `canOverwatch` downgrade still lets it follow when it has no firing position, so it
  can't be stranded holding an angle it doesn't have.
- **Triage.** `bot-medic.js` weights candidates by `outsideSquadPenalty` (1.75) when the caller marks
  them `squadmate: false`, so a squad medic stops abandoning its own wounded for a stranger a metre
  nearer. Applied to **ranking only** — never to `responseRadius` or the tend radius, so preference
  decides who to treat, not how far a medic can reach or how close it must stand to start working.
  `selectHealTarget`/`selectReviveTarget` return the true `dist` alongside the weighted `score`. The
  flag is `undefined` for an unrostered medic, which keeps the plain nearest-first behaviour.

### Status

Node-tested (`test-bot-squad.mjs` and `test-bot-structures.mjs`, 130+ assertions between them,
including a reconcile fixed-point test that runs a worst-case field of remnants and strays to
convergence and asserts nobody is lost, duplicated, or left over strength) and `node --check` clean
on the extracted module
script. **Browser QA pending** — nothing below has been watched run: formation shape/spacing on open
ground, the auto wedge↔column switch at a real corridor mouth, leader death producing a visible
leaderless scatter then a chevron appearing on the successor, reinforcement intake filling an
understrength squad rather than forming a new one, remnants merging as a fight thins a team out, a
detachment forming past 8 and splitting at 12, reinforcements landing beside their squad, and the
home compounds building with a gateway bots can actually path through.

**Fixed 2026-07-27**, two bugs in the same seam, both found by adding the visuals above:

1. `spawnBots` collected its `spawned[]` actors but never called `fillSquadOpenings`/`formSquad` on
   them, so with squad mode on the batch got squad *roles* (including a chevroned leader) and no
   roster ever existed — `squads` stayed empty and every squad-gated code path was dead.
2. Once rostering worked from the spawn buttons, it still did nothing for **auto-add waves or a
   scene shuffle**, because `intake` was gated on `botSquadModeEnabled && !roles` — and both of
   those callers pass their own `roles`. Squad mode therefore appeared to work only when spawning by
   hand, and any squad was silently lost on the next map shuffle.

Both were pure wiring with no pure-function surface, which is why 112 green Node tests said nothing
about them. `dealSquadChunks` was extracted to `bot-squad.js` so the batch→roster split is now
testable, and `test-bot-squad.mjs` pins both the generated layout and the caller-supplied case.

### Not yet built (roadmap)

Formations are the first slice. Still to come, in order: an order-lease channel generalising
`commandBotHold` into a priority ladder (self-preservation > firefight reflex > medic channel >
squad order > autonomous, every order a short re-armed lease so it decays rather than sticking);
sectors of fire, objective selection and focus-fire designation; a maneuver element that scores
approach bearings off the visibility field while the base element suppresses; then temperament,
loss-retreat and leader-death morale ported from `squad-activity.js`; then the outpost/ammo/flag
layers from `docs/superpowers/specs/2026-07-14-squad-outpost-ammo-economy-design.md`.

Exploratory steps toward objective selection, all in `bot-viewer-v2.html`, current control scheme
as of 2026-08-06:

- **Select**: plain left-click on a bot sets `selectedBotActor` (previously only ctrl-click did this,
  as a purely-visual trace-viewer marker; it's now also "the bot that right-click commands apply to").
  Camera-follow/POV on plain/shift-click and the ctrl-click trace-viewer ping are unchanged.
- **Command**: right-click anywhere on the map raycasts to a ground point (`groundPointAtEvent`) and
  opens a small floating menu at the cursor (dismissed by clicking away, Escape, or picking an
  option). The menu has independent toggles, not one flat choice: **Double time** and **Break
  contact** checkboxes at the top (each sets its flag directly, no point/command issued, and checked
  state carries over between menu openings), and two goal buttons below them, **Move here** / **Hold
  here**, that each set `commandTargetId`/`commandGoal`/`commandGoalState` for the selected bot using
  whatever the two toggles currently are. A color-coded marker (`markerMesh`) drops at the point for
  feedback: amber = move, orange = move + double time, cyan = hold, violet = hold + double time
  (break contact isn't separately color-coded yet). `updateCommandMovement` is wired into the
  out-of-combat dispatch ahead of `updateSquadFormationMovement`/medic cohesion, so an explicit
  command overrides passive follow/regroup behavior until it resolves.
- **Arrival behavior (goal state)**: `commandGoalState: 'move'` clears the command on arrival
  (`COMMAND_ARRIVE_M`) and falls through to whatever the bot would normally do next — the "attack then
  return to patrol" default, since combat is a separate, higher-priority FSM branch that pre-empts
  movement entirely (unless break contact is also on — see below) and isn't cleared by arriving, so a
  fight en route doesn't cancel the order. `commandGoalState: 'hold'` never clears on arrival — the bot
  parks at that exact point indefinitely (proto-defense: still fights on contact, returns to holding
  afterward instead of resuming patrol).
- **Double time (movement style)**: `commandDoubleTime` is orthogonal to goal state — it forces a
  `STANCE_RUN` for as long as the commanded bot is actively traveling toward `commandGoal`, regardless
  of whether the goal is move or hold (once a hold-goal bot has arrived and is stationary, the flag is
  a no-op by construction — nothing reads it while parked). `bot-stance.js`'s `chooseBotStance` has a
  `doubleTime` ctx flag that only fires while the resolved FSM state is `'patrol'` (so it can never
  fight the aim/seek crouch table or any higher-priority rung — forcedCrouch/holding/heal/alert all
  still win). The viewer sets that flag true for the directly commanded bot **and** any live squadmate
  (`activeBotActor.squadId` matched against the commanded bot's, looked up fresh each frame rather than
  tracked separately), so double-timing a squad leader speeds up the whole squad through the existing
  stance→`stanceSpeedFactor`→`currentBotMoveSpeed` pipeline — no new movement code needed.
- **Break contact (combat override)**: `commandBreakContact`, propagated to squadmates the same way as
  double time, is read into `c.orderOverride` and passed to `chooseBotStateName` (bot-activity.js).
  It's a new ladder rung, positioned below every self-preservation rung (flee/heal/knife/committed
  cover/the close-self-threat spin all still win) but above the entire firefight-reflex tier — pursue,
  fresh cover entry, aim/fire, the ally-hit cover reaction, the lost-sight chase — landing on
  `BOT_PATROL` so `updateCommandMovement` takes over that same frame. This is a hard "stop shooting and
  move now," not a graceful kite-while-retreating: the bot goes silent and pulls out. Node-tested in
  `test-bot-activity.mjs`.

**Command wheel (experimental alternate to the right-click menu)**: holding the middle mouse button
(scroll-wheel click) over the map pops a small radial wheel at the cursor instead of right-clicking a
ground point first — Move/Hold spokes at top/bottom, Double time/Break contact spokes at the sides. It's
a hold-drag-release gesture, not click-to-open: `pointerdown` (button 1) shows the wheel at the cursor,
each spoke highlights (a border ring, via its own `refresh(hover)` closure) as the cursor drags over it
while still held, and the matching `pointerup` resolves whichever spoke is under the cursor at that
instant via `document.elementFromPoint` and commits it; releasing off every spoke just closes the wheel
with no effect. A stray `pointerdown` elsewhere while the wheel is still open (a lost pointerup, e.g.
from releasing outside the window) closes it as a safety net. Q was tried first but fly-cam already uses
Q for vertical descent, so the trigger moved to the middle button; `controls.mouseButtons.MIDDLE = null`
(set where `controls` is constructed) permanently frees that button from OrbitControls' default dolly so
the two never fight over it. The two toggle spokes flip `commandDoubleTime`/`commandBreakContact`
immediately — same module state the right-click menu's checkboxes read/write, so the two entry points
can never disagree — and read as persistent toggles because each spoke's fill color is driven by an
`isActive()` getter re-evaluated on every open (`paintWheelToggles`), not just painted once at creation.
The two goal spokes have no point yet at the moment they're picked: choosing one sets `wheelArmedGoal`
('move'/'hold'); the *next* left-click that doesn't land on a bot supplies the ground point
(`groundPointAtEvent`) and commits through the same `commandBotTo` helper the right-click menu's buttons
call (`issueCommand` is now a thin wrapper around it). While a goal is armed the cursor switches to a
crosshair. Escape clears both the wheel and any armed goal; opening either menu hides the other. This is
a UI experiment, not a replacement — the right-click menu is unchanged and still works exactly as before.

Selecting a squad leader drags the whole squad along for free, since followers track the leader's
live entity position in `updateSquads`, not this dispatch choice — selecting an individual follower
instead breaks it out of formation to travel/hold/double-time solo (no squad-wide selection yet). No
team/order/persistence wiring exists yet. Staged plan going forward: marker (done) → point-directed
selection (done) → arrive-and-act options, move vs. hold, decoupled from a double-time movement-style
toggle (done) → team/base assignment with attack/defend orders, leash, and base-biased cover.

Selecting a bot for the command menu never moves the camera by itself (as of 2026-08-07) — the plain
left-click handler only calls `setSelectedBot`, nothing camera-related. Following a specific bot is a
separate, explicit action: the Follow/POV buttons and the V/P keybinds now target `selectedBotActor`
when one exists (`setCameraMode(mode, selectedBotActor)`), falling back to whatever `getCameraFollowActor`
already resolves to (the auto-follow toggle, or the last bot cycled to with `]`/"Nearest") when nothing
is selected. This was a deliberate fix for a regression the point-command work introduced: the click
handler used to unconditionally jump the camera to whatever was clicked, which fought with using the
same click just to target a command.

That first pass left a gap, fixed the same day: `updateCameraButtons()` disabled the Follow/POV/Frame
buttons off `hasActor = !!getCameraFollowActor()` alone, which knows nothing about `selectedBotActor` —
so with auto-follow off and nothing ever followed yet, the buttons stayed greyed out (ignoring clicks)
even though a bot was selected and the click handlers were already wired to use it. The V/P keybinds
were unaffected (they call `setCameraMode` directly, not gated on the button's `disabled` state) — only
the on-screen buttons were stuck. Fixed by widening `hasActor` to `!!(selectedBotActor ||
getCameraFollowActor())` and having `setSelectedBot` call `updateCameraButtons()` (it's not on the
per-frame path, so nothing else was repainting the buttons when a click changed the selection).
`frameCamera`'s default actor (used by the Frame button and the F key) similarly widened from
`getCameraFollowActor()` alone to `selectedBotActor || getCameraFollowActor()`, so F now frames on your
selection too instead of only on whatever's currently being followed.

A third fix, same day: Follow mode wasn't tracking the bot **while** the user rotated or zoomed —
only once they released the mouse. `updateCameraRig`'s `CAMERA_FOLLOW` branch (~line 4072) computes a
smoothed `cameraFollowAnchor` every frame regardless, but used to bail out (`if
(cameraRig.userInteracting) return;`) immediately after updating it, before ever writing that anchor
into `controls.target`/`camera.position` — so mid-drag or mid-scroll the pivot you were orbiting around
just sat still while the bot kept walking, then the camera snapped to catch up the instant you let go.
Fixed by hoisting the `cameraRig.translateTarget(cameraFollowDesiredTarget)` call above the
`userInteracting` check: it always carries the pivot *and* the camera together by the bot's own
frame-to-frame motion (a pure translation, touching neither the orbit distance nor direction the user
is actively dragging/scrolling), and only the distance/occlusion resolution below it stays gated on
release, so it doesn't fight that live input. `controls.update()` (applying the drag/wheel delta) runs
immediately before `updateCameraRig` each frame (see the call site comment), so this ordering is exactly
the same "user input first, follow rig writes the final pose after" contract the non-interacting path
already used — it just no longer skips writing that pose during the gesture. No unit-testable surface
(live OrbitControls interaction timing); verify by dragging/scrolling while following a moving bot.

The camera system as a whole (follow/POV/orbit/fly modes, framing presets, occlusion guard) is old and
separately grown; a real overhaul is out of scope here and would be its own pass.

## Bot Inspector (2026-07-15)

Debug tool for diagnosing the kind of live movement/pathing glitches squads exposed (terrain-trap,
retreat clump, etc. above) directly instead of guessing from a screenshot. All in
`environment-viewer.html`, host/solo only (`mpRole !== 'guest'`), no new files.

- **Selection**: `selectedBotId` (module state) plus `selectBot(id)`/`cycleSelectedBot(delta)`.
  Three ways to select: Alt+Click a bot in the 3D scene (`pickBotAtScreen` raycasts against
  `mpGhostRenderer.playerGroups()`, filtered to ids in `botPlayers`), click a row in the panel
  table, or Left/Right arrow keys (global keydown handler, skipped while a form control has focus).
  Alt+Click is used instead of a plain click because plain left-click is already claimed (fires the
  equipped weapon in FPS mode, starts an orbit-camera drag otherwise); the orbit-drag pointerdown
  handler and the FPS-mode mousedown handler both bail out early on `e.altKey` so the two never
  fire together.
- **3D highlight**: `ensureBotMarker()` lazily creates a flat yellow ring (`depthTest: false`, high
  `renderOrder`) that `updateBotInspector` repositions onto the selected bot's capsule-base position
  every `updateBots` tick; hidden (not removed) when nothing is selected.
- **Panel** ("Bot Inspector" section): a live text readout of the selected bot (fsm state, hp/alive,
  time in current state, position, XZ speed + stuck flag, `pathMode`/waypoint count/`pathFailCount`,
  squad id + leader/member + order, live target + distance to it, ammo/reload, and lifetime
  shots/hits/kills/deaths/distance traveled) refreshed at ~150ms via `refreshBotInspectorPanel`
  (throttled the same way `updateCreatureCommandHud` is), Prev/Next/Clear buttons mirroring the
  arrow keys, a "Teleport to selected" button, a record-to-file toggle (below), and a table of every
  live bot (id, state, hp, rounded position, fail count, kills/deaths, stuck flag) — each row
  selectable by click and carries its own "Go" teleport button, with the selected row highlighted
  and stuck bots tinted amber.
- **Teleport**: `teleportPlayerTo(x, z)` snaps the local player's capsule (`playerCollider`) and the
  orbit camera's `target` straight to a world XZ point at `terrainHeight(x,z)`, matching the same
  ground-contact convention `resetPlayerPosition`/bot spawning use — no path or collision check, an
  instant jump for inspection purposes only.

### Per-bot stats: tracked fields (2026-07-16)

Beyond the state already listed above, every `botPlayers` record also carries lifetime counters,
initialized in `spawnBotAt` and persisting across that bot's own respawns (only `stateEnteredAt`/
`lastPos`/`stuckSince` are re-anchored on respawn, so the teleport-to-spawn jump isn't counted as
travel):

- `shotsFired` — bumped in `botFire` when `applyCombatIntent` returns `ok`.
- `hitsLanded` / `kills` — bumped by `bumpBotCombatCounters(attackerId, targetId, wasTargetAlive)`,
  called from both `applyHitDamage` (hitscan/melee) and `applyExplosionBlast` (radial). Kills are
  only counted on the tick a hit actually flips a target from alive to dead — `wasTargetAlive` is
  sampled *before* `playerCombat.applyDamage`, so a follow-up hit on an already-dead target doesn't
  double-count.
- `deaths` — bumped on the same alive→dead transition, on the target's own record.
- `stateEnteredAt` — reset whenever `botTickOne` sees `fsmState` change; `nowMs - stateEnteredAt` is
  time-in-current-state.
- `distanceTraveled` — accumulated every `botTickOne` tick from the XZ delta against `lastPos`.
- `stuckSince` — `bot-activity.js`'s `trackStuck({ speed, moving, stuckSince, nowMs })` (pure,
  Node-tested in `test-bot-activity.mjs`): latches a timestamp the first tick a bot's XZ speed drops
  below `STUCK_MIN_SPEED` (0.15 m/s) while `moving` (fsmState is `patrol`/`seek` — `aim`/`fire` are
  deliberately stationary and never flagged). Cleared the moment speed recovers. This is the direct
  diagnostic for "glitched movement" reports: a bot with a growing `stuckMs` while its `fsmState`
  claims it should be walking is stuck on something pathing/physics isn't resolving.

### Continuous file logging: `botStatsLog` (2026-07-16)

A "Record all bots to file" toggle in the Bot Inspector panel starts `botStatsLog`, which samples
every live bot every `intervalMs` (500ms) into a ring buffer and batch-POSTs CSV chunks to
`/api/save-stats?filename=bots-<ISO>.csv&mode=append` — the same endpoint and append convention
`perfLog` (`docs/subsystems/infra.md`) uses for `perf-*.csv`, just with a `bots-` filename prefix
(both prefixes are accepted by `serve.py`'s `_SAFE_STATS_FILENAME`). The file updates live on disk
while recording (flushes every 5s once ≥20 unflushed rows are queued, plus a `sendBeacon` flush on
`pagehide`/`beforeunload`/tab-hide), so it can be tailed or opened mid-session, not just after
stopping. Each row is one bot's full snapshot at that tick: fsm state, hp/alive, position, speed,
path state, squad info, ammo, and all the lifetime counters above (`shotsFired`, `hitsLanded`,
`kills`, `deaths`, `timeInStateMs`, `distanceTraveled`, `stuckMs`, `distToTarget`). Recording state
and row count live in `botStatsLog`/`botStatsLogUI`, refreshed on the same ~150ms cycle as the
inspector panel.

### Fall-through-map recovery and stuck-force-replan (2026-07-17)

A `botStatsLog` recording surfaced two distinct failure modes hiding behind "bots are stuck":

- **Falling through the map.** `stepBotPhysics` (`bot-entity.js`) only clears `bot.onFloor` via
  `mapCollider.resolveCapsule`'s local BVH shapecast; if that query finds zero nearby triangles
  (a gap in the collision mesh, a ledge, the map edge) `onFloor` stays false and gravity applies
  every frame with nothing to ever catch the fall — there's no floor anywhere below the playable
  area and, until this fix, no safety net. The trigger was almost always the escape hatch above:
  `pushBotsApart`'s XZ-only correction can shove a bot's own position off the nav mesh, which
  drives `pathFailCount` to `BOT_STUCK_ESCAPE_RETRIES`, which used to send the bot in a straight,
  uncollided line toward `spawnPos` — easily crossing a collision gap at full `botMoveSpeed`.
  Observed in a recorded session: 43 of 110 bots (39%) eventually fell, one reaching y ≈ -73,800
  with no recovery for the rest of the session.
  Fix: every `botPlayers` record now tracks `rec.lastSafePos`, updated to the bot's own position
  every tick `bot.onFloor` is true. If `bot.capsule.start.y` ever drops more than
  `BOT_FALL_CATCH_DROP_M` (12m) below `rec.lastSafePos.y`, `botTickOne` snaps the capsule back to
  `lastSafePos` (translating both endpoints to preserve capsule height), zeroes velocity, and
  clears the current path. The escape hatch itself now also steers toward `lastSafePos` instead of
  `spawnPos` — the last point known to be walkable, not a straight-line trip across whatever
  terrain lies between the bot and its original spawn (which, for a squad that has pushed far from
  home, is exactly the kind of unguided crossing that caused the fall in the first place).
- **Frozen with a "valid" path.** Separately, `followBotPath` can report a nonempty path and keep
  commanding velocity toward the next waypoint every tick while the bot makes zero physical
  progress — most likely wedged against static geometry or squadmates, neither of which the nav
  grid models as obstacles. Because the path itself never fails, `pathFailCount` never increments,
  so the escape hatch never engages; some bots held position for 70+ seconds in one recording.
  First attempt: `botTickOne` forced a repath and bumped `pathFailCount` once `stuckMs` exceeded
  `BOT_STUCK_FORCE_REPLAN_MS` (3s). This didn't actually work — a follow-up recording still showed
  a bot stuck 25s+ — because `botTickMovement`'s normal retry path resets `pathFailCount = 0` the
  very next tick whenever a repath nominally "succeeds" (line ~2122), and a repath against the same
  physically-blocked-but-nav-valid goal succeeds every time, wiping the bump out before it could
  accumulate. Actual fix: a separate `rec.stuckReplanCount`, throttled to the same `BOT_PATH_RETRY_MS`
  cadence as normal retries (`rec.stuckReplanAt`) and reset only when the bot is *actually* moving
  again (`stuck.stuckSince == null`) or reaches the escape hatch's target — never by an individual
  repath "succeeding". The escape-hatch trigger now checks `pathFailCount >= BOT_STUCK_ESCAPE_RETRIES
  || stuckReplanCount >= BOT_STUCK_ESCAPE_RETRIES`, so a physically-wedged bot with a nominally valid
  path still reaches the same recovery as a genuinely unreachable one.

### Systemic review and the actual fix (2026-07-18)

The 2026-07-17 fixes above turned out to both be broken in the exact cases they targeted — a
`claude-fable-5`-run architecture review (`docs/superpowers/reviews/2026-07-18-bot-stuck-systemic-review.md`)
found that in a 12-bot recording, 83% of bots got stuck at some point and **every stuck episode
over ~1s ran to the end of the session and never recovered** — an absorbing state, not noise.
Root causes, both confirmed against the live code before fixing:

- **The escape hatch was dead code.** `rec.lastSafePos` is updated to the bot's own position every
  tick `bot.onFloor` is true — and a stalled-but-grounded bot (the common case) is grounded every
  tick, so `lastSafePos` was always wherever it was already stuck. The escape hatch's distance
  check (`dist < 0.3`) read ~0 instantly, took the "arrived" branch, and reset the counters without
  moving the bot at all — a silent regression from the fall-through fix above, which needed
  `lastSafePos` retargeted away from `spawnPos` but broke the grounded-stall case in the process.
- **`stuckReplanCount`'s own trigger case could never reach the code that reads it.** The escape
  check lived inside `else if (rec.currentPath.length === 0)`. But the wedged-with-a-valid-path
  case is defined by `requestBotPath` *succeeding* (nav-valid, physically blocked) — so
  `currentPath` was never empty for exactly the bots `stuckReplanCount` exists to catch, and the
  counter accumulated into a branch that never ran.

Fix (the review's R1 + R4, ranked highest impact/effort of six recommendations — R2/R3/R5/R6 are
deeper architecture work, not yet done, see the review doc):
- New `botNearestWalkableToBot(bot)` (`environment-viewer.html`, next to `nearestWalkableInGrid`)
  returns the nearest walkable cell to the bot's *own* position (using `botNavGrid` if a static
  bake exists, else a freshly built local window, same pattern `requestBotPath`'s goal-fallback
  already used) — that's the escape target now, not `lastSafePos`. `lastSafePos` reverts to serving
  only the mid-air fall-catch, which it was always correct for.
  `requestBotPath`'s static-grid branch also gained the same nearest-walkable-goal retry the
  local-window branch already had (it had none before).
- The escape check in `botTickMovement`'s patrol branch is now evaluated unconditionally at the
  top (before the normal retry/follow logic), not gated behind an empty `currentPath` — so a
  wedged bot with a nominally valid path can reach it. Steering has a bounded budget
  (`BOT_ESCAPE_TIMEOUT_MS`, 4s); if even the short (typically <6m) walk to the recovered cell
  doesn't land, it's a last-resort XZ-only teleport onto that cell rather than a permanent statue.
- `botTrackStuck` is now fed actual displacement (`movedDist / dt`, the same delta already computed
  for `distanceTraveled`) instead of commanded `bot.velocity`. The review's Finding 5: `velocity`
  stays at full speed while a bot is shoved back by another bot's `pushBotsApart` correction (which
  only ever touches position, never velocity), so bot-vs-bot blocking was entirely invisible to the
  stuck diagnostic that shaped these very fixes. `resolveCapsule` already zeroes into-wall velocity,
  so wall-wedging was and remains correctly detected either way.

**Fable re-review of this exact diff caught one more self-cancellation bug** before it shipped:
a `stuckReplanCount`-triggered episode self-cancelled after a single tick of movement toward the
escape target, because that movement itself counts as displacement, which clears `stuckSince` in
`botTickOne`, which resets `stuckReplanCount` to 0 that same tick — dropping the trigger condition
back to false and abandoning the walk one tick after starting it (a bot pushed off-mesh via
`pathFailCount` wasn't affected; only the "successfully pathed but physically blocked" case was).
Fixed by adding `rec.escapeTarget` itself to the trigger condition, so an episode already in
progress keeps running until it explicitly finishes (arrival or `BOT_ESCAPE_TIMEOUT_MS`), decoupled
from the raw counters being free to reset mid-flight.

Not yet done from the review: eroding the nav grid by capsule radius (R2 — kills the
wedged-valid-path generator at its source instead of recovering from it), collapsing the five
ad-hoc counters (`pathFailCount`/`pathRetryAt`/`stuckReplanCount`/`stuckReplanAt`/`stuckSince`)
into one tested state machine (R3), and a real local-avoidance steering force so bot-vs-bot
contention stops happening rather than just getting detected (R5). Re-verify with a fresh
`botStatsLog` recording — the review's suggested metric is episode *duration* (should now be
bounded, seconds not session-length), not just the raw stuck fraction, which may briefly rise
now that R4 makes previously-invisible bot-vs-bot stalls visible.

**Post-fix validation (2026-07-18, 20-bot/800-row recording):** confirmed the above worked as
intended — stuck-sample fraction dropped 43.3%→16.5%, max single-episode duration dropped from an
unbounded/absorbing ~25.9s to a bounded ~2.6s, 0 fall-throughs, and only 3/20 bots were still
mid-episode at the moment recording stopped (vs. 9/12 before). All 132 stuck samples in this
recording were `fsmState='patrol'`, none in `'seek'`.

**"Look back and forth" while stuck, explained (2026-07-18):** not a separate animation bug —
`botFaceMovement` (the only yaw driver in `patrol`) always faces whichever direction
`bot.velocity` currently points, and during the ~3s retry window before the escape hatch engages,
`nextPatrolTarget`'s `rec.patrolIdx++` on every failed `requestBotPath` call (`:2180`) hands the
bot a *different* patrol goal each retry — so a blocked bot's commanded (and visible) facing can
flip toward an unrelated new goal every `BOT_PATH_RETRY_MS`. Cosmetically bounded now that episodes
are bounded; killing the flicker itself (not just its duration) would mean not advancing
`patrolIdx` on failure, only once recovery actually succeeds.

**Root cause for getting stuck on open/authored terrain specifically (2026-07-18):** confirmed
`stepBotPhysics` never resolves against `trunkIndex`/`dressingIndexRef` at all — tree/rock
avoidance for bots is nav-planning-time only (`botTerrainWalkable`'s clearance checks), so it can
only fail by *ever routing through* a tree/rock, not by physically clipping one. The real gap:
`botTerrainWalkable` never consulted `mapCollider` (the actual collision mesh) — only
`terrainHeight`'s slope, `trunkIndex`, and `dressingIndexRef`. `terrainHeight` on an authored map
*is* mesh-derived (via `mapCollider.raycastDown`, see `:1352`), but only through `cpuHeightField`'s
coarsened bake — smaller mesh features (cliff faces, rock formations, structures not registered in
either index) can be aliased away, so A* plans straight through geometry that `mapCollider`
correctly blocks the bot's actual capsule from entering — "valid path, zero physical progress"
with no obstacle-anchored cause, same symptom as the wedged-bot case above but a different
generator. Compared against `bot-viewer.html`'s harness, which never hits this: it tests one bot
(no bot-vs-bot contention) against hand-authored wall rectangles padded by a `WALL_MARGIN` (0.35m,
bigger than the bot's own capsule radius) baked directly into its walkability test — a nav check
that can't diverge from the real geometry because the geometry *is* the authoring data, unlike an
organic authored terrain mesh.

**Fix: `botMeshBlockedAt` bake-once cache (2026-07-18).** New `botMeshBlockedCache` (`Map`, keyed
by world position rounded to `BOT_LOCAL_NAV_CELL`) plus `botMeshBlockedAt(x, z)`
(`environment-viewer.html`, next to the other nav constants): on a cache miss, stands a stationary
zero-velocity test capsule (bot-sized: `BOT_NAV_OBSTACLE_RADIUS` x `BOT_NAV_STAND_HEIGHT`) at
`(x, terrainHeight(x,z), z)` and resolves it against `mapCollider` via the existing, already-tested
`resolveCapsule` — blocked if it isn't `grounded` or gets pushed sideways more than
`BOT_NAV_MESH_PUSH_TOLERANCE` (0.05m), meaning solid mesh geometry intrudes on the bot's footprint
there beyond the ground plane. **The `grounded` half of that rule was wrong and was removed on
2026-08-08 — see "The `!grounded` term condemned 92% of the terrain zone" below.** The result is cached forever (the collision mesh never changes at
runtime), so any given world cell is only ever tested against the live BVH once per session —
deliberately not a live per-tick BVH query, matching the codebase's existing rule (see
`bot-viewer.html`'s `pointInWall` and shoot-house's `botNavWalkable`) that nav walkability always
uses a cheap proxy, never the BVH directly; the one BVH-touching pass here is amortized to at most
once per unique cell ever visited by a nav query, not once per query. `botTerrainWalkable` now
calls it as its last check, after the existing height/trunk/dressing tests. No-ops entirely
(returns `false`, i.e. never blocks) when there's no `mapCollider` (pure procedural open terrain
with no authored/loaded map) — nothing to test against there.

## Not yet built (see spec for phasing)

The `retreat` state (needs a bot HP model beyond alive/dead — a hp01-style threshold could now
reuse `playerCombat.getSnapshot(id).hp/maxHp`, since bots have real HP via the panel's Health
slider, but the FSM itself still has no low-HP branch), the optional Phase 2b nav-mesh upgrade
path (superseded in spirit by the 2026-07-14 local-window A* for terrain, though a nav-mesh would
still be more accurate for irregular authored geometry), and tactical polish (Phase 3:
cover-seeking, peek/lean squad coordination beyond the simple shared-target-position alerting
added 2026-07-14). Bots also don't currently count toward any player-count-gated logic (round win
conditions, scoreboards) — the spec's other open question was resolved as out of scope for this
pass (no such logic exists yet in this codebase to wire into).

Known minor edge case (2026-07-14, not fixed — harmless): if the host fires while invisible to
bots (third-person/orbit), `alertBotsToShot` can still alert *other* bots standing near the shot's
ray to the host's position (the visibility gate only blocks the actually-targeted/hit bot's
perception, not the near-miss alert to bystanders). Those bystander bots will SEEK toward the
host's last known position but can never actually acquire or hit them (`pickBotTarget`/
`resolveWorldShot` both still enforce the gate), so this only wastes a little bot movement, never
results in an actual interaction.

## Ragdoll (standalone solver + viewer, 2026-07-23)

Working toward replacing `GhostRenderer`'s rigid `FALL_MS` tip-over death pose (`multiplayer.js`)
with a real passive ragdoll, mirroring how `bot-activity.js`/`nav-grid.js` + `bot-viewer.html` were
built before the FSM/nav wiring. Two steps: **A (done, 2026-07-23)** — pure solver + a `setRagdollPose`
render path + a standalone harness that flops a real body, all validated in isolation; **B (pending)**
— wire it into the live alive→dead edge. **Not wired into the game yet** (B).

- `ragdoll.js` — pure Verlet ragdoll solver, **THREE-free and Node-tested** (`test-ragdoll.mjs`).
  Skeleton proportions mirror `player-procedural-body.js` (`H=1.8`, `R=0.35`, `thighLen`/`shinLen`/
  `upperArmLen`/`forearmLen`/`limbThickness`), exported as `RAGDOLL_PROPORTIONS`. 16 particles
  (head/neck/chest/pelvis, L/R shoulder-elbow-hand, L/R hip-knee-foot) linked by three constraint
  kinds: **rigid** bones (fixed length, one per segment), **structural braces** (semi-stiff, default
  0.7 — keep the torso a box instead of a folding sheet), and **soft reach limits** (min/max on
  hip↔foot and shoulder↔hand so knees/elbows can't collapse to a point or hyperextend). Plus
  **passive angular cone limits** (`jointLimits`, default on): the head's swing from the spine and the
  knee/elbow fold from the parent bone are clamped **only when they exceed the cap** (55° head, 105°
  knees/elbows), so they dissipate energy rather than inject it, and they reference a **local bone
  axis** (not a global body frame). They run before the distance pass each iteration so bone lengths
  still win. (An earlier attempt used an active *pole driver* keyed to a shoulder/spine body frame; it
  made the corpse flip over and the shoulders spaz when prone — the frame flips on the ground and the
  driver pumps energy — so it was removed in favor of these passive cones.) Physics is
  Verlet integration + iterative constraint projection + ground collision (flat number or
  `heightAt(x,z)` fn, with restitution + tangential friction), sub-stepped at a fixed `FIXED_DT`
  (1/120) via an internal accumulator (variable-dt Verlet is unstable), clamped to `MAX_SUBSTEPS` so
  a big frame gap can't spiral. API: `createRagdoll({origin, yaw, braceStiffness})`,
  `stepRagdoll(rd, dt, {gravity, groundHeight, iterations, drag, restitution, friction})`,
  `applyImpulse(rd, jointName, {x,y,z})` (single-joint punch), `applyImpulseAll(rd, {x,y,z})` (blast
  knockback), `jointPos`, `kineticEnergy`/`isSettled`, and `rd.bones` (render pairs with role +
  thickness). Seeds a standing A-pose by default; `seedRagdollFromJoints(rd, J, {velocity,
  recomputeRest})` adopts an external joint pose instead (the live body at the moment of death, so the
  corpse flops from where it died) — `recomputeRest` (default true) resets rigid/brace rest lengths to
  the seeded distances so the pose doesn't pop toward the built-in standing lengths on the first solve.
  No self-collision yet (deferred, per the feasibility plan).
- `player-procedural-body.js` — new `setRagdollPose(P)` API (**step A**): poses the whole rig directly
  from the 16 ragdoll joint world positions instead of the IK/gait solve, reusing `placeSegment` so
  limbs stretch identically. Torso orientation comes from a spine-up + shoulder-lateral basis with
  `fwd = up × lateral` — matching the body's hardcoded `+Math.PI` facing convention (`update()`'s
  `targetYaw = state.yaw + PI`, eyes on the head's -Z at yaw 0); `cross(lateral, up)` faces backward
  and snapped the head 180° on death (invisible on the radially-symmetric torso, obvious on the eyed
  head). L/R mesh assignment is cosmetic (symmetric geometry). Call in place of `update()` while dead; works
  in both mesh and instanced mode (the instanced `flush()` reads the same placeholder transforms). The
  mesh path stays byte-identical when `setRagdollPose` isn't called — body Node suites
  (`test-player-body-{gait,ik}`, `test-ghost-renderer`, `test-body-part-batches`) unchanged.
- `ragdoll-viewer.html` — standalone WebGPU harness (same THREE r0.184 CDN pins as the other viewers).
  Two things live here: **(1) stand-in ragdolls** rendered straight from `rd.bones` (stretched
  cylinders, shell/plate/trim by hue) + optional joint spheres — for pure-solver tuning; drop one /
  drop a row of 6 / blast up / reset / clear, with **shift+click a joint to punch it**. **(2) a real
  `createProceduralPlayerBody` demo** (step A): "Spawn body" poses a real mannequin rig standing, "Kill
  (flop)" seeds a ragdoll from its live joints (`seedRagdollFromJoints`) + a death-impulse kick and
  drives the *same rig* via `setRagdollPose` — validating the exact body↔ragdoll joint mapping and the
  render path step B will reuse, before touching live MP code. Live sliders: gravity, solver iterations,
  air drag, ground bounce/friction, spawn height, time-scale, torso stiffness (rebuild), death impulse;
  a **joint-limits checkbox** flips the pole/cone limits on/off live to see the difference.
- `test-ragdoll.mjs` — Node suite (31 checks): construction/topology, fall→land→settle, rigid-bone
  length preservation (<3%, with limits on too), no floor tunneling, corpse collapse height, bounded
  energy (no runaway), single-joint impulse injects energy, whole-body shove slides, blast lift,
  sloped-ground landing, big-dt survival, `seedRagdollFromJoints` (adopts pose, recomputes rest to
  <0.1%, starts at rest, settles), and the cone limits (head cap on backward snap, knee shin-fold cap,
  `jointLimits:false` disables). All green.

- `ragdoll-body.js` (new, **step B**) — the bridge between a live `createProceduralPlayerBody` rig and
  the pure solver, so the body↔ragdoll joint map lives in exactly one place (used by
  `ragdoll-viewer.html`, `bot-viewer.html`, and later the game). `RAGDOLL_JOINT_MAP` (body visual joint
  names → the solver's 16), `ragdollFromBody(THREE, body, opts)` (reads the body's joint world
  positions, seeds a ragdoll, returns `{rd, pose}` where `pose` is the reusable name→live-particle map
  for `setRagdollPose`), `weaponKnockback(weapon)` (per-weapon knockback m/s — respects an explicit
  `weapon.knockback`, else derives from damage+mode: pistol→rifle→sniper for hitscan, light for melee,
  hardest for projectiles/explosions), and `applyDeathImpulse(rd, {dir, strength, hitPoint})` (a modest
  whole-body shove along the shot **plus** a reaction concentrated at the joint nearest `hitPoint` with
  1-hop falloff — headshot snaps the head, a leg hit kicks that leg; no `hitPoint` → upper-body spread),
  and `applyBlastImpulse(rd, from, strength)` (explosion: launches the whole corpse radially away from
  `from` with an upward pop + chest tumble). THREE injected, not imported. Node-tested
  (`test-ragdoll-body.mjs`: knockback ordering, hit targeting, radial blast).

**Step A done + browser-verified.** **Step B (in progress) — wired into `bot-viewer.html`:** when a
bot with a procedural body dies, `killCombatBot` now seeds a ragdoll from its live joints
(`ragdollFromBody`), drops the gun (`destroyBotWeaponMount`), keeps the instanced body, and drives it
via `setRagdollPose` each frame from the dead-actor branch of `updateAllBots` (dead bots skip the FSM
but a corpse still steps). `applyBotDamage` builds the death knockback from the killing shot —
**direction** = bullet travel (shooter eye → hit point), **magnitude** = the shooter's
`weaponKnockback` (per-weapon), **location** = the hit point, so the reaction concentrates where the
round landed (headshot snaps the head, leg hit kicks the leg). Panel: a **"Ragdoll death"** toggle
(falls back to the old tipped-capsule when off or when no procedural body) and a **death-impulse ×**
multiplier on the per-weapon base.

bot-viewer had **no explosions** (every weapon, incl. the RPG, was a pure hitscan), so a minimal blast
mechanic was added to test explosion ragdolls: an explosive weapon (`mode: 'projectile'`, e.g. the RPG)
detonates at its hitscan impact via `detonateBlast(center, weapon, now)` — radial damage falloff
over `BOT_BLAST_RADIUS` (6m) to every alive actor, blast-killed bots ragdoll outward via
`applyBlastImpulse`, plus a pooled expanding-sphere flash (`spawnBlastFx`/`updateBlastFx`). Only the
reusable `applyBlastImpulse` was ever meant to carry over. **This paragraph still describes
`bot-viewer.html` (v1) exactly**; `bot-viewer-v2.html` has since replaced the hitscan detonation with
real flying projectiles, the fixed 6 m radius with the authored per-weapon one, and the sphere pool
with `effect-renderer.js` — see "Explosives in the v2 harness" below.

Remaining step B: port the death ragdoll to `environment-viewer.html`'s `GhostRenderer` death edge,
routing its real hitscan kills through `applyDeathImpulse` and its `applyExplosionBlast` through
`applyBlastImpulse`. No wall collision in v1 (ground plane only).

## Key files

| File | Role |
|---|---|
| `bot-entity.js` | Capsule/physics/pose, including the wire-quaternion facing fix — Browser/THREE only. |
| `bot-activity.js` | Pure FSM decision math (patrol/seek/aim/fire) — Node-tested, THREE-free. |
| `squad-activity.js` | Pure squad decision math for the **env-viewer** Phase 1 system (temperament roll, loss-retreat latch, formation geometry) — Node-tested, THREE-free. **v1-only since 2026-07-30**: `environment-viewer-v2.html` uses `bot-squad.js` instead. |
| `bot-squad.js` | Pure squad math for the **v2 harness**: balanced roster partitioning, leader election + succession shock, formation kinds/slot geometry, corridor fit — Node-tested (`test-bot-squad.mjs`), THREE-free. |
| `bot-roles.js` | Role registry (`rifleman`/`medic`/`squadleader`/`sniper`/`technical`/`droneop`) + batch assignment + `leadership`-ordered leader pick and the bounding-overwatch split — Node-tested (`test-bot-roles.mjs`), THREE-free. |
| `nav-grid.js` | Pure walkable-grid + A* pathfinding, used both for shoot-house's static bake and the terrain local-window — Node-tested, THREE-free. Also carries the optional per-cell surface cost (`setNavTravelCost`, see below). |
| `bot-state-code.js` | Pure 9-slot discrete state code for FSM trace logging/diffing/mining (encode/decode/legality/core projection/`diffCodes`) — Node-tested (`test-bot-state-code.mjs`), THREE-free. Wired into `bot-viewer-v2.html`; browser QA pending. See [`bot-state-codes.md`](bot-state-codes.md). |
| `gen-bot-state-table.mjs` | Regenerates `bot-state-table.md`/`.csv` (434 core states) from `bot-state-code.js`. The table is a printout, never hand-edited. |
| `bot-viewer.html` | Dev harness (v1); not part of the game's module graph, still useful for FSM/nav iteration. |
| `bot-viewer-v3.html` | **The live harness (forked from v2 on 2026-08-08).** All new bot work goes here. |
| `bot-viewer-v2.html` | Frozen playable snapshot of the 2026-08-07 state. Do not edit; it shares the `pcw:bv2:*` localStorage slots with v3. |
| `bot-trace-viewer.html` | Playback tool for saved state traces: animates `bot-states/*.tsv` as a top-down map (position, facing, state, squad links, stall halos) with a scrubber and an activity ribbon. Imports `bot-state-code.js` for decoding. See [`bot-state-codes.md`](bot-state-codes.md). |
| `environment-viewer.html` | Live wiring: `botPlayers`, nav-grid bake + local windows, `updateBots`, `pushBotsApart`, spawn/behavior panel. |
| `shoot-house.js` | Adapter exposes `bounds` for the shoot-house static nav-grid bake. |
| `multiplayer.js` | `GhostRenderer`'s capsule-ghost path renders a smooth (tick()-driven) fall-over death pose for any `alive:false` player/bot pose; `instanceBots` option drives the Phase 4 instanced body pool + per-bot `botBodyStyle` color. |
| `body-part-batches.js` | Phase 4 instanced-render pool for bot bodies: one `InstancedMesh` per shared body geometry, per-instance color; driven by `createProceduralPlayerBody`'s `flush()`. Node-tested (`test-body-part-batches.mjs`). |
| `ragdoll.js` | Pure Verlet ragdoll solver (16-particle humanoid, proportions from `player-procedural-body.js`) with passive angular cone limits + `seedRagdollFromJoints` — Node-tested (`test-ragdoll.mjs`), THREE-free. Solver done; death-pose wiring (step B) pending. |
| `player-procedural-body.js` | `setRagdollPose(P)` poses the rig from 16 ragdoll joints instead of IK/gait (step A) — mesh + instanced; mesh path unchanged when unused. |
| `ragdoll-body.js` | Bridge: `RAGDOLL_JOINT_MAP` + `ragdollFromBody` (seed a ragdoll from a live rig) + `applyDeathImpulse`. One source of truth for the body↔ragdoll mapping; shared by the viewer, bot-viewer, and (later) the game. |
| `ragdoll-viewer.html` | Standalone harness: stand-in ragdolls (drop/punch/blast + physics sliders) **and** a real-body flop demo (Spawn body → Kill) validating `setRagdollPose`. Not part of the game's module graph. |
| `bot-viewer.html` | Step B host: bots with a procedural body ragdoll on death (`killCombatBot`), driven from `updateAllBots`' dead branch; "Ragdoll death" toggle + death-impulse slider. |
| `bot-viewer-visuals-style.js` | Pure look data for the v2 harness: themes, palette maths, `randomTheme(seed)` — Node-tested (`test-bot-viewer-visuals.mjs`), THREE-free. |
| `bot-viewer-visuals.js` | Renderer half: TSL sky dome, the three map node materials, light rig, fog, IBL, post stack, and its own panel section. Browser/WebGPU only. |
| `bot-score.js` | Pure per-team session tally (spawns/deaths/revives/frags) behind the v2 HUD scoreboard — Node-tested (`test-bot-score.mjs`), THREE-free. |
| `bot-projectiles.js` | Pure ballistic aiming + a projectile lifetime manager wrapping `entity-types/combat-projectile.js` (flying rockets/grenades in the v2 harness) — Node-tested (`test-bot-projectiles.mjs`), THREE-free. |
| `bot-drones.js` | Pure drone-operator aircraft: the bomb drone's release solution and go-around, the loitering munition's orbit and dive, target choice and launch gating — Node-tested (`test-bot-drones.mjs`), THREE-free. |
| `flight-meshes.js` | The flight sim's three craft as reusable groups (plane/quad/bird), materials supplied by the caller. Shared by `demos/flight-sim.html` and the bot viewer's drones. See `docs/subsystems/flight.md`. |
| `bot-grenade.js` | Pure grenade-secondary decision math (throw gates/scoring, live-grenade evade urgency) — Node-tested (`test-bot-grenade.mjs`), THREE-free. |
| `bot-stance.js` | Pure per-bot stance channel: the stand/crouch/prone/run/dash decision table over the resolved FSM state, the stand-up hysteresis latch, and the speed/spread/height/turn-rate multipliers — Node-tested (`test-bot-stance.mjs`), THREE-free and zero-dependency. |
| `weapon-hold-resolver.js` | Pure resolution of the third-person weapon hold from (stance × locomotion) — continuous stance lerp plus an additive per-class carry delta. Shared by `bot-viewer-v2.html` and `weapon-animation-viewer.html` so the authoring tool cannot drift from the game. Node-tested (`test-weapon-hold-resolver.mjs`). See Contract 6 in `procedural-body-weapon-contracts.md`. |
| `effect-renderer.js` | Shared layered-explosion / tracer / spark / smoke renderer, also used by `environment-viewer.html`. Stateless: sub-particles regenerate each frame from the wire object + id hash + age. See `docs/subsystems/fx.md`. |
| `weapon-sfx-synth.js` | Procedural WebAudio voices for weapon events with no loaded sample (`rocket_launch`, `explosion`, `grenade_throw`, `grenade_bounce`) — Node-tested (`test-weapon-sfx-synth.mjs`). See `docs/subsystems/audio.md`. |

## Per-cell surface cost in `nav-grid.js` (2026-08-10)

`setNavTravelCost(grid, costAt)` bakes one multiplier per cell into `grid.travelCost` and applies it
in both `findPath` and `floodFill`, averaged over each step's two cells so a boundary crossing is
charged half in and half out. Pass `null` to clear it. A grid built without one carries
`travelCost === null` and searches exactly as before — every existing caller is unaffected.

**Costs are clamped to ≥ 1 (`NAV_TRAVEL_COST_MAX` = 8 at the top).** The A* heuristic charges one
unit per cell, so any cost below 1 would make it optimistic and the returned path would no longer be
the cheapest one. Model a preferred surface as *"everything else is dearer"*, never as *"this is
cheaper than walking"*. `slopeFactor` is already ≥ 1 for the same reason, uphill and down.

First consumer is the road bias in `bot-viewer-v3.html`: cells near a road cost 1, everything
else costs the "open ground costs" slider. Covered by `test-roads.mjs`, which asserts the clamp, that
raising the cost pulls a route onto the road, and that off-road ground stays reachable — the bias is
a preference, never a wall.

`bot-flora.js` gained a matching optional `clearFn(x, z)` ("true where nothing may grow"), checked by
both the grass `acceptFn` and the plant-placement filter, defaulting to `null`. Roads use it to keep
their surface bare. See [`roads.md`](roads.md).

## Level overlay in `nav-grid.js` — decks you fight on *and* under (2026-08-11)

Route B of [`../elevated-structures-plan.md`](../elevated-structures-plan.md). Route C (the `terrace`
kind) gives high ground by raising the terrain, so nav never learns anything new; it can never give
you a surface you walk both over and beneath, because a raised pad under C is solid. This is that
second surface. Node-tested in `test-nav-levels.mjs`.

**The plan's scoping of this was wrong and the correction is the design.** It said the searches run
"over opaque integer keys". They do not: `findPath`, `floodFill`, `labelRegions` and
`cheapestSoftLink` each decompose the key with `k % cols` / `(k / cols) | 0` and rebuild neighbours
from column/row deltas. Key↔(c,r) was inlined in every search, which is exactly what a second level
breaks. So the change is a **shared neighbour expansion** (`expandNeighbors`, which every search now
calls) rather than a bolt-on — four copies of the corner rule would have drifted the moment any one
of them changed.

### The data

`buildNavGrid(..., { decks, levels })`, where a deck is `{x, z, w, d, y}` — centre plus full extents,
`y` being the walking surface. `attachLevels` rasterizes each onto the columns whose **centre** it
covers, the same rule `rasterizeBlockers` and `buildSightGrid` use, so a deck edge lands on the same
cells everywhere. Two decks at one height over one column merge.

| | |
|---|---|
| Base keys | `0 .. cols*rows-1`, unchanged, as are `cells`/`heights`/`soft`/`travelCost` |
| Level keys | allocated **after** that range, one per level cell, chained per column |
| `grid.levels` | `null` unless decks were passed — a deck-free map is byte-identical |
| `LEVEL_DEFAULTS.step` | `0.5` m — most a body may climb or drop to change surface |
| `LEVEL_DEFAULTS.tolerance` | `1.0` m — how far a "which surface am I on" query may miss by |

Helpers: `keyCount`, `keyIsLevel`, `keyBase`, `keyHeight`, `keyWalkable`, `keyToWorld`, `keyAt`,
`nearestWalkableKey`, `floodPathToKey`. `findPath`/`floodFill`/`reachable` endpoints may now carry
`y`; omit it and you get the old ground-level answer. Waypoints gain a `y` property on a level grid,
so a 2D consumer reading `.x`/`.z` is unaffected either way.

### Two rules make it architecture rather than a second ground

- **A step is height-gated only when a level is involved.** Base→base stays the continuous ground it
  has always been — nav charges slope as *cost*, and the caller's own test rejects cliffs. So adding
  a deck somewhere cannot change how a bot walks up a hill somewhere else. This is what makes the
  byte-identical claim hold rather than merely being asserted.
- **`step` is 0.5 m**, which clears everything nav's own slope gate already allows (`maxSlope` 0.85
  over a 0.5 m cell = 0.43 m) but not a deck edge. So a platform's side excludes *itself* and the
  only way up is a chain of rects you deliberately provide. **A ramp is just several thin decks at
  stepped heights** — nav needs no ramp concept at all.

### The lookup, whose assertion is the refusal

`keyAt(grid, x, z, y, tolerance)` returns the surface nearest `y`, **or `-1`**. With no level inside
tolerance it returns nothing rather than the nearest one, so a bot beneath a deck can never be
mistaken for a bot standing on it. `nearestWalkableKey` refuses the same way after its spiral. The
slab contract's ≥1.8 m headroom is what makes 1.0 m a clean separator. Tested at 3.0 m (deck), 0 m
(ground) and 1.5 m (neither → `-1`).

### Measured

- **Regression proved against `versions/nav-grid-before-levels-20260811-222855.js`, not against
  itself.** Two fixtures on purpose: `rolling` is open enough that 120/120 sampled pairs have a
  route, `broken` is steep enough to produce 177 regions, 151 carved cells and 70 sealed. On
  `rolling` alone the section passed while carving nothing — it was agreeing about code neither
  build had run. Cells, heights, soft, regions, region sizes, carve order, sealed list, every A*
  path, every smoothed path, and floodFill's full dist/parent arrays all match.
- **Deck behaviour:** 24 m of ramp reaches a 3 m deck; delete the ramp and `findPath` is `null` and
  `reachable` agrees. From the east the route walks 34.0 m round to the ramp against a 10.0 m
  straight line — it does not step up the edge. The ground under the deck stays walkable end to end
  and that route never rises above 0.6 m. `connectStrandedRegions` carves **0** cells for a rampless
  deck and records it as sealed instead, because levels are never soft.
- **Cost on maps that have no decks:** pathfinding **+1.7%**, floodFill +3.6%, bake **+21%**
  (18.8 → 22.7 ms on a 344×344 grid, median of 20). The bake cost is `labelRegions` materialising
  all eight neighbours before filtering, where the old loop rejected already-labelled ones first.
  That is ~4 ms once per map rebuild against 1.7% on the search that runs per frame, so it was not
  worth keeping a second copy of the corner rule to recover.

### What this does NOT do yet

**The visibility field and corner map are still one surface per column.** `nav-visibility.js` sizes
`walkIndex`, the sight grid and the height grid by `cols*rows` alone, so a level key is out of range
and `canSee` answers `false`; `nav-corners.js` reads `navGrid.cells` and scans one height per column.
A bot on a deck therefore gets **no cover records rather than wrong ones**. Both files now say so at
the top and the built field reports `levelsIgnored`, so this is loud instead of a quietly halved
cover map. Live LOS in v3 is a raycast, so a deck bot still shoots correctly.

Nothing in `bot-viewer-v3.html` passes `decks` yet — threading `y` through the "where am I" call
sites is the remaining step, and no structure kind emits decks.

## Locomotion weapon carries + the dash stance (2026-07-27, `bot-viewer-v2.html`)

Bots used to hold the gun in exactly one place. `updateBotWeaponMount` hardcoded `def.thirdPersonHold`,
so the `crouchHold` / `proneHold` that `weapons.js` has carried since 2026-07-08 — and that
`environment-viewer.html` already blends — were dead data here: crouched and prone bots held the
weapon at standing height. That is fixed, and the same resolve now carries walk/run/dash poses.

**`weapon-hold-resolver.js` (new, pure, Node-tested)** owns the whole resolve; see Contract 6 in
`docs/subsystems/procedural-body-weapon-contracts.md` for the frozen shapes and sign conventions.
Stance is a continuous lerp on the rig's own eased `{crouch01, prone01}` weights; locomotion is an
additive per-class delta (`CARRY_PRESETS`, opted into by `carryClass` in `weapons.js`), itself eased
so transitions glide. Walk and run point the muzzle down and swing the weapon across the body; dash
points it up, one-handed.

**`STANCE_DASH`** is the blast-evade sprint. It sits above every rung in `chooseBotStance` — mirroring
`updateGrenadeEvade` outranking every movement handler — and is the one stance that pays no exit cost,
because a prone bot must leave the pose the instant the movement code sprints it rather than sliding
prone for the whole `standUpMs` window. It is faster than RUN (`dashSpeedBonus` 1.15× on top of the
run multiplier), has the worst spread cone in the table (`dashSpreadScale` 1.9, one-handed at a
sprint), turns unpenalised, and keeps the full capsule.

The trigger is `updateGrenadeEvade` stamping `actor.evadingUntil = now + 600 ms`, read by the *next*
frame's stance resolve (the evade handler runs after it). A self-expiring stamp rather than a boolean:
the handler early-returns once the threat list empties, so a flag it owned would latch the dash on
forever. The 600 ms linger also stops the pose flickering off the frame a grenade detonates.

Two rules the mount now honours:

- **A carry is never barrel-solved.** `alignMountedWeaponToPoint` is gated on `!carrying`; solving a
  muzzle-down hold onto the aim point would undo the entire pose. (`locomotionFor` is the single
  source of truth for "is this bot aiming" — `isAiming` is derived back out of it, so the pose, the
  barrel solve and the off hand cannot disagree.)
- **Dash frees the support hand**, tucking it at the chest with the elbow outward, written after
  `controller.update()` drives both hands to their grips. Only touched on a change, so the medic and
  heal pose overlays that also own the left arm are not fought every frame.

### The shot and the aim were two different decisions (fixed 2026-08-06)

Symptom: sniper bots firing into the sky. The FSM gated the shot on the **entity's** yaw/pitch
(`aimError <= AIM_TOLERANCE_RAD`, `bot-activity.js:108`) but `fireBotShot` took its direction from
the **rendered** barrel (`botMountedBarrelRay`), and nothing forced the two to agree at the instant of
the shot. `updateBotWeaponMount` — the only thing that ever puts pitch on the weapon rig, since the
rig itself gets `Euler(0, bodyYaw, 0)` — runs *after* `updateBotSentry` in the frame and skips its
solve in three cases: while carrying, while a reload sequence is playing (`lockAimedPosition`), and on
a rig-LOD frame (every 2nd past 18 m, every 4th past 45 m). An unsolved m24 hold sits ~6° above
horizontal, which is a near miss at 20 m and a tracer into the sky at 200 m.

Three fixes, all enforced by `test-bot-fire-aim-sync.mjs` (a source-parsing test — the viewer cannot
run in Node):

- **`fireBotShot` solves the barrel onto `botAimPoint` before reading it.** One quaternion and one
  matrix update per round fired. The confirmation and the shot are now the same decision. The solve is
  idempotent (a relative correction from the current ray) and `updateBotWeaponMount` rebuilds the rig
  transform from scratch anyway, so nothing accumulates.
- **Every state that fires is in the mount's `aiming` set** — `BOT_COVER_MOVE`, `BOT_COVER_HOLD`,
  `MEDIC_MOVE` and `MEDIC_TEND` joined `BOT_AIM`/`BOT_FIRE`/`BOT_FLEE`. The first two fire while
  running (`bot-stance.js:98` gives them `STANCE_RUN`), so they had been shooting down the rifle walk
  carry: 67° right and 17° down. Consequence: cover-holders and tending medics now show the aimed pose
  rather than low-ready.
- **`botHasAimPoint` is cleared when the target dies or is removed.** It was set true and never set
  false again, so a bot with no target kept solving its barrel onto a corpse's last eye position.

The debug reticle (`bot-viewer-v2.html:4352`) draws from entity yaw/pitch, so it showed these shots as
locked on. It cannot surface this bug class; the test is the guard.

### The mount frame must be stance-invariant (fixed 2026-07-29)

Enabling the crouch/prone holds surfaced a second bug: crouched bots put their **arms through the
floor**. The mount had drifted to tracking the torso joint, but the authored holds live in the
ground-anchored frame `body-preview-v3.html:3925` and `environment-viewer.html` use — body XZ at
`terrainHeight + 1.5`, which does not move with stance. So the crouch drop was counted twice: the
torso itself falls ~0.75 m (`pelvisDrop` 0.62 + `torsoDrop` 0.25) and `crouchHold` then subtracts
another ~1.0 m. Measured on the CZ: standing put the weapon at 2.420, crouching at 0.664 — a 1.756 m
drop where 1.010 m was authored. The IK hands followed it underground. Prone double-counted the same
way through `proneCfg`'s torso offsets.

The rig is now placed at `(bodyPosition.xz, feetY + 1.5)`, stance-invariant, and **bob and sway are
re-added explicitly** — `motion.bob` on Y, `motion.sway` along body-right on XZ, both scaled by
`(1 - prone01)`. They have to be, because no joint carries the gait motion without also carrying the
stance pose, and losing them was what made the weapon feel detached in the first place. Standing is
bit-identical to before the fix (2.420 either way); only crouch and prone change.

`weapon-animation-viewer.html` mirrors this exactly — it had inherited the same torso mount.

**Authoring** is `weapon-animation-viewer.html`'s new *Carry* panel, which imports the same resolver
and drives the previewed body around a circle at the selected locomotion's real speed (walk 1.6, run
3.6, dash 4.6 m/s) — a static body cannot show whether a carry reads against the rig's bob and sway.
Editing a delta feeds a live `carryHolds` overlay through the production resolver, so the preview has
no parallel math of its own. Export copies a paste-ready `CARRY_PRESETS` block.

That tool also had a parity bug worth knowing about: it mounted the rig at a static `(0, 1.5, 0)` and
yawed it `bodyState.yaw + Math.PI`, while v2 mounts torso-relative at `visualYaw + headYaw` through an
identical rig/adjust/frame/view chain — so every hold previewed 180° off from how it rendered in game.
The viewer now mirrors v2's mount exactly.

**Status.** Node-tested (`test-weapon-hold-resolver.mjs` 79 checks, `test-bot-stance.mjs` 197). The
carry delta values are first-pass starting points authored to be tuned in the viewer, not final.

**Stance-aware carry deltas (added 2026-08-04).** A carry entry (`walk`/`run`/`dash`, either on
`CARRY_PRESETS` or a per-weapon `carryHolds` override) is normally one flat `{position, rotation}`
delta applied unchanged at every stance. The RPG needed more: its length read backwards-looking when
carried at the generic rifle walk pose while prone, but the pose that fixed prone looked wrong
standing. `carryDeltaFor` now takes a third argument — the same eased `{crouch01, prone01}` weights
`resolveWeaponHold` takes — and a carry entry may opt into `{ stand?, crouch?, prone? }` instead of the
flat shape; missing stances fall back along the chain `crouch -> stand`, `prone -> crouch -> stand`,
and the map blends with the identical prone-dominates-crouch curve the stance holds themselves use, so
the carry never disagrees with the hold it stacks on mid-transition. See Contract 6 in
`procedural-body-weapon-contracts.md` for the full shape. `weapons.js`'s `rpg.carryHolds.walk` is the
first (and so far only) user: `{ stand: {...}, prone: {...} }`, crouch unauthored and falling back to
stand. Both `bot-viewer-v2.html` and `environment-viewer-v2.html` now pass the actor's `stanceWeights`
into `carryDeltaFor` — a caller that forgets silently resolves any stance-aware entry as if standing.

`weapon-animation-viewer.html`'s Carry panel Stance dropdown used to be preview-only (it re-posed the
body but always edited the same one flat class-level bucket regardless of which stance was selected —
tuning against a prone preview silently overwrote the standing value too). It now edits a genuinely
separate bucket per stance (`carryEdits[cls][stance][kind]`, all three seeded identical to the shipped
preset), and the live preview overlay is always built as the stance-map shape so it blends through the
production resolver exactly as the game would. `Copy presets`/`Reset entry` operate on the
currently-selected stance's bucket; the exported `CARRY_PRESETS` block collapses a class back to the
flat shape when its three stances haven't diverged, so an untouched class exports byte-identical to
today. The tool still has no export path for a per-weapon `carryHolds` override (class-level
`CARRY_PRESETS` only) — that stays a hand-edit into `weapons.js`, in the same shape the panel previews.
`bot-viewer-v2-camera.html` (the forked camera rewrite, pending merge) still carries the old
hardcoded `thirdPersonHold` mount and the pre-dash stance list.

## Aim coherence (2026-08-12, `bot-aim-blend.js` + `bot-viewer-v3.html`)

Symptom, in the user's words: *"the bots don't really aim, as much as the weapon kinda rotates."*

Diagnosis: that was literally the code. `alignMountedWeaponToPoint` applied its **whole** correction
every frame, unbounded and unsmoothed, so the gun was on target in frame 1. The body slewed at
`TURN_RATE_RAD_S` 4.5 rad/s scaled by stance (0.80 crouch, 0.55 kneel, 0.35 prone) and was then spring-
smoothed again by the rig's `turnCfg` — up to ~1.3 s behind. The spine and the shoulder sockets had no
aim input at all (only `loco.torsoLean` / `loco.shoulderYaw`), `bot.pitch` reached nothing but the head,
and the head's yaw was turn *anticipation* (`targetYaw − visualYaw`), which points away from a target it
has finished turning toward. The hands bridged the gap by stretching. Full trace and the plan:
`docs/bot-aim-coherence-plan.md`.

**The reframe:** the barrel solve stops being the aiming mechanism and becomes an error-nulling trim.

### `bot-aim-blend.js` (pure, THREE-free, Node-tested via `test-bot-aim-blend.mjs`)

`solveAimBlend(yawResidual, aimPitch, cfg, out)` splits the angle between the body's **rendered**
facing and the aim point:

| Out | Meaning |
|---|---|
| `torsoYaw` | `clamp(residual × torsoYawShare, ±torsoYawMax)` — the spine twist |
| `torsoPitch` | `clamp(aimPitch × torsoPitchShare, ±torsoPitchMax)` — the spine lean |
| `headYaw` | `clamp(residual − torsoYaw, ±headYawMax)`, **relative to the twisted spine** |
| `headPitch` | `aimPitch − torsoPitch`, so the total elevation is unchanged |
| `barrelYaw` / `barrelPitch` | what the trim still has to cover |

Also `stepAimChannels` (per-bot easing), `barrelTrimFraction` / `releaseTrimFraction` (the rate limit),
`aimLeadSeconds`, `addRecoil` / `stepRecoil`, and `directionError`. Every function returns the legacy
value when `cfg.enabled` is false — `test-bot-aim-blend.mjs` pins that as its last block.

### Rig channels (`player-procedural-body.js`)

Four new optional `state` fields, all defaulting to 0, so every other viewer sharing this rig renders
exactly as before: `aimYaw`, `aimLean`, `lookYaw`, `lookWeight`.

Two constraints found by reading the rig, both of which would have failed silently:

1. **The aim twist is not gated on `_spineLw`.** That locomotion weight is `loco ? (1−pw)(1−kw) : 0`,
   which collapses to zero when kneeling or prone — exactly the stances with the slowest turn rate and
   the worst decoupling. `spineOrient` now applies the locomotion terms under `_spineLw` and the aim
   terms under `frac` alone.
2. **`_shoulderQ` takes the full aim twist.** The sockets are built from `_orient` (+ the locomotion
   shoulder yaw), *not* from `_upperQ`. A spine that twisted without them would leave the arms hanging
   off the old chest facing.

`lookYaw` **blends over** the anticipation term rather than replacing it
(`anticipate + (lookYaw − anticipate) × lookWeight`), so patrol and idle scanning are untouched at
weight 0.

### Viewer wiring (`bot-viewer-v3.html`)

- `stepBotAimChannels(dt)` measures the residual against `motion.visualYaw` (what is on screen), not
  `bot.yaw` (the sim's), and eases each channel per bot. No aim point hands the channels back to zero
  and the head back to `bot.pitch`, so acquisition and loss are the same code path.
- The **mount root** is now built the way the rig builds its shoulder line — `Ry(yaw) · Rx(aimLean) ·
  Ry(aimYaw)` — instead of `Euler(0, yaw + headYaw, 0)`. The gun rode the *head's* anticipation before,
  which leads a turn and then recentres. The mount stays ground-anchored at `feetY + 1.5`: the aim
  **rotation** goes on it, never a reparent to the torso (see the stance-invariance section above).
- `stepBarrelTrim` replaces the direct `alignMountedWeaponToPoint` call. Because the rig is rebuilt
  from the authored hold every frame, a rate limit needs the correction to **persist** — otherwise each
  frame restarts from the hold and the gun sits at a fixed fraction of the way there forever. The
  persistent `actor.aimTrim` quaternion is chased toward the exact solve at `barrelRate` (7 rad/s) and
  unwound at `releaseRate` (6 rad/s) when the aim point clears.
- **A2:** `botAimGateOk` gates firing on `botBarrelAimError()` — the angle between the rendered barrel
  and the line from its muzzle to the aim point — instead of the entity's eye-derived error. This is
  what stops a rate-limited barrel from firing before it has caught up, and it closes the eye-vs-barrel
  parallax gap the previous fix could only paper over. It falls back to the entity error when the
  barrel was not solved within the last 6 frames (a carry or reload pose is not a failed aim), and the
  FSM's own AIM→FIRE rung reads the same number, so the `fire` state means the *gun* is on target.
- `fireBotShot` no longer re-solves the barrel at the trigger while the trim is on: the round must
  leave down the barrel the player can see. The legacy snap survives behind `!trimOn`, and
  `test-bot-fire-aim-sync.mjs` asserts both arms.
- **Lead** applies flight time only. Hitscan weapons get none on purpose — an instant round aimed
  ahead of a runner is a guaranteed miss *ahead*. `leadLatencyS` defaults to 0; the slider exists so
  tracking-ahead can be tried by eye.
- **Recoil** adds a torso pitch impulse per shot (`recoilKick` 0.05 rad, decaying at 7/s) on top of the
  weapon-local recoil the pose controller already plays.

### Panel

`bots ▸ Aim coherence`: a master toggle plus one per track (torso B, head C, trim A1/A3, barrel gate
A2, lead D, recoil D), then four slider groups (Torso, Head, Barrel trim, Lead & recoil). Saved and
restored with the rest of the bot slot as `aimBlend`. Master off is a direct A/B against the old
behaviour.

**Untuned.** Every number above was chosen from the rig's geometry, not from watching a bot use it.
The authority split in particular is a by-eye setting.

## Visual system in the v2 harness (2026-07-25, `bot-viewer-v2.html`)

`bot-viewer-v2.html` used to render a flat grey box: three `MeshStandardMaterial`s, a sun + one
overhead point light, a solid `scene.background`, and a "Scene look" panel whose Saturation slider
was a CSS `filter: saturate()` on the canvas. That is all gone. The look now lives in two files,
split the same way `shoot-house-style.js` / `shoot-house.js` are:

| File | Contents |
|---|---|
| `bot-viewer-visuals-style.js` | Pure data + maths. No THREE import, so it is Node-testable. Also owns the audio-reactive routing table (`REACTIVE_TARGETS`, `REACTIVE_KEYS`, `REACTIVE_MAX`, `defaultReactiveTargets`, `reactiveGain`, `advanceAudioMix`). |
| `bot-viewer-visuals.js` | `createVisualSystem({ THREE, renderer, scene, camera, postFX, rig, overheadLight, getAudioLevels? })`. Builds nodes and DOM. `getAudioLevels` (from `environment-audio.js`) enables optional audio-reactive lighting across five routed groups — accent lights, bloom, map neon, bot glow, sky — driven here but controlled from the viewer's Audio panel section via `setAudioReactive()` / `setAudioDrive()` / `setAudioTarget()`, with `reactiveTargets` exposed so the panel builds its chips from the same table. Every group multiplies the theme-resolved value captured by `applySky`/`applyMaterials`/`applyBots`, writes only while pumping, and is clamped — see `docs/subsystems/audio.md` § Reactive routing. |

### Themes

A **theme** is one complete look — `bg`, `fog`, `sky`, `lights`, `mats`, `bots`, `post`, `env` — plus
a `toggles` patch over `DEFAULT_TOGGLES`. `validateTheme()` lists any missing field and is what the
Node test asserts against, so a half-filled theme fails in `node`, not in the browser.

`normalizeTheme(t)` backfills whole sections and individual keys a theme predates. The panel's
save/load slots store a theme **verbatim** (sliders edit it in place, so a key alone would lose every
hand-tweak), which means a slot written before a section existed would otherwise reach the renderer
as `undefined`. `setTheme()` runs every incoming theme through it, so old slots keep working.

| Key | Look |
|---|---|
| `hangar` | The old neutral grey box, cleaned up. Neon off. The "nothing fancy" baseline. |
| `internetcore` | The shoot-house palette (`shoot-house-style.js`) pushed further: black deck, glowing grid, cyan trim, magenta rim, scan ring. **Default.** |
| `orbital` | Station deck: starfield + a large lit planet outside, cold key, warm amber interior trim, reflective floor. |
| `blacksite` | Emergency lighting — red/amber, thick haze, almost no key, fast trim pulse. |
| `daybreak` | Flat bright daylight, neon off. The readable one for actually watching bot behaviour. |
| `noir` | High-contrast monochrome (`saturation: 0`), white rim, heavy vignette. |
| `toxic` | Irradiated green haze with a green gas giant. |

`randomTheme(seed)` rolls an eighth look procedurally: one base hue, a harmony offset
(complementary / triadic / analogous) for the neon accent, the opposite for the secondary, and
everything else derived. `accentOver()` walks each accent toward white-hot until it clears the
surface it sits on by `TRIM_LUMA_GAP` — without it a deep-blue accent at `l=0.6` can be *darker*
than the wall it is meant to outline, and the roll comes out flat. The Node test rolls 400 seeds
and asserts every emissive accent stays readable and every value stays inside its panel slider's
range. Same seed → identical look (mulberry32, the maze's generator).

### What the shaders do

Everything a shader reads is a `uniform`, so switching theme is a value write — never a material
rebuild, which on the WebGPU backend means a pipeline recompile hitch.

- **Sky dome** — `MeshBasicNodeMaterial`, `BackSide`, `fog = false`, re-centred on the camera every
  frame (base radius 150 < `camera.far` 200; the v2 Camera panel's "view distance (m)" slider raises
  `camera.far` up to 2000 and rescales the dome to 75% of it, since the dome depth-tests and would
  otherwise hide everything beyond its radius). Vertical gradient, a banded nebula (2-octave fbm — each
  extra octave is 8 more hashes across every background pixel), three star layers, a sun glow, and
  an optionally-lit planet with a limb terminator and an atmospheric halo. The star field took
  three rounds of browser QA and each failure mode is worth knowing:
  1. Star size is a **fraction of a cell** -- at ~1.0 every cell is one solid star and the sky
     tiles into visible squares. `angRadius = sizeMul/scale` radians; at ~20 px/deg a bright core
     wants ~0.0025 rad (about 3 px).
  2. **Occupancy must stay low** (a few percent of cells). At ~25% the field reads as TV static.
  3. **Magnitude and colour have to vary.** The first version multiplied brightness by the raw
     occupancy hash, whose surviving range is nearly constant -- so every star came out the same
     size, the same brightness and the same white. The hash is now remapped to [0,1] across the
     surviving range and raised to a power, so most stars are faint and a handful are bright,
     each tinted along a cool->warm axis, with a wide dim halo for bloom to catch.
  4. **Below the horizon is not automatically empty.** The first version faded stars out under
     `d.y = 0`, which is right for `daybreak` (there is ground down there) and wrong for every
     other theme — the map is a slab floating in the void, so looking down showed a black band.
     `sky.starWrap` (0..1, per theme, and a "stars below horizon" slider in the panel) selects
     between the two: 1 wraps the field right around, 0 stops it at the horizon.

  The nebula band likewise has to be narrow and high-contrast or it washes the whole sky flat.
- **Floor** — world-space grid (every 4th line brighter, faded by camera distance) plus an
  expanding scan ring from the arena centre. Grid lines are ~5 cm; at 2 cm they render sub-pixel
  from orbit distance and look like the grid is off.
- **Wall** — trim bands keyed off `BoxGeometry`'s `uv.y` (0 at the bottom, 1 at the top on side
  faces), so a band is a fraction of *each box's own height* and survives terrain-sunk walls where
  a fixed world-Y band would float. Plus a travelling energy pulse and a fresnel silhouette rim.
- **Cover** — diagonal hazard stripes belted to the top third of each piece, plus an emissive cap.

### Lights, fog, reflections, post

`createVisualSystem` drives the existing `rig.dirLight` / `rig.ambLight` / `overheadLight` from
theme values, and adds a rim `DirectionalLight` plus four `PointLight`s at the arena corners that
breathe out of phase. `setBounds(activeBounds)` — called from `applyLayout()` — recentres the floor
grid/scan ring and repositions those accents, so they track the maze as it grows.

Fog is `FogExp2`. Reflections are **off by default**: enabling them PMREMs the sky dome into
`scene.environment` (near/far straddling `SKY_RADIUS`, since PMREM's default far of 100 sits
*inside* the dome) and swaps the floor to the theme's `reflectMetalness`/`reflectRoughness`. If
PMREM isn't available in the running three build it logs a warning, turns the toggle back off and
carries on — it never takes the viewer down.

Post goes through `post-fx.js`. `setToneMapping` rebuilds the output graph, so it is only called on
an actual operator change, not on every slider drag.

### Panel

`visuals.buildPanel()` returns DOM built in the viewer's own `#ctrl` idiom (`.ttl` headings,
full-width buttons, `.row` sliders) and is spread into `ctrl` where the old "Scene look" section
was. It offers: theme dropdown + 🎲 roll + reset; master brightness / saturation / bloom / neon
gain / fog density; tone-map operator, exposure, contrast, vignette; toggles for sky, stars,
nebula, planet, sun glow, fog, grid, scan, trim, pulse, rim, shadows and reflections; and sky
detail sliders (star gain/density, stars below horizon, nebula gain, planet
size/azimuth/elevation).

**A theme supplies toggle *defaults*, not toggle values.** `toggleOverrides` holds only the toggles
the user has explicitly clicked; `resolveToggles()` recomputes `toggles` as
`{ ...togglesFor(theme), ...toggleOverrides }` on every theme change. The first version just did
`toggles = togglesFor(theme)`, so picking a preset silently undid every toggle decision you had
made — turn the planet on, try another look, and it was off again with no way to keep it. A pinned
toggle now gets a blue left accent bar; **shift+click** hands it back to theme control, and
**Reset theme defaults** unpins everything and returns the master sliders to 1. Master sliders
(brightness/saturation/bloom/neon/fog) already persisted across theme switches; the theme-detail
sliders (exposure, contrast, star gain, nebula gain…) deliberately do not, since those values are
only meaningful relative to a particular theme.

The camera section also gains **Shuffle look too**: when on, `shuffleScene()` rolls a fresh
procedural theme alongside the layout, so an unattended auto-shuffle session never repeats a look.
Pinned toggles survive that too.

### Status

Browser-verified 2026-07-25 in Chrome/WebGPU: all seven themes, a procedural roll, the reflections
toggle, maze + cover pieces, and uneven terrain all render with no console errors. **Frame rate is
not verified** — the QA tab was backgrounded and Chrome freezes `requestAnimationFrame` in hidden
tabs, so no trustworthy fps reading was possible. Worth a focused-window check with the Test
condition (30×30 maze, 200 dummies) before leaning on the heavier themes.

### Cyclic locomotion overlay (2026-08-07)

`naturalLocomotion` is **on** for bots (`bot-viewer-v2.html`, the single
`createProceduralPlayerBody` call). Four `botMovementSettings` fields drive it through
`applyBotMovementSettings`, so they reach every per-actor body and ride the save/load slots:
`locoEnabled`, `locoAmount` (scales every cyclic amplitude off `LOCOMOTION_DEFAULTS` at once, for
A/B against the old look), `stepOverlap` (0.22) and `spineFalloff`. See
`docs/subsystems/procedural-body-weapon-contracts.md` for the layer itself.

`locoEnabled` had no control until 2026-08-09 — the only way to dial the layer back was the amount
slider, and `locoAmount` did not scale `armSpread`, so at 0 the arms still drifted 5 cm outward and
the A/B was not clean. **v3** now has a `Natural locomotion: On/Off` button above **Cyclic amount**
in Movement tuning, flipping `cfg.enabled` on every live body through `applyBotMovementSettings`
(which every body-creation path already calls, so new spawns inherit it), and the amount now scales
`armSpread` too, so 0 and Off are the same pose. v2 is frozen and keeps the old behaviour.

**Gait model A/B (2026-08-10).** A `Gait model` dropdown above the **Lean into step** slider picks a
`GAIT_MODELS` entry (`movementTuning.gaitModel`). `Shipped` is today's behaviour; `Tuned (lead)`
carries the same speed fit with `stepLeadScale` 0.55, which aims each foot at the ground the hips
cover during its swing instead of straight underneath them. Selecting a model also writes its
recommended lead into the slider, so the panel keeps one source of truth and the change is visible.

Watch a **running or dashing** bot: at a walk the correction is small, but at a dash it takes the
planted foot from 0.099 m past leg reach to 0.004 m. The rig cannot bend a leg further than straight
(`solveTwoBone` clamps at 0.999 of full extension), so that overshoot was the drawn foot sliding
away from where the simulation had planted it. Both fields ride `botMovementSettings`, so save/load
slots cover them without change. Measurements and the objective behind the number are in
`docs/subsystems/procedural-body-weapon-contracts.md`.

Five diagnostic parts were added to the existing **Movement debug** overlay
(`botMovementDebugParts`), each with its own toggle:

| Part | Draws | Reads correct when |
|---|---|---|
| `phase` | Stride-phase dial over the head, ticks at 0 (left) and 0.5 (right) | the marker crosses a tick as that foot lifts; drift = the phase lock slipping |
| `footfall` | Fading dot at each real lift, coloured by side | flashes line up with the dial's ticks |
| `twist` | Bars at hips, mid-spine and shoulders | hips and shoulders scissor in **opposite** directions |
| `trace` | Pelvis trail, last ~3 s | a smooth arc, not a sawtooth (a sawtooth is the old once-per-stride bob) |
| `support` | Line between the feet, green in double support / red in single | green shrinks as `stepOverlap` rises |

`trace` and `footfall` are sampled **every frame** by `sampleBotLocomotionDebug()`, separately from
the 15 Hz geometry rebuild — at 15 Hz the bob aliases into a sawtooth and short swings are missed
entirely, which would make the overlay report the bug it exists to disprove.

## Bot lighting (2026-07-26, `bot-viewer-visuals.js` + `body-part-batches.js`)

The dim themes above exposed an asymmetry: **the map emits, the bots only reflected.** Walls, floor
and cover carry `emissiveNode` trim/grid/pulse terms, so they stay bright however far the light rig
is turned down — while the bots, plain `MeshStandardMaterial` with per-instance colour on diffuse
only, simply went dark with the rig. The fix is to give the bots the same treatment rather than to
add lights, in four layers that stack.

The layer names below are also the toggle keys, all five in `DEFAULT_TOGGLES` and all pinnable.

### 1. Self-illumination — `botGlow` / `botRim`

`createVisualSystem` now builds the four role materials (`shell`/`plate`/`trim`/`eye`) and hands them
to `createBodyPartBatches({ materials })`. Roughness/metalness are copied from the originals so the
shading is unchanged; what is new is an `emissiveNode`:

```
instanceTint * roleGlow  +  mix(rimColor, instanceTint, 0.35) * fresnel * rimGain
```

- **`instanceTint`** is `varyingProperty('vec3', 'vInstanceColor')` — the varying `InstanceNode`
  writes. `NodeMaterial` multiplies per-instance colour into the *diffuse* term for you, but nothing
  feeds it to an `emissiveNode`, so it has to be read explicitly. It is fetched off a namespace
  import (`import * as TSL`) so a build without that export degrades to un-tinted glow at runtime
  instead of failing the module link and taking the whole viewer down.
- **Weighting is on `shell`, not `trim`.** Counter-intuitive, and worth knowing before you retune:
  in this rig the team colour lives in the shell parts — `bot-viewer-v2.html` builds bodies with
  `style: { shell: teamShell, plate: teamPlate, trim: 0x0a0d0a }`, and both `plate` (`0x101410` /
  `0x171012`) and `trim` are authored near-black. Emission on trim multiplies a near-black tint and
  does nothing. `test-bot-viewer-visuals.mjs` asserts `shellGlow >= plateGlow` for every theme so a
  future edit can't quietly put the glow back on a black role.
- The fresnel rim leans 35 % toward the bot's own colour so teams stay apart even in silhouette.
- The **eye** bucket never gets an instance colour allocated, so it takes `theme.bots.eyeColor`
  directly and reads as a lit visor. `botGlow: false` zeroes all four glow uniforms, which restores
  the original flat-black eye and the pre-2026-07-26 look exactly.

**`bots.eyeColor` is its own slot** (added 2026-07-26; the visor previously borrowed `bots.rimColor`,
which meant the fresnel edge and the visor could never disagree). `internetcore` now pairs a cyan rim
with a magenta visor, `orbital` a blue rim with amber, `blacksite` an amber rim with red; the other
four keep visor == rim, so their look is unchanged. `randomTheme` gives the visor the roll's `accent`
and the rim its `second`, so a roll always puts both palette hues on the bot. Saved look states
predating the slot are handled explicitly in `normalizeTheme`: the generic REQUIRED-key backfill
would hand them the *default theme's* visor, so `eyeColor` is instead restored from the save's own
`rimColor` — a pre-slot save renders exactly as it did.

`body-part-batches.js` gained an optional `materials` override. Callers that pass their own keep
ownership — `dispose()` skips them — so `bot-viewer.html` (v1) and `multiplayer.js`, which share that
module, are untouched.

### 2. Ground pools — `groundPools`

One soft additive disc per bot, `PlaneGeometry` instanced through the same immediate-mode contract as
the body pool (`beginBotFx` / `addBotFx` / `endBotFx`), tinted by team colour: **one draw call for
the whole roster.** It fakes the contact light a real per-bot lamp would cast, stops bots floating
over a dark deck, and reads stance from overhead — `poolScaleForHeight(height)` widens the patch as
the capsule shortens, so crouch and prone spread without any extra state being plumbed through.

The radial falloff is `pow(smoothstep(1,0,d), 2.4)`, not a bare `1-d`: a linear rolloff clips against
the additive ceiling and the pool reads as a hard-edged solid disc rather than light on a floor.
`daybreak` sets `poolGain: 0` — additive pools under real daylight only wash the bots out.

### 3. Dynamic light budget — `dynamicLights`

**Not one light per bot.** 200 dummies × one `PointLight` is a per-pixel loop over 200 lights across
the whole screen plus 200 uniform uploads a frame; it is a non-starter, and so is porting
`clustered-lights.js`, which would also require the bot materials to become node materials for a
problem that emission already solves. Instead there is a fixed pool of `DYN_LIGHT_COUNT` (**2**) real
point lights that *events* borrow for a few frames:

- `visuals.flash(pos, opts?)` — called from `spawnTracer()` for every muzzle flash and from
  `spawnBlastFx()` (louder, longer, warmer) for every explosion. Records live in a pre-allocated ring
  of `FLASH_CAP` (64), so a sustained full-auto exchange never allocates. Intensity is stored
  *unscaled*; `master.brightness` is applied when a slot is written, so the brightness slider moves
  flashes already in flight rather than only new ones.
- Each frame `flashCurve(age, life)` — instant attack, quadratic decay, so it reads as a discharge
  rather than a lamp switching off — sets a weight of `intensity * curve / (1 + camDist * 0.25)`, and
  `pickLightSlotsInto(requests, capacity, out)` hands the slots to the loudest. Ties break on
  insertion order so a light already burning never loses its slot to an equal newcomer, which would
  strobe. The `Into` form fills a caller-owned array: the original `pickLightSlots` (kept, and still
  the reference the fuzz test compares against) allocates three intermediate arrays plus a wrapper
  object per request, every frame of every firefight.
- Both helpers are pure and live in `bot-viewer-visuals-style.js`, so the arbitration is Node-tested.

**`flashColor` is the one bot-lighting colour that does not follow the theme accent.** A muzzle
flash is burning propellant, so it is warm on every map, matching the tracer (`0xffc247`) and the
blast FX (`0xffb066`) which were already warm. The first cut keyed it to the palette like everything
else, which gave `internetcore` a blue flash and `toxic` a green one; the random roller now jitters
only *within* the incandescent band (hue ≈22–47°) rather than off `accentHue`. A test asserts
R ≥ G ≥ B and R > B for all seven themes plus 300 random rolls. `beamColor` (flashlights) is
deliberately still palette-keyed — that's an LED, not combustion.

**Coloured flashes — `flashTint` (default off).** The deliberate escape hatch from the rule above,
because unphysical flashes look good. Three controls in the panel:

- the **`flashTint` toggle** — off restores the warm propellant colour exactly;
- a **colour picker**, `makeColorRow()` wrapping a native `<input type="color">` (that *is* the OS
  colour wheel, for no maintenance) bound to `bots.flashTintColor`;
- **`flash hue cycle`**, `bots.flashTintCycle` in turns/second. `0` holds the picked colour.

When the toggle is on, the tint wins over the caller's `opts.color` too, so `spawnBlastFx()`
explosions tint with everything else — half-tinted combat reads as a bug, not a style. The cycle is
sampled **per shot, at the moment it fires** (`cycleHueHex(tint, elapsed * rate)` inside `flash()`),
not per frame, so a full-auto burst comes out as a gradient across its rounds rather than every
round in the burst sharing one colour.

`hexToHsl` / `cycleHueHex` are pure and live in the style file with the rest of the palette maths.
`cycleHueHex` must **wrap**, not clamp — `elapsed * rate` grows without bound, so a clamping
implementation would park the flash at one end of the wheel after a minute. There's a test for it.
Random rolls key the tint to the roll's accent (the opposite of `flashColor`) and give it a 40 %
chance of a non-zero cycle rate; the toggle is still off, so it only shows if you ask for it.

**Why 2 and not more.** Because the lights are permanently resident (see the box below), each slot is
a *permanent per-fragment tax*, not a pay-per-flash one — the WebGPU forward path evaluates every
visible light for every fragment with no early-out at `intensity 0`. Flashes live ~60 ms, so three
that overlap *and* are all worth lighting is vanishingly rare, and the third-brightest is precisely
the one nobody would notice missing. Two dynamic lights alongside 4 accents + the overhead point is
already a 7-light punctual loop on a neon theme.

> **Never toggle `light.visible` per frame on the WebGPU backend.** The set of *visible* lights feeds
> the lights hash that keys the render pipeline, so a light appearing or disappearing recompiles
> every material in the scene. The first cut of this pool did exactly that — one flip per muzzle
> flash — and a firefight dropped to ~2 fps while the bots themselves stayed smooth, which is the
> tell: the cost tracked *shooting*, not bot count. Both lights (and the flashlight `SpotLight`)
> are now permanently visible whenever their toggle is on, and per-frame code only writes
> `intensity`/`position`/`color`/`distance`, which are uniforms. `applyBots()` is the sole owner of
> `.visible`, and only changes it on a panel toggle, where one recompile is acceptable. The same rule
> applies to anything else added here later.

**The corollary is that a zero-intensity light must not be left visible.** It costs the same per
fragment as a bright one. `placeAccentLights()` has always gated on `A.intensity > 0`; `applyLights()`
now does the same for `rimLight` (`hangar` ships `rim.intensity: 0.0`), and `applyBots()` gates
`focusSpot` on the resolved `u.beamGain.value > 0 && beamIntensity > 0` rather than on the toggle
alone. All three are theme/slider-time writes, never per-frame, so they're on the right side of the
rule above.

### 4. Flashlights — `flashlights` (default off)

Two halves, because a real `SpotLight` per bot is the same non-starter as a real point light per bot:

- **Every** bot gets an instanced additive cone — fake volumetrics, one draw call. The geometry is
  authored apex-at-origin opening down `+Z` (`ConeGeometry(1,1,20,1,true).translate(0,-0.5,0)
  .rotateX(-π/2)`) so the per-instance matrix is just `makeBasis(right, up, forward)` scaled by
  `(radius, radius, length)`, with `radius = length * tan(beamAngle)`.
- **The focused bot** (`botDebugFocusActor || activeBotActor`) additionally drives one real
  `SpotLight`.

The cone shader fades along its length, brightens at grazing angles so it reads as light in air
rather than a solid triangle, and — the one that matters — fades out within 1.6 m of the camera.
Without that near fade, following a bot closely puts the camera *inside* an additive volume and
whites the entire frame out; that is exactly what the first browser pass did.

### Draw-cost notes (audit pass, 2026-07-26)

Four things found by re-reading the above after it shipped, all fixed in the same pass:

- **The FX pools bounded their instance upload.** `makeFxPool.end()` claimed the same contract as
  `body-part-batches.js` but had skipped its `setUpdateRange()` helper, so `needsUpdate` re-uploaded
  all `BOT_FX_CAP` (512) instances every frame whether 5 bots were alive or 200. Both files now carry
  the same helper; if you add a third instanced pool here, copy it.
- **`addBotFx`/`endBotFx` gate on the resolved uniform** (`u.poolGain.value > 0`), not on the raw
  `theme.bots.poolGain`. The uniform already folds in the toggle *and* `master.neon`, so the old
  test built and submitted 200 pool instances and 200 cones that shaded to pure black whenever
  `neon gain` was 0.
- **The sky dome draws last among the opaques** (`skyMesh.renderOrder = 1000`, was `-1000`). It is
  the most expensive shader in the frame — two noise octaves, three star layers, a lit planet — and
  drawing it first meant running it for every screen pixel and then painting the map over most of
  them. The material is `depthWrite: false` with depth testing on, so deferring it lets wall/floor/bot
  depth reject every covered fragment. Three sorts opaque before transparent regardless of
  `renderOrder`, so the additive FX pools still composite on top correctly.
- Per-frame allocation in the light-slot pick, covered under §3 above.

### Panel

A **Bot lighting** section: the six toggles above (`botGlow`, `botRim`, `groundPools`,
`dynamicLights`, `flashTint`, `flashlights`), then `body glow` / `plate glow` / `trim glow` /
`visor glow` / **`visor colour`** (colour picker) / `bot rim gain` / `pool gain` / `pool radius` /
`flash intensity` / `flash falloff` /
**`flash tint`** (colour picker) / **`flash hue cycle`** / `beam gain` / `beam length` /
`beam angle`. The master `neon gain` and `brightness` sliders now scale bot emission and the
flash/spot intensity too, so they stay whole-scene controls.

`makeColorRow(label, get, set, title)` sits alongside `makeSlider` and is the general way to expose
any packed-hex theme field: it converts between `0xRRGGBB` and the `#rrggbb` the input wants, and
registers a syncer so loading a look slot repaints the swatch.

### Status

Browser-verified 2026-07-26 in Chrome/WebGPU, no console errors beyond the pre-existing
`renderAsync()` deprecation warning:

- With the light rig at `brightness = 0`, bots are fully readable and correctly team-tinted (green
  Alpha / red Bravo) — which is also the decisive proof that `vInstanceColor` reaches the emissive.
- Ground pools render soft and team-coloured; `daybreak` correctly shows none.
- Flashlight cones read clearly on `blacksite`, and no longer white out at close range.
- Dynamic lights A/B: with them on, a firing cluster visibly washes the deck around it; with the
  toggle off, that wash is gone.
- A pinned `flashlights` toggle survives switching between `internetcore` / `blacksite` / `hangar`,
  and shift+click hands it back to the theme.

Re-verified after the audit pass: 12 bots armed and manoeuvring on `internetcore`, sky dome and map
correct under the new draw order, ground pools and emissive tints unchanged, console clean.

**Frame rate is still not verified from automation**, for the same reason as the section above — the
QA tab is backgrounded and Chrome freezes `requestAnimationFrame` there (the on-screen counter reads
1–4 fps in that state and means nothing). What *is* known: the per-frame `light.visible` flip
described above tanked combat to ~2 fps in a focused window, and removing it is the fix; whether
combat is now smooth needs a focused-window confirmation, ideally under the Test condition (30×30
maze, 200 dummies). Steady-state cost is two instanced draws plus 2 always-resident point lights
(3 with `flashlights` on). Cheapest levers if it still bites, in order: `dynamicLights` off,
`flashlights` off — the cones are `DoubleSide` additive, so with 200 bots this is a fillrate problem
long before it is a light-count one — then `groundPools` off.

### The key light's shadow frustum (fixed 2026-07-26)

The shadow camera used to be hardcoded in `bot-viewer-v2.html` — `±12 m`, `near 0.1`, `far 40`,
aimed at the world origin — while `applyLights()` parked the light at `direction * 50`. A
DirectionalLight's shadow camera is an ortho box anchored **at the light** and aimed at its
**target**, so `near/far` are distances from the light: the whole scene sat ~50 m out, past a far
plane of 40. **Nothing was ever inside the frustum.** The shadow pass rendered a 2048² depth map of
empty space every frame and every surface came back unshadowed — A/B'd in the browser against the
old numbers, which produce a completely flat scene.

`fitKeyLight()` (in `bot-viewer-visuals.js`) now places the light and fits the box to the live
arena, called from both `applyLights()` (sun angle changed) and `setBounds()` (layout changed). The
maths is the pure `fitShadowBox(bounds, height, margin)` in the style file so it is Node-tested:
everything derives from the arena's bounding **sphere**, not its box, so one fit stays correct at
every azimuth a theme can pick — no re-fit when the sun moves. `SHADOW_HEIGHT` (10 m) is the
vertical span covered; overshooting costs shadow resolution, never correctness. Texel size is
`2 * radius / 2048` — about 2 cm on a 30×30 maze, better on smaller layouts, where the old fixed box
gave a constant 1.2 cm over a region that didn't contain the map.

`shadow.camera.updateProjectionMatrix()` has to be called by hand — `LightShadow.updateMatrices`
copies the light's position and orientation but never touches the projection.

Note this only affects walls, cover, dummies and the floor: `body-part-batches.js` sets
`castShadow = false` on the bot body batches, and v2 builds its weapon batches with
`castShadow: false`, so **bots still cast no shadow** — that is a deliberate perf choice, not a
consequence of the frustum.

### Known, not fixed

- **Bots cast no shadow** (see above) — a body-batch decision, revisit only with a measured budget.

## Audio in the v2 harness (2026-07-25, `bot-viewer-v2.html`)

`bot-viewer-v2.html` now runs `environment-audio.js` — the same controller the environment viewer
uses — so bot firefights are audible and music plays from `sfx/music/`. There is no local player, so
the listener is the camera and every combat sound is positional. Fire points, the arena-scaled
panner profiles, the voice budget, and the panel are documented in
`docs/subsystems/audio.md` ("Wiring in `bot-viewer-v2.html`"); the shared-module addition that made
music work without a folder pick is `loadMusicHttp()` / `musicSource: 'http'`, covered by
`test-audio-http-music.mjs`. `bot-viewer.html` (v1) is deliberately left silent.

`playAtCulled` now falls back to `weapon-sfx-synth.js`' procedural voices for events with no loaded
sample instead of going silent — a loaded sample always wins (`envAudio.hasSfxEvent`), so in practice
this covers `rocket_launch` and `grenade_throw`, while `explosion` still plays its assigned wav. The
fallback is switchable from the Explosives panel section (`botSynthSfxEnabled`). Details in
`docs/subsystems/audio.md` ("Procedural weapon voices").

## Panel theme in the v2 harness (2026-07-26, `bot-viewer-v2.html`)

`bot-viewer-v2.html`'s control panel now wears the environment viewer's inspector look instead of
its own dark floating card: a full-height right dock, white surfaces, orange accent, and
collapsible `.sec` cards.

**`workshop-panel-theme.js`** (new) is the extracted, reusable half:

- `installPanelTheme(rootSelector)` — writes the `--theme-settings-*` custom properties onto `:root`
  and injects the scoped stylesheet. Idempotent per root selector.
- `panelCss(rootSelector)` / `themeCssVars(theme)` / `readSettingsTheme(storage)` / `hexToRgba` —
  pure, so the rules and the palette read are Node-testable (`test-workshop-panel-theme.mjs`).
- `createSection(host, title, { collapsed })` — the environment viewer's `header()` idiom as a
  function: a `.sec` card whose `.sec-head` toggles `collapsed`, returning the `.sec-body` to append
  into.
- `setAllSectionsCollapsed(host, collapsed)` / `readSectionStates(host)` / `applySectionStates(host,
  states)` — bulk section control. States are keyed by **heading text**, not index, so a ui slot
  saved before a section was added or reordered still restores the ones it knows; unknown titles and
  non-boolean values are ignored.

**The palette is shared, not copied.** It reads the same `pcw:uiTheme` localStorage key the
environment viewer's Theme tab writes, and emits the same `--theme-settings-*` variable names, so a
colour picked over there carries into this harness. Malformed or partial saved themes fall back
per-key. Note `environment-ui.js` still carries its own copy of these rules (in `installStyle`,
around line 595) because it also has to un-style the docked panel; folding it onto this module is a
separate job.

### Panel restructure

The panel was one flat scrolling column of ~40 buttons under plain `.ttl` headings. Those headings
became collapsible sections, using the same cursor trick as `environment-viewer.html`'s `header()`:
the panel root is `ctrlRoot`, and `let ctrl` points at whichever `.sec-body` is currently open, so
every pre-existing `ctrl.append*()` call lands in the right section untouched.

Sections, in order: Save / load · Camera · Map layout · Maze structure · Terrain · Visuals · Bot
controls · Auto-add & corpses · Weapons & ammo · Body & ragdoll · Debug overlays · State recorder ·
Movement tuning · Lost-sight pursuit · Bot readout (starts expanded) · Dummies · Nav grid · Audio.
Weapons, body/ragdoll, debug overlays and the state recorder were split out of the single "Bot
controls" blob; stance moved up next to the spawn buttons.

> **Superseded 2026-08-06.** That flat order, and several of those section names, no longer exist —
> see "Panel tab refactor" at the end of this doc for the current structure.

`visuals.buildPanel()` gained a `{ heading }` option so it doesn't emit a "Visuals" `.ttl` inside a
section already titled Visuals. Its remaining `.ttl` headings ("Visual toggles", "Sky detail")
survive as subheads, which the theme styles like the environment viewer's `.wui-subhead`.

**Inline colours had to go.** An inline `style.cssText` beats any stylesheet, so every hard-coded
`#2a313c` / `#c4ccd6` / `#333a45` in the panel's widget construction (selects, the state-recorder
textarea, the track list, the slot widget, the visuals theme/tone selects) was stripped down to its
layout declarations or switched to `var(--wui-*)`. The music shuffle button's hand-painted active
colours became `.primary`. This is the same wart `environment-viewer.html` still has — its adopted
buttons keep their dark inline backgrounds.

### Header controls (2026-07-26)

The `.panel-head` is now `[.head-left: "Bot viewer" + hint][.head-btns: ⌄ ⌃ –]`:

| Button | Effect |
|---|---|
| `⌄` / `⌃` | expand / collapse every `.sec` at once (`setAllSectionsCollapsed`) |
| `–` / `+` | collapse the whole panel to its header bar — `#ctrl.collapsed` drops `bottom:0` and the fixed width, hides `.panel-body`, and hides the two `.sec-toggle` buttons that would be meaningless while shut |

Both the panel-collapsed flag and the per-section collapse map ride in the **ui** slot group
(`captureUiState().panel`), so a saved ui slot restores the panel layout as well as the toggles.
`.head-btns button` overrides the panel's `button{width:100%}` rule back to `width:auto`.

### Camera is no longer reset by a map-parameter edit (2026-07-26)

`applyLayout(layout, { resetCamera = true })`. It used to always snap `camera.position` /
`controls.target` back to `layout.cameraTarget`, so every maze/terrain slider drag — each of which
rebuilds the layout — yanked the viewpoint back to the default overview. `rebuildMazeIfActive()` and
`rebuildActiveLayout()` (the parameter-edit paths) now pass `resetCamera: false`; the initial build,
the Rooms/Maze buttons, the Test condition and `shuffleScene()` still reset, since those are
genuinely different maps. `controls.maxDistance` is still recomputed unconditionally — a smaller map
has to re-clamp the zoom — and `controls.update()` still runs so that clamp takes effect.

## FSM remediation wave 5 (2026-07-26)

Waves 0–4 passed browser QA; wave 5 is the deferred set, shipped as three related changes plus one
new module. Findings are A7, S11, S13, S14 in
`docs/superpowers/reviews/2026-07-25-bot-fsm-behavior-audit.md`. A10 (reaction time / spread)
shipped separately, later the same day — see *Reaction time & weapon spread* below.

### `bot-pursuit.js` (new) — A7 + S14 geometry

Pure, THREE-free, tested in `test-bot-pursuit.mjs`:

| Export | Purpose |
|---|---|
| `investigationRadius(elapsedS, settings)` | search-bubble radius, clamped to `maxRadius` |
| `interceptPoint(target, velocity, self, {speed, closeDistance})` | `{x, z, leadSeconds}` — where to chase |
| `pincerOffsets(rings, step)` | `[0, +s, −s, +2s, −2s, …]` approach bearings |
| `standoffPoint(target, from, range, offsetRad, fallbackYaw)` | a point `range` out on a rotated bearing |

**A7 — the search bubble and the chase.** `expansionMetresPerSecond` was 0.55 against a 3.5–4 m/s
target, so a bot swept an 8 m bubble long after the target had left it; it's now **2.5 m/s with a
12 m cap**. The cap matters as much as the rate — an uncapped fast bubble covers the map, which
makes "search" meaningless and inflates the region BFS that seeds it (`investigationRegionCeiling`
now derives from the same clamped function, so the two can't drift). `updatePursuitMovement` leads
the chase by `interceptPoint`: gap ÷ own speed, capped at 1.2 s, ignored under 0.6 m/s of target
motion. **Aim and fire stay on the present position** — shots are hitscan, so leading them would
just miss. A lead that fails `lineWalkable` from the target is discarded rather than sending the
chaser at the wall the target is about to turn behind.

**S14 — pincer.** `pursuitStandoffGoal()` walks the pincer offsets and takes the first standoff cell
that is walkable and not claimed by another bot (`goalClaims` kind `'pursue'`, released on any
non-PURSUE frame alongside the existing flee/seek releases). All offsets taken → direct line anyway;
a contested goal beats no goal and separation resolves the overlap.

### S13 — the hold channel, generalized

`healHoldUntil` / `healMedicXZ` → **`holdUntil` / `holdReason` / `holdFacingXZ`**, set through
`commandBotHold(actor, until, reason, facingXZ)`. Reasons are `'heal'` and `'overwatch'`; a live heal
hold refuses to be overwritten by an overwatch one, so a squad can't walk off a patient a medic is
mid-channel on. The ladder gate is unchanged in shape (PATROL/SEEK/PURSUE yield; FLEE never does)
and the held bot still aims and fires — which is exactly what makes it usable as overwatch.

### S11 — a real push tier

The push tier was: seed `lastKnownTarget`, show a marker, then N bots independently SEEK the same
anchor. Now `applyPushElement()` splits the squad:

- `squadMembersNear()` (list variant of `livingTeammatesNear`, reusing one array — no per-tick
  allocation) → `pickSquadLeader()` → `squadRanks(members, leaderId)` (sorted for stability, leader
  pulled to rank 0).
- `boundingRole(rank, now − pushStartedAt)` → `'base'` or `'move'`, alternating by rank **and
  flipping every `PUSH_BOUND_MS` (2.5 s)** — real bounding overwatch, not a fixed assignment. Every
  member derives the same split from the same ranking, so this needs no messaging.
- The base element holds via a self-issued 500 ms `'overwatch'` hold, re-armed each frame the tier
  is live. Two safeguards against the freeze failure mode earlier waves fought: the lease expires on
  its own when the tier drops, and **a bot that can neither see the threat nor hold a cover corner
  is never assigned to base** — standing still blind is worse than advancing.
- New actor fields (all actor-direct, no register-bank mirror): `pushStartedAt`, `pushElement`,
  `squadLeaderId`. Cleared with the tier, and by `resetActorMapState` on a kept-roster rebuild.

`pickSquadLeader` was tested-but-unwired since the role system shipped; this is its first caller.

**Readout:** the overhead `!` is **white** for a base-of-fire bot and stays green for a moving one,
so a bounding pair reads at a glance — white shoots, green moves, and they trade every 2.5 s.

**Browser QA passed 2026-07-26.** What was watched: a 3-bot push should never have all three charging at once;
white and green should swap every ~2.5 s; and no bot should stand white while unable to shoot.

## Reaction time & weapon spread — A10 (2026-07-26, `bot-viewer-v2.html` + `bot-aim.js`)

The last open audit finding. Before this, the path from "an enemy entered my cone" to "a round is in
its head" contained nothing: `selectBotTarget` acquired on the scan frame, `aimAnglesTo` gave the
exact bearing, `readyToFire` checked only visibility/reload/mag/cooldown, and `fireBotShot` handed
`resolveHitscan` the exact muzzle ray. A bot facing a doorway killed whatever walked through it on
the first frame, at any range, forever. Two halves now sit in that gap, each with its own toggle.

### `bot-aim.js` (new) — pure, THREE-free, tested in `test-bot-aim.mjs`

| Export | Purpose |
|---|---|
| `AIM_DEFAULTS` | every tunable below, and the source of `botAimSettings` |
| `reactionDelayMs(distance, {alerted, primed, jitter01}, s)` | recognition delay for a fresh contact, in ms |
| `settleFactor01(heldMs, s)` | 1 at acquisition → 0 after `settleMs`; scales the first-shot penalty |
| `spreadHalfAngleRad({moveSpeed01, heldMs, bloomDeg}, s)` | half-angle of the cone the next round is drawn from |
| `bloomAfterShot(deg, s)` / `decayBloomDeg(deg, dtS, s)` | recoil climb per shot and its recovery |
| `dispersedDirection(dir, half, r1, r2, out)` | deflects a ray uniformly over the disc; `r1`/`r2` are caller-supplied rolls so tests can pin the result |

The two `*Enabled` flags are honoured **inside** the module (`reactionDelayMs` → 0,
`spreadHalfAngleRad` → 0), so "off" is one code path, not a branch at every call site.

### Reaction

Per-bot, actor-direct fields: `aimContactAt`, `aimReadyAt`, `aimLostAt`, `aimTargetId`. On the frame
a target first becomes *raw* visible (not the debounced ladder value — you cannot acquire what you
cannot see), `updateAimAcquisition()` stamps the contact and pays the delay once:
`reactionMs + reactionPerMetreMs × range`, `× alertReactionScale` if the bot was on an alert tier
last frame (one frame late, the same convention as A6), `± reactionJitter01` per contact, capped at
`reactionMaxMs`. `botAimReady(now)` then gates `readyToFire`.

Three properties worth keeping:

- **The FSM still sees `visible`.** A bot inside its delay sits in `BOT_AIM` — it turns, holds, takes
  cover, calls the contact out. It just doesn't shoot yet. Nothing about awareness was slowed down.
- **Occlusion under `reacquireGraceMs` (600 ms) doesn't re-arm it.** Otherwise a bot fighting across
  a pillar pays the delay on every flicker and never fires.
- **A target switch resets it**, beside the existing miss-streak/debounce reset — the delay describes
  one opponent. Since 2026-07-31 the reset also *primes* the bot (see below), so the replacement
  contact pays the attention-shift discount, not full recognition.

### Faster fire decision — A10b (2026-07-31)

Bots visibly aimed at enemies for seconds without firing. Two causes: the harness overrode the
module defaults with `reactionMs 700 / perMetre 40 / cap 2000` (~1.5 s at 20 m), and every teardown
of a paid acquisition — a target switch, or any sight break past the grace — re-charged the *full*
delay. With two enemies trading the "nearest" slot on the 4-frame scan, a bot could re-pay forever.
Four changes, all in the same A10 seam:

- **Module defaults restored** — `botAimSettings` is now plain `{ ...AIM_DEFAULTS }`
  (260 ms + 12 ms/m, cap 900). Note the **bots** save slots persist `aim`, so an old slot loads the
  old slow values back; re-save after loading.
- **Primed window** — `primeAimAcquisition` stamps `aimPrimedUntil = now + 4 s` whenever a live
  contact is torn down (retarget in `updateBotSentry`, grace expiry in `updateAimAcquisition`).
  Fresh contacts while primed pass `primed: true` to `reactionDelayMs`, which applies
  `primedReactionScale` (default 0.4). The hard actor reset clears it.
- **Taking fire counts as alerted** — the `alerted` input is now
  `alertTierLast || lastSelfThreatAt within 4 s`, so a bot being shot at reacts at the alert scale
  even before any squad report scores a tier.
- **Reaction floor** — `reactionMinMs` (default 100) keeps the stacked scales
  (alert × primed × jitter) from producing inhuman sub-50 ms reactions.

Alongside, `selectBotTarget` gained **stickiness**: a newcomer must be ≥30 % (linear) closer to
steal the slot from a still-visible incumbent (`TARGET_STICK_CLOSER_SQ`), because every steal
resets the paid acquisition. An incumbent that lost its own LOS is still replaced immediately.
Panel: two new *Aim & reaction* sliders (`Reaction floor (ms)`, `Primed reaction ×`); the readout's
aim row appends `(primed)` while the discount window is live.

**Commit dwell (2026-08-03).** The 30 %-closer margin alone still flickered when two enemies were
near that ratio and strafing: crossing the line and back every rescan flipped the pick each time,
visible in a multi-target fight as the bot's aim swinging between targets instead of committing to
one ("shooter anxiety"). `TARGET_COMMIT_MIN_MS = 1500` adds a flat time floor on top of the margin:
`activeBotActor.targetCommittedAt` stamps whenever `botTarget` actually changes, and while
`now - targetCommittedAt < 1500`, a steal is refused outright even if the newcomer clears the margin
— as long as the incumbent is still a candidate and still has LOS. The dwell only gates that one
branch: a dead incumbent, a `stale` (unseen > `TARGET_RETAIN_MAX_MS`) incumbent, or an incumbent that
just lost LOS still hands off immediately, since holding the lock there isn't commitment, it's
staring at nothing or a corpse. Reset alongside `targetUnseenSince` in `resetActorMapState` so a
map change doesn't leave a stale dwell timestamp.

**Risk-based pick + pile-on discount (2026-08-05).** `selectBotTarget` no longer sorts candidates by
raw distance for the pick; it scores each in-cone/in-range candidate by
`risk = proximity x danger` and reorders `_selCandidates`/`_selCandidateDistSq`/`_selRisk` in place
(highest risk first) before the raycast-and-pick loop, so the loop's existing "stop at first clear
LOS" behavior now finds the most dangerous visible enemy instead of the nearest one. The
nearest-first `perceivedEnemies` HUD snapshot is taken *before* this reorder, so the POV HUD is
unaffected. `proximity = sightDist / (sightDist + distance)`. `danger` starts at 1 and gets a bonus
if the candidate's id matches the attacker on the freshest applicable alert report:
`latestSelfThreat(recentAllyHits, bot, now).attackerId` (this enemy is shooting ME, bonus
`TARGET_DANGER_SELF_BONUS = 2.5`) or `latestAllyHitNear(bot, now).attackerId` (shooting a teammate
near me, bonus `TARGET_DANGER_ALLY_BONUS = 1.2`, self takes priority over ally when both match). Each
bonus ramps down linearly over the report's own `alertWindowMs` (`dangerDecay(age, window) = max(0,
1 - age/window)`) instead of cliffing to zero at expiry — a shooter who fires once and breaks LOS
fades out instead of staying maximally dangerous for the full window, and a target whose report
expires mid-dwell demotes smoothly instead of silently.

The stickiness margin moved with it: it used to require the newcomer to be 30% *closer* than the
incumbent (`TARGET_STICK_CLOSER_SQ`, a plain distance ratio) to steal the slot. Now that the sort key
is risk, not distance, that comparison was checking the wrong thing — a farther-but-far-more-dangerous
shooter could fail a distance margin and get wrongly blocked. `TARGET_STICK_RISK_MARGIN = 1.3`
replaces it: the newcomer needs >=30% more risk than the incumbent, still gated by the same commit
dwell and still overridden immediately if the incumbent loses LOS.

**Pile-on discount.** `latestSelfThreat` is self-filtered (each bot only sees reports where it was
the victim), so it can't cause a dogpile — two bots each being shot by a different enemy correctly
target their own attacker. `latestAllyHitNear` reads a *shared* report ring: if enemy X shoots bot A,
every nearby teammate of A sees X as elevated danger at the same time and can converge on X while
other visible enemies go unanswered. Before applying the ally-threat bonus, `selectBotTarget` counts
how many `squadMembersNear(bot, SUPPORT_RADIUS)` (reusing the same spatial-hash helper the push-element
code already calls) currently have `actor.target.id === allyThreat.attackerId`, and discounts the
bonus by `TARGET_PILE_ON_STEP = 0.25` per already-committed squadmate, floored at
`TARGET_PILE_ON_FLOOR = 0.4` so someone always still answers the shooter. This only runs when there's
an ally-hit report to check (`allyThreat.attackerId != null`), so the extra spatial-hash query is
skipped entirely outside a live gunfight. Self-threat targeting is never discounted.

These constants (`TARGET_DANGER_SELF_BONUS`, `TARGET_DANGER_ALLY_BONUS`, `TARGET_PILE_ON_STEP`,
`TARGET_PILE_ON_FLOOR`, `TARGET_STICK_RISK_MARGIN`) are a first-pass tuning, same status
`TARGET_COMMIT_MIN_MS` had before it got retuned from 800 to 1500 off one playtest — expect to revisit
after watching a real multi-target fight. Not yet done: currently-hidden/remembered enemies still
score nothing (only this-scan's visible candidates are risk-scored), which needs the persistent
per-enemy contact memory described in [[multi-threat-contact-model-plan]] in memory.

**Known drift:** `environment-viewer-v2.html` carries an earlier copy of this same target-selection
code (search `TARGET_STICK_CLOSER_SQ` there) that predates both the commit dwell and this risk pass —
it still has the old distance-only pick with no danger/pile-on awareness. Not synced as part of this
change; flagging so a future env-viewer bot-port pass knows this file has fallen further behind
`bot-viewer-v2.html`, consistent with [[env-viewer-bot-port-plan]] in memory (port not yet started).

**Persistent contact memory (2026-08-07, `bot-contacts.js`, NEW module).** First step of the
"engaging based on threat, not just this instant's visible set" half of the plan in
[[multi-threat-contact-model-plan]]: a per-bot, per-enemy memory of the last confirmed sighting,
separate from the shared squad-report ring (`recordContact`/`latestContactNear` in `bot-alert.js`
already covers "tell my teammates what I see" — this is one bot's own recollection, not shared).
Pure, THREE-free, Node-tested in `test-bot-contacts.mjs`, same decay-on-read/bounded-Map style as
`bot-danger.js`: a record is `{x, z, lastSeenAt, visible}`, `recordContactSighting` upserts and
re-inserts (Map order = sight recency) so overflow past `CONTACT_MEMORY_MAX_ENTRIES = 12` evicts the
least-recently-seen, and `contactRecency(rec, now, windowMs)` gives a linear 1→0 confidence instead
of a cliff, matching the `dangerDecay` shape added in the risk-pick pass above.

Wired into `selectBotTarget`: `activeBotActor.contacts` (created per actor in `createBotActor`,
cleared in `resetActorMapState` on map rebuild since remembered x/z are meaningless on a new map) is
updated every `scanDue` frame — every candidate that passed the FOV+range+field-prefilter gate this
scan gets `recordContactSighting`, and `markContactsUnseen` flips everything else to `visible: false`
without touching its remembered position. Deliberately reuses the field-prefilter pass rather than a
fresh raycast per candidate: `USE_FIELD_LOS_PREFILTER`'s own comment says the field "errs toward
visible", so this is an approximate "roughly saw them" signal, not raycast-confirmed truth — adding a
raycast per candidate here would reintroduce the "raycast everyone" cost the risk-pick pass
deliberately avoided (score cheap, raycast only the winner). The raycast in the pick loop remains the
sole authority on whether `botTarget` can actually be fired at; this memory never overrides that.

**This pass is infrastructure only — it is not yet consumed by anything.** No behavior or HUD change:
`selectBotTarget`'s pick still only considers this-scan's visible candidates, same as before this
commit. What it enables, still open: (1) folding remembered-but-currently-hidden contacts into risk
scoring so a bot weighs "I know a shooter was over there recently" against a new bystander it can
see — `contactRecency` plus a hidden-visibility penalty is the intended mechanism, mirroring the
danger-decay shape already in place; (2) feeding cover/flee so a bot routes away from every
remembered danger position, not just its current target's; (3) a HUD readout (e.g. dim/grey marks
for `visible: false` contacts) so the memory's behavior is observable, the way `perceivedEnemies`
already is via the diamond marks. The threat-to-support ratio (engage-or-break) from the same plan is
unrelated to this memory and still entirely unstarted.

### Spread

`fireBotShot` deflects the ray before anything consumes it, so combat, tracer, and bullet mesh all
follow the same imperfect line. Cone half-angle =
`baseSpreadDeg + moveSpreadDeg × speed01 + firstShotSpreadDeg × settleFactor01(heldMs) + bloom`,
with bloom climbing `bloomPerShotDeg` per round to `bloomMaxDeg` and recovering at
`bloomDecayDegPerSecond` (aged in `updateAimAcquisition`, so it recovers whether or not a target is
up). Deflection is uniform over the disc (`sqrt(r1)`), not centre-weighted.

A `lastShotAlignment` diagnostic used to measure the pre-spread ray to catch a rendered barrel that
doesn't point where the shot goes; it was never read and was deleted 2026-07-27 (per-shot Vector3
churn). `bot-viewer.html` still carries its own copy.

### Knock-on effects (expected, not bugs)

Bots now miss, which feeds two systems that were previously near-dead: `botMissStreak` drives the
pursue-break threshold, so bots break off and close distance more often; and `recordNearMisses` fires
regularly, so rounds whistling past propagate `'near'` alerts through a squad.

### Panel & readout

*Aim & reaction* section: `Reaction delay` / `Weapon spread` toggles (both **on**), then sliders for
every field of `AIM_DEFAULTS`. Saved in the **bots** slot group under `aim`. The *Bot readout* gains
an **aim** row — `ready | +180ms | no contact | instant` followed by the live cone in degrees.

**Browser QA passed 2026-07-26** at the defaults above. What was watched: a bot walking into a doorway should die *after* a beat, not
on contact; the aim row should show a countdown then `ready`; sustained fire should visibly widen
the cone (tracers fanning) and tighten again after a pause; and both toggles off should reproduce
the old laser behaviour exactly.

### Keep bots on rebuild (2026-07-26)

`applyLayout` used to always `removeBot()` / `removeDummy()`, so a map edit also emptied the roster —
and with nothing left to follow, follow/POV fell back to orbit. That teardown is now behind the
**`keep bots on rebuild`** toggle in *Map layout* (`botKeepOnRebuild`, **default on**), which supplies
the default for `applyLayout`'s `keepBots` option. Saved in the **ui** slot group as
`rebuild.keepBots`.

With it on, `relocateActorsForLayout()` runs instead of the teardown, after the new nav grid and
terrain exist:

- **Bodies** — `placeEntityOnWalkableGround()` leaves a bot exactly where it stands if its cell is
  still walkable, else pushes it to the nearest walkable cell (`nearestWalkableNavCell`, radius ≤ 4)
  and falls back to `findBotSpawnPoint()` if the whole neighbourhood is now wall. Y is re-seated on
  the rebuilt terrain, velocity zeroed, `onFloor` cleared. Capsule height is preserved so stance
  survives. Dummies get the same treatment plus a `roamPath` clear.
- **Memory** — `resetActorMapState()` drops everything expressed in old cells: path/pathMode, target
  and last-known-target, combat-move and patrol-resume goals, investigation, flee history, the whole
  cover block (corner, threat, gate, hold, cell-keyed blacklist, peek), muzzle-recovery target and
  visited cells, attention/patrol scan, pack-seek goal, medic action and cached flood. `patrolIndex`
  is re-modded onto the new ring. Plus the global `goalClaims`, world health packs and dummy hit
  impacts.
- **Corpses are cleared, not moved** — a settled ragdoll can't be re-seated like a standing capsule,
  and a corpse inside new geometry is an unreachable revive target. `clearDeadBotActors()` reuses
  `cullDeadBots`'s teardown.
- **Rebinding** — the bound actor's state lives in globals while bound, so the reset ends with
  `bindBotActor(activeBotActor)`; otherwise the next `commitBotActor` would write the old path back.

Two callers always pass `keepBots: false` regardless of the toggle: `shuffleScene()` (it captures the
roster and respawns it itself — survivors would double it) and the Test condition button (it wants a
reproducible empty start).

**Browser QA is still pending** for all of this and the save/load slots below.

## Save / load slots in the v2 harness (2026-07-25, `bot-viewer-v2.html`)

The control panel opens with a **Save / load** block: three independent sets of 6 named
localStorage slots, one per state group. `bot-viewer-slots.js` owns storage and the widget;
`bot-viewer-v2.html` owns the six `capture*State()` / `apply*State()` functions, because only the
viewer knows which rebuild syncers a given value needs.

Storage key is `pcw:bv2:slots:<group>` → `{ "<1-6>": { name, savedAt, data } }`. Groups never share
a key, so loading a maze slot cannot disturb bot tuning. Corrupt/unparseable payloads and a full or
denied `localStorage` degrade to "no slots" instead of throwing into the panel build.

### Which group owns which state

The split is by **what a load costs you**, not by which panel heading the control sits under:

- **maze** — map geometry. Loading calls `applyLayout`, which tears down and rebakes the collider,
  nav grid, visibility field and corner map, and **removes every bot and dummy**.
- **bots** — AI tuning. Loading retunes the live roster in place; nothing is despawned.
- **ui** — camera, debug overlays, look and audio. Loading never touches the simulation.

| State | Group | Notes |
|---|---|---|
| `activeLayoutKind` (rooms/maze) | maze | |
| `mazeCols` / `mazeRows` / `mazeSeed` | maze | |
| `mazeCellSize` (hall width) | maze | slider is hall width; the var is cell pitch |
| `WALL_T` / `WALL_H` | maze | saved as `wallThickness` / `wallHeight` |
| `mazeLoopChance` / `mazeStraightness` / `mazeBraid` | maze | |
| `mazeStartGoal`, `mazeEntrances` | maze | |
| `mazeWallMode` (maze/perimeter/open) | maze | validated against the enum on load |
| `structuresOn`, `structureSettings` | maze | count/spacing/mix re-clamped on load |
| `terrainPadsEnabled` | maze | saved as `terrainPads` |
| `flyCam.speed` / `flyCam.walk` | ui | saved under `camera.flySpeed` / `camera.flyWalk` |
| `mazeRoomsOn` / `mazeRoomCount` / `mazeRoomSize` | maze | |
| `mazeCoverOn` / `mazeCoverDensity` / `mazeCoverHeight` | maze | |
| `terrainSettings` (all 12 keys) | maze | whole object; ground is map geometry |
| `botMovementSettings` (9 keys) | bots | re-applied via `applyBotMovementSettings()` |
| `botBehaviorSettings` (14 keys) | bots | incl. `sightDistance`, `fovDegrees` |
| `botHealthSettings` (8 keys) | bots | |
| `botAimSettings` (A10, 15 keys) | bots | saved as `aim`; includes both enable toggles |
| `botPackSettings`, `botMedicSettings`, `botInvestigationSettings` | bots | saved though they have no sliders yet |
| `botGrenadeSettings` (all `GRENADE_DEFAULTS` keys) | bots | saved as `grenade`; 11 of the 13 keys have sliders |
| `botGrenadeBlast` (5 keys) | bots | saved as `grenadeBlast`; the live ordnance tuning (fuse, jitter, radius, damage, FX size) |
| `botGrenadesEnabled`, `botExplosionFxEnabled`, `botSynthSfxEnabled` | bots | saved as `grenadesEnabled` / `explosionFx` / `synthSfx`; carried stock is **not** saved (Restock re-applies `perBotCount`) |
| `botStance` (crouch/prone/run) | bots | |
| `botWeaponId`, `botKnifeSecondaryEnabled` | bots | weapon goes through `setBotWeapon()` |
| `botAutoRefillOnReload`, `botNoAmmoEnabled` | bots | ammo goes through `setBotNoAmmoEnabled()` |
| `botProceduralBodyEnabled`, `ragdollDeathEnabled`, `ragdollDeathImpulse` | bots | |
| `botTeam`, `teamBotCountInput.value`, `botMedicPercent` | bots | spawn count has no backing var |
| `botAutoAdd*` (enabled/teams/count/interval/teamCap/totalCap) | bots | `botAutoAddNextAt` resets to 0 |
| `botCorpseCullEnabled`, `botCorpseCap` | bots | |
| `dummyImmortal`, `dummyRoamEnabled`, `randomDummyCount.value` | bots | dummies are sim entities |
| `panelCollapsed`, per-section collapse map | ui | keyed by section heading text |
| `botKeepOnRebuild` | ui | preference only; the rebuild it affects is a later action |
| `cameraMode` | ui | falls back to orbit if nothing is alive to follow |
| `cameraAutoFollowEnabled` / `cameraAutoRotateEnabled` / `cameraFollowOcclusionEnabled` | ui | |
| `cameraFollowUserDistance` | ui | |
| `autoSceneShuffleEnabled` / `autoSceneShuffleIntervalMs` / `shuffleLookEnabled` | ui | shuffle rerolls the maze — a ui slot can overwrite a maze slot's map |
| `botStateOrbsEnabled`, `botTacticalVisualsEnabled`, `botFovWedgeEnabled` | ui | per-actor mesh visibility re-applied on load |
| `botMovementDebugEnabled` + `botMovementDebugParts` | ui | |
| `botRecoveryDebugEnabled`, `botBehaviorDebugEnabled` | ui | |
| `navPoints.visible` (nav overlay) | ui | |
| theme key, seed, live theme object, pinned toggles, master sliders | ui | `visuals.getLookState()` |
| master/music/sfx volume, mute, bot SFX | ui | |
| music source, output, speaker behavior, shuffle, 6 effect params | ui | |

**Deliberately not saved:** the bot/dummy roster itself (a slot is settings, not a scene), transient
timers (`botAutoAddNextAt`, `autoSceneShuffleNextAt`), `botDebugFocusActor`, `botStateRecording` and
its log, the picked SFX/music folder handles (browser-owned permissions), and everything derived by
`applyLayout` (collider, nav grid, spawn points, bounds). `botPovEnabled` isn't captured directly
because `setCameraMode` derives it — it rides along with `camera.mode`.

### Restore hardening

Slot payloads are untrusted (hand-edited, or written by an older build), and several of the setters
they drive are expensive or destructive, so the apply paths guard rather than assign blindly:

- `numOr` requires an actual `number` — `Number(null)`/`Number('')` are `0`, which would otherwise
  zero `mazeCellSize`, `WALL_H`/`WALL_T` or the death impulse from a corrupt slot. `clampOr` pins
  everything else to its slider range; `mazeCols`/`mazeRows` get a hard `MAZE_MAX_CELLS = 200`
  ceiling, since their inputs have no `max` and a four-figure value hangs the tab in the nav,
  visibility and corner bakes.
- Every `assignKnown` call passes `Object.keys(liveObject)`, so a stale key from an older slot is
  dropped instead of injected into a settings object the sim reads.
- `setBotWeapon` and `setBotNoAmmoEnabled` are guarded on an actual change. Both walk the whole
  roster: the first destroys and re-mounts every weapon GLB, and the second — on the common
  `noAmmo: false` — rewrites every bot's ammo map, silently refilling the roster mid-firefight.
- `cameraFollowUserDistance` is restored **after** `setCameraMode`, and mirrored into
  `cameraFollowDynamicDistance`/`cameraFollowCollisionDistance`. `setCameraMode` →
  `resetFollowFraming` re-derives the distance from the live camera offset, so restoring it first
  was a dead write.
- The audio block is wrapped in try/catch: `setMusicSource('folder')` with no surviving folder
  permission would otherwise abort the apply and skip the trailing widget resync, leaving the panel
  disagreeing with the sim. Note `environment-audio.js` persists the mixer to its own localStorage,
  so a **ui** slot overwrites those global prefs, not just this harness's view.

### Supporting changes

- `bot-viewer-visuals.js` gained `getLookState()` / `applyLookState(state)`. The theme is stored
  **verbatim, not by key**: the sky/post sliders mutate `theme` in place, so a key alone would lose
  every hand-tweak. `randomSeed` and the five `master` sliders were closure-private and unreadable
  from outside before this.
- `createBotMovementSlider` / `createBotBehaviorSlider` now register into a `botTuneSyncers` array,
  as do the death-impulse and heal-threshold sliders. They were write-only before — a loaded slot
  would have retuned the sim while every slider stayed where it was.
- `applyMazeState` does `rebuildTerrainField()` → `syncMazeControls()` → `rebuildActiveLayout()` →
  `terrainSyncers`, i.e. exactly one layout rebuild for a combined map+terrain change (the
  standalone `applyTerrainChange()` path would have cost two). Syncers run **after** the rebuild
  because the terrain toggle's tooltip reads `terrainTriangleCount`, which only `buildFloorMesh`
  writes.

`test-bot-viewer-slots.mjs` covers storage round-trip, corrupt/hostile payloads, name clamping, and
the `pickKeys` / `assignKnown` merge helpers (`assignKnown` drops type-mismatched values so a slot
written before a tunable changed shape can't poison the sim). The panel widget itself needs a DOM
and is **pending browser QA**.

### Export layout JSON (2026-07-29)

The same **Save / load** block ends with a single **Export layout JSON** button. Where the maze slots
save generator *parameters*, this saves the world those parameters produced: `captureInterchangeLayout()`
runs the live `activeWalls` / `activeCovers` / `activeBounds` / `WALL_H` / `botSpawnPoint` /
`dummySpawnPoint` / `patrolPoints` through `createLayout()` in **`layout-interchange.js`** and downloads
the result as `layout-<kind>-<stamp>.json` (via the existing `downloadTraceFile`, which now takes a MIME
type). That file is a `pcw-layout` v1 document — the app-neutral schema `shoot-house.js` reads back via
`createShootHouse({ interchange })`, so a harness-authored world becomes a shoot-house map with the same
geometry. Schema and API: [`shoot-house.md`](shoot-house.md); Node coverage in
`test-layout-interchange.mjs` (round-trip losslessness plus identical nav/sight bakes either way).
Export only for now — there is no import side in the harness yet.

## Bot field of view (2026-07-23, bot-viewer)

Bot perception was omnidirectional: `selectBotTarget` picked the nearest enemy with a clear LOS
ray regardless of which way the bot faced. `botBehaviorSettings.fovDegrees` (live "Field of view
(deg)" slider, 1–360, **default 120** — a forward cone with a real rear/side blind spot; set 360 for
the prior omnidirectional behaviour) now bounds a **horizontal
vision cone** centered on `bot.yaw` (0 = +Z), via `withinBotFov(yaw, fromPos, toPos)`. The cone
gates two places, parallel to the existing LOS occlusion gate: (1) **acquisition** — an out-of-cone
enemy can't be freshly picked as `best` in `selectBotTarget`; (2) **sustained visibility** — the
sentry's `visible` flag is `!blocked && withinBotFov(...)`, so a target that strafes out of the cone
stops being aim/fired-at and the bot falls back to SEEK toward its last-known position (turning to
re-acquire) or PATROL. A genuine rear blind spot follows: a bot never before aware of an enemy
behind it stays blind to it (no last-known → no turn) — the hook a future getting-shot-at alert
would use to make it wheel around. Vertical (pitch) FOV is not modelled; bots/targets are ~level.

> **Known bug (2026-08-06):** "bots/targets are ~level" is not a safe assumption once cover and
> terrain are in play, and it is the cause of *bots with their head exposed over cover are never
> targeted*. Three systems each reduce a bot to one point at chest height: `fieldSaysHidden`
> (`:6030`) prunes the candidate before any ray because `nav-visibility.js:52` discards each
> blocker's real height and treats anything ≥ `SIGHT_BLOCK_HEIGHT` (1.5 m) as blocking at every
> height; the sentry LOS ray samples a single eye-to-eye line at `EYE_LIFT 0.85` = 1.32 m; and the
> hit capsule tops out at 1.80 m while the rendered head runs 1.786 → 2.020 m (2.053 m with the
> Mark VII crest), so the head is drawn but not hittable. Plan:
> `docs/superpowers/plans/2026-08-06-height-aware-los-plan.md`. Audit:
> `docs/superpowers/reviews/2026-08-06-bot-visibility-hitbox/`.

A **"Hit volume" panel toggle** (`botHitVolumeDebugEnabled`, off by default) exists to verify that
geometry against a live bot rather than against constants. It draws, per living bot, the hit capsule
in green wireframe, the **rendered** head's world-space bounds in magenta, and an amber ring on the
capsule's exact top plane. The capsule comes from `projCapsuleInto` — the scratch twin of the
`combatCapsuleFor` descriptor `resolveHitscan` is actually handed — and the head is read off
`body.joints.head`'s own geometry bounds, so neither can drift from the real hit test or the real
mesh. Groups are allocated lazily per actor (the M6 pattern) and torn down with the rest of the
actor's debug meshes. Capsule geometry is built per `(radius, shaft)` and cached with the shaft
quantized to 2 cm, because scaling a unit capsule non-uniformly would deform the hemisphere caps —
the amber ring is positioned from unquantized numbers so the measurement stays exact regardless.
Enabling the toggle also logs measured metres-above-feet to the console; `window.reportBotHitVolume()`
re-runs that report on demand for the focused bot.

A **"FOV wedge" panel toggle** (`botFovWedgeEnabled`, off by default) draws each bot's cone as a
flat ground-plane sector: `buildFovWedgeGeometry(fovDeg)` builds a unit-radius triangle fan centered
on local +Z, and `updateBotTacticalVisuals` rotates it to `bot.yaw` and scales it to `sightDistance`
each frame, rebuilding the geometry only when the FOV slider moves (360° degenerates to a full disc).
It renders beneath the sight ring and follows the same focus gate as the other tactical visuals.

## Weapon-linked engagement distance (2026-07-23, bot-viewer)

The FSM's engagement band is derived from the equipped weapon each tick rather than fixed, so a
longer-range gun holds a farther standoff. `botWeaponStandoff(weapon)` maps `weapon.range`
(~65–230 m for bot weapons) by `botBehaviorSettings.standoffFactor` (default 0.09), clamped to
`[4, sightDistance − 4]` so standoff stays perceivable; `standoffFactor: 0` collapses every weapon
to the min (no linking). The result (`botCombatStandoff`, recomputed per tick) is threaded into
`chooseBotState` as **both** `pursueDistance` (the pursue-stop / fire-band threshold) **and** the
`updatePursuitMovement` goal via `standoffGoalFromTarget`, while the kite/back-off trigger passed as
`fleeDistance` is `max(botBehaviorSettings.fleeDistance, standoff × 0.5)`. Net: the fire band is
`[standoff/2, standoff]` — below it the bot kites back (flee-while-firing), above it it only closes
when it keeps missing (see pursue-on-miss). Approx standoffs at defaults: `five_seven` ~5.9 m,
`m1911` ~9 m, `cz_805_bren` ~10.8 m, `m24` ~20.7 m. `bot-activity.js` is unchanged — this is pure
viewer-side ctx wiring, so the env-viewer bot code is unaffected until its rewrite.

**Pursue-freeze fix (2026-08-02, env-viewer only).** `updatePursuitMovement`'s goal used to be the
bare `botCombatStandoff`, but `BOT_PURSUE`'s own exit rung only releases once `targetDistance <=
pursueDistance - pursueExitBuffer` — so a bot that perfectly reached its goal sat exactly at the one
distance guaranteed to still fail that check, and froze there (zero velocity, target visible,
`keepsMissing` latched forever since PURSUE never fires). Confirmed against a live trace: 5 of 6
sampled bots ended PURSUE with `target_dist` matching their own standoff to within 0.1 m. Fix: the
goal now targets `botCombatStandoff - pursueExitBuffer` in both `environment-viewer-v2.html`'s and
`bot-viewer-v2.html`'s `updatePursuitMovement`, so arrival satisfies the exit check instead of
missing it by the buffer. See `bot-state-codes.md` for the two new trace columns
(`self_threat`, `sidearm_mag`/`sidearm_reserve`) added alongside this to chase the separate,
still-unconfirmed dry-bot `aim` freeze.

Live panel sliders (all read every tick): **Standoff / weapon range** (`standoffFactor`), **Kite
trigger (× standoff)** (`fleeStandoffFraction`, near edge of the fire band), **Pursue after N
misses** (`pursueMissStreak`), **Pursue health floor** (`pursueHealthThreshold01`). The shared
`createBotBehaviorSlider` helper now derives its value-readout decimals from the step (so 0.005-step
factors show three decimals) instead of the old fixed 1-decimal format.

## Visibility field, corner cover & bot separation (2026-07-23, bot-viewer)

Defensive positioning, built on precomputed spatial data (plan:
`docs/superpowers/plans/2026-07-23-bot-cover-corners-plan.md`). All sight-blocking geometry in
bot-viewer maps is static after `applyLayout`, so visibility is baked once per layout instead of
raycast per query.

### Baked substrate (pure modules, Node-tested)

- **`nav-visibility.js`** (`test-nav-visibility.mjs`) — pairwise cell↔cell LOS bitfield over
  walkable nav cells at eye height. `buildSightGrid(navGrid, blockers)` rasterizes sight-blocking
  rects (`activeWalls` = full height; `activeCovers` only when `h >= SIGHT_BLOCK_HEIGHT` (1.5 m) —
  short maze covers block walking, not sight); a rect marks a cell only if it covers the cell
  center. `buildVisibilityField(navGrid, sightGrid)` bakes an Amanatides-Woo DDA trace per pair
  (upper triangle, symmetric OR — conservatism always errs toward *visible*) into a row-major
  bitset over dense walkable indices. `field.canSee(rawCellA, rawCellB)` (false for unwalkable
  inputs), `field.rowFor(cellIdx)`, `cellIndexAt(navGrid, x, z)`. Maze-sized bake (56×56, ~2.7k
  walkables) ≈ 0.5 s, logged once per bake (the viewer's `[rebuild <label>]` line).
  `buildLazyVisibilityField(navGrid, sightGrid, {rowCacheCap})` is the drop-in lazy variant —
  identical `canSee`/`rowFor` answers (Node-verified over all pairs, in both argument orders and
  across repeat passes) but each query is a direct symmetric pair trace (~0.3 µs) behind a
  direct-mapped pair memo, and rows are computed on demand into a FIFO cache, so construction is
  O(walkable) instead of O(walkable²). The memo needs no invalidation: a built field is immutable.
  The eager bake is quadratic (~100 s and a 133 MB bitset on the 30×30 Test-condition maze, ~32k
  walkable cells), which made large mazes unopenable — **both viewers now use the lazy field**;
  `buildVisibilityField` is retained for small maps and as the test oracle.
- **`nav-corners.js`** (`test-nav-corners.mjs`) — corner map off the same sight-blocker rects.
  Each tall-rect corner yields up to 2 records (one per adjoining face):
  `{corner, wallDirA/B, anchorCell/Pos, peekCell/Pos, peekDir}` — anchor = standing spot
  `ANCHOR_INSET` (0.6) along the face + `ANCHOR_OFFACE` (0.4) off it, peek = `PEEK_PAST` (0.5)
  past the corner edge, both snapped to walkable cells (shared `nearestWalkable` from
  `nav-grid.js`). Culls: buried corners, failed snaps, and records failing the
  anchor↔peek `canSee` cross-check.
- Both are baked and cached in `applyLayout` beside the nav grid (`visField`/`cornerMap`),
  rebuilt on layout change.

### Cover FSM (`BOT_COVER_MOVE` / `BOT_COVER_HOLD`)

`findCoverCorner(bot, threatPos)` (bot-viewer, pure scoring in `bot-cover.js`): corners within
`COVER_SEARCH_RADIUS` (10 m), validity = `!canSee(threatCell, anchorCell) &&
canSee(threatCell, peekCell)` — two bit tests, zero raycasts — skipping other-bot claims
(goal-claim store, kind `'cover'`) and the per-life `coverBlacklist`. Score: closer better,
penalty for closing distance to the threat, bonus for wall face perpendicular to threat bearing.

Ladder placement (`bot-activity.js`, FSM core stays pure/timer-free): cover-persistence rung
mirrors flee-committed (LOS loss can't break cover — that's the point; only `coverValid` going
false or heal/knife can); entry rung under kite-flee/pursue, above the stationary AIM/FIRE;
ally-hit entry on the lost-sight path (`allyHitNearby`: same-team damage within
`ALLY_ALERT_RADIUS` 12 m in the last `ALLY_ALERT_WINDOW_MS` 3 s, attacker last-known pos as
threat — gated on a corner actually existing). Viewer ctx: per-frame validity bit test with
immediate re-pick on invalidation ("re-pick is cheap" — the bake makes it two bit tests);
`COVER_COMMIT_TIMEOUT_S` (6) applies only in COVER_MOVE and blacklists unreachable anchors.

`BOT_COVER_HOLD` runs the peek cycle (`bot-cover.js`, `test-bot-cover.mjs`): concealed at anchor
(jittered `PEEK_IN` 0.8–1.6 s, re-rolled per cycle so squads don't metronome) ↔ 0.15 s slide ↔
exposed at peek (`PEEK_OUT` 1.2 s), aiming during slide-out, firing only under the same
aim-error/`readyToFire` gate as AIM→FIRE. Blocked shots ≥ threshold while peeked blacklist the
corner and re-pick (no muzzle-recovery wander from cover). Holding bots skip separation steering
(hard pushout still applies; the seat re-asserts next frame).

### Bot separation & goal claims (`bot-separation.js`, re-exported via `bot-entity.js`)

Bots previously phased through each other (no bot-bot physics at all). Now (`test-bot-separation.mjs`):
- `resolveBotPairs(bots, radius)` — O(n²) XZ pushout after the per-bot update loop, half the
  penetration each; moved bots get a follow-up `mapCollider` wall resolve (doorway squeezes can't
  push through walls).
- `separationXZ` — 1/dist-weighted repulsion blended into `followPath` direction
  (`SEPARATION_RADIUS` 1.5, `SEPARATION_WEIGHT` 0.5) for all path-following states.
- `createGoalClaims(isAlive)` — cellIdx → `{id, kind}` claim store; flee goals, muzzle-recovery
  cells, sought packs, and cover anchors claim their cells so two bots never commit to the same
  spot; kind-scoped release on arrival/replan/state-exit/death; cleared on layout change. Patrol
  ring points are exempt (shared pass-through waypoints).

### Bot spatial hash (`bot-spatial-hash.js`) — Phase 2 of the 2026-07-25 perf audit

Pure, THREE-free uniform XZ grid over `entity.capsule.start`; the answer to finding F2 (no spatial
partitioning of bots existed anywhere, so seven systems ran linear scans of `botActors` per bot per
frame). Node-tested in `test-bot-spatial-hash.mjs`. **Wired into `bot-viewer-v2.html` (see below); the
legacy `bot-viewer.html` still runs the linear scans.**

- `createBotSpatialHash(cellSize = 2)` → `{ rebuild, forEachNear, forEachSegment, size, cellSize }`.
- `rebuild(entities)` re-indexes from scratch (call once per frame, after physics). Linked-list
  layout — a reused `Map<packedCellKey, slot>` of cell heads plus a growable `Int32Array next` —
  so steady-state rebuilds allocate nothing. Cell keys are `Math.floor(coord / cellSize)` pairs
  packed as `(cx + 32768) * 65536 + (cz + 32768)`, clamped to that range (world coords are
  otherwise unbounded; non-finite coords collapse to cell 0). Each indexed entity is stamped with
  its slot as `_hashIdx`.
- `forEachNear(x, z, radius, fn)` visits every entity in the cells covering the circle's **AABB**,
  so callers still do the exact distance test. Cost scales with the cell rect, so keep radii near
  the interaction range — a huge radius walks a huge cell rect.
- `forEachSegment(x0, z0, x1, z1, pad, fn)` — same, over the segment AABB expanded by `pad` (for
  `recordNearMisses`). AABB coverage only, no supercover walk.
- Both return `true` when a visitor returned `true` (early-out, used by the contested query).
- Queries only touch cells, never positions, so a stale hash returns stale entities instead of
  throwing — a caller that skips `rebuild` gets wrong answers, not a crash.

Hash-consuming variants live alongside (not replacing) the originals in `bot-separation.js`:
`separationXZHashed(self, hash, radius)` and `waypointContestedHashed(self, hash, waypoint,
wpDist, contactDist)` are semantically identical (same self/`alive === false` skips; identical
contributor set, float sum order may differ). `resolveBotPairsHashed(bots, hash, radius)` runs the
same pushout math through a hashed broad phase: the pass stamps each listed bot with `_pairStamp`
+ `_pairIdx`, so entities present in the hash but absent from `bots` are ignored and each pair is
handled exactly once — by its lower-`_pairIdx` member. Pair *order* differs from the nested loop,
so crowded piles settle to marginally different positions (tested invariant: comparable residual
overlap, ≥90% shared moved-set, same convergence).

#### Viewer wiring (`bot-viewer-v2.html`, 2026-07-25)

`botHash = createBotSpatialHash(2)` is module state, rebuilt by `rebuildBotHash()` over the living,
non-ragdolled roster into the reused `_hashLiving` array — **twice** per `updateAllBots`: once right
after `rebuildFrameEnemyLists()`, and again immediately before the pushout pass (the FSM ticks move
everyone in between). Consumers:

- `followPath` — `waypointContestedHashed` / `separationXZHashed`; the per-while-iteration
  `botActors.map(...)` is gone.
- `updateAllBots` pushout — `resolveBotPairsHashed(living, botHash)`.
- `sharedAllyAlertNear` / `livingTeammatesNear` — `forEachNear` with `SEMI_ALERT_SHARE_RADIUS` /
  the radius argument. Reports live on the actor, reached via the `entity.botActor` backref.
- `recordNearMisses` — `forEachSegment` over the shot segment padded by `NEAR_MISS_RADIUS + 0.5`;
  XZ-projected distance never exceeds the 3D distance, so the AABB is a conservative prefilter and
  the exact 3D `shotMissDistance` test still runs per candidate.
- `decideMedicDuty` (living allies, `MEDIC_DEFAULTS.responseRadius`) and
  `updateMedicCohesionMovement` (`cohesionNeighborRadius`, the radius `cohesionTarget` itself
  respects). **Corpses are not in the hash**, so the revive candidates come from the module-level
  `deadBotActors` Set, added in `killCombatBot` and removed in `reviveCombatBot`/`removeAllBots`.

All visitors are hoisted to module scope with module scratch (matching `bot-separation.js`'s style),
so the queries allocate nothing and none of the state is `withBotActor`-bound. Hash iteration order
differs from `botActors` order, so ties (equal-`at` alert reports, equal-distance medic candidates)
may resolve to a different bot than before.

Alongside it: `botActorById = new Map()` (maintained at the `botActors.push` / `botActors.splice(0)`
sites) replaces the linear id scans in `combatEntityById`, the three medic `.find`s, and the
`goalClaims` `isAlive` callback (M7); and every `smoothPath(` call site passes
`SMOOTH_LOOKAHEAD = 16` to bound its O(k²) DDA retraces (M3).

### Phase 4 rendering (`bot-viewer-v2.html`, 2026-07-25) — F8, F9, M5, M6

- **Corpse retirement (F8).** The dead-actor branch of `updateAllBots` now gates
  `stepRagdoll` + `setRagdollPose` on `!botRagdollAsleep(actor, now)`. After each step,
  `kineticEnergy(rd) < RAGDOLL_SLEEP_ENERGY` (1e-4, the "came to rest" bar from
  `test-ragdoll.mjs`) stamps `actor.ragdollSettledSince`; anything above clears it. Once the
  stamp is `RAGDOLL_SLEEP_MS` (500 ms) old the corpse stops simulating entirely — the body
  pool's immediate-mode `flush()` reads the rig's `matrixWorld` and keeps drawing the frozen
  pose. Wake sites clear the stamp: `killCombatBot` (the only place impulses are applied —
  `applyDeathImpulse` / `applyBlastImpulse`; `detonateBlast` skips already-dead actors, so a
  corpse is never re-impulsed) and `reviveCombatBot`, which now drops `ragdoll` /
  `ragdollPose` / `ragdollSettledSince` unconditionally rather than only in the
  body-survived branch (a revive with procedural bodies disabled used to leave `ragdoll` set,
  which also excluded the bot from `rebuildBotHash`). Empirically a blast-launched ragdoll
  settles ~0.8 s after death and sleeps at ~1.3 s.
- **Unplaced-mount guard (both viewers).** `createBotWeaponMount` is async and builds
  `weaponRig` at identity; only `updateBotWeaponMount` ever positions it. Because the mount is
  assigned in a promise continuation, it could land after `updateAllBots` but before the weapon
  flush, so `flushWeaponMount` instanced the rig while it was still at the world origin at raw
  GLB scale — a full-size gun flashing mid-map for a frame or two on spawn (very visible at high
  auto-add rates). The mount now carries `placed: false`, set true at the end of
  `updateBotWeaponMount`'s transform writes, and `flushWeaponMount` skips until then. Side
  effect: a bot that dies before its mount finishes loading never renders that gun, instead of
  rendering it wrong.
- **Corpse cull (F8, second half).** Sleeping stops the ragdoll solver but a corpse still keeps
  its meshes, its `botActors` slot, and a body flush every frame, so long auto-add sessions grow
  without bound. `cullDeadBots(now)` runs first in `updateAllBots` (before the frame enemy lists
  and hash, so a culled corpse never enters them): when `deadBotActors.size` exceeds
  `botCorpseCap`, corpses are removed oldest-death-first, skipping any still inside
  `MEDIC_DEFAULTS.reviveWindowMs` (12 s) so a cull can never steal a revive in progress — which
  also means the cap can be legitimately exceeded while many corpses are fresh. Each cull drops
  the actor from `botActors` / `botActorById` / `deadBotActors`, releases its `goalClaims`,
  re-points debug focus and the active binding if either referenced it, then calls
  `disposeBotActor(actor)` — the per-actor teardown extracted out of `removeAllBots` (which now
  just loops it). UI: `Cull bodies: On/Off` toggle plus a `max corpses` number input (disabled
  and dimmed while off) beside the auto-add controls. Defaults on, cap 24.
- **Facing cones → one `InstancedMesh` (F9).** The per-bot `ConeGeometry` +
  `MeshStandardMaterial` mesh is gone (creation, `scene.add`, the `actor.facing` field, the
  `facingMesh` binding, and the kill/revive visibility writes). Module-level `botFacingMesh`
  (shared cone geo, one white standard material, capacity 1024, `frustumCulled = false`,
  `castShadow = false`) is filled immediate-mode: `botFacingCount = 0` at the top of
  `updateAllBots`, `addBotFacingInstance(mid, yaw, radius, stateColor)` from `updateBot` for
  living bots only, `flushBotFacing()` after the actor loop. Instance transform reproduces the
  old mesh exactly: position `mid + (sin yaw, 0, cos yaw) × (radius + 0.2)`, rotation
  `Euler(π/2, 0, −yaw)` in three.js's default `'XYZ'` order (the old `rotation.x = π/2` set at
  spawn plus the per-frame `rotation.z = −yaw`), composed with module scratch. Per-instance
  color replaces the per-frame `material.color.setHex(botStateColor(...))`. The upload is
  bounded by a local `setInstancedUpdateRange` copy of `body-part-batches.js`'s helper.
- **Weapon shadows (M5).** `createWeaponPartBatches({ THREE, scene, castShadow: false })` —
  v2 only; `bot-viewer.html` keeps the default `true`.
- **Spawn-time sharing (M6).** Module-level `botSightRingGeometry` / `botKnifeRingGeometry` /
  `botHealthBarBgGeometry` / `botHealthBarFillGeometry`, plus a lazily-built
  `botCapsuleGeometry` (every `createBotEntity` call in the viewer uses the same radius/stand
  height; built from the first entity instead of hard-coding the defaults). **Materials stay
  per-bot** — the capsule tints on non-ragdoll death and the health fill tints with HP — so
  only geometries are shared, and `removeAllBots` no longer disposes them (the per-bot FOV
  wedge geometry is still disposed; it is rebuilt when the FOV slider moves).
  `createBotGoalDebug` / `createBotInvestigationDebug` (the latter allocating a 320×80 canvas
  + `CanvasTexture`) are no longer called at spawn: `ensureBotGoalDebug(actor)` /
  `ensureBotInvestigationDebug(actor)` build and `scene.add` them on first display inside
  `updateAllBotGoalDebug` / `updateInvestigationDebug`, which only ever activate for the
  Alt-click `botDebugFocusActor` (or the bound actor). Every other access is optional-chained,
  and `removeAllBots` disposes them only when present.

### Phase 5 bind/commit + scene-graph matrix work (2026-07-25) — M9, M10

- **Single bind/commit per bot (M9, `bot-viewer-v2.html`).** `updateAllBots`'s per-actor
  `withBotActor(actor, …)` wrapper — which cost commit(previous) + bind(actor) + commit(actor) +
  bind(previous), ~150 property copies per bot per frame — is now one `commitBotActor(focus)`
  before the loop, then a bare `bindBotActor(actor)` → `updateBotSentry` + `updateBot` →
  `commitBotActor(actor)` per living bot (half the copies). The loop-exit
  `bindBotActor(focus ?? botActors[0])` restores the outer binding as before. Foreign-actor
  touches inside the pipeline (`killCombatBot` on a shot victim, `reviveCombatBot` on a medic's
  patient) still wrap themselves in `withBotActor`, which commits the loop actor on entry and
  re-binds it (from its just-committed fields) on exit — a lossless round trip, so nesting is
  unaffected. Out-of-pipeline call sites (weapon assignment, no-ammo toggle, spawn/remove,
  visual-mode sync) keep `withBotActor` unchanged. Behavior deviation accepted: the old
  per-iteration `try/finally` restore on an exception inside `updateBot` is gone — an exception
  there escapes `updateAllBots` and breaks the frame loop in both versions anyway.
- **Weapon rig never scene-added (M10).** The mount hierarchy
  (`weaponRig → weaponAdjust → weaponFrame → weaponView → markers`) is transform-only — nothing
  renders from it (guns draw from the weapon-part-batches pool) — so `createBotWeaponMount` no
  longer `scene.add`s it and `destroyBotWeaponMount` no longer removes it. That deletes the
  renderer's per-frame walk of every rig; `flushWeaponMount`'s `updateMatrixWorld(true)` is now
  the single authoritative walk, and it runs before the batch `add()`s consume
  `weaponView.matrixWorld` (same-frame order unchanged). All other consumers
  (`botMountedBarrelRay`, `botBulletOrigin`, `alignMountedWeaponToPoint`, the pose controller)
  already self-refresh via
  `updateWorldMatrix(true, false)` / `getWorldPosition`, which don't need scene membership.
  `weaponRig.visible` remains the holster flag (gates the flush only).
- **Static locals frozen (M10).** `matrixAutoUpdate = false` + one `updateMatrix()` after final
  local placement for nodes whose local transform never changes after construction:
  `weaponFrame` + muzzle/barrel markers (rig), the alert-mark bar/dot/digit, role-insignia
  crosses, the health-bar background plane, and health-pack box/plus children. Their per-frame
  written parents (rig root/adjust/view, mark groups, pack groups) keep auto-update.
- **Settled-corpse flush skips the matrix walk (M10, `player-procedural-body.js`).** `flush(pool)`
  gained an optional `refreshMatrices = true` second parameter (additive — default is
  byte-identical for `bot-viewer.html`/`multiplayer.js`): when false it reuses the previous
  walk's `matrixWorld`s. v2's animate loop passes
  `!(dead && botRagdollAsleep(actor, now))`, so a corpse asleep under F8 stops paying the
  ~28-node `updateMatrixWorld(true)` recompose while still re-adding its frozen pose to the
  immediate-mode pool. Safe because sleep implies no `update()`/`setRagdollPose` writes since the
  last refreshed flush, and revive/impulse sites clear `ragdollSettledSince`.
- **Skipped for safety:** freezing nodes inside the living body rig — every placeholder part is
  re-posed each frame by `update()`/`setRagdollPose` (eyes included, via `applyEyeConfig`), so
  there are no never-written nodes to freeze without touching shared per-frame write paths.

### Retrofits onto the field (2026-07-23)

- `findFleeGoal`: cover bonus (`coverScore`) now computed for **every** flood candidate via bit
  test, on **all** flees (was: top-24 raycasts, heal-retreat only; `FLEE_COVER_RAYCAST_CAP`
  deleted). Threat quantizing to unwalkable/off-grid disables the bonus (never "all covered").
- `findMuzzleRecoveryCell`: field filter + at most `MUZZLE_RECOVERY_CONFIRM_CAP` (3) confirming
  raycasts on the best candidates (falls back to pure raycast path if the target cell is
  unwalkable).
- `USE_FIELD_LOS_PREFILTER` (default **false**, pending browser QA): skip target/pack BVH
  raycasts when the field says mutually hidden (`fieldSaysHidden` only trusts "hidden" when both
  endpoints are walkable in-bounds).
- Investigation frontier: `INVESTIGATE_LOS_BONUS` (0.25) alignment bonus for cells that can see
  the last-known anchor.

Deferred (plan's Future Work): stance→hit-capsule mechanics (crouch/prone are still cosmetic),
body-roll lean channel, env-viewer port, dynamic blockers.

### Hallway corner-jam fix (2026-07-23, same day)

Browser QA of the cover/separation pass surfaced bots jamming permanently at hallway corners
(path polyline visibly cutting through the wall). Three interacting defects, all fixed
(`test-bot-hallway.mjs` reproduces pre-fix and guards post-fix):
- `lineWalkable` (nav-grid.js) point-sampled string-pull shortcuts every 0.25 m and passed
  segments grazing through a blocked corner cell (pre-existing; 36/2026 illegal segments in an
  L-hall sweep). Now a supercover DDA — every touched cell must be walkable, corner crossings
  need both flanking cells open (findPath's no-corner-cut rule; errs blocked, deliberately
  opposite the vis-field's errs-visible).
- Separation steering was walkability-blind: crowd repulsion at a corner pointed the blended
  move direction into the wall, wall-resolve cancelled it — the grind. `blendSeparationDir`
  (bot-separation.js) drops the separation component when a `SEPARATION_PROBE_M` (0.45)
  look-ahead lands on a nav-blocked cell.
- Contested-waypoint starvation: a bot pushed off a waypoint by a nearer neighbor never hit
  `WAYPOINT_REACH` 0.35; `waypointContested` relaxes reach to 0.80 in that case.
Pushout chains alone were ruled out (convoys/opposing flows clear); permanent jams needed a
holding bot (cover-hold/aim/medic-tend) to nucleate the scrum. Note bot-viewer has no
stuck-force-replan machinery (that's environment-viewer only). environment-viewer inherits the
`lineWalkable` fix via its `smoothPath` import.

### Cover QA fixes (2026-07-23, browser round 2)

- **Off-path shove freeze:** pushout could displace a bot laterally so its position→waypoint
  segment clipped a corner (path itself legal); with no tangential slide component it froze
  pressed into the wall. `followPath` now checks `lineWalkable(p, path[0])` — on failure skips
  to `path[1]` if legal, else re-paths in place (`NAV_REPATH_COOLDOWN_MS` 350).
- **Cover re-pick thrash:** validity flicking across a visibility boundary caused per-frame
  corner switches (measured 599 switches/10 s, net 0.13 m — "frozen" bots with indigo orbs).
  Hysteresis in `bot-cover.js`: invalidity must persist `COVER_INVALID_GRACE_S` 0.35 before
  breaking hold; commits/entries rate-limited by `COVER_SWITCH_COOLDOWN_S` 0.8.
- **Cover camping:** the committed-cover rung outranked pursue, and clean misses reset the
  blocked-streak — a bot could hold far beyond weapon range missing forever. Entry now requires
  threat within `standoff × COVER_RANGE_FACTOR` (1.5, + pursue-exit buffer while held; snipers
  legitimately keep long cover); `COVER_PEEK_MISS_LIMIT` 6 consecutive no-hit peek shots
  blacklists the corner for the engagement (any target hit resets; world-geometry blocked-streak
  still trips at 2 first).

### Frozen-camper fix (2026-07-23, browser round 3)

"Stuck in cover / stuck aiming" bots (user-observed; giving ammo un-stuck them) were missing
exit pressure: every engagement exit (peek miss-streak, blocked-streak, pursue miss-streak)
advances only on shots fired, so a bot that can't fire (dry mag — `botAutoRefillOnReload`
defaults off — or a threat gone stale) camped forever. Desync and seat-assertion theories were
refuted (commits are never refusable post-selection; HOLD/AIM clear paths per frame). Fixes:
- `coverHoldExitReason` (bot-cover.js): `COVER_FIRE_DROUGHT_S` 6 (held without firing →
  release + blacklist) and `COVER_THREAT_STALE_S` 5.5 (live threat unseen → release, no
  blacklist, falls to SEEK to investigate last-known; ally-alert freshness counts as seen).
- Ladder ctx `fireCapable`/`knifeCapable` (bot-activity.js, default true/false legacy-safe):
  a bot that can't fire flees instead of camping AIM/FIRE and never takes fresh cover; SEEK
  requires being able to fight on arrival. `knifeRequested`'s 8 m distance gate removed — a dry
  knife bot charges from any range.
- Cover lifecycle runs before `botState` stamps with a self-healing invariant: a cover state
  that can't secure a committed corner demotes to AIM/SEEK/PATROL the same frame.

### Squad alert / lemming fix (2026-07-23, browser round 4)

Bots ignored teammates being shot or killed right in front of them and patrolled single-file
into the same kill funnel. Two wiring gaps: cover entry required the reported shooter inside
the bot's own weapon band (`coverInBand`) — a distant hallway shooter never qualified — and
when no corner was in range the ally alert did nothing at all. Fixes (`bot-alert.js`, pure,
tested in `test-bot-alert.mjs`):
- **Death-weighted alert windows** — `recordAllyHit` stamps `lethal` (caller decrements health
  first); `latestAlertNear` keeps deaths actionable `ALLY_DEATH_WINDOW_MS` 8 s vs 3 s grazes,
  and each new victim refreshes the report.
- **Band-free cover entry on ally reports** — `threatIsAllyReport` skips the `coverInBand`
  gate for both entry and the committed-hold band check (the shooter is out of the bot's own
  engagement, but nearby squadmates must still break for corners, not walk past them).
- **Alert hold** — a bot still in PATROL despite a live alert (no corner, or dry gun), whose
  position the baked field says the reported threat can NOT see (`exposedToThreat`), stops and
  trains its gun on the threat direction instead of walking into the exposed zone. Stamped as
  ad-hoc state `'alert'` (movement-level, like muzzle-recovery's `'reposition'`; yellow orb).
  `stepAlertHold` caps an episode at `ALERT_HOLD_MAX_MS` 20 s with a 4 s cooldown so a
  sustained firefight can't freeze a bot; cover/combat rungs always outrank the hold.
  (Gate removed 2026-07-24, reinstated with fail-open guards 2026-07-25 — see those sections.)

### Corner-jam fixes round 2 (2026-07-23, harness-verified)

Residual "occasional corner stick" was reproduced headlessly (multi-bot patrol flows through
narrow L-halls; wide corridors were already clean) and each fix was validated against the same
harness before shipping — a first attempt (hard no-reverse separation + head-on yield-stop)
made the stress scenarios far worse (5 → 1350 stuck events) and was discarded. Shipped set
(24 short bounded events, 0 permanent stalls, +15% patrol throughput vs baseline):
- **Contested-relax pop legality** (`followPath`): the crowd-relaxed reach (0.80) could pop a
  load-bearing bend waypoint whose successor segment runs through the wall, collapsing the path
  into a repath-thrash loop. The relax now applies only when `lineWalkable(p, path[1])` holds;
  a camped bend waypoint means queueing behind the camper instead (bounded in-game by cover exits).
- **Damped reversal** (`followPath`): the separation 1/d² contact spike may still reverse the
  heading — that reversal is what dissolves jams — but a heading opposing the waypoint direction
  moves at 0.4× speed, killing the full-speed sprint-away oscillation.
- **Margin-band recovery** (`requestPath`/`followPath`): a bot shoved into the physically-walkable
  but nav-blocked wall margin now gets its re-path's snapped start waypoint kept (no `slice(1)`),
  and `followPath` skips legality checks/re-paths while the bot's own cell is blocked
  (`lineWalkable` from a blocked start is false by construction — checking it only thrashed).
- **Patrol anti-stall give-up** (`updatePatrolMovement`): a leg with < `PATROL_STALL_DIST_M`
  0.35 net progress for `PATROL_STALL_GIVEUP_MS` 2500 is abandoned for the next patrol goal —
  e.g. a one-lane hall bend camped by a cover-holding teammate.

### Alert visibility marker (2026-07-24)

Every bot carries an overhead billboarded yellow "!" (`buildAlertMark`/`updateAlertMark`,
shared geo/mat like the medic cross) visible exactly while its squad alert is actionable
(`latestAllyHitNear` non-null: same-team hit/death within `ALLY_ALERT_RADIUS`, inside the
graze/death windows). It is the ground-truth QA signal for alert triggering; stacks above the
role insignia. (At the time only actual hits/kills on allies registered; near-miss shots were
closed as a trigger source on 2026-07-25, see below.)

### Alert hold made unconditional (2026-07-24)

Browser QA with the "!" marker showed the hold's concealment precondition split behavior:
bots on concealed corner cells paused, bots standing in the shooter's LOS pushed ahead. The
`exposedToThreat` gate is removed — ANY patrolling bot with an actionable alert and no visible
target now stops and trains its gun on the reported threat until the alert window expires
(graze 3 s / death 8 s, refreshed by new hits). `ALERT_HOLD_MAX_MS` raised 10 s → 20 s: it is
now purely a freeze backstop under a sustained nearby firefight, after which a 4 s cooldown
lets the bot reposition. `exposedToThreat` stays exported/tested in bot-alert.js for the
planned retreat-to-concealment behavior.

**Reversed 2026-07-25** (FSM remediation wave 1): the systemic audit judged the unconditional
hold worse than the split it fixed — an exposed holder is a free kill for up to 20 s. The gate
is back, and the 07-24 split-behavior complaint is addressed by *context*, not by the gate:
being shot now seeds `lastKnownTarget` (SEEK preempts PATROL, so the hold rarely evaluates)
and the push tier is cover-eligible, so an exposed alerted bot usually investigates or breaks
for a corner instead of walking blind. The residual hold case (wary-tier ally report, no
corner) is the browser-QA watch item.

### Semi-alert propagation (2026-07-24)

A bot with no firsthand alert that passes within `SEMI_ALERT_SHARE_RADIUS` 6 m of a teammate
carrying an active firsthand "!" inherits that teammate's report — one hop only (only
firsthand reports, stored per-frame in `actor.alertReport`, propagate). The secondhand
response scales with a deterministic local **escalation score** (`alertEscalation`,
bot-alert.js): same-team in-window casualty reports within `ESCALATION_RADIUS` 18 m, scored
hits + 2×deaths:
- score 1 (*wary*): pause `SEMI_ALERT_WARY_MS` 1.5 s facing the reported threat, then resume.
- score ≥ `ALERT_DEFENSIVE_SCORE` 2 (*semi*): full firsthand behavior — alert hold, cover
  eligibility, band-free entry.
- score ≥ `ALERT_PUSH_SCORE` 4 AND ≥ `SUPPORT_GROUP_MIN` 3 living teammates within
  `SUPPORT_RADIUS` 10 m (*push*): adopt the reported threat as last-known and advance via the
  normal SEEK machinery (health/ammo gates apply); without the numbers, falls back to *semi*.
Markers: firsthand "!" stays yellow; all secondhand modes render orange
(`actor.alertMarkMode` stamped by the sentry, consumed by `updateAlertMark`). (Tier gating by
source and this palette were both superseded 2026-07-25 — see "Score-unified alert response".)

### Alert score digit (2026-07-25)

The "!" now carries the bot's escalation score as a digit beside it (clamped 1–9), so tiers
are readable at a glance: 1 = wary flinch, 2–3 = defensive, 4+ = push-eligible. The sentry
computes `alertEscalation` for every bot each tick and stamps `actor.alertScore` whenever any
alert mode is active (firsthand included — its score is ≥1 by construction since the
triggering casualty is inside `ESCALATION_RADIUS`). Rendering: `alertDigitMat(score, mode)`
lazily builds shared canvas-texture materials keyed `<mode><digit>` (white glyph tinted
yellow/orange via material color); each mark group holds one digit plane
(`group.userData.digit`) swapped by material, while `group.userData.exclaim` keeps the
bar/dot pair the mode-material loop repaints. Shared geo/mats — teardown still skips dispose.

### Blast damage now reports to the squad-alert system (2026-07-25)

`detonateBlast` (bot-viewer.html) decremented `e.health` inline and never called
`recordAllyHit`, so grenade/RPG casualties — deaths included — pushed nothing into
`recentAllyHits` and generated zero "!" alert for nearby teammates. Bullet (`applyBotDamage`)
and knife (`applyCombatDamage`) hits always reported; explosives were the only silent kill.

The fix keeps the blast on its own damage path rather than routing through `applyBotDamage`:
that path builds a directional `{dir, hitPoint, knockback}` death from the shooter's eye ray,
which would overwrite the blast's `{blastFrom, knockback}` and lose the radial `applyBlastImpulse`
ragdoll launch. Instead the victim loop is split in two — pass 1 applies impact FX, decrements
health, and calls `recordBotDamage` + `recordAllyHit`; pass 2 runs `killCombatBot` with the
unchanged `blastFrom` payload. The split matters because `recordAllyHit` early-returns on a dead
attacker: a thrower caught in its own blast would otherwise silence every victim processed after
it. Health is decremented before reporting, per the ordering contract that lets `recordAllyHit`
stamp `lethal`.

Attacker resolution: `detonateBlast(center, weapon, now, attacker = bot)` now takes the thrower
explicitly, passed as `bot` from its sole call site in `fireBotShot` (where the global `bot` is
the firing actor, bound by `bindBotActor`). A self-blast pushes a report with
`victimId === attacker.id`; `latestAlertNear` filters self, so the thrower doesn't alert itself
while its teammates still do. The `dummyTargets` blast loop already routed through
`applyCombatDamage` and needs nothing — WASD dummies have no `botActor`, so they were never
ally-hit sources.

### Near-miss alerts (2026-07-25)

Closes the last known alert trigger gap: every alert used to originate from a bot actually
*taking* damage (`recordAllyHit` is only called from damage paths), so a bot shot at and missed
by inches didn't flinch. `fireBotShot` now calls `recordNearMisses(fireOrigin, dir, hit.distance,
hitId, bot, now)` right after the hitscan resolves, pushing a report for every living **enemy**
bot whose capsule midpoint lies within `NEAR_MISS_RADIUS` **1.5 m** of the shot segment
(shooter muzzle → hit point, or → max range when nothing was struck). Geometry is the pure,
tested `shotMissDistance(origin, dir, len, p)` in `bot-alert.js` — clamped point-to-segment,
same approach as env-viewer's older `alertBotsToShot` (which stays independent; env-viewer's
radius is 2.5 m).

Decisions:
- **Enemy shots only.** A friendly round whistling past a squadmate is routine in these hallway
  maps (bots shoot past each other at a shared target) and its "threat" position would be a
  teammate — alerting on it would self-sustain squad-wide alerts pointed at their own line.
- **Own reports only, never the target it hit** (`hit.kind === 'player'` ⇒ that id is skipped;
  it already gets a real hit report). A shot that *missed* the engaged target does near-miss it.
- **Distinct report kind.** `kind: 'nearmiss'` (`NEAR_MISS_KIND`) on the same `recentAllyHits`
  ring, with its own `NEAR_MISS_WINDOW_MS` **1500** — half the 3 s graze window and exactly one
  `SEMI_ALERT_WARY_MS` pause long, matching the weakest existing response tier.
  `alertWindowMs` returns it. Per victim at most one near-miss report is live: a new one inside
  the window refreshes the existing record instead of pushing (a full-auto burst can't flood the
  64-entry ring and evict casualty reports).
- **Escalation weight 0.** `alertEscalation` skips near-miss reports entirely, so `hits`,
  `deaths`, and `score = hits + 2*deaths` still count only casualties and `ALERT_DEFENSIVE_SCORE`
  2 / `ALERT_PUSH_SCORE` 4 keep exactly the meaning the sections above give them. A barrage of
  near misses never promotes a bot to the defensive or push tier (regression-tested).
- **Inverted self-filter, firsthand only.** `latestAlertNear` skips near misses outright (they
  are never squad alerts); the new `latestNearMiss(hits, me, now)` requires
  `rep.victimId === me.id` — the mirror of the casualty rule — with no radius and no team lookup,
  because a bullet cracking past is only perceivable by the bot it passed. Near misses are
  **not** propagated: `actor.alertReport` (what `sharedAllyAlertNear` relays one hop) is still
  stamped from casualty reports only, so one burst can't alert a whole squad with nobody hit.

Response tier: **hold + orient only.** The sentry evaluates a near miss last, only when no
firsthand or secondhand casualty alert is live (`const nearMiss = alertMode ? null :
latestNearMiss(...)`), and feeds it into `wantAlertHold`/`faceTargetXZ` through the new
`alertThreat = allyAlert || nearMiss`. It deliberately does **not** flow into `coverThreat`,
`threatIsAllyReport`, or the FSM's `allyHitNearby` — a cover break is an expensive commitment
that stays reserved for confirmed casualties. Net effect: a patrolling bot that gets shot at
stops, trains its gun on the shooter's position for up to 1.5 s, and resumes — while an engaged
bot (visible target) is unaffected, since the hold requires `state === BOT_PATROL && !visible`.

Marker: a third mode `'near'` renders the "!" **cyan** `0x4fc3f7` (`ALERT_MARK_MAT_NEAR`) vs
yellow firsthand / orange secondhand, digit tinted to match via the shared
`ALERT_MARK_COLORS` map that `alertDigitMat` now reads (keys `full`/`semi`/`near`). Shared
geo/mats, no per-bot allocation, teardown still skips dispose. The escalation digit reads 1 in
near mode by clamping (score is 0 by construction unless real casualties are also nearby).
(Palette/keys reworked and the near-mode digit hidden on 2026-07-25 — see the next section.)

### Score-unified alert response (2026-07-25)

The score digit exposed an inconsistency: the response was gated by *how* a bot learned of the
threat, not by severity — a firsthand witness always did the full hold/cover even at score 1,
yet could never push, while a secondhand bot at the same score could. Reconfigured so
**acquisition stays split but the response is source-blind**:
- Acquisition (information flow, unchanged): firsthand = casualty seen within
  `ALLY_ALERT_RADIUS` 12 m; secondhand = report inherited one hop from an alerted teammate
  within `SEMI_ALERT_SHARE_RADIUS` 6 m. Near miss stays its own firsthand-only, weakest cue.
- Response (new, identical for both sources), tiered purely by `alertEscalation` score:
  1 = *wary* flinch (`alertWarySince`, renamed from `semiAlertSince`, times the 1.5 s pause —
  now applies to firsthand grazes too, a deliberate downgrade from the old full hold);
  ≥2 = *defensive* (alert hold + band-free cover — feeds `coverThreat` / `threatIsAllyReport` /
  FSM `allyHitNearby` via `coverAlert`); ≥4 with the support group = *push* for everyone,
  firsthand witnesses included (adopt threat as last-known → SEEK; no `holdAlert` so the
  advance is never anchored, but since 2026-07-25 push DOES set `coverAlert` — losing squads
  were dropping cover exactly when losing; the cover rung outranks the seek, so a pushed bot
  with a reachable corner takes it and the seek is the no-corner fallback).
Sentry now derives `coverAlert`/`holdAlert` via the pure, tested `alertTierChannels(tier, report)`;
`alertThreat = holdAlert || nearMiss` still drives the hold. Marker palette (user-specified):
**red** = saw it (`seen`), **yellow** = heard it (`heard`), **green** = part of a push
(`push`, overrides source), **cyan** = near miss (digit hidden — no casualty score).
`ALERT_MARK_MATS`/`ALERT_MARK_COLORS` share those keys; digit tint follows the mode.

### Split attention: threat bearing vs. travel heading (2026-07-25)

Perception is gated by the body's yaw cone (`withinBotFov`, `fovDegrees` 120, hard `continue` in
`selectBotTarget`), so any state that pinned yaw on one bearing made the bot blind to everything
else — and alerting a bot *narrowed* its awareness instead of widening it. Two failures fell out
of that: an alerted bot stood facing threat A for up to `ALERT_HOLD_MAX_MS` 20 s while threat B
walked in from any other bearing, and a `BOT_SEEK` bot faced its straight-line goal while its nav
path doglegged, so it walked down corridors it was not looking at.

Fix: `stepAttention` / `attentionSweep` in `bot-alert.js` (pure, tested), consumed by a new
`faceThreatAndAhead(threat, dt, now)` in the viewer:
- **Moving** — alternate the dwell: `ATTENTION_THREAT_MS` 1200 holding the threat bearing, then
  `ATTENTION_AHEAD_MS` 800 facing the actual velocity heading, repeating. The glance is sized to
  outlast a 180° turn at `TURN_RATE_RAD_S` 4.5 (~700 ms) so the bot genuinely arrives and looks;
  a test asserts that relationship. The turn transit itself sweeps the cone across everything
  between the two bearings, which is most of the awareness win.
- **Standing** — no heading to check, so the threat bearing gets a triangle-wave offset instead
  (`ATTENTION_SWEEP_RAD` 0.95 rad ≈ 54°, `ATTENTION_SWEEP_MS` 2800 period), moving the blind arc
  rather than pinning it. Anchored at the first sample so each hold starts centred.

Wired into the four states that committed to a single bearing: `'alert'`, `BOT_SEEK`,
`BOT_HEAL`, and the non-peek branch of `BOT_COVER_HOLD`. Deliberately *not* wired into
`faceAimDirection` states (`BOT_AIM`/`BOT_FIRE`/`BOT_PURSUE`/`BOT_FLEE`/`BOT_KNIFE`, peek-aiming
cover): once a target is actually visible the bot commits and stops scanning, so this costs
nothing in a live engagement. State lives in `actor.attention`, cleared on death.

Known tradeoff: a bot mid-glance has its weapon off the threat bearing, so a scan can cost it the
first shot if the threat reappears at the wrong moment. That is the intended exchange — the
alternative is the tunnel vision this replaces — but the dwell ratio is the tuning knob if it
reads as too distracted in play.

### A bot can finally read reports about itself (2026-07-25)

Browser QA: **medics and patients were being shot and never turned around.** Three compounding
causes, the first of which had been latent since the alert stack was built:

1. **A bot could not read its own hit reports.** `recordAllyHit` pushes `{victimId, threat, …}` for
   every damaged bot, but `latestAlertNear` explicitly skips `hit.victimId === me.id` (it answers
   *"was a **teammate** hit"*) and `latestNearMiss` matches only `kind === 'nearmiss'`. So a bullet
   actually **landing** on a bot gave that bot no bearing whatsoever — only near *misses* ever
   reached their own victim. `beginBotHealthRetreat` stores `healThreatId` but never sets
   `lastKnownTarget`, so nothing else filled the gap either.
2. **The near-miss cue was tier-suppressed and PATROL-only.** `nearMiss` is nulled whenever any
   `alertTier` is live, and the only consumer, `wantAlertHold`, requires `state === BOT_PATROL`.
   A healing bot is never in PATROL, so no alert path could reach it regardless.
3. **The healing states faced social points.** `beingHealed` faced `healMedicXZ`, `MEDIC_TEND`
   faced `medicAction`, `BOT_HEAL` faced `lastKnownTarget || botCombatMoveGoal`. When a bot had
   never seen its attacker, all of those were null → `faceThreatAndAhead` fell through to
   `faceMovement`, which early-returns below 0.05 m/s. A stationary healing bot could not rotate
   **at all**.

Fix: `latestSelfThreat(hits, me, now)` in `bot-alert.js` — freshest in-window report whose victim
is me, hit *or* near miss, each on its own window (graze 3 s / death 8 s / near miss 1.5 s). It is
computed unconditionally in the sentry (no tier gate, no state gate) and feeds a `threatFacing()`
helper whose priority is **whoever is shooting me → the state's own point → the alert threat →
last known**. Wired into every non-aiming branch: `beingHealed`, `BOT_HEAL`, `MEDIC_TEND`,
`BOT_SEEK`, `BOT_COVER_HOLD`, `'alert'`. `MEDIC_MOVE` and `BOT_COVER_MOVE` take the narrower
`selfThreat?.threat` only, so with no incoming fire they still fall through to plain
face-movement and their travel behavior is unchanged.

Because these states are mostly stationary, the split-attention sweep applies too: a bot healing
or tending now slowly sweeps around the threat bearing instead of staring at one point.

`latestAlertNear`'s self-skip is deliberate and unchanged — the two accessors answer different
questions, and `alertEscalation` still counts casualties only, so tier thresholds are untouched.

Note the priority change beyond the shot-at case: a patient waiting on a medic now faces a live
`lastKnownTarget` in preference to the medic. That is intended (it already fires at visible
enemies while held) but it is a visible behavior change from "always face the medic".

## Uneven terrain in the v2 harness (2026-07-25, `bot-viewer-v2.html` + `bot-terrain.js`)

Both layouts (rooms and maze) can now sit on procedurally displaced ground instead of a flat slab.
It is **off by default** — the flat-floor path is byte-for-byte the old one, so existing perf
baselines and the Test condition are unchanged until the toggle is flipped.

### `bot-terrain.js` (pure, Node-tested via `test-bot-terrain.mjs`)

THREE-free, so the height math and the mesh builder are unit-testable without a GPU.

| Export | Role |
|---|---|
| `BOT_TERRAIN_DEFAULTS` | Every tunable, with the viewer's starting values. |
| `normalizeTerrainParams(p)` | Clamps scales/octaves/mesh resolution into safe ranges. |
| `createTerrainField(p, flatten, opts)` | `{ params, pads, features, grid, baked, heightAt, analyticHeight, rawHeight, gradientAt, slopeAt, normalAt }`. Pass `opts.bounds` to bake — see "Baking the height field". |
| `footprintRange(field, x, z, w, d, samples)` | Lowest/highest ground under an axis-aligned box footprint. |
| `buildTerrainMeshArrays(bounds, field, opts)` | Indexed grid mesh (`positions`/`normals`/`colors`/`indices`/`segX`/`segZ`/`triangleCount`) as plain typed arrays; the caller owns all THREE objects. |
| `LANDFORMS` / `FEATURE_KINDS` | The shaper table and the placed-feature vocabulary. |
| `erodeGrid(grid, p)` / `generateFeatures(b, p)` / `stampFeatures(grid, f, limit)` | Bake stages, exported for testing. |

The field is three independent, separately-tunable bands summed together, so any one can be zeroed
without touching the others:

- **hills / depressions** — seeded value-noise fBm (`hillAmp`, `hillScale`, `hillOctaves`), then
  shaped by `landform` and optionally terraced. Signed around zero, so the same band produces both
  rises and basins.
- **ripples** — mid-frequency surface band (`rippleAmp`, `rippleScale`). `rippleMode: 'isotropic'`
  (the default) uses a 2-octave fBm with no preferred direction; `'dunes'` keeps directional
  corrugation, on a seeded angle. See "Killing the corduroy" below.
- **grain** — single-octave value noise (`noiseAmp`, `noiseScale`) for per-step surface texture.

`heightAt` returns exactly `0` when `enabled` is false, which is what makes the whole viewer
integration a no-op in the off state. Total height is bounded by `hillAmp + rippleAmp + noiseAmp`.
`gradientAt`/`normalAt` are central differences of `heightAt`, so mesh normals, the nav slope gate,
and any future consumer all agree by construction.

### Viewer wiring (`bot-viewer-v2.html`)

The key structural decision: the displaced floor mesh is added to `mapRoot` like any wall, so
`createMapCollider` bakes it into the same BVH. **No physics code changed** — `stepBotPhysics`'s
existing `resolveCapsule` call walks bots up and down hills via the slope limit it already had.

| Hook | What it does |
|---|---|
| `terrainSettings` / `terrainField` / `rebuildTerrainField()` | Live params + the field built from them. |
| `groundHeight(x, z)` | The single ground accessor the rest of the viewer reads; `0` while off. |
| `decalY(x, z, lift)` | Ground-decal helper — nav dots, path line, FOV wedges, sight/knife rings, goal and recovery markers, health packs and their bob all lift by the local ground so hills don't swallow them. |
| `boxOnTerrain(mat, x, z, w, h, d)` | Wall/cover placement: base at the lowest ground under the footprint, top `h` above the highest, so a box never floats over a dip nor loses height on a rise. |
| `buildFloorMesh(w, d)` | Flat slab when off; otherwise the displaced grid (padded `TERRAIN_FLOOR_PAD = 2.5 m` past the bounds so edges aren't cliffs) plus a catch slab 1 m below the lowest vertex, since the terrain surface has no thickness. |
| `navWalkable(x, z)` | Now also rejects cells where `slopeAt > terrainSettings.maxSlope` — paths across too-steep ground just stall the capsule against the slope limit. |
| spawns | `applyLayout` drops `botSpawn`/`dummySpawn` onto the ground; `findBotSpawnPoint` and `spawnRandomDummies` do the same per point. |
| `createProceduralPlayerBody({ terrainHeight: groundHeight })` | Foot IK/gait plants on the hillside instead of on `y = 0`. |
| `RAGDOLL_DEATH_STEP.groundHeight` | Now the `groundHeight` function (`ragdoll.js` accepts `number \| fn(x,z)`), so corpses settle onto slopes. |

Panel section **Terrain**: on/off, seed (+ reroll, which also switches terrain on), hill
height/scale/detail, ripple height/scale, grain, mesh cell, max walk slope. Sliders commit on
release, not per drag tick — every change rebuilds the field, the floor mesh, every wall's sink
depth, the BVH collider, and the nav/cover bake.

### Limits worth knowing

- **`maxSegments = 220` per axis** caps the collider cost. Worst realistic case (Test condition,
  30×30 maze, ~112 m across) is ~96.8k terrain triangles + ~24k wall triangles ≈ 121k against
  `createMapCollider`'s 250k cap. Past that cap the mesh coarsens rather than the budget blowing
  up, so `meshCell` below ~0.5 m stops having an effect on large maps.
- ~~The cover/visibility bake is still 2-D.~~ **Fixed 2026-07-26** — see "Terrain-aware navigation
  and cover" below.
- Hitscan still passes `heightAt: () => -1e6` to `resolveHitscan` and relies on the BVH occluder,
  so terrain impacts report as `kind: 'world'`, which `recordBotShotResult` already treats as a
  blocked shot alongside `'terrain'`.

## Terrain-aware navigation and cover (2026-07-26)

Three gaps closed together, so hills stop being scenery the AI cannot perceive. All three are
inert on a flat map (no height grid → no cost, no occlusion, no pads), so the Test condition and
every flat-map baseline are unchanged.

### 1. Terrain occludes sight, and crests are cover

`nav-visibility.js` gained an optional height grid:

| Export | Role |
|---|---|
| `buildHeightGrid(navGrid, heightAt)` | Ground height at every cell center (`Float32Array`). `buildNavGrid`'s own `heights` array is the same thing, so the viewer reuses it rather than sampling twice. |
| `TERRAIN_EYE_HEIGHT` (1.6) / `TERRAIN_LOS_MARGIN` (0.2) | Eye height the traces use — matching the live `mapCollider` raycast — and the slack that keeps quantization erring toward VISIBLE. |
| `buildVisibilityField(grid, sight, { terrain })` / `buildLazyVisibilityField(grid, sight, { rowCacheCap, terrain })` | `terrain` is `{ heights, eyeHeight?, margin? }`. |

The DDA now tests each visited cell's ground against the eye-to-eye chord (parameterized by the
cell's projection onto the trace axis, so it needs no extra state in the step loop). A ridge that
rises more than `margin` above the sight line blocks; a dip never does; a bump under eye height
never does. Lazy and eager fields stay bit-identical.

`nav-corners.js` turns that into cover. `buildCornerMap(grid, rects, field, { heights, crest })`
appends **crest records** — same record shape as wall corners (`anchorCell`/`peekCell`/`peekDir`/
`claimedBy`), tagged `kind: 'crest'` vs `kind: 'wall'`, so `bot-cover.js` needed no changes.
Qualification is *measured, not assumed*: from a candidate anchor the scan walks uphill for the brow
(`maxSpan`), picks a threat-side probe cell (`farCells` beyond it), and keeps the record only if the
anchor is hidden from that probe **and** the brow can see it. `CREST_DEFAULTS` also carries
`minRise` (prefilter), `spacingCells` (one record per block per direction, so a rolling field can't
flood the map), `maxRecords` (hard cap, row-major = deterministic) and `stride`. The viewer converts
metres → cells (`NAV_CELL` is 0.5 m) and drops to `stride: 2` past 220 columns.

**Reality check from the sweep:** crest cover only exists where the relief does. At ~3 m of total
relief the bake emits zero crests (correctly — a standing bot sees over it); at ~5 m it emits
dozens; at ~8 m it saturates the 400-record cap. The default `hillAmp` of 0.9 produces none, which
is the honest answer rather than the old silent disagreement with the raycast.

### 2. Slope costs, in the search and in the legs

`buildNavGrid(walkableTest, bounds, cellSize, { heightAt, slopeCost, blockers, blockerMargin })`
stores a per-cell height array and a `slope` config (`SLOPE_COST_DEFAULTS`: `up: 1.8`, `down: 0.6`, `maxFactor: 6`,
`smoothMaxRise: 0.6`). Every step in `findPath` and `floodFill` is multiplied by
`1 + weight * |grade|` — never below 1, so the straight-line heuristic stays admissible, and
uphill is charged harder than downhill. On a height grid `floodFill`'s `dist` is therefore
*effort*-metres, which is what the flee/goal scorers want anyway.

`smoothPath` gained a matching guard: a string-pull shortcut is rejected when the chord climbs more
than `smoothMaxRise` above its own endpoints (`chordClimb`). Without it the pull straightened every
detour right back over the summit the search had just paid to avoid.

The bot pays what the grid charges: `terrainSpeedFactor(p, mx, mz)` in the viewer scales
`followPath`'s speed by the gradient along the heading (`SLOPE_SPEED_CLIMB = 0.55` lost per unit of
climb, `SLOPE_SPEED_DESCENT = 0.12` gained descending, clamped to 0.4–1.15).

### 3. Level pads under spawns, cover and buildings

`createTerrainField(params, flatten)` takes a list of `{x, z, radius, y?, falloff?}` pads. Inside the
radius the ground is level at the pad center's **raw** height (resolved once at build time — sampling
`heightAt` there would recurse, and order-dependent pads would drift); outside it smoothsteps back
over `falloff` metres, defaulting to the global `flattenFalloff`. Overlapping pads pick the strongest
weight outright rather than averaging, because a blend between two levels is exactly the tilted
ground pads exist to remove.

**Both optional fields are how a pad stops being a leveller and becomes a landform.** Supply `y` and
the pad *raises* the ground to it instead of flattening to what is there. Supply `falloff` and the
pad sets its own rim steepness — which decides walkability outright, since a smoothstep rim peaks at
`1.5 × rise / falloff` and the nav gate rejects anything past `maxSlope`. Per-pad falloff was added
2026-08-11 for the `terrace` structure; with only the global value a map could hold a climbable
hummock or an unclimbable mesa, never both.
Pads are indexed into 8 m buckets — `heightAt` runs hundreds of thousands of times per rebuild and a
structure-heavy map carries a hundred pads.

The viewer builds the list in `terrainPadsForLayout(layout)` (both spawns at `SPAWN_PAD_RADIUS`,
every cover footprint, plus any `layout.pads` the generator asked for) and rebuilds the field
**first** in `applyLayout`, so spawn heights, wall sinking, the mesh, the collider and the nav grid
all read the same post-flatten ground. Panel: **level pads** toggle + **pad blend (m)** slider in
the Terrain section; the toggle's tooltip reports the live pad count.

## Large open maps: structures + the fly camera (2026-07-26)

Wall-less mode (`mazeWallMode: 'open'`) gives you a big terrain field; these two make it a workspace
you can actually build and inspect in.

### `structure-viewer.html` (standalone tool, checked by `test-structure-viewer.mjs`)

A bench for `bot-structures.js`, served like any other page here (`python serve.py`, then
`http://127.0.0.1:8080/structure-viewer.html`). It exists because structures could previously only
be judged inside `bot-viewer-v3.html`, scattered across a combat map at whatever scale the maze
happened to be — which made it hard to see what one parameter does and impossible to tell whether
the procedural space contains **families** worth freezing into presets.

It imports `createVisualSystem`, `createPostFX`, `createLightingRig` and `createBotFlora` directly,
so "the same theming, sky, lighting and UX as v3" is literal rather than approximate — it is the
same code object, and a theme rolled here is the theme v3 renders.

**Deliberately absent: the nav grid, the lazy visibility field, the cover-corner bake and the BVH
collider.** All four are bot-AI infrastructure, all four are the expensive part of a v3 rebuild, and
none of them changes how a structure looks.

Two modes:

- **Field** renders one scattered set over a square map — what v3 renders.
- **Gallery** puts one `generateOne` specimen per grid cell, each on its own seed, each rerollable
  by clicking its label in the scene. This is where families become visible, and it is the only
  genuinely new interaction here.

Cards, in panel order: Mode · Structure · Wall · Building · Pocket · Obstacles · Portal · Terrain ·
Flora · Visuals (`visuals.buildPanel({heading:false})`) · Presets.

Readouts along the bottom left: placed versus requested (the field sampler drops silently), the
per-kind breakdown, wall/cover/slab counts, the largest footprint, **minimum slab headroom** flagged
red under 1.8 m, terrain triangles, and the flora counts with the blade cap called out when it binds.

Things worth knowing before editing it:

- The gallery does **not** reject-sample, so a specimen wider than its cell reaches into its
  neighbour. `SLOT_MIN` (28 m) clears the widest structure the defaults can build — measured at
  8.92 m radius over 200 seeds × 4 kinds, so 17.8 m across, plus the canopy overhang. Raising
  `buildingMax` can still outgrow the cell, so the HUD says when a slot did.
- Slot seeds are `(base, index, that slot's own reroll counter)`, so rerolling one specimen cannot
  disturb another. The test proves the strides never collide for up to 16 slots and 32 rerolls.
- Presets use the slot group **`structures`**. `bot-viewer-slots.js` hardcodes `pcw:bv2:slots:` and
  namespaces only by group, so reusing `maze`, `bots` or `ui` would overwrite v3's saved slots.
- `visuals.buildPanel()` includes a Bot lighting block. It is dropped host-side by slicing the
  returned node list between its heading and the next one, rather than by changing the module, so
  v2 and v3 are untouched.
- `createLightingRig` defaults to `ui: true`, which would build a second lighting panel fighting the
  theme for the same rig. And once `createVisualSystem` owns the rig, `rig.setAzimuth`/`setElevation`
  recompute from `lights.js`'s own stale state — drive light direction only through the theme.

`test-structure-viewer.mjs` scans the source for each of those wiring traps, because every one of
them fails silently in a browser, and separately checks the gallery sizing rule against the real
`generateOne`.

### `map-boxes.js` (Node-tested via `test-map-boxes.mjs`)

The box-mesh glue, lifted out of `bot-viewer-v3.html` on 2026-08-09 so `structure-viewer.html` shares
it instead of becoming a third copy. **`bot-viewer-v2.html` is frozen and keeps its own copy on
purpose** — two copies with one frozen beats three live ones.

| Export | What it does |
|---|---|
| `UNIT_BOX` | The one `BoxGeometry(1,1,1)` every instanced wall, cover and slab shares. |
| `instancedBoxes(parent, mat, boxes)` | One `InstancedMesh` per material. A maze is ~950 boxes; one draw call and one shadow caster beats 950. Returns `null` for an empty list. |
| `boxMesh(parent, mat, x, y, z, w, h, d)` | A single sized box, for the few one-offs (floor slab, terrain catch slab). |
| `clearBoxes(parent)` | Teardown: disposes geometry a mesh owned, **skips `UNIT_BOX`**, and disposes instance buffers. |
| `boxOnGround(x, z, w, h, d, range)` | Wall/cover fitting. `range` `null` = flat ground. |
| `slabOnGround(x, z, w, d, baseY, h, groundMax)` | Elevated-box fitting. |

The transforms take a **resolved height range**, not a terrain field. Sampling stays with the caller
(`footprintRange` needs `terrainField`, which only the viewer owns), which is also what makes the
math pure and testable in Node. v3 keeps `boxTransformOnTerrain`/`slabTransformOnTerrain` as
two-line wrappers that do the sampling and delegate.

Two invariants the test pins, because both fail silently:

- **`clearBoxes` must never dispose `UNIT_BOX`.** Disposing it once breaks every later rebuild, and
  nothing throws at the point of the mistake.
- **`slabOnGround` lifts by the ground's `max`, never its `min`.** Slabs are deliberately absent from
  the nav grid, so a bot walks straight under one; sampling the low point sinks the slab into the
  rise and turns an overhang into a trap.

### `bot-structures.js` (pure, Node-tested via `test-bot-structures.mjs`)

The maze carve moved here out of `bot-viewer-v2.html` — `generateMazeCells` (unchanged, now
Node-tested) plus `mazeCellWalls(cells, cols, rows, { cell, originX, originZ, wallT, ringOnly })`,
the wall emission the layout used to do inline. `ringOnly` is the perimeter wall mode.

`generateStructures(bounds, params, avoid)` scatters islands of content over open ground and returns
viewer-shaped `{ walls, covers, slabs, pads, placed }`:

| Kind | What it is |
|---|---|
| `building` | Rect shell: four wall runs, each a doorway, a window or solid; a 50% internal divider with its own gap; 0–2 interior cover boxes; and a 50% cantilevered canopy. Asks for a level `pad`. |
| `pocket` | A small braided maze block (`pocketCells²` at `pocketCell` m) with 2–4 entrances — a hazard to cross, not a trap to die in. |
| `obstacles` | A field of boxes at mixed heights: `tallShare` of them at `tallHeight` (≥ `SIGHT_BLOCK_HEIGHT`, so they yield cover corners), the rest shoot-over cover. |
| `portal` | Two piers carrying a deck at `wallHeight` — the underpass form. The piers are walls, the deck is a slab, so you fight *under* it. |
| `colonnade` | A grid of tall posts, optionally carrying a soffit. Posts are **covers, not walls**, because only covers carry a per-record height — a post emitted as a wall is forced to the global `WALL_H` and the grid collapses into a maze. At `tallHeight` each post blocks sight and yields cover corners, so the grid is transparent at range and opaque up close. |
| `slot` | Two parallel walls and nothing else: a firing lane you commit to, with no perpendicular escape. Unlike a `pocket` it does not branch. |
| `rampart` | One long wall carrying a cantilevered soffit, with a sight-blocking buttress on each face. The wall is a long sight-line blocker, the soffit is deep shade that costs nothing in nav, and the buttresses manufacture the free ends `buildCornerMap` wants. |
| `corner` | Two perpendicular walls and the nook inside the elbow, furnished with one sight-blocker and one shoot-over cover. The cheapest kind here and the most reliable defensible hold. |
| `terrace` | **High ground, made of ground.** Emits no geometry at all — only terrain pads. See below. |

#### `terrace`: elevation without layered nav (2026-08-11)

Nav reads one height per cell from the terrain field, and the capsule has no step-up and no jump, so
a slab is something bots walk *under* and never *onto*. A terrace sidesteps that entirely by raising
the ground instead of floating geometry above it: the top **is** the walkable surface, so nav, the
visibility field and the collider all see it without learning anything new.

It emits pads only — `{x, z, radius, y, falloff}`:

- **The top pad** carries a `y` (the rise) and a tight `falloff`. A smoothstep rim peaks at
  `1.5 × rise / falloff`, so a tight falloff puts the sides past the nav slope gate and **the mesa
  excludes itself**. That is the whole trick: the sides are unwalkable because of their shape, not
  because anything was told to block them.
- **The approach** is a chain of pads stepping down and out, spaced `drop / grade` so the run follows
  from the rise rather than being guessed. It is the only way up.

`falloff` is per-pad as of the same date (`bot-terrain.js`); it used to be the global
`flattenFalloff`, which meant one map could hold a walkable hummock or an unclimbable mesa but never
both. `y` was always supported (`y: f.y ?? baseAt(...)`) and simply had no caller.

**Measured, not assumed** (`test-terrace.mjs` builds the field, bakes a real nav grid over it and
runs `findPath`):

- 24/24 seeds are reachable up the ramp, and 24/24 keep a rim that is ≥60% blocked.
- Delete the approach and the summit becomes unreachable — so the reachability above is the ramp
  doing its job, not a rim that was climbable all along.
- `connectStrandedRegions` carves **0** cells on a well-formed terrace, and on a rampless mesa it
  records the summit as *sealed* rather than cutting a staircase into the side. The worry that the
  connectivity repair would undo the rim is measured as unfounded.

A terrace is by far the widest kind — the ramp roughly doubles its radius — which is why
`structure-viewer.html`'s `SLOT_MIN` is 36 m rather than 28.

**`padTerrain`: a pad-only kind is invisible without terrain (2026-08-12).** Because a terrace emits
*only* pads, a caller with terrain off drops them on the floor and the structure renders nothing —
while still consuming a placement slot and its separation radius. Measured at **10.6%** of
placements under Mixed (60 seeds × 8 slots), and both viewers default terrain to off, so roughly one
structure in nine was an invisible hole with no warning.

`STRUCTURE_DEFAULTS.padTerrain` (default `true`, so no existing caller changes) tells the generator
whether pads will actually be used. When it is `false`, `kindsForMix` drops every kind in
`PAD_ONLY_KINDS` from **`mixed`** — but never from a mix that *named* one, because an empty map is a
worse answer than a flat one. The result carries a `dropped` list so a UI can explain itself rather
than silently shrink the pool. `isPadOnlyKind(kind)` is exported for the same reason.

Both viewers pass it (`terrainSettings.enabled && terrainPadsEnabled` in v3, which also runs through
`applyTerrainChange` → `rebuildActiveLayout`, so toggling terrain re-rolls the pool). v3's structure
tooltip appends *"terraces are invisible with terrain off"* when a pad-only kind was placed anyway.

**The mix dropdowns had drifted (fixed 2026-08-12).** Five kinds shipped on 2026-08-10/11 and
`bot-viewer-v3.html`'s dropdown still listed the original four, so colonnades, slots, ramparts,
corners and terraces were reachable only by accident under Mixed and could not be isolated.
`test-bot-structures.mjs` now scans both viewer sources and asserts every kind the generator can
build has a mix that reaches it — resolved *through* `generateStructures` rather than by guessing
plurals, since `obstacles` is already plural. Verified to fail against the old five-entry list
(missing: colonnade, slot, rampart, corner, terrace) before being accepted.

**What this route cannot do:** the space underneath. A raised platform is solid, so nothing built
this way is an underpass. Decks you fight on *and* under still need the sparse level overlay in
`docs/elevated-structures-plan.md`.

`slabs` are elevated boxes and are **not** interchangeable with `walls`: see "Elevated geometry"
below for what they are deliberately absent from.

Placement is rejection sampling with `minSeparation` between footprints and an `avoid` list (the
two spawns) — **the gaps between structures are the firing lanes**, so spacing is the main tuning
knob. A structure that can't find room after `attempts` tries is silently dropped rather than
overlapped, so a crowded map degrades to fewer structures. `mix` picks `mixed`/`buildings`/
`pockets`/`obstacles`.

**The slot's gap is a hard floor, not a taste setting.** `navWalkable` inflates every wall by
`WALL_MARGIN` (0.55 m), so a gap under about 1.6 m seals shut and the slot stops being a corridor at
all — it becomes a solid block that still *looks* like a passage. `slotGapMin` defaults to 2.0 m and
`test-bot-structures.mjs` asserts the clearance that survives the margin.

`generateOne(kind, params, seed, { x, z })` builds a single specimen of one kind through the same
builders and the same stream the scatter uses, for galleries and previews. It always returns all
three geometry lists, so `pocket` and `obstacles` no longer need a caller-side `if (built.slabs)`.

#### Seed stability (2026-08-09)

Changing one parameter must change only what that parameter governs, or "fix a seed, drag one
slider" shows a different map instead of a variant. Two things used to break that, and both are
fixed:

- **One RNG stream for the whole scatter**, with the builder called *inside* the rejection loop, so a
  structure that needed five attempts consumed five builders' worth of draws and shifted everything
  after it. Now each structure draws from `streamSeed(seed, i, salt)` — a splitmix-style integer mix
  — with separate salts for kind selection, position, and shape, and **shape gets a fresh stream per
  attempt** (`SALT_SHAPE + attempt`). A rejected attempt now costs the next one nothing, and raising
  `count` leaves the structures already placed untouched.
- **Variable draw counts inside `buildBuilding`**: window rolls were skipped on door sides, opening
  positions were only drawn when there was an opening, and the canopy and interior-cover draws were
  all inside their own branches. It now front-loads a fixed 27-slot draw vector and indexes into it,
  the discipline `plants.js:414` documents for `rollPlantVariation`. The slot map is in a comment
  above `BUILDING_DRAWS`; **adding a roll means growing that constant, not calling `rng()` again.**

The other three builders were already draw-stable and were left alone: `buildPortal` draws four
values unconditionally, `buildObstacles` draws five per obstacle with every roll in a ternary
*condition* (so `tallShare` cannot shift the sequence), and `buildPocket` consumes the rest of its
stream inside `generateMazeCells` with nothing after it.

**The limit, stated so it is not later mistaken for a bug:** placement is still rejection-sampled
against already-placed structures, so a change that resizes a *footprint* (`buildingMin/Max`,
`pocketCells`, `clusterRadius`, `portalMin/Max`, `minSeparation`) can still move later structures.
The candidate sequence is stable; only accept/reject moves. `test-bot-structures.mjs` asserts this
case explicitly alongside the stable ones.

The regression tests are fixture-sensitive: on a roomy map with few buildings they pass against the
*pre-fix* generator too. The chosen fixture (`seed: 3, count: 14`, mixed, 140 m) places four
buildings across four kinds and does reshuffle before the fix — verified against the snapshot in
`versions/`. Keep that property if the fixture is ever changed.

Existing structure seeds changed with this work, the same way they did when `portal` was added.

Viewer wiring: `buildMazeLayout` runs the scatter only when `structuresOn && mazeWallMode !== 'maze'`
(maze mode is already all walls), on its own seed stream (`mazeSeed ^ 0x5bf03635`) so restructuring
never reshuffles the maze or the cover scatter. Building pads flow into `layout.pads` →
`terrainPadsForLayout` → flat building slabs. Panel: **structures** toggle (tooltip reports what the
last build actually placed), **structure count**, **structure spacing (m)**, **structure mix** —
all greyed out in maze mode, next to the walls dropdown.

### Fly camera (`CAMERA_FLY`)

Orbiting is unusable for crossing a 200 m field, so there is a fourth camera mode, and it is the
only one that needs no actor (it works on an empty map).

- **G** toggles fly ⇄ orbit, **Esc** leaves it, or the **Fly** button in the Camera section.
- **W/A/S/D** move along the look direction, **Q**/**E** or **Space** down/up, **Shift** boost (×3),
  **Ctrl** crawl (×0.25), left-drag to look, **wheel** trims speed (1–120 m/s, also a slider).
- **fly mode: Free flight / Walk ground** — walk mode clamps the camera to `groundHeight + 1.7`,
  which is how you judge slopes and sight lines the way a bot sees them.
- `updateDummy` yields WASD while flying, so driving the view never walks the dummy too.
- Entering adopts the current view direction (no snap); `controls.enabled` goes false and
  `stepFlyCam` commits the pose after `controls.update()`, exactly like POV.
- Speed and walk-mode persist in the **ui** save slot; the mode itself restores too.

### FSM remediation wave 1: the four cheapest tells (2026-07-25)

From the five-agent systemic audit (`docs/superpowers/reviews/2026-07-25-bot-fsm-behavior-audit.md`,
findings H1/H2/H4/C5; execution plan in `docs/superpowers/plans/2026-07-25-bot-fsm-remediation-orchestration-plan.md`):

- **H1 — exposure-gated alert hold** (reversal of the 2026-07-24 unconditional hold; rationale
  in that section above). `exposedToThreat` hardened to fail open: null bake, off-grid, or
  unwalkable cells all return `false` ("not confidently exposed" → hold allowed), so degenerate
  input reproduces pre-gate behavior. The harness computes it only for a bot the hold could
  actually apply to (PATROL, no visible target, live alert).
- **H2 — push tier is cover-eligible.** `alertTierChannels(tier, report, into)` in bot-alert.js
  is now the single tier→channels table (tested, alloc-free out-param); push arms `coverAlert`
  and still never arms `holdAlert`.
- **H4 — being shot seeds the search.** A non-near-miss self-threat report from an unseen
  bearing seeds `lastKnownTarget` (flagged `fromReport: true`) → the ladder's SEEK rung runs the
  existing investigation machinery at the shooter's position. Guards, each closing a review
  finding: near misses stay facing-only cues (S2); anchors within 1.5 m of the bot are dropped —
  own blast splash (S3); `lastKnownTargetMotion` nulled so a stale heading can't order the
  frontier (S7). The sentry's no-live-target teardown now *keeps* `fromReport` anchors (it
  discards dead-entity memories, but a report never described an entity) — without this the
  per-tick teardown + reseed rebuilt the investigation BFS every frame (S1, caught in review).
  Report-seeded searches retire through `finishInvestigation` (expiry/exhaustion) like any other.
  The push-tier seed gets the same flag for the same reason.
- **C5 — miss-streak resets.** `botMissStreak` now resets on target identity change
  (`actor.lastTargetId`) and after 1.5 s of continuous lost sight (`MISS_STREAK_SIGHT_RESET_MS`),
  so one bad engagement can no longer make a bot charge on the first three shots at every later
  enemy. Fields are actor-direct (not in the bind/commit register bank), same pattern as
  `coverBlacklist`.

Known follow-ups recorded for later waves: push ≈ defensive + marker until wave 5 builds real
group behavior (S4); ally-report cover entries can now reach the 6 s drought → life-scoped
blacklist faster, so wave 2's blacklist TTL matters more (S4); `selectBotTarget` has no switch
hysteresis, so in crowds the C5 identity reset can starve pursue-on-miss (S6); friendly splash
still seeds a teammate-position anchor — needs `attackerTeam` on reports (S3 residual).


## V2 viewer camera controls (2026-07-25, bot-viewer-v2.html)

The v2 harness now has a dedicated Camera panel: damped OrbitControls with tighter near zoom, adaptive far zoom, screen-space panning, and optional auto-rotation; click a living bot for smooth third-person follow or Shift-click it for first-person POV. Auto-follow chooses the nearest living bot when the followed actor disappears. F frames the followed bot, O returns to orbit, and V enters POV. The optional auto scene shuffle alternates rooms and freshly seeded mazes at a configurable interval, retaining the living team/role roster and dummy count across the rebuild. Follow framing now owns its focus and zoom while auto-rotation is active only in manual orbit, preventing controller drift. It preserves a user-selected zoom, widens gradually for movement and long engagements, blends toward the active target, holds on a killed followed bot for 1.25 seconds, then auto-selects the nearest living bot; the Follow nearest bot button and ] shortcut use the same proximity rule. Follow mode also raycasts the existing map BVH between its focus and desired camera position: the Occlusion guard pulls the camera inward immediately before walls block the subject, then eases it back to the requested zoom after the view clears.

### POV HUD + eye-bridge anchor restore (2026-07-30)

POV mode has a DOM overlay (`#povHud`, toggled by `setCameraMode` via `updatePovHudVisibility`):
a centre crosshair, and a hitmarker X that pops when the followed bot's shot lands (red and
longer-lived when the hit was fatal). The hitmarker hooks `creditBotHit` — the one place every
bot-victim damage path (bullet, knife, blast) already credits through, after the health decrement
so lethality reads correctly — plus the dummy branch of `applyCombatDamage`; blast damage to
dummies threads the thrower through `source.attacker` since the active-bot global no longer points
at the thrower when a projectile lands. A red diamond marker (`povSpotMark`, updated once per
frame by `updatePovSpotMarker`) floats above the head of the enemy the followed bot currently
sees (`actor.target` + `actor.targetVisible` — single-slot threat model, so at most one) and
lingers `POV_SPOT_LINGER_MS` (1.2 s) after sight loss.

The 2026-07-27 comfort presets blended the POV camera 68–84% back toward the capsule-axis point
(`headBlend` 0.32/0.16), undoing the 2026-07-26 eye-bridge anchor fix — the camera sat inside the
head. All presets now use `headBlend: 1`: the camera anchors at the animated head's eye bridge and
comfort is purely temporal damping (position/rotation rates, dead zone, max lag).

The anchor itself is user-tunable: `povEyeOffset` ({y, z}, head-local metres, z out through the
face) is added inside `botPovAnimatedEyePoint` before `localToWorld`, driven by the "POV eye
up/down (m)" and "POV eye forward (m)" sliders in the Camera panel (defaults 0/0 keep the authored
eye bridge). The no-head capsule fallback applies y as world up and z along the bot's yaw.

### POV debug HUD (2026-07-31)

A game-style overlay ("POV debug readout" toggle in the Camera panel, default on) showing the
followed bot's *perceived* state so the rendered view can be checked against what the bot actually
knows. Every field reads off the followed **actor** (committed each think tick, so it is exact even
under think stagger). The widgets, all inside `#povHud`, updated by `updatePovDebugHud` with
change-guarded DOM writes:

- **Dynamic crosshair** — the four bars' gap is the live spread half-angle projected to screen
  pixels (`spreadRad × pxPerRad` from `camera.fov`); colour is the fire decision (white = no seen
  target, orange = seen but inside the A10 delay, red = shot legal). `layoutPovCrosshair`.
- **Reaction ring** (`#povRing`) — conic-gradient countdown around the crosshair while the
  recognition delay runs on a seen target; masked to a thin ring.
- **Target plate** (`#povTarget`, above the crosshair) — target id, distance, visibility gate
  spelled out (`CLEAR`/wall/fov/range), the target's health bar, and the aim gate line
  (`+340ms (primed)` / `READY` / `FIRING`) with border colour matching the crosshair state.
- **State chip** (`#povState`, below the crosshair) — a dot in the `botStateColor` orb colour +
  state name + time-in-state, with the alert tier as a coloured badge (SEEN/HEARD/PUSH/BASE/NEAR,
  matching the overhead-mark colour language).
- **Vitals** (`#povVitals`, bottom-centre) — name/team/role/stance/life/k-d line, health bar
  (hue-scaled), magazine bar with reserve count and a pulsing reload sweep + countdown, and
  grenade/pack/revive-kit pips.
- **Squad widget** (`#povSquad`) — one row per member with a live health bar; leader starred,
  followed bot arrowed, dead members dimmed; header shows formation/engaged/push element. Rows
  rebuild only when membership or leadership changes.
- **Text panel** (`#povDebug`) — the residual ground-truth numbers not worth a widget: state line,
  shots/hits, target + aim gate, last-known contact (age, `[report]` origin), nav mode + waypoint
  count + goal coordinates.

The panel column (`#povLeft`) sits top-left under `#info` — measured from `#info`'s live rect (it
wraps on narrow windows), deliberately clear of the bottom-left `#hud-bottom` row
(fps / navwarn / score / now-playing) and the bottom-centre vitals.

Second pass (same day) made it diagnostic rather than just informative:

- **Aim reticle** (`povReticle`) — a ring at the bot's *actual* muzzle bearing (entity yaw/pitch,
  not the free-look camera), radius = the spread cone at that distance, colour = the fire
  decision. Together with the target plate's `err` readout (the real `aimError` vs
  `AIM_TOLERANCE_RAD` gate) it shows the one gate that decides AIM vs FIRE.
- **Direction arrows** (`.pov-edge`) on a ring around the crosshair, angle = horizontal bearing
  relative to the camera heading: `▲` current target while outside the camera's horizontal FOV
  (colour = aim gate), `‼` whoever shot this bot (fresh `lastSelfThreatXZ`, now committed on the
  actor), `!` the squad-alert threat bearing in the tier colour.
- **SEEK/COVER markers** — a fading ghost diamond at `lastKnownTarget` (yellowed when
  `[report]`-seeded), cover anchor + peek-seat diamonds with the slide line between them, and the
  state chip appends the live peek phase (`peek in/out EXPOSED`) during COVER_HOLD.
  `buildFovWedgeGeometry` uses the *effective* cone for all bots — base `fovDegrees` maxed with the
  alert-tier widening.
- **The FOV wedge is suppressed for the inhabited bot** (`povSelf`, 2026-08-02). An earlier revision
  force-showed the followed bot's wedge in POV to make the perception cone checkable in-view. That
  was wrong on geometry: the wedge is a flat ground fan spanning a 150° cone scaled to the full sight
  distance, and the render camera is 55° vertical (~88° horizontal), so from the wedge's own apex its
  edges are *always* off-screen. Only the 10%-opacity fill renders — a team-coloured film (Alpha
  green `0x57d68d`, Bravo red `0xff8a80`) over the entire floor, reported as ground haze. A cone can
  only be read from outside it. Other bots' wedges still draw in POV, where they are genuinely
  useful: you can watch an enemy's cone sweep toward you.
- **Acquisition-churn visibility** — the target plate shows `cand N` (in-cone candidate count,
  stamped by `selectBotTarget`), and the reaction ring flashes grey for 300 ms whenever a paid
  acquisition is torn down (`aimResetAt`, stamped in `primeAimAcquisition`) — retarget re-pays are
  unmistakable.
- **Target callout** (2026-08-02) — the plate moved off screen centre to the right edge, where it
  no longer sits on top of the sightline. It tracks the target vertically (clamped to the viewport),
  scales with proximity between 0.85x and 1.2x, and anchors a leader line to the target's diamond
  drawn in the gate colour, plus faint stubs to every other live perceived contact — so the plate is
  the hub of the contact set rather than a floating label. Lines live in an SVG layer appended
  *before* the plate so they render underneath it. `povScreenPos` returns null for points behind the
  camera, where `project()` mirrors them to a plausible but wrong position; the plate then parks at
  30% height and the line hides, since the edge arrow already carries the bearing. The plate rect is
  read once per frame *before* the style write, so it lags one frame instead of forcing a
  synchronous layout — imperceptible on a leader line.
- **Diamond flash** (2026-08-02) — the committed-target diamond grew (0.17 → 0.23) and now flashes,
  at double rate once the shot is legal and half that while the reaction delay runs; a
  memory-only contact stops flashing and sits at flat 0.5 opacity, so "still tracking" and "still
  seeing" are distinguishable at a glance. Perceived marks grew to 0.13 and flash only when LOS is
  confirmed this frame, each phase-offset by its index so they read as separate contacts instead of
  one pulsing block. Occluded marks stay steady and faint — motion in the periphery means someone
  can see you.
- **Target diamond size** (`povMarkScale`, Camera panel slider, 0.3x–3x, default 1x) scales the
  committed-target diamond and the perceived marks together — one visual family that keeps its size
  ratio. It deliberately does *not* touch the nav/goal/ghost/cover marks. Saved in the ui slot as
  `debug.povMarkScale` and clamped to the slider's own range on load, so a hand-edited slot cannot
  park the diamonds at 0 or 40x.
- **Perceived-enemy marks** — `selectBotTarget` now commits candidate *identities*
  (`actor.perceivedEnemies`, up to `PERCEIVED_ENEMY_MAX` = 8 `{entity, distSq}` entries,
  nearest-first, same `.alive`-guarded retention convention as `actor.target`; cleared on map
  reset). The world pass draws a small diamond over each one (minus the committed target): solid
  white = LOS re-verified clear this frame (HUD-only rays, followed bot only), faint grey = in
  cone but occluded. The plate's count becomes `cand N (M vis)`. This makes the single-slot
  amnesia visible — five enemies in the cone, one target — and the list is the seam a future
  multi-threat contact memory would replace (risk-scored target choice, threat-to-support ratio).
- **Shape + hygiene** — a centre dot appears only when the shot is legal (ready never rides on hue
  alone); `layoutPovCrosshair` is change-guarded; the squad key is allocation-free (size/leader +
  stale-row sweep); the toggle is split into **POV debug widgets** (screen) and **POV debug
  markers** (world), both persisted in the ui slot group (`debug.povScreen` / `debug.povWorld`).

The world markers are drawn `depthTest: false` on purpose (through walls — they describe intent
and memory, not sight): the cyan polyline (`povPathLine`, 64-waypoint cap) through the actor's
actual `path` queue and the cyan diamond (`povGoalMark`) at the terminal goal (path end, else
combat move goal / pack goal / cover anchor). The spotted-enemy diamond also encodes the fire
decision by colour: grey = lingering memory after sight loss, orange = seen but inside the
reaction delay, red = the shot is legal.

### Terrain fix: weapon mount height was world-absolute (2026-07-25)

First browser bug from the terrain work: held guns hung at a fixed world height instead of riding
with their bot. `updateBotWeaponMount` captures a one-time `bodyMountOffsetY` so the rig root sits
at the authored 1.5 m reference, but it captured it as `1.5 - visualTorso.position.y` — a *world*
y. On flat ground the bot's feet are at 0 so that reads correctly; on terrain it bakes in
`-feetY_at_capture`, leaving every bot's gun off by the ground height where its body happened to be
created. The no-body (capsule render mode) fallback was worse: a literal `weaponY = 1.5`, fully
detached from the bot.

Both now measure from the bot's own ground contact (`feetY = capsule.start.y - capsule.radius`):
capture is `1.5 - (visualTorso.position.y - feetY)` and the fallback is `feetY + 1.5`. With the body
on, the resulting expression is unchanged (`torso.y + offset`) — only the capture moved — so flat-map
behavior is bit-identical.

### FSM remediation wave 2: state-conflict fixes (2026-07-25)

Audit findings C1-C4, C8, C10-C14 + L9 (same audit/plan docs as wave 1). Pure logic went into
the modules; the harness got wiring only.

- **C1/C10 — pack claims need intent and a safe run** (`bot-health-packs.js`):
  `packClaimIntent(state, wantsHeal, hasPack)` — only PATROL (opportunistic) and
  wounded-packless FLEE may claim/seek a pack; FIRE/COVER/PURSUE bystanders no longer starve
  wounded bots or poison the claim cell namespace. `packRunSafe(botXZ, packXZ, threatXZ)` —
  closing-bearing + standoff-retention test (`PACK_RUN_SAFETY`: closingDot 0.5, minRun 2 m,
  danger 8.5 m, holdFrac 0.5) rejects the sprint-at-the-corpse-under-the-enemy detour.
- **C2 — cover commit timeout now measures travel** (`coverCommitTimedOut(moveSince, now)`):
  `actor.coverMoveSince` is stamped on every entry into COVER_MOVE (ladder transition +
  corner switch) and nulled otherwise; a long-held corner nudged by pushout no longer reads
  as an expired commit and gets blacklisted (`coverStartedAt` remains as commit bookkeeping only).
- **C3 — seat band** (`coverSeatBand(dist, holding)`, enter 0.45 m / leave 0.9 m): crowded
  bots stop flapping HOLD<->MOVE per pushout shove, so peek cycles complete and the drought
  clock accumulates. The harness's local `COVER_ANCHOR_REACH` is retired.
- **C14 — blacklist TTL** (`createCoverBlacklist`/`blacklistCover`/`coverBlacklisted`,
  `COVER_BLACKLIST_TTL_MS` 20 s): corner blacklists expire instead of monotonically
  exhausting the room over a bot's life. All three add sites + the findCoverCorner skip converted.
- **C8 — visibility loss debounce** (`stepVisibleDebounce`, 250 ms grace, gain instant):
  the state ladder + investigation teardown see the debounced bit; aiming/firing keep raw
  visibility. Reset on target switch and target death so grace never crosses opponents.
- **C13 — heal-safety hysteresis** (`healUnsafeBand`, exit buffer 1.5 m): a target hovering
  at safeDistance can't pump HEAL<->FLEE flood-fills.
- **C4 — a fleeing patient is never medic-frozen**: BOT_FLEE removed from the `beingHealed`
  yield list; the medic chases via its own re-plan instead of pinning the patient in the lane.
- **C6 — `'reposition'` cleans up on entry**: releases the flee claim and any committed cover
  corner, and starts a dry-mag reload during the walk.
- **C11 — self-blast write-through**: `beginBotHealthRetreat` writes the globals when the
  victim is the currently-bound actor (and reads the live `botHealRequested` for its guard),
  so commitBotActor can no longer clobber a self-inflicted heal retreat.
- **L9 — goal-claim releases are id+kind matched** (`bot-separation.js`): one owner holding
  two kinds on one cell can no longer free the wrong record; prerequisite for wave 3's
  `'seek'` claim kind.

Deferred: C12 (mid-tick shooter state stomp in applyCombatDamage — benign, LOW), the
`'reposition'`/`'alert'` sentinel-vs-commitment-test cleanup, and attackerTeam on reports
(S3 residual). C15 (budgeted cover A*) was already fixed by the concurrent refactor.

**Wave 2 review fixes (2026-07-25):** the adversarial pass found the C11 scenario unreachable —
`detonateBlast` damages victims inline and never triggered a heal retreat for ANY blast victim;
it now calls `beginBotHealthRetreat` per surviving victim (the write-through handles the
self-blast bound-actor case). Hardened the three new blacklist call sites with the
`botStateRecordFrameNow || performance.now()` idiom (a zero clock silently disabled the TTL),
removed the dead harness `COVER_COMMIT_TIMEOUT_S` and the dead flee-release in `beingHealed`.
Known follow-up (review MED-2): a medic closes on a fleeing patient at only ~0.24 m/s net, so
MEDIC_TEND is practically unreachable mid-flee — wave 4's medic work should bump chase speed or
widen tendRadius for FLEE patients. QA note: leave auto-shuffle OFF during wave-2 browser QA
(it resets all FSM/claim state and masks slow-accumulating bugs).

### FSM remediation wave 3: anti-lemmings (2026-07-25)

Audit findings H3, H5, L5, L6, L7, S9 (same audit/plan docs). New module + pure additions,
harness wiring, adversarially reviewed (fixes folded in below).

- **H3 — team danger field** (NEW `bot-danger.js`, Node-tested): decaying per-team danger over
  nav cells (`recordDanger`/`dangerAt`/`dangerPenalty`/`dangerBlocksCover`; death 1.0 + 0.4
  spread to 8 neighbours, hit 0.35, half-life 25 s, 64 entries/team, alloc-free reads).
  Writes: `killCombatBot` (death cell + the dead bot's cover anchor/peek cells — a bot that
  died mid-peek paints the cell it actually died at) and `recordAllyHit`. Reads: flee scoring
  (−), patrol-resume (+, minimized loop), pack seek (`cmp = dist + penalty`, raw dist kept),
  medic candidate cost, and a hard-but-expiring cover veto (`dangerBlocksCover` at 0.35 so the
  neighbour spread bites; single-death veto ~8 s, decay tail continues). Bravo deaths never
  scare alpha: fields are keyed by the victim's team and read with the reader's team.
- **H5 — seek spread + `'seek'` claims** (`bot-activity.js`): `spreadAnchor` saturating Vogel
  spiral; the harness maps each bot to one of 8 spiral slots (`spreadSeed & 7`, slot 0 = the
  true anchor, so ring 0 is always somebody's job) and skips the spread entirely for a solo
  searcher (`livingTeammatesNear <= 1`). Investigation carries `spread`/`spreadRadius`; the
  region gate widens by `spreadRadius` (without this, offset bots freeze waiting for their own
  ring-0 cell) and the BFS ceiling grows to match. Chosen search cells are claimed under the
  new `'seek'` kind (skip-not-attempted in the frontier; released on finishInvestigation,
  observer memory invalidation, the ladder sweep, reposition entry, and death).
- **L5/S9 — flee scoring** (`bot-cover.js`): `fleeCandidateScore` replaces the inline formula —
  adds a path-exposure penalty (`fleePathExposureFromParents`, zero-alloc parent-chain walk,
  stride 3, −10·exposure01) and a gentle squad-centroid pull (−0.15/m, radius 16 m, off when
  no teammate near; 6.7:1 dominated by threat distance so it can never drag a bot through the
  shooter). Measured on the L-wall test map: the old endpoint-only pick routed 83% of the
  retreat through the shooter's view; the new pick 17%. Cost +0.05-0.16 ms per findFleeGoal.
- **L6 — de-synchronized breaks** (`bot-activity.js` `pursueBreakThreshold`): per-bot hashed
  jitter on the pursue miss-streak (3 → 3..5) AND on the peek-miss release
  (`COVER_PEEK_MISS_LIMIT` 6 is now a floor, actual 6..8 per bot) so squads no longer abandon
  cover or charge in unison.
- **L7 — patrol stagger**: `patrolIndex: nextBotId % patrolPoints.length` — the two teams no
  longer conga through waypoint 0.
- `actor.spreadSeed` is lazily `??=` (actor-direct, not in the bind/commit register bank).
  `investigation.spread/spreadRadius` ride the wholesale investigation mirror.

Review notes carried forward: claimed frontier cells recover only via frontier reorder (safe,
skip-not-stall, worst wait ~1.3 s/ring, 12 s investigation cap); findFleeGoal has no frame
budget (pre-existing) and is now ~2× cost on its churn path — watch in browser QA.

### FSM remediation wave 4: synergy & awareness (2026-07-25)

Audit findings S2, A4/A5/A6, A9, H6, S10, S8, S12 + the wave-2 MED-2 medic-chase note.
Adversarially reviewed; review fixes folded in.

- **S2 — contact reports** (`bot-alert.js`): a bot with eyes on an enemy publishes a
  `kind:'contact'` report (one record per reporter ever, `at` = intel freshness bumped per
  sighting tick, `updatedAt` = 1 s rate-limit key; 4 s window, 18 m call-out radius).
  Excluded from escalation scoring, `latestAlertNear`, and `latestSelfThreat` — tiers still
  mean casualties. Squadmates consume via `latestContactNear`: seeds `lastKnownTarget`
  (`fromReport`, lowest priority after visible/push/self-threat) and falls into `coverThreat`
  (band-free, like ally reports). Review fix: `finishInvestigation` stamps a 5 s
  `contactSeedBlockUntil` so one teammate's held LOS can't re-arm back-to-back searches (or
  rebuild the frontier per frame on an unreachable anchor).
- **Report attribution** (2026-08-02): every report now names the enemy responsible, not only the
  place. `recordAllyHit` and the near-miss path stamp `attackerId` (both already had the attacker
  entity in hand and were discarding its identity), and `recordContact` takes an optional
  `threatId` naming who was seen. A near-miss refresh and a contact content-rewrite both
  re-attribute, so a reporter swinging onto a second enemy does not leave the first one's id
  attached. Nothing consumes these yet — this is the prerequisite for per-bot contact memory,
  where "is shooting at me" has to bind to an identity rather than a bearing, since ranking a
  shooter above a bystander is impossible when both are just coordinates. The accessors
  (`latestSelfThreat`, `latestAlertNear`) return the record itself, so the ids pass through
  untouched; `test-bot-alert.mjs` guards that round-trip against a future accessor that rebuilds
  records field by field.
- **A4/A5 — patrol scan** (`patrolScanOffset`, ±0.5 rad / 3.6 s, golden-ratio phase per bot;
  `sweepPhaseMs` de-phases the standing sweep per episode): moving out-of-contact bots
  (patrol, pack runs, medic cohesion) finally look around; standing groups no longer share
  one blind arc. `'reposition'` stays eyes-forward on purpose.
- **A6 — tier perception** (`perceptionForTier`): wary 140°/stride 3, defensive+push
  160°/stride 2, max-composed with the FOV slider; read one frame late by design. The debug
  FOV wedge still draws the slider cone (known cosmetic gap).
- **A9 — reload awareness**: ladder rungs `reloading && cover → COVER_MOVE` (visible and
  no-LOS variants) + `shouldTopOffReload` (mag < 35% and unseen/concealed) called at the
  sentry tail. Review fix: a peeking holder only tops off during the concealed hold AND the
  hold is extended to cover the reload — otherwise the cycle slid the bot out mid-reload,
  exposed and unable to fire.
- **H6a — spin-on-backstab**: `closeSelfThreat` (self-threat ≤ 4 m outside the cone) preempts
  everything below heal/knife/committed-flee/committed-cover with a spin AIM at the report
  bearing. Review fixes: latched until nearly aimed (0.4 rad), not merely in-cone, killing
  the cone-edge yaw jitter; and a peeking cover holder now breaks its peek-aim to face the
  backstabber (stays in cover — `threatFacing` handles the turn).
- **H6b — secondary-threat awareness**: `secondVisibleThreat` (second-nearest visible enemy,
  or a >3 m-distinct contact; zero new raycasts) vetoes corners in `coverCornerValid` and
  — review fix — PENALIZES (`COVER_SECONDARY_PENALTY` 6) rather than vetoes at pick time:
  half-cover blocks one of two firing lines and beats the open field.
- **S10 — staggered peeks**: `peekPhaseOffsetS(groupIndex)` (wrapped, not clamped) added to
  the first concealed hold on commit; `coverGroupIndex` counts same-threat holders within
  8 m at commit only. Known limitation: offsets are relative to each bot's own hold start
  and drift apart over ~15-27 s of jitter re-rolls — true wall-clock tiling is a wave-5 item.
- **S8 — allyDown cover exit**: a ≤2 s-fresh lethal report from a bearing >45° off the held
  threat releases the hold (no blacklist — bearing problem, not a bad corner). Review fixes:
  edge-triggered per report (`allyDownHandledAt` — was level-triggered, thrashing cover for
  2 s and permanently resetting the wave-2 drought clock) and the same-frame re-pick now
  hides from the NEW bearing (`coverThreat = report.threat`).
- **S12 + MED-2 — medic-in-cover + chase fix**: an exposed tend converts post-decision to a
  move onto a concealed cell near the PATIENT (single centre for gate and route — review
  fix; the hide cell is chosen once and stored on the action; none available → tend anyway,
  never freeze). `medicChaseSpeedFactor` 1.45 for fleeing patients (~0.5 m/s net closure,
  still under the 1.7 sprint multiplier) and `medicTendRadiusFor` 2.6 m mid-flee.
- Review perf fix: the cover probe (`findCoverCorner`) only runs when a ladder rung could
  consume it (`visible || coverAlert || reloading`) — contact-only bots no longer probe
  corners every frame. Drought exits with report-only threats no longer blacklist the corner.
- New actor-direct fields (lazily rebuilt, reset on death): `patrolScan`, `tierPerception`,
  `coverPeekOffsetS`, `spinLatched`, `allyDownHandledAt`, `contactSeedBlockUntil`.

Known deferrals: wall-clock peek tiling (S10), contact records age toward the ring head
(FIFO inversion under sustained fire, bounded), debug FOV wedge vs tier cone, dead reporter
contacts surviving 4 s. Browser QA additions: do patrollers crab-walk (±29° scan offset on
travel)? do alerted bots acquire outside the drawn wedge (expected — cone is wider)?

### Camera intent model (2026-07-27, `bot-camera.js` + `bot-viewer-v2-camera.html`)

Supersedes the 2026-07-26 "follow camera ownership", "unified camera rig" and 2026-07-27 "POV
comfort smoothing" designs. Those routed every pose through `cameraRig.commit` but kept **no stored
intent** — follow reconstructed the user's distance/direction/pan by measuring the rendered pose
(`|camera.position − controls.target|` against a start-of-drag snapshot, 0.002 epsilon, four guard
flags and a 450 ms momentum window). OrbitControls wrote the pose and then the follow pass
overwrote it, so in follow/POV/fly user input was discarded every frame.

**Currently shipped in `bot-viewer-v2-camera.html`**, a working copy forked from
`bot-viewer-v2.html` while another session was editing the latter; see the merge note at the end.

**Model.** The camera's state is one struct; the pose is derived from it and never read back.

```js
cam = { anchorId, drive, focus:{x,y,z}, pan:{x,y,z}, yaw, pitch, distance, fov }
position = focus + pan + spherical(yaw, pitch, distance)
```

`bot-camera.js` is pure (THREE-free, plain `{x,y,z}`), covered by `test-bot-camera.mjs`:
`createCameraIntent`, `rotateIntent`, `zoomIntent`, `panIntent`, `translateFocus`,
`stepCameraFocus`, `resolveCameraPose`, `decayTowardBotAim`, `recenterOnBotAim`,
`captureIntent`/`restoreIntent`, `yawPitchFromDirection`.

**Three axes replace four modes.** `anchorId` (world vs. bot), `distance` (0 = first person), and
`drive` (does WASD move the camera). Orbit / follow / POV / fly are now just named combinations, and
`setCameraMode` survives only as an adapter over them so legacy call sites stay one-liners.

|  | `distance > 0` | `distance ≈ 0` |
|---|---|---|
| world, `drive` off | orbit | free-look from a fixed point |
| world, `drive` on | drivable orbit | fly |
| bot | follow | POV |

Zoom slides continuously between third and first person on the anchored row. `drive` is an explicit
toggle (`G`), **deliberately not** derived from distance — WASD ownership was an explicit mode gate
before, and making it a function of zoom would have been a hidden mode keyed on a continuous
parameter. Scrolling in while unanchored puts the eye at the focus without taking WASD off the dummy.

**Eye blend.** `eyeBlendFor(distance)` is 1 at 0 m and 0 past `EYE_EXIT` (0.9 m). Two things ride it:
the anchor point lerps from the capsule point to the comfort-smoothed head eye, and the bot's turn
carries the user's angles by a *delta* scaled by `eyeBlend * povFollowWeight` (default 0.9). Carrying
a delta rather than storing a bot-relative offset is what keeps the transition continuous — at blend
0 the bot's turning does nothing, at blend 1 with weight 1 the view is locked to its aim, and the
user's free-look offset survives either way. `updatePovBodyHiding` hides the anchored bot's own body
under 0.45 m (the weapon rig stays visible, which reads as a proper first-person view); the old hard
POV cut never needed this because the interior of the head was never on screen.

**Auto-recenter is off by default.** The old 900 ms timed pull back to the bot's aim is now
`cameraRecenterDecay` (0 = off), so a free-look offset persists until you recenter explicitly.

**Occlusion** keeps `bot-camera-control.js` unchanged (`chooseOcclusionCandidate`,
`stepOcclusionMemory`, `dampAlpha`, `dampAngle`, still covered by `test-bot-camera-control.mjs`).
The caller now probes six `(yaw, lift)` offsets rather than direction vectors, and applies the result
as a **transient distance ceiling** (`cameraOcclusionLimit`, folded into `resolveCameraPose`'s
`maxDistance` clamp). It never writes `cam`, which is what the momentum window used to defend
against. Still default-off pending browser tuning.

**Constraints.** Pitch clamps symmetrically at ±85° (`PITCH_LIMIT`), replacing `minPolarAngle 0.08` /
`maxPolarAngle π×0.485` — low ground-level angles are reachable now. Ground contact is a soft push
(`groundHeight + 0.25`) applied to the pose, so a valley camera can still look up. `cam.distance` is
stored **unclamped** and clamped only at apply time against the map-derived ceiling, so shrinking and
regrowing a map restores the user's zoom instead of eating it. Zoom is log-scaled via
`d = 0.6·(eᶻ − 1)` — proportional at range, sub-proportional near the eye so the last notch lands
exactly on 0.

**Input.** OrbitControls is gone. One pointer handler (LMB rotate, shift/middle/right pan, wheel
zoom) replaces four canvas listeners plus the three OrbitControls intent-scrapers, and engages
pointer lock past a 4 px drag so a long traverse needs one grab. Click-to-follow tests
`camInput.dragDistance` because pointer lock freezes `clientX/Y`. Move speed is deliberately **not**
on `ctrl+wheel` — browsers deliver trackpad pinch that way. **Known regression:** OrbitControls
provided all touch handling; there is none now. Accepted for a desktop harness.

Also fixed here: the global `dummyKeys` keydown is guarded on `document.activeElement`, so typing
`w` in the state-record textarea no longer walks the dummy.

**Slots** store `captureIntent(cam)` plus the toggles. Legacy slots migrate — `followDirection` is
converted with `yawPitchFromDirection`, `followDistance`/`followFocusOffset`/`fov` are carried over,
and `povRecenter: true` maps to a 2.4 decay rate. The old "restore must come after `setCameraMode`
or `resetFollowFraming` overwrites it" hazard is gone with the code that caused it.

**Merge note.** The work landed in `bot-viewer-v2-camera.html` because `bot-viewer-v2.html` was being
edited concurrently (frame profiler, autoprofile, think stagger). The 3-way merge base is
`versions/bot-viewer-v2-camera-fork-base-20260727-185601.html`; merge with
`git merge-file bot-viewer-v2-camera.html <base> bot-viewer-v2.html`. Camera changes are confined to
the camera blocks, so conflicts should be limited to the animate loop if the other session touched it.

## Team scoreboard (2026-07-26, `bot-score.js` + `bot-viewer-v2.html`)

The v2 harness had no way to read a fight's outcome: the only roster number on screen was
`Remove all bots (N)`, which lumps both sides and counts corpses. `bot-score.js` is the pure,
THREE-free session tally behind a per-team HUD readout — Node-tested in `test-bot-score.mjs`.

**Model.** `createScoreboard(teams)` returns `{ teams: Map<team, rec> }` with
`rec = { spawned, deaths, revives, kills, teamkills, selfKills }`. Unknown teams are created
lazily by `teamStats`, so the tally survives a team key the harness invents later.

| Call | Meaning |
|---|---|
| `recordSpawn(board, team, count, now)` | one wave of spawns; non-numeric/negative counts floor to 0. Stamps the round start, and opens the next round if the last one was decided. |
| `recordKill(board, victimTeam, killerTeam, opts)` | one death on the victim's side, one frag on the killer's — cross-team it's `kills`, same-team `teamkills`, own blast `selfKills` (also a `teamkill`). `killerTeam: null` (world/dummy) credits nobody. `opts = { selfKill, weapon, cause, killerRole, victimRole }` drives the attribution maps; friendly fire is deliberately kept out of them. |
| `recordRevive(board, team)` | a medic stood the bot back up; the death stays on the books |
| `netLosses(rec)` | `deaths - revives`, clamped at 0 — what the side has actually lost right now |
| `finishRound(board, {now, winner, reason})` | closes and archives the live round (newest first, capped at `MAX_ROUNDS`). Counters are **not** zeroed, so the HUD keeps showing the result; the next `recordSpawn` opens a fresh round. A round nobody spawned into is never archived. |
| `decideRoundOutcome(board, aliveByTeam)` | `{winner, reason:'wipe'}` when one engaged side is left, `{winner:null, reason:'mutual'}` when none is, else `null`. Sides that never spawned don't count, so a one-sided sandbox never "ends". |
| `resetScoreboard(board, {keepHistory})` | full wipe including the archive unless `keepHistory` |
| `formatTeamScore` / `formatBreakdownLines` / `formatRoundHeader` / `formatRoundLine` / `formatDuration` | HUD + panel strings; `alive` is passed in, never stored |

The board deliberately holds no alive count — corpse culls and roster splices would desync a
mirrored one, so the viewer counts living actors from `botActors` at draw time.

**Attribution.** Each record also carries four Maps: `byWeapon`, `byCause` (`bullet`/`blast`/
`knife`), `byRole` (killer's role) and `lossesByRole` (victim's role). The equipped weapon is not a
reliable source — a knife hit lands while the rifle is still equipped — so the damage path threads
an explicit `source = {weaponId, cause}`: `applyCombatDamage` → `applyBotDamage` → `killCombatBot`'s
`credit = {killer, weaponId, cause}`. Call sites: `fireBotShot` (`bullet`), `fireBotKnife`
(`knife`), `detonateBlast` (`blast`, killer = the thrower, so posthumous grenade kills still count).

**Per-bot counters.** `createBotActor` initializes `shotsFired` / `hitsLanded` / `kills` / `deaths`
— the same field names the environment viewer's `botPlayers` records use, so the port is a copy.
They're actor-direct with no global mirror, so `commitBotActor`'s explicit field list leaves them
alone. `fireBotShot` bumps `shotsFired` (bullets only — grenade throws are not shots), `creditBotHit`
bumps `hitsLanded` on both damage paths, and `killCombatBot` bumps the victim's `deaths` plus the
killer's `kills` (cross-team, non-self only). These are **roster-scoped, not round-scoped**: corpses
keep theirs until culled and survivors carry theirs across rounds, which is why the panel prints
them under a separate "Roster (current bots, all rounds)" heading.

**Rounds.** `removeAllBots` no longer zeroes the board — it calls `finishRound(reason:'cleared')`, so
clearing the roster (including the auto scene shuffle, which rebuilds without keep-bots) banks the
round instead of silently wiping the tally. `checkRoundOutcome` runs in the animation loop, gated on
`botScoreDirty` (an outcome can only change on a spawn/kill/revive) and skipped entirely while
auto-add is on, since endless waves have no round to decide.

**Frame profiler.** Loading with `?prof=1` extends the fps counter with smoothed per-phase CPU
timings from a `createFrameProfiler` instance (`frame-profiler.js`, shared with env-viewer) wrapping
the animation loop: `sim` (updateAllBots), `body`/`wpn` (instanced flushes), `fx3d` (bot FX pass),
`vis` (visuals.update), `fx` (tracers/bullets/projectiles/effects), `aud`, `ui` (score/debug/DOM
tail), `rnd` (`postFX.renderAsync`). The instance is exposed as `window.__botProf` for scripted
sampling. `?autoprofile=1[&profbots=45]` additionally spawns profbots-per-team, records phases +
a JS self-profile through the round (ends on scoreboard "wins", 3000 frames, or 120 s), and POSTs
the aggregate to `/api/save-stats` as `perf-autoprofile.csv` (JSON) in `research/stats/`.
Measured 2026-07-27, 90 bots, healthy foreground tab: ~37 fps early-fight with sim ≈ 12 ms and
render CPU ≈ 4-5 ms; sim decays to ~1.5 ms as the roster dies. Sim time is spread (sentry FSM,
rig+pose ≈ 7%, physics ≈ 7%, alert scans ≈ 3%), no single hot function — the fps ceiling at high
bot counts is per-bot sim breadth plus three.js scene-graph/render-object overhead.

**Think stagger.** With a big roster, each bot's full decision pass (`updateBotSentry`) runs every
Nth frame in spawn-order cohorts (reusing `scanPhase`), banking dt between turns so rate-based
slews and dt-integrated timers see the same total time; physics/movement/rig (`updateBot`) stay
per-frame and the focused/POV bot always thinks. Mode via the **Think stagger** button (Bot
controls) or `?stagger=auto|1|2|3`; auto = off ≤40 living, /2 ≤80, /3 above. A/B at 90 bots
(perf-autoprofile-3/-4.csv): sim 10-12 ms → 8-9 ms (-25%), avg fps 42.4 → 45.1.

**Rig LOD.** Bots beyond 18 m of the camera re-solve their procedural body + weapon pose every 2nd
frame, beyond 45 m every 4th (spawn-order cohorts, banked dt); physics, capsule, stance weights and
the per-frame markers are untouched, and the followed/POV/debug-focus bot always solves full-rate.
Off-stride frames re-flush the frozen pose, so the only artifact is the visual pose trailing the
capsule by one stride of movement. Toggle: **Rig LOD** button or `?riglod=0`. A/B on the
Test-condition maze at 90 bots (perf-autoprofile-8/-9.csv): sim 5-9.5 ms → 3-5.4 ms (~-40%), avg
fps 31.7 → 34.5; on the small default arena the camera sits inside 18 m so it barely engages.

**Flush LOD, behind-camera cull, distance hide, rbox far-LOD** (2026-08-03, plan:
`docs/superpowers/plans/2026-08-03-bot-fps-perf-plan.md`). Measured cause of the post-soldier fps
drop: draw calls were never the problem (125 `InstancedMesh` buckets cover all five roles at any
bot count), but a bot went from the default rig's 5,068 triangles to 95,500-105,852 — 19x — with
no geometric LOD. Two thirds of that lives in the `rbox` armour primitive, 828 triangles a piece
at the authored `seg=3` against 156 at `seg=1`. Four changes, each independently A/B-able.

**Where the toggles live.** All four are runtime UI controls, not reload-only URL flags. In
`bot-viewer-v2.html` they are buttons in the bot control panel beside **Rig LOD** (Flush LOD,
Behind-camera cull, Body hide, Armour LOD — the last two cycle through distance steps, and Armour
LOD adds a **Global** step after them; see the Phase 3-B section below). In
`environment-viewer-v2.html` they register on the **Perf A/B** panel via `window.perfAB`, and call
through to `GhostRenderer.setBotRenderTuning({flushLod, cullBehind, rboxLod, rboxLodDist})`; the
flags themselves live at module scope in `multiplayer.js` because both viewers share them, and
`getBotRenderTuning()` seeds the panel so it never disagrees with them. The URL params below still
work and still set the initial state — the UI reads them at startup rather than replacing them.
Turning the armour LOD **off** must walk every live body back to full detail, since the per-bot
swap only runs while the flag is on; both viewers' off-paths do this explicitly.

- **Flush LOD** (`?flushlod=0` disables, default on). `flush()` skipped the IK solve on strided
  frames but still ran `group.updateMatrixWorld(true)` over ~170 nodes per bot. Measured in Node
  at 90 bots: 4.5 ms/frame soldier, 9.3 ms/frame armoured, against 0.76/2.0 ms without the walk
  (armoured costs double — its gear-anchor tree is deeper). The caller's hint is now advisory:
  `player-procedural-body.js` keeps its own `_poseDirty`, set by `update()`, `setRagdollPose()`
  and `setVisible()`, and `flush()` walks when EITHER says so. A caller that gets the hint wrong
  can cost frame time but can never render a stale pose. Pinned by `test-body-flush-lod.mjs`.
- **Behind-camera cull** (`?botcull=0` disables, default on). A bot strictly behind the camera
  skips its flush, so it is absent from the immediate-mode pools and never drawn. Strictly behind
  only, not the frustum sides, so a fast turn cannot outrun it; never inside 8 m at any angle;
  never the focus/POV bot. Safe because the body buckets are `castShadow=false`. The IK solve
  still runs on its normal stride, so a spun-round camera never finds a stale pose. In the env
  viewer this needs `getCameraForward` alongside `getCameraPos` on `GhostRenderer`.
- **Distance hide for `bot-viewer-v2.html`** (`?bothide=<m>`, `0` disables, default 240). The env
  viewer has hidden bodies past 240 m for weeks; the harness had no hide at all. No-op in the
  maze, real in open terrain.
- **rbox far-LOD** (`?rboxlod=1` per-distance, **default OFF**; `?rboxlodDist=25`). `gearGeometry`
  takes a `segOverride` that is part of its cache key, so every rbox piece gets a shared `seg=1`
  twin; `setGearLod(0|1)` swaps the placeholders' geometry references. Measured: soldier rifleman
  95,916 → 42,828 tris (55% off), armoured medic 106,216 → 38,344 (64% off). Only rbox swaps —
  lathes, domes and faces keep their authored tessellation. **This changes how bots look** (the
  chamfer highlights flatten), which is why it defaults off; ±2 m hysteresis stops a bot walking
  the threshold from swapping every frame. This mode was A/B'd and **lost** (see the fourth
  measurement below); `?rboxlod=2` (global) is the mode that is expected to pay, and it kept
  the per-distance mode only as the comparison arm.

Also: pool capacity dropped 8192 → 2048 at both construction sites (the heaviest bucket holds 4
instances per bot, so this covers 500+ bots and returns ~48 MB; `stats.dropped` is the guard).

### Sim-phase profiling scaffolding (2026-08-04, `bot-viewer-v2.html`)

Temporary instrumentation, added to find the source of the `sim` spikes by bisection rather than by
guessing. It is diagnostic only and should come out once the cost is fixed.

`?prof=1` now breaks `sim` into `pre` / `sen` / `bot` / `post`, and `sen` (`updateBotSentry`) into
four phases, each of which then reports its own sub-slices:

- **A** perception — target selection (its `sel` slice is *inside* A), LOS, contact and voice.
- **B** alert ring reads and the cover-position choice.
- **C** FSM state resolution and stance.
- **D** the movement handler for the winning state, printed as `D<total>{tail<n> <top-3 states>}`.
  The per-state map is keyed by the `BOT_*` state strings (plus `hold`, `gEvade`, `gThrow`,
  `patrol` for the branches that aren't keyed on `state`); `tail` is the weapon-slot/reload block
  after the dispatch, which every bot pays regardless of state.

Two things to know before reading the numbers:

- `frameProf.record()` **overwrites** per name rather than accumulating, so a per-bot timer would
  report only the last bot. These phases sum by hand into module-level `let`s reset at the top of
  `updateAllBots`, which is also why they are raw last-tick values.
- The HUD reads `frameProf.snapshot(..., { smooth: true })` at `smoothing: 0.1`, so `sim`, `body`
  and `rnd` are lagging EMAs while the hand-summed phases are instantaneous. A sub-phase can
  therefore legitimately read *higher* than its parent on a spike frame — `sen 86.0` under
  `sim 27.9` is the smoothing, not a bug. Compare phases against each other, not against `sim`.

The phases use boundary timestamps rather than wrapped closures because they share locals
(`state`, `alertTier`, `visible`); wrapping would put those out of scope downstream. Every early
`return` inside the function has to close its phase, or that phase silently under-reports — the
`'reposition'` path at the end of A is the one that does this.

#### The `Y` perf-log recorder (2026-08-04)

`Y` starts a take, `Y` again stops it and puts a TSV on the clipboard. Sampled once per frame from
the end of the animation loop (after the `render` await, so `rnd` is that frame's own cost) and
**unsmoothed** — `frameProf.snapshot(PERF_LOG_MAP, {})`, not the HUD's `{ smooth: true }`. An 80 ms
spike is a single frame; the HUD both averages it away and repaints only at 2 Hz, so reading spikes
off it previously meant screen-recording the HUD and OCR'ing the frames. It works with or without
`?prof=1`, since the phase counters always accumulate and `?prof=1` only draws them.

Columns: `t dt cpu gap gpu fps sim pre sen senA sel senB senC senD dTail bot post body wpn fx3d vis
fx aud pnl uiA uiB uiC ui rnd bots dStates draws tris`. `dt` is the interval since the previous frame, `cpu` is
this frame's timed JS, and **`gap` is `dt - cpu`** — GPU execute plus the browser's own render steps,
which nothing inside the loop can observe. `gpu` needs `?prof=1` (it enables `trackTimestamp`, which
is construction-only and so cannot be an in-game toggle) and trails by a frame or two, since
`resolveTimestampsAsync` resolves after the frame that issued it. `dStates` is the `state:ms`
breakdown inside `senD`.

`draws` and `tris` are `renderer.info.render.drawCalls` / `.triangles` — **counts, not milliseconds**,
and they need no `?prof=1`. They cover the whole chain including post passes. The renderer resets
these at the top of the animation loop, *before* the frame callback runs, so reading them after the
render await gives this frame's totals rather than the previous frame's. They exist because `rnd`
is command encoding and encoding cost tracks draw-call count: a change that cuts `rnd` without
cutting `draws` did not win on draw count and is doing something else. They are appended at the end
of the row rather than placed next to `rnd` because `perfLogSummary` indexes rows positionally, so a
mid-row insert would silently re-point every `line()` call. The summary prints them on their own
median/p90/max/**min** line — no "share of frame", which would be meaningless for a count — and
`draws` is added to the worst-5-frames list so a spike can be checked against its draw count.

**`gap` pairs `dt` with the *previous* frame's `cpu`**, and this is not a detail. `dt` is the interval
that ended when the current frame started, so the work inside it belongs to the frame before. The
first version subtracted same-row `cpu`, which put a spike's cost in one row and its consequence in
the next — a 116 ms frame read as `cpu 116.2, dt 16.9` followed by `dt 117.3, gap 101.6`. Negatives
are left signed rather than clamped: the loop is `async`, so the browser can start a frame before the
previous frame's awaited tail finishes, and clamping silently inflated the gap total (in the take
that exposed this, `cpu` and `gap` shares summed to 104.9% instead of 100%). Aggregate *shares*
survived the bug regardless — summing `dt - cpu` telescopes — but per-row gap values did not.

**`gpu` overlaps `cpu`, it does not add to it.** The GPU executes the previous frame's commands while
the current frame records, so a frame is roughly `max(cpu, gpu)` plus serialisation, not their sum.
Reading the two shares as parts of a whole will double-count.

The header also records `devicePixelRatio`, the actual render buffer ratio, MSAA and the shadow
filter (2026-08-04) — see "Perf remediation phases 0-B and 1-B" at the end of this document. Fill
cost scales with the square of the pixel ratio, so takes are only comparable at equal values.

`Y` copies a header, a computed **SUMMARY** block and the full per-frame table; **`Shift+Y` copies
the summary alone**, which is short enough to paste anywhere. The summary carries median/p90/max and
share-of-frame for `dt cpu gap gpu sim sen senC senD body ui rnd`, the `senD` total per state across
the whole take, and the five worst frames by `dt`. Rows are stored as arrays rather than pre-joined
strings precisely so the summary can read the columns back as numbers.

Details that are load-bearing rather than incidental:

- The loop's `dt` is clamped to 50 ms for simulation stability, which would hide exactly the stalls
  this log exists to catch. The row logs an unclamped `frameMs` captured before the clamp.
- The recorder uses **its own `AudioContext`** for the start/stop cue rather than `envAudio`, so the
  cue still fires when the game mixer is muted or its SFX budget is saturated, and never competes
  for a combat voice slot.
- The clipboard staging textarea is positioned off-screen, not `display:none` — a hidden textarea
  cannot be selected, and the selection is the Ctrl/Cmd+C fallback when clipboard permission is
  denied. On a **successful** copy it is explicitly blurred: the keydown listener ignores keys while
  a `TEXTAREA` has focus, so leaving it focused would make the next `Y` (and every other hotkey)
  silently do nothing.
- Rows cap at `PERF_LOG_MAX` (36000, ~10 min at 60 fps) and the header reports how many were
  dropped, so a take left running is bounded and says so rather than truncating silently.

The badge lives in `#hud-bottom` beside the fps counter rather than free-floating in the corner, so
it cannot collide with the right-hand control panel at any panel width. It pulses red while
recording and turns green with the frame count for 3.5 s after the copy.

**First measurement** (2026-08-04, 90-bot open terrain, 20 samples over 9.5 s of a firefight,
OCR'd off a screen recording of the HUD): every spike is in **D**. Its quiet baseline is 0.1-0.8 ms
and it peaks at 80.6 ms — 94% of `sen` on the worst frame — while A stays flat at 0.8-3.3 ms
throughout. Perception and target selection are therefore *not* the bottleneck. C has a smaller,
independent spike (6-9 ms on frames where D is calm) worth its own pass afterwards.

**Second measurement, and a reframing** (2026-08-04, 104 frames / 6.3 s at 44-47 bots, from the `Y`
recorder rather than OCR). Per-frame data says the sim is *not* where the frame goes:

| | median | p90 | max | share of frame |
|---|---|---|---|---|
| `dt` (frame interval) | 58.9 | 78.1 | 109.6 | 100% |
| `cpu` (all timed JS) | 18.6 | 27.6 | 56.9 | **33.8%** |
| **`gap` (`dt - cpu`)** | **39.2** | 54.1 | 82.2 | **66.2%** |
| `sim` | 8.6 | 17.3 | 36.0 | 16.9% |
| `senD` | 1.1 | 10.7 | 29.2 | 6.1% |
| `rnd` | 7.2 | 9.3 | 16.3 | 12.8% |

`cpu` reconciles exactly with the sum of the phase timers (verified per row: `sim + body + wpn +
fx3d + vis + fx + aud + pnl + ui + rnd` = `cpu` to 0.1 ms), so the loop is fully accounted for and
the gap is genuinely outside it — GPU execute, present, and the browser's style/layout/paint steps.
Correlation between `dt` and `cpu` is only **0.42**, so frame time is mostly driven by something the
loop cannot see. Eliminating `senD` entirely would buy about 6% of a frame.

This is why the `gpu` and `gap` columns exist.

**Third measurement, with GPU timestamps** (2026-08-04, 377 frames / 11.0 s at 47 bots, `?prof=1`).
Mean 34.4 fps. Medians: `dt` 26.2, `cpu` 18.9 (**74.7%** of frame time), `gpu` **18.4** (p90 26.9,
max 41.8), `rnd` 8.6, `sim` 7.1, `senD` 0.6.

**CPU and GPU are both at roughly 18-19 ms against a 26 ms frame.** They pipeline, so neither alone
sets the frame time, but 60 fps needs *both* under 16.7 ms — there are two independent ceilings here,
not one. Inside `cpu`, `rnd` (8.6 ms of command encoding) is slightly larger than the entire AI sim
(7.1 ms), so "the bots are slow" was never the whole story.

This take and the second one disagree sharply (34.4 vs 16.5 fps, `cpu` share 74.7% vs 33.8%) and
nothing in the logs explains why. Treat the split between them as unresolved rather than assuming
either is representative.

**`seek` is a hitch generator, not an average-fps cost.** It totals 880 ms (8.0% of all frame time)
against `patrol`'s 168 ms, but median `senD` is 0.6 ms — the cost is entirely in the tail, with
single-frame stalls of 100.3, 68.4 and 64.0 ms. Those are visible freezes and worth fixing for
smoothness, independently of the fps ceilings above.

**Fourth measurement — the armour far-LOD A/B, and it does not work** (2026-08-04, ~46-48 bots,
three of the four cells: no-LOD fight, LOD no-fight, LOD fight).

| | mean fps | `dt` | `cpu` | `gpu` | `sim` | `body` | `rnd` |
|---|---|---|---|---|---|---|---|
| LOD off, fight | 29.4 | 25.5 | 16.2 | **11.3** | 5.6 | 1.2 | 8.1 |
| LOD **on**, fight | 31.9 | 26.7 | 17.3 | **15.7** | 4.8 | 2.1 | 9.2 |
| LOD on, no fight | 46.7 | 17.6 | 15.5 | 7.4 | 4.8 | 1.1 | 8.6 |

(medians; fps is the take mean)

Turning the LOD on **raised** the GPU median (11.3 → 15.7) and raised `body` (1.2 → 2.1) and `rnd`
(8.1 → 9.2). The mechanism is in `body-part-batches.js`: `bucketFor` keys buckets on
`geometry.uuid` and **buckets are never removed** once created. Swapping an rbox piece to its
`seg=1` twin therefore *adds* a bucket rather than replacing one — with both variants live (near
bots full, far bots cheap) the rbox bucket count roughly doubles, `stats.draws = buckets.size` rises
with it, and `beginFrame`/`endFrame` iterate the larger set every frame. Worse, a bucket created
once persists for the session even after every bot returns to full detail. **The LOD trades
triangles for draw calls, and at this bot count the trade loses.** Leave it off (it already
defaults off). Making it pay would mean reusing one bucket per piece with a swappable geometry, not
keying on uuid — a redesign, not a tuning change.

**Superseded in part on 2026-08-04.** Bucket eviction landed in `body-part-batches.js`, and the
diagnosis above was incomplete in one respect: the additive-bucket problem is not only a lifecycle
bug, it is intrinsic to a *per-distance* LOD. While the population is mixed, near bots fill seg=3
buckets and far bots fill seg=1 buckets, so both variants are live by design and no lifecycle can
collapse them. Only a **global** switch replaces one set with the other. That is `?rboxlod=2` — see
the Phase 3-B section below. The verdict on `?rboxlod=1` stands unchanged.

Caveat: the two fights were separate live scenarios, so camera distance and how much screen the bots
filled were not controlled. Read this as "no evidence of benefit, plus a concrete mechanism for
harm", not as a controlled measurement.

**Combat's cost is on the GPU, not in the AI.** The LOD-on pair is clean on the LOD axis, and going
from no-fight to fight moves `dt` 17.6 → 26.7 ms (+9.1). Of that, `gpu` accounts for +8.3 (7.4 →
15.7, a 2.1× rise) and `cpu` for only +1.8. **`sim`'s median is identical at 4.8 ms in both.** So
whatever combat adds to the *render* — muzzle-flash dynamic lights, tracers, impact and blast FX,
ground pools — is where the combat frame rate goes, and the bot AI is not what drops it. The next
A/B should be the existing bot-lighting toggles (dynamic lights / flashlights / ground pools)
measured against `gpu`, not anything in `updateBotSentry`.

**Fifth measurement — bot lights off, and the limit of this A/B method** (2026-08-04, four takes:
three "lights off, no fight" back to back, plus one "lights off, fight").

The three no-fight takes were recorded under *identical* settings, seconds apart:

| take | mean fps | `dt` | `cpu` | `gap` | `gpu` | `rnd` |
|---|---|---|---|---|---|---|
| 1 | 28.9 | 30.9 | 11.8 | 18.9 | 9.3 | 5.3 |
| 2 | **50.0** | 17.0 | 11.7 | **5.8** | 13.4 | 5.1 |
| 3 | 29.8 | 32.7 | 12.3 | 19.2 | 23.9 | 5.4 |

**`cpu` is constant (11.7–12.3) while fps ranges 28.9–50.0.** Every bit of the difference is in `gap`
— 18.9 / 5.8 / 19.2 — which is outside the loop by construction. Run-to-run variance under identical
settings is therefore larger than any code change measured so far, and A/B by comparing separate
free-play recordings has hit its resolution limit. `gpu` is also unstable across these (9.3 / 13.4 /
23.9) because it depends on camera angle and what is on screen, which was not controlled.

Note the `dt` medians: **17.0 in the fast take, 30.9 / 32.7 / 34.1 in the three slow ones**, with
`cpu` unchanged. That is the shape of frame pacing rather than workload — a frame that occasionally
misses the display interval getting held to the next one, so the rate sits at either ~60 or ~30 and
rarely between. Treat that as the leading explanation, not a proven one: the intermediate 24–26 ms
rows in take 3 do not fit a clean 60 Hz ladder, and nothing here identifies the mechanism.

**What the lights toggle actually bought** (comparing against the lights-on no-fight take): `rnd`
8.6 → 5.1–5.4 and `cpu` 15.5 → 11.7–12.3, i.e. **about 3.5 ms of CPU per frame, essentially all of
it in command encoding**. That much is repeatable across all three takes and is a real saving. It
did *not* reliably raise the frame rate, because the frame rate is currently decided by the
pacing/gap term above. If the pacing reading is right, though, a 3.5 ms CPU saving is exactly the
size of margin that decides whether a frame lands inside the interval or misses it — so it may be
worth more than the fps averages suggest.

**Do not read the lights-off *fight* take as a regression.** It shows 24.8 fps and `gpu` 28.0 against
the lights-on fight's 31.9 fps and `gpu` 15.7, but it also ran 46 s against 16.8 s, with the roster
falling from 48 to 38 bots, and it sits inside the same run-to-run spread demonstrated above. There
is no controlled comparison there.

**Method fix before any further A/B:** use the fixed scenario that already exists —
`?autoprofile=1&proflayout=maze` builds a seeded maze (`mazeSeed = 1337`) specifically so runs are
comparable. Free-play takes cannot resolve changes of this size.

**Sixth measurement — smaller maps, and the pacing question settled** (2026-08-04, 697 frames /
15.6 s, ~25 bots, near-continuous fighting). Mean 44.6 fps. Medians: `dt` 18.7, `cpu` 15.6,
**`gap` 2.6**, `gpu` 15.1, `rnd` 7.3, `sim` 4.6, `body` 2.5, `senD` 0.3.

**The frame pacing reading from the fifth measurement is now confirmed rather than inferred.** The
`dt` column clusters hard on two values — long runs of 16.6–16.9 broken by runs of 33.2–33.7 — which
is a 60 Hz vsync ladder: a frame lands on one refresh interval or slips to two. Mean `dt` is 22.4 ms,
which for a 16.7/33.3 mix implies roughly **two thirds of frames at 60 and one third at 30**. That
also explains the fifth measurement retroactively: those three "identical" takes at 28.9 / 50.0 /
29.8 fps were the same workload sitting on the boundary and landing on different sides of it.

**Consequence for optimisation.** `cpu` median 15.6 ms against a 16.7 ms budget means the CPU is
sitting *right on the line*. Savings there are worth far more than their size suggests, because each
frame pushed under the interval jumps from 33.3 ms to 16.7 ms rather than improving smoothly. Inside
that 15.6 ms: **`rnd` 7.3 (47%)**, `sim` 4.6 (29%), `body` 2.5 (16%). Command encoding is the single
biggest item and the obvious first target — which is also the mechanism that made the armour far-LOD
backfire, since it added buckets.

**`gap` collapsed from ~19 ms to 2.6 ms**, so the uncontrolled machine-state variance that made the
fifth measurement unusable is absent in this configuration. A/B is viable again here.

**Smaller maps all but eliminated the seek stalls.** `senD` max is **14.4 ms against 124.4 ms** in
the large-map fight, p90 1.3 vs 9.9, and `seek` totals 252 ms (1.6% of frame time) against 3635 ms
(7.9%). That fits what `seek` is — investigating a lost target — since a small map means short
searches. The 100 ms hitches documented above are gone in this configuration.

Caveat: the roster also halved (48 → ~25 bots) in the same change, so map size and bot count are
confounded here. The seek result is very likely map size (path length is what `seek` scales with);
the `gap` and `cpu` results could be either.

Two other things the same data says:

- **Even idle, the CPU is at the 60 fps limit.** `cpu` median out of combat is 15.5 ms against a
  16.7 ms budget, and `rnd` (8.6 ms of command encoding) is more than half of it. Draw-call count is
  the shared lever behind both `rnd` and the LOD result above.
- **The `seek` stalls are untouched by any of this** — `senD` max is 130.9 ms (LOD on, fight) and
  114.3 ms (LOD off, fight), and out of combat `senD` never exceeds 1.0 ms. They are a combat-only
  hitch and still need their own fix.

Within `senD` the spiking states are **`seek`** (max 28.3 ms) and **`patrol`** (max 14.3 ms) — not
`flee`, which was the earlier suspicion. `senD > 5 ms` on 31% of frames. Both handlers re-plan
whenever `pathMode` no longer matches, and most branches (AIM, FIRE, COVER_HOLD, hold, alert) clear
`pathMode = null`, so a state flicker forces a fresh plan; there is no cap on how many bots may plan
in one tick. `choosePatrolResumeGoal` in particular runs an **unbounded** `floodFill(navGrid, start,
{})`. That is the shape of the cost, not yet a measured cause.

**Wall instancing.** Walls and covers render as one `InstancedMesh` per material
(`instancedBoxes`: shared unit `BoxGeometry`, per-instance scale+translate matrices,
`boxTransformOnTerrain` keeps the hillside-sinking math), replacing one Mesh+BoxGeometry per
rectangle — perf-sweep finding #8. `applyLayout`'s teardown exempts the shared `UNIT_BOX` from
geometry disposal and calls `mesh.dispose()` to free the instance buffer; floor and catch slabs
stay plain meshes (`box()`). Collision required a matching change in `map-collision.js`:
`collectWorldTriangles` now expands InstancedMesh instances (`matrixWorld × instanceMatrix`) into
world triangles — without it the collider would bake a single unit box. The autoprofile payload
records `mapTris/mapWalls/mapCovers` as an invariant check ((walls+covers+floor)×12 must equal
`mapTris`). A/B on the Test-condition maze at 90 bots (perf-autoprofile-9/-10.csv): render submit
13-25 ms → 3.7-5.3 ms, avg fps 34.5 → 51.9.

The autoprofile harness accepts `&proflayout=maze` (Test-condition maze, fixed seed, no dummy
swarm) and `&profclose=1` (tab closes itself after uploading).

**HUD.** `#score` sits in `#hud-bottom` next to the fps counter: a round header plus one row per
team, label tinted with that team's `BOT_TEAM_DEFS.facing` colour. `flushBotScore(now)` writes the
DOM only when `botScoreDirty` is set (spawn / kill / revive / reset / visibility toggle, plus a 1 Hz
tick while a round is live so the clock moves) — corpse culls do not dirty it, since a culled corpse
was already counted dead. Panel section **Scoreboard**: the HUD toggle, **Reset scoreboard**, and a
read-only textarea with the live round's per-team breakdown, roster shooting totals (shots / hits /
accuracy / top bot as `kills-deaths`) and the banked rounds. The visibility flag round-trips through
the `ui` save slot as `debug.scoreboard`.

**Frame cost.** Nothing here runs per frame beyond two guard checks. The per-bot counters live only
on the actor and are never mirrored into the bind/commit field list, so the per-frame actor copy is
untouched. `countLivingByTeam(now)` is the only O(roster) work; it is memoized for the frame the
outcome check and the flush share, and `checkRoundOutcome` invalidates that memo on entry so it can
never outlive its frame. `renderScorePanel` — which sorts the four breakdown maps, scans the roster
per team and writes the textarea — is skipped outright unless its section is actually expanded
(`scorePanelOpen()`, a class check, not a layout read); expanding the section or the panel, or
restoring a `ui` slot, sets `botScoreDirty` so it repaints on the next frame. The 1 Hz clock tick is
suppressed when both the HUD and the panel section are hidden, so an unwatched scoreboard costs
nothing at all. The textarea is only written when the text actually changed.

## Explosives in the v2 harness (2026-07-26, `bot-viewer-v2.html`)

Explosive weapons in `bot-viewer-v2.html` are real flying bodies with travel time, and grenades are a
secondary every bot carries. Three pure modules own the math; the viewer owns the raycasts, the
meshes, the wind-up animation and the FSM hooks.

| File | Owns | Pure? |
|---|---|---|
| `bot-projectiles.js` | ballistic aiming, arc sampling, the live-projectile list, ids, trail cadence, detonation callbacks | pure, Node-tested (`test-bot-projectiles.mjs`) |
| `entity-types/combat-projectile.js` | the flight sim itself: gravity, bounce, fuse, life, fizzle, swept raycast, detonation | pure (shared with the game) |
| `bot-grenade.js` | "is a nade worth it, and where do I aim it" + live-grenade evade urgency | pure, Node-tested (`test-bot-grenade.mjs`) |
| `bot-viewer-v2.html` | `projectileRaycast`, pooled projectile meshes, arc clearance checks, the wind-up/release swap, evade pathing, panel | glue, covered by `test-bot-explosives.mjs` |

`bot-projectiles.js` also exports `livingGrenadeThreat(list, point, extraRadius)` (nearest live
grenade-like projectile whose blast covers a point). It is tested but **has no production caller** —
the viewer builds `_grenadeThreats` once per frame instead and feeds `bot-grenade.js`'s `grenadeEvade`,
which also returns urgency. Treat it as available, not as the wired path.

### Flying projectiles

`fireBotShot` early-returns into `launchBotProjectile(weapon, origin, dir, attackerId, velocity?)`
whenever `weapon.mode === 'projectile' && weapon.projectile` — no hitscan, no tracer, no bullet mesh,
and no blast until the thing actually arrives. The old hitscan-then-detonate-at-the-impact-point path
is still in the file but is now reachable only by a projectile-mode weapon that carries **no**
`projectile` spec.

- **`createProjectileManager({ raycast, terrainHeight, onDetonate, onTrail, trailIntervalS })`** wraps
  `CombatProjectileEntity`. It intercepts the entity's `'explosion'` spawn through its own `ctx.spawn`,
  so every detonation route (raycast hit, terrain contact, fuse, end-of-life airburst) funnels into one
  `onDetonate(point, proj)` — and a **fizzle raises nothing**, which is exactly how an RPG that hits
  nothing before `life` (19 s) stays silent. `spawn()` stamps `bp<n>` ids plus `weaponId` /
  `throwerActorId`; `update(dt)` steps the list backwards and splices the dead.
- **`projectileRaycast(from, to, radius, ownerId)`** is the viewer's swept-segment test: `mapCollider`
  first, then every living bot/dummy capsule via `rayCapsuleHit`, nearest hit wins, **thrower
  excluded** (`target.id === ownerId`) so a rocket does not detonate on the barrel it left. It runs
  per projectile per frame, so two things are deliberate: the roster is built **once per frame** by
  `refreshProjectileTargets()` (called from `updateProjectiles`, never from the raycast), and each
  capsule is filled into the shared `_projCap` scratch by `projCapsuleInto` rather than allocated by
  `combatCapsuleFor` (which clones two `Vector3`s per call). A **sphere broadphase** —
  `|centre − from|² > (range + r + h/2)²` → skip — precedes `rayCapsuleHit`; since every point of a
  capsule lies within `r + h/2` of its centre, it is provably conservative, and a ~1 m swept step
  rejects nearly the whole roster. `test-bot-explosives.mjs` fuzzes 20 000 ray/capsule pairs to pin
  that it never drops a real hit.
- **`updateProjectiles(dt)`** returns immediately when nothing is in the air, then steps the manager
  and draws immediate-mode: one pooled sphere mesh per live projectile (`rocketMat` for `rpg`,
  `grenadeMat` otherwise, reassigned only on an actual change — a swap rebuilds the WebGPU pipeline),
  leftovers hidden. Nothing is hand-released, so a fizzling rocket that never calls back cannot leak
  a mesh.
- **`onDetonate`** resolves the weapon from `proj.weaponId` and calls the same `detonateBlast` the old
  instant path used, so damage falloff, ragdoll knockback, squad-alert reports and heal-retreat
  triggers are unchanged.
- **`onTrail`** fires every `trailIntervalS` (0.035 s) of flight and pushes one `smoke_puff` effect —
  fatter/longer-lived for a rocket (life 1.2 s, size 0.3, opacity 0.34) than for a tumbling grenade
  (0.55 s, 0.14, 0.16).

**`arc` and `gravity` are the two easy ways to break a launch.** `CombatProjectileEntity.create()`
adds the spec's `arc` on top of `dir * speed` and defaults `gravity` to **0**, so `launchBotProjectile`
passes `arc: [0, 0, 0]` (the solved velocity already contains the loft — re-applying the spec's
`[0, 4.8, 0]` throws the grenade over the target) and passes `gravity: spec.gravity ?? 0` explicitly
(omitting it makes a grenade fly flat forever). `test-bot-explosives.mjs` pins both.

### Blast radius is authored per weapon

`blastRadiusFor(weapon)` reads `weapon.projectile.blastRadius` from `weapons.js` — **grenade 15 m,
rpg 8.2 m** — and `BOT_BLAST_RADIUS` (6) survives only as the fallback for a weapon with no spec.
These radii are deliberately **not** scaled down to arena size, even though the maze is ~40 m across:
the harness is there to test the game's real numbers, and a 15 m grenade in a 40 m box is a large part
of why the throw gates below behave the way they do.

### Grenade secondary

Every actor spawns with `grenades: throwCountFor(botGrenadeSettings)` (2), plus `lastGrenadeAt`,
`grenadeThrow` (the pending wind-up) and `grenadeEvadeAt`. Stock is independent of the primary's ammo
and is **not** restored by a reload — the panel's **Restock grenades** button is the only refill.

- **`refreshGrenadeThreats()`** runs once per frame from `updateAllBots` and rebuilds the shared
  `_grenadeThreats` list (position, `blastRadius`, `fuseRemainingS`) from the live projectiles, so N
  bots share one scan instead of each walking the projectile list.
- **`grenadeCandidate(now)`** checks the cheap gates first (grenades enabled, stock left, the
  `GRENADE_DECIDE_INTERVAL_MS` 500 ms per-bot throttle, per-bot `cooldownMs`, team-wide
  `teamCooldownMs` from `teamLastGrenadeAt`) and only then snapshots the roster into
  `_grenadeEnemies` / `_grenadeAllies` and calls `chooseGrenadeThrow`. Between the cooldowns and the
  snapshot sits a **range/staleness pre-gate** against the target's own XZ (or `lastKnownTarget`),
  slackened by the largest the aim lead can be (`aimLeadS × run speed`), so it can only reject throws
  `chooseGrenadeThrow` would also reject. It exists because the self veto — `blastRadius ×
  selfRadiusScale`, 18.75 m at the authored blast — rejects the overwhelming majority of frames, and
  without it every one of those paid for a full roster scan. It returns
  `{ aimPoint, score, reason, targetId }` or null; `reason` is `cluster` (visible), `cover` (a memory
  younger than half `blindThrowMaxAgeMs` — "he just ducked") or `blind` (older, still in window).
- **`solveGrenadeThrow(fromVec, aimPoint)`** does the two corrections that make a lob land where it was
  aimed. (1) It **drops the aim to ground level** under the target (`groundHeight(x,z) + 0.15`) —
  `bot-grenade.js` carries the target's body Y through, and a lob solved to chest height sails past and
  lands metres long. (2) It then **lifts the aim** by `0.5 * gravity * (1/60) * flightS` and re-solves,
  because the entity's semi-implicit Euler integrator decrements `vy` before integrating and so falls
  systematically short of the analytic parabola. Finally it walks `sampleArcPoints(..., 6, flightS)`
  and rejects the throw if any leg **except the last** hits `mapCollider` — the last leg is allowed to
  end in a wall or the floor, which is what landing means.
- **`updateGrenadeThrow(dt, now)`** owns the bot for the whole `GRENADE_WINDUP_MS` (420 ms): velocity
  zeroed, path dropped, facing the aim point, then `releaseGrenade` **re-solves from the hand** at
  release (the decision was made from the body centre), spends a grenade, stamps both cooldowns, plays
  `grenade_throw` and logs the event. During the wind-up the equipped-weapon line swaps to `'grenade'`
  (`setBotEquippedWeapon(activeBotActor.grenadeThrow ? 'grenade' : …)`) — the same seam the knife
  secondary uses, so the rendered model matches the animation.
- **`updateGrenadeEvade(dt, now)`** runs `grenadeEvade` against the shared threat list (reading the
  bot's own position through the `grenadeBodyInto` out-param, since this runs per bot per frame);
  anything inside a live grenade's own `blastRadius` is evaded, replanned every
  `GRENADE_EVADE_REPLAN_MS` (400 ms) or when the path empties, and always at run speed. Urgency (0–1)
  is `0.6 ×` fuse pressure + `0.4 ×` proximity, normalised against a 2.0 s nominal fuse. The
  destination comes from `grenadeEvadeGoal` (see below); on arriving at one the blast cannot see, the
  bot **stops and holds until the grenade detonates**, facing directly away from it.
- **Evade hysteresis (`evadeExitScale`, default 1.25).** `grenadeEvade` takes a fourth argument, the
  threat id the caller is already evading; that grenade keeps its hold out to `blastRadius ×
  evadeExitScale` while every other threat still engages at the plain `blastRadius`. Without it the
  ring was a hard cutoff, and since the FSM keeps resolving *underneath* the evade override, the frame
  a bot crossed the edge the combat branch walked it straight back in — a boundary chatter that read
  as marching in place. Short fuses hid it; a long fuse makes it run for seconds. `urgency` and the
  reported `radius` still measure against the true damage ring, so the widened band reads as zero
  proximity rather than negative. A scale of 1 restores the old behaviour; values below 1 are clamped.
- **`grenadeEvadeGoal(fromP, blastRadius, actor)`** is the whole destination decision — one scored cell
  scan that replaced both the old distance-only search and a short-lived corner-map cover search.
  Scoring distance-from-blast alone produced two wrong behaviours, and the corner version could not fix
  the second one *in principle*: **a corner anchor is a boundary feature by definition**, so "get
  properly inside cover" was unreachable no matter how the anchors were scored.
  - *Running into a firing lane.* A cell can be clear of the grenade and sit squarely in the enemy's
    sights. Cells the bot's current threat can see (seen position if visible, else `lastKnownTarget` —
    the same memory the rest of the FSM steers on) take `EVADE_EXPOSURE_PENALTY` (7).
  - *Parking on the edge.* Being merely past the shadow boundary is a bad place to stand: it looks
    unnatural and re-exposes the bot the moment anything moves. Hidden cells take a flat
    `EVADE_SHADOW_BONUS` (9) **plus** `EVADE_DEPTH_BONUS` (2.6) per probe direction that is also hidden
    — four probes at `EVADE_PROBE_CELLS` (3 cells ≈ 1.5 m), so 0–4. `canSee` is fail-closed on
    unwalkable cells, so a probe landing in a wall counts as shadow, which is what we want: a wall stops
    a blast as well as a shadow does. The same edge logic applies to the blast ring itself —
    `EVADE_EDGE_PENALTY` (1.2/m) for any shortfall inside `blastRadius + EVADE_CLEAR_MARGIN` (2.5 m),
    so bots aim to end up comfortably clear rather than barely.
  - *Everyone picking the same cell.* `evadeJitter` adds up to `EVADE_NOISE` (1.5), hashed from a
    per-bot `evadeSeed` and the cell index, so it is **stable across replans** (no frame-to-frame
    chatter) but differs per bot. At 1.5 it can only shuffle cells of near-equal quality.
  - Ranking check at the shipped weights: deep shadow 14.95 > deep shadow but exposed 7.95 > shadow
    edge 4.55 > open ground 1.1 > open and exposed −5.9. Deep shadow beats the boundary by 10.4, far
    outside jitter's reach. Note blast safety outranks bullet safety while a grenade is live — an
    exposed deep-shadow cell still beats an unexposed boundary cell, deliberately.
  - Scans a `±EVADE_SEARCH_CELLS` (12) box at `EVADE_SEARCH_STRIDE` 2, so ~169 candidates at 1 m
    granularity rather than 625 at 0.5 m. The own cell is skipped so "evade" can never resolve to
    standing still. Returns `{x, z, hidden}`; `hidden` is what gates the hold and the overlay colour.
  - Reachability: `lineWalkable` first (one trace, the common case, single waypoint) and
    `requestPathBudgeted` only when the winner is behind geometry — which is exactly when a path solve
    is worth paying for. Still no `floodFill`: a Dijkstra per bot per replan while a grenade is airborne
    is real work even with pooled buffers.
  - Degrades safely: no `visField` or an off-grid blast cell means no shadow term and no exposure term,
    leaving the old distance-and-travel behaviour, which is what open terrain gets.
- **`updateGrenadeDebug(now)`** draws the **Grenade debug** overlay (Debug overlays card, off by default,
  saved as `debug.grenadeDebug`). Immediate mode: four pools are re-indexed each frame and the leftovers
  hidden, so nothing is ever hand-released. It runs in the `uiB` pass, after the sim, while
  `_grenadeThreats` still holds this frame's list. What it shows, and which change each part proves:
  - **Solid red ring** at `blastRadius` and **dashed amber ring** at `blastRadius × evadeExitScale`,
    per live grenade. The gap between them is the hysteresis band; the dashed ring is suppressed at a
    scale of 1. Watching a bot cross the red ring and keep going is the boundary-chatter fix.
  - **Blue cells** = the blast shadow, the nav cells `visField` says the grenade cannot see, i.e.
    exactly the set `grenadeEvadeGoal` scores a shadow bonus for. Baked into one `InstancedMesh` (cap 4096) and
    rebaked only when the grenade changes cell, since a scan of a 15 m ring is thousands of `canSee`
    calls. Only the first live grenade gets one.
  - **Green line + ring** from an evading bot to its chosen cover anchor, brightening once it is
    within `GRENADE_COVER_REACH` and holding. **Amber line + ring** means no corner was found and the
    bot's chosen cell is in the open instead — which distinguishes "the cover scoring is off" from
    "there is no cover here", the one thing the behaviour alone cannot tell you. Watching the green
    ring land well inside the blue rather than on its rim is the shadow-depth term working.
  - **Bar above a bot** = the post-blast aim settle: grey while the acquisition is torn down, amber and
    draining while the recognition delay runs, gone once it is shooting again.
  The fallback waypoint is stashed as `actor.grenadeGoalDbg` purely for this overlay; everything else
  is read back from live sim state, so the overlay cannot drift from the behaviour it explains.
- **Blast occlusion (`blastExposure`, panel toggle "Blast blocked by walls", default on).** A blast used
  to be a pure radius test — geometry did nothing, which among other things made the grenade-evade
  cover hold pointless: the bot reached its corner and ate the damage anyway. It now casts **three rays
  from the blast centre to fractions 0.15 / 0.5 / 0.9 up the victim's own capsule** (shins, torso,
  head) and scales damage by the fraction unblocked, so a low wall is partial cover rather than
  immunity — a single centre-to-centre ray would make a crouching bot either invulnerable or
  unprotected, and the head-exposed case is a known bug family here. Exposure 0 drops the victim from
  the list entirely (no damage, no hit FX, no squad report). Rays stop 5 cm short of the sample so the
  victim's own surface is never its own cover. Cost is 3 raycasts per victim per blast, and blasts are
  rare. Applies to bots and WASD dummies alike; `mapCollider` being null (open terrain, pre-layout)
  degrades to full exposure. Turning it off restores the old damage-through-walls behaviour exactly.
  - **The veto rings run through the same test** (2026-08-07 — they briefly did not; see below).
    `chooseGrenadeThrow` takes an optional `input.blastReaches(point, entry)` hook, injected the way
    `combat-projectile` takes `ctx.raycast`, so `bot-grenade.js` stays THREE-free and Node-testable.
    `blastReachesBody` in the viewer wires it to **`blastExposure` itself**, not a reimplementation —
    that identity is the point: the throw decision and the detonation cannot disagree about a wall, and
    turning the toggle off reverts both together (`blastExposure` returns 1). It is tested against the
    ground under the aim point, matching `solveGrenadeThrow`, rather than the target's chest, which
    sits a metre higher and clears low walls the grenade will not.
    - All three rings use it: sheltered enemies stop counting toward the cluster and the score,
      sheltered allies stop vetoing, and a sheltered thrower may throw short — the last one is what
      cooking a grenade around a corner looks like. `minRange` still holds the floor, so occlusion
      waives the self *ring*, not the range gate.
    - Consulted only for bodies that already passed the distance test, so ray cost scales with what is
      inside the ring rather than with the roster. `grenadeCandidate`'s cheap self pre-gate had to
      become occlusion-aware too, or it would have vetoed every short throw before the real gate saw it
      and silently undone this.
    - Omitting the hook restores pure-radius behaviour exactly, which is what every existing caller and
      test gets. A hook returning a non-boolean reads as unreachable, never as a pass.
    - **For ~a day this was inconsistent**, and it cut both ways, which is worth remembering as the
      general shape of the bug: an ally behind a wall falsely vetoed a safe throw (bots passed up
      grenades), *and* enemies behind a wall falsely counted toward the cluster (bots spent grenades
      and a 9 s cooldown to hit one target). Any time a decision model approximates a damage model,
      expect errors in both directions, not just the cautious one.
- **`settleAfterBlast(center, radius, now)`**, called at the end of `detonateBlast`, tears down the aim
  acquisition (`aimContactAt`/`aimReadyAt`/`aimTargetId`, stamping `aimResetAt`) of every living bot
  within `radius × BLAST_SETTLE_SCALE` (1.35 — wide enough to catch bots that just cleared the ring).
  That routes the "don't resume fire on the frame the smoke appears" delay through the existing A10
  recognition-delay system and its sliders instead of adding an FSM state. Bots outside that reach are
  untouched.
**Dispatch order.** Both hook the FSM chain in `updateBotSentry` ahead of the `holding` branch:
`updateGrenadeEvade` → `updateGrenadeThrow` → hold → `AIM`/`FIRE`/… A live grenade outranks
everything (and clears any pending wind-up — mid-throw is not the moment to stand still); a wind-up
outranks everything but that. A throw is never *started* from `BOT_FLEE` or `BOT_HEAL`.

**The veto rings, not the range sliders, are what actually bind.** With the authored 15 m grenade,
`selfRadiusScale` 1.25 means a bot refuses any aim point closer than **18.75 m** — well past the 8 m
`minRange` slider — and `friendlyRadiusScale` 1.15 vetoes any throw with a squadmate inside **17.25 m**
of the aim point, which in a squad fight is most of them. If grenades appear to never be thrown, those
two sliders are the first place to look, not `minRange`/`maxRange`. Both are now panel sliders (0 on
the friendly scale disables that check outright). `test-bot-grenade.mjs` has a dedicated case for this.

### Blast FX and audio

The 8-sphere blast pool is gone; blasts and rocket trails draw through the shared
`effect-renderer.js` (`createEffectRenderer({ THREE, scene, terrainHeight: groundHeight })`). The
viewer keeps a plain `botEffects` list of wire objects — `pushEffect(kind, p, life, extra)` stamps an
`fx<n>` id and an `expireAt`, `updateEffects(now)` drops expired entries and calls `sync` — because
the renderer is stateless. `EFFECT_LIST_CAP` (900, oldest-first eviction) exists because rocket trail
puffs, not blasts, dominate the list. Two list-hygiene details matter at that size: `updateEffects`
compacts in a **single write-index pass** (expired effects cluster at the *front*, so per-item
`splice` degraded to an O(n) shift each), and over-cap eviction drops an **eighth of the cap at
once** rather than one entry per push, which would otherwise re-shift the whole array on every
`pushEffect`. `spawnBlastFx(center, radius, fxScale)` still calls `visuals.flash` for every blast
regardless of the FX toggle (a real dynamic light is what sells an explosion on the dark themes); the
**drawn** size is `radius × fxScale` and the light reach follows that rather than the damage ring
(`distance: min(60, shown * 3.2)`), so the puff can be dialled off the ring without the light lying. Parameters and the
caller rules for `smoke_puff` are in `docs/subsystems/fx.md`; the procedural SFX fallback is in
`docs/subsystems/audio.md`.

### Hit FX: blood and sparks (2026-08-04)

Every damaging hit now spawns the same four-kind stack `damage-simulator.html` uses, through the
`effectRenderer` the harness was already running — **no new imports**. `spawnHitBloodFx(point, normal)`
(next to `spawnBlastFx`) pushes `hit_spark`, `blood_spray` (28 droplets), `blood_stain` at the wound,
and `blood_splatter` on the ground. `smoke_puff` is deliberately omitted: v2 already spends its
`EFFECT_LIST_CAP` budget on rocket-trail puffs.

Three things are easy to get wrong here and are handled explicitly:

- **Colour must be passed.** `pushEffect` writes a raw wire object and never runs
  `EffectEntity.create()`, so `entity-types/effect.js`'s blood-kind colour default never applies and
  `effect-renderer.js` would fall back to the warm muzzle colour — blood would render orange. The
  viewer keeps its own `BLOOD_RED = [0.4, 0.02, 0.03]` mirroring that file and passes it on all three
  blood kinds.
- **Three damage sites, not one.** `applyBotDamage` (bullets + knife on bots), the dummy-target branch
  of `applyCombatDamage`, and `detonateBlast`'s victim loop. The last one never calls `applyBotDamage`
  or `emitBotDamaged`, which is why subscribing to `onBotDamaged` was rejected — it would miss blast
  and dummy hits entirely.
- **The spray direction.** `hitNormalFor(target, hitPoint, explicit, sourcePoint)` follows
  `combat.js`'s own capsule convention: horizontal, outward from the target's axis. Only bullets carry
  a real normal (threaded through as `source.normal` from `resolveHitscan`). Every other path passes a
  hit point taken from the **victim's own vertical capsule**, so `dx`/`dz` there are *exactly* zero and
  the naive form degenerates to `[0,1,0]` — blood spraying straight up on every knife kill. Hence the
  second reference: the knife's attacker (`source.attacker ?? bot`) or the blast's centre
  (`source.origin`, added to the blast-on-dummy call).

A **Blood FX** toggle sits under **Body & ragdoll** (not Explosives — it fires on bullets and knives
too), saved as `bloodFx` in the `bots` slot and restored through `boolOr`, so older slots keep loading.

**The decal cap moved right after this shipped.** It was a hardcoded 160 quads shared by
`blood_stain` + `blood_splatter`, drawn as 160 separate `Mesh` + `MeshBasicMaterial` pairs — at 11
decals per hit that saturated around 14 concurrent hits, and because they were `DoubleSide` with no
`forceSinglePass` a full pool encoded up to 320 transparent draws. That pool is now one instanced
draw with a `maxBloodDecals` option defaulting to 512 (see `docs/subsystems/fx.md`), so the harness
uses the wire-default splatter count of 10 and the practical ceiling is ~46 concurrent hits.

This mattered more than a perf tidy-up: bleedout drips and growing blood pools are *persistent*
decal producers, so a single bot bleeding for 20 s would have blown a 160 cap on its own.

### Panel + tests

An **Explosives** section carries three toggles (**Grenades**, **Blast FX**, **Synth SFX fallback**),
a **Restock grenades** button (refills every living bot and clears both cooldowns) and 10 sliders
bound live to `botGrenadeSettings`: carried count, per-bot and squad cooldowns, min/max range, the two
veto scales, cluster weight, blind-throw max age, and min visible enemies. (`blindThrowChance` and
`aimLeadS` are settings without sliders.) All of it round-trips through the `bots` save slot.

### Tuning the ordnance itself (2026-07-28)

`botGrenadeSettings` decides *whether* to throw; **`botGrenadeBlast`** is what the grenade then does,
seeded at load from the authored `weapons.js` spec and driven by five more sliders:

| Slider | Key | Default | Reaches |
|---|---|---|---|
| Explode delay (s) | `fuseS` | 2.0 | the projectile's `fuse` at launch |
| Delay randomness (± s) | `fuseJitterS` | 0 | rolled per throw, clamped ≥ 0.15 s |
| Area of impact (m) | `blastRadius` | 15 | `blastRadiusFor` → damage ring, spawn state, **and the veto rings** |
| Damage (centre) | `damage` | 95 | `blastDamageFor` → falloff to 0 at the edge |
| Explosion effect size (×) | `fxScale` | 1 | `spawnBlastFx` only — visual, never damage |

Three things that make this more than five variables:

- **The overrides are keyed on the weapon** (`isTunedGrenade`), not applied globally, so the RPG keeps
  its authored 8.2 m / 110 damage — one tunable explosive is enough to tune *against*, and the
  technical role's `closeRange` stays meaningful.
- **The fuse had to be made reachable at all** — see "The delay slider needed a sim fix" below. Two
  parts: `life` is stretched with the fuse (`life = max(spec.life, fuse + GRENADE_FUSE_TAIL_S)`,
  because life expiry also detonates and the authored life of 2.15 s barely clears the authored 2 s
  fuse), and the grenade is launched with `cooks: true` so contact stops it instead of setting it off.
- **Radius is one number everywhere.** `grenadeCandidate` now reads `blastRadiusFor(getWeapon('grenade'))`
  rather than the frozen spec, so widening the blast automatically widens the self/friendly veto rings
  (at `selfRadiusScale` 1.25 a 22 m blast means bots won't throw closer than 27.5 m) and the
  `refreshGrenadeThreats` evade rings, which read the radius off the projectile.

Changes apply to grenades thrown from then on; anything already in the air keeps the fuse and radius
it launched with. One knob deliberately not wired: `bot-grenade.js` normalises evade urgency against
a nominal 2 s fuse, so a very long fuse makes every airborne grenade read as maximally urgent — that
only affects which of several live grenades a bot runs from first.

### The delay slider needed a sim fix (`entity-types/combat-projectile.js`)

The first version of the delay slider did nothing above ~1 s, and the authored 2 s fuse had never
applied either. `update()` checked contact **before** the fuse, and a thrown grenade lands and spends
its 2-bounce budget in under a second — so the terrain branch detonated it on the third ground
contact and step 3 was unreachable. Measured on flat ground with a 20 m throw: fuses of 2 s, 4 s and
6 s all detonated at **0.95 s**, the moment it stopped bouncing.

Two changes, both in the shared entity:

- **The fuse is checked first**, before the contact branches. A cook timer only consulted while the
  grenade is airborne is not a timer. (Side effect for every caller: when a fuse expires on the same
  tick as an impact, the fuse now wins and the blast lands at the pre-step position — one frame of
  travel earlier than before.)
- **`cooks` (opt-in, default off)** — contact *stops* a grenade instead of detonating it. Out of
  bounces it comes to rest (`sim.resting`, velocity zeroed, only fuse/life can end it); a wall or
  body hit damps it (`CONTACT_DAMP`) and cancels any climb so it drops to the floor and rests there.
  `bot-viewer-v2.html` passes `cooks: isTunedGrenade(weapon)`, so **the RPG and `environment-viewer`'s
  grenades keep their contact behaviour** — flipping the game over to cook timers is a separate call.

`test-bot-explosives.mjs` pins all of it: 2 s / 5 s / 0.4 s fuses detonate on time through a full
throw, a wall bonk keeps cooking, and an *uncooked* grenade still detonates on contact under 1.5 s so
the game path stays covered.

One consequence worth knowing: a grenade now lies on the ground for the rest of its fuse, which is
what makes `grenadeEvade` meaningful — bots have the whole cook to run out of the ring, instead of
the blast landing on contact.

`test-bot-explosives.mjs` is the integration test for the glue that lives inline in the viewer and so
has no module test of its own: a decided throw lands near where the decision aimed, the spec's `arc`
is not re-applied on top of a solved velocity, `gravity` is passed explicitly, a rocket flies straight
and trails smoke on cadence, a rocket that hits nothing fizzles without a blast, evade urgency rises
as the fuse runs out, and the clearance sampler brackets the real flight.

## Per-bot stance (2026-07-26, `bot-stance.js` + `bot-viewer-v2.html`)

Stance used to be **one global cosmetic object** — `botStance = {crouch, prone, run}`, shared by every
bot on the map, driven only by three UI buttons, and read in exactly two places: the procedural body's
pose channels and a run-speed multiplier. Crouch and prone changed nothing about LOS, hit profile or
accuracy, and running was *free* — `moveSpeed01` normalised speed against a denominator that already
contained the run multiplier, so a sprinting bot read the same 1.0 as a walking one. That global is
gone. Stance is now a **per-bot channel derived from the resolved FSM state**, with real consequences:
movement speed, weapon spread, turn rate, and (opt-in) capsule height.

Stance is deliberately **not new FSM states**. The `bot-activity.js` ladder already carries 14 rungs
and three commitment latches, and folding posture into it would multiply every rung. It is an
orthogonal channel computed immediately *after* the ladder resolves — which is also why the whole
thing can be switched off, or force-overridden from the panel, without touching the ladder at all.

### `bot-stance.js` (new) — pure, THREE-free, zero-dependency, tested in `test-bot-stance.mjs` (197 checks)

| Export | Purpose |
|---|---|
| `STANCE_STAND` / `STANCE_CROUCH` / `STANCE_PRONE` / `STANCE_RUN` | the four postures, plain strings |
| `STANCE_DEFAULTS` | the tunables below, and the source of `botStanceSettings` |
| `chooseBotStance(state, ctx, settings)` | the decision table — resolved FSM state + context → desired stance |
| `stepStanceTransition(st, desired, now, settings)` | hysteresis latch; returns the **effective** stance |
| `stanceSpeedFactor` / `stanceSpreadScale` / `stanceHeightScale` / `stanceTurnRateScale` | the four consequence multipliers |
| `resolveStanceOverride(override, autoStance)` | UI force-override; `'auto'` (or anything unrecognised) defers to the derived value |

FSM states are compared as **plain strings**, which is what lets the module import nothing — not even
the state constants. Anything unrecognised reads as STAND, never as a low stance, and so does a
missing/junk posture passed back in.

### The decision table

`chooseBotStance` in priority order. First match wins.

| # | Condition | Stance |
|---|---|---|
| 1 | `enabled: false` (master gate) | STAND |
| 2 | `forcedCrouch` — rifleman self-heal or the brief pack-pickup dip | CROUCH |
| 3 | `heal` / `medic-tend` | STAND if a **medic** (sidearm stays up), else CROUCH (two hands on the pack) |
| 4 | commanded hold (`holding`, the S13 hold channel) | PRONE if `proneEnabled` **and** `holdElapsedMs >= proneMinHoldMs`, else CROUCH |
| 5 | `cover-hold`, `peekPhase === 'in'` | CROUCH — tucked behind the corner |
| 6 | `cover-hold`, `peekExposed` | STAND |
| 7 | `cover-hold`, otherwise | CROUCH |
| 8 | `alert` (or `alertHeld`) | CROUCH |
| 9 | `pursue` / `flee` / `cover-move` / `medic-move` / `knife` | RUN |
| 10 | `aim` / `fire` | CROUCH when the target is visible and **beyond** `aimCrouchDistance` (`- aimCrouchHysteresisM` if already crouched), else STAND |
| 11 | `seek` | CROUCH within `seekCrouchRadius` (`+ seekCrouchHysteresisM` if already crouched) of the last-known point, else STAND |
| — | `patrol` / anything unrecognised | STAND |

Two details that are easy to get backwards. A **missing** last-known point reads as `Infinity`, not 0
— `Number(null)` is a finite zero, which would land inside `seekCrouchRadius` and crouch every
searching bot that has no memory to search toward. And the aim rung crouches at **long** range (the
gate is `targetDistance >= aimCrouchDistance`): a bot steadies the shot for the far target and stays
mobile in a close-quarters fight. (The panel tooltip on that slider currently phrases it the other way
round; the code is the `>=` above.)

### Crouch/stand dead-band hysteresis (2026-08-03)

Rungs 10 and 11 are bare thresholds, and `stepStanceTransition`'s exit cost only damps flicker faster
than `crouchUpMs` (220 ms) — a bot whose real motion hovers at the boundary for longer than that (a
very plausible strafe or search-orbit timescale) still visibly toggles crouch/stand, flipping speed
and spread every cycle. Fixed with dead-band hysteresis, not a longer timer: entering crouch keeps the
existing threshold; a bot that is **already crouched** only stands back up once it clears a further
margin (`aimCrouchHysteresisM` = 1.5 m, `seekCrouchHysteresisM` = 1 m). `chooseBotStance` takes a new
ctx field, `alreadyCrouched` (default `false`, so omitting it reproduces the old single-threshold
behavior exactly — no existing caller or test needed to change). This is a separate mechanism from the
transition-latch exit cost above: hysteresis stops the *desired* signal itself from flapping at the
boundary; the exit cost still separately charges a bot for actually completing a stand-up once its
desire is genuinely settled.

`chooseBotStance` now has three live call sites — `bot-viewer-v2.html`, `bot-viewer-v2-camera.html`
(the camera fork), and `environment-viewer-v2.html` (the env-viewer port) — each with its own decision
seam. All three now set `sc.alreadyCrouched = <actor>.stanceLatch?.stance === STANCE_CROUCH`, reading
from the **latch**, not the actor's post-override `.stance` field, so a UI force-override can't feed
back into the auto hysteresis. Sliders (`seekCrouchHysteresisM`, `aimCrouchHysteresisM`) were added to
the two files with a Stance panel (`bot-viewer-v2.html`, `bot-viewer-v2-camera.html`);
`environment-viewer-v2.html` has no Stance panel yet, so it gets the module fix with no new UI, same as
its current auto-only state for every other stance tunable.

Found in passing, not fixed (out of scope for this change): the `crouchUpMs` panel tooltip still
describes the wrong direction (says "dropping into a crouch"; the cost is actually for *leaving*
crouch), and `bot-viewer-v2-camera.html`'s decision seam never sets `sc.evading`, so grenade-evade dash
stance doesn't fire there.

### Why leaving a low stance costs time

`stepStanceTransition` charges an exit cost to *leave* a low stance — `standUpMs` (700 ms) out of
prone, `crouchUpMs` (220 ms) out of crouch — while dropping *into* a lower stance is instant. This is
not flavour: posture without an exit cost is degenerate. Prone is strictly dominant for any stationary
bot (least spread, smallest silhouette), so with a free stand-up the entire roster flops down on the
first quiet frame and never gets back up. Making prone a commitment is the only thing that keeps the
choice interesting.

Mechanically it is a mutating latch over a caller-owned `{stance, changedAt, blockedUntil}` object
(fields created if absent), safe to call every frame with a null or fresh latch. While the cost is
still owed it returns the **old** stance, so every consumer downstream sees one consistent value.
Re-choosing the current stance cancels a pending exit, so a bot that thinks better of standing up
doesn't keep a stale clock running.

### Tunables (`STANCE_DEFAULTS`, mirrored into `botStanceSettings`)

| Key | Default | Effect |
|---|---|---|
| `enabled` | `true` | Master gate. Off → every bot reads STAND and no latch is kept. |
| `proneEnabled` | `false` | Whether the decider may pick prone at all. **Opt-in.** |
| `heightEnabled` | `true` | Scale the LOS/hit capsule with the pose. Scale is **derived from the rig**, not from the two fallback constants below. |
| `crouchSpeedFactor` | `0.55` | Move speed while crouched, as a fraction of walking. |
| `proneSpeedFactor` | `0.30` | Move speed while prone. |
| `crouchSpreadScale` | `0.75` | Multiplier on the `bot-aim.js` spread cone while crouched. |
| `proneSpreadScale` | `0.50` | Same, prone — the steadiest posture. |
| `runSpreadScale` | `1.25` | Accuracy penalty for sprinting. |
| `crouchHeightScale` | `0.68` | **Fallback only** — used when a bot has no procedural body to measure. |
| `proneHeightScale` | `0.35` | Same, prone. Both are superseded by `stanceCapsuleHeightScale` whenever a rig exists. |
| `crouchBlendRate` | `9` | Exponential 1/s easing into a crouch pose (~180 ms to settle). |
| `proneBlendRate` | `5` | Same for prone — slower, it is a bigger move. |
| `crouchTurnRateScale` | `0.80` | Yaw-slew multiplier while crouched. |
| `proneTurnRateScale` | `0.35` | Yaw-slew multiplier while prone — a prone bot cannot whip around. |
| `standUpMs` | `700` | Exit cost leaving prone. |
| `crouchUpMs` | `220` | Exit cost leaving crouch. |
| `proneMinHoldMs` | `1200` | Time a bot must ALREADY have been held before prone is justified. |
| `seekCrouchRadius` | `4` | m from the last-known point inside which a searching bot crouches. |
| `aimCrouchDistance` | `8` | m: **beyond** this a stationary aiming bot crouches to steady the shot. |
| `seekCrouchHysteresisM` | `1` | m: extra distance beyond `seekCrouchRadius` a crouched bot must clear before standing back up. |
| `aimCrouchHysteresisM` | `1.5` | m: extra distance short of `aimCrouchDistance` a crouched bot must clear before standing back up. |

RUN does not have its own speed factor — `stanceSpeedFactor` takes the caller's existing
`botMovementSettings.runMultiplier`, so the run slider that was already in the panel stays the one
source of truth. Settings are read **per key with a per-call fallback** (`opt()`), never by merging a
copy: these run per bot per frame and the viewer mutates the live object from sliders, so neither
allocating a merge nor caching one is acceptable.

### Seams in `bot-viewer-v2.html`

| Seam | What it does |
|---|---|
| `botStanceSettings` + `BOT_STANCE_OVERRIDES` / `botStanceOverride` | replaces the deleted `botStance` global |
| decision seam in `updateBotSentry`, between `stepAlertHold` and `botState = state` | the one point where the final state is known and nothing has consumed it yet: auto pick → latch → override → stamped on the actor. The S13 `holding` check is hoisted above it (a pinned bot is stationary, which is exactly what the decider wants to know). Fills a reused `_stanceCtx` scratch — one ctx for all bots, every field overwritten. |
| `currentBotMoveSpeed()` → `stanceSpeedFactor` | every movement path already funnels through it, so nothing else had to change |
| `botShotSpreadRad(now)` (new shared helper) → `stanceSpreadScale` | used by **both** `describeBotAim` and the live fire path |
| `botTurnRateRadS()` → `stanceTurnRateScale` | applied at the `faceAimDirection` / `faceMovement` / `faceMovementScanning` slews |
| `applyStanceHeight(actor)`, called from `updateBot` | scales the capsule's straight section only, feet fixed, always from a once-captured `standHeight` |
| pose seam in `updateBot` | `st.crouch` / `st.prone` from the resolved stance; `st.height` reads the **standing** height so a shrunk capsule doesn't double up on the rig's own crouch channel |
| panel | cycling `stanceOverrideBtn` (Auto → Stand → Crouch → Prone → Run) plus a **Stance** section: 3 toggles + 14 sliders, wired into `botTuneSyncers` |
| readout | the state row now reads `state · stance`, and the aim row appends the live stance after the cone |
| save/load | the `bots` slot group carries `stance` + `stanceOverride` |

Per-actor fields (`stance`, `stanceLatch`, `stanceForcedCrouch`, `standHeight`) are set in
`createBotActor` and cleared by `resetActorMapState`. They are deliberately **actor-direct** — *not*
added to `bindBotActor` / `commitBotActor` — matching the newer convention already used by the A10 aim
state, `holdUntil` and `medicAction`. Nothing round-trips through the register bank, so stance
structurally cannot leak from one bot to the next.

### The running-accuracy bug this fixed in passing

`botShotSpreadRad` exists because the readout and the live fire path must never disagree, but folding
the two together exposed a real bug: `moveSpeed01` was normalised against `currentBotMoveSpeed()`, a
denominator that *already carried the run multiplier*. A sprinting bot therefore computed exactly the
same `1.0` as a walking one, and `moveSpreadDeg` cost a runner nothing. It now normalises against the
run **ceiling** (`BOT_MOVE_SPEED × runMultiplier`), so running actually throws the shot. The old
denominator is kept on the `enabled: false` path, bug and all, so "stance off" reproduces the previous
numbers exactly.

### Capsule height is measured off the rig, not guessed

The first cut hardcoded `crouchHeightScale: 0.68` / `proneHeightScale: 0.35`. Both were wrong, and
wrong in different ways, so they are now **derived** in `stanceCapsuleHeightScale(stance, rig,
standTotalHeight)` from the same numbers `player-procedural-body.js` poses with:

```
standing head top = height * (pelvisHeightRatio + 0.48)
crouch  head top  = height * (pelvisHeightRatio * (1 - pelvisDrop) + 0.48 * (1 - headDrop))
crouch  scale     = crouch top / standing top          -> ~0.615 at pelvisHeightRatio 0.58
prone   scale     = (hipHeight + headUp) / standing top -> ABSOLUTE, so it varies with bot height
```

Three things the guesses got wrong:

- **Crouch was ~10% too tall** (0.68 vs the rig's ~0.615).
- **`pelvisHeightRatio` is speed-adaptive** (0.58 walking → 0.52 running), so no constant can be
  right; the viewer reads `body.gait.cfg.pelvisHeightRatio` live.
- **Prone is an absolute height**, not a ratio — the rig parks the hip at `proneCfg.hipHeight` 0.25 m
  regardless of bot size, so a fixed fraction is wrong *in principle*. A taller bot must scale down
  further.

`RIG_HEAD_TOP_FACTOR` (0.48) mirrors the rig's head placement; keep it in sync if that changes.
Junk rig config clamps to a sane band rather than inverting or erasing a bot.

**One real geometric limit:** a vertical capsule cannot be shorter than its own two caps, so with
`radius` 0.3 the prone capsule bottoms out at 0.6 m total rather than the rig's ~0.41 m. Prone is
therefore *approximately* right, not exactly. Shrinking `radius` too would fix it but would also
narrow collision, and a prone body is wider, not thinner — so the height floors instead.

### Pose and capsule share one eased weight

The rig accepts fractional `crouch`/`prone` (0..1) but the viewer used to feed it a bare 0/1, so
posture popped. `stepStanceWeights(w, stance, dt)` now eases a per-actor `{crouch01, prone01}` pair,
and **both** the pose channels and the capsule scale read that same pair —
`blendStanceHeightScale(crouchScale, proneScale, crouch01, prone01)`, using the rig's own precedence
(prone dominates, crouch takes what is left). The silhouette and the hitbox therefore cannot disagree
mid-blend, which was the whole reason the height seam looked untrustworthy.

A fully upright bot short-circuits both derived scales rather than blending toward 1 — that is the
common case every frame.

The debug capsule mesh shares one memoized `botCapsuleGeometryFor` geometry across the roster, so it
tracks the shrink via `mesh.scale.y` instead of a per-bot geometry rebuild.

### Defaults, and what "off" means

`enabled: true`, `proneEnabled: false`, `heightEnabled: true`. With `enabled: false` + override
`Auto` the system is provably neutral: every multiplier returns 1, no latch is kept, the pose weights
resolve from `stanceForcedCrouch` so the legacy heal/pack-pickup dip still reads, and the spread
denominator reverts — i.e. the old "always stand, never run" baseline, reproduced through one code
path rather than a branch at every call site. Prone stays opt-in because it is the posture most likely
to look wrong before QA. A slot saved before this shipped carried `{crouch, prone, run}` booleans —
`assignKnown` drops those keys and an unknown override degrades to Auto, so an old slot can't wedge
the roster into one posture.

**Perf:** audited by measurement, not inspection. The decision path is ~210 ns/bot-frame and the
height+weights path ~228 ns, so ~440 ns total — 17.5 µs/frame at 40 bots, ~0.1% of a 60 fps budget,
allocation-free in steady state. Two lessons worth keeping: a `{...DEFAULTS, ...settings}` merge that
**escapes** its function is ~17× slower than a per-key accessor (hence `opt()` here), while the
same-looking non-escaping merge in `bot-aim.js` is JIT-elided and genuinely fine — measure before
"fixing" one. Routing both spread call sites through `botShotSpreadRad` also *removed* a per-frame and
a per-shot object literal.

### When prone actually fires (and why it never did at first)

Prone needs **all** of: `proneEnabled` on, a live commanded hold, the bot **already** held for
`proneMinHoldMs` (1200 ms), and an FSM state of PATROL / SEEK / PURSUE (the `holding` predicate skips
AIM/FIRE/COVER_HOLD, which are stationary already and never yield to a hold).

The two hold sources are both in `commandBotHold`:

- **`'overwatch'`** — the squad-push base-of-fire element, while the assault element bounds forward.
- **`'heal'`** — a medic pinning its patient for the duration of the channel.

The first cut gated on `holdRemainingMs` and was therefore **unreachable**: both issuers grant a
`500 ms` lease that is *re-granted every frame* (`PUSH_HOLD_LEASE_MS`, `healHoldLeaseMs`), so remaining
time is pinned near 500 and can never clear a 1200 ms bar. The gate now reads elapsed time via a
`holdSince` stamp that resets whenever a hold lapses, so a sustained pin accumulates across lease
renewals while a one-frame stop does not.

Consequence worth knowing: a bot actively engaging a visible target resolves to AIM/FIRE, so it
crouches (the range rung) rather than going prone. Prone is for sustained overwatch and being
medic-pinned, not for active gunfights.

**Status:** Node-tested (`test-bot-stance.mjs`, 171 checks; the full 112-file suite is green).
**Browser QA pending** — needs `python serve.py` and a real browser. What to watch: bots should crouch
to search and to shoot at range, sprint on pursue/flee/cover-move, and take a visible beat to stand
back up; posture should ease rather than snap; a crouched bot's LOS and hit profile should visibly
drop; nobody should end up permanently flat once `Allow prone` is on; and `Stance system: Off` should
look identical to the pre-stance build.

## Terrain generation overhaul (2026-07-27, `bot-terrain.js` + `bot-viewer-v2.html` + `bot-viewer-visuals.js`)

Five changes to the ground generator, done under a hard "no performance regression" constraint.
The measured baseline and the yardstick for all of it is **`node bench-terrain.mjs [preset]`**
(`open-field` / `maze` / `huge` / `eroded`), which times the real rebuild stages and reports the
resulting relief, mean slope and unwalkable share so a "faster" field that quietly flattened the
map can't pass unnoticed.

### Baking the height field — the change that paid for the rest

`createTerrainField(params, flatten, opts)` now takes an optional `opts.bounds`. Given one, the
field is evaluated once onto a `Float32Array` grid (`fieldCell`, default 0.5 m, capped by
`maxFieldSegments`) and every later query is a bilinear read.

This is not a cache, it is the enabling move. The profile showed **~80% of a rebuild was
re-evaluating the same noise for central differences**: `slopeAt` and `normalAt` each cost 4
`heightAt` calls, once per nav cell and once per mesh vertex. On the 172 m preset:

| stage | analytic | baked |
|---|---|---|
| nav walk-slope gate | 112 ms | 9 ms |
| mesh arrays | 54 ms | 5 ms |
| nav height grid | 20 ms | 2 ms |
| field construction | 0.5 ms | 27 ms |
| **total rebuild** | **187 ms** | **43 ms** |

`heightAt` itself goes 137 ns to 17 ns, which matters beyond rebuilds: it runs per frame for
decals, ragdoll settling, the fly camera's ground clamp and the FX layer.

Without `opts.bounds` the field stays purely analytic and behaves exactly as before — that path is
what the pre-existing tests exercise, and none of them changed. Queries outside the baked window
(`BAKE_MARGIN` = 4 m past the layout) fall back to the analytic field rather than clamping to the
border row, so an off-map query is still correct. **Erosion and placed features live only on the
grid**, so ground beyond that margin is un-eroded; nothing gameplay-relevant is out there.

The viewer bakes over `activeBounds` and skips baking before the first layout, when bounds are
still degenerate. Three redundant `rebuildTerrainField()` calls were removed at the same time
(`applyTerrainChange`, the open-field preset, slot load) — `applyLayout` already rebuilds the field
once the layout's pads are known, and at 27 ms a double bake is no longer free.

### The pad blend was putting walls in the ground

Not planned work; found by the bake-fidelity check, which flagged a 377 mm discrepancy. The cause
was real and pre-existing: pads used **strongest-pad-wins**, an argmax over pad weights, so the
ground jumped the instant the winner changed. Three overlapping cover pads at levels -0.83 /
-0.19 / -0.08 produced a **753 mm step across 5 cm — a local slope of 15.1**, which the nav gate
then correctly marked unwalkable. Map-wide the 103-pad preset had 20 such wall-points.

The fix keeps the guarantee that mattered (a pad with no close rival levels its own footprint
*exactly*) while making the surface continuous: pads within `PAD_BLEND_BAND` (0.2) of the strongest
weight blend in, smoothstepped from zero at the band edge. The result is a short ramp between
levels instead of a cliff. Wall-points went 20 to 1, worst slope 7.5 to 2.7, and the baked field has
none at all. Continuity is asserted by measurement, not eyeball: sampling 4x finer must shrink the
worst jump ~4x (a step would not shrink at all).

### Landform vocabulary

- **`landform`** — `rolling` (the original band), `ridged` (`1-2|n|`) or `billowy` (`2|n|-1`). The
  two folded forms are exact mirrors of each other and carry ~2x the median slope of their parent:
  the crease along the fBm zero-crossings is the point. All three stay inside the amplitude bound
  and keep both hills and hollows.
- **`warpAmp` / `warpScale`** — domain warp. Pushes the sample point sideways before reading the
  hills, turning round fBm blobs into sinuous ridges and hooked valleys.
- **`terraceSteps` / `terraceSharpness`** — quantizes the band into benches with an eased tread.
  Monotonic, so a terraced hill keeps its parent's up/down structure and simply gains flat ground
  to stand and fight on. At 6 steps it produces >3x the flat ground of the same hill untraced,
  while drifting less than half `hillAmp` from it.

### Killing the corduroy

The old ripple band summed two sines on **hardcoded axes** (`0.8,0.6` and `-0.6,0.8`), so every map
ever generated wore the same diagonal corduroy, and it read as a rendering artifact rather than as
ground. `rippleMode: 'isotropic'` (now the default) replaces it with a 2-octave fBm that has no
preferred direction — verified by binning gradient directions and requiring the busiest bin to sit
under 1.6x the mean. `'dunes'` keeps directional corrugation for when you want it, on an angle
drawn from the seed. The direction is per-map and constant, deliberately: a position-varying
rotation makes the gradient blow up far from the origin.

### Erosion (`erosionAmp`, default 0 = off)

Rain one unit on every cell, walk cells high to low passing each one's water to its steepest
downhill neighbour, then cut each cell by `sqrt(drainage area)` — the standard hydraulic scaling,
and what makes the output read as a branching landscape rather than noise with dents in it.
Ordering is a counting sort on quantised height; a comparator sort of 130k cells costs more than
every other bake stage combined.

Depth is measured against a cell that drains only itself, so `erosionAmp` is the depth of a full
channel *below unchannelled ground* and ridges are cut by exactly nothing (19% of cells).
`erosionSmooth` then widens the cut over two channel-weighted passes, turning a one-cell V that
nothing can walk into a valley floor.

**`erosionFillPits` (default on) is what makes it useful.** Rolling fBm is full of closed basins,
and without depression filling the first pit swallows the drainage:

| | components | largest run | span |
|---|---|---|---|
| no fill | 221 | 216 cells | 28 m |
| **filled** | 203 | **1118 cells** | **75 m of a 120 m map** |

Priority-flood from the border produces a routing surface where every cell drains off-map; the
carve still cuts the *real* surface, so basins stay basins and simply gain an outlet gully. Cost of
the fill is ~3 ms. Erosion total is ~11 ms on the 172 m preset.

Known characteristic: pads resolve **after** erosion, deliberately — a drainage channel must not cut
through the ground a spawn or building slab stands on.

### Placed landmarks (`featureCount`, default 0 = off)

Noise gives you ground, not a landmark. `plateau` / `ravine` / `escarpment` are stamped into the
grid **before** erosion, so drainage answers to them — water runs off a plateau rim and along a
ravine floor, which is what stops them reading as objects dropped onto the terrain. Plateaus are
levelled to one height (flat ground worth holding, with a rim); escarpments taper to nothing past
their ends, so the wall has flanks. Placement is rejection-sampled with a separation gap.

Overlapping features are capped at `1.5 x featureHeight` of compound displacement — two escarpments
were otherwise stacking to a 5.16 m wall from a 2.5 m setting.

### Terrain shading (`shadeRock` / `shadeChannel` / `shadeAltitude`)

Without this, every landform and channel above renders as one flat shade and the player cannot read
the ground. `buildTerrainMeshArrays` now emits a `colors` attribute — a **multiplier** on the
material's own colour, so the map's theme still owns the palette and the shading only says which
ground is which: steep faces lighten toward exposed rock, drainage channels darken, and altitude
gets a tonal spread. Setting all three to 0 emits flat white, i.e. the material untouched.

`bot-viewer-visuals.js` gained a fourth map material, `materials.terrain`: the same themed colour
and vignette as `floor`, multiplied by `attribute('color','vec3')`. It is a separate material
rather than a flag on `floorMat` because the flat slab and the catch slab carry no colour attribute
and must keep rendering exactly as they do. It shares the theme's uniform objects, so themes drive
it for free; `applyFloorFinish` mirrors the floor's metalness/roughness onto it.

### What this does to the map the bots see

Real pipeline (field to nav grid to visibility to corner map), 172 m map, seed 7:

| preset | relief | walkable | crest cover | route |
|---|---|---|---|---|
| flat (terrain off) | 0 m | 100% | 0 | 313 cells to 2 smoothed |
| big open field (shipped) | 5.6 m | 100% | 8 | 349 to 4 |
| **eroded highlands (new preset)** | 9.7 m | 93.7% | **379** | 386 to 11 |

47x the terrain cover, and the cross-map route survives. The 6.3% unwalkable is ravine walls,
escarpment faces and plateau rims — intended, and it does not disconnect the map.

That 379 nearly saturated `CREST_DEFAULTS.maxRecords`, which was 400. Raised to 800, and
`buildCornerMap` now returns **`crestCapped`** so truncation can't pass for "that's all the cover
there is" — the viewer's `[rebuild <label>]` line prints `[CREST CAP HIT -- terrain cover truncated]`.

### Cost, stated plainly

Every stage is opt-in and defaults to off or neutral, so the shipped presets are unchanged except
for the ripple band and the pad-blend fix. With **everything** on (`bench-terrain.mjs eroded`) the
172 m rebuild is **83 ms against a 187 ms pre-bake baseline** — the maximum-feature terrain still
builds faster than the old plain terrain did. The full eroded-highlands pipeline including nav,
visibility and cover bakes is ~200 ms, of which ~100 ms is the field; erosion, features, warp and
terracing are all in that number.

Items 8 and 9 of the original improvement list (LOD, chunked rebuild) were **not** implemented as
such. The bake made a full rebuild 3-4x cheaper, which removed the pressure that motivated them;
if map sizes grow past ~300 m they are the next thing to reach for.

### Panel

The Terrain section grew four subsections — **Landform**, **Erosion**, **Landmarks** and **Terrain
shading** — plus a **Preset: eroded highlands** button that sets a coherent combination and rerolls
the seed. Every new parameter lives in `terrainSettings`, so the save/load slots pick them up with
no slot-code change (`assignKnown` type-checks, and `normalizeTerrainParams` falls back on an
unknown `landform`/`rippleMode`/`featureMix` from a stale slot).

**Status:** Node-tested — `test-bot-terrain.mjs` is 37 checks (was 17), and the nav/cover/structure
suites are green. **Browser QA pending:** what to watch is the shading (channels should read as
darker routes, steep faces as lighter rock), the eroded-highlands preset, whether the ~100 ms field
bake is noticeable on a slider release, and that the seven themes still tint the terrain.

## Bots standing still in valleys — terrain connectivity (2026-07-27, `bot-terrain.js` + `nav-grid.js` + `bot-viewer-v2.html`)

Reported as "sometimes bots sit still in valleys not doing anything". It was not sometimes and it
was not a bot bug: the terrain overhaul above was fragmenting the map.

### What was actually happening

Erosion channels, ravine walls and escarpment faces all produce ground that clears the slope gate
but is fenced off from the rest of the map. Measured on the eroded-highlands preset, every seed
tried did it:

| seed | walkable | components | largest stranded region |
|---|---|---|---|
| 7 | 93.7% | 6 | 2846 cells = **711 m2** |
| 21 | 93.0% | 7 | 2706 cells = 677 m2 |
| 99 | 94.0% | 3 | 2372 cells **and** 1921 cells |

`findBotSpawnPoint`'s fallback picks any walkable cell, so bots spawned inside these islands. Every
goal handler in the viewer answers an empty path the same way — `bot.velocity.x = 0; bot.velocity.z = 0`
— and `findPath` returns nothing for a goal in another component. So the bot stood there.

Patrol made it look deliberate: `updatePatrolMovement` advanced to the next patrol point each time
a search came back empty, but at one index per `REPLAN_COOLDOWN_MS`, and the next point was just as
unreachable. The bot stood still, cycling goals, forever.

It was also expensive. A* to a goal in another component is its worst case — it expands **every**
reachable cell before admitting defeat, 0.6 ms on this map, re-run every 300 ms per stuck bot.

### Region labels in `nav-grid.js`

`buildNavGrid` now labels connected components and stores `regions` (Int32Array, -1 = blocked),
`regionSizes` and `mainRegion`. The flood fill uses A*'s own connectivity **including the corner
rule**, so a label can never promise a route the search would refuse — two blocks touching only at
a diagonal stay two regions.

- `regionAt(grid, x, z, maxRadius)` — region of the nearest walkable cell, or -1.
- `reachable(grid, a, b)` — O(1) "could a path exist at all".
- `findPath` early-outs to `null` when the endpoints differ. Unreachable-goal searches drop from
  **0.6 ms to ~0.001 ms**, measured, and the test asserts it stays a lookup.

The label pass costs ~1-3 ms once per layout bake, against a recurring saving of ~2 ms/s **per
stuck bot**.

### Carved passes in `bot-terrain.js` (`connectPasses`, default on)

Labels make the failure cheap; they don't make the map good. 700 m2 of unreachable ground is a
generator bug. So after erosion and features — and before pads resolve — `connectGrid` checks that
the walkable ground is one piece and cuts a pass into every stranding worth reaching, the way a
road crosses a ridge.

1. **Mask** — cells whose central-difference slope beats `maxSlope`, restricted to the layout
   bounds (the baked grid's 4 m margin is off-map ground no nav cell covers; a mask that routed
   through it would call a map connected that the nav grid still splits).
2. **Label** — 8-connected components, corner rule included.
3. **Route** — Dijkstra from each stranding, free inside a component and priced by excess steepness
   outside one, so it finds the thinnest, gentlest part of the barrier. Bounded by
   `PASS_SEARCH_CAP`; a stranding with no plausible crossing is left alone and reported.
4. **Carve** — grade the route to `PASS_GRADE_SAFETY x maxSlope` and widen it into a corridor with
   a flat floor and a tapered rim.
5. **Verify** — re-label and repeat, up to `PASS_MAX_ROUNDS`. The reported numbers are measured
   after the last cut, not before it. `field.connectivity` carries the report.

### Three things this got wrong first, all found by measuring

**Grading passes to the limit doesn't work.** The carve writes grid *nodes*; the nav gate samples
cell *centres*, half a field cell away. Passes built exactly to `maxSlope` failed there. Fixed by
grading to half the limit and giving the corridor a flat floor rather than a knife-edge crown.

**A cut with steep sides manufactures new strandings.** At a rim taper of 0.5 m a 3 m cut leaves a
wall of its own, and the sliver of ground pinched between that wall and the old hillside is a fresh
stranding — the carve spent every later round chasing damage it had just done. The rim now tapers
in proportion to the cut depth, at `PASS_RIM_GRADE` (< 1) times the slope limit, so **the sides of
a pass are themselves walkable** and a pass cannot fence anything off.

**Lowering-only was the wrong rule.** Two strandings survived every round on seeds 21 and 42 —
12-16 cells, 1.4 m from walkable ground, routes found and carved every single round with no effect.
They were not ringed by ridges. They were ringed by a one-cell **erosion gully**: a hole, not a
wall. Lowering a hole achieves nothing. Passes now cut *and* fill, with fill capped at
`PASS_FILL_MAX` (1.5 m) above the lower end so a long route can't pave a ravine into a causeway.
The cap only ever lowers the profile, so it stays grade-limited. That one change took convergence
from "3-6 rounds, 1-2 strandings left" to **1-2 rounds, zero**.

### Result

Full pipeline (field to nav grid to visibility to corner map), 172 m map, five seeds:

| | passes off | passes on |
|---|---|---|
| stranded regions >= 12 cells | 2-6 per seed | **0 on every seed** |
| main region's share of walkable ground | 96.1-99.8% | **100%** |
| relief | — | unchanged to 2 dp |
| walkable share | — | unchanged (+0.1% at most) |
| crest cover records | 372-441 | within 1% either way |
| cross-map route length | — | identical |

The map is connected and is otherwise the same map. Passes move **0.25-0.8% of the grid**.

### Cost

- **Fully walkable ground: +0.3 ms.** The mask counts blocked cells and, finding none, returns
  before labelling — one component by construction. The shipped open-field preset is exactly that
  case, and a test asserts the bail-out (`rounds === 0`), because it would otherwise be paying ~4 ms
  for a question whose answer can't be no.
- **Eroded highlands: +19 ms** on a ~54 ms field build, on a preset that genuinely needs it. Pass
  searches share generation-stamped scratch buffers; allocating full-grid arrays per search cost
  more than the searches.
- Every `bench-terrain.mjs` preset is still well ahead of the pre-bake baseline: open-field 3.18x,
  maze 4.05x, huge 2.77x, **eroded 2.12x**.

### Viewer

- Spawn fallback requires `mainRegion`. "Anywhere walkable" has to mean anywhere walkable the rest
  of the map can be reached from.
- `advanceToReachablePatrolPoint()` skips patrol points in another region before searching, so a
  bot that does end up cut off patrols locally instead of freezing.
- `reportNavRegions()` warns once per layout when walkable ground is still cut off, with the area
  and how many passes the terrain carved. Silent when the map is one piece. Walls and cover can
  fence a region off too, which no terrain pass can fix, so the finished nav grid is what it checks.

## Sidearms — every bot carries a pistol (2026-07-28, `bot-sidearm.js` + `bot-viewer-v2.html`)

Bots used to have exactly one gun and one fallback: reload when the mag runs dry, draw the knife
when the reserve runs out. A dry mag in the middle of a firefight meant standing still for a
1.5-1.8 s reload with an enemy shooting back. Every bot now carries a pistol behind its primary and
draws it instead.

### `bot-sidearm.js` (new — pure, THREE-free, tested in `test-bot-sidearm.mjs`)

| Export | What it decides |
|---|---|
| `pickSidearmId(primaryId, seed, pistols = PISTOL_IDS)` | Which pistol this bot carries. Never the bot's own primary (an M1911 rifleman backs up with the Five-seveN); the seed spreads the roster across both pistols deterministically. |
| `weaponDry(ammo, flags)` | Empty mag AND nothing to refill from. Honours the viewer's `autoRefill` (infinite reserve) and `noAmmo` debug toggles. |
| `chooseWeaponSlot(ctx)` | `'primary'` / `'sidearm'` to request a swap, or `null` to keep what's held. |
| `outOfAllAmmo({active, other, hasSidearm}, flags)` | The FSM's `fireCapable` / knife input: true only when BOTH guns are done. |
| `SIDEARM_DRAW_MS` (550) | Pistol is in hand but can't fire or reload — the cost of the swap. |
| `SIDEARM_LULL_MS` (2500) | Quiet time before a pistol-carrying bot goes back to its primary. Also the window that keeps "in a gunfight" true after line of sight breaks. |
| `SIDEARM_CLOSE_HYST` (1.4) | How far past `closeRange` a target must back off before the primary comes back up. |

`chooseWeaponSlot`'s ladder, holding the primary:

- backup mag empty → keep what's held; there is nothing to draw.
- target inside the role's `closeRange` → draw the backup, loaded primary or not. This is the
  sniper's answer to a rusher and the technical's answer to a rocket that would kill it too.
- mag still has rounds → keep it (a swap is never an upgrade).
- mag dry, primary reserve also spent → draw the backup regardless of contact.
- mag dry **and someone is shooting** → draw the backup. This is the whole point: 550 ms of draw
  beats 1450-1800 ms of reload while exposed. Suppressed for a role with `swapOnDryMag: false`,
  whose primary empties its mag every shot (a bolt-action) — for it a dry mag means nothing.
- mag dry, out of contact → keep it and reload normally. No reason to downgrade in a lull.

...and holding the backup:

- backup spent (mag and reserve) and the primary has anything → back to the primary.
- backup mag dry but the primary still has rounds chambered → back to the primary (don't reload the
  pistol when a loaded rifle is on your back).
- target now beyond `closeRange × SIDEARM_CLOSE_HYST` and the primary has rounds → back to the
  primary. The hysteresis is what stops a swap loop at exactly the boundary distance.
- lull (`quietMs >= SIDEARM_LULL_MS`, nobody in contact) → back to the primary, which the existing
  A9 top-off reload then refills while nothing can shoot back.
- the sidearm toggle turned off mid-round → holster immediately.

### Wiring in `bot-viewer-v2.html`

- `entity.weapon` is now **the weapon in hand**, not the loadout. `entity.primaryWeapon` and
  `entity.sidearm` are the loadout; `ammoByWeapon` already keyed both, so magazine, reserve,
  fire interval, range-derived standoff, fire SFX and the reload sequence all follow the swap for
  free. A bot on its pistol therefore also fights at pistol standoff — it closes in.
- `updateBotWeaponSlot(now, inGunfight, targetDist)` runs twice per sentry frame: once before the FSM
  reads the weapon, and once after the fire branch, so the shot that empties the mag draws the pistol
  on the same frame instead of starting a reload the next frame would cancel. `inGunfight` = target
  visible, or contact/being-shot-at within `SIDEARM_LULL_MS`. `targetDist` is the sentry's own
  `targetDistance` (Infinity with no line of sight) and only matters to a role with a `closeRange`.
- `sidearmForRole(roleId, primaryId, seed)` is the one place a loadout's backup is chosen: a role may
  name its own (the technical's rifle), otherwise `pickSidearmId` hands out a pistol. A named backup
  that IS the primary falls back to a pistol, so cycling a technical onto the AR still leaves it one.
- `swapBotWeaponSlot` stamps `actor.swapUntil` (draw timer, blocks `readyToFire`, `fireBotShot` and
  `reloadBotWeapon`) and **cancels any reload in progress** — swapping is what a bot does precisely
  because it has no time to reload.
- The knife is now a third-tier fallback: `attackerOutOfAmmo` comes from `outOfAllAmmo`, so
  `knifeRequested` / `fireCapable` only fire once the primary *and* the pistol are spent.
- `No ammo: On` zeroes both slots (a roster with full pistols would never reach the knife).
- Panel: `Sidearm: <pistol> (mag/reserve)` in **Weapons & ammo**, showing `(drawn)` while it's in
  hand; toggling it off holsters every drawn pistol at once. Persisted in the save/load slots as
  `sidearm`.

### Stowed weapons (back / hip)

Whatever the bot is *not* holding rides its body, so the swap reads visually: long guns slung
diagonally across the back, pistols on the right hip. A bot on the knife shows both.

- No rig, no pose controller, no anchors, never scene-added — `flushStowedWeapons(actor)` composes
  one matrix per stowed gun (torso joint + body visual yaw + a fixed local offset from
  `STOW_PLACEMENTS`) and pushes it into the **same** `weapon-part-batches` pool the held gun uses.
  Same geometries/materials → same instancing buckets → zero extra draw calls.
- The LOD is the part list: `buildStowParts` keeps the largest sub-meshes covering 90% of the
  vertices (max 2), dropping the small detail meshes a silhouette on someone's back never resolves.
  Single-mesh GLBs come through unchanged, costing one instance.
- `syncBotStowMounts(actor)` rebuilds only when the stowed *set* changes (spawn, weapon assignment,
  a swap, the toggle), keyed by a `primary|sidearm` string. Requires a procedural body — a capsule
  bot has nothing to hang a gun on.
- Placement constants (`STOW_PLACEMENTS.back` / `.hip`) are eyeballed, not authored anchors; they're
  the obvious thing to nudge if a gun clips the body. Templates normalize with their long axis on
  +Z, so the X rotation stands the gun up, Y sets the diagonal and Z rolls it about its own barrel.
- Size comes from the weapon's own `thirdPersonHold.scale` (rifles 2x, pistols 0.68x) times a
  placement trim — a flat stow scale renders a slung rifle at half size.

### Status

Node-tested (`test-bot-sidearm.mjs`, 43 checks). Not ported to `environment-viewer.html` — like the
rest of the v2 FSM work, it lands there with the bot port.

## Sniper and technical roles (2026-07-28, `bot-roles.js` + `bot-viewer-v2.html`)

Two specialists beside the rifleman/medic/squad-leader three. Both are **pure descriptor changes** —
no new behaviour module, no FSM rung, no `if (role === …)` in the viewer. What made that possible is
that the descriptor gained a loadout/perception block the viewer reads generically:

| Field | Default | Read by |
|---|---|---|
| `sidearm` | `null` | `sidearmForRole` — a named backup instead of a picked pistol |
| `sightScale` | `1` | `botSightDistanceFor(actor)` — the one accessor every sight test now goes through |
| `bonusGrenades` | `0` | `createBotActor` and the **Restock grenades** button |
| `swapOnDryMag` | `true` | `chooseWeaponSlot` — whether an empty mag is a reason to swap |
| `closeRange` | `0` | `chooseWeaponSlot` — the distance at which the primary is the wrong tool |

`ROLE_DEFAULTS` is merged into every descriptor at module load, so no caller writes `?? 1`.

### Sniper — `m24` + pistol, 1.5× sight

- **Sees first.** `sightScale: 1.5` multiplies the *slider*, so the "Sight distance" control still
  governs the whole roster and the sniper stays 1.5× whatever it's set to. It feeds enemy
  acquisition, the second-threat scan, the LOS/visibility gate, pack spotting, the standoff clamp
  **and** the tactical rings, so the drawn ring is the honest picture of what that bot can see.
  With the standoff clamp reading the same number, its m24 (230 m range) also fights further out.
- **`swapOnDryMag: false`** is the non-obvious half. The m24's magazine holds **one** round, so a
  sniper is mag-empty between every shot; the generic "dry mag in a gunfight → draw the pistol" rung
  would have put it on a pistol permanently after its first shot. It swaps only when the rifle is
  out of ammo entirely, or when…
- **`closeRange: 14`** — anyone that closes inside 14 m gets the pistol, chambered round or not,
  and the rifle comes back up once they're past 19.6 m (`× SIDEARM_CLOSE_HYST`).
- `support: true`, `leadership: 0` — takes a rear formation slot, never the maneuver element of a
  bounding push, and never outranks a rifleman for squad leader. Insignia: cyan scope ring.

### Technical — `rpg` backed by a `cz_805_bren`, +1 grenade

- **`sidearm: 'cz_805_bren'`** — the first non-pistol backup, and the reason `sidearmForRole` exists.
  The RPG's magazine is also 1 round with a 2.5 s fire interval, so the generic ladder produces the
  intended loop with no special casing: fire a rocket → mag dry in a gunfight → the rifle is up
  550 ms later instead of standing through the tube reload → after a 2.5 s lull it re-shoulders the
  RPG and reloads it. Both guns are long, so whichever isn't in hand stows on the back.
- **`closeRange: 10`** is a safety rule, not a preference: `detonateBlast` damages every bot inside
  the radius **including the shooter** (now scaled by `blastExposure`, so a wall between them helps —
  but at 10 m in the open there is rarely one), and the RPG's blast is 8.2 m while weapon-linked
  standoff would walk it to 13.5 m. Inside 10 m it fights with the rifle.
- **`bonusGrenades: 1`** on top of the global carried count, applied at spawn and by **Restock
  grenades** (which now re-reads each actor's role rather than flattening everyone to the slider).
- Line role: `leadership: 1`, `support: false`. Insignia: orange warhead triangle.

### Spawning them

- `assignRolesToBatch(count, { medicPercent, mix })` — `mix` is `{ roleId: percent }`. Each role is
  spaced evenly and **claims the nearest free slot**, so several percentages share one batch instead
  of overwriting each other; an over-subscribed batch simply runs out of slots for the later roles.
  Still no RNG — the same inputs give the same roster.
- Panel: **sniper %** / **technical %** inputs beside **medic %** (defaults 10/10), plus **Spawn
  sniper** / **Spawn technical** buttons. The percentages live in one `botRoleMix` object that the
  inputs write into directly and every spawn path reads — batch spawns, squad templates
  (`squadRoleTemplate` forwards `mix`) and auto-add waves, whose fractional debt is now tracked
  **per role per team** (`botAutoAddRoleAccum`) so a 1-bot wave still honours a 10% share over time.
- Saved in the slot presets as `roleMix`.

### Known gaps

- The 9-slot state code's role slot is still `r`/`m` (`ROLE_CHARS`), so a sniper or technical encodes
  as `r`. Widening it would change the legal-state space (354,013) and the `duty-requires-medic`
  rules for no behavioural gain; the Inspector's role tag shows the real label.
- Nothing stops the global weapon cycler from reassigning a specialist's primary — that's the
  existing "set every bot's weapon" behaviour, and the role's backup survives it.

Node-tested (`test-bot-roles.mjs`, `test-bot-sidearm.mjs`).

## Three stall bugs (2026-07-29)

Found by joining the state trace against `target_id` / `target_dist` / `vis_gate`
(`docs/subsystems/bot-state-codes.md`). All three end in a bot that stands still and never fights,
which is why they read as one bug in the viewer. Each carries a `botDiag` counter so a take shows
both that the old path is gone and that the replacement is doing the work.

### P1 — the shared fallback target (root cause of the other two's severity)

`selectBotTarget` ended `botTarget = best || (botTarget?.alive ? botTarget : firstLive)`. `firstLive`
is the first entry of `frameEnemyList(team)`, which `rebuildFrameEnemyLists` fills in `botActors`
order — spawn order, since ids come from `nextBotId++` and `cullDeadBots` splices without reordering.
So **every bot that failed acquisition got the same enemy: the lowest-spawn-order survivor.**

Evidence in `bot-states/bot-state-trace-20260729-081830.tsv`: all 8 living alpha bots held one target
simultaneously, handing off in lockstep as it died (bot-31 → bot-57 → bot-84 → bot-94); the held
target was the lowest-id living enemy in **76%** of unseen-target samples *specifically when it was
not the nearest*; rank-1-by-distance was only 16%. Squad contact-sharing was excluded — bots in
**different** squads co-targeted 67% of the time, which `pushAllyReport` cannot cause.

Fix: no invented target. `best`, else a retained **living** target, else `null`. The retention half is
deliberate and unchanged (investigate/chase needs the last position). The `!scanDue` early-out now
tests `botTarget?.alive` so a targetless bot re-scans immediately instead of waiting for its stagger
slot. The dead-bot branch no longer hands a corpse a target either, so a revived bot re-acquires.

Counters: `targetPickBest` / `targetPickRetained` / `targetPickFallbackSuppressed` (fires exactly
where the old bug did) / `targetPickNone`.

### P2 — patrol with no reachable ring point froze the bot forever

`advanceToReachablePatrolPoint()` returns false when no patrol point shares the bot's nav region;
`updatePatrolMovement` then did a bare `return` — no fallback, no retry, no wander. A bot spawned in a
pocket stood on its spawn coordinates for the rest of the session. **30 of 112 bots** in the 08:18
take stalled >5 s this way; bot-95 for 608 s; bot-118 travelled 0 m in 501 s and was still in
`pursue` with a *visible* target 26 m away, unable to path anywhere.

Fix: `localPatrolFallbackGoal()` picks the furthest walkable cell **in the bot's own region**
(`PATROL_LOCAL_MIN_M` 4 m, per-bot scan offset so a pocket's bots don't claim one cell, cached until
reached) and patrols to that under `pathMode = 'patrolLocal'`. Only a genuinely sealed-in bot still
stops, and that case is now counted rather than silent.

Counters: `patrolNoRoute` (problem) / `patrolLocalFallback` (fix engaged) / `patrolIsolated` (residue).

### P3 — knife was a one-way door

Knife is entered only when out of ammo (`attackerOutOfAmmo`), and the rung sits above nearly the whole
ladder — only the heal rungs outrank it. Reload was blocked in knife **twice**: `reloadBotWeapon`
returned false on `botState === BOT_KNIFE`, and the tail `updateBotReload` call was gated the same
way. Dry → knife → cannot reload → still dry → knife. bot-66 held it **652 s of 906 s**.

The severity came from P1: its knife target was bot-94, the shared fallback, a median **43 m** away —
**0%** of its knife samples were ever inside the 2.0 m blade range. It was charging a phantom.

Fix: both reload guards removed (`bot.weapon` is still the gun slot, so the firearm reloads normally),
plus a `KNIFE_COMMIT_MAX_MS` 8 s cap with a `KNIFE_COMMIT_COOLDOWN_MS` 5 s re-entry block, so a charge
that never lands expires instead of persisting. Both halves are needed: a bot with zero reserve is
legitimately dry forever, and only the cap frees it.

Counters: `knifeOutOfReach` (problem — knife frames with the target past 3× blade range) /
`knifeReloadUnblocked` / `knifeTimeout`.

### Reading the counters

`botDiag` is reset when recording starts and saved beside the trace as `bot-diag-<stamp>.json`; it is
also logged to the console on save and exposed as `window.botDiag` for mid-run inspection. It is
deliberately **not** in the TSV — extra rows or comment lines break every consumer that reads that
file by column index. Healthy after the fixes: `targetPickFallbackSuppressed` large (the old bug's
frequency), `patrolIsolated` ≈ 0, `knifeOutOfReach` small and `knifeTimeout` non-zero only if a bot
really is permanently dry.

**Not Node-tested** — all three fixes live inside `bot-viewer-v2.html`, which has no module seam to
import. Verified by syntax check, counter-wiring check, and the endpoint round-trip; the counters
themselves are the runtime evidence.

## Nav fragmentation, and the fallbacks around it (2026-07-29)

The 07-29 traces had 30 of 112 bots stalled in patrol with no reachable ring point, one for 608 s and
one that never moved at all. `patrolLocal` (above) stopped the freeze but by design keeps a bot inside
its own region, so a stranded squad orbited instead of standing still. Neither is "in the fight".

### The fix: connectStrandedRegions (nav-grid.js)

A blocked nav cell is blocked for one of two very different reasons, and the repair turns entirely on
the difference. `navWalkable` rejects a cell for `pointInWall` **or** for exceeding `maxSlope`. The
first is real geometry; the second is continuous ground the capsule can still stand on. `buildNavGrid`
now takes `softBlockedTest`, and only soft cells may ever be opened.

`connectStrandedRegions` repeatedly finds a region that is not the main one, runs a Dijkstra out of it
that may cross soft cells but never walls, and opens the cheapest chain it finds. Cost is
`1 + rise * 4` per opened cell, so the carve crosses a saddle rather than a cliff face — opening the
steepest cell on a ridge would just move the stall from the pathfinder to the capsule. The same corner
rule as `labelRegions`/`findPath` applies, or the link would be a diagonal pinch A* then refuses to
walk: a repair that reads as fixed and is not.

A pocket with no soft route out is **walled off, not steep**. It is left sealed and recorded in
`grid.sealedRegions`; `grid.carved` lists every opened cell. Both are reported by `reportNavRegions`,
including on success — a silently repaired map hides how fragmented the generator actually is.

Node-tested (`test-nav-connect.mjs`): slope-stranded pockets connect and A* then walks them, walls are
never opened, connected maps are untouched, the carve picks a 0.2 m saddle over a 6 m ridge, and the
whole feature is inert without `softBlockedTest` so existing callers are unaffected.

### The escape hatch is a symptom patch, and says so

After `PATROL_ESCAPE_MS` (6 s) orbiting with no reachable ring point, a bot tries to path to a patrol
point outside its region. Once the repair above has run, this normally **fails** — and the failure is
the point. It proves the bot is stranded rather than merely un-attempted, and everything downstream
says so out loud rather than letting the fallback pass as normal behaviour:

- `pathMode` flips `patrolLocal` -> `patrolStranded`. The two are distinct on purpose: the first means
  we have not asked yet, the second that we asked and there is no way out.
- `botDiag.patrolEscaped` / `patrolStranded` count both outcomes.
- A **persistent HUD banner** in-game. A `console.warn` scrolls away; a bot orbiting a sealed pocket
  does not, so the banner stays up for as long as the fallback is load-bearing.
- The trace map rings the bot: dashed amber for `patrolLocal`, solid orange for `patrolStranded`, each
  with its own legend line.
- The trace viewer's **nav region overlay** (`world.regions`, see `bot-state-codes.md`) shows the
  fragmentation itself rather than only its victims: which cells belong to which connected component,
  which cells the repair carved, and how much walkable ground sits off the main region. Region colour
  is by size rank, not id, because `labelRegions` reassigns ids on every relabel.

### Bounded holds elsewhere

Two more places could pin a bot indefinitely, both now capped with a counter:

- `SQUAD_HOLD_MAX_MS` (12 s) — a follower's movement is entirely parasitic on its leader, so a leader
  that stopped moving froze its whole squad forever. Past the cap the follower falls through to its
  own patrol and re-forms when the leader moves. (`squadHoldBroken`)
- `TARGET_RETAIN_MAX_MS` (6 s) — the `firstLive` fix only covered targets that *died*; 30.6% of switches
  in the 07-29 trace were onto an unseen target whose predecessor was still alive. Dropping a
  long-unseen target does not end the search, since `lastKnownTarget` is separate and still drives
  SEEK — it only frees the bot to acquire something it can actually see. (`targetRetentionExpired`)

## `advancePath` — the shared waypoint-advance contract (2026-07-29, `nav-grid.js`)

First seam of the creature/bot merge: the waypoint-pop half of `followPath` now lives in `nav-grid.js`
as a pure, THREE-free helper, so a creature body and a bot capsule advance along a path by the same
rule and only differ in the numbers they pass.

```js
advancePath(pos, path, reachRadius, opts = {}) -> waypoint {x,z} | null
```

- Pops (`path.shift()`) **every** waypoint the body has already reached, then returns the new head to
  steer at, or `null` once the path is spent. It mutates the caller's array in place — that array *is*
  the queue. `null`/empty path returns `null` rather than throwing.
- Base pop test is `dist < reachRadius` (strict, so exactly-on-the-radius does not pop).
- `opts.relaxRadius` + `opts.contested(waypoint, dist)` reproduce the contested-waypoint relax: inside
  the `[reachRadius, reachRadius + relaxRadius)` band a pop is allowed only when `contested` says a
  neighbor is squatting the spot. Omit `contested` and the band is never entered — the predicate is
  never called inside the base reach or outside the band, so the expensive neighbor scan stays rare.
- `opts.canSkipTo(pos, next)` vetoes a *relaxed* pop that would skip a load-bearing corner waypoint.
  Vacuous when `path.length === 1` (nothing to skip) and never consulted for a base-reach pop. Omit it
  for no veto.

`followPath` in `bot-viewer-v2.html` passes `WAYPOINT_REACH` 0.35, `relaxRadius: WAYPOINT_CONTEST_RELAX`
0.45, `contested` = `waypointContestedHashed(entity, botHash, …, WAYPOINT_CONTEST_RANGE)`, and
`canSkipTo` = `lineWalkable(navGrid, …)` when a grid exists (`null` otherwise, matching the old
`|| !navGrid` escape). The opts object and both callbacks are module-level singletons rebound per call
(`_fpOpts` / `_fpContested` / `_fpNextLeg`), so the extraction allocates nothing per frame; `_fpNextLeg`
keeps the old lazy `lineWalkable(p, path[1])` cache, now keyed on the waypoint identity because `p` is
fixed for the whole call. A future creature caller is just `advancePath(pos, path, bodyReach)` — no
contest, no grid.

**What stayed inline in `followPath`**: everything after the pop — own-cell-blocked recovery mode, the
`lineWalkable(p, target)` skip/re-path (`NAV_REPATH_COOLDOWN_MS`), separation blending, the damped
crowd reversal, `terrainSpeedFactor`, and writing `entity.velocity.x/z`. Those are harness-specific;
only the reach/contest/skip-guard verdict is shared.

Tested in `test-advance-path.mjs` (pop at reach, no pop outside it, relax band edges, guard veto and
its vacuous cases, guard wired to a real `buildNavGrid` doorway, empty/null paths, multi-waypoint
runs, and a creature-scale `reachRadius`).

## Phase A brain port into the environment viewer (2026-07-29, `environment-viewer-v2.html`)

The v2 harness brain now runs in the game — in the `environment-viewer-v2.html` work copy, not
the shipping v1 file. The legacy 4-state inline brain (`botTickMovement`, `pickBotTarget`, the
`alertBot`/`propagateBotAlert` pair) is gone; `botTickOne` survives as the per-bot wrapper that
`bindBotActor`s the register machine and runs the ported `updateBotSentry` ladder
(`chooseBotStateName`), cover (against the map-load `buildSightGrid`/`buildLazyVisibilityField`/
`buildCornerMap` bakes), alerts (`bot-alert.js`), aim/spread (`bot-aim.js`), and
`advancePath`-based movement. Env-specific parts stay from v1: `stepBotPhysics` integration, the
fall catch, stuck/escape, `ensureAmmo` as the ammo authority, and `botHasLineOfSight` as the
injected occluder (trees/rocks through the same pipeline shots resolve against) behind the v2
LOS-throttle cache. Contracts preserved: `botPlayers` is still the record store, `playerCombat`
the only HP authority, `applyCombatIntent` the only fire path, guest early-outs intact. Out of
Phase A scope (signals defaulted calm): roles/medic/packs/sidearms/stances (Phase C — landed
2026-07-30, see below), squads/formations/explosives (C½), open-terrain nav (D). QA instrument: `?botTrace=1` state-code takes
diff slot-by-slot against harness takes on the same `pcw-layout` map (see `layout-interchange.js`).

## Phase B: separation, spatial hash, goal claims (2026-07-30, `environment-viewer-v2.html`)

Crowd handling now matches the harness. `botHash = createBotSpatialHash(2)` is rebuilt by
`rebuildBotHash()` **twice per `updateBots` tick** — once before the per-bot loop (so every
neighbour query in the ladder reads this frame's positions) and once after it, feeding the pushout
pass. The rebuild also stamps `entity.botRec = rec`, the entity→record back-ref the visitors need
(respawn swaps the entity, so it is re-stamped rather than set at spawn — the harness's
`entity.botActor` equivalent).

Per-frame order inside `updateBots`: guest early-out → `botFrameNow`/`botFrameCounter` →
`replanBudgetLeft` reset → round-mode spawn top-up → **`rebuildBotHash()`** → per-rec loop
(dead: death-edge `goalClaims.release(id)` / respawn / trace row; living: `botTickOne` = bind,
`updateBotSentry`, movement, `stepBotPhysics`, commit) → `bindBotActor(null)` → `updateSquads()` →
**`pushBotsApart(rebuildBotHash())`** → ghost flush → weapon mounts → inspector → stats.

**Pushout.** `pushBotsApart` is the harness's `resolveBotPairsHashed` penetration-only pass
followed by `mapCollider.resolveCapsule` on every entity it moved, so a doorway squeeze cannot
shove anyone through geometry. The env's `BOT_COLLIDE_PAD` is preserved by passing an explicit
pass radius (`maxCapsuleRadius + BOT_COLLIDE_PAD * 0.5`, i.e. the old `2r + pad` minDist). The
local-player push is env-specific (the harness has no player) and stays an O(n) pairwise pass
after the bot-bot one, with the same wall re-resolve. This lands review finding **R5**; **R2**
(nav-grid erosion by capsule radius) and **R6** (off-nav spawn positions) are still open — R2
edits `nav-grid.js` and the review requires it to ship with R1.

**Soft steering.** `followPath` now blends `separationXZHashed(entity, botHash, SEPARATION_RADIUS)`
into the move direction via `blendSeparationDir`, gated by `navBlockedAhead` (a
`SEPARATION_PROBE_M` look-ahead cell test bound to the `_fpXZ` scratch — crowds may deflect a
heading along a hall, never into a wall), and damps a crowd-spike reversal to `speed * 0.4`. The
harness's `terrainSpeedFactor` slope drag is deliberately not ported (Phase D owns open terrain).
Tunables: `SEPARATION_RADIUS 1.5`, `SEPARATION_WEIGHT 0.5`, `SEPARATION_PROBE_M 0.45`.

**Waypoint contest.** `_fpOpts.contested` is `waypointContestedHashed(..., WAYPOINT_CONTEST_RANGE)`
(was a Phase A `null` stub), so `advancePath` relaxes reach by `WAYPOINT_CONTEST_RELAX` when a
neighbour is parked nearer the waypoint — still guarded by `canSkipTo = _fpNextLeg`, the
`lineWalkable` check on the next leg. Tunables: `WAYPOINT_CONTEST_RANGE 0.75`, `_RELAX 0.45`.

**Claims.** `goalClaims` (`createGoalClaims`, alive predicate = `botPlayers` membership +
`playerCombat` snapshot) is now released on all three exits: respawn (`resetBotBrainState`,
per-kind), despawn (`despawnBot`, all kinds) and the **death edge** in `updateBots` (all kinds).
`isClaimedByOther` already ignored dead owners, so the death release is a leak fix, not a
behaviour change.

| State / event | Kind | Claimed at | Released at |
|---|---|---|---|
| `BOT_COVER_MOVE` / `BOT_COVER_HOLD` | `cover` | `commitCoverCorner` (anchor cell) | `releaseCoverCorner` — cover invalid/blacklisted, cover exit, recovery reposition, muzzle-recovery episode start/clear |
| `BOT_SEEK` (investigate cell) | `seek` | `updateSeekMovement` on plan commit (`planNextInvestigationGoal` skips others' cells) | `finishInvestigation`; `state !== BOT_SEEK` after dispatch; recovery reposition |
| `BOT_PURSUE` (approach bearing) | `pursue` | `pursuitStandoffGoal` | `state !== BOT_PURSUE` after dispatch |
| `BOT_FLEE` (retreat cell) | `flee` | `updateFleeMovement` on plan commit (`findFleeGoal` skips others' cells) | arrival, failed search, `state !== BOT_FLEE` after dispatch, recovery reposition |
| muzzle-recovery reposition | `recover` | `beginMuzzleRecovery` (`findMuzzleRecoveryCell` skips others' cells) | `updateMuzzleRecoveryMovement` arrival, `clearMuzzleRecoveryEpisode` |
| any → death | all kinds | — | `updateBots` death edge (**new in Phase B**) |
| any → respawn | all kinds | — | `resetBotBrainState` |
| any → despawn | all kinds | — | `despawnBot` |

**Neighbour scans on the hash.** `sharedAllyAlertNear`, `livingTeammatesNear`, `fleeSquadCentroid`,
`coverGroupIndex` and `recordBotNearMisses` were per-bot walks of `botPlayers` (O(n²) per tick for
the first two and cover-group); they are now hoisted-visitor hash queries mirroring the harness's
`_saVisit`/`_ltVisit`/`_fsqVisit`/`_giVisit`/`_nmVisit`. `recordBotNearMisses` uses
`forEachSegment` with the harness's `NEAR_MISS_RADIUS + 0.5` AABB pad as a conservative prefilter
before the exact 3D `shotMissDistance` test. Scratch is module-scope and drained inside one call,
so none of these allocate per frame.

**Replan budgeting** was already ported in Phase A and is unchanged: `requestPathBudgeted`
(per-entity `REPLAN_COOLDOWN_MS` + `replanJitterMs` phase, global `REPLAN_BUDGET_PER_FRAME = 8`
reset at the top of `updateBots`) returns `null` on refusal, and `requestPath` remains a thin wrapper
over `requestBotPath` so the static-grid vs. local-window abstraction is untouched. `followPath`'s
inline re-path deliberately calls the unbudgeted `requestPath` behind the per-entity
`NAV_REPATH_COOLDOWN_MS` latch, exactly as the harness does.

No trace columns changed — `bot-state-code.js` has no slot for separation or claims, so the
`?botTrace=1` TSV stays byte-identical to the harness's.

## Phase C: roles, medic, health packs, sidearms, stances (2026-07-30, `environment-viewer-v2.html`)

Five harness systems landed together, because they share one substrate: a role is a data
descriptor whose fields the brain reads, and packs/medic/sidearm/stance are what those fields
select. All of it merges INTO the `botPlayers` rec (never beside it), like the Phase A actor fields.

**Roles (`bot-roles.js`).** Env spawns one bot at a time, so `assignRolesToBatch` fills a rolling
`botRoleQueue` (`BOT_ROLE_BATCH = 10`) drained by `nextBotRole()`; `spawnSquadAtSlot` deals one
batch for the whole squad so specialists spread across it. Panel sliders `Medic %` / `Sniper %` /
`Technical %` feed `currentRoleMixOpts()` and flush the queue on change. Role fields are consumed
as pure data, never as a branch on a role id:

| Field | Consumed by |
|---|---|
| `weapon` | `spawnBotAt` — `role.weapon ?? botWeaponId` (medic five-seven, sniper m24, technical RPG) |
| `sidearm` | `sidearmForRole()` — a named backup, else `pickSidearmId` |
| `sightScale` | `botSightDistanceFor(rec)` — the one sight-range accessor, so perception, the standoff clamp and pack visibility all scale together |
| `swapOnDryMag`, `closeRange` | `updateBotWeaponSlot` -> `chooseWeaponSlot` |
| `maxPacks`, `startingPacks` | rec `maxPacks` / `healthPacks` at spawn and respawn |
| `canRevive` (via `ROLE_MEDIC`) | the medic-duty gate in `updateBotSentry` |

Sniper and technical are pure descriptors — no code path names them. Technical defaults to 0%: its
RPG fires through `applyCombatIntent`'s projectile mode with no ballistic lead (unchanged by C½,
which lands the arc solver on grenades only — the harness does not lead rockets either).

**Sidearms (`bot-sidearm.js`).** `rec.weaponId` now means *the gun in hand*; the loadout is
`rec.primaryWeaponId` + `rec.sidearmId`. `ensureAmmo` already pools per `id:weaponId`, so each slot
keeps its own mag/reserve with no new bookkeeping. `updateBotWeaponSlot(now, inGunfight, dist)`
runs at the **tail** of the sentry, on post-fire ammo, so the round that empties a mag draws the
pistol on that frame instead of starting a reload the next frame cancels. `swapBotWeaponSlot`
writes `rec.weaponId` + `bot.weapon`/`bot.tool` + `setPlayerWeapon`/`setPlayerTool` and stamps
`rec.swapUntil = now + SIDEARM_DRAW_MS`; `updateEnvironmentBotWeaponMount` already rebuilds on a
`rec.weaponId` change, so the visible gun follows for free. `readyToFire` and the `BOT_FIRE`->`AIM`
re-stamp both gate on `botSwapping()`. `botOutOfAllAmmo()` is `outOfAllAmmo({active, other,
hasSidearm})`, so a spent primary with a loaded pistol keeps a bot `fireCapable` instead of sending
it fleeing. `inGunfight` = visible target, or a self-threat within `SIDEARM_LULL_MS`, or a fresh
ally report. **Deferred:** back/hip stow visuals (the harness's `syncBotStowMounts` builds extra
low-part mounts; env's mount path is a single `skeletonClone`d template) and the `BOT_KNIFE` rung
(`botKnifeSecondaryEnabled = false` — env has no bot melee fire path, so a genuinely dry bot flees).

**Health packs (`bot-health-packs.js`).** Host-owned world items: `worldHealthPacks` + `packHash`
(`createBotSpatialHash(8)`, rebuilt only when the list changes), `PACK_DESPAWN_MS 60000`,
`PACK_CAP 64` with claimed-cell-aware eviction, drained by `despawnStaleHealthPacks` at the top of
`updateBots`. Packs drop on the **death edge** in `updateBots` (`dropBotHealthPacks`, scattered by
`botPackSettings.dropScatter`) and are collected by `collectPacksUnderfoot` at the top of every
sentry tick. Seeking: `packClaimIntent(botState, wantsHeal, hasPack)` gates the claim on last
tick's state (only PATROL and a wounded FLEE walk to a pack — every other state would be a phantom
claim), `packRunSafe` rejects a run that closes on the live threat, and the chosen cell takes a
`'pack'` goal claim. The harness's danger-field inflation of the pack distance is **not** ported
(env has no `botDangerField` — the danger A* term is Phase D).

**Heal chain.** `beginBotHealthRetreat` is hooked into `recordBotAllyHit`, the single damage-report
point (hitscan *and* blast). It sets `rec.healRequested`, which lights the ladder's heal rungs:
FLEE to a retreat cell -> `healArrived` -> `updateHealSafety` (`healUnsafeBand` hysteresis around
`botHealthSettings.safeDistance`) -> `BOT_HEAL`. `updateBotHealing` spends pack charge with
`drawFromPacks` and applies it through `healBotHp`, a **clamped negative `applyDamage`** — so
`playerCombat` stays the sole HP authority and no second HP owner appears. `updateFleeMovement`
detours to a pack at 1.24x speed when wounded and empty, and latches `healArrived` on arrival or
on a failed retreat search.

**Medic (`bot-medic.js`).** Medic duty layers on top of the resolved FSM state, between
`chooseBotStateName` and the cover lifecycle: own-survival (`healRequested`), FLEE and KNIFE
outrank it. `decideMedicDuty` snapshots wounded allies off the spatial hash (fellow medics
excluded; a patient another medic has leased is skipped) and corpses off the `rec.diedAt` /
`rec.deathXZ` stamps set at the death edge, ranks both by **nav path cost**, and returns
`MEDIC_MOVE` / `MEDIC_TEND`. Both dispatch branches fire while moving/tending. `updateMedicTend`
heals through `healBotHp` or, after `reviveChannelMs`, calls `reviveCombatBot` — which stands the
corpse up where it fell via `playerCombat.revive` trimmed to `reviveHp` by a follow-up
`applyDamage`, clears `deadSince`/`diedAt`, and runs `resetBotBrainState`. Out of combat a medic
falls through to `updateMedicCohesionMovement` (`cohesionTarget`, local group only).

> **G5 (amended).** `floodFill` results are pooled and valid only until the next call. The medic
> nav flood is cached for `MEDIC_NAV_FLOOD_MS = 200`, i.e. **across frames**, so `medicNavFlood`
> passes the medic's own `rec.medicFloodBuf` as `out`. `findFleeGoal` still uses the pool — it
> drains its result inside one call.

**Stances (`bot-stance.js`).** Resolved once per bot per tick, immediately after the alert hold and
before any dispatch consumes the state: `chooseBotStance(state, _stanceCtx, botStanceSettings)` ->
`stepStanceTransition` hysteresis latch -> `rec.stance`. Prone stays default-off
(`STANCE_DEFAULTS.proneEnabled`), and there is no UI force-override and no `STANCE_DASH` (the
grenade-evade trigger is C-and-a-half), so the live set is stand / crouch / run. Seams:

| Seam | Hook |
|---|---|
| Movement speed | `currentBotMoveSpeed()` x `stanceSpeedFactor(stance, settings, botRunMultiplier)` — this is what gives walk vs. run speed variation; `Run speed x` slider, default 1.7 |
| Turn rate | `botTurnRateRadS()` x `stanceTurnRateScale` |
| Weapon spread | `botShotSpreadRad()` x `stanceSpreadScale` |
| Capsule height | `applyStanceHeight(rec, dt)` in `botTickOne`, right after `stepBotPhysics` |

`applyStanceHeight` eases `rec.stanceWeights` with `stepStanceWeights` and scales the capsule's
straight section from the stored `rec.standHeight`, feet fixed. The scale is **derived from the
rig**, not from the flat `*HeightScale` constants: `stanceHeightScaleFor` reads the live
`pelvisHeightRatio`/`crouchCfg`/`proneCfg` off the GhostRenderer's procedural body
(`environmentBotBody(id)`) and feeds `stanceCapsuleHeightScale`, falling back to
`stanceHeightScale` before the body exists. One weight pair therefore drives the silhouette and the
hitbox, so they cannot disagree mid-blend.

**Multiplayer.** Three additive, default-safe wire fields, all emitted only when a sender actually
stamped them, so an unstanced viewer produces the exact wire pose it always did:

| Field | Producer | Consumer |
|---|---|---|
| `crouch` (0..1) | `toWirePose` from `bot.crouch01` | `GhostRenderer._updateProceduralBody` — was hard-coded `crouch: 0` |
| `prone` (0..1) | `toWirePose` from `bot.prone01` | same (the rig already had a `state.prone` channel) |
| `standFullHeight` | `toWirePose` from `bot.standHeight` | rig `height`, preferred over `fullHeight` |

`h`/`fullHeight` stay the **live** (shrunk) capsule so a crouched bot really is a shorter hit/LOS
target, while `standFullHeight` is the standing profile the rig poses from — otherwise the
renderer's own crouch channel would double up on an already-shortened body. `_lerpPlayers` carries
all three (crouch/prone interpolate like `h`; absent on both sides stays absent). HP authority is
still `playerCombat`, the fire path is still `applyCombatIntent`, and guest early-outs are intact.
**Deferred:** guests do not see world health packs — that needs a pack entity type in the registry
(the standing lights-first registry migration) rather than a wire field.

**Tracer slots now live.** Slot 4 (role) reads `rec.role` — the alphabet is two chars (`rm`), so
sniper/technical/squad-leader encode as the line's `r`, per `bot-state-code.js`'s own `ROLE_NAMES`.
Slot 8 (packs) is `packSlot(rec.healthPacks.length, rec.reviveKits > 0)`. The heal-flee commit
latch is live in slot 9 (`LATCH_HEAL_FLEE = 8`; `LATCH_HOLD` at bit 4 had no channel until C½,
which added one). Slot 5 (push element) and the hold latch both went live in C½ below. Two
re-stamps keep codes legal at the frame boundary, mirroring the existing `BOT_FIRE`->`AIM` one: a
`BOT_HEAL` that spent its last charge this frame re-stamps to `BOT_PATROL` (`heal-needs-pack`), and
so does a `MEDIC_MOVE`/`MEDIC_TEND` with neither packs nor a kit left (`duty-requires-resource`).

**Panel.** Combat Bots gains `Medic %`, `Sniper %`, `Technical %`, `Run speed x`, and `Stances` /
`Sidearms` toggles. The Bot Inspector gains role, stance, packs (+ revive kit), heal flag, the
in-hand/primary/backup weapons with a draw indicator, and the live medic action.

## Phase C½: teams, squads, explosives AI (2026-07-30, `environment-viewer-v2.html`)

The last behaviour phase before open-terrain nav (Phase D). Three systems, one substrate: a bot now
belongs to a **side**, a side's bots form **squads**, and a squad throws and dodges **ordnance**.

### Team model (the harness's "sides", mirrored)

`BOT_TEAM_DEFS = { alpha, bravo }` with `BOT_TEAMS` as the spawn-side order, matching
`bot-viewer-v2.html`. Every bot carries `rec.teamId` **and** `bot.team` (re-stamped on respawn,
because respawn swaps the entity) so hash visitors can read the side straight off the entity via
`e.botRec`. `teamOfId(id)` answers for any combat id; a non-bot id is `HUMAN_TEAM`.

**Where the player sits.** Humans (host + guests) are a *third party hostile to every bot team* —
exactly the role the harness's WASD dummy targets play there (`rebuildFrameEnemyLists` pushes them
into every team's list). They are never a squad member, never an ally-report audience, and never a
medic patient. `hostVisibleToBots()` still gates whether the host is perceivable at all.

`rebuildEnemyCandidates()` builds one candidate array **per team**, once per frame: alive humans
plus every living bot on another side. Bot candidates are pooled `{ id, p, h }` objects reused
across frames (no per-frame garbage), with `p` the capsule midpoint so `humanAimInto`'s `+0.3h`
lift resolves the same upper-chest point it does for a human wire pose. `selectBotTarget` and
`secondVisibleThreat` read `botEnemyCandidates(rec.teamId)`.

Bot-vs-bot damage needs no new path: `resolveWorldShot` already folds `botPlayers` into
`currentCombatPlayers()` and `resolveHitscan` excludes the shooter, so once targeting includes
enemy bots the existing `fireBotShot` → `applyCombatIntent` → `applyHitDamage` chain carries HP,
counters, casualty reports and MP replication. `playerCombat` stays the sole HP authority.

**Team scoping** — every site that meant "ally" and previously meant "any bot":

| Site | Rule |
|---|---|
| `recordBotAllyHit` | the report carries the **victim's** side; `latestAlertNear` filters on team, so one side's casualties never alert the other |
| `recordBotNearMisses` / `_nmVisit` | skips bots on the **shooter's** side (a friendly round whistling past alerts nobody); the old "bot fire records no near-misses" early-out is gone |
| `sharedAllyAlertNear` / `_saVisit` | one side's chatter only |
| `livingTeammatesNear` | teammates, not everyone standing nearby (feeds the push-tier group test and aim seeding) |
| `fleeSquadCentroid` / `_fsqVisit` | same side |
| `_mdAllyVisit`, the medic corpse scan, `_mcVisit` | a medic never heals, revives or regroups on the enemy; squadmates are preferred via the `squadmate:` field |
| `coverGroupIndex` / `_giVisit` | S10 peek phasing counts same-side holders |
| `_contactMe.team` / `_escMe.team` | the bound bot's real side |

Friendly fire stays **on at the damage level and off at the decision level**, as in the harness:
`chooseGrenadeThrow` vetoes a throw with an ally in the ring and target selection never returns a
teammate, but `applyExplosionBlast` damages whoever is inside the radius, thrower included.

Health packs stay side-neutral (any bot scavenges any ground pack) — harness parity.

**Spawn placement.** `botSpawnTeam` is `'both'` (default) | `'alpha'` | `'bravo'`;
`nextSpawnTeam()` fills the emptier living side, the rule the harness's auto-adder uses.
`teamSpawnPoints(teamId)` splits the authored spawn points in half along the map's **long axis**
(cached per `botSpawnPoints` identity) — the side model `bot-structures.js`'s `teamSideRegions`
bakes in the harness, derived here from whatever points the map authored, so it works for
shoot-house and pcw-layout maps alike. With no authored points the golden-angle ring is offset by
`teamIndex * PI`. Both spawn paths (manual button, round/squad top-up) route through it.

### Squads (`bot-squad.js`, at harness fidelity)

`squad-activity.js` is **retired inside the v2 copy only** — `environment-viewer.html` (v1) still
imports it, and the module plus `test-squad-activity.mjs` are untouched. `pickExploreGoal` was the
one non-squad function in it, so it is inlined into `environment-viewer-v2.html` beside
`nextExploreGoal`.

Squad records match the harness's shape: `memberIds` / `detachIds` Sets, `seq` (ascending =
younger; older squads keep command through a merge), `heirIds` (the named line of succession),
`successionShockUntil`, `liveCount`, `kind`, and reused `leaderPos` / `leaderYaw`.

Lifecycle:

1. **Spawn.** `spawnSquadAtSlot(startIndex, teamId, count)` runs `planSquadIntake` first, so
   reinforcements top up understrength same-side squads (`fillSquadOpenings`, oldest squad first)
   before any new squad forms; roles come from `assignRolesToBatch` for the joiners and
   `squadRoleTemplate` (leader at slot 0) for each new squad. Env spawns one bot at a time, so the
   batch is materialised and then bound with `dealSquadChunks` + `formSquad`.
2. **Roster.** `formSquad` elects immediately (`electSquadLeader`) rather than leaving it to the
   first tick — an unresolved leader reads as a dead one, and the squad would open its life inside
   a succession shock.
3. **Succession.** `updateSquads(nowMs)` runs `stepSquadSuccession` per squad: a dead leader leaves
   the squad leaderless for `SUCCESSION_SHOCK_MS` before an heir (or an election) takes over.
   `rec.isLeader` follows command, not the spawn role.
4. **Formation.** `formationRanks` ranks the **living** only (so a formation closes over its
   casualties) and puts support at the back; `chooseFormationKind` picks wedge/column/line/ring from
   the panel override, contact, and a throttled corridor probe (`squadCorridorClear`, which reuses
   whichever walkability test backs the active map's nav). Members walk their slot via
   `updateSquadFormationMovement`, wired into the **out-of-combat** dispatch branch only, so it
   biases movement that was already idle and never pre-empts the FSM. A follower parked on its slot
   longer than `SQUAD_HOLD_MAX_MS` falls back to its own patrol — a frozen leader must not freeze
   the whole squad.
5. **Reconciler.** `reconcileSquads` runs `planSquadReconcile` every `SQUAD_RECONCILE_MS` and applies
   split / mergeDetachments / merge / absorb ops; strength counts living bodies only. It is pure
   bookkeeping (nobody is moved), so it is safe mid-firefight.

The squad tick runs **before** the per-bot FSM loop — rosters settle before any member reads them —
replacing the old post-loop `updateSquads()`.

**Push element (S11) + hold channel (S13) go live.** `BOT_PUSH_TIER_ENABLED = true`.
`applyPushElement` derives a stable bounding split from `rec.squadRank` (rostered) or an emergent
hash-sweep ranking (independent); support roles never draw the maneuver element. The base element
expresses itself as a short self-issued hold (`commandBotHold`, `PUSH_HOLD_LEASE_MS`, re-armed each
frame the tier is live), and a medic asks its patient to hold with a `'heal'` reason that outranks
`'overwatch'`. `holding` is resolved above the stance resolve (the stance ctx reads it) and consumed
by a dispatch branch that still aims and fires — overwatch *is* that.

### Explosives AI (decision math only)

`bot-grenade.js` plus `bot-projectiles.js`'s arc solver, bound to env's **existing** projectile and
explosion entities. No new FX, no new entity type, and no `createProjectileManager` — env's registry
already owns projectile lifetime.

- **Throw decision.** `grenadeCandidate` runs cheap gates first (per-bot cooldown, per-team volley
  cooldown via `teamLastGrenadeAt`, stock, rough range) and only then scans the roster:
  enemies = `botEnemyCandidates(rec.teamId)`, allies = living same-side bots. `chooseGrenadeThrow`
  returns an aim point, a score and a reason (`cluster` / `cover` / `blind`).
- **Ballistic aiming.** `solveGrenadeThrow` drops the aim to the ground under the target (a lob
  solved to chest height lands metres long), solves with `solveBallisticArc`, lifts by the
  integrator's own error term, then clearance-checks the `sampleArcPoints` legs against
  `mapCollider` **and against `terrainHeight`** — the G1 flat-floor fix the harness does not need.
- **Launch.** `spawnBotOrdnance` creates a `combat-projectile` registry entity with the solved
  velocity (`dir` normalised, `speed = |v|`, `arc` zeroed so the spec's loft is not applied twice),
  host-only — exactly the type `applyCombatIntent`'s projectile branch spawns. Detonation therefore
  runs the normal `ExplosionEntity` → `applyExplosionBlast` path, which already calls
  `recordBotAllyHit` per victim with the blast's own threat point, so blasts feed the alert tiers
  the way the harness's `detonateBlast` does.
- **Evade.** `refreshGrenadeThreats()` snapshots live bouncing projectiles once per tick from the
  registry, so a **player-thrown** grenade is dodged too. `grenadeEvade` picks the most urgent blast
  covering the bot; `grenadeEvadeGoal` is a no-alloc straight-sprint cell search on the static grid,
  with `fleeAwayFromXZ` as the open-terrain fallback (the static grid is shoot-house-only). The
  evade handler outranks every other movement branch; a wind-up outranks everything but that.
  `rec.evadingUntil` (a self-expiring stamp, `GRENADE_EVADE_POSE_LINGER_MS`) feeds `sc.evading`,
  which is what resolves `STANCE_DASH`.
- **Inventory.** `rec.grenades = throwCountFor(settings) + role.bonusGrenades`, a per-life stock
  independent of the primary's ammo, restocked on respawn. The technical's RPG keeps firing as its
  primary through `applyCombatIntent`; the harness does not ballistically lead rockets either.

### Tracer

Slot 5 (push element) is live via `BOT_ELEMENT_SLOT = { base: 'b', move: 'm' }` — the same table the
harness uses — and `LATCH_HOLD` (bit 4) is live as `holdUntil > now && state in PSU`, mirroring the
dispatch's `holding` rather than the bare lease. All nine slots now read real fields. The
`element-requires-push` rule holds because `rec.pushElement` is set only while `alertTier ===
'push'` and cleared otherwise (and on death). TSV columns are unchanged: `team` is now the real side
and `squad_rank` is `rec.squadRank`.

### Panel

"Squads & Outposts" becomes **"Squads & Sides"**: Spawn team (Both / Alpha / Bravo), Squad mode,
Formation (auto plus the four kinds), Squad size, Slot spacing, Merge radius, a Grenades toggle, and
a per-squad status list (`id  side  core+detached  kind  leader/LEADERLESS`) under a living-per-side
header. The temperament sliders and the Force retreat / Force attack buttons are gone with
`squad-activity.js`. The Bot Inspector shows team, squad rank, formation kind and the shock flag.

**Deferred:** a grenade-in-hand visual during the wind-up (env's mount path is one `skeletonClone`d
template; the harness swaps to the grenade GLB), per-side bot tinting, and open-terrain cover bakes
(Phase D). The danger-field A* term stays off.

## Swarm-audit parity fixes (2026-07-30, `environment-viewer-v2.html`)

A six-agent audit comparing the two apps' bots dimension-by-dimension surfaced two quick parity
slips, both fixed:

- **Local-window smoothing bound** — `requestBotPath`'s local-window branch (and its
  nearest-walkable retry) called `botSmoothPath` without the `SMOOTH_LOOKAHEAD` cap every other
  call site passes, defaulting the string-pull lookahead to `Infinity`. Low impact on a ~24×24
  window, but now bounded like the static-bake branch.
- **Arena-scaled combat SFX** — gunfire/launch/explosion positional audio played through the
  outdoor-tuned `positionalSfxProfiles` (gunshot `refDistance` 25) even on shoot-house maps, where
  the harness's own `BOT_SFX` comment documents that as every-shot-at-full-volume. `combatSfxProfile(kind)`
  now selects the harness's arena profiles (`ARENA_SFX`) when `NO_ENVIRONMENT` and the shared
  outdoor profiles otherwise. The harness's voice budget / distance cull / synth fallback remain
  Phase E items.

## Phase D: open terrain (2026-07-30, `environment-viewer-v2.html` + `nav-grid.js` + `nav-corners.js`)

Before this phase, everything cell-indexed in the ported brain was dead outside the shoot house.
`botNavGrid` was baked only under `NO_ENVIRONMENT`, so on terrain maps cover corners, crest cover,
the flee/hide scans, region labels and the danger field all sat behind `if (!botNavGrid) return
null` guards, and pathing was a throwaway 36 m A* window rebuilt per request with a binary
`BOT_TERRAIN_SLOPE_TOLERANCE` walk gate and no slope cost at all.

### The architecture decision, and the bench behind it

`bench-bot-nav.mjs` (new, repo root; flags `--rugged`, `--blockers`, `--crest`) builds grids at
env-viewer map scales over synthetic-but-env-shaped ground (rolling hills over a continental tilt,
a water level, a scattered trunk/rock field) and times the module work separately from the per-cell
walkability predicate — the predicate is the part that differs in the browser, where it also runs a
cached capsule-vs-BVH sweep.

Numbers that decided it (rolling profile, Node 22):

| span m | cell m | cells | walkable | build ms | grid MB | lazy field ms | flee scan ms | corner bake ms | corners | **eager field MB** |
|---|---|---|---|---|---|---|---|---|---|---|
| 128 | 0.5 | 65,536 | 46,729 | 40 | 0.6 | 3.2 | 0.63 | 18 | 544 | **260** |
| 256 | 1.5 | 29,241 | 17,563 | 12 | 0.3 | 0.3 | 0.03 | 10 | 671 | **37** |
| **384** | **1.5** | **65,536** | **34,232** | **19** | **0.6** | **0.7** | **0.24** | **8** | **1,281** | **140** |
| 512 | 1.5 | 116,964 | 56,967 | 42 | 1.1 | 0.9 | 0.61 | 13 | 2,193 | **387** |
| 1024 | 2.0 | 262,144 | 123,759 | 119 | 2.5 | 1.9 | 0.83 | 54 | 2,451 | **1,826** |
| 1200 | 1.5 | 640,000 | 329,828 | 292 | 6.1 | 4.5 | 0.04 | 77 | 3,822 | **12,969** |

Reference point: the *existing* per-request local window is 576 cells at **0.35 ms every time a bot
asks for a path**.

Three things fall out of that table:

1. **The eager visibility field is confirmed dead** at any env scale — `walkableCount²` bits is
   140 MB at 384 m and 13 GB over a whole 1200 m map. `buildLazyVisibilityField` is mandatory, and
   it is cheap: construction is sub-millisecond (it only builds the walkable index), a
   1,681-candidate flee scan against one threat cell costs 0.24 ms, and its 64-row FIFO cache tops
   out at 0.3 MB. `rowFor` is the one expensive call (9 ms at 384 m, 384 ms at 1200 m) —
   environment-viewer never calls it, and shouldn't start.
2. **A whole-map grid is not quite the wall it looked like** — 1200 m at 1.5 m is 292 ms and
   6.1 MB, survivable *in Node*. It is not survivable in the browser: the real predicate adds a BVH
   capsule sweep per cell and 640k of those at map load is seconds. It also over-serves — bots
   fight inside a 50 m sight bubble, not across a kilometre.
3. **384 m at 1.5 m is the sweet spot** — 65k cells, 0.6 MB, a ~20 ms build plus a single-digit-ms corner bake, and
   the same pitch as `BOT_LOCAL_NAV_CELL`, which means it shares `botMeshBlockedAt`'s cache keys
   exactly instead of doubling the BVH sweeps.

**Decision: hybrid — a persistent, player-anchored, time-sliced combat-zone grid, with the existing
local windows kept for everything outside it.** Not a full-map coarse grid (browser bake cost, and
cover records at a coarse pitch are worthless), not local-windows-only (they cannot carry cover,
danger or region labels), not a bounded grid that rebakes per fight (the anchor would thrash).

### What that looks like in code

`updateBotNavZone(nowMs)` runs once per bot tick, before the per-bot loop, and does nothing at all
when there are no bots. It anchors on the **local player** — bots spawn around them, their sight
range is 50 m, and it is the one anchor that exists on both authored and infinite procedural
terrain — falling back to the first living bot when there is no player pose.

The bake is **time-sliced**: `stepBotZoneBake()` samples whole rows until it has spent
`BOT_ZONE_BAKE_BUDGET_MS` (3 ms), then returns and resumes next frame. `nav-grid.js` gained
`finalizeNavGrid(grid, opts)` for this — the region-labelling + `connectStrandedRegions` half of
`buildNavGrid`, callable on a grid whose `cells`/`heights`/`soft` arrays the caller filled in
itself. `buildNavGrid` is now that function plus its sampling loop, so the two paths cannot drift
(a Node test asserts they produce identical cells, labels, carves and paths).

While a bake is in flight the previous grid stays live, and before the *first* bake `botNavGrid` is
null — i.e. exactly the pre-Phase-D local-window behaviour. Degradation, never failure.

`adoptBotNavGrid` swaps the finished grid in and **throws away every cell index in flight** — goal
claims, the danger field, per-bot cover corners, medic flood caches, flee-goal history, live paths.
Cell indices belong to a lattice; remapping them between two different ones is not worth the bug
surface.

### Tunables (all in `environment-viewer-v2.html`, in the zone block)

| Constant | Value | Note |
|---|---|---|
| `BOT_ZONE_SPAN` | 384 m | zone side length; the bench's sweet spot |
| `BOT_ZONE_CELL` | `BOT_LOCAL_NAV_CELL` (1.5 m) | same pitch as the local windows, so `botMeshBlockedAt`'s cache is shared |
| `BOT_ZONE_REBAKE_DRIFT` | 96 m | anchor drift from the zone centre before a rebake |
| `BOT_ZONE_BAKE_BUDGET_MS` | 3 ms | per-frame sampling budget |
| `BOT_ZONE_RETRY_MS` | 4000 ms | floor between rebakes |
| `BOT_ZONE_EDGE_MARGIN` | 3 m (2 cells) | how far inside the zone a query must be to count as covered |
| `BOT_ZONE_SIGHT_CAP` | 1200 | biggest-first cap on derived sight-blocker rects |
| `BOT_ZONE_SIGHT_MIN_FOOTPRINT` | 1.5 m | below the cell pitch a rect occludes nothing (see below) |
| `BOT_ZONE_CREST_MIN_RISE` | 0.6 m | harness value, unchanged |
| `BOT_ZONE_CREST_SPAN_M` | **4.5 m** | harness uses 2 m — diverged, see below |
| `BOT_ZONE_CREST_FAR_M` | **24 m** | harness uses 12 m — diverged, see below |
| `NEAREST_WALKABLE_WINDOW_CELLS` | 32 | bounds `nearestWalkableInGrid`'s scan |

### Slope-costed pathing

Both regimes now pass `heightAt: terrainHeight` into `buildNavGrid`, so A* and `floodFill` charge
`slopeFactor` (uphill 1.8×/grade, downhill 0.6×/grade, capped at 6×) and `smoothPath`'s
`chordClimb` refuses a string-pull shortcut that would climb back over the hill the search just
routed around. The binary `BOT_TERRAIN_SLOPE_TOLERANCE` (0.9 m rise per 1.5 m cell) stays as the
hard walkability gate; slope cost sits on top of it, exactly as in the harness.

The zone grid additionally passes `softBlockedTest: botTerrainSoftBlocked` — "blocked by slope
alone, i.e. continuous ground the capsule can still stand on" — so `connectStrandedRegions` can
carve the cheapest chain of steep cells linking a stranded pocket to the main region. Water, tree
trunks, dressing circles and BVH-blocked cells are hard blocks and are never carved. The bake log
reports carved-cell and stranded-region counts, matching the harness's `reportNavRegions`
discipline: a repaired map should be visibly repaired.

Local windows get `heightAt` but no soft test — they are 24×24 and a carve inside one is
meaningless.

### Cover on terrain: what counts as a sight blocker

Sight blockers come from the **dressing index** (`dressingIndexRef` — boulders, stumps, logs),
walked chunk-by-chunk over the zone bounds and deduped, with height from the same convention the
bullet columns already use (`r * GUN_ROCK_H_PER_RADIUS`, floor `GUN_ROCK_MIN_H`).

Included: dressing circles whose footprint is at least the cell pitch **and** whose derived height
clears `SIGHT_BLOCK_HEIGHT` (1.5 m) — in practice r ≥ ~1.1 m, i.e. boulder grade.

Excluded, deliberately:

- **Tree trunks.** `buildSightGrid` marks a cell only when a rect covers the cell **centre**, so a
  0.3–0.6 m trunk at a 1.5 m pitch occludes nothing at all — while still emitting up to 8 corner
  records each. Thousands of corner records that hide nobody is the worst of both worlds.
- **Hills, cliffs and authored mesh geometry.** These occlude through the field's *terrain* path
  (`buildLazyVisibilityField(..., { terrain: { heights } })` tests each visited cell's ground
  against the eye-to-eye chord), not through rects. That is also what makes crest cover honest.
- **Chunks that have not streamed in yet** contribute nothing. The dressing index is streamed, so a
  zone edge can be under-blocked. That errs toward VISIBLE, the direction the whole vis-field
  design already errs in.

`nav-corners.js` gained `inset` / `offFace` / `peekPast` options (defaults unchanged, so
shoot-house and both bot viewers keep their exact behaviour). The authored 0.6 / 0.4 / 0.5 m offsets
assume a ~0.5 m grid; at 1.5 m they can quantize anchor and peek onto the same cell, which is a
record with no lean in it. The zone bake scales them with the cell (0.6×, 0.5×, 1.2×). A matching
guard drops any record whose anchor and peek land on one cell — such a record could never be
*selected* anyway (`pickCoverCorner` needs the threat to not-see the anchor and to see the peek,
a contradiction on one cell), so this only shrinks the list.

### Crest cover: a measured divergence from the harness

The harness bakes crests with `maxSpan: 2 m`, `farCells: 12 m`. **Those values find zero crests
here**, and `bench-bot-nav.mjs --crest` shows why:

```
crest sweep @384 m / 1.5 m cell, rugged synthetic terrain
  span   2 m   far 12 m:   0    far 18 m:   0    far 24 m:  18
  span   3 m   far 12 m:   0    far 18 m:   0    far 24 m:  82
  span 4.5 m   far 12 m:   0    far 18 m:   0    far 24 m: 100
  span   6 m   far 12 m:   0    far 18 m:   0    far 24 m: 101
  span   9 m   far 12 m:   0    far 18 m:   0    far 24 m: 103
```

Two independent geometric reasons:

- **Span.** A brow only hides a 1.6 m eye if it stands ~1.8 m above the anchor. The walk gate caps a
  cell's rise at 0.9 m, so that needs at least 3 cells of run — 4.5 m at this pitch. The harness's
  2 m is ~4 cells on *its* 0.5 m grid; here it is one.
- **Probe distance.** Env terrain is far gentler than the harness's authored hills, so the
  threat-side probe has to sit ~24 m out before the ground between it and the anchor rises enough
  to occlude.

On the *rolling* (gentle) profile the sweep finds zero crests at every setting, which is the correct
answer: flat ground has no reverse-slope cover. Crest counts are map-dependent; the bake log prints
them plus a `CAP HIT` marker when `maxRecords` (800) truncates.

### Danger field, now live

`bot-danger.js` was imported but unused. It is wired at harness fidelity — and note it is **not** an
A* cost term in the harness either, despite how the port plan phrased it. It is a scoring term plus
one hard veto:

| Site | Use | Scale |
|---|---|---|
| bot death edge | `recordDanger` on the death cell + its 8 neighbours; a bot that died holding a cover corner also poisons that corner's anchor and peek | `DANGER_DEATH_WEIGHT` 1.0 |
| `recordBotAllyHit` | one cell, no spread (weaker evidence) | `DANGER_HIT_WEIGHT` 0.35 |
| `findFleeGoal` | maximized score, danger **subtracts** | `DANGER_FLEE_SCALE` 6 |
| `choosePatrolResumeGoal` | minimized score, danger **adds** | `DANGER_PATROL_SCALE` 4 |
| `nearestSeekablePack` (`_psVisit`) | danger-inflated distance drives selection; the returned `dist` stays raw metres | `DANGER_PACK_SCALE` 3 |
| `attachMedicNavCost` | minimized cost, danger adds | `DANGER_PATROL_SCALE` 4 |
| `findCoverCorner` | `dangerBlocksCover` hard veto at 0.35 (below the 0.4 neighbour-spread share, so spread vetoes too) | — |

Every read site hoists `hasDanger(field, team)` out of its loop, so a clean team pays one Map lookup
for a whole scan. Records decay with a 25 s half-life on read (no timers), and the field is cleared
whenever a grid is adopted, since its keys are cell indices.

### Routing, and what happens outside the zone

`botNavGridCovers(x, z)` is the new gate: true when `botNavGrid` exists **and** either it is the
shoot-house full-map bake (`botNavZone === null`, the grid *is* the map) or the point is inside the
zone by `BOT_ZONE_EDGE_MARGIN`.

- `requestBotPath` uses the persistent grid when the bot is covered, else the local window (goal
  clamped into it) exactly as before.
- `botNearestWalkableToBot` likewise; both now share one `buildLocalNavWindow(center)` helper.
- `nearestWalkableInGrid` was a full-grid brute-force sweep — fine on 576 cells, 65k on the zone
  grid. It now scans a ±32-cell window first and accepts that answer only when it falls within the
  window's inscribed radius (in which case it provably *is* the global nearest), falling back to
  the full sweep otherwise. Exact, just usually cheap.
- `squadCorridorClear` picked its walkability predicate off `botNavGrid ? botNavWalkable : …`;
  `botNavWalkable` is the shoot-house flat-floor test and would have been wrong the moment a
  terrain grid existed. It keys off `NO_ENVIRONMENT` now.
- Patrol/explore on terrain is unchanged in *intent* (no authored patrol ring means directional
  explore goals) but now routes over the zone grid wherever the bot is inside it — slope cost,
  region labels and all — instead of hopping 36 m windows.

The Combat Bots panel's static "no nav grid on this map" note is now a live readout
(`refreshBotNavNote`): static bake / bake progress percentage / zone size and corner counts / "spawn
a bot to bake the zone".

### Shoot-house is untouched

The `NO_ENVIRONMENT` static bake block is the same call sequence it was; `botNavZone` stays null
there, so `botNavGridCovers` is unconditionally true and every path takes the static-bake branch as
before. `updateBotNavZone` returns immediately when `NO_ENVIRONMENT`. The only shared-code changes
that reach it are the `finalizeNavGrid` refactor (identical output, asserted by test) and the
corner-map same-cell guard (drops records that could never be selected).

### Known consequences and what is deferred

- **Cell-denominated radii read 3× larger on the zone grid** than on shoot-house's 0.5 m grid:
  `fleeSearchRadius` 5 cells is 2.5 m indoors and 7.5 m on terrain; `BOT_RECOVERY_CELL_RADIUS` 2 is
  1 m vs 3 m. Left as-is on purpose — a 2.5 m flee hop is meaningless on open ground — but it is a
  scale change worth watching in QA. `COVER_SEARCH_RADIUS` (10) is already metres and unaffected.
- **Bot-vs-bot fights far from the player** get no cover, crest or danger, because the zone follows
  the player. Multi-zone or centroid-of-conflict anchoring is a follow-up, not this phase.
- **Sight blockers are dressing-only.** Authored map structures that are mesh-only (not in the
  dressing index, not tall enough to register in the height field) produce no wall corners. A
  BVH-raycast blocker bake is the fallback the cover/corners plan already sketched.
- **`rowFor` stays unused.** It is the one lazy-field call that scales badly; if a future consumer
  wants whole rows, re-measure first.
- **Browser bake cost is unmeasured.** The Node predicate is 0.2–0.9 µs/cell and the real one adds a
  cached BVH capsule sweep. The 3 ms/frame budget makes wall-clock duration a non-issue (65k cells
  is ~1–2 s of background frames), but the first zone bake after a map load does more first-time BVH
  sweeps than any prior code path.

## Phase E: bot mount carries, stow, grenade wind-up (2026-07-30, `environment-viewer-v2.html`)

The third-person bot weapon mount was static: `weaponAdjust` got `def.thirdPersonHold` verbatim, so a
sprinting bot held its rifle exactly like a standing one, and a crouched one held it at standing
height. This slice ports the harness's mount surgery. All of it lives in the mount block of
`environment-viewer-v2.html` (`destroyEnvironmentBotWeaponMount` through `syncEnvironmentBotWeaponMounts`),
is host/solo-side only, and is purely visual â€” no FSM, ammo or damage path reads any of it. Guests
render bots through `GhostRenderer`, which does not run this code.

### 1. Locomotion carries (`weapon-hold-resolver.js`)

`updateEnvironmentBotWeaponMount` now resolves the hold the same way `bot-viewer-v2.html:1462` does:

```js
_envMountLoco.stance  = rec.stance ?? STANCE_STAND;      // bot-stance.js latch, already on the rec
_envMountLoco.aiming  = !!rec.weaponAimPoint;            // env's existing "gun is up" signal
_envMountLoco.moving  = Math.hypot(bot.velocity.x, bot.velocity.z) > CARRY_MOVING_SPEED;
const locomotion = locomotionFor(_envMountLoco);         // idle | walk | run | dash | aim
rec.carryBlend   = rec.carryLocomotion == null           // snap on frame 1 / after a weapon swap
  ? snapCarryBlend(rec.carryBlend, carryDeltaFor(mount.def, locomotion))
  : stepCarryBlend(rec.carryBlend, carryDeltaFor(mount.def, locomotion), dt);
const hold = resolveWeaponHold(mount.def, rec.stanceWeights, rec.carryBlend, _envMountHold);
```

Two axes, combined differently, exactly as the resolver documents. **Stance** (`rec.stanceWeights`,
the eased `{crouch01, prone01}` that `applyStanceHeight` already computes for the rig) lerps the
authored `thirdPersonHold`/`crouchHold`/`proneHold`. The resolver also honours a `kneelHold`, but
env-viewer-v2 never sets `kneel01`, so its bots stay on the three-stance path. **Locomotion** is an
additive delta eased on top
at `CARRY_BLEND_RATE` (9/s, ~180 ms). Two consequences worth knowing:

- Bots now also get the **stance** holds, which environment-viewer-v2 never applied before. This is
  correct and free â€” the mount root is `terrainHeight(x,z) + 1.5`, the ground-anchored,
  stance-invariant frame the holds were authored in â€” but it is a visible change beyond the carries.
- `locomotionFor` returns `aim` whenever `weaponAimPoint` is set, and the aim carry delta is zero, so
  a firing bot never holds a carry pose and `environmentBotWeaponMuzzle` is unaffected while aiming.
  During the ~180 ms blend *out* of a carry into aim the gun is mid-pose, but
  `alignEnvironmentBotWeaponToPoint` still solves the barrel onto the target, so shots stay honest.
  (The harness behaves identically; `!carrying` guards the solve in both.)

One deliberate divergence: the harness derives `aiming` from the FSM state (`BOT_AIM || BOT_FIRE ||
BOT_FLEE`), so a bot fleeing from nothing still holds its gun up. env keeps its existing
`weaponAimPoint` signal — set exactly when the sentry resolved a *visible* target this tick — which is
also what already gated the barrel solve. A fleeing bot with no visible target therefore shows the run
carry here and an aimed hold in the harness. It cannot fire in that state either way (`err` is
`Infinity` without a target), so this is a pose difference only.

The one-handed dash tuck is ported too: on `STANCE_DASH` the support hand comes off the weapon and
tucks at the chest (`DASH_HAND_FWD/SIDE/UP`), written *after* `controller.update` so it wins over the
grip targets, and released when the carry stops being one-handed. Unlike the harness's shared
`_dashHand` scratch, env keeps a **per-rec** target object (`rec.dashHandTarget`) â€” `setArmTarget`
stores the reference, and a shared vector would alias across every bot in the roster.

Pistol walk/run carries are still unauthored upstream (`CARRY_PRESETS.pistol` exists but was never
tuned against a body); sidearms therefore keep their current look. No poses were invented here.

### 2. Sidearm stow visuals

Whatever the bot is *not* holding rides its body: long guns slung on the back, pistols on the right
hip (`PISTOL_IDS` from `bot-sidearm.js` picks which). Placement values are copied verbatim from the
harness (`bot-viewer-v2.html:1558`), including the `scale` convention:

| Slot | position (torso-local, m) | rotation (XYZ, rad) | scale |
|---|---|---|---|
| `back` | `[0.02, -0.06, -0.20]` | `[-PI/2, 0.61, 0]` | `0.95 x thirdPersonHold.scale` |
| `hip` | `[0.22, -0.32, 0.02]` | `[PI/2, 0.25, 0]` | `0.95 x thirdPersonHold.scale` |

`scale` multiplies the weapon's authored hold scale (rifles 2x, pistols 0.68x) â€” a flat number would
render a slung rifle at half size. The transform is `torso.position + yawÂ·offset` with rotation
`yaw Â· euler(rotation)`, matching `flushStowedWeapons`.

Where env **diverges from the harness**: the harness has an instanced weapon-batch pool
(`weapon-part-batches.js`) and stows a 2-part vertex-coverage LOD of the gun into it.
`environment-viewer-v2.html` has no such pool â€” its held mount is a per-bot `skeletonClone`. So a stow
prop is a second cheap `skeletonClone` of the **same** `lbWeaponModelCache` template (shared
geometry/materials, `castShadow` off, no pose controller, no IK, no anchors), built lazily by
`requestEnvironmentBotStowProp` and then **kept for the bot's life**, toggled by visibility rather
than rebuilt. That is what makes the grenade wind-up below affordable: a bot that throws repeatedly
reuses one clone instead of re-cloning every 420 ms.

Swapping is implicit: `rec.weaponId` is the gun in hand, so when the sidearm is drawn the held mount
rebuilds on the existing token machinery and the primary appears on the back the same frame.

### 3. Grenade wind-up

The harness "swaps its mount to the grenade" via `setBotEquippedWeapon('grenade')` â€” but `grenade`
has no `thirdPersonHold` and no entry in `weapon-anchors.json`, so `createBotWeaponMount` bails and
the harness actually winds up **empty-handed**. env shows the real thing instead, without touching
the async mount machinery at all. During `rec.grenadeThrow`:

- `environmentBotHeldWeaponId(rec)` reports `'grenade'`, so the stow set covers both guns and the
  primary appears on the back;
- the held `weaponRig` is simply hidden (`visible = false`) â€” `rec.weaponId` never changes, so no
  mount is destroyed, no token is spent and no GLB is re-requested;
- the right arm is driven to a cocked-back target (`GRENADE_WINDUP_HAND`) and the left is released
  from the (now stowed) gun, both written after `controller.update`;
- a grenade prop â€” one more `skeletonClone`, `GRENADE_HAND_SCALE` 0.22 of the 0.62 m normalization â€”
  follows `body.joints.rightHand`, so it sits in the hand regardless of IK reach.

`updateGrenadeThrow` clears `rec.grenadeThrow` on release, and death/evade clear it too; on top of
that `hideEnvironmentBotProps` runs on the dead branch, so a bot killed mid-wind-up cannot leave a
grenade floating in its hand.

### LOD and lifecycle

The LOD gate moved **above** the mount lookup so the new props stride and hide on exactly the same
tiers as the held gun (`BOT_RENDER_LOD` near/mid/hide, `rec.lodPhase` stagger). The dt accumulator
moved from `mount.lodDtAccum` to `rec.mountDtAccum` for the same reason â€” it has to survive a mount
rebuild now. `hideEnvironmentBotProps` (dead, or past `hideD2`) hides every prop, releases both
overridden arm targets and nulls `rec.carryLocomotion` so the carry snaps rather than glides when the
bot comes back. `destroyEnvironmentBotProps(id)` is called from `despawnBot` only â€” a weapon swap
rebuilds the held mount but must keep the body props.

### Tunables

| Name | Value | Effect |
|---|---|---|
| `CARRY_MOVING_SPEED` | 0.35 m/s | above this a standing bot shows the walk carry, not idle |
| `CARRY_BLEND_RATE` (resolver) | 9 /s | ~180 ms carry ease, matched to the stance blend |
| `DASH_HAND_FWD/SIDE/UP` | 0.16 / 0.14 / -0.04 | freed support hand on a dash |
| `STOW_PLACEMENTS.back/hip` | see table above | slung / holstered transform |
| `GRENADE_HAND_SCALE` | 0.22 | grenade prop size (x the 0.62 m normalization) |
| `GRENADE_WINDUP_HAND` | back -0.30, side 0.22, up 0.30 | torso-local cocked-hand offset |

### Deferred

- **Pistol walk/run/dash carries.** Unauthored upstream; authoring belongs in
  `weapon-animation-viewer.html`, not here.
- **No stow LOD.** The harness drops a stowed gun to its 2 biggest sub-meshes; env clones the whole
  model because it has no part-level pool to drop into. Worth revisiting if stow props show up in a
  bot-count profile.
- **Guests see none of this.** `GhostRenderer` renders bots from the wire pose and does not run the
  mount path, so a guest sees no carries, no stowed guns and no grenade. Replicating it needs new
  wire fields and is out of scope for this slice.
- **Wind-up arm is a static target, not an arc.** The hand snaps to one cocked pose and the IK glides
  into it; there is no authored throw animation.

## Phase E: ragdolls, team colors, overhead indicators (2026-07-30, `multiplayer.js` + `bot-entity.js`)

The body-visuals half of Phase E. Everything here lands in `GhostRenderer` (env-viewer bots render
**only** through it), so host, solo and guest all get it from one implementation. Full API notes in
`docs/subsystems/multiplayer.md`; this section is the bot-side summary and the wire contract.

### Three new wire fields

All additive, emitted from `toWirePose` **only when a caller stamped them**, and optional with safe
renderer defaults — a viewer that never stamps any produces the exact wire pose it always did.

| Field | Stamped at | Consumer |
|---|---|---|
| `team` (`'alpha'`\|`'bravo'`) | already on the entity — `spawnBotAt` and the respawn branch set `bot.team = teamId` | `botBodyStyle` → the ghost body's shell/plate/trim |
| `alertTier` (`'seen'`\|`'heard'`\|`'push'`\|`'near'`\|`null`) | `rec.bot.alertTier = rec.alertMarkMode` beside the existing `rec.alertMarkMode`/`alertScore` writes in the alert-ring block; cleared to `null` on the death edge | the overhead "!" mark |
| `deathImpulse` (`[x, y, z]`, magnitude = m/s) | `rec.bot.deathImpulse = rec.lastHitImpulse` on the death edge; `rec.lastHitImpulse` is refreshed in `recordBotAllyHit` by `shotImpulseXZ(threat, victimXZ)` (shot-travel direction × `BOT_DEATH_KNOCKBACK` = 7, with a 0.25× upward component) | kicks the death ragdoll once, on the alive→dead edge |

`_lerpPlayers` needs no change: it returns `{ ...pb, … }`, so any field on the newer snapshot rides
through. `team` is stable for a life; `alertTier` correctly disappears the moment the host stops
sending it; `deathImpulse` only exists while the bot is dead (respawn builds a fresh entity).

`hp`/`maxHp` needed no new field either, but `updateHostPlayerGhosts` was only merging `alive` into
its bot poses — it now merges `hp`/`maxHp` from the same `playerCombat.getSnapshot` call. The guest
path already had them via `mergePlayerCombatFields` inside `getState()`.

### Team colors

`botBodyStyle(THREE, id, team)` returns the harness's authored side palette (mirroring
`bot-viewer-v2.html`'s `BOT_TEAM_DEFS`, exported as `BOT_TEAM_STYLES`) instead of a per-id hue:
alpha = green family (`0x1f5b3a` / `0x101410` / `0x57d68d`), bravo = red family (`0x64252a` /
`0x171012` / `0xff8a80`), the harness `facing` color landing in the ghost's `trim` slot. Per-bot
variation stays as an id-keyed 0.86–1.14 brightness scale inside the family. **Both** body paths use
it now — previously only the instanced path was colored and every non-instanced bot was the same
fixed dark green. A pose with no `team` keeps the old distinct-hue-per-id fallback.

### Ragdoll deaths

Bots use the real solver (`ragdoll.js` / `ragdoll-body.js`) instead of the canned tip-over; humans
keep the tip-over. Seeded from the rig's live joints at the moment of death (`ragdollFromBody`),
kicked by `deathImpulse` (`applyDeathImpulse`), stepped against the renderer's own `terrainHeight`,
and slept at the harness's thresholds (`kineticEnergy < 1e-4` held for 500 ms). At most
`maxLiveRagdolls` (12) corpses are stepped at once; a death past that falls back to the tip-over.
**The instanced path needed no fallback** — `setRagdollPose` writes the same part transforms the gait
solve does and `flush()` walks the same placeholders, so a corpse rides the shared `InstancedMesh`
pool like any living bot. Corpses hold their settled pose until the record disappears; respawn and
despawn both retire the solver and release its budget slot.

### Overhead indicators

Harness-style billboarded health bar (only while damaged) and alert "!" (only while `alertTier` is
live), hidden past `overlayHideD2` (default `min(60², botLod.hideD2)`). Colors match the harness
(`ALERT_MARK_COLORS`, and the green/amber/red HP thresholds at 0.55/0.30). Shared geometry and
materials built lazily; one `Group` per bot, parented to its ghost container so it dies with it; the
billboard is derived from the camera **position** the renderer already holds, so no new constructor
option and no per-frame allocation.

### Deferred

- **No blast-specific ragdoll launch.** `applyBlastImpulse` (radial + upward pop) is not wired; a
  grenade/RPG death reports the blast direction through the same `deathImpulse` vector and gets
  `applyDeathImpulse`'s directional shove instead of a tumble. Wiring it needs a 3D blast origin on
  the wire — `recordBotAllyHit` only receives an XZ threat point.
- **No per-weapon knockback.** `weaponKnockback(weapon)` exists in `ragdoll-body.js` but the stamp
  site has no weapon def in hand, so `BOT_DEATH_KNOCKBACK` is a single constant.
- **No escalation-score digit** beside the "!" (the harness draws one from a canvas texture).
- **No corpse cap / cull.** The harness retires old corpses (`botCorpseCap`); here a corpse lives as
  long as its bot record does, which the env viewer already bounds by respawning bots.
- **Deaths with no recorded hit** (fall damage, or a kill that never went through
  `recordBotAllyHit`) fall back to the pose's replicated velocity, then to a small shove down the
  bot's facing.

## Phase E: audio gating, FX pooling, knife

Wave 2 of the harness port (`environment-viewer-v2.html` only; v1 untouched).

### Bot combat audio gating

Every *positional* bot / remote combat voice now goes through one gate, `playAtCulled(eventId,
position, kind, maxPerWindow)`, a port of the harness's layer (`bot-viewer-v2.html:140-177`):

1. **Distance cull** — squared-distance test against the listener (`playerCollider.end`, else the
   camera) before any Web Audio node is built. `audioCullDist(kind)` picks per map: the shoot house
   keeps the harness's arena numbers (`AUDIO_CULL_ARENA` — gunshot/launch/explosion 70 m, impact
   60 m, step 26 m), the outdoor map uses each class's own panner-profile `maxDistance`
   (`AUDIO_CULL_OUTDOOR` — gunshot 250, launch 220, impact 100, step 30). An `inverse` panner
   *clamps* at `maxDistance` instead of reaching zero, so that is exactly where the fade ends and a
   distant firefight is still faintly audible up to it. `explosion` is the exception: the shared
   `largeExplosion` profile clamps at 1100 m and never fades, so its 420 m cull is a deliberate
   budget bound, not the profile's range.
2. **Voice budget** — `sfxBudgetOk(eventId, maxPerWindow, windowMs = 100)`, one rolling window per
   event id shared by all bots. Harness-identical caps: gunshot 8, impact (`bullet_impact` /
   `enemy_hit`) 8, launch 4, `knife_swing` 4, `footstep` 4, explosion 3.
3. **Procedural fallback** — a loaded sample always wins (`envAudio.hasSfxEvent`); otherwise
   `synthVoice(eventId)` from `weapon-sfx-synth.js` is played via `envAudio.playSynthAt`, so
   `rocket_launch` / `explosion` / `grenade_throw` / `grenade_bounce` are never silent.

`combatSfxProfile(kind)` (the arena-vs-outdoor panner picker) is unchanged for
`gunshot`/`launch`/`explosion` and gained `impact` and `step` entries; `playAtCulled` calls it.

Routed through the gate: bot/remote gunfire (`applyCombatIntent`, and the guest's `fireSeq` remote
shots), bot grenade launch (`releaseGrenade`), explosions (`applyExplosionBlast`), all impact cues
(`spawnShotEffects`, `spawnMeleeImpact`, `applyHitDamage`, the guest's `hit_spark` pass).

**Not gated:** the human player's own first-person shot report is `envAudio.play(...)` —
non-positional, never distance-culled and never budget-culled. Same for `player_damage`.

**Bot footsteps** are ported (`updateBotFootstepSfx`, harness `bot-viewer-v2.html:2532`): a 1.7 m
stride accumulator per bot fed from `capsule.start`, called every frame from the bot loop after
`botTickOne`. It needs no animation hook — the capsule is the source, and it is not think-strided.
Panel toggles `botAudioEnabled` and `botSynthSfxEnabled` sit in the bots section.

### Effect entity churn

`effect-renderer.js` already pools everything it owns (line/point buffers plus two sprite pools), so
the per-shot churn was **not** in the renderer and **not** muzzle flashes — bots never spawn one
(`spawnLocalMuzzleFlash` is a first-person-only view effect). It was the entity façade:
`entityRegistry.renderList(e => e.type === 'effect')` ran **every render frame** and re-serialized
every live effect, allocating a fresh wire object plus 3-4 fresh arrays each, on top of `list()`'s
two array allocations.

Fix (host/solo render side only): effects never move or change after creation
(`EffectEntity.update` only advances `age`), so `createEffectEntity(init, nowSec)` serializes the
wire **once** at spawn into `hostEffectWires`, and `liveHostEffectWires()` compacts that array in
place each frame against `entityRegistry.get(id)` (a Map lookup, no allocation). `MAX_EFFECT_ENTITIES`
(220, ≈110 hitscan shots in flight) caps the array; a new effect past the cap destroys the oldest.

**Replication is unchanged.** `snapshot()` still walks the registry and serializes independently, so
guest upserts are byte-identical; the cap only produces an ordinary early `removes` tombstone, which
guests already handle. The guest render path (`mpPendingEffects`) is untouched.

### Bot knife (last rung of the dry ladder)

Phase C's note that "env has no bot melee fire path" was wrong: `applyCombatIntent` resolves
`mode === 'melee'` (skips the magazine, resolves the short ray, draws `spawnMeleeImpact`).
`botKnifeSecondaryEnabled` is now a `let`, default **on**, with a panel checkbox.

Ladder position, harness-faithful — the dry rungs run **primary → sidearm → knife → flee**:
`bot-sidearm.js`'s `outOfAllAmmo` decides "dry"; a spent primary with a loaded pistol swaps
(`updateBotWeaponSlot`), a bot with both slots empty raises `knifeRequested`, and
`chooseBotStateName` returns `BOT_KNIFE` above the flee rungs. Only a knife commit that times out
(`KNIFE_COMMIT_MAX_MS` 12 s, then `KNIFE_COMMIT_COOLDOWN_MS` 6 s of `rec.knifeBlockUntil`) drops the
bot through to flee — both constants already existed and were dead until now.

- `updateKnifeMovement(targetDistance, nowMs)` — paths to `standoffGoalFromTarget(target,
  knife.range * 0.72)` (that helper was also dead-but-correct since Phase C) and stops inside blade
  range. No entry distance gate: a dry bot charges from anywhere, the commit cap is the backstop.
- `fireBotKnife(targetDistance, nowMs)` — builds a `combat_intent` with `weapon: 'knife'` and goes
  through `applyCombatIntent`, which stays the only fire path. The fire-rate gate applies and is
  correct for melee (`validateShot` against the knife's 1500 ms `fireIntervalMs`). It deliberately
  does *not* call `recordBotShotResult`: that is the blocked-**shot** heuristic (blacklist cover,
  reposition for a clear muzzle) and a 2 m blade landing on a wall is not a firing-position problem.
- **In hand vs slot.** `rec.weaponId` always stays the *firearm* slot so the swap/reload ladder keeps
  operating on the gun the bot goes back to; `rec.knifeOut` is the harness's `equippedWeapon`, and
  `environmentBotHeldWeaponId(rec)` now reports `grenade → knife → weaponId`. The held id is written
  last in the tick so a same-frame slot swap cannot overwrite it.
- **State-code tracer stays truthful**: `mag`/`reserve` read `rec.weaponId` (the dry firearm), so the
  `knife-needs-dry` rule still holds, and slot 1 is `K` from the FSM name.

**Visual gap (reported, not invented):** `weapon-anchors.json` has **no `knife` entry**, so
`createEnvironmentBotWeaponMount` bails on the missing `ikAnchors` and the IK weapon mount cannot
hold a knife. Until the knife is authored there it rides the right hand as a plain prop
(`updateEnvironmentBotKnifeProp`), exactly like the grenade wind-up prop: position from the rig's own
`rightHand` joint, scale from the knife's authored `thirdPersonHold.scale`, rotation body-yaw only.
Both firearms stow on the body while it is out and the firearm rig is hidden. Blade orientation is
therefore approximate — authoring `knife.ikAnchors` (grips + a blade tip) is what removes the
approximation and enables a real knife pose/attack sequence.

### Dead code removed (Phase A leftovers)

`findPlayerHit` (unused `combat.js` import), `chooseBotState` (unused `bot-activity.js` import,
superseded by `chooseBotStateName`), `mapOverlayLabel()`, and the `_fireEye` scratch (harness
remnant — env's `fireBotShot` reads `bot.capsule.end` directly). Each had exactly one occurrence in
the file: its own declaration.

---

## Bot appearance redesign — design spec + studio (2026-07-31)

Bot bodies are no longer the rig's hardcoded default look. `player-procedural-body.js` gained a
`design` option (exported defaults `BODY_DESIGN_DEFAULTS`; every field matches the old hardcoded
geometry, so callers that omit it render the identical body) plus a `gear` accessory system —
primitive descriptors (lathe/box/sphere/cylinder/capsule/torus/cone) parented to core parts through
inverse-scale anchors, shared-geometry cached, instancing-compatible. Full field reference:
`docs/subsystems/procedural-body-weapon-contracts.md`.

- **`bot-body-design.js`** — the bots' spec, `BOT_BODY_DESIGN`. Second pass (2026-07-31) replaced
  the placeholder shapes with modelled ones and gave the rig real material variation: a helmeted
  head sized to ~0.23 × 0.26 m with lens eyes, metal brow, vent slats, chin guard and temple bolts;
  extruded boots (~0.11 × 0.12 × 0.30 m) with a shaped rubber sole, toe cap, instep strap and
  ankle cuff, replacing a 0.16 × 0.06 × 0.35 m flipper; extruded gloves with the palm facing
  inward, replacing a lathe blob; pauldrons on the shoulder joints, sternum/collar/back plates,
  rubber belt, and spline-smoothed profiles throughout (`profileSmooth: 48`).
  `BOT_DESIGN_ADDONS` holds role markers — `visorSlit` (the slit face, deliberately NOT the
  general look) and `antenna` — composed via `botDesignWith(...)`; neither is wired to a role yet.
  `bot-viewer-v2.html` passes the spec in `createBotProceduralBody`; the dummy and the env-viewer
  bodies are untouched.
  Also owns the **body-kind switch** (2026-08-01): `BOT_BODY_KINDS` / `getBotBodyKind()` /
  `setBotBodyKind(kind)` pick between `armoured` (the Mark VII mech) and `soldier` (the clothed
  human of `bot-human-body.js` in a plate carrier, pads and helmet), and `botDesignForRole()`
  branches on it. It lives behind that one function because both viewers already reach the art
  through it and nothing else, so they agree by construction. `setBotBodyKind` returns true only on
  a real change, which is what tells a caller to pay for a rebuild. `SOLDIER_ROLE_DESIGNS` is the
  soldier-side role table; full contract in `procedural-body-weapon-contracts.md`.
- **`bot-body-versions.js` + `bot-bodies/`** — body and head as independent axes.
  `composeBot(bodyKey, headKey, headOpts)` crosses `BOT_BODIES` (the bare rig, four frozen
  snapshots of the design's history, then the live one) with `BOT_HEAD_KEYS` (`as authored`, the
  human face, the helmets). The snapshots are copies taken out of `versions/` deliberately, so that
  directory stays a manual undo history rather than an import path. Node-tested by
  `test-bot-body-versions.mjs`, which checks all 24 combinations and that `as authored` is a true
  identity — if it drifts, the frozen versions stop being trustworthy references.
- **`bot-human-body.js`** — the clothed unarmoured body (`HUMAN_BODY_DESIGN`), registered as the
  `human` branch of `BOT_BODIES` and headless by design so it must be paired with a head. Carries
  the kit (`SOLDIER_PADS`, `PLATE_CARRIER`, `SOLDIER_PACK`) and, since 2026-08-01, the human-scale
  role markers `SOLDIER_MEDIC_MARKS` / `SOLDIER_PACK_CROSS` / `SOLDIER_ANTENNA` / `SOLDIER_TUBES` —
  `BOT_DESIGN_ADDONS` cannot be reused for these, being authored against the mech's 500 x 360 mm
  chest block. All four are placed against PACK or CARRIER surfaces, so the composition guards on
  the role actually carrying one. Trouser
  and sleeve limb profiles, a matte non-glowing `cloth` uniform role, and belt/collar/cuff/boot-mouth
  edge pieces. Driven by four rounds of adversarial critique; the wrong reads it shipped on the way
  (wetsuit, cone, nappy, bobblehead, bracelet) are recorded in
  `procedural-body-weapon-contracts.md`. Node-tested by `test-bot-body-versions.mjs`.
- **`bot-face.js`** — a HUMAN head, as an alternative to the Mark VII helmet: skin-coloured skull,
  sphere eyes with pupils and catchlights, a side-profile nose, lips, ears and a hair cap, plus
  eight expression presets (neutral / determined / angry / shout / grin / worried / pain / dead)
  driven by six numbers that generate the brow, lid and mouth outlines. It brings five material
  roles with it — `skin` and `hair` are per-body tints the team colour never touches,
  `sclera`/`pupil`/`mouth` are shared. `withHumanHead(design, opts)` and `withHelmet(design, helmet)`
  swap heads by dropping every `anchor: 'head'` piece, carrying the skull fields along with the
  gear. Also carries the **head kit** — `SOLDIER_HELMET`, `SUNGLASSES`, `FACE_MASK` and
  `withHeadKit(design, { helmet, glasses, mask })`. **Wired into both viewers as of 2026-08-01**
  through the body-kind switch, though the armoured bot is still the default. The kit reaches the
  field only through `SOLDIER_ROLE_DESIGNS` in `bot-body-design.js` → `buildSoldierDesign` →
  `botDesignForRole`, which is the single function both viewers call: rifleman and medic get the
  helmet alone, technical helmet + mask, sniper helmet + glasses, and **squadleader the full kit —
  helmet + glasses + mask** (2026-08-03), the only role that covers both the eyes and the mouth,
  which is what makes it findable in a squad at a glance. Its `shout` expression still reads,
  because expression drives the brows as well as the mouth and the brows sit above the lenses.
  `test-bot-body-versions.mjs` asserts the per-role kit end to end — checking `bot-face.js` in
  isolation says nothing about whether a bot on the field gets it.

  Note when iterating: a page loaded before an edit to `SOLDIER_ROLE_DESIGNS` keeps serving the old
  design, because `botDesignForRole` memoises per `kind|role` AND the browser caches the module. A
  hard reload or a fresh `?v=` is required; a stale design renders perfectly and silently.

  The helmet shell is a single `type: 'dome'` piece (2026-08-03) — a surface of revolution cut at a
  per-azimuth height, so the bottom edge is a three-run staircase: flat over the brow at y 0.048, a
  shelf over the ear at 0.035, and the nape at −0.026, level right through dead-centre. That
  replaced a `lathe` plus a `helmetSkirt` box faking the rear drop plus a `helmetBrim` torus capping
  the rim; both are deleted. Retention straps are GENERATED from the skull by `strapOnHead()` rather
  than authored as boxes, and `strapAnchor` is computed between `headPoint()` and
  `helmetEdgePoint()` so it tracks the rim table. Exports for that: `headPoint`, `headNormal`,
  `helmetRimY`, `helmetEdgePoint`.

  `SUNGLASSES` is two 80 × 46 mm plates rotated ±0.62 rad about Y, plus a nose bridge and temple
  arms. 80 mm is the practical width ceiling: the plate is a flat chord against an elliptical face,
  so widening it lifts BOTH ends off the head, and past ~90 mm the outer corner runs off the widest
  part of the skull. Height is unconstrained, so growth goes there. `withHeadKit` DELETES the eye
  pieces when `glasses` is on (`HIDDEN_BY_SHADES`: eyeballs, pupils, catchlights, lids) — the
  eyeball stands 2.9 mm proud of the skull and the catchlight 3.5 mm proud of that, so any lens
  close enough to read as glasses sits behind them. The eyeball is mostly sunk, so removing it
  leaves skull surface rather than a hole.

  `mask` splits the nose instead of hiding it (`splitNoseForMask`). The ridge runs 16 mm below the
  gaiter's top hem and stands 4.5 mm proud of the cloth at its tip, so a masked head used to show a
  skin-coloured nose poking through. The extrusion outline is Sutherland–Hodgman clipped at
  `MASK_TOP_Y` into `noseTop` (`skin`) and `noseMasked` (`cloth`), overlapping by `NOSE_SEAM` either
  side of the cut so no gap opens at the join. Pulling the nose back instead is not an option —
  above the hem it is the face's strongest feature and shortening it flattens the profile.

  Helmet **and** mask together use `SOLDIER_HELMET_MASKED` instead of `SOLDIER_HELMET`. The straps
  are solved onto the SKULL and the gaiter stands 5–13 mm off the skull, so the whole retention
  system used to be inside the cloth: chin legs 8 mm in at the inner face, rear legs 5 mm, chin cup
  21 mm in and completely invisible. The cloth surface is exported as `maskRadius(y)` /
  `maskDepth(p)` / `maskStandoff(y)` (declared above the strap section, and `FACE_MASK` is built
  from the same constants so the two cannot drift). `soldierStraps(overMask)` regenerates the whole
  assembly against it: `standoffAt()` steps each sample out until a plate of that thickness keeps
  its INNER face clear, then `liftOffsets()` re-tests every chord midpoint and raises both ends of
  any segment still cutting in — a straight segment between two cleared points still sags into a
  convex surface — repeating until a pass moves nothing. Straps end up 5–10 mm further out; the top
  of the front leg, which runs above the hem, does not move. The chin cup is a 32 mm-deep box whose
  back is buried by design, so it is not lifted by the same test but shifted straight out by
  `HEAD_Z_SCALE * maskStandoff(y)`, keeping the 3.9 mm of proudness it has against bare skin.

  Node-tested by `test-bot-face.mjs`, whose real job is checking every
  forward feature clears the skull ELLIPSE (`headSurfaceZ`), not the lathe radius. Authoring traps
  and the failed first attempts are in `procedural-body-weapon-contracts.md`.
- **`bot-design-studio.html`** — **how to run a session is in `design-studio.md`**; what follows is
  the module's place in the system. The iteration harness the spec is authored in: a WebGPU page
  rendering design variants side by side through the same `createVisualSystem` bot materials and
  themes as bot-viewer-v2, driven either from its own control panel or from the console/browser
  automation. The panel gives sliders, number entries, dropdowns and colour pickers over every gear
  descriptor field plus the chassis proportions, with multi-select (list, `role:`/`anchor:`/`type:`/
  `id:` filter tokens, shift and ctrl ranges), per-field group semantics, undo, and Copy gear JS /
  Copy diff for pasting the result back into `bot-body-design.js`. A Head section switches between
  the human head (`bot-face.js`) and the helmets and picks the expression, skin tone and hair
  colour. Slot 0 is the editable copy and the rest stay on the shipped design as a reference. Details and the three rig constraints the
  panel is built around are in `procedural-body-weapon-contracts.md`.
  `window.__studio` API: `setSlots` (each slot takes `design`, `style`, `weapon`), `setAnim`
  (idle/walk/run/crouch/prone plus `aim*` variants), `setTheme`, camera presets, `setPaused`,
  `showLabels`, and — the two that make close review possible — `focusPart(name, {dir, side})`,
  which fills the viewport with one part's real world bounds including its gear children, and
  `measurePart(name)`, which reports a part's extents in ITS OWN frame (a world AABB inflates as
  soon as a pose rotates the part). Slots carry real weapon mounts reusing the game's GLB
  templates, baked anchors, `weapon-part-batches` and `weapon-pose-controller`, so designs are
  judged in a combat pose rather than a T-stance. Iterate there, then update `bot-body-design.js`.

Reviewing at lineup distance hides everything that matters: the near-black head, the buried eyes,
the faceted silhouettes and the invisible boot detail were all invisible until parts were framed
individually and measured. Use `focusPart`/`measurePart` per part, not a full-body screenshot.

### Harness spawn placement (2026-07-31, `environment-viewer-v2.html`)

Slot rotation is gone: bot placement is the harness's `findBotSpawnPoint` rejection sampler.
Anchored spawns disc-sample area-uniformly (sqrt radius) within the spread; free spawns take a
random walkable, main-region cell — preferring the team's map half on layout maps — and every
candidate must be `BOT_SPAWN_CLEARANCE` (1.2 m) clear of all live bots. `planSpawnAnchors` puts
reinforcements beside the squad they join (`BOT_SPAWN_SQUAD_SPREAD` 7 m) and forms each new squad
around one shared seed (`BOT_SPAWN_HOME_SPREAD` 6 m) — an authored team marker when the layout has
one, else a sampled point. A one-marker layout therefore forms squads up around the marker instead
of stacking the whole roster onto it. `botSpawnSlot` survives only as the gridless fallback
(authored marker, else player-relative golden-angle arcs, i.e. terrain before the first zone bake).

### Harness combat parity — aim/disengage (2026-07-31, `environment-viewer-v2.html`)

Nine divergences between env-viewer-v2's bot combat and the authoritative `bot-viewer-v2.html`
harness were closed. Where the two disagreed, the harness won.

**Awareness / aim**

- `botAimSettings` is now a plain `{ ...AIM_DEFAULTS }` (260 ms base / 12 ms per metre / 900 ms
  ceiling) instead of the env-only 700/40/2000 override. The "Notice time (s)" slider — which
  overwrote `reactionMs` from `botNoticeTimeSec` on every sentry tick and so pinned reaction to a
  UI value the harness has no equivalent of — is deleted along with its variable and DOM row.
- Aim priming (A10b) is ported: `primeAimAcquisition` stamps `aimPrimedUntil` (4 s window) when a
  live contact is torn down — on retarget in `updateBotSentry` and on occlusion outliving
  `reacquireGraceMs`. `updateAimAcquisition` passes `primed:` into `reactionDelayMs`, which scales
  the delay ×0.4, so a mid-fight re-sight is an attention shift rather than fresh recognition. The
  same call now also treats recent personal fire (`lastSelfThreatAt` within `AIM_UNDER_FIRE_MS`,
  4 s) as `alerted`, not just a scored squad tier.
- Target stickiness: `selectBotTarget` keeps the incumbent target unless it has lost its own line
  of sight or a newcomer is at least 30% closer (`TARGET_STICK_CLOSER_SQ`). Previously it was pure
  nearest-visible, so two enemies trading the nearest slot re-paid the acquisition delay forever.
- Line of sight now matches the bullet. `botHasLineOfSight` passes `heightAt: terrainHeight` (gated
  on `NO_ENVIRONMENT` exactly as `resolveWorldShot` does), so bots no longer see through hills that
  stop their rounds. The 120 ms per-bot occlusion cache (`botSeesCached`,
  `BOT_LOS_CHECK_INTERVAL_MS`, and the `losTargetId`/`losVisible`/`nextLosCheckAt` rec fields) is
  gone: the current target is raycast fresh every frame and candidates fresh on their scan tick,
  as the harness does.

**Disengage under fire**

- `currentFleeThreat()` resolves the remembered attacker first (`healThreatId` → live position via
  `getKnownPlayerState`, alive-checked) and falls back to the current target; `findFleeGoal` flees
  from that and only bails when neither resolves. `healThreatId` was written but never read, so a
  wounded bot with no live target found no threat, `findFleeGoal` returned null, and the bot
  latched `healArrived` standing still in the open.
- `recordBotAllyHit` no longer gates the victim's own reaction on resolving the attacker's
  position. `lastSelfThreatAt` and `beginBotHealthRetreat` run unconditionally (mirroring the
  harness's `applyBotDamage`); only the danger-field stamp, the casualty report and the ragdoll
  impulse — all of which genuinely need a bearing — stay behind the `threat` check.
- `botHealthSettings.retreatSearchRadius` (10) is added, and a wounded flee search uses
  `max(fleeSearchRadius, retreatSearchRadius)`.
- Stamps: `lastSelfThreatXZ` is recorded alongside `lastSelfThreatAt` (copied, since the report
  record is pooled), and the `push` alert tier seeds `lastKnownTarget` from the ally report when
  nothing firsthand holds the slot, so a pushing bot with no contact has somewhere to go.

**Host visibility**

`hostVisibleToBots()` is now just `fpsMode`. It previously required `fpsMode && !localBodyThird`,
which meant a host in the third-person body view could never become a bot target or be hit by a
bot round — bots ignored the person shooting them. A body in the world (first or third person) is
a valid enemy; only the orbit/dev camera, which has no body, stays invisible.

**Perf note.** Dropping the LOS cache means `botHasLineOfSight` — which builds obstacle columns and
runs the terrain march, both heavier than the harness's single BVH raycast — now runs once per bot
per frame for the current target plus once per candidate on each scan tick, versus roughly eight
times a second per bot before. This is the harness's cadence and was applied deliberately; if bot
counts make it a measurable frame cost, the fix is to make `botHasLineOfSight` cheaper (a dedicated
sight ray), not to reinstate the stale cache.

### Harness combat parity — cover (2026-07-31, `environment-viewer-v2.html`)

Bots hid for a few seconds and then walked straight back into the fight. The shared cover logic
(`bot-cover.js` plus the ported ladder in `bot-activity.js`) is a faithful port of the harness; the
divergence was entirely in the env-side INPUTS it is fed. The harness bakes one static 0.5 m grid
over a bounded arena and its threats are grid-walking bots; the terrain path here is a 384 m combat
zone at 1.5 m cells, re-anchored on the local player, with a human threat that is off-grid by
nature. Every fix below is env glue — no shared module was edited, so harness behaviour is
unchanged by construction.

**1. Cover seats were unreachable on the 1.5 m grid.** `COVER_ANCHOR_REACH` is 0.45 m, but
`findPath`/`followPath` only ever steer to cell CENTRES, and a 1.5 m cell centre can sit ~1.06 m
from the anchor. The bot parked, never registered arrival, hit the 6 s `coverCommitTimedOut`, got
its own corner blacklisted, and re-engaged. `updateCoverMoveMovement` now hands the tail of the
journey to `stepCoverAnchorApproach`/`coverAnchorLeg`, which walks straight to the exact
`anchorPos`. The leg is bounded by `max(BOT_WAYPOINT_REACH + cellSize, cellSize * 1.5)` (0.85 m at
0.5 m cells, 2.25 m at 1.5 m) and gated on `lineWalkable`, so it can never substitute for a path or
cut a wall corner. On a 0.5 m grid arrival already registered from the path itself, so this is
effectively inert for shoot-house.

**2. A threat on a bad cell fail-closed every corner.** `field.canSee` returns false for
out-of-bounds or unwalkable cells, so `coverCornerValid` invalidated every corner and
`pickCoverCorner` found none whenever the threat stood on a slope, a rock, on top of cover, or
outside the zone — which for the human player is most of the time. Both wrappers now route the
threat through `coverThreatOnGrid`, which returns the exact position when its own cell is walkable
(so nothing changes where threats already walk the grid), else the nearest walkable cell centre
within `COVER_THREAT_SNAP_CELLS` (4), else the bot's remembered last-resolvable cell
(`rec.coverThreatCell`, re-snapped so a rebake cannot leave a stale one). If nothing resolves,
`coverCornerValid` returns `true` — keep the current assessment rather than fail closed. The 0.35 s
`stepCoverGate` grace is untouched. The secondary threat snaps through
`coverThreatOnGridSecondary`, which never writes or reads the memory and drops to `null` when
unsnappable (it is a pure veto and already fails open).

**3. A zone rebake wiped all cover state mid-hold.** `adoptBotNavGrid` nulled every bot's corner,
peek and hold clocks, cleared the danger field and every blacklist on each 96 m player drift, so
the whole team abandoned cover at the same instant. It now carries across whatever is still
representable: committed corners are re-resolved against the new corner map by WORLD position
(`remapCoverCorner`, same `kind`, `peekDir` dot ≥ 0.7, anchor within 1.5 cells) and the hold plus
its claim survive; blacklists are remapped cell → world → cell (`remapCoverBlacklist`); the danger
field is replayed from the casualty ring (`restampDangerField`), each report keeping its ORIGINAL
timestamp so `bot-danger`'s read-time decay ages it exactly as before. Paths, medic floods and
patrol/flee goals are still dropped — they re-derive in a frame.

**4. The bake validated peeks that live LOS blocks.** The zone sight bake only turned dressing
circles ≥ 1.5 m across into rects, but live `botHasLineOfSight` raycasts tree trunks through
`obstacleColumnsAlongRay`. A bake-validated peek could therefore be trunk-blocked in play: the
holder peeked, saw nothing, and exited `stale`/`drought` at 5.5–6 s. `botTerrainOccluders` now
appends every trunk in the zone at the SAME radius the bullet columns use
(`TRUNK_RADIUS_PER_SCALE`), capped at `BOT_ZONE_TRUNK_CAP` (4000) biggest-first. Trunks are
occluders only: the field is baked over `occluders`, `buildCornerMap` still sees the rock-only
`rects`, so a tree never authors a lean-around corner and nav-corners' O(rects²) burial scan is
unaffected. Measured cost: `buildSightGrid` with 4000 extra trunk rects is +0.03 ms, and the gather
(chunk walk + dedupe + sort) is ~2–3 ms; both land in `finishBotZoneBake`'s synchronous tail
(already 100 ms+), not in the 3 ms/frame sampling budget. The gather time is logged live as the
`(N.N ms)` beside the trunk count in `[bot zone bake #N]`. **Residual:** rasterization marks a cell
only when a rect covers the cell CENTRE, and trunks are 0.53–1.32 m across on a 1.5 m pitch, so
only ~39% of them mark a cell (measured on a synthetic 384 m zone). This narrows the bake/live gap
substantially but does not close it; closing it fully would mean inflating trunk rects to a full
cell, which would make forests opaque to every LOS-based system and was not done.

**5. The danger veto footprint was 9× too large in area.** The harness paints the death cell plus
its 8 neighbours on a 0.5 m grid — a 1.5 × 1.5 m patch. On the 1.5 m zone grid the same rule paints
4.5 × 4.5 m, so two deaths blanketed a whole corner cluster (veto threshold 0.35, ~38 s decay) and
released bots could not re-hide. `paintDangerPatch` denominates the stamp in METRES: neighbours are
painted only when `cellSize * 3 <= DANGER_PATCH_M` (1.5). At 0.5 m cells that is the harness's
exact 3×3 stamp, bit-identical; at 1.5 m cells a single cell already covers exactly 2.25 m², the
same area the harness patch covers.

**6. Null-bake guard.** `coverCornerValid` gained the harness's `if (!visField || !navGrid) return
false` guard (bot-viewer-v2.html :7970), which the env wrapper was missing.

**Verified:** the extracted module script passes `node --check`; all 29 `test-bot-*.mjs` plus
`test-nav-grid`, `test-nav-visibility`, `test-nav-corners` and `test-nav-connect` pass (33/33).

## Trace-viewer live bridge (2026-07-31)

`bot-trace-viewer.html` is now shared by both apps: it streams from `bot-viewer-v2.html` (the
harness) *and* from `environment-viewer-v2.html` (the game) over the same contract, unmodified. Only
one may be streaming at a time — the channel has no sender id, so two live senders would interleave
rows from two different arenas into one map.

**Contract** (channel `bot-trace-live`, same-origin `BroadcastChannel`, no server):

| Direction | Message | When |
|---|---|---|
| viewer → game | `{type:'hello'}` | the viewer's `○ live` button is switched on |
| game → viewer | `{type:'snapshot', world, startedAt, hidden, rows, events}` | answer to `hello`; `rows`/`events` replay the last `BOT_LIVE_BACKLOG` (4000) |
| game → viewer | `{type:'rows', rows}` / `{type:'events', events}` | one batched message per frame, from `botLiveFlush()` |
| game → viewer | `{type:'world', world}` | the arena was rebuilt under the viewer |
| game → viewer | `{type:'vis', hidden}` | `visibilitychange` — rAF does not run for a hidden tab, so the sim genuinely pauses |
| viewer → game | `{type:'select', id}` | trace-viewer's "Go to bot viewer" button (aside, next to "Selected bot") |
| game → viewer | `{type:'selected', id}` | ctrl-click on a bot in the 3D scene |

Rows are the tracer's own change-triggered + heartbeat samples; `test-trace-viewer-row-parity.mjs`
pins the field names, and env's `pushBotTraceRow` emits all 22 of them.

**Cross-viewer selection (2026-08-02).** The `select`/`selected` pair syncs a single "selected bot"
between the two tabs, independent of camera state and simulation binding:

- Trace-viewer "Go to bot viewer" (enabled only while `liveOn && selected`) sends `{type:'select', id}`.
  `bot-viewer-v2.html`'s `botLiveOpen()` handler looks the id up in `botActorById` and, if found, calls
  `setSelectedBot(actor)` (visual only) *and* `setCameraMode(CAMERA_FOLLOW, actor)` — the same transition
  a plain click on that bot already performs.
- Ctrl-click on a bot in `bot-viewer-v2.html` (`renderer.domElement`'s existing `click` listener, ahead
  of the plain-click camera branch) calls `setSelectedBot(picked)` and broadcasts `{type:'selected', id}`
  without moving the camera — plain click already owns camera-follow/POV, ctrl-click is a separate,
  additive gesture. The trace-viewer's `ingestLive()` mirrors it onto `selected` and redraws, reusing the
  exact `buildBotList(); renderDetail(); draw();` triad its own click handlers use.
- The selected bot gets a glowing silver diamond above its head in `bot-viewer-v2.html`
  (`selectionMark`, `updateSelectionMark()`), built and animated exactly like the existing POV spot
  marker (`povSpotMark`): billboarded to the camera, stacked above the state orb/insignia/alert mark via
  `BOT_STATE_ORB_LIFT`, with the same slow sine-pulse opacity/scale. `selectedBotActor` is cleared
  wherever `botDebugFocusActor` already is (`removeAllBots`, `cullDeadBots`, `clearDeadBotActors`), so it
  can never point at a disposed actor.
- **Harness-only for now:** `environment-viewer-v2.html` (the game) only ever sends on this channel — it
  has no handler for an inbound `select` message, so "Go to" has no effect when the game, not
  `bot-viewer-v2.html`, is the live sender. Ctrl-click is a `bot-viewer-v2.html`-only gesture; there's no
  equivalent picker wired up in the game.

**Global hotkeys (`bot-viewer-v2.html`, 2026-08-03).** Bound in the same top-level `keydown` listener
as camera hotkeys F/O/V/G, guarded by the same "not typing in an input" check:

| Key | Action |
|---|---|
| H | `toggleBotStateCapture()` — start an all-bots take; press again to stop and save the TSV |
| L | `liveStreamBtn.click()` — same toggle as the **Live map** button (also starts recording if it wasn't running) |
| P | `setCameraMode(CAMERA_POV)` — alias for V |
| J | `copyRecentBotStateLog(10000)` — copy just the last 10s of the state log to the clipboard |
| Y | `togglePerfLog()` — start a per-frame perf take; press again to stop and copy the TSV |

`copyRecentBotStateLog` filters `botStateRecordLines` by parsing each line's `[MM:SS.mmm]` elapsed
stamp back to milliseconds (`parseBotRecordTimestampMs`, the inverse of `formatBotRecordTimestamp` —
lines only carry the formatted string, not a raw number) and comparing against `performance.now() -
botStateRecordStartedAt`. It swaps the filtered text into `botStateRecordView` to copy it (same
temporary-swap idiom as `copyTraceBtn`, since the filtered window differs from what's already
displayed), then resets `botStateRecordRenderedCount` so the next flush repaints the full live log.

**Env side** (`environment-viewer-v2.html`):

- `ensureBotTracer()` is the single idempotent tracer start. `?botTrace=1` awaits it at startup; the
  **Live map** button in the Combat Bots panel awaits it on first toggle, so live streaming works
  without the URL flag. `botTraceOn` (not `BOT_TRACE`) now gates the per-tick tracer calls and the
  string-building `patrolDebug` stamps that feed `window.botProbe`.
- `botWorldMeta()` is built from env's own bake, not the harness's globals:
  - `bounds` from the live `botNavGrid` extent (on terrain the grid **is** the combat zone) with
    `loadedMap.bounds` as the fallback.
  - `walls` / `covers` — env keeps one `botSightRects` list where the harness keeps two, so height
    splits it: top ≥ `BOT_LIVE_WALL_H` (2.0 m, above a standing bot) draws as wall, below as cover.
  - `heights` from `botNavGrid.heights` (already baked; re-sampling `terrainHeight` would mean tens
    of thousands of collider raycasts), downsampled to 192 on the long axis. Shoot-house reports
    `flat: true` because its floors are flat by construction.
  - `regions` — the harness's byte-per-cell base64 encoding, unchanged, so the viewer's
    fragmentation readout decodes it directly.
  - `patrolPoints` from `botPatrolRing`, falling back to `botSpawnPoints`.
- Events come from `bumpBotCombatCounters` — the one choke point every bullet, knife and blast hit
  passes through — as `kill` / `damage` rows in the harness's shape. Inert unless the tracer or the
  live map is on. (The viewer does not draw them yet; it derives deaths from the `D` state slot.)
- `botLiveFlush()` is called exactly once per frame, at the tail of `updateBots()`;
  `botLiveAnnounceWorld()` fires from `adoptBotNavGrid()` when a zone rebake swaps the grid.

## Below-terrain floor rescue (2026-08-03, `bot-entity.js` + `bot-viewer-v2.html`)

Fixes the physics half of BB-004 (`docs/bot-bugs-log.md`): a bot whose capsule ends up under the
ground stays there indefinitely, and because everything that gates combat on distance
(`selectBotTarget`'s `distanceSq > sightSq`, LOS, alerts) measures **3D** distance off the same
capsule, that bot silently becomes unkillable and blind while still patrolling normally.

**Why it persisted.** `bot-viewer-v2.html`'s generated terrain (`buildFloorMesh`) is a single thin
displaced sheet with a flat catch slab under it, so nothing that clips through falls forever. The
slab is real collision geometry: `mapCollider.resolveCapsule` re-grounds a tunnelled capsule on it
and reports `grounded: true`. Nothing then moved it back up — the viewer has no `lastSafePos`
fall-catch (that lives in `environment-viewer-v2.html`, and it only triggers while `!onFloor`
anyway). The bug is also nearly invisible: `player-procedural-body.js` recomputes the visible body's
height from `terrainHeight(x,z)` whenever `onFloor` is true, so the rig renders as if standing
correctly. Only the weapon mount and the per-bot facing indicator — which read
`bot.capsule.start.y`/the capsule midpoint directly — show the real position.

**The rescue.** `stepBotPhysics` takes a new option, `rescueHeightAt(x, z)`. When supplied, and
only in the `mapCollider` branch, it compares the capsule's rest height (`start.y`) against
`rescueHeightAt(x,z) + capsule.radius` immediately after `bot.onFloor = contact.grounded`. If the
capsule is more than `FLOOR_RESCUE_DEPTH` (0.75 m, exported) under that, both endpoints are lifted
by the same delta (preserving capsule height), a negative `velocity.y` is zeroed, `onFloor` is
forced true, `bot.floorRescues` (initialised to 0 by `createBotEntity`) is incremented, and one
`console.warn` names the bot, the depth and the XZ.

Design points worth not re-deriving:

- **It is a separate option from `heightAt`, deliberately.** `heightAt` is the no-collider ground
  snap and at least one caller (`environment-viewer-v2.html`) passes a height function that returns
  the **topmost** surface at (x,z). Reusing the name would have opted that caller in automatically
  and teleported bots standing legitimately indoors up onto the roof. Callers that pass neither
  option see byte-for-byte the old behaviour.
- **Reference height, not a raycast.** `bot-viewer-v2.html` passes `groundHeight` (i.e.
  `terrainField.heightAt`), the same O(1) baked field the terrain mesh is generated from, so the two
  agree by construction. `mapCollider.raycastDown` cannot even detect this failure — cast from a
  capsule already below the sheet it hits the catch slab and reports "ground found."
- **Threshold.** 0.75 m sits above the worst legitimate deviation (capsule-vs-slope geometry at
  `slopeLimitY = 0.5` is ~0.15 m and pushes the capsule *up*, not down; the real budget is
  mesh-vs-field interpolation slack, estimated at well under 0.35 m) and below the ≥ 1.00 m deficit
  guaranteed by a catch-slab rest. `TERRAIN_CATCH_SLAB_DROP` (1.0 m) and
  `TERRAIN_CATCH_SLAB_THICKNESS` (0.1 m) in `bot-viewer-v2.html` name what used to be a bare
  `lowest - 1.05` literal; the drop must stay comfortably above `FLOOR_RESCUE_DEPTH` or a slab rest
  reads as legitimate slope deviation and becomes undetectable.
- **Not gated on `onFloor`.** No legitimate state puts a bot's feet 0.75 m under the height field,
  grounded or falling, and the ungated form also catches a capsule that tunnels the (0.1 m) slab
  itself and would otherwise free-fall forever — the shape the 072210 trace analysis in
  `bot-bugs-log.md` reconstructed from `target_dist`.

**Wired at:** both `bot-viewer-v2.html` call sites — the hoisted `_updateBotPhysOpts` for the main
roster and the dummy-target loop, both passing `rescueHeightAt: groundHeight`.

**Not wired in `environment-viewer-v2.html`, on purpose.** Its `mapCollider` exists only for
authored maps, where `terrainHeight` is a top-down `mapCollider.raycastDown` returning the highest
surface — under a roof, lintel or mezzanine deck that is metres above the floor a bot is legitimately
standing on, so opting in would yank indoor bots onto rooftops. It also has no catch slab (a bot that
tunnels the authored floor free-falls into empty space) and already recovers that case via
`rec.lastSafePos` / `BOT_FALL_CATCH_DROP_M`. On procedural terrain it never builds a `mapCollider` at
all and runs the `heightAt` snap, which re-grounds every frame and cannot tunnel. Wiring it would need
a true ground-height function that is not `terrainHeight`.

**Not addressed here:** what makes a capsule tunnel the sheet in the first place. That is a separate,
still-unconfirmed question (swept/continuous collision, step size, push-out interactions); this change
only guarantees the state is recovered rather than permanent.

**Tests:** `node test-bot-entity-rescue.mjs` (34 checks) — lift/velocity/counter on a grounded
under-terrain capsule, the 0.74/0.76 m threshold boundary, no-op when `rescueHeightAt` is omitted, the
`heightAt` fallback path unchanged with and without the new option, the ungrounded free-fall case, a
settled bot not re-triggering, a NaN reference height being a no-op, and the warn throttle below. It
stubs `three/addons/math/Capsule.js` through `node:module`'s `registerHooks`, because this repo's local
`three` install ships empty `examples/jsm` files (the browser loads addons from a CDN importmap).

**Warn throttle + on-screen banner (2026-08-03, later).** Review flagged that the rescue's
`console.warn` had no throttle: if the still-unidentified tunnelling trigger ever turns out to be a
*persistent* condition (a bot stuck re-tunnelling the same seam every frame) rather than a rare
one-off, it would log every frame indefinitely. `bot.floorRescueWarnAt` is a per-bot, dt-banked
cooldown (`FLOOR_RESCUE_WARN_COOLDOWN_S`, 3 s) that gates only the `console.warn` — the lift itself is
never throttled, so every rescue still corrects the capsule and increments `floorRescues` immediately,
whether or not it logs. Banked by `dt` rather than a wall clock so the throttle stays exactly as
Node-testable as the rescue itself.

Because a throttled warning can no longer be trusted to surface every occurrence, `bot-viewer-v2.html`
now mirrors `updateNavWarnBanner`'s "stays on screen while load-bearing" pattern for this too: a new
`#floorwarn` HUD element (same row as `#navwarn`/`#fps`/`#score`, DOM writes only on text change) reads
`floorRescues`/`floorRescueWarnAt` across `botActors` each frame via `updateFloorRescueBanner()`. It
shows the count of bots currently within a rescue's cooldown window (i.e. rescued in roughly the last
`FLOOR_RESCUE_WARN_COOLDOWN_S` seconds) in an urgent orange-red, falling back to a quieter blue
"N recovered this session" once nothing is actively re-triggering. Scoped to `botActors` only — the
dummy targets also pass `rescueHeightAt` (so they're rescued and covered by the same warn throttle)
but are not counted in the banner.

## Terrain-tunnelling forensic ring (2026-08-04, `bot-forensics.js` + `bot-entity.js` + `bot-viewer-v2.html`)

The rescue above makes a below-terrain capsule transient instead of permanent. It does **not** say why
the capsule crosses the sheet in the first place, and that is still unknown. This is the instrumentation
for answering it from real data: a fixed-size ring of the physics leading *into* each fall, exportable
as TSV with one keystroke.

**Schema.** One `ArrayBuffer` with a `Float32Array` and an `Int32Array` over the same memory,
interleaved, stride 12 fields. `FORENSIC_RING = 1024` samples per slot (~17 s at 60 fps, at least 10 s
up to ~100 fps), `FORENSIC_MAX_SLOTS = 128`, so 6.29 MB, allocated once at creation and never grown.
Index of sample `p` of slot `s`, field `f` is `((s * ring + p) * 12) + f`. Per-slot metadata (`ids`,
`radius`, `writeIdx`, `count`) is written only on assign/release, never per frame.

| Field | View | Meaning |
|---|---|---|
| `t` | Int32 | ms, from `setNow(ms)` — one clock read per frame for the whole roster, not `performance.now()` per bot |
| `dtMs` | f32 | the clamped `dt` actually passed into `stepBotPhysics` |
| `preY` | f32 | `capsule.start.y` at entry, before gravity/translate |
| `postY` | f32 | `capsule.start.y` at exit, after collider + rescue |
| `velY` | f32 | `velocity.y` after the gravity increment — latched **before** the rescue zeroes it |
| `groundY` | f32 | the `rescueHeightAt`/`heightAt` reading already made this frame; NaN when neither ran |
| `x`, `z`, `velX`, `velZ` | f32 | post-step position and horizontal velocity |
| `stateKey` | **Int32** | the packed 9-slot FSM key, stamped every frame regardless of the state recorder (see below); -1 only before a bot's first `commitBotActor` this session |
| `flags` | Int32 | bit0 `onFloorIn`, bit1 `groundedRaw`, bit2 `onFloorOut`, bit3 `rescued`, bit4 `hasCollider`, bit5 `hasGroundRef` |

**`stateKey` must stay in the Int32 view.** The packed key from `bot-state-code.js` is
`STATE(13) x TIER(5) x SCORE(10) x ROLE(2) x ELEMENT(3) x AMMO(7) x HEALTH(5) x PACK(10) x LATCH(32)`
= 43,680,000 combinations, so its real maximum is **43,679,999**. Float32 represents integers exactly
only up to 2^24 = 16,777,216, so putting the key in the float view would silently corrupt real,
reachable state combinations — not a theoretical risk. `test-bot-forensics.mjs` case 6 exists purely to
fail a future refactor that moves it. (`t` as Int32 ms wraps after ~24 days of continuous uptime;
irrelevant for a real session.)

**`stateKey` is stamped unconditionally, not gated on the state recorder.** The key is packed once per
actor per frame inside `botStateDescriptor` (`bot-viewer-v2.html`), which is cheap — reused scratch
objects only, no allocation, no DOM work. It was originally reachable only through
`botStateRecording`-gated call paths, so a user who saw the `#floorwarn` banner and pressed `Shift+J`
without having separately turned on state recording got `state_key = -1` on every row, in exactly the
reactive workflow the feature exists to serve. Two independent reviews of the first cut caught this.
Fix: `commitBotActor` (the single per-live-bot-per-frame commit point, after every per-frame global has
landed on the actor) now calls `botStateDescriptor` directly and unconditionally, below the
`botStateRecording` gate rather than through it; `traceBotStateCode` still runs only when recording is
on and ends up computing the same key a second time in that case, which is accepted as cheap redundancy
rather than restructured away. Dummy targets never call `commitBotActor`, so their `state_key` stays -1
— expected, since they carry no FSM state to encode.

**Derived only at export time**, never stored per sample:

- `gap = ground_y + radius - post_y` — exactly the quantity the rescue thresholds against
  (`FLOOR_RESCUE_DEPTH`, 0.75 m). The frame where `gap` crosses it is the frame the rescue fired.
- `ext_dy = pre_y[n] - post_y[n-1]` — **the key forensic column.** Nonzero means something *outside*
  `stepBotPhysics` moved the capsule between frames (the pair-pushout re-resolve in `updateAllBots`,
  stance capsule scaling, a teleport). Zero while `post_y` still dives means the integrator itself
  stepped through the sheet in one frame. Those are different bugs with different fixes.
- `speed_xz` — `hypot(vel_x, vel_z)`.

Deliberately excluded: `navRegion` (derivable offline from x/z, and already in `botStateTrace` at 1 Hz),
BVH contact detail beyond `grounded` (`map-collision.js`'s `resolveCapsule` does not expose more), and a
running `floorRescues` total (reconstructable from the `rescued` bits).

**Why the sample is taken inside `stepBotPhysics`.** That is the only place `preY`, the integrated
`velY` *before* the rescue zeroes it, the raw `contact.grounded` *before* the rescue forces `onFloor`
true, and the already-computed ground reference all exist at once. Sampling from the caller would need a
second ground-height call per bot per frame and would lose the two pre-rescue values outright. The
function latches those locals where their value still exists and makes exactly one `forensics.sample(...)`
call at the end; with the option absent, behaviour is unchanged (`test-bot-forensics.mjs` case 3 proves
it by twin comparison across six branch shapes, and `test-bot-entity-rescue.mjs` still passes 34/34).

**Recording is continuous for every live bot from its first physics step.** Slot assignment is
lazy-on-first-sample, but recording is *not* gated on "has this bot been rescued before" — that would
mean a bot's first fall, the one nobody has diagnosed, is the one case with no captured lead-up. Slots
are released in `disposeBotActor` (the choke point `removeAllBots`, `cullDeadBots` and
`clearDeadBotActors` all funnel through) and in `removeDummy`; reassignment zeroes the ring counters so
a recycled slot carries no ghost history, and an `ids[slot] !== bot.id` guard reassigns rather than
letting one bot write into another's ring after a missed release. Past 128 concurrent entities a bot
gets `forensicSlot = -1`, `stats.droppedBots` increments once, and sampling for it no-ops — it never
throws, and the sentinel is sticky so the counter stays a count of bots, not of frames.

**Rescue auto-freeze.** A 17-second ring is useless if the take is overwritten before anyone reaches for
it. On any sample carrying the `rescued` bit, if no take is already pending, the whole slot ring is
copied into one preallocated 48 KB snapshot buffer (a single `TypedArray.set`) and marked pending.
Policy is **first unexported rescue wins**; exporting re-arms it. Later rescues while a take is pending
still move `lastRescue`, and the live ring keeps recording independently and stays separately
exportable. That also rate-limits the copy automatically: a bot re-tunnelling every frame costs one
memcpy total until the pending take is collected.

**Retrieval.** `Shift+J` copies the forensics. Plain `J` is unchanged (last 10 s of the state log) — the
existing `KeyJ` handler had no `shiftKey` check, so `Shift+J` was free. `KeyY`/`Shift+Y` (perf log) are
untouched. Scope resolves in priority order:

1. the pending frozen take, if one exists (the normal case — the `#floorwarn` banner appends
   `forensic take ready: <bot-id> — Shift+J` while one is pending, so the warning says what to press);
2. else the live ring of the most recently rescued bot;
3. else the live ring of the focused bot (`botDebugFocusActor ?? selectedBotActor ?? activeBotActor`).

Two buttons in the **State recorder** panel do the same thing — "Copy fall forensics (Shift+J)" (the
full ladder) and "Copy live ring (focused bot)" (step 3 only, for a bot that never fell). Output is TSV
staged through `perfLogCopy`, the same off-screen-textarea idiom the perf log uses, so the visible
state-log textarea is not clobbered; `#`-prefixed header lines carry bot id, slot, radius, capture time,
sample count and a legend for `gap`/`ext_dy`, matching the existing perf-log/trace export style. A NaN
`ground_y` renders as a blank cell, never the string `NaN`.

**Reading a take.** Three shapes to look for first, in this order:

1. **A `dt_ms` spike** on or just before the dive — a stall long enough that one gravity step crosses
   the sheet. Cross-check against the perf log's worst-frames list.
2. **A nonzero `ext_dy`** on the dive frame — the capsule was moved by something other than the
   integrator (the pair pushout re-resolving against walls, stance scaling), so the fix is there, not
   in the physics step.
3. **`x`/`z` clustering** across several takes — repeated falls at the same coordinates point at a seam
   or hole in the collision mesh rather than at a timing/velocity condition.

**Perf validation (for the project owner to run — no in-browser number is claimed here).** `?forensics=0`
disables the recorder entirely: it stays `null`, `_updateBotPhysOpts` never gets a `forensics` property,
and `stepBotPhysics` runs its exact pre-existing code path. That is the A/B control arm. Protocol:

- Same seeded Test-condition maze in both arms (`mazeSeed = 1337`; the `?autoprofile=1&proflayout=maze`
  path sets up the same fixed-seed maze if you would rather have it driven).
- Fixed ~90-bot roster, auto-add **off**, so the roster cannot drift between runs.
- Three ~60 s takes per arm: `Y` to start the per-frame perf log, `Shift+Y` to stop with the summary.
- Compare the `sim` row's median and p90 from that summary, arm against arm.
- **Pass:** sim-phase median delta at most 0.2 ms and no consistent p90 growth above 0.5 ms across all
  three pairs. **Fail (investigate before relying on it):** a 0.3 ms or larger median regression in all
  three pairs.

A Node microbenchmark of the write path alone (90 bots x 20,000 frames) measured ~4 us per 90-bot frame
with zero retained heap growth. That is a sanity check that the write path does not allocate — it is
**not** a browser measurement and does not answer the question the protocol above answers.

**Not wired in `environment-viewer-v2.html`,** consistent with the floor-rescue section above: it
deliberately does not pass `rescueHeightAt`, has no catch slab, already has its own `lastSafePos` fall
recovery, and on procedural terrain never builds a `mapCollider` at all. The `forensics` option is
available to it for free if that ever changes.

**Tests:** `node test-bot-forensics.mjs` (81 checks) — buffer sizing and shared views, slot
assign/release/recycle and the stale-slot guard, the six-shape zero-behaviour-change twin comparison,
per-field sample correctness on both ground branches, the rescue frame plus freeze policy (including
that `grounded_raw` still separates a catch-slab rest from an uncaught free fall after the rescue has
forced `onFloor` true), Int32 key
fidelity at 43,679,999 and 2^25+1, ring wrap ordering, TSV shape and every derived column, slot
exhaustion, and the `dt = 0` / NaN-ground / no-`setNow` edge cases. Same `registerHooks` Capsule stub as
`test-bot-entity-rescue.mjs`.

## Perf remediation phases 0-B and 1-B (2026-08-04, `bot-viewer-v2.html`)

Workstream B of the two-agent pass described in
`docs/superpowers/plans/2026-08-04-bot-viewer-v2-perf-remediation-plan.md`. Evidence lives in
`docs/superpowers/reviews/2026-08-04-bot-viewer-v2-perf-findings.md`. Nothing here changes a visual
default; every new knob is opt-in and defaults to the exact pre-existing behaviour.

### Phase 0-B — fix the instrument, install the A/B levers

**`frameProf.beginFrame()` is now the first statement of the animation loop.** It has to precede
every `frameProf.time(...)` call, otherwise a timer that was already zeroed gets zeroed again after
recording. Without it, a phase that does not run on a given frame reported the *previous* frame's
value rather than 0, so conditionally-executed phases carried stale data into every comparison. This
is paired with a `frame-profiler.js` change that makes `beginFrame()` zero every recorded name
rather than only the environment viewer's `DEFAULT_NAMES` — **both halves have now landed**, so a
phase that skips a frame reads 0 here rather than the previous frame's value. Smoothed
(`{ smooth: true }`) values are deliberately not zeroed, so the HUD keeps its EMA.

Ordering matters as a result. The `?prof=1` HUD reads `snapshot(..., { smooth: true })`, which
`beginFrame()` never touches, and `perfLogSample` reads unsmoothed *after* the render await, so both
see real values. Any future unsmoothed `snapshot()` placed before the timed work would read zeros.

`body-part-batches.js` gained a matching lifecycle in the same pass: a bucket is hidden the frame it
goes empty and evicted after 120 consecutive flushed empty frames, with the shared geometry never
disposed and the next `add()` rebuilding it. That is what makes a **global** rbox LOD swap
subtractive instead of additive — the seg=3 buckets actually go away rather than sitting alongside
the seg=1 ones, which is why the earlier per-distance LOD lost. Note that hiding alone does not move
the `draws` column: at r0.184 an `InstancedMesh` with `count === 0` already issued no draw call.
Hiding saves render-list and bind-group work in `rnd`; **eviction** is what fixes the LOD arithmetic.

**Three renderer-construction URL params**, at the `WebGPURenderer` construction site:

| Param | Effect | Default |
|---|---|---|
| `?dpr=<n>` | `setPixelRatio(Math.min(devicePixelRatio, n))` | uncapped `devicePixelRatio` |
| `?msaa=0` | `antialias: false` | `antialias: true` |
| `?shadowfilter=pcfsoft\|pcf\|basic` | `renderer.shadowMap.type` | `PCFSoftShadowMap` |

These exist because the findings' A/B sequence cannot be run without them: `antialias` is a
construction option, so it can never be an in-game toggle — the same reason `?prof=1` exists for
`trackTimestamp`. `BasicShadowMap` is `0`, so the lookup uses `??` rather than `||`; `|| ` would
silently fall back to PCFSoft for exactly the cheapest arm. Unknown values fall back to the default.

**`devicePixelRatio` is logged.** It goes to the console at boot alongside the msaa/dpr/shadow state,
and a second header line in `perfLogHeader()` records `devicePixelRatio`, the actual render buffer
ratio (`renderer.getPixelRatio()`, which differs when `?dpr` caps it), msaa and the shadow filter.
Fill cost scales with the square of the pixel ratio, so this single unknown moved the size of the
fill-rate finding by up to 4x and made takes from different machines silently incomparable. No
`PERF_LOG_COLS` change — this is header text, not a column.

### Phase 1-B — five confirmed structural fixes

1. **`updateNavPathLine` no longer allocates per frame.** It used to `dispose()` the line geometry
   and build a new one from N fresh `Vector3`s every frame the nav overlay was up. Now a
   fixed-capacity `Float32Array` position attribute (`NAV_PATH_MAX_POINTS = 256`, `DynamicDrawUsage`)
   is written in place with `addUpdateRange` + `setDrawRange`. `frustumCulled = false`, matching
   `navPoints`, because the buffer's extent changes per frame and the bounding sphere is never
   recomputed. Off at defaults, so it costs nothing in the current takes — the point is that GC
   pauses tip frames on a 60 Hz vsync ladder, and the perf log's `gap` column is the regression watch.
2. **FOV wedge geometry is cached and shared.** `fovWedgeGeometry(deg)` memoizes on the *rounded*
   degree in a module-level `Map`, which is all the segment count resolves anyway. Previously each
   actor minted its own `BufferGeometry` and every bot disposed-and-rebuilt it on each FOV slider
   change, so a drag churned 25 geometries per step. `userData.builtDeg` now stores the rounded
   degree so the comparison matches the cache key. **`disposeBotActor` no longer disposes
   `fovWedge.geometry`** — it is shared now, and disposing it would pull the geometry out from under
   every other living bot.
3. **`botVoiceIdentities` entries are released** in `disposeBotActor`. Safe because
   `voiceIdentity(entity.id, team)` is deterministic: a revived or respawned bot with the same id
   re-derives the identical voice. Memory only; the map is never iterated per frame.
4. **Static map geometry stops recomputing its local matrix.** `matrixAutoUpdate = false` plus one
   `updateMatrix()` at creation in `box()`, `instancedBoxes()` and the terrain mesh. `applyLayout`
   tears `mapRoot` down and rebuilds it, so nothing static ever moves after creation; `mapRoot`
   itself is never transformed either.
5. **The one unbudgeted nav call is now budgeted.** `choosePatrolResumeGoal` ran
   `floodFill(navGrid, start, {})` — an unbounded Dijkstra over the whole grid — with no cooldown, no
   cap and no share of `REPLAN_BUDGET_PER_FRAME`, while every other nav call goes through
   `requestPathBudgeted`. It now charges `PATROL_RESUME_REPLAN_COST = 4` budget units (a whole-grid
   flood is worth several A* searches) and respects the same per-entity `nextReplanAt` cooldown.

   **Refusal has to be retried, not swallowed.** `finishInvestigation` is the only caller and is
   never re-entered, so a dropped re-entry goal would silently downgrade the bot to
   `patrolPoints[patrolIdx]` — often a waypoint behind it. Refusal therefore sets
   `activeBotActor.patrolResumePending`, and `updatePatrolMovement` retries the call on its next
   think tick while no resume goal is held. A *served* call clears the flag whether or not it found a
   goal, so a genuine "no reachable patrol point" answer terminates instead of re-flooding. The
   observable cost is a re-entry goal arriving a few hundred ms late — the same throttle every other
   nav call already lives under.

   `maxRadius` was considered (`nav-grid.js:479` supports it) and **deliberately not used**: the
   band is an axis-aligned box around the start cell, so any radius small enough to save work can
   clip a route that legitimately detours outside the box, and a radius large enough to keep every
   patrol point reachable is the whole grid. It would buy nothing and risk silently dropping distant
   patrol points in a maze.

   This is insurance against map growth, not a present-tense win. Grid cells are a fixed 0.5 m, so
   doubling map size quadruples the node count; at the current map size the call is cheap.

**Verification:** the module block parses under Node. There are no Node test targets for these
in-file paths. Owner QA: nav overlay on (`updateNavPathLine`), FOV slider drag with the wedge on,
medic revive (voice identity), and a patrol resume after combat ends.

### Phase 3-B — the global rbox LOD mode (`?rboxlod=2`)

`rboxlod` is now a **three-state mode**, not a boolean: `0` off (default), `1` per-distance, `2`
global. `BOT_RBOX_LOD` holds the mode number, clamped to 0-2 at parse so a typo cannot land in a
half-state. The panel button (`Armour LOD: …`) cycles `Off → 15 m → 25 m → 40 m → 60 m → Global` and
tracks its position by index rather than by looking up the current distance, since the global step
has no distance to look up.

**Why global is a different thing from far.** A per-distance LOD is inherently *additive* while the
bot population is mixed: near bots keep filling seg=3 buckets while far bots fill seg=1 buckets, so
both geometries are live at once and the rbox bucket count roughly doubles. Neither hiding nor
eviction can collapse that, because both sets are genuinely non-empty. A global switch is
*substitutive*: every bot moves at once, the seg=3 buckets go empty, they are hidden the same frame
and evicted after 120 flushed empty frames by the `body-part-batches.js` lifecycle. The arithmetic
that this phase is betting on is therefore **`draws` flat, `tris` down** — roughly 44 K of a bot's
~57 K triangles is rbox armour at 828 triangles a piece, against 156 at `seg=1`.

**Eviction, not hiding, is what makes that work.** At r0.184 an `InstancedMesh` with `count === 0`
already issues no draw call and never appears in `renderer.info.render.drawCalls`, so hiding an
empty bucket does not move `draws` at all — it buys earlier rejection in `_projectObject` (no
render-list entry, no bind-group refresh), which shows up in `rnd`. Do not read a flat `draws` in the
first 120 frames after a switch as a failure; that is the eviction window.

**Where the swap is applied.** Global mode runs in `botCullBegin()` — once per frame, before the
flush loop — rather than in `botFlushSkipped()`, because `botFlushSkipped` returns early for the
camera-focus and debug-focus actors and those bots must swap too. `setGearLod` early-returns when the
level is unchanged, so the per-frame walk over `botActors` costs one integer compare a bot.
Per-distance mode stays exactly where it was, inside `botFlushSkipped`.

Leaving global mode (any button step other than Global) walks every live body back to `setGearLod(0)`
before applying the new mode, so a focus bot cannot get stranded on the cheap twin.

**The default stays OFF.** The `seg=1` twin visibly flattens the armour's chamfer highlights. That is
an aesthetic call for the project owner after looking at it, not a perf decision.

`perfLogHeader()` now records the live `rboxlod` state (`off` / `<n>m` / `global`) on the same header
line as `devicePixelRatio` and msaa, so a take identifies its own arm. It is header text, not a
column — `PERF_LOG_COLS` is unchanged, and `perfLogSummary` indexes rows positionally, so any future
column must be appended at the end of both `PERF_LOG_COLS` and the row push.

**A/B the owner runs (STOP/MEASURE M2).** Three firefight takes of comparable length and bot count,
identical otherwise, reading `tris`, `draws`, `gpu`, `body`, `rnd` and `sub30`:

| Arm | URL |
|---|---|
| control | `?prof=1&dpr=1&msaa=0&rboxlod=0` |
| per-distance | `?prof=1&dpr=1&msaa=0&rboxlod=1&rboxlodDist=25` |
| global | `?prof=1&dpr=1&msaa=0&rboxlod=2` |

Expected shape if the model is right: arm 3 drops `tris` by roughly 60-75% against arm 1 with `draws`
flat or slightly down, `gpu` down, and `body` flat or down (fewer vertices to write, same bucket
count). Arm 2 should reproduce the old backfire — `draws` up, `tris` down less. If arm 3 moves
`tris` but leaves `gpu` unchanged, the GPU is fill-bound rather than vertex-bound and armour
triangles are not worth an aesthetic change; that is a real result, not a failed take.

**`sub30` is the criterion, not the mean.** The success bar is "never sits below 30 fps for any
considerable time", so read the `sub30` summary line — frames over 33.3 ms plus the longest
consecutive run — before any median. It is a summary line rather than a per-frame column; `tris` and
`draws` are columns 31 and 32. A mode that leaves the median flat but shortens the worst run is a win.

**Verification:** the module block parses under Node. No Node test target exists for this path (it is
a render-side policy switch); the numbers come from the owner's takes.

**Not in this pass:** Phase 4 (fill-rate default flips) is gated on the owner's measurements and
changes visual defaults.

## Conforming blood stains, Phase 1 (2026-08-05, `bot-body-hit.js` + `effect-renderer.js` + `damage-simulator.html`)

"Blood stains don't conform to the bot" turned out to be **four** defects, only one of which is about
decal technique. Reading the code rather than assuming reordered the whole job:

1. **The stain never moved.** `blood_stain` is a wire object with a fixed world `p`, and nothing in
   `effect-renderer.js` read a bot transform. A hit bot walked off and left the stain in mid-air.
2. **The hit point was not on the body.** `combat.js`'s `rayCapsuleHit` returns a point on one
   capsule for the whole bot — `bot-entity.js`'s `DEFAULT_RADIUS = 0.3`. Real limbs are ~0.10 m
   across and sit laterally offset from that axis, so a limb hit lands in open air.
3. **The quad is a fixed 0.15 m and flat.** Deferred: this is what the three decal modes address.
4. **The mask was rotationally symmetric.** `drawBloodStain` has always computed a per-decal `spin`,
   but the decal pool sampled `makeSoftTexture`'s centred radial gradient — so spinning it did
   nothing and every stain was the same soft circle. Fixed in `effect-renderer.js`; see
   `docs/subsystems/fx.md`.

Defects 1, 2 and 4 are prerequisites of *every* decal mode, so they shipped first and alone.

### `bot-body-hit.js`

```
resolveBodyHit({ THREE, body, origin, dir, refresh = false })
  -> { partIndex, part, role, point, normal, localPoint, localNormal, attach } | null
attachFromPoint({ THREE, body, point, normal = null, refresh = false })   // same shape
resolveAttachmentMatrix(body, attach) -> Matrix4 | null
```

`resolveBodyHit` walks `body.parts.all` and does a ray/AABB slab test in each part's own local space.
Design notes that are not obvious:

- **A local AABB, not a triangle raycast.** In instanced mode a part is a transform-only `Object3D`
  carrying `.geometry` — there is no `Mesh` for a `Raycaster`. The AABB is GPU-free and Node-testable
  and runs **once per hit**, not per frame. It *is* an approximation: `limbShape` defaults to
  `'mannequin'` and nothing in the repo overrides it, so limbs, torso, pelvis and head are all
  `LatheGeometry`. If the approximation shows (most likely a graze near a limb silhouette landing
  slightly proud), the fix is a per-role primitive test, not triangles.
- **The local ray is deliberately not renormalized.** The direction is built as
  `(origin + dir)·M⁻¹ − origin·M⁻¹`, which keeps world scale in the vector, so `t` stays in world
  units and hits from differently-scaled parts are directly comparable.
- **`batches.raycast`'s `instanceId` is unusable** as a handle: `beginFrame()` zeroes every bucket
  count and instances are re-added each frame, so it is valid only inside the frame that produced it.
  `attachFromPoint` exists for the case where the *point* came from that accurate raycast and only
  the stable part handle is missing.
- **Attachment requires instanced mode.** A mesh-mode body has no `parts.all`; it returns `null`
  rather than guessing.
- Matrices come from the last `flush()` — at most one frame stale. `refresh: true` pays for a fresh
  `updateMatrixWorld(true)` over the whole rig.

The handle it produces (`{ part, role, parts, lp, ln }`) and the resolver that consumes it are
documented under "Attached stains" in `docs/subsystems/fx.md`. The short version: `part` alone is
**silent-wrong** on mismatch — a stale index resolves to a valid matrix for the *wrong* part — so
`role` and the total part count ride along as a guard. They are a guard, not proof: `_role` is a
material role (`shell`/`plate`/…) that several parts share.

### Why the harness needed fixing before it could judge anything

`damage-simulator.html` could show **neither** of the two defects it was chosen to demonstrate:

- Its bot never moved (`botState.position` was never mutated), so a stain left behind was invisible.
- Its click-to-fire already used `batches.raycast`, which is *strictly more accurate* than production
  hitscan — so defect 2 did not reproduce there at all.

Both are now toggles: **`bot → pace`** and **`hit resolution → source`** (`capsule` / `parts` /
`mesh`), plus **`attach stains`** for a direct before/after. `capsule` is the honest production
baseline and is the only source that cannot produce an `attach` handle, because at that level no part
information exists.

### Tests

`test-body-hit.mjs` (Node, no GPU) builds a stand-in rig of plain `Object3D` parts — the exact shape
instanced mode produces — and covers: a ray onto a known face; misses, a body with no `parts.all`,
and hidden parts all resolving to `null`; nearest-part selection by **world** distance including a
`(1,4,1)`-stretched part; under scale *and* rotation, the returned normal checked **perpendicular to
two in-face directions** rather than against a recomputed normal matrix, so the test cannot pass by
mirroring the implementation's own arithmetic; `attachFromPoint` picking the nearest part and keeping
the local point unclamped; and the handle resolving on its own body, declining on role mismatch,
part-count mismatch, out-of-range index, null handle and null body, and tracking the part after it
moves. `test-effect-renderer.mjs` block 1c covers the renderer half.

### The thigh flip (2026-08-05, `player-procedural-body.js`)

First bug the attachment surfaced in the browser: a stain on a thigh jumped to the **other side of
the leg** when the bot turned around. Not an attachment bug — a rig one.

`placeSegment` oriented a limb with `setFromUnitVectors(_up, _dir)`, the **shortest-arc** rotation
from local +Y to the bone. Shortest-arc carries **no roll**, so for a near-vertical thigh it is
near-identity no matter which way the bot faces: the segment's local frame was world-locked. A decal
pinned in it therefore held still in world space while the body rotated around it, landing on the far
side. Worst on thighs precisely because they are the most vertical segment, where roll is least
constrained.

Fixed at the source — `placeSegment` now does the identical shortest-arc solve in **body space** and
rotates the result by the body orientation, which makes the frame rigid with the body while leaving
the rendered mesh untouched (limb geometry is a lathe about Y with equal X/Z scale, so it is exactly
symmetric about the axis being rolled). Details and the call-site threading are in
`docs/subsystems/procedural-body-weapon-contracts.md` under Contract 2; the regression is pinned by
`test-segment-frame.mjs`, which measured the old behaviour at ~0.12 m of error on a ~0.11 m thigh —
the exact mirror position.

Worth remembering as a class of bug: **a rig frame that no renderer ever cared about can still be
wrong**, and stays invisible until something is pinned to it. Every limb segment had this frame for
as long as the rig has existed.

### Phase 2 Mode A: stains sized from the part they hit (2026-08-05)

`bot-body-hit.js` gained **`partCrossSection(part)`** — the part's narrower cross-axis extent in
world metres — and every hit now carries it as `crossSection`. `damage-simulator.html`'s **blood
stain → size mode** switches between `fixed` (one authored number times a coarse head/torso/arm/leg
factor) and `fitted` (Mode A: `clamp(fit x crossSection, min, max)`).

Measuring the real rig is what made the case. The old fixed 0.15 m stain is **1.6x the width of a
forearm** (0.094 m) — it did not merely tent, it ran past the limb's silhouette on both sides — while
covering only 0.6x of the 0.236 m torso. Numbers for both bot variants are tabulated in
`docs/subsystems/fx.md` under "Stain sizing (Mode A)".

The same measurement turned up a second defect nobody had costed: `pushBlood` lifted **every** decal
1 cm along its normal to dodge z-fighting. That is invisible on terrain and badly wrong on a body —
1 cm is more than a tenth of a forearm's width, so the stain hovered near the arm instead of sitting
on it. `lift` is now a `pushBlood` parameter; ground splatter keeps 1 cm and `blood_stain` scales it
to `clamp(size x 0.04, 0.8 mm, 1 cm)`.

**What Mode A does not fix:** a flat quad still lifts off where the surface curves away — about 8 mm
at the edges on a forearm, 19 mm on a torso, at a 0.55x fit. That residual is the number Modes B and
C have to beat to justify themselves.

**Not in this pass:** defect 3. The three decal modes (flat part-sized quad, CPU-clipped
`DecalGeometry`, GPU depth-projected) are Phase 2 and are still a bake-off, not a decision.

### Phase 3: both modes wired into `bot-viewer-v2.html` (2026-08-07)

Mode C (`projected-decals.js`, GPU depth-projected boxes) was built alongside Mode A, and both are
now live in the harness's real combat hit path rather than only in `damage-simulator.html`. Mode B
(CPU-clipped `DecalGeometry`) was never built and is not planned: it cannot replicate, it reintroduces
the per-decal `Mesh` cost that forced the old 160-decal cap, and it cannot grow — which conflicts with
the two remaining blood problems (bleedout drips and growing ground pools).

Two buttons in **Body & ragdoll** keep both refinements optional, because both cost something:
`Wound hit: Cylinder / Mesh` picks where the wound point comes from, and `Wound stain: Fitted /
Projected` picks how it is drawn. Full wiring notes, costs and fallbacks are in
`docs/subsystems/fx.md` under "Wiring in `bot-viewer-v2.html`".

The one thing worth repeating here: `Mesh` re-traces the shot from the shooter through the capsule
hit point, and the capsule is fatter than the rig, so a graze can pass beside the mesh entirely.
`refineWoundHit()` returns `null` there and the caller falls back to the capsule point with no
attachment — the same result `Cylinder` would have given. Nothing is dropped, but a small fraction of
grazes will keep the old floating behaviour.

## Limb identity (`bot-limb-map.js`, 2026-08-08)

`bot-body-hit.js` answers *which part* a shot hit; it cannot answer *which limb*, because the `_role`
it returns is a MATERIAL role (shell/plate/trim) shared by parts all over the body. `bot-limb-map.js`
supplies the anatomy. Pure, no THREE, Node-tested by `test-bot-limb-map.mjs` (39 checks).

```
buildLimbMap(body)                    -> Map<Object3D, {limb, segment}>
limbForPart(map, part)                -> {limb, segment} | null
limbIdForPart(map, part)              -> limb id | null
isSeverable(limb)                     -> boolean
partsOfLimb(map, limb, {keepProximal}) -> Object3D[]
LIMBS, SEVERABLE_LIMBS
```

Limb ids are `head`, `core`, `leftArm`, `rightArm`, `leftLeg`, `rightLeg`. The map is keyed by object
reference, so a lookup is O(1) and survives a part being re-indexed or hidden.

Two things it exists to get right:

- **The side mirror.** `parts.arms.left` is the VISUAL left arm and is wired to the INTERNAL
  `arms.right`; the rig mirrors and `setArmTarget` swaps for the same reason. The map is built only
  from `body.parts`, which is already visual-side, so the mirror is handled once here instead of at
  every call site. Reading the internal rig instead removes the wrong arm.
- **Gear is a hit target.** A helmet, pauldron or boot is its own part in `parts.all` and sits
  *outside* the limb it covers, so a shot at the head usually strikes the helmet rather than the head
  part. Gear inherits its host's limb by walking parent links — not by parsing anchor names, because
  `gearHosts` uses INTERNAL side naming (`handL` is the internal right hand) and name-matching would
  reintroduce the mirror bug. Gear carries `segment: 'gear'`.

`partsOfLimb` is the sever sweep. By default it keeps the proximal joint (shoulder or hip) and that
joint's gear, so a stump has a cap rather than a hole.

**Cache it on the body.** Part identity never changes for the life of a rig: `setGearLod` swaps
geometry in place and a sever only flips `.visible`. `bot-viewer-v3.html`'s `limbMapFor(body)` builds
it once and hangs it off the body, so a rebuild (revive, body-kind change) naturally gets a new map.

### Wiring in `bot-viewer-v3.html`

`resolveWoundHit(target, point, normal, sourcePoint)` is the one place a landed hit becomes anatomy.
It calls `refineWoundHit` and then the limb map, returning `{hit, limb, segment}` or null. Null is a
real outcome, not just an error case: the hit capsule is fatter than the mesh, so a graze can land
inside the capsule and miss the body entirely.

It is deliberately **not** gated on `botBloodFxEnabled` or `botWoundHitMode`. Those are cosmetic
switches, and limb identity now feeds gameplay decisions that must not change because someone turned
blood off. `botWoundHitMode` still selects FX *placement* (mesh point vs capsule point); the trace
runs either way. Cost is one ray/AABB walk over ~30 parts per **landed hit**, not per shot fired.

`applyBotDamage` passes the result to `spawnHitBloodFx` (so one hit costs one walk, not two) and adds
`bodyHit`, `limb` and `segment` to the `emitBotDamaged` payload. Nothing consumes those yet.

**Known gap:** `detonateBlast` resolves a wound for its FX but does not call `emitBotDamaged` at all —
blast damage has always gone straight to `recordBotDamage`/`creditBotHit`. So blast limb identity
reaches the effects and not the event bus. Routing blasts through the bus would also start firing the
damage-audio listener for explosions, which is a behaviour change, so it is left for whoever needs it.

## Bleeding (`bot-bleed.js`, 2026-08-11)

Wounds and stumps emit until healed; a corpse pools. Pure module, `test-bot-bleed.mjs`. The caller
owns the FX and the damage-class gate — this only decides what is due.

```
createBleedState()
openBleedSite(state, {limb, segment, attach, local, kind}, now, cfg) -> site | null
closeBleedSites(state) / closeBleedSitesOn(state, limb)   // a heal seals wounds
markBleedDead(state, now)
stepBleed(state, now, cfg) -> { drips: [site], pool: radius }
bleedRateFor / dropsFor / bleedingSiteCount
SITE_WOUND = 'wound', SITE_STUMP = 'stump'
```

- A **stump** replaces every wound on its limb and bleeds ~3.5× as hard.
- **At most one drip per site per step**, so a stalled tab cannot dump a backlog of decals in a frame.
- `maxSites` (6) bounds a riddled bot; the oldest wound is dropped.
- `clotSeconds` defaults to **0** — a wound bleeds until healed rather than sealing itself.
- The **pool** needs an open wound: a corpse with none never pools. It starts after `poolDelaySeconds`,
  grows at `poolGrowth` m/s to `poolMax`, and freezes at `bleedoutSeconds`. Draw it as a **projected**
  decal, not a quad — it has to conform to the ground it spreads over.

## Haywire death (`bot-haywire.js`, 2026-08-11)

A death where control goes with the bot: it thrashes, fires wild, then twitches out. Pure decision and
schedule, `test-bot-haywire.mjs`; randomness is injected so tests are deterministic. The caller applies
the ragdoll impulses and resolves the shots.

```
haywireChance(cause, cfg)   // cause: { headKill, severed }
rollHaywire(cause, rand, cfg)
createHaywireState(now, cfg)
stepHaywire(state, now, rand, cfg) -> { phase, kick, impulse, fire }
haywireImpulseDir(rand)
phases: 'thrash' -> 'twitch' -> 'done'
```

Where the bot was shot is what moves the odds: **headshot 65%**, a death that also took a limb 25%,
anything else 10%. Firing only happens during the thrash and is capped at `fireCap` (5) rounds. A
twitching corpse never fires. Wild rounds hit whoever is standing there — scoring them is the
viewer's job (a bot's own team costs it a point, an enemy earns one).

## Bleeding and haywire in `bot-viewer-v3.html` (2026-08-11)

Two switches in **Body & ragdoll**: `Bleeding` and `Haywire death`, plus `Force haywire` for watching
the thrash on demand and `Reload damage tuning` for re-reading the file. The numbers behind them are
tuned in `damage-simulator.html` and arrive through `damage-tuning.json` or, live, through a
`storage` event — see `docs/subsystems/fx.md`. Live state is per actor: `actor.bleed`,
`actor.haywire`, `actor.haywireShots`.

- **Wounds** open in `applyBotDamage`, through the same damage-class gate the hit burst uses, so a bot
  whose armour hid the spray does not then start dripping. **Stumps** open in `severBotLimb` and carry
  an `anchor` (the shoulder or hip part itself), so the drip follows the joint instead of hanging where
  the limb came off. A heal seals every site; a revive rebuilds the state.
- `updateBotBleeding(now)` runs once per frame after the rigs are posed, so a drip leaves the limb's
  live position. Every Nth drip (`groundEvery`) also leaves ground blood, or one standing bleeder eats
  the decal budget.
- **Pools** are drawn by `drawProjectedStains`, which now runs whenever any pool exists even in fitted
  stain mode — a pool has to conform to the ground.
- **Haywire** is seeded in `killCombatBot`, in the ragdoll branch only (no ragdoll, no thrash). The
  cause is read from the corpse's own wound state, so nothing extra is threaded through the death path.
  `updateBotHaywire` runs in the dead-actor branch of `updateAllBots`, before the ragdoll step; a kick
  clears `ragdollSettledSince` or the corpse freezes mid-thrash.
- A wild round is its own hitscan from the corpse's chest (`fireHaywireShot`) rather than
  `fireBotShot` — the gun is already dropped by then — but it uses the same resolver, damage, FX and
  `applyCombatDamage`, so it can really kill someone. Cause is `'haywire'`.

## Limb loss (`bot-wound.js`, 2026-08-08)

Damage accumulates **per limb**, and a limb that absorbs enough of it comes off. The head is the
exception and kills on contact instead — see "The head kills on contact" below. Pure module,
Node-tested by `test-bot-wound.mjs` (82 checks).

Severing is default **off** (`botLimbLossEnabled`, "Limb loss" in Body & ragdoll), because it changes
how a fight reads and the thresholds are untuned. Head lethality is default **on** and has its own
switch.

```
createWoundState()                        -> per-bot state
applyLimbDamage(state, limb, amount, cfg) -> {severed, lethal, total, threshold}
getWoundConfig(damageClassId)             -> merged row
limbThreshold(limb, cfg)
killingBlowSever(state, limb, cfg)        -> a fatal hit takes the limb it landed on
isLethalHit(limb, cfg)                    -> head hits kill on contact
isSevered / severedLimbs / isDecapitated / canHoldWeapon / canHoldTwoHanded / weaponResponseFor
TRIGGER_ARM = 'rightArm', SUPPORT_ARM = 'leftArm', LETHAL_LIMBS = {'head'}
```

**Where hits land**, measured by `test-bot-wound-attribution.mjs` (capsule-gated rays at a real
instanced rig). 60% of capsule-passing rays find the rig at all; of those: core 73%, each leg 12%,
head 1.7%, **each arm 0.3%**. Set any per-limb threshold against these, not against health alone — a
bot absorbs 100 damage total, so one arm expects under half a point of it.

**A killing blow takes the limb it landed on** (`killingBlowSever`, gated by `severOnKillingBlow`,
default true). This is where limb loss actually comes from: roughly a quarter of deaths, mostly legs.
The accumulator is the rarer path, for a bot that survives concentrated fire on one limb.

**Every damage source must pass `origin`.** `applyBotDamage` falls back to `attacker.capsule.start`
(ankle height, 0.3 m), which traces up through the victim from below and names the wrong limb.
`fireBotShot` passes the muzzle, `fireBotKnife` the attacker's eye, `detonateBlast` the blast centre.

Thresholds still assume flat damage: an arm hit costs the bot as much health as a chest hit, so at the
default 60 a bot losing an arm is down to 40 health. `limbDamageScale` is the seam for locational
scaling, defaulting to 1.

Thresholds are keyed by damage class: armour raises them (85/105), robots lower them (45/55), and
plain humans sit between (60/75). Legs are tougher than arms in every class. There is **no decay and
no healing** — armour breach already works this way, and a limb shot four times should not be restored
by a health pack.

### The head kills on contact (2026-08-11)

The head is the one limb the accumulator argument does not apply to. Everything above is an argument
about limbs a bot is meant to **survive** losing; the head is the opposite case, and a head that
needed three rounds would just be a slower torso. So `limbThreshold('head')` is **0** and any bullet
that resolves to it sets `lethal` on the result. `applyBotDamage` reads that and writes health to 0
regardless of what the weapon actually did, so the weakest pistol in the game is as fatal to a head as
the rpg.

Two rules on **separate switches**, deliberately:

| Switch | Default | What it does |
|---|---|---|
| `botHeadshotKillEnabled` ("Headshots kill") | **on** | The lethality itself. It is a combat rule, not gore, so turning blood or limb loss off must not quietly make bots survive headshots. |
| `botLimbLossEnabled` ("Limb loss") | off | Whether the head is also *removed* on that hit. Lethality without it means the bot simply drops. |

**Blasts are exempt.** `accrueLimbDamage(..., { lethalHead: false })` from `detonateBlast`: an
explosion resolves to whichever limb faced the blast normal, which is an artefact of geometry rather
than a placed shot, and a distant grenade should not instakill because the trace happened to name the
head. The blast still records head damage.

**How reachable the head actually is: 1.7% of hits, measured.** The capsule bullets test against is
1.8 m tall (radius 0.3, top plane at 1.80 m above the feet) and the rendered head spans **1.76–2.11 m**
— so only its bottom 4 cm is inside the hittable shape. That is the head-exposed hit-volume gap, still
unfixed. Bots aim at `eyePos`, 0.85 up the capsule, which is **1.32 m** — chest height — so they are
not going for heads deliberately. What connects is a rising shot that clips the crown of the capsule
and carries on into the head above it, because `refineWoundHit` traces the full shot line and takes
the first rig part on it, not the capsule surface point. Practical consequence before tuning: shots
that used to read as harmless top-of-capsule grazes are now the main source of headshot kills. Fixing
the hit volume would raise 1.7% considerably. `reportBotHitVolume` measures the gap on a live bot and
`test-bot-wound-attribution.mjs` measures the share.

`emitBotDamaged` gained `headshot` (the hit landed on the head) and `headKill` (that hit is why it
died); they differ whenever the switch is off or the blast exemption applied.

### Severing

`setAmputated(limb, on)` on the rig (`player-procedural-body.js`, VISUAL limb naming) skips
`solveArm`/`solveLeg` for that side, which leaves the stump joints frozen instead of chasing a target
with no endpoint — a cost *reduction*, since it skips a FABRIK solve. Hiding the parts is the caller's
job via `partsOfLimb`; `flush()` already skips invisible parts, and so does `resolveBodyHit`, so a
severed limb leaves both rendering and hit-testing for free and cannot be severed twice.

**Body lean is unaffected.** It comes from a midpoint of `gait.feet`, which the gait scheduler keeps
updating whether or not the leg is solved — so a missing leg does not tilt the torso. (The plan
predicted trouble here; the rig does not derive pitch from solved feet.)

`severBotLimb(actor, limb)` in `bot-viewer-v3.html` hides the parts, sets the flag, and spawns a stump
burst anchored at the joint the limb hung from (which is still there and still animating), gated
through the damage class so a robot sparks instead of bleeding. A head has no proximal segment of its
own — the neck belongs to the core — so a decapitation marks itself at the head instead, and the event
is logged as `decapitate` rather than `sever head`. `clearBotLimbLoss(actor)` reverses all of it on
revive, next to the `armourBreached` reset; the head restores through the same path, since a lethal
head hit records itself in `state.severed`.

### The weapon

`weaponResponseFor(state)` answers what a lost arm means for the loadout:

| Response | Cause | Handling |
|---|---|---|
| `oneHanded` | support arm gone | Nothing to do — the amputated arm's IK is skipped, so it simply never reaches for the gun. |
| `sidearm` | trigger arm gone | Forced swap to the pistol, and the ammo logic can never re-shoulder the primary. |
| `disarm` | both arms gone | No swap. Consequences are a later phase. |

The swap is applied in `updateBotWeaponSlot`, **not** at the moment of severing: `swapBotWeaponSlot`
acts on the bound bot, and the bot being dismembered is the victim, not whoever is bound while its
attacker shoots. So the victim performs the swap on its own next think.

The weapon rig is never parented to a hand — `updateBotWeaponMount` places it from the body position
and the authored hold — so losing an arm cannot make the gun fall or drift.

### Consequences

Shaped exactly like `bot-stance.js`: pure functions consulted **at the point of use** and multiplied
onto what is already there, so wound is an orthogonal channel rather than a new FSM axis. Nothing here
touches `bot-state-code.js`.

| Function | Effect | Wired at |
|---|---|---|
| `woundSpeedFactor` | 0.5 per missing leg, 0.18 for both (a crawl, not 0.25) | `currentBotMoveSpeed` |
| `woundTurnRateScale` | 0.65 per missing leg | `botTurnRateRadS` |
| `woundSpreadScale` | ×2.2 per missing arm | all three `stanceSpreadScale` sites |
| `canHeal` | false once **either** arm is gone | `decideMedicDuty` returns null |
| `canFight` | false once **both** arms are gone | `fireBotShot` refuses; `beginBotHealthRetreat` |

**Why either arm ends a medic:** the heal pose is two-handed — it holds the pack in one hand and dabs
with the other — so a one-armed medic has no pose to play. It drops back to being an ordinary
rifleman rather than becoming a medic that cannot medic.

**Why both arms forces a retreat:** a bot with nothing to hold a gun with cannot shoot back at any
health, so `beginBotHealthRetreat` bypasses its usual health threshold on capability instead.
`severBotLimb` calls it the moment the last arm goes. Routing through the existing retreat means a
disarmed bot uses the same flee goals, cover and pathing as any other wounded bot — no second way to
run. It still respects the global `retreatEnabled` toggle, so turning retreat off leaves a disarmed
bot standing, which is the operator's call.

## Damage classes (`bot-damage-class.js`, 2026-08-07)

Four damage-FX features were planned at once (wound-centred blood, limb loss, blood pools, robot
fire) and all four wanted to know the same thing: what is this bot made of. Without a shared answer
each would have grown its own `if (bodyKind === 'armoured')` branch. `bot-damage-class.js` is that
answer — pure data, no THREE, no DOM, modelled on `bot-roles.js`: a `DAMAGE_CLASS_DEFAULTS` object
merged into named rows, and **no call site anywhere branches on a class id string**. Every consumer
reads `getDamageClass(id).<field>`; adding a fourth class is one new row.

```
human          blood: 'always'
armouredHuman  blood: 'lowHealthOnly' @ 0.35, sparks, smoke: 'lowHealthOnly', hitAudio: 'metal'
robot          blood: 'never', sparks, smoke: 'always', spasms, haywireOnDeath, all-metal audio
```

- `classForActor(actor, bodyKind)` resolves an explicit per-actor `damageClass` override first, then
  falls back to today's global body kind (`soldier → human`, `armoured → armouredHuman`). Nothing
  sets the override yet; it is the seam a mixed fight arrives through.
- `shouldShowBlood(cls, hpAfter01, alreadyBreached) -> { show, breached }` is the gate, extracted as
  a pure function so the decision is testable without the viewer. `breached` is a **one-way latch**,
  not a hysteresis band: blood gating is decided once per discrete hit rather than per frame, so the
  usual enter/exit band solves a problem that does not arise. What a plain threshold would get wrong
  is a healed bot — armour once breached does not un-breach, so a medic topping a bot back up must
  not make it stop bleeding. The caller stores the returned `breached` on the actor and passes it
  back in. It is a plain actor field, deliberately not a state-code latch bit: that slot is at 5/5
  bits and this does not need to be greppable in a trace to do its job.
- `shouldShowSmoke` reads its own `smoke` field against the same threshold and latch.

Covered by `test-bot-damage-class.mjs` (43 checks), including a mechanical check that no two classes
have identical fields, since a class that can only be told apart by its id would force call sites
back to the branching this table exists to prevent.

**Wired into the hit path (2026-08-07).** `spawnHitBloodFx` now resolves a class per hit and gates
`hit_spark`, the three blood kinds and a new grey `smoke_puff` off its fields; it also scales the
droplet burst by `bloodIntensityForHealth` from `effect-renderer.js`. Both landed as one change
because both needed the same signature (`amount` added) and the same three call sites
(`applyBotDamage`, the dummy branch, the blast loop). Two buttons in **Body & ragdoll** — `Damage
class` and `Bleed by health` — turn each half off independently, and off means exactly the previous
behaviour. Details and the exact controls: `docs/subsystems/fx.md`.

The visible consequence worth knowing before flipping it on: the default body kind is `armoured`, so
with classes on, a healthy bot **stops bleeding** and only starts once it drops below 35%.

**Damage class is not body kind.** Body kind is geometry and is still one global variable
(`bot-body-design.js`'s `_bodyKind`), so mixed-geometry fights remain impossible. Damage class only
has to answer per hit, and the hit path already runs per target — so a mixed damage *language* is
reachable well before mixed geometry is. Two decisions are still open: whether class is assigned per
bot or per squad, and whether `robot` is a re-skin of the existing Mark VII or new art.

## Panel tab refactor (2026-08-06, `bot-viewer-v2.html`)

The panel had grown to 29 collapsible cards and ~330 controls in one flat scrolling column, ordered
by when each feature was written. Bot concerns were spread over 11 sections, the six perf/LOD A/B
toggles sat inside the spawn card, diagnostic overlays lived in four separate places, and the three
one-click scenario presets were buried at the bottoms of unrelated sections.

Design record: `docs/bot-viewer-v2-ui-inventory.md` (the pre-refactor catalogue) and
`docs/superpowers/reviews/2026-08-06-ui-refactor/` (three independent proposals plus the approved
`proposed-structure.md`). Three agents were given the same brief; the consolidations below are the
ones all three arrived at independently.

### The section plan is the panel's structure

`SECTION_PLAN` near the top of the panel bootstrap is a declarative table of
`[tabId, title, cluster, collapsedByDefault]`. Every card is created from it up front, in display
order, under its tab host. `header(title)` then only **re-points `ctrl` at an already-built body**
instead of creating a section:

```js
function header(title) {
  const body = sectionBodies.get(title);
  if (!body) throw new Error(`header(): no section planned for "${title}"`);
  ctrl = body;
}
```

That inversion is what made the refactor tractable. The ~2900 lines of control-building code below
keep their original order in the file while the panel renders in a completely different one, so a
card's contents can be assembled from several places without moving code. It also means the panel
order is editable by rearranging one table.

Two arrays, `debugOverlayExtras` and `perfLodControls`, park controls whose owning card is built
later in the file, and are spread in once that card has its own contents — so ordering *inside* a
card stays intentional rather than depending on where in the file a control happens to be created.

`header()` throwing on an unplanned name is deliberate: a typo is a hard failure at load, not a
control silently appended to whatever section was last open.

### Structure

Pinned chrome above the tab strip (visible from every tab): search box · ★ jump drawer · the four
camera mode buttons · Bot readout. Then six tabs:

| Tab | Clusters → cards |
|---|---|
| Session | *Save state*: Save / load · *Camera*: Framing & follow, POV & fly |
| **Bots** (active on load) | *Roster & spawn*: Spawn, Composition, Squads, Deployment, Auto-add & corpses · *Loadout*: Weapons & ammo, Body & ragdoll, Explosives · *AI tuning*: Movement tuning, Stance, Perception & pursuit, Aim & reaction · *Results & test aids*: Scoreboard, Dummies |
| World | preset strip (Big open field · Test condition · eroded highlands) · *Layout & structure*: Map layout, Scene shuffle · *Terrain generation*: Terrain, Landform, Erosion, Landmarks, Terrain shading |
| Debug | *Performance*: Perf / LOD · *Overlays*: Debug overlays · *Capture*: State recorder |
| Visuals | Look & post, Visual toggles, Bot lighting, Sky detail |
| Audio | Mixer & voices, Music player, Reactive lighting, Music FX |

Clusters are plain non-interactive caption rows, not a second collapse level — a label, not another
click. 35 tab cards plus the pinned readout, and nine sub-groups nested inside three of them.

### View distance and POV eye offset were never saved (2026-08-08)

`camera.far` (the view distance slider) and `povEyeOffset.y` / `.z` (POV eye up/down and forward)
were written by the panel and absent from `captureUiState`. Both are now in the `camera` block as
`viewDistance` and `povEye`.

Restoring the view distance goes through the slider's own `syncViewDist()` rather than assigning
`camera.far` directly, because that syncer also rescales the sky dome (fixed radius, depth-tested, so
it hides everything past 75% of far) and hands the distance to the grass. A bare assignment would
clip correctly and leave both behind. POV offsets are clamped to the slider ranges and pushed back
into the sliders through a new `cameraSyncers` array.

Each had its own reason for being invisible to `test-bot-viewer-slot-coverage.mjs`, and both are now
closed:

- **`camera.far`** — the declaration scan recognised `let`, `var` and `const x = {`. `camera` is
  `const camera = new THREE.PerspectiveCamera(...)`, so it was in no declaration map at all and every
  write to `camera.*` was skipped as undeclared. The scan now takes any top-level declaration,
  including `const`, since a const binding still holds mutable state. Narrowing to column-zero
  declarations at the same time dropped a false positive (`text`, a function-local).
- **`povEyeOffset.y`** — written only as `povEyeOffset[key] = …`. The write pattern matched `name` and
  `name.prop` but not `name[key]`, so the object looked unwritten. Computed keys now count.
- **A third gap the fix exposed**: coverage matched on the object name, so once `camera.fov` was
  captured, every other `camera.*` field passed silently. There is now a property-level pass that
  accepts a full path, a `...obj` spread, or the bare property name.

### Bots tab reorganisation (2026-08-08)

Five independent proposals were collected on how to re-cut this tab. Four changes had majority
support and shipped; the rest (scenario presets, archetype presets, per-slider previews) did not.

- **`Spawn & composition` split into `Spawn` and `Composition`.** The card that opens on load now
  holds only "put bots on the map": team, spawn, count, add friendly/enemy, remove. The role mix and
  the three specialist spawn buttons moved to `Composition`, which starts collapsed. `Spawn` is still
  the only card expanded on load.
- **`Sides & home bases` renamed to `Deployment`.** Every proposal wanted the spawn-placement tools
  merged into this card. They were already in it — the name simply never mentioned spawning.
- **`Lost-sight pursuit` renamed to `Perception & pursuit`.** Sight distance and field of view live
  in this card, which the old name hid.
- **Three long cards grew nested groups**, via a new `subheader(title)` next to `header(title)`:
  - **Stance** → `Crouch`, `Kneel`, `Prone`, `Choosing and leaving a stance`. One posture per group,
    each asking the same six questions, so a crouch tuned tighter than its kneel is visible.
  - **Aim & reaction** → `Reaction timing`, `Weapon spread`, `Recoil`. How long before a bot shoots
    and where the round goes are tuned in separate sessions.
  - **Explosives** → `Throw decisions`, `Blast physics`. This settles the one point the proposals
    split on — whether to break Explosives into two cards — without doing so.
- **The stance override button moved** from the spawn card to `Stance`, beside the settings it
  overrides.

`subheader()` nests a normal `createSection` inside the current card, so groups inherit collapse,
search filtering and by-title state restore for free. It tracks `ctrlCard` separately from `ctrl` so
a second group nests beside the first rather than inside it. Group titles must stay unique panel-wide:
`readSectionStates` keys on heading text, and a collision would stomp a card's saved state.

**All five proposals said to move the Perf/LOD toggles and the debug overlays out of the Bots tab.
They were already out.** Those buttons are *constructed* inside the spawn region and parked in
`perfLodControls` / `debugOverlayExtras`, then appended to the Debug tab's cards. Reading the source
in order gives the wrong answer about where a control appears — worth knowing before trusting a
source-order reading of this panel.

### What moved

- **Perf / LOD is a new card.** Think stagger, Rig LOD, Flush LOD, Behind-camera cull, Body hide and
  Armour LOD left the spawn card. They are frame-budget instruments, not gameplay.
- **Debug overlays absorbed everything overlay-shaped**: POV debug widgets and markers (from Camera),
  Squad overlay (from Squads), and the nav overlay button. **"Nav grid (Phase 2)" no longer exists** —
  a whole collapsible card for one button was the clearest over-sectioning in the panel.
- **Map layout and Maze structure merged** into one card, ordered coarse to fine: layout, size, then
  walls, rooms, cover, structures. Scene shuffle split out into its own card in World.
- **Camera split three ways**: mode buttons to pinned chrome, framing and POV detail to two Session
  cards, POV debug toggles to Debug overlays.
- **The Visuals mega-card split into four.** `visuals.buildPanel({ heading: false })` returns one
  flat list with `.ttl` dividers marking its own subheads; the panel now partitions on those markers
  and drops the dividers, since the card headings carry those names. An unplanned fifth subhead would
  land in the last card rather than throwing.
- **Audio split into three cards** plus the existing Music FX, by inserting `header()` calls
  mid-block — the audio helpers append to `ctrl` as they build, so a header call redirects them.
- **The three scenario presets** moved to a bare button strip at the top of the World tab.
- **Spawn & composition reordered** to team → spawn → counts → role mix → role spawns → stance →
  remove, and is the one card expanded on load. The Bot readout is pinned but **collapsed**.
  (Superseded 2026-08-08: this card is now split into `Spawn` and `Composition`, see above.)

### Chrome

- **Search** filters cards on their whole rendered text, so a control label matches even when its
  card title doesn't. While a query is active every tab host is revealed at once (a control you
  can't place shouldn't need the right tab first) and cluster captions and the preset strip hide.
  Collapse states are snapshotted on the first keystroke and restored when the query clears. Escape
  clears and blurs.
- **Pinning** never moves DOM. A pinned card becomes a jump chip in the drawer; clicking it switches
  tab, expands the card and scrolls it into view. Moving cards would have disturbed both the planned
  order and the by-title collapse-state restore.
- **Compact** is one class on the panel root tightening existing padding; no new visual language.
- **Expand/collapse-all scope to the active tab plus the chrome**, via `activeSectionHosts()`. A
  panel-wide expand would have blown open five tabs nobody is looking at.

### Slot compatibility

`captureUiState` now reads section states from `ctrlRoot` rather than `panelBody`, since the pinned
readout lives outside the scroller, and the `ui` group gained `activeTab`, `pinned` and `compact`.
Both directions degrade cleanly: `applySectionStates` only touches sections it finds, so a slot
saved against the old names restores the cards that still exist and ignores the rest, and
`panel.pinned` is only applied when it is actually an array — a pre-refactor slot leaves your pins
alone instead of wiping them.

### Tests

`test-bot-viewer-panel-layout.mjs` (31 checks). The panel can't be executed in Node — it imports
three.js and needs a GPU — but the plan is a declarative table, so the test parses it out of the
HTML and asserts the approved tab order, per-tab card order, cluster captions, the load defaults,
and that every planned card is filled by something while every `header()` names a planned card. It
also pins the three consolidations the refactor exists for, so a later edit can't quietly scatter
the perf toggles or the overlays again.

The toggle idiom is unchanged: buttons still carry their state in the label. All three proposals
independently declined to convert to checkboxes — it would touch nearly every call site for a
cosmetic gain, and the problems here were ordering and grouping, not the widget.

## Slot capture gaps (2026-08-06, `bot-viewer-v2.html`)

"Not all settings save to the slots" was a real, pre-existing gap, and it had one shape: **the
capture functions enumerate their fields by hand, so a control added without a matching capture line
works, tunes the sim, and silently isn't saved.** No error anywhere. An audit of every persistent
`let` the panel reassigns against the text of all three capture functions found eight such controls,
now fixed.

- **The entire Perf / LOD card — six of six controls.** Think stagger, Rig LOD, Flush LOD,
  Behind-camera cull, Body hide, Armour LOD. They began as `?riglod=0`-style URL flags during the
  perf sweep, so they were never thought of as panel settings; the tab refactor gathering them into
  one card is what made the gap legible as "a whole section doesn't save". They now round-trip in the
  `ui` group under `perf`.
- **Hit volume** (Debug overlays) and **the state recorder's trace tick**, both under `debug`.

Restoring Armour LOD repeats the button's own order — drop every body back to full detail, then
re-band — because the per-bot swap only runs in mode 1, so a body left cheap by the old mode would
stay cheap. It also restores `rboxLodStep` so the next click continues the cycle instead of jumping.

Two things the audit ruled out, worth not re-checking: **no captured key is dropped on apply** in any
of the three groups, and **no settings object is partially captured** (`botSquadSettings` only
persists `spacing`/`mergeRadius`, but the rest of it has no panel control). Nine names stay
deliberately transient — live actor references, reload timers, recording-take state, and
`botLiveEnabled`, which opens a websocket and would auto-connect on load.

`test-bot-viewer-slot-coverage.mjs` guards the general case rather than this instance: it re-derives
the panel's writes and fails on any that no capture function mentions, so the next control added is
caught at the test rather than months later. Genuinely transient state goes in its `TRANSIENT`
allowlist **with a reason**, and the test also flags allowlist entries that have gone stale.

## Body kind was never saved — and why the audits missed it (2026-08-07)

Body kind (Human soldier vs Armoured bot) did not survive a slot load. The fix is small —
`captureBotState` records `getBotBodyKind()`, `applyBotState` restores it — but **the reason three
separate audits missed it is the part worth keeping.**

Every scan looked for *assignments*: which variables does the panel write, and does a capture
function mention them? Body kind is set by `setBotBodyKind()`, **imported from
`bot-body-design.js`**. The state lives in that module. There is no assignment anywhere in
`bot-viewer-v2.html` to find, so a scan built on assignments could never have seen it, and a test
built on that scan passed while the bug was live.

Restoring it goes **after** the procedural-body switch (rebuilding rigs is pointless while bots are
capsules), is guarded on an actual change the way the weapon and ammo setters are (a rebuild walks
every live rig), and refreshes the damage-class label, which resolves from body kind.

`test-bot-viewer-slot-coverage.mjs` gained an **imported-setter pass**: any `set*` imported from
another module and called by the panel must have its getter reach a capture function. Genuine
actions go in an `ACTIONS` allowlist with a reason (`resetScoreboard` — restoring a score on load
would be wrong). The general lesson for this panel: *state reachable only through another module's
setter is invisible to any assignment-based check.*

## Save all, restore, disk mirror (2026-08-07, `bot-viewer-v2.html`)

The slot design had two holes that both read to a user as "my settings didn't save", and neither was
a missing capture field:

- **Saving was three separate clicks.** maze, bots and ui each had their own row and their own Save
  button, with no combined one. Saving `ui` and assuming the panel was saved was the easy mistake.
- **Nothing survived a reload.** `applyMazeState`/`applyBotState`/`applyUiState` were only ever
  reached from a Load click. Refreshing the page dropped everything back to defaults with the slot
  still sitting in storage, untouched.

Now, in the Save / load card, top to bottom:

| Control | Behaviour |
|---|---|
| **Restore last session** | Applies the rolling autosave. Enabled only when a snapshot exists; its tooltip names the snapshot's time. |
| **everything** slot row | `captureAllState`/`applyAllState` — all three groups in one slot. |
| maze / bots / ui rows | Unchanged, for partial work. |

`applyAllState` order is **maze → bots → ui**, and it matters: the maze rebuild clears the roster, so
bot tuning has to land after it, and ui goes last because it never touches the sim and so cannot be
undone by either of the others.

The autosave is **debounced by 3 s** off `input`/`click` on the panel root, plus a `pagehide` flush,
and it is deliberately **offered rather than applied** — an automatic restore would fight anyone who
reloads specifically to get a clean slate. A failed write (quota, or a capture caught mid-rebuild)
is swallowed; the next edit tries again.

**Disk mirror.** `createSlotSection` gained an optional `onSaved(group, index, entry)` hook, wired to
`exportSlotToDisk`, which POSTs to `/api/save-slot-export` and lands the save in `bot-viewer-saves/`
(gitignored — one file per save click). It is fire-and-forget by design: the slot is already in
`localStorage` before the fetch runs, and losing a save because the server was down would be worse
than the problem the mirror solves. `createSlotSection` also swallows a throwing `onSaved` for the
same reason. Off-server there is simply no disk copy.

The client filename and the server's allowlist are a **cross-language contract with nothing linking
them but a test** — `bv2-<group>-slot<N>-<YYYYMMDD>-<HHMMSS>.json`, built in `exportSlotToDisk` and
matched by `_SAFE_SLOT_FILENAME` in `serve.py`. `test-bot-viewer-save-all.mjs` builds names the way
the client does and runs them against the regex the server actually compiles, so a change to either
side fails rather than silently 400ing every save. That test also drives `createSlotSection` against
a stub DOM to prove `onSaved` fires with the right arguments and that a throwing hook still saves.

## Hover text (2026-08-06, `bot-viewer-v2.html`)

Every control in the panel now has a `title`, written for someone who has never seen the app. Before
this pass **71 of 146 named controls had none**, and the gap was invisible in review: a button with
no tooltip looks identical in the code to one with a tooltip.

Two of those gaps were structural rather than per-control, and they are the ones worth remembering:
`createBotMovementSlider` had **no `title` parameter at all**, so all 12 Movement tuning sliders were
bare by construction, and the `AUDIO_EFFECT_DEFS` loop ignored one, taking the 6 Music FX sliders
with it. Both now take a tooltip; `AUDIO_EFFECT_DEFS` gained a 7th field. Where a factory builds a
row rather than a bare control the title goes on the row, so the label and value hover too, not just
the slider track.

The spec-table cards — aim, stance, explosives, terrain, voices — already had complete coverage, and
their existing text is the register to match: say what the control does and what changes if you move
it, and give the measured numbers where they exist.

`test-bot-viewer-tooltips.mjs` keeps it at 100%. It lists every control the panel creates and fails
on any without a title, checks each of the ten shared factories both **accepts** a tooltip and
**applies** it (which is what catches a whole card going bare at once), and walks the positional spec
tables row by row, since a row can silently omit its last argument.

## Closing the harness-to-game gaps (2026-08-08, `environment-viewer-v2.html`)

The bot port (Phases A-E) had left the game running an older version of several harness systems. A
file-to-file audit found eight; seven are now closed. Every one of them is host-side: guests see the
results through the wire they already read.

**Report attribution.** `pushAllyReport` payloads carry `attackerId` (casualty and near-miss alike,
re-attributed when a near-miss refreshes), and `recordContact` now passes `threatId`. Reports were
bearings before; they are identities now, which is what the risk model below needs.

**Risk-ranked target selection** replaces the distance-only pick. Risk is `proximity x danger`, where
danger is bonused for a candidate shooting *me* (`TARGET_DANGER_SELF_BONUS` 2.5) or a nearby teammate
(`TARGET_DANGER_ALLY_BONUS` 1.2), each decaying linearly over the report's own `alertWindowMs` rather
than cliffing at expiry. Ally-threat rides a shared ring, so `alliesCommittedTo()` discounts it by
`TARGET_PILE_ON_STEP` per teammate already on that shooter (floor `TARGET_PILE_ON_FLOOR`) and the
whole side stops converging on one man. Stickiness became a risk ratio (`TARGET_STICK_RISK_MARGIN`
1.3) behind a `TARGET_COMMIT_MIN_MS` 1500 dwell floor on `rec.targetCommittedAt`.

**Contact memory** (`bot-contacts.js`) records every FOV+range candidate per bot, exactly as the
harness does. Recorded, not yet consumed.

**Blast geometry.** `blastExposure(cx, cy, cz, p, height)` casts three rays (`BLAST_SAMPLE_T`
0.15/0.5/0.9 up the victim) through the same `botHasLineOfSight` world bullets use, so trees and rocks
count, and returns a *fraction* — partial cover is partial damage, and a fully covered body takes
none. `applyExplosionBlast` multiplies by it, and `blastReachesBody` hands the SAME function to
`chooseGrenadeThrow`'s `blastReaches` hook, so the throw decision and the detonation can never
disagree about a wall. `blastOcclusionEnabled` reverts both together.

**Wound-centred hit FX.** `spawnHitBloodFx` hangs off `bumpBotCombatCounters`, the one choke point
bullets, knives and blasts all pass through, so no fire path needed its own copy. In `mesh` mode
`refineWoundHit` re-traces the shot against the rig (`resolveBodyHit`) for the surface point, its
normal, the part's cross-section (which sizes the stain) and an `attach` handle; `capsule` mode uses
the sim point. Blood/sparks/smoke are gated by `bot-damage-class.js` off the global body kind, with
`rec.armourBreached` latched one-way so a heal cannot un-breach armour, and spray/splatter counts come
from `bloodIntensityForHealth`. Every effect is an ordinary replicated effect entity, so guests see
the same hit. Five panel toggles: blood FX, wound-fitted hits, damage classes, health-scaled blood,
blast occlusion.

**Cyclic locomotion** is on for bot bodies via a new `botLocomotion` GhostRenderer option (bots only;
human ghosts are untouched).

**Role insignia** are drawn by GhostRenderer beside the health bar and the alert "!", from the `role`
already on the wire: diamond rifleman, cross medic, chevron squad leader, ring sniper, triangle
technical. `INSIGNIA_KINDS`/`INSIGNIA_COLORS` are a local table, not a `bot-roles.js` import, so
multiplayer.js stays THREE- and bot-module-free. Covered by `test-ghost-renderer.mjs`.

**Scoreboard** (`bot-score.js`): spawns/kills/deaths/revives per side in a top-centre HUD, toggleable.
One adaptation — rounds only close when **respawn is off**, since endless reinforcements mean there is
never a last-bot-standing moment to decide; that is the same condition the harness's auto-add gate
expresses.

### Deliberately not ported

- **`rescueHeightAt`** (the below-terrain floor rescue). `stepBotPhysics` only runs the rescue inside
  its `mapCollider` branch, and on an authored map this file's `terrainHeight` raycasts DOWN from the
  top of the map bounds — it returns the *topmost* surface. That is precisely the caller
  `bot-entity.js` warns must not opt in: bots standing under a mezzanine would be lifted onto it. The
  game already has two other nets (the `heightAt` flat-snap on open ground, `BOT_FALL_CATCH_DROP_M`).
- Nothing else. The player command layer landed on 2026-08-08 as well — see the next section.

### The command wheel in the game (2026-08-08)

> **Superseded in part on 2026-08-12.** The gesture and the raycast are unchanged; the single global
> command slot described below was replaced by the order book in
> *[Squad orders](#squad-orders-2026-08-12-bot-ordersjs)* at the end of this file. `underCommand`,
> `commandTargetId`, `commandGoal` and `commandGoalState` no longer exist.

The harness issues orders with a cursor over an orbit camera; this game is pointer-locked
first-person, where right mouse is ADS and `Q` is cursor-free mode. So the wheel was ported and the
right-click menu was not — and the wheel is driven the way this file's existing **tool radial** already
works, not the way the harness's is.

**Gesture.** Hold the middle mouse button in first person, drag toward a spoke, release to commit.
Releasing near the centre commits nothing. Spokes: *Move here*, *Hold here*, and the two persistent
toggles *Double time* and *Break contact*.

**Why movement, not position.** Under pointer lock `clientX/Y` is frozen, so `elementFromPoint` (what
the harness uses) would resolve to the same spoke forever. `updateCommandWheelByMovement` accumulates
`movementX/Y` and takes the angle, with a 14 px dead zone — the same maths `updateToolRadialByMovement`
already used for tools. While the wheel is open, `mousemove` is consumed by it and does not turn the
camera.

**Where the order lands.** `lgRaycastTerrain()` — the ray the pet *go-to* command already used — gives
the ground point under the crosshair at the moment of release. That is the first-person equivalent of
clicking the map. The commanded bot is whatever `selectedBotId` holds; `openCommandWheel` calls
`pickBotAtScreen` at screen centre first, so looking at a bot selects it, and looking at nothing keeps
the previous selection (select a bot, then look where you want it to go). A marker ring drops either
way, because seeing where the order *would* have gone is the feedback.

**Sim side**, identical to the harness: `updateCommandMovement` sits in the out-of-combat chain after
packs and before formation; `commandBreakContact` feeds `c.orderOverride` (the only thing that pulls a
bot out of a fight for a move order — a close self-threat still outranks it) and `commandDoubleTime`
feeds `sc.doubleTime` (→ `STANCE_RUN`). Both reach the commanded bot *and* its squad through
`underCommand()`. A `move` clears on arrival and falls through to formation/patrol; a `hold` parks
indefinitely. The bot answers with `order_ack`, or `order_ack_squad` if it is a squad leader.

The wheel is closed uncommitted on pointer-lock loss and on leaving first person, since neither
delivers the matching `mouseup`. `test-env-command-wheel.mjs` parses the viewer for all of the above —
the failure this guards against is a toggle that the UI sets but nothing reads, which looks identical
in the code to one that works.

## Two bugs from the 2026-08-08 terrain session

### Bots stood still on spawn until an enemy appeared

Out of combat with no patrol points — which is every open-terrain map, since `botSpawnPoints` is
shoot-house-only and `botPatrolRing` needs an authored pcw-layout map — the *only* goal source is an
explore point 80-300 m out along the bot's fixed heading. That goal is usually blocked or off the
384 m combat zone, so `requestBotPath` fell back to "nearest walkable cell to the goal". On real
terrain that cell is routinely across a lake or a ridge, in a **different connected region**: A* failed
a second time, the caller got an empty path, cleared `exploreGoal`, and picked another goal exactly as
unreachable. Forever. Combat worked throughout because a pursue/cover/seek goal is metres away, in the
bot's own region.

Two changes, and the reason there are two is that they fix different halves:

- `nearestWalkableInGrid(grid, x, z, region)` takes an optional region, and the zone branch passes the
  bot's own. A retarget the bot cannot reach is worse than none — it burns the retry.
- `updatePatrolMovement` routes a failed explore goal through the **same local fallback** a cut-off
  patrol point already got (`localPatrolFallbackGoal`), for `PATROL_EXPLORE_RESCUE_MS` (8 s), then
  tries exploring again. That rescue existed but was gated behind `points.length > 0`, so open terrain
  could never reach it.

`test-explore-retarget.mjs` reproduces the whole thing against the real nav-grid on a map split by an
impassable channel: it asserts the unconstrained retarget lands on the far bank and fails, and that the
region-constrained one paths and heads toward the goal.

The two `TEMP diagnostic` console logs from the 2026-07-19 investigation into this are removed. Note
they had gone stale: `[botpath]` only instrumented the **local-window** branch, while Phase D
(2026-07-30) made the **zone** branch the live path on terrain, where the bug actually was.

### Switching body kind froze the game

`Cannot read properties of null (reading 'flush')`, repeating as `Uncaught (in promise)` from
`multiplayer.js`. `rebuildBotBodies()` destroys every rig so the next frame rebuilds it from
`getDesign()` — but a corpse mid-ragdoll is *posed from that rig every frame*, and the ragdoll branch
of `_updateProceduralBodyLod` was the one place that dereferenced `ud.bodyProc` without a null check.
It also leaked a slot from the live-corpse budget, since only `_retireRagdoll` decrements
`_ragdollAwake`. Fixed on both sides: `rebuildBotBodies` retires a live ragdoll before dropping the
rig, and the branch is guarded. Covered by `test-ghost-renderer.mjs`.

### The `!grounded` term condemned 92% of the terrain zone (2026-08-08)

The real reason bots stood still on open terrain, found by instrumenting the bake rather than by
reasoning about it. A per-cause tally printed with the zone bake reported:

```
[bot zone bake #1] 256x256 @1.5m over 384m, 4354 walkable, 24 carved cells, 89 stranded region(s)
[bot zone walkability] 65536 cells: walkable 6.6% · rejected by water 0.0% · slope 0.7% · trees 0.0%
                       · rocks/dressing 0.6% · mesh 92.0% · no height 0.0% (water level -70.0)
```

`botMeshBlockedAt` stands a probe capsule at the cell and asked `blocked = !grounded || pushedXZ >
tol`. But the probe is seated at `groundY + radius + 0.02` — its lowest surface point is 2 cm **above**
the sampled ground — and `map-collision.js`'s `resolveOnce` only reports contact when a triangle comes
within the capsule radius. On accurately-sampled ground the probe therefore touches nothing,
`grounded` is false, and the cell is called blocked. The rule was inverted in effect: the 6.6% it
passed were the cells where the mesh rises INTO the capsule, which are the obstacles.

**Fixed by dropping the `!grounded` term.** Lateral push is the whole signal — standing here, does the
mesh shove the capsule sideways. A pure vertical push (resting on ground, or on a slope) does not
count, and no contact at all now means "nothing in the way", which is the right bias: whether the
ground *exists* is already answered by `terrainHeight` and the water/slope tests, not by this probe.

**A first attempt was falsified by its own test and abandoned:** seating the probe 3 cm *into* the
ground made contact reliable but leaked vertical penetration into a lateral push on slopes — 0.077 m
on a 45° face against a 0.05 m tolerance, so steep-but-walkable ground would have become "blocked".
`test-nav-mesh-probe.mjs` models the capsule/plane geometry (three-mesh-bvh is not installed for Node)
and checks the shipped rule at the *real* slope limit — `atan(0.9/1.5)` = 31°, since
`BOT_TERRAIN_SLOPE_TOLERANCE` rejects anything steeper before this probe runs — where the lateral push
is 0.013 m, about 4× under tolerance. It keeps the falsified 3 cm seat as a negative guard so nobody
re-seats the probe without re-checking slopes.

Note the earlier region-constrained retarget and explore rescue (previous section) were aimed at a
contributing cause, not this one. They stand on their own merits; this is what actually stranded the
bots.

### Bots exiled themselves, and the interim leash (2026-08-08)

Once the walkability fix let bots move, they moved *away*. `rec.exploreHeading` is rolled once at
spawn and never changes, and every explore goal is 80-300 m along it, so an unleashed bot walks a
straight line outward forever — six of twenty-one were found 600 m to 1.1 km out, beached on coastline
outside the 384 m combat zone, while the fight was inside 150 m of the player.

`leashedExploreAim(pos, spawn, heading)` is a pure helper feeding `nextExploreGoal`: inside
`BOT_LEASH_RADIUS` (140 m of `rec.spawnPos`) the bot keeps its own heading and full range; outside it,
the heading points home and `maxDist` is clamped to the distance to spawn, so a goal cannot overshoot
onto the far side and start a fresh outbound leg. A cached goal that leads *further* from spawn is
invalidated, and a leashed pick ignores `rec.exploreHistory` — the history exists to stop a bot
re-picking where it has been, which is exactly what going home is.

This is deliberately interim. The intended model is bots that belong to authored map locations and
only exist while a player is near; the leash is the same mechanism with `spawnPos` standing in for a
spawn location, so that work changes the anchor rather than the machinery. `BOT_LEASH_RADIUS` is a
first guess, not a tuned number.

`test-explore-leash.mjs` simulates 40 goal-hops both ways (unleashed ends 3 km+ out, leashed stays
bounded) and diffs its copy of the helper against the viewer's, since the viewer inlines it.

### Bots walked up to each other and froze (2026-08-08)

Two bots on opposite teams closed to contact and stopped — weapons down, neither firing. The roster
overlay read `pursue … fail0 … STUCK`, and zero path failures on a bot going nowhere is the
contradiction that located it. Two causes, both in the pursuit path, both needed:

- **`pursuitStandoffGoal` handed out goals nobody could path to.** It skips any approach bearing
  another pursuer has claimed, so attackers converge from different sides. When *every* bearing was
  claimed it fell through to `return direct` — and the direct point is only ever reached when it is
  unwalkable, because offset 0 is tried first. So in a converging group everyone after the first got
  an unpathable goal. It now keeps the best walkable-but-claimed bearing in `shared` and returns
  `shared ?? direct`: crowding on one approach is what separation steering is for, standing still is
  not.
- **`updatePursuitMovement` swallowed the failure.** Unlike patrol it never touched `pathFailCount`,
  so an empty path just zeroed velocity and returned. `BOT_PURSUE` is only left by getting *closer* to
  the target, so a bot that could not move could never exit it — parked indefinitely, reporting
  `fail0`. It now returns early when the request was merely `refused` (budget or cooldown, which
  retries on its own), otherwise retries toward the target's own ground snapped into the bot's own
  region via `nearestWalkableInGrid`, and counts a genuine failure so the existing
  `BOT_STUCK_ESCAPE_RETRIES` ladder engages.

## Moss on the ground, and vines that read as ivy (2026-08-09)

Reference-audit items 3 and 5, both first-pass features that were present but not *reading*.

### Moss was only ever on wall caps

`mossWeight` drove the up-facing caps of walls and cover, and on 0.3 m walls that is a strip you
cannot see from a playing camera. Every reference puts moss on the **ground** — carpeting the floor
(01, 02), furring every up-facing stone (10), packed into corners (12).

`groundMoss()` now runs in both `floorMat` and `terrainMat`, gated through the same shared
`mossWeight` law on `normalWorld.y`, so it takes the flats and channels and leaves steep faces bare
— which is the "moss on horizontals" the audit actually asked for. It is a **single** noise tap
rather than an fbm, because the ground is most of the screen. Theme fields `mats.floor.mossColor /
mossGain / mossScale` are optional and read with `??`, same pattern as the concrete block, so the
other six themes keep a bare floor.

The cap mask also widened from `smoothstep(0.5, 0.9)` to `(0.3, 0.75)` and the wall/cover moss gains
went up, so the caps that *are* visible now carry it.

### Vine leaves were flat diamonds, several of them black

Two faults with one cause. The cards were 4-point quads with a forced `(0,1,0)` normal, laid
horizontally. Horizontal is wrong for ivy, and it is also why they went black: a horizontal card
seen from below gets a downward normal under `DoubleSide` and takes no key light.

Leaves now lie **in the wall plane facing outward**, the way ivy actually grows (reference 12).
That is more faithful *and* self-fixing: the wall is opaque behind the leaf, so you only ever view
it from the lit side. Shape is a 5-point fan with mild lobing (`r = size * (1 + 0.2*sin(2a))`) so
the outline reads round rather than as a regular polygon, scattered across the strand rather than
threaded on it, at 8 per strand instead of 5.

The ribbon is no longer leaf-coloured: `push(..., stem = true)` routes it to a woody red-brown that
grades toward the tip colour, which is reference 12's red stems.

Geometry cost per strand went from ~14 triangles to ~52. A dense maze at the default vine density is
therefore in the low hundreds of thousands of triangles for vines alone — the *distribution* and
*leafiness* sliders are the dials if that bites.

## Elevated geometry: overhangs and openings (2026-08-09, `bot-structures.js` + `bot-viewer-v3.html`)

The reference set's most-repeated architectural move is the **soffit** — a slab you fight *under* —
and its second is an **opening** punched through a mass. Every box in the viewer was an upright
solid, so neither existed. Both are now one new primitive.

### Slabs

A slab is `{x, z, w, d, y, h}` with `y` the **underside** above local ground. `layout.slabs` flows
into `activeSlabs`, is placed by `slabTransformOnTerrain` (underside above the *highest* ground
under the footprint, so a slab spanning a dip keeps its headroom), and renders with `wallMat`.

What makes it work is what it is **absent** from:

| List | Slabs in it? | Consequence |
|---|---|---|
| `activeWalls` / `pointInWall` | no | bots walk under an overhang instead of pathing round thin air |
| `sightBlockers` | no | LOS passes underneath, as it does in reality at these heights |
| `mapRoot` (BVH collider) | **yes** | bullets and capsules still stop against it |

That asymmetry is the whole design. A slab listed as a wall would carve a hole in the nav grid
where there is nothing but air, and the cover FSM would generate corner records for a shadow.

**The one invariant**: every slab's `y` must clear a standing bot, or it becomes a trap — nav does
not know it exists, so a bot walks straight in. `test-bot-structures.mjs` asserts this over a
generated map rather than trusting the generators.

### Openings

`wallRun` now returns `{ walls, covers, slabs }`, because one opening emits three kinds of geometry:

- **Door** — gap in the wall, plus a lintel slab from `doorHeight` to `wallHeight`. Previously a
  doorway was a full-height slot; now there is concrete over your head as you go through.
- **Window** — the same, plus a **sill emitted as `cover`**. That is deliberate rather than lazy:
  a sill's behaviour *is* cover — it blocks movement and you shoot over it — so putting it in the
  cover list gets the FSM and the nav grid right for free.

`wallHeight` must be passed as the viewer's live `WALL_H`; a stale value leaves a floating lintel or
a gap over every door, which the test also covers.

### Portals

A new structure kind: two piers carrying a deck at `wallHeight`. This is references 03 and 07
directly — the underpass — and the only structure you fight *under*. Piers are walls (they block
sight and movement); the deck is a slab (it blocks neither). Selectable in the structure-mix
dropdown, and included in `mixed`.

Note `mixed` now rolls from four kinds rather than three, so **existing structure seeds produce
different maps**.

### Flora

Slabs reach `bot-flora.js` as their own `vineBoxes` list, not folded into `wallBoxes`: vines hang
off canopy and deck edges (references 09 and 12), but slabs must not become ground keep-outs,
because grass grows right up under a soffit in references 03 and 07.

## Eco-brutalism: concrete surfaces and growth (2026-08-08, `bot-viewer-v3.html`)

A theme where the map is cast concrete slowly going back to the ground. Reference photographs are in
`references/eco-brutalism/`. Three parts, each independently switchable: a **theme**, a **concrete
material treatment**, and a **flora system**.

### The two optional theme blocks

The existing seven themes are a closed shape — `validateTheme` asserts every field of every section,
and `normalizeTheme` backfills a saved slot from `THEMES[DEFAULT_THEME]`. Rather than widen that shape
and edit all seven, concrete and flora are **optional blocks**, deliberately absent from
`THEME_SECTIONS` and `REQUIRED`:

| Block | Lives at | Read via | Default |
|---|---|---|---|
| Concrete | `mats.wall.concrete`, `mats.cover.concrete` | `concreteFor(matBlock)` | `CONCRETE_OFF` (gain 0) |
| Flora | `theme.flora` | `floraFor(theme)` | `FLORA_OFF` (density 0) |

Both merge over their defaults, so every read site gets a complete object and no caller writes `?? 0`
per field. A theme that omits a block gets zeroes and renders exactly as it did before — which is what
`test-bot-flora.mjs` asserts for all seven pre-existing themes, one check each. `cloneTheme` is a deep
JSON clone and `normalizeTheme` only ever *adds* missing keys, so both blocks survive a save/load slot
round trip with no plumbing in the slot code at all.

### Concrete (`concreteAlbedo` in `bot-viewer-visuals.js`)

`wallMat.colorNode` and `coverMat.colorNode` were bare colour uniforms; they are now a node graph
over that colour. Walls and cover own **separate uniform sets**, so cover can weather harder — it sits
at ground level in the wet and is small enough to be swallowed.

Every box in a layout is axis-aligned (unit `BoxGeometry`, scale-and-translate instance transforms
only), so the local normal names a world axis directly and world XZ/Y serve as the surface's own
coordinates. No tangent frame is needed or built.

- **Form-panel grid** — a recessed joint wherever two form panels met (`panelW`/`panelH`/`seamWidth`).
  References 07, 08 and 12 are panel-formed, which is why this is the primary system.
- **Board-form grain** — a line at each board edge, *plus a per-board tone offset*. The tone offset is
  what actually sells board forming: every board pours a slightly different shade, and the lines alone
  read as a decal rather than a construction method. References 04, 05 and 13.
- **Form-tie holes** on their own coarser grid.
- **Exposed aggregate** — high-frequency speckle over slow patina blotching (reference 12).
- **Rain streaking** — noise that varies *only* along the wall run, so it reads as vertical columns
  rather than blotches, faded down from the top edge over a per-column length.
- **Growth**, in two terms that are deliberately not one:
  - `mossWeight()` from `moss-tint.js` — the repo's one moss law, shared with env-viewer's terrain and
    rocks — drives the **caps only**. Its `upness` gate hard-zeros below normalY 0.45 by design: moss
    holds on tops, not on cliffs.
  - The damp green creeping up the **base of a vertical face** (references 01, 10, 12) is a separate,
    simpler `algae` term. Feeding a fake `upness` into the shared law to make it do something it says
    it does not would have been the wrong fix.

**Cost, stated plainly.** This evaluates three value-noise taps per fragment on *every* theme, not just
the ones with `gain > 0` — `gain` is a uniform, so the graph cannot be branched away, and the
alternative (a second material swapped per theme) means a pipeline recompile on every theme switch,
which `bot-viewer-visuals.js` exists to avoid. `patina` is shared between the mottle and the moss
break-up rather than each taking its own fbm, which saves a tap and is if anything more correct. If
this shows up in a profile, the material swap is the fix, not a cheaper noise.

### Flora (`bot-flora.js` + `bot-flora-place.js`)

Ported from the environment viewer's vegetation subsystem, with one deliberate simplification:
env-viewer streams chunks around a moving player across an infinite world, and a bot arena is a small
bounded box fully in view, so this places the whole map in **one pass and never streams**.

| Part | Source | Notes |
|---|---|---|
| Grass | `grass.js` (`createGrass`) | One merged field, square mode, positioned at the arena centre |
| Understory plants | `plants.js` / `plants-placement.js` / `plants-gpu.js` | Lazily imported; one `'arena'` chunk replaces the streaming window |
| Vines | new, in `bot-flora.js` | No env-viewer counterpart |

`bot-flora-place.js` is the pure half (no three.js), tested by `test-bot-flora.mjs` — the same split as
`bot-viewer-visuals-style.js` / `bot-viewer-visuals.js`.

**Keep-outs.** Wall and cover boxes widen by `clearance` into rectangles; spawn points contribute pad
rectangles. A blade landing inside one is *dropped as a gap*, never relocated — the same mechanism
`grass.js` already used for submerged blades, reached through a new optional `acceptFn(x, z, y)`
option (backward compatible; env-viewer does not pass it). The clearance is not cosmetic: a blade
planted flush against a wall pokes through it from the far side, because a blade is a flat card with
no thickness. Below roughly 0.2 m it starts showing.

**The blocker index.** A maze layout is ~950 wall boxes and a grass field is tens of thousands of
placement attempts; the linear scan that product implies is tens of millions of rect tests per rebuild.
`buildBlockerIndex` buckets rects into a uniform grid. The test asserts the index never disagrees with
the brute-force scan it replaces, over 4000 samples and at two different cell sizes.

**The density subtlety.** `createGrass`'s square mode scatters uniformly over a *square*, and an arena
is generally a rectangle. Sizing the request to the rectangle's area would thin the field by the
rectangle's aspect ratio. So `bladeBudget` sizes the request to the bounding square and the overspill
outside the rectangle is dropped by the same `acceptFn`.

**Plant distribution** (fixed 2026-08-08 after the first browser look). Three things were wrong, and
the first was a real bug:

1. A chunk is necessarily **square** — `plants-placement.js` scatters over `size` on both axes — and
   an arena is a rectangle. `floraChunk` originally anchored that square at the padded bounds'
   *corner*, so the entire overspill landed past **one** edge: on the rooms map, an 18 × 18 square
   over an 18 × 12 arena put a third of the plants in a 6 m band off the south side. The square is
   now centred, and — the actual fix — the plant filter tests `inRect(padded, …)` as well as
   `isBlocked`. `isBlocked` cannot catch this: outside the index it correctly reports nothing
   blocking, because out there is nothing at all. The grass path already had this test; the plant
   path did not, and that inconsistency was the bug.
2. `clumpRadius` defaults to `chunk.size * 0.16`, which is fine when a chunk is one tile of a
   streamed world and useless when it is the whole arena — 2.88 m on the rooms map, at which a dozen
   clumps overlap into flat scatter and the clumping silently does nothing. Now set explicitly
   (`plantClumpRadius`, 1.2 m).
3. Nothing told the placer that walls matter, so plants scattered evenly and said nothing about the
   architecture — where every reference photograph has the understory **massed against the
   concrete**. `wallAffinityMask` feeds `plants-placement.js`'s `densityAt` hook with a quadratic
   falloff from the nearest keep-out rectangle. Because `densityAt` is a rejection gate it only ever
   *removes*, so `plantDensity` is now the **near-wall** density and `plantOpenFloor` (0.25) is the
   fraction surviving in the open — which is why `plantDensity` rose from 0.22 to 0.55 in the same
   change and is not an increase in the plant count.

`nearestBlockerDist` reuses the blocker index, searching only the cells within the reach, so the mask
costs the same whether the map has eight walls or nine hundred.

**Per-species controls** (2026-08-09). The Flora card carries a species dropdown plus a height and a
density slider, writing into the theme's `speciesHeight` / `speciesDensity` maps (absent key = 1x).
The two cost very different amounts: **height** is baked into the palette geometry, so
`createPlantPalette` gained a `heightScale` option and changing it tears down and re-bakes the whole
plants-gpu host (keyed on the map's signature, so a rebuild that didn't touch it reuses what's there);
**density** only reweights the species table `plants-placement.js` picks from, so it costs a
re-placement and nothing more. Density is relative, not absolute -- raising one species crowds out the
rest rather than adding plants. `floraFor()` deep-copies both maps, because a plain spread aliases
`FLORA_OFF`'s own objects and the panel writes directly into them.

**Vines** hang from wall **top edges**. `vineAnchors` takes the *rendered* boxes — the output of
`boxTransformOnTerrain`, not the layout rectangles — so a wall sunk into a hillside grows its vines at
its real top rather than at `WALL_H`. Each of a box's four top edges is walked independently: a wall
running along X is a long box with a thin depth, so its two long faces collect nearly every strand and
its 0.3 m end caps collect none, which falls out of the edge length with no special-casing of wall
orientation. Fractional strand counts are treated as a **probability**, not truncated — a `floor()`
there would silently strip every short wall segment out of a maze, which is most of a maze.

Three controls shape them: **distribution** (`vineClump`) lerps each strand from its evenly-spaced slot toward one of a few bunch centres on that edge, so 0 is even spacing and 1 is tight bunches with bare stretches between; **leafiness** scales both the card count and card size; **branching** is the chance a strand forks into a shorter, thinner one partway down, one level deep only (branches of branches double the geometry for something nobody can pick out at this size). A strand is a tapering ribbon that leaves the top edge, bellies away from the face and falls back
against it (one that hung straight down read as a wire, not a plant), with leaf cards along it. Leaf
normals point up rather than along the card, the same trick `plants.js` uses on its shrub clumps —
a flat card lit by its own face normal flickers black as the camera orbits. Wind rides on a per-vertex
weight, squared in the shader, exactly as `grass.js` does it.

### Wiring in `bot-viewer-v3.html`

- Flora owns **its own group under `scene`, not `mapRoot`**. `applyLayout` tears `mapRoot` down by
  disposing every geometry it finds, which would destroy the plant palette's shared baked geometries —
  those are built once and reused across every layout.
- `applyLayout` now keeps `activeWallBoxes` / `activeCoverBoxes` (the terrain-sunk boxes it was
  previously building inline) because flora reads the same boxes for keep-outs and vine anchors.
- `createVisualSystem` gained an **`onLookChange`** callback, fired at the end of `applyAll()` and by
  the flora toggle. A theme switch swaps the `flora` block, and flora is geometry that module does not
  own, so it reports the change and the host rebuilds. `flora` is declared as a `let` *before*
  `createVisualSystem` because that constructor applies the theme, which fires the callback once before
  flora exists — a `const` would be in its temporal dead zone.
- `flora.update()` is **awaited** in the frame loop: the plant pass is a compute cull whose indirect
  draw counts this frame's draw reads, and an unawaited compute races the draw. It reports as the
  `flora` phase in the frame profiler.
- Panel: a **Flora** card whose sliders edit the *active theme's* flora block in place, the same way the
  look sliders edit its colours — so they ride along in look slots and save/load slots with no extra
  plumbing. Wind commits live; everything else rebuilds geometry and so commits on release, for the
  same reason the terrain sliders do. Two new toggles, *Concrete weathering* and *Flora*, join the
  Visual toggles card.

### Status

Node-tested (`test-bot-flora.mjs`, 63 checks); the seven existing themes, `test-bot-viewer-visuals.mjs`,
`test-moss-tint.mjs` and the nine grass/plant suites are unchanged and green. Not yet looked at in a
browser, so the numbers in the theme's `flora` and `concrete` blocks are first-draft values chosen from
the reference photographs, not tuned against a render.

## Drone operators (2026-08-10, `bot-drones.js` + `flight-meshes.js` + `bot-viewer-v3.html`)

A sixth role that fights through aircraft instead of through its rifle. The operator is a rear-line
body: `standoffScale: 1.9` (a new `ROLE_DEFAULTS` field, read by `botWeaponStandoff`) puts it at a
sniper's distance — ~20 m with the 120 m `cz_805_bren` — without giving it a sniper's gun, and
`sightScale: 1.35` is what lets it point drones at things the line has not reached yet.

The craft themselves are the flight sim's, not new art: `flight-meshes.js` was split out of
`demos/flight-sim.html` so both pages build the same quad and the same fixed wing. Materials are a
caller-supplied `{ standard, basic }` pair, because the sim runs node materials and the bot viewer
does not. The sim's own render is unchanged — `buildMesh` there is now one call into the module.

### The two aircraft

| | Bomb drone (quad mesh) | Loitering munition (fixed-wing mesh) |
|---|---|---|
| Count | **one, reusable**, per operator | expendable, 2 carried by default |
| Slot | one man flies one aircraft (`aloftMax` 1) | shares that same single slot |
| Cruise | 14 m, 9 m/s | 20 m, 10 m/s |
| Cycle | climb → attack → egress → **dock in the operator's hands** → reload (7 s) | climb → orbit a drifting centre → dive |
| Kill | 46 damage / 5.5 m blast per bomb, 2 bombs a sortie | 62 damage / 5 m blast, spent on impact |
| Ends when | the operator dies (it falls) | it hits, or endurance (80 s) runs out |

Both fly in `bot-drones.js` — pure array math, no THREE, Node-tested in `test-bot-drones.mjs`. The
viewer owns the meshes, the projectile, the blast and the sound, exactly like the grenade split.

### Bombing is a solved release, not a proximity check

`bombLead(height, speed, gravity, vy)` returns how far short of the target a bomb has to leave the
rack: release speed × time of fall, with the drone's own vertical velocity in the fall time. The
drone drops when it is aligned (≤ 0.3 rad), level (± 3 m of cruise) and exactly that far out.

Two things were wrong on first authoring and both looked fine in isolation:

1. **The second bomb landed 3 m long, every sortie.** Release happens a lead-length *short* of the
   target, so 1.6 s later the drone is still aligned and still closing — the drop gate passed again
   from inside its own lead distance. Fixed by flying a real go-around (`reattack`) after every
   release, plus a `dropWindow`: a pass that arrives late is spoiled, and a spoiled pass goes around
   rather than dropping long.
2. **The go-around never came back.** Its turn point was recomputed each frame from the live
   heading, so the drone chased its own tail in a 7 m circle over the target forever. The turn point
   is now frozen when the pass ends.

Measured after both fixes: every bomb of a sortie lands within 1 m of a stationary target, from four
different approach bearings. That is the claim `test-bot-drones.mjs` asserts.

### One man, one aircraft

`aloftMax` (1) caps how many drones an operator has **in the sky**, and "aloft" means *on task*: a
bomb drone shadowing him or sitting in his hands is not flying a mission and does not hold the slot.
So a munition can go up while the bomb drone waits, and the viewer sets `standDown` on the bomber
while one is out, which brings it down to the dock rather than leaving it circling — the slot is
visible from the ground, not just a number. `bomberReady` is the other half of the decision: whether
that parked drone could be sent right now, which is what decides if the slot goes to a munition
instead. A bomb drone that already exists is **re-sent by the module**, never re-spawned by the
launch path — spawning one that exists is how an operator ends up with two.

### Dead stick

The bomb drone is being *flown* by the operator, so when he dies it does not vanish: `orphanDrone`
puts it in `deadstick` and whatever is still on the rack goes off where it lands. `detonateBlast` has
never cared about teams, so a wreck coming down on the operator's own squad hurts them, which is the
intent rather than a case to filter out. A dry drone just breaks. The loitering munition is
unaffected by his death: it is fire-and-forget and finishes its errand.

**Being shot down is the same problem, and used to have the opposite answer.** A laden bomb drone
killed by gunfire simply disposed itself in mid-air, so shooting the aircraft was *safer* for
everyone underneath than shooting the pilot. `damageDrone` now rolls `deadstickChance` (1 in 3) on a
lethal hit above 2 m: on the roll it stops being flown instead of coming apart, and a second hit
while it falls finishes it normally — which is also what stops the roll re-rolling forever.

`crippleDrone(d, { wild, phase })` puts **either** airframe into dead stick, in one of two flavours
(`deadstickWild` splits them, default half and half):

- **fall** — ballistic, drag, tumbling: straight down from wherever it was hit.
- **wild** — the rotors still bite but nothing is steering. It flies off on a wandering heading,
  sinking, until `wildS` (6 s) of power runs out and it drops the rest of the way. The wander is
  summed sines off a per-drone `phase` rather than per-frame noise, which reads as a stutter rather
  than as a drone, and the sines are deliberately **slow** (0.55 and 0.23 Hz): a fast oscillation
  circles one spot like a trapped fly instead of carrying away. A drone hovering when it was hit has
  no speed to run with, so `crippleDrone` gives it the airframe's own speed along its last heading —
  without that, a wild dead stick was indistinguishable from a plain fall.

Either way the wreck reports what it was carrying. `out.bombsAboard` scales the crash blast by **every
bomb on the rack** (it was capped at two, an arbitrary first-draft number, while the slider goes to
six), and `out.warhead` is what tells the viewer a *munition* has landed: a loitering drone is itself
the warhead, so it goes off whether or not it was carrying anything.

### Spares are finite

The bomb drone is reusable, which used to also mean free: destroyed, it respawned at full HP with a
full rack after `bomberCooldownMs` (4 s), forever — so shooting one down bought four seconds, while
the munitions beside it were a hard, non-replenishing stock. Each loss now counts against
`bomberReplacements` (**1** by default), and past that the operator has no bomb drone for the rest of
the match: he fights on with whatever munitions remain and his rifle. Only a drone removed by
`updateBotDrones` counts — *Ground every drone* on the panel is a debug button and must not spend an
operator's spares. The **Bot readout** `drones` row shows what is left (`spares 1, munitions 2`),
because an operator with nothing coming otherwise looks exactly like one with an aircraft on the way.

Worth knowing while tuning: `bomberCooldownMs` paces the *first* launch and any replacement, not
repeat sorties. Once the aircraft exists, `stepBomber` sends it back out from the rack as soon as it
has a target and bombs, so an established bomber is paced by flight time plus `reloadS`.

### The bomber is a multirotor, so it can stop

`cruiseTo` renormalises velocity to the airframe's cruise speed every step, which is a fixed wing's
constraint and was applied to both aircraft. The bomber now has `canHover`, and with it `hoverTo` —
a commanded velocity straight at the goal that may be zero, first-order because a quad still has
mass, it just has no turn radius. `advance` keeps the last heading below 0.5 m/s, since a hovering
drone has no velocity to read a facing off and would otherwise spin on numerical noise.

Two behaviours fall out of that:

- **Hover-drop.** It stops directly over the target at `hoverDropAlt` (11 m) and releases once it is
  within 0.6 m horizontally and under `hoverDropSettleSpeed` (0.35 m/s). The bomb falls straight
  down, so there is no lead solution and no go-around: measured miss 0.53 m and 0.03 m for the two
  bombs of a sortie, against 0.05–0.7 m for the flying pass. The cost is a stationary drone at 11 m,
  which is exactly what air defence wants. `hoverDropSpeedGate` picks the attack: a target moving
  slower than 0.6 m/s is bombed from a hover, anything faster gets the flying pass, because a bomb
  released from a hover lands where the drone is, which is behind anything that moves. A hover drop
  whose target starts walking switches to a pass mid-attack.
- **The dock, and the shadow.** Rearming is a man hanging bombs on a rack, so the drone descends to
  `dockAlt` 1.0 m, `dockOffset` 1.5 m in front of the operator's facing (clear of his shoulders — the
  airframe is about a metre across), holds a commanded heading rather than drifting on its last one,
  and the reload clock runs only while it is within `dockRadius` of that point: a drone that never
  reaches its operator never rearms. Only an **empty** rack is worth that. A loaded drone with
  nothing to bomb `shadow`s him instead, at 5 m over his shoulder, and follows him as he walks —
  otherwise an idle operator spends the match servicing a full drone.

### Targeting

- **The operator** only ever points a sortie at what its own FSM can see or has just seen (visible
  target, else `lastKnownTarget`). Around that point it gathers enemies within `seedRadius` (12 m)
  and `pickDroneTarget` picks the best cluster, so a drone goes to the pair standing together rather
  than to whoever happens to be nearest. The pick is passed `minTargetRange` as well as `from`: the
  launch gate checks the *seed*, and without this the cluster pick could then choose a neighbour up
  to a `seedRadius` nearer the operator — inside the range his own blast reaches.
- **An aircraft flies with the numbers that were on the sliders when it launched**, and that now
  includes damage and blast radius. They were the one exception, read live at the moment of
  detonation, so nudging the damage slider mid-sortie changed the bomb already falling and could
  differ between bomb one and bomb two of the same pass. A dropped bomb carries its own numbers on
  the projectile, since the drone that released it may be long gone by the time it lands.
- **In the air** the drone re-acquires for itself, every frame: nearest live enemy within
  `scanRadius` (45 m). It keeps the lock it already has while that one is still in view and makes a
  rival be `DRONE_LOCK_MARGIN` (25%) closer to steal it — the same anti-flicker idea the ground FSM
  has, and without it two bots at equal range trade the lock every frame and a bomber loses its run
  to the flip.
- **Memory is a direction to go and look, never a reason to drop anything.** With nothing in view the
  drone flies the operator's last assignment, then its own last sighting, for `DRONE_SEEK_LOST_MS`
  (6 s) — but the point is flagged `stale`, and stale implies `holdFire`. It arrives, finds nothing,
  and does not attack. Three compounding bugs made "drones bomb bare ground" the normal case:
  1. The operator re-stamped each assignment with `now` every think tick, so a sighting from half a
     minute ago stayed permanently "fresh". Assignments now carry `lastKnownTargetAt` — the age of
     the **sighting** — and a sighting older than `DRONE_SEED_MAX_AGE_MS` (4 s) does not launch one.
  2. `stepBotDrone` stored whatever point it was flying as `d.aim`, including a remembered one. So the
     assignment lapsed, the drone adopted the same stale point as its new last-known, and renewed its
     own ghost indefinitely. A stale point is now flown toward but never stored.
  3. Nothing distinguished "I can see it" from "I remember it" at the release gate, so a loiterer
     would dive into empty ground and a bomber would drop on it.
- **It has to be able to see it.** `droneSees` raycasts from the aircraft to the candidate before
  accepting it, budgeted at two rays per drone per frame (the current lock, then the nearest as a
  fallback) because this runs every frame for every drone. Anything occluded is not a sighting: it
  drops through to the memory branch above, which is `stale`, which holds fire. That is the whole
  chain that stops a hover-drop through a roof — no new machinery, just the existing one told the
  truth. The airframe itself still has no collision, so drones fly *over* walls freely; they simply
  cannot attack through them any more.
- **A run it can never release is given up.** `holdGiveUpS` (6 s) counts time spent in an attack
  state under `holdFire` and egresses past it. Without it a drone held off by a roof or by an ally
  hovers over the spot for as long as the operator keeps feeding it the same point, which is forever.
- **Friendly veto**: a drone holds FIRE if any ally sits within 1.1 × its blast of the aim point —
  the same rule the grenade AI has, but expressed as `holdFire` rather than as a lost target. The
  bomber flies its pass and simply does not release; a diving loiterer waves off and climbs back.
- Blasts go through `detonateBlast` with a weapon-shaped literal (`drone_bomb` / `drone_kamikaze`),
  so falloff, wall occlusion, knockback, squad alert reports and kill credit are the harness's
  existing ones and not a second implementation.

### Panel

**Bots → Drones**, under Explosives: a sortie on/off toggle, a *Ground every drone* button, the
**Drones frighten bots** and **Drone threat debug** toggles, and three subsections (bomb drone,
loitering munition, both) covering altitude, speed, bomb count, reload, damage/radius, endurance,
stock, cooldowns, camera range, cluster radius, run-rather-than-shoot share, dead-stick chance and
its wild share, and model scale. Everything rides in the save slots as `drones`, the two toggles
under `debug`. Composition gains a **drone operator %** input (default 0) and a **Spawn drone
operator** button.

**Bot readout** gained a `drones` row, because every number above was authored blind — nothing on
screen said what an aircraft was doing. It lists, per drone the selected bot owns: kind and bombs
left, state (including `deadstick/wild` vs `deadstick/fall`), height above its own ground, HP, what
it is locked on or `>memory`, and `HOLD:stale` / `HOLD:friendly` when it is holding fire. Select
anything that is not an operator and it falls back to a count of everything in the air.

### The squad waits for him (S15)

Servicing is hands-on, so the operator stops: he marks himself **busy** (`markBotBusy`), takes a
`'service'` hold on the existing bot-to-bot hold channel, and kneels. Without the hold the kneel was
just a pose over a bot still walking its patrol route — a bot sliding along the ground on its knees.

The rest of his squad holds too, through a seam meant to outlive this one use:
`squadHaltRequest(members, now, state)` in `bot-squad.js` takes each member's `{ busyReason,
busyUntil }` and returns who the squad is waiting for. Reasons are **ranked** (`BUSY_ENGAGED` >
`BUSY_MEDIC_TEND` > `BUSY_DRONE_SERVICE`) so two busy members do not fight over the halt, ties break
on lowest id so it cannot flap, and the whole wait is capped at `SQUAD_HALT_MAX_MS` (20 s) so one
stuck bot cannot freeze a squad for the rest of the match — with the clock restarting when a
different member takes the halt over, because waiting for two people in turn is two waits.

Only the drone operator marks itself busy today. **Medics mid-channel and bots in a firefight are the
next two**: both already stop on their own, and marking them busy is what turns "this bot stopped"
into "the squad waited for it". The halt is memoised per squad per frame (`haltComputedAt`), and it
only bites in `PATROL`/`SEEK`/`PURSUE` — a member with a visible enemy fights rather than waits.

### Air defence — what the ground does about it

A bot with **no visible ground target** engages the nearest drone within `airEngageRange` (35 m,
slant range, so altitude counts against it) that it has line of sight to, after an `airNoticeMs`
reaction delay. It is an aim-and-trigger override laid over whatever the FSM already decided about
movement, so a patrolling bot keeps walking and shoots upward rather than stopping to duel a drone.

A gunfight outranks a drone *cruising* overhead, but no longer one that has **committed** — see the
threat section below. With a ground target visible, only `droneTerminal` aircraft are considered.

- **The close-range self-splash gate has to see what is actually being shot at.**
  `updateBotWeaponSlot` takes the distance to the target and swaps to the sidearm inside
  `role.closeRange` (10 m for a technical, drawn above the RPG's 8.2 m blast). It was fed only the
  *ground* target's distance, which sits at `Infinity` in exactly the condition air defence runs in —
  so a technical kept the RPG and rocketed a bomb drone hovering 11 m over its own head. It is now
  fed `min(ground, air)`.

- The drone is a hit volume in the same `resolveHitscan` call the ground target uses (`bodyRadius`
  0.55-0.6 m), so one shot path serves both and a bullet can only hit one of them.
- Hitscan needs no lead, so the aim point is the drone itself; a **projectile** weapon (a technical's
  RPG) is led with `airLeadPoint` at the projectile's own speed.
- Airframes have HP (bomber 30, munition 22) — a rifle burst brings one down. A shot-down aircraft
  either comes apart in the air (a munition detonating where it was, a bomb drone simply breaking)
  or goes **dead stick** and comes down still loaded — see above.
- The shooter **keeps** the drone it is already on. `pickAirTarget` takes a `lockId`/`lockMargin`
  (the drone's own commit dwell, pointed the other way), and a *single* blocked frame no longer drops
  the lock — it takes `AIR_LOS_GRACE_MS` (600 ms) of continuous occlusion. Both exist for the same
  reason: swapping or dropping restarts the `airNoticeMs` recognition delay, so a drone bobbing
  behind a roofline, or two at similar range, left a bot perpetually half a second from firing and
  never actually shooting. It still cannot shoot through a wall while blocked; it just keeps the
  target.
- Blasts reach up: `detonateBlast` now damages drones inside its radius too, so a rocket or grenade
  under a drone is not wasted. That pass is **occlusion-aware** as of the same change — it was pure
  distance, so a blast on one side of a wall damaged a drone on the other, while ground victims had
  gone through `blastExposure` since it was written. One ray per drone, not the three-sample capsule
  sweep: an airframe is a point at this scale. Victims are snapshotted and the centre read into locals first, because
  a munition detonating from inside that loop re-enters the same function with the scratch vector.
  **The drone is marked spent before its warhead goes off** — its own blast comes back through
  `blastDamageDrones` with it at distance zero, and while it was still marked live that recursed
  `detonateBlast → blastDamageDrones → damageDrone → detonateBlast` until the stack gave out and took
  the WebGPU device with it. `test-bot-viewer-drones.mjs` parses that ordering out of the source,
  since none of this can run in Node.
- A shot at a drone does not feed the pursue-on-miss streak — that counter is about ground fights.
- Air defence fires from whatever state the ladder left the bot in, usually patrol, so it sets
  `airEngaging` and the weapon mount trains on that as well as on the firing states. Without it a bot
  shoots at a drone out of a cross-body carry, which is the sniper-shooting-the-sky defect again;
  `test-bot-fire-aim-sync.mjs` covers the air path too.

### A committed drone frightens the bots under it

A drone in its **terminal phase** — a bomber stopped overhead to release (`hoverdrop`), or a munition
already diving — is a grenade with a longer fuse, so it goes through the grenade threat channel
rather than a second implementation. `refreshGrenadeThreats` appends one entry per terminal drone
marked `air: true`, and everything the bots already do about a live grenade follows for free: the
warning call-out, the run for a nav cell the blast cannot see, the stance, and `reportGrenadeThreat`
pushing an ally report — which means **being bombed is a bearing on the operator**, since the threat
carries `throwerId`.

**A bomb already off the rack is a threat too**, and is the most immediate one on the field. The
projectile filter admitted only grenades, so bots stood still underneath live ordnance for its whole
fall. It cannot use `sim.life` as a fuse — that is the 8 s flight cap, which would report six seconds
left on a bomb one second from landing — so the fall is solved ballistically and the ring is drawn
where the bomb will *land*, carried forward by its own horizontal velocity. It is deliberately not
flagged `air`: you cannot shoot a falling bomb, so there is no run-or-shoot choice to make about one.

Two details the drone threats could not inherit:

- **The threat point is the impact, not the aircraft.** `droneImpactPoint` puts it where the blast
  will actually be: straight down under a hover-drop, at the aim point for a dive. A ring drawn
  around a drone at 14 m is nowhere anyone is about to be hurt, and the blast-shadow cover search
  scores from that point.
- **Run and shoot, decided by how close it is.** A grenade can only be run from; a drone can be shot
  down, so a squad under one does both. Each bot rolls its own nerve once per drone and keeps that
  number; it breaks when the roll falls under `threatFleeShare × √nearness`, where nearness is 0 at
  the edge of the blast ring and 1 at the impact point. So at the edge nobody runs and everybody
  shoots, and the closer the thing gets the more of them break — the share is what runs when it is
  right on top of them, not a flat split.

  The roll is per **attack run**, not per aircraft. The threat id is `${drone.id}#${runSeq}`, where
  `runSeq` bumps each time that drone enters a terminal state. Keying on the drone id alone was
  correct for a munition — spawned per launch, fresh id every time — and quietly wrong for the one
  reusable bomber, whose id lasts the whole match: the first hover-drop of the game decided every
  bot's reaction to that airframe permanently, so the proximity gradient stopped applying after one
  encounter.

  The decision **escalates and never reverses** while the bot is inside the ring: a bot that talks
  itself back into standing still mid-run reads as broken. Running ends by *leaving* the ring —
  `grenadeEvade` drops the threat past `blast × evadeExitScale` (1.25), and the next frame's chain
  finds the bot with nothing to run from and a drone overhead to shoot at. Not running is not
  passivity: it falls straight through to air defence, which is why committed drones are exempt from
  the "a gunfight outranks the air" rule.

Both halves are gated on the **Drones frighten bots** toggle, and **Drone threat debug** draws them:
red ring where the blast will land, orange line up to the drone above it, amber lines for bots
running (and where to), cyan for bots shooting back. It is the grenade overlay's twin and shows the
one thing that one cannot — which bots chose which.

### Three more bugs, all visible only on screen

1. **The bomb drone kept flying back at its own operator.** Station keeping cruised *at* the home
   point at 2.2 m altitude, so it overshot him, turned, and came back through him twice a lap — a
   fixed wing's flight model on a quadrotor. It hovers at the dock now (above); the wing-only
   fallback circles with `orbitAround` instead.
2. **A friendly near the target sent the drone home.** The veto nulled the target, and a null target
   means egress — with an ally drifting in and out of the ring the drone shuttled home and back.
   Split into `holdFire` (above), plus a `targetGraceS` of 3 s so a blink in LOS does not end a run.
3. **The aircraft flew tail first.** `Object3D.lookAt` points **+Z** at the target (only cameras and
   lights point −Z), and the flight-sim craft are modelled nose-forward −Z. The pose now flips 180°
   after the lookAt; the bank rolls with it.

### Known gaps

- The drone **airframe** still ignores walls and roofs — it flies over and through geometry freely.
  Only its targeting and its ordnance are occlusion-aware now (`droneSees`, and the bomb's own
  raycast). Real avoidance is a steering problem worth much less than the targeting fix was.
- The state code's role slot still reads `r` for an operator, exactly as it does for snipers and
  technicals.
- The operator services its drone with a kneel and nothing else — no arm IK reaching for it.
- `aloftMax` (default 1) caps one operator's sky, and the bomber now stands down only once munitions
  *fill* that cap rather than for any munition at all — which is what made the slider above 1 do
  nothing for it. They still leave one at a time: `decideDroneLaunch` returns a single kind per tick
  and the cooldowns (4 s / 14 s) space them. Nothing releases two aircraft in the same instant.
- Nothing caps drones **globally**, only per operator. A high drone-operator percentage puts one
  aircraft per operator in the air with no ceiling.
- The operator is effectively fed only by his own eyes, and he stands 1.9× further back than anyone
  else — so the unit with the widest view in the game is seeded by the bot least likely to have a
  target. **An earlier version of this doc said `bot-contacts.js` was unconsumed; that was wrong.**
  `latestContactNear` already feeds every bot's `lastKnownTarget`, the operator included, and that is
  exactly what seeds a sortie. The real problem is narrower: its radius is measured from the reader
  to the **reporting ally** (`CONTACT_SHARE_RADIUS`, 18 m), standing in for "close enough to hear the
  shout" — and a standoff operator is usually outside 18 m of the squadmates actually doing the
  spotting. The cheap fix is a role field scaling that radius (the `sightScale`/`standoffScale`
  pattern), or a team-wide variant with no reader-distance check at all, on the grounds that an
  operator is trusting a radio rather than his own ears.
- The drone's own sighting goes nowhere but its bomb. `droneTargetPoint` produces a clean
  LOS-checked contact every frame from the highest vantage on the field and throws it away; pushing
  it into `recordContact` would make the aircraft a spotter for the whole squad.
- Numbers are first-draft: tuned in Node against the trajectories, never yet watched in a browser.

## Squad orders (2026-08-12, `bot-orders.js`)

The first piece of adversary mode. A commander who can only hold one thought at a time cannot run a
battle, and that is literally what the game had: `commandTargetId` was **one module-level variable**,
so ordering a second squad did not countermand the first order, it overwrote it.

`bot-orders.js` is pure — no THREE, no DOM, no clock of its own — and is covered by
`test-bot-orders.mjs`. `environment-viewer-v2.html` owns one `orderBook` and writes to it from the
command wheel.

### What actually changed, and what did not

Movement behaviour is close to unchanged, and that is on purpose. Ordering a squad leader already
moved the whole squad before this: the leader took the `command` branch of the out-of-combat chain,
every other member failed the `activeBot.id !== commandTargetId` check, fell through to
`updateSquadFormationMovement`, and followed the leader. That still happens. The four real deltas:

| | before | now |
|---|---|---|
| **Plurality** | one order, game-wide | one order per addressee, any number at once |
| **Addressing** | a bot id, only from a crosshair | a squad id (or a bot id), from anywhere |
| **Lifecycle** | cleared only by arriving | pruned when the addressee dies, or by TTL, or by cancel |
| **Inheritance** | none — squads reshuffle every 700 ms | carried across merge, split and detachment |

### The order

`issueOrder(book, {scope, addressee, kind, goal, teamId, doubleTime, breakContact, issuedAt, ttlMs})`.
`kind` is `move` or `hold`; anything else is refused rather than stored as a no-op, as is a missing or
NaN goal. One addressee holds one order — re-issuing replaces. Every order gets a fresh ascending id,
so a late acknowledgement can be told from a live one, which is what a network or LLM commander needs.

`doubleTime` and `breakContact` are now **per order**, not global toggles. Two squads can advance
under different rules of engagement at the same time; the wheel's toggles only seed the next order.

### Scope, and who walks

`resolveOrderFor(book, botId, squadId)` returns the bot's own order if it has one, else its squad's.
A personal order outranks the squad's deliberately: the reconciler absorbs loose bots into squads
every 700 ms, and it must not be able to undo a player's explicit decision to send one body somewhere.
`orderMoverId` names the one bot that walks the goal — the leader for a squad order, the bot itself
for a personal one. Everyone else reaches the goal on their formation slot, exactly as before.

A leaderless squad (mid-succession-shock) has **no** mover; the order sits and the members patrol.
Picking an arbitrary walker there would have the squad advance under a bot nobody promoted.

### Lifecycle: the dead-commander bug

The old slot cleared only on arrival. A `hold` on a bot that then died stayed live forever, and
because `underCommand` matched by squad id, that dead bot's entire squad kept break-contacting for the
rest of the match. `pruneOrders` runs every tick right after `updateSquads`, with predicates rather
than sets so nothing is allocated per frame:

- a **bot-scoped** order dies with its bot;
- a **squad-scoped** order outlives its leader, because the squad is what was addressed — succession
  names a new leader and the order carries;
- a squad-scoped order dies when the squad is wiped out;
- `ttlMs` (default 0 = never) expires an order on its own, which is what stops a machine commander
  leaving stale orders on the field.

Arrival is `completeOrder`: a `move` leaves the book, a `hold` latches `arrived` and stays.

### Inheritance across the reconciler

Squads are not stable objects. Three hooks in `applySquadOp` keep an order attached to the bodies it
was given to:

- **merge** → `transferOrderOnMerge(into, from)`. The survivor's own order wins; an *unordered* squad
  that swallows an ordered one adopts the order, so absorbing a squad mid-advance does not halt it.
- **split / mergeDetachments** → `inheritOrderForNewSquad(newId, parentIds)`, parents sorted
  oldest-`seq` first, matching the existing rule that older squads keep command. The goal is copied,
  not shared, and `arrived` resets. Parents keep their own orders — a detachment leaving disarms nobody.
- **absorb** → nothing. A loose bot joining a squad simply starts resolving that squad's order; its
  own personal order, if it had one, is untouched and still outranks it.

### Compliance

`describeCompliance(order, {engaged, fleeing, pinned, pathFailed})` returns one of `no-order`,
`moving`, `holding`, `fighting`, `pinned`, `broken`, `no-path`. Precedence is `broken` → `no-path` →
`fighting` → `pinned`, because a fleeing bot is immune to orders by design and saying "pinned" about it
would be a lie.

This exists because an order being obeyed and an order never heard look identical from a distance.
The wheel's header shows it for the selected bot's order, read off the **mover** — a member sitting in
its formation slot is not the bot that failed to find a path (`orderPathFailed`, stamped in
`updateCommandMovement` when `requestPathBudgeted` refuses).

### Wheel changes

Six spokes now: *Move here*, *Double time*, *Hold here*, *Cancel order*, *Break contact*, *This bot
only*. The selected bot names the **addressee**, and if it is in a squad the order goes to the squad —
*This bot only* is how you still pull one body out of a formation, which is what ordering a non-leader
used to do by accident. The header names the squad, its live count, and the compliance of any order
already in force.

One ring per live order (`updateOrderMarkers`, pooled), because a single shared marker would show only
the newest order and every other one would be invisible — which is exactly the failure the plurality
fix is about. A held position dims its ring to 0.4 opacity once reached.

### Not yet done

- **Vocabulary is still two verbs.** `attack`, `capture` and `fall back` are what adversary mode needs
  and none of them exist yet. `attack` is meant to be a destination plus a weighting inside
  `selectBotTarget`'s existing risk product — never a target assignment — which is a change to target
  selection, not to the order book, and is deliberately not bundled here.
- **No map addressing.** The book accepts a squad id from anywhere, but the only writer is the
  first-person wheel. The fullscreen `M` map (`world-map.js`) is where squad blips and click-to-order
  belong.
- **No network path.** Orders are host-local. The intended shape is one JSON command message over the
  existing `mp:guest_input` channel, which needs no relay change.
- **Browser-verified: no.** Node tests pass (`test-bot-orders.mjs`, `test-env-command-wheel.mjs`);
  nothing here has been watched on screen.

## Shipped panel presets (2026-08-13, `bot-viewer-presets.json`)

The hosted page had no configured state: `bot-viewer-v3.html` booted to the stock arena, and the only
way to a tuned one was for the visitor to tweak the panel themselves. The save slots could not help,
because they live in `localStorage` and are therefore per-browser — nothing in them reaches anyone
else. Presets are the committed half of that system.

### The file

`bot-viewer-presets.json` at the repo root, generated from the `bot-viewer-saves/` mirrors (which stay
gitignored — one file per Save click would flood `git status`). Shape:

```json
{ "version": 1, "presets": [ { "id": "all-1", "group": "all", "name": "everything 1",
                               "savedAt": "…", "isDefault": true, "data": { maze, bots, ui } } ] }
```

`data` is exactly a `captureAllState()` payload, so `applyAllState` reads it with no translation. To
refresh a preset: click Save in the viewer while served by `serve.py`, then copy the newest
`bot-viewer-saves/bv2-all-slot<N>-*.json`'s `data` into the matching preset. `test-bot-viewer-slots.mjs`
validates the file — unique ids, exactly one `isDefault`, every `all` preset carrying maze/bots/ui.

### They coexist with local slots, they do not replace them

Presets appear in the same dropdown as the numbered slots, under their own value namespace
(`preset:<id>`, `PRESET_PREFIX`/`isPresetValue` in `bot-viewer-slots.js`), so a shipped preset can
never collide with a slot the user saved. They are read-only: Save and Delete are disabled while one
is selected, refused rather than silently redirected to another slot. Load works, and deliberately
leaves the rename field empty so the next Save names a new slot instead of reading as an edit to the
shipped one. `createSlotSection` takes them via `setPresets(list)` rather than at build time, because
they arrive from a `fetch` after the panel is already built.

### The seed, and why it is allowed to be automatic

`loadShippedPresets()` applies the `isDefault` preset on a visitor's first load. That is the thing the
autosave deliberately refuses to do — see "restoring is offered, never automatic" — so the exemption
is narrow and every clause of it is pinned in `test-bot-viewer-save-all.mjs`:

- It is skipped when `readAutosave()` returns anything, or when the `all` group has any saved slot.
  A returning user's own state always wins.
- It writes `pcw:bv2:presetSeeded`, so it runs at most once even for someone who clears their slots.
- Blocked storage (private mode, a thrown `localStorage`) is read as a *return* visit, not a fresh
  one — the failure direction that leaves the panel alone.
- `?preset=1` forces it, `?preset=0` suppresses it.
- A missing, non-OK or unparseable file returns silently: the viewer then behaves exactly as it did
  before presets existed.
- A preset that throws while applying does not mark the seed as done, so a bad file is retried rather
  than being permanently swallowed.

The seed runs after `applyLayout(buildRoomsLayout())`, so a first-time visitor's map is built twice on
that one load. That is accepted rather than fixed: sequencing the fetch ahead of the initial layout
would make the whole boot wait on the network.

**Browser-verified: no.** Node tests pass (`test-bot-viewer-slots.mjs`, `test-bot-viewer-save-all.mjs`,
`test-bot-viewer-slot-coverage.mjs`, `test-bot-viewer-panel-layout.mjs`); the dropdown and the
first-visit seed have not been watched on screen.
