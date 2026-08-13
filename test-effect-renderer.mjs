// test-effect-renderer.mjs — pool arithmetic / lifecycle contract for effect-renderer.js.
// Verifies instance counts, pool caps, empty-sync teardown, the firstSeen sweep, and the
// smoke back-to-front gather. Rendering itself is NOT verified here (no GPU in Node).
// Run: node test-effect-renderer.mjs

import * as THREE from 'three/webgpu';

// --- headless canvas stub so makeSoftTexture() can build its radial gradient ---------------
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillStyle: null,
        fillRect() {},
        // makeStainTexture draws its lobes as filled arcs, not rects.
        beginPath() {}, arc() {}, fill() {},
      }),
    }),
  };
}

const { createEffectRenderer, bloodIntensityForHealth } = await import('./effect-renderer.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
function checkTrue(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${detail}`}`);
}

function makeHarness(opts = {}) {
  const children = [];
  const scene = { children, add(o) { children.push(o); }, remove(o) { const i = children.indexOf(o); if (i >= 0) children.splice(i, 1); } };
  const fx = createEffectRenderer({ THREE, scene, terrainHeight: () => 0, ...opts });
  const meshes = children.filter((o) => o.isMesh && o.geometry && o.geometry.isInstancedBufferGeometry);
  const glow = meshes.find((m) => m.material.blending === THREE.AdditiveBlending);
  // Smoke and blood are both normal-blended; only the decal pool carries the in-plane axis attributes.
  const isDecal = (m) => !!m.geometry.getAttribute('instTan');
  const smoke = meshes.find((m) => m.material.blending === THREE.NormalBlending && !isDecal(m));
  const blood = meshes.find(isDecal);
  return { fx, scene, glow, smoke, blood };
}

// ---------------------------------------------------------------------------------------
// 1. Construction: three instanced pool meshes — additive glow, normal-blend smoke, decal blood.
// ---------------------------------------------------------------------------------------
{
  const { scene, glow, smoke, blood } = makeHarness();
  const pools = scene.children.filter((o) => o.isMesh && o.geometry && o.geometry.isInstancedBufferGeometry);
  check('construct: instanced pool meshes', pools.length, 3);
  checkTrue('construct: glow pool exists (additive)', !!glow);
  checkTrue('construct: smoke pool exists (normal blend)', !!smoke);
  checkTrue('construct: blood decal pool exists', !!blood);
  check('construct: glow starts empty', glow.geometry.instanceCount, 0);
  check('construct: smoke starts empty', smoke.geometry.instanceCount, 0);
  check('construct: blood starts empty', blood.geometry.instanceCount, 0);
  checkTrue('construct: glow not frustum culled', glow.frustumCulled === false);
  checkTrue('construct: smoke not frustum culled', smoke.frustumCulled === false);
  checkTrue('construct: blood not frustum culled', blood.frustumCulled === false);
  checkTrue('construct: smoke fogged, glow not', smoke.material.fog === true && glow.material.fog === false);
  for (const name of ['instPos', 'instColor', 'instSize', 'instAlpha']) {
    checkTrue(`construct: ${name} is instanced`, glow.geometry.getAttribute(name).isInstancedBufferAttribute === true);
  }
  for (const name of ['instPos', 'instTan', 'instBit', 'instColor', 'instAlpha']) {
    checkTrue(`construct: blood ${name} is instanced`, blood.geometry.getAttribute(name).isInstancedBufferAttribute === true);
  }
  check('construct: glow capacity', glow.geometry.getAttribute('instSize').count, 220);
  check('construct: smoke capacity', smoke.geometry.getAttribute('instSize').count, 260);
  check('construct: blood capacity (default)', blood.geometry.getAttribute('instAlpha').count, 512);
  // DoubleSide without forceSinglePass is what made the old per-mesh pool draw twice.
  checkTrue('construct: blood is single-pass DoubleSide',
    blood.material.side === THREE.DoubleSide && blood.material.forceSinglePass === true);
}

