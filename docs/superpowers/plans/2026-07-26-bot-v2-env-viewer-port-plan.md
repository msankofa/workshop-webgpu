# Bot-viewer-v2 → environment-viewer port plan (2026-07-26)

Executes the standing "bot-viewer is authoritative" direction: replace `environment-viewer.html`'s
inline v1 bot brain with the remediated bot-viewer-v2 stack (FSM waves 0-6, cover/corners, roles/medic,
health packs, separation, aim/reaction, danger memory, pursuit). Scoped from a three-way survey of
`bot-viewer-v2.html`, `environment-viewer.html`, and the prior plan docs on 2026-07-26.

Related docs: `docs/merged-procedural-creature.md` (why this port is step 1 of the
environment-viewer-v2 chain), `docs/subsystems/bots.md` (both architectures, §env-viewer ≈ lines 263-468),
`docs/superpowers/plans/2026-07-25-bot-fsm-remediation-orchestration-plan.md` (module contract),
`docs/superpowers/plans/2026-07-23-bot-cover-corners-plan.md` (rect-bake assumption + Future Work),
`docs/superpowers/reviews/2026-07-19-bot-port/PLAN-fable-review.md` (render/perf port, already shipped),
`docs/superpowers/reviews/2026-07-18-bot-stuck-systemic-review.md` (open findings R2/R3/R5/R6).

## STATUS

- [ ] Decision gate D1 — map scope for Phase A (recommended: shoot-house first)
- [ ] Decision gate D2 — fate of `squad-activity.js` squads (recommended: v2 roles/bounding supersede; keep squad UI removed until parity)
- [ ] Phase A — core brain swap (shoot-house)
- [ ] Phase B — separation / spatial hash / goal claims
- [ ] Phase C — roles, medic, health packs (needs world pack items)
- [ ] Phase C½ — explosives AI + squads (added 2026-07-29, see "2026-07-29 update")
- [ ] Phase D — open-terrain nav + cover
- [ ] Phase E — polish parity (ragdoll death, bot SFX, inspector/panel, squads decision follow-through)
- [ ] Browser QA per phase (user gate) — MUST include at least one non-flat map from Phase A on (see gotcha G1)

## 2026-07-29 update — where this leads, and how v2 drifted

### This port is step 1 of the environment-viewer-v2 chain

`docs/merged-procedural-creature.md` sets the target. After this port lands, the bot stack
merges with the creature system: bot layers decide **where** (FSM → nav → waypoint), creature
physics decides **how** (waypoint → `computeSteering` → foot-driven physics), under one unified
perception model. The result is **environment viewer v2**. New creature types (birds, fish,
worms — via a per-mode locomotor dispatch) and non-combat gameplay build only on top of that
merged system. So this port gates everything downstream, not just bot parity.

**The harness survives this port.** The bot viewer continues as **bot viewer v3** after the
port — an independent harness, never dissolved into the game. Its purpose stays: develop bots
in shared, pure modules so they port cleanly into environment viewer v2 (see
`docs/merged-procedural-creature.md`, "The bot viewer survives as bot viewer v3").

Two merge-aware notes for the port itself:

- **Perception will unify on the bot model** (FOV/LOS/notice-time beats distance radii). Port
  perception cleanly separated from the brain so creatures can adopt it later.
- **The register machine (S2) gets a second client.** If the brain lands as an extracted
  THREE-free `bot-brain.js`, the creature merge can drive creature bodies from the same brain.
  That strengthens the existing S2 recommendation; it does not change it.

### Bot-viewer-v2 drift since the 2026-07-26 scoping scan

The harness kept moving. These shipped in v2 after scoping and change the port scope:

- **Squads are real now** (`bot-squad.js`): persistent rosters, leader election + succession
  shock, wedge/column/line/ring formations, reconciler + detachments, sides + home bases,
  support roles inside squads. Node-tested. This supersedes D2's framing — see the D2 amendment.
- **Per-bot stance** (`bot-stance.js`): stand/crouch/prone/run + the STANCE_DASH blast-evade
  sprint; speed/spread/height/turn multipliers; capsule height derived from the rig. Folds into
  Phase A — the brain reads the stance channel every tick.
- **Locomotion weapon carries** (`weapon-hold-resolver.js`, Contract 6): stance × locomotion
  resolve of the third-person hold; the mount frame was made stance-invariant (2026-07-29).
  Folds into Phase A's mount wiring — env-viewer already blends crouch/prone holds for the
  local player, so this closes a gap both apps had.
