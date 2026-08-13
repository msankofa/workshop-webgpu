// Effect entity type — short-lived, non-physics combat visuals (bullet tracers, impact
// sparks, muzzle flashes, and explosion blasts). Pure math/state, no THREE. Host-spawned and
// snapshot-owned so every client sees the same shot result; effect-renderer.js draws them.
// See the multiplayer-guns design doc ("Visual Effects"). Effects self-destroy on tick once
// their lifespan elapses.
//
// Lifespans are the OUTER envelope: effect-renderer.js sub-times each visual layer (flash,
// shockwave, embers, shrapnel, smoke) inside this window, so `life` is set to the longest
// layer (smoke lingers well past the flash). Ported from html-game-v2's layered explosion
// (createEnemyDeathExplosion / explodePlayerProjectile).
//
// Wire shapes (serialize):
//   { id, type:'effect', kind:'gun_tracer',   p:[x,y,z], p1:[x,y,z], color:[r,g,b], life, tracerFx }
//   { id, type:'effect', kind:'hit_spark',    p:[x,y,z], normal:[x,y,z], color, surface, life }
//   { id, type:'effect', kind:'muzzle_flash', p:[x,y,z], dir:[x,y,z], color:[r,g,b], life }
//   { id, type:'effect', kind:'explosion',    p:[x,y,z], color:[r,g,b], radius, life }
//   { id, type:'effect', kind:'smoke_puff',   p:[x,y,z], color:[r,g,b], life, size, growth, rise, drift:[x,y,z], opacity }
//   { id, type:'effect', kind:'blood_spray',    p, normal, color, life, count, spread, speed, gravity, size, bodyPart }
//   { id, type:'effect', kind:'blood_stain',    p, normal, color, life, size, opacity, bodyPart }
//   { id, type:'effect', kind:'blood_splatter', p, normal, color, life, count, spread, speed, gravity, size, opacity, bodyPart }
//
// smoke_puff is ONE sprite, not an emitter: a rocket trail is ~30-60 independent puff entities
// spawned every ~35 ms of flight, each with its OWN id (firstSeen keys age off the id, so an id
// must never be reused for a later puff). Defaults: life 1.2, size 0.35, growth 0.9, rise 0.35,
// drift [0,0,0], opacity 0.3, color [0.42,0.4,0.38]. Rendered position is
// p + drift*t + up*rise*t; radius is size + growth*(t/life); alpha fades in fast and out to zero.
// A rocket trail wants near-zero drift and slow rise; a blast wisp wants more of both.
//
// Three blood kinds split by where the blood actually ends up:
//   - blood_spray: the droplets in flight — a short gravity-arced burst (defaults: life 0.6,
//     count 28, spread 1.0, speed 4.2, gravity 9.8, size 0.03), scattered around `normal`.
//   - blood_stain: the mark left AT the wound — a small, high-opacity decal quad stuck to the hit
//     surface, oriented to `normal` (defaults: life 6.0, size 0.15, opacity 0.92).
//   - blood_splatter: where those same flying droplets land nearby — decal quads on the GROUND
//     (not the hit surface), positioned by resolving each droplet's own ballistic fall time to the
//     injected terrain height rather than reusing `p`/`normal` for placement (defaults: life 8.0,
//     count 10, spread 1.0, speed 4.2, gravity 9.8, size 0.12, opacity 0.8). Shares blood_spray's
//     count/spread/speed/gravity fields because it's resolving the SAME kind of scatter forward to
//     a landing point instead of animating the flight — it is not literally the same droplets
//     (independent `id`, independent RNG stream), just the same physics.
// blood_stain and blood_splatter both render as decal quads, not billboard sprites, since a
// billboard can't be stuck to a surface normal (camera-facing only). `bodyPart` on any of the three
// is a free-form string (e.g. 'head'/'torso'/'limb') a caller can use to scale it by hit location;
// it carries no meaning inside this module.

import { normalizeTracerFx } from '../tracer-visual.js';

const DEFAULT_LIFE = {
  gun_tracer: 0.12, hit_spark: 0.6, muzzle_flash: 0.42, explosion: 1.8, smoke_puff: 1.2,
  blood_spray: 0.6, blood_stain: 6.0, blood_splatter: 8.0,
};
const EFFECT_KINDS = new Set([
  'gun_tracer', 'hit_spark', 'muzzle_flash', 'explosion', 'smoke_puff',
  'blood_spray', 'blood_stain', 'blood_splatter',
]);
const BLOOD_KINDS = new Set(['blood_spray', 'blood_stain', 'blood_splatter']);
const SMOKE_GRAY = [0.42, 0.4, 0.38];
const BLOOD_RED = [0.4, 0.02, 0.03];

function vec3(v, fallback) {
  if (!Array.isArray(v)) return fallback.slice();
  return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
}

