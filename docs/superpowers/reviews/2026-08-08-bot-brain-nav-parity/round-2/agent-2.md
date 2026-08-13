# Bot Brain & Navigation Parity Audit — Round 2, Agent 2

**Scope:** `bot-viewer-v2.html` (reference/authoritative) vs `environment-viewer-v2.html` (game-side port).
**Source:** frozen snapshot directory (see task); all citations are basenames identical to the live repo.
**Method:** three parallel sub-investigations (FSM/perception/alert, combat/roles/squads, navigation), each independently applying the two-method absence-confirmation rule, then synthesized here. All claims are marked MEASURED (read directly) or INFERRED (deduced without direct confirmation) by the sub-investigators; that marking is preserved below.

---

## Summary table

| Area | bot-viewer-v2 | environment-viewer-v2 | Verdict |
|---|---|---|---|
| FSM states + dispatch | Full ladder (`chooseBotStateName`) + if/else dispatch, allowlist `holding` gate (3 states) | Same ladder, same dispatch (reordered but equivalent), denylist `holding` gate (6 states, extra hold-eligible states) | **Drifted** |
| Manual squad-command system (`commandGoal`, break-contact, double-time, command wheel) | Present, full UI | **Absent entirely** | **Missing from B** |
| Think cadence / stagger (whole-brain LOD) | `botThinkStaggerMode` + `botThinkStride` + Rig LOD | **Absent** (only a stale comment) | **Missing from B** |
| Target-scan stride (narrow throttle) | `TARGET_SCAN_STRIDE=4`, tier-adjustable | Identical | Identical |
| FOV cone | 150° default, tier widening 140/160° | Identical, same math | Identical |
| Eye height | `EYE_LIFT=0.85` fraction (≈1.32 m) | `capsule.end` direct (≈1.5 m, no fraction) | **Drifted** |
| LOS field prefilter (`USE_FIELD_LOS_PREFILTER`) | Present, 3 call sites | **Absent** | **Missing from B** |
| Contact/sighting memory (bot-contacts.js) | Imports `contactRecency` (dead/unused) | Missing `contactRecency` (cosmetic only) | n/a-architectural |
| Alert propagation / escalation tiers | Full 28-symbol import, all constants | Identical import list, identical constants | Identical |
| POV "perceived enemies" debug overlay | Present (`PERCEIVED_ENEMY_MAX=8`) | **Absent** | **Missing from B** |
| Stuck detection / forced replan | **Absent** | Present (`trackStuck`, `BOT_STUCK_FORCE_REPLAN_MS`) | **Missing from A** |
| Aim reaction delay / bloom | Shared bot-aim.js, identical call shape | Identical | Identical |
| Shot spread composition | Stance scale + legacy-denominator quirk when stance disabled | Stance scale **+ extra `botAccuracy` slider term** (`BOT_MAX_SPREAD_RAD=0.15`) | **Drifted** |
| Top-off reload gating during cover-hold | Peek-phase gated + extends concealed hold to cover reload | No peek-phase gate, no hold extension | **Drifted** |
| Sidearm swap (bot-sidearm.js) | Shared, identical constants | Identical | Identical |
| Pursue/disengage (`pursueBreakThreshold`, distances) | `pursueDistance:7.0, pursueExitBuffer:0.6, pursueMissStreak:3` | Identical values, identical call sites | Identical |
| Grenade self-veto pre-gate | Occlusion-aware (`blastReachesBody` in fast pre-gate) | Pre-gate **not** occlusion-aware (accurate gate still is) | **Drifted** |
| Grenade/rocket execution pipeline | `createProjectileManager` (standalone) | Entity-registry (`ProjectileEntity`/`CombatProjectileEntity`/`ExplosionEntity`) | n/a-architectural |
| Melee/knife damage path | Direct `applyCombatDamage` | Routed through `applyCombatIntent`/`validateShot` (replicated hitscan path) | n/a-architectural |
| Roles (medic/squadleader/sniper/technical) descriptors | Shared bot-roles.js table | Identical | Identical |
| Medic tend-in creep (`creepToContact`, `MEDIC_CONTACT_RADIUS/CREEP`) | Present | **Absent** (patient tended from up to ~1.7-2.6 m away) | **Missing from B** |
| Medic squad-centroid flee bias (`teamCentroid`) | Imported from bot-medic.js | Reimplemented inline (`fleeSquadCentroid`) — duplicated, not missing | n/a-architectural (drift-risk noted) |
| Health packs core logic | Shared, identical | Identical (missing only debug-only `packsTotalHp`) | Identical (cosmetic gap only) |
| Squads/formations core movement | Shared bot-squad.js, `SQUAD_MERGE_RADIUS` used identically | Identical (missing only debug-only `squadSlotWorld` direct import) | Identical (cosmetic gap only) |
| Ragdoll / death physics | In-line `stepRagdoll`/`ragdollFromBody`/impulse application | **Not imported**; only forwards `deathImpulse` field, presumably consumed downstream (unverified) | **Missing from B (unverified downstream)** |
| Nav grid build (`buildNavGrid`/`finalizeNavGrid`) | Single-shot bake, `buildNavGrid` only | 3 build paths incl. incremental bake + `finalizeNavGrid` (module-documented, deliberate) | n/a-architectural |
| A*/flood-fill/path-follow tuning constants | ~18 constants read | Same 18 constants, same values | Identical |
| Region labeling / stranded-region repair | Shared `labelRegions`/`connectStrandedRegions` inside `finalizeNavGrid` | Same shared code; console-reporting mechanism differs (`reportNavRegions` vs inline log) | n/a-architectural (reporting-only gap) |
| Goal claims (`createGoalClaims`) | Full claim/release, cleared wholesale on layout change | Same claim/release **plus** live remap across mid-session zone rebake | n/a-architectural (B has an extra capability A doesn't need) |
| Cover/corner maps (bot-cover.js) | 22-symbol import | Same 22 **plus `COVER_ANCHOR_REACH`** (coarse-grid compensation, documented) | **Drifted (justified)** |
| Crest-cover span/far distances | `maxSpan=2 perM, farCells=12 perM` (0.5 m grid) | `BOT_ZONE_CREST_SPAN_M=4.5, FAR_M=24` (1.5 m grid, empirically retuned) | n/a-architectural (documented retune) |
| Separation/pushout (bot-entity.js re-export of bot-separation.js) | Uniform radius via capsule fallback | Explicit radius arg **+ second player-vs-bot pushout pass** | n/a-architectural |
| Slope/danger cost core (bot-danger.js) | Identical import, identical constants | Identical | Identical |
| Danger-field metre/cell normalization | Cell-native (0.5 m grid, no wrapper needed) | `paintDangerPatch` metre-wrapper (documented coarse-grid fix) | n/a-architectural (documented) |
| Terrain-aware nav source | `bot-terrain.js` synthetic hill field | **Not imported at all**; uses real game terrain (`terrain-system.js`/CDLOD) + `collision.js` indices instead | **Missing from B (by design — Phase D replacement, not a gap)** |
| Scattered-structure cover (`bot-structures.js`) | `generateStructures` on open ground | **Not imported at all**, no equivalent — open terrain relies only on natural cover | **Missing from B (genuine capability gap)** |
| Stance selection core (chooseBotStance/scale functions) | Full import incl. `STANCE_RUN`, `STANCE_DASH`, `resolveStanceOverride` | Missing those 3 symbols from import, but run/dash behavior still works (string-keyed internally) | **Drifted (import only; functional impact narrow)** |
| Stance debug override UI | Present (`stanceOverrideBtn`, cycling override) | **Absent** | **Missing from B (debug tooling only)** |

---

## Detailed findings

### A. FSM / Perception / Alert

**FSM dispatch.** Both harnesses call the shared `chooseBotStateName(botState, c)` from `bot-activity.js` at one site each — `bot-viewer-v2.html:10625` vs `environment-viewer-v2.html:6488` — then dispatch on `state ===` branches: `bot-viewer-v2.html:10736-10821` vs `environment-viewer-v2.html:6567-6639`. Branch order differs textually but each guard is mutually exclusive, so this reordering is cosmetic (MEASURED, both blocks read in full).

The stale-looking comment at `environment-viewer-v2.html:105` — `"v2 brain surface (Phase A port; inert until the brain lands)"` — is **misleading**: the code at `environment-viewer-v2.html:3432-3441` documents "Phases A-C-and-a-half are in" and the states are live throughout 1739-6773 (MEASURED). A prior audit's warning about trusting comments over code is directly validated here.

**Genuine drift — `holding` gate:**
```
bot-viewer-v2.html:10678-10679
const holding = activeBotActor.holdUntil > now &&
  (state === BOT_PATROL || state === BOT_SEEK || state === BOT_PURSUE);

environment-viewer-v2.html:6530-6531
const holding = rec.holdUntil > nowMs && state !== BOT_FLEE && state !== BOT_HEAL &&
  state !== BOT_AIM && state !== BOT_FIRE && state !== BOT_COVER_HOLD && state !== BOT_KNIFE;
```
bot-viewer-v2 uses an allowlist of 3 states; environment-viewer-v2 uses a denylist of 6, which additionally treats `BOT_COVER_MOVE` and `'alert'` as hold-eligible. A commanded "hold" freezes a bot mid-cover-approach or mid-alert-hold in environment-viewer-v2 but not in bot-viewer-v2. (MEASURED)

**Missing from B — manual squad-command system.** bot-viewer-v2 has `commandGoal`, `commandTargetId`, `commandBreakContact`, `commandDoubleTime`, `commandGoalState`, `updateCommandMovement`, and a command-wheel UI (`bot-viewer-v2.html:619-711` etc.). None of this exists in environment-viewer-v2 — confirmed by (a) whole-file grep for 6 exact symbol names (0 hits), (b) phrase grep for "break contact"/"double time"/"command wheel"/"squad order"/"point command" (0 hits), (c) direct read of the ctx-build block (`environment-viewer-v2.html:6469-6488`, no `c.orderOverride` assignment) and default dispatch branch (`6634-6637`, no `updateCommandMovement` call). This also makes `bot-activity.js`'s `orderOverride` FSM rung permanently dead code on the B side.

**Missing from B — think-stagger LOD.** bot-viewer-v2 has `botThinkStaggerMode` (`bot-viewer-v2.html:3064`, `'auto'|1|2|3`, URL-overridable), `botThinkStride(livingCount)` (`3128-3129`: off ≤40 bots, /2 ≤80, /3 above), applied at `3364-3370` to throttle the whole `updateBotSentry` decision pass per bot, paired with an independent Rig LOD system (`3069, 3837-3897`). Confirmed absent from environment-viewer-v2 by whole-file grep for `botThinkStaggerMode`/`thinkStride`/`thinkDtAcc`/`botThinkStride`/`rigLod`/`RigLod` (0 hits) and by reading the only related text, a comment at `environment-viewer-v2.html:3529-3532` ("the brain may be think-strided, the capsule is not") that describes a feature with no implementation nearby. **Distinct from** the narrower, present-on-both-sides `TARGET_SCAN_STRIDE=4` (target re-acquisition throttle only, `bot-viewer-v2.html:6405` / `environment-viewer-v2.html:3652`, including tier-adjustable minimum via `perceptionForTier` — identical on both).

**Genuine drift — eye height.** `bot-viewer-v2.html:6652`: `const EYE_LIFT = 0.85;` applied at `7102-7108` as `capsule.start.lerp(capsule.end, EYE_LIFT)`, yielding ≈1.32 m eye height on the shared 1.8 m-standHeight/0.3 m-radius capsule. `environment-viewer-v2.html:3426`: `botEyeInto` returns `capsule.end` directly with no lerp — ≈1.5 m, 0.18 m higher. Confirmed absent by whole-file grep for `EYE_LIFT` (0 hits) and for literal `0.85` (all other hits are unrelated UI/material values, individually inspected). This directly affects aim-ray origin and LOS near partial cover — relevant to the "Head-exposed LOS bug" item already tracked in project memory.

**Missing from B — field LOS prefilter.** `USE_FIELD_LOS_PREFILTER=true` / `fieldSaysHidden()` (`bot-viewer-v2.html:6672, 6677`; used at 5610, 6449, 9541) prune target candidates against the baked visibility field before paying for a raycast. Both symbols are absent from environment-viewer-v2 (0 hits both), and its candidate-filter loop (`environment-viewer-v2.html:3968-3985`) only filters by range + FOV. Primarily a perf/contact-memory divergence, not a can-you-be-shot-at divergence (the final fire-authority raycast is unaffected on both sides).

**Missing from B — POV debug overlay.** `PERCEIVED_ENEMY_MAX=8` (`bot-viewer-v2.html:4758`) drives a debug overlay snapshotting up to 8 in-cone candidates per scan. Confirmed absent from environment-viewer-v2 via whole-file grep (0 hits) and direct read of its target-selection function.

**Identical — alert propagation/escalation.** Both import the exact same 28-symbol list from `bot-alert.js` (`bot-viewer-v2.html:6642-6647` vs `environment-viewer-v2.html:126-133`), with matching call counts for every split-attention/escalation function. Constants `SEMI_ALERT_SHARE_RADIUS=6`, `ESCALATION_RADIUS=18`, `ALERT_DEFENSIVE_SCORE=2`, `ALERT_PUSH_SCORE=4`, `SUPPORT_GROUP_MIN=3`, `SUPPORT_RADIUS=10` (`bot-alert.js:123-129`) are identical by construction on both sides (no local shadowing found).

**Cosmetic-only — contact memory import list.** bot-viewer-v2 imports `contactRecency` in addition to `createContactMemory`/`recordContactSighting`/`markContactsUnseen` (`bot-viewer-v2.html:6647-6649` vs `environment-viewer-v2.html:79`), but `contactRecency` is dead code in bot-viewer-v2 too (grep: exactly 1 hit, the import line itself) — so this import-list difference has zero functional effect.

**Missing from A — stuck detection.** `trackStuck`/`STUCK_MIN_SPEED` (`bot-activity.js:238-247`) is imported and used only by environment-viewer-v2 (aliased `botTrackStuck`, `environment-viewer-v2.html:104`, used at `6774-6776` to force a path replan after `BOT_STUCK_FORCE_REPLAN_MS=3000`). bot-viewer-v2 has zero stuck-detection (confirmed: whole-file grep for `trackStuck` = 0 hits; grep for `stuckSince`/`stuckMs` = 0 hits; the shared-import block `bot-viewer-v2.html:6609-6624` omits it). This is architecturally plausible (env-viewer's open terrain and real mesh collision create more ways to get physically wedged than bot-viewer-v2's small authored maps) but is a genuine one-directional capability.

### B. Combat / Roles / Squads

**Genuine drift — extra accuracy-slider term in shot spread.** bot-viewer-v2's `botShotSpreadRad` (`10204-10217`) composes `spreadHalfAngleRad(...) * stanceSpreadScale(...)`, with a documented "legacy denominator, bug and all" branch when the stance system is disabled. environment-viewer-v2's version (`5822-5831`) composes `(spreadHalfAngleRad(...) + inaccuracy01 * BOT_MAX_SPREAD_RAD) * stanceSpreadScale(...)`, where `inaccuracy01 = 1 - clamp(botAccuracy,0,100)/100` and `BOT_MAX_SPREAD_RAD=0.15` (`environment-viewer-v2.html:2196`) is fed by a UI "Accuracy (%)" slider (`botAccuracy`, default 60, `environment-viewer-v2.html:9764`). Confirmed absent from bot-viewer-v2 by whole-file grep (`BOT_MAX_SPREAD_RAD`/`botAccuracy`, 0 hits) and direct read of its spread function. **This is a real, additive behavioral divergence**, not a cosmetic rename — environment-viewer-v2 bots have a tunable inaccuracy dial bot-viewer-v2 bots don't.

**Genuine drift — top-off reload gating during cover-hold.**
```
bot-viewer-v2.html:10832-10850 (paraphrased):
gated by state !== BOT_KNIFE && botReloadUntil==null && magazineSize>0;
in BOT_COVER_HOLD, only tops off if holdPeek.phase === 'in' (concealed),
then extends the concealed hold: holdPeek.inHoldS = max(holdPeek.inHoldS, holdPeek.t + reloadS)

environment-viewer-v2.html:6648-6652:
gated only by botReloadUntil==null && magazineSize>0 (no BOT_KNIFE check),
no peek-phase gate, no hold extension — calls updateBotReload(nowMs, true) unconditionally
```
A bot in `BOT_COVER_HOLD` mid-peek (exposed) can top off in environment-viewer-v2 without regard to concealment, and its concealed-hold window is never stretched to cover the reload — a hardening present in bot-viewer-v2's comments that did not port. (MEASURED)

**Frame-order drift — `updateBotWeaponSlot`.** bot-viewer-v2 calls it twice per tick (early at `10407`, before FSM dispatch; late at `10831`, to re-decide the slot after this frame's fire empties the mag). environment-viewer-v2 calls it once (`6644`), after fire dispatch — so its slot decision feeding *this* frame's aim/fire is one frame stale relative to bot-viewer-v2. Confirmed via grep counts (2 vs 1 call sites in each file respectively).

**Genuine drift — grenade self-veto pre-gate not occlusion-aware.**
```
bot-viewer-v2.html:9095-9096 (grenadeCandidate fast pre-gate):
if (roughDist + slack <= blastR * selfRadiusScale && blastReachesBody(...)) return null;
// comment: "now occlusion-aware... without the reach test this would veto every short
// throw before the real gate ever saw it, silently undoing the corner-cook"

environment-viewer-v2.html:6017:
if (roughDist + slack <= blastR * selfRadiusScale) return null;   // no blastReachesBody check
```
Both sides pass `blastReaches: blastReachesBody` into the real `chooseGrenadeThrow(...)` call (bot-viewer-v2.html:9119, environment-viewer-v2.html:6041), so the accurate decision is occlusion-aware on both. The bug is narrower: environment-viewer-v2's cheap pre-gate can short-circuit-reject a throw the accurate gate would allow — a bot near its own blast radius behind a corner may refuse to "cook" a grenade around it in environment-viewer-v2 where bot-viewer-v2 correctly allows it. Looks like a fix that landed in A but was never ported to B.

**Architectural, not drift — projectile execution pipeline.** bot-viewer-v2 imports `createProjectileManager` (standalone harness projectile system, `bot-viewer-v2.html:116`); environment-viewer-v2 does NOT import it (confirmed absent, 0 hits + direct import-line read) and instead routes grenades/rockets through the game's entity registry (`ProjectileEntity`, `CombatProjectileEntity`, `ExplosionEntity`/`blastDamageAt`, `EffectEntity` — `environment-viewer-v2.html:71-74`). Grenade *decision* math (`chooseGrenadeThrow`/`grenadeEvade`) is shared and matches; only *execution* differs by design (consistent with the entity-registry migration effort in project memory).

**Architectural, not drift — melee damage path.** bot-viewer-v2's `fireBotKnife` (`10902-10911`) applies damage directly via `applyCombatDamage`. environment-viewer-v2's `fireBotKnife` (`5350-5367`) routes through `applyCombatIntent({action:'gun.fire', weapon:'knife', ...})`, the same intent pipeline used for bullets, with cadence enforced by `validateShot`'s gate rather than a local timer. Both source range/damage/cadence from the shared `getWeapon('knife')` so the numbers themselves can't drift — only the enforcement/replication path differs, by design.

**Identical — sidearm swap.** Same 6-symbol import both sides (`bot-viewer-v2.html:6616` / `environment-viewer-v2.html:145`), same module constants (`SIDEARM_DRAW_MS=550`, `SIDEARM_LULL_MS=2500`, `SIDEARM_CLOSE_HYST=1.4`, `PISTOL_IDS=['m1911','five_seven']`). `inGunfight` computation differs in *data source* only (bot-viewer-v2 uses `lastKnownTargetAt`; environment-viewer-v2 uses a `report` object from the contacts system) but same formula shape — not verified numerically equivalent, flagged INFERRED-parity.

**Identical — pursue/disengage.** `investigationRadius, interceptPoint, pincerOffsets, standoffPoint` imported identically (`bot-viewer-v2.html:6620` / `environment-viewer-v2.html:137`), call sites structurally identical. `pursueBreakThreshold` called identically at two matching sites each. Constants match exactly: `pursueDistance:7.0, pursueExitBuffer:0.6, pursueMissStreak:3` (`bot-viewer-v2.html:7637-7639` / `environment-viewer-v2.html:3582-3584`). Confirmed this is a **different** setting from `healUnsafeBand`/`HEAL_UNSAFE_EXIT_BUFFER=1.5` (also in `bot-activity.js:159-169`, imported identically on both sides) — the two were checked separately per the audit's warning about a prior confusion between them.

**Identical — roles table.** `bot-roles.js` 10-symbol import matches on both sides (different order only). Role descriptors (sniper `sightScale:1.5, closeRange:14, swapOnDryMag:false`; technical `sidearm:'cz_805_bren', bonusGrenades:1, closeRange:10`) are single-sourced. `sightScale`/`swapOnDryMag`/`closeRange` wiring into the sidearm-slot decision is line-identical in shape (`bot-viewer-v2.html:1743,1831-1832` / `environment-viewer-v2.html:3794,3864-3865`).

**Missing from B — medic tend-in creep.** bot-viewer-v2 imports `MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP` in addition to the 8 symbols environment-viewer-v2 also imports (missing `teamCentroid` too — see below). `creepToContact` (`bot-viewer-v2.html:9928-9934`) keeps a medic creeping toward a patient after `MEDIC_TEND` latches (at 1.7 m, or 2.6 m if fleeing) until within `MEDIC_CONTACT_RADIUS=0.85m`, called from `updateMedicTend` (`9944`). environment-viewer-v2's `updateMedicTend` (`4601` onward) has no `creepToContact` call and no equivalent (0 hits for `creepToContact` + direct read of the function). **Real gap**: an environment-viewer-v2 medic treats a patient from wherever it was when the tend threshold crossed (up to ~1.7-2.6 m away) instead of closing the last stride.

**Architectural, drift-risk noted — `teamCentroid`.** bot-viewer-v2 reuses `bot-medic.js`'s `teamCentroid` in two places, including the S9 flee-goal squad-centroid bias (`findFleeGoal`, `bot-viewer-v2.html:8860`). environment-viewer-v2 reimplements this exact feature inline as `fleeSquadCentroid()` (`5487-5501`) rather than importing it — functionally parallel today, but a duplicated-logic drift risk if `teamCentroid`'s edge-case handling changes later without the inline copy following.

**Cosmetic only — `packsTotalHp`, `squadSlotWorld`, scoreboard formatters.** All three are confirmed absent from environment-viewer-v2's imports, but each is used in bot-viewer-v2 *only* inside debug/inspector text (packs-HP readout, squad-debug tether overlay, scoreboard reset/breakdown/round-history panel respectively) — none feed live decision logic. Not behavior gaps.

**Ragdoll/death physics — missing from B, downstream status unverified.** bot-viewer-v2 imports `stepRagdoll`/`kineticEnergy` (ragdoll.js) and `ragdollFromBody`/`applyDeathImpulse`/`applyBlastImpulse`/`weaponKnockback` (ragdoll-body.js) at `915-916`. Confirmed absent from environment-viewer-v2 by whole-file grep for all 6 symbol names (0 hits) and direct read of the full top-of-file import block (36-165). A case-insensitive grep for "ragdoll" turns up only two comments (`4091, 7004`) about forwarding a `deathImpulse` field for a "ghost's death ragdoll," implying the physics may run downstream in `multiplayer.js`/`GhostRenderer` — **not confirmed**, since `multiplayer.js` was not opened in this pass. Flagged as a real gap in the host-side bot-sim file itself; whether it's compensated downstream is unverified.

### C. Navigation

**Architectural, not a gap — `finalizeNavGrid`.** `nav-grid.js:20-58` (read in full): `buildNavGrid` internally calls `finalizeNavGrid` at line 44. The module's own header comment (44-50) states the split exists so "a bake too large to run inside one frame can sample incrementally and finalize once (environment-viewer-v2's terrain combat-zone grid does exactly that)." bot-viewer-v2 imports only `buildNavGrid` (`:6619`, single call site `:7491-7492`, small ~170 m maps bake in one frame). environment-viewer-v2 imports both (`:111-112`) and has three build paths: (1) a single-shot bake for the authored shoot-house map (`:2323`, `BOT_NAV_CELL=0.5`, matching bot-viewer-v2's `NAV_CELL=0.5` exactly), (2) an incremental `stepBotZoneBake`/`finalizeNavGrid` pair for open-terrain combat zones (`:2482-2509`, `BOT_ZONE_BAKE_BUDGET_MS=3ms`/frame), (3) a throwaway local A* window for off-zone queries (`:3328`, `BOT_LOCAL_NAV_RADIUS=18`). `docs/subsystems/bots.md:5976-5979` confirms this is a deliberate anti-drift design ("the two paths cannot drift"). `WALL_MARGIN=0.55` matches `BOT_NAV_WALL_MARGIN=0.55` exactly on both sides.

**Identical — path-follow/replan tuning.** 18 constants compared line-by-line and found identical on both sides, including `NAV_REPATH_COOLDOWN_MS=350`, `SMOOTH_LOOKAHEAD=16`, `SEPARATION_RADIUS=1.5`, `SEPARATION_WEIGHT=0.5`, `SEPARATION_PROBE_M=0.45`, `WAYPOINT_CONTEST_RANGE=0.75`, `WAYPOINT_CONTEST_RELAX=0.45`, `PATROL_STALL_DIST_M=0.35`, `PATROL_STALL_GIVEUP_MS=2500`, `COVER_SEARCH_RADIUS=10`, `ALLY_ALERT_RADIUS=12`, `REPLAN_COOLDOWN_MS=300`, `REPLAN_BUDGET_PER_FRAME=8`, `FLEE_SEARCH_BACKOFF_MS=400`, `FLEE_SQUAD_RADIUS=16`, `COVER_PROBE_BACKOFF_MS=250`, `PATROL_ESCAPE_MS=6000`, `PATROL_ESCAPE_RETRY_MS=8000`, `BOT_RECOVERY_CELL_RADIUS=2`, `fleeSearchRadius=5`. `docs/subsystems/bots.md:6135-6138` documents that cell-denominated radii (`fleeSearchRadius`, `BOT_RECOVERY_CELL_RADIUS`) read differently in real-world metres between the 0.5 m and 1.5 m grid pitches — "left as-is on purpose."

**Missing from A — stuck detection (nav-side confirmation).** Cross-confirms the perception-agent's finding: `trackStuck`/`STUCK_MIN_SPEED` used only in environment-viewer-v2 (`:104, 6774-6782`), layered on top of its own `BOT_STUCK_FORCE_REPLAN_MS=3000` (`:2213`). bot-viewer-v2 relies purely on inline `PATROL_STALL_*`/`PATROL_ESCAPE_*` constants with no speed-tracking helper. INFERRED explanation: env-viewer's open terrain and real mesh collision produce more physical-stuck scenarios than bot-viewer-v2's small hand-authored maps.

**Identical — region labeling/connectivity core**, both `labelRegions` and `connectStrandedRegions` live only in `nav-grid.js:71-204` and run inside `finalizeNavGrid`, used by both build paths on both sides — no reimplementation in either HTML. Reporting mechanism differs: bot-viewer-v2 has a dedicated `reportNavRegions()` (`:7169-7194`, threshold `NAV_REGION_REPORT_MIN=12` cells, called once per `applyLayout()`); environment-viewer-v2 inlines a threshold of `size >= 6` directly in its zone-bake log line (`:2534, 2541`) with no equivalent function, but separately exposes a richer machine-readable `botLiveRegions()` (`:7328-7354`) for a HUD fragmentation readout. Given the differing grid pitches, the "6 vs 12 cells" numbers were not established to represent the same physical area — reported as a numeric difference, not confirmed drift.

**Correction to scope brief — `createGoalClaims` lives in `bot-separation.js`**, not `bot-entity.js` (`bot-separation.js:163-203`); `bot-entity.js:126` re-exports it. Both HTML files correctly import it via the `bot-entity.js` barrel. Claim-kind vocabulary (`'recover'|'seek'|'pursue'|'flee'|'cover'|'pack'`) and release-on-exit sites are structurally identical on both sides (`bot-viewer-v2.html:10721-10723` / `environment-viewer-v2.html:6558-6560`, nearly line-identical).

**One-directional, architecturally necessary — cover-claim remap across live rebake.** environment-viewer-v2 only: `adoptBotNavGrid`'s `remapCoverCorner`/`remapCoverBlacklist` (`:2544-2569`) relocate a bot's committed cover corner/blacklist by world position when the persistent zone grid rebakes mid-session (`BOT_ZONE_REBAKE_DRIFT=96m` player drift trigger, `:2355`). bot-viewer-v2 never rebakes mid-session — `applyLayout()` unconditionally calls `goalClaims.clear()` (`:7493`). Not a gap; A never needs this because its grid is static per session.

**Genuine drift (justified) — `COVER_ANCHOR_REACH`.** environment-viewer-v2 imports and uses it (`:5705`, `COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6`) with an explicit comment (`:5701-5704`) explaining that on the 1.5 m terrain-zone grid a cell center can sit ~1.06 m from the anchor, outside `COVER_ANCHOR_REACH=0.45`, causing bots to park short and eventually blacklist the cover — so a direct-walk-to-anchor tail (`coverAnchorLeg()`, `:5710-5714+`) was added. bot-viewer-v2 has zero references to `COVER_ANCHOR_REACH` (0 hits) because its 0.5 m grid never produces this quantization gap — its own comment at `:5708-5709` says the leg would be "effectively inert" on a 0.5 m grid. This is a documented coarse-grid compensation, not accidental drift, but it is a real behavioral difference (B has a code path A doesn't).

**Genuine, documented retune — crest-cover span/far distances.** bot-viewer-v2 (`:7510-7512`): `minRise:0.6, maxSpan≈2m, farCells≈12m` (0.5 m grid). environment-viewer-v2 zone bake (`:2360-2367, 2524-2526`): `BOT_ZONE_CREST_MIN_RISE=0.6` (matches exactly), but `BOT_ZONE_CREST_SPAN_M=4.5, FAR_M=24` — with a comment citing empirical bench results ("at 2m/12m the bake finds ZERO crests on rugged synthetic terrain, at 4.5m/24m it finds ~100"). The one truly grid-pitch-independent term (`minRise`) matches exactly; the retuned terms are deliberate, not drift.

**Architectural — separation/pushout.** `bot-separation.js` is never imported directly by either HTML (only comment mentions); both go through `bot-entity.js`'s re-export barrel with 1-for-1 identical call counts for `resolveBotPairsHashed`/`separationXZHashed`/`blendSeparationDir`/`waypointContestedHashed`. environment-viewer-v2's `pushBotsApart()` (`:3230-3256`) passes an explicit radius (`maxR + BOT_COLLIDE_PAD*0.5`, `:3238`) where bot-viewer-v2 (`:3382`) passes none, falling back to per-entity capsule radius — documented (`:3226-3236`) as reproducing the old `2r + BOT_COLLIDE_PAD` formula exactly while adding an env-only pad. environment-viewer-v2 additionally runs a second pairwise pushout pass against the local player (`:3242-3255`) — n/a for bot-viewer-v2, which has no player entity.

**Identical — `bot-danger.js` core.** Verbatim identical 12-symbol import on both sides (`bot-viewer-v2.html:6634-6637` / `environment-viewer-v2.html:133-136`). environment-viewer-v2 adds a metre-normalizing wrapper (`paintDangerPatch`, referenced at `:2579`) to correct the death-cell danger-paint footprint for its 1.5 m grid — `docs/subsystems/bots.md:6726-6729` documents the exact scale bug this fixes (0.5 m grid paints a 1.5×1.5 m patch; the same 8-neighbor rule on a 1.5 m grid would paint 4.5×4.5 m without the fix). bot-viewer-v2 doesn't need this since its grid is fixed at 0.5 m.

**Critical, independently confirmed — `bot-terrain.js` and `bot-structures.js` are not imported anywhere in environment-viewer-v2.html**, static or lazy. Method (a): bare-basename grep — `bot-terrain` = 0 matches; `bot-structures` = 1 match, a comment at `:2650` ("bot-structures.js's teamSideRegions bakes in the harness"), not an import. Method (b): grep for every exported symbol from both modules (`BOT_TERRAIN_DEFAULTS`, `createTerrainField`, `footprintRange`, `buildTerrainMeshArrays`, `generateStructures`, `teamSideRegions`, `STRUCTURE_DEFAULTS`, `generateHomeBase`, `HOME_BASE_DEFAULTS`, `generateMazeCells`, `mazeCellWalls`) — only `teamSideRegions` appears once, in that same comment, never as a live binding. Method (c): the full 16-entry `await import(...)` lazy-import list in environment-viewer-v2.html was enumerated in full and neither module appears. **Triple-confirmed absent.**

What environment-viewer-v2 uses instead (Phase D, per `docs/subsystems/bots.md:5917` onward): real game terrain (`terrainHeight(x,z)` via `terrain-system.js`/CDLOD or `mapCollider.raycastDown`) instead of `bot-terrain.js`'s synthetic hill generator; `trunkIndex`/`dressingIndexRef` (from `collision.js`, the same indices the player uses) instead of `bot-terrain.js`'s footprint math; a simple adjacent-cell height-delta slope gate (`BOT_TERRAIN_SLOPE_TOLERANCE=0.9m`, `:2207`, `botTerrainWalkable` at `:2278-2292`) instead of `bot-terrain.js`'s `SLOPE_COST_DEFAULTS` math; sight-blocker rects from live dressing (rocks via `botTerrainSightRects`, `:2409-2434`) plus tree trunks (`botTerrainOccluders`, `:2438-2460`) instead of `bot-structures.js`'s authored generator. Slope-*cost* in the A* itself is still genuinely shared: both grids pass `heightAt` into `buildNavGrid`/`finalizeNavGrid`, so `nav-grid.js`'s own `slopeFactor`/`chordClimb` logic (`SLOPE_COST_DEFAULTS`, `nav-grid.js:8-13`) applies identically on both sides.

**Genuine capability gap — no scattered-structure cover in B.** `bot-structures.js`'s `generateStructures` (scattered buildings/maze-pockets/obstacle-fields as authored cover, `structuresOn=true` default at `bot-viewer-v2.html:7272`) has no equivalent anywhere in environment-viewer-v2 — open terrain there relies solely on natural cover (terrain crests, rocks, trees). `docs/subsystems/bots.md:5578, 5668-5669, 5897-5899` confirms this was a deliberate, tracked deferral: harness-only slope drag and open-terrain cover bakes were explicitly deferred and later solved by the Phase D system above rather than by porting `bot-terrain.js`/`bot-structures.js` verbatim. This is real (not reimplemented elsewhere), but intentional per project docs — flagged as `missing-from-B by design`, not an oversight, though it remains a genuine behavioral capability gap for anyone comparing the two harnesses' cover variety.

**Import gap, narrow functional impact — stance constants.** bot-viewer-v2 imports `STANCE_RUN, STANCE_DASH, resolveStanceOverride` in addition to the 13 symbols both sides share (`:929-931` vs `:146-148`). Confirmed absent from environment-viewer-v2 by grep (`STANCE_RUN|STANCE_DASH` — 2 hits, both inside comments, not live bindings; `resolveStanceOverride|stanceOverride` — 0 hits) plus direct import-block read. However, `chooseBotStance` and the `stance*Factor`/`stance*Scale` functions switch on the stance *string* internally regardless of whether the caller imported the constant bindings, so run/dash speed and spread scaling still function correctly in environment-viewer-v2 by string literal (confirmed live via comments at `:3608, 6545`). What's genuinely missing is `resolveStanceOverride` itself — a debug-only stance-force UI control (`stanceOverrideBtn`, `bot-viewer-v2.html:12782-13132`, cycling Auto→Stand→Crouch→Prone→Run, `BOT_STANCE_OVERRIDES` at `:1085`) with no equivalent anywhere in environment-viewer-v2 (0 hits, both search methods). QA/tuning-tool gap, not a live-behavior gap.

---

## Ranked list of most significant parity gaps

1. **Shot-spread accuracy slider only exists in environment-viewer-v2** (`BOT_MAX_SPREAD_RAD`/`botAccuracy`, environment-viewer-v2.html:5822-5831 vs bot-viewer-v2.html:10204-10217). This directly changes hit-rate tuning between the two harnesses in a way that isn't a simple rename — anyone tuning bot difficulty in one harness and expecting it to transfer to the other will be wrong. High behavioral stakes, low fix cost (either port the term or document it as intentional).

2. **Eye-height convention diverged (0.85 lerp vs raw capsule.end, ≈0.18 m gap).** Affects every aim ray and every LOS check in environment-viewer-v2 relative to bot-viewer-v2, and is directly relevant to the open "Head-exposed LOS bug" tracked in project memory — this is a plausible root-cause candidate, not just a cosmetic difference.

3. **Grenade self-veto pre-gate lost its occlusion-awareness in the port** (environment-viewer-v2.html:6017 vs bot-viewer-v2.html:9095-9096). bot-viewer-v2's comment explicitly frames this as a targeted bugfix ("without the reach test this would veto every short throw... silently undoing the corner-cook"); that fix did not travel to environment-viewer-v2, so the same bug it fixed likely still exists there.

4. **No scattered-structure cover (`bot-structures.js`) and no synthetic terrain-slope system (`bot-terrain.js`) in environment-viewer-v2**, confirmed absent by three independent methods. Mitigated by a real, documented Phase D replacement using actual game terrain/dressing, but open-terrain cover variety is still narrower in B (no authored building/maze-pocket scatter) — a genuine, if intentional, capability gap.

5. **Medic tend-in creep (`creepToContact`) missing from environment-viewer-v2.** A B-side medic can start tending/reviving from up to ~1.7-2.6 m away instead of closing to 0.85 m, which is a visible, easily-reproduced behavioral bug (medic appears to heal at a distance) rather than a subtle numeric drift.

6. **Whole-brain think-stagger/Rig LOD system entirely absent from environment-viewer-v2.** Not a correctness bug, but a real performance-scaling gap: bot-viewer-v2 can throttle full-brain re-evaluation for large rosters (>40/>80 bots); environment-viewer-v2 has no equivalent, so large-roster frame cost in the game viewer is not mitigated the way the reference harness's is.

7. **Manual squad-command system (break-contact, double-time, command wheel) entirely absent from environment-viewer-v2.** This removes a whole category of player/tester-directed squad control that exists in the reference harness — likely intentional (game bots probably shouldn't take player micromanagement commands the same way a test harness does), but worth an explicit decision record if not already made.

8. **Top-off reload during cover-hold isn't peek-phase-gated in environment-viewer-v2**, so a B-side bot can be caught reloading while exposed mid-peek, and its concealed hold is never stretched to cover the reload — a smaller, more situational version of the same "fix didn't travel" pattern as the grenade gap above.

9. **Stuck-detection/forced-replan (`trackStuck`) exists only in environment-viewer-v2, not bot-viewer-v2.** Flagged for completeness (the "opposite direction" the brief asked to weight equally) — this is very plausibly correct as-is (B's open terrain needs it, A's small maps don't), but it does mean testing pathing robustness in the reference harness will never exercise this fallback.

10. **`holding`-gate semantics differ (allowlist of 3 vs denylist of 6 states)**, meaning a commanded "hold" behaves differently near cover-approach and alert states between the two harnesses. Lower severity than the above (holds are typically short/rare), but a real, easily-overlooked FSM-level drift.

---

## Absence claims and how they were confirmed

Every entry below states the claim, then the two independent methods used to confirm it, as required by the audit brief.

| # | Claim | Method 1 | Method 2 |
|---|---|---|---|
| 1 | `fieldSaysHidden`/`USE_FIELD_LOS_PREFILTER` absent from environment-viewer-v2 | Whole-file grep for both symbol names → 0 hits | Direct read of the target-candidate filter loop (env-viewer-v2.html:3968-3985), confirming only range+FOV filtering |
| 2 | `trackStuck`/stuck-detection absent from bot-viewer-v2 | Whole-file grep `trackStuck` → 0 hits; grep `stuckSince`/`stuckMs` → 0 hits | Direct read of the shared bot-activity.js import block (bot-viewer-v2.html:6609-6624) — symbol not present |
| 3 | Manual command system absent from environment-viewer-v2 | Whole-file grep for 6-7 exact symbol names → 0 hits | Phrase grep ("break contact", "double time", "command wheel", etc.) → 0 hits; plus direct read of ctx-build (6469-6488) and dispatch default branch (6634-6637) |
| 4 | Think-stagger/Rig LOD absent from environment-viewer-v2 | Whole-file grep for 6 symbol names (`botThinkStaggerMode`, `thinkStride`, `thinkDtAcc`, `botThinkStride`, `rigLod`, `RigLod`) → 0 hits | Direct read of the one related comment (3529-3532), confirmed to be prose only with no nearby implementation |
| 5 | `SIGHT_BLOCK_HEIGHT` not imported/used by bot-viewer-v2 | Whole-file grep → 0 hits | Direct read of nav-visibility.js import line (bot-viewer-v2.html:6624) — not in list |
| 6 | `PERCEIVED_ENEMY_MAX`/`perceivedEnemies` overlay absent from environment-viewer-v2 | Whole-file grep for both symbols → 0 hits | Direct read of environment-viewer-v2's target-selection function (3968-4030) — no equivalent block |
| 7 | `EYE_LIFT`/0.85 fraction absent from environment-viewer-v2 | Whole-file grep `EYE_LIFT` → 0 hits | Whole-file grep literal `0.85`, all hits individually inspected — all unrelated (UI opacity, volume, weapon sway) |
| 8 | `contactRecency` unused in bot-viewer-v2 despite being imported | Whole-file grep → exactly 1 hit (the import line) | Direct read of the import block confirming that's the only occurrence |
| 9 | `bot-terrain.js` not imported anywhere in environment-viewer-v2 | Bare basename grep → 0 matches | Grep for 4+ exported symbols (`BOT_TERRAIN_DEFAULTS`, `createTerrainField`, `footprintRange`, `buildTerrainMeshArrays`) → 0 matches; plus full enumeration of the 16-entry lazy `await import(...)` list — absent |
| 10 | `bot-structures.js` not imported anywhere in environment-viewer-v2 | Bare basename grep → 1 hit, a comment (line 2650), not an import | Grep for 7 exported symbols (`generateMazeCells`, `mazeCellWalls`, `STRUCTURE_DEFAULTS`, `HOME_BASE_DEFAULTS`, `teamSideRegions`, `generateHomeBase`, `generateStructures`) → only `teamSideRegions` appears, in that same comment, never as a binding; plus lazy-import list check |
| 11 | `bot-separation.js` never imported directly by either HTML | Bare basename grep in both files — bot-viewer-v2: 1 hit inside a profiler-classifier string literal (not an import); environment-viewer-v2: 1 hit in a comment | Direct read of both `bot-entity.js` import blocks confirming separation functions come via the `bot-entity.js` re-export, plus reading bot-entity.js:124-128 confirming the re-export source |
| 12 | `COVER_ANCHOR_REACH` unused in bot-viewer-v2 | Whole-file grep → 0 hits | Direct read of the bot-cover.js import block (6626-6633) — not present, vs environment-viewer-v2's block (125-132) which has it |
| 13 | `resolveStanceOverride`/`STANCE_RUN`/`STANCE_DASH` unused (as bindings) in environment-viewer-v2 | Whole-file grep `resolveStanceOverride|stanceOverride` → 0 hits; grep `STANCE_RUN|STANCE_DASH` → 2 hits, both in comments | Direct read of the bot-stance.js import block (146-148) — absent from the destructured list, vs bot-viewer-v2's (929-931) which has all three |
| 14 | `reportNavRegions`-equivalent console function absent for environment-viewer-v2's shoot-house bake path | Grep `reportNavRegions\|NAV_REGION_REPORT_MIN` → 0 hits | Manual trace of the shoot-house bake call site (2322-2339) end to end — one summary log line, no stranded/sealed-region reporter call |
| 15 | `packsTotalHp` not imported by environment-viewer-v2 | Direct read of import line (143-144) | Whole-file grep → 0 hits |
| 16 | `MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP`/`teamCentroid` not imported by environment-viewer-v2 | Direct read of import line (141-142) | Whole-file grep for all three names → 0 hits |
| 17 | `createProjectileManager` not imported by environment-viewer-v2 | Direct read of import line (158) | Whole-file grep → 0 hits |
| 18 | ragdoll.js/ragdoll-body.js not imported by environment-viewer-v2 | Direct read of the full top-of-file import block (36-165) | Whole-file grep for 6 exported symbol names → 0 hits (plus a separate case-insensitive "ragdoll" grep finding only 2 unrelated comments about a forwarded `deathImpulse` field) |
| 19 | `resetScoreboard`/`formatBreakdownLines`/`formatRoundLine` not imported by environment-viewer-v2 | Direct read of import line (80-81) | Whole-file grep for all three names → 0 hits |
| 20 | `squadSlotWorld` not imported by environment-viewer-v2 | Direct read of import line (153-156) | Whole-file grep → 0 hits |
| 21 | `creepToContact` absent from environment-viewer-v2's `updateMedicTend` | Direct read of the full function (~4601-4620) | Whole-file grep `creepToContact` → 0 hits |
| 22 | `BOT_MAX_SPREAD_RAD`/`botAccuracy` absent from bot-viewer-v2 | Whole-file grep → 0 hits | Direct read of `botShotSpreadRad` (10204-10217) — no such term present |
| 23 | environment-viewer-v2's grenade self-veto pre-gate lacks `blastReachesBody` | Direct read of the pre-gate statement (6017) in full, not truncated | Direct read of the matching bot-viewer-v2 line (9095-9096) for contrast, confirming the token is present there and absent in B |
| 24 | `createSquadDebug` overlay absent from environment-viewer-v2 | Whole-file grep → 0 hits | Cross-checked against the confirmed-absent `squadSlotWorld` import (the only external caller of that function besides bot-squad.js itself) |
| 25 | `SUCCESSION_SHOCK_MS`/`SQUAD_MERGE_MAX`/`DETACHMENT_MIN`/`SQUAD_SPLIT_TOTAL` imported by neither file (symmetric, not a parity gap) | Whole-file grep in bot-viewer-v2.html → 0 hits | Whole-file grep in environment-viewer-v2.html → 0 hits |

---

## Notes on methodology and confidence

- All three sub-investigations were run independently against the same frozen snapshot and cross-checked for consistency; the `trackStuck` absence-from-A / presence-in-B finding was independently reached by both the perception and navigation sub-investigations, which increases confidence in it.
- Two claims are flagged INFERRED rather than MEASURED and should be treated with lower confidence: (a) `inGunfight`'s two data sources (`lastKnownTargetAt` vs a `report` object) were confirmed structurally parallel but not verified numerically equivalent; (b) `planSquadReconcile`'s call-site arguments were not diffed in full on both sides, only confirmed present with a matching base settings object.
- One finding is explicitly unverified: whether environment-viewer-v2's `deathImpulse` field is actually consumed by ragdoll physics downstream (likely in `multiplayer.js`/`GhostRenderer`) was not confirmed, since those files were outside this audit's frozen-snapshot file set / were not opened. This should not be read as "ragdoll physics is missing from the game" — only that it is confirmed missing from `environment-viewer-v2.html` itself, with the downstream question open.
