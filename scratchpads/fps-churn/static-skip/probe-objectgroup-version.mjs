// Are the uniform GROUP nodes in `builder.updateNodes`, and does the object group's version really
// rise once per object?
//
// Why this probe exists. Grepping the r184 bundle for callers of `UniformGroupNode.update()`
// (vendor/three-0.184/three.webgpu.js:5266) finds none, and grepping for `groupNode.build(` finds
// none either. Read that way it looks as if `objectGroup.version` stays 0 forever, `updateGroup`
// (:54280) returns true exactly once per (groupNode, uniformsGroup) pair, and every object uniform
// buffer is therefore written once and then frozen -- which would be an r184 regression and would
// change the whole static-skip design. It is not what happens. The group nodes ARE built into the
// graph, so `NodeBuilder.buildUpdateNodes` (:50423-50455) picks them up by their update type and
// `Nodes.updateForRender` (:55110) feeds them to `NodeFrame.updateNode` per object (:53211, OBJECT
// never dedupes). This builds a real material with the shipped builder and shows it.
//
// node scratchpads/fps-churn/static-skip/probe-objectgroup-version.mjs

import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';
import NodeFrame from 'three/src/nodes/core/NodeFrame.js';
import NodeManager from 'three/src/renderers/common/nodes/NodeManager.js';
import ChainMap from 'three/src/renderers/common/ChainMap.js';

const scene = new THREE.Scene();
const light = new THREE.DirectionalLight(); scene.add(light);
const camera = new THREE.PerspectiveCamera();
const material = new THREE.MeshStandardNodeMaterial();
const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);

const renderer = {
  library: new THREE.BasicNodeLibrary(), coordinateSystem: THREE.WebGPUCoordinateSystem,
  backend: { coordinateSystem: THREE.WebGPUCoordinateSystem, isWebGPUBackend: true, compatibilityMode: false,
    utils: { getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }) } },
  getMRT: () => null, getRenderTarget: () => null, getCanvasTarget: () => null,
  getDrawingBufferSize: v => { v.set(1, 1); return v; }, getRenderObjectFunction: () => null,
  getClearColor: () => new THREE.Color(), toneMapping: 0, outputColorSpace: 'srgb', xr: { isPresenting: false },
  shadowMap: { enabled: true, type: THREE.PCFShadowMap }, isRenderer: true, contextNode: context({}), getContext: () => ({}),
  lighting: { createNode: (ls = []) => new THREE.LightsNode().setLights(ls) },
  nodes: { getCacheKey: () => '', library: null },
  logarithmicDepthBuffer: false, reverseDepthBuffer: false, samples: 0, sortObjects: false,
  info: {}, extensions: { has: () => false }, localClippingEnabled: false, clippingPlanes: [], alpha: true,
  currentToneMapping: 0, currentColorSpace: 'srgb', getMaxAnisotropy: () => 1, hasFeature: () => false,
  hasCompatibility: () => false, hasInitialized: () => true, isOutputTarget: () => false,
  getOutputRenderTarget: () => null, getColorBufferType: () => 0, getOutputBufferType: () => 0, getPixelRatio: () => 1,
};

const b = THREE.WebGPUBackend.prototype.createNodeBuilder(mesh, renderer);
b.scene = scene; b.camera = camera; b.material = material;
b.lightsNode = new THREE.LightsNode().setLights([light]);
b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
b.build();

const groups = b.updateNodes.filter(n => n.isUniformGroup);
console.log(`updateNodes: ${b.updateNodes.length} entries`);
console.log('uniform GROUP nodes among them:',
  groups.map(g => `${g.name}[${g.getUpdateType()}] v=${g.version}`).join(', ') || '(none)');

// Exactly what Nodes.updateForRender does, three times, as if for three render objects in one render.
const frame = new NodeFrame();
for (let i = 0; i < 3; i++) for (const n of b.updateNodes) if (n.isUniformGroup) frame.updateNode(n);
console.log('after three objects in one render:', groups.map(g => `${g.name} v=${g.version}`).join(', '));

// And what Bindings._update then asks.
const nm = Object.create(NodeManager.prototype);
nm.groupsData = new ChainMap();
const objectGroupNode = groups.find(g => g.name === 'object');
const binding = { groupNode: objectGroupNode };
console.log('updateGroup right now:', nm.updateGroup(binding));
console.log('updateGroup again, no update in between:', nm.updateGroup(binding));
frame.updateNode(objectGroupNode);
console.log('updateGroup after one more object update:', nm.updateGroup(binding));

console.log(`
Expected: object[object] rises 1 per object; render[render] stays put within one renderId;
updateGroup is true after each object update and false when asked twice in a row.`);
