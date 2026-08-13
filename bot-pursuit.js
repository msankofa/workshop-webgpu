// Pursuit geometry: where a chasing bot should actually run to.
//
// Two ideas from the FSM audit (A7, S14), both pure so they test without a nav grid or a GPU:
//   - intercept lead: aim the CHASE at where the target will be. Aim/fire stay present-position --
//     shots are hitscan, so leading them would just miss. Without this a chaser paths to the
//     target's current cell every replan and trails forever at equal speed.
//   - pincer offsets: rotate each extra claimant's standoff bearing off the direct line, so a squad
//     converges from several sides instead of queueing down one corridor behind the leader.
//
// Wired in bot-viewer-v2.html: updatePursuitMovement (lead + pincer), investigationSearchRadius.

export const PURSUIT_DEFAULTS = Object.freeze({
  maxLeadSeconds: 1.2,          // past this the prediction is fantasy: targets turn corners
  minLeadSpeed: 0.6,            // m/s under which a target counts as standing still
  pincerStepRad: Math.PI / 4.8, // 37.5 deg per additional claimant
  pincerRings: 3,               // ± this many steps, so up to 7 distinct approach bearings
});

// Search-bubble radius at `elapsedSeconds`, clamped to maxRadius.
//
// The audit's A7: expansion used to be 0.55 m/s against a 3.5-4 m/s target, so a bot diligently
// swept an 8 m bubble while the target was two rooms away. The cap matters as much as the rate --
// an uncapped fast bubble covers the whole map, which makes "search" meaningless and makes the
// region BFS that seeds it expensive.
export function investigationRadius(elapsedSeconds, settings) {
  const { initialRadius = 1.25, expansionMetresPerSecond = 0, maxRadius = Infinity } = settings || {};
  const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
  return Math.min(maxRadius, initialRadius + elapsed * expansionMetresPerSecond);
}

/**
 * Where to chase. Returns { x, z, leadSeconds } -- the target's predicted position after the time
 * it takes to close `closeDistance`-adjusted range at `speed`. leadSeconds is 0 when the target is
 * effectively stationary, or when we're already inside the range we're closing to.
 */
export function interceptPoint(target, velocity, self, options = {}) {
  const {
    speed = 0, closeDistance = 0,
    maxLeadSeconds = PURSUIT_DEFAULTS.maxLeadSeconds,
    minLeadSpeed = PURSUIT_DEFAULTS.minLeadSpeed,
  } = options;
  const still = { x: target.x, z: target.z, leadSeconds: 0 };
  if (!velocity || !(speed > 0)) return still;
  const targetSpeed = Math.hypot(velocity.x, velocity.z);
  if (!(targetSpeed >= minLeadSpeed)) return still;
  const gap = Math.hypot(target.x - self.x, target.z - self.z) - Math.max(0, closeDistance);
  if (!(gap > 0)) return still;
  const leadSeconds = Math.min(maxLeadSeconds, gap / speed);
  return { x: target.x + velocity.x * leadSeconds, z: target.z + velocity.z * leadSeconds, leadSeconds };
}

// Bearing offsets to try in order: straight on first, then alternating sides, widening.
// Alternating rather than sweeping one way keeps a 2-bot squad on opposite flanks.
export function pincerOffsets(rings = PURSUIT_DEFAULTS.pincerRings, step = PURSUIT_DEFAULTS.pincerStepRad) {
  const out = [0];
  for (let ring = 1; ring <= Math.max(0, rings); ring++) out.push(ring * step, -ring * step);
  return out;
}

/**
 * A point `range` from `target`, on the bearing back toward `from`, rotated by `offsetRad`.
 * `fallbackYaw` covers the degenerate case of standing exactly on the target.
 */
export function standoffPoint(target, from, range, offsetRad = 0, fallbackYaw = 0) {
  let dx = from.x - target.x, dz = from.z - target.z;
  let distance = Math.hypot(dx, dz);
  if (distance < 1e-4) {
    dx = -Math.sin(fallbackYaw); dz = -Math.cos(fallbackYaw); distance = 1;
  }
  const ux = dx / distance, uz = dz / distance;
  const cos = Math.cos(offsetRad), sin = Math.sin(offsetRad);
  // Standard XZ rotation; sign convention only has to be consistent for +/- offsets to mirror.
  const rx = ux * cos - uz * sin, rz = ux * sin + uz * cos;
  return { x: target.x + rx * range, z: target.z + rz * range };
}
