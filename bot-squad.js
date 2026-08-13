// bot-squad.js — pure, THREE-free squad math: rosters, leader election/succession, formations.
// Node-tested in test-bot-squad.mjs; world-wiring (meshes, spawn, per-frame movement, nav sampling)
// stays in bot-viewer-v2.html. Nothing here touches THREE, the nav grid, or global viewer state.

import { ROLE_SQUAD_LEADER, assignRolesToBatch, pickSquadLeader, squadRanks, getRole } from './bot-roles.js';

export const SQUAD_MAX_SIZE = 8;          // hard ceiling on one squad's CORE roster
export const SQUAD_MIN_SIZE = 2;          // below this there is nobody to lead; the bot stays independent
export const SUCCESSION_SHOCK_MS = 1800;  // leaderless gap after a leader dies, before the successor takes over

// Consolidation rules. A squad at core strength parks new arrivals in a detachment -- a temporary
// sub-unit that walks with its parent until it is big enough to stand alone as a squad of its own.
export const SQUAD_MERGE_MAX = 4;         // a squad at or below this size looks for somewhere to merge
export const DETACHMENT_MIN = 4;          // a detachment this size splits off as its own squad
export const SQUAD_SPLIT_TOTAL = SQUAD_MAX_SIZE + DETACHMENT_MIN;   // 12: core + a full detachment
export const SQUAD_MERGE_RADIUS = 20;     // m, leader-to-leader; squads farther apart never merge

export const FORMATION_KINDS = ['wedge', 'column', 'line', 'ring'];

export const SQUAD_DEFAULTS = {
  spacing: 2.4,        // metres between adjacent slots
  ringScale: 2.5,      // ring radius as a multiple of spacing
  slotArrive: 1.2,     // within this of its slot a member stops walking
  leash: 22,           // farther than this from the leader, head for the leader itself, not the slot
};

// Split `count` bots into balanced squads no larger than `maxSize` -- 11 bots become 6+5, not 8+3,
// so no squad fights a third understrength.
export function partitionSquadSizes(count, maxSize = SQUAD_MAX_SIZE) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const cap = Math.max(1, Math.floor(Number(maxSize) || SQUAD_MAX_SIZE));
  if (n === 0) return [];
  const squads = Math.ceil(n / cap);
  const base = Math.floor(n / squads);
  const extra = n % squads;
  const sizes = [];
  for (let i = 0; i < squads; i++) sizes.push(base + (i < extra ? 1 : 0));
  return sizes;
}

// Split `members` into chunks of the given `sizes`, seeding each chunk with a leader-role member
// before filling it out. Callers that bring their own role list (reinforcement waves, a scene
// shuffle replaying a captured roster) have no per-squad layout, so a plain slice could hand one
// chunk every leader and leave the next with none. Leftover members are dropped.
export function dealSquadChunks(members = [], sizes = [], isLeader = () => false) {
  const leaders = [], others = [];
  for (const member of members) (isLeader(member) ? leaders : others).push(member);
  const chunks = [];
  for (const size of sizes) {
    const chunk = leaders.length ? [leaders.shift()] : [];
    while (chunk.length < size && others.length) chunk.push(others.shift());
    while (chunk.length < size && leaders.length) chunk.push(leaders.shift());
    if (chunk.length) chunks.push(chunk);
  }
  return chunks;
}

// Role ids for one squad: slot 0 always leads, the rest inherit the batch specialist spread.
export function squadRoleTemplate(size, { medicPercent = 0, mix = null } = {}) {
  const n = Math.max(0, Math.floor(Number(size) || 0));
  if (n === 0) return [];
  return [ROLE_SQUAD_LEADER, ...assignRolesToBatch(n - 1, { medicPercent, mix })];
}

// Highest-leadership LIVING member, ties on lowest id. Members are { id, role, alive }.
export function electSquadLeader(members = []) {
  return pickSquadLeader(members.filter((m) => m && m.alive !== false));
}

