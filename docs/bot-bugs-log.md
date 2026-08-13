# Bot bugs log

Append-only log of behavioral bugs/pathologies found by reading `bot-states/*.tsv` traces
(see [`bot-state-codes.md`](subsystems/bot-state-codes.md) for the code format and
`bot-trace-viewer.html` for playback). Newest entry on top. Never delete or rewrite an entry —
if a bug turns out to be a misread, add a note under it rather than removing it; if it's fixed,
flip the status and say what changed.

**Bot IDs are session-specific.** A bug entry pins bots to the exact trace file(s) and timestamp
range it was observed in — `bot-262` in one take is not guaranteed to be the same spawn as
`bot-262` in another unless both are cited from the same session.

Entry template:

```
## BB-NNN: <short title>

**Status:** open | investigating | fixed | wontfix
**Main bot:** <id>, <team>, <role>, <squad>
**Encountered by:** <ids, split by direction if relevant>
**Traces:** <file paths + t_ms ranges>

**Symptom**
<observable fact pattern>

**Evidence**
<bullet list: file, timestamp/range, columns, what they show>

**Suspected mechanism**
<hypothesis, tied to file/subsystem, marked as unconfirmed>

**Open questions / next steps**
<what would confirm or kill the hypothesis>
```

## Tooling

`check-bot-target-attribution.mjs` (repo root) is a post-hoc checker for exactly this bug shape.
Run it against any trace(s):

```
node check-bot-target-attribution.mjs bot-states/bot-state-trace-<stamp>.tsv [more.tsv ...]
```

It loads the sibling `bot-events-<stamp>.tsv` when present and runs three checks:

1. **Ghost combatants** — bots with damage/kill events as attacker that never appear as any
   other bot's `target_id`, anywhere in the trace. This is the exact BB-001 signature.
2. **Unattributed hits** — individual damage/kill events where the *victim's* `target_id` never
   equals the attacker within 2s of the event. **Caveat: this one has a high baseline rate even
   on an unremarkable take** (~44% in both the 143625 and 151350 takes) — it also fires on
   ordinary ambush/flank kills where the victim never got a chance to identify their killer
   before dying, which isn't necessarily a bug. Don't read a raw count here as damning on its
   own; compare it against another take's rate rather than against zero.
3. **Silent/one-sided encounters** — opposing-team bots that stay within 15m of each other for
   3+ consecutive seconds without both directions ever recording the other (via `target_id` or
   an event). Tagged `one-sided` (exactly one direction attributed — the bot-262 flee/knife
   shape) or `silent` (neither direction, ever). Dead-bot heartbeat rows are excluded so a corpse
   can't manufacture a fake encounter with whoever later walks past it. **This is the check with
   the clearest signal** — it ran at 2-3 flagged pairs on the two 1436xx takes and 110 on the
   151350 take, an order of magnitude jump worth treating as real.

Exits 1 if any check flags something in any file, 0 otherwise, so it can gate a take review.

