// Combat projectile entity — a damaging rocket or thrown grenade that flies, collides
// with targets/terrain, and detonates into an `explosion` entity. Pure math/state, no
// THREE. Distinct from entity-types/projectile.js (the light gun's cosmetic projectile,
// which only checks terrain height and spawns a light) — this one sweeps its path
// against players/creatures/mobs/obstacles via an injected ctx.raycast and spawns radial
// blast damage. See the orchestration plan
// (docs/superpowers/plans/2026-07-11-all-weapons-implementation-orchestration.md) and the
// html-game-v2 updatePlayerProjectiles port it mirrors.
//
// Injected ctx (from entity-registry tick / host wiring):
//   ctx.spawn(type, init)                    -> create a child entity (the explosion)
//   ctx.raycast(from, to, radius, ownerId)   -> { point:[x,y,z], kind } | null  (solid hit
//                                               along the swept segment; excludes owner)
//   ctx.terrainHeight(x, z)                  -> ground height
//
// Wire shape (serialize): renders as a moving light like the light-gun projectile.
//   { id, type:'projectile', p:[x,y,z], color:[r,g,b], radius, intensity, renders:true }

const DEFAULT_RADIUS = 0.4;     // collision radius (m)
const GROUND_CLEARANCE = 0.12;  // detonate/bounce when this close above terrain
const MAX_BOUNCES = 2;          // grenade bounces before it must detonate
const BOUNCE_MIN_LIFE = 0.35;   // below this remaining life, a grounded grenade detonates
const BOUNCE_VY = 0.38;         // vertical velocity retained per bounce
const BOUNCE_HORIZ = 0.72;      // horizontal velocity retained per bounce
const CONTACT_DAMP = 0.15;      // horizontal speed a COOKING grenade keeps after hitting something

function vec3(v, fallback) {
  if (!Array.isArray(v)) return fallback.slice();
  return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
}

export const CombatProjectileEntity = {
  type: 'combat-projectile',

  create(input = {}) {
    const origin = vec3(input.origin, [0, 0, 0]);
    const dir = vec3(input.dir, [0, 0, 1]);
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const speed = Number.isFinite(input.speed) ? input.speed : 60;
    const arc = vec3(input.arc, [0, 0, 0]);

    return {
      ownerId: input.ownerId || null,
      transform: { p: origin, q: [0, 0, 0, 1], s: [1, 1, 1] },
      state: {
        color: vec3(input.color, [1, 0.5, 0.2]),
        radius: Number.isFinite(input.radius) ? input.radius : DEFAULT_RADIUS,
        blastRadius: Number.isFinite(input.blastRadius) ? input.blastRadius : 8,
        damage: Number.isFinite(input.damage) ? input.damage : 100,
        bounces: input.bounces === true,        // grenade-style ground bouncing
        fizzleOnExpire: input.fizzleOnExpire === true, // rocket fizzles at life end; grenade airbursts
        // Opt-in cook behaviour: contact stops the grenade instead of setting it off, so the FUSE
        // decides when it blows. Off by default -- a rocket detonates on impact, and the shipped
        // game's grenades keep their contact behaviour until that is deliberately changed.
        cooks: input.cooks === true,
      },
      sim: {
        vx: (dir[0] / len) * speed + arc[0],
        vy: (dir[1] / len) * speed + arc[1],
        vz: (dir[2] / len) * speed + arc[2],
        gravity: Number.isFinite(input.gravity) ? input.gravity : 0,
        life: Number.isFinite(input.life) ? input.life : 8,
        fuse: Number.isFinite(input.fuse) ? input.fuse : Infinity,
        age: 0,
        bounceCount: 0,
        resting: false,   // cooked to a stop on the ground; only the fuse/life can end it now
      },
    };
  },

  update(entity, dt, ctx = {}) {
    dt = Math.max(0, dt || 0);
    const s = entity.state;
    const sim = entity.sim;
    const from = entity.transform.p;

    sim.age += dt;
    sim.life -= dt;

    // 1. Fuse timer, checked BEFORE any contact branch. A cook timer that only gets consulted while
    // the grenade is still airborne is no timer at all: a thrown grenade lands and runs out of
    // bounces in under a second, so every fuse longer than the throw used to be unreachable.
    if (sim.age >= sim.fuse) return detonate(entity, ctx, from);

    // 2. A cooking grenade that has come to rest is done moving — it just runs its timer out.
    if (sim.resting) {
      if (sim.life > 0) return null;
      return s.fizzleOnExpire ? { destroy: true, reason: 'expired' } : detonate(entity, ctx, from);
    }

    if (sim.gravity) sim.vy -= sim.gravity * dt;

    const to = [from[0] + sim.vx * dt, from[1] + sim.vy * dt, from[2] + sim.vz * dt];

    // 3. Swept-segment hit against solid targets/obstacles (owner excluded by the host).
    if (typeof ctx.raycast === 'function') {
      const hit = ctx.raycast(from, to, s.radius, entity.ownerId);
      if (hit && Array.isArray(hit.point)) {
        if (!s.cooks) return detonate(entity, ctx, hit.point);
        // Cooking: bonking a wall or a body kills the throw, it doesn't set the grenade off. Drop
        // it at the contact and let gravity take it to the floor, where it rests out its fuse.
        entity.transform.p = [hit.point[0], hit.point[1], hit.point[2]];
        sim.vx *= CONTACT_DAMP; sim.vz *= CONTACT_DAMP;
        sim.vy = Math.min(sim.vy, 0);
        return null;
      }
    }

    // 4. Terrain contact.
    const th = typeof ctx.terrainHeight === 'function' ? ctx.terrainHeight(to[0], to[2]) : -Infinity;
    if (to[1] <= th + GROUND_CLEARANCE) {
      if (s.bounces && sim.bounceCount < MAX_BOUNCES && sim.life > BOUNCE_MIN_LIFE) {
        to[1] = th + GROUND_CLEARANCE;
        sim.vy = Math.abs(sim.vy) * BOUNCE_VY;
        sim.vx *= BOUNCE_HORIZ;
        sim.vz *= BOUNCE_HORIZ;
        sim.bounceCount++;
        entity.transform.p = to;
        return null;
      }
      if (!s.cooks) return detonate(entity, ctx, [to[0], th + GROUND_CLEARANCE, to[2]]);
      entity.transform.p = [to[0], th + GROUND_CLEARANCE, to[2]];
      sim.vx = 0; sim.vy = 0; sim.vz = 0;
      sim.resting = true;
      return null;
    }

    entity.transform.p = to;

    // 5. Life expiry — grenade airbursts, rocket fizzles with no blast.
    if (sim.life <= 0) {
      if (s.fizzleOnExpire) return { destroy: true, reason: 'expired' };
      return detonate(entity, ctx, to);
    }

    return null;
  },

  serialize(entity) {
    const s = entity.state;
    const p = entity.transform.p;
    return {
      id: entity.id,
      type: 'projectile', // shares the light-gun projectile's renderer path (renders:true)
      p: [p[0], p[1], p[2]],
      color: [s.color[0], s.color[1], s.color[2]],
      radius: s.radius,
      intensity: 1,
      ownerId: entity.ownerId,
      renders: true,
    };
  },
};

// Spawn the blast and destroy the projectile.
function detonate(entity, ctx, at) {
  const s = entity.state;
  if (typeof ctx.spawn === 'function') {
    ctx.spawn('explosion', {
      p: at,
      radius: s.blastRadius,
      damage: s.damage,
      color: s.color,
      ownerId: entity.ownerId,
    });
  }
  return { destroy: true, reason: 'impact' };
}
