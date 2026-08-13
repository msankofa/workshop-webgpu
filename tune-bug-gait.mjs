// Tune demos/bug-rig.js's gait with ../spsa.js against demos/bug-gait-objective.js.
//
// A CLI rather than a page, because the run takes tens of seconds of pure arithmetic and there is nothing
// to look at while it happens. What you do with the result is paste it into `BUG_GAIT` and then look at
// the bug, which is the part no objective can do for you.
//
//   node tune-bug-gait.mjs [budget] [seed] [--freeze=a,b,c]
//
// `--freeze` holds named parameters at their shipped values and optimises only the rest. That is the mode
// whose output is safe to paste: `stepDuration` and `stepLift` are AESTHETIC choices - the objective will
// happily slow the gait right down to buy itself more time to place each foot, which scores far better and
// stops the bug reading as an insect. Freezing them asks the narrower question this harness can actually
// answer: given the look I want, what are the best foot-placement numbers to go with it?
//
// Random search runs on the same budget as a control. That comparison is the only thing that justifies
// using SPSA at all: if random search matches it, the gradient estimate is not buying anything.
//
// The winner is then validated on HELD-OUT seeds and AT MATCHED PACE, because neither check is optional:
//
//   - Held-out, because a candidate selected on REFERENCE_SEEDS can be fitted to them.
//   - At matched pace, because the first gait this harness produced scored +1.19 and was WORSE. Almost
//     every improvement the objective offers is available by walking more slowly: fewer artifacts per
//     second is not a better gait. Re-running the winner with maxSpeed raised until it travels as fast as
//     the baseline is what exposes that - the first candidate went from 5.00% of planted feet out of reach
//     to 14.46% once it had to keep up, against the baseline's 4.50%.
import * as THREE from 'three';
import { createSpsa, createRandomSearch, calibrateSpsa, mulberry32 } from './spsa.js';
import {
  useThree, BUG_GAIT_PARAMS, BUG_GAIT_BOUNDS, BUG_GAIT_BASELINE,
  sampleBugGait, createPairedSampler, scoreBugGait, profileBugGait, thetaToGait, simulateBugWalk,
  CONDITIONS, REFERENCE_SEEDS,
} from './demos/bug-gait-objective.js';

useThree(THREE);

const BUDGET = Number(process.argv[2] || 600);
const SEED = Number(process.argv[3] || 1);
const SAMPLE_DURATION = 5;
const freezeArg = process.argv.find(a => a.startsWith('--freeze='));
const FROZEN = new Set(freezeArg ? freezeArg.slice('--freeze='.length).split(',').filter(Boolean) : []);
for (const k of FROZEN) {
  if (!BUG_GAIT_PARAMS.some(p => p.key === k)) throw new Error(`--freeze names an unknown parameter: ${k}`);
}

// Frozen parameters are removed from the vector entirely rather than given a zero-width bound, which
// would divide by zero in the optimiser's normalisation.
const ACTIVE = BUG_GAIT_PARAMS.map((p, i) => i).filter(i => !FROZEN.has(BUG_GAIT_PARAMS[i].key));
const expand = (sub) => {
  const full = BUG_GAIT_BASELINE.slice();
  ACTIVE.forEach((idx, j) => { full[idx] = sub[j]; });
  return full;
};
const SUB_BASELINE = ACTIVE.map(i => BUG_GAIT_BASELINE[i]);
const SUB_BOUNDS = ACTIVE.map(i => BUG_GAIT_BOUNDS[i]);

const t0 = Date.now();
const baseScore = scoreBugGait(BUG_GAIT_BASELINE);
console.log(`baseline (the eyeballed BUG_GAIT): ${baseScore.toFixed(4)}   ceiling 4.0`);
console.log(`${ACTIVE.length} of ${BUG_GAIT_PARAMS.length} parameters active`
  + (FROZEN.size ? `, frozen: ${[...FROZEN].join(', ')}` : '')
  + `; ${CONDITIONS.length} conditions x ${REFERENCE_SEEDS.length} seeds in the clean score`);
console.log(`budget ${BUDGET} noisy evaluations of ${SAMPLE_DURATION}s each\n`);

