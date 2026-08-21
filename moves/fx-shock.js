/**
 * fx-shock.js — a shockwave that expands as a ring from a centre point. Unlike every other effect in
 * this set there is no main path along the cast line: the whole drawing is one annulus whose radius is
 * a uniform, so it can race outward without ever rebuilding a vertex buffer.
 *
 * Donor: fx-fissure.js, which already bakes its impact burst as a cluster of radial cracks revealed by
 * one monotonic `uGrown` uniform advancing past the line's end. This module promotes that trick to be
 * the whole effect — the "burst" IS the move — and borrows fx-aurora.js's closed-ring construction (an
 * integer-harmonic column jitter so the seam at angle 0/2*PI is invisible) for the ring geometry itself.
 *
 * Geometry: `buildRing` (move-parts) samples one column per angle at the cast's resting radius, giving a
 * direction cosine and a baked terrain height per column. Each column is repeated over a few rows that
 * span the ring's *cross-section*, not its radius — a vertex at row-fraction `aV` sits at world radius
 * `uRadius + aV * width`, so growing `uRadius` slides the whole annulus outward without stretching its
 * width the way scaling the mesh would (`aV` is unitless and `width` is a constant, so widening never
 * happens by accident). `aV` near 1 is the outer, leading edge; `colorNode` makes that edge the brightest
 * point, same as the fissure ribbon's white-hot front. The vertical lift blends from flat (at the centre)
 * to the baked terrain sample as the ring nears its resting radius — an approximation, not a live terrain
 * sample, since nothing in TSL can call the injected `terrainHeight()` per vertex; a ring that raced across
 * wildly uneven ground would visibly float or dig in in the last few metres of travel.
 *
 * Sonic wanting several rings from one cast decided the whole shape of this module: `buildRingGeometry`
 * runs once and up to three materials are built against the same geometry, each closing over the shared
 * `uRadius` uniform minus its own constant offset, the way fx-aurora draws its curtain twice (front sheet,
 * de-phased back sheet) and fx-bolt draws its ribbon twice (glow pass, hot core) rather than building
 * per-instance geometry.
 *
 * Layers, gated per palette:
 *  - RING(S) — the annulus above, additive for blast/sonic/electric, lit-but-flat for quake/wave.
 *  - GROUND CRACKS (quake only) — `radialWalks` from the centre, a ribbon in the same shape as fissure's
 *    branches, revealed by `smoothstep(0, w, uRadius - aDist)`: the same expanding radius that grows the
 *    ring also tears the cracks open, so there is only ever one growth uniform to drive.
 *  - DUST — `createSpriteParticles`, emitted along the advancing front while it is still growing.
 *  - DEBRIS — `createDebrisPool` over `makeRockGeometry`, for palettes that throw up rock (blast, quake).
 *  - LIGHTS — zero to two pooled point lights, fixed at the centre, breathing with the impact flash.
 *
 * The centre defaults to the caster (`line.origin`) per the brief, with `options.centre` (or a per-cast
 * override) able to select `'target'` instead; none of the shipped palettes use the target. These are
 * area moves cast on a two-fighter demo that only understands one hit target, so the ring's true area
 * reach is cosmetic — `onImpact` still just fires once at `u = 1`, same as every other effect here.
 *
 * `sourceY`/`targetY` are accepted but unused: this is a ground effect like fx-fissure.
 */

import { createPhaseMachine, mulberry32, Easing, saturate, createRateEmitter } from './move-core.js';
import { buildRing, radialWalks, createSpriteParticles, createDebrisPool, makeRockGeometry } from './move-parts.js';

const TAU = Math.PI * 2;

