// bot-grenade.js — pure, THREE-free grenade-secondary DECISION math. Node-tested in
// test-bot-grenade.mjs; the viewer owns the arc raycast, the throw, the swap animation and the
// projectile itself. This module only answers "is a nade worth it, and where do I aim it".
// All gates are horizontal (XZ); the aimPoint keeps its source Y so the viewer can solve the arc.

export const GRENADE_DEFAULTS = Object.freeze({
  perBotCount: 2,                 // grenades carried per bot per life
  cooldownMs: 9000,               // per-bot spacing between throws
  teamCooldownMs: 2500,           // squad-wide spacing so a team doesn't volley at once
  minRange: 8,                    // closer than this and the thrower eats its own blast / just shoots
  maxRange: 25,                   // beyond this the arc is a coin flip
  friendlyRadiusScale: 1.15,      // ally inside blastRadius * this vetoes the throw
  selfRadiusScale: 1.25,          // thrower inside blastRadius * this vetoes the throw
  clusterWeight: 1.0,             // score bonus per EXTRA enemy inside the blast
  blindThrowMaxAgeMs: 4000,       // a last-known point older than this is not worth a nade
  blindThrowChance: 0.5,          // score multiplier for a blind throw vs. a visible one
  minEnemiesForVisibleThrow: 2,   // one enemy you can already shoot is not worth a nade
  aimLeadS: 0.4,                  // seconds of target velocity to lead a visible target by
  evadeExitScale: 1.25,           // evade holds out to blastRadius * this once engaged (hysteresis)
});

// Fraction of blindThrowMaxAgeMs under which a blind throw reads as 'cover' (he just ducked)
// rather than 'blind' (a stale guess). Reason string only — it never changes the score.
const COVER_AGE_FRACTION = 0.5;

// Nominal full fuse (weapons.js grenade projectile.fuse) used to normalize evade urgency.
const NOMINAL_FUSE_S = 2.0;

// Evade urgency blend: time pressure dominates, proximity trims. Sums to 1.
const EVADE_TIME_WEIGHT = 0.6;
const EVADE_PROXIMITY_WEIGHT = 0.4;

// Per-key read so a viewer may pass a partial settings object without producing NaN gates.
function tune(cfg, key) {
  const v = cfg ? cfg[key] : undefined;
  return Number.isFinite(v) ? v : GRENADE_DEFAULTS[key];
}

function isVec3(p) {
  return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
}

function distXZ(a, b) { return Math.hypot(a[0] - b[0], a[2] - b[2]); }

// Optional occlusion hook, `input.blastReaches(point, entry) -> boolean`: would a blast at `point`
// actually reach this body, or is there a wall in the way. Injected rather than computed here so this
// module stays THREE-free and Node-testable, the same way combat-projectile takes `ctx.raycast`.
// Omitted means everything is exposed, which is the pre-occlusion behaviour every caller had.
// It is consulted only for bodies that already passed the distance test, so the ray cost scales with
// what is inside the ring rather than with the roster.
function reaches(fn, point, entry) { return typeof fn !== 'function' || fn(point, entry) === true; }

// Count of `list` entries within `radius` (XZ) of `point` that the blast can actually reach.
function countWithin(list, point, radius, reachable) {
  let n = 0;
  for (const e of list || []) {
    if (!e || !isVec3(e.p) || distXZ(e.p, point) > radius) continue;
    if (reaches(reachable, point, e)) n++;
  }
  return n;
}

function anyWithin(list, point, radius, reachable) {
  for (const e of list || []) {
    if (!e || !isVec3(e.p) || distXZ(e.p, point) > radius) continue;
    if (reaches(reachable, point, e)) return true;
  }
  return false;
}

