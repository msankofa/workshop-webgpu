// test-forest-object-group.mjs — the per-object contract the static refresh policy leans on, on
// the Base Game's own forest configuration: which nodes write each role's `object` uniform group,
// and whether the allowlist in forest-gpu.js accepts them.
//
// What this proves and what it does not: the shipped WGSLNodeBuilder builds the TSL graph with a
// stub renderer (same harness as test-forest-leaf-shaders.mjs), so this reads the BUILT graph —
// which nodes are object-typed, and what the object group holds. It compiles no WGSL and runs no
// GPU. It says nothing about milliseconds.
//
// node test-forest-object-group.mjs

import * as THREE from 'three/webgpu';
import { context, uniform, vec3 } from 'three/tsl';
import { createTree } from './trees.js';
import { createForestPalette } from './forest-palette.js';
import { createForestGPU, forestGraphVerdict } from './forest-gpu.js';
import { bindTreeMaterials, BASE_GAME_FOREST_DEFAULTS } from './base-game-forest.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from './base-game-tree-species.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

const scene = new THREE.Scene();
const light = new THREE.DirectionalLight(); scene.add(light);
const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
const renderer = {
  library: new THREE.BasicNodeLibrary(),
  coordinateSystem: THREE.WebGPUCoordinateSystem,
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
  currentToneMapping: 0, currentColorSpace: 'srgb', getMaxAnisotropy: () => 1,
  hasFeature: () => false, hasCompatibility: () => false, hasInitialized: () => true, isOutputTarget: () => false,
  getOutputRenderTarget: () => null, getColorBufferType: () => 0, getOutputBufferType: () => 0, getPixelRatio: () => 1,
  computeAsync: async () => {},
  getArrayBufferAsync: async attr => new ArrayBuffer(attr.array.byteLength),
};

function build(mesh) {
  const b = THREE.WebGPUBackend.prototype.createNodeBuilder(mesh, renderer);
  b.scene = scene; b.camera = camera; b.material = mesh.material;
  b.lightsNode = new THREE.LightsNode().setLights([light]);
  b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
  b.build();
  return b;
}

const params = {
  speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 3),
  branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
  leafCount: 4, leafSize: 1, leafShadowPct: 0.3,
};
const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 2 });

// The Base Game's own forest options, read off base-game-forest.js: no billboards, the shadow
// layer named, drawMode 'variants', authored-or-procedural bark through bindTreeMaterials, and
// NO addEmissive — base-game-forest.js does not pass one (environment-viewer.html does).
function makeBaseGameForest(extra = {}) {
  return createForestGPU({
    renderer, camera, palette, heightAt: () => 0,
    lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 16,
    leafSway: BASE_GAME_FOREST_DEFAULTS.treeLeafSway,
    billboards: false, progressive: true, shadowLayer: 4,
    drawMode: BASE_GAME_FOREST_DEFAULTS.forestDrawMode,
    instanceNormalVarying: BASE_GAME_FOREST_DEFAULTS.forestNormalVarying !== false,
    staticRefresh: true, assumeLimits: true, ...extra,
  });
}

const ROLES = ['branchesL0', 'leavesL0', 'shadowL0', 'branchesL1', 'leavesL1',
  'branchesL2', 'coarseLeavesL2', 'barkShadow', 'leafShadow'];

// A NodeBuilderState-shaped view of a built builder: what forestGraphVerdict reads.
const stateOf = b => ({
  updateNodes: b.updateNodes, updateBeforeNodes: b.updateBeforeNodes, updateAfterNodes: b.updateAfterNodes,
});
const nodeLabel = n => `${n.constructor?.type ?? n.constructor?.name}${n.name ? `(${n.name})` : ''}` +
  `${n.property ? `.${n.property}` : ''}${n.scope ? `:${n.scope}` : ''}`;

section('the Base Game forest configuration: the object group of each role');
const forest = makeBaseGameForest();
forest.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));
const meshes = forest.variantMeshes(0);
const built = new Map();
for (const role of ROLES) {
  const mesh = meshes.find(m => m.name === `forest:v0:${role}`);
  if (!mesh) { check(`the ${role} mesh exists`, false); continue; }
  let b = null, err = null;
  try { b = build(mesh); } catch (e) { err = e; }
  check(`${role} builds`, !!b, String(err?.message ?? ''));
  if (b) built.set(role, { builder: b, mesh });
}

console.log('\n  role              object-group uniforms                                          object update nodes');
for (const role of ROLES) {
  const entry = built.get(role);
  if (!entry) continue;
  const group = entry.builder.uniformGroups?.object?.uniforms ?? [];
  const objectNodes = entry.builder.updateNodes.filter(n => (n.getUpdateType?.() ?? n.updateType) === 'object');
  console.log(`  ${role.padEnd(17)} ${group.map(u => `${u.name}:${u.constructor?.name?.replace('NodeUniform', '')}`).join(' ').padEnd(62)} ` +
    `${objectNodes.map(nodeLabel).join(' ')}`);
}

