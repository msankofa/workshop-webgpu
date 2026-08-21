/**
 * fx-tether.js — a filament link that appears already attached at both ends and stays: Thunder Wave,
 * Parabolic Charge, the drain moves, Dream Eater, Spirit Shackle, Mean Look, Lock-On.
 *
 * Built from fx-bolt.js. Bolt throws a strand bundle from mouth to target and the tip arrives over
 * time; a tether never travels — it is the standing state. The donor's ribbon shape already has the
 * lever for this: `boltPoint`'s `pinch`/`converge` terms pin the noise offset to zero at both ends of
 * the parameter range, which bolt only uses loosely (the far end is not meant to look "landed" until
 * the strike gets there). Here that pin is unconditional — both `t = 0` and `t = 1` are always clamped
 * to the exact axis, so a strand can crackle or sag in the middle but never drifts off its anchor.
 * There is consequently no `uProgress` tip-clip in this module at all: the geometry always spans the
 * full origin-to-target axis (`mix(origin, target, t)`, bowed by `sag`), and the phase machine's TRAVEL
 * is kept so short (`travelTime` near zero) that it exists only to make `onImpact` fire on the very
 * first `update()` call, one frame after `cast()`. What used to be "the strike front reaching the
 * target" becomes "the link snapping into place," driven by `uFade` ramping 0→1 across a short slice
 * of IMPACT (`attachFrac`) and then holding at 1 for the rest of the hold, however long that turns out
 * to be — `saturate()` inside the phase machine means `onFade`'s `t` pins at 1 once the ramp finishes,
 * so nothing has to poll wall-clock time to know the attach is done.
 *
 * Reused verbatim from bolt: the ladder-strip `InstancedBufferGeometry` (t along, side ±1, one instance
 * per filament), the camera-facing extrusion (`cross(tangent, toCamera)`), the cross-ribbon `pow(1-|v|,
 * sharpness)` falloff, the two-pass glow-then-core draw, and the `hash11`/`vnoise`/kink octave stack for
 * the electric look. Jitter and restrike are palette data here, not code paths: `paralysis` is the only
 * look with non-zero `jitter`, and every calmer palette sets `restrike` to a near-zero (not exactly zero
 * — `boltMaterial`'s strand-seed clamps it to a 0.01 floor same as the donor) value instead of deleting
 * the mechanism, so a slow restrike is still technically running under Dream Eater, just too gradual to
 * see inside one hold.
 *
 * New here: a slow brightness `pulse` (a plain sine on `time`, depth and speed palette-driven) for the
 * looks that should not flicker — spectral pulses, paralysis flickers, and both terms are zero for the
 * palette that does not want them, so they coexist in one opacity/color expression without a branch.
 * Motes come from `createSpriteParticles` (move-parts.js, part 5) and their direction is what tells the
 * four looks apart: `drain` streams them from the target back to the caster (`moteDir: -1`), `paralysis`
 * streams them outward from the caster (`moteDir: 1`), `spectral` just lets them drift locally
 * (`moteMode: 'drift'`, spawned on the axis with a small random walk, no cross-span flight), and `lock`
 * emits none at all — its "reticle" is a small pulsing flash sphere (`makeFlashSphere`, part 9) parked
 * at the target end instead. One pooled light per live cast, held at the link's midpoint.
 *
 * THE SAG TRAP. The brief's warning about bolt's CPU/GPU mirror applies directly here: `axisPoint()`
 * below reproduces only the axis term of the vertex shader (`mix(origin, target, t) + sag·sin(t·π)`),
 * not the kink noise, and that is exactly the term bolt's own sparks rely on too. It is exact — not an
 * approximation — for every palette except `paralysis`, because every other palette sets `jitter: 0`,
 * so the GPU ribbon centreline *is* the axis term with nothing added; a mote placed by `axisPoint` sits
 * exactly on it regardless of how large `sag` is. `drain` is the palette that stresses this (`sag: 0.5`,
 * the biggest of the four) and it is jitter-free by design, so its stream of motes tracks the visible
 * sag exactly at spawn. The one place this needed real work is the *flight* of a streaming mote between
 * spawn and despawn: `createSpriteParticles.step()` integrates a straight ballistic path (velocity +
 * constant gravity), which does not itself know about `sin(t·π)`. Rather than have the mote fly the
 * straight chord and visibly cut across the belly of the sag, each rig's `gravity` is solved in closed
 * form so a mote launched from one end with the matching initial vertical velocity traces a parabola
 * that passes through the same three points the sag curve does — both endpoints and the peak at the
 * midpoint (`accel = 8·sag / life²`, `v0 = 4·sag / life`, derived from the constraint that a symmetric
 * parabola of duration `life` and peak height `sag` returns to its start height at `life`). A parabola
 * is not a sine, so the match is exact at t = 0, 0.5, 1 and close in between, not identical along the
 * whole arc; `drag` is left at 0 for the streaming pools specifically so damping cannot pull the flight
 * away from that closed form. `paralysis` also streams (small `sag: 0.05`, so any drift is tiny) and
 * `spectral`'s drift mode never leaves the neighbourhood of its spawn point, so neither needed the same
 * treatment. This was checked by derivation, not by looking at a render — nothing in this module has
 * been seen on a GPU.
 *
 * THE ENDPOINT TRAP. `cast()` samples `line.origin`/`line.target` once, exactly like bolt, and the
 * uniforms never update after that. A thrown bolt lives half a second and the target barely moves in
 * that time; a *held* tether can sit attached for `maxHold` seconds while both creatures walk around,
 * and this module has no way to follow either of them — `deps` carries no per-frame transform for
 * attacker or target, only the `line` handed to `cast()`. The link will visibly detach from a moving
 * body. This is a harness-level gap, not something fixable in here; flagged per the brief instead of
 * worked around.
 */

