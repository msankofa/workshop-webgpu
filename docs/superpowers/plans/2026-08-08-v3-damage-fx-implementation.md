# v3 damage-FX implementation plan (2026-08-08)

The remaining damage-FX work, sequenced for `bot-viewer-v3.html`. Everything here lands in v3;
`bot-viewer-v2.html` is frozen and only picks up changes that happen to live in shared modules.

Scope, in the order the user asked for it:

| Track | What | Source plan |
|---|---|---|
| **A** | Limb loss (idea 2) | `idea-2-limb-loss.md` |
| **B** | Blood pools + robot fire (idea 4) | `idea-4-pools-and-fire.md` |
| **E** | Audio routing and haywire death (idea 3's unshipped phases) | `idea-3-class-damage-language.md` §5, Phases 2/6 |
| **C** | Splatter derived from the spray's own trajectory (blood problem 2) | none — new |
| **D** | Bleedout over time (blood problem 3) | `idea-1-wound-centred-blood.md` §Phase 3, deferred there |

**What of idea 3 actually shipped:** Phase 0 (`bot-damage-class.js`), Phase 1 (blood, spark and smoke
gating in the hit path) and Phase 4 (the `armourBreached` one-way latch, cleared in
`reviveCombatBot`). Phases 2, 3, 5 and 6 did not. Phase 3 (per-actor class) is a hard prerequisite
for track B and lives there as B0; Phases 2 and 6 are track E. **Phase 5 (live-bot spasms) is cut** —
its twitch is folded into the death sequence instead, see track E. Phase 7 (per-bot material feedback)
stays deferred behind the bot-material migration and is not scheduled here.

## Line references

All references are to the **v3** file. The source plans were written against v2 and their line
numbers have drifted by roughly +500 to +900. Current anchors:

| Symbol | v3 line |
|---|---|
| `disposeBotActor` | 2632 |
| `combatCapsuleFor` | 2700 |
| `cullDeadBots` | 3398 |
| `killCombatBot` | 5370 |
| `emitBotDamaged` | 6247 |
| `applyBotDamage` | 6324 |
| `applyCombatDamage` | 6363 |
| `reviveCombatBot` | 10284 |
| `detonateBlast` | 11156 |
| `fireBotShot` | 11203 |
| `EFFECT_LIST_CAP = 900` | 11297 |
| `pushEffect` | 11341 |
| `updateEffects` | 11358 |
| `refineWoundHit` | 11476 |
| `spawnHitBloodFx` | 11508 |
| `botCorpseCap = 24` | 1184 |

## What already exists that shrinks these plans

- **The part-resolving ray is already wired.** `refineWoundHit` (11476) calls
  `resolveBodyHit({THREE, body, origin, dir, refresh:true})` on every landed hit and gets back
  `{partIndex, part, role, point, normal, localPoint, localNormal, crossSection, attach}`.
  `spawnHitBloodFx` uses `point`/`normal`/`attach`/`crossSection` and **throws `part` away.** Idea 2's
  Phase 0 is therefore mostly done — what is missing is limb identity and a path off the FX function.
- **`classForActor` already reads a per-actor override** (`bot-damage-class.js:68`:
  `actor?.damageClass || actor?.entity?.damageClass`). Nothing assigns it. Idea 4's stated blocker
  ("no per-bot class signal exists") is now one assignment plus a UI control, not a subsystem.
- **The decal budget is a live slider**, not a constant: `botDecalBudget` (default 512) drives
  `effectRenderer.setBloodDecalCap`, with drop counters and high-water marks behind
  `effectRenderer.stats()`. Sizing decisions below can be measured instead of asserted.
- **`disposeBotActor` (2632) is the single corpse teardown hook**, already used to release forensics
  slots. Pools and fires hang off it.

---

# Track A — limb loss

## A0. Part identity, and a hit path that survives the FX toggles — **SHIPPED 2026-08-08**

Built as described, with two findings worth carrying forward:

- **Gear is a hit target and had to be mapped.** A helmet is the outermost head geometry, so most head
  hits strike the helmet part, not the head part. Without gear inheritance every headshot would have
  resolved to "unknown limb" — which would have quietly broken E2's headshot weighting. Gear resolves
  by walking parent links, because `gearHosts` uses internal side naming and name-matching would
  reintroduce the mirror bug.
- **Blast damage never reaches `emitBotDamaged`.** It goes straight to `recordBotDamage`, so blast
  limb identity reaches the FX and not the bus. Pre-existing, left alone: routing blasts through the
  bus would start firing the damage-audio listener for explosions.

Details in `docs/subsystems/bots.md`. Original design follows.

**Problem to fix first:** the only call to `refineWoundHit` sits inside `spawnHitBloodFx`, which
returns early when `botBloodFxEnabled` is false and only re-traces when `botWoundHitMode === 'mesh'`.
Severing a limb must not depend on whether blood is switched on.

1. New pure module `bot-limb-map.js`:
   - `buildLimbMap(body)` → a `Map` keyed by part object reference, valued
     `{limb: 'leftArm'|'rightArm'|'leftLeg'|'rightLeg'|'head'|'core', segment: 'upper'|'lower'|'hand'|'foot'|…}`.
     Built by walking `body.parts.core/arms/legs` (`player-procedural-body.js:1932-1938`), which uses
     **visual** side naming — do not read `arms.left` off the internal rig, it is mirrored.
   - `limbForPart(map, part)` → the entry or `null`.
   - Built once per body and cached on the body object; part identity never changes, only visibility.
   - Note the caveat from `bot-body-hit.js:78`: `_role` is a *material* role (shell/plate/trim), not
     anatomy. Identity comes from which named slot the part is, never from the role string.
2. Hoist the re-trace. `refineWoundHit` moves to the top of the damage path and its result is passed
   down to `spawnHitBloodFx` instead of being computed inside it. The three damage call sites
   (`applyBotDamage` 6324, the dummy branch in `applyCombatDamage` 6363, the `detonateBlast` loop
   11156) resolve `bodyHit` once and share it.
3. Add `bodyHit` and the resolved `limb` id to `emitBotDamaged`'s payload (6247). Nothing consumes
   it yet. `bot-damage-audio.js` already subscribes to this bus and is the proof it is a safe seam.
4. Blast damage has no ray. Score the nearest limb radially instead: reuse `nearestJoint`
   (`ragdoll-body.js:66`), which already routes blast impulse to a joint, and map that joint to a limb
   through the same map.

**Test:** `test-bot-limb-map.mjs` — a known rig pose, a shot from a known origin/dir, asserting the
expected limb id; plus every part in `parts.all` resolving to exactly one limb (no part unmapped, no
part claimed twice).

**Accuracy check to run in the same test, not skip:** `resolveBodyHit`'s own header admits the body
is "mostly lathe surfaces … the box is an approximation". A box overhang that mis-severs a forearm is
a much worse failure than a slightly misplaced decal. Assert the resolved limb against a grid of
sample rays before anything downstream trusts it for dismemberment.

## A1. Sever: visuals only, no AI change

1. `WOUND_DEFAULTS` table in a new `bot-wound.js` (descriptor pattern, no id branching — the shape
   `bot-roles.js` and `bot-damage-class.js` both use):
   ```
   headLethal: true, bothLegsLethal: true, maxSurvivableLimbs: 1,
   legLossSpeedFactor: 0.5, armLossSpreadScale: 2.2, armLossTurnScale: 0.8,
   severThresholdBullet: 55, severThresholdBlast: 0.6,
   ```
   Keyed by **damage class**, so `robot` can shed limbs at a different threshold than `human` without
   a branch — the composition idea 3's plan asked for.
2. Sever = set `.visible = false` on the limb's parts. `flush()` (`player-procedural-body.js:1871`)
   already skips invisible parts, and `resolveBodyHit`/`attachFromPoint` skip them too, so the part
   leaves both rendering and hit-testing for free. Leave the proximal joint (shoulder/hip) visible as
   the stump cap.
3. Per-body `amputated` flags, read as an early-continue at the top of the per-side leg and arm loops
   in `update()` so the FABRIK solve is skipped for a limb with no endpoint. This is a cost
   *reduction*, not an addition.
4. **The one piece that needs real care:** body pitch/height is derived from foot averages. A missing
   leg's foot must still resolve to *something* sane (freeze it at the hip socket) or the torso will
   tilt wrong. Verify this in v3 before assuming the original app's behaviour transfers.
5. Stump FX: a gore burst plus a `blood_stain` with `attach` pinned to the **proximal remaining**
   part. Reuses the attach machinery shipped for problem 1; no new decal system.
6. Record `actor.wound = {leftArm:true, …}` and ride it on `toWirePose` (`bot-entity.js:150-178`) as an
   optional, only-emitted-when-set field, exactly like `crouch`/`prone`/`deathImpulse`. Host-authoritative:
   the host decides, guests render.
7. Default **off** behind a panel toggle, like every other FX feature in this file.

**Verify:** the pure parts are Node-testable; the pose result is a browser look-check.

## A2. `bot-wound.js` — the gameplay consequence

Pure module, mirroring `bot-stance.js` exactly (which exists precisely because posture must not
become an FSM axis):

- `woundSpeedFactor(wound, cfg)` — multiplies alongside `stanceSpeedFactor` at the movement call site.
- `woundSpreadScale(wound, cfg)` — multiplies alongside `stanceSpreadScale` at its three call sites.
- `woundTurnRateScale(wound, cfg)` — alongside `stanceTurnRateScale`.
- Losing the firing-side arm forces a sidearm draw through `bot-roles.js`'s existing `sidearm` /
  `swapOnDryMag` fields rather than a new branch. If there is no sidearm the bot cannot fire and
  falls back to its existing flee/retreat behaviour.

**Do not touch `bot-state-code.js`.** Its latch slot is at 5/5 bits and 9 core slots are already
enumerated. Wound rides the per-frame trace row (`pushBotEvent`) the way `hpBefore01`/`fatal` already
ride `emitBotDamaged`, so it stays greppable in a trace without touching the state budget.

**Test:** `test-bot-wound.mjs`, table-driven per stance × wound combination, structured like
`test-bot-stance.mjs`.

## A3. Lethality

`maxSurvivableLimbs` / `bothLegsLethal` / head-is-lethal routed into the existing `killCombatBot`
path. Per-weapon `severChance` override following `weapon.knockback`'s optional-field pattern, so an
RPG severs more readily than a pistol with no `if (weapon.id === 'rpg')` anywhere.

**Test:** extend the existing kill-crediting tests; assert the table produces the documented
thresholds.

## A4. Head loss — blocked, but now measurable

**What exists (verified in v3, 2026-08-08):** a hit-volume debug overlay and a console report, both
built since the LOS plan was written. `updateAllBotHitVolumeDebug` (6926) draws the hittable capsule
in green against the *rendered* head in magenta, with an amber ring on the capsule's true top plane —
and the comment is explicit that it is built from the same descriptor `resolveHitscan` is handed, "so
the overlay is the hit volume by construction." `reportBotHitVolume()` (6955, also on `window`)
prints the numbers, including a `headAboveHitVolume` field that exists precisely to measure this gap.

**What does not exist:** the head volume itself. `combatCapsuleFor` (2700) and its scratch twin
`projCapsuleInto` (11582) both still return one capsule derived from `entity.capsule` — no head
sphere, no primitive id. Bots spawn with `standHeight: 1.8` (2568), so the hit volume still stops at
1.80 m while the head is rendered above it.

So the instrumentation shipped and the fix did not. **Run `reportBotHitVolume()` on a live bot before
building anything that depends on head hits** — it answers this exactly, off a real rig, instead of
off a number in a plan document.

One nuance the old framing got wrong: headshots are not strictly impossible. The head's *bottom* sits
just under the 1.80 m cap, so a shot through that thin band does hit the capsule, and A0's rig
re-trace then correctly names the head part. It is a sliver, not a target — near enough to never that
nothing should be designed around it, but "cannot happen" was too strong.

Ship arms and legs without head loss. Do not hack a temporary head volume into this feature; a
capsule raised to wrap the head also wraps a wide column of air around it, which is the trap the
height-aware-LOS plan documents and the reason it wants a separate primitive.

## A5. Detached limb prop — deferred

A severed limb that falls and ragdolls on its own has no analog in the codebase. Stump plus gore
burst first; revisit only if the browser look-check says it reads as insufficient.

---

# Track B — blood pools and robot fire

## B0. Per-bot damage class (idea 3 Phase 3 — the prerequisite for B and E both)

`classForActor` already prefers `actor.damageClass`. What is missing is that anything writes it.

1. Assign `actor.damageClass` at bot spawn, defaulting to whatever `classForActor(null, getBotBodyKind())`
   resolves today, so behaviour is unchanged on day one.
2. A `boolIsRobot(actor)`-style single lookup point used by every routing decision in this track, so
   swapping the source later is a one-function edit.
3. Panel control for a mixed roster (per-squad or per-team assignment — see open decisions).

Geometry stays global (`bot-body-design.js`'s `_bodyKind`). A mixed *damage-language* fight is
reachable now; a mixed *geometry* fight is not, and this track does not need it.

## B1. Pool data model — pure, no rendering

**The model is dwell time, not one blob per corpse.** A body deposits blood wherever it comes to
rest, and the mark grows at a rate for as long as it stays there. Move the body — thrash, recoil, a
slope it slides down — and it starts a new mark at the new spot while the old one stops growing and
stays. That gives a corpse that got dragged around a *trail of marks*, largest where it lay longest,
which is a truer read than one blob at the coordinate where it happened to die.

New `blood-pools.js`, THREE-free like `bot-medic.js`:

- **Deposits, not pools.** Each is `{x, z, normal, seededAt, dwellMs, radius, alpha, frozen}`.
- **One active deposit per bleeding body.** It accumulates while the body stays within a threshold
  distance of the deposit centre. Cross that distance and the active deposit freezes and a new one
  seeds at the new position.
- **Growth is a function of dwell time**, saturating at a per-body-size cap so a corpse that lies
  still all session does not grow without bound. Rate scales with bleed intensity, so track D's
  intensity curve drives it — the same number that decides drips versus a stream decides how fast the
  ground soaks.
- **Bounded per body: a ring of at most `marksPerBody` deposits.** A body that gets shoved around
  repeatedly recycles its oldest mark rather than accumulating unbounded ones. This is what keeps the
  budget a number instead of a function of how much a corpse gets kicked.
- `onCorpseRemoved(id)` frees every deposit that body owns.
- The merge-lap approximation, unchanged: when two deposit centres land within a body width, cap the
  later one's growth so it laps the earlier one's edge instead of drawing a second full blob on top.
  True merging needs compositing that does not exist here — explicitly v2.

This generalises for free. A *living* bleeding bot is the same mechanism with a shorter dwell
threshold: it walks, so it seeds constantly and each mark stays small — which is exactly the blood
trail track D wants, with no second system.

**Test:** `test-blood-pools.mjs` — growth monotonic in dwell time and saturating at the cap; a move
past the threshold freezes the old deposit and seeds a new one; the per-body ring recycles rather than
grows; slope-gate skip; eviction on removal; global cap respected.

## B2. Pool rendering

- A **separate** instanced decal pool, not the 512-cap wound pool. Three reasons: a firefight's
  transient spray must never evict a pool; deposits are keyed by body identity rather than aged; and
  the budget has to be legible on its own instead of being a function of fight intensity.
- **Sized `botCorpseCap × marksPerBody`**, not one slot per corpse. At 24 corpses and 4 marks each
  that is 96 instances — at the pool's measured 52 bytes per instance, 5 KB. Memory is not the
  constraint; the cap exists to bound draw-instance growth over a long session, and it should be a
  slider for the same reason the wound budget became one.
- Track its own usage the way the wound pool now does — used, dropped, and high-water marks — so
  `marksPerBody` is chosen from a measurement instead of a guess.
- Orient the quad to `terrainField.normalAt(x,z)` rather than hardcoding `[0,1,0]` — flat is fine for
  an 8 s splat, wrong for something meant to look soaked into a hillside.
- Place with `decalY(x, z, lift)`, the helper every ground marker already uses.
- Above `terrainSettings.maxSlope` (the same constant nav already respects) skip pool growth and fall
  back to ordinary splatter. Pools are flat-to-moderate ground only in v1; this is not a flow model.
- Hook `onCorpseRemoved` into `disposeBotActor` (2632) beside the forensics release.
- **Projected mode (Mode C) does not get pools in v1.** It rebuilds from `botEffects` every frame and
  pools live outside that list. Document the gap rather than half-supporting it.

## B3. Fire — ignition and particles only

- New `fire` effect kind in `entity-types/effect.js`. Remember `serialize()` is a hard per-kind
  whitelist: a field missing from the new branch silently never reaches guests.
- Ignition is a probability roll at `killCombatBot` (5370) weighted by `credit.cause`
  (`bullet` | `knife` | `blast`), gated on damage class through B0's single lookup.
- Particles reuse the existing `GLOW_POOL` (220) and `SMOKE_POOL` (260) — a burning bot is warm glow
  sprites plus rising smoke, which is what `drawExplosion`'s ember and smoke layers already are.
  Anchored via the same `attach` handle blood stains use.
- **No real `PointLight` in v1.** `DYN_LIGHT_COUNT` is 2 and is architected for momentary flashes
  competing brightest-nearest per frame. A 15-second burn either squats a slot and starves every
  muzzle flash nearby, or loses every contest and lights nothing. Sell it with additive sprite
  brightness and bloom. Revisit only after a look-check says it is too dim.
- Burn for tens of seconds, then degrade to a **cheap smolder**: no glow sprites, no sustained audio,
  one slow smoke puff every second or two. Same philosophy as the flash budget — degrade to a cheap
  approximation rather than vanishing or costing full price forever.
- **No spread** in v1. Fire spreading needs a per-frame spatial query that no system here does.

**Test:** `test-fire-ignition.mjs` — ignition probability by cause, closest-N-wins cap enforcement,
smolder transition timing.

## B4. Fire audio

`sweepBurning(now)` in `bot-damage-audio.js`, modelled directly on `sweepWounded` (score by distance,
keep the closest N, `budget.reserveOrPreempt(..., {sustained:true})`).

New `maxFireCrackles` in `sound-params.js`, capped at **2**, and the existing
`maxSirens + maxDamageLoops <= loopCap` validator extended to include it.
Current headroom is exactly 3 (`loopCap` 8, sirens 3, damage loops 2), so 2 fits with 1 to spare.
Reuse `AUDIO_PRIORITY.damageLoop` rather than inventing a tier until there is a reason.

## B5. Scorch material — optional, highest risk

`materials/damage-overheat.js` already builds the right skin (`damage` → `1 - hp01`, `heat` → burning)
but **nothing in this codebase has ever applied a `materials/*` output to a bot shell.** The cost is
the plumbing, not the material — and per-role shared `InstancedMesh`es are the same blocker that
stalled per-bot material glow. Scoped last and optional so B1–B4 ship value without it.

## B6. Scorch mark on extinguish

Reuse B1's allocator with a dark texture so a burned-out corpse leaves a mark. Nearly free once pools
exist, and it is what makes fire read as aftermath rather than a timer.

---

# Track E — audio routing and haywire death

Idea 3's unshipped half. E1 is worth doing on its own merit; E2 only pays off once B0 makes a robot
reachable, so it sits after it.

**Idea 3 Phase 5 (live-bot spasms) is cut.** It was written as a low-health twitch on a *living*
bot, which is weakly motivated: full-rig jitter fights the IK and locomotion actively posing the bot,
and an unexplained twitch reads as a rendering bug rather than as damage. The twitch survives as the
settling phase of the death sequence in E2, where the ragdoll already owns the pose and nothing
fights it.

## E1. Audio class routing (idea 3 Phase 2)

**The gap is real and currently invisible:** `bot-damage-audio.js` gives *every* bot synthesized
struck-metal audio regardless of body kind. The flesh sample path exists, but only the practice dummy
reaches it. So today the visuals are all blood and the audio is all metal — a human soldier bleeds
and rings like a hull.

`bot-damage-class.js` already carries the answer: `hitAudio` and `deathAudio`, both `'flesh' | 'metal'`,
on every row. Nothing reads them.

1. Route `class.hitAudio` at `bot-damage-audio.js`'s `onBotDamaged` subscription and
   `class.deathAudio` at `onBotDied`.
2. `armouredHuman` is deliberately `hitAudio: 'metal'`, `deathAudio: 'flesh'` — plate rings when
   struck, the person inside dies. That asymmetry is the reason these are two fields and not one.
3. Extend `test-bot-damage-audio.mjs`'s existing pure-logic coverage with a class parameter.

No new samples, no new banks, no budget change — this is a selector on paths that both already exist.

## E2. Haywire death (idea 3 Phase 6, expanded)

Haywire is a **flavour of the existing death**, not a new state. `killCombatBot`'s ragdoll branch
already seeds impulses and already fires `emitBotDied`, which drives squad call-outs, the danger field
and the audio hook. Haywire is a short scripted sequence layered on top of that.

### The sequence

Three phases, in order, all after death:

1. **Thrash.** A randomised impulse on the ragdoll's joints — a parameter on the existing
   `applyDeathImpulse` call, not a new system. Violent, short, roughly the first second.
2. **Twitch.** The salvaged half of the cut spasm phase: decaying jitter as the body settles, seeded
   off `(botId, frame)` with the same `hash01` determinism the effect renderer uses, so host and guest
   twitch identically without networking anything. This is where a twitch actually belongs — the
   ragdoll owns the pose, so there is nothing for the jitter to fight.
3. **Settle.** Normal ragdoll rest.

Throughout: an extra spark and smoke burst reusing `hit_spark` and `smoke_puff` (no new effect kind),
and `class.deathAudio` selecting the bank through E1's routing.

### Wild firing during the thrash

A haywire bot can discharge its weapon while thrashing — the tell that makes haywire a hazard rather
than a light show.

- Shots come from the **existing** shot-spawn path with a direction taken from the ragdoll's current
  weapon-hand orientation, so they go wherever the thrash happens to be pointing. Not aimed at
  anything, and deliberately not routed through the FSM or the aim pipeline.
- The corpse is not a combatant. It has no state, no target, no think pass — it is a scripted emitter
  that happens to spawn tracers. The dead-state collapse rule keeps the encoder out of it entirely.
- Rounds actually hurt whoever they hit, including the dead bot's own squad. **The kill is credited to
  the dead bot: −1 for a teammate, +1 for an enemy.** So a haywire corpse can lose its own team points
  by spraying its squad, or steal a kill it did not aim for. `bot-score.js` already owns scoring; this
  is a credit target, not a new scoring axis.
- The corpse moves, and that is a feature. Thrash and recoil push the ragdoll off the spot where the
  bot died, and B1's deposit model turns that into a **trail** — a mark wherever it came to rest,
  sized by how long it stayed there. A haywire death writes its own path across the floor.
- Bounded hard: a few shots over a fixed window, capped per corpse, and off by default until it has
  been watched in play.

### Hit location decides the odds

Haywire probability is weighted by **where the killing shot landed**, not just by damage class. Track
A0's limb map is what makes this possible — it is the same resolved part, read at the kill instead of
at the hit.

- A head hit is the most likely trigger. Damage to the thing doing the thinking is the whole fiction.
- Torso and limb hits are progressively less likely.
- A blast has no ray; it uses A0's radial nearest-limb fallback.
- Expressed as a weight per limb in the `WOUND_DEFAULTS`-style table, keyed by damage class, so a
  fourth class or a per-weapon override drops in without a branch.

**Head weighting barely fires until the head is hittable.** The hit volume still stops at 1.80 m
(A4). The head's bottom edge sits just below that, so head hits are *possible* through a thin band and
A0's rig trace does name them correctly — but they are far too rare to carry the feature. The table
carries the head weight from day one and haywire gets its best trigger for free the moment a head
primitive lands. **Run `reportBotHitVolume()` before assuming either way**; it prints the real
overhang off a live rig.

### What it does not touch

The `'dead-collapses'` rule already freezes every other slot the instant the state is `D`. Haywire is
invisible to `bot-state-code.js` by construction — including the wild firing, because a corpse
emitting shots never enters a state.

**Test:** trigger weighting by limb and class; the shot cap holds; and a standing regression asserting
`STATE_CHARS.length` and `LATCH_MASK` are unchanged, so haywire can never quietly grow the state space.

---

# Track C — splatter from the spray's own trajectory

The current behaviour is documented as intentional in `entity-types/effect.js:38-40`: splatter is
"not literally the same droplets (independent `id`, independent RNG stream), just the same physics."
That is exactly the complaint. The droplets you watch fly are not the marks you see land.

Both functions live in `effect-renderer.js`: `drawBloodSpray` (612) scatters with hash offsets
`k*5+1..4`; `drawBloodSplatter` (686) scatters with `k*7+71..76`. Same formula, different stream.

1. **Share the stream.** Give the splatter effect the spray's id (a new `sprayId` wire field, added to
   the `blood_splatter` serialize branch) and use the spray's `k*5+…` offsets, so droplet *k* on the
   ground is the landing point of droplet *k* in the air. `count` must be ≤ the spray's count; the
   splatter then picks the first N droplets rather than inventing its own.
2. **Orient the mark to the impact, not to a random spin.** A droplet arrives with a known horizontal
   velocity `(dx, dz) * sp`; the decal's roll should come from `atan2(dz, dx)` instead of
   `hash01(e.id, k*7+75)`.
3. **Elongate by obliqueness.** A steep arrival is a round dot; a shallow one is a streak. `pushBlood`
   currently scales `tan` and `bit` by one scalar `size` (374-393); add an optional `stretch` so the
   along-velocity axis scales by `size * stretch` and the cross axis by `size`. `stretch` derives from
   the ratio of horizontal to vertical landing speed, clamped.
4. Keep `wound = 0` — these are still droplets, not punctures.

**Test:** extend `test-effect-renderer.mjs` — assert that for a matched spray/splatter pair, droplet
*k*'s landing XZ equals the spray's own ballistic solution for droplet *k*; assert stretch is 1 for a
vertical arrival and grows monotonically as arrival flattens.

**Risk to state honestly:** this couples two effects that are currently independent. If the spray is
suppressed (low intensity gives `sprayCount = 0` at high health) the splatter has no parent stream.
Handle it by falling back to today's independent scatter when there is no `sprayId`, rather than
emitting nothing.

---

# Track D — bleedout over time

The intent: a wounded bot keeps bleeding after the hit — drips at low intensity, a stream at high —
rather than one burst and done. This was explicitly deferred out of idea 1 as "true crawling drip".

1. **A bleed source per wound, not per frame.** A wound registers on the actor with an intensity and
   a decay; a per-actor timer emits a small `blood_spray` (1-3 droplets) plus a small
   `blood_splatter` at intervals scaled by intensity. Reuse `bloodIntensityForHealth` as the
   intensity curve — it already maps hp to droplet count, speed and spread, and already agrees with
   the per-hit look.
2. **Rate-limit at the source, not the pool.** `EFFECT_LIST_CAP` is 900 and shared by tracers, sparks
   and blast layers. A bleeding bot must emit on a cadence (say every 0.4-1.2 s by intensity), not
   every frame, or a firefight's bleeders will evict combat FX. Cap the number of *simultaneously
   bleeding* bots the same closest-N way `sweepWounded` caps audio.
3. **Gate on damage class.** `shouldShowBlood` already answers this; a robot must not drip.
4. **The ground half is already B1.** A bleeding bot is a body with a dwell-time deposit under it —
   the same model, with a shorter move threshold, so a walking bot seeds constantly and each mark
   stays small. That is a blood trail, and it costs nothing extra because B1 already has to handle a
   body that moves. Track D owns the airborne half (drips and spray cadence) and the bleed intensity;
   B1 owns everything that touches the ground. This is why D is sequenced after B.
5. Stop on death — the body keeps depositing, but as a corpse rather than a bleeder — and on heal
   above the class's blood threshold, except that `armourBreached` is a one-way latch and stays
   latched.

**Test:** `test-bot-bleed.mjs` — cadence by intensity, cap enforcement, class gating, stop conditions.

---

# Shared budget ledger

Every track pulls from the same ceilings. Numbers as they stand in v3:

| Resource | Ceiling | Claimed by | Note |
|---|---|---|---|
| Wound decal pool | `botDecalBudget`, default 512, **live slider** | stains + splatter (one draw) | drop counters and high-water marks already exposed via `effectRenderer.stats()`; track C raises per-hit decal count slightly, track D raises it over time |
| Projected pool (Mode C) | 256 | stains only | no pools, no fire in v1 |
| New pool decals | `botCorpseCap × marksPerBody`, ~96 at 24×4 | track B | separate pool, own slider and usage counters; a body owns a bounded ring of marks and corpse culling frees all of them |
| `GLOW_POOL` | 220 | explosions, muzzle flash, **fire** | ~24 slots for 6 simultaneous full-VFX fires |
| `SMOKE_POOL` | 260 | blast wisps, robot smoke, **fire** | ~12 slots plus smoulder puffs |
| `DYN_LIGHT_COUNT` | 2 | muzzle/blast flashes | **fire claims zero** |
| Sustained audio | `loopCap` 8, 5 claimed | sirens, damage beds, **fire** | 2 for fire, 1 spare |
| `botEffects` | `EFFECT_LIST_CAP` 900 | everything | track D is the one that can flood it; rate-limit at the source |

Every deposit and every fire is owned by exactly one bot id and freed at `disposeBotActor`. Within a
body, its own mark ring recycles. No global LRU, no second bookkeeping path.

---

# Sequence

```
A0  part identity + hit path off the FX toggles     ← everything else depends on this
A1  sever visuals
A2  bot-wound.js gameplay effects
A3  lethality
        A4 head loss  — blocked on the height-aware-LOS plan's Phase 3
        A5 detached limb prop — deferred
B0  per-bot damage class                            ← small; unblocks all of B
B1  pool data model
B2  pool rendering
B3  fire ignition + particles
B4  fire audio
        B5 scorch material — optional, may stall
        B6 scorch mark on extinguish
E2  haywire death                                   ← needs B0 for a robot, A0 for hit-location odds
C   splatter from the spray's trajectory            ← independent of everything; can jump the queue
D   bleedout over time                              ← after B1, so it feeds pool growth

E1  audio class routing                             ← independent; do it whenever
```

Two pieces depend on nothing else here and can ship on their own if the queue stalls: **track C**
(only `effect-renderer.js` and `entity-types/effect.js`) and **E1** (only `bot-damage-audio.js`).
E1 in particular fixes a bug that is audible on every single hit — humans currently sound like hulls.

# Decisions taken (not questions)

- Two legs gone is **lethal** in v1. A crawl state is a much larger animation ask than the FX it buys.
- Head loss is **always fatal** — no headless-but-alive FSM.
- Losing the firing arm **forces a sidearm draw**, and failing that the bot cannot fire.
- Fire gets **no dynamic light** until a look-check says the sprite glow is too dim.
- Fire reuses `AUDIO_PRIORITY.damageLoop` rather than getting its own tier.
- A burned-out fire **leaves a scorch mark** (B6), reusing the pool allocator.
- Bleeding-while-alive pools exist, but arrive through track D's bleed event rather than doubling
  B1's state machine.
- **Live-bot spasms are cut.** The twitch happens after the death thrash, where the ragdoll owns the
  pose. A twitch on a live bot fights the IK and reads as a rendering bug.
- Haywire is a scripted post-death sequence, so it **never touches `bot-state-code.js`** — including
  the wild firing, because a corpse emitting shots never enters a state.
- Haywire odds are weighted by where the killing shot landed. The head weight ships carried but
  rarely triggered, and comes alive on its own once a head primitive lands.
- A haywire kill is credited to the dead bot: −1 for a teammate, +1 for an enemy.
- Blood pools are **dwell-time deposits**, not one blob per corpse. A body that moves leaves a trail,
  each mark sized by how long it lay there. This is also what gives track D its blood trail for free.
- Idea 3 Phase 7 (per-bot glowing cracks and scorch) stays deferred. It needs the
  `body-part-batches.js` per-instance-attribute migration, which is the same blocker as B5.

# Open decisions that need you

1. **How is damage class assigned in a mixed fight** — per bot at spawn (a mix ratio slider), per
   squad, or per team? Per team is the most legible in play; per bot is the most flexible for testing.
2. **Is `robot` a Mark VII re-skin or new art?** The class row exists and is unreachable until
   something can look like a robot. A re-skin (emissive tint plus the scorch material) is cheap; new
   geometry is its own project.
3. **Where do you want the two self-contained pieces?** Track C and E1 depend on nothing and each fix
   something present on every hit — one visible, one audible. Both are reasonable to do first rather
   than last.
4. **Has the head volume actually landed since this was written?** The debug overlay and
   `reportBotHitVolume()` both exist, but `combatCapsuleFor` still returns one capsule and bots still
   spawn at `standHeight: 1.8`. If a head primitive is in flight elsewhere, A4 and E2's head weighting
   both change from "carried but rarely fires" to "live" — worth knowing before either is built.
