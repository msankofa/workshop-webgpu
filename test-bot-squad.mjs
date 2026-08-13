// Node tests for bot-squad.js (pure roster partitioning, leader succession, formation geometry).
// Run: node test-bot-squad.mjs
import {
  SQUAD_MAX_SIZE, SUCCESSION_SHOCK_MS, FORMATION_KINDS, SQUAD_DEFAULTS,
  SQUAD_MERGE_MAX, DETACHMENT_MIN, SQUAD_SPLIT_TOTAL, SQUAD_MERGE_RADIUS, planSquadReconcile,
  partitionSquadSizes, squadRoleTemplate, dealSquadChunks, formationRanks, electSquadLeader, stepSquadSuccession,
  chooseFormationKind, formationOffsetLocal, ringAngleFor, squadSlotWorld,
  squadMemberGoal, formationHalfWidth,
  squadHaltRequest, BUSY_DRONE_SERVICE, BUSY_MEDIC_TEND, BUSY_ENGAGED, SQUAD_HALT_MAX_MS,
} from './bot-squad.js';
import { ROLE_RIFLEMAN, ROLE_MEDIC, ROLE_SQUAD_LEADER, squadRanks } from './bot-roles.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// ---- roster partitioning ----
ok(partitionSquadSizes(0).length === 0, 'no bots -> no squads');
ok(JSON.stringify(partitionSquadSizes(1)) === '[1]', 'one bot -> one squad of one');
ok(JSON.stringify(partitionSquadSizes(8)) === '[8]', 'a full squad stays whole');
ok(JSON.stringify(partitionSquadSizes(11)) === '[6,5]', '11 balances to 6+5 rather than 8+3');
ok(JSON.stringify(partitionSquadSizes(16)) === '[8,8]', '16 -> two full squads');
ok(JSON.stringify(partitionSquadSizes(17)) === '[6,6,5]', '17 balances across three squads');
ok(JSON.stringify(partitionSquadSizes(9, 4)) === '[3,3,3]', 'a custom cap is respected');
for (const n of [1, 5, 8, 9, 23, 64]) {
  const sizes = partitionSquadSizes(n);
  ok(sum(sizes) === n, `partition of ${n} keeps every bot`);
  ok(sizes.every((s) => s <= SQUAD_MAX_SIZE), `partition of ${n} never exceeds the max size`);
  ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `partition of ${n} is balanced within one`);
}

// ---- role template ----
{
  const roles = squadRoleTemplate(8, { medicPercent: 25 });
  ok(roles.length === 8, 'template covers the whole squad');
  ok(roles[0] === ROLE_SQUAD_LEADER, 'slot 0 is the squad leader');
  ok(roles.filter((r) => r === ROLE_SQUAD_LEADER).length === 1, 'exactly one leader per squad');
  ok(roles.includes(ROLE_MEDIC), 'the medic share still lands in the squad');
  ok(squadRoleTemplate(0).length === 0, 'an empty squad has no roles');
  ok(JSON.stringify(squadRoleTemplate(1)) === JSON.stringify([ROLE_SQUAD_LEADER]), 'a squad of one is its own leader');
  ok(squadRoleTemplate(4, { medicPercent: 0 }).slice(1).every((r) => r === ROLE_RIFLEMAN), '0% medics -> riflemen behind the leader');
}