import { createPhaseMachine, mulberry32, Easing, saturate, createRateEmitter } from './move-core.js';
import { createSpriteParticles, makeFlashSphere } from './move-parts.js';

const TAU = 6.283185307179586;

export const PALETTES = {
  /** Thunder Wave, Parabolic Charge: yellow-white, kinked, restriking, taut and short-lived. */
  paralysis: {
    core: '#fff8d0', inner: '#ffe98a', outer: '#f0c93a', halo: '#5a4600', light: '#ffe27a', mote: '#fff2b0',
    strands: 5, sag: 0.05, spread: 0.07, spreadNear: 0.02, twist: 0.35, pinch: 0.18,
    width: 0.045, glow: 2.4,
    jitter: 0.3, jitterScale: 1.1, crawl: 3.6, restrike: 16,
    flicker: 0.45, pulseSpeed: 0, pulseDepth: 0,
    moteMode: 'stream', moteDir: 1, moteRate: 7, moteLife: 0.5,
    snap: true, lightIntensity: 9,
  },
  /** Absorb, Mega Drain, Giga Drain, Leech Life: green, slack, smooth, a steady stream toward the caster. */
  drain: {
    core: '#eaffb8', inner: '#a6f26a', outer: '#4fae2c', halo: '#0e2a06', light: '#8fe860', mote: '#c8ffa0',
    strands: 3, sag: 0.5, spread: 0.035, spreadNear: 0.015, twist: 0.08, pinch: 0.28,
    width: 0.055, glow: 1.5,
    jitter: 0, jitterScale: 0.9, crawl: 0, restrike: 0,
    flicker: 0, pulseSpeed: 1.4, pulseDepth: 0.18,
    moteMode: 'stream', moteDir: -1, moteRate: 15, moteLife: 0.9,
    snap: false, lightIntensity: 5,
  },
  /** Dream Eater, Spirit Shackle, Mean Look: violet-black, thin, near-still, a slow pulse. */
  spectral: {
    core: '#d8b8ff', inner: '#8a4fd0', outer: '#2a0f4a', halo: '#050008', light: '#7a3ec0', mote: '#c090ff',
    strands: 2, sag: 0.24, spread: 0.02, spreadNear: 0.01, twist: 0.04, pinch: 0.32,
    width: 0.032, glow: 1.1,
    jitter: 0.02, jitterScale: 0.7, crawl: 0.2, restrike: 0,
    flicker: 0, pulseSpeed: 0.9, pulseDepth: 0.35,
    moteMode: 'drift', moteDir: 0, moteRate: 5, moteLife: 1.6,
    snap: false, lightIntensity: 3,
  },
  /** Lock-On: a thin bright line, almost no body, a reticle-like flash at the target end. */
  lock: {
    core: '#ffffff', inner: '#dff2ff', outer: '#8fd0ff', halo: '#0a1420', light: '#bfe6ff', mote: '#ffffff',
    strands: 1, sag: 0.01, spread: 0, spreadNear: 0, twist: 0, pinch: 0.05,
    width: 0.018, glow: 3.2,
    jitter: 0, jitterScale: 0.9, crawl: 0, restrike: 0,
    flicker: 0, pulseSpeed: 3.2, pulseDepth: 0.55,
    moteMode: 'none', moteDir: 0, moteRate: 0, moteLife: 0.5,
    snap: true, lightIntensity: 2, reticle: true,
  },
};
PALETTES.default = PALETTES.paralysis;

