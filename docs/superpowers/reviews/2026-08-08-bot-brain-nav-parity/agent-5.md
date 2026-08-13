# Bot brain + navigation parity: bot-viewer-v2.html vs environment-viewer-v2.html

Date: 2026-08-08. Read-only investigation, no files modified.

## Method note (read this before the findings)

This report is built from direct `Read`/`Grep` inspection of:

- `bot-viewer-v2.html` (reference/authoritative harness, ~15.7k lines)
- `environment-viewer-v2.html` (game-side port, ~14.7k lines)
- Shared modules: `bot-activity.js`, `bot-entity.js`, `bot-roles.js`, `bot-aim.js`, `bot-contacts.js`,
  `nav-grid.js`, `bot-cover.js` (partially), `bot-stance.js` (partially), `bot-squad.js` (imports only)
- `docs/subsystems/bots.md` (the team's own change log for this port — used as corroborating,
  dated, first-party evidence, not as a substitute for reading the code)

**Every claim below is tagged MEASURED (I read the exact line(s) cited) or INFERRED (reasoned from
measured evidence, not directly confirmed).** Where a doc note and the current code disagreed, the
code wins and the conflict is called out explicitly (see "Live-editing caveat").

**Live-editing caveat.** This repository is under active, concurrent development (see the git log —
today's top commit is itself a bot-parity fix). Partway through this investigation, re-reading
`environment-viewer-v2.html` at previously-recorded line numbers showed different content than an
earlier pass — three new imports (`bot-body-hit.js`, `bot-damage-class.js`, `bot-contacts.js`) and
an added `bloodIntensityForHealth` symbol appeared between an early exploratory grep and later reads.
All citations in this report are from the **last read of each file during this session**, but a
citation's line number could already have drifted by the time this is read. Treat exact line numbers
as "as of this session," not as permanently fixed addresses — the symbol names and surrounding
context are the more durable identifier.

**Coverage.** I read `bot-activity.js`, `bot-entity.js`, `nav-grid.js`, `bot-roles.js`, `bot-aim.js`,
and `bot-contacts.js` in full, and `bot-stance.js`/`bot-cover.js` partially. I did not read
`bot-alert.js`, `bot-squad.js`, `bot-medic.js`, `bot-sidearm.js`, `bot-grenade.js`, `bot-danger.js`,
`bot-pursuit.js`, or `combat.js` source in full — those areas are covered only via the two harnesses'
import lists and call-site greps, which is enough to establish *whether* something is wired but not
always *exactly how the shared module's internals work*. Where I did not verify a claim by reading
source, it is marked INFERRED.

---

## Summary table

| Area | bot-viewer-v2.html | environment-viewer-v2.html | Verdict |
|---|---|---|---|
| FSM states (`bot-activity.js`) | Single shared ladder, `chooseBotStateName` | Same shared ladder | **Identical** (shared module, no local fork found) |
| `trackStuck` (stuck-bot detection) | Not imported, not called (0 matches) | Imported as `botTrackStuck`, called | **Missing in bot-viewer-v2** |
| Roles catalogue (`bot-roles.js`) | Full symbol set imported | Same symbol set imported | **Identical** |
| Medic (`bot-medic.js`) | Imports `teamCentroid`, `MEDIC_CONTACT_RADIUS`, `MEDIC_CONTACT_CREEP` extra | Missing those 3 symbols | **Drifted / narrower in env-viewer-v2** |
| Squads (`bot-squad.js`) | Imports `squadSlotWorld` extra | Missing `squadSlotWorld` | **Drifted / narrower in env-viewer-v2** (usage not traced) |
| Target selection / risk scoring | `TARGET_STICK_RISK_MARGIN`, `TARGET_COMMIT_MIN_MS`, pile-on discount | Same constants, same algorithm, currently present | **Identical (now)** — a doc note claims historical drift, code contradicts it, see Finding 6 |
| Contact memory (`bot-contacts.js`) | Imports all 4 exports incl. `contactRecency`; `contactRecency` never called | Imports 3 of 4 (no `contactRecency`); both are write-only | **Near-identical**, both sides "recorded but not consumed" |
| Aim (`bot-aim.js`) | `AIM_DEFAULTS` used directly | Doc claims a stale 700/40/2000 override existed and was deleted; not independently re-verified this session | **Not directly re-verified** (see Finding 6) |
| Eye height / LOS origin | Not directly compared this session | `botEyeInto` = capsule top (`entity.capsule.end`) | **Not fully compared** — see Finding 7 |
| Cover (`bot-cover.js`) | No `COVER_ANCHOR_REACH` import (uses `coverInBand` internally) | Imports `COVER_ANCHOR_REACH` explicitly, derives `COVER_FINAL_APPROACH_STOP` for a coarser terrain grid | **Env-specific extension, not a gap** |
| Danger field (`bot-danger.js`) | `recordDanger`/`dangerPenalty`/`dangerBlocksCover` call sites, same weight constants, same `0.35` veto threshold | Same call sites, same constants | **Identical wiring** |
| Nav grid build | One `buildNavGrid` call over one bounded map | `buildNavGrid` (static map) **+** `finalizeNavGrid` (incremental terrain-zone bake) **+** a third `buildNavGrid` call for bounded local windows | **Env-viewer-v2 has a materially larger nav architecture**, by design (see Finding 9) |
| Goal claims (`createGoalClaims`) | `cover/flee/seek/pursue/recover/pack` kinds claimed/released | Same 6 kinds, same call pattern | **Identical wiring** |
| Crest cover tuning | `maxSpan: 2m`, `farCells: 12m` (per doc) | `BOT_ZONE_CREST_SPAN_M = 4.5m`, `BOT_ZONE_CREST_FAR_M = 24m` | **Deliberately diverged**, documented reason (terrain scale) |
| Stance overrides | Imports `STANCE_RUN`, `STANCE_DASH`, `resolveStanceOverride`; has a UI force-override dropdown | Imports neither `resolveStanceOverride` nor a debug override | **Missing in env-viewer-v2** (debug/QA capability only, not simulated behavior) |
| Projectile hit-testing | Uses `rayCapsuleHit` from `combat.js` directly against bot capsules | Never imports/calls `rayCapsuleHit`; uses its own entity-registry projectile/explosion system instead | **Architecturally different**, not necessarily a behavioral gap (not traced further) |
| Body-hit / wound targeting (`bot-body-hit.js`) | Imports and calls `resolveBodyHit` | Imports and calls `resolveBodyHit` | **Identical** |

---

## Detailed findings

### 1. FSM ladder is a genuinely single source of truth

`bot-activity.js` (269 lines, read in full) defines the 10 state constants, the deterministic
`chooseBotStateName` ladder, and all state-adjacent helpers (`shouldTopOffReload`,
`stepVisibleDebounce`/`resetVisibleDebounce`, `healUnsafeBand`, `spreadAnchor`/`spreadAnchorRadius`,
`botSeedFromId`, `pursueBreakThreshold`, `aimAnglesTo`/`aimError`/`slewAngle`, `trackStuck`).
[`bot-activity.js:10-19`] (state constants), [`bot-activity.js:36-125`] (the full ladder).

Both harnesses import from this same file with the same symbol names (a few renamed via `as` in
env-viewer-v2, values unchanged):

- `bot-viewer-v2.html:6609-6615` — `BOT_PATROL, BOT_SEEK, BOT_PURSUE, BOT_FLEE, BOT_HEAL, BOT_KNIFE, BOT_AIM, BOT_FIRE, BOT_COVER_MOVE, BOT_COVER_HOLD, SENSE_RANGE, AIM_TOLERANCE_RAD, TURN_RATE_RAD_S, chooseBotStateName, aimAnglesTo, aimError, slewAngle, stepVisibleDebounce, resetVisibleDebounce, healUnsafeBand, spreadAnchor, spreadAnchorRadius, botSeedFromId, SEEK_SPREAD_RING_M, pursueBreakThreshold, CLOSE_THREAT_RADIUS, shouldTopOffReload`
- `environment-viewer-v2.html:97-107` — same set, `SENSE_RANGE as BOT_SENSE_RANGE`, `TURN_RATE_RAD_S as BOT_TURN_RATE_RAD_S`, `aimError as botAimError`, **plus `trackStuck as botTrackStuck`**.

MEASURED: I did not find any locally-redefined copy of `chooseBotStateName` or the ladder's
conditions in either HTML file (searched for the state constant literals and function name; all
matches are either the import or downstream call sites). The ladder itself is not duplicated —
only the FSM's *inputs* (`ctx` fields like `targetVisible`, `readyToFire`, `coverAvailable`, etc.)
are each harness's own responsibility to compute per-bot per-frame, and I did not diff that
input-computation code line-by-line in either file (INFERRED gap in this report's own coverage,
not a claim about drift).

### 2. `trackStuck` — real, one-sided gap

`bot-activity.js:243-247` exports `trackStuck({speed, moving, stuckSince, nowMs})`, a stuck-bot
detector (latches `stuckSince` when a patrol/seek bot's speed drops under
`STUCK_MIN_SPEED = 0.15` m/s, `bot-activity.js:238`).

- `environment-viewer-v2.html:101` imports it as `botTrackStuck`, and calls it at
  `environment-viewer-v2.html:6774`: `const stuck = botTrackStuck({ speed: dt > 0 ? movedDist / dt : 0, moving, stuckSince: rec.stuckSince, nowMs });` — MEASURED, live call site.
- `bot-viewer-v2.html` never imports `trackStuck` and a full-file grep for the literal string
  `trackStuck` returns zero matches — MEASURED (`Grep` on `bot-viewer-v2.html` for `trackStuck`,
  no results).

INFERRED: this is plausibly because `bot-viewer-v2.html`'s maze/room map rarely produces bots stuck
against terrain, while `environment-viewer-v2.html`'s open procedural terrain (rocks, tree trunks,
slope) does — but I did not confirm this reasoning against either file's issue history.

