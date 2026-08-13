# Adversary mode — what the code actually is today (2026-08-11)

Reconnaissance for a Halo Wars-like adversary mode: a human commands one team; the other side is run
by a script, an LLM, or a second human. Four read-only agents covered the order layer, unit lifecycle,
the network and machine-control surface, and map structure. Everything below carries a `file:line`.

**Confidence marking.** Facts are agent-reported from static reading unless marked **[verified]**,
which means I checked it myself in this session. Nothing here was observed at runtime. Line numbers
drift — grep the symbol.

---

## 1. Orders

The entire order system is three module-level globals: `commandTargetId` (a single bot id),
`commandGoal {x,z}`, `commandGoalState` (`environment-viewer-v2.html:5526-5528`).

- **Vocabulary is four items**: goals `move` and `hold`, plus persistent toggles `doubleTime` and
  `breakContact` (`COMMAND_WHEEL_SPOKES`, `:12314-12319`). Issued by a middle-mouse radial wheel in
  first person, spoke picked from accumulated `movementX/Y` because the pointer is locked (`:12357`),
  committed on release (`:13864`).
- **One bot at a time.** `updateCommandMovement` returns early unless `activeBot.id === commandTargetId`
  (`:5539`). There is no multi-select and no squad-level order entry point.
- **`underCommand(rec)`** is true for the commanded bot *and* everyone sharing its `squadId`
  (`:5532-5537`) — but it gates only the two toggles. The move/hold **goal itself never propagates to
  the squad**. Ordering a leader drags the squad along only incidentally, through formation-following.
- **`orderOverride` is read at exactly two rungs** of the FSM ladder (`bot-activity.js:101` and `:120`),
  both returning `BOT_PATROL`. It sits below heal, flee, knife, committed cover, close-self-threat and
  reload-to-cover, and above pursue, fresh cover entry, aim and fire.
- **There is no attack order.** Target selection is entirely autonomous (`selectBotTarget`). A
  commander can pull bots out of a fight and can never point them at one.
- **Guests cannot command** — `openCommandWheel` early-returns for `mpRole === 'guest'` (`:12347`).
- **[verified] Orders have no lifecycle.** `clearCommand()` has exactly one caller, arrival at a move
  goal (`:5545`). Nothing clears a command when the commanded bot dies, so a `hold` on a dead bot
  leaves its whole squad break-contacting indefinitely via `underCommand`.

## 2. Squads (`bot-squad.js`)

- `formSquad` + `electSquadLeader` (highest `leadership`, ties to lowest id, living members only,
  `:66-68`). Membership is dynamic: `reconcileSquads` runs every 700 ms over four ops in fixed order —
  `split` (detachment ≥ 4), `mergeDetachments`, `merge` (a squad ≤ 4 folds into the nearest same-team
  squad within 20 m; the older squad keeps command), `absorb` (loose bots join) (`:121-192`).
  `SQUAD_MAX_SIZE` 8, `SQUAD_MIN_SIZE` 2.
- Leader death leaves the squad leaderless for `SUCCESSION_SHOCK_MS` 1800 ms, then prefers a named
  `heirIds` line over a fresh election (`:74-85`).
- Formations `wedge | column | line | ring` (`:18`); `chooseFormationKind({manual, engaged,
  corridorClear})` — manual wins, contact forces `line`, else a corridor probe picks wedge vs column.
- **Governing rule, stated in the code**: "Squad state is a bias source, never an override"
  (`bots.md:885-888`). Formation movement runs only from the out-of-combat branch, so it redirects
  movement that was already idle and never writes FSM, cover or aim state.
- **A squad cannot be given a goal as a unit.** No function issues a move/hold to a roster.

## 3. Roles (`bot-roles.js`)

Six descriptors — rifleman, medic, squad leader, sniper, technical, drone operator (`:52-93`) —
normalised against `ROLE_DEFAULTS` so every field always exists. Fields: `maxPacks`, `startingPacks`,
`weapon`, `sidearm`, `insignia`, `canRevive`, `leadership`, `support`, `sightScale`, `bonusGrenades`,
`swapOnDryMag`, `closeRange`, `standoffScale`. Consumed generically — the docs state explicitly that
sniper and technical added "no new behaviour module, no FSM rung, no `if (role === …)`".

`assignRolesToBatch(count, {medicPercent, mix})` (`:107-125`) spaces role percentages through a spawn
batch deterministically, with no RNG. **[verified]** role is stamped once in `spawnBotAt`
(`environment-viewer-v2.html:2823`) and never reassigned; promotion sets a separate `isLeader` flag.

**No role has a cost, tier or rarity.** The shape is right for purchasable unit types; the numbers do
not exist.

## 4. Teams

Exactly two, hardcoded: `BOT_TEAM_DEFS = { alpha, bravo }` (`environment-viewer-v2.html:3765`).
Nothing generalises past the two literal keys. A third identity, `HUMAN_TEAM = 'humans'`, exists only
in the game: the player is hostile to every bot team and is "never a squad member, never an
ally-report audience, never a medic patient". **There is no notion of a human commanding a bot team.**

Team-scoped: ally reports, alert sharing, enemy candidate lists, cover groups, medic scans, flee
centroids. Global and shared by both sides: health packs, the nav grid, the FSM itself, and **every
tuning setting** — one `botAimSettings` and one `botBehaviorSettings` serve both teams, so there is no
per-side configuration to make two commanders asymmetric.

## 5. The FSM

Thirteen encodable states: `patrol, seek, pursue, flee, heal, knife, aim, fire, cover-move,
cover-hold, medic-move, medic-tend, dead`.

- **Suppressible by `breakContact`**: patrol, seek, pursue, and fresh entry into cover-move / aim / fire.
- **Immune by design** (self-preservation outranks a manual order): flee, heal, knife, cover once
  `coverCommitted`, the close-self-threat aim spin, and medic duty (layered after the ladder).

## 6. Unit lifecycle

- `spawnBotAt(pos, roleId, teamId)` (`:2805`). It calls `recordSpawn` first, which **reopens a closed
  round** (`bot-score.js:58`).
- `botSpawnPoints` / `botPatrolRing` are shoot-house or authored-map only. Open terrain samples
  placement live via `findBotSpawnPoint`, splitting the map by long axis into team halves.
- **Bot count is uncapped in the game.** Only the `round` auto-fill mode is bounded, by a 1–10 slider
  defaulting to 3. The harness has real caps: 30 living per team, 50 total.
- **Death never removes the roster entry.** The corpse stays in `botPlayers`, drops its health packs,
  and ragdolls. Only manual despawn deletes it. The game has no corpse budget; the harness culls at
  `botCorpseCap` 24, oldest first, sparing corpses inside the revive window.
- `botRespawnEnabled` (default true) respawns the **same record** after 4000 ms at its **original
  `spawnPos`**, not where it died. `resetBotBrainState` wipes perception and target memory; lifetime
  stats persist.
- **Identity survives death**: id, squad membership and stats all persist, because only despawn prunes.
- **Ammo survives death.** `playerAmmo` is keyed `` `${id}:${weaponId}` `` and `ensureAmmo` only
  initialises when the key is absent, so a bot that dies dry respawns dry.
- Medic revive is separate: 3 health packs fuse into one revive kit (`REVIVE_KIT_PACK_COST`), which
  stands a bot up where it fell.
- **No grudge system exists anywhere** — searched, no matches.
- **The harness has no respawn at all.** Dead is dead there, aside from medic revive, then culled.

## 7. Score and match (`bot-score.js`)

Per team: `spawned, deaths, revives, kills, teamkills, selfKills`, plus breakdown maps `byWeapon`,
`byCause`, `byRole`, `lossesByRole`. Deliberately keeps no alive count — callers pass one in.

`decideRoundOutcome(board, aliveByTeam)` (`:134-142`) is **the only win logic in the repo**: it needs
at least two teams that spawned this round; if exactly one still has living bots that team wins by
`wipe`, if none do it is `mutual`, otherwise the round stays open. It is gated behind
`!botRespawnEnabled` in the game and `!botAutoAddEnabled` in the harness — both normally on, so in
practice **nothing ever ends**. There is no match concept above a round.

Per-bot counters exist separately on each roster record and are never rolled into the scoreboard.

## 8. Economy

**None exists.** No points, credits, supply, cost, tier or spendable pool anywhere in either viewer or
their modules. Every `budget` identifier in the codebase is a frame-time, audio or replan budget. The
only gameplay number resembling a price is the 3-pack revive-kit cost.

Health packs are **drop-on-death only** (`worldSpawnCount: 0`), capped at 64, despawning after 60 s.
There are **no ammo pickups** anywhere.

## 9. Map structure

- **Shoot house**: procedural, finite, bounded. Strips get a `type` (`open|cover|pillars|shelving|
  crates|tables`) and gallery rooms get an `archetype.id` — but these are **generation-time labels
  only**. Nothing downstream reads `meta`; consumers see anonymous `{kind,cx,cy,cz,sx,sy,sz}` boxes.
  Room identity does not survive into the geometry, the nav bake, or the interchange format.
- **Open terrain**: chunk-streamed and effectively infinite (`terrain-system.js`).
- **`pcw-layout` v1** (`layout-interchange.js`) is a real authored map format:
  `{format, version, name?, bounds, walls[], covers[], spawns[], terrain}`, with converters both ways
  to the shoot-house shape. Geometry and spawns only — no semantic regions.
- **`bot-terrain.js`** (harness) generates deliberate landmarks — `plateau`, `ravine`, `escarpment`
  (`FEATURE_KINDS`) — with a stated rationale that "noise gives you ground; it does not give you a
  landmark". They carry no ids.
- **`bot-structures.js`** is fully seeded (mulberry32 + per-structure `streamSeed` so structure *i*'s
  rolls don't depend on earlier draws). Returns `{kind, x, z, radius}` — no ids. `teamSideRegions` is a
  computed half-map split, not authored places.
- **`bot-spawn-markers.js` — harness only, and the closest thing to a base that exists.**
  `addSpawnMarker(store, {team, x, z, radius, base, origin})` produces a **stable id** (`spawn-N`),
  team ownership, a garrison radius, and a `base` flag when a compound was generated around it. It
  offers `spawnMarkerById`, `spawnMarkersForTeam`, `garrisonSlot`/`garrisonSlots`, `withinGarrison`,
  `clampToGarrison`. Squads spawned at a marker garrison it and fight intruders. **It has no capture,
  contest or ownership-transfer semantics, and it is not wired into the game at all.**

### The nav constraint — the central technical problem

`nav-grid.js` labels connected regions with numeric ids that are **reassigned from scratch on every
`labelRegions()` call**, so region ids are not stable identifiers. `reachable(grid, a, b)` is the O(1)
"could a path exist" check.

The game cannot bake the whole map. Its own comments cite 1200–4000 m maps, 640k+ cells, and a
pairwise visibility field that is O(walkable²) — **140 MB at 384 m, 13 GB at 1200 m**. So there is one
persistent grid: `BOT_ZONE_SPAN` 384 m at 1.5 m pitch, **anchored on the local player**, baked
incrementally at 3 ms/frame, rebaked when the anchor drifts 96 m, throttled to once per 4 s. Outside
that bubble bots get throwaway local windows with no region labels. On every rebake, live cover
corners and in-flight paths must be remapped by world position because cell indices mean nothing
across bakes.

**Any design with bases spread across a map has fights happening where the player is not, which is
precisely what this architecture is built to avoid.** Treat this as the hard problem, not a detail.

### Overhead view

There is **no top-down 3D camera anywhere in the repo** (the only `OrthographicCamera` bakes icon
thumbnails). But `world-map.js` already provides a 2D canvas map with a heading-up minimap and a
north-up fullscreen map on `M`, with `worldToBigMap` and inverse affines, biome/elevation/slope
overlays, and a live mouse-to-world-coordinate readout. It currently draws **only** the local player
and remote-player arrows — no structures, bases or markers, and it reads nothing from
`bot-structures.js` or `bot-spawn-markers.js`.

## 10. Network and the machine-control surface

Host-authoritative. The relay is a dumb JSON forwarder that never parses `sim_state`.

- **Host → guests**: `sim_state {seq, creatures, players, entities, worldMode}` every 50 ms, dropped
  rather than queued when `bufferedAmount` exceeds 128 KiB; plus `creature_config` and
  `world_settings` on change.
- **Guest → host**: `join`, `query`, `player_state` (50 ms), `combat_intent`
  (`gun.fire` / `gun.reload`), `entity_intent` (`light.place` / `light.fire`).
- `set_target` / `set_behavior` have **host handlers but no senders anywhere**, and they route to the
  ambient wildlife system, not to combat bots.
- A guest can mutate host simulation **only for its own player** (`combat_intent` → `validateShot` →
  real HP/ammo mutation) and for light entities. **Bots never run on a guest.**
- **Bot wire pose** (`toWirePose`, `bot-entity.js:150-177`): `id, p, q, h, r, isBot, fullHeight,
  onFloor, velocity, weapon, tool, aimPitch`, optionally `crouch, prone, standFullHeight, team, role,
  alertTier, deathImpulse`; `hp/maxHp/alive` merged in from `playerCombat`.
- **Not on the wire**: target identity, path, squad id / rank / leader, the numeric alert score, FSM
  latch and commit state, cover and formation state. A remote commander seeing only `sim_state` would
  not know what any bot is shooting at or who leads it.
- **Narrowest attach point** for a commander channel: the existing `mp:guest_input` dispatch plus
  `mpSession.sendInput`. The relay forwards arbitrary JSON tagged with `clientId`, so it needs no
  change at all.

### Structured state that already exists

`bot-state-code.js` is a pure, Node-tested 9-character encoder of a bot's FSM, alert tier, role,
resources and latches, with `encodeBotState` / `decodeBotState` / `diffCodes` / `describeBotState` and
18 legality rules. Trace capture writes 19-column TSV takes (`t_ms, bot_id, team, code, changed_slots,
x, z, yaw_deg, speed, moved, goal_dist, path_len, path_mode, squad_id, squad_rank, leader_id,
target_id, target_dist, vis_gate`) and streams live combat events over a WebSocket to
`bot-trace-viewer.html`.

**All of it is wired only into `bot-viewer-v2.html`, not into the game, and none of it is networked.**
There is no JSON command intake for bots or teams anywhere in the repo.

## 11. Determinism

Not fixed-timestep: `clock.getDelta()` clamped to 0.1 s, driven by `requestAnimationFrame`. Terrain and
structure generation is seeded, but gameplay randomness calls bare `Math.random()` — explore heading,
weapon spread, recoil jitter, sky seed. **There is no global seed and no replay.** The multiplayer doc
already flags divergence as a known limitation.
