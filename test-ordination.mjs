// node test-ordination.mjs
// Covers the code-ordination pipeline: the masking splitter, the sparse/centred Gram identity,
// the ordination projections, and the label scoring -- then runs the whole thing over this
// repo's own source as an end-to-end check that the scores beat chance and beat random vectors.

import fs from 'node:fs';
import path from 'node:path';
import { maskNonCode, matchBrace, bodyBraceFrom, splitFunctions, splitChunks, extractUnits } from './ordination-extract.js';
import { splitIdentifier, tokenize, stripImports, shapeTokens, representUnit } from './ordination-represent.js';
import { buildVocab, embedDocs, hashString } from './ordination-embed.js';
import { sparseDot, meanVector, buildGram, gramDistance, eigenCoords, ordinate, distanceMatrix } from './ordination-vectors.js';
import { parseCodeMap, neighborPurity, silhouette, chancePurity, labelUnits } from './ordination-score.js';
import { prepare, project, runPipeline, sweepTail, DEFAULT_CONFIG } from './ordination-pipeline.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------- stage 1: extract
section('extract: masking');
{
  const src = [
    'const a = "he{llo"; // } not a brace',
    'const re = /}{/g;',
    '/* } block } */',
    'function f() { return 1; }',
  ].join('\n');
  const mask = maskNonCode(src);
  check('mask preserves length', mask.length === src.length, `${mask.length} vs ${src.length}`);
  check('mask blanks braces in strings, regex and comments',
    (mask.match(/[{}]/g) || []).length === 2,
    'found ' + JSON.stringify(mask.match(/[{}]/g)));
  check('mask keeps newlines aligned', mask.split('\n').length === src.split('\n').length);

  const tpl = 'const t = `a ${ obj.x } b`; function g() { }';
  const tm = maskNonCode(tpl);
  check('template holes stay visible', tm.includes('obj.x'), tm);
  check('template text is blanked', !tm.includes('a $'), tm);
}

section('extract: brace matching and bodies');
{
  const s = 'function f({ a, b }) { if (x) { y(); } }';
  const mask = maskNonCode(s);
  const brace = bodyBraceFrom(mask, s.indexOf('f(') + 1);
  check('destructured params are not the body', s[brace] === '{' && brace > s.indexOf('}'),
    'brace at ' + brace);
  check('matchBrace finds the closer', matchBrace(mask, brace) === s.length - 1);
}

section('extract: function splitting');
{
  const src = [
    'import { x } from "./y.js";',
    'export function alpha(a, b) {',
    '  function nested() { return 1; }',
    '  return nested() + a;',
    '}',
    'export const beta = ({ p }) => {',
    '  return p * 2;',
    '};',
    'class Gamma { constructor() { this.v = 1; } }',
  ].join('\n');
  const units = splitFunctions(src, 'demo.js');
  const names = units.map((u) => u.name);
  check('finds top-level declarations', names.join(',') === 'alpha,beta,Gamma', names.join(','));
  check('nested function is absorbed, not double-counted', units[0].text.includes('nested'));
  check('unit ids are path-qualified', units[0].id === 'demo.js#alpha', units[0].id);
  check('start lines are 1-based', units[0].startLine === 2, String(units[0].startLine));

  const chunks = splitChunks(src, 'demo.js', 3);
  check('chunking covers the file', chunks.length === 3, String(chunks.length));
  check('minChars filter drops trivia',
    extractUnits([{ path: 'demo.js', text: src }], { unit: 'function', minChars: 10_000 }).length === 0);
}

// ---------------------------------------------------------------- stage 2: represent
section('represent');
{
  check('camelCase splits', splitIdentifier('buildNavGrid').join(' ') === 'build Nav Grid');
  check('acronyms split sensibly', splitIdentifier('parseHTMLNode').join(' ') === 'parse HTML Node',
    splitIdentifier('parseHTMLNode').join(' '));
  check('snake_case splits', splitIdentifier('grass_blade_count').join(' ') === 'grass blade count');

  const toks = tokenize('const navGrid = 3;', { splitCase: true, lowercase: true, dropStopwords: true });
  check('keywords are dropped', !toks.includes('const'), toks.join(','));
  check('identifier words survive', toks.includes('nav') && toks.includes('grid'), toks.join(','));

  const withImports = 'import { a } from "./b.js";\nconst k = 1;';
  check('imports are strippable', !stripImports(withImports).includes('import'), stripImports(withImports));

  const shapeA = shapeTokens('function f(a) { if (a) { return a + 1; } }');
  const shapeB = shapeTokens('function g(zz) { if (zz) { return zz + 1; } }');
  check('shape target ignores names', shapeA.join() === shapeB.join());
  const shapeC = shapeTokens('function h(a) { while (a) { a--; } }');
  check('shape target still separates structure', shapeA.join() !== shapeC.join());

  const unit = { id: 'x#f', path: 'x.js', name: 'f', text: 'function f() { return 1; }' };
  const summ = representUnit(unit, { target: 'summary', summaries: { 'x.js': 'Builds the nav grid.' } });
  check('summary target uses prose, not code', summ.tokens.includes('nav') && !summ.tokens.includes('return'),
    summ.tokens.join(','));
  const missing = representUnit(unit, { target: 'summary', summaries: {} });
  check('missing summary yields empty tokens, not code fallback', missing.tokens.length === 0);
  const capped = representUnit({ ...unit, text: 'aa bb '.repeat(500) }, { target: 'raw', maxTokens: 10 });
  check('token cap is reported', capped.truncated && capped.tokens.length === 10);
}