### 3. Roles catalogue is identical; medic and squad imports have each dropped a few symbols

`bot-roles.js` (156 lines, read in full) defines `ROLE_RIFLEMAN/MEDIC/SQUAD_LEADER/SNIPER/TECHNICAL`
with per-role `sightScale`, `swapOnDryMag`, `closeRange`, `sidearm`, `bonusGrenades`, `leadership`,
`support`, `insignia` [`bot-roles.js:49-84`], plus `assignRolesToBatch` (deterministic, no RNG,
interleaved specialist placement) [`bot-roles.js:96-114`], `pickSquadLeader` (highest `leadership`,
ties broken by lowest id) [`bot-roles.js:118-128`], and bounding-overwatch helpers `squadRanks`/
`boundingRole` (`PUSH_BOUND_MS = 2500`) [`bot-roles.js:135-155`].

Role import lists are the same set, different textual order:

- `bot-viewer-v2.html:918-919` — `ROLE_MEDIC, ROLE_SQUAD_LEADER, ROLE_SNIPER, ROLE_TECHNICAL, DEFAULT_ROLE, getRole, assignRolesToBatch, pickSquadLeader, squadRanks, boundingRole`
- `environment-viewer-v2.html:136-137` — `ROLE_MEDIC, ROLE_SNIPER, ROLE_TECHNICAL, ROLE_SQUAD_LEADER, DEFAULT_ROLE, getRole, assignRolesToBatch, pickSquadLeader, squadRanks, boundingRole`

MEASURED: identical symbol set. A raw occurrence count of the four specialist role constants
(`ROLE_SNIPER|ROLE_TECHNICAL|ROLE_SQUAD_LEADER|ROLE_MEDIC`) is 25 in `bot-viewer-v2.html` vs 12 in
`environment-viewer-v2.html` (`Grep -o` count on each file). MEASURED count; INFERRED significance —
this likely just reflects more UI-panel/debug-readout references to role names in the harness, since
role-driven *behavior* is reached through `getRole(id).fieldName`, not by re-testing the constant, so
a lower literal-occurrence count doesn't by itself mean less behavior is wired. Not traced further.

**Medic — a real, measured drop:**

- `bot-viewer-v2.html:923-924` — `import { MEDIC_MOVE, MEDIC_TEND, MEDIC_DEFAULTS, decideMedicAction, cohesionTarget, teamCentroid, medicChaseSpeedFactor, medicTendRadiusFor, MEDIC_CONTACT_RADIUS, MEDIC_CONTACT_CREEP } from './bot-medic.js';`
- `environment-viewer-v2.html:138-139` — `import { MEDIC_MOVE, MEDIC_TEND, MEDIC_DEFAULTS, decideMedicAction, cohesionTarget, medicChaseSpeedFactor, medicTendRadiusFor } from './bot-medic.js';`

`environment-viewer-v2.html` does not import `teamCentroid`, `MEDIC_CONTACT_RADIUS`, or
`MEDIC_CONTACT_CREEP`. MEASURED (direct read of both import blocks). I did not read `bot-medic.js`
itself, so I cannot say from measurement what behavior this removes — the names suggest a
medic-specific "how close counts as contact" radius/creep tuning and a team-centroid cohesion target
that env-viewer-v2 either lacks or computes some other way. INFERRED that this is a real capability
gap, not just an unused import, because the missing symbols are plain constants/functions with no
substitute name found nearby in a scan of the same import block.

**Squads — one symbol dropped, usage not traced:**

- `bot-viewer-v2.html:920-922` — `import { SQUAD_MAX_SIZE, SQUAD_MIN_SIZE, SQUAD_DEFAULTS, FORMATION_KINDS, partitionSquadSizes, squadRoleTemplate, electSquadLeader, stepSquadSuccession, chooseFormationKind, squadMemberGoal, squadSlotWorld, dealSquadChunks, planSquadReconcile, SQUAD_MERGE_RADIUS, formationRanks, formationHalfWidth } from './bot-squad.js';`
- `environment-viewer-v2.html:152-156` (line number moved during the session, see caveat; content confirmed twice) — same set **minus `squadSlotWorld`**.

MEASURED: `squadSlotWorld` is imported only by `bot-viewer-v2.html`. I did not grep its call sites in
either file or read `bot-squad.js`, so I cannot say whether env-viewer-v2 needs an equivalent (formation
slot → world position resolver) or computes it inline under a different name — flagged but not closed
out due to time constraints on this pass.

### 4. Target selection / risk scoring: code shows parity; one dated doc note is stale

`docs/subsystems/bots.md:2353-2357` contains a "Known drift" note claiming
`environment-viewer-v2.html` "carries an earlier copy of this same target-selection code... it still
has the old distance-only pick with no danger/pile-on awareness."

Direct measurement of the **current** code contradicts this note. Both files define the identical
risk-scoring constant set and algorithm:

- `bot-viewer-v2.html:6406-6420` — `TARGET_STICK_RISK_MARGIN = 1.3`, `TARGET_COMMIT_MIN_MS = 1500`, `TARGET_DANGER_SELF_BONUS = 2.5`, `TARGET_PILE_ON_STEP = 0.25`, `TARGET_PILE_ON_FLOOR = 0.4`.
- `environment-viewer-v2.html:3890-3899` — same five constants, same values, same comments.
- `environment-viewer-v2.html:3921-4009` (`selectBotTarget`) implements proximity×danger risk
  scoring, self/ally-threat danger bonuses with `dangerDecay`, an `alliesCommittedTo` pile-on
  discount, and the same `TARGET_STICK_RISK_MARGIN`/`TARGET_COMMIT_MIN_MS` stickiness gate as the
  harness — measured directly, not inferred from the doc.
- A literal search for the doc's cited stale marker `TARGET_STICK_CLOSER_SQ` in
  `environment-viewer-v2.html` returns **zero matches** — MEASURED, i.e. the old code path the doc
  describes is gone.

This is corroborated by `docs/subsystems/bots.md:6608-6664` ("Harness combat parity — aim/disengage,
2026-07-31"), which documents nine divergences between the two apps' combat brains being closed,
including exactly this target-stickiness fix, and matches the top commit in this repo's git log
(`23da7d4 fix(bots): harness combat parity - aim/disengage/cover now follow bot-viewer-v2`).
**Conclusion: the doc note at line 2353 is stale — written before the 2026-07-31 parity pass, not
updated after. Target-selection risk scoring is currently at parity.** (MEASURED code state;
the doc's own later section, also MEASURED by reading it, explains why the earlier note no longer
holds.)

### 5. Contact memory (`bot-contacts.js`): present on both sides, unconsumed on both sides

`bot-contacts.js` (54 lines, read in full) is a per-bot, per-enemy sighting memory: `recordContactSighting`
upserts `{x, z, lastSeenAt, visible}` keyed by enemy id (Map-order = recency, capped at
`CONTACT_MEMORY_MAX_ENTRIES = 12`), `markContactsUnseen` flips stale entries to `visible:false`, and
`contactRecency` gives a linear 1→0 confidence decay [`bot-contacts.js:8-52`].

- `bot-viewer-v2.html:6647-6649` — `import { createContactMemory, recordContactSighting, markContactsUnseen, contactRecency } from './bot-contacts.js';` — imports all 4 exports, but a full-file grep for `contactRecency` finds **only the import line itself** (MEASURED — it is never called).
- `environment-viewer-v2.html:79` — `import { createContactMemory, recordContactSighting, markContactsUnseen } from './bot-contacts.js';` — imports 3 of 4 (no `contactRecency`), and calls the other three at `environment-viewer-v2.html:3949` (`activeBot.contacts ??= createContactMemory()`), `:3954` (`recordContactSighting(...)`), `:3956` (`markContactsUnseen(...)`), with an explicit code comment: *"Recorded but not yet consumed, same as the harness."* [`environment-viewer-v2.html:3945-3948`].

**Verdict: this is near-identical, write-only wiring on both sides**, not a one-sided gap. Neither
harness currently folds remembered-but-hidden contacts into target risk scoring — matches
`docs/subsystems/bots.md:2381` ("This pass is infrastructure only — it is not yet consumed by
anything"). The only asymmetry is that `bot-viewer-v2.html` additionally imports the unused
`contactRecency` function (dead import) while `environment-viewer-v2.html` does not import it at
all — functionally equivalent, since neither calls it.

**Caveat on this finding**: earlier in this session, a first-pass grep of `environment-viewer-v2.html`
for the literal string "bot-contacts" returned no matches, which would have supported a very different
conclusion ("env-viewer-v2 lacks contact memory entirely"). A later, fresh read of the same file found
the import at line 79. Per the live-editing caveat above, I cannot fully rule out that this import was
added to the file partway through this session rather than the first grep simply missing it (the
import sits in a different cluster — audio/FX/damage imports, lines ~75-82 — than the main bot-brain
import cluster starting around line 97, which is a plausible reason a narrowly-scoped search would
miss it independent of any edit). The state reported here (present, wired, unconsumed, matching the
harness) is what I measured on my last read and is the one to trust.

### 6. Aim tuning (`bot-aim.js`) — not independently re-verified this session

`bot-aim.js` (93 lines, read in full) exports `AIM_DEFAULTS` (`reactionMs: 260`,
`reactionPerMetreMs: 12`, `reactionMaxMs: 900`, `baseSpreadDeg: 0.35`, `moveSpreadDeg: 2.5`,
`bloomPerShotDeg: 0.45`, `bloomMaxDeg: 4.0`, etc. — `bot-aim.js:5-23`), plus `reactionDelayMs`,
`spreadHalfAngleRad`, `bloomAfterShot`, `decayBloomDeg`, `dispersedDirection`.

Both harnesses import the same symbol set from `bot-aim.js` (`AIM_DEFAULTS, reactionDelayMs,
spreadHalfAngleRad, bloomAfterShot, decayBloomDeg, dispersedDirection` — `bot-viewer-v2.html:6621-6623`,
`environment-viewer-v2.html:110-112`). MEASURED: the import lists match.

`docs/subsystems/bots.md:6615-6618` states that env-viewer-v2 previously overrode these with a local
`700/40/2000` ms triple (via a now-deleted "Notice time (s)" slider) and that this override was
removed as part of the same 2026-07-31 parity pass discussed in Finding 4. I did not re-grep
`environment-viewer-v2.html` for a local `botAimSettings` override object this session to confirm the
override is actually gone — **this is INFERRED from the doc, not independently measured**, unlike
Finding 4 where I did re-verify the code directly. Flagging so a follow-up pass closes this out with
a direct read.

### 7. Eye height / LOS origin — partially measured, not fully compared

`environment-viewer-v2.html:3422` — `function botEyeInto(entity, out) { out.x = entity.capsule.end.x; out.y = entity.capsule.end.y; out.z = entity.capsule.end.z; return out; }` — the bot's sight origin is the literal top of its capsule (MEASURED). A neighboring comment at `environment-viewer-v2.html:3423-3425` notes a *separate* convention for scoring a human target's aim point: `humanAimInto` lifts a wire-pose midpoint by `0.3 * height` for "upper chest," not eye height.

I did not locate or read the equivalent eye-origin function in `bot-viewer-v2.html` this session, so
**I cannot confirm whether the two harnesses use the same eye-height convention** — this is an open
question, not a confirmed gap or confirmed parity. Given `bot-entity.js`'s shared
`DEFAULT_STAND_HEIGHT = 1.8` [`bot-entity.js:12`] and `DEFAULT_RADIUS = 0.3` [`bot-entity.js:11`],
and that both harnesses build bots via the same `createBotEntity`, the capsule geometry itself is
identical by construction (MEASURED, both harnesses call the same `createBotEntity` from
`bot-entity.js` — `bot-viewer-v2.html:909`, `environment-viewer-v2.html:97`) — only the "where on
that capsule do I look from" convention is unconfirmed as equal.

### 8. Cover (`bot-cover.js`): one import asymmetry, resolved as intentional, not a gap

- `bot-viewer-v2.html:6626-6633` imports from `bot-cover.js`: `createPeekCycle, stepPeekCycle,
  peekPosition, peekAiming, peekExposed, approachXZ, PEEK_APPROACH_SPEED, peekPhaseOffsetS,
  coverCornerValid as coverCornerValidPure, pickCoverCorner, stepCoverGate, noteCoverSwitch,
  coverSwitchAllowed, coverInBand, COVER_PEEK_MISS_LIMIT, coverHoldExitReason, coverSeatBand,
  coverCommitTimedOut, createCoverBlacklist, blacklistCover, coverBlacklisted,
  fleePathExposureFromParents, fleeCandidateScore` — **no `COVER_ANCHOR_REACH`**.
- `environment-viewer-v2.html:122-129` imports the same set **plus `COVER_ANCHOR_REACH`**.

`bot-cover.js:75` defines `export const COVER_ANCHOR_REACH = 0.45;` (MEASURED). Env-viewer-v2 uses
the raw constant to derive its own tighter approach-stop radius for a coarser (1.5 m) terrain grid:
`environment-viewer-v2.html:5642` — `const COVER_FINAL_APPROACH_STOP = COVER_ANCHOR_REACH * 0.6;`,
with an explanatory comment at `environment-viewer-v2.html:5639` about why the coarser terrain-zone
grid needs it (a 1.5 m cell centre can sit ~1.06 m from the anchor, outside the 0.45 m reach band).
This matches `docs/subsystems/bots.md:6676-6684` ("Cover seats were unreachable on the 1.5 m grid").
**Verdict: this is a documented, intentional env-specific extension to make the shared cover module
work on a coarser grid, not a parity drift** — the shared cover logic itself (`bot-cover.js`) is
identical on both sides; only the caller-side geometry differs, by necessity of the different grid
pitch (0.5 m maze vs 1.5 m open terrain).

### 9. Navigation grid: bot-viewer-v2 is one static bake; environment-viewer-v2 is three cooperating grids

`nav-grid.js` (620 lines, read in full) is the sole pathfinding implementation for both harnesses —
`buildNavGrid` (sample + label + connect), `finalizeNavGrid` (label + connect only, for a
caller-filled grid — see below), region labeling/connectivity repair (`labelRegions`,
`connectStrandedRegions`, `cheapestSoftLink`), A* (`findPath`), bounded Dijkstra (`floodFill`/
`floodPath`), string-pulling (`smoothPath`/`lineWalkable`/`chordClimb`), and the waypoint-advance
contract (`advancePath`). A comment at `nav-grid.js:47-50` states outright that the
`buildNavGrid`/`finalizeNavGrid` split "exists so a bake too large to run inside one frame can sample
incrementally and finalize once (**environment-viewer-v2's terrain combat-zone grid does exactly
that**)" — i.e. this split was added specifically for env-viewer-v2's use case, confirmed by the
module's own source comment.

**bot-viewer-v2.html: one grid, one call.**
`bot-viewer-v2.html:7491-7492` — `navGrid = buildNavGrid(navWalkable, activeBounds, NAV_CELL, terrainSettings.enabled ? { heightAt: groundHeight, softBlockedTest: navSoftBlocked } : {});` — a single bounded-map bake, rebuilt on toolbar changes (goal claims and the danger field are cleared alongside it at the same call site, `bot-viewer-v2.html:7493-7494`).

**environment-viewer-v2.html: three grid paths.**
1. Static authored-map bake (mirrors the harness): `environment-viewer-v2.html:2320` — `botNavGrid = buildNavGrid(botNavWalkable, loadedMap.bounds, BOT_NAV_CELL);`, gated on `NO_ENVIRONMENT` (`environment-viewer-v2.html:2319`).
2. Incremental, time-sliced open-terrain "zone" bake via `finalizeNavGrid`: `environment-viewer-v2.html:2503-2506` — `finishBotZoneBake` calls `finalizeNavGrid({ cols, rows, cellSize, minX, minZ, cells, heights, soft })` on a grid the caller filled in across multiple frames.
3. A bounded local-window fallback for points outside the zone: `environment-viewer-v2.html:3323` — `return buildNavGrid(botTerrainWalkable, bounds, BOT_LOCAL_NAV_CELL, { heightAt: terrainHeight });`.

This is corroborated in detail by `docs/subsystems/bots.md:5917-6150` ("Phase D: open terrain"),
which documents the design rationale (a benchmark table at `docs/subsystems/bots.md:5935-5942`
comparing whole-map vs. zone vs. local-window bake costs) and a concrete tunables table
(`docs/subsystems/bots.md:5990-6005`): `BOT_ZONE_SPAN = 384m`, `BOT_ZONE_CELL = 1.5m`,
`BOT_ZONE_REBAKE_DRIFT = 96m`, `BOT_ZONE_BAKE_BUDGET_MS = 3ms`, etc. I did not independently grep
every one of these tunables in the current `environment-viewer-v2.html` this session (INFERRED from
the doc for the exact numbers; the three-grid *architecture* itself is MEASURED from the three call
sites above).

**Verdict: not a drift, a genuine scope difference.** `bot-viewer-v2.html`'s map is a small, bounded,
authored arena; `environment-viewer-v2.html` additionally has to navigate open, effectively unbounded
procedural terrain, and the extra grid machinery exists to make that tractable without baking a
kilometer-scale grid up front (the doc's own benchmark shows a full 1200 m grid costs 13 GB for an
eager visibility field — `docs/subsystems/bots.md:5942,5949-5950`).

### 10. Crest cover tuning is deliberately diverged, with a measured reason

`docs/subsystems/bots.md:6054-6079` documents that the harness's crest-cover bake parameters
(`maxSpan: 2m`, `farCells: 12m`) find **zero** crests on env-viewer-v2's gentler terrain, and that
`environment-viewer-v2.html` instead uses `BOT_ZONE_CREST_SPAN_M = 4.5m`,
`BOT_ZONE_CREST_FAR_M = 24m` (`docs/subsystems/bots.md:6003-6004`), with a `bench-bot-nav.mjs --crest`
sweep table showing the harness's values produce 0 crests at any setting on synthetic env-shaped
terrain, while 4.5 m/24 m produces 100. I did not re-run this benchmark or re-grep the current
constants in `environment-viewer-v2.html` this session — **this finding is INFERRED from the doc**,
carried over because it is a first-party, dated, numerically-specific engineering note rather than a
vague claim, but it should be spot-checked against the live file in a follow-up pass.

### 11. Danger field: identical wiring, identical constants

Both files call `recordDanger`/`dangerPenalty`/`dangerBlocksCover` from `bot-danger.js` at matching
sites with matching weight constants:

- Death → `DANGER_DEATH_WEIGHT` (bot-viewer-v2.html:5309/5312/5313, environment-viewer-v2.html:3741/3742)
- Ally hit → `DANGER_HIT_WEIGHT` (bot-viewer-v2.html:5687, environment-viewer-v2.html:4046)
- Flee scoring → `DANGER_FLEE_SCALE` (bot-viewer-v2.html:8882, environment-viewer-v2.html:5420)
- Patrol resume → `DANGER_PATROL_SCALE` (bot-viewer-v2.html:8517/9759, environment-viewer-v2.html:5079/4404)
- Pack-seeking → `DANGER_PACK_SCALE` (bot-viewer-v2.html:5631, environment-viewer-v2.html:4235)
- Cover veto → identical magic threshold `0.35` in both, with the identical comment about the 0.4
  neighbour-spread share: `bot-viewer-v2.html:9515` and `environment-viewer-v2.html:5554`, both:
  `dangerBlocksCover(botDangerField, <team>, rec.anchorCell, nowMs, 0.35);`

MEASURED (call-site greps on both files). This is corroborated by
`docs/subsystems/bots.md:6081-6099` ("Danger field, now live"), which documents the same
site/scale table this session's greps independently reproduced.

### 12. Goal claims: identical wiring

`bot-entity.js:126` re-exports `createGoalClaims` from `bot-separation.js`. Both files instantiate one
`goalClaims` object and claim/release the same six kinds (`'cover', 'flee', 'seek', 'pursue',
'recover', 'pack'`) at matching state-exit points — e.g. `bot-viewer-v2.html:10721-10723` and
`environment-viewer-v2.html:6495-6497` both read, near-verbatim:
```
if (state !== BOT_FLEE) goalClaims.release(bot.id, 'flee');
if (state !== BOT_SEEK) goalClaims.release(bot.id, 'seek');
if (state !== BOT_PURSUE) goalClaims.release(bot.id, 'pursue');
```
MEASURED (full-file greps for `goalClaims.` on both files, ~20 call sites apiece, same kind strings,
same claim/release pattern for cover/flee/seek/pursue/recover/pack).

### 13. Stance overrides: a real, narrow, QA-tooling gap

`bot-stance.js:21-26` defines `STANCE_PRONE/CROUCH/STAND/RUN/DASH`; `bot-stance.js:252-256` defines
`resolveStanceOverride(override, autoStance)` — a manual force-override that defers to the
auto-derived stance unless the override is one of the five valid stance strings.

- `bot-viewer-v2.html:929-931` imports `STANCE_PRONE, STANCE_CROUCH, STANCE_STAND, STANCE_RUN,
  STANCE_DASH, STANCE_DEFAULTS, chooseBotStance, stepStanceTransition, stanceSpeedFactor,
  stanceSpreadScale, stanceHeightScale, stanceCapsuleHeightScale, stanceTurnRateScale,
  resolveStanceOverride, stepStanceWeights, blendStanceHeightScale` — and wires a UI dropdown at
  `bot-viewer-v2.html:1085`: `const BOT_STANCE_OVERRIDES = ['auto', STANCE_STAND, STANCE_CROUCH, STANCE_PRONE, STANCE_RUN, STANCE_DASH];`, consumed at `bot-viewer-v2.html:10714`: `activeBotActor.stance = resolveStanceOverride(botStanceOverride, autoStance);`.
- `environment-viewer-v2.html:144-146` imports `STANCE_CROUCH, STANCE_PRONE, STANCE_STAND,
  STANCE_DEFAULTS, chooseBotStance, stepStanceTransition, stanceSpeedFactor, stanceSpreadScale,
  stanceHeightScale, stanceCapsuleHeightScale, stanceTurnRateScale, stepStanceWeights,
  blendStanceHeightScale` — **no `STANCE_RUN`, `STANCE_DASH`, or `resolveStanceOverride`**.

MEASURED (both import blocks read directly, `resolveStanceOverride` grepped as absent in
`environment-viewer-v2.html`). Env-viewer-v2 does reference `STANCE_RUN`/`STANCE_DASH` in comments
only (`environment-viewer-v2.html:3604,6496`), meaning the auto-derivation (`chooseBotStance`, which
*is* imported by both) can presumably still internally produce `'run'`/`'dash'` string states — I did
not confirm this by reading `bot-stance.js`'s `chooseBotStance` body, so **whether run/dash stances
are actually reachable in env-viewer-v2 is INFERRED, not measured**. What is measured is that
env-viewer-v2 has **no manual QA/debug override control** for stance the way the harness does.

### 14. Sidearm and combat-adjacent modules: identical import surface where checked

- `bot-sidearm.js` import is textually identical on both sides: `SIDEARM_DRAW_MS, SIDEARM_LULL_MS,
  PISTOL_IDS, pickSidearmId, chooseWeaponSlot, outOfAllAmmo` — `bot-viewer-v2.html:6616`,
  `environment-viewer-v2.html:143`. MEASURED.
- `bot-grenade.js` import is textually identical: `GRENADE_DEFAULTS, chooseGrenadeThrow,
  grenadeEvade, throwCountFor` — `bot-viewer-v2.html:117`, `environment-viewer-v2.html:152`.
  MEASURED. I did not trace call sites for either module (i.e. whether the same *values* are used at
  the call site, only that the same functions/constants are imported unmodified).

### 15. Projectile hit-testing and body-hit: one real architectural fork, one exact match

- `combat.js`'s `rayCapsuleHit` is imported and used only by `bot-viewer-v2.html`
  (`bot-viewer-v2.html:6617` import, `bot-viewer-v2.html:11424` call site, direct
  projectile-vs-bot-capsule ray test). A full-file grep of `environment-viewer-v2.html` for
  `rayCapsuleHit` returns zero matches — MEASURED. Env-viewer-v2's projectile/explosive system is
  built on its own entity-registry classes (`ProjectileEntity`, `CombatProjectileEntity`,
  `ExplosionEntity` + `blastDamageAt`, imported at `environment-viewer-v2.html:71-73`), which is a
  different architecture, not a like-for-like port of `bot-viewer-v2.html`'s
  `createProjectileManager` (`bot-viewer-v2.html:116`, which env-viewer-v2 does not import — its
  `bot-projectiles.js` import at `environment-viewer-v2.html:153` only pulls `solveBallisticArc,
  sampleArcPoints`, the trajectory math, not the manager). Whether hit-detection fidelity differs
  behaviorally between the two approaches was **not traced this session** — flagged as open, not
  resolved.
- `bot-body-hit.js`'s `resolveBodyHit`/`resolveAttachmentMatrix` (wound-placement targeting) is
  imported and called by **both**: `bot-viewer-v2.html:99` (import) / `:11307` (call), and
  `environment-viewer-v2.html:77` (import, per this session's last read — see live-editing caveat).
  MEASURED equal on this one.

---

## Ranked list of the most significant parity gaps

1. **Medic contact-radius/cohesion tuning is missing in env-viewer-v2** (`teamCentroid`,
   `MEDIC_CONTACT_RADIUS`, `MEDIC_CONTACT_CREEP` — Finding 3). This directly affects how medics
   converge on and tend to wounded teammates, a visible, frequent behavior in any firefight with a
   medic role active. Real behavioral impact if these symbols aren't reproduced some other way in
   env-viewer-v2's own code (not confirmed either way — the import is simply absent).

2. **`environment-viewer-v2.html` has no manual stance-override / debug tool** (Finding 13). Lower
   behavioral stakes (it doesn't change what bots actually decide to do in the ordinary case,
   `chooseBotStance` is shared) but it removes a QA capability the harness has for isolating and
   testing crouch/prone/run/dash behavior in isolation — this matters for anyone trying to debug
   env-viewer-v2 bot posture issues without switching to the harness.

3. **Projectile hit-testing is architecturally forked** (`rayCapsuleHit` vs. entity-based
   `blastDamageAt`, Finding 15). Unresolved whether this produces different grenade/rocket hit
   outcomes against bots between the two apps — flagged as the single largest *unverified* risk in
   this report, because it touches lethality math directly and neither side was traced to a shared
   or provably-equivalent conclusion.

4. **A stale "known drift" doc note could mislead a future contributor** (Finding 4). The doc at
   `docs/subsystems/bots.md:2353` still reads as if env-viewer-v2's target selection lacks
   danger/pile-on awareness; the code says otherwise as of this session. Not a code gap, but a
   documentation-hygiene risk: someone trusting that note without re-reading the code would
   duplicate work that's already done, or distrust a system that's actually at parity.

5. **`squadSlotWorld` is imported only by the harness** (Finding 3), and **`bot-viewer-v2.html` lacks
   `trackStuck`** (Finding 2) — both are narrow, single-symbol asymmetries with plausible
   map-shape-driven explanations (bounded maze vs. open terrain) rather than obvious bugs, but
   neither was traced to a confirmed behavioral consequence.

6. **Several areas this report could not close out with direct measurement**: `bot-aim.js` local
   override removal (Finding 6, INFERRED from doc only), eye-height convention parity (Finding 7,
   open question), and the exact current values of the crest-cover tunables (Finding 10, INFERRED
   from doc only). None of these are asserted as gaps — they are explicitly flagged as **unverified**,
   and a follow-up pass should read the cited line ranges directly before treating them as settled.