/** Named looks. Colors are linear HDR triples (values above 1 are additive headroom), like fx-fissure. */
export const PALETTES = {
  blast: { // Explosion, Self-Destruct — fast, violent, white-hot fading to smoke.
    ringCount: 1, ringWidth: 1.0, crestHeight: 0.4, additive: true, flicker: false,
    base: [0.05, 0.02, 0.01], rim: [1.3, 0.28, 0.03], mid: [3.2, 1.0, 0.15], core: [4.6, 3.7, 2.0],
    maxRadius: 8, baseRadius: 6.5,
    cracks: 0, crackColor: null,
    dust: { color: 0xffcf8a, base: 0x2a1206, size: [0.18, 0.5], rate: 70, gravity: 5, drag: 1.1, upSpeed: [2.2, 5.0] },
    debris: { rock: 0x241a12, count: 22, speed: 5.5, gravity: -15, size: 0.08 },
    lightColor: 0xff5522, lightCount: 2, lightGain: 1, flashPower: 1,
    travelTime: 0.32, impactTime: 0.35, fadeTime: 0.85,
  },
  quake: { // Magnitude, Bulldoze, Earthquake — slow brown wave, heavy rock, cracks, no glow.
    ringCount: 1, ringWidth: 1.7, crestHeight: 0.1, additive: false, flicker: false,
    base: [0.02, 0.014, 0.009], rim: [0.05, 0.035, 0.02], mid: [0.09, 0.065, 0.04], core: [0.15, 0.11, 0.07],
    maxRadius: 8.5, baseRadius: 8.5,
    cracks: 11, crackColor: [0.02, 0.012, 0.006],
    dust: { color: 0xcbb896, base: 0x35291a, size: [0.3, 0.75], rate: 26, gravity: 9, drag: 1.7, upSpeed: [0.5, 1.6] },
    debris: { rock: 0x554635, count: 46, speed: 3.2, gravity: -13, size: 0.15 },
    lightColor: 0x8a7550, lightCount: 0, lightGain: 0, flashPower: 0,
    travelTime: 1.5, impactTime: 1.0, fadeTime: 1.7,
  },
  sonic: { // Boomburst, Hyper Voice, Screech, Round — two or three thin rings, nearly colourless.
    ringCount: 3, ringGap: 0.9, ringWidth: 0.22, crestHeight: 0.04, additive: true, flicker: false,
    base: [0, 0, 0], rim: [0.25, 0.28, 0.35], mid: [0.6, 0.65, 0.75], core: [1.0, 1.0, 1.05],
    maxRadius: 8.8, baseRadius: 8.8,
    cracks: 0, crackColor: null,
    dust: null, debris: null,
    lightColor: 0xbfd8ff, lightCount: 1, lightGain: 0.35, flashPower: 0.3,
    travelTime: 0.5, impactTime: 0.25, fadeTime: 0.45,
  },
  wave: { // Surf, Muddy Water — a tall crest rolling outward, spray, no cracks.
    ringCount: 1, ringWidth: 1.2, crestHeight: 1.3, additive: false, flicker: false,
    base: [0.01, 0.05, 0.12], rim: [0.03, 0.22, 0.42], mid: [0.15, 0.55, 0.82], core: [0.6, 0.95, 1.02],
    maxRadius: 8, baseRadius: 6.2,
    cracks: 0, crackColor: null,
    dust: { color: 0xe4f8ff, base: 0x9fd8ee, size: [0.12, 0.32], rate: 55, gravity: 6.5, drag: 0.9, upSpeed: [1.7, 3.6] },
    debris: null,
    lightColor: 0x53c8ff, lightCount: 1, lightGain: 0.55, flashPower: 0.15,
    travelTime: 0.85, impactTime: 0.55, fadeTime: 1.05,
  },
  electric: { // Discharge — fell out cheaply: sonic's multi-ring rig with a flicker term and a blue tint.
    ringCount: 2, ringGap: 0.45, ringWidth: 0.3, crestHeight: 0.08, additive: true, flicker: true,
    base: [0, 0, 0.02], rim: [0.15, 0.3, 1.0], mid: [0.7, 0.9, 3.0], core: [2.4, 2.6, 4.6],
    maxRadius: 8, baseRadius: 7.2,
    cracks: 0, crackColor: null,
    dust: null, debris: null,
    lightColor: 0x9fd0ff, lightCount: 2, lightGain: 0.9, flashPower: 0.6,
    travelTime: 0.4, impactTime: 0.3, fadeTime: 0.5,
  },
  petal: { // Petal Blizzard — also fell out cheaply: the wave rig with pink petals instead of spray.
    ringCount: 1, ringWidth: 1.0, crestHeight: 0.35, additive: false, flicker: false,
    base: [0.12, 0.03, 0.08], rim: [0.55, 0.12, 0.32], mid: [0.85, 0.32, 0.55], core: [1.0, 0.55, 0.75],
    maxRadius: 7.5, baseRadius: 6,
    cracks: 0, crackColor: null,
    dust: { color: 0xffb0d8, base: 0xff6fa8, size: [0.22, 0.5], rate: 60, gravity: 1.3, drag: 2.2, upSpeed: [1.1, 2.4] },
    debris: null,
    lightColor: 0xff9fd0, lightCount: 1, lightGain: 0.45, flashPower: 0.15,
    travelTime: 0.65, impactTime: 0.5, fadeTime: 0.9,
  },
};
PALETTES.default = PALETTES.blast;

