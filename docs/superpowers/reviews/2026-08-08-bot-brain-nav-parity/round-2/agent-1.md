# Bot Brain / Navigation Parity Audit — Round 2

**Scope:** `bot-viewer-v2.html` (A, reference/authoritative) vs `environment-viewer-v2.html` (B, game-side port).
**Source:** frozen snapshot only, at
`C:\Users\msankofa\AppData\Local\Temp\claude\...\c59a907d-fde4-49d6-9626-8da94a115879\scratchpad\frozen\`
(A = 886,930 bytes / 15,699 lines; B = 834,921 bytes / 14,924 lines; plus all `bot-*.js`/`nav-*.js` shared modules and `docs/subsystems/bots.md`, 7,714 lines, a running dated changelog — later entries supersede earlier ones; the file's newest section is dated **2026-08-08**, today).

All claims are labeled **MEASURED** (read directly in the frozen snapshot) or **INFERRED** (deduced, not directly read). This report was assembled from four parallel read-only research passes (FSM/roles/squads; perception; combat; navigation), each independently re-verifying constants and absence claims against the source, then cross-checked here for internal consistency (e.g. `pursueHealthThreshold01` vs `botHealthSettings.threshold01` — see §3.4, these are NOT the same setting and are reported separately below, per the task's explicit warning).

Note on harness generations: `docs/subsystems/bots.md:3-9` (2026-08-08) states `bot-viewer-v3.html` is now the live/edited harness and `bot-viewer-v2.html` is a **frozen snapshot of 2026-08-07 game state**. The task named `bot-viewer-v2.html` as the reference, so that is what was compared; a v3 exists but is out of scope here.

---

## 1. Summary table

| Area | bot-viewer-v2 (A) | environment-viewer-v2 (B) | Verdict |
|---|---|---|---|
| FSM ladder (`chooseBotStateName`) | Shared `bot-activity.js`, unmodified | Shared `bot-activity.js`, unmodified | **identical** (shared code, drift impossible) |
| `holding` (S13 commanded-hold) formula | Inclusion list of 3 states | Exclusion list of 6 states (not the complement) | **drifted** |
| Think cadence / per-bot staggering | Full stagger system (`botThinkStride`, cohorts, rig-LOD stride) | None — every bot thinks every frame | **missing-from-B** |
| `orderOverride` / break-contact command layer | Full UI + ctx wiring | Not wired (rung permanently inert) | **missing-from-B** (documented as deliberate) |
| Risk-ranked target selection, pile-on, stickiness | Present | Present, numerically identical | **identical** |
| Roles (medic/squadleader/sniper/technical) descriptors | Shared `bot-roles.js`, unmodified | Shared `bot-roles.js`, unmodified | **identical** (shared code) |
| Medic decision math (`bot-medic.js`) | Shared, `MEDIC_DEFAULTS` unmodified | Shared, `MEDIC_DEFAULTS` unmodified | **identical** |
| Medic harness tuning (`botMedicSettings`) | 6 fields, own values | 6 fields, all 6 differ | **drifted** |
| Self-heal tuning (`botHealthSettings`) | threshold01 0.60 / resume01 0.72 | threshold01 0.35 / resume01 0.85 | **drifted** (materially different survival policy) |
| Pack pickup tuning (`botPackSettings`) | own values | all 4 shared fields differ; +`worldSpawnCount` (B-only) | **drifted** |
| Medic pose overlay (`medicHold`/`medicAid`) | Present | Absent | **missing-from-B** |
| Squads/formations (`bot-squad.js` wedge/column/line/ring) | Used | Used, identically | **identical** |
| `squad-activity.js` (legacy ring/column module) | Not imported | Not imported (retired) | **n/a** — only v1 (out of scope) still uses it |
| `SQUAD_HOLD_MAX_MS` | 12000 | 6000 | **drifted** |
| Squad debug overlay (rings/tethers/leader label) | Present | Absent | **missing-from-B** |
| Single-spawn role queue (`nextBotRole`) | Absent (batch spawn only) | Present | **missing-from-A** (architectural, one-at-a-time spawn model) |
| Default role-mix % (medic/sniper/technical) | 25/10/10 | 20/0/0 | **drifted** (defaults only, sliders exist both sides) |
| FOV cone (`withinBotFov`, 150°) | Inline | Inline, identical | **identical** (duplicated inline, not drifted) |
| Eye height (ray origin) | `EYE_LIFT=0.85` lerp → 1.32 m | raw `capsule.end` → 1.5 m, no `EYE_LIFT` at all | **drifted** |
| Target-side eye/aim height | Same `eyePosInto` formula (symmetric) | Different formula (`humanAimInto`, chest-height on wire-pose) | **drifted** (partly architecture-forced) |
| LOS raycast mechanism | `mapCollider.raycast` only (walls) | `botHasLineOfSight`→`resolveHitscan` (walls+trees/rocks+terrain) | **n/a-architectural** (B is a superset, appropriate to its richer world) |
| LOS raycast cadence (acquisition scan + confirm-ray) | `TARGET_SCAN_STRIDE=4`, tier-scaled; confirm every frame | identical | **identical** |
| Baked visibility-field LOS prefilter (`USE_FIELD_LOS_PREFILTER`) | Present, gates candidate list | Absent — every candidate pays full raycast | **missing-from-B** |
| Alert escalation ladder + constants | Shared `bot-alert.js` | Shared `bot-alert.js` | **identical** |
| `BOT_PUSH_TIER_ENABLED` gate | Absent | Present (hardcoded true, currently inert) | **missing-from-A** (inert extra code) |
| Overhead "!" marker mode (`alertMarkMode`) | 5 values incl. `'push'`/`'base'` | Only 3 values — push/base never emitted | **drifted** (real visual/wire-format gap) |
| Split attention (threat-bearing vs travel heading) | `faceThreatAndAhead`/`faceMovementScanning`, `bot-alert.js` constants | Same, near-literal port | **identical** |
| Contact/sighting memory (`bot-contacts.js`) | Recorded, not consumed (unused `contactRecency` import) | Recorded, not consumed | **identical** (both equally infrastructure-only) |
| "Head-exposed over cover" LOS bug | Open (single-ray sentry LOS, shared `nav-visibility.js` unchanged) | Open, identically | **n/a-architectural** (shared bug, not a cross-viewer divergence) |
| "Target-perception-gap" (`firstLive` fallback) fix | Present | Present, equivalent | **identical** |
| Aim/lead/spread base (`bot-aim.js` `AIM_DEFAULTS`) | Shared, unmodified | Shared, unmodified | **identical** |
| Inline per-shot accuracy widener (`botAccuracy`/`BOT_MAX_SPREAD_RAD`) | Absent | Present, stacked on shared cone | **missing-from-A** |
| Fire-gating ctx (`readyToFire`, ladder wiring) | Full | Full, equivalent (cosmetic reordering only) | **identical** |
| `pursueHealthThreshold01` (PURSUE-vs-AIM/FIRE gate) | 0.60 | 0.60 | **identical** — do not confuse with `botHealthSettings.threshold01` below |
| Reload duration source | Per-weapon (`reloadSequence.duration`), fallback 1800ms | Flat `BOT_RELOAD_MS=1800` always, ignores weapon | **drifted** |
| Top-off reload guard (`state!==BOT_KNIFE`, peek-hold extension) | Present | Absent (both guards missing) | **missing-from-B** |
| Sidearm slot decision cadence | Twice/frame (pre- and post-ladder) | Once/frame (post-ladder only) | **drifted** |
| `inGunfight` formula (sidearm trigger) | Uses bot's own `contactAgeMs` | Uses squad ally report age instead | **drifted** (independently-defined, not just cadence) |
| Sidearm constants (draw/lull/hysteresis) + stow visuals | Shared, `STOW_PLACEMENTS.hip` identical | Shared, identical | **identical** |
| Grenade throw decision (`chooseGrenadeThrow`, `GRENADE_DEFAULTS`) | Shared, unmodified | Shared, unmodified | **identical** |
| `createProjectileManager` local grenade flight sim | Present | Absent (only arc math imported) | **n/a-architectural** (B routes through game's networked projectile system) |
| Grenade evade hysteresis (`engagedId` arg) | Passed | Not passed (3-arg call, defaults null) | **missing-from-B** |
| Grenade evade goal search sophistication | Occlusion/exposure/edge-penalty/jitter-stable scan | Flat radial scan, no occlusion/exposure/edge terms | **drifted** (B materially simpler) |
| Knife/melee ladder rung + gating | Shared `bot-activity.js` rung; matching predicates | Same | **identical** |
| `KNIFE_COMMIT_MAX_MS` / `KNIFE_COMMIT_COOLDOWN_MS` | 8000 / 5000 | 12000 / 6000 | **drifted** |
| Nav grid core (`buildNavGrid`/`findPath`/`floodFill`, binary heap, pooled buffers) | Shared `nav-grid.js`, unmodified | Shared, unmodified | **identical** (drift structurally impossible) |
| `finalizeNavGrid` (incremental/time-sliced bake) | Not imported | Imported, used for zone-grid bake | **n/a-architectural** (B-specific persistent open-terrain grid) |
| Region labeling / stranded-region carve | Shared, both report carve/stranded counts | Shared, both report | **identical** (logic); UI banner differs (below) |
| Visible "STRANDED" HUD banner | Present (amber/orange bar) | Absent (console.warn + inspector text only) | **missing-from-B** (UI-only) |
| Goal claims (`createGoalClaims` via `bot-entity.js`) | Same kinds: cover/flee/seek/pursue/recover/pack | Same kinds, identical | **identical** |
| Cover/corner maps (`bot-cover.js`/`nav-corners.js`) | `buildCornerMap`, harness defaults (0.5m grid) | Same on shoot-house bake; scaled offsets on B's coarser 1.5m zone grid | **n/a-architectural** (documented, re-tuned for coarser pitch) |
| Separation/pushout (`bot-separation.js`) | `SEPARATION_RADIUS/WEIGHT/PROBE_M` identical | Identical, plus `BOT_COLLIDE_PAD` extra margin for human player | **n/a-architectural** (B has a documented extra pad) |
| Slope/danger cost (`bot-danger.js`) | Shared, all scale constants identical | Shared, identical | **identical** |
| Terrain-aware pathing source | `bot-terrain.js` (synthetic procedural ground) | Own `terrainHeight`/real CDLOD terrain, no `bot-terrain.js` | **n/a-architectural** |
| Terrain walkability slope threshold | Continuous gradient test, `maxSlope=0.85` (~40°) | Discrete adjacent-cell test, `0.9m/1.5m≈0.6` (~31°) | **drifted** (un-reconciled, undocumented) |
| Stance selection (`bot-stance.js`, `STANCE_DEFAULTS`) | Shared, unmodified | Shared, unmodified | **identical** (core capability, incl. prone/rig-derived capsule height) |
| `resolveStanceOverride` / "Allow prone" UI toggle | Present | Absent (prone capability exists but no UI switch; stays off) | **missing-from-B** (UI-only) |
| `STANCE_DASH` | Present (per doc) | Absent (per doc) | **missing-from-B** (INFERRED from bots.md, not independently grepped) |
| Stuck detection (`trackStuck`, escape/fall-catch system) | **Absent** | **Present**, fully wired | **missing-from-A** (reference harness is behind here) |
| `bot-structures.js` (`teamSideRegions`, `generateHomeBase`) | Imported/used | Not imported (comment-only reference) | **missing-from-B** |

---

## 2. Detailed findings

### 2.1 FSM ladder and think cadence

**The ladder itself is byte-identical by construction.** Both files import `chooseBotStateName` from `bot-activity.js` and call it exactly once per bot per frame with no local reimplementation:
- A: `bot-viewer-v2.html:6609-6615` (import), `:10625` (`let state = chooseBotStateName(botState, c);`)
- B: `environment-viewer-v2.html:102-110` (import), `:6488` (same call)

Since it is one shared, unmodified function, the priority order (heal-latch → knife → flee-commit → cover-commit → close-self-threat → reload-to-cover → [visible: flee-exit-buffer → flee → reload-to-cover → orderOverride → pursue(miss-streak+health-gate) → cover-entry → aim → fire] → [not visible: reload-to-cover → orderOverride → ally-hit cover-move → seek/patrol]) cannot drift between the two harnesses. The surrounding `ctx`-building code is a close line-for-line port (A `:10500-10730` vs B `:6360-6560`), inside which two real drifts were found:

**Drift — `holding` (S13 commanded-hold) formula (MEASURED).**
```
// A, bot-viewer-v2.html:10676-10679
// S13 hold, hoisted above the stance resolve... a pinned bot is stationary...
const holding = activeBotActor.holdUntil > now &&
    (state === BOT_PATROL || state === BOT_SEEK || state === BOT_PURSUE);