// ---- election ----
{
  const members = [
    { id: 'bot-3', role: ROLE_RIFLEMAN, alive: true },
    { id: 'bot-1', role: ROLE_SQUAD_LEADER, alive: true },
    { id: 'bot-2', role: ROLE_MEDIC, alive: true },
  ];
  ok(electSquadLeader(members).id === 'bot-1', 'the dedicated leader outranks a rifleman');
  const noLeader = members.filter((m) => m.role !== ROLE_SQUAD_LEADER);
  ok(electSquadLeader(noLeader).id === 'bot-3', 'a rifleman outranks a medic');
  ok(electSquadLeader([{ id: 'bot-9', role: ROLE_MEDIC, alive: true }]).id === 'bot-9', 'an all-medic squad still elects someone');
  const deadLeader = members.map((m) => (m.id === 'bot-1' ? { ...m, alive: false } : m));
  ok(electSquadLeader(deadLeader).id === 'bot-3', 'a dead leader is never elected');
  ok(electSquadLeader([]) === null, 'an empty roster elects nobody');
  ok(electSquadLeader(members.map((m) => ({ ...m, alive: false }))) === null, 'a wiped squad elects nobody');
  const tie = [{ id: 'bot-7', role: ROLE_RIFLEMAN, alive: true }, { id: 'bot-4', role: ROLE_RIFLEMAN, alive: true }];
  ok(electSquadLeader(tie).id === 'bot-4', 'ties break on the lowest id, so the pick is stable');
}

// ---- succession ----
{
  const alive = [{ id: 'a', role: ROLE_SQUAD_LEADER, alive: true }, { id: 'b', role: ROLE_RIFLEMAN, alive: true }];
  const held = stepSquadSuccession({ leaderId: 'a', members: alive, now: 1000 });
  ok(held.leaderId === 'a' && !held.changed && !held.shocked, 'a living leader keeps command');

  const dead = [{ id: 'a', role: ROLE_SQUAD_LEADER, alive: false }, { id: 'b', role: ROLE_RIFLEMAN, alive: true }];
  const s1 = stepSquadSuccession({ leaderId: 'a', members: dead, now: 1000 });
  ok(s1.leaderId === null && s1.shocked, 'a dead leader leaves the squad leaderless');
  ok(s1.shockUntil === 1000 + SUCCESSION_SHOCK_MS, 'the shock window opens on the death tick');

  const s2 = stepSquadSuccession({ leaderId: null, members: dead, now: 1500, shockUntil: s1.shockUntil });
  ok(s2.leaderId === null && s2.shocked && !s2.changed, 'nobody is promoted mid-shock');

  const s3 = stepSquadSuccession({ leaderId: null, members: dead, now: 1000 + SUCCESSION_SHOCK_MS, shockUntil: s1.shockUntil });
  ok(s3.leaderId === 'b' && s3.changed && !s3.shocked, 'the successor takes over once the shock expires');
  ok(s3.shockUntil === 0, 'succession clears the shock window');

  const revived = stepSquadSuccession({ leaderId: 'b', members: [{ id: 'b', role: ROLE_RIFLEMAN, alive: true }], now: 9000, shockUntil: 0 });
  ok(revived.leaderId === 'b' && !revived.shocked, 'a settled successor holds command');

  const wiped = stepSquadSuccession({ leaderId: 'a', members: [{ id: 'a', role: ROLE_SQUAD_LEADER, alive: false }], now: 1000 });
  ok(wiped.leaderId === null && !wiped.shocked && wiped.shockUntil === 0, 'a wiped squad needs no shock window');
}

// ---- formation choice ----
ok(chooseFormationKind({ manual: 'ring' }) === 'ring', 'a manual pick wins outright');
ok(chooseFormationKind({ manual: 'ring', engaged: true, corridorClear: false }) === 'ring', 'a manual pick beats both auto rules');
ok(chooseFormationKind({ manual: 'auto', engaged: true }) === 'line', 'contact brings the squad abreast');
ok(chooseFormationKind({ manual: 'auto', engaged: true, corridorClear: false }) === 'line', 'contact outranks corridor width');
ok(chooseFormationKind({ manual: 'auto', corridorClear: false }) === 'column', 'a tight corridor collapses to single file');
ok(chooseFormationKind({ manual: 'auto', corridorClear: true }) === 'wedge', 'open ground defaults to a wedge');
ok(chooseFormationKind({ manual: 'nonsense' }) === 'wedge', 'an unknown manual kind falls back to auto');
ok(chooseFormationKind() === 'wedge', 'no arguments is open-ground default');

