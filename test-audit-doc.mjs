// test-audit-doc.mjs — audit-doc.js against the real tree-audit document plus parser edge cases.
//
// node test-audit-doc.mjs

import fs from 'node:fs';
import { parseAuditDoc, parseYamlBlock } from './audit-doc.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

const DOC_PATH = 'docs/superpowers/reviews/2026-08-28-base-game-trees-audit.md';
const rawText = fs.readFileSync(DOC_PATH, 'utf8');
const { meta, findings, prose } = parseAuditDoc(rawText);

section('frontmatter, read from the real document');
{
  check('title', meta.title === 'Base Game trees — WebGPU audit');
  check('page', meta.page === 'base-game.html');
  check('subsystem', meta.subsystem === 'vegetation');
  check('date', meta.date === '2026-08-28');
  check('the findings count field matches the findings present',
  meta.findings === findings.length,
  `frontmatter says ${meta.findings}, document holds ${findings.length}`);
  check('steps_complete is a number array', Array.isArray(meta.steps_complete) && meta.steps_complete.every(n => typeof n === 'number'),
    JSON.stringify(meta.steps_complete));
  check('steps_partial surfaced', Array.isArray(meta.steps_partial) && meta.steps_partial.join(',') === '2,5,6');
  check('steps_not_run surfaced', Array.isArray(meta.steps_not_run) && meta.steps_not_run.join(',') === '4');
}

section('every finding in the real document');
{
  check('every finding parsed', findings.length > 0 && findings.every(f => f.id),
  `${findings.length} findings`);
  const ids = findings.map(f => f.id);
  check('ids are unique and ascending',
  (() => {
    const n = findings.map(f => Number(f.id.slice(2)));
    return new Set(n).size === n.length && n.every((v, i) => i === 0 || v > n[i - 1]);
  })(), findings.map(f => f.id).join(','));

  const SEVERITIES = new Set(['high', 'medium', 'low', 'info']);
  const STATUSES = new Set(['fixed', 'deferred', 'open', 'unverified']);
  const KINDS = new Set(['defect', 'regression', 'gap', 'test-gap', 'observation']);
  const INTRODUCED_BY = new Set(['this-work', 'donor', 'pre-existing']);
  check('every severity is in the vocabulary', findings.every(f => SEVERITIES.has(f.severity)),
    findings.filter(f => !SEVERITIES.has(f.severity)).map(f => f.id).join(','));
  check('every status is in the vocabulary', findings.every(f => STATUSES.has(f.status)),
    findings.filter(f => !STATUSES.has(f.status)).map(f => f.id).join(','));
  check('every kind is in the vocabulary', findings.every(f => KINDS.has(f.kind)),
    findings.filter(f => !KINDS.has(f.kind)).map(f => f.id).join(','));
  check('every introduced_by is in the vocabulary', findings.every(f => INTRODUCED_BY.has(f.introduced_by)),
    findings.filter(f => !INTRODUCED_BY.has(f.introduced_by)).map(f => f.id).join(','));

  check('every finding has all four narrative sections', findings.every(f => f.cause && f.effect && f.solution && f.result),
    findings.filter(f => !(f.cause && f.effect && f.solution && f.result)).map(f => f.id).join(','));
  check('every finding has a title', findings.every(f => typeof f.title === 'string' && f.title.length > 0));
  check('every finding has a locations array (possibly empty)', findings.every(f => Array.isArray(f.locations)));
  check('every finding has a mutation_tested boolean', findings.every(f => typeof f.mutation_tested === 'boolean'));

  const severityTally = {};
  const statusTally = {};
  for (const f of findings) {
    severityTally[f.severity] = (severityTally[f.severity] || 0) + 1;
    statusTally[f.status] = (statusTally[f.status] || 0) + 1;
  }
  check('per-finding severity tally matches the frontmatter rollup',
    JSON.stringify(severityTally) === JSON.stringify(meta.severity_counts) ||
    Object.keys(meta.severity_counts).every(k => severityTally[k] === meta.severity_counts[k]),
    `${JSON.stringify(severityTally)} vs ${JSON.stringify(meta.severity_counts)}`);
  check('per-finding status tally matches the frontmatter rollup',
    Object.keys(meta.status_counts).every(k => statusTally[k] === meta.status_counts[k]),
    `${JSON.stringify(statusTally)} vs ${JSON.stringify(meta.status_counts)}`);
}

section('spot checks on specific findings');
{
  const f01 = findings.find(f => f.id === 'F-01');
  check('F-01 title', f01.title === 'The frame loop scanned every tree instance');
  check('F-01 has three locations', f01.locations.length === 3);
  check('F-01 location fields', f01.locations[0].file === 'base-game-forest.js' && f01.locations[0].line === 239 &&
    f01.locations[0].symbol === 'syncStats');
  check('F-01 measured is a nested map with two keys', f01.measured.before && f01.measured.after);
  check('F-01 verified_by carries an embedded quote literally',
    f01.verified_by.includes('"twenty more frames run the instance scan zero times"'));

  const f04 = findings.find(f => f.id === 'F-04');
  check('F-04 status is deferred', f04.status === 'deferred');
  check('F-04 measured has three sibling keys', f04.measured.uploaded && f04.measured.distinct && f04.measured.waste);

  const f16 = findings.find(f => f.id === 'F-16');
  check('F-16 rows_at_risk is an inline array of four strings', Array.isArray(f16.rows_at_risk) && f16.rows_at_risk.length === 4,
    JSON.stringify(f16.rows_at_risk));
  check('F-16 carries the extra blocked_on field the vocab table does not list', typeof f16.blocked_on === 'string' && f16.blocked_on.length > 0);

  const f18 = findings.find(f => f.id === 'F-18');
  check('F-18 carries the extra prior_art field', typeof f18.prior_art === 'string' && f18.prior_art.includes('roads work'));

  const f20 = findings.find(f => f.id === 'F-20');
  check('F-20 quoted symbol strips its outer quotes',
    f20.locations[0].symbol === 'the forest builds and draws what placement found');

  const f21 = findings.find(f => f.id === 'F-21');
  check('F-21 measured has two sibling keys with slash-separated values', f21.measured.per_variant && f21.measured.per_rung);
}