```
Design intent at A:10725-10729: *"Only pure locomotion yields: AIM/FIRE/KNIFE and COVER_HOLD are already stationary, COVER_MOVE resolves to a hold on its own... FLEE never yields."* — a deliberate 3-state inclusion list.
```
// B, environment-viewer-v2.html:6530-6531
const holding = rec.holdUntil > nowMs && state !== BOT_FLEE && state !== BOT_HEAL &&
    state !== BOT_AIM && state !== BOT_FIRE && state !== BOT_COVER_HOLD && state !== BOT_KNIFE;
```
This is a 6-state exclusion list, not the complement of A's inclusion list. States the ladder can also emit — `BOT_COVER_MOVE`, `'alert'`, `MEDIC_MOVE`, `MEDIC_TEND` — are not excluded, so `holding` reads **true** for them in B under a live hold lease, vs **false** in A. Consequence: a B bot mid-`MEDIC_TEND`/`MEDIC_MOVE` or breaking for `BOT_COVER_MOVE` while still carrying a hold lease freezes into the generic "holding" branch instead of running its own dispatch. This is also internally inconsistent with B's own state-code tracer, which computes `LATCH_HOLD` using the PSU-only formula that matches A's dispatch, not B's own dispatch:
- B: `:7146` `_btLatchQ.hold = !dead && rec.holdUntil > nowMs && 'PSU'.includes(d.state);`
- A: `:2727` `_stateLatchQ.hold = actor.holdUntil > now && 'PSU'.includes(d.state);` (matches A's own dispatch)

`docs/subsystems/bots.md:5883-5884` (2026-07-30) claims B's `LATCH_HOLD` "mirror[s] the dispatch's `holding`" — that claim is false against current source; either the dispatch formula broadened after this doc entry, or the doc was wrong from the start.

**Missing-from-B — think cadence / per-bot staggering (MEASURED).** A has a full stagger system: each bot's entire decision pass runs only every Nth frame in spawn-order cohorts, banking `dt` between turns.
- A: `:3059-3131` defines `botThinkStaggerMode` ('auto'|1|2|3, URL-overridable), `botThinkStride(livingCount)` → stride 1 (≤40 bots) / 2 (41-80) / 3 (>80); applied at `:3364-3371` (`actor.thinkDtAcc` accumulator, `updateBotSentry(actor.thinkDtAcc, now)` only on the bot's turn); companion rig-LOD stride at `:3069-3104` (`botRigLodEnabled`, `RIG_LOD_MID2`/`RIG_LOD_FAR2`).
- B calls `updateBotSentry(rec, dt, nowMs)` unconditionally every frame for every living bot (`:6724-6726`, `:7055`). No `thinkDtAcc`, no cohort modulus, no rig-LOD stride equivalent.
- **Absence confirmed two ways:** (1) grep `botThinkStride|thinkDtAcc|botThinkStaggerMode` in B → 0 hits; (2) grep `botRigLodEnabled|RIG_LOD_MID2|RIG_LOD_FAR2` in B → 0 hits.
- The narrower target-rescan stride (`TARGET_SCAN_STRIDE=4`) exists identically in both (A `:6405,6434`; B `:3652,3971-3972`) — only the outer whole-decision-pass stagger is A-only.
- Architecturally expected (A is a stress-test harness tuned for 80-100+ bot rosters; B runs embedded, typically smaller rosters), but real: at large rosters A's FSM re-evaluates less often per bot (graceful degradation), B's always re-evaluates every bot every frame (no degradation, no headroom).

**Missing-from-B — `orderOverride` / break-contact command layer (MEASURED, and independently corroborated).** The ladder's `orderOverride` rung (bot-activity.js, feeds "pull the bot back to PATROL out of the firefight-reflex tier") is driven from a player-facing command UI in A only:
- A: `:614-711` (`commandDoubleTime`, `commandBreakContact`, command-wheel UI); `:10616-10617` sets `c.orderOverride`.
- B has no `commandBreakContact`/`commandDoubleTime`/`commandGoal`/`commandTargetId` and never sets `c.orderOverride` (rung permanently inert, defaults false).
- **Confirmed two ways:** (1) grep `orderOverride|commandBreakContact|commandDoubleTime|commandGoal|commandTargetId` in B → 0 hits; (2) `docs/subsystems/bots.md:7709-7714` (2026-08-08, the file's newest entry) states explicitly: *"Deliberately not ported: The player command layer... `orderOverride`/`doubleTime`/break-contact plumbing... The consumption side is portable — the game already imports `bot-activity.js`, whose `orderOverride` rung is waiting — but the input side is not... Nothing of it is wired yet."*

**Non-finding worth recording:** risk-ranked target selection (`TARGET_DANGER_SELF_BONUS=2.5`, `TARGET_PILE_ON_STEP=0.25`, `TARGET_STICK_RISK_MARGIN=1.3`, `TARGET_COMMIT_MIN_MS=1500`) is present and numerically identical in both (A `:6406-6421`; B `:3937-3949`) — this closes a gap `docs/subsystems/bots.md:2353-2357` had earlier called "known drift" (that note is now stale/superseded by the 2026-08-08 entry).

### 2.2 Roles and squads

**Role descriptor data cannot drift.** Both statically import `bot-roles.js`/`bot-medic.js` unmodified, no local `ROLES[...]` override anywhere:
- A: `:918-919`, `:923-924`. B: `:139-142` (same symbol set, different destructure order — no semantic effect).
- `role.sightScale`/`role.swapOnDryMag`/`role.closeRange`/`role.maxPacks` consumed identically in both (A `:1743,1831-1832`; B `:3794,3864-3865`), so sniper/technical/medic/squad-leader descriptor values (sightScale 1.5, closeRange, swapOnDryMag, maxPacks, canRevive, leadership, insignia) are guaranteed identical.
- `MEDIC_DEFAULTS` (`tendRadius=1.7`, `healAllyThreshold01=0.65`, `allyResumeHp01=0.95`, `responseRadius=16`, `reviveWindowMs=12000`, `reviveRadius=14`, `cohesionNeighborRadius=16`, `cohesionRadius=9`, `cohesionDeadzone=3.5`, `outsideSquadPenalty=1.75` — `bot-medic.js:14-25`) — no local override in either file, confirmed identical.

**Drift — `botMedicSettings` (harness-side channel rates layered on shared medic math), all 6 fields differ (MEASURED).**
```
// A, bot-viewer-v2.html:7689-7696
const botMedicSettings = {
  healAllyPerSecond: 22, reviveChannelMs: 2500, reviveHp: 50,
  healHoldRadius: 6.0, healHoldLeaseMs: 500, medicClaimLeaseMs: 700,
};
// B, environment-viewer-v2.html:3624-3627
const botMedicSettings = {
  healAllyPerSecond: 26, reviveChannelMs: 2600, reviveHp: 45,
  medicClaimLeaseMs: 1500, healHoldRadius: 4.5, healHoldLeaseMs: 700,
};
```
`medicClaimLeaseMs` differs by more than 2x (700 vs 1500ms — how long a medic's claim on a patient blocks other medics converging on it).

**Drift — self-heal `botHealthSettings`, 5 of 7 fields differ (MEASURED).**
```
// A, bot-viewer-v2.html:7656-7665
const botHealthSettings = {
  retreatEnabled: true, threshold01: 0.60, resume01: 0.72, healPerSecond: 18,
  safeDistance: 8.5, safeHoldMs: 500, retreatSearchRadius: 10, coverScore: 12,
};
// B, environment-viewer-v2.html:3611-3619
const botHealthSettings = {
  retreatEnabled: true, threshold01: 0.35, resume01: 0.85, safeDistance: 12,
  safeHoldMs: 900, healPerSecond: 22, retreatSearchRadius: 10,
};
// B's coverScore lives in a different object: environment-viewer-v2.html:3593 botBehaviorSettings.coverScore: 12 (same value, different parent)
```
This is the single largest behavioral divergence found in the whole audit: A bots break off to self-heal at 60% HP and stop at 72%; B bots fight on down to 35% HP and heal all the way to 85%, and additionally require a farther/longer-held safe window before healing starts (`safeDistance` 8.5 vs 12, `safeHoldMs` 500 vs 900).

**Drift — pack pickup `botPackSettings`, all 4 shared fields differ + B-only field (MEASURED).**
```
// A, bot-viewer-v2.html:7666-7671
const botPackSettings = { pickupRadius: 0.7, shortProximity: 4.0, dropScatter: 0.45, pickupCrouchMs: 450 };
// B, environment-viewer-v2.html:3620-3623
const botPackSettings = {
  dropScatter: 0.35, pickupRadius: 0.9, shortProximity: 12, pickupCrouchMs: 600,
  worldSpawnCount: 0,  // ambient packs seeded at map load; 0 = corpse drops only
};
```
`shortProximity` (a healthy bot only detours for a pack this close) is 4.0 vs 12 — a 3x difference. `worldSpawnCount` (ambient ground-spawned packs, independent of corpse drops) is B-only; confirmed absent in A via (1) grep `worldSpawnCount` → 0 hits, (2) grep `ambient pack|seedWorldPacks|worldPack` → 0 hits. It defaults to 0 (inert unless a map author changes it) but the *feature* does not exist in A at all.

**Missing-from-B — medic pose overlay (MEASURED).** A drives a dedicated arm/hand pose override during tending (`poseMode: 'none'|'rifleHeal'|'medicHold'|'medicAid'`, `:7810,3880-3895`) gated by `tendUnderFire`/`MEDIC_TEND_COMBAT_MS=5000` (`:7699,10649-10650`) — gun-up standing tend if a fight was recently live, holstered kneeling aid once quiet. Confirmed absent in B two ways: (1) grep `medicHold|medicAid|desiredPose` → 0 hits; (2) grep `tendUnderFire|MEDIC_TEND_COMBAT_MS` → 0 hits. B sets `sc.medicTend = rec.role === ROLE_MEDIC` (`:6544`) into the stance ctx, but `bot-stance.js`'s `chooseBotStance` never reads a `medicTend` field (confirmed: grep `medicTend` in `bot-stance.js` → 0 hits) — a dead, harmless field. Posture parity still holds since the stance table forces `STANCE_CROUCH` for `'heal'`/`'medic-tend'` unconditionally (`bot-stance.js:89`); only the finer gun-up-vs-holstered visual is A-only. Rendering/animation concern, not decision logic.

**`squad-activity.js` is used by neither v2 file** (MEASURED, and this itself needed the two-method check because the string appears in B as retirement-commentary, not an import):
- Grep `squad-activity` in A → 0 hits. In B → 2 hits, both comments: `:3372` `// Inlined from squad-activity.js (retired here in Phase C-and-a-half; v1 still imports the module).`; `:9908` similar.
- `docs/subsystems/bots.md:5804-5807` confirms: *"`squad-activity.js` is retired inside the v2 copy only — `environment-viewer.html` (v1) still imports it."* v1 is out of this audit's scope. `squad-activity.js`'s own `chooseFormationKind` (ring/column-only, `engaged→'ring'` default) is a red herring — neither v2 file calls it; both use `bot-squad.js`'s differently-shaped `chooseFormationKind` (`engaged→'line'`, `wedge` default).

