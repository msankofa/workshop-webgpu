// test-forest-leaf-shaders.mjs — the per-variant (default 'variants' draw mode) forest role
// materials, built to WGSL headless, checked for vertex-stage work leaking into the fragment stage.
//
// What this proves and what it does not. Same harness contract as test-forest-pulled-wgsl.mjs:
// the shipped WGSLNodeBuilder turns the TSL graph into a WGSL string with a stub renderer, so this
// reads the SHAPE of the emitted code (which stage loads which buffer, how many times). It does not
// compile the WGSL, does not run a GPU, and says nothing about cost in time.
//
// node test-forest-leaf-shaders.mjs [--dump]   (--dump writes WGSL under scratchpads/fps-churn/leaves/)

import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';
import { createTree } from './trees.js';
import { createForestPalette } from './forest-palette.js';
import { createForestGPU } from './forest-gpu.js';
import { bindTreeMaterials } from './base-game-forest.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from './base-game-tree-species.js';

const dump = process.argv.includes('--dump');
const OUT = new URL('./scratchpads/fps-churn/leaves/wgsl/', import.meta.url);
if (dump) mkdirSync(OUT, { recursive: true });
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);
const count = (src, re) => (src.match(re) || []).length;
const write = (name, src) => { if (dump) writeFileSync(new URL(name, OUT), src); };

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

function buildMaterial(mesh) {
  const b = THREE.WebGPUBackend.prototype.createNodeBuilder(mesh, renderer);
  b.scene = scene; b.camera = camera; b.material = mesh.material;
  b.lightsNode = new THREE.LightsNode().setLights([light]);
  b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
  b.build();
  return { vertex: b.vertexShader, fragment: b.fragmentShader };
}

const params = {
  speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 3),
  branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
  leafCount: 4, leafSize: 1, leafShadowPct: 0.3,
};
const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 2 });

function makeForest(extra = {}) {
  return createForestGPU({
    renderer, camera, palette, heightAt: () => 0,
    lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 16,
    billboards: false, progressive: true, shadowLayer: 5, drawMode: 'variants',
    assumeLimits: true, ...extra,
  });
}

// The draw buffer is the only storage buffer these materials touch. Count its reads per stage.
const ROLES = ['branchesL0', 'leavesL0', 'leavesL1', 'coarseLeavesL2', 'leafShadow'];
function measure(forest, tag) {
  const meshes = forest.variantMeshes(0);
  const out = {};
  for (const role of ROLES) {
    const mesh = meshes.find(m => m.name === `forest:v0:${role}`);
    if (!mesh) { check(`the ${role} mesh exists`, false); continue; }
    let src = null, err = null;
    try { src = buildMaterial(mesh); } catch (e) { err = e; }
    check(`${tag}: ${role} builds vertex+fragment WGSL`, !!src, String(err?.message ?? ''));
    if (!src) continue;
    write(`${tag}-${role}-vertex.wgsl`, src.vertex);
    write(`${tag}-${role}-fragment.wgsl`, src.fragment);
    out[role] = {
      vsBindings: count(src.vertex, /var<storage,\s*read(_write)?>/g),
      fsBindings: count(src.fragment, /var<storage,\s*read(_write)?>/g),
      vsLoads: count(src.vertex, /NodeBuffer_\d+\.value\[/g),
      vsIndices: new Set([...src.vertex.matchAll(/NodeBuffer_\d+\.value\[([^\]]*)\]/g)].map(m => m[1].trim())).size,
      fsLoads: count(src.fragment, /NodeBuffer_\d+\.value\[/g),
      vsTrig: count(src.vertex, /\b(cos|sin)\(/g),
      fsTrig: count(src.fragment, /\b(cos|sin)\(/g),
      fsInstance: count(src.fragment, /instanceIndex|instance_index/g),
    };
  }
  return out;
}

section('the per-variant leaf and bark roles, default draw mode');
const forest = makeForest();
forest.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));
const now = measure(forest, 'variants');
console.log('\n  role              vsBind fsBind vsLoad fsLoad vsTrig fsTrig fsInst');
for (const role of ROLES) {
  const m = now[role];
  if (!m) continue;
  console.log(`  ${role.padEnd(17)} ${String(m.vsBindings).padStart(5)} ${String(m.fsBindings).padStart(6)} ` +
    `${String(m.vsLoads).padStart(6)} ${String(m.fsLoads).padStart(6)} ${String(m.vsTrig).padStart(6)} ` +
    `${String(m.fsTrig).padStart(6)} ${String(m.fsInstance).padStart(6)}`);
}

section('no leaf or bark fragment stage reads the draw buffer');
for (const role of ROLES) {
  const m = now[role];
  if (!m) continue;
  check(`${role}: the fragment stage binds no storage buffer`, m.fsBindings === 0, `${m.fsBindings} bindings`);
  check(`${role}: the fragment stage loads no draw record`, m.fsLoads === 0, `${m.fsLoads} loads`);
  // Bark keeps one sin: the procedural bark colour's own noise, which is fragment work by design.
  const trigBudget = role === 'branchesL0' ? 1 : 0;
  check(`${role}: the yaw rotation is not redone per fragment`, m.fsTrig <= trigBudget, `${m.fsTrig} cos/sin`);
  check(`${role}: the fragment stage derives nothing from the instance index`, m.fsInstance === 0, `${m.fsInstance} uses`);
}

section('the vertex stage reads each draw record once');
for (const role of ROLES) {
  const m = now[role];
  if (!m) continue;
  // rec0 (x,y,z,scale) and rec1 (yaw): two distinct records. The builder inlines an element()
  // read at each consumer, so the same two indices appear several times in the text; they are
  // identical read-only loads at a loop-invariant index, which is what a driver folds.
  check(`${role}: the vertex stage reads exactly two distinct draw indices`, m.vsIndices === 2, `${m.vsIndices} indices`);
  check(`${role}: one cos and one sin in the vertex stage`, m.vsTrig === 2, `${m.vsTrig} cos/sin`);
}
forest.dispose();

section('the legacy fragment-side normal is still reachable, and is what it was');
{
  const legacy = makeForest({ instanceNormalVarying: false });
  legacy.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));
  const before = measure(legacy, 'legacy');
  for (const role of ROLES) {
    const m = before[role];
    if (!m) continue;
    check(`${role}: the legacy form does read the draw buffer per fragment`, m.fsLoads > 0, `${m.fsLoads} loads`);
  }
  console.log('\n  legacy role       fsBind fsLoad fsTrig');
  for (const role of ROLES) {
    const m = before[role];
    if (!m) continue;
    console.log(`  ${role.padEnd(17)} ${String(m.fsBindings).padStart(6)} ${String(m.fsLoads).padStart(6)} ${String(m.fsTrig).padStart(6)}`);
  }
  legacy.dispose();
}

