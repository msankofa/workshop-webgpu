// hiz-test.js — the occlusion test both cull kernels run against a hiz-pyramid.js pyramid.
//
// occluded(bmin, bmax): project the eight corners of a world-space box with the camera that
// drew the pyramid, take the screen rectangle and the nearest depth, pick the level whose texel
// covers the rectangle in at most 2x2 texels, read those four from the atlas, and call the box
// hidden only when its nearest point is behind the FARTHEST of them by more than the bias (one
// texel's world footprint at that depth plus a floor). A box that straddles the near plane or
// leaves the screen is never called hidden; the cone test owns those.
//
// One texture binding: the atlas. forest-cull.js carries the CPU twin, occludedByHiZ(); keep the
// two in step.

import * as THREE from 'three';
import { Fn, If, bool, float, int, ivec2, vec2, vec3, vec4, uniform, texture, max, min, floor, clamp } from 'three/tsl';
import { HIZ_BIAS_FLOOR, HIZ_BASE_DIVISOR } from './hiz-pyramid.js';

export const HIZ_NEAR_W = 0.05;   // a corner closer than this is treated as straddling the near plane
export const HIZ_MAX_LEVELS = 8;

const placeholder = () => new THREE.DataTexture(new Float32Array(1), 1, 1, THREE.RedFormat, THREE.FloatType);

export function createHizSampler(hiz) {
  const uOn = uniform(hiz.enabled ? 1 : 0);
  const uVP = uniform(new THREE.Matrix4());
  const uLevelCount = uniform(1);
  const uTexelWorld = uniform(0);                        // level-0 texel width in world units per metre of depth
  const uRects = [];                                     // per level: atlas x, y, width, height
  for (let i = 0; i < HIZ_MAX_LEVELS; i++) uRects.push(uniform(new THREE.Vector4(0, 0, 1, 1)));
  const atlasNode = texture(hiz.atlas || placeholder()).setSampler(false);

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
        const size0 = uRects[0].zw;
        const extent = max(uvHi.x.sub(uvLo.x).mul(size0.x), uvHi.y.sub(uvLo.y).mul(size0.y));
        const rect = vec4(uRects[0]).toVar();
        const levelScale = float(1).toVar();
        for (let i = 1; i < HIZ_MAX_LEVELS; i++) {
          If(extent.greaterThan(float(2 * (1 << (i - 1)))).and(uLevelCount.greaterThan(float(i))), () => {
            rect.assign(uRects[i]); levelScale.assign(float(1 << i));
          });
        }
        const maxT = ivec2(int(rect.z).sub(int(1)), int(rect.w).sub(int(1)));
        const origin = ivec2(int(rect.x), int(rect.y));
        const a = min(ivec2(floor(uvLo.mul(rect.zw))), maxT).add(origin), b = min(ivec2(floor(uvHi.mul(rect.zw))), maxT).add(origin);
        const farthest = max(max(atlasNode.load(ivec2(a.x, a.y)).x, atlasNode.load(ivec2(b.x, a.y)).x),
          max(atlasNode.load(ivec2(a.x, b.y)).x, atlasNode.load(ivec2(b.x, b.y)).x));
        const bias = nearest.mul(uTexelWorld).mul(levelScale).add(float(HIZ_BIAS_FLOOR));
        hidden.assign(nearest.greaterThan(farthest.add(bias)));
      });
    });
    return hidden;
  });

  let lastRevision = -1;
  // Copy the pyramid's state into the uniforms; true when a recull is warranted.
  function sync() {
    const on = hiz.enabled && hiz.levels.length && hiz.atlas ? 1 : 0;
    const changed = uOn.value !== on || (!!on && (lastRevision !== hiz.revision || !uVP.value.equals(hiz.viewProj)));
    uOn.value = on;
    if (!on) return changed;
    lastRevision = hiz.revision;
    uVP.value.copy(hiz.viewProj);
    uTexelWorld.value = (2 * hiz.tanHalfFov * hiz.aspect) / Math.max(1, Math.ceil(hiz.frameWidth / HIZ_BASE_DIVISOR));
    const n = Math.min(HIZ_MAX_LEVELS, hiz.levels.length);
    uLevelCount.value = n;
    for (let i = 0; i < n; i++) { const l = hiz.levels[i]; uRects[i].value.set(l.x, l.y, l.width, l.height); }
    if (atlasNode.value !== hiz.atlas) atlasNode.value = hiz.atlas;
    return changed;
  }

  return { occluded, sync, get enabled() { return uOn.value > 0.5; } };
}
