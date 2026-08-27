// Span-level annotation for the step viewer.
//
// ordination-represent.js answers "which words came out of this piece". That is not enough to
// SHOW the step: to strike dropped text out in place you need to know which characters survived
// and why each one did not. This module produces that, covering the source with typed spans.
//
// The spans are only trustworthy if the words they imply are exactly the words the real
// pipeline produces, so test-ordination-steps.mjs checks that equality over the whole repo
// rather than trusting the two implementations to agree.

import { splitIdentifier } from './ordination-represent.js';

const BACKSLASH = String.fromCharCode(92);

// Kept in sync with ordination-represent.js's JS_STOPWORDS, which is not exported.
const JS_STOPWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'of', 'in',
  'new', 'this', 'null', 'undefined', 'true', 'false', 'export', 'import', 'from', 'default',
  'async', 'await', 'class', 'extends', 'typeof', 'instanceof', 'break', 'continue', 'try',
  'catch', 'finally', 'throw', 'switch', 'case', 'do', 'void', 'delete', 'yield', 'static',
  'get', 'set', 'length', 'push', 'math', 'the', 'a', 'is', 'to', 'and', 'it', 'that',
]);

const IMPORT_LINE = /^\s*(?:import\s.*?(?:;|$)|export\s+\{[^}]*\}\s*from\s.*?(?:;|$))/gm;

/**
 * Regions of the source that are not code: comments, string bodies and regex literals.
 * A template hole is code, so it is left out of the result on purpose.
 * Mirrors the scanner in ordination-extract.js; the test asserts the two agree character for
 * character rather than assuming they do.
 */
export function nonCodeRegions(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let prevCode = '';
  const push = (start, end, kind) => { if (end > start) out.push({ start, end, kind }); };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      push(start, i, 'comment');
      continue;
    }
    if (c === '/' && d === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      push(start, i, 'comment');
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let start = i;
      i++;
      while (i < n) {
        if (src[i] === BACKSLASH) { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          push(start, i, 'string');          // close the run before the hole
          push(i, i + 2, 'string');          // the ${ delimiter belongs to the literal
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {       // the hole itself is code, so nothing is pushed for it
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth === 0) push(i, i + 1, 'string');   // and so does the closing brace
            i++;
          }
          start = i;
          continue;
        }
        i++;
      }
      push(start, i, 'string');
      prevCode = quote;
      continue;
    }
    if (c === '/' && canStartRegex(prevCode)) {
      const start = i;
      i++;
      while (i < n && src[i] !== '\n') {
        if (src[i] === BACKSLASH) { i += 2; continue; }
        if (src[i] === '[') { while (i < n && src[i] !== ']' && src[i] !== '\n') i++; }
        if (src[i] === '/') { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;
      push(start, i, 'regex');
      prevCode = '/';
      continue;
    }
    if (!/\s/.test(c)) prevCode = c;
    i++;
  }
  return out;
}

const REGEX_OPENERS = '(,=:[!&|?{};+-*%~^<>';
function canStartRegex(prev) {
  return prev === '' || REGEX_OPENERS.includes(prev);
}

/** Character ranges covered by import / re-export lines. */
export function importRegions(src) {
  const out = [];
  IMPORT_LINE.lastIndex = 0;
  let m;
  while ((m = IMPORT_LINE.exec(src)) !== null) {
    if (m[0].length === 0) { IMPORT_LINE.lastIndex++; continue; }
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'import' });
  }
  return out;
}

function inAny(regions, pos) {
  for (const r of regions) if (pos >= r.start && pos < r.end) return r;
  return null;
}

export const REASONS = {
  import: 'import line',
  comment: 'comment',
  string: 'text in quotes',
  regex: 'pattern',
  keyword: 'keyword',
  short: 'under 2 characters',
  syntax: 'punctuation and numbers',
  cap: 'past the word cap',
};

/**
 * Cover a piece of source with spans saying what happened to every character.
 * Returns { spans, words, tally }. Each span is {start, end, text, kept, reason}, in order and
 * gap-free, so the viewer can render the original text with the dropped parts struck through.
 *
 * Only `raw`, `stripped` and `identifiers` map back onto the source this way. `shape` and
 * `summary` do not describe the source character by character, and callers are told so via
 * `mappable: false` rather than being handed a fabricated overlay.
 */
