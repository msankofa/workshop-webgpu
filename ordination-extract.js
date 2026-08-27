// Stage 1 of the code-ordination pipeline: a corpus of files becomes a flat list of units.
// Pure and THREE-free so test-ordination.mjs can run the whole splitter in Node.

const BACKSLASH = String.fromCharCode(92);

/** Blank out comments, strings and regex literals so a regex can scan structure without false hits. */
export function maskNonCode(src) {
  const out = new Array(src.length);
  const n = src.length;
  let i = 0;
  let prevCode = ''; // last significant code char, so `/` reads as divide vs regex start
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out[i] = ' '; i++;
      while (i < n) {
        if (src[i] === BACKSLASH) {
          out[i] = ' ';
          if (i + 1 < n) out[i + 1] = src[i + 1] === '\n' ? '\n' : ' ';
          i += 2;
          continue;
        }
        if (src[i] === quote) { out[i] = ' '; i++; break; }
        // Template holes hold real code, so leave them visible to the scanner.
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          out[i] = ' '; out[i + 1] = ' '; i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            out[i] = depth === 0 ? ' ' : src[i];
            i++;
          }
          continue;
        }
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      prevCode = quote;
      continue;
    }
    if (c === '/' && canStartRegex(prevCode)) {
      out[i] = ' '; i++;
      while (i < n && src[i] !== '\n') {
        if (src[i] === BACKSLASH) { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === '[') { // a `/` inside a character class is literal
          while (i < n && src[i] !== ']' && src[i] !== '\n') { out[i] = ' '; i++; }
        }
        if (src[i] === '/') { out[i] = ' '; i++; break; }
        out[i] = ' '; i++;
      }
      while (i < n && /[a-z]/.test(src[i])) { out[i] = ' '; i++; } // flags
      prevCode = '/';
      continue;
    }
    out[i] = c;
    if (!/\s/.test(c)) prevCode = c;
    i++;
  }
  return out.join('');
}

// After these a `/` opens a regex; after an identifier, `)` or a literal it is division.
const REGEX_OPENERS = '(,=:[!&|?{};+-*%~^<>';
function canStartRegex(prev) {
  return prev === '' || REGEX_OPENERS.includes(prev);
}

/** Index of the brace matching the one at `open`, scanning the masked source. */
export function matchBrace(mask, open) {
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    if (mask[i] === '{') depth++;
    else if (mask[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const DECL_RE = new RegExp([
  String.raw`(?:^|\n)[\t ]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)`,
  String.raw`(?:^|\n)[\t ]*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)`,
  String.raw`(?:^|\n)[\t ]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\*?\s*[\w$]*\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?:=>)?\s*\{`,
].join('|'), 'g');

/**
 * First `{` that opens a body, skipping balanced parens so a destructured parameter
 * (`function f({ a, b })`) is not mistaken for the body brace.
 */
export function bodyBraceFrom(mask, from) {
  for (let i = from; i < mask.length; i++) {
    const c = mask[i];
    if (c === '(') {
      let depth = 0;
      for (; i < mask.length; i++) {
        if (mask[i] === '(') depth++;
        else if (mask[i] === ')') { depth--; if (depth === 0) break; }
      }
      continue;
    }
    if (c === '{') return i;
    if (c === ';' || c === ')') return -1; // declaration ended without a body
  }
  return -1;
}

/** Split one file into function/class units. A regex over masked source, not a real parser. */
export function splitFunctions(src, path) {
  const mask = maskNonCode(src);
  const units = [];
  DECL_RE.lastIndex = 0;
  let m;
  while ((m = DECL_RE.exec(mask)) !== null) {
    const name = m[1] || m[2] || m[3];
    const declStart = m.index + (mask[m.index] === '\n' ? 1 : 0);
    // Branch 3 already consumed the body brace; branches 1 and 2 stop at the name.
    const brace = m[3] !== undefined
      ? m.index + m[0].length - 1
      : bodyBraceFrom(mask, m.index + m[0].length);
    if (brace < 0) continue;
    const close = matchBrace(mask, brace);
    if (close < 0) continue;
    units.push({
      id: path + '#' + name,
      path,
      name,
      text: src.slice(declStart, close + 1),
      startLine: lineAt(src, declStart),
    });
    DECL_RE.lastIndex = close; // never descend into a body already captured
  }
  return units;
}

/** Split one file into fixed line windows. */
export function splitChunks(src, path, lines = 60) {
  const all = src.split('\n');
  const units = [];
  for (let i = 0; i < all.length; i += lines) {
    const text = all.slice(i, i + lines).join('\n');
    if (!text.trim()) continue;
    units.push({ id: path + '@' + (i + 1), path, name: 'L' + (i + 1), text, startLine: i + 1 });
  }
  return units;
}

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === '\n') line++;
  return line;
}

/** Corpus ({path, text} list) to units. `minChars` drops trivia that would swamp neighbour lists. */
export function extractUnits(corpus, { unit = 'file', chunkLines = 60, minChars = 120 } = {}) {
  const out = [];
  for (const file of corpus) {
    if (unit === 'file') {
      out.push({ id: file.path, path: file.path, name: file.path, text: file.text, startLine: 1 });
    } else if (unit === 'function') {
      out.push(...splitFunctions(file.text, file.path));
    } else if (unit === 'chunk') {
      out.push(...splitChunks(file.text, file.path, chunkLines));
    } else {
      throw new Error('unknown unit: ' + unit);
    }
  }
  return out.filter((u) => u.text.length >= minChars);
}
