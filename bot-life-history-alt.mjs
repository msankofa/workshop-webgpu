#!/usr/bin/env node
// Reconstructs per-bot life histories + anomaly report from a bot-viewer-v2 state trace + events
// pair. Usage: node bot-life-history-alt.mjs [trace.tsv] [events.tsv]
// With no args, picks the newest bot-state-trace-*.tsv in bot-states/ and its matching
// bot-events-*.tsv (same YYYYMMDD-HHMMSS suffix).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { decodeBotState, describeBotState } from './bot-state-code.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATES_DIR = path.join(HERE, 'bot-states');

// --- file resolution --------------------------------------------------------------------------

function newestTrace() {
  const files = fs.readdirSync(STATES_DIR).filter(f => /^bot-state-trace-.*\.tsv$/.test(f)).sort();
  if (!files.length) throw new Error(`no bot-state-trace-*.tsv found in ${STATES_DIR}`);
  return files[files.length - 1];
}

function matchingEvents(traceName) {
  const stamp = traceName.match(/bot-state-trace-(.+)\.tsv$/)?.[1];
  const candidate = `bot-events-${stamp}.tsv`;
  if (stamp && fs.existsSync(path.join(STATES_DIR, candidate))) return candidate;
  // No same-stamp events file -- environment-viewer-v2's tracer (unlike bot-viewer-v2's) doesn't
  // write one. Return null rather than guessing at some other session's unrelated events file.
  return null;
}

const traceFile = process.argv[2] || path.join(STATES_DIR, newestTrace());
// An explicit argv[3] is a caller-given path and must be used as-is, exactly like traceFile above --
// only the auto-detected filename (bare, no directory) needs joining with STATES_DIR.
const autoEvents = matchingEvents(path.basename(traceFile));
const eventsFile = process.argv[3] || (autoEvents ? path.join(STATES_DIR, autoEvents) : null);

// --- tsv parsing -------------------------------------------------------------------------------

function parseTsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.length);
  const header = lines[0].split('\t');
  return lines.slice(1).map(l => {
    const cols = l.split('\t');
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cols[i];
    return row;
  });
}

const trace = parseTsv(traceFile);
const events = eventsFile ? parseTsv(eventsFile) : [];
if (!trace.length) throw new Error(`empty trace: ${traceFile}`);

const t0 = Math.min(...trace.map(r => +r.t_ms));
const t1 = Math.max(...trace.map(r => +r.t_ms));
const sec = t => ((t - t0) / 1000).toFixed(1);

const byBot = new Map();
for (const r of trace) {
  if (!byBot.has(r.bot_id)) byBot.set(r.bot_id, []);
  byBot.get(r.bot_id).push(r);
}
for (const rows of byBot.values()) rows.sort((a, b) => +a.t_ms - +b.t_ms);

// --- global recording-gap detection -------------------------------------------------------------
// A gap this size can't be explained by any single bot going quiet -- with dozens of bots each
// ticking roughly once a second, a real combined-row silence longer than this means the recorder
// itself stopped (backgrounded tab, machine sleep), not that every bot froze at once. Without this
// check, a single global gap gets misread as N separate "stuck bot" anomalies (caught the hard way
// on the first pass over this dataset: 27 bots wrongly flagged as frozen for 26,794s).
const GLOBAL_GAP_MS = 30_000;
const allTimes = trace.map(r => +r.t_ms).sort((a, b) => a - b);
const gapWindows = [];
for (let i = 1; i < allTimes.length; i++) {
  const d = allTimes[i] - allTimes[i - 1];
  if (d > GLOBAL_GAP_MS) gapWindows.push([allTimes[i - 1], allTimes[i]]);
}
function overlapsGap(from, to) {
  return gapWindows.some(([gs, ge]) => from < ge && to > gs);
}

// --- kills / deaths, cross-referenced both ways -------------------------------------------------

