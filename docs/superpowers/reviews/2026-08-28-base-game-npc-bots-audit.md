---
title: Base Game NPC bots — WebGPU audit
page: base-game.html
subsystem: multi
scope: The NPC bot slices 1-3 and the lag fixes that followed — server/base-game-npcs.js, server/base-game-rooms.js (NPC wiring, profiler), bot-brain.js wiring, terrain-source-v5.js holeAt, base-game-player-bodies.js NPC bodies, base-game-remote-players.js, base-game-drone-view.js, and the base-game.html panel, spawner and feeds
skill: improve-webgpu
date: 2026-08-28
baseline: server 16 bots 2.24 ms per 120 Hz tick on a v5 world before this audit (bench-base-game-npcs.mjs --v5 --fight); client frame rate reported "fine" by the user online, no capture
measurements: bench-base-game-npcs.mjs and node --cpu-prof (server, headless); no client GPU or frame-profiler numbers in this audit
steps_complete: [1, 3, 5]
steps_partial: [2, 6]
steps_not_run: [4]
findings: 21
severity_counts:
  high: 9
  medium: 8
  low: 1
  info: 3
status_counts:
  fixed: 13
  deferred: 1
  open: 3
  unverified: 4
kind_counts:
  defect: 10
  gap: 5
  regression: 2
  test-gap: 2
  observation: 2
---

# Base Game NPC bots — WebGPU audit

Findings from running `improve-webgpu` over the NPC bot work shipped 2026-08-27 and the two lag
passes that followed on 2026-08-28. Half of this work runs on the relay, not in WebGPU; the skill's
rule still applies there, with the loop at 120 Hz instead of 60, so the server findings are ranked
by the same standard.

The audit is **incomplete**. Step 4 (the visual rubric) has not run: the NPC bodies, the team
tints, the human heads and the spawner laser have never been seen by me in a browser. Step 2 has
server numbers only; the client side rests on the user's report that the frame rate was fine while
the ping was not. ~~`F-13` through `F-15` record those gaps as findings.~~ `F-13`, `F-14`, and the
corrected `F-16` record the remaining visual, client-performance, and online-UAV verification gaps.

**Correction, 2026-08-29.** The original frontmatter rollups said ~~6 fixed / 2 deferred / 5 open /
3 unverified and 8 defects / 4 gaps~~. A direct parse found 8 fixed / 1 deferred / 4 open /
3 unverified and 7 defects / 5 gaps before the corrections below. Findings `F-17` through `F-21`
record the review defects and their implementation fixes; the frontmatter now reflects all 21 findings.

## About this document

Written to be machine-read. The contract a reader can rely on:

- A finding is any `##` heading whose text starts with `F-` followed by digits. Every other `##`
  heading is prose and can be skipped.
- The first fenced ` ```yaml ` block inside a finding is its metadata. Fields are fixed; values come
  from the vocabularies below.
- The four `###` headings inside a finding are always present and always in this order:
  **Cause**, **Effect**, **Solution**, **Result**. A finding that is not fixed still has all four —
  `Solution` is then the proposed fix and `Result` says what has and has not changed.

Vocabularies:

| Field | Values |
|---|---|
| `severity` | `high` · `medium` · `low` · `info` |
| `status` | `fixed` · `deferred` · `open` · `unverified` |
| `kind` | `defect` · `regression` · `gap` · `test-gap` · `observation` |
| `introduced_by` | `this-work` · `donor` · `pre-existing` |
| `runs` | `per-frame` · `per-tick` · `per-think` · `per-snapshot` · `per-interaction` · `per-rebuild` · `once` · `n/a` |

`per-tick` is the relay's 120 Hz loop, `per-think` the brain's 60 Hz step inside it, `per-snapshot`
the 20 Hz broadcast. `severity` follows the skill's rule — where the code runs, not how it reads.
Line numbers are as of 2026-08-28 and will drift; the `symbol` field is the durable half.

# Findings

## F-01 — The v5 hole test scanned a density column five times per body per tick

