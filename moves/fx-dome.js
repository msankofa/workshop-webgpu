/**
 * fx-dome.js — a self-cast shield that closes overhead: Light Screen, Reflect, Safeguard, Aqua Ring,
 * Protect, King's Shield, Wide Guard, Magic Coat, Barrier. A held field effect that stands over the
 * caster until FADE lets it drop.
 *
 * Forked from fx-aurora.js's curtain, per two independent reviews of that module that landed on the
 * same fork: a sphere cap closing overhead instead of a ring standing on the ground. The fold, sway
 * and ripple terms, and the trick of reusing the fold phase for brightness so the glow rides the
 * cloth, carry over almost unchanged — what changes is the surface they perturb and the axis the
 * growth front sweeps.
 *
 *  1. GEOMETRY. The equator is `buildRing` from move-parts.js, at radius `options.radius`, so the hem
 *     ring here is built exactly the way aurora's hem is. Every row above it is a genuine point on a
 *     sphere: cut a sphere of radius `Rs` with the ground plane so the cutting circle has radius `R`
 *     (the equator) and the cap rises to apex height `H` (`options.height`) — `Rs` and the sphere's
 *     vertical offset `d` below the ground follow from R and H (`d = (R²/H − H)/2`, `Rs = (H + R²/H)/2`;
 *     `d = 0` is a plain hemisphere, `d > 0` flattens the cap, `d < 0` domes it past a hemisphere). A
 *     true sphere, not an ellipsoid, keeps the per-vertex normal exact (`(sinθ·cosφ, cosθ, sinθ·sinφ)`,
 *     already unit length), which is what the fresnel-weighted opacity below reads.
 *     The one liberty taken with the terrain: only the hem row samples `terrainHeight` per column, the
 *     same as aurora's ring. Rows above it use the idealised flat-ground sphere and then carry that
 *     column's terrain offset up as a constant vertical bias, rather than re-deriving the sphere per
 *     column. On a slope this means the apex is not quite one point (a hairline gap, not a crossed
 *     fan) — acceptable at shield scale, and the reason the apex is built as one vertex per column
 *     instead of a single shared vertex (see POLE below).
 *  2. GROWTH AXIS. Aurora's front swept around the closed ring (`u` = angle). A shield closing overhead
 *     has no natural start angle — it should seal shut on all sides at once and finish at the top. So
 *     `uGrown` here is compared against each vertex's colatitude fraction `aV` (0 at the hem, 1 at the
 *     apex) instead of its longitude `aU`: the shell rises from the ground and the last thing to close
 *     is the tip. The base position of every vertex, like aurora's curtain, is collapsed to its hem
 *     point; a per-vertex `aRise` vector (precomputed at cast time) carries it to its true sphere
 *     position, scaled by the same `unfurl`/`sink` shape aurora used for its vertical lift — just
 *     applied along a 3-vector instead of straight up.
 *  3. PERTURBATION AXIS. Aurora's billow and ripple pushed a curtain vertex out along the ring's radial
 *     direction (`aSide`). Here they push along that vertex's own analytic surface normal — stored in
 *     the geometry's standard `normal` attribute so the same values double as the fresnel term's input —
 *     per the fork's instruction, the same fold/sway/ripple sines just re-pointed to bulge and dimple the
 *     shell instead of billowing a flat sheet.
 *  4. POLE. Every longitude column shares the same row index at the apex, and because the geometry is
 *     built with the standard rows × cols grid (same index pattern as aurora's curtain), that row
 *     naturally collapses to a triangle fan once its radius hits zero — the same way THREE.SphereGeometry
 *     closes its own poles. Each column keeps its own apex vertex (not one shared vertex) so `aU`-driven
 *     shading (the fold phase, the lattice) stays continuous right up to the tip instead of tearing.
 *     What is NOT trusted to fall out naturally is the perturbation amplitude: `poleFade` is an explicit
 *     `smoothstep` that forces sway/ripple/lattice to exactly zero at `aV = 1`, because those terms vary
 *     per column (different phase, different crest jitter) and would otherwise displace each column's
 *     apex vertex by a different amount, reopening the seam the pole is supposed to close.
 *  5. SHELL COUNT. Aurora drew its curtain twice (front sheet + de-phased back sheet) because an open
 *     ribbon needs a second layer to read as cloth with depth. A closed dome shell already shows its own
 *     inside on the far side of the camera (`THREE.DoubleSide`), so this module draws one shell, not two.
 *  6. READABILITY FROM BOTH SIDES. An additive double-sided shell can wash out from inside where the
 *     camera in the demo does go. `opacityNode` is fresnel-weighted (`normalWorld` vs. the vector to
 *     `cameraPosition`, both confirmed exports of the shipped `three.tsl.js`) so grazing angles — the
 *     silhouette — stay bright while a face looked at head-on (including from inside, looking out through
 *     the near wall) goes closer to the palette's `fresnelMin` floor. `reflect` leans hardest on this: low
 *     `fresnelMin`, high `fresnelPower`, so the centre reads clear and the rim reads mirror-bright.
 *
 * Layers, all additive:
 *  - SHELL — the cap, single layer, DoubleSide. `colorNode` carries the hem/mid/top gradient (unchanged
 *    3-stop mix from aurora), the fold-phase brightness, the fresnel rim boost, and screen's lattice.
 *  - HEM GLOW — aurora's ground-hugging strip, unchanged, except its unfurl no longer depends on
 *    longitude: since the whole ring rises together now, the hem just fades in with `uGrown` as a
 *    scalar.
 *  - MOTES — optional, via `createSpriteParticles` (move-parts.js), not aurora's flat quads, which are a
 *    known weak point for thinning edge-on. Sampled inside the dome's volume and continuously recycled
 *    with `createRateEmitter` for as long as the shield stands.
 *  - LIGHT SPILL — up to `lightCount` (2 by default) pooled point lights, placed inside the shell rather
 *    than on it, breathing with the overall growth and with the hit pulse below.
 *
 * `protect` (and by extension King's Shield / Wide Guard / Magic Coat / Barrier) wants to flash where it
 * is struck. Nothing in the module's inputs carries a collision — `onImpact` fires once, when the cast
 * line's own travel completes, which for a self-cast zero-length line is immediately. So this exposes
 * `inst.registerHit(worldPoint)` for the harness to call later when it has real impact data: it pulses
 * the shell's brightness globally, and biases the pulse toward `worldPoint`'s side of the dome if given.
 * Nothing in this codebase calls it yet.
 *
 * The dome's group is parented to the scene at the caster's position at cast time (the same as aurora)
 * and never re-reads the caster's transform, so it will not follow a walking rig. That is a property of
 * the harness's `cast()` contract, not a bug in this module — noted, not worked around.
 */

