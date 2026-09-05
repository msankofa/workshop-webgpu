// base-game.html: the lab and the near terrain join the spawn building as grass occluders.
const fs = require('fs');
const file = 'base-game.html';
let s = fs.readFileSync(file, 'utf8');
const eol = s.includes('\r\n') ? '\r\n' : '\n';
const rep = (a, b) => {
  a = a.split('\n').join(eol); b = b.split('\n').join(eol);
  if (!s.includes(a)) throw new Error(`missing: ${a.slice(0, 70)}`);
  s = s.replace(a, b);
};
rep(`  grassOcclusion: true,           // blades behind the spawn building's concrete are not generated
`,
`  grassOcclusion: true,           // blades behind the spawn building's concrete are not generated
  grassTerrainOccludes: true,     // the near terrain chunks hide blades behind a crest as well
`);
rep(`// The planters are a biome inside the building's rectangle, and the concrete occludes blades.
function syncSpawnBuildingFlora() {
  if (!floraForBuilding) return;
  const wanted = spawnBuildingWanted();
  floraForBuilding.setStructure(wanted ? spawnBuilding.floraStructure : null);
  floraForBuilding.setOccluders(wanted ? spawnBuilding.root : null);
}`,
`// The planters are a biome inside the building's rectangle, and the concrete occludes blades,
// with the lab and the near terrain chunks (never the far clipmap rings, which a position node
// places and the depth pass would draw flat).
let floraOccResidency = -1;
function syncSpawnBuildingFlora() {
  if (!floraForBuilding) return;
  const wanted = spawnBuildingWanted();
  floraForBuilding.setStructure(wanted ? spawnBuilding.floraStructure : null);
  const roots = [];
  if (wanted) roots.push(spawnBuilding.root);
  if (settings.worldMode === 'traversalLab') roots.push(traversalLab.root);
  if (settings.worldMode === 'terrain' && settings.grassTerrainOccludes) roots.push({ root: terrain.root, filter: (o) => o.isBatchedMesh });
  floraForBuilding.setOccluders(roots);
  floraOccResidency = terrain.residencyRevision;
}
// Streaming adds batches under an unmoved terrain root, so the marking must follow residency.
function updateFloraOccluders() {
  if (!floraForBuilding || settings.worldMode !== 'terrain' || !settings.grassTerrainOccludes) return;
  if (terrain.residencyRevision === floraOccResidency) return;
  floraOccResidency = terrain.residencyRevision;
  floraForBuilding.remarkOccluders();
}`);
rep(`'grassBufferMB', 'grassKmax', 'grassOcclusion'];`, `'grassBufferMB', 'grassKmax', 'grassOcclusion', 'grassTerrainOccludes'];`);
rep(`  flora.setOcclusionEnabled?.(settings.grassOcclusion);
}`,
`  flora.setOcclusionEnabled?.(settings.grassOcclusion);
  syncSpawnBuildingFlora();
}`);
rep(`    updateRainOccluders();
    if (profileFrame) frameProfiler.mark('rainBake', performance.now() - passStart);`,
`    updateRainOccluders();
    updateFloraOccluders();
    if (profileFrame) frameProfiler.mark('rainBake', performance.now() - passStart);`);
rep(`addToggle(plantsSec, 'grassOcclusion', 'Cull blades hidden behind the spawn building');`,
`addToggle(plantsSec, 'grassOcclusion', 'Cull blades hidden behind concrete and terrain');
addToggle(plantsSec, 'grassTerrainOccludes', 'Terrain hides blades behind a crest');`);
fs.writeFileSync(file, s);
