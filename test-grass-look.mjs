// test-grass-look.mjs — grass-look.js + soil-shade.js: JS twins of the TSL math, the uniform
// setters, and a headless GLSL build of the grass material with every toggle on and off.
import { createGrassLook, coverageKeepRef, curlRef, valueNoise2, GRASS_LOOK_DEFAULTS } from './grass-look.js';
import { createSoilShade, worleyF1F2Ref, SOIL_SHADE_DEFAULTS, soilFor } from './soil-shade.js';
import { buildMaterial } from './tsl-build-check.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ', m); } else { fail++; console.log('FAIL', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// coverage
ok(coverageKeepRef(3, 4, { ...GRASS_LOOK_DEFAULTS, coverage: false }) === 1, 'coverage off keeps every blade');
{
  const o = { ...GRASS_LOOK_DEFAULTS, coverage: true };
  let mono = true, prev = -1;
  for (let c = 0; c <= 1.0001; c += 0.05) {
    let sum = 0, n = 0;
    for (let x = 0; x < 40; x += 1.7) for (let z = 0; z < 40; z += 1.3) { sum += coverageKeepRef(x, z, { ...o, coverageAmount: c }); n++; }
    const mean = sum / n;
    if (mean < prev - 1e-9) mono = false;
    prev = mean;
  }
  ok(mono, 'mean coverage keep rises monotonically with coverageAmount');
  ok(coverageKeepRef(5, 5, { ...o, coverageAmount: 0 }) === 0, 'coverageAmount 0 collapses everything');
  ok(coverageKeepRef(5, 5, { ...o, coverageAmount: 1 }) === 1, 'coverageAmount 1 keeps everything');
  const v = valueNoise2(3.3, 7.7);
  ok(v >= 0 && v <= 1, 'value noise stays in 0..1');
}

// curl
{
  const c0 = curlRef(0.8, 1, 0, 1);
  ok(near(c0.dy, 0, 1e-4) && near(c0.dz, 0, 1e-4), 'zero curl leaves the blade straight');
  const A = Math.PI / 2, c = curlRef(0.8, 1, A, 1);
  ok(near(c.dy, 0.8 * (2 / Math.PI) - 0.8, 1e-4) && near(c.dz, 0.8 * 2 / Math.PI, 1e-4), 'quarter-turn arc lands the tip at (2/pi, 2/pi) of the length');
  const arcLen = Math.hypot(0.8 + c.dy, c.dz);
  ok(arcLen < 0.8, 'a curled blade is shorter end-to-end than its arc length');
}

// worley
{
  let okAll = true;
  for (let i = 0; i < 400; i++) {
    const [f1, f2] = worleyF1F2Ref(Math.sin(i * 12.9) * 50, Math.cos(i * 3.1) * 50);
    if (!(f1 >= 0 && f2 >= f1 && f2 < 2.9)) okAll = false;
  }
  ok(okAll, 'worley F1 <= F2 and both bounded');
}

// setters
{
  const look = createGrassLook();
  ok(look.u.windDir.value === 0 && look.u.curl.value === 0 && look.u.coverage.value === 0, 'every look toggle starts off');
  look.set({ windDir: true, windAngle: 90, coverageSeedX: 4, curlAmount: 1.3, bogus: 9 });
  ok(look.u.windDir.value === 1, 'set(windDir:true) flips the uniform');
  ok(near(look.u.windVec.value.x, 0, 1e-9) && near(look.u.windVec.value.y, 1), 'windAngle 90 points the wind along +z');
  ok(look.u.coverageSeed.value.x === 4 && look.u.curlAmount.value === 1.3, 'seed and amounts land in their uniforms');
  ok(!('bogus' in look.get()), 'unknown keys are ignored');
  const soil = createSoilShade();
  ok(soil.u.cracks.value === 0 && soil.u.moisture.value === 0, 'soil toggles start off');
  soil.set({ cracks: true, seedZ: 7, crackWidth: 0.2 });
  ok(soil.u.cracks.value === 1 && soil.u.seed.value.y === 7 && soil.u.crackWidth.value === 0.2, 'soil set() lands');
  ok(soilFor(null).crackScale === SOIL_SHADE_DEFAULTS.crackScale && soilFor({ crackScale: 2 }).crackScale === 2, 'soilFor merges over defaults');
}

// headless builds
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData() {}, fillRect() {}, drawImage() {},
}) }) };
{
  const { createGrass } = await import('./grass.js');
  for (const on of [false, true]) {
    const g = createGrass({ count: 8, look: { windDir: on, curl: on, translucency: on, rootShade: on, coverage: on } });
    let built = null;
    try { built = await buildMaterial(g.material, g.geometry); } catch (e) { console.log('   ', e.message); }
    ok(built && built.vertex.length > 1000 && built.fragment.length > 1000, `grass material builds with look toggles ${on ? 'on' : 'off'}`);
    if (built) ok(built.vertex.includes('aFace') && built.vertex.includes('aT'), `merged field's aFace/aT reach the vertex shader (${on ? 'on' : 'off'})`);
    // the coverage FBM must sit behind the toggle's branch, not be multiplied out
    if (built) ok(built.vertex.split('if (').length - 1 >= 1, `coverage is branch-gated in the vertex shader (${on ? 'on' : 'off'})`);
    // blades are DoubleSide and a custom normalNode gets no automatic flip, so the arc normal
    // has to carry gl_FrontFacing itself
    if (built) ok(built.fragment.includes('gl_FrontFacing'), `curl normal follows the visible side (${on ? 'on' : 'off'})`);
  }
  const THREE = await import('three/webgpu');
  const TSL = await import('three/tsl');
  const soil = createSoilShade({ moisture: true, cracks: true });
  const mat = new THREE.MeshStandardNodeMaterial();
  const d = soil.nodes.apply({ col: TSL.vec3(0.5), rough: TSL.float(1), worldXZ: TSL.positionWorld.xz, normalWorld: TSL.normalWorld });
  mat.colorNode = d.col; mat.roughnessNode = d.rough; mat.normalNode = TSL.cameraViewMatrix.transformDirection(d.normalWorld);
  let built = null;
  try { built = await buildMaterial(mat, new THREE.PlaneGeometry()); } catch (e) { console.log('   ', e.message); }
  ok(built && built.fragment.length > 1000, 'soil-dressed standard material builds');
  // moisture and cracks each own a branch, so a ground with both off pays a compare, not ~130 hashes
  if (built) ok(built.fragment.split('if (').length - 1 >= 2, 'soil moisture and cracks are each branch-gated');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
