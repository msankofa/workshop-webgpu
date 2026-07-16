// Pure, THREE-free decision math for player-interactive creatures (pets / wildlife /
// hostiles). Imported by port-creature-system.js; unit-tested in test-creature-interaction.mjs.
// See docs/superpowers/specs/2026-07-11-creature-interaction-overhaul-design.md.

export const ROLE_WILD = 'wild';
export const ROLE_PET = 'pet';
export const ROLE_HOSTILE = 'hostile';

export const CMD_FOLLOW = 'follow';
export const CMD_STAY = 'stay';
export const CMD_GOTO = 'goto';
export const CMD_ATTACK = 'attack';

const EPS = 1e-6;

// Positional args + a reusable `out` object so hot per-frame callers (computeSteering) allocate
// nothing; pass a module-scoped scratch as `out`. `out` defaults to a fresh object for tests/
// one-off callers. Both write `{ dx, dz, moving, dist }` (hostile also `inRange`).

// Unit XZ steering toward the player that stops inside `standoff` (so pets don't jitter into the
// player). When `spreadAngle` (radians) is non-null, aim at a ring slot at that bearing/`standoff`
// around the player instead of the player center, so grouped pets fan out instead of stacking.
export function followDesire(selfX, selfZ, playerX, playerZ, standoff = 2.2, spreadAngle = null, out = {}) {
  let tx = playerX, tz = playerZ, stop = standoff;
  if (spreadAngle != null) {
    tx = playerX + Math.sin(spreadAngle) * standoff;
    tz = playerZ + Math.cos(spreadAngle) * standoff;
    stop = 0.4;
  }
  const dx = tx - selfX, dz = tz - selfZ;
  const dist = Math.hypot(dx, dz);
  if (dist <= stop) { out.dx = 0; out.dz = 0; out.moving = false; out.dist = dist; return out; }
  const inv = dist > EPS ? 1 / dist : 0;
  out.dx = dx * inv; out.dz = dz * inv; out.moving = true; out.dist = dist;
  return out;
}

// Approach the player until within `attackRange` (then hold + strike), or flee directly away when
// `weak`. `inRange` gates the melee/damage state in the caller.
export function hostileDesire(selfX, selfZ, playerX, playerZ, attackRange = 1.4, weak = false, out = {}) {
  const dx = playerX - selfX, dz = playerZ - selfZ;
  const dist = Math.hypot(dx, dz);
  const inv = dist > EPS ? 1 / dist : 0;
  if (weak) {
    out.dx = -dx * inv; out.dz = -dz * inv; out.moving = dist > EPS; out.inRange = false; out.dist = dist;
    return out;
  }
  if (dist <= attackRange) { out.dx = 0; out.dz = 0; out.moving = false; out.inRange = true; out.dist = dist; return out; }
  out.dx = dx * inv; out.dz = dz * inv; out.moving = true; out.inRange = false; out.dist = dist;
  return out;
}

// Whether a strike (hand world point) contacts the player capsule. `playerY` is the capsule
// CENTER (matches getLocalPlayerState's p, which is the capsule midpoint).
export function meleeHitsPlayer({
  handX, handY, handZ, playerX, playerY, playerZ,
  playerRadius = 0.35, playerHeight = 1.6, margin = 0.25,
}) {
  const half = playerHeight * 0.5;
  const yMin = playerY - half, yMax = playerY + half;
  const cy = Math.max(yMin, Math.min(yMax, handY));
  const dx = handX - playerX, dz = handZ - playerZ, dy = handY - cy;
  return Math.sqrt(dx * dx + dz * dz + dy * dy) <= playerRadius + margin;
}

function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Self-relative wander target: heading biased away from where we came from (`prev`), distance in
// [minStep, maxStep]. `bounds` is null (infinite world) or {minX,maxX,minZ,maxZ}; out-of-bounds
// picks retry, then clamp as a last resort. Deterministic given `rand`. Writes/returns `out`.
const ROAM_CONE = (110 * Math.PI) / 180; // half-angle around "forward" (self - prev) that new headings prefer
export function pickRoamTarget(selfX, selfZ, prevX, prevZ, minStep, maxStep, bounds, rand = Math.random, out = {}) {
  const fx = selfX - prevX, fz = selfZ - prevZ;
  const prevDist = Math.hypot(fx, fz);
  const hasForward = prevDist > EPS;
  const forwardAng = hasForward ? Math.atan2(fx, fz) : 0;
  const tries = 8;
  let lastX = selfX, lastZ = selfZ;
  for (let i = 0; i < tries; i++) {
    const free = !hasForward || i >= tries - 2; // widen to full circle once bounds keep rejecting us
    const ang = free ? rand() * Math.PI * 2 : forwardAng + (rand() * 2 - 1) * ROAM_CONE;
    const dist = minStep + rand() * Math.max(0, maxStep - minStep);
    const tx = selfX + Math.sin(ang) * dist;
    const tz = selfZ + Math.cos(ang) * dist;
    if (!bounds || (tx >= bounds.minX && tx <= bounds.maxX && tz >= bounds.minZ && tz <= bounds.maxZ)) {
      out.x = tx; out.z = tz;
      return out;
    }
    lastX = tx; lastZ = tz;
  }
  out.x = bounds ? clampNum(lastX, bounds.minX, bounds.maxX) : lastX;
  out.z = bounds ? clampNum(lastZ, bounds.minZ, bounds.maxZ) : lastZ;
  return out;
}

// Keep ~`target` wild creatures around the player: cull any `existing` ({id,x,z}) beyond
// `cullRadius`, and spawn up to `maxSpawnPerCall` new ones on the ring [ringMin,ringMax].
// Deterministic given `rand`.
export function wildlifeSpawnPlan({
  playerX, playerZ, existing = [], target = 8,
  ringMin = 40, ringMax = 70, cullRadius = 120, rand = Math.random, maxSpawnPerCall = 2,
}) {
  const despawnIds = [];
  let near = 0;
  for (const e of existing) {
    const d = Math.hypot(e.x - playerX, e.z - playerZ);
    if (d > cullRadius) despawnIds.push(e.id);
    else near++;
  }
  const deficit = Math.max(0, target - near);
  const n = Math.min(deficit, Math.max(0, maxSpawnPerCall));
  const spawns = [];
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2;
    const r = ringMin + rand() * Math.max(0, ringMax - ringMin);
    spawns.push({ x: playerX + Math.cos(ang) * r, z: playerZ + Math.sin(ang) * r });
  }
  return { spawns, despawnIds };
}
