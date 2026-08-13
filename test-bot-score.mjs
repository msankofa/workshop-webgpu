// Node tests for the per-team session tally: spawn/death/revive accounting, frag credit
// (cross-team vs teamkill vs self-blast), weapon/cause/role attribution, round lifecycle +
// outcome detection, and the HUD/panel formatters.
// Run: node test-bot-score.mjs
import {
  createScoreboard, teamStats, resetScoreboard, recordSpawn, recordKill, recordRevive,
  netLosses, formatTeamScore, formatBreakdownLines, formatRoundHeader, formatRoundLine,
  formatDuration, finishRound, decideRoundOutcome, roundElapsedMs, MAX_ROUNDS,
} from './bot-score.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

const LABELS = { alpha: { label: 'Alpha' }, bravo: { label: 'Bravo' } };

// ---- fresh board ----
{
  const b = createScoreboard();
  ok([...b.teams.keys()].join(',') === 'alpha,bravo', 'known teams exist in order');
  const a = teamStats(b, 'alpha');
  ok(a.spawned === 0 && a.deaths === 0 && a.revives === 0 && a.kills === 0 && a.teamkills === 0 && a.selfKills === 0,
    'fresh team record is all zeros');
  ok(a.byWeapon.size === 0 && a.byCause.size === 0 && a.byRole.size === 0 && a.lossesByRole.size === 0,
    'fresh breakdowns are empty');
  ok(netLosses(a) === 0, 'no losses on a fresh board');
  ok(b.round.index === 1 && b.round.startedAt == null && b.rounds.length === 0, 'round 1 is open and unstamped');
}

// ---- spawns ----
{
  const b = createScoreboard();
  recordSpawn(b, 'alpha', 1, 1000);
  recordSpawn(b, 'alpha', 4, 1500);
  recordSpawn(b, 'bravo', 0, 1600);
  recordSpawn(b, 'bravo', -3, 1600);   // nonsense counts are floored to 0, never negative
  recordSpawn(b, 'bravo', '2', 1700);  // input widgets hand over strings
  ok(teamStats(b, 'alpha').spawned === 5, 'spawn counts accumulate');
  ok(teamStats(b, 'bravo').spawned === 2, 'zero/negative spawns are no-ops, strings coerce');
  ok(b.round.startedAt === 1000, 'the first real spawn stamps the round start');
}

// ---- kills: cross-team frag credit ----
{
  const b = createScoreboard();
  recordSpawn(b, 'alpha', 3, 0); recordSpawn(b, 'bravo', 3, 0);
  recordKill(b, 'bravo', 'alpha');
  recordKill(b, 'bravo', 'alpha');
  recordKill(b, 'alpha', 'bravo');
  const a = teamStats(b, 'alpha'), v = teamStats(b, 'bravo');
  ok(a.kills === 2 && a.deaths === 1, 'alpha scored 2, lost 1');
  ok(v.kills === 1 && v.deaths === 2, 'bravo scored 1, lost 2');
  ok(a.teamkills === 0 && v.teamkills === 0, 'clean fight has no teamkills');
  ok(netLosses(a) === 1 && netLosses(v) === 2, 'net losses match deaths with no revives');
}

// ---- kills: teamkill, self-blast, and unknown killer ----
{
  const b = createScoreboard();
  recordKill(b, 'alpha', 'alpha', { weapon: 'bren', cause: 'bullet' });      // friendly fire
  recordKill(b, 'alpha', 'alpha', { selfKill: true, weapon: 'grenade' });    // own grenade
  recordKill(b, 'bravo', null);                                             // world/unattributed death
  const a = teamStats(b, 'alpha');
  ok(a.deaths === 2, 'both friendly-fire deaths count as alpha losses');
  ok(a.kills === 0, 'friendly fire never scores a frag');
  ok(a.teamkills === 2 && a.selfKills === 1, 'teamkills include the self-blast, tracked separately too');
  ok(a.byWeapon.size === 0 && a.byCause.size === 0, 'friendly fire is kept out of the frag attribution');
  ok(teamStats(b, 'bravo').deaths === 1 && teamStats(b, 'bravo').kills === 0, 'a null killer credits nobody');
}

// ---- attribution: weapon / cause / killer role / victim role ----
{
  const b = createScoreboard();
  recordKill(b, 'bravo', 'alpha', { weapon: 'bren', cause: 'bullet', killerRole: 'rifle', victimRole: 'medic' });
  recordKill(b, 'bravo', 'alpha', { weapon: 'bren', cause: 'bullet', killerRole: 'rifle', victimRole: 'rifle' });
  recordKill(b, 'bravo', 'alpha', { weapon: 'grenade', cause: 'blast', killerRole: 'medic', victimRole: 'rifle' });
  recordKill(b, 'bravo', 'alpha', { weapon: null, cause: 'knife' });   // missing fields never create a key
  const a = teamStats(b, 'alpha'), v = teamStats(b, 'bravo');
  ok(a.byWeapon.get('bren') === 2 && a.byWeapon.get('grenade') === 1 && a.byWeapon.size === 2, 'frags tally per weapon');
  ok(a.byCause.get('bullet') === 2 && a.byCause.get('blast') === 1 && a.byCause.get('knife') === 1, 'frags tally per cause');
  ok(a.byRole.get('rifle') === 2 && a.byRole.get('medic') === 1, 'frags tally per killer role');
  ok(v.lossesByRole.get('rifle') === 2 && v.lossesByRole.get('medic') === 1, 'losses tally on the victim role');
  ok(a.kills === 4, 'all four frags counted regardless of missing attribution');
}

