// Tunes the speed->gait model against gait-objective.js and prints the winner as a pasteable
// literal. Not a test - run it by hand when the harness or the rig changes:
//
//   node tune-gait.mjs [--budget 6000] [--restarts 5]
//
// Multiple restarts because SPSA is a local method on a noisy objective: one run landing in a
// shallow basin is expected, and the clean reference score (never shown to the search) is what
// picks between them. The baseline is always evaluated too, so a run that fails to beat the
// shipped model reports that rather than silently emitting a worse "winner".

import { createSpsa, calibrateSpsa, runToBudget, mulberry32 } from './spsa.js';
import {
  GAIT_PARAMS, GAIT_BOUNDS, GAIT_INDEX, baselineTheta, sampleGait, scoreGait, profileGait,
} from './gait-objective.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : fallback;
};
const BUDGET = arg('budget', 6000);
const RESTARTS = arg('restarts', 5);

const f4 = v => v.toFixed(4);
const f7 = v => v.toFixed(7);

function objectiveFor(seed) {
  const rng = mulberry32(seed);
  return theta => -sampleGait(theta, rng);      // spsa.js minimizes
}

function reportProfile(label, theta) {
  console.log(`\n  ${label}: speed  slidePlanted  slideSwing  clip   over%  pelvis  step/s  stride  penalty`);
  for (const p of profileGait(theta)) {
    console.log('        ', [
      p.speed.toFixed(2).padStart(5), f4(p.slidePlanted).padStart(12), f4(p.slideSwing).padStart(11),
      f4(p.clip).padStart(7), (p.overextend * 100).toFixed(0).padStart(6),
      p.pelvisHeight.toFixed(3).padStart(7), p.stepRate.toFixed(2).padStart(7),
      p.meanStep.toFixed(2).padStart(7), p.penalty.toFixed(3).padStart(8),
    ].join(''));
  }
}

const baseline = baselineTheta();
const baselineScore = scoreGait(baseline);
console.log(`baseline (shipped model)  clean score ${f4(baselineScore)}`);
reportProfile('baseline', baseline);

const results = [];
for (let r = 0; r < RESTARTS; r++) {
  const seed = 101 + r * 37;
  const objective = objectiveFor(seed);
  const { a, c } = calibrateSpsa({ theta0: baseline, objective, bounds: GAIT_BOUNDS, seed });
  const opt = createSpsa({
    theta0: baseline, objective, bounds: GAIT_BOUNDS, a, c, seed,
    maxIter: Math.ceil(BUDGET / 2), A: Math.ceil(BUDGET / 20),
  });
  runToBudget(opt, BUDGET);
  const theta = opt.best.theta;
  const clean = scoreGait(theta);
  results.push({ seed, a, c, theta, clean });
  console.log(`restart ${r}  seed ${seed}  a=${f4(a)} c=${f4(c)}  clean score ${f4(clean)}`);
}

results.sort((x, y) => y.clean - x.clean);
const full = results[0];
console.log(`\nbest full-search restart: seed ${full.seed}, clean score ${f4(full.clean)}`);

// The one-parameter alternative: shipped coefficients, lead term only. Worth computing every time
// because it has repeatedly BEATEN the 11-parameter search - the shipped fit is already good and
// the only thing missing from it is a lead term. A grid is exact here where SPSA is not: one
// bounded dimension, and the clean score is cheap enough to evaluate a few hundred times.
function bestLeadOnly(overlap = GAIT_PARAMS[GAIT_INDEX.overlap].base) {
  const at = L => {
    const t = baseline.slice();
    t[GAIT_INDEX.leadScale] = L;
    t[GAIT_INDEX.overlap] = overlap;
    return t;
  };
  let best = { L: 0, clean: scoreGait(at(0)) };
  for (let L = 0; L <= 1.5001; L += 0.05) {
    const clean = scoreGait(at(L));
    if (clean > best.clean) best = { L, clean };
  }
  for (let L = Math.max(0, best.L - 0.05); L <= best.L + 0.0501; L += 0.005) {
    const clean = scoreGait(at(L));
    if (clean > best.clean) best = { L, clean };
  }
  return { ...best, overlap, theta: at(best.L) };
}
// The optimum moves with stepOverlap, so report the curve rather than one number pretending to be
// universal. bot-viewer-v3.html runs 0.22; the shipped module's default is 0.
console.log('\nlead-only optimum vs step overlap (shipped coefficients otherwise):');
for (const ov of [0, 0.11, 0.22, 0.33]) {
  const r = bestLeadOnly(ov);
  const off = baseline.slice();
  off[GAIT_INDEX.overlap] = ov;
  console.log(`  overlap ${ov.toFixed(2)}  best leadScale ${r.L.toFixed(3)}  clean ${f4(r.clean)}`
    + `  (no lead: ${f4(scoreGait(off))})`);
}
// Compared against the full search at the SAME overlap the full search started from, or the two
// numbers are not measuring the same gait.
const lead = bestLeadOnly();
const leadV3 = bestLeadOnly(0.22);
console.log(`\nlead-only at the module default overlap: leadScale ${lead.L.toFixed(3)}, clean ${f4(lead.clean)}`);
console.log(`lead-only at bot-viewer-v3's overlap 0.22: leadScale ${leadV3.L.toFixed(3)}, clean ${f4(leadV3.clean)}`
  + '  <- the number to put in GAIT_MODELS.tuned');

const win = lead.clean >= full.clean ? lead : full;
console.log(`\nwinner: ${win === lead ? 'LEAD-ONLY' : 'full search'}  ${f4(win.clean)} vs baseline ${f4(baselineScore)}`);
if (win.clean <= baselineScore) {
  console.log('NO IMPROVEMENT. Do not ship these coefficients.');
  process.exit(1);
}
reportProfile('tuned', win.theta);

console.log('\n  param            shipped        tuned');
for (const p of GAIT_PARAMS) {
  const i = GAIT_INDEX[p.key];
  const atBound = win.theta[i] <= p.min + 1e-6 || win.theta[i] >= p.max - 1e-6 ? '  <- at bound' : '';
  console.log(`  ${p.key.padEnd(14)} ${f7(baseline[i]).padStart(12)} ${f7(win.theta[i]).padStart(12)}${atBound}`);
}

const t = win.theta, i = GAIT_INDEX;
console.log(`
// ---- paste into player-procedural-body.js ----
  pelvisHeightRatio: Object.freeze({ m: ${f7(t[i.pelvisSlope])}, b: ${f7(t[i.pelvisBase])} }),
  maxStepDistance:   Object.freeze({ m: ${f7(t[i.strideSlope])}, b: ${f7(t[i.strideBase])} }),
  stepLift:          Object.freeze({ m: ${f7(t[i.liftSlope])}, b: ${f7(t[i.liftBase])} }),
  stepDuration:      Object.freeze({ A: ${f7(t[i.cadenceA])}, B: ${f7(t[i.cadenceB])} }),
  triggerDistance: ${f7(t[i.trigger])},
  stepOverlap: ${f7(t[i.overlap])},
  stepLeadScale: ${f7(t[i.leadScale])},`);