export const EffectEntity = {
  type: 'effect',

  create(input = {}) {
    const kind = EFFECT_KINDS.has(input.kind) ? input.kind : 'gun_tracer';
    const p0 = vec3(input.p0 || input.p, [0, 0, 0]);
    const life = Number.isFinite(input.life) ? input.life : DEFAULT_LIFE[kind];
    return {
      ownerId: input.ownerId || null,
      transform: { p: p0, q: [0, 0, 0, 1], s: [1, 1, 1] },
      state: {
        kind,
        p1: vec3(input.p1, p0),
        normal: vec3(input.normal, [0, 1, 0]),
        dir: vec3(input.dir, [0, 0, 1]),
        color: vec3(input.color, kind === 'smoke_puff' ? SMOKE_GRAY : BLOOD_KINDS.has(kind) ? BLOOD_RED : [1, 0.85, 0.45]),
        surface: input.surface || null,
        drift: vec3(input.drift, [0, 0, 0]),                                          // smoke_puff wind/inherited velocity (m/s)
        rise: Number.isFinite(input.rise) ? input.rise : 0.35,                        // smoke_puff buoyancy (m/s)
        size: Number.isFinite(input.size) ? input.size
          : kind === 'blood_stain' ? 0.15 : kind === 'blood_splatter' ? 0.12 : kind === 'blood_spray' ? 0.03 : 0.35,
        growth: Number.isFinite(input.growth) ? input.growth : 0.9,                   // smoke_puff radius gained over full life (m)
        opacity: Number.isFinite(input.opacity) ? input.opacity
          : kind === 'blood_stain' ? 0.92 : kind === 'blood_splatter' ? 0.8 : 0.3,
        radius: Number.isFinite(input.radius) ? input.radius : 0, // explosion blast radius (visual scale)
        count: Number.isFinite(input.count) ? input.count : (kind === 'blood_splatter' ? 10 : 28), // droplet/decal count (blood_spray, blood_splatter)
        spread: Number.isFinite(input.spread) ? input.spread : 1.0,       // scatter around normal (blood_spray, blood_splatter)
        speed: Number.isFinite(input.speed) ? input.speed : 4.2,          // initial droplet speed, m/s (blood_spray, blood_splatter)
        gravity: Number.isFinite(input.gravity) ? input.gravity : 9.8,    // droplet fall accel, m/s^2 (blood_spray, blood_splatter)
        bodyPart: input.bodyPart || null,                                 // free-form hit-location tag, e.g. 'head'/'torso'/'limb'
        // blood_stain only: opaque handle pinning the decal to a body part, built by
        // bot-body-hit.js and resolved back to a live matrix by whatever the renderer was given as
        // resolveAttachment. Null means a world-anchored decal, which is the old behaviour.
        attach: input.attach || null,
        tracerFx: normalizeTracerFx(input.tracerFx),
        life,
      },
      sim: { age: 0 },
    };
  },

  update(entity, dt) {
    entity.sim.age += dt;
    if (entity.sim.age >= entity.state.life) return { destroy: true, reason: 'expired' };
    return null;
  },

  serialize(entity) {
    const s = entity.state;
    const p = entity.transform.p;
    const wire = {
      id: entity.id,
      type: 'effect',
      kind: s.kind,
      p: [p[0], p[1], p[2]],
      color: [s.color[0], s.color[1], s.color[2]],
      life: s.life,
      ownerId: entity.ownerId,
    };
    if (s.kind === 'gun_tracer') {
      wire.p1 = [s.p1[0], s.p1[1], s.p1[2]];
      wire.tracerFx = { ...s.tracerFx };
    }
    else if (s.kind === 'muzzle_flash') wire.dir = [s.dir[0], s.dir[1], s.dir[2]];
    else if (s.kind === 'explosion') wire.radius = s.radius;
    else if (s.kind === 'smoke_puff') {
      wire.drift = [s.drift[0], s.drift[1], s.drift[2]];
      wire.rise = s.rise; wire.size = s.size; wire.growth = s.growth; wire.opacity = s.opacity;
    }
    else if (s.kind === 'blood_spray') {
      wire.normal = [s.normal[0], s.normal[1], s.normal[2]];
      wire.count = s.count; wire.spread = s.spread; wire.speed = s.speed; wire.gravity = s.gravity;
      wire.size = s.size; wire.bodyPart = s.bodyPart;
    }
    else if (s.kind === 'blood_stain') {
      wire.normal = [s.normal[0], s.normal[1], s.normal[2]];
      wire.size = s.size; wire.opacity = s.opacity; wire.bodyPart = s.bodyPart;
      // This branch is a whitelist, not a passthrough — a field missing here never reaches the wire,
      // and the bug looks like "attachment works locally, decals are static for guests".
      if (s.attach) wire.attach = s.attach;
    }
    else if (s.kind === 'blood_splatter') {
      // Same fields as blood_spray plus opacity — the renderer resolves these droplets forward to
      // a ground landing point instead of animating their flight. `normal`/`p` seed the scatter
      // direction and origin, same role they play for blood_spray; they are NOT where the decals
      // end up (that's resolved against injected terrain height in effect-renderer.js).
      wire.normal = [s.normal[0], s.normal[1], s.normal[2]];
      wire.count = s.count; wire.spread = s.spread; wire.speed = s.speed; wire.gravity = s.gravity;
      wire.size = s.size; wire.opacity = s.opacity; wire.bodyPart = s.bodyPart;
    }
    else { wire.normal = [s.normal[0], s.normal[1], s.normal[2]]; wire.surface = s.surface; }
    return wire;
  },
};