const killEvents = events.filter(e => e.type === 'kill');
const deathByVictim = new Map(killEvents.map(e => [e.victim, e]));
const killsByAttacker = new Map();
for (const e of killEvents) {
  if (!killsByAttacker.has(e.attacker)) killsByAttacker.set(e.attacker, []);
  killsByAttacker.get(e.attacker).push(e);
}
// damage-to-zero fallback: some deaths only ever show up as a damage row hitting 0, no kill row
const lastDamageZero = new Map();
for (const e of events) {
  if (e.type === 'damage' && +e.victim_health <= 0) {
    const prev = lastDamageZero.get(e.victim);
    if (!prev || +e.t_ms > prev.t_ms) lastDamageZero.set(e.victim, e);
  }
}

// --- per-bot life history ------------------------------------------------------------------------

function lifeHistory(id, rows) {
  const team = rows[0].team;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const lastDecoded = decodeBotState(last.code);
  const nonTick = rows.filter(r => r.changed_slots !== 'tick'); // 'tick' is a motion-trail heartbeat, not a decision
  const statePath = [];
  for (const r of nonTick) {
    const st = r.code[0];
    if (statePath[statePath.length - 1] !== st) statePath.push(st);
  }
  let pathStr = statePath.join('>');
  if (statePath.length > 22) {
    pathStr = statePath.slice(0, 14).join('>') + `>..(${statePath.length - 19} more)..>` + statePath.slice(-5).join('>');
  }

  // environment-viewer-v2 respawns bots (bot-viewer-v2 does not), so a 'D' row earlier in the
  // trace does not mean dead NOW -- only the terminal state does. Count death<->alive cycles so a
  // respawned bot is reported as alive-with-history, not as having died, which is what a naive
  // "first D row found" check would wrongly report.
  let deaths = 0, wasDead = false;
  for (const r of nonTick) {
    const isDead = r.code[0] === 'D';
    if (isDead && !wasDead) deaths++;
    wasDead = isDead;
  }
  const endsDead = lastDecoded?.state === 'dead';
  const respawnNote = deaths > (endsDead ? 1 : 0) ? ` [died/respawned ${deaths}x total during the recording]` : '';

  const death = deathByVictim.get(id) || lastDamageZero.get(id);
  const kills = killsByAttacker.get(id) || [];
  let outcome;
  if (!endsDead) {
    outcome = `SURVIVED to end (last=${lastDecoded?.state}, hp=${lastDecoded?.healthRange})${respawnNote}`;
  } else if (death) {
    // an event timestamped before t0 happened before the trace recorder started, so the bot's
    // "first" trace row is really its corpse already lingering -- label it distinctly rather than
    // print a confusing negative elapsed time.
    if (+death.t_ms < t0) {
      outcome = `DIED pre-recording (killed by ${death.attacker}/${death.attacker_team} w/${death.weapon} `
        + `${((t0 - death.t_ms) / 1000).toFixed(0)}s before trace start; corpse first logged @${sec(+first.t_ms)}s)`;
    } else {
      outcome = `DIED @${sec(+death.t_ms)}s killed by ${death.attacker}(${death.attacker_team}) w/${death.weapon}${respawnNote}`;
    }
  } else {
    // last, not first: a respawning bot can have several 'D' rows, and only the final one is live.
    const deadRow = [...rows].reverse().find(r => r.code[0] === 'D');
    outcome = `DIED @${sec(+deadRow.t_ms)}s (no matching event -- cause unlogged)${respawnNote}`;
  }
  const killStr = kills.length
    ? ` | kills: ${kills.map(k => +k.t_ms < t0 ? `${k.victim}(pre-recording)` : `${k.victim}@${sec(+k.t_ms)}s`).join(', ')}`
    : '';

  return { id, team, firstT: +first.t_ms, lastT: +last.t_ms, pathStr, outcome, killStr };
}

