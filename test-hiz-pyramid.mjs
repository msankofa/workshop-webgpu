// test-hiz-pyramid.mjs — the Hi-Z pyramid's CPU helpers, and its GPU kernels built to WGSL headless.
import assert from 'node:assert/strict';
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {} }) }) };
const THREE = await import('three/webgpu');
const { context } = await import('three/tsl');
const { hizLevelSizes, hizReduceCPU, hizPickLevel, hizBias, createHiZ, HIZ_BIAS_FLOOR } = await import('./hiz-pyramid.js');

// Sizes: half-res base, halving with round-up, stopping at 1x1.
assert.deepEqual(hizLevelSizes(1920, 1080, 8).map(s => [s.width, s.height]),
  [[960, 540], [480, 270], [240, 135], [120, 68], [60, 34], [30, 17], [15, 9], [8, 5]]);
assert.deepEqual(hizLevelSizes(3, 2, 8).map(s => [s.width, s.height]), [[2, 1], [1, 1]]);

// Reduction keeps the farthest depth and clamps the odd edge instead of reading past it.
const src = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);   // 3x3
const r = hizReduceCPU(src, 3, 3);
assert.deepEqual([r.width, r.height], [2, 2]);
assert.deepEqual(Array.from(r.data), [5, 6, 8, 9]);
const r2 = hizReduceCPU(r.data, r.width, r.height);
assert.deepEqual(Array.from(r2.data), [9]);

// Level pick: a footprint of n level-0 texels is covered by at most 2x2 texels of the level.
assert.equal(hizPickLevel(1, 8), 0);
assert.equal(hizPickLevel(2, 8), 0);
assert.equal(hizPickLevel(3, 8), 1);
assert.equal(hizPickLevel(4, 8), 1);
assert.equal(hizPickLevel(5, 8), 2);
assert.equal(hizPickLevel(1000, 8), 7, 'never past the last level');
for (let e = 1; e < 600; e++) { const l = hizPickLevel(e, 8); assert.ok(e <= 2 * (1 << l) || l === 7); }

// Bias grows with distance and level, never below the floor.
const b0 = hizBias(10, 0, 1920, Math.tan(0.6), 16 / 9);
assert.ok(b0 > HIZ_BIAS_FLOOR);
assert.ok(Math.abs(hizBias(20, 0, 1920, Math.tan(0.6), 16 / 9) - HIZ_BIAS_FLOOR - 2 * (b0 - HIZ_BIAS_FLOOR)) < 1e-9);
assert.ok(Math.abs(hizBias(10, 3, 1920, Math.tan(0.6), 16 / 9) - HIZ_BIAS_FLOOR - 8 * (b0 - HIZ_BIAS_FLOOR)) < 1e-9);

// GPU chain: builds to WGSL through the backend's node builder with no device.
let captured = null;
const renderer = {
  library: new THREE.BasicNodeLibrary(), coordinateSystem: THREE.WebGPUCoordinateSystem,
  backend: { coordinateSystem: THREE.WebGPUCoordinateSystem, isWebGPUBackend: true, compatibilityMode: false,
    utils: { getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }) } },
  hasFeature: () => true, hasCompatibility: () => false, getMRT: () => null, getRenderTarget: () => null,
  getCanvasTarget: () => null, getDrawingBufferSize: v => { v.set(640, 360); return v; }, getRenderObjectFunction: () => null,
  getClearColor: () => new THREE.Color(), toneMapping: 0, outputColorSpace: 'srgb', xr: { isPresenting: false },
  shadowMap: { enabled: false, type: 0 }, isRenderer: true, contextNode: context({}), getContext: () => ({}),
  lighting: { createNode: (ls = []) => new THREE.LightsNode().setLights(ls) },
  nodes: { getCacheKey: () => '', library: null }, logarithmicDepthBuffer: false, reverseDepthBuffer: false,
  samples: 0, sortObjects: false, info: {}, extensions: { has: () => false }, localClippingEnabled: false,
  clippingPlanes: [], alpha: true, currentToneMapping: 0, currentColorSpace: 'srgb', getMaxAnisotropy: () => 1,
  hasInitialized: () => true, isOutputTarget: () => false, getOutputRenderTarget: () => null,
  getColorBufferType: () => 0, getOutputBufferType: () => 0, getPixelRatio: () => 1,
  computeAsync: async nodes => { captured = Array.isArray(nodes) ? nodes : [nodes]; },
};
const buildCompute = node => { const b = THREE.WebGPUBackend.prototype.createNodeBuilder(node, renderer); b.build(); return b.computeShader; };
const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
camera.updateMatrixWorld();
const depthTexture = new THREE.DepthTexture(640, 360);
const hiz = createHiZ({ renderer, camera, depthTexture, levels: 8 });
assert.equal(await hiz.update(), true);
assert.equal(hiz.stats.levels, 8);
assert.equal(captured.length, 8, 'one dispatch per level in one submit');
assert.deepEqual([hiz.state.levels[0].width, hiz.state.levels[0].height], [320, 180]);
assert.equal(hiz.state.levels[0].texture.format, THREE.RedFormat);
assert.equal(hiz.state.levels[0].texture.type, THREE.FloatType);
const wgsl0 = buildCompute(captured[0]), wgsl1 = buildCompute(captured[1]);
assert.ok(/textureLoad/.test(wgsl0), 'level 0 fetches the pass depth without a sampler');
assert.ok(/textureStore/.test(wgsl0) && /textureStore/.test(wgsl1));
assert.ok((wgsl1.match(/textureLoad/g) || []).length >= 4, 'a reduce reads its 2x2 block');
assert.ok(/max\(/.test(wgsl1), 'a reduce keeps the farthest depth');
assert.equal(hiz.state.revision, 1);
hiz.setEnabled(false);
assert.equal(await hiz.update(), false);
hiz.dispose();
assert.equal(hiz.state.levels.length, 0);
// The shared test builds to WGSL with one binding per bound level, no samplers.
const { createHizSampler } = await import('./hiz-test.js');
{
  const { Fn: F, vec3: V3, float: Fl, instanceIndex: II, storage: St } = await import('three/tsl');
  const h2 = createHiZ({ renderer, camera, depthTexture, levels: 8 }); await h2.update();
  const sampler = createHizSampler(h2.state, { levels: 4 });
  assert.equal(sampler.bound, 4);
  assert.equal(sampler.sync(), true, 'first sync reports a change');
  assert.equal(sampler.sync(), false, 'same revision and camera: no change');
  const out = new THREE.StorageBufferAttribute(new Float32Array(4), 1);
  const kernel = F(() => { St(out, 'float', 4).element(II).assign(Fl(sampler.occluded(V3(0, 0, -5), V3(1, 2, -4)))); })().compute(4);
  const wgsl = buildCompute(kernel);
  assert.equal((wgsl.match(/texture_2d<f32>/g) || []).length, 4, 'four level bindings');
  assert.ok(!/sampler/.test(wgsl), 'no samplers');
  assert.ok((wgsl.match(/textureLoad/g) || []).length >= 16, 'four taps per bound level');
  h2.dispose();
}
console.log('hiz pyramid: sizes, reduction, level pick, bias and WGSL build checks passed');
