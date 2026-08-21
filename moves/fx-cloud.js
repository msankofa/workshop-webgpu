/**
 * fx-cloud.js — the gas/powder moves. Icy Wind, Powder Snow, Smokescreen, Ominous Wind, Sleep Powder,
 * Stun Spore, Poison Powder, Sweet Scent, Heat Wave, Sand Attack, Poison Gas, Bubble.
 *
 * The subtractive fork in the set: a cloud move is the particle layer alone. `fx-stream.js` builds a
 * shaded tube and dresses it with puffs; this module drops the tube entirely and is nothing but
 * `createSpriteParticles` (move-parts.js part 5), fed by CPU emitters that differ only in *where* and
 * *how fast* they emit. No TSL is written here — the sprite kit already owns the one shader every
 * palette needs, so a new look is a data row, never a new code path.
 *
 * Every palette picks exactly one of three emission shapes, and the shape is what a palette *is* as
 * much as its colour:
 *
 *   spray — a widening cone carried from the caster's mouth to the target. Particles spawn at the
 *           travelling front with a lateral jitter that grows with `u` (narrow at the mouth, wide by
 *           the time the front lands) and a forward speed that falls off as `u` approaches 1, so the
 *           jet reads as slowing into a cloud rather than slamming into a wall. Frost, cinder and smoke.
 *   puff  — nothing travels; the whole show is a burst at the target on impact, radiating outward and
 *           settling under the palette's own gravity/drag. Dust.
 *   drift — a field that blooms over the target once the front lands and is topped up at a *constant*
 *           rate for as long as IMPACT lasts, so a held cast reaches a steady population (emission rate
 *           × life) instead of thickening forever. Spore.
 *
 * A cloud has no single dramatic impact frame the way a burst sphere would give one, so `onImpact` is
 * just the phase-machine hook: it fires the caller's callback and, for spray/drift, is the moment the
 * emission source stops advancing and starts feeding a fixed point instead — the same "hose stays open"
 * idea fx-stream uses for its column.
 *
 * Particle count is the whole cost of this module, so every palette below names a hard `cap` on its
 * pooled `createSpriteParticles` kit; emission rate and burst size scale with `power` but can never push
 * a kit past its cap (the sprite pool recycles its oldest instance instead of growing). Worst case, one
 * live cast: frost 360, smoke 260, cinder 260, dust 300, spore 620 sprites. Kits are pooled per palette
 * exactly like fx-stream's kits, so a repeated cast of the same move reuses geometry and material.
 */

import { createPhaseMachine, mulberry32, saturate, createRateEmitter } from './move-core.js';
import { createSpriteParticles, makeGroundDecal } from './move-parts.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const range = (rnd, r) => r[0] + rnd() * (r[1] - r[0]);

/** Named looks. Every field is overridable through `options.palettes.<name>` at factory level. */
export const PALETTES = {
  frost: {
    shape: 'spray', colorA: '#eaffff', colorB: '#5fb8e8', additive: true, aspect: [1, 1],
    cap: 360, rate: 130, size: [0.1, 0.2], life: [0.8, 1.3], gravity: -0.6, drag: 0.5,
    spread: 2.2, speed: [3.5, 6], light: null,
  },
  smoke: {
    shape: 'spray', colorA: '#4a4a4a', colorB: '#0d0d0d', additive: false, aspect: [1, 0.85],
    cap: 260, rate: 70, size: [0.55, 1.0], life: [1.8, 2.6], gravity: 0.25, drag: 1.3,
    spread: 2.8, speed: [1.8, 3.2], light: null,
  },
  cinder: {
    shape: 'spray', colorA: '#fff2c0', colorB: '#ff3300', additive: true, aspect: [1, 1.3],
    cap: 260, rate: 100, size: [0.14, 0.3], life: [0.45, 0.8], gravity: -2.6, drag: 0.55,
    spread: 1.8, speed: [4.5, 7.5], light: '#ff6a1e', lightIntensity: 14, lightDistance: 12,
  },
  spore: {
    shape: 'drift', colorA: '#fff3a0', colorB: '#c9a6ff', additive: true, aspect: [1, 1],
    cap: 620, rate: 170, size: [0.05, 0.11], life: [2.2, 3.4], gravity: -0.03, drag: 0.18,
    radius: 1.6, speed: [0.4, 1.1], light: null,
  },
  dust: {
    shape: 'puff', colorA: '#cdbb85', colorB: '#4d4126', additive: false, aspect: [1, 0.8],
    cap: 300, burstCount: 70, rate: 18, size: [0.3, 0.65], life: [1.0, 1.7], gravity: 0.35,
    drag: 1.5, spread: 2.4, speed: [2.5, 4.5], light: null,
    decal: true, decalColor: '#7a6a3d', decalOpacity: 0.5,
  },
};

