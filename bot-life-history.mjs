#!/usr/bin/env node
// Reconstructs per-bot life histories from a bot-viewer-v2 state trace + events log, and flags
// recording artifacts / FSM anomalies. Usage:
//   node bot-life-history.mjs [trace.tsv] [events.tsv]
// With no args, picks the most recent bot-state-trace-*.tsv in bot-states/ and its matching
// bot-events-<timestamp>.tsv.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeBotState, describeBotState } from './bot-state-code.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_STATES_DIR = path.join(__dirname, 'bot-states');

// A global gap this large can't be per-frame jitter even with ~200 bots logging independently
// (observed normal jitter tops out under 500ms) -- it means the recorder itself stalled, most
// likely the browser tab was backgrounded and rAF got throttled/paused, not that bots froze.
const PAUSE_GAP_THRESHOLD_MS = 5000;

// How long a bot can go between real (non-tick) transitions before we call it out as a possible
// standstill. Chosen well above normal patrol-loop cadence but low enough to catch multi-minute
// silences; anything flagged here still needs a human look, it's not proof of a bug.
const STUCK_THRESHOLD_MS = 20000;

// A damage event can show health as e.g. 0.03 instead of exactly 0 (float rounding in the logger),
// so "died from this hit" needs a near-zero band, not strict equality.
const NEAR_ZERO_HEALTH = 1;

function resolveInputFiles(argv) {
  if (argv[0]) return [argv[0], argv[1] || null];
  const traceFiles = fs.readdirSync(BOT_STATES_DIR)
    .filter(f => /^bot-state-trace-.*\.tsv$/.test(f))
    .sort(); // filenames are YYYYMMDD-HHMMSS stamped, so lexical sort == chronological
  if (!traceFiles.length) throw new Error(`No bot-state-trace-*.tsv found in ${BOT_STATES_DIR}`);
  const traceFile = traceFiles[traceFiles.length - 1];
  const stamp = traceFile.match(/^bot-state-trace-(.*)\.tsv$/)[1];
  const eventsPath = path.join(BOT_STATES_DIR, `bot-events-${stamp}.tsv`);
  // environment-viewer-v2's tracer (unlike bot-viewer-v2's) doesn't write a companion events file --
  // proceed with no events rather than guessing at an unrelated events file from a different session.
  return [path.join(BOT_STATES_DIR, traceFile), fs.existsSync(eventsPath) ? eventsPath : null];
}

function parseTsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const header = lines[0].split('\t');
  return lines.slice(1).map(l => {
    const cols = l.split('\t');
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i]; });
    return row;
  });
}

function fmtT(ms) { return (ms / 1000).toFixed(1); }

function findPauseWindows(trace) {
  const times = trace.map(r => +r.t_ms).sort((a, b) => a - b);
  const pauses = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > PAUSE_GAP_THRESHOLD_MS) pauses.push([times[i - 1], times[i], gap]);
  }
  return pauses;
}

