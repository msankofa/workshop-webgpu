// bot-score.js — pure, THREE-free per-team session tally: spawns, deaths, revives, frags, plus
// kill attribution (weapon / cause / role) and a round history. Node-tested in test-bot-score.mjs;
// consumed by bot-viewer-v2's spawn/kill/revive hooks, the HUD scoreboard and the panel readout.
// Deliberately holds no "alive" count: living bots are the roster's truth, so callers pass a live
// count in instead of the tally trying to mirror culls.

export const MAX_ROUNDS = 12;        // archived rounds kept; oldest is dropped
const BREAKDOWN_TOP = 4;             // entries per breakdown line before the tail is folded away

export function createScoreboard(teams = ['alpha', 'bravo']) {
  const board = { teams: new Map(), rounds: [], round: newRound(1, null) };
  for (const team of teams) teamStats(board, team);   // fixed display order for the known teams
  return board;
}

function newRound(index, startedAt) {
  return { index, startedAt, endedAt: null, winner: null, reason: null };
}

function newRecord() {
  return {
    spawned: 0, deaths: 0, revives: 0, kills: 0, teamkills: 0, selfKills: 0,
    byWeapon: new Map(),      // frags per weapon id
    byCause: new Map(),       // frags per cause: bullet | blast | knife
    byRole: new Map(),        // frags per killer role
    lossesByRole: new Map(),  // deaths per victim role
  };
}

function zeroRecord(rec) {
  rec.spawned = 0; rec.deaths = 0; rec.revives = 0; rec.kills = 0; rec.teamkills = 0; rec.selfKills = 0;
  rec.byWeapon.clear(); rec.byCause.clear(); rec.byRole.clear(); rec.lossesByRole.clear();
}

function bump(map, key, n = 1) {
  if (key == null || key === '') return;
  map.set(key, (map.get(key) || 0) + n);
}

// Ensures (and returns) the record for a team; unknown teams are created on first use.
export function teamStats(board, team) {
  const key = team ?? 'unknown';
  let rec = board.teams.get(key);
  if (!rec) { rec = newRecord(); board.teams.set(key, rec); }
  return rec;
}

// Full wipe: the live round, the counters, and (unless kept) the archived rounds.
export function resetScoreboard(board, { keepHistory = false } = {}) {
  for (const rec of board.teams.values()) zeroRecord(rec);
  if (!keepHistory) board.rounds.length = 0;
  board.round = newRound(1, null);
}

export function recordSpawn(board, team, count = 1, now = null) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return;
  if (board.round.endedAt != null) openRound(board, now);   // first spawn after a decision starts the next round
  board.round.startedAt ??= now;
  teamStats(board, team).spawned += n;
}

// One death. The frag lands on the killer's team: cross-team it's a kill (with weapon/cause/role
// attribution), same-team a teamkill, and a bot killed by its own blast a selfKill.
export function recordKill(board, victimTeam, killerTeam = null, opts = {}) {
  const { selfKill = false, weapon = null, cause = null, killerRole = null, victimRole = null } = opts;
  const victim = teamStats(board, victimTeam);
  victim.deaths += 1;
  bump(victim.lossesByRole, victimRole);
  if (killerTeam == null) return;
  const killer = teamStats(board, killerTeam);
  if (selfKill) { killer.selfKills += 1; killer.teamkills += 1; return; }
  if (killerTeam === victimTeam) { killer.teamkills += 1; return; }
  killer.kills += 1;
  bump(killer.byWeapon, weapon);
  bump(killer.byCause, cause);
  bump(killer.byRole, killerRole);
}

// A revived bot is alive again but its death stays on the books, so lost = deaths - revives.
export function recordRevive(board, team) {
  teamStats(board, team).revives += 1;
}

// Deaths that stuck: what the side has actually lost right now.
export function netLosses(rec) {
  return Math.max(0, rec.deaths - rec.revives);
}

export function roundElapsedMs(board, now) {
  const r = board.round;
  if (r.startedAt == null || now == null) return 0;
  return Math.max(0, (r.endedAt ?? now) - r.startedAt);
}

function anySpawns(board) {
  for (const rec of board.teams.values()) if (rec.spawned > 0) return true;
  return false;
}