// ---------------------------------------------------------------------------------------
// 1b. Blood decal geometry: instance counts, the size->axis-length contract, and the cap.
// ---------------------------------------------------------------------------------------
const stain = (id, p = [0, 1, 0], n = [0, 1, 0]) =>
  ({ id, type: 'effect', kind: 'blood_stain', p, normal: n, color: [0.4, 0.02, 0.03], size: 0.2, opacity: 1, life: 6 });
// blood_stain fades IN over the first lt*12 of its life, so at t=0 its alpha is 0 and pushBlood
// drops it. Every case below samples at 1 s, well inside the 6 s life and past the fade-in.
const AGED = 1000;
{
  const { fx, blood } = makeHarness();
  fx.sync([stain('b1')], 0);
  fx.sync([stain('b1')], AGED);
  check('blood_stain: 1 decal instance', blood.geometry.instanceCount, 1);
  checkTrue('blood_stain: pool visible', blood.visible === true);

  // The two in-plane axes must each be `size` long (the quad spans ±0.5 of them) and orthogonal to
  // each other and to the normal -- that is what makes the decal a flat square lying on the surface.
  const t = blood.geometry.getAttribute('instTan').array;
  const b = blood.geometry.getAttribute('instBit').array;
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const tv = [t[0], t[1], t[2]], bv = [b[0], b[1], b[2]];
  checkTrue('blood_stain: tangent length == size', Math.abs(len(tv) - 0.2) < 1e-5, `got ${len(tv)}`);
  checkTrue('blood_stain: bitangent length == size', Math.abs(len(bv) - 0.2) < 1e-5, `got ${len(bv)}`);
  checkTrue('blood_stain: axes orthogonal', Math.abs(dot(tv, bv)) < 1e-5, `got ${dot(tv, bv)}`);
  checkTrue('blood_stain: axes lie in the surface plane', Math.abs(tv[1]) < 1e-5 && Math.abs(bv[1]) < 1e-5,
    `got ty=${tv[1]} by=${bv[1]}`);

  // A near-vertical normal must NOT collapse the basis -- that is the case the helper axis exists for.
  const { fx: fx2, blood: blood2 } = makeHarness();
  const pair = [stain('b2', [0, 1, 0], [0, 1, 0]), stain('b3', [3, 1, 0], [1, 0, 0])];
  fx2.sync(pair, 0); fx2.sync(pair, AGED);
  check('blood_stain: both normals produce decals', blood2.geometry.instanceCount, 2);
  const t2 = blood2.geometry.getAttribute('instTan').array;
  checkTrue('blood_stain: vertical normal keeps a real tangent', len([t2[0], t2[1], t2[2]]) > 1e-4);

  // Over-cap decals are dropped, never written past the buffer.
  const { fx: fx3, blood: blood3 } = makeHarness();
  const many = Array.from({ length: 700 }, (_, i) => stain(`cap${i}`, [i, 1, 0]));
  fx3.sync(many, 0); fx3.sync(many, AGED);
  check('blood_stain: instances clamp to cap', blood3.geometry.instanceCount, 512);

  // An empty sync hides the pool again.
  const { fx: fx4, blood: blood4 } = makeHarness();
  fx4.sync([stain('b4')], 0);
  fx4.sync([stain('b4')], AGED);
  fx4.sync([], AGED);
  check('blood: empty sync zeroes instances', blood4.geometry.instanceCount, 0);
  checkTrue('blood: empty sync hides pool', blood4.visible === false);
}

