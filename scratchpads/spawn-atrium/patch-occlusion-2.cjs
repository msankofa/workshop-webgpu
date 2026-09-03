// Second occlusion patch: the projection becomes the visibility test (screen bounds with a
// margin, base or top), and occlusion is tested at the candidate's top. Run from the repo root.
const fs = require('fs');
const rx = (a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'));
function patch(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) { const r = rx(a); if (!r.test(s)) throw new Error(file + ' missing: ' + a.slice(0, 80)); s = s.replace(r, () => b); }
  fs.writeFileSync(file, s);
}
const OLD_FN = `  const occludedFn = occlusion
    ? (wx, wy, wz) => {
        const clip = uOccVP.mul(vec4(wx, wy, wz, 1.0));
        const w = clip.w;
        // WebGPU samples a render target with row 0 at the top and the WGSL builder adds no flip,
        // so V runs down from clip-space +y.
        const ndc = clip.xy.div(w.max(0.001));
        const uv = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
        const inside = w.greaterThan(0.05)
          .and(uv.x.greaterThan(0)).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
        const tx = vec2(uOccTexel.x, 0), tz = vec2(0, uOccTexel.y);
        const far = max(max(texture(occlusion.texture, uv).r, texture(occlusion.texture, uv.add(tx)).r),
          max(texture(occlusion.texture, uv.sub(tx)).r, max(texture(occlusion.texture, uv.add(tz)).r, texture(occlusion.texture, uv.sub(tz)).r)));
        return uOccOn.greaterThan(0.5).and(inside).and(w.greaterThan(far.add(uOccBias).add(w.mul(0.02))));
      }
    : null;`;
const NEW_FN = `  // keepFn(wx, wy, wz, h, dist): the projection is the visibility test. A candidate survives when
  // its base or its top (h above) projects inside the screen with a margin, or it is within
  // 1.5 m; it is then occlusion-tested at its top, because walls hide things from the ground
  // up. Behind the camera or off screen is simply not visible, never "not occluded".
  const NDC_MARGIN = 1.15;
  const project = (wx, wy, wz) => {
    const clip = uOccVP.mul(vec4(wx, wy, wz, 1.0));
    const w = clip.w;
    const ndc = clip.xy.div(w.max(0.001));
    const onScreen = w.greaterThan(0.05)
      .and(ndc.x.greaterThan(-NDC_MARGIN)).and(ndc.x.lessThan(NDC_MARGIN))
      .and(ndc.y.greaterThan(-NDC_MARGIN)).and(ndc.y.lessThan(NDC_MARGIN));
    return { w, ndc, onScreen };
  };
  const keepFn = occlusion
    ? (wx, wy, wz, h, dist) => {
        const base = project(wx, wy, wz);
        const top = project(wx, wy.add(h), wz);
        const visible = base.onScreen.or(top.onScreen).or(dist.lessThan(1.5));
        // WebGPU samples a render target with row 0 at the top and the WGSL builder adds no flip,
        // so V runs down from clip-space +y.
        const uv = vec2(clamp(top.ndc.x.mul(0.5).add(0.5), 0, 1), clamp(float(0.5).sub(top.ndc.y.mul(0.5)), 0, 1));
        const tx = vec2(uOccTexel.x, 0), tz = vec2(0, uOccTexel.y);
        const far = max(max(texture(occlusion.texture, uv).r, texture(occlusion.texture, uv.add(tx)).r),
          max(texture(occlusion.texture, uv.sub(tx)).r, max(texture(occlusion.texture, uv.add(tz)).r, texture(occlusion.texture, uv.sub(tz)).r)));
        const occluded = uOccOn.greaterThan(0.5).and(top.onScreen).and(top.w.greaterThan(far.add(uOccBias).add(top.w.mul(0.02))));
        return visible.and(occluded.not());
      }
    : null;`;
patch('grass-compute.js', [
  [OLD_FN, NEW_FN],
  [`        .and(occludedFn ? occludedFn(wx, wy.add(0.2), wz).not() : float(1).greaterThan(0))
        .and(keepRand.greaterThan(edge))
        .and(a.w.lessThan(biomeDensity));`,
   `        .and(keepFn ? keepFn(wx, wy, wz, uBladeHeight.mul(1.2), dist) : float(1).greaterThan(0))
        .and(keepRand.greaterThan(edge))
        .and(a.w.lessThan(biomeDensity));`],
  [`        .and(occludedFn ? occludedFn(wx, wy.add(0.2), wz).not() : float(1).greaterThan(0))
        .and(keepRand.greaterThan(edge))
        .and(densityRand.lessThan(biomeDensity));`,
   `        .and(keepFn ? keepFn(wx, wy, wz, uBladeHeight.mul(1.2), dist) : float(1).greaterThan(0))
        .and(keepRand.greaterThan(edge))
        .and(densityRand.lessThan(biomeDensity));`],
]);
patch('plants-gpu.js', [
  [OLD_FN, NEW_FN],
  [`      const unoccluded = occludedFn ? occludedFn(rec0.x, rec0.y.add(0.5), rec0.z).not() : float(1).greaterThan(0);`,
   `      const unoccluded = keepFn ? keepFn(rec0.x, rec0.y, rec0.z, float(1.4), dist) : float(1).greaterThan(0);`],
]);
console.log('patched');
