# Squads, outposts, and an ammo economy

Status: DESIGN (2026-07-14). Not started.

## Goal
Layer squad/outpost command structure on top of the existing per-bot combat FSM
(`docs/superpowers/specs/2026-07-13-combat-bot-fsm-design.md`, `docs/subsystems/bots.md`), and
replace bots' currently-infinite-then-permanently-dry ammo (see that spec's fourth-polish-pass
note) with a real supply economy covering two resources — ammo and first aid kits: bots carry
finite amounts of both, refill only from pickups/outposts, and squad leaders/outposts are the
supply chain. Individual bot combat (aim/fire/patrol/seek FSM, line-of-sight, alerting) is
unchanged — this spec adds a layer *above* it, not a replacement, with one exception: healing
finally implements the `retreat` FSM state the FSM spec left as "not yet built" (hp-gated), just
scoped tighter (hp-*and*-kit-gated, per-bot rather than squad-wide).

## Source quotes (what was asked for, verbatim, so intent is traceable)
- "a squad is a group of at least 5 bots that work together, and are led by a squad leader. the
  squad leader determines where to go, and the squad members follow. squad leaders can command
  bots to attack or retreat. when retreating, the squad leader will run away and the squad
  members will follow. squads can get ammo from squad leaders, and leaders can call for ammo
  drops to replenish themselves. ammo drops come down in parachutes, and they are capturable from
  enemies. enemies drop ammo when they die."
- "outposts can have 2-3 squads, and an outpost leader that commands a squad."
- "outposts have ammo, and a flag."
- "squad leaders right now are just going to have a 50/50 change of telling their members to
  either retreat or not when 40% of the squad is lost. outpost leaders have a 50/50 chance of
  over ruling a command from a squad leader. they also have a 50/50 chance of commanding the
  other squads to retreating or attacking when a squad is lost or retreats. bots are faster when
  retreating. actually, make it so that leaders have different temperments, meaning different
  likihoods of attack or flee."
- "bots need to be able to heal. they can run, then use first aid kits. they drop these as well.
  bots have 1 first aid kit each. they can get these from drops too. outpost have them too.
  outposts are placed randomly around the map, squads can be found anywhere, but are more common
  near outposts (over a decently large radius), essentially making a gradient of likelihood."

## Terminology
- **Squad** — 1 leader + 4+ members (5+ total). All squad members are regular combat bots; the
  leader is a combat bot too (fights, can die) with an extra role layered on top, not a separate
  entity type.
- **Outpost** — 2-3 squads plus one **outpost leader**. Read "an outpost leader that commands a
  squad" as the same pattern one level up (squad leader : squad members :: outpost leader : squad
  leaders) — i.e. the outpost leader is *also* one squad's leader (dual role, no new entity type)
  and additionally issues orders to the other squads' leaders. Flagged in Open Questions in case
  "commands a squad" meant something narrower.