const lives = [...byBot.entries()]
  .sort(([a, ra], [b, rb]) => {
    const ta = ra[0].team, tb = rb[0].team;
    return ta !== tb ? ta.localeCompare(tb) : (+a.split('-')[1]) - (+b.split('-')[1]);
  })
  .map(([id, rows]) => lifeHistory(id, rows));

// --- anomaly detection -----------------------------------------------------------------------

const anomalies = [];

for (const [bot, rows] of byBot) {
  const team = rows[0].team;

  // 1. long-stuck: no slot change for a long stretch, skipping spans that fall inside a detected
  // global gap (those are recorder silence, not this bot's FSM freezing).
  const transitions = rows.filter(r => r.changed_slots !== 'tick');
  for (let i = 0; i < transitions.length - 1; i++) {
    const from = +transitions[i].t_ms, to = +transitions[i + 1].t_ms;
    const gap = to - from;
    if (gap > 300_000 && !overlapsGap(from, to)) {
      const d = decodeBotState(transitions[i].code);
      anomalies.push({ kind: 'long-stuck', bot, team,
        detail: `No slot change for ${(gap / 1000).toFixed(0)}s from t=${sec(from)}s to t=${sec(to)}s, `
          + `state=${d?.state} tier=${d?.tier} latches=${d?.latches.join('+') || 'none'}` });
    }
  }

  // 2. target visible + no engagement: a target in range that the bot never aims or fires at.
  // (Ammo-empty bots correctly flee/knife instead -- check mag before trusting this as a bug.)
  const withTarget = rows.filter(r => r.target_id && +r.target_dist < 30);
  if (withTarget.length >= 5 && !rows.some(r => 'AF'.includes(r.code[0]))) {
    const minDist = Math.min(...withTarget.map(r => +r.target_dist));
    anomalies.push({ kind: 'target-no-engage', bot, team,
      detail: `${withTarget.length} rows with target_id set & dist<30 (min dist ${minDist.toFixed(1)}) but never reaches aim/fire` });
  }

  // 3. rapid A-B-A state flapping (<4s) -- cover thrash (C<->G) is the pattern this project has
  // been chasing, but any state oscillating this fast is worth a look.
  const stateTrans = transitions.filter(r => r.changed_slots.includes('state'));
  let flapCount = 0;
  const flapExamples = [];
  for (let i = 2; i < stateTrans.length; i++) {
    const a = stateTrans[i - 2].code[0], b = stateTrans[i - 1].code[0], c = stateTrans[i].code[0];
    if (a === c && a !== b) {
      const dt = +stateTrans[i].t_ms - +stateTrans[i - 2].t_ms;
      if (dt < 4000) { flapCount++; if (flapExamples.length < 3) flapExamples.push(`${a}->${b}->${c} within ${dt}ms at t=${sec(+stateTrans[i].t_ms)}s`); }
    }
  }
  if (flapCount >= 3) {
    anomalies.push({ kind: 'state-flapping', bot, team, detail: `${flapCount} rapid A->B->A flaps (<4s). Examples: ${flapExamples.join(' | ')}` });
  }

  // 4. reaches 'D' in-trace with no death event in either direction (kill or damage-to-zero).
  // Meaningless noise with no events file at all (environment-viewer-v2 doesn't write one, so
  // EVERY death would "fail" this check) -- only worth flagging when an events file exists and
  // still doesn't explain the death.
  if (eventsFile && rows.some(r => r.code[0] === 'D') && !deathByVictim.has(bot) && !lastDamageZero.has(bot)) {
    const deadRow = [...rows].reverse().find(r => r.code[0] === 'D'); // last, not first: a respawned bot dies more than once
    anomalies.push({ kind: 'dead-state-no-event', bot, team,
      detail: `'D' dead state at t=${sec(+deadRow.t_ms)}s but no kill/damage-to-zero event in the events file` });
  }
}