import { createPhaseMachine, createRateEmitter, mulberry32, saturate } from './move-core.js';
import { buildRing, createSpriteParticles } from './move-parts.js';

const TAU = Math.PI * 2;

// Integer wave counts around the ring — an integer harmonic is what keeps the closed seam invisible.
const FOLD_FREQ = 5;
const SWAY_FREQ = 9;
const RIPPLE_FREQ = 18;

export const PALETTES = {
  // Light Screen — warm, panelled, mostly see-through.
  screen: {
    hem: 0xd99a1a, mid: 0xffd54a, top: 0xfff6c2,
    lattice: 1, alpha: 0.55, fresnelPower: 2.0, fresnelMin: 0.4, rotateSpeed: 0, snap: false,
  },
  // Reflect — cool, mirror-like: strong rim, clear centre.
  reflect: {
    hem: 0x1f5f9e, mid: 0x69b9ff, top: 0xe8f7ff,
    lattice: 0, alpha: 0.62, fresnelPower: 3.4, fresnelMin: 0.06, rotateSpeed: 0, snap: false,
  },
  // Safeguard / Aqua Ring — soft, gentle, slowly turning.
  safeguard: {
    hem: 0x8fe9c4, mid: 0xd8fff0, top: 0xffffff,
    lattice: 0, alpha: 0.4, fresnelPower: 1.3, fresnelMin: 0.55, rotateSpeed: 0.15, snap: false,
  },
  // Protect / King's Shield / Wide Guard / Magic Coat / Barrier — hard cyan, snaps shut fast.
  protect: {
    hem: 0x00b8d9, mid: 0x4de8ff, top: 0xdafcff,
    lattice: 0, alpha: 0.82, fresnelPower: 2.6, fresnelMin: 0.25, rotateSpeed: 0, snap: true,
  },
};

