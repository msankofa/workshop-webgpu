// test-wound-mask.mjs — the wound-centre mask's CPU twin, plus the two setWoundStyle APIs.
//
// The mask itself is GPU math; what is testable here is that the CPU twin matches the TSL formula
// (`1 - smoothstep(inner, outer, dist)`) exactly, that it behaves at the edges, and that both decal
// materials expose the same write API and really hold their values. Whether the darkened centre
// LOOKS like a wound is not something Node can answer.
//
// Run: node test-wound-mask.mjs

import * as THREE from 'three/webgpu';

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillStyle: null, fillRect() {}, beginPath() {}, arc() {}, fill() {},
      }),
    }),
  };
}

const { WOUND_DEFAULTS, woundCoreFactor } = await import('./wound-mask.js');
const { createEffectRenderer, makeStainTexture } = await import('./effect-renderer.js');
const { createProjectedDecals } = await import('./projected-decals.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
function checkTrue(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${detail}`}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- 1. defaults are sane for the geometry they describe ----
// The quad spans +/-0.5, so anything at or past ~0.707 is off the corner. An outer radius beyond the
// quad's own half-width would mean the decal never reaches its undarkened colour anywhere.
checkTrue('defaults: inner is inside outer', WOUND_DEFAULTS.inner < WOUND_DEFAULTS.outer);
checkTrue('defaults: outer stays inside the quad half-width', WOUND_DEFAULTS.outer < 0.5);
checkTrue('defaults: darken actually darkens', WOUND_DEFAULTS.darken > 0 && WOUND_DEFAULTS.darken < 1);

// ---- 2. the curve ----
check('curve: dead centre is fully the core', woundCoreFactor(0), 1);
check('curve: at the inner radius it is still fully core', woundCoreFactor(WOUND_DEFAULTS.inner), 1);
check('curve: at the outer radius it is gone', woundCoreFactor(WOUND_DEFAULTS.outer), 0);
check('curve: past the outer radius it stays gone', woundCoreFactor(1.0), 0);
check('curve: inside the inner radius clamps rather than exceeding 1', woundCoreFactor(-5), 1);

{
  // Matches the TSL formula it mirrors. smoothstep is t*t*(3-2t) with t clamped to [0,1]; at the
  // midpoint of the band that is exactly 0.5, so the factor is exactly 0.5 too.
  const mid = (WOUND_DEFAULTS.inner + WOUND_DEFAULTS.outer) / 2;
  checkTrue('curve: the band midpoint is exactly half', near(woundCoreFactor(mid), 0.5),
    `got ${woundCoreFactor(mid)}`);
  const manual = (d, i, o) => {
    const t = Math.max(0, Math.min(1, (d - i) / (o - i)));
    return 1 - t * t * (3 - 2 * t);
  };
  let worst = 0;
  for (let d = 0; d <= 0.8; d += 0.001) {
    worst = Math.max(worst, Math.abs(woundCoreFactor(d) - manual(d, WOUND_DEFAULTS.inner, WOUND_DEFAULTS.outer)));
  }
  checkTrue('curve: matches 1 - smoothstep(inner, outer, d) across the whole quad', worst < 1e-12,
    `worst ${worst}`);
}

{
  // Monotonic: a decal that got lighter then darker again as you moved outward would read as a ring.
  let monotonic = true, prev = woundCoreFactor(0);
  for (let d = 0.005; d <= 0.8; d += 0.005) {
    const cur = woundCoreFactor(d);
    if (cur > prev + 1e-12) monotonic = false;
    prev = cur;
  }
  checkTrue('curve: never increases with distance', monotonic);
}

// Degenerate and garbage inputs. A zero-width band is undefined for GLSL/WGSL smoothstep, so the
// twin has to pick a reading and the materials must never be handed one.
check('curve: a zero-width band is a hard step, inside it', woundCoreFactor(0.1, 0.2, 0.2), 1);
check('curve: a zero-width band is a hard step, on the edge', woundCoreFactor(0.2, 0.2, 0.2), 1);
check('curve: a zero-width band is a hard step, outside it', woundCoreFactor(0.3, 0.2, 0.2), 0);
check('curve: an inverted band does not produce a negative factor', woundCoreFactor(0.5, 0.4, 0.1), 0);
check('curve: NaN distance is treated as the centre', woundCoreFactor(NaN), 1);
checkTrue('curve: every sample is finite',
  [0, 0.1, 0.3, 0.5, 0.707, 2].every((d) => Number.isFinite(woundCoreFactor(d))));

// ---- 3. both materials expose the same write API and hold their values ----
function scene() {
  const children = [];
  return { children, add(o) { children.push(o); }, remove(o) { const i = children.indexOf(o); if (i >= 0) children.splice(i, 1); } };
}
{
  const fx = createEffectRenderer({ THREE, scene: scene(), terrainHeight: () => 0 });
  const applied = fx.setWoundStyle({ inner: 0.11, outer: 0.33, darken: 0.4 });
  checkTrue('api: effect-renderer holds what it was given',
    near(applied.inner, 0.11) && near(applied.outer, 0.33) && near(applied.darken, 0.4),
    JSON.stringify(applied));
  const partial = fx.setWoundStyle({ darken: 0.9 });
  checkTrue('api: an omitted field is left alone', near(partial.inner, 0.11) && near(partial.darken, 0.9));
  const junk = fx.setWoundStyle({ inner: NaN, outer: undefined, darken: 'red' });
  checkTrue('api: garbage is ignored rather than written',
    near(junk.inner, 0.11) && near(junk.outer, 0.33) && near(junk.darken, 0.9), JSON.stringify(junk));
  checkTrue('api: an empty call is a no-op', near(fx.setWoundStyle().inner, 0.11));

  // The uniforms live outside makeDecalPool specifically so a resize does not reset them.
  fx.setBloodDecalCap(128);
  checkTrue('api: a pool resize keeps the tuned wound style',
    near(fx.setWoundStyle().darken, 0.9), JSON.stringify(fx.setWoundStyle()));
}
{
  const s = scene();
  const pool = createProjectedDecals({ THREE, scene: s, decalTexture: makeStainTexture(THREE), cap: 4 });
  const applied = pool.setWoundStyle({ inner: 0.11, outer: 0.33, darken: 0.4 });
  checkTrue('api: projected-decals exposes the identical API',
    near(applied.inner, 0.11) && near(applied.outer, 0.33) && near(applied.darken, 0.4),
    JSON.stringify(applied));
  checkTrue('api: and ignores garbage the same way',
    near(pool.setWoundStyle({ inner: NaN }).inner, 0.11));
  pool.dispose();
}

// Both materials must start from the SAME defaults, or the two stain modes would look different
// before anything touches a slider.
{
  const fx = createEffectRenderer({ THREE, scene: scene(), terrainHeight: () => 0 });
  const s = scene();
  const pool = createProjectedDecals({ THREE, scene: s, decalTexture: makeStainTexture(THREE), cap: 4 });
  const a = fx.setWoundStyle(), b = pool.setWoundStyle();
  checkTrue('api: fitted and projected start from identical defaults',
    near(a.inner, b.inner) && near(a.outer, b.outer) && near(a.darken, b.darken),
    `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  checkTrue('api: and those are the shared module defaults',
    near(a.inner, WOUND_DEFAULTS.inner) && near(a.darken, WOUND_DEFAULTS.darken));
  pool.dispose();
}

// ---- 4. the wound centre is PER INSTANCE, not per material ----
// A stain and its ground splatter are one instanced draw sharing one material, so a uniform-only
// wound centre darkened both. A droplet thrown onto the ground is not a puncture and must stay flat.
{
  const decalPoolOf = (s) =>
    s.children.find((o) => o.isMesh && o.geometry?.isInstancedBufferGeometry && o.geometry.getAttribute('instTan'));
  const AGED = 1000;
  const settle = (fx, wire) => { fx.sync([wire], 0); fx.sync([wire], AGED); };

  const s1 = scene();
  const fx1 = createEffectRenderer({ THREE, scene: s1, terrainHeight: () => 0 });
  settle(fx1, { id: 'w1', type: 'effect', kind: 'blood_stain', p: [0, 1, 0], normal: [0, 1, 0],
    color: [0.4, 0.02, 0.03], life: 6, size: 0.1, opacity: 1 });
  const stainGeo = decalPoolOf(s1).geometry;
  check('instance: a stain draws one decal', stainGeo.instanceCount, 1);
  check('instance: and it IS a wound', stainGeo.getAttribute('instWound').array[0], 1);

  const s2 = scene();
  const fx2 = createEffectRenderer({ THREE, scene: s2, terrainHeight: () => 0 });
  settle(fx2, { id: 'w2', type: 'effect', kind: 'blood_splatter', p: [0, 2, 0], normal: [0, 1, 0],
    color: [0.4, 0.02, 0.03], life: 8, count: 6, size: 0.12, opacity: 1,
    spread: 1, speed: 4.2, gravity: 9.8 });
  const splatGeo = decalPoolOf(s2).geometry;
  const n = splatGeo.instanceCount;
  checkTrue('instance: ground splatter draws several decals', n > 1, `got ${n}`);
  const flags = Array.from(splatGeo.getAttribute('instWound').array.slice(0, n));
  checkTrue('instance: and NONE of them is a wound', flags.every((v) => v === 0), `got ${flags}`);
}

console.log(failures === 0 ? '\nAll wound-mask checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