// Leader succession as a pure state step: a dead leader leaves the squad leaderless for `shockMs`
// before anyone is promoted, so decapitating a squad actually costs it something. `heirIds` is the
// named line of succession (the leaders of squads that merged in, oldest squad first) and outranks
// a plain election -- a leader who gave up command keeps their claim to it.
export function stepSquadSuccession({ leaderId = null, members = [], now = 0, shockUntil = 0,
  shockMs = SUCCESSION_SHOCK_MS, heirIds = [] } = {}) {
  const living = members.filter((m) => m && m.alive !== false);
  const leaderLives = leaderId != null && living.some((m) => String(m.id) === String(leaderId));
  if (leaderLives) return { leaderId, shockUntil: 0, shocked: false, changed: false };
  if (!living.length) return { leaderId: null, shockUntil: 0, shocked: false, changed: leaderId != null };
  if (shockUntil === 0) return { leaderId: null, shockUntil: now + shockMs, shocked: true, changed: leaderId != null };
  if (now < shockUntil) return { leaderId: null, shockUntil, shocked: true, changed: false };
  const heir = heirIds.map((id) => living.find((m) => String(m.id) === String(id))).find(Boolean);
  const successor = heir || electSquadLeader(living);
  return { leaderId: successor?.id ?? null, shockUntil: 0, shocked: false, changed: true };
}

// Merge two squads into the older one. The established core is never displaced -- the joiners fill
// whatever room is left in it and the rest becomes a detachment. The merging leader gives up command
// but not its claim on it: it is the next heir when the merge fits, and when it does not, it takes
// the detachment it will lead out again once that detachment can stand alone.
function planMerge(into, from, coreMax) {
  const fromLeader = from.hasLeader ? from.leaderId : null;
  const joining = [...from.core, ...from.detach].filter((id) => id !== fromLeader);
  const core = [...into.core];
  const detach = [...into.detach];
  const room = Math.max(0, coreMax - core.length);
  core.push(...joining.slice(0, room));
  const overflow = joining.slice(room);
  let detachLeaderId = into.detachLeaderId ?? null;
  let heirId = null;
  if (fromLeader != null) {
    if (!overflow.length && core.length < coreMax) { core.push(fromLeader); heirId = fromLeader; }
    // An older detachment already has a commander; the newcomer just joins it.
    else { overflow.push(fromLeader); if (detachLeaderId == null) detachLeaderId = fromLeader; }
  }
  detach.push(...overflow);
  if (detach.length && detachLeaderId == null) detachLeaderId = detach[0];
  return { core, detach, detachLeaderId, heirId };
}

// Reconcile the whole field into sensibly-sized squads. Pure: takes snapshots, returns an ordered
// list of operations for the caller to apply, and never touches live state. Snapshots are
// `{ id, team, seq, detachSeq, leaderId, hasLeader, x, z, core: [ids], detach: [ids], detachLeaderId }`
// (`seq` ascending = older) and loose bots are `{ id, team, x, z }`.
//
// Passes run in this order so each one works on ground the previous one cleared:
//   1. split            — a detachment at full strength leaves as its own squad
//   2. mergeDetachments — two parents pool detachments that are each too small to stand alone
//   3. merge            — an understrength squad folds into a nearby one
//   4. absorb           — leftover independents join whoever is nearest
export function planSquadReconcile({ squads = [], loose = [], radius = SQUAD_MERGE_RADIUS,
  coreMax = SQUAD_MAX_SIZE, mergeMax = SQUAD_MERGE_MAX, detachMin = DETACHMENT_MIN } = {}) {
  const ops = [];
  const work = squads.map((s) => ({
    ...s, core: [...(s.core || [])], detach: [...(s.detach || [])],
    detachSeq: s.detachSeq ?? 0, detachLeaderId: s.detachLeaderId ?? null,
  }));
  const consumed = new Set();
  const inRange = (a, b) => a.hasLeader && b.hasLeader && Math.hypot(a.x - b.x, a.z - b.z) <= radius;

  for (const s of work) {
    if (s.detach.length < detachMin) continue;
    ops.push({ op: 'split', squadId: s.id, memberIds: [...s.detach], leaderId: s.detachLeaderId ?? s.detach[0] });
    s.detach.length = 0; s.detachLeaderId = null; s.detachSeq = 0;
  }

  for (let i = 0; i < work.length; i++) {
    const a = work[i];
    if (consumed.has(a.id) || !a.detach.length) continue;
    for (let j = i + 1; j < work.length; j++) {
      const b = work[j];
      if (consumed.has(b.id) || !b.detach.length || b.team !== a.team || !inRange(a, b)) continue;
      if (a.detach.length + b.detach.length < detachMin) continue;
      // The older detachment's commander leads the squad the two of them become.
      const older = (a.detachSeq || Infinity) <= (b.detachSeq || Infinity) ? a : b;
      const memberIds = [...a.detach, ...b.detach];
      ops.push({ op: 'mergeDetachments', squadIds: [a.id, b.id], memberIds, leaderId: older.detachLeaderId ?? memberIds[0] });
      for (const s of [a, b]) { s.detach.length = 0; s.detachLeaderId = null; s.detachSeq = 0; }
      break;
    }
  }

  for (const s of work) {
    if (consumed.has(s.id)) continue;
    if (s.core.length + s.detach.length > mergeMax) continue;
    let best = null, bestDistance = Infinity;
    for (const t of work) {
      if (t === s || consumed.has(t.id) || t.team !== s.team || !inRange(s, t)) continue;
      // Core room only: merging into a full squad just parks everyone in a detachment that would
      // split straight back out, and the two would trade members forever.
      if (t.core.length >= coreMax) continue;
      const distance = Math.hypot(s.x - t.x, s.z - t.z);
      if (distance < bestDistance) { bestDistance = distance; best = t; }
    }
    if (!best) continue;
    const [into, from] = best.seq <= s.seq ? [best, s] : [s, best];   // older squad keeps command
    const merged = planMerge(into, from, coreMax);
    // Emitted ops carry copies: later passes keep mutating the working rosters, and an op holding a
    // live reference would rewrite itself as they do.
    ops.push({ op: 'merge', intoId: into.id, fromId: from.id, coreIds: [...merged.core], detachIds: [...merged.detach],
      detachLeaderId: merged.detachLeaderId, heirId: merged.heirId });
    into.core = merged.core; into.detach = merged.detach; into.detachLeaderId = merged.detachLeaderId;
    consumed.add(from.id);   // a consumed squad is skipped by the guard at the top of this loop
  }

  for (const bot of loose) {
    let best = null, bestDistance = Infinity;
    for (const t of work) {
      if (consumed.has(t.id) || t.team !== bot.team || !t.hasLeader) continue;
      const distance = Math.hypot(bot.x - t.x, bot.z - t.z);
      if (distance > radius || distance >= bestDistance) continue;
      bestDistance = distance; best = t;
    }
    if (!best) continue;
    const toDetachment = best.core.length >= coreMax;
    (toDetachment ? best.detach : best.core).push(bot.id);
    if (toDetachment && best.detachLeaderId == null) best.detachLeaderId = bot.id;
    ops.push({ op: 'absorb', squadId: best.id, memberId: bot.id, toDetachment });
  }

  return ops;
}

