# Terrain streaming: nothing arrives into the frame it lands in

Date: 2026-09-06. Status: proposed, reviewed by Astra 2026-09-06 (two rounds), not started.
Owner: the terrain sessions (`base-game-terrain.js`, `terrain-system.js`, `terrain-worker.js` are
theirs); authored by the fps-churn session (workshop-webgpu-73) from the capture evidence below.

## Evidence

Base Game walking captures, 2026-09-06 21:18 to 21:19 (`research/stats/base-game-performance-log.json`):

| Capture | Frame max | Terrain pass max | Fold | Colorize | Batch | Collider | Install |
|---|---|---|---|---|---|---|---|
| 21:18:41 | 431 ms | 7.5 ms | 6.3 | 5.9 | 0.4 | 3.0 | 2.9 (1 chunk) |
| 21:18:56 | 221 ms | 14.6 ms | 12.5 | 12.0 | 0.5 | 3.2 | 6.6 (5) |
| 21:19:41 | 141 ms | 37.9 ms | 27.2 | 0.9 | 4.3 | 3.8 | 11.8 (22) |

Terrain is a minority of the walking spikes (the render encode is 54 to 83 ms max in the same
captures, see `docs/render-submission-gpu-driven-plan.md`), but 38 ms in one frame is a hitch on
its own. These maxima are separate counters and need not share a frame. Four causes, all "work
done in the frame the data arrives":

1. **The cascade folds unbudgeted.** `update()` calls `applyMaterials()` with no budget when any
   far LOD chunk (120 / 480 / 1920 m) lands, folding every pending chunk across all levels at once.
   It runs outside the fold timer, so the split under-reports it (fold 27.2 ms vs timed parts 9.0),
   and its second call overwrites `lastColorizeMs` / `lastBatchMs` from the budgeted call.
2. **Colorize is unbudgeted.** `applyMaterials` tints every newly arrived chunk (per-vertex JS
   loop, `colorizeGeometry`) before the two-per-frame batch budget applies. 12 ms in one frame.
3. **Installs burst.** `terrain-system.js` builds geometry (`geometryFromArrays`, bounding sphere,
   dispose of the replaced chunk) inside the worker `onmessage`, on the main thread, as many as
   arrive. 22 in one frame for 11.8 ms; four workers and three cascade systems return the same
   boundary crossing together.
4. **Collider BVH** is budgeted (1/frame) and costs 3 to 4 ms per chunk. Under this plan it is the
   largest single item, which is why step E is part of the plan.

## Design

**A. The worker finishes the chunk.** `terrainTintAt` and its palette move to a dependency-light
`terrain-tint.js` imported by both `terrain-worker.js` and `base-game-terrain.js`. The tile request
carries a tint revision (sea level, palette); the worker returns vertex colours with the geometry,
and a reply whose revision is stale is re-tinted on commit by the main-thread function, which also
stays as the synchronous fallback and behind `recolorAll`. Worker buffers are transferred, not
copied, and the worker returns the bounding sphere so the main thread does not recompute it. A test
asserts numerical parity between worker and main-thread tint.

**B. An integration queue with one shared soft time budget.** Worker results stop being installed
in `onmessage`. They go into a bounded inbox (items and bytes, default 32 items / 48 MB; dispatch
pauses while over the line), keyed by `(system, epoch, key)`, deduplicated, validated at enqueue
and again at commit, and dropped on rebuild, dispose, source swap or worker error. A stale reply
never clears a newer same-key request. `pendingBuildCount` and the unload-idle checks count queued
items.

Each frame `base-game-terrain.js` runs one scheduler over every system and stage with one deadline,
`integrateBudgetMs: 2`, measured with an injected clock:

- Operations are indivisible and small: one install, one bounded batch copy, one BVH. Never a
  multi-chunk transaction.
- The next operation is selected only while budget remains; a started operation may finish past
  the deadline, then the frame stops globally. That is the one-item overrun rule.
- Priority: (1) collision and its install prerequisite for the body's **safety region**, derived
  from the body's swept footprint this frame (the chunk it is in plus any chunk the footprint
  touches, including diagonal crossings), (2) everything else nearest-first across install, near
  fold, cascade fold and far collider, with aging so no item starves. Every operation, safety
  region included, is charged to the same deadline.
- The saved `maxFoldsPerUpdate` and `maxColliderRebuildsPerUpdate` remain as additional per-frame
  count caps (the one-BVH cap in particular stays). They are never mapped to unlimited.
- The cascade's `applyMaterials()` call on `cascadeChanged` is removed; the scheduler covers the
  cascade like every other stage.

Coverage while queued: a queued result has no mesh, so the previous chunk (or the cascade level
under it) stays resident and collided until the replacement is committed. Near/far dissolve masks
and `residencyRevision` read committed residency only. A source swap clears the inbox and falls
back to the cascade's coarse ground exactly as `setSource` does today. Missing safety coverage
after a teleport or source swap is handled by the existing handoff (the heightfield answers until
the volume chunk is back), never by unlimited synchronous catch-up; under permanent overload the
inbox bound is the backpressure and the panel shows it.

