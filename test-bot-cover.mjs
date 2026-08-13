// Node tests for the cover peek/fight cycle (Task 4): real pure modules end-to-end on a
// hand-built L-wall map, driven through a minimal harness mirroring bot-viewer's cover wiring
// (pickCoverCorner/coverCornerValid/peek cycle are the SAME code the viewer imports).
// Run: node test-bot-cover.mjs
import { buildNavGrid, floodFill, cellToWorld } from './nav-grid.js';
import { buildSightGrid, buildVisibilityField, cellIndexAt } from './nav-visibility.js';
import { buildCornerMap } from './nav-corners.js';
import { chooseBotState, BOT_PATROL, BOT_SEEK, BOT_FLEE, BOT_AIM, BOT_COVER_MOVE, BOT_COVER_HOLD } from './bot-activity.js';
import {
  createPeekCycle, stepPeekCycle, peekPosition, peekAiming, peekExposed, approachXZ,
  coverCornerValid, pickCoverCorner, rollPeekIn,
  PEEK_OUT_S, PEEK_IN_MIN_S, PEEK_IN_MAX_S, PEEK_SLIDE_S, PEEK_APPROACH_SPEED,
  stepCoverGate, noteCoverSwitch, coverSwitchAllowed, coverInBand,
  COVER_INVALID_GRACE_S, COVER_SWITCH_COOLDOWN_S, COVER_RANGE_FACTOR, COVER_PEEK_MISS_LIMIT,
  coverHoldExitReason, COVER_FIRE_DROUGHT_S, COVER_THREAT_STALE_S,
  COVER_ALLY_DOWN_FRESH_S, COVER_ALLY_DOWN_BEARING_COS,
  peekPhaseOffsetS, PEEK_CYCLE_NOMINAL_S, PEEK_PHASE_OFFSET_MAX_S,
  coverSeatBand, COVER_ANCHOR_REACH, COVER_ANCHOR_LEAVE,
  coverCommitTimedOut, COVER_COMMIT_TIMEOUT_S,
  createCoverBlacklist, blacklistCover, coverBlacklisted, pruneCoverBlacklist, COVER_BLACKLIST_TTL_MS,
  fleePathExposure, fleePathExposureFromParents, fleeCandidateScore,
  FLEE_EXPOSURE_STRIDE, FLEE_EXPOSURE_PENALTY, FLEE_PATH_COST, FLEE_COVER_BONUS, FLEE_CENTROID_PULL,
} from './bot-cover.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// ---- pure peek-cycle units: timers, slide interpolation, aim/fire eligibility ----
{
  const rand0 = () => 0, rand1 = () => 0.999999;
  ok(near(rollPeekIn(rand0), PEEK_IN_MIN_S), 'rollPeekIn hits the jitter floor');
  ok(rollPeekIn(rand1) < PEEK_IN_MAX_S && rollPeekIn(rand1) > PEEK_IN_MAX_S - 0.001, 'rollPeekIn approaches the jitter ceiling');
  const peek = createPeekCycle(rand0);
  ok(peek.phase === 'in' && peek.exposure === 0, 'cycle starts concealed at the anchor');
  ok(!peekAiming(peek) && !peekExposed(peek), 'concealed phase neither aims nor fires');
  const dt = 1 / 60;
  for (let t = 0; t < PEEK_IN_MIN_S + dt; t += dt) stepPeekCycle(peek, dt, rand0);
  ok(peek.phase === 'sliding' && peek.outward, 'in-hold elapses into the outward slide');
  ok(peekAiming(peek) && !peekExposed(peek), 'slide-out aims but cannot fire yet');
  for (let t = 0; t < PEEK_SLIDE_S + 2 * dt; t += dt) stepPeekCycle(peek, dt, rand0);
  ok(peek.phase === 'out' && peek.exposure === 1, 'slide completes fully exposed at peekPos');
  ok(peekAiming(peek) && peekExposed(peek), 'exposed phase aims and may fire');
  const a = { x: 0, z: 0 }, p = { x: 1.1, z: 0 };
  const at = peekPosition(peek, a, p);
  ok(near(at.x, 1.1) && near(at.z, 0), 'peekPosition returns peekPos at exposure 1');
  for (let t = 0; t < PEEK_OUT_S + PEEK_SLIDE_S + 3 * dt; t += dt) stepPeekCycle(peek, dt, rand0);
  ok(peek.phase === 'in' && peek.exposure === 0, 'out-hold + slide-in returns concealed');
  // approach: clamped step, no overshoot, exact landing
  const step1 = approachXZ({ x: 0, z: 0 }, { x: 10, z: 0 }, 1);
  ok(near(step1.x, 1) && near(step1.z, 0), 'approachXZ clamps to maxStep');
  const step2 = approachXZ({ x: 9.9, z: 0 }, { x: 10, z: 0 }, 1);
  ok(step2.x === 10 && step2.z === 0, 'approachXZ lands exactly on the target');
}

// ---- S10 alternating peeks: per-group phase offset on the first concealed hold ----
{
  const rand0 = () => 0;
  // Regression: the no-argument form is byte-identical to the pre-S10 cycle.
  const plain = createPeekCycle(rand0);
  ok(plain.phase === 'in' && plain.t === 0 && plain.exposure === 0 && plain.outward === false &&
     near(plain.inHoldS, PEEK_IN_MIN_S), 'createPeekCycle() with no offset is unchanged');
  ok(Object.keys(plain).length === 5, 'the cycle object gains no fields when no offset is passed');
  ok(peekPhaseOffsetS(0) === 0, 'the first claimant of a threat takes no extra hold');
  ok(peekPhaseOffsetS(-1) === 0 && peekPhaseOffsetS(NaN) === 0 && peekPhaseOffsetS(undefined) === 0,
    'a bogus group index degrades to no offset');
  ok(near(peekPhaseOffsetS(1), PEEK_OUT_S), 'the second claimant hides one full peek window longer');
  ok(near(peekPhaseOffsetS(2), 2 * PEEK_OUT_S), 'the third stacks another window');
  for (let i = 0; i < 40; i++) ok(peekPhaseOffsetS(i) < PEEK_PHASE_OFFSET_MAX_S + 1e-9,
    'no group index ever asks for more than the two-cycle bound');
  ok(PEEK_PHASE_OFFSET_MAX_S > PEEK_CYCLE_NOMINAL_S, 'the bound is more than a single cycle');
  ok(PEEK_CYCLE_NOMINAL_S > PEEK_OUT_S, 'a nominal cycle is longer than the exposed window it staggers');
  // Distinct phases for a realistic group size (a clamp would collapse everything past the bound).
  const phases = new Set();
  for (let i = 0; i < 5; i++) phases.add(peekPhaseOffsetS(i).toFixed(4));
  ok(phases.size === 5, 'a five-bot cover group gets five distinct phases');
  ok(peekPhaseOffsetS(5) !== peekPhaseOffsetS(4), 'past the bound the offset wraps instead of re-syncing');
  // Jitter must survive ON TOP of the offset: the offset staggers, jitter decorrelates the drift.
  const lo = createPeekCycle(() => 0, peekPhaseOffsetS(2));
  const hi = createPeekCycle(() => 0.999999, peekPhaseOffsetS(2));
  ok(near(lo.inHoldS, PEEK_IN_MIN_S + 2 * PEEK_OUT_S), 'offset adds to the jittered hold, it does not replace it');
  ok(hi.inHoldS - lo.inHoldS > PEEK_IN_MAX_S - PEEK_IN_MIN_S - 0.001, 'the full jitter range survives the offset');
  // Behaviour: a same-threat pair should tile its exposure, not share it. Same seed both ways so the
  // ONLY difference is the phase offset (pre-fix, identical bots peeked in perfect lockstep).
  const dt = 1 / 60, RUN_S = 8, frames = Math.round(RUN_S / dt);
  function pairExposure(offsets) {
    const cycles = offsets.map((o) => createPeekCycle(rand0, o));
    let both = 0, some = 0;
    for (let f = 0; f < frames; f++) {
      for (const p of cycles) stepPeekCycle(p, dt, rand0);
      const exposed = cycles.filter(peekExposed).length;
      if (exposed > 1) both++;
      if (exposed > 0) some++;
    }
    return { both, some };
  }
  const lockstep = pairExposure([0, 0]);
  const staggered = pairExposure([peekPhaseOffsetS(0), peekPhaseOffsetS(1)]);
  ok(lockstep.both > 0.4 * frames, 'unstaggered clones stand exposed together half the time (the S10 bug)');
  // Residual overlap is the PEEK_SLIDE_S handover at the window boundary, not a shared camp.
  ok(staggered.both < 0.15 * lockstep.both,
    `staggering all but eliminates the shared exposure window (${staggered.both} vs ${lockstep.both} frames)`);
  ok(staggered.both * dt < 2 * PEEK_SLIDE_S * (RUN_S / PEEK_CYCLE_NOMINAL_S),
    'what overlap remains is boundary handover, under one slide per cycle');
  ok(staggered.some > lockstep.some,
    `staggering buys more frames with someone shooting (${staggered.some} vs ${lockstep.some})`);
  ok(lockstep.some === lockstep.both + 0 || lockstep.some >= lockstep.both, 'sanity: shared frames are a subset of covered frames');
  // Three bots on one threat still tile (the offset is per-index, not a two-way toggle).
  const trio = pairExposure([peekPhaseOffsetS(0), peekPhaseOffsetS(1), peekPhaseOffsetS(2)]);
  ok(trio.some > staggered.some, 'a third staggered bot widens the covered window further');
}

