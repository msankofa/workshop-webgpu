// Headless WGSL build of grass-compute.js's cull kernel and blade material, with the same injected
// samplers base-game-flora builds. node scratchpads/grass-investigation/wgsl-build.mjs
import { writeFileSync } from 'node:fs';
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {} }) }) };
const THREE = await import('three/webgpu');
const { context } = await import('three/tsl');
const { createComputeGrass } = await import('../../grass-compute.js');
const { createBaseGameFlora } = await import('../../base-game-flora.js');
const { createBaseGameTerrain } = await import('../../base-game-terrain.js');
const { createWorldQueryService } = await import('../../world-query.js');
const { createWorldCoordinateSpace } = await import('../../world-coordinates.js');
const { analyticDescriptor } = await import('../../terrain-source-analytic.js');
const { placeholderStreamedSplatTextures, createStreamedSplatMaterial } = await import('../../terrain-splat-streamed.js');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
const light = new THREE.DirectionalLight(); scene.add(light);
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
  computeAsync: async () => {},
};

const worldQuery = createWorldQueryService();
const worldCoordinates = createWorldCoordinateSpace();
const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates,
  source: analyticDescriptor({ key: 'wgsl', seaLevel: 0 }), useWorker: false });
terrain.setActive(true);
const tex = placeholderStreamedSplatTextures();
for (const l of Object.values(tex.layers)) { l.color.minFilter = THREE.LinearMipmapLinearFilter; l.color.magFilter = THREE.LinearFilter; l.color.generateMipmaps = true; l.color.colorSpace = THREE.SRGBColorSpace; }
terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
const flora = createBaseGameFlora({ scene, renderer, camera, terrain, worldCoordinates });
flora.setEnabled(true);
for (let i = 0; i < 60; i++) { terrain.update([0, 0, 0], 1 / 60); terrain.fieldScheduler.pump(); }
await flora.load();
const ok = await flora.update(0.016);
console.log('flora built', ok, 'ground tint available', flora.stats.groundTint?.available, 'samples textures', terrain.groundColorSamplesTextures);
const grass = flora.grass;

// Compute kernel. Renderer.compute() builds these through Nodes.getForCompute: a WGSLNodeBuilder
// over the compute node, then .build().
const cullNode = grass.mesh.userData.cull ?? null;
function buildCompute(node, label) {
  const b = THREE.WebGPUBackend.prototype.createNodeBuilder(node, renderer);
  b.build();
  const src = b.computeShader;
  writeFileSync(new URL(`./wgsl-${label}.wgsl`, import.meta.url), src);
  return src;
}
// grass-compute does not export its kernels; reach them via the awaited computeAsync call.
let kernels = null;
renderer.computeAsync = async nodes => { kernels = nodes; };
grass.forceRecull();
await grass.update(0.02);
console.log('kernels captured', kernels?.length);
const names = ['reset', 'cull', 'finalize'];
const wgsl = {};
kernels.forEach((n, i) => { try { wgsl[names[i]] = buildCompute(n, names[i]); console.log(`${names[i]}: ${wgsl[names[i]].length} chars`); } catch (e) { console.log(`${names[i]} FAILED: ${e.message}`); } });

// Render material.
{
  const b = THREE.WebGPUBackend.prototype.createNodeBuilder(grass.mesh, renderer);
  b.scene = scene; b.camera = camera; b.material = grass.mesh.material;
  b.lightsNode = new THREE.LightsNode().setLights([light]);
  b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
  try {
    b.build();
    writeFileSync(new URL('./wgsl-vertex.wgsl', import.meta.url), b.vertexShader);
    writeFileSync(new URL('./wgsl-fragment.wgsl', import.meta.url), b.fragmentShader);
    console.log('vertex', b.vertexShader.length, 'fragment', b.fragmentShader.length);
  } catch (e) { console.log('material FAILED:', e.stack.split('\n').slice(0, 6).join('\n')); }
}
const cull = wgsl.cull || '';
console.log('cull: textureSampleLevel calls', (cull.match(/textureSampleLevel/g) || []).length,
  'textureLoad calls', (cull.match(/textureLoad/g) || []).length,
  'atomicAdd', (cull.match(/atomicAdd/g) || []).length);
terrain.dispose();
