/**
 * fx-bolt.js — Thunderbolt. A lightning bolt thrown from the attacker's mouth to the target's.
 *
 * Ported from LinearAbiltyCastingThreeJS (WebGL/GLSL) to TSL:
 *   materials/LightningMaterial.js  → the two node materials built by `boltMaterial()`
 *   assets/ProceduralGeometry.js    → `boltGeometry()` (createBoltRibbonGeometry)
 *   abilities/ThunderAbility.js     → the cast orchestration below
 *
 * The whole bolt lives in the vertex stage. A vertex arrives as `(t, side)` — how far along the bolt
 * it is and which edge of the ribbon it sits on — and leaves as a position. Three things stack to make
 * the shape:
 *
 *   1. the axis — mix(origin, target, t), bowed by `sag`. The only part that knows where the cast points.
 *   2. the fan  — a per-filament offset in the plane perpendicular to the axis, opening from `spreadNear`
 *      at the mouth to `spread` at the target and rolling around the axis with `twist`.
 *   3. the kinks — octaves of *linearly* interpolated value noise. Linear on purpose: smoothstep would
 *      round the corners off, and the corners are the whole reason it reads as lightning.
 *
 * The ribbon then turns to face the camera by crossing the local tangent with the view vector, so it
 * keeps its apparent thickness from any angle without being a screen-space line. `uProgress` clips the
 * undrawn tip in the fragment rather than scaling the ribbon, so the *shape* never changes as the strike
 * front travels — only how much of it exists.
 *
 * Two meshes share one geometry: a wide soft halo (renderOrder first) and the hot core on top. Drawing
 * the halo as real ribbon rather than faking it with bloom keeps the glow attached to every kink.
 *
 * Deviations from the reference, and why:
 *   - The perpendicular frame (n1/n2) and the span are computed on the CPU at cast time and uploaded as
 *     uniforms. The reference Gram-Schmidts them per vertex because its editor moves the cast live; here
 *     the line is fixed for the cast, so it is the same math one place cheaper.
 *   - `hash11`, `vnoise`, `kink` and `boltPoint` are plain JS helpers that emit TSL nodes. They are only
 *     ever called from inside an `Fn` body, which is what makes their `toVar()` calls legal.
 *   - No soft depth fade (the reference samples a depth prepass this harness does not have).
 *   - Particles are 200 CPU-driven crossed quads instead of a GPU particle engine. Crossed rather than
 *     flat because deps hands us no camera, so a single quad would vanish edge-on.
 *
 * Materials are pooled per palette and handed back on dispose, so a repeated cast does not recompile.
 *
 * The bolt is placed in world coordinates by `positionNode`, and `cameraPosition` is world space, so the
 * group this returns must stay at the origin with an identity transform. Nothing here ever moves it.
 */

import { createPhaseMachine, mulberry32, Easing, saturate, createRateEmitter } from './move-core.js';

const TAU = 6.283185307179586;

export const PALETTES = {
  /** Thunderbolt: yellow-white core inside a blue-violet halo. */
  electric: {
    core: '#fffbdc', inner: '#cfe0ff', outer: '#4f6cff', halo: '#160a7a',
    spark: '#ffe9a8', light: '#7aa2ff', muzzle: '#dfe8ff', impact: '#bcd4ff',
  },
  /** Dark Pulse: violet core bleeding into black-purple. */
  dark: {
    core: '#d9a6ff', inner: '#9b46f5', outer: '#4a10a0', halo: '#0d0016',
    spark: '#c07bff', light: '#8a3cf0', muzzle: '#b070ff', impact: '#7a20d0',
  },
  /** Fairy: pink-white, softer halo. */
  fairy: {
    core: '#ffffff', inner: '#ffd6ef', outer: '#ff77c4', halo: '#7a1050',
    spark: '#ffc2e6', light: '#ff8fd0', muzzle: '#ffd9f0', impact: '#ff9fd8',
  },
};
PALETTES.default = PALETTES.electric;

