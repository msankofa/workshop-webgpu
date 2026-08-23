// test-ground-look.mjs — the ground shading law and its TSL twin.
//
//   node test-ground-look.mjs
//
// The law is what goes wrong here, not the noise: an ordering slip puts snow under rock, a missing
// clamp blows a colour past 1, a centring mistake tints ground that should be untouched. All of that
// is testable in Node. The noise itself is MaterialX fractal noise with no JS equivalent, so it is
// passed in rather than generated — see the header of ground-look.js.

import * as THREE from 'three/webgpu';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, attribute, uniform, vec2, vec3, float, normalize } from 'three/tsl';
import { buildMaterial } from './tsl-build-check.mjs';
import {
  GROUND_LOOK_VERSION, GROUND_LOOK_DEFAULTS, GROUND_LOOK_RANGE,
  groundLookFrom, groundColorRef, createGroundLookNodes,
} from './ground-look.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const cfg = groundLookFrom();
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// The four-colour ramp exactly as demos/flight-sim.html had it before this module existed.
function legacyColor(h, slope) {
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const m = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const sand = [0.60, 0.55, 0.40], grass = [0.24, 0.34, 0.19], rock = [0.34, 0.33, 0.31], snow = [0.86, 0.88, 0.92];
  let c = m(sand, grass, ss(4, 55, h));
  c = m(c, rock, ss(0.30, 0.62, slope));
  return m(c, snow, ss(380, 520, h) * (1 - ss(0.34, 0.62, slope)));
}

console.log('\n1. config');
{
  ok('defaults are frozen', Object.isFrozen(GROUND_LOOK_DEFAULTS));
  ok('groundLookFrom copies the colour arrays', groundLookFrom().sand !== GROUND_LOOK_DEFAULTS.sand);
  const custom = groundLookFrom({ edgeJitter: 5, sand: [1, 0, 0] });
  ok('partials override', custom.edgeJitter === 5 && custom.sand[0] === 1);
  ok('and leave the rest at defaults', custom.grassHi === GROUND_LOOK_DEFAULTS.grassHi);
  ok('a malformed colour falls back rather than corrupting the palette',
    groundLookFrom({ rock: [1, 2] }).rock.length === 3);
  let allRanged = true;
  for (const [k, r] of Object.entries(GROUND_LOOK_RANGE)) {
    if (!(r[0] <= GROUND_LOOK_DEFAULTS[k] && GROUND_LOOK_DEFAULTS[k] <= r[1])) allRanged = false;
  }
  ok('every default sits inside its own slider range', allRanged);
}

console.log('\n2. it is a layer, not a rewrite');
{
  // With every added term at zero the law must be the old ramp. Note strata is excluded by setting
  // its amount, not by zeroing noise: it is driven by height, so "no noise" never silences it —
  // which is exactly the bug this check caught in `enabled: 0`.
  const bare = groundLookFrom({ strataAmount: 0 });
  let worst = 0;
  for (let h = -400; h <= 700; h += 7) {
    for (let s = 0; s <= 1; s += 0.05) {
      const a = groundColorRef(bare, h, s, 0, 0, 0);
      const b = legacyColor(h, s);
      for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    }
  }
  ok('with every term at zero it is the original four-colour ramp', worst < 1e-12, `worst ${worst}`);

  const off = groundLookFrom({ enabled: 0 });
  let worstOff = 0;
  for (let h = -400; h <= 700; h += 11) for (let s = 0; s <= 1; s += 0.1) {
    const a = groundColorRef(off, h, s, 0.9, -0.7, 0.5);   // noise present but disabled
    const b = legacyColor(h, s);
    for (let i = 0; i < 3; i++) worstOff = Math.max(worstOff, Math.abs(a[i] - b[i]));
  }
  ok('disabled ignores the noise entirely', worstOff < 1e-12, `worst ${worstOff}`);
}

