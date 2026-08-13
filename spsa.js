// Derivative-free optimizers for tuning parameters against a NOISY objective (no THREE/DOM).
// Node-testable twin (see test-spsa.mjs), mirroring the repo's stats-math/forest-cull pattern.
//
// Why SPSA: our tuning targets (creature-stats.js metrics, gait/slider sets) can only be sampled by
// running a short simulation, so every evaluation carries run-to-run noise and no gradient exists.
// SPSA estimates a descent direction from exactly TWO evaluations per iteration no matter how many
// parameters are in play, which is why it is the default optimizer for variational algorithms.
// Finite differences need 2n, so at n=12 SPSA buys 6x the iterations for the same sim budget.
//
// Scale handling: parameters with mixed units (frequency in Hz next to step height in metres) break
// a single scalar perturbation size. Given `bounds`, everything runs internally in normalized [0,1]
// space and is mapped back only to call the objective, so one `c` is meaningful across all of them.
//
// All three optimizers minimize, share the same evaluation wrapper, and count every objective call,
// so a best-so-far-vs-evaluations plot compares them fairly.

// Deterministic PRNG - the repo needs seeded, reproducible randomness, never Math.random.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller normal, used only by callers that want to add measurement noise.
export function gaussian(rng, mean = 0, sd = 1) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

// Shared plumbing: unit-space mapping, eval counting, best-so-far tracking.
function makeHarness({ theta0, objective, bounds }) {
  const n = theta0.length;
  const lo = bounds ? bounds.map(b => b[0]) : null;
  const span = bounds ? bounds.map(b => Math.max(b[1] - b[0], 1e-12)) : null;

  const toUnit = x => (bounds ? x.map((v, i) => clamp01((v - lo[i]) / span[i])) : x.slice());
  const fromUnit = u => (bounds ? u.map((v, i) => lo[i] + v * span[i]) : u.slice());

  const h = {
    n, toUnit, fromUnit,
    evals: 0,
    best: { theta: theta0.slice(), value: Infinity },
    // Every objective call in this module goes through here, so counts and bests stay comparable.
    evaluate(unit) {
      const x = fromUnit(unit);
      const y = objective(x);
      h.evals++;
      if (y < h.best.value) h.best = { theta: x, value: y };
      return y;
    },
  };
  return h;
}

/**
 * Simultaneous Perturbation Stochastic Approximation (Spall).
 * Two evaluations per iteration regardless of dimension.
 *
 * Gain sequences follow Spall's standard form: a_k = a/(k+1+A)^alpha, c_k = c/(k+1)^gamma.
 * Defaults alpha=0.602 / gamma=0.101 are the asymptotically valid pair he recommends in practice.
 */
export function createSpsa({
  theta0, objective, bounds = null, maxIter = 200,
  a = 0.1, c = 0.05, A = null, alpha = 0.602, gamma = 0.101, seed = 1,
}) {
  const h = makeHarness({ theta0, objective, bounds });
  const rng = mulberry32(seed);
  const stability = A == null ? Math.max(1, Math.round(0.1 * maxIter)) : A; // Spall: ~10% of budget
  let theta = h.toUnit(theta0);
  let k = 0;

  return {
    get theta() { return h.fromUnit(theta); },
    get evals() { return h.evals; },
    get best() { return h.best; },
    get iter() { return k; },

    step() {
      const ck = c / Math.pow(k + 1, gamma);
      const ak = a / Math.pow(k + 1 + stability, alpha);

      // Rademacher +-1: the perturbation must be symmetric and bounded-inverse, not gaussian.
      const delta = new Array(h.n);
      for (let i = 0; i < h.n; i++) delta[i] = rng() < 0.5 ? -1 : 1;

      // Probes are clamped into the box; this biases the estimate at a bound, which is accepted.
      const plus = theta.map((v, i) => clamp01(v + ck * delta[i]));
      const minus = theta.map((v, i) => clamp01(v - ck * delta[i]));
      const yPlus = h.evaluate(plus);
      const yMinus = h.evaluate(minus);

      // g_i = (y+ - y-) / (2 c_k d_i); with d_i = +-1 the reciprocal is just d_i again.
      const diff = (yPlus - yMinus) / (2 * ck);
      const ghat = delta.map(d => diff * d);

      theta = theta.map((v, i) => clamp01(v - ak * ghat[i]));
      k++;
      return { k, ak, ck, yPlus, yMinus, ghat, theta: h.fromUnit(theta) };
    },
  };
}

