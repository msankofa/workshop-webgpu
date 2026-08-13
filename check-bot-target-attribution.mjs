// Post-hoc checker for bot-states/*.tsv traces (see docs/bot-bugs-log.md BB-001).
// Flags bots that fight (or get fled/knifed from) without ever being recorded as
// another bot's target_id -- the pattern that let bot-262 rack up an unopposed
// kill streak in one take and go unnoticed fleeing point-blank in another.
//
// Usage: node check-bot-target-attribution.mjs <trace.tsv> [trace2.tsv ...]
// Loads the sibling bot-events-<stamp>.tsv next to each trace when present.
// Exits 1 if any check flags something in any file, 0 otherwise.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ATTRIB_WINDOW_MS = 2000; // how close to a damage event a target_id match must land
const ENGAGE_DIST_M = 15;      // proximity treated as "in contact"
const ENGAGE_MIN_STREAK = 3;   // consecutive 1s buckets within ENGAGE_DIST_M to count as sustained
const BUCKET_MS = 1000;
const MAX_STALE_MS = 3000;     // a bot's last-known position older than this is "not present"

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cols = line.split('\t');
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
}

function loadTrace(file) {
  const rows = parseTsv(readFileSync(file, 'utf8'));
  for (const r of rows) {
    r.t_ms = Number(r.t_ms);
    r.x = r.x === '' ? null : Number(r.x);
    r.z = r.z === '' ? null : Number(r.z);
  }
  return rows;
}

function loadEvents(file) {
  if (!existsSync(file)) return null;
  const rows = parseTsv(readFileSync(file, 'utf8'));
  for (const r of rows) r.t_ms = Number(r.t_ms);
  return rows;
}

function eventsPathFor(tracePath) {
  const base = path.basename(tracePath);
  if (!base.startsWith('bot-state-trace-')) return null;
  return path.join(path.dirname(tracePath), base.replace('bot-state-trace-', 'bot-events-'));
}

function groupBy(rows, key) {
  const out = {};
  for (const r of rows) (out[r[key]] ??= []).push(r);
  return out;
}

// Check 1: bots with damage/kill events as attacker that never appear as anyone's target_id.
function checkGhostCombatants(trace, events) {
  const targetedIds = new Set();
  for (const r of trace) if (r.target_id) targetedIds.add(r.target_id);

  const stats = {};
  for (const e of events ?? []) {
    if (e.type !== 'damage' && e.type !== 'kill') continue;
    const s = (stats[e.attacker] ??= { events: 0, kills: 0 });
    s.events++;
    if (e.type === 'kill') s.kills++;
  }

  return Object.entries(stats)
    .filter(([id]) => !targetedIds.has(id))
    .map(([bot_id, s]) => ({ bot_id, ...s }));
}

// Check 2: individual damage/kill events where the victim's target_id never equals
// the attacker within ATTRIB_WINDOW_MS of the event.
function checkUnattributedHits(trace, events) {
  const byBot = groupBy(trace, 'bot_id');
  const flagged = [];
  for (const e of events ?? []) {
    if (e.type !== 'damage' && e.type !== 'kill') continue;
    const victimRows = byBot[e.victim] || [];
    const attributed = victimRows.some(
      (r) => r.target_id === e.attacker && Math.abs(r.t_ms - e.t_ms) <= ATTRIB_WINDOW_MS,
    );
    if (!attributed) {
      flagged.push({ t_ms: e.t_ms, type: e.type, attacker: e.attacker, victim: e.victim });
    }
  }
  return flagged;
}

