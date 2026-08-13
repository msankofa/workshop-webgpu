# Bot brain + navigation parity: bot-viewer-v2.html vs environment-viewer-v2.html

Investigation date: 2026-08-08. Scope: FSM/think loop, perception, combat decision-making, roles/squads,
navigation. Method: import-diff between the two HTML files (both draw on the same shared module files,
with no `?v=` cache-busting divergence found on any bot-brain module — see "Method note" below), followed
by targeted `Grep`/`Read` of call sites in both files and the shared modules themselves. No files were
modified. No browser tools were used.

**MEASURED vs INFERRED.** Every claim below is MEASURED (grepped and read directly) unless explicitly
flagged INFERRED. Several sub-investigations were delegated to parallel research agents (noted per
section); their citations were spot-checked but not re-verified byte-for-byte by the compiling agent
except where called out.

**Method note — why "parity" mostly means "call-site parity."** Both HTML files import from the *same*
relative-path module files (`bot-entity.js`, `bot-activity.js`, `nav-grid.js`, `bot-alert.js`,
`bot-cover.js`, `bot-danger.js`, `bot-aim.js`, `bot-sidearm.js`, `bot-grenade.js`, `bot-stance.js`,
`bot-roles.js`, `bot-squad.js`, `bot-medic.js`, `bot-health-packs.js`, `bot-pursuit.js`,
`bot-spatial-hash.js`, `nav-visibility.js`, `nav-corners.js`), with no `?v=` cache-busting suffix on any
of them in either file (confirmed by grepping `\.js?v=` in both — the only `?v=` hits in
environment-viewer-v2.html are for terrain/vegetation/sky modules unrelated to bots). So there are no
duplicated/forked copies of the bot-brain logic itself — any behavioral drift necessarily comes from (a)
which exported names each HTML actually imports, (b) inline logic in the HTML around those calls, or (c)
call-site arguments/constants. This report is organized around exactly those three sources of drift.

---

## Summary table

| Area | Sub-area | bot-viewer-v2.html | environment-viewer-v2.html | Verdict |
|---|---|---|---|---|
| FSM | Core state ladder (`chooseBotStateName`) | shared, identical ctx construction | shared, identical ctx construction | **identical** |
| FSM | Manual "break contact" order (`orderOverride`) | present | absent entirely | **missing** |
| FSM | Forced crouch during self-heal (`BOT_HEAL`) | applies to every role incl. medics | excludes `ROLE_MEDIC` | **drifted** |
| FSM | `holding` (commanded-hold) predicate | allow-list of 3 states | deny-list of 6 states (not equivalent) | **drifted** |
| FSM | Full-decision-pass think-cadence stagger | present, roster-size-scaled | absent — every bot thinks every frame | **missing** |
| FSM | Target-rescan stagger (`TARGET_SCAN_STRIDE`) | present (stride 4) | present (stride 4), identical | **identical** |
| FSM | "Stuck" detection + forced replan | **absent entirely** | present (`trackStuck`) | **missing (reversed — v2 lacks it)** |
| FSM | Bot forensics (BB-004 debug recorder) | present, default-on | absent | **missing** |
| FSM | Goal claims / hashed separation call sites | shared, ~30 matching call sites | shared, matching call sites + intentional radius-arg difference | **drifted (documented/intentional)** |
| Perception | FOV cone (`withinBotFov`, 150°) | shared, identical | shared, identical | **identical** |
| Perception | Eye height model | uniform `EYE_LIFT = 0.85` both ends | asymmetric: self = capsule top (1.0), target ≈ 0.8×h | **drifted** |
| Perception | LOS raycast depth | flat `mapCollider.raycast` (maze-appropriate) | terrain/tree-aware march via `resolveHitscan` | **drifted (intentional — different environments)** |
| Perception | Baked-field LOS prefilter before raycast | present (`USE_FIELD_LOS_PREFILTER`) | absent entirely | **missing** |
| Perception | Secondary-threat cover veto occlusion check | present (`fieldSaysHidden`) | absent — range/FOV only | **missing** |
| Perception | Alert propagation / escalation tiers | shared, identical call sites | shared, identical + extra `BOT_PUSH_TIER_ENABLED` flag (defaults on) | **identical** |
| Perception | Split attention (`stepAttention`/`attentionSweep`) | shared, identical call sites | shared, identical call sites | **identical** |
| Perception | Contact / sighting memory (`bot-contacts.js`) | present, cleared on live map rebuild | present, same write path, **no** clear-on-rebuild | **drifted (minor)** |
| Perception | Target-selection scoring math | shared, identical | shared, identical | **identical** |
| Perception | `perceivedEnemies` POV snapshot | present | absent | **missing (plausibly intentional — no POV HUD)** |
| Combat | Aim/spread core (bot-aim.js) | shared, identical | shared + extra `inaccuracy01` widening term | **drifted** |
| Combat | Fire gating | identical structure | identical structure (+ a weapon-lookup fallback) | **identical** |
| Combat | Sidearm `inGunfight` gate | uses own last-known-target recency | uses ally-report recency only | **drifted** |
| Combat | Sidearm same-frame swap-then-fire (bug-fix pattern) | two `updateBotWeaponSlot` call sites | one call site only | **missing** |
| Combat | Grenade self-veto pre-gate | occlusion-aware (`blastReachesBody`) | bare distance check | **drifted** |
| Combat | Grenade evade exit hysteresis | present (`engagedId`, 1.25× ring) | absent | **missing** |
| Combat | Melee/knife reachability | present | present | **identical** |
| Combat | Melee/knife hit-resolution mechanism | guaranteed distance-gated hit | facing-dependent raycast swing via `combat.js` melee intent | **drifted (architecturally different)** |
| Combat | Knife commit/cooldown timing | 8000 / 5000 ms | 12000 / 6000 ms | **drifted** |
| Combat | Manual stance override (command wheel) | present | absent | **missing** |
| Combat | Auto RUN/DASH stance selection | present | present, same shared logic | **identical** |
| Roles/Squads | Role assignment distribution | shared `assignRolesToBatch` | shared, identical call shape | **identical** |
| Roles/Squads | Sniper/technical effect wiring (`sightScale`/`closeRange`/`swapOnDryMag`) | shared | shared, identical | **identical** |
| Roles/Squads | Squad formations (ranks/kind/member goal) | shared `bot-squad.js` | shared `bot-squad.js` | **identical** |
| Roles/Squads | Squad debug overlay (`squadSlotWorld`) | present | absent | **missing (debug-only, no behavioral effect)** |
| Roles/Squads | Medic decide/heal/revive core | shared `bot-medic.js` | shared `bot-medic.js` | **identical** |
| Roles/Squads | Medic creep-to-contact (final-stride close) | present | absent | **missing** |
| Roles/Squads | Medic/flee squad-centroid math | shared `teamCentroid` | reimplemented inline (`fleeSquadCentroid`), same math | **drifted (duplicated code)** |
| Roles/Squads | Health-pack core math | shared `bot-health-packs.js` | shared, identical | **identical** |
| Roles/Squads | `packsTotalHp` HUD label | present | absent | **missing (cosmetic only)** |
| Roles/Squads | Scoring / round-outcome system (`bot-score.js`) | present | **absent entirely** | **missing** |
| Roles/Squads | Home base / team-region generation (`bot-structures.js`) | procedural `generateHomeBase` | substituted with `teamSpawnPoints()` from authored map data | **drifted (intentional)** |
| Navigation | Nav-grid build + region connectivity | `buildNavGrid` (single-shot; calls `finalizeNavGrid` internally) | same, plus a second, chunked/incremental `finalizeNavGrid` path for Phase-D | **identical (env has an added capability)** |
| Navigation | A* pathfinding / smoothing | shared `nav-grid.js` | shared `nav-grid.js` | **identical** |
| Navigation | Flood-fill (flee-goal search etc.) | shared | shared | **identical** |
| Navigation | Cover/corner selection | shared `bot-cover.js`/`nav-corners.js` | shared, + a terrain-grid-scale final-approach correction | **drifted (intentional, terrain-scale)** |
| Navigation | Danger field | shared `bot-danger.js`, matching call pattern | shared, matching call pattern | **identical** |
| Navigation | Terrain source feeding the nav grid | `bot-terrain.js` (closed-form arena/maze terrain) | `terrain-system.js`/CDLOD + a whole extra "Phase D" persistent zone-bake subsystem | **drifted (intentional — biggest structural difference in the whole comparison)** |

