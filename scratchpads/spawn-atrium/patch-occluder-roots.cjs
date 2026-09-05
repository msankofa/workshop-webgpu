// Applies the multi-root occluder change to a file path given on argv (works on HEAD copies too).
const fs = require('fs');
const [,, file, which] = process.argv;
let s = fs.readFileSync(file, 'utf8');
const eol = s.includes('\r\n') ? '\r\n' : '\n';
const rep = (a, b) => {
  a = a.split('\n').join(eol); b = b.split('\n').join(eol);
  if (!s.includes(a)) throw new Error(`${which}: missing: ${a.slice(0, 60)}`);
  s = s.replace(a, b);
};
if (which === 'occ') {
  rep(`  // Opaque meshes under \`root\` become occluders; transparent ones (water) stay out.
  function markOccluders(root) {`,
`  // Opaque meshes under \`root\` become occluders; transparent ones (water) stay out. \`filter\`
  // narrows further (the terrain root also holds clipmap rings placed by a position node).
  function markOccluders(root, filter = null) {`);
  rep(`      if (!o.isMesh || (o.material && o.material.transparent)) return;`,
      `      if (!o.isMesh || (o.material && o.material.transparent) || (filter && !filter(o))) return;`);
} else {
  rep(`  let occlusion = null, occluderRoot = null;`, `  let occlusion = null, occluderRoots = [];`);
  rep(`    // The group whose opaque meshes occlude blades. The kernels compile the test in at build, so
    // the first call before the grass exists is free; a later first call rebuilds the field.
    setOccluders(root) {
      occluderRoot = root || null;
      if (!occluderRoot) { if (occlusion) occlusion.setEnabled(false); return; }
      if (!occlusion) {
        occlusion = createFloraOcclusion({ renderer, scene, camera, cacheStatic: true });
        if (grass) rebuild();
      }
      occlusion.setEnabled(true);
      occlusion.markOccluders(occluderRoot);
    },`,
`    // The groups whose opaque meshes occlude blades: one Object3D, or a list of Object3D or
    // { root, filter }. The kernels compile the test in at build, so the first call before the
    // grass exists is free; a later first call rebuilds the field.
    setOccluders(roots) {
      occluderRoots = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map((r) => (r.isObject3D ? { root: r, filter: null } : r));
      if (!occluderRoots.length) { if (occlusion) occlusion.setEnabled(false); return; }
      if (!occlusion) {
        occlusion = createFloraOcclusion({ renderer, scene, camera, cacheStatic: true });
        if (grass) rebuild();
      }
      occlusion.setEnabled(true);
      this.remarkOccluders();
    },
    // Re-marks every root: a streamed terrain grows new batches under an unmoved root.
    remarkOccluders() {
      if (!occlusion) return;
      for (const { root, filter } of occluderRoots) occlusion.markOccluders(root, filter);
    },`);
}
fs.writeFileSync(file, s);