```yaml
id: F-01
title: The v5 hole test scanned a density column five times per body per tick
severity: high
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-tick
locations:
  - file: terrain-source-v5.js
    line: 205
    symbol: holeAt
    role: the scan
  - file: world-query-heightfield-provider.js
    line: 24
    symbol: hasTerrain
    role: the caller, reached from acceptsQuery, groundProbe and resolveCapsule
  - file: base-game-player-controller.js
    line: 229
    symbol: resolve
    role: the controller step that asks about five times
measured:
  before: 65% of server CPU in fbm3/hashedCell3/densityAt under holeAt (node --cpu-prof, 16 bots, v5); 16 bots 2.24 ms per tick, 32 bots 4.36 ms
  after: "~~16 bots 0.54-0.58 ms per tick, 32 bots 1.02-1.04 ms with the invalid spatial cache~~; exact-cache rerun: 16 bots 0.692 ms, 32 bots 1.271 ms; worst 100 ms slices 13.5 / 20.9 ms"
verified_by: bench-base-game-npcs.mjs --v5 --fight; test-terrain-volume.mjs including both cave-boundary query orders; test-world-query-heightfield.mjs, test-base-game-rooms-terrain.mjs, test-base-game-player.mjs
mutation_tested: false
```

### Cause

`holeAt` decided "is this point a cave mouth" by running `surfaceYAt`, which walks the density
column down from `heightAt + 12 m` to `density.y_min` in 1 m steps and then bisects — about sixty
3D-noise samples. `hasTerrain` calls it, and one player-controller step reaches `hasTerrain` from
`acceptsQuery` (twice), `groundProbe`, `resolveCapsule` and `headroomFor`. Every human player on a
v5 world paid it; every NPC multiplied it, because an NPC is a full controller stepped at 120 Hz.

### Effect

This was the 300 ms ping. The relay's wake-ups ran long, the catch-up cap dropped sim time, the
clients' lockstep queues overran, and the user's manually flown UAV was pulled back by every late
snapshot. It is why the room lagged with a handful of bots when the brain itself was under 2% of the
profile.

### Solution

The scan now stops at `h - warpReach`, the depth the hole test actually needs. ~~The answer is
cached per 0.5 m cell in a 65k-entry map that clears when full; holes are cave mouths metres wide,
so a half-metre cell never straddles one meaningfully.~~ That cache was incorrect at cave boundaries.
It is now a fixed 65k-slot direct-mapped cache that only hits when both exact coordinates match;
hash collisions recompute rather than sharing an answer.

### Result

Four times cheaper per tick at every bot count in the original measurement; the profile's top
entries were then the brain and controller. ~~The half-metre cache was correct because the source is
immutable.~~ Source immutability did not make spatial approximation correct. The exact-coordinate
replacement passes the two-order cave-boundary regression. The refreshed v5 benchmark measured
0.692 ms/tick at 16 bots and 1.271 ms/tick at 32, still below the 8.33 ms tick budget.

## F-02 — The zone bake ran whole in one tick and again on every spawn

```yaml
id: F-02
title: The zone bake ran whole in one tick and again on every spawn
severity: high
status: fixed
kind: defect
introduced_by: this-work
runs: per-interaction
locations:
  - file: server/base-game-npcs.js
    line: 180
    symbol: startBake
    role: the sliced replacement
  - file: server/base-game-npcs.js
    line: 205
    symbol: stepBake
    role: 2 ms of sampling per think, then finalize, vis and corners in their own ticks
measured:
  before: 812 ms in one tick on a v5 world (analytic world ~100 ms), rerun on every spawn request
  after: phases finalize 5 / vis 1-3 / corners 15-18 ms; worst 100 ms slice during a bake 47-78 ms in the bench's batched ticks
verified_by: bench-base-game-npcs.mjs; server/test-base-game-npcs-room.mjs
mutation_tested: false
```

### Cause

The nav grid, visibility field and crest corners for a 384 m zone were baked synchronously inside
`ensureZone`, and `noteSpawnAnchor` marked the zone stale so the next think rebaked it.

