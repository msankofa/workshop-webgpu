/**
 * fx-orb.js — Shadow Ball, Energy Ball, Sludge Bomb, Focus Blast, Aura Sphere, Will-O-Wisp, and every
 * other move whose whole cast is "one glowing ball flies from the mouth to the target." Stream draws a
 * hose that exists everywhere along its line at once; an orb is the opposite shape, a single point that
 * exists in exactly one place, so this module trades the tube's world-space vertex placement for a plain
 * Object3D transform (`orbPivot`) that is moved once a frame in JS, the way fx-bolt already moves its
 * muzzle/impact flash spheres with `mesh.position.copy(at)`. That choice matters for the CPU/GPU-mirror
 * trap the other move modules have to manage: because the shell materials below only ever displace
 * vertices in *local* unit-sphere space (`positionLocal.add(normalLocal.mul(bump))`, lifted straight from
 * stream's impact burst dome), there is no second, shader-side copy of the flight curve to keep in sync.
 * `flightPos()`/`tangentAt()` compute the orb's world position exactly once per frame and that same
 * number drives the mesh transform, the pooled light and the trail emitter — three readers, one writer,
 * not two independent implementations of the same math. The trap would reappear the moment a future perf
 * pass batches many orbs into one `InstancedMesh` and moves this per-instance placement into a uniform
 * array read by the shader; at that point the flight formula would need to exist on both sides again.
 *
 * Three layers, arrival order:
 *
 *   1. The core: a noise-displaced icosahedron, built exactly like stream's burst dome — a fresnel term
 *      from `positionWorld`/`normalWorld` (deliberately *not* reused from the vertex-stage bump, so no
 *      `varying()` promotion is needed, matching how stream's own burst dome keeps its two noise/fresnel
 *      terms independent) mixes core color at the centre into edge color at the silhouette. A second,
 *      larger, dimmer shell reuses the same recipe as a halo — for `shadow` it is non-additive and dark,
 *      which is what actually reads as "a bright churn inside a dark rim," since additive blending alone
 *      cannot produce a dark edge. `aura` and its `zapcannon` recolor add a spinning torus for the ringed
 *      look those two moves are known for. The whole rig tumbles by rotating `orbPivot`, not by animating
 *      the noise field, per the design note about a spinning core reading better than a frozen one.
 *   2. A trail: `createSpriteParticles` from move-parts, emitted every travel frame at the orb's current
 *      position with a small velocity opposite the flight tangent (computed by finite difference on
 *      `flightPos`, so a lobbed arc's trail sprays backward along the true 3D path, not just the flat
 *      ground direction).
 *   3. Arrival: the same noise-displaced-dome-plus-fresnel recipe scaled up for a burst, `makeGroundDecal`
 *      for the splash/scorch/puddle, and a heavier radial pulse through the same trail pool rather than a
 *      second particle system — the "debris or spray burst" the brief offers a choice between. Sludge and
 *      its Mud Bomb recolor lean on this with a strong downward `trailGravity` so the burst reads as heavy
 *      drips rather than smoke; a follow-up that wants chunky flying debris would reach for move-parts'
 *      `createDebrisPool`, deliberately not used here because its `emit()` closes over an `rnd()` supplied
 *      once at construction, and this module's kits are pooled *across* casts with different seeds — a
 *      debris pool built at kit time would replay the first cast's randomness on every later cast of the
 *      same palette. Building one fresh per cast would fix that at the cost of a geometry/material churn
 *      this module chooses not to pay for a cosmetic upgrade.
 *
 * One pooled light rides the orb (position updated every travel frame, released on dispose); moves that
 * want no light at all just set `lightIntensity: 0` in their palette, matching stream's `water`.
 *
 * `easeIn` on the phase machine — a slow start before the orb's speed ramps up — is exposed per palette
 * as `chargeIn` rather than hard-coded, because a fixed easeIn baked into every cast is exactly the
 * complaint raised against fx-bolt.js. `aura` sets it high enough to read as a charge-up beat (Focus
 * Blast, Aura Sphere); its `zapcannon` recolor sets it higher still.
 */

