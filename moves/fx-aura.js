/**
 * fx-aura.js — the stat-boost flourish: a close aura that hugs the caster's own body, climbs it, and
 * resolves at the top (a burst, a spiral, a settle, a sinking hush — palette-dependent), then fades.
 * Powers Swords Dance/Bulk Up/Work Up/Focus Energy/Calm Mind/Agility/Nasty Plot/Curse/Dragon Dance/
 * Growth/Charge/Wild Charge: the set's stat boosts, which had no self-worn effect before this module.
 *
 * DONOR: fx-aurora.js, collapsed from a wide ground ring several metres out to a sleeve that wraps the
 * body. What carries over: the ring path (now `buildRing` from move-parts, the exact function aurora's
 * own ring code was later lifted into), the curtain grid (vertex sits at the hem, the vertex stage lifts
 * it), the trick of driving fragment brightness off the same phase the vertex sway uses, and the ground
 * hem strip. The blade/ring mask (SHAPE PER PALETTE below) reads `pal.bladeCount`/`pal.ringFreq` as a
 * ring-angle harmonic the same way aurora's fold/sway/ripple terms did, so those stay even integers by
 * construction instead of going through move-parts' `harmonic()` helper — there is no seam to protect
 * for a palette in ring mode, and every blade-mode palette's count was chosen even by hand. What does
 * not carry over: aurora's motes were a flat un-billboarded
 * `InstancedMesh` (flagged in the subsystem doc as thinning edge-on) — this module uses move-parts'
 * `createSpriteParticles` instead, the billboarded kit fx-stream's puffs use. The electric look (charge
 * palette) borrows fx-bolt's idea of a parametric ladder-strip ribbon shaped entirely in the vertex
 * stage, rewritten from scratch below (ARCS) because bolt's own kink/hash helpers are closures private
 * to that file, not exports. Bolt's own review called out the hazard directly: its kink frequency is
 * `jitterScale * spanMetres` cycles across the whole strike, which keeps a constant kink *wavelength* in
 * world space no matter how long the bolt is — reusing that formula unscaled on an arc a few tens of
 * centimetres long would put less than one kink cycle on the whole thing (too smooth), while reusing
 * bolt's absolute *jitter amplitude* (tuned for multi-metre strikes) unscaled would offset a short arc by
 * more than its own length (a tangled scribble, not a filament). ARCS below fixes both: kink frequency
 * is `kinksPerMetre * thisArc'sOwnLength` cycles (so short arcs still read as a few clean zigzags, not a
 * flat line or a knot), and jitter amplitude is a fraction of the aura's own radius, not an absolute
 * metre figure copied from a multi-metre reference.
 *
 * SHAPE PER PALETTE. One curtain shader serves all six looks; what differs is baked in as plain JS
 * numbers at build time (no runtime branch, no extra uniforms) rather than as six separate shaders:
 *   - A silhouette mask, `abs(sin(...))` raised to a sharpness power and thresholded by a duty cycle,
 *     applied either around the ring (vertical "blade" gaps — might, charge, growth, malice, draconic)
 *     or up the height (horizontal "band" gaps — mind's concentric rings). The failure mode named in the
 *     brief is a glowing cylinder reading as a container; this mask is what keeps every palette from
 *     closing into one.
 *   - `might`/`charge`: low duty, high sharpness — few, bright, narrow blades/filaments.
 *   - `mind`: high duty, low sharpness, in the ring (not blade) mode — broad, soft horizontal bands that
 *     drift upward, which is as close to "concentric rings rising" as one warped grid gets without a
 *     second geometry.
 *   - `malice`: mid duty, mid sharpness, blade mode, `riseSign: -1` (see COVERAGE below) and a wide
 *     `rimBand`, so the colour reads dark through the body of the cloth with a bright edge — the "void
 *     with a bright skin" the brief asks for, approximated as a gradient stop near the curtain's own top
 *     edge rather than a true view-dependent fresnel (no per-fragment normal survives the displacement,
 *     so this is a cheap stand-in, not a rim light; flagged below as a number to revisit in a browser).
 *   - `draconic`: two wide blades whose angular position is offset by `twist * aV`, i.e. the blade
 *     rotates as it climbs — a barber-pole spiral rather than a straight stripe.
 *
 * COVERAGE. A second, independent front controls how much of the curtain's height is drawn, driven by
 * `uT` (the same 0..1 impact / 1..2 fade timeline `onFade` already hands every effect in this set):
 * `envelope = smoothstep(0, 0.3, uT) * (1 - smoothstep(1.0, 1.9, uT))` rises over the first 30% of the
 * hold and falls back over most of the release, and `coverage` reveals vertices whose height fraction is
 * below `envelope` (or, when `riseSign < 0`, above `1 - envelope` — the same formula run on the mirrored
 * coordinate). That single sign flip is malice's "sinking rather than rising": its curtain appears at the
 * head and descends to cling low, instead of growing up from the feet.
 *
 * ANCHOR GAP. Every move in this set is cast with `move.self: true`, which per `castMove` in
 * `demos/pokemon-moves.html` makes `to` literally the same object reference as `from`; `makeLine`'s
 * degenerate-length branch then walks a fixed 5 cm north from that point rather than producing a true
 * zero-length line, so `line.dir`/`line.side` are a fixed, arbitrary frame — fine here, since nothing
 * below reads them; only `line.origin` matters. The returned `group` is parented directly to `scene`
 * (never to the caster's rig) and is positioned once, at cast time, from that origin. This is the same
 * gap every self-buff effect in this set has, but it is the most visible here of all of them, because
 * this module is built specifically to look worn: if the creature walks away mid-cast, the aura stays
 * planted on the ground where the move was cast and the body walks out of it. The fix is a follow
 * target the harness does not pass through `cast()`, so it is out of scope here; the mitigation is
 * keeping the whole flourish to about a second (see TIMING) so a walk cycle rarely gets the chance.
 *
 * BODY PROPORTIONS. `sourceY` is the only body measurement `cast()` receives — the caster's origin
 * height above the terrain, the same number fx-bolt adds to its origin to leave from mouth height. There
 * is no body-width figure anywhere in the contract, so the sleeve's radius is guessed as a fraction of
 * `sourceY` (`radiusFrac`, 0.30-0.42 depending on palette) under the assumption that the stadium walkers
 * this set is cast between are roughly as wide as they are a third-again tall — closer to a stocky biped
 * or quadruped stance than a slim human one — then clamped to [0.22 m, 1.1 m] so a very short or very
 * tall caster does not collapse the sleeve to a sliver or balloon it past believable. `heightFrac` (0.55
 * for malice's low cling, up to 1.22 for draconic's climb past the head) scales `sourceY` itself, so a
 * tall creature's aura and a short creature's aura both reach proportionally the same place on the body.
 * Both fractions are guesses pending a browser: they are tuned against no reference art at all.
 *
 * TIMING. `status: true` (set by the registry, not here) means no health bar reacts to any of this, and
 * the brief is explicit that a stat-boost flourish should read as a flourish, not a field effect: no
 * hold. Total lifetime is `travelTime + impactTime + fadeTime`, scaled per palette by `pace` — 0.12 s +
 * 0.5 s + 0.3 s = 0.92 s at `pace: 1` (might), stretched to about 1.24 s for mind's slower rings,
 * compressed to about 0.55 s for growth's "brief" read. Every number here is a guess about how long a
 * glance needs to register the shape before it goes; none of it has been seen animate.
 *
 * LAYERS, all additive, all built fresh per cast and disposed with the instance (this module does not
 * pool rigs across casts the way fx-bolt does, matching aurora's simpler per-cast build):
 *   - CURTAIN x2 (front + a de-phased, shorter, dimmer inner pass, same trick as aurora's front/back).
 *   - HEM — a flat ring strip at the feet, aurora's ground-glow strip sized to the sleeve's own radius.
 *   - ARCS — short vertical crackle ribbons scattered around the body (see the DONOR note above);
 *     skipped entirely (no mesh built) for palettes with `crackle: 0`, which is every palette but
 *     might, draconic and charge.
 *   - MOTES — a single deterministic burst from `createSpriteParticles` at cast time (no continuous
 *     trickle: the whole effect is under a second, so one burst plus the pool's own per-particle life is
 *     enough to cover it), rising for every palette but malice, where they sink; draconic and mind add a
 *     small tangential drift so the burst reads as a slow spiral rather than a straight column.
 *   - BURST — a pooled flash sphere (move-parts' `makeFlashSphere`/`popFlash`) popped once at the top of
 *     the sleeve when `onImpact` fires, only for palettes with `burst: 1` (might, charge).
 *   - LIGHT SPILL — two pooled point lights (of the six-light budget) breathing near the body, faded by
 *     the same `envelope` as the curtain.
 *
 * CPU/GPU MIRROR: none. Every displaced vertex only ever exists on the GPU; the CPU-side mote and light
 * placement use their own, independent formulas (a straight burst velocity and a breathing sine) rather
 * than re-deriving anything the shader computes, so there is nothing to keep in sync by hand.
 */