- **Sidearms** (`bot-sidearm.js`): pistol backup (draw instead of reload under fire) + back/hip
  stow visuals; `entity.weapon` now means the gun in hand. Folds into Phase C — roles own loadouts.
- **Specialist roles**: sniper + technical as pure role descriptors
  (`sightScale`/`closeRange`/`swapOnDryMag`), no branches. Free with Phase C's `bot-roles.js` port.
- **Explosives AI** (`bot-projectiles.js`, `bot-grenade.js`): ballistic aiming, flying
  rockets/grenades, throw gating + live-grenade evade, ordnance tuning (2026-07-28). New
  Phase C½: env-viewer already owns projectile/explosion entities and blast plumbing
  (`applyExplosionBlast`), so this port is decision math + the evade→dash trigger, not new FX.
- **State-code tracing** (`bot-state-code.js`, `bot-trace-viewer.html`, the mind view): 9-slot
  discrete state codes, trace capture/export, live trace channel. Port EARLY (with Phase A) —
  it is the best QA instrument for proving the ported brain matches the harness.
- **Terrain-aware nav hardening**: nav-grid region labels + connectivity checks (the
  "stranded bots in valleys" fix), slope-costed A*, crest cover. Extends Phase D. The v2
  terrain *generation* overhaul (landforms, erosion, pads) stays harness-only — env-viewer
  has real terrain.
- **Perf**: think stagger + rig LOD (A/B verified in the harness), wall instancing, floodFill
  pooling (see the G5 amendment), auto-add population caps. Port the stagger/LOD pattern with
  Phase A.
- **Still out of scope** (unchanged from "Do NOT port"): bot lighting / reactive lighting,
  save/load slots, scoreboard, and the camera intent model (`bot-viewer-v2-camera.html` —
  not merged even inside the harness yet).

G3 applies double: every symbol anchor below is a 2026-07-26 snapshot and the harness has
grown substantially since. Re-locate by symbol at execution time.

## What already shipped vs. what this plan does

The 2026-07-19 "bot port" was **rendering/perf only**: terrain-relative weapon rig Y, shared weapon
template cache + `skeletonClone`, body/weapon LOD, `body-part-batches.js` instancing behind
`instanceBots: true`. All shipped. **This plan is the AI/nav/behavior port**, which had not started
as of 2026-07-26 (confirmed against agent_log tail — all recent bot work is v2-harness-only).

Both apps import the **same module files** — there are no diverged copies. Env-viewer imports only
`bot-entity.js`, a 7-symbol legacy subset of `bot-activity.js` (PATROL/SEEK/AIM/FIRE era), `nav-grid.js`,
and `squad-activity.js`; its brain is ~1,700 inline lines (`botTickOne`, `botTickMovement`, bespoke
alert/LOS/pushApart). `bot-activity.js` ctx params were deliberately kept pursue-safe-by-default so this
old call site works until the rewrite — this plan is that rewrite.

## Contracts to preserve (env-viewer side — do not break)

1. **`botPlayers: Map<id, rec>` with `rec.bot`** (a `bot-entity.js` entity). Read by
   `getKnownPlayerState`, `currentCombatPlayers`, `getState` wire fold, ghost merge, explosion loop,
   `bumpBotCombatCounters`, Bot Inspector. The v2 actor fields merge INTO this rec, not beside it.
2. **`playerCombat` is the sole HP authority** (`ensurePlayer`/`getSnapshot`/`applyDamage`/`revive`).
   v2's local `actor.health`/`alive` bookkeeping must be re-pointed at combat snapshots.
3. **`applyCombatIntent(intent, id)` is the only fire path.** v2 calls `resolveHitscan` directly;
   port reroutes bot fire through the synthetic-intent path (`botFire`) so ammo, tracers, muzzle SFX,
   near-miss alerts, and MP replication stay free. Aim dispersion from `bot-aim.js` applies to the
   intent's direction (v1 already sprays the bullet, not the yaw — same principle).
4. **`updateHostPlayerGhosts()` after pose mutation**; guests stay render-only via the existing
   `mpRole === 'guest'` early-outs. No new wire message types in Phases A-B.
5. **`hostVisibleToBots()` / `playerImmortal` gates** on perception and damage stay.
6. **`requestBotPath`** remains the nav abstraction hiding static-grid vs. local-window; v2 movement
   primitives call through it rather than owning a grid directly.

