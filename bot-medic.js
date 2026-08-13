// Pure, THREE-free decision math for the medic role (see bot-roles.js for the descriptor). The
// viewer snapshots the medic's living/fallen allies each frame and hands them here; this module
// decides whether to move to someone, tend them in place, revive them, or regroup -- but never
// touches THREE, the scene, or wall-clock state. Unit-tested in test-bot-medic.mjs.
//
// Two behaviour states layer on top of the combat FSM (bot-activity.js): MEDIC_MOVE steers to an
// ally/corpse while the bot may still aim and fire, MEDIC_TEND holds position and channels a heal or
// revive (also fire-capable -- pack in the off hand, sidearm in the other). Self-preservation (the
// medic's own low-health flee/heal) is decided upstream and outranks all of this.

export const MEDIC_MOVE = 'medic-move';
export const MEDIC_TEND = 'medic-tend';

export const MEDIC_DEFAULTS = {
  healAllyThreshold01: 0.65,  // an ally at or below this HP fraction is worth breaking off for
  allyResumeHp01: 0.95,       // stop tending once the ally recovers to here
  responseRadius: 16,         // only answer a wounded ally within this range
  tendRadius: 1.7,            // close enough to lay hands on -> channel instead of approach
  reviveWindowMs: 12000,      // a corpse stays revivable for this long after death
  reviveRadius: 14,           // only attempt a revive within this range
  cohesionNeighborRadius: 16, // only teammates within this count as "the group near me" (local, not global)
  cohesionRadius: 9,          // regroup toward the local group once farther than this from its centroid
  cohesionDeadzone: 3.5,      // stop short of the centroid by this much so medics don't crowd
  outsideSquadPenalty: 1.75,  // reach multiplier for a casualty outside the medic's own squad
};

// MED-2 chase math. A patient in FLEE runs at BOT_MOVE_SPEED * 1.24 (flee-heal) while the medic
// chased at * 1.1, i.e. it LOST ~0.34 m/s of ground and MEDIC_TEND was practically unreachable
// mid-flee. 1.45 nets (1.45 - 1.24) = 0.21 * BOT_MOVE_SPEED ~ 0.5 m/s of closure (a 4 m gap shuts in
// ~8 s instead of never), and the wider tend radius latches the channel ~0.9 m / 0.5 m/s ~ 1.8 s
// earlier still. Both stay under the 1.7x run multiplier, so a sprinting patient can still break off.
export const MEDIC_CHASE_SPEED_FACTOR = 1.1;
export const MEDIC_FLEE_CHASE_SPEED_FACTOR = 1.45;
export const MEDIC_FLEE_TEND_RADIUS = 2.6; // vs MEDIC_DEFAULTS.tendRadius 1.7 for a stationary patient
export function medicChaseSpeedFactor(patientFleeing) {
  return patientFleeing ? MEDIC_FLEE_CHASE_SPEED_FACTOR : MEDIC_CHASE_SPEED_FACTOR;
}
export function medicTendRadiusFor(patientFleeing, cfg = MEDIC_DEFAULTS) {
  return patientFleeing ? MEDIC_FLEE_TEND_RADIUS : cfg.tendRadius;
}

// Hand-on-patient distance. The tend radius is the gate to START channelling (deliberately loose, so
// the channel latches on a moving patient); this is where the medic actually stands once it has, so
// its hand reaches the body instead of treating an ally from two metres away. Two 0.3 m capsules
// bottom out at 0.6 m under the pair pushout, so this leaves ~0.25 m for the arm to cover.
export const MEDIC_CONTACT_RADIUS = 0.85;
export const MEDIC_CONTACT_CREEP = 0.45; // fraction of move speed for the closing shuffle

function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }

// Distance metric: prefer a caller-supplied nav path `cost` (wall-aware, so allies behind a wall read
// as far, not near, and unreachable ones are pre-dropped) and fall back to straight-line when absent.
function reach(self, o) { return o.cost != null ? o.cost : Math.hypot(o.x - self.x, o.z - self.z); }

// Ranking only. A squadded medic weights its own squad's casualties: `squadmate: false` costs a
// candidate a multiplier, so the medic will still cross to a stranger who is clearly closer or the
// only one bleeding, but stops abandoning its own squad for whoever is a metre nearer. The flag is
// only set by a caller that knows the medic's roster -- undefined means no preference at all.
// `bias` is the caller's danger-field surcharge in the same metres, added the same ranking-only way.
// Deliberately NOT applied to the range gate or the tend radius: preference decides who to go to,
// never how far a medic can reach or how close it has to stand to start working.
function preference(self, o, cfg) {
  const d = reach(self, o);
  return (o.squadmate === false ? d * (cfg.outsideSquadPenalty ?? 1) : d) + (o.bias ?? 0);
}