// Check 3: opposing-team bots that stay within ENGAGE_DIST_M of each other for a
// sustained stretch without BOTH directions ever recording the other -- via target_id
// or a damage event. Flags two shapes:
//   'one-sided'  A refers to B (or vice versa) but never the reverse -- A reacts to a
//                contact that never reacts back. This is the bot-262 shape: it set
//                target_id to the bot it was fleeing/knifing, but that bot never set
//                target_id back.
//   'none'       neither side ever refers to the other despite sustained proximity.
function checkSilentEncounters(trace, events) {
  const byBot = groupBy(trace, 'bot_id');
  const ids = Object.keys(byBot);
  const team = {};
  for (const id of ids) team[id] = byBot[id][0]?.team;

  const attributed = new Set(); // directed: `${from}|${to}` means `from` referenced `to`
  for (const r of trace) if (r.target_id) attributed.add(`${r.bot_id}|${r.target_id}`);
  for (const e of events ?? []) {
    if (e.type === 'damage' || e.type === 'kill') attributed.add(`${e.attacker}|${e.victim}`);
  }
  function attributionShape(a, b) {
    const ab = attributed.has(`${a}|${b}`);
    const ba = attributed.has(`${b}|${a}`);
    if (ab && ba) return 'mutual';
    if (ab || ba) return 'one-sided';
    return 'none';
  }

  // A dead bot (state slot 1 == 'D') keeps emitting heartbeat rows at its death
  // position forever -- exclude those so a corpse can't manufacture a "close
  // proximity" encounter with whoever later walks past it.
  const seq = {};
  for (const id of ids) {
    seq[id] = byBot[id]
      .filter((r) => r.x !== null && r.z !== null && !Number.isNaN(r.t_ms) && r.code?.[0] !== 'D')
      .sort((a, b) => a.t_ms - b.t_ms);
  }

  const allT = trace.map((r) => r.t_ms).filter((n) => !Number.isNaN(n));
  if (!allT.length) return [];
  const tMin = Math.min(...allT);
  const tMax = Math.max(...allT);

  const ptr = {};
  ids.forEach((id) => { ptr[id] = 0; });
  function posAt(id, t) {
    const rows = seq[id];
    if (!rows || !rows.length) return null;
    let p = ptr[id];
    while (p + 1 < rows.length && rows[p + 1].t_ms <= t) p++;
    ptr[id] = p;
    const r = rows[p];
    if (!r || Math.abs(t - r.t_ms) > MAX_STALE_MS) return null;
    return r;
  }

  const streak = {};
  const flagged = new Map();

  for (let t = tMin; t <= tMax; t += BUCKET_MS) {
    const present = [];
    for (const id of ids) {
      const r = posAt(id, t);
      if (r) present.push({ id, x: r.x, z: r.z, team: team[id] });
    }
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const A = present[i];
        const B = present[j];
        if (A.team === B.team || !A.team || !B.team) continue;
        const key = [A.id, B.id].sort().join('|');
        const dist = Math.hypot(A.x - B.x, A.z - B.z);
        if (dist <= ENGAGE_DIST_M) {
          streak[key] = (streak[key] || 0) + 1;
          const shape = attributionShape(A.id, B.id);
          if (streak[key] >= ENGAGE_MIN_STREAK && shape !== 'mutual') {
            const rec = flagged.get(key) || {
              a: A.id, b: B.id, teamA: A.team, teamB: B.team,
              firstT: t, lastT: t, peakStreak: 0, minDist: dist, shape,
            };
            rec.lastT = t;
            rec.peakStreak = Math.max(rec.peakStreak, streak[key]);
            rec.minDist = Math.min(rec.minDist, dist);
            rec.shape = shape; // keep latest -- can flip one-sided -> none is impossible, but not vice versa either; stays stable in practice
            flagged.set(key, rec);
          }
        } else {
          streak[key] = 0;
        }
      }
    }
  }
  return [...flagged.values()];
}

function runOne(tracePath) {
  const trace = loadTrace(tracePath);
  const evPath = eventsPathFor(tracePath);
  const events = evPath ? loadEvents(evPath) : null;

  const ghosts = checkGhostCombatants(trace, events);
  const unattributed = events ? checkUnattributedHits(trace, events) : [];
  const silent = checkSilentEncounters(trace, events);

  console.log(`\n=== ${path.basename(tracePath)} ===`);
  console.log(`rows: ${trace.length}, events file: ${events ? path.basename(evPath) : '(none found)'}${events ? `, events: ${events.length}` : ''}`);

  console.log(`\n[1] Ghost combatants (dealt damage, never any bot's target_id): ${ghosts.length}`);
  for (const g of ghosts) {
    console.log(`  - ${g.bot_id}: ${g.events} events (${g.kills} kills), 0 times targeted by anyone`);
  }

  console.log(`\n[2] Unattributed hits (event landed, victim's target_id never matched within ${ATTRIB_WINDOW_MS}ms): ${unattributed.length}`);
  for (const u of unattributed.slice(0, 20)) {
    console.log(`  - t=${u.t_ms} ${u.type} ${u.attacker} -> ${u.victim}`);
  }
  if (unattributed.length > 20) console.log(`  ... and ${unattributed.length - 20} more`);

  const oneSided = silent.filter((s) => s.shape === 'one-sided');
  const none = silent.filter((s) => s.shape === 'none');
  console.log(`\n[3] Silent/one-sided encounters (opposing bots within ${ENGAGE_DIST_M}m for >=${ENGAGE_MIN_STREAK}s, not mutually attributed): ${silent.length} (${oneSided.length} one-sided, ${none.length} fully silent)`);
  for (const s of silent) {
    const durS = ((s.lastT - s.firstT) / 1000).toFixed(1);
    const tag = s.shape === 'one-sided' ? '[one-sided]' : '[silent]';
    console.log(`  - ${tag} ${s.a} (${s.teamA}) <-> ${s.b} (${s.teamB}): t=${s.firstT}-${s.lastT} (${durS}s), min dist ${s.minDist.toFixed(1)}m, peak streak ${s.peakStreak}s`);
  }

  return ghosts.length + unattributed.length + silent.length;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node check-bot-target-attribution.mjs <trace.tsv> [trace2.tsv ...]');
  process.exit(2);
}

let totalFlags = 0;
for (const f of files) totalFlags += runOne(f);

console.log(`\n=== summary: ${totalFlags} total flags across ${files.length} file(s) ===`);
process.exit(totalFlags > 0 ? 1 : 0);