### Effect

Each spawn froze the room for most of a second on v5 (bots stood still, then everything caught up
at once). This was the first lag pass; it was real but not the main cost — `F-01` was.

### Solution

`startBake` / `stepBake` sample each cell once under `NPC_BAKE_BUDGET_MS = 2` per think, then run
`finalizeNavGrid`, the vis field and the corner pass in their own ticks; the old zone stays live until
the new one is ready. A spawn adds its point to the live patrol ring instead of rebaking.

### Result

No single tick carries a bake. The corners pass is still the largest single slice (15-18 ms); if it
shows up in the profiler line it is the next thing to slice.

## F-03 — Every remote body allocated a sample object and two arrays per frame

```yaml
id: F-03
title: Every remote body allocated a sample object and two arrays per frame
severity: high
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: base-game-remote-players.js
    line: 146
    symbol: update
    role: the loop that built record.sample from scratch
measured:
  before: 1 object + 2 arrays per remote body per frame (16 bots: 48 allocations per frame)
  after: 0 per frame after the first; one scratch object per record, mutated in place
verified_by: test-base-game-replication.mjs (112 pass); no consumer keeps a reference across frames (grep for lastSample/prevSample in base-game-player-bodies.js is empty)
mutation_tested: false
```

### Cause

`update` wrote `record.sample = { position: [...sample.position], velocity: [...latest.velocity],
... }` for every remote record every frame. Pre-existing, but this work added `team`, `npc` and
`appearance` to it and, more to the point, made sixteen remote bodies a normal room instead of a
rare one.

### Effect

At sixteen bots, 48 short-lived allocations per frame from this loop alone, feeding the collector
on a page that already renders sixteen full rigs.

### Solution

One `sampleScratch` per record, filled field by field.

### Result

~~Allocation-free steady state.~~ The `base-game-remote-players.js` sampling loop is allocation-free
after warm-up, and its consumers read the scratch object synchronously. The HTML feed still allocated
fresh argument and gadget-phase records; that omitted churn is recorded and fixed in `F-21`.

## F-04 — The Solo drone path churned lists and sets with nothing in the air

```yaml
id: F-04
title: The Solo drone path churned lists and sets with nothing in the air
severity: high
status: fixed
kind: defect
introduced_by: this-work
runs: per-frame
locations:
  - file: base-game.html
    line: 1328
    symbol: stepSoloDrones
    role: the per-frame ingest call
  - file: base-game-drone-view.js
    line: 48
    symbol: ingest
    role: allocates a Set and a sanitized copy per drone per call
measured:
  before: 1 array + 1 Set per frame in Solo with zero drones; plus a sanitized object per drone
  after: 0 with no drones and nothing shown
verified_by: inspection only
mutation_tested: false
```

### Cause

`stepSoloDrones` ended with `droneView.ingest([...soloDrones.values()].map(droneWireState), now)`
unconditionally, and `ingest` allocates a `Set` and sanitizes every state.

### Effect

Small but permanent: two allocations every Solo frame for the whole session, with the drones
unused. With a drone up, a sanitized copy per drone per frame as well, which is the cost of
reusing the online path and is left as is.

### Solution

Skip the call when `soloDrones` is empty and the view shows nothing.

### Result

Fixed. The with-drone cost (sanitize per frame) stays; it is one object per drone and the sanitize
is the same function the wire path needs.

## F-05 — syncAll rebuilt the world list and a Set on every think

```yaml
id: F-05
title: syncAll rebuilt the world list and a Set on every think
severity: high
status: fixed
kind: defect
introduced_by: this-work
runs: per-think
locations:
  - file: server/base-game-npcs.js
    line: 276
    symbol: syncAll
    role: per-think body-to-brain sync
measured:
  before: 1 Set + 2 arrays per think (60 Hz) regardless of bot count
  after: 0 in steady state; the world list is rebuilt only when the player set changes
verified_by: server/test-base-game-npcs-room.mjs; bench 16 bots 0.54 ms per tick (sync 1.6 ms per s)
mutation_tested: false
```

