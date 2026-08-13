// Node tests for the team-scoped danger field (H3): accumulation/cap, exact half-life decay,
// cross-team isolation, entry-cap eviction, self-prune, spread lists, and read-path sanity.
// Run: node test-bot-danger.mjs
import {
  createDangerField, recordDanger, dangerAt, dangerPenalty, dangerBlocksCover,
  hasDanger, dangerEntryCount, pruneDangerField, clearDangerField, cellNeighbors8,
  DANGER_DEATH_WEIGHT, DANGER_HIT_WEIGHT, DANGER_MAX_WEIGHT, DANGER_HALF_LIFE_MS,
  DANGER_EPSILON, DANGER_SPREAD_FRACTION, DANGER_MAX_ENTRIES, DANGER_COVER_SKIP_WEIGHT,
} from './bot-danger.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

// ---- empty field reads as harmless ----
{
  const f = createDangerField();
  ok(dangerAt(f, 'alpha', 12, 0) === 0, 'unknown team reads 0');
  ok(dangerAt(f, 'alpha', -1, 0) === 0, 'off-grid cell (-1) reads 0');
  ok(dangerPenalty(f, 'alpha', 12, 0, 99) === 0, 'penalty on an empty field is 0');
  ok(!hasDanger(f, 'alpha'), 'hasDanger is false before any record');
  ok(!dangerBlocksCover(f, 'alpha', 12, 0), 'nothing blocks cover on an empty field');
  recordDanger(f, 'alpha', 12, 0, 1000);          // zero weight is a no-op
  recordDanger(f, 'alpha', -3, 1, 1000);          // off-grid cell is a no-op
  recordDanger(null, 'alpha', 12, 1, 1000);       // null field is a no-op
  ok(dangerEntryCount(f, 'alpha') === 0, 'no-op writes create no records');
}

// ---- accumulation + cap ----
{
  const f = createDangerField();
  recordDanger(f, 'alpha', 5, DANGER_DEATH_WEIGHT, 0);
  ok(near(dangerAt(f, 'alpha', 5, 0), DANGER_DEATH_WEIGHT), 'a death records its full weight');
  ok(hasDanger(f, 'alpha'), 'hasDanger flips true after a record');
  recordDanger(f, 'alpha', 5, DANGER_HIT_WEIGHT, 0);
  ok(near(dangerAt(f, 'alpha', 5, 0), DANGER_DEATH_WEIGHT + DANGER_HIT_WEIGHT),
    'same-cell records accumulate');
  for (let i = 0; i < 10; i++) recordDanger(f, 'alpha', 5, DANGER_DEATH_WEIGHT, 0);
  ok(near(dangerAt(f, 'alpha', 5, 0), DANGER_MAX_WEIGHT), 'accumulation saturates at DANGER_MAX_WEIGHT');
  ok(dangerEntryCount(f, 'alpha') === 1, 'repeated same-cell writes stay one record');
  // A single oversized write is clamped too.
  recordDanger(f, 'bravo', 7, 99, 0);
  ok(near(dangerAt(f, 'bravo', 7, 0), DANGER_MAX_WEIGHT), 'one oversized write is clamped to the cap');
}

// ---- exponential decay: exact at 1 and 2 half-lives ----
{
  const f = createDangerField();
  recordDanger(f, 'alpha', 9, 1, 0);
  ok(near(dangerAt(f, 'alpha', 9, 0), 1), 'fresh record reads its full weight');
  ok(near(dangerAt(f, 'alpha', 9, DANGER_HALF_LIFE_MS), 0.5), 'one half-life reads exactly half');
  ok(near(dangerAt(f, 'alpha', 9, 2 * DANGER_HALF_LIFE_MS), 0.25), 'two half-lives read exactly a quarter');
  ok(near(dangerAt(f, 'alpha', 9, DANGER_HALF_LIFE_MS / 2), Math.SQRT1_2),
    'half a half-life reads 1/sqrt(2)');
  ok(near(dangerAt(f, 'alpha', 9, -5000), 1), 'a backwards clock reads the record as fresh, never amplified');
  // Accumulating onto a decayed record folds the DECAYED value, not the stale stamp.
  recordDanger(f, 'alpha', 9, 0.5, DANGER_HALF_LIFE_MS);
  ok(near(dangerAt(f, 'alpha', 9, DANGER_HALF_LIFE_MS), 1), 'accumulate folds the decayed value at the new stamp');
  ok(near(dangerAt(f, 'alpha', 9, 2 * DANGER_HALF_LIFE_MS), 0.5), 'the re-stamped record decays from the new time');
}

