// Node tests for squad-activity.js (pure squad AI decision math, Phase 1: loss-retreat, formation).
// Run: node test-squad-activity.mjs
import {
  SQUAD_LOSS_THRESHOLD, rollTemperament, tickSquadLossDecision, formationAngleFor, formationOffset,
} from './squad-activity.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// seeded PRNG (mulberry32) for deterministic sequences
function seededRand(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// rollTemperament: default range stays within [0, 1]
{
  const rand = seededRand(1);
  for (let i = 0; i < 50; i++) {
    const t = rollTemperament(0, 1, rand);
    ok(t >= 0 && t <= 1, `rollTemperament(0,1) stays in bounds (got ${t})`);
  }
}
// rollTemperament: custom range is respected
{
  const rand = seededRand(2);
  for (let i = 0; i < 50; i++) {
    const t = rollTemperament(0.3, 0.7, rand);
    ok(t >= 0.3 && t <= 0.7, `rollTemperament(0.3,0.7) stays in bounds (got ${t})`);
  }
}
// rollTemperament: deterministic given a fixed rand
{
  const t1 = rollTemperament(0, 1, () => 0.5);
  ok(t1 === 0.5, `rollTemperament(0,1) with rand()=0.5 gives midpoint (got ${t1})`);
  const t2 = rollTemperament(10, 20, () => 0.25);
  ok(t2 === 12.5, `rollTemperament(10,20) with rand()=0.25 gives 12.5 (got ${t2})`);
}
// rollTemperament: rand()=0 gives min, rand()=1 gives max (boundary)
{
  ok(rollTemperament(2, 8, () => 0) === 2, 'rollTemperament with rand()=0 gives min');
  ok(rollTemperament(2, 8, () => 1) === 8, 'rollTemperament with rand()=1 gives max');
}

// tickSquadLossDecision: below threshold -> latch cleared, no retreat
{
  const r = tickSquadLossDecision({ initialSize: 10, aliveCount: 8, lossRetreatDecided: false, leaderTemperament: 0.5 });
  ok(r.lossRetreatDecided === false, 'below threshold clears/keeps latch false');
  ok(r.retreat === false, 'below threshold never retreats');
}
// tickSquadLossDecision: below threshold clears an already-set latch (recovery re-arms)
{
  const r = tickSquadLossDecision({ initialSize: 10, aliveCount: 9, lossRetreatDecided: true, leaderTemperament: 0.5 });
  ok(r.lossRetreatDecided === false, 'recovering below threshold clears a previously-set latch');
  ok(r.retreat === false, 'clearing the latch does not itself trigger a retreat');
}
// tickSquadLossDecision: exactly at threshold counts as "at/above" (>=)
{
  // lostFrac = 1 - 6/10 = 0.4 == SQUAD_LOSS_THRESHOLD
  const r = tickSquadLossDecision({ initialSize: 10, aliveCount: 6, lossRetreatDecided: false, leaderTemperament: 0.5, rand: () => 0.999 });
  ok(r.lossRetreatDecided === true, 'exactly at threshold is treated as at/above and decides');
}
// tickSquadLossDecision: at/above threshold, first roll, low rand -> retreats (cautious leader)
{
  // leaderTemperament 0.2 -> retreatChance 0.8; rand()=0.1 < 0.8 -> retreat
  const r = tickSquadLossDecision({ initialSize: 10, aliveCount: 5, lossRetreatDecided: false, leaderTemperament: 0.2, rand: () => 0.1 });
  ok(r.lossRetreatDecided === true, 'at/above threshold sets the latch');
  ok(r.retreat === true, 'low rand under a cautious leader retreat chance triggers retreat');
}
// tickSquadLossDecision: at/above threshold, first roll, high rand -> holds (aggressive leader)
{
  // leaderTemperament 0.9 -> retreatChance 0.1; rand()=0.5 >= 0.1 -> no retreat
  const r = tickSquadLossDecision({ initialSize: 10, aliveCount: 5, lossRetreatDecided: false, leaderTemperament: 0.9, rand: () => 0.5 });
  ok(r.lossRetreatDecided === true, 'at/above threshold sets the latch even when rand does not trigger retreat');
  ok(r.retreat === false, 'high rand against an aggressive leader retreat chance holds the line');
}
// tickSquadLossDecision: both retreat outcomes reachable through a seeded rand stream
{
  const rand = seededRand(42);
  let sawTrue = false, sawFalse = false;
  for (let i = 0; i < 200; i++) {
    const r = tickSquadLossDecision({ initialSize: 10, aliveCount: 5, lossRetreatDecided: false, leaderTemperament: 0.5, rand });
    if (r.retreat) sawTrue = true; else sawFalse = true;
  }
  ok(sawTrue, 'seeded rand stream produces at least one retreat:true across repeated fresh decisions');
  ok(sawFalse, 'seeded rand stream produces at least one retreat:false across repeated fresh decisions');
}
// tickSquadLossDecision: already decided -> no-op, latch stays set, retreat false regardless of rand
{
  const r = tickSquadLossDecision({ initialSize: 10, aliveCount: 5, lossRetreatDecided: true, leaderTemperament: 0.1, rand: () => 0 });
  ok(r.lossRetreatDecided === true, 'already-decided keeps the latch set');
  ok(r.retreat === false, 'already-decided never fires retreat again, even with a rand that would trigger it fresh');
}
// tickSquadLossDecision: full lifecycle -- decide, recover, decide again (latch re-arms)
{
  let state = { lossRetreatDecided: false };
  // drop below threshold, decide (force retreat via low rand + cautious leader)
  state = tickSquadLossDecision({ initialSize: 10, aliveCount: 5, lossRetreatDecided: state.lossRetreatDecided, leaderTemperament: 0.1, rand: () => 0 });
  ok(state.lossRetreatDecided === true && state.retreat === true, 'lifecycle: initial drop decides and retreats');
  // still below threshold next tick -> no-op even with a rand that would otherwise trigger
  state = tickSquadLossDecision({ initialSize: 10, aliveCount: 5, lossRetreatDecided: state.lossRetreatDecided, leaderTemperament: 0.1, rand: () => 0 });
  ok(state.retreat === false, 'lifecycle: still below threshold next tick is a no-op');
  // reinforcements bring the squad back above threshold -> latch clears
  state = tickSquadLossDecision({ initialSize: 10, aliveCount: 9, lossRetreatDecided: state.lossRetreatDecided, leaderTemperament: 0.1 });
  ok(state.lossRetreatDecided === false, 'lifecycle: recovering above threshold clears the latch');
  // drops again -> can decide (and retreat) a second time
  state = tickSquadLossDecision({ initialSize: 10, aliveCount: 5, lossRetreatDecided: state.lossRetreatDecided, leaderTemperament: 0.1, rand: () => 0 });
  ok(state.lossRetreatDecided === true && state.retreat === true, 'lifecycle: a second drop after recovery can retreat again');
}

// formationAngleFor: evenly spaced across the full circle
{
  const memberCount = 4;
  const angles = [0, 1, 2, 3].map((i) => formationAngleFor(i, memberCount));
  ok(angles[0] === 0, `first member is at angle 0 (got ${angles[0]})`);
  for (let i = 1; i < memberCount; i++) {
    const delta = angles[i] - angles[i - 1];
    ok(Math.abs(delta - Math.PI / 2) < 1e-9, `member ${i} is spaced PI/2 from member ${i - 1} (got delta ${delta})`);
  }
}
// formationAngleFor: wraps correctly -- angle at memberIndex === memberCount equals a full turn (2*PI), same direction as 0
{
  const memberCount = 5;
  const wrapped = formationAngleFor(memberCount, memberCount);
  ok(Math.abs(wrapped - Math.PI * 2) < 1e-9, `formationAngleFor(memberCount, memberCount) is a full 2*PI turn (got ${wrapped})`);
}
// formationAngleFor: single-member squad sits at angle 0
{
  ok(formationAngleFor(0, 1) === 0, 'single-member squad is at angle 0');
}

// formationOffset: radius 0 collapses to the leader position regardless of angle
{
  const leaderPos = { x: 5, z: -3 };
  const p = formationOffset(leaderPos, 1.23, 0);
  ok(Math.abs(p.x - leaderPos.x) < 1e-9 && Math.abs(p.z - leaderPos.z) < 1e-9, 'formationOffset with radius 0 collapses to leaderPos');
}
// formationOffset: angle 0 is directly +X from the leader at the given radius
{
  const leaderPos = { x: 0, z: 0 };
  const p = formationOffset(leaderPos, 0, 10);
  ok(Math.abs(p.x - 10) < 1e-9, `angle 0 offsets +X by radius (got x=${p.x})`);
  ok(Math.abs(p.z) < 1e-9, `angle 0 has no Z offset (got z=${p.z})`);
}
// formationOffset: angle PI/2 is directly +Z from the leader at the given radius
{
  const leaderPos = { x: 0, z: 0 };
  const p = formationOffset(leaderPos, Math.PI / 2, 10);
  ok(Math.abs(p.x) < 1e-9, `angle PI/2 has no X offset (got x=${p.x})`);
  ok(Math.abs(p.z - 10) < 1e-9, `angle PI/2 offsets +Z by radius (got z=${p.z})`);
}
// formationOffset: distance from leaderPos always equals radius, for any angle
{
  const leaderPos = { x: 12, z: -7 };
  const radius = 4.5;
  for (let i = 0; i < 8; i++) {
    const angle = formationAngleFor(i, 8);
    const p = formationOffset(leaderPos, angle, radius);
    const dist = Math.hypot(p.x - leaderPos.x, p.z - leaderPos.z);
    ok(Math.abs(dist - radius) < 1e-9, `formationOffset stays exactly radius away from leaderPos (member ${i}, got ${dist})`);
  }
}
// formationOffset: offsets from a non-origin leaderPos translate correctly
{
  const leaderPos = { x: 100, z: 50 };
  const p = formationOffset(leaderPos, 0, 5);
  ok(Math.abs(p.x - 105) < 1e-9 && Math.abs(p.z - 50) < 1e-9, `formationOffset translates with a non-origin leaderPos (got x=${p.x}, z=${p.z})`);
}

// SQUAD_LOSS_THRESHOLD is a sane fraction
ok(SQUAD_LOSS_THRESHOLD > 0 && SQUAD_LOSS_THRESHOLD < 1, 'SQUAD_LOSS_THRESHOLD is a plausible fraction between 0 and 1');

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('squad-activity: all assertions passed');
