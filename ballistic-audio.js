// ballistic-audio.js -- incoming-round audio: closest-approach geometry, whizz/ricochet gating,
// and the two procedural voices behind `bullet_whizz` / `bullet_ricochet`.
// Pure math + WebAudio: no THREE, no DOM beyond the AudioContext a builder is handed.
//
// Builder contract is weapon-sfx-synth.js's: `build(ctx, destination, t0) => durationSeconds`,
// connects only to `destination`, schedules via AudioParam automation from t0, never setTimeout.
// The whizz needs per-shot distance/delay, so createWhizzVoice() closes over them and hands back
// a conforming 3-arg builder (playSynthAt only ever passes three).

import { jitter, envGain, noiseSource, filterNode } from './synth-utils.js';
import { SOUND_PARAMS, SOUND_PARAM_SCHEMA } from './sound-params.js';

// The exported constants below are the SCHEMA DEFAULTS, derived rather than restated so they can
// never drift from sound-params.js. The functions read SOUND_PARAMS live, so an override applied
// at boot (or by sound-studio.html mid-session) changes behaviour without changing these.
const BAL = () => SOUND_PARAMS.ballistic;
const defaultOf = key => SOUND_PARAM_SCHEMA.ballistic.params[key].default;

// ---- vector plumbing -------------------------------------------------------------------
// Call sites hand us both shapes: combat.js works in [x,y,z], the viewers in THREE Vector3.
function vx(v) { return Array.isArray(v) ? Number(v[0]) : Number(v?.x); }
function vy(v) { return Array.isArray(v) ? Number(v[1]) : Number(v?.y); }
function vz(v) { return Array.isArray(v) ? Number(v[2]) : Number(v?.z); }
function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
function clamp01(n) { return clamp(n, 0, 1); }

// ---- geometry --------------------------------------------------------------------------
// Superset of bot-alert.js's shotMissDistance: same clamped dot-product projection onto the
// shot segment, but it also returns the parameter `t` (whizz delay) and the closest point on
// the segment (panner position). test-ballistic-audio.mjs cross-checks the two so the shared
// math can never drift apart.
export function closestApproach(origin, dir, travelled, listenerPos) {
  const ox = vx(listenerPos) - vx(origin);
  const oy = vy(listenerPos) - vy(origin);
  const oz = vz(listenerPos) - vz(origin);
  const dx = vx(dir), dy = vy(dir), dz = vz(dir);
  const raw = Number(travelled);
  const len = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const t = clamp(ox * dx + oy * dy + oz * dz, 0, len);
  return {
    t,
    point: { x: vx(origin) + dx * t, y: vy(origin) + dy * t, z: vz(origin) + dz * t },
    distance: Math.hypot(ox - dx * t, oy - dy * t, oz - dz * t),
  };
}

// ---- whizz gating ----------------------------------------------------------------------
export const WHIZZ_MAX_DIST = defaultOf('whizzMaxDist');        // m; past this a round is just a distant report
export const WHIZZ_MAX_DELAY_S = defaultOf('whizzMaxDelayS');   // so a long-range shot can't park a voice for a second
// weapons.js tracerFx() default. Per-weapon values are the VISUAL tracer speed (m1911 350,
// cz_805_bren 820, m24 850) used here as a muzzle-velocity proxy -- it is the only per-weapon
// speed the codebase has. Real ballistics (drag, transonic delay) are not modelled.
export const DEFAULT_BULLET_SPEED = defaultOf('bulletSpeed');

export function bulletSpeedFor(weapon) {
  const s = Number(weapon?.tracerFx?.speed);
  return Number.isFinite(s) && s > 0 ? s : BAL().bulletSpeed;
}

// null when no whizz should play. `travelled` is how far the round actually got (hit.distance,
// or the weapon range on a clean miss) so a round that stopped in a wall never whizzes past you.
export function evaluateWhizz({
  origin, dir, travelled, listenerPos,
  shooterId = null, listenerId = null, weapon = null, maxDist = null,
} = {}) {
  if (!origin || !dir || !listenerPos) return null;
  if (shooterId != null && listenerId != null && shooterId === listenerId) return null;
  const limit = Number.isFinite(maxDist) ? maxDist : BAL().whizzMaxDist;
  const ca = closestApproach(origin, dir, travelled, listenerPos);
  if (!Number.isFinite(ca.distance) || ca.distance > limit) return null;
  const delaySeconds = clamp(ca.t / bulletSpeedFor(weapon), 0, BAL().whizzMaxDelayS);
  return { point: ca.point, distance: ca.distance, delaySeconds, t: ca.t, maxDist: limit };
}