**C. Prefetch and hysteresis.** The target set is extended ahead of motion: one chunk column in
the travel direction at walking speed, two in a vehicle, refreshed within a chunk from the current
velocity, while the ring around the actual body is always in the set. Unload radius exceeds load
radius by one chunk of that system's size, stated per cascade level. Dispatch stays at
`maxChunksPerUpdate` per system; the four systems share one in-flight cap, which bounds outstanding
work but not simultaneous completion, which is what the inbox bound is for.

**D. Timing that adds up.** `frameCost` gains `integrateMs` (install + fold + collider + dispose +
bounds + batch growth, whatever the scheduler ran), `queued`, `queuedBytes`, `queuedOldestMs`,
`overruns`, `staleDrops`, `maxItemMs`, `collisionReadyDistance`. Worker tint time arrives in the
message and is reported separately from main-thread time. The capture compares total frame CPU,
not only the terrain pass, so a cost moved into `renderer.render` (the GPU upload that follows an
install) is seen.

**E. BVH in the worker.** `map-collision.js`'s BVH as flat typed arrays, built in the worker and
adopted by `volumeProvider.setChunk` without a rebuild. With a 2 ms budget and a 3 to 4 ms BVH
this is the step that makes the budget real, so it is in scope, sequenced last.

## Steps

- [ ] 1. Snapshot the three files. `terrain-tint.js`; worker returns `colors` and bounds under a
  tint revision; `geometryFromArrays` adopts both; main-thread tint kept as fallback and for a stale
  revision. Tests: parity with the current function; a stale-revision reply is re-tinted.
- [ ] 2. Inbox in `terrain-system.js` with the bounds, keys, validation and lifecycle above.
  Tests (injected clock): 22 queued results drain across frames nearest-first with none lost;
  epoch mismatch and stale same-key replies dropped; inbox over its byte line pauses dispatch;
  dispose clears it.
- [ ] 3. Scheduler in `base-game-terrain.js` across near system, cascade levels and colliders;
  the `cascadeChanged` fold removed; count caps kept. Tests (fake 4 ms BVH cost): all five
  safety-region results arriving together never exceed the deadline by more than one item;
  sustained arrivals never starve a far install (aging); the safety chunk's collider always precedes
  a nearer-first cosmetic install.
- [ ] 4. Coverage tests: walking, teleport, source swap, late collider. The previous chunk draws
  and collides until its replacement commits; masks read committed residency.
- [ ] 5. Prefetch + hysteresis + shared in-flight cap. Tests: a straight walk requests the next
  column before the boundary; a reversal does not re-request; vehicle speed extends by two.
- [ ] 6. `frameCost` / stats fields, `base-game.html` capture events (`terrainIntegrateMs`,
  `terrainQueued`, `terrainOverruns`), the panel terrain line; `docs/subsystems/terrain.md`,
  `docs/subsystems/base-game.md`, `agent_log.csv`.
- [ ] 7. Step E, worker BVH.

## Validation

- Headless: the tests above; `node test-page-syntax.mjs base-game.html`.
- Browser (the user): a walking capture compared with the 21:18 to 21:19 set at the same route
  and settings. Success is the terrain pass p99 under 4 ms **after step 7** (steps 1 to 6 alone are
  bounded by one BVH, so expect about 5 ms there), total frame CPU p95 not worse, `terrainQueued`
  draining to 0 within a second of stopping under normal walking (a bounded workload; a vehicle at
  speed may keep a standing queue), and no visible late ground: a deferred chunk keeps its
  predecessor, so lateness is a coarser ring, not a hole.

## Review rationale (Astra, 2026-09-06, two rounds)

Kept here as the reasons behind the design above, not as separate instructions.

- A shared 2 ms budget is soft against a 3 to 4 ms BVH; ordering install-first could starve
  collision. Hence the single deadline, safety region first, one-item overrun, small item
  granularity, aging, and worker BVH in scope.
- Exempting five chunks from the budget would allow 15 to 20 ms of BVH before anything else.
  Hence the safety region is highest priority but charged to the same deadline, and it is derived
  from the swept footprint rather than four cardinal neighbours.
- "No hole" only held for an installed mesh awaiting batching. Hence committed-residency masks
  and the predecessor kept resident.
- An in-flight cap bounds neither simultaneous completion nor inbox growth. Hence the inbox bound
  in items and bytes, the keys, and validation at both ends.
- Sorting missing keys by predicted distance is prioritisation, not prefetch. Hence the target-set
  extension.
- Installation changes can move a spike into `renderer.render`. Hence total-frame comparison and
  the upload in the measurement.
- A worker import of `base-game-terrain.js` drags the page's dependencies into the worker. Hence
  `terrain-tint.js`.

## Coordination

`base-game-terrain.js`, `terrain-system.js`, `terrain-worker.js` belong to the terrain sessions.
This plan is a proposal to them; the churn session will not edit these files without a yes in
`comms.txt`.
