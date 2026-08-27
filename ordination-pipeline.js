// The pipeline itself: one config object in, one result out.
//
//   extract -> represent -> embed -> postprocess -> ordinate -> score
//
// Only the first three stages depend on the corpus text, and embedding is the one expensive
// step, so `runPipeline` splits at that seam: `prepare()` is cached by config, and `project()`
// re-runs the cheap tail. That is what makes sweeping stage 4 and 5 combinations affordable.

import { extractUnits } from './ordination-extract.js';
import { representAll } from './ordination-represent.js';
import { embedDocs, cacheKey } from './ordination-embed.js';
import { buildGram, ordinate } from './ordination-vectors.js';
import { labelUnits, scoreConfig, chancePurity } from './ordination-score.js';

export const DEFAULT_CONFIG = Object.freeze({
  unit: 'file',
  chunkLines: 60,
  minChars: 120,
  target: 'stripped',
  stripImports: true,
  splitCase: true,
  lowercase: true,
  dropStopwords: true,
  maxTokens: 4000,
  embedder: 'tfidf',
  minDocFreq: 2,
  maxVocab: 4000,
  dims: 256,
  seed: 1,
  center: true,
  normalize: true,
  metric: 'cosine',
  method: 'pca',
  components: 2,
  iters: 100,
  neighborK: 5,
  maxUnits: 1200,
});

/** Deterministic stride sample, so a capped run is reproducible and spread across the corpus. */
function capUnits(units, maxUnits, notes) {
  if (units.length <= maxUnits) return units;
  const stride = units.length / maxUnits;
  const kept = [];
  for (let i = 0; i < maxUnits; i++) kept.push(units[Math.floor(i * stride)]);
  notes.push(`Capped to ${maxUnits} of ${units.length} units (deterministic stride sample) -- raise maxUnits to see the rest.`);
  return kept;
}

/** Stages 1 to 3: corpus to vectors. The expensive half, worth caching. */
export function prepare(corpus, config = {}, { summaries = null } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const notes = [];

  let units = extractUnits(corpus, { unit: cfg.unit, chunkLines: cfg.chunkLines, minChars: cfg.minChars });
  if (!units.length) throw new Error('no units survived extraction -- check the corpus filter and minChars');
  units = capUnits(units, cfg.maxUnits, notes);

  const { docs, empty, truncated } = representAll(units, {
    target: cfg.target,
    stripImports: cfg.stripImports,
    splitCase: cfg.splitCase,
    lowercase: cfg.lowercase,
    dropStopwords: cfg.dropStopwords,
    maxTokens: cfg.maxTokens,
    summaries,
  });
  if (empty) notes.push(`${empty} of ${docs.length} units produced no tokens${cfg.target === 'summary' ? ' (no summary for that file)' : ''} and sit at the origin.`);
  if (truncated) notes.push(`${truncated} units hit the ${cfg.maxTokens}-token cap, so only their opening was embedded.`);

  const vectors = embedDocs(docs, {
    embedder: cfg.embedder,
    minDocFreq: cfg.minDocFreq,
    maxVocab: cfg.maxVocab,
    dims: cfg.dims,
    seed: cfg.seed,
  });
  if (vectors.droppedTerms) notes.push(`${vectors.droppedTerms} terms fell outside the ${cfg.maxVocab}-term vocabulary.`);

  return { cfg, units, docs, vectors, notes, key: cacheKey(docs, { e: cfg.embedder, v: cfg.maxVocab, d: cfg.dims, m: cfg.minDocFreq }) };
}

/** Stages 4 to 6: vectors to a scored 2D layout. The cheap half, worth sweeping. */
export function project(prepared, config = {}, { labels = null } = {}) {
  const cfg = { ...prepared.cfg, ...config };
  const G = buildGram(prepared.vectors.rows, prepared.vectors.dim, {
    center: cfg.center,
    normalize: cfg.metric === 'cosine' ? true : cfg.normalize,
  });
  const { coords, explained, stress, axesMeaningful } = ordinate(G, {
    method: cfg.method, k: cfg.components, iters: cfg.iters,
  });

  let scores = null;
  let chance = null;
  if (labels) {
    const unitLabels = labelUnits(prepared.units, labels);
    scores = scoreConfig(G, coords, unitLabels, { k: cfg.neighborK, metric: cfg.metric });
    chance = chancePurity(unitLabels);
  }
  return { G, coords, explained, stress, axesMeaningful, scores, chance, cfg };
}

/** Whole pipeline in one call. */
export function runPipeline(corpus, config = {}, { labels = null, summaries = null } = {}) {
  const prepared = prepare(corpus, config, { summaries });
  const projected = project(prepared, config, { labels });
  return { ...prepared, ...projected, notes: prepared.notes };
}

/**
 * Sweep the cheap tail over every postprocess and ordination combination, ranked by how well
 * the vector space recovers the known labels. Reuses one `prepare`, so the cost is stage 4 only.
 */
export function sweepTail(prepared, { labels, metrics = ['cosine', 'euclidean'], centers = [true, false], methods = ['pca', 'mds'] } = {}) {
  const rows = [];
  for (const metric of metrics) {
    for (const center of centers) {
      for (const method of methods) {
        const out = project(prepared, { metric, center, normalize: metric === 'cosine', method }, { labels });
        rows.push({
          metric, center, method,
          purity: out.scores ? out.scores.purity : 0,
          layoutPurity: out.scores ? out.scores.layoutPurity : 0,
          silhouette: out.scores ? out.scores.silhouette : 0,
          chance: out.chance,
        });
      }
    }
  }
  rows.sort((a, b) => b.purity - a.purity || b.silhouette - a.silhouette);
  return rows;
}