// ---- self-prune below epsilon ----
{
  const f = createDangerField();
  recordDanger(f, 'alpha', 3, DANGER_DEATH_WEIGHT, 0);
  // Time needed for 1.0 to fall under epsilon, plus a margin.
  const gone = DANGER_HALF_LIFE_MS * (Math.log2(1 / DANGER_EPSILON) + 1);
  ok(dangerEntryCount(f, 'alpha') === 1, 'record present before it decays out');
  ok(dangerAt(f, 'alpha', 3, gone) === 0, 'a record under epsilon reads exactly 0');
  ok(dangerEntryCount(f, 'alpha') === 0, 'the read self-pruned the dead record');
  ok(!hasDanger(f, 'alpha'), 'hasDanger goes false once the last record is pruned');
  // Writes prune stale records for other cells too.
  recordDanger(f, 'alpha', 4, DANGER_DEATH_WEIGHT, 0);
  recordDanger(f, 'alpha', 5, DANGER_DEATH_WEIGHT, gone);
  ok(dangerEntryCount(f, 'alpha') === 1 && dangerAt(f, 'alpha', 4, gone) === 0,
    'a later write prunes records that decayed out meanwhile');
  // pruneDangerField sweeps whole teams away.
  recordDanger(f, 'bravo', 1, DANGER_DEATH_WEIGHT, 0);
  pruneDangerField(f, gone * 2);
  ok(dangerEntryCount(f, 'alpha') === 0 && dangerEntryCount(f, 'bravo') === 0, 'pruneDangerField clears decayed teams');
}

// ---- cross-team isolation ----
{
  const f = createDangerField();
  recordDanger(f, 'alpha', 42, DANGER_DEATH_WEIGHT, 0);
  ok(near(dangerAt(f, 'alpha', 42, 0), DANGER_DEATH_WEIGHT), 'alpha sees its own casualty cell');
  ok(dangerAt(f, 'bravo', 42, 0) === 0, "bravo does not inherit alpha's danger");
  recordDanger(f, 'bravo', 42, DANGER_HIT_WEIGHT, 0);
  ok(near(dangerAt(f, 'alpha', 42, 0), DANGER_DEATH_WEIGHT), "bravo's write does not touch alpha's weight");
  ok(near(dangerAt(f, 'bravo', 42, 0), DANGER_HIT_WEIGHT), 'bravo keeps its own independent weight');
  clearDangerField(f);
  ok(!hasDanger(f, 'alpha') && !hasDanger(f, 'bravo'), 'clearDangerField wipes every team');
}

// ---- entry-cap eviction: least-recently-written goes first ----
{
  const f = createDangerField();
  for (let i = 0; i < DANGER_MAX_ENTRIES; i++) recordDanger(f, 'alpha', i, DANGER_DEATH_WEIGHT, i);
  ok(dangerEntryCount(f, 'alpha') === DANGER_MAX_ENTRIES, 'field fills exactly to the cap');
  const now = DANGER_MAX_ENTRIES;
  ok(dangerAt(f, 'alpha', 0, now) > 0, 'cell 0 is alive just before overflow');
  recordDanger(f, 'alpha', 1000, DANGER_DEATH_WEIGHT, now);
  ok(dangerEntryCount(f, 'alpha') === DANGER_MAX_ENTRIES, 'the cap holds after overflow');
  ok(dangerAt(f, 'alpha', 0, now) === 0, 'the oldest cell was evicted');
  ok(dangerAt(f, 'alpha', 1, now) > 0, 'the second-oldest cell survived');
  ok(dangerAt(f, 'alpha', 1000, now) > 0, 'the new cell is present');
  // Touching an old cell makes it recent again, so it outlives a younger untouched one.
  recordDanger(f, 'alpha', 1, DANGER_HIT_WEIGHT, now);
  recordDanger(f, 'alpha', 1001, DANGER_DEATH_WEIGHT, now);
  ok(dangerAt(f, 'alpha', 1, now) > 0, 'a re-recorded cell is treated as recently written');
  ok(dangerAt(f, 'alpha', 2, now) === 0, 'the next-oldest untouched cell was evicted instead');
  // A spread burst cannot blow past the cap either.
  const burst = [];
  for (let i = 2000; i < 2100; i++) burst.push(i);
  recordDanger(f, 'alpha', 3000, DANGER_DEATH_WEIGHT, now, burst);
  ok(dangerEntryCount(f, 'alpha') === DANGER_MAX_ENTRIES, 'a 100-cell spread burst still respects the cap');
}

// ---- spread list ----
{
  const f = createDangerField();
  const spread = [11, 12, 13, 5];
  recordDanger(f, 'alpha', 12, DANGER_DEATH_WEIGHT, 0, spread);
  ok(near(dangerAt(f, 'alpha', 12, 0), DANGER_DEATH_WEIGHT),
    'the epicentre keeps its full weight (it is skipped inside its own spread list)');
  ok(near(dangerAt(f, 'alpha', 11, 0), DANGER_DEATH_WEIGHT * DANGER_SPREAD_FRACTION),
    'a neighbour takes the spread fraction');
  ok(near(dangerAt(f, 'alpha', 5, 0), DANGER_DEATH_WEIGHT * DANGER_SPREAD_FRACTION),
    'every listed neighbour is painted');
  ok(dangerEntryCount(f, 'alpha') === 4, 'spread creates one record per distinct cell');
  // spreadCount lets a reused scratch buffer be passed without slicing.
  const scratch = new Int32Array(8);
  scratch[0] = 70; scratch[1] = 71; scratch[2] = 999; // 999 is stale tail, excluded by count
  recordDanger(f, 'bravo', 60, 1, 0, scratch, 2);
  ok(near(dangerAt(f, 'bravo', 71, 0), DANGER_SPREAD_FRACTION), 'spreadCount honours the live prefix');
  ok(dangerAt(f, 'bravo', 999, 0) === 0, 'stale scratch tail beyond spreadCount is ignored');
}

