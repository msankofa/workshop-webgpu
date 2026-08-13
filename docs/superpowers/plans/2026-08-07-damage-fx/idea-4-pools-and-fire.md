# Idea 4: blood pools (humans) and burning (robots) — persistent aftermath FX

**The idea**: downed/bleeding humans accumulate a growing blood pool on the ground; damaged or
destroyed robots catch fire and burn; armoured humans may do both — world-persistent effects with
a lifetime, distinct from the instantaneous hit FX that already exist.

**The hardest problem**: there is no per-bot signal to decide "human vs robot" at all today.
`setBotBodyKind` (`bot-body-design.js:573-591`) is a single **global** variable — the whole roster
is armoured XOR soldier, never mixed. Idea 4 cannot choose blood-pool-vs-fire per corpse until
idea 3 (or this plan, if idea 3 doesn't ship first) adds a **per-bot** class field. Everything else
in this plan is ordinary budget/pooling engineering; this is the one blocking unknown.

**Recommendation**: worth building, but only after (or alongside, as a small shared patch to) the
per-bot class field. Scope it small: 1 persistent decal per corpse (grows in place, never spawns
more geometry) and a hard-capped, priority-evicted burning-bot list reusing the existing
`combat-audio-budget.js` pattern. Do not give fire a real dynamic light in v1 — the existing 2-slot
budget is sized for momentary flashes, not a 15-second sustained glow, and a burning robot would
starve every muzzle flash near it for the whole engagement.

---

## 1. What exists today

### Wound stains (the closest existing thing, and NOT what this idea needs)

`entity-types/effect.js` defines three blood kinds, all **short-lived** (`entity-types/effect.js:48-51`):
`blood_spray` (life 0.6s, flying droplets), `blood_stain` (life 6.0s, decal at the wound),
`blood_splatter` (life 8.0s, decals where the droplets land on the ground). Every one is a normal
`effect` entity: pushed via `pushEffect()` (`bot-viewer-v2.html:10592`), aged in `botEffects`, and
dropped the frame its `expireAt` passes (`updateEffects`, `bot-viewer-v2.html:10609-10629`). There
is no accumulation — a stain fades to zero opacity over its last 30% of life
(`effect-renderer.js:615-617`, mirrored in the projected-decal path at `bot-viewer-v2.html:10654`)
and is gone. **This is a transient hit-marker system, not a pool system.** It answers "where did
blood just land," not "how much blood has soaked into the ground here over the last 30 seconds."

Two render paths share one wire format, selected by `botStainRender` (`bot-viewer-v2.html:10585`,
default `'fitted'`):

- **Fitted** (`effect-renderer.js`): one instanced decal pool, `maxBloodDecals = 512`
  (`effect-renderer.js:120`), shared by `blood_stain` **and** `blood_splatter` combined
  (`effect-renderer.js:116-117,273`). `sync()` rewrites the whole pool from scratch every frame by
  re-walking the live `botEffects` list (`effect-renderer.js:671-698`) — it is not an append/evict
  ring buffer, it's redrawn each frame from source-of-truth state. 52 bytes/instance, 26,624 bytes
  total (measured via `node -e`) — capacity was never the constraint, frame redraw cost and the
  shared-with-transients semantics are.
- **Projected** (`projected-decals.js`, Mode C): `cap = 256` (`bot-viewer-v2.html:10639`), same
  per-frame full-rebuild pattern (`begin()`/`push()`/`end()` called fresh every frame from
  `botEffects` in `drawProjectedStains`, `bot-viewer-v2.html:10646-10670`). This is the pool the
  user's brief cited as "512" — that number is actually the *fitted*-mode cap; both pools exist
  and are mutually exclusive at any moment (`updateEffects`'s `projecting` branch,
  `bot-viewer-v2.html:10619-10628`), and **neither retains state across frames** — they are redrawn,
  not persisted.

`EFFECT_LIST_CAP = 900` (`bot-viewer-v2.html:10560`) is the outer cap shared by *every* kind of
effect (tracers, sparks, blast layers, smoke puffs, blood) — oldest-eighth-trimmed in blocks when
exceeded (`bot-viewer-v2.html:10600-10605`). A pool system must not compete with this list for the
same slots, or a firefight's spark/tracer volume will evict pools mid-frame.

### Ground placement on uneven terrain

`decalY(x, z, lift) { return groundHeight(x, z) + lift; }` (`bot-viewer-v2.html:702`) is the one
helper every ground-anchored UI/debug marker uses to avoid sinking into slopes. `groundHeight` is
`terrainField.heightAt` (`bot-viewer-v2.html:700`). The terrain field additionally exposes
`slopeAt(x, z, e)` and `normalAt(x, z, out)` (`bot-terrain.js:286,291`, both central-difference over
a baked height grid) — the ingredients for orienting a flat decal to the local ground normal and for
gating pool growth on steep ground are already present and cheap (baked-grid lookup, not raw noise
eval — `bot-terrain.js:137-138` explains why the grid bake exists at all).
`blood_splatter` already resolves its ground Y per-droplet against injected `terrainHeight`
(`effect-renderer.js:649-664`), so the pattern for "decal, but on real ground, not flat world Y=0"
is proven — it's just never applied to something that grows or orients to slope.

### Corpse lifetime (no fixed lifespan — a count cap only)

`killCombatBot` (`bot-viewer-v2.html:4905`) stamps `actor.diedAt` (line 4944) and, when
`ragdollDeathEnabled` (default `true`, `bot-viewer-v2.html:966`), spawns a Verlet ragdoll
(`ragdollFromBody`, line 4965) that settles onto the terrain via `groundHeight`
(`RAGDOLL_DEATH_STEP`, `bot-viewer-v2.html:968`). Corpses have **no timed decay**. `cullDeadBots`
(`bot-viewer-v2.html:3056-3081`) only fires once `deadBotActors.size > botCorpseCap` (default `24`,
line 975), and even then it spares any corpse still inside `MEDIC_DEFAULTS.reviveWindowMs`
(12,000ms, `bot-medic.js:19`) so a medic revive can't be stolen. Eviction is oldest-`diedAt`-first
(line 3064). **A corpse can live the entire session** if the roster never exceeds 24 simultaneous
dead. `disposeBotActor` (`bot-viewer-v2.html:2293`) is the single teardown choke point — called from
`cullDeadBots`, `removeAllBots`, and `clearDeadBotActors` — and is the correct, already-proven hook
for freeing anything a corpse owns (forensics slot release at line 2300 is the existing example).

**Consequence for pool design**: a pool's lifetime must be tied to *its corpse's* lifetime (freed at
`disposeBotActor`), not to a fixed timer like the 6-8s wound stains use — a pool that outlives its
corpse is a floating stain nobody died at; a pool that expires before the corpse is culled makes an
old body look freshly clean.

### Body kind is global, not per-bot (the blocking gap)

`BOT_BODY_KINDS = ['armoured', 'soldier']` (`bot-body-design.js:573`), held in one module-level
`_bodyKind` (line 574). `setBotBodyKind()` changes it for **every bot on the field** and requires a
full rig rebuild to take effect (`bot-viewer-v2.html:12552-12557`, the "Body:" toggle button —
its own title says "Applies to bots already on the field"). There is no per-bot record of which
kind a given bot is beyond "whatever the roster currently is." Grepped for `.bodyKind`/`BodyKind`
across `bot-viewer-v2.html` — only the six global-toggle call sites exist
(`bot-viewer-v2.html:89,93,11755,12054,12316-12319,12552-12557`). **No per-bot class signal exists
in the codebase today.**

### Lighting and audio budgets (both real, both small)

- `DYN_LIGHT_COUNT = 2` (`bot-viewer-visuals.js:37`) — the entire real-`PointLight` budget for
  every flash on screen (muzzle, blast). Comment at lines 32-40: two lights are "permanent per-pixel
  tax, not pay-per-flash," sized for a firefight's *overlapping momentary* flashes, brightest/nearest
  wins each frame (`pickLightSlotsInto`, called at line ~546-560). `flash()` writes into a 64-slot
  ring buffer of flash *records* (`FLASH_CAP = 64`, line 41) that compete for those 2 real lights —
  the ring is cheap, the real lights are the scarce resource.
- `GLOW_POOL = 220`, `SMOKE_POOL = 260` (`effect-renderer.js:43-44`) — additive/smoke sprite pools
  shared by explosion layers, muzzle flash, smoke puffs, and (if reused) fire. Both rebuilt fresh
  each `sync()` call from the live effect list, same pattern as the blood decal pool.
- `combat-audio-budget.js` (`createAudioBudget`, line 68) is a generic priority-preemption budget
  already used for exactly this shape of problem. `AUDIO_PRIORITY.damageLoop = 40`
  (`combat-audio-budget.js:25`) is an **existing sustained-loop category** used today for the
  "failing servo" damage bed on wounded bots. `bot-damage-audio.js:648-690` (`sweepWounded`) already
  implements the pattern a fire-crackle system would need: score every candidate, sort by distance,
  keep only the closest `cfg.maxDamageLoops` (default `2`, `sound-params.js:156`), and reserve a
  sustained voice via `budget.reserveOrPreempt('damage', AUDIO_PRIORITY.damageLoop, meta, {sustained:true})`
  — displacing the *oldest lower-priority* voice when at cap (`combat-audio-budget.js:126-141`).
  `loopCap` defaults to `8` (`sound-params.js:215`); sirens (`maxSirens`, default `3`) +
  damage-loops (`maxDamageLoops`, default `2`) already claim 5 of it, leaving **3 slots of headroom**
  under current defaults — confirmed by `node -e` arithmetic. `sound-params.js:513-517` already
  validates `maxSirens + maxDamageLoops <= loopCap`; a fire-crackle addition must extend that check.

### Materials: `damage-overheat.js` is usable, but not wired

`materials/damage-overheat.js` builds a `MeshStandardNodeMaterial` with two uniforms, `damage`
(permanent, spreads a scorch blotch and roughens the surface) and `heat` (transient, lights emissive
cracks), driven by `mx_noise_float`/`mx_fractal_noise_float` over `positionLocal`
(lines 47-78). Every TSL symbol it imports (`uniform, float, vec3, mix, smoothstep, time,
positionLocal, mx_noise_float, mx_fractal_noise_float`) is a standard `three/tsl` export, not
something exotic — safe to grep-verify against `three.webgpu.js`/`three.tsl.js` (both present
locally at `node_modules/three/build/`) before relying on it, per house rule, but nothing about this
module's node usage is unusual for r0.184. **The material itself is directly usable for "robot looks
damaged/glowing,"** but it is a per-material swap: nothing in `bot-viewer-v2.html` currently applies
`materials/*` to bot shell materials — `bot-body-design.js`/the rig-builder assign plain
`MeshStandardMaterial`/similar, and the materials subsystem's own doc (per user memory,
"materials-subsystem-shipped... game wiring pending") confirms it is unwired. **This is not
combustion** — it has no particles, no ignition state machine, no duration, and its "heat" uniform
is authored as "pulse on each hit, decay to 0," i.e. it's built for hit-flash glow, not a sustained
multi-second burn. Reusable as the *scorch skin* under a burning robot (its `damage`/`heat` uniforms
map naturally onto "how burned" and "currently on fire"), not as the fire itself.

