// Tests for the pure derivative-free optimizer module. Run: node test-spsa.mjs
import {
  createSpsa, createFiniteDifference, createRandomSearch,
  calibrateSpsa, runToBudget, mulberry32, gaussian,
} from './spsa.js';

let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name); }
}

// mulberry32: deterministic, in range, not constant
{
  const a = mulberry32(42), b = mulberry32(42);
  const xs = Array.from({ length: 200 }, () => a());
  const ys = Array.from({ length: 200 }, () => b());
  check('rng reproducible for a seed', xs.every((v, i) => v === ys[i]));
  check('rng within [0,1)', xs.every(v => v >= 0 && v < 1));
  check('rng not constant', new Set(xs).size > 190);
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  check('rng roughly uniform mean', Math.abs(mean - 0.5) < 0.06);
}

// gaussian: mean and spread land where they should
{
  const rng = mulberry32(3);
  const xs = Array.from({ length: 4000 }, () => gaussian(rng, 2, 0.5));
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
  check('gaussian mean ~2', Math.abs(mean - 2) < 0.05);
  check('gaussian sd ~0.5', Math.abs(sd - 0.5) < 0.05);
}

// Cost accounting: SPSA is 2 evaluations per iteration at ANY dimension - the module's core claim.
{
  for (const n of [2, 12, 60]) {
    const opt = createSpsa({ theta0: new Array(n).fill(0.5), objective: x => x[0], maxIter: 10 });
    opt.step(); opt.step(); opt.step();
    check(`spsa 2 evals/iter at n=${n}`, opt.evals === 6);
  }
  const fd = createFiniteDifference({ theta0: new Array(12).fill(0.5), objective: x => x[0], maxIter: 10 });
  fd.step();
  check('finite-difference 2n evals/iter (n=12 -> 24)', fd.evals === 24);
}

// Gradient direction on a known linear function: g should track the true slope.
{
  const grads = [];
  const opt = createSpsa({
    theta0: [0, 0], objective: x => 3 * x[0] - 5 * x[1], bounds: [[-10, 10], [-10, 10]],
    a: 0, c: 0.1, maxIter: 50, seed: 5, // a=0 pins theta so every estimate is taken at the origin
  });
  for (let i = 0; i < 400; i++) grads.push(opt.step().ghat);
  const mx = grads.reduce((s, g) => s + g[0], 0) / grads.length;
  const my = grads.reduce((s, g) => s + g[1], 0) / grads.length;
  // Unit-space slopes: the box spans 20 units, so d/du = 20 * d/dx.
  check('spsa mean gradient x ~ +60', approx(mx, 60, 3));
  check('spsa mean gradient y ~ -100', approx(my, -100, 3));
}

// Noiseless quadratic: must actually converge on the optimum.
// Gains come from calibrateSpsa, not by hand - hand-picked values were wildly too large here.
{
  const objective = x => (x[0] - 3) ** 2 + (x[1] + 1) ** 2 + 0.5 * (x[2] - 2) ** 2;
  const bounds = [[-10, 10], [-10, 10], [-10, 10]];
  const theta0 = [-8, 7, -5];
  const cal = calibrateSpsa({ theta0, objective, bounds, maxIter: 3000 });
  const opt = createSpsa({ theta0, objective, bounds, a: cal.a, c: cal.c, maxIter: 3000, seed: 11 });
  for (let i = 0; i < 3000; i++) opt.step();
  const t = opt.theta;
  check('quadratic converges x0 -> 3', approx(t[0], 3, 0.15));
  check('quadratic converges x1 -> -1', approx(t[1], -1, 0.15));
  check('quadratic converges x2 -> 2', approx(t[2], 2, 0.25));
  check('quadratic final cost near zero', objective(t) < 0.05);
}

// Mixed-scale parameters: normalization is what stops the small-range axis being ignored.
{
  // x0 spans 1000 units, x1 spans 0.02 - a single unnormalized c cannot serve both.
  const objective = x => ((x[0] - 700) / 1000) ** 2 + ((x[1] - 0.015) / 0.02) ** 2;
  const bounds = [[0, 1000], [0, 0.02]];
  const opt = createSpsa({ theta0: [100, 0.001], objective, bounds, a: 0.3, c: 0.02, maxIter: 2000, seed: 4 });
  for (let i = 0; i < 2000; i++) opt.step();
  const t = opt.theta;
  check('mixed-scale wide axis converges', Math.abs(t[0] - 700) < 25);
  check('mixed-scale narrow axis converges', Math.abs(t[1] - 0.015) < 0.0008);
}

// Noisy objective: the whole reason this module exists.
{
  const clean = x => (x[0] - 2) ** 2 + (x[1] - 2) ** 2;
  const bounds = [[-8, 8], [-8, 8]];
  const theta0 = [-6, 5];
  const calRng = mulberry32(99);
  const cal = calibrateSpsa({ theta0, objective: x => clean(x) + gaussian(calRng, 0, 0.6), bounds, maxIter: 1500 });
  check('calibrate sizes c to the injected noise', Math.abs(cal.c - 0.6) < 0.15);
  const rng = mulberry32(99);
  const noisy = x => clean(x) + gaussian(rng, 0, 0.6);
  const opt = createSpsa({ theta0, objective: noisy, bounds, a: cal.a, c: cal.c, maxIter: 1500, seed: 21 });
  for (let i = 0; i < 1500; i++) opt.step();
  check('noisy: true cost improves a lot', clean(opt.theta) < clean(theta0) * 0.02);
  check('noisy: lands near the true optimum', clean(opt.theta) < 0.6);
}

