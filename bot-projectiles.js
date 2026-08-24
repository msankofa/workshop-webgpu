// Thrown/fired projectile helpers for the bot sim: ballistic aiming, arc sampling, and a
// lifetime manager that wraps entity-types/combat-projectile.js. Pure math — no THREE, no DOM.
// The flight sim (gravity, bounce, fuse, life, fizzle, swept raycast, detonation) lives in
// CombatProjectileEntity; this module only owns aiming, ids, trails, and the live list.
import { CombatProjectileEntity } from './entity-types/combat-projectile.js';

const EPS = 1e-6;

// Low-arc launch velocity of magnitude `speed` from `from` that lands on `to`. null = no solution.
export function solveBallisticArc(from, to, speed, gravity) {
  if (!Array.isArray(from) || !Array.isArray(to)) return null;
  const v = Number(speed);
  if (!Number.isFinite(v) || v <= 0) return null;
  const dx = Number(to[0]) - Number(from[0]);
  const dy = Number(to[1]) - Number(from[1]);
  const dz = Number(to[2]) - Number(from[2]);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return null;

  const g = Number(gravity);
  // No gravity (or a bad value): straight line at full speed.
  if (!Number.isFinite(g) || g <= 0) {
    const len = Math.hypot(dx, dy, dz);
    if (len < EPS) return null;
    return { vx: (dx / len) * v, vy: (dy / len) * v, vz: (dz / len) * v };
  }

  const d = Math.hypot(dx, dz);
  if (d < EPS) return null; // straight-up shots have no low-arc solution
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  if (!(disc >= 0)) return null; // out of range (also catches NaN)

  const tanTheta = (v2 - Math.sqrt(disc)) / (g * d); // smaller root = flat trajectory
  if (!Number.isFinite(tanTheta)) return null;
  const theta = Math.atan(tanTheta);
  const horiz = v * Math.cos(theta);
  const vy = v * Math.sin(theta);
  const vx = (horiz * dx) / d;
  const vz = (horiz * dz) / d;
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) return null;
  return { vx, vy, vz };
}

// Ballistic path points at t = span*i/steps, i = 0..steps (so the first point is `from`).
export function sampleArcPoints(from, vel, gravity, steps = 6, span = 2.0) {
  const out = [];
  if (!Array.isArray(from) || !vel) return out;
  const n = Math.max(1, Math.floor(steps) || 1);
  const t1 = Number.isFinite(span) ? span : 0;
  const g = Number.isFinite(gravity) && gravity > 0 ? gravity : 0;
  const x0 = Number(from[0]) || 0, y0 = Number(from[1]) || 0, z0 = Number(from[2]) || 0;
  const vx = Number(vel.vx) || 0, vy = Number(vel.vy) || 0, vz = Number(vel.vz) || 0;
  for (let i = 0; i <= n; i++) {
    const t = (t1 * i) / n;
    out.push([x0 + vx * t, y0 + vy * t - 0.5 * g * t * t, z0 + vz * t]);
  }
  return out;
}

// Owns the live projectile list, ids, trail cadence, and detonation callbacks.
export function createProjectileManager({
  raycast = null,
  terrainHeight = null,
  onDetonate = null,
  onTrail = null,
  trailIntervalS = 0.035,
} = {}) {
  const list = [];
  let nextId = 1;
  let detonating = null; // projectile whose CP.update is currently running

  // ctx.spawn intercepts combat-projectile's 'explosion' spawn — every detonation path
  // (raycast hit, terrain, fuse, life airburst) funnels through it; fizzles never do.
  const ctx = {
    spawn(type, init) {
      if (type !== 'explosion' || !detonating) return null;
      // Third argument is the raw explosion init, so a caller can read `cause` without this module
      // re-deriving it. Callers written before it simply ignore the extra argument.
      if (typeof onDetonate === 'function') onDetonate(init && init.p ? init.p : detonating.transform.p, detonating, init || null);
      return null;
    },
  };
  if (typeof raycast === 'function') ctx.raycast = raycast;
  if (typeof terrainHeight === 'function') ctx.terrainHeight = terrainHeight;

  const interval = Number.isFinite(trailIntervalS) && trailIntervalS > 0 ? trailIntervalS : 0;

  function spawn(init = {}) {
    const proj = CombatProjectileEntity.create(init);
    proj.id = `bp${nextId++}`;
    proj.weaponId = init.weaponId || null;
    proj.throwerActorId = init.throwerActorId != null ? init.throwerActorId : null;
    proj.prevP = proj.transform.p;
    proj.trailAccum = 0;
    list.push(proj);
    return proj;
  }

  function update(dt) {
    const step = Math.max(0, Number(dt) || 0);
    for (let i = list.length - 1; i >= 0; i--) {
      const proj = list[i];
      proj.prevP = proj.transform.p; // CP.update always assigns a fresh array, so this stays valid
      detonating = proj;
      let res = null;
      try {
        res = CombatProjectileEntity.update(proj, step, ctx);
      } finally {
        detonating = null;
      }
      if (res && res.destroy) { list.splice(i, 1); continue; }
      if (typeof onTrail !== 'function') continue;
      if (interval <= 0) { onTrail(proj, proj.transform.p); continue; }
      proj.trailAccum += step;
      while (proj.trailAccum >= interval) {
        proj.trailAccum -= interval;
        onTrail(proj, proj.transform.p);
      }
    }
  }

  function clear() { list.length = 0; }

  return { list, spawn, update, clear };
}

// Nearest live grenade-like projectile whose blast would cover `pointArr`, else null.
export function livingGrenadeThreat(list, pointArr, extraRadius = 0) {
  if (!Array.isArray(list) || !Array.isArray(pointArr)) return null;
  const px = Number(pointArr[0]) || 0, py = Number(pointArr[1]) || 0, pz = Number(pointArr[2]) || 0;
  const extra = Number.isFinite(extraRadius) ? extraRadius : 0;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < list.length; i++) {
    const proj = list[i];
    if (!proj || !proj.state || !proj.transform) continue;
    if (proj.weaponId !== 'grenade' && proj.state.bounces !== true) continue;
    const p = proj.transform.p;
    const dist = Math.hypot(px - p[0], py - p[1], pz - p[2]);
    if (!Number.isFinite(dist)) continue;
    const reach = (Number(proj.state.blastRadius) || 0) + extra;
    if (dist > reach || dist >= bestDist) continue;
    bestDist = dist;
    best = proj;
  }
  return best;
}
