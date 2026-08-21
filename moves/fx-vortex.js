/**
 * fx-vortex.js — the trapping whirls. Fire Spin, Magma Storm, Whirlpool, Sand Tomb, Leaf Tornado,
 * Twister, Hurricane, Wrap, Bind, Infestation.
 *
 * A vortex is not a beam: it is a funnel standing on the ground at the target, so this is fx-stream's
 * swept surface with the straight caster-to-target axis replaced by a fixed vertical one and the tube's
 * circumferential angle — already a full 0..2π wrap in the donor — reused unchanged as the wrap around
 * the funnel itself. That fork turns out to *simplify* the donor's geometry: stream needs a Gram-Schmidt
 * frame at cast time because its axis can point anywhere, including straight up, which is exactly the
 * case that breaks a naive `cross(dir, up)`. A vertical axis is never degenerate, so the outward normal
 * here is just `vec3(cos(ang), 0, sin(ang))` — no basis vectors, no cast-time frame at all.
 *
 * Height (`t`, 0 at the foot, 1 at the crown) plays the part of stream's along-axis `t`; the cone-radius
 * curve, the radial wobble noise and the downstream-scrolling streak shading are stream's formulas
 * verbatim, just evaluated against height instead of distance. Growth is the same clip idiom as stream's
 * `uProgress`/`uTail`: the funnel is cut off above `uGrow` while it spins up (never scaled), and eaten
 * from the foot upward by `uTail` while it shuts down — the exact mirror of stream's mouth-end tail clip.
 *
 * Rotation is a travelling wave, not a transform: the silhouette's noise samples the angle plus a
 * `time * P.spin` phase (see `spin` in `buildKit`), so the bumps drift around the funnel over time while
 * each vertex's own outward direction never changes. That keeps every camera-facing calculation exactly
 * as valid as stream's — no object-space rotation to reconcile against `cameraPosition` — while still
 * reading as a spinning column. The orbiting debris (part 5 from move-parts) get a *real* angle,
 * `rnd() * TAU + now * P.spin`, using the identical `P.spin` constant, so the flung sparks keep pace with
 * the visible swirl even though the mechanisms (a shading phase vs. an actual emission angle) differ.
 * `funnelRadiusAt`/`funnelHeightAt` below are the CPU mirror of the GPU's `radius`/`centreLocal.y` — the
 * trap both reviews called the hardest part of this fork. They are written right next to the node graph
 * they mirror, they deliberately drop the noise wobble (no cheap CPU equivalent, same call fx-stream's
 * own `frontAt` makes for its wander term), and the test asserts they agree with the documented formula.
 *
 * The target end of the cast line is everything here; the origin barely matters. `targetY` sizes the
 * funnel tall enough to visually engulf whatever stands at the target (a trapping move should look like
 * it closes over the creature); `sourceY`, the caster's own height, is not read anywhere — nothing
 * travels from the caster, so there is nothing for it to place.
 *
 * Layers: the funnel surface (a `PlaneGeometry` parameter grid under a hand-written node graph, as
 * above); orbiting debris and spray (`createSpriteParticles`, angular emission angle, linear-with-drag
 * flight afterward — they get flung off the cone rather than truly circling it, which reads the same and
 * needs no bespoke integrator); a foot collar ring built from `buildRing` at the funnel's own base
 * radius, so the two never disagree and the wrap has no seam; a ground decal from `makeGroundDecal`; and
 * one pooled light breathing from inside the column.
 *
 * Held move: TRAVEL is the spin-up (grow tracks `machine.u` linearly, landing at full height exactly at
 * `onImpact`), IMPACT is the standing funnel — this is what has to look right sitting there for several
 * turns — and FADE is the tail-clip shutdown. `hold`/`maxHold` are set by the harness, never by this file.
 */