const DEFAULTS = { travelSpeed: 14, impactTime: 1.0, fadeTime: 0.7, poolPerPalette: 3 };

export function createCloudFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, terrainHeight = () => 0, lights } = deps;
  const O = { ...DEFAULTS, ...options };

  const pools = new Map();
  const liveKits = new Set();

  /** Palette-scoped tunables: the palette table, then anything the caller overrode. */
  function paramsFor(name) {
    const base = PALETTES[name] || PALETTES.smoke;
    const over = options.palettes && options.palettes[name];
    return { ...base, ...(over || {}) };
  }

  function buildKit(key) {
    const P = paramsFor(key);
    const particles = createSpriteParticles({
      THREE, TSL, NODES, cap: P.cap, colorA: P.colorA, colorB: P.colorB, aspect: P.aspect,
      gravity: P.gravity, drag: P.drag, additive: P.additive,
    });
    const group = new THREE.Group();
    group.add(particles.mesh);
    let decal = null;
    if (P.decal) {
      decal = makeGroundDecal({ THREE, TSL, NODES, radius: 1, color: P.decalColor });
      decal.mesh.visible = false;
      group.add(decal.mesh);
    }
    return { key, P, group, particles, decal };
  }

  function acquireKit(key) {
    const pool = pools.get(key);
    const kit = pool && pool.length ? pool.pop() : buildKit(key);
    kit.particles.reset();
    kit.particles.setFade(1);
    if (kit.decal) { kit.decal.mesh.visible = false; kit.decal.setOpacity(0); }
    liveKits.add(kit);
    return kit;
  }

  function releaseKit(kit) {
    if (!liveKits.delete(kit)) return;
    if (kit.group.parent) kit.group.parent.remove(kit.group);
    let pool = pools.get(kit.key);
    if (!pool) pools.set(kit.key, (pool = []));
    if (pool.length < O.poolPerPalette) pool.push(kit); else destroyKit(kit);
  }

  function destroyKit(kit) {
    if (kit.group.parent) kit.group.parent.remove(kit.group);
    kit.particles.dispose();
    if (kit.decal) kit.decal.dispose();
  }

  function cast({ line, seed = 1, palette = 'smoke', power = 1, sourceY = 0.6, targetY = 0.6 }) {
    const key = PALETTES[palette] ? palette : 'smoke';
    const kit = acquireKit(key);
    const P = kit.P;
    const rnd = mulberry32(seed >>> 0);
    const pw = Math.max(0.2, power);

    const sx = line.origin.x, sy = line.origin.y + sourceY, sz = line.origin.z;
    const ex = line.target.x, ey = line.target.y + targetY, ez = line.target.z;
    let dx = ex - sx, dy = ey - sy, dz = ez - sz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;

    kit.group.position.set(0, 0, 0);
    scene.add(kit.group);
    if (kit.decal) {
      const gy = terrainHeight(ex, ez);
      kit.decal.mesh.position.set(ex, (Number.isFinite(gy) ? gy : ey) + 0.02, ez);
      kit.decal.mesh.scale.setScalar(1.3 * pw);
    }

    // acquire() can starve when six lights are already spoken for; every caller here checks for null.
    const light = P.light ? lights?.acquire() : null;
    if (light) { light.color.set(P.light); light.distance = P.lightDistance * pw; light.intensity = 0; }

    const emitter = createRateEmitter(64);
    let pendingImpact = false, doneFired = false, released = false;
    const _p = { x: 0, y: 0, z: 0 };

    /** The travelling front, sourceY/targetY and any per-cast sag already folded into the endpoints. */
    function frontAt(u) {
      _p.x = lerp(sx, ex, u); _p.y = lerp(sy, ey, u); _p.z = lerp(sz, ez, u);
      return _p;
    }

    /** spray: emit at the moving (or parked, once u=1) front, widening and slowing as u grows. */
    function spray(u, dt, rate) {
      const p = frontAt(u);
      const n = emitter.take(rate * pw, dt);
      const widen = 0.12 + 0.88 * u;
      const carry = 1 - 0.6 * u;
      for (let i = 0; i < n; i++) {
        const spread = P.spread * widen;
        const sxo = (rnd() - 0.5) * spread, syo = (rnd() - 0.5) * spread * 0.6, szo = (rnd() - 0.5) * spread;
        const sp = range(rnd, P.speed) * carry;
        const size = range(rnd, P.size) * pw;
        const life = range(rnd, P.life);
        kit.particles.emit(p.x, p.y, p.z, dx * sp + sxo, dy * sp + syo, dz * sp + szo, size, life);
      }
    }

    /** puff: a one-shot radial burst that blooms at (cx, cy, cz) and settles under the palette gravity. */
    function burst(cx, cy, cz, count) {
      for (let i = 0; i < count; i++) {
        const a = rnd() * TAU;
        const sp = range(rnd, P.speed) * (0.5 + rnd() * 0.7);
        const size = range(rnd, P.size) * pw;
        const life = range(rnd, P.life);
        const vy = 0.4 + rnd() * 0.6;
        kit.particles.emit(cx, cy, cz, Math.cos(a) * sp, vy, Math.sin(a) * sp, size, life);
      }
    }

    /** drift: a settling field over the target, spawned inside a ground disc at a constant rate. */
    function driftField(dt, rate, cx, cy, cz) {
      const n = emitter.take(rate * pw, dt);
      const radius = P.radius * (0.7 + 0.5 * pw);
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * radius;
        const va = rnd() * TAU, sp = range(rnd, P.speed);
        const size = range(rnd, P.size) * pw;
        const life = range(rnd, P.life);
        kit.particles.emit(
          cx + Math.cos(a) * r, cy + rnd() * 0.6, cz + Math.sin(a) * r,
          Math.cos(va) * sp, (rnd() - 0.5) * 0.3, Math.sin(va) * sp, size, life,
        );
      }
    }

    const machine = createPhaseMachine({
      travelSpeed: O.travelSpeed, impactTime: O.impactTime, fadeTime: O.fadeTime,
      onTravel(dt) {
        if (P.shape === 'spray') {
          spray(this.u, dt, P.rate);
          if (light) { const p = frontAt(this.u); light.position.set(p.x, p.y, p.z); }
        } else if (P.shape === 'puff') {
          spray(this.u, dt, P.rate); // a thin carried trickle so the throw reads before it lands
        }
        // drift emits nothing in TRAVEL: the field only exists once the front has landed.
      },
      onImpact() {
        pendingImpact = true;
        if (P.shape === 'puff') burst(ex, ey, ez, Math.round(P.burstCount * pw));
        if (light) light.position.set(ex, ey, ez);
        if (kit.decal) kit.decal.mesh.visible = true;
      },
      onFade(dt, t) {
        if (t <= 1) {
          // IMPACT: the source keeps feeding — spray stays parked at the target, drift tops itself up.
          if (P.shape === 'spray') spray(1, dt, P.rate * 0.6);
          else if (P.shape === 'drift') driftField(dt, P.rate, ex, ey, ez);
          if (kit.decal) kit.decal.setOpacity(P.decalOpacity * saturate(t * 4));
          if (light) light.intensity = P.lightIntensity * pw * saturate(t * 3);
        } else {
          const k = saturate(t - 1);
          kit.particles.setFade(1 - k * k);
          if (kit.decal) kit.decal.setOpacity(P.decalOpacity * (1 - k));
          if (light) light.intensity = P.lightIntensity * pw * (1 - k);
        }
      },
    });
    machine.spawn(line);

    return {
      group: kit.group, machine, onImpact: null, onDone: null,
      update(dt, now) {
        const alive = machine.update(dt, now);
        kit.particles.step(dt);
        if (pendingImpact) { pendingImpact = false; this.onImpact?.(); }
        if (!alive && !doneFired) { doneFired = true; this.onDone?.(); }
        return alive;
      },
      dispose() {
        if (released) return;
        released = true;
        machine.destroy();
        if (light && lights) lights.release(light);
        releaseKit(kit);
      },
    };
  }

  function dispose() {
    for (const kit of liveKits) destroyKit(kit);
    liveKits.clear();
    for (const pool of pools.values()) for (const kit of pool) destroyKit(kit);
    pools.clear();
  }

  return { cast, dispose };
}
