# Bot brain / navigation parity report — agent-3

Comparing:
- **A) bot-viewer-v2.html** (~15,700 lines) — reference/authoritative standalone bot harness
- **B) environment-viewer-v2.html** (~14,700 lines) — game-side viewer the bot system was ported into

All findings below are **MEASURED** (read directly with Grep/Read against both files and the shared
modules) unless explicitly marked **INFERRED**. Two claims in an earlier draft pass were wrong and are
called out explicitly in "Corrections made during this investigation" — they are fixed in the tables
below.

**Methodology caveat (measured):** both HTML files show `git status` as already-modified working-tree
files (uncommitted local changes pre-dating this session), and line numbers for the same string
observably shifted between two greps run minutes apart during this investigation (e.g. a `BOT_FIRE`
match moved from line 6604 to line 6618 in `environment-viewer-v2.html` with no edit from this agent).
The repo is being edited concurrently by something outside this investigation. Line numbers below are
accurate as of the specific read/grep that produced them, but may have since drifted by a handful of
lines. Function names, call shapes, and constant values are the load-bearing evidence, not exact line
numbers.

## Corrections made during this investigation

Two claims drafted mid-investigation were **wrong** and are corrected here rather than repeated:

1. **bot-contacts.js is NOT missing from environment-viewer-v2.** It is imported at
   `environment-viewer-v2.html:79` (`createContactMemory, recordContactSighting, markContactsUnseen`)
   and called at lines 3996, 4001, 4003. Only `contactRecency` is not imported there — but `contactRecency`
   has **zero call sites in either file** (confirmed by grep), so it is a dead/unused export in
   `bot-viewer-v2.html` too (imported at lines 6647–6649, never called). No functional gap.
2. **bot-score.js is NOT missing from environment-viewer-v2.** It is imported at
   `environment-viewer-v2.html:80-81` (`createScoreboard, recordSpawn, recordKill, recordRevive,
   decideRoundOutcome, finishRound, formatRoundHeader, formatTeamScore`) and actively used: `createScoreboard`
   at line 3702, `recordSpawn` at 2778, `recordRevive` at 4638, `recordKill` at 14034, and a
   `flushBotScore` wrapper (line 3724) that calls `decideRoundOutcome`/`finishRound` on a 1 Hz clock. Both
   harnesses have live round/kill/revive scoring. The only real gap is three formatting/reset helpers
   (see table).

## Summary table