### No fire/combustion system exists anywhere

Grepped `bot-viewer-v2.html`, `particles.js`, `particle-field.js`, `damage-simulator.html` for
fire/flame/burn/ember/smolder outside of unrelated matches (`fireRate`, `fireMode`, etc.) — nothing.
`particle-field.js`/`particles.js` (SP4b GPU compute ember/dust field) is wired into
**`environment-viewer.html` only** (`environment-viewer.html:50,1497-1516`) — not imported anywhere
in `bot-viewer-v2.html`. It is also architecturally the wrong shape for per-bot fire: it spawns
particles in a camera-centered volume (`spawnInVolume`, `particle-field.js:16-22`), not anchored to
a moving/settling world-space emitter per entity. Usable later as a look reference for the GPU
compute→indirect-draw pattern, not as a drop-in.

## 2. The gap

**Pools**: nothing persists. `blood_stain`/`blood_splatter` are 6-8s decals that fade to nothing;
there is no notion of "this ground cell has accumulated blood," no growth-over-time, no
merging of overlapping stains, and no eviction policy scoped to *pools* as opposed to *all effects*.

**Fire**: nothing exists. No ignition trigger, no particle emitter anchored to a bot/corpse, no
burn-duration state machine, no scorch material wiring, no sound, no light policy. `damage-overheat.js`
supplies the skin-damage half of the visual language but not combustion itself.

