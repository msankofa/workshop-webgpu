/**
 * fx-aurora.js — Aurora Veil. A self-buff: curtains of luminous silk unfurl in a ring around the
 * attacker, hold, then thin and sink back into the ground.
 *
 * Ported from GeometryPainterThreeJS/src/modes/aurora.ts (already TSL). Two changes matter:
 *
 *  1. PATH REBIND. The reference laid its curtain along a stroke painted on a sphere, so every path
 *     point carried its own surface normal. Here the path is a closed circle of `radius` around
 *     `line.origin`, sampled on the terrain, and the normal is always world up. `side` (the direction
 *     the cloth sways) therefore becomes the radial outward vector, so the curtain billows in and out
 *     of the ring rather than left and right along a stroke. The line's target is unused — a self-buff
 *     only needs the origin.
 *  2. SEAMLESS PHASE. The reference indexed every wave by arc length, which is fine for an open stroke
 *     but would tear at the seam of a closed ring. Every frequency here is an integer multiple of a
 *     normalized angle `aU` in [0,1], so the folds, rays and crest jitter all line up where the ring
 *     closes. The crest jitter is a sum of integer-frequency sines (seeded phases) instead of the
 *     reference's random walk, for the same reason.
 *
 * Layers, all additive:
 *  - CURTAIN ×2 — one ring grid drawn twice (front, plus a shorter de-phased back sheet), displaced in
 *    the vertex stage by layered sines whose amplitude grows with height, so the hem stays pinned.
 *  - FOLD LIGHT — fragment brightness locked to the same phase as the vertex sway, so the silk glows
 *    along its moving folds like translucent fabric seen edge-on.
 *  - RAYS — thin vertical striations drifting around the ring, plus a hot lower border.
 *  - HEM GLOW — a flat additive strip on the terrain where the silk meets the ground.
 *  - MOTES — twinkling star dust riding a cheap CPU approximation of the same wave; brightness
 *    twinkles on the GPU from a hash of the instance index, so the CPU only writes matrices.
 *  - LIGHT SPILL — pooled point lights breathing around the ring.
 *
 * Phases: TRAVEL sweeps the unfurl front around the circle (machine.u is the angle), IMPACT holds the
 * finished veil, FADE sinks and thins it. onImpact fires when the ring closes.
 */

import { createPhaseMachine, mulberry32, saturate } from './move-core.js';

const TAU = Math.PI * 2;

// Integer wave counts around the ring — keeping them whole is what makes the seam invisible.
const FOLD_FREQ = 6;
const SWAY_FREQ = 11;
const RIPPLE_FREQ = 22;
const RAY_FREQ = 34;

export const PALETTES = {
  default: { hem: 0x3cffa8, mid: 0x36c9ff, top: 0xb26bff, spectrum: 0 },
  aurora: { hem: 0x3cffa8, mid: 0x36c9ff, top: 0xb26bff, spectrum: 0 },
  spectrum: { hem: 0x4dffc8, mid: 0x7ad0ff, top: 0xc08bff, spectrum: 1 },
  ice: { hem: 0xffffff, mid: 0xa8e0ff, top: 0x4a7cff, spectrum: 0 },
};

const DEFAULTS = {
  radius: 1.2,        // ring radius in metres, before power scaling
  height: 1.7,        // curtain height
  wave: 0.55,         // billow amplitude
  flow: 1,            // animation speed
  rays: 0.7,          // vertical striation strength
  brightness: 1,      // overall curtain intensity
  motes: 150,         // star dust inside the veil
  maxMotes: 240,      // hard instance cap
  lightSpill: 1.1,    // point-light intensity
  lightCount: 3,
  lightRange: 7,
  segments: 96,       // ring columns
  heightSegs: 14,
  hemWidth: 0.38,     // ground glow half-width
  unfurlWidth: 0.12,  // how much of the ring the growth front feathers over
  travelTime: 0.6,
  impactTime: 2.5,
  fadeTime: 1.2,
};

// Scratch — nothing here is allocated per frame.
let _m4 = null, _v3 = null, _sc = null, _zero = null;

