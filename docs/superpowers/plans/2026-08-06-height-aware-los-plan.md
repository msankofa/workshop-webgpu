# Height-aware line of sight — plan

**Status:** Phase 0 shipped 2026-08-06. Phases 1–4 not started.
**Symptom:** bots with their head exposed over cover are not targeted. Confirmed by the user in the
browser; this plan explains the mechanism and fixes it.
**Audit it came from:** `docs/superpowers/reviews/2026-08-06-bot-visibility-hitbox/`.

> **Line numbers are as of 2026-08-06 21:35** and were re-verified against the file at that time.
> `bot-viewer-v2.html` was edited concurrently during this work (the fire/aim-sync fix logged at
> 21:30 moved everything below `fireBotShot` by ~180 lines). All three load-bearing facts in §1 were
> re-checked afterwards and hold unchanged — that fix touched the *aim* path, not perception or hit
> geometry. Re-grep the symbols before trusting a number.

---

## 1. What is actually broken

Three independent systems each assume the bot is a single point at chest height. All three have to
agree before an exposed head can be seen, aimed at, and hit.

### 1.1 The candidate prefilter drops the bot before any ray is cast

`bot-viewer-v2.html:6036`, inside `selectBotTarget`:

```js
if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(origin.x, origin.z, targetEye.x, targetEye.z)) continue;
```

`fieldSaysHidden` consults the baked visibility field, whose blocker rule is
`nav-visibility.js:52-53`:

```js
const h = b.h === undefined ? Infinity : b.h;
if (h < SIGHT_BLOCK_HEIGHT) continue;      // SIGHT_BLOCK_HEIGHT = 1.5
```

A cover 1.5 m or taller marks its cell as sight-blocking at **every** height. The blocker's real
height is read on the line above and then discarded. A bot behind a 1.8 m cover with its head at
1.9 m is removed from the candidate list having cost **zero raycasts**. Same code at `:8860` for
secondary threats and `:5200` for health packs.

`WALL_H = 3` and the maze cover slider runs 0.4–2.5 m (`:6824`, default 1.1), so this bites for any
cover authored above 1.5 m.

### 1.2 If it survives the prefilter, the LOS ray samples one point at chest height

`bot-viewer-v2.html:9560-9576`:

```js
const botEye    = eyePosInto(bot, _sentryEye);      // capsule.start.lerp(end, EYE_LIFT)
const targetEye = eyePosInto(botTarget, _sentryTargetEye);
const blocked   = mapCollider.raycast([...botEye], [...dir], dist - 0.05);
```

`EYE_LIFT = 0.85` (`:6220`) puts both ends at **1.32 m**. One ray, one point per end. No head
sample, no torso sample. This is the mechanism on terrain, where the field is generous enough to
pass (see 3.2) and the real ray against the mesh then fails.

### 1.3 Even a bot that aims at the head cannot hit it

`botAimPoint.copy(targetEye)` (`:9597`) aims at the same 1.32 m point, and the hit capsule tops out
below the head anyway. Measured against the constants:

| Landmark | Y above feet | Source |
|---|---|---|
| Hit capsule bottom → top | 0.000 → **1.800** | `bot-entity.js:11,25-28`, `combat.js:33-35` |
| Eye / LOS / aim point | 1.320 | `EYE_LIFT = 0.85` |
| pelvis | 1.044 | `pelvisHeightRatio 0.58 × H` |
| torso anchor | 1.440 | `torsoYRatio 0.22` |
| neck anchor | 1.710 | `neckYRatio 0.37` |
| head anchor | 1.908 | `headYRatio 0.48` (`player-procedural-body.js:513`) |
| head bottom → top | 1.786 → **2.020** | `headProfile` × `H`, `:883` |
| Mark VII crest top | **2.053** | `bot-body-design.js:101` |

`H = 1.8`, `R = 0.35` (`player-procedural-body.js:684-685`); profiles scale `[r,y] → [R*r, H*y]`
(`:883`). The visible bot is 2.02 m tall (2.05 with the crest); the hit capsule is 1.80 m. **The top
0.22–0.25 m — 11–12% of body height, i.e. the whole head — is drawn but not hittable.**

---

## 2. Design

Do not add rays. The information needed is already being computed and thrown away.

