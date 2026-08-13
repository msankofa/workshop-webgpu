# Bot Brain + Navigation Parity Audit — Round 2 / Agent 3

Comparing `bot-viewer-v2.html` (reference/authoritative harness) against `environment-viewer-v2.html`
(game-side port), both read from the frozen snapshot directory:
`C:\Users\msankofa\AppData\Local\Temp\claude\...\c59a907d-fde4-49d6-9626-8da94a115879\scratchpad\frozen\`

All file:line citations below are against that snapshot; basenames are identical to the live repo.
Work was split across five parallel sub-agents (FSM/stance, perception/alert, combat, roles/squads,
navigation), each independently applying the two-method absence-confirmation rule, then synthesized
here. Every claim is tagged **MEASURED** (an agent read the exact lines) or **INFERRED** (deduced,
not directly confirmed) — INFERRED claims are called out explicitly; almost everything below is
MEASURED.

One snapshot gap: `combat.js` and `weapons.js` were referenced by both HTML files but were **not
present as standalone files** in the frozen directory (only their consumers were read). Claims about
their internals are inferred from call sites/comments, flagged where relevant.

---

## Summary table

| Area | bot-viewer-v2 | environment-viewer-v2 | Verdict |
|---|---|---|---|
| FSM states (bot-activity.js core) | full state set | full state set, same import surface | identical |
| Think cadence / roster-scaled staggering | `botThinkStride` (1/2/3 @ 40/80 bots) + rig LOD | none — every bot full-rate every frame | **missing-from-B** |
| Target-acquisition scan stride | `TARGET_SCAN_STRIDE=4` | `TARGET_SCAN_STRIDE=4` | identical |
| Stuck detection / force-replan / escape-teleport | absent entirely | `trackStuck` + `BOT_STUCK_FORCE_REPLAN_MS` + `BOT_STUCK_ESCAPE_RETRIES` | **missing-from-A** |
| State encoding (bot-state-code.js) | static import, debug tracer only | dynamic `import()` behind `?botTrace=1`, same purpose | drifted (loading strategy only; no behavior diff) |
| Stance FSM core (chooseBotStance/transitions) | full | full, same constants | identical |
| Stance manual override + 17 tuning sliders | present (`resolveStanceOverride`, slider panel) | absent | **missing-from-B** |
| "Double time" order → STANCE_RUN via patrol | present | absent (`doubleTime` doesn't exist) | **missing-from-B** (doc'd as roadmap) |
| Eye/aim/perception anchor height | 1.32 m (`EYE_LIFT=0.85` lerp) | 1.50 m (`capsule.end`, self); enemy uses a third formula | **drifted (significant, quantified)** |
| FOV cone (base + tier scaling) | 150° base, tier via `perceptionForTier` | 150° base, same | identical |
| LOS raycast threshold (`SIGHT_BLOCK_HEIGHT`) | applied internally by `buildSightGrid`, not imported | imported for early pre-filter | identical effective behavior |
| Visibility-field build cadence | one full-map bake per layout load | static once (shoot-house) OR budgeted rolling "zone bake" (open terrain) | drifted, architectural (bounded map vs. unbounded terrain) |
| Target selection/attribution core | `selectBotTarget`, 8 tunables | same function, same 8 tunables | identical |
| Target-anchor consistency (gate vs. final LOS ray) | consistent (`eyePosInto` both times) | inconsistent (`humanAimInto` for gating, raw `candidate.p` for the ray) | **drifted (minor, port-introduced)** |
| Alert propagation / escalation tiers | 28/28 symbols, 7 constants | 28/28 symbols, same constants | identical |
| Split attention (`stepAttention`/`attentionSweep`) | 8 call sites | 9 call sites (extra: grenade throw) | drifted (minor behavior change, arguably an improvement) |
| Contact/sighting memory core | `createContactMemory` etc. | same, minus `contactRecency` | drifted but inert (unused on both sides) |
| Aim core (bot-aim.js AIM_DEFAULTS) | shared | shared, identical | identical |
| Fired-shot spread | shared cone only | shared cone **+** accuracy-slider term (`BOT_MAX_SPREAD_RAD`) | **drifted** |
| Fire gating (`readyToFire`) | 5-condition gate | same 5 conditions | identical |
| Lead / target prediction | none (hitscan, by design) | none | n/a-architectural (both) |
| Reload duration | per-weapon animation duration (fallback 1800ms) | flat 1800ms for all weapons | **drifted** |
| Sidearm swap (bot-sidearm.js) | shared, identical call shape | shared, identical call shape | identical |
| Heal/flee HP threshold | 0.60 → resume 0.72; safeDist 8.5m; safeHold 500ms | 0.35 → resume 0.85; safeDist 12m; safeHold 900ms | **drifted (high impact)** |
| Pursue-break miss-streak / pursue-health threshold | `pursueBreakThreshold` base 3; `pursueHealthThreshold01` 0.60 | identical values | identical |
| Grenade/rocket ballistic math | `solveBallisticArc`/`sampleArcPoints` | same functions, same math | identical |
| Grenade/rocket delivery container | standalone `createProjectileManager` | `entityRegistry`/`CombatProjectileEntity` | architectural re-platform, n/a |
| Grenade evade exit hysteresis (`grenadeEvadeId`) | wired (1.25× exit-radius scale) | not passed — feature inert | **missing-from-B** |
| Knife commit-timeout constants | 8000ms max / 5000ms cooldown | 12000ms max / 6000ms cooldown | **drifted** |
| Knife swing cooldown mechanism | bespoke local `lastKnifeAt` timer | routed through shared `applyCombatIntent`/`validateShot` | architectural re-platform (unverified internals) |
| Hitscan primitive (`rayCapsuleHit`) | used for projectile-vs-body sweep | consolidated into `resolveWorldShot`→`resolveHitscan` | architectural consolidation, n/a |
| Roles (medic/squadleader/sniper/technical) core + behavior fields | full, fields actively read | full, fields actively read | identical |
| Squads/formations movement (`squadMemberGoal`) | uses `squadSlotWorld` internally via the shared module | same (via the same internal call inside `squadMemberGoal`) | identical |
| Squad debug visualization (rings/tethers/slot markers) | present | absent | **missing-from-B** (QA tooling only) |
| Medic regroup (`cohesionTarget`) | shared, identical call | shared, identical call | identical |
| Medic flee-goal squad cohesion (`teamCentroid`) | uses shared `teamCentroid` helper | hand-duplicated local reimplementation (`fleeSquadCentroid`) | drifted (code duplication, not a behavior gap) |
| Medic final-approach creep-to-contact | present (`creepToContact`, 0.85m/0.45 creep) | absent — medic never closes the last stride | **missing-from-B (functional)** |
| Health-pack total-HP readout | HUD shows `packsTotalHp` | HUD shows pack count only | **missing-from-B (HUD only)** |
| Scoreboard reset | `resetScoreboard` + UI button | none — `botScore` is a `const`, never reset | **missing-from-B (functional)** |
| Scoreboard breakdown/history (`formatBreakdownLines`/`formatRoundLine`) | full attribution + round history panel | header + team score only | **missing-from-B** |
| Nav grid build (`buildNavGrid`) | single synchronous call, finalizes internally | same, plus frame-sliced `finalizeNavGrid` split for open terrain | architectural, n/a |
| A* vs flood-fill goal dispatch | flood for flee, A* for pursue, shared budget constants | identical dispatch and constants | identical |
| Region labeling / connectivity repair | shared `nav-grid.js` logic | same shared logic | identical |
| Stranded-region logging | warns on `sealedRegions.length` separately | folded into one combined log line, no separate sealed-region warning | drifted (minor, cosmetic) |
| Goal claims lifecycle | 6 kinds, claim/release symmetric | same 6 kinds, same lifecycle, +1 extra corner-remap claim | identical (extra is architecture-driven) |
| Cover corner seat band (`COVER_ANCHOR_REACH`) | not imported (never needs the raw constant) | imported, used to derive a coarser-grid correction | architectural, n/a (quantified: A's grid is 0.5m cells, B's is 1.5m) |
| Danger field (bot-danger.js) | shared, identical constants | shared, identical constants | identical |
| Separation / pushout | shared, identical constants | shared, identical constants, +1 extra `BOT_COLLIDE_PAD` term | drifted (documented, minor, player-avoidance specific) |
| Slope/terrain-aware pathing | optional synthetic terrain via `bot-terrain.js` (default-off) | real terrain (`terrain-system.js`) fed into the same `nav-grid.js` slope cost function | architectural, n/a — both are slope-cost-capable |
| Path-level stuck/replan | none | `BOT_STUCK_FORCE_REPLAN_MS`, `BOT_STUCK_ESCAPE_RETRIES`, escape-teleport | **missing-from-A** (same root cause as row 4) |

---

## Detailed findings by area

### 1. FSM states, transitions, think cadence

**Core state set — identical.** Both files import the same 27 core symbols from `bot-activity.js`
(`BOT_PATROL, BOT_SEEK, BOT_PURSUE, BOT_FLEE, BOT_HEAL, BOT_KNIFE, BOT_AIM, BOT_FIRE, BOT_COVER_MOVE,
BOT_COVER_HOLD, ...`). MEASURED: `bot-viewer-v2.html:6609-6615` vs `environment-viewer-v2.html:102-110`.
The only per-side difference is one extra symbol, `trackStuck as botTrackStuck`, imported by
environment-viewer-v2.html only (see §3).

**Think stagger — missing from B.** bot-viewer-v2.html scales down the full FSM decision-pass rate
for large rosters:

```
bot-viewer-v2.html:3128-3131
function botThinkStride(livingCount) {
  if (botThinkStaggerMode !== 'auto') return botThinkStaggerMode;
  return livingCount > 80 ? 3 : livingCount > 40 ? 2 : 1;
}
```
applied at `bot-viewer-v2.html:3341, 3364-3370` (`updateBotSentry` is skipped on off-stride frames;
physics/movement/rig still run every frame; dt is banked so timers integrate correctly). A matching
`rigLod`/`RIG_LOD_MID2`/`RIG_LOD_FAR2` system strides the procedural-body pose solve by camera
distance (`bot-viewer-v2.html:3069-3097`). `docs/subsystems/bots.md:3926-3939` documents both,
matching the measured code and citing a measured A/B result (sim 10-12ms → 8-9ms at 90 bots).

Confirmed absent from environment-viewer-v2.html by two methods: (a) `grep -n
"thinkStride|thinkDtAcc"` → 0 matches; (b) reading `updateBots(dt)` (`environment-viewer-v2.html:6993`)
shows it calls `botTickOne(id, rec, dt, nowMs)` for **every living bot, every frame, unconditionally**
(`:7054`), and `botTickOne` calls `updateBotSentry` with no stride gate (`:6726`). A `rigLod` grep also
returns 0 matches. **Both sides do share** the narrower `TARGET_SCAN_STRIDE = 4` acquisition-only
stride (`bot-viewer-v2.html:6405`, `environment-viewer-v2.html:3652`) — that one is not affected.

**Net effect:** environment-viewer-v2.html has no roster-size-scaled perf throttle for the bot brain
at all; every bot always runs its full decision pass and full-detail rig solve regardless of bot
count. This is a real, unmirrored capability gap, not flagged as a to-do anywhere in the docs.

### 2. Stuck detection — missing from A (the opposite direction of #1)

**Confirmed absent from bot-viewer-v2.html**, two methods: (a) `grep -n "trackStuck"
bot-viewer-v2.html` → 0 matches; `grep -ni "stuck"` → only prose/UI-string hits, no logic
(`bot-viewer-v2.html:2770, 7584, 9995, 12779, 14004`). (b) `bot-activity.js:238-247` defines
`trackStuck({speed, moving, stuckSince, nowMs})` (returns `{stuckSince, stuckMs}` once speed drops
below `STUCK_MIN_SPEED = 0.15` m/s while "moving" is expected) — it is exported but never imported by
bot-viewer-v2.html at all.

environment-viewer-v2.html wires it into a three-tier recovery system:
```
environment-viewer-v2.html:6767-6786 (botTickOne)
const stuck = botTrackStuck({ speed: dt > 0 ? movedDist / dt : 0, moving, stuckSince: rec.stuckSince, nowMs });
if (stuck.stuckMs > BOT_STUCK_FORCE_REPLAN_MS && pathMode != null) {
  if (nowMs >= (rec.stuckReplanAt ?? 0)) {
    currentPath = []; pathMode = null;
    rec.stuckReplanCount = (rec.stuckReplanCount ?? 0) + 1;
    rec.stuckReplanAt = nowMs + BOT_PATH_RETRY_MS;
  }
}
```
`BOT_STUCK_FORCE_REPLAN_MS = 3000` (`:2213`); escalates to a hard escape-teleport after
`BOT_STUCK_ESCAPE_RETRIES = 6` (`:2210`) failed replans, timing out at `BOT_ESCAPE_TIMEOUT_MS = 4000`
(`:2211`), steering straight for the nearest walkable cell and teleporting there as a last resort
(`:6722-6789`). The code's own comment states this plainly: *"stepBotPhysics, the fall catch and the
stuck/escape machinery are env-specific and stay from v1"* (`:6723`) — i.e. this is a deliberately
kept holdover from the pre-port codebase, not something dropped during the port, and
`docs/subsystems/bots.md:1228-1290, 1250` documents it accurately as environment-viewer-only, citing
`docs/superpowers/reviews/2026-07-18-bot-stuck-systemic-review.md Finding 1`.

**Verdict:** bot-viewer-v2.html — the harness this audit treats as authoritative — has zero
stuck-detection or replan-on-stuck logic of any kind. Its bounded synthetic maze apparently doesn't
trigger the failure modes (falling through collision gaps, being pushed off walkable ground by
`pushBotsApart`, terrain-zone grid boundary edges) that motivated this system in environment-viewer's
open/procedural terrain. Whether that omission is safe depends entirely on whether bot-viewer-v2.html
is ever run on the newer open-terrain nav-zone mode (per memory, "Open-terrain workspace" shipped
2026-07-26) — if so, it inherits none of this recovery behavior.

### 3. State encoding (bot-state-code.js) — loading strategy differs, behavior does not

bot-viewer-v2.html imports it statically (`:932-934`) and uses it purely for a debug/QA tracer:
`botStateDescriptor`/`pushBotStateTraceRow`/TSV export, gated by `botStateRecording`
(`bot-viewer-v2.html:2696-2960`); no gameplay/FSM decision reads the encoded value.
environment-viewer-v2.html dynamically imports it (`await import('./bot-state-code.js')` at
`:7093`) only when `?botTrace=1` is present, with an explicit comment: *"the QA instrument for the
bot-viewer-v2 brain port... Inert by default — with the flag off nothing is imported and the per-bot
cost is one boolean test"* (`:7072-7075`). **Verdict:** deliberate, documented optimization; no
behavioral difference, only load-time/bundle-cost difference. `docs/subsystems/bots.md`'s detailed
section on this (lines ~6805-6807) is accurate; its summary table entry doesn't mention the
dynamic-import path, a minor doc omission, not a code problem.

### 4. Stance system

Core FSM (`chooseBotStance`, `stepStanceTransition`, all speed/spread/height/turn-rate scale
functions) is imported and wired identically on both sides, and `STANCE_DEFAULTS` (crouchSpeedFactor
0.55, proneSpeedFactor 0.30, dashSpeedBonus 1.15, standUpMs 700, crouchUpMs 220, proneMinHoldMs 1200,
etc. — `bot-stance.js:28-56`) is spread into an identical local settings object on both sides
(`bot-viewer-v2.html:1499`, `environment-viewer-v2.html:3610`) with no numeric shadowing.

**Two capabilities confirmed missing from environment-viewer-v2.html:**
- `STANCE_RUN`, `STANCE_DASH`, `resolveStanceOverride` are absent from its `bot-stance.js` import
  (`environment-viewer-v2.html:146-148`, vs `bot-viewer-v2.html:929-931` which has all three). Grep
  confirms `STANCE_RUN`/`STANCE_DASH` appear only in comments in env-viewer, and
  `resolveStanceOverride` has zero matches at all. Because `STANCE_RUN`/`STANCE_DASH` are plain
  string constants compared by value inside `bot-stance.js` itself, the postures remain reachable at
  runtime through the FSM paths both sides share (dash reachable via the grenade-evade trigger,
  `environment-viewer-v2.html:6545`; run reachable via pursue/flee/cover-move/medic-move/knife
  states) — **except** the one path gated behind a "Double time" command-menu order
  (`bot-stance.js:104`, `state === 'patrol' && doubleTime` → RUN), which doesn't exist in
  environment-viewer-v2.html at all (`doubleTime`: 0 matches). `docs/subsystems/bots.md:1058-1101`
  correctly documents this as "not yet built (roadmap)... all in bot-viewer-v2.html," so it's a known
  gap, not a silent regression.
- `resolveStanceOverride` — a pure debug force-override (bot-viewer-v2.html:10714, feeding a dropdown
  UI at `:1085`, `:13535-13536`) has **no counterpart at all** in environment-viewer-v2.html; the
  code even says so in a comment: *"there is still no UI force-override"* (`environment-viewer-v2.html:6526`).
- 17 live stance-tuning sliders (`crouchSpeedFactor`, `proneSpeedFactor`, `dashSpeedBonus`, etc.,
  `bot-viewer-v2.html:13695-13714`) exist only in bot-viewer-v2.html; environment-viewer-v2.html's
  stance tuning is permanently pinned to `STANCE_DEFAULTS` with no in-session way to A/B it.

**One stale doc finding:** `docs/subsystems/bots.md:5696-5700` claims "no STANCE_DASH" for
environment-viewer-v2.html — this is now false; the grenade-evade phase wired `STANCE_DASH` in after
that doc section was written (`environment-viewer-v2.html:6134, 6545`). The doc's separate
`bot-stance.js` API table (lines 4665-4674) also omits `STANCE_DASH` from its posture list even
though the module exports five postures. Both are drift, worth a doc fix.

### 5. Perception — eye height (most significant single finding in this audit)

**Confirmed, quantified divergence.** bot-viewer-v2.html defines `EYE_LIFT = 0.85`
(`bot-viewer-v2.html:6652`, "fraction up the capsule used as eye/muzzle height, both bot and dummy")
and uses `eyePos`/`eyePosInto` (`:7102-7107`, `capsule.start.lerp(capsule.end, EYE_LIFT)`) at ~31 call
sites — aim origin, LOS checks, muzzle/fire origin, grenade throw origin, applied **symmetrically**
to both self and enemy.

environment-viewer-v2.html has **zero** matches for `EYE_LIFT` or `eyePos` anywhere (confirmed via
whole-file grep for both terms, plus a broader case-insensitive `eye` sweep to rule out a renamed
constant). Instead:
```
environment-viewer-v2.html:3426
function botEyeInto(entity, out) { out.x = entity.capsule.end.x; out.y = entity.capsule.end.y; out.z = entity.capsule.end.z; return out; }
```
— eye = the literal top of the capsule (100%, not 85%) — used for the **bot's own** eye. The
**enemy's** eye uses a third, different formula entirely: `humanAimInto` (`:3427`,
`state.p[1] + (state.h ?? 1.6) * 0.3`, a wire-pose-relative chest point, ≈1.26m), so
environment-viewer-v2.html's target-selection loop is asymmetric — self and target use different
anchor concepts, where bot-viewer-v2.html deliberately uses the identical function for both
("both bot and dummy").

**Capsule geometry is identical on both sides** (`bot-entity.js:11-12, 27-28`, `DEFAULT_RADIUS=0.3`,
`DEFAULT_STAND_HEIGHT=1.8`, shared module, both callers use the same defaults), so this is a real
height difference, not a labeling difference:
- bot-viewer-v2 eye: 0.3 + 0.85×1.2 = **1.32 m** above ground.
- environment-viewer-v2 self-eye: **1.50 m** above ground.
- **Delta: 0.18 m (18 cm) higher** in the port.

This 1.32 m figure independently cross-checks against the user's own memory note
`head-exposed-los-bug.md`, which already flagged "1.32 m eye ray" as a suspect constant — this audit
confirms that number is intentional in the reference harness and the port silently diverged from it.

**Why it matters:** eye/origin feeds the FOV-cone dot-product test, the LOS raycast start point, and
the muzzle/tracer origin on both sides — cover heights, peek-exposure thresholds, and near-miss
geometry tuned against the harness's 1.32 m eye do not transfer exactly to the shipped game's 1.50 m
eye.

**Secondary, port-introduced inconsistency:** in `selectBotTarget`, environment-viewer-v2.html gates
candidates using `targetEye = humanAimInto(candidate, ...)` (`:3979`) but the final LOS-confirmation
ray uses a *different* point, the raw wire-pose midpoint `candidate.p` (≈0.9m):
`botHasLineOfSight(origin, candidate.p, ...)` (`:4032`). bot-viewer-v2.html recomputes and uses
`targetEye` consistently for both the gate and the ray (`:6524`). Low practical impact at normal
engagement ranges (height-only deltas barely move 3D distance) but a real, unintentional
inconsistency introduced during the port.

### 6. FOV cones, LOS visibility field, alert propagation — mostly identical

- `withinBotFov` is mathematically identical on both sides (`bot-viewer-v2.html:6387`,
  `environment-viewer-v2.html:3890`), base `fovDegrees: 150` matches exactly
  (`bot-viewer-v2.html:7648`, `environment-viewer-v2.html:3590`), and tier scaling comes from the
  single shared `perceptionForTier` (`bot-alert.js:265-269`, `TIER_FOV_WARY=140`,
  `TIER_FOV_ALERTED=160`) called identically on both sides.
- `SIGHT_BLOCK_HEIGHT = 1.5` (`nav-visibility.js:8`) is applied internally by `buildSightGrid`
  regardless of what the caller imports; environment-viewer-v2.html additionally imports it
  (`:160`) to do an early pre-filter before building the blocker array (`:2317, 2423`) — a
  micro-optimization, not a behavior difference, since `buildSightGrid` enforces the same threshold
  either way.
- Visibility-field **build cadence** genuinely differs, architecturally: bot-viewer-v2.html rebuilds
  a full-map bake on every layout change (`:7503-7504`); environment-viewer-v2.html either bakes once
  at init (bounded shoot-house maps, `:2334`) or runs a budgeted, player-anchor-following "zone bake"
  across frames for open procedural terrain (`:2589`, triggered from `updateBotNavZone`,
  `:6631-6646`), explicitly because a full-map bake at 1200-4000m terrain scale would need "13 GB at
  1200m" (comment, `:2497-2499`). bot-viewer-v2.html has no equivalent zone-recentering system at all
  (0 matches for "ZoneBake"/"botNavZone"). This reads as a deliberate, necessary consequence of
  unbounded terrain, not an oversight.
- Alert propagation/escalation: **byte-for-byte identical** 28-symbol import list from `bot-alert.js`
  on both sides (`bot-viewer-v2.html:6638-6646`, `environment-viewer-v2.html:116-124`), and all seven
  escalation constants (`SEMI_ALERT_SHARE_RADIUS=6`, `ESCALATION_RADIUS=18`,
  `SEMI_ALERT_WARY_MS=1500`, `ALERT_DEFENSIVE_SCORE=2`, `ALERT_PUSH_SCORE=4`, `SUPPORT_GROUP_MIN=3`,
  `SUPPORT_RADIUS=10`, `bot-alert.js:123-129`) are unshadowed on both sides.
- Split attention (`stepAttention`/`attentionSweep`) is ported verbatim, with one behavior-changing
  addition: environment-viewer-v2.html's grenade-throw path (`updateGrenadeThrow`, `:6092`) calls the
  same `faceThreatAndAhead` used for combat facing, giving a bot the threat/travel attention sweep
  while winding up a throw; bot-viewer-v2.html's grenade path uses a simpler `faceTargetXZ`
  (`:9153`, snap-to-aim-point, no sweep) — a real, minor behavioral drift, arguably an improvement,
  introduced during the port.
- Contact memory: `contactRecency` (`bot-contacts.js:47-52`) is imported by bot-viewer-v2.html
  (`:6648`) but has exactly one match in the whole file — the import itself — meaning it is dead code
  on the reference side too, never called. environment-viewer-v2.html doesn't import it at all. Both
  sides' `selectBotTarget` comments say contact memory is "recorded but not yet consumed" — so this
  import gap changes nothing behaviorally today, though it's worth naming as a "not actually
  identical" import list.

### 7. Combat: aim, fire gating, reload, sidearm, disengage, grenade, melee

- **Aim core (bot-aim.js)**: identical import list, identical `AIM_DEFAULTS` (reactionMs 260,
  baseSpreadDeg 0.35, bloomPerShotDeg 0.45, bloomMaxDeg 4.0, etc. — `bot-aim.js:5-22`), and matching
  call sites for `reactionDelayMs`/`decayBloomDeg`/`bloomAfterShot`/`dispersedDirection`. **One
  drift**: environment-viewer-v2.html's fired-shot spread formula adds an extra term absent from the
  reference: `(spreadHalfAngleRad(...) + inaccuracy01 * BOT_MAX_SPREAD_RAD) * stanceSpreadScale(...)`
  (`:5830`) where `BOT_MAX_SPREAD_RAD = 0.15` (`:2196`) is scaled by a UI "accuracy" slider
  (`botAccuracy`, default 60, `:2177`) that has no counterpart at all in bot-viewer-v2.html (0
  matches). Fired accuracy therefore differs between the two harnesses even with identical
  `AIM_DEFAULTS`.
- **Fire gating**: the `readyToFire` boolean checks the same five conditions in the same effective
  order on both sides (`bot-viewer-v2.html:10413-10414`, `environment-viewer-v2.html:6307-6309`) —
  clean match.
- **Lead/target prediction**: neither side leads gunfire at a moving target — confirmed by
  `bot-pursuit.js:3-4`'s own comment ("Aim/fire stay present-position — shots are hitscan, so leading
  them would just miss") and by both `aimAnglesTo` call sites using the target's live position, not
  an extrapolated one. `interceptPoint`/lead math exists on both sides but is used only to choose a
  **movement** goal (where to run), not a firing direction — this is n/a-architectural, correctly
  symmetric.
- **Reload**: the trigger condition (`shouldTopOffReload`, `TOP_OFF_MAG_FRAC = 0.35`,
  `bot-activity.js:131-134`) is gated identically on both sides. Reload **duration** differs:
  bot-viewer-v2.html reads the actual mounted weapon's animation sequence duration, falling back to
  `BOT_RELOAD_FALLBACK_MS = 1800` only when no animation is present (`:1871-1886`, `:1474`);
  environment-viewer-v2.html uses a flat `BOT_RELOAD_MS = 1800` for every weapon unconditionally
  (`:2192`, `:3878, 3883`) — the fallback values happen to match, but env-viewer never varies by
  weapon. bot-viewer-v2.html also extends cover-peek hold across a reload (`:10841-10849`) with no
  environment-viewer-v2.html counterpart.
- **Sidearm swap (bot-sidearm.js)**: identical import list (`SIDEARM_DRAW_MS=550`,
  `SIDEARM_LULL_MS=2500`, `PISTOL_IDS=['m1911','five_seven']`, `bot-sidearm.js:6-9`), and both sides
  build an equivalent context object before calling the shared `chooseWeaponSlot` — clean match.
- **Disengage / heal threshold — the single highest-impact numeric drift found in this audit.**
  Caution honored: this is distinct from `pursueBreakThreshold` (a miss-streak count, not a
  distance/HP value) and from `pursueHealthThreshold01` (which does match at 0.60 on both sides —
  see below). The actual **heal/flee HP threshold** is a separate object:
  ```
  bot-viewer-v2.html:7656-7665            environment-viewer-v2.html:3611-3618
  threshold01: 0.60,                      threshold01: 0.35,   // at/below this HP a bot breaks off to heal
  resume01: 0.72,                         resume01: 0.85,      // heal until here
  safeDistance: 8.5,                      safeDistance: 12,    // healUnsafeBand centre
  safeHoldMs: 500,                        safeHoldMs: 900,     // unbroken safe time before heal starts
  ```
  bot-viewer-v2.html bots break off to heal at 60% HP and resume fighting at 72%;
  environment-viewer-v2.html bots fight on until 35% HP and must heal to 85% before rejoining — nearly
  double the damage absorbed before retreating, plus a larger/longer safety check before the heal
  channel even starts. This is a real, deliberate-looking but very consequential tuning divergence.
  Note for future auditors: bot-viewer-v2.html's heal threshold (0.60) and its **separate**
  `pursueHealthThreshold01` (also 0.60) happen to share a value on the reference side — almost
  certainly the source of the earlier audit's confusion — but they are two independent settings, and
  on the port side they no longer coincide (heal moved to 0.35; pursue stayed 0.60).
  `pursueBreakThreshold`/`pursueHealthThreshold01` themselves are confirmed identical on both sides
  (`bot-viewer-v2.html:7639-7640`, `environment-viewer-v2.html:3584-3585`, both `pursueMissStreak: 3`,
  `pursueHealthThreshold01: 0.60`, both consumed the same way at `:10438-10441` /`:6327-6330`).
- **Grenade/rocket**: ballistic math (`solveBallisticArc`/`sampleArcPoints`) is shared and identical.
  Delivery container differs architecturally — bot-viewer-v2.html spawns/updates flying ordnance via
  its own `createProjectileManager` instance (`:11431-11447`); environment-viewer-v2.html spawns
  through the game's `entityRegistry`/`CombatProjectileEntity` (`:6050`, `:14151`), consistent with
  the project's ongoing entity-registry migration (per user memory). This is a re-platform, not a
  missing feature — confirmed `createProjectileManager` has 0 matches anywhere in
  environment-viewer-v2.html. **One real behavior gap within this re-platform**: `grenadeEvade`'s
  4th parameter (`engagedId`, giving 1.25× exit-radius hysteresis so a bot doesn't flap in and out of
  evade at the blast-radius boundary, `bot-grenade.js:132-135,144-145`) is passed on bot-viewer-v2.html
  (`:9291`, tracked via `actor.grenadeEvadeId`) but omitted on environment-viewer-v2.html (`:6125`,
  confirmed 0 matches for `grenadeEvadeId` anywhere in the file) — the hysteresis feature is present
  in the shared module but never activated by the port.
- **Melee (knife)**: range/damage come from the shared `weapons.js` (not in this snapshot, but
  single-sourced by construction on both sides). Commit-timeout constants differ:
  `KNIFE_COMMIT_MAX_MS`/`KNIFE_COMMIT_COOLDOWN_MS` = 8000/5000 on bot-viewer-v2.html (`:6686-6687`)
  vs 12000/6000 on environment-viewer-v2.html (`:3653-3654`) — cross-checked against
  `docs/subsystems/bots.md:5413, 6426`, which documents the same two pairs independently, confirming
  this is a known, not accidental, divergence. The swing-cooldown *mechanism* also differs:
  bot-viewer-v2.html uses a bespoke local `lastKnifeAt` timer (`:7752` etc.); environment-viewer-v2.html
  routes the swing through the shared `applyCombatIntent`/`validateShot` pipeline used by every other
  weapon (0 matches for `lastKnifeAt` in env-viewer) — architectural re-platform, internals of
  `validateShot`'s rate-limiting unverified (combat.js absent from snapshot).
- **Hitscan primitive**: bot-viewer-v2.html imports `rayCapsuleHit` from combat.js and uses it in
  exactly one place — its own projectile-vs-body sweep test (`:11424`), not gun hitscan (gun hitscan
  uses `resolveHitscan` directly). environment-viewer-v2.html doesn't import `rayCapsuleHit` at all (0
  matches) — its equivalent projectile raycast delegates to `resolveWorldShot`→`resolveHitscan`
  (`:14097-14105`, `:13635-13657`), the same pipeline used for every gun's hitscan. This is
  consolidation onto one shared hit-resolution path, not a missing capability — though full
  confirmation that `resolveHitscan` performs equivalent per-target capsule math internally is
  INFERRED, not directly verified (combat.js not in the snapshot).

### 8. Roles, squads, medic, health packs, scoreboard

- **Roles**: import lists match (reordered only), `assignRolesToBatch` is called at an equivalent
  spawn-time point on both sides, and all three role-conditioned behavior fields
  (`sightScale`/`closeRange`/`swapOnDryMag`) are actively read on both sides, not just assigned —
  confirmed via matching usage sites (`bot-viewer-v2.html:1743,1831-1832`,
  `environment-viewer-v2.html:3794,3864-3865`).
- **Squads/formations**: `squadSlotWorld` is imported only by bot-viewer-v2.html (`:920-922`), but
  `squadMemberGoal` — the function that actually drives per-frame formation *movement* on both sides
  — calls `squadSlotWorld` **internally** inside the shared `bot-squad.js` module
  (`bot-squad.js:251-259`). So formation-slot placement for movement is not degraded in the port;
  bot-viewer-v2.html's own call to `squadSlotWorld` (`:7072-7076`) is purely for a **debug
  visualization** (rings + tether lines to the leader) that has no counterpart at all in
  environment-viewer-v2.html (`squadDebugSlot`/`squadDebugRing`: 0 matches) — a QA-tooling gap, not a
  gameplay gap. `SQUAD_DEFAULTS` (spacing 2.4, ringScale 2.5, slotArrive 1.2, leash 22,
  `bot-squad.js:20-25`) is spread into an identical local object on both sides with no numeric drift.
- **Medic**: `cohesionTarget` is called identically on both sides and doesn't depend on the missing
  `teamCentroid` import. `teamCentroid` itself, missing from environment-viewer-v2.html's import, is
  used on bot-viewer-v2.html only for flee-goal squad-cohesion bias (`:8860`); environment-viewer-v2.html
  reimplements the identical mean-XZ math locally as `fleeSquadCentroid` (`:5487-5501`) rather than
  reusing the shared helper — code duplication, not a behavior gap. **Genuine functional gap**: the
  "creep to contact" final approach (`MEDIC_CONTACT_RADIUS=0.85`, `MEDIC_CONTACT_CREEP=0.45`,
  `bot-medic.js:42-47`) is wired on bot-viewer-v2.html (`creepToContact`, `:9928-9934`, explicit
  comment: "without this the medic stops up to 1.7m short and treats an ally at arm's length plus a
  metre") but entirely absent from environment-viewer-v2.html's `updateMedicTend` (`:4601-4628`,
  0 matches for `creepToContact`) — the port's medic zeroes velocity on TEND entry and never closes
  the last stride, so it can visually heal/revive from up to ~1.7-2.6m away instead of ~0.85m contact
  distance. Purely positional/visual — heal HP/sec and revive timers are unaffected.
- **Health packs**: `packsTotalHp` (sum of remaining heal HP across carried packs,
  `bot-health-packs.js:14`) is imported only by bot-viewer-v2.html, used solely in its debug HUD
  (`:15581`, `packs:N (XXhp)`). environment-viewer-v2.html's equivalent HUD line
  (`:10100`, `packs: ${rec.healthPacks.length}/${rec.maxPacks}`) shows pack count/capacity but not
  remaining heal value — a HUD-only gap, no decision logic anywhere depends on `packsTotalHp`.
- **Scoreboard**: `createScoreboard`/`recordKill`/`finishRound`/`decideRoundOutcome` are wired
  identically, so the underlying data (spawns, kills, revives, round history) is tracked the same way
  on both sides. But `resetScoreboard` is imported only by bot-viewer-v2.html, wired to a dedicated
  reset button (`:12942`); environment-viewer-v2.html's `botScore` is declared `const` once
  (`:3702`) and never reset or reassigned anywhere in the file — **there is no way to reset the
  scoreboard short of reloading the page.** `formatBreakdownLines` (per-team weapon/cause/role
  attribution) and `formatRoundLine` (per-round history) are likewise imported only by
  bot-viewer-v2.html and used in its detail panel (`:12968-12984`); environment-viewer-v2.html's
  scoreboard render (`:3739-3741`) only shows the round header plus one team-score line per team —
  the underlying `botScore.rounds` history is still populated by `finishRound` but never surfaced to
  any UI.

### 9. Navigation: grid build, routing, connectivity, cover, danger, separation, terrain

- **`finalizeNavGrid`**: `buildNavGrid` calls it internally (`nav-grid.js:44`), so any single-call,
  single-frame bake (bot-viewer-v2.html's one `buildNavGrid` call per map load, `:7491-7492`) needs
  no separate import. `finalizeNavGrid` exists specifically so a bake too large for one frame can
  sample incrementally and finalize once — environment-viewer-v2.html's open-terrain "combat zone"
  grid does exactly that, sampling `terrainHeight` row-by-row across frames
  (`stepBotZoneBake`, `:2478-2498`) then calling `finalizeNavGrid` once sampling completes
  (`:2506-2509`). Confirmed absent from bot-viewer-v2.html by whole-file grep (0 matches) — this is
  architectural, not a gap: bot-viewer-v2.html's bounded synthetic maze is small enough to bake
  synchronously.
- **A* vs flood-fill dispatch**: both sides use the identical rule — `floodFill` (bounded Dijkstra)
  for flee goals, `findPath` (A*) for pursue/patrol goals — through a shared, identically-tuned
  budgeted wrapper (`REPLAN_COOLDOWN_MS=300`, `REPLAN_BUDGET_PER_FRAME=8`, matching on both sides).
  Quoted flee-goal call sites are nearly line-for-line identical
  (`bot-viewer-v2.html:8839-8846`, `environment-viewer-v2.html:5440-5443`, the latter's comment
  explicitly says "harness parity").
- **Region labeling/connectivity**: fully shared logic in `nav-grid.js` (`labelRegions`,
  `connectStrandedRegions`, invoked transparently by both `buildNavGrid` and `finalizeNavGrid`). Both
  HTML files independently reimplement an almost line-for-line identical "patrol point unreachable
  from this region" diagnostic (`bot-viewer-v2.html:8370-8400`, `environment-viewer-v2.html:4979-4996`,
  same log text). **One minor logging gap**: bot-viewer-v2.html's build-time report separately warns
  on `navGrid.sealedRegions.length` (`:7167-7192`); environment-viewer-v2.html folds carved-cell and
  stranded-region counts into one combined log line but does not separately warn about sealed regions
  — the underlying data is still present and shown in both sides' debug HUD dumps, so this is
  cosmetic.
- **Goal claims**: `createGoalClaims` lifecycle (claim on goal-select, release on
  abandon/reached/despawn, across the same six kinds: cover/flee/seek/pursue/recover/pack) matches
  at every corresponding call site on both sides. environment-viewer-v2.html has one extra claim call
  (`:2600`, re-claiming a cover cell after a corner-map remap following a terrain-zone rebake) — an
  architecture-driven addition (bot-viewer-v2.html's static maze never needs to remap corners after
  load), not a gap.
- **Cover corner seat band (`COVER_ANCHOR_REACH`)**: `bot-cover.js:75-79` defines
  `COVER_ANCHOR_REACH = 0.45` (m), consumed internally by the shared `coverSeatBand()`, which both
  sides call identically — so bot-viewer-v2.html never needs to import the raw constant directly
  (confirmed via its own comment, `:7585`: "seat arrive/leave thresholds now live in bot-cover.js").
  environment-viewer-v2.html imports it additionally to derive
  `COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6` (`:5700-5705`), with a comment explaining
  why: its terrain-zone grid cell size (`BOT_LOCAL_NAV_CELL = 1.5`, `:2206`) is 3x coarser than
  bot-viewer-v2.html's maze grid (`NAV_CELL = 0.5`, `:7154`), so a path waypoint can land up to ~1.06m
  from the cover anchor — outside the 0.45m seat band — without this direct-walk correction. A
  deliberate, quantitatively-justified addition, not drift.
- **Danger field**: import lists byte-identical; all constants
  (`DANGER_DEATH_WEIGHT=1.0, DANGER_HIT_WEIGHT=0.35, DANGER_FLEE_SCALE=6, DANGER_PATROL_SCALE=4,
  DANGER_PACK_SCALE=3`, `bot-danger.js:8-19`) unshadowed on both sides — full parity.
- **Separation/pushout**: `SEPARATION_RADIUS=1.5`, `SEPARATION_WEIGHT=0.5`,
  `WAYPOINT_CONTEST_RANGE=0.75` identical on both sides, call sites near-identical. One documented
  addition: environment-viewer-v2.html's pass radius adds `BOT_COLLIDE_PAD=0.05` (`:3232-3238`),
  explicitly commented as "the harness has no equivalent of" — needed because the port also has to
  keep bots from phasing into the local player, a concept the harness doesn't model.
- **Terrain-aware pathing**: `nav-grid.js`'s `findPath` costs slope directly off `grid.heights` via
  `slopeFactor` (`:224-231`) — a no-op when `grid.heights` is null. bot-viewer-v2.html optionally
  supplies synthetic terrain via `bot-terrain.js` (default-off, `:810, 827, 7491-7492`).
  environment-viewer-v2.html never imports `bot-terrain.js` at all (confirmed via two independent
  case-insensitive whole-file greps for "bot-terrain" and "BOT_TERRAIN_DEFAULTS"/"footprintRange," all
  0 matches) but is **not terrain-blind**: both its persistent zone grid
  (`stepBotZoneBake` sampling real `terrainHeight`, `:2478-2495`, feeding `finalizeNavGrid`) and its
  local-window fallback (`buildLocalNavWindow`, `:3328`, `heightAt: terrainHeight`, explicit comment
  "Slope-costed since Phase D") feed real game terrain into the same shared `slopeFactor` cost
  function bot-viewer-v2.html's optional mode uses. `bot-terrain.js` exists purely to synthesize fake
  uneven ground for the harness's otherwise-flat maze; environment-viewer-v2.html never needed it
  because it already has real terrain wired directly. Architectural, not a gap in either direction.
- **Path-level stuck/replan**: covered in §2 above — this is the path-level half of the same
  environment-viewer-v2.html-only system (`BOT_STUCK_FORCE_REPLAN_MS`, `BOT_STUCK_ESCAPE_RETRIES`,
  escape-teleport), confirmed absent from bot-viewer-v2.html by the same two grep methods
  (`pathFailCount`, `stuckReplanCount`, `escapeTarget`, `BOT_STUCK_ESCAPE_RETRIES`: all 0 matches).

---

## Ranked list of most significant parity gaps

1. **Heal/flee HP threshold: 0.60 vs 0.35** (§7). The single highest-impact behavioral divergence
   found. Environment-viewer-v2.html bots absorb roughly double the damage before disengaging to
   heal, and must heal much further (85% vs 72%) before rejoining combat. This changes squad
   attrition, fight duration, and perceived bot "toughness" directly, and looks like a deliberate
   tuning change rather than an accidental drift — but it means QA/tuning done against
   bot-viewer-v2.html's combat pacing does not transfer to the shipped game's pacing.

2. **Eye/aim/perception anchor height: 1.32m vs 1.50m, plus an internal self/target inconsistency**
   (§5). This is the anchor point for FOV cones, LOS rays, and muzzle/tracer origin on both sides.
   An 18cm difference is large enough to change what counts as "exposed" over a given cover height,
   and the port additionally uses two different formulas for self vs. target eye position where the
   reference harness deliberately uses one. Directly corroborated by the user's own prior bug note on
   the 1.32m constant.

3. **Roster-scaled think-stagger + rig-LOD perf throttle missing from the port** (§1). At high bot
   counts (the harness's own docs measure a -25% sim-time win from this at 90 bots), the port pays
   full per-bot FSM + full-detail rig cost every frame with no scaling knob — a live performance risk
   at scale that has no equivalent mitigation in environment-viewer-v2.html today.

4. **Stuck-detection / force-replan / escape-teleport present only in the port, absent from the
   reference harness** (§2, §9). Not obviously a bug — it's a documented holdover from env-viewer's
   pre-port codebase addressing open-terrain-specific failure modes — but it means bot-viewer-v2.html
   offers no guarantee of recovering a genuinely wedged bot, which matters if/when the harness is used
   with the open-terrain nav mode that motivated this system in the first place.

5. **Medic "creep to contact" missing from the port** (§8). Medics in environment-viewer-v2.html can
   visually heal/revive from up to ~1.7-2.6m away instead of closing to ~0.85m contact distance —
   purely positional, but visually wrong and easy for a player to notice ("medic healing me from
   across the room").

6. **Grenade-evade exit hysteresis inert in the port** (§7). The shared module supports a 1.25×
   exit-radius scale specifically to prevent boundary-chatter when a bot is right at the edge of a
   blast radius; the port never activates it, so this specific flicker/chatter failure mode is
   possible in the shipped game but not in the harness.

7. **Reload duration: per-weapon animation-driven vs. flat 1800ms** (§7). Minor on its own, but it
   means per-weapon reload feel authored in the harness (fast pistol reload vs. slow rifle reload,
   if such variation exists in the animation data) does not carry over to the port.

8. **Knife commit-timeout constants differ (8000/5000ms vs 12000/6000ms)** (§7). Confirmed
   intentional (both values independently documented in `bots.md`), but still a real behavioral
   difference in how long a bot will commit to closing for a melee kill before giving up.

9. **Scoreboard: no reset, no kill-attribution breakdown, no round history in the port** (§8). Not
   gameplay-affecting, but a real functional gap for anyone using the in-game scoreboard for the same
   purposes the harness's is used for (repeated test rounds, post-round analysis).

10. **Squad debug visualization (slot rings/tethers) entirely absent from the port** (§8), and
    **stance manual-override + 17 tuning sliders entirely absent from the port** (§4). Both are pure
    QA/tooling gaps with zero gameplay impact, but they matter for this audit's purpose: anyone trying
    to debug port-side squad or stance behavior in the field has strictly less visibility than the
    harness offers.

---

## Absence claims and how each was confirmed

Per claim: the two independent methods used, per the task's methodology requirement.

| Absence claim | Method 1 | Method 2 |
|---|---|---|
| `trackStuck` absent from bot-viewer-v2.html | grep bare `trackStuck` across whole file → 0 matches | grep case-insensitive `stuck` across whole file → only prose/UI-string hits, no logic reimplementation |
| `pathFailCount`/`stuckReplanCount`/`escapeTarget`/`BOT_STUCK_ESCAPE_RETRIES` absent from bot-viewer-v2.html | grep each bare symbol across whole file → 0 matches each | read `bot-activity.js`'s `trackStuck` export + env-viewer's `botTickOne` call site to confirm what the missing machinery would need to hook into, then confirmed no equivalent hook exists in bot-viewer-v2.html |
| `bot-state-code.js` not statically imported by environment-viewer-v2.html | grep the full static-import block region (lines ~37-163) — absent | grep `bot-state-code` and `encodeBotState` across the whole file → found only inside the `?botTrace=1`-gated dynamic `import()` and its call sites |
| `STANCE_RUN`, `STANCE_DASH`, `resolveStanceOverride` absent from environment-viewer-v2.html's bot-stance.js import | diff the full import statement against bot-viewer-v2.html's | grep each bare symbol across the whole file — `STANCE_RUN`/`STANCE_DASH` found only in comments (confirming no aliasing), `resolveStanceOverride` 0 matches anywhere |
| `doubleTime` (Double-time order → STANCE_RUN) absent from environment-viewer-v2.html | grep `doubleTime` across whole file → 0 matches | read `bot-viewer-v2.html`'s `doubleTimeCheckbox`/`commandDoubleTime` UI wiring to confirm what would need a counterpart, confirmed none exists; cross-checked `docs/subsystems/bots.md:1058-1101` which independently documents this as bot-viewer-v2.html-only/roadmap |
| `EYE_LIFT`/`eyePos`/`eyePosInto` absent from environment-viewer-v2.html | grep `EYE_LIFT` across whole file → 0 matches | grep `eyePos` across whole file → 0 matches; additionally a broad case-insensitive `eye` sweep to rule out a renamed 0.85-style lerp constant, which surfaced `botEyeInto`/`humanAimInto` as the actual (different) mechanism instead |
| `squadSlotWorld` absent from environment-viewer-v2.html | diff the full bot-squad.js import statement against bot-viewer-v2.html's | grep bare `squadSlotWorld` across whole file → 0 matches; then read `bot-squad.js`'s `squadMemberGoal` to confirm it calls `squadSlotWorld` internally, so movement behavior is unaffected despite the missing direct import |
| `squadDebugSlot`/`squadDebugRing`/squad debug overlay absent from environment-viewer-v2.html | grep those symbol names across whole file → 0 matches | read bot-viewer-v2.html's actual debug-draw call site (`:7063-7084`) to confirm what a port equivalent would need to contain, confirmed no equivalent draw call exists anywhere in env-viewer |
| `teamCentroid` absent from environment-viewer-v2.html's bot-medic.js import | diff the full import statement | grep bare `teamCentroid` across whole file → 0 matches; then located `fleeSquadCentroid` as a local reimplementation of the same math, confirming behavior is preserved via duplication rather than truly missing |
| `MEDIC_CONTACT_RADIUS`/`MEDIC_CONTACT_CREEP`/`creepToContact` absent from environment-viewer-v2.html | diff the full import statement | grep bare `creepToContact` (and the two constants) across whole file → 0 matches each; read `updateMedicTend` in full to confirm no equivalent final-approach step exists anywhere in that function |
| `packsTotalHp` absent from environment-viewer-v2.html | diff the full import statement | grep bare `packsTotalHp` across whole file → 0 matches; located env-viewer's actual HUD line to confirm it shows a different, less-informative metric rather than an equivalent one |
| `resetScoreboard`/`formatBreakdownLines`/`formatRoundLine` absent from environment-viewer-v2.html | diff the full import statement | grep each bare symbol across whole file → 0 matches each; then grepped all 16 references to `botScore` in the file to confirm it's declared `const` and never reset/reassigned anywhere |
| `finalizeNavGrid` absent from bot-viewer-v2.html | diff the full nav-grid.js import statement | grep bare `finalizeNavGrid` across whole file → 0 matches; read `nav-grid.js`'s `buildNavGrid` to confirm it calls `finalizeNavGrid` internally, explaining why a direct import is unnecessary for a single-call bake |
| `COVER_ANCHOR_REACH` absent from bot-viewer-v2.html | diff the full bot-cover.js import statement | grep bare `COVER_ANCHOR_REACH` across whole file → 0 matches; located the explaining comment at `:7585` confirming bot-viewer-v2.html deliberately never reads the raw constant, only the wrapping `coverSeatBand()` |
| `bot-terrain.js` / `BOT_TERRAIN_DEFAULTS` / `createTerrainField` / `footprintRange` absent from environment-viewer-v2.html | grep case-insensitive `bot-terrain` across whole file → 0 matches | grep `BOT_TERRAIN_DEFAULTS`, `createTerrainField`, and `footprintRange` individually across whole file → 0 matches each; then read `stepBotZoneBake`/`buildLocalNavWindow` to confirm a *different*, terrain-system.js-based mechanism supplies the same `heightAt` input to `nav-grid.js` instead |
| `grenadeEvadeId` (evade exit hysteresis) absent from environment-viewer-v2.html | diff the `grenadeEvade(...)` call arguments against bot-viewer-v2.html's 4-argument call | grep bare `grenadeEvadeId` across whole file → 0 matches, confirming the parameter is never tracked or passed anywhere, not just omitted at one call site |
| `rayCapsuleHit` absent from environment-viewer-v2.html's combat.js import | diff the full import statement | grep bare `rayCapsuleHit` across whole file → 0 matches; traced env-viewer's actual projectile-raycast call site to confirm it delegates to `resolveWorldShot`/`resolveHitscan` instead, a different (consolidated) pipeline |
| `lastKnifeAt` (bespoke knife cooldown timer) absent from environment-viewer-v2.html | read env-viewer's `fireBotKnife` in full — no local cooldown check present | grep bare `lastKnifeAt` across whole file → 0 matches, confirming no cooldown tracking exists anywhere outside the shared `applyCombatIntent` path |
| `createProjectileManager` absent from environment-viewer-v2.html | diff the full bot-projectiles.js import statement | grep bare `createProjectileManager` across whole file → 0 matches; confirmed the actual grenade/rocket spawn call sites use `entityRegistry.create('combat-projectile', ...)` instead |
| `contactRecency` — present in bot-viewer-v2.html's import but otherwise absent everywhere else in that same file | grep bare `contactRecency` across bot-viewer-v2.html → exactly 1 match, the import line itself | read the surrounding `selectBotTarget` code and its own comment ("recorded but not yet consumed") to confirm it is genuinely unused, not just hard to find |
| `botThinkStride`/`thinkDtAcc`/`rigLod` absent from environment-viewer-v2.html | grep each bare term across whole file → 0 matches each | read `updateBots(dt)`/`botTickOne` in full to confirm every living bot runs `updateBotSentry` unconditionally every frame, with no stride gate of any kind |
| `doubleTime` — see above (listed once; applies to both the stance and command-menu claims) | — | — |

---

## Notes on methodology and confidence

- Every numeric constant comparison above quotes the full defining line (or a tight excerpt) from
  both files, and each was cross-checked for "same setting, not a look-alike" before being reported
  as a match or a drift — most explicitly for the heal-threshold vs. pursue-threshold pair (§7),
  which a prior audit round is known to have confused.
- Five independent sub-agents did the primary file reading; each was instructed to use the two-method
  absence rule and to tag MEASURED vs. INFERRED. The handful of INFERRED claims in this document are
  called out inline (mainly around `combat.js`/`weapons.js` internals and `entity-types/combat-projectile.js`,
  none of which were present as standalone files in the frozen snapshot — only their consumers were
  read).
- `docs/subsystems/bots.md` was spot-checked against several of the findings above (think-stagger,
  stuck-detection, stance/STANCE_DASH, knife commit-timeout constants) and found accurate except for
  two stale points, both noted in §4: the "no STANCE_DASH" claim at `bots.md:5696-5700` and the
  missing `STANCE_DASH` entry in the `bot-stance.js` API table at `bots.md:4665-4674`.