function initScratch(THREE) {
  if (_m4) return;
  _m4 = new THREE.Matrix4();
  _v3 = new THREE.Vector3();
  _sc = new THREE.Vector3();
  _zero = new THREE.Matrix4().makeScale(0, 0, 0);
}

/** Ring path around the origin, sampled on the terrain. normal is up, side is radial outward. */
function buildRing(segments, radius, ox, oy, oz, terrainHeight) {
  const cols = segments + 1; // last column repeats the first position to close the seam
  const pts = new Array(cols);
  for (let i = 0; i < cols; i++) {
    const u = i / segments;
    const a = u * TAU;
    const cx = Math.cos(a), cz = Math.sin(a);
    const x = ox + cx * radius, z = oz + cz * radius;
    pts[i] = { x: cx * radius, y: terrainHeight(x, z) - oy, z: cz * radius, u, sx: cx, sz: cz };
  }
  return pts;
}

/** Curtain grid. Every vertex sits at the hem; the lift happens in the vertex stage. */
function buildCurtainGeometry(THREE, ring, rows, jitPhase) {
  const cols = ring.length;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const side = new Float32Array(n * 3);
  const us = new Float32Array(n);
  const vs = new Float32Array(n);
  const jits = new Float32Array(n);
  const idx = [];
  for (let i = 0; i < cols; i++) {
    const p = ring[i];
    const a = p.u * TAU;
    // Periodic crest jitter: integer harmonics only, so column 0 and column N agree.
    const jit = 1
      + 0.17 * Math.sin(a * 2 + jitPhase[0])
      + 0.12 * Math.sin(a * 3 + jitPhase[1])
      + 0.08 * Math.sin(a * 5 + jitPhase[2]);
    for (let r = 0; r < rows; r++) {
      const vi = i * rows + r;
      pos[vi * 3] = p.x; pos[vi * 3 + 1] = p.y; pos[vi * 3 + 2] = p.z;
      side[vi * 3] = p.sx; side[vi * 3 + 1] = 0; side[vi * 3 + 2] = p.sz;
      us[vi] = p.u;
      vs[vi] = r / (rows - 1);
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
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 3));
  geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geo.setAttribute('aV', new THREE.BufferAttribute(vs, 1));
  geo.setAttribute('aColJit', new THREE.BufferAttribute(jits, 1));
  geo.setIndex(idx);
  return geo;
}

/** Two-row ring strip lying on the terrain; the width is applied in the vertex stage. */
function buildHemGeometry(THREE, ring) {
  const cols = ring.length;
  const pos = new Float32Array(cols * 2 * 3);
  const side = new Float32Array(cols * 2 * 3);
  const across = new Float32Array(cols * 2);
  const us = new Float32Array(cols * 2);
  const idx = [];
  for (let i = 0; i < cols; i++) {
    const p = ring[i];
    for (let k = 0; k < 2; k++) {
      const vi = i * 2 + k;
      pos[vi * 3] = p.x; pos[vi * 3 + 1] = p.y + 0.02; pos[vi * 3 + 2] = p.z;
      side[vi * 3] = p.sx; side[vi * 3 + 1] = 0; side[vi * 3 + 2] = p.sz;
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
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 3));
  geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geo.setIndex(idx);
  return geo;
}

