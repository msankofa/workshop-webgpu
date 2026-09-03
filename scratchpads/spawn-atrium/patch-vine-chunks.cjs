// Vine chunking in bot-flora.js: one mesh per spatial cell so the renderer frustum-culls vines
// per cell. Run from the repo root: node scratchpads/spawn-atrium/patch-vine-chunks.cjs
const fs = require('fs');
const rx = (a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'));
let s = fs.readFileSync('bot-flora.js', 'utf8');
const rep = (a, b) => { const r = rx(a); if (!r.test(s)) throw new Error('missing: ' + a.slice(0, 80)); s = s.replace(r, () => b); };
rep(`  let vineMesh = null;`, `  let vineMeshes = [];   // one per cell when flora.vineChunk > 0, else one for the map`);
rep(`    vineMesh = buildVines(anchors, { base: flora.grassBase, tip: flora.grassTip },
      { leafiness: flora.vineLeafiness, branch: flora.vineBranch });
    if (vineMesh) { root.add(vineMesh); stats.vines = anchors.length; }`,
`    // Chunked by anchor position so a cell of strands behind the camera is one skipped draw. The
    // bounding sphere is padded by the strand length: a strand hangs below its anchor and sways.
    const cell = flora.vineChunk > 0 ? flora.vineChunk : 0;
    const groups = new Map();
    for (const a of anchors) {
      const key = cell ? \`\${Math.floor(a.x / cell)}:\${Math.floor(a.z / cell)}\` : 'all';
      let g = groups.get(key); if (!g) groups.set(key, (g = [])); g.push(a);
    }
    for (const group of groups.values()) {
      const m = buildVines(group, { base: flora.grassBase, tip: flora.grassTip },
        { leafiness: flora.vineLeafiness, branch: flora.vineBranch });
      if (!m) continue;
      m.geometry.boundingSphere.radius += flora.vineLength * (1 + 0.5) + 0.5;
      m.frustumCulled = cell > 0;
      m.userData.strands = group.length;
      root.add(m);
      vineMeshes.push(m);
    }
    stats.vines = anchors.length;
    stats.vineChunks = vineMeshes.length;`);
rep(`    if (vineMesh) { root.remove(vineMesh); vineMesh.geometry.dispose(); vineMesh = null; }`,
`    for (const m of vineMeshes) { root.remove(m); m.geometry.dispose(); }
    vineMeshes = [];
    stats.vineChunks = 0;`);
rep(`      return { mode: stats.grassMode, tilesVisible, tilesTotal: grassTiles.length, bladesVisible, bladesTotal, vines: stats.vines, plantsTotal: stats.plants };`,
`      let vineChunksVisible = 0, vinesVisible = 0;
      for (const m of vineMeshes) {
        if (!m.frustumCulled || _frustum.intersectsObject(m)) { vineChunksVisible++; vinesVisible += m.userData.strands || 0; }
      }
      return {
        mode: stats.grassMode, tilesVisible, tilesTotal: grassTiles.length, bladesVisible, bladesTotal,
        vines: stats.vines, vinesVisible, vineChunks: vineMeshes.length, vineChunksVisible, plantsTotal: stats.plants,
      };`);
fs.writeFileSync('bot-flora.js', s);
console.log('vines chunked');
