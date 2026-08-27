// node test-ordination-steps.mjs
// The step viewer shows what each stage did to the source. That display is only worth anything
// if it agrees with the pipeline it claims to be showing, so these checks compare the span
// overlay against ordination-represent.js's real output over this repo's own files.

import fs from 'node:fs';
import { maskNonCode, extractUnits, splitFunctions } from './ordination-extract.js';
import { representUnit } from './ordination-represent.js';
import { annotateUnit, nonCodeRegions, importRegions, coverageGaps, tallyRows } from './ordination-annotate.js';
import { embedDocs } from './ordination-embed.js';
import { explainRow, reverseVocab, vocabSummary, matrixPoints } from './ordination-explain.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}
const section = (t) => console.log('\n' + t);

section('spans cover the source exactly');
{
  const unit = { path: 'x.js', name: 'f', startLine: 1, text: [
    "import { Vec } from './v.js';",
    '// walkable cells only',
    'export function buildNavGrid(size) {',
    '  const cells = [];',
    '  const label = "grid text";',
    '  for (let i = 0; i < size; i++) cells.push(i);',
    '  return cells;',
    '}',
  ].join('\n') };

  const { spans, words, tally } = annotateUnit(unit, {});
  check('spans start at 0', spans[0].start === 0);
  check('spans end at the end of the text', spans[spans.length - 1].end === unit.text.length);
  let contiguous = true;
  for (let i = 1; i < spans.length; i++) if (spans[i].start !== spans[i - 1].end) contiguous = false;
  check('spans are gap-free and non-overlapping', contiguous);
  check('rebuilding from spans gives the original text',
    spans.map((s) => s.text).join('') === unit.text);

  const importSpan = spans.find((s) => s.reason === 'import');
  check('the import line is marked dropped', importSpan && !importSpan.kept, JSON.stringify(importSpan?.text));
  const commentSpan = spans.find((s) => s.reason === 'comment');
  check('the comment is marked dropped', commentSpan && !commentSpan.kept);
  const stringSpan = spans.find((s) => s.reason === 'string');
  check('the quoted text is marked dropped', stringSpan && !stringSpan.kept, JSON.stringify(stringSpan?.text));
  check('kept words include the identifier parts', words.includes('build') && words.includes('nav') && words.includes('grid'),
    words.join(','));
  check('keywords are counted as dropped', (tally.keyword || 0) > 0, JSON.stringify(tally));
  check('tallyRows sorts by count', tallyRows(tally).every((r, i, a) => i === 0 || a[i - 1].count >= r.count));
}

section('raw target keeps comments and strings');
{
  const unit = { path: 'x.js', name: 'f', startLine: 1,
    text: '// walkable cells\nconst label = "grid text";' };
  const raw = annotateUnit(unit, { target: 'raw' });
  const stripped = annotateUnit(unit, { target: 'stripped' });
  check('raw keeps comment words', raw.words.includes('walkable'), raw.words.join(','));
  check('stripped drops comment words', !stripped.words.includes('walkable'), stripped.words.join(','));
  check('raw keeps quoted words', raw.words.includes('text'), raw.words.join(','));
}

section('shape and summary are refused rather than faked');
{
  const unit = { path: 'x.js', name: 'f', startLine: 1, text: 'function f() { return 1; }' };
  for (const target of ['shape', 'summary']) {
    const out = annotateUnit(unit, { target });
    check(`${target} reports mappable false`, out.mappable === false && out.spans.length === 0);
  }
}

section('the region scanner agrees with the extractor mask');
{
  // Two independent implementations of the same idea. Where they disagree, the overlay lies.
  const files = fs.readdirSync('.').filter((f) => /\.(js|mjs)$/.test(f)).slice(0, 120);
  let mismatches = 0;
  let worst = null;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const mask = maskNonCode(src);
    const regions = nonCodeRegions(src);
    const blanked = new Uint8Array(src.length);
    for (const r of regions) for (let i = r.start; i < r.end; i++) blanked[i] = 1;
    for (let i = 0; i < src.length; i++) {
      // Newlines survive masking so line numbers stay aligned; skip them.
      if (src[i] === '\n') continue;
      // Inside a region the mask must hold a space; outside, the original character.
      const agrees = blanked[i] ? mask[i] === ' ' : mask[i] === src[i];
      if (!agrees) {
        mismatches++;
        if (!worst) worst = `${f}@${i}: ${JSON.stringify(src.slice(Math.max(0, i - 25), i + 25))}`;
        break;
      }
    }
  }
  check('scanner and mask agree on every scanned file', mismatches === 0,
    `${mismatches} of ${files.length} files differ; first: ${worst}`);
}

