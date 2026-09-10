// test-forest-static-observer.mjs — the forest's own node-material refresh policy
// (createForestGPU({ staticRefresh: true })), driven the way Renderer._renderObjectDirect drives it.
//
// What this proves and what it does not. The materials, the observer and the graph are REAL: they
// come out of the shipped WGSLNodeBuilder with a stub renderer, so `builder.observer` is the object
// three would call. The render objects are fakes shaped like three's (geometry, object, material,
// lightsNode, bundle, getNodeBuilderState, getMonitor) because RenderObject needs a device; the
// base NodeMaterialObserver is driven through its own firstInitialization/getRenderObjectData, so
// its bookkeeping is real. No WGSL is compiled and no GPU runs. Nothing here measures time.
//
// On the clean-mark bookkeeping: needsRefresh returning true is a DECISION taken before the
// renderer does the work, so the policy only marks the render object "pending" there. The clean
// mark is committed from the hook forest-gpu.js installs on renderer._nodes.updateAfter, which
// three calls at three.webgpu.js:61351 only when needsRefresh was true, the pipeline was ready and
// the draw was issued. If the refresh throws, the frame is broken anyway — but the mark stays
// pending, so the next call refreshes again rather than skipping stale state. The same holds when
// a pipeline is not yet ready: no commit, one more refresh next frame.
//
// node test-forest-static-observer.mjs

import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';
import { createTree } from './trees.js';
import { createForestPalette } from './forest-palette.js';
import { createForestGPU } from './forest-gpu.js';
import { bindTreeMaterials } from './base-game-forest.js';
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

// The stub renderer, plus the two pieces the policy actually reaches: getMRT (velocity) and the
// _nodes.updateAfter seam the commit hook wraps.
function makeRenderer() {
  const nodesCalls = [];
  const r = {
    library: new THREE.BasicNodeLibrary(),
    coordinateSystem: THREE.WebGPUCoordinateSystem,
    backend: { coordinateSystem: THREE.WebGPUCoordinateSystem, isWebGPUBackend: true, compatibilityMode: false,
      utils: { getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }) } },
    mrt: null,
    getMRT() { return this.mrt; },
    getRenderTarget: () => null, getCanvasTarget: () => null,
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
    // Three's Nodes.updateAfter walks the render object's updateAfterNodes (empty for the forest).
    _nodes: { updateAfter(renderObject) { nodesCalls.push(renderObject); } },
  };
  r._nodesCalls = nodesCalls;
  return r;
}

const params = {
  speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 2),
  branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
  leafCount: 4, leafSize: 1, leafShadowPct: 0.3,
};
const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 2 });

function makeForest(renderer, extra = {}) {
  const forest = createForestGPU({
    renderer, camera, palette, heightAt: () => 0,
    lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 16,
    billboards: false, progressive: true, shadowLayer: 4, drawMode: 'variants',
    staticRefresh: true, assumeLimits: true, ...extra,
  });
  forest.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));
  return forest;
}

function buildObserver(renderer, mesh) {
  const b = THREE.WebGPUBackend.prototype.createNodeBuilder(mesh, renderer);
  b.scene = scene; b.camera = camera; b.material = mesh.material;
  b.lightsNode = new THREE.LightsNode().setLights([light]);
  b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
  b.build();
  return { observer: b.observer, state: b };
}

// A render object shaped like three's, over a real mesh and a real builder state.
function makeRenderObject(mesh, built, tag = 'main') {
  const lightsNode = new THREE.LightsNode().setLights([light]);
  return {
    tag,
    object: mesh,
    get geometry() { return mesh.geometry; },
    get material() { return mesh.material; },
    bundle: null,
    lightsNode,
    context: { width: 1, height: 1 },
    getNodeBuilderState: () => built.state,
    getMonitor: () => built.observer,
  };
}

// Renderer._renderObjectDirect, reduced to what the policy interacts with (three.webgpu.js:61312).
function renderObjectDirect(renderer, ro, nodeFrame, opts = {}) {
  const needsRefresh = ro.getMonitor().needsRefresh(ro, nodeFrame);
  if (needsRefresh) {
    if (opts.throwOnUpdate) throw new Error('the bindings update blew up');
    (opts.log ?? []).push(ro.tag);
  }
  if (opts.pipelineReady !== false) {
    if (needsRefresh) renderer._nodes.updateAfter(ro);
  }
  return needsRefresh;
}