---

## Detailed findings

### 1. FSM states, transitions, think cadence, stuck detection, goal claims

*Researched by a delegated sub-agent; citations below are as returned by that agent. Not independently
re-verified line-by-line by the compiling agent except where noted.*

**Core ladder — identical.** All ten states (`BOT_PATROL/SEEK/PURSUE/FLEE/HEAL/KNIFE/AIM/FIRE/COVER_MOVE/COVER_HOLD`)
plus the harness-local `MEDIC_MOVE`/`MEDIC_TEND`/`'alert'` pseudo-states are driven by the same shared
`chooseBotStateName` (bot-activity.js:42-125), called once per bot per think tick:
`bot-viewer-v2.html:10625` vs `environment-viewer-v2.html:6425`, both feeding one reused `_fsmCtx` object
per frame (comment "M1" at `bot-viewer-v2.html:10602` / `environment-viewer-v2.html:6406`). The ctx-field
construction (`targetVisible, aimError, readyToFire, hasLastKnown, targetDistance, pursueDistance,
pursueExitBuffer, keepsMissing, pursueHealthOk, fleeDistance, fleeExitBuffer, fleeCommitted,
knifeRequested, healRequested, healFleeCommitted, healReady, healUnsafe, hasHealResource,
coverAvailable, atCoverAnchor, coverValid, allyHitNearby, coverCommitted, fireCapable, knifeCapable,
closeSelfThreat, reloading`) matches line-for-line: `bot-viewer-v2.html:10603-10622` vs
`environment-viewer-v2.html:6407-6420`. The post-ladder overlays also match: H6a close-threat
spin-onto-attacker (`bot-viewer-v2.html:10628-10634` vs `environment-viewer-v2.html:6426-6432`),
medic-duty override via `decideMedicDuty` (`:10638-10644` vs `:6436-6442`), cover-corner self-heal
invariant (`:10652-10658` vs `:6443-6449`), squad-alert hold → `'alert'` pseudo-state (`:10659-10675` vs
`:6450-6460`).

**Divergence — `orderOverride` ("break contact" manual command) is bot-viewer-v2-only.**
`bot-viewer-v2.html:10616-10617` sets `c.orderOverride = commandBreakContact && !!commandGoal && (...)`,
backed by a command-wheel UI (`commandBreakContact`, `commandGoal`, `commandTargetId`, `wheelSpoke(...)`
at `bot-viewer-v2.html:583-711`, confirmed present via direct grep by the compiling agent:
`commandMenuEl`/`commandDoubleTime` first appear at `bot-viewer-v2.html:583-614`).
`environment-viewer-v2.html` has **zero** occurrences of `orderOverride`, `commandBreakContact`,
`commandGoal`, `commandTargetId`, `commandMenu`, or `wheelSpoke` (grepped, no matches — confirmed
independently by the compiling agent). Since `chooseBotStateName` destructures `orderOverride = false`
(bot-activity.js:53) and the field is never written on the shared ctx in environment-viewer-v2, the rung
that pulls a bot straight back to `BOT_PATROL` on manual order (bot-activity.js:96-101/120) is
unreachable there — the feature was never ported, not merely bugged.

**Divergence — forced crouch during self-heal excludes medics only in environment-viewer-v2.**
`bot-viewer-v2.html:10682-10683`: `const forcedCrouch = state === BOT_HEAL || activeBotActor.packPickupCrouchUntil > now;`
(comment at `:10698`: "No medic fields here any more: every tend kneels").
`environment-viewer-v2.html:6464`: `const forcedCrouch = (state === BOT_HEAL && rec.role !== ROLE_MEDIC) || rec.packPickupCrouchUntil > nowMs;`
— a self-healing medic bot crouches in bot-viewer-v2 but stands in environment-viewer-v2. (`MEDIC_TEND`
forced-crouch, a separate code path, is gated identically in both.)

**Divergence — `holding` (S13 commanded-hold) predicate is not equivalent.**
`bot-viewer-v2.html:10678-10679`: `const holding = activeBotActor.holdUntil > now && (state === BOT_PATROL || state === BOT_SEEK || state === BOT_PURSUE);`
(allow-list of 3 states).
`environment-viewer-v2.html:6467-6468`: `const holding = rec.holdUntil > nowMs && state !== BOT_FLEE && state !== BOT_HEAL && state !== BOT_AIM && state !== BOT_FIRE && state !== BOT_COVER_HOLD && state !== BOT_KNIFE;`
(deny-list of 6 states). environment-viewer-v2's version can be true for `BOT_COVER_MOVE` and `'alert'`,
which bot-viewer-v2's allow-list excludes — this feeds `sc.holding`/`sc.holdElapsedMs` on the stance ctx
and downstream locomotion-hold gating.

**Think cadence / staggering — a real, significant gap.**
`bot-viewer-v2.html` has a full-decision-pass stagger for large rosters: `botThinkStride(livingCount)`
(`:3128-3131`) returns a manual override if forced via `?stagger=` (`:3064-3067`), else auto:
`livingCount > 80 ? 3 : livingCount > 40 ? 2 : 1`. Computed once per frame (`:3341`), applied per-bot
(`:3364-3371`): the full FSM decision pass (`updateBotSentry`) only runs when
`thinkStride === 1 || actor === focus || (botFrameCounter + actor.scanPhase) % thinkStride === 0`; dt is
accumulated in `actor.thinkDtAcc` between ticks. Movement/physics (`updateBot`) still runs every frame
(`:3373`); the camera-focused bot always thinks every frame.
`environment-viewer-v2.html` has **no equivalent**: `botTickOne` (`:6659`) calls `updateBotSentry` (the
decide+move pass) unconditionally (`:6661`), and `updateBots` (`:6989`) loops every bot with no
stride/frame-count gate. Grepped `stagger`, `thinkInterval`, `thinkEvery`, `thinkHz`, `thinkStride`,
`botThinkStaggerMode` in environment-viewer-v2.html: no matches. A *narrower* stagger does match: both
files define `TARGET_SCAN_STRIDE = 4` (`bot-viewer-v2.html:6405` / `environment-viewer-v2.html:3638`) for
target-rescan only, with an identical spawn-order phase offset (`scanPhase: nextBotId & 3` at
`bot-viewer-v2.html:7758` vs `scanPhase: botIdSeq & 3` at `environment-viewer-v2.html:2798`). So
target-rescan staggering agrees; full-FSM staggering at scale does not — bot-viewer-v2 throttles the
entire per-bot decision pass past 40/80 bots, environment-viewer-v2 does not.

**Stuck detection — definitively confirmed asymmetric, in the *unexpected* direction.**
`environment-viewer-v2.html` imports `trackStuck as botTrackStuck` (`:102`, confirmed by compiling agent
at current line 99 — see line-number caveat below) and wires it into `botTickOne`
(`:6702-6721`): computes `movedDist` from actual capsule displacement (not commanded velocity — a
deliberate choice per the comment at `:6706-6707`, since `pushBotsApart` corrects position without
touching velocity), excludes `BOT_AIM/BOT_FIRE/BOT_COVER_HOLD/'alert'` from `moving` (`:6708`), and on
`stuck.stuckMs > BOT_STUCK_FORCE_REPLAN_MS` forces a path replan under a retry cooldown (`:6711-6721`),
layered on an env-specific escape/teleport fallback (`escapeTarget`, `BOT_STUCK_ESCAPE_RETRIES`,
`BOT_ESCAPE_TIMEOUT_MS`, `:6663-6701`). State fields: `stuckSince: null` at spawn (`:2796`), reset at
`:4576`.
`bot-viewer-v2.html` has **none of this**. Its bot-activity.js import list omits `trackStuck` entirely
(`:6609-6615`), and grepping `stuck` case-insensitively across the whole file returns only 5 hits, all
comments/UI copy (lines 2770, 7584, 9995, 12779, 14004) — zero behavioral matches for `trackStuck` or
`stuckSince`. The nearest analog, `tryPatrolEscape` (`:8375-8401`), is a *path-availability* escape (fires
only when patrol path-planning to every patrol point in the bot's own nav region has failed, on a
6000/8000 ms delay), which detects sealed nav pockets — not the same failure mode as "bot has a nominally
valid path but isn't making progress" (e.g. jammed against geometry or another bot), which
environment-viewer-v2's `trackStuck` does catch. **Net: the game-side viewer has stuck-recovery logic the
"authoritative" harness lacks.**

