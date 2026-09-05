// Doc rows for the multi-root occluders; argv[2] picks the file so it also runs on a HEAD copy.
const fs = require('fs');
const [,, file, which] = process.argv;
let s = fs.readFileSync(file, 'utf8');
const eol = s.includes('\r\n') ? '\r\n' : '\n';
const rep = (a, b) => {
  a = a.split('\n').join(eol); b = b.split('\n').join(eol);
  if (!s.includes(a)) throw new Error(`${which}: missing: ${a.slice(0, 70)}`);
  s = s.replace(a, b);
};
if (which === 'veg') {
  rep('`setOccluders(root)` builds a `flora-occlusion.js` pass over the group and passes its state to `createComputeGrass`; see `base-game.md`, "Spawn building". |',
      '`setOccluders(roots)` takes one Object3D or a list of Object3D or `{ root, filter }` (2026-09-05), builds a `flora-occlusion.js` pass over them and passes its state to `createComputeGrass`; `remarkOccluders()` re-marks every root, which the page calls when terrain residency changes because streaming adds batches under an unmoved root; see `base-game.md`, "Spawn building". |');
  rep('`markOccluders(root)` puts every opaque mesh under `root` on the layer (transparent water stays out);',
      '`markOccluders(root, filter?)` puts every opaque mesh under `root` on the layer (transparent water stays out; a `filter(mesh)` narrows it, which the Base Game uses to keep the far clipmap rings out of the terrain root, since a position node places them and the override material would draw them flat);');
} else {
  rep('from `syncSpawnBuildingFlora()` whenever the building is reseated or the world mode changes.',
      `from \`syncSpawnBuildingFlora()\` whenever the building is reseated or the world mode changes.

Since 2026-09-05 the occluder list is more than the building: in the spawn-area world the lab's
root joins it, and on terrain the terrain root joins it filtered to its \`BatchedMesh\` chunk
batches (the far clipmap rings are placed by a position node, so the depth pass would draw them
flat; the debug bounds and contact marker are not batches either). A crest therefore hides the
blades behind it. Streaming adds batches under the unmoved terrain root, which the pass's static
cache cannot see, so \`updateFloraOccluders()\` re-marks the roots whenever
\`terrain.residencyRevision\` moves. The setting \`grassTerrainOccludes\` (default on, "Terrain hides
blades behind a crest") drops the terrain root from the list; it is a flora apply key, so a toggle
re-syncs at once. The cost, an extra draw of the visible chunk batches at 256 px on every moving
frame, has not been measured; the flora HUD's occlusion render time is where to read it. The lab
entry has no visible effect yet, because the grass only runs in the terrain world.`);
}
fs.writeFileSync(file, s);