// ---- cellNeighbors8 (grid-shape helper for the spread list) ----
{
  const out = new Int32Array(8);
  // 5x4 grid; interior cell (c=2, r=1) = index 7.
  let n = cellNeighbors8(7, 5, 4, out);
  ok(n === 8, 'an interior cell has 8 neighbours');
  const got = Array.from(out.subarray(0, n)).sort((a, b) => a - b);
  ok(got.join(',') === '1,2,3,6,8,11,12,13', `interior neighbours are the surrounding ring (got ${got.join(',')})`);
  n = cellNeighbors8(0, 5, 4, out);
  ok(n === 3 && Array.from(out.subarray(0, n)).sort((a, b) => a - b).join(',') === '1,5,6',
    'a corner cell clamps to 3 neighbours');
  n = cellNeighbors8(19, 5, 4, out);
  ok(n === 3 && Array.from(out.subarray(0, n)).sort((a, b) => a - b).join(',') === '13,14,18',
    'the far corner clamps to 3 neighbours');
  ok(cellNeighbors8(-1, 5, 4, out) === 0, 'an off-grid index yields no neighbours');
  ok(cellNeighbors8(100, 5, 4, out) === 0, 'an out-of-range index yields no neighbours');
  // End-to-end: death at an interior cell paints a 3x3 blob.
  const f = createDangerField();
  n = cellNeighbors8(7, 5, 4, out);
  recordDanger(f, 'alpha', 7, DANGER_DEATH_WEIGHT, 0, out, n);
  ok(dangerEntryCount(f, 'alpha') === 9, 'a death paints the cell plus its 8 neighbours');
  ok(dangerAt(f, 'alpha', 7, 0) > dangerAt(f, 'alpha', 6, 0), 'the epicentre outweighs its neighbours');
}

// ---- penalty / cover-veto helpers ----
{
  const f = createDangerField();
  recordDanger(f, 'alpha', 20, DANGER_DEATH_WEIGHT, 0);
  ok(near(dangerPenalty(f, 'alpha', 20, 0, 6), DANGER_DEATH_WEIGHT * 6), 'penalty scales the decayed weight');
  ok(dangerPenalty(f, 'bravo', 20, 0, 6) === 0, 'penalty is team-scoped');
  ok(dangerBlocksCover(f, 'alpha', 20, 0), 'a fresh death weight vetoes a cover corner');
  ok(!dangerBlocksCover(f, 'alpha', 20, 2 * DANGER_HALF_LIFE_MS),
    'a corner becomes usable again once the memory decays below the veto threshold');
  recordDanger(f, 'alpha', 21, DANGER_HIT_WEIGHT, 0);
  ok(!dangerBlocksCover(f, 'alpha', 21, 0), 'a single non-lethal hit does not veto a corner');
  ok(DANGER_HIT_WEIGHT < DANGER_COVER_SKIP_WEIGHT, 'the hit weight sits below the cover veto by construction');
}

// ---- read path: monotone, finite, and stable under repetition ----
{
  const f = createDangerField();
  recordDanger(f, 'alpha', 33, DANGER_DEATH_WEIGHT, 0);
  let prev = Infinity, sawZero = false;
  for (let t = 0; t <= 200000; t += 500) {
    const a = dangerAt(f, 'alpha', 33, t);
    const b = dangerAt(f, 'alpha', 33, t); // repeated read at the same instant must be identical
    if (!Number.isFinite(a) || Number.isNaN(a)) { ok(false, `dangerAt returned a non-finite value at t=${t}`); break; }
    if (a !== b) { ok(false, `repeated dangerAt disagreed at t=${t} (${a} vs ${b})`); break; }
    if (a > prev + 1e-12) { ok(false, `dangerAt rose over time at t=${t} (${a} > ${prev})`); break; }
    if (a < 0 || a > DANGER_MAX_WEIGHT) { ok(false, `dangerAt left [0, max] at t=${t} (${a})`); break; }
    if (a === 0) sawZero = true;
    prev = a;
  }
  ok(sawZero, 'the danger memory eventually reads 0 and stops penalizing');
  // Reads on a missing cell/team must not create records (no lazy map growth in a scoring loop).
  const before = dangerEntryCount(f, 'alpha');
  for (let i = 0; i < 100; i++) dangerAt(f, 'alpha', 5000 + i, 0);
  for (let i = 0; i < 100; i++) dangerAt(f, 'charlie', i, 0);
  ok(dangerEntryCount(f, 'alpha') === before && dangerEntryCount(f, 'charlie') === 0,
    'misses on the read path allocate nothing and create no records');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-danger: all assertions passed');