### Cause

`new Set()`, `[...worldEntities.keys()]` and `brain.setWorldEntities([...worldEntities.values()])`
ran every think. The brain stores the list by reference (`bot-brain.js:4321`), so a fresh array
was never needed.

### Effect

180 allocations per second on the relay for nothing. Negligible in ms; wrong by the skill's rule.

### Solution

A module-scope `Set` cleared per think and a persistent `_worldList` rebuilt only when an id was
removed or the size changed.

### Result

Fixed. `syncAll` still calls `room.combat.getSnapshot` and `room.ammo.ensureAmmo` per bot per
think; see `F-08`.

## F-06 — The relay stringified the snapshot once per client

```yaml
id: F-06
title: The relay stringified the snapshot once per client
severity: medium
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-snapshot
locations:
  - file: server/base-game-rooms.js
    line: 1284
    symbol: broadcastSnapshots
    role: the 20 Hz broadcast
measured:
  before: JSON.stringify per connected client (8.5 KB payload at 16 bots + 1 player)
  after: once per room; the string is sent to every client
verified_by: server/test-base-game-rooms.mjs and the npc room test (fake sockets receive the same string)
mutation_tested: false
```

### Cause

`broadcast(room)` went through `send(ws, payload)`, which stringifies its argument, once per client.

### Effect

Linear in clients × payload; with NPC entries (appearance, loadout, gadgets) the payload grew and
the multiplier stayed. Small for one or two players, real for a full room.

### Solution

`broadcastSnapshots` stringifies once and sends the string. The profiler counts the bytes.

### Result

Fixed for the periodic broadcast. The event-driven `broadcast(room)` calls (join, leave, world
patch) still stringify per client; they are rare and left alone.

## F-07 — A wake-up profiler now says where relay time goes

```yaml
id: F-07
title: A wake-up profiler now says where relay time goes
severity: info
status: fixed
kind: gap
introduced_by: this-work
runs: per-tick
locations:
  - file: server/base-game-rooms.js
    line: 1210
    symbol: profReport
    role: one line per second when a wake-up ran 12 ms or more, or a gap passed 50 ms
measured:
  before: no server-side timing at all; the lag was diagnosed by bench and guesswork
  after: wake max/avg, gap max, per-phase ms (prepare, think, clients, projectiles, drones), snapshot ms and KB, brain stats
verified_by: bench output under BASE_GAME_PROF=1
mutation_tested: false
```

### Cause

The first lag report could only be answered by reproducing it headless. The relay had no way to say
which phase ran long.

### Effect

Two passes were needed where one would have done: the bake was fixed first because it was the
obvious suspect, and the real cost (`F-01`) only surfaced under a CPU profile.

### Solution

Time every wake-up and every phase, print on threshold. The cost is a dozen `performance.now()`
calls per tick.

### Result

Shipped. ~~The original line reported every listed brain counter.~~ It printed `heightAt undefined`
because it read `stats.heightAt` instead of `stats.heights`; `F-20` records the correction. The line
to paste when a session feels laggy remains `[base-game prof] ...`.

## F-08 — getSnapshot allocates a normalized record per call, several times per bot per tick

```yaml
id: F-08
title: getSnapshot allocates a normalized record per call, several times per bot per tick
severity: medium
status: open
kind: defect
introduced_by: pre-existing
runs: per-tick
locations:
  - file: player-combat.js
    line: 54
    symbol: getSnapshot
    role: returns normalizeSnapshot(...), a fresh object
  - file: server/base-game-rooms.js
    line: 884
    symbol: stepNpcClient
    role: one call per bot per tick
  - file: server/base-game-rooms.js
    line: 340
    symbol: playerEntry
    role: two calls per entry per snapshot
  - file: server/base-game-npcs.js
    line: 262
    symbol: syncEntity
    role: one call per bot per think
measured:
  before: 16 bots: ~16 per tick + 16 per think + 34 per snapshot allocations from this alone
  after: unchanged
verified_by: inspection
mutation_tested: false
```

