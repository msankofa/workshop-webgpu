// Projectile entity type adapter — pure math/state, no THREE, no renderer calls.
// Generic payload-carrying projectile. Ported from environment-viewer.html's
// lgCreateSharedProjectile + the "projectile" branch of lgUpdateSharedLightsHost.
//
// Wire shape (allowlisted in serialize):
//   { id, type:'projectile', p:[x,y,z], color:[r,g,b] (0..1), radius,
//     intensity, ownerId, renders:true }
//
// Render marker choice: `renders:true` is a boolean flag (rather than
// repurposing `type`) so the renderer binding layer (light-entity-renderer.js,
// step 2) can key its "does this serialized entity want a light slot?"
// predicate on `entity.renders === true` regardless of `type`. `type` stays
// 'projectile' so consumers that care about entity kind (debug UI, future
// non-light payloads) aren't forced to sniff renders. Per the plan, an
// in-flight projectile renders as a moving light at FULL brightness (no
// "faint tracer" dimming) — same as today's shared-light behavior.

import { normalizeParamsPacket, sharedLightColor, clampNumber } from './light.js';

const LG_MIN_SPEED = 8;
const LG_MAX_SPEED = 60;
const LG_FALL_GRAVITY = 14;
export const MP_LIGHT_MAX_FLIGHT = 10;

export const ProjectileEntity = {
  type: 'projectile',

  create(input = {}, ctx = {}) {
    const origin = Array.isArray(input.origin) ? input.origin : [0, 0, 0];
    const dir = Array.isArray(input.dir) ? input.dir : [0, 0, 1];
    const len = Math.hypot(Number(dir[0]) || 0, Number(dir[1]) || 0, Number(dir[2]) || 0) || 1;
    const nx = (Number(dir[0]) || 0) / len;
    const ny = (Number(dir[1]) || 0) / len;
    const nz = (Number(dir[2]) || 0) / len;

    const chargeRatio = clampNumber(input.chargeRatio, 0, 0, 1);
    const speed = LG_MIN_SPEED + chargeRatio * (LG_MAX_SPEED - LG_MIN_SPEED);

    const x = Number(origin[0]) || 0;
    const y = Number(origin[1]) || 0;
    const z = Number(origin[2]) || 0;

    const payloadType = (input.payload && input.payload.type) || 'light';
    const payloadParams = normalizeParamsPacket((input.payload && input.payload.params) || {});
    const arc = input.arc !== undefined ? !!input.arc : payloadParams.trajectory !== 'straight';
    const c = sharedLightColor(payloadParams);

    return {
      ownerId: input.ownerId || null,
      transform: { p: [x, y, z], q: [0, 0, 0, 1], s: [1, 1, 1] },
      state: {
        color: c,
        radius: payloadParams.radius,
        decay: payloadParams.decay,
        brightness: payloadParams.brightness,
        payload: { type: payloadType, params: payloadParams },
      },
      sim: {
        vx: nx * speed, vy: ny * speed, vz: nz * speed,
        arc,
        age: 0,
      },
    };
  },

  update(entity, dt, ctx = {}) {
    const s = entity.state;
    const sim = entity.sim;
    let [x, y, z] = entity.transform.p;

    sim.age += dt;
    if (sim.arc) sim.vy -= LG_FALL_GRAVITY * dt;
    x += sim.vx * dt;
    y += sim.vy * dt;
    z += sim.vz * dt;
    entity.transform.p = [x, y, z];

    const th = typeof ctx.terrainHeight === 'function' ? ctx.terrainHeight(x, z) : 0;
    const hit = y <= th;
    const expired = sim.age > MP_LIGHT_MAX_FLIGHT;

    if (hit || expired) {
      if (typeof ctx.spawn === 'function') {
        const params = s.payload.params;
        ctx.spawn(s.payload.type, {
          x, y: hit ? th + (params.float ? 1.5 : 0.2) : y, z,
          params,
          ownerId: entity.ownerId,
          spawnedFrom: entity.id,
        });
      }
      return { destroy: true, reason: hit ? 'impact' : 'expired' };
    }

    return null;
  },

  // Allowlist-based: renders at full brightness while in flight.
  serialize(entity) {
    const s = entity.state;
    const p = entity.transform.p;
    return {
      id: entity.id,
      type: 'projectile',
      p: [p[0], p[1], p[2]],
      color: [s.color.r, s.color.g, s.color.b],
      radius: s.radius,
      decay: s.decay,
      intensity: s.brightness,
      ownerId: entity.ownerId,
      renders: true,
    };
  },
};