// ---- pure hysteresis gate: grace debounce + switch cooldown (2026-07-23 thrash fix) ----
{
  const gate = { invalidSince: null, switchedAt: null };
  let r = stepCoverGate(gate, true, 1000);
  ok(r.holdValid && !r.maySwitch, 'valid frames hold without switching');
  r = stepCoverGate(gate, false, 1100);
  ok(r.holdValid && !r.maySwitch, 'fresh invalid inside grace still holds');
  stepCoverGate(gate, true, 1200);
  ok(gate.invalidSince == null, 'a valid frame clears the invalid latch');
  stepCoverGate(gate, false, 1300);
  r = stepCoverGate(gate, false, 1300 + COVER_INVALID_GRACE_S * 1000);
  ok(!r.holdValid && r.maySwitch, 'sustained invalid past grace releases and may switch');
  noteCoverSwitch(gate, 2000);
  ok(gate.invalidSince == null, 'a switch clears the invalid latch');
  ok(!coverSwitchAllowed(gate, 2100), 'switch cooldown blocks an immediate re-switch');
  ok(coverSwitchAllowed(gate, 2000 + COVER_SWITCH_COOLDOWN_S * 1000), 'cooldown expiry re-allows switching');
  stepCoverGate(gate, false, 2100);
  r = stepCoverGate(gate, false, 2100 + COVER_INVALID_GRACE_S * 1000);
  ok(!r.holdValid && !r.maySwitch, 'past grace but inside cooldown: release without a switch');
}

// ---- pure weapon-linked cover band (far camps fall through to pursue) ----
{
  const standoff = 10;
  ok(coverInBand(standoff * COVER_RANGE_FACTOR - 0.1, standoff, false), 'threat inside the band allows entry');
  ok(!coverInBand(standoff * COVER_RANGE_FACTOR + 0.1, standoff, false), 'threat past the band blocks entry');
  ok(coverInBand(standoff * COVER_RANGE_FACTOR + 0.4, standoff, true, 0.6), 'committed hold gets exit-buffer hysteresis');
  ok(!coverInBand(standoff * COVER_RANGE_FACTOR + 0.7, standoff, true, 0.6), 'far past band+buffer breaks the hold');
  ok(COVER_PEEK_MISS_LIMIT > 3, 'peek miss limit exceeds the open-field pursue miss streak');
}

// ---- pure seat band: HOLD<->MOVE hysteresis (C3, 2026-07-25 crowded-cover flap fix) ----
{
  ok(COVER_ANCHOR_LEAVE > COVER_ANCHOR_REACH, 'the leave threshold sits outside the enter threshold');
  ok(COVER_ANCHOR_LEAVE - COVER_ANCHOR_REACH >= 0.3, 'band width exceeds one pushout displacement (~0.3 m)');
  ok(coverSeatBand(0.1, false), 'approaching bot inside reach seats');
  ok(!coverSeatBand(0.6, false), 'approaching bot outside reach keeps moving');
  ok(coverSeatBand(0.6, true), 'a shoved holder inside the band keeps its seat (was a MOVE flip)');
  ok(coverSeatBand(COVER_ANCHOR_LEAVE, true), 'exactly at the leave threshold still holds');
  ok(!coverSeatBand(COVER_ANCHOR_LEAVE + 1e-9, true), 'past the leave threshold the holder is off-station');
  ok(coverSeatBand(COVER_ANCHOR_REACH, false), 'exactly at reach counts as arrived');
  ok(!coverSeatBand(COVER_ANCHOR_REACH + 1e-9, false), 'a hair past reach is not yet arrived');
  // The flap repro: pushout oscillates the bot around the old single threshold; the band absorbs it.
  let flips = 0, seated = false;
  for (let i = 0; i < 40; i++) {
    const dist = i % 2 === 0 ? 0.3 : 0.7; // 0.7 > old 0.45 threshold, < new leave
    const next = coverSeatBand(dist, seated);
    if (next !== seated) flips++;
    seated = next;
  }
  ok(flips === 1 && seated, `pushout oscillation seats once and stays (${flips} flips)`);
}

// ---- pure commit timeout: measures travel time, not corner age (C2) ----
{
  ok(coverCommitTimedOut(0, COVER_COMMIT_TIMEOUT_S * 1000 + 1), 'travel past the timeout window abandons the corner');
  ok(!coverCommitTimedOut(0, COVER_COMMIT_TIMEOUT_S * 1000), 'exactly at the window is not yet timed out');
  ok(!coverCommitTimedOut(null, 1e9), 'a bot that is not traveling never times out (null stamp)');
  // The repro: 30 s of good holding then a 0.5 m shove. Re-stamping on HOLD->MOVE resets the clock.
  const heldSince = 1000, shovedAt = 31000;
  ok(coverCommitTimedOut(heldSince, shovedAt), 'pre-fix stamp (commit time) reads as instantly timed out');
  ok(!coverCommitTimedOut(shovedAt, shovedAt + 500), 're-stamped on re-entry the shoved holder has a fresh window');
  ok(COVER_COMMIT_TIMEOUT_S >= COVER_FIRE_DROUGHT_S, 'travel window is at least as long as the drought window');
}