**Squad roster/succession code is near-byte-identical** (A `:6060-6111` vs B `:3085-3134`: `stepSquadSuccession`, `formationRanks`, `chooseFormationKind`, `squadCorridorClear`, `reconcileSquads` — identical logic, only data-source variable names differ). `botSquadSettings` construction is literally identical:
```
A:1040:        const botSquadSettings = { ...SQUAD_DEFAULTS, slotRepath: 1.0, corridorProbeMs: 300, mergeRadius: SQUAD_MERGE_RADIUS };
B:2162:         const botSquadSettings = { ...SQUAD_DEFAULTS, slotRepath: 1.0, corridorProbeMs: 300, mergeRadius: SQUAD_MERGE_RADIUS };
```
So `SQUAD_DEFAULTS` (spacing 2.4, ringScale 2.5, slotArrive 1.2, leash 22), `SQUAD_MERGE_RADIUS`=20, `SUCCESSION_SHOCK_MS`=1800, `SQUAD_MAX_SIZE`=8, and `PUSH_HOLD_LEASE_MS`=500 (A `:5791`, B `:3630`) are all confirmed identical (no local shadowing found in either file for any of these names).

**Drift — `SQUAD_HOLD_MAX_MS` (MEASURED).**
```
A, bot-viewer-v2.html:6688:        const SQUAD_HOLD_MAX_MS = 12000;  // longest a follower holds a slot before doing its own thing
B, environment-viewer-v2.html:2164: const SQUAD_HOLD_MAX_MS = 6000;   // past this, a follower stuck holding its slot goes back to patrolling
```
Same consumption pattern in both (A `:9976-9999`, B `:5017`) — B squad followers give up on a frozen leader twice as fast.