// ---------------------------------------------------------------------------------------
// 1c. blood_stain attachment: the decal is placed from the resolved part matrix each frame, falls
// back to the world-anchored wire position when the handle doesn't resolve, and transforms its
// normal with the NORMAL matrix (not the model matrix) so non-uniform limb scale doesn't skew it.
// ---------------------------------------------------------------------------------------
{
  const attached = (id, attach) => ({ ...stain(id), attach });
  const posOf = (blood) => Array.from(blood.geometry.getAttribute('instPos').array.slice(0, 3));
  // Same two-sync pattern as 1b: the first call registers firstSeen, the second ages past fade-in.
  const settle = (fx, wire) => { fx.sync([wire], 0); fx.sync([wire], AGED); };
  // A stain is lifted off its surface by a SIZE-SCALED amount, not a fixed 1 cm -- see drawBloodStain.
  const LIFT = Math.min(0.01, Math.max(0.0008, 0.2 * 0.04));

  // Resolved: instPos is the part-local point pushed through the matrix, plus pushBlood's 0.01
  // lift along the normal. The wire's own p (0,1,0) must NOT be what lands.
  const move = new THREE.Matrix4().makeTranslation(5, 0, 0);
  const { fx: fxA, blood: bloodA } = makeHarness({ resolveAttachment: () => move });
  settle(fxA, attached('a1', { part: 0, role: 'shell', parts: 4, lp: [0, 1, 0], ln: [0, 1, 0] }));
  const pA = posOf(bloodA);
  checkTrue('attach: decal follows the resolved matrix',
    Math.abs(pA[0] - 5) < 1e-5 && Math.abs(pA[1] - (1 + LIFT)) < 1e-5, `got ${pA}`);

  // Same wire object, resolver declines (bot despawned / body rebuilt / guest has no such bot).
  const { fx: fxB, blood: bloodB } = makeHarness({ resolveAttachment: () => null });
  settle(fxB, attached('a1', { part: 0, role: 'shell', parts: 4, lp: [0, 1, 0], ln: [0, 1, 0] }));
  const pB = posOf(bloodB);
  checkTrue('attach: unresolved handle falls back to the wire position',
    Math.abs(pB[0]) < 1e-5 && Math.abs(pB[1] - (1 + LIFT)) < 1e-5, `got ${pB}`);

  // No resolver injected at all: every existing consumer keeps today's behaviour untouched.
  const { fx: fxC, blood: bloodC } = makeHarness();
  settle(fxC, attached('a1', { part: 0, role: 'shell', parts: 4, lp: [9, 9, 9], ln: [0, 1, 0] }));
  const pC = posOf(bloodC);
  checkTrue('attach: no resolver leaves the decal world-anchored',
    Math.abs(pC[0]) < 1e-5 && Math.abs(pC[1] - (1 + LIFT)) < 1e-5, `got ${pC}`);

  // Non-uniform scale (1,4,1) — placeSegment stretches limb segments exactly like this. For
  // ln = (1,1,0)/sqrt2 the normal matrix gives ~(0.970, 0.243, 0) and the model matrix would give
  // ~(0.243, 0.970, 0): the two are far apart, so the check can only pass with the right one.
  const stretch = new THREE.Matrix4().makeScale(1, 4, 1);
  const { fx: fxD, blood: bloodD } = makeHarness({ resolveAttachment: () => stretch });
  const s2 = Math.SQRT1_2;
  settle(fxD, attached('a1', { part: 0, role: 'shell', parts: 4, lp: [0, 0, 0], ln: [s2, s2, 0] }));
  const pD = posOf(bloodD);
  const expN = [4 / Math.hypot(4, 1), 1 / Math.hypot(4, 1), 0];   // inverse-transpose of diag(1,4,1)
  checkTrue('attach: normal uses the normal matrix, not the model matrix',
    Math.abs(pD[0] - expN[0] * LIFT) < 1e-6 && Math.abs(pD[1] - expN[1] * LIFT) < 1e-6, `got ${pD}`);
  // and the decal's in-plane axes must be perpendicular to that same corrected normal.
  const tD = Array.from(bloodD.geometry.getAttribute('instTan').array.slice(0, 3));
  checkTrue('attach: in-plane axis stays perpendicular to the corrected normal',
    Math.abs(tD[0] * expN[0] + tD[1] * expN[1] + tD[2] * expN[2]) < 1e-6);
}

