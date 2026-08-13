// Mode C — GPU depth-projected decals.
//
// A flat quad stuck to a curved limb lifts off at its edges (measured: ~8 mm on a forearm, ~19 mm on
// a torso). A projected decal has no surface of its own at all: it draws a box, reads the DEPTH
// already in the framebuffer to recover the world position of whatever solid geometry is behind each
// fragment, and paints only where that position falls inside the box. It therefore conforms to
// whatever is actually there — limb, torso, ground, wall — with no per-hit CPU work and no geometry.
//
// UNPROVEN RISK, and the reason this ships behind a toggle with a debug view: both harnesses run
// WebGPURenderer({ antialias: true }) into a PostProcessing pass. viewportDepthTexture copies the
// bound framebuffer's depth per render call (ViewportDepthTextureNode extends ViewportTextureNode,
// updateBeforeType = NodeUpdateType.RENDER), but whether a MULTISAMPLED depth target is samplable
// here is not something that can be checked without running it. Turn on `debug` to find out: it
// paints the reconstructed world position as a colour grid instead of the decal. A clean grid that
// slides correctly under camera motion means depth reconstruction works. Flat, black or swimming
// output means it does not, and Mode C is not viable in this pipeline.
//
// This does NOT replace attachment. A projected decal conforms to whatever is on screen right now,
// so a world-anchored one smears across anything that walks through it — the box still has to be
// moved by the body part it belongs to, exactly like a Mode A quad.

import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute, cameraProjectionMatrixInverse, cameraWorldMatrix, positionGeometry, screenUV, texture,
  vec2, vec3, vec4, float, abs, max, step, fract, viewportDepthTexture,
  uniform, length, mix, smoothstep,
} from 'three/tsl';
import { WOUND_DEFAULTS } from './wound-mask.js';

