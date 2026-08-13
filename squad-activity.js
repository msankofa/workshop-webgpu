// Pure, THREE-free decision math for squad AI (Phase 1: loss-retreat decision, formation ring).
// Mirrors bot-activity.js's split (pure decision logic here, world-wiring in the importer).
// Unit-tested in test-squad-activity.mjs.

export const SQUAD_LOSS_THRESHOLD = 0.4; // fraction of initialSize lost before a leader re-evaluates

// Uniform-random temperament in [min, max]. Called once per bot at spawn (every bot gets one,
// even unsquadded/non-leader bots -- it just sits unused until/unless that bot leads).
export function rollTemperament(min = 0, max = 1, rand = Math.random) {
  return min + rand() * (max - min);
}

// Edge-triggered, latched loss-retreat decision. Pure: takes current state in, returns next state
// out -- caller applies `retreat` to squad.order itself, this never mutates anything.
// - lostFrac < threshold: clears the latch (so a reinforced squad can re-roll if it drops again).
// - lostFrac >= threshold and not yet decided: rolls once, sets the latch, may return retreat:true.
// - lostFrac >= threshold and already decided: no-op, latch stays set, retreat:false (already fired).
export function tickSquadLossDecision({ initialSize, aliveCount, lossRetreatDecided, leaderTemperament, rand = Math.random }) {
  const lostFrac = 1 - aliveCount / initialSize;
  if (lostFrac < SQUAD_LOSS_THRESHOLD) return { lossRetreatDecided: false, retreat: false };
  if (lossRetreatDecided) return { lossRetreatDecided: true, retreat: false };
  const retreatChance = 1 - leaderTemperament; // cautious (low aggression) leaders retreat more readily
  return { lossRetreatDecided: true, retreat: rand() < retreatChance };
}

// Deterministic, evenly-spaced angle for member `memberIndex` of `memberCount` -- assigned ONCE at
// squad formation (formSquad, wiring side) and stored on the bot rec so the formation ring doesn't
// jitter frame to frame from re-randomizing.
export function formationAngleFor(memberIndex, memberCount) {
  return (memberIndex / memberCount) * Math.PI * 2;
}

// World-space point on a loose ring of `radius` around `leaderPos` at a bot's fixed `angleRad`.
// This IS the squad-member movement goal when a member has no combat target of its own -- see
// squadMemberGoal in the wiring contract below, which is a thin environment-viewer.html wrapper
// around this pure function (reads live leader position, calls this, no logic of its own).
export function formationOffset(leaderPos, angleRad, radius) {
  return { x: leaderPos.x + Math.cos(angleRad) * radius, z: leaderPos.z + Math.sin(angleRad) * radius };
}

// World-space point trailing directly behind the leader along its current heading, for the
// single-file/column formation -- memberIndex 1 is one spacing back, 2 is two spacings back, etc.
// (member 0 is the leader itself and never calls this). headingRad follows bot.yaw's convention
// (0 = +Z), matching aimAnglesTo/botFaceMovement in environment-viewer.html.
export function columnOffset(leaderPos, headingRad, memberIndex, spacing) {
  const back = memberIndex * spacing;
  return { x: leaderPos.x - Math.sin(headingRad) * back, z: leaderPos.z - Math.cos(headingRad) * back };
}

// Ring vs. column decision for a squad's formation, re-evaluated every tick (wiring side owns the
// terrain/combat sampling, this just applies the priority order). `manual` is 'ring' | 'column' |
// 'auto' (or nullish, treated as 'auto'). Combat engagement always wins over terrain -- formation
// spacing for coverage matters more than corridor-fit mid-fight.
export function chooseFormationKind({ manual = 'auto', engaged = false, corridorClear = true }) {
  if (manual === 'ring' || manual === 'column') return manual;
  if (engaged) return 'ring';
  return corridorClear ? 'ring' : 'column';
}

// Picks a far exploration goal along a bot's fixed heading, jittered within a cone, retried
// (up to maxAttempts) against a short exclusion history so a bot doesn't immediately re-path back
// over ground it just came from. Pure: `pos` is the bot's current position (goals chain outward
// from wherever the bot currently is, not always from spawn), `history` is an array of the last
// few goal points, `rand` is injectable for deterministic tests. Does not know about walkability,
// map bounds, or water -- the wiring side hands the result to the existing A*/nearest-walkable
// routing, which already clamps/retargets unreachable goals (see requestBotPath).
export function pickExploreGoal({ pos, heading, coneJitterRad, minDist, maxDist, history = [], exclusionRadius, rand = Math.random, maxAttempts = 8 }) {
  let candidate = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const angle = heading + (rand() * 2 - 1) * coneJitterRad;
    const dist = minDist + rand() * (maxDist - minDist);
    const point = { x: pos.x + Math.sin(angle) * dist, z: pos.z + Math.cos(angle) * dist };
    candidate = point;
    const tooClose = history.some((h) => Math.hypot(h.x - point.x, h.z - point.z) < exclusionRadius);
    if (!tooClose) return point;
  }
  return candidate; // exhausted retries -- best-effort, still gets the bot moving somewhere new-ish
}
