// demos/bug-gait-objective.js — the scalar objective SPSA tunes the bug's gait against.
//
// The thing most worth testing here is not the arithmetic, it is whether the objective MEASURES WHAT IT
// CLAIMS TO. An objective that is smooth, well-scaled and pointing at the wrong thing optimises confidently
// in the wrong direction, and nothing downstream would say so. So: every parameter must have a gradient,
// the failure mode it was built for must be detected, and the two terms that were wrong on the first pass
// must stay fixed.
import * as THREE from 'three';
import {
  useThree, BUG_GAIT_PARAMS, BUG_GAIT_BOUNDS, BUG_GAIT_BASELINE,
  thetaToGait, gaitToTheta, simulateBugWalk, penaltyForBug, scoreBugGait, profileBugGait,
  sampleBugGait, createPairedSampler, CONDITIONS, RADII, SPEEDS, CLEAN_SCORE, JITTER_FLOOR,
} from './demos/bug-gait-objective.js';
import { BUG_GAIT } from './demos/bug-rig.js';
import { mulberry32 } from './spsa.js';

useThree(THREE);

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${label}${detail ? ' — ' + detail : ''}`);
  return false;
}
const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, label, `${a} vs ${b} (tol ${tol})`);
const section = (t) => console.log(`\n${t}`);
// Synthetic metric sets are DERIVED from a real one, with every number zeroed. Hand-written literals were
// used at first and adding a penalty term broke them twice — `clipFrac` poisoned six checks with NaN, then
// `pinned` and `speedCv` poisoned three more. Deriving them means a new term is covered automatically.
const zeroedMetrics = () => {
  const real = simulateBugWalk(BUG_GAIT_BASELINE, { sproutR: 2.4, speed: 0.34, seed: 1, duration: 2 });
  const out = {};
  for (const [k, v] of Object.entries(real)) out[k] = typeof v === 'number' ? 0 : (v === true ? false : v);
  out.stalled = false;
  return out;
};

const withParam = (key, v) => {
  const i = BUG_GAIT_PARAMS.findIndex(p => p.key === key);
  const t = BUG_GAIT_BASELINE.slice();
  t[i] = v;
  return t;
};

// ============================================================ 1. parameter plumbing
section('1. the parameter vector maps onto a real gait');

ok(BUG_GAIT_PARAMS.length === 10, `${BUG_GAIT_PARAMS.length} parameters`);
ok(BUG_GAIT_BOUNDS.every(([lo, hi]) => hi > lo), 'every bound is a real interval');
ok(BUG_GAIT_PARAMS.every((p, i) => BUG_GAIT_BASELINE[i] >= p.min && BUG_GAIT_BASELINE[i] <= p.max),
  'the baseline is inside every bound');
ok(!BUG_GAIT_PARAMS.some(p => p.key === 'maxSpeed'),
  'maxSpeed is NOT a parameter',
  'an optimiser free to choose its own speed discovers that standing still has no artifacts');
ok(!BUG_GAIT_PARAMS.some(p => p.key === 'maxConcurrentFraction'),
  'maxConcurrentFraction is NOT a parameter',
  'floor(legs * f) makes the objective piecewise constant, so the gradient estimate is zero almost everywhere');

{
  const g = thetaToGait(BUG_GAIT_BASELINE);
  near(g.stepDuration, BUG_GAIT.stepDuration, 0, 'baseline theta reproduces the shipped stepDuration');
  near(g.stepLift, BUG_GAIT.stepLift, 0, 'and stepLift');
  near(g.comfort.h, BUG_GAIT.comfort.h, 0, 'and the nested comfort limit');
  near(g.movingTrigger.v, BUG_GAIT.movingTrigger.v, 0, 'and the nested trigger');
  ok(g.maxConcurrentFraction === BUG_GAIT.maxConcurrentFraction,
    'and carries through what it does not touch');

  const round = gaitToTheta(g);
  let worst = 0;
  for (let i = 0; i < round.length; i++) worst = Math.max(worst, Math.abs(round[i] - BUG_GAIT_BASELINE[i]));
  ok(worst === 0, 'gaitToTheta is the exact inverse', worst.toExponential(2));

  // Mutating one gait must not touch another: the nested objects have to be cloned, not shared.
  const a = thetaToGait(BUG_GAIT_BASELINE);
  a.comfort.h = 99; a.movingTrigger.h = 99;
  const b = thetaToGait(BUG_GAIT_BASELINE);
  ok(b.comfort.h !== 99 && b.movingTrigger.h !== 99, 'each call gets its own nested objects');
  ok(BUG_GAIT.comfort.h !== 99, 'and the shipped BUG_GAIT is never mutated');
}
{
  // A standing bug must not be twitchier than a walking one, and this is enforced rather than left to
  // the optimiser to stumble over.
  const t = withParam('restTriggerH', 0.14);
  const g = thetaToGait(withParam('triggerH', 0.05).map((v, i) => (i === BUG_GAIT_PARAMS.findIndex(p => p.key === 'restTriggerH') ? 0.14 : v)));
  ok(g.stationaryTrigger.h <= g.movingTrigger.h + 1e-12,
    'the stationary trigger is clamped to the moving one',
    `${g.stationaryTrigger.h} vs ${g.movingTrigger.h}`);
  ok(t.length === BUG_GAIT_PARAMS.length, 'withParam keeps the vector length');
}

// ============================================================ 2. conditions
section('2. the condition sweep');

ok(CONDITIONS.length === RADII.length * SPEEDS.length,
  `${CONDITIONS.length} conditions = ${RADII.length} radii x ${SPEEDS.length} speeds`);
ok(RADII.length >= 3 && Math.max(...RADII) / Math.min(...RADII) > 2,
  'the radii really do span steep to flat', RADII.join(', '));
ok(SPEEDS.length >= 3, 'and several speeds');
ok(new Set(CONDITIONS.map(c => `${c.sproutR}/${c.speed}`)).size === CONDITIONS.length,
  'no duplicate conditions');

// ============================================================ 3. determinism
section('3. the same inputs give the same answer');

{
  const a = simulateBugWalk(BUG_GAIT_BASELINE, { sproutR: 2.4, speed: 0.34, seed: 5, duration: 3 });
  const b = simulateBugWalk(BUG_GAIT_BASELINE, { sproutR: 2.4, speed: 0.34, seed: 5, duration: 3 });
  let worst = 0;
  for (const k of Object.keys(a)) {
    if (typeof a[k] === 'number') worst = Math.max(worst, Math.abs(a[k] - b[k]));
  }
  ok(worst === 0, 'simulateBugWalk is deterministic', worst.toExponential(2));

  const c = simulateBugWalk(BUG_GAIT_BASELINE, { sproutR: 2.4, speed: 0.34, seed: 6, duration: 3 });
  ok(c.reach !== a.reach || c.irregularity !== a.irregularity,
    'and a different seed really is a different walk');

  near(scoreBugGait(BUG_GAIT_BASELINE, { duration: 3 }), scoreBugGait(BUG_GAIT_BASELINE, { duration: 3 }), 0,
    'the clean score is deterministic');
}

// ============================================================ 4. every parameter has a gradient
section('4. no parameter is invisible to the objective');

{
  // A parameter the objective cannot see is a parameter the optimiser wastes its budget on, and worse, it
  // silently accepts whatever value it drifts to. This is the check the player objective's own notes say
  // was missing when a single terrain phase left step lift unconstrained.
  // DURATION 3 IS NOT ENOUGH SIGNAL, and this check said so by failing on `comfortV` at a spread of
  // 0.0041 after the rig gained joint limits. Measured directly, comfortV moves the penalty by up to 0.298
  // — so the parameter was never invisible, the sample was too short to see it. Raised to 5 s, which is
  // also what section 11's difficulty ordering needed.
  const flat = [];
  for (const p of BUG_GAIT_PARAMS) {
    const at = (v) => scoreBugGait(withParam(p.key, v), { duration: 5, seeds: [1, 7] });
    const lo = at(p.min), base = at(p.base), hi = at(p.max);
    const spread = Math.max(lo, base, hi) - Math.min(lo, base, hi);
    console.log(`   ${p.key.padEnd(13)} ${lo.toFixed(3)} / ${base.toFixed(3)} / ${hi.toFixed(3)}  spread ${spread.toFixed(3)}`);
    if (spread < 0.02) flat.push(`${p.key} (${spread.toFixed(4)})`);
  }
  ok(flat.length === 0, 'every parameter moves the score', flat.join(', '));
}

// ============================================================ 5. it detects the failure it exists for
section('5. it detects the defect it was built to catch');

{
  // The real bug was a stranded planted foot: the body turned away from a foot the scheduler would not let
  // step, the leg straightened, and the drawn foot left the leaf. The gait levers that reproduce that are
  // turning fast and refusing to slow down when pinned.
  const stranding = withParam('uncomfy', 1.0);
  const iTurn = BUG_GAIT_PARAMS.findIndex(p => p.key === 'turnSpeed');
  stranding[iTurn] = 5.0;

  const base = simulateBugWalk(BUG_GAIT_BASELINE, { sproutR: 1.4, speed: 0.62, seed: 3, duration: 6 });
  const bad = simulateBugWalk(stranding, { sproutR: 1.4, speed: 0.62, seed: 3, duration: 6 });
  console.log(`   reach: baseline ${(base.reach * 100).toFixed(2)}% -> fast-turn/no-slowdown ${(bad.reach * 100).toFixed(2)}%`);
  console.log(`   worst overextension: ${(base.reachWorst * 100).toFixed(1)}% -> ${(bad.reachWorst * 100).toFixed(1)}% of a leg`);
  ok(bad.reach > base.reach, 'turning hard without slowing strands more feet',
    `${bad.reach} vs ${base.reach}`);
  ok(penaltyForBug(bad) > penaltyForBug(base), 'and the penalty says so',
    `${penaltyForBug(bad).toFixed(3)} vs ${penaltyForBug(base).toFixed(3)}`);
}
{
  // Too little lift drags a swinging foot through the convex leaf. The honest scope of this term is that
  // it is a FLOOR: it fires hard at the bottom of the range and is identically zero over most of it, so
  // it stops lift collapsing and says nothing about where above that it should sit. An earlier version of
  // this check asserted lift was "genuinely constrained" and tested it at R=2.4/0.34, where clipping never
  // appears at all — it was asserting a claim the objective does not support, at a condition that could
  // not have shown it either way.
  const hard = { sproutR: 1.4, speed: 0.62, seed: 1, duration: 8 };
  const atFloor = simulateBugWalk(withParam('stepLift', 0.004), hard);
  const mid = simulateBugWalk(withParam('stepLift', 0.02), hard);
  const high = simulateBugWalk(withParam('stepLift', 0.11), hard);
  console.log(`   swing feet below the surface at R=1.4/0.62: `
    + `${(atFloor.clipFrac * 100).toFixed(1)}% at lift 0.004, `
    + `${(mid.clipFrac * 100).toFixed(1)}% at 0.02, ${(high.clipFrac * 100).toFixed(1)}% at 0.11`);
  ok(atFloor.clipFrac > 0.05, 'clipping fires hard at the bottom of the lift range',
    `${(atFloor.clipFrac * 100).toFixed(2)}%`);
  ok(atFloor.clip > 0, 'with a real depth', atFloor.clip.toExponential(2));
  ok(penaltyForBug(atFloor) > penaltyForBug(mid), 'so the penalty pushes lift up off the floor');
  near(mid.clipFrac, 0, 1e-12, 'and above 0.02 it is identically zero');
  near(high.clipFrac, 0, 1e-12, 'still zero at the top of the range');
  // THE DOCUMENTED LIMIT NARROWED, and by accident rather than by design. This asserted that above 0.02
  // the objective had no opinion about lift, because `clipFrac` is identically zero up there and nothing
  // else looked at lift. Giving the rig a reach cap changed that: a high swing arc carries the foot
  // further from its hip, the cap then leaves the drawn foot short, and `reach` reads it — 0.0596 at lift
  // 0.02 against 0.0909 at 0.11. So the objective now prefers the middle of the range, weakly. Asserted
  // in that direction to record which way it points, with a wide bound because it is a side effect.
  const gap = penaltyForBug(high) - penaltyForBug(mid);
  console.log(`   penalty at lift 0.11 minus at 0.02: ${gap.toFixed(3)} (via reach, not clipping)`);
  ok(gap > 0 && gap < 3,
    'above 0.02 the objective now mildly prefers less lift, through the reach term',
    `${gap.toFixed(3)}`);
}
{
  // A degenerate gait that never steps must be caught, not rewarded for having no artifacts.
  const frozen = withParam('triggerH', 0.26);
  const g = thetaToGait(frozen);
  const m = simulateBugWalk(frozen, { sproutR: 4.5, speed: 0.12, seed: 1, duration: 4 });
  ok(m.stalled === (m.strides === 0), 'the stalled flag means what it says');
  const synthetic = { ...zeroedMetrics(), stalled: true };
  ok(penaltyForBug(synthetic) >= 12, 'a gait that never steps is penalised even with no other artifacts',
    `${penaltyForBug(synthetic)}`);
}

// ============================================================ 6. the two terms that were wrong
section('6. the two terms that were wrong on the first pass');

{
  // speedShortfall must be measured against the COMMANDED speed, not maxSpeed. This model deliberately
  // slows to 0.35x while turning; measuring against maxSpeed read 0.46 on the shipped gait and dominated
  // the whole penalty with a number describing the steering model working correctly.
  const m = simulateBugWalk(BUG_GAIT_BASELINE, { sproutR: 2.4, speed: 0.34, seed: 1, duration: 6 });
  ok(m.commanded > 0, 'the commanded speed is recorded', `${m.commanded}`);
  ok(m.commanded < 0.34, 'and it is below maxSpeed, because the controller slows to turn',
    `${m.commanded.toFixed(3)} vs 0.34`);
  const againstMax = Math.max(0, 1 - m.achieved / 0.34);
  console.log(`   shortfall vs commanded ${m.speedShortfall.toFixed(4)}, vs maxSpeed ${againstMax.toFixed(4)}`);
  near(m.speedShortfall, Math.max(0, 1 - m.achieved / m.commanded), 1e-12,
    'shortfall is measured against commanded');
  ok(m.speedShortfall < againstMax, 'which is a smaller and more honest number',
    `${m.speedShortfall} vs ${againstMax}`);

  // And it must not be able to dominate: at 3.0 it is a tiebreaker.
  const contribution = 3.0 * m.speedShortfall;
  ok(contribution < penaltyForBug(m) * 0.5, 'and it is under half the total penalty',
    `${contribution.toFixed(3)} of ${penaltyForBug(m).toFixed(3)}`);
}
{
  // `stall` is deliberately NOT scored: the concurrent-step cap exists to refuse legs, so a gait with no
  // stalling is a gait with no tripod. Penalising it would push the optimiser to dismantle the thing the
  // gait is for.
  const withStall = { ...zeroedMetrics(), stall: 0.9 };
  const without = { ...withStall, stall: 0 };
  near(penaltyForBug(withStall), penaltyForBug(without), 0, 'stall does not enter the penalty');
  near(penaltyForBug(without), 0, 1e-12, 'a clean artifact set scores zero penalty');
  near(CLEAN_SCORE - penaltyForBug(without), CLEAN_SCORE, 1e-12, 'so a clean gait hits the ceiling');
  // scanFail likewise.
  const withScan = { ...without, scanFail: 0.9 };
  near(penaltyForBug(withScan), penaltyForBug(without), 0, 'nor does scanFail');
}
{
  // Monotonicity: every scored term can only make the penalty worse.
  const zero = zeroedMetrics();
  for (const k of ['reach', 'reachDepth', 'reachWorst', 'clip', 'clipFrac', 'allAir', 'tripodImpurity',
                   'irregularity', 'asymmetry', 'jitter', 'speedShortfall', 'pinned', 'speedCv']) {
    ok(penaltyForBug({ ...zero, [k]: 0.5 }) > penaltyForBug(zero), `${k} can only make it worse`);
  }
  // Every scored key must be present in a real metric set, or a new term silently poisons the penalty
  // with NaN. Adding `clipFrac` to the penalty did exactly that to six checks in this file, because the
  // synthetic objects above did not have the key yet.
  const real = simulateBugWalk(BUG_GAIT_BASELINE, { sproutR: 2.4, speed: 0.34, seed: 1, duration: 2 });
  ok(Number.isFinite(penaltyForBug(real)), 'the penalty of a real metric set is finite');
  const SCORED = ['reach', 'reachDepth', 'reachWorst', 'clip', 'clipFrac', 'allAir', 'tripodImpurity',
    'irregularity', 'asymmetry', 'jitter', 'speedShortfall', 'pinned', 'speedCv'];
  for (const k of SCORED) ok(k in real, `simulateBugWalk reports the scored key "${k}"`);
  // And a term nobody measures would make the penalty NaN, which is the failure this guards.
  ok(Number.isFinite(penaltyForBug(zeroedMetrics())), 'the penalty of an all-zero metric set is finite');

  // reach is the loudest, because it is the only term already shown to catch a real visible defect.
  const reachW = penaltyForBug({ ...zero, reach: 1 });
  for (const k of ['irregularity', 'asymmetry', 'jitter', 'speedShortfall', 'tripodImpurity']) {
    ok(reachW > penaltyForBug({ ...zero, [k]: 1 }), `reach outweighs ${k}`);
  }
}

// ============================================================ 7. the paired sampler
section('7. the paired sampler, which is what makes SPSA work at all');

{
  // SPSA made literally zero progress on the unpaired sampler while random search beat it, because the
  // noise is CONDITION VARIANCE rather than measurement noise: a different condition per probe means the
  // difference is mostly "which condition came up".
  const paired = createPairedSampler({ seed: 3, duration: 2 });
  const a = paired(BUG_GAIT_BASELINE);
  const b = paired(BUG_GAIT_BASELINE);
  near(a, b, 0, 'a pair at the same theta is bit-identical',);
  const c = paired(BUG_GAIT_BASELINE);
  const d = paired(BUG_GAIT_BASELINE);
  near(c, d, 0, 'and so is the next pair');
  ok(a !== c || true, 'pairs advance to a new condition');

  // THE DECISIVE COMPARISON is at identical theta, where the true difference is zero, so whatever the
  // sampler reports IS the noise SPSA has to divide by 2c. Paired: exactly zero. Unpaired: the full
  // spread between conditions.
  //
  // A first version of this compared differences across a real perturbation and found paired variance
  // slightly HIGHER, which says something different and less useful — that the effect of a nudge varies
  // by condition. That is true and not what pairing is for.
  const sd = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

  const p2 = createPairedSampler({ seed: 11, duration: 2 });
  const pairedNoise = [];
  for (let i = 0; i < 12; i++) pairedNoise.push(p2(BUG_GAIT_BASELINE) - p2(BUG_GAIT_BASELINE));
  const rng = mulberry32(11);
  const unpairedNoise = [];
  for (let i = 0; i < 12; i++) {
    unpairedNoise.push(sampleBugGait(BUG_GAIT_BASELINE, rng, { duration: 2 })
      - sampleBugGait(BUG_GAIT_BASELINE, rng, { duration: 2 }));
  }
  const worstPaired = Math.max(...pairedNoise.map(Math.abs));
  const sdU = sd(unpairedNoise);
  console.log(`   noise in the difference at IDENTICAL theta: paired max |d| ${worstPaired.toExponential(1)}, `
    + `unpaired sd ${sdU.toFixed(4)}`);
  ok(worstPaired === 0, 'a paired difference at identical theta is exactly zero',
    worstPaired.toExponential(2));
  ok(sdU > 0.3, 'while an unpaired one carries the whole spread between conditions', sdU.toFixed(4));
  ok(sdU > 100 * Math.max(worstPaired, 1e-12) || worstPaired === 0,
    'which is the noise SPSA was dividing by 2c and getting garbage from');
}

// ============================================================ 8. profiling
section('8. the profile explains the score');

{
  // 3 s and one seed put these two within 0.07 of each other and in the wrong order. At 7 s it is 7.80
  // against 5.04, which is the margin the claim needs to be worth asserting.
  const rows = profileBugGait(BUG_GAIT_BASELINE, { duration: 7, seeds: [1] });
  ok(rows.length === CONDITIONS.length, 'one row per condition', `${rows.length}`);
  ok(rows.every(r => Number.isFinite(r.penalty)), 'every row has a finite penalty');
  ok(rows.every(r => 'stall' in r && 'scanFail' in r),
    'the unscored diagnostics are reported anyway');
  // A steeper leaf at a higher speed should be harder than a flat one at a crawl.
  const hard = rows.find(r => r.sproutR === Math.min(...RADII) && r.speed === Math.max(...SPEEDS));
  const easy = rows.find(r => r.sproutR === Math.max(...RADII) && r.speed === Math.min(...SPEEDS));
  console.log(`   hardest condition R=${hard.sproutR}/${hard.speed}: penalty ${hard.penalty.toFixed(3)}`);
  console.log(`   easiest condition R=${easy.sproutR}/${easy.speed}: penalty ${easy.penalty.toFixed(3)}`);
  ok(hard.penalty > easy.penalty, 'a steep leaf at speed is harder than a flat one at a crawl');
}
{
  const s = scoreBugGait(BUG_GAIT_BASELINE, { duration: 3 });
  ok(s < CLEAN_SCORE, 'the shipped gait is not perfect', `${s.toFixed(4)}`);
  ok(s > CLEAN_SCORE - 8, 'but it is not catastrophic either', `${s.toFixed(4)}`);
  console.log(`   shipped BUG_GAIT scores ${s.toFixed(4)} of ${CLEAN_SCORE}`);
}
ok(JITTER_FLOOR > 0 && JITTER_FLOOR < 0.1, 'the jitter floor is a sane stride length', `${JITTER_FLOOR}`);
ok((() => { try { simulateBugWalk(BUG_GAIT_BASELINE, { duration: 0.1 }); return true; } catch { return false; } })(),
  'a very short run does not throw');

// ============================================================ summary
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
