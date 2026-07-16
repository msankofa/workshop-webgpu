// Tests for the pure PCA/linear-algebra module. Run: node test-stats-math.mjs
import { columnStats, centerMatrix, covarianceMatrix, powerIteration, pca, pearson, linreg, niceTicks } from './stats-math.js';

let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name); }
}

// columnStats
{
  const { means, stdevs } = columnStats([[0, 10], [2, 10], [4, 10]]);
  check('col means', approx(means[0], 2) && approx(means[1], 10));
  check('col stdev (population)', approx(stdevs[0], Math.sqrt((4 + 0 + 4) / 3)) && approx(stdevs[1], 0));
}

// centerMatrix: zero-variance column must not divide-by-zero -> stays 0
{
  const { centered } = centerMatrix([[0, 10], [2, 10], [4, 10]], true);
  check('zero-variance col -> 0 (no NaN)', centered.every(r => r[1] === 0));
}

// powerIteration on a known diagonal matrix -> dominant eigenpair
{
  const { vector, value } = powerIteration([[3, 0], [0, 1]]);
  check('power-iter dominant value ~3', approx(value, 3, 1e-3));
  check('power-iter eigenvector ~[±1,0]', approx(Math.abs(vector[0]), 1, 1e-3) && approx(vector[1], 0, 1e-3));
}

// powerIteration on a known off-diagonal symmetric matrix
{
  // [[2,1],[1,2]] has eigenvalues 3 (vec ~[1,1]/√2) and 1 (vec ~[1,-1]/√2)
  const { vector, value } = powerIteration([[2, 1], [1, 2]]);
  check('sym dominant value ~3', approx(value, 3, 1e-3));
  check('sym eigenvector components equal magnitude', approx(Math.abs(vector[0]), Math.abs(vector[1]), 1e-3));
}

// covarianceMatrix symmetry + diagonal = variance
{
  const { centered } = centerMatrix([[1, 2], [3, 6], [5, 10]], false);
  const cov = covarianceMatrix(centered);
  check('cov symmetric', approx(cov[0][1], cov[1][0]));
  check('cov diag = col variance', approx(cov[0][0], (4 + 0 + 4) / 3));
}

// PCA on perfectly correlated data (y = 2x): PC1 explains ~all variance
{
  const data = [[0, 0], [1, 2], [2, 4], [3, 6], [4, 8]];
  const { scores, explained } = pca(data, 2, { standardize: false });
  check('PCA PC1 explains ~100%', explained[0] > 0.999);
  check('PCA PC2 explains ~0%', explained[1] < 1e-3);
  // scores on PC1 must be monotonic with the input ordering (rank preserved)
  const s = scores.map(r => r[0]);
  const mono = s.every((v, i) => i === 0 || (v - s[i - 1]) * (s[1] - s[0]) > 0);
  check('PCA PC1 scores monotonic with input', mono);
}

// PCA explained variance sums to <= 1 and each in [0,1]
{
  const data = [[1, 5, 2], [2, 3, 9], [8, 1, 4], [3, 7, 6], [5, 5, 5]];
  const { explained, scores, components } = pca(data, 2);
  check('PCA explained in [0,1]', explained.every(e => e >= 0 && e <= 1));
  check('PCA explained sum <= 1', explained.reduce((a, b) => a + b, 0) <= 1 + 1e-6);
  check('PCA scores shape N×2', scores.length === 5 && scores.every(r => r.length === 2));
  check('PCA components shape 2×M', components.length === 2 && components.every(c => c.length === 3));
}

// PCA degenerate inputs must not throw
{
  const r1 = pca([[1, 2, 3]], 2); // single row
  check('PCA single row -> zero scores', r1.scores.length === 1 && r1.scores[0].every(v => v === 0));
  const r0 = pca([], 2);
  check('PCA empty -> empty scores', r0.scores.length === 0);
}

// pearson
{
  check('pearson perfect +1', approx(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1));
  check('pearson perfect -1', approx(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1));
  check('pearson zero-variance -> 0', pearson([1, 1, 1], [1, 2, 3]) === 0);
  check('pearson uncorrelated ~0', Math.abs(pearson([1, 2, 3, 4], [1, 2, 1, 2])) < 0.5);
  check('pearson n<2 -> 0', pearson([1], [1]) === 0);
}

// linreg (y = 2x + 1)
{
  const { slope, intercept, r, r2 } = linreg([0, 1, 2, 3], [1, 3, 5, 7]);
  check('linreg slope=2', approx(slope, 2));
  check('linreg intercept=1', approx(intercept, 1));
  check('linreg r=1 on exact line', approx(r, 1) && approx(r2, 1));
  const noisy = linreg([0, 1, 2, 3], [1, 3, 4, 7]); // still positive trend
  check('linreg noisy r2 in (0,1)', noisy.r2 > 0 && noisy.r2 < 1);
  check('linreg zero X-variance -> slope 0', linreg([2, 2, 2], [1, 2, 3]).slope === 0);
}

// niceTicks
{
  const t = niceTicks(0, 97, 5);
  check('niceTicks covers range', t.niceMin <= 0 && t.niceMax >= 97);
  check('niceTicks round step', [1, 2, 5, 10, 20, 25, 50].includes(t.step));
  check('niceTicks ascending unique', t.ticks.every((v, i) => i === 0 || v > t.ticks[i - 1]));
  const eq = niceTicks(5, 5, 5); // min==max must not blow up
  check('niceTicks equal min/max -> valid span', eq.niceMax > eq.niceMin && eq.ticks.length >= 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