// ---- pure blacklist TTL: expiry + prune-on-write/read (C14) ----
{
  const bl = createCoverBlacklist();
  ok(bl instanceof Map && bl.size === 0, 'a fresh blacklist is an empty map');
  ok(!coverBlacklisted(bl, 42, 1000), 'an unlisted cell is never skipped');
  blacklistCover(bl, 42, 1000);
  ok(coverBlacklisted(bl, 42, 1000), 'a freshly listed cell is skipped');
  ok(coverBlacklisted(bl, 42, 1000 + COVER_BLACKLIST_TTL_MS - 1), 'the cell stays skipped for the whole TTL');
  ok(!coverBlacklisted(bl, 42, 1000 + COVER_BLACKLIST_TTL_MS), 'the cell is usable again once the TTL elapses');
  ok(bl.size === 0, 'the expiring read pruned the entry (no unbounded growth)');
  // Re-listing extends, it does not stack: a corner that keeps failing stays out, but only for one TTL.
  blacklistCover(bl, 7, 2000);
  blacklistCover(bl, 7, 5000);
  ok(bl.get(7) === 5000 + COVER_BLACKLIST_TTL_MS, 're-listing refreshes the expiry from the latest write');
  // Prune-on-write sweeps stale siblings so the map tracks live vetoes only.
  blacklistCover(bl, 8, 5000);
  blacklistCover(bl, 9, 5000 + COVER_BLACKLIST_TTL_MS + 1);
  ok(!bl.has(7) && !bl.has(8) && bl.has(9), 'a later write prunes every expired entry');
  pruneCoverBlacklist(bl, 5000 + 2 * COVER_BLACKLIST_TTL_MS + 2);
  ok(bl.size === 0, 'an explicit prune clears the map once everything expired');
  ok(!coverBlacklisted(null, 1, 0), 'a missing blacklist skips nothing');
  blacklistCover(null, 1, 0); // must not throw
  ok(COVER_BLACKLIST_TTL_MS > COVER_FIRE_DROUGHT_S * 1000, 'TTL outlasts the drought window that writes it');
}

// ---- pure route exposure sampling (L5): fraction of the flee path the threat can see ----
{
  const THREAT = 900;
  // Stub field: only cells listed in `seen` are visible from THREAT (canSee is symmetric in prod).
  const fieldOf = (seen) => ({ canSee: (a, b) => a === THREAT && seen.has(b) });
  const walkable = { cells: new Uint8Array(64).fill(1) };

  ok(near(fleePathExposure(fieldOf(new Set([10, 11])), walkable, THREAT, [10, 11, 12, 13], 1), 0.5),
    'half-visible route reports 0.5 exposure');
  ok(fleePathExposure(fieldOf(new Set([10, 11, 12, 13])), walkable, THREAT, [10, 11, 12, 13], 1) === 1,
    'a route fully in the open reports 1');
  ok(fleePathExposure(fieldOf(new Set()), walkable, THREAT, [10, 11, 12, 13], 1) === 0,
    'a fully concealed route reports 0');
  // Stride: sampling every k-th cell, not every cell (routes are cell-dense, LOS is not).
  const six = [20, 21, 22, 23, 24, 25];
  const strideField = fieldOf(new Set([20, 23]));
  ok(near(fleePathExposure(strideField, walkable, THREAT, six, 1), 2 / 6), 'stride 1 samples every cell');
  ok(near(fleePathExposure(strideField, walkable, THREAT, six, 3), 1), 'stride 3 samples only indices 0 and 3');
  ok(near(fleePathExposure(strideField, walkable, THREAT, six, 2), 1 / 3), 'stride 2 samples indices 0,2,4');
  ok(near(fleePathExposure(strideField, walkable, THREAT, six), fleePathExposure(strideField, walkable, THREAT, six, FLEE_EXPOSURE_STRIDE)),
    'the omitted stride defaults to FLEE_EXPOSURE_STRIDE');
  ok(FLEE_EXPOSURE_STRIDE >= 1 && Number.isInteger(FLEE_EXPOSURE_STRIDE), 'the default stride is a positive integer');
  ok(near(fleePathExposure(strideField, walkable, THREAT, six, 0), 2 / 6), 'a bogus stride below 1 degrades to every cell');
  // Degenerate inputs: no path / no field / no threat cell contribute no exposure penalty.
  ok(fleePathExposure(strideField, walkable, THREAT, [], 1) === 0, 'an empty path has no exposure');
  ok(fleePathExposure(strideField, walkable, THREAT, null, 1) === 0, 'a missing path has no exposure');
  ok(fleePathExposure(null, walkable, THREAT, six, 1) === 0, 'a missing field has no exposure');
  ok(fleePathExposure(strideField, walkable, -1, six, 1) === 0, 'an off-grid threat cell has no exposure');
  ok(fleePathExposure(strideField, walkable, null, six, 1) === 0, 'a null threat cell has no exposure');
  // Invalid cells count as UNSEEN but still occupy a sample slot (fail-open, like exposedToThreat).
  ok(near(fleePathExposure(fieldOf(new Set([20])), walkable, THREAT, [20, -1, null, 999], 1), 0.25),
    'invalid path cells sample as unseen rather than being skipped');
  const blocked = { cells: new Uint8Array(64).fill(1) };
  blocked.cells[21] = 0;
  ok(near(fleePathExposure(fieldOf(new Set([20, 21])), blocked, THREAT, [20, 21], 1), 0.5),
    'an unwalkable path cell reads unseen even when the field claims visibility');
  ok(fleePathExposure(fieldOf(new Set([20, 21])), null, THREAT, [20, 21], 1) === 1,
    'with no navGrid the field alone decides');

  // Parent-chain form: same measure with zero allocation, walked back from the goal.
  const parent = new Int32Array(16).fill(-1);
  for (let k = 1; k <= 5; k++) parent[k] = k - 1;
  const chainField = fieldOf(new Set([1, 2, 3]));
  const chainCells = { cells: new Uint8Array(16).fill(1) };
  ok(near(fleePathExposureFromParents(chainField, chainCells, THREAT, parent, 0, 5, 1),
    fleePathExposure(chainField, chainCells, THREAT, [0, 1, 2, 3, 4, 5], 1)),
    'parent-walk and array forms agree at stride 1');
  ok(near(fleePathExposureFromParents(chainField, chainCells, THREAT, parent, 0, 5, 1), 0.5),
    'parent-walk samples the whole chain including start and goal');
  ok(fleePathExposureFromParents(chainField, chainCells, THREAT, parent, 0, 0, 1) === 0,
    'goal == start samples the single start cell');
  const broken = Int32Array.from(parent);
  broken[3] = -1;
  ok(near(fleePathExposureFromParents(chainField, chainCells, THREAT, broken, 0, 5, 1), 1 / 3),
    'a severed parent chain scores what it reached instead of hanging');
  ok(fleePathExposureFromParents(chainField, chainCells, THREAT, null, 0, 5, 1) === 0, 'a missing parent array has no exposure');
  ok(fleePathExposureFromParents(chainField, chainCells, THREAT, parent, 0, -1, 1) === 0, 'a negative goal key has no exposure');
}