**Missing-from-B — squad debug visualization** (MEASURED). A has color-coded rings on every squad member, tethers to formation slots (via `squadSlotWorld`), and a `LEADERLESS <shock-remaining>s` leader label during succession shock (`:921` import, `:6961-7100` implementation, `:12841-12843` UI button). Confirmed absent in B two ways: (1) grep `squadDebug|SquadDebug` → 0 hits; (2) grep `squadSlotWorld` → 0 hits (only appears in A's import + one call site at `:7072`). `squadMemberGoal` (actual movement, not debug drawing) IS used identically by both — this gap is presentation/tooling only, not functional.

**Missing-from-A — single-spawn role queue (architectural, not a bug).** B spawns bots one at a time (live "add bot" action) so needs a rolling role queue not present in A (A spawns a full batch at once via `assignRolesToBatch` directly, `:2450-2452`):
```
B, environment-viewer-v2.html:2757-2764
const BOT_ROLE_BATCH = 10;
let botRoleQueue = [];
function nextBotRole() {
  if (!botRoleQueue.length) botRoleQueue = assignRolesToBatch(BOT_ROLE_BATCH, currentRoleMixOpts());
  return botRoleQueue.shift() ?? DEFAULT_ROLE;
}
```
Confirmed absent from A two ways: (1) grep `nextBotRole|BOT_ROLE_BATCH|botRoleQueue` → 0 hits; (2) direct comparison of A's spawn path (batch call, no queue abstraction anywhere).

**Default role-mix differs (both runtime-adjustable via sliders, but defaults differ):**
```
A:7673: let botMedicPercent = 25;
A:7676: const botRoleMix = { [ROLE_SNIPER]: 10, [ROLE_TECHNICAL]: 10 };
B:3605: let botMedicPercent = 20;
B:3606-3609: let botSniperPercent = 0; let botTechnicalPercent = 0; const botRoleMix = {};
```

### 2.3 Perception

**Import surface.** Both statically import the full perception stack (`nav-visibility.js`, `bot-alert.js`, `bot-contacts.js`, `bot-danger.js`, `bot-activity.js`, `bot-entity.js`) at the top of the file; zero `await import()` lazy-loads for any of these in either file. `bot-contacts.js`: A imports `contactRecency` (`:6647-6649`), B does not (`:79`).

**FOV cone (`withinBotFov`) — inline in both, identical.** Same cosine-half-angle test in both files (A `:6387-6396`, B `:3890`), `deg>=360` short-circuits to omnidirectional. Default `fovDegrees=150` identical (A `:7648`, B `:3590`) — note `bots.md:2588` documents "120" as the default, which is stale doc, not a cross-viewer divergence.

**Drift — eye height (MEASURED).**
```
A, bot-viewer-v2.html:6652: const EYE_LIFT = 0.85; // fraction up the capsule used as eye/muzzle height, both bot and dummy
A:7102-7108: function eyePos(entity) { return entity.capsule.start.clone().lerp(entity.capsule.end, EYE_LIFT); }
B, environment-viewer-v2.html:3426:
function botEyeInto(entity, out) { out.x = entity.capsule.end.x; out.y = entity.capsule.end.y; out.z = entity.capsule.end.z; return out; }
```
No `EYE_LIFT` constant exists anywhere in B (grep → 0 hits; confirmed by direct read of the surrounding `:3415-3432` block showing no lerp/fraction at all, just `capsule.end`). Both use the same shared, unmodified `createBotEntity` capsule shape (`DEFAULT_STAND_HEIGHT=1.8`; A passes `{standHeight:1.8}` explicitly at `:2464`, B passes no opts at `:2781,7021` but lands on the same shape) — so **computed eye height above ground is 1.32m in A (0.3 + 0.85×1.2) vs 1.5m in B (raw capsule top)**, an ~18cm difference with no comment in B explaining it as intentional (unlike the neighboring `botXZInto`, which does carry a "matches bot-viewer-v2's botXZ" parity comment). `bots.md:2604` independently confirms A's 1.32m figure.

Downstream, target-side eye point uses a *different formula entirely* in B, not just a different constant: A uses the same `eyePosInto` (0.85 lerp) symmetrically for both origin and target (`:6443,6526,6543`); B uses `humanAimInto` for targets — wire-pose midpoint + 0.3×height ("upper chest", `:3428-3431`), used at `:3979,4824,5621,6182`. Structurally necessary in B (targets arrive as wire-pose snapshots for multiplayer parity), but it means B's origin-eye (capsule top) and target-eye (chest) conventions don't match each other, whereas A's single formula is symmetric.

**Missing-from-B — baked visibility-field LOS prefilter (MEASURED).** A's `selectBotTarget` prunes candidates via the baked field before they even enter the raycast loop:
```
A:6449: if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(origin.x, origin.z, targetEye.x, targetEye.z)) continue;
A:6672: const USE_FIELD_LOS_PREFILTER = true; // skip LOS raycasts when the baked field says hidden
```
B's `selectBotTarget` (`:3968-4062`, read in full) has no equivalent — every FOV+range candidate pays a full raycast. Confirmed absent two ways: (1) grep `USE_FIELD_LOS_PREFILTER|fieldSaysHidden` in B → 0 hits; (2) full read of `selectBotTarget`'s body plus a grep confirming B's `botVisibilityField` (the field itself) IS used elsewhere (cover/flee/investigate/alert-exposure: `:2334,4577,4844,5207,5460,5604,6520`) but never inside `selectBotTarget`. So B pays a full walls+trees+terrain raycast per in-cone/in-range candidate where A gets an O(1) prefilter first.

**n/a-architectural — LOS raycast mechanism.** A's LOS test is a direct `mapCollider.raycast(...)` (walls only, appropriate to A's maze/room-only harness maps): A `:6529,10275`. B wraps LOS in `botHasLineOfSight(eye, targetP, dist)` (`:3169-3183`) routed through `resolveHitscan` with obstacle columns (trees/rocks) and `heightAt` (terrain) — a genuine superset, consistent with `bots.md:7651-7691`'s "closing the harness-to-game gaps" entry. Not a gap; B's richer world requires richer LOS.

**LOS/target-scan cadence — identical two-tier cadence in both.** Full candidate re-scan gated by `TARGET_SCAN_STRIDE=4` (A `:6405`, B `:3652`, identical), narrowed to `TIER_STRIDE_ALERTED=2` under alert tiers via shared `perceptionForTier` (`bot-alert.js:233-234`). Confirm-ray against the already-committed target runs every frame in both (A `:10262-10275`, B `:6181-6191`, B explicitly commented "fresh every frame, harness parity").

**"Head-exposed over cover" LOS bug — open identically in both (n/a-architectural, shared bug not a cross-viewer divergence).** `bots.md:2599-2608` (2026-08-06) documents: single eye-to-eye ray at 1.32m, `nav-visibility.js`'s `SIGHT_BLOCK_HEIGHT=1.5` blocks fully-or-not with no per-height query, hit capsule tops at 1.80m while the rendered head runs 1.786-2.020m → heads-over-cover are never targeted. `nav-visibility.js` is unchanged (`SIGHT_BLOCK_HEIGHT=1.5` still a scalar, `:8`; `buildSightGrid` still binary, `:48-65`). Neither viewer's sentry/target-acquisition LOS samples more than one ray (only the separate blast-occlusion system, `BLAST_SAMPLE_T=[0.15,0.5,0.9]`, samples multiple heights, and that's a different code path — grenade/explosion damage, not bullet target acquisition). INFERRED that the bug is still open (the referenced plan doc isn't in the frozen snapshot to confirm directly), but MEASURED that both viewers share identical (unfixed) machinery, so this is not a parity gap between them.

**"Target-perception-gap" (`firstLive` fallback) bug — fixed identically in both.** A retains `firstLive` only as a diagnostic counter (`:6567`), never assigned to `botTarget`; final selection `:6569` `const keep = botTarget?.alive && !stale ? botTarget : null;`. B's rewrite (`:4053-4061`) has no `firstLive`-equivalent fallback at all. `TARGET_RETAIN_MAX_MS=6000` present verbatim in both (A `:6689`, B `:3651`).

**Alert escalation — full parity plus one B-only inert gate.** Both compute `esc = alertEscalation(...)` (shared) then apply the identical tier ladder (A `:10459-10474`, B `:6340-6355`). All tier constants (`SEMI_ALERT_SHARE_RADIUS=6`, `ESCALATION_RADIUS=18`, `SEMI_ALERT_WARY_MS=1500`, `ALERT_DEFENSIVE_SCORE=2`, `ALERT_PUSH_SCORE=4`, `SUPPORT_GROUP_MIN=3`, `SUPPORT_RADIUS=10`) come from shared `bot-alert.js`, confirmed no local redefinition in either file. `ALLY_ALERT_RADIUS=12` identical in both (A `:7582`, B `:3645`). B adds `BOT_PUSH_TIER_ENABLED=true` (`:3629`, gates the push tier at `:6343`) which A has no equivalent of (grep → 0 hits in A) — currently inert since hardcoded true, but exists only on B's side.

**Drift — overhead "!" marker mode never reaches push/base state in B (MEASURED, real functional gap).**
```
A, bot-viewer-v2.html:10503-10504:
activeBotActor.alertMarkMode = alertTier === 'push' ? (activeBotActor.pushElement === 'base' ? 'base' : 'push')
  : alertTier ? (firsthand ? 'seen' : 'heard') : nearMiss ? 'near' : null;
```
(Five possible values: `'push'`,`'base'`,`'seen'`,`'heard'`,`'near'` — documented in `POV_ALERT_BADGE`, A `:4611-4614`, and `bot-entity.js:148`.)
```
B, environment-viewer-v2.html:6380:
rec.alertMarkMode = alertTier ? (firsthand ? 'seen' : 'heard') : nearMiss ? 'near' : null;
```
This runs *before* the push-element block (`:6385-6389`) and is never reassigned after, so when `alertTier==='push'`, `alertMarkMode` still resolves to `'seen'`/`'heard'` — it can never be `'push'`/`'base'`. This value is replicated to the wire (`:6382`, "so ghosts can draw the overhead '!'"), so multiplayer ghosts never receive a push/base alert-tier value from B. Confirmed two ways: (1) full grep of `alertMarkMode` in B (5 hits: `:2828,3563,6380,6382,7150`) shows exactly one assignment site with no push branch; (2) direct read of `:6334-6392` confirms the push-element computation (`applyPushElement`, `:6385-6389`) runs after and doesn't touch `alertMarkMode`. The underlying push/base *behavior* (`rec.pushElement`) IS computed correctly in B (`:5897-5900`, matching A `:5811-5814`) — only the visual/wire marker fails to reflect it.