## The three hard seams

**S1 — nav/visibility representation.** v2 bakes `nav-visibility.js` fields + `nav-corners.js` corner
maps from AABB rect lists (`activeWalls`/`activeCovers`) over ONE persistent grid. Env-viewer has a BVH
triangle soup and two nav regimes (static grid on shoot-house only; 36 m throwaway local A* windows
elsewhere). `nav-visibility` memory is walkableCount² bits (~3 MB @ ~5k walkables) — unusable on
1200-4000 m maps. Resolution (per the cover/corners plan's own Future Work): **stop discarding the
`shoot-house-pieces` primitive list** (already carries `kind:'cover'` tags) and bake from those rects.
Open terrain is Phase D with its own strategy.

**S2 — the register machine.** v2's brain (`updateBotSentry` ~520 lines + ~40 helpers, harness lines
~3860-6280) is written against ~40 module-scope globals loaded/stored by `bindBotActor`/`commitBotActor`.
No module requires this — it's harness legacy. **Decision: carry it across intact** (mechanical,
low-risk) into a dedicated section of env-viewer (or an extracted `bot-brain.js` if it stays THREE-free);
refactor-to-explicit-actor is a separate later cleanup, not part of this port.

**S3 — terrain interface.** `terrainHeight(x,z)` drops in for v2's `groundHeight`, but v2 also needs
`slopeAt` (walkability gate) and a per-cell `heights` array (vis-field ridge occlusion, crest corners).
Shoot-house is flat (`heightAt()=0`) so Phase A can stub these; Phase D supplies real ones.

## Decision gates

**D1 — map scope for Phase A.** Recommended: shoot-house only (static grid exists, floor y=0, rect
list recoverable). Non-shoot-house maps keep the v1 seek/patrol behavior via a `BOT_AI_V2` capability
flag until Phase D. Alternative (not recommended): raycast-callback extension of the bakes day one.

**D2 — squads.** `squad-activity.js` (temperament, loss decisions, formations, squads UI panel) is
env-viewer-only; v2's grouping is `bot-roles.js` ranks + bounding-overwatch + medic cohesion.
Recommended: v2 model supersedes; remove the Squads panel + `squad-activity.js` import when Phase A's
brain lands (keep the file — bot-viewer v1 history), and fold "spawn squad" into role-batch spawning
(`assignRolesToBatch`). Alternative: bridge formations onto v2 SEEK — deferred unless missed in QA.

**D2 amendment (2026-07-29).** v2 now has a full squad system of its own (`bot-squad.js`:
rosters, leader succession, formations, reconciler — see the drift list above). The
recommendation strengthens: retire `squad-activity.js` and port `bot-squad.js` in Phase C½.
Formation parity is now real, so the "bridge formations onto SEEK" alternative is dead.

## Phase A — core brain swap (shoot-house)

The bulk of the work (~roughly half the total effort).

1. **Imports.** Add the module stack to `environment-viewer.html`: full `bot-activity.js` surface,
   `bot-aim.js`, `bot-alert.js`, `bot-cover.js`, `bot-danger.js`, `bot-pursuit.js`,
   `nav-visibility.js`, `nav-corners.js`, extended `nav-grid.js` symbols (`lineWalkable`, `floodFill`,
   `floodPath`, cell converters), extended `bot-entity.js` symbols (goal claims; separation waits for
   Phase B). Danger-field A* cost term stays **OFF** (the wave-3 flag was defined for this port).
2. **Rect recovery + bakes.** Surface the `shoot-house-pieces` primitive list from
   `shoot-house.js`/`shoot-house-layout.js` (walls + `kind:'cover'`); at map load (where the static
   grid bakes today) also run `buildSightGrid` + `buildLazyVisibilityField` + `buildCornerMap` with a
   flat `heights` stub. Gate all of it on the existing `NO_ENVIRONMENT && loadedMap` condition.