import { createPhaseMachine, mulberry32, Easing, saturate, createRateEmitter } from './move-core.js';
import { createSpriteParticles, makeGroundDecal, makeFlashSphere, popFlash } from './move-parts.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;

/** Named looks. Every field is overridable through `options.palettes[name]` at factory level. */
export const PALETTES = {
  /** Shadow Ball: a bright roiling churn behind a dark, almost-opaque rim. */
  shadow: {
    core: '#caa8ff', edge: '#3a1a5a', halo: '#0a0410',
    additive: true, haloAdditive: false,
    opacityBase: 0.55, opacityRim: 0.55, haloOpacityBase: 0.85, haloOpacityRim: 0.05,
    size: 0.34, haloScale: 1.9, rimPower: 2.4,
    noiseScale: 3.2, noiseAmt: 0.16, roil: 1.4, spin: 2.6,
    ring: false,
    arc: 0.35, chargeIn: 0.08,
    trailColorA: '#8a3fe0', trailColorB: '#0a0414', trailRate: 42, trailSize: 0.24, trailLife: 0.55,
    trailGravity: -0.6, trailDrag: 1.0, trailSpread: 1.0, trailSpeed: 3.2, trailAspect: [1, 1],
    burst: '#8a3fe0', burstScale: 1.6, burstNoise: 0.3, burstFlatten: 1,
    hasDecal: true, decalColor: '#0d0414', decalOpacity: 0.6, decalRadius: 1.0,
    light: '#7a2fd0', lightIntensity: 14, lightDistance: 10, flickerAmt: 0.25, flickerSpeed: 20,
  },
  /** Energy Ball: smooth, bright, green-white, almost no noise. */
  verdant: {
    core: '#eaffe0', edge: '#2c6e1a', halo: '#4fd82a',
    additive: true, haloAdditive: true,
    opacityBase: 0.6, opacityRim: 0.4, haloOpacityBase: 0.15, haloOpacityRim: 0.25,
    size: 0.30, haloScale: 1.7, rimPower: 1.6,
    noiseScale: 1.6, noiseAmt: 0.04, roil: 0.4, spin: 1.8,
    ring: false,
    arc: 0.2, chargeIn: 0.08,
    trailColorA: '#d8ffb0', trailColorB: '#1c5c12', trailRate: 55, trailSize: 0.18, trailLife: 0.4,
    trailGravity: 0, trailDrag: 1.5, trailSpread: 0.6, trailSpeed: 2.8, trailAspect: [1, 1],
    burst: '#bdf28a', burstScale: 1.5, burstNoise: 0.18, burstFlatten: 1,
    hasDecal: true, decalColor: '#1c3c10', decalOpacity: 0.4, decalRadius: 0.85,
    light: '#7be04a', lightIntensity: 12, lightDistance: 10, flickerAmt: 0.1, flickerSpeed: 10,
  },
  /** Sludge Bomb: opaque, heavy, a big lob and a dripping trail landing in a strong puddle. */
  sludge: {
    core: '#7a9c3a', edge: '#241a30', halo: '#3a2a44',
    additive: false, haloAdditive: false,
    opacityBase: 0.92, opacityRim: 0.08, haloOpacityBase: 0.25, haloOpacityRim: 0.1,
    size: 0.42, haloScale: 1.5, rimPower: 1.1,
    noiseScale: 2.4, noiseAmt: 0.20, roil: 0.6, spin: 1.0,
    ring: false,
    arc: 1.1, chargeIn: 0.08,
    trailColorA: '#a8c85a', trailColorB: '#241a10', trailRate: 38, trailSize: 0.30, trailLife: 0.65,
    trailGravity: -13, trailDrag: 0.4, trailSpread: 0.7, trailSpeed: 2.2, trailAspect: [0.8, 1.3],
    burst: '#8fae3a', burstScale: 2.0, burstNoise: 0.35, burstFlatten: 0.5,
    hasDecal: true, decalColor: '#241a08', decalOpacity: 0.85, decalRadius: 1.6,
    light: '#7a9c3a', lightIntensity: 6, lightDistance: 8, flickerAmt: 0, flickerSpeed: 0,
  },
  /** Focus Blast / Aura Sphere: pale blue, clean, ringed, a low trail and a charge-up beat. */
  aura: {
    core: '#eaf6ff', edge: '#2a5580', halo: '#bfe0ff',
    additive: true, haloAdditive: true,
    opacityBase: 0.5, opacityRim: 0.45, haloOpacityBase: 0.12, haloOpacityRim: 0.2,
    size: 0.30, haloScale: 1.8, rimPower: 2.0,
    noiseScale: 1.2, noiseAmt: 0.025, roil: 0.3, spin: 2.2,
    ring: true, ringColor: '#dff0ff', ringScale: 2.3,
    arc: 0.5, chargeIn: 0.35,
    trailColorA: '#eaf6ff', trailColorB: '#4a8fd0', trailRate: 16, trailSize: 0.14, trailLife: 0.35,
    trailGravity: 0, trailDrag: 1.7, trailSpread: 0.35, trailSpeed: 2.0, trailAspect: [1, 1],
    burst: '#dff0ff', burstScale: 1.4, burstNoise: 0.12, burstFlatten: 1,
    hasDecal: true, decalColor: '#20405a', decalOpacity: 0.35, decalRadius: 0.75,
    light: '#a8d8ff', lightIntensity: 14, lightDistance: 12, flickerAmt: 0.05, flickerSpeed: 8,
  },
  /** Will-O-Wisp: a small, flickering, slow blue-white flame lobbed high, no scorch on the ground. */
  ember: {
    core: '#eaf6ff', edge: '#123a5a', halo: '#3a6a8f',
    additive: true, haloAdditive: true,
    opacityBase: 0.45, opacityRim: 0.5, haloOpacityBase: 0.15, haloOpacityRim: 0.25,
    size: 0.15, haloScale: 1.9, rimPower: 1.8,
    noiseScale: 4.5, noiseAmt: 0.30, roil: 3.2, spin: 4.0,
    ring: false,
    arc: 1.5, chargeIn: 0.08,
    trailColorA: '#cdeaff', trailColorB: '#0d2038', trailRate: 48, trailSize: 0.09, trailLife: 0.28,
    trailGravity: 4.5, trailDrag: 2.2, trailSpread: 0.45, trailSpeed: 1.6, trailAspect: [0.7, 1.4],
    burst: '#8fd8ff', burstScale: 0.8, burstNoise: 0.22, burstFlatten: 1,
    hasDecal: false, decalColor: '#000000', decalOpacity: 0, decalRadius: 0,
    light: '#8fd8ff', lightIntensity: 9, lightDistance: 7, flickerAmt: 0.5, flickerSpeed: 26,
  },
};