`traceClear` (`nav-visibility.js:73-105`) is a DDA that walks the segment cell by cell. For terrain
it *already* performs the exact test wanted, at `:99-102`:

```js
const t = ((c - c0) * dc + (r - r0) * dr) * invLen2;
if (terrain.heights[k] > eyeA + eyeRise * t + terrain.margin) return false;
```

That is "is the obstruction at this cell above the sightline chord here." Walls get a binary flag
instead. Give walls the same treatment and one traversal answers every height at once — a strictly
stronger question than a ray can answer, at the same cost. It also yields the **lowest exposed point
on the target**, which is the aim point, for free.

### 2.1 Additive, not a rewrite of `canSee`

`canSee` has 15 live call sites across `bot-cover.js` (6), `nav-corners.js` (3), `bot-alert.js` (1)
and `bot-viewer-v2.html` (5). Every one of them wants today's chest-height boolean for cover
reasoning. **`canSee` and `rowFor` keep their exact current semantics and their binary sight grid.**

The new capability is a second array and a second query beside them. Memory cost is one
`Float32Array(cols*rows)` — on a 30×30 m map at `NAV_CELL = 0.5` that is 14 400 floats, ~58 KB.

Unifying the two grids later is possible but is a behaviour change for the cover FSM (a 1.5 m cover
would stop blocking a 1.6 m chord), so it stays out of scope here.

### 2.2 Mandatory signature change

`traceClear:87-88` hardcodes the same eye offset at both ends:

```js
eyeA    = terrain.heights[r0 * cols + c0] + terrain.eye;
eyeRise = terrain.heights[r1 * cols + c1] + terrain.eye - eyeA;
```

Asking "can my eye at 1.32 see that head at ground + 1.90" needs two different offsets. The trace
must take explicit endpoint heights. Without this, height-parameterized LOS on terrain is impossible
— both ends can only slide together.

### 2.3 Cover height is relative to local ground

Confirmed, not assumed: covers carry `{x, z, w, d, h}` with no `y` (`:6886`,
`bot-structures.js:196`), and are placed with `boxTransformOnTerrain(cv.x, cv.z, cv.w, cv.h, cv.d)`
(`:7054`). So obstruction top at a cell is `groundY(cell) + blockerH(cell)`. Keeping blocker height
and ground height as two arrays (rather than one absolute array) preserves the existing property
that terrain is optional.

---

## 3. Does this fix hill cover

Yes, and hills need no new baked data — the ground heights are already sampled by `buildNavGrid` and
handed to the field at `:7070-7071`:

```js
visField = buildLazyVisibilityField(navGrid, buildSightGrid(navGrid, sightBlockers),
  navHeights ? { terrain: { heights: navHeights } } : {});
```

But the two cases fail differently today and the fix reaches them differently.

### 3.1 Walls and tall covers — the prefilter wrongly prunes
Fixed directly by 2.1: the trace compares the head chord against `ground + blockerH` instead of
against a constant.

### 3.2 Hills — the prefilter passes and the real ray fails
`TERRAIN_EYE_HEIGHT = 1.6` plus `TERRAIN_LOS_MARGIN = 0.2` puts the field's chord up to 0.48 m above
the live 1.32 m eye. It errs toward visible, so it never wrongly prunes — it just prunes almost
nothing on terrain, and the ray at 1.32 m then does the rejecting. The fix reaches this by moving
the *ray's* target point to the highest exposed sample, not by changing the prune.

**`nav-visibility.js:10-12` contains a false statement** and should be corrected in the same change:
it claims the terrain eye height "matches the live raycast's eye so the baked field and mapCollider
agree." It is 1.6 against a live 1.32.

### 3.3 Where hills stay weaker than walls
The head's whole vertical extent is 0.234 m; `TERRAIN_LOS_MARGIN` is 0.2 m. So on terrain the field
can only prune when a crest clears the head chord by more than the margin — nearly the head's own
height. Anything inside that band defers to the confirming ray. That is correct but means less
pruning on terrain than against walls. Keep the margin: paying a ray is much cheaper than losing a
real sighting.

`NAV_CELL = 0.5` cell-center sampling also smooths crests sharper than half a metre. With the
confirming ray still running against real mesh, that costs a wasted ray, never a wrong verdict.

---

## 4. Phases

Snapshot each edited file into `versions/` first, per the repo convention.