// ---------------------------------------------------------------------------------------
// 1d. Surface lift. A fixed 1 cm offset is right for a splat on the ground and wrong on a body: a
// bot forearm is ~9.4 cm across, so 1 cm floats the decal a tenth of the limb's width off it. A
// stain scales its lift to its own size; ground splatter keeps the flat 1 cm.
// ---------------------------------------------------------------------------------------
{
  const liftOf = (size) => {
    const { fx, blood } = makeHarness();
    const wire = { ...stain('L' + size), size, p: [0, 1, 0], normal: [0, 1, 0] };
    fx.sync([wire], 0); fx.sync([wire], AGED);
    return blood.geometry.getAttribute('instPos').array[1] - 1;   // offset along the +Y normal
  };
  const small = liftOf(0.05), big = liftOf(0.5);
  checkTrue('lift: a small stain sits close to the surface', small < 0.003, `got ${small}`);
  checkTrue('lift: it scales with the decal', Math.abs(small - 0.05 * 0.04) < 1e-6, `got ${small}`);
  checkTrue('lift: capped so a huge stain never floats past the old 1 cm', Math.abs(big - 0.01) < 1e-6, `got ${big}`);
  checkTrue('lift: floored so it still clears depth precision', liftOf(0.004) >= 0.0008 - 1e-9);

  // Ground splatter is unchanged — it lands on terrain, where 1 cm is invisible and z-fighting isn't.
  const { fx: fxS, blood: bloodS } = makeHarness();
  const spl = { id: 's1', type: 'effect', kind: 'blood_splatter', p: [0, 1, 0], normal: [0, 1, 0],
    color: [0.4, 0.02, 0.03], life: 8, count: 1, size: 0.12, opacity: 1, spread: 0, speed: 0, gravity: 9.8 };
  fxS.sync([spl], 0); fxS.sync([spl], AGED);
  checkTrue('lift: ground splatter keeps the flat 1 cm',
    Math.abs(bloodS.geometry.getAttribute('instPos').array[1] - 0.01) < 1e-6,
    `got ${bloodS.geometry.getAttribute('instPos').array[1]}`);
}

// ---------------------------------------------------------------------------------------
// 1e. Resizable decal budget. The 512 default was never measured, so the cap is a runtime dial with
// usage counters behind it. A cap is a buffer size, so setBloodDecalCap is a REBUILD — the old mesh
// has to leave the scene or every resize leaks one, and the new one has to actually be the size
// asked for.
// ---------------------------------------------------------------------------------------
{
  const decalMeshOf = (scene) =>
    scene.children.find((o) => o.isMesh && o.geometry?.isInstancedBufferGeometry && o.geometry.getAttribute('instTan'));
  const { fx, scene } = makeHarness({ maxBloodDecals: 64 });
  check('budget: honours the constructor cap', fx.stats().bloodCap, 64);

  // Overflow is counted, not silently swallowed — that count is the whole point of the dial.
  const many = Array.from({ length: 100 }, (_, i) => stain('B' + i));
  fx.sync(many, 0); fx.sync(many, AGED);
  check('budget: draws exactly the cap', fx.stats().bloodUsed, 64);
  check('budget: counts what the cap refused', fx.stats().bloodDropped, 36);
  check('budget: peak tracks the high-water mark', fx.stats().bloodPeak, 64);
  check('budget: dropped peak too', fx.stats().bloodDroppedPeak, 36);

  const before = decalMeshOf(scene);
  check('budget: setBloodDecalCap returns the applied cap', fx.setBloodDecalCap(256), 256);
  const after = decalMeshOf(scene);
  checkTrue('budget: the pool was rebuilt, not resized in place', before !== after);
  check('budget: exactly one decal pool remains in the scene',
    scene.children.filter((o) => o.isMesh && o.geometry?.isInstancedBufferGeometry && o.geometry.getAttribute('instTan')).length, 1);
  check('budget: the new buffer really is the new size', after.geometry.getAttribute('instAlpha').array.length, 256);
  check('budget: peaks reset, since old peaks were measured against the old cap', fx.stats().bloodPeak, 0);

  // The same 100 stains now fit, which is the user-visible point of raising it.
  fx.sync(many, 0); fx.sync(many, AGED);
  check('budget: a raised cap draws what it previously dropped', fx.stats().bloodUsed, 100);
  check('budget: and drops nothing', fx.stats().bloodDropped, 0);

  check('budget: a no-op resize is a no-op', fx.setBloodDecalCap(256), 256);
  checkTrue('budget: a no-op resize does not rebuild', decalMeshOf(scene) === after);

  // Junk in must not produce a NaN-sized buffer or a negative allocation.
  check('budget: negative clamps to zero', fx.setBloodDecalCap(-5), 0);
  fx.sync(many, 0); fx.sync(many, AGED);
  check('budget: a zero cap draws nothing', fx.stats().bloodUsed, 0);
  check('budget: and drops everything it was asked for', fx.stats().bloodDropped, 100);
  check('budget: garbage clamps to zero rather than throwing', fx.setBloodDecalCap('nonsense'), 0);
  check('budget: absurd values are bounded', fx.setBloodDecalCap(1e9), 16384);

  fx.resetStats();
  check('budget: resetStats clears the peak', fx.stats().bloodPeak, 0);
}