import { createPhaseMachine, mulberry32, Easing, saturate, createRateEmitter } from './move-core.js';
import { buildRing, createSpriteParticles, makeGroundDecal } from './move-parts.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * GPU mirror: must equal the `radius` expression built in `buildKit` — `mix(radiusNear, radiusFar,
 * pow(t, radiusCurve)) * width` — minus the shader's noise wobble term, which has no cheap CPU
 * equivalent (the same omission fx-stream's own `frontAt` makes for its wander noise). Used to seat
 * every debris/spray emission point, and the light, on the actual cone instead of adrift near it.
 */
export function funnelRadiusAt(P, widthScale, t) {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  return lerp(P.radiusNear, P.radiusFar, Math.pow(tt, P.radiusCurve)) * widthScale;
}

/** GPU mirror: must equal `centreLocal.y` in `buildKit` — `height * t` — sway noise omitted as above. */
export function funnelHeightAt(height, t) {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  return height * tt;
}

/** Named looks. Every field is overridable through `options.palettes.<name>` at factory level. */
export const PALETTES = {
  flame: {
    core: '#fff2c0', mid: '#ff8a1e', edge: '#5c1400', puffA: '#ffb347', puffB: '#3a1404',
    decal: '#140a05', ringColor: '#2a0f06', additive: true, opacity: 1,
    height: 3.2, radiusNear: 0.35, radiusFar: 1.1, radiusCurve: 0.8, ringWidth: 0.3, ringOpacity: 0.5,
    wobble: 0.35, bands: 2.2, noiseScale: 2.6, flow: 3.8, wander: 0.18, spin: 4.2,
    streak: 1, streakSharp: 0.42, streakScale: 4.5, streakBands: 2.6, streakAlpha: 0.4, sparkle: 0.15,
    rim: 0.55, fill: 0.8, coreSharp: 1.4, edgePower: 2, baseGlow: 1.2, baseLen: 0.12, tipSoft: 0.06,
    puffRate: 70, puffSize: 0.34, puffLife: 0.9, puffAspect: [0.85, 1.3], puffGravity: -3.2, puffDrag: 1.1,
    puffSpeed: 3.4, light: '#ff7a1e', lightIntensity: 16, lightDistance: 13, flicker: 0.32,
  },
  water: {
    core: '#eaffff', mid: '#59c8ff', edge: '#08395e', puffA: '#bfeaff', puffB: '#2b6fa8',
    decal: '#0d2b3f', ringColor: '#bfeeff', additive: false, opacity: 0.55,
    height: 1.1, radiusNear: 0.5, radiusFar: 1.7, radiusCurve: 1.15, ringWidth: 0.5, ringOpacity: 0.75,
    wobble: 0.22, bands: 2.6, noiseScale: 3.6, flow: -2.4, wander: 0.06, spin: 2.1,
    streak: 0.9, streakSharp: 0.5, streakScale: 6, streakBands: 3.2, streakAlpha: 0.32, sparkle: 0.2,
    rim: 0.85, fill: 0.4, coreSharp: 1.1, edgePower: 1.6, baseGlow: 0.5, baseLen: 0.1, tipSoft: 0.05,
    puffRate: 55, puffSize: 0.18, puffLife: 0.8, puffAspect: [1, 1], puffGravity: 3, puffDrag: 0.6,
    puffSpeed: 2.6, light: '#7fd0ff', lightIntensity: 6, lightDistance: 9, flicker: 0.05,
  },
  sand: {
    core: '#e8d29a', mid: '#c9a35c', edge: '#7a5a2c', puffA: '#d8bd80', puffB: '#5a3f1e',
    decal: '#3a2a12', ringColor: '#4a3416', additive: false, opacity: 0.95,
    height: 2, radiusNear: 0.4, radiusFar: 0.85, radiusCurve: 0.9, ringWidth: 0.4, ringOpacity: 0.6,
    wobble: 0.4, bands: 1.8, noiseScale: 2.2, flow: 1.6, wander: 0.14, spin: 1.6,
    streak: 0.6, streakSharp: 0.5, streakScale: 3.5, streakBands: 1.8, streakAlpha: 0.25, sparkle: 0,
    rim: 0.3, fill: 0.95, coreSharp: 1, edgePower: 1.4, baseGlow: 0, baseLen: 0.1, tipSoft: 0.08,
    puffRate: 90, puffSize: 0.4, puffLife: 0.7, puffAspect: [0.9, 0.9], puffGravity: 7, puffDrag: 1.4,
    puffSpeed: 3, light: '#c9a35c', lightIntensity: 0, lightDistance: 8, flicker: 0,
  },
  leaf: {
    core: '#eaffcf', mid: '#7fd94a', edge: '#234d12', puffA: '#a6e26a', puffB: '#2f5c16',
    decal: '#1c3a0d', ringColor: '#284d14', additive: false, opacity: 0.12,
    height: 2.6, radiusNear: 0.3, radiusFar: 0.95, radiusCurve: 0.85, ringWidth: 0.25, ringOpacity: 0.3,
    wobble: 0.3, bands: 2, noiseScale: 2.8, flow: 2.6, wander: 0.22, spin: 3.4,
    streak: 0.5, streakSharp: 0.55, streakScale: 4, streakBands: 2.2, streakAlpha: 0.18, sparkle: 0,
    rim: 0.5, fill: 0.12, coreSharp: 1, edgePower: 1.8, baseGlow: 0, baseLen: 0.1, tipSoft: 0.07,
    puffRate: 85, puffSize: 0.3, puffLife: 1.1, puffAspect: [1.3, 0.7], puffGravity: -1.2, puffDrag: 0.9,
    puffSpeed: 3.6, light: '#7fd94a', lightIntensity: 4, lightDistance: 8, flicker: 0.1,
  },
  gale: {
    core: '#ffffff', mid: '#dfe8ee', edge: '#8fa0ac', puffA: '#eef3f6', puffB: '#7d8b93',
    decal: '#5a636a', ringColor: '#8fa0ac', additive: false, opacity: 0.1,
    height: 3.4, radiusNear: 0.32, radiusFar: 1, radiusCurve: 0.9, ringWidth: 0.3, ringOpacity: 0.2,
    wobble: 0.25, bands: 2.4, noiseScale: 3, flow: 3, wander: 0.16, spin: 3,
    streak: 1.1, streakSharp: 0.62, streakScale: 6.5, streakBands: 3.4, streakAlpha: 0.5, sparkle: 0,
    rim: 0.35, fill: 0.08, coreSharp: 0.8, edgePower: 1.6, baseGlow: 0, baseLen: 0.1, tipSoft: 0.06,
    puffRate: 45, puffSize: 0.22, puffLife: 0.85, puffAspect: [1, 1], puffGravity: 0.4, puffDrag: 0.8,
    puffSpeed: 3.2, light: '#dfe8ee', lightIntensity: 0, lightDistance: 8, flicker: 0,
  },
};

const DEFAULTS = {
  travelSpeed: 8, impactTime: 2.2, fadeTime: 0.9, heightSegs: 30, radialSegs: 64,
  puffCap: 220, decalScale: 1.3, poolPerPalette: 3, widthScale: 1,
};

/** Two-row ring strip standing a hair off the ground; width applied in local XZ using `ringPoint.sx/sz`. */
function buildRingBandGeometry(THREE, ring, width) {
  const cols = ring.length;
  const pos = new Float32Array(cols * 2 * 3);
  const across = new Float32Array(cols * 2);
  const us = new Float32Array(cols * 2);
  const idx = [];
  for (let i = 0; i < cols; i++) {
    const p = ring[i];
    for (let k = 0; k < 2; k++) {
      const vi = i * 2 + k;
      const w = (k === 0 ? -1 : 1) * width * 0.5;
      pos[vi * 3] = p.x + p.sx * w; pos[vi * 3 + 1] = p.y + 0.015; pos[vi * 3 + 2] = p.z + p.sz * w;
      across[vi] = k === 0 ? -1 : 1;
      us[vi] = p.u;
    }
  }
  for (let i = 0; i < cols - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geo.setIndex(idx);
  return geo;
}

export function createVortexFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, terrainHeight = () => 0, lights } = deps;
  const O = { ...DEFAULTS, ...options };
  const {
    uniform, attribute, positionGeometry, cameraPosition, time, mix, smoothstep, clamp, pow, abs,
    sin, cos, dot, normalize, varying, vec3, float, mx_noise_float,
  } = TSL;

  const pools = new Map();
  const liveKits = new Set();

  function paramsFor(name) {
    const base = PALETTES[name] || PALETTES.gale;
    const over = options.palettes && options.palettes[name];
    return { ...base, ...(over || {}) };
  }

  function buildKit(key) {
    const P = paramsFor(key);
    const u = {
      base: uniform(new THREE.Vector3()), seed: uniform(0), height: uniform(P.height),
      grow: uniform(0), tail: uniform(0), fade: uniform(1), width: uniform(1), decal: uniform(0),
      cCore: uniform(new THREE.Color(P.core)), cMid: uniform(new THREE.Color(P.mid)),
      cEdge: uniform(new THREE.Color(P.edge)), cRing: uniform(new THREE.Color(P.ringColor)),
    };

    // ---- the funnel surface ---------------------------------------------------------------
    const t = positionGeometry.x.add(0.5); // 0 at the foot, 1 at the crown
    const ang = positionGeometry.y.add(0.5).mul(TAU); // full wrap; cos/sin close the seam for free
    const scroll = time.mul(P.flow);
    const spin = time.mul(P.spin); // the ONE rotation-rate value; spray() below reuses P.spin verbatim

    // The silhouette breathes as a travelling wave in angle+spin, so it LOOKS like it spins even
    // though `nrm` (below) never depends on time — see the docblock's note on why that matters.
    const wob = mx_noise_float(vec3(
      cos(ang.add(spin)).mul(P.bands), sin(ang.add(spin)).mul(P.bands), t.mul(P.noiseScale).sub(scroll).add(u.seed),
    ));
    const sway = t.mul(P.wander); // the crown sways; the foot is anchored to the ring
    const dA = mx_noise_float(vec3(t.mul(1.6).sub(scroll.mul(0.25)), u.seed, 0));
    const dB = mx_noise_float(vec3(t.mul(1.6).sub(scroll.mul(0.25)), u.seed.add(9.1), 3.3));
    const centreLocal = vec3(dA.mul(sway), u.height.mul(t), dB.mul(sway));

    // GPU radius-at-height; funnelRadiusAt() at module scope is the CPU mirror of this exact line.
    const radius = mix(float(P.radiusNear), float(P.radiusFar), pow(t, P.radiusCurve))
      .mul(u.width).mul(wob.mul(P.wobble).add(1));
    const nrm = vec3(cos(ang), 0, sin(ang)); // outward direction; never itself time-dependent
    const surface = u.base.add(centreLocal).add(nrm.mul(radius));

    const vT = varying(t, 'vVortexT');
    const vAng = varying(ang, 'vVortexAng');
    const vFacing = varying(abs(dot(normalize(cameraPosition.sub(surface)), nrm)), 'vVortexFacing');

    const facing = clamp(vFacing, 0, 1);
    const axisward = pow(facing, P.coreSharp);
    const rim = pow(facing.oneMinus(), P.edgePower);
    const flowN = mx_noise_float(vec3(
      vT.mul(P.streakScale).sub(scroll),
      cos(vAng.add(spin)).mul(P.streakBands), sin(vAng.add(spin)).mul(P.streakBands).add(u.seed),
    ));
    const streak = smoothstep(P.streakSharp, 0.98, flowN).mul(P.streak);
    const spark = smoothstep(0.86, 1, mx_noise_float(vec3(
      vT.mul(P.streakScale * 3).sub(scroll.mul(1.7)),
      cos(vAng.add(spin.mul(1.3))).mul(P.streakBands * 2.5), sin(vAng.add(spin.mul(1.3))).mul(P.streakBands * 2.5).add(u.seed),
    ))).mul(P.sparkle);
    const baseGlowT = smoothstep(0, P.baseLen, vT).oneMinus(); // glow where the funnel meets the ground

    const heat = clamp(axisward.mul(0.7).add(pow(vT.oneMinus(), 1.6).mul(0.5)).add(streak.mul(0.6)), 0, 1);
    const tubeColor = mix(u.cEdge, u.cMid, smoothstep(0, 0.55, heat))
      .mix(u.cCore, smoothstep(0.55, 1, heat))
      .add(u.cCore.mul(baseGlowT.mul(P.baseGlow).add(spark.mul(1.2))));

    // Spin-up and shutdown are both clips, never a scale — the crown-clip mirrors stream's uProgress,
    // the foot-clip mirrors stream's uTail eating the mouth end.
    const drawn = smoothstep(u.grow.sub(P.tipSoft), u.grow, vT).oneMinus()
      .mul(smoothstep(u.tail, u.tail.add(P.tipSoft), vT));
    const tubeAlpha = clamp(
      rim.mul(P.rim).add(axisward.mul(P.fill)).add(streak.mul(P.streakAlpha)).add(spark),
      0, 1,
    ).mul(drawn).mul(u.fade).mul(P.opacity);

    const funnelGeo = new THREE.PlaneGeometry(1, 1, O.heightSegs, O.radialSegs);
    const funnelMat = new NODES.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    funnelMat.blending = P.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    funnelMat.toneMapped = false;
    funnelMat.positionNode = surface;
    funnelMat.colorNode = tubeColor;
    funnelMat.opacityNode = tubeAlpha;
    const funnel = new THREE.Mesh(funnelGeo, funnelMat);
    funnel.frustumCulled = false;
    funnel.matrixAutoUpdate = false;

    // ---- foot collar ring, from buildRing so it shares the funnel's own base radius --------
    const footRing = buildRing({ segments: O.radialSegs, radius: P.radiusNear, terrainHeight: () => 0 });
    const ringGeo = buildRingBandGeometry(THREE, footRing, P.ringWidth);
    const ringMat = new NODES.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    ringMat.toneMapped = false;
    ringMat.blending = P.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    {
      const aAcross = attribute('aAcross', 'float');
      const aU = attribute('aU', 'float');
      const fall = abs(aAcross).oneMinus().max(0).pow(1.4);
      const mottle = mx_noise_float(vec3(aU.mul(9), u.seed, 0)).mul(0.5).add(0.6);
      const shimmer = cos(aU.mul(TAU * 3).add(spin)).mul(0.15).add(0.85);
      ringMat.colorNode = u.cRing.mul(mottle).mul(shimmer);
      ringMat.opacityNode = fall.mul(mottle).mul(u.decal).mul(P.ringOpacity);
    }
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.frustumCulled = false;

    // ---- ground decal, from move-parts ------------------------------------------------------
    const decalPart = makeGroundDecal({ THREE, TSL, NODES, radius: 1, color: P.decal, mottle: 7, seed: key.length });
    decalPart.mesh.frustumCulled = false;

    // ---- orbiting debris / spray, from move-parts -------------------------------------------
    const particles = createSpriteParticles({
      THREE, TSL, NODES, cap: O.puffCap, colorA: P.puffA, colorB: P.puffB, aspect: P.puffAspect,
      gravity: P.puffGravity, drag: P.puffDrag, additive: P.additive,
    });
    particles.mesh.frustumCulled = false;

    const group = new THREE.Group();
    group.add(funnel, ring, decalPart.mesh, particles.mesh);

    return {
      key, P, group, funnel, ring, decalPart, particles, u,
      geometries: [funnelGeo, ringGeo],
      materials: [funnelMat, ringMat],
    };
  }

  function acquireKit(key) {
    const pool = pools.get(key);
    const kit = pool && pool.length ? pool.pop() : buildKit(key);
    kit.particles.reset();
    kit.u.grow.value = 0; kit.u.tail.value = 0; kit.u.fade.value = 1; kit.u.decal.value = 0;
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
    for (const g of kit.geometries) g.dispose();
    for (const m of kit.materials) m.dispose();
    kit.decalPart.dispose();
    kit.particles.dispose();
  }

  function cast({ line, seed = 1, palette = 'gale', power = 1, sourceY = 0.6, targetY = 0.6 }) {
    const key = PALETTES[palette] ? palette : 'gale';
    const kit = acquireKit(key);
    const P = kit.P;
    const rnd = mulberry32(seed >>> 0);
    const u = kit.u;
    const pw = Math.max(0.2, power);

    // sourceY (the caster's own height) is never read: nothing travels from the caster, the funnel
    // simply grows in place at the target, so only the line's target end has anything to say here.
    const tx = line.target.x, tz = line.target.z;
    const gy = terrainHeight(tx, tz);
    const groundY = Number.isFinite(gy) ? gy : line.target.y;
    u.base.value.set(tx, groundY, tz);
    u.seed.value = rnd() * 37;
    u.width.value = O.widthScale * (0.75 + 0.4 * pw);
    // targetY sizes the funnel tall enough to visually engulf whatever stands at the target.
    u.height.value = Math.max(P.height, targetY * 2.2) * (0.85 + 0.3 * pw);
    u.grow.value = 0; u.tail.value = 0; u.fade.value = 1; u.decal.value = 0;

    kit.group.position.set(0, 0, 0);
    kit.ring.position.set(tx, groundY, tz);
    kit.ring.scale.setScalar(u.width.value); // matches the funnel's own foot radius exactly
    kit.decalPart.mesh.position.set(tx, groundY + 0.03, tz);
    kit.decalPart.mesh.scale.setScalar(O.decalScale * P.radiusFar * u.width.value);
    scene.add(kit.group);

    const light = P.lightIntensity > 0 && lights ? lights.acquire() : null;
    if (light) {
      light.color.set(P.light); light.distance = P.lightDistance * pw; light.intensity = 0;
      light.position.set(tx, groundY + u.height.value * 0.4, tz);
    }

    const emitter = createRateEmitter(64);
    let pendingImpact = false, doneFired = false, released = false;

    /** Emission point on the real cone surface, in world space, via the exported CPU mirror above. */
    function funnelPointAt(tt, angle) {
      const r = funnelRadiusAt(P, u.width.value, tt);
      return {
        x: tx + Math.cos(angle) * r,
        y: groundY + funnelHeightAt(u.height.value, tt),
        z: tz + Math.sin(angle) * r,
      };
    }

    function spray(dt, rate, now) {
      const n = emitter.take(rate * pw, dt);
      for (let i = 0; i < n; i++) {
        const tt = 0.15 + rnd() * 0.8;
        const angle = rnd() * TAU + now * P.spin; // same P.spin the shader's `spin` node uses
        const p = funnelPointAt(tt, angle);
        const tangent = angle + Math.PI / 2;
        const speed = P.puffSpeed * (0.6 + rnd() * 0.7);
        const out = 0.15 + rnd() * 0.3;
        particles.emit(
          p.x, p.y, p.z,
          Math.cos(tangent) * speed + Math.cos(angle) * speed * out,
          (rnd() - 0.5) * 0.6,
          Math.sin(tangent) * speed + Math.sin(angle) * speed * out,
          P.puffSize * pw * (0.7 + rnd() * 0.6),
          P.puffLife * (0.7 + rnd() * 0.6),
        );
      }
      if (light) light.position.set(tx, groundY + u.height.value * 0.4, tz);
    }
    const particles = kit.particles;

    const machine = createPhaseMachine({
      travelSpeed: O.travelSpeed, impactTime: O.impactTime, fadeTime: O.fadeTime,
      onTravel(dt, now) {
        u.grow.value = this.u; // spin up from the ground as a clip, never a scale
        spray(dt, P.puffRate * 0.4 * this.u, now);
        if (light) light.intensity = P.lightIntensity * pw * saturate(this.u * 2) * (1 + P.flicker * Math.sin(now * 23));
      },
      onImpact() {
        u.grow.value = 1;
        pendingImpact = true;
      },
      onFade(dt, t, now) {
        if (t <= 1) {
          // IMPACT: the standing state a held vortex has to hold indefinitely.
          u.tail.value = 0; u.fade.value = 1;
          u.decal.value = saturate(t * 3);
          spray(dt, P.puffRate, now);
          if (light) light.intensity = P.lightIntensity * pw * (1 + P.flicker * Math.sin(now * 23));
        } else {
          const k = saturate(t - 1);
          u.tail.value = Easing.inQuad(k);
          u.fade.value = 1 - k * k;
          u.decal.value = 1 - k;
          spray(dt, P.puffRate * (1 - k) * 0.6, now);
          if (light) light.intensity = P.lightIntensity * pw * (1 - k);
        }
      },
    });
    machine.spawn(line);

    return {
      group: kit.group, machine, onImpact: null, onDone: null,
      update(dt, now = 0) {
        const alive = machine.update(dt, now);
        particles.step(dt);
        particles.setFade(u.fade.value);
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
