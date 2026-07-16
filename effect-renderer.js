// effect-renderer.js — draws the serialized 'effect' entities produced by
// entity-types/effect.js: bullet tracers, impact sparks, muzzle flashes, and layered
// explosions. This is a faithful port of html-game-v2's explosion look (fireball flash,
// shockwave ring, ember burst, hot shrapnel, lingering smoke) into this renderer's
// replication model: instead of spawning hundreds of stateful particles, every sub-particle
// is regenerated each frame *deterministically* from the single wire object + a hashed id +
// wall-clock age. Host and guest therefore render an identical blast from one tiny snapshot.
//
// Two draw systems:
//   - Additive lines + points (pooled buffers) for tracers, sparks, shockwave rings, ember
//     dots, and hot shrapnel streaks.
//   - A soft-billboard SPRITE POOL (core THREE.Sprite, auto-facing) for the volumetric
//     fireball flash and the dark, lingering smoke — the layers that need per-puff colour,
//     opacity and scale that pooled Points can't express under the WebGPU backend.
//
// sync(list, nowMs): `list` is serialized effect wire objects; call every render frame.

import { SpriteNodeMaterial } from 'three/webgpu';

const SPARK_RAYS = 6;
const GLOW_POOL = 220;   // additive fireball / muzzle-flash sprites live at once (cap)
const SMOKE_POOL = 260;  // normal-blend smoke sprites live at once (cap)