| Area | bot-viewer-v2 | environment-viewer-v2 | Verdict |
|---|---|---|---|
| FSM dispatcher structure (grenade-evade > grenade-throw > hold > AIM/FIRE > KNIFE > MEDIC_MOVE/TEND > PURSUE > FLEE > HEAL) | inline, ~10730–10780 | inline, ~6500–6545 | identical (structurally) |
| Think cadence / staggering | `botThinkStride()` gates the **entire** per-bot sentry think (skips non-focus bots on non-stride frames) | only a narrower stride gates **target re-acquisition** inside `selectBotTarget`; the full sentry think runs every frame for every bot | **drifted — significant** |
| Eye / muzzle height | `capsule.start.lerp(capsule.end, 0.85)` (`EYE_LIFT=0.85`) | `entity.capsule.end` (100%, top of capsule) | **drifted** |
| bot-activity.js FSM states/exports | full import, lines 6609–6615 | full import, lines 97–105, identical export set | identical |
| bot-alert.js (alert tiers, split attention, near-miss, escalation) | full import, 6638–6646 | full import, 111–119, identical export set | identical |
| bot-contacts.js (sighting memory) | imports incl. dead `contactRecency` | imports 3 of 4 (no `contactRecency`, also unused) | identical (see correction) |
| bot-aim.js (spread/bloom/lead) | full import, identical set | full import, identical set | identical |
| bot-sidearm.js (swap/draw) | `pickSidearmId(primaryId, seed)` | `pickSidearmId(primaryId, seed)` — same call | identical |
| bot-grenade.js (throw decision) | `chooseGrenadeThrow(...)` same shape | `chooseGrenadeThrow(...)` same shape | identical |
| bot-grenade.js (evade hysteresis) | `grenadeEvade(bodyPos, threats, settings)` — **3 args, no `engagedId`** | `grenadeEvade(self, threats, settings, actor.grenadeEvadeId)` — **4 args, hysteresis active** | **drifted — env-viewer has MORE** |
| bot-projectiles.js manager | `createProjectileManager(...)` instantiated directly (~line 11431) | not used; bot ordnance flows through the game's `ProjectileEntity`/`CombatProjectileEntity` entity-registry types instead | architectural difference (not a gap) |
| bot-pursuit.js | identical import/use | identical import/use | identical |
| Knife commit timing | `KNIFE_COMMIT_MAX_MS=8000`, `KNIFE_COMMIT_COOLDOWN_MS=5000` | `KNIFE_COMMIT_MAX_MS=12000`, `KNIFE_COMMIT_COOLDOWN_MS=6000` | **drifted (numeric)** |
| Knife engagement debug ring | `knifeEngagementDistance` (default 8.0, UI slider) sizes a debug-only ring mesh; actual trigger has no distance gate (confirmed by code comment) | no equivalent debug ring | missing from B (cosmetic only) |
| bot-roles.js | full import, same set (reordered) | full import, same set | identical |
| bot-squad.js | full import + `squadSlotWorld` | full import, no `squadSlotWorld` | **missing from B** |
| bot-medic.js | full import + `teamCentroid`, `MEDIC_CONTACT_RADIUS`, `MEDIC_CONTACT_CREEP` | full import, missing those 3 | **missing from B** |
| bot-health-packs.js | full import + `packsTotalHp` (HUD pack-hp tag) | full import, no `packsTotalHp` | missing from B (cosmetic HUD) |
| bot-stance.js core FSM (`chooseBotStance`, `stepStanceTransition`, speed/spread/height/turn scalers) | full import | full import, same functions | identical |
| bot-stance.js `resolveStanceOverride` (manual debug override) | imported + used (`~10714`) | not imported, zero uses | missing from B (debug tooling only) |
| bot-score.js core (scoreboard/round outcome/kill/revive) | full import (11 exports) | 8 of 11 exports imported and actively used | mostly identical (see correction) |
| bot-score.js (`resetScoreboard`, `formatBreakdownLines`, `formatRoundLine`) | imported | not imported | missing from B (cosmetic/reset-helper only) |
| bot-state-code.js (9-char state trace) | static top-level import; `encodeBotState` called unconditionally per bot | dynamic `import()` only behind `?botTrace=1`; off by default | **drifted (default-on vs opt-in)** |
| bot-entity.js core (physics, separation, waypoint contest, goal claims) | full import | full import, same functions, same call sites | identical |
| bot-entity.js `createBotForensics` (BB-004 forensic ring) | imported (line 909) | **not imported anywhere** | **missing from B** |
| nav-grid.js core (`buildNavGrid`, `findPath`, `floodFill`, `floodPath`, `regionAt`, etc.) | full import, aliased-free | full import, several aliased (`botFindPath` etc.), same functions | identical (naming only) |
| nav-grid.js `finalizeNavGrid` | **not imported** | imported (line 111) and called (line 2506) | **missing from A** (env-viewer is ahead here) |
| nav-visibility.js `SIGHT_BLOCK_HEIGHT` | **not imported** | imported (line 160) and used (2317, 2423) | **missing from A** |
| bot-cover.js `COVER_ANCHOR_REACH` | **not imported** | imported (line 130) and used (`COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6`, line 5705) | **missing from A** |
| bot-cover.js core (peek cycle, corner validity, blacklist, flee scoring) | full import | full import, same functions | identical |
| bot-danger.js (slope/danger cost weights) | full import, same 5 weight constants | full import, same 5 weight constants | identical (no override found) |
| bot-terrain.js (standalone uneven-ground overlay) | imported (line 810), default-off per project memory | not imported | N/A — env-viewer already has a real CDLOD terrain driving its nav grid height; bot-terrain.js is a synthetic-floor-only feature specific to the standalone harness |
| Separation / pushout call shape | `resolveBotPairsHashed(living, botHash)` — 2 args, radius defaults null | `resolveBotPairsHashed(living, botHash, maxR + BOT_COLLIDE_PAD*0.5)` — 3 args, explicit bound | minor drift (perf-tuning only; `SEPARATION_RADIUS`/`SEPARATION_WEIGHT` constants identical: 1.5 / 0.5 in both) |
| Goal claims / flood-fill / corner map usage | all called (multiple sites each) | all called (multiple sites each); `buildCornerMap` called twice vs once in A | identical in kind; env-viewer's double corner-map build not fully explained (see open item) |
| Squad/role active wiring (`assignRolesToBatch`, `electSquadLeader`, `stepSquadSuccession`, `chooseFormationKind`) | all called every relevant frame/event | all called every relevant frame/event, matching argument shapes | identical |

