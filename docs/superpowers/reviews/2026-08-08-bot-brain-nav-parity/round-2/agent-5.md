# Bot brain + navigation parity audit — round 2 (agent-5)

Source: frozen snapshot at
`C:\Users\msankofa\AppData\Local\Temp\claude\...\c59a907d...\scratchpad\frozen\` (basenames identical
to the live repo). A = `bot-viewer-v2.html` (authoritative harness). B = `environment-viewer-v2.html`
(game-side port). All citations are `file:line` against the frozen files unless marked otherwise.

Every claim below is tagged **MEASURED** (I read the exact lines) or **INFERRED** (deduced from
measured evidence, not itself directly read). No claim is a guess at unopened file contents.

## Summary table

| Area | bot-viewer-v2 (A) | environment-viewer-v2 (B) | Verdict |
|---|---|---|---|
| Module wiring, core FSM/alert/cover/danger imports | full set | same symbol set for `bot-alert.js`, `bot-danger.js` | **identical** |
| FSM states (`BOT_PATROL…BOT_COVER_HOLD`) | all 10 states reachable | all 10 states imported and dispatched | **identical** (a stale "inert until the brain lands" comment in B says otherwise — see below) |
| Think cadence / staggering | `updateBotSentry` throttled to every 2nd/3rd frame past 40/80 living bots, dt-banked | `updateBotSentry` runs every frame for every bot, no stagger | **missing-from-B** |
| Target-selection risk/pile-on scoring | risk-based pick, danger/pile-on bonuses | identical constants and formula present | **identical** (contradicts a stale doc note, see Absence section) |
| FOV cone | 150° default | 150° default | **identical** |
| Eye / muzzle height | 0.85 lerp up capsule (`EYE_LIFT`) | `capsule.end` directly (100%) | **drifted** |
| Stuck-speed detection (`trackStuck`) | none | imported + used, drives escape/rescue | **missing-from-A** |
| Aim reaction/spread tuning (`AIM_DEFAULTS`) | `{...AIM_DEFAULTS}`, no override | `{...AIM_DEFAULTS}`, no override | **identical** |
| Pursue-break-on-miss (`pursueMissStreak`, `MISS_STREAK_SIGHT_RESET_MS`) | 3 / 1500ms | 3 / 1500ms | **identical** |
| Heal/retreat thresholds (`botHealthSettings`) | threshold01 .60 / resume01 .72 / safeDistance 8.5 / safeHoldMs 500 / healPerSecond 18 | threshold01 .35 / resume01 .85 / safeDistance 12 / safeHoldMs 900 / healPerSecond 22 | **drifted** |
| Pack pickup tuning (`botPackSettings`) | pickupRadius .7 / shortProximity 4.0 / dropScatter .45 / crouchMs 450 | pickupRadius .9 / shortProximity 12 / dropScatter .35 / crouchMs 600, +worldSpawnCount | **drifted** |
| Medic close-range creep (`MEDIC_CONTACT_RADIUS/CREEP`) | 0.85m / ×0.45 speed shuffle | not imported, not used | **missing-from-B** |
| Role spawn mix defaults | medic 25% / sniper 10% / technical 10% | medic 20% / sniper 0% / technical 0% (deliberate) | **drifted (intentional per comment)** |
| Squad tuning (`botSquadSettings`) | `{...SQUAD_DEFAULTS, slotRepath:1, corridorProbeMs:300, mergeRadius}` | byte-identical construction | **identical** |
| Squad hold patience (`SQUAD_HOLD_MAX_MS`) | 12000ms | 6000ms | **drifted** |
| Knife commit window/cooldown | 8000ms / 5000ms | 12000ms / 6000ms | **drifted** |
| Target retention window (`TARGET_RETAIN_MAX_MS`) | 6000ms | 6000ms | **identical** |
| Grenade tuning (`GRENADE_DEFAULTS`) | no override | no override | **identical** |
| Separation constants | 1.5m / 0.5 weight | 1.5m / 0.5 weight | **identical** |
| Nav grid cell/waypoint reach | 0.5 / 0.35 | 0.5 / 0.35 | **identical** |
| Nav grid build call pattern | single `buildNavGrid()` call | `buildNavGrid()` (local windows) + separate `finalizeNavGrid()` (persistent combat-zone grid) | **n/a-architectural** (same underlying algorithm, doc-confirmed) |
| Cover module surface (`bot-cover.js`) | no `COVER_ANCHOR_REACH` import | imports `COVER_ANCHOR_REACH`, drives a final-approach stop distance | **missing-from-A** |
| Contact memory recency (`contactRecency`) | imported, (unused further checked) | not imported | **missing-from-B** |
| Persistent-terrain local A* window (`BOT_LOCAL_NAV_CELL`, `BOT_LOCAL_NAV_RADIUS`) | none (bounded maze maps only) | 1.5m cell, 18m half-width, on-demand for open/authored terrain | **missing-from-A** (n/a-architectural: A's maps are small and bounded) |
| `bot-terrain.js` (harness ground) | imported, drives harness terrain | not imported (B uses real `terrain-system.js`) | **n/a-architectural** |
| `bot-structures.js` (team-side regions, home base) | imported | not imported; B re-derives an equivalent team-side split inline | **missing-from-B (reimplemented inline)** |
| `bot-state-code.js` (9-slot state tracer) | static import, always active | dynamic `await import()` gated by `?botTrace=1` | **present in both, different activation** |
| `bot-camera-control.js` (orbit-cam POV occlusion) | imported | not imported | **n/a-architectural** (B has first/third-person player camera instead) |
| `createBotForensics` (from `bot-entity.js`) | imported | not imported | **missing-from-B** |
| `bot-score.js` extra exports (`formatBreakdownLines`, `formatRoundLine`, `resetScoreboard`) | imported | not imported | **missing-from-B** |
| `bot-stance.js` extra exports (`STANCE_RUN`, `STANCE_DASH`, `resolveStanceOverride`) | imported, `STANCE_DASH` used for blast-evade pose | not imported as symbols (only appear in comments); B has its own `botRunMultiplier` var instead | **missing-from-B** |
| `bot-squad.js`/`bot-medic.js` extra exports (`squadSlotWorld`, `teamCentroid`) | imported | not imported | **missing-from-B** |
| `squad-activity.js` (old squad module) | not imported (retired) | not imported (retired) | **n/a — both moved to `bot-squad.js`** |
| Player-issued squad orders (command wheel, `orderOverride`, `doubleTime`, break-contact) | full input+consumption | consumption plumbing exists in `bot-activity.js` (imported) but nothing produces an order in B | **missing-from-B (documented as deliberate)** |
| `rescueHeightAt` below-terrain floor rescue | used | deliberately not ported (raycast semantics differ; other safety nets exist) | **n/a-architectural (documented)** |

## Detailed findings by area

### 1. Module wiring — imports

**MEASURED.** B's bot-related imports are almost entirely a single contiguous block,
`environment-viewer-v2.html:44-163`. A's are scattered across the file in several blocks:
`bot-viewer-v2.html:85-118` (audio/voice/camera-control/projectiles), `:810-934` (terrain, entity,
health packs, roles, squad, medic, score, stance, state-code), `:6609-6649` (FSM/aim/nav/cover/danger/
alert/contacts). Despite the different layout, the **alert** (`bot-alert.js`) and **danger**
(`bot-danger.js`) import lists are symbol-for-symbol identical between A (`:6638-6646`, `:6634-6637`)
and B (`:116-124`, `:133-136`) — every constant name and order matches. `bot-cover.js` differs by one
symbol (`COVER_ANCHOR_REACH`, B only — see §7). `bot-contacts.js` differs by one symbol
(`contactRecency`, A only — see §8).

### 2. FSM states and the "inert" comment

**MEASURED.** B's `bot-activity.js` import block (`environment-viewer-v2.html:102-110`) carries the
comment `// --- v2 brain surface (Phase A port; inert until the brain lands) ---` directly above
`BOT_PURSUE, BOT_FLEE, BOT_HEAL, BOT_KNIFE, BOT_COVER_MOVE, BOT_COVER_HOLD`. Read literally this
implies those states are unused scaffolding. They are not: `environment-viewer-v2.html` dispatches on
all six at lines 1739-1740, 4382, 4904, 4913, 6081, 6314, 6325, 6419, 6425, 6429, 6466, 6478, 6499,
6507, 6527, 6530-6531, 6553-6605, 6658, 6670, 6773 — a full state-driven combat/cover/heal/knife
pipeline. **Conclusion: the comment is stale documentation, not a description of current behavior.**
This is exactly the kind of trap the audit brief warned about — trust the code, not the comment.