export const DEFAULTS = {
  // shape
  nodes: 72, strands: 10, maxStrands: 24,
  sag: 0.25, restrike: 24, originForward: 0.25,
  spread: 0.55, spreadNear: 0.05, spreadCurve: 1.6, twist: 0.45, twistSpeed: 0.8, branchDim: 0.72,
  jitter: 0.3, jitterScale: 0.85, octaves: 4, jitterFalloff: 0.55, crawl: 3.2, pinch: 0.14, converge: 0.85,
  // ribbon
  width: 0.075, widthTip: 0.5, widthCurve: 1, coreWidth: 2.1, coreSharp: 3.4, glowFalloff: 2.4,
  glowWidth: 8, glowOpacity: 0.32, opacity: 1, glow: 2.3,
  flicker: 0.3, flickerSpeed: 34, strandFlash: 0.5, tipGlow: 2, tipLength: 0.08,
  // timing
  travelSpeed: 90, travelTime: 0, holdTime: 0.35, fadeTime: 0.45,
  // flashes and light
  muzzleSize: 0.45, muzzleLife: 0.22, impactSize: 0.95, impactLife: 0.4,
  lightIntensity: 26, lightDistance: 14, lightFlicker: 0.45, lightFlickerSpeed: 30,
  // sparks
  sparks: true, sparkCap: 200, sparkRate: 150, sparkSize: 0.06, sparkLife: 0.45,
  sparkSpeed: 4.2, sparkGravity: -9, sparkDrag: 1.6,
};

/**
 * @param {object} deps { THREE, TSL, NODES, scene, terrainHeight, lights }
 * @param {object} options overrides for DEFAULTS
 */