/**
 * Central-difference gradient descent, present only as the honest baseline SPSA is claimed to beat.
 * Costs 2n evaluations per iteration, which is the whole point of the comparison.
 */
export function createFiniteDifference({
  theta0, objective, bounds = null, maxIter = 200,
  a = 0.1, c = 0.05, A = null, alpha = 0.602, gamma = 0.101,
}) {
  const h = makeHarness({ theta0, objective, bounds });
  const stability = A == null ? Math.max(1, Math.round(0.1 * maxIter)) : A;
  let theta = h.toUnit(theta0);
  let k = 0;

  return {
    get theta() { return h.fromUnit(theta); },
    get evals() { return h.evals; },
    get best() { return h.best; },
    get iter() { return k; },

    step() {
      const ck = c / Math.pow(k + 1, gamma);
      const ak = a / Math.pow(k + 1 + stability, alpha);
      const ghat = new Array(h.n);
      for (let i = 0; i < h.n; i++) {
        const plus = theta.slice(), minus = theta.slice();
        plus[i] = clamp01(plus[i] + ck);
        minus[i] = clamp01(minus[i] - ck);
        ghat[i] = (h.evaluate(plus) - h.evaluate(minus)) / (2 * ck);
      }
      theta = theta.map((v, i) => clamp01(v - ak * ghat[i]));
      k++;
      return { k, ak, ck, ghat, theta: h.fromUnit(theta) };
    },
  };
}

// Uniform random sampling of the box - the floor any optimizer has to clear to justify itself.
export function createRandomSearch({ theta0, objective, bounds = null, seed = 1 }) {
  const h = makeHarness({ theta0, objective, bounds });
  const rng = mulberry32(seed);
  let k = 0;
  h.evaluate(h.toUnit(theta0));

  return {
    get theta() { return h.best.theta.slice(); },
    get evals() { return h.evals; },
    get best() { return h.best; },
    get iter() { return k; },
    step() {
      const probe = new Array(h.n);
      for (let i = 0; i < h.n; i++) probe[i] = rng();
      const y = h.evaluate(probe);
      k++;
      return { k, y, theta: h.best.theta.slice() };
    },
  };
}

/**
 * Estimate usable `a` and `c` from the objective itself rather than guessing.
 * c is set to the observed noise standard deviation (Spall's rule), and a is set so the first
 * update moves the iterate by roughly `targetStep` in normalized space.
 */
export function calibrateSpsa({
  theta0, objective, bounds = null, seed = 7, samples = 12,
  targetStep = 0.05, maxIter = 200, alpha = 0.602, gradientProbes = 6,
}) {
  const h = makeHarness({ theta0, objective, bounds });
  const rng = mulberry32(seed);
  const unit0 = h.toUnit(theta0);

  // Repeated evaluation at one point isolates measurement noise from parameter sensitivity.
  const ys = [];
  for (let i = 0; i < samples; i++) ys.push(h.evaluate(unit0));
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const sd = Math.sqrt(ys.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, ys.length - 1));
  const c = Math.max(sd, 1e-3);

  // Mean |ghat| over a few probes gives the scale the step size has to cancel.
  let magnitude = 0;
  for (let p = 0; p < gradientProbes; p++) {
    const delta = new Array(h.n);
    for (let i = 0; i < h.n; i++) delta[i] = rng() < 0.5 ? -1 : 1;
    const plus = unit0.map((v, i) => clamp01(v + c * delta[i]));
    const minus = unit0.map((v, i) => clamp01(v - c * delta[i]));
    magnitude += Math.abs((h.evaluate(plus) - h.evaluate(minus)) / (2 * c));
  }
  magnitude = Math.max(magnitude / gradientProbes, 1e-9);

  const stability = Math.max(1, Math.round(0.1 * maxIter));
  const a = (targetStep * Math.pow(stability + 1, alpha)) / magnitude;
  return { a, c, noiseSd: sd, gradientMagnitude: magnitude, evals: h.evals };
}

// Convenience driver: run an optimizer to a fixed evaluation budget, sampling a curve as it goes.
export function runToBudget(optimizer, budget, onSample = null) {
  const curve = [];
  while (optimizer.evals < budget) {
    optimizer.step();
    const point = { evals: optimizer.evals, best: optimizer.best.value };
    if (onSample) onSample(optimizer, point);
    curve.push(point);
  }
  return curve;
}