export function createProjectedDecals({ THREE, scene, decalTexture, cap = 256, debug = false }) {
  // Wound centre, mirroring effect-renderer.js's quad pool so switching stain mode changes the decal
  // technique and nothing else. Constants come from the one shared module; the graph is duplicated
  // because these two files have never shared a material factory (`lift`, spin and the helper-axis
  // swap are already duplicated the same way).
  const woundInner = uniform(WOUND_DEFAULTS.inner);
  const woundOuter = uniform(WOUND_DEFAULTS.outer);
  const woundDarken = uniform(WOUND_DEFAULTS.darken);
  // Unit cube, corners +/-0.5. The three per-instance axes below scale and orient it, so the
  // geometry itself never changes and the mesh matrix stays identity (world space, same convention
  // as effect-renderer.js's pools).
  const box = new THREE.BoxGeometry(1, 1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', box.getAttribute('position'));
  geo.setAttribute('uv', box.getAttribute('uv'));
  geo.setIndex(box.getIndex());
  box.dispose();

  const pos = new Float32Array(cap * 3);
  const ax = new Float32Array(cap * 3);   // half-axis: decal's in-plane X, world space, pre-scaled
  const ay = new Float32Array(cap * 3);   // half-axis: the decal's NORMAL (projection depth)
  const az = new Float32Array(cap * 3);   // half-axis: in-plane Z
  const col = new Float32Array(cap * 3);
  const alpha = new Float32Array(cap);
  const inst = (arr, n) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('instPos', inst(pos, 3));
  geo.setAttribute('instAxisX', inst(ax, 3));
  geo.setAttribute('instAxisY', inst(ay, 3));
  geo.setAttribute('instAxisZ', inst(az, 3));
  geo.setAttribute('instColor', inst(col, 3));
  geo.setAttribute('instAlpha', inst(alpha, 1));
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const aPos = attribute('instPos', 'vec3');
  const aX = attribute('instAxisX', 'vec3');
  const aY = attribute('instAxisY', 'vec3');
  const aZ = attribute('instAxisZ', 'vec3');

  const mat = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    // The box must not vanish when the camera is inside it, and its own faces must never occlude the
    // projection — only the depth already in the buffer decides what gets painted.
    side: THREE.BackSide, depthTest: false, forceSinglePass: true,
  });
  mat.positionNode = aPos
    .add(aX.mul(positionGeometry.x))
    .add(aY.mul(positionGeometry.y))
    .add(aZ.mul(positionGeometry.z));

  // Reconstruct the world position of the solid surface behind this fragment.
  const depth = viewportDepthTexture().r;
  const viewPos = getViewPositionSafe(screenUV, depth);
  const worldPos = cameraWorldMatrix.mul(vec4(viewPos, 1.0)).xyz;

  // Into the decal's own space. The axes are orthogonal, so the inverse is three dot products over
  // squared lengths — no mat4 inverse. Each component lands in [-0.5, 0.5] inside the box.
  const d = worldPos.sub(aPos);
  const proj = (axis) => d.dot(axis).div(max(axis.dot(axis), float(1e-8)));
  const local = vec3(proj(aX), proj(aY), proj(aZ));

  // Outside the box on any axis, this fragment is looking at geometry the decal doesn't cover.
  // Masked rather than discarded: `Discard` writes into the fragment stack, which is only reliable
  // inside an Fn, and at alpha 0 over a transparent material the result is identical.
  const outside = max(max(abs(local.x), abs(local.y)), abs(local.z));
  const inside = step(outside, float(0.5));

  if (debug) {
    // Reconstructed world position as a 1 m colour grid. This is the whole spike: if depth is
    // readable here, the ground reads as clean axis-aligned bands that stay locked to the world as
    // the camera moves. If it isn't, this is flat or noise.
    mat.colorNode = fract(worldPos);
    mat.opacityNode = inside;
  } else {
    // Project along the decal's normal (its Y axis): the in-plane coordinates are X and Z.
    const uv = vec2(local.x, local.z).add(0.5);
    // `local.xz` is already in the same +/-0.5 units the quad pool's positionGeometry.xy uses, so the
    // radial distance is directly comparable and the two modes darken identically.
    const base = attribute('instColor', 'vec3');
    const core = float(1).sub(smoothstep(woundInner, woundOuter, length(vec2(local.x, local.z))));
    mat.colorNode = mix(base, base.mul(woundDarken), core);
    mat.opacityNode = attribute('instAlpha', 'float').mul(texture(decalTexture, uv).a).mul(inside);
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.visible = false;
  mesh.renderOrder = 2;   // after opaque geometry, so the depth it samples is already written
  scene.add(mesh);

  let count = 0;
  // Decals the caller wanted but the cap refused, this frame and at its worst. Same purpose as the
  // quad pool's counters: the cap is only defensible if the cost of it is visible.
  let dropped = 0, peak = 0, droppedPeak = 0;
  const _t = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();

  return {
    mesh,
    get cap() { return cap; },
    get count() { return count; },
    get dropped() { return dropped; },
    get peak() { return peak; },
    get droppedPeak() { return droppedPeak; },
    resetStats() { peak = 0; droppedPeak = 0; },
    // Uniform writes, so this is slider-cheap. Same signature as effect-renderer's setWoundStyle.
    setWoundStyle({ inner, outer, darken } = {}) {
      if (Number.isFinite(inner)) woundInner.value = inner;
      if (Number.isFinite(outer)) woundOuter.value = outer;
      if (Number.isFinite(darken)) woundDarken.value = darken;
      return { inner: woundInner.value, outer: woundOuter.value, darken: woundDarken.value };
    },
    begin() { count = 0; dropped = 0; },
    // One decal: centred at (x,y,z), facing `normal`, `size` across in plane, projecting `depthM`
    // along the normal in both directions. `spin` rolls it about the normal.
    push(x, y, z, normal, size, depthM, r, g, b, a, spin = 0) {
      if (a <= 0.003 || size <= 0) return false;
      if (count >= cap) { dropped++; return false; }
      _n.copy(normal);
      if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0); else _n.normalize();
      // Any in-plane basis; the helper axis swaps when the normal is near-vertical, or the cross
      // product collapses — the same trap effect-renderer.js's pushBlood has.
      _t.set(Math.abs(_n.y) > 0.99 ? 1 : 0, Math.abs(_n.y) > 0.99 ? 0 : 1, 0).cross(_n);
      if (_t.lengthSq() < 1e-12) _t.set(1, 0, 0); else _t.normalize();
      _b.crossVectors(_n, _t).normalize();
      const cs = Math.cos(spin), sn = Math.sin(spin);
      const i = count++, i3 = i * 3;
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      // Half-extents: `size` is the full in-plane width, so each half-axis is size/2.
      const h = size * 0.5;
      ax[i3] = (_t.x * cs + _b.x * sn) * h; ax[i3 + 1] = (_t.y * cs + _b.y * sn) * h; ax[i3 + 2] = (_t.z * cs + _b.z * sn) * h;
      az[i3] = (_b.x * cs - _t.x * sn) * h; az[i3 + 1] = (_b.y * cs - _t.y * sn) * h; az[i3 + 2] = (_b.z * cs - _t.z * sn) * h;
      ay[i3] = _n.x * depthM; ay[i3 + 1] = _n.y * depthM; ay[i3 + 2] = _n.z * depthM;
      col[i3] = r; col[i3 + 1] = g; col[i3 + 2] = b;
      alpha[i] = Math.min(1, a);
      return true;
    },
    end() {
      geo.instanceCount = count;
      mesh.visible = count > 0;
      if (count > peak) peak = count;
      if (dropped > droppedPeak) droppedPeak = dropped;
      for (const name of ['instPos', 'instAxisX', 'instAxisY', 'instAxisZ', 'instColor', 'instAlpha']) {
        geo.getAttribute(name).needsUpdate = true;
      }
    },
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}

// getViewPosition is exported from TSL, but importing it by name pulls in a symbol whose presence
// varies by build entry point; inlining the same four lines keeps this module dependent only on
// exports already verified present in three 0.184's tsl bundle.
function getViewPositionSafe(uv, depth) {
  // WebGPU clip space: xy in [-1,1] with y flipped from uv, z in [0,1] taken straight from depth.
  const clip = vec4(vec3(vec2(uv.x, uv.y.oneMinus()).mul(2.0).sub(1.0), depth), 1.0);
  const view = cameraProjectionMatrixInverse.mul(clip);
  return view.xyz.div(view.w);
}
