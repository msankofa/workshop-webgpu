// blast-debris-sim.js — the persistent debris layer of an explosion, as a pure simulation.
// A port of html-game-v2's shrapnel / rubble / spark / smoke pools (src/game/main.js:215-395 for the
// pools, :16784 updateShrapnel, :16864 updateRubble, :17438 spawnBlastShrapnel, :17331
// spawnEnemyRubble, :11614 spawnDropShipImpactDebris). Numbers are theirs unless a comment says why
// not; docs/research/html-game-v2-explosion-effects.md is the annotated source.
//
// Why a separate module from effect-renderer.js: that renderer is stateless by design (every
// sub-particle re-derived per frame from id + age so guests match the host). Debris that lands,
// bounces, skids and smoulders for twenty seconds is state, so it lives here. No THREE, no DOM; the
// ground query and the random source are injected, so `test-blast-debris-sim.mjs` runs it headless.
// `blast-debris.js` is the WebGPU renderer that draws these arrays.
//
// Colours are sRGB floats in [0,1] (what THREE.Color.setHex would have taken); the renderer converts.

export const DEBRIS_DEFAULTS = Object.freeze({
  shrapnelCountScale: 1, shrapnelSpeedScale: 1, shrapnelGravityScale: 1, shrapnelLifeScale: 1,
  shrapnelSmokeScale: 1, shrapnelGlowChance: 1, shrapnelGlowScale: 1,
  rubbleCountScale: 1, rubbleSpeedScale: 1, rubbleGravityScale: 1, rubbleLifeScale: 1,
  rubbleSmokeScale: 1, rubbleSmolderChance: 0.28, rubbleGlowScale: 1, rubbleLightScale: 1,
});

// html-game-v2's pool sizes. A full pool recycles its oldest member.
export const DEBRIS_CAPS = Object.freeze({ shrapnel: 900, rubble: 260, sparks: 80, smoke: 2600 });

// Tier scaling as html-game-v2 applies it: medium halves the shrapnel and keeps a third of the
// rubble, lite spawns no debris at all (explodePlayerProjectile / createEnemyDeathExplosion).
export const TIER_DEBRIS_SCALE = Object.freeze({
  full: { shrapnel: 1, rubble: 1 },
  medium: { shrapnel: 0.5, rubble: 0.38 },
  lite: { shrapnel: 0, rubble: 0 },
});

const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const SHRAPNEL_HOT = hex(0xff2200);
const SHRAPNEL_FLICKER = [hex(0xff2626), hex(0xff5a2a), hex(0x8f0505)];
const SHRAPNEL_GLOW = [hex(0xff6a22), hex(0xff2d12)];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const spinBelow = (o) => Math.abs(o.sx) + Math.abs(o.sy) + Math.abs(o.sz) < REST_SPIN;
// Thresholds for calling a grounded piece settled, at which point it stops being simulated. Speed is
// 1 cm/s. Spin has to be in the test too: freezing a fragment that is still turning at 7 rad/s is a
// visible pop, and unlike the rubble, html-game-v2 never damped shrapnel spin at all.
const REST_SPEED2 = 1e-4;
const REST_SPIN = 0.05;   // rad/s, summed over the three axes