export function createAuroraFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene } = deps;
  const terrainHeight = deps.terrainHeight || (() => 0);
  const lightPool = deps.lights || { acquire: () => null, release: () => {} };
  const o = { ...DEFAULTS, ...options };
  initScratch(THREE);

  const { abs, attribute, cos, float, fract, hash, instanceIndex, mix, positionLocal, smoothstep, time, uniform, uv, vec3 } = TSL;
  const moteGeo = new THREE.PlaneGeometry(1, 1); // shared across casts

  function cast({ line, seed = 1, palette = 'default', power = 1 }) {
    const rnd = mulberry32(seed >>> 0);
    const pal = PALETTES[palette] || PALETTES.aurora;
    const radius = o.radius * Math.pow(Math.max(power, 0.05), 0.3);
    const height = o.height * Math.pow(Math.max(power, 0.05), 0.35);
    const bright = o.brightness * (0.75 + 0.25 * power);
    const moteCount = Math.min(o.maxMotes, Math.max(0, Math.round(o.motes * (0.7 + 0.3 * power))));

    const group = new THREE.Group();
    group.position.set(line.origin.x, line.origin.y, line.origin.z);
    scene.add(group);

    const ring = buildRing(o.segments, radius, line.origin.x, line.origin.y, line.origin.z, terrainHeight);
    const rows = o.heightSegs + 1;
    const jitPhase = [rnd() * TAU, rnd() * TAU, rnd() * TAU];

    // ----- uniforms -----
    const uGrown = uniform(0);      // unfurl front, in normalized ring angle
    const uFade = uniform(0);       // 0 while held, 1 fully gone
    const uHeight = uniform(height);
    const uWave = uniform(o.wave);
    const uFlow = uniform(o.flow);
    const uRays = uniform(o.rays);
    const uBright = uniform(bright);
    const uSpectrum = uniform(pal.spectrum);
    const uHemW = uniform(o.hemWidth);
    const uHem = uniform(new THREE.Color(pal.hem));
    const uMid = uniform(new THREE.Color(pal.mid));
    const uTop = uniform(new THREE.Color(pal.top));

    const materials = [];
    const T = time.mul(uFlow);

    /** phase de-syncs the back sheet; stature/dim shrink and soften it into a second band. */
    function curtainMaterial(phase, stature, dim) {
      const mat = new NODES.MeshBasicNodeMaterial();
      mat.transparent = true; mat.depthWrite = false;
      mat.side = THREE.DoubleSide; mat.blending = THREE.AdditiveBlending;
      materials.push(mat);

      const aSide = vec3(attribute('aSide', 'vec3'));
      const aU = float(attribute('aU', 'float'));
      const aV = float(attribute('aV', 'float'));
      const aJit = float(attribute('aColJit', 'float'));
      const ang = aU.mul(TAU);
      const sink = uFade.mul(0.72).oneMinus();

      const unfurl = smoothstep(0, o.unfurlWidth, uGrown.sub(aU));
      const lift = uHeight.mul(aJit).mul(aV).mul(unfurl).mul(stature).mul(sink);

      const breath = T.mul(0.23).add(phase).sin().mul(0.2).add(0.8);
      const amp = uWave.mul(uHeight).mul(0.28).mul(aV.pow(1.35)).mul(unfurl).mul(breath);
      const foldPhase = ang.mul(FOLD_FREQ).add(T.mul(1.1)).add(phase);
      const sway = foldPhase.sin()
        .add(ang.mul(SWAY_FREQ).sub(T.mul(0.7)).add(aV.mul(1.8)).add(phase).sin().mul(0.5));
      const ripple = ang.mul(RIPPLE_FREQ).add(T.mul(1.9)).add(aV.mul(4)).add(phase).sin()
        .mul(uHeight.mul(0.032)).mul(aV);

      mat.positionNode = positionLocal
        .add(vec3(0, 1, 0).mul(lift.add(ripple.mul(0.4))))
        .add(aSide.mul(amp.mul(sway).add(ripple)));

      // Fold light shares foldPhase with the vertex sway, so the glow rides the moving cloth.
      const folds = abs(cos(foldPhase)).pow(1.6).mul(0.85).add(0.4);
      const rayWave = ang.mul(RAY_FREQ).add(T.mul(0.45).sin().mul(1.6)).add(aV.mul(2.2)).sin().mul(0.5).add(0.5);
      const rays = mix(float(1), rayWave.pow(2.4).mul(1.7).add(0.25), uRays);
      const hemBoost = smoothstep(0, 0.22, aV).oneMinus().mul(1.3).add(1);

      let grad = mix(vec3(uHem), vec3(uMid), smoothstep(0.03, 0.45, aV));
      grad = mix(grad, vec3(uTop), smoothstep(0.45, 0.95, aV));
      const cyc = ang.add(T.mul(0.35));
      const spec = cos(vec3(cyc, cyc.add(2.09), cyc.add(4.18))).mul(0.5).add(0.5).mul(vec3(0.9, 1.0, 1.2));
      const col = mix(grad, spec, uSpectrum);

      mat.colorNode = col.mul(folds).mul(rays).mul(hemBoost).mul(uBright).mul(1.3 * dim);

      const feather = ang.mul(17).add(aV.mul(9)).add(T.mul(0.8)).sin().mul(0.12).add(0.88);
      const thin = uFade.oneMinus().pow(1.4);
      mat.opacityNode = float(1).sub(aV).pow(1.15).mul(unfurl).mul(feather).mul(thin).mul(0.85);
      return mat;
    }

    const frontMesh = new THREE.Mesh(buildCurtainGeometry(THREE, ring, rows, jitPhase), curtainMaterial(0, 1, 1));
    const backMesh = new THREE.Mesh(frontMesh.geometry, curtainMaterial(2.4, 0.72, 0.55));
    for (const m of [backMesh, frontMesh]) { m.renderOrder = 2; m.frustumCulled = false; group.add(m); }

    // ----- hem glow -----
    const hemMat = new NODES.MeshBasicNodeMaterial();
    hemMat.transparent = true; hemMat.depthWrite = false; hemMat.blending = THREE.AdditiveBlending;
    hemMat.side = THREE.DoubleSide;
    materials.push(hemMat);
    {
      const aSide = vec3(attribute('aSide', 'vec3'));
      const aAcross = float(attribute('aAcross', 'float'));
      const aU = float(attribute('aU', 'float'));
      hemMat.positionNode = positionLocal.add(aSide.mul(aAcross.mul(uHemW)));
      const unfurl = smoothstep(0, o.unfurlWidth * 2.5, uGrown.sub(aU));
      const falloff = abs(aAcross).oneMinus().max(0).pow(1.5);
      const shimmer = aU.mul(TAU * FOLD_FREQ).add(T.mul(1.1)).cos().mul(0.2).add(0.8);
      hemMat.colorNode = mix(vec3(uHem), vec3(uMid), 0.35).mul(falloff).mul(shimmer).mul(uBright).mul(0.5);
      hemMat.opacityNode = unfurl.mul(uFade.oneMinus());
    }
    const hemMesh = new THREE.Mesh(buildHemGeometry(THREE, ring), hemMat);
    hemMesh.renderOrder = 1; hemMesh.frustumCulled = false;
    group.add(hemMesh);

    // ----- motes -----
    const moteMat = new NODES.MeshBasicNodeMaterial();
    moteMat.transparent = true; moteMat.depthWrite = false;
    moteMat.blending = THREE.AdditiveBlending; moteMat.side = THREE.DoubleSide;
    materials.push(moteMat);
    {
      const h1 = hash(instanceIndex);
      const h2 = fract(h1.mul(97.13));
      const tw = T.mul(h2.mul(2.2).add(0.6)).mul(2).add(h1.mul(TAU)).sin().mul(0.5).add(0.5).pow(2.5);
      const tint = mix(vec3(uHem), vec3(uTop), h1);
      const r = uv().sub(0.5).length().mul(2);
      const disc = r.oneMinus().max(0).pow(2.2);
      moteMat.colorNode = tint.mul(tw.mul(1.3).add(0.25)).mul(uBright);
      moteMat.opacityNode = disc.mul(tw.mul(0.7).add(0.3)).mul(uFade.oneMinus());
    }
    const moteMesh = new THREE.InstancedMesh(moteGeo, moteMat, Math.max(moteCount, 1));
    moteMesh.renderOrder = 3; moteMesh.frustumCulled = false;
    group.add(moteMesh);

    const motes = new Array(moteCount);
    for (let i = 0; i < moteCount; i++) {
      const p = ring[Math.floor(rnd() * (ring.length - 1))];
      motes[i] = {
        x: p.x, y: p.y, z: p.z, sx: p.sx, sz: p.sz, u: p.u,
        v: Math.pow(rnd(), 1.4), // cluster toward the hem
        size: height * (0.012 + rnd() * 0.024),
        phase: rnd() * TAU,
        quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI)),
      };
      moteMesh.setMatrixAt(i, _zero);
    }
    moteMesh.instanceMatrix.needsUpdate = true;

    // ----- light spill -----
    const spill = [];
    for (let i = 0; i < o.lightCount; i++) {
      const light = lightPool.acquire();
      if (!light) break;
      const u = i / o.lightCount;
      const a = u * TAU;
      light.position.set(
        line.origin.x + Math.cos(a) * radius * 0.9,
        line.origin.y + height * 0.45,
        line.origin.z + Math.sin(a) * radius * 0.9,
      );
      light.distance = o.lightRange;
      light.intensity = 0;
      spill.push({ light, u, phase: rnd() * 20, warm: i % 2 === 1 });
    }
    const cHem = new THREE.Color(pal.hem);
    const cTop = new THREE.Color(pal.top);

    // ----- phase machine -----
    let grown = 0, fade = 0, hitPending = false, donePending = false;
    const machine = createPhaseMachine({
      travelTime: o.travelTime, impactTime: o.impactTime, fadeTime: o.fadeTime, easeIn: 0.05,
      onTravel() { grown = Math.max(grown, this.u); },
      onImpact() { hitPending = true; },
      onFade(dt, t) {
        grown = Math.min(1 + o.unfurlWidth, grown + dt * (o.unfurlWidth / 0.15));
        fade = t > 1 ? saturate(t - 1) : 0;
      },
      onDestroy() { donePending = true; },
    });
    machine.spawn(line);

    function updateMotes(t) {
      const flow = t * o.flow;
      for (let i = 0; i < moteCount; i++) {
        const m = motes[i];
        if (m.u > grown) { moteMesh.setMatrixAt(i, _zero); continue; }
        const open = Math.min((grown - m.u) / o.unfurlWidth, 1);
        const lift = height * m.v * (0.35 + 0.65 * open) * (1 - 0.72 * fade);
        const sway = Math.sin(m.u * TAU * FOLD_FREQ + flow * 1.1) * o.wave * height * 0.28 * Math.pow(m.v, 1.35);
        const bob = Math.sin(flow * 0.6 + m.phase) * height * 0.03;
        const off = sway + Math.sin(flow * 0.4 + m.phase * 1.7) * height * 0.03;
        _v3.set(m.x + m.sx * off, m.y + lift + bob, m.z + m.sz * off);
        _sc.setScalar(m.size);
        _m4.compose(_v3, m.quat, _sc);
        moteMesh.setMatrixAt(i, _m4);
      }
      moteMesh.instanceMatrix.needsUpdate = true;
    }

    function updateLights(t) {
      for (let i = 0; i < spill.length; i++) {
        const s = spill[i];
        if (grown <= s.u) { s.light.intensity = 0; continue; }
        const ignite = saturate((grown - s.u) / 0.2);
        const breathe = 0.72 + 0.28 * Math.sin(t * 0.9 * o.flow + s.phase);
        s.light.color.copy(s.warm ? cTop : cHem);
        s.light.intensity = o.lightSpill * bright * ignite * breathe * (1 - fade);
      }
    }

    const inst = {
      group,
      machine,
      onImpact: null,
      onDone: null,
      update(dt, t = 0) {
        const alive = machine.update(dt, t);
        uGrown.value = grown;
        uFade.value = fade;
        updateMotes(t);
        updateLights(t);
        if (hitPending) { hitPending = false; this.onImpact?.(); }
        if (!alive && donePending) { donePending = false; this.onDone?.(); }
        return alive;
      },
      dispose() {
        machine.destroy();
        donePending = false;
        for (const s of spill) { s.light.intensity = 0; lightPool.release(s.light); }
        spill.length = 0;
        group.removeFromParent();
        frontMesh.geometry.dispose();
        hemMesh.geometry.dispose();
        moteMesh.dispose();
        for (const m of materials) m.dispose();
      },
    };
    return inst;
  }

  return {
    cast,
    dispose() { moteGeo.dispose(); },
  };
}
