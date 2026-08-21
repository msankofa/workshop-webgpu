/**
 * fx-blade.js — a swept sword-cut: Slash, Fury Cutter, Sacred Sword, X-Scissor (steel), Night Slash
 * (shadow), Psycho Cut (psychic), Air Slash / Aerial Ace (wind).
 *
 * Donor: fx-bolt.js. Kept from it: the parameter-space ladder strip (one `InstancedBufferGeometry` of
 * (t, edge) quads, one instance per stroke), the finite-difference tangent crossed with the view vector
 * to keep the ribbon camera-facing, the width profile with its tip taper, the cross-ribbon
 * `pow(1-|edge|, sharpness)` falloff, and `uProgress` clipping the undrawn tip rather than scaling the
 * shape. Removed: the fractal kink (linear value noise), the restrike re-seeding and the quantised
 * flicker — a blade is a clean arc, not a jittering filament, so there is no noise anywhere in this file.
 *
 * The axis is the one thing that changes, and bolt's own review said that is the only thing that should
 * have to: `mix(origin, target, t)` becomes a point on a circle of radius `uRadius` in a plane that
 * passes through the target, normal to the attack direction:
 *
 *   angle = uAngleFrom + uArcAngle * t + bladeAngle(instance)
 *   here  = uCenter + uRadius * (cos(angle) * uE1 + sin(angle) * uE2)
 *
 * `uE1`/`uE2` are the same Gram-Schmidt frame bolt builds from `line.side` and the axis direction, just
 * applied to a *plane* through the target instead of a running perpendicular along the whole line. The
 * frame is static for the cast, so — as in bolt — it is computed once on the CPU at cast time rather
 * than per vertex. Because the axis has no time-varying noise term, the forward-difference tangent needs
 * none of bolt's end-of-line mirroring trick: sin/cos are defined for any angle, so sampling t + eps is
 * always safe, even past t = 1.
 *
 * A cast can carry one to three strokes (`slashes`), each a separate instance fanned out by
 * `uBladeSpread` around the centre of the fan and staggered in time by `uBladeStagger` — that is what
 * turns two overlapping arcs into an X for X-Scissor while a single stroke plays alone for Fury Cutter.
 * `slashes` is not baked into the palette as a fixed number the way colours are; each palette carries a
 * `slashes` default but a cast can override it, because the same steel look has to serve one-stroke moves
 * and a two-stroke cross. See PALETTES below and the note on Cross Poison / Razor Shell.
 *
 * Two passes share the geometry, exactly as in bolt: a soft additive halo (drawn first) and a hard core
 * on top. Psycho Cut's "doubled ribbon" is a third, structural difference rather than a shader branch —
 * palettes with `doubled: true` get two core passes instead of one, offset a fixed `uDoubleGap` apart
 * along the ribbon's own binormal (a JS-constant `sideOffset` baked into the material closure, the same
 * way bolt bakes `isGlow`'s width/opacity constants). `colorNode`/`opacityNode` are otherwise identical
 * between every palette; only the uniform values (colours, width, glow, opacity multipliers) differ,
 * which is the point of the exercise this module was asked to run.
 *
 * `makeFlashSphere`/`popFlash` (move-parts) give the brief pop where the arc crosses the target's centre,
 * and `createSpriteParticles` (move-parts) gives a small deterministic burst of glints along the cut,
 * placed by `arcPointCPU` — a CPU mirror of the vertex shader's axis term. Bolt's CPU mirror
 * (`axisPoint`) only ever reproduced the noise-free first stage of its shape function, never the kink;
 * this module's shape function has no noise at all, so `arcPointCPU` is an *exact* mirror, not an
 * approximation, and it is the only geometry this file computes twice.
 *
 * Precipice Blades is deliberately left off this roster: it throws rock spikes up out of the ground in a
 * pattern, which is ground geometry in the `fx-fissure`/`fx-crystals` family, not a ribbon swept through
 * the air. It does not belong to a swept-arc module and forcing it in would just be a worse fissure.
 */

import { createPhaseMachine, mulberry32, Easing, saturate } from './move-core.js';
import { makeFlashSphere, popFlash, createSpriteParticles } from './move-parts.js';