// ---- pure flee-candidate score: one place for every term weight (L5 + S9) ----
{
  const base = { threatDistance: 10, pathDist: 0, covered: false, exposure01: 0, centroidDistance: null };
  ok(fleeCandidateScore({}) === 0, 'an all-default candidate scores 0');
  ok(near(fleeCandidateScore(base), 10), 'threat distance carries straight into the score');
  ok(near(fleeCandidateScore({ ...base, pathDist: 5 }), 10 - FLEE_PATH_COST * 5), 'path cost is charged per metre travelled');
  ok(near(fleeCandidateScore({ ...base, covered: true }), 10 + FLEE_COVER_BONUS), 'a covered endpoint earns the cover bonus');
  ok(near(fleeCandidateScore({ ...base, covered: true, coverScore: 4 }), 14), 'the harness tunable overrides the default cover bonus');
  // Term-by-term ranking checks.
  ok(fleeCandidateScore({ ...base, covered: true }) > fleeCandidateScore(base), 'covered beats uncovered at equal distance');
  const cleanRoute = fleeCandidateScore({ ...base, covered: true, exposure01: 0 });
  const openRoute = fleeCandidateScore({ ...base, covered: true, exposure01: 1 });
  ok(openRoute < cleanRoute, 'a route across the threat lane scores below a concealed route to the same cell');
  // L5 repro: the endpoint bit alone used to be worth the full bonus regardless of the run to it.
  const residual = openRoute - fleeCandidateScore(base);
  ok(residual <= 0.2 * FLEE_COVER_BONUS,
    `a fully-exposed route cancels the cover bonus (${residual.toFixed(2)} of ${FLEE_COVER_BONUS} left)`);
  ok(near(FLEE_EXPOSURE_PENALTY * 0.5, fleeCandidateScore({ ...base }) - fleeCandidateScore({ ...base, exposure01: 0.5 })),
    'the exposure penalty scales linearly with the exposed fraction');
  let prev = Infinity;
  for (let e = 0; e <= 1.0001; e += 0.1) {
    const s = fleeCandidateScore({ ...base, covered: true, exposure01: e });
    ok(s < prev, 'score decreases monotonically as route exposure rises');
    prev = s;
  }
  // A covered cell 10 m of extra walking away but reached unseen beats a close covered cell in the open.
  ok(fleeCandidateScore({ ...base, covered: true, pathDist: 10, exposure01: 0 }) >
     fleeCandidateScore({ ...base, covered: true, pathDist: 0, exposure01: 1 }),
    'a longer concealed run outranks a short sprint through the lane');
  // S9 squad pull: breaks ties toward the squad, never overrides real separation from the threat.
  ok(near(fleeCandidateScore({ ...base, centroidDistance: null }), fleeCandidateScore({ ...base })),
    'a null centroid distance switches the term off');
  ok(near(fleeCandidateScore({ ...base, centroidDistance: undefined }), fleeCandidateScore({ ...base })),
    'an undefined centroid distance switches the term off');
  ok(near(fleeCandidateScore({ ...base, centroidDistance: 0 }), fleeCandidateScore({ ...base })),
    'sitting on the centroid costs nothing');
  const nearSquad = fleeCandidateScore({ ...base, centroidDistance: 4 });
  const farSquad = fleeCandidateScore({ ...base, centroidDistance: 12 });
  ok(nearSquad > farSquad, 'at equal safety the wounded bot retreats toward its squad, not into empty map');
  ok(near(nearSquad - farSquad, FLEE_CENTROID_PULL * 8), 'the squad pull is exactly the documented per-metre weight');
  ok(fleeCandidateScore({ threatDistance: 20, centroidDistance: 30 }) > fleeCandidateScore({ threatDistance: 10, centroidDistance: 0 }),
    'a 10 m threat-distance advantage outweighs a 30 m walk from the squad');
  ok(FLEE_CENTROID_PULL * 40 < 10, 'the squad pull cannot dominate a 10 m threat-distance gap anywhere on a 40 m map');
}

// ---- L-wall map bake (same shape test-nav-corners.mjs proves out) ----
const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 20 };
const rects = [
  { x: 10, z: 8, w: 1, d: 8, h: 3 },      // vertical arm, x in [9.5,10.5], z in [4,12]
  { x: 13.5, z: 11.5, w: 6, d: 1, h: 3 }, // horizontal arm, x in [10.5,16.5], z in [11,12]
];
function inRect(rect, x, z) { return Math.abs(x - rect.x) <= rect.w / 2 && Math.abs(z - rect.z) <= rect.d / 2; }
const grid = buildNavGrid((x, z) => !rects.some(rc => inRect(rc, x, z)), bounds, 1);
const field = buildVisibilityField(grid, buildSightGrid(grid, rects));
const map = buildCornerMap(grid, rects, field);
ok(map.corners.length > 0, 'L-wall bake yields corner records');

// ---- minimal harness mirroring bot-viewer's sentry cover block + hold handler ----
const DT = 1 / 60;
const MOVE_SPEED = 2.4;
const ANCHOR_REACH = COVER_ANCHOR_REACH;
function makeDefender(pos, rand) {
  return { pos: { ...pos }, state: BOT_PATROL, rec: null, peek: null, blacklist: createCoverBlacklist(), rand,
    gate: { invalidSince: null, switchedAt: null }, nowMs: 0, switches: 0,
    ammo: Infinity, shots: 0, lastShotAt: null, lastSeenAt: null, lastKnown: null,
    holdSince: null, moveSince: null, lastExit: null };
}
function commitRec(d, rec) {
  if (d.rec !== rec) { d.peek = null; d.holdSince = null; d.switches++; noteCoverSwitch(d.gate, d.nowMs); }
  d.rec = rec;
}
function releaseRec(d) { d.rec = null; d.peek = null; d.holdSince = null; d.gate.invalidSince = null; }
// opts.vanished = live target gone from sight: lastSeenAt freezes, threatPos plays the stale lastKnown.
function stepDefender(d, threatPos, opts = {}) {
  d.nowMs += DT * 1000;
  const world = { corners: map.corners, field, navGrid: grid, searchRadius: 10, skip: (rec) => d.blacklist.has(rec.anchorCell) };
  const defCell = cellIndexAt(grid, d.pos.x, d.pos.z);
  const threatCell = cellIndexAt(grid, threatPos.x, threatPos.z);
  const visible = !opts.vanished && field.canSee(defCell, threatCell);
  if (visible) { d.lastSeenAt = d.nowMs; d.lastKnown = { ...threatPos }; }
  let coverCommitted = (d.state === BOT_COVER_MOVE || d.state === BOT_COVER_HOLD) && !!d.rec;
  let coverValid = false;
  if (coverCommitted) {
    // Wall-clock exits first (mirrors bot-viewer): stale ghost -> investigate, fire drought -> blacklist.
    const holdExit = coverHoldExitReason({ nowMs: d.nowMs,
      holdSinceMs: d.state === BOT_COVER_HOLD ? d.holdSince : null,
      lastShotAtMs: d.lastShotAt, lastSeenAtMs: d.lastSeenAt,
      targetVisible: visible, targetAlive: true });
    if (holdExit) {
      if (holdExit === 'drought') blacklistCover(d.blacklist, d.rec.anchorCell, d.nowMs);
      releaseRec(d);
      coverCommitted = false;
      d.lastExit = holdExit;
    } else {
      // Debounced validity + cooldown-gated re-pick, mirroring bot-viewer's cover block.
      const g = stepCoverGate(d.gate, coverCornerValid({ field, navGrid: grid }, d.rec, threatPos), d.nowMs);
      coverValid = g.holdValid;
      if (!coverValid && g.maySwitch) {
        const next = pickCoverCorner(world, d.pos, threatPos);
        if (next && next !== d.rec) { commitRec(d, next); coverValid = true; }
      }
      if (!coverValid) { releaseRec(d); coverCommitted = false; }
    }
  }
  const probe = !coverCommitted && coverSwitchAllowed(d.gate, d.nowMs) ? pickCoverCorner(world, d.pos, threatPos) : null;
  const seat = d.peek && d.rec ? peekPosition(d.peek, d.rec.anchorPos, d.rec.peekPos) : d.rec?.anchorPos;
  const atCoverAnchor = coverCommitted && !!seat && Math.hypot(seat.x - d.pos.x, seat.z - d.pos.z) <= ANCHOR_REACH;
  let { state } = chooseBotState({ current: d.state, ctx: {
    targetVisible: visible, aimError: 0, readyToFire: visible && d.ammo > 0, hasLastKnown: !!d.lastKnown,
    targetDistance: Math.hypot(threatPos.x - d.pos.x, threatPos.z - d.pos.z),
    pursueDistance: 6, fleeDistance: 2, pursueHealthOk: true,
    coverAvailable: coverCommitted || !!probe, atCoverAnchor, coverValid,
    allyHitNearby: false, coverCommitted, fireCapable: d.ammo > 0 } });
  // Invariant (mirrors bot-viewer): a cover state must own a committed corner or self-heal out.
  if (state === BOT_COVER_MOVE || state === BOT_COVER_HOLD) {
    if (!d.rec && probe) commitRec(d, probe);
    if (!d.rec) state = visible ? BOT_AIM : BOT_SEEK;
  }
  d.state = state;
  if (state === BOT_COVER_MOVE) {
    d.peek = null;
    d.holdSince = null;
    d.pos = approachXZ(d.pos, d.rec.anchorPos, MOVE_SPEED * DT);
  } else if (state === BOT_COVER_HOLD) {
    d.holdSince ??= d.nowMs;
    d.peek = d.peek ?? createPeekCycle(d.rand);
    stepPeekCycle(d.peek, DT, d.rand);
    d.pos = approachXZ(d.pos, peekPosition(d.peek, d.rec.anchorPos, d.rec.peekPos), PEEK_APPROACH_SPEED * DT);
    if (peekExposed(d.peek) && visible && d.ammo > 0) { d.ammo -= 1; d.shots += 1; d.lastShotAt = d.nowMs; }
  } else {
    if (d.rec) { d.rec = null; d.peek = null; }
    d.holdSince = null;
    if (state === BOT_SEEK && d.lastKnown) d.pos = approachXZ(d.pos, d.lastKnown, MOVE_SPEED * DT);
  }
  return { visible };
}
function canSeeFrom(pos, threatPos) {
  return field.canSee(cellIndexAt(grid, pos.x, pos.z), cellIndexAt(grid, threatPos.x, threatPos.z));
}