export function createDebrisSim({ groundAt = () => 0, random = Math.random, caps = {}, settings = {} } = {}) {
  const cap = { ...DEBRIS_CAPS, ...caps };
  const s = { ...DEBRIS_DEFAULTS, ...settings };
  const shrapnel = [], rubble = [], sparks = [], smoke = [];
  const stats = { shrapnelSpawned: 0, rubbleSpawned: 0, sparksSpawned: 0, smokeSpawned: 0, recycled: 0 };
  let time = 0;
  const rnd = () => random();

  function push(list, limit, item) {
    if (list.length >= limit) { list.shift(); stats.recycled++; }
    list.push(item);
    return item;
  }

  // ---- smoke (spawnInstSmoke) ----
  function spawnSmoke(x, y, z, vx, vy, vz, baseScale, expandRate, baseOpacity, r, g, b, life) {
    stats.smokeSpawned++;
    return push(smoke, cap.smoke, { x, y, z, vx, vy, vz, life, maxLife: life, baseScale, expandRate, baseOpacity, r, g, b });
  }
  // spawnShrapnelSmokeTrail
  function shrapnelTrail(x, y, z, vx, vy, vz, scale) {
    scale *= s.shrapnelSmokeScale;
    if (scale <= 0.001) return;
    const l = Math.hypot(vx, vy, vz) || 1;
    const dx = vx / l, dy = vy / l, dz = vz / l;
    const size = (0.14 + rnd() * 0.18) * scale;
    const lighter = rnd() > 0.42;
    const back = -0.28 - rnd() * 0.55;
    spawnSmoke(
      x + (rnd() - 0.5) * 0.12, y + (rnd() - 0.5) * 0.12, z + (rnd() - 0.5) * 0.12,
      dx * back + (rnd() - 0.5) * 0.45, dy * back + 0.12 + rnd() * 0.34, dz * back + (rnd() - 0.5) * 0.45,
      size, 1.6 + rnd() * 1.9, 0.4,
      lighter ? 0.310 : 0.188, lighter ? 0.294 : 0.169, lighter ? 0.271 : 0.161,
      1.15 + rnd() * 0.85);
  }
  // spawnRubbleSmokeTrail
  function rubbleTrail(x, y, z, vx, vy, vz, scale, rise = false) {
    scale *= s.rubbleSmokeScale;
    if (scale <= 0.001) return;
    const l = Math.hypot(vx, vy, vz) || 1;
    const dx = vx / l, dy = vy / l, dz = vz / l;
    const size = (0.22 + rnd() * 0.28) * scale;
    const back = -0.18 - rnd() * 0.34;
    const shade = 0.13 + rnd() * 0.11, warmth = rnd() * 0.035;
    spawnSmoke(
      x + (rnd() - 0.5) * 0.22, y + (rise ? 0.18 + rnd() * 0.32 : (rnd() - 0.5) * 0.16), z + (rnd() - 0.5) * 0.22,
      dx * back * (rise ? 0.28 : 1) + (rnd() - 0.5) * (rise ? 0.22 : 0.34),
      rise ? 0.95 + rnd() * 1.25 : dy * back + 0.18 + rnd() * 0.52,
      dz * back * (rise ? 0.28 : 1) + (rnd() - 0.5) * (rise ? 0.22 : 0.34),
      size, (rise ? 2.8 : 2.1) + rnd() * 2.4, rise ? 0.42 : 0.48,
      shade + warmth, shade * 0.95 + warmth * 0.45, shade * 0.88,
      (rise ? 2.05 : 1.55) + rnd() * 1.15);
  }
  // spawnDropShipDebrisSmokeTrail — the big dust the ground slabs drag behind them.
  function slabTrail(x, y, z, vx, vy, vz, scale) {
    scale *= s.rubbleSmokeScale;
    if (scale <= 0.001) return;
    const l = Math.hypot(vx, vy, vz) || 1;
    const dx = vx / l, dy = vy / l, dz = vz / l;
    const puffs = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < puffs; i++) {
      const back = -0.32 - rnd() * 0.58, drift = 1.05 + rnd() * 1.75;
      spawnSmoke(
        x + (rnd() - 0.5) * scale * 0.22, y + (rnd() - 0.5) * scale * 0.2, z + (rnd() - 0.5) * scale * 0.22,
        dx * back + (rnd() - 0.5) * drift, Math.max(0, dy) * 0.45 + 8.5 + rnd() * 7.5, dz * back + (rnd() - 0.5) * drift,
        (0.82 + rnd() * 0.88) * scale, 5.5 + rnd() * 4.5, 0.72,
        0.18 + rnd() * 0.11, 0.145 + rnd() * 0.08, 0.105 + rnd() * 0.055,
        8.5 + rnd() * 3.5);
    }
  }

  // ---- sparks (spawnRubbleEmberSpark) ----
  function emberSpark(r) {
    stats.sparksSpawned++;
    const ang = rnd() * Math.PI * 2, lateral = 0.28 + rnd() * 0.62, life = 0.16 + rnd() * 0.22;
    push(sparks, cap.sparks, {
      x: r.x + (rnd() - 0.5) * r.radius * 0.7, y: r.y + r.radius * (0.25 + rnd() * 0.65), z: r.z + (rnd() - 0.5) * r.radius * 0.7,
      vx: Math.cos(ang) * lateral, vy: 1.5 + rnd() * 4.2, vz: Math.sin(ang) * lateral,
      rx: rnd() * Math.PI * 2, ry: rnd() * Math.PI * 2, rz: rnd() * Math.PI * 2,
      radiusScale: 0.018 + rnd() * 0.012, heightScale: 0.1 + rnd() * 0.18,
      life, maxLife: life, r: 1, g: 0.28 + rnd() * 0.22, b: 0.035 + rnd() * 0.04,
    });
  }

  // ---- shrapnel (spawnBlastShrapnel) ----
  // `color` is the blast colour; `direction`+`directionBias` cone the scatter (airbursts).
  // `velocity` is NOT html-game-v2's: it is [vx,vy,vz] added to every launch vector, so debris off a
  // moving thing carries its momentum. Their game only blew up things standing still. Omit it and
  // every piece spawns with their numbers exactly. The caller scales it, and has to: nothing in here
  // is drag, so whatever speed a piece launches with is what it still has when it lands.
  function spawnBlastShrapnel(cx, cy, cz, blastRadius, color = SHRAPNEL_HOT, o = {}) {
    const size = blastRadius / 4;
    const countScale = o.countScale ?? 1, speedScale = o.speedScale ?? 1, gravityScale = o.gravityScale ?? 1;
    const iv = o.velocity, ivx = iv ? iv[0] : 0, ivy = iv ? iv[1] : 0, ivz = iv ? iv[2] : 0;
    const verticalBoost = o.verticalBoost ?? 0;
    const bias = clamp(o.directionBias ?? 0, 0, 1);
    const cone = bias > 0 && o.direction ? o.direction : null;
    const baseCount = clamp(Math.round(16 + size * 10), 14, 56);
    const count = Math.max(0, Math.round(baseCount * s.shrapnelCountScale * countScale));
    const baseSize = (0.055 + size * 0.02) * clamp(size / 3.2, 0.85, 1.6);
    const glowChance = s.shrapnelGlowScale > 0 ? s.shrapnelGlowChance : 0;
    for (let i = 0; i < count; i++) {
      const piece = baseSize * (0.7 + rnd() * 0.8);
      const speed = (16 + size * 3) * (0.55 + rnd() * 0.9) * s.shrapnelSpeedScale * speedScale;
      let dx = (rnd() - 0.5) * 2, dy = rnd() * 1.6 - 0.2 + verticalBoost, dz = (rnd() - 0.5) * 2;
      let l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      if (cone) {
        dx = dx * (1 - bias) + cone[0] * bias; dy = dy * (1 - bias) + cone[1] * bias; dz = dz * (1 - bias) + cone[2] * bias;
        l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      }
      const base = rnd() > 0.45 ? color : SHRAPNEL_HOT;
      const glow = SHRAPNEL_GLOW[rnd() > 0.5 ? 0 : 1];
      stats.shrapnelSpawned++;
      push(shrapnel, cap.shrapnel, {
        x: cx, y: cy, z: cz, vx: dx * speed + ivx, vy: dy * speed + ivy, vz: dz * speed + ivz,
        rx: rnd() * Math.PI, ry: rnd() * Math.PI, rz: rnd() * Math.PI,
        sx: (rnd() - 0.5) * 16, sy: (rnd() - 0.5) * 16, sz: (rnd() - 0.5) * 16,
        life: (20 + rnd() * 8) * s.shrapnelLifeScale, scale: piece, radius: piece,
        gravity: 36 * s.shrapnelGravityScale * gravityScale,
        bounces: 0, maxBounces: 8, damping: 0.38, friction: 0.72,
        trailTimer: 0, trailInterval: 0.25 + rnd() * 0.18, flickerTimer: 0,
        smokeScale: 0.6 + size * 0.07,
        r: base[0], g: base[1], b: base[2],
        glowing: rnd() < glowChance, glowScale: piece * (0.8 + rnd() * 0.4) * s.shrapnelGlowScale,
        glowPhase: rnd() * Math.PI * 2, gr: glow[0], gg: glow[1], gb: glow[2], glowNow: 0, fade: 1,
        resting: false,
      });
    }
    return count;
  }

  // ---- rubble (spawnEnemyRubble) ----
  // `size` plays html-game-v2's enemy effect size (a few metres); `dir` = [dx, dz] is the direction
  // the killing blow travelled, which the debris follows. `baseY` is where the pieces may start.
  function spawnRubble(cx, cy, cz, size, dir = null, o = {}) {
    const countScale = o.countScale ?? 1;
    const iv = o.velocity, ivx = iv ? iv[0] : 0, ivy = iv ? iv[1] : 0, ivz = iv ? iv[2] : 0;
    const baseCount = clamp(Math.round(7 + size * 6), 8, 34);
    const count = Math.max(0, Math.round(baseCount * s.rubbleCountScale * countScale));
    const baseSize = (0.18 + size * 0.055) * clamp(size / 2.6, 0.9, 1.85);
    const floorY = groundAt(cx, cz) + Math.max(0.35, size * 0.22);
    let ix = dir?.[0] ?? 0, iz = dir?.[1] ?? -1;
    let l = Math.hypot(ix, iz); if (l < 1e-4) { ix = 0; iz = -1; l = 1; } ix /= l; iz /= l;
    const sxd = -iz, szd = ix;
    for (let i = 0; i < count; i++) {
      const piece = baseSize * (0.72 + rnd() * 0.95);
      const flatten = 0.72 + rnd() * 0.52, stretch = 0.86 + rnd() * 0.64;
      const speed = (13 + size * 3.1) * (0.72 + rnd() * 1.05) * s.rubbleSpeedScale;
      const side = (rnd() - 0.5) * 0.86, back = 1.15 + rnd() * 1.35;
      let dx = ix * back + sxd * side + (rnd() - 0.5) * 0.32;
      let dy = 0.28 + rnd() * 0.58;
      let dz = iz * back + szd * side + (rnd() - 0.5) * 0.32;
      l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      const smoldering = rnd() < s.rubbleSmolderChance;
      let r, g, b;
      if (smoldering) { r = 0.32 + rnd() * 0.3; g = 0.09 + rnd() * 0.08; b = 0.018 + rnd() * 0.035; }
      else { const shade = 0.08 + rnd() * 0.08; r = shade; g = shade; b = shade * 0.95; }
      const sb = (rnd() - 0.25) * size * 0.22, ss = (rnd() - 0.5) * size * 0.46;
      const x = cx + ix * sb + sxd * ss, z = cz + iz * sb + szd * ss;
      const y = Math.max(floorY, cy + (rnd() - 0.28) * size * 0.35);
      const kick = 1 + rnd() * 0.48;
      const vx = dx * speed * kick + ivx, vy = dy * speed * 0.78 + 2.6 + rnd() * 4.4 + ivy, vz = dz * speed * kick + ivz;
      const smokeScale = clamp(piece / 0.22, 0.85, 2.8);
      stats.rubbleSpawned++;
      push(rubble, cap.rubble, {
        x, y, z, vx, vy, vz,
        rx: rnd() * Math.PI, ry: rnd() * Math.PI, rz: rnd() * Math.PI,
        sx: (rnd() - 0.5) * 12, sy: (rnd() - 0.5) * 12, sz: (rnd() - 0.5) * 12,
        life: (18 + rnd() * 10) * s.rubbleLifeScale,
        scaleX: piece * stretch, scaleY: piece * flatten, scaleZ: piece * (0.82 + rnd() * 0.55),
        gravity: (58 + rnd() * 16) * s.rubbleGravityScale,
        bounces: 0, maxBounces: 4 + Math.floor(rnd() * 3), damping: 0.24 + rnd() * 0.16, friction: 0.5 + rnd() * 0.16,
        trailTimer: rnd() * 0.04, trailInterval: 0.052 + rnd() * 0.062, smokeScale, radius: piece * 0.62,
        slab: false, r, g, b,
        smoldering, emberHeat: smoldering ? 0.78 + rnd() * 0.42 : 0,
        emberFlicker: rnd() * Math.PI * 2, emberFlickerSpeed: 10 + rnd() * 12,
        emberSmokeTimer: rnd() * 0.12, emberSparkTimer: rnd() * 0.22,
        glowScale: piece * (0.9 + rnd() * 0.55) * s.rubbleGlowScale,
        gr: 1, gg: 0.26 + rnd() * 0.22, gb: 0.04 + rnd() * 0.035, glowNow: 0, light: 0, lightDist: 0, fade: 1,
        resting: false,
      });
      rubbleTrail(x, y, z, vx, vy, vz, smokeScale * 1.2);
    }
    return count;
  }

  // ---- ground slabs (spawnDropShipImpactDebris) — the bomb-scale displaced-earth pieces ----
  // `o.scale` shrinks the whole thing; html-game-v2's numbers are for a drop-pod footprint ~20 m
  // across, which is far too big for a grenade. 1 = theirs.
  function spawnImpactSlabs(cx, cy, cz, o = {}) {
    const k = o.scale ?? 1;
    const count = Math.max(0, Math.round((o.count ?? 10) * s.rubbleCountScale * (o.countScale ?? 1)));
    const originY = groundAt(cx, cz);
    const burstRadius = Math.max(8, (o.footprintRadius ?? 20) * 0.42) * k;
    const smokeBase = o.smokeScale ?? 14.5;
    for (let i = 0; i < count; i++) {
      const ang = rnd() * Math.PI * 2, ox = Math.cos(ang), oz = Math.sin(ang), tx = -oz, tz = ox;
      const startRadius = burstRadius * (0.1 + rnd() * 0.38);
      const piece = (3.4 + rnd() * 2.4) * k, stretch = 1.18 + rnd() * 1.25, flatten = 0.38 + rnd() * 0.36;
      const speed = (30 + rnd() * 34) * s.rubbleSpeedScale * (o.speedScale ?? 0.72) * Math.sqrt(k);
      const rad = 0.78 + rnd() * 0.5, tan = (rnd() - 0.5) * 0.3;
      let dx = ox * rad + tx * tan + (rnd() - 0.5) * 0.14, dy = 1.35 + rnd() * 1.45, dz = oz * rad + tz * tan + (rnd() - 0.5) * 0.14;
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      const x = cx + ox * startRadius + (rnd() - 0.5) * 3.2 * k, z = cz + oz * startRadius + (rnd() - 0.5) * 3.2 * k;
      const y = originY + (1.2 + rnd() * 2.2) * k;
      const vx = dx * speed, vy = dy * speed * 1.45 + (50 + rnd() * 38) * Math.sqrt(k), vz = dz * speed;
      const intensity = 0.52 + rnd() * 0.82;
      stats.rubbleSpawned++;
      push(rubble, cap.rubble, {
        x, y, z, vx, vy, vz,
        rx: rnd() * Math.PI, ry: rnd() * Math.PI, rz: rnd() * Math.PI,
        sx: (rnd() - 0.5) * 10, sy: (rnd() - 0.5) * 10, sz: (rnd() - 0.5) * 10,
        life: (22 + rnd() * 12) * s.rubbleLifeScale,
        scaleX: piece * stretch, scaleY: piece * flatten, scaleZ: piece * (0.9 + rnd() * 0.75),
        gravity: (72 + rnd() * 24) * s.rubbleGravityScale * (o.gravityScale ?? 2.9),
        bounces: 0, maxBounces: 2 + Math.floor(rnd() * 2), damping: 0.18 + rnd() * 0.1, friction: 0.42 + rnd() * 0.12,
        trailTimer: rnd() * 0.025, trailInterval: 0.11 + rnd() * 0.075,
        smokeScale: smokeBase * intensity * k, slabSmokeTimer: 0, slabSmokeDuration: 3.8 + rnd() * 8.4,
        radius: piece * 1.05, slab: true,
        r: 0.18 + rnd() * 0.12, g: 0.12 + rnd() * 0.08, b: 0.07 + rnd() * 0.055,
        smoldering: true, emberHeat: 0.95 + rnd() * 0.45,
        emberFlicker: rnd() * Math.PI * 2, emberFlickerSpeed: 9 + rnd() * 11,
        emberSmokeTimer: rnd() * 0.08, emberSparkTimer: rnd() * 0.18,
        slabShrapnelTimer: 0.12 + rnd() * 0.24, slabShrapnelBursts: 4 + Math.floor(rnd() * 4),
        slabShrapnelRadius: (o.shrapnelRadius ?? 7.5) * k, slabColor: o.color ?? hex(0xffa040),
        glowScale: piece * (1.05 + rnd() * 0.65) * s.rubbleGlowScale,
        gr: 1, gg: 0.2 + rnd() * 0.16, gb: 0.035 + rnd() * 0.04, glowNow: 0, light: 0, lightDist: 0, fade: 1,
        resting: false,
      });
      slabTrail(x, y, z, vx, vy, vz, smokeBase * intensity * k * 1.2);
    }
    return count;
  }

  // ---- step ----
  function stepShrapnel(dt) {
    for (let i = shrapnel.length - 1; i >= 0; i--) {
      const p = shrapnel[i];
      p.life -= dt;
      if (p.life <= 0) { shrapnel.splice(i, 1); continue; }
      // A settled fragment is skipped entirely: gravity would un-zero vy every frame and drag it back
      // through a ground query it can never fail. That query is the expensive part when the world is
      // a noise field rather than a flat floor. How much it saves depends entirely on the caller: a
      // blast at head height has everything down and still within a couple of seconds, while an
      // aircraft killed at 1,500 m has fragments in the air for most of their 20 s life and saves
      // almost nothing. It is never a loss, and it is what stops settled debris drifting or spinning.
      if (!p.resting) {
        p.vy -= p.gravity * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const gy = groundAt(p.x, p.z);
        if (p.y <= gy + p.radius) {
          p.y = gy + p.radius;
          if (p.vy < 0 && p.bounces < p.maxBounces) {
            p.vy = Math.abs(p.vy) * p.damping + 0.35; p.vx *= p.friction; p.vz *= p.friction; p.bounces++;
          } else {
            p.vy = 0; p.vx *= 0.82; p.vz *= 0.82;
            // Spin damping is NOT html-game-v2's: theirs kept turning on the ground forever, which
            // only stayed invisible because nothing ever stopped simulating it. Same rate the rubble
            // uses while grounded.
            p.sx *= 0.68; p.sy *= 0.68; p.sz *= 0.68;
            if (p.vx * p.vx + p.vz * p.vz < REST_SPEED2 && spinBelow(p)) p.resting = true;
          }
        }
        p.rx += p.sx * dt; p.ry += p.sy * dt; p.rz += p.sz * dt;
        p.trailTimer -= dt;
        const v2 = p.vx * p.vx + p.vy * p.vy + p.vz * p.vz;
        if (p.trailTimer <= 0 && v2 > 0.45) { shrapnelTrail(p.x, p.y, p.z, p.vx, p.vy, p.vz, p.smokeScale); p.trailTimer = p.trailInterval; }
      }
      p.flickerTimer -= dt;
      if (p.flickerTimer <= 0) {
        p.flickerTimer = 0.035 + rnd() * 0.08;
        const r = rnd(), c = SHRAPNEL_FLICKER[r > 0.45 ? 0 : r > 0.22 ? 1 : 2];
        p.r = c[0]; p.g = c[1]; p.b = c[2];
      }
      p.fade = Math.min(1, p.life / 4);
      p.glowNow = p.glowing
        ? Math.max(0.001, Math.min(p.scale * 1.15, p.glowScale * Math.min(1, p.life / 1.35) * (0.68 + Math.sin(p.glowPhase + time * 18) * 0.1)))
        : 0;
    }
  }

  function stepRubble(dt) {
    for (let i = rubble.length - 1; i >= 0; i--) {
      const r = rubble[i];
      r.life -= dt;
      if (r.life <= 0) { rubble.splice(i, 1); continue; }
      // The slab smoke window runs on wall-clock, not on motion, so it keeps counting once settled.
      let slabSmoking = true;
      if (r.slab) {
        r.slabSmokeTimer += dt;
        slabSmoking = r.slabSmokeTimer < r.slabSmokeDuration;
      }
      // Same short-circuit as the shrapnel: a settled piece is only an ember from here on.
      if (!r.resting) {
        r.vy -= r.gravity * dt;
        r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
        const gy = groundAt(r.x, r.z);
        if (r.y <= gy + r.radius) {
          r.y = gy + r.radius;
          if (r.vy < 0 && r.bounces < r.maxBounces) {
            r.vy = Math.abs(r.vy) * r.damping + 0.12; r.vx *= r.friction; r.vz *= r.friction;
            r.sx *= 0.62; r.sy *= 0.62; r.sz *= 0.62; r.bounces++;
            if (r.slab) slabTrail(r.x, r.y, r.z, r.vx, r.vy, r.vz, r.smokeScale * 0.95);
            else rubbleTrail(r.x, r.y, r.z, r.vx, r.vy, r.vz, r.smokeScale * 1.15);
          } else {
            r.vy = 0; r.vx *= 0.72; r.vz *= 0.72; r.sx *= 0.68; r.sy *= 0.68; r.sz *= 0.68;
            if (r.vx * r.vx + r.vz * r.vz < REST_SPEED2 && spinBelow(r)) r.resting = true;
          }
        }
        r.rx += r.sx * dt; r.ry += r.sy * dt; r.rz += r.sz * dt;
        r.trailTimer -= dt;
        const v2 = r.vx * r.vx + r.vy * r.vy + r.vz * r.vz;
        if (r.slab) {
          r.slabShrapnelTimer -= dt;
          if (r.slabShrapnelTimer <= 0) {
            if (r.slabShrapnelBursts > 0 && v2 > 42 && shrapnel.length < cap.shrapnel * 0.82) {
              spawnBlastShrapnel(r.x, r.y, r.z, r.slabShrapnelRadius, r.slabColor,
                { countScale: 0.18, speedScale: 1.45, verticalBoost: 0.12 });
              r.slabShrapnelBursts--;
              r.slabShrapnelTimer = 0.22 + rnd() * 0.34;
            } else r.slabShrapnelTimer = 0.18 + rnd() * 0.22;
          }
        }
        if (r.trailTimer <= 0 && v2 > 0.26) {
          if (r.slab) { if (slabSmoking) slabTrail(r.x, r.y, r.z, r.vx, r.vy, r.vz, r.smokeScale); }
          else rubbleTrail(r.x, r.y, r.z, r.vx, r.vy, r.vz, r.smokeScale);
          r.trailTimer = r.trailInterval;
        }
      }
      if (r.smoldering) {
        r.emberFlicker += dt * r.emberFlickerSpeed;
        const emberFade = Math.min(1, r.life / 7) * r.emberHeat;
        const flicker = 0.72 + Math.sin(r.emberFlicker) * 0.18 + Math.sin(r.emberFlicker * 2.31) * 0.1;
        r.glowNow = Math.max(0.001, r.glowScale * emberFade * Math.max(0.42, flicker));
        const ls = s.rubbleLightScale;
        if (ls > 0 && emberFade > 0.04) {
          r.light = Math.max(0, (0.75 + r.glowScale * 2.2) * emberFade * flicker * ls);
          r.lightDist = (3.2 + r.glowScale * 7.5) * Math.max(0.25, Math.sqrt(ls));
          r.lightG = 0.28 + flicker * 0.08;
        } else r.light = 0;
        r.emberSmokeTimer -= dt;
        if (r.emberSmokeTimer <= 0) {
          if (r.slab) { if (slabSmoking) slabTrail(r.x, r.y + r.radius * 1.05, r.z, 0, 1, 0, r.smokeScale * 0.28); }
          else rubbleTrail(r.x, r.y + r.radius * 1.05, r.z, 0, 1, 0, r.smokeScale * 0.95, true);
          r.emberSmokeTimer = r.slab ? 0.26 + rnd() * 0.32 : 0.12 + rnd() * 0.22;
        }
        r.emberSparkTimer -= dt;
        if (r.emberSparkTimer <= 0 && rnd() < 0.72) { emberSpark(r); r.emberSparkTimer = 0.16 + rnd() * 0.42; }
      } else { r.glowNow = 0; r.light = 0; }
      r.fade = Math.min(1, r.life / 5);
    }
  }

  function stepSparks(dt) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life -= dt;
      if (p.life <= 0) { sparks.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    }
  }

  function stepSmoke(dt) {
    for (let i = smoke.length - 1; i >= 0; i--) {
      const p = smoke[i];
      p.life -= dt;
      if (p.life <= 0) { smoke.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    }
  }

  function step(dt) {
    time += dt;
    stepShrapnel(dt);
    stepRubble(dt);
    stepSparks(dt);
    stepSmoke(dt);
  }

  // The hottest rubble pieces, for a renderer with a fixed light pool (html-game-v2 uses 8).
  // Called once per frame by the renderer to fill a light pool of 2 to 8 out of up to 260 pieces.
  // Selection, not a sort: collecting the lit ones and sorting all of them was the whole cost.
  function hottestRubble(n) {
    if (n <= 0) return [];
    const top = [];
    for (const r of rubble) {
      if (r.light <= 0) continue;
      if (top.length < n) {
        let i = top.length;
        while (i > 0 && top[i - 1].light < r.light) { top[i] = top[i - 1]; i--; }
        top[i] = r;
      } else if (r.light > top[n - 1].light) {
        let i = n - 1;
        while (i > 0 && top[i - 1].light < r.light) { top[i] = top[i - 1]; i--; }
        top[i] = r;
      }
    }
    return top;
  }

  function clear() { shrapnel.length = 0; rubble.length = 0; sparks.length = 0; smoke.length = 0; }
  const counts = () => ({ shrapnel: shrapnel.length, rubble: rubble.length, sparks: sparks.length, smoke: smoke.length });

  return {
    settings: s, caps: cap, shrapnel, rubble, sparks, smoke, stats,
    get time() { return time; },
    spawnBlastShrapnel, spawnRubble, spawnImpactSlabs, spawnSmoke,
    step, clear, counts, hottestRubble,
  };
}