let RENDER_ID = 0;
const frame = renderer => ({ renderer, renderId: ++RENDER_ID, frameId: RENDER_ID });

// ---------------------------------------------------------------------------------------------
section('two meshes of one material: the decision table');
const renderer = makeRenderer();
const forest = makeForest(renderer);
const branch0 = forest.variantMeshes(0).find(m => m.name === 'forest:v0:branchesL0');
const branch1 = forest.variantMeshes(1).find(m => m.name === 'forest:v1:branchesL0');
check('the two meshes share one material', branch0.material === branch1.material);
check('and carry different slot offsets', branch0.userData.slotOffset !== branch1.userData.slotOffset);
check('both are marked with an epoch', branch0.userData.forestEpoch !== undefined && branch1.userData.forestEpoch !== undefined);

const built = buildObserver(renderer, branch0);
check('the material supplied its own observer', typeof built.observer?.needsRefresh === 'function');
const ro0 = makeRenderObject(branch0, built, 'v0');
const ro1 = makeRenderObject(branch1, built, 'v1');

function render(order = [ro0, ro1], opts = {}) {
  const f = frame(renderer);
  const log = [];
  for (const ro of order) renderObjectDirect(renderer, ro, f, { ...opts, log });
  return log;
}

check('render 1: both refresh (first initialization)', JSON.stringify(render()) === '["v0","v1"]');
check('render 2: only the first of the material refreshes', JSON.stringify(render()) === '["v0"]');
check('render 3: same again', JSON.stringify(render()) === '["v0"]');
check('render 4, order reversed: exactly one refresh, and it is the first one seen',
  JSON.stringify(render([ro1, ro0])) === '["v1"]');
check('render 5, order restored: still exactly one refresh', render().length === 1);

section('an epoch bump refreshes every mesh, once, and does not leave a redundant second refresh');
forest.setTreeScale(1.7);
check('setTreeScale invalidated both meshes', JSON.stringify(render()) === '["v0","v1"]');
check('and the next render is back to one', JSON.stringify(render()) === '["v0"]');
// The first-of-render refresh records the mark too, so reversing the order after an invalidate
// does not make the already-refreshed mesh pay a second time.
forest.setLeafScale(1.4);
check('setLeafScale invalidated both meshes', render([ro1, ro0]).length === 2);
check('and reversing the order again costs one refresh, not two', JSON.stringify(render([ro0, ro1])) === '["v0"]');

section('the setters that write a shared uniform value, guarded on change');
forest.setLeafSway(0.5);
check('setLeafSway with a new value invalidates', render().length === 2);
render();
forest.setLeafSway(0.5);
check('setLeafSway with the same value does not', JSON.stringify(render()) === '["v0"]');
forest.setTreeScale(1.7);
check('setTreeScale with the same value does not', JSON.stringify(render()) === '["v0"]');
forest.setLeafScale(1.4);
check('setLeafScale with the same value does not', JSON.stringify(render()) === '["v0"]');

section('a material value change with an unchanged shader key refreshes the SECOND mesh too');
{
  // roughness is a MaterialReferenceNode read into every mesh's own object UBO. The shader and the
  // cache key do not change, so RenderObjects.get would not recreate anything; the policy must
  // notice on its own. forest-gpu bumps the version through needsUpdate, which is what it tracks.
  render();                                   // settle: v0 refreshes, v1 skips
  const mat = branch0.material;
  const before = mat.version;
  mat.roughness = 0.42;
  mat.needsUpdate = true;                     // what a forest setter writing a material value must do
  check('the material version moved', mat.version !== before);
  const log = render([ro0, ro1]);
  check('the second mesh of the material refreshes on a scalar change', log.includes('v1'), log.join(','));
  check('and settles back to one refresh afterwards', JSON.stringify(render()) === '["v0"]');
}