### Phase 0 — verify the geometry before building on it — **SHIPPED 2026-08-06**
The table in §1.3 is computed from constants, not observed, so it gets verified before anything is
built on it.

Shipped: a **"Hit volume"** toggle in the Debug overlays card (`botHitVolumeDebugEnabled`, off by
default). Per living bot it draws the hit capsule in green wireframe, the **rendered** head's
world-space bounds in magenta, and an amber ring on the capsule's exact top plane. The capsule is
read from `projCapsuleInto` (the scratch twin of the `combatCapsuleFor` descriptor `resolveHitscan`
is handed) and the head from `body.joints.head`'s own geometry bounds, so neither can drift from the
real hit test or the real mesh. Enabling it logs measured metres-above-feet;
`window.reportBotHitVolume()` re-runs the report for the focused bot.

Two implementation notes worth keeping: capsule geometry is built per `(radius, shaft)` and cached
with the shaft quantized to 2 cm, because scaling a unit capsule non-uniformly deforms the hemisphere
caps — and the cap is the exact thing being measured. The amber ring is positioned from unquantized
numbers, so the measurement stays exact regardless of the geometry bucket.

**Gate: do not start Phase 3 until the overlay has been looked at.** The prediction under test is
that the magenta head box sits entirely above the amber ring, by 0.22–0.25 m.

### Phase 1 — `nav-visibility.js`, pure and Node-testable
1. `buildSightGrid` additionally returns `Float32Array` of max blocker height above local ground per
   cell (0 = none). Keep the existing `Uint8Array` binary grid unchanged for `canSee`/`rowFor`.
2. Generalize the trace to take explicit world-Y endpoints and return the **highest obstruction
   relative to the chord** instead of a boolean.
3. Add `highestClearHeight(cellA, cellB, fromY, candidateYs[])` returning the first candidate height
   on B visible from `fromY` at A, or null.
4. `canSee`/`rowFor` delegate to the generalized trace with the legacy chord and the legacy binary
   grid, so their answers are bit-identical.
5. Extend the pair memo key with the height bucket (`:188-199`); today it keys on the cell pair only
   and would return a stale answer for a different height.

**Tests, in `test-nav-visibility.mjs` (235 lines today):** every existing assertion must pass
unchanged — that is the regression gate for the cover FSM. New cases: head clears a 1.6 m cover;
chest does not; head blocked by a 2.5 m cover; the same three over a terrain crest; memo returns
different answers for different heights on one pair.

### Phase 2 — wire it into `bot-viewer-v2.html`
1. Sample set per target: head (~1.90), chest (1.32), pelvis (~1.04), derived from the live capsule
   so stance scaling carries (`applyStanceHeight:7185` already scales the capsule with the pose).
2. `fieldSaysHidden` → prune only when hidden at **every** sample.
3. Sentry LOS (`:9573`): field picks the highest exposed sample, one `mapCollider.raycast` confirms
   it against real mesh. Ray count stays at one.
4. `botAimPoint` (`:9597`) and `botAimTarget` take the sample that won, not `targetEye`.

**Watch:** `botTargetVisGate` (`:6224`) is a debug channel with values `y/w/f/r/-`. It should gain a
code for "visible only above chest," or the HUD will silently mislabel the new case.

### Phase 3 — make the head hittable, as its own primitive

**Do not simply extend the capsule upward.** The capsule radius is 0.3 m; the skull is 0.086 m. A
capsule raised to ~2.05 m wraps a 0.6 m-wide column of air around a 0.17 m-wide head, so rounds
passing 20 cm clear of the head register as hits. That volume does not exist today, so the
over-wideness is currently invisible above the shoulders — raising the capsule would make it the
most visible artifact in the game, plausibly worse than the bug being fixed.

Instead, give the target descriptor a **separate head sphere**:

1. `combatCapsuleFor` (`:2328`) additionally returns `head: { p, r }`, centred on the head anchor
   (~1.908 m, derived from the live capsule so stance carries) with `r` sized off the skull, not
   inherited from the body radius.
2. `capsuleHit` (`combat.js:185-196`) tests the sphere alongside the shaft and takes the nearer.
   `testSphere` (`:223`) already exists as a module-local helper used by `rayCapsuleHit`, so the
   primitive is there.
3. Leave `bot-entity.js`'s capsule alone — it is the collision/doorway volume, and growing it
   changes how bots move through the shoot house.

