// test-grass-wgsl-build.mjs — grass-compute.js's kernels and blade material, built to WGSL headless.
//
// The renderer builds compute nodes and materials through WebGPUBackend.createNodeBuilder, which
// is reachable from Node with a stub renderer. That is enough to prove the graph Base Game hands
// grass-compute compiles to WGSL: the ground-colour path samples the five splat maps in the cull
// (with samplers, not a textureLoad fallback), the view cone is in the kernel, the fragment reads
// the instance record back through a storage buffer, and the ground probe evaluates the same node.
// Bind-time validation is the one thing this cannot exercise.
//
// node test-grass-wgsl-build.mjs [--dump]   (--dump writes the WGSL beside the investigation notes)

import { writeFileSync } from 'node:fs';
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {} }) }) };
const THREE = await import('three/webgpu');
const { context } = await import('three/tsl');
const { createBaseGameFlora } = await import('./base-game-flora.js');
const { createBaseGameTerrain } = await import('./base-game-terrain.js');
const { createWorldQueryService } = await import('./world-query.js');
const { createWorldCoordinateSpace } = await import('./world-coordinates.js');
const { analyticDescriptor } = await import('./terrain-source-analytic.js');
const { placeholderStreamedSplatTextures, createStreamedSplatMaterial } = await import('./terrain-splat-streamed.js');

const dump = process.argv.includes('--dump');
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);
const count = (src, re) => (src.match(re) || []).length;

// The renderer the node builder reads from. Everything here is what WGSLNodeBuilder touches on
// the way to a shader string; nothing submits to a GPU.
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
const light = new THREE.DirectionalLight(); scene.add(light);
let captured = null;
const renderer = {
  library: new THREE.BasicNodeLibrary(),
  coordinateSystem: THREE.WebGPUCoordinateSystem,
  backend: { coordinateSystem: THREE.WebGPUCoordinateSystem, isWebGPUBackend: true, compatibilityMode: false,
    utils: { getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }) } },
  hasFeature: () => true, hasCompatibility: () => false,
  getMRT: () => null, getRenderTarget: () => null, getCanvasTarget: () => null,
  getDrawingBufferSize: v => { v.set(1, 1); return v; }, getRenderObjectFunction: () => null,
  getClearColor: () => new THREE.Color(), toneMapping: 0, outputColorSpace: 'srgb', xr: { isPresenting: false },
  shadowMap: { enabled: false, type: 0 }, isRenderer: true, contextNode: context({}), getContext: () => ({}),
  lighting: { createNode: (ls = []) => new THREE.LightsNode().setLights(ls) },
  nodes: { getCacheKey: () => '', library: null }, logarithmicDepthBuffer: false, reverseDepthBuffer: false,
  samples: 0, sortObjects: false, info: {}, extensions: { has: () => false }, localClippingEnabled: false,
  clippingPlanes: [], alpha: true, currentToneMapping: 0, currentColorSpace: 'srgb', getMaxAnisotropy: () => 1,
  hasInitialized: () => true, isOutputTarget: () => false, getOutputRenderTarget: () => null,
  getColorBufferType: () => 0, getOutputBufferType: () => 0, getPixelRatio: () => 1,
  // Captures what grass-compute submits, so the kernels can be built without being exported.
  computeAsync: async nodes => { captured = Array.isArray(nodes) ? nodes : [nodes]; },
  getArrayBufferAsync: async attr => new ArrayBuffer(attr.array.byteLength),
};
function buildCompute(node) {
  const b = THREE.WebGPUBackend.prototype.createNodeBuilder(node, renderer);
  b.build();
  return b.computeShader;
}
function buildMaterial(mesh) {
  const b = THREE.WebGPUBackend.prototype.createNodeBuilder(mesh, renderer);
  b.scene = scene; b.camera = camera; b.material = mesh.material;
  b.lightsNode = new THREE.LightsNode().setLights([light]);
  b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
  b.build();
  return { vertex: b.vertexShader, fragment: b.fragmentShader };
}
const dumpTo = (name, src) => { if (dump) writeFileSync(new URL(`./scratchpads/grass-investigation/wgsl-${name}.wgsl`, import.meta.url), src); };

section('the flora rig builds grass with the ground colour wired');
const worldQuery = createWorldQueryService();
const worldCoordinates = createWorldCoordinateSpace();
const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates,
  source: analyticDescriptor({ key: 'wgsl', seaLevel: 0 }), useWorker: false, farLod: true });