**Per-bot class**: the signal needed to route "this corpse gets a pool" vs "this corpse catches
fire" does not exist. This blocks routing, not the FX mechanics themselves.

## 3. Design: blood pools

**Representation**: one persistent instanced decal per corpse, not a mesh and not multiple stacked
decals. Reuse the *shape* of `effect-renderer.js`'s `makeDecalPool`/`pushBlood`
(`effect-renderer.js:232-341`) — oriented quad, two in-plane axes, ground normal via
`terrainField.normalAt` instead of a hit normal — but as a **new, separate pool** from the 512-cap
wound-stain pool, for three reasons: (1) pools must never be evicted by a firefight's transient
spray, and the wound pool's per-frame full-rebuild-from-`botEffects` semantics has no "protected"
concept; (2) pools are indexed by *corpse identity* (one deterministic slot per `actor.id`, freed at
`disposeBotActor`), not appended/aged like the wound pool's ring; (3) budget accounting has to be
legible on its own (see §5) — mixing it into the 512 cap makes "how much headroom is left" a
function of firefight intensity, which is exactly the coupling to avoid.

**Growth model**: on the *first* qualifying wound (see "source" below) allocate a pool slot sized to
a small seed radius. Each subsequent qualifying tick while the bot is alive-and-bleeding, or while
freshly dead, grows the *existing* slot's scale/alpha toward a per-body-size cap — never spawns a
second decal. This keeps the cost flat at 1 draw-call-worth-of-instance-data per corpse regardless of
how long it bleeds, which is the only way to keep the budget in §5 a hard number instead of a
function of fight duration.

