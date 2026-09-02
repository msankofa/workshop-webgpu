// effect-renderer.js — draws the serialized 'effect' entities produced by
// entity-types/effect.js: bullet tracers, impact sparks, muzzle flashes, and layered
// explosions. This is a faithful port of html-game-v2's explosion look (fireball flash,
// shockwave ring, ember burst, hot shrapnel, lingering smoke) into this renderer's
// replication model: instead of spawning hundreds of stateful particles, every sub-particle
// is regenerated each frame *deterministically* from the single wire object + a hashed id +
// wall-clock age. Host and guest therefore render an identical blast from one tiny snapshot.
//
// Three draw systems:
//   - Additive lines + points (pooled buffers) for tracers, sparks, shockwave rings, ember
//     dots, hot shrapnel streaks, and blood_spray droplets.
//   - Two INSTANCED soft-billboard pools (one additive glow, one normal-blend smoke) for the
//     volumetric fireball flash and the dark, lingering smoke — the layers that need per-puff
//     colour, opacity and scale that pooled Points can't express under the WebGPU backend.
//     Each pool is ONE draw call: a unit quad in an InstancedBufferGeometry, billboarded by
//     SpriteNodeMaterial, with per-instance world position / size / rgb / alpha as instanced
//     attributes. See the makePool comment for why instanceMatrix is not used.
//   - A third INSTANCED pool of oriented DECAL QUADS for blood_stain and blood_splatter — a
//     billboard sprite can't stay stuck to a surface normal, so these carry a per-instance frame
//     rather than facing the camera. blood_stain sits at the hit point, oriented to the hit normal;
//     blood_splatter sits on the GROUND, flat, at each droplet's resolved landing point (see
//     drawBloodSplatter). Unlike the sprite pools this one CAN express orientation, because a
//     plain MeshBasicNodeMaterial builds its vertex from positionLocal — see makeDecalPool.
//
// Wire shapes drawn here (see entity-types/effect.js for the authoritative list):
//   { id, type:'effect', kind:'gun_tracer',   p, p1, color, life, tracerFx }
//   { id, type:'effect', kind:'hit_spark',    p, normal, color, surface, life }
//   { id, type:'effect', kind:'muzzle_flash', p, dir, color, life, muzzleFx }
//   { id, type:'effect', kind:'explosion',    p, color, radius, life }
//   { id, type:'effect', kind:'smoke_puff',   p, color, life, size, growth, rise, drift, opacity }
//   { id, type:'effect', kind:'blood_spray',    p, normal, color, life, count, spread, speed, gravity, size }
//   { id, type:'effect', kind:'blood_stain',    p, normal, color, life, size, opacity }
//   { id, type:'effect', kind:'blood_splatter', p, normal, color, life, count, spread, speed, gravity, size, opacity }
//   (no recognised kind) { id, type:'effect', p, p1, color, life } -> generic additive streak
//
// sync(list, nowMs): `list` is serialized effect wire objects; call every render frame.

import { SpriteNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, materialColor, positionGeometry, texture, uniform, length, mix, smoothstep, float } from 'three/tsl';
import { tracerSegmentAt } from './tracer-visual.js';
import { WOUND_DEFAULTS } from './wound-mask.js';

const SPARK_RAYS = 6;
const GLOW_POOL = 220;   // additive fireball / muzzle-flash sprites live at once (cap)
const SMOKE_POOL = 260;  // normal-blend smoke sprites live at once (cap)

