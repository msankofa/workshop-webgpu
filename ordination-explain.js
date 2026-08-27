// Step 3's viewer: why each word became the number it did.
//
// ordination-embed.js returns sparse rows of weights. A row of 96 floats is not something you
// can check. This turns one row back into a readable table -- the word, how often it appears in
// this piece, how many pieces contain it at all, and the weight those two produced -- so the
// arithmetic can be verified by eye instead of trusted.
//
// The weights here are read straight off the real sparse row rather than recomputed, so the
// table cannot drift from what the pipeline actually built.

/** index -> word, for reading a sparse row back. */
export function reverseVocab(vocab) {
  const out = new Array(vocab.size);
  for (const [term, entry] of vocab) out[entry.index] = term;
  return out;
}

export const NO_NUMBER = {
  rare: 'used in too few pieces',
  common: 'used in too many pieces',
  cap: 'past the vocabulary cap',
};

/**
 * One piece's vector as an explainable table.
 *
 * `rows` are the words that became numbers, heaviest first. `missing` are the words that came
 * out of step 2 but produced no number, each with the reason. Together they account for every
 * distinct word in the piece, which the test asserts.
 *
 * Takes the already-selected sparse row rather than looking it up, because the caller knows
 * which position the piece sits at and the row is the authority on the weights.
 */
export function explainRow(doc, row, embedding, { minDocFreq = 2, limit = 400 } = {}) {
  const { vocab, docFreq, maxDf, docCount } = embedding;
  if (!vocab || !docFreq) {
    // hashing and random have no vocabulary, so there is no word-level story to tell.
    return { unsupported: true, rows: [], missing: [], counts: { became: row ? row.idx.length : 0 } };
  }
  const words = reverseVocab(vocab);

  // How many times each distinct word appears in this piece.
  const here = new Map();
  for (const t of doc.tokens) here.set(t, (here.get(t) || 0) + 1);

  const rows = [];
  for (let e = 0; e < row.idx.length; e++) {
    const word = words[row.idx[e]];
    rows.push({
      word,
      here: here.get(word) || 0,
      docs: docFreq.get(word) || 0,
      docCount,
      weight: row.val[e],
    });
  }
  rows.sort((a, b) => b.weight - a.weight || (a.word < b.word ? -1 : 1));

  const missing = [];
  const counts = { became: rows.length, rare: 0, common: 0, cap: 0 };
  for (const [word, n] of here) {
    if (vocab.has(word)) continue;
    const df = docFreq.get(word) || 0;
    const why = df < minDocFreq ? 'rare' : (df > maxDf ? 'common' : 'cap');
    counts[why]++;
    missing.push({ word, here: n, docs: df, docCount, why, reason: NO_NUMBER[why] });
  }
  missing.sort((a, b) => b.here - a.here || (a.word < b.word ? -1 : 1));

  return {
    unsupported: false,
    rows: rows.slice(0, limit),
    truncated: Math.max(0, rows.length - limit),
    missing,
    counts,
    distinctWords: here.size,
  };
}

/** Vocabulary headline numbers for the filter strip. */
export function vocabSummary(embedding) {
  if (!embedding.vocab) {
    return { total: 0, kept: embedding.dim, tooRare: 0, tooCommon: 0, overCap: 0, unsupported: true };
  }
  return {
    total: embedding.docFreq.size,
    kept: embedding.vocab.size,
    tooRare: embedding.tooRare,
    tooCommon: embedding.tooCommon,
    overCap: embedding.droppedTerms,
    maxDf: embedding.maxDf,
    unsupported: false,
  };
}

/**
 * The whole matrix as points for the 3D view: one per non-zero cell.
 * Capped, because 3,204 pieces by 4,000 words is 12.8 million cells and only a fraction are
 * filled. What the cap dropped is returned rather than hidden.
 */
export function matrixPoints(embedding, { maxPieces = 1200, maxWords = 600, maxPoints = 240000 } = {}) {
  const rows = embedding.rows;
  const pieceStride = Math.max(1, Math.ceil(rows.length / maxPieces));
  const wordLimit = Math.min(maxWords, embedding.dim);

  const xs = [];
  const ys = [];
  const ws = [];
  let maxWeight = 0;
  let skippedPoints = 0;

  for (let r = 0, out = 0; r < rows.length; r += pieceStride, out++) {
    const row = rows[r];
    for (let e = 0; e < row.idx.length; e++) {
      // Vocabulary indices are already ordered by how many pieces use the word, so a low index
      // is a common word. Cutting at wordLimit keeps the dense, informative left-hand side.
      if (row.idx[e] >= wordLimit) continue;
      if (xs.length >= maxPoints) { skippedPoints++; continue; }
      xs.push(row.idx[e]);
      ys.push(out);
      ws.push(row.val[e]);
      if (row.val[e] > maxWeight) maxWeight = row.val[e];
    }
  }

  const shownPieces = Math.ceil(rows.length / pieceStride);
  return {
    x: Int32Array.from(xs),
    y: Int32Array.from(ys),
    w: Float32Array.from(ws),
    maxWeight,
    shownPieces,
    totalPieces: rows.length,
    shownWords: wordLimit,
    totalWords: embedding.dim,
    pieceStride,
    skippedPoints,
    fillPercent: (xs.length / Math.max(1, shownPieces * wordLimit)) * 100,
  };
}
