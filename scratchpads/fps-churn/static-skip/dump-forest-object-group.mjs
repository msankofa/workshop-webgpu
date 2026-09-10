// dump-forest-object-group.mjs — what the GENERATED shader and binding layout say each forest
// mesh owns per object. Evidence for 02-forest-object-contract.md. Read-only; writes JSON+MD here.
//
// Run from the repo root:  node scratchpads/fps-churn/static-skip/dump-forest-object-group.mjs
//
// Caveat, stated up front: this uses the node_modules `three/webgpu` (root three.webgpu.js), which
// the vendored vendor/three-0.184/three.webgpu.js matches except for a light-uniform patch. The
// stub renderer has no device, so nothing here is validated WGSL — it is the builder's output.

import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';
import { createTree } from '../../../trees.js';
import { createForestPalette } from '../../../forest-palette.js';
import { createForestGPU } from '../../../forest-gpu.js';
import { bindTreeMaterials } from '../../../base-game-forest.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from '../../../base-game-tree-species.js';

const OUT = new URL('./', import.meta.url);
mkdirSync(OUT, { recursive: true });

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

const forest = createForestGPU({
  renderer, camera, palette, heightAt: () => 0,
  lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 16,
  billboards: false, progressive: true, shadowLayer: 5, drawMode: 'variants', assumeLimits: true,
});
forest.applyTextureSet((b, l) => bindTreeMaterials(b, l, null));

// One mesh of each distinct name (role), from variant 0, plus variant 1 of the same role so we can
// answer "do two meshes sharing a material differ in the object group?".
const v0 = forest.variantMeshes(0);
const v1 = forest.variantMeshes(1);

const describeNode = node => {
  if (!node) return null;
  return {
    ctor: node.constructor?.name ?? null,
    name: node.name ?? null,
    updateType: node.updateType ?? null,
    updateBeforeType: node.updateBeforeType ?? null,
    groupNode: node.groupNode?.name ?? node.groupNode?.constructor?.name ?? null,
    // userData nodes carry the path they read
    path: node.path ?? node.property ?? null,
    objectNodeScope: node.scope ?? null,
    value: (() => { const v = node.value; if (v === undefined) return undefined;
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      if (v && v.isColor) return [v.r, v.g, v.b];
      if (v && v.elements) return Array.from(v.elements);
      if (v && v.isVector3) return [v.x, v.y, v.z];
      if (v && v.isTexture) return 'Texture#' + v.id;
      return v === null ? null : (v.constructor?.name ?? String(v)); })(),
  };
};

const dumpBuilder = (b, mesh) => {
  const groups = {};
  for (const [groupName, ug] of Object.entries(b.uniformGroups ?? {})) {
    groups[groupName] = (ug.uniforms ?? []).map(u => ({
      name: u.name,
      type: u.type ?? u.constructor?.name,
      uniformCtor: u.constructor?.name,
      node: describeNode(u.nodeUniform?.node ?? u.node),
    }));
  }
  const bindings = {};
  for (const stage of ['vertex', 'fragment', 'compute']) {
    const stageBindings = b.bindings?.[stage];
    if (!stageBindings) continue;
    const list = [];
    const push = (b2) => list.push({
      cls: b2.constructor?.name, name: b2.name,
      group: b2.groupNode?.name ?? b2.group?.name ?? null,
      isStorage: !!(b2.isStorageBuffer ?? b2.isNodeStorageBuffer),
      isTexture: !!b2.isSampledTexture, isSampler: !!b2.isSampler,
      access: b2.access ?? null,
      uniformNames: (b2.uniforms ?? []).map(u => u.name),
    });
    if (Array.isArray(stageBindings)) stageBindings.forEach(push);
    else for (const arr of Object.values(stageBindings)) arr.forEach(push);
    bindings[stage] = list;
  }
  const nodeList = arr => (arr ?? []).map(n => `${n.constructor?.name}${n.name ? `(${n.name})` : ''}[${n.getUpdateType?.() ?? n.updateType}]`);
  const updateNodes = nodeList(b.updateNodes);
  const updateBeforeNodes = nodeList(b.updateBeforeNodes);
  const updateAfterNodes = nodeList(b.updateAfterNodes);
  const vs = b.vertexShader ?? '';
  const fs = b.fragmentShader ?? '';
  const greps = {};
  for (const key of ['modelViewMatrix', 'modelWorldMatrix', 'modelMatrix', 'cameraViewMatrix',
    'cameraProjectionMatrix', 'modelNormalMatrix', 'normalMatrix', 'modelViewProjection',
    'instanceIndex', 'vertexIndex', 'var<storage']) {
    greps[key] = { vertex: (vs.match(new RegExp(key.replace(/[<]/g, '[<]'), 'g')) || []).length,
      fragment: (fs.match(new RegExp(key.replace(/[<]/g, '[<]'), 'g')) || []).length };
  }
  // The object-group struct as the builder emitted it, verbatim.
  const structs = [...vs.matchAll(/struct\s+(\w+)\s*\{[^}]*\}/g)].map(m => m[0]);
  return {
    mesh: mesh.name,
    material: mesh.material.name || mesh.material.type,
    materialUuid: mesh.material.uuid,
    slotOffset: mesh.userData?.slotOffset,
    geometryUuid: mesh.geometry.uuid,
    attributes: Object.keys(mesh.geometry.attributes),
    hasIndex: !!mesh.geometry.index,
    indirect: !!(mesh.geometry.indirect ?? mesh.geometry._indirect),
    instanceCount: mesh.geometry.instanceCount,
    updateNodes, updateBeforeNodes, updateAfterNodes,
    uniformGroups: groups,
    bindings,
    wgslGreps: greps,
    vertexStructs: structs,
  };
};