// ---------------------------------------------------------------- stage 3: embed
section('embed');
{
  const docs = [
    { id: 'a', tokens: ['grass', 'blade', 'wind', 'grass'] },
    { id: 'b', tokens: ['grass', 'blade', 'wind'] },
    { id: 'c', tokens: ['bot', 'nav', 'grid'] },
    { id: 'd', tokens: ['bot', 'nav', 'grid', 'astar'] },
  ];
  const { vocab } = buildVocab(docs, { minDocFreq: 2, maxVocab: 100 });
  check('rare terms drop out of the vocabulary', !vocab.has('astar'), [...vocab.keys()].join(','));
  check('shared terms stay', vocab.has('grass') && vocab.has('nav'));

  for (const embedder of ['tfidf', 'bm25', 'binary', 'hashing', 'random']) {
    const { rows, dim } = embedDocs(docs, { embedder, minDocFreq: 1, maxVocab: 100, dims: 32 });
    check(`${embedder} produces one row per doc`, rows.length === 4 && dim > 0);
    const sorted = [...rows[0].idx].every((v, i, arr) => i === 0 || arr[i - 1] < v);
    check(`${embedder} indices are sorted for the merge join`, sorted);
  }

  const { rows } = embedDocs(docs, { embedder: 'tfidf', minDocFreq: 1, maxVocab: 100 });
  const simSame = sparseDot(rows[0], rows[1]);
  const simDiff = sparseDot(rows[0], rows[2]);
  check('tf-idf puts the grass pair above the grass/bot pair', simSame > simDiff, `${simSame} vs ${simDiff}`);
  check('hashString is stable', hashString('grass') === hashString('grass'));
}

// ---------------------------------------------------------------- stage 4: gram identity
section('postprocess: the centred Gram identity');
{
  // Dense reference: centre by hand, then compare against the sparse identity the module uses.
  const dim = 6;
  const dense = [
    [1, 0, 2, 0, 0, 1],
    [0, 3, 0, 1, 0, 0],
    [2, 1, 0, 0, 4, 0],
    [0, 0, 1, 2, 0, 3],
  ];
  const rows = dense.map((r) => {
    const idx = [];
    const val = [];
    r.forEach((v, i) => { if (v !== 0) { idx.push(i); val.push(v); } });
    return { idx: Int32Array.from(idx), val: Float32Array.from(val) };
  });
  const mu = meanVector(rows, dim);
  const refMu = new Array(dim).fill(0).map((_, d) => dense.reduce((s, r) => s + r[d], 0) / dense.length);
  check('mean vector matches the dense mean', refMu.every((v, d) => near(v, mu[d], 1e-9)));

  const G = buildGram(rows, dim, { center: true, normalize: false });
  let worst = 0;
  for (let i = 0; i < dense.length; i++) for (let j = 0; j < dense.length; j++) {
    let ref = 0;
    for (let d = 0; d < dim; d++) ref += (dense[i][d] - refMu[d]) * (dense[j][d] - refMu[d]);
    worst = Math.max(worst, Math.abs(ref - G[i][j]));
  }
  check('sparse centred Gram equals the dense centred Gram', worst < 1e-6, 'max error ' + worst);

  const Gn = buildGram(rows, dim, { center: true, normalize: true });
  check('normalised diagonal is 1', [0, 1, 2, 3].every((i) => near(Gn[i][i], 1, 1e-9)));
  check('normalised entries are cosines in [-1, 1]',
    Gn.every((r) => [...r].every((v) => v >= -1.0000001 && v <= 1.0000001)));
  check('Gram is symmetric', Gn.every((r, i) => r.every((v, j) => near(v, Gn[j][i], 1e-12))));

  const d01 = gramDistance(Gn, 0, 1);
  check('distance is non-negative and self-distance is zero', d01 >= 0 && near(gramDistance(Gn, 0, 0), 0, 1e-6));

  // Triangle inequality on the induced metric.
  const D = distanceMatrix(Gn);
  let triOk = true;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) {
    if (D[i][j] > D[i][k] + D[k][j] + 1e-6) triOk = false;
  }
  check('induced distances obey the triangle inequality', triOk);
}