// Close the live round and archive a snapshot. The counters stay put so the HUD keeps showing the
// result until the next spawn; a round nobody ever spawned into is left open instead of archived.
export function finishRound(board, { now = null, winner = null, reason = 'ended' } = {}) {
  const r = board.round;
  if (r.endedAt != null || !anySpawns(board)) return false;
  r.endedAt = now; r.winner = winner; r.reason = reason;
  board.rounds.unshift(snapshotRound(board));   // newest first
  if (board.rounds.length > MAX_ROUNDS) board.rounds.length = MAX_ROUNDS;
  return true;
}

function openRound(board, now) {
  board.round = newRound(board.round.index + 1, now);
  for (const rec of board.teams.values()) zeroRecord(rec);
}

function snapshotRound(board) {
  const teams = {};
  for (const [team, rec] of board.teams) {
    if (!rec.spawned && !rec.deaths && !rec.kills) continue;
    teams[team] = {
      spawned: rec.spawned, deaths: rec.deaths, revives: rec.revives,
      kills: rec.kills, teamkills: rec.teamkills, selfKills: rec.selfKills,
      byWeapon: [...rec.byWeapon], byCause: [...rec.byCause],
      byRole: [...rec.byRole], lossesByRole: [...rec.lossesByRole],
    };
  }
  const r = board.round;
  return { index: r.index, winner: r.winner, reason: r.reason, durationMs: roundElapsedMs(board, r.endedAt), teams };
}

// Is the live round decided? Only sides that actually spawned count, and a one-sided sandbox never
// ends. `aliveByTeam` is the caller's living-roster count; callers gate this on auto-add being off.
export function decideRoundOutcome(board, aliveByTeam) {
  const engaged = [];
  for (const [team, rec] of board.teams) if (rec.spawned > 0) engaged.push(team);
  if (engaged.length < 2) return null;
  const survivors = engaged.filter((team) => (aliveByTeam?.[team] ?? 0) > 0);
  if (survivors.length === 1) return { winner: survivors[0], reason: 'wipe' };
  if (survivors.length === 0) return { winner: null, reason: 'mutual' };
  return null;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const labelOf = (labels, team) => (team == null ? '-' : (labels?.[team]?.label ?? labels?.[team] ?? team));

// One HUD line's worth of numbers. `alive` comes from the caller's roster, never from the tally.
export function formatTeamScore(board, team, alive) {
  const rec = teamStats(board, team);
  const parts = [`alive ${alive}`, `spawned ${rec.spawned}`, `lost ${netLosses(rec)}`, `kills ${rec.kills}`];
  if (rec.revives) parts.push(`rev ${rec.revives}`);
  if (rec.teamkills) parts.push(`tk ${rec.teamkills}`);
  return parts.join(' · ');
}

// "bren 4 · m1911 2 · +3 more", biggest first, ties broken by key for a stable readout.
function formatCounts(map) {
  const entries = [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const head = entries.slice(0, BREAKDOWN_TOP).map(([key, n]) => `${key} ${n}`);
  const tail = entries.length - head.length;
  if (tail > 0) head.push(`+${tail} more`);
  return head.join(' · ');
}

// Attribution lines for the panel; empty breakdowns are skipped, so a quiet team prints nothing.
export function formatBreakdownLines(board, team) {
  const rec = teamStats(board, team);
  const rows = [['weapons', rec.byWeapon], ['causes', rec.byCause], ['as role', rec.byRole], ['lost by', rec.lossesByRole]];
  return rows.filter(([, map]) => map.size > 0).map(([label, map]) => `${label.padEnd(8)}${formatCounts(map)}`);
}

export function formatRoundHeader(board, now, labels = null) {
  const r = board.round;
  const clock = formatDuration(roundElapsedMs(board, now));
  if (r.startedAt == null) return `Round ${r.index} · waiting for spawns`;
  if (r.endedAt == null) return `Round ${r.index} · ${clock} · live`;
  const outcome = r.winner ? `${labelOf(labels, r.winner)} wins` : (r.reason === 'mutual' ? 'mutual wipe' : 'cleared');
  return `Round ${r.index} · ${clock} · ${outcome}`;
}

export function formatRoundLine(round, labels = null) {
  const outcome = round.winner ? `${labelOf(labels, round.winner)} wins` : (round.reason === 'mutual' ? 'mutual wipe' : 'cleared');
  const sides = Object.entries(round.teams)
    .map(([team, t]) => `${labelOf(labels, team)} ${t.kills}-${Math.max(0, t.deaths - t.revives)}`)
    .join(' · ');
  return `R${round.index} ${formatDuration(round.durationMs)} · ${outcome}${sides ? ` · ${sides}` : ''}`;
}
