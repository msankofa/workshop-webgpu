// hiz-test.js — the occlusion test both cull kernels run against a hiz-pyramid.js pyramid.
//
// occluded(bmin, bmax): project the eight corners of a world-space box with the camera that
// drew the pyramid, take the screen rectangle and the nearest depth, pick the level whose texel
// covers the rectangle in at most 2x2 texels, read those four, and call the box hidden only when
// its nearest point is behind the FARTHEST of them by more than the bias (one texel's world
// footprint at that depth plus a floor). A box that straddles the near plane or leaves the screen
// is never called hidden; the cone test owns those.
//
// forest-cull.js carries the CPU twin, occludedByHiZ(); keep the two in step.

import * as THREE from 'three';
import { Fn, If, bool, float, int, ivec2, vec2, vec3, vec4, uniform, texture, max, min, floor, clamp, select } from 'three/tsl';
import { HIZ_BIAS_FLOOR, HIZ_BASE_DIVISOR } from './hiz-pyramid.js';

export const HIZ_NEAR_W = 0.05;   // a corner closer than this is treated as straddling the near plane

// `levels` caps the bindings a kernel spends on the pyramid (the grass cull stage is near the
// sampled-texture limit); a footprint past the last bound level uses that level's texels.
export function createHizSampler(hiz, { levels = 8 } = {}) {
  const bound = Math.max(1, Math.min(levels, hiz.levels.length || levels));
  const uOn = uniform(hiz.enabled ? 1 : 0);
  const uVP = uniform(new THREE.Matrix4());
  const uSize0 = uniform(new THREE.Vector2(1, 1));       // level 0 size in texels
  const uTexelWorld = uniform(0);                        // level-0 texel width in world units per metre of depth
  const texNodes = [], uSizes = [];
  for (let i = 0; i < bound; i++) {
    const lv = hiz.levels[i];
    texNodes.push(texture(lv ? lv.texture : new THREE.DataTexture(new Float32Array(1), 1, 1, THREE.RedFormat, THREE.FloatType)).setSampler(false));
    uSizes.push(uniform(new THREE.Vector2(lv ? lv.width : 1, lv ? lv.height : 1)));
  }

  const occluded = Fn(([bmin, bmax]) => {
    const hidden = bool(false).toVar();
    If(uOn.greaterThan(0.5), () => {
      const lo = vec2(1e9, 1e9).toVar(), hi = vec2(-1e9, -1e9).toVar();
      const nearest = float(1e9).toVar();
      const straddle = bool(false).toVar();
      for (let c = 0; c < 8; c++) {
        const p = vec3(c & 1 ? bmax.x : bmin.x, c & 2 ? bmax.y : bmin.y, c & 4 ? bmax.z : bmin.z);
        const clip = uVP.mul(vec4(p, 1.0));
        const w = clip.w;
        straddle.assign(straddle.or(w.lessThan(HIZ_NEAR_W)));
        const ndc = clip.xy.div(max(w, float(HIZ_NEAR_W)));
        lo.assign(min(lo, ndc)); hi.assign(max(hi, ndc));
        nearest.assign(min(nearest, w));
      }
      const onScreen = hi.x.greaterThan(-1).and(lo.x.lessThan(1)).and(hi.y.greaterThan(-1)).and(lo.y.lessThan(1));
      If(straddle.not().and(onScreen), () => {
        // uv with V down (WebGPU render targets keep row 0 at the top), clipped to the screen.
        const uvLo = vec2(clamp(lo.x.mul(0.5).add(0.5), 0, 1), clamp(float(0.5).sub(hi.y.mul(0.5)), 0, 1));
        const uvHi = vec2(clamp(hi.x.mul(0.5).add(0.5), 0, 1), clamp(float(0.5).sub(lo.y.mul(0.5)), 0, 1));
        const extent = max(uvHi.x.sub(uvLo.x).mul(uSize0.x), uvHi.y.sub(uvLo.y).mul(uSize0.y));
        const level = int(0).toVar();
        for (let i = 1; i < bound; i++) If(extent.greaterThan(float(2 * (1 << (i - 1)))), () => { level.assign(int(i)); });
        const farthest = float(0).toVar();
        for (let i = 0; i < bound; i++) {
          If(level.equal(int(i)), () => {
            const sz = uSizes[i];
            const maxT = ivec2(int(sz.x).sub(int(1)), int(sz.y).sub(int(1)));
            const a = min(ivec2(floor(uvLo.mul(sz))), maxT), b = min(ivec2(floor(uvHi.mul(sz))), maxT);
            const t = texNodes[i];
            farthest.assign(max(max(t.load(ivec2(a.x, a.y)).x, t.load(ivec2(b.x, a.y)).x),
              max(t.load(ivec2(a.x, b.y)).x, t.load(ivec2(b.x, b.y)).x)));
          });
        }
        const levelScale = float(1).toVar();
        for (let i = 1; i < bound; i++) If(level.equal(int(i)), () => { levelScale.assign(float(1 << i)); });
        const bias = nearest.mul(uTexelWorld).mul(levelScale).add(float(HIZ_BIAS_FLOOR));
        hidden.assign(nearest.greaterThan(farthest.add(bias)));
      });
    });
    return hidden;
  });

  let lastRevision = -1;
  // Copy the pyramid's state into the uniforms; true when a recull is warranted.
  function sync() {
    const on = hiz.enabled && hiz.levels.length ? 1 : 0;
    const changed = uOn.value !== on || (!!on && (lastRevision !== hiz.revision || !uVP.value.equals(hiz.viewProj)));
    uOn.value = on;
    if (!on) return changed;
    lastRevision = hiz.revision;
    uVP.value.copy(hiz.viewProj);
    uSize0.value.set(hiz.levels[0].width, hiz.levels[0].height);
    uTexelWorld.value = (2 * hiz.tanHalfFov * hiz.aspect) / Math.max(1, Math.ceil(hiz.frameWidth / HIZ_BASE_DIVISOR));
    for (let i = 0; i < bound; i++) {
      const lv = hiz.levels[Math.min(i, hiz.levels.length - 1)];
      if (texNodes[i].value !== lv.texture) texNodes[i].value = lv.texture;
      uSizes[i].value.set(lv.width, lv.height);
    }
    return changed;
  }

  return { occluded, sync, bound, get enabled() { return uOn.value > 0.5; } };
}