// ---- scenario: static attacker east of the wall; defender breaks for the correct corner ----
const attackerEast = { x: 13.5, z: 7.5 };
const d = makeDefender({ x: 13.5, z: 2.5 }, lcg(1234));
ok(canSeeFrom(d.pos, attackerEast), 'defender starts exposed to the attacker');
stepDefender(d, attackerEast);
ok(d.state === BOT_COVER_MOVE && !!d.rec, `engaged defender breaks for cover (got ${d.state})`);
let arrived = -1;
for (let f = 1; f <= Math.round(6 / DT); f++) {
  stepDefender(d, attackerEast);
  if (d.state === BOT_COVER_HOLD) { arrived = f; break; }
}
ok(arrived > 0, 'defender reaches BOT_COVER_HOLD within 6s');
const firstRec = d.rec;
{
  const threatCell = cellIndexAt(grid, attackerEast.x, attackerEast.z);
  ok(!!firstRec && !field.canSee(threatCell, firstRec.anchorCell), 'held anchor is hidden from the attacker');
  ok(!!firstRec && field.canSee(threatCell, firstRec.peekCell), 'held peek cell sees the attacker');
  ok(Math.hypot(firstRec.anchorPos.x - d.pos.x, firstRec.anchorPos.z - d.pos.z) <= ANCHOR_REACH, 'defender stands at the anchor on arrival');
}

// ---- 12s of holding: peek cycle alternates exposed at peekPos / concealed at anchorPos ----
{
  const phases = []; // contiguous {phase, frames}
  let exposedSeen = 0, concealedSeen = 0;
  for (let f = 0; f < Math.round(12 / DT); f++) {
    stepDefender(d, attackerEast);
    ok(d.state === BOT_COVER_HOLD, 'defender keeps holding vs a static attacker');
    if (d.state !== BOT_COVER_HOLD) break;
    const ph = d.peek.phase;
    if (!phases.length || phases[phases.length - 1].phase !== ph) phases.push({ phase: ph, frames: 0 });
    phases[phases.length - 1].frames++;
    // settled samples only (skip the settle window after each transition)
    if (d.peek.t > 0.3) {
      if (ph === 'out') {
        exposedSeen++;
        ok(near(d.pos.x, d.rec.peekPos.x, 1e-6) && near(d.pos.z, d.rec.peekPos.z, 1e-6), 'exposed frames stand at peekPos');
        ok(canSeeFrom(d.pos, attackerEast), 'exposed frames can see the attacker');
        ok(peekAiming(d.peek) && peekExposed(d.peek), 'exposed frames are fire-eligible');
      } else if (ph === 'in') {
        concealedSeen++;
        ok(near(d.pos.x, d.rec.anchorPos.x, 1e-6) && near(d.pos.z, d.rec.anchorPos.z, 1e-6), 'concealed frames stand at anchorPos');
        ok(!canSeeFrom(d.pos, attackerEast), 'concealed frames are hidden from the attacker');
        ok(!peekAiming(d.peek), 'concealed frames are not aiming out');
      }
    }
  }
  ok(exposedSeen > 0 && concealedSeen > 0, 'cycle produced both exposed and concealed samples');
  const outDurs = phases.filter(s => s.phase === 'out').map(s => s.frames * DT);
  const inDurs = phases.filter((s, i) => s.phase === 'in' && i > 0 && i < phases.length - 1).map(s => s.frames * DT);
  ok(outDurs.length >= 2, `at least two full peeks in 12s (got ${outDurs.length})`);
  ok(outDurs.slice(0, -1).every(t => Math.abs(t - PEEK_OUT_S) <= 3 * DT), `out-holds run ~PEEK_OUT_S (got ${outDurs.map(t => t.toFixed(2))})`);
  ok(inDurs.every(t => t >= PEEK_IN_MIN_S - DT && t <= PEEK_IN_MAX_S + 3 * DT), `in-holds stay in the jitter band (got ${inDurs.map(t => t.toFixed(2))})`);
  ok(inDurs.length >= 2 && Math.max(...inDurs) - Math.min(...inDurs) > 0.01, 'in-holds are jittered, not a metronome');
}

// ---- attacker teleports behind the wall: validity bit test flips, defender re-picks ----
{
  while (d.peek.phase !== 'in') stepDefender(d, attackerEast); // teleport while concealed, deterministic re-pick origin
  const attackerWest = { x: 4.5, z: 7.5 };
  ok(!coverCornerValid({ field, navGrid: grid }, firstRec, attackerWest), 'old corner is invalid vs the teleported attacker');
  const expected = pickCoverCorner({ corners: map.corners, field, navGrid: grid, searchRadius: 10, skip: (rec) => d.blacklist.has(rec.anchorCell) }, d.pos, attackerWest);
  // The re-pick is debounced now: it lands once sustained invalidity outlives the grace window.
  let switched = false;
  for (let f = 0; f < Math.round((COVER_INVALID_GRACE_S + COVER_SWITCH_COOLDOWN_S + 0.5) / DT) && !switched; f++) {
    stepDefender(d, attackerWest);
    if (d.rec !== firstRec) switched = true;
  }
  if (expected) {
    ok(switched, 'sustained invalidation re-picks within grace+cooldown');
    ok(!!d.rec && d.rec !== firstRec, 're-picked corner differs from the flanked one');
    let held = false;
    for (let f = 0; f < Math.round(8 / DT); f++) {
      stepDefender(d, attackerWest);
      if (d.state === BOT_COVER_HOLD) { held = true; break; }
    }
    ok(held, 'defender reaches HOLD at the re-picked corner');
    const threatCell = cellIndexAt(grid, attackerWest.x, attackerWest.z);
    ok(!field.canSee(threatCell, d.rec.anchorCell) && field.canSee(threatCell, d.rec.peekCell), 're-picked corner is valid cover vs the west attacker');
  } else {
    ok(d.state !== BOT_COVER_MOVE && d.state !== BOT_COVER_HOLD, 'with no valid corner the defender falls out of cover states');
  }
}

// ---- every corner blacklisted (the bad-peek seam): invalidation falls out of cover entirely ----
{
  for (const rec of map.corners) blacklistCover(d.blacklist, rec.anchorCell, d.nowMs);
  const onAnchor = d.rec ? { x: d.rec.anchorPos.x, z: d.rec.anchorPos.z } : { x: 9, z: 3.6 };
  // Attacker standing on the anchor cell: canSee(a,a) makes it invalid; grace must elapse first.
  for (let f = 0; f < Math.round((COVER_INVALID_GRACE_S + 0.2) / DT); f++) stepDefender(d, onAnchor);
  ok(d.rec === null, 'blacklisted re-pick finds nothing and releases the corner');
  ok(d.state !== BOT_COVER_MOVE && d.state !== BOT_COVER_HOLD, `defender falls back out of cover states (got ${d.state})`);
}

