// Stage 6 of the code-ordination pipeline: scoring a configuration against known labels.
//
// Without this the map is decoration -- any pipeline produces a plot, and a plot always looks
// like it means something. The repo's own subsystem assignments in code-map.html are the free
// ground truth: if terrain files do not land near terrain files, the configuration is wrong.

import { gramDistance, nearestNeighbors } from './ordination-vectors.js';

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&amp;': '&', '&#39;': "'" };

function unescapeDesc(str) {
  return str
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/&lt;|&gt;|&quot;|&amp;|&#39;/g, (m) => ENTITIES[m]);
}

/**
 * Pull labels and hand-written descriptions out of code-map.html's NODES array.
 * The descriptions double as the `summary` capture target -- prose about what a file does,
 * which is a different similarity notion from the file's own vocabulary.
 */
export function parseCodeMap(html) {
  const labels = {};
  const summaries = {};
  const entry = /\{\s*id:\s*'((?:[^'\\]|\\.)*)'\s*,\s*group:\s*'([^']*)'/g;
  const found = [];
  let m;
  while ((m = entry.exec(html)) !== null) found.push({ id: unescapeDesc(m[1]), group: m[2], at: m.index });
  for (let i = 0; i < found.length; i++) {
    const slice = html.slice(found[i].at, i + 1 < found.length ? found[i + 1].at : found[i].at + 6000);
    labels[found[i].id] = found[i].group;
    const desc = /desc:\s*'((?:[^'\\]|\\.)*)'/.exec(slice);
    if (desc) summaries[found[i].id] = unescapeDesc(desc[1]);
  }
  return { labels, summaries, count: found.length };
}

/** Label per unit, via its file path. Units in unlabelled files score as null and are skipped. */
export function labelUnits(units, labels) {
  return units.map((u) => labels[u.path] ?? null);
}

/**
 * Mean fraction of each unit's k nearest neighbours that share its label.
 * Units whose label has only one member are excluded -- they can never score above zero and
 * would otherwise drag every configuration down by the same constant.
 */
export function neighborPurity(G, labels, k = 5, metric = 'cosine') {
  const counts = new Map();
  for (const l of labels) if (l != null) counts.set(l, (counts.get(l) || 0) + 1);
  let total = 0;
  let scored = 0;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label == null || counts.get(label) < 2) continue;
    const neigh = nearestNeighbors(G, i, k, metric);
    let hit = 0;
    for (const nb of neigh) if (labels[nb.index] === label) hit++;
    total += hit / Math.max(1, neigh.length);
    scored++;
  }
  return { purity: scored ? total / scored : 0, scored };
}

/** Same measure on a 2D layout, so the cost of the projection is visible rather than assumed. */
export function layoutPurity(coords, labels, k = 5) {
  const counts = new Map();
  for (const l of labels) if (l != null) counts.set(l, (counts.get(l) || 0) + 1);
  const dist = (a, b) => Math.hypot((a[0] || 0) - (b[0] || 0), (a[1] || 0) - (b[1] || 0));
  let total = 0;
  let scored = 0;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label == null || counts.get(label) < 2) continue;
    const near = [];
    for (let j = 0; j < coords.length; j++) {
      if (j === i) continue;
      near.push({ index: j, d: dist(coords[i], coords[j]) });
    }
    near.sort((a, b) => a.d - b.d);
    const top = near.slice(0, k);
    let hit = 0;
    for (const nb of top) if (labels[nb.index] === label) hit++;
    total += hit / Math.max(1, top.length);
    scored++;
  }
  return { purity: scored ? total / scored : 0, scored };
}

/** Mean silhouette width over labelled units, in the Gram's own distance. */
export function silhouette(G, labels) {
  const n = labels.length;
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    if (labels[i] == null) continue;
    if (!groups.has(labels[i])) groups.set(labels[i], []);
    groups.get(labels[i]).push(i);
  }
  let total = 0;
  let scored = 0;
  for (let i = 0; i < n; i++) {
    const label = labels[i];
    if (label == null) continue;
    const own = groups.get(label);
    if (own.length < 2) continue;
    let a = 0;
    for (const j of own) if (j !== i) a += gramDistance(G, i, j);
    a /= own.length - 1;
    let b = Infinity;
    for (const [other, members] of groups) {
      if (other === label) continue;
      let sum = 0;
      for (const j of members) sum += gramDistance(G, i, j);
      b = Math.min(b, sum / members.length);
    }
    if (!isFinite(b)) continue;
    total += (b - a) / Math.max(a, b);
    scored++;
  }
  return { silhouette: scored ? total / scored : 0, scored };
}

/** Every score for one configuration, plus the label coverage the scores rest on. */
export function scoreConfig(G, coords, labels, { k = 5, metric = 'cosine' } = {}) {
  const np = neighborPurity(G, labels, k, metric);
  const lp = coords ? layoutPurity(coords, labels, k) : { purity: 0, scored: 0 };
  const sil = silhouette(G, labels);
  const labelled = labels.filter((l) => l != null).length;
  return {
    purity: np.purity,
    layoutPurity: lp.purity,
    projectionLoss: np.purity - lp.purity,
    silhouette: sil.silhouette,
    scored: np.scored,
    labelled,
    coverage: labels.length ? labelled / labels.length : 0,
  };
}

/**
 * What a label split of this shape scores by chance, given the label sizes.
 * A purity of 0.4 means nothing until you know the expected value is 0.38.
 */
export function chancePurity(labels) {
  const counts = new Map();
  let n = 0;
  for (const l of labels) {
    if (l == null) continue;
    counts.set(l, (counts.get(l) || 0) + 1);
    n++;
  }
  if (n < 2) return 0;
  let sum = 0;
  for (const c of counts.values()) if (c >= 2) sum += c * ((c - 1) / (n - 1));
  const eligible = [...counts.values()].filter((c) => c >= 2).reduce((a, x) => a + x, 0);
  return eligible ? sum / eligible : 0;
}

/** Import edges from code-map.html, as an undirected "these two files know about each other" set. */
export function parseCodeMapEdges(html) {
  const start = html.indexOf('const EDGES = [');
  if (start < 0) return new Set();
  const slice = html.slice(start, html.indexOf('\n];', start));
  const pair = /\[\s*'([^']+)'\s*,\s*'([^']+)'/g;
  const set = new Set();
  let m;
  while ((m = pair.exec(slice)) !== null) {
    set.add(m[1] + '|' + m[2]);
    set.add(m[2] + '|' + m[1]);
  }
  return set;
}

/**
 * Pairs that sit close in the embedding space but never import each other.
 * This is the point of overlaying the map on the dependency graph: where the two disagree is
 * usually parallel evolution -- the same idea implemented twice in files that never met.
 */
export function findUnconnectedSimilar(G, units, edges, { minSim = 0.4, limit = 40, ignoreTestPairs = true } = {}) {
  const out = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      if (units[i].path === units[j].path) continue; // same file is not a finding
      if (edges.has(units[i].path + '|' + units[j].path)) continue;
      if (ignoreTestPairs && isTestOf(units[i].path, units[j].path)) continue;
      const sim = G[i][j];
      if (sim >= minSim) out.push({ a: units[i], b: units[j], sim });
    }
  }
  out.sort((x, y) => y.sim - x.sim);
  return out.slice(0, limit);
}

/** True when one path is the other's test file, which is a similarity nobody needs reporting. */
export function isTestOf(a, b) {
  const stem = (p) => p.replace(/^.*\//, '').replace(/\.(js|mjs)$/, '');
  const [x, y] = [stem(a), stem(b)];
  return x === 'test-' + y || y === 'test-' + x;
}