// 5. kill events whose victim never appears in the trace at all -- expected when the kill predates
// the trace's own t0 (trace logging starts later than event logging), flagged only if it doesn't.
for (const e of killEvents) {
  if (!byBot.has(e.victim)) {
    anomalies.push({ kind: +e.t_ms < t0 ? 'death-no-trace-pre-recording' : 'death-no-trace-UNEXPLAINED',
      bot: e.victim, team: e.victim_team, detail: `killed by ${e.attacker} at t_ms=${e.t_ms} but never appears in the trace` });
  }
}

// 6. squad_id/leader_id referencing a bot_id that never appears as an actual bot in the trace
const allIds = new Set(byBot.keys());
const leaderRefs = new Set(trace.map(r => r.leader_id).filter(Boolean));
const squadRefs = new Set(trace.map(r => r.squad_id).filter(Boolean));
for (const id of leaderRefs) if (!allIds.has(id)) anomalies.push({ kind: 'dangling-leader-ref', bot: id, team: '?', detail: `leader_id references ${id}, which never appears as a bot_id` });
if (trace.some(r => r.squad_id || r.leader_id) === false) {
  anomalies.push({ kind: 'squad-system-empty', bot: '(all)', team: '(all)', detail: `squad_id and leader_id are empty on all ${trace.length} rows` });
}

// --- report ----------------------------------------------------------------------------------

const teamCounts = new Map();
for (const rows of byBot.values()) teamCounts.set(rows[0].team, (teamCounts.get(rows[0].team) || 0) + 1);
const killsByTeam = new Map(), deathsByTeam = new Map();
for (const e of killEvents) {
  killsByTeam.set(e.attacker_team, (killsByTeam.get(e.attacker_team) || 0) + 1);
  deathsByTeam.set(e.victim_team, (deathsByTeam.get(e.victim_team) || 0) + 1);
}
const survivors = lives.filter(l => l.outcome.startsWith('SURVIVED')).length;

console.log('='.repeat(100));
console.log('ROSTER SUMMARY');
console.log('='.repeat(100));
console.log(`Trace: ${traceFile}`);
console.log(`Events: ${eventsFile || "(none found -- kill/death attribution limited to the trace's own 'D' state)"}`);
console.log(`Bots: ${byBot.size} total -- ${[...teamCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`Kills: ${killEvents.length} total -- by team: ${[...killsByTeam.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`Deaths (by team, from kill events): ${[...deathsByTeam.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`Survivors to end of recording: ${survivors} / ${byBot.size}`);
console.log(`Raw trace span: t0=${t0}ms t1=${t1}ms (${((t1 - t0) / 1000).toFixed(1)}s)`);
if (gapWindows.length) {
  for (const [gs, ge] of gapWindows) {
    console.log(`Global recording gap: zero rows from any bot between t=${sec(gs)}s and t=${sec(ge)}s (${((ge - gs) / 1000).toFixed(0)}s) -- recorder silence, not an FSM freeze`);
  }
} else {
  console.log('No global recording gap detected.');
}

console.log('\n' + '='.repeat(100));
console.log('PER-BOT LIFE HISTORY');
console.log('='.repeat(100));
for (const l of lives) {
  console.log(`${l.id.padEnd(9)} ${l.team.padEnd(6)} span=${sec(l.firstT).padStart(9)}-${sec(l.lastT).padStart(9)}s  path=${l.pathStr}`);
  console.log(`  ${l.outcome}${l.killStr}`);
}

console.log('\n' + '='.repeat(100));
console.log(`ANOMALIES (${anomalies.length})`);
console.log('='.repeat(100));
const kinds = [...new Set(anomalies.map(a => a.kind))];
for (const k of kinds) console.log(`${k}: ${anomalies.filter(a => a.kind === k).length}`);
console.log('');
for (const a of anomalies) console.log(`[${a.kind}] ${a.bot} (${a.team}): ${a.detail}`);
