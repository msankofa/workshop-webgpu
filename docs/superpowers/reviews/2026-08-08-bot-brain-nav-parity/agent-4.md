# Bot brain + navigation parity: bot-viewer-v2.html vs environment-viewer-v2.html

Date: 2026-08-08
Scope: FSM/think-cadence, perception/alert/contacts, combat decision-making, roles/squads/medic/score, navigation.

Methodology note: every row below is either **MEASURED** (an agent read the exact cited lines in this session) or **INFERRED** (reasoned from surrounding/partial context without opening every line). Where a finding could plausibly be wrong because it rests on a grep with no full read, that is flagged explicitly. All investigation was done by five parallel sub-agents, each given known import-block anchors already measured by the orchestrator directly (see "Orchestrator-measured import blocks" at the end). No files were modified; no browser tools were used.

---

## 1. Summary table

| Area | Sub-area | bot-viewer-v2 | environment-viewer-v2 | Verdict |
|---|---|---|---|---|
| FSM/cadence | FSM ladder (`chooseBotStateName`) | bot-viewer-v2.html:10625 | environment-viewer-v2.html:6416 | identical |
| FSM/cadence | Stance resolve (`chooseBotStance`/`stepStanceTransition`) | bot-viewer-v2.html:10710-10712 | environment-viewer-v2.html:6477-6479 | drifted |
| FSM/cadence | Manual stance override (`resolveStanceOverride`) | imported + applied, bot-viewer-v2.html:931, 10714 | **not imported at all** | missing in env-viewer |
| FSM/cadence | Sidearm draw/swap (`pickSidearmId`/`chooseWeaponSlot`) | bot-viewer-v2.html:1788, 1834 | environment-viewer-v2.html:2763, 3810 | identical |
| FSM/cadence | Population-adaptive think-cadence/LOD (`botThinkStride`) | bot-viewer-v2.html:3128-3131, gates FSM think per bot | **no equivalent gate on `botTickOne`/`updateBotSentry`** — runs every frame for every bot | missing in env-viewer |
| FSM/cadence | Gear/render LOD (`BOT_RBOX_LOD`, `?rboxlod=`) | bot-viewer-v2.html:3096-3126 | absent (0 matches) | missing in env-viewer |
| FSM/cadence | Target-rescan stagger | folded into population-adaptive sentry gate | separate fixed `TARGET_SCAN_STRIDE=4` (env-viewer-v2.html:3647), not population-adaptive | drifted |
| FSM/cadence | Break-contact order rung (`orderOverride`/`commandBreakContact`) | wired, bot-viewer-v2.html:10616-10617 | absent — field never set, no `commandBreakContact` in file | missing in env-viewer (expected: squad point-command UI is bot-viewer-v2-only) |
| FSM/cadence | `holding` gate (which states a commanded hold can freeze) | allow-list: PATROL/SEEK/PURSUE only, bot-viewer-v2.html:10678-10679 | deny-list: all states except FLEE/HEAL/AIM/FIRE/COVER_HOLD/KNIFE, environment-viewer-v2.html:6458-6459 | drifted (semantically different, not just cosmetic) |
| FSM/cadence | `sc.medicTend` stance-ctx field | explicitly removed with comment, bot-viewer-v2.html:10698 | still set, environment-viewer-v2.html:6472 | drifted (dead field, `chooseBotStance` doesn't read it — cosmetic only) |
| Perception | FOV cone (`withinBotFov`) | bot-viewer-v2.html:6387-6396 | environment-viewer-v2.html:3842-3849 | identical |
| Perception | Split attention (`stepAttention`/`attentionSweep`) | bot-viewer-v2.html:9649,9652-9653,9672 | environment-viewer-v2.html:5698,5701-5702,5712 | identical |
| Perception | Alert escalation/tiers | bot-viewer-v2.html:344,6276,10456,10509 (approx.) | environment-viewer-v2.html:1618,6276,6328,6456 | identical, same shared constants |
| Perception | Squad "contact" callout ring (`recordContact`/`latestContactNear`) | wired, bot-viewer-v2.html:10289, 10522 | wired, environment-viewer-v2.html:6152, 6340 | identical |
| Perception | Exposure gate (`exposedToThreat`) | bot-viewer-v2.html:9826, 10672 | environment-viewer-v2.html:4446, 6458 | identical |
| Perception | Per-bot private sighting memory (`bot-contacts.js`) | imported bot-viewer-v2.html:6648-6649, wired bot-viewer-v2.html:6479-6489, 7775 | imported environment-viewer-v2.html:79, wired environment-viewer-v2.html:3996-4003 (own comment: "Recorded but not yet consumed, same as the harness") | **identical** — CORRECTED (see §2.2 correction note); a sub-agent's initial "absent" claim was wrong, refuted by direct re-verification |
| Perception | Field-based LOS prefilter in target scan (`USE_FIELD_LOS_PREFILTER`) | bot-viewer-v2.html:6449, 6672, 6677, 9541 | absent from `selectBotTarget` (field exists, used for cover/exposure only) | missing in env-viewer (perf-only, not a correctness change) |
| Perception | Perceived-enemy POV debug snapshot | bot-viewer-v2.html:4758-4759, 6463-6472 | absent | missing in env-viewer (HUD/debug only) |
| Perception | Eye height for perception origin | `EYE_LIFT=0.85` (85% up capsule), bot-viewer-v2.html:6652, 7106-7107 | `botEyeInto` uses literal `capsule.end` (100%), environment-viewer-v2.html:3421 | **drifted** (real numeric difference) |
| Perception | LOS raycast richness | direct `mapCollider.raycast`, bot-viewer-v2.html:6529, 6546 | `botHasLineOfSight`→`resolveHitscan` incl. terrain/tree/rock occlusion, environment-viewer-v2.html:3164-3178, 3973, 3987 | richer in env-viewer (not a regression) |
| Perception | Target scoring formula (proximity×danger, pile-on, stickiness) | bot-viewer-v2.html:6494-6549 | environment-viewer-v2.html:3945-3990 | identical constants/formulas |
| Combat | `bot-aim.js`/`bot-pursuit.js`/`bot-grenade.js`/`bot-projectiles.js` imports | present | present, matching | identical (orchestrator's suspicion that A lacks bot-grenade.js import was WRONG — confirmed present at bot-viewer-v2.html:116-117) |
| Combat | Reaction delay (`reactionDelayMs`) | bot-viewer-v2.html:10199-10202, 10248-10256 | environment-viewer-v2.html:5746-5752 | identical |
| Combat | Shot spread formula | `spreadHalfAngleRad(...) * stanceSpreadScale(...)`, bot-viewer-v2.html:10208-10217 | same, **plus extra** `inaccuracy01 * BOT_MAX_SPREAD_RAD` term, environment-viewer-v2.html:5761-5769 | **drifted** |
| Combat | Move-speed spread denominator | stance-conditional, bot-viewer-v2.html:10209-10211 | always `botMoveSpeed`, environment-viewer-v2.html:5762 (own comment: "disabled stance keeps the legacy denominator, bug and all") | **drifted** |
| Combat | Disengage/flee thresholds (`fleeDistance`, `fleeExitBuffer`) | bot-viewer-v2.html:10606-10608 | environment-viewer-v2.html:6410-6412 | identical |
| Combat | Pursue break-off (`pursueBreakThreshold`, default miss-streak 3) | bot-viewer-v2.html:10441, 7639 | environment-viewer-v2.html:6267, 3579 | identical |
| Combat | Knife engage range/gating | bot-viewer-v2.html:8803-8828, 10902-10911 | environment-viewer-v2.html:5262-5305 | identical |
| Combat | Knife fire pipeline | direct `applyCombatDamage`, bot-viewer-v2.html:10908 | routed through replicated `applyCombatIntent`, environment-viewer-v2.html:5295-5299 | structurally different by necessity (MP replication), not a decision-logic drift |
| Combat | Grenade self pre-gate (corner-cook occlusion check) | occlusion-aware, bot-viewer-v2.html:9095-9096 | **occlusion check missing**, environment-viewer-v2.html:5954 | **drifted — real behavior regression** |
| Combat | Grenade evade hysteresis (`engagedId` arg) | passed, bot-viewer-v2.html:9291 | **omitted**, environment-viewer-v2.html:6062 | **drifted — real behavior regression** |
| Combat | Grenade decide cadence gate | bot-viewer-v2.html:9077 | environment-viewer-v2.html:5940 | identical |
| Roles/Squads | Role assignment (`assignRolesToBatch`) | bot-viewer-v2.html:2450, 2452 | environment-viewer-v2.html:2759, 2967 | identical |
| Roles/Squads | Squad leader election/succession | bot-viewer-v2.html:5845 | environment-viewer-v2.html:2887 | identical |
| Roles/Squads | Formation kind selection | bot-viewer-v2.html:6102, 6106 | environment-viewer-v2.html:3122, 3126 | identical |
| Roles/Squads | Squad member goal / slot | bot-viewer-v2.html:9984 | environment-viewer-v2.html:4943 | identical (gameplay path intact) |
| Roles/Squads | Squad debug-ring visualization (`squadSlotWorld` direct call) | bot-viewer-v2.html:7050-7089 | absent | missing in env-viewer (debug/viz only, no gameplay effect) |
| Roles/Squads | Medic decide (heal/revive/cohesion) | bot-viewer-v2.html:9828 | environment-viewer-v2.html:4448 | identical |
| Roles/Squads | Medic last-stride contact creep (`MEDIC_CONTACT_RADIUS`/`_CREEP`) | wired, bot-viewer-v2.html:9928-9934 | **absent** — `updateMedicTend` just zeroes velocity, environment-viewer-v2.html:4540-4567 | **drifted/missing — real behavior gap**: medic hand can stop up to 1.7m short of patient |
| Roles/Squads | Flee-squad cohesion centroid | `teamCentroid()` pure fn, bot-viewer-v2.html:8860 | inline reimplementation `fleeSquadCentroid()`, environment-viewer-v2.html:5426-5438 | functionally identical, differently implemented (duplication risk) |
| Roles/Squads | Health-pack debug HUD (`packsTotalHp`) | bot-viewer-v2.html:15581 | absent | missing in env-viewer (cosmetic only) |
| Roles/Squads | Scoreboard/round-outcome (`bot-score.js`) | fully wired, 11 symbols imported: bot-viewer-v2.html:950, 994-995, 2512, 2567, 5263, 10104, plus UI-only `resetScoreboard`/`formatBreakdownLines`/`formatRoundLine` at 12942, 12973, 12982 | wired with 8 of 11 symbols, environment-viewer-v2.html:80-81 (import), createScoreboard :3702, recordSpawn :2778, recordKill :14034, recordRevive :4638, decideRoundOutcome/finishRound :3731-3732, formatRoundHeader/formatTeamScore :3739, 3741 | **drifted (minor)** — CORRECTED (see §2.4 correction note); core kill/death/round-outcome tracking IS ported and wired; env-viewer lacks only a manual reset button and the per-cause/weapon breakdown + round-history log UI (`resetScoreboard`, `formatBreakdownLines`, `formatRoundLine` not imported) |
| Roles/Squads | `squad-activity.js` | not imported (belongs to v1 `environment-viewer.html`, not either "-v2" file) | one function (`pickExploreGoal`) copy-inlined at environment-viewer-v2.html:3368, marked "retired here" | n/a — module isn't shared between the two audited files at all |
| Navigation | `buildNavGrid`/`finalizeNavGrid` split | 1 one-shot call, bot-viewer-v2.html:7491; `finalizeNavGrid` never called (0 matches) | 3 `buildNavGrid` sites + 1 separate `finalizeNavGrid` call, environment-viewer-v2.html:2321, 3324, 2504 | drifted (additive, intentional — nav-grid.js:47-50 names env-viewer-v2 as the intended second consumer) |
| Navigation | A*/flood-fill/region-labeling/`lineWalkable`/`smoothPath`/`advancePath` | imported unaliased | imported with `bot`-prefixed aliases; confirmed no real naming collision exists in-repo | identical logic, cosmetic aliasing only |
| Navigation | `COVER_ANCHOR_REACH` constant | not imported, no local equivalent found | imported (line 128 of env-viewer-v2 import block), derives `COVER_FINAL_APPROACH_STOP`, environment-viewer-v2.html:5653-5656 | additive in env-viewer (terrain grid needs tighter final-approach stop; not a gap in A) |
| Navigation | `SIGHT_BLOCK_HEIGHT` constant | not imported | imported, used in `shootHouseSightRects` (2310-2319) and `botTerrainSightRects` (2407-2432) | additive in env-viewer (needed to derive sight rects from terrain dressing; A's walls carry pre-authored heights) |
| Navigation | `bot-separation.js` (goal claims, separation, pushout, waypoint contest) | consumed indirectly via `bot-entity.js` re-export, never imported directly | same — consumed indirectly via `bot-entity.js` re-export | identical, not orphaned |
| Navigation | Goal-claims/separation/pushout call-site shape and frequency | 1x each of `createGoalClaims`, `resolveBotPairsHashed`, `separationXZHashed`+`blendSeparationDir`, `waypointContestedHashed` | same 4 call-site shapes, same counts | identical |
| Navigation | Cover-corner map bake cadence (`buildCornerMap`) | 1 bake per layout load, bot-viewer-v2.html:7508 | 2 modes: static once for shoot-house maps, incrementally rebaked on player drift for open terrain | drifted (additive — required by open/procedural terrain) |
| Navigation | Danger field call sites (`recordDanger`/`dangerPenalty`) | 7 sites (death, hit, pack-score, patrol x2, flee, corner-anchor/peek) | 8 sites, same semantic set plus a corner-death variant | identical (1:1 semantic match) |
| Navigation | Terrain-aware nav (slope cost, height-aware walkability) | present and optional (`terrainSettings.enabled`), bot-viewer-v2.html:7490-7492 — bot-viewer-v2 is NOT flat-maze-only | present, plus a second, genuinely new persistent anchor-following zone-bake system for open/procedural terrain (384m span, 3ms/frame budget, `stepBotZoneBake`/`finishBotZoneBake`, environment-viewer-v2.html:2339-2529) | genuine architectural addition in env-viewer, not a parity bug |

---

## 2. Detailed findings by area

### 2.1 FSM / think-cadence / stance / sidearm

**Shared modules are byte-identical, unforked.** `bot-activity.js`, `bot-stance.js`, `bot-sidearm.js` export the same surface consumed by both files with no divergent local copies (MEASURED: full reads of all three modules). `bot-activity.js` defines the 10 FSM states (`BOT_PATROL/SEEK/PURSUE/FLEE/HEAL/KNIFE/AIM/FIRE/COVER_MOVE/COVER_HOLD`), `chooseBotState(Name)`, hysteresis helpers (`stepVisibleDebounce`, `healUnsafeBand`), and per-bot desync helpers (`spreadAnchor`, `pursueBreakThreshold`). `bot-stance.js` exports the 5 stance constants, `STANCE_DEFAULTS` (`proneEnabled: false` by default, bot-stance.js:31 — same default reaches both files), `chooseBotStance`, `stepStanceTransition`. `bot-sidearm.js` exports `SIDEARM_DRAW_MS=550`, `SIDEARM_LULL_MS=2500`, `SIDEARM_CLOSE_HYST=1.4`.

**Biggest gap in this area: no population-adaptive think-cadence/LOD in environment-viewer-v2 (MEASURED).** bot-viewer-v2's `botThinkStride(livingCount)` (bot-viewer-v2.html:3128-3131) auto-selects a stride of 1/2/3 based on live population thresholds (>40, >80), overridable via `?stagger=`, and gates the FSM think itself per-bot via a `scanPhase` offset (bot-viewer-v2.html:3365-3371) — this is the mechanism behind the "90-bot profile... think stagger + rig LOD SHIPPED" memory entry. environment-viewer-v2's `updateBots` (line 6908) calls `botTickOne`→`updateBotSentry` (6929-6991, 6661-6663) **unconditionally every frame for every living bot**, with no equivalent gate. There is also no `BOT_RBOX_LOD`/`?rboxlod=` gear-visual LOD system (bot-viewer-v2.html:3096-3126) in env-viewer at all. The only staggering present in env-viewer is an unrelated fixed `TARGET_SCAN_STRIDE=4` inside target re-acquisition (environment-viewer-v2.html:3647, 3919-3925) — not population-adaptive, and it doesn't gate the FSM step, only target rescans.

**Missing manual stance override.** `resolveStanceOverride` is imported and applied in bot-viewer-v2 (bot-viewer-v2.html:931, 10714) but environment-viewer-v2's bot-stance.js import list (lines 141-143) omits it, and no `botStanceOverride` variable exists anywhere in the file (grep, zero matches) — env-viewer bots always run the auto-derived stance with no manual force-crouch/force-prone path.

**Real logic drift in the `holding` predicate.** bot-viewer-v2 uses an allow-list — only PATROL/SEEK/PURSUE states can be frozen by a commanded hold (bot-viewer-v2.html:10678-10679). environment-viewer-v2 uses a deny-list — any state except FLEE/HEAL/AIM/FIRE/COVER_HOLD/KNIFE can be held (environment-viewer-v2.html:6458-6459). This is semantically different, not cosmetic: env-viewer permits holding during e.g. COVER_MOVE or an "alert" scan state that bot-viewer-v2 would exclude by omission. Since bot-viewer-v2 has no `commandBreakContact`/order UI equivalent wired in env-viewer either, this predicate's practical impact in env-viewer today is likely small, but it is a genuine ladder-logic fork that would resurface if/when hold-orders are exposed in env-viewer.

### 2.2 Perception (FOV / LOS / eye height / target selection / alert / contacts)

**Core perception ladder (FOV, split attention, alert tiers, exposure gate, target scoring) is identical**, consuming the same `bot-alert.js` and matching call-site shapes (see table above for citations). The squad-level "contact" callout ring (`recordContact`/`latestContactNear`, the 64-slot shared report used for "contact, north hallway" alerting) is fully wired in both.

**CORRECTION (post-review): `bot-contacts.js` is NOT absent from environment-viewer-v2 — the first-pass sub-agent finding was wrong, refuted by direct re-verification.** MEASURED directly by the orchestrator: `environment-viewer-v2.html:79` imports `createContactMemory, recordContactSighting, markContactsUnseen` from `./bot-contacts.js` (this import sits in an early module-loading block at lines 55-93, separate from the later bot-brain import block at 95-156, which is presumably why the first grep pass missed it). It is wired identically to bot-viewer-v2 inside `selectBotTarget`'s equivalent at `environment-viewer-v2.html:3996-4003`: `const contacts = activeBot.contacts ??= createContactMemory();` then `recordContactSighting(...)` per seen candidate and `markContactsUnseen(...)` for the rest, with an inline comment that literally states parity intent: "Recorded but not yet consumed, same as the harness." In bot-viewer-v2 it's imported (bot-viewer-v2.html:6648-6649), initialized at spawn (:7775), and written every scan inside `selectBotTarget` (:6479-6489), with bot-viewer-v2's own comment at :6474-6478 confirming this per-bot memory is "not yet consumed by anything" there either. **Verdict: identical, write-only scaffolding in both files, not a gap.** One minor real difference: bot-viewer-v2's import also pulls in `contactRecency` (bot-viewer-v2.html:6648) which env-viewer's import (line 79) omits; a repo-wide grep for `contactRecency` in environment-viewer-v2.html returned zero matches, confirming it's genuinely unused there — but since neither file calls it as part of live decision-making anyway (per both files' own comments above), this is inert.

**Real numeric drift: eye height for LOS/aim origin.** bot-viewer-v2 anchors perception at 85% up the capsule (`EYE_LIFT = 0.85`, bot-viewer-v2.html:6652, used :7106-7107). environment-viewer-v2's `botEyeInto` uses the literal capsule top (`capsule.end`, environment-viewer-v2.html:3421) — 100%, no lerp. This is consistent within each file (so likely an intentional port-time simplification tied to a different capsule-height convention), but it is a real difference in where LOS rays and aim originate, and could change edge-case sightline outcomes (e.g. peeking over low cover).

**Not a gap — env-viewer's LOS is more capable, not less.** env-viewer's `botHasLineOfSight`→`resolveHitscan` additionally blocks LOS through terrain, trees, and rocks (environment-viewer-v2.html:3164-3178, 3973, 3987) versus bot-viewer-v2's bare `mapCollider.raycast` (bot-viewer-v2.html:6529, 6546) — an intentional environment-specific richness given env-viewer's real terrain.

**Minor, debug/perf-only gaps** (not correctness-affecting): env-viewer lacks bot-viewer-v2's field-based LOS prefilter inside target scan (bot-viewer-v2.html:6449, 6672, 6677, 9541 — a perf shortcut, not accuracy-affecting per the field's own "errs toward visible" guarantee) and lacks the perceived-enemy POV debug snapshot (bot-viewer-v2.html:4758-4759, 6463-6472).

### 2.3 Combat decision-making

**Orchestrator's initial suspicion resolved as false**: `bot-grenade.js` IS imported by bot-viewer-v2 (bot-viewer-v2.html:116-117, plus call sites at 8974, 9008, 9051) — grenade/rocket AI is fully wired in the reference harness. The earlier concern came from an incomplete first-pass grep, not a real gap.

**Two real behavior regressions found in env-viewer's grenade AI (MEASURED via direct code comparison):**

1. **Lost occlusion-aware self-veto ("corner-cook") gate.** bot-viewer-v2.html:9095-9096 gates the grenade self-pre-veto with a reach+occlusion test (`blastReachesBody(...)`), and its own comment explains this was a deliberate fix: without the reach test the pre-gate "would veto every short throw before the real gate ever saw it, silently undoing the corner-cook the self veto now allows." environment-viewer-v2.html:5954 has exactly the regressed version — distance-only, no occlusion check — so env-viewer bots will refuse legitimate close-range corner-cook throws that bot-viewer-v2 bots take, even though the underlying `chooseGrenadeThrow` (shared, bot-grenade.js:118) is itself occlusion-aware. The pre-gate short-circuits before that logic runs.
2. **Grenade evade hysteresis not wired.** bot-viewer-v2.html:9291 passes `actor.grenadeEvadeId` as a 4th argument to `grenadeEvade(...)` so a bot already fleeing a grenade holds out to the wider `evadeExitScale` exit ring (bot-grenade.js:132-134, 144-145). environment-viewer-v2.html:6062 omits this argument entirely, so `engagedId` is always `null` — a bot near the blast-radius edge can flicker in and out of evade state instead of holding the wider exit ring.

**Shot-spread has an added inaccuracy term and a formula-denominator drift.** environment-viewer-v2.html:5765-5767 adds `inaccuracy01 * BOT_MAX_SPREAD_RAD` (driven by a standalone `botAccuracy` slider, env-viewer-v2.html:2174, 2193) on top of the shared `spreadHalfAngleRad` output — bot-viewer-v2 has no such extra term (it exposes a different, more granular live-tuning panel instead: `baseSpreadDeg`/`bloomPerShotDeg`/toggles, bot-viewer-v2.html:13784-13807). Additionally, the move-speed normalization denominator in the spread formula is stance-conditional in bot-viewer-v2 (bot-viewer-v2.html:10209-10211) but always uses `botMoveSpeed` in env-viewer (environment-viewer-v2.html:5762) — env-viewer's own inline comment acknowledges this: "disabled stance keeps the legacy denominator, bug and all." Net effect: same underlying spread/bloom curve, but env-viewer bots carry an extra independently-tunable inaccuracy source and a known-acknowledged formula quirk that bot-viewer-v2 doesn't have.

**Everything else in combat is identical**: reaction delay, disengage/flee thresholds, pursue break-off streak default (3), knife engage range, fire-gating FSM ladder — all consume the same shared pure modules with unmodified default settings objects. The knife *fire pipeline* differs structurally (direct damage call in A vs. a replicated `applyCombatIntent` path in B) but this is necessitated by env-viewer's multiplayer replication requirement, not a decision-logic fork.

### 2.4 Roles / squads / medic / score

**Role assignment, squad leader election/succession, formation-kind selection, and squad-member-goal steering are all identical**, same shared-module call sites (see table).

**Real behavior gap: medic "last-stride contact creep" is missing in env-viewer.** bot-medic.js:46-47 defines `MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP` — a step that closes the final distance so the medic's hand actually reaches the patient once TEND latches (bot-medic.js comment at 42-45: without it, the medic can stop up to ~1.7m short). bot-viewer-v2 wires this (bot-viewer-v2.html:9928-9934). environment-viewer-v2's `updateMedicTend` (environment-viewer-v2.html:4540-4567) simply zeroes velocity on entering TEND with no contact-closing step — a genuine, unremarked gap, not just an alternate code path.

**CORRECTION (post-review): `bot-score.js` is NOT absent from environment-viewer-v2 either — a second first-pass sub-agent finding, also wrong, also refuted by direct re-verification.** MEASURED directly by the orchestrator: `environment-viewer-v2.html:80-81` imports `createScoreboard, recordSpawn, recordKill, recordRevive, decideRoundOutcome, finishRound, formatRoundHeader, formatTeamScore` from `./bot-score.js` (same early import block as the bot-contacts.js correction above, lines 55-93 — again likely missed because the later bot-brain import block at 95-156 was used as the search anchor). Call sites, all MEASURED: `createScoreboard(BOT_TEAMS)` at :3702, `recordSpawn(botScore, ...)` at :2778 ("opens the next round if one just ended"), `recordKill(botScore, ...)` at :14034, `recordRevive(botScore, ...)` at :4638, `decideRoundOutcome`/`finishRound` at :3731-3732, `formatRoundHeader`/`formatTeamScore` driving the live HUD at :3739, 3741. This is a real, functioning scoreboard/round-outcome system, not a stub.

The only genuine (minor) gap: env-viewer's import list (8 symbols) omits `resetScoreboard`, `formatBreakdownLines`, and `formatRoundLine`, which bot-viewer-v2 imports and uses for a manual "reset scoreboard" button (bot-viewer-v2.html:12942) and a per-cause/weapon kill-breakdown + round-history log export (bot-viewer-v2.html:12973, 12982). So: **core kill/death/round-outcome tracking has parity; env-viewer is missing only the debug-facing reset control and the detailed breakdown/history log UI**, not the scoring logic itself.

**Two symbols missing from env-viewer's import list turned out to be cosmetic-only, not behavioral gaps**: `teamCentroid` (bot-medic.js:123-127) is reimplemented inline in env-viewer as `fleeSquadCentroid()` (environment-viewer-v2.html:5426-5438) with equivalent math via a spatial-hash visitor instead of the pure function — functionally intact, but a second place that can silently drift if the averaging logic changes. `squadSlotWorld` (bot-squad.js:235-247) is called directly in bot-viewer-v2 only for a squad debug-ring visualization (bot-viewer-v2.html:7050-7089); the actual gameplay path (`squadMemberGoal`, imported by both) calls it internally inside bot-squad.js regardless, so gameplay parity is intact — only the debug visualization is missing in env-viewer. `packsTotalHp` (bot-health-packs.js:14) is likewise debug-HUD-only (bot-viewer-v2.html:15581) with no gameplay effect.

### 2.5 Navigation

**Core nav/cover/danger/separation pure logic is shared verbatim** — `nav-grid.js`, `nav-corners.js`, `nav-visibility.js`, `bot-cover.js`, `bot-danger.js`, `bot-entity.js` (which re-exports goal-claims/separation/pushout from `bot-separation.js`) — consumed with matching call-site shapes and frequency in both harnesses (goal claims 1x/frame, separation+pushout 1x/frame, danger-field record sites semantically 1:1 across 7-8 call sites). `bot-separation.js` is not orphaned in either file; both consume it exclusively through `bot-entity.js`'s re-export (confirmed: no direct import of `bot-separation.js` in either file; the only string hits are a profiler bucket label in bot-viewer-v2.html:15667 and a comment in environment-viewer-v2.html:3223).

**`finalizeNavGrid` split is an intentional additive API, not a gap.** `nav-grid.js:20-58`: `buildNavGrid` internally calls `finalizeNavGrid` as its last step (nav-grid.js:44) for one-shot callers. `finalizeNavGrid` is separately exported (nav-grid.js:51) specifically for a caller that fills the grid across multiple frames and only wants the finalize (region-labeling + stranded-region repair) step once — the doc comment at nav-grid.js:47-50 names "environment-viewer-v2's terrain combat-zone grid" as the intended consumer. bot-viewer-v2 never calls `finalizeNavGrid` directly (0 matches) because its maps are small enough to sample synchronously in one call. environment-viewer-v2 uses the split at environment-viewer-v2.html:2504 inside `finishBotZoneBake`, the completion step of a frame-budgeted (`BOT_ZONE_BAKE_BUDGET_MS=3ms`, :2354) sampling loop over a 384m player-anchored persistent zone (`botZoneAnchor`, :2462-2467) — needed because env-viewer's open terrain runs 1200-4000m across and a full-map bake would be infeasible (a 13GB visibility field at 1200m, per the comment at :2340-2350).

**`COVER_ANCHOR_REACH` and `SIGHT_BLOCK_HEIGHT` are genuine env-viewer-specific refinements, not hidden equivalents missing from bot-viewer-v2.** `COVER_ANCHOR_REACH` (bot-cover.js:75, 0.45m "close enough counts as seated") is imported only by env-viewer, which derives `COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6` (environment-viewer-v2.html:5653-5656) with an inline comment explaining that on the terrain-zone grid a cover seat can sit ~1.06m from its anchor — outside the 0.45m band — so it needs a tighter final-approach stop than bot-viewer-v2's authored-arena case required. `SIGHT_BLOCK_HEIGHT` (nav-visibility.js:8, 1.5m) is likewise env-viewer-only, used to filter authored-map primitives and terrain-dressing circles into sight-rects before `buildSightGrid` consumes them (`shootHouseSightRects` :2310-2319, `botTerrainSightRects` :2407-2432) — bot-viewer-v2 doesn't need this because its walls/covers already carry pre-authored `h` (height) values.

**Terrain-aware nav is not bot-viewer-v2-vs-env-viewer binary — bot-viewer-v2 already supports optional slope-costed terrain nav** (bot-viewer-v2.html:7490-7492, `terrainSettings.enabled ? { heightAt: groundHeight, softBlockedTest: navSoftBlocked } : {}`), consistent with the "Open-terrain workspace" memory entry (wall modes, terrain-aware LOS/cover/slope-cost shipped 2026-07-26). The genuine architectural addition in env-viewer is scale/lifecycle, not the concept itself: bot-viewer-v2 bakes one bounded grid synchronously per layout load (~170m arena); env-viewer additionally runs the persistent, anchor-following, incrementally-budgeted zone-bake system described above for its much larger open procedural terrain, and derives its own sight-blocker rects live from terrain dressing/tree indices rather than from a static authored wall list.

**Naming-collision concern resolved as unfounded.** environment-viewer-v2 imports several `nav-grid.js` functions with `bot`-prefixed aliases (`isWalkableCell as botIsWalkableCell`, etc.). A repo-wide check for other modules exporting functions of the same name found none, and no unaliased use of these names elsewhere in the file — the aliasing is a local naming convention (the file has hundreds of `bot*` identifiers), not evidence of a second, divergent nav system.

---

## 3. Ranked list of most significant parity gaps

1. **No population-adaptive think-cadence/render LOD in environment-viewer-v2** (`botThinkStride` / `BOT_RBOX_LOD`, §2.1). Every bot's FSM ticks every frame regardless of population size, with no gear-visual LOD either. This is a scaling/performance risk specifically for env-viewer, which is the harness meant to run in-game (potentially alongside creatures, terrain, and rendering load bot-viewer-v2 doesn't carry) — the exact scenario the "90-bot profile" perf work in bot-viewer-v2 was built to solve, and that fix never crossed over. Re-confirmed by direct orchestrator grep (`botThinkStride`, `BOT_RBOX_LOD`: zero matches in environment-viewer-v2.html).
2. **Grenade AI has two real behavior regressions in env-viewer**: the occlusion-aware corner-cook self-veto is gone (bots refuse valid close throws) and the evade-exit hysteresis argument is dropped (bots can flicker in/out of evade near the blast-radius edge) (§2.3). These are concrete, previously-fixed bugs in bot-viewer-v2 that silently reappeared in the port.
3. **Medic contact-creep step is missing**, so env-viewer medics can stall short of the patient they're trying to revive/heal (§2.4) — a directly observable gameplay bug once medics are exercised in env-viewer. Re-confirmed by direct orchestrator grep (`MEDIC_CONTACT_RADIUS`, `MEDIC_CONTACT_CREEP`: zero matches in environment-viewer-v2.html).
4. **Eye-height origin differs (0.85×capsule vs. capsule.end)** (§2.2) and **shot-spread has an extra inaccuracy term plus a stance-denominator quirk** (§2.3) — both are consistent-but-different numeric formulas, lower severity than the above since they don't change qualitative behavior, but they mean aim/LOS outcomes near edge cases (peeking, moving-while-firing) won't match between harnesses even with identical settings.
5. **Missing manual stance override** (`resolveStanceOverride`, §2.1) — re-confirmed by direct orchestrator grep (zero matches in environment-viewer-v2.html). No manual force-crouch/force-prone path for env-viewer bots.
6. **Scoreboard UI completeness gap**: env-viewer's scoreboard (`bot-score.js`) is fully wired for live kill/death/round tracking, but is missing the manual reset control and the per-cause/weapon breakdown + round-history log that bot-viewer-v2 has (§2.4) — cosmetic/tooling, not a scoring-logic gap.
7. **Squad debug-ring visualization and health-pack HUD strings missing** (§2.1, §2.4) — cosmetic/tooling gaps with no gameplay effect, listed for completeness.

### Correction note (methodology)

Two items originally ranked here — "`bot-contacts.js` per-bot sighting memory entirely unported" and "Scoreboard/round-outcome did not port at all" — were **retracted after direct re-verification found both modules fully imported and wired in environment-viewer-v2** (bot-contacts.js at environment-viewer-v2.html:79, 3996-4003; bot-score.js at :80-81, 2778, 3702, 3731-3732, 3739-3741, 4638, 14034). The originating sub-agents' "zero matches" grep claims were false negatives, most likely because both modules are imported in an early loading block (lines 55-93) outside the later bot-brain-specific import block (95-156) that anchored those agents' searches, combined with the Google Drive mount's known grep-reliability issues noted in the task brief. This is flagged here explicitly per the instruction to distinguish MEASURED from INFERRED: the corrected rows above are MEASURED by direct orchestrator re-grep and Read, superseding the sub-agents' original (incorrect) MEASURED claims. Given this, any remaining "absent" / "zero matches" claim elsewhere in this report that was NOT independently re-verified by the orchestrator should be treated with slightly lower confidence than a claim backed by an actual code excerpt. The orchestrator did independently re-verify (and confirm as still accurate) the `resolveStanceOverride`, `botThinkStride`, `BOT_RBOX_LOD`, `MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP`, `packsTotalHp`, `squadSlotWorld`, `squad-activity.js`, and `bot-separation.js` absence claims (see updated ranked items above and §2.5), so those stand as directly confirmed.

Everything else audited — FOV, split attention, alert escalation, exposure gating, target scoring, reaction delay, disengage/pursue thresholds, knife range, role assignment, squad formation/leader logic, and the entire core navigation/cover/danger/separation pipeline — is either byte-identical (same shared pure module, same call-site shape) or differs only in ways that are intentional and necessitated by environment-viewer-v2's larger, open, terrain-based world (the `finalizeNavGrid` split, `COVER_ANCHOR_REACH`/`SIGHT_BLOCK_HEIGHT` consumption, the persistent terrain-zone bake, and env-viewer's richer terrain-aware LOS).

---

## Orchestrator-measured import blocks (ground truth used to brief the sub-agents)

bot-viewer-v2.html import block A (lines 908-934):
```
import { createBotEntity, stepBotPhysics, toWirePose, resolveBotPairsHashed, separationXZHashed, blendSeparationDir, waypointContestedHashed, createGoalClaims, createBotForensics } from './bot-entity.js';
import { createBotSpatialHash } from './bot-spatial-hash.js';
...
import { makePack, drawFromPacks, hasHealResource, canHold, addPack, packsTotalHp, hasReviveMaterials, consumeRevivePacks, packClaimIntent, packRunSafe } from './bot-health-packs.js';
import { ROLE_MEDIC, ROLE_SQUAD_LEADER, ROLE_SNIPER, ROLE_TECHNICAL, DEFAULT_ROLE, getRole,
  assignRolesToBatch, pickSquadLeader, squadRanks, boundingRole } from './bot-roles.js';
import { SQUAD_MAX_SIZE, SQUAD_MIN_SIZE, SQUAD_DEFAULTS, FORMATION_KINDS, partitionSquadSizes, squadRoleTemplate,
  electSquadLeader, stepSquadSuccession, chooseFormationKind, squadMemberGoal, squadSlotWorld,
  dealSquadChunks, planSquadReconcile, SQUAD_MERGE_RADIUS, formationRanks, formationHalfWidth } from './bot-squad.js';
import { MEDIC_MOVE, MEDIC_TEND, MEDIC_DEFAULTS, decideMedicAction, cohesionTarget, teamCentroid,
  medicChaseSpeedFactor, medicTendRadiusFor, MEDIC_CONTACT_RADIUS, MEDIC_CONTACT_CREEP } from './bot-medic.js';
import { createScoreboard, resetScoreboard, recordSpawn, recordKill, recordRevive, finishRound,
  decideRoundOutcome, formatTeamScore, formatBreakdownLines, formatRoundHeader, formatRoundLine } from './bot-score.js';
import { resolveWeaponHold, carryDeltaFor, locomotionFor, isCarryLocomotion, isOneHanded,
  hasCarryVocabulary, stepCarryBlend, snapCarryBlend, LOCOMOTION_AIM } from './weapon-hold-resolver.js';
import { STANCE_PRONE, STANCE_CROUCH, STANCE_STAND, STANCE_RUN, STANCE_DASH, STANCE_DEFAULTS, chooseBotStance, stepStanceTransition,
  stanceSpeedFactor, stanceSpreadScale, stanceHeightScale, stanceCapsuleHeightScale,
  stanceTurnRateScale, resolveStanceOverride, stepStanceWeights, blendStanceHeightScale } from './bot-stance.js';
import { encodeBotState, changedSlots, describeBotState, healthBand, ammoSlot, packSlot, latchBits, tierSlot,
  STATE_NAMES, STATE_CHARS, TIER_CHARS, SCORE_CHARS, ROLE_CHARS, ELEMENT_CHARS, AMMO_CHARS, HEALTH_CHARS,
  PACK_CHARS, LATCH_CHARS, LATCH_FLEE, LATCH_COVER, LATCH_HEAL_FLEE, illegalReason } from './bot-state-code.js';
```

bot-viewer-v2.html import block B (lines 6609-6649):
```
import {
  BOT_PATROL, BOT_SEEK, BOT_PURSUE, BOT_FLEE, BOT_HEAL, BOT_KNIFE, BOT_AIM, BOT_FIRE, BOT_COVER_MOVE, BOT_COVER_HOLD, SENSE_RANGE, AIM_TOLERANCE_RAD, TURN_RATE_RAD_S,
  chooseBotStateName, aimAnglesTo, aimError, slewAngle,
  stepVisibleDebounce, resetVisibleDebounce, healUnsafeBand,
  spreadAnchor, spreadAnchorRadius, botSeedFromId, SEEK_SPREAD_RING_M, pursueBreakThreshold,
  CLOSE_THREAT_RADIUS, shouldTopOffReload,
} from './bot-activity.js';
import { SIDEARM_DRAW_MS, SIDEARM_LULL_MS, PISTOL_IDS, pickSidearmId, chooseWeaponSlot, outOfAllAmmo } from './bot-sidearm.js';
...
import { buildNavGrid, findPath, smoothPath, lineWalkable, advancePath, floodFill, floodPath, isWalkableCell, worldToCell, cellToWorld, worldToCellInto, cellToWorldInto, regionAt } from './nav-grid.js';
import { investigationRadius, interceptPoint, pincerOffsets, standoffPoint } from './bot-pursuit.js';
import {
  AIM_DEFAULTS, reactionDelayMs, spreadHalfAngleRad, bloomAfterShot, decayBloomDeg, dispersedDirection,
} from './bot-aim.js';
import { buildSightGrid, buildLazyVisibilityField, cellIndexAt } from './nav-visibility.js';
import { buildCornerMap } from './nav-corners.js';
import {
  createPeekCycle, stepPeekCycle, peekPosition, peekAiming, peekExposed, approachXZ, PEEK_APPROACH_SPEED, peekPhaseOffsetS,
  coverCornerValid as coverCornerValidPure, pickCoverCorner,
  stepCoverGate, noteCoverSwitch, coverSwitchAllowed, coverInBand, COVER_PEEK_MISS_LIMIT,
  coverHoldExitReason,
  coverSeatBand, coverCommitTimedOut, createCoverBlacklist, blacklistCover, coverBlacklisted,
  fleePathExposureFromParents, fleeCandidateScore,
} from './bot-cover.js';
import {
  createDangerField, clearDangerField, recordDanger, dangerPenalty, dangerBlocksCover, hasDanger, cellNeighbors8,
  DANGER_DEATH_WEIGHT, DANGER_HIT_WEIGHT, DANGER_FLEE_SCALE, DANGER_PATROL_SCALE, DANGER_PACK_SCALE,
} from './bot-danger.js';
import {
  latestAlertNear, stepAlertHold, alertWindowMs, alertEscalation, tierForScore, exposedToThreat,
  latestNearMiss, latestSelfThreat, shotMissDistance, NEAR_MISS_RADIUS, NEAR_MISS_WINDOW_MS, NEAR_MISS_KIND, alertTierChannels,
  SEMI_ALERT_SHARE_RADIUS, ESCALATION_RADIUS, SEMI_ALERT_WARY_MS,
  ALERT_DEFENSIVE_SCORE, ALERT_PUSH_SCORE, SUPPORT_GROUP_MIN, SUPPORT_RADIUS,
  stepAttention, attentionSweep,
  recordContact, latestContactNear, CONTACT_SHARE_RADIUS,
  patrolScanOffset, sweepPhaseMs, perceptionForTier,
} from './bot-alert.js';
import {
  createContactMemory, recordContactSighting, markContactsUnseen, contactRecency,
} from './bot-contacts.js';
```
Also: bot-viewer-v2 imports `teamSideRegions, generateHomeBase, HOME_BASE_DEFAULTS` from `./bot-structures.js` around line 7267 (out of scope for this report; home-base generation, not bot brain/nav proper).

environment-viewer-v2.html import block (lines 55-215, bot/nav-relevant excerpt):
```
import { botDesignForRole, setBotBodyKind, getBotBodyKind, BOT_BODY_KINDS } from './bot-body-design.js';
...
import { createBotEntity, stepBotPhysics, toWirePose as botToWirePose, createGoalClaims,
  resolveBotPairsHashed, separationXZHashed, waypointContestedHashed, blendSeparationDir } from './bot-entity.js';
import {
  BOT_PATROL, BOT_SEEK, BOT_AIM, BOT_FIRE, SENSE_RANGE as BOT_SENSE_RANGE, TURN_RATE_RAD_S as BOT_TURN_RATE_RAD_S,
  aimAnglesTo, aimError as botAimError, slewAngle, trackStuck as botTrackStuck,
  BOT_PURSUE, BOT_FLEE, BOT_HEAL, BOT_KNIFE, BOT_COVER_MOVE, BOT_COVER_HOLD,
  AIM_TOLERANCE_RAD, CLOSE_THREAT_RADIUS, SEEK_SPREAD_RING_M,
  chooseBotStateName, stepVisibleDebounce, resetVisibleDebounce, healUnsafeBand,
  spreadAnchor, spreadAnchorRadius, botSeedFromId, pursueBreakThreshold, shouldTopOffReload,
} from './bot-activity.js';
import { buildNavGrid, finalizeNavGrid, isWalkableCell as botIsWalkableCell, cellToWorld as botCellToWorld, findPath as botFindPath, smoothPath as botSmoothPath,
  lineWalkable, floodFill, floodPath, advancePath, worldToCell, worldToCellInto, cellToWorldInto, regionAt } from './nav-grid.js';
import {
  AIM_DEFAULTS, reactionDelayMs, spreadHalfAngleRad, bloomAfterShot, decayBloomDeg, dispersedDirection,
} from './bot-aim.js';
import {
  latestAlertNear, stepAlertHold, alertWindowMs, alertEscalation, tierForScore, exposedToThreat,
  latestNearMiss, latestSelfThreat, shotMissDistance, NEAR_MISS_RADIUS, NEAR_MISS_WINDOW_MS, NEAR_MISS_KIND, alertTierChannels,
  SEMI_ALERT_SHARE_RADIUS, ESCALATION_RADIUS, SEMI_ALERT_WARY_MS,
  ALERT_DEFENSIVE_SCORE, ALERT_PUSH_SCORE, SUPPORT_GROUP_MIN, SUPPORT_RADIUS,
  stepAttention, attentionSweep,
  recordContact, latestContactNear, CONTACT_SHARE_RADIUS,
  patrolScanOffset, sweepPhaseMs, perceptionForTier,
} from './bot-alert.js';
import {
  createPeekCycle, stepPeekCycle, peekPosition, peekAiming, peekExposed, approachXZ, PEEK_APPROACH_SPEED, peekPhaseOffsetS,
  coverCornerValid as coverCornerValidPure, pickCoverCorner,
  stepCoverGate, noteCoverSwitch, coverSwitchAllowed, coverInBand, COVER_PEEK_MISS_LIMIT,
  coverHoldExitReason,
  coverSeatBand, COVER_ANCHOR_REACH, coverCommitTimedOut, createCoverBlacklist, blacklistCover, coverBlacklisted,
  fleePathExposureFromParents, fleeCandidateScore,
} from './bot-cover.js';
import {
  createDangerField, clearDangerField, recordDanger, dangerPenalty, dangerBlocksCover, hasDanger, cellNeighbors8,
  DANGER_DEATH_WEIGHT, DANGER_HIT_WEIGHT, DANGER_FLEE_SCALE, DANGER_PATROL_SCALE, DANGER_PACK_SCALE,
} from './bot-danger.js';
import { investigationRadius, interceptPoint, pincerOffsets, standoffPoint } from './bot-pursuit.js';
import { ROLE_MEDIC, ROLE_SNIPER, ROLE_TECHNICAL, ROLE_SQUAD_LEADER, DEFAULT_ROLE, getRole,
  assignRolesToBatch, pickSquadLeader, squadRanks, boundingRole } from './bot-roles.js';
import { MEDIC_MOVE, MEDIC_TEND, MEDIC_DEFAULTS, decideMedicAction, cohesionTarget,
  medicChaseSpeedFactor, medicTendRadiusFor } from './bot-medic.js';
import { makePack, drawFromPacks, hasHealResource, canHold, addPack, hasReviveMaterials,
  consumeRevivePacks, packClaimIntent, packRunSafe } from './bot-health-packs.js';
import { SIDEARM_DRAW_MS, SIDEARM_LULL_MS, PISTOL_IDS, pickSidearmId, chooseWeaponSlot, outOfAllAmmo } from './bot-sidearm.js';
import { STANCE_CROUCH, STANCE_PRONE, STANCE_STAND, STANCE_DEFAULTS, chooseBotStance, stepStanceTransition,
  stanceSpeedFactor, stanceSpreadScale, stanceHeightScale, stanceCapsuleHeightScale,
  stanceTurnRateScale, stepStanceWeights, blendStanceHeightScale } from './bot-stance.js';
import { resolveWeaponHold, carryDeltaFor, locomotionFor, isCarryLocomotion, isOneHanded,
  hasCarryVocabulary, stepCarryBlend, snapCarryBlend, LOCOMOTION_AIM } from './weapon-hold-resolver.js';
import { SQUAD_MAX_SIZE, SQUAD_MIN_SIZE, SQUAD_DEFAULTS, SQUAD_MERGE_RADIUS, FORMATION_KINDS,
  partitionSquadSizes, squadRoleTemplate, electSquadLeader, stepSquadSuccession, chooseFormationKind,
  squadMemberGoal, dealSquadChunks, planSquadReconcile, formationRanks,
  formationHalfWidth } from './bot-squad.js';
import { GRENADE_DEFAULTS, chooseGrenadeThrow, grenadeEvade, throwCountFor } from './bot-grenade.js';
import { solveBallisticArc, sampleArcPoints } from './bot-projectiles.js';
import { createBotSpatialHash } from './bot-spatial-hash.js';
import { buildSightGrid, buildLazyVisibilityField, cellIndexAt, SIGHT_BLOCK_HEIGHT } from './nav-visibility.js';
import { buildCornerMap } from './nav-corners.js';
```
Note (CORRECTED): `squad-activity.js` is confirmed not imported by environment-viewer-v2.html (only inlined/commented references at :3372, :9908 — verified by direct orchestrator grep). `bot-score.js`, however, IS imported — just not in this excerpt: it lives in an earlier module-loading block at environment-viewer-v2.html:80-81 (`import { createContactMemory, recordContactSighting, markContactsUnseen } from './bot-contacts.js';` at :79 and `import { createScoreboard, recordSpawn, recordKill, recordRevive, decideRoundOutcome, finishRound, formatRoundHeader, formatTeamScore } from './bot-score.js';` at :80-81). See the correction notes in §2.2 and §2.4 — the original sub-agent claim that both were absent was wrong and has been corrected throughout this report.
