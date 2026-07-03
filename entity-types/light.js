// Light entity type adapter — pure math/state, no THREE, no renderer calls.
// Ported from environment-viewer.html's lgNormalizeParamsPacket /
// lgSharedLightColor / the "placed" branch of lgUpdateSharedLightsHost.
//
// Wire shape (allowlisted in serialize — see header note below):
//   { id, type:'light', p:[x,y,z], color:[r,g,b] (0..1), radius, intensity,
//     lifespan, totalLife, ownerId, spawnedFrom? }
//
// `spawnedFrom` (when present) is the id of the projectile this light was
// converted from on impact — carried so guest interpolation can use the
// projectile's last known position/color as this new id's lerp predecessor
// instead of popping in (see plan "Interpolation continuity").

const LG_FALL_GRAVITY = 14;
const LG_FADE_WINDOW = 2;

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Normalizes a raw params packet (as sent over the wire / passed from the UI)
// against a base of defaults. Mirrors lgNormalizeParamsPacket.
function normalizeParamsPacket(packet = {}, base = {}) {
  const b = {
    trajectory: 'arc', float: true, drift: false,
    lifespan: 15, r: 255, g: 180, b: 80, brightness: 60, radius: 30,
    ...base,
  };
  return {
    trajectory: packet.trajectory === 'straight' ? 'straight' : 'arc',
    float: packet.float === undefined ? b.float : !!packet.float,
    drift: packet.drift === undefined ? b.drift : !!packet.drift,
    lifespan: clampNumber(packet.lifespan, b.lifespan, 0.5, 120),
    r: clampNumber(packet.r, b.r, 0, 255),
    g: clampNumber(packet.g, b.g, 0, 255),
    b: clampNumber(packet.b, b.b, 0, 255),
    brightness: clampNumber(packet.brightness, b.brightness, 0, 500),
    radius: clampNumber(packet.radius, b.radius, 0.1, 200),
  };
}

function sharedLightColor(params) {
  return { r: params.r / 255, g: params.g / 255, b: params.b / 255 };
}

export const LightEntity = {
  type: 'light',

  create(input = {}, ctx = {}) {
    const p = normalizeParamsPacket(input.params || input);
    const c = sharedLightColor(p);
    const x = Number(input.x) || 0;
    const y = Number(input.y) || 0;
    const z = Number(input.z) || 0;
    const floating = !!p.float;

    return {
      ownerId: input.ownerId || null,
      transform: { p: [x, y, z], q: [0, 0, 0, 1], s: [1, 1, 1] },
      state: {
        color: c,
        radius: p.radius,
        brightness: p.brightness,
        lifespan: p.lifespan,
        totalLife: p.lifespan,
        float: floating,
        drift: !!p.drift,
        ...(input.spawnedFrom ? { spawnedFrom: input.spawnedFrom } : {}),
      },
      sim: {
        vy: 0,
        grounded: floating,
        driftPhase: Math.random() * Math.PI * 2,
        age: 0,
      },
    };
  },

  update(entity, dt, ctx = {}) {
    const s = entity.state;
    const sim = entity.sim;
    const [x0, y0, z0] = entity.transform.p;
    let x = x0, y = y0, z = z0;

    if (!s.float && !sim.grounded) {
      sim.vy -= LG_FALL_GRAVITY * dt;
      y += sim.vy * dt;
      const th = typeof ctx.terrainHeight === 'function' ? ctx.terrainHeight(x, z) : 0;
      if (y <= th) { y = th; sim.vy = 0; sim.grounded = true; }
    }

    s.lifespan -= dt;
    entity.transform.p = [x, y, z];

    if (s.lifespan <= 0) {
      return { destroy: true, reason: 'expired' };
    }

    sim.age += dt;
    let xOff = 0, zOff = 0;
    if (s.float && s.drift) {
      xOff = Math.sin(sim.age * 0.3 + sim.driftPhase) * 3;
      zOff = Math.cos(sim.age * 0.27 + sim.driftPhase) * 3;
    }
    const fadeScale = s.lifespan < LG_FADE_WINDOW ? Math.max(0, s.lifespan / LG_FADE_WINDOW) : 1;

    sim.renderP = [x + xOff, y, z + zOff];
    sim.intensity = s.brightness * fadeScale;

    return null;
  },

  // Allowlist-based: only ever emit these fields on the wire. `sim`
  // (velocity/driftPhase/grounded/age) is host-private and never leaks.
  serialize(entity) {
    const s = entity.state;
    const sim = entity.sim;
    const p = sim.renderP || entity.transform.p;
    const intensity = sim.intensity !== undefined ? sim.intensity : s.brightness;
    const out = {
      id: entity.id,
      type: 'light',
      p: [p[0], p[1], p[2]],
      color: [s.color.r, s.color.g, s.color.b],
      radius: s.radius,
      intensity,
      lifespan: s.lifespan,
      totalLife: s.totalLife,
      ownerId: entity.ownerId,
    };
    if (s.spawnedFrom) out.spawnedFrom = s.spawnedFrom;
    return out;
  },
};

export { normalizeParamsPacket, sharedLightColor, clampNumber };
