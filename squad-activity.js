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