export const PALETTES = {
  /** Slash / Fury Cutter / Sacred Sword / X-Scissor: white-blue, thin, hard-edged, minimal glow. */
  steel: {
    core: '#eafcff', rim: '#bfe9ff', halo: '#2a5a7a', spark: '#dff6ff', light: '#8fd0ff',
    widthMul: 0.75, glowMul: 0.55, opacityMul: 1, slashes: 1, doubled: false, glow: false,
  },
  /** Night Slash: dark violet core, bright rim — the mix is the same formula, just inverted colours. */
  shadow: {
    core: '#2a0a3a', rim: '#e6c6ff', halo: '#160022', spark: '#c07bff', light: '#8a3cf0',
    widthMul: 1.5, glowMul: 1.15, opacityMul: 1, slashes: 1, doubled: false, glow: true, arcAngle: 1.7,
  },
  /** Psycho Cut: magenta, two offset core passes (the "doubled ribbon"), soft outer halo. */
  psychic: {
    core: '#ff5ad1', rim: '#ffd0f2', halo: '#7a1064', spark: '#ff9ae8', light: '#e050c0',
    widthMul: 1.1, glowMul: 1.0, opacityMul: 1, slashes: 1, doubled: true, glow: true, arcAngle: 1.3,
  },
  /** Air Slash / Aerial Ace: pale cyan, very thin, almost transparent, two or three quick strokes. */
  wind: {
    core: '#eafeff', rim: '#bfefff', halo: '#1a3a44', spark: '#dffcff', light: '#9fe8ff',
    widthMul: 0.4, glowMul: 0.45, opacityMul: 0.55, slashes: 2, doubled: false, glow: false,
    arcAngle: 1.1, bladeSpread: 0.7,
  },
  /**
   * Cross Poison: steel's structure (single ribbon, no glow) with X-Scissor's two-stroke fan, recoloured
   * violet. Reached from `steel` by a colour change plus the slash count `steel`'s own X-Scissor already
   * demonstrates.
   */
  poison: {
    core: '#f0d9ff', rim: '#c07bff', halo: '#2a0a3c', spark: '#c060ff', light: '#8a2be2',
    widthMul: 0.8, glowMul: 0.6, opacityMul: 1, slashes: 2, doubled: false, glow: false, bladeSpread: 0.7,
  },
  /** Razor Shell: steel's single-stroke structure recoloured aqua-blue. */
  water: {
    core: '#eaffff', rim: '#3fa9e0', halo: '#0a2c40', spark: '#bfe8ff', light: '#3fa9e0',
    widthMul: 0.85, glowMul: 0.6, opacityMul: 1, slashes: 1, doubled: false, glow: false,
  },
};
PALETTES.default = PALETTES.steel;

export const DEFAULTS = {
  // shape
  nodes: 10, maxSlashes: 3, slashes: 1,
  radius: 0.55, arcAngle: 1.3, bladeSpread: 0.55, bladeStagger: 0.35,
  // ribbon
  width: 0.05, widthTip: 0.35, widthCurve: 1.4, coreSharp: 4.5, glowFalloff: 1.8,
  glowWidth: 4.5, glowOpacity: 0.35, opacity: 1, glow: 1.6, doubleGap: 0.55,
  tipLength: 0.12, tipGlow: 1.4,
  // timing — a slash is over in a few tenths of a second, so every phase is short
  travelSpeed: 40, travelTime: 0.12, impactTime: 0.05, fadeTime: 0.18,
  // flash and light
  flashSize: 0.5, flashLife: 0.14, lightIntensity: 10, lightDistance: 6,
  // sparks
  sparks: true, sparkCap: 48, sparkBurst: 10, sparkSize: 0.05, sparkLife: 0.28,
  sparkSpeed: 2.6, sparkGravity: -6, sparkDrag: 1.8,
};

/**
 * @param {object} deps { THREE, TSL, NODES, scene, terrainHeight, lights }
 * @param {object} options overrides for DEFAULTS
 */
