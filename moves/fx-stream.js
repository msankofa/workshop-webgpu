/**
 * fx-stream.js — the breath weapons. Flamethrower, Water Gun, Dragon Breath, Ice Beam.
 *
 * A stream is not a projectile: it is a hose the attacker holds open. That single fact drives every
 * decision here. The tube is built once as a unit (t, angle) grid and *placed* by the vertex shader
 * against `mix(start, end, t)` — the trick borrowed from LinearAbiltyCastingThreeJS/BeamMaterial.js,
 * where `beamRadius(t)`/`beamAxis(t)` are the only geometry and every pass hangs off them. Because
 * the shape is a pure function of t, the travelling front is a *clip* (`uProgress`) rather than a
 * scale, so the column's texture never stretches as it reaches out; and shutting the stream off is
 * the mirror image, a second clip (`uTail`) eating it from the mouth end while the far gas keeps
 * going. Nothing about the tube's silhouette is CPU work.
 *
 * Three layers, in the order they read:
 *
 *   1. The column. Cone radius, radial noise scrolling downstream, a low-frequency axis wander pinned
 *      at both ends, and for water a catenary sag that is zero at the mouth and zero at the target so
 *      the arc droops without missing. Shaded from a facing term: axis-ward is the hot core (the view
 *      ray's longest path through the gas), rim is the cool edge. Additive for fire/dragon/ice,
 *      normal-blended and translucent for water.
 *   2. Puffs. Instanced camera-facing quads via SpriteNodeMaterial's documented instanced form
 *      (`positionNode = instancedBufferAttribute`), fed by CPU arrays — fire licks that rise, droplets
 *      that fall — with `aLife` read by `opacityNode`. Particle motion is the ParticleSystem.js idea
 *      (velocity + gravity + drag + life curve) run on the CPU instead, because 300 puffs is nothing
 *      and it keeps the emitter honest about where the front actually is.
 *   3. Impact. A noise-displaced additive dome (flattened into a splash for water/ice), a radial burst
 *      of puffs, and a scorch/wet disc on the ground that holds through IMPACT and dies in FADE.
 *
 * A pooled kit (geometry + node graph + materials, keyed by palette) is reused between casts, so a
 * repeated Flamethrower compiles one shader, not one per press. Deterministic from `seed`; no
 * allocation in update.
 */

import { createPhaseMachine, mulberry32, Easing, saturate, createRateEmitter } from './move-core.js';

const TAU = Math.PI * 2;
const _pt = { x: 0, y: 0, z: 0 };
const lerp = (a, b, t) => a + (b - a) * t;

