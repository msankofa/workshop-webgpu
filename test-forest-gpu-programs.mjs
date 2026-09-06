// The forest's node materials must produce the SAME WGSL across variants: the WebGPU renderer's
// Pipelines cache programs by shader source (Pipelines.js `programs.vertex.get(vertexShader)`), so
// a per-variant constant in the graph is one full compile per variant per material role.
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';
import { createTree } from './trees.js';
import { createForestPalette } from './forest-palette.js';
import { createForestGPU } from './forest-gpu.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from './base-game-tree-species.js';

// Enough renderer for WGSLNodeBuilder to emit source; nothing is uploaded or compiled.
function buildWGSL(mesh) {
  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight(); scene.add(light); scene.add(mesh);
  const renderer = {
    library: new THREE.BasicNodeLibrary(),
    coordinateSystem: THREE.WebGPUCoordinateSystem,
    backend: { coordinateSystem: THREE.WebGPUCoordinateSystem, isWebGPUBackend: true, compatibilityMode: false,
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) } },
    getMRT: () => null, getRenderTarget: () => null, getCanvasTarget: () => null,
    getDrawingBufferSize: v => v.set(1, 1), getRenderObjectFunction: () => null,
    getClearColor: () => new THREE.Color(), toneMapping: 0, outputColorSpace: 'srgb', xr: { isPresenting: false },
    shadowMap: { enabled: true, type: THREE.PCFShadowMap }, isRenderer: true, contextNode: context({}), getContext: () => ({}),
    lighting: { createNode: (ls = []) => new THREE.LightsNode().setLights(ls) },
    nodes: { getCacheKey: () => '', library: null },
    logarithmicDepthBuffer: false, reverseDepthBuffer: false, samples: 0, sortObjects: false,
    info: {}, extensions: { has: () => false }, localClippingEnabled: false, clippingPlanes: [], alpha: true,
    currentToneMapping: 0, currentColorSpace: 'srgb', getMaxAnisotropy: () => 1,
    hasFeature: () => false, hasCompatibility: () => false, hasInitialized: () => true, isOutputTarget: () => false,
    getOutputRenderTarget: () => null, getColorBufferType: () => 0, getOutputBufferType: () => 0, getPixelRatio: () => 1,
  };
  const builder = new THREE.WebGPUBackend({}).createNodeBuilder(mesh, renderer);
  builder.scene = scene; builder.camera = new THREE.PerspectiveCamera(); builder.material = mesh.material;
  builder.lightsNode = new THREE.LightsNode().setLights([light]);
  builder.environmentNode = null; builder.fogNode = null; builder.clippingContext = null;
  builder.build();
  return builder.vertexShader + '\n' + builder.fragmentShader;
}

const params = {
  speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 2),
  branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
  leafCount: 4, leafSize: 1, leafShadowPct: 0.3,
};
const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 2 });
const forest = createForestGPU({
  renderer: { computeAsync: async () => {} }, camera: new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000),
  palette, heightAt: () => 0, lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 16,
  billboards: false, progressive: true, shadowLayer: 5,
});
const V = palette.variants.length;
const roles = new Map();   // mesh role -> Set of WGSL sources across variants
for (let g = 0; g < V; g++) {
  for (const mesh of forest.variantMeshes(g)) {
    const role = mesh.name.replace(/^forest:v\d+:/, '');
    if (!roles.has(role)) roles.set(role, new Set());
    roles.get(role).add(buildWGSL(mesh));
  }
}
const distinct = [...roles.values()].reduce((n, s) => n + s.size, 0);
// One material object per role for the whole forest (billboards excepted; not built here).
const materials = new Set();
for (let g = 0; g < V; g++) for (const mesh of forest.variantMeshes(g)) materials.add(mesh.material);
assert.equal(materials.size, 8, `${materials.size} distinct materials across ${V} variants, expected 8`);
assert.equal(forest.materials.length, 8);
for (let g = 0; g < V; g++) {
  for (const mesh of forest.variantMeshes(g)) assert.equal(typeof mesh.userData.slotOffset, 'number', `${mesh.name} carries its slot offset`);
}
for (const [role, srcs] of roles) assert.equal(srcs.size, 1, `${role}: ${srcs.size} distinct programs across ${V} variants`);
assert.ok(roles.size >= 7, `${roles.size} mesh roles`);
console.log(`${roles.size} mesh roles, ${distinct} distinct WGSL programs, ${materials.size} materials across ${V} variants (per-variant materials gave ${roles.size * V} programs)`);
forest.dispose();