// ---- the space the instance normal reaches lighting in ------------------------------------
// NodeMaterial.setupNormal returns vec3(this.normalNode) and normalView consumes it with no
// transform, so the normal handed over must already be VIEW space. These read the emitted WGSL
// for the varying's own assignment line and ask which matrices touched it, and in which stage.
const NORMAL_ROLES = ['branchesL0', 'leavesL0', 'leafShadow'];
const normalAssign = src => (src.match(/varyings\.v_forestNormal\s*=\s*[^;]*;/) || [])[0] ?? '';
const fragNormalLines = src => src.split('\n').filter(l => l.includes('v_forestNormal') && !l.includes('@location'));

function normalShaders(f, tag) {
  const meshes = f.variantMeshes(0);
  const out = {};
  for (const role of NORMAL_ROLES) {
    const mesh = meshes.find(m => m.name === `forest:v0:${role}`);
    if (!mesh) continue;
    const src = buildMaterial(mesh);
    write(`${tag}-${role}-vertex.wgsl`, src.vertex);
    write(`${tag}-${role}-fragment.wgsl`, src.fragment);
    out[role] = src;
  }
  return out;
}

section("the default 'view' form transforms the normal in the vertex stage");
{
  const f = makeForest();
  f.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));
  const built = normalShaders(f, 'viewspace');
  for (const role of NORMAL_ROLES) {
    const src = built[role];
    if (!src) { check(`the ${role} mesh exists`, false); continue; }
    const vs = normalAssign(src.vertex);
    check(`${role}: the vertex stage writes v_forestNormal`, vs.length > 0);
    // modelNormalMatrix lands as an object-group uniform (object.nodeUniformN) on the same line.
    check(`${role}: the model normal matrix is applied in the vertex stage`,
      /object\.nodeUniform\d+\s*\*/.test(vs), vs.slice(0, 160));
    check(`${role}: the camera view matrix is applied in the vertex stage`,
      vs.includes('render.cameraViewMatrix'), vs.slice(0, 160));
    const fs = fragNormalLines(src.fragment);
    check(`${role}: the fragment stage applies no camera transform to the normal`,
      fs.every(l => !l.includes('cameraViewMatrix')), fs.join(' | ').slice(0, 200));
    check(`${role}: the fragment stage normalizes the interpolated normal`,
      fs.some(l => /normalize\(\s*v_forestNormal\s*\)/.test(l)), fs.join(' | ').slice(0, 200));
    check(`${role}: the fragment stage still binds no storage buffer`,
      count(src.fragment, /var<storage,\s*read(_write)?>/g) === 0);
    check(`${role}: the fragment stage still loads no draw record`,
      count(src.fragment, /NodeBuffer_\d+\.value\[/g) === 0);
  }
  f.dispose();
}

section("the 'world' form is the pre-fix shader: no camera transform on the normal");
{
  const f = makeForest({ normalSpace: 'world' });
  f.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));
  const built = normalShaders(f, 'worldspace');
  for (const role of NORMAL_ROLES) {
    const src = built[role];
    if (!src) { check(`the ${role} mesh exists`, false); continue; }
    const vs = normalAssign(src.vertex);
    check(`${role}: world form still writes v_forestNormal`, vs.length > 0);
    check(`${role}: world form applies no camera view matrix to the normal`,
      !vs.includes('cameraViewMatrix'), vs.slice(0, 160));
    check(`${role}: world form applies no model normal matrix to the normal`,
      !/object\.nodeUniform\d+\s*\*/.test(vs), vs.slice(0, 160));
    const fs = fragNormalLines(src.fragment);
    check(`${role}: world form does not renormalize the varying either`,
      fs.every(l => !/normalize\(\s*v_forestNormal\s*\)/.test(l)), fs.join(' | ').slice(0, 200));
  }
  f.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (dump) console.log('WGSL written to scratchpads/fps-churn/leaves/wgsl/');
process.exit(failed ? 1 : 0);