3. **Port the brain.** Lift `updateBotSentry` + the FSM ctx build + dispatch + movement primitives
   (`followPath`/`requestPathBudgeted`, seek/pursue/flee/cover-move/knife/facing helpers) and the
   bind/commit register machine, re-pointed at `botPlayers` recs: merge `createBotActor`'s fields into
   the rec at `spawnBotAt`; keep `stepBotPhysics` + fall-catch + stuck tracking from v1 (env-specific,
   and v2 lacks the stuck machinery). Replace `botTickOne`/`botTickMovement`/`pickBotTarget`/
   `botHasLineOfSight`-throttle internals; keep the 120 ms LOS cadence initially (env LOS uses
   `resolveHitscan` + obstacle columns and is heavier than v2's single BVH ray).
   `USE_FIELD_LOS_PREFILTER` stays default-off (still un-QA'd even in v2).
4. **Alerts.** Replace `alertBot`/`propagateBotAlert`/`alertBotsToShot` with `bot-alert.js`
   (escalation tiers, `perceptionForTier`, semi-alert propagation). Wire the near-miss and
   explosion alert call sites in `applyCombatIntent`/`applyExplosionBlast` to the new API.
5. **Fire path.** Brain decides fire ⇒ existing `botFire` synthetic intent; `bot-aim.js` reaction
   delay gates `readyToFire`, dispersion cone replaces the flat `botAccuracy` spread (keep the
   accuracy slider driving the new dispersion params).
6. **UI.** Keep the Combat Bots panel + Bot Inspector; inspector gains `state` strings for the new
   FSM (PURSUE/FLEE/COVER_*/reposition/alert) and cover/claim readouts. Squads panel per D2.
7. **Node tests.** The pure modules keep their existing tests. Add an env-side contract test
   (flat Node script per repo convention) asserting the ctx object built for `chooseBotStateName`
   carries every wave-5/6 key (`coverAvailable`, `atCoverAnchor`, `coverValid`, `allyHitNearby`,
   `keepsMissing`, `pursueHealthOk`, `hasHealResource`, `healUnsafe`, ...) so the wiring can't
   silently regress to the 4-key legacy ctx.

Exit: shoot-house rounds show pursue-on-miss, cover peek/hold, flee-to-cover, reaction-delayed fire;
tests green; browser QA gate.

## Phase B — separation, spatial hash, goal claims

- `bot-spatial-hash.js` neighbor index rebuilt per tick over living bots.
- Replace `pushBotsApart` (O(n²)) with `resolveBotPairsHashed` + post-pushout `mapCollider.resolveCapsule`
  re-resolve + `blendSeparationDir` soft steering in path following. This lands review finding **R5**
  (demote hard pushout to penetration-only) and is the natural moment to take **R2** (erode nav grid
  by capsule radius) and **R6** (stop generating off-nav positions) — they touch the same code.
- `createGoalClaims` for cover/seek/flee/pursue/pack claims (Phase A can stub claims as always-granted
  if sequencing demands, but B makes them real).

Exit: 20+ bots in shoot-house without doorway pile-ups or wall-wedging; QA gate.

## Phase C — roles, medic, health packs

- `bot-roles.js` role catalogue + `assignRolesToBatch` at spawn; `squadRanks`/`boundingRole` feed the
  alert push-element logic ported in Phase A.
- `bot-medic.js` decisions + MEDIC_MOVE/MEDIC_TEND dispatch; revive routes through `playerCombat.revive`
  (already exists for respawn).
- `bot-health-packs.js` needs **world pack items**: held-pack visual (crouch+in-hand from v2),
  drop-on-death, ground packs seekable/claimable. Guests must see them ⇒ represent packs in the
  **entity registry** (per the standing lights-first registry migration goal) or as effect-renderer
  statics if the registry isn't ready; host-authoritative either way.

Exit: medics tend/revive under fire, packs drop and get scavenged, guests see packs; QA gate.

## Phase C½ — explosives AI + squads (added 2026-07-29)

- **Explosives AI**: `bot-projectiles.js` ballistic aiming + `bot-grenade.js` throw gating and
  live-grenade evade, routed onto env-viewer's existing projectile/explosion entities and
  `applyExplosionBlast`. Decision math only — no new FX. The evade path needs the STANCE_DASH
  trigger from Phase A's stance channel.
- **Squads**: port `bot-squad.js` (rosters, leader succession, formations, reconciler) and
  retire `squad-activity.js` per the D2 amendment. Spawn flows through `assignRolesToBatch`.

Exit: bots throw and evade grenades on shoot-house; squads hold formation on the move; QA gate.

## Phase D — open-terrain nav + cover

- Supply real `slopeAt` + heights: env-viewer already has slope math inside `botTerrainWalkable`;
  factor it out. For bakes, build a **persistent coarse grid** (cell ≥ 1.5 m) over a bounded combat
  zone around the fight rather than the whole 1200-4000 m map, or keep local windows and skip
  vis/corner cover outside shoot-house — decide after profiling `nav-visibility` at the candidate
  walkable counts (hard wall: walkableCount² bits).
- Crest cover + slope-costed A* from the 2026-07-26 terrain work port here.
- Profile and (maybe) enable the danger-field A* term.
- Blocker rects for authored maps: synthesize from `world-map.js` dressing/structures where available;
  otherwise BVH-raycast bake at load (cover/corners plan's fallback option — runtime API identical).

Exit: bots fight competently on at least one procedural-terrain map; QA gate.

## Phase E — polish parity

- **Ragdoll death** (documented "step B"): `ragdoll.js`/`ragdoll-body.js` on GhostRenderer's death
  edge; hitscan kills through `applyDeathImpulse`, blasts through `applyBlastImpulse`; ground-plane
  collision only in v1 of this.
- **Audio**: port `playAtCulled` + `sfxBudgetOk` voice budget + bot footsteps (`updateBotFootstep`);
  reuse shared `positionalSfxProfiles` (env maps are the 1 km scale they were authored for — do NOT
  port the arena-scaled `BOT_SFX` overrides blindly).
- Extract-and-reuse from `bot-viewer-visuals.js` if wanted: muzzle-flash `flash()` light pooling.
- D2 follow-through; docs (`bots.md` env section rewrite, `code-map.html` edges); delete/stale-banner
  the v1 brain block.

## Do NOT port

`bot-viewer-visuals(-style).js` (env has its own sky/lighting/themes), `bot-viewer-slots.js` (env has
slider-state presets), `bot-camera-control.js` (env is FPS), `bot-terrain.js` (env has real terrain —
only its `slopeAt`/pads *concepts* inform Phase D), `bot-structures.js` (optional, separate feature),
the dummy target, debug CSV recorders (env has `botStatsLog` already), `bot-score.js` (optional nicety).

## Gotchas (all previously recorded; restated because they bite this plan directly)

- **G1 — flat-floor trap.** Every v2 offset is authored against floor y=0. Anything lifted from the
  harness must be re-derived terrain-relative. Shoot-house hides this bug class — QA every phase on
  a non-flat map too (this already caused the 2026-07-19 weapon-rig bug).
- **G2 — Phase 1.5 MUST-FIX is still open**: `teardownLocalWeaponMount` traverse-disposes geometry now
  shared by every bot clone. Land it before spawning more/longer-lived bots.
- **G3 — locate by symbol, never line.** Both HTML files drift constantly; every line ref above is
  a 2026-07-26 snapshot. `bot-viewer-v2.html` grew 60 lines *during* the scoping scan.
- **G4 — shared-asset disposal**: geo tagged `userData.shared` must be skipped in destroy paths;
  `skeletonClone` (never `clone(true)`) for skinned weapon GLBs; `frustumCulled = false` on held
  weapons is intentional.
- **G5 — alloc discipline (amended 2026-07-29)**: danger/scoring lookups O(1) no-alloc in hot
  loops. The original note said `floodFill` returns fresh arrays — that is stale: `floodFill`
  is pooled since 2026-07-27. A pooled result is valid only until the next `floodFill` call;
  a caller that holds a result across frames must pass its own `out` buffer pair (the medic
  flood cache is the one such caller today). Port the new contract, not the old one.
- **G6 — sight-blockers ≠ nav-blockers** (`SIGHT_BLOCK_HEIGHT = 1.5`); rasterization errs visible.

## Key symbol anchors

| What | Where (2026-07-26) |
|---|---|
| v2 per-frame tick | `updateAllBots` bot-viewer-v2.html:1566 |
| v2 brain | `updateBotSentry` :5506; ctx fill :5816; dispatch :5889 |
| v2 actor schema | `createBotActor` :3877; bind/commit :3945/:3985 |
| v2 bakes | `applyLayout` :3649 (grid :3677, vis :3689, corners :3694) |
| env brain to replace | `botTickOne` environment-viewer.html:2312; `botTickMovement` :2225 |
| env perception/alert to replace | :1894-2008 |
| env nav abstraction | `requestBotPath` :2074; `botTerrainWalkable` :1765; `botMeshBlockedAt` :1729 |
| env spawn/update | `spawnBotAt` :1807; `updateBots` :2630; frame call :9365 |
| env fire path | `botFire` :1946 → `applyCombatIntent` :8684 |
| env combat fold | `currentCombatPlayers` :452; `getState` :569; ghost merge :592 |