**Bot forensics — bot-viewer-v2-only debug instrumentation.**
`bot-viewer-v2.html:909` imports `createBotForensics`; instantiated at `:3425-3426`:
`const botForensics = new URLSearchParams(location.search).get('forensics') === '0' ? null : createBotForensics();`
— **on by default**, opt-out only. Comment (`:3420-3424`) identifies it as the BB-004 investigation tool
recording every live bot's physics from its first step (~6.3 MB, allocated once). `bot-entity.js:130`
re-exports `createBotForensics, FORENSIC_RING, FORENSIC_MAX_SLOTS, FORENSIC_STRIDE, FORENSIC_COLUMNS`
from `./bot-forensics.js`, so the symbol was available to environment-viewer-v2 and simply was not
imported (confirmed zero matches for `createBotForensics`/`bot-forensics` in environment-viewer-v2.html).

**Goal claims / separation — near-exhaustively parallel, one intentional argument difference.**
Every `goalClaims.claim/release/isClaimedByOther` call site for the six claim kinds (`cover`, `flee`,
`seek`, `pursue`, `recover`, `pack`) appears in both files at matching points in the control flow
(≈30 call sites cross-referenced by the sub-agent). `waypointContestedHashed`/`separationXZHashed`/
`blendSeparationDir` call shapes match exactly (`bot-viewer-v2.html:7963/7997/8000` vs
`environment-viewer-v2.html:4664/4697/4700`). One documented, intentional difference:
`resolveBotPairsHashed` — `bot-viewer-v2.html:3382` calls it with no radius argument (falls back to each
entity's own `capsule.radius`, per bot-separation.js:114-126), while `environment-viewer-v2.html:3233`
passes `maxR + BOT_COLLIDE_PAD * 0.5` explicitly, called out in an inline comment
(`environment-viewer-v2.html:3229-3230`) as reproducing the harness's old combined-minDist behavior while
adding an env-only padding constant. environment-viewer-v2 also runs a second, harness-absent pushout pass
against the local human player (`:3237-3250`) — expected, since bot-viewer-v2 has no player entity.

**Line-number caveat (sub-agent note, relevant to this whole report):** the sub-agent researching
perception flagged that some line numbers supplied in its briefing context (captured earlier in this
session) were already stale by a few lines by the time it re-read the file — e.g. the bot-alert.js import
block was briefed as `environment-viewer-v2.html:111-119` but is actually at `:114-122` as of this
writing, and `SIGHT_BLOCK_HEIGHT`'s import line moved from `:155` to `:158`. This means
**environment-viewer-v2.html was edited during this investigation** (it's the actively-developed file per
project convention). Line numbers throughout this report are as read by each investigating agent at the
time it read that region; treat them as accurate to within a handful of lines rather than exact if the
file has changed again since.

### 2. Perception — FOV, LOS, eye height, alert, contacts, target selection

*Researched by a delegated sub-agent; citations below are as returned by that agent.*

**FOV cone — identical.** `withinBotFov` is byte-identical logic in both:
`bot-viewer-v2.html:6387-6396` vs `environment-viewer-v2.html:3842-3849` (yaw-cone dot-product test, same
`Math.max(botBehaviorSettings.fovDegrees, tier.fovDegrees ?? 0)` widening). Default `fovDegrees: 150` in
both (`bot-viewer-v2.html:7648`, `environment-viewer-v2.html:3585`/`3586`, confirmed independently by the
compiling agent).

**Eye height — real, measured numeric divergence.**
`bot-viewer-v2.html` uses one function, `eyePos`/`eyePosInto` (`:7102-7108`), for *both* the perceiving
bot's own origin and every candidate's aim point: `capsule.start.lerp(capsule.end, EYE_LIFT)` with
`EYE_LIFT = 0.85` (`:6652`) — used uniformly across 20+ call sites.
`environment-viewer-v2.html` splits this into two different, non-matching functions (confirmed
independently by the compiling agent, which found the same split by a different route while checking
`EYE_LIFT` usage): `botEyeInto` (`:3421`/`3422`) returns `entity.capsule.end` **directly** — i.e. LIFT =
1.0, the literal top of the capsule — used for the perceiving bot's own origin. Targets/candidates instead
go through `humanAimInto` (`:3423-3427`/`3424-3426`): `state.p[1] + (state.h ?? 1.6) * 0.3`, which for a
bot candidate (built from capsule midpoint + height in `rebuildEnemyCandidates`, `:3862-3888`) works out
to `start.y + 0.8*h` — close to but not equal to bot-viewer-v2's uniform 0.85. **Net effect:**
environment-viewer-v2 has an internal self-vs-target eye-height asymmetry (1.0 vs ≈0.8) that
bot-viewer-v2 does not have (uniform 0.85 both ways), and neither of environment-viewer-v2's two formulas
matches bot-viewer-v2's exactly. This directly affects LOS-ray origin/endpoint geometry — most consequential
at cover edges and low walls, where a few centimeters of eye-height difference can flip a visibility check.

**`SIGHT_BLOCK_HEIGHT` — not a functional gap, environment-specific need.** Only environment-viewer-v2
imports it (`nav-visibility.js:8`, `SIGHT_BLOCK_HEIGHT = 1.5`), using it to filter which authored
primitives count as sight-blocking rects (`shootHouseSightRects`, `:2307-2318`/`2309-2318`;
`botTerrainSightRects`, `:2404-2431`/`2406-2431`). bot-viewer-v2 doesn't need it because its maze
sight-blocker list is simply `[...activeWalls, ...activeCovers]` (`:7499`), which are always full-height
by construction.

**LOS raycast depth — intentional environment difference, not drift.**
`environment-viewer-v2.html`'s `botHasLineOfSight` (`:3165-3175+`) routes through `resolveHitscan` with
`obstacleColumnsAlongRay` and a terrain heightfield march — a comment (`:3161-3164`) explains this was
added because bots previously "saw and fired through hills." bot-viewer-v2's LOS confirm in target
selection is a flat `mapCollider.raycast(...)` (`:6529`) with no tree/terrain march, appropriate for its
wall-only maze harness.

**Missing capability — no baked-field LOS prefilter in environment-viewer-v2's target selection.**
`bot-viewer-v2.html:6449` gates candidate collection with
`if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(...)) continue;` (flag `USE_FIELD_LOS_PREFILTER = true`
at `:6672`) before paying for the expensive raycast, used at 3 call sites (target selection `:6449`, pack
visibility `:5610`, secondary-threat `:9541`). environment-viewer-v2's equivalent loop (`:3929-3935`) has
no such check anywhere — grepped `USE_FIELD_LOS_PREFILTER`/`fieldSaysHidden` across the whole file: zero
matches. Every FOV/range-passing candidate falls straight through to the full raycast.

**Missing occlusion check — `secondVisibleThreat` (H6b secondary-shooter cover veto) has none in
environment-viewer-v2.** `bot-viewer-v2.html:9527-9549` requires a candidate to pass
`!fieldSaysHidden(...)` — its only occlusion test — to count as a secondary threat that can veto a cover
corner. environment-viewer-v2's version (`:5561-5584`) checks only range + FOV cone, no occlusion test at
all. **Behavioral consequence:** environment-viewer-v2 can reject a cover corner because of an enemy that
is actually behind a wall/terrain and not really visible, where bot-viewer-v2 would correctly exclude that
enemy from the veto.

**Alert propagation / escalation — identical, one extra off-switch.** Import lists match exactly
(re-verified by the compiling agent at `environment-viewer-v2.html:114-122` vs
`bot-viewer-v2.html:6638-6646`). Call sites for `alertEscalation`/tier ladder are structurally identical:
`bot-viewer-v2.html:10452-10478` vs `environment-viewer-v2.html:6272-6296`, same thresholds
(`ALERT_PUSH_SCORE`/`ALERT_DEFENSIVE_SCORE`/`SEMI_ALERT_WARY_MS`). environment-viewer-v2 additionally
gates the push tier behind `BOT_PUSH_TIER_ENABLED = true` (`:3625`, used at `:6281`) — bot-viewer-v2 has
no such flag (push is unconditional on the score/support-count thresholds). Both currently resolve to the
same effective behavior since the flag defaults on.

**Split attention — identical.** `faceThreatAndAhead`'s `stepAttention`/`attentionSweep` logic is
line-for-line identical: `bot-viewer-v2.html:9644-9654` vs `environment-viewer-v2.html:5694-5703` (only a
`now`→`nowMs` naming difference), with matching per-bot phase seeding
(`sweepPhaseMs(botSeedFromId(...))`), and matching caller sites across the state machine (9 states in
each: fire/aim, pursue, medic, cover-hold, cover-move, patrol-fallback —
`bot-viewer-v2.html:10744-10811` vs `environment-viewer-v2.html:6511-6568`).

**Contact / sighting memory — present in both, minor drift on cleanup.** (The investigation's initial
premise — based on an import-list snapshot taken earlier in this session — was that `bot-contacts.js` was
entirely unimported by environment-viewer-v2. That premise is **stale/incorrect**: as of this
investigation's actual reads, `environment-viewer-v2.html:79` imports
`createContactMemory, recordContactSighting, markContactsUnseen` from `./bot-contacts.js` — note, not
`contactRecency`.) Wiring matches: `environment-viewer-v2.html:3949-3956` mirrors
`bot-viewer-v2.html:6480-6488` almost line for line, both inside `selectBotTarget`. Both files' own inline
comments describe contact memory as write-only infrastructure not yet consumed by any behavior
(`environment-viewer-v2.html:3945-3948`, `bot-viewer-v2.html:6474-6478`) — consistent with `contactRecency`
being imported by bot-viewer-v2 (`:6648`) but never actually called anywhere in that file either (grepped,
zero hits). **Real, if minor, difference:** `bot-viewer-v2.html`'s `resetActorMapState` clears
`actor.contacts` on a live map/maze rebuild (`:7398`: `if (actor.contacts) actor.contacts.clear()`);
environment-viewer-v2 has no equivalent function at all (grepped `resetActorMapState`, zero hits) — stale
contact entries are never explicitly cleared on a nav-grid rebake there. Low-impact today since contact
memory is unconsumed and stores raw world x/z rather than cell indices (so a rebake wouldn't invalidate
it), but relevant if contact memory is ever wired into live behavior.

**Target selection & attribution — core scoring identical, three real gaps.** The proximity×danger scoring
model (`TARGET_DANGER_SELF_BONUS`/`TARGET_DANGER_ALLY_BONUS`/`TARGET_PILE_ON_STEP`/`TARGET_PILE_ON_FLOOR`,
risk-sort, first-clear-LOS-wins pick) matches almost verbatim:
`bot-viewer-v2.html:6490-6522` vs `environment-viewer-v2.html:3957-3983`. Stickiness/commit-dwell
(`TARGET_STICK_RISK_MARGIN`, `TARGET_COMMIT_MIN_MS = 1500`) matches (`:6410`/`:3893`). Constants match:
`TARGET_SCAN_STRIDE = 4` (`:6405`/`:3648`), `TARGET_RETAIN_MAX_MS = 6000` (`:6689`/`:3647`). The three gaps
(field LOS prefilter, secondVisibleThreat occlusion check) are covered above; the third is:
**`perceivedEnemies`/`PERCEIVED_ENEMY_MAX` snapshot missing from environment-viewer-v2.**
`bot-viewer-v2.html:4758` (`PERCEIVED_ENEMY_MAX = 8`) and `:6463-6472` maintain a nearest-first
in-cone-candidate snapshot per actor, documented as feeding the POV HUD and as prospective future
contact-memory input. Grepped `perceivedEnemies|PERCEIVED_ENEMY_MAX` across environment-viewer-v2.html:
zero matches. INFERRED (not confirmed by any comment or commit) that this is a deliberate scope cut
because environment-viewer-v2 has no equivalent debug POV HUD, rather than an unported piece.

**Feature-flag / default differences, consolidated:** `USE_FIELD_LOS_PREFILTER = true`
(bot-viewer-v2-only, `:6672`) — capability entirely missing on the other side, not a default difference.
`BOT_PUSH_TIER_ENABLED = true` (environment-viewer-v2-only, `:3625`) — extra off-switch, currently
behavior-neutral. `EYE_LIFT = 0.85` has no counterpart constant in environment-viewer-v2 (replaced by the
two different formulas above).

### 3. Combat — aim, fire gating, reload/sidearm, disengage, grenades, melee, stance

*Researched by a delegated sub-agent; citations below are as returned by that agent.*

**Aim/spread core — shared, with one environment-viewer-v2-only widening term.** `reactionDelayMs`,
`spreadHalfAngleRad`, `bloomAfterShot`, `decayBloomDeg`, `dispersedDirection` are called identically for
aim acquisition (`bot-viewer-v2.html:10160-10217` vs `environment-viewer-v2.html:5718-5769`,
`AIM_PRIMED_WINDOW_MS`/`AIM_UNDER_FIRE_MS = 4000` match in both). **Divergence:**
`environment-viewer-v2.html:5765-5768` adds:
```
const inaccuracy01 = 1 - Math.min(100, Math.max(0, botAccuracy)) / 100;
return (spreadHalfAngleRad(_spreadIn, botAimSettings) + inaccuracy01 * BOT_MAX_SPREAD_RAD) * stanceSpreadScale(...)
```
`botAccuracy` (default 60, slider 0-100, `:2174`) and `BOT_MAX_SPREAD_RAD = 0.15` (`:2193`) have zero
matches in bot-viewer-v2.html (grepped). At the default 60% slider this widens every
environment-viewer-v2 bot's shot cone by ≈0.06 rad (≈3.4°) beyond what bot-aim.js alone would produce —
bot-viewer-v2 bots have no equivalent floor/widening term, so they are more accurate than
environment-viewer-v2 bots at matched nominal settings unless `botAccuracy` is manually raised to 100.

**Fire gating — structurally identical.** Core gate:
`visible && botAimReady(now) && botReloadUntil==null && !swapping && ammo.mag>0 && (now - lastShotAt >= fireIntervalMs)`
— `bot-viewer-v2.html:10413-10414` vs `environment-viewer-v2.html:6244-6246` (clause order differs
cosmetically). Minor defensive difference: environment-viewer-v2 falls back
`currentBotWeapon()?.fireIntervalMs ?? 340` (`:6246`); bot-viewer-v2 assumes resolution always succeeds
(`:10414`) — not expected to matter under normal play.

**Reload / sidearm swap — two real divergences.** No local redeclaration of `SIDEARM_DRAW_MS`/
`SIDEARM_LULL_MS` in either file (both use the shared constants unmodified — checked and confirmed by
both the sub-agent and the compiling agent).
1. **`inGunfight` computation differs.** `bot-viewer-v2.html:10404-10406`:
   `visible || contactAgeMs < SIDEARM_LULL_MS || now - lastSelfThreatAt < SIDEARM_LULL_MS`, where
   `contactAgeMs = now - lastKnownTargetAt` (the bot's *own* last-known-target recency).
   `environment-viewer-v2.html:6579-6580`:
   `visible || nowMs - lastSelfThreatAt < SIDEARM_LULL_MS || (!!report && nowMs - report.at < SIDEARM_LULL_MS)`
   — substitutes an ally-alert/firsthand-hit `report` record for the bot's own target recency, even though
   `lastKnownTargetAt` is available earlier in the same frame (`:6285`/`:6334`/`:6343`, all before
   `:6579`). **Effect:** in bot-viewer-v2, a bot that personally loses its own target still counts as "in
   a gunfight" (won't retreat to primary) for `SIDEARM_LULL_MS` even absent any ally report; in
   environment-viewer-v2 that same bot does not, so it returns to its primary/reloads sooner after
   breaking personal contact.
2. **Missing same-frame swap-then-fire call site.** bot-viewer-v2.html calls
   `updateBotWeaponSlot(now, inGunfight, targetDistance)` **twice** per frame: once at `:10407` (before
   the `readyToFire` gate at `:10413`, so a bot whose mag just hit 0 can swap-and-fire the sidearm the
   *same* frame) and again at `:10831`, with an explicit bug-fix comment (`:10828-10830`): "the shot that
   emptied the mag swaps the pistol in now, instead of starting a reload the next frame would immediately
   cancel... skipping it was the other half of the deadlock." environment-viewer-v2.html has **only one**
   call site (`:6581`, positioned like bot-viewer-v2's *second* call). Grepped `updateBotWeaponSlot\(` in
   environment-viewer-v2.html: single match. INFERRED that practical impact is small (the 550 ms
   `SIDEARM_DRAW_MS` swap timer likely dominates a 1-frame lag) — not measured/profiled — but this is a
   genuine structural gap from a pattern the harness explicitly fixed a deadlock bug with.

**Disengage.** The `chooseBotStateName` context construction matches near line-for-line (see FSM section
above; same file). The manual-order gap (`orderOverride`/`commandBreakContact`) is the disengage-relevant
finding and is detailed in section 1 — repeated here because it's squarely a combat-disengage capability:
environment-viewer-v2 bots can never be manually commanded to break contact and fall back to patrol; only
the FSM's own automatic flee/pursue-exit logic (which *is* shared and identical) governs disengagement
there.

**Grenade / rocket throw and evade — two real gaps.** `chooseGrenadeThrow` call sites are largely
equivalent (cooldowns, team cooldown, blind-throw staleness, range pre-gate):
`bot-viewer-v2.html:9079-9120` vs `environment-viewer-v2.html:5955-5993`.
1. **Self pre-gate is not occlusion-aware in environment-viewer-v2.** `bot-viewer-v2.html:9095-9096`
   gates the cheap self-proximity pre-check through `blastReachesBody(...)`, with a comment explaining
   that without it, the pre-gate "would veto every short throw before the real gate ever saw it, silently
   undoing the corner-cook the self veto now allows." environment-viewer-v2.html:5968 has a bare distance
   check with no occlusion test: `if (roughDist + slack <= blastR * botGrenadeSettings.selfRadiusScale) return null;`.
   **Effect:** environment-viewer-v2 bots can never throw a grenade short from behind their own cover
   ("cooking around a corner") — the pre-gate rejects it before the real, occlusion-aware self-veto
   (which environment-viewer-v2 *does* pass `blastReaches: blastReachesBody` to, at `:5992`) ever runs.
   bot-viewer-v2 allows this throw.
2. **`grenadeEvade` hysteresis missing.** `bot-viewer-v2.html:9291` passes a 4th `engagedId` argument
   (`actor.grenadeEvadeId`) that bot-grenade.js uses to widen the exit ring to
   `blastRadius * evadeExitScale` (1.25×) once a bot is already evading a specific grenade
   (bot-grenade.js:132-134/144-145), preventing flicker at the boundary.
   `environment-viewer-v2.html:6076` omits the 4th argument entirely, and there is no
   `grenadeEvadeId`/equivalent field anywhere in the file (grepped, zero matches).
   **Effect:** environment-viewer-v2 bots exit evade mode exactly at the raw blast-radius boundary,
   without the buffer bot-grenade.js was built to provide, so evade state can flicker on/off near the
   boundary. Grenade stock (`throwCountFor(...) + role.bonusGrenades`) is identical in both
   (`bot-viewer-v2.html:7793/13874`, `environment-viewer-v2.html:2847/6984`).

**Melee / knife — reachable in both, but a different hit-resolution mechanism.** `BOT_KNIFE` is imported
and dispatched in both (`environment-viewer-v2.html:104`/`6532-6535` vs
`bot-viewer-v2.html:10753-10756`; the compiling agent independently confirmed `BOT_KNIFE` is wired
end-to-end in both files, including the `botKnifeSecondaryEnabled` default-true gate that exists
identically in both — `bot-viewer-v2.html:1479` / `environment-viewer-v2.html:3600`, both defaulting to
`true`, with matching UI toggles).
1. **Tuning divergence:** `KNIFE_COMMIT_MAX_MS` = 8000 (`bot-viewer-v2.html:6686`) vs 12000
   (`environment-viewer-v2.html:3649`); `KNIFE_COMMIT_COOLDOWN_MS` = 5000 (`:6687`) vs 6000 (`:3650`).
   Both are plain local consts, not shared-module values — environment-viewer-v2 bots can commit to a
   knife charge 50% longer before the FSM forcibly abandons it, and wait 20% longer before re-committing.
2. **Hit resolution architecture differs.** `bot-viewer-v2.html:10902-10911`'s `fireBotKnife` directly
   calls `applyCombatDamage(...)` on `botTarget` whenever `targetDistance <= knife.range` and the
   `now - lastKnifeAt < knife.fireIntervalMs` cooldown has elapsed — a guaranteed hit gated on distance
   only, no raycast/facing check. `environment-viewer-v2.html:5298-5318`'s `fireBotKnife` instead routes
   through `applyCombatIntent({ action: 'gun.fire', weapon: 'knife', ... })`, whose comment states that
   `combat.js`'s melee branch "skips the magazine, resolves the 2 m ray along the bot's current facing...
   validateShot's cadence gate is the knife's own 1500 ms fireIntervalMs." This is a genuinely different
   mechanic — facing-dependent raycast swing vs. guaranteed distance-only hit. INFERRED, not measured:
   whether `validateShot`'s internal cadence gate actually enforces 1500 ms was read from a comment, not
   from `combat.js`'s `validateShot` body directly (out of scope for the sub-agent's pass).

**Stance system — RUN/DASH still function; only the manual-override UI is missing.** Resolved
definitively: `chooseBotStance`/`stepStanceTransition`/`stanceSpeedFactor`/`stanceSpreadScale`/
`stanceTurnRateScale` all compare against bot-stance.js's own internal `STANCE_RUN`/`STANCE_DASH` string
constants, so a caller never needs to import those names to receive or use the returned value.
`environment-viewer-v2.html:6496` sets `sc.evading = rec.evadingUntil > nowMs` (→ DASH per
bot-stance.js:82), and its own comment at `:6477` confirms this was understood at port time: "The
grenade-evade dash rides sc.evading below; there is still no UI force-override." What's actually missing
(both tied to the same missing command-wheel infrastructure as `orderOverride` above, confirmed by the
compiling agent independently by grepping `STANCE_RUN`/`STANCE_DASH`/`resolveStanceOverride` in
bot-viewer-v2.html):
1. **Manual stance-force UI.** `bot-viewer-v2.html:10714`:
   `activeBotActor.stance = resolveStanceOverride(botStanceOverride, autoStance);`, backed by a
   `BOT_STANCE_OVERRIDES` dropdown (`:1085`: `['auto', STANCE_STAND, STANCE_CROUCH, STANCE_PRONE, STANCE_RUN, STANCE_DASH]`).
   environment-viewer-v2.html:6502 assigns `rec.stance` directly from `stepStanceTransition(...)` with no
   override step, and `resolveStanceOverride` is never called anywhere in the file (grepped, zero
   matches, confirmed independently by the compiling agent) — no debug/manual stance-forcing UI exists.
2. **`doubleTime` command-forced RUN while patrolling.** `bot-viewer-v2.html:10708-10709`:
   `sc.doubleTime = commandDoubleTime && !!commandGoal && (...)`, feeding bot-stance.js's
   `if (state === 'patrol' && doubleTime) return STANCE_RUN` rung (bot-stance.js:104).
   `environment-viewer-v2.html`'s stance-ctx block (`:6483-6503`) never sets `sc.doubleTime` — this rung
   is unreachable there, consistent with the missing manual-command infrastructure noted throughout.

**`rayCapsuleHit` — not a real gap, indirect usage confirmed.** `rayCapsuleHit` (combat.js:29) is used
internally by `resolveHitscan` (combat.js:189/250), which both files import identically, so ordinary
bullet hitscan is unaffected. bot-viewer-v2's direct import is used only for its bespoke bot-only swept
projectile collision, `projectileRaycast` (`:11405-11430`), feeding `createProjectileManager` (which
environment-viewer-v2 does not import at all). environment-viewer-v2's replacement,
`CombatProjectileEntity.update` (entity-types/combat-projectile.js:96-97), calls an injected
`ctx.raycast(...)` wired to its own `projectileRaycast` (`:14025-14033`/`14501`), which delegates to
`resolveWorldShot(...)` — a unified world-shot resolver used by both bullets and projectiles, itself built
on `resolveHitscan`/`rayCapsuleHit` internally. So capsule-vs-projectile collision math is exercised
identically under the hood; the difference is architectural (bot-viewer-v2's bespoke bot-only sweep vs.
environment-viewer-v2's single unified world-shot path that also covers creatures/mobs). INFERRED, not
fully traced: whether `resolveWorldShot`'s capsule math is byte-for-byte identical to
`projectileRaycast`'s in every edge case (occlusion order, mob hits) was not verified line-by-line.

### 4. Roles / squads / medic / health packs / scoring

*Researched directly by the compiling agent.*

**Role catalogue and assignment — identical.** `bot-roles.js` (155 lines) defines five roles
(`ROLE_RIFLEMAN`/`ROLE_MEDIC`/`ROLE_SQUAD_LEADER`/`ROLE_SNIPER`/`ROLE_TECHNICAL`, lines 13-18) with
descriptor fields including `sightScale`, `closeRange`, `swapOnDryMag`, `bonusGrenades`, `leadership`,
`support` (lines 46-82). Both files import the same names from `bot-roles.js`
(`bot-viewer-v2.html:918-919` vs `environment-viewer-v2.html:137`/nearby). Effect-application call sites
match: `sightScale` — `bot-viewer-v2.html:1743` (`botBehaviorSettings.sightDistance * getRole(actor?.role).sightScale`)
vs `environment-viewer-v2.html:3747` (`botSightRange * getRole(rec?.role).sightScale`, function
`botSightDistanceFor`); `closeRange`/`swapOnDryMag` — `bot-viewer-v2.html:1814/1818/1832` vs
`environment-viewer-v2.html:3801/3803/3818`, both writing `_slotCtx.closeRange`/`_slotCtx.swapOnDryMag`
from the role descriptor identically. `assignRolesToBatch` call sites: `bot-viewer-v2.html:2450-2452` vs
`environment-viewer-v2.html:2760`/`2968`, both driven by a `{ medicPercent, mix }` options object built
from UI sliders (`botMedicPercent`/`botSniperPercent`/`botTechnicalPercent` in
environment-viewer-v2.html:3602-3603, both defaulting appropriately — sniper/technical default 0%,
comment at `:3603`: "RPG has no ballistic lead (harness parity): default off"). bot-viewer-v2's equivalent
UI (`createRoleMixRow`, `:12797-12808`) drives the same `botRoleMix` map. **No behavioral drift found in
role assignment.**

**Squad formations — shared, one debug-only gap.** `bot-squad.js` (267 lines) is imported with a nearly
identical name list in both: bot-viewer-v2.html:920-922 additionally imports `squadSlotWorld` (which
environment-viewer-v2 does not — `environment-viewer-v2.html:151-154`), while both import
`SQUAD_MERGE_RADIUS` (confirmed present in *both* files after a direct re-read —
`environment-viewer-v2.html:151`: `import { SQUAD_MAX_SIZE, SQUAD_MIN_SIZE, SQUAD_DEFAULTS, SQUAD_MERGE_RADIUS, FORMATION_KINDS, ...`
— an earlier working assumption in this investigation that `SQUAD_MERGE_RADIUS` was missing from
environment-viewer-v2 was **incorrect and is corrected here**). Both files construct
`botSquadSettings = { ...SQUAD_DEFAULTS, slotRepath: 1.0, corridorProbeMs: 300, mergeRadius: SQUAD_MERGE_RADIUS }`
identically (`bot-viewer-v2.html:1040`, `environment-viewer-v2.html:2160`). `squadMemberGoal` (imported by
both) internally calls `squadSlotWorld` itself (bot-squad.js:251-259), so formation *movement* is
unaffected by the missing direct import. The only confirmed use of a *direct* `squadSlotWorld(...)` call
is in bot-viewer-v2's squad debug overlay (`:7072-7079`, inside `createSquadDebug`, drawing formation slot
markers and tethers for the debug panel). environment-viewer-v2 has no such overlay at all (grepped
`createSquadDebug`/`squadDebug`, zero matches). **Verdict: `squadSlotWorld`'s absence is a missing
debug-visualization feature, not a behavioral gap** — squad formation walking is identical in both.

**Medic behavior — core decision logic shared; two real drifts.** `bot-medic.js` (149 lines) is pure
decision math: `decideMedicAction` (lines 108-120) picks revive-over-heal, gated by `hasKit`/`hasCharge`,
returning `MEDIC_TEND` when within `tendRadius`/`medicTendRadiusFor(fleeing)` else `MEDIC_MOVE`. Both
files import and call `decideMedicAction`/`MEDIC_MOVE`/`MEDIC_TEND`/`cohesionTarget`/
`medicChaseSpeedFactor`/`medicTendRadiusFor` identically (`bot-viewer-v2.html:923-924`,
`environment-viewer-v2.html:136-137`).
1. **Missing "creep to contact" final approach.** `bot-viewer-v2.html` additionally imports
   `MEDIC_CONTACT_RADIUS` (0.85 m) and `MEDIC_CONTACT_CREEP` (0.45× move speed) from bot-medic.js (lines
   46-47), used by a dedicated function `creepToContact` (`bot-viewer-v2.html:9928-9934`): once
   `MEDIC_TEND` latches (at the looser `tendRadius` of 1.7 m or 2.6 m fleeing), the medic keeps closing
   the last stride toward the patient until within 0.85 m, at 0.45× move speed — comment: "without this
   the medic stops up to 1.7 m short and treats an ally at arm's length plus a metre."
   `environment-viewer-v2.html` does **not** import `MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP`
   (confirmed absent from its bot-medic.js import at `:136-137`, and zero matches for either constant
   anywhere in the file). Its `updateMedicTend` (`:4554-4581`) sets `bot.velocity.x/z = 0` immediately at
   entry (`:4555`) and never creeps closer — **confirmed by reading the function body directly**. So an
   environment-viewer-v2 medic latches TEND and stops wherever it is (up to ~1.7 m / 2.6 m from the
   patient) rather than closing to arm's-reach contact distance, a visible behavioral gap (medic appears
   to "treat from a distance").
2. **`teamCentroid` reimplemented inline rather than imported.** `bot-medic.js:123-127` exports
   `teamCentroid` (plain XZ centroid of a point list); `bot-viewer-v2.html:8860` calls it directly inside
   `findFleeGoal` ("S9: the local squad's XZ centroid", `:8834-8861`) to bias flee-goal scoring toward
   staying near the local squad. `environment-viewer-v2.html` does not import `teamCentroid` — but its own
   `findFleeGoal` (`:5385-5437`) computes the same thing via a locally-defined `fleeSquadCentroid`
   function (`:5438-5452`), which is algebraically identical (accumulate x/z over same-team neighbors
   within `FLEE_SQUAD_RADIUS`, divide by count) and is called at the equivalent point (`:5399`). **Verdict:
   this is duplicated code, not a missing feature** — the math and behavior match, just not via the
   shared function.

**Health packs — core math shared; one cosmetic-only gap.** `bot-health-packs.js` (99 lines) is
imported nearly identically by both (`bot-viewer-v2.html:917`, `environment-viewer-v2.html:138-139`), the
only difference being `packsTotalHp` (line 14 of bot-health-packs.js: sums `packHp` across a pack array).
bot-viewer-v2 imports and uses it exactly once, at `:15581`, to render a HUD string
`` `(${Math.round(packsTotalHp(packs))}hp)` ``. environment-viewer-v2 doesn't import or use it anywhere.
**Verdict: purely a debug/HUD label, zero behavioral effect** — `drawFromPacks`, `hasHealResource`,
`canHold`, `addPack`, `hasReviveMaterials`, `consumeRevivePacks`, `packClaimIntent`, `packRunSafe` (the
functions that actually drive pickup/heal/revive/pack-run-safety decisions) are imported and used
identically in both files.

**Scoring / round system — entirely absent from environment-viewer-v2.** `bot-score.js` (191 lines) is a
per-team session tally: spawns, deaths, revives, frags, kill attribution by weapon/cause/role, and a round
history (`createScoreboard`, `recordSpawn`, `recordKill`, `recordRevive`, `finishRound`,
`decideRoundOutcome`, header comment lines 1-5). `bot-viewer-v2.html:925-926` imports the full API.
`environment-viewer-v2.html` imports **none of it** — confirmed by grepping the full import list (no
`bot-score.js` reference anywhere) and by grepping `recordKill`, `recordSpawn`, `recordRevive`,
`teamStats`, `winner`, `killCount`, `deathCount` across the whole file: **zero matches for all seven
terms**. There is a `botSpawnMode = 'manual' | 'round'` toggle (`environment-viewer-v2.html:2148`) but
this governs spawn *cadence*, not a win/score tally — it has no relationship to bot-score.js. **Verdict:
bots in environment-viewer-v2 fight with no scoreboard, no kill/death tally, and no round-outcome
logic at all** — this is entirely a bot-viewer-v2-only feature.

**Home base / team-region generation — intentionally substituted, not missing.** `bot-structures.js`
(329 lines) is a pure map-content generator; its `teamSideRegions`/`generateHomeBase`/`HOME_BASE_DEFAULTS`
are imported only by `bot-viewer-v2.html:7267`, feeding its procedurally-generated maze/arena maps.
environment-viewer-v2.html does not import bot-structures.js, but has a direct, documented substitute:
`teamSpawnPoints` (`:2647-2664`), whose comment explicitly names the harness function it replaces:
"Authored spawn points split into two halves along the map's long axis, one per team -- the side model
bot-structures.js's teamSideRegions bakes in the harness, derived here from whatever spawn points the map
actually authored (works for shoot-house and pcw-layout maps alike)." **Verdict: architectural
substitution appropriate to environment-viewer-v2's authored-map model (vs. bot-viewer-v2's procedurally
generated maze), not an unported feature.**