/** Named looks. Every field is overridable through `options` at factory level. */
export const PALETTES = {
  fire: {
    core: '#fff2c0', mid: '#ff8a1e', edge: '#8e1f04', puffA: '#ffb347', puffB: '#2a0f06',
    burst: '#ffd27a', decal: '#120a06', decalOpacity: 0.75, additive: true, opacity: 1,
    radiusNear: 0.1, radiusFar: 0.62, radiusCurve: 0.85, sag: 0, wobble: 0.3, bands: 1.8,
    noiseScale: 3.2, flow: 3.4, wander: 0.1, streak: 1, streakSharp: 0.45, streakScale: 5.5,
    streakBands: 2.4, streakAlpha: 0.42, sparkle: 0, rim: 0.55, fill: 0.75, coreSharp: 1.5,
    edgePower: 2, mouthGlow: 1.3, mouthLen: 0.1, tipSoft: 0.07,
    puffRate: 60, puffSize: 0.42, puffLife: 0.75, puffAspect: [0.85, 1.4], puffGravity: 2.6,
    puffDrag: 1.6, puffSpread: 1.5, puffSpeed: 6.5, puffSpin: 1.2, burstPuffs: 26,
    burstScale: 2.1, burstFlatten: 1, burstNoise: 0.25, light: '#ff7a1e', lightIntensity: 18,
    lightDistance: 14, flicker: 0.35,
  },
  water: {
    core: '#eaffff', mid: '#59c8ff', edge: '#0b4d8f', puffA: '#bfeaff', puffB: '#2b6fa8',
    burst: '#cfefff', decal: '#0d2b3f', decalOpacity: 0.5, additive: false, opacity: 0.62,
    radiusNear: 0.09, radiusFar: 0.34, radiusCurve: 1.1, sag: 0.55, wobble: 0.22, bands: 2.4,
    noiseScale: 4.4, flow: 4.6, wander: 0.05, streak: 0.8, streakSharp: 0.55, streakScale: 7,
    streakBands: 3, streakAlpha: 0.3, sparkle: 0.15, rim: 0.85, fill: 0.35, coreSharp: 1.1,
    edgePower: 1.6, mouthGlow: 0.4, mouthLen: 0.08, tipSoft: 0.06,
    puffRate: 90, puffSize: 0.16, puffLife: 0.9, puffAspect: [1, 1], puffGravity: -11,
    puffDrag: 0.5, puffSpread: 1.8, puffSpeed: 7.5, puffSpin: 0.4, burstPuffs: 40,
    burstScale: 1.7, burstFlatten: 0.35, burstNoise: 0.18, light: '#7fd0ff', lightIntensity: 0,
    lightDistance: 10, flicker: 0,
  },
  dragon: {
    core: '#e9d9ff', mid: '#9a4dff', edge: '#0f8f8f', puffA: '#a86bff', puffB: '#0b3b45',
    burst: '#c9a6ff', decal: '#150b22', decalOpacity: 0.65, additive: true, opacity: 1,
    radiusNear: 0.13, radiusFar: 0.72, radiusCurve: 0.8, sag: 0.08, wobble: 0.38, bands: 1.4,
    noiseScale: 2.6, flow: 2.8, wander: 0.16, streak: 1.1, streakSharp: 0.4, streakScale: 4.5,
    streakBands: 2, streakAlpha: 0.5, sparkle: 0.25, rim: 0.7, fill: 0.8, coreSharp: 1.3,
    edgePower: 2.4, mouthGlow: 1.5, mouthLen: 0.12, tipSoft: 0.08,
    puffRate: 55, puffSize: 0.5, puffLife: 0.85, puffAspect: [0.9, 1.25], puffGravity: 1.4,
    puffDrag: 1.2, puffSpread: 1.7, puffSpeed: 6, puffSpin: 1.6, burstPuffs: 30,
    burstScale: 2.6, burstFlatten: 1, burstNoise: 0.32, light: '#9a4dff', lightIntensity: 16,
    lightDistance: 16, flicker: 0.18,
  },
  ice: {
    core: '#ffffff', mid: '#bfe9ff', edge: '#3f7fd0', puffA: '#e8f8ff', puffB: '#6fa8d8',
    burst: '#dff3ff', decal: '#8fc7e8', decalOpacity: 0.55, additive: true, opacity: 0.9,
    radiusNear: 0.07, radiusFar: 0.26, radiusCurve: 1.3, sag: 0, wobble: 0.14, bands: 3.2,
    noiseScale: 6, flow: 5.5, wander: 0.03, streak: 1.3, streakSharp: 0.62, streakScale: 9,
    streakBands: 4, streakAlpha: 0.45, sparkle: 0.9, rim: 0.6, fill: 0.9, coreSharp: 1.8,
    edgePower: 2.6, mouthGlow: 0.9, mouthLen: 0.08, tipSoft: 0.05,
    puffRate: 70, puffSize: 0.14, puffLife: 1, puffAspect: [1, 1], puffGravity: -1.2,
    puffDrag: 0.9, puffSpread: 1, puffSpeed: 8, puffSpin: 2.2, burstPuffs: 34,
    burstScale: 1.9, burstFlatten: 0.8, burstNoise: 0.2, light: '#bfe9ff', lightIntensity: 10,
    lightDistance: 12, flicker: 0.08,
  },
};

const DEFAULTS = {
  travelSpeed: 26, impactTime: 0.8, fadeTime: 0.5, tubeSegments: 56, tubeRings: 18,
  puffCap: 300, burstTime: 0.4, decalRadius: 1.4, widthScale: 1, poolPerPalette: 3,
};

/** Fire the emitter into a slot, reusing the oldest when full. */
function emitPuff(kit, rnd, x, y, z, dx, dy, dz, speed, spread, size, life) {
  const cap = kit.puffCap;
  const i = kit.puffCount < cap ? kit.puffCount++ : (kit.puffCursor = (kit.puffCursor + 1) % cap);
  const j = i * 3;
  kit.pPos[j] = x; kit.pPos[j + 1] = y; kit.pPos[j + 2] = z;
  const sx = (rnd() - 0.5) * spread, sy = (rnd() - 0.5) * spread, sz = (rnd() - 0.5) * spread;
  kit.pVel[j] = dx * speed + sx; kit.pVel[j + 1] = dy * speed + sy; kit.pVel[j + 2] = dz * speed + sz;
  kit.pLife[i] = 1;
  kit.pRate[i] = 1 / Math.max(0.05, life * (0.7 + rnd() * 0.6));
  kit.pSize[i] = size * (0.65 + rnd() * 0.7);
  kit.pSeed[i] = rnd();
}