export function createBladeFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, lights } = deps;
  const O = Object.assign({}, DEFAULTS, options);
  const {
    Fn, attribute, uniform, positionGeometry, cameraPosition,
    float, mix, smoothstep, step, pow, sin, cos, normalize, cross, length, max, clamp,
  } = TSL;

  const scratch = { v: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3() };

  /* ------------------------------------------------------------------ */
  /* Geometry — parameter space only, one ladder strip per stroke         */
  /* ------------------------------------------------------------------ */

  const geoCache = new Map();
  function arcGeometry(slashes) {
    let g = geoCache.get(slashes);
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
    const blade = new Float32Array(slashes);
    for (let i = 0; i < slashes; i++) blade[i] = i;
    g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aBlade', new THREE.InstancedBufferAttribute(blade, 1));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.instanceCount = slashes;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4); // placed in the shader, never culled
    geoCache.set(slashes, g);
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* Material                                                            */
  /* ------------------------------------------------------------------ */

  const aBlade = attribute('aBlade', 'float');

  /** `here` at parameter `t` for instance `blade` — the only place the arc shape is defined. */
  function shapePoint(u, t, blade) {
    const bladeAngle = blade.sub(u.uBladeCenter).mul(u.uBladeSpread);
    const angle = u.uAngleFrom.add(u.uArcAngle.mul(t)).add(bladeAngle);
    return u.uCenter.add(u.uE1.mul(cos(angle)).add(u.uE2.mul(sin(angle))).mul(u.uRadius));
  }

  /** `localU` staggers each blade's reveal: blade 0 starts at machine.u = 0, later blades start later. */
  function localProgress(u) {
    const bladeStart = aBlade.mul(u.uBladeStagger);
    const denom = max(float(1).sub(bladeStart), float(1e-3));
    return clamp(u.uProgress.sub(bladeStart).div(denom), 0, 1);
  }

  function bladeMaterial(u, isGlow, sideOffset) {
    const widthScale = isGlow ? O.glowWidth : 1;
    const passOpacity = isGlow ? O.glowOpacity : 1;

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
      const blade = aBlade.toVar();
      const here = shapePoint(u, t, blade).toVar();

      // No noise in the axis, so unlike bolt no end-of-strip mirroring is needed: t + eps is always valid.
      const stp = float(0.02);
      const ahead = shapePoint(u, t.add(stp), blade);
      const tangent = normalize(ahead.sub(here)).toVar();

      const toCamera = normalize(cameraPosition.sub(here));
      const bn = cross(tangent, toCamera).toVar();
      const bl = length(bn).toVar();
      const binormal = mix(u.uE1, bn.div(max(bl, float(1e-4))), step(float(1e-4), bl)).toVar();

      const halfWidth = u.uWidth.mul(widthScale)
        .mul(mix(float(1), u.uWidthTip, pow(clamp(t, 0, 1), max(u.uWidthCurve, float(0.01)))))
        .mul(u.uFade);

      const doubled = binormal.mul(sideOffset).mul(u.uDoubleGap).mul(u.uWidth);
      return here.add(doubled).add(binormal.mul(edge).mul(halfWidth));
    })();

    // Cross-ribbon profile: high at the centreline, falling off to the edges.
    const profileOf = () => {
      const v = clamp(positionGeometry.y.abs(), 0, 1);
      return pow(v.oneMinus(), max(isGlow ? u.uGlowFalloff : u.uCoreSharp, float(0.05)));
    };
    const drawnOf = () => {
      const tip = max(u.uTipLength, float(1e-3));
      return smoothstep(float(0), float(1), clamp(localProgress(u).sub(positionGeometry.x).div(tip), 0, 1));
    };

    material.colorNode = Fn(() => {
      const profile = profileOf().toVar();
      // Rim vs core is entirely a data choice: steel puts bright at the centre, shadow puts it at the
      // rim, by swapping which colour is uColorCore and which is uColorRim in the palette.
      const base = isGlow ? u.uColorHalo : mix(u.uColorRim, u.uColorCore, profile);
      const tip = max(u.uTipLength, float(1e-3));
      const localU = localProgress(u);
      const front = smoothstep(localU.sub(tip.mul(2)), localU, positionGeometry.x);
      return base.add(u.uColorCore.mul(front).mul(u.uTipGlow)).mul(u.uGlow);
    })();

    material.opacityNode = Fn(() => profileOf().mul(drawnOf()).mul(u.uFade).mul(passOpacity).mul(u.uOpacity))();

    return material;
  }

  /* ------------------------------------------------------------------ */
  /* Rigs — one full set of meshes per live cast, pooled by palette       */
  /* ------------------------------------------------------------------ */

  const pool = new Map();

  function buildRig(palName) {
    const pal = PALETTES[palName] || PALETTES.default;
    const u = {
      uCenter: uniform(new THREE.Vector3()), uE1: uniform(new THREE.Vector3(1, 0, 0)), uE2: uniform(new THREE.Vector3(0, 1, 0)),
      uRadius: uniform(O.radius), uAngleFrom: uniform(-O.arcAngle / 2), uArcAngle: uniform(O.arcAngle),
      uBladeCenter: uniform(0), uBladeSpread: uniform(O.bladeSpread), uBladeStagger: uniform(O.bladeStagger),
      uProgress: uniform(0), uFade: uniform(1),
      uWidth: uniform(O.width * (pal.widthMul ?? 1)), uWidthTip: uniform(O.widthTip), uWidthCurve: uniform(O.widthCurve),
      uCoreSharp: uniform(O.coreSharp), uGlowFalloff: uniform(O.glowFalloff), uDoubleGap: uniform(O.doubleGap),
      uTipLength: uniform(O.tipLength), uTipGlow: uniform(O.tipGlow),
      uOpacity: uniform(O.opacity * (pal.opacityMul ?? 1)), uGlow: uniform(O.glow * (pal.glowMul ?? 1)),
      uColorCore: uniform(new THREE.Color(pal.core)), uColorRim: uniform(new THREE.Color(pal.rim)), uColorHalo: uniform(new THREE.Color(pal.halo)),
    };

    const group = new THREE.Group();
    const geo = arcGeometry(Math.min(O.maxSlashes, Math.max(1, Math.round(pal.slashes || O.slashes))));
    const meshes = [];
    const halo = new THREE.Mesh(geo, bladeMaterial(u, true, 0));
    halo.frustumCulled = false; halo.renderOrder = 11; group.add(halo); meshes.push(halo);
    if (pal.doubled) {
      for (const side of [-1, 1]) {
        const core = new THREE.Mesh(geo, bladeMaterial(u, false, side));
        core.frustumCulled = false; core.renderOrder = 13; group.add(core); meshes.push(core);
      }
    } else {
      const core = new THREE.Mesh(geo, bladeMaterial(u, false, 0));
      core.frustumCulled = false; core.renderOrder = 13; group.add(core); meshes.push(core);
    }

    const flash = makeFlashSphere({ THREE, NODES, color: pal.core });
    flash.renderOrder = 10;
    group.add(flash);

    let sparks = null;
    if (O.sparks) {
      sparks = createSpriteParticles({
        THREE, TSL, NODES, cap: O.sparkCap, colorA: pal.spark, colorB: pal.core,
        gravity: O.sparkGravity, drag: O.sparkDrag, additive: true,
      });
      sparks.mesh.renderOrder = 12;
      group.add(sparks.mesh);
    }

    return { pal, u, group, meshes, flash, sparks };
  }

  function takeRig(palName) {
    const free = pool.get(palName);
    if (free && free.length) return free.pop();
    return buildRig(palName);
  }
  function giveRig(palName, rig) {
    rig.u.uFade.value = 0;
    rig.flash.visible = false;
    if (rig.sparks) rig.sparks.reset();
    let free = pool.get(palName);
    if (!free) pool.set(palName, free = []);
    free.push(rig);
  }

  /* ------------------------------------------------------------------ */
  /* Cast                                                                */
  /* ------------------------------------------------------------------ */

  function cast({ line, seed = 1, palette = 'default', power = 1, sourceY = 0.6, targetY = 0.6, slashes, arcAngle } = {}) {
    const palName = PALETTES[palette] ? palette : 'default';
    const rig = takeRig(palName);
    const u = rig.u;
    const pal = rig.pal;
    const rng = mulberry32(seed >>> 0 || 1);

    const n = Math.min(O.maxSlashes, Math.max(1, Math.round(slashes != null ? slashes : (pal.slashes || O.slashes))));
    const geo = arcGeometry(n);
    for (const m of rig.meshes) m.geometry = geo;

    const origin = new THREE.Vector3(line.origin.x, line.origin.y + sourceY, line.origin.z);
    const target = new THREE.Vector3(line.target.x, line.target.y + targetY, line.target.z);
    const dir = new THREE.Vector3().subVectors(target, origin);
    dir.divideScalar(Math.max(dir.length(), 0.01));
    // Gram-Schmidt, same convention as bolt: line.side is only approximately perpendicular to dir.
    const e1 = new THREE.Vector3(line.side.x, 0, line.side.z);
    e1.addScaledVector(dir, -e1.dot(dir));
    if (e1.lengthSq() < 1e-8) e1.set(0, 1, 0).cross(dir);
    e1.normalize();
    const e2 = new THREE.Vector3().crossVectors(dir, e1).normalize();

    u.uCenter.value.copy(target);
    u.uE1.value.copy(e1);
    u.uE2.value.copy(e2);
    u.uRadius.value = O.radius * (0.8 + 0.3 * power);
    const arc = arcAngle ?? pal.arcAngle ?? O.arcAngle;
    u.uArcAngle.value = arc;
    u.uAngleFrom.value = -arc / 2;
    u.uBladeCenter.value = (n - 1) / 2;
    u.uBladeSpread.value = pal.bladeSpread ?? O.bladeSpread;
    u.uBladeStagger.value = pal.bladeStagger ?? O.bladeStagger;
    u.uWidth.value = O.width * (pal.widthMul ?? 1) * (0.8 + 0.3 * power);
    u.uProgress.value = 0;
    u.uFade.value = 1;

    /**
     * CPU mirror of `shapePoint` above. There is no noise in the shape function (unlike bolt's
     * `boltPoint`, which this mirrors only the noise-free axis of), so this reproduces the vertex shader
     * exactly rather than approximately — used to place sparks and the impact flash on the drawn arc.
     */
    function arcPointCPU(t, bladeIdx, out) {
      const bladeAngle = (bladeIdx - u.uBladeCenter.value) * u.uBladeSpread.value;
      const angle = u.uAngleFrom.value + u.uArcAngle.value * t + bladeAngle;
      out.copy(target);
      out.addScaledVector(e1, Math.cos(angle) * u.uRadius.value);
      out.addScaledVector(e2, Math.sin(angle) * u.uRadius.value);
      return out;
    }

    /* --- sparks --- */
    function emitSparks(count) {
      if (!rig.sparks) return;
      for (let i = 0; i < count; i++) {
        const b = Math.floor(rng() * n);
        const t = rng();
        const bladeAngle = (b - u.uBladeCenter.value) * u.uBladeSpread.value;
        const angle = u.uAngleFrom.value + u.uArcAngle.value * t + bladeAngle;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        arcPointCPU(t, b, scratch.v);
        const speed = O.sparkSpeed * (0.4 + rng() * 0.8) * power;
        const rx = ca * e1.x + sa * e2.x, ry = ca * e1.y + sa * e2.y, rz = ca * e1.z + sa * e2.z; // radial dir
        rig.sparks.emit(
          scratch.v.x, scratch.v.y, scratch.v.z,
          rx * speed, ry * speed + O.sparkSpeed * 0.3, rz * speed,
          O.sparkSize * (0.6 + rng() * 0.6) * power, O.sparkLife * (0.6 + rng() * 0.6),
        );
      }
    }

    /* --- flash --- */
    let flashAge = -1;

    /* --- light: only palettes that glow spend one --- */
    const light = pal.glow && lights && lights.acquire ? lights.acquire() : null;
    if (light) {
      light.color.set(pal.light);
      light.distance = O.lightDistance * (0.7 + 0.5 * power);
      light.intensity = 0;
      light.position.copy(target);
    }

    scene.add(rig.group);

    const instance = {
      group: rig.group,
      machine: null,
      onImpact: null,
      onDone: null,
      update(dt, t) {
        const alive = machine.update(dt, t);
        if (rig.sparks) rig.sparks.step(dt);
        if (flashAge >= 0) { flashAge += dt; popFlash(rig.flash, target.x, target.y, target.z, O.flashSize * power, flashAge, O.flashLife); }
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
      travelSpeed: O.travelSpeed, travelTime: O.travelTime, easeIn: 0, // a slash starts at full speed, no wind-up
      impactTime: O.impactTime, fadeTime: O.fadeTime,
      onSpawn() {
        flashAge = -1;
      },
      onTravel() {
        u.uProgress.value = this.u;
        if (light) light.intensity = O.lightIntensity * power * this.u;
      },
      onImpact() {
        u.uProgress.value = 1;
        flashAge = 0;
        emitSparks(O.sparkBurst);
        if (light) light.intensity = O.lightIntensity * power * 1.3;
        instance.onImpact && instance.onImpact();
      },
      onFade(dt, t) {
        // t runs 0..1 through the hold, then 1..2 through the blow-out.
        const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
        u.uFade.value = fade;
        u.uProgress.value = 1;
        if (light) light.intensity = O.lightIntensity * power * fade * 0.6;
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
        rig.flash.material.dispose();
        rig.flash.geometry.dispose();
        if (rig.sparks) rig.sparks.dispose();
        if (rig.group.parent) rig.group.parent.remove(rig.group);
      }
    }
    pool.clear();
    for (const g of geoCache.values()) g.dispose();
    geoCache.clear();
  }

  return { cast, dispose, PALETTES, options: O };
}

export default createBladeFx;