// Which formation a squad walks in. Manual wins; contact brings guns abreast; a corridor too narrow
// for the formation's width collapses it to single file.
export function chooseFormationKind({ manual = 'auto', engaged = false, corridorClear = true } = {}) {
  if (FORMATION_KINDS.includes(manual)) return manual;
  if (engaged) return 'line';
  return corridorClear ? 'wedge' : 'column';
}

// Formation order: leader at the point, then the fighting line, then support at the back. Plain
// `squadRanks` orders by id, which put the medic on the leading edge of the wedge as often as not --
// a medic walking point is the tell that a squad is treating it as just another rifle.
export function formationRanks(members = [], leaderId = null) {
  const ordered = squadRanks(members, leaderId);
  if (ordered.length < 3) return ordered;   // nobody to fall back behind
  const roleOf = new Map(members.filter(Boolean).map((m) => [String(m.id), m.role]));
  const rest = ordered.slice(1);
  const line = rest.filter((id) => !getRole(roleOf.get(id)).support);
  const support = rest.filter((id) => getRole(roleOf.get(id)).support);
  return [ordered[0], ...line, ...support];
}

// Slot offset in the leader's own frame: +right is off its right shoulder, +back is behind it.
// Rank 0 is the leader itself and always sits at the origin.
export function formationOffsetLocal(kind, rank, count, spacing = SQUAD_DEFAULTS.spacing) {
  const i = Math.max(0, Math.floor(Number(rank) || 0));
  if (i === 0) return { right: 0, back: 0 };
  const side = i % 2 === 1 ? 1 : -1;      // odd ranks right of the leader, even ranks left
  const tier = Math.ceil(i / 2);          // how many pairs out from the leader
  if (kind === 'column') return { right: 0, back: i * spacing };
  if (kind === 'line') return { right: side * tier * spacing, back: 0 };
  return { right: side * tier * spacing, back: tier * spacing }; // wedge: a 45-degree V
}

// Evenly-spaced world bearing for a ring member -- a fixed angle, so the ring does not spin when the
// leader turns the way a leader-relative offset would.
export function ringAngleFor(rank, count) {
  return (rank / Math.max(1, count)) * Math.PI * 2;
}

