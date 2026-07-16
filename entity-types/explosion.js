// Explosion entity type — a short-lived radial-damage burst. Pure math/state, no
// THREE, no renderer calls. Host-spawned and snapshot-owned so every client sees the
// same blast; effect-renderer.js draws the flash from its serialized form.
//
// Damage math is ported from html-game-v2's damageEnemiesInRadius: linear falloff from
// center (100%) to edge (45%), floored — see
// docs/superpowers/plans/2026-07-11-all-weapons-implementation-orchestration.md.
// The actual target enumeration + HP mutation lives in the injected ctx.applyBlast
// (host wiring reuses resolveWorldShot / playerCombat / creatures), so this module
// stays THREE-free and Node-testable. friendly-fire + self-damage are ON (owned by
// applyBlast); this entity just triggers the query once, at spawn.
//
// Wire shape (serialize):
//   { id, type:'explosion', p:[x,y,z], radius, color:[r,g,b], life, intensity, renders:true }

const DEFAULT_LIFE = 0.42;   // seconds the blast point-light lives (short, punchy flash)
const VISUAL_LIFE = 1.8;     // seconds the replicated visual effect lives (smoke lingers)
const DEFAULT_COLOR = [1, 0.55, 0.2];
const DAMAGE_FLOOR = 12; // minimum damage a target inside the radius takes (edge hit)

// Shared falloff so combat-projectile / tests / applyBlast agree on the curve.
// dist/radius in [0,1] -> multiplier in [0.45 .. 1.0]; >radius -> 0.
export function blastFalloff(dist, radius) {
  if (!(radius > 0) || dist >= radius) return 0;
  return 0.45 + (1 - dist / radius) * 0.55;
}

// Pure helper: scaled damage for a target at `dist` from a blast of `baseDamage`/`radius`.
export function blastDamageAt(baseDamage, dist, radius, floor = DAMAGE_FLOOR) {
  const m = blastFalloff(dist, radius);
  if (m <= 0) return 0;
  return Math.max(floor, Math.round(baseDamage * m));
}

function vec3(v, fallback) {
  if (!Array.isArray(v)) return fallback.slice();
  return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
}

export const ExplosionEntity = {
  type: 'explosion',

  create(input = {}, ctx = {}) {
    const p = vec3(input.p || input.origin, [0, 0, 0]);
    const radius = Number.isFinite(input.radius) ? input.radius : 8;
    const damage = Number.isFinite(input.damage) ? input.damage : 0;
    const color = vec3(input.color, DEFAULT_COLOR);
    const life = Number.isFinite(input.life) ? input.life : DEFAULT_LIFE;
    const floor = Number.isFinite(input.damageFloor) ? input.damageFloor : DAMAGE_FLOOR;

    // Host-authoritative damage happens ONCE, at spawn. applyBlast owns which units are
    // enumerated (players/creatures/mobs), friendly-fire, and self-damage; it may call
    // blastDamageAt for the falloff or apply its own. Guests never run create() for
    // registry entities (they applySnapshot), so this never double-hits.
    if (typeof ctx.applyBlast === 'function') {
      ctx.applyBlast({ center: p, radius, damage, ownerId: input.ownerId || null, floor });
    }

    // Spawn the replicated visual (an 'effect' kind:'explosion' the effect-renderer draws).
    // spawnEffect is a host-tick closure onto entityRegistry.create('effect', …); guests
    // receive the effect over the wire and never run this path.
    if (typeof ctx.spawnEffect === 'function') {
      // Visual outlives the light: the effect-renderer sub-times flash/shockwave/embers/
      // shrapnel/smoke inside VISUAL_LIFE, so smoke lingers after the point-light fades.
      ctx.spawnEffect({ kind: 'explosion', p, color, radius, life: VISUAL_LIFE, ownerId: input.ownerId || null });
    }

    return {
      ownerId: input.ownerId || null,
      transform: { p, q: [0, 0, 0, 1], s: [1, 1, 1] },
      state: { radius, color, life, damage },
      sim: { age: 0 },
    };
  },

  update(entity, dt) {
    entity.sim.age += Math.max(0, dt || 0);
    if (entity.sim.age >= entity.state.life) return { destroy: true, reason: 'expired' };
    return null;
  },

  // Renders as a bright, brief point light (via renders:true) plus an explosion effect.
  serialize(entity) {
    const s = entity.state;
    const p = entity.transform.p;
    // Flash fades over life, sharp curve so the light blooms bright then drops fast.
    const k = Math.pow(Math.max(0, 1 - entity.sim.age / s.life), 2);
    return {
      id: entity.id,
      type: 'explosion',
      p: [p[0], p[1], p[2]],
      radius: s.radius,
      color: [s.color[0], s.color[1], s.color[2]],
      life: s.life,
      intensity: k,
      ownerId: entity.ownerId,
      renders: true,
    };
  },
};
