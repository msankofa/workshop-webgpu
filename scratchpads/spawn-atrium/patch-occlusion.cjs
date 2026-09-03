// One-off patch script: adds the occluder depth test to grass-compute.js and plants-gpu.js and
// wires flora-occlusion.js through bot-flora.js. Run from the repo root: node scratchpads/spawn-atrium/patch-occlusion.cjs
const fs = require('fs');
// Matches across mixed line endings: every newline in a pattern accepts CRLF or LF.
const rx = (a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'));
function patch(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) { const r = rx(a); if (!r.test(s)) throw new Error(file + ' missing: ' + a.slice(0, 80)); s = s.replace(r, () => b); }
  fs.writeFileSync(file, s);
}
const OCC_SETUP = `  // Occlusion against flora-occlusion.js's depth image: project the candidate with the same
  // view-projection, read the stored view depth at the point and its four neighbours, and drop
  // it when it is deeper than all of them by more than the bias. Without an occlusion option the
  // test is not compiled in at all.
  const occlusion = opts.occlusion || null;
  const uOccOn = uniform(occlusion && occlusion.enabled ? 1 : 0);
  const uOccVP = uniform(new THREE.Matrix4());
  const uOccTexel = uniform(new THREE.Vector2(1 / 256, 1 / 256));
  const uOccBias = uniform(occlusion ? occlusion.bias : 0.45);
  const occludedFn = occlusion
    ? (wx, wy, wz) => {
        const clip = uOccVP.mul(vec4(wx, wy, wz, 1.0));
        const w = clip.w;
        const uv = clip.xy.div(w.max(0.001)).mul(0.5).add(0.5);
        const inside = w.greaterThan(0.05)
          .and(uv.x.greaterThan(0)).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
        const tx = vec2(uOccTexel.x, 0), tz = vec2(0, uOccTexel.y);
        const far = max(max(texture(occlusion.texture, uv).r, texture(occlusion.texture, uv.add(tx)).r),
          max(texture(occlusion.texture, uv.sub(tx)).r, max(texture(occlusion.texture, uv.add(tz)).r, texture(occlusion.texture, uv.sub(tz)).r)));
        return uOccOn.greaterThan(0.5).and(inside).and(w.greaterThan(far.add(uOccBias).add(w.mul(0.02))));
      }
    : null;
  function syncOcclusion() {
    if (!occlusion) return false;
    const on = occlusion.enabled ? 1 : 0;
    const changed = uOccOn.value !== on || !uOccVP.value.equals(occlusion.viewProj);
    uOccOn.value = on;
    uOccVP.value.copy(occlusion.viewProj);
    uOccTexel.value.copy(occlusion.texel);
    uOccBias.value = occlusion.bias;
    return changed;
  }
`;
patch('grass-compute.js', [
  [`  vec2, vec3, vec4, sin, cos, floor, mix, clamp, length, smoothstep, positionLocal, positionWorld,`,
   `  vec2, vec3, vec4, sin, cos, floor, mix, clamp, length, smoothstep, positionLocal, positionWorld, max,`],
  [`  const inConeFn = (wx, wz, dist) => {`, OCC_SETUP + `  const inConeFn = (wx, wz, dist) => {`],
  [`        .and(inConeFn(wx, wz, dist))
        .and(keepRand.greaterThan(edge))
        .and(a.w.lessThan(biomeDensity));`,
   `        .and(inConeFn(wx, wz, dist))
        .and(occludedFn ? occludedFn(wx, wy.add(0.2), wz).not() : float(1).greaterThan(0))
        .and(keepRand.greaterThan(edge))
        .and(a.w.lessThan(biomeDensity));`],
  [`        .and(inConeFn(wx, wz, dist))
        .and(keepRand.greaterThan(edge))
        .and(densityRand.lessThan(biomeDensity));`,
   `        .and(inConeFn(wx, wz, dist))
        .and(occludedFn ? occludedFn(wx, wy.add(0.2), wz).not() : float(1).greaterThan(0))
        .and(keepRand.greaterThan(edge))
        .and(densityRand.lessThan(biomeDensity));`],
  [`      const coneChanged = cone.fx !== lastFx || cone.fz !== lastFz || cone.cos !== lastCos;
      if (recullMode !== 'frame' && !dirty && !cellChanged && !coneChanged) {`,
   `      const coneChanged = cone.fx !== lastFx || cone.fz !== lastFz || cone.cos !== lastCos;
      // Occlusion depends on the exact camera, so any camera change re-culls while it is on.
      const occChanged = syncOcclusion();
      if (recullMode !== 'frame' && !dirty && !cellChanged && !coneChanged && !occChanged) {`],
]);
patch('plants-gpu.js', [
  [`  atomicAdd, atomicStore, atomicLoad, time, mix, dot,`, `  atomicAdd, atomicStore, atomicLoad, time, mix, dot, vec4, texture, max,`],
  [`  const uNearKeep = uniform(opts.nearKeep ?? 8);`, `  const uNearKeep = uniform(opts.nearKeep ?? 8);
` + OCC_SETUP],
  [`      const live = dist.lessThan(uCullRadius).and(keepRand.greaterThan(edge)).and(inCone);`,
   `      const unoccluded = occludedFn ? occludedFn(rec0.x, rec0.y.add(0.5), rec0.z).not() : float(1).greaterThan(0);
      const live = dist.lessThan(uCullRadius).and(keepRand.greaterThan(edge)).and(inCone).and(unoccluded);`],
  [`      const cone = coneFor();
      if (!dirty && camX === lastCamX && camZ === lastCamZ && cone.fx === lastFx && cone.fz === lastFz && cone.cos === lastCos) return;`,
   `      const cone = coneFor();
      const occChanged = syncOcclusion();
      if (!dirty && !occChanged && camX === lastCamX && camZ === lastCamZ && cone.fx === lastFx && cone.fz === lastFz && cone.cos === lastCos) return;`],
]);
// bot-flora: single-line anchors only (the file has mixed line endings).
let s = fs.readFileSync('bot-flora.js', 'utf8');
const rep = (a, b) => { const r = rx(a); if (!r.test(s)) throw new Error('bot-flora missing: ' + a.slice(0, 80)); s = s.replace(r, () => b); };
rep(`import { createGrass } from './grass.js';`, `import { createGrass } from './grass.js';
import { createFloraOcclusion } from './flora-occlusion.js';`);
rep(`  THREE, renderer, camera, parent, seed = 1, onStats = () => {}, clearFn = null,`,
    `  THREE, renderer, camera, parent, seed = 1, onStats = () => {}, clearFn = null, occluders = null, occlusionSize = 256,`);