section('every role is on the allowlist, and its graph carries no updateBefore/updateAfter node');
for (const role of ROLES) {
  const entry = built.get(role);
  if (!entry) continue;
  const verdict = forestGraphVerdict(stateOf(entry.builder));
  check(`${role}: the allowlist accepts it`, verdict.ok === true, verdict.reason ?? '');
  check(`${role}: no updateBefore/updateAfter nodes`,
    entry.builder.updateBeforeNodes.length === 0 && entry.builder.updateAfterNodes.length === 0,
    `${entry.builder.updateBeforeNodes.length}/${entry.builder.updateAfterNodes.length}`);
}

section('the object group holds only slot offset, tree/leaf scale, the two matrices and material values');
for (const role of ROLES) {
  const entry = built.get(role);
  if (!entry) continue;
  const group = entry.builder.uniformGroups?.object?.uniforms ?? [];
  const kinds = group.map(u => u.constructor?.name);
  check(`${role}: exactly one mat4 (the model world matrix) in the object group`,
    kinds.filter(k => k === 'Matrix4NodeUniform').length === 1, kinds.join(','));
  check(`${role}: exactly one mat3 (the normal matrix) in the object group`,
    kinds.filter(k => k === 'Matrix3NodeUniform').length === 1, kinds.join(','));
  check(`${role}: no texture or sampler in the object uniform group`,
    kinds.every(k => /NodeUniform$/.test(k ?? '')), kinds.join(','));
}

section('the normal matrix is camera-independent');
{
  // vendor/three-0.184/three.webgpu.js:14622 — modelNormalMatrix is
  //   uniform(new Matrix3()).onObjectUpdate(({object}, self) => self.value.getNormalMatrix(object.matrixWorld))
  // i.e. it reads object.matrixWorld only: no camera, no render context, no pass. The camera
  // enters in the shader body instead (render.cameraViewMatrix * (object.normalMatrix * n)).
  // The camera-dependent alternatives (highpModelNormalViewMatrix, ModelNode:viewPosition) would
  // fail classifyObjectUpdateNode's identity/scope tests, which is the refusal case below.
  const entry = built.get('branchesL0');
  const mat3Nodes = entry.builder.updateNodes.filter(n =>
    (n.getUpdateType?.() ?? n.updateType) === 'object' &&
    (n.constructor?.type ?? n.constructor?.name) === 'UniformNode');
  check('branchesL0: exactly one object-typed plain UniformNode (the normal matrix)', mat3Nodes.length === 1, `${mat3Nodes.length}`);
  const { modelNormalMatrix } = await import('three/tsl');
  check('it is three\'s own modelNormalMatrix singleton, by identity', mat3Nodes[0] === modelNormalMatrix);
  const model = entry.builder.updateNodes.filter(n => (n.constructor?.type ?? n.constructor?.name) === 'ModelNode');
  check('the only ModelNode scope in the graph is worldMatrix', model.length > 0 && model.every(n => n.scope === 'worldMatrix'),
    model.map(n => n.scope).join(','));
}

section('a graph extension that adds a per-object uniform is refused');
{
  // The shape environment-viewer.html's addEmissive would take if the clustered-light term carried
  // per-object state: an onObjectUpdate uniform that is not modelNormalMatrix.
  const injected = makeBaseGameForest({
    addEmissive: () => uniform(vec3(0, 0, 0)).onObjectUpdate(({ object }, self) => {
      self.value.setScalar(object.matrixWorld.elements[13]); return self.value;
    }),
  });
  injected.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));
  const mesh = injected.variantMeshes(0).find(m => m.name === 'forest:v0:branchesL0');
  const b = build(mesh);
  const verdict = forestGraphVerdict(stateOf(b));
  check('the allowlist refuses a graph with an injected onObjectUpdate uniform', verdict.ok === false, verdict.reason ?? 'accepted');
  check('and says which node type refused it', /UniformNode/.test(verdict.reason ?? ''), verdict.reason ?? '');
  injected.dispose();
}

section('a graph with an updateBefore or updateAfter node is refused');
{
  check('updateBefore refuses', forestGraphVerdict({ updateNodes: [], updateBeforeNodes: [{}], updateAfterNodes: [] }).ok === false);
  check('updateAfter refuses', forestGraphVerdict({ updateNodes: [], updateBeforeNodes: [], updateAfterNodes: [{}] }).ok === false);
  check('no builder state refuses', forestGraphVerdict(null).ok === false);
}

forest.dispose();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
