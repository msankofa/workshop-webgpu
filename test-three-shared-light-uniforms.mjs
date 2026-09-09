// test-three-shared-light-uniforms.mjs — the local patch to the served Three build
// (vendor/three-0.184/three.webgpu.js): two instanced meshes of one material must end up with the
// SAME render-group uniform nodes, which is the precondition for Three sharing one render bind group
// between them (WGSLNodeBuilder._getBindGroup keys the shared group by uniform node ids).
// node test-three-shared-light-uniforms.mjs
//
// What this proves: node identity across builds, with the flag on and off. What it does not: that
// the browser then writes camera and light uniforms once; that is the ?trace=1 capture's job.

import * as THREE from './vendor/three-0.184/three.webgpu.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const { context } = THREE.TSL;

function rig() {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(); sun.castShadow = true; sun.position.set(10, 20, 5); scene.add(sun);
  const point = new THREE.PointLight(0xffaa00, 3, 40, 2); point.position.set(2, 3, 1); scene.add(point);
  const spot = new THREE.SpotLight(0xffffff, 5, 30, 0.6, 0.3, 1); spot.castShadow = true; spot.position.set(0, 5, 0); scene.add(spot);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  const renderer = {
    library: new THREE.BasicNodeLibrary(),
    coordinateSystem: THREE.WebGPUCoordinateSystem,
    backend: { coordinateSystem: THREE.WebGPUCoordinateSystem, isWebGPUBackend: true, compatibilityMode: false, capabilities: { getUniformBufferLimit: () => 65536 },
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
  };
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x8899aa, roughness: 0.9 });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const meshes = [new THREE.InstancedMesh(geo, material, 8), new THREE.InstancedMesh(geo, material, 8)];
  for (const m of meshes) { m.receiveShadow = true; scene.add(m); }
  const lights = [sun, point, spot];
  // One LightsNode per build, as Renderer.lighting.createNode does per material build.
  function build(mesh) {
    const b = THREE.WebGPUBackend.prototype.createNodeBuilder(mesh, renderer);
    b.scene = scene; b.camera = camera; b.material = mesh.material;
    b.lightsNode = new THREE.LightsNode().setLights(lights);
    b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
    b.build();
    return b;
  }
  return { meshes, build, lights };
}
const renderIds = b => (b.uniformGroups.render?.uniforms || []).map(u => u.nodeUniform.node.id).sort((a, b) => a - b);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log('\nshared light uniforms (patched build, flag on)');
{
  THREE.setSharedLightUniforms(true);
  const { meshes, build } = rig();
  const a = build(meshes[0]), b = build(meshes[1]);
  const ia = renderIds(a), ib = renderIds(b);
  check('both builds carry render-group uniforms', ia.length > 4, `${ia.length}`);
  check('two instanced meshes of one material get the same render-group uniform nodes', same(ia, ib), `${ia.length} vs ${ib.length}, first differing: ${ia.find((v, i) => v !== ib[i])}`);
  check('the vertex and fragment shaders still build', typeof a.vertexShader === 'string' && a.vertexShader.length > 100 && a.fragmentShader.length > 100);
  check('the light colour updates through the shared node', (() => {
    const light = new THREE.PointLight(0xff0000, 2);
    const n1 = new THREE.PointLightNode(light), n2 = new THREE.PointLightNode(light);
    n1.update({}); const c = n2.colorNode.value;
    return n1.colorNode === n2.colorNode && Math.abs(c.r - 2) < 1e-6 && c.g === 0 && n1.cutoffDistanceNode === n2.cutoffDistanceNode;
  })());
  check('a light with its own colorNode keeps it', (() => {
    const light = new THREE.PointLight(0x00ff00, 1); light.colorNode = THREE.TSL.uniform(new THREE.Color(1, 1, 1));
    const n = new THREE.PointLightNode(light); n.update({});
    return n.colorNode === light.colorNode && light.colorNode.value.r === 1;
  })());
}

console.log('\nupstream behaviour (flag off)');
{
  THREE.setSharedLightUniforms(false);
  const { meshes, build } = rig();
  const ia = renderIds(build(meshes[0])), ib = renderIds(build(meshes[1]));
  check('with the flag off the two builds differ, as upstream', !same(ia, ib));
  THREE.setSharedLightUniforms(true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