### 5. Navigation — nav grid, pathfinding, cover/corner maps, danger field, terrain source

*Researched directly by the compiling agent.*

**Nav-grid build & region connectivity — identical core, environment-viewer-v2 has an added incremental
path.** `nav-grid.js` (620 lines) defines `buildNavGrid(walkableTest, bounds, cellSize, opts)` (lines
20-45), which samples the grid and then **calls `finalizeNavGrid` internally** at line 44
(`return finalizeNavGrid(grid, { connectRegions: doConnect, minConnectRegion, slopeCost });`).
`finalizeNavGrid` (lines 51-58) does region labeling (`labelRegions`) and, if `connectRegions` (default
`true`) and a `soft`-blocked-cell array exist, stranded-region reconnection
(`connectStrandedRegions`/`minConnectRegion`, default 6). The module's own header comment (lines 47-50)
explicitly names environment-viewer-v2 as the reason the split exists: "the split exists so a bake too
large to run inside one frame can sample incrementally and finalize once (environment-viewer-v2's terrain
combat-zone grid does exactly that)." So `bot-viewer-v2.html`'s single `buildNavGrid` call
(`:7491-7492`, no options overriding `connectRegions`/`minConnectRegion`, so both defaults apply) gets
identical connectivity handling to `environment-viewer-v2.html`'s two `buildNavGrid` calls
(`:2320`, shoot-house branch, also default options; `:3323`, local terrain window,
`{ heightAt: terrainHeight }` only) — **plus** a third path, `finalizeNavGrid` called directly
(`:2503-2506`) at the end of `finishBotZoneBake` (`:2501-2534`), which finalizes a grid whose
`cells`/`heights`/`soft` arrays were filled in incrementally across multiple frames by `stepBotZoneBake`
(`:2479-2500`, budgeted at `BOT_ZONE_BAKE_BUDGET_MS = 3` ms/frame, `:2353`). **Verdict: no connectivity gap
— environment-viewer-v2 has an additional, budgeted bake path for its much larger open-terrain maps that
bot-viewer-v2's single-shot maze bake doesn't need.**