const DEFAULTS = {
  radius: 1.15,          // equator radius in metres, before power scaling
  height: 1.35,           // apex height; > radius domes past a hemisphere, < radius flattens it
  wave: 0.5,              // billow amplitude
  flow: 1,                // animation speed
  brightness: 1,
  segments: 72,            // longitude columns
  latSegs: 10,             // colatitude rows above the hem
  hemWidth: 0.32,
  unfurlWidth: 0.14,       // how much colatitude the growth front feathers over
  poleFadeWidth: 0.08,     // how much colatitude, at the very tip, the perturbation is faded out over
  latticeU: 9,             // screen's panel lattice, longitude divisions
  latticeV: 5,             // screen's panel lattice, colatitude divisions
  latticeWidth: 0.07,      // fraction of a panel cell the lattice line occupies
  motes: 60,
  maxMotes: 140,
  moteRate: 16,            // motes/second respawned once the shell is sealed
  moteLife: [1.6, 2.9],
  moteDrift: 0.14,
  moteSize: [0.018, 0.045],
  lightSpill: 1.0,
  lightCount: 2,
  lightRange: 6,
  travelTime: 0.32,
  impactTime: 2.4,
  fadeTime: 0.85,
  hitPulseTime: 0.35,
};

/** Hem-hugging ring point set, identical role to aurora's `buildRing` call — kept local per the brief. */
function ring(o, ox, oy, oz, radius, terrainHeight) {
  return buildRing({ segments: o.segments, radius, ox, oy, oz, terrainHeight });
}

/**
 * The cap. Every vertex's base position is its column's hem point (collapsed, like aurora's curtain);
 * `aRise` carries it out to its true position on the sphere cut by (R, H). `aNormal` is that sphere's
 * exact outward unit normal at the vertex's *final* position — used both for the billow/ripple push and
 * for the fresnel term, since the animation only perturbs a few centimetres off a geometry whose analytic
 * normal is otherwise exact.
 */