import { createPhaseMachine, mulberry32, saturate } from './move-core.js';
import { buildRing, createSpriteParticles, makeFlashSphere, popFlash } from './move-parts.js';

const TAU = Math.PI * 2;

export const PALETTES = {
  /** Swords Dance, Bulk Up, Work Up, Focus Energy — sharp rising blades, hard flash at the peak. */
  might: {
    base: 0xb01400, mid: 0xff5a1e, top: 0xffe9a0, light: 0xff7a33,
    bladeCount: 16, bladeDuty: 0.32, bladeSharp: 2.4, ringMode: 0, ringFreq: 0, twist: 0, rimBand: 0.12,
    burst: 1, crackle: 0.12, riseSign: 1, flow: 1.35, heightFrac: 1.18, radiusFrac: 0.34, pace: 0.95,
    moteDir: 1, spiral: 0,
  },
  /** Calm Mind, Agility — cool, smooth, slow concentric rings rising, no burst. */
  mind: {
    base: 0x2c5a8c, mid: 0x6fb3ff, top: 0xffffff, light: 0x8fc8ff,
    bladeCount: 9, bladeDuty: 0.92, bladeSharp: 0.7, ringMode: 1, ringFreq: 4, twist: 0, rimBand: 0.3,
    burst: 0, crackle: 0, riseSign: 1, flow: 0.5, heightFrac: 1.02, radiusFrac: 0.36, pace: 1.35,
    moteDir: 1, spiral: 0.15,
  },
  /** Nasty Plot, Curse — low, clinging, sinks rather than rises; a dark body with a bright edge. */
  malice: {
    base: 0x05010a, mid: 0x2a0a3d, top: 0xc24dff, light: 0x8a2be2,
    bladeCount: 10, bladeDuty: 0.7, bladeSharp: 1.3, ringMode: 0, ringFreq: 0, twist: 0, rimBand: 0.45,
    burst: 0, crackle: 0, riseSign: -1, flow: 0.5, heightFrac: 0.55, radiusFrac: 0.42, pace: 1.1,
    moteDir: -1, spiral: 0,
  },
  /** Dragon Dance — a teal/violet helix spiralling up the body. */
  draconic: {
    base: 0x0c8a78, mid: 0x5a4bff, top: 0xc79bff, light: 0x7a5aff,
    bladeCount: 2, bladeDuty: 0.55, bladeSharp: 1.6, ringMode: 0, ringFreq: 0, twist: 2.6, rimBand: 0.15,
    burst: 0, crackle: 0.06, riseSign: 1, flow: 1.05, heightFrac: 1.22, radiusFrac: 0.3, pace: 1.15,
    moteDir: 1, spiral: 0.5,
  },
  /** Growth — green, brief, upward, light. */
  growth: {
    base: 0x2f8f3a, mid: 0x8dff6b, top: 0xf3fff0, light: 0x9dffb0,
    bladeCount: 12, bladeDuty: 0.82, bladeSharp: 1.0, ringMode: 0, ringFreq: 0, twist: 0, rimBand: 0.15,
    burst: 0, crackle: 0, riseSign: 1, flow: 1.4, heightFrac: 0.8, radiusFrac: 0.3, pace: 0.6,
    moteDir: 1, spiral: 0,
  },
  /** Charge, Wild Charge — yellow-white, crackling arcs dominate over a thin sleeve. */
  charge: {
    base: 0xb0900a, mid: 0xffe066, top: 0xffffff, light: 0xffe066,
    bladeCount: 22, bladeDuty: 0.22, bladeSharp: 3.2, ringMode: 0, ringFreq: 0, twist: 0.25, rimBand: 0.1,
    burst: 1, crackle: 1, riseSign: 1, flow: 1.6, heightFrac: 1.1, radiusFrac: 0.34, pace: 0.85,
    moteDir: 1, spiral: 0.1,
  },
};
PALETTES.default = PALETTES.might;

