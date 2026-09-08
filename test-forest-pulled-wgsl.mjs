// test-forest-pulled-wgsl.mjs — the pulled-draw forest graphs, built to WGSL headless.
//
// What this proves and what it does not. The shipped WGSLNodeBuilder turns a TSL graph into a
// WGSL string with a stub renderer, so this catches TSL graph errors: a missing node, a wrong
// swizzle, a storage node the builder cannot bind, an attribute that does not exist. It does NOT
// validate the WGSL: node_modules carries no naga/tint/wgsl compiler, so type errors the builder
// happens to emit, and every device limit (storage buffers per stage above all), are invisible
// here and only a real device answers them.
//
// node test-forest-pulled-wgsl.mjs [--dump]   (--dump writes the WGSL under scratchpads/fps-churn/)

import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';
import { createTree } from './trees.js';
import { createForestPalette } from './forest-palette.js';
import { createForestGPU, pulledStorageBindingsNeeded } from './forest-gpu.js';
import { bindTreeMaterials } from './base-game-forest.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from './base-game-tree-species.js';

const dump = process.argv.includes('--dump');
const OUT = new URL('./scratchpads/fps-churn/forest-pulled-wgsl/', import.meta.url);
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
  computeAsync: async nodes => { captured.push(...(Array.isArray(nodes) ? nodes : [nodes])); },
  getArrayBufferAsync: async attr => new ArrayBuffer(attr.array.byteLength),
};
let captured = [];

function buildMaterial(mesh) {
  const b = THREE.WebGPUBackend.prototype.createNodeBuilder(mesh, renderer);
  b.scene = scene; b.camera = camera; b.material = mesh.material;
  b.lightsNode = new THREE.LightsNode().setLights([light]);
  b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
  b.build();
  return { vertex: b.vertexShader, fragment: b.fragmentShader };
}
function buildCompute(node) {
  const b = THREE.WebGPUBackend.prototype.createNodeBuilder(node, renderer);
  b.build();
  return b.computeShader;
}

const params = {
  speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 3),
  branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
  leafCount: 4, leafSize: 1, leafShadowPct: 0.3,
};
const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 2 });

function makeForest(drawMode) {
  return createForestGPU({
    renderer, camera, palette, heightAt: () => 0,
    lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 16,
    billboards: false, progressive: true, shadowLayer: 5, drawMode,
    // The stub renderer has no device, so the admission check reports unknown. Tests say so out loud.
    assumeLimits: true,
  });
}