Two things this buys beyond the fix. The hit result can report **which** primitive was struck, which
is the seam a headshot multiplier would need — extending the capsule throws that away. And body-shot
behaviour is untouched, so any change you feel is attributable to the head.

The body capsule's 0.3 m radius is still ~2× too wide at the limbs. That one genuinely is deferred:
narrowing it makes bots harder to hit across the board, which is a difficulty change, not a bug fix.

**Test:** add cases asserting a ray at head height hits and reports the head primitive; a ray 0.2 m
beside the head misses; a body-height ray is unchanged from today.

### Phase 4 — `RIG_HEAD_TOP_FACTOR`
`bot-stance.js:181` names 0.48 the head *top*; it is `headYRatio`, the head *anchor*. So
`stanceCapsuleHeightScale` models a body ~0.11 m shorter than it renders, and crouch/prone capsule
scales inherit the error. Rename and correct. `test-bot-stance.mjs` will need its expected scales
updated — check each change is the intended correction and not a masked second bug.

### Out of scope, and why

`fireBotShot:10318` passes `players: botTarget?.alive ? [combatCapsuleFor(botTarget)] : []`. A bullet
can only hit the shooter's currently selected target; every other bot is bullet-transparent.

This is deferred **not because it is small** — it is arguably the larger bug — but because fixing it
creates friendly fire and crossfire where none exist today. Bots would start killing teammates. That
is a balance decision, not a bug fix. Bundling it here would also make the result unattributable: if
combat feels different afterwards, there would be no way to tell whether it was bots spotting heads
or bots suddenly shooting each other. Ship the perception fix, feel it, then take this on its own.

Note it interacts with Phase 2: once bots aim at head-height points over cover, more rounds travel
over cover tops and through the space other bots occupy — so the value of fixing this goes **up**
after this plan lands, not down.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Cover FSM regresses — 15 `canSee` call sites drive it | `canSee`/`rowFor` keep the binary grid and legacy chord; existing `test-nav-visibility.mjs` and `test-bot-cover.mjs` (776 lines) must pass untouched |
| Bots become too perceptive; head-glimpse spotting feels unfair | Sample set is data, not hardcoded. Expect to tune, and expect the existing `stepVisibleDebounce` to matter more |
| Per-query cost rises | Ray count is unchanged (one confirming ray) or lower (prune at all heights). DDA adds one `Float32` read per visited cell. **Not measured** — see §6 |
| Stale memo returns a wrong-height answer | Phase 1 step 5; a test asserts it |

## 6. Confidence

- §1.1, §1.2, §2.2, §2.3, §3.1, §3.2 — read directly from source. High.
- §1.3's table — computed from constants I read; arithmetic is deterministic but **not observed in a
  render**. Phase 0 exists to settle it.
- §3.3 and the perf claims — reasoned, not measured. I have not benchmarked a DDA traversal against a
  BVH raycast in this build. The recommendation does not depend on it, since this removes rays rather
  than adding them, but do not quote the cost claim as measured.
- The `soldier` body kind (`bot-human-body.js:473`, `headYRatio 0.459`) was not audited. Its head
  sits ~0.038 m lower; the conclusion is unchanged.
- Three parallel audit agents ran this question. Two reported the head as inside the capsule; both
  arithmetic errors are traced in the review folder (one used the capsule base as the pelvis, one
  guessed the neck joint). A third agent never reported.
- **Correction (2026-08-07):** an earlier revision of this section said `resolveBodyHit`'s only
  callers were `damage-simulator.html:323,330`. That was true when written and is now false — the
  `2026-08-07T12:05` log entry ported the conforming-blood-stain work into bot-viewer-v2's real hit
  path. `bot-viewer-v2.html:99` imports it and `botWoundHitMode = 'mesh'` is the **default**, so
  every blood-FX spawn already re-traces the shot against the rig via `refineWoundHit`. Precise
  scope: `refineWoundHit` has exactly one call site, inside `spawnHitBloodFx` — per-part identity
  reaches the **FX** path only. Damage still resolves against one capsule and is still flat, so
  Phase 3's head sphere is unaffected.

## 7. On completion

Per `CLAUDE.md`: update `docs/subsystems/bots.md` for the perception/hit-geometry changes, and append
one `agent_log.csv` row per logical change.