// ---- local slot geometry ----
for (const kind of FORMATION_KINDS) {
  const o = formationOffsetLocal(kind, 0, 4);
  ok(o.right === 0 && o.back === 0, `${kind}: the leader sits at the formation origin`);
}
{
  const sp = 2;
  ok(formationOffsetLocal('column', 3, 8, sp).back === 6, 'column stacks straight back');
  ok(formationOffsetLocal('column', 3, 8, sp).right === 0, 'column has no lateral spread');
  const l1 = formationOffsetLocal('line', 1, 8, sp), l2 = formationOffsetLocal('line', 2, 8, sp);
  ok(l1.back === 0 && l2.back === 0, 'a line stays abreast of the leader');
  ok(l1.right === sp && l2.right === -sp, 'a line alternates sides at equal spacing');
  const w1 = formationOffsetLocal('wedge', 1, 8, sp), w4 = formationOffsetLocal('wedge', 4, 8, sp);
  ok(w1.right === sp && w1.back === sp, 'a wedge opens at 45 degrees');
  ok(w4.right === -2 * sp && w4.back === 2 * sp, 'a wedge widens and deepens by tier');
  ok(Math.sign(formationOffsetLocal('wedge', 1, 8, sp).right) !== Math.sign(formationOffsetLocal('wedge', 2, 8, sp).right),
    'consecutive wedge ranks take opposite shoulders');
}

// ---- world placement ----
{
  const leaderPos = { x: 10, z: -4 };
  const at0 = squadSlotWorld({ kind: 'wedge', leaderPos, rank: 0, count: 4 });
  ok(at0.x === 10 && at0.z === -4, 'rank 0 resolves to the leader position itself');
  ok(squadSlotWorld({ leaderPos: null, rank: 1 }) === null, 'no leader position -> no slot');

  // heading 0 faces +Z, so "back" is -Z and the right shoulder is -X.
  const col = squadSlotWorld({ kind: 'column', leaderPos: { x: 0, z: 0 }, headingRad: 0, rank: 2, count: 4, spacing: 3 });
  ok(near(col.x, 0) && near(col.z, -6), 'at heading 0 a column trails along -Z');
  const line = squadSlotWorld({ kind: 'line', leaderPos: { x: 0, z: 0 }, headingRad: 0, rank: 1, count: 4, spacing: 3 });
  ok(near(line.x, -3) && near(line.z, 0), 'at heading 0 the right shoulder is -X');

  // turning the leader 90 degrees rotates the whole formation with it.
  const turned = squadSlotWorld({ kind: 'column', leaderPos: { x: 0, z: 0 }, headingRad: Math.PI / 2, rank: 1, count: 4, spacing: 3 });
  ok(near(turned.x, -3, 1e-9) && near(turned.z, 0, 1e-9), 'facing +X, the column trails along -X');

  // slot distance from the leader is heading-invariant.
  for (const headingRad of [0, 0.7, Math.PI, -2.2]) {
    const p = squadSlotWorld({ kind: 'wedge', leaderPos: { x: 5, z: 5 }, headingRad, rank: 3, count: 8, spacing: 2 });
    ok(near(Math.hypot(p.x - 5, p.z - 5), Math.hypot(4, 4), 1e-9), `wedge slot distance is stable at heading ${headingRad}`);
  }

  // a ring is world-anchored, so it does not spin when the leader turns.
  const r1 = squadSlotWorld({ kind: 'ring', leaderPos: { x: 0, z: 0 }, headingRad: 0, rank: 1, count: 4, spacing: 2 });
  const r2 = squadSlotWorld({ kind: 'ring', leaderPos: { x: 0, z: 0 }, headingRad: 1.3, rank: 1, count: 4, spacing: 2 });
  ok(near(r1.x, r2.x) && near(r1.z, r2.z), 'ring slots ignore the leader heading');
  ok(near(Math.hypot(r1.x, r1.z), 2 * SQUAD_DEFAULTS.ringScale, 1e-9), 'ring radius scales off spacing');
  const fixed = squadSlotWorld({ kind: 'ring', leaderPos: { x: 0, z: 0 }, rank: 2, count: 4, spacing: 2, ringRadius: 7 });
  ok(near(Math.hypot(fixed.x, fixed.z), 7, 1e-9), 'an explicit ring radius overrides the scale');
  ok(near(ringAngleFor(2, 4), Math.PI), 'ring angles spread evenly around the circle');
}