const DEFAULTS = {
  segments: 40, heightSegs: 9, unfurlWidth: 0.24,
  travelTime: 0.12, impactTime: 0.5, fadeTime: 0.3,
  hemWidth: 0.1,
  radiusMin: 0.22, radiusMax: 1.1,
  moteCap: 90, motesBurst: 30,
  arcSteps: 9, arcCountBase: 6, arcWidth: 0.05, arcKinksPerMetre: 5,
  lightCount: 2, lightRange: 5, lightSpill: 1.15,
  brightness: 1,
};

/** Ring-column crest jitter, three integer harmonics like aurora's — closes without a seam. */
function crestJit(a, phase) {
  return 1
    + 0.17 * Math.sin(a * 2 + phase[0])
    + 0.12 * Math.sin(a * 3 + phase[1])
    + 0.08 * Math.sin(a * 5 + phase[2]);
}

/** Curtain grid: every vertex sits at the hem; height, sway and mask all happen in the vertex/fragment stage. */
function buildCurtainGeometry(THREE, ring, rows, jitPhase) {
  const cols = ring.length, n = cols * rows;
  const pos = new Float32Array(n * 3), side = new Float32Array(n * 3);
  const us = new Float32Array(n), vs = new Float32Array(n), jits = new Float32Array(n);
  const idx = [];
  for (let i = 0; i < cols; i++) {
    const p = ring[i];
    const jit = crestJit(p.u * TAU, jitPhase);
    for (let r = 0; r < rows; r++) {
      const vi = i * rows + r;
      pos[vi * 3] = p.x; pos[vi * 3 + 1] = p.y; pos[vi * 3 + 2] = p.z;
      side[vi * 3] = p.sx; side[vi * 3 + 1] = 0; side[vi * 3 + 2] = p.sz;
      us[vi] = p.u; vs[vi] = r / (rows - 1); jits[vi] = jit;
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

/** Two-row ring strip at the feet, aurora's hem shape reused verbatim at the sleeve's own radius. */
function buildHemGeometry(THREE, ring) {
  const cols = ring.length;
  const pos = new Float32Array(cols * 2 * 3), side = new Float32Array(cols * 2 * 3);
  const across = new Float32Array(cols * 2), us = new Float32Array(cols * 2);
  const idx = [];
  for (let i = 0; i < cols; i++) {
    const p = ring[i];
    for (let k = 0; k < 2; k++) {
      const vi = i * 2 + k;
      pos[vi * 3] = p.x; pos[vi * 3 + 1] = p.y + 0.015; pos[vi * 3 + 2] = p.z;
      side[vi * 3] = p.sx; side[vi * 3 + 1] = 0; side[vi * 3 + 2] = p.sz;
      across[vi] = k === 0 ? -1 : 1; us[vi] = p.u;
    }
  }
  for (let i = 0; i < cols - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 3));
  geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geo.setIndex(idx);
  return geo;
}

/** Arc ladder-strip geometry (t along, ±1 across), one instance per arc — bolt's ribbon shape, cached by count. */
const arcGeoCache = new Map();
function buildArcGeometry(THREE, steps, count) {
  const key = steps * 1000 + count;
  let g = arcGeoCache.get(key);
  if (g) return g;
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
  const aArc = new Float32Array(count);
  for (let i = 0; i < count; i++) aArc[i] = i;
  g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aArc', new THREE.InstancedBufferAttribute(aArc, 1));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4); // placed in the shader, never culled
  arcGeoCache.set(key, g);
  return g;
}

export function createAuraFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene } = deps;
  const terrainHeight = deps.terrainHeight || (() => 0);
  const lightPool = deps.lights || { acquire: () => null, release: () => {} };
  const o = { ...DEFAULTS, ...options };

  const {
    abs, attribute, cameraPosition, cos, cross, float, floor, fract, hash, mix,
    normalize, positionGeometry, positionLocal, pow, sin, smoothstep, time, uniform, vec3,
  } = TSL;

  function cast({ line, seed = 1, palette = 'default', power = 1, sourceY = 1.0 }) {
    const rnd = mulberry32(seed >>> 0 || 1);
    const palName = PALETTES[palette] ? palette : 'default';
    const pal = PALETTES[palName];

    const bodyY = Math.max(0.3, sourceY); // a crouched or tiny caster still gets a legible sleeve
    const radius = Math.min(o.radiusMax, Math.max(o.radiusMin, bodyY * pal.radiusFrac)) * Math.pow(Math.max(power, 0.05), 0.22);
    const height = bodyY * pal.heightFrac * Math.pow(Math.max(power, 0.05), 0.3);
    const bright = o.brightness * (0.8 + 0.2 * power);

    const group = new THREE.Group();
    group.position.set(line.origin.x, line.origin.y, line.origin.z);
    scene.add(group);

    const ring = buildRing({ segments: o.segments, radius, ox: line.origin.x, oy: line.origin.y, oz: line.origin.z, terrainHeight });
    const rows = o.heightSegs + 1;
    const jitPhase = [rnd() * TAU, rnd() * TAU, rnd() * TAU];

    const materials = [];
    const uGrown = uniform(0);   // angular wipe-in during TRAVEL, aurora's own trick
    const uT = uniform(0);       // onFade's own 0..1 impact / 1..2 fade timeline, shared by every layer
    const uHeight = uniform(height);
    const uFlow = uniform(pal.flow);
    const uBright = uniform(bright);
    const uBase = uniform(new THREE.Color(pal.base));
    const uMid = uniform(new THREE.Color(pal.mid));
    const uTop = uniform(new THREE.Color(pal.top));
    const uHemW = uniform(o.hemWidth * (0.7 + 0.5 * power));
    const T = time.mul(uFlow);

    // Rises from vFrac 0->1 as the coverage envelope opens; riseSign<0 mirrors it so the mask opens
    // from the top down instead — malice's "sinking rather than rising".
    const envelopeOf = () => {
      const growUp = smoothstep(float(0), float(0.3), uT);
      const fadeDown = smoothstep(float(1.0), float(1.9), uT);
      return growUp.mul(fadeDown.oneMinus());
    };
    const coverageOf = (vFrac, env) => smoothstep(float(-0.08), float(0.08), env.sub(vFrac));

    function curtainMaterial(phase, stature, dim) {
      const mat = new NODES.MeshBasicNodeMaterial();
      mat.transparent = true; mat.depthWrite = false;
      mat.side = THREE.DoubleSide; mat.blending = THREE.AdditiveBlending; mat.toneMapped = false;
      materials.push(mat);

      const aSide = vec3(attribute('aSide', 'vec3'));
      const aU = float(attribute('aU', 'float'));
      const aV = float(attribute('aV', 'float'));
      const aJit = float(attribute('aColJit', 'float'));
      const ang = aU.mul(TAU);
      const vFrac = pal.riseSign < 0 ? aV.oneMinus() : aV;

      const env = envelopeOf();
      const coverage = coverageOf(vFrac, env);
      const wipe = smoothstep(float(0), float(o.unfurlWidth), uGrown.sub(aU));

      const bumpAng = abs(sin(ang.mul(pal.bladeCount * 0.5).sub(aV.mul(pal.twist).mul(TAU))));
      const bumpH = abs(sin(aV.mul(pal.ringFreq * TAU).add(T.mul(1.3))));
      const bump = pal.ringMode ? bumpH : bumpAng;
      const mask = smoothstep(float(1 - pal.bladeDuty), float(1), pow(bump, float(pal.bladeSharp)));

      const breath = T.mul(0.6).add(phase).sin().mul(0.18).add(0.85);
      const sway = ang.mul(6).add(T.mul(1.1)).add(phase).sin().mul(0.5)
        .add(ang.mul(11).sub(T.mul(0.7)).add(aV.mul(1.6)).add(phase).sin().mul(0.35));
      const lift = uHeight.mul(aJit).mul(aV).mul(coverage).mul(stature).mul(breath);

      mat.positionNode = positionLocal
        .add(vec3(0, 1, 0).mul(lift))
        .add(aSide.mul(uHeight.mul(0.06).mul(sway).mul(coverage)));

      const taper = pow(vFrac.oneMinus().add(0.15), float(0.85));
      const rim = smoothstep(float(1 - pal.rimBand), float(1), vFrac).mul(1.6).add(1);
      let grad = mix(vec3(uBase), vec3(uMid), smoothstep(float(0.05), float(0.5), vFrac));
      grad = mix(grad, vec3(uTop), smoothstep(float(0.5), float(0.95), vFrac));

      const crackleFlicker = pal.crackle > 0.3
        ? mix(float(1), hash(floor(T.mul(24)).add(ang.mul(3))), float(0.6))
        : float(1);

      mat.colorNode = grad.mul(rim).mul(breath).mul(uBright).mul(1.25 * dim).mul(crackleFlicker);
      mat.opacityNode = taper.mul(mask).mul(coverage).mul(wipe).mul(0.9);
      return mat;
    }

    const curtainGeo = buildCurtainGeometry(THREE, ring, rows, jitPhase);
    const frontMesh = new THREE.Mesh(curtainGeo, curtainMaterial(0, 1, 1));
    const innerMesh = new THREE.Mesh(curtainGeo, curtainMaterial(2.4, 0.7, 0.55));
    for (const m of [innerMesh, frontMesh]) { m.renderOrder = 2; m.frustumCulled = false; group.add(m); }

    // ----- hem -----
    const hemMat = new NODES.MeshBasicNodeMaterial();
    hemMat.transparent = true; hemMat.depthWrite = false; hemMat.blending = THREE.AdditiveBlending;
    hemMat.side = THREE.DoubleSide; hemMat.toneMapped = false;
    materials.push(hemMat);
    {
      const aSide = vec3(attribute('aSide', 'vec3'));
      const aAcross = float(attribute('aAcross', 'float'));
      const aU = float(attribute('aU', 'float'));
      hemMat.positionNode = positionLocal.add(aSide.mul(aAcross.mul(uHemW)));
      const wipe = smoothstep(float(0), float(o.unfurlWidth * 2.5), uGrown.sub(aU));
      const falloff = abs(aAcross).oneMinus().max(0).pow(1.5);
      const shimmer = aU.mul(TAU * 6).add(T).cos().mul(0.2).add(0.8);
      const env = envelopeOf();
      hemMat.colorNode = mix(vec3(uBase), vec3(uMid), 0.4).mul(falloff).mul(shimmer).mul(uBright).mul(0.6);
      hemMat.opacityNode = wipe.mul(env);
    }
    const hemMesh = new THREE.Mesh(buildHemGeometry(THREE, ring), hemMat);
    hemMesh.renderOrder = 1; hemMesh.frustumCulled = false;
    group.add(hemMesh);

    // ----- arcs (crackle) -----
    if (pal.crackle > 0) {
      const arcCount = Math.max(2, Math.round(o.arcCountBase * pal.crackle * (0.7 + 0.5 * power)));
      const arcMat = new NODES.MeshBasicNodeMaterial();
      arcMat.transparent = true; arcMat.depthWrite = false; arcMat.blending = THREE.AdditiveBlending;
      arcMat.side = THREE.DoubleSide; arcMat.toneMapped = false;
      materials.push(arcMat);

      const uSeed = uniform(rnd() * 97);
      const uArcCount = uniform(arcCount);
      const uRadius = uniform(radius * 0.98);
      const uYMax = uniform(height);
      const uArcLen = uniform(height * 0.3); // typical arc span; kink frequency below is scaled to it, not to sourceY
      const uWidth = uniform(o.arcWidth * (0.8 + 0.4 * power));
      const uKinkAmp = uniform(radius * 0.22); // a fraction of the sleeve's own radius, not an absolute metre figure
      const uColor = uniform(new THREE.Color(pal.top));
      // The group sits at line.origin (unlike fx-bolt, which keeps its group at the scene origin so its
      // shader can work purely in world space); cameraPosition below is world space, so this arc shader
      // has to add the group's own offset back in by hand to billboard correctly.
      const uOrigin = uniform(new THREE.Vector3(line.origin.x, line.origin.y, line.origin.z));

      const idx = attribute('aArc', 'float');
      const h1 = hash(idx.add(uSeed));
      const h2 = fract(h1.mul(53.17));
      const t = positionGeometry.x, edge = positionGeometry.y;
      const angle = idx.div(uArcCount.max(1)).mul(TAU).add(h1.sub(0.5).mul(0.7));
      const yLo = mix(float(0), uYMax.mul(0.7), h2);
      // Own-length kink frequency: cycles across THIS arc, not a constant copied from a multi-metre bolt.
      const arcLen = uArcLen.mul(mix(float(0.7), float(1.3), fract(h1.mul(29.3))));
      const y = yLo.add(t.mul(arcLen));
      const kinkCycles = arcLen.mul(o.arcKinksPerMetre);
      const kink = t.mul(kinkCycles).mul(TAU).add(h1.mul(41)).sin().mul(uKinkAmp);
      const r = uRadius.add(kink);
      const here = vec3(cos(angle).mul(r), y, sin(angle).mul(r));
      const toCam = normalize(cameraPosition.sub(here.add(uOrigin)));
      const up = vec3(0, 1, 0);
      const binormal = normalize(cross(up, toCam));
      const endTaper = t.mul(t.oneMinus()).mul(4).pow(0.6);
      arcMat.positionNode = here.add(binormal.mul(edge).mul(uWidth).mul(endTaper));

      const flicker = hash(floor(T.mul(30)).add(idx).add(uSeed));
      arcMat.colorNode = vec3(uColor).mul(2.2).mul(uBright);
      arcMat.opacityNode = endTaper.mul(mix(float(0.25), float(1), flicker)).mul(uGrown);

      const arcMesh = new THREE.Mesh(buildArcGeometry(THREE, o.arcSteps, arcCount), arcMat);
      arcMesh.frustumCulled = false; arcMesh.renderOrder = 3;
      group.add(arcMesh);
    }

    // ----- burst flash -----
    const burstFlash = pal.burst ? makeFlashSphere({ THREE, NODES, color: pal.top }) : null;
    if (burstFlash) { burstFlash.renderOrder = 5; group.add(burstFlash); }
    let burstAge = -1;

    // ----- motes: one deterministic burst, billboarded sprites so they never thin out edge-on -----
    const moteCount = Math.min(o.moteCap, Math.max(0, Math.round(o.motesBurst * (0.7 + 0.4 * power))));
    const motePool = createSpriteParticles({
      THREE, TSL, NODES, cap: Math.max(1, moteCount),
      colorA: pal.top, colorB: pal.mid, additive: true,
      gravity: -height * (pal.riseSign > 0 ? 0.55 : 0.15), drag: 0.9,
    });
    motePool.mesh.renderOrder = 4;
    group.add(motePool.mesh);
    for (let i = 0; i < moteCount; i++) {
      const a = rnd() * TAU;
      const rr = radius * (0.55 + 0.55 * rnd());
      const h0 = height * rnd() * 0.85 * (pal.riseSign > 0 ? 0.3 : 1);
      const speed = height * (0.7 + rnd() * 0.7) * pal.moteDir;
      const tang = pal.spiral * height * (0.4 + rnd() * 0.6);
      motePool.emit(
        Math.cos(a) * rr, h0, Math.sin(a) * rr,
        -Math.sin(a) * tang, speed, Math.cos(a) * tang,
        0.045 * (0.6 + rnd() * 0.9) * Math.max(1, radius / 0.35),
        0.45 + rnd() * 0.45,
      );
    }

    // ----- light spill -----
    const spill = [];
    for (let i = 0; i < o.lightCount; i++) {
      const light = lightPool.acquire();
      if (!light) break;
      const a = (i / o.lightCount) * TAU + rnd() * 0.5;
      light.distance = o.lightRange; light.intensity = 0;
      spill.push({ light, a, phase: rnd() * 20 });
    }
    const cLight = new THREE.Color(pal.light);

    // ----- phase machine -----
    let grown = 0, tVal = 0, hitPending = false, donePending = false;
    const machine = createPhaseMachine({
      travelTime: o.travelTime * pal.pace, impactTime: o.impactTime * pal.pace, fadeTime: o.fadeTime * pal.pace,
      easeIn: 0.03,
      onTravel() { grown = Math.max(grown, this.u); },
      onImpact() { hitPending = true; burstAge = burstFlash ? 0 : -1; },
      onFade(dt, t) { grown = Math.min(1 + o.unfurlWidth, grown + dt * (o.unfurlWidth / 0.12)); tVal = t; },
      onDestroy() { donePending = true; },
    });
    machine.spawn(line);

    function envelopeAtJs(t) {
      const growUp = saturate(t / 0.3);
      const fadeDown = saturate((t - 1.0) / 0.9);
      return growUp * (1 - fadeDown);
    }

    const inst = {
      group, machine, onImpact: null, onDone: null,
      update(dt, t = 0) {
        const alive = machine.update(dt, t);
        uGrown.value = grown;
        uT.value = tVal;
        motePool.step(dt);
        motePool.setFade(envelopeAtJs(tVal)); // same envelope the curtain's coverage uses, so both open and close together
        for (const s of spill) {
          const env = envelopeAtJs(tVal);
          const breathe = 0.75 + 0.25 * Math.sin(t * 1.1 * pal.flow + s.phase);
          s.light.color.copy(cLight);
          s.light.intensity = o.lightSpill * bright * env * breathe;
          s.light.position.set(
            group.position.x + Math.cos(s.a) * radius * 0.85,
            group.position.y + height * 0.4,
            group.position.z + Math.sin(s.a) * radius * 0.85,
          );
        }
        if (burstAge >= 0) {
          burstAge += dt;
          // burstFlash is a child of `group` (already sitting at line.origin), so this is a LOCAL offset —
          // unlike the lights above, which are top-level scene lights and need world coordinates.
          popFlash(burstFlash, 0, height * (pal.riseSign < 0 ? 0.25 : 0.98), 0, height * 0.4, burstAge, 0.28);
          if (burstAge > 0.28) burstAge = -1;
        }
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
        curtainGeo.dispose();
        hemMesh.geometry.dispose();
        motePool.dispose();
        for (const m of materials) m.dispose();
      },
    };
    return inst;
  }

  return {
    cast,
    dispose() {}, // arc geometries are cached module-wide, not per factory; nothing else is shared across casts
  };
}

export default createAuraFx;
