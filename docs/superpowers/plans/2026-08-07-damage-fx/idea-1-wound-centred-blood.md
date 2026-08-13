# Idea 1: Wound-centred blood stains + health-driven drip/spray

**The idea**: darken the center of a `blood_stain` decal so it reads as a wound, not just a red
smear, and scale the accompanying spray/splatter from a light drip (healthy bot) to a full burst
(near-dead bot).

**Hardest problem**: none of it is hard, which is itself the finding — `bot-viewer-v2.html` already
does per-part hit resolution, attachment, and fitted sizing for every blood hit by default
(`botWoundHitMode = 'mesh'`, `bot-viewer-v2.html:10584`). The only real design risk is a wrong
choice of which signal to darken from — see "Design" for why the blob mask's own alpha is the wrong
one and quad-local geometry is the right one.

**Recommendation**: build it. Both halves are small, additive, shader/caller-side changes to code
that already exists and already runs on every hit. No new wire fields, no new pool, no new
per-frame cost.

---

## 1. What exists today

The full hit → blood pipeline, already live in `bot-viewer-v2.html`, in call order:

1. **Hit detection** — `fireBotShot` (`bot-viewer-v2.html:10466`) → `resolveHitscan`
   (`combat.js:172`) against `combatCapsuleFor(botTarget)` (`bot-viewer-v2.html:2358`), one 0.3 m
   vertical capsule for the whole bot. This step knows nothing about limbs.
2. **Damage application** — `applyCombatDamage` (`bot-viewer-v2.html:5870`) →
   `applyBotDamage` (`:5831`) for real bots, or the dummy-target branch (`:5877`) for training
   dummies. Both call `spawnHitBloodFx` **before** mutating `target.health`
   (`:5835`, `:5880`; the blast loop does the same at `:10444`).
3. **Blood FX spawn** — `spawnHitBloodFx(point, normal, target, sourcePoint)` (`:10725`).
   Gated on `botBloodFxEnabled` (default `true`, `:10575`). When `botWoundHitMode === 'mesh'`
   (**the default**, `:10584`) it calls `refineWoundHit` (`:10707`), which re-traces the shot
   against the bot's actual rig via **`resolveBodyHit`** (`bot-body-hit.js:129`, imported at
   `bot-viewer-v2.html:99`) — a ray/AABB walk over `body.parts.all`, run once per hit, not per
   frame (`ensureMatrices` only refreshes on demand, `bot-body-hit.js:45`). This returns the true
   surface point, its normal, `crossSection` (part width) and an `attach` handle.
   `spawnHitBloodFx` then sizes the stain from `crossSection` (`STAIN_FIT = 0.55`,
   clamped `[0.03, 0.16]`, `:10586-10588`) and pushes four effects: `hit_spark`, `blood_spray`
   (count 28, size 0.03, speed 4.2, spread 1.0, gravity 9.8), `blood_stain` (size from the fit,
   opacity 0.92, carries `attach`), `blood_splatter` (count 10, size 0.12, opacity 0.8).
4. **Draw** — `effect-renderer.js`'s `sync()` regenerates every sub-particle each frame from the
   wire object + id hash + age (`effect-renderer.js:671`). Blood-relevant pieces:
   - `blood_spray` reuses the additive line/point pool — gravity-arced droplet streaks, no
     dedicated buffer (`:560-586`).
   - `blood_stain` and `blood_splatter` share one **instanced decal pool**,
     `maxBloodDecals = 512` (`:120`), one draw call. Each instance carries `instPos` (world
     centre), `instTan`/`instBit` (in-plane axes, already scaled by size — 6 floats, no matrix,
     `:236-271`), `instColor`, `instAlpha`. Material is `MeshBasicNodeMaterial`,
     `colorNode = attribute('instColor')` (flat per-instance RGB, **no per-pixel color
     variation today**), `opacityNode = attribute('instAlpha').mul(texture(stainTex).a)`
     (`:256-263`). `stainTex` is `makeStainTexture` (`:82-114`): a 128 px canvas, one big
     off-centre-ish core lobe at `(0.5,0.5)` r=0.30, seven smaller fused lobes at
     `r∈[0.10,0.26]` from centre, twelve small detached droplets scattered further out —
     **alpha-only**, rgb is always white. `lift` (surface offset) is size-scaled for stains,
     fixed for splatter (`:168-172`, `pushBlood` at `:321-341`).
   - `blood_stain` with an `attach` handle is redrawn from the live body-part matrix every frame
     (`drawBloodStain`, `:594-623`; `resolveAttachmentMatrix`, `bot-body-hit.js:87`). Without one,
     or when it stops resolving, it freezes at the last resolved world pose (`:597-611`).
   - A parallel **Mode C** path, `projected-decals.js`, exists and is selectable via
     `botStainRender` (`'fitted'` default vs `'projected'`, `bot-viewer-v2.html:10585`). It draws
     depth-projected boxes instead of flat quads, reusing the **same** `stainTex` for alpha
     (`projected-decals.js:98`) and also has a flat, unvaried `instColor` for colour
     (`:97`). Whatever I change in the Fitted decal material needs a parallel change here for the
     two modes to look consistent, or an explicit note that they diverge.