// ---------------------------------------------------------------------------------------
// 1f. bloodIntensityForHealth. The load-bearing property is the REGRESSION GUARD: at zero health
// this must reproduce the constants that shipped before it existed, so the change can only ever
// remove blood from light hits and never alter what a lethal hit already looked like.
// ---------------------------------------------------------------------------------------
{
  const dying = bloodIntensityForHealth(0);
  check('intensity: dying spray count is the old constant', dying.sprayCount, 28);
  checkTrue('intensity: dying spray speed is the old constant', Math.abs(dying.spraySpeed - 4.2) < 1e-9);
  checkTrue('intensity: dying spray spread is the old constant', Math.abs(dying.spraySpread - 1.0) < 1e-9);
  check('intensity: dying splatter count is the old constant', dying.splatterCount, 10);
  checkTrue('intensity: dying splatter opacity is the old constant', Math.abs(dying.splatterOpacity - 0.8) < 1e-9);

  const healthy = bloodIntensityForHealth(1);
  check('intensity: a healthy hit barely sprays', healthy.sprayCount, 3);
  check('intensity: and puts nothing on the ground', healthy.splatterCount, 0);
  checkTrue('intensity: healthy droplets are slow', healthy.spraySpeed < dying.spraySpeed);
  checkTrue('intensity: and tightly grouped', healthy.spraySpread < dying.spraySpread);

  // Monotonic across the range, or the mapping would read as noise rather than as "more hurt".
  let monotonic = true;
  let prev = bloodIntensityForHealth(1);
  for (let hp = 0.95; hp >= 0; hp -= 0.05) {
    const cur = bloodIntensityForHealth(hp);
    if (cur.sprayCount < prev.sprayCount || cur.splatterCount < prev.splatterCount
      || cur.spraySpeed < prev.spraySpeed || cur.spraySpread < prev.spraySpread) monotonic = false;
    prev = cur;
  }
  checkTrue('intensity: rises monotonically as health falls', monotonic);

  // Out-of-range and garbage must not produce a negative count or a NaN that poisons a wire field.
  check('intensity: above 1 clamps to healthy', bloodIntensityForHealth(4).sprayCount, 3);
  check('intensity: below 0 clamps to dying', bloodIntensityForHealth(-4).sprayCount, 28);
  check('intensity: NaN is treated as dying, not as NaN', bloodIntensityForHealth(NaN).sprayCount, 28);
  check('intensity: undefined is treated as dying', bloodIntensityForHealth(undefined).sprayCount, 28);
  checkTrue('intensity: every field is finite across the range',
    [0, 0.25, 0.5, 0.75, 1].every((hp) => Object.values(bloodIntensityForHealth(hp)).every(Number.isFinite)));
}

// ---------------------------------------------------------------------------------------
// 2. Per-kind instance counts. Every case below is hash-independent by construction.
// ---------------------------------------------------------------------------------------
const explosion = (id) => ({ id, type: 'effect', kind: 'explosion', p: [0, 10, 0], color: [1, 0.6, 0.2], radius: 6, life: 2 });
const muzzle = (id) => ({ id, type: 'effect', kind: 'muzzle_flash', p: [0, 1, 0], dir: [0, 0, 1], color: [1, 0.9, 0.6], life: 0.5 });
const tracer = (id) => ({ id, type: 'effect', kind: 'gun_tracer', p: [0, 0, 0], p1: [0, 0, 100], color: [1, 1, 0.8], life: 0.2 });
const puff = (id, p = [0, 2, 0]) => ({ id, type: 'effect', kind: 'smoke_puff', p, color: [0.4, 0.4, 0.4], life: 0.5 });
const spark = (id) => ({ id, type: 'effect', kind: 'hit_spark', p: [0, 1, 0], normal: [0, 1, 0], color: [1, 0.8, 0.4], surface: 'terrain', life: 0.6 });

