// Effect entity type — short-lived, non-physics combat visuals (bullet tracers, impact
// sparks). Pure math/state, no THREE. Host-spawned and snapshot-owned so every client sees
// the same shot result; effect-renderer.js draws them. See the multiplayer-guns design doc
// ("Visual Effects"). Effects self-destroy on tick once their lifespan elapses.
//
// Wire shapes (serialize):
//   { id, type:'effect', kind:'gun_tracer', p:[x,y,z], p1:[x,y,z], color:[r,g,b], life }
//   { id, type:'effect', kind:'hit_spark',  p:[x,y,z], normal:[x,y,z], color:[r,g,b],
//     surface:'player'|'creature'|'obstacle'|'terrain', life }

const DEFAULT_LIFE = { gun_tracer: 0.09, hit_spark: 0.22, explosion: 0.55 };
const EFFECT_KINDS = new Set(['gun_tracer', 'hit_spark', 'explosion']);

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
        color: vec3(input.color, [1, 0.85, 0.45]),
        surface: input.surface || null,
        radius: Number.isFinite(input.radius) ? input.radius : 0, // explosion blast radius (for visual scale)
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
    if (s.kind === 'gun_tracer') wire.p1 = [s.p1[0], s.p1[1], s.p1[2]];
    else if (s.kind === 'explosion') { wire.kind = 'explosion'; wire.radius = s.radius; }
    else { wire.normal = [s.normal[0], s.normal[1], s.normal[2]]; wire.surface = s.surface; }
    return wire;
  },
};