// ---------------------------------------------------------------- stage 5: ordination
section('ordination');
{
  // Three tight clusters in 2D, embedded as sparse rows; PCA must recover the separation.
  const pts = [];
  for (let c = 0; c < 3; c++) for (let i = 0; i < 6; i++) {
    pts.push([Math.cos(c * 2.1) * 10 + i * 0.05, Math.sin(c * 2.1) * 10 + (i % 3) * 0.05, 0.01 * i]);
  }
  const rows = pts.map((p) => ({ idx: Int32Array.from([0, 1, 2]), val: Float32Array.from(p) }));
  const G = buildGram(rows, 3, { center: true, normalize: false });
  const { coords, explained } = eigenCoords(G, 2);
  check('PCA returns one coordinate pair per row', coords.length === pts.length && coords[0].length === 2);
  check('explained variance is ordered and in [0,1]',
    explained[0] >= explained[1] && explained[0] <= 1.0000001 && explained[1] >= -1e-9,
    explained.join(','));
  check('the first two components hold nearly all the variance', explained[0] + explained[1] > 0.99,
    String(explained[0] + explained[1]));

  const labels = pts.map((_, i) => 'c' + Math.floor(i / 6));
  const within = neighborPurity(G, labels, 3).purity;
  check('clusters are recovered by neighbour purity', within > 0.95, String(within));

  for (const method of ['pca', 'mds', 'stress']) {
    const out = ordinate(G, { method, k: 2, iters: 30 });
    check(`${method} returns finite coordinates`,
      out.coords.length === pts.length && out.coords.every((c) => c.every((v) => Number.isFinite(v))));
  }
  const st = ordinate(G, { method: 'stress', k: 2, iters: 60 });
  check('stress layout reports its stress and disclaims its axes',
    st.stress !== null && st.stress >= 0 && st.axesMeaningful === false, String(st.stress));
  check('PCA claims meaningful axes', ordinate(G, { method: 'pca' }).axesMeaningful === true);

  const a = ordinate(G, { method: 'stress', k: 2, iters: 60 });
  const b = ordinate(G, { method: 'stress', k: 2, iters: 60 });
  check('stress layout is deterministic', JSON.stringify(a.coords) === JSON.stringify(b.coords));
}

// ---------------------------------------------------------------- stage 6: scoring
section('scoring');
{
  const labels = ['a', 'a', 'a', 'b', 'b', 'b', 'solo'];
  check('chance purity accounts for label sizes', near(chancePurity(labels), (3 * (2 / 6) + 3 * (2 / 6)) / 6, 1e-9),
    String(chancePurity(labels)));
  const perfect = Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) =>
    labels[i] === labels[j] ? 1 : 0));
  const np = neighborPurity(perfect, labels, 2, 'cosine');
  check('perfect separation scores purity 1', near(np.purity, 1, 1e-9), String(np.purity));
  check('singleton labels are excluded from scoring', np.scored === 6, String(np.scored));
  const sil = silhouette(perfect, labels);
  check('silhouette is positive on perfect separation', sil.silhouette > 0, String(sil.silhouette));
}

section('scoring: code-map label parsing');
{
  const html = fs.readFileSync('code-map.html', 'utf8');
  const { labels, summaries, count } = parseCodeMap(html);
  check('parses many labelled nodes', count > 100, String(count));
  check('labels are subsystem keys', labels['nav-grid.js'] === 'bots', String(labels['nav-grid.js']));
  check('descriptions come through as prose', (summaries['nav-grid.js'] || '').length > 40,
    (summaries['nav-grid.js'] || '').slice(0, 60));
  check('html entities are decoded', !Object.values(summaries).some((s) => s.includes('&lt;')));
  check('escaped quotes are decoded', !Object.values(summaries).some((s) => s.includes("\\'")));
}

