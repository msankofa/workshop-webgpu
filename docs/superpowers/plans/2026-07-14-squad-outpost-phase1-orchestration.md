# Squad/outpost Phase 1 — handoff + orchestration plan

**Status: not started. Written for context-compaction handoff — read this whole file before doing
anything else, then jump to "Resume here" at the bottom.**

**Source spec:** `docs/superpowers/specs/2026-07-14-squad-outpost-ammo-economy-design.md` (design
only, fully written, four rounds of user refinement already folded in: base squads/outposts/ammo,
temperament-weighted decision rolls + retreat speed, first aid kits + healing, and outpost/squad
map placement). This orchestration doc only covers **Phase 1** of that spec's five-phase plan
(Phase 1 / Phase 2 ammo+medkit / Phase 3 squad pool+drops / Phase 4 outposts). Do not start Phase 2+
work from this doc — write a fresh orchestration doc per phase when the user says go (see
"Standing instruction" below).

**Standing instruction from the user (2026-07-14): orchestrate multiple active parallel Sonnet
agents every phase of this feature**, not solo inline execution. This overrides the project's
usual default (see memory `feedback_subagent_usage.md` — normally prefer inline execution; this is
the explicit-ask carve-out that memory already anticipates). Repeat this pattern — define an exact
contract, split into file-disjoint parallel workstreams, dispatch N `Agent` calls with
`model: "sonnet"` in one message, integrate — for every subsequent phase, not just this one.

## What Phase 1 is (from the spec)

> Squads only, no outposts, no drops. Group existing bots into one squad (min 5), placed via
> today's existing uniform spawn-point sampling (no gradient yet), leader-follow movement, retreat
> speed multiplier, and per-bot temperament. Includes decision roll #1 (squad leader's
> loss-triggered retreat) since it only needs a squad leader, no outpost — attack/hold orders
> otherwise still come from a debug-panel button (not an AI outpost-leader yet). Proves the
> command-hierarchy plumbing, temperament, and leader succession in isolation.

