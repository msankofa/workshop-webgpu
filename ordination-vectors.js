// Stages 4 and 5 of the code-ordination pipeline: postprocessing and ordination.
//
// Everything downstream of embedding runs off one n-by-n Gram matrix of inner products, because
// mean-centring a sparse tf-idf matrix would densify it (4000 dims x n rows) for no gain. The
// identity <x-u, y-u> = <x,y> - <x,u> - <y,u> + <u,u> lets the centred Gram be built straight
// from sparse dot products, and every distance, neighbour list and projection then follows from
// d(i,j)^2 = G[i][i] + G[j][j] - 2*G[i][j]. That is also why the stage-4 and stage-5 sweep is
// cheap: only the Gram depends on the embedding, and it is built once.

import { powerIteration, deflate } from './stats-math.js';

export const METRICS = ['cosine', 'euclidean'];
export const ORDINATIONS = ['pca', 'mds', 'stress'];

/** Inner product of two index-sorted sparse rows, by merge join. */
export function sparseDot(a, b) {
  let i = 0, j = 0, sum = 0;
  while (i < a.idx.length && j < b.idx.length) {
    const ai = a.idx[i], bj = b.idx[j];
    if (ai === bj) { sum += a.val[i] * b.val[j]; i++; j++; }
    else if (ai < bj) i++;
    else j++;
  }
  return sum;
}

/** Dense mean vector over sparse rows. */
export function meanVector(rows, dim) {
  const mu = new Float64Array(dim);
  for (const row of rows) for (let i = 0; i < row.idx.length; i++) mu[row.idx[i]] += row.val[i];
  if (rows.length) for (let d = 0; d < dim; d++) mu[d] /= rows.length;
  return mu;
}

/**
 * Gram matrix of the postprocessed vectors.
 * `center` subtracts the mean vector (embedding spaces are anisotropic -- without this every
 * pair reads as similar). `normalize` makes the entries cosine similarities rather than raw
 * inner products, which is what the `cosine` metric means.
 */
export function buildGram(rows, dim, { center = true, normalize = true } = {}) {
  const n = rows.length;
  const mu = center ? meanVector(rows, dim) : null;
  const muDot = new Float64Array(n);      // <x_i, mu>
  let muMu = 0;
  if (mu) {
    for (let d = 0; d < dim; d++) muMu += mu[d] * mu[d];
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      let s = 0;
      for (let e = 0; e < row.idx.length; e++) s += row.val[e] * mu[row.idx[e]];
      muDot[i] = s;
    }
  }

  const G = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let g = sparseDot(rows[i], rows[j]);
      if (mu) g = g - muDot[i] - muDot[j] + muMu;
      G[i][j] = g;
      G[j][i] = g;
    }
  }

  if (normalize) {
    const inv = new Float64Array(n);
    for (let i = 0; i < n; i++) inv[i] = G[i][i] > 1e-12 ? 1 / Math.sqrt(G[i][i]) : 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) G[i][j] *= inv[i] * inv[j];
  }
  return G;
}

/** Distance implied by the Gram matrix. */
export function gramDistance(G, i, j) {
  return Math.sqrt(Math.max(0, G[i][i] + G[j][j] - 2 * G[i][j]));
}

/** Full distance matrix (array of Float64Array rows). */
export function distanceMatrix(G) {
  const n = G.length;
  const D = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = gramDistance(G, i, j);
    D[i][j] = d; D[j][i] = d;
  }
  return D;
}

/**
 * k nearest neighbours of row i.
 * Cosine ranks by the Gram entry directly; euclidean ranks by distance. On normalised vectors
 * the two orders agree, which is worth knowing before reading a metric comparison as meaningful.
 */