section('prose keeps the intro readable, and steps_not_run is not buried');
{
  check('prose has at least the intro and the parse-contract section', prose.length >= 2, `${prose.length} sections`);
  check('the intro section is not itself mistaken for a finding', prose.every(p => !(p.heading && /^F-\d+\b/.test(p.heading))));
  const aboutSection = prose.find(p => p.heading === 'About this document');
  check('the "About this document" section is captured as prose', !!aboutSection && aboutSection.text.length > 0);
  check('steps_not_run is present on the parsed meta so a viewer cannot silently drop it',
    Array.isArray(meta.steps_not_run) && meta.steps_not_run.length === 1);
}

section('parseYamlBlock scalar and structural edge cases');
{
  check('inline arrays of numbers', JSON.stringify(parseYamlBlock('a: [1, 3]').a) === '[1,3]');
  check('inline arrays of bare words', JSON.stringify(parseYamlBlock('a: [x, y-z]').a) === '["x","y-z"]');
  check('booleans', parseYamlBlock('a: true\nb: false').a === true && parseYamlBlock('a: true\nb: false').b === false);
  check('null and tilde', parseYamlBlock('a: null\nb: ~').a === null && parseYamlBlock('a: null\nb: ~').b === null);
  check('a colon embedded in a quoted value survives', parseYamlBlock('a: "hi: there"').a === 'hi: there');
  check('a colon embedded in an unquoted value survives, split only on the first colon',
    parseYamlBlock('a: verified_by: none').a === 'verified_by: none');
  check('a nested map one level deep', (() => {
    const r = parseYamlBlock('measured:\n  before: 1\n  after: 2');
    return r.measured.before === 1 && r.measured.after === 2;
  })());
  check('a list of maps', (() => {
    const r = parseYamlBlock('locations:\n  - file: a.js\n    line: 1\n  - file: b.js\n    line: 2');
    return r.locations.length === 2 && r.locations[0].file === 'a.js' && r.locations[1].line === 2;
  })());
}

section('degrades to undefined instead of throwing on a half-written document');
{
  check('an empty string parses cleanly', (() => {
    const r = parseAuditDoc('');
    return r.meta && Array.isArray(r.findings) && r.findings.length === 0 && Array.isArray(r.prose);
  })());
  check('a document with no frontmatter still parses its body', (() => {
    const r = parseAuditDoc('# Just a title\n\nSome text.\n');
    return Object.keys(r.meta).length === 0 && r.prose.length >= 1;
  })());
  check('a finding heading with no yaml fence still parses, fields undefined', (() => {
    const r = parseAuditDoc('## F-01 — Untitled\n\nNo yaml block here at all.\n');
    const f = r.findings[0];
    return f.id === 'F-01' && f.severity === undefined && f.locations.length === 0 && f.cause === undefined;
  })());
  check('a finding missing some of the four sections leaves the rest undefined', (() => {
    const doc = '## F-02 — Half written\n\n```yaml\nid: F-02\nseverity: low\n```\n\n### Cause\n\nOnly this exists.\n';
    const f = parseAuditDoc(doc).findings[0];
    return f.severity === 'low' && f.cause === 'Only this exists.' && f.effect === undefined && f.solution === undefined;
  })());
  check('a heading that only looks like a finding id is rejected', (() => {
    const r = parseAuditDoc('## F-abc not a real finding\n\nprose.\n');
    return r.findings.length === 0 && r.prose.some(p => p.heading === 'F-abc not a real finding');
  })());
  check('a finding heading with no dash separator still splits id from title', (() => {
    const r = parseAuditDoc('## F-99 no dash at all\n\n```yaml\nid: F-99\n```\n');
    return r.findings[0].title === 'no dash at all';
  })());
  check('an unknown/missing top-level frontmatter field is undefined, not thrown', (() => {
    const r = parseAuditDoc('---\ntitle: Only a title\n---\n\nbody\n');
    return r.meta.title === 'Only a title' && r.meta.subsystem === undefined;
  })());
}

section('the frontmatter rollups agree with the findings');
{
  const tally = key => findings.reduce((a, f) => (a[f[key]] = (a[f[key]] || 0) + 1, a), {});
  for (const [field, key] of [['severity_counts', 'severity'], ['status_counts', 'status'], ['kind_counts', 'kind']]) {
    const declared = meta[field] || {};
    const actual = tally(key);
    const keys = new Set([...Object.keys(declared), ...Object.keys(actual)]);
    const wrong = [...keys].filter(k => (declared[k] || 0) !== (actual[k] || 0));
    check(`${field} matches the findings`, wrong.length === 0,
      wrong.map(k => `${k}: says ${declared[k] || 0}, is ${actual[k] || 0}`).join('; '));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