function main() {
  const [traceFile, eventsFile] = resolveInputFiles(process.argv.slice(2));
  console.log(`Trace:  ${traceFile}`);
  console.log(`Events: ${eventsFile || '(none found -- kill/death attribution limited to the trace\'s own \'dead\' state)'}\n`);

  const trace = parseTsv(traceFile);
  const events = eventsFile ? parseTsv(eventsFile) : [];

  const byBot = new Map();
  for (const r of trace) {
    if (!byBot.has(r.bot_id)) byBot.set(r.bot_id, []);
    byBot.get(r.bot_id).push(r);
  }
  for (const rows of byBot.values()) rows.sort((a, b) => +a.t_ms - +b.t_ms);

  const pauses = findPauseWindows(trace);
  const overlapsPause = (t0, t1) => pauses.some(([a, b]) => t0 < b && t1 > a);

  const killsByVictim = new Map();
  const killsByAttacker = new Map();
  const damageByVictim = new Map();
  for (const e of events) {
    if (e.type === 'kill') {
      if (!killsByVictim.has(e.victim)) killsByVictim.set(e.victim, []);
      killsByVictim.get(e.victim).push(e);
      if (!killsByAttacker.has(e.attacker)) killsByAttacker.set(e.attacker, []);
      killsByAttacker.get(e.attacker).push(e);
    }
    if (e.type === 'damage') {
      if (!damageByVictim.has(e.victim)) damageByVictim.set(e.victim, []);
      damageByVictim.get(e.victim).push(e);
    }
  }
  for (const arr of damageByVictim.values()) arr.sort((a, b) => +a.t_ms - +b.t_ms);

  const tAll = trace.map(r => +r.t_ms);
  const tMin = Math.min(...tAll), tMax = Math.max(...tAll);
  const activeMs = (tMax - tMin) - pauses.reduce((s, [, , gap]) => s + gap, 0);

  // ---------------------------------------------------------------- (a) roster summary
  console.log('='.repeat(78));
  console.log('(a) ROSTER SUMMARY');
  console.log('='.repeat(78));
  const teamCounts = new Map();
  for (const rows of byBot.values()) teamCounts.set(rows[0].team, (teamCounts.get(rows[0].team) || 0) + 1);
  console.log(`Bots in state trace: ${byBot.size} — ${[...teamCounts.entries()].map(([t, n]) => `${t}: ${n}`).join(', ')}`);

  // Bots that only appear in the events file died before the trace's first row -- the two logs
  // don't start at the same t_ms, so early casualties are invisible to per-bot state history.
  const traceIds = new Set(byBot.keys());
  const eventsOnlyIds = new Set();
  for (const e of events) {
    if (e.attacker && !traceIds.has(e.attacker)) eventsOnlyIds.add(e.attacker);
    if (e.victim && !traceIds.has(e.victim)) eventsOnlyIds.add(e.victim);
  }
  console.log(`Bots seen only in events.tsv (died before trace logging started): ${eventsOnlyIds.size}`);
  if (eventsOnlyIds.size) console.log(`  ${[...eventsOnlyIds].join(', ')}`);

  const kills = events.filter(e => e.type === 'kill');
  const killsByTeam = new Map();
  const killsByWeapon = new Map();
  for (const k of kills) {
    killsByTeam.set(k.attacker_team, (killsByTeam.get(k.attacker_team) || 0) + 1);
    killsByWeapon.set(k.weapon, (killsByWeapon.get(k.weapon) || 0) + 1);
  }
  console.log(`Total kill events: ${kills.length} — ${[...killsByTeam.entries()].map(([t, n]) => `${t}: ${n}`).join(', ')}`);
  console.log(`By weapon: ${[...killsByWeapon.entries()].map(([w, n]) => `${w}: ${n}`).join(', ')}`);

  console.log(`\nRaw timestamp span: ${fmtT(tMin)}s - ${fmtT(tMax)}s (${fmtT(tMax - tMin)}s)`);
  console.log(`Recording-pause windows excluded from "active" time (see anomalies): ${pauses.length}`);
  for (const [a, b, gap] of pauses) console.log(`  ${fmtT(a)}s -> ${fmtT(b)}s (${fmtT(gap)}s pause)`);
  console.log(`Actual active/recorded simulation time: ~${fmtT(activeMs)}s`);

  // ---------------------------------------------------------------- (b) per-bot life history
  console.log('\n' + '='.repeat(78));
  console.log('(b) PER-BOT LIFE HISTORY');
  console.log('='.repeat(78));

  const ENGAGE_STATES = new Set(['pursue', 'knife', 'aim', 'fire']);
  function mode(arr) {
    const counts = new Map();
    for (const v of arr) { if (!v) continue; counts.set(v, (counts.get(v) || 0) + 1); }
    let best = null, bestN = 0;
    for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
    return best;
  }

  const ids = [...byBot.keys()].sort((a, b) => {
    const na = +a.replace(/\D/g, ''), nb = +b.replace(/\D/g, '');
    return na - nb;
  });

  const deathInfo = new Map(); // bot_id -> { matched, unmatchedButAlive, ... } for the anomalies section
  const lines = [];

  for (const id of ids) {
    const rows = byBot.get(id);
    const team = rows[0].team;
    // 'tick' rows are a position/motion-trail heartbeat only -- no slot actually changed, so they
    // are not decisions and must not be treated as transitions or as evidence of "still active".
    const real = rows.filter(r => r.changed_slots !== 'tick');
    const first = rows[0], last = rows[rows.length - 1];
    const fD = decodeBotState(first.code), lD = decodeBotState(last.code);
    const role = mode(rows.map(r => decodeBotState(r.code)?.role));

    let firstEngage = null;
    for (const r of real) {
      const d = decodeBotState(r.code);
      if (ENGAGE_STATES.has(d.state)) { firstEngage = { t: fmtT(+r.t_ms), state: d.state, target: r.target_id, dist: r.target_dist }; break; }
    }

    // environment-viewer-v2 respawns bots (bot-viewer-v2 does not), so "ever reached the dead
    // state" is not the same question as "is dead now" -- walk the real transitions and find every
    // dead-state entry/exit pair. A bot can die and respawn more than once in one recording.
    let deaths = 0, wasDead = false;
    for (const r of real) {
      const isDead = decodeBotState(r.code)?.state === 'dead';
      if (isDead && !wasDead) deaths++;
      wasDead = isDead;
    }
    const respawns = wasDead ? deaths - 1 : deaths; // still dead at the end -> the last death had no respawn
    // Only worth a note when a respawn actually happened -- a single death with 0 respawns is just
    // "died", the ordinary case for bot-viewer-v2, which never respawns bots at all.
    const respawnNote = respawns > 0 ? ` (died ${deaths}x, respawned ${respawns}x during the recording)` : '';

    const botKillsAll = (killsByVictim.get(id) || []).slice().sort((a, b) => +a.t_ms - +b.t_ms);
    const dmgs = damageByVictim.get(id) || [];
    let outcome, unmatchedDeath = false;
    if (!wasDead) {
      // Alive at the end regardless of any earlier death cycle -- respawnNote (if any) covers those.
      outcome = `survives to the end of the recording (last state '${lD.state}' at ${fmtT(+last.t_ms)}s)${respawnNote}`;
    } else if (botKillsAll.length) {
      const k = botKillsAll[botKillsAll.length - 1]; // the death that stuck, not necessarily the first
      outcome = `dies at ${fmtT(+k.t_ms)}s, killed by ${k.attacker} (${k.attacker_team}) with ${k.weapon}${respawnNote}`;
    } else {
      const nearZero = [...dmgs].reverse().find(e => +e.victim_health <= NEAR_ZERO_HEALTH);
      if (nearZero) {
        outcome = `apparently dies at ${fmtT(+nearZero.t_ms)}s (health hit ~0 from ${nearZero.attacker}/${nearZero.weapon}, no kill-event logged)${respawnNote}`;
      } else {
        outcome = `ends in 'dead' state at ${fmtT(+last.t_ms)}s with no corresponding kill/damage event in the events file${respawnNote}`;
        unmatchedDeath = true;
      }
    }
    const gotKills = killsByAttacker.get(id);
    const killsStr = gotKills && gotKills.length
      ? ` Scored ${gotKills.length} kill(s): ${gotKills.map(k => `${k.victim} (${k.victim_team}, ${k.weapon}) at ${fmtT(+k.t_ms)}s`).join(', ')}.`
      : '';

    const spansPause = pauses.some(([a, b]) => +first.t_ms < a && +last.t_ms > b);

    let sentence = `${id} (${team}${role ? `, ${role}` : ''}): first seen ${fmtT(+first.t_ms)}s in '${fD.state}'.`;
    sentence += firstEngage
      ? ` First engages at ${firstEngage.t}s (${firstEngage.state}${firstEngage.target ? `, target ${firstEngage.target}@${firstEngage.dist}m` : ''}).`
      : ` Never reaches an engage state (pursue/knife/aim/fire) in ${real.length} real transitions.`;
    sentence += ` ${outcome[0].toUpperCase() + outcome.slice(1)}.${killsStr}`;
    if (spansPause) sentence += ' [alive across a recording-pause window]';

    lines.push(sentence);
    deathInfo.set(id, { unmatchedDeath, realCount: real.length, dmgCount: dmgs.length, lastDmgHealth: dmgs.length ? +dmgs[dmgs.length - 1].victim_health : null });
  }
  console.log(lines.join('\n'));

  // ---------------------------------------------------------------- (c) anomalies
  console.log('\n' + '='.repeat(78));
  console.log('(c) ANOMALIES');
  console.log('='.repeat(78));

  console.log('\n-- Unmatched deaths (dead in trace, no kill/near-zero-damage event as victim) --');
  let phantomCount = 0, realLifeCount = 0;
  for (const [id, info] of deathInfo) {
    if (!info.unmatchedDeath) continue;
    const hadRealLife = info.realCount > 1;
    if (hadRealLife) realLifeCount++; else phantomCount++;
    if (hadRealLife) {
      console.log(`  ${id}: ${info.realCount} real transitions, ${info.dmgCount} damage-events-as-victim, last known health=${info.lastDmgHealth ?? 'n/a'} -- died with substantial recorded life but no logged cause`);
    }
  }
  console.log(`  (+ ${phantomCount} more that were only ever seen as an already-dead 'initial' snapshot -- almost certainly pre-trace casualties, not evidence of missed logging)`);
  console.log(`  Total unmatched: ${phantomCount + realLifeCount} (${realLifeCount} with real recorded activity, ${phantomCount} phantom-only)`);

  console.log('\n-- Stuck-state candidates (>20s between real transitions, excluding recording-pause windows) --');
  let stuckFound = 0;
  for (const [id, rows] of byBot) {
    const real = rows.filter(r => r.changed_slots !== 'tick');
    for (let i = 1; i < real.length; i++) {
      const t0 = +real[i - 1].t_ms, t1 = +real[i].t_ms;
      if (overlapsPause(t0, t1)) continue; // a pause window makes any interval crossing it look "stuck" when it's really just unrecorded
      if (t1 - t0 > STUCK_THRESHOLD_MS) {
        const d0 = decodeBotState(real[i - 1].code), d1 = decodeBotState(real[i].code);
        console.log(`  ${id}: stuck in '${d0.state}' from ${fmtT(t0)}s to ${fmtT(t1)}s (${fmtT(t1 - t0)}s) -> '${d1.state}'`);
        stuckFound++;
      }
    }
  }
  console.log(`  Total candidates: ${stuckFound}`);

  console.log('\n-- Squad/leader referential integrity --');
  const leaderRefs = new Set();
  for (const r of trace) if (r.leader_id) leaderRefs.add(r.leader_id);
  const missingLeaders = [...leaderRefs].filter(l => !traceIds.has(l));
  console.log(missingLeaders.length
    ? `  leader_id values with no matching bot_id in trace: ${missingLeaders.join(', ')}`
    : '  none found (every leader_id referenced is itself a bot present in the trace)');

  console.log('\n-- Rapid state-flip thrashing (A-B-A within <1.5s), excluding normal aim<->fire firing cadence --');
  // aim<->fire alternation is the expected per-shot cycle of semi-auto fire, not FSM oscillation --
  // a first pass mistook this for a bug on the bots with the most kills, so it's excluded here.
  let thrashFound = 0;
  for (const [id, rows] of byBot) {
    const real = rows.filter(r => r.changed_slots !== 'tick');
    const pairs = new Map();
    for (let i = 2; i < real.length; i++) {
      const d0 = decodeBotState(real[i - 2].code), d1 = decodeBotState(real[i - 1].code), d2 = decodeBotState(real[i].code);
      if (d0.state === d2.state && d0.state !== d1.state && (+real[i].t_ms - +real[i - 2].t_ms) < 1500) {
        const isFireCadence = (d0.state === 'aim' && d1.state === 'fire') || (d0.state === 'fire' && d1.state === 'aim');
        if (isFireCadence) continue;
        const key = `${d0.state}<->${d1.state}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
    const total = [...pairs.values()].reduce((a, b) => a + b, 0);
    if (total > 5) { console.log(`  ${id}: ${total} rapid flips -- ${[...pairs.entries()].map(([k, n]) => `${k}:${n}`).join(', ')}`); thrashFound++; }
  }
  if (!thrashFound) console.log('  none above threshold');
}

main();