### Cause

The combat facade normalizes on every read. The NPC path reads it for alive/hp in three places.

### Effect

A few thousand small allocations per second at sixteen bots. Not visible in the bench's ms, but it
is the largest remaining per-tick allocation on the server.

### Solution

Either a non-allocating `isAlive(id)` / `healthOf(id)` on the facade, or have `playerEntry` read the
snapshot once and reuse it. Both are mechanical.

### Result

Not changed in this pass; deferred behind the Solo decision so the facade is touched once.

## F-09 — NPC bodies render as full rigs with no LOD or budget on the remote path

```yaml
id: F-09
title: NPC bodies render as full rigs with no LOD or budget on the remote path
severity: medium
status: unverified
kind: gap
introduced_by: this-work
runs: per-frame
locations:
  - file: base-game-player-bodies.js
    line: 606
    symbol: updateRemote
    role: one full procedural body (human head, expression) per NPC, stepped every frame
  - file: base-game.html
    line: 4640
    symbol: remote bodies loop
    role: feeds every remote record every frame
measured:
  before: not measured; the user reports the frame rate was fine while ping was 300 ms
  after: n/a
verified_by: none
mutation_tested: false
```

### Cause

The remote-body path was built for a few human players. Bots arrive through it unchanged, each a
complete rig with gait, stance blend, weapon mount and a composed human head. `bot-viewer-v3` has a
rig LOD and think stagger for exactly this; the Base Game path has neither.

### Effect

Unknown until measured. The one browser report says the client held up; the bot count that session
is not recorded.

### Solution

Measure first with the frame profiler's `bodies` pass at 16 and 32 bots. If it shows, port v3's rig
LOD (distance-tiered update rate) into `updateRemote`, keyed on the sample's distance from the
camera.

### Result

Open. Needs a browser number before any code.

## F-10 — Team tint is applied once at body creation

```yaml
id: F-10
title: Team tint is applied once at body creation
severity: low
status: open
kind: observation
introduced_by: this-work
runs: per-rebuild
locations:
  - file: base-game-player-bodies.js
    line: 618
    symbol: updateRemote
    role: setTint inside the `!record` branch only
measured:
  before: n/a
  after: n/a
verified_by: inspection
mutation_tested: false
```

### Cause

The tint is chosen from `sample.team` when the body is made; a later team change would not re-tint,
and the rebuild key (`bodyModel` + face) does not include team.

### Effect

None today: an NPC's team never changes and players are all one side. It becomes a bug the day a
side switch ships.

### Solution

Add the team to the rebuild key, or call `setTint` when `sample.team` differs from the record's.

### Result

Left as is, noted for whoever adds sides for players.

## F-11 — npcAccuracy is a slider the server never reads

```yaml
id: F-11
title: npcAccuracy is a slider the server never reads
severity: medium
status: fixed
kind: gap
introduced_by: this-work
runs: n/a
locations:
  - file: base-game.html
    line: 3061
    symbol: npcSec
    role: the range control
  - file: server/base-game-rooms.js
    line: 760
    symbol: syncNpcSettings
    role: maps npcNoticeMs only
measured:
  before: n/a
  after: npcAccuracy 0 doubles donor dispersion, 0.5 preserves it, and 1 removes spread/bloom; npcNoticeMs retains reactionEnabled and changes reactionMs
verified_by: test-bot-aim.mjs; server/test-base-game-npcs-room.mjs
mutation_tested: false
```

### Cause

The shared key was added with the panel; the brain's spread/aim settings were never wired to it.

### Effect

A control that does nothing, which the user will assume is broken rather than unwired.

### Solution

~~Map it in `syncNpcSettings` to `botAimSettings` the way `npcNoticeMs` maps to `reactionMs`.~~ The
notice mapping replaced the entire aim object and disabled its own reaction gate. First make partial
brain aim configuration merge, then map accuracy around the donor's `0.5` baseline.

### Result