`check-bot-elevation-gap.mjs` (repo root, added for BB-004) recovers a bot's otherwise-unlogged
vertical position indirectly: the trace has `x`/`z` but no `y`, while `target_dist` is a full 3D
distance computed off the same capsule. For every row with a `target_id`, it backs out
`yGap = sqrt(target_dist^2 - xzDist^2)` (`xzDist` from the two bots' own logged `x`/`z`) and reports
the bots/pairs with the largest sustained gaps:

```
node check-bot-elevation-gap.mjs bot-states/bot-state-trace-<stamp>.tsv [more.tsv ...]
```

This is what confirmed BB-004 (bots rendering off the terrain) and BB-001/002/003 (the "ghost
combatant" family) are the same bug — see BB-004's update note below.

## Symptoms (added 2026-08-02)

`bot-trace-viewer.html`'s Statistics panel has a third tab, **Symptoms**, next to Per bot/Per state:
one row per bot, one column per named symptom below, all pulled directly from BB-001/002/003. Every
column is a **raw count, ratio, or boolean** — deliberately not combined into a single weighted score.
We have no empirical basis yet for how much any one symptom should count relative to another; that's
what this tab is *for* determining (via `Copy TSV` into real correlation analysis), not something to
assume up front. A ratio's sample-size column always sits next to it (e.g. `high-tier rows` next to
`high-tier no-target ratio`) so a thin sample stays visibly distinguishable from a solid one, instead
of the tool silently treating them the same. Once real takes show which signals actually correlate
with confirmed bugs, weights (if any) belong here, cited back to that analysis — not guessed at.

Five of the seven named symptoms are single-bot aggregates and are implemented; two are inherently
pairwise/temporal and are not (see the table below).

| Symptom | Bug | Columns | Detection |
|---|---|---|---|
| **Blind Combat** | BB-001 | `kills`, `deaths caused`, `engagements`, `sights` | No threshold gate: any bot with `kills`, `deathsCaused`, or `engagements` > 0 is combat evidence; `sights` (times any other bot's row had this one as `target_id` with `vis_gate=y`) is the counter-evidence. Read the two side by side — real combat with near-zero sights is the BB-001 shape. |
| **Silent Escalation** | BB-002 | `high-tier rows`, `high-tier no-target rows`, `high-tier no-target ratio` | Per row, tier (`r.d.tierChar`, decoded from the state code) ≥ 3 ('defensive'/'push') counts as `high-tier rows`; of those, the ones with a blank `target_id` are `high-tier no-target rows`. Ratio always computed when `high-tier rows` ≥ 1 — no minimum-sample gate, the row count itself is the sample-size signal. |
| **Silent Contact** | BB-002 (headline) | — | Not a per-bot aggregate: needs pairwise x/z distance + mutual `target_id` checks across the whole roster over time. This is exactly `check-bot-target-attribution.mjs` check 3, already built, offline only. Not in the Symptoms tab. |
| **Target Flicker** | BB-003 | `max target switches / 3s` | `target_id` change timestamps (to a new non-blank value) collected per bot, then the densest run within any 3000ms window. A continuous integer (0 for calm, rising with severity), not an episode count gated at a minimum switch count. |
| **Feared and Dropped** | BB-003 | — | Not implemented: needs pairwise *and* temporal correlation (another bot's flee/fear timing vs this bot's target-switch timing). Not even the Node checker does this yet — BB-003 found it by manual read. |
| **Directionless Push** | BB-003 | `push rows`, `push no-target rows`, `push no-target ratio` | Same computation as Silent Escalation, tighter scope: tier ≥ 4 ('push') *and* `element` = `m` (moving), matching BB-003's exact "coordinated advance, never acquires a visible enemy" shape. |
| **Blind Death** | BB-003 (update) | `killer ever targeted`, `max self-threat before death` | Needs real combat-event data (to know the real killer) — a file load's `bot-events-<stamp>.tsv` sibling, or a live game broadcasting its own event stream (see below); `—` when neither is available, same caveat as `kills`/`hits`. For a bot that died: did the killing event's attacker ever appear in this bot's own `target_id` in the 5s before death (a genuine yes/no, no continuum to lose)? Separately, the raw max `self_threat` in that window (not pass/failed against a cutoff — the value itself). |

`computeSymptomStats()` in `bot-trace-viewer.html` is the implementation; it calls `computeBotStats()`
first to reuse `kills`/`deathsCaused`/`engagements`/`sights`/`role`/`squad` rather than recomputing
them. Never grouped by role/team (a ratio or a max-in-window metric across bots isn't a sum, mean, or
union like the other stats columns) — `groupBy`/`leaderMode` hide while this tab is active. Each
column's `<th>` also carries a `title` tooltip with its detection text (from this table), and the
table itself now groups columns under a `"<symptom name> <BB-###>"` header — see
`docs/subsystems/bot-state-codes.md`'s "Symptoms tab grouping + tooltips" bullet.

**Live combat-event streaming** (added 2026-08-02): `kills`/`hits`/`killer ever targeted`/`max
self-threat before death` used to read `—` for every live session — not because live streaming can't
carry combat events, but because the viewer's `ingestLive()` silently dropped bot-viewer-v2's `events`
messages, which it had been broadcasting all along. Fixed; a live session now populates these columns
the same way a file load with its `bot-events` sibling does. See
`docs/subsystems/bot-state-codes.md`'s "Live combat-event streaming" bullet for the mechanism.

---

## BB-011: a bullet can only ever hit the shooter's current target

**Status:** open — deferred by decision, not by difficulty
**Provenance:** code audit, 2026-08-06. No trace; this shape cannot appear in a trace, because the
hits that *should* happen simply never occur.
**Main bot / Encountered by / Traces:** N/A — see provenance.

**Symptom**
No crossfire, no friendly fire, no stray hits. Rounds pass through every bot except the one the
shooter has selected.

**Evidence**
- `fireBotShot` → `resolveHitscan` is handed `players: botTarget?.alive ? [combatCapsuleFor(botTarget)] : []`
  (`bot-viewer-v2.html:10738`, as of 2026-08-07T19:xx). The list has at most one entry.
- `combat.js:185-196 capsuleHit` iterates whatever list it is given, so the restriction is entirely
  at the call site — the resolver itself is already general.

**Suspected mechanism**
Confirmed, not suspected: the candidate list is built from a single target by construction.

**Open questions / next steps**
Fixing this creates friendly fire and crossfire where none exist today, so it is a balance decision
rather than a straight bug fix, and it was deliberately scoped out of the
`2026-08-06-height-aware-los-plan.md` work to keep that change attributable. Note the value of fixing
it **rises** once that plan lands: bots aiming at head-height points over cover will send more rounds
through the space other bots occupy.

---

## BB-010: `nav-visibility.js` models eyes 0.28 m higher than the live raycast, and says otherwise

**Status:** open — errs safe, but wastes rays and misleads
**Provenance:** code audit, 2026-08-06. No trace.

**Symptom**
The baked visibility field prunes almost nothing on terrain; the live ray does all the rejecting.

**Evidence**
- `nav-visibility.js:12` `TERRAIN_EYE_HEIGHT = 1.6`, plus `:13` `TERRAIN_LOS_MARGIN = 0.2`.
- The live eye is `EYE_LIFT = 0.85` up the capsule shaft (`bot-viewer-v2.html:6415`) = **1.32 m**.
- `nav-visibility.js:10-12`'s comment claims the terrain eye height "matches the live raycast's eye
  so the baked field and mapCollider agree." It does not — it is 0.28 m high, 0.48 m with the margin.

**Suspected mechanism**
Confirmed. The direction is safe (a high chord over-reports visibility, so the prefilter never
wrongly prunes) which is presumably why it went unnoticed.

**Open questions / next steps**
Correct the comment at minimum. Whether to lower the constant depends on the height-aware trace work
— see §3.2 of `docs/superpowers/plans/2026-08-06-height-aware-los-plan.md`.

---

## BB-009: `RIG_HEAD_TOP_FACTOR` is the head *anchor*, not the head *top*

**Status:** open — Phase 4 of the height-aware LOS plan
**Provenance:** code audit, 2026-08-06. No trace.

**Symptom**
Crouch and prone capsule heights are derived from a body modelled ~0.11 m shorter than it renders.

**Evidence**
- `bot-stance.js:181` `RIG_HEAD_TOP_FACTOR = 0.48`, used at `:196` as `standTop = pelvisHeightRatio + 0.48`.
- 0.48 is `headYRatio` (`player-procedural-body.js:513`), the Y at which the head part is *placed*
  (`:1778`), not the top of its geometry. The head's own profile adds `+0.062 × H = 0.112 m` above
  that anchor.

**Suspected mechanism**
Confirmed by reading both constants. A naming error that propagated into the stance maths.

**Open questions / next steps**
`test-bot-stance.mjs` will need updated expectations. Check each changed value is the intended
correction and not a second bug being unmasked.

---

## BB-008: bots with an exposed head over cover are never seen, aimed at, or hit

**Status:** open — plan authored, Phase 0 (diagnostic) shipped 2026-08-06
**Provenance:** observed by the user in the browser, then traced by code audit 2026-08-06. No `.tsv`
trace — this is a perception/geometry bug, and the trace format has no column that would show it.
**Main bot / Encountered by / Traces:** N/A — see provenance.

**Symptom**
A bot behind cover with its head clearly visible above the top is not targeted. Reported directly by
the user: "bots with their head exposed not being targeted."

**Evidence — three independent mechanisms, each sufficient on its own**

1. **The candidate prefilter drops it before any ray is cast.**
   `bot-viewer-v2.html:6231` in `selectBotTarget` calls `fieldSaysHidden`, which consults the baked
   field. `nav-visibility.js:52-53` reads each blocker's real height and then discards it:
   anything `>= SIGHT_BLOCK_HEIGHT` (1.5 m, `:8`) blocks at **every** height. Cost to reject: zero
   raycasts. Same call at `:8860`-equivalent for secondary threats and the health-pack scan.
   `WALL_H = 3`; the maze cover slider runs 0.4–2.5 m, so this bites for any cover above 1.5 m.
2. **The LOS ray samples one point at chest height.**
   `bot-viewer-v2.html:9958` raycasts eye-to-eye, both ends at `EYE_LIFT = 0.85` = **1.32 m**. One
   ray, one point per end, no head or torso sample. This is the mechanism on terrain, where the
   field (see BB-010) is generous enough to pass and the real ray then fails.
3. **The head is outside the hit volume, so even a correct aim would not connect.**
   `combatCapsuleFor` (`:2497`) returns the physics capsule: `DEFAULT_RADIUS = 0.3`,
   `DEFAULT_STAND_HEIGHT = 1.8` (`bot-entity.js:11-12`), tested by `combat.js:33-35` as centre ±h/2
   ±r → **0 → 1.80 m** above the feet. The rendered head runs **1.786 → 2.020 m** (2.053 m with the
   Mark VII crest at `bot-body-design.js:101`). Computed from `pelvisHeightRatio 0.58`,
   `headYRatio 0.48`, `H = 1.8`, `R = 0.35`, profiles scaled `[r,y] → [R*r, H*y]`
   (`player-procedural-body.js:56, 513, 684-685, 883`). `botAimPoint` also copies `targetEye`
   (`:9982`), i.e. the same 1.32 m point.

**Suspected mechanism**
Not suspected — all three confirmed by reading. Common root: three systems each reduce a 2 m body to
one point at chest height, and each was written against the documented assumption that
"bots/targets are ~level" (`docs/subsystems/bots.md`, now annotated).

**Note on a related claim I got wrong.** An earlier version of this entry and of the plan stated that
`bot-body-hit.js resolveBodyHit` had no callers outside `damage-simulator.html`. True when written,
false from 2026-08-07T12:05, when the conforming-blood-stain work was ported into bot-viewer-v2's
real hit path. `botWoundHitMode = 'mesh'` is now the default and `refineWoundHit` re-traces every hit
against the rig. Its single call site is inside `spawnHitBloodFx`, so part identity reaches the **FX**
path only — damage still resolves against the one capsule above, so nothing in this entry changes.

**Fix shipped so far**
Phase 0 only, and it is a diagnostic rather than a fix: a **"Hit volume"** toggle in Debug overlays
(`botHitVolumeDebugEnabled`, off by default) drawing the hit capsule in green wireframe, the rendered
head's world bounds in magenta, and an amber ring on the capsule's exact top plane. Built from
`projCapsuleInto` and `body.joints.head`'s own geometry so it cannot drift from the real hit test or
the real mesh. `window.reportBotHitVolume()` prints measured metres above feet. The prediction under
test is that the magenta box sits entirely above the amber ring by 0.22–0.25 m; **as of this entry it
has not yet been looked at**, so the geometry in evidence item 3 remains computed, not observed.

**Open questions / next steps**
Phases 1–4 of `docs/superpowers/plans/2026-08-06-height-aware-los-plan.md`: carry blocker height in
the sight grid so one DDA answers every height at once, sample head/chest/pelvis and aim at whichever
is exposed, give the target descriptor a separate head sphere (not a taller capsule — that would wrap
a 0.6 m column of air around a 0.17 m head), then BB-009.

---

---

## BB-007: grenade evade scored only distance — bots parked on the cover boundary and ran into firing lanes

**Status:** fixed 2026-08-07 in `bot-viewer-v2.html` (`grenadeEvadeGoal` rewritten as a scored cell scan)
**Main bot:** n/a — affected every bot that evaded a grenade
**Encountered by:** n/a
**Traces:** none. Found by user observation in a live bot-viewer-v2 session, then confirmed by code
read. No trace pins this — the trace format has no column for "where did the evade send it".

**Symptom**

Two user-reported behaviours, one root cause:

1. **Parking on the edge of cover.** "It seems like they'll get one space into cover and sit right
   there. This is unnatural." Bots reaching cover stopped at the first spot that was technically out
   of the blast's line, standing on the boundary rather than moving properly inside.
2. **No account of enemy exposure.** Bots sprinted clear of a blast into open ground that the enemy
   they were fighting could see straight down.

**Evidence**
- Code read of the two goal pickers as shipped 2026-08-06:
  - `grenadeEvadeGoal` scored `distanceFromBlast − 0.35 × travel`. No visibility term of any kind, to
    the grenade or to any enemy.
  - `grenadeCoverCorner` scored `−distanceToAnchor` (nearest wins), with the hold triggering 0.8 m
    from the anchor.
- **The cover version could not have been fixed by re-scoring it.** A corner record's `anchorPos` is a
  boundary feature by construction — `nav-corners.js` builds each one as the walkable cell adjacent to
  the sight line, paired with a `peekCell` that *is* exposed. "Get properly inside cover" is not
  expressible over that candidate set at any weighting.

**Mechanism (confirmed by code read, not inferred)**

Both pickers optimised the wrong objective. Distance-from-blast is necessary and not sufficient:
being past the shadow boundary says nothing about how far past, and nothing at all about who else can
see the spot.

**Fix**

Replaced both with one scored cell scan over walkable cells (`±12` cells at stride 2, ~169 candidates
at 1 m granularity):

| Term | Weight | Addresses |
|---|---|---|
| Hidden from the blast | +9 | prefers cover at all |
| Shadow depth (4 probes at 1.5 m, 0–4) | +2.6 each | symptom 1 — depth beats merely being past the line |
| Visible to the bot's own threat | −7 | symptom 2 |
| Shortfall inside `blastRadius + 2.5 m` | −1.2/m | the same edge logic applied to the blast ring |
| Per-bot jitter, stable per cell | ≤1.5 | stops a squad converging on one cell |

Ranking at the shipped weights (arithmetic checked in a standalone harness, not just reasoned):
deep shadow 14.95 > exposed deep shadow 7.95 > shadow edge 4.55 > open ground 1.1 > open and exposed
−5.9. Deep shadow clears the boundary by 10.4, far outside jitter's reach.

`canSee` is fail-closed on unwalkable cells, so a depth probe landing in a wall counts as shadow —
deliberate: a wall stops a blast as well as a shadow does. Reachability uses `lineWalkable` first and
`requestPathBudgeted` only when the winner is behind geometry.

**Known deliberate asymmetry:** blast safety outranks bullet safety while a grenade is live — an
exposed deep-shadow cell still beats an unexposed boundary cell. Not tuned against real takes.

**Open questions / next steps**
- The weights are reasoned and hand-checked, not fitted to observed outcomes. Worth revisiting against
  a recorded take once one exists that has bots surviving or dying to grenades in cover.
- The scan is per bot per 400 ms replan. Not profiled under a large roster with several live grenades.
- `environment-viewer-v2.html` still carries the old distance-only `grenadeEvadeGoal` (see
  `docs/subsystems/bots.md`'s port section). Not ported.

---

## BB-006: blast damage ignored geometry entirely — grenades killed through walls

**Status:** fixed 2026-08-07 in `bot-viewer-v2.html` (`blastExposure`)
**Main bot:** n/a — affected every blast victim
**Encountered by:** n/a
**Traces:** none. User-reported from a live session ("grenades do damage through walls"), confirmed
immediately by code read.

**Symptom**

A grenade or rocket damaged every bot inside its radius regardless of what stood between them.

**Evidence**
- `detonateBlast`'s victim loop was a pure distance test: capsule midpoint, `if (d > R) continue`, then
  linear falloff. No raycast, no visibility-field lookup, no occlusion term anywhere in the function.
- This had already been flagged in a code audit on 2026-08-06 as a standing property of the function
  before the user hit it in play.

**Mechanism (confirmed)**

There was no occlusion test to fail. The behaviour was the code doing exactly what it said.

**Why it mattered more than it looks:** it silently invalidated the grenade cover-seeking shipped the
day before. A bot ran to a corner, held it correctly, and took full damage anyway — the cover
behaviour was cosmetic for as long as this bug stood.

**Fix**

`blastExposure(center, capsule)` casts three rays from the blast centre to fractions 0.15 / 0.5 / 0.9
up the victim's own capsule (shins, torso, head) and scales damage by the fraction unblocked. Exposure
0 drops the victim from the list entirely — no damage, no hit FX, no squad report. Rays stop 5 cm
short so the victim's own surface is never its own cover.

**Three rays, not one, on purpose.** A single centre-to-centre ray makes a bot behind a low wall either
immune or unprotected, and head-exposed-but-not-registered is already a known bug family in this
codebase. Partial cover now gives partial protection.

Panel toggle **Blast blocked by walls** (Explosives, default on); off restores the old behaviour
exactly, so it doubles as an A/B control.

**Update (2026-08-07, same day): the veto rings were left inconsistent for a few hours, and it cut
both ways — now fixed**

Shipping occlusion in the damage model without touching the decision model left
`chooseGrenadeThrow` approximating a function that no longer matched it. The interesting part is that
the error was **not** purely cautious, which is how it was first described:

- **Over-refusing.** An ally sheltered behind a wall 10 m from the aim point takes zero damage but
  still tripped the `blast × 1.15` friendly veto. Bots passed up safe throws — worse the tighter the
  map, so worst in the shoot-house.
- **Over-throwing.** Enemies behind walls still counted toward `minEnemiesForVisibleThrow` and the
  cluster score. A bot could read "three in the blast, worth it", throw, and hit one — spending a
  grenade and a 9 s cooldown on geometry.

Fix: `chooseGrenadeThrow` takes an optional `input.blastReaches(point, entry)` hook (injected like
`combat-projectile`'s `ctx.raycast`, so the module stays pure and Node-testable), consulted by all
three rings and only for bodies that already passed the distance test. The viewer wires it to
`blastExposure` **itself** rather than a reimplementation, so the two models cannot drift again and the
panel toggle reverts both together. The cheap self pre-gate in `grenadeCandidate` had to become
occlusion-aware in the same change, or it would have vetoed every short throw before the real gate ran.

24 new assertions in `test-bot-grenade.mjs`. Verified non-vacuous by mutation: wiring the hook but not
consulting it fails 6 of them.

**Generalisable lesson:** whenever a decision model approximates a damage/physics model, expect the
approximation to fail in *both* directions once they diverge. "It only errs cautious" was wrong here
and was believed for several hours.

**Open questions / next steps**
- Cost is 3 raycasts per victim per blast, plus up to 3 per body inside a veto ring per throw
  consideration (at most every 500 ms per bot, behind the cooldown gates). Accepted without profiling —
  unverified under a large roster inside one 15 m blast.
- `blastReachesBody` tests the ground under the aim point; the grenade may bounce or roll before it
  detonates, so the veto is evaluated against a point estimate of where it will end up. Same
  single-point-estimate weakness BB-007 hit for the evade destination.

---

## BB-005: grenade evade released instantly at the ring edge — bots marched in place, then snapped straight back into combat

**Status:** fixed 2026-08-06 in `bot-grenade.js` + `bot-viewer-v2.html`
**Main bot:** n/a — affected every bot that evaded a grenade
**Encountered by:** n/a
**Traces:** none. User-reported from a live session after raising the grenade fuse; mechanism below is
**inferred from code plus the user's description**, not observed in a trace or a captured repro.

**Symptom**

Reported together after the fuse was lengthened from the authored 2.0 s:

1. Bots that cleared the blast radius "kinda like march run in place", in the open, where they were
   easy to kill.
2. Bots "snap right back into combat after it explodes."

Both were latent before the fuse change and only became visible once a grenade stayed live for
seconds instead of under two.

**Evidence**
- `grenadeEvade` dropped a threat the instant `dist > g.blastRadius` — a hard cutoff, no hysteresis.
- The evade is a **movement-layer override, not an FSM state**: state resolution runs above the
  dispatch chain and keeps ticking through the whole event. So the frame the ring released, the combat
  branch already had a live target and a movement goal and pulled the bot back across the boundary.
- Nothing anywhere tore down aim acquisition on detonation, so `aimContactAt`/`aimReadyAt` survived the
  blast intact and the bot was legal to fire on the first frame after it.
- A second contributing path for symptom 1, also code-read: on reaching its goal, `currentPath.length
  === 0` forced an immediate replan, and `grenadeEvadeGoal` refuses to return the bot's own cell — so
  at a local maximum it had to pick a neighbour, then pick the original back.

**Mechanism (inferred, consistent with both reports)**

Boundary chatter. Two systems with no shared hysteresis — an evade that releases at exactly
`blastRadius` and a combat FSM that never stopped wanting to advance — hand the bot back and forth
across one line at the replan cadence.

**Fix**
- `grenadeEvade` takes a fourth argument, the threat id already being evaded; that grenade keeps its
  hold out to `blastRadius × evadeExitScale` (default 1.25) while every other threat still engages at
  the plain radius. `urgency` and the reported `radius` still measure against the true damage ring, so
  the widened band reads as zero proximity rather than negative. Scale 1 restores the old behaviour;
  below 1 is clamped. Panel slider **Evade release ×blast**. Covered by six new assertions in
  `test-bot-grenade.mjs`.
- `settleAfterBlast(center, radius, now)` at the end of `detonateBlast` tears down aim acquisition for
  every living bot within `radius × 1.35`, routing the "don't resume fire instantly" delay through the
  existing A10 recognition-delay system rather than adding an FSM state.

**Open questions / next steps**
- 1.25 and 1.35 are picked, not derived. No take has been measured to say whether the band is wide
  enough under a long fuse.
- The settle radius is not occlusion-tested (see BB-006) — deliberate, since a bot behind a wall still
  hears the blast, but it does mean the two use different reach models.
- The same instant-release structure exists anywhere else a movement override sits under a live FSM.
  Not audited.

## BB-004: knife-committed bots (and their weapons) render airborne, well above the terrain surface

**Status:** recovery shipped 2026-08-03 in `bot-viewer-v2.html` (see the last update in this entry);
the trigger that puts a capsule through the terrain sheet is still unidentified
**Main bot:** unidentified — found by screen observation in a bot-viewer-v2 open-terrain session,
not a saved trace, so no bot ID is pinned down yet. Recurs on whichever bot has most recently
become squad leader by succession (BB-003's pattern: the senior survivor inherits `squad_rank 0`
when its own leader dies).
**Encountered by:** n/a — this is a geometry/physics bug, not a target-attribution bug; no other
bot's `target_id` is implicated.
**Traces:** none pinned to this bug yet. `bot-states/bot-state-trace-20260803-072210.tsv` (+
matching `bot-diag`/`bot-events`) is timestamped ~30 min before the screenshots below (07:22 vs
07:53) and is a plausible same-session candidate, but that is **unconfirmed** — treat it as
something to go check, not a citation.

**Symptom**

User-reported pattern, not yet cross-checked against a trace:

1. The bot that has survived long enough to become squad leader is disproportionately the one seen
   exhibiting this bug — plausibly because it has simply accumulated more live playtime than any
   other bot to trigger a rare condition, not because leadership itself is causal.
2. That bot is usually dry (both weapon slots empty) and has the knife out, i.e. in `BOT_KNIFE` —
   consistent with the FSM, where knife is gated on `attackerOutOfAmmo` and is a genuine last
   resort (bot-viewer-v2.html:9421-9424).
3. It is "seen a lot" (long survival, high exposure) but doesn't rack up kills, and squadmates
   behave as though its perception/response is bugged — reads as the BB-001/002/003
   target-attribution family (ghost combatant, ignored-while-fleeing, target flicker). This may be
   an independently-caused co-occurrence rather than the same bug as the floating below (see
   Suspected mechanism).
4. **New this session:** the bot's whole rig — body and weapon alike — renders well above the
   actual terrain surface, with the ground/its own shadow visibly below it rather than at its feet.

**Evidence**
- `bot-states/bb-004-floating-knife-bot/01-legs-above-terrain-crest.png` — legs/feet in frame with
  terrain falling away well below, from a low/following camera.
- `bot-states/bb-004-floating-knife-bot/02-full-body-airborne-leader-chevron.png` — full body
  hanging in mid-air over a terrain fold, with an overhead chevron-shaped marker matching the
  squad-leader role insignia (`buildRoleInsignia('chevron')`, bot-viewer-v2.html:4707) — confirms
  this specific bot is the squad leader.
- `bot-states/bb-004-floating-knife-bot/03-weapon-detached-above-terrain.png` — a held/stowed
  weapon floating over terrain with a structure silhouette behind it and a clear shadow gap
  beneath it on the ground, same session.
- A fourth screenshot (shared inline in chat, not saved to a file) shows the same shape of bug on a
  second, distinctly-marked bot — the floating is not confined to a single bot instance.

**Suspected mechanism**

Nothing below is confirmed by a runtime repro; these are candidates ruled in/out purely by reading
the code.

- **Fairly confidently ruled out: the stance/pose height-blend system.** `chooseBotStance`
  (bot-stance.js:98, wired in at bot-viewer-v2.html:9315) maps FSM state `'knife'` to
  `STANCE_RUN`, and `STANCE_RUN`'s height scale is a 1x no-op in both `stanceHeightScale` and
  `stanceCapsuleHeightScale` — this exact mapping is covered by `test-bot-stance.mjs`. Unlikely
  that this system is injecting a crouch/prone-style vertical offset for knife.
- **Fairly confidently ruled out: stale/cached weapon transforms.** `flushStowedWeapons`
  recomputes each stowed weapon's world matrix every frame straight off `actor.body.joints.torso`,
  and the instance batch is cleared (`beginFrame`/`endFrame`) every frame too — a floating weapon
  isn't a leftover instance sitting at an old position, it's tracking a floating body live. This
  also explains why body and weapon float together instead of the weapon alone.
- **Fairly confidently ruled out: knife-charge movement skipping the nav mesh.**
  `updateKnifeMovement` (bot-viewer-v2.html:7801) paths through the same
  `requestPathBudgeted`/`followPath` as every other locomotion state; it doesn't beeline through
  walls/structures in a way that would obviously drive it onto unintended collision geometry.
- **Still open, most likely candidate: `mapCollider` resolving the capsule onto real-but-wrong
  geometry.** Every bot's vertical position funnels through exactly one place,
  `stepBotPhysics` (bot-entity.js:41) — gravity plus `mapCollider.resolveCapsule`, or a flat
  `heightAt` fallback with no `mapCollider`. Nothing in the combat/knife code writes to
  `capsule.start.y`/`end.y`/`velocity.y` directly, so if the capsule really is elevated, either
  (a) the BVH collider is genuinely resolving the bot onto elevated geometry it shouldn't be
  standing on, or (b) the collider is stale relative to the terrain actually being rendered.
- **A specific version of (a) worth checking first:** `bot-structures.js`'s `generateStructures`
  only returns 2D `{x,z,w,d}` wall/cover footprints — no `y` at all — leaving it to the caller in
  bot-viewer-v2.html to extrude them to 3D and align them to the terrain (the module's own comment
  says callers "pad the terrain under them"). That extrusion/padding path hasn't been traced yet.
  Knife bots are exactly the ones forced into close-quarters combat around structures (they have to
  close distance to melee range), and close combat is also where the hardest position-correction
  code runs (`resolveCreatureCollisions`/separation pushout) — so if a structure's collision floor
  sits above the terrain anywhere (an unpadded slope, an overlap between two placed structures), a
  knife bot getting shoved during a close fight is a plausible way to end up parked on it. This
  would explain "knife bots specifically" without any code in the knife/combat FSM itself being
  wrong.
- The BB-001/002/003 perception-bug family (symptom 3 above) is almost certainly a **separate**
  root cause from the floating (different subsystems: target/alert selection in
  bot-activity.js/bot-alert.js vs. physics/collision in bot-entity.js) that merely **co-occurs** in
  the same bots because both need a long, uninterrupted life to manifest or accumulate. Worth
  stating explicitly so this doesn't get treated as one bug when it may be two independent
  long-tail bugs sharing the same population of long-lived bots.

**Open questions / next steps**
- Capture a trace where a bot enters `BOT_KNIFE` and log `capsule.start.y` alongside
  `terrainField.heightAt(x,z)` (and, if reachable, a straight-down `mapCollider` raycast at the
  same `(x,z)`) every frame — the three should agree within centimeters while grounded; a
  persistent gap that opens specifically under `BOT_KNIFE` would confirm the physics-desync
  hypothesis directly.
- Check `bot-states/bot-diag-20260803-072210.json` and its matching trace/events files against
  this bug if that session turns out to be the same one screenshotted (unconfirmed above) — look
  for the bot with the longest lifetime / `squad_rank 0` and check whether it also shows the
  BB-001-style "never appears as any target_id" symptom.
- Trace the caller-side extrusion of `bot-structures.js` wall/cover rects in bot-viewer-v2.html to
  confirm or rule out the "structure collider floats above terrain" hypothesis — specifically
  whether the terrain-flattening "pad" always fully covers a structure's footprint on a sloped
  base.
- Reproduce with `botStateOrbsEnabled` on and the buggy bot set as the debug-focused actor, to get
  a live colored FSM-state readout confirming `BOT_KNIFE` at the exact moment it's airborne —
  screenshot 2's overhead marker is ambiguous at thumbnail resolution between the amber
  `BOT_KNIFE` state orb (`botStateColor`, bot-viewer-v2.html:2905) and the gold squad-leader
  chevron.

**Update (2026-08-03): this is very likely the same bug as BB-001/002/003, not a separate one**

The "co-occurrence, different subsystem" call above was wrong — or at least premature. The user
pushed back that the airborne bots in the screenshots look like the same bots BB-001-003 already
described, which prompted checking two things:

1. **BB-001/002/003 have no visual description of the bots at all**, and *couldn't* have one from
   their own evidence — every finding in this log through BB-003 was read entirely off
   `bot-state-trace-*.tsv` text (grep/awk over `target_id`, `tier`, `score`, state codes), and the
   trace format's own column list (`## Tooling` intro / the header dump) has **no `y` column, only
   `x`/`z`**. Nobody investigating BB-001-003 could have seen or ruled out an elevation bug even if
   they had thought to look; visual/geometric state was simply never captured.
2. But it turns out `y` is recoverable *indirectly*. `target_dist` (logged per row) is a full 3D
   distance — `botEye.distanceTo(targetEye)`, where `eyePosInto` (bot-viewer-v2.html:6134) is a
   lerp of `entity.capsule.start`/`.end`, the **exact same capsule** the logged `x`/`z` come from
   (`botXZInto`, bot-viewer-v2.html:6141). So for any row with a `target_id`, comparing the logged
   `target_dist` against the XZ-only distance recomputed from both bots' own `x`/`z` at matching
   timestamps exposes whatever vertical gap the trace was blind to. `check-bot-elevation-gap.mjs`
   (new, repo root, see `## Tooling` above) does exactly this across a whole trace file.

Run against the exact files BB-001-003 were diagnosed from, it finds real, large, structured
anomalies — not noise:

- **`bot-states/bot-state-trace-20260802-151350.tsv`** (BB-002/003's file): `bot-808` logged
  `target_dist=566.20` to `bot-856` at t=146379, while `bot-856`'s own concurrent rows put it at
  completely normal coordinates fighting `bot-807`/`bot-809` at 2-7m — confirmed by hand
  (`awk` dump, both bots' raw rows), not just the tool's aggregate.
- **`bot-states/bot-state-trace-20260803-072210.tsv`** (this morning, closest session to the
  screenshots): `bot-1578` vs `bot-1584`, **n=71 flagged rows**, growing **smoothly and
  monotonically** from 22.15m (t=22050101) to 635.16m (t=22055840) — a 5.7s window. Over that same
  window `bot-1578`'s own logged `x`/`z` barely move (`-49.61,-31.92` → `-54.57,-28.56`) and
  `bot-1584`'s stays put too, actively fighting three *other* bots at normal 11-21m ranges the
  whole time. The growth curve is the signature of **unrecovered free fall**: `stepBotPhysics`
  (bot-entity.js:41) applies `GRAVITY = 30` m/s² whenever `bot.onFloor` is false, uncapped, every
  frame `mapCollider.resolveCapsule` fails to find ground — `0.5 * 30 * 5.7^2 ≈ 488m`, the right
  order of magnitude for the ~600m opened up. Right after (t=22055899) `bot-1578` drops its target
  entirely (nothing else was in range) rather than continuing to report distance, which is why the
  trace goes quiet instead of showing the fall's actual bottom.
- **This directly falsifies the knife requirement**: `bot-1578` never once enters state `K` in this
  entire trace (`awk` state tally: A=94 C=64 E=32 F=2 G=30 H=18 P=133 S=167, zero `K`) — it was
  fleeing (`E`) when it fell. It also **does not permanently vanish**: it's still alive and on
  ordinary `P` patrol at the very end of the trace (t≈36.4M ms, hours later), *and* is squad leader
  (`squad_rank 0`, `leader_id` = itself) by then. Best read: `capsule.start/end.x/z` are driven by
  movement/pathing code that is entirely XZ-based and never notices a broken Y, so the bot keeps
  patrolling/pathing normally forever; only `.y` is wrong, indefinitely, so every future
  `target_dist` involving it is enormous, `vis_gate` reads `'r'` (out of sight range), and it never
  gets meaningfully targeted or targets anyone again for the rest of a very long life — a ghost
  that still walks around, matching **every** BB-001-004 symptom in the user's report at once (see
  below), not two coincidentally-overlapping bugs.

**Revised mechanism, high confidence:** `entity.capsule`'s `y` occasionally diverges from ground
truth — almost certainly runaway free fall (`stepBotPhysics`'s gravity never re-latching
`onFloor = true`, i.e. `mapCollider.resolveCapsule` failing to find ground under the bot for one or
more consecutive frames and never recovering) — while `x`/`z` stay correct throughout. Because
`eyePosInto` reads directly off the same capsule with no indirection through the visual rig, this
single corruption is *sufficient* on its own to explain:
- **BB-001/002/003** (ghost combatant / silent proximity / target flicker / blind death): the
  fallen bot's 3D distance to and from everyone explodes past `botSightDistance()`, so
  `selectBotTarget`'s `distanceSq > sightSq` gate (bot-viewer-v2.html:5629) silently drops it as
  a candidate in both directions — it can be 0.6m away in XZ (BB-002's bot-744 case) and still
  never be selected, because the *3D* distance is actually enormous.
- **BB-004** (this entry): `botMesh.position`/the procedural body's root is the midpoint of the
  same corrupted capsule (bot-viewer-v2.html:3113-3114), so the rendered bot and its
  attached/stowed weapons (`flushStowedWeapons` rides `actor.body.joints.torso`, itself built off
  the capsule) render far from the terrain, in whichever direction the corruption pushed `y` —
  "under the map" (the user's original words) is at least as consistent with this as "floating",
  and more consistent with gravity-driven free fall specifically.
- **The squad-leader / "extremely long-lived" / "seen a lot, no kills" / "usually out of ammo,
  knife out" correlations**: not separate causes, just downstream consequences of being
  functionally unkillable once fallen (nobody can resolve it as a target) — it outlives everyone,
  inherits leadership by succession (BB-003's mechanism), can't reliably re-engage (its own
  targeting is equally corrupted), burns through ammo without resupply over an abnormally long
  life, and ends up on the knife not because knife causes the fall but because surviving long
  enough for the fall to have already happened tends to end in "dry."

The three previously-"ruled out" candidates above (stance height-blend, stale stowed-weapon
transforms, knife-charge pathing) stay ruled out — none of them touch `capsule.y` or gravity, and
none would explain a knife-free fall like `bot-1578`'s. The `bot-structures.js`
elevated-collision-geometry hypothesis is downgraded but not dead: it's a plausible *trigger* for
why `mapCollider.resolveCapsule` would fail to find ground under a bot in the first place (a hole
or seam in the collision mesh), it just isn't the mechanism that explains the symptom itself
(runaway gravity is).

**Open questions / next steps (revised)**
- ~~Find and read `mapCollider.resolveCapsule`'s implementation~~ — done, see update below.
- Try to reproduce the trigger directly: drive a bot to the exact `(x,z)` where `bot-1578` started
  falling (~`-49,-32` in the 072210 session's map) and watch `bot.onFloor` frame-by-frame.
- Wire a live/debug readout of `capsule.start.y` (there is currently no way to see it — not in the
  trace, not obviously in any on-screen HUD) so a human watching a session can catch the divergence
  the instant it starts, rather than reconstructing it after the fact from `target_dist` algebra.
- Consider logging `y` in the trace format going forward — the entire reason this took four bug
  numbers and a screenshot to notice is that vertical position was never captured anywhere.

**Update (2026-08-03, later): knife is very likely not implicated at all — checked two ways**

The user specifically asked whether ground/collision detection behaves differently depending on
whether the bot has a knife out. Worth checking directly rather than assuming from the one
`bot-1578` counter-example above, since that was a single case, not a systematic test.

1. **Structurally: it can't.** Read `map-collision.js`'s `resolveCapsule`/`resolveOnce`
   (lines 75-127) in full. The whole function is pure capsule-vs-BVH-triangle geometry —
   `resolveCapsule(capsule, velocity, { slopeLimitY, iterations })` — with zero parameters or
   references to weapon, tool, or FSM state anywhere in the file (`grep -n
   "weapon\|knife\|tool" map-collision.js` returns nothing). `stepBotPhysics` (bot-entity.js:41)
   doesn't pass any either. There is no code path for ground detection to know a knife is out.
2. **Empirically, across every available trace, it doesn't correlate either.** Extended
   `check-bot-elevation-gap.mjs` with a `--tol=N` flag and a per-observer-FSM-state flag-rate
   tally, then ran all 7 trace files in `bot-states/` through it at `--tol=30` (well above the
   routine ~3-15m measurement-noise floor the default 3m threshold picks up on nearly every state
   in nearly every file — that noise floor is not a useful lens for this question). At the ≥30m
   "smoking gun" severity: **every knife-state row across all 7 files came back clean — 0/11,
   0/3, 0/53, 0/9 (0/76 total)** — while the real severe anomalies concentrated in `seek`,
   `cover-move`, `cover-hold`, `heal`, and `flee` (e.g. the 072210 file's `bot-1578` fall,
   flee/`E`: 10/751 flagged). Aim, fire, pursue, patrol, and medic-tend were also clean, so this
   isn't simply "every other state is dirty and knife happens to be clean" — a handful of states
   carry essentially all of the observed severe events, and knife isn't one of them, in a
   reasonably sized sample (76 knife instances with zero hits, comparable to or larger than some
   states that DID show hits).

Between the code read and the cross-trace tally, there's no remaining basis to treat knife as
special. The likely full picture: whatever triggers `mapCollider.resolveCapsule` to lose the floor
happens during ordinary movement (seek/flee/cover, all common, all long before a bot is ever dry),
and the knife/squad-leader/no-kills correlation the user originally reported is pure survivorship
— it's what a bot that fell days-in-game-time ago and became functionally unkillable looks like by
the time anyone notices it, not a property of the knife state itself.

**Update (2026-08-03, later still): recovery shipped, and the "free fall forever" reading needed a
correction**

Reading `buildFloorMesh` (bot-viewer-v2.html) turned up a detail the trace-only analysis above
couldn't see: the generated terrain is a thin displaced sheet **with a flat catch slab under it**,
1.00 m below the lowest terrain vertex. That slab is ordinary collision geometry, so a capsule that
tunnels the sheet is caught by `mapCollider.resolveCapsule` and reads `grounded: true` — genuinely
grounded, on the wrong surface, with nothing in the viewer to move it back up (`rec.lastSafePos`'s
fall-catch lives in `environment-viewer-v2.html`, and only fires while `!onFloor`). So the persistent
state in the harness is "grounded ~1 m too low", not necessarily "still accelerating downward"; the
600 m figures reconstructed from `target_dist` in the 072210 trace are consistent with an
uncaught fall (a capsule that also tunnels the 0.1 m slab), not with a slab rest, so both shapes
plausibly exist. Nothing above is retracted — this only adds a second, likelier-in-the-harness way
for `capsule.y` to end up wrong and stay wrong.

Why an affected bot looks fine: `player-procedural-body.js` recomputes the visible body's height from
`terrainHeight(x,z)` whenever `onFloor` is true, so the rig renders standing correctly regardless of
the capsule's real Y. The weapon mount and the per-bot facing indicator read `bot.capsule.start.y` /
the capsule midpoint directly and are the two things that visibly detach — matching screenshot 03
("weapon floating over terrain") better than the whole-rig readings did.

Fix (this change): `stepBotPhysics` gained an opt-in `rescueHeightAt(x,z)` reference-height option;
when the capsule's rest height is more than `FLOOR_RESCUE_DEPTH` (0.75 m) under it, the capsule is
lifted back onto the ground, `velocity.y` is zeroed, `onFloor` is forced true, `bot.floorRescues` is
incremented and a `console.warn` fires. `bot-viewer-v2.html` passes `groundHeight` at both physics
call sites. The check is deliberately **not** gated on `onFloor`, so it recovers the slab-rest and
the uncaught-free-fall shapes alike. Full rationale, threshold derivation and why
`environment-viewer-v2.html` is deliberately not wired: `docs/subsystems/bots.md` → "Below-terrain
floor rescue". The `console.warn` is also the missing live readout the previous "next steps" asked
for: any session that hits this now says so in the console instead of only showing up in
`target_dist` algebra afterwards.

Still open: what makes the capsule cross the sheet in the first place (single-step tunnelling at
speed, push-out interactions, a seam in the collision mesh). The rescue makes the state transient
instead of permanent; it does not remove the trigger.

**Update (2026-08-03, later still): the console.warn is now throttled, with an on-screen banner as
the live readout instead.** Two independent reviews of the change above both flagged the same gap: if
the still-unidentified trigger turns out to be a persistent condition rather than a rare one-off, an
affected bot would warn every single frame. `bot.floorRescueWarnAt`, a per-bot dt-banked cooldown
(`FLOOR_RESCUE_WARN_COOLDOWN_S`, 3 s), now gates the `console.warn` only — every rescue still corrects
the capsule and counts immediately regardless of whether it logs. Since a throttled warning can no
longer be trusted to show every occurrence, `bot-viewer-v2.html` gained a `#floorwarn` HUD element
mirroring `updateNavWarnBanner`'s "stays on screen while load-bearing" pattern — the paragraph above's
"any session that hits this now says so in the console" is superseded by this: the banner, not the
console, is now the reliable live readout. Detail: `docs/subsystems/bots.md` → "Warn throttle +
on-screen banner".

**Update (2026-08-04): forensic capture built — the recovery is instrumented, the trigger is still
unidentified.** Everything shipped so far detects and papers over the fall. Nothing captured *why* the
capsule crosses the sheet, and the surviving evidence (`floorRescues`, the banner, a throttled
`console.warn`) says only "it happened", never what the physics was doing on the way in. This change
adds that capture.

`bot-forensics.js` (new, pure and THREE-free, re-exported by `bot-entity.js`) is a fixed-size ring
recorder: 1024 samples per bot (~17 s at 60 fps) over one preallocated 6.29 MB `ArrayBuffer`, nothing
allocated per frame. `stepBotPhysics` gained a fourth opt-in option, `forensics`, and takes exactly one
sample per call from *inside* the function — the only place `preY`, the integrated `velocity.y` before
the rescue zeroes it, the raw `contact.grounded` before the rescue forces `onFloor` true, and the
already-computed ground reference all coexist. `bot-viewer-v2.html` records every live bot (and dummy
target) continuously from its first physics step, deliberately **not** gated on "has this bot fallen
before" — a bot's first fall is exactly the one with no captured lead-up otherwise. On any rescue the
whole ring is frozen into a preallocated snapshot (first unexported rescue wins, exporting re-arms), the
`#floorwarn` banner names the bot with the take waiting, and `Shift+J` copies it as TSV. `?forensics=0`
is the kill switch / A/B control arm. Full schema, freeze policy and the perf-validation protocol:
`docs/subsystems/bots.md` → "Terrain-tunnelling forensic ring".

**What a future session should look at first in a captured take**, in this order:

1. **A `dt_ms` spike** on or immediately before the frame `post_y` dives. That is the plain-tunnelling
   hypothesis: one frame long enough that a single gravity step crosses a thin sheet. If this is the
   shape, the fix is a swept/substepped physics step or a dt clamp, not collision geometry.
2. **A nonzero `ext_dy`** (`pre_y[n] - post_y[n-1]`) on the dive frame. That proves something *outside*
   `stepBotPhysics` moved the capsule between frames — the prime suspect is `updateAllBots`'s
   post-pushout `mapCollider.resolveCapsule` re-resolve (bot-bot separation squeezing a capsule through
   a wall/floor seam), with stance capsule scaling second. If this is the shape, the physics step is
   innocent and the fix is at the pushout.
3. **`x`/`z` clustering** across several takes. Repeated falls at the same coordinates mean a seam or
   hole in the collision mesh (the `bot-structures.js` elevated-geometry hypothesis, downgraded but
   never dead), not a timing or velocity condition. Scattered coordinates rule it out.

These are mutually distinguishing, which is the point: the three candidate mechanisms that have been
argued about since this entry opened now each have a column that separates them. Nothing above is a
finding — no take has been captured yet.

**Update (2026-08-04, later): `state_key` was silently -1 in the exact reactive workflow the feature
exists for — fixed.** Two independent Sonnet reviews of the forensic-capture change above, given an
identical prompt, both traced the same gap: `forensicStateKey` was only ever stamped from inside
`botStateDescriptor`, and every call path into that function was gated on `botStateRecording`, which
defaults off. A user who saw the `#floorwarn` banner and pressed `Shift+J` without having separately
turned on state recording first got `state_key = -1` on every row, every time — the one diagnostic field
the plan called out as core to the feature, silently empty in the default case. Both reviewers judged it
disclosed-but-real, not a blocker (the primary `dt_ms`/`ext_dy`/`x`-`z` triage above doesn't depend on
it), and one traced that the fix was cheap: `botStateDescriptor` itself does no allocation or DOM work,
only reused-scratch-object writes, so it can run unconditionally. Fixed directly (no further agent
delegation — small, well-scoped, single-function change): `commitBotActor`, the one point every live
bot passes through every frame after its per-frame globals have landed, now calls `botStateDescriptor`
unconditionally, below the `botStateRecording` gate rather than through it. `state_key` is live from a
bot's first frame this session regardless of whether recording is on. Detail:
`docs/subsystems/bots.md` → "Terrain-tunnelling forensic ring" (the `stateKey` row and the paragraph
below the Int32 note). Not Node-tested — `commitBotActor`/`botStateDescriptor` are viewer-only globals
with no path into the Node test harness the way `bot-entity.js`/`bot-forensics.js` are; confirming
`state_key` populates correctly with recording off is browser verification, not yet done.

---

## BB-003: bot-814's one kill is a 3-second target-flicker, and it misses the one bot that feared it

**Status:** investigating
**Main bot:** bot-814, alpha, role `r` (rifleman), squad-92 (follower; leads a chain of three
squad leaders as they're killed off over the take — `bot-798` → `bot-804` → `bot-806`, its own
`squad_rank` climbing 4 → 3 → 2 → 1 as it moves up the succession order)
**Encountered by:** bot-829 (bravo) — the only bot that ever targets bot-814 in the whole take,
once, for one row
**Traces:** `bot-states/bot-state-trace-20260802-151350.tsv` (bot-814's rows span t≈8080–260660+),
`bot-states/bot-events-20260802-151350.tsv`

**Symptom**

Found by manually reading bot-814's full row history after BB-002 flagged this take as unusually
bad; the checker itself only caught a trivial 3s proximity blip on this bot (see below), not the
interesting part.

1. **The only kill it lands is jittery.** In the span t=67441–70367ms (under 3s) it cycles
   `target_id` four times — `bot-829` → `bot-818` → *(fires, kills bot-818 at t=68245)* →
   `bot-810` → `bot-833` → `bot-810` → blank. Two of those targets were acquired while
   `vis_gate` said **not visible** (`f` FOV-rejected, `w` LOS-blocked); `bot-818` only flips to
   `y` one row before the kill shot.
2. **It misses the one bot that was afraid of it.** At t=67397, `bot-829` (bravo) shows up
   fleeing bot-814 at 16.57m — tier4/score9 (near-max alarm), health band 0 (critical) — at the
   exact moment bot-814 first glances at it as a target (t=67441, 44ms later). bot-814 drops
   `bot-829` for `bot-818` on the very next target switch and kills that one instead. `bot-829`'s
   fear was aimed at a threat that had already moved on, and no bot ever targets bot-814 again
   for the rest of the take.
3. **~75% of its recorded life has no target at all.** From t≈70000 to the end of the pulled
   range (t≈260660, ~190 of its ~252 recorded seconds), `target_id` is blank almost
   continuously — including one full **squad push** (t≈206497–217574, tier4/score4,
   `element=m` moving) where it's part of an aggressive coordinated advance under max alert and
   never acquires a visible enemy the entire time.

**Evidence**
- `awk -F'\t' '$2=="bot-814"' bot-states/bot-state-trace-20260802-151350.tsv` — full row history.
- `awk -F'\t' '$17=="bot-814" && $2!="bot-814"'` on the same file returns exactly one row: the
  `bot-829` flee-contact at t=67397.
- `bot-events-20260802-151350.tsv` grep for `bot-814`: exactly one row, the `bot-818` kill at
  t=68245, no damage events either side.
- `check-bot-target-attribution.mjs`'s only flag on this bot: `[one-sided] bot-814 <-> bot-833,
  t=72000-72000 (0.0s), min dist 11.8m, peak streak 3s` — a footnote next to the actual pattern.

**Suspected mechanism**

Same family as BB-001/BB-002 (target/alert selection not tracking multiple live contacts), but
this is a third distinct shape: not "never perceived despite killing/being fled from" (BB-001) or
"sustained silent proximity" (BB-002), but rapid target reassignment that abandons a contact the
instant a more salient one appears — even when the abandoned contact (bot-829) had already
correctly identified bot-814 as the threat. Also reinforces BB-002's read that this take
(151350) has something systemically off: two independently-found bots (bot-744, bot-814) both
show the "escalates to real alert/push tiers but rarely or never resolves a target" shape.

**Open questions / next steps**
- Is the four-way target flicker in 3 seconds normal contention among multiple nearby enemies,
  or a reassignment heuristic that's too eager to drop a committed target? Needs the actual
  target-selection predicate, not just the trace.
- Would a "don't drop a target that's actively fleeing you" tie-break change this bot's outcome,
  or is `bot-829` surviving/dying elsewhere irrelevant to whether this is a bug?

**Update (2026-08-02, later take): its eventual death is the same bug, mirrored**

A newer, separate take (`bot-state-trace-20260802-153238.tsv` / `bot-events-20260802-153238.tsv`,
bot-814's rows span the whole take) caught this bot's actual death, and it's the single-target-slot
gap again, just inverted: this time bot-814 is the one that fails to perceive the threat, not the
one that gets missed.

By t≈1358000 bot-814 had gone on a 30+ kill rampage earlier in the take and then run completely
dry — `mag/reserve/sidearm_mag/sidearm_reserve` all `0/0/0/0` — and was reduced to fleeing, then
knife-fighting `bot-1186`, closing 9.6m → 6.7m. `target_id` stays locked on `bot-1186` for the
entire final two seconds.

The killing blow came from `bot-1087`, a bravo rifleman from an unrelated squad (squad-112) that
had been doing `cover`/`seek` 34–51m away with no prior connection to the fight. At t=1362280 it
picked up `target_id=bot-814` at 31.84m with a clean `vis_gate=y` line the whole time, and put
three cz_805_bren bursts into it (health 71→47→23→0) in 358ms, killing it at t=1362638.

bot-814's own rows never show `bot-1087` anywhere — not in `target_id`, and `self_threat` stays
flat `0` through all three incoming hits. It died to a fully visible rifleman at medium range while
its one target slot was pinned on the knife opponent 7m in front of it, with no mechanism to
register the second, lethal threat even as a score bump.

Same family as the target-flicker finding above, but where that one showed the bug from the
*attacker* side (dropping a contact that already knew to fear it), this shows it from the
*victim* side (dying to a threat that never entered its own single-slot awareness at all).

**Update (2026-08-03):** see BB-004's update note — this whole family is very likely explained by
`entity.capsule.y` occasionally diverging from ground truth (unrecovered free fall) while `x`/`z`
stay correct, silently exploding the 3D `target_dist` used for sight-range gating. Not confirmed
for bot-814 specifically (no elevation-gap check has been run against this bot yet), but the
mechanism now has direct numeric confirmation in the 151350 and 072210 traces.

## BB-002: take 151350 — bulk unattributed hits and sustained silent proximity (bot-744 flagship)

**Status:** investigating
**Main bot:** bot-744, alpha, role `r` (rifleman), squad-1 (starts `squad_rank 1` under leader
`bot-736`; by the end of the pulled range, t=260660, it's `squad_rank 0` — its own leader died
and it inherited the squad, same succession pattern as BB-003's bot-814 in squad-92)
**Encountered by:** dozens of bravo bots it stood within point-blank range of and never
perceived, including bot-808 (0.6m min distance, continuously close for up to 183s), plus
bot-803/805/807/809/847/849/851 and a long tail of others (see the checker's `[3]` output for
the full list)
**Traces:** `bot-states/bot-state-trace-20260802-151350.tsv` (19,014 rows, ~4.5 min take),
`bot-states/bot-events-20260802-151350.tsv` (480 events)

**Symptom**

Running `check-bot-target-attribution.mjs` against this take (in the same breath as the two
known-shape 1436xx takes, as a regression check) turned up numbers an order of magnitude worse
on check 3: **110 silent/one-sided proximity encounters** (40 one-sided, 70 fully silent) versus
2-3 on each of the 143625 and 144000 takes. Check 2 (unattributed hits) also flagged 206 of 480
events (43%), but that's within the ~44% baseline rate already seen on the 143625 take — see the
Tooling section's caveat — so it's not treated as anomalous on its own here.

`bot-744` is the clearest single example: it legitimately escalates to tier3/score8 over the
match and takes cover multiple times (real alert behavior, not a stuck/frozen bot — it moves
across most of the map, x from -1.6 to 137, z from -2.7 to 41.7), but it **never once sets
`target_id`, deals damage, or takes damage** in the entire take (zero rows in
`bot-events-20260802-151350.tsv` for it, either side) — while repeatedly standing within 0.6-2m
of a dozen-plus different bravo bots for stretches from a few seconds up to 183 seconds straight.

**Evidence**
- `node check-bot-target-attribution.mjs bot-states/bot-state-trace-20260802-151350.tsv` — full
  report; check 3 alone lists 110 pairs, many involving bot-744.
- `awk -F'\t' '$2=="bot-744"{print substr($4,1,1)}' ... | sort | uniq -c'` → `C 63, G 34, P 140,
  S 105` — a real mix of patrol/seek/cover states, not a frozen bot.
- `awk -F'\t' 'NR==1 || $3=="bot-744" || $5=="bot-744"' bot-events-20260802-151350.tsv` → header
  only, zero matching rows.
- Comparable run on `bot-state-trace-20260802-143625.tsv` and `-144000.tsv` in the same
  invocation: 3 and 2 silent/one-sided pairs respectively, for scale.

**Suspected mechanism**

Same underlying gap as BB-001 (multi-threat contact model, single-slot target/alert tracking),
but the jump from single-digit to 110 flagged pairs suggests this take's setup (bot count, map,
squad density — not yet compared against the 1436xx takes' configs) may be stressing target
acquisition harder, rather than this being a rarer edge case. See also BB-003 (bot-814, same
take) for a second, differently-shaped instance of "escalates to real alert but rarely resolves
a target."

**Open questions / next steps**
- What differs about this take's spawn/map/bot-count config versus the two 1436xx takes? If it's
  just "more bots," the contact-model gap may scale badly with roster size specifically.
- Is 110 pairs mostly a handful of bots each in many pairs (as bot-744 suggests) or spread evenly
  across the roster? Worth a quick tally of which bot IDs recur most across the flagged pairs.

**Update (2026-08-03):** see BB-004's update note — `check-bot-elevation-gap.mjs` run against this
exact file (`bot-state-trace-20260802-151350.tsv`) found `bot-808`/`bot-856` diverging by 566m
while both bots' own `x`/`z` stayed at plausible, close-together coordinates, matching runaway
`capsule.y` free fall. `bot-744` itself can't be checked the same way — the tool needs at least one
`target_id` reference to back out a gap, and bot-744's whole signature (per this entry) is that it
*never* sets or receives one, in either direction, the entire take. That total silence is at least
as consistent with "fell out of sight range before any pair ever logged a valid distance" as it is
with anything else, but it's not independently confirmed for this specific bot.

## BB-001: bot-262 never appears as any other bot's `target_id`, in either direction

**Status:** investigating
**Main bot:** bot-262, bravo, role `m` (medic), squad-27 leader (`squad_rank 0`, `leader_id` self)
**Encountered by:**
- Take 1 (never targeted *by*, despite killing them): bot-247, bot-261, bot-189, bot-240,
  bot-245, bot-259, bot-290 (all alpha) — plus bot-284 (bravo squadmate, who absorbed alpha's
  targeting attention instead)
- Take 2 (bot-262 fled/knifed *them*, but was never targeted back): bot-362, bot-364, briefly
  bot-281 (all alpha)

**Traces:**
- `bot-states/bot-state-trace-20260802-143625.tsv` (t=0–74.2s, combat take)
- `bot-states/bot-events-20260802-143625.tsv` (kill/damage log for the same take)
- `bot-states/bot-diag-20260802-143625.json` (world meta for the same take)
- `bot-states/bot-state-trace-20260802-144000.tsv` (t=0–68.4s, flee/knife take, separate
  recording started ~2m20s after the first take ended — the gap between them is not recorded)
- No `bot-events-20260802-144000.tsv` exists — zero damage/kill events team-wide in that take

**Symptom**

1. **Take 1:** bot-262 is the single most productive bot in the match — 6 kills, 20
   damage/kill events (next-highest is 13) — yet across ~2,900 trace rows, **no other bot's
   `target_id` column ever equals `bot-262`**. Every one of its six victims' own last recorded
   `target_id` before dying was either blank or `bot-284` (bot-262's bravo squadmate, who is
   also a real threat — 3 kills, 13 events — but far less lethal than bot-262). Alpha's
   targeting/fleeing attention fixated on bot-284 while bot-262 fought unopposed in the same
   fight.
2. **Take 2:** bot-262 opens already fleeing bot-362 and spends the first ~12s thrashing
   between flee and knife against bot-362/bot-364 at down to ~2m range, including a
   flee-boundary oscillation stretch (4 state changes in ~600ms around t=10.7–11.3s). But
   bot-362, bot-364, and (briefly, at large `target_dist`) bot-281 sit in plain calm
   `P00r-4320`/`P00r-4310` patrol — tier 0, score 0, `target_id` blank — for **every single row
   of the entire 68s take**. They never register bot-262 as a contact at all.

Net: in neither take does any other bot's `target_id` ever equal `bot-262`, in either direction
of engagement.

**Evidence**
- `awk -F'\t' '$17=="bot-262" && $2!="bot-262"'` on both trace files returns 0 data rows.
- Alpha-team `target_id` frequency count in take 1 (`awk -F'\t' '$3=="alpha"{print $17}' | sort
  | uniq -c`) never lists `bot-262` among its ~20 distinct values.
- Victim-side check: for each of bot-262's 6 kills, the victim's own rows in the ~1.2s before
  its `D...` row show `target_id` blank or `bot-284`, never `bot-262`.
- `bot-events-20260802-143625.tsv` attacker counts: bot-262 leads with 20 events / 6 kills;
  bot-284 (the bot alpha actually reacted to) has 13 events / 3 kills.
- `bot-362`/`bot-364` full row dumps for take 2: `tier`/`score` columns are `0`/`0` and
  `target_id` is blank on literally every row from t=0 to t=68175.

**Suspected mechanism**

Overlaps two known gaps already in memory:
- [Multi-threat contact model plan] — target/alert selection appears to be single-slot per
  side, fixating on one perceived threat (bot-284) rather than tracking multiple simultaneous
  attackers (bot-262 alongside it).
- [Bot split attention] — threat model is single-slot; FOV cone gates perception but the
  contact model itself may not reconcile multiple live shooters.

Take 2 additionally suggests contact detection may not be symmetric: bot-262's own flee/knife
commit fires off *something* (proximity? a stale/one-sided sentry read?) that bot-362/bot-364's
own sentries never independently confirm, since their tier/score never leave calm the whole
time. Not yet traced to a specific predicate in `bot-alert.js` / `bot-activity.js`.

**Open questions / next steps**
- Is this specific to bot-262/bot-284/squad-27 in this session, or reproducible with other IDs?
  Needs a fresh recorded take to check.
- Read the target-selection code path (`bot-alert.js`/whatever chooses among multiple visible
  attackers) to see why bot-284 wins over bot-262 as alpha's registered contact.
- Read whatever triggers bot-262's flee/knife commit in take 2 to see if it's gated on a mutual
  LOS/FOV check with bot-362/bot-364 or a one-sided distance read.
- The untraced ~2m20s gap between the two takes is also worth closing: bot-262 goes from a
  well-armed 20/67-mag killer at the end of take 1 to completely disarmed (0 ammo, 0 reserve, 0
  packs, both weapon slots) at the start of take 2, with nothing recorded in between.

**Update (2026-08-02, automated check):** built `check-bot-target-attribution.mjs` (see Tooling
above) to catch this pattern automatically. Running it against both takes confirmed the ghost
combatant/one-sided findings above and turned up a **second** ghost combatant in take 1 that the
manual read missed: `bot-297` (5 damage events, 0 kills, never targeted by anyone either). See
BB-002/BB-003 for what the same tool found in a third, newly-captured take.

**Update (2026-08-03):** see BB-004's update note for the mechanism this family very likely shares
-- `entity.capsule.y` occasionally diverging from ground truth (unrecovered free fall) while `x`/`z`
stay correct, silently exploding the 3D `target_dist` sight-range gate in both directions.
**Not independently confirmed for bot-262 specifically**: running `check-bot-elevation-gap.mjs`
against this entry's own two files (`143625`/`144000`) doesn't turn up anything at the 566m/635m
scale found elsewhere -- max ~10m and ~7m respectively, which is within plausible normal
noise/eye-offset range, not a smoking gun. The mechanism is solidly established (BB-002/003's file,
and the 2026-08-03 session) and is the leading candidate for this entry's shape too, but bot-262's
own ghost-combatant instances haven't been pinned to it directly yet -- would need a fresh take
that reproduces the same pattern while this checker is run alongside it.
