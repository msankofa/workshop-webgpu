// Which updateBefore nodes does a forest material graph carry when the sun casts shadows (the real page), and of what update type?
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';
import { createTree } from '../../trees.js';
import { createForestPalette } from '../../forest-palette.js';
import { createForestGPU } from '../../forest-gpu.js';
import { bindTreeMaterials } from '../../base-game-forest.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from '../../base-game-tree-species.js';
const scene = new THREE.Scene();
const light = new THREE.DirectionalLight(); light.castShadow = process.argv[2] !== 'noshadow'; scene.add(light);
const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
const r = { library: new THREE.BasicNodeLibrary(), coordinateSystem: THREE.WebGPUCoordinateSystem,
  backend: { coordinateSystem: THREE.WebGPUCoordinateSystem, isWebGPUBackend: true, compatibilityMode: false, utils: { getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }) } },
  mrt: null, getMRT() { return this.mrt; }, getRenderTarget: () => null, getCanvasTarget: () => null, getDrawingBufferSize: v => { v.set(1, 1); return v; }, getRenderObjectFunction: () => null,
  getClearColor: () => new THREE.Color(), toneMapping: 0, outputColorSpace: 'srgb', xr: { isPresenting: false }, shadowMap: { enabled: true, type: THREE.PCFShadowMap }, isRenderer: true, contextNode: context({}), getContext: () => ({}),
  lighting: { createNode: (ls = []) => new THREE.LightsNode().setLights(ls) }, nodes: { getCacheKey: () => '', library: null }, logarithmicDepthBuffer: false, reverseDepthBuffer: false, samples: 0, sortObjects: false,
  info: {}, extensions: { has: () => false }, localClippingEnabled: false, clippingPlanes: [], alpha: true, currentToneMapping: 0, currentColorSpace: 'srgb', getMaxAnisotropy: () => 1,
  hasFeature: () => false, hasCompatibility: () => false, hasInitialized: () => true, isOutputTarget: () => false, getOutputRenderTarget: () => null, getColorBufferType: () => 0, getOutputBufferType: () => 0, getPixelRatio: () => 1,
  computeAsync: async () => {}, getArrayBufferAsync: async attr => new ArrayBuffer(attr.array.byteLength), _nodes: { updateAfter() {} } };
const params = { speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 1), branchLods: [{ sectionStride: 2, segmentScale: 0.67 }], leafCount: 4, leafSize: 1, leafShadowPct: 0.3 };
const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 1 });
const forest = createForestGPU({ renderer: r, camera, palette, heightAt: () => 0, lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 16, billboards: false, progressive: true, shadowLayer: 4, drawMode: 'variants', staticRefresh: true, assumeLimits: true });
forest.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));
const mesh = forest.variantMeshes(0).find(m => m.name === 'forest:v0:branchesL0');
const b = THREE.WebGPUBackend.prototype.createNodeBuilder(mesh, r);
b.scene = scene; b.camera = camera; b.material = mesh.material; b.lightsNode = new THREE.LightsNode().setLights([light]);
b.environmentNode = null; b.fogNode = null; b.clippingContext = null; b.build();
const desc = n => `${n.property ?? ''} ${n.constructor?.type ?? n.constructor?.name} updateType=${n.getUpdateType?.() ?? n.updateType} updateBeforeType=${n.getUpdateBeforeType?.() ?? n.updateBeforeType} updateAfterType=${n.getUpdateAfterType?.() ?? n.updateAfterType}`;
console.log('castShadow', light.castShadow);
console.log('updateBeforeNodes', b.updateBeforeNodes.map(desc));
console.log('updateAfterNodes', b.updateAfterNodes.map(desc));
console.log('object-typed updateNodes', b.updateNodes.filter(n => (n.getUpdateType?.() ?? n.updateType) === 'object').map(desc));
import * as W from 'three/webgpu';
console.log('build has setSharedLightUniforms:', typeof W.setSharedLightUniforms, 'sharing', W.getSharedLightUniforms?.());
for (const n of b.updateNodes.filter(n => (n.getUpdateType?.() ?? n.updateType) === 'object' && /ReferenceNode/.test(n.constructor?.type ?? n.constructor?.name ?? ''))) {
  const u = n.node ?? n;
  console.log('ref', n.property, 'on', n.object?.constructor?.name ?? n.reference?.constructor?.name, 'group', u.groupNode?.name, 'shared', u.groupNode?.shared);
}