// ---- ricochet gating -------------------------------------------------------------------
// A flesh "normal" is the capsule's outward XZ vector, not a real surface, so a grazing angle
// against it means nothing -- bodies never ricochet.
export const FLESH_KINDS = new Set(['player', 'creature', 'mob']);
// Hardness is only inferable from hit.kind plus the obstacle id prefix that
// obstacleColumnsAlongRay stamps ('t:' tall trunks, 'r:' short dressing). There is no material
// tag anywhere in the codebase. Caveat: the 'r:' dressing index also holds stumps and logs, so
// some wood is scored as rock; nothing in the data distinguishes them.
// Live view of SOUND_PARAMS.ballistic in the class-keyed shape surfaceClass() returns.
export const RICOCHET_BASE = {
  get world() { return BAL().ricochetWorld; },       // map BVH: concrete/metal shoot-house geometry
  get rock() { return BAL().ricochetRock; },
  get obstacle() { return BAL().ricochetObstacle; }, // unprefixed column, hardness unknown
  get wood() { return BAL().ricochetWood; },
  get terrain() { return BAL().ricochetTerrain; },   // dirt absorbs
};
export const RICOCHET_GRAZE_EXP = defaultOf('ricochetGrazeExp'); // a near-perpendicular hit essentially never ricochets

export function surfaceClass(hit) {
  const kind = hit?.kind;
  if (!kind || kind === 'none') return null;
  if (FLESH_KINDS.has(kind)) return 'flesh';
  if (kind === 'terrain') return 'terrain';
  if (kind === 'world') return 'world';
  if (kind === 'obstacle') {
    const id = typeof hit.id === 'string' ? hit.id : '';
    if (id.startsWith('t:')) return 'wood';
    if (id.startsWith('r:')) return 'rock';
    return 'obstacle';
  }
  return 'obstacle';
}

// 0 = head-on, 1 = perfectly tangential. No normal means no evidence of a graze, so 0.
export function grazingFactor(dir, normal) {
  if (!dir || !normal) return 0;
  const nx = vx(normal), ny = vy(normal), nz = vz(normal);
  const nl = Math.hypot(nx, ny, nz);
  if (!(nl > 0)) return 0;
  const dx = vx(dir), dy = vy(dir), dz = vz(dir);
  const dl = Math.hypot(dx, dy, dz);
  if (!(dl > 0)) return 0;
  const c = Math.abs((dx * nx + dy * ny + dz * nz) / (nl * dl));
  return clamp01(1 - c);
}

export function ricochetChance(hit, dir) {
  const cls = surfaceClass(hit);
  if (!cls || cls === 'flesh') return 0;
  const base = RICOCHET_BASE[cls] ?? RICOCHET_BASE.obstacle;
  return base * Math.pow(grazingFactor(dir, hit.normal), BAL().ricochetGrazeExp);
}

// `rng` is injectable so tests are deterministic rather than flaky.
export function evaluateRicochet({ hit, dir, rng = Math.random } = {}) {
  const p = ricochetChance(hit, dir);
  if (!(p > 0)) return false;
  return rng() < p;
}

// Which single impact voice this hit should play. A ricochet REPLACES the impact rather than
// stacking a second voice on it.
export function pickImpactVoice(hit, dir, rng = Math.random) {
  const cls = surfaceClass(hit);
  if (!cls) return null;
  if (cls === 'flesh') return 'enemy_hit';
  return evaluateRicochet({ hit, dir, rng }) ? 'bullet_ricochet' : 'bullet_impact';
}

// ---- projectiles -----------------------------------------------------------------------
// Rockets/grenades are real stepped bodies on curved, bouncing paths, so the straight-ray
// closest-approach math above is simply wrong for them. Instead each live projectile is
// sampled per tick and fires once, on the tick it starts receding inside `radius`.
export const PROJECTILE_WHIZZ_RADIUS = defaultOf('projectileWhizzRadius');

export function createProjectileWhizzTracker({ radius = null } = {}) {
  const states = new Map();
  // Unpinned trackers follow SOUND_PARAMS live -- the viewers build one at boot and never rebuild it.
  const radiusOf = () => (Number.isFinite(radius) ? radius : BAL().projectileWhizzRadius);
  return {
    step(key, position, listenerPos) {
      const r = radiusOf();
      let st = states.get(key);
      if (!st) { st = { fired: false, prev: Infinity }; states.set(key, st); }
      if (st.fired) return null;
      const d = Math.hypot(vx(position) - vx(listenerPos), vy(position) - vy(listenerPos), vz(position) - vz(listenerPos));
      if (!Number.isFinite(d)) return null;
      if (d > r) { st.prev = d; return null; }
      if (d <= st.prev) { st.prev = d; return null; }
      st.fired = true;
      const distance = Math.min(d, st.prev);
      st.prev = d;
      return { distance, point: { x: vx(position), y: vy(position), z: vz(position) }, maxDist: r };
    },
    // Drop state for projectiles that no longer exist, so the map cannot grow unbounded.
    retain(liveKeys) { for (const k of states.keys()) if (!liveKeys.has(k)) states.delete(k); },
    forget(key) { states.delete(key); },
    size() { return states.size; },
    clear() { states.clear(); },
  };
}

