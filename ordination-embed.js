// Stage 3 of the code-ordination pipeline: token lists become vectors.
//
// Everything here is local and free -- no API, no model download. That is deliberate: these are
// the baselines a hosted embedding model has to BEAT before it earns its cost, and `random` is
// the control that proves the scoring in ordination-score.js can tell signal from noise at all.
//
// Vectors are sparse ({idx, val} typed-array pairs) because a tf-idf row touches a few hundred
// of several thousand terms. ordination-vectors.js consumes that shape directly.

export const EMBEDDERS = ['tfidf', 'bm25', 'binary', 'hashing', 'random'];

/** Document frequency of every term, plus the vocabulary the weighting will use. */
export function buildVocab(docs, { minDocFreq = 2, maxVocab = 4000, commonRatio = 0.6 } = {}) {
  const df = new Map();
  for (const doc of docs) {
    const seen = new Set(doc.tokens);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  // Terms in almost every document separate nothing, so drop the top of the range too.
  const maxDf = Math.max(minDocFreq, Math.floor(docs.length * commonRatio));
  const kept = [];
  let tooRare = 0;
  let tooCommon = 0;
  for (const [term, n] of df) {
    if (n < minDocFreq) { tooRare++; continue; }
    if (n > maxDf) { tooCommon++; continue; }
    kept.push([term, n]);
  }
  kept.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const vocab = new Map();
  const dropped = Math.max(0, kept.length - maxVocab);
  for (const [term, n] of kept.slice(0, maxVocab)) vocab.set(term, { index: vocab.size, df: n });
  // `df` and the reject counts come back too, so a viewer can say WHY a word became no number.
  return { vocab, dropped, totalTerms: df.size, df, tooRare, tooCommon, maxDf };
}

function sparseRow(counts, weightFn) {
  const entries = [];
  for (const [index, tf] of counts) {
    const w = weightFn(index, tf);
    if (w !== 0) entries.push([index, w]);
  }
  entries.sort((a, b) => a[0] - b[0]); // sorted indices let the gram use a merge join
  const idx = new Int32Array(entries.length);
  const val = new Float32Array(entries.length);
  for (let i = 0; i < entries.length; i++) { idx[i] = entries[i][0]; val[i] = entries[i][1]; }
  return { idx, val };
}

function termCounts(tokens, vocab) {
  const counts = new Map();
  for (const t of tokens) {
    const entry = vocab.get(t);
    if (!entry) continue;
    counts.set(entry.index, (counts.get(entry.index) || 0) + 1);
  }
  return counts;
}

/** A 32-bit string hash, used by the hashing embedder so it needs no vocabulary at all. */
export function hashString(str, seed = 0) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Token lists to sparse vectors.
 * Returns {rows, dim, embedder, vocabSize, droppedTerms} -- no normalisation is applied here,
 * because centring and length-normalising are separate, sweepable choices (stage 4).
 */
export function embedDocs(docs, { embedder = 'tfidf', minDocFreq = 2, maxVocab = 4000, commonRatio = 0.6, dims = 256, seed = 1, k1 = 1.5, b = 0.75 } = {}) {
  if (embedder === 'hashing') {
    const rows = docs.map((doc) => {
      const acc = new Float32Array(dims);
      for (const t of doc.tokens) {
        const h = hashString(t);
        // A signed hash keeps collisions from only ever inflating a bucket.
        acc[h % dims] += (h & 0x10000) ? 1 : -1;
      }
      const idx = [];
      const val = [];
      for (let i = 0; i < dims; i++) if (acc[i] !== 0) { idx.push(i); val.push(acc[i]); }
      return { idx: Int32Array.from(idx), val: Float32Array.from(val) };
    });
    return { rows, dim: dims, embedder, vocabSize: dims, droppedTerms: 0 };
  }

  if (embedder === 'random') {
    const rows = docs.map((_, i) => {
      const rand = mulberry32(seed + i * 7919);
      const idx = new Int32Array(dims);
      const val = new Float32Array(dims);
      for (let d = 0; d < dims; d++) { idx[d] = d; val[d] = rand() * 2 - 1; }
      return { idx, val };
    });
    return { rows, dim: dims, embedder, vocabSize: dims, droppedTerms: 0 };
  }

  const { vocab, dropped, df: docFreq, tooRare, tooCommon, maxDf } = buildVocab(docs, { minDocFreq, maxVocab, commonRatio });
  const n = docs.length;
  const idf = new Float32Array(vocab.size);
  for (const { index, df } of vocab.values()) idf[index] = Math.log((n + 1) / (df + 1)) + 1;

  const lengths = docs.map((d) => d.tokens.length || 1);
  const avgLen = lengths.reduce((a, x) => a + x, 0) / Math.max(1, n);

  const rows = docs.map((doc, i) => {
    const counts = termCounts(doc.tokens, vocab);
    if (embedder === 'binary') return sparseRow(counts, (index) => idf[index]);
    if (embedder === 'bm25') {
      const norm = k1 * (1 - b + b * (lengths[i] / avgLen));
      return sparseRow(counts, (index, tf) => idf[index] * ((tf * (k1 + 1)) / (tf + norm)));
    }
    // tf-idf with sublinear tf, which stops one hot loop's repeated variable from dominating.
    return sparseRow(counts, (index, tf) => (1 + Math.log(tf)) * idf[index]);
  });

  return {
    rows, dim: vocab.size, embedder, vocabSize: vocab.size, droppedTerms: dropped,
    vocab, idf, docFreq, tooRare, tooCommon, maxDf, docCount: n,
  };
}

/** Stable key for the embedding cache: same represented text + same settings means same vectors. */
export function cacheKey(docs, options) {
  let h = 2166136261;
  for (const doc of docs) {
    h = Math.imul(h ^ hashString(doc.id), 16777619);
    h = Math.imul(h ^ doc.tokens.length, 16777619);
    for (let i = 0; i < doc.tokens.length; i += 8) h = Math.imul(h ^ hashString(doc.tokens[i]), 16777619);
  }
  return (h >>> 0).toString(16) + ':' + JSON.stringify(options);
}