// ---- per-frame validity flicker must not thrash the corner pick (QA bug B, 599 switches pre-fix) ----
{
  const d2 = makeDefender({ x: 13.5, z: 2.5 }, lcg(777));
  const east = { x: 13.5, z: 7.5 }, west = { x: 4.5, z: 7.5 };
  let arrived = false;
  for (let f = 0; f < Math.round(8 / DT) && !arrived; f++) { stepDefender(d2, east); arrived = d2.state === BOT_COVER_HOLD; }
  ok(arrived, 'flicker scenario defender reaches HOLD first');
  const heldRec = d2.rec;
  ok(!coverCornerValid({ field, navGrid: grid }, heldRec, west), 'flank position really invalidates the held corner');
  const switchesBefore = d2.switches;
  for (let f = 0; f < Math.round(10 / DT); f++) {
    stepDefender(d2, f % 2 === 0 ? east : west); // validity flips every single frame
    ok(d2.state === BOT_COVER_HOLD, 'per-frame flicker never breaks the hold');
    if (d2.state !== BOT_COVER_HOLD) break;
  }
  ok(d2.rec === heldRec, 'per-frame flicker keeps the same corner');
  ok(d2.switches === switchesBefore, `per-frame flicker causes zero corner switches (got ${d2.switches - switchesBefore})`);
}

// ---- slow validity oscillation: switches are rate-limited by the cooldown, not per flip ----
{
  const d3 = makeDefender({ x: 13.5, z: 2.5 }, lcg(4242));
  const east = { x: 13.5, z: 7.5 }, west = { x: 4.5, z: 7.5 };
  let arrived = false;
  for (let f = 0; f < Math.round(8 / DT) && !arrived; f++) { stepDefender(d3, east); arrived = d3.state === BOT_COVER_HOLD; }
  ok(arrived, 'oscillation scenario defender reaches HOLD first');
  const switchesBefore = d3.switches;
  const dwellFrames = Math.round(0.6 / DT); // dwell > grace so flips genuinely register
  const totalS = 12;
  for (let f = 0; f < Math.round(totalS / DT); f++) {
    stepDefender(d3, Math.floor(f / dwellFrames) % 2 === 0 ? west : east);
  }
  const switches = d3.switches - switchesBefore;
  const bound = Math.ceil(totalS / COVER_SWITCH_COOLDOWN_S) + 1;
  ok(switches > 0, 'slow oscillation does exercise re-picking');
  ok(switches <= bound, `corner switches stay cooldown-bounded over ${totalS}s (${switches} <= ${bound})`);
}

// ---- pure wall-clock exit pressure (2026-07-23 cover-limbo fix) ----
{
  const base = { nowMs: 60000, holdSinceMs: 50000, lastShotAtMs: 59000, lastSeenAtMs: 59500, targetVisible: false, targetAlive: true };
  ok(coverHoldExitReason(base) === null, 'recent shot + recent sighting keeps the hold');
  ok(coverHoldExitReason({ ...base, lastSeenAtMs: 60000 - COVER_THREAT_STALE_S * 1000 }) === 'stale', 'live threat unseen past the staleness window exits stale');
  ok(coverHoldExitReason({ ...base, lastSeenAtMs: 50000, targetVisible: true }) === null, 'a visible threat is never stale');
  ok(coverHoldExitReason({ ...base, lastSeenAtMs: 50000, targetAlive: false }) === null, 'a dead threat is never stale (band/validity own that exit)');
  ok(coverHoldExitReason({ ...base, lastShotAtMs: 50000, lastSeenAtMs: 59500 }) === 'drought', 'held past the drought window without a shot exits drought');
  ok(coverHoldExitReason({ ...base, lastShotAtMs: null, holdSinceMs: 60000 - COVER_FIRE_DROUGHT_S * 1000, lastSeenAtMs: 59500 }) === 'drought', 'never-fired hold droughts off holdSince alone');
  ok(coverHoldExitReason({ ...base, lastShotAtMs: null, holdSinceMs: null, lastSeenAtMs: 59500 }) === null, 'no drought while still moving to the anchor (holdSince null)');
  ok(COVER_THREAT_STALE_S > 2 && COVER_FIRE_DROUGHT_S > PEEK_IN_MAX_S + PEEK_OUT_S + 2 * PEEK_SLIDE_S, 'windows dwarf brief LOS loss and a full peek cycle');
}

// ---- S8 'allyDown' exit: a fresh lethal report from a NEW bearing invalidates the corner ----
{
  // Holder at the origin; the corner is aimed north (+z). Every arg optional -> old behaviour.
  const holder = { x: 0, z: 0 };
  const north = { x: 0, z: 10 }, east = { x: 10, z: 0 }, south = { x: 0, z: -10 };
  const base = { nowMs: 60000, holdSinceMs: 59000, lastShotAtMs: 59500, lastSeenAtMs: 59500,
    targetVisible: true, targetAlive: true };
  // Regression: absent ally-down args reproduce every legacy verdict exactly.
  const legacy = [
    [{ ...base }, null],
    [{ ...base, targetVisible: false, lastSeenAtMs: 60000 - COVER_THREAT_STALE_S * 1000 }, 'stale'],
    [{ ...base, lastShotAtMs: 50000, holdSinceMs: 50000 }, 'drought'],
    [{ ...base, holdSinceMs: null, lastShotAtMs: null }, null],
  ];
  for (const [args, want] of legacy) {
    ok(coverHoldExitReason(args) === want, `legacy verdict ${want} unchanged without ally-down args`);
    ok(coverHoldExitReason({ ...args, allyDownAt: null, allyDownFrom: null, heldThreat: null, holderPos: holder }) === want,
      `explicit null ally-down args reproduce ${want}`);
  }
  const withDown = (over) => coverHoldExitReason({ ...base, allyDownFrom: east, heldThreat: north, holderPos: holder, ...over });
  ok(withDown({ allyDownAt: 59500 }) === 'allyDown', 'a fresh lethal report from 90deg away breaks the hold');
  ok(withDown({ allyDownAt: 60000 - COVER_ALLY_DOWN_FRESH_S * 1000 }) === 'allyDown', 'exactly at the freshness edge still counts');
  ok(withDown({ allyDownAt: 60000 - COVER_ALLY_DOWN_FRESH_S * 1000 - 1 }) === null, 'a stale lethal report disturbs nothing');
  ok(withDown({ allyDownAt: 59500, allyDownFrom: south }) === 'allyDown', 'a shooter behind the corner is a new bearing');
  ok(withDown({ allyDownAt: 59500, allyDownFrom: { x: 0, z: 6 } }) === null, 'a death on the SAME bearing keeps the corner');
  ok(withDown({ allyDownAt: 59500, allyDownFrom: { x: 4, z: 10 } }) === null, 'a small bearing change stays inside the deadzone');
  ok(withDown({ allyDownAt: 59500, heldThreat: null }) === null, 'no held threat bearing -> no comparison, no exit');
  ok(withDown({ allyDownAt: 59500, allyDownFrom: null }) === null, 'no report bearing -> no comparison, no exit');
  ok(withDown({ allyDownAt: 59500, allyDownFrom: holder }) === null, 'a degenerate (zero-length) bearing never exits');
  // Frame contract: omit holderPos and the two args are already-relative direction vectors.
  ok(coverHoldExitReason({ ...base, allyDownAt: 59500, allyDownFrom: { x: 1, z: 0 }, heldThreat: { x: 0, z: 1 } }) === 'allyDown',
    'direction vectors work without a holder position');
  // Precedence: 'stale' still wins (the threat is gone), 'allyDown' outranks the slower drought clock.
  ok(coverHoldExitReason({ ...base, targetVisible: false, lastSeenAtMs: 60000 - COVER_THREAT_STALE_S * 1000,
    allyDownAt: 59500, allyDownFrom: east, heldThreat: north, holderPos: holder }) === 'stale',
    'a vanished threat still exits stale, not allyDown');
  ok(coverHoldExitReason({ ...base, lastShotAtMs: 50000, holdSinceMs: 50000,
    allyDownAt: 59500, allyDownFrom: east, heldThreat: north, holderPos: holder }) === 'allyDown',
    'fresh casualty intel outranks the drought clock (and so must not blacklist the corner)');
  ok(COVER_ALLY_DOWN_BEARING_COS > 0.7 && COVER_ALLY_DOWN_BEARING_COS < 0.72, 'the bearing gate is the documented ~45deg');
  ok(COVER_ALLY_DOWN_FRESH_S * 1000 < COVER_THREAT_STALE_S * 1000, 'the ally-down window is far tighter than the staleness window');
}