export const DEFAULTS = {
  // shape (shared ribbon constants; per-look numbers live on the palette instead)
  nodes: 48, maxStrands: 8, spreadCurve: 1.4, twistSpeed: 0.5, octaves: 4, jitterFalloff: 0.55, branchDim: 0.75,
  // ribbon
  widthTip: 1, widthCurve: 1, coreWidth: 2, coreSharp: 3.2, glowFalloff: 2.2, glowWidth: 6, glowOpacity: 0.34,
  opacity: 1, flickerSpeed: 34, strandFlash: 0.4,
  // timing — TRAVEL is not a beat here, only a one-frame formality so onImpact fires; the real reveal
  // is uFade ramping across the first `attachFrac` of impactTime.
  travelTime: 0.0002, attachFrac: 0.4, impactTime: 0.5, fadeTime: 0.5,
  // light and motes
  lightDistance: 8, moteCap: 40, moteSize: 0.05,
  // reticle (lock only)
  reticleSize: 0.3,
};

/**
 * @param {object} deps { THREE, TSL, NODES, scene, terrainHeight, lights }
 * @param {object} options overrides for DEFAULTS (shared ribbon constants, not per-palette looks)
 */
export function createTetherFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, lights } = deps;
  const O = Object.assign({}, DEFAULTS, options);
  const {
    Fn, attribute, uniform, positionGeometry, cameraPosition, time,
    float, vec2, vec3, mix, smoothstep, step, pow, floor, fract, sin, cos,
    normalize, cross, length, max, clamp,
  } = TSL;

  const scratch = { v: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3() };

  /* ------------------------------------------------------------------ */
  /* Geometry — same ladder-strip parameter space as fx-bolt.            */
  /* ------------------------------------------------------------------ */

  const geoCache = new Map();
  function tetherGeometry(strands) {
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

  /* ------------------------------------------------------------------ */
  /* Material                                                            */
  /* ------------------------------------------------------------------ */

  const aStrand = attribute('aStrand', 'float');

  const hash11 = (p) => {
    const a = fract(p.mul(0.1031)).toVar();
    const b = a.mul(a.add(33.33)).toVar();
    const c = b.mul(b.add(b)).toVar();
    return fract(c);
  };
  const vnoise = (x, seed) => {
    const i = floor(x).toVar();
    return mix(hash11(i.add(seed)), hash11(i.add(1).add(seed)), x.sub(i)).mul(2).sub(1);
  };

  function tetherMaterial(u, isGlow) {
    const widthScale = isGlow ? O.glowWidth : 1;
    const passOpacity = isGlow ? O.glowOpacity : 1;

    const kink = (t, seed) => {
      let ox = float(0).toVar(), oy = float(0).toVar();
      let amp = float(1).toVar();
      let freq = max(u.uJitterScale, float(0.01)).mul(u.uSpan).toVar();
      let scroll = time.mul(u.uCrawl).toVar();
      for (let i = 0; i < 5; i++) {
        const on = step(float(i), u.uOctaves.sub(1));
        ox = ox.add(on.mul(amp).mul(vnoise(t.mul(freq).add(scroll), seed.add(13 * i)))).toVar();
        oy = oy.add(on.mul(amp).mul(vnoise(t.mul(freq).add(scroll.mul(1.17)), seed.add(71.3 + 13 * i)))).toVar();
        amp = amp.mul(u.uJitterFalloff).toVar();
        freq = freq.mul(2).toVar();
        scroll = scroll.mul(1.63).toVar();
      }
      return vec2(ox, oy);
    };

    // Unlike bolt, both ends are always fully pinned: a tether has no partial-arrival state, so the
    // "converge" term bolt fades in while travelling is baked here as permanently on.
    const tetherPoint = (t, seed, radial) => {
      const axis = mix(u.uOrigin, u.uTarget, t).add(vec3(0, u.uSag.mul(sin(t.mul(Math.PI))), 0));
      const pinch = max(u.uPinch, float(1e-3));
      const ends = smoothstep(float(0), pinch, t).mul(smoothstep(float(0), pinch, t.oneMinus()));
      const off = kink(t, seed).mul(u.uJitter).mul(ends).toVar();
      const angle = seed.mul(TAU).add(t.mul(u.uTwist).add(time.mul(u.uTwistSpeed)).mul(TAU));
      const reach = mix(u.uSpreadNear, u.uSpread, pow(clamp(t, 0, 1), max(u.uSpreadCurve, float(0.01))));
      off.addAssign(vec2(cos(angle), sin(angle)).mul(reach).mul(radial));
      return axis.add(u.uN1.mul(off.x)).add(u.uN2.mul(off.y));
    };

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
      const here = tetherPoint(t, seed, radial).toVar();

      const stp = float(0.02);
      const flip = float(1).sub(step(float(1), t.add(stp)).mul(2)).toVar();
      const ahead = tetherPoint(t.add(stp.mul(flip)), seed, radial);
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

    const profileOf = () => {
      const v = clamp(positionGeometry.y.abs(), 0, 1);
      return pow(v.oneMinus(), max(isGlow ? u.uGlowFalloff : u.uCoreSharp, float(0.05)));
    };
    // Slow brightness pulse: zero speed/depth for a look leaves this at a flat 1, same trick as flicker.
    const pulseOf = () => {
      const wave = time.mul(u.uPulseSpeed).add(u.uSeed).sin().mul(0.5).add(0.5);
      return mix(float(1), wave.mul(0.6).add(0.6), u.uPulseDepth);
    };

    material.colorNode = Fn(() => {
      const profile = profileOf().toVar();
      const base = isGlow
        ? mix(u.uColorHalo, u.uColorOuter, profile)
        : mix(mix(u.uColorOuter, u.uColorInner, smoothstep(float(0), float(0.5), profile)), u.uColorCore, smoothstep(float(0.45), float(1), profile));
      return base.mul(u.uGlow).mul(pulseOf());
    })();

    material.opacityNode = Fn(() => {
      const flicker = float(1).sub(u.uFlicker.mul(hash11(floor(time.mul(u.uFlickerSpeed)).add(u.uSeed))));
      return profileOf().mul(flicker).mul(pulseOf()).mul(flashOf()).mul(u.uFade)
        .mul(passOpacity).mul(u.uOpacity)
        .mul(mix(float(1), clamp(u.uBranchDim, 0, 1), radialOf()));
    })();

    return material;
  }

  /* ------------------------------------------------------------------ */
  /* Rigs — pooled per palette, like fx-bolt.                            */
  /* ------------------------------------------------------------------ */

  const pool = new Map();

  function buildRig(palName) {
    const look = PALETTES[palName] || PALETTES.default;
    const u = {
      uOrigin: uniform(new THREE.Vector3()), uTarget: uniform(new THREE.Vector3(0, 0, 1)),
      uDir: uniform(new THREE.Vector3(0, 0, 1)), uN1: uniform(new THREE.Vector3(1, 0, 0)), uN2: uniform(new THREE.Vector3(0, 1, 0)),
      uSpan: uniform(1), uSag: uniform(look.sag), uSeed: uniform(0), uFade: uniform(0),
      uStrands: uniform(look.strands), uRestrike: uniform(look.restrike), uPinch: uniform(look.pinch),
      uSpread: uniform(look.spread), uSpreadNear: uniform(look.spreadNear), uSpreadCurve: uniform(O.spreadCurve),
      uTwist: uniform(look.twist), uTwistSpeed: uniform(O.twistSpeed),
      uJitter: uniform(look.jitter), uJitterScale: uniform(look.jitterScale), uOctaves: uniform(O.octaves),
      uJitterFalloff: uniform(O.jitterFalloff), uCrawl: uniform(look.crawl), uBranchDim: uniform(O.branchDim),
      uWidth: uniform(look.width), uWidthTip: uniform(O.widthTip), uWidthCurve: uniform(O.widthCurve),
      uCoreWidth: uniform(O.coreWidth), uCoreSharp: uniform(O.coreSharp), uGlowFalloff: uniform(O.glowFalloff),
      uFlicker: uniform(look.flicker), uFlickerSpeed: uniform(O.flickerSpeed), uStrandFlash: uniform(O.strandFlash),
      uPulseSpeed: uniform(look.pulseSpeed), uPulseDepth: uniform(look.pulseDepth),
      uOpacity: uniform(O.opacity), uGlow: uniform(look.glow),
      uColorCore: uniform(new THREE.Color(look.core)), uColorInner: uniform(new THREE.Color(look.inner)),
      uColorOuter: uniform(new THREE.Color(look.outer)), uColorHalo: uniform(new THREE.Color(look.halo)),
    };

    const group = new THREE.Group();
    const strands = Math.min(O.maxStrands, Math.max(1, Math.round(look.strands)));
    const geo = tetherGeometry(strands);
    const meshes = [true, false].map((isGlow, i) => {
      const mesh = new THREE.Mesh(geo, tetherMaterial(u, isGlow));
      mesh.frustumCulled = false;
      mesh.renderOrder = 11 + i * 2;
      group.add(mesh);
      return mesh;
    });

    // Gravity is solved so a mote launched from one end lands on the other exactly at `life`, tracing a
    // parabola through the sag peak at the midpoint — see the SAG TRAP note at the top of this file.
    const gAccel = look.moteMode === 'stream' ? (8 * look.sag) / (look.moteLife * look.moteLife) : 0;
    const particles = createSpriteParticles({
      THREE, TSL, NODES, cap: O.moteCap, colorA: look.mote, colorB: look.mote,
      gravity: look.moteMode === 'stream' ? -gAccel : 0,
      drag: look.moteMode === 'stream' ? 0 : 0.4,
      additive: true,
    });
    particles.mesh.renderOrder = 13;
    group.add(particles.mesh);

    const reticle = makeFlashSphere({ THREE, NODES, color: look.light });
    reticle.renderOrder = 14;
    group.add(reticle);

    return { look, u, group, meshes, particles, reticle };
  }

  function takeRig(palName) {
    const free = pool.get(palName);
    if (free && free.length) return free.pop();
    return buildRig(palName);
  }
  function giveRig(palName, rig) {
    rig.u.uFade.value = 0;
    rig.particles.reset();
    rig.reticle.visible = false;
    let free = pool.get(palName);
    if (!free) pool.set(palName, free = []);
    free.push(rig);
  }

  /* ------------------------------------------------------------------ */
  /* Cast                                                                */
  /* ------------------------------------------------------------------ */

  function cast({ line, seed = 1, palette = 'default', power = 1, sourceY = 0.6, targetY = 0.6 }) {
    const palName = PALETTES[palette] ? palette : 'default';
    const look = PALETTES[palName];
    const rig = takeRig(palName);
    const u = rig.u;
    const rng = mulberry32(seed >>> 0 || 1);

    // Endpoints are sampled once, here, and never revisited — see the ENDPOINT TRAP note up top.
    const origin = scratch.a.set(line.origin.x, line.origin.y + sourceY, line.origin.z);
    const target = scratch.b.set(line.target.x, line.target.y + targetY, line.target.z);
    u.uOrigin.value.copy(origin);
    u.uTarget.value.copy(target);

    const dir = new THREE.Vector3().subVectors(target, origin);
    const span = Math.max(dir.length(), 0.01);
    dir.divideScalar(span);
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
    u.uFade.value = 0;
    const strands = Math.min(O.maxStrands, Math.max(1, Math.round(look.strands * (0.8 + 0.3 * power))));
    u.uStrands.value = strands;
    for (const m of rig.meshes) m.geometry = tetherGeometry(strands);
    u.uWidth.value = look.width * (0.8 + 0.3 * power);
    u.uGlow.value = look.glow;

    const originV = origin.clone();
    const targetV = target.clone();
    /** Mirrors the axis term only (see the SAG TRAP note); exact whenever the palette's jitter is 0. */
    function axisPoint(t, out) {
      const s = saturate(t);
      out.lerpVectors(originV, targetV, s);
      out.y += look.sag * Math.sin(s * Math.PI);
      return out;
    }

    rig.particles.reset();
    const moteEmitter = createRateEmitter(O.moteCap);
    const moteVec = new THREE.Vector3();

    function emitMotes(rateNow, dt) {
      if (look.moteMode === 'none') return;
      const n = moteEmitter.take(rateNow, dt);
      for (let k = 0; k < n; k++) {
        const size = O.moteSize * (0.7 + 0.6 * rng()) * (0.85 + 0.3 * power);
        if (look.moteMode === 'stream') {
          const fromTarget = look.moteDir < 0;
          const startV = fromTarget ? targetV : originV;
          const endV = fromTarget ? originV : targetV;
          const invLife = 1 / look.moteLife;
          const vx = (endV.x - startV.x) * invLife;
          const vy = (endV.y - startV.y) * invLife + (4 * look.sag) * invLife; // + the matching arc launch
          const vz = (endV.z - startV.z) * invLife;
          rig.particles.emit(startV.x, startV.y, startV.z, vx, vy, vz, size, look.moteLife);
        } else if (look.moteMode === 'drift') {
          axisPoint(rng(), moteVec);
          const sp = 0.35;
          rig.particles.emit(moteVec.x, moteVec.y, moteVec.z, (rng() - 0.5) * sp, (rng() - 0.5) * sp * 0.5, (rng() - 0.5) * sp, size, look.moteLife);
        }
      }
    }

    const light = lights && lights.acquire ? lights.acquire() : null;
    if (light) {
      light.color.set(look.light);
      light.distance = O.lightDistance;
      light.intensity = 0;
    }
    /** Same quantised-stutter trick as fx-bolt's lightShimmer, not claiming to match the GPU flicker. */
    function shimmer(age) {
      if (look.flicker <= 0) return 1;
      const stepIndex = Math.floor(age * O.flickerSpeed);
      const n = Math.abs(Math.sin(stepIndex * 127.1) * 43758.5453) % 1;
      return 1 - look.flicker * n;
    }
    function driveLight(fade, age) {
      if (!light) return;
      axisPoint(0.5, moteVec);
      light.position.copy(moteVec);
      const pulse = look.pulseDepth > 0 ? (1 - look.pulseDepth) + look.pulseDepth * (0.5 + 0.5 * Math.sin(age * look.pulseSpeed + u.uSeed.value)) : 1;
      light.intensity = look.lightIntensity * power * fade * shimmer(age) * pulse;
    }

    rig.reticle.visible = false;
    function updateReticle(fade, age) {
      if (!look.reticle) return;
      const pulse = 0.5 + 0.5 * Math.sin(age * look.pulseSpeed * 2 + u.uSeed.value);
      rig.reticle.visible = fade > 0.001;
      rig.reticle.position.copy(targetV);
      rig.reticle.scale.setScalar(O.reticleSize * (0.7 + 0.3 * pulse) * (0.8 + 0.3 * power));
      rig.reticle.material.opacity = fade * (0.5 + 0.5 * pulse) * 0.95;
    }

    scene.add(rig.group);

    const instance = {
      group: rig.group,
      machine: null,
      onImpact: null,
      onDone: null,
      update(dt, t) {
        const alive = machine.update(dt, t);
        const fadeNow = u.uFade.value;
        emitMotes(look.moteRate * power * fadeNow, dt);
        rig.particles.step(dt);
        driveLight(fadeNow, machine.age);
        updateReticle(fadeNow, machine.age);
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
      travelTime: O.travelTime, easeIn: 0,
      impactTime: O.impactTime, fadeTime: O.fadeTime,
      onImpact() { instance.onImpact && instance.onImpact(); },
      onFade(dt, t) {
        let fade;
        if (t <= 1) {
          fade = t >= O.attachFrac ? 1 : Easing.outCubic(saturate(t / O.attachFrac));
        } else {
          const k = saturate(t - 1);
          fade = look.snap ? 1 - Easing.inCubic(k) : 1 - k; // snap holds then cuts; dissolve fades evenly
        }
        u.uFade.value = fade;
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
        rig.particles.dispose();
        rig.reticle.geometry.dispose();
        rig.reticle.material.dispose();
        if (rig.group.parent) rig.group.parent.remove(rig.group);
      }
    }
    pool.clear();
    for (const g of geoCache.values()) g.dispose();
    geoCache.clear();
  }

  return { cast, dispose, PALETTES, options: O };
}

export default createTetherFx;