{
  // explosion at t=0: 1 fireball core + 5 body puffs = 6 glow; smoke is staggered so none yet.
  const { fx, glow, smoke } = makeHarness();
  fx.sync([explosion('e1')], 0);
  check('explosion t=0: glow instances', glow.geometry.instanceCount, 6);
  check('explosion t=0: smoke instances', smoke.geometry.instanceCount, 0);
  checkTrue('explosion t=0: glow mesh visible', glow.visible === true);
}
{
  // explosion at t=0.6: cores/bodies are gone, all 10 smoke puffs have been born and none expired.
  const { fx, glow, smoke } = makeHarness();
  fx.sync([explosion('e1')], 0);
  fx.sync([explosion('e1')], 600);
  check('explosion t=0.6: glow instances', glow.geometry.instanceCount, 0);
  check('explosion t=0.6: smoke instances', smoke.geometry.instanceCount, 10);
}
{
  // muzzle flash: 1 glow at t=0 (flash only, smoke alpha still 0), 2 smoke wisps at t=0.1.
  const { fx, glow, smoke } = makeHarness();
  fx.sync([muzzle('m1')], 0);
  check('muzzle t=0: glow instances', glow.geometry.instanceCount, 1);
  check('muzzle t=0: smoke instances', smoke.geometry.instanceCount, 0);
  fx.sync([muzzle('m1')], 100);
  check('muzzle t=0.1: glow instances', glow.geometry.instanceCount, 0);
  check('muzzle t=0.1: smoke instances', smoke.geometry.instanceCount, 2);
}
{
  // tracer: 1.2 m streak sampled every width*3 -> 11 glow beads along the core, no smoke.
  const { fx, glow, smoke } = makeHarness();
  fx.sync([tracer('t1')], 0);
  check('tracer t=0: glow instances (head short of min distance)', glow.geometry.instanceCount, 0);
  fx.sync([tracer('t1')], 20);
  check('tracer t=0.02: glow instances', glow.geometry.instanceCount, 11);
  check('tracer t=0.02: smoke instances', smoke.geometry.instanceCount, 0);
}
{
  // smoke_puff: exactly one smoke instance per live puff entity, zero glow.
  const { fx, glow, smoke } = makeHarness();
  fx.sync([puff('s1'), puff('s2'), puff('s3')], 0);
  fx.sync([puff('s1'), puff('s2'), puff('s3')], 20);
  check('smoke_puff x3: smoke instances', smoke.geometry.instanceCount, 3);
  check('smoke_puff x3: glow instances', glow.geometry.instanceCount, 0);
}
{
  // hit_spark on terrain: rays are lines; the lingering dust is one smoke instance once it fades in.
  const { fx, glow, smoke } = makeHarness();
  fx.sync([spark('h1')], 0);
  check('hit_spark t=0: smoke instances', smoke.geometry.instanceCount, 0);
  fx.sync([spark('h1')], 100);
  check('hit_spark t=0.1: smoke instances', smoke.geometry.instanceCount, 1);
  check('hit_spark t=0.1: glow instances', glow.geometry.instanceCount, 0);
  // flesh hits get no dust puff at all
  const { fx: fx2, smoke: smoke2 } = makeHarness();
  const flesh = { ...spark('h2'), surface: 'flesh' };
  fx2.sync([flesh], 0);
  fx2.sync([flesh], 100);
  check('hit_spark flesh: smoke instances', smoke2.geometry.instanceCount, 0);
}

// ---------------------------------------------------------------------------------------
// 3. Pool caps.
// ---------------------------------------------------------------------------------------
{
  const { fx, glow, smoke } = makeHarness();
  const blasts = [];
  for (let i = 0; i < 100; i++) blasts.push(explosion(`cap-e${i}`)); // 6 glow each = 600 > 220
  fx.sync(blasts, 0);
  check('cap: glow clamped to GLOW_POOL', glow.geometry.instanceCount, 220);

  const puffs = [];
  for (let i = 0; i < 400; i++) puffs.push(puff(`cap-s${i}`));
  fx.sync(puffs, 0);
  fx.sync(puffs, 20);
  check('cap: smoke clamped to SMOKE_POOL', smoke.geometry.instanceCount, 260);
}

