// Pure linear-algebra + PCA for the creature stats ordination (no THREE/DOM).
// Node-testable twin (see test-stats-math.mjs), mirroring the repo's forest-cull/post-grade pattern.

// Column means + population stdevs of an N×M matrix (array of equal-length rows).
export function columnStats(matrix) {
  const n = matrix.length, m = n ? matrix[0].length : 0;
  const means = new Array(m).fill(0), stdevs = new Array(m).fill(0);
  if (!n) return { means, stdevs };
  for (const row of matrix) for (let j = 0; j < m; j++) means[j] += row[j];
  for (let j = 0; j < m; j++) means[j] /= n;
  for (const row of matrix) for (let j = 0; j < m; j++) { const d = row[j] - means[j]; stdevs[j] += d * d; }
  for (let j = 0; j < m; j++) stdevs[j] = Math.sqrt(stdevs[j] / n);
  return { means, stdevs };
}

// Center (and optionally z-score) columns. Zero-variance columns collapse to 0 (stdev treated as 1).
export function centerMatrix(matrix, standardize = true) {
  const { means, stdevs } = columnStats(matrix);
  const scale = stdevs.map(s => (s > 1e-9 ? s : 1));
  const out = matrix.map(row => row.map((v, j) => (v - means[j]) / (standardize ? scale[j] : 1)));
  return { centered: out, means, stdevs };
}

// Pearson correlation of two equal-length numeric vectors. 0 if degenerate/zero-variance.
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  const d = Math.sqrt(vx * vy);
  return d > 1e-12 ? cov / d : 0;
}

// Ordinary least-squares fit y = slope*x + intercept, plus Pearson r and r².
// Returns slope/intercept 0 for degenerate (n<2 or zero X-variance) input.
export function linreg(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: 0, intercept: n ? ys[0] : 0, r: 0, r2: 0, n };
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r = (sxx > 1e-12 && syy > 1e-12) ? sxy / Math.sqrt(sxx * syy) : 0;
  return { slope, intercept, r, r2: r * r, n };
}

// "Nice" rounded axis ticks spanning [min,max] with ~count intervals.
// Returns { ticks, niceMin, niceMax, step }. Handles min==max and zero span.
export function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max)) return { ticks: [0], niceMin: 0, niceMax: 1, step: 1 };
  if (min === max) { const p = Math.abs(min) || 1; min -= p * 0.5; max += p * 0.5; }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks, niceMin, niceMax, step };
}

// M×M covariance of an already-centered N×M matrix (population, /N).
export function covarianceMatrix(centered) {
  const n = centered.length, m = n ? centered[0].length : 0;
  const cov = Array.from({ length: m }, () => new Array(m).fill(0));
  for (const row of centered)
    for (let i = 0; i < m; i++)
      for (let j = i; j < m; j++) cov[i][j] += row[i] * row[j];
  for (let i = 0; i < m; i++)
    for (let j = i; j < m; j++) { cov[i][j] /= (n || 1); cov[j][i] = cov[i][j]; }
  return cov;
}

function matVec(A, v) {
  const m = A.length, out = new Array(m).fill(0);
  for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < v.length; j++) s += A[i][j] * v[j]; out[i] = s; }
  return out;
}
function norm(v) { return Math.sqrt(v.reduce((s, x) => s + x * x, 0)); }

// Dominant eigenvector/value of a symmetric matrix via power iteration.
export function powerIteration(A, iters = 200, seed = 1) {
  const m = A.length;
  if (!m) return { vector: [], value: 0 };
  let v = new Array(m).fill(0).map((_, i) => Math.sin(seed + i * 1.7) + 0.5); // deterministic, non-degenerate
  let nv = norm(v) || 1; v = v.map(x => x / nv);
  let value = 0;
  for (let k = 0; k < iters; k++) {
    const Av = matVec(A, v);
    const n2 = norm(Av);
    if (n2 < 1e-12) break;
    const next = Av.map(x => x / n2);
    value = v.reduce((s, x, i) => s + x * Av[i], 0); // Rayleigh quotient (v·Av, v unit)
    let diff = 0; for (let i = 0; i < m; i++) diff += Math.abs(next[i] - v[i]);
    v = next;
    if (diff < 1e-10) break;
  }
  return { vector: v, value };
}

// Remove a known eigenpair from a symmetric matrix (deflation) so the next power
// iteration finds the following component.
export function deflate(A, vec, val) {
  const m = A.length;
  return A.map((row, i) => row.map((x, j) => x - val * vec[i] * vec[j]));
}

// PCA on an N×M matrix. Returns k principal components, per-row scores, and explained variance.
export function pca(matrix, k = 2, { standardize = true } = {}) {
  const n = matrix.length, m = n ? matrix[0].length : 0;
  const kk = Math.min(k, m);
  if (n < 2 || m < 1) return { scores: matrix.map(() => new Array(kk).fill(0)), components: [], explained: [], means: [], stdevs: [] };
  const { centered, means, stdevs } = centerMatrix(matrix, standardize);
  let cov = covarianceMatrix(centered);
  let totalVar = 0; for (let i = 0; i < m; i++) totalVar += cov[i][i];
  const components = [], values = [];
  for (let c = 0; c < kk; c++) {
    const { vector, value } = powerIteration(cov);
    components.push(vector);
    values.push(Math.max(0, value));
    cov = deflate(cov, vector, value);
  }
  const scores = centered.map(row => components.map(comp => comp.reduce((s, w, j) => s + w * row[j], 0)));
  const explained = values.map(v => (totalVar > 1e-9 ? v / totalVar : 0));
  return { scores, components, explained, means, stdevs };
}
