## Idea 3: class → damage-language seam

The idea: humans bleed, armoured humans bleed only once their armour is compromised (plus
sparks/smoke throughout), robots never bleed and instead spark/smoke/spasm/go haywire when they
die. The ask is really an architecture question — a `class` descriptor that the other three damage
ideas key off, instead of each growing its own `if (bodyKind === 'armoured')` branch.

**Hardest problem**: robot-specific *continuous* material feedback (glowing cracks, scorch) is
blocked by the bot rig's rendering model — every bot of a role shares one `InstancedMesh` material
per part-role bucket with only a per-instance **color**, no per-instance damage/heat uniform, so
`materials/damage-overheat.js` cannot be wired to one bot without a rig-material migration nobody
has scoped. Event-based FX (sparks, smoke puffs, spasm jitter, blood gating) sidestep this
entirely because they're spawned per-hit through code paths that already know the specific target,
not through the shared material.

**Recommendation**: worth building, and cheap to start. The descriptor itself (Phases 0-2 below) is
a half-day of work reusing effect kinds and audio paths that already exist and are already budgeted;
it should ship before ideas 1/2/4 touch damage FX so they build on the seam instead of pre-empting
it. The one piece that's genuinely expensive — per-bot glowing damage material — should be deferred
and is flagged as out of scope here (spasms and haywire are event/render-time tricks, not material
work, so they don't need it — see §5).

---

## 1. What exists today

### Two body kinds, one *global* switch, not a per-bot field

`BOT_BODY_KINDS = ['armoured', 'soldier']` (`bot-body-design.js:573`). `'armoured'` is the Mark VII
mech (`BOT_BODY_DESIGN`, `bot-body-design.js:192-405` — an "armoured combat mech" per its own
header comment, never described as human or robot). `'soldier'` is the clothed human
(`bot-human-body.js` via `buildSoldierDesign`, `bot-body-design.js:625-640`).

`setBotBodyKind`/`getBotBodyKind` (`bot-body-design.js:576-591`) hold **one module-level variable**,
`_bodyKind`. Both viewers default it from a URL param at load:
- `bot-viewer-v2.html:93`: `setBotBodyKind(new URLSearchParams(location.search).get('botBody') || 'armoured')`
- `environment-viewer-v2.html:765`: identical pattern, same default.

The only call site that turns a bot into a mesh is `bot-viewer-v2.html:2123`:
`design: botDesignForRole(activeBotActor?.role)` — **role** varies per bot, **body kind does not**.
`botDesignForRole` (`bot-body-design.js:651-661`) caches on `_bodyKind + '|' + roleId`, i.e. it is
architecturally a global-times-role cache, not a per-bot one. `multiplayer.js:1137-1145`'s
`rebuildBotBodies()` docstring confirms this directly: *"the armoured/soldier switch... leaves live
bots wearing the old one forever otherwise"* — singular switch, plural bots.

**This, not the rename, is the real gap for idea 3.** Today you cannot field a mixed fight (some
humans, some armoured, some robots) at all — flipping the toggle changes every bot on the field.

No persisted state references the body-kind string: `bot-viewer-slots.js` has zero matches for
`bodyKind`/`armoured`/`botBody` (grepped directly), so there is no localStorage migration to worry
about for the geometry axis. `BOT_BODY_KINDS` also composes with two *other* existing axes that
already work per-bot-batch: `bot-body-versions.js`'s `composeBot(bodyKey, headKey, headOpts, kits)`
separates head from body (`headOf`/`bodyOf`, lines 55-72), and `bot-roles.js`'s `ROLES` table
descriptors already vary art (pack/kit) per role. Neither axis carries a "what species is this"
concept — that's a fourth axis that doesn't exist yet.

### The damage funnel

`applyCombatDamage(amount, hitPoint, target, now, source)` (`bot-viewer-v2.html:5870-5901`) is the
single dispatch point cited in the task brief. It branches only on `target.botActor` (is this a real
bot vs. the practice dummy), not on class:

```
5872-5873  if (!target.botActor) playAtCulled('enemy_hit', ...);      // dummy: flesh sample
5874-5876  if (target.botActor) { applyBotDamage(...); ... }          // bot: always the same path
```

`applyBotDamage` (`bot-viewer-v2.html:5831-5868`) unconditionally calls
`spawnHitBloodFx(hitPoint, ..., target, woundFrom)` at line 5835 for **every** bot hit, regardless of
body kind. `spawnHitBloodFx` (`bot-viewer-v2.html:10725-10750`) unconditionally pushes `hit_spark`
*and* the full `blood_spray`/`blood_stain`/`blood_splatter` stack — there is no class check anywhere
in this path. **Confirmed gap, not inference**: every bot on the field bleeds today, mech or human,
full health or dying.

Hitscan tests one 0.3 m capsule per bot and damage is flat (no per-part multiplier) — confirmed via
`fx.md`'s own note (`combat hitscan tests one 0.3 m capsule for the whole bot`) and `applyBotDamage`
taking a flat `amount` with no body-part lookup before the health subtraction at line 5838.

### Audio is *already* uniformly "robot," independent of body kind — a second, orthogonal gap

`bot-damage-audio.js:2-3`: *"Bots are robots: the sampled `enemy_hit` (body-impact.wav) and
`pain-grunt.wav` are flesh and breath, so every voice here is synthesized struck metal, arcing
electronics or a distress siren."* `bot-voice.js:1`: *"robotic squad-radio voices for combat bots."*
Both are unconditional — a `'soldier'` (human) body kind still barks and dies through the metal/siren
voice bank. So the audio side of idea 3 isn't "add class routing to existing per-class audio," it's
"introduce the first class routing at all" — the flesh sample path exists (used for the dummy) but
is not reachable by any real bot regardless of what it looks like.

### Effect kinds are already generic enough to reuse

`entity-types/effect.js` defines `hit_spark`, `smoke_puff`, `blood_spray`, `blood_stain`,
`blood_splatter` (`EFFECT_KINDS`, lines 52-55) as parametrized kinds (color, count, size all
caller-supplied). `hit_spark` and `smoke_puff` are **not** blood-specific — `hit_spark` already fires
on every hit for world surfaces too (`fx.md`: *"world surfaces (terrain/obstacle) also get a
lingering dust instance"*), and `smoke_puff` already renders rocket-trail/blast-wisp smoke with no
blood coupling. **Robot sparks/smoke need no new effect kind** — they're `hit_spark`/`smoke_puff`
calls with robot-flavoured params, going through the same pooled draws (`GLOW_POOL` 220,
`SMOKE_POOL` 260, shared `LineSegments`/`Points` pools) that are already budgeted and already paid
for by the existing blood path. What doesn't exist: a short-circuit arc / spasm visual, and any
per-bot continuous material glow (see §5, §6).

### Materials: `damage-overheat.js` exists, is not wired in, and the blocker is concrete

`materials/damage-overheat.js` is a `MeshStandardNodeMaterial` with `damage`/`heat` driven by
`uniform()` (lines 47-53) — **one value per material instance**, meant for a single mesh. The bot rig
renders through `body-part-batches.js`: one `InstancedMesh` **per shared geometry/role bucket**
(`shell`/`plate`/`trim`/`eye`...), shared across every bot wearing that role's design
(`body-part-batches.js:20-23,79`), with only a per-instance `instanceColor` (vec3) — no per-instance
scalar attribute for damage or heat. Wiring `damage-overheat.js` in as-is would either (a) make every
bot in a role bucket glow identically (wrong — it's per-material, not per-instance), or (b) require
giving every damaged robot bot its own non-instanced mesh, which defeats the entire point of
`body-part-batches.js` (N bots costing one geometry). The real fix is a rig-material migration —
extending the instanced buckets with per-instance float attributes (`instDamage`, `instHeat`) and a
custom node material reading `attribute('instDamage')` instead of `uniform(damage)`. That migration
is unscoped, matches the memory note ("iridescent shells blocked on a bot-material migration"), and
is **out of scope for this plan** (see Cost, §6, and Phase 7).

### Death already has a path; there is room to hang a variant on it, not replace it

`killCombatBot` (`bot-viewer-v2.html:4905-4992`) tallies the kill, drops packs, paints the danger
field (H3, lines 4949-4958), fires `emitBotDied` (line 4946, which drives squad call-outs and
`bot-damage-audio`'s siren/death voice), then branches on `ragdollDeathEnabled` (lines 4961-4985) to
either seed a Verlet ragdoll (`ragdollFromBody`, `applyBlastImpulse`/`applyDeathImpulse`) or fall back
to the flat capsule-death visual. Nothing here reads body kind or class today.

### The state-code encoder is exhaustively enumerated and its latch slot is already full

`bot-state-code.js` encodes 9 discrete axes into a fixed-width code, one of which
(`STATE_CHARS = 'PSUEHKAFCGMTD'`, 13 characters, line 42) is the FSM state, and one of which
(slot 9, `LATCH_CHARS`, line 50) is a base32 char over **exactly** 5 commit-latch bits
(`LATCH_MASK = 31`, line 79) — `Array.from({length:32})` is `2^5`, fully saturated: flee, cover,
hold, heal-flee, sight-grace already use all 5 bits (lines 70-78). `enumerateLegalCodes()`
(lines 360-382) is a brute-force nested loop over every slot's alphabet, gated by 18 hand-written
legality `RULES` (lines 110-151) — this is a closed, exhaustively tested combinatorial space, not an
open enum you can casually extend. Adding a new top-level FSM state (e.g. a `HAYWIRE` state) means a
new `STATE_CHARS` entry plus new legality rules scoping which tiers/roles/ammo/health values are
legal alongside it — real, nontrivial work, and it multiplies the enumeration. Adding a new latch bit
(e.g. "armour breached") has **no room** — the slot is at capacity. §5 and §4 design around both
constraints rather than paying for them.

*(Doc-drift note, not load-bearing: `fx.md` line ~253-255 says bot-viewer-v2 "Neither currently
spawns blood_spray/... from a real hit," but lines 367-373 of the same file say the opposite and
match what the code does. The second is correct; the first is stale from before Blood FX v2 shipped.
Flagging per house style — not fixing it, out of scope here.)*

---

## 2. The gap

1. **No class concept exists at all**, visual or behavioural. The closest thing, body kind, is a
   single global toggle, not a per-entity property — see §1. Idea 3 needs class to be assignable
   per bot (or at minimum per squad) for a mixed fight to ever be possible, which body kind cannot
   do today without a larger change (threading `_bodyKind` through `botDesignForRole`'s cache key
   and every design-lookup call site).
2. **Damage FX has zero class branching.** Every bot bleeds, always, regardless of what it's wearing
   (§1). This is the literal bug idea 3 fixes, and it's confirmed in code, not inferred.
3. **Audio has zero class branching either, in the opposite direction**: everything is robot-voiced
   today, even the human body kind. Idea 3 has to *introduce* flesh-audio routing for `human`, not
   just gate an existing one.
4. **The rename's technical cost is small; its content cost is the open question.** Renaming the
   string `'armoured'` → e.g. `'armouredHuman'` touches: `BOT_BODY_KINDS` (`bot-body-design.js:573`),
   two URL-param defaults (`bot-viewer-v2.html:93`, `environment-viewer-v2.html:765`), and the UI
   label already computed live (`bodyKindBtn.textContent`, `bot-viewer-v2.html:12317`) — no
   persisted-slot migration needed (§1). The **content** cost is bigger: the current Mark VII
   ("armoured") already reads as a fully-enclosed helmeted mech, which is closer to what "robot"
   should look like than to a human wearing armour over a visible face. Reusing it as-is for
   `armouredHuman` under the new narrative, and authoring a *new* look for a genuinely different
   `robot` class (or vice versa), is an art decision, not a code one — flagged in Open Questions.
5. **A decoupling decision the plan is making explicitly**: `damageClass` (the FX/audio language) and
   `bodyKind` (the geometry) do not have to be the same axis. Recommended: keep them separate. The
   damage-language seam only needs to know, per hit, "what species is this bot" — it doesn't need to
   solve per-bot geometry at all, because `spawnHitBloodFx`/`applyBotDamage` already run per-target
   (§1). Solving per-bot geometry (so a robot and a human can stand side by side) is real work but is
   *decoupled* from and cheaper-adjacent-to the damage-language work; the plan phases it in §7 as an
   explicit, separately-scoped step (Phase 3) rather than a blocking prerequisite.

---

## 3. The descriptor design

Follows `bot-roles.js`'s pattern exactly: a `DEFAULTS` object merged into named rows, pure data, no
branching on the id anywhere outside the module that owns the table (`bot-roles.js:42-80` is the
model — every consumer reads `getRole(id).fieldName`, never `if (id === 'medic')`).

New module, `bot-damage-class.js` (Node-testable, no THREE, mirrors `bot-roles.js` and
`bot-state-code.js` in being pure):

```js
export const DAMAGE_CLASS_DEFAULTS = {
  blood: 'always',        // 'always' | 'lowHealthOnly' | 'never'
  bloodThreshold01: null, // hp fraction below which blood starts, only read for 'lowHealthOnly'
  sparks: false,          // hit_spark on every hit, independent of blood
  smoke: 'never',         // 'never' | 'lowHealthOnly' | 'always' — smoke_puff wisps on hit
  spasms: false,          // pre-death low-health twitch overlay (see Section 5)
  haywireOnDeath: false,  // death-flourish variant (see Section 5)
  hitAudio: 'flesh',      // 'flesh' | 'metal' — which bot-damage-audio bank plays on hit
  deathAudio: 'flesh',    // 'flesh' | 'metal' — which bank plays on death/siren
};

export const DAMAGE_CLASSES = {
  human:         { blood: 'always' },
  armouredHuman: { blood: 'lowHealthOnly', bloodThreshold01: 0.35, sparks: true,
                   smoke: 'lowHealthOnly', hitAudio: 'metal', deathAudio: 'flesh' },
  robot:         { blood: 'never', sparks: true, smoke: 'always',
                   spasms: true, haywireOnDeath: true, hitAudio: 'metal', deathAudio: 'metal' },
};
```

Every field name is a *capability*, not a class name — that's what lets ideas 1, 2 and 4 plug in
without a class-by-class branch:

- **Idea 1** (bullet wounds darker at centre, drip vs. spray by health) reads `class.blood` first —
  if `'never'`, it does nothing; if `'lowHealthOnly'`, it gates on the same
  `bloodThreshold01`/breach-latch this plan introduces (§4) instead of re-deriving its own
  threshold. Its own new fields (say `woundStyle: 'stain-drip'`) are added to the same rows, not to a
  parallel table.
- **Idea 2** (limb loss) needs a *stump* language per class — a severed bloody stump for `human`, a
  sparking socket for `robot`. That's one new field (`stumpFx: 'blood' | 'sparks'`) on the same
  table, read the same way `hitAudio` is read. It also composes naturally with `haywireOnDeath` (a
  robot that loses a limb *and* dies haywire) without either idea's code knowing about the other —
  both just read their own field off the same row.
- **Idea 4** (blood pools; robots' pools catch fire; armoured maybe both) needs a `poolFx` field
  (`'blood-pool' | 'oil-fire' | 'both'`) and its own new effect kind for burning oil — that's idea
  4's own work, but the *decision* of which pool a given bot gets is `class.poolFx`, looked up once,
  not reimplemented.

The rule this table exists to enforce: **no call site anywhere branches on `'human'`/
`'armouredHuman'`/`'robot'` string literals.** Every consumer calls `getDamageClass(bot).<field>`.
Adding a fourth class later (say, a heavy-mech boss with its own language) is one new row.

A resolver bridges today's `bodyKind` to a class until Phase 3 decouples them for real:
`classForActor(actor)` defaults `bodyKind === 'soldier' → 'human'`, `bodyKind === 'armoured' →
'armouredHuman'`, with `'robot'` unreachable until it has geometry or an explicit per-actor override
exists (§7, Phase 3). This keeps Phase 1-2 shippable against the two body kinds that already exist.

---

## 4. Low-health gating for armoured humans

**Where health fraction is already read**: `applyBotDamage` already computes both
`hpBefore01`/`hpAfter01` at lines 5837 and 5848 (`Math.max(0, Math.min(1, target.health / maxHp))`),
purely for the `emitBotDamaged` audio event. The blood-gating check should reuse these exact values,
not recompute them.

**Threshold**: the descriptor's `bloodThreshold01` (`0.35` proposed above — armour meaningfully
compromised, below the existing `botHealthSettings.threshold01 = 0.60` heal-retreat trigger
(`bot-viewer-v2.html:7255`) so a bot starts retreating to heal *before* it starts visibly bleeding,
which reads correctly — "I'm hurt" precedes "I'm bleeding through the plate").

**Hysteresis — yes, and there's a working precedent already in this file to copy, not invent.**
`botHealthSettings` (`bot-viewer-v2.html:7253-7262`) already implements a two-value enter/exit band
for heal-retreat: `threshold01: 0.60` to start, `resume01: 0.72` to stop
(`beginBotHealthRetreat`, line 5000: `if (hp01 > botHealthSettings.threshold01) return;`), the exact
`evadeExitScale` shape the task brief warns about (`botGrenadeSettings.evadeExitScale`,
`bot-viewer-v2.html:8945`, "a bot already running keeps running until blast×this").

For blood specifically, though, a plain enter/exit band is the *wrong* shape, because blood-gating
isn't a continuous state (like "is this bot currently fleeing") — it's a one-shot decision evaluated
once per discrete hit event. The flicker risk the brief is worried about (a bot bobbing back and
forth across 0.60/0.72 every frame) doesn't apply the same way to an event that only fires on
`applyBotDamage` calls. What *can* still look wrong without a latch: a bot drops to 30% (bleeding),
a medic heals it to 50% (still below `resume01` conceptually but now healed) — should it stop
bleeding on the very next hit above threshold? Narratively no — armour once breached doesn't
un-breach.

**Recommendation**: a one-way latch, not a two-value band — `actor.armourBreached` (boolean),
set `true` the first time `hpAfter01 <= class.bloodThreshold01`, never cleared except on
revive-from-death (the medic revive path already resets a bot to a fresh state, so a resurrected bot
starting clean is correct). Blood shows if `armourBreached === true`, independent of the *current*
frame's health. This is a single boolean field on the bot actor (same shape as the existing
`actor.healRequested` latch used right next to it), not a slot in the 9-char state-code — the
latch slot there is already at 5/5 bits (§1) and this doesn't need to be greppable in a state trace
to do its job.

---

## 5. Robot spasms and haywire

**Spasms (pre-death, low-health twitch) — recommendation: a render-time cosmetic modifier, not an
FSM state, not even a latch.** Reasoning: a spasming robot is still doing whatever it was doing —
aiming, firing, fleeing — the twitch has to *compose* with every existing state, not replace it. The
task brief's own example of what *not* to do is right there in the code: medic duty already
overwrites the FSM state wholesale (`bot-state-code.js:22-24`, `bot-viewer-v2.html`'s
`if (duty) state = duty.state`), and that comment explicitly warns the overwrite is state-consuming,
not modifier-composing — a second axis doing the same thing for spasms would be the same mistake the
duty model was corrected away from. Instead: at render time (`Creature`-equivalent per-bot placement
step), when `class.spasms` and `hp01` is below a spasm threshold (proposed `0.20`, i.e. below the
armour-breach band, "about to die" not "just hurt"), apply a small per-frame positional/rotational
jitter to the rig, seeded off `(botId, frame)` the same way `hash01`-style determinism is used
elsewhere in this codebase (`particle-field.js`'s `hash01`, `effect-renderer.js`'s per-`id` hash) so
it's reproducible across host/guest without being networked. No FSM change, no state-code change, no
new latch bit needed.

**Haywire on death — recommendation: a death-flourish *variant*, layered onto the existing ragdoll
branch, not a new pre-death state.** `killCombatBot`'s `ragdollDeathEnabled` branch
(`bot-viewer-v2.html:4961-4985`) already seeds impulses (`applyBlastImpulse`/`applyDeathImpulse`)
and already fires `emitBotDied` (line 4946) which drives squad call-outs, the danger field
(lines 4949-4958), and `bot-damage-audio`'s siren/death-voice hook
(`onBotDied`, lines 5786-5789). For a `robot`-class bot, "haywire" is: (a) an extra
spark/smoke burst at the death point (reusing `hit_spark`/`smoke_puff`, no new effect kind), (b) a
class-selected death audio cue routed through the *existing* `onBotDied` listener by reading
`class.deathAudio` instead of the hardcoded siren/death-voice path, and (c) optionally, a brief
randomized-impulse "thrash" applied to the ragdoll's joints for a few frames before it settles,
which is a parameter on the *existing* `applyDeathImpulse` call, not a new system.

**Why this doesn't touch `bot-state-code.js` at all — a genuine win worth calling out explicitly.**
The `'dead-collapses'` rule (`bot-state-code.js:149-150`) already freezes every other slot the
instant `state === 'D'` — tier, score, element, ammo and health all collapse to their zero value, and
latches must be `0`. Haywire, by this plan's design, is a *flavour of the same terminal state*, not a
new one, so it is invisible to the encoder by construction — no new `STATE_CHARS` entry, no new
`RULES`, no re-enumeration of the combinatorial space (§1's warning about the 13-state /
5-bit-saturated encoder). If a future pass wants haywire to be a *live hazard* (see Open Questions)
rather than a corpse-side flourish, that would cross back into FSM territory and would have to pay
the encoder cost for real — explicitly deferred here.

**Squads**: haywire death goes through the same `emitBotDied` → squad call-out → succession path as
any other death (`bot-viewer-v2.html:5794-5812`) with zero special-casing, because it's the same
event with a different `credit?.cause`/audio bank, not a different event. No squad-side change is
needed for Phase 6.

---

## 6. Cost

**Measured / confirmed from code, not estimated:**
- `hit_spark`/`smoke_puff` are already generic, parametrized, and drawn through pools that are
  already paid for by the existing blood path (`GLOW_POOL` 220, `SMOKE_POOL` 260, shared
  `LineSegments`(3072)/`Points`(1024)) — robot sparks/smoke add call-site branching, not new draw
  calls, new pools, or new per-frame cost categories.
- The bot rig's material model is one `InstancedMesh` per role bucket, shared across every bot of
  that role, with only a per-instance `vec3` color (`body-part-batches.js:20-23,79`) — confirmed,
  not inferred, and it is the reason continuous per-bot material glow (crack/scorch) cannot be
  wired from `damage-overheat.js` as-is (§1). This plan does not cost that migration; it is excluded
  from every phase below.
- The state-code encoder is exhaustively enumerated (`bot-state-code.js:360-382`) and its latch slot
  is at capacity (5/5 bits, §1) — confirmed. This plan's FSM design (§5) is shaped specifically to
  avoid paying that cost, by construction, not by omission.
- No localStorage/slot migration cost for the body-kind rename (`bot-viewer-slots.js` grepped clean,
  §1) — confirmed.

**Estimated / inference, flagged as such:**
- Gating blood off for `robot`-class bots in a robot-heavy fight should *reduce* pressure on the
  512-slot `maxBloodDecals` pool (fewer `blood_stain` instances competing for the cap) relative to
  today's always-bleed baseline — this is a plausible perf **improvement**, not measured against the
  90-bot profile cited in memory, and not verified in this investigation (no browser run was done,
  per instructions).
- The per-hit branching this plan adds (one table lookup, one boolean latch check) is the same order
  of cost as the `hpBefore01`/`hpAfter01` math `applyBotDamage` already does every hit — expected
  negligible, not separately profiled.
- Spasms' per-frame jitter (§5) touches only `robot`-class bots below a low-health threshold, which
  in most fights is a small minority of the live roster at any instant — expected negligible, not
  profiled.

---

## 7. Phases

Each phase is independently shippable and leaves the game in a working state; none blocks on Phase 3
(art) or Phase 7 (material migration, explicitly out of scope).

**Phase 0 — descriptor scaffold, inert.** New `bot-damage-class.js`: `DAMAGE_CLASS_DEFAULTS`,
`DAMAGE_CLASSES` (`human`, `armouredHuman`; `robot` row present but unreachable until Phase 3),
`getDamageClass(id)`, `classForActor(actor)` (resolves from today's `getBotBodyKind()` + role, per
§3). No call site wired yet. `test-bot-damage-class.mjs`: table shape, defaults merge correctly,
unknown id falls back to a default class rather than throwing (mirrors `bot-roles.js`'s
`getRole` fallback, line 83).

**Phase 1 — wire blood/spark/smoke gating into the hit path.** `spawnHitBloodFx` and
`applyBotDamage` read `getDamageClass(classForActor(target))` and branch only on
`class.blood`/`class.sparks`/`class.smoke` fields (never on class id literals, per §3's rule). The
blood-vs-not decision itself should be a small **pure, extracted function**
(`shouldShowBlood(class, hpAfter01, alreadyBreached) -> {show, breached}`) so it's Node-testable
without touching the 14k-line host file — same pattern `bot-state-code.js`'s pure `healthBand`/
`tierSlot` helpers use relative to the viewer. `test-bot-damage-class.mjs` gains cases: `'always'`
always shows; `'never'` never shows; `'lowHealthOnly'` shows only once `hpAfter01` crosses
`bloodThreshold01` and *stays* shown (the one-way latch from §4) even if healed back up.

**Phase 2 — audio class routing.** `class.hitAudio`/`class.deathAudio` select which
`bot-damage-audio.js` bank plays (`onBotDamaged`/`onBotDied`, `bot-viewer-v2.html:5782-5789`),
so `human`-class bots finally reach the flesh sample path that today only the practice dummy uses
(§1). Extends `test-bot-damage-audio.mjs`'s existing pure-logic coverage with a class parameter.

**Phase 3 — decouple `damageClass` from `bodyKind`, add per-actor override.** This is where the real
"third class, per-bot" capability lands: either (a) thread an explicit `damageClass` field onto the
bot actor at spawn (independent of the still-global `bodyKind`), defaulting via `classForActor` but
overridable per-squad/per-spawn-batch, or (b) make `bodyKind` itself per-actor by threading it through
`botDesignForRole`'s cache key (`bot-body-design.js:656`) and every design-lookup call site. (a) is
strictly cheaper and is what this plan recommends — it makes mixed *damage languages* possible on
the field immediately, without solving mixed *geometry* (which stays a separate, larger, explicitly
deferred problem — the field is still "every bot looks like whatever `bodyKind` says" until someone
does (b) or authors real robot art). Robot geometry itself (new art or a re-skin of the existing
Mark VII) is content work outside this plan's scope — see Open Questions.

**Phase 4 — armour-breach latch hardening.** `actor.armourBreached` boolean, set on first breach,
cleared only on revive-from-death (§4). `test-bot-damage-class.mjs` (or a small
`test-bot-damage-latch.mjs`) covers the latch state machine directly: enter once, stays set across a
simulated heal, clears on a simulated revive.

**Phase 5 — spasms overlay.** Render-time jitter for `class.spasms` bots below a spasm threshold,
seeded deterministically off `(botId, frame)` (§5). Pure jitter-curve math (`spasmAmplitude(hp01) ->
number`) is Node-testable in isolation even though the actual mesh perturbation isn't.

**Phase 6 — haywire death flourish.** Extra spark/smoke burst + `class.deathAudio` routing +
optional ragdoll thrash on `killCombatBot`'s existing ragdoll branch (§5). A cheap regression
worth adding here: assert `STATE_CHARS.length` and `LATCH_MASK` are unchanged by this phase, as a
standing guarantee that haywire never grows the state-code space (matches the "genuine win" claimed
in §5).

**Phase 7 — explicitly deferred, not scheduled.** Per-bot continuous material feedback (glowing
cracks/scorch via a `body-part-batches.js` instance-attribute migration + a `damage-overheat.js`
node-material variant reading `attribute('instDamage')`/`attribute('instHeat')` instead of
`uniform()`). Flagged, not costed, not phased — see §1 and §6.

---

## 8. Dependencies and conflicts with the other three ideas

- **Sequencing**: this plan's Phase 0-1 (descriptor + blood/spark gating) should land **before**
  ideas 1, 2 or 4 touch `spawnHitBloodFx`/`applyBotDamage`. If any of them ships first and hardcodes
  its own body-kind check, it will need replumbing onto `getDamageClass` once this lands — cheap to
  avoid by ordering, expensive to unwind after the fact.
- **Idea 1** (wound centre/drip-vs-spray by health) is a pure consumer of `class.blood` and this
  plan's `hpBefore01`/`hpAfter01` values (§4) — it should call `shouldShowBlood` first and only run
  its own severity math if that returns true, rather than re-deriving a health check. No conflict,
  straightforward dependency.
- **Idea 2** (limb loss) needs a new field on the same table (`stumpFx`, §3) and composes with
  `haywireOnDeath` — a robot that loses a limb and then dies haywire is two independent field reads,
  not two systems that need to know about each other. Sequencing after Phase 6 is not required but
  is lower-risk (haywire's audio/FX hooks will already exist to reuse).
- **Idea 4** (blood pools; robot pools catch fire) is the most entangled: it needs a *new* effect
  kind (burning oil, not blood) and a new `poolFx` field, and it naturally wants to key off
  `haywireOnDeath` (a haywire death could ignite its own pool) — recommend idea 4 sequence after
  Phase 6 specifically, so "does this death ignite anything" has one place to be decided
  (`class.poolFx` + `class.haywireOnDeath` together) instead of two features racing to add fire
  independently.
- **No conflicts identified with idea 1 or 2** beyond straightforward field additions to the same
  table — the whole point of the descriptor is that they don't need their own switch statement.

---

## 9. Open questions

1. **Rename scope** (cannot be decided here, per the task brief): does `'armoured'` need to become a
   new *string key* (`'armouredHuman'`) everywhere it appears — `BOT_BODY_KINDS`, the two URL-param
   defaults, `?botBody=armoured` links anyone has bookmarked/scripted — or is a *label-only* rename
   (leave the internal key `'armoured'`, just change `bodyKindBtn.textContent` and doc prose)
   sufficient? The label-only version is strictly cheaper and breaks nothing external; the key
   rename is more honest to the new narrative but has no technical forcing function since nothing
   persists the string (§1, §2).
2. **What is `robot`, visually?** Is it a re-skin/relabel of the existing Mark VII mech (already
   reads as fully-enclosed and faceless — arguably already "robot" today), with a *new* look
   authored for `armouredHuman` (human face/head visible under armour, per `bot-body-versions.js`'s
   existing head/body decoupling)? Or the reverse — keep `'armoured'` as `armouredHuman` unchanged
   and author new robot art from scratch? This is an art-direction decision this plan cannot make;
   it determines almost all of Phase 3's actual scope.
3. **Per-bot or per-squad class assignment?** Phase 3 as written makes per-bot assignment possible
   cheaply. Is that actually wanted (mixed fights, a robot squad vs. a human squad), or is a single
   global class-for-the-whole-fight (matching today's global `bodyKind` toggle) acceptable for a
   while? This changes how much of Phase 3 is worth building now vs. later.
4. **Does the armour-breach latch (§4) ever need to be visible in the state trace?** This plan
   deliberately keeps it off the state-code (the latch slot has no room, §1) as a plain actor field.
   If a future debugging need wants it greppable in a 9-char trace, that requires either growing the
   encoder's latch slot (a real, costed redesign) or accepting it stays trace-invisible — worth a
   decision before Phase 4, not after.
5. **Is haywire ever meant to be a live hazard** (an unstable robot that can hurt nearby allies before
   or as it dies), or purely a corpse-side cosmetic/audio flourish forever? This plan scopes Phase 6
   as the latter specifically because the former re-opens the state-code cost this plan otherwise
   avoids (§5) — flagging so ideas 2/4 don't design around an assumption this plan didn't commit to.