section('span words equal the real pipeline output, across the repo');
{
  const files = fs.readdirSync('.').filter((f) => /\.(js|mjs)$/.test(f));
  for (const target of ['raw', 'stripped', 'identifiers']) {
    let checked = 0, bad = 0, firstBad = null;
    for (const f of files.slice(0, 150)) {
      const src = fs.readFileSync(f, 'utf8');
      const units = extractUnits([{ path: f, text: src }], { unit: 'function' });
      for (const u of units) {
        const viaSpans = annotateUnit(u, { target }).words;
        const viaPipeline = representUnit(u, { target }).tokens;
        checked++;
        if (viaSpans.join('|') !== viaPipeline.join('|')) {
          bad++;
          if (!firstBad) {
            const n = Math.min(viaSpans.length, viaPipeline.length);
            let at = 0;
            while (at < n && viaSpans[at] === viaPipeline[at]) at++;
            firstBad = `${u.id} at word ${at}: overlay ${JSON.stringify(viaSpans.slice(at, at + 4))} vs pipeline ${JSON.stringify(viaPipeline.slice(at, at + 4))}`;
          }
        }
      }
    }
    check(`${target}: overlay matches the pipeline on all ${checked} pieces`, bad === 0,
      `${bad} mismatched; first: ${firstBad}`);
  }
}

section('coverage gaps');
{
  const src = [
    'const top = 1;',       // 1  uncovered
    '',                     // 2  blank
    'function a() {',       // 3
    '  return 1;',          // 4
    '}',                    // 5
    'const between = 2;',   // 6  uncovered
    'function b() {',       // 7
    '  return 2;',          // 8
    '}',                    // 9
  ].join('\n');
  const units = splitFunctions(src, 'demo.js');
  const cov = coverageGaps(src, units);
  check('finds both uncovered runs', cov.gaps.length === 2, JSON.stringify(cov.gaps));
  check('counts uncovered non-blank lines', cov.uncoveredLines === 2, String(cov.uncoveredLines));
  check('counts blank lines separately', cov.blankLines === 1, String(cov.blankLines));
  check('total lines is right', cov.totalLines === 9, String(cov.totalLines));

  const whole = coverageGaps(src, [{ startLine: 1, text: src }]);
  check('full coverage leaves no gaps', whole.gaps.length === 0 && whole.uncoveredLines === 0);
}

section('coverage on a real file');
{
  const src = fs.readFileSync('nav-grid.js', 'utf8');
  const units = extractUnits([{ path: 'nav-grid.js', text: src }], { unit: 'function' });
  const cov = coverageGaps(src, units);
  check('real file reports a plausible coverage figure',
    cov.uncoveredLines >= 0 && cov.uncoveredLines < cov.totalLines, JSON.stringify(cov));
  console.log(`  nav-grid.js: ${units.length} pieces, ${cov.totalLines} lines, ` +
    `${cov.uncoveredLines} not inside any piece, ${cov.gaps.length} gaps`);
}