**Pathfinding (A*) & smoothing — identical.** `findPath` (nav-grid.js:389-442) is deterministic 8-connected
A* with no-corner-cutting and slope-costed edges; `smoothPath` (nav-grid.js:580-593) greedily string-pulls
with a slope-aware `chordClimb` veto. Both files call these through the same shared functions (aliased
`botFindPath`/`botSmoothPath` in environment-viewer-v2.html per its import block, plain names in
bot-viewer-v2.html). environment-viewer-v2 layers a documented fallback the compiling agent found at
`:3298-3313`: if the true goal is unreachable, it retries against the nearest walkable cell instead of
ever beelining through unwalkable ground, citing a prior bug ("Squad member terrain-trap"). This is an
environment-viewer-v2-specific robustness addition for open terrain (steep slopes/water), not present as
a named function in bot-viewer-v2's maze context (where unreachable goals are rarer by construction) —
noted as an addition, not checked for a bot-viewer-v2 equivalent beyond the region-connectivity gate both
share.

**Flood-fill — identical usage pattern.** `floodFill`/`floodPath` (nav-grid.js:479-545) back the flee-goal
candidate search in both files at structurally matching call sites (`findFleeGoal` in both — see Roles
section above for the squad-centroid-related part of that function).

**Cover / corner selection — shared, one terrain-scale-driven addition in environment-viewer-v2.**
`pickCoverCorner` call sites match: `bot-viewer-v2.html:9516` vs `environment-viewer-v2.html:5555`, same
argument shape (`{ corners, field, navGrid, searchRadius: COVER_SEARCH_RADIUS, skip }`). `buildCornerMap`
is called with matching crest-cover parameters in the maze/shoot-house cases: bot-viewer-v2.html:7508-7514
uses `{ heights, crest: { minRise: 0.6, maxSpan: round(2*perM), farCells: round(12*perM), spacingCells: round(4*perM), stride } }`;
environment-viewer-v2.html's shoot-house branch (`:2332`-`2333`) calls `buildCornerMap` with no crest
override at all (flat maps, comment at `:2329-2330`: "No terrain args anywhere here... no ridge occlusion
to model and no crest cover to find"). environment-viewer-v2's *terrain*-zone bake (`:2517-2525`)
deliberately uses **different** crest constants — `minRise: 0.6` (same), but `maxSpan`/`farCells` derived
from `BOT_ZONE_CREST_SPAN_M = 4.5` / `BOT_ZONE_CREST_FAR_M = 24` (vs. the harness's 2 m / 12 m) — with an
explicit comment (`:2358-2364`) explaining the harness's values were authored for a 0.5 m grid inside a
~170 m arena, while the terrain zone runs a coarser 1.5 m pitch, and that `bench-bot-nav.mjs --crest`
measured **zero** crests found at 2 m/12 m on rugged synthetic terrain vs. ~100 at 4.5 m/24 m. **This is a
documented, deliberate, empirically-tuned divergence, not drift.** Separately: `COVER_ANCHOR_REACH` (0.45
m, bot-cover.js:75, "arriving: this close to the seat counts as seated") is imported only by
environment-viewer-v2 (`:128`), used to derive `COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6`
(`:5656`), with a comment (`:5653`) explaining that on the terrain-zone grid's coarser cells, a chosen
seat center can land ~1.06 m from the true anchor — outside the 0.45 m reach band — so
environment-viewer-v2 needs an explicit final-approach correction that bot-viewer-v2's finer maze grid
doesn't require.

**Danger field — identical usage pattern.** `createDangerField`/`recordDanger`/`dangerPenalty` call sites
match one-for-one in structure and weight constants: death recording (own-corner + peek-cell, both files),
hit recording (`DANGER_HIT_WEIGHT`, both files), and penalty application to patrol/flee/pack-seek
candidate scoring (`DANGER_PATROL_SCALE`/`DANGER_FLEE_SCALE`/`DANGER_PACK_SCALE`, both files) — e.g.
`bot-viewer-v2.html:5309/5312-5313/5687/5631/8517/8882/9759` vs
`environment-viewer-v2.html:2576/3731/3741-3742/4046/4235/4404/5079/5420`.

**Terrain source feeding the nav grid — the single largest structural difference in the whole
comparison, and entirely intentional.** `bot-viewer-v2.html` builds its nav grid over a closed-form
maze/arena described by `bot-terrain.js` and simple wall/cover box lists (`activeWalls`, `activeCovers`),
baked once per layout in a single `buildNavGrid` call (`:7491-7517`, comment: "heightAt makes every search
slope-costed and gives the vis/corner bakes their height grid"). `environment-viewer-v2.html` instead
layers an entire additional subsystem on top of the shared `nav-grid.js`/`nav-visibility.js`/
`nav-corners.js` primitives, described in its own block comment (`:2338-2376`, "Phase D: open-terrain
combat-zone nav"): terrain maps run 1200-4000 m across, a full-map bake is 640k+ cells and a pairwise
visibility field is O(walkable²) (140 MB at 384 m, 13 GB at 1200 m per its own `bench-bot-nav.mjs`
citation), so it maintains a **persistent, player-anchored 384 m × 384 m zone grid**
(`BOT_ZONE_SPAN = 384`, `:2350`) at the same 1.5 m pitch as its local windows, rebaked when the anchor
drifts more than `BOT_ZONE_REBAKE_DRIFT = 96` m (`:2352`), sampled incrementally at a 3 ms/frame budget
(`:2353`), with its own sight-blocker derivation from streamed dressing/tree-trunk spatial indices
(`botTerrainSightRects`/`botTerrainOccluders`, `:2406-2456`) rather than static wall/cover lists. Bots
outside the zone fall back to a throwaway local A* window (`buildLocalNavWindow`, `:3318-3324`,
`heightAt: terrainHeight` only, no persistent grid). **This means the two harnesses' navigation systems,
while sharing identical low-level primitives (A*, flood-fill, region labeling, cover-corner picking,
danger-field scoring), operate over fundamentally different ground-truth data**: a small closed-form maze
baked once vs. a large procedural/open terrain baked incrementally and re-anchored to the player at
runtime. Every behavioral tuning constant downstream of this (crest thresholds, cover final-approach
correction, per-call `heightAt`/`softBlockedTest` wiring) traces back to this one structural choice, and
each downstream divergence found above is explicitly commented as a deliberate consequence of it, not an
accidental drift.

---

## Ranked list of the most significant parity gaps

1. **Manual squad-order / command-wheel system is entirely absent from environment-viewer-v2.** This one
   root cause explains three separate findings above: `orderOverride`/`commandBreakContact` (disengage on
   manual order, section 1/3), `commandDoubleTime` (forced RUN while patrolling, section 3), and
   `resolveStanceOverride`/`BOT_STANCE_OVERRIDES` (manual stance-force UI, section 3). It was independently
   rediscovered by three separate investigation passes (the FSM sub-agent, the combat sub-agent, and the
   compiling agent's own stance check), which is strong convergent evidence it's real and not a
   misreading. **Why it matters:** in the shipped game viewer, there is currently no way to give bots a
   direct tactical order (fall back, double-time, hold a stance) — all bot behavior there is fully
   autonomous. If any game feature (player squad commands, a future "order your squad" mechanic) is
   planned, this entire code path needs to be ported, not just the FSM ladder it plugs into.

2. **No scoring / round-outcome system in environment-viewer-v2 (`bot-score.js` entirely unported).**
   Confirmed by a zero-match grep across seven different score/kill/round-related terms. **Why it
   matters:** any game mode built around round wins, team scores, or kill/death tracking for bots has no
   substrate to build on yet — this is a bigger lift than a tuning fix, it's a whole missing subsystem.

3. **Medics in environment-viewer-v2 stop up to ~1.7-2.6 m short of the ally they're tending, instead of
   closing to arm's-reach (0.85 m) as bot-viewer-v2 does.** Confirmed by reading `updateMedicTend`
   directly — it zeroes velocity immediately on entering `MEDIC_TEND` with no creep-to-contact step, and
   `MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP` are absent from its bot-medic.js import. **Why it
   matters:** this is a visible, easily-noticed animation/readability bug (medic appears to be healing
   from a conspicuous distance rather than laying hands on the patient), not just an internal tuning
   difference, and the fix is small (import two constants, add the equivalent of `creepToContact`).

4. **environment-viewer-v2's target-selection and cover-veto logic pay for full raycasts with no baked-field
   prefilter, and the secondary-threat cover veto (`secondVisibleThreat`) has no occlusion test at all.**
   The missing prefilter (`USE_FIELD_LOS_PREFILTER`/`fieldSaysHidden`) is primarily a performance
   concern at scale, but the missing occlusion test on `secondVisibleThreat` is a **behavioral** gap: an
   environment-viewer-v2 bot can be denied a good cover corner because of an enemy that's actually behind
   a wall and can't really see it, which bot-viewer-v2's version correctly ignores.

5. **The eye-height model is asymmetric in environment-viewer-v2 (self ≠ target) and doesn't match
   bot-viewer-v2's uniform 0.85 either way.** This directly affects LOS geometry at cover edges — the kind
   of place where "can this bot see me" mismatches are most visible to a player and hardest to debug
   without knowing the two constants differ.

6. **Grenade behavior has two real gaps: no occlusion-aware self-veto pre-gate (bots can never "cook" a
   short throw around their own cover) and no evade-exit hysteresis (evade state can flicker at the blast
   radius boundary).** Both are documented bug-fixes in the shared module's call-site comments in
   bot-viewer-v2 that simply weren't carried over to the newer call sites.

7. **The sidearm-swap "same-frame swap-then-fire" fix (`updateBotWeaponSlot` called twice) is missing from
   environment-viewer-v2**, which re-exposes a specific deadlock bot-viewer-v2's own commit history
   explicitly fixed (a bot whose mag empties starts a reload the very next frame that immediately gets
   cancelled by the sidearm swap). Likely low-frequency in practice, but it's a known-bad pattern
   recurring on one side only.

8. **Knife/melee is architecturally different, not just re-tuned**: bot-viewer-v2 resolves a knife hit as
   guaranteed-if-in-range; environment-viewer-v2 resolves it as a facing-dependent raycast swing through
   `combat.js`'s generic melee intent path. This is likely an intentional consequence of
   environment-viewer-v2 needing one unified combat-intent pipeline for players *and* bots (unlike
   bot-viewer-v2, which has no player entity), but it means knife behavior will feel different in the two
   harnesses (e.g. environment-viewer-v2 bots can plausibly whiff a "point blank" knife swing if not
   facing the target; bot-viewer-v2 bots cannot).

9. **bot-viewer-v2 has no full-decision-pass think-cadence throttle counterpart failure — actually the
   reverse: environment-viewer-v2 lacks the roster-size-scaled throttle bot-viewer-v2 uses for 40+/80+
   bots**, running every bot's full FSM every frame regardless of count. Likely a performance concern
   rather than a behavioral-fidelity one at typical bot counts, but worth flagging before scaling up
   default bot counts in the shipped game.

10. **Two lower-stakes but easy-to-miss FSM-ladder differences**: forced crouch during self-heal excludes
    medics only in environment-viewer-v2 (a visual/tactical inconsistency — every other role kneels to
    self-heal, medics don't), and the `holding` (commanded-hold) predicate uses a non-equivalent
    allow-list vs. deny-list between the two files, which can produce different hold behavior specifically
    in `BOT_COVER_MOVE` and the `'alert'` pseudo-state.

**Noteworthy but not a "gap" in environment-viewer-v2's favor:** bot-viewer-v2 — the harness explicitly
documented as authoritative — has **no stuck-detection/forced-replan system at all**, while
environment-viewer-v2 has one (`trackStuck`, wired to path replanning and an escape/teleport fallback).
If bot-viewer-v2 is meant to be the reference implementation other systems get ported *from*, this is a
capability that should arguably be ported *backward* into it, or the "authoritative" framing for this
specific behavior should be revised.

**Noteworthy architecture, not a bug:** environment-viewer-v2's terrain-driven navigation (Phase D
persistent zone-bake, incremental `finalizeNavGrid`, terrain-scaled crest/cover constants) is a
substantially larger and more sophisticated system than bot-viewer-v2's single-shot maze bake, built to
handle 1200-4000 m open-world maps that the harness was never designed for. Every navigation-tuning
difference found in this report traces back to this one deliberate, well-documented architectural choice.

---

## Open questions / not verified

- Several claims are flagged INFERRED inline above (not re-stated here in full) — search this document
  for "INFERRED" to find them: `validateShot`'s exact knife cadence value, `resolveWorldShot`'s
  byte-for-byte capsule-math equivalence to `projectileRaycast`, the real-world performance impact of the
  1-frame `updateBotWeaponSlot` gap, and whether `perceivedEnemies`' absence is a deliberate scope cut.
- The FSM/goal-claims sub-agent verified call-site *presence* and *matching context* for goal-claims
  across ~30 sites but did not diff every one character-for-character.
- Not every one of bot-alert.js's ~26 imported names was traced to a call site in both files beyond the
  escalation/attention paths reported (e.g. `exposedToThreat`, `shotMissDistance`, `NEAR_MISS_*`,
  `latestNearMiss` cadence specifically) — no claim of parity or drift is made on those beyond "the import
  lists match."
- environment-viewer-v2.html was observed to have shifted line numbers during this investigation (it is
  the actively-developed file); all line citations are accurate as of the read that produced them but the
  file may have moved on since.
- No browser/runtime testing was performed on either harness — every finding here is static-code
  evidence (a function is called, a constant is/isn't imported, a code path exists/doesn't) rather than
  observed runtime behavior.