section('the same mesh in three passes keeps three sets of books');
{
  // RenderObjects.get keys on (object, material, renderContext, lightsNode) plus a passId chain,
  // so the main, shadow and reflection passes hold DIFFERENT render objects for one mesh.
  const main = makeRenderObject(branch0, built, 'main');
  const shadow = makeRenderObject(branch0, built, 'shadow');
  const reflect = makeRenderObject(branch0, built, 'reflect');
  const passes = [main, shadow, reflect];
  for (const ro of passes) { const f = frame(renderer); renderObjectDirect(renderer, ro, f); }   // first init
  const second = passes.map(ro => { const f = frame(renderer); return renderObjectDirect(renderer, ro, f); });
  check('each pass refreshes once per render (its own renderId)', second.every(v => v === true));
  // Within ONE render id, a second render object of the material is the one that may skip.
  const f = frame(renderer);
  const a = renderObjectDirect(renderer, main, f);
  const b = renderObjectDirect(renderer, shadow, f);
  check('inside one render, the first refreshes and the second skips', a === true && b === false);
  forest.setLeafSway(0.9);
  const after = passes.map(ro => { const g = frame(renderer); return renderObjectDirect(renderer, ro, g); });
  check('an invalidate is honoured once in every pass', after.every(v => v === true));
}

section('only the mesh whose geometry changed refreshes');
{
  render(); render();
  const variant = palette.variants[1];
  forest.installVariant(1, variant);           // swaps geometry and uploads the indirect count
  const log = render([ro0, ro1]);
  check('installVariant refreshed the swapped variant', log.includes('v1'), log.join(','));
  render();
  // The unrelated variant is untouched: only v1's meshes carry the new epoch.
  const log2 = render([ro1, ro0]);
  check('and the untouched variant does not refresh a second time', log2.length === 1, log2.join(','));
}

section('a geometry swapped behind the policy is still caught (the backstop)');
{
  render(); render();
  const spare = new THREE.BufferGeometry();
  spare.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  const previous = branch1.geometry;
  branch1.geometry = spare;                    // no invalidate at all
  const log = render([ro0, ro1]);
  check('the geometry id compare refreshes it anyway', log.includes('v1'), log.join(','));
  branch1.geometry = previous;
  render(); render();
}

section('a render-origin rebase moves no forest mesh, so it forces no refresh');
{
  // base-game.html's onRebase moves traversalLab.root, spawnBuilding.root, structures.root and
  // roads.group — not the forest, which sits at the render origin (base-game.html:3725, and the
  // published meshes are handed to matrixWalk.skip). forest.setWorldOrigin only flags a rebuild:
  // the records are re-baked against the new origin on the CPU and uploaded to the SOURCE buffer,
  // which is bound by the cull kernels, and Bindings.updateForCompute is outside the gate.
  render(); render();
  const epochBefore = branch0.userData.forestEpoch;
  const matrixBefore = branch0.matrixWorld.elements.slice();
  forest.setWorldOrigin(4096, 0, -4096);
  check('setWorldOrigin bumped no epoch', branch0.userData.forestEpoch === epochBefore);
  check('and moved no mesh', branch0.matrixWorld.elements.every((v, i) => v === matrixBefore[i]));
  check('so the second mesh still skips', JSON.stringify(render()) === '["v0"]');
  // Correctness over the optimisation: if anything DID move a mesh, the matrix compare catches it.
  branch1.position.set(1, 0, 0);
  branch1.updateMatrixWorld(true);
  const log = render([ro0, ro1]);
  check('a mesh that moves without an invalidate is refreshed by the matrix compare', log.includes('v1'), log.join(','));
  branch1.position.set(0, 0, 0);
  branch1.updateMatrixWorld(true);
  render(); render();
}

section('a refresh whose update throws is retried on the next call');
{
  render(); render();
  forest.setLeafSway(1.3);                                    // both meshes owe a refresh
  const f = frame(renderer);
  renderObjectDirect(renderer, ro0, f);                       // v0 takes its refresh and commits
  let threw = false;
  try { renderObjectDirect(renderer, ro1, f, { throwOnUpdate: true }); } catch { threw = true; }
  check('the driver saw the throw', threw);
  // Nothing committed for v1: its mark is still pending.
  const g = frame(renderer);
  renderObjectDirect(renderer, ro0, g);
  check('the next call for that render object refreshes again', renderObjectDirect(renderer, ro1, g) === true);
  check('and once it completes, it skips again', (() => {
    const h = frame(renderer);
    renderObjectDirect(renderer, ro0, h);
    return renderObjectDirect(renderer, ro1, h) === false;
  })());
}

section('a refresh whose pipeline was not ready is retried too');
{
  render(); render();
  forest.setLeafSway(1.6);                                         // both meshes owe a refresh
  const f = frame(renderer);
  renderObjectDirect(renderer, ro0, f);
  renderObjectDirect(renderer, ro1, f, { pipelineReady: false });   // no updateAfter, no commit
  const g = frame(renderer);
  renderObjectDirect(renderer, ro0, g);
  check('it refreshes again', renderObjectDirect(renderer, ro1, g) === true);
  render(); render();
}