for (const mode of ['variants', 'pulled', 'pulled-compact']) {
  section(`draw mode '${mode}'`);
  const forest = makeForest(mode);
  const stats = () => forest.summary;
  check('the mode is what was asked for', stats().drawMode === mode, stats().drawMode);
  const merged = forest.variantMeshes(0).find(m => m.name === 'forest:pulled:branchesL2') ?? null;
  check(`the merged mesh ${mode === 'variants' ? 'does not exist' : 'exists'}`, !!merged === (mode !== 'variants'));

  // Every material of this mode's forest builds, with the bark binding the page applies.
  forest.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));
  const meshes = [];
  for (let g = 0; g < palette.variants.length; g++) meshes.push(...forest.variantMeshes(g));
  let built = 0, firstErr = null;
  for (const mesh of meshes) {
    try { buildMaterial(mesh); built++; } catch (e) { firstErr ??= `${mesh.name}: ${e.message}`; }
  }
  check('every render mesh builds vertex+fragment WGSL', built === meshes.length, firstErr ?? `${built}/${meshes.length}`);

  if (merged) {
    let src = null, err = null;
    try { src = buildMaterial(merged); } catch (e) { err = e; }
    check('the merged material builds', !!src, String(err?.message ?? ''));
    if (src) {
      write(`${mode}-merged-vertex.wgsl`, src.vertex);
      write(`${mode}-merged-fragment.wgsl`, src.fragment);
      const vs = src.vertex;
      // The four storage reads the vertex stage makes: merged instance list, arena vertices,
      // arena indices, arena counts. This is the number the device must admit in the VERTEX stage.
      const vsStorage = count(vs, /var<storage,\s*read(_write)?>/g);
      check('the vertex stage binds exactly the four arena/instance storage buffers', vsStorage === 4, `${vsStorage} bindings`);
      check('and the module agrees with itself about that count',
        pulledStorageBindingsNeeded() === vsStorage, `${pulledStorageBindingsNeeded()} reported`);
      check('the vertex stage reads @builtin(vertex_index)', /vertex_index/.test(vs));
      check('the merged draw is instanced', /instance_index/.test(vs));
      if (mode === 'pulled') check('the padded index collapses onto k=0', /if \( \( vertexIndex </.test(vs));
      // gi = instance*chunk + vertexIndex, then a divide by the variant's index count and a
      // multiply-subtract for the remainder (TSL has no u32 % here).
      else {
        const a = forest.summary.pulledArena;
        check('the compact mapping walks instance*chunk + vertexIndex and divides by an index count',
          new RegExp(`instanceIndex \\* ${a.chunk}u`).test(vs) && / \/ /.test(vs));
        // ---- the tail guard, read out of the WGSL the builder actually emitted ----
        const body = vs.slice(vs.indexOf('fn main('));
        const V = forest.summary.variants, PREFIX_BASE = V * 2;
        // The only storage reads before the guard are the prefix table at FIXED indices.
        const guard = body.search(new RegExp(`< NodeBuffer_\\d+\\.value\\[ ${PREFIX_BASE + V}u \\]`));
        check('the guard compares gi against the total', guard >= 0);
        const loads = [...body.matchAll(/NodeBuffer_\d+\.value\[ ([^\]]*)\]/g)];
        const before = loads.filter(m => m.index < guard);
        check('every storage read before the guard is a constant index into the prefix table',
          before.every(m => /^\s*\d+u\s*$/.test(m[1])), before.map(m => m[1]).join(' | '));
        // No dynamic read may exist outside the guarded branch either.
        const gStart = body.indexOf('if ( ', guard);
        const dynamicOutside = loads.filter(m => m.index > guard && m.index < gStart && !/^\s*\d+u\s*$/.test(m[1]));
        check('no dynamically indexed storage read sits between the guard and its branch',
          dynamicOutside.length === 0, dynamicOutside.map(m => m[1]).join(' | '));
        check('the tail emits a finite constant position, so its triangles have no area',
          /vec3<f32>\( 0\.0, 0\.0, 0\.0 \)/.test(body));
        // Variant V can never be reached: the search is clamped to V-1 and the tail forces 0.
        check(`the variant search is clamped to ${V - 1}`, new RegExp(`min\\([^;]*\\), ${V - 1}u \\)`).test(body));
        check(`the instance is clamped to the per-variant cap`, new RegExp(`min\\( \\([^;]*/ [^;]*\\), ${a.cap - 1}u \\)`).test(body),
          'no min(r / ic, CAP-1)');
        check(`the local index is clamped to the index slot`, new RegExp(`, ${a.indexSlot - 1}u \\)`).test(body));
        check('and the arena is only ever indexed by the clamped variant',
          !new RegExp(`\\* ${a.vertexSlot}u`).test(body.slice(0, guard)));
      }
      check('the fragment stage needs no storage buffer', count(src.fragment, /var<storage/g) === 0);
      check('uv, colour and the shading normal cross as varyings, not per-fragment arena reads',
        /v_pulledUv/.test(vs) && /v_pulledColor/.test(vs) && /v_pulledNormal/.test(vs));
    }
  }

  // The compute chain, in this mode. warmupAll walks every node the mode dispatches.
  captured = [];
  await forest.warmupCompute();
  check('warmupAll submits the mode\'s compute nodes', captured.length > 0, `${captured.length}`);
  let ok = 0, cErr = null;
  const kernels = [];
  for (const node of captured) {
    try { kernels.push(buildCompute(node)); ok++; } catch (e) { cErr ??= e.message; }
  }
  check('every compute node builds WGSL', ok === captured.length, cErr ?? `${ok}/${captured.length}`);
  check('the mode reports the pipeline count it built', stats().computePipelines === captured.length,
    `${stats().computePipelines} vs ${captured.length}`);
  if (mode.startsWith('pulled')) {
    const cull = kernels.find(k => /atomicAdd/.test(k) && /textureLoad|uCam/.test(k)) ?? kernels.join('\n');
    write(`${mode}-compute-all.wgsl`, kernels.join('\n// ---- next kernel ----\n'));
    check('the merged compaction atomic is in the cull', /atomicAdd/.test(cull));
    const finalizer = kernels[kernels.length - 1];
    check('a one-invocation merged finalizer ends the chain', /atomicLoad/.test(finalizer));
  } else {
    write('variants-compute-all.wgsl', kernels.join('\n// ---- next kernel ----\n'));
  }
  forest.dispose();
}