// ---------------------------------------------------------------------------------------
// 4. Empty sync drops both pools to zero and hides the meshes.
// ---------------------------------------------------------------------------------------
{
  const { fx, glow, smoke } = makeHarness();
  fx.sync([explosion('z1'), puff('z2')], 0);
  fx.sync([explosion('z1'), puff('z2')], 600);
  checkTrue('empty-sync precondition: pools populated',
    glow.geometry.instanceCount + smoke.geometry.instanceCount > 0);
  fx.sync([], 700);
  check('empty sync: glow instances', glow.geometry.instanceCount, 0);
  check('empty sync: smoke instances', smoke.geometry.instanceCount, 0);
  checkTrue('empty sync: glow hidden', glow.visible === false);
  checkTrue('empty sync: smoke hidden', smoke.visible === false);
  fx.sync(undefined, 800);
  check('null sync: glow instances', glow.geometry.instanceCount, 0);
  check('null sync: smoke instances', smoke.geometry.instanceCount, 0);
}

// ---------------------------------------------------------------------------------------
// 5. firstSeen sweep: ages are kept inside SEEN_TTL_MS (30 s) and dropped past it, so an id
//    that reappears after the sweep restarts its animation from t=0.
// ---------------------------------------------------------------------------------------
{
  const { fx, glow } = makeHarness();
  fx.sync([explosion('sweep')], 0);
  check('sweep: initial age t=0 draws core+body', glow.geometry.instanceCount, 6);
  fx.sync([explosion('sweep')], 6000); // sweep runs (>5 s) but 6 s < 30 s TTL, so the id is kept
  check('sweep: id retained inside TTL (aged out visually)', glow.geometry.instanceCount, 0);
  fx.sync([], 40000);                  // sweep runs; 40 s > 30 s TTL, so the id is dropped
  fx.sync([explosion('sweep')], 40001);
  check('sweep: id dropped past TTL restarts at t=0', glow.geometry.instanceCount, 6);
}

// ---------------------------------------------------------------------------------------
// 6. Smoke gather is back-to-front once a camera has been observed (normal blending is
//    order-dependent; glow is additive and deliberately unsorted).
// ---------------------------------------------------------------------------------------
{
  const { fx, smoke } = makeHarness();
  const near = puff('near', [0, 2, 5]);
  const mid = puff('mid', [0, 2, 20]);
  const far = puff('far', [0, 2, 60]);
  fx.sync([near, mid, far], 0);
  fx.sync([near, mid, far], 20);
  const zs = () => Array.from(smoke.geometry.getAttribute('instPos').array.slice(0, 9))
    .filter((_, i) => i % 3 === 2).map((z) => Math.round(z)); // puffs carry deterministic jitter
  const z0 = zs();
  checkTrue('sort: emission order without a camera', z0.join() === '5,20,60', `got ${z0.join()}`);

  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 2, 0);
  camera.updateMatrixWorld(true);
  smoke.onBeforeRender(null, null, camera); // the renderer hands us the camera at draw time
  fx.sync([near, mid, far], 40);
  const z1 = zs();
  checkTrue('sort: back-to-front after a camera is seen', z1.join() === '60,20,5', `got ${z1.join()}`);
}

// ---------------------------------------------------------------------------------------
// 7. dispose() removes both pool meshes from the scene.
// ---------------------------------------------------------------------------------------
{
  const { fx, scene } = makeHarness();
  const before = scene.children.length;
  fx.dispose();
  const pools = scene.children.filter((o) => o.isMesh && o.geometry && o.geometry.isInstancedBufferGeometry);
  check('dispose: instanced pools removed', pools.length, 0);
  checkTrue('dispose: scene shrank', scene.children.length < before);
}

console.log(failures === 0 ? '\nAll effect-renderer pool checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