// Small deterministic hash → [0,1) so per-particle scatter is stable per entity id.
function hash01(str, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// A radial white→transparent puff texture, shared by every sprite (tinted per-puff via
// material.color). Generated once on the CPU; works on the WebGPU backend as a CanvasTexture.
function makeSoftTexture(THREE) {
  const S = 64;
  const cv = (typeof document !== 'undefined')
    ? document.createElement('canvas') : new OffscreenCanvas(S, S);
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createEffectRenderer({ THREE, scene, terrainHeight = null, maxSegments = 3072, maxPoints = 1024 }) {
  // Real ground height under a point (injected). Explosions use this instead of assuming the
  // blast Y is the ground — a rocket can detonate on a trunk, a wall, a creature, or mid-air.
  const groundAt = (x, z, fallback) => (typeof terrainHeight === 'function' ? terrainHeight(x, z) : fallback);
  // ---- additive lines (tracers, sparks, shockwave rings, shrapnel streaks) ----
  const segPos = new Float32Array(maxSegments * 2 * 3);
  const segCol = new Float32Array(maxSegments * 2 * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(segPos, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(segCol, 3));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  scene.add(lines);

  // ---- additive points (muzzle glow origins, ember dots, ray tips) ----
  const ptPos = new Float32Array(maxPoints * 3);
  const ptCol = new Float32Array(maxPoints * 3);
  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute('position', new THREE.BufferAttribute(ptPos, 3));
  ptGeo.setAttribute('color', new THREE.BufferAttribute(ptCol, 3));
  const ptMat = new THREE.PointsMaterial({
    size: 0.35, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(ptGeo, ptMat);
  points.frustumCulled = false;
  scene.add(points);

  // ---- soft-billboard sprite pools (fireball glow + smoke) ----
  const softTex = makeSoftTexture(THREE);
  const makePool = (count, blending) => {
    const group = new THREE.Group();
    group.frustumCulled = false;
    const items = [];
    for (let i = 0; i < count; i++) {
      // SpriteNodeMaterial (not classic SpriteMaterial) — required by the WebGPU backend;
      // .color/.opacity are live uniforms, mutated per-frame from the pooled sub-particles.
      const mat = new SpriteNodeMaterial({
        map: softTex, transparent: true, depthWrite: false, blending, opacity: 0,
      });
      mat.fog = blending === THREE.NormalBlending; // smoke reads atmosphere; additive glow stays bright
      const spr = new THREE.Sprite(mat);
      spr.visible = false;
      group.add(spr);
      items.push(spr);
    }
    scene.add(group);
    return { items, mat0: items[0]?.material };
  };
  const glow = makePool(GLOW_POOL, THREE.AdditiveBlending);
  const smoke = makePool(SMOKE_POOL, THREE.NormalBlending);

  const firstSeen = new Map(); // id -> nowMs first observed

  let segCount = 0, ptCount = 0, glowCount = 0, smokeCount = 0;
  const pushSeg = (ax, ay, az, bx, by, bz, cr, cg, cb) => {
    if (segCount >= maxSegments) return;
    const i = segCount * 6;
    segPos[i] = ax; segPos[i + 1] = ay; segPos[i + 2] = az;
    segPos[i + 3] = bx; segPos[i + 4] = by; segPos[i + 5] = bz;
    segCol[i] = cr; segCol[i + 1] = cg; segCol[i + 2] = cb;
    segCol[i + 3] = cr; segCol[i + 4] = cg; segCol[i + 5] = cb;
    segCount++;
  };
  const pushPoint = (x, y, z, cr, cg, cb) => {
    if (ptCount >= maxPoints) return;
    const i = ptCount * 3;
    ptPos[i] = x; ptPos[i + 1] = y; ptPos[i + 2] = z;
    ptCol[i] = cr; ptCol[i + 1] = cg; ptCol[i + 2] = cb;
    ptCount++;
  };
  // Place one pooled sprite. `pool` is glow (additive) or smoke (normal).
  const pushSprite = (pool, isGlow, x, y, z, size, r, g, b, alpha) => {
    if (alpha <= 0.003 || size <= 0) return;
    const idx = isGlow ? glowCount : smokeCount;
    if (idx >= pool.items.length) return;
    const spr = pool.items[idx];
    spr.visible = true;
    spr.position.set(x, y, z);
    spr.scale.set(size, size, 1);
    spr.material.color.setRGB(r, g, b);
    spr.material.opacity = Math.min(1, alpha);
    if (isGlow) glowCount++; else smokeCount++;
  };

  // ---------- layered explosion (port of createEnemyDeathExplosion) ----------
  // t = seconds since first seen; R = blast radius; (cr,cg,cb) = base blast colour.
  function drawExplosion(e, t, cr, cg, cb) {
    const R = Math.max(1, Number(e.radius) || 6);
    const P = e.p;
    const gY = groundAt(P[0], P[2], P[1] - 0.5); // true terrain height under the blast
    const nearGround = (P[1] - gY) < R * 0.8;    // airbursts/wall/creature hits skip the ground ring

    // 1. Fireball core — white-hot ball that flares then collapses to the blast colour.
    if (t < 0.2) {
      const ct = t / 0.2, a = 1 - ct;
      const wr = cr + (1 - cr) * (1 - ct), wg = cg + (1 - cg) * (1 - ct), wb = cb + (1 - cb) * (1 - ct);
      pushSprite(glow, true, P[0], P[1], P[2], R * (0.5 + ct * 0.7), wr, wg, wb, 0.95 * a);
    }
    // 2. Fireball body — a few warm puffs bloom outward for volume.
    if (t < 0.34) {
      const bt = t / 0.34, a = (1 - bt) * 0.8;
      for (let k = 0; k < 5; k++) {
        const ang = hash01(e.id, k * 7 + 2) * Math.PI * 2;
        const rad = R * (0.15 + bt * 0.55) * (0.5 + hash01(e.id, k * 7 + 3));
        const ox = Math.cos(ang) * rad, oz = Math.sin(ang) * rad;
        const oy = (hash01(e.id, k * 7 + 4) - 0.3) * R * bt * 0.8;
        pushSprite(glow, true, P[0] + ox, P[1] + oy, P[2] + oz,
          R * (0.4 + bt * 0.5), cr, cg * 0.85 + 0.1, cb * 0.6, a);
      }
    }
    // 3. Shockwave ground ring — expanding additive ring on the terrain plane (ground hits only).
    if (nearGround && t < 0.42) {
      const st = t / 0.42, rr = R * (0.2 + st * 1.05), a = (1 - st) * 0.8;
      const SEG = 26;
      for (let k = 0; k < SEG; k++) {
        const a0 = (k / SEG) * Math.PI * 2, a1 = ((k + 1) / SEG) * Math.PI * 2;
        pushSeg(P[0] + Math.cos(a0) * rr, gY + 0.12, P[2] + Math.sin(a0) * rr,
          P[0] + Math.cos(a1) * rr, gY + 0.12, P[2] + Math.sin(a1) * rr,
          cr * a, (cg * 0.7 + 0.3) * a, cb * a);
      }
    }
    // 4. Shell — warm radial rays bursting to ~0.8R (the wireframe-shell analog).
    if (t < 0.28) {
      const st = t / 0.28, grow = R * (0.15 + st * 0.7), a = (1 - st) * 0.9;
      for (let k = 0; k < 14; k++) {
        let dx = hash01(e.id, k * 3 + 11) - 0.5, dy = hash01(e.id, k * 3 + 12) - 0.5, dz = hash01(e.id, k * 3 + 13) - 0.5;
        const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
        pushSeg(P[0], P[1], P[2], P[0] + dx * grow, P[1] + dy * grow, P[2] + dz * grow,
          a, a * 0.85, a * 0.6);
      }
    }
    // 5. Embers — ~22 warm dots on ballistic arcs (gravity), cooling as they fly.
    if (t < 0.52) {
      const et = t / 0.52, a = 1 - et, G = 26;
      for (let k = 0; k < 22; k++) {
        let dx = hash01(e.id, k * 5 + 21) - 0.5, dy = hash01(e.id, k * 5 + 22), dz = hash01(e.id, k * 5 + 23) - 0.5;
        const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
        const sp = R * (1.2 + hash01(e.id, k * 5 + 24) * 2.2);
        const x = P[0] + dx * sp * t, y = P[1] + dy * sp * t - 0.5 * G * t * t, z = P[2] + dz * sp * t;
        const warm = 0.4 + hash01(e.id, k * 5 + 25) * 0.6; // orange→yellow
        pushPoint(x, Math.max(gY + 0.05, y), z, a, a * (0.5 + warm * 0.4), a * 0.25 * warm);
      }
    }
    // 6. Shrapnel — ~12 hot fragment streaks flung out under gravity; skid along the real
    // ground on contact (streak turns horizontal) rather than punching through it.
    if (t < 0.72) {
      const ft = t / 0.72, a = (1 - ft) * 0.9, G = 30;
      for (let k = 0; k < 12; k++) {
        let dx = hash01(e.id, k * 4 + 31) - 0.5, dy = 0.2 + hash01(e.id, k * 4 + 32) * 0.8, dz = hash01(e.id, k * 4 + 33) - 0.5;
        const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
        const sp = R * (2.0 + hash01(e.id, k * 4 + 34) * 3.0);
        const vy0 = dy * sp;
        let y = P[1] + vy0 * t - 0.5 * G * t * t;
        const x = P[0] + dx * sp * t, z = P[2] + dz * sp * t;
        let ux = dx * sp, uy = vy0 - G * t, uz = dz * sp; // instantaneous velocity
        if (y < gY + 0.05) { y = gY + 0.05; uy = 0; }     // grounded: skid, don't drill downward
        const vlen = Math.hypot(ux, uy, uz) || 1; ux /= vlen; uy /= vlen; uz /= vlen;
        const streak = 0.4 + R * 0.06;
        pushSeg(x, y, z, x - ux * streak, y - uy * streak, z - uz * streak, a, a * 0.55, a * 0.2);
      }
    }
    // 7. Smoke — dark puffs that rise, expand, and linger long after the flash.
    {
      const SMK = 10;
      for (let k = 0; k < SMK; k++) {
        const born = hash01(e.id, k * 6 + 41) * 0.12;      // staggered emission
        const dur = 1.3 + hash01(e.id, k * 6 + 42) * 0.4;
        const lt = (t - born) / dur;
        if (lt <= 0 || lt >= 1) continue;
        const ang = hash01(e.id, k * 6 + 43) * Math.PI * 2;
        const rad = R * (0.1 + smooth(lt) * 0.6) * (0.4 + hash01(e.id, k * 6 + 44));
        const rise = R * 0.5 * lt + lt * lt * R * 0.4;
        const x = P[0] + Math.cos(ang) * rad, z = P[2] + Math.sin(ang) * rad;
        const y = P[1] + rise + R * 0.15;
        const size = R * (0.5 + smooth(lt) * 1.1);
        const a = smooth(Math.min(1, lt * 4)) * (1 - lt) * 0.5; // fade in fast, out slow
        const shade = 0.34 - lt * 0.16; // cools from warm-gray toward dark
        pushSprite(smoke, false, x, y, z, size, shade + 0.06, shade, shade * 0.92, a);
      }
    }
  }

  // ---------- muzzle flash (port of createMuzzleFlash + createMuzzleSmoke) ----------
  // P is the actual viewmodel muzzle (~0.6 m from the eye), so everything here is SMALL and
  // sits just ahead of the barrel — never a screen-filling flash in the shooter's face.
  function drawMuzzle(e, t, cr, cg, cb) {
    const P = e.p, d = e.dir || [0, 0, 1];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const dx = d[0] / dl, dy = d[1] / dl, dz = d[2] / dl;
    const fx = e.muzzleFx || {};
    const value = (key, fallback) => Number.isFinite(fx[key]) ? fx[key] : fallback;
    // Barrel-relative basis for deterministic scatter. This prevents the old world-X/Z
    // jitter from sliding smoke sideways when the player looks in a different direction.
    let rx = -dz, ry = 0, rz = dx;
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-5) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * dz - rz * dy, uy = rz * dx - rx * dz, uz = rx * dy - ry * dx;
    // hot flash right at the muzzle tip, very brief
    const flashDuration = Math.max(0.001, value('flashDuration', 0.08));
    const flashOpacity = Math.max(0, value('flashOpacity', 0.85));
    if (t < flashDuration && flashOpacity > 0) {
      const a = (1 - t / flashDuration) * flashOpacity;
      const fwd = value('flashForward', 0.02);
      const px = P[0] + dx * fwd, py = P[1] + dy * fwd, pz = P[2] + dz * fwd;
      pushSprite(glow, true, px, py, pz,
        Math.max(0.001, value('flashSize', 0.13) + t * value('flashGrowth', 0.4)),
        cr, cg, cb, a);
      pushPoint(px, py, pz, a * cr, a * cg, a * cb);
    }
    // Small smoke wisps start at the authored muzzle and drift along its world orientation.
    const smokeCount = Math.max(0, Math.min(12, Math.round(value('smokeCount', 2))));
    const smokeDuration = Math.max(0.001, value('smokeDuration', 0.42));
    const smokeOpacity = Math.max(0, value('smokeOpacity', 0.22));
    for (let k = 0; k < smokeCount && smokeOpacity > 0; k++) {
      const dur = smokeDuration * (0.85 + hash01(e.id, k * 4 + 51) * 0.3);
      const lt = t / dur;
      if (lt >= 1) continue;
      const fwd = value('smokeForward', 0) + lt * value('smokeTravel', 0.42)
        * (0.75 + hash01(e.id, k * 4 + 52) * 0.5);
      const scatter = value('smokeSpread', 0.06) * (0.2 + lt * 0.8);
      const jr = (hash01(e.id, k * 4 + 53) - 0.5) * 2 * scatter;
      const ju = (hash01(e.id, k * 4 + 54) - 0.5) * 2 * scatter;
      const x = P[0] + dx * fwd + rx * jr + ux * ju;
      const y = P[1] + dy * fwd + ry * jr + uy * ju + lt * value('smokeRise', 0.1);
      const z = P[2] + dz * fwd + rz * jr + uz * ju;
      const size = Math.max(0.001, value('smokeSize', 0.08) + lt * value('smokeGrowth', 0.28));
      const a = smooth(Math.min(1, lt * 5)) * (1 - lt) * smokeOpacity;
      pushSprite(smoke, false, x, y, z, size, 0.4, 0.4, 0.38, a);
    }
  }

  function sync(list, nowMs) {
    segCount = 0; ptCount = 0; glowCount = 0; smokeCount = 0;
    const live = new Set();

    for (const e of (list || [])) {
      if (!e || e.type !== 'effect' || !Array.isArray(e.p)) continue;
      live.add(e.id);
      let seen = firstSeen.get(e.id);
      if (seen === undefined) { seen = nowMs; firstSeen.set(e.id, nowMs); }
      const t = (nowMs - seen) / 1000;
      const lifeMs = (Number(e.life) || 0.1) * 1000;
      const a = 1 - Math.min(1, Math.max(0, (nowMs - seen) / lifeMs));
      if (a <= 0) continue;
      const col = e.color || [1, 0.85, 0.45];
      const cr0 = col[0], cg0 = col[1], cb0 = col[2];

      if (e.kind === 'explosion') {
        drawExplosion(e, t, cr0, cg0, cb0);
      } else if (e.kind === 'muzzle_flash') {
        drawMuzzle(e, t, cr0, cg0, cb0);
      } else if (e.kind === 'hit_spark') {
        // Spark rays fade fast (0.22s) while a small dust puff lingers over the full life.
        const st = Math.min(1, t / 0.22), sa = 1 - st;
        const cr = cr0 * sa, cg = cg0 * sa, cb = cb0 * sa;
        const n = e.normal || [0, 1, 0];
        const grow = 0.18 + st * 1.1;
        for (let k = 0; k < SPARK_RAYS; k++) {
          const jx = hash01(e.id, k * 3 + 1) - 0.5;
          const jy = hash01(e.id, k * 3 + 2) - 0.5;
          const jz = hash01(e.id, k * 3 + 3) - 0.5;
          let dx = n[0] + jx * 1.6, dy = n[1] + jy * 1.6, dz = n[2] + jz * 1.6;
          const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
          pushSeg(e.p[0], e.p[1], e.p[2],
            e.p[0] + dx * grow, e.p[1] + dy * grow, e.p[2] + dz * grow, cr, cg, cb);
        }
        pushPoint(e.p[0], e.p[1], e.p[2], cr, cg, cb);
        // dust for world-surface hits only (not flesh) — reads as debris kicked up.
        if (e.surface === 'terrain' || e.surface === 'obstacle') {
          const dt2 = t / (Number(e.life) || 0.6);
          if (dt2 < 1) {
            const y = e.p[1] + n[1] * 0.2 + dt2 * 0.4;
            const da = smooth(Math.min(1, dt2 * 5)) * (1 - dt2) * 0.3;
            pushSprite(smoke, false, e.p[0] + n[0] * 0.2, y, e.p[2] + n[2] * 0.2,
              0.28 + dt2 * 0.5, 0.42, 0.4, 0.36, da);
          }
        }
      } else {
        // gun_tracer / generic: a bright additive segment + muzzle glow at the origin.
        const cr = cr0 * a, cg = cg0 * a, cb = cb0 * a;
        const p1 = e.p1 || e.p;
        pushSeg(e.p[0], e.p[1], e.p[2], p1[0], p1[1], p1[2], cr, cg, cb);
        pushPoint(e.p[0], e.p[1], e.p[2], cr, cg, cb);
      }
    }

    // Drop fade state for ids no longer present.
    if (firstSeen.size > live.size) {
      for (const id of firstSeen.keys()) if (!live.has(id)) firstSeen.delete(id);
    }

    lineGeo.setDrawRange(0, segCount * 2);
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;
    ptGeo.setDrawRange(0, ptCount);
    ptGeo.attributes.position.needsUpdate = true;
    ptGeo.attributes.color.needsUpdate = true;
    lines.visible = segCount > 0;
    points.visible = ptCount > 0;
    // Hide unused pooled sprites from this frame.
    for (let i = glowCount; i < glow.items.length; i++) if (glow.items[i].visible) glow.items[i].visible = false;
    for (let i = smokeCount; i < smoke.items.length; i++) if (smoke.items[i].visible) smoke.items[i].visible = false;
  }

  function dispose() {
    scene.remove(lines); scene.remove(points);
    lineGeo.dispose(); lineMat.dispose(); ptGeo.dispose(); ptMat.dispose();
    for (const s of glow.items) { s.material.dispose(); scene.remove(s); }
    for (const s of smoke.items) { s.material.dispose(); scene.remove(s); }
    softTex.dispose();
  }

  return { sync, dispose };
}