section('step 3: the weight table matches the real vectors');
{
  const files = fs.readdirSync('.').filter((f) => /\.(js|mjs)$/.test(f) && !/^test-/.test(f)).slice(0, 120);
  const units = extractUnits(files.map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') })), { unit: 'function' });
  const docs = units.map((u) => representUnit(u, { target: 'stripped' }));
  const emb = embedDocs(docs, { embedder: 'tfidf', minDocFreq: 2, maxVocab: 4000 });
  const words = reverseVocab(emb.vocab);

  check('reverse vocab covers every index', words.every((w) => typeof w === 'string'));
  check('vocab is ordered by how many pieces use the word',
    words.slice(0, 200).every((w, i, a) => i === 0 || emb.docFreq.get(a[i - 1]) >= emb.docFreq.get(w)));

  let bad = 0, accounted = 0, firstBad = null;
  const sample = Math.min(docs.length, 400);
  for (let i = 0; i < sample; i++) {
    const ex = explainRow(docs[i], emb.rows[i], emb, { minDocFreq: 2 });
    // Every weight shown must be the weight actually stored in the sparse row.
    const fromRow = new Map();
    for (let e = 0; e < emb.rows[i].idx.length; e++) fromRow.set(words[emb.rows[i].idx[e]], emb.rows[i].val[e]);
    for (const r of ex.rows) {
      if (fromRow.get(r.word) !== r.weight) {
        bad++;
        if (!firstBad) firstBad = `${docs[i].id}: ${r.word} shows ${r.weight}, row holds ${fromRow.get(r.word)}`;
      }
    }
    if (ex.rows.length + ex.truncated + ex.missing.length === ex.distinctWords) accounted++;
  }
  check('every weight shown is the weight actually stored', bad === 0, firstBad || '');
  check('became-a-number plus did-not accounts for every distinct word',
    accounted === sample, `${accounted} of ${sample}`);

  const ex = explainRow(docs[0], emb.rows[0], emb, { minDocFreq: 2 });
  check('table is sorted heaviest first', ex.rows.every((r, i, a) => i === 0 || a[i - 1].weight >= r.weight));
  check('each missing word carries a named reason',
    ex.missing.every((m) => ['rare', 'common', 'cap'].includes(m.why)));
  check('the reason counts add up to the missing list',
    ex.counts.rare + ex.counts.common + ex.counts.cap === ex.missing.length, JSON.stringify(ex.counts));

  const vs = vocabSummary(emb);
  check('vocab summary accounts for every distinct word',
    vs.kept + vs.tooRare + vs.tooCommon + vs.overCap === vs.total, JSON.stringify(vs));
  console.log(`  ${docs.length} pieces, ${vs.total} different words -> ${vs.kept} kept ` +
    `(${vs.tooRare} too rare, ${vs.tooCommon} too common, ${vs.overCap} over the cap)`);

  // hashing has no vocabulary, so the viewer must say so rather than invent a table.
  const hashed = embedDocs(docs, { embedder: 'hashing', dims: 64 });
  check('hashing reports that it has no word-level story',
    explainRow(docs[0], hashed.rows[0], hashed).unsupported === true);
}

section('step 3: the matrix view is honest about what it caps');
{
  const files = fs.readdirSync('.').filter((f) => /\.(js|mjs)$/.test(f)).slice(0, 150);
  const units = extractUnits(files.map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') })), { unit: 'function' });
  const docs = units.map((u) => representUnit(u, { target: 'stripped' }));
  const emb = embedDocs(docs, { embedder: 'tfidf' });

  const pts = matrixPoints(emb, { maxPieces: 200, maxWords: 100, maxPoints: 50000 });
  check('point arrays are the same length', pts.x.length === pts.y.length && pts.x.length === pts.w.length);
  check('no point falls outside the shown window',
    [...pts.x].every((v) => v < pts.shownWords) && [...pts.y].every((v) => v < pts.shownPieces),
    `words<${pts.shownWords} pieces<${pts.shownPieces}`);
  check('it reports the piece stride it used', pts.pieceStride >= 1);
  check('it reports totals as well as what is shown',
    pts.totalPieces >= pts.shownPieces && pts.totalWords >= pts.shownWords);
  check('fill percentage is a sane fraction', pts.fillPercent > 0 && pts.fillPercent <= 100, String(pts.fillPercent));
  console.log(`  matrix: ${pts.shownPieces} of ${pts.totalPieces} pieces x ` +
    `${pts.shownWords} of ${pts.totalWords} words, ${pts.x.length} filled cells ` +
    `(${pts.fillPercent.toFixed(1)}%), stride ${pts.pieceStride}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