// Bounds are respected on both the iterate and every probe the objective ever sees.
{
  let violations = 0;
  const bounds = [[0, 1], [2, 3]];
  const objective = x => {
    if (x[0] < 0 || x[0] > 1 || x[1] < 2 || x[1] > 3) violations++;
    return -(x[0] + x[1]); // pushes hard into the upper corner
  };
  const opt = createSpsa({ theta0: [0.5, 2.5], objective, bounds, a: 5, c: 0.3, maxIter: 300, seed: 2 });
  for (let i = 0; i < 300; i++) opt.step();
  check('no probe escaped the bounds', violations === 0);
  const t = opt.theta;
  check('iterate stays in bounds', t[0] >= 0 && t[0] <= 1 && t[1] >= 2 && t[1] <= 3);
  check('iterate pinned at the maximising corner', approx(t[0], 1, 1e-9) && approx(t[1], 3, 1e-9));
}

// Same seed -> same trajectory; different seed -> different trajectory.
{
  const mk = seed => {
    const rng = mulberry32(1);
    const opt = createSpsa({
      theta0: [1, 1], objective: x => x[0] ** 2 + x[1] ** 2 + gaussian(rng, 0, 0.1),
      bounds: [[-5, 5], [-5, 5]], a: 0.2, c: 0.05, maxIter: 100, seed,
    });
    for (let i = 0; i < 100; i++) opt.step();
    return opt.theta;
  };
  const a1 = mk(8), a2 = mk(8), b = mk(9);
  check('same seed reproduces exactly', a1[0] === a2[0] && a1[1] === a2[1]);
  check('different seed diverges', a1[0] !== b[0] || a1[1] !== b[1]);
}

// best-so-far never rises, and is reported in real parameter space not unit space.
{
  const objective = x => Math.abs(x[0] - 250);
  const cal = calibrateSpsa({ theta0: [500], objective, bounds: [[0, 1000]], maxIter: 400 });
  const opt = createSpsa({
    theta0: [500], objective, bounds: [[0, 1000]],
    a: cal.a, c: cal.c, maxIter: 400, seed: 6,
  });
  let previous = Infinity, monotone = true;
  for (let i = 0; i < 400; i++) { opt.step(); if (opt.best.value > previous + 1e-12) monotone = false; previous = opt.best.value; }
  check('best-so-far is monotone', monotone);
  check('best reported in parameter space', opt.best.theta[0] > 1 && Math.abs(opt.best.theta[0] - 250) < 20);
}

// calibrateSpsa recovers the injected noise level and proposes usable gains.
{
  const rng = mulberry32(17);
  const objective = x => 4 * x[0] + gaussian(rng, 0, 0.25);
  const cal = calibrateSpsa({
    theta0: [0.5], objective, bounds: [[0, 1]], samples: 400, gradientProbes: 60, seed: 3,
  });
  check('calibrate recovers noise sd ~0.25', Math.abs(cal.noiseSd - 0.25) < 0.05);
  check('calibrate c tracks noise sd', approx(cal.c, cal.noiseSd, 0.05));
  check('calibrate returns positive finite a', cal.a > 0 && Number.isFinite(cal.a));
  check('calibrate counts its own evals', cal.evals === 400 + 60 * 2);
}

// SPSA beats finite differences at equal EVALUATION budget in higher dimensions.
{
  const n = 20, budget = 1200;
  const centre = Array.from({ length: n }, (_, i) => 0.3 + 0.4 * Math.sin(i));
  const clean = x => x.reduce((s, v, i) => s + (v - centre[i]) ** 2, 0);
  const bounds = Array.from({ length: n }, () => [-2, 2]);
  const theta0 = new Array(n).fill(-1.5);

  const mkNoisy = seed => { const r = mulberry32(seed); return x => clean(x) + gaussian(r, 0, 0.3); };
  // One calibration, shared by both gradient methods, so the race is on cost per iteration alone.
  const cal = calibrateSpsa({ theta0, objective: mkNoisy(5), bounds, maxIter: budget / 2 });
  const spsa = createSpsa({ theta0, objective: mkNoisy(1), bounds, a: cal.a, c: cal.c, maxIter: budget / 2, seed: 31 });
  const fd = createFiniteDifference({ theta0, objective: mkNoisy(1), bounds, a: cal.a, c: cal.c, maxIter: Math.max(1, Math.round(budget / (2 * n))) });
  const rs = createRandomSearch({ theta0, objective: mkNoisy(1), bounds, seed: 31 });
  runToBudget(spsa, budget); runToBudget(fd, budget); runToBudget(rs, budget);

  check('spsa ran far more iterations than fd', spsa.iter > fd.iter * 8);
  check('spsa true cost beats fd at equal budget', clean(spsa.theta) < clean(fd.theta));
  check('spsa true cost beats random search', clean(spsa.theta) < clean(rs.theta));
  check('spsa improved on the start point', clean(spsa.theta) < clean(theta0) * 0.01);
  check('random search barely moves in 20 dimensions', clean(rs.theta) > clean(theta0) * 0.1);
}

// runToBudget stops at the budget and returns a curve keyed to evaluation count.
{
  const opt = createSpsa({ theta0: [0], objective: x => x[0] ** 2, bounds: [[-1, 1]], maxIter: 50 });
  const curve = runToBudget(opt, 40);
  check('runToBudget honours the budget', opt.evals >= 40 && opt.evals <= 41);
  check('curve length matches iterations', curve.length === opt.iter);
  check('curve evals ascend', curve.every((p, i) => i === 0 || p.evals > curve[i - 1].evals));
  check('curve best descends', curve.every((p, i) => i === 0 || p.best <= curve[i - 1].best + 1e-12));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
