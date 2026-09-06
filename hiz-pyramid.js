// hiz-pyramid.js — a hierarchical depth pyramid built from the main pass depth.
//
// Level 0 is linear view distance (positive metres) at half the frame resolution, read from the
// scene pass's depth texture. Every further level is a 2x2 max reduction, so a texel at level n
// holds the FARTHEST distance under its footprint. A cull kernel then picks the level whose texel
// matches a candidate's screen footprint, reads the four texels it covers, and treats the candidate
// as hidden only when its nearest point is behind all of them (see hiz-test.js).
//
// Every level is also packed into ONE atlas texture (level 0 on the left, the rest stacked down
// the right), so a kernel reaches the whole pyramid through a single texture binding; the grass
// cull stage has one binding to spare. A level cannot read and write the same texture in one
// dispatch, so the chain reduces through per-level textures and writes each result twice.
//
// The CPU helpers (sizes, layout, reduction, level pick, bias) are pure and are what the Node test
// covers; createHiZ() owns the GPU chain and mirrors them exactly.

import * as THREE from 'three';
import { StorageTexture } from 'three/webgpu';
import { Fn, int, ivec2, uniform, vec4, texture, textureStore, instanceIndex, max, min, perspectiveDepthToViewZ } from 'three/tsl';

export const HIZ_BASE_DIVISOR = 2;   // level 0 is the frame at half resolution
export const HIZ_BIAS_FLOOR = 0.05;   // metres, added under the texel footprint

// Level sizes from the frame size: level 0 is the half-res frame, each further level halves and
// rounds up, so an odd edge keeps a texel for its last column (the reduction clamps reads).
export function hizLevelSizes(frameWidth, frameHeight, levels) {
  const out = [];
  let w = Math.max(1, Math.ceil(frameWidth / HIZ_BASE_DIVISOR)), h = Math.max(1, Math.ceil(frameHeight / HIZ_BASE_DIVISOR));
  for (let i = 0; i < levels; i++) {
    out.push({ width: w, height: h });
    if (w === 1 && h === 1) break;
    w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
  }
  return out;
}

// Atlas layout: level 0 at the origin, levels 1.. stacked down a column to its right.
export function hizAtlasLayout(sizes) {
  const levels = [{ x: 0, y: 0, ...sizes[0] }];
  let y = 0;
  for (let i = 1; i < sizes.length; i++) { levels.push({ x: sizes[0].width, y, ...sizes[i] }); y += sizes[i].height; }
  const width = sizes[0].width + (sizes.length > 1 ? sizes[1].width : 0);
  return { width, height: Math.max(sizes[0].height, y), levels };
}

// CPU twin of the reduce kernel: max of the 2x2 block, reads clamped to the source edge.
export function hizReduceCPU(src, srcWidth, srcHeight) {
  const w = Math.max(1, Math.ceil(srcWidth / 2)), h = Math.max(1, Math.ceil(srcHeight / 2));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.min(2 * x, srcWidth - 1), x1 = Math.min(2 * x + 1, srcWidth - 1);
    const y0 = Math.min(2 * y, srcHeight - 1), y1 = Math.min(2 * y + 1, srcHeight - 1);
    out[y * w + x] = Math.max(src[y0 * srcWidth + x0], src[y0 * srcWidth + x1], src[y1 * srcWidth + x0], src[y1 * srcWidth + x1]);
  }
  return { data: out, width: w, height: h };
}

// The level whose texel is at least half the footprint, so a rectangle of `extentPx` level-0
// texels on its longer side is covered by at most 2x2 texels of the chosen level.
export function hizPickLevel(extentPx, levels) {
  let level = 0;
  while (level < levels - 1 && extentPx > 2 * (1 << level)) level++;
  return level;
}

// Distance a candidate may sit behind the stored depth and still count as visible: the world
// footprint of one texel of the chosen level at that distance, plus a fixed floor.
export function hizBias(distance, level, frameWidth, tanHalfFov, aspect) {
  const level0Texel = (2 * distance * tanHalfFov * aspect) / Math.max(1, Math.ceil(frameWidth / HIZ_BASE_DIVISOR));
  return level0Texel * (1 << level) + HIZ_BIAS_FLOOR;
}

