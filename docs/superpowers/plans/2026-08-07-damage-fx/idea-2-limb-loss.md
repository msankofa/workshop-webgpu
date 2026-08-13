# Idea 2: limb loss from headshots and grenades

**The idea:** a sufficiently violent hit severs a limb or head. A bot that survives keeps fighting
as WOUNDED — visibly missing a part and mechanically worse (slower, wider spread, maybe one-handed)
— not just a palette swap. Enough limbs gone, or the head gone, is fatal outright.

**The hardest problem:** not the visual removal (that's a one-line `.visible = false`, already the
mechanism `bot-body-hit.js` uses to exclude a part from hit-testing) and not the AI penalty (the
stance module already proves the "orthogonal derived channel" pattern). It's **identifying that a
specific limb, not just "the bot," was hit hard enough** — combat hitscan today tests one whole-bot
capsule and has no idea which part it struck, and the one module that *can* answer that question is
completely unwired from combat.

**Recommendation:** worth building, but only after `2026-08-06-height-aware-los-plan.md` Phase 3
lands (headshots aren't identifiable at all until then), and only if `bot-body-hit.js` gets wired
into combat as its own phase first — that wiring is valuable on its own (accurate blood decals) even
if limb loss never ships. Scope the AI/lethality side tight: this repo's own state-code budget
(§3.4) is nearly saturated, so "wounded" has to stay a side-channel, not a new FSM axis.

---

## 1. What exists today

### Combat and hit detection
- **One capsule per bot, no part info.** `fireBotShot` (`bot-viewer-v2.html:10466`) calls
  `resolveHitscan` (`combat.js:172`) with `players: [combatCapsuleFor(botTarget)]`.
  `combatCapsuleFor` (`bot-viewer-v2.html:2358`) returns `{id, p:[mid], r:0.3, h:1.2}` — a single
  vertical capsule, no head, no limbs. `capsuleHit` inside `resolveHitscan` (`combat.js:185-196`)
  calls `rayCapsuleHit`, which only ever returns a world point and a horizontal outward normal
  (confirmed again in `damage-simulator.html:315-319`'s comment: "a capsule hit can never carry a
  body normal"). **The shot literally cannot know which limb it hit.**
- **`bot-body-hit.js` already solves this and is unwired.** `resolveBodyHit({THREE, body, origin,
  dir})` (`bot-body-hit.js:129`) ray/AABB-tests every part in `body.parts.all` and returns
  `{partIndex, part, role, point, normal, localPoint, localNormal, crossSection, attach}`. Its only
  callers are `damage-simulator.html:323` and `:330` (`attachFromPoint`, for a hit point that's
  already exact and just needs a part to pin to). Header comment (`bot-body-hit.js:9-14`, `:78`)
  is explicit about the caveat that matters most for this idea: `_role` is a **material** role
  (shell/plate/trim/…), shared by several parts — it is NOT a semantic "left forearm" identity.
  Semantic limb identity has to come from *which named part* (`leg.upper`/`leg.lower`/`arm.upper`
  etc.) was hit, not from its role string.
- **Damage is flat.** Grep across `bot-viewer-v2.html` for a headshot multiplier or per-part scale
  turns up nothing; `applyBotDamage` (`:5831`) and `detonateBlast` (`:10424`) both apply
  `weapon.damage` (or `blastDamageFor`) uniformly. `damage-simulator.html:302`'s `PART_SCALE = {
  head: 1.5, torso: 1.15, arm: 0.85, leg: 0.85 }` exists only in the standalone harness, not combat.
- **The head is currently unhittable.** Per the shared context: hit capsule 0→1.80 m, rendered head
  1.786→2.020 m (2.053 m with the Mark VII crest). Confirmed again here by grep — nothing in
  `combat.js` or `combatCapsuleFor` adds a head primitive. This is fully blocking for "headshot
  severs the head" until Phase 3 of the LOS plan ships.

### The rig: parts, not a mesh
- `player-procedural-body.js:950-992` builds `legs = {left: makeLeg(), right: makeLeg()}` and
  `arms = {left: makeArm(), right: makeArm()}`. Each leg is
  `{chain, upper, lower, hip, knee, ankle, foot}`; each arm is
  `{chain, upper, lower, shoulder, elbow, wrist, hand, target}` — six to seven independently
  addressable `Object3D` placeholders per limb, all created via `makePart` (`:736`).
- In instanced mode (`instanced = !!batches`, `:586`) a "part" is a transform-only `Object3D`
  carrying `.geometry` and `._role` (`:736-739`), pushed into `_instanceParts` (flat list, exposed
  as `parts.all` at `:2029`) — **this is exactly the list `bot-body-hit.js` walks.**
- `parts` (`:2024-2030`) exposes `arms`/`legs` under **visual** side naming (internal sides are
  mirrored — `setArmTarget`, `:1922-1926`, swaps for the same reason). Any code that turns "left arm
  severed" into actual part objects must go through this mapping, not the internal `arms.left`.
- **`.visible` already does double duty.** `flush()` (`:1957-1966`) — the per-frame call that
  pushes every part's world matrix into the shared `InstancedMesh` buckets — skips invisible parts
  outright: `if (!part.visible) continue;` (`:1963`). And `resolveBodyHit`/`attachFromPoint`
  (`bot-body-hit.js:138`, `:170`) both skip invisible parts too: `if (!part.visible) continue;`.
  **Setting `.visible = false` on a limb's parts removes it from rendering AND from any future
  part-hit test, for free, with code that already exists for other reasons.**
- **Legs and arms are cosmetic IK, not physical support.** `gait = createGaitScheduler()`
  (`:1228`) drives `gait.feet[side].current` foot targets from capsule velocity
  (`locomotion.update(dt, {speed, feet: gait.feet})`, `:1678`); `solveLeg`/`solveArm`
  (`:1468`, `:1501`) are called unconditionally for both sides every `update()` (`:1825-1843`,
  `:1858-1878`) and just place IK segments toward those targets. The bot's actual movement is the
  capsule physics in `bot-entity.js` (`stepBotPhysics`, `:66`) — a raw `Capsule` translated by
  `velocity * dt` and resolved against `mapCollider`. **The capsule does not know or care how many
  legs are attached.** This is good news: removing a leg cannot break locomotion physics, because
  legs never drove it. The visible consequence of a missing leg is purely a rendering/IK-authoring
  problem (what does the IK solve toward with no foot?), not a physics one.
- **The weapon is not parented to the hand.** `updateBotWeaponMount` (`:1897`) positions the
  `weaponRig` from body position + authored `hold.position/rotation` (`resolveWeaponHold`,
  `:1920`) at `feetY + 1.5 + bob`, entirely independent of `arms[side].hand`'s actual position. The
  arm's `solveArm` target is set separately via `setArmTarget` so the IK hand *chases* the gun; the
  gun does not follow the hand. Losing the gun arm therefore does not break weapon rendering by
  itself — but a bot missing its right arm still visually holds/fires the rifle from the same
  authored offset, which reads as wrong unless something branches on it (open question, §9).

### Ragdoll and blast
- `ragdoll.js` (348 lines, pure, Node-tested) + `ragdoll-body.js` (108 lines) already exist and are
  live: `killCombatBot` (`:4905`) seeds a ragdoll from the live rig
  (`ragdollFromBody`, `ragdoll-body.js:24`) when `ragdollDeathEnabled && botProceduralBodyEnabled`
  (`:4961`).
- `applyDeathImpulse` (`ragdoll-body.js:96-108`) **already concentrates a hit-point-derived impulse
  on the nearest joint plus one-hop neighbors** (`NEIGHBORS`, `:56-63`) — "a headshot snaps the
  head, a leg hit kicks the leg" per its own doc comment. This is reusable almost unchanged for a
  *lethal* limb-loss death (the corpse should still whip appropriately), but it's a death-only path;
  it says nothing about a bot that *survives* losing a limb, which needs a live (non-ragdolled) rig
  missing a part while the bot keeps moving and fighting.
- `detonateBlast` (`:10424`) already does radial falloff damage (`falloff = 1 - d/R`,
  `:10438`) per victim and already calls `beginBotHealthRetreat` on survivors (`:10449`) — the
  "wounded reacts differently" precedent already exists for retreat behavior, just not for
  locomotion/aim penalties.

### The event bus (a clean wiring seam)
- `onBotDamaged`/`onBotDied` (`:5748-5749`) is a listener registry; `emitBotDamaged`
  (`applyBotDamage`, `:5846-5851`) and `emitBotDied` (`killCombatBot`, `:4946`) already fire on
  every hit and death. `botDamageAudio.onDamaged` (`:5782`) is an existing consumer. **A limb-loss
  system can subscribe here instead of editing `applyBotDamage`/`detonateBlast` directly**, keeping
  the wound-onset logic in its own module the way audio already does.

### The stance module — the pattern to copy
- `bot-stance.js` (253 lines, pure, Node-tested, `test-bot-stance.mjs`) is the working precedent
  for "posture as an orthogonal derived channel, not a new FSM state." Its own header
  (`:1-19`) explains why: folding posture into the FSM ladder "would multiply every rung." It
  exposes pure functions — `stanceSpeedFactor`, `stanceSpreadScale`, `stanceTurnRateScale`,
  `stanceHeightScale` — each consulted at the point of use:
  `BOT_MOVE_SPEED * stanceSpeedFactor(...)` (`:7186`), spread at three call sites (`:4474`, `:4770`,
  `:9703`), turn rate at `:7190`. **A `bot-wound.js` module built the same shape, multiplying on top
  of the existing stance multiplier, is the natural home for "wounded" gameplay effects** — see §3.

### The state code — nearly full
- `bot-state-code.js` (448 lines) already packs 9 independent axes into a fixed 9-character code,
  and its own header states the legal-combination count precisely: "Of 43,680,000 raw slot
  products, 395,533 are legal (0.906%)." It is explicitly NOT where posture lives (medic-duty is
  folded into slot 1 by overwrite, not a new slot, per `:22-24`). Adding "wounded" as a 10th core
  slot would multiply that combinatorics again and is exactly the mistake the module's own history
  warns against.

---

## 2. The gap

**(a) Identifying that a specific limb was hit hard enough.** Does not exist. Combat only has a
whole-bot capsule (§1). `bot-body-hit.js` can answer "which part" but is wired to nothing live.
Even once wired, "hard enough" needs a damage/weapon threshold that doesn't exist (damage is flat,
§1).

**(b) Removing it visually.** Nearly free. `part.visible = false` on the limb's parts (§1) does the
render-side removal via the existing `flush()` skip, and — as a side effect — also removes it from
any future `resolveBodyHit` pass, which is desirable (can't dismember an already-gone limb twice).
The remaining work is IK-side: `solveLeg`/`solveArm` (`:1468`, `:1501`) run unconditionally for both
sides every frame (`:1825-1843`, `:1858-1878`) and will keep computing a pose for a limb with no
visible parts — wasted work, not a bug, but it also means the *joint* positions (`leg.hip.position`
etc., still updated) stay physically plausible for anything that reads them (gear anchors, `joints`
picking targets for body-preview tooling). Skipping the solve entirely needs a per-limb "amputated"
flag threaded through `update()`, and a decision about what the stump joint should freeze to.

**(c) The stump/gore.** No dismembered-limb prop exists (a severed forearm that falls and lies on
the ground). `effect-renderer.js`'s `blood_stain` decal already rides a live body-part matrix via
the `attach` handle `bot-body-hit.js:makeAttachment` produces (`fx.md:65-72`, "a `blood_stain` that
carries an `attach` handle is drawn from the live body-part matrix it names") — that's the reuse
seam for a wound decal at the stump, riding the animation. A *physical* severed limb that
detaches and ragdolls independently is new work with no existing analog; scope it out of an MVP (a
gore burst + stump decal, no separate flying limb, is a reasonable v1 — see §6/§7).

**(d) The AI consequence.** No "wounded" condition exists anywhere. `beginBotHealthRetreat`
(`:4994`) is the closest precedent (health-threshold behavior change) but it only sets a retreat
flag, not a movement/aim penalty. `bot-stance.js` is the pattern to extend (§1, §3), not a starting
point with existing wound logic.

---

## 3. Design

### 3.1 Identifying the hit limb (wiring `bot-body-hit.js` into combat)

This is Phase 1 and the load-bearing piece everything else depends on.

`fireBotShot` already resolves a `hitPoint` in world space (`:10520`, from `resolveHitscan`'s
`hit.point`) whether or not the future head-sphere lands. The cheapest correct wiring is **not**
to make `resolveHitscan` itself part-aware (`combat.js` is deliberately dumb/pure and used by
non-bot callers too) — instead, once `resolveHitscan` says `hit.kind === 'player'`, do a **second,
part-scoped resolve** against just that bot's rig, using the same origin/dir:

```js
if (hit.kind === 'player') {
  const target = combatEntityById(hit.id);
  const bodyHit = target?.botActor?.body
    ? resolveBodyHit({ THREE, body: target.botActor.body, origin: fireOrigin, dir })
    : null;
  applyCombatDamage(weapon.damage, hitPoint, target, now, { weaponId, cause: 'bullet', normal: hit.normal, bodyHit });
}
```

One extra ray/AABB walk per confirmed hit only (not per shot fired at nothing), against ~30 parts —
cheap, and it is the harness `damage-simulator.html` already exercises at interactive rates. This
gives `applyBotDamage`/`emitBotDamaged` a `bodyHit.part` (the actual Object3D — `legs.left.lower`,
`arms.right.upper`, etc.) and `bodyHit.role`. Blast damage (`detonateBlast`, `:10424`) has no ray at
all — it already knows the victim capsule center and blast center; a **radial** scoring instead
(nearest limb to the blast-center-to-capsule-center line, or nearest joint via the same
`nearestJoint` helper `ragdoll-body.js:66` already implements for impulse routing) substitutes for a
ray test there.

### 3.2 Limb identity, not material role

`bot-body-hit.js:78`'s own caveat is the crux: `_role` is shell/plate/trim, shared by many parts.
Identity has to come from **which named slot** was hit, derived by comparing `bodyHit.part` against
`body.parts.legs.left.upper`, `.lower`, `.hip`, `.knee`, `.ankle`, `.foot`, and the arm/core
equivalents (`body.parts` already exposes this exact structure, `player-procedural-body.js:2024-2030`).
A small lookup (`part → {limb: 'leftLeg'|'rightArm'|…, segment: 'upper'|'lower'|'hand'|…}`) built
once per body (parts don't change identity, only visibility) is the whole of this — a flat `Map`
keyed by object reference, O(1) per hit.

### 3.3 Severing a limb

Given a limb id (`leftArm`/`rightArm`/`leftLeg`/`rightLeg`/`head`), sever means:
1. Set `.visible = false` on every `Object3D` in that limb's part set (`upper`, `lower`, and its
   terminal joint+extremity — `hand`+`wrist`, `foot`+`ankle`; leave the proximal joint —
   `shoulder`/`hip` — visible as the stump cap, or add a small stump cap part).
2. Stop calling `solveLeg`/`solveArm` for that side; freeze the joint positions at their last pose
   (or snap to a fixed stump offset from the shoulder/hip socket) so nothing chases a target with no
   endpoint. This needs a per-body `amputated = {leftArm: false, ...}` flag read at the top of the
   per-side loops in `update()` (`:1825`, `:1858`) — a one-line early-continue per loop iteration,
   not a restructure.
3. Record the amputation on the bot entity/actor (`actor.wound = {leftArm: true, ...}` or similar)
   so FSM/AI code (§3.4) and the wire protocol (multiplayer — guests need to render the same missing
   limb) can read it. This is new state, follows the existing `bot.crouch01`/`bot.prone01` pattern
   (`toWirePose`, `bot-entity.js:154-157` — optional, only-emitted-when-set fields).
4. Spawn a gore burst + a `blood_stain` decal `attach`ed to the stump part (§2c), reusing
   `effect-renderer.js`'s existing attach machinery — no new decal system needed, just a new spawn
   call at the sever event with `attach: bodyHit.attach` pinned to the *proximal* remaining part
   (shoulder/hip), not the departed one.

### 3.4 "Wounded" as an orthogonal channel (mirrors `bot-stance.js`)

Do **not** add a 10th slot to `bot-state-code.js` (§1's combinatorics warning) and do **not** fold
it into the FSM ladder (same reasoning `bot-stance.js:1-19` gives for posture). Instead, a new
`bot-wound.js`, pure and Node-testable like its sibling:

- `woundSpeedFactor(wound, settings)` — multiplies alongside `stanceSpeedFactor` at `:7186`
  (a bot missing a leg limps: e.g. 0.5×; missing both legs: crawl speed or treat as effectively
  immobile depending on the lethality call in §4).
- `woundSpreadScale(wound, settings)` — multiplies alongside `stanceSpreadScale` (`:4474`, `:4770`,
  `:9703`); missing the off-hand/gun arm should blow this out badly (one-handed aim) — that also
  hooks the "weapon handling" ask directly, since it's the visible tell a bot is fighting
  one-handed.
- `woundTurnRateScale` — mirrors `stanceTurnRateScale` (`:7190`); a missing leg costs pivot speed
  too.
- A gate on `swapOnDryMag`/weapon choice: a bot missing its firing-side arm should be forced to a
  sidearm or unable to fire at all, depending on which arm — this is a natural extension of
  `bot-roles.js`'s existing descriptor pattern (`sidearm`, `swapOnDryMag`, `closeRange` fields,
  `bot-roles.js:35-44`) rather than a branch: e.g. a `oneHandedPenalty` field consulted the same way
  `closeRange` is.
- Debug-overlay/state-trace visibility: **do not** touch `bot-state-code.js`'s core 9 slots; instead
  add wound as a field on the existing per-frame trace row (`pushBotEvent`, `:2604`) the same way
  `hpBefore01`/`hpAfter01`/`fatal` already ride `emitBotDamaged`'s payload (`:5846-5851`) rather than
  the fixed-width code. This keeps the 395,533-legal-state budget untouched, per §1's warning, while
  still making wound state greppable in a trace.

### 3.5 What breaks in the IK/pose loop specifically

Concretely, in `player-procedural-body.js:update()`:
- **Missing leg**: the per-side leg loop (`:1825-1843`) computes `hipAttach` and a foot target
  every iteration regardless of side; with an amputation flag, skip `solveLeg` for that side and
  instead either (a) leave the stump joints static at the hip socket (simplest, reads as "peg leg"),
  or (b) drive a stagger/hop animation — out of scope for an MVP, flag as follow-up. The **pelvis
  height / body orientation** code (`updateBodyOrientation`-equivalent, computed from foot averages
  per the top-level `../CLAUDE.md` doc's description of the *original* app — verify this repo's
  actual equivalent before touching it) may read all four "feet" including a missing one; a missing
  leg's foot position must still resolve to *something* sane (the frozen stump point) or body pitch
  will read wrong. This is the one piece of "IK copes with a missing limb" that needs actual care,
  not just an early-continue.
- **Missing arm**: simpler, because `arm.target` already supports a `weight` of 0 to fall back to
  idle pose (`solveArm`, `:1503-1512`) — the existing weight-blend mechanism nearly does what's
  needed for "don't reach for anything." An amputated arm just skips the call outright and leaves
  the shoulder stump static, same pattern as the leg.
- **Missing head**: `head` is optional already — `if (head) { ... }` throughout `update()`
  (`:1810-1821`, `applyModeVisibility`, `:1558-1569` region) — the rig already tolerates a null
  head in some contexts (though today that's about `mode === 'local-lower-body'`, not amputation).
  Setting `head.visible = false` plus skipping the head-pose block is the smallest version of this
  and should be nearly free to add given the existing null-guard pattern.

---

## 4. Lethality rules (data-driven)

Following the repo's descriptor convention (`bot-roles.js:20-44`, `ROLE_DEFAULTS`/per-role
overrides; `weapons.js`'s per-weapon fields cited throughout `ragdoll-body.js:44-53`), define a
`WOUND_DEFAULTS` table, not branches:

```js
export const WOUND_DEFAULTS = {
  headLethal: true,               // losing the head is always a kill, never "wounded"
  legLossSpeedFactor: 0.5,        // per missing leg, multiplicative
  bothLegsLethal: false,          // false: crawl state; true: instant kill (design call, see open Qs)
  armLossSpreadScale: 2.2,        // per missing arm (one-handed), multiplicative
  maxSurvivableLimbs: 1,          // limbs remaining below this => lethal (e.g. 1 of 4 gone survives, 3 gone dies)
  severThresholdBullet: 55,       // damage-in-one-hit needed to sever via bullet (a headshot multiplier gets there)
  severThresholdBlast: 0.6,       // blast falloff fraction (close-in) needed to sever
};
```

Per-weapon override follows the existing `weapon.knockback` optionality pattern
(`ragdoll-body.js:46-48`, "Respects an explicit `weapon.knockback` if a def sets one, else derives")
— a weapon can carry `weapon.severChance` or inherit the default. This keeps the RPG/grenade
(`bot-grenade.js`, `detonateBlast`) trivially more likely to sever than a pistol without an
`if (weapon.id === 'rpg')` branch anywhere.

**Head loss is always fatal** — simplest rule, matches player expectation, and sidesteps the
question of what a headless-but-alive bot would even do (no eyes to aim with, no obvious FSM
target). **Limb-count lethality** should be a threshold (`maxSurvivableLimbs`), not a hardcoded "2
legs = dead" branch, so it can be tuned per game mode without code changes.

---

## 5. Dependency on the head-sphere work (2026-08-06 plan)

**Hard blocker for the headshot half of this idea.** Today the hit capsule tops out at 1.80 m and
the head runs 1.786–2.020 m (`docs/superpowers/plans/2026-08-06-height-aware-los-plan.md` §1.3) —
**a shot cannot hit the head at all**, so "headshot severs the head" cannot be authored, tested, or
even triggered by accident until that plan's Phase 3 ships (`combatCapsuleFor` gains a
`head: {p, r}` sphere, `capsuleHit` tests it, §Phase 3 of that plan). Everything about limb loss
*below the neck* (arms, legs) has no such dependency — the existing capsule already spans the torso
and the part-hit resolver (§3.1) works today against any body height. **This plan's Phase 1–3
(§7) should ship arm/leg loss first, independent of the LOS plan, and gate head loss behind that
plan's Phase 3 landing.** Do not attempt to hack a temporary head volume into this feature's own
combat wiring — the LOS plan's Phase 3 rationale (§Phase 3 of that plan: "a capsule raised to ~2.05m
wraps a 0.6m-wide column of air around a 0.17m-wide head") is exactly the trap to avoid duplicating.

---

## 6. Cost

- **Per-shot**: one extra `resolveBodyHit` ray/AABB walk (~30 parts) per **confirmed hit only**
  (not per shot fired, since most shots miss or hit terrain/walls) — negligible next to the existing
  raycast-heavy LOS/aim pipeline the height-aware-LOS plan is itself auditing.
- **Per-frame, per wounded bot**: `flush()` already skips invisible parts (`:1963`) — an amputated
  bot **costs less** per frame in the instanced-batch upload, not more. The only added cost is the
  early-continue in `solveLeg`/`solveArm`'s call sites, which is a cost *reduction* (skips a FABRIK
  solve) not an addition.
- **Instanced-batch churn risk (the thing to actually watch, per the brief):** none identified. A
  part going invisible does not create or destroy an `InstancedMesh` bucket — buckets are keyed by
  shared geometry (`body-part-batches.js:74-94`), and a body's parts already share geometry across
  the whole roster (`_sharedBodyGeo` cache, per `player-procedural-body.js` module comment). One
  bot's arm disappearing just drops that bot's matrix from the next `endFrame()` upload range
  (`:143`); it does not evict or resize a bucket (eviction is time-based over `evictAfter` empty
  frames, `:131`, and this bucket stays non-empty from every *other* bot's arm). **No new
  InstancedMesh churn.**
- **Gore/stump decals**: reuses `effect-renderer.js`'s existing `maxBloodDecals = 512` pool
  (`fx.md:65`) — bounded already, no new pool to size.
- **New state on the wire** (multiplayer): `actor.wound` fields need to ride `toWirePose`
  (`bot-entity.js:150-178`) the same optional-field way `crouch`/`prone`/`deathImpulse` do
  (`:156-164`) — small, bounded, and the pattern is already proven for exactly this kind of
  "only-emitted-when-set" state.
- **90-bot profile risk**: low. Nothing here adds per-frame cost that scales with bot count beyond
  what's already paid (the extra ray only fires on a landed hit, which is already a rare per-frame
  event relative to the aim/LOS raycasts the height-aware-LOS plan is auditing for cost).

---

## 7. Phases

Each phase independently shippable; snapshot into `versions/` before editing per repo convention.

### Phase 0 — wire `bot-body-hit.js` into combat (no visible gameplay change)
Add the second-pass part resolve described in §3.1 to `fireBotShot`'s hit path and a radial
nearest-limb lookup to `detonateBlast`. Attach the resolved `bodyHit`/limb id to
`emitBotDamaged`'s payload (`:5846-5851`) as a new optional field; nothing consumes it yet. This
phase alone is valuable independent of limb loss: it makes existing blood-decal placement in
`effect-renderer.js` part-accurate instead of capsule-surface-approximate, which idea 1 (bullet
wounds at blood-stain centers) also wants.
**Test**: extend `test-weapons.mjs` or a new `test-bot-body-hit-combat.mjs` — a shot at a known
origin/dir against a known rig pose resolves to the expected limb id.

### Phase 1 — sever + stump visuals, no AI change yet
Build the limb-identity lookup (§3.2), the amputation flag + `.visible` toggling + frozen-joint
IK skip (§3.3 steps 1-2, §3.5), and the stump gore/decal spawn (§3.3 step 4) reusing
`effect-renderer.js`'s attach system. Gate behind a threshold from §4's `WOUND_DEFAULTS`, off by
default. Arms and legs only — head stays out per §5.
**Test**: Node-testable for the pure parts (limb-identity lookup, threshold math); the `.visible`
toggling and IK skip need a browser check (per user preference, ask them to look rather than
driving Chrome) since it's a rendering/pose result.

### Phase 2 — `bot-wound.js`: AI/movement consequences
Speed/spread/turn multipliers (§3.4), wired at the four existing stance-multiplier call sites
(`:7186`, `:4474`, `:4770`, `:9703`, `:7190`) as an additional multiplicative factor. Wound state
recorded on the actor and appended to the per-frame trace row (`pushBotEvent`) without touching
`bot-state-code.js`'s core slots.
**Test**: `test-bot-wound.mjs`, mirroring `test-bot-stance.mjs`'s structure exactly (pure functions,
table-driven cases per stance/wound combination).

### Phase 3 — lethality rules
`maxSurvivableLimbs`/`bothLegsLethal`/head-is-lethal wiring into `applyBotDamage`/`detonateBlast`'s
existing death path (`killCombatBot`, already correctly reused). Per-weapon `severChance`/
`severThresholdBullet`/`severThresholdBlast` overrides (§4).
**Test**: extend whatever death/kill-crediting tests already exist for `killCombatBot`'s callers;
assert a WOUND_DEFAULTS table produces the documented threshold behavior.

### Phase 4 — head loss (blocked on the LOS plan's Phase 3)
Once `combatCapsuleFor` returns a `head` sphere and `capsuleHit` reports which primitive was hit
(LOS plan §Phase 3), route a head hit through this feature's sever-and-kill path instead of a normal
body hit. No new geometry work needed beyond what that plan already describes; this phase is mostly
"consume the primitive id."
**Test**: a case in the LOS plan's own Phase 3 test file plus one here asserting head hits always
route to `killCombatBot` regardless of remaining health.

### Phase 5 (optional, explicitly deferred) — physical detached limb prop
A severed limb that falls and rests on the ground as its own ragdoll-lit prop, rather than just
vanishing + a stump decal. No existing analog in the codebase (§2c); scope only if the MVP (stump +
gore burst) reads as insufficient in the browser.

---

## 8. Dependencies and conflicts with the other three ideas

- **Idea 1 (bullet wounds at blood-stain centers)**: complementary, not conflicting — both want
  Phase 0 here (wiring `bot-body-hit.js` into combat) as their foundation. If idea 1 ships first and
  does this wiring itself, Phase 0 here becomes "already done, verify the shape matches." Coordinate
  so the wiring isn't built twice with incompatible payload shapes.
- **Idea 3 (damage effects by bot class — human/armoured/robot)**: **directly interacts with §4's
  severability.** A robot bot presumably shouldn't "bleed" but might still lose a limb (sparks
  instead of gore); an armoured human might resist severing until low health. If idea 3 ships a
  `damageClass` descriptor on bots, this idea's `WOUND_DEFAULTS`/`severThreshold*` fields should key
  off it (e.g. `severThresholdBullet` per class) rather than assuming one universal human body. Build
  idea 3's class descriptor first if both are in scope, or this idea will need rework to consume it.
- **Idea 4 (blood pools / robot fire / armoured both)**: consumes the same stump/gore event this
  idea produces (§3.3 step 4) as a trigger — a severed limb is a natural "start a pool here" or
  "ignite here" event. Sequencing-friendly: build this idea's sever event first, let idea 4 subscribe
  to it via the same `onBotDamaged`/new sever-event bus pattern (§1's "event bus" seam) rather than
  hardcoding a call from this module into idea 4's pool/fire spawner.
- **Shared infra all four ideas will fight over**: `effect-renderer.js`'s `maxBloodDecals = 512`
  pool ceiling (§6) is a single shared budget; four separate features spawning decals need a combined
  budget conversation, not four independent assumptions that 512 is "enough."

---

## 9. Open questions

1. **What does a bot missing its gun arm actually do?** §1 established the weapon rig is NOT
   parented to the hand — losing the arm doesn't break weapon rendering, it just makes it look wrong
   (a rifle held by an arm that isn't there). Does the bot force-switch to sidearm-in-the-other-hand,
   drop the weapon entirely, or is the visual mismatch acceptable for a first ship? This needs an
   actual answer before Phase 1's stump work is "done," since it's directly observable.
2. **Two legs gone: crawl, or dead?** §4 leaves `bothLegsLethal` as a design call. A crawling bot is
   a much bigger animation/IK ask (§3.5's leg section already flags "stagger/hop animation" as
   out-of-scope follow-up) — recommend `true` (lethal) for the MVP and revisit only if crawling is
   explicitly wanted.
3. **Does a wounded-but-not-dead bot's role loadout change?** E.g. a wounded medic — does it still
   try to revive allies one-handed? §3.4's `oneHandedPenalty` field idea doesn't resolve whether
   `canRevive`/other role behaviors should gate on wound state; needs a decision, not just spread
   penalties.
4. **Multiplayer**: does a guest need to independently simulate severing, or does the host decide and
   broadcast (host-authoritative per this repo's existing model, `CLAUDE.md`'s "Multiplayer is
   host-authoritative" note)? Almost certainly the latter — host decides, wire field rides
   `toWirePose` — but worth confirming no guest-side prediction is expected.
5. **Does `resolveBodyHit`'s box-approximation accuracy (its own header admits the body is "mostly
   lathe surfaces... the box is an approximation") matter for sever decisions**, or only for decal
   placement? A near-miss box hit on a thin forearm mis-severing the wrong segment is a worse failure
   mode for gameplay (a limb vanishing) than for a decal (slightly misplaced blood). Worth an
   explicit accuracy check in Phase 0's test before trusting it for something as visible as
   dismemberment.
6. **Should the "stump" leave a static joint or attempt a believable rest pose** (e.g., an arm stump
   hanging naturally rather than frozen mid-stride)? §3.5 punts to "simplest" for the MVP; worth a
   look in the browser before deciding it's good enough.