**Split attention — full parity.** `faceThreatAndAhead` (A `:9644-9654`, B `:5757-5766`) and `faceMovementScanning` (A `:9667-9676`, B `:5769-5777`) are near-literal ports (only variable renames). All constants (`ATTENTION_THREAT_MS=1200`, `ATTENTION_AHEAD_MS=800`, `ATTENTION_SWEEP_MS=2800`, `ATTENTION_SWEEP_RAD=0.95`, `PATROL_SCAN_RAD=0.5`, `PATROL_SCAN_MS=3600`, `TIER_FOV_WARY=140`, `TIER_FOV_ALERTED=160`, `TIER_STRIDE_WARY=3`, `TIER_STRIDE_ALERTED=2`) live only in `bot-alert.js` — confirmed via grep of every constant name across both HTML files (0 hits outside the shared module), so drift is structurally impossible.

**Contact/sighting memory — recorded, consumed by neither (parity, not a gap).** Both write via `recordContactSighting`/`markContactsUnseen` inside `selectBotTarget`, neither reads it back. Confirmed for both: grep `\.contacts\b` (A: 2 hits, both writes/clear; B: 1 hit, a write) and grep `contactRecency` (only in A's unused import line; 0 hits anywhere in B). `bots.md:2381` (A, 2026-08-07) and `:7669-7670` (B, 2026-08-08) both independently state "recorded, not yet consumed."

### 2.4 Combat

**Import surface.** All 8 combat modules (`bot-activity.js`, `bot-aim.js`, `bot-sidearm.js`, `bot-pursuit.js`, `bot-grenade.js`, `bot-projectiles.js`, `bot-score.js`, `weapon-hold-resolver.js`) statically imported in both, zero lazy-loads for any of them (confirmed by grepping `await import\(` in both files — 19 hits in A / 17 in B, all for terrain/forest/plants/rocks/particle/UI subsystems, none for combat modules). One asymmetry: A imports `createProjectileManager` from `bot-projectiles.js` (`:116`), B imports only `solveBallisticArc, sampleArcPoints` (`:158`) — see grenade section below.

**Aim — shared math used identically, plus a B-only inline widener (MEASURED).** Both call `aimAnglesTo`/`aimError`/`slewAngle` (`bot-activity.js`) and `spreadHalfAngleRad`/`bloomAfterShot`/`decayBloomDeg`/`reactionDelayMs` (`bot-aim.js`); `botAimSettings = {...AIM_DEFAULTS}` unmodified in both (A `:7655`, B `:3596`) — confirms `bots.md`'s 2026-07-31 note that B's old 700/40/2000 override is gone. Drift:
```
A, bot-viewer-v2.html:10215-10216:
return spreadHalfAngleRad(_spreadIn, botAimSettings) * stanceSpreadScale(...)
B, environment-viewer-v2.html:5830-5831:
return (spreadHalfAngleRad(_spreadIn, botAimSettings) + inaccuracy01 * BOT_MAX_SPREAD_RAD) * stanceSpreadScale(...)
```
where `inaccuracy01 = 1 - clamp(botAccuracy,0,100)/100`, `BOT_MAX_SPREAD_RAD=0.15` (B `:2196-2197`), fed by a live "Accuracy (%)" slider (default 60, B `:2177`). Confirmed absent from A two ways: (1) grep `BOT_MAX_SPREAD_RAD` in A → 0 hits; (2) grep `botAccuracy` in A → 0 hits. This is a real B-only per-shot accuracy widener layered on the shared cone.

**Fire gating — the ctx-wiring "still-old env-viewer" doc warning is stale; the rewrite happened (MEASURED against source, correcting the doc).** `bots.md:59-66` (undated inline note inside the bot-activity.js section) warns *"the still-old env-viewer call site keeps SEEK until its rewrite"* if `keepsMissing`/`pursueHealthOk` default. Measured against current source, B computes and wires both real values:
```
B:6327: const pursueHealthOk = combat.hp / Math.max(1, combat.maxHp) > botBehaviorSettings.pursueHealthThreshold01;
B:6330: const keepsMissing = botMissStreak >= pursueBreakThreshold(botBehaviorSettings.pursueMissStreak, spreadSeed);
B:6473: c.keepsMissing = keepsMissing; c.pursueHealthOk = pursueHealthOk;
```
identical in shape to A `:10438/10441/10606`. This matches `bots.md:6608-6664` (2026-07-31, "Harness combat parity — aim/disengage"), which explicitly closed this. **The doc note at line 65 is dead prose from before the fix landed and should be treated as stale, not as a live bug.**

**Missing-from-B — `orderOverride` rung (documented deliberate, see §2.1).**

**Drift — reload duration source (MEASURED, genuine functional gap).**
- A's `updateBotReload` (`:1889-1908`) calls shared `reloadBotWeapon(now)`, which computes duration from `botWeaponMount.reloadSequence.duration` (**per-weapon**), falling back to `BOT_RELOAD_FALLBACK_MS/1000=1.8s` (`:1474,1881`) only when no sequence is mounted.
- B's `updateBotReload` (`:3871-3886`) sets a flat `botReloadUntil = nowMs + BOT_RELOAD_MS` where `BOT_RELOAD_MS=1800` (`:2192`) is a plain constant — confirmed via full-file grep that `reloadSequence` never appears in B's reload-timer path (only in animation-lookup code elsewhere, `:13008,13069`).
- Consequence: in A a bolt-action/sniper reload takes proportionally longer than a pistol; in B every weapon reloads in exactly 1.8s regardless.

**Missing-from-B — top-off reload guards (MEASURED).** Both import/call shared `shouldTopOffReload` (A `:10847/10850`, B `:6652`), but the surrounding guard differs: A gates the whole block on `state !== BOT_KNIFE && botReloadUntil == null && ...` (`:10835`) plus a peek-hold-aware branch (`:10841-10849`) that only tops off `if (holdPeek.phase==='in')` and extends `holdPeek.inHoldS` to cover the reload so a peeking bot doesn't retreat mid-reload. B's equivalent (`:6648`) has neither the `state!==BOT_KNIFE` guard nor any peek-hold extension. Confirmed two ways: (1) grep `peekReloadOk` in B → 0 hits; (2) direct read shows B's block is 3 lines shorter with no `holdPeek`/`inHoldS` reference in the reload path. Consequence: B could attempt a top-off during `BOT_KNIFE` (A forbids this), and a peeking/covering B bot has no guaranteed hold-through-reload.

**Drift — sidearm slot decision cadence and `inGunfight` formula (MEASURED, two separate divergences).** A calls `updateBotWeaponSlot` twice per frame: once pre-ladder (`:10404-10407`) and again post-movement (`:10831`, explicitly commented to re-decide on the same frame's post-fire ammo so an empty-mag shot swaps the pistol in immediately rather than starting a reload the very next frame). B calls it once, post-movement only (`:6644`). Confirmed via call-site count: A has 2 (`:10407,10831`), B has 1 (`:6644`). Additionally, the `inGunfight` gating formula itself differs, not just the count:
```
A:10404-10406: visible || contactAgeMs < SIDEARM_LULL_MS || now - lastSelfThreatAt < SIDEARM_LULL_MS   // contactAgeMs = bot's own last-known-target memory
B:6642-6643:   visible || nowMs - lastSelfThreatAt < SIDEARM_LULL_MS || (!!report && nowMs - report.at < SIDEARM_LULL_MS)  // 3rd term = squad ally report age, not own memory
```
A never references squad ally reports in this formula; B never references its own contact-age memory here — independently-drifted definitions of "am I in a gunfight," not merely a cadence difference. Shared constants (`SIDEARM_DRAW_MS=550`, `SIDEARM_LULL_MS=2500`, `SIDEARM_CLOSE_HYST=1.4`, `PISTOL_IDS`) and stow visuals (`STOW_PLACEMENTS.hip`, byte-identical A `:2230-2233` / B `:12865-12867`, B's own comment confirms "ported from bot-viewer-v2.html:1548") are otherwise at full parity — the rendering approach differs (A: batched geometry; B: per-bot cloned prop groups) but that's architecture, not behavior.

**Disengage/flee wiring — byte-for-byte identical (MEASURED).**
```
A:7637-7645                              B:3582-3589
pursueDistance: 7.0                      pursueDistance: 7.0
pursueExitBuffer: 0.6                    pursueExitBuffer: 0.6
pursueMissStreak: 3                      pursueMissStreak: 3
pursueHealthThreshold01: 0.60            pursueHealthThreshold01: 0.60
fleeStandoffFraction: 0.5                fleeStandoffFraction: 0.5
fleeDistance: 2.2                        fleeDistance: 2.2
fleeExitBuffer: 0.6                      fleeExitBuffer: 0.6
```
`fleeCommitted` (A `:10435-10436`, B `:6325`), `weaponFleeDistance` (A `:10446`, B `:6332`) match. The Schmitt-trigger hysteresis lives entirely inside shared `chooseBotStateName` (flee-side `bot-activity.js:91-94`, pursue-side `:107-109`) — a single implementation, drift structurally impossible.

**IMPORTANT — do not conflate `pursueHealthThreshold01` (identical, 0.60/0.60, gates PURSUE) with `botHealthSettings.threshold01` (gates HEAL entry, DIFFERS 0.60/0.35) — this is exactly the trap the task asked to guard against.** These are two distinct ctx fields feeding two different ladder rungs (`pursueHealthOk` vs `healReady`/`healUnsafe`). See §2.2 for the full `botHealthSettings` table (threshold01 0.60 vs 0.35, resume01 0.72 vs 0.85, healPerSecond 18 vs 22, safeDistance 8.5 vs 12, safeHoldMs 500 vs 900) — that is a real, separate, large divergence; `pursueHealthThreshold01` itself is identical on both sides and must not be reported as part of that gap.

**Grenade throw decision — full parity.** `botGrenadeSettings={...GRENADE_DEFAULTS}` unmodified in both (A `:8977`, B `:5923`; `GRENADE_DEFAULTS` per `bot-grenade.js:6-20`: `perBotCount:2, cooldownMs:9000, teamCooldownMs:2500, minRange:8, maxRange:25, friendlyRadiusScale:1.15, selfRadiusScale:1.25, clusterWeight:1.0, blindThrowMaxAgeMs:4000, blindThrowChance:0.5, minEnemiesForVisibleThrow:2, aimLeadS:0.4, evadeExitScale:1.25`). `chooseGrenadeThrow` pre-gates match line-for-line (A `:9079-9120`, B `:6005-6042`).

**n/a-architectural — `createProjectileManager`.** A runs its own local grenade flight simulation (`:11431`, `botProjectiles.spawn/update/list`) appropriate to a standalone dev harness; B imports only the arc-math helpers (`:158`) and (inferred) routes actual grenade entities through the game's existing networked projectile system. Confirmed via (1) grep `createProjectileManager` in B → 0 hits; (2) B's import statement names only `solveBallisticArc, sampleArcPoints`.

**Missing-from-B — grenade evade hysteresis arg (MEASURED).** `grenadeEvade(selfP, threats, settings, engagedId)` (`bot-grenade.js:135-155`) takes an optional 4th arg specifically so a bot that just cleared a blast edge isn't handed straight back to combat, widening the evade-exit ring by `evadeExitScale=1.25`. A passes it (`:9291`, `actor.grenadeEvadeId`); B's call (`:6125`) omits it (3 args, defaults null). Confirmed two ways: (1) grep `grenadeEvadeId` in B → 0 hits; (2) direct read of both call sites (A: 4 args; B: 3 args). Consequence: a B bot at the edge of a blast radius can flicker in/out of evade state frame-to-frame — the exact boundary-chatter `evadeExitScale` exists to prevent.

**Drift — grenade evade goal search sophistication (MEASURED, inline-vs-inline; `grenadeEvadeGoal` is not a shared-module function, written independently in each file).** A's version (`:9207-9255`) scores candidate cells by distance-from-blast minus travel-weighted distance-from-self, plus a stable per-cell noise jitter, a blast-shadow/occlusion bonus via `visField.canSee`, an exposure-to-current-threat penalty, an edge-clearance penalty, and separately tracks a direct-sprintable fallback alongside a path-solved winner. B's version (`:6101-6120`) is a flat 8-radius nested-loop scan scoring only `distanceFromBlast - 0.35*distanceFromSelf`, gated by a single `lineWalkable` check — no occlusion/exposure/edge/jitter/fallback terms at all. This is a genuine capability gap: B's evading bots won't preferentially seek blast-shadowed cover or avoid running back into an enemy's sightline while also fleeing a grenade, where A's will.

**Knife/melee — ladder rung shared, gating predicates match, but commit timers drift (MEASURED).** `BOT_KNIFE` lives only in shared `chooseBotStateName` (`bot-activity.js:70`). Gating predicates match (A `:10432`; B `:6322-6323`), both derive `attackerOutOfAmmo` from shared `outOfAllAmmo`.
```
A:6686-6687:  KNIFE_COMMIT_MAX_MS = 8000;   KNIFE_COMMIT_COOLDOWN_MS = 5000;
B:3653-3654:  KNIFE_COMMIT_MAX_MS = 12000;  KNIFE_COMMIT_COOLDOWN_MS = 6000;
```
Both 50%/20% larger in B — a knife-committed B bot chases 50% longer before the ladder force-abandons the charge (A's comment at `:10419` documents the origin of this safety valve: "One bot held it 652s against a target a median 43m away, 0% of samples ever inside blade range"), and is blocked from re-entering KNIFE for 6s vs A's 5s after abandoning. Also ties to the top-off gap above: A's top-off explicitly excludes `BOT_KNIFE` state; B's does not, so B's opportunistic top-off is unconditionally available during a knife commit where A's is not.

### 2.5 Navigation

**Core algorithm cannot drift.** Both statically import the identical shared `nav-grid.js` (binary-heap `findPath`, pooled-buffer `floodFill`/`floodPath`, no local `findPath`/`buildNavGrid`/`floodFill` redefinitions found in either file via grep of `^function findPath` etc. — 0 hits both). A: `:6619`. B: `:111-112` (aliases some symbols, e.g. `findPath as botFindPath`, but same underlying function).

**n/a-architectural — `finalizeNavGrid`.** B additionally imports `finalizeNavGrid` (`:111-112`), which A does not (grep in A → 0 hits). This is the region-labeling/connectivity half of `buildNavGrid`, split out so a large bake can sample incrementally across frames and finalize once — `nav-grid.js:47-58` comment explicitly names "environment-viewer-v2's terrain combat-zone grid" as the use case. B calls it via `stepBotZoneBake()`/`adoptBotNavGrid` for its persistent 384m open-terrain grid; A's `buildNavGrid` is always a single synchronous bake at layout-load time (`:7491`) since A has no equivalent open-world map type. Neither file overrides `minConnectRegion`/`connectRegions` (grep in both → 0 hits), so both get shared defaults (`minConnectRegion=6, connectRegions=true`).

**Region labeling / stranded-region carve — shared logic, UI-only gap.** Entirely inside shared `nav-grid.js` (`labelRegions`, `connectStrandedRegions`, `cheapestSoftLink`) for both. A's `reportNavRegions()` (`:7169-7194`) logs carved/sealed/stranded counts and drives a live colored HUD banner (`:3399-3417`, amber "⚠ N bots STRANDED — orbiting a sealed pocket (fallback, not a fix)"). B's zone-grid bake logs the same numbers inline (`:2534-2541`) and exposes `sealedRegions`/`carved`/`regions` over the wire (`botLiveRegions()`, `~:7353`), but has no equivalent colored banner — confirmed via (1) grep `"STRANDED"` uppercase in B → only inside per-bot Bot Inspector text (`:10096,10126`), never a global banner; (2) grep `"orbiting a sealed pocket"` in B → only a code comment (`:4974`), never rendered UI. Per-bot fallback state (`patrolStranded`) exists with the same field name and semantics in both.

**Goal claims — shared, identical.** Both indirectly import `createGoalClaims` via `bot-entity.js` (not directly from `bot-separation.js`; confirmed A `:909`, B `:100`, and `bot-separation.js`'s own header explains the re-export is because it needs THREE). Both claim/release the same kinds (`'cover'`,`'flee'`,`'seek'`,`'pursue'`,`'recover'`,`'pack'`) at matching call sites. B additionally re-claims `'cover'` after a zone-grid rebake (`:2600`) since `adoptBotNavGrid` invalidates in-flight cell indices — A never rebuilds its grid mid-session so has no equivalent step. Architectural, not a gap.

**Cover/corner maps — near-identical wiring, one scaled-constant divergence documented in-source.** Both import the same `bot-cover.js` symbol set (A `:6626-6633`, B `:125-132`) except B additionally imports `COVER_ANCHOR_REACH` (`:130`), used only for `COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6` (`:5705`) — needed because B's zone grid's coarser 1.5m cell pitch places anchors ~1.06m from center, outside the 0.45m `COVER_ANCHOR_REACH` tuned for A's fine 0.5m grid. `buildCornerMap` calls: A (`:7508-7514`) and B's shoot-house bake (`:2335`) both use shared defaults (`ANCHOR_INSET=0.6, ANCHOR_OFFACE=0.4, PEEK_PAST=0.5`, all metres, tuned for the 0.5m grid both use here). B's zone-grid bake (`:2520-2528`) scales these by the coarser pitch (0.6×/0.5×/1.2×) — `bots.md:6046-6052` documents this explicitly: "The authored 0.6/0.4/0.5m offsets assume a ~0.5m grid; at 1.5m they can quantize anchor and peek onto the same cell... The zone bake scales them with the cell." Crest params also diverge similarly (A: `maxSpan≈2m,farCells≈12m`; B's zone grid: `BOT_ZONE_CREST_SPAN_M=4.5, BOT_ZONE_CREST_FAR_M=24`, roughly double A's metre-equivalents) — `bots.md:6054-6076` documents this as a deliberate, bench-validated re-tune for the coarser pitch (at 1.5m, a 2m span finds zero crests on synthetic rugged terrain). **n/a-architectural, both documented in source.**

**Separation/pushout — identical constants, one documented extra pad in B.** `SEPARATION_RADIUS=1.5`, `SEPARATION_WEIGHT=0.5`, `SEPARATION_PROBE_M=0.45` identical (A `:7572-7574`, B `:3633-3635`). A calls `resolveBotPairsHashed(living, botHash)` with no explicit radius (falls back to per-bot capsule radius, `:3382`); B passes `maxR + BOT_COLLIDE_PAD*0.5` (`:3238`) with `BOT_COLLIDE_PAD=0.05` (`:2202`) — B's own comment (`:3226-3236`) explains this is because B has a real human player sharing physical space, which A's bot-only harness doesn't need to account for. Documented, architectural.

**Slope/danger cost — identical.** `bot-danger.js` imported identically (A `:6634-6637`, B `:133-136`); every read site uses matching scale constants (`DANGER_PACK_SCALE`, `DANGER_PATROL_SCALE`, `DANGER_FLEE_SCALE`, cover-veto threshold 0.35 with matching comments) at equivalent call sites in both. Confirmed per `bots.md:6083-6085`: danger is a scoring/veto term in both, never an A* cost term, matching all call sites found (all outside `findPath`/`floodFill`). `SLOPE_COST_DEFAULTS` (`nav-grid.js:8-13`, `up:1.8, down:0.6, maxFactor:6, smoothMaxRise:0.6`) — neither file overrides `slopeCost` (grep → 0 hits both), so both take shared defaults verbatim.

**n/a-architectural — terrain source, but with one undocumented numeric drift worth flagging.** B does not import `bot-terrain.js` at all (confirmed two ways: (1) grep bare `bot-terrain` in B → 0 hits; (2) grep `createTerrainField|BOT_TERRAIN_DEFAULTS` in B → 0 hits) — expected, since `bot-terrain.js` is A's synthetic procedural-ground generator for a harness with no real map, while B rides the game's real CDLOD terrain via its own `terrainHeight`. Both still feed `heightAt` into `buildNavGrid`/`finalizeNavGrid` for slope-costed A*/flood-fill. **However, the separate walkability *gate* (pass/fail, not cost) uses two different, un-reconciled formulas:**
- A's `navWalkable` (`:7196-7202`): continuous central-difference gradient magnitude vs `terrainSettings.maxSlope`, default `BOT_TERRAIN_DEFAULTS.maxSlope=0.85` (`bot-terrain.js:32`, "~40°").
- B's `botTerrainWalkable` (`:2278-2287`): discrete adjacent-cell rise/run vs `BOT_TERRAIN_SLOPE_TOLERANCE=0.9` (`:2207`, "metres of rise between adjacent local-grid cells"); at `BOT_LOCAL_NAV_CELL=1.5m` this is `0.9/1.5=0.6` (~31°) — **notably stricter than A's ~40° threshold**, and not called out anywhere in `bots.md`.
This is a real numeric divergence in what terrain each viewer's bots consider "too steep to walk," independent of the (expected, architectural) fact that they read terrain from different sources.

**Stance selection — shared core capability identical; UI exposure differs.** Both import the same `bot-stance.js` symbols except B omits `resolveStanceOverride` (confirmed: grep in B → 0 hits). B hardcodes `botStanceSettings={...STANCE_DEFAULTS}` (`:3610`, comment "proneEnabled stays false, like the harness"), i.e. the capability exists but B exposes no UI to turn prone on, where A has a live toggle (`:13676`, `createBotStanceToggle('Allow prone', 'proneEnabled', ...)`). "Capsule height derived from the rig" (the fix noted in project memory as resolving an earlier "prone still off" state) is confirmed current on **both** sides: `stanceCapsuleHeightScale` wired identically (A `:7616`, B `:6697`), both reading the live procedural rig rather than flat constants. `STANCE_DEFAULTS` itself (`crouchSpeedFactor=0.55, proneSpeedFactor=0.30, crouchSpreadScale=0.75, proneSpreadScale=0.50, runSpreadScale=1.25, dashSpeedBonus=1.15, dashSpreadScale=1.9, crouchHeightScale=0.68, proneHeightScale=0.35, standUpMs=700, crouchUpMs=220, proneMinHoldMs=1200, seekCrouchRadius=4, aimCrouchDistance=8`) is unmodified in both (no local reassignment found). `STANCE_DASH` reported absent from B per `bots.md` — **INFERRED, not independently grepped** in this pass.

**Missing-from-A — stuck detection (the reference harness is behind here; flagged prominently, see ranked gaps).** `trackStuck`/`STUCK_MIN_SPEED=0.15` are exported from `bot-activity.js` (`:238-244`). A's own import of `bot-activity.js` (`:6609-6615`) omits `trackStuck` even though it's exported; confirmed absent two ways: (1) grep `trackStuck` in A → 0 hits; (2) grep related identifiers `pathFailCount|lastSafePos|BOT_FALL_CATCH|stuckReplanCount|stuckSince|stuckMs` in A → 0 hits. A's re-path logic is purely goal/wall-driven (`lineWalkable` failure + `NAV_REPATH_COOLDOWN_MS`, `:7980-7994`; global A* throttle `REPLAN_COOLDOWN_MS=300`/`REPLAN_BUDGET_PER_FRAME=8`, `:8043-8065`) — it never checks whether a bot has physically stopped moving. B imports and fully wires `trackStuck` as `botTrackStuck` (`:104`) plus a larger recovery system: `BOT_STUCK_ESCAPE_RETRIES=6` (`:2210`), `BOT_STUCK_FORCE_REPLAN_MS=3000` (`:2213`), `BOT_FALL_CATCH_DROP_M=12` (`:2212`), `BOT_ESCAPE_TIMEOUT_MS=4000` (`:2211`), `rec.pathFailCount`/`rec.stuckReplanCount`/`rec.lastSafePos`, an escape-target teleport fallback, and a live per-bot inspector readout (`:10096,10126`). Per `bots.md`, this system originated in the older, pre-v2 `bot-viewer.html` (v1) — documented at length in a "Bot Inspector"/"Fall-through-map recovery" section dated 2026-07-15 through 2026-07-18 — and was apparently **not carried forward when `bot-viewer-v2.html` was built**, while it **was** ported into B during a later phase (B's `BOT_STUCK_ESCAPE_RETRIES` comment cites `docs/superpowers/reviews/2026-07-18-bot-stuck-systemic-review.md`). **Net effect: for stuck detection specifically, the "reference/authoritative" harness A is currently less capable than the port B** — the reverse of the general pattern in this audit.

**Missing-from-B — `bot-structures.js` (`teamSideRegions`, `generateHomeBase`).** A imports it (`:7267`); B does not — confirmed two ways: (1) grep bare `bot-structures` in B → 1 hit, a comment only (`:2650`); (2) grep exported symbols `teamSideRegions|generateHomeBase|HOME_BASE_DEFAULTS` in B → same single comment hit, no import/usage. Slightly outside strict nav scope (it's a map-content generator) but touches team-side/home-base geometry that squad goal-picking can reference, so noted here.

---

## 3. Ranked list of the most significant parity gaps

1. **Self-heal HP thresholds (`botHealthSettings`) — A breaks off at 60%/heals to 72%; B fights to 35%/heals to 85%, with a farther and longer-held safe-retreat requirement (8.5m/500ms vs 12m/900ms).** This is the single largest behavioral divergence in the whole audit and changes the fundamental survival policy of every non-medic bot: B bots visibly stay in gunfights far longer while critically wounded than A bots would. Both a design-intent question (which is "correct"?) and a tuning risk (if B is supposed to match A's playtested balance, this needs reconciling). §2.2.

2. **`orderOverride`/break-contact command layer is entirely absent from B (deliberate, per today's changelog, but still a functional gap for anyone testing "orders" behavior in the game viewer).** The consumption side is ready (`bot-activity.js`'s rung is live); nothing drives it. Matters for anyone assuming player squad commands work in-game the way they do in the harness. §2.1.

3. **Overhead "!" marker can never show `'push'`/`'base'` in B, even though the underlying push/base behavior is computed correctly.** This silently degrades a player-facing readability signal (and the multiplayer wire payload for ghosts) without degrading actual bot behavior — the kind of bug that's easy to miss because "the bots act right" but "the UI doesn't say why." §2.3.

4. **A has no per-bot think-cadence stagger; B has no equivalent gap but also has no equivalent headroom.** At large roster counts this is a real perf/behavior tradeoff (A degrades reaction latency gracefully under load; B doesn't degrade but also doesn't have a release valve). Worth knowing before assuming B can host A-harness-scale rosters at the same frame budget. §2.1.

5. **Eye height differs by 18cm (1.32m in A vs 1.5m in B) with no explanatory comment on B's side, plus B uses two different height conventions for origin vs target eye points where A uses one symmetric formula.** This changes exactly what a bot standing behind a given piece of cover can and can't see, in a way that isn't visually obvious and wasn't flagged as intentional anywhere in the source. §2.3.

6. **Reload duration in B ignores per-weapon `reloadSequence.duration` entirely, using a flat 1.8s for every weapon.** A sniper rifle and a pistol reload in the same time in B; they don't in A. Directly affects weapon balance and fire-gating pacing. §2.4.

7. **Baked visibility-field LOS prefilter is missing from B's target acquisition (`selectBotTarget` pays a full raycast per candidate instead of an O(1) field lookup first).** Primarily a perf concern (more raycasts per frame at scale), but also means B's target-scan cadence tradeoffs are calibrated differently than A's. §2.3.

8. **Grenade evade in B is both less resistant to boundary chatter (missing `engagedId` hysteresis) and much less tactically aware (no occlusion/exposure/edge-penalty scoring in `grenadeEvadeGoal`).** B bots evading a grenade may flicker in/out of evade state and won't preferentially duck into blast shadow or avoid running into an enemy's sightline while doing so — a visible AI-quality regression in exactly the kind of high-stakes moment (grenade thrown) where players notice bot behavior most. §2.4.

9. **Stuck detection is present in B but absent from the "reference/authoritative" A — the one finding in this audit that runs backward from the general pattern.** Anyone treating A as ground truth for this behavior would be wrong; A itself needs the fix that already exists in `bot-activity.js` (`trackStuck`) and was ported into B from the older v1 harness. §2.5.

10. **Terrain walkability slope threshold differs (~40° in A vs ~31° in B) and is not documented anywhere as an intentional re-tune, unlike the (documented) corner-map/crest scaling for B's coarser grid pitch.** Worth a maintainer's explicit sign-off on whether this is intended or an oversight, since B's threshold is meaningfully more conservative. §2.5.

Lower-severity items (medic pose overlay, squad debug overlay, various default-percentage/tuning deltas in medic/pack settings, `SQUAD_HOLD_MAX_MS`, knife commit timers) are real and cataloged above but are either presentation-only or small enough numeric deltas that they're unlikely to be immediately visible in play — see §1/§2 for full detail.

---

## 4. Absence claims and how they were confirmed (two methods each)

| # | Claim | Method 1 | Method 2 |
|---|---|---|---|
| 1 | `squad-activity.js` not imported by either v2 file | grep bare string `squad-activity` in both HTML files (0 hits in A; 2 hits in B, both comments not imports) | `docs/subsystems/bots.md:5804-5807` states explicitly it's retired in "the v2 copy," only v1 still imports it |
| 2 | A's whole-decision-pass think-stagger absent in B | grep `botThinkStride\|thinkDtAcc\|botThinkStaggerMode\|Think stagger` in B → 0 hits | grep `botRigLodEnabled\|RIG_LOD_MID2\|RIG_LOD_FAR2` in B → 0 hits (companion LOD system also absent) |
| 3 | `orderOverride`/command layer absent/inert in B | grep `orderOverride\|commandBreakContact\|commandDoubleTime\|commandGoal\|commandTargetId` in B → 0 hits | `bots.md:7709-7714` (2026-08-08, newest entry) states "Deliberately not ported... Nothing of it is wired yet" |
| 4 | `contactRecency` unused in both (not a functional cross-viewer gap) | grep `contactRecency` in A → only the import line, no call site | grep `contactRecency` in B → 0 hits at all, not even imported |
| 5 | `worldSpawnCount`/ambient pack seeding absent from A | grep `worldSpawnCount` in A → 0 hits | grep `ambient pack\|seedWorldPacks\|worldPack` in A → 0 hits |
| 6 | Single-spawn role queue (`nextBotRole`) absent from A | grep `nextBotRole\|BOT_ROLE_BATCH\|botRoleQueue` in A → 0 hits | direct code comparison: A's spawn path calls `assignRolesToBatch(total,...)` against the full batch directly, no queue abstraction anywhere in the spawn flow |
| 7 | Squad debug overlay (`squadDebug*`) absent from B | grep `squadDebug\|SquadDebug` in B → 0 hits | grep `squadSlotWorld` in B → 0 hits (the one function the overlay needs and nothing else in B uses it) |
| 8 | Medic pose-override system (`medicHold`/`medicAid`/`poseMode`) absent from B | grep `medicHold\|medicAid\|desiredPose` in B → 0 hits | grep `tendUnderFire\|MEDIC_TEND_COMBAT_MS` in B → 0 hits (driving signal also absent) |
| 9 | `medicTend` stance-ctx field is dead in B (not consumed by shared module) | grep `medicTend` in `bot-stance.js` → 0 hits | direct read of `chooseBotStance`'s destructure list (`bot-stance.js:75-79`) confirms `medicTend` is not among read fields |
| 10 | Baked visibility-field LOS prefilter absent from B's target acquisition | grep `USE_FIELD_LOS_PREFILTER\|fieldSaysHidden` in B → 0 hits | full read of `selectBotTarget`'s body (B `:3968-4062`) plus grep confirming `botVisibilityField` IS used elsewhere in B, just never inside `selectBotTarget` |
| 11 | `EYE_LIFT` constant absent from B | grep `EYE_LIFT` in B → 0 hits | direct read of B's `botEyeInto` (`:3415-3432`) shows raw `capsule.end`, no lerp/fraction math at all |
| 12 | `BOT_MAX_SPREAD_RAD`/`botAccuracy` inline accuracy widener absent from A | grep `BOT_MAX_SPREAD_RAD` in A → 0 hits | grep `botAccuracy` in A → 0 hits |
| 13 | `peekReloadOk`/peek-hold-aware top-off extension absent from B | grep `peekReloadOk` in B → 0 hits | direct read of B's top-off block (`:6648`) shows it's shorter than A's and has no `holdPeek`/`inHoldS` reference in the reload path |
| 14 | `createProjectileManager` local grenade sim absent from B | grep `createProjectileManager` in B → 0 hits | B's import statement (`:158`) names only `solveBallisticArc, sampleArcPoints`, confirming it wasn't imported under another name |
| 15 | `grenadeEvadeId`/`engagedId` hysteresis arg absent from B's evade call | grep `grenadeEvadeId` in B → 0 hits | direct read of B's call site (`:6125`, 3 args) vs A's (`:9291`, 4 args) |
| 16 | `bot-terrain.js` (synthetic ground generator) absent from B | grep bare basename `bot-terrain` in B → 0 hits | grep exported symbols `createTerrainField\|BOT_TERRAIN_DEFAULTS` in B → 0 hits |
| 17 | `resolveStanceOverride`/"Allow prone" UI toggle absent from B | grep `resolveStanceOverride` in B → 0 hits (import list omits it) | direct read of B's `botStanceSettings` (`:3610`, `{...STANCE_DEFAULTS}` spread with comment "proneEnabled stays false, like the harness") confirms no override path exists |
| 18 | `trackStuck`/stuck-detection system absent from A | grep `trackStuck` in A → 0 hits | grep related identifiers `pathFailCount\|lastSafePos\|BOT_FALL_CATCH\|stuckReplanCount\|stuckSince\|stuckMs` in A → 0 hits |
| 19 | `bot-structures.js` (`teamSideRegions`/`generateHomeBase`) absent from B | grep bare basename `bot-structures` in B → 1 hit, a comment only (`:2650`), not an import | grep exported symbols `teamSideRegions\|generateHomeBase\|HOME_BASE_DEFAULTS` in B → same single comment hit, no import/usage |
| 20 | Visible colored "STRANDED" HUD banner absent from B | grep `"STRANDED"` (uppercase, quoted) in B → only inside per-bot Bot Inspector text rows (`:10096,10126`), never a global banner | grep `"orbiting a sealed pocket"` in B → only a code comment (`:4974`), never rendered as UI text |
| 21 | `alertMarkMode` never resolves to `'push'`/`'base'` in B | full grep of every `alertMarkMode` occurrence in B (5 hits total: `:2828,3563,6380,6382,7150`) shows exactly one assignment site with no push/base branch | direct read of the surrounding block (`:6334-6392`) confirms the push-element computation (`:6385-6389`) runs after the assignment and never touches it |
| 22 | `STANCE_DASH` absent from B | **not independently grepped in this pass — INFERRED from `docs/subsystems/bots.md`'s Phase C note only; flagged as lower-confidence than every other absence claim above** | — |

All absence claims except #22 were confirmed by two independent methods directly against the frozen source, per the task's methodology requirement. #22 is explicitly flagged as doc-only/INFERRED and should be independently verified before being relied on.

---

## 5. Scope boundaries and things deliberately not deep-dived

- `bot-alert.js`/`bot-cover.js`/`bot-danger.js` internal tuning beyond what feeds the FSM ctx build was not exhaustively re-verified line-by-line beyond confirming import-block parity and no local shadowing of their constants — the perception and navigation sections above cover the ctx-relevant subset in full.
- `multiplayer.js`/`GhostRenderer` (referenced as the consumer of B's `alertMarkMode` wire field) is not in the frozen snapshot and was not independently inspected — the claim that B's ghosts can never show a push/base marker is based on what B writes to the wire, not on reading the renderer itself.
- The referenced height-aware-LOS plan doc (`docs/superpowers/plans/2026-08-06-height-aware-los-plan.md`) is not in the frozen snapshot, so its completion status is INFERRED from the unchanged state of `nav-visibility.js` and both viewers' single-ray sentry LOS checks, not read directly.
- `bot-viewer-v3.html` (now the live/edited harness per `bots.md:3-9`) was out of scope — this audit compares exactly the two files named in the task.