// ---- member goal ----
{
  const leaderPos = { x: 0, z: 0 };
  ok(squadMemberGoal({ leaderPos: null, selfPos: { x: 0, z: 0 } }) === null, 'no leader -> no goal');
  const far = squadMemberGoal({ kind: 'column', leaderPos, headingRad: 0, rank: 1, count: 4, spacing: 3, selfPos: { x: 20, z: 20 } });
  ok(far.regrouping && near(far.x, 0) && near(far.z, 0), 'a strayed member heads for the leader, not its slot');
  const close = squadMemberGoal({ kind: 'column', leaderPos, headingRad: 0, rank: 1, count: 4, spacing: 3, selfPos: { x: 0, z: -3 } });
  ok(!close.regrouping && close.arrived, 'a member standing on its slot has arrived');
  const walking = squadMemberGoal({ kind: 'column', leaderPos, headingRad: 0, rank: 1, count: 4, spacing: 3, selfPos: { x: 0, z: 2 } });
  ok(!walking.arrived, 'a member off its slot is still walking');
  const noSelf = squadMemberGoal({ kind: 'column', leaderPos, headingRad: 0, rank: 1, count: 4, spacing: 3 });
  ok(noSelf && !noSelf.arrived && !noSelf.regrouping, 'an unknown position never claims arrival');
}

// ---- corridor fit ----
ok(formationHalfWidth('column', 8) === 0, 'a column needs no extra width');
ok(formationHalfWidth('wedge', 1) === 0, 'a lone bot needs no extra width');
ok(formationHalfWidth('line', 5, 2) === 4, 'a line of five spans two tiers either side');
ok(formationHalfWidth('wedge', 8, 2) === 8, 'a full wedge spans four tiers either side');
ok(formationHalfWidth('ring', 8, 2) === 2 * SQUAD_DEFAULTS.ringScale, 'a ring needs its radius');

// ---- spawn layout <-> roster alignment ----
// spawnBots lays a batch out as [joining reinforcements, ...one run per new squad] and then slices
// the spawned actors back apart by exactly those lengths. If the two ever disagree the wrong bot
// leads its squad, so the layout invariant is pinned here: every run must start on a leader.
{
  for (const [joining, total] of [[0, 8], [3, 11], [5, 5], [2, 17], [0, 1]]) {
    const sizes = partitionSquadSizes(total - joining, SQUAD_MAX_SIZE);
    const roles = [
      ...new Array(joining).fill(ROLE_RIFLEMAN),
      ...sizes.flatMap((size) => squadRoleTemplate(size, { medicPercent: 0 })),
    ];
    ok(roles.length === total, `layout covers the whole batch (${joining}/${total})`);
    let at = joining;
    for (const size of sizes) {
      ok(roles[at] === ROLE_SQUAD_LEADER, `run at ${at} starts on a leader (${joining}/${total})`);
      ok(!roles.slice(at + 1, at + size).includes(ROLE_SQUAD_LEADER), `run at ${at} holds exactly one leader`);
      at += size;
    }
    ok(at === total, `runs consume the batch exactly (${joining}/${total})`);
    ok(!roles.slice(0, joining).includes(ROLE_SQUAD_LEADER), 'reinforcements never carry a spare leader');
  }
}