// ---- ladder: a bot that cannot fire must never camp AIM or break for cover ----
{
  ok(chooseBotState({ ctx: { targetVisible: true, targetDistance: 14, pursueDistance: 6, fleeDistance: 2, fireCapable: false } }).state === BOT_FLEE,
    'visible enemy + dry gun retreats instead of camping AIM');
  ok(chooseBotState({ ctx: { targetVisible: true, targetDistance: 14, knifeRequested: true, fireCapable: false } }).state === 'knife',
    'knife eligibility outranks the dry-gun retreat');
  ok(chooseBotState({ ctx: { targetVisible: true, targetDistance: 5, coverAvailable: true, fireCapable: false, fleeDistance: 2 } }).state === BOT_FLEE,
    'dry gun never breaks for a fresh corner');
  ok(chooseBotState({ ctx: { targetVisible: false, coverAvailable: true, allyHitNearby: true, fireCapable: false } }).state !== BOT_COVER_MOVE,
    'dry gun ignores the ally-hit cover entry');
  const held = chooseBotState({ current: BOT_COVER_HOLD, ctx: { coverCommitted: true, coverValid: true, atCoverAnchor: true, fireCapable: false } });
  ok(held.state === BOT_COVER_HOLD, 'a committed dry hold persists until the drought exit breaks it (viewer-owned)');
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true, fireCapable: false, knifeCapable: false } }).state === BOT_PATROL,
    'fully disarmed bot patrols rather than chasing');
  ok(chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true, fireCapable: false, knifeCapable: true } }).state === BOT_SEEK,
    'knife-armed dry bot still investigates');
}

// ---- repro: dry mag in HOLD had zero exit pressure (shots drive every engagement exit) ----
{
  const dA = makeDefender({ x: 13.5, z: 2.5 }, lcg(99));
  dA.ammo = 3;
  let arrived = false, moveDisp = 0, movePrev = null;
  for (let f = 0; f < Math.round(8 / DT) && !arrived; f++) {
    stepDefender(dA, attackerEast);
    if (dA.state === BOT_COVER_MOVE) {
      if (movePrev) moveDisp += Math.hypot(dA.pos.x - movePrev.x, dA.pos.z - movePrev.z);
      movePrev = { ...dA.pos };
    }
    arrived = dA.state === BOT_COVER_HOLD;
  }
  ok(arrived, 'dry-mag repro reaches HOLD while it still has rounds');
  ok(moveDisp > 0.5, `COVER_MOVE makes real progress toward its anchor (${moveDisp.toFixed(2)}m)`);
  for (let f = 0; f < Math.round(10 / DT) && dA.ammo > 0; f++) stepDefender(dA, attackerEast);
  ok(dA.ammo === 0 && dA.shots === 3, 'defender runs its mag dry from the peek');
  const drySince = dA.nowMs;
  const dryAnchor = dA.rec?.anchorCell;
  let releasedAt = null;
  for (let f = 0; f < Math.round((COVER_FIRE_DROUGHT_S + 3) / DT) && releasedAt == null; f++) {
    stepDefender(dA, attackerEast);
    if (dA.state !== BOT_COVER_HOLD && dA.state !== BOT_COVER_MOVE) releasedAt = dA.nowMs;
    // invariant: any frame still in a cover state owns a committed corner
    if (dA.state === BOT_COVER_MOVE || dA.state === BOT_COVER_HOLD) ok(!!dA.rec, 'cover state implies a committed corner');
  }
  ok(releasedAt != null, 'dry hold releases (pre-fix: camped forever, zero displacement)');
  ok(releasedAt - drySince <= (COVER_FIRE_DROUGHT_S + 1.5) * 1000, 'dry hold breaks within the drought window');
  ok(dA.lastExit === 'drought', `dry hold exits via drought (got ${dA.lastExit})`);
  ok(dryAnchor != null && dA.blacklist.has(dryAnchor), 'drought blacklists the unusable anchor');
  for (let f = 0; f < Math.round(2 / DT); f++) {
    stepDefender(dA, attackerEast);
    ok(dA.state !== BOT_COVER_MOVE && dA.state !== BOT_COVER_HOLD && dA.state !== BOT_AIM,
      `dry bot never re-camps cover/AIM after the drought exit (got ${dA.state})`);
  }
}

// ---- repro: threat slips away while holding -> stale lastKnown kept the hold alive forever ----
{
  const dG = makeDefender({ x: 13.5, z: 2.5 }, lcg(55));
  let arrived = false;
  for (let f = 0; f < Math.round(8 / DT) && !arrived; f++) { stepDefender(dG, attackerEast); arrived = dG.state === BOT_COVER_HOLD; }
  ok(arrived, 'ghost repro reaches HOLD first');
  const ghostAnchor = dG.rec.anchorCell;
  const vanishedAt = dG.nowMs;
  let outAt = null;
  for (let f = 0; f < Math.round((COVER_THREAT_STALE_S + 2.5) / DT) && outAt == null; f++) {
    stepDefender(dG, attackerEast, { vanished: true });
    if (dG.state !== BOT_COVER_HOLD) outAt = dG.nowMs;
  }
  ok(outAt != null, 'ghost hold releases (pre-fix: 40s+ camp against a threat unseen the whole time)');
  ok(outAt - vanishedAt <= (COVER_THREAT_STALE_S + 1) * 1000, 'ghost hold breaks within the staleness window');
  ok(dG.lastExit === 'stale', `ghost hold exits via stale (got ${dG.lastExit})`);
  ok(!dG.blacklist.has(ghostAnchor), 'stale release keeps the corner usable (no blacklist)');
  ok(dG.state === BOT_SEEK, `released ghost-holder investigates last-known (got ${dG.state})`);
  const seekFrom = { ...dG.pos };
  for (let f = 0; f < Math.round(1.5 / DT); f++) stepDefender(dG, attackerEast, { vanished: true });
  const seekDisp = Math.hypot(dG.pos.x - seekFrom.x, dG.pos.z - seekFrom.z);
  ok(seekDisp > 1, `a non-cover state that owns a path walks it (${seekDisp.toFixed(2)}m in 1.5s)`);
}