const out = [];
const seen = new Set();
for (const mesh of v0) {
  if (seen.has(mesh.name)) continue;
  seen.add(mesh.name);
  try { const bb = build(mesh); writeFileSync(new URL('./wgsl-' + mesh.name.replace(/[:]/g,'_') + '.vert.wgsl', OUT), bb.vertexShader); out.push(dumpBuilder(bb, mesh)); }
  catch (e) { out.push({ mesh: mesh.name, error: e.message }); }
}
// Same role from variant 1 — do the shared-material meshes differ?
const pair = [];
for (const role of ['branchesL0', 'leavesL0', 'branchesL2']) {
  const a = v0.find(m => m.name.endsWith(':' + role)), c = v1.find(m => m.name.endsWith(':' + role));
  const name = role;
  if (a && c) pair.push({
    name,
    sameMaterial: a.material === c.material,
    slotOffsetA: a.userData?.slotOffset, slotOffsetB: c.userData?.slotOffset,
    sameGeometry: a.geometry === c.geometry,
    geoA: a.geometry.uuid, geoB: c.geometry.uuid,
  });
}

const meshCensus = {};
for (let g = 0; g < palette.variants.length; g++) {
  for (const m of forest.variantMeshes(g)) meshCensus[m.name] = (meshCensus[m.name] ?? 0) + 1;
}

const report = { meshCensus, variants: palette.variants.length, roles: out, sharedMaterialPairs: pair };
writeFileSync(new URL('./forest-object-group.json', OUT), JSON.stringify(report, null, 2));

// Human-readable summary to stdout.
console.log('variants:', palette.variants.length, 'mesh census:', meshCensus);
for (const r of out) {
  if (r.error) { console.log(`\n== ${r.mesh}  ERROR ${r.error}`); continue; }
  console.log(`\n== ${r.mesh}   material=${r.material} slotOffset=${r.slotOffset} attrs=[${r.attributes}] index=${r.hasIndex}`);
  for (const [g, us] of Object.entries(r.uniformGroups)) {
    console.log(`   group '${g}': ${us.length} uniforms`);
    for (const u of us) console.log(`      ${u.name} : ${u.type}  <- ${u.node?.ctor}${u.node?.name ? `(${u.node.name})` : ''} updateType=${u.node?.updateType} value=${JSON.stringify(u.node?.value)?.slice(0,60)}`);
  }
  for (const [s, list] of Object.entries(r.bindings)) {
    console.log(`   bindings.${s}: ${list.map(b => `${b.cls}${b.name ? `:${b.name}` : ''}${b.group ? `@${b.group}` : ''}`).join(', ')}`);
  }
  console.log('   updateNodes:', r.updateNodes.join(', '));
  console.log('   updateBefore:', r.updateBeforeNodes.join(', ') || '(none)', '| updateAfter:', r.updateAfterNodes.join(', ') || '(none)');
  console.log('   wgsl:', Object.entries(r.wgslGreps).filter(([, v]) => v.vertex || v.fragment)
    .map(([k, v]) => `${k} v${v.vertex}/f${v.fragment}`).join('  '));
}
console.log('\nshared-material pairs:', JSON.stringify(pair, null, 2));
console.log('\nwrote forest-object-group.json');
forest.dispose();