// Nearest ally (by path when `cost` is supplied) at/under the heal threshold within responseRadius.
// allies: [{id,x,z,hp01,cost?,fleeing?}]; `fleeing` carries through so the tend gate can widen (MED-2).
export function selectHealTarget(self, allies, cfg = MEDIC_DEFAULTS) {
  let best = null;
  for (const a of allies || []) {
    if (!a || a.hp01 > cfg.healAllyThreshold01) continue;
    const d = reach(self, a);
    if (d > cfg.responseRadius) continue;
    const score = preference(self, a, cfg);
    if (!best || score < best.score) best = { id: a.id, x: a.x, z: a.z, hp01: a.hp01, dist: d, score, fleeing: !!a.fleeing };
  }
  return best;
}

// Nearest still-revivable corpse (by path when `cost` is supplied) within reviveRadius.
// corpses: [{id,x,z,diedAt,cost?}].
export function selectReviveTarget(self, corpses, now, cfg = MEDIC_DEFAULTS) {
  let best = null;
  for (const c of corpses || []) {
    if (!c || c.diedAt == null || now - c.diedAt > cfg.reviveWindowMs) continue;
    const d = reach(self, c);
    if (d > cfg.reviveRadius) continue;
    const score = preference(self, c, cfg);
    if (!best || score < best.score) best = { id: c.id, x: c.x, z: c.z, diedAt: c.diedAt, dist: d, score };
  }
  return best;
}

// S12: TEND is a stationary channel that also PINS the patient, so committing to it in the shooter's
// lane gets both killed. `exposed` (the caller's exposedToThreat verdict for the tend spot) downgrades
// the TEND to a MOVE toward the same target flagged seekConcealment, which the caller re-routes to the
// nearest concealed cell inside the tend radius. exposed absent/false -> the original decision.
function tendOrSeekConcealment(action, exposed) {
  if (action.state === MEDIC_TEND && exposed) { action.state = MEDIC_MOVE; action.seekConcealment = true; }
  return action;
}

// Combined medic duty. Revive outranks heal (a dead ally is the more urgent, time-boxed save), and
// each is gated by the resource it needs. Within tendRadius -> TEND, else MOVE. Returns
// { state, kind:'heal'|'revive', targetId, x, z, dist } (+ `fleeing` on heal, `seekConcealment` when an
// exposed tend spot was downgraded) or null when there's nothing to do.
export function decideMedicAction({ self, allies = [], corpses = [], hasKit = false, hasCharge = false,
  now = 0, cfg = MEDIC_DEFAULTS, exposed = false } = {}) {
  if (hasKit) {
    const r = selectReviveTarget(self, corpses, now, cfg);
    if (r) return tendOrSeekConcealment({ state: r.dist <= cfg.tendRadius ? MEDIC_TEND : MEDIC_MOVE, kind: 'revive', targetId: r.id, x: r.x, z: r.z, dist: r.dist }, exposed);
  }
  if (hasCharge) {
    const h = selectHealTarget(self, allies, cfg);
    // A fleeing patient gets the wider tend band, otherwise the channel never latches (MED-2).
    if (h) return tendOrSeekConcealment({ state: h.dist <= medicTendRadiusFor(h.fleeing, cfg) ? MEDIC_TEND : MEDIC_MOVE, kind: 'heal', targetId: h.id, x: h.x, z: h.z, dist: h.dist, fleeing: h.fleeing }, exposed);
  }
  return null;
}

// XZ centroid of a set of teammates, or null if the set is empty. teammates: [{x,z}].
export function teamCentroid(teammates) {
  let n = 0, sx = 0, sz = 0;
  for (const t of teammates || []) { if (!t) continue; sx += t.x; sz += t.z; n++; }
  return n ? { x: sx / n, z: sz / n } : null;
}

// Regroup goal, computed against the LOCAL group only (teammates within cohesionNeighborRadius).
// Deliberately no across-map fallback: if there's no teammate within perception the medic returns
// null and the caller lets it patrol/scatter. A "nearest teammate" fallback turns every isolated
// medic into a homing missile toward the same far fighter, and several of them then funnel into one
// clump at a chokepoint far from anyone (the "isolated medics, no patients" bug). Returns a point
// short of the local centroid by cohesionDeadzone, or null when already tucked in / no local group.
// The caller excludes fellow medics from `teammates` so support anchors on the fighting line.
export function cohesionTarget(self, teammates, cfg = MEDIC_DEFAULTS) {
  const near = [];
  for (const t of teammates || []) {
    if (!t) continue;
    if (dist2(self.x, self.z, t.x, t.z) <= cfg.cohesionNeighborRadius * cfg.cohesionNeighborRadius) near.push(t);
  }
  const c = teamCentroid(near);
  if (!c) return null; // no local group -> don't chase across the map; patrol instead
  const dx = c.x - self.x, dz = c.z - self.z;
  const d = Math.hypot(dx, dz);
  if (d <= cfg.cohesionRadius) return null;
  const stop = Math.max(0, d - cfg.cohesionDeadzone);
  return { x: self.x + (dx / d) * stop, z: self.z + (dz / d) * stop };
}