function storageR32(width, height) {
  const t = new StorageTexture(width, height);
  t.format = THREE.RedFormat; t.type = THREE.FloatType;
  t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}

// GPU chain. `depthTexture` is the scene pass's depth attachment; `camera` gives near/far and the
// view-projection the kernels test against. Sizes follow the renderer's drawing buffer.
export function createHiZ({ renderer, camera, depthTexture, levels = 8 }) {
  const state = {
    enabled: true, atlas: null, atlasWidth: 0, atlasHeight: 0, levels: [], frameWidth: 0, frameHeight: 0,
    viewProj: new THREE.Matrix4(), cameraPosition: new THREE.Vector3(), near: camera.near, far: camera.far,
    tanHalfFov: Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5), aspect: camera.aspect, revision: 0,
  };
  const stats = { levels: 0, dispatches: 0, lastUpdateCpuMs: 0 };
  const uNear = uniform(camera.near), uFar = uniform(camera.far);
  let textures = [], atlas = null, kernels = [];
  const size = new THREE.Vector2();

  function dispose() {
    for (const t of textures) t.dispose();
    atlas?.dispose();
    textures = []; kernels = []; atlas = null; state.atlas = null; state.levels = [];
  }

  function build(frameWidth, frameHeight) {
    dispose();
    const sizes = hizLevelSizes(frameWidth, frameHeight, levels);
    const layout = hizAtlasLayout(sizes);
    // The last level needs no texture of its own: nothing reduces from it.
    textures = sizes.slice(0, -1).map(({ width, height }) => storageR32(width, height));
    atlas = storageR32(layout.width, layout.height);
    const depthLoad = texture(depthTexture).setSampler(false);
    kernels = [];
    for (let i = 0; i < sizes.length; i++) {
      const { width, height } = sizes[i];
      const at = layout.levels[i];
      const src = i > 0 ? texture(textures[i - 1]).setSampler(false) : null;
      const srcMax = i > 0 ? ivec2(sizes[i - 1].width - 1, sizes[i - 1].height - 1) : null;
      const own = textures[i] || null;
      kernels.push(Fn(() => {
        const xy = ivec2(int(instanceIndex).mod(int(width)), int(instanceIndex).div(int(width)));
        let value;
        if (i === 0) {
          // Level 0: the pass depth at every other pixel, made linear.
          value = perspectiveDepthToViewZ(depthLoad.load(xy.mul(int(HIZ_BASE_DIVISOR))).x, uNear, uFar).negate();
        } else {
          const b = xy.mul(int(2));
          const a = min(b, srcMax), c = min(b.add(int(1)), srcMax);
          value = max(max(src.load(ivec2(a.x, a.y)).x, src.load(ivec2(c.x, a.y)).x),
            max(src.load(ivec2(a.x, c.y)).x, src.load(ivec2(c.x, c.y)).x));
        }
        const out = vec4(value, 0, 0, 1);
        if (own) textureStore(own, xy, out).toWriteOnly();
        textureStore(atlas, xy.add(ivec2(at.x, at.y)), out).toWriteOnly();
      })().compute(width * height));
    }
    state.atlas = atlas; state.atlasWidth = layout.width; state.atlasHeight = layout.height;
    state.levels = layout.levels.map(l => ({ ...l }));
    state.frameWidth = frameWidth; state.frameHeight = frameHeight;
    stats.levels = sizes.length;
  }

  return {
    state, stats, kernels: () => kernels,
    setEnabled(v) { state.enabled = !!v; },
    // After the render: reduce the frame just drawn and remember the camera that drew it.
    async update() {
      if (!state.enabled) return false;
      const t0 = performance.now();
      renderer.getDrawingBufferSize(size);
      if (size.x !== state.frameWidth || size.y !== state.frameHeight) build(size.x, size.y);
      uNear.value = camera.near; uFar.value = camera.far;
      state.near = camera.near; state.far = camera.far;
      state.tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5); state.aspect = camera.aspect;
      state.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      camera.getWorldPosition(state.cameraPosition);
      await renderer.computeAsync(kernels);
      stats.dispatches += kernels.length;
      state.revision++;
      stats.lastUpdateCpuMs = performance.now() - t0;
      return true;
    },
    dispose,
  };
}