## Detailed findings by area

### Think cadence / staggering (significant)

`bot-viewer-v2.html:3128` defines `function botThinkStride(livingCount)`. It is read once per frame at
`bot-viewer-v2.html:3341` (`const thinkStride = botThinkStride(rebuildBotHash().length);`) inside
`updateAllBots()` (starts line 3329), and gates the entire per-bot think at
`bot-viewer-v2.html:3365-3369`:

```
if (thinkStride === 1 || actor === focus ||
    (botFrameCounter + (actor.scanPhase ?? 0)) % thinkStride === 0) {
  updateBotSentry(actor.thinkDtAcc, now);
  ...
}
```

Non-focus bots simply do not run their sentry/FSM step on frames that don't line up with their
`scanPhase`. There is a UI toggle, "Think stagger: ..." at `bot-viewer-v2.html:12644`.

`environment-viewer-v2.html` has **no equivalent**: grepping the whole file for `botThinkStride`,
`thinkStride`/`ThinkStride`, `THINK_INTERVAL`, and `stagger` in a think/cadence context returns zero
matches outside comments. Its `updateBots(dt)` function (`environment-viewer-v2.html:6971`) calls
`updateBotSentry(rec, dt, nowMs)` unconditionally for every living bot in the `for (const [id, rec] of
botPlayers)` loop (call site ~line 6726). The only stride-like mechanism found is inside
`selectBotTarget()` (`environment-viewer-v2.html:3966-3974`), which throttles **target re-acquisition
only** (`TARGET_SCAN_STRIDE` / `activeBot.tierPerception?.scanStride`), not the full think step.