/** Integrate the live puffs and swap-remove the dead ones so instanceCount stays tight. */
function stepPuffs(kit, P, dt) {
  const damp = 1 - Math.min(0.95, P.puffDrag * dt);
  const g = P.puffGravity * dt;
  let n = kit.puffCount;
  for (let i = 0; i < n; i++) {
    const l = kit.pLife[i] - kit.pRate[i] * dt;
    if (l <= 0) {
      n--;
      const a = i * 3, b = n * 3;
      kit.pPos[a] = kit.pPos[b]; kit.pPos[a + 1] = kit.pPos[b + 1]; kit.pPos[a + 2] = kit.pPos[b + 2];
      kit.pVel[a] = kit.pVel[b]; kit.pVel[a + 1] = kit.pVel[b + 1]; kit.pVel[a + 2] = kit.pVel[b + 2];
      kit.pLife[i] = kit.pLife[n]; kit.pRate[i] = kit.pRate[n];
      kit.pSize[i] = kit.pSize[n]; kit.pSeed[i] = kit.pSeed[n];
      i--;
      continue;
    }
    kit.pLife[i] = l;
    const j = i * 3;
    kit.pVel[j] *= damp; kit.pVel[j + 1] = kit.pVel[j + 1] * damp + g; kit.pVel[j + 2] *= damp;
    kit.pPos[j] += kit.pVel[j] * dt;
    kit.pPos[j + 1] += kit.pVel[j + 1] * dt;
    kit.pPos[j + 2] += kit.pVel[j + 2] * dt;
  }
  kit.puffCount = n;
  if (kit.puffCursor >= n) kit.puffCursor = 0;
  kit.puffGeo.instanceCount = n;
  kit.aPos.needsUpdate = true; kit.aLife.needsUpdate = true;
  kit.aSize.needsUpdate = true; kit.aSeed.needsUpdate = true;
}