Fixed together with `F-19`. Accuracy now controls all spread and bloom amplitudes, while room
notice-time changes preserve `reactionEnabled` and the other donor defaults.

## F-12 — Solo has no bots

```yaml
id: F-12
title: Solo has no bots
severity: medium
status: deferred
kind: gap
introduced_by: this-work
runs: n/a
locations:
  - file: base-game.html
    line: 3070
    symbol: sendNpc
    role: refuses in Solo with a note
measured:
  before: n/a
  after: n/a
verified_by: the note itself
mutation_tested: false
```

### Cause

The brain was wired to a room (`base-game-npcs.js` makes bots as room client records). Solo has no
room. The brain itself needs only `heightAt` and `raycast` and would run in the page; the wiring is
what is missing, and Solo also has no damage model at all ("Solo has nothing to damage").

### Effect

Half the asked scope (Solo and online) is absent.

### Solution

Two routes were laid out for the user: in-page wiring the bot-viewer way (needs a Solo damage
model), or a loopback room running `createBaseGameRoomService` in the tab (identical behaviour to
online, needs an in-memory `terrain-store` twin and a shared-key audit). The user is deciding.

### Result

Deferred on that decision.

## F-13 — Step 4 did not run

```yaml
id: F-13
title: Step 4 did not run
severity: info
status: unverified
kind: observation
introduced_by: this-work
runs: n/a
locations:
  - file: base-game.html
    line: 0
    symbol: n/a
    role: the page under audit
measured:
  before: n/a
  after: n/a
verified_by: none
mutation_tested: false
```

### Cause

The NPC bodies, tints, human heads, spawner laser and aimed placement have not been rendered where I
could see them, and the user drives the browser.

### Effect

Every visual claim about this work is inferred from code. In particular: whether the team tints
read as sides at distance, whether the composed human head sits right on the rig, and whether the
spawner's laser lands where the server's `aimedGroundPoint` puts the bot.

### Solution

The user's look at the page. The questions above are the ones to answer.

### Result

Open until seen.

## F-14 — No client-side numbers in this audit

```yaml
id: F-14
title: No client-side numbers in this audit
severity: info
status: unverified
kind: gap
introduced_by: this-work
runs: n/a
locations:
  - file: base-game.html
    line: 0
    symbol: frameProfiler
    role: the pass breakdown that would answer F-09
measured:
  before: n/a
  after: n/a
verified_by: none
mutation_tested: false
```

### Cause

Step 2 was run headless on the server only.

### Effect

`F-03`, `F-04` and `F-09` are ranked by where they run, not by a measured ms.

### Solution

The frame profiler's `bodies` and `remote` passes with 16 bots in the room, read from the perf HUD.

### Result

Open.

## F-15 — A pre-existing terrain handoff test fails

```yaml
id: F-15
title: A pre-existing terrain handoff test fails
severity: medium
status: open
kind: test-gap
introduced_by: pre-existing
runs: n/a
locations:
  - file: test-base-game-terrain-handoff.mjs
    line: 82
    symbol: handoff completes once the chunk under the player is collidable
    role: the failing assertion
measured:
  before: fails with the working tree; passes at HEAD (git stash / pop)
  after: unchanged; fails identically with the holeAt change reverted
verified_by: run with terrain-source-v5.js swapped for its versions/ snapshot
mutation_tested: false
```

### Cause

Something in the earlier uncommitted work on this branch (not the NPC slices, not `F-01`) changed
the volumetric handoff. Not diagnosed.

### Effect

One red test in the terrain suite that the next person will attribute to whatever they just did.

### Solution

Bisect the working tree's terrain-side changes against that assertion.

### Result

Recorded, not fixed.

## F-16 — The UAV jerk was the server stall, and I misattributed Solo