// The throw decision. Returns { aimPoint:[x,y,z], score, reason, targetId } or null at the first
// failed gate (no side effects, no mutation of the input). reason: 'cluster' (visible cluster),
// 'cover' (fresh memory — he just ducked), 'blind' (older but still in-window memory).
export function chooseGrenadeThrow(input, settings = GRENADE_DEFAULTS) {
  if (!input || !input.self || !isVec3(input.self.p)) return null;
  const { self, target, enemies, allies, blastRadius, grenadesLeft, lastThrowAt, lastTeamThrowAt, now,
    blastReaches } = input;

  if (!(grenadesLeft > 0)) return null;
  if (!(blastRadius > 0)) return null;

  const t = Number.isFinite(now) ? now : 0;
  if (Number.isFinite(lastThrowAt) && t - lastThrowAt < tune(settings, 'cooldownMs')) return null;
  if (Number.isFinite(lastTeamThrowAt) && t - lastTeamThrowAt < tune(settings, 'teamCooldownMs')) return null;
  if (!target) return null;

  // Aim point: led current position when visible, else a fresh-enough remembered point.
  let aimPoint = null;
  let blind = false;
  let ageMs = 0;
  if (target.visible && isVec3(target.p)) {
    const lead = tune(settings, 'aimLeadS');
    const v = target.velocity;
    const vx = v && Number.isFinite(v.x) ? v.x : 0;
    const vz = v && Number.isFinite(v.z) ? v.z : 0;
    aimPoint = [target.p[0] + vx * lead, target.p[1], target.p[2] + vz * lead];
  } else if (isVec3(target.lastKnownP) && Number.isFinite(target.lastKnownAt)) {
    ageMs = t - target.lastKnownAt;
    if (ageMs > tune(settings, 'blindThrowMaxAgeMs')) return null;
    aimPoint = [target.lastKnownP[0], target.lastKnownP[1], target.lastKnownP[2]];
    blind = true;
  }
  if (!aimPoint) return null;

  const throwDist = distXZ(self.p, aimPoint);
  if (throwDist < tune(settings, 'minRange') || throwDist > tune(settings, 'maxRange')) return null;

  // All three rings run through the same reachability hook as the damage model, so a body the blast
  // cannot touch neither counts toward the cluster nor vetoes the throw. Without it a wall made bots
  // refuse safe throws (ally sheltered behind it) AND take unsafe ones (enemies counted through it).
  const covered = countWithin(enemies, aimPoint, blastRadius, blastReaches);
  if (covered <= 0) return null; // nothing in the blast: never spend a nade on empty ground
  if (!blind && covered < tune(settings, 'minEnemiesForVisibleThrow')) return null;

  if (anyWithin(allies, aimPoint, blastRadius * tune(settings, 'friendlyRadiusScale'), blastReaches)) return null;
  // Self veto is a one-entry anyWithin: behind a corner from its own aim point, a bot may throw short
  // (the minRange gate still holds the floor), which is what cooking one around a corner looks like.
  if (anyWithin([self], aimPoint, blastRadius * tune(settings, 'selfRadiusScale'), blastReaches)) return null;

  let score = covered + (covered - 1) * tune(settings, 'clusterWeight');
  if (blind) score *= tune(settings, 'blindThrowChance');
  const reason = !blind ? 'cluster'
    : (ageMs <= tune(settings, 'blindThrowMaxAgeMs') * COVER_AGE_FRACTION ? 'cover' : 'blind');

  return { aimPoint, score, reason, targetId: target.id };
}

// Most urgent live grenade whose blast covers selfP, or null when nothing does. threats:
// [{ id, p:[x,y,z], blastRadius, fuseRemainingS }]. urgency in 0..1 rises as the fuse runs out and
// as the bot sits nearer the centre; ties on urgency go to the nearer grenade. The viewer feeds
// `from` into its flee-goal search as a repulsor.
// `engagedId` is the threat the caller is ALREADY evading: it keeps its hold out to a wider ring
// (blastRadius * evadeExitScale) so a bot that just cleared the edge is not handed straight back to
// the combat FSM, which would walk it in again and chatter across the boundary.
export function grenadeEvade(selfP, threats, settings = GRENADE_DEFAULTS, engagedId = null) {
  if (!isVec3(selfP) || !threats) return null;
  const exitScale = Math.max(1, tune(settings, 'evadeExitScale'));
  let best = null, bestUrgency = -1, bestDist = Infinity;
  for (const g of threats) {
    if (!g || !isVec3(g.p) || !(g.blastRadius > 0)) continue;
    const fuse = Number.isFinite(g.fuseRemainingS) ? g.fuseRemainingS : NOMINAL_FUSE_S;
    if (fuse < 0) continue; // already detonated
    const dist = distXZ(selfP, g.p);
    const held = engagedId != null && g.id != null && g.id === engagedId;
    if (dist > g.blastRadius * (held ? exitScale : 1)) continue;
    const timeTerm = Math.min(1, Math.max(0, 1 - fuse / NOMINAL_FUSE_S));
    const nearTerm = Math.min(1, Math.max(0, 1 - dist / g.blastRadius));
    const urgency = Math.min(1, Math.max(0, EVADE_TIME_WEIGHT * timeTerm + EVADE_PROXIMITY_WEIGHT * nearTerm));
    if (urgency > bestUrgency || (urgency === bestUrgency && dist < bestDist)) {
      bestUrgency = urgency; bestDist = dist;
      best = { id: g.id ?? null, from: [g.p[0], g.p[1], g.p[2]], radius: g.blastRadius, urgency };
    }
  }
  return best;
}

// Grenades a fresh bot spawns with — keeps the viewer out of the settings object.
export function throwCountFor(settings = GRENADE_DEFAULTS) {
  return tune(settings, 'perBotCount');
}