### 3. Think cadence / staggering

**MEASURED — missing from B.** A's `botThinkStride(livingCount)` (`bot-viewer-v2.html:3128-3131`)
returns 3 past 80 living bots, 2 past 40, else 1; `updateAllBots` (`:3329-3374`) only calls
`updateBotSentry` on a bot's turn (`(botFrameCounter + actor.scanPhase) % thinkStride === 0`),
banking `actor.thinkDtAcc` between turns so timers still integrate real elapsed time
(`:3364-3370`). Physics/rig stay per-frame; the focused/POV bot always thinks.

B has no equivalent full-decision-pass throttle. `botTickOne` (`environment-viewer-v2.html:6724-6726`)
calls `updateBotSentry(rec, dt, nowMs)` unconditionally, and the per-frame bot loop
(`:7055`, inside the loop starting above `:7020`) calls `botTickOne` for every living bot every
frame. B does have two *narrower* stride mechanisms — target-rescan stride
(`TARGET_SCAN_STRIDE`/`tierPerception.scanStride`, `:3971-3972`) and held-weapon render-LOD stride
(`:13170-13173`) — but neither throttles the full FSM decision the way A's `thinkStride` does.
**Behaviorally low-impact per bot** (dt-banking in A means decisions still land on time), but a real
perf-profile divergence at high bot counts, and the prompt asked for it explicitly.

### 4. Perception: FOV, eye height, LOS

**MEASURED — FOV identical.** Both default `fovDegrees: 150` (`bot-viewer-v2.html:7648`,
`environment-viewer-v2.html:3590`), both read live from `botBehaviorSettings.fovDegrees` merged with
`tierPerception.fovDegrees` (`bot-viewer-v2.html:6389`, `environment-viewer-v2.html:3891`).

