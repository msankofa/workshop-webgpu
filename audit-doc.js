// audit-doc.js — pure parser for the improve-webgpu audit doc shape. No DOM, no dependencies.
// Contract: docs/superpowers/reviews/2026-08-28-base-game-trees-audit.md "About this document".

// Splits scalar text into typed values: booleans, null, numbers, inline arrays, quoted strings.
function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return undefined;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map(part => parseScalar(part));
  }
  if (/^"(.*)"$/.test(s)) return s.slice(1, -1);
  if (/^'(.*)'$/.test(s)) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// Splits "key: value" (or bare "key:") on the FIRST colon; value may itself contain colons.
function splitKeyValue(content) {
  const idx = content.indexOf(':');
  if (idx === -1) return null;
  return { key: content.slice(0, idx).trim(), rest: content.slice(idx + 1) };
}

// Minimal hand-rolled YAML reader: top-level scalars, nested maps, lists of maps, inline arrays.
export function parseYamlBlock(text) {
  const lines = [];
  for (const raw of String(text ?? '').split('\n')) {
    if (raw.trim() === '') continue;
    lines.push({ indent: raw.length - raw.trimStart().length, content: raw.trim() });
  }
  let i = 0;

  function parseListOfMaps(itemIndent) {
    const list = [];
    const contentIndent = itemIndent + 2;
    while (i < lines.length && lines[i].indent === itemIndent && lines[i].content.startsWith('- ')) {
      const item = {};
      const kv = splitKeyValue(lines[i].content.slice(2));
      if (kv) item[kv.key] = parseScalar(kv.rest);
      i++;
      while (i < lines.length && lines[i].indent === contentIndent) {
        const kv2 = splitKeyValue(lines[i].content);
        if (kv2) item[kv2.key] = parseScalar(kv2.rest);
        i++;
      }
      list.push(item);
    }
    return list;
  }

  function parseMapAt(baseIndent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === baseIndent) {
      const kv = splitKeyValue(lines[i].content);
      if (!kv) { i++; continue; }
      i++;
      if (kv.rest.trim() !== '') {
        obj[kv.key] = parseScalar(kv.rest);
        continue;
      }
      if (i < lines.length && lines[i].indent > baseIndent) {
        obj[kv.key] = lines[i].content.startsWith('- ')
          ? parseListOfMaps(lines[i].indent)
          : parseMapAt(lines[i].indent);
      } else {
        obj[kv.key] = undefined;
      }
    }
    return obj;
  }

  return parseMapAt(0);
}

// Frontmatter is a "---" fenced YAML block at the very top of the document.
function splitFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  return { meta: parseYamlBlock(m[1]), body: text.slice(m[0].length) };
}

// Splits markdown body on "#"/"##" heading lines, returning ordered {level, heading, text} chunks.
function splitSections(body) {
  const headingRe = /^(#{1,2})[ \t]+(.*)$/gm;
  const matches = [...body.matchAll(headingRe)];
  const sections = [];
  const firstStart = matches.length ? matches[0].index : body.length;
  const lead = body.slice(0, firstStart).trim();
  if (lead) sections.push({ level: 0, heading: null, text: lead });
  for (let idx = 0; idx < matches.length; idx++) {
    const level = matches[idx][1].length;
    const heading = matches[idx][2].trim();
    const start = matches[idx].index + matches[idx][0].length;
    const end = idx + 1 < matches.length ? matches[idx + 1].index : body.length;
    sections.push({ level, heading, text: body.slice(start, end).trim() });
  }
  return sections;
}

// Splits a finding's body (after its yaml block) into named "### Heading" sections, lowercased.
function parseFourPart(text) {
  const re = /^###[ \t]+(.*)$/gm;
  const matches = [...text.matchAll(re)];
  const map = {};
  for (let idx = 0; idx < matches.length; idx++) {
    const heading = matches[idx][1].trim().toLowerCase();
    const start = matches[idx].index + matches[idx][0].length;
    const end = idx + 1 < matches.length ? matches[idx + 1].index : text.length;
    map[heading] = text.slice(start, end).trim();
  }
  return map;
}

const FINDING_HEADING_RE = /^(F-\d+)\s*(?:[-—]+\s*)?(.*)$/;

// Parses one "## F-NN — Title" section into a finding record; degrades to undefined, never throws.
function parseFinding(headingText, sectionText) {
  const m = FINDING_HEADING_RE.exec(headingText) || [];
  const idFromHeading = m[1];
  const titleFromHeading = m[2];

  const yamlMatch = /```yaml\r?\n([\s\S]*?)\r?\n```/.exec(sectionText);
  const meta = yamlMatch ? parseYamlBlock(yamlMatch[1]) : {};
  const remainder = yamlMatch ? sectionText.slice(yamlMatch.index + yamlMatch[0].length) : sectionText;
  const parts = parseFourPart(remainder);

  return {
    ...meta,
    id: meta.id || idFromHeading,
    title: meta.title || titleFromHeading || undefined,
    locations: meta.locations || [],
    cause: parts.cause,
    effect: parts.effect,
    solution: parts.solution,
    result: parts.result,
  };
}

// Parses a full audit doc's markdown text into { meta, findings, prose }.
export function parseAuditDoc(markdownText) {
  const text = String(markdownText ?? '');
  const { meta, body } = splitFrontmatter(text);
  const sections = splitSections(body);
  const findings = [];
  const prose = [];
  for (const sec of sections) {
    const isFinding = sec.level === 2 && sec.heading && /^F-\d+\b/.test(sec.heading);
    if (isFinding) findings.push(parseFinding(sec.heading, sec.text));
    else prose.push(sec);
  }
  return { meta, findings, prose };
}