export function createBoltFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, lights } = deps;
  const O = Object.assign({}, DEFAULTS, options);
  const {
    Fn, attribute, uniform, positionGeometry, cameraPosition, time,
    float, vec2, vec3, mix, smoothstep, step, pow, floor, fract, sin, cos,
    normalize, cross, length, max, clamp,
  } = TSL;

  const SPARK_CAP = Math.max(1, Math.round(O.sparkCap));
  const scratch = { v: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), c: new THREE.Color() };

  /* ------------------------------------------------------------------ */
  /* Geometry — parameter space only, one ladder strip per filament       */
  /* ------------------------------------------------------------------ */

  const geoCache = new Map();
  function boltGeometry(strands) {
    let g = geoCache.get(strands);
    if (g) return g;
    const steps = Math.max(2, Math.round(O.nodes));
    const positions = new Float32Array(steps * 2 * 3);
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1), o = i * 6;
      positions[o] = t; positions[o + 1] = -1;
      positions[o + 3] = t; positions[o + 4] = 1;
    }
    const indices = new Uint16Array((steps - 1) * 6);
    for (let i = 0; i < steps - 1; i++) {
      const a = i * 2, o = i * 6;
      indices[o] = a; indices[o + 1] = a + 1; indices[o + 2] = a + 2;
      indices[o + 3] = a + 1; indices[o + 4] = a + 3; indices[o + 5] = a + 2;
    }
    const strand = new Float32Array(strands);
    for (let i = 0; i < strands; i++) strand[i] = i;
    g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aStrand', new THREE.InstancedBufferAttribute(strand, 1));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.instanceCount = strands;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4); // placed in the shader, never culled
    geoCache.set(strands, g);
    return g;
  }

  const flashGeo = new THREE.IcosahedronGeometry(1, 2);

  /** Two perpendicular quads, so a spark is never invisible edge-on. */
  function sparkGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
      0, -0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, -0.5,
    ]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    return g;
  }
  const sparkGeo = sparkGeometry();

  /* ------------------------------------------------------------------ */
  /* Materials                                                           */
  /* ------------------------------------------------------------------ */

  const aStrand = attribute('aStrand', 'float');

  /** hash11 from the reference noise lib — sharp, cheap, takes fractional input. */
  const hash11 = (p) => {
    const a = fract(p.mul(0.1031)).toVar();
    const b = a.mul(a.add(33.33)).toVar();
    const c = b.mul(b.add(b)).toVar();
    return fract(c);
  };

  /** Value noise with a *linear* ramp: piecewise-linear output, hard corners. */
  const vnoise = (x, seed) => {
    const i = floor(x).toVar();
    return mix(hash11(i.add(seed)), hash11(i.add(1).add(seed)), x.sub(i)).mul(2).sub(1);
  };

  function boltMaterial(u, isGlow) {
    const widthScale = isGlow ? O.glowWidth : 1;
    const passOpacity = isGlow ? O.glowOpacity : 1;

    // Offset of one filament from the axis. uJitterScale stays kinks per metre at any range.
    const kink = (t, seed) => {
      let ox = float(0).toVar(), oy = float(0).toVar();
      let amp = float(1).toVar();
      let freq = max(u.uJitterScale, float(0.01)).mul(u.uSpan).toVar();
      let scroll = time.mul(u.uCrawl).toVar();
      for (let i = 0; i < 5; i++) { // fixed trip count with a per-octave gate, as in the reference
        const on = step(float(i), u.uOctaves.sub(1));
        ox = ox.add(on.mul(amp).mul(vnoise(t.mul(freq).add(scroll), seed.add(13 * i)))).toVar();
        oy = oy.add(on.mul(amp).mul(vnoise(t.mul(freq).add(scroll.mul(1.17)), seed.add(71.3 + 13 * i)))).toVar();
        amp = amp.mul(u.uJitterFalloff).toVar();
        freq = freq.mul(2).toVar();
        scroll = scroll.mul(1.63).toVar();
      }
      return vec2(ox, oy);
    };

    const boltPoint = (t, seed, radial) => {
      const axis = mix(u.uOrigin, u.uTarget, t).add(vec3(0, u.uSag.mul(sin(t.mul(Math.PI))), 0));
      // Pinned at the mouth always, and at the target as hard as uConverge asks.
      const pinch = max(u.uPinch, float(1e-3));
      const ends = smoothstep(float(0), pinch, t)
        .mul(mix(float(1), smoothstep(float(0), pinch, t.oneMinus()), clamp(u.uConverge, 0, 1)));
      const off = kink(t, seed).mul(u.uJitter).mul(ends).toVar();
      const angle = seed.mul(TAU).add(t.mul(u.uTwist).add(time.mul(u.uTwistSpeed)).mul(TAU));
      const reach = mix(u.uSpreadNear, u.uSpread, pow(clamp(t, 0, 1), max(u.uSpreadCurve, float(0.01))));
      off.addAssign(vec2(cos(angle), sin(angle)).mul(reach).mul(radial));
      return axis.add(u.uN1.mul(off.x)).add(u.uN2.mul(off.y));
    };

    // The strike index snaps every filament onto a new shape uRestrike times a second; the crawl inside
    // kink() slides it continuously in between. Both are what stops a held bolt reading as a static ribbon.
    const strandSeed = () => hash11(aStrand.mul(7.13).add(u.uSeed).add(floor(time.mul(max(u.uRestrike, float(0.01)))).mul(3.77))).mul(97);
    const radialOf = () => aStrand.div(max(u.uStrands.sub(1), float(1)));
    const flashOf = () => mix(float(1), hash11(floor(time.mul(u.uFlickerSpeed)).add(aStrand.mul(3.7)).add(u.uSeed)), u.uStrandFlash);

    const material = new NODES.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = true;
    material.blending = THREE.AdditiveBlending;
    material.side = THREE.DoubleSide;
    material.toneMapped = false;

    material.positionNode = Fn(() => {
      const t = positionGeometry.x.toVar();
      const edge = positionGeometry.y;
      const seed = strandSeed().toVar();
      const radial = radialOf().toVar();
      const here = boltPoint(t, seed, radial).toVar();

      // Tangent by finite difference, mirrored at the far end so the last node has a neighbour.
      const stp = float(0.02);
      const flip = float(1).sub(step(float(1), t.add(stp)).mul(2)).toVar();
      const ahead = boltPoint(t.add(stp.mul(flip)), seed, radial);
      const tangent = normalize(ahead.sub(here).mul(flip).add(u.uDir.mul(1e-4))).toVar();

      const toCamera = normalize(cameraPosition.sub(here));
      const bn = cross(tangent, toCamera).toVar();
      const bl = length(bn).toVar();
      const binormal = mix(u.uN1, bn.div(max(bl, float(1e-4))), step(float(1e-4), bl)).toVar();

      const halfWidth = u.uWidth.mul(widthScale)
        .mul(mix(float(1), u.uWidthTip, pow(clamp(t, 0, 1), max(u.uWidthCurve, float(0.01)))))
        .mul(mix(u.uCoreWidth, float(1), radial))
        .mul(flashOf()).mul(u.uFade);

      return here.add(binormal.mul(edge).mul(halfWidth));
    })();

    // Cross-ribbon profile. Attributes used in the fragment stage auto-varying, so vT/vSide/aStrand
    // come straight off positionGeometry instead of hand-written varyings.
    const profileOf = () => {
      const v = clamp(positionGeometry.y.abs(), 0, 1);
      return pow(v.oneMinus(), max(isGlow ? u.uGlowFalloff : u.uCoreSharp, float(0.05)));
    };
    const drawnOf = () => {
      const tip = max(u.uTipLength, float(1e-3));
      return smoothstep(float(0), float(1), clamp(u.uProgress.sub(positionGeometry.x).div(tip), 0, 1));
    };

    material.colorNode = Fn(() => {
      const profile = profileOf().toVar();
      const base = isGlow
        ? mix(u.uColorHalo, u.uColorOuter, profile)
        : mix(mix(u.uColorOuter, u.uColorInner, smoothstep(float(0), float(0.5), profile)), u.uColorCore, smoothstep(float(0.45), float(1), profile));
      const tip = max(u.uTipLength, float(1e-3));
      // The leading edge is where the air is actually breaking down.
      const front = smoothstep(u.uProgress.sub(tip.mul(2)), u.uProgress, positionGeometry.x);
      return base.add(u.uColorCore.mul(front).mul(u.uTipGlow)).mul(u.uGlow);
    })();

    material.opacityNode = Fn(() => {
      // Quantised, not sinusoidal: real lightning stutters between brightnesses, it does not breathe.
      const flicker = float(1).sub(u.uFlicker.mul(hash11(floor(time.mul(u.uFlickerSpeed)).add(u.uSeed))));
      return profileOf().mul(drawnOf()).mul(flicker).mul(flashOf()).mul(u.uFade)
        .mul(passOpacity).mul(u.uOpacity)
        .mul(mix(float(1), clamp(u.uBranchDim, 0, 1), radialOf()));
    })();

    return material;
  }

  function additiveMaterial(color) {
    const m = new NODES.MeshBasicNodeMaterial();
    m.color = new THREE.Color(color);
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
    m.toneMapped = false;
    m.opacity = 0;
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* Rigs — one full set of meshes per live cast, pooled by palette       */
  /* ------------------------------------------------------------------ */

  const pool = new Map();

  function buildRig(palName) {
    const pal = PALETTES[palName] || PALETTES.default;
    const u = {
      uOrigin: uniform(new THREE.Vector3()), uTarget: uniform(new THREE.Vector3(0, 0, 1)),
      uDir: uniform(new THREE.Vector3(0, 0, 1)), uN1: uniform(new THREE.Vector3(1, 0, 0)), uN2: uniform(new THREE.Vector3(0, 1, 0)),
      uSpan: uniform(1), uSag: uniform(O.sag), uSeed: uniform(0), uProgress: uniform(0), uFade: uniform(1),
      uStrands: uniform(O.strands), uRestrike: uniform(O.restrike),
      uSpread: uniform(O.spread), uSpreadNear: uniform(O.spreadNear), uSpreadCurve: uniform(O.spreadCurve),
      uTwist: uniform(O.twist), uTwistSpeed: uniform(O.twistSpeed), uBranchDim: uniform(O.branchDim),
      uJitter: uniform(O.jitter), uJitterScale: uniform(O.jitterScale), uOctaves: uniform(O.octaves),
      uJitterFalloff: uniform(O.jitterFalloff), uCrawl: uniform(O.crawl), uPinch: uniform(O.pinch), uConverge: uniform(O.converge),
      uWidth: uniform(O.width), uWidthTip: uniform(O.widthTip), uWidthCurve: uniform(O.widthCurve),
      uCoreWidth: uniform(O.coreWidth), uCoreSharp: uniform(O.coreSharp), uGlowFalloff: uniform(O.glowFalloff),
      uFlicker: uniform(O.flicker), uFlickerSpeed: uniform(O.flickerSpeed), uStrandFlash: uniform(O.strandFlash),
      uTipGlow: uniform(O.tipGlow), uTipLength: uniform(O.tipLength),
      uOpacity: uniform(O.opacity), uGlow: uniform(O.glow),
      uColorCore: uniform(new THREE.Color(pal.core)), uColorInner: uniform(new THREE.Color(pal.inner)),
      uColorOuter: uniform(new THREE.Color(pal.outer)), uColorHalo: uniform(new THREE.Color(pal.halo)),
    };

    const group = new THREE.Group();
    const geo = boltGeometry(Math.min(O.maxStrands, Math.max(1, Math.round(O.strands))));
    const meshes = [true, false].map((isGlow, i) => {
      const mesh = new THREE.Mesh(geo, boltMaterial(u, isGlow));
      mesh.frustumCulled = false;
      mesh.renderOrder = 11 + i * 2; // halo first so the core adds on top of it
      group.add(mesh);
      return mesh;
    });

    const muzzle = new THREE.Mesh(flashGeo, additiveMaterial(pal.muzzle));
    const impact = new THREE.Mesh(flashGeo, additiveMaterial(pal.impact));
    for (const m of [muzzle, impact]) { m.frustumCulled = false; m.renderOrder = 10; m.visible = false; group.add(m); }

    const sparkMat = additiveMaterial(pal.spark);
    sparkMat.opacity = 1;
    sparkMat.side = THREE.DoubleSide;
    const sparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, SPARK_CAP);
    sparkMesh.frustumCulled = false;
    sparkMesh.renderOrder = 12;
    sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scratch.c.set(pal.spark);
    for (let i = 0; i < SPARK_CAP; i++) sparkMesh.setColorAt(i, scratch.c);
    sparkMesh.visible = false;
    group.add(sparkMesh);

    return { pal, u, group, meshes, muzzle, impact, sparkMesh, sparkColor: new THREE.Color(pal.spark) };
  }

  function takeRig(palName) {
    const free = pool.get(palName);
    if (free && free.length) return free.pop();
    return buildRig(palName);
  }
  function giveRig(palName, rig) {
    rig.u.uFade.value = 0;
    rig.muzzle.visible = false;
    rig.impact.visible = false;
    rig.sparkMesh.visible = false;
    let free = pool.get(palName);
    if (!free) pool.set(palName, free = []);
    free.push(rig);
  }

  /* ------------------------------------------------------------------ */
  /* Cast                                                                */
  /* ------------------------------------------------------------------ */

  function cast({ line, seed = 1, palette = 'default', power = 1, sourceY = 0.6, targetY = 0.6 }) {
    const palName = PALETTES[palette] ? palette : 'default';
    const rig = takeRig(palName);
    const u = rig.u;
    const rng = mulberry32(seed >>> 0 || 1);

    const strands = Math.min(O.maxStrands, Math.max(1, Math.round(O.strands * (0.7 + 0.4 * power))));
    const geo = boltGeometry(strands);
    for (const m of rig.meshes) m.geometry = geo;

    // Endpoints: the bolt leaves the mouth a little ahead of the attacker and lands at the target's.
    const origin = scratch.a.set(
      line.origin.x + line.dir.x * O.originForward,
      line.origin.y + sourceY,
      line.origin.z + line.dir.z * O.originForward,
    );
    const target = scratch.b.set(line.target.x, line.target.y + targetY, line.target.z);
    u.uOrigin.value.copy(origin);
    u.uTarget.value.copy(target);

    const dir = new THREE.Vector3().subVectors(target, origin);
    const span = Math.max(dir.length(), 0.01);
    dir.divideScalar(span);
    // Gram-Schmidt: the axis tilts, so line.side is only approximately perpendicular to it.
    const n1 = new THREE.Vector3(line.side.x, 0, line.side.z);
    n1.addScaledVector(dir, -n1.dot(dir));
    if (n1.lengthSq() < 1e-8) n1.set(0, 1, 0).cross(dir);
    n1.normalize();
    const n2 = new THREE.Vector3().crossVectors(dir, n1).normalize();
    u.uDir.value.copy(dir);
    u.uN1.value.copy(n1);
    u.uN2.value.copy(n2);
    u.uSpan.value = span;

    u.uSeed.value = rng() * 100;
    u.uProgress.value = 0;
    u.uFade.value = 1;
    u.uStrands.value = strands;
    u.uWidth.value = O.width * (0.7 + 0.4 * power);
    u.uSpread.value = O.spread * power;

    const axisOrigin = new THREE.Vector3().copy(origin);
    const axisTarget = new THREE.Vector3().copy(target);
    /** Mirrors the first stage of the vertex shader, so CPU sparks sit on the bolt the GPU draws. */
    function axisPoint(s, out) {
      const t = saturate(s);
      out.lerpVectors(axisOrigin, axisTarget, t);
      out.y += O.sag * Math.sin(t * Math.PI);
      return out;
    }
    const bundleRadius = (s) => O.spreadNear + (O.spread * power - O.spreadNear) * Math.pow(saturate(s), Math.max(0.01, O.spreadCurve));

    /* --- sparks --- */
    const sparkPos = new Float32Array(SPARK_CAP * 3);
    const sparkVel = new Float32Array(SPARK_CAP * 3);
    const sparkLife = new Float32Array(SPARK_CAP);
    const sparkMax = new Float32Array(SPARK_CAP);
    const emitter = createRateEmitter(SPARK_CAP);
    let sparkCursor = 0;

    function emitSparks(n, reach) {
      if (!O.sparks) return;
      for (let k = 0; k < n; k++) {
        const i = sparkCursor;
        sparkCursor = (sparkCursor + 1) % SPARK_CAP;
        const s = (0.05 + rng() * 0.95) * reach;
        axisPoint(s, scratch.v);
        const r = bundleRadius(s) * 1.1 + 0.05;
        const o = i * 3;
        sparkPos[o] = scratch.v.x + (rng() - 0.5) * 2 * r;
        sparkPos[o + 1] = scratch.v.y + (rng() - 0.5) * 2 * r;
        sparkPos[o + 2] = scratch.v.z + (rng() - 0.5) * 2 * r;
        const speed = O.sparkSpeed * (0.3 + rng() * 1.4) * power;
        sparkVel[o] = (rng() - 0.5) * 2 * speed + dir.x * speed * 0.35;
        sparkVel[o + 1] = (0.2 + rng()) * speed;
        sparkVel[o + 2] = (rng() - 0.5) * 2 * speed + dir.z * speed * 0.35;
        sparkMax[i] = sparkLife[i] = O.sparkLife * (0.5 + rng());
      }
      if (n > 0) rig.sparkMesh.visible = true;
    }

    function updateSparks(dt) {
      if (!rig.sparkMesh.visible) return;
      const drag = Math.max(0, 1 - O.sparkDrag * dt);
      let live = 0;
      for (let i = 0; i < SPARK_CAP; i++) {
        const o = i * 3;
        let scale = 0;
        if (sparkLife[i] > 0) {
          sparkLife[i] -= dt;
          if (sparkLife[i] > 0) {
            sparkVel[o] *= drag; sparkVel[o + 1] = sparkVel[o + 1] * drag + O.sparkGravity * dt; sparkVel[o + 2] *= drag;
            sparkPos[o] += sparkVel[o] * dt; sparkPos[o + 1] += sparkVel[o + 1] * dt; sparkPos[o + 2] += sparkVel[o + 2] * dt;
            const k = sparkLife[i] / Math.max(1e-4, sparkMax[i]);
            scale = O.sparkSize * (0.35 + 0.65 * k) * power;
            scratch.c.copy(rig.sparkColor).multiplyScalar(0.25 + 0.75 * k);
            rig.sparkMesh.setColorAt(i, scratch.c);
            live++;
          }
        }
        scratch.v.set(sparkPos[o], sparkPos[o + 1], sparkPos[o + 2]);
        scratch.s.setScalar(scale);
        scratch.m.compose(scratch.v, scratch.q, scratch.s);
        rig.sparkMesh.setMatrixAt(i, scratch.m);
      }
      rig.sparkMesh.instanceMatrix.needsUpdate = true;
      if (rig.sparkMesh.instanceColor) rig.sparkMesh.instanceColor.needsUpdate = true;
      if (live === 0) rig.sparkMesh.visible = false;
    }

    /* --- flashes --- */
    let muzzleAge = -1, impactAge = -1;
    function popFlash(mesh, at, size, age, life) {
      if (age < 0) { mesh.visible = false; return; }
      const k = saturate(age / life);
      mesh.visible = true;
      mesh.position.copy(at);
      mesh.scale.setScalar(size * (0.25 + 0.95 * Easing.outCubic(k)));
      mesh.material.opacity = (1 - Easing.inQuad(k)) * 0.95;
      if (k >= 1) mesh.visible = false;
    }

    /* --- light --- */
    const light = lights && lights.acquire ? lights.acquire() : null;
    if (light) {
      light.color.set(rig.pal.light);
      light.distance = O.lightDistance * (0.7 + 0.5 * power);
      light.intensity = 0;
      light.position.copy(origin);
    }
    /** Lightning gutters where ice glints — a hard, quantised stutter. */
    function lightShimmer(age) {
      const stepIndex = Math.floor(age * Math.max(1, O.lightFlickerSpeed));
      const n = Math.abs(Math.sin(stepIndex * 127.1) * 43758.5453) % 1;
      return 1 - saturate(O.lightFlicker) * n;
    }
    function driveLight(s, fade, boost) {
      if (!light) return;
      axisPoint(s, scratch.v);
      light.position.copy(scratch.v);
      light.intensity = O.lightIntensity * power * fade * boost * lightShimmer(machine.age);
    }

    scene.add(rig.group);

    const instance = {
      group: rig.group,
      machine: null,
      onImpact: null,
      onDone: null,
      update(dt, t) {
        const alive = machine.update(dt, t);
        updateSparks(dt);
        if (muzzleAge >= 0) { muzzleAge += dt; popFlash(rig.muzzle, axisPoint(0, scratch.v), O.muzzleSize * power, muzzleAge, O.muzzleLife); }
        if (impactAge >= 0) { impactAge += dt; popFlash(rig.impact, axisPoint(1, scratch.v), O.impactSize * power, impactAge, O.impactLife); }
        return alive;
      },
      dispose() {
        if (!rig.group.parent) return;
        scene.remove(rig.group);
        if (light && lights && lights.release) { light.intensity = 0; lights.release(light); }
        giveRig(palName, rig);
      },
    };

    const machine = createPhaseMachine({
      travelSpeed: O.travelSpeed, travelTime: O.travelTime, easeIn: 0.01,
      impactTime: O.holdTime, fadeTime: O.fadeTime,
      onSpawn() {
        emitter.reset();
        muzzleAge = 0;
        emitSparks(Math.round(24 * power), 0.12);
        driveLight(0, 1, 1.4);
      },
      onTravel(dt) {
        u.uProgress.value = this.u;
        emitSparks(emitter.take(O.sparkRate * power, dt), Math.max(0.02, this.u));
        driveLight(this.u, 1, 1);
      },
      onImpact() {
        u.uProgress.value = 1;
        impactAge = 0;
        emitSparks(Math.round(40 * power), 1);
        driveLight(1, 1, 1.8);
        instance.onImpact && instance.onImpact();
      },
      onFade(dt, t) {
        // t runs 0..1 while the bolt holds, then 1..2 while it blows out. Cubic so it hangs on and goes.
        const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
        u.uFade.value = fade;
        u.uProgress.value = 1;
        emitSparks(emitter.take(O.sparkRate * power * fade * (t <= 1 ? 0.6 : 0.35), dt), 1);
        driveLight(1, fade, 1);
      },
      onDestroy() {
        u.uFade.value = 0;
        if (light) light.intensity = 0;
        instance.onDone && instance.onDone();
      },
    });
    instance.machine = machine;
    machine.spawn(line);
    return instance;
  }

  function dispose() {
    for (const list of pool.values()) {
      for (const rig of list) {
        for (const m of rig.meshes) m.material.dispose();
        rig.muzzle.material.dispose();
        rig.impact.material.dispose();
        rig.sparkMesh.material.dispose();
        rig.sparkMesh.dispose();
        if (rig.group.parent) rig.group.parent.remove(rig.group);
      }
    }
    pool.clear();
    for (const g of geoCache.values()) g.dispose();
    geoCache.clear();
    flashGeo.dispose();
    sparkGeo.dispose();
  }

  return { cast, dispose, PALETTES, options: O };
}

export default createBoltFx;