- **Order** — a directive that flows down the hierarchy: outpost leader → squad leaders (which
  squad attacks/holds/retreats, and where) → squad members (inherit the squad's current order,
  same as today's FSM states are per-bot). Orders are state, not one-shot events — a squad has a
  *current* order it's still executing every tick, same shape as `rec.fsmState` today.
- **Temperament** — a per-bot trait (`rec.temperament`, 0..1, "aggression") assigned at spawn like
  `botMaxHp`/`botMoveSpeed` are today. Only consulted while that bot is *acting as* a leader (squad
  or outpost) — a regular member's temperament sits unused unless it's promoted via succession, at
  which point the squad's decisions immediately start reflecting the new leader's own number, not
  the dead leader's. 0 = flees at the first excuse, 1 = holds/pushes forward almost no matter what,
  0.5 = the original flat-50/50 behavior as originally requested. Every temperament-gated decision
  below is a **weighted coin flip**, not a deterministic threshold — a 0.9-aggression leader can
  still occasionally order a retreat, same as a real "usually bold, sometimes cautious" personality.

## Data model

New top-level maps alongside `botPlayers` (environment-viewer.html):

```js
squads = new Map();   // squadId -> Squad
outposts = new Map(); // outpostId -> Outpost
```

```
Squad {
  id, outpostId, teamId,
  leaderId,              // a botPlayers id; null if leader is dead and no successor yet
  memberIds: Set<id>,    // includes leaderId
  initialSize,           // memberIds.size at formation time -- the denominator for the 40%-lost check
  order: 'hold' | 'attack' | 'retreat',
  orderTarget: {x,z} | null,   // attack: objective position; retreat: rally point
  lossRetreatDecided: false,   // latch: the 40%-loss coin flip fires once per threshold crossing, not every tick
  ammoPool: { [weaponId]: reserveCount },  // leader-held shared reserve, see Ammo economy
  pendingDrop: dropRequestId | null,       // set while an ammo-drop call is in flight
}
```

```
Outpost {
  id, teamId, pos: {x,z},
  squadIds: [id, id, id?],   // 2-3
  leaderSquadId,             // which squad's leader is also the outpost leader
  ammoStockpile: { [weaponId]: reserveCount },  // draws down on every drop call, see below
  medkitStockpile: reserveCount,                // same idea, for first aid kits -- see Healing
  flag: { teamId, captureProgress01, contestedBy: teamId | null },
}
```

Bot rec (`botPlayers` value, environment-viewer.html `spawnBotAt`) gains:
```js
squadId: null, isLeader: false, temperament: 0.5, // aggression, randomized per bot at spawn -- see Temperament above
firstAidKits: 1, healing: false, healStartedAt: null, // see Healing & first aid kits
```
Nothing else about the existing rec shape changes — `fsmState`/`lastKnownTarget`/aim/fire/reload
all keep working exactly as they do today, per-bot. Squad membership only changes *which
movement target* a non-leader bot's patrol/seek logic resolves to (see Movement below), gates the
new ammo-pool draw, and (for retreat, and for healing — see below) the bot's move speed (see
Movement).

## Command hierarchy & orders

- **Outpost leader → squad leaders**: picks each squad's `order` + `orderTarget`. Simplest useful
  policy for v1: attack the nearest enemy outpost's flag position with 2 of its 2-3 squads, hold
  the 3rd back defending its own flag; if the outpost's own flag is contested, recall an attacking
  squad to `retreat` toward home. This is intentionally simple — a real tactical AI is out of
  scope for v1 (see Phasing). Layered on top of this baseline policy are the reactive,
  temperament-weighted overrides below.
- **Squad leader → squad members**: a squad member's own `fsmState` (patrol/seek/aim/fire) is
  unchanged and still reacts to *its own* visible targets exactly as today (a member doesn't need
  the leader's permission to shoot back at someone shooting at it — `alertBot`/`propagateBotAlert`
  already handle that). What the leader controls is where a member goes *when it has no target of
  its own*: today that's `nextPatrolTarget` (a wander/waypoint loop); for a squad member it
  becomes "near the leader" (attack/hold) or "toward the rally point, same as the leader" (retreat)
  — see Movement.
- **Retreat**: leader sets its own movement goal to the rally point (outpost position, or spawn if
  the outpost is lost) and moves there like a `seek`-style path-follow; members' patrol target
  resolves to "near the leader" the same way it does for `attack`/`hold`, so retreating is just
  "follow the leader" pointed at a different destination — no separate member-side retreat logic
  needed. Retreating bots (leader and members both) move faster than normal — see Movement.

### Temperament-weighted decision rolls

Three distinct decision points, each an edge-triggered weighted coin flip (rolled once when its
triggering condition first becomes true, then latched — never re-rolled every tick while the
condition continues to hold, or a leader would flip-flop dozens of times a second):