// ---------------------------------------------------------------- end to end, on this repo
section('end to end: this repo');
{
  const html = fs.readFileSync('code-map.html', 'utf8');
  const { labels, summaries } = parseCodeMap(html);
  const corpus = fs.readdirSync('.')
    .filter((f) => /\.(js|mjs)$/.test(f) && fs.statSync(f).isFile())
    .map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }));
  check('corpus is non-trivial', corpus.length > 200, String(corpus.length));

  const out = runPipeline(corpus, { unit: 'file', target: 'stripped', embedder: 'tfidf' }, { labels, summaries });
  const labelled = labelUnits(out.units, labels);
  const cov = labelled.filter(Boolean).length / labelled.length;
  // code-map.html hand-lists ~140 of the 600+ files, so most of the corpus is unlabelled and
  // invisible to scoring. That is a limit of the ground truth, not of the pipeline.
  check('enough files carry a subsystem label to score against', cov > 0.15, 'coverage ' + cov.toFixed(2));
  check('purity beats chance', out.scores.purity > out.chance,
    `purity ${out.scores.purity.toFixed(3)} vs chance ${out.chance.toFixed(3)}`);
  // Measured: silhouette sits near zero (slightly negative) while neighbour purity is well above
  // chance. Subsystems are local neighbourhoods in this space, not globally compact clusters --
  // so purity is the measure to tune on and silhouette is the one that says "do not trust a blob".
  check('silhouette is finite and reported', Number.isFinite(out.scores.silhouette), out.scores.silhouette.toFixed(3));
  check('local structure is real even though global clustering is not',
    out.scores.purity > out.chance * 2 && out.scores.silhouette < 0.2,
    `purity ${out.scores.purity.toFixed(3)} silhouette ${out.scores.silhouette.toFixed(3)}`);

  const rnd = runPipeline(corpus, { unit: 'file', embedder: 'random' }, { labels, summaries });
  check('tf-idf beats random vectors',
    out.scores.purity > rnd.scores.purity + 0.1,
    `tfidf ${out.scores.purity.toFixed(3)} vs random ${rnd.scores.purity.toFixed(3)}`);
  check('random vectors score near chance', rnd.scores.purity < rnd.chance + 0.1,
    `${rnd.scores.purity.toFixed(3)} vs chance ${rnd.chance.toFixed(3)}`);

  check('projection loss is reported and non-negative-ish',
    Number.isFinite(out.scores.projectionLoss), String(out.scores.projectionLoss));

  const prepared = prepare(corpus, { unit: 'file', target: 'stripped', embedder: 'tfidf' }, { summaries });
  const swept = sweepTail(prepared, { labels });
  check('sweep ranks every tail combination', swept.length === 8, String(swept.length));
  check('sweep is sorted by purity', swept.every((r, i) => i === 0 || swept[i - 1].purity >= r.purity));

  const uncentred = project(prepared, { center: false }, { labels });
  const centred = project(prepared, { center: true }, { labels });
  check('centring changes the result', !near(uncentred.scores.purity, centred.scores.purity, 1e-9),
    `off ${uncentred.scores.purity.toFixed(3)} vs on ${centred.scores.purity.toFixed(3)}`);

  console.log('\n  --- measured on this repo (file units, tf-idf, cosine) ---');
  console.log(`  files ${corpus.length}, labelled ${(cov * 100).toFixed(0)}%, vocab ${out.vectors.vocabSize}`);
  console.log(`  purity@5 ${out.scores.purity.toFixed(3)} | chance ${out.chance.toFixed(3)} | random ${rnd.scores.purity.toFixed(3)}`);
  console.log(`  silhouette ${out.scores.silhouette.toFixed(3)} | layout purity ${out.scores.layoutPurity.toFixed(3)} (loss ${out.scores.projectionLoss.toFixed(3)})`);
  console.log('  best tail combos:');
  for (const r of swept.slice(0, 4)) {
    console.log(`    ${r.metric}/${r.center ? 'centred' : 'raw'}/${r.method}: purity ${r.purity.toFixed(3)} layout ${r.layoutPurity.toFixed(3)} sil ${r.silhouette.toFixed(3)}`);
  }
  for (const n of out.notes) console.log('  note: ' + n);
}

section('capture targets compared on this repo');
{
  const html = fs.readFileSync('code-map.html', 'utf8');
  const { labels, summaries } = parseCodeMap(html);
  const corpus = fs.readdirSync('.')
    .filter((f) => /\.(js|mjs)$/.test(f) && fs.statSync(f).isFile())
    .map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }));
  const table = [];
  for (const target of ['raw', 'stripped', 'identifiers', 'shape', 'summary']) {
    const out = runPipeline(corpus, { unit: 'file', target, embedder: 'tfidf' }, { labels, summaries });
    table.push({ target, purity: out.scores.purity, sil: out.scores.silhouette, chance: out.chance });
    console.log(`  ${target.padEnd(12)} purity ${out.scores.purity.toFixed(3)}  silhouette ${out.scores.silhouette.toFixed(3)}  (chance ${out.chance.toFixed(3)})`);
  }
  check('every capture target runs', table.length === 5);
  check('at least one target clearly beats chance', table.some((r) => r.purity > r.chance + 0.2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
