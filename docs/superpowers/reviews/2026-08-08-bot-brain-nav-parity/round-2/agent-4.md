# Bot Brain / Navigation Parity Audit — Round 2

**A** = `bot-viewer-v2.html` (reference/authoritative bot harness, ~15,699 lines)
**B** = `environment-viewer-v2.html` (game-side viewer the bot system was ported into, ~14,924 lines)

Source: frozen snapshot at
`C:\Users\msankofa\AppData\Local\Temp\claude\...\scratchpad\frozen\` (both HTML files + all `bot-*.js`/`nav-*.js` shared modules + `docs/subsystems/bots.md`, captured at a single instant). All file:line citations use basenames from that snapshot. This audit was produced by four parallel research passes (FSM/perception/alert, combat, roles/squads, navigation), each independently required to confirm every absence claim with two distinct search methods; their findings are synthesized below without re-verification beyond internal consistency checks.

Tags: **MEASURED** = a cited line was actually read. **INFERRED** = deduced from adjacent evidence without directly reading the specific line. Unless stated otherwise, treat citations below as MEASURED by the sub-agent that produced them.

---

## Summary table

| Area | bot-viewer-v2 (A) | environment-viewer-v2 (B) | Verdict |
|---|---|---|---|
| FSM states/transitions | Full ladder in shared `bot-activity.js`; sets `orderOverride` for manual break-contact | Same shared ladder; never sets `orderOverride` — that rung is unreachable | **drifted** (missing-from-B: manual order wiring) |
| Think cadence/staggering | Two layers: adaptive whole-FSM stagger (`botThinkStride`, user-toggleable) + narrower `TARGET_SCAN_STRIDE=4` | Only the narrower `TARGET_SCAN_STRIDE=4`; full FSM (`updateBotSentry`) runs every bot every frame | **missing-from-B** (significant, perf/scale risk) |
| Perception: FOV | `fovDegrees: 150` default, live-tunable slider + 3D debug wedge | Same default (150), no tuning UI | **drifted** (UI-only, expected) |
| Perception: LOS | Cheap field-based prefilter (`fieldSaysHidden`) before expensive raycast in target-confirm loop | No prefilter; goes straight to `resolveHitscan`-based raycast every scan | **missing-from-B** |
| Perception: eye height | Single unified `EYE_LIFT=0.85` fraction for both self-origin and target-aim-point | Split: `botEyeInto` (capsule top, 1.0) for self, `humanAimInto` (midpoint + 0.3·h) for target | **drifted** (real geometric divergence) |
| Target selection & attribution | Identical risk-scoring math (shared); full scoreboard breakdown UI (`formatBreakdownLines`, `formatRoundLine`, `resetScoreboard`) | Same scoring math; scoreboard UI missing those 3 symbols | **drifted** (UI-only) |
| Alert propagation & escalation | Shared `bot-alert.js` tiers/thresholds identical; push/base marker distinction (`POV_ALERT_BADGE`) | Same shared tiers; no push/base marker distinction; has extra `BOT_PUSH_TIER_ENABLED` kill-switch A lacks | **drifted** |
| Split attention | `faceThreatAndAhead`/`faceMovementScanning` via shared `bot-alert.js` | Near-verbatim port, renamed variables only | **identical** |
| Contact/sighting memory | Writes only, unconsumed; cleared on map/layout rebuild (`resetActorMapState`) | Writes only, unconsumed; **not** cleared on respawn (`resetBotBrainState` never touches `.contacts`) | **drifted** (latent, no current behavioral effect) |
| Combat: aim/lead/spread | Shared `bot-aim.js`, `AIM_DEFAULTS` unmodified; no lead prediction | Same shared module/defaults; adds extra `botAccuracy`-driven spread widening (`BOT_MAX_SPREAD_RAD`); no lead prediction either | **drifted** (B adds a difficulty knob) |
| Fire gating | Same gate order; resolves hitscan inline in FSM | Same gate order (+defensive fallback); routes through `applyCombatIntent`/host-authoritative pipeline | **n/a-architectural** |
| Reload | Duration = authored per-weapon reload-animation clip, `BOT_RELOAD_FALLBACK_MS=1800` only as fallback; top-off extends cover-peek hold; excludes `BOT_KNIFE` state | Flat `BOT_RELOAD_MS=1800` for every weapon; top-off has no peek-hold extension, no knife-state exclusion | **drifted** (significant) |
| Sidearm swap | Shared `bot-sidearm.js`, identical constants/logic | Same shared module; adds MP replication call | **identical** (logic) |
| Disengage — pursue/flee range | `pursueDistance:7.0, pursueHealthThreshold01:0.60, fleeDistance:2.2`, etc. | Identical values, all fields | **identical** |
| Disengage — heal-retreat threshold | `threshold01:0.60, resume01:0.72, safeDistance:8.5, safeHoldMs:500, healPerSecond:18` | `threshold01:0.35, resume01:0.85, safeDistance:12, safeHoldMs:900, healPerSecond:22` | **drifted** (significant; breaks a documented shared-module invariant) |
| Grenade/rocket throw | Self-veto pre-gate is occlusion-aware (`blastReachesBody`) | Pre-gate is plain distance check — reintroduces a bug A's own comment says was fixed | **drifted** (significant, real bug) |
| Grenade evade hysteresis | `grenadeEvade(..., actor.grenadeEvadeId)` — 4-arg, hysteresis engages | `grenadeEvade(..., )` — 3-arg call, `engagedId` always null, hysteresis unreachable | **missing-from-B** (significant) |
| Melee/knife trigger | 5-condition gate, `KNIFE_COMMIT_MAX_MS=8000`, `KNIFE_COMMIT_COOLDOWN_MS=5000` | Same 5-condition gate; `KNIFE_COMMIT_MAX_MS=12000`, `COOLDOWN_MS=6000` (undocumented change) | **drifted** |
| Melee/knife hit resolution | No raycast — pure distance+cooldown, always connects in range | Real 2m raycast along facing via `applyCombatIntent`'s `mode==='melee'` branch — can whiff | **drifted** (significant, architecture + behavior) |
| Medic role | `botMedicSettings`: heal 22/s, revive 2500ms/50hp, holdRadius 6.0, claimLease 700ms; `creepToContact` closes final stride; `teamCentroid` from shared module | `botMedicSettings`: heal 26/s, revive 2600ms/45hp, holdRadius 4.5, claimLease **1500ms**; no contact-creep step; independent inline `fleeSquadCentroid` reimplementation | **drifted** (significant) |
| Squadleader / succession | `bot-squad.js` shared, `SUCCESSION_SHOCK_MS=1800` (shared, cannot drift); visual chevron (`setSquadLeaderMark`) | Same shared succession logic; leadership tracked only as non-rendered `isLeader` boolean, no chevron | **drifted** (visual-only) |
| Sniper / technical roles | `ROLE_SNIPER`/`ROLE_TECHNICAL` descriptors shared, cannot drift; default spawn mix 10%/10% | Same shared descriptors; default spawn mix **0%/0%** | **drifted** (default-only) |
| Formations (wedge/column/line/ring) | `bot-squad.js` shared functions, byte-identical call sites | Same shared functions/call sites | **identical** |
| Squad/role visual debug | Role insignia meshes, squad-leader chevron, full `squadDebug` overlay (34 hits) | None of the three exist | **missing-from-B** |
| Nav grid build | Single `buildNavGrid` call, `NAV_CELL=0.5` | `buildNavGrid` (authored maps, `BOT_NAV_CELL=0.5`, matches A) **plus** incremental `finalizeNavGrid`-based 384m terrain-zone bake (`BOT_LOCAL_NAV_CELL=1.5`) A has no equivalent of | **n/a-architectural** (B strictly extends) |
| A*/flood-fill algorithm | Shared `nav-grid.js`, cannot drift | Same shared algorithm; extra `nearestWalkableInGrid` goal-retry fallback A lacks | **missing-from-A** (minor robustness) |
| Region labeling/connectivity | Shared `regionAt`; console `reportNavRegions()` diagnostic (`NAV_REGION_REPORT_MIN=12`) | Same shared `regionAt`; no console diagnostic (still tracks the same data for the debug overlay) | **missing-from-B** (debug-only) |
| Goal claims | `createGoalClaims` via `bot-entity.js` re-export; 6 claim kinds | Same re-export, same 6 kinds; +1 rebake re-claim call for mid-round grid rebase | **identical** (B's extra call is architecturally necessary) |
| Cover/corner maps | `bot-cover.js` shared; one `buildCornerMap` call, crest `maxSpan=4/farCells=24` cells (2m/12m at 0.5m pitch) | Same shared module + `COVER_ANCHOR_REACH` constant; two `buildCornerMap` calls, zone-bake crest retuned to `maxSpan=3/farCells=16` (4.5m/24m at 1.5m pitch), bench-verified | **drifted** (justified, documented) |
| Separation/pushout | Shared hashed pair-resolve, `SEPARATION_RADIUS=1.5`/`WEIGHT=0.5` inline (identical values); applies `terrainSpeedFactor` to path-follow speed | Same shared resolve/constants; **no** `terrainSpeedFactor` equivalent; extra player-pushout pass A has no counterpart for | **drifted** (see slope-cost row) |
| Slope/danger cost (pathing) | `bot-danger.js` shared constants (cannot drift); `nav-grid.js` `SLOPE_COST_DEFAULTS` shared (cannot drift) | Same shared constants; adds hard gate `BOT_TERRAIN_SLOPE_TOLERANCE=0.9` (not a drift of the same constant — different terrain system) | **identical** (routing cost) |
| Slope-based movement speed | `terrainSpeedFactor()`, `SLOPE_SPEED_CLIMB=0.55`, `SLOPE_SPEED_DESCENT=0.12` applied every frame | No equivalent found anywhere; bots move at constant nominal speed regardless of grade | **missing-from-B** (significant, undocumented) |
| Terrain-aware pathing (bot-terrain.js) | Imports `bot-terrain.js` (synthetic noise field) for its standalone maps | Has its own larger open-terrain nav pipeline (Phase D: 384m zone, drift-rebake, frame-budgeted bake) against real game terrain instead | **n/a-architectural** (confirmed clean non-overlap) |
| Stance selection (core) | `chooseBotStance` shared, `STANCE_DEFAULTS` shared (cannot drift) | Same shared function/defaults | **identical** (core logic) |
| Stance manual override | `resolveStanceOverride`, `BOT_STANCE_OVERRIDES` UI dropdown, `doubleTime` command | None of the three imported/present | **missing-from-B** |
| Stuck detection / escape | No equivalent found | Full system: `trackStuck` (shared, A doesn't import it), escalating escape via `nearestWalkable`, teleport fallback, fall-catch (`lastSafePos`) | **missing-from-A** (documented as intentional, "env-specific, stays from v1") |

---

## Detailed findings

### 1. FSM states/transitions

Both viewers import the entire deterministic ladder from the same file, `bot-activity.js` (269 lines, no imports of its own — "Pure, THREE-free decision math"), in a large multiline block ending at `bot-viewer-v2.html:6615` and `environment-viewer-v2.html:110`. Because the ladder body (`chooseBotStateName`) lives in exactly one shared file, its internal transition logic **cannot drift** between viewers by construction — call sites are `bot-viewer-v2.html:10625` and `environment-viewer-v2.html:6488`.

**Import symbol diff (MEASURED):** B additionally imports `trackStuck as botTrackStuck` (`environment-viewer-v2.html:104`), which A does not import at all (see Stuck Detection, §26). Otherwise the symbol lists match: `BOT_PATROL, BOT_SEEK, BOT_PURSUE, BOT_FLEE, BOT_HEAL, BOT_KNIFE, BOT_AIM, BOT_FIRE, BOT_COVER_MOVE, BOT_COVER_HOLD, SENSE_RANGE, AIM_TOLERANCE_RAD, TURN_RATE_RAD_S, chooseBotStateName, aimAnglesTo, aimError, slewAngle, stepVisibleDebounce, resetVisibleDebounce, healUnsafeBand, spreadAnchor, spreadAnchorRadius, botSeedFromId, SEEK_SPREAD_RING_M, pursueBreakThreshold, CLOSE_THREAT_RADIUS, shouldTopOffReload`.

**`orderOverride` — real, confirmed gap.** A sets it explicitly right before the ladder call:

```js
// bot-viewer-v2.html:10615-10617
c.orderOverride = commandBreakContact && !!commandGoal && (activeBotActor.id === commandTargetId ||
    (activeBotActor.squadId != null && activeBotActor.squadId === botActorById.get(commandTargetId)?.squadId));
