// Stage 2 of the code-ordination pipeline: each unit's text becomes the token stream that
// gets embedded. The capture target decides WHAT similarity means; the preprocessing flags
// decide how much shared boilerplate is allowed to drown it out.

import { maskNonCode } from './ordination-extract.js';

export const CAPTURE_TARGETS = ['raw', 'stripped', 'identifiers', 'shape', 'summary'];

// Keywords carry no signal about what a unit does -- every file has them in similar proportion.
const JS_STOPWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'of', 'in',
  'new', 'this', 'null', 'undefined', 'true', 'false', 'export', 'import', 'from', 'default',
  'async', 'await', 'class', 'extends', 'typeof', 'instanceof', 'break', 'continue', 'try',
  'catch', 'finally', 'throw', 'switch', 'case', 'do', 'void', 'delete', 'yield', 'static',
  'get', 'set', 'length', 'push', 'math', 'the', 'a', 'is', 'to', 'and', 'it', 'that',
]);

const IMPORT_LINE = /^\s*(?:import\s.*?(?:;|$)|export\s+\{[^}]*\}\s*from\s.*?(?:;|$))/gm;

/** Comments and strings out, everything else kept. */
export function stripComments(src) {
  return maskNonCode(src);
}

/** Import/re-export lines out -- every module in a subsystem shares them, so they add no signal. */
export function stripImports(src) {
  return src.replace(IMPORT_LINE, '');
}

/** camelCase, PascalCase and snake_case identifiers into their word parts. */
export function splitIdentifier(word) {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** Identifier-ish tokens only, with numbers and one-character noise dropped. */
export function tokenize(text, { splitCase = true, lowercase = true, dropStopwords = true } = {}) {
  const words = text.match(/[A-Za-z_$][\w$]*/g) || [];
  const out = [];
  for (const w of words) {
    const parts = splitCase ? splitIdentifier(w) : [w];
    for (let p of parts) {
      if (lowercase) p = p.toLowerCase();
      if (p.length < 2) continue;
      if (dropStopwords && JS_STOPWORDS.has(p.toLowerCase())) continue;
      out.push(p);
    }
  }
  return out;
}

/**
 * Structural skeleton: identifiers collapse to `_`, so two units match when they have the
 * same control flow and call shape regardless of what they are named or what domain they serve.
 */
export function shapeTokens(text) {
  const mask = maskNonCode(text);
  const KEYWORDS = /\b(?:if|else|for|while|return|function|class|const|let|var|new|await|async|try|catch|switch|case|throw|=>)\b/;
  const tokens = mask.match(/[A-Za-z_$][\w$]*|=>|[(){}[\].,;=+\-*/%<>!&|?:]+/g) || [];
  const out = [];
  for (const t of tokens) {
    if (/^[A-Za-z_$]/.test(t)) out.push(KEYWORDS.test(t) ? t : '_');
    else out.push(t);
  }
  // Trigrams of the skeleton, so local structure rather than raw symbol counts is compared.
  const grams = [];
  for (let i = 0; i + 2 < out.length; i++) grams.push(out[i] + '|' + out[i + 1] + '|' + out[i + 2]);
  return grams;
}

/**
 * One unit to its token list.
 * `summary` needs a path -> prose map (code-map.html's hand-written descriptions, or any
 * LLM-generated blurbs); units with no summary come back empty and are reported, not silently kept.
 */
export function representUnit(unit, {
  target = 'stripped',
  stripImports: doStripImports = true,
  splitCase = true,
  lowercase = true,
  dropStopwords = true,
  maxTokens = 4000,
  summaries = null,
} = {}) {
  let text = unit.text;
  let tokens;

  if (target === 'summary') {
    const blurb = summaries ? summaries[unit.path] : null;
    tokens = blurb ? tokenize(blurb, { splitCase, lowercase, dropStopwords }) : [];
  } else if (target === 'shape') {
    tokens = shapeTokens(doStripImports ? stripImports(text) : text);
  } else {
    if (doStripImports) text = stripImports(text);
    if (target === 'stripped' || target === 'identifiers') text = stripComments(text);
    if (target === 'identifiers') {
      // Only the names being declared and called, not their surrounding syntax.
      text = (text.match(/[A-Za-z_$][\w$]*/g) || []).join(' ');
    }
    tokens = tokenize(text, { splitCase, lowercase, dropStopwords });
  }

  const truncated = tokens.length > maxTokens;
  return { id: unit.id, tokens: truncated ? tokens.slice(0, maxTokens) : tokens, truncated };
}

/** Represent every unit, reporting how many were empty or hit the token cap. */
export function representAll(units, options = {}) {
  const docs = units.map((u) => representUnit(u, options));
  return {
    docs,
    empty: docs.filter((d) => d.tokens.length === 0).length,
    truncated: docs.filter((d) => d.truncated).length,
  };
}