**Why it matters:** bot-viewer-v2's think-stagger was shipped specifically to sustain frame rate at
high bot counts (project memory: "think stagger... SHIPPED; A/B verified; maze sim -40%" and a "90-bot
profile" note). Environment-viewer-v2 pays the full per-bot AI cost every frame for every bot, which is
a real perf-parity gap and, more subtly, a behavioral one: bot-viewer-v2 bots make FSM decisions on a
staggered cadence (stale by up to `thinkStride` frames for non-focus bots), while env-viewer-v2 bots
always decide on the freshest frame data.

### Eye / muzzle height (confirmed numeric drift)

`bot-viewer-v2.html:6652`: `const EYE_LIFT = 0.85; // fraction up the capsule used as eye/muzzle height`.
Used at `bot-viewer-v2.html:7103` and `:7107`: `entity.capsule.start.clone().lerp(entity.capsule.end,
EYE_LIFT)` — i.e., 85% of the way up the capsule.

`environment-viewer-v2.html:3426`: `function botEyeInto(entity, out) { out.x = entity.capsule.end.x; out.y
= entity.capsule.end.y; out.z = entity.capsule.end.z; return out; }` — the eye is the capsule's literal
top (100%), not 85%.

No `EYE_LIFT` token or `0.85` fraction was found anywhere in `environment-viewer-v2.html` (grepped
directly). This is a real, small (roughly capsule-height × 0.15) but confirmed divergence in the
raycast/aim origin height used for LOS and target-eye calculations.

### Knife melee: identical trigger logic, different tuning, cosmetic-only distance gap

Both files gate `BOT_KNIFE` entry with structurally identical logic: no distance gate (a comment in
`bot-viewer-v2.html:10417-10419` explicitly documents this design decision — "No distance gate: a dry
bot with a knife charges... the old gate left far bots camping AIM. One bot held it 652 s against a
target a median 43 m away"), a `knifeSince`/timeout/`knifeBlockUntil` cooldown structure, and the same
guard shape (`botKnifeSecondaryEnabled && visible && !healRequested && reloadUntil==null &&
outOfAmmo && not-blocked`) — compare `bot-viewer-v2.html:10432` vs `environment-viewer-v2.html:6273-6274`.

The two timeout constants differ numerically:
- `KNIFE_COMMIT_MAX_MS`: **8000** (`bot-viewer-v2.html:6686`) vs **12000** (`environment-viewer-v2.html:3649`)
- `KNIFE_COMMIT_COOLDOWN_MS`: **5000** (`bot-viewer-v2.html:6687`) vs **6000** (`environment-viewer-v2.html:3650`)

Env-viewer bots commit to a knife charge 50% longer before giving up, and sit out the resulting cooldown
20% longer.

Separately, `bot-viewer-v2.html` has a `knifeEngagementDistance` setting (default 8.0, UI slider
1.5–15, `bot-viewer-v2.html:7646`, `:13739`) — but it is used **only** to size a debug visualization
ring (`bot-viewer-v2.html:3576-3632`, `actor.knifeRange`), not to gate the actual FSM transition (per
the "no distance gate" comment above). `environment-viewer-v2.html` has no `knifeEngagementDistance` and
no equivalent debug ring (zero matches for `knifeRange`/`KNIFE_RANGE`/`meleeRange`). This is a
tooling/visualization gap only, not a behavioral one.

### Grenade evade hysteresis — environment-viewer-v2 is ahead of bot-viewer-v2

`bot-grenade.js:135` — `export function grenadeEvade(selfP, threats, settings = GRENADE_DEFAULTS,
engagedId = null)`. When `engagedId` matches a threat's id, that threat's evade ring widens to
`blastRadius * evadeExitScale` (`GRENADE_DEFAULTS.evadeExitScale = 1.25`, `bot-grenade.js:19`) — explicit
hysteresis so a bot that just cleared the blast edge doesn't immediately re-enter evade and thrash
between FSM states (`bot-grenade.js:132-134` comment).

`environment-viewer-v2.html` passes this 4th argument: `grenadeEvade(self, _grenadeThreats,
botGrenadeSettings, actor.grenadeEvadeId)` (observed at the call site during this investigation) and
tracks `grenadeEvadeId`/`grenadeGoal`/`evadeSeed` per actor (fields declared alongside spawn state,
e.g. `grenadeEvadeId: null, grenadeGoal: null, evadeSeed: null`), reassigning `actor.grenadeEvadeId` on
threat change.

`bot-viewer-v2.html`'s call to `grenadeEvade` (near line 6062 in the version read) passes only **3**
arguments — `grenadeEvade(grenadeBodyInto(bot.capsule, _grenadeSelf), _grenadeThreats,
botGrenadeSettings)` — with no `engagedId`, even though `activeBotActor.grenadeEvadeId` exists as a
tracked field (declared alongside spawn state, e.g. `grenadeEvadeId: null, grenadeGoal: null,
evadeSeed: null`). The field is tracked but never threaded into the `grenadeEvade` call.

**Why it matters:** bot-viewer-v2 bots evaluate the plain blast ring on every check and can flicker in
and out of the evade state right at the boundary; environment-viewer-v2 bots get the wider hysteresis
exit ring once already evading. This is a genuine behavioral difference, and unusually, it runs opposite
to the general pattern — env-viewer-v2 has functionality bot-viewer-v2 (the nominal reference) lacks.

### Nav-grid / visibility / cover: three items where environment-viewer-v2 is ahead

- `finalizeNavGrid` — imported and called only in `environment-viewer-v2.html` (`:111` import,
  `:2506` call: `const grid = finalizeNavGrid({...})`). Zero matches for `finalizeNavGrid` in
  `bot-viewer-v2.html`. **INFERRED** (not directly read): based on its name and nav-grid.js's role
  description in project docs ("region labeling and connectivity"), this likely performs a
  post-`buildNavGrid` connectivity/region-labeling pass — this investigation did not open `nav-grid.js`
  to confirm the function body, so treat the *purpose* as inferred even though the *import/call-site
  asymmetry* is measured fact.
- `SIGHT_BLOCK_HEIGHT` — imported and used only in `environment-viewer-v2.html` (`:160` import,
  used at `:2317` and `:2423` as a height-clip threshold in what appears to be sight-grid construction).
  Zero matches in `bot-viewer-v2.html`.
- `COVER_ANCHOR_REACH` — imported and used only in `environment-viewer-v2.html` (`:130` import,
  `:5705`: `const COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6;`, with a comment at `:5702`
  noting a specific failure mode this constant fixes — "a centre can sit ~1.06 m from the anchor --
  outside COVER_ANCHOR_REACH (0.45 m)"). Zero matches in `bot-viewer-v2.html`.

All three exports exist in the shared modules and are consumed by environment-viewer-v2 but not
imported at all by bot-viewer-v2. This is the opposite direction from most of this report's other
findings (which show bot-viewer-v2 with extra capability) and suggests bot-viewer-v2 is not
unconditionally "ahead" of environment-viewer-v2 — for this trio, the shared modules gained capability
that only got wired into the game-side viewer.

### Roles / squads / medic — core wiring confirmed identical, three missing exports in B

Both files call `assignRolesToBatch`, `electSquadLeader`, `stepSquadSuccession`, and
`chooseFormationKind` with matching argument shapes:
- `assignRolesToBatch`: `bot-viewer-v2.html:2450-2452`; `environment-viewer-v2.html:2760, 2968`
- `electSquadLeader`: `bot-viewer-v2.html:5845`; `environment-viewer-v2.html:2888`
- `stepSquadSuccession`: `bot-viewer-v2.html:6073`; `environment-viewer-v2.html:3094`
- `chooseFormationKind`: `bot-viewer-v2.html:6102, 6106`; `environment-viewer-v2.html:3123, 3127`

Three exports are imported by bot-viewer-v2 but not environment-viewer-v2 (all zero-match verified):
- `squadSlotWorld` (bot-squad.js) — imported `bot-viewer-v2.html:921`, absent from B.
  **INFERRED** purpose (not read directly): likely converts a squad formation rank into a world
  position, given the surrounding `formationRanks`/`formationHalfWidth` imports.
- `teamCentroid` (bot-medic.js) — imported `bot-viewer-v2.html:923`, absent from B.
- `MEDIC_CONTACT_RADIUS`, `MEDIC_CONTACT_CREEP` (bot-medic.js) — imported `bot-viewer-v2.html:924`, absent
  from B.

These three were not traced to specific call sites/behavioral consequences within the time budget of
this pass — flagged as open items below rather than asserted with a specific behavioral claim.

### bot-entity.js forensic ring — confirmed missing from B

`bot-entity.js:130`: `export { createBotForensics, FORENSIC_RING, FORENSIC_MAX_SLOTS, FORENSIC_STRIDE,
FORENSIC_COLUMNS } from './bot-forensics.js';` — re-exported from a dedicated `bot-forensics.js` module
(referenced in project docs as "BB-004" tooling). `bot-viewer-v2.html:909` imports `createBotForensics`
alongside the rest of bot-entity.js's surface. `environment-viewer-v2.html` has zero matches for
`createBotForensics` or the literal string `bot-forensics` anywhere in the file — this diagnostic/forensic
system is not wired into environment-viewer-v2 at all, despite `bot-forensics.js` being listed as part of
the "wired" bots subsystem in this repo's top-level `CLAUDE.md` doc table. That doc entry appears stale
for environment-viewer-v2 specifically (**INFERRED** — the doc wasn't opened to check what it actually
claims, only the code was checked).

### State-code tracer — present in both, but default-on vs opt-in

`bot-viewer-v2.html:932-934` statically imports the full `bot-state-code.js` surface, and
`encodeBotState(desc)` is called unconditionally per bot (`bot-viewer-v2.html:2760`) — the 9-char state
code is always being computed.

`environment-viewer-v2.html` does not statically import `bot-state-code.js`. Instead it lazy-loads it
only when a trace is requested: `botTraceApi = await import('./bot-state-code.js');`, gated behind a
`?botTrace=1` URL flag (comment: "9-slot bot state-code tracer (bot-state-code.js), ?botTrace=1"). Off
by default.

### Scoring — corrected finding, mostly identical

See "Corrections made" above. Remaining real gap: `resetScoreboard`, `formatBreakdownLines`, and
`formatRoundLine` are imported in `bot-viewer-v2.html:925-926` but not in `environment-viewer-v2.html:80-81`.
**INFERRED** consequence (not traced to a call site): environment-viewer-v2 likely cannot reset an
in-progress scoreboard without a page reload, and its score HUD likely lacks the per-team stat
breakdown line bot-viewer-v2 can render — this was not confirmed by reading the HUD-rendering code on
either side.

### Combat FSM dispatcher — structurally identical

Both files branch in the same order and with the same guard style inside their per-bot per-frame combat
dispatch: grenade-evade overrides grenade-throw overrides "holding" overrides `BOT_AIM`/`BOT_FIRE`
overrides `BOT_KNIFE` overrides `MEDIC_MOVE`/`MEDIC_TEND` overrides `BOT_PURSUE` overrides `BOT_FLEE`
overrides `BOT_HEAL`. Compare `bot-viewer-v2.html:10730-10780` against `environment-viewer-v2.html:6500-6545`.
Fire-gate call shape is identical: `state === BOT_FIRE && fireBotShot(...)`, and the internal
`fireBotShot` guard (`botReloadUntil != null || botSwapping(now) || ammo.mag <= 0`) is present in the
version of `bot-viewer-v2.html` read at `:11020`.

### Projectile handling — architectural difference, not a gap

`bot-viewer-v2.html:116` imports `createProjectileManager` from `bot-projectiles.js` and instantiates it
directly (`bot-viewer-v2.html:11431`: `const botProjectiles = createProjectileManager({...})`).
`environment-viewer-v2.html` has zero matches for `createProjectileManager`. Instead it imports
`ProjectileEntity` (`:71`) and `CombatProjectileEntity` (`:72`) from `entity-types/`, and registers them
with the game's general entity registry (`entityRegistry.registerType(ProjectileEntity)` /
`registerType(CombatProjectileEntity)`, ~lines 274-276). Both files still call the same
`chooseGrenadeThrow`/`grenadeEvade`/`throwCountFor` decision functions from `bot-grenade.js` identically
— this is a difference in how the resulting projectile is simulated/rendered (bot-only manager vs.
shared world entity system), not a difference in the AI decision of whether/where to throw.

### Separation / pushout — functionally identical, minor perf-tuning difference

`resolveBotPairsHashed`, `separationXZHashed`, `blendSeparationDir`, `waypointContestedHashed` are all
called in both files. `bot-separation.js:114`: `export function resolveBotPairsHashed(bots, hash,
radius)` — `radius` is optional and defaults to `null` internally when omitted. `bot-viewer-v2.html`
calls it with 2 arguments (radius omitted); `environment-viewer-v2.html` calls it with an explicit third
argument (`maxR + BOT_COLLIDE_PAD * 0.5`). The underlying `SEPARATION_RADIUS` (1.5m) and
`SEPARATION_WEIGHT` (0.5) constants are identical, character-for-character, in both files. This reads as
a hashed-neighbor-scan perf-tuning choice, not a behavioral difference — **INFERRED** (the internal
consequence of passing vs. omitting `radius` inside `bot-separation.js` was not traced further).

## Ranked list of the most significant parity gaps

1. **Think-stagger is entirely absent from environment-viewer-v2.** Bot-viewer-v2 skips full per-bot
   AI updates on non-stride frames for non-focus bots (`botThinkStride`, `bot-viewer-v2.html:3128,
   3341, 3365-3369`); environment-viewer-v2 runs every bot's full sentry think every frame
   (`environment-viewer-v2.html:6971-6993`, and zero `thinkStride`/`stagger` matches elsewhere). This is
   both a scalability gap (more bots will cost more per frame in env-viewer) and a subtle behavioral one
   (decision freshness differs by harness). Matters most at high bot counts, which is exactly the
   scenario the project's "90-bot profile" memory note says bot-viewer-v2 was tuned for.

2. **Eye/muzzle height differs by a fixed fraction of capsule height (0.85 vs 1.0).** Confirmed via
   direct reads of both eye-position helpers (`bot-viewer-v2.html:7103/7107` vs
   `environment-viewer-v2.html:3426`). Affects every LOS raycast origin and aim-origin calculation for
   every bot in environment-viewer-v2, silently, in every frame.

3. **Grenade-evade hysteresis is missing from bot-viewer-v2, present in environment-viewer-v2.** The
   `engagedId` 4th argument to `grenadeEvade` (bot-grenade.js:135) is threaded through in
   environment-viewer-v2 but dropped in bot-viewer-v2's call site, despite bot-viewer-v2 tracking the
   exact field (`grenadeEvadeId`) the argument needs. This is the reverse of "v2 is the reference" — it
   means testing grenade-evade behavior in the harness will not match what actually ships.

4. **Three shared-module exports (`finalizeNavGrid`, `SIGHT_BLOCK_HEIGHT`, `COVER_ANCHOR_REACH`) are
   wired into environment-viewer-v2 but not bot-viewer-v2 at all.** Same direction as #3: capability the
   harness cannot currently be used to test or tune, because it was never imported there.

5. **Knife commit timing differs numerically (8000/5000 ms vs 12000/6000 ms).** A tuning value that
   diverged rather than an architectural gap, but it changes how long a dry bot will charge with a knife
   and how long it sits out afterward — directly observable in play, and the harness will not reproduce
   it.

6. **bot-forensics.js (`createBotForensics`) is not wired into environment-viewer-v2 at all**, despite
   being imported and available in bot-viewer-v2 and listed as part of the "wired" bots subsystem in the
   top-level project doc table. Anyone trying to use forensic-ring diagnostics in the live game viewer
   will find nothing there.

7. **State-code tracer (`bot-state-code.js`) defaults to off (opt-in `?botTrace=1`) in
   environment-viewer-v2, while bot-viewer-v2 always computes it.** Lower severity — it's a debugging
   aid, not gameplay logic — but it means state-code-based debugging workflows validated in the harness
   need an extra URL flag to work in the game viewer, and are simply not running by default there.

8. **`resolveStanceOverride` (manual per-bot stance override for debugging) exists only in
   bot-viewer-v2.** Minor — debug tooling only, core stance FSM (`chooseBotStance`,
   `stepStanceTransition`, speed/spread/height scalers) is otherwise identical in both harnesses.

## Open items not resolved within this investigation's time budget

- `squadSlotWorld`, `teamCentroid`, `MEDIC_CONTACT_RADIUS`, `MEDIC_CONTACT_CREEP` — confirmed absent from
  environment-viewer-v2 by direct grep, but their call sites/purpose in bot-viewer-v2 and the concrete
  behavioral consequence of their absence were not traced by reading `bot-squad.js`/`bot-medic.js`
  directly. Flagged as **measured absence, inferred/unconfirmed impact**.
- `environment-viewer-v2.html` calls `buildCornerMap` twice (observed near lines 2333 and 2518) versus
  bot-viewer-v2's single call site (~7508) — not confirmed whether this is a legitimate two-phase build
  (e.g., editor/precompute pass plus runtime pass) or redundant work.
- `bot-danger.js` weight constants (`DANGER_DEATH_WEIGHT`, `DANGER_HIT_WEIGHT`, `DANGER_FLEE_SCALE`,
  `DANGER_PATROL_SCALE`, `DANGER_PACK_SCALE`) are imported identically by both files; this investigation
  did not grep for local override/multiplication of these constants at their use sites in either file, so
  "no override found" for this row in the summary table should be read as "not searched for," not
  "confirmed absent."
- Aim/lead/spread fire-gating fine detail (exact `AIM_DEFAULTS` field overrides, if any, in either
  harness) and reload-threshold specifics beyond the sidearm-swap call-site match were not
  independently re-verified after the file-drift issue was discovered; the FSM dispatcher-shape and
  fire-gate comparisons above were re-confirmed, but a full pass over every `AIM_DEFAULTS.*` override
  site was not completed.
