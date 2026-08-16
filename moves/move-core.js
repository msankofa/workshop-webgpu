/**
 * move-core.js — the part of a Pokémon move that is not a picture.
 *
 * A move is a cast along a ground line from an attacker to a target. Every effect module consumes the
 * same line and hangs its visuals off the same phase machine, so the harness never learns what a move
 * looks like — only that it travels, lands, and fades.
 *
 *   IDLE → TRAVEL → IMPACT → FADE → DONE
 *
 * `front` advances along the line at `travelSpeed` m/s (eased off standstill); `u = front / length`.
 * Crossing u = 1 fires `onImpact` once. IMPACT lasts `impactTime` s, FADE `fadeTime` s; both call
 * `onFade(dt, t)` with t running 0..1 across IMPACT and 1..2 across FADE, so a hold reads as t < 1.
 *
 * Pure JS: no THREE, no DOM. `test-move-core.mjs` covers it in Node.
 */

export const Phase = Object.freeze({ IDLE: 'idle', TRAVEL: 'travel', IMPACT: 'impact', FADE: 'fade', DONE: 'done' });

export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;

export const Easing = Object.freeze({
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outBack: (t) => { const c = 1.70158; const s = c + 1; return 1 + s * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  outElastic: (t) => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1,
});

/** Deterministic per-cast RNG (mulberry32). Same seed, same crystals. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string to a seed, so a move name + cast index reproduces. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * The ground line a move is cast along. `from`/`to` are {x, z} (y comes from the terrain), and the
 * samples are evenly stepped along the line with the terrain height baked in, so every effect that lays
 * geometry on the ground reads one list instead of re-sampling.
 *
 * Returns { origin, target, dir, side, length, samples, pointAt(u, out) }; `dir` and `side` are flat
 * unit vectors, `side = dir × up`. `pointAt` interpolates the samples, so it follows the terrain.
 */
export function makeLine({ from, to, terrainHeight = () => 0, step = 0.1, minLength = 0.05 }) {
  let dx = to.x - from.x, dz = to.z - from.z;
  let length = Math.hypot(dx, dz);
  if (length < minLength) { dx = 0; dz = minLength; length = minLength; }
  const dir = { x: dx / length, y: 0, z: dz / length };
  const side = { x: dir.z, y: 0, z: -dir.x };
  const count = Math.max(2, Math.ceil(length / step) + 1);
  const samples = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const x = from.x + dx * t, z = from.z + dz * t;
    samples[i] = { x, y: terrainHeight(x, z), z, t };
  }
  const origin = { ...samples[0] };
  const target = { ...samples[count - 1] };
  function pointAt(u, out = { x: 0, y: 0, z: 0 }) {
    const f = saturate(u) * (count - 1);
    const i = Math.min(count - 2, Math.floor(f));
    const k = f - i;
    const a = samples[i], b = samples[i + 1];
    out.x = a.x + (b.x - a.x) * k; out.y = a.y + (b.y - a.y) * k; out.z = a.z + (b.z - a.z) * k;
    return out;
  }
  return { origin, target, dir, side, length, samples, pointAt };
}

/**
 * The phase machine. Hooks are optional and are called with the machine as `this`.
 *
 *   spawn(line)       — resets state, enters TRAVEL, calls onSpawn(line). Instances can pool.
 *   update(dt, time)  — advances; returns false once DONE.
 *
 * `travelSpeed` is m/s; `travelTime` (seconds) wins over it when set.
 */
export function createPhaseMachine({
  travelSpeed = 12, travelTime = 0, impactTime = 0.6, fadeTime = 0.8, easeIn = 0.08,
  onSpawn, onTravel, onImpact, onFade, onDestroy,
} = {}) {
  const m = {
    phase: Phase.IDLE, line: null, front: 0, u: 0, age: 0, phaseAge: 0, impacted: false,
    travelSpeed, travelTime, impactTime, fadeTime,
    get alive() { return m.phase !== Phase.IDLE && m.phase !== Phase.DONE; },
    spawn(line) {
      m.line = line; m.front = 0; m.u = 0; m.age = 0; m.phaseAge = 0; m.impacted = false;
      m.phase = Phase.TRAVEL;
      onSpawn?.call(m, line);
      return m;
    },
    update(dt, time = 0) {
      if (!m.alive) return false;
      m.age += dt; m.phaseAge += dt;
      if (m.phase === Phase.TRAVEL) {
        const speed = m.travelTime > 0 ? m.line.length / m.travelTime : m.travelSpeed;
        const ease = easeIn > 0 ? saturate(m.age / easeIn) : 1;
        m.front += speed * ease * dt;
        m.u = saturate(m.front / m.line.length);
        onTravel?.call(m, dt, time);
        if (m.front >= m.line.length) {
          m.front = m.line.length; m.u = 1; m.impacted = true;
          m.phase = Phase.IMPACT; m.phaseAge = 0;
          onImpact?.call(m, time);
        }
        return true;
      }
      if (m.phase === Phase.IMPACT) {
        const t = m.impactTime > 0 ? saturate(m.phaseAge / m.impactTime) : 1;
        onFade?.call(m, dt, t, time);
        if (m.phaseAge >= m.impactTime) { m.phase = Phase.FADE; m.phaseAge = 0; }
        return true;
      }
      if (m.phase === Phase.FADE) {
        const t = m.fadeTime > 0 ? saturate(m.phaseAge / m.fadeTime) : 1;
        onFade?.call(m, dt, 1 + t, time);
        if (m.phaseAge >= m.fadeTime) { m.phase = Phase.DONE; onDestroy?.call(m); return false; }
        return true;
      }
      return false;
    },
    destroy() { if (m.phase !== Phase.DONE) { m.phase = Phase.DONE; onDestroy?.call(m); } },
  };
  return m;
}

/**
 * Fractional-rate emitter: `take(rate, dt)` returns how many whole things to emit this frame, carrying
 * the remainder so 3.5/s at 60 fps does not round to zero forever. Capped so a hitch cannot dump a flood.
 */
export function createRateEmitter(cap = 240) {
  let acc = 0;
  return {
    take(rate, dt) { acc += rate * dt; const n = Math.min(cap, Math.floor(acc)); acc -= n; return n; },
    reset() { acc = 0; },
  };
}
