// Every control in the panel should explain itself on hover. Nothing enforces that on its own --
// a button with no `title` looks identical in the code to one with a title, so the gap is invisible
// until someone hovers. Half the panel (71 of 146 controls) was bare before 2026-08-06.
//
// This lists every control the panel creates and fails on any without hover text.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = 'bot-viewer-v3.html';   // v2 is a frozen snapshot; v3 is the live harness
const src = fs.readFileSync(path.join(here, VIEWER), 'utf8');
const lines = src.split('\n');

const START = lines.findIndex(l => l.includes('const SECTION_PLAN'));
const END = lines.findIndex(l => l.includes('function captureMazeState'));
const panel = lines.slice(START, END).join('\n');

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
};

check('panel region located', START > 0 && END > START);

// Controls held in a named variable. Anonymous ones built inside a factory are covered by the
// factory checks below instead.
const created = new Map();
for (let i = START; i < END; i++) {
  const m = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\('(button|input|select|textarea)'\)/.exec(lines[i]);
  if (m) created.set(m[1], { line: i + 1, tag: m[2] });
}

const titled = new Set();
for (const m of panel.matchAll(/([A-Za-z_$][\w$]*)\.title\s*=/g)) titled.add(m[1]);
for (const m of panel.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.assign|el)\([^)]*title:/g)) titled.add(m[1]);

console.log('\nhover text');
check('the panel still builds the controls we expect', created.size > 100, `found ${created.size}`);

// `title` inherits to descendants, so a slider inside a titled row is covered by that row — which
// is the idiom the slider factories use deliberately, to make the label and value hover too.
const stemOf = (n) => n.replace(/(Btn|Input|Select|Sel|View|Toggle|Row)$/, '');
const titledStems = new Set([...titled].map(stemOf));

const bare = [...created]
  .filter(([name]) => !titled.has(name) && !titledStems.has(stemOf(name)))
  .map(([name, info]) => `${name} (${info.tag}, ${VIEWER}:${info.line})`);
check('every named control has hover text', bare.length === 0,
  bare.length ? `no title set on:\n       ${bare.join('\n       ')}` : '');

// Controls built by a shared factory: the factory must take a tooltip and apply it, or every
// control it produces is bare at once. That is how all 12 Movement tuning sliders came to have none.
console.log('\ncontrol factories');
const FACTORIES = [
  'createBotMovementSlider', 'createBotAimSlider', 'createGrenadeSlider',
  'createBotStanceSlider', 'createBotStanceToggle', 'chatterSliderRow',
  'makeTerrainSlider', 'makeTerrainSelect', 'makeTerrainToggle', 'mazeIntInput',
];
for (const fn of FACTORIES) {
  const at = src.indexOf(`function ${fn}(`);
  if (at === -1) { check(`${fn} exists`, false, 'factory not found — renamed?'); continue; }
  const sig = src.slice(at, src.indexOf(')', at));
  const body = src.slice(at, src.indexOf('\n}', at));
  check(`${fn} takes a tooltip and applies it`,
    /\btitle\b/.test(sig) && /\.title\s*=\s*title/.test(body));
}

// Spec tables feed those factories positionally, so a row can still omit its tooltip.
console.log('\nspec table rows');
const STR = /'(?:[^'\\]|\\.)*'/g;
const TABLES = [
  ['Movement tuning', 'botMovementSliderSpecs', 3],
  ['Music FX', 'AUDIO_EFFECT_DEFS', 3],
];
for (const [card, anchor, minStrings] of TABLES) {
  const at = lines.findIndex(l => l.includes(`const ${anchor}`));
  if (at === -1) { check(`${card} table found`, false, `no const ${anchor}`); continue; }
  let end = at;
  while (end < lines.length && !/^\s*\];/.test(lines[end])) end++;
  const rows = [];
  for (let i = at; i <= end; i++) {
    if (!/^\s*\[/.test(lines[i])) continue;
    // a row may wrap, so count strings until the row closes
    let text = lines[i], j = i;
    while (!/\],?\s*$/.test(text) && j < end) text += lines[++j];
    rows.push({ line: i + 1, strings: (text.match(STR) || []).length });
  }
  const short = rows.filter(r => r.strings < minStrings).map(r => `${VIEWER}:${r.line}`);
  check(`${card}: every row carries a tooltip (${rows.length} rows)`, short.length === 0, short.join(', '));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