section('a velocity MRT stops every skip');
{
  render(); render();
  renderer.mrt = { has: name => name === 'velocity' };
  const f = frame(renderer);
  check('the first refreshes', renderObjectDirect(renderer, ro0, f) === true);
  check('and so does the second', renderObjectDirect(renderer, ro1, f) === true);
  renderer.mrt = null;
  render(); render();
}

section('the stats say what the policy did');
{
  const s = forest.staticRefreshStats;
  check('the policy reports itself enabled', s.enabled === true);
  check('it counted skipped refreshes', s.skipped > 0, String(s.skipped));
  check('it counted the refreshes it allowed', s.refreshed > 0, String(s.refreshed));
  check('nothing on the Base Game graph was refused', Object.keys(s.refused).length === 0, JSON.stringify(s.refused));
  check('forest.stats carries the same block', forest.stats.staticRefresh.enabled === true);
}

// ---------------------------------------------------------------------------------------------
section('with the flag off, every call is three\'s own answer');
{
  const r2 = makeRenderer();
  const off = makeForest(r2, { staticRefresh: false });
  const mesh = off.variantMeshes(0).find(m => m.name === 'forest:v0:branchesL0');
  const other = off.variantMeshes(1).find(m => m.name === 'forest:v1:branchesL0');
  const b2 = buildObserver(r2, mesh);
  const a = makeRenderObject(mesh, b2, 'a');
  const c = makeRenderObject(other, b2, 'b');
  let delegated = 0;
  // The base observer is behind the policy: with the flag off, count that every call reaches it.
  const observer = b2.observer;
  const original = observer.needsRefresh.bind(observer);
  let answers = [];
  for (let i = 0; i < 3; i++) {
    const f = frame(r2);
    answers.push(original(a, f), original(c, f));
  }
  delegated = answers.length;
  check('every call answered true, as a node material does (three.webgpu.js:698)', answers.every(v => v === true), answers.join(','));
  check('six calls, six answers', delegated === 6);
  check('no mesh was ever skipped', off.staticRefreshStats.skipped === 0);
  check('the commit hook was not installed', r2._nodes.__forestStaticCommit !== true);
  off.dispose();
}

section('the pulled modes and the billboards stay outside the opt-in');
{
  // The policy only reads meshes drawMesh marked. The merged pulled mesh reads the arena storage
  // buffers (uploaded outside any per-mesh invalidate) and the billboards rebuild their colorNode
  // per variant, so both are left to three's observer: they carry no epoch.
  const r3 = makeRenderer();
  const pulled = makeForest(r3, { drawMode: 'pulled', billboards: true });
  const v0 = pulled.variantMeshes(0);
  const merged = v0.find(m => m.name === undefined || m.name === '');
  const billboard = v0.find(m => m.name === 'forest:v0:billboard');
  check('the billboard mesh exists and is unmarked',
    !!billboard && billboard.userData.forestEpoch === undefined, String(billboard?.userData?.forestEpoch));
  check('the merged pulled mesh, if built, is unmarked',
    !merged || merged.userData.forestEpoch === undefined, String(merged?.userData?.forestEpoch));
  check('the per-variant meshes are still marked',
    v0.filter(m => m.name?.startsWith('forest:v0:') && m.name !== 'forest:v0:billboard')
      .every(m => m.userData.forestEpoch !== undefined));
  pulled.dispose();
}

section('a rebuild hands out fresh meshes, and their render objects initialise from scratch');
{
  const r4 = makeRenderer();
  const rebuilt = makeForest(r4);
  const mesh = rebuilt.variantMeshes(0).find(m => m.name === 'forest:v0:branchesL0');
  check('the rebuilt forest\'s meshes are not the old ones', mesh !== branch0);
  const b4 = buildObserver(r4, mesh);
  const ro = makeRenderObject(mesh, b4, 'new');
  check('its first render object refreshes', renderObjectDirect(r4, ro, frame(r4)) === true);
  check('and the observer is a fresh one', b4.observer !== built.observer);
  rebuilt.dispose();
}

section('dispose puts renderer._nodes.updateAfter back');
{
  const patched = renderer._nodes.updateAfter;
  forest.dispose();
  check('the hook was removed', renderer._nodes.updateAfter !== patched);
  check('and the marker is cleared', renderer._nodes.__forestStaticCommit === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
