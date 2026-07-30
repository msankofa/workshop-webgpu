# Combat bots

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
  exercised that path. Browser/THREE only, not Node-tested.
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
    (`MEDIC_TEND` gates on path cost too). Without a nav grid it falls back to straight-line. This **layers on top of the combat FSM** in
    `updateBotSentry`: after `chooseBotState`, a medic that isn't self-preserving (`!botHealRequested`)
    and isn't in a committed `BOT_FLEE`/`BOT_KNIFE` may override its state to `MEDIC_MOVE` (approach a
    wounded/fallen ally) or `MEDIC_TEND` (channel in place). It still aims and **fires while
    moving/tending** (the fire-if-aimed clause mirrors `BOT_FLEE`).
  - **Heal-ally pose** — `medicHold`: unlike the rifleman heal, the sidearm stays in the **right hand**
    (weapon visible, aim/fire intact) and `updateMedicHoldOverlay` overrides only the **left-arm**
    target to cradle the pack (run *after* `updateBotWeaponMount` so it wins the frame). `updateMedicTend`
    transfers `healAllyPerSecond` HP from the medic's packs into the ally; `stickyHealTend` keeps
    topping an ally past the (lower) select threshold up to `allyResumeHp01`.
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
- **Chevron**: gold, built by `buildRoleInsignia('chevron')`. `ROLE_SQUAD_LEADER` carries it as its
  spawn insignia; `setSquadLeaderMark` grows one on a promoted rifleman and removes it on demotion,
  skipping any role that already has its own insignia (the medic keeps its cross).
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
  `ROLE_SQUAD_LEADER`, so its leader would otherwise wear no chevron until it died.

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
there beyond the ground plane. The result is cached forever (the collision mesh never changes at
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
| `bot-roles.js` | Role registry (`rifleman`/`medic`/`squadleader`/`sniper`/`technical`) + batch assignment + `leadership`-ordered leader pick and the bounding-overwatch split — Node-tested (`test-bot-roles.mjs`), THREE-free. |
| `nav-grid.js` | Pure walkable-grid + A* pathfinding, used both for shoot-house's static bake and the terrain local-window — Node-tested, THREE-free. |
| `bot-state-code.js` | Pure 9-slot discrete state code for FSM trace logging/diffing/mining (encode/decode/legality/core projection/`diffCodes`) — Node-tested (`test-bot-state-code.mjs`), THREE-free. Wired into `bot-viewer-v2.html`; browser QA pending. See [`bot-state-codes.md`](bot-state-codes.md). |
| `gen-bot-state-table.mjs` | Regenerates `bot-state-table.md`/`.csv` (434 core states) from `bot-state-code.js`. The table is a printout, never hand-edited. |
| `bot-viewer.html` | Dev harness; not part of the game's module graph, still useful for FSM/nav iteration. |
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
| `bot-grenade.js` | Pure grenade-secondary decision math (throw gates/scoring, live-grenade evade urgency) — Node-tested (`test-bot-grenade.mjs`), THREE-free. |
| `bot-stance.js` | Pure per-bot stance channel: the stand/crouch/prone/run/dash decision table over the resolved FSM state, the stand-up hysteresis latch, and the speed/spread/height/turn-rate multipliers — Node-tested (`test-bot-stance.mjs`), THREE-free and zero-dependency. |
| `weapon-hold-resolver.js` | Pure resolution of the third-person weapon hold from (stance × locomotion) — continuous stance lerp plus an additive per-class carry delta. Shared by `bot-viewer-v2.html` and `weapon-animation-viewer.html` so the authoring tool cannot drift from the game. Node-tested (`test-weapon-hold-resolver.mjs`). See Contract 6 in `procedural-body-weapon-contracts.md`. |
| `effect-renderer.js` | Shared layered-explosion / tracer / spark / smoke renderer, also used by `environment-viewer.html`. Stateless: sub-particles regenerate each frame from the wire object + id hash + age. See `docs/subsystems/fx.md`. |
| `weapon-sfx-synth.js` | Procedural WebAudio voices for weapon events with no loaded sample (`rocket_launch`, `explosion`, `grenade_throw`, `grenade_bounce`) — Node-tested (`test-weapon-sfx-synth.mjs`). See `docs/subsystems/audio.md`. |

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

**Status.** Node-tested (`test-weapon-hold-resolver.mjs` 57 checks, `test-bot-stance.mjs` 186). The
carry delta values are first-pass starting points authored to be tuned in the viewer, not final.
`bot-viewer-v2-camera.html` (the forked camera rewrite, pending merge) still carries the old
hardcoded `thirdPersonHold` mount and the pre-dash stance list.

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
  frame (radius 150 < `camera.far` 200). Vertical gradient, a banded nebula (2-octave fbm — each
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
| `reactionDelayMs(distance, {alerted, jitter01}, s)` | recognition delay for a fresh contact, in ms |
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
  one opponent.

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
| `botGrenadeSettings` (all `GRENADE_DEFAULTS` keys) | bots | saved as `grenade`; 10 of the 12 keys have sliders |
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
  walkables) ≈ 0.5 s, logged once per bake (`[cover bake]`).
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

`buildNavGrid(walkableTest, bounds, cellSize, { heightAt, slopeCost })` stores a per-cell height
array and a `slope` config (`SLOPE_COST_DEFAULTS`: `up: 1.8`, `down: 0.6`, `maxFactor: 6`,
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

`createTerrainField(params, flatten)` takes a list of `{x, z, radius, y?}` pads. Inside the radius
the ground is level at the pad center's **raw** height (resolved once at build time — sampling
`heightAt` there would recurse, and order-dependent pads would drift); outside it smoothsteps back
over `flattenFalloff` metres. Overlapping pads pick the strongest weight outright rather than
averaging, because a blend between two levels is exactly the tilted ground pads exist to remove.
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

### `bot-structures.js` (pure, Node-tested via `test-bot-structures.mjs`)

The maze carve moved here out of `bot-viewer-v2.html` — `generateMazeCells` (unchanged, now
Node-tested) plus `mazeCellWalls(cells, cols, rows, { cell, originX, originZ, wallT, ringOnly })`,
the wall emission the layout used to do inline. `ringOnly` is the perimeter wall mode.

`generateStructures(bounds, params, avoid)` scatters islands of content over open ground and returns
viewer-shaped `{ walls, covers, pads, placed }`:

| Kind | What it is |
|---|---|
| `building` | Rect shell: four wall runs, one or two doorways (kept off the corners), a 50% internal divider with its own gap, and 0–2 interior cover boxes. Asks for a level `pad`. |
| `pocket` | A small braided maze block (`pocketCells²` at `pocketCell` m) with 2–4 entrances — a hazard to cross, not a trap to die in. |
| `obstacles` | A field of boxes at mixed heights: `tallShare` of them at `tallHeight` (≥ `SIGHT_BLOCK_HEIGHT`, so they yield cover corners), the rest shoot-over cover. |

Placement is rejection sampling with `minSeparation` between footprints and an `avoid` list (the
two spawns) — **the gaps between structures are the firing lanes**, so spacing is the main tuning
knob. A structure that can't find room after `attempts` tries is silently dropped rather than
overlapped, so a crowded map degrades to fewer structures. `mix` picks `mixed`/`buildings`/
`pockets`/`obstacles`.

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
  anything inside a live grenade's own `blastRadius` gets a `grenadeEvadeGoal`, replanned every
  `GRENADE_EVADE_REPLAN_MS` (400 ms) or when the path empties, and always at run speed. Urgency (0–1)
  is `0.6 ×` fuse pressure + `0.4 ×` proximity, normalised against a 2.0 s nominal fuse.
- **`grenadeEvadeGoal(fromP)`** is a **straight-sprint** search, not a path solve: it scans the
  `GRENADE_EVADE_CELLS` (8) ring for the walkable cell maximising distance-from-blast minus `0.35 ×`
  straight-line travel, and traces `lineWalkable` **only for a candidate that would actually win**,
  so the result is a single waypoint on a proven-clear line. It deliberately does **not** call
  `floodFill` — a Dijkstra per bot per replan while a grenade is airborne is real work even now that
  the `dist`/`parent` pair is pooled rather than a fresh 469 KB allocation. Measured 19× faster
  (296 µs → 15 µs per call) for the same chosen cell, at zero allocation. The own cell is skipped so
  "evade" can never resolve to standing still.

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

### `bot-stance.js` (new) — pure, THREE-free, zero-dependency, tested in `test-bot-stance.mjs` (130 checks)

| Export | Purpose |
|---|---|
| `STANCE_STAND` / `STANCE_CROUCH` / `STANCE_PRONE` / `STANCE_RUN` | the four postures, plain strings |
| `STANCE_DEFAULTS` | all 17 tunables below, and the source of `botStanceSettings` |
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
| 10 | `aim` / `fire` | CROUCH when the target is visible and **beyond** `aimCrouchDistance`, else STAND |
| 11 | `seek` | CROUCH within `seekCrouchRadius` of the last-known point, else STAND |
| — | `patrol` / anything unrecognised | STAND |

Two details that are easy to get backwards. A **missing** last-known point reads as `Infinity`, not 0
— `Number(null)` is a finite zero, which would land inside `seekCrouchRadius` and crouch every
searching bot that has no memory to search toward. And the aim rung crouches at **long** range (the
gate is `targetDistance >= aimCrouchDistance`): a bot steadies the shot for the far target and stays
mobile in a close-quarters fight. (The panel tooltip on that slider currently phrases it the other way
round; the code is the `>=` above.)

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
| ~~unused~~ | | | A commanded hold must have at least this long left to justify going prone. |
| `seekCrouchRadius` | `4` | m from the last-known point inside which a searching bot crouches. |
| `aimCrouchDistance` | `8` | m: **beyond** this a stationary aiming bot crouches to steady the shot. |

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
there is" — the viewer's `[cover bake]` line prints `[CREST CAP HIT -- terrain cover truncated]`.

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
  the radius **including the shooter**, and the RPG's blast is 8.2 m while weapon-linked standoff
  would walk it to 13.5 m. Inside 10 m it fights with the rifle.
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