const DEFAULTS = {
  segments: 72,        // ring columns
  rows: 4,             // cross-section samples (inner→outer)
  pathStep: 0.18,      // crack walk step
  crackWidth: 0.22,
  lightIntensity: 9,
  radiusPower: 0.4,    // power -> reach exponent
};

export function createShockFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, terrainHeight = () => 0, lights } = deps;
  const O = { ...DEFAULTS, ...options };
  const defaultCentre = options.centre === 'target' ? 'target' : 'origin';
  const { attribute, uniform, float, vec3, mix, smoothstep, positionLocal, abs, time } = TSL;

  const live = new Set();

  /** Closed ring strip: `rows` cross-section samples per column, direction + baked terrain per column. */
  function buildRingGeometry(ring, rows, jitPhase) {
    const cols = ring.length;
    const n = cols * rows;
    const pos = new Float32Array(n * 3); // unused by the shader; keeps the geometry a valid buffer
    const dir = new Float32Array(n * 3);
    const vs = new Float32Array(n);
    const terrY = new Float32Array(n);
    const jits = new Float32Array(n);
    const idx = [];
    for (let i = 0; i < cols; i++) {
      const p = ring[i];
      const a = p.u * TAU;
      // Integer harmonics only (3, 5), the fx-aurora trick that keeps a closed ring seamless.
      const jit = 1 + 0.14 * Math.sin(a * 3 + jitPhase[0]) + 0.08 * Math.sin(a * 5 + jitPhase[1]);
      for (let r = 0; r < rows; r++) {
        const vi = i * rows + r;
        dir[vi * 3] = p.sx; dir[vi * 3 + 1] = 0; dir[vi * 3 + 2] = p.sz;
        vs[vi] = r / (rows - 1);
        terrY[vi] = p.y;
        jits[vi] = jit;
      }
    }
    for (let i = 0; i < cols - 1; i++) {
      for (let r = 0; r < rows - 1; r++) {
        const a = i * rows + r, b = (i + 1) * rows + r;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aV', new THREE.BufferAttribute(vs, 1));
    geo.setAttribute('aTerrainY', new THREE.BufferAttribute(terrY, 1));
    geo.setAttribute('aColJit', new THREE.BufferAttribute(jits, 1));
    geo.setIndex(idx);
    return geo;
  }

  /** Radial crack ribbon, group-local. Needle tips at both the centre and the outer end (fissure's pinch). */
  function buildCrackGeometry(walks) {
    const positions = [], sides = [], acrosses = [], dists = [], tapers = [];
    const indices = [];
    const pinch = 0.3;
    for (const path of walks) {
      const base = positions.length / 3;
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        const edgeDist = Math.min(p.walked, p.maxWalk - p.walked);
        const taper = Math.pow(saturate(edgeDist / pinch), 0.6);
        for (let k = 0; k < 2; k++) {
          positions.push(p.x, p.y + 0.03, p.z);
          sides.push(p.sx, 0, p.sz);
          acrosses.push(k === 0 ? -1 : 1);
          dists.push(p.dist);
          tapers.push(taper);
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
    geo.setAttribute('aAcross', new THREE.Float32BufferAttribute(acrosses, 1));
    geo.setAttribute('aDist', new THREE.Float32BufferAttribute(dists, 1));
    geo.setAttribute('aTaper', new THREE.Float32BufferAttribute(tapers, 1));
    geo.setIndex(indices);
    return geo;
  }

  /** One ring material bound to the shared geometry; `radiusOffset` is what makes N rings out of one mesh. */
  function buildRingMaterial(u, pal, radiusOffset) {
    const mat = new NODES.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    if (pal.additive) mat.blending = THREE.AdditiveBlending;
    mat.toneMapped = false;

    const aDir = attribute('aDir', 'vec3');
    const aV = attribute('aV', 'float');
    const aTerrainY = attribute('aTerrainY', 'float');
    const aColJit = attribute('aColJit', 'float');

    const ringR = u.radius.sub(float(radiusOffset)).max(0);
    const worldR = ringR.add(aV.mul(u.width));
    const heightBlend = ringR.div(u.settle).clamp(0, 1);
    // Crest shaping: height rises toward the leading (outer) edge, and only once the ring is moving.
    const crest = aV.pow(1.6).mul(smoothstep(0, 0.15, ringR));
    const py = mix(float(0), aTerrainY, heightBlend).add(crest.mul(u.crestHeight).mul(aColJit)).add(0.02);
    mat.positionNode = vec3(aDir.x.mul(worldR), py, aDir.z.mul(worldR));

    // Leading-edge brightness: aV near 1 (outer edge) is the hottest part of the wavefront.
    const edge = smoothstep(0.15, 1, aV).pow(2.2);
    const trail = float(1).sub(aV);
    let color = mix(vec3(...pal.base), vec3(...pal.rim), trail.oneMinus());
    color = mix(color, vec3(...pal.mid), smoothstep(0.1, 0.7, aV));
    color = mix(color, vec3(...pal.core), edge);
    if (pal.flicker) {
      // CPU never mirrors this: it is a pure GPU-side flicker keyed off column direction, not a position.
      const flick = time.mul(41).add(aDir.x.mul(17)).add(aDir.z.mul(11)).sin().mul(0.5).add(0.5).pow(5).mul(1.5).add(0.25);
      color = color.mul(flick);
    }
    mat.colorNode = color.mul(u.brightness);

    const openness = smoothstep(0, 0.04, ringR);
    mat.opacityNode = trail.mul(0.35).add(edge.mul(0.75)).mul(openness).mul(u.opacity);
    return mat;
  }

  /** Cracks light up only where the shared radius uniform has already passed them — zero extra uniforms. */
  function buildCrackMaterial(u, pal) {
    const mat = new NODES.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.toneMapped = false;
    const aSide = attribute('aSide', 'vec3');
    const aAcross = attribute('aAcross', 'float');
    const aDist = attribute('aDist', 'float');
    const aTaper = attribute('aTaper', 'float');
    mat.positionNode = positionLocal.add(aSide.mul(aAcross.mul(float(O.crackWidth * 0.5))).mul(aTaper));
    const openness = smoothstep(0, 0.35, u.radius.sub(aDist));
    const edge = abs(aAcross).oneMinus();
    mat.colorNode = vec3(...(pal.crackColor || pal.base));
    mat.opacityNode = openness.mul(edge).mul(aTaper).mul(u.opacity);
    return mat;
  }

  function cast({ line, seed = 1, palette = 'default', power = 1, centre } = {}) {
    const pal = PALETTES[palette] || PALETTES.default;
    const rnd = mulberry32(seed >>> 0 || 1);
    const p = Math.max(0.15, power);
    const which = centre === 'target' || centre === 'origin' ? centre : defaultCentre;
    const originPt = which === 'target' ? line.target : line.origin;

    const group = new THREE.Group();
    group.position.set(originPt.x, originPt.y, originPt.z);
    scene?.add(group);

    const reach = Math.min(pal.maxRadius, pal.baseRadius * Math.pow(p, O.radiusPower));
    const jitPhase = [rnd() * TAU, rnd() * TAU];
    const ring = buildRing({ segments: O.segments, radius: reach, ox: originPt.x, oy: originPt.y, oz: originPt.z, terrainHeight });
    const ringGeo = buildRingGeometry(ring, O.rows, jitPhase);

    const u = {
      radius: uniform(0), opacity: uniform(1), brightness: uniform(1),
      width: float(pal.ringWidth), settle: float(Math.max(0.5, reach)), crestHeight: float(pal.crestHeight),
    };

    const ringMats = [];
    const ringCount = Math.max(1, pal.ringCount || 1);
    const ringGap = pal.ringGap || 0;
    for (let i = 0; i < ringCount; i++) {
      const mat = buildRingMaterial(u, pal, i * ringGap);
      ringMats.push(mat);
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      group.add(mesh);
    }

    let crackGeo = null, crackMat = null;
    if (pal.cracks > 0) {
      const walks = radialWalks({
        x: originPt.x, z: originPt.z, count: pal.cracks, rnd, terrainHeight, baseDist: 0, step: O.pathStep,
        length: reach * 0.95, lengthMin: 0.6, lengthMax: 1.05, curvatureScale: 1.4, angleJitter: 0.4,
      });
      for (const path of walks) for (const q of path) { q.x -= originPt.x; q.y -= originPt.y; q.z -= originPt.z; }
      crackGeo = buildCrackGeometry(walks);
      crackMat = buildCrackMaterial(u, pal);
      const crackMesh = new THREE.Mesh(crackGeo, crackMat);
      crackMesh.frustumCulled = false;
      crackMesh.renderOrder = 1;
      group.add(crackMesh);
    }

    let dustKit = null;
    if (pal.dust) {
      dustKit = createSpriteParticles({
        THREE, TSL, NODES, cap: 90, colorA: pal.dust.color, colorB: pal.dust.base,
        gravity: -pal.dust.gravity, drag: pal.dust.drag, additive: !!pal.additive,
      });
      dustKit.mesh.renderOrder = 3;
      group.add(dustKit.mesh);
    }
    const dustEmitter = createRateEmitter(60);

    // fx-crystals' rock chunk generaliseed into move-parts' makeRockGeometry/createDebrisPool.
    let debrisGeo = null, debrisMat = null, debrisKit = null;
    if (pal.debris) {
      debrisGeo = makeRockGeometry(THREE, rnd);
      debrisMat = new NODES.MeshStandardNodeMaterial({ color: pal.debris.rock, roughness: 1, metalness: 0 });
      debrisKit = createDebrisPool({
        THREE, geometry: debrisGeo, material: debrisMat, max: pal.debris.count,
        gravity: pal.debris.gravity, size: pal.debris.size, rnd,
      });
      debrisKit.mesh.renderOrder = 2;
      group.add(debrisKit.mesh);
    }
    const debrisEmitter = createRateEmitter(20);

    const spill = [];
    if (pal.lightGain > 0 && lights) {
      for (let i = 0; i < pal.lightCount; i++) {
        const light = lights.acquire?.();
        if (!light) break;
        light.color.set(pal.lightColor);
        light.distance = reach * 1.3;
        light.intensity = 0;
        light.position.set(originPt.x, originPt.y + 0.4, originPt.z);
        spill.push({ light, phase: rnd() * 20 });
      }
    }

    let grown = 0, fade = 0, flash = 0, disposed = false;

    function updateDust(dt) {
      if (!dustKit) return;
      if (grown < reach - 0.05) {
        const n = dustEmitter.take(pal.dust.rate, dt);
        for (let k = 0; k < n; k++) {
          const a = rnd() * TAU;
          const r = Math.max(0, grown + (rnd() - 0.5) * 0.25);
          const wx = originPt.x + Math.cos(a) * r, wz = originPt.z + Math.sin(a) * r;
          const gy = terrainHeight(wx, wz) - originPt.y;
          const speed = pal.dust.upSpeed[0] + rnd() * (pal.dust.upSpeed[1] - pal.dust.upSpeed[0]);
          const size = pal.dust.size[0] + rnd() * (pal.dust.size[1] - pal.dust.size[0]);
          dustKit.emit(
            wx - originPt.x, gy + 0.05, wz - originPt.z,
            Math.cos(a) * speed * 0.25, speed, Math.sin(a) * speed * 0.25,
            size, 0.5 + rnd() * 0.6,
          );
        }
      }
      dustKit.step(dt);
    }

    function updateDebris(dt) {
      if (!debrisKit) return;
      if (grown < reach - 0.05) {
        const n = debrisEmitter.take(pal.debris.count * 0.6, dt);
        if (n > 0) {
          const a = rnd() * TAU;
          const wx = originPt.x + Math.cos(a) * grown, wz = originPt.z + Math.sin(a) * grown;
          const gy = terrainHeight(wx, wz) - originPt.y;
          debrisKit.emit(wx - originPt.x, gy, wz - originPt.z, n, pal.debris.speed);
        }
      }
      debrisKit.step(dt);
    }

    function updateLights(t) {
      for (const sp of spill) {
        const ignite = saturate(grown / 0.5);
        const fl = 0.85 + 0.15 * Math.sin(t * 13 + sp.phase);
        sp.light.intensity = pal.lightGain * O.lightIntensity * ignite * fl * (1 - fade) * (1 + flash * (pal.flashPower || 0) * 2);
      }
    }

    const machine = createPhaseMachine({
      travelTime: pal.travelTime, impactTime: pal.impactTime, fadeTime: pal.fadeTime, easeIn: 0.04,
      onTravel() { grown = Easing.outCubic(this.u) * reach; },
      onImpact() { flash = 1; inst.onImpact?.(); },
      onFade(dt, t) {
        // t runs 0..1 across IMPACT (hold at full reach) and 1..2 across FADE (small overshoot + dim out).
        if (t <= 1) { grown = reach; flash = saturate(1 - this.phaseAge / 0.25); fade = 0; }
        else { const ft = saturate(t - 1); grown = reach + 0.3 * Easing.outCubic(ft); flash = 0; fade = Easing.outQuad(ft); }
      },
      onDestroy() { inst.onDone?.(); },
    });

    const inst = {
      group, machine, onImpact: null, onDone: null,
      reach, // not part of the contract; exposed only so tests can check the radius cap without a GPU
      update(dt, t = 0) {
        const alive = machine.update(dt, t);
        u.radius.value = grown;
        u.opacity.value = 1 - fade;
        u.brightness.value = 1 + flash * 1.5;
        updateDust(dt);
        updateDebris(dt);
        updateLights(t);
        return alive;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        machine.destroy();
        group.removeFromParent();
        for (const sp of spill) { sp.light.intensity = 0; lights?.release?.(sp.light); }
        spill.length = 0;
        ringGeo.dispose();
        for (const m of ringMats) m.dispose();
        crackGeo?.dispose(); crackMat?.dispose();
        dustKit?.dispose();
        // createDebrisPool.dispose() calls mesh.dispose(), which InstancedMesh does not implement — see
        // the report; disposing the geometry/material we own directly sidesteps that shared-file bug.
        debrisGeo?.dispose(); debrisMat?.dispose();
        live.delete(inst);
      },
    };

    machine.spawn(line);
    grown = 0;
    live.add(inst);
    return inst;
  }

  return {
    cast,
    dispose() {
      for (const i of Array.from(live)) i.dispose();
    },
  };
}
