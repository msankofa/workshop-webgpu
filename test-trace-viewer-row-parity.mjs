// Extract the REAL parseTrace and ingestRow out of bot-trace-viewer.html and run both over the same
// logical row, so a shape drift between file mode and live mode fails here instead of on screen.
import fs from 'fs';
import { decodeBotState } from 'file:///G:/My Drive/Scripts/procedural-creature/workshop-webgpu/bot-state-code.js';

const base = 'G:/My Drive/Scripts/procedural-creature/workshop-webgpu/';
const src = fs.readFileSync(base + 'bot-trace-viewer.html', 'utf8');

function grab(name, startsWith) {
  const i = src.indexOf(startsWith);
  if (i < 0) throw new Error('not found: ' + name);
  // Brace-match from the function's opening brace.
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
const parseSrc = grab('parseTrace', 'function parseTrace(text)');
const ingestSrc = grab('ingestRow', 'function ingestRow(raw)');
const logEventSrc = grab('isLogEvent', 'function isLogEvent(r)');   // ingestRow calls it

// Shim the globals each function touches.
let hasMotion = false, bots = new Map(), allRows = [], tMin = Infinity, tMax = -Infinity, bounds = null;
const ctxObj = { decodeBotState };
const mk = new Function('decodeBotState', 'state', `
  let hasMotion = false;
  const bots = state.bots, allRows = state.allRows;
  let tMin = Infinity, tMax = -Infinity, bounds = null;
  // The live-log side of ingestRow is DOM output; this test is about row shape, so stub it.
  const logEntries = [], LOG_MAX_LINES = 500;
  const appendLogRow = () => {}, logEntryFor = (r) => r;
  ${logEventSrc}
  ${parseSrc}
  ${ingestSrc}
  return { parseTrace, ingestRow, snap: () => ({ tMin, tMax, bounds }) };
`);

const TSV_COLS = ['t_ms', 'bot_id', 'team', 'code', 'changed_slots', 'x', 'z', 'yaw_deg', 'speed',
  'moved', 'goal_dist', 'path_len', 'path_mode', 'squad_id', 'squad_rank', 'leader_id',
  'target_id', 'target_dist', 'vis_gate', 'nav_region', 'mag', 'reserve'];

// The game's in-memory row (field names from pushBotStateTraceRow + fillBotStateTraceMotion).
const gameRow = {
  t: 1234, id: 'bot-7', team: 'alpha', code: 'A34r-4420', changed: 'state+tier',
  x: 12.5, z: -3.25, yaw: 131, speed: 2.4, moved: 0.37, goalDist: 5.72, pathLen: 2,
  pathMode: 'cover', squadId: 'squad-2', squadRank: 1, leaderId: 'bot-4',
  targetId: 'bot-19', targetDist: 33.35, visGate: 'y',
  navRegion: 3, mag: 24, reserve: 90,
};
// The same row as it would appear in the TSV (n2 = 2dp on the numeric fields).
const n2 = v => (v == null ? '' : v.toFixed(2));
const tsvLine = [gameRow.t, gameRow.id, gameRow.team, gameRow.code, gameRow.changed,
  n2(gameRow.x), n2(gameRow.z), gameRow.yaw, n2(gameRow.speed), n2(gameRow.moved),
  n2(gameRow.goalDist), gameRow.pathLen, gameRow.pathMode, gameRow.squadId, gameRow.squadRank,
  gameRow.leaderId, gameRow.targetId, n2(gameRow.targetDist), gameRow.visGate,
  gameRow.navRegion, gameRow.mag, gameRow.reserve].join('\t');

const A = mk(decodeBotState, { bots: new Map(), allRows: [] });
const parsed = A.parseTrace(TSV_COLS.join('\t') + '\n' + tsvLine)[0];

const stateB = { bots: new Map(), allRows: [] };
const B = mk(decodeBotState, stateB);
B.ingestRow(gameRow);
const streamed = stateB.allRows[0];

const ka = Object.keys(parsed).sort(), kb = Object.keys(streamed).sort();
console.log('parsed keys  :', ka.length);
console.log('streamed keys:', kb.length);
const onlyA = ka.filter(k => !kb.includes(k)), onlyB = kb.filter(k => !ka.includes(k));
console.log(onlyA.length ? `  *** only in parsed:   ${onlyA}` : '  ok  no key only in parsed');
console.log(onlyB.length ? `  *** only in streamed: ${onlyB}` : '  ok  no key only in streamed');

let diffs = 0;
for (const k of ka) {
  if (!kb.includes(k)) continue;
  const a = parsed[k], b = streamed[k];
  if (k === 'd') { const same = JSON.stringify(a) === JSON.stringify(b);
    console.log(`  ${same ? 'ok  ' : 'FAIL'} d (decoded object) identical`); if (!same) diffs++; continue; }
  const same = a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (!same) { diffs++; console.log(`  FAIL ${k}: parsed=${JSON.stringify(a)} streamed=${JSON.stringify(b)}`); }
}
console.log(diffs ? `*** ${diffs} field mismatch(es)` : `  ok  all ${ka.length} fields match`);
console.log(diffs || onlyA.length || onlyB.length ? '\n*** PARITY FAIL' : '\nPARITY PASS');