console.log('\n3. the law behaves');
{
  let inRange = true, anyNaN = false;
  for (let i = 0; i < 20000; i++) {
    const h = -600 + Math.random() * 1500, s = Math.random();
    const n = () => Math.random() * 2 - 1;
    const c = groundColorRef(cfg, h, s, n(), n(), n());
    for (const v of c) {
      if (!(v >= 0 && v <= 1)) inRange = false;
      if (Number.isNaN(v)) anyNaN = true;
    }
  }
  ok('every colour stays inside [0,1]', inRange);
  ok('no NaN for any input', !anyNaN);

  // Snow is a flat-ground material: a vertical face at altitude must read as rock, not white.
  const cliff = groundColorRef(cfg, 800, 0.95, 0, 0, 0);
  const shelf = groundColorRef(cfg, 800, 0.02, 0, 0, 0);
  ok('high cliffs are rock, high flats are snow', shelf[0] > 0.7 && cliff[0] < 0.5,
    `shelf ${shelf[0].toFixed(2)} cliff ${cliff[0].toFixed(2)}`);

  // The whole point of edgeJitter: the same altitude reads differently in different places.
  const lo = groundColorRef(cfg, 430, 0.05, -1, 0, 0);
  const hi = groundColorRef(cfg, 430, 0.05, 1, 0, 0);
  ok('the snowline wanders with the noise', Math.abs(hi[0] - lo[0]) > 0.15,
    `${lo[0].toFixed(2)} vs ${hi[0].toFixed(2)}`);
  const flat = groundLookFrom({ edgeJitter: 0, slopeJitter: 0 });
  ok('and stops wandering when the jitter is zero',
    near(groundColorRef(flat, 430, 0.05, -1, 0, 0)[0], groundColorRef(flat, 430, 0.05, 1, 0, 0)[0]));

  // Strata are a rock feature; striping a meadow would be worse than no strata at all.
  let flatBand = 0;
  for (let h = 100; h < 140; h += 0.5) {
    const c = groundColorRef(cfg, h, 0.0, 0, 0, 0);
    flatBand = Math.max(flatBand, Math.abs(c[1] - groundColorRef(cfg, 100, 0.0, 0, 0, 0)[1]));
  }
  ok('flat ground is not striped', flatBand < 0.02, `${flatBand.toFixed(3)}`);
  let rockBand = 0;
  for (let h = 100; h < 140; h += 0.5) {
    const c = groundColorRef(cfg, h, 1.0, 0, 0, 0);
    rockBand = Math.max(rockBand, Math.abs(c[1] - groundColorRef(cfg, 100, 1.0, 0, 0, 0)[1]));
  }
  ok('rock faces are banded', rockBand > 0.01, `${rockBand.toFixed(3)}`);

  ok('tint pulls toward dry, not away', (() => {
    const none = groundColorRef(cfg, 200, 0, 0, -1, 0);
    const full = groundColorRef(cfg, 200, 0, 0, 1, 0);
    const toDry = (c) => Math.abs(c[0] - cfg.dry[0]);
    return toDry(full) < toDry(none);
  })());
}

console.log('\n4. the TSL twin builds');
{
  const nodes = await createGroundLookNodes(cfg);
  ok('nodes expose live uniforms', typeof nodes.color === 'function' && nodes.uniforms.edgeJitter);

  nodes.set({ edgeJitter: 12.5, strataPeriod: 20 });
  ok('set() retunes without rebuilding',
    nodes.uniforms.edgeJitter.value === 12.5 && nodes.uniforms.strataPeriod.value === 20);
  nodes.set({ sand: [1, 1, 1] });
  ok('set() leaves colour uniforms alone (they are graph shape)',
    typeof nodes.uniforms.sand.value !== 'number');

  const aPos = attribute('position', 'vec3');
  const uCenter = uniform(new THREE.Vector2());
  const world = Fn(() => vec3(aPos.x.add(uCenter.x), aPos.y.mul(300), aPos.z.add(uCenter.y)))();
  const mat = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  mat.positionNode = world;
  mat.normalNode = normalize(vec3(0.1, 1, 0.2));
  mat.colorNode = nodes.color(world, float(0.8));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));

  let built = null, err = null;
  try { built = await buildMaterial(mat, geo); } catch (e) { err = e; }
  ok('the ground-look material compiles', built != null && !err, err ? err.message : '');

  const off = await createGroundLookNodes(groundLookFrom({ enabled: 0 }));
  let builtOff = null, errOff = null;
  const mat2 = new MeshStandardNodeMaterial();
  mat2.positionNode = world;
  mat2.colorNode = off.color(world, float(0.8));
  try { builtOff = await buildMaterial(mat2, geo); } catch (e) { errOff = e; }
  ok('and so does the disabled variant', builtOff != null && !errOff, errOff ? errOff.message : '');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