5. **Correction to the shared context brief**: bullet 2 states `resolveBodyHit`'s "ONLY callers are
   `damage-simulator.html:323` and `:330`." That is stale. `bot-viewer-v2.html` imports and calls it
   too (`import { resolveBodyHit, resolveAttachmentMatrix } from './bot-body-hit.js'` at
   `bot-viewer-v2.html:99`; call site `bot-viewer-v2.html:10723` inside `refineWoundHit`), and does
   so **by default** in production, not as an opt-in harness feature. This matters a lot for section
   4 below — the wiring this idea might have needed is already done.

`damage-simulator.html` (`fireHit`, `:334-385`) is the tuning harness and has **no concept of
health at all** — confirmed by grep, zero matches for `health` in the file. Its `settings` object
hardcodes spray/stain/splatter magnitudes as sliders; there is no bot HP to drive anything from.

## 2. The gap

Two independent, small gaps:

1. **No wound centre.** The decal material has exactly one colour per instance
   (`colorNode = attribute('instColor')`) and the mask texture only ever supplies alpha. A stain is
   a flat-coloured, feather-edged blob — visually a puddle, not a puncture with blood radiating from
   it.
2. **No health-driven intensity.** `spawnHitBloodFx`'s spray/splatter parameters
   (count/speed/spread/size/opacity) are constants (`:10586-10588`, `:10742-10749`). Every hit —
   grazing or lethal — spawns the identical 28-droplet burst and 10-decal splatter pattern.
   `applyBotDamage` already computes a post-hit health fraction (`hpAfter01`, `:5848`) but computes
   it **after** `spawnHitBloodFx` already ran (`:5835` precedes `:5838`'s mutation), so the value
   isn't available where it's needed yet. `damage-simulator.html` has nothing to drive this from at
   all — it would need a synthetic health slider.

## 3. Design

### 3a. Wound centre

**Rejected approach**: reuse the stain texture's own alpha as a "core-ness" factor
(`mix(instColor, coreColor, texture(stainTex).a)`, since the biggest lobe is at the centre and
alpha is highest there). Traced through `makeStainTexture`'s geometry (`effect-renderer.js:100-109`)
and rejected: the seven "fused lobes" are drawn at `r ∈ [0.10, 0.26]` from centre with their own
radius up to `~0.20`, so they reach alpha≈1 in patches that are **not** near the quad's geometric
centre. Driving colour from alpha would paint several dark blotches scattered across the stain
instead of one wound at the middle — wrong shape for "radiates from a centre."

**Chosen approach**: drive the mix from **quad-local geometry**, not the texture at all.
`positionGeometry.xy` is already available in this material's node graph (imported already,
`effect-renderer.js:39`) and ranges `±0.5` per instance regardless of which decal it is. Compute a
radial distance from the decal's own centre and mix towards a darker colour as that distance shrinks:

```
// effect-renderer.js, makeDecalPool's material setup
const dist = length(positionGeometry.xy);
const core = float(1.0).sub(smoothstep(uniforms.woundInner, uniforms.woundOuter, dist));
mat.colorNode = mix(attribute('instColor'), attribute('instColor').mul(uniforms.woundDarken), core);
```