// ---- real-map L5 repro: endpoint-only scoring sends the flee run across the shooter's lane ----
// Same flood/candidate scan bot-viewer-v2's findFleeGoal runs, on the baked L-wall map.
{
  const threatAt = { x: 14.5, z: 4.5 };   // shooter east of the vertical wall arm, watching the open south
  const source = { x: 5.5, z: 2.5 };      // fleeing bot southwest of it, caught in the open
  const squadAt = { x: 2.5, z: 6.5 };     // the rest of the squad, holding west (S9)
  const FLEE_SEARCH_RADIUS = 5;           // botBehaviorSettings.fleeSearchRadius in bot-viewer-v2
  const flood = floodFill(grid, source, { maxRadius: FLEE_SEARCH_RADIUS });
  const threatCell = cellIndexAt(grid, threatAt.x, threatAt.z);
  ok(!!flood && threatCell !== -1 && grid.cells[threatCell] === 1, 'flee repro floods from a walkable source toward a walkable threat cell');
  ok(field.canSee(cellIndexAt(grid, source.x, source.z), threatCell), 'the fleeing bot really is under fire at the start');
  const cands = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const key = r * grid.cols + c;
      if (flood.dist[key] === Infinity) continue;
      const goal = cellToWorld(grid, c, r);
      const threatDistance = Math.hypot(goal.x - threatAt.x, goal.z - threatAt.z);
      const covered = !field.canSee(threatCell, key);
      const exposure01 = fleePathExposureFromParents(field, grid, threatCell, flood.parent, flood.startKey, key, 1);
      const cheap = fleePathExposureFromParents(field, grid, threatCell, flood.parent, flood.startKey, key);
      const centroidDistance = Math.hypot(goal.x - squadAt.x, goal.z - squadAt.z);
      const shared = { threatDistance, pathDist: flood.dist[key], covered };
      cands.push({ key, c, r, covered, exposure01, cheap, centroidDistance,
        old: fleeCandidateScore(shared),
        fixed: fleeCandidateScore({ ...shared, exposure01 }),
        cheapFixed: fleeCandidateScore({ ...shared, exposure01: cheap }),
        squadAware: fleeCandidateScore({ ...shared, exposure01, centroidDistance }) });
    }
  }
  const argmax = (field_) => cands.reduce((a, b) => (b[field_] > a[field_] ? b : a));
  ok(cands.length > 10, `the flee flood produced a real candidate set (${cands.length})`);
  const oldBest = argmax('old');
  const fixedBest = argmax('fixed');
  // The bug: both picks are "covered" endpoints, but the old one is reached by a run down the lane.
  ok(oldBest.covered && fixedBest.covered, 'both scorings still demand a covered endpoint');
  ok(oldBest.exposure01 > 0.5,
    `endpoint-only scoring runs the bot through the open to its cover (${(oldBest.exposure01 * 100).toFixed(0)}% of the route in view)`);
  ok(fixedBest.key !== oldBest.key, 'route exposure actually changes which cell the bot flees to');
  ok(fixedBest.exposure01 <= oldBest.exposure01 - 0.3,
    `exposure-aware scoring picks a materially safer route (${(fixedBest.exposure01 * 100).toFixed(0)}% vs ${(oldBest.exposure01 * 100).toFixed(0)}% exposed)`);
  // No route scores 0 here: the bot is standing in the open, so its own cell is always a seen sample.
  const floor = Math.min(...cands.map(x => x.exposure01));
  ok(floor > 0 && fixedBest.exposure01 <= floor + 1e-9,
    `the winning route is as concealed as this map allows (${(floor * 100).toFixed(0)}% floor = the cell the bot starts on)`);
  // Strided sampling is a coarse estimate, so what must survive is the RANKING, not the value.
  ok(argmax('cheapFixed').key === fixedBest.key,
    `stride-${FLEE_EXPOSURE_STRIDE} sampling picks the same goal as the exhaustive walk`);
  // S9: the squad term provably cannot override real safety (it can only ever concede one pull).
  const squadBest = argmax('squadAware');
  const maxPull = FLEE_CENTROID_PULL * Math.max(...cands.map(x => x.centroidDistance));
  ok(fixedBest.fixed - squadBest.fixed <= maxPull + 1e-9,
    `the squad term costs at most one centroid-pull of safety (${(fixedBest.fixed - squadBest.fixed).toFixed(2)} <= ${maxPull.toFixed(2)})`);
  ok(maxPull < 2, `on a 20 m map the whole squad term is worth under 2 score units (${maxPull.toFixed(2)})`);
}

// ---- H6b secondary-threat veto: cover from A must not mean standing open to B ----
{
  const world = { corners: map.corners, field, navGrid: grid, searchRadius: 10 };
  const botAt = { x: 13.5, z: 2.5 };
  const primary = { x: 13.5, z: 7.5 };
  // Regression: omitted / null secondary reproduces the pre-H6b pick and validity verdicts exactly.
  const bestPlain = pickCoverCorner(world, botAt, primary);
  ok(!!bestPlain, 'the baseline pick still finds a corner');
  ok(pickCoverCorner(world, botAt, primary, null) === bestPlain, 'a null secondary threat picks the same corner');
  ok(pickCoverCorner(world, botAt, primary, undefined) === bestPlain, 'an omitted secondary threat picks the same corner');
  for (const rec of map.corners) {
    ok(!!coverCornerValid({ field, navGrid: grid }, rec, primary) ===
       !!coverCornerValid({ field, navGrid: grid }, rec, primary, null),
      'per-corner validity is unchanged when no secondary threat is supplied');
  }
  ok(coverCornerValid({ field, navGrid: grid }, bestPlain, primary), 'the picked corner is valid vs the primary alone');
  // A second shooter standing ON the anchor cell trivially sees it (canSee(a,a)) -> hard veto.
  const onAnchor = { x: bestPlain.anchorPos.x, z: bestPlain.anchorPos.z };
  ok(!coverCornerValid({ field, navGrid: grid }, bestPlain, primary, onAnchor), 'a second shooter watching the anchor invalidates it');
  // Pick-time the secondary is a PENALTY, not a veto: half-cover beats the open field.
  const bestPenalized = pickCoverCorner(world, botAt, primary, onAnchor);
  ok(!!bestPenalized, 'a second shooter never starves the pick (penalty, not veto)');
  if (bestPenalized !== bestPlain) {
    ok(!field.canSee(cellIndexAt(grid, onAnchor.x, onAnchor.z), bestPenalized.anchorCell),
      'a displaced pick moved to an anchor hidden from the secondary');
    ok(coverCornerValid({ field, navGrid: grid }, bestPenalized, primary, onAnchor), 'the displaced pick is valid against both threats');
  }
  // The veto only ever removes options: every survivor of the two-threat pick is a survivor of the one-threat pick.
  let vetoed = 0;
  for (const rec of map.corners) {
    const one = !!coverCornerValid({ field, navGrid: grid }, rec, primary);
    const two = !!coverCornerValid({ field, navGrid: grid }, rec, primary, primary); // same point: no NEW veto
    ok(one === two, 'a secondary equal to the primary changes nothing (it is already vetoed by the primary test)');
    if (one && !coverCornerValid({ field, navGrid: grid }, rec, primary, onAnchor)) vetoed++;
  }
  ok(vetoed > 0, 'the second-shooter position really removes at least one otherwise-valid corner');
  // Fail-open: an off-grid / unknown secondary position must not veto anything (matches the primary test).
  const offGrid = { x: -500, z: -500 };
  ok(!!coverCornerValid({ field, navGrid: grid }, bestPlain, primary, offGrid), 'an off-grid secondary threat vetoes nothing');
  ok(pickCoverCorner(world, botAt, primary, offGrid) === bestPlain, 'an off-grid secondary threat leaves the pick alone');
  // A field that answers `undefined` for the secondary must read as "not seen", never as a veto.
  const secondary = { x: 0.5, z: 0.5 };
  const secCell = cellIndexAt(grid, secondary.x, secondary.z);
  const mutedField = { canSee: (a, b) => (a === secCell ? undefined : field.canSee(a, b)) };
  ok(!!coverCornerValid({ field: mutedField, navGrid: grid }, bestPlain, primary, secondary),
    'an unanswerable secondary visibility query fails open, never closed');
  ok(pickCoverCorner({ ...world, field: mutedField }, botAt, primary, secondary) === bestPlain,
    'the pick also fails open on an unanswerable secondary query');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-cover: all assertions passed');