**1. Squad leader: retreat when the squad takes heavy losses.**
```js
function tickSquadLossDecision(squad) {
  const aliveCount = [...squad.memberIds].filter(id => playerCombat.getSnapshot(id).alive).length;
  const lostFrac = 1 - aliveCount / squad.initialSize;
  if (lostFrac < 0.4) { squad.lossRetreatDecided = false; return; } // recovered (reinforced) -- can fire again later
  if (squad.lossRetreatDecided) return; // already rolled for this loss streak
  squad.lossRetreatDecided = true;
  const leader = botPlayers.get(squad.leaderId);
  const retreatChance = 1 - (leader?.temperament ?? 0.5); // cautious (low aggression) leaders retreat more readily
  if (Math.random() < retreatChance) setSquadOrder(squad, 'retreat', outposts.get(squad.outpostId)?.pos);
}
```
40% lost is measured against `initialSize` (the squad's size when formed), not current headcount,
so a squad that started at 5 retreats-or-not once it's down to 3 alive.

**2. Outpost leader: overrule a squad leader's order.**
Rolled once every time a squad's `order` changes (whether from the loss decision above or any
future trigger) — never on an order that's simply still in effect:
```js
function maybeOverruleSquadOrder(outpost, squad) {
  const t = botPlayers.get(outpostLeaderBotId(outpost))?.temperament ?? 0.5;
  // Aggressive outpost leaders (high t) are quick to overrule a *retreat* back into the fight;
  // cautious ones (low t) are quick to overrule an *attack/hold* into a retreat. Either way the
  // roll pushes toward the outpost leader's own disposition, not a direction-agnostic flip.
  const overrule = squad.order === 'retreat' ? Math.random() < t : Math.random() < (1 - t);
  if (overrule) setSquadOrder(squad, squad.order === 'retreat' ? 'attack' : 'retreat', ...);
}
```

**3. Outpost leader: react when a squad is lost or retreats, by commanding the *other* squads.**
Rolled once per triggering event (a squad wiped out entirely, or a squad's order transitioning
into `retreat`), for each of the outpost's other squads:
```js
function outpostReactToSquadEvent(outpost, sourceSquad) {
  const t = botPlayers.get(outpostLeaderBotId(outpost))?.temperament ?? 0.5;
  for (const id of outpost.squadIds) {
    if (id === sourceSquad.id) continue;
    const other = squads.get(id);
    const goAggressive = Math.random() < t; // high aggression -> more likely to push reinforcements in, not pull back
    setSquadOrder(other, goAggressive ? 'attack' : 'retreat', goAggressive ? sourceSquad.orderTarget : outpost.pos);
  }
}
```

All three reuse the same `temperament` field and the same "weighted coin flip toward the leader's
own number" shape — there's deliberately only one personality concept in this system, applied at
three decision points, rather than three separate tunables.

## Movement: leader-follow

Reuse `botTickMovement`'s existing patrol/seek machinery (`requestBotPath`, `followBotPath`,
`nav-grid.js`/local-window A*) rather than inventing new pathing. Change only the *goal* a
non-leader, no-target bot paths toward:

```js
function squadMemberGoal(rec) {
  const squad = squads.get(rec.squadId);
  const leader = squad && botPlayers.get(squad.leaderId);
  if (!leader) return null; // no leader (dead, no successor yet) -- falls back to patrol
  return formationOffset(botMidXZ(leader.bot), squad.order); // loose ring around the leader, not exact slot
}
```
`nextPatrolTarget(rec)` (existing, wander/waypoint-loop) becomes: squad members call
`squadMemberGoal` first, falling back to today's wander behavior only if unsquadded or leaderless.
A loose radius (not exact formation slots) keeps this cheap — members re-path only when they
drift outside the ring, same replan cadence `requestBotPath` already uses for patrol/seek.

**Retreat speed**: wherever bot movement speed is read (`botMoveSpeed`, live every tick today),
a bot whose squad order is `retreat` gets a flat multiplier on top:
```js
function botCurrentSpeed(rec) {
  const squad = rec.squadId && squads.get(rec.squadId);
  return botMoveSpeed * (squad?.order === 'retreat' ? BOT_RETREAT_SPEED_MULT : 1);
}
```
Applies to the leader too (it's the one setting the pace — members are following it, so a faster
leader means a faster-moving retreat overall even before considering the members' own multiplier).
`BOT_RETREAT_SPEED_MULT` ~1.4-1.5x, panel-tunable alongside the existing behavior sliders.

**Leader succession**: on leader death, `updateBots`'s existing death handling (already resets
`rec.*` fields on respawn) additionally needs to: pick a successor from `memberIds` (simplest:
first remaining alive member) and update `squad.leaderId`. Until a successor is picked (single
tick), `squadMemberGoal` returns null and members fall back to individual patrol/seek — never a
crash, just a one-tick lapse in cohesion.