// ---- voices ----------------------------------------------------------------------------
// Close pass = brighter, sharper attack, shorter; far pass = duller and softer. Both the peak
// gain and the bandpass centre scale off the perpendicular miss distance.
function whizzBody(ctx, destination, t0, distance, delaySeconds, maxDist) {
  const span = maxDist > 0 ? maxDist : BAL().whizzMaxDist;
  const near = clamp01(1 - (Number.isFinite(distance) ? distance : span) / span);
  const delay = clamp(Number.isFinite(delaySeconds) ? delaySeconds : 0, 0, BAL().whizzMaxDelayS);
  const start = t0 + delay;
  const a = jitter(); const b = jitter(); const c = jitter();

  const bodyDur = 0.19 - 0.07 * near + a * 0.02;
  const attack = 0.016 - 0.012 * near;
  const gain = envGain(ctx, destination, 0.1 + 0.62 * near * near, start, attack, bodyDur);
  const centre = 900 + 3200 * near + b * 300;
  const bp = filterNode(ctx, 'bandpass', centre, start, 1.4 + 3.2 * near);
  // Downsweep as the round passes and recedes -- the Doppler tell that says "past you".
  bp.frequency.exponentialRampToValueAtTime(Math.max(180, centre * (0.32 + 0.14 * (1 - near))), start + bodyDur);
  bp.connect(gain);
  noiseSource(ctx, start, bodyDur, a * 1.4).connect(bp);

  // Only a genuinely close pass earns the extra supersonic snap in front of the whizz.
  if (near > 0.55) {
    const crackDur = 0.03 + c * 0.01;
    const crackGain = envGain(ctx, destination, 0.12 + 0.4 * (near - 0.55) / 0.45, start, 0.0015, crackDur);
    const hp = filterNode(ctx, 'highpass', 2600 + c * 900, start, 0.8);
    hp.connect(crackGain);
    noiseSource(ctx, start, crackDur, c * 1.4).connect(hp);
  }

  return delay + bodyDur;
}

// Factory: closes over this shot's geometry and returns the 3-arg builder playSynthAt wants.
export function createWhizzVoice({ distance = null, delaySeconds = 0, maxDist = null } = {}) {
  return (ctx, destination, t0) => {
    const span = Number.isFinite(maxDist) ? maxDist : BAL().whizzMaxDist;
    const d = Number.isFinite(distance) ? distance : span * 0.45;
    return whizzBody(ctx, destination, t0, d, delaySeconds, span);
  };
}

// Registry default: a mid-distance, undelayed pass.
export function buildBulletWhizz(ctx, destination, t0) {
  const span = BAL().whizzMaxDist;
  return whizzBody(ctx, destination, t0, span * 0.45, 0, span);
}

// Strike tick, then the falling metal whine, over a thin band-passed air tail.
export function buildRicochet(ctx, destination, t0) {
  const DUR = 0.42;
  const a = jitter(); const b = jitter(); const c = jitter(); const d = jitter();

  const tickDur = 0.045 + a * 0.01;
  const tickGain = envGain(ctx, destination, 0.7, t0, 0.002, tickDur);
  const tickLp = filterNode(ctx, 'lowpass', 3200 + a * 1200, t0, 4.0 + b * 2.0);
  tickLp.frequency.exponentialRampToValueAtTime(700 + b * 300, t0 + tickDur);
  tickLp.connect(tickGain);
  noiseSource(ctx, t0, tickDur, a * 1.4).connect(tickLp);

  const whineStart = t0 + 0.006 + b * 0.004;
  const whineDur = 0.3 + c * 0.08;
  const whineGain = envGain(ctx, destination, 0.4, whineStart, 0.012, whineDur);
  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator();
    osc.type = i ? 'triangle' : 'sawtooth';
    const f0 = 1650 + (i ? 260 : 0) + c * 700;
    osc.frequency.setValueAtTime(f0, whineStart);
    osc.frequency.exponentialRampToValueAtTime(Math.max(180, f0 * (0.22 + d * 0.1)), whineStart + whineDur);
    osc.connect(whineGain);
    osc.start(whineStart);
    osc.stop(whineStart + whineDur);
  }

  const tailStart = t0 + 0.02;
  const tailDur = 0.3 + d * 0.06;
  const tailGain = envGain(ctx, destination, 0.16, tailStart, 0.03, tailDur);
  const tailBp = filterNode(ctx, 'bandpass', 2400 + d * 800, tailStart, 2.0);
  tailBp.frequency.exponentialRampToValueAtTime(600 + c * 250, tailStart + tailDur);
  tailBp.connect(tailGain);
  noiseSource(ctx, tailStart, tailDur, d * 1.4).connect(tailBp);

  return DUR;
}

const VOICES = {
  bullet_whizz: buildBulletWhizz,
  bullet_ricochet: buildRicochet,
};

export const SYNTH_EVENT_IDS = Object.keys(VOICES);

// Returns a builder for the id, or null when this module has no voice for it.
export function synthVoice(eventId) {
  if (!eventId || !Object.prototype.hasOwnProperty.call(VOICES, eventId)) return null;
  return VOICES[eventId];
}