// ---- revives ----
{
  const b = createScoreboard();
  recordSpawn(b, 'alpha', 2, 0);
  recordKill(b, 'alpha', 'bravo');
  recordKill(b, 'alpha', 'bravo');
  recordRevive(b, 'alpha');
  const a = teamStats(b, 'alpha');
  ok(a.deaths === 2 && a.revives === 1, 'a revive does not erase the death');
  ok(netLosses(a) === 1, 'net losses discount revives');
  recordRevive(b, 'alpha'); recordRevive(b, 'alpha');   // more revives than deaths cannot go negative
  ok(netLosses(a) === 0, 'net losses clamp at 0');
  ok(teamStats(b, 'bravo').kills === 2, 'the killer keeps the frags after a revive');
}

// ---- unknown teams are created lazily ----
{
  const b = createScoreboard();
  recordKill(b, 'charlie', 'delta');
  ok(teamStats(b, 'charlie').deaths === 1 && teamStats(b, 'delta').kills === 1, 'unseen teams are tracked');
  recordSpawn(b, undefined, 2, 0);
  ok(teamStats(b, undefined).spawned === 2 && teamStats(b, 'unknown').spawned === 2, 'a missing team is the unknown bucket');
}

// ---- round lifecycle ----
{
  const b = createScoreboard();
  ok(finishRound(b, { now: 500 }) === false, 'a round nobody spawned into is not archived');
  ok(b.round.endedAt == null, 'the empty round stays open');

  recordSpawn(b, 'alpha', 4, 1000); recordSpawn(b, 'bravo', 4, 1000);
  recordKill(b, 'bravo', 'alpha', { weapon: 'bren', cause: 'bullet' });
  ok(roundElapsedMs(b, 61000) === 60000, 'elapsed runs off the round start while live');

  ok(finishRound(b, { now: 61000, winner: 'alpha', reason: 'wipe' }) === true, 'a fought round archives');
  ok(finishRound(b, { now: 62000 }) === false, 'finishing twice is a no-op');
  ok(b.rounds.length === 1 && b.rounds[0].index === 1, 'the archived round is on the stack');
  ok(b.rounds[0].winner === 'alpha' && b.rounds[0].durationMs === 60000, 'archive keeps winner + duration');
  ok(b.rounds[0].teams.alpha.kills === 1 && b.rounds[0].teams.bravo.deaths === 1, 'archive keeps both sides');
  ok(Array.isArray(b.rounds[0].teams.alpha.byWeapon) && b.rounds[0].teams.alpha.byWeapon[0][0] === 'bren',
    'archived breakdowns are plain arrays, not live Maps');
  ok(teamStats(b, 'alpha').kills === 1, 'counters survive the finish so the HUD can show the result');
  ok(roundElapsedMs(b, 99000) === 60000, 'a finished round clock stops at its end');

  recordSpawn(b, 'alpha', 2, 70000);
  ok(b.round.index === 2 && b.round.startedAt === 70000 && b.round.endedAt == null, 'the next spawn opens round 2');
  ok(teamStats(b, 'alpha').kills === 0 && teamStats(b, 'alpha').spawned === 2, 'round 2 starts from zero');
  ok(teamStats(b, 'alpha').byWeapon.size === 0, 'breakdowns are cleared with the counters');
  ok(b.rounds[0].teams.alpha.kills === 1, 'the archived snapshot is untouched by the new round');
}

// ---- round history is capped, newest first ----
{
  const b = createScoreboard();
  for (let i = 0; i < MAX_ROUNDS + 3; i++) {
    recordSpawn(b, 'alpha', 1, i * 1000);
    finishRound(b, { now: i * 1000 + 500, winner: 'alpha', reason: 'wipe' });
  }
  ok(b.rounds.length === MAX_ROUNDS, 'history is capped');
  ok(b.rounds[0].index === MAX_ROUNDS + 3, 'newest round is first');
  ok(b.rounds[b.rounds.length - 1].index === 4, 'oldest rounds are dropped');
}