## Ammo economy

Today (per the third/fourth polish passes): `ensureAmmo`/`reloadAmmo` move rounds from a fixed
per-weapon `reserve` into `mag`, and `reserve` is never refilled — bots that fire enough
eventually go permanently dry. This spec's fix is: **stop treating `reserve` as fixed**, and add
pickup entities that add to it.

- **Individual ammo (unchanged)**: `mag`/`reserve`/reload-timer logic (`BOT_RELOAD_MS`) stays
  exactly as-is; this spec only adds ways `reserve` goes back up.
- **Squad ammo pool (leader-held)**: the squad leader carries `squad.ammoPool[weaponId]`, a
  shared reserve on top of its own personal `reserve`. When a member's own `reserve` hits 0 (no
  more reload possible), and it's within the same loose follow radius as its movement goal, it
  draws a chunk (e.g. one magazine's worth) from `squad.ammoPool[member.weaponId]` instead of
  staying dry — modeled as an instant "resupply" transfer, no new pickup entity needed for this
  path since it's peer-to-peer within a squad that's already colocated.
- **Supply drop crates (parachute)**: when `squad.ammoPool` for the squad's weapon type drops below
  a threshold, the squad leader calls a drop (gated so only one is in flight at a time —
  `squad.pendingDrop`), which draws from `outpost.ammoStockpile` (fails/no-ops if the outpost
  itself is dry — see Open Questions on stockpile refill) and spawns a new entity type,
  `supply_drop` (carries ammo and/or kits — see Healing & first aid kits below for the kit half of
  its payload), following the `entityRegistry` pattern used by `ExplosionEntity`/
  `CombatProjectileEntity` (`entity-types/*.js`, `create`/`update`/`serialize`):
  - Spawns high above a point near the squad, descends at a slow fixed rate (parachute — no
    gravity acceleration, unlike `combat-projectile.js`'s grenade arc) until it hits
    `terrainHeight`/`mapCollider`, then becomes a static, lootable crate.
  - **Capturable from enemies**: the crate is not team-locked — any bot or the player within pickup
    radius can draw from it, added to their own `reserve` directly (not the calling squad's pool),
    first-come-first-served until its payload is exhausted or a timeout expires, then despawns.
    This is what "capturable" means here: nothing to actively contest, just unclaimed loot that
    doesn't check `teamId`.
- **Death drops**: on a bot's death (`updateBots`'s existing `!combat.alive` branch, right where
  `deadSince` gets set), spawn a small `supply_drop`-type pickup at the death position with a fixed
  ammo payload (not the dead bot's exact remaining ammo — keeps this independent of whatever the
  dead bot happened to be carrying, avoids a 0-payload drop from a bot that died dry) plus its
  unused first aid kit, if it still had one (see Healing & first aid kits). Same
  capturable-by-anyone pickup logic as a called-in drop, just smaller and with no parachute descent
  (drops straight down at the death point).

## Healing & first aid kits

A second, simpler consumable resource alongside ammo — a first aid kit is a discrete count (0 or
1 per the request, see Open Questions on whether more can ever be carried), not a mag/reserve pool,
and it has no reload-style timer: it's either used (fully, all at once) or not.

- **Trigger — a personal reflex, independent of squad order**: unlike squad-level `retreat` (a
  leader's tactical call), healing is something any bot can act on regardless of what its squad is
  currently doing. When a bot's `playerCombat.getSnapshot(id).hp` drops below
  `BOT_HEAL_HP_THRESHOLD` (a new panel-tunable trait, e.g. defaulting to 35% of max) **and** it's
  carrying a kit **and** it has no visible target (`!targetVisible` — a bot with an enemy in its
  sights doesn't stop to bandage mid-fight), it breaks off. This is exactly the `retreat` FSM state
  `docs/subsystems/bots.md`'s "Not yet built" section flagged as needing a bot HP model — this spec
  is what finally implements it, gated tighter than a bare hp threshold (hp *and* kit availability,
  and scoped per-bot rather than a squad-wide order).
- **"Run"**: reuses the exact same movement-away-from-threat + speed boost already spec'd for squad
  retreat (`BOT_RETREAT_SPEED_MULT`, direction away from `lastKnownTarget`/nearest threat) — no new
  movement code, just a second trigger condition that can drive the same behavior independent of
  `squad.order`.
- **"Then use first aid kits"**: once clear of any visible target for `BOT_HEAL_SAFE_MS` (a short
  beat, so a bot doesn't try to bandage one step outside LOS mid-sprint), it stops and channels for
  `BOT_HEAL_CHANNEL_MS` (e.g. 3000ms), restoring HP linearly over the channel rather than instantly
  at the end — a bot that gets reacquired mid-channel is still worse off than one that finished,
  giving the player a real window to punish a healing bot. If a target becomes visible again during
  the channel, healing cancels: **the kit is not consumed**, `healing`/`healStartedAt` reset, and
  the bot returns to normal FSM control (typically straight back into `aim`/`fire`). Only a clean,
  uninterrupted channel spends the kit (`firstAidKits -= 1`) and applies the heal.
- **Sources**: 1 kit at spawn (fixed, matches "bots have 1 first aid kit each"). Refilled only from
  a `supply_drop` pickup carrying a kit, or (assumed, not stated outright) drawn directly from
  `outpost.medkitStockpile` when physically at/near the outpost — kits have no squad-leader-held
  shared pool the way ammo has `squad.ammoPool`; the request describes drops and outposts as the
  only kit sources, no leader-to-member hand-off step.
- **"They drop these as well"**: read as bots dropping their unused kit on death, alongside their
  fixed ammo payload — folded into the same `supply_drop` death-drop entity described in Ammo
  economy above rather than a second pickup type, so a looter finds one crate with (up to) both
  resources instead of hunting two separate drops per dead bot.

## Outpost flag & capture (minimal v1)

"Outposts have ammo, and a flag" — spec'd minimally since no broader round/objective system exists
yet in this codebase (the FSM spec's "Open questions" already flagged this gap as unresolved):
- `outpost.flag.teamId` — who currently owns it (drives which squads treat it as home/rally).
- `outpost.flag.captureProgress01` — ticks up while only one team's bots (or the player, if players
  should be able to capture — open question) are within a capture radius and no defenders of the
  owning team are present; ticks back down otherwise. Standard FPS-domination-point math, no new
  primitive needed (same shape as an aim-error/health bar tween already used elsewhere).
- On full capture: `flag.teamId` flips, `outpost.ammoStockpile` is **not** reset (captured supply
  stays captured — gives capture a tangible payoff), and every squad whose `outpostId` was this
  outpost re-homes its rally point to the new owner's nearest remaining outpost (or, if the
  capturing side has none, the squads are just orphaned and fall back to individual patrol/seek —
  same lapse-in-cohesion behavior as a leaderless squad).
- Win condition / scoring off the back of outpost capture is explicitly **not** spec'd here — same
  "no round-win logic exists yet" gap noted in the FSM spec, still out of scope.

## Placement: outposts and a squad spawn-density gradient

- **Outposts**: placed at map load (or squad-mode enable) by sampling N positions uniformly at
  random from the map's walkable area — reusing whatever walkability test the map already exposes
  (`botNavWalkable` on shoot-house, `botTerrainWalkable`-style checks on open terrain) — rejecting
  any candidate too close to an already-placed outpost (`OUTPOST_MIN_SPACING`) so outposts don't
  cluster by chance in one corner of the map.
- **Squads — "anywhere, but more common near outposts"**: a distance-weighted rejection sample
  rather than uniform-random placement. Pick a candidate point uniformly at random from the
  walkable area (cheap, same pool outposts sample from), then accept it with a probability that
  rises toward outposts and never fully bottoms out elsewhere:
  ```js
  function squadSpawnAcceptProb(pos) {
    const d = nearestOutpostDistance(pos); // metres to the closest outpost.pos
    const falloff = Math.max(0, 1 - d / SQUAD_GRADIENT_RADIUS); // 1 at an outpost, 0 past the radius
    return SQUAD_BASE_ACCEPT + (1 - SQUAD_BASE_ACCEPT) * falloff;
  }
  ```
  Re-roll a fresh candidate on rejection. `SQUAD_GRADIENT_RADIUS` is the "decently large radius"
  from the request — map-scale, not bot-scale (existing per-bot ranges like `BOT_SENSE_RANGE`=25m
  or `BOT_LOCAL_NAV_RADIUS`=18m are the wrong order of magnitude for reference; start around
  150-250m, tunable). `SQUAD_BASE_ACCEPT` (e.g. 0.15) keeps "squads can be found anywhere" literally
  true — a squad can still land on the far side of the map, just less often than one lands near an
  outpost. This is the same accept/reject-around-a-center-point shape `plants-placement.js`'s
  clustering already uses for its distance-to-clump-center gate (`agent_log.csv`, 2026-07-05),
  just at map scale with a nonzero floor instead of a hard falloff to zero.
- **Phase-ordering wrinkle**: the gradient only means something once outposts exist (Phase 4).
  Phases 1-3 (squads with no outposts yet) fall back to today's existing uniform spawn-point
  sampling (`sampleBotSpawnPoints`/`botSpawnSlot`, generalized from one bot to a whole squad) —
  there's no outpost position yet to measure distance from.

## Wiring / integration points

- `spawnBotAt`/`updateBots` (environment-viewer.html): bots gain `squadId`/`isLeader`; a new
  squad-forming step (spawn 5+ bots as one squad, assign a leader) replaces or wraps today's
  per-bot `spawnBotAtSlot` loop when squad mode is on.
- `botTickMovement`/`nextPatrolTarget`: gains the `squadMemberGoal` branch described above.
  Individual aim/fire/reload/LOS/alerting code is untouched.
- New `entity-types/supply-drop.js` (ammo and/or kits — see Healing & first aid kits), registered
  via `entityRegistry.registerType` alongside the existing five types
  (environment-viewer.html:186-190).
- New pickup-consume check: on each `updateBots` tick (or the existing per-frame player-item-pickup
  pass, if the game already has one for something else — needs checking, not confirmed here),
  test bot/player capsule distance against live `supply_drop` entities, same point-to-capsule
  distance math `alertBotsToShot`'s near-miss check already uses.
- New per-bot heal check in `botTickOne` (or a sibling function called from it): the
  hp/kit/no-target gate, the `BOT_HEAL_SAFE_MS`/`BOT_HEAL_CHANNEL_MS` timers, and the
  interrupt-on-target-reacquired cancel path described in Healing & first aid kits.
- New outpost/squad placement functions (`placeOutposts`, a squad-forming variant of
  `spawnBotAtSlot` that consults `squadSpawnAcceptProb`) — called once at squad-mode enable, not
  per-tick.
- Debug panel: squad size, outpost count, a manual "call ammo drop" button, and a heal-HP-threshold
  slider belong in a new "Squads & Outposts" panel section, same style as the existing "Combat
  Bots" section.

## Phasing

- **Phase 1 — squads only, no outposts, no drops. DONE (2026-07-14).** Group existing bots into
  one squad (min 5), placed via today's existing uniform spawn-point sampling (no gradient yet —
  see Placement), leader-follow movement, retreat speed multiplier, and per-bot `temperament`.
  Includes decision roll #1 (squad leader's loss-triggered retreat) since it only needs a squad
  leader, no outpost — attack/hold orders otherwise still come from a debug-panel button (not an AI
  outpost-leader yet). Proves the command-hierarchy plumbing, temperament, and leader succession in
  isolation. Landed as `squad-activity.js`/`test-squad-activity.mjs` (pure decision logic) +
  `environment-viewer.html` wiring — see `docs/subsystems/bots.md`'s "Squads (Phase 1)" section for
  what actually shipped. Interactive browser verification (formation-follow, retreat, succession)
  is still outstanding, flagged there.
- **Phase 2 — individual ammo + medkit economy.** Death drops + `supply_drop` entity +
  pickup-consume check, independent of squads (works even with unsquadded bots — "enemies drop
  ammo when they die," and now kits too, applies to any bot). Also lands the per-bot heal
  break-off/channel behavior (`firstAidKits`, `BOT_HEAL_HP_THRESHOLD`/`_SAFE_MS`/`_CHANNEL_MS`),
  since it only needs a bot's own hp/kit state, no squad. This phase is also the actual fix for the
  "bots run permanently dry" gap the fourth FSM polish-pass review surfaced — can ship before
  squads if sequencing matters more than the spec's own phase order.
- **Phase 3 — squad ammo pool + leader-called drops.** `squad.ammoPool`, peer-to-peer resupply
  radius, `pendingDrop` gating, parachute descent variant of `supply_drop`.
- **Phase 4 — outposts.** `Outpost` records, outpost leader dual-role, 2-3 squad grouping,
  `ammoStockpile`/`medkitStockpile`, minimal flag/capture, decision rolls #2/#3 (outpost leader
  overruling a squad leader, and reacting to a squad being lost/retreating by commanding the
  others) — both need an outpost leader to exist, so they land here rather than Phase 1 — and the
  squad spawn-density gradient toward outposts (meaningless before outposts have positions to
  measure distance from). Depends on Phase 1-3 all being solid, since an outpost is just "a few
  squads plus a supply cap" on top of them.

## Open questions

- **"an outpost leader that commands a squad"** — spec'd as dual-role (outpost leader is also one
  squad's leader, per the squad-leader:members :: outpost-leader:squad-leaders reading). Could
  instead mean the outpost leader is a distinct non-combat entity, or commands only one specific
  squad rather than all of them. Needs confirmation before Phase 4.
- **Outpost stockpile refill** — nothing currently refills `outpost.ammoStockpile` once drops draw
  it down, so an outpost eventually can't call drops either. Left open: maybe outposts pass a slow
  trickle regen, maybe capturing enemy crates/outposts is the only refill, maybe it's meant to be a
  hard resource-attrition mechanic (outposts *should* run out eventually). Affects Phase 4 tuning
  only, not Phases 1-3.
- **Does the player benefit from this economy** — can the player loot `supply_drop` pickups (ammo
  and kits both — death drops and called-in crates both say "capturable from enemies," which reads
  as yes), and can the player contest/capture an outpost flag solo, or is flag capture
  bot-squad-only? Assumed yes to both above (pickups are team-agnostic by design; flag capture math
  doesn't exclude the player) but not explicitly stated in the request.
- **Kit cap** — "bots have 1 first aid kit each" is read as a hard cap of 1, not just a starting
  amount: a bot already holding a kit can't loot a second one from a pickup until it uses (or loses,
  on death) its current kit. Needs confirmation — could instead mean kits can stack.
- **Heal channel shape** — spec'd as a 3s interruptible channel with linear regen over that window
  (not an instant press-to-heal), read from "run, **then** use first aid kits" implying a
  distinguishable two-step action. Duration/regen curve are unconfirmed placeholder numbers.
- **Heal HP threshold** — not stated in the request; assumed a new panel-tunable trait
  (`BOT_HEAL_HP_THRESHOLD`, e.g. defaulting to 35%) matching the existing pattern for every other
  bot trait (health/speed/sight/tenacity/notice/accuracy).
- **Squad/outpost team count** — spec assumes at least two teams (attacker/defender or two
  opposing bot factions) exist for "enemies" to mean anything; today's bot wiring has a single
  implicit team (all bots vs. the host player). Needs a `teamId` concept on bots that doesn't
  fully exist yet — currently only `alertBot`/combat treat "the player" and "bots" as the two
  sides. Multi-squad bot-vs-bot combat isn't validated anywhere yet.
- **Temperament distribution** — spec'd as a 0..1 random value assigned per bot at spawn but
  doesn't say the distribution (flat uniform vs. clustered around 0.5 with occasional extremes) or
  whether it should be panel-tunable (a min/max range slider, matching how every other bot trait —
  health/speed/sight/tenacity/notice/accuracy — already works). Defaulting to flat uniform [0,1]
  and a panel range slider unless told otherwise.
- **40%-lost basis** — read as 40% of `initialSize` (squad's size when formed), not current alive
  count relative to some other baseline. A squad that gets reinforced back above the threshold can
  cross it again later and re-roll (the `lossRetreatDecided` latch resets below 40%) — not spec'd
  explicitly in the request, assumed as the more interesting behavior over a one-shot-ever roll.