// ---- dealing a spawned batch into squads ----
{
  const isLeader = (m) => m.role === ROLE_SQUAD_LEADER;
  const batch = (roles) => roles.map((role, i) => ({ id: `b${i}`, role }));

  // The layout spawnBots generates itself: leaders already sit at the head of each run, so dealing
  // has to reproduce the plain slice exactly or it would reshuffle who fights alongside whom.
  const generated = batch(partitionSquadSizes(11, 8).flatMap((size) => squadRoleTemplate(size, { medicPercent: 0 })));
  const dealt = dealSquadChunks(generated, partitionSquadSizes(11, 8), isLeader);
  ok(dealt.length === 2 && dealt[0].length === 6 && dealt[1].length === 5, 'dealing honours the planned sizes');
  ok(dealt[0][0].id === 'b0' && dealt[1][0].id === 'b6', 'a generated layout deals exactly like a plain slice');

  // Caller-supplied roles (auto-add waves, scene shuffle): both leaders sit at the front, so a slice
  // would put them in one squad and leave the other leaderless.
  const supplied = batch([ROLE_SQUAD_LEADER, ROLE_SQUAD_LEADER, ROLE_RIFLEMAN, ROLE_MEDIC, ROLE_RIFLEMAN, ROLE_RIFLEMAN]);
  const spread = dealSquadChunks(supplied, [3, 3], isLeader);
  ok(spread.every((chunk) => chunk.filter(isLeader).length === 1), 'each squad gets exactly one leader-role bot');
  ok(spread.flat().length === 6, 'dealing places every member');
  ok(new Set(spread.flat().map((m) => m.id)).size === 6, 'no member lands in two squads');

  // More leaders than squads: the surplus has to fall in somewhere rather than vanish.
  const heavy = dealSquadChunks(batch(new Array(4).fill(ROLE_SQUAD_LEADER)), [2, 2], isLeader);
  ok(heavy.flat().length === 4, 'surplus leaders still get placed');

  ok(dealSquadChunks(batch([ROLE_RIFLEMAN, ROLE_RIFLEMAN]), [2], isLeader)[0].length === 2,
    'a batch with no leader role still forms its squad');
  ok(dealSquadChunks([], [4], isLeader).length === 0, 'no members, no squads');
  ok(dealSquadChunks(batch([ROLE_RIFLEMAN]), [], isLeader).length === 0, 'no planned sizes, no squads');
  // Short batch: the last chunk takes what is left instead of forming an empty squad.
  const short = dealSquadChunks(batch([ROLE_SQUAD_LEADER, ROLE_RIFLEMAN, ROLE_RIFLEMAN]), [2, 2], isLeader);
  ok(short.length === 2 && short[1].length === 1, 'a short batch still fills as far as it reaches');
}

// ---- formation order puts support at the back ----
{
  const m = (id, role) => ({ id, role, alive: true });
  // Ids are ordered so a plain id sort would put the medic at rank 1 -- the point of the wedge.
  const members = [m('a', ROLE_SQUAD_LEADER), m('b', ROLE_MEDIC), m('c', ROLE_RIFLEMAN), m('d', ROLE_RIFLEMAN)];
  const ranks = formationRanks(members, 'a');
  ok(ranks[0] === 'a', 'the leader keeps the point');
  ok(ranks[ranks.length - 1] === 'b', 'the medic falls in at the back');
  ok(ranks.length === 4 && new Set(ranks).size === 4, 'every member gets exactly one slot');
  ok(squadRanks(members, 'a')[1] === 'b', 'plain id ranking really would have put the medic on point');

  const twoMedics = formationRanks([m('a', ROLE_RIFLEMAN), m('b', ROLE_MEDIC), m('c', ROLE_MEDIC), m('d', ROLE_RIFLEMAN)], 'a');
  ok(twoMedics.slice(2).every((id) => id === 'b' || id === 'c'), 'all support falls in behind the line');
  const allMedic = formationRanks([m('a', ROLE_MEDIC), m('b', ROLE_MEDIC), m('c', ROLE_MEDIC)], 'a');
  ok(allMedic[0] === 'a' && allMedic.length === 3, 'an all-support squad still has its elected leader on point');
  ok(formationRanks([m('a', ROLE_SQUAD_LEADER), m('b', ROLE_MEDIC)], 'a')[0] === 'a', 'a pair needs no reordering');
}