rep(`  let computeGrass = null, computeTex = null, computePending = null;`,
    `  let computeGrass = null, computeTex = null, computePending = null;
  // Occluder depth for the GPU culls. Built only when the host names its occluders, because the
  // kernels compile the test in at creation and the mesh grass path has no use for it.
  const occlusion = occluders ? createFloraOcclusion({ renderer, scene: parent, camera, size: occlusionSize }) : null;
  if (occlusion) occlusion.markOccluders(occluders);`);
rep(`        renderer, camera,
        density: flora.grassDensity, radius, maxRadius: radius, maxInstances: 2_000_000,`,
    `        renderer, camera, occlusion: occlusion ? occlusion.state : null,
        density: flora.grassDensity, radius, maxRadius: radius, maxInstances: 2_000_000,`);
rep(`      renderer, camera, palette, heightAt: (x, z) => groundAt(x, z),`,
    `      renderer, camera, palette, heightAt: (x, z) => groundAt(x, z), occlusion: occlusion ? occlusion.state : null,`);
rep(`      for (const g of grassTiles) g.update(seconds);`,
    `      if (occlusion && occlusion.state.enabled && (computeGrass || (plants && stats.plants > 0))) occlusion.update();
      for (const g of grassTiles) g.update(seconds);`);
rep(`    async grassVisible() { return computeGrass ? computeGrass.readBladeCount() : null; },`,
    `    async grassVisible() { return computeGrass ? computeGrass.readBladeCount() : null; },
    // Occlusion: re-mark after a layout rebuild (new meshes), toggle live, read whether it exists.
    markOccluders(root) { return occlusion ? occlusion.markOccluders(root) : 0; },
    setOcclusionEnabled(on) { if (occlusion) occlusion.setEnabled(on); },
    get occlusion() { return occlusion ? occlusion.state : null; },`);
rep(`      vineMat.dispose();
      parent.remove(root);`, `      vineMat.dispose();
      if (occlusion) occlusion.dispose();
      parent.remove(root);`);
fs.writeFileSync('bot-flora.js', s);
console.log('all patched');