section('the authored bark normal map goes through the arena uv frame');
{
  const forest = makeForest('pulled');
  const merged = forest.variantMeshes(0).find(m => m.name === 'forest:pulled:branchesL2');
  const barkMap = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const barkNormalMap = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  forest.applyTextureSet((b, l) => bindTreeMaterials(b, l,
    { mode: 'authored', barkMap, barkNormalMap, leafMap: barkMap, leafAlphaTest: 0.5 }));
  let src = null, err = null;
  try { src = buildMaterial(merged); } catch (e) { err = e; }
  check('the merged material builds with an authored bark set', !!src, String(err?.message ?? ''));
  if (src) {
    write('pulled-merged-authored-vertex.wgsl', src.vertex);
    write('pulled-merged-authored-fragment.wgsl', src.fragment);
    const fs = src.fragment;
    // Two sampled textures in the fragment: the bark colour and the bark normal.
    check('bark colour and bark normal are both sampled', count(fs, /textureSample/g) >= 2, `${count(fs, /textureSample/g)} samples`);
    check('the tangent frame is built from screen derivatives of the arena uv',
      /dpdx/i.test(fs) && /v_pulledUv/.test(fs));
    check('and it still reads no storage buffer in the fragment stage', count(fs, /var<storage/g) === 0);
    check('the vertex stage still binds only its four', count(src.vertex, /var<storage,\s*read(_write)?>/g) === 4);
  }
  forest.dispose();
}

section('the arena reports its geometry');
{
  const forest = makeForest('pulled');
  const a = forest.summary.pulledArena;
  check('an arena was packed', !!a, forest.summary.pulledError ?? '');
  if (a) console.log(`  vertexSlot ${a.vertexSlot}, indexSlot ${a.indexSlot}, ` +
    `${(a.vertexBytes / 1024).toFixed(0)} KiB verts + ${(a.indexBytes / 1024).toFixed(0)} KiB indices`);
  forest.dispose();
}

section('a device that cannot bind the vertex stage falls back');
{
  const forest = createForestGPU({
    renderer, camera, palette, heightAt: () => 0, lodR0: 60, lodR1: 140, lodR2: 260,
    maxDrawRadius: 260, capPerVariant: 16, billboards: false, progressive: true, shadowLayer: 5,
    drawMode: 'pulled', assumeLimits: { maxStorageBuffersInVertexStage: 0 },
  });
  check('the mode fell back to variants', forest.summary.drawMode === 'variants-fallback', forest.summary.drawMode);
  check('and said why', /storage/i.test(forest.summary.pulledError ?? ''), forest.summary.pulledError ?? '');
  check('no merged mesh was built', !forest.variantMeshes(0).some(m => m.name === 'forest:pulled:branchesL2'));
  forest.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (dump) console.log(`WGSL written to scratchpads/fps-churn/forest-pulled-wgsl/`);
process.exit(failed ? 1 : 0);
