// Prints bot-state-code.js's legal space to docs/subsystems/bot-state-table.{md,csv}; never hand-edit those.
// Run: node gen-bot-state-table.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STATE_CHARS, STATE_NAMES, STATE_CLASSES, SLOTS, RULES, CODE_LENGTH, CORE_LENGTH,
  enumerateLegalCodes, enumerateCoreStates,
} from './bot-state-code.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'docs', 'subsystems');
const MD_PATH = join(OUT_DIR, 'bot-state-table.md');
const CSV_PATH = join(OUT_DIR, 'bot-state-table.csv');

const legal = enumerateLegalCodes();
const rows = enumerateCoreStates();

const rawProduct = SLOTS.reduce((n, s) => n * s.chars.length, 1);
const legalPct = (legal.length / rawProduct) * 100;

// Named slot subsets a trace can be bucketed by, coarsest first.
const PROJECTIONS = [
  ['state class', [], 'the coarse verb: idle/search/engage/survive/defend/support/terminal'],
  ['state', [1], 'slot 1 alone: which FSM rung'],
  ['state + role', [1, 4], 'rung x rifleman/medic'],
  ['state + tier', [1, 2], 'rung x how alarmed'],
  ['state + latches', [1, 9], 'rung x which commits are held'],
  ['alert triple', [2, 3, 5], 'the alert subsystem on its own: tier, score, push element'],
  ['core minus latches', [1, 2, 4, 5], 'the core without commit bits'],
  ['core', [1, 2, 4, 5, 9], 'the behavioural core: what and why, resources dropped'],
  ['core + ammo', [1, 2, 4, 5, 6, 9], 'core plus the one resource that gates the weapon rungs'],
  ['core + all resources', [1, 2, 4, 5, 6, 7, 8, 9], 'everything except the escalation score'],
  ['full code', [1, 2, 3, 4, 5, 6, 7, 8, 9], 'all nine slots'],
];

function projectionSize(slots) {
  if (!slots.length) return new Set(legal.map(c => STATE_CLASSES[c[0]])).size;
  const idx = slots.map(s => s - 1);
  return new Set(legal.map(c => idx.map(i => c[i]).join(''))).size;
}
const projRows = PROJECTIONS.map(([name, slots, note]) => ({
  name, slots: slots.length ? slots.join(',') : '--', note, count: projectionSize(slots),
}));

// Per-state fan-out: core rows vs. the full codes that project onto them.
const coreByState = new Map(), fullByState = new Map();
for (const r of rows) coreByState.set(r.state, (coreByState.get(r.state) || 0) + 1);
for (const c of legal) fullByState.set(c[0], (fullByState.get(c[0]) || 0) + 1);

const N = n => n.toLocaleString('en-US');
const esc = s => String(s).replace(/\|/g, '\\|');
const csvCell = s => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
const table = (head, body) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map(r => `| ${r.join(' | ')} |`)].join('\n');

const md = `# Bot state codes — generated reference table

<!-- GENERATED FILE — do not edit by hand. Run \`node gen-bot-state-table.mjs\` to rebuild. -->

Source of truth: \`bot-state-code.js\`. Prose, slot semantics and the legality rules live in
[\`bot-state-codes.md\`](bot-state-codes.md); this file is only the enumeration.
Machine-readable copy: [\`bot-state-table.csv\`](bot-state-table.csv).

## Counts

| Quantity | Value |
|---|---|
| Slot alphabets (product of all nine) | ${N(rawProduct)} |
| Legal ${CODE_LENGTH}-char codes | ${N(legal.length)} |
| Legal share of the raw product | ${legalPct.toFixed(3)}% |
| Legality rules applied | ${RULES.length} |
| Distinct ${CORE_LENGTH}-char core states | ${N(rows.length)} |
| Full codes per core state (min / max) | ${Math.min(...rows.map(r => r.fullCodes))} / ${N(Math.max(...rows.map(r => r.fullCodes)))} |

Slot alphabet sizes: ${SLOTS.map(s => `${s.index} ${s.key} ${s.chars.length}`).join(', ')}.

## Projections

Pick the coarsest resolution that still shows the pathology you are hunting.

${table(['Projection', 'Slots', 'Distinct values', 'What it answers'],
  projRows.map(p => [esc(p.name), p.slots, N(p.count), esc(p.note)]))}

## Fan-out by state

${table(['State', 'Class', 'Core rows', 'Legal full codes'],
  [...STATE_CHARS].map(ch => [
    STATE_NAMES[ch], STATE_CLASSES[ch],
    N(coreByState.get(STATE_NAMES[ch]) || 0), N(fullByState.get(ch) || 0),
  ]))}

## Core states (${N(rows.length)})

${table(['#', 'Core', 'State', 'Class', 'Tier', 'Role', 'Element', 'Latches', 'Full codes', 'Reading'],
  rows.map(r => [
    r.n, `\`${r.code}\``, r.state, r.class, r.tier, r.role, r.element,
    r.latches.length ? r.latches.join('+') : '--', N(r.fullCodes), esc(r.reading),
  ]))}
`;

const csv = [
  ['n', 'core', 'state', 'class', 'tier', 'role', 'element', 'latches', 'full_codes', 'reading'],
  ...rows.map(r => [r.n, r.code, r.state, r.class, r.tier, r.role, r.element,
    r.latches.join('+'), r.fullCodes, r.reading]),
].map(cols => cols.map(csvCell).join(',')).join('\n') + '\n';

writeFileSync(MD_PATH, md);
writeFileSync(CSV_PATH, csv);

console.log(`bot-state-table: ${N(rows.length)} core states from ${N(legal.length)} legal codes `
  + `(${legalPct.toFixed(3)}% of ${N(rawProduct)}), ${RULES.length} rules`);
for (const p of projRows) console.log(`  ${p.name.padEnd(21)} ${String(p.count).padStart(8)}`);
console.log(`wrote ${MD_PATH}`);
console.log(`wrote ${CSV_PATH}`);