export function createStreamFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, terrainHeight = () => 0, lights } = deps;
  const O = { ...DEFAULTS, ...options };
  const {
    uniform, attribute, positionGeometry, positionLocal, positionWorld, normalLocal, normalWorld,
    cameraPosition, uv, time, mix, smoothstep, clamp, pow, abs, sin, cos, step, dot, cross,
    normalize, varying, vec2, vec3, float, mx_noise_float,
  } = TSL;

  const pools = new Map();
  const liveKits = new Set();

  /** Palette-scoped tunables: the palette table, then anything the caller overrode. */
  function paramsFor(name) {
    const base = PALETTES[name] || PALETTES.fire;
    const over = options.palettes && options.palettes[name];
    return { ...base, ...(over || {}) };
  }

  function buildKit(key) {
    const P = paramsFor(key);
    const u = {
      start: uniform(new THREE.Vector3()), end: uniform(new THREE.Vector3(0, 0, 1)),
      seed: uniform(0), progress: uniform(0), tail: uniform(0), fade: uniform(1),
      width: uniform(1), burst: uniform(0), decal: uniform(0),
      cCore: uniform(new THREE.Color(P.core)), cMid: uniform(new THREE.Color(P.mid)),
      cEdge: uniform(new THREE.Color(P.edge)), cBurst: uniform(new THREE.Color(P.burst)),
      cPuffA: uniform(new THREE.Color(P.puffA)), cPuffB: uniform(new THREE.Color(P.puffB)),
      cDecal: uniform(new THREE.Color(P.decal)),
    };

    // ---- layer 1: the column -------------------------------------------------------------
    const axis = u.end.sub(u.start);
    const dir = normalize(axis);
    const ref = mix(vec3(0, 1, 0), vec3(1, 0, 0), step(0.98, abs(dir.y)));
    const n1 = normalize(cross(dir, ref));
    const n2 = cross(dir, n1);

    const t = positionGeometry.x.add(0.5);
    const ang = positionGeometry.y.add(0.5).mul(TAU);
    const scroll = time.mul(P.flow);

    const wob = mx_noise_float(vec3(
      cos(ang).mul(P.bands), sin(ang).mul(P.bands), t.mul(P.noiseScale).sub(scroll).add(u.seed),
    ));
    const dA = mx_noise_float(vec3(t.mul(1.7).sub(scroll.mul(0.3)), u.seed, 0));
    const dB = mx_noise_float(vec3(t.mul(1.7).sub(scroll.mul(0.3)), u.seed.add(9.1), 3.3));
    const ends = sin(t.mul(Math.PI));

    const sag = t.mul(t.oneMinus()).mul(4 * P.sag);
    const centre = mix(u.start, u.end, t).sub(vec3(0, sag, 0))
      .add(n1.mul(dA).add(n2.mul(dB)).mul(ends.mul(P.wander)));
    const radius = mix(float(P.radiusNear), float(P.radiusFar), pow(t, P.radiusCurve))
      .mul(u.width).mul(wob.mul(P.wobble).add(1));
    const nrm = n1.mul(cos(ang)).add(n2.mul(sin(ang)));
    const surface = centre.add(nrm.mul(radius));

    const vT = varying(t, 'vStreamT');
    const vAng = varying(ang, 'vStreamAng');
    const vFacing = varying(abs(dot(normalize(cameraPosition.sub(surface)), nrm)), 'vStreamFacing');

    const facing = clamp(vFacing, 0, 1);
    const axisward = pow(facing, P.coreSharp);
    const rim = pow(facing.oneMinus(), P.edgePower);
    const flowN = mx_noise_float(vec3(
      vT.mul(P.streakScale).sub(time.mul(P.flow)),
      cos(vAng).mul(P.streakBands), sin(vAng).mul(P.streakBands).add(u.seed),
    ));
    const streak = smoothstep(P.streakSharp, 0.98, flowN).mul(P.streak);
    const spark = smoothstep(0.86, 1, mx_noise_float(vec3(
      vT.mul(P.streakScale * 3).sub(time.mul(P.flow * 1.7)),
      cos(vAng).mul(P.streakBands * 2.5), sin(vAng).mul(P.streakBands * 2.5).add(u.seed),
    ))).mul(P.sparkle);
    const mouth = smoothstep(0, P.mouthLen, vT).oneMinus();

    const heat = clamp(axisward.mul(0.75).add(pow(vT.oneMinus(), 2).mul(0.7)).add(streak.mul(0.6)), 0, 1);
    const tubeColor = mix(u.cEdge, u.cMid, smoothstep(0, 0.55, heat))
      .mix(u.cCore, smoothstep(0.55, 1, heat))
      .add(u.cCore.mul(mouth.mul(P.mouthGlow).add(spark.mul(1.4))));

    // The front and the shut-off are the same idea twice: clip the finished shape, never rescale it.
    const drawn = smoothstep(u.progress.sub(P.tipSoft), u.progress, vT).oneMinus()
      .mul(smoothstep(u.tail, u.tail.add(P.tipSoft), vT));
    const tubeAlpha = clamp(
      rim.mul(P.rim).add(axisward.mul(P.fill)).add(streak.mul(P.streakAlpha)).add(spark),
      0, 1,
    ).mul(drawn).mul(u.fade).mul(P.opacity);

    const tubeGeo = new THREE.PlaneGeometry(1, 1, O.tubeSegments, O.tubeRings);
    const tubeMat = new NODES.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    tubeMat.blending = P.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    tubeMat.toneMapped = false;
    tubeMat.positionNode = surface;
    tubeMat.colorNode = tubeColor;
    tubeMat.opacityNode = tubeAlpha;
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.frustumCulled = false;
    tube.matrixAutoUpdate = false;

    // ---- layer 2: puffs ------------------------------------------------------------------
    const cap = O.puffCap;
    const puffGeo = new THREE.InstancedBufferGeometry();
    puffGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    puffGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    puffGeo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    const pPos = new Float32Array(cap * 3), pLife = new Float32Array(cap);
    const pSize = new Float32Array(cap), pSeed = new Float32Array(cap);
    const aPos = new THREE.InstancedBufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage);
    const aLife = new THREE.InstancedBufferAttribute(pLife, 1).setUsage(THREE.DynamicDrawUsage);
    const aSize = new THREE.InstancedBufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage);
    const aSeed = new THREE.InstancedBufferAttribute(pSeed, 1).setUsage(THREE.DynamicDrawUsage);
    puffGeo.setAttribute('aPos', aPos); puffGeo.setAttribute('aLife', aLife);
    puffGeo.setAttribute('aSize', aSize); puffGeo.setAttribute('aSeed', aSeed);
    puffGeo.instanceCount = 0;
    puffGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    const nLife = attribute('aLife', 'float');
    const nSize = attribute('aSize', 'float');
    const nSeed = attribute('aSeed', 'float');
    const grow = mix(float(1.35), float(0.35), nLife); // small and hard at birth, wide and soft at death
    const disc = smoothstep(0.5, 0.06, uv().sub(0.5).length());

    const puffMat = new NODES.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    puffMat.blending = P.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    puffMat.toneMapped = false;
    puffMat.positionNode = attribute('aPos', 'vec3');
    puffMat.scaleNode = vec2(
      nSize.mul(grow).mul(P.puffAspect[0]),
      nSize.mul(grow).mul(P.puffAspect[1]),
    );
    puffMat.rotationNode = nSeed.mul(TAU).add(time.mul(P.puffSpin));
    puffMat.colorNode = mix(u.cPuffB, u.cPuffA, pow(nLife, 0.6));
    puffMat.opacityNode = disc
      .mul(smoothstep(0, 0.3, nLife))
      .mul(smoothstep(1, 0.88, nLife))
      .mul(u.fade);
    const puffs = new THREE.Mesh(puffGeo, puffMat);
    puffs.frustumCulled = false;
    puffs.userData.moveComponent = 'particles';

    // ---- layer 3: impact -----------------------------------------------------------------
    const burstGeo = new THREE.SphereGeometry(1, 24, 16);
    const burstMat = new NODES.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    burstMat.blending = THREE.AdditiveBlending;
    burstMat.toneMapped = false;
    const bump = mx_noise_float(positionLocal.mul(2.4).add(u.seed)).mul(P.burstNoise);
    burstMat.positionNode = positionLocal.add(normalLocal.mul(bump));
    const bRim = pow(abs(dot(normalize(cameraPosition.sub(positionWorld)), normalWorld)).oneMinus(), 1.6);
    burstMat.colorNode = mix(u.cBurst, u.cCore, bRim.oneMinus());
    burstMat.opacityNode = clamp(bRim.mul(0.8).add(0.25), 0, 1).mul(u.burst);
    const burst = new THREE.Mesh(burstGeo, burstMat);
    burst.frustumCulled = false;

    const decalGeo = new THREE.CircleGeometry(1, 40);
    const decalMat = new NODES.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    decalMat.toneMapped = false;
    const dR = uv().sub(0.5).length().mul(2);
    const mottle = mx_noise_float(vec3(uv().x.mul(7), uv().y.mul(7), u.seed)).mul(0.5).add(0.6);
    decalMat.colorNode = u.cDecal.mul(mottle);
    decalMat.opacityNode = smoothstep(1, 0.2, dR).mul(mottle).mul(u.decal);
    const decal = new THREE.Mesh(decalGeo, decalMat);
    decal.rotation.x = -Math.PI / 2;
    decal.frustumCulled = false;

    const group = new THREE.Group();
    group.add(tube, puffs, burst, decal);

    return {
      key, P, group, tube, puffs, burst, decal, u,
      puffGeo, aPos, aLife, aSize, aSeed, pPos, pLife, pSize, pSeed,
      pVel: new Float32Array(cap * 3), pRate: new Float32Array(cap),
      puffCap: cap, puffCount: 0, puffCursor: 0,
      geometries: [tubeGeo, puffGeo, burstGeo, decalGeo],
      materials: [tubeMat, puffMat, burstMat, decalMat],
    };
  }

  function acquireKit(key) {
    const pool = pools.get(key);
    const kit = pool && pool.length ? pool.pop() : buildKit(key);
    kit.puffCount = 0; kit.puffCursor = 0; kit.puffGeo.instanceCount = 0;
    kit.u.progress.value = 0; kit.u.tail.value = 0; kit.u.fade.value = 1;
    kit.u.burst.value = 0; kit.u.decal.value = 0;
    kit.burst.visible = false; kit.decal.visible = false;
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
  }

  function cast({ line, seed = 1, palette = 'default', power = 1, sourceY = 0.6, targetY = 0.6 }) {
    const key = PALETTES[palette] ? palette : 'fire';
    const kit = acquireKit(key);
    const P = kit.P;
    const rnd = mulberry32(seed >>> 0);
    const u = kit.u;
    const pw = Math.max(0.2, power);

    const sx = line.origin.x, sy = line.origin.y + sourceY, sz = line.origin.z;
    const ex = line.target.x, ey = line.target.y + targetY, ez = line.target.z;
    u.start.value.set(sx, sy, sz);
    u.end.value.set(ex, ey, ez);
    u.seed.value = rnd() * 37;
    u.width.value = O.widthScale * (0.7 + 0.45 * pw);

    let dx = ex - sx, dy = ey - sy, dz = ez - sz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const flicker = rnd() * TAU;

    kit.group.position.set(0, 0, 0);
    const gy = terrainHeight(ex, ez);
    kit.decal.position.set(ex, (Number.isFinite(gy) ? gy : line.target.y) + 0.03, ez);
    kit.decal.scale.setScalar(O.decalRadius * pw);
    kit.burst.position.set(ex, ey, ez);
    kit.burst.scale.setScalar(0.001);
    scene.add(kit.group);

    const light = P.lightIntensity > 0 && lights ? lights.acquire() : null;
    if (light) { light.color.set(P.light); light.distance = P.lightDistance * pw; light.intensity = 0; }

    const emitter = createRateEmitter(48);
    let pendingImpact = false, doneFired = false, released = false, burstAge = 0;

    /** Where the nozzle is pointing right now, sag included, in the same frame as the shader. */
    function frontAt(uu) {
      _pt.x = lerp(sx, ex, uu);
      _pt.y = lerp(sy, ey, uu) - 4 * P.sag * uu * (1 - uu);
      _pt.z = lerp(sz, ez, uu);
      return _pt;
    }

    function spray(uu, dt, rate) {
      const p = frontAt(uu);
      if (light) light.position.set(p.x, p.y, p.z);
      const n = emitter.take(rate * pw, dt);
      for (let i = 0; i < n; i++) {
        const q = frontAt(Math.max(0, uu - rnd() * 0.14));
        emitPuff(kit, rnd, q.x, q.y, q.z, dx, dy, dz,
          P.puffSpeed * (0.6 + rnd() * 0.8), P.puffSpread, P.puffSize * pw, P.puffLife);
      }
    }

    const machine = createPhaseMachine({
      travelSpeed: O.travelSpeed, impactTime: O.impactTime, fadeTime: O.fadeTime,
      onTravel(dt, t) {
        u.progress.value = this.u;
        spray(this.u, dt, P.puffRate);
        if (light) light.intensity = P.lightIntensity * pw * (1 + P.flicker * Math.sin(t * 31 + flicker)) * saturate(this.u * 3);
      },
      onImpact() {
        u.progress.value = 1;
        pendingImpact = true;
        burstAge = 0;
        kit.burst.visible = true; kit.decal.visible = true;
        const p = frontAt(1);
        for (let i = 0; i < P.burstPuffs; i++) {
          const a = (i / P.burstPuffs) * TAU + rnd() * 0.4;
          const rise = P.puffGravity > 0 ? 0.9 + rnd() * 0.8 : 0.35 + rnd() * 0.9;
          emitPuff(kit, rnd, p.x, p.y, p.z, Math.cos(a) * 0.85, rise, Math.sin(a) * 0.85,
            P.puffSpeed * (0.45 + rnd() * 0.7), P.puffSpread * 0.6, P.puffSize * pw * 1.15, P.puffLife * 1.2);
        }
      },
      onFade(dt, t, now) {
        burstAge += dt;
        const bt = saturate(burstAge / O.burstTime);
        kit.burst.scale.set(
          P.burstScale * pw * Easing.outCubic(bt) + 0.02,
          P.burstScale * pw * P.burstFlatten * Easing.outCubic(bt) + 0.02,
          P.burstScale * pw * Easing.outCubic(bt) + 0.02,
        );
        u.burst.value = (1 - bt) * (1 - bt);

        if (t <= 1) {
          // IMPACT: the hose is still open, so the column stays lit and keeps feeding the splash.
          u.tail.value = 0; u.fade.value = 1;
          u.decal.value = P.decalOpacity * saturate(t * 4);
          spray(1, dt, P.puffRate * 0.7);
          if (light) light.intensity = P.lightIntensity * pw * (1 + P.flicker * Math.sin(now * 31 + flicker));
        } else {
          const k = saturate(t - 1);
          u.tail.value = Easing.inQuad(k) * 1.15;
          u.fade.value = 1 - k * k;
          u.decal.value = P.decalOpacity * (1 - k);
          if (light) light.intensity = P.lightIntensity * pw * (1 - k) * (1 + P.flicker * Math.sin(now * 31 + flicker));
        }
      },
    });
    machine.spawn(line);

    return {
      group: kit.group, machine, onImpact: null, onDone: null,
      update(dt, now) {
        const alive = machine.update(dt, now);
        stepPuffs(kit, P, dt);
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