// Small deterministic hash → [0,1) so per-particle scatter is stable per entity id.
function hash01(str, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// A radial white→transparent puff texture, shared by every sprite (tinted per-puff via
// material.color). Generated once on the CPU; works on the WebGPU backend as a CanvasTexture.
function makeSoftTexture(THREE) {
  const S = 64;
  const cv = (typeof document !== 'undefined')
    ? document.createElement('canvas') : new OffscreenCanvas(S, S);
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// An irregular white→transparent mask for blood decals: a big off-centre core lobe, a ring of
// smaller lobes fused into it, and a scatter of detached droplets. Sampled for alpha only.
//
// The decal pool used to share makeSoftTexture's radial ramp, which is perfectly rotationally
// symmetric — so the per-decal `spin` drawBloodStain has always computed was a visual no-op, and
// every stain rendered as the same soft circle. Breaking the symmetry is what makes that existing
// variety mechanism do anything, and it is the difference between a red dot and a splat.
//
// Seeded, not Math.random: host and guest each generate this locally, and a divergent mask would
// mean the same wire object rendering differently on the two machines.
export function makeStainTexture(THREE) {
  const S = 128;
  const cv = (typeof document !== 'undefined')
    ? document.createElement('canvas') : new OffscreenCanvas(S, S);
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  let seed = 0x9e3779b9;
  const rnd = () => (((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296));
  // Feathered white blob at (cx,cy) in [0,1] canvas units with radius `r`, hard to ~60% then out.
  const lobe = (cx, cy, r) => {
    const x = cx * S, y = cy * S, rad = Math.max(1, r * S);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  };
  lobe(0.5, 0.5, 0.30);
  for (let i = 0; i < 7; i++) {            // fused lobes: break the circle into a lumpy outline
    const a = (i / 7 + rnd() * 0.14) * Math.PI * 2;
    const d = 0.10 + rnd() * 0.16;
    lobe(0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d, 0.09 + rnd() * 0.11);
  }
  for (let i = 0; i < 12; i++) {           // detached droplets, kept inside the quad's ±0.5
    const a = rnd() * Math.PI * 2;
    const d = 0.28 + rnd() * 0.16;
    lobe(0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d, 0.015 + rnd() * 0.035);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * How hard a hit bleeds, from the victim's health AFTER the hit. 0 = untouched, 1 = dying.
 *
 * Pure and exported so it is Node-testable and so the harness and the game cannot drift apart. It
 * returns tuning for the effect kinds that already exist rather than introducing a "drip" kind: at
 * the healthy end a low count of slow, tightly-grouped droplets already reads as a trickle under
 * blood_spray's existing gravity-arced renderer, and no splatter reaches the ground at all.
 *
 * The values at hp01 = 0 are exactly today's hardcoded constants, so a badly wounded bot looks
 * unchanged. The whole change is additive at the healthy end — this is a regression guard, and the
 * test asserts it.
 */
export function bloodIntensityForHealth(hp01) {
  const hp = Number.isFinite(hp01) ? Math.max(0, Math.min(1, hp01)) : 0;
  const t = 1 - hp;   // 0 = healthy, 1 = dying
  const lerp = (a, b) => a + (b - a) * t;
  return {
    sprayCount: Math.round(lerp(3, 28)),
    spraySpeed: lerp(1.0, 4.2),
    spraySpread: lerp(0.25, 1.0),
    splatterCount: Math.round(lerp(0, 10)),
    splatterOpacity: lerp(0.5, 0.8),
  };
}

// maxBloodDecals caps blood_stain + blood_splatter COMBINED. It is one instanced draw, so the cap
// costs ~13 floats per slot and nothing per frame — size it for the worst case, not the average.
export function createEffectRenderer({
  THREE, scene, terrainHeight = null, resolveAttachment = null,
  maxSegments = 3072, maxPoints = 1024, maxBloodDecals = 512,
}) {
  // Real ground height under a point (injected). Explosions use this instead of assuming the
  // blast Y is the ground — a rocket can detonate on a trunk, a wall, a creature, or mid-air.
  const groundAt = (x, z, fallback) => (typeof terrainHeight === 'function' ? terrainHeight(x, z) : fallback);
  // Live world matrix for a blood_stain's `attach` handle, or null. Injected the same way and for
  // the same reason as terrainHeight: the renderer stays stateless — it holds no reference to a bot,
  // recomputes the transform every frame, and a guest resolves against its OWN rig from the same
  // wire object. See bot-body-hit.js's resolveAttachmentMatrix for the other half.
  const attachAt = (ownerId, attach) =>
    (typeof resolveAttachment === 'function' ? resolveAttachment(ownerId, attach) : null);
  const _atP = new THREE.Vector3(), _atN = new THREE.Vector3(), _atM = new THREE.Matrix3();
  // ---- additive lines (tracers, sparks, shockwave rings, shrapnel streaks) ----
  const segPos = new Float32Array(maxSegments * 2 * 3);
  const segCol = new Float32Array(maxSegments * 2 * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(segPos, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(segCol, 3));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.name = 'fx-lines';
  lines.frustumCulled = false;
  scene.add(lines);

  // ---- additive points (muzzle glow origins, ember dots, ray tips) ----
  const ptPos = new Float32Array(maxPoints * 3);
  const ptCol = new Float32Array(maxPoints * 3);
  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute('position', new THREE.BufferAttribute(ptPos, 3));
  ptGeo.setAttribute('color', new THREE.BufferAttribute(ptCol, 3));
  const ptMat = new THREE.PointsMaterial({
    size: 0.35, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(ptGeo, ptMat);
  points.name = 'fx-points';
  points.frustumCulled = false;
  scene.add(points);

  // ---- soft-billboard instanced pools (fireball glow + smoke) ----
  const softTex = makeSoftTexture(THREE);
  const stainTex = makeStainTexture(THREE);   // decals only; the sprite pools stay radial
  // Unit quad matching THREE.Sprite's own geometry (corners ±0.5, index 0,1,2/0,2,3). Each pool
  // owns a copy so disposing one never frees the other's buffers.
  // SpriteNodeMaterial reads positionGeometry.xy for the billboard corner offset.
  const QUAD_POS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
  const QUAD_UV = [0, 0, 1, 0, 1, 1, 0, 1];
  const QUAD_INDEX = [0, 1, 2, 0, 2, 3];
  // NOTE: instanceMatrix/instanceColor are deliberately NOT used. SpriteNodeMaterial builds its
  // vertex position from `positionNode` + `positionGeometry`, never from `positionLocal`, so an
  // InstancedMesh's instanceMatrix has no effect on where a sprite lands (three r0.184,
  // SpriteNodeMaterial.setupPositionView). Per-instance data therefore rides on plain instanced
  // attributes wired into positionNode/scaleNode/colorNode/opacityNode.
  const makePool = (cap, blending) => {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(QUAD_POS), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UV), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(QUAD_INDEX), 1));
    const pos = new Float32Array(cap * 3);
    const col = new Float32Array(cap * 3);
    const size = new Float32Array(cap);
    const alpha = new Float32Array(cap);
    const inst = (arr, n) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('instPos', inst(pos, 3));
    geo.setAttribute('instColor', inst(col, 3));
    geo.setAttribute('instSize', inst(size, 1));
    geo.setAttribute('instAlpha', inst(alpha, 1));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    const mat = new SpriteNodeMaterial({ map: softTex, transparent: true, depthWrite: false, blending });
    mat.fog = blending === THREE.NormalBlending; // smoke reads atmosphere; additive glow stays bright
    mat.positionNode = attribute('instPos', 'vec3');   // billboard centre, world space
    mat.scaleNode = attribute('instSize', 'float');    // float broadcasts to vec2(size, size)
    mat.colorNode = attribute('instColor', 'vec3').mul(materialColor); // materialColor carries the soft map
    mat.opacityNode = attribute('instAlpha', 'float');
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx-sprite-pool';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    scene.add(mesh);
    return { cap, geo, mat, mesh, pos, col, size, alpha, wPos: pos, wCol: col, wSize: size, wAlpha: alpha };
  };
  const glow = makePool(GLOW_POOL, THREE.AdditiveBlending);
  const smoke = makePool(SMOKE_POOL, THREE.NormalBlending);
  glow.mesh.renderOrder = 0;
  smoke.mesh.renderOrder = 1; // deterministic: smoke composites over the additive flash
  // Smoke is normal-blended, so its instance order IS its blend order. It writes to staging
  // buffers and is gathered back-to-front at the end of sync(); the camera comes from the
  // previous frame's draw, which is exactly one frame stale and visually indistinguishable.
  smoke.wPos = new Float32Array(SMOKE_POOL * 3);
  smoke.wCol = new Float32Array(SMOKE_POOL * 3);
  smoke.wSize = new Float32Array(SMOKE_POOL);
  smoke.wAlpha = new Float32Array(SMOKE_POOL);
  const smokeOrder = new Int32Array(SMOKE_POOL);
  const smokeKey = new Float32Array(SMOKE_POOL);
  let lastCamera = null;
  smoke.mesh.onBeforeRender = (_r, _s, camera) => { lastCamera = camera; };

  // ---- blood decal pool (oriented quads, not billboards) — shared by blood_stain (on the hit
  // surface) and blood_splatter (on the ground) ----
  // A Sprite is always camera-facing, so a decal that has to sit flush against an arbitrary normal
  // can't be one. It used to be maxBloodDecals separate Meshes, each with its own MeshBasicMaterial
  // and side:DoubleSide with no forceSinglePass — a saturated pool encoded up to 2x that many
  // transparent draws. It is now ONE instanced draw like glow and smoke.
  //
  // The reason instancing works here and NOT for the sprite pools: MeshBasicNodeMaterial builds its
  // vertex from positionLocal, which `positionNode` replaces, so per-instance geometry is
  // expressible. Rather than a mat4 per decal, each instance carries its two in-plane axes already
  // scaled by size (instTan/instBit); the quad corner is centre + geomX*tan + geomY*bit. That is 6
  // floats instead of 16 and no matrix multiply. The mesh matrix stays identity, so those axes and
  // the centre are world space — same convention the sprite pools use.
  // Live uniforms, not baked constants, so the harness can tune the wound without a material rebuild
  // — the same treatment every other tunable in this file's pools gets. Declared outside
  // makeDecalPool so a pool rebuilt by setBloodDecalCap keeps whatever the sliders were set to.
  const woundInner = uniform(WOUND_DEFAULTS.inner);
  const woundOuter = uniform(WOUND_DEFAULTS.outer);
  const woundDarken = uniform(WOUND_DEFAULTS.darken);
  const makeDecalPool = (cap) => {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(QUAD_POS), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UV), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(QUAD_INDEX), 1));
    const pos = new Float32Array(cap * 3);
    const tan = new Float32Array(cap * 3);
    const bit = new Float32Array(cap * 3);
    const col = new Float32Array(cap * 3);
    const alpha = new Float32Array(cap);
    const wound = new Float32Array(cap);
    const inst = (arr, n) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('instPos', inst(pos, 3));
    geo.setAttribute('instTan', inst(tan, 3));
    geo.setAttribute('instBit', inst(bit, 3));
    geo.setAttribute('instColor', inst(col, 3));
    geo.setAttribute('instAlpha', inst(alpha, 1));
    geo.setAttribute('instWound', inst(wound, 1));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    // forceSinglePass is the point of DoubleSide here: a decal on a curved surface can present its
    // back face, but rendering the pool twice to get that is the defect this rewrite removes.
    const mat = new MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      side: THREE.DoubleSide, forceSinglePass: true,
    });
    mat.positionNode = attribute('instPos', 'vec3')
      .add(attribute('instTan', 'vec3').mul(positionGeometry.x))
      .add(attribute('instBit', 'vec3').mul(positionGeometry.y));
    // Wound centre: darken the middle so a stain reads as a puncture with blood radiating from it
    // rather than a flat red smear. Driven by the quad's own geometry (+/-0.5), not by the mask's
    // alpha — see wound-mask.js for why alpha is the wrong signal. The core darkens whatever colour
    // the instance already carries instead of forcing a blood shade, so blood_splatter shares this
    // for free and a future non-blood decal on the same pool is not broken by it.
    const base = attribute('instColor', 'vec3');
    const core = float(1).sub(smoothstep(woundInner, woundOuter, length(positionGeometry.xy)))
      .mul(attribute('instWound', 'float'));   // 0 on ground splatter: a droplet has no puncture
    mat.colorNode = mix(base, base.mul(woundDarken), core);
    // Sampled for its ALPHA only — that ramp is what gives the decal a feathered edge instead of a
    // hard square. Its rgb is white and carries no colour. Decals use the irregular mask rather than
    // the sprite pools' radial one; see makeStainTexture.
    mat.opacityNode = attribute('instAlpha', 'float').mul(texture(stainTex).a);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx-decal-pool';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    mesh.renderOrder = -1; // decals are stuck to surfaces; glow and smoke composite over them
    scene.add(mesh);
    return { cap, geo, mat, mesh, pos, tan, bit, col, alpha, wound };
  };
  // `let`, not `const`: setBloodDecalCap rebuilds it. Every reader below goes through this binding
  // (pushBlood reads bloodPool.cap/.pos at call time, uploadDecals is passed it per frame), so a
  // rebuild is picked up without rewiring anything.
  let bloodPool = makeDecalPool(maxBloodDecals);

  const firstSeen = new Map(); // id -> nowMs first observed
  // Fade state is swept by age, not by diffing against the live list: a per-frame Set of every
  // id (plus a full-map rescan whenever one expired) is a real cost once trails push hundreds of
  // effects per frame. Safe because no effect outlives SEEN_TTL_MS — one still being drawn has
  // age < life, so it can never be swept out from under itself.
  const SEEN_TTL_MS = 30000;
  const SEEN_SWEEP_MS = 5000;
  let sweepAt = 0;

  let segCount = 0, ptCount = 0, glowCount = 0, smokeCount = 0, bloodCount = 0;
  // Decals wanted but not drawn because the pool was full, this frame and at its worst since the
  // last reset. 512 was picked without measurement; these are what make it measurable.
  let bloodDropped = 0, bloodPeak = 0, bloodDroppedPeak = 0;
  const pushSeg = (ax, ay, az, bx, by, bz, cr, cg, cb) => {
    if (segCount >= maxSegments) return;
    const i = segCount * 6;
    segPos[i] = ax; segPos[i + 1] = ay; segPos[i + 2] = az;
    segPos[i + 3] = bx; segPos[i + 4] = by; segPos[i + 5] = bz;
    segCol[i] = cr; segCol[i + 1] = cg; segCol[i + 2] = cb;
    segCol[i + 3] = cr; segCol[i + 4] = cg; segCol[i + 5] = cb;
    segCount++;
  };
  const pushPoint = (x, y, z, cr, cg, cb) => {
    if (ptCount >= maxPoints) return;
    const i = ptCount * 3;
    ptPos[i] = x; ptPos[i + 1] = y; ptPos[i + 2] = z;
    ptCol[i] = cr; ptCol[i + 1] = cg; ptCol[i + 2] = cb;
    ptCount++;
  };
  // Write one pooled sprite instance. `pool` is glow (additive) or smoke (normal).
  const pushSprite = (pool, isGlow, x, y, z, size, r, g, b, alpha) => {
    if (alpha <= 0.003 || size <= 0) return;
    const idx = isGlow ? glowCount : smokeCount;
    if (idx >= pool.cap) return;
    const i3 = idx * 3;
    pool.wPos[i3] = x; pool.wPos[i3 + 1] = y; pool.wPos[i3 + 2] = z;
    pool.wCol[i3] = r; pool.wCol[i3 + 1] = g; pool.wCol[i3 + 2] = b;
    pool.wSize[idx] = size;
    pool.wAlpha[idx] = Math.min(1, alpha);
    if (isGlow) glowCount++; else smokeCount++;
  };
  // Place one pooled blood decal, oriented to (nx,ny,nz) and offset off the surface along it by
  // `lift` to avoid z-fighting with the geometry it's stuck to. `spin` rotates it about its own
  // normal, baked into the two in-plane axes below, for per-hit variety.
  //
  // `lift` is a parameter because 1 cm is right for a splat on the ground and badly wrong on a body:
  // a bot's forearm is ~9.4 cm across, so a fixed 1 cm lift floats the decal more than a tenth of
  // the limb's width off its surface, which reads as a mark hovering near the arm rather than one
  // stuck to it. Ground decals keep the default; blood_stain scales it down to its own size.
  // `wound` is 1 for a stain at a bullet hole and 0 for anything else sharing this pool. The wound
  // centre has to be PER INSTANCE, not a material uniform: stains and ground splatter are one draw
  // call, so a uniform darkened both, and a thrown droplet is not a puncture.
  const pushBlood = (x, y, z, nx, ny, nz, size, r, g, b, alpha, spin, lift = 0.01, wound = 1) => {
    if (alpha <= 0.003 || size <= 0) return;
    if (bloodCount >= bloodPool.cap) { bloodDropped++; return; }
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-8) { nx = 0; ny = 1; nz = 0; } else { nx /= nl; ny /= nl; nz /= nl; }
    // Any in-plane basis will do -- `spin` randomizes the decal's roll anyway. The helper axis just
    // has to not be parallel to the normal, or the cross product collapses.
    const steep = Math.abs(ny) > 0.99;
    const hx = steep ? 1 : 0, hy = steep ? 0 : 1;   // helper x-axis when the normal is near-vertical
    let tx = hy * nz, ty = -hx * nz, tz = hx * ny - hy * nx;   // helper x normal (helper.z is always 0)
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const cs = Math.cos(spin) * size, sn = Math.sin(spin) * size;
    const i = bloodCount++, i3 = i * 3;
    const P = bloodPool.pos, T = bloodPool.tan, B = bloodPool.bit, C = bloodPool.col;
    P[i3] = x + nx * lift; P[i3 + 1] = y + ny * lift; P[i3 + 2] = z + nz * lift;
    T[i3] = tx * cs + bx * sn; T[i3 + 1] = ty * cs + by * sn; T[i3 + 2] = tz * cs + bz * sn;
    B[i3] = bx * cs - tx * sn; B[i3 + 1] = by * cs - ty * sn; B[i3 + 2] = bz * cs - tz * sn;
    C[i3] = r; C[i3 + 1] = g; C[i3 + 2] = b;
    bloodPool.alpha[i] = Math.min(1, alpha);
    bloodPool.wound[i] = wound;
  };

  // ---------- layered explosion (port of createEnemyDeathExplosion) ----------
  // t = seconds since first seen; R = blast radius; (cr,cg,cb) = base blast colour.
  function drawExplosion(e, t, cr, cg, cb) {
    const R = Math.max(1, Number(e.radius) || 6);
    const P = e.p;
    const gY = groundAt(P[0], P[2], P[1] - 0.5); // true terrain height under the blast
    const nearGround = (P[1] - gY) < R * 0.8;    // airbursts/wall/creature hits skip the ground ring

    // 1. Fireball core — white-hot ball that flares then collapses to the blast colour.
    if (t < 0.2) {
      const ct = t / 0.2, a = 1 - ct;
      const wr = cr + (1 - cr) * (1 - ct), wg = cg + (1 - cg) * (1 - ct), wb = cb + (1 - cb) * (1 - ct);
      pushSprite(glow, true, P[0], P[1], P[2], R * (0.5 + ct * 0.7), wr, wg, wb, 0.95 * a);
    }
    // 2. Fireball body — a few warm puffs bloom outward for volume.
    if (t < 0.34) {
      const bt = t / 0.34, a = (1 - bt) * 0.8;
      for (let k = 0; k < 5; k++) {
        const ang = hash01(e.id, k * 7 + 2) * Math.PI * 2;
        const rad = R * (0.15 + bt * 0.55) * (0.5 + hash01(e.id, k * 7 + 3));
        const ox = Math.cos(ang) * rad, oz = Math.sin(ang) * rad;
        const oy = (hash01(e.id, k * 7 + 4) - 0.3) * R * bt * 0.8;
        pushSprite(glow, true, P[0] + ox, P[1] + oy, P[2] + oz,
          R * (0.4 + bt * 0.5), cr, cg * 0.85 + 0.1, cb * 0.6, a);
      }
    }
    // 3. Shockwave ground ring — expanding additive ring on the terrain plane (ground hits only).
    if (nearGround && t < 0.42) {
      const st = t / 0.42, rr = R * (0.2 + st * 1.05), a = (1 - st) * 0.8;
      const SEG = 26;
      for (let k = 0; k < SEG; k++) {
        const a0 = (k / SEG) * Math.PI * 2, a1 = ((k + 1) / SEG) * Math.PI * 2;
        pushSeg(P[0] + Math.cos(a0) * rr, gY + 0.12, P[2] + Math.sin(a0) * rr,
          P[0] + Math.cos(a1) * rr, gY + 0.12, P[2] + Math.sin(a1) * rr,
          cr * a, (cg * 0.7 + 0.3) * a, cb * a);
      }
    }
    // 4. Shell — warm radial rays bursting to ~0.8R (the wireframe-shell analog).
    if (t < 0.28) {
      const st = t / 0.28, grow = R * (0.15 + st * 0.7), a = (1 - st) * 0.9;
      for (let k = 0; k < 14; k++) {
        let dx = hash01(e.id, k * 3 + 11) - 0.5, dy = hash01(e.id, k * 3 + 12) - 0.5, dz = hash01(e.id, k * 3 + 13) - 0.5;
        const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
        pushSeg(P[0], P[1], P[2], P[0] + dx * grow, P[1] + dy * grow, P[2] + dz * grow,
          a, a * 0.85, a * 0.6);
      }
    }
    // 5. Embers — ~22 warm dots on ballistic arcs (gravity), cooling as they fly.
    if (t < 0.52) {
      const et = t / 0.52, a = 1 - et, G = 26;
      for (let k = 0; k < 22; k++) {
        let dx = hash01(e.id, k * 5 + 21) - 0.5, dy = hash01(e.id, k * 5 + 22), dz = hash01(e.id, k * 5 + 23) - 0.5;
        const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
        const sp = R * (1.2 + hash01(e.id, k * 5 + 24) * 2.2);
        const x = P[0] + dx * sp * t, y = P[1] + dy * sp * t - 0.5 * G * t * t, z = P[2] + dz * sp * t;
        const warm = 0.4 + hash01(e.id, k * 5 + 25) * 0.6; // orange→yellow
        pushPoint(x, Math.max(gY + 0.05, y), z, a, a * (0.5 + warm * 0.4), a * 0.25 * warm);
      }
    }
    // 6. Shrapnel — ~12 hot fragment streaks flung out under gravity; skid along the real
    // ground on contact (streak turns horizontal) rather than punching through it.
    if (t < 0.72) {
      const ft = t / 0.72, a = (1 - ft) * 0.9, G = 30;
      for (let k = 0; k < 12; k++) {
        let dx = hash01(e.id, k * 4 + 31) - 0.5, dy = 0.2 + hash01(e.id, k * 4 + 32) * 0.8, dz = hash01(e.id, k * 4 + 33) - 0.5;
        const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
        const sp = R * (2.0 + hash01(e.id, k * 4 + 34) * 3.0);
        const vy0 = dy * sp;
        let y = P[1] + vy0 * t - 0.5 * G * t * t;
        const x = P[0] + dx * sp * t, z = P[2] + dz * sp * t;
        let ux = dx * sp, uy = vy0 - G * t, uz = dz * sp; // instantaneous velocity
        if (y < gY + 0.05) { y = gY + 0.05; uy = 0; }     // grounded: skid, don't drill downward
        const vlen = Math.hypot(ux, uy, uz) || 1; ux /= vlen; uy /= vlen; uz /= vlen;
        const streak = 0.4 + R * 0.06;
        pushSeg(x, y, z, x - ux * streak, y - uy * streak, z - uz * streak, a, a * 0.55, a * 0.2);
      }
    }
    // 7. Smoke — dark puffs that rise, expand, and linger long after the flash.
    {
      const SMK = 10;
      for (let k = 0; k < SMK; k++) {
        const born = hash01(e.id, k * 6 + 41) * 0.12;      // staggered emission
        const dur = 1.3 + hash01(e.id, k * 6 + 42) * 0.4;
        const lt = (t - born) / dur;
        if (lt <= 0 || lt >= 1) continue;
        const ang = hash01(e.id, k * 6 + 43) * Math.PI * 2;
        const rad = R * (0.1 + smooth(lt) * 0.6) * (0.4 + hash01(e.id, k * 6 + 44));
        const rise = R * 0.5 * lt + lt * lt * R * 0.4;
        const x = P[0] + Math.cos(ang) * rad, z = P[2] + Math.sin(ang) * rad;
        const y = P[1] + rise + R * 0.15;
        const size = R * (0.5 + smooth(lt) * 1.1);
        const a = smooth(Math.min(1, lt * 4)) * (1 - lt) * 0.5; // fade in fast, out slow
        const shade = 0.34 - lt * 0.16; // cools from warm-gray toward dark
        pushSprite(smoke, false, x, y, z, size, shade + 0.06, shade, shade * 0.92, a);
      }
    }
  }

  // ---------- muzzle flash (port of createMuzzleFlash + createMuzzleSmoke) ----------
  // P is the actual viewmodel muzzle (~0.6 m from the eye), so everything here is SMALL and
  // sits just ahead of the barrel — never a screen-filling flash in the shooter's face.
  function drawMuzzle(e, t, cr, cg, cb) {
    const P = e.p, d = e.dir || [0, 0, 1];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const dx = d[0] / dl, dy = d[1] / dl, dz = d[2] / dl;
    const fx = e.muzzleFx || {};
    const value = (key, fallback) => Number.isFinite(fx[key]) ? fx[key] : fallback;
    // Barrel-relative basis for deterministic scatter. This prevents the old world-X/Z
    // jitter from sliding smoke sideways when the player looks in a different direction.
    let rx = -dz, ry = 0, rz = dx;
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-5) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * dz - rz * dy, uy = rz * dx - rx * dz, uz = rx * dy - ry * dx;
    // hot flash right at the muzzle tip, very brief
    const flashDuration = Math.max(0.001, value('flashDuration', 0.08));
    const flashOpacity = Math.max(0, value('flashOpacity', 0.85));
    if (t < flashDuration && flashOpacity > 0) {
      const a = (1 - t / flashDuration) * flashOpacity;
      const fwd = value('flashForward', 0.02);
      const px = P[0] + dx * fwd, py = P[1] + dy * fwd, pz = P[2] + dz * fwd;
      pushSprite(glow, true, px, py, pz,
        Math.max(0.001, value('flashSize', 0.13) + t * value('flashGrowth', 0.4)),
        cr, cg, cb, a);
      pushPoint(px, py, pz, a * cr, a * cg, a * cb);
    }
    // Small smoke wisps start at the authored muzzle and drift along its world orientation.
    const smokeCount = Math.max(0, Math.min(12, Math.round(value('smokeCount', 2))));
    const smokeDuration = Math.max(0.001, value('smokeDuration', 0.42));
    const smokeOpacity = Math.max(0, value('smokeOpacity', 0.22));
    for (let k = 0; k < smokeCount && smokeOpacity > 0; k++) {
      const dur = smokeDuration * (0.85 + hash01(e.id, k * 4 + 51) * 0.3);
      const lt = t / dur;
      if (lt >= 1) continue;
      const fwd = value('smokeForward', 0) + lt * value('smokeTravel', 0.42)
        * (0.75 + hash01(e.id, k * 4 + 52) * 0.5);
      const scatter = value('smokeSpread', 0.06) * (0.2 + lt * 0.8);
      const jr = (hash01(e.id, k * 4 + 53) - 0.5) * 2 * scatter;
      const ju = (hash01(e.id, k * 4 + 54) - 0.5) * 2 * scatter;
      const x = P[0] + dx * fwd + rx * jr + ux * ju;
      const y = P[1] + dy * fwd + ry * jr + uy * ju + lt * value('smokeRise', 0.1);
      const z = P[2] + dz * fwd + rz * jr + uz * ju;
      const size = Math.max(0.001, value('smokeSize', 0.08) + lt * value('smokeGrowth', 0.28));
      const a = smooth(Math.min(1, lt * 5)) * (1 - lt) * smokeOpacity;
      pushSprite(smoke, false, x, y, z, size, 0.4, 0.4, 0.38, a);
    }
  }

  // A hitscan tracer is rendered as a visual projectile: a short luminous streak whose head
  // advances toward the fixed hit point while its tail follows. Additive soft sprites laid
  // along the core approximate a camera-facing glow ribbon without relying on unsupported
  // wide LineBasicMaterial widths in WebGPU.
  function drawTracer(e, t, cr, cg, cb) {
    const segment = tracerSegmentAt(e.p, e.p1 || e.p, t, e.tracerFx);
    if (!segment) return;
    const [ax, ay, az] = segment.start;
    const [bx, by, bz] = segment.end;
    const alpha = segment.alpha;
    pushSeg(ax, ay, az, bx, by, bz, cr * alpha, cg * alpha, cb * alpha);

    const glowAlpha = alpha * segment.glow;
    if (glowAlpha <= 0.003) return;
    const spacing = Math.max(0.1, segment.width * 3);
    const samples = Math.max(2, Math.min(12, Math.ceil(segment.segmentLength / spacing) + 1));
    for (let i = 0; i < samples; i++) {
      const u = samples === 1 ? 1 : i / (samples - 1);
      const x = ax + (bx - ax) * u;
      const y = ay + (by - ay) * u;
      const z = az + (bz - az) * u;
      pushSprite(
        glow,
        true,
        x,
        y,
        z,
        segment.width * 4,
        cr,
        cg,
        cb,
        glowAlpha * (0.55 + u * 0.45),
      );
    }
  }

  // ---------- smoke puff (rocket trail bead / lingering blast wisp) ----------
  // Costs exactly ONE smoke sprite. A trail is many independent short-lived puff entities
  // accumulating behind the projectile — never one entity emitting sub-particles.
  function drawSmokePuff(e, t, cr, cg, cb) {
    const life = Number(e.life) || 0.1; // same fallback sync uses, so the envelopes can't disagree
    const lt = t / life;
    if (lt >= 1) return;
    if (!Array.isArray(e.color)) { cr = 0.42; cg = 0.40; cb = 0.38; } // smoke gray, not the warm effect default
    const P = e.p, d = e.drift || [0, 0, 0];
    const rise = Number.isFinite(e.rise) ? e.rise : 0.35;
    const sz0 = Number.isFinite(e.size) ? e.size : 0.35;
    const growth = Number.isFinite(e.growth) ? e.growth : 0.9;
    const op = Number.isFinite(e.opacity) ? e.opacity : 0.3;
    // Deterministic per-puff scatter so a trail doesn't read as identical dots on a straight line.
    const j = sz0 * 0.5;
    const jx = (hash01(e.id, 61) - 0.5) * 2 * j;
    const jy = (hash01(e.id, 62) - 0.5) * 2 * j;
    const jz = (hash01(e.id, 63) - 0.5) * 2 * j;
    const sv = 0.8 + hash01(e.id, 64) * 0.45;  // per-puff size variance
    const bv = 0.88 + hash01(e.id, 65) * 0.24; // per-puff brightness variance
    const x = P[0] + (Number(d[0]) || 0) * t + jx;
    const y = P[1] + (Number(d[1]) || 0) * t + rise * t + jy;
    const z = P[2] + (Number(d[2]) || 0) * t + jz;
    const size = Math.max(0.001, (sz0 + growth * lt) * sv);
    const a = smooth(Math.min(1, lt * 6)) * (1 - lt) * op; // fast fade-in, long fade-out to zero
    const dim = (1 - lt * 0.45) * bv; // smoke cools/darkens as it ages
    pushSprite(smoke, false, x, y, z, size, cr * dim, cg * dim, cb * dim, a);
  }

  // ---------- blood spray (gravity-arced droplet burst) ----------
  // Reuses the same additive line/point buffers as embers/shrapnel above — droplets are just
  // short streaks along their instantaneous velocity, scattered around the hit normal and falling
  // under gravity, faded out linearly over the effect's life.
  function drawBloodSpray(e, t, cr, cg, cb) {
    const life = Number(e.life) || 0.6;
    const lt = t / life;
    if (lt >= 1) return;
    const P = e.p, n = e.normal || [0, 1, 0];
    const count = Math.max(1, Math.min(64, Math.round(Number(e.count) || 28)));
    const spread = Number.isFinite(e.spread) ? e.spread : 1.0;
    const speed = Number.isFinite(e.speed) ? e.speed : 4.2;
    const gravity = Number.isFinite(e.gravity) ? e.gravity : 9.8;
    const size = Number.isFinite(e.size) ? e.size : 0.03;
    const a = 1 - lt;
    if (a <= 0) return;
    for (let k = 0; k < count; k++) {
      let dx = n[0] + (hash01(e.id, k * 5 + 1) - 0.5) * spread * 2;
      let dy = n[1] + (hash01(e.id, k * 5 + 2) - 0.25) * spread * 1.5 + 0.25;
      let dz = n[2] + (hash01(e.id, k * 5 + 3) - 0.5) * spread * 2;
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      const sp = speed * (0.5 + hash01(e.id, k * 5 + 4));
      const x = P[0] + dx * sp * t, z = P[2] + dz * sp * t;
      const y = P[1] + dy * sp * t - 0.5 * gravity * t * t;
      const vx = dx * sp, vy = dy * sp - gravity * t, vz = dz * sp; // horizontal speed is constant, only vy falls
      const vl = Math.hypot(vx, vy, vz) || 1;
      const ux = vx / vl, uy = vy / vl, uz = vz / vl;
      // Capped at how far the droplet has actually flown, or a slow spray draws tails longer than
      // its travel and every streak reaches back to the spawn point in a converging bundle.
      const streak = Math.min(Math.max(0.02, size * 3), Math.hypot(x - P[0], y - P[1], z - P[2]));
      pushSeg(x, y, z, x - ux * streak, y - uy * streak, z - uz * streak, cr * a, cg * a, cb * a);
    }
  }

  // ---------- blood stain (small, high-opacity decal stuck to the hit surface itself) ----------
  // With an `attach` handle the stain is placed from the hit part's LIVE world matrix every frame,
  // so it rides the animation instead of hanging in the air where the bot used to be. Without one —
  // or when the handle no longer resolves (bot despawned, corpse culled, body rebuilt on revive,
  // guest has no such bot) — it falls back to the world-anchored `p`/`normal` already in the wire
  // object, which freezes the decal at its last resolved pose rather than dropping it to the origin.
  function drawBloodStain(e, t, cr, cg, cb) {
    const life = Number(e.life) || 6.0;
    const lt = t / life;
    if (lt >= 1) return;
    let P = e.p, n = e.normal || [0, 1, 0];
    const at = e.attach;
    if (at && Array.isArray(at.lp)) {
      const m = attachAt(e.ownerId, at);
      if (m) {
        _atP.set(at.lp[0], at.lp[1], at.lp[2]).applyMatrix4(m);
        // Normal matrix, not the model matrix: limb segments carry non-uniform scale from
        // placeSegment, which skews a normal pushed through the model matrix directly.
        _atM.getNormalMatrix(m);
        const L = at.ln || [0, 1, 0];
        _atN.set(L[0], L[1], L[2]).applyMatrix3(_atM).normalize();
        P = [_atP.x, _atP.y, _atP.z];
        n = [_atN.x, _atN.y, _atN.z];
      }
    }
    const size = Number.isFinite(e.size) ? e.size : 0.15;
    const opacity = Number.isFinite(e.opacity) ? e.opacity : 0.92;
    const fadeIn = smooth(Math.min(1, lt * 12));
    const fadeOut = 1 - smooth(Math.max(0, (lt - 0.7) / 0.3));
    const a = fadeIn * fadeOut * opacity;
    const spin = hash01(e.id, 91) * Math.PI * 2;
    // Scaled to the decal, not fixed: a stain sized to the part it hit is the thing that decides how
    // far off that surface it can afford to sit. Floored so it still clears depth precision.
    const lift = Math.min(0.01, Math.max(0.0008, size * 0.04));
    pushBlood(P[0], P[1], P[2], n[0], n[1], n[2], size, cr, cg, cb, a, spin, lift);
  }

  // ---------- blood splatter (decals on the GROUND where the spray's own droplets would land) ----------
  // Reuses blood_spray's per-droplet scatter (same formula, independent RNG stream off this
  // effect's own id) but resolves each droplet's ballistic fall time to the ground instead of
  // animating its flight, then drops a flat decal (normal [0,1,0], not the hit normal) at the
  // landing point. Ground height at the landing spot is looked up via the injected terrainHeight,
  // same as drawExplosion's shockwave ring — a hit on sloped ground still lands each splat at the
  // right height. `life` here is how long the ground mark lingers, not flight time (flight time —
  // tLand below — is typically well under a second and has already elapsed long before the decal
  // fades out).
  function drawBloodSplatter(e, t, cr, cg, cb) {
    const life = Number(e.life) || 8.0;
    const lt = t / life;
    if (lt >= 1) return;
    const P = e.p, n = e.normal || [0, 1, 0];
    const count = Math.max(1, Math.min(48, Math.round(Number(e.count) || 10)));
    const spread = Number.isFinite(e.spread) ? e.spread : 1.0;
    const speed = Number.isFinite(e.speed) ? e.speed : 4.2;
    const gravity = Math.max(0.05, Number.isFinite(e.gravity) ? e.gravity : 9.8);
    const size = Number.isFinite(e.size) ? e.size : 0.12;
    const opacity = Number.isFinite(e.opacity) ? e.opacity : 0.8;
    const fadeIn = smooth(Math.min(1, lt * 8));
    const fadeOut = 1 - smooth(Math.max(0, (lt - 0.7) / 0.3));
    const a = fadeIn * fadeOut * opacity;
    if (a <= 0.003) return;
    const groundY0 = groundAt(P[0], P[2], P[1] - 1);
    const dropHeight = Math.max(0.05, P[1] - groundY0);
    for (let k = 0; k < count; k++) {
      let dx = n[0] + (hash01(e.id, k * 7 + 71) - 0.5) * spread * 2;
      let dy = n[1] + (hash01(e.id, k * 7 + 72) - 0.25) * spread * 1.5 + 0.25;
      let dz = n[2] + (hash01(e.id, k * 7 + 73) - 0.5) * spread * 2;
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      const sp = speed * (0.5 + hash01(e.id, k * 7 + 74));
      // Time-of-flight to fall `dropHeight` starting with vertical speed vy under gravity g:
      // solving 0.5*g*t^2 - vy*t - dropHeight = 0 for the positive root (mirrors the classic
      // sqrt(2h/g) drop-time formula when vy = 0).
      const vy = dy * sp;
      const tLand = (vy + Math.sqrt(vy * vy + 2 * gravity * dropHeight)) / gravity;
      if (!Number.isFinite(tLand) || tLand <= 0) continue;
      const lx = P[0] + dx * sp * tLand, lz = P[2] + dz * sp * tLand;
      const ly = groundAt(lx, lz, groundY0);
      const spin = hash01(e.id, k * 7 + 75) * Math.PI * 2;
      const jitterSize = size * (0.7 + hash01(e.id, k * 7 + 76) * 0.6);
      // wound = 0: a droplet thrown onto the ground is not a puncture, so it keeps a flat colour.
      pushBlood(lx, ly, lz, 0, 1, 0, jitterSize, cr, cg, cb, a, spin, 0.01, 0);
    }
  }

  function sync(list, nowMs) {
    segCount = 0; ptCount = 0; glowCount = 0; smokeCount = 0; bloodCount = 0; bloodDropped = 0;

    for (const e of (list || [])) {
      if (!e || e.type !== 'effect' || !Array.isArray(e.p)) continue;
      let seen = firstSeen.get(e.id);
      if (seen === undefined) { seen = nowMs; firstSeen.set(e.id, nowMs); }
      const t = (nowMs - seen) / 1000;
      const lifeMs = (Number(e.life) || 0.1) * 1000;
      const a = 1 - Math.min(1, Math.max(0, (nowMs - seen) / lifeMs));
      if (a <= 0) continue;
      const col = e.color || [1, 0.85, 0.45];
      const cr0 = col[0], cg0 = col[1], cb0 = col[2];

      if (e.kind === 'explosion') {
        drawExplosion(e, t, cr0, cg0, cb0);
      } else if (e.kind === 'muzzle_flash') {
        drawMuzzle(e, t, cr0, cg0, cb0);
      } else if (e.kind === 'gun_tracer') {
        drawTracer(e, t, cr0, cg0, cb0);
      } else if (e.kind === 'smoke_puff') {
        drawSmokePuff(e, t, cr0, cg0, cb0);
      } else if (e.kind === 'blood_spray') {
        drawBloodSpray(e, t, cr0, cg0, cb0);
      } else if (e.kind === 'blood_stain') {
        drawBloodStain(e, t, cr0, cg0, cb0);
      } else if (e.kind === 'blood_splatter') {
        drawBloodSplatter(e, t, cr0, cg0, cb0);
      } else if (e.kind === 'hit_spark') {
        // Spark rays fade fast (0.22s) while a small dust puff lingers over the full life.
        const st = Math.min(1, t / 0.22), sa = 1 - st;
        const cr = cr0 * sa, cg = cg0 * sa, cb = cb0 * sa;
        const n = e.normal || [0, 1, 0];
        const grow = 0.18 + st * 1.1;
        for (let k = 0; k < SPARK_RAYS; k++) {
          const jx = hash01(e.id, k * 3 + 1) - 0.5;
          const jy = hash01(e.id, k * 3 + 2) - 0.5;
          const jz = hash01(e.id, k * 3 + 3) - 0.5;
          let dx = n[0] + jx * 1.6, dy = n[1] + jy * 1.6, dz = n[2] + jz * 1.6;
          const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
          pushSeg(e.p[0], e.p[1], e.p[2],
            e.p[0] + dx * grow, e.p[1] + dy * grow, e.p[2] + dz * grow, cr, cg, cb);
        }
        pushPoint(e.p[0], e.p[1], e.p[2], cr, cg, cb);
        // dust for world-surface hits only (not flesh) — reads as debris kicked up.
        if (e.surface === 'terrain' || e.surface === 'obstacle') {
          const dt2 = t / (Number(e.life) || 0.6);
          if (dt2 < 1) {
            const y = e.p[1] + n[1] * 0.2 + dt2 * 0.4;
            const da = smooth(Math.min(1, dt2 * 5)) * (1 - dt2) * 0.3;
            pushSprite(smoke, false, e.p[0] + n[0] * 0.2, y, e.p[2] + n[2] * 0.2,
              0.28 + dt2 * 0.5, 0.42, 0.4, 0.36, da);
          }
        }
      } else {
        // Generic fallback for any future line-shaped effect.
        const cr = cr0 * a, cg = cg0 * a, cb = cb0 * a;
        const p1 = e.p1 || e.p;
        pushSeg(e.p[0], e.p[1], e.p[2], p1[0], p1[1], p1[2], cr, cg, cb);
        pushPoint(e.p[0], e.p[1], e.p[2], cr, cg, cb);
      }
    }

    // Drop fade state for ids long dead.
    if (nowMs >= sweepAt) {
      sweepAt = nowMs + SEEN_SWEEP_MS;
      for (const [id, seen] of firstSeen) if (nowMs - seen > SEEN_TTL_MS) firstSeen.delete(id);
    }

    lineGeo.setDrawRange(0, segCount * 2);
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;
    ptGeo.setDrawRange(0, ptCount);
    ptGeo.attributes.position.needsUpdate = true;
    ptGeo.attributes.color.needsUpdate = true;
    lines.visible = segCount > 0;
    points.visible = ptCount > 0;
    gatherSmoke(smokeCount);
    uploadPool(glow, glowCount);
    uploadPool(smoke, smokeCount);
    uploadDecals(bloodPool, bloodCount);
    if (bloodCount > bloodPeak) bloodPeak = bloodCount;
    if (bloodDropped > bloodDroppedPeak) bloodDroppedPeak = bloodDropped;
  }

  // Copy smoke staging -> instance buffers, back-to-front when a camera is known.
  function gatherSmoke(n) {
    if (n <= 0) return;
    const { wPos, wCol, wSize, wAlpha, pos, col, size, alpha } = smoke;
    let sorted = false;
    if (n > 1 && lastCamera && lastCamera.matrixWorld) {
      const m = lastCamera.matrixWorld.elements;
      const cx = m[12], cy = m[13], cz = m[14];
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const dx = wPos[i3] - cx, dy = wPos[i3 + 1] - cy, dz = wPos[i3 + 2] - cz;
        smokeOrder[i] = i;
        smokeKey[i] = dx * dx + dy * dy + dz * dz;
      }
      smokeOrder.subarray(0, n).sort((a, b) => smokeKey[b] - smokeKey[a]);
      sorted = true;
    }
    for (let i = 0; i < n; i++) {
      const j = sorted ? smokeOrder[i] : i;
      const i3 = i * 3, j3 = j * 3;
      pos[i3] = wPos[j3]; pos[i3 + 1] = wPos[j3 + 1]; pos[i3 + 2] = wPos[j3 + 2];
      col[i3] = wCol[j3]; col[i3 + 1] = wCol[j3 + 1]; col[i3 + 2] = wCol[j3 + 2];
      size[i] = wSize[j];
      alpha[i] = wAlpha[j];
    }
  }

  function uploadPool(pool, n) {
    pool.geo.instanceCount = n;
    pool.mesh.visible = n > 0;
    if (n <= 0) return;
    const a = pool.geo.attributes;
    a.instPos.needsUpdate = true;
    a.instColor.needsUpdate = true;
    a.instSize.needsUpdate = true;
    a.instAlpha.needsUpdate = true;
  }

  // Decals are normal-blended and depth-tested but never depth-sorted against each other: they lie
  // flush on solid surfaces, so overlap is coplanar rather than layered, and every decal in this
  // pool is the same dark red. Sorting them would buy nothing the smoke gather buys.
  function uploadDecals(pool, n) {
    pool.geo.instanceCount = n;
    pool.mesh.visible = n > 0;
    if (n <= 0) return;
    const a = pool.geo.attributes;
    a.instPos.needsUpdate = true;
    a.instTan.needsUpdate = true;
    a.instBit.needsUpdate = true;
    a.instColor.needsUpdate = true;
    a.instAlpha.needsUpdate = true;
    a.instWound.needsUpdate = true;
  }

  /**
   * Resize the blood/splatter decal pool. Returns the cap actually in force.
   *
   * The cap is a buffer size, so changing it means new Float32Arrays and a new geometry — there is
   * no way to grow an InstancedBufferAttribute in place. That makes this a rebuild, not a write, and
   * it drops whatever decals were on screen for one frame: sync() repopulates every instance from
   * the wire list on the very next call, so nothing is permanently lost, but this is not something to
   * call per frame. Drive it from a slider's change event, not its input event.
   */
  function setBloodDecalCap(n) {
    const cap = Math.max(0, Math.min(16384, Math.floor(Number(n) || 0)));
    if (cap === bloodPool.cap) return bloodPool.cap;
    scene.remove(bloodPool.mesh);
    bloodPool.geo.dispose();
    bloodPool.mat.dispose();
    bloodPool = makeDecalPool(cap);
    bloodCount = Math.min(bloodCount, cap);
    bloodPeak = 0; bloodDroppedPeak = 0;   // peaks measured against the old cap mean nothing now
    return cap;
  }

  /**
   * What the pools actually cost last frame. `bloodPeak`/`bloodDroppedPeak` are the high-water marks
   * since the last cap change or resetStats() — the numbers that say whether a cap is too small
   * (drops above zero) or wastefully large (peak far below cap).
   */
  function stats() {
    return {
      bloodCap: bloodPool.cap, bloodUsed: bloodCount, bloodDropped,
      bloodPeak, bloodDroppedPeak,
      segments: segCount, points: ptCount, glow: glowCount, smoke: smokeCount,
    };
  }
  function resetStats() { bloodPeak = 0; bloodDroppedPeak = 0; }

  /**
   * Retune the wound centre. A uniform write, not a rebuild — safe to call as often as a slider
   * moves. Fields are optional; `darken: 1` turns the effect off without changing the shader.
   */
  function setWoundStyle({ inner, outer, darken } = {}) {
    if (Number.isFinite(inner)) woundInner.value = inner;
    if (Number.isFinite(outer)) woundOuter.value = outer;
    if (Number.isFinite(darken)) woundDarken.value = darken;
    return { inner: woundInner.value, outer: woundOuter.value, darken: woundDarken.value };
  }

  function dispose() {
    scene.remove(lines); scene.remove(points);
    lineGeo.dispose(); lineMat.dispose(); ptGeo.dispose(); ptMat.dispose();
    for (const p of [glow, smoke, bloodPool]) { scene.remove(p.mesh); p.geo.dispose(); p.mat.dispose(); }
    softTex.dispose();
    stainTex.dispose();
  }

  return { sync, dispose, setBloodDecalCap, stats, resetStats, setWoundStyle };
}