// ---- outcome detection ----
{
  const b = createScoreboard();
  ok(decideRoundOutcome(b, { alpha: 0, bravo: 0 }) === null, 'nothing spawned = no outcome');
  recordSpawn(b, 'alpha', 3, 0);
  ok(decideRoundOutcome(b, { alpha: 0 }) === null, 'a one-sided sandbox never decides');
  recordSpawn(b, 'bravo', 3, 0);
  ok(decideRoundOutcome(b, { alpha: 3, bravo: 3 }) === null, 'both sides alive = still fighting');
  ok(decideRoundOutcome(b, { alpha: 2, bravo: 0 })?.winner === 'alpha', 'last side standing wins');
  ok(decideRoundOutcome(b, { alpha: 2, bravo: 0 })?.reason === 'wipe', 'wipe is the reason');
  const mutual = decideRoundOutcome(b, { alpha: 0, bravo: 0 });
  ok(mutual && mutual.winner === null && mutual.reason === 'mutual', 'everyone dead = mutual wipe');
  ok(decideRoundOutcome(b, {})?.reason === 'mutual', 'a missing alive count reads as zero');
}

// ---- reset ----
{
  const b = createScoreboard();
  recordSpawn(b, 'alpha', 4, 0); recordKill(b, 'alpha', 'bravo', { weapon: 'bren' }); recordRevive(b, 'alpha');
  finishRound(b, { now: 1000, winner: 'bravo', reason: 'wipe' });
  resetScoreboard(b, { keepHistory: true });
  ok(b.rounds.length === 1, 'keepHistory spares the archive');
  ok(b.round.index === 1 && b.round.startedAt == null, 'reset reopens at round 1');
  ok(teamStats(b, 'bravo').kills === 0 && teamStats(b, 'bravo').byWeapon.size === 0, 'counters and breakdowns zeroed');
  resetScoreboard(b);
  ok(b.rounds.length === 0, 'a plain reset drops the history too');
  ok(b.teams.has('alpha') && b.teams.has('bravo'), 'reset keeps the team records themselves');
}

// ---- formatters ----
{
  ok(formatDuration(0) === '00:00' && formatDuration(61000) === '01:01' && formatDuration(-5) === '00:00',
    'duration formats mm:ss and clamps');

  const b = createScoreboard();
  recordSpawn(b, 'alpha', 6, 0);
  ok(formatTeamScore(b, 'alpha', 6) === 'alive 6 · spawned 6 · lost 0 · kills 0', 'quiet line omits rev/tk');
  ok(formatBreakdownLines(b, 'alpha').length === 0, 'no breakdown lines before any kills');
  ok(formatRoundHeader(b, 5000, LABELS) === 'Round 1 · 00:05 · live', 'live header shows the running clock');

  recordKill(b, 'bravo', 'alpha', { weapon: 'bren', cause: 'bullet', killerRole: 'rifle', victimRole: 'medic' });
  recordKill(b, 'alpha', 'bravo', { weapon: 'm1911', cause: 'bullet', killerRole: 'rifle', victimRole: 'rifle' });
  recordRevive(b, 'alpha');
  recordKill(b, 'alpha', 'alpha');
  ok(formatTeamScore(b, 'alpha', 5) === 'alive 5 · spawned 6 · lost 1 · kills 1 · rev 1 · tk 1',
    `line adds rev/tk once they happen (got: ${formatTeamScore(b, 'alpha', 5)})`);
  const lines = formatBreakdownLines(b, 'alpha');
  ok(lines[0] === 'weapons bren 1' && lines[1] === 'causes  bullet 1' && lines[2] === 'as role rifle 1',
    `breakdown lines are label-padded (got: ${JSON.stringify(lines)})`);
  ok(lines[3] === 'lost by rifle 1', 'the victim-role line is included');

  finishRound(b, { now: 90000, winner: 'alpha', reason: 'wipe' });
  ok(formatRoundHeader(b, 99000, LABELS) === 'Round 1 · 01:30 · Alpha wins', 'finished header names the winner');
  ok(formatRoundLine(b.rounds[0], LABELS) === 'R1 01:30 · Alpha wins · Alpha 1-1 · Bravo 1-1',
    `round line reads kills-losses per side (got: ${formatRoundLine(b.rounds[0], LABELS)})`);
  ok(formatRoundHeader(createScoreboard(), 0, LABELS) === 'Round 1 · waiting for spawns', 'unstarted round says so');
}

// ---- breakdown ordering + tail folding ----
{
  const b = createScoreboard();
  for (const [w, n] of [['bren', 5], ['m1911', 3], ['knife', 2], ['rpg', 2], ['grenade', 1], ['five_seven', 1]]) {
    for (let i = 0; i < n; i++) recordKill(b, 'bravo', 'alpha', { weapon: w });
  }
  const weapons = formatBreakdownLines(b, 'alpha')[0];
  ok(weapons === 'weapons bren 5 · m1911 3 · knife 2 · rpg 2 · +2 more',
    `biggest first, ties by name, tail folded (got: ${weapons})`);
}

if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('bot-score tests passed');