Concretely, six pieces: (1) a `Squad` record + `squads` Map, (2) grouping bots into a squad at
spawn time, (3) per-bot `temperament` (resolves the spec's open question: uniform-random per bot
between two panel-tunable bounds, not a single shared value like the other bot traits — a shared
value can't produce "different" leaders), (4) leader-follow movement for non-leader members with
no target of their own, (5) the loss-triggered retreat decision roll + retreat speed multiplier,
(6) leader succession on death. No ammo, no medkits, no outposts, no ambient drops yet.

## Why only 2 parallel agents (not more) for this phase

`environment-viewer.html` is the one file essentially all of Phase 1's wiring lands in
(state, `spawnBotAt`, `botTickMovement`, `updateBots`, the panel) — it's the same "contended file,
serialize edits to it" situation the existing `2026-07-11-all-weapons-implementation-orchestration.md`
plan already identified for this codebase. The only genuinely file-disjoint piece is the new pure
decision-logic module. So Phase 1 splits into exactly two parallel-safe workstreams:

- **Agent A — pure module** (`squad-activity.js` + `test-squad-activity.mjs`, brand new files,
  never touches `environment-viewer.html`).
- **Agent B — wiring** (`environment-viewer.html` + `code-map.html`, the one agent that owns the
  contended file this phase).

Both work against a **fixed contract** (below) agreed up front, so B can write real calling code
against A's exports before A has actually finished — true parallelism, not sequential-pretending-
to-be-parallel. Later phases (2/3/4) have more separable surface area (new `entity-types/*.js`
files, placement functions, outpost records) and should use more agents — don't cap future phases
at 2 just because Phase 1 only supports 2.

Docs (`docs/subsystems/bots.md`) and `agent_log.csv` are **not** delegated to either agent —
written by the orchestrator (you, post-integration) once the real code exists. Two reasons: (1)
CLAUDE.md's own rule — "a subsystem doc that doesn't match the code is worse than no doc" — rules
out drafting docs against code that doesn't exist yet in a sibling agent; (2) `agent_log.csv` has
had unclosed-quote mistakes twice already this session (heredoc appends missing a trailing `"`) —
keep that file under tighter, single-writer control until that stops happening by habit.

## Fixed contract: `squad-activity.js`

New file, sibling to `bot-activity.js`/`creature-activity.js` (pure, THREE-free, Node-tested,
no imports beyond plain JS — mirror those two files' style exactly). Agent A implements this
exact shape; Agent B calls it exactly this way. Do not rename or restructure without updating both
sides.

```js
// squad-activity.js
export const SQUAD_LOSS_THRESHOLD = 0.4; // fraction of initialSize lost before a leader re-evaluates

// Uniform-random temperament in [min, max]. Called once per bot at spawn (every bot gets one,
// even unsquadded/non-leader bots -- it just sits unused until/unless that bot leads).
export function rollTemperament(min = 0, max = 1, rand = Math.random) {
  return min + rand() * (max - min);
}

// Edge-triggered, latched loss-retreat decision. Pure: takes current state in, returns next state
// out -- caller applies `retreat` to squad.order itself, this never mutates anything.
// - lostFrac < threshold: clears the latch (so a reinforced squad can re-roll if it drops again).
// - lostFrac >= threshold and not yet decided: rolls once, sets the latch, may return retreat:true.
// - lostFrac >= threshold and already decided: no-op, latch stays set, retreat:false (already fired).
export function tickSquadLossDecision({ initialSize, aliveCount, lossRetreatDecided, leaderTemperament, rand = Math.random }) {
  const lostFrac = 1 - aliveCount / initialSize;
  if (lostFrac < SQUAD_LOSS_THRESHOLD) return { lossRetreatDecided: false, retreat: false };
  if (lossRetreatDecided) return { lossRetreatDecided: true, retreat: false };
  const retreatChance = 1 - leaderTemperament; // cautious (low aggression) leaders retreat more readily
  return { lossRetreatDecided: true, retreat: rand() < retreatChance };
}

// Deterministic, evenly-spaced angle for member `memberIndex` of `memberCount` -- assigned ONCE at
// squad formation (formSquad, wiring side) and stored on the bot rec so the formation ring doesn't
// jitter frame to frame from re-randomizing.
export function formationAngleFor(memberIndex, memberCount) {
  return (memberIndex / memberCount) * Math.PI * 2;
}

// World-space point on a loose ring of `radius` around `leaderPos` at a bot's fixed `angleRad`.
// This IS the squad-member movement goal when a member has no combat target of its own -- see
// squadMemberGoal in the wiring contract below, which is a thin environment-viewer.html wrapper
// around this pure function (reads live leader position, calls this, no logic of its own).
export function formationOffset(leaderPos, angleRad, radius) {
  return { x: leaderPos.x + Math.cos(angleRad) * radius, z: leaderPos.z + Math.sin(angleRad) * radius };
}
```

`test-squad-activity.mjs` (plain `node test-squad-activity.mjs`, no framework, same style as every
other `test-*.mjs` in this repo): cover `rollTemperament`'s bounds, `tickSquadLossDecision`'s
latch behavior (below/above/at threshold, already-decided no-op, latch-clear on recovery, both
retreat outcomes with a seeded `rand`), and `formationOffset`/`formationAngleFor`'s geometry
(evenly spaced, correct radius, wraps at `memberCount`).

## Fixed contract: `environment-viewer.html` wiring

Agent B's scope. Exact integration points — grep for the named functions/constants to find real
line numbers (they will have drifted since this doc was written):

1. **New state**, near the existing bot behavior sliders (`botMaxHp`/`botMoveSpeed`/etc., search
   `let botSeekTenacitySec`):
   ```js
   let botSquadModeEnabled = false; // panel toggle; spawn/round-mode groups bots into squads of SQUAD_MIN_SIZE+ instead of independent bots
   let botTemperamentMin = 0.15, botTemperamentMax = 0.85; // sliders
   const SQUAD_MIN_SIZE = 5;
   const SQUAD_FORMATION_RADIUS = 5; // metres, loose ring around the squad leader
   const BOT_RETREAT_SPEED_MULT = 1.45;
   const squads = new Map(); // squadId -> Squad record
   let squadIdSeq = 0;
   ```
   `import { rollTemperament, tickSquadLossDecision, formationAngleFor, formationOffset } from './squad-activity.js';` at the top with the other module imports.

2. **Bot rec** (`spawnBotAt`, search `botPlayers.set(id, {`): add
   `squadId: null, isLeader: false, temperament: rollTemperament(botTemperamentMin, botTemperamentMax), formationAngle: 0,`
   — every bot rolls a temperament at spawn regardless of squad membership (cheap, and it means a
   later-formed squad doesn't need a special case).

3. **`formSquad(botIds)`**, new function near `spawnBotAtSlot`:
   ```js
   function formSquad(botIds) {
     const id = `squad-${++squadIdSeq}`;
     const leaderId = botIds[0];
     const squad = { id, outpostId: null, teamId: 'bots', leaderId, memberIds: new Set(botIds),
       initialSize: botIds.length, order: 'hold', orderTarget: null, lossRetreatDecided: false };
     squads.set(id, squad);
     botIds.forEach((bid, i) => {
       const rec = botPlayers.get(bid);
       rec.squadId = id;
       rec.isLeader = bid === leaderId;
       rec.formationAngle = formationAngleFor(i, botIds.length);
     });
     return squad;
   }
   ```
   Hook into spawn: when `botSquadModeEnabled`, spawn bots in batches of `SQUAD_MIN_SIZE` (reuse
   `spawnBotAtSlot` per-bot, collect the returned ids) and call `formSquad` on each completed
   batch, instead of the existing one-at-a-time independent spawn. **Keep the existing toggle-off
   path byte-identical** — this is additive, not a rewrite of today's spawn behavior.

4. **`squadMemberGoal(rec)`**, new function near `nextPatrolTarget`:
   ```js
   function squadMemberGoal(rec) {
     if (!rec.squadId || rec.isLeader) return null;
     const squad = squads.get(rec.squadId);
     const leader = squad && botPlayers.get(squad.leaderId);
     if (!leader) return null; // no leader (dead, no successor resolved this tick) -- caller falls back to patrol
     return formationOffset(botMidXZ(leader.bot), rec.formationAngle, SQUAD_FORMATION_RADIUS);
   }
   ```
   Wire into `botTickMovement`'s patrol branch: a squadded non-leader bot with no target of its
   own calls `squadMemberGoal` first, falling back to today's `nextPatrolTarget` wander only if it
   returns `null` (unsquadded, leaderless, or the leader check fails).

5. **`updateBots`**, once per tick (after the per-bot FSM loop, alongside `pushBotsApart()`): for
   each squad, compute `aliveCount` via `playerCombat.getSnapshot(id).alive` over `memberIds`, call
   `tickSquadLossDecision`, store the returned `lossRetreatDecided` back onto the squad, and if
   `retreat` came back true set `squad.order = 'retreat'` (target: the squad's formation point —
   for Phase 1, with no outpost yet, just use the squad's original spawn point, tracked as
   `squad.spawnPos` set once in `formSquad`). Also handle **leader succession** here: if
   `!playerCombat.getSnapshot(squad.leaderId).alive`, find the first other alive member and promote
   it (`squad.leaderId = successorId`, flip `isLeader` on both old and new).

6. **Retreat speed**: find wherever `botMoveSpeed` is currently read for movement integration
   (bots.md says "read live every tick by all active bots" — grep `botMoveSpeed` to find the actual
   read site, likely inside `botTickMovement`/`followBotPath`/`stepBotPhysics`'s caller) and
   multiply by `BOT_RETREAT_SPEED_MULT` when `rec.squadId && squads.get(rec.squadId)?.order === 'retreat'`.

7. **Panel**: new "Squads & Outposts" section (same inline-DOM style as the existing "Combat Bots"
   section) — a Squad mode checkbox (`botSquadModeEnabled`), Temperament min/max sliders, a
   squad-count/size readout, and (since no outpost-leader AI exists yet this phase) a manual
   per-squad "Force retreat" / "Force attack" debug button pair that directly sets `squad.order`.

8. **`code-map.html`**: add a node entry for the new `squad-activity.js` file (mirror
   `bot-activity.js`'s existing entry — same subsystem group, `tests: ['test-squad-activity.mjs']`).

**Verification (Agent B runs before reporting done):** extract the `<script type="module">` body
and `node --check` it; run the full `test-*.mjs` suite (must stay green, zero regressions); start
`python serve.py` and `curl` for a 200 on `environment-viewer.html`. Full interactive browser
verification (spawn a squad, watch it hold formation, force a retreat, kill the leader and confirm
succession) is **not** expected from a headless agent — flag it as still-needed in the report back
instead of claiming it works.

## Phase 1 dispatch — send both in ONE message, two `Agent` tool calls, `model: "sonnet"`

**Agent A prompt:**
> Building Phase 1 of a squad AI system for bots in a WebGPU FPS game at
> `G:\My Drive\Scripts\procedural-creature\workshop-webgpu`. Create two new files:
> `squad-activity.js` and `test-squad-activity.mjs`, sibling to the existing `bot-activity.js` /
> `test-bot-activity.mjs` (read those two files first for the exact style to mirror — pure
> functions, no THREE import, no global state, one-line comments only, plain `node test-X.mjs`
> test runner with no framework). Implement exactly this contract (do not deviate from these
> function names/signatures, another agent is writing calling code against this exact shape in
> parallel): [paste the full `squad-activity.js` code block from this doc verbatim]. Write
> `test-squad-activity.mjs` covering: `rollTemperament`'s bounds with a seeded rand;
> `tickSquadLossDecision`'s latch behavior (below threshold, at/above threshold first roll both
> outcomes via a seeded rand, already-decided is a no-op, recovering below threshold clears the
> latch so it can fire again later); `formationAngleFor`/`formationOffset`'s geometry (evenly
> spaced angles, correct radius, wraps correctly at `memberCount`). Run
> `node test-squad-activity.mjs` yourself and confirm it passes before reporting back. Do not touch
> `environment-viewer.html` or any other existing file — these two files are your entire scope.
> Report back: the final export list and confirmation the test file passes.

**Agent B prompt:**
> Building Phase 1 of a squad AI system for bots in a WebGPU FPS game at
> `G:\My Drive\Scripts\procedural-creature\workshop-webgpu`. Read `CLAUDE.md` in this directory
> first for house rules (terse comments, doc/log update requirements — but for THIS task skip the
> doc/agent_log.csv update, the orchestrator handles those separately after your work lands). Read
> `docs/subsystems/bots.md` for how the existing combat-bot system works (`botPlayers` Map,
> `spawnBotAt`, `botTickMovement`, `updateBots`, the debug panel) before editing anything — you're
> extending that system, not replacing it. A sibling agent is building a new pure module
> `squad-activity.js` in parallel against this exact fixed contract (it may or may not exist on
> disk yet when you start — write your code assuming it exists with exactly this shape, it will be
> there by integration time): [paste the full `squad-activity.js` code block from this doc
> verbatim]. Wire squads into `environment-viewer.html` per these exact integration points: [paste
> items 1-7 from the "Fixed contract: environment-viewer.html wiring" section of this doc
> verbatim]. Also add a `squad-activity.js` entry to `code-map.html` mirroring the existing
> `bot-activity.js` entry (item 8 above). Verify: extract the `<script type="module">` body and
> `node --check` it; run every `test-*.mjs` in the repo root and confirm all still pass (zero
> regressions — this is a large existing test suite, all green is required); start
> `python serve.py` and confirm `environment-viewer.html` returns HTTP 200. Do not touch
> `squad-activity.js`, `test-squad-activity.mjs`, `agent_log.csv`, or any `docs/*.md` file — those
> are out of your scope. Report back: what you changed (function/line areas, not a full diff),
> syntax-check and test-suite results, and explicitly flag that interactive browser verification
> (spawn a squad, watch formation-follow, force a retreat, kill the leader and confirm succession)
> is still needed and wasn't possible headless.

## Post-integration steps (orchestrator, after both agents report back)

1. Confirm Agent B's imports from `squad-activity.js` exactly match Agent A's actual exports —
   fix any naming drift (should be none, given the fixed contract, but verify).
2. Re-run `node --check` on the full extracted script and the whole `test-*.mjs` suite yourself
   once more, don't just trust each agent's self-report.
3. Update `docs/subsystems/bots.md` with a new "Squads (Phase 1)" bullet describing what actually
   landed (not what was planned — read the real diff first).
4. Update this spec's phasing checklist / the FSM design spec if it tracks phase status.
5. Append exactly one `agent_log.csv` row yourself. **Before writing it, count the quote characters
   in your own heredoc/edit** — this session lost time twice to unclosed quotes on multi-line
   summary fields. Verify after writing: `awk -F'"' '{ if ((NF-1) % 2 != 0) print NR }' agent_log.csv`
   should not flag your new line.
6. Query real time via `date` before writing the log timestamp — do not guess/increment a
   plausible-looking one (this also happened twice this session).
7. Report Phase 1 complete to the user with a tldr of what shipped and what's still manual-only
   (browser verification), and explicitly ask before starting Phase 2 — don't auto-continue.

## Resume here

1. You are resuming after a context compaction. This file is self-contained; you do not need
   prior conversation history to execute it.
2. If Phase 1 is not yet done (no `squad-activity.js` on disk, no squad state in
   `environment-viewer.html`): send **one message** containing both `Agent` tool calls from
   "Phase 1 dispatch" above, each with `model: "sonnet"`, prompts copied verbatim including the
   pasted contract blocks. Wait for both to return, then do "Post-integration steps."
3. If Phase 1 IS already done (check `git log`/`git status` and `docs/subsystems/bots.md` for a
   "Squads (Phase 1)" section to confirm before assuming): do not redo it. Ask the user whether to
   start Phase 2 (individual ammo + medkit economy — see the source spec's Phasing section) and
   write a fresh `docs/superpowers/plans/<date>-squad-outpost-phase2-orchestration.md` following
   this same doc's structure (contract-first, split into genuinely file-disjoint parallel
   workstreams, `model: "sonnet"`, orchestrator owns docs/agent_log.csv) before dispatching agents.