// Calibrating a PAIRED objective needs care, and `calibrateSpsa` cannot do it unaided. Its heuristic is
// `c = the noise sd measured by repeated evaluation at one point`, which assumes noise independent per
// call. Pairing deliberately breaks that: repeated calls here span different conditions, so it measures
// condition variance (about 0.75) and would set c to three quarters of every parameter's range again.
//
// So `c` is CHOSEN — 4% of each parameter's range, small enough to be local and comfortably above the
// zero noise a paired difference has at fixed theta — and only `a` is derived, using calibrateSpsa's own
// formula against a gradient magnitude measured at that c.
const C = 0.04;
const TARGET_STEP = 0.05, ALPHA = 0.602;
const calSampler = createPairedSampler({ seed: SEED + 5, duration: SAMPLE_DURATION });
const probeObj = (sub) => -calSampler(expand(sub));
const unit = (t) => t.map((v, i) => (v - SUB_BOUNDS[i][0]) / (SUB_BOUNDS[i][1] - SUB_BOUNDS[i][0]));
const fromUnit = (u) => u.map((v, i) => SUB_BOUNDS[i][0] + v * (SUB_BOUNDS[i][1] - SUB_BOUNDS[i][0]));
const u0 = unit(SUB_BASELINE);
const probeRng = mulberry32(SEED + 3);
let magnitude = 0;
const PROBES = 8;
for (let p = 0; p < PROBES; p++) {
  const d = u0.map(() => (probeRng() < 0.5 ? -1 : 1));
  const plus = fromUnit(u0.map((v, i) => Math.min(1, Math.max(0, v + C * d[i]))));
  const minus = fromUnit(u0.map((v, i) => Math.min(1, Math.max(0, v - C * d[i]))));
  magnitude += Math.abs((probeObj(plus) - probeObj(minus)) / (2 * C));
}
magnitude = Math.max(magnitude / PROBES, 1e-9);
const stability = Math.max(1, Math.round(0.1 * (BUDGET / 2)));
const cal = { a: (TARGET_STEP * Math.pow(stability + 1, ALPHA)) / magnitude, c: C,
              noiseSd: 0, gradientMagnitude: magnitude, evals: PROBES * 2 };
console.log(`calibrated: a=${cal.a.toExponential(2)} c=${cal.c.toFixed(4)} `
  + `noise sd=${cal.noiseSd.toFixed(4)} |grad|=${cal.gradientMagnitude.toFixed(3)} (${cal.evals} evals spent)`);

function run(make, label) {
  const opt = make();
  let bestClean = baseScore, bestTheta = BUG_GAIT_BASELINE.slice();
  let sinceCheck = 0;
  while (opt.evals < BUDGET) {
    opt.step();
    sinceCheck++;
    // The optimiser's own `best` is a noisy single draw, so it cannot be trusted to rank candidates.
    // Re-score its current iterate cleanly now and then, and keep the winner by THAT.
    //
    // The check is IDENTICAL to the final score - same conditions, same seeds, same duration. Two
    // cheaper versions of it were tried and both leaked: two seeds instead of three, then five seconds
    // instead of seven. Each let a candidate win the check and then score BELOW the baseline on the full
    // reference, so the tuner reported a result worse than doing nothing. If the selection criterion is
    // not the reported criterion, the reported number is not what was selected for.
    if (sinceCheck >= 40) {
      sinceCheck = 0;
      const full = expand(opt.theta);
      const clean = scoreBugGait(full);
      if (clean > bestClean) { bestClean = clean; bestTheta = full; }
    }
  }
  const finalClean = scoreBugGait(bestTheta);
  console.log(`${label.padEnd(14)} ${opt.evals} evals -> clean ${finalClean.toFixed(4)}`);
  return { theta: bestTheta, score: finalClean };
}

const spsa = run(() => createSpsa({
  theta0: SUB_BASELINE,
  objective: (() => { const paired = createPairedSampler({ seed: SEED + 991, duration: SAMPLE_DURATION }); return sub => -paired(expand(sub)); })(),
  bounds: SUB_BOUNDS, a: cal.a, c: cal.c, maxIter: BUDGET / 2, seed: SEED,
}), 'SPSA');

const rand = run(() => createRandomSearch({
  theta0: SUB_BASELINE,
  objective: (() => { const rng = mulberry32(SEED + 77); return sub => -sampleBugGait(expand(sub), rng, { duration: SAMPLE_DURATION }); })(),
  bounds: SUB_BOUNDS, seed: SEED + 11,
}), 'random search');

const winner = spsa.score >= rand.score ? spsa : rand;
const winnerName = spsa.score >= rand.score ? 'SPSA' : 'random search';

console.log(`\nbaseline ${baseScore.toFixed(4)}  ->  ${winner.score.toFixed(4)} (${winnerName})`
  + `   improvement ${(winner.score - baseScore).toFixed(4)}`);

console.log('\nparameters:');
console.log(`  ${'name'.padEnd(14)} ${'baseline'.padStart(9)} ${'tuned'.padStart(9)}   range`);
BUG_GAIT_PARAMS.forEach((p, i) => {
  const b = BUG_GAIT_BASELINE[i], t = winner.theta[i];
  const atBound = FROZEN.has(p.key) ? '  (frozen)'
    : Math.abs(t - p.min) < (p.max - p.min) * 0.02 ? ' <-- at min'
    : Math.abs(t - p.max) < (p.max - p.min) * 0.02 ? ' <-- at MAX' : '';
  console.log(`  ${p.key.padEnd(14)} ${b.toFixed(4).padStart(9)} ${t.toFixed(4).padStart(9)}   [${p.min}, ${p.max}]${atBound}`);
});

