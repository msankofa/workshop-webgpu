/**
 * fx-fissure.js — the ground tears open along the cast line.
 *
 * A glowing crack races from the attacker to the target: the propagation front IS the phase machine's
 * `u`, so the tear reaches the target exactly at impact. Lightning-like side branches fork off it,
 * basalt lips heave up along both edges, embers rise out of the melt and point lights flicker along
 * the seam. At impact a radial burst of 4–6 short cracks tears out around the target and the whole
 * network flashes; through FADE the crack cools and dims while the rock stays.
 *
 * Ported from GeometryPainterThreeJS/src/modes/fissures.ts (already TSL). What changed:
 *  - The path is the ground line, not a painted stroke on a sphere. `line.samples` is the centreline,
 *    the surface normal is always +Y, and branches walk in XZ re-sampling `terrainHeight` instead of
 *    re-projecting onto a sphere of radius |origin|. The anchor-space/localNormal plumbing is gone.
 *  - `uGrown` is driven by `machine.u * total` rather than a free-running growth speed, and keeps
 *    advancing past `total` during IMPACT so the burst cracks (generated as branches anchored at the
 *    target, with `aDist` starting at `total`) tear open in the same shader with no extra draw call.
 *  - The live-slider uniforms became per-cast constants fed by `power`: branch density (`uBranchFrac`)
 *    and branch reach (`uLenFrac`) scale with it, as does crack width.
 *  - The ember sprite is a TSL radial falloff on `uv()` instead of a canvas texture, so the module has
 *    no DOM dependency and constructs in Node.
 *  - Palettes swap the blackbody ramp, the halo, the rock tint and the ember behaviour, so `earth`
 *    can be a dull unlit crack shedding dust while `magma` keeps the reference look.
 *
 * Ground effect: `sourceY` / `targetY` are ignored.
 */

import { createPhaseMachine, mulberry32, Easing, saturate, createRateEmitter } from './move-core.js';

/** Named looks. `seam→warm→hot→peak` is the core ramp; values above 1 are HDR headroom. */
export const PALETTES = {
  magma: {
    seam: [0.02, 0.004, 0.002], warm: [1.1, 0.1, 0.01], hot: [2.6, 0.85, 0.1], peak: [4.6, 3.6, 2.4],
    heat: 1.5, coreAdditive: true,
    glow: [1.5, 0.38, 0.05], glowGain: 0.34,
    rock: 0x565046, rockHue: 0.06, rockRough: 0.95,
    light: 0xff7030, lightGain: 1,
    emberHot: [2.2, 1.5, 0.5], emberCool: [1.9, 0.5, 0.1], emberAdditive: true,
    emberRise: [0.9, 2.0], emberSize: [0.05, 0.12], emberLife: [0.7, 1.9], emberDrag: 0.6, emberGravity: 0.2,
  },
  shadow: {
    seam: [0.01, 0.0, 0.02], warm: [0.22, 0.02, 0.42], hot: [0.6, 0.08, 1.2], peak: [1.5, 0.6, 2.8],
    heat: 1.25, coreAdditive: true,
    glow: [0.5, 0.1, 1.5], glowGain: 0.42,
    rock: 0x2a2136, rockHue: 0.75, rockRough: 0.85,
    light: 0x8a2bff, lightGain: 0.85,
    emberHot: [1.3, 0.7, 2.4], emberCool: [0.5, 0.05, 1.4], emberAdditive: true,
    emberRise: [0.7, 1.6], emberSize: [0.06, 0.14], emberLife: [0.9, 2.2], emberDrag: 0.5, emberGravity: 0.05,
  },
  earth: {
    seam: [0.02, 0.014, 0.009], warm: [0.07, 0.05, 0.032], hot: [0.15, 0.11, 0.07], peak: [0.26, 0.2, 0.14],
    heat: 1, coreAdditive: false,
    glow: [0, 0, 0], glowGain: 0,
    rock: 0x6b5a44, rockHue: 0.09, rockRough: 1,
    light: 0x8a7550, lightGain: 0,
    emberHot: [0.5, 0.44, 0.36], emberCool: [0.36, 0.31, 0.25], emberAdditive: false,
    emberRise: [0.35, 0.9], emberSize: [0.14, 0.34], emberLife: [1.2, 2.6], emberDrag: 1.6, emberGravity: 0.55,
  },
};
PALETTES.default = PALETTES.magma;