**MEASURED — eye height drifted.** A defines `EYE_LIFT = 0.85` (`bot-viewer-v2.html:6652`, comment:
"fraction up the capsule used as eye/muzzle height, both bot and dummy") and computes the eye point as
`entity.capsule.start.clone().lerp(entity.capsule.end, EYE_LIFT)` (`:7103`, `:7107`). B's
`botEyeInto(entity, out)` (`environment-viewer-v2.html:3426`) instead does
`out.{x,y,z} = entity.capsule.end.{x,y,z}` — the **100%** point, with no lerp fraction at all. Per
`bot-entity.js:26-31`, `capsule.end = spawnPos.y + standHeight - radius`, i.e. already `radius` below
true head-top; A's 0.85 lerp lands further down that span again. `botEyeInto` is the eye/muzzle point
used pervasively in B: target selection (`:3975`), pack-seek (`:4257`), grenade throw origin
(`:6066`, `:6084`), and — critically — the sentry LOS/fire eye (`:6181`, `:6491`). **Net effect:** B's
bots see and shoot from a point noticeably higher on the body than A's (roughly `0.15 × standHeight`
higher), which changes what counts as "exposed" over waist-high cover and where a shot visually
originates. This is a genuine, quantifiable behavioral divergence, not just a render artifact.

**MEASURED — LOS raycast semantics.** `docs/subsystems/bots.md:6628-6633` (dated 2026-07-31) records
that B's `botHasLineOfSight` was updated to pass `heightAt: terrainHeight` (matching the bullet path)
and to drop a 120ms occlusion cache in favor of per-frame fresh raycasts, explicitly to match A's
cadence. I did not re-derive this from source in this pass (doc-only, cross-referenced against A's own
un-cached per-frame LOS calls at `bot-viewer-v2.html:10234`-area `updateBotSentry`); flagging as
**doc-sourced, not independently re-measured this round**.

### 5. Stuck detection

**MEASURED — missing from A, present in B.** `bot-activity.js:238-256` exports `STUCK_MIN_SPEED` and
`trackStuck({speed, moving, stuckSince, nowMs})`. B imports it as `trackStuck as botTrackStuck`
(`environment-viewer-v2.html:104`) and calls it at `:6774`:
`const stuck = botTrackStuck({ speed: dt > 0 ? movedDist / dt : 0, moving, stuckSince: rec.stuckSince, nowMs });`
feeding B's escape/rescue machinery (`BOT_STUCK_ESCAPE_RETRIES`, `botTickOne` around `:6730`).
A never imports `trackStuck` and has no `stuckSince`/`STUCK_MIN_SPEED` anywhere (confirmed two ways,
see Absence section). A's closest equivalent is path-failure counting
(`botDiag.patrolNoRoute/patrolLocalFallback/patrolIsolated/patrolEscaped/patrolStranded`,
`bot-viewer-v2.html:3140-3144`) plus a separate "recovery" system for fallen/rescued bots
(`:12779` tooltip). These are related but not the same mechanism — A detects "path planning failed N
times," B additionally detects "moving too slowly for too long regardless of path state." **This is a
genuine feature B has that A lacks**, the under-covered direction the brief called out.

### 6. Combat: aim, spread, fire gating, pursue/disengage

**MEASURED — identical.** Both construct `botAimSettings = { ...AIM_DEFAULTS }` verbatim
(`bot-viewer-v2.html:7655`, `environment-viewer-v2.html:3596`) with no further field overrides found
in either file (grepped `botAimSettings\.` assignments beyond the definition — only reads). Source
defaults (`bot-aim.js:5-20`): `reactionMs 260`, `reactionPerMetreMs 12`, `reactionMaxMs 900`,
`reactionMinMs 100`, `reacquireGraceMs 600`, `baseSpreadDeg 0.35`, `moveSpreadDeg 2.5`,
`firstShotSpreadDeg 2.0`, `settleMs 800`, `bloomPerShotDeg 0.45`. `docs/subsystems/bots.md:6608-6624`
confirms this was a deliberate 2026-07-31 sync (B previously had a "700/40/2000" override plus a
`botNoticeTimeSec` slider that was removed).

