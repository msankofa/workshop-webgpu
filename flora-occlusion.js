// flora-occlusion.js -- an occluder depth buffer the GPU flora culls test against.
//
// Each frame the meshes on OCCLUDER_LAYER are drawn from the live camera into a small render
// target, with an override material that writes linear view depth instead of colour. The cull
// kernels in grass-compute.js and plants-gpu.js project each candidate with the same
// view-projection matrix, read the stored depth around that point, and drop the candidate when
// it lies deeper than the occluder there. Only the concrete is drawn, so it is cheap; sky, flora
// and transparent water are never occluders.
//
// Usage:
//   const occ = createFloraOcclusion({ renderer, scene, camera });
//   occ.markOccluders(mapRoot);          // after every layout rebuild: puts its meshes on the layer
//   occ.update();                        // per frame, BEFORE the culls that read it
//   createComputeGrass({ ..., occlusion: occ.state });  createPlantsGPU({ ..., occlusion: occ.state });
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { positionView, vec4 } from 'three/tsl';

export const OCCLUDER_LAYER = 2;
const FAR = 60000;   // clear depth: anything the occluders do not cover reads as open

export function createFloraOcclusion({ renderer, scene, camera, size = 256, layer = OCCLUDER_LAYER, bias = 0.12, cacheStatic = false }) {
  const rt = new THREE.RenderTarget(size, size, {
    format: THREE.RGBAFormat, type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: true, generateMipmaps: false,
  });
  const depthMat = new MeshBasicNodeMaterial();
  depthMat.colorNode = vec4(positionView.z.negate(), 0, 0, 1);
  const occCam = new THREE.PerspectiveCamera();
  occCam.layers.set(layer);
  const clear = new THREE.Color(FAR, FAR, FAR);
  const prevClear = new THREE.Color();
  const state = {
    enabled: true,
    texture: rt.texture,
    viewProj: new THREE.Matrix4(),
    texel: new THREE.Vector2(1 / size, 1 / size),
    bias,
    size,
    revision: 0,
  };
  const stats = { renders: 0, skipped: 0 };
  const nextViewProj = new THREE.Matrix4();
  const roots = new Map();
  let dirty = true;
  // Static hosts call invalidate/markOccluders after editing children or geometry. Root motion
  // (including a floating-origin rebase) and visibility changes are detected automatically.
  function invalidate() { dirty = true; }

  function update() {
    if (!state.enabled) return false;
    occCam.position.copy(camera.position);
    occCam.quaternion.copy(camera.quaternion);
    occCam.scale.copy(camera.scale);
    occCam.near = camera.near; occCam.far = camera.far; occCam.fov = camera.fov; occCam.aspect = camera.aspect;
    occCam.updateMatrixWorld(true);
    occCam.projectionMatrix.copy(camera.projectionMatrix);
    occCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    nextViewProj.multiplyMatrices(occCam.projectionMatrix, occCam.matrixWorldInverse);
    for (const [root, previous] of roots) {
      root.updateWorldMatrix(true, false);
      if (!previous.matrix.equals(root.matrixWorld) || previous.visible !== root.visible || previous.parent !== root.parent) dirty = true;
      previous.matrix.copy(root.matrixWorld);
      previous.visible = root.visible;
      previous.parent = root.parent;
    }
    if (cacheStatic && !dirty && nextViewProj.equals(state.viewProj)) { stats.skipped++; return false; }
    // Background and fog would write into the depth image; both are put back after the pass.
    const prevRT = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial, prevBg = scene.background, prevFog = scene.fog;
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    dirty = true; // a failed render must be retried, with the previous depth revision unchanged
    try {
      scene.overrideMaterial = depthMat; scene.background = null; scene.fog = null;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(clear, 1);
      renderer.render(scene, occCam);
    } finally {
      renderer.setRenderTarget(prevRT);
      renderer.setClearColor(prevClear, prevAlpha);
      scene.overrideMaterial = prevOverride; scene.background = prevBg; scene.fog = prevFog;
    }
    state.viewProj.copy(nextViewProj);
    state.revision++;
    dirty = false;
    stats.renders++;
    return true;
  }

  // Opaque meshes under `root` become occluders; transparent ones (water) stay out. `filter`
  // narrows further (the terrain root also holds clipmap rings placed by a position node).
  function markOccluders(root, filter = null) {
    // A reseated building replaces its root. Detached roots need no cached references.
    for (const previous of roots.keys()) if (!previous.parent) roots.delete(previous);
    if (cacheStatic && !roots.has(root)) roots.set(root, { matrix: new THREE.Matrix4(), visible: null, parent: null });
    invalidate();
    let n = 0;
    root.traverse((o) => {
      if (!o.isMesh || (o.material && o.material.transparent) || (filter && !filter(o))) return;
      o.layers.enable(layer); n++;
    });
    return n;
  }

  return {
    state, stats, update, markOccluders, invalidate,
    setEnabled(on) { if (state.enabled !== !!on) invalidate(); state.enabled = !!on; },
    dispose() { roots.clear(); rt.dispose(); depthMat.dispose(); },
  };
}