- **Source — bleeding while alive**: only for bots below a low-health threshold (mirror
  `MEDIC_DEFAULTS.healAllyThreshold01 = 0.65`, `bot-medic.js:15`, as the "wounded enough to leave a
  trail" gate, since that threshold already exists and means "an ally would break off to heal this
  bot" — a reasonable proxy for "visibly hurt"). Growth rate scales with how far below threshold, so
  a bot at 5% HP pools faster than one at 60%.
- **Source — death**: on `killCombatBot`, seed a pool immediately at the death XZ
  (`deathXZ`, `bot-viewer-v2.html:4931,4945`) sized larger than any pre-death seed, then continue
  growing (up to the per-body cap) for a short window afterward (bleed-out), matching how ragdolls
  already settle over a few frames before `botRagdollAsleep` (`bot-viewer-v2.html:3048-3050`).
- **Merging overlapping pools**: not for v1. True merging (boolean-combining two decal footprints)
  needs either a shared render target or SDF blending, neither of which exists here, and the existing
  decal tech (`projected-decals.js`, `effect-renderer.js`'s oriented-quad pool) has no compositing
  step between instances — they just z-fight-avoid via `lift`. Cheap approximation: when two corpses'
  pool centers land within a body-width of each other, cap the *later* one's growth so its footprint
  visually laps onto the earlier one's edge rather than drawing a second full-size blob on top. Flag
  true merging as a v2 idea, not a v1 requirement.
- **Terrain slope**: orient the decal quad to `terrainField.normalAt(x, z)` (proven API,
  `bot-terrain.js:291`) rather than hardcoding `[0,1,0]` the way `blood_splatter` does today
  (`effect-renderer.js:667`, flat normal is fine for an 8s mark, wrong for something meant to look
  soaked into a hillside for a minute). Above `terrainSettings.maxSlope` (the same gate nav already
  uses, `bot-viewer-v2.html:6798,6806`), skip pool growth entirely and fall back to the existing
  `blood_splatter` behavior — a pool "pooling" on a wall-steep slope doesn't read as blood, it reads
  as a decal bug. This is the honest answer to "pools on a slope": **flat-to-moderate ground only in
  v1**, gated by the same slope constant the nav grid already respects, not a physically-simulated
  flow-downhill model.
- **Placement height**: `decalY(x, z, 0.01-ish lift)` exactly as every other ground marker in the
  file does (`bot-viewer-v2.html:702` and its ~15 call sites) — no new height logic needed.

**Eviction when the pool budget is exhausted** (see §5 for the number): pools are keyed 1:1 to
`deadBotActors` membership, so eviction is **free** — it already happens. When `cullDeadBots` culls a
corpse (`bot-viewer-v2.html:3056-3081`, oldest-`diedAt`-first, respecting the 12s revive window), the
same `disposeBotActor` call that releases the forensics slot (line 2300) also releases that corpse's
pool slot. No separate LRU is needed as long as the pool budget is ≤ `botCorpseCap`; if the pool
budget is set *below* `botCorpseCap` (recommended, see §5), pools need their own age-based eviction
independent of corpse culling — oldest-pool-first, same pattern, smaller cap.

## 4. Design: fire

**Trigger**: ignition is a probability roll at `killCombatBot`, weighted by `credit.cause`
(`'bullet' | 'knife' | 'blast'`, confirmed values at `bot-viewer-v2.html:2598,5849,10454,10535`) —
blast kills should ignite far more often than bullet kills, matching the fiction ("damaged or
destroyed robot catches fire" reads as explosive/overheat damage, not a clean headshot). Requires
the per-bot class field from §6 to gate "robot only" (armoured-human "may do both" per the brief is a
§6-dependent refinement, not a v1 blocker — v1 can ship robot-only fire against the current global
body-kind toggle and revisit once class is per-bot).

**Particles**: reuse `effect-renderer.js`'s existing `glow`/`smoke` sprite pools
(`GLOW_POOL=220`/`SMOKE_POOL=260`, `effect-renderer.js:203-217`) rather than building a third pool
system — a burning bot is visually "small warm glow sprites + rising dark smoke," which is exactly
what `drawExplosion`'s ember/smoke layers already do (`effect-renderer.js:390-401,420-438`) with
per-hash deterministic scatter. A `fire` effect kind can be added to `entity-types/effect.js`
alongside the existing eight, sustained (no fixed short life — driven by an explicit "extinguish"
state change rather than an age-out), spawning a handful of flame-glow sprites plus 1-2 smoke puffs
per active-fire per frame, anchored to the corpse's settled ragdoll position (or the live bot's torso
while still standing and burning-but-alive, using the same `attach` handle mechanism `blood_stain`
already uses via `resolveAttachmentMatrix`, `bot-viewer-v2.html:10567-10570`).

**Material**: `materials/damage-overheat.js` as the *scorch skin* — map its `damage` uniform to
`1 - hp01` (as its own doc comment already prescribes, line 24) and its `heat` uniform to "currently
on fire" (1.0 while burning, decaying after extinguish) instead of "pulse per hit." This requires
actually wiring a `materials/*` output onto the bot shell material for the first time in this
codebase — the real engineering cost here isn't the material, it's building the (currently
nonexistent) plumbing from "bot mesh material" to "swappable TSL node material," which today doesn't
exist for any bot. Treat this as its own phase (§7) with its own fallback: if the wiring proves
non-trivial under time pressure, ship fire as pure particles/light first and skin-scorch second — the
particles alone sell "on fire" without the material.

**Light**: **no real `PointLight` in v1.** The 2-slot dynamic-light budget
(`DYN_LIGHT_COUNT=2`, `bot-viewer-visuals.js:37`) is architected for momentary (~0.1-0.3s) flashes
competing on a per-frame brightest/nearest basis (`pickLightSlotsInto`); a fire burning for 10-20s
would either permanently occupy a slot (starving every muzzle flash and blast near it for the whole
burn) or lose the brightest/nearest contest to any nearby gunfire and effectively never light
anything. Sell "burning" with the additive glow sprites' own emissive brightness (the same trick
`drawExplosion`'s fireball layer already relies on, `effect-renderer.js:352-356`) plus, if bloom is
active in the post-fx stack, let the additive blending do the "glowing" work it already does for
muzzle flashes. Revisit a dedicated slot only if a browser look-check shows the sprite-only glow
reads as too dim — that's a one-line follow-up (`DYN_LIGHT_COUNT` 2→3, dedicating the third to
sustained fire specifically, exempt from the flash ring's per-frame recompute), not a redesign.

**Sound**: reuse `combat-audio-budget.js`'s existing sustained-loop machinery exactly as
`sweepWounded` does today (`bot-damage-audio.js:648-690`) — a `sweepBurning(now)` that scores every
active fire by distance, keeps the closest N, and calls
`budget.reserveOrPreempt('damage', AUDIO_PRIORITY.damageLoop, meta, {sustained:true})` per kept fire
(or a new `AUDIO_PRIORITY.fireCrackle` tier between `damageHit` (50) and `damageLoop` (40) if fire
should outrank a servo-arc bed but not a death siren — a product call, not an engineering one).
Extinguish stops the loop the same way `endSiren`/`stopLoop` already do.

**Duration**: not a fixed short life like wound stains. A burn should last long enough to read as an
aftermath (tens of seconds), then transition to a *cheap smolder* — drop to zero glow sprites and
zero sustained sound, keep one slow-rising smoke puff every second or two, no light contest, no audio
slot — before fully extinguishing. This mirrors the flash-budget philosophy already in this codebase
(brightest/most-recent wins the expensive resources; everything else degrades to a cheap
approximation rather than disappearing or costing full price forever).

**Spread**: **per-bot only in v1.** Fire spreading to nearby bots, vegetation, or props needs a
proximity query against every other live/dead entity every frame that no existing system does today
(the closest analog, `refreshGrenadeThreats`, `bot-viewer-v2.html:3111`, is a once-per-frame scan of
*live projectiles*, not a spatial "what's near this burning corpse" query) — real new work, not a
wiring job. Ship isolated per-bot fire first; propose spread as a separate, later idea if the
isolated version reads as too static.

## 5. Budget

| Resource | Existing ceiling | Proposed addition | Interaction |
|---|---|---|---|
| Ground decal pools (fitted mode) | `maxBloodDecals = 512` (`effect-renderer.js:120`) | **New, separate pool**, cap **24** (= `botCorpseCap` default, `bot-viewer-v2.html:975`) — one slot per corpse, no growth beyond one instance | Zero overlap with the 512 cap; a firefight's wound-stain volume can never evict a pool and vice versa. 24 × 52 bytes ≈ 1.25 KB — capacity is a non-issue, the cap exists to bound *draw-call growth over a long session*, not memory. |
| Projected decal pool (Mode C) | `cap = 256` (`bot-viewer-v2.html:10639`) | Pools are **not supported in projected mode in v1** — `projected-decals.js`'s `begin()/push()/end()` is called fresh every frame from `botEffects` (`bot-viewer-v2.html:10646-10670`); pools living outside `botEffects` would need a second `createProjectedDecals` instance mirroring the fitted-mode split above. Ship fitted-mode-only, document the gap, extend later if `botStainRender` usage data shows projected mode is the common case. | N/A |
| Glow sprite pool | `GLOW_POOL = 220` (`effect-renderer.js:43`) | ≤6 simultaneous full-VFX fires × 4 flame sprites = 24 slots (measured via `node -e`) | 24/220 ≈ 11% of the pool, contending with muzzle flashes and blast fireballs during the worst-case moment (a firefight next to a burning robot) — acceptable but not free; the "full-VFX fires" cap (not "all active fires") is what keeps this bounded (see smolder degrade in §4). |
| Smoke sprite pool | `SMOKE_POOL = 260` (`effect-renderer.js:44`) | ≤6 fires × 2 puffs = 12 slots, **plus** every smoldering (post-full-burn) fire keeps 1 puff every 1-2s | Small; smoke is the cheapest resource here. |
| Dynamic point lights | `DYN_LIGHT_COUNT = 2` (`bot-viewer-visuals.js:37`) | **Zero** — v1 fire claims no real light (§4). | This is the resource most likely to break combat readability if violated (a sustained slot-holder starves every muzzle flash near it) — treat "give fire a light" as a deliberate, separately-reviewed follow-up, not a default. |
| Sustained audio voices | `loopCap = 8` (`sound-params.js:215`), `maxSirens=3` + `maxDamageLoops=2` = 5 claimed by default | Cap **2** simultaneous fire-crackle loops (`maxFireCrackles`, new `sound-params.js` field, mirroring `maxDamageLoops`'s shape) | 5 + 2 = 7 ≤ 8, matches current headroom exactly with zero slack — either raise `loopCap` or accept that a mass-death moment (3 sirens + 2 damage beds + 2 fires = 7) plus one more sustained voice from anywhere else in the mix will start preempting by priority. Extend the existing `sound-params.js:513-517` validation to include `maxFireCrackles`. |
| Effect list (`botEffects`) | `EFFECT_LIST_CAP = 900` (`bot-viewer-v2.html:10560`) | Pools live **outside** this list entirely (their own array, keyed by corpse id) — a `fire` effect kind, if implemented as a `entity-types/effect.js` kind, **does** count against this list, same as any other effect, since it needs the existing `pushEffect`/expiry machinery for its glow/smoke sub-draws. | A long fire is one entry in a 900-cap list; negligible. |
| Corpse count | `botCorpseCap = 24` default (`bot-viewer-v2.html:975`) | Pools/fires are both keyed 1:1 to corpse identity, so corpse culling *is* their eviction policy (§3) — no double-bookkeeping. | Lowering `botCorpseCap` automatically lowers pool/fire headroom; no separate slider needed unless product wants pools to outnumber visible corpses (not recommended — a pool with no corpse reads as a bug). |

**Eviction rule, stated once**: every persistent-FX slot (pool or fire) is owned by exactly one
corpse/bot id. The slot is freed the instant that id leaves `deadBotActors` (pool/fire) or is
revived (fire, since a revived bot shouldn't still be on fire — pool can persist as "old blood," it
already happened). No independent LRU, no separate cap-vs-current-count check beyond "does this
corpse still exist" — reusing `disposeBotActor` (`bot-viewer-v2.html:2293`) as the one teardown choke
point, exactly as forensics slots already do (line 2300), is both the simplest implementation and the
one least likely to leak, since it's a single already-proven hook rather than a new one.

## 6. Dependency on idea 3's class descriptor

Needed, concretely:

1. **A per-bot field**, not a global toggle. Today `getBotBodyKind()` (`bot-body-design.js:576`)
   answers for the whole roster; killCombatBot/pool-routing needs `actor.bodyKind` (or whatever idea
   3 names it) readable per corpse at time of death.
2. **A stable value while `_bodyKind` may still be global.** If idea 3 ships the per-bot field before
   making the roster genuinely mixed (i.e. `setBotBodyKind` still rebuilds everyone to one kind), this
   plan's routing degrades gracefully to "read the one global kind" — worth stating explicitly so
   idea 4 isn't blocked on idea 3's full mixed-roster support, only on the field existing.
3. **The "armoured humans may do both" case is explicitly idea 3's territory**, not idea 4's — idea 3's
   brief already describes armoured humans bleeding *and* sparking/smoking, "but only bleed at low
   health." This plan's pool-growth gate (§3, `healAllyThreshold01`-style threshold) is written to
   compose with that: an armoured-human's pool source becomes "low health AND class=armoured," fire
   source becomes an idea-3-owned spark/smoke event rather than this plan's kill-time roll. No new
   idea-4 work, just correct routing once the field exists.

**If idea 3 does not ship first**: this plan can still ship fire-only (gated on the current global
`getBotBodyKind() === 'armoured'`) and pool-only (gated on `'soldier'`) as a temporary, whole-roster
approximation — correct only when the operator hasn't mixed kinds, which today they structurally
can't anyway. Flag this explicitly as the fallback, not a redesign.

## 7. Phases

Each phase is independently shippable; later phases degrade gracefully if earlier ones are the only
ones that land.

**Phase 1 — pool data model + Node tests, no rendering.**
A pure module (mirrors `bot-medic.js`'s THREE-free style) that owns: per-corpse pool state (seed
time, growth curve, current radius/alpha, slope-gated flag), the eviction hook contract
(`onCorpseRemoved(id)`), and the merge-lap approximation math from §3. Test file:
`test-blood-pools.mjs` (growth curve monotonicity, slope-gate skip, eviction on removal, budget cap
respected). No THREE, no scene — same reason `bot-medic.js`/`particle-field.js` are pure math:
Node-testable without a GPU.

**Phase 2 — pool rendering.**
New instanced decal pool (cap 24, per §5), wired into `bot-viewer-v2.html`'s render loop alongside
the existing `effectRenderer.sync()` call site (`bot-viewer-v2.html:10626`). Orient via
`terrainField.normalAt`, place via `decalY`. Hook Phase 1's `onCorpseRemoved` into
`disposeBotActor` (`bot-viewer-v2.html:2293`). No browser verification performed as part of this
plan (per the task's constraints) — flag for a look-check once implemented.

**Phase 3 — fire ignition + particle-only burn (no material, no light, no sound).**
`fire` effect kind in `entity-types/effect.js`, ignition roll at `killCombatBot`
(`bot-viewer-v2.html:4905`), reuses `glow`/`smoke` pools per §4/§5. Test file: `test-fire-ignition.mjs`
(ignition probability by cause, budget cap enforcement — closest-N-wins when over cap, mirroring
`sweepWounded`'s `candidates.sort`/`.slice` pattern, smolder-transition timing).

**Phase 4 — fire sound.**
`sweepBurning()` in `bot-damage-audio.js`, new `maxFireCrackles` param in `sound-params.js`
(extend the existing validator at `sound-params.js:513-517`). Test file: extend
`test-bot-damage-audio.mjs` if it exists, or add `test-fire-audio.mjs` — budget-cap and
priority-eviction behavior can be tested against `combat-audio-budget.js` directly, no audio hardware
needed (same reason `combat-audio-budget.js`'s own header calls it Node-testable in isolation).

**Phase 5 — scorch material wiring (optional, higher-risk).**
Build the (currently nonexistent) plumbing to swap a bot shell material for a
`materials/damage-overheat.js` instance, wire `damage`→`1-hp01`, `heat`→burning state. This is the
riskiest phase because it touches material-assignment code that has never been exercised for bots
before — explicitly scoped last and optional so Phases 1-4 ship value (pools + burning-with-particles)
even if this phase stalls.

**Phase 6 — per-bot class routing (blocked on idea 3).**
Swap the kill-time global-kind check (§6 fallback) for a real per-bot field once idea 3 lands it.
Small, mechanical change if Phases 1-5 were written with the field name as a single lookup point
(recommend a single `boolIsRobot(actor)` helper from day one, even while it only reads the global
toggle, so this phase is a one-function edit).

## 8. Dependencies and conflicts with the other three ideas

- **Idea 1 (bullet wounds at stain center)** touches the *wound-stain* system
  (`blood_stain`/`makeStainTexture`), which this plan deliberately keeps separate from the new pool
  system (§3). No file overlap expected beyond both reading `BLOOD_RED`/similar constants. If idea 1
  changes `blood_stain`'s decal texture or attach semantics, pools are unaffected since they don't
  reuse that pool.
- **Idea 2 (limb loss)** would change what a corpse's mesh/attach points look like at death time —
  if a limb is missing, the pool's death-seed position (currently `deathXZ`, capsule-center-based)
  and any future fire-attach point should probably originate from the wound location, not the
  capsule center. Not a blocker for Phase 1-4 (capsule center is a fine default), but worth a shared
  TODO if idea 2 ships first: route pool/fire origin through idea 2's wound-location data instead of
  `deathXZ`.
- **Idea 3 (class descriptor)**: the hard dependency, covered fully in §6. Idea 3's own design should
  be told that idea 4 needs the descriptor to be **per-bot-readable at kill time**, not just a
  rendering-time lookup — `killCombatBot` is a one-shot event (`bot-viewer-v2.html:4905`), so if the
  class field isn't resolvable synchronously there, ignition/pool-source routing can't happen at the
  moment that matters.
- **Shared budget contention across all four ideas**: every idea in this set pulls from the *same*
  `GLOW_POOL`/`SMOKE_POOL`/`bloodPool`/`EFFECT_LIST_CAP`/audio-budget ceilings. None of the four plans
  can size its own budget in isolation — whichever ships first should leave explicit headroom notes
  (this plan does, §5) so the next idea's author isn't surprised the pools are already 40% claimed.

## 9. Open questions

1. Should a *bleeding-while-alive* pool (not just a death pool) exist at all in v1, or is that scope
   better deferred to keep Phase 1 smaller? The design in §3 supports it, but it roughly doubles
   Phase 1's state machine (two growth sources instead of one) for a effect that's easy to miss during
   a moving firefight.
2. Is `botCorpseCap`-sized pool budget (24) actually the right number, or should pools have their own
   independently-tunable slider like `corpseCapInput` (`bot-viewer-v2.html:12475-12479`) does for
   corpses? Recommend starting tied to `botCorpseCap` (§5) and splitting only if playtesting wants
   pools to persist longer/shorter than corpses independently.
3. Where does "smolder" actually stop — does a fully-smoldered-out fire leave any permanent visual
   mark (a scorch decal, reusing the pool-decal mechanism from §3 with a black/gray texture instead of
   red), or does it just vanish once the last smoke puff fades? A scorch-mark-on-extinguish would reuse
   nearly all of the pool infrastructure from §3 for free — worth deciding before Phase 3, since it
   changes whether Phase 3 needs Phase 1's pool allocator as a dependency.
4. `DYN_LIGHT_COUNT` 2→3 was floated in §4 as a cheap follow-up if particle-only fire reads too dim —
   should that decision wait for an actual look-check (per this repo's "report what the render shows"
   convention), or is it safe to bundle into Phase 3 speculatively? Recommend waiting for the look-check;
   the cost of being wrong (a wasted light slot during every firefight) is higher than the cost of a
   follow-up phase.
5. Should `AUDIO_PRIORITY` get a dedicated `fireCrackle` tier (between `damageHit`=50 and
   `damageLoop`=40) or reuse `damageLoop` outright (§4)? This is a product/feel call the plan
   deliberately left open rather than guessing.