terrain.setActive(true);
// Placeholder maps are 1x1 nearest DataTextures, which the builder treats as unfilterable and
// reads with textureLoad. The real maps are linear mipmapped sRGB, so make the stand-ins match.
const tex = placeholderStreamedSplatTextures();
for (const l of Object.values(tex.layers)) {
  l.color.minFilter = THREE.LinearMipmapLinearFilter; l.color.magFilter = THREE.LinearFilter;
  l.color.generateMipmaps = true; l.color.colorSpace = THREE.SRGBColorSpace;
}
terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
const flora = createBaseGameFlora({ scene, renderer, camera, terrain, worldCoordinates });
flora.setEnabled(true);
for (let i = 0; i < 60; i++) { terrain.update([0, 0, 0], 1 / 60); terrain.fieldScheduler.pump(); }
await flora.load();
const built = await flora.update(0.016);
check('grass builds over the rig', built === true && flora.built);
check('the ground colour node is injected', flora.stats.groundTint?.available === true);
check('and it samples the textures, not the averages', terrain.groundColorSamplesTextures === true);
check('far blades stand on the drawn rings', flora.stats.heightSource === 'drawn', flora.stats.heightSource);
const grass = flora.grass;

section('the cull kernel compiles to WGSL');
captured = null;
grass.forceRecull();
await grass.update(0.02);
check('a recull submits reset, cull and finalize', captured?.length === 3, `got ${captured?.length}`);
const wgsl = {};
for (const [i, name] of ['reset', 'cull', 'finalize'].entries()) {
  let err = null;
  try { wgsl[name] = buildCompute(captured[i]); dumpTo(name, wgsl[name]); } catch (e) { err = e; }
  check(`${name} builds`, !err, String(err?.message ?? ''));
}
const cull = wgsl.cull ?? '';
check('the cull samples the five splat maps with samplers', count(cull, /textureSampleLevel\(/g) === 5, `${count(cull, /textureSampleLevel\(/g)} calls`);
check('and never with the plain textureSample a compute stage cannot use', count(cull, /textureSample\(/g) === 0);
check('the field windows are read with textureLoad', count(cull, /textureLoad\(/g) > 0);
// Six ring levels, each four wrapped loads plus a morph toward the next: the drawn-height branch
// alone is more loads than the whole field path had (32) before it.
check('the drawn rings are in the kernel too', count(cull, /textureLoad\(/g) > 40, `${count(cull, /textureLoad\(/g)} loads`);
check('as branches, not all evaluated', /if \(/.test(cull));
check('survivors are compacted through one atomic counter', count(cull, /atomicAdd\(/g) === 1);
check('the view cone is in the kernel', /dot\(\s*\(\s*vec2<f32>/.test(cull) || /dot\( vec2<f32>/.test(cull));
check('the occlusion branch is compiled out without an occluder image', count(cull, /uOcc|occlusion/g) === 0 && !/textureSample\(/.test(cull));

section('the blade material compiles to WGSL');
{
  let shaders = null, err = null;
  try { shaders = buildMaterial(grass.mesh); } catch (e) { err = e; }
  check('vertex and fragment build', !!shaders && !err, String(err?.message ?? ''));
  if (shaders) {
    dumpTo('vertex', shaders.vertex); dumpTo('fragment', shaders.fragment);
    check('the fragment reads the instance record from a read-only storage buffer', /var<storage,\s*read>/.test(shaders.fragment));
    check('through a flat instance-index varying', /@interpolate\(\s*flat/.test(shaders.fragment) || /@interpolate\(\s*flat/.test(shaders.vertex));
    check('the vertex stage reads the record too', /var<storage,\s*read>/.test(shaders.vertex));
  }
}

section('the ground probe evaluates the same node');
{
  captured = null;
  const probe = await grass.readGroundProbe(3, 4);
  check('the probe returns rgb and a height', probe && ['r', 'g', 'b', 'y'].every(k => typeof probe[k] === 'number'));
  check('it submits one kernel', captured?.length === 1);
  let src = '', err = null;
  try { src = buildCompute(captured[0]); dumpTo('probe', src); } catch (e) { err = e; }
  check('which builds', !err, String(err?.message ?? ''));
  check('and samples the same five maps', count(src, /textureSampleLevel\(/g) === 5, `${count(src, /textureSampleLevel\(/g)} calls`);
  check('with no atomics or instance writes', count(src, /atomicAdd\(/g) === 0);
}

terrain.dispose();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