export function annotateUnit(unit, {
  target = 'stripped',
  stripImports = true,
  splitCase = true,
  lowercase = true,
  dropStopwords = true,
  maxTokens = 4000,
} = {}) {
  const src = unit.text;
  if (target === 'shape' || target === 'summary') {
    return { mappable: false, target, spans: [], words: [], tally: {} };
  }

  const imports = stripImports ? importRegions(src) : [];
  const nonCode = target === 'raw' ? [] : nonCodeRegions(src);

  const spans = [];
  const words = [];
  const tally = {};
  const bump = (reason) => { tally[reason] = (tally[reason] || 0) + 1; };
  const add = (start, end, kept, reason) => {
    if (end <= start) return;
    const last = spans[spans.length - 1];
    if (last && last.kept === kept && last.reason === reason && last.end === start) {
      last.end = end;
      last.text = src.slice(last.start, end);
      return;
    }
    spans.push({ start, end, text: src.slice(start, end), kept, reason });
  };

  let i = 0;
  while (i < src.length) {
    const imp = inAny(imports, i);
    if (imp) { add(i, imp.end, false, 'import'); bump('import'); i = imp.end; continue; }
    const nc = inAny(nonCode, i);
    if (nc) {
      const end = Math.min(nc.end, nextRegionStart(imports, i, nc.end));
      add(i, end, false, nc.kind);
      bump(nc.kind);
      i = end;
      continue;
    }
    // Plain code: identifiers become candidate words, everything else is syntax.
    const rest = src.slice(i);
    const m = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (m) {
      const word = m[0];
      const parts = splitCase ? splitIdentifier(word) : [word];
      let anyKept = false;
      let hitCap = false;
      for (let p of parts) {
        if (lowercase) p = p.toLowerCase();
        if (p.length < 2) { bump('short'); continue; }
        if (dropStopwords && JS_STOPWORDS.has(p.toLowerCase())) { bump('keyword'); continue; }
        // The real pipeline slices at maxTokens, so everything past it is genuinely unused.
        if (words.length >= maxTokens) { bump('cap'); hitCap = true; continue; }
        words.push(p);
        anyKept = true;
      }
      const reason = anyKept ? null : (hitCap ? 'cap' : (parts.length === 1 ? 'keyword' : 'short'));
      add(i, i + word.length, anyKept, reason);
      i += word.length;
      continue;
    }
    let j = i;
    while (j < src.length
      && !/[A-Za-z_$]/.test(src[j])
      && !inAny(imports, j)
      && !inAny(nonCode, j)) j++;
    if (j === i) j++;
    add(i, j, false, 'syntax');
    i = j;
  }

  return { mappable: true, target, spans, words, tally };
}

function nextRegionStart(regions, from, fallback) {
  let best = fallback;
  for (const r of regions) if (r.start > from && r.start < best) best = r.start;
  return best;
}

/** Dropped-reason counts as display rows, largest first. */
export function tallyRows(tally) {
  return Object.entries(tally)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => ({ reason, label: REASONS[reason] || reason, count: n }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Lines of a file that no extracted piece covers.
 * This is step 1's own check on itself: a splitter that quietly loses a function shows up here
 * as a gap, which is the thing worth looking at rather than the pieces that came out fine.
 */
export function coverageGaps(fileText, units) {
  const total = fileText.split('\n').length;
  const covered = new Uint8Array(total + 2);
  for (const u of units) {
    const lines = u.text.split('\n').length;
    for (let l = u.startLine; l < u.startLine + lines && l <= total; l++) covered[l] = 1;
  }
  const gaps = [];
  let run = null;
  for (let l = 1; l <= total; l++) {
    if (!covered[l]) {
      if (!run) run = { from: l, to: l };
      else run.to = l;
    } else if (run) { gaps.push(run); run = null; }
  }
  if (run) gaps.push(run);
  const blank = new Set();
  const srcLines = fileText.split('\n');
  let uncoveredLines = 0;
  for (const g of gaps) for (let l = g.from; l <= g.to; l++) {
    if (!srcLines[l - 1].trim()) blank.add(l);
    else uncoveredLines++;
  }
  return { gaps, totalLines: total, uncoveredLines, blankLines: blank.size };
}