// A member's formation slot in world XZ. `headingRad` follows bot.yaw (0 = +Z), so forward is
// (sin, cos) and right is forward x up = (-cos, sin).
export function squadSlotWorld({ kind = 'wedge', leaderPos, headingRad = 0, rank = 0, count = 1,
  spacing = SQUAD_DEFAULTS.spacing, ringRadius = null } = {}) {
  if (!leaderPos) return null;
  if (!(rank > 0)) return { x: leaderPos.x, z: leaderPos.z };
  if (kind === 'ring') {
    const r = ringRadius ?? spacing * SQUAD_DEFAULTS.ringScale;
    const a = ringAngleFor(rank, count);
    return { x: leaderPos.x + Math.cos(a) * r, z: leaderPos.z + Math.sin(a) * r };
  }
  const { right, back } = formationOffsetLocal(kind, rank, count, spacing);
  const fx = Math.sin(headingRad), fz = Math.cos(headingRad);
  return { x: leaderPos.x - fz * right - fx * back, z: leaderPos.z + fx * right - fz * back };
}

// Where a squadded follower should walk, or null with no leader. A member dragged past `leash`
// heads for the leader itself: its slot may be across the map or through a wall by then.
export function squadMemberGoal(opts = {}) {
  const { leaderPos, selfPos, arriveRadius = SQUAD_DEFAULTS.slotArrive, leash = SQUAD_DEFAULTS.leash } = opts;
  if (!leaderPos) return null;
  const strayed = selfPos ? Math.hypot(selfPos.x - leaderPos.x, selfPos.z - leaderPos.z) > leash : false;
  const slot = strayed ? { x: leaderPos.x, z: leaderPos.z } : squadSlotWorld(opts);
  if (!slot) return null;
  const arrived = selfPos ? Math.hypot(selfPos.x - slot.x, selfPos.z - slot.z) <= arriveRadius : false;
  return { x: slot.x, z: slot.z, arrived, regrouping: strayed };
}

// Half-width the formation needs to walk abreast, so the wiring can ask the nav grid whether the
// corridor ahead actually fits it before choosing anything wider than a column.
export function formationHalfWidth(kind, count, spacing = SQUAD_DEFAULTS.spacing) {
  if (kind === 'column' || count <= 1) return 0;
  if (kind === 'ring') return spacing * SQUAD_DEFAULTS.ringScale;
  return Math.ceil((count - 1) / 2) * spacing;
}

// ─── waiting for a busy member ───────────────────────────────────────────────
// A squad that walks off while one of its own is mid-task leaves him alone in the open. A member
// that cannot do its job on the move marks itself BUSY, and the rest of the squad holds until it is
// finished or the wait runs long.
//
// The first reason is a drone operator servicing his aircraft. Medics mid-channel and bots in a
// firefight are the next two: both already have their own stop-and-do-it behaviour, and folding them
// in here is what turns "this bot stopped" into "the squad waited for it". Reasons are ranked, so
// two busy members do not fight over the halt — the more urgent one owns it.

export const BUSY_DRONE_SERVICE = 'drone-service';
export const BUSY_MEDIC_TEND = 'medic-tend';
export const BUSY_ENGAGED = 'engaged';

// Higher wins. A firefight outranks a reload, which outranks a drone on the rack.
export const BUSY_PRIORITY = {
  [BUSY_DRONE_SERVICE]: 1,
  [BUSY_MEDIC_TEND]: 2,
  [BUSY_ENGAGED]: 3,
};

// A halt is capped: a member stuck busy forever must not freeze its squad for the rest of the match.
export const SQUAD_HALT_MAX_MS = 20000;

// `members` are { id, busyReason, busyUntil, alive }. `state` carries the halt already in progress
// ({ since, memberId }) so the cap measures the whole wait rather than restarting every frame.
// Returns { memberId, reason, until, since } or null for "nobody is waiting on anyone".
export function squadHaltRequest(members = [], now = 0, state = {}, cfg = {}) {
  const maxMs = Number.isFinite(cfg.maxMs) ? cfg.maxMs : SQUAD_HALT_MAX_MS;
  let best = null, bestRank = -Infinity;
  for (const m of members) {
    if (!m || m.alive === false || !m.busyReason) continue;
    if (!(Number(m.busyUntil) > now)) continue;
    const rank = BUSY_PRIORITY[m.busyReason] ?? 0;
    if (rank > bestRank || (rank === bestRank && best && String(m.id) < String(best.id))) {
      best = m; bestRank = rank;
    }
  }
  if (!best) return null;
  // The clock restarts when a different member takes over the halt: waiting for two people in turn
  // is two waits, not one long one.
  const since = state.memberId === best.id && Number.isFinite(state.since) ? state.since : now;
  if (now - since > maxMs) return null;
  return { memberId: best.id, reason: best.busyReason, until: best.busyUntil, since };
}