```yaml
id: F-16
title: The UAV jerk was the server stall, and I misattributed Solo
severity: high
status: unverified
kind: regression
introduced_by: this-work
runs: per-tick
locations:
  - file: server/base-game-rooms.js
    line: 1228
    symbol: stepRoom
    role: the quarter-second catch-up cap that dropped sim time under F-01/F-02
  - file: base-game.html
    line: 1301
    symbol: stepSoloDrones
    role: the Solo path, which never touches the server
measured:
  before: user report — manually flown UAV jerked back and forth online at 300 ms ping
  after: "~~F-01 and F-02 fixed~~; likely addressed by the stall fixes, but not yet retested online by the user"
verified_by: headless 40 s follow-mode run of both drones (smooth; three altitude-cap bumps for the UAV)
mutation_tested: false
```

### Cause

Under the stalls, the client's predicted UAV ran ahead of the room and each late snapshot pulled
it back. I first explained this as a server effect for Solo too; Solo steps drones locally with zero
interpolation delay and has no such path.

### Effect

The online symptom was real and is addressed by `F-01`/`F-02`. The Solo claim was wrong and cost a
turn.

### Solution

None beyond the fixes above; the process note is in memory (answer mechanism questions from the
mode branch in the code, not from the architecture summary).

### Result

~~Fixed.~~ The server stalls are fixed in headless measurements, but the reported online manual-flight
path remains unverified until the user's retest.

## F-17 — The machine-readable rollups described a different finding set

```yaml
id: F-17
title: The machine-readable rollups described a different finding set
severity: medium
status: fixed
kind: test-gap
introduced_by: this-work
runs: once
locations:
  - file: docs/superpowers/reviews/2026-08-28-base-game-npc-bots-audit.md
    line: 13
    symbol: frontmatter rollups
    role: the incorrect status and kind totals
  - file: test-audit-doc.mjs
    line: 15
    symbol: DOC_PATH
    role: covered only the tree audit
measured:
  before: status said 6/2/5/3 instead of 8/1/4/3 fixed/deferred/open/unverified; kinds said 8 defects and 4 gaps instead of 7 and 5
  after: every audit that declares the machine-readable contract has its finding count and three rollups checked
verified_by: test-audit-doc.mjs
mutation_tested: false
```

### Cause

The counts were copied from an earlier draft, while the parser test called the tree audit the “real
document” and never opened this file.

### Effect

Any viewer or agent trusting frontmatter saw the wrong completion state even though all 16 original
finding blocks parsed correctly.

### Solution

Recompute the counts from the parsed findings and make the test discover every `*-audit.md` that
declares a `findings` field. Legacy prose audits remain outside this newer contract.

### Result

Fixed. The original totals are preserved in the correction note above, and the current rollups cover
all 21 findings.

## F-18 — The half-metre hole cache shared answers across a cave boundary

```yaml
id: F-18
title: The half-metre hole cache shared answers across a cave boundary
severity: high
status: fixed
kind: regression
introduced_by: this-work
runs: per-tick
locations:
  - file: terrain-source-v5.js
    line: 210
    symbol: holeAt
    role: the corrected exact-coordinate cache
  - file: test-terrain-volume.mjs
    line: 102
    symbol: cave-boundary cache checks
    role: queries both orders
measured:
  before: (-96.24,-100) was false and (-95.76,-100) true uncached, but both used key -201326792 and the first answer won
  after: both points retain their own answer in either query order
verified_by: test-terrain-volume.mjs
mutation_tested: false
```

### Cause

`holeAt` quantized coordinates to a half-metre key but evaluated the first exact point placed in that
bucket. A cave boundary can cross any bucket; source immutability does not prevent that.

### Effect

Heightfield collision beside a cave mouth depended on which point a body queried first, potentially
creating a false floor or false hole.

### Solution

Use a fixed direct-mapped cache whose slot is hashed spatially but whose hit requires exact X and Z.
A slot collision recomputes, so caching cannot change the terrain answer.

### Result

Fixed and boundary-tested. The exact cache is slower than the invalid spatial approximation but the
refreshed 16/32-bot measurements remain 0.692/1.271 ms per tick against an 8.33 ms budget.

## F-19 — A notice-time patch replaced the whole aim configuration