```

B's equivalent ctx block (`environment-viewer-v2.html:6469-6479`) never sets `c.orderOverride`. Since `bot-activity.js` defaults the field to `false` when absent, nothing crashes — but the "break-contact order pulls the bot out of the firefight-reflex tier back to `BOT_PATROL`" rung (`bot-activity.js:101`) is simply unreachable in B. A has a full manual-order subsystem behind it — right-click move goal, "Break contact" checkbox (`bot-viewer-v2.html:621`), radial-menu spoke (`:711`), `commandDoubleTime` propagation (`:10708-10709`) — none of which exists in B (confirmed via `commandBreakContact`/`commandTargetId`/`commandGoal`/`wheelSpoke(`/`commandMenuCheckbox` all returning 0 hits in B).

### 2. Think cadence / staggering

**A has two independent staggering layers; B has only the narrower one.**

A's whole-FSM stagger (`bot-viewer-v2.html:3064-3069, 3128-3129`):

```js
let botThinkStaggerMode = 'auto'; // 'auto' | 1 | 2 | 3; ?stagger=auto|1|2|3 overrides (A/B runs)
...
function botThinkStride(livingCount) {
  if (botThinkStaggerMode !== 'auto') return botThinkStaggerMode;
```

Applied around the whole per-bot think call (`bot-viewer-v2.html:3341, 3365-3369`):

```js
const thinkStride = botThinkStride(rebuildBotHash().length);
...
if (thinkStride === 1 || actor === focus ||
    (botFrameCounter + (actor.scanPhase ?? 0)) % thinkStride === 0) {
  updateBotSentry(actor.thinkDtAcc, now);
```

It is user-tunable (UI button `bot-viewer-v2.html:12640-12647`, persisted via slots at `:14927`).

B's `updateBotSentry` (`environment-viewer-v2.html:6163`) is called **unconditionally every living bot every frame**, from `botTickOne` (`:6721-6726`), itself called from `updateBots(dt)` with no stride gate. Confirmed absent by (1) bare grep `botThinkStride|botThinkStaggerMode` on B → 0 hits, and (2) reading the actual call chain directly — no wrapping gate exists.

Both share the narrower `TARGET_SCAN_STRIDE = 4` (`bot-viewer-v2.html:6405`, `environment-viewer-v2.html:3652`, identical value), which gates only the candidate re-scan inside target selection, not the whole think pass.

**Net effect**: A can throttle full-brain updates as roster size grows (adaptive, user-toggleable); B always runs the full FSM for every bot every frame — a scale/perf risk with no equivalent knob.

### 3. Perception: FOV, LOS, eye height

**FOV cone** — identical default and math: `fovDegrees: 150` in both (`bot-viewer-v2.html:7648`, `environment-viewer-v2.html:3590`); `withinBotFov` computes the same cone (A via `THREE.MathUtils.degToRad`, B via inline `deg*Math.PI/180`, numerically identical). A additionally has a live-tuning slider (`createBotBehaviorSlider('Field of view (deg)', ...)`, `bot-viewer-v2.html:13738`) and a 3D debug wedge mesh (`fovWedgeGeometry`, `:3565`) — both confirmed absent in B (0 hits each, two separate grep methods).

**Sight distance** — same default (50) on both sides, both role-scaled by the shared `sightScale` field, both user-tunable (A slider range 4–50, B 5–50). No drift.

**LOS raycast prefilter — real gap.** A prunes candidates with a cheap baked-field lookup before running the expensive raycast:

```js
// bot-viewer-v2.html:6449
if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(origin.x, origin.z, targetEye.x, targetEye.z)) continue;
```

Confirmed absent in B by (1) bare grep `fieldSaysHidden` → 0 hits, (2) bare grep `USE_FIELD_LOS_PREFILTER` → 0 hits. B's target-confirm loop goes straight from the FOV check to a real raycast every scan-due frame (`botHasLineOfSight` at `environment-viewer-v2.html:3169-3183`, called at `:4034`). B does use its visibility field extensively elsewhere (cover picking, flee scoring, investigation, alert exposure — 10+ sites) — just not in the target-perception hot path.

**Eye-height / aim-point geometry — real, measured drift.** A uses one function, one fraction, for both self-origin and target-eye:

```js
// bot-viewer-v2.html:6652, 7102-7108
const EYE_LIFT = 0.85; // fraction up the capsule used as eye/muzzle height, both bot and dummy
function eyePos(entity) { return entity.capsule.start.clone().lerp(entity.capsule.end, EYE_LIFT); }
```

B splits it into two functions with two different heights:

```js
// environment-viewer-v2.html:3426-3430
function botEyeInto(entity, out) { out.x = entity.capsule.end.x; ... } // capsule TOP (fraction 1.0)
function humanAimInto(state, out) { out.y = state.p[1] + (state.h ?? 1.6) * 0.3; ... } // midpoint + 0.3h
```

`botEyeInto` (own origin, 8 call sites) uses fraction 1.0; `humanAimInto` (target aim point, 5 call sites) uses an asymmetric midpoint+0.3h formula — neither matches A's uniform 0.85, and the two B-side values don't match each other either. This is a genuine geometric divergence relevant to LOS edge cases and headshot/hitbox alignment between the two viewers, not just a naming difference.

### 4. Target selection & attribution

Core risk-scoring math (`selectBotTarget`) is structurally identical: `TARGET_SCAN_STRIDE=4`, `TARGET_STICK_RISK_MARGIN`, `TARGET_COMMIT_MIN_MS=1500`, `TARGET_RETAIN_MAX_MS=6000` all match. The only functional differences in this area are the eye-height/LOS-prefilter items above, plus B's `_teamEnemyList`/multi-team-including-live-player candidate machinery vs A's single-dummy-target list — an expected structural difference (B is the live multiplayer game; A is a standalone harness), not a bug.

**`bot-score.js` import diff (MEASURED):** A imports 11 symbols (`createScoreboard, resetScoreboard, recordSpawn, recordKill, recordRevive, finishRound, decideRoundOutcome, formatTeamScore, formatBreakdownLines, formatRoundHeader, formatRoundLine`, `bot-viewer-v2.html:925-926`); B imports 8, missing `resetScoreboard, formatBreakdownLines, formatRoundLine` (`environment-viewer-v2.html:80-81`). Confirmed via direct usage grep (not just the import list) that B never calls any of the three. A uses them for a scoreboard-reset button (`:12942`), a per-weapon/cause/role kill-attribution breakdown panel (`:12973`), and a round-history line (`:12982`) — all absent from B. The underlying `recordKill` attribution fields themselves are captured identically by both (shared module), B just never surfaces them in a breakdown UI.

### 5. Alert propagation & escalation

**Shared module** `bot-alert.js` (270 lines) — both import an **identical** symbol list verbatim (`bot-viewer-v2.html:6640-6646` / `environment-viewer-v2.html:118-124`): `latestAlertNear, stepAlertHold, alertWindowMs, alertEscalation, tierForScore, exposedToThreat, latestNearMiss, latestSelfThreat, shotMissDistance, NEAR_MISS_RADIUS, NEAR_MISS_WINDOW_MS, NEAR_MISS_KIND, alertTierChannels, SEMI_ALERT_SHARE_RADIUS, ESCALATION_RADIUS, SEMI_ALERT_WARY_MS, ALERT_DEFENSIVE_SCORE, ALERT_PUSH_SCORE, SUPPORT_GROUP_MIN, SUPPORT_RADIUS, stepAttention, attentionSweep, recordContact, latestContactNear, CONTACT_SHARE_RADIUS, patrolScanOffset, sweepPhaseMs, perceptionForTier`. All tier thresholds (`ALERT_DEFENSIVE_SCORE=2`, `ALERT_PUSH_SCORE=4`, `SUPPORT_GROUP_MIN=3`, `SUPPORT_RADIUS=10`, `SEMI_ALERT_SHARE_RADIUS=6`, `ESCALATION_RADIUS=18`, `SEMI_ALERT_WARY_MS=1500`) live only in this file — **cannot drift**.

**Push/base marker distinction — B-only regression.** A distinguishes a bot on the 'push' vs 'base' (base-of-fire) element in its overhead marker mode:

```js
// bot-viewer-v2.html:10503-10504
activeBotActor.alertMarkMode = alertTier === 'push' ? (activeBotActor.pushElement === 'base' ? 'base' : 'push')
    : alertTier ? (firsthand ? 'seen' : 'heard') : nearMiss ? 'near' : null;
```

B collapses this: `rec.alertMarkMode = alertTier ? (firsthand ? 'seen' : 'heard') : nearMiss ? 'near' : null;` (`environment-viewer-v2.html:6380`) — never distinguishes push from base. A's `POV_ALERT_BADGE` dictionary with distinct `push`/`base` entries (`bot-viewer-v2.html:4611-4613`) is confirmed entirely absent from B (0 hits).

**`BOT_PUSH_TIER_ENABLED` — B-only feature flag**, confirmed absent from A (0 hits): `environment-viewer-v2.html:3629, 6343` gates the push tier behind a runtime flag (currently `true`, so behavior matches today) that A has no equivalent kill-switch for.

### 6. Split attention

Ported essentially verbatim — `faceThreatAndAhead`/`faceMovementScanning` (`bot-viewer-v2.html:9642-9653` vs `environment-viewer-v2.html:5757-5765`) differ only in variable names (`activeBotActor`→`activeBot`, `now`→`nowMs`). All timing constants (`ATTENTION_THREAT_MS=1200`, `ATTENTION_AHEAD_MS=800`, `ATTENTION_SWEEP_MS=2800`, `ATTENTION_SWEEP_RAD=0.95`, `PATROL_SCAN_RAD=0.5`, `PATROL_SCAN_MS=3600`) live only in `bot-alert.js` — cannot drift. No functional difference found.

### 7. Contact / sighting memory

**Shared module** `bot-contacts.js` (54 lines). A imports `createContactMemory, recordContactSighting, markContactsUnseen, contactRecency` (`bot-viewer-v2.html:6647-6649`); B imports the same minus `contactRecency` (`environment-viewer-v2.html:79`). Both viewers' own code comments state the memory is "recorded but not yet consumed" — confirmed by a broad grep (`[a-zA-Z]\.contacts\b|contacts\.get|contacts\.set|contacts\.size`) across both full files, finding only write sites in either. So `contactRecency`'s absence in B has zero behavioral effect today (it's dead code in A too).

**Reset-on-map-change vs never-reset — latent drift.** A's `resetActorMapState(actor)` (triggered on map/layout rebuild, `bot-viewer-v2.html:7391-7399`) explicitly clears `actor.contacts`. B's `resetBotBrainState(rec)` (triggered on respawn, `environment-viewer-v2.html:3547-3577`, read in full) touches ~30 fields but never `rec.contacts`; B also has no `resetActorMapState`-equivalent trigger at all (0 hits for the function name; B's nav grid is built once per map load with no accompanying per-actor reset). Net: stale contact positions persist indefinitely across respawns/map changes in B, though since the memory is currently unconsumed this has no visible effect — flagged as a latent gap for whenever contact memory becomes load-bearing.

### 8. Combat: aim / lead / spread

**Shared module (`bot-aim.js`)** — identical symbol list in both: `AIM_DEFAULTS, reactionDelayMs, spreadHalfAngleRad, bloomAfterShot, decayBloomDeg, dispersedDirection` (`bot-viewer-v2.html:6621-6623`, `environment-viewer-v2.html:113-115`). Both instantiate `{ ...AIM_DEFAULTS }` unmodified (`bot-viewer-v2.html:7655`, `environment-viewer-v2.html:3596`, the latter commented "Harness parity... unmodified and never overwritten"). `updateAimAcquisition` (reaction-delay state machine) is line-for-line identical logic aside from variable renames.

**B adds an extra spread term A lacks:**

```js
// bot-viewer-v2.html:10214-10216 (A)
return spreadHalfAngleRad(_spreadIn, botAimSettings) *
  stanceSpreadScale(activeBotActor?.stance ?? STANCE_STAND, botStanceSettings);

// environment-viewer-v2.html:5828-5831 (B)
const inaccuracy01 = 1 - Math.min(100, Math.max(0, botAccuracy)) / 100;
return (spreadHalfAngleRad(_spreadIn, botAimSettings) + inaccuracy01 * BOT_MAX_SPREAD_RAD)
  * stanceSpreadScale(activeBot?.stance ?? STANCE_STAND, botStanceSettings);
```

B additively widens the cone by an "Accuracy (%)" difficulty slider (`let botAccuracy = 60;` default, `environment-viewer-v2.html:2177`) times `BOT_MAX_SPREAD_RAD = 0.15` (`:2196`). Confirmed A has no `botAccuracy` term at all (0 hits). This is a B-only, game-facing difficulty knob layered on top of the shared cone.

**No bullet-lead prediction anywhere in either viewer** — both aim purely at present position; B explicitly documents this as deliberate ("RPG has no ballistic lead (harness parity): default off", `environment-viewer-v2.html:3607`). The only "lead" concept in either combat AI is grenade-throw's `aimLeadS=0.4` (shared, see §13).

A additionally has live aim-tuning UI (`aimReactionBtn`/`aimSpreadBtn`, `botTuneSyncers`) confirmed entirely absent from B (0 hits each) — expected, since B is the game not a tuning harness.

### 9. Fire gating

Functionally identical gate order:

```js
// A, bot-viewer-v2.html:10413
visible && botAimReady(now) && botReloadUntil == null && !swapping && ammo.mag > 0 &&
  (now - lastShotAt >= currentBotWeapon().fireIntervalMs)

// B, environment-viewer-v2.html:6307-6309
visible && botAimReady(nowMs) && botReloadUntil == null && ammo.mag > 0 && !botSwapping(nowMs) &&
  (nowMs - lastShotAt >= (currentBotWeapon()?.fireIntervalMs ?? 340))
```

Same five gates, same semantics; B adds a defensive `?? 340` fallback A lacks. `fireIntervalMs` lives in `weapons.js` (not in the frozen module set — its contents were not read in this audit, so per-weapon cadence numbers themselves are unverified but structurally shared either way, since both viewers import from the same file).

**Architecture diverges past the gate**: A resolves the hitscan directly inline (`fireBotShot`, `bot-viewer-v2.html:11018`, calls `resolveHitscan` itself). B instead builds a `combat_intent` object and routes it through the host-authoritative `applyCombatIntent` (`environment-viewer-v2.html:5837-5854`, defined at `:14160`), the same path used for the human player and MP replication. This is the expected entity-registry/host-authoritative architecture, not a bug.

### 10. Reload

**Real divergence — duration mechanism.** A derives reload time from the actually-mounted weapon's authored reload-animation clip:

```js
// bot-viewer-v2.html:1474, 1880-1882
const BOT_RELOAD_FALLBACK_MS = 1800;
...
const sequence = botWeaponMount?.weaponId === bot.weapon ? botWeaponMount.reloadSequence : null;
const durationMs = Math.max(1, Math.round((sequence?.duration ?? BOT_RELOAD_FALLBACK_MS / 1000) * 1000));
```

B uses one flat constant for every weapon, with no animation lookup:

```js
// environment-viewer-v2.html:2192, 3878/3883
const BOT_RELOAD_MS = 1800;
...
botReloadUntil = nowMs + BOT_RELOAD_MS;
```

So in B a bolt-action rifle and a pistol reload in the identical 1800ms; in A each weapon's reload duration reflects its authored GLB clip, and 1800ms is only the fallback for missing animation data. Confirmed via full reads of both reload functions; B has no `reloadSequence`/`botWeaponMount` reference anywhere in its reload path.

**Top-off reload — two behavioral omissions in B.** A's top-off gate excludes `BOT_KNIFE` state and, while mid-peek from cover, extends the peek hold to cover the reload's real duration:

```js
// bot-viewer-v2.html:10834-10850 (abridged)
if (state !== BOT_KNIFE && botReloadUntil == null && heldAmmo.magazineSize > 0) {
  ...
  if (holdPeek) {
    const reloadS = (seq?.duration ?? BOT_RELOAD_FALLBACK_MS / 1000) + 0.15;
    ...
    if (peekReloadOk && shouldTopOffReload(_topOff) && reloadBotWeapon(now)) {
      holdPeek.inHoldS = Math.max(holdPeek.inHoldS, holdPeek.t + reloadS);
    }
  } else if (shouldTopOffReload(_topOff)) reloadBotWeapon(now);
}
```

B's equivalent (`environment-viewer-v2.html:6647-6652`) has neither the `BOT_KNIFE` exclusion nor any `holdPeek`-extension logic (0 hits for `holdPeek` anywhere in B). A bot mid-peek in B can start a top-off reload without its peek window being extended to cover it.

### 11. Sidearm swap

Fully shared: `bot-sidearm.js` imported with an identical symbol list (`SIDEARM_DRAW_MS, SIDEARM_LULL_MS, PISTOL_IDS, pickSidearmId, chooseWeaponSlot, outOfAllAmmo`, `bot-viewer-v2.html:6616`, `environment-viewer-v2.html:145`), and all constants (`SIDEARM_DRAW_MS=550, SIDEARM_LULL_MS=2500, SIDEARM_CLOSE_HYST=1.4`) live only in that file — cannot drift. `swapBotWeaponSlot` logic is equivalent in both; B additionally replicates the weapon-in-hand to the MP entity registry (`setPlayerWeapon`/`setPlayerTool`, `environment-viewer-v2.html:3841-3842`), expected given B's networked model. Role-derived swap parameters (`swapOnDryMag`, `closeRange`) come from the shared `bot-roles.js` and cannot drift either.

### 12. Disengage — two distinct thresholds, one identical, one drifted

Per the audit's own warning about conflating these: **pursue/flee-range thresholds** (`botBehaviorSettings`) are identical field-for-field in both: `pursueDistance:7.0, pursueExitBuffer:0.6, pursueMissStreak:3, pursueHealthThreshold01:0.60, fleeStandoffFraction:0.5, fleeDistance:2.2, fleeExitBuffer:0.6, fovDegrees:150, fleeSearchRadius:5, fleeGoalMemory:3, standoffFactor:0.09` (`bot-viewer-v2.html:7636-7650`, `environment-viewer-v2.html:3581-3593`).

**The separate low-HP heal-retreat threshold** (`botHealthSettings`) has diverged substantially:

```js
// A, bot-viewer-v2.html:7656-7664
{ retreatEnabled:true, threshold01:0.60, resume01:0.72, healPerSecond:18, safeDistance:8.5, safeHoldMs:500, retreatSearchRadius:10, coverScore:12 }

// B, environment-viewer-v2.html:3611-3619
{ retreatEnabled:true, threshold01:0.35, resume01:0.85, safeDistance:12, safeHoldMs:900, healPerSecond:22, retreatSearchRadius:10 }
```

A's bots break off to self-heal at ≤60% HP and resume fighting at 72%; B's bots fight on to ≤35% HP before retreating and don't resume until 85%. (`coverScore:12` is not actually dropped in B — it moved to `botBehaviorSettings.coverScore`, `environment-viewer-v2.html:3593`, same value, same downstream consumer.)

**This breaks a documented invariant.** `bot-damage-class.js` (shared, imported identically by both) carries this comment on the `armouredHuman` row:

```js
// bot-damage-class.js:33-36
// Armour takes the hit first... 0.35 sits below botHealthSettings.threshold01 (0.60, the heal-retreat
// trigger), so a bot starts pulling back to heal before it starts visibly bleeding.
bloodThreshold01: 0.35,
```

That invariant (blood-onset 0.35 < heal-retreat 0.60) holds in A but no longer holds in B, where `botHealthSettings.threshold01` is *also* 0.35 — the two thresholds now coincide exactly, so B's armoured bots may begin visibly bleeding at the same instant they decide to retreat, rather than always retreating first as the shared module's own design comment assumes. (The two numbers were both read directly; the "coincide" framing is a straightforward comparison, not a deep inference.)

### 13. Grenade / rocket throw & evade

**Shared module (`bot-grenade.js`)** — identical import list (`GRENADE_DEFAULTS, chooseGrenadeThrow, grenadeEvade, throwCountFor`), both use `{ ...GRENADE_DEFAULTS }` unmodified with no overrides found in either file — so `perBotCount:2, cooldownMs:9000, teamCooldownMs:2500, minRange:8, maxRange:25, aimLeadS:0.4`, etc. are byte-identical.

**Bug reintroduced in B — self-blast pre-veto loses occlusion awareness.** A's pre-gate is occlusion-aware, per its own comment explaining why:

```js
// bot-viewer-v2.html:9091-9097
// Self pre-gate, now occlusion-aware so it keeps the "can only reject what chooseGrenadeThrow would
// also reject" invariant. Without the reach test this would veto every short throw before the real
// gate ever saw it, silently undoing the corner-cook the self veto now allows.
if (roughDist + slack <= blastR * botGrenadeSettings.selfRadiusScale
  && blastReachesBody(_grenadeRoughAim(aimX, aimZ), { cap: bot.capsule })) return null;
```

B's equivalent omits the `blastReachesBody` check entirely:

```js
// environment-viewer-v2.html:6016-6017
if (roughDist + slack <= blastR * botGrenadeSettings.selfRadiusScale) return null;
```

This is exactly the bug A's own comment says was fixed: B will veto a legitimate "corner cook" throw (bot shielded from its own blast by a wall) purely on straight-line distance, before `chooseGrenadeThrow`'s internal correctly-occlusion-aware self-veto is ever reached.

**Evade hysteresis unreachable in B.** `grenadeEvade`'s 4th parameter (`engagedId`) widens the evade-exit ring once a bot is already fleeing a specific grenade, specifically to prevent boundary chatter (`bot-grenade.js:132-134`). A supplies real per-bot state:

```js
// bot-viewer-v2.html:9291
const evade = grenadeEvade(self, _grenadeThreats, botGrenadeSettings, actor.grenadeEvadeId);
```

B calls the same function with only 3 arguments:

```js
// environment-viewer-v2.html:6125
const evade = grenadeEvade(grenadeBodyInto(bot.capsule, _grenadeSelf), _grenadeThreats, botGrenadeSettings);
```

Confirmed absent by (1) bare grep `grenadeEvadeId` → 0 hits in B, (2) counting call-site arguments directly (3 vs A's 4). B tracks a `voiceEvadeId` for dialogue dedup but nothing for the hysteresis math — B bots can chatter in/out of grenade-evade at the blast-radius boundary in a way A's design specifically guards against.

**Projectile management — architectural, not a gap.** A imports `createProjectileManager` from `bot-projectiles.js` for a standalone list-based lifetime manager; B imports only `solveBallisticArc, sampleArcPoints` (confirmed via direct import-line read) and instead spawns grenades/rockets through the game's `entityRegistry`/`CombatProjectileEntity` system (`environment-viewer-v2.html:72, 279, 6050`), the same mechanism used for all other MP-replicated projectiles. B doesn't need `createProjectileManager` because the entity registry already provides equivalent lifetime management.

### 14. Melee / knife

Trigger gate is functionally identical (5 conditions each):

```js
// A, bot-viewer-v2.html:10431
botKnifeSecondaryEnabled && visible && !botHealRequested && botReloadUntil == null && attackerOutOfAmmo && !knifeBlocked

// B, environment-viewer-v2.html:6322-6323
botKnifeSecondaryEnabled && visible && !rec.healRequested && botReloadUntil == null && attackerOutOfAmmo && nowMs >= (rec.knifeBlockUntil ?? 0)
```

**Commit-timeout constants drifted, undocumented:**

```js
// A, bot-viewer-v2.html:6686-6687
const KNIFE_COMMIT_MAX_MS = 8000;   // longest a knife charge may run before it is abandoned
const KNIFE_COMMIT_COOLDOWN_MS = 5000;

// B, environment-viewer-v2.html:3653-3654
const KNIFE_COMMIT_MAX_MS = 12000;
const KNIFE_COMMIT_COOLDOWN_MS = 6000;
```

50% longer charge window, 20% longer subsequent lockout in B, with no comment anywhere in the surrounding lines explaining the change.

**Hit resolution mechanism is fundamentally different.** A resolves a knife strike with pure distance + cooldown, no raycast:

```js
// bot-viewer-v2.html:10902-10909
function fireBotKnife(targetDistance, now) {
  const knife = getWeapon('knife');
  const victim = botTarget;
  if (!knife || !victim?.alive || targetDistance > knife.range || now - lastKnifeAt < knife.fireIntervalMs) return false;
  ...
  applyCombatDamage(knife.damage, eyePos(victim), victim, now, { weaponId: 'knife', cause: 'knife' });
}
```

`applyCombatDamage` itself has no line trace — read in full, it only checks `alive` and applies the damage number. A knife swing that passes range+cooldown **always connects**.

B routes the knife through the same intent pipeline as gunfire, by its own comment:

```js
// environment-viewer-v2.html:5347-5349
// Melee swing: same single fire path as a bullet. applyCombatIntent's mode==='melee' branch skips
// the magazine, resolves the 2 m ray along the bot's current facing and draws spawnMeleeImpact...
```

Confirmed inside `applyCombatIntent` (`:14160-14226`): for `mode==='melee'` it calls `resolveWorldShot({ origin, dir, range: weapon.range, ... })` — a real raycast — then applies damage/impact FX only on a hit. **B's knife can whiff at valid range** if the bot isn't precisely facing the target (e.g. mid-turn); A's cannot miss once in range. This is a genuine behavioral divergence, not cosmetic.

### 15. Medic role

**Shared module import diff (MEASURED).** A: `MEDIC_MOVE, MEDIC_TEND, MEDIC_DEFAULTS, decideMedicAction, cohesionTarget, teamCentroid, medicChaseSpeedFactor, medicTendRadiusFor, MEDIC_CONTACT_RADIUS, MEDIC_CONTACT_CREEP` (`bot-viewer-v2.html:923-924`). B: same minus `teamCentroid, MEDIC_CONTACT_RADIUS, MEDIC_CONTACT_CREEP` (`environment-viewer-v2.html:141-142`).

- `teamCentroid`: A calls it directly (`bot-viewer-v2.html:8860`) inside flee-goal scoring to bias toward the squad centroid. B has an **independently-written inline reimplementation**, `fleeSquadCentroid()` (`environment-viewer-v2.html:5487-5500`) — different variable names, different team-lookup path (`other.botRec?.teamId` vs A's `other.team`), separately maintained code that could drift further from the shared version over time.
- `MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP` (shared values: `0.85`, `0.45`): power A's `creepToContact()` (`bot-viewer-v2.html:9925-9932`), which closes the final ~0.85m stride onto a patient once `MEDIC_TEND` latches. **B has no equivalent call anywhere** (0 hits for both the constants and `creepToContact`) — a medic in B holds at whatever position it was standing at when TEND latched, without closing the last stride onto the patient.

**Tuning constants — every field of `botMedicSettings` drifted:**

```js
// A, bot-viewer-v2.html:7689-7696
{ healAllyPerSecond:22, reviveChannelMs:2500, reviveHp:50, healHoldRadius:6.0, healHoldLeaseMs:500, medicClaimLeaseMs:700 }

// B, environment-viewer-v2.html:3624-3627
{ healAllyPerSecond:26, reviveChannelMs:2600, reviveHp:45, medicClaimLeaseMs:1500, healHoldRadius:4.5, healHoldLeaseMs:700 }
```

Most notably `medicClaimLeaseMs` more than doubles (700→1500ms), meaning a medic's claim on a patient blocks other medics from stealing it for over twice as long in B.

**Self-preservation threshold** (`botHealthSettings`, distinct mechanism — see §12 for the full comparison and why it's not the same number as the teammate-heal threshold above).

**Default spawn mix — sniper/technical.** A ships with `const botRoleMix = { [ROLE_SNIPER]: 10, [ROLE_TECHNICAL]: 10 };` (`bot-viewer-v2.html:7676`) — 10%/10% by default. B initializes `let botSniperPercent = 0; let botTechnicalPercent = 0;` (`environment-viewer-v2.html:3606-3609`) — 0%/0% by default, only medics (20%) spawn until sliders are moved. Both are user-tunable; only the out-of-the-box composition differs.

### 16. Squadleader role, succession, and formations

`bot-squad.js` is imported with an identical symbol list except A additionally imports `squadSlotWorld` (`bot-viewer-v2.html:921-922` vs `environment-viewer-v2.html:153-156`), which is used only inside A's debug-overlay drawing function (`updateSquadDebug`, `bot-viewer-v2.html:7072-7076`) — actual member movement in both viewers goes through `squadMemberGoal`, imported and used identically. `SUCCESSION_SHOCK_MS=1800`, `SQUAD_MAX_SIZE=8`, `SQUAD_MIN_SIZE=2`, `SQUAD_MERGE_RADIUS=20`, and `SQUAD_DEFAULTS` (`spacing:2.4, ringScale:2.5, slotArrive:1.2, leash:22`) all live only in the shared module — cannot drift. `botSquadSettings = { ...SQUAD_DEFAULTS, slotRepath:1.0, corridorProbeMs:300, mergeRadius:SQUAD_MERGE_RADIUS }` is a byte-identical line in both files.

`chooseFormationKind`/`formationOffsetLocal`/`formationRanks`/`formationHalfWidth`/`ringAngleFor` (`bot-squad.js:196-267`) call sites are line-identical in both viewers.

**Note on `squad-activity.js`**: neither viewer imports it (confirmed via both a literal-string grep and an exported-symbol grep, both 0 hits in both files). B's two literal-string hits are comments noting the module was "retired here in Phase C-and-a-half" (`environment-viewer-v2.html:3372, 9908`) — B copy-pasted one unrelated function (`pickExploreGoal`) from it for patrol goal-picking, not for squad formations. Both viewers exclusively use `bot-squad.js` for squads/formations. `docs/subsystems/bots.md:1524` corroborates that `squad-activity.js` is v1-only (the older `bot-viewer.html`, not in scope here).

**Visual/debug system — entirely A-only.** Role insignia meshes (11 hits in A, 0 in B, confirmed by a second search for alternative names — 0 hits), squad-leader chevron (`setSquadLeaderMark`, 8 hits in A, 0 in B), and the full squad-debug overlay (`squadDebug`, 34 hits in A — ring markers, slot markers, tethers, leaderless-countdown label — 0 hits in B) are all confirmed entirely absent from B. B tracks leadership only as a non-rendered `isLeader` boolean, consumed by debug HUD text and role bookkeeping, never drawn in the 3D scene.

### 17–18. Nav grid build, A*/flood-fill

Both import `buildNavGrid` from `nav-grid.js`; the actual A*/flood-fill/smoothing algorithm code is one shared file, so it **cannot drift** at the algorithm level (`findPath, smoothPath, floodFill, floodPath, advancePath, lineWalkable` all shared). `SMOOTH_LOOKAHEAD=16`, `NAV_REPATH_COOLDOWN_MS=350`, `SEPARATION_PROBE_M=0.45` are identical inline values on both sides.

**B additionally imports `finalizeNavGrid`** (`environment-viewer-v2.html:2506` inside `finishBotZoneBake`), confirmed absent from A (0 hits, second method: checked the full import block directly). B samples a large persistent terrain-combat-zone grid incrementally across multiple frames (`BOT_ZONE_BAKE_BUDGET_MS=3`) then finalizes it once, versus A's single atomic `buildNavGrid` call — this is B extending the shared module for a capability (large open-world terrain) A's small fixed maze maps never needed.

**Grid cell size**: A: `NAV_CELL=0.5` (one grid). B has three grids at different pitches: `BOT_NAV_CELL=0.5` for authored/shoot-house maps (matches A exactly), `BOT_LOCAL_NAV_CELL=1.5` for a throwaway per-bot local window, and `BOT_ZONE_CELL=1.5` for the persistent terrain zone.

**Path-request robustness — B extends, A lacks the fallback.** B's `requestBotPath` (`environment-viewer-v2.html:3266`) retries against `nearestWalkableInGrid` when a direct path fails, in both its zone and local-window branches. A's `requestPath` (`bot-viewer-v2.html:8034-8043`) has no equivalent whole-goal retarget-to-nearest-walkable retry (confirmed 0 hits for `nearestWalkableInGrid` in A — A only uses nav-grid's internal single-cell snap, not a call-site-level retry).

**Slope cost** (`SLOPE_COST_DEFAULTS`, shared: `up:1.8, down:0.6, maxFactor:6, smoothMaxRise:0.6`) is not overridden by either viewer at any `buildNavGrid`/`finalizeNavGrid` call site — shared, cannot drift.

### 19. Region labeling / connectivity

`regionAt` is imported identically by both and used in structurally identical patterns for foraging/escape region-match checks. Both viewers also carry a byte-for-byte identical "live region overlay" encoder function (rank-order byte packing for a debug viewer) — `bot-viewer-v2.html:3205-3221` and `environment-viewer-v2.html:7331-7353` match line-for-line including the exact packing formula.

**B lacks A's console diagnostic.** A has `reportNavRegions()` (`bot-viewer-v2.html:7169-7194`), gated by `NAV_REGION_REPORT_MIN=12`, which `console.info`/`console.warn`s carved-cell counts and sealed-pocket/stranded-area totals whenever the nav grid rebuilds. Confirmed absent in B by two methods: literal warning-string grep (0 hits) and `NAV_REGION_REPORT_MIN` grep (0 hits). B still tracks the same underlying data (used by the identical live-overlay encoder above) — it's just never surfaced to the console, only to the separate debug-world overlay.

### 20. Goal claims

`createGoalClaims` is not a standalone import in either viewer — both get it from `bot-entity.js`'s re-export (`export { ..., createGoalClaims } from './bot-separation.js';`, `bot-entity.js:126`), confirmed by checking that a direct `bot-separation.js` import string appears only in comments in both files. Both instantiate one `goalClaims` at module scope with an equivalent alive-check predicate (styled differently to match each viewer's combat-state architecture) and use the identical 6 claim kinds (`recover, seek, pursue, flee, cover, pack`) at matching call-site counts.

B has one extra claim call inside its terrain-zone rebake handler (`environment-viewer-v2.html:2600`) to replant cover claims against a rebaked grid when the persistent zone drifts — architecturally necessary because B's zone grid can rebake mid-round (`BOT_ZONE_REBAKE_DRIFT=96`) while A's static per-layout grid never does. Not a functional gap.

### 21. Cover / corner maps

`bot-cover.js` import lists match except B additionally imports `COVER_ANCHOR_REACH` (value `0.45`, `bot-cover.js:75`), which B uses to derive `COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6` (`environment-viewer-v2.html:5705`) — justified by comment: B's coarser 1.5m terrain-zone grid can snap a corner up to ~1.06m from its true anchor, outside the fine-grid harness's 0.45m seat band, so B derives its own final-approach-stop from the same shared constant. The constant's *value* is shared and cannot drift; only its downstream use differs.

**`buildCornerMap` call count and crest tuning differ, but the difference is bench-verified and documented.** A has one call (`bot-viewer-v2.html:7508-7513`) with crest params `minRise:0.6, maxSpan:4 cells, farCells:24 cells` (at `NAV_CELL=0.5`, i.e. 2m/12m). B has two calls: an authored-map call with no crest options (flat maps need none), and a terrain-zone call (`environment-viewer-v2.html:2520-2528`) with `minRise:0.6` (identical) but `maxSpan:3 cells, farCells:16 cells` (at `BOT_ZONE_CELL=1.5`, i.e. 4.5m/24m). B's own comment (`:2361-2365`) states this retuning is deliberate and bench-verified (`bench-bot-nav.mjs --crest`): A's harness-authored 2m/12m values find **zero crests** on B's rugged open terrain at the coarser pitch, while 4.5m/24m finds ~100. The `minRise` requirement itself is preserved exactly; only the metre-space span/far values were re-tuned out of necessity.

### 22. Separation / pushout

Neither viewer imports `bot-separation.js` directly — both get its functions via `bot-entity.js`'s re-export, so the pushout/separation algorithm code itself is one shared file and cannot drift. `SEPARATION_RADIUS=1.5` and `SEPARATION_WEIGHT=0.5` are independently-declared inline constants with identical values on both sides.

One real difference inside the (structurally near-identical) `followPath` speed calculation: A multiplies the crowd-adjusted speed by `terrainSpeedFactor(p, mx, mz)` (`bot-viewer-v2.html:8005`); B's equivalent line has no such multiplier (`environment-viewer-v2.html:4767`) — see §23.

`resolveBotPairsHashed` (bot-bot pushout) is called with an implicit radius in A vs an explicit `maxR + BOT_COLLIDE_PAD*0.5` in B; B's own comment explains this reproduces A's result exactly while adding a small pad, because B also runs a second local-player pushout pass (`pushBotsApart`) A has no counterpart for (A's harness has no player entity). Documented, deliberate, not drift.

### 23. Slope / danger cost

**Danger memory** (`bot-danger.js`) is imported with a byte-identical 12-symbol list by both, so `DANGER_DEATH_WEIGHT`, `DANGER_HIT_WEIGHT`, `DANGER_FLEE_SCALE=6`, `DANGER_PATROL_SCALE=4`, `DANGER_PACK_SCALE=3` cannot drift; usage sites (flee/patrol/pack scoring, cover-corner veto with an identical `0.35` threshold on both sides) are structurally identical.

**Real, confirmed gap — B has no per-frame slope-based movement-speed modulation.** A defines and applies:

```js
// bot-viewer-v2.html:8017-8025
const SLOPE_SPEED_CLIMB = 0.55;
const SLOPE_SPEED_DESCENT = 0.12;
function terrainSpeedFactor(p, mx, mz) {
  if (!terrainSettings.enabled) return 1;
  const g = terrainField.gradientAt(p.x, p.z, 0.35);
  const grade = g.dx * mx + g.dz * mz;
  const f = grade >= 0 ? 1 - SLOPE_SPEED_CLIMB * grade : 1 + SLOPE_SPEED_DESCENT * -grade;
  return f < 0.4 ? 0.4 : f > 1.15 ? 1.15 : f;
}
```

applied to every path-following bot's speed. Confirmed absent in B by two methods: `grep "terrainSpeedFactor"` → 0 hits, `grep "SLOPE_SPEED_CLIMB|SLOPE_SPEED_DESCENT"` → 0 hits. B's bots move at constant nominal speed regardless of local terrain gradient during path-following — slope only affects pathfinding *cost* (routing) and the hard walkability gate (`BOT_TERRAIN_SLOPE_TOLERANCE=0.9`), never real-time locomotion speed. No comment near B's `followPath` speed line explains this as an intentional omission — it reads as an unintentional gap rather than a documented architectural choice.

**`BOT_TERRAIN_SLOPE_TOLERANCE=0.9` (B) vs `BOT_TERRAIN_DEFAULTS.maxSlope=0.85` (A, `bot-terrain.js:32`)** are NOT the same constant being compared — they gate two different, independently-authored terrain systems (B: real game terrain via `terrainHeight`; A: bot-terrain.js's own synthetic noise field). Not a drift claim; flagged only to note the two numbers are superficially similar but not comparable.

### 24. Terrain-aware pathing (bot-terrain.js)

**Confirmed A-only, architectural, not a gap.** `bot-terrain.js` is imported only by A (`bot-viewer-v2.html:810`), confirmed absent from B by two methods (import-string grep and bare-basename grep, both 0 in B). B has its own considerably larger open-terrain nav pipeline ("Phase D") built directly on `nav-grid.js`'s `heightAt`/slope-cost machinery against real game terrain, including a 384m persistent zone grid, drift-triggered rebakes, frame-budgeted incremental sampling, and a throwaway local-window fallback — none of which A's small fixed maze maps need.

**Minor, plausibly-by-design gap flagged but not fully resolved:** `footprintRange` (`bot-terrain.js:932`), used by A to sink procedurally-generated wall/cover boxes into its synthetic terrain (`boxTransformOnTerrain`, `bot-viewer-v2.html:835`), has no equivalent in B (0 hits for both the symbol and the calling function). Plausible explanation: B's cover geometry on real maps comes from authored map primitives already seated by the level author, not runtime-generated boxes needing terrain-conforming placement. This was **not fully verified** — confirming it would require reading `shoot-house-layout.js`/`terrain-system.js` in full, which was out of the navigation agent's assigned module scope. Flagged as an open question, not a closed finding.

### 25. Stance selection

Core function `chooseBotStance(state, sc, botStanceSettings)` is shared and called with structurally identical context-object construction in both (`bot-viewer-v2.html:10710`, `environment-viewer-v2.html:6549`) — `STANCE_DEFAULTS` (`crouchSpeedFactor:0.55, proneSpeedFactor:0.30, standUpMs:700, crouchUpMs:220, proneMinHoldMs:1200`, etc.) lives only in the shared module and neither viewer was found overriding it, so these values cannot drift (not independently re-verified whether either side clones+mutates `botStanceSettings` post-construction — flagged as unverified rather than asserted clean).

**Real, confirmed gap — manual override missing in B.** A ends its per-frame stance resolve with:

```js
// bot-viewer-v2.html:10714
activeBotActor.stance = resolveStanceOverride(botStanceOverride, autoStance);
```

backed by a UI dropdown `const BOT_STANCE_OVERRIDES = ['auto', STANCE_STAND, STANCE_CROUCH, STANCE_PRONE, STANCE_RUN, STANCE_DASH];` (`bot-viewer-v2.html:1085`). B's equivalent line (`environment-viewer-v2.html:6551`) never calls `resolveStanceOverride` (0 hits anywhere in B; A's import block includes it, B's does not) — B's bots' stance is always fully automatic, with no way to force crouch/prone/run/dash from the UI. `chooseBotStance` itself can still internally return `STANCE_DASH`/`STANCE_RUN` regardless of whether the caller imports the named constant, so automatic evade-dash/pursue-run behavior is not broken in B — only manual override capability is missing.

A also sets `sc.doubleTime` from a "Double time" UI checkbox (`bot-viewer-v2.html:620, 10708`), driving `chooseBotStance`'s `if (state==='patrol' && doubleTime) return STANCE_RUN;` branch (`bot-stance.js:104`). Confirmed absent from B (0 hits for `doubleTime` anywhere in the file) — B has no squad-wide "double time" patrol-speed command at all.

### 26. Stuck detection

**Major asymmetry, opposite direction from most other findings: B has a full system A completely lacks.** B imports `trackStuck as botTrackStuck` from the shared `bot-activity.js` (`environment-viewer-v2.html:104`); A's import of the same file (`bot-viewer-v2.html:6615` block) does not include it. Confirmed absent from A by two methods: bare `trackStuck` grep (0 hits) and a broader case-insensitive `stuck` grep (5 hits, all unrelated comments/UI labels describing bot-entity.js's separate floor-rescue mechanism).

B's usage (`environment-viewer-v2.html:6774-6787`) feeds movement speed and a `moving` flag into `botTrackStuck`, and once stuck duration exceeds `BOT_STUCK_FORCE_REPLAN_MS=3000` forces a repath. Beyond that, B has an escalating escape mechanism entirely its own: once `pathFailCount`/`stuckReplanCount` reach `BOT_STUCK_ESCAPE_RETRIES=6`, the bot steers for `botNearestWalkableToBot`, and after `BOT_ESCAPE_TIMEOUT_MS=4000` with no progress it is teleported to the escape target as a last resort; a companion fall-catch system (`BOT_FALL_CATCH_DROP_M=12`, `rec.lastSafePos`) recovers bots that fall through collision-mesh gaps. Confirmed absent from A: `pathFailCount` (0 hits), `lastSafePos` (0 hits).

B's own code comment states this is a deliberate, inherited design choice, not an oversight: *"stepBotPhysics, the fall catch and the stuck/escape machinery are env-specific and stay from v1."* (`environment-viewer-v2.html:6722`). This makes sense given B runs on open/procedural terrain with real fall risk that A's fixed small maze/arena maps never present.

---

## Ranked list of most significant parity gaps

1. **Heal-retreat threshold divergence (§12)** — A's bots break off to self-heal at 60% HP and resume at 72%; B's fight to 35% HP and don't resume until 85%. This is a first-order combat-behavior difference (how aggressively bots preserve themselves) and it also breaks a documented invariant in the shared `bot-damage-class.js` (blood-onset threshold no longer strictly precedes heal-retreat in B). Matters because anyone tuning "bot toughness" or "bot self-preservation feel" in one viewer will not see the same feel in the other.

2. **Melee hit-resolution mechanism (§14)** — A's knife never misses once in range (pure distance+cooldown); B's routes through a real facing-dependent raycast and can whiff. Combined with the undocumented commit-timeout drift (8s/5s vs 12s/6s), this means knife combat *feels* different between the two viewers in a way that isn't a tuning knob, it's a different algorithm.

3. **Grenade self-veto occlusion regression (§13)** — B's pre-gate reintroduces a bug A's own code comment says was already fixed (vetoing legitimate corner-cook throws by raw distance instead of occlusion-aware reach). This is the clearest case of a real regression versus the reference implementation, not an intentional divergence.

4. **Grenade evade hysteresis unreachable in B (§13)** — the 4th-argument `engagedId` that prevents boundary-chatter is never passed in B, so B bots can flicker in/out of evade state at the blast-radius edge, a bug class A's design specifically engineered against.

5. **Reload duration mechanism (§10)** — A's per-weapon animation-derived reload vs B's flat 1800ms-for-everything is a meaningful gameplay-pacing difference (pistol and bolt-action reload identically fast/slow in B), plus B drops the cover-peek hold-extension and `BOT_KNIFE` exclusion during top-off.

6. **Think-cadence staggering entirely absent in B (§2)** — A can adaptively throttle full-FSM updates as bot count grows and expose it as a perf knob; B always runs every bot's full brain every frame. This is primarily a scale/performance risk (large bot counts in the live game with no throttle), not a correctness bug, but it's the single biggest architectural capability gap found.

7. **Eye-height/aim-point geometry split in B (§3)** — A uses one uniform 0.85 fraction for both self and target; B uses two different, mutually-inconsistent formulas (capsule-top for self, midpoint+0.3h for target). Affects LOS/headshot edge-case parity in ways that are easy to miss because both "work" most of the time.

8. **Medic behavioral drift (§15)** — every numeric field of `botMedicSettings` differs, the claim-lease timeout more than doubles (700→1500ms), and B is missing the final-stride contact-creep step entirely (B medics can visually stop short of the patient they're healing).

9. **Slope-based movement speed modulation missing from B (§23)** — A's bots slow climbing/speed up descending in real time; B's don't, despite B having its own (larger) open-terrain system that would benefit from exactly this. No comment suggests this was intentional.

10. **LOS field-based prefilter missing from B's target-perception path (§3)** — mainly a performance concern (B always pays for a full raycast where A can cheaply prune first), but worth flagging since B's terrain is larger/more complex than A's maze maps, making the missing optimization more costly there, not less.

Lower-priority items not in the top 10 but worth tracking: manual command/order system (`orderOverride`, break-contact, double-time) entirely absent from B (§1, §25); squad/role visual markers and debug overlay entirely absent from B (§16, cosmetic/debuggability only); default sniper/technical spawn mix 10%/10% (A) vs 0%/0% (B) (§15); B's stuck-detection/escape/fall-catch system entirely absent from A (§26, but explicitly documented as intentional).

---

## Absence claims and how they were confirmed

Each row: claim, method 1, method 2, verdict. All were performed independently by the sub-agent responsible for that area; see the section number in parentheses for detailed context.

| # | Claim | Method 1 | Method 2 | Verdict |
|---|---|---|---|---|
| 1 (§1) | A never sets `c.orderOverride` before calling `chooseBotStateName` | bare grep `orderOverride` on B → 0 | bare grep `commandBreakContact\|commandTargetId\|commandGoal` on B → 0; third sweep `wheelSpoke(\|commandMenuCheckbox\|Break contact\|doubleTime` on B → 0 | Confirmed absent from B |
| 2 (§2) | A has no `trackStuck`/stuck-detection | bare grep `trackStuck` on A → 0 | case-insensitive grep `stuck` on A → 5 hits, all unrelated comments/labels | Confirmed absent from A |
| 3 (§2) | B has no full-FSM think-stagger (`botThinkStride`) | bare grep `botThinkStride\|botThinkStaggerMode` on B → 0 | read `botTickOne`/`updateBots` call chain directly — no stride gate around `updateBotSentry` | Confirmed absent from B |
| 4 (§3) | A has no FOV tuning UI / debug wedge | bare grep `createBotBehaviorSlider` scoped to FOV on B → 0 | bare grep `fovWedge` and literal text `Field of view` on B → 0 | Confirmed absent from B |
| 5 (§3) | B has no baked-field LOS prefilter (`fieldSaysHidden`) in target perception | bare grep `fieldSaysHidden` on B → 0 | bare grep `USE_FIELD_LOS_PREFILTER` on B → 0; read `selectBotTarget`'s ray-confirm loop directly, raw `resolveHitscan` call with no prior field check | Confirmed absent from B |
| 6 (§4) | B's `bot-score.js` import omits `resetScoreboard`/`formatBreakdownLines`/`formatRoundLine` | read B's import line directly, 8 symbols vs A's 11 | grep `formatBreakdownLines(\|formatRoundLine(\|resetScoreboard(` (call sites, not just import) on B → 0 | Confirmed absent from B |
| 7 (§5) | B has no push/base marker distinction (`POV_ALERT_BADGE`) | bare grep `POV_ALERT_BADGE` on B → 0 | read B's `alertMarkMode` assignment directly — ternary has no 'base' branch | Confirmed absent from B |
| 8 (§5) | A has no `BOT_PUSH_TIER_ENABLED` flag | bare grep `BOT_PUSH_TIER_ENABLED` on A → 0 | read A's push-tier `if` condition directly, no flag term present | Confirmed absent from A |
| 9 (§7) | Neither viewer consumes contact memory for decisions | grep `contactRecency(` (calls, not import) on both → only A's import line matches | broader grep `[a-zA-Z]\.contacts\b\|contacts\.get\|contacts\.set\|contacts\.size` across both full files → write sites only | Confirmed write-only in both |
| 10 (§7) | B's `resetBotBrainState` never clears `rec.contacts`; B has no `resetActorMapState` equivalent | read the full `resetBotBrainState` function body — no `contacts` reference | bare grep `function resetActorMapState` on B → 0; confirmed no accompanying per-actor reset near B's `buildNavGrid` call site | Confirmed absent from B |
| 11 (§8) | B adds an accuracy-based spread term (`botAccuracy`) A doesn't have | bare grep `botAccuracy` on A → 0 | read A's `botShotSpreadRad` function body in full — no such term | Confirmed present-only-in-B (inverse absence, i.e. confirmed absent from A) |
| 12 (§10) | A's per-weapon reload-duration lookup (`reloadSequence`) has no B equivalent | grep `reloadSequence`/`botWeaponMount` scoped to B's `updateBotReload` region → not present | read B's full `updateBotReload` body — only `BOT_RELOAD_MS` flat constant | Confirmed absent from B |
| 13 (§13) | B's grenade self-veto pre-gate omits `blastReachesBody` | grep `blastReachesBody` scoped to B's pre-gate lines → not present | read B's full `grenadeCandidate`-equivalent function and diffed line-by-line against A's | Confirmed absent from B |
| 14 (§13) | B's `grenadeEvade` call never passes an `engagedId` (hysteresis unreachable) | bare grep `grenadeEvadeId` on B → 0 | read B's `grenadeEvade(...)` call site directly — 3 args vs A's 4 | Confirmed absent from B |
| 15 (§13) | `createProjectileManager` absent from B | bare grep `createProjectileManager` on B → 0 | read B's `bot-projectiles.js` import line directly — 2 symbols only | Confirmed absent from B (architectural — B uses `entityRegistry`/`CombatProjectileEntity` instead) |
| 16 (§15) | Neither viewer imports `squad-activity.js` | literal-string grep `squad-activity.js` on both — A: 0; B: 2 (both read directly, confirmed comments) | grep for the module's actual exported symbols (`rollTemperament, tickSquadLossDecision, formationAngleFor, columnOffset, SQUAD_LOSS_THRESHOLD, lossRetreatDecided`) and `from './squad-activity` pattern on both → 0 in both | Confirmed absent from both |
| 17 (§15) | B lacks `teamCentroid`/`MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP` imports | read B's `bot-medic.js` import line directly — symbols not listed | grep each bare symbol name across all of B → 0 hits each (B has an independent inline `fleeSquadCentroid` reimplementation instead, read in full) | Confirmed absent from B |
| 18 (§16) | B has no role insignia / squad-leader chevron / squad-debug overlay | grep `insignia`, `setSquadLeaderMark`, `squadDebug`/`SquadDebug` on B → 0 each | searched B for alternative naming (`roleMarker`, `overheadMarker`, `roleIcon`, `chevron`, `leaderMark`) → 0 | Confirmed absent from B |
| 19 (§17-18) | A doesn't import `finalizeNavGrid` | grep `finalizeNavGrid` on A → 0 | read A's full nav-grid import line directly, symbol not present | Confirmed absent from A |
| 20 (§19) | B has no console-based stranded/sealed-region report | grep literal warning strings (`walled off, not merely steep`, `cut off from the map`) on B → 0 | grep `NAV_REGION_REPORT_MIN` on B → 0 | Confirmed absent from B |
| 21 (§21/§24) | `bot-terrain.js` not imported by B | grep `from './bot-terrain.js'` on B → 0 | grep bare `bot-terrain` basename on B → 0 | Confirmed absent from B (architectural, not a gap) |
| 22 (§24) | `footprintRange`/`boxTransformOnTerrain` unused in B | grep `footprintRange` on B → 0 | grep `function boxTransformOnTerrain` on B → 0 | Confirmed absent from B (not fully resolved whether a B-side equivalent exists elsewhere — flagged open) |
| 23 (§23) | B has no `terrainSpeedFactor`/slope-speed modulation | grep `terrainSpeedFactor` on B → 0 | grep `SLOPE_SPEED_CLIMB\|SLOPE_SPEED_DESCENT` on B → 0 | Confirmed absent from B |
| 24 (§25) | B doesn't import `resolveStanceOverride`/`STANCE_RUN`/`STANCE_DASH` as live constants | grep `resolveStanceOverride` on B → 0 | grep `STANCE_RUN`/`STANCE_DASH` as non-comment occurrences on B → both only appear inside comments, never as imported/live values | Confirmed absent from B |
| 25 (§25) | B has no manual stance-override UI or `doubleTime` command | grep `botStanceOverride`/`BOT_STANCE_OVERRIDES` on B → 0 | grep `doubleTime` (catches `commandDoubleTime`/`sc.doubleTime`) on B → 0 | Confirmed absent from B |
| 26 (§26) | A has no `pathFailCount`/`lastSafePos` stuck-escape state | grep `pathFailCount` on A → 0 | grep `lastSafePos` on A → 0 | Confirmed absent from A |
| 27 (§22) | Neither viewer imports `bot-separation.js` directly | grep `from './bot-separation.js'` on both → 0 | grep bare `bot-separation` basename on both → only comment references found in each | Confirmed — both use it solely via `bot-entity.js`'s re-export |

---

## Notes on methodology and residual uncertainty

- All four research passes were run in parallel against the same frozen snapshot and cross-referenced known import-block line numbers before beginning, to reduce the risk of the "which line is actually the import" confusion the prior audit round reportedly had.
- Two comparisons flagged in earlier rounds as risk areas were explicitly re-verified here as *not* conflated: the pursue/flee-range threshold (`pursueHealthThreshold01`, identical in both) versus the separate heal-retreat threshold (`botHealthSettings.threshold01`, drifted 0.60→0.35) are reported and quoted separately in §12; similarly the teammate-heal threshold (`MEDIC_DEFAULTS.healAllyThreshold01=0.65`, shared) is distinct from both of the above and from the medic's own self-preservation number, and is not conflated with either in §15.
- `weapons.js` (per-weapon `fireIntervalMs`, damage, range) was referenced but not itself present in the frozen snapshot directory and so was not read directly in this audit — its values are structurally shared (both viewers import from the same file) but were not independently verified line-by-line.
- One open item was explicitly left unresolved rather than guessed at: whether B has any mechanism equivalent to A's `footprintRange`/`boxTransformOnTerrain` for seating authored cover geometry onto sloped terrain (§24, absence claim #22) — resolving this would require reading `shoot-house-layout.js` and/or `terrain-system.js` in full, which was outside the assigned module scope for this pass.
- `STANCE_DEFAULTS` sharing was asserted as "cannot drift" based on neither viewer being observed to override it, but this was not verified by reading every `botStanceSettings =` definition site exhaustively in both files — flagged as a minor residual gap in coverage (§25).