Why this over a fixed "wound red" colour: `attribute('instColor').mul(darken)` darkens *whatever*
colour the instance already carries instead of a hardcoded blood shade. `blood_splatter` shares this
same material and pool, so ground droplets get the same treatment for free — and it reads as
correct there too (a droplet has a denser core). It also means a future non-blood decal on this pool
(idea 3's scorch marks, say) keeps working without hardcoding red into the shared material — it
would want its own `woundDarken`/inner/outer, which is the one thing this design does *not* make
free (see §7).

Constants: start with `woundInner ≈ 0.06`, `woundOuter ≈ 0.28` (quad half-width units — so on a
fitted forearm decal, ~0.052 m half-width per fx.md's measured table, the fully-dark centre is
roughly a 6 mm-radius puncture, fading out by ~30 mm). `woundDarken ≈ 0.2-0.3`. These should be
**uniforms**, not baked constants, exactly like every other live-tunable decal parameter in this
file (`post-fx.js`/particle precedent: everything except pool capacity is a live uniform write) —
that makes them tunable from `damage-simulator.html` without a material rebuild.

**Attachment**: nothing new needed. The wound centre is a per-fragment shader effect on a decal
whose *position and orientation* are already driven by `instPos`/`instTan`/`instBit`, which already
ride the `attach` handle's live body-part matrix every frame (`drawBloodStain:594-623`,
`bot-body-hit.js`'s `resolveAttachmentMatrix`). The wound centre inherits that for free — it is
baked into the same quad, not a separate object that needs its own attachment.

**Mode C parity**: `projected-decals.js`'s material (`:60-99`) needs the identical
`colorNode` change (same `positionGeometry`-in-box-local-space math is already computed there as
`local.xz`, so the radial distance is `length(local.xz)` instead) or the Projected stain toggle will
visibly regress relative to Fitted. Same uniforms, duplicated material, no shared module today (this
file and `effect-renderer.js` don't share a material factory) — that duplication already exists for
other params (`lift`, spin, the helper-axis swap) so this follows the file's existing convention
rather than introducing a new one.

### 3b. Health-driven drip vs. spray

**Rejected framing**: two discrete visual *systems* (a literal "drip" that runs down the body over
time vs. a "spray" burst). A true crawling drip would need `blood_stain`'s render function to grow
or translate as a function of age — technically possible (`drawSmokePuff` already does age-driven
growth statelessly, `:527-554`, so the pattern exists) but it's new geometry logic, a new wire field
or two, and a `EffectEntity.serialize` whitelist change (`entity-types/effect.js:139-145`) — real
scope for a look the continuous version below already delivers.

**Chosen approach**: keep `drip` and `spray` as **the same existing `blood_spray` /
`blood_splatter` kinds**, just continuously re-tuned by a health-driven intensity factor. This is
zero new wire fields, zero new effect kinds, zero shader work — purely caller-side arithmetic
already legal today, since every one of these fields (`count`, `speed`, `spread`, `size`, `opacity`)
is already a per-call parameter `spawnHitBloodFx` and `fireHit` set explicitly.

```
// pure, Node-testable — proposed export from effect-renderer.js
export function bloodIntensityForHealth(hp01) {
  const t = Math.max(0, Math.min(1, 1 - (Number.isFinite(hp01) ? hp01 : 0))); // 0 = healthy, 1 = dying
  const lerp = (a, b) => a + (b - a) * t;
  return {
    sprayCount: Math.round(lerp(3, 28)),
    spraySpeed: lerp(1.0, 4.2),
    spraySpread: lerp(0.25, 1.0),
    splatterCount: Math.round(lerp(0, 10)),
    splatterOpacity: lerp(0.5, 0.8),
  };
}
```

Numbers at `t=1` (near-dead) intentionally match the *current* hardcoded defaults, so a badly
wounded bot looks exactly like today's blood FX — the change is additive at the healthy end, not a
regression at the lethal end. At `t=0` (full health) the spray nearly disappears (3 slow, tight
droplets) and splatter is suppressed to 0 — a light hit reads as "barely bled," which is the "drip"
half of the ask: a thin, low-speed, tightly-clustered droplet burst under the *existing*
`blood_spray` renderer (gravity-arced short streaks) already looks like a trickle rather than an
explosion once `count`/`speed`/`spread` are this low — no new rendering path required.

**Justification for this mapping over a hard drip/spray toggle**: combat health degrades
continuously (many small hits, not one binary state), and a threshold would make the 31st point of
damage look identical to the 30th but suddenly very different from the 29th. A continuous lerp reads
as "the more hurt this bot is, the more it's bleeding," which matches how the rest of this codebase
already treats health (`damage-overheat.js`'s `damage` param is explicitly documented as `1 -
health/maxHealth`, driving continuous scorch spread — same idiom, already precedented in this repo).

**Wiring**: `spawnHitBloodFx` needs the health fraction *after* the hit, which none of its three
call sites currently have at call time (all three call it before mutating health:
`applyBotDamage:5835`→health set at `:5838`; the dummy branch `:5880`→`:5883`; the blast loop
`:10444`→`:10445`). Cheapest correct fix: pass `amount` and let `spawnHitBloodFx` compute
`hp01 = clamp((target.health - amount) / (target.maxHealth ?? DUMMY_MAX_HEALTH))` itself, mirroring
the existing `hpBefore01`/`hpAfter01` pattern in `applyBotDamage` (`:5836-5848`) instead of
triplicating the calc at each call site. `target`/`amount` are already in scope at all three
existing call sites, so this is a signature change (`spawnHitBloodFx(point, normal, target,
sourcePoint, amount)`) with a `Number.isFinite(amount) ? … : 1` fallback so the pre-existing "no
amount" call shape can't crash if a fourth caller is added later without it.

`damage-simulator.html` has no bot health to read, so it needs a synthetic **health slider** (0-1,
default e.g. 0.5) in `settings`, feeding `bloodIntensityForHealth` the same way — this is the
harness's usual role (see `botWoundHitMode`/`botStainRender`'s harness-first precedent in
`fx.md`'s "Two harness controls exist specifically so the harness can show the defects it is
judging").

## 4. Does per-part hit resolution need wiring in?

**No — it already runs, and already runs by default.** `bot-viewer-v2.html:10584` sets
`botWoundHitMode = 'mesh'` as the initial value, which routes every blood-FX spawn through
`refineWoundHit` → `resolveBodyHit` (`bot-body-hit.js:129`) before this idea touches anything. That
call already happens once per hit (not per frame — `ensureMatrices` only walks the rig on
`refresh:true`, which `refineWoundHit` passes explicitly, `bot-viewer-v2.html:10723`), and already
produces the `attach` handle and `crossSection` this idea's wound-centre design leans on. This idea
adds **zero** new calls to `resolveBodyHit` and zero new per-hit CPU work beyond the tiny
`bloodIntensityForHealth` arithmetic (five `lerp` calls, no allocation).

The one thing this idea's health-lookup needs that isn't already threaded through is `amount` at
the `spawnHitBloodFx` call sites — see §3b's wiring note. That's a parameter pass, not new
resolution work.

## 5. Cost

**Measured**: nothing — no GPU profiling was run (per the task's constraint: no browser). Every
number below is either arithmetic or drawn from the existing, already-shipped pool sizing in
`fx.md`.

- **Draw calls**: **zero new draw calls.** The wound centre is a `colorNode` change to the existing
  decal material (one draw call, unchanged) and the equivalent one in `projected-decals.js`. The
  intensity mapping only changes `count`/`speed`/`spread`/`opacity` values already passed into
  effect kinds that reuse the existing additive line/point pool and the existing decal pool.
- **Per-hit CPU**: `bloodIntensityForHealth` is 5 arithmetic ops, no allocation, called once per
  `spawnHitBloodFx` invocation (already once per hit). Negligible next to the AABB walk
  (`resolveBodyHit`) already paid on the same call path.
- **Per-frame GPU**: the wound-centre shader adds `length` + `smoothstep` + one extra `mix` to the
  decal fragment shader — a handful of ALU ops on a pool whose fragment footprint is small screen-
  space quads (decals sized 0.03-0.16 m). No new texture fetch (`positionGeometry` is a varying, not
  a sample); the existing `texture(stainTex).a` fetch is unchanged. This is the kind of cost the
  particle/post-fx system already treats as "a uniform write, not a rebuild" — estimated
  negligible, not measured.
- **Pool pressure**: worst case per hit today is 1 `blood_stain` + up to 10 `blood_splatter`
  instances = 11 of the shared 512-slot decal cap. This idea's intensity mapping *reduces*
  `splatterCount` for lightly-wounded hits (down to 0) and never raises it above the current default
  of 10 at the lethal end — so the worst case is unchanged and the typical case (most hits, most
  bots, most of a firefight, are not point-blank kill shots) drops. No pool resize needed.
- **Wire size**: unchanged. No new fields on `blood_stain`/`blood_spray`/`blood_splatter` — every
  value `bloodIntensityForHealth` produces already has a slot in the existing wire shape.

## 6. Phases

Each phase is independently shippable; Phase 1 and Phase 2 do not depend on each other and could
ship in either order or as one combined change if preferred.

**Phase 1 — wound centre (visual only, no health logic).**
- Add `woundInner`/`woundOuter`/`woundDarken` uniforms and the `colorNode` mix to
  `makeDecalPool`'s material in `effect-renderer.js`.
- Mirror the same in `projected-decals.js`'s material for Mode C parity.
- Extract the mix math as a pure function (`woundCoreFactor(dist, inner, outer)`, matching this
  repo's CPU/GPU-math-twin convention — `particle-field.js`/`post-grade.js` are the precedent named
  in `CLAUDE.md`) so it is Node-testable without a GPU: assert `factor(0) === 1`,
  `factor(>=outer) === 0`, monotonic non-increasing, matches the TSL `smoothstep` formula bit-for-
  bit on a handful of sample points. Extend `test-effect-renderer.mjs` (or a new
  `test-wound-fx.mjs`) with this.
- No caller changes needed in `bot-viewer-v2.html` or `damage-simulator.html` — both get it
  automatically since both build their decal pool through `createEffectRenderer`.
- Ship criterion: existing `test-effect-renderer.mjs` still passes unmodified (pool arithmetic is
  untouched) plus the new pure-math test passes.

**Phase 2 — health-driven drip/spray intensity.**
- Add `bloodIntensityForHealth(hp01)` as a pure export from `effect-renderer.js` (or a small
  dedicated module if it's judged to not belong next to THREE-importing code — `effect-renderer.js`
  is already the frozen shared import point for all five callers per `fx.md`, so I'd default to
  putting it there unless review disagrees).
- Change `spawnHitBloodFx`'s signature to take `amount` and compute `hp01` internally; update the
  three call sites (`bot-viewer-v2.html:5835`, `:5880`, `:10444`) to pass it.
- Add a `settings.health` slider to `damage-simulator.html` and wire `fireHit` through the same
  function.
- Test: pure Node test on `bloodIntensityForHealth` — `t=1` (hp01=0) reproduces today's hardcoded
  constants exactly (regression guard against changing lethal-hit behaviour), `t=0` (hp01=1) is the
  suppressed "drip" tuning, monotonic across the range, clamps outside `[0,1]`.
- Ship criterion: the two Node tests above, plus a manual check that `applyBotDamage`'s existing
  `hpBefore01`/`hpAfter01` computation (`:5836-5848`, used for `emitBotDamaged`) is untouched — this
  phase reads health, it must not change when/how it's mutated or reported elsewhere.

**Phase 3 — true crawling drip (explicit stretch, not required).**
Age-driven downward growth of the stain decal itself (elongating `instBit` and/or offsetting
position as `f(age)`, mirroring `drawSmokePuff`'s age-driven size growth). Needs a new `drip`
wire field or two, an `EffectEntity.serialize` whitelist addition, and care that it still resolves
correctly against a moving `attach` matrix (elongating in world-space "down" vs. part-local "down"
will look different on a limb that's currently horizontal — this needs a decision, not just code).
Deferred: the task explicitly allows "some other health-driven mapping you think reads better," and
Phase 2 already delivers a legible drip↔spray read without this complexity.

## 7. Dependencies and conflicts with ideas 2-4

- **Same decal pool, same material.** Ideas 3 and 4 (class-split damage effects, blood pools /
  robot fire) are the most likely to also touch `makeDecalPool` in `effect-renderer.js` and/or
  `projected-decals.js`. My `woundDarken`/`woundInner`/`woundOuter` uniforms are material-wide, not
  per-instance — if a later idea wants a *different* core behaviour per decal kind on the *same*
  pool (e.g., idea 3's robot scorch marks wanting a bright ember centre instead of a dark one), that
  needs a new **per-instance** attribute (an 8th float on top of the current `instPos`/`instTan`/
  `instBit`/`instColor`/`instAlpha` = 13 floats/slot), not a uniform — flag this explicitly for
  whoever builds idea 3 rather than silently letting the shared uniform win for every kind.
- **Same hit-resolution seam.** Idea 2 (limb loss) and idea 3 (class-split effects) both want to
  know *what got hit* and *how hurt is the target*, which are exactly this idea's two inputs
  (`resolveBodyHit`'s `part`/`role`/`crossSection`, and `hp01`). None of this idea's changes touch
  `resolveBodyHit` itself or its call site — it only consumes what's already returned — so there's
  no structural conflict, but whoever builds idea 2 should know `spawnHitBloodFx` will be reading
  `amount` post-Phase-2 and should keep passing it through if they refactor the call sites.
- **`bloodIntensityForHealth` is blood-specific in its tuning constants but not in its shape.** If
  idea 3 wants a parallel `sparkIntensityForHealth` (or similar) for robots, the same
  `(hp01) -> {count, speed, spread, ...}` shape is reusable; the numbers are not.
  No shared module exists today for this class of tuning function — this plan puts it in
  `effect-renderer.js` next to the kinds it tunes, following this file's existing convention of
  colocated constants (`STAIN_FIT`/`STAIN_FIXED` in `bot-viewer-v2.html`, `PART_SCALE` in
  `damage-simulator.html` — tuning knobs already live near their callers, not centralized).
- **No conflict with idea 4 (blood pools / robot fire)** at the code level — pooling is a
  ground-decal-lifetime concern (`blood_splatter`'s `life`/count), which Phase 2 modifies the
  *count* of but not the *lifetime model* of. A future "pool that grows over time" would likely need
  its own new effect kind either way.

## 8. Open questions

1. **Should `woundInner`/`woundOuter`/`woundDarken` be global constants or exposed as live sliders
   in `damage-simulator.html`?** I'd default to sliders (matches the file's existing tuning-harness
   role) but didn't find a strong precedent either way for *shader* uniforms specifically (the
   harness's existing sliders are all wire-object fields, not material uniforms) — worth confirming
   before Phase 1 lands.
2. **`dummyImmortal` targets never lose health** (`bot-viewer-v2.html:5882` returns before the
   health mutation). Under Phase 2's mapping, an immortal dummy would always read as "healthy" (hp01
   stays at whatever it was initialized to) regardless of how many times it's shot, so it would
   always drip, never spray. Is that the desired training-dummy behaviour, or should immortal
   dummies get a separate always-"spray" override so testers can see the intense end without
   killing anything? Not resolved from the code — this is a product call.
3. **Should the health used be the *victim's* health only, or should a headshot (once idea 2 exists)
   push the intensity mapping independently of remaining HP** (a fatal headshot on an otherwise
   healthy bot currently would read as "healthy" under hp01 alone, since Phase 2 doesn't know the
   hit was fatal until `applyBotDamage` finishes)? `applyBotDamage` already knows `fatal:
   target.health <= 0` (`:5850`) at the point health is set, which is one call *after*
   `spawnHitBloodFx` in the current order — if a "fatal hit always sprays regardless of pre-hit
   health" rule is wanted, `amount` needs to carry a `fatal` flag forward too, or the call order
   needs to change. Not designed here; flagged for whoever sequences idea 1 against idea 2.
4. **Quad-local wound centre vs. the blob mask's own visual weight** — I verified the *rejected*
   alpha-driven approach's failure mode by reading `makeStainTexture`'s lobe placement math, not by
   rendering it. It's plausible the geometric (`positionGeometry`) approach still looks slightly
   off-centre relative to where the blob mask's densest ink actually sits, since the mask isn't
   perfectly radially symmetric either (`fx.md` already documents this: "the per-decal spin... was a
   visual no-op... every stain rendered as the same soft circle" was the *old* bug; the new mask is
   deliberately irregular). This can only really be judged by looking at it — flagged, not resolved.