function buildDomeGeometry(THREE, pts, rows, jitPhase, Rs, d, theta0) {
  const cols = pts.length;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const rise = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const us = new Float32Array(n);
  const vs = new Float32Array(n);
  const jits = new Float32Array(n);
  const idx = [];
  for (let i = 0; i < cols; i++) {
    const p = pts[i];
    const a = p.u * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    const jit = 1
      + 0.15 * Math.sin(a * 2 + jitPhase[0])
      + 0.1 * Math.sin(a * 3 + jitPhase[1])
      + 0.06 * Math.sin(a * 5 + jitPhase[2]);
    for (let r = 0; r < rows; r++) {
      const vi = i * rows + r;
      const v = r / (rows - 1);
      const theta = theta0 * (1 - v);
      const sinT = Math.sin(theta), cosT = Math.cos(theta);
      const idealX = Rs * sinT * ca, idealZ = Rs * sinT * sa, idealY = Rs * cosT - d;
      pos[vi * 3] = p.x; pos[vi * 3 + 1] = p.y; pos[vi * 3 + 2] = p.z;
      rise[vi * 3] = idealX - p.x; rise[vi * 3 + 1] = idealY; rise[vi * 3 + 2] = idealZ - p.z;
      nrm[vi * 3] = sinT * ca; nrm[vi * 3 + 1] = cosT; nrm[vi * 3 + 2] = sinT * sa;
      us[vi] = p.u; vs[vi] = v; jits[vi] = jit;
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
  // 'normal' is standard so the built-in normalWorld TSL node reads it too (see the fresnel term below);
  // it stays the static, undisplaced analytic value — good enough since the animation only perturbs a
  // few centimetres off it — so aRise's own perturbation direction reads the same attribute.
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aRise', new THREE.BufferAttribute(rise, 3));
  geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geo.setAttribute('aV', new THREE.BufferAttribute(vs, 1));
  geo.setAttribute('aColJit', new THREE.BufferAttribute(jits, 1));
  geo.setIndex(idx);
  return geo;
}

/** Ground-hugging glow strip at the hem — unchanged from aurora's, ported locally per the module brief. */
function buildHemGeometry(THREE, pts) {
  const cols = pts.length;
  const pos = new Float32Array(cols * 2 * 3);
  const side = new Float32Array(cols * 2 * 3);
  const across = new Float32Array(cols * 2);
  const us = new Float32Array(cols * 2);
  const idx = [];
  for (let i = 0; i < cols; i++) {
    const p = pts[i];
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

export function createDomeFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene } = deps;
  const terrainHeight = deps.terrainHeight || (() => 0);
  const lightPool = deps.lights || { acquire: () => null, release: () => {} };
  const o = { ...DEFAULTS, ...options };

  const {
    abs, attribute, cos, dot, float, fract, max, min, mix, normalize, oneMinus, positionLocal,
    pow, smoothstep, time, uniform, vec3, cameraPosition, positionWorld, normalWorld,
  } = TSL;

  function cast({ line, seed = 1, palette = 'protect', power = 1 }) {
    const rnd = mulberry32(seed >>> 0);
    const pal = PALETTES[palette] || PALETTES.protect;
    const s = Math.pow(Math.max(power, 0.05), 0.32); // one scale factor for both R and H, so their ratio (and theta0) never distorts with power
    const R = o.radius * s;
    const H = Math.max(0.05, o.height * s);
    const d = (R * R / H - H) / 2;
    const Rs = (H + R * R / H) / 2;
    const theta0 = Math.atan2(R, d);
    const bright = o.brightness * (0.75 + 0.25 * power);
    const unfurlWidth = pal.snap ? o.unfurlWidth * 0.45 : o.unfurlWidth;
    const moteCount = Math.min(o.maxMotes, Math.max(0, Math.round(o.motes * (0.7 + 0.3 * power))));

    const group = new THREE.Group();
    group.position.set(line.origin.x, line.origin.y, line.origin.z);
    scene.add(group);

    const pts = ring(o, line.origin.x, line.origin.y, line.origin.z, R, terrainHeight);
    const rows = o.latSegs + 1;
    const jitPhase = [rnd() * TAU, rnd() * TAU, rnd() * TAU];

    // ----- uniforms -----
    const uGrown = uniform(0);      // growth front, now read against colatitude aV instead of ring angle aU
    const uFade = uniform(0);
    const uWave = uniform(o.wave);
    const uFlow = uniform(o.flow);
    const uBright = uniform(bright);
    const uHemW = uniform(o.hemWidth);
    const uHem = uniform(new THREE.Color(pal.hem));
    const uMid = uniform(new THREE.Color(pal.mid));
    const uTop = uniform(new THREE.Color(pal.top));
    const uAlpha = uniform(pal.alpha);
    const uFresPow = uniform(pal.fresnelPower);
    const uFresMin = uniform(pal.fresnelMin);
    const uLattice = uniform(pal.lattice ? 1 : 0);
    const uHitPulse = uniform(0);
    const uHitDir = uniform(new THREE.Vector3(0, 1, 0));
    const uHitLocal = uniform(0);

    const materials = [];
    const T = time.mul(uFlow);

    // ----- shell -----
    const domeMat = new NODES.MeshBasicNodeMaterial();
    domeMat.transparent = true; domeMat.depthWrite = false;
    domeMat.side = THREE.DoubleSide; domeMat.blending = THREE.AdditiveBlending;
    materials.push(domeMat);
    {
      const aRise = vec3(attribute('aRise', 'vec3'));
      const aNormal = vec3(attribute('normal', 'vec3')); // the analytic sphere normal, doubling as the standard attribute
      const aU = float(attribute('aU', 'float'));
      const aV = float(attribute('aV', 'float'));
      const aJit = float(attribute('aColJit', 'float'));
      const ang = aU.mul(TAU);

      const sink = uFade.mul(0.72).oneMinus(); // shrink the rise back toward the hem as the shield fades
      const unfurl = smoothstep(0, unfurlWidth, uGrown.sub(aV));
      const risen = positionLocal.add(aRise.mul(unfurl).mul(sink));

      // Forced to exactly zero at aV = 1 (see POLE in the header) so every column's apex vertex still coincides.
      const poleFade = smoothstep(1, 1 - o.poleFadeWidth, aV);

      const breath = T.mul(0.23).sin().mul(0.2).add(0.8);
      const jitScale = float(1).add(aJit.sub(1).mul(0.6));
      const amp = uWave.mul(0.22).mul(aV.pow(1.2)).mul(unfurl).mul(breath).mul(poleFade).mul(jitScale);
      const foldPhase = ang.mul(FOLD_FREQ).add(T.mul(1.1));
      const sway = foldPhase.sin()
        .add(ang.mul(SWAY_FREQ).sub(T.mul(0.7)).add(aV.mul(1.6)).sin().mul(0.5));
      const ripple = ang.mul(RIPPLE_FREQ).add(T.mul(1.7)).add(aV.mul(3)).sin()
        .mul(0.018).mul(aV).mul(poleFade);

      domeMat.positionNode = risen.add(aNormal.mul(amp.mul(sway).add(ripple)));

      // Fold brightness shares foldPhase with the vertex sway, so the glow rides the same moving folds.
      const folds = abs(cos(foldPhase)).pow(1.6).mul(0.8).add(0.45);

      const viewDir = normalize(cameraPosition.sub(positionWorld));
      const NdotV = abs(dot(normalize(normalWorld), viewDir));
      const fres = pow(oneMinus(NdotV), uFresPow);
      const fresMix = mix(uFresMin, float(1), fres);
      const rimBoost = fres.mul(0.7).add(1);

      const cellU = fract(aU.mul(o.latticeU));
      const cellV = fract(aV.mul(o.latticeV));
      const distU = min(cellU, oneMinus(cellU));
      const distV = min(cellV, oneMinus(cellV));
      // Ascending edges throughout, per aurora's own convention — inverted afterward with oneMinus rather than
      // passed to smoothstep reversed, since WGSL only guarantees smoothstep's result when edge0 < edge1.
      const lineU = smoothstep(0, o.latticeWidth, distU).oneMinus();
      const lineV = smoothstep(0, o.latticeWidth, distV).oneMinus();
      const latticeMask = max(lineU, lineV).mul(poleFade);
      const panelMul = mix(float(1), mix(0.18, 1, latticeMask), uLattice);

      const hitAlign = dot(aNormal, vec3(uHitDir)).mul(0.5).add(0.5);
      const hitMask = mix(float(1), smoothstep(0.25, 1, hitAlign), uHitLocal);
      const hitGlow = hitMask.mul(uHitPulse);

      let grad = mix(vec3(uHem), vec3(uMid), smoothstep(0, 0.55, aV));
      grad = mix(grad, vec3(uTop), smoothstep(0.55, 1, aV));
      const latColor = mix(grad, vec3(uTop), latticeMask.mul(uLattice).mul(0.6));
      const col = latColor.mul(folds).mul(rimBoost).mul(uBright);
      domeMat.colorNode = col.mul(hitGlow.mul(1.4).add(1)).add(vec3(1, 1, 1).mul(hitGlow.mul(0.35)));

      const thin = uFade.oneMinus().pow(1.3);
      domeMat.opacityNode = unfurl.mul(fresMix).mul(panelMul).mul(thin).mul(uAlpha).add(hitGlow.mul(0.4));
    }
    const domeMesh = new THREE.Mesh(buildDomeGeometry(THREE, pts, rows, jitPhase, Rs, d, theta0), domeMat);
    domeMesh.renderOrder = 2; domeMesh.frustumCulled = false;
    group.add(domeMesh);

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
      // The ring rises as a whole now (growth sweeps up, not around), so the hem's own unfurl is a scalar.
      const unfurl = smoothstep(0, unfurlWidth * 2, uGrown);
      const falloff = oneMinus(abs(aAcross)).max(0).pow(1.5);
      const shimmer = aU.mul(TAU * FOLD_FREQ).add(T.mul(1.1)).cos().mul(0.2).add(0.8);
      hemMat.colorNode = mix(vec3(uHem), vec3(uMid), 0.35).mul(falloff).mul(shimmer).mul(uBright).mul(0.5);
      hemMat.opacityNode = unfurl.mul(uFade.oneMinus());
    }
    const hemMesh = new THREE.Mesh(buildHemGeometry(THREE, pts), hemMat);
    hemMesh.renderOrder = 1; hemMesh.frustumCulled = false;
    group.add(hemMesh);

    // ----- motes: sprite kit, not flat quads, so they don't thin edge-on -----
    const sprite = createSpriteParticles({
      THREE, TSL, NODES, cap: Math.max(moteCount, 1),
      colorA: pal.top, colorB: pal.hem, gravity: 0, drag: 0.35, additive: true,
    });
    sprite.mesh.renderOrder = 3; sprite.mesh.frustumCulled = false;
    group.add(sprite.mesh);
    const moteEmitter = createRateEmitter(48);

    // ----- light spill: inside the shell, not on it -----
    const spill = [];
    for (let i = 0; i < o.lightCount; i++) {
      const light = lightPool.acquire();
      if (!light) break;
      const u = i / Math.max(1, o.lightCount);
      spill.push({ light, a: u * TAU + rnd() * 0.6, v: 0.45 + rnd() * 0.25, phase: rnd() * 20, warm: i % 2 === 1 });
      light.distance = o.lightRange;
      light.intensity = 0;
    }
    const cHem = new THREE.Color(pal.hem);
    const cTop = new THREE.Color(pal.top);

    // ----- phase machine -----
    let grown = 0, fade = 0, hitPending = false, donePending = false, hitTimer = 0;
    const machine = createPhaseMachine({
      travelTime: o.travelTime, impactTime: o.impactTime, fadeTime: o.fadeTime, easeIn: 0.04,
      onTravel() { grown = Math.max(grown, this.u); },
      onImpact() { hitPending = true; },
      onFade(dt, t) {
        // Same tail the ring-sweep version needed: the front has to clear the last column's unfurl width.
        grown = Math.min(1 + unfurlWidth, grown + dt * (unfurlWidth / 0.12));
        fade = t > 1 ? saturate(t - 1) : 0;
      },
      onDestroy() { donePending = true; },
    });
    machine.spawn(line);

    function updateMotes(dt, t) {
      if (moteCount > 0) {
        const sealed = grown >= 1 && fade < 0.98 && machine.alive;
        if (sealed) {
          const n = moteEmitter.take(o.moteRate, dt);
          for (let k = 0; k < n; k++) {
            const a = rnd() * TAU, v = rnd();
            const theta = theta0 * (1 - v);
            const sinT = Math.sin(theta), cosT = Math.cos(theta);
            const sx = Rs * sinT * Math.cos(a), sz = Rs * sinT * Math.sin(a), sy = Rs * cosT - d;
            const rr = Math.cbrt(rnd()) * 0.85; // pull inward toward the sphere's own centre (-d), roughly volume-uniform
            const px = sx * rr, py = -d * (1 - rr) + sy * rr, pz = sz * rr;
            const drift = o.moteDrift;
            const vx = (rnd() - 0.5) * drift, vy = (rnd() - 0.3) * drift * 0.6, vz = (rnd() - 0.5) * drift;
            const size = o.moteSize[0] + rnd() * (o.moteSize[1] - o.moteSize[0]);
            const life = o.moteLife[0] + rnd() * (o.moteLife[1] - o.moteLife[0]);
            sprite.emit(px, py, pz, vx, vy, vz, size, life);
          }
        }
      }
      sprite.step(dt);
      sprite.setFade(1 - fade);
    }

    function updateLights(t) {
      for (let i = 0; i < spill.length; i++) {
        const s = spill[i];
        const theta = theta0 * (1 - s.v);
        const sinT = Math.sin(theta), cosT = Math.cos(theta);
        const rr = 0.55; // pulled inward from the shell surface, toward the sphere's own centre
        const sx = Rs * sinT * Math.cos(s.a), sz = Rs * sinT * Math.sin(s.a), sy = Rs * cosT - d;
        s.light.position.set(
          line.origin.x + sx * rr,
          line.origin.y - d * (1 - rr) + sy * rr,
          line.origin.z + sz * rr,
        );
        const ignite = saturate((grown - 0.15) / 0.5);
        const breathe = 0.72 + 0.28 * Math.sin(t * 0.9 * o.flow + s.phase);
        s.light.color.copy(s.warm ? cTop : cHem);
        s.light.intensity = o.lightSpill * bright * ignite * breathe * (1 - fade) * (1 + hitTimer * 2);
      }
    }

    const inst = {
      group,
      machine,
      onImpact: null,
      onDone: null,
      /** Not called by anything yet (no collision data reaches this module) — see the header. */
      registerHit(worldPoint) {
        hitTimer = o.hitPulseTime;
        if (worldPoint) {
          const lx = worldPoint.x - group.position.x, ly = worldPoint.y - group.position.y, lz = worldPoint.z - group.position.z;
          const len = Math.hypot(lx, ly, lz) || 1;
          uHitDir.value.set(lx / len, ly / len, lz / len);
          uHitLocal.value = 1;
        } else {
          uHitLocal.value = 0;
        }
      },
      update(dt, t = 0) {
        const alive = machine.update(dt, t);
        uGrown.value = grown;
        uFade.value = fade;
        if (hitTimer > 0) hitTimer = Math.max(0, hitTimer - dt);
        uHitPulse.value = hitTimer / o.hitPulseTime;
        if (pal.rotateSpeed) group.rotation.y += dt * pal.rotateSpeed;
        updateMotes(dt, t);
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
        domeMesh.geometry.dispose();
        hemMesh.geometry.dispose();
        sprite.dispose();
        for (const m of materials) m.dispose();
      },
    };
    return inst;
  }

  return { cast, dispose() {} };
}