// ---- reconciling the field into sensibly-sized squads ----
{
  // Snapshot builder. `seq` ascending = older; squads sit at the origin unless moved.
  const snap = (id, seq, core, extra = {}) => ({
    id, team: 'a', seq, x: 0, z: 0, hasLeader: true, leaderId: core[0],
    core: [...core], detach: [], detachSeq: 0, detachLeaderId: null, ...extra,
  });
  const only = (ops, op) => ops.filter((o) => o.op === op);

  // Applies a plan back onto snapshots, so a settled field can be re-planned and shown to be stable.
  function applyOps(squads, loose, ops) {
    const byId = new Map(squads.map((s) => [s.id, s]));
    let born = 1000;
    const spawn = (memberIds, leaderId, team) => {
      const fresh = snap(`new-${born}`, born++, memberIds, { team, leaderId });
      squads.push(fresh);
      byId.set(fresh.id, fresh);
    };
    for (const op of ops) {
      if (op.op === 'split' || op.op === 'mergeDetachments') {
        const parents = op.op === 'split' ? [byId.get(op.squadId)] : op.squadIds.map((id) => byId.get(id));
        for (const parent of parents) { parent.detach = []; parent.detachLeaderId = null; parent.detachSeq = 0; }
        spawn(op.memberIds, op.leaderId, parents[0].team);
      } else if (op.op === 'merge') {
        const into = byId.get(op.intoId), from = byId.get(op.fromId);
        into.core = [...op.coreIds]; into.detach = [...op.detachIds];
        into.detachLeaderId = op.detachLeaderId;
        if (into.detach.length && !into.detachSeq) into.detachSeq = born++;
        squads.splice(squads.indexOf(from), 1); byId.delete(from.id);
      } else if (op.op === 'absorb') {
        const target = byId.get(op.squadId);
        (op.toDetachment ? target.detach : target.core).push(op.memberId);
        if (op.toDetachment && !target.detachSeq) { target.detachSeq = born++; target.detachLeaderId ??= op.memberId; }
        loose.splice(loose.findIndex((b) => b.id === op.memberId), 1);
      }
    }
    return squads;
  }

  // --- merging understrength squads ---
  {
    const squads = [snap('old', 1, ['a1', 'a2', 'a3']), snap('young', 2, ['b1', 'b2', 'b3'])];
    const merges = only(planSquadReconcile({ squads, loose: [] }), 'merge');
    ok(merges.length === 1, 'two understrength squads in range merge');
    ok(merges[0].intoId === 'old' && merges[0].fromId === 'young', 'the older squad absorbs the younger');
    ok(merges[0].coreIds.length === 6 && !merges[0].detachIds.length, 'six fit in one core');
    ok(merges[0].heirId === 'b1', 'the merging leader becomes next in line');
  }
  {
    const squads = [snap('old', 1, ['a1', 'a2', 'a3']), snap('young', 2, ['b1', 'b2', 'b3'], { x: SQUAD_MERGE_RADIUS + 5 })];
    ok(!only(planSquadReconcile({ squads, loose: [] }), 'merge').length, 'squads out of range never merge');
  }
  {
    const squads = [snap('a', 1, ['a1', 'a2', 'a3']), snap('b', 2, ['b1', 'b2', 'b3'], { team: 'b' })];
    ok(!only(planSquadReconcile({ squads, loose: [] }), 'merge').length, 'squads on opposing teams never merge');
  }
  {
    const full = snap('full', 1, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
    const small = snap('small', 2, ['b1', 'b2', 'b3', 'b4']);
    ok(!only(planSquadReconcile({ squads: [full, small], loose: [] }), 'merge').length,
      'a full core is not a merge target -- the detachment would split straight back out');
  }
  {
    // A squad big enough to stand on its own is left alone, however close it is.
    const squads = [snap('a', 1, ['a1', 'a2', 'a3', 'a4', 'a5']), snap('b', 2, ['b1', 'b2', 'b3', 'b4', 'b5'])];
    ok(!only(planSquadReconcile({ squads, loose: [] }), 'merge').length, `squads above ${SQUAD_MERGE_MAX} stay independent`);
  }
  {
    // Overflow: the joiners fill the core, and their leader takes the detachment it will lead out.
    const squads = [snap('old', 1, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']), snap('young', 2, ['b1', 'b2', 'b3', 'b4'])];
    const [merge] = only(planSquadReconcile({ squads, loose: [], mergeMax: 4 }), 'merge');
    ok(merge.coreIds.length === 8, 'the core fills to strength first');
    ok(merge.detachIds.length === 2, 'the remainder becomes a detachment');
    ok(merge.detachLeaderId === 'b1' && merge.heirId === null,
      'a merging leader that does not fit leads the detachment instead of standing heir');
    ok(!merge.coreIds.includes('b1'), 'the established core is never displaced');
  }

  // --- detachments ---
  {
    const squads = [snap('a', 1, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
      { detach: ['d1', 'd2', 'd3', 'd4'], detachLeaderId: 'd2', detachSeq: 5 })];
    const [split] = only(planSquadReconcile({ squads, loose: [] }), 'split');
    ok(split && split.memberIds.length === DETACHMENT_MIN, 'a detachment at strength splits off');
    ok(split.leaderId === 'd2', 'the detachment commander leads the squad it becomes');
    ok(squads[0].core.length + DETACHMENT_MIN === SQUAD_SPLIT_TOTAL, 'the split fires at the twelfth bot');
  }
  {
    const squads = [
      snap('a', 1, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'], { detach: ['d1', 'd2'], detachLeaderId: 'd1', detachSeq: 9 }),
      snap('b', 2, ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'], { detach: ['e1', 'e2'], detachLeaderId: 'e1', detachSeq: 4 }),
    ];
    const [pooled] = only(planSquadReconcile({ squads, loose: [] }), 'mergeDetachments');
    ok(pooled && pooled.memberIds.length === 4, 'two detachments pool into a squad once they reach strength');
    ok(pooled.leaderId === 'e1', 'the older detachment commander leads the pooled squad');
  }
  {
    const squads = [
      snap('a', 1, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'], { detach: ['d1'], detachLeaderId: 'd1', detachSeq: 1 }),
      snap('b', 2, ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'], { detach: ['e1'], detachLeaderId: 'e1', detachSeq: 2 }),
    ];
    ok(!only(planSquadReconcile({ squads, loose: [] }), 'mergeDetachments').length,
      'detachments that would still be understrength together stay put');
  }

  // --- absorbing independents ---
  {
    const squads = [snap('a', 1, ['a1', 'a2'])];
    const loose = [{ id: 'x1', team: 'a', x: 1, z: 1 }, { id: 'x2', team: 'b', x: 1, z: 1 },
      { id: 'x3', team: 'a', x: 500, z: 500 }];
    const absorbed = only(planSquadReconcile({ squads, loose }), 'absorb');
    ok(absorbed.length === 1 && absorbed[0].memberId === 'x1', 'only a nearby same-team independent is absorbed');
    ok(absorbed[0].toDetachment === false, 'a core with room takes the newcomer directly');
  }
  {
    const squads = [snap('a', 1, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'])];
    const [absorbed] = only(planSquadReconcile({ squads, loose: [{ id: 'x1', team: 'a', x: 1, z: 1 }] }), 'absorb');
    ok(absorbed.toDetachment === true, 'a squad at strength parks newcomers in a detachment');
  }

  // --- the field settles ---
  {
    // Four remnants and a handful of strays, all on top of each other: the worst case for churn.
    const squads = [snap('s1', 1, ['a1', 'a2']), snap('s2', 2, ['b1', 'b2']),
      snap('s3', 3, ['c1', 'c2', 'c3']), snap('s4', 4, ['d1', 'd2'])];
    const loose = [1, 2, 3, 4, 5].map((i) => ({ id: `x${i}`, team: 'a', x: 2, z: 2 }));
    let passes = 0;
    for (; passes < 12; passes++) {
      const ops = planSquadReconcile({ squads, loose });
      if (!ops.length) break;
      applyOps(squads, loose, ops);
    }
    ok(passes < 12, 'reconciling reaches a fixed point instead of churning forever');
    ok(!planSquadReconcile({ squads, loose }).length, 'a settled field plans no further work');
    ok(!loose.length, 'every stray ends up in a squad');
    const total = squads.reduce((sum, s) => sum + s.core.length + s.detach.length, 0);
    ok(total === 14, 'nobody is lost or duplicated by consolidation');
    ok(squads.every((s) => s.core.length <= SQUAD_MAX_SIZE), 'no core ends up over strength');
    ok(squads.every((s) => s.detach.length < DETACHMENT_MIN), 'no detachment is left big enough to split');
    ok(squads.length < 4, 'the remnants actually consolidated');
  }

  // --- succession honours the line of heirs ---
  {
    const members = [{ id: 'h1', role: ROLE_RIFLEMAN, alive: true }, { id: 'r2', role: ROLE_SQUAD_LEADER, alive: true }];
    const promoted = stepSquadSuccession({ leaderId: 'gone', members, now: 5000, shockUntil: 1, heirIds: ['h1'] });
    ok(promoted.leaderId === 'h1', 'a named heir outranks a plain election');
    const dead = stepSquadSuccession({ leaderId: 'gone', members, now: 5000, shockUntil: 1, heirIds: ['ghost'] });
    ok(dead.leaderId === 'r2', 'a dead heir is skipped and the election decides');
  }
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
// ─── waiting for a busy member ───────────────────────────────────────────────
{
  const now = 10000;
  const busy = (id, reason, untilIn = 500, alive = true) => ({ id, busyReason: reason, busyUntil: now + untilIn, alive });
  ok(squadHaltRequest([], now) === null, 'a squad with nobody busy does not wait');
  ok(squadHaltRequest([{ id: 'a', alive: true }], now) === null, 'a member with no reason is not busy');
  ok(squadHaltRequest([busy('a', BUSY_DRONE_SERVICE, -1)], now) === null, 'a lapsed lease is not a halt');
  ok(squadHaltRequest([busy('a', BUSY_DRONE_SERVICE, 500, false)], now) === null, 'a corpse is not busy');

  const one = squadHaltRequest([busy('a', BUSY_DRONE_SERVICE)], now);
  ok(one?.memberId === 'a' && one.reason === BUSY_DRONE_SERVICE, 'one busy member halts the squad');

  // Two busy at once: the more urgent job owns the halt, so the wait is explained by the right man.
  const both = squadHaltRequest([busy('a', BUSY_DRONE_SERVICE), busy('b', BUSY_MEDIC_TEND)], now);
  ok(both?.memberId === 'b', `a medic mid-channel outranks a drone on the rack (${both?.memberId})`);
  const three = squadHaltRequest([busy('a', BUSY_MEDIC_TEND), busy('b', BUSY_ENGAGED)], now);
  ok(three?.memberId === 'b', 'and a firefight outranks both');
  const tie = squadHaltRequest([busy('b', BUSY_DRONE_SERVICE), busy('a', BUSY_DRONE_SERVICE)], now);
  ok(tie?.memberId === 'a', 'equal reasons break to the lowest id, so the halt does not flap');

  // The cap measures the whole wait, and a new member taking over restarts it.
  const held = { memberId: 'a', since: now - SQUAD_HALT_MAX_MS - 1 };
  ok(squadHaltRequest([busy('a', BUSY_DRONE_SERVICE)], now, held) === null,
    'a member stuck busy stops being waited for once the cap runs out');
  const handover = squadHaltRequest([busy('c', BUSY_DRONE_SERVICE)], now, held);
  ok(handover?.since === now, 'waiting for a second member is a second wait, not a continuation of the first');
  const running = squadHaltRequest([busy('a', BUSY_DRONE_SERVICE)], now, { memberId: 'a', since: now - 1000 });
  ok(running?.since === now - 1000, 'an ongoing wait keeps its clock');
}

console.log('bot-squad: all assertions passed');