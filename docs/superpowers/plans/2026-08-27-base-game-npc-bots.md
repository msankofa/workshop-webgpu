# Base Game NPC bots: the v3 bots as friendly and enemy NPCs

**STATUS 2026-08-27: slices 1–3 shipped, Node-tested, unseen in a browser.** `bot-brain.js`
(generated from v3 by `tools/bot-brain-gen/`), `server/base-game-npcs.js`, protocol 14, the panel,
team tints, faces and the key-9 spawner are in. N1 measured: 16 bots 2.4 ms per tick on v5 (bench-base-game-npcs.mjs). Not done: the Solo
loopback room (bots need a room), `npcAccuracy` on the server, slice 4 cover seen in a browser, slice 5
roles/squads/orders beyond the role loadouts. Deviations from the plan below: the spawner is a tool
mode over the sidearm rather than a seventh slot; spawn placement is a small server-side rejection
sampler rather than v3's `findBotSpawnPoint`; the zone grid shipped in slice 2 because
`updatePatrolMovement` needs a grid and a patrol ring to move at all.

Written from a read of `docs/subsystems/bots.md` (the port narrative at lines 6289–7220 and
8736–8955), `docs/superpowers/plans/2026-07-26-bot-v2-env-viewer-port-plan.md`, the two
bot-port review folders, `docs/bot-bugs-log.md`, `docs/subsystems/base-game.md`,
`docs/base-game-flight-integration.md`, the drones plan, `server/base-game-rooms.js`,
`base-game-protocol.mjs` and the v3 harness. No earlier plan for NPCs in Base Game exists; the
closest are the env-viewer port (bots into a browser-host game) and the drones (the first
non-player thing the room replicates). Both are used below, and both left lessons this plan is
built around.

## What ships

Bots from `bot-viewer-v3.html` live in Base Game rooms as NPCs on two sides. The room owner adds
them from the panel: how many friendlies, how many enemies, respawn on or off, and the notice-time
and accuracy sliders from the harness. Friendlies fight beside the players and do not shoot at
them; enemies hunt players and friendlies. They walk the real terrain, see and shoot with the
same ray a player's bullet uses, take damage on the same 18-capsule hurt rig, die, and respawn at
their side's spawn. Every client, including guests, sees the same NPCs because they arrive in the
snapshot like any other body. Solo gets the same NPCs through a loopback room (below).

## The two decisions everything else follows from

### 1. An NPC is a roster entry with a synthetic input source, not a second entity type

The room server already has everything a body needs once it has a tick input: the 120 Hz
controller (`consumeTick`, `server/base-game-rooms.js`), the hurt-rig pose and rewind ring, the
trigger/ammo/reload state, `fireShot` with lag compensation and the world occluder, `applyDamage`,
respawn, the `players[]` snapshot, and on the client the instanced remote body with weapon mount,
stance and actions (`base-game-player-bodies.js` `updateRemote`, keyed by any string id).

So an NPC is a `client` record made by `makeClient` with `ws: null`, `npc: true`, `team`, and a
`source` that pushes one sanitized tick into `client.queue` per sim step. `consumeTick` then runs
unchanged. The brain's whole job is to produce `{ moveX, moveZ, yaw, pitch, sprint, stance, jump,
slot, aim, reload, fire, throw }` — the player's input vocabulary.

Why this and not the harness's own `stepBotPhysics` + `rayCapsuleHit` path: read the earlier
port's trap list. The flat-floor bug class (G1, BB-004), the below-terrain floor rescue, the
terrain-tunnelling forensics, the `!grounded` walkability inversion, the ammo-authority split, and
the projectile hit-test fork "traced by nobody" all came from bots owning their own physics and
hit path beside the player's. The flight doc's rule "build the generic table, do not special-case"
is about vehicles; a humanoid NPC is player-shaped, and the players table *is* the generic table.
The `stepClient` branches for dead, disconnected and stalled already exist; NPCs need one more.

The concern with this choice, stated so it gets measured rather than argued: a 120 Hz controller
step plus a hurt-rig pose per NPC on Node. Players cap at 16. Gate N1 measures it before any
client work. The brain itself thinks at the harness's sentry cadence with the harness's stride
(2 past 40 bots, 3 past 80); the controller consumes a held input between thinks.

Differences from v3 this creates, to decide on rather than discover: NPCs move at the player
controller's speeds (per-client `config`, so a slower NPC profile is one object); a stray NPC
bullet hits whatever is in the way including an ally (v3 shots only test the target); NPCs
swim, jump and take fall damage like players.

### 2. The brain moves into `bot-brain.js`, a server-safe module

The brain is about 45 inline functions and ~3,300 lines of `bot-viewer-v3.html`:
`updateBotSentry` (one ~690-line function), `selectBotTarget` and the FOV/field helpers,
`fireBotShot` and its aim gates, about thirty `update*Movement` handlers with their goal pickers,
`followPath`/`requestPath*`, `createBotActor`, and the `bindBotActor`/`commitBotActor` register
that loads ~35 module globals per actor. The env-viewer port copied all of it inline as a second
copy; `bot-brain.js` was planned in 2026-07-19 and 2026-07-26 and never built. A third inline
copy in a Node server is not possible anyway (no `window`, no THREE, no `mapCollider`).

The move is mechanical, not a rewrite: the functions and the register go into the module as they
are. Only two things change inside them. Every `mapCollider.raycast(...)` becomes
`world.raycast(...)` and every `groundHeight(...)` becomes `world.heightAt(...)`, and the physics
calls (`stepBotPhysics`, `placeBotXZ`, writes to `bot.velocity`) become fields on the returned
input. `bot-brain.js` exposes `stepBrain(actor, world, dt, now)` returning the input object.
`world` is injected:

```js
{
  heightAt(x, z),                 // the source, unbounded (roomGroundY); never resident chunks
  raycast(origin, dir, range),    // worldOccluder(room): the same ray fireShot resolves with
  candidates(team),               // living clients of other teams: { id, team, pos, eye, head, torso, vel, alive }
  allies(team),
  nav,                            // null in slice 1; the zone grid + vis field + corners later
  reports,                        // the shared ally-hit ring (bot-alert.js)
  claims,                         // goal claims
  seed,                           // botSeedFromId, for deterministic rolls
}
```

The pure modules it calls are the same files v3 imports (`bot-activity`, `bot-alert`, `bot-aim`, `bot-cover`,
`bot-danger`, `bot-pursuit`, `bot-stance`, `bot-contacts`, `bot-roles`, `nav-*`), so decision
math is not forked. v3 keeps its inline copy for now; parity is measured with the existing
instrument, `bot-state-code.js` traces diffed slot by slot on the same scenario, the way Phase A
was checked. Switching v3 to the module is a separate later step, as `weapon-mount.js` was.

Eye and target points come from the hurt rig (`playerPoseAnchor(pose, 'eye')` and the head and
torso joints), not from a capsule fraction. That closes the eye-height disagreement the audit
found (harness 1.32 m, port 1.50 m and 0.8 h in two functions) and the head-exposed LOS family
(BB-008/009/010): the LOS test samples head and torso, the way `blastExposure` already samples
three heights, and a head showing over a crest is a target.

## Protocol 14

- `players[]` entries gain `team` (integer, players default 1), `npc` (boolean) and `appearance`. Guests read
  both; nothing else on the wire changes for a player.
- `base:npc` — owner-only admin request, validated like `base:set_world`:
  `{ friendly, enemy, respawn, noticeMs, accuracy, speedProfile }`. Counts clamp to a room cap.
  These are shared world keys (`BASE_GAME_SHARED_KEYS`), in `DEFAULT_SETTINGS`, in state files and
  in performance captures, as `base-game.md` requires of every component.
- Friendly fire is unchanged (bullets and blasts hit anyone, as today). NPC *targeting* is
  partitioned by team like v3's `rebuildFrameEnemyLists`, so an NPC never aims at an ally.
  Turning friendly fire off is a rule change for players too; that is a separate decision.

## The spawner (slot 9)

A held tool the player spawns NPCs with, aimed like a gun. It rides the drones' pattern: `spawner`
joins `BASE_GAME_WEAPON_IDS` as a tool id (`isBaseGameTool`), a seventh slot `spawner` on key 9
(7 and 8 stay free), handed to the bodies as a held model and to `getWeapon()` as nothing. The
held model is the sidearm pistol with a distinct tint until something is authored, so the mount
and the laser's muzzle both exist; the laser (double-tap `L`, the existing setting) then puts its
dot where the bot will stand, with no spawner-specific laser code.

- **Click** spawns. The server, not the client, finds the point: `playerPoseAnchor(pose, 'eye')`
  and `lookDirection(yaw, pitch)` → `worldQuery.raycast`, then the `droneSendPoint` fallback
  (a 10 m march along `heightAt` out to 1.5 km, so a bot can be placed on a far hill). The point
  goes through `findBotSpawnPoint`'s rejection test (water, slope, bodies) with a small search
  radius, so a click on a lake edge puts the bot on the shore rather than refusing.
- **`R` (reload) cycles the side and role** shown on the combat HUD line: enemy rifleman, enemy
  medic, … friendly rifleman, … The panel's NPC section sets the default the spawner opens on.
- **Right mouse (aim)** with the spawner held is free; it does nothing until there is a use.
- Spawned bots are ordinary NPCs from then on: they carry the panel's respawn setting, and their
  respawn marker is the point they were placed at.
- Owner-only online (it is `base:npc` with a point, validated like the rest); in Solo the
  loopback room makes it the same code.

## Server

`server/base-game-npcs.js` (new, imported by `base-game-rooms.js`):

- `spawnNpc(room, team, role, at)` → `makeClient`-shaped record without a socket, `bodyModel` from
  the role design, loadout from the harness role, placed by v3's `findBotSpawnPoint` rejection
  sampler around `at`, with `heightAt` and sea level as the ground test. `at` is the spawner's
  aimed point, or a side marker from `bot-spawn-markers.js` for panel-count spawns (default one
  marker per side around the first player).
- `stepNpc(client)` — a fourth branch in `stepClient`: run `bot-brain` at its cadence, hold the
  last input, push one tick numbered `client.lastConsumedTick + 1`, then the existing
  `consumeTick`. Dead NPCs take the existing dead branch and `respawnClient` with the respawn
  key honoured.
- `rebuildFrameLists(room)` once per sim step before the NPC loop: living clients by team, the
  spatial hash (`bot-spatial-hash.js`), the ally-report ring aggregation. Same order the env port
  settled on: reports and squads settle before any member reads them.
- Snapshot: NPCs appear in `players[]` through `playerEntry` with `team` and `npc`. No new array.
- `worldOccluder(room)` is the only ray the brain gets. On heightfield terrain that is terrain
  only, because the server has no trees or rocks (nothing registers them); NPCs will see through
  trees a player cannot until F6/F8 of the plants plan puts deterministic tree placement on the
  server. That hook is named here so the occluder is extended, not replaced, when it lands.

## Client

- `base-game-player-bodies.js`: remote colour from `team` when the entry carries one, else the
  identity hue. Friendlies and enemies read at a glance; nothing else in the render path changes.
- Panel: an NPCs section under the room controls (owner-enabled, guests disabled like other
  shared keys), with the counts, respawn, notice time, accuracy and speed profile.
- HUD: kill feed already reports names; NPC ids read as `npc-<side>-<n>`.
- Solo: a **loopback room**. Instantiate `createBaseGameRooms` in the page with an in-memory
  socket pair, so Solo is a room with zero latency and one sim. The server module's only Node
  import is `randomUUID` from `node:crypto` (`globalThis.crypto.randomUUID` works in both). This
  replaces the pattern where Solo re-implements the server (`stepSoloDrones` is already a copy of
  `launchGadget`/`applyDroneInput`/`stepDrones`), and it is what makes NPCs testable in Solo
  without a third copy of the brain. If the loopback proves awkward, the fallback is NPCs online
  only, with the local relay started from `server-tool.html`.

## Navigation and cover, in two steps

**Slice 1: local windows.** The env port's off-grid path: `buildLocalNavWindow` (24×24 cells at
1.5 m around the bot, `nav-grid.js` in Node, `heightAt` for slope cost, sea level as water) with
the goal clamped into the window, `advancePath`, and the game-side stuck handling (`trackStuck`
on *displacement*, R4: commanded velocity lied about bot-vs-bot stalls; the harness has none).
Patrol, seek, pursue, flee, aim and fire all work at this level on open terrain. This is where
the first browser look happens.

**Slice 3: the zone grid.** Node builds a 384 m / 1.5 m grid in ~19 ms (`bench-bot-nav.mjs`),
with no BVH probe to pay because walkability on a heightfield is slope, water and bounds only.
Anchor on the **centroid of connected living players**, never the first bot (the verified
`botZoneAnchor` bug), rebake at 96 m of drift, keep the old grid live while baking. Sight blockers
are terrain only, so cover means crests: use the env constants (`CREST_SPAN_M 4.5`,
`CREST_FAR_M 24`), not the harness's 2 and 12, which found zero crests on real terrain. Off-grid
NPCs fall back to slice 1 windows rather than stopping (`findFleeGoal` returning null froze bots
in the env port). Base Game's `residencyRevision` is not the trigger: the server samples the
source, so residency does not apply.

## Slices and gates

1. **`bot-brain.js` slice 1** — patrol/seek/pursue/aim/fire/flee/heal-retreat, target selection
   with risk and stickiness, reaction delay and spread through the same `shotDirectionFor` seed
   path the player uses, stance from `bot-stance.js`. Tests: a Node scenario harness with two
   teams on the analytic terrain; state-code trace against a v3 take of the same scenario.
   Gate: NPCs close, shoot, retreat when hurt and never fire at an ally over 5,000 ticks.
2. **Server + protocol 14** — `base-game-npcs.js`, the `stepClient` branch, `base:npc`, team on
   the wire, spawn placement, respawn. Tests in `server/test-base-game-npcs-room.mjs`; two clients
   in the relay test see the same NPC list. **Gate N1 (measure before slice 4):**
   `bench-base-game-npcs.mjs` prints ms per 120 Hz step for 0/8/16/32/64 NPCs with 4 players on
   v5 terrain. The numbers go in this file's STATUS line. If 32 NPCs do not fit in the tick, the
   first lever is the brain stride, the second is a controller profile that skips the hurt-rig
   pose on ticks nobody can shoot.
3. **Client** — team colour, panel section, shared keys, state file, perf capture, loopback room
   for Solo, and the spawner on key 9 with its HUD line. Gate: your look at it.
4. **Zone grid and cover** — slice 3 nav above, `bot-cover.js` with crest corners, the danger
   field. Gate: bots go to ground behind crests when shot at; a Node tally of the bake per cause
   (walkable / water / slope) is printed, since the `!grounded` bug was found by that tally and
   not by reasoning.
5. **Roles, squads, orders** — the env port's C/C½ ladder: roles and medic, then squads and
   formations, then `bot-orders.js` on the squad record (the adversary synthesis: orders on the
   squad, zero new FSM rungs, `attack` as a bias not a target). Grenades and sidearms ride the
   player's existing throw and swap paths for free.
6. **Docs** — `base-game.md` roadmap entry, `bots.md` cross-link, `agent_log.csv` per slice.

Slices 1–2 are Node only. Slice 3 is the first browser look. Nothing in 4–5 is needed for the
first look.

## Pains from the earlier port, and where each lands here

| Pain (source) | Then | Here |
|---|---|---|
| Flat-floor offsets, weapon rig at absolute y=1.5 (G1, BB-004) | every harness offset re-derived | no bot physics or mount code is ported; the player's controller and mount already run on terrain |
| Bots saw and fired through hills; forest transparent to LOS | `heightAt` march added late; trunk occluders bolted on | `worldOccluder` is the only ray, shared with `fireShot` from day one; trees are a named future hook |
| Stale 120 ms LOS cache | deleted, cost accepted | never added; confirm-ray stride from the 08-17 perf pass is the lever if rays cost |
| `!grounded` condemned 92 % of cells | per-cause tally found it | heightfield walkability has no probe; tally printed anyway |
| Explore goals in another region, bots exiled 1 km out | region-scoped nearest cell, 140 m leash | slice 1 has no grid; slice 3 spawns bind NPCs to a side anchor with a leash |
| Pursue-freeze, converging bots stall | fixed in game and harness | port the fixed version; `pathFailCount` counted in pursue |
| Pooled `floodFill` results held across frames (G5) | per-record `out` buffers | same contract; medic flood passes its own buffer |
| Shared scratch stored by reference (`setArmTarget`) | per-record targets | brain returns plain input; no scratch reaches the renderer |
| Zone rebake wiped cover mid-hold; anchor on an arbitrary bot | remap + player anchor | centroid anchor, remap kept |
| Eye height disagreed with itself; head exposed not targeted (BB-008–010) | open | rig anchors for eye, head and torso |
| Third-person player invisible to bots | gate loosened | no gate: the server has no camera mode |
| Arena-scaled SFX and cell-denominated radii | patched | radii in metres; audio is Base Game's |
| Think stride missing in the port | open | stride in from slice 1 |
| Two copies of the brain | still two | one module (moved, not rewritten), v3 switch later |
| Solo re-implements the server (drones) | shipped that way | loopback room |
| Special-cased replicated table (drones) | shipped that way | NPCs ride `players[]` |
| Locate by symbol, never by line (G3) | rule | every v3 reference above is a symbol; the line numbers are 2026-08-27 and will drift |

## The entity registry, later

`entity-registry.js` (Milestone A, 2026-07-03) has never reached Base Game; the room hand-rolls
`players[]`, `projectiles[]` and `drones[]`. Moving the room onto it is another job. This plan
keeps that merge cheap by making an NPC "a body plus a brain" and nothing else: it has no
socket, no queue and no prediction state of its own, so moving it from a roster entry to a
registry entry changes where it is stored, not what it is. The one seam that job will want is
already implied here: the per-body sim that `consumeTick`/`respawnClient`/`playerEntry` do on
`client` is what an NPC reuses, and extracting it is where a registry `npc` kind would plug in.

## Not in this plan

Wounds, limb loss, bleeding, ragdolls and blood FX: players do not have them in Base Game, so
NPCs do not either until that lands for everyone. Bot voice and squad radio. Drone operators as an
NPC role. Health packs as world entities. A commander or adversary economy (the 2026-08-11
synthesis stands on its own). Friendly-fire rules.

## Decisions (answered 2026-08-27)

1. **No NPC cap.** Counts are whatever the owner sets; gate N1 reports the cost curve so the
   number is informed, not enforced.
2. **NPC speed is bot-viewer speed.** The NPC controller `config` takes its move and sprint
   values from v3's `botMovementSettings` and `bot-stance.js` multipliers, not the player's
   5.5 m/s.
3. **Friendly fire is a shared-key toggle.** `applyDamage` is the one funnel, so the toggle
   gates it there for players and NPCs alike; NPC targeting stays team-partitioned regardless.
4. **Solo and online both.** Solo through the loopback room; the relay path unchanged.
5. **Roles, yes.** v3's role designs (`botDesignForRole`, armoured and soldier kinds) are added
   as ids in `base-game-body-models.js` (all `humanoid-default` hit profile) and composed by
   `base-game-player-bodies.js`.
6. **Appearance variation is required.** `bot-face.js` already owns it (`SKIN_TONES`,
   `HAIR_COLORS`, `FACE_EXPRESSIONS`; `composeBot(body, 'human', { expression })`; skin and hair
   are per-body tints that `setTint` deliberately skips) and nothing rolls it in either app.
   Player entries gain `appearance: { skin, hair, expression }` on the wire; the server rolls an
   NPC's from its seed at spawn, and a player's comes from `base:set_body`. Expression is fixed
   per body at first because `makeHumanHead` builds the face gear at compose time; a
   state-driven face (determined → shout → pain → dead) is a later step that needs a face swap
   cheaper than a body rebuild.