const DEFAULTS = {
  width: 0.26,            // crack width at power 1 (world units)
  glowWidthMul: 3.4,      // underglow width = width * mul + add
  glowWidthAdd: 0.22,
  lift: 0.04,             // centreline offset above ground, kills z-fighting
  pathStep: 0.16,         // branch walk step
  branchCount: 8,         // branch slots generated; power culls them
  branchLength: 1.5,      // branch reach at power 1
  burstMin: 4, burstMax: 6, burstLength: 1.3,
  rocksPerMeter: 2, maxRocks: 90, rockSize: 0.3, rockPop: 0.55,
  emberRate: 7,           // embers/s per open metre of crack
  maxEmbers: 220,
  lightCount: 3, lightDistance: 7, lightIntensity: 6,
  pulseSpeed: 1, flashTime: 0.3,
  travelSpeed: 13, impactTime: 0.7, fadeTime: 1.4,
};

const ROCK_VARIANTS = 3;
const PINCH_MAX = 0.6; // longest needle-point taper at a crack end

export function createFissureFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, terrainHeight = () => 0, lights } = deps;
  const O = { ...DEFAULTS, ...options };
  const { positionLocal, attribute, uniform, float, vec2, vec3, mix, smoothstep, uv, time } = TSL;
  const tstep = TSL.step, tabs = TSL.abs;

  // Scratch — created once per factory, never per frame.
  const S = {
    m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), c: new THREE.Color(),
    v: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
    basis: new THREE.Matrix4(), zero: new THREE.Matrix4().makeScale(0, 0, 0),
  };

  let rockGeos = null;
  const matCache = new Map();
  const live = new Set();

  /** Flattened jagged basalt chunk, base at y=0, ~unit sized. Shared across every cast. */
  function makeRockGeometry(rnd) {
    const geo = new THREE.BoxGeometry(1, 0.55, 0.7, 2, 1, 1).toNonIndexed();
    const pos = geo.getAttribute('position');
    const seen = new Map();
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      let d = seen.get(key);
      if (!d) { d = [(rnd() - 0.5) * 0.45, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.4]; seen.set(key, d); }
      pos.setXYZ(i, pos.getX(i) + d[0], pos.getY(i) * (0.7 + rnd() * 0.1) + d[1] * 0.5 + 0.25, pos.getZ(i) + d[2]);
    }
    geo.computeVertexNormals();
    return geo;
  }

  function getRockGeos() {
    if (!rockGeos) {
      const rnd = mulberry32(0xba5a17);
      rockGeos = Array.from({ length: ROCK_VARIANTS }, () => makeRockGeometry(rnd));
    }
    return rockGeos;
  }

  /** Rock + ember materials are per palette, not per cast: nothing in them is cast-specific. */
  function getShared(palName, pal) {
    let entry = matCache.get(palName);
    if (entry) return entry;
    const rock = new NODES.MeshStandardNodeMaterial({
      color: pal.rock, roughness: pal.rockRough, metalness: 0.02,
    });
    const ember = new NODES.MeshBasicNodeMaterial();
    ember.transparent = true;
    ember.depthWrite = false;
    ember.side = THREE.DoubleSide;
    ember.blending = pal.emberAdditive ? THREE.AdditiveBlending : THREE.NormalBlending;
    const col = attribute('aEmberCol', 'vec4');
    const soft = smoothstep(0.08, 0.5, uv().distance(vec2(0.5, 0.5))).oneMinus();
    ember.colorNode = vec3(col.x, col.y, col.z);
    ember.opacityNode = soft.mul(col.w);
    entry = { rock, ember };
    matCache.set(palName, entry);
    return entry;
  }

  // ---------- path ----------

  /** Main centreline straight off `line.samples`: normal is up, side is the flat perpendicular. */
  function buildPath(line) {
    const s = line.samples;
    const pts = [];
    let dist = 0;
    for (let i = 0; i < s.length; i++) {
      if (i > 0) dist += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y, s[i].z - s[i - 1].z);
      const a = s[Math.max(i - 1, 0)], b = s[Math.min(i + 1, s.length - 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      pts.push({ x: s[i].x, y: s[i].y, z: s[i].z, tx, tz, sx: -tz, sz: tx, dist, walked: 0, maxWalk: 1, rank: 0 });
    }
    return pts;
  }

  /** Walk a crack across the ground from a seed point, veering as it goes. Used by branches AND the burst. */
  function walkCrack(x, z, dirX, dirZ, maxWalk, curvature, baseDist, rank) {
    const pts = [];
    let dx = dirX, dz = dirZ;
    for (let walked = 0; walked <= maxWalk; walked += O.pathStep) {
      pts.push({
        x, y: terrainHeight(x, z), z, tx: dx, tz: dz, sx: -dz, sz: dx,
        dist: baseDist + walked, walked, maxWalk, rank,
      });
      x += dx * O.pathStep; z += dz * O.pathStep;
      const a = curvature * O.pathStep, ca = Math.cos(a), sa = Math.sin(a);
      const nx = dx * ca - dz * sa; dz = dx * sa + dz * ca; dx = nx;
    }
    return pts;
  }

  /** Lightning-like side branches: alternate sides, launch 30°–75° off the tangent, curve away. */
  function growBranches(main, rnd, total, power) {
    const out = [];
    const spacing = total / Math.max(1, O.branchCount);
    let next = spacing * (0.3 + rnd() * 0.5);
    let sideSign = rnd() < 0.5 ? 1 : -1;
    const reach = O.branchLength * power;
    for (const p of main) {
      if (p.dist < next || p.dist > total - spacing * 0.25) continue;
      next = p.dist + spacing * (0.7 + rnd() * 0.6);
      sideSign = -sideSign;
      const ang = sideSign * (0.55 + rnd() * 0.7);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const pts = walkCrack(
        p.x, p.z, p.tx * ca - p.tz * sa, p.tx * sa + p.tz * ca,
        reach * (0.45 + rnd() * 0.75), (rnd() - 0.5) * 3 / Math.max(0.3, power), p.dist, 0.02 + rnd() * 0.98,
      );
      if (pts.length >= 2) out.push(pts);
    }
    return out;
  }

  /** Impact burst: short cracks radiating from the target, ranked so they always survive culling. */
  function growBurst(target, rnd, total, power) {
    const n = O.burstMin + Math.floor(rnd() * (O.burstMax - O.burstMin + 1));
    const out = [];
    const base = rnd() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = base + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
      const len = O.burstLength * power * (0.6 + rnd() * 0.8);
      const pts = walkCrack(target.x, target.z, Math.cos(a), Math.sin(a), len, (rnd() - 0.5) * 2.4, total, 0.0005);
      if (pts.length >= 2) out.push(pts);
    }
    return out;
  }

  /**
   * One indexed ribbon for the main crack, its branches and the burst. Every vertex sits ON the
   * centreline; the across displacement is `aSide * width * aAcross * aJit * taper` in the vertex
   * shader, so width and branch reach stay uniform-driven.
   */
  function buildRibbonGeometry(segments, total, rnd) {
    const positions = [], sides = [], across = [], dists = [], jitters = [], walks = [], maxWalks = [], ranks = [];
    const indices = [];
    const pinch = Math.min(PINCH_MAX, Math.max(0.12, total * 0.12));
    for (const path of segments) {
      const base = positions.length / 3;
      const isBranch = path[0].rank > 0;
      let jit = 1;
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        jit = Math.min(1.45, Math.max(0.6, jit + (rnd() - 0.5) * 0.35));
        // A crack terminates in a needle, not a rounded cap; branches taper in the shader instead.
        let w = jit * (isBranch ? 0.62 : Math.pow(saturate(Math.min(p.dist, total - p.dist) / pinch), 0.65));
        for (let k = 0; k < 2; k++) {
          positions.push(p.x, p.y + O.lift, p.z);
          sides.push(p.sx, 0, p.sz);
          across.push(k === 0 ? -1 : 1);
          dists.push(p.dist); jitters.push(w); walks.push(p.walked); maxWalks.push(p.maxWalk); ranks.push(p.rank);
        }
      }
      for (let i = 0; i < path.length - 1; i++) {
        const a = base + i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 3));
    geo.setAttribute('aAcross', new THREE.Float32BufferAttribute(across, 1));
    geo.setAttribute('aDist', new THREE.Float32BufferAttribute(dists, 1));
    geo.setAttribute('aJit', new THREE.Float32BufferAttribute(jitters, 1));
    geo.setAttribute('aWalk', new THREE.Float32BufferAttribute(walks, 1));
    geo.setAttribute('aMaxWalk', new THREE.Float32BufferAttribute(maxWalks, 1));
    geo.setAttribute('aRank', new THREE.Float32BufferAttribute(ranks, 1));
    geo.setIndex(indices);
    return geo;
  }

  // ---------- node graphs ----------

  /** Branch selection, tip taper and the needle-point dimming, shared by both ribbon materials. */
  function branchFactors(u) {
    const aWalk = attribute('aWalk', 'float');
    const aMaxWalk = attribute('aMaxWalk', 'float');
    const aRank = attribute('aRank', 'float');
    const aDist = attribute('aDist', 'float');
    const sel = tstep(aRank, u.branchFrac);
    const taper = float(1).sub(aWalk.div(aMaxWalk.mul(u.lenFrac).add(1e-4))).clamp(0, 1).pow(0.7);
    const isBranch = tstep(1e-5, aRank);
    const tip = mix(smoothstep(0, 0.16, aDist.min(u.total.sub(aDist))), float(1), isBranch);
    return { sel, taper, tip, aDist };
  }

  /** Blackbody core: seam → warm → hot → peak, with travelling pulses and a white-hot front. */
  function buildCoreMaterial(u, pal) {
    const mat = new NODES.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    if (pal.coreAdditive) mat.blending = THREE.AdditiveBlending;
    const aAcross = attribute('aAcross', 'float');
    const aJit = attribute('aJit', 'float');
    const aSide = attribute('aSide', 'vec3');
    const { sel, taper, tip, aDist } = branchFactors(u);

    mat.positionNode = positionLocal.add(aSide.mul(u.width.mul(0.5).mul(aAcross).mul(aJit)).mul(taper.mul(sel)));

    const openness = smoothstep(0, 0.1, u.grown.sub(aDist));
    const center = smoothstep(0.12, 1, tabs(aAcross)).oneMinus();
    const pulse = aDist.mul(2.2).sub(time.mul(u.pulse.mul(2.6))).sin().mul(0.28).add(0.72);
    const flicker = time.mul(9).add(aDist.mul(13)).sin().mul(0.08).add(0.94);
    const front = smoothstep(0, 0.35, tabs(u.grown.sub(aDist))).oneMinus().mul(1.6).mul(tip);
    const burstFlash = u.flash.mul(smoothstep(u.total.mul(0.6), u.total, aDist)).mul(1.8);
    const heat = center.mul(pulse).mul(flicker).mul(u.heat)
      .mul(taper.mul(0.35).add(0.65))
      .mul(tip.mul(0.85).add(0.15))
      .add(front.mul(u.cool)).add(burstFlash);

    const cSeam = vec3(...pal.seam), cWarm = vec3(...pal.warm), cHot = vec3(...pal.hot), cPeak = vec3(...pal.peak);
    let color = mix(cSeam, cWarm, smoothstep(0, 0.55, heat));
    color = mix(color, cHot, smoothstep(0.55, 1.15, heat));
    color = mix(color, cPeak, smoothstep(1.15, 2.1, heat));
    mat.colorNode = color;

    const edge = smoothstep(0.82, 1, tabs(aAcross)).oneMinus();
    mat.opacityNode = openness.mul(edge).mul(sel);
    return mat;
  }

  /** The wide additive halo that paints radiance onto the ground either side of the seam. */
  function buildUnderMaterial(u, pal) {
    const mat = new NODES.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    const aAcross = attribute('aAcross', 'float');
    const aJit = attribute('aJit', 'float');
    const aSide = attribute('aSide', 'vec3');
    const { sel, taper, tip, aDist } = branchFactors(u);

    mat.positionNode = positionLocal.add(aSide.mul(u.glowWidth.mul(0.5).mul(aAcross).mul(aJit)).mul(taper.mul(sel)));

    const openness = smoothstep(0, 0.18, u.grown.sub(aDist));
    const falloff = tabs(aAcross).oneMinus().max(0).pow(1.6);
    const pulse = aDist.mul(2.2).sub(time.mul(u.pulse.mul(2.6))).sin().mul(0.22).add(0.78);
    const strength = falloff.mul(pulse).mul(u.heat).mul(taper.mul(0.5).add(0.5)).mul(tip)
      .mul(u.flash.mul(1.5).add(1)).mul(pal.glowGain);
    mat.colorNode = vec3(...pal.glow).mul(strength);
    mat.opacityNode = openness.mul(sel);
    return mat;
  }

  // ---------- cast ----------

  function cast({ line, seed = 1, palette = 'default', power = 1 } = {}) {
    const pal = PALETTES[palette] || PALETTES.default;
    const rnd = mulberry32(seed >>> 0 || 1);
    const p = Math.max(0.2, power);
    const shared = getShared(PALETTES[palette] ? palette : 'default', pal);
    const group = new THREE.Group();

    const main = buildPath(line);
    const total = Math.max(1e-3, main[main.length - 1].dist);
    const branches = growBranches(main, rnd, total, p);
    const burst = growBurst(line.target, rnd, total, p);
    const burstReach = O.burstLength * p + 0.4;
    const allPts = [];
    for (const seg of [main, ...branches, ...burst]) for (const q of seg) allPts.push(q);

    const u = {
      grown: uniform(0), width: uniform(O.width * (0.6 + 0.4 * p)),
      glowWidth: uniform(O.width * (0.6 + 0.4 * p) * O.glowWidthMul + O.glowWidthAdd),
      heat: uniform(pal.heat), pulse: uniform(O.pulseSpeed), cool: uniform(1), flash: uniform(0),
      branchFrac: uniform(saturate(0.3 + 0.7 * p)), lenFrac: uniform(saturate(0.35 + 0.65 * p)),
      total: uniform(total),
    };

    const ribbonGeo = buildRibbonGeometry([main, ...branches, ...burst], total, rnd);
    const coreMat = buildCoreMaterial(u, pal);
    const coreMesh = new THREE.Mesh(ribbonGeo, coreMat);
    coreMesh.renderOrder = 2;
    coreMesh.frustumCulled = false;
    let underMat = null;
    if (pal.glowGain > 0) {
      underMat = buildUnderMaterial(u, pal);
      const underMesh = new THREE.Mesh(ribbonGeo, underMat);
      underMesh.renderOrder = 1;
      underMesh.frustumCulled = false;
      group.add(underMesh);
    }
    group.add(coreMesh);

    // ----- rock lips -----
    const rocksByVariant = Array.from({ length: ROCK_VARIANTS }, () => []);
    const rockStep = 1 / Math.max(0.01, O.rocksPerMeter);
    let nextRock = rockStep * 0.5, flip = 1, rockTotal = 0;
    for (const q of main) {
      if (q.dist < nextRock || rockTotal >= O.maxRocks) continue;
      nextRock = q.dist + rockStep * (0.8 + rnd() * 0.4);
      flip = -flip;
      rockTotal++;
      const size = O.rockSize * p * (0.55 + rnd() * 0.9);
      const flat = 0.6 + rnd() * 0.6, off = rnd();
      const r = {
        birth: q.dist + rnd() * 0.15, tint: rnd(),
        pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(size, size * flat, size * 0.8),
      };
      r.pos.set(
        q.x + q.sx * flip * (u.width.value * 0.55 + off * u.width.value * 0.6 + size * 0.15),
        q.y - 0.3 * size * flat,
        q.z + q.sz * flip * (u.width.value * 0.55 + off * u.width.value * 0.6 + size * 0.15),
      );
      S.v.set(q.tx, 0, q.tz); S.v2.set(0, 1, 0); S.v3.crossVectors(S.v, S.v2);
      S.basis.makeBasis(S.v, S.v2, S.v3);
      r.quat.setFromRotationMatrix(S.basis);
      S.q.setFromAxisAngle(S.v2, (rnd() - 0.5) * 0.9); r.quat.premultiply(S.q);
      S.q.setFromAxisAngle(S.v, (off - 0.5) * 0.35); r.quat.premultiply(S.q);
      rocksByVariant[Math.floor(rnd() * ROCK_VARIANTS)].push(r);
    }
    const geos = getRockGeos();
    const rockMeshes = [];
    for (let v = 0; v < ROCK_VARIANTS; v++) {
      const list = rocksByVariant[v];
      const mesh = new THREE.InstancedMesh(geos[v], shared.rock, Math.max(list.length, 1));
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let i = 0; i < list.length; i++) {
        mesh.setMatrixAt(i, S.zero);
        mesh.setColorAt(i, S.c.setHSL(pal.rockHue, 0.12, 0.5 + list[i].tint * 0.35));
      }
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      rockMeshes.push(mesh);
      group.add(mesh);
    }

    // ----- embers (instanced quads; WebGPU points are always 1px) -----
    const emberGeo = new THREE.PlaneGeometry(1, 1);
    const emberCol = new THREE.InstancedBufferAttribute(new Float32Array(O.maxEmbers * 4), 4);
    emberGeo.setAttribute('aEmberCol', emberCol);
    const emberMesh = new THREE.InstancedMesh(emberGeo, shared.ember, O.maxEmbers);
    emberMesh.frustumCulled = false;
    emberMesh.renderOrder = 3;
    for (let i = 0; i < O.maxEmbers; i++) emberMesh.setMatrixAt(i, S.zero);
    group.add(emberMesh);
    const embers = [];
    for (let i = 0; i < O.maxEmbers; i++) {
      embers.push({
        alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        quat: new THREE.Quaternion(), size: 0.05, life: 0, maxLife: 1, hot: 0,
      });
    }
    let emberCursor = 0;
    const emitter = createRateEmitter(48);

    // ----- flickering light spill -----
    const spill = [];
    if (pal.lightGain > 0 && lights) {
      const n = Math.min(O.lightCount, Math.max(1, Math.round(total * 0.35)));
      for (let i = 0; i < n; i++) {
        const light = lights.acquire?.();
        if (!light) break;
        const f = n === 1 ? 0.6 : 0.15 + (0.85 * i) / (n - 1);
        const d = total * f;
        const s = main[Math.min(main.length - 1, Math.round((d / total) * (main.length - 1)))];
        light.position.set(s.x, s.y + 0.35, s.z);
        light.color.set(pal.light);
        light.distance = O.lightDistance * p;
        light.intensity = 0;
        spill.push({ light, dist: d, phase: rnd() * 20, last: i === n - 1 });
      }
    }

    // ----- state -----
    let grown = 0, cool = 1, flash = 0, rocksDone = false, disposed = false;

    function poseRocks(force) {
      let allDone = grown >= total + O.rockPop + 0.3;
      for (let v = 0; v < ROCK_VARIANTS; v++) {
        const list = rocksByVariant[v], mesh = rockMeshes[v];
        let dirty = force;
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          const t = (grown - r.birth) / O.rockPop;
          if (t <= 0) { if (force) mesh.setMatrixAt(i, S.zero); allDone = false; continue; }
          if (t < 1.2 || force) {
            const k = t >= 1 ? 1 : Easing.outBack(t);
            S.v.copy(r.scale).multiplyScalar(k);
            S.m.compose(r.pos, r.quat, S.v);
            mesh.setMatrixAt(i, S.m);
            dirty = true;
            if (t < 1) allDone = false;
          }
        }
        if (dirty) mesh.instanceMatrix.needsUpdate = true;
      }
      if (allDone) rocksDone = true;
    }

    function spawnEmber() {
      for (let n = 0; n < embers.length; n++) {
        emberCursor = (emberCursor + 1) % embers.length;
        if (!embers[emberCursor].alive) return embers[emberCursor];
      }
      return null;
    }

    function updateEmbers(dt) {
      const open = Math.min(grown, total);
      const n = cool > 0.05 ? emitter.take(O.emberRate * open * cool, dt) : 0;
      for (let k = 0; k < n; k++) {
        const e = spawnEmber();
        if (!e) break;
        const q = allPts[Math.floor(rnd() * allPts.length)];
        if (q.dist > grown || q.rank > u.branchFrac.value || q.walked > q.maxWalk * u.lenFrac.value) continue;
        const off = (rnd() - 0.5) * u.width.value * 0.7;
        e.alive = true;
        e.x = q.x + q.sx * off; e.y = q.y + 0.05; e.z = q.z + q.sz * off;
        e.vy = pal.emberRise[0] + rnd() * (pal.emberRise[1] - pal.emberRise[0]);
        e.vx = (rnd() - 0.5) * 0.5; e.vz = (rnd() - 0.5) * 0.5;
        S.e.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
        e.quat.setFromEuler(S.e);
        e.size = pal.emberSize[0] + rnd() * (pal.emberSize[1] - pal.emberSize[0]);
        e.maxLife = pal.emberLife[0] + rnd() * (pal.emberLife[1] - pal.emberLife[0]);
        e.life = e.maxLife;
        e.hot = rnd();
      }
      const arr = emberCol.array;
      for (let i = 0; i < embers.length; i++) {
        const e = embers[i];
        if (!e.alive) continue;
        e.life -= dt;
        if (e.life <= 0) {
          e.alive = false;
          emberMesh.setMatrixAt(i, S.zero);
          arr[i * 4 + 3] = 0;
          continue;
        }
        const drag = 1 - Math.min(0.9, dt * pal.emberDrag);
        e.vx *= drag; e.vy = e.vy * drag - pal.emberGravity * dt; e.vz *= drag;
        e.x += e.vx * dt + Math.sin(e.life * 7 + i) * dt * 0.08;
        e.y += e.vy * dt;
        e.z += e.vz * dt + Math.cos(e.life * 6 + i * 1.7) * dt * 0.08;
        const f = e.life / e.maxLife;
        S.v.setScalar(e.size * (0.5 + f * 0.5));
        S.m.compose(S.v2.set(e.x, e.y, e.z), e.quat, S.v);
        emberMesh.setMatrixAt(i, S.m);
        const b = f * f * cool;
        const o = i * 4;
        arr[o] = (pal.emberCool[0] + (pal.emberHot[0] - pal.emberCool[0]) * e.hot) * (pal.emberAdditive ? b : 1);
        arr[o + 1] = (pal.emberCool[1] + (pal.emberHot[1] - pal.emberCool[1]) * e.hot) * (pal.emberAdditive ? b : 1);
        arr[o + 2] = (pal.emberCool[2] + (pal.emberHot[2] - pal.emberCool[2]) * e.hot) * (pal.emberAdditive ? b : 1);
        arr[o + 3] = pal.emberAdditive ? 1 : b;
      }
      emberMesh.instanceMatrix.needsUpdate = true;
      emberCol.needsUpdate = true;
    }

    function updateLights(t) {
      for (let i = 0; i < spill.length; i++) {
        const sp = spill[i];
        if (grown <= sp.dist) { sp.light.intensity = 0; continue; }
        const ignite = saturate((grown - sp.dist) / 0.4);
        const fl = 0.78 + 0.16 * Math.sin(t * 13 + sp.phase) + 0.06 * Math.sin(t * 31 + sp.phase * 2.3);
        const boost = sp.last ? 1 + flash * 2.5 : 1;
        sp.light.intensity = O.lightIntensity * pal.lightGain * p * ignite * fl * cool * boost;
      }
    }

    const machine = createPhaseMachine({
      travelSpeed: O.travelSpeed, impactTime: O.impactTime, fadeTime: O.fadeTime,
      onTravel() { grown = this.u * total; },
      onImpact() { grown = total; flash = 1; inst.onImpact?.(); },
      onFade(dt, t) {
        // t runs 0..1 across IMPACT (hold) and 1..2 across FADE (cool).
        grown = total + burstReach * Easing.outCubic(saturate(t));
        flash = saturate(1 - this.phaseAge / O.flashTime) * (t < 1 ? 1 : 0);
        cool = t <= 1 ? 1 : Easing.outQuad(saturate(2 - t));
      },
      onDestroy() { inst.onDone?.(); },
    });

    const inst = {
      group, machine, onImpact: null, onDone: null,
      update(dt, t = 0) {
        const alive = machine.update(dt, t);
        u.grown.value = grown;
        u.cool.value = cool;
        u.flash.value = flash;
        u.heat.value = pal.heat * (0.25 + 0.75 * cool);
        if (!rocksDone) poseRocks(false);
        updateEmbers(dt);
        updateLights(t);
        return alive;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        machine.destroy();
        group.removeFromParent();
        for (const sp of spill) { sp.light.intensity = 0; lights.release?.(sp.light); }
        spill.length = 0;
        ribbonGeo.dispose();
        coreMat.dispose();
        underMat?.dispose();
        emberGeo.dispose();
        emberMesh.dispose();
        for (const m of rockMeshes) m.dispose();
        live.delete(inst);
      },
    };

    scene?.add(group);
    machine.spawn(line);
    grown = 0;
    poseRocks(true);
    live.add(inst);
    return inst;
  }

  return {
    cast,
    dispose() {
      for (const i of Array.from(live)) i.dispose();
      if (rockGeos) for (const g of rockGeos) g.dispose();
      rockGeos = null;
      for (const { rock, ember } of matCache.values()) { rock.dispose(); ember.dispose(); }
      matCache.clear();
    },
  };
}