```yaml
id: F-19
title: A notice-time patch replaced the whole aim configuration
severity: high
status: fixed
kind: defect
introduced_by: this-work
runs: per-think
locations:
  - file: server/base-game-rooms.js
    line: 776
    symbol: syncNpcSettings
    role: sends the partial room settings
  - file: bot-brain.js
    line: 733
    symbol: botAimSettings setter
    role: now merges partial settings
  - file: tools/bot-brain-gen/3-generate.py
    line: 182
    symbol: botAimSettings generator setter
    role: keeps regeneration consistent
measured:
  before: reactionEnabled became undefined, so botAimReady returned true and npcNoticeMs did nothing
  after: reactionEnabled remains true, reactionMs follows the room value, and accuracy endpoints reach spread/bloom
verified_by: test-bot-aim.mjs; server/test-base-game-npcs-room.mjs; test-bot-brain.mjs
mutation_tested: false
```

### Cause

The room correctly sent a partial `{ reactionMs }` patch, but the generated setter assigned that
object wholesale instead of merging it with the donor defaults.

### Effect

The direct `reactionEnabled` gate read `undefined` and treated every visible target as ready to fire.
The notice slider was as ineffective as the unwired accuracy slider.

### Solution

Merge partial `botAimSettings` in both the generator and generated module. Map `npcAccuracy` from
twice the donor dispersion at 0, through donor behavior at 0.5, to zero spread and bloom at 1.

### Result

Fixed. The room test changes both controls and reads the brain's effective aim settings; the pure aim
test pins the three accuracy points.

## F-20 — The profiler printed an undefined height counter

```yaml
id: F-20
title: The profiler printed an undefined height counter
severity: medium
status: fixed
kind: defect
introduced_by: this-work
runs: per-tick
locations:
  - file: server/base-game-npcs.js
    line: 94
    symbol: stats.heights
    role: the real counter
  - file: server/base-game-rooms.js
    line: 54
    symbol: formatBaseGameNpcProfStats
    role: the corrected formatter
measured:
  before: profiler lines ended with heightAt undefined
  after: the formatter prints the numeric stats.heights value
verified_by: server/test-base-game-npcs-room.mjs
mutation_tested: false
```

### Cause

The NPC stats field is named `heights`; the new log line read `heightAt`.

### Effect

The diagnostic added specifically to distinguish terrain cost from brain cost omitted its terrain
sample count.

### Solution

Extract the NPC suffix formatter, read `s.heights`, and assert that a known count appears with no
`undefined` text.

### Result

Fixed. Live and test profiler lines now expose the height sample count.

## F-21 — The HTML remote feed still allocated records and computed gadget phases three times

```yaml
id: F-21
title: The HTML remote feed still allocated records and computed gadget phases three times
severity: high
status: fixed
kind: defect
introduced_by: this-work
runs: per-frame
locations:
  - file: base-game.html
    line: 4287
    symbol: remoteAudioFeed and remoteBodyFeed
    role: persistent feed scratch records
  - file: base-game.html
    line: 4767
    symbol: remote bodies loop
    role: fills scratch and computes gadget phases once
measured:
  before: at least 4 fresh objects per non-gadget remote per frame from two feed literals and repeated phase results
  after: 0 feed or phase objects per remote per frame after scratch initialization
verified_by: inspection; the audio and body consumers read fields synchronously and retain only copied scalar/vector state
mutation_tested: false
```

### Cause

`F-03` stopped allocations inside interpolation but did not follow the sample into the page. The page
made fresh audio/body argument objects and invoked `remoteGadgetPhases` three times for the same sample.

### Effect

Sixteen NPCs still produced steady per-frame garbage in the exact feed loop the audit scoped, so the
original “allocation-free steady state” result was too broad.

### Solution

Reuse one audio record, one body record, and one gadget result/phase record across the synchronous
loop. Compute gadget phases once and pass that result to both body and held-gadget presentation.

### Result

Fixed by inspection. Client frame and garbage-collector measurements remain part of the open `F-14`
browser capture.