// Electro Ball, Mud Bomb, Weather Ball and Zap Cannon are each one of the five looks above with a colour
// (and, for Zap Cannon, a size and charge beat) change — see the module docblock's arrival-layer note and
// the design brief's own instruction to reach for a recolor before a new structure.
PALETTES.electro = { // Electro Ball: shadow's roiling additive churn read as crackling yellow charge.
  ...PALETTES.shadow, core: '#fff8c0', edge: '#5a4200', halo: '#241a00',
  trailColorA: '#fff2a0', trailColorB: '#4a3800', burst: '#ffe14a',
  decalColor: '#241a00', light: '#ffe14a',
};
PALETTES.mud = { // Mud Bomb: sludge's opaque heavy lob and dripping trail, recoloured brown.
  ...PALETTES.sludge, core: '#8a6a3a', edge: '#1a1208', halo: '#3a281a',
  trailColorA: '#a88a5a', trailColorB: '#2a1a0a', burst: '#7a5a2a',
  decalColor: '#2a1a0a', light: '#7a5a2a',
};
PALETTES.weather = { // Weather Ball (normal form): verdant's smooth bright shell, recoloured neutral.
  ...PALETTES.verdant, core: '#ffffff', edge: '#5a5a5a', halo: '#cfcfcf',
  trailColorA: '#ffffff', trailColorB: '#8a8a8a', burst: '#eaeaea',
  decalColor: '#4a4a4a', light: '#d8d8d8',
};
PALETTES.zapcannon = { // Zap Cannon: aura's clean ringed sphere, recoloured electric and charged longer.
  ...PALETTES.aura, core: '#fffbe0', edge: '#5a4200', halo: '#ffe14a', ringColor: '#fff8c0',
  size: 0.46, chargeIn: 0.55,
  trailColorA: '#fff2a0', trailColorB: '#5a4200', burst: '#ffe14a',
  decalColor: '#241a00', light: '#ffe14a',
};