const show = (rows, label) => {
  console.log(`\n${label}: per-condition penalty and the terms that made it`);
  console.log(`  ${'R'.padStart(4)} ${'speed'.padStart(6)} ${'pen'.padStart(6)} ${'reach'.padStart(7)} `
    + `${'worst'.padStart(7)} ${'clip'.padStart(7)} ${'irreg'.padStart(6)} ${'asym'.padStart(6)} `
    + `${'short'.padStart(6)} ${'stall'.padStart(6)} ${'tripod'.padStart(6)}`);
  for (const r of rows) {
    console.log(`  ${r.sproutR.toFixed(1).padStart(4)} ${r.speed.toFixed(2).padStart(6)} ${r.penalty.toFixed(3).padStart(6)} `
      + `${(r.reach * 100).toFixed(2).padStart(6)}% ${(r.reachWorst * 100).toFixed(1).padStart(6)}% `
      + `${r.clip.toExponential(1).padStart(7)} ${r.irregularity.toFixed(3).padStart(6)} ${r.asymmetry.toFixed(3).padStart(6)} `
      + `${r.speedShortfall.toFixed(3).padStart(6)} ${r.stall.toFixed(3).padStart(6)} ${r.tripodImpurity.toFixed(3).padStart(6)}`);
  }
};
show(profileBugGait(BUG_GAIT_BASELINE), 'BASELINE');
show(profileBugGait(winner.theta), 'TUNED');

// ---------------------------------------------------------------------------
// Validation: held out, and at matched pace. Neither is optional.
// ---------------------------------------------------------------------------

const HELD_OUT = [3, 11, 99, 555, 2026];
const baseHeld = scoreBugGait(BUG_GAIT_BASELINE, { seeds: HELD_OUT });
const winHeld = scoreBugGait(winner.theta, { seeds: HELD_OUT });
console.log(`\nheld-out seeds ${HELD_OUT.join(',')}: baseline ${baseHeld.toFixed(4)} -> ${winHeld.toFixed(4)}`
  + `  (${winHeld > baseHeld ? '+' : ''}${(winHeld - baseHeld).toFixed(4)})`);
const generalises = winHeld > baseHeld;
if (!generalises) console.log('  DOES NOT GENERALISE — it was fitted to the tuning seeds.');

// Raise the candidate's speeds until it travels as fast as the baseline, then compare the metric that
// matters most on equal terms. Almost every improvement this objective offers is available by walking
// more slowly, and fewer artifacts per second is not a better gait.
function pace(theta, scale) {
  let speed = 0, reach = 0, n = 0;
  for (const seed of HELD_OUT) {
    for (const cond of CONDITIONS) {
      const m = simulateBugWalk(theta, { ...cond, speed: cond.speed * scale, seed, duration: 5 });
      speed += m.achieved; reach += m.reach; n++;
    }
  }
  return { speed: speed / n, reach: reach / n };
}
const basePace = pace(BUG_GAIT_BASELINE, 1);
let bestScale = 1, bestDiff = Infinity;
for (const scale of [1.0, 1.3, 1.6, 1.9, 2.3]) {
  const d = Math.abs(pace(winner.theta, scale).speed - basePace.speed);
  if (d < bestDiff) { bestDiff = d; bestScale = scale; }
}
const matched = pace(winner.theta, bestScale);
console.log(`\nat matched pace (candidate's speeds x${bestScale.toFixed(1)}):`);
console.log(`  baseline  speed ${basePace.speed.toFixed(3)}  feet out of reach ${(basePace.reach * 100).toFixed(2)}%`);
console.log(`  candidate speed ${matched.speed.toFixed(3)}  feet out of reach ${(matched.reach * 100).toFixed(2)}%`);
const betterAtPace = matched.reach <= basePace.reach;

console.log(`\n${generalises && betterAtPace ? 'ADOPT: it generalises and it is better at the same pace.'
  : 'DO NOT ADOPT: ' + (!generalises ? 'it does not generalise.'
    : 'its score was bought with slowness, not with better foot placement.')}`);

console.log('\nfor reference, the candidate was:');
const g = thetaToGait(winner.theta);
console.log(`  stepDuration: ${g.stepDuration.toFixed(4)},`);
console.log(`  stepLift: ${g.stepLift.toFixed(4)},`);
console.log(`  stationaryTrigger: { h: ${g.stationaryTrigger.h.toFixed(4)}, v: ${g.stationaryTrigger.v.toFixed(4)} },`);
console.log(`  movingTrigger: { h: ${g.movingTrigger.h.toFixed(4)}, v: ${g.movingTrigger.v.toFixed(4)} },`);
console.log(`  comfort: { h: ${g.comfort.h.toFixed(4)}, v: ${g.comfort.v.toFixed(4)} },`);
console.log(`  lookAhead: ${g.lookAhead.toFixed(4)},`);
console.log(`  turnSpeed: ${g.turnSpeed.toFixed(4)},`);
console.log(`  uncomfortableSpeedMultiplier: ${g.uncomfortableSpeedMultiplier.toFixed(4)},`);

console.log(`\nA GOOD SCORE MEANS NOTHING IS VISIBLY BROKEN, NOT THAT IT LOOKS RIGHT.`);
console.log(`The objective has no term for "reads as a beetle" and cannot acquire one.`);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