export function nearestNeighbors(G, i, k = 8, metric = 'cosine') {
  const n = G.length;
  const scored = [];
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    scored.push({ index: j, score: metric === 'cosine' ? G[i][j] : -gramDistance(G, i, j) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Double-centre a squared-distance matrix, turning any metric into an inner-product form. */
export function doubleCenter(D) {
  const n = D.length;
  const B = Array.from({ length: n }, () => new Float64Array(n));
  const rowMean = new Float64Array(n);
  let grand = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += D[i][j] * D[i][j];
    rowMean[i] = s / n;
    grand += s;
  }
  grand /= n * n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    B[i][j] = -0.5 * (D[i][j] * D[i][j] - rowMean[i] - rowMean[j] + grand);
  }
  return B;
}

/**
 * Top-k eigenpairs of a symmetric matrix, as coordinates.
 * Applied to an already-centred Gram this is PCA scores; applied to a double-centred distance
 * matrix it is classical MDS. Same routine, so the two only differ by what is fed in.
 */
export function eigenCoords(M, k = 2, iters = 300) {
  const n = M.length;
  if (!n) return { coords: [], explained: [], values: [] };
  let work = M.map((row) => Array.from(row));
  let trace = 0;
  for (let i = 0; i < n; i++) trace += M[i][i];
  const vectors = [];
  const values = [];
  for (let c = 0; c < Math.min(k, n); c++) {
    const { vector, value } = powerIteration(work, iters);
    vectors.push(vector);
    values.push(Math.max(0, value));
    work = deflate(work, vector, value);
  }
  // An eigenvector of the Gram scaled by sqrt(lambda) is the coordinate along that axis.
  const coords = [];
  for (let i = 0; i < n; i++) {
    coords.push(vectors.map((vec, c) => vec[i] * Math.sqrt(values[c])));
  }
  const explained = values.map((v) => (trace > 1e-9 ? v / trace : 0));
  return { coords, explained, values };
}

/**
 * SMACOF stress majorisation, started from the PCA solution so it is deterministic.
 * This is the non-linear option: it fits near distances better than PCA at the cost of making
 * the axes meaningless. Cluster separation on this plot is not evidence on its own.
 */
export function stressLayout(D, { k = 2, iters = 100, init = null } = {}) {
  const n = D.length;
  if (n < 2) return { coords: D.map(() => new Array(k).fill(0)), stress: 0 };
  let X = init ? init.map((row) => row.slice(0, k)) : eigenCoords(doubleCenter(D), k).coords;
  X = X.map((row) => {
    const out = new Array(k).fill(0);
    for (let c = 0; c < k; c++) out[c] = row[c] || 0;
    return out;
  });

  const dist = (a, b) => {
    let s = 0;
    for (let c = 0; c < k; c++) { const t = a[c] - b[c]; s += t * t; }
    return Math.sqrt(s);
  };

  let stress = 0;
  for (let it = 0; it < iters; it++) {
    const next = Array.from({ length: n }, () => new Array(k).fill(0));
    for (let i = 0; i < n; i++) {
      let wsum = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dij = dist(X[i], X[j]) || 1e-9;
        const ratio = D[i][j] / dij;
        for (let c = 0; c < k; c++) next[i][c] += X[j][c] + ratio * (X[i][c] - X[j][c]);
        wsum++;
      }
      if (wsum) for (let c = 0; c < k; c++) next[i][c] /= wsum;
    }
    X = next;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const t = dist(X[i], X[j]) - D[i][j];
      num += t * t;
      den += D[i][j] * D[i][j];
    }
    stress = den > 1e-12 ? Math.sqrt(num / den) : 0;
  }
  return { coords: X, stress };
}

/** Run the chosen ordination and report what it is entitled to claim. */
export function ordinate(G, { method = 'pca', k = 2, iters = 100 } = {}) {
  if (method === 'pca') {
    const { coords, explained } = eigenCoords(G, k);
    return { coords, explained, stress: null, axesMeaningful: true };
  }
  const D = distanceMatrix(G);
  if (method === 'mds') {
    const { coords, explained } = eigenCoords(doubleCenter(D), k);
    return { coords, explained, stress: null, axesMeaningful: true };
  }
  if (method === 'stress') {
    const { coords, stress } = stressLayout(D, { k, iters });
    return { coords, explained: [], stress, axesMeaningful: false };
  }
  throw new Error('unknown ordination: ' + method);
}
