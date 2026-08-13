// check-bot-elevation-gap.mjs -- BB-004 tooling. The state-trace TSV logs x/z per bot but never y
// (see docs/bot-bugs-log.md's trace header list), so a bot's vertical position has never been
// directly observable from a trace file. `target_dist`, however, is a full 3D distance
// (botEye.distanceTo(targetEye), bot-viewer-v2.html:8906, itself a lerp of entity.capsule.start/end
// -- see eyePosInto, bot-viewer-v2.html:6134 -- so it moves with the SAME capsule the x/z columns
// come from). That means whenever a row has both a target_id and a target_dist, the vertical gap
// between observer and target is recoverable: yGap = sqrt(target_dist^2 - xzDist^2), where xzDist
// is computed from the two bots' own logged x/z at matching timestamps.
//
// This is how BB-004 (bots rendering far off the terrain) was confirmed to be the SAME bug as the
// BB-001/002/003 "ghost combatant" family, not a separate co-occurring one: running this against
// the exact trace files those bugs were diagnosed from turns up bot pairs with a multi-hundred-metre
// implied yGap, growing smoothly and monotonically over several real seconds while both bots' own
// x/z barely move -- the shape of unrecovered free fall under bot-entity.js's GRAVITY constant, not
// a one-frame glitch. See docs/bot-bugs-log.md BB-004's update note for the full case study
// (bot-1578 vs bot-1584, bot-states/bot-state-trace-20260803-072210.tsv, t=22050101-22055840).
//
// Usage: node check-bot-elevation-gap.mjs <trace.tsv> [...]
import { readFileSync } from 'node:fs';

const MATCH_TOL_MS = 400; // how stale a target's own position sample may be before we skip the row

// --tol=N overrides the default noise floor. The default (3m) is dominated by routine measurement
// noise (eye-anchor offset, MATCH_TOL_MS position drift) -- most files show a 15-40% flag rate at
// that level across nearly every FSM state, not just knife, so it's the wrong lens for "is this
// state specifically implicated in the severe bug." Rerun with e.g. --tol=30 to isolate the
// smoking-gun-scale events (hundreds of metres) from that background noise.
const args = process.argv.slice(2);
const tolArg = args.find((a) => a.startsWith('--tol='));
const TOL_M = tolArg ? Number(tolArg.slice('--tol='.length)) : 3;
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: node check-bot-elevation-gap.mjs [--tol=N] <trace.tsv> [...]'); process.exit(1); }

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const lines = readFileSync(file, 'utf8').split('\n');
  const header = lines[0].split('\t');
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = lines.slice(1).filter(Boolean).map((line) => line.split('\t'));

  // bot_id -> sorted [{t,x,z}], so a target's position can be looked up at any observer's timestamp.
  const posByBot = new Map();
  for (const f of rows) {
    const id = f[col.bot_id];
    const t = Number(f[col.t_ms]), x = Number(f[col.x]), z = Number(f[col.z]);
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (!posByBot.has(id)) posByBot.set(id, []);
    posByBot.get(id).push({ t, x, z });
  }
  for (const arr of posByBot.values()) arr.sort((a, b) => a.t - b.t);

  function nearestPos(id, t) {
    const arr = posByBot.get(id);
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; }
    const cand = lo > 0 ? [arr[lo], arr[lo - 1]] : [arr[lo]];
    const best = cand.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    return Math.abs(best.t - t) <= MATCH_TOL_MS ? best : null;
  }

  const observerAgg = new Map(); // bot_id -> {maxGap, sumGap, n, atT, withWhom}
  const targetAgg = new Map();
  // Does this happen more during BOT_KNIFE than any other state? Tally the OBSERVER's own FSM
  // state (code[0]) for every eligible row, split into flagged (yGap > TOL) vs total, so we get a
  // per-state flag-RATE rather than a raw count -- knife is rare (last resort, gated on being dry),
  // so raw counts alone would be meaningless without a same-state baseline to compare against.
  const stateTotal = new Map(); // state char -> total eligible rows
  const stateFlagged = new Map(); // state char -> flagged rows
  for (const f of rows) {
    const selfId = f[col.bot_id], targetId = f[col.target_id];
    const td = Number(f[col.target_dist]);
    if (!targetId || !Number.isFinite(td) || td <= 0) continue;
    // Dead-bot heartbeat rows keep re-logging a frozen target_id/target_dist from the moment of
    // death while a still-live target keeps moving -- that's a stale-timestamp artifact, not a real
    // vertical gap (matches check-bot-target-attribution.mjs's own dead-heartbeat exclusion).
    const state = f[col.code]?.[0];
    if (state === 'D') continue;
    const t = Number(f[col.t_ms]);
    const tp = nearestPos(targetId, t);
    if (!tp) continue;
    const xzDist = Math.hypot(Number(f[col.x]) - tp.x, Number(f[col.z]) - tp.z);
    const gapSq = td * td - xzDist * xzDist;
    const yGap = gapSq > 0 ? Math.sqrt(gapSq) : 0;
    stateTotal.set(state, (stateTotal.get(state) ?? 0) + 1);
    if (yGap <= TOL_M) continue;
    stateFlagged.set(state, (stateFlagged.get(state) ?? 0) + 1);
    for (const [agg, id, other] of [[observerAgg, selfId, targetId], [targetAgg, targetId, selfId]]) {
      const rec = agg.get(id) ?? { maxGap: 0, sumGap: 0, n: 0, atT: null, withWhom: null };
      rec.sumGap += yGap; rec.n++;
      if (yGap > rec.maxGap) { rec.maxGap = yGap; rec.atT = t; rec.withWhom = other; }
      agg.set(id, rec);
    }
  }

  const top = (agg) => [...agg.entries()].sort((a, b) => b[1].maxGap - a[1].maxGap).slice(0, 8);
  console.log(`rows with target_id+target_dist parsed; yGap = sqrt(target_dist^2 - xzDist^2), TOL=${TOL_M}m`);
  console.log('Top by OBSERVER (gap could be its own bad Y or the target it looked at -- check both lists):');
  for (const [id, r] of top(observerAgg)) console.log(`  ${id}: maxGap=${r.maxGap.toFixed(1)}m avg=${(r.sumGap / r.n).toFixed(1)}m n=${r.n} (peak t=${r.atT}, vs ${r.withWhom})`);
  console.log('Top by TARGET (gap could be its own bad Y or the observer):');
  for (const [id, r] of top(targetAgg)) console.log(`  ${id}: maxGap=${r.maxGap.toFixed(1)}m avg=${(r.sumGap / r.n).toFixed(1)}m n=${r.n} (peak t=${r.atT}, vs ${r.withWhom})`);
  console.log(`Flag rate by observer's own FSM state (flagged/total, >TOL=${TOL_M}m):`);
  const states = [...stateTotal.keys()].sort((a, b) => (stateFlagged.get(b) ?? 0) / stateTotal.get(b) - (stateFlagged.get(a) ?? 0) / stateTotal.get(a));
  for (const s of states) {
    const total = stateTotal.get(s), flagged = stateFlagged.get(s) ?? 0;
    console.log(`  ${s}: ${flagged}/${total} = ${(100 * flagged / total).toFixed(2)}%`);
  }
}