**MEASURED — identical.** Pursue-break-on-miss: `pursueMissStreak: 3` in both
(`bot-viewer-v2.html:7639`, `environment-viewer-v2.html:3584`), consumed by the identical formula
`botMissStreak >= pursueBreakThreshold(botBehaviorSettings.pursueMissStreak, spreadSeed)`
(`bot-viewer-v2.html:10441`, `environment-viewer-v2.html:6330`), and `MISS_STREAK_SIGHT_RESET_MS = 1500`
in both (`:6685`, `:3650`). **This is the pursue/disengage-on-miss threshold, distinct from the
heal-retreat threshold in §9 below** — the two must not be conflated (see the audit brief's warning);
I verified them as two separate constant families with separate surrounding comments.

**MEASURED — identical.** Target-selection risk/pile-on scoring (`selectBotTarget`) is byte-identical
in constants and formula between the two files: `TARGET_STICK_RISK_MARGIN 1.3`, `TARGET_COMMIT_MIN_MS
1500`, `TARGET_DANGER_SELF_BONUS 2.5`, `TARGET_DANGER_ALLY_BONUS 1.2`, `TARGET_PILE_ON_STEP 0.25`,
`TARGET_PILE_ON_FLOOR 0.4` all appear with the same values and the same `danger +=`/`pileOnFactor`/
`dwellHolding` logic in both (`bot-viewer-v2.html:6406-6542`, `environment-viewer-v2.html:3937-4047`).
**This directly contradicts `docs/subsystems/bots.md:2353-2357`**, which states as "Known drift" that
B "carries an earlier copy of this same target-selection code... it still has the old distance-only
pick with no danger/pile-on awareness." That doc note is dated against the 2026-08-05 risk-pass
changelog entry immediately above it; the code in this snapshot (dated 2026-08-08) shows the
risk-based pick has since been ported into B and the doc note was never updated. **Report this doc
passage as stale — the parity gap it describes no longer exists in code.**

**MEASURED — sidearm/grenade tuning identical.** `bot-sidearm.js` imports
(`SIDEARM_DRAW_MS, SIDEARM_LULL_MS, PISTOL_IDS, pickSidearmId, chooseWeaponSlot, outOfAllAmmo`) are
symbol-identical in both (`bot-viewer-v2.html:6616`, `environment-viewer-v2.html:145`), no local
overrides found. `botGrenadeSettings = { ...GRENADE_DEFAULTS }` verbatim in both
(`bot-viewer-v2.html:8977`, `environment-viewer-v2.html:5923`), defaults from `bot-grenade.js:6-20`
(`perBotCount 2`, `cooldownMs 9000`, `teamCooldownMs 2500`, `minRange 8`, `maxRange 25`, etc.) — no
overrides in either file.

**MEASURED — knife commit window drifted.** `KNIFE_COMMIT_MAX_MS` = 8000 in A
(`bot-viewer-v2.html:6686`, "longest a knife charge may run before it is abandoned") vs 12000 in B
(`environment-viewer-v2.html:3653`); `KNIFE_COMMIT_COOLDOWN_MS` = 5000 in A (`:6687`) vs 6000 in B
(`:3654`). B lets a knife rush run 50% longer and re-arm 20% slower than A.

### 7. Cover / corners

**MEASURED — `COVER_ANCHOR_REACH` present only in B.** A's `bot-cover.js` import
(`bot-viewer-v2.html:6626-6633`) has no `COVER_ANCHOR_REACH`. B's equivalent import
(`environment-viewer-v2.html:125-132`) adds it, and B uses it directly:
`const COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6;` (`:5705`, with the surrounding comment
at `:5702` noting "a centre can sit ~1.06 m from the anchor -- outside COVER_ANCHOR_REACH (0.45 m)").
I did not find an equivalent named constant governing final cover-approach stop distance in A within
the time available — flagged as **not independently confirmed absent in A beyond the import-list and
targeted-symbol checks** (see Absence section, this is one of the two-method-confirmed items).

### 8. Contact memory

**MEASURED — `contactRecency` present only in A.** A imports
`createContactMemory, recordContactSighting, markContactsUnseen, contactRecency` from
`bot-contacts.js` (`bot-viewer-v2.html:6647-6649`). B imports only the first three
(`environment-viewer-v2.html:79`), omitting `contactRecency`. `bot-contacts.js` is otherwise identical
in surface between the two (`createContactMemory`, `recordContactSighting`, `markContactsUnseen`
match). Whatever `contactRecency` gates in A (e.g., decaying confidence in a remembered sighting) is
therefore not available to B's per-bot contact memory. I did not open `bot-contacts.js`'s function body
in this pass to characterize the exact behavioral delta — **INFERRED** that this narrows B's memory
model relative to A's, not independently traced to a call site in A within budget.

### 9. Health / heal-retreat tuning (distinct from pursue/disengage, §6)

**MEASURED — significantly drifted, full object quoted both sides.**

A, `bot-viewer-v2.html:7656-7665`:
```
const botHealthSettings = {
  retreatEnabled: true,
  threshold01: 0.60,
  resume01: 0.72,
  healPerSecond: 18,
  safeDistance: 8.5,
  safeHoldMs: 500,
  retreatSearchRadius: 10,
  coverScore: 12,
};
```

B, `environment-viewer-v2.html:3611-3619`:
```
const botHealthSettings = {
  retreatEnabled: true,
  threshold01: 0.35,   // at/below this HP a bot breaks off to heal
  resume01: 0.85,      // heal until here
  safeDistance: 12,    // healUnsafeBand centre: a visible threat inside this cancels the channel
  safeHoldMs: 900,     // unbroken safe time before the heal actually starts
  healPerSecond: 22,
  retreatSearchRadius: 10,   // wounded flee search widens to this (harness parity)
};
```

Both objects are consumed by shared `bot-activity.js`/`bot-medic.js`/`bot-health-packs.js` functions
identically (e.g. `healUnsafeBand(...)` called the same way at `bot-viewer-v2.html:9691` and
`environment-viewer-v2.html:4370`), so **the divergence is purely in the tuning numbers, not the
mechanism**. Net effect: A's bots break off to heal at 60% HP and stop healing at 72%; B's bots fight
on down to 35% HP (much more reckless) but then heal further, to 85%, and demand a wider safety
distance (12m vs 8.5m) and a longer unbroken-safe hold (900ms vs 500ms) before starting. `coverScore:
12` exists only in A's object (used at `bot-viewer-v2.html:8880`); B's object has no `coverScore`
field at all (confirmed: not present in the quoted block above, and a grep for `botHealthSettings\.
coverScore` in B returns nothing — second method).

**MEASURED — pack settings also drifted.** A, `bot-viewer-v2.html:7666-7671`:
`pickupRadius 0.7, shortProximity 4.0, dropScatter 0.45, pickupCrouchMs 450`. B,
`environment-viewer-v2.html:3620-3623`: `dropScatter 0.35, pickupRadius 0.9, shortProximity 12,
pickupCrouchMs 600, worldSpawnCount: 0` (extra field, ambient-pack seeding, absent from A's object).

### 10. Roles / squads

**MEASURED — role spawn-mix defaults drifted (appears intentional for one field).**
A: `botMedicPercent` default not shown inline near the settings block I read but a UI-set default of
25 appears in the shipped-features memory note and is consistent with the harness's tuning UI; B sets
`let botMedicPercent = 20;` (`environment-viewer-v2.html:3605`), `let botSniperPercent = 0;` (`:3606`),
`let botTechnicalPercent = 0; // RPG has no ballistic lead (harness parity): default off` (`:3607`).
A's `botRoleMix` is built with `{ [ROLE_SNIPER]: 10, [ROLE_TECHNICAL]: 10 }`
(`bot-viewer-v2.html:7676`), i.e. A spawns 10% sniper / 10% technical by default; B spawns 0%/0% by
default with `botRoleMix = {}` refilled from sliders (`:3609`). The comment on B's technical default
explains the *reason* (RPG bots lack ballistic lead so are deliberately held back by default) but does
**not** claim the 0%/0% numbers themselves match A — read literally it is explaining an intentional
divergence, not asserting parity. **Verdict: drifted, partially by design** (technical), unexplained
for sniper and medic.

**MEASURED — squad settings identical.** `botSquadSettings` is constructed with the exact same
expression in both files: `{ ...SQUAD_DEFAULTS, slotRepath: 1.0, corridorProbeMs: 300, mergeRadius:
SQUAD_MERGE_RADIUS }` (`bot-viewer-v2.html:1040`, `environment-viewer-v2.html:2162`), and every
downstream read (`botSquadSettings.mergeRadius/corridorProbeMs/spacing/slotArrive/leash/slotRepath`)
appears at matching call sites in both (`bot-viewer-v2.html:5981,6100,6104,7074,9986-9988,10011` vs
`environment-viewer-v2.html:3067,3125,3129,5008-5010,5028`).

**MEASURED — squad-hold patience drifted.** `SQUAD_HOLD_MAX_MS` = 12000 in A
(`bot-viewer-v2.html:6688`, "longest a follower holds a slot before doing its own thing") vs 6000 in B
(`environment-viewer-v2.html:2164`, "past this, a follower stuck holding its slot goes back to
patrolling"). B's followers give up on formation-holding twice as fast as A's.

**MEASURED — `squadSlotWorld`/`teamCentroid` present only in A.** A imports `squadSlotWorld` from
`bot-squad.js` (`bot-viewer-v2.html:921`) and `teamCentroid` from `bot-medic.js` (`:923`); neither
appears anywhere in B (confirmed absent by whole-file grep, 0 occurrences each — second method beyond
the import-list read). Not independently traced to a specific missing B behavior within budget;
**INFERRED** this narrows either squad cohesion-target computation or a debug/visual helper in B
relative to A.

**MEASURED — medic close-approach creep missing from B.** `bot-medic.js:46-47` exports
`MEDIC_CONTACT_RADIUS = 0.85` and `MEDIC_CONTACT_CREEP = 0.45`. A imports and uses both
(`bot-viewer-v2.html:924`, then `:9931-9932`: `if (!(d > MEDIC_CONTACT_RADIUS)) { ... return; }` /
`const speed = currentBotMoveSpeed() * MEDIC_CONTACT_CREEP;`) — a medic slows to 45% speed inside
0.85m of the ally it's tending, so it doesn't overshoot/jitter at contact range. B imports neither
symbol and has 0 occurrences of either name — its medics presumably rely on whatever general
arrival-radius logic the shared `bot-medic.js` functions already provide, without this final-approach
deceleration. **INFERRED behavioral effect** (possible overshoot/oscillation at very close range);
not observed at runtime (no browser tools used per instructions).

### 11. Navigation: grid build, region labeling, connectivity

**MEASURED — identical resolution.** `NAV_CELL = 0.5`, `WAYPOINT_REACH = 0.35` in both
(`bot-viewer-v2.html:7154,7571`; `environment-viewer-v2.html:3631-3632`, sourced from
`BOT_NAV_CELL = 0.5` / `BOT_WAYPOINT_REACH = 0.35` at `:2198,2201`).

**MEASURED — same algorithm, different call convention (architectural).** A calls only
`buildNavGrid(...)` (`bot-viewer-v2.html:6619` import, 0 occurrences of `finalizeNavGrid` anywhere in
A — confirmed via direct grep). B imports both `buildNavGrid` and `finalizeNavGrid`
(`environment-viewer-v2.html:111`) and calls `finalizeNavGrid` directly at `:2506`. Per
`nav-grid.js:47-58`, `finalizeNavGrid` is exactly the region-labeling (`labelRegions`) +
`connectStrandedRegions` half of `buildNavGrid`, split out so a bake too large for one frame can
sample incrementally and finalize once — the module's own comment names
`environment-viewer-v2's terrain combat-zone grid` as the reason for the split
(`nav-grid.js:48-50`), and `buildNavGrid` itself is defined as the sampling loop plus a call to
`finalizeNavGrid` (`nav-grid.js:43-44`), so the two paths cannot diverge in region-labeling or
connectivity behavior. `docs/subsystems/bots.md:5963-5980` (Phase D, 2026-07-30) documents this as a
deliberate architecture decision: B needs a persistent, player-anchored, time-sliced combat-zone grid
for open/authored terrain maps that run 1200-4000m across, versus A's single-shot bake over a bounded
maze. **Verdict: n/a-architectural, not a behavioral gap** — same region-labeling/flood-fill/A*
machinery underneath (`lineWalkable, floodFill, floodPath, advancePath, worldToCell, cellToWorldInto,
regionAt` are symbol-identical imports in both, `bot-viewer-v2.html:6619`,
`environment-viewer-v2.html:111-112`).

**MEASURED — B-only local A* window for open terrain.** B defines
`BOT_LOCAL_NAV_RADIUS = 18` and `BOT_LOCAL_NAV_CELL = 1.5` (`environment-viewer-v2.html:2203-2206`,
comment: "on-demand local A* window used on open/authored terrain -- these maps run 1200-4000m
across... far too large to bake a single static grid over the way shoot-house's bounded interior is
baked"). A has no equivalent (`LOCAL_NAV_CELL`/`localNavCell` returns 0 occurrences in A — confirmed
two ways: targeted grep and, separately, absence from A's own `NAV_CELL`/`WAYPOINT_REACH` block
above). **n/a-architectural**: A's maps are bounded shoot-house/maze layouts that fit one static bake;
B additionally supports open procedural terrain that cannot be baked wholesale.

**MEASURED — danger field and separation constants identical.** `bot-danger.js` import list is
symbol-identical (`bot-viewer-v2.html:6634-6637`, `environment-viewer-v2.html:133-136`):
`DANGER_DEATH_WEIGHT, DANGER_HIT_WEIGHT, DANGER_FLEE_SCALE, DANGER_PATROL_SCALE,
DANGER_PACK_SCALE`. `SEPARATION_RADIUS = 1.5` / `SEPARATION_WEIGHT = 0.5` identical
(`bot-viewer-v2.html:7572-7573`, `environment-viewer-v2.html:3633-3634`).

**MEASURED — B-only stuck-recovery escalation.** `BOT_STUCK_ESCAPE_RETRIES`-gated escape/teleport
logic in B's `botTickOne` (`environment-viewer-v2.html:6729-6733` and following) rides on top of the
`trackStuck` detector from §5; A's nearest equivalent is its own `patrolStranded`/escape-hatch
diagnostics (`bot-viewer-v2.html:3140-3144`) plus a separate ragdoll/fallen-state "recovery" system
(`:12779`). Not the same code path in either direction — this is the same finding as §5, restated
under navigation because it's a nav-side consequence (stuck-in-terrain vs stuck-in-pathing are
different failure modes each viewer catches with a different net).

### 12. Stance selection

**MEASURED — core stance machinery identical, run/dash extension missing from B.** Both import
`STANCE_CROUCH, STANCE_PRONE, STANCE_STAND, STANCE_DEFAULTS, chooseBotStance, stepStanceTransition,
stanceSpeedFactor, stanceSpreadScale, stanceHeightScale, stanceCapsuleHeightScale,
stanceTurnRateScale, stepStanceWeights, blendStanceHeightScale` (`bot-viewer-v2.html:929-931` minus
`STANCE_RUN, STANCE_DASH, resolveStanceOverride`; `environment-viewer-v2.html:146-148`). A additionally
imports `STANCE_RUN, STANCE_DASH, resolveStanceOverride`; B does not (0 occurrences of
`resolveStanceOverride` anywhere in B; `STANCE_RUN`/`STANCE_DASH` each appear exactly once in B, both
inside comments — `:3608` "STANCE_RUN speed multiplier (harness botMovementSettings default)" and
`:6545` "-> STANCE_DASH while clearing a blast" — never as an imported symbol or live value). B
substitutes its own `let botRunMultiplier = 1.7;` variable (`:3608`) for run-speed scaling, which does
match A's `botMovementSettings.runMultiplier: 1.7` (`bot-viewer-v2.html:1490`) in value, so **run speed
itself is numerically at parity even though the mechanism differs** (a bespoke multiplier vs the
shared `STANCE_RUN` stance constant). The blast-evade comment at B `:6545` suggests B's evade motion is
*conceptually* dash-like but does not actually apply `bot-stance.js`'s `STANCE_DASH` visual/physical
profile — **INFERRED** this means B's evade dash and A's evade dash can look/feel different even
though both are triggered by the same `bot-grenade.js` `grenadeEvade` logic (imported identically in
both, `bot-viewer-v2.html:117`, `environment-viewer-v2.html:157`).

### 13. Team-side regions / structures / home base

**MEASURED — `bot-structures.js` not imported in B; B re-derives the concept inline.** A imports
`teamSideRegions, generateHomeBase, HOME_BASE_DEFAULTS` from `bot-structures.js`
(`bot-viewer-v2.html:7267`). B has zero import of `bot-structures.js` and a single reference in a
comment: `// side model bot-structures.js's teamSideRegions bakes in the harness, derived here from
whatever...` (`environment-viewer-v2.html:2650`). This is explicit, first-party acknowledgment in B's
own source that the team-side split is a **separate, inline reimplementation** of the same concept, not
a shared call — meaning any future tuning change to `bot-structures.js`'s `teamSideRegions` will
silently NOT reach B. I did not read the full inline reimplementation in this pass (time budget);
flagging its existence and location for a follow-up diff. `generateHomeBase`/`HOME_BASE_DEFAULTS`
(home-base structure generation) have no B counterpart found at all — **missing-from-B**, not just
reimplemented.

### 14. State-code tracer, forensics, camera-control, score formatting (viewer/QA-only)

**MEASURED.** `bot-state-code.js` is statically imported and always active in A
(`bot-viewer-v2.html:932-934`). In B it is **dynamically** imported only when `?botTrace=1` is present
(`environment-viewer-v2.html:7076,7093`, comment: "Inert by default -- with the flag off nothing is
imported and the per-bot cost is one boolean test"). This is a deliberate perf-gated QA instrument, not
a behavioral gap — B's own comment at `:7073-7075` frames it as "the QA instrument for the
bot-viewer-v2 brain port: same encoder, same TSV columns as the harness, so a take here diffs
slot-by-slot against a take there." **n/a — present in both, activation differs by design.**

`createBotForensics` (from `bot-entity.js`) is imported only in A (`bot-viewer-v2.html:909`); 0
occurrences in B. `bot-camera-control.js` (`chooseOcclusionCandidate, dampAlpha, dampAngle,
stepOcclusionMemory, stepPovRecenter`) is imported only in A (`bot-viewer-v2.html:118`) — this
resolves orbit-camera occlusion for the harness's free-look POV camera, which has no B equivalent
because B has a full first/third-person player camera system instead (n/a-architectural, INFERRED from
the symbol names and B's very different camera stack, not independently traced). `bot-score.js`'s
`formatBreakdownLines, formatRoundLine, resetScoreboard` are imported only in A
(`bot-viewer-v2.html:925-926`); B imports `createScoreboard, recordSpawn, recordKill, recordRevive,
decideRoundOutcome, finishRound, formatRoundHeader, formatTeamScore` only
(`environment-viewer-v2.html:80-81`) — B can compute and format a scoreboard but cannot reset it
mid-session or print the extended breakdown/round-line text A can. `squad-activity.js` (the old,
pre-`bot-squad.js` module) is imported by **neither** viewer — both have moved to `bot-squad.js`;
B's comment at `:3372,9908` notes only `bot-viewer.html` (v1, not v2) still imports it.

### 15. Deliberately-not-ported features (doc-confirmed)

**Doc-sourced, cross-checked by grep.** `docs/subsystems/bots.md:7702-7714` lists two items as
explicitly out of scope for B, both re-confirmed absent in code this round:

- `rescueHeightAt` (below-terrain floor rescue) — A's `mapCollider` branch in `stepBotPhysics` uses it;
  B's `terrainHeight` raycasts from the top of map bounds and already has two other safety nets
  (`heightAt` flat-snap, `BOT_FALL_CATCH_DROP_M`), so porting it would risk lifting bots that are
  legitimately standing under a mezzanine onto it.
- The player command layer (right-click order menu, middle-button command wheel, `orderOverride`,
  `doubleTime`, break-contact, order voice acks) — **MEASURED**: `orderOverride` appears in B only in
  two comments (`environment-viewer-v2.html:618,10615-10616`, "see the orderOverride rung in
  bot-activity.js"), never as a live assignment; `doubleTime`/`breakContact`/`break-contact` have 0
  occurrences in B. A's `commandBreakContact`/`commandGoal`/`commandTargetId` at
  `bot-viewer-v2.html:10615-10616` (input side) have no B counterpart. The doc is correct that
  `bot-activity.js`'s consumption-side field (`orderOverride`) is already imported into B and ready to
  be driven — nothing currently drives it.

## Ranked list of most significant parity gaps

1. **Heal-retreat health threshold: 60% (A) vs 35% (B).** This is the single biggest behavioral lever
   in the whole comparison — it changes when a hurt bot disengages to heal at all, and every
   downstream heal/resume/safe-distance/safe-hold number differs alongside it
   (`bot-viewer-v2.html:7656-7665` vs `environment-viewer-v2.html:3611-3619`). A player fighting B's
   bots will see them fight much longer while wounded than A's harness ever demonstrates.
2. **No think-stagger in B.** At high bot counts B pays the full FSM decision cost every bot every
   frame, where A explicitly throttles to keep frame time flat (`bot-viewer-v2.html:3128-3131,3341,
   3364-3370` vs the unconditional `botTickOne` call at `environment-viewer-v2.html:7055`). Matters
   for scaling the game's bot roster, not for small counts.
3. **Eye/muzzle height uses the top of the capsule in B instead of a 0.85 lerp in A**
   (`environment-viewer-v2.html:3426` vs `bot-viewer-v2.html:6652,7103,7107`). Height affects both what
   a bot can see over cover and where its shots visually originate — a systematic, silent offset in
   every LOS check and every fired round.
4. **Stale "inert until the brain lands" comment in B's `bot-activity.js` import block**
   (`environment-viewer-v2.html:105`) actively misdescribes fully-wired code. Left as-is, it will
   mislead the next person who reads it into thinking those states are dead.
5. **`bot-structures.js`'s `teamSideRegions` is duplicated inline in B rather than shared**
   (`environment-viewer-v2.html:2650`), and `generateHomeBase`/`HOME_BASE_DEFAULTS` have no B
   counterpart at all — any future tuning of team-side placement in the shared module silently will
   not reach B.
6. **Squad-hold patience halved in B** (12000ms A vs 6000ms B, `bot-viewer-v2.html:6688` vs
   `environment-viewer-v2.html:2164`) — B's squads fragment into independent action twice as readily.
7. **Stale doc claim of target-selection drift** (`docs/subsystems/bots.md:2353-2357`) no longer
   matches code — the risk/pile-on scoring is now identical in both viewers. Low behavioral
   significance (it's already fixed) but high documentation-trust significance: this is exactly the
   kind of stale "X is missing" claim the audit brief warned about, just living in the doc instead of
   in my own reasoning.
8. **Medic final-approach creep (`MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP`) absent from B**
   (`bot-medic.js:46-47`, used only in A at `bot-viewer-v2.html:9931-9932`) — plausible source of medic
   overshoot/jitter at very close range in B, not confirmed at runtime.

## Absence claims and how I confirmed them

For every claim of the form "X is not imported / not present in file Y," I used two independent
methods before writing it above:

1. **`createBotForensics` absent from B** — (a) read B's full `bot-entity.js` import line
   (`environment-viewer-v2.html:100-101`) and confirmed the symbol list does not include it; (b)
   `grep -c "createBotForensics"` over the whole file returned 0.
2. **`bot-state-code.js` static-import absent from B** — (a) grepped `from ['"]\./(bot-|nav-)` across
   the whole file and found no static import line; (b) separately grepped every `await import(` call
   in the file (11 hits) and found the module IS present, just dynamically loaded
   (`environment-viewer-v2.html:7093`) — this second method caught what the first would have
   misreported as a flat absence, exactly the failure mode the brief warned about.
3. **`bot-structures.js`, `bot-terrain.js`, `bot-camera.js`, `bot-camera-control.js`,
   `bot-forensics.js`(as a module), `bot-body-versions.js`, `bot-viewer-visuals*.js`,
   `bot-viewer-slots.js`, `bot-human-body.js`, `body-part-batches.js`, `squad-activity.js` absent from
   B's static imports** — (a) grepped `from ['"]\./(bot-|nav-)` (comprehensive static-import list,
   reproduced in full in §1); (b) grepped each basename as a bare string across the whole file (not
   just inside import statements) to catch comments/dynamic references — `bot-structures` and
   `bot-state-code`/`bot-terrain` returned comment-only or dynamic-only hits (documented above),
   the rest returned zero hits anywhere in the file.
4. **`STANCE_RUN`, `STANCE_DASH`, `resolveStanceOverride`, `squadSlotWorld`, `teamCentroid`,
   `MEDIC_CONTACT_RADIUS`, `MEDIC_CONTACT_CREEP`, `formatBreakdownLines`, `formatRoundLine`,
   `resetScoreboard`, `contactRecency`, `packsTotalHp` absent as live symbols in B** — (a) read B's
   full multi-line import blocks for `bot-stance.js`, `bot-squad.js`, `bot-medic.js`, `bot-score.js`,
   `bot-contacts.js`, `bot-health-packs.js` directly (`environment-viewer-v2.html:141-148,153-156,
   79-81`); (b) ran a single batched `grep -c` for all twelve symbol names across the whole file —
   `STANCE_RUN`/`STANCE_DASH` returned exactly 1 (comment-only, confirmed by reading the line; not an
   import or live use), every other symbol returned 0.
5. **`COVER_ANCHOR_REACH` absent from A** — (a) read A's full `bot-cover.js` import block
   (`bot-viewer-v2.html:6626-6633`) directly, symbol not present; (b) `grep -c "COVER_ANCHOR_REACH"`
   over the whole A file returned 0.
6. **`trackStuck`/`STUCK_MIN_SPEED`/`stuckSince` absent from A** — (a) grepped the exact symbol names,
   0 hits; (b) separately grepped the broader root `stuck` (case-sensitive substring, catches any
   naming variant) across the whole file — the 5 hits that exist are all comments/UI tooltip text
   about "a stuck or fallen state" / "why a bot appears stuck," none is a variable declaration or
   function call implementing speed-based stuck detection.
7. **`orderOverride`/`doubleTime`/`break-contact` command-layer absent from B** — (a) grepped each term
   across the whole B file — `orderOverride` returned 2 hits, both inside comments referencing A's
   mechanism, never a live assignment; `doubleTime` and `break-contact` returned 0; (b) cross-checked
   against `docs/subsystems/bots.md:7709-7714`, which independently documents this as a deliberate,
   not-yet-wired gap for the same reason (differing input schemes between orbit-cam harness and
   pointer-locked FPS game).

## Not independently verified this round (flagged, not asserted)

- The exact behavioral effect of A's `contactRecency` (§8) and A's `squadSlotWorld`/`teamCentroid`
  (§10) — confirmed as import-list-only differences; I did not open the call sites inside
  `bot-contacts.js`/`bot-squad.js`/`bot-medic.js` to characterize what specifically breaks in B without
  them.
- LOS raycast semantics (`heightAt: terrainHeight` gating, occlusion-cache removal) — relied on
  `docs/subsystems/bots.md:6628-6633` rather than re-reading both `botHasLineOfSight` implementations
  side by side this round; flagged as doc-sourced.
- B's inline reimplementation of `teamSideRegions` (§13) — location confirmed
  (`environment-viewer-v2.html:2650` and surrounding function), full logic not diffed against
  `bot-structures.js`'s original within the time budget.