const DEFAULTS = {
  travelSpeed: 16, impactTime: 0.5, fadeTime: 0.45, chargeIn: 0.08,
  coreDetail: 3, haloDetail: 1, trailCap: 220, burstTime: 0.35, poolPerPalette: 3,
  popTime: 0.12, orbFadeTime: 0.15, ringTube: 0.09, sizeScale: 1,
};

export function createOrbFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, terrainHeight = () => 0, lights } = deps;
  const O = { ...DEFAULTS, ...options };
  const {
    uniform, positionLocal, normalLocal, normalWorld, positionWorld, cameraPosition,
    mix, clamp, pow, abs, dot, normalize, vec3, float, mx_noise_float, time,
  } = TSL;

  const pools = new Map();
  const liveKits = new Set();

  /** Palette-scoped tunables: the palette table, then anything the caller overrode. */
  function paramsFor(name) {
    const base = PALETTES[name] || PALETTES.shadow;
    const over = options.palettes && options.palettes[name];
    return { ...base, ...(over || {}) };
  }

  // Shared unit geometry: every kit's shells and ring are the same base shape, only scale differs.
  const coreGeo = new THREE.IcosahedronGeometry(1, O.coreDetail);
  const haloGeo = new THREE.IcosahedronGeometry(1, O.haloDetail);
  const burstGeo = new THREE.SphereGeometry(1, 22, 14);
  const ringGeo = new THREE.TorusGeometry(1, O.ringTube, 8, 32);
  const sharedGeometries = [coreGeo, haloGeo, burstGeo, ringGeo];

  /**
   * A noise-displaced shell, modelled closely on fx-stream's impact burst dome: the vertex bump comes
   * from `positionLocal` alone (vertex-stage only, never reused in the fragment stage, so no `varying()`
   * promotion is needed) and the fresnel rim comes from `positionWorld`/`normalWorld` alone (already
   * fragment-safe built-ins), exactly as stream keeps its own bump and its own `bRim` independent.
   */
  function buildShellMaterial(P, u, isHalo) {
    const additive = isHalo ? P.haloAdditive : P.additive;
    const opBase = isHalo ? P.haloOpacityBase : P.opacityBase;
    const opRim = isHalo ? P.haloOpacityRim : P.opacityRim;
    const noiseAmt = isHalo ? P.noiseAmt * 0.4 : P.noiseAmt;

    const mat = new NODES.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    mat.toneMapped = false;

    const bump = mx_noise_float(positionLocal.mul(P.noiseScale).add(vec3(0, u.seed, time.mul(P.roil)))).mul(noiseAmt);
    mat.positionNode = positionLocal.add(normalLocal.mul(bump));

    const rim = pow(abs(dot(normalize(cameraPosition.sub(positionWorld)), normalWorld)).oneMinus(), P.rimPower);
    mat.colorNode = isHalo ? u.cHalo : mix(u.cEdge, u.cCore, rim.oneMinus());
    mat.opacityNode = clamp(float(opBase).add(rim.mul(opRim)), 0, 1).mul(u.fade).mul(u.flicker);
    return mat;
  }

  function buildKit(key) {
    const P = paramsFor(key);
    const u = {
      seed: uniform(0), fade: uniform(1), flicker: uniform(1), burst: uniform(0),
      cCore: uniform(new THREE.Color(P.core)), cEdge: uniform(new THREE.Color(P.edge)),
      cHalo: uniform(new THREE.Color(P.halo)), cBurst: uniform(new THREE.Color(P.burst)),
    };

    const coreMat = buildShellMaterial(P, u, false);
    const haloMat = buildShellMaterial(P, u, true);
    const core = new THREE.Mesh(coreGeo, coreMat);
    const halo = new THREE.Mesh(haloGeo, haloMat);
    core.frustumCulled = false; halo.frustumCulled = false;

    const orbPivot = new THREE.Group();
    orbPivot.add(core, halo);

    let ring = null;
    if (P.ring) {
      const ringMat = new NODES.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
      ringMat.blending = THREE.AdditiveBlending;
      ringMat.toneMapped = false;
      ringMat.color = new THREE.Color(P.ringColor);
      ringMat.opacity = 0.7;
      ring = new THREE.Mesh(ringGeo, ringMat);
      ring.frustumCulled = false;
      orbPivot.add(ring);
    }

    // Arrival dome — the same recipe as the shells above, sized up for a burst (fx-stream's own recipe).
    const burstMat = new NODES.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    burstMat.blending = THREE.AdditiveBlending;
    burstMat.toneMapped = false;
    const burstBump = mx_noise_float(positionLocal.mul(2.4).add(u.seed)).mul(P.burstNoise);
    burstMat.positionNode = positionLocal.add(normalLocal.mul(burstBump));
    const bRim = pow(abs(dot(normalize(cameraPosition.sub(positionWorld)), normalWorld)).oneMinus(), 1.6);
    burstMat.colorNode = mix(u.cBurst, u.cCore, bRim.oneMinus());
    burstMat.opacityNode = clamp(bRim.mul(0.8).add(0.25), 0, 1).mul(u.burst);
    const burst = new THREE.Mesh(burstGeo, burstMat);
    burst.frustumCulled = false;

    const decal = P.hasDecal ? makeGroundDecal({ THREE, TSL, NODES, radius: 1, color: P.decalColor, seed: 0 }) : null;
    if (decal) decal.setOpacity(0);

    const muzzle = makeFlashSphere({ THREE, NODES, color: P.core });

    const trail = createSpriteParticles({
      THREE, TSL, NODES, cap: O.trailCap, colorA: P.trailColorA, colorB: P.trailColorB,
      aspect: P.trailAspect, gravity: P.trailGravity, drag: P.trailDrag, additive: P.additive,
    });

    const group = new THREE.Group();
    group.add(orbPivot, trail.mesh, burst, muzzle);
    if (decal) group.add(decal.mesh);

    return {
      // Shells/ring/burst share the module-level geometries (`sharedGeometries`); a kit only owns materials
      // plus the decal and muzzle, which build their own geometry via move-parts and dispose themselves.
      key, P, u, group, orbPivot, core, halo, ring, burst, decal, muzzle, trail,
      materials: [coreMat, haloMat, ...(ring ? [ring.material] : []), burstMat],
    };
  }

  function acquireKit(key) {
    const pool = pools.get(key);
    const kit = pool && pool.length ? pool.pop() : buildKit(key);
    kit.trail.reset();
    kit.u.fade.value = 1; kit.u.flicker.value = 1; kit.u.burst.value = 0;
    kit.orbPivot.visible = true; kit.orbPivot.rotation.set(0, 0, 0); kit.orbPivot.scale.setScalar(0.001);
    kit.burst.visible = false;
    if (kit.decal) { kit.decal.setOpacity(0); kit.decal.mesh.visible = false; }
    kit.muzzle.visible = false;
    if (kit.ring) kit.ring.rotation.set(0, 0, 0);
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
    for (const m of kit.materials) m.dispose();
    if (kit.decal) kit.decal.dispose();
    kit.muzzle.material.dispose();
    kit.trail.dispose();
  }

  function cast({ line, seed = 1, palette = 'shadow', power = 1, sourceY = 0.9, targetY = 0.7 }) {
    const key = PALETTES[palette] ? palette : 'shadow';
    const kit = acquireKit(key);
    const P = kit.P, u = kit.u;
    const rnd = mulberry32(seed >>> 0);
    const pw = Math.max(0.2, power);

    u.seed.value = rnd() * 41;
    u.cCore.value.set(P.core); u.cEdge.value.set(P.edge); u.cHalo.value.set(P.halo);
    u.cBurst.value.set(P.burst);

    const size = P.size * pw;
    kit.core.scale.setScalar(size);
    kit.halo.scale.setScalar(size * P.haloScale);
    if (kit.ring) kit.ring.scale.setScalar(size * P.ringScale);

    kit.group.position.set(0, 0, 0);
    scene.add(kit.group);

    // Single source of truth for where the orb is: the ground line's XZ/terrain-Y plus a height that
    // interpolates mouth-height to body-height, plus an optional parabolic lob. The core/halo shells
    // never re-derive this in the shader, so there is nothing here to fall out of sync with a GPU copy.
    const _pos = { x: 0, y: 0, z: 0 }, _a = { x: 0, y: 0, z: 0 }, _b = { x: 0, y: 0, z: 0 }, _tan = { x: 0, y: 0, z: 0 };
    function heightAt(uu) { return lerp(sourceY, targetY, uu) + P.arc * pw * 4 * uu * (1 - uu); }
    function flightPos(uu, out) { line.pointAt(uu, out); out.y += heightAt(uu); return out; }
    function tangentAt(uu, out) {
      const e = 0.015;
      flightPos(Math.max(0, uu - e), _a); flightPos(Math.min(1, uu + e), _b);
      out.x = _b.x - _a.x; out.y = _b.y - _a.y; out.z = _b.z - _a.z;
      const len = Math.hypot(out.x, out.y, out.z) || 1;
      out.x /= len; out.y /= len; out.z /= len;
      return out;
    }

    function flicker(now, phase) {
      if (!P.flickerAmt) return 1;
      return 1 - P.flickerAmt + P.flickerAmt * Math.sin(now * P.flickerSpeed + phase);
    }
    const flickerPhase = rnd() * TAU;

    const light = P.lightIntensity > 0 && lights ? lights.acquire() : null;
    if (light) { light.color.set(P.light); light.distance = P.lightDistance * pw; light.intensity = 0; }

    const emitter = createRateEmitter(64);
    let spawnAge = 0, impactFadeAge = -1, burstAge = 0, muzzleAge = -1;
    const muzzleLife = Math.max(0.18, (P.chargeIn ?? O.chargeIn) * 1.3);
    let pendingImpact = false, doneFired = false, released = false;

    function spray(uu, dt, rate) {
      flightPos(uu, _pos); tangentAt(uu, _tan);
      const n = emitter.take(rate * pw, dt);
      for (let i = 0; i < n; i++) {
        const back = 0.3 + rnd() * 0.5;
        const jx = (rnd() - 0.5) * P.trailSpread, jy = (rnd() - 0.5) * P.trailSpread * 0.6, jz = (rnd() - 0.5) * P.trailSpread;
        kit.trail.emit(
          _pos.x - _tan.x * 0.05, _pos.y - _tan.y * 0.05, _pos.z - _tan.z * 0.05,
          _tan.x * -P.trailSpeed * back + jx, _tan.y * -P.trailSpeed * back + jy, _tan.z * -P.trailSpeed * back + jz,
          P.trailSize * (0.7 + rnd() * 0.6) * pw, P.trailLife * (0.7 + rnd() * 0.6),
        );
      }
    }

    const machine = createPhaseMachine({
      travelSpeed: O.travelSpeed, impactTime: O.impactTime, fadeTime: O.fadeTime,
      easeIn: P.chargeIn ?? O.chargeIn,
      onSpawn() {
        flightPos(0, _pos);
        kit.muzzle.position.set(_pos.x, _pos.y, _pos.z);
        muzzleAge = 0;
        if (light) light.position.set(_pos.x, _pos.y, _pos.z);
      },
      onTravel(dt, t) {
        spawnAge += dt;
        const pop = spawnAge < O.popTime ? Easing.outBack(saturate(spawnAge / O.popTime)) : 1;
        kit.orbPivot.scale.setScalar(Math.max(0.001, pop));
        kit.orbPivot.rotation.y += P.spin * dt;
        kit.orbPivot.rotation.x += P.spin * 0.6 * dt;
        if (kit.ring) kit.ring.rotation.z += P.spin * 1.4 * dt;

        flightPos(this.u, _pos);
        kit.orbPivot.position.set(_pos.x, _pos.y, _pos.z);
        u.flicker.value = flicker(t, flickerPhase);
        spray(this.u, dt, P.trailRate);
        if (light) {
          light.position.set(_pos.x, _pos.y, _pos.z);
          const ease = saturate(this.u * 3);
          light.intensity = P.lightIntensity * pw * ease * flicker(t, flickerPhase);
        }
      },
      onImpact() {
        flightPos(1, _pos);
        pendingImpact = true;
        impactFadeAge = 0; burstAge = 0;
        kit.burst.visible = true;
        kit.burst.position.set(_pos.x, _pos.y, _pos.z);
        kit.burst.scale.setScalar(0.001);
        if (kit.decal) {
          const gy = terrainHeight(_pos.x, _pos.z);
          kit.decal.mesh.position.set(_pos.x, (Number.isFinite(gy) ? gy : _pos.y) + 0.03, _pos.z);
          kit.decal.mesh.scale.setScalar(P.decalRadius * pw);
          kit.decal.mesh.visible = true;
        }
        // The impact spray reuses the trail's own sprite pool at a heavier rate instead of a second
        // particle system — the "spray burst" half of the brief's debris-or-spray choice.
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * TAU + rnd() * 0.5;
          const rise = P.trailGravity < 0 ? 0.3 + rnd() * 0.6 : 0.7 + rnd() * 0.7;
          kit.trail.emit(
            _pos.x, _pos.y, _pos.z,
            Math.cos(a) * P.trailSpeed * 0.9, rise * P.trailSpeed * 0.6, Math.sin(a) * P.trailSpeed * 0.9,
            P.trailSize * pw * 1.2, P.trailLife * 1.3,
          );
        }
      },
      onFade(dt, t, now) {
        impactFadeAge += dt;
        u.fade.value = 1 - saturate(impactFadeAge / O.orbFadeTime);
        if (u.fade.value <= 0.001) kit.orbPivot.visible = false;

        burstAge += dt;
        const bt = saturate(burstAge / O.burstTime);
        const grow = Easing.outCubic(bt);
        const bs = P.burstScale * pw * grow + 0.02;
        kit.burst.scale.set(bs, bs * P.burstFlatten, bs);
        u.burst.value = (1 - bt) * (1 - bt);

        const decalK = t <= 1 ? saturate(t * 4) : 1 - saturate(t - 1);
        if (kit.decal) kit.decal.setOpacity(P.decalOpacity * decalK);

        if (light) light.intensity = P.lightIntensity * pw * Math.max(0, 1 - t) * flicker(now, flickerPhase);
      },
    });
    machine.spawn(line);

    return {
      group: kit.group, machine, onImpact: null, onDone: null,
      update(dt, now) {
        const alive = machine.update(dt, now);
        kit.trail.step(dt);
        if (muzzleAge >= 0) { muzzleAge += dt; popFlash(kit.muzzle, kit.muzzle.position.x, kit.muzzle.position.y, kit.muzzle.position.z, P.size * pw * 2.2, muzzleAge, muzzleLife); }
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
    for (const g of sharedGeometries) g.dispose();
  }

  return { cast, dispose };
}

export default createOrbFx;
