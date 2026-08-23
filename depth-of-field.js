// depth-of-field.js — gather depth of field for the WebGPU node post pipeline.
//
// Port of demos/sdf-bug-v2.html's `dofPass`: for each pixel, sample a golden-angle disc of
// neighbours and keep each tap only in so far as its OWN circle of confusion reaches this pixel,
// which stops a blurred background bleeding over a sharp subject. The demo read depth it had
// stored itself; here it comes from the scene pass depth attachment, converted to view distance.
// Focus is either a hand-set distance or whatever sits at frame centre (one depth fetch).
//
// createDepthOfField({ scenePass, params }) -> { node, uniforms, setParams }. `node` is the
// colour to feed into renderOutput (or a grade). Gather runs on the HDR colour, so highlights
// spread into bright discs instead of grey mush.

import {
  Fn, uv, vec2, vec3, vec4, float, uniform, texture, mix, clamp, abs, step, max, sqrt, cos, sin, length,
  Loop, hash, perspectiveDepthToViewZ, cameraNear, cameraFar, screenSize,
} from 'three/tsl';

export const DOF_DEFAULTS = Object.freeze({
  enabled: false,
  autoFocus: true,       // focus on whatever is at frame centre
  focusDistance: 6,      // m, when autoFocus is off
  aperture: 0.9,         // blur growth per unit of normalized defocus (bigger = shallower)
  maxRadius: 14,         // px, largest blur circle
  farScale: 2.1,         // the far side of focus falls apart this much faster than the near side
  focusRate: 6,          // 1/s, how fast auto focus settles (pulled on the CPU each frame)
  taps: 48,
});

export function createDepthOfField({ scenePass, params = {} } = {}) {
  const p = { ...DOF_DEFAULTS, ...params };
  const u = {
    enabled: uniform(p.enabled ? 1 : 0),
    autoFocus: uniform(p.autoFocus ? 1 : 0),
    focusDistance: uniform(p.focusDistance),
    aperture: uniform(p.aperture),
    maxRadius: uniform(p.maxRadius),
    farScale: uniform(p.farScale),
    focusSmoothed: uniform(p.focusDistance),   // CPU-eased auto focus, read back from the picture
  };
  const TAPS = Math.max(8, Math.min(96, p.taps | 0));
  const colorTex = scenePass.getTextureNode('output');
  const depthTex = scenePass.getTextureNode('depth');

  // View distance (positive metres) of the scene at a screen uv, from the pass depth attachment.
  const distanceAt = (q) => perspectiveDepthToViewZ(depthTex.sample(q).x, cameraNear, cameraFar).negate();

  const node = Fn(() => {
    const q = uv();
    const texel = vec2(1).div(screenSize);
    const here = colorTex.sample(q);
    const dHere = distanceAt(q);
    // Focus in metres: the smoothed centre distance, or the slider. Defocus is measured as a
    // fraction of the focus distance so the same aperture reads the same at 3 m and at 30 m.
    const focus = mix(u.focusDistance, u.focusSmoothed, u.autoFocus);
    const cocOf = (d) => {
      const s = d.sub(focus).div(max(focus, float(0.05)));
      return clamp(abs(s).mul(mix(float(1.0), u.farScale, step(float(0), s))).mul(u.aperture), 0, 1);
    };
    const rHere = cocOf(dHere).mul(u.maxRadius).mul(u.enabled);
    const acc = here.xyz.toVar();
    const wsum = float(1).toVar();
    // Per-pixel angular jitter turns spiral spokes into fine grain.
    const jitter = hash(q.x.mul(screenSize.x).add(q.y.mul(screenSize.y).mul(7919.0))).mul(6.2831853);
    Loop(TAPS, ({ i }) => {
      const fi = float(i);
      const ang = fi.mul(2.39996).add(jitter);
      const rad = sqrt(fi.add(0.5).div(TAPS));
      const off = vec2(cos(ang), sin(ang)).mul(rad.mul(rHere));
      const sq = q.add(off.mul(texel));
      const s = colorTex.sample(sq);
      const rThere = cocOf(distanceAt(sq)).mul(u.maxRadius).mul(u.enabled);
      const w = clamp(rThere.sub(length(off)).add(1.0), 0, 1);
      acc.addAssign(s.xyz.mul(w));
      wsum.addAssign(w);
    });
    return vec4(acc.div(max(wsum, float(1e-4))), here.w);
  })();

  function setParams(next) {
    if (!next) return;
    if (next.enabled !== undefined) u.enabled.value = next.enabled ? 1 : 0;
    if (next.autoFocus !== undefined) u.autoFocus.value = next.autoFocus ? 1 : 0;
    if (Number.isFinite(next.focusDistance)) u.focusDistance.value = next.focusDistance;
    if (Number.isFinite(next.aperture)) u.aperture.value = next.aperture;
    if (Number.isFinite(next.maxRadius)) u.maxRadius.value = next.maxRadius;
    if (Number.isFinite(next.farScale)) u.farScale.value = next.farScale;
    if (Number.isFinite(next.focusRate)) p.focusRate = next.focusRate;
  }

  // Auto focus is eased on the CPU from a distance the page measures (a centre ray against the
  // world), so the picture never snaps focus when the crosshair crosses an edge.
  function updateFocus(dt, measuredDistance) {
    if (!Number.isFinite(measuredDistance)) return u.focusSmoothed.value;
    const k = 1 - Math.exp(-Math.max(0, p.focusRate) * Math.max(0, dt));
    u.focusSmoothed.value += (measuredDistance - u.focusSmoothed.value) * k;
    return u.focusSmoothed.value;
  }

  return { node, uniforms: u, setParams, updateFocus, get params() { return { ...p }; } };
}
