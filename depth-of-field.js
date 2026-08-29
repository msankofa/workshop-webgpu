// depth-of-field.js — gather depth of field for the WebGPU node post pipeline.
//
// Port of demos/sdf-bug-v2.html's `dofPass`: each pixel gathers a golden-angle disc scaled by its
// OWN circle of confusion, so an in-focus pixel's disc collapses and it stays sharp — that disc
// scaling, not the tap weight, is what keeps background blur off a sharp subject. The tap weight
// only stops a sharper neighbour polluting a blurred pixel. Known single-pass limit: a NEAR
// blurred object keeps a hard silhouette over a sharp background (three's dof() addon separates
// near/far fields if that ever matters). Depth comes from the scene pass attachment, linearized
// with the SCENE camera's planes held in our own uniforms — the global cameraNear/cameraFar nodes
// would read the post quad's ortho camera (near 0, far 1) and flatten every depth to zero.
// Focus is either a hand-set distance or whatever sits at frame centre (one depth fetch).
//
// createDepthOfField({ scenePass, camera, params }) -> { node, uniforms, setParams, updateFocus }.
// `node` is the colour to feed into renderOutput (or a grade). Gather runs on the HDR colour, so
// highlights spread into bright discs instead of grey mush.

import {
  Fn, If, uv, vec2, vec4, float, uniform, mix, clamp, abs, step, max, sqrt, cos, sin, length,
  Loop, hash, perspectiveDepthToViewZ, screenSize,
} from 'three/tsl';

export const DOF_DEFAULTS = Object.freeze({
  enabled: false,
  autoFocus: true,       // focus on whatever is at frame centre
  focusDistance: 6,      // m, when autoFocus is off
  aperture: 0.9,         // blur growth per unit of normalized defocus (bigger = shallower)
  maxRadius: 14,         // px, largest blur circle
  farScale: 2.1,         // the far side of focus falls apart this much faster than the near side
  focusRate: 6,          // 1/s, how fast auto focus settles (pulled on the CPU each frame)
  taps: 48,              // baked into the shader loop at build — changing it means a new node
});

export function createDepthOfField({ scenePass, camera, params = {} } = {}) {
  if (!camera) throw new Error('createDepthOfField needs the scene camera (near/far for depth linearization)');
  const p = { ...DOF_DEFAULTS, ...params };
  const u = {
    enabled: uniform(p.enabled ? 1 : 0),
    autoFocus: uniform(p.autoFocus ? 1 : 0),
    focusDistance: uniform(p.focusDistance),
    aperture: uniform(p.aperture),
    maxRadius: uniform(p.maxRadius),
    farScale: uniform(p.farScale),
    focusSmoothed: uniform(p.focusDistance),   // CPU-eased auto focus, read back from the picture
    // Scene camera planes, refreshed every render from the closed-over camera.
    sceneNear: uniform(camera.near).onRenderUpdate(() => camera.near),
    sceneFar: uniform(camera.far).onRenderUpdate(() => camera.far),
  };
  const TAPS = Math.max(8, Math.min(96, p.taps | 0));
  const colorTex = scenePass.getTextureNode('output');
  const depthTex = scenePass.getTextureNode('depth');

  // View distance (positive metres) at a screen uv. The Lod variant samples with an explicit
  // level so it stays legal inside the non-uniform early-out branch (no implicit derivatives).
  const distanceAt = (q) => perspectiveDepthToViewZ(depthTex.sample(q).x, u.sceneNear, u.sceneFar).negate();
  const distanceAtLod = (q) => perspectiveDepthToViewZ(depthTex.sample(q).level(0).x, u.sceneNear, u.sceneFar).negate();

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
    const result = here.toVar();
    // Sharp (or disabled) pixels skip the whole gather; the branch implies enabled = 1.
    If(rHere.greaterThan(float(0.5)), () => {
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
        const s = colorTex.sample(sq).level(0);
        const rThere = cocOf(distanceAtLod(sq)).mul(u.maxRadius);
        const w = clamp(rThere.sub(length(off)).add(1.0), 0, 1);
        acc.addAssign(s.xyz.mul(w));
        wsum.addAssign(w);
      });
      result.assign(vec4(acc.div(max(wsum, float(1e-4))), here.w));
    });
    return result;
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
