// Phase 3 page wiring for the spawn building in base-game.html. Run from the repo root ONLY when no
// other session has base-game.html open: node scratchpads/spawn-atrium/patch-page-spawn.cjs
const fs = require('fs');
const file = 'base-game.html';
let s = fs.readFileSync(file, 'utf8');
const rx = (a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'));
const rep = (a, b) => { const r = rx(a); if (!r.test(s)) throw new Error('missing: ' + a.slice(0, 90)); s = s.replace(r, () => b); };

// 1. import next to the traversal lab's.
rep(`import { createBaseGameTraversalLab } from './base-game-traversal-lab.js';`,
    `import { createBaseGameTraversalLab } from './base-game-traversal-lab.js';
import { createBaseGameSpawnBuilding } from './base-game-spawn-building.js';`);

// 2. the room terrain config carries the flag: a room made from this page has the building.
rep(`  const volumetric = simulationReady && settings.terrainVolumetric && !!terrain.source?.densityAt;
  return { kind: 'terrain', descriptor, volumetric };`,
    `  const volumetric = simulationReady && settings.terrainVolumetric && !!terrain.source?.densityAt;
  // The spawn building rides on heightfield terrain only; volumetric rooms keep the bare spawn.
  return { kind: 'terrain', descriptor, volumetric, spawnBuilding: !volumetric };`);

// 3. build it after the lab, on the terrain's own source; rebuilt whenever that source changes.
rep(`const traversalLab = createBaseGameTraversalLab({ scene, worldQuery });`,
    `const traversalLab = createBaseGameTraversalLab({ scene, worldQuery });
// The eco-brutalist spawn building (docs/subsystems/base-game.md, "Spawn building"): the same
// collider the room server registers, seated on the same source, dressed in chunked concrete.
// Online it exists only when the room's terrain config says so; Solo heightfield terrain always has it.
const spawnBuilding = createBaseGameSpawnBuilding({
  THREE, scene, worldQuery, heightAt: (x, z) => terrain.groundHeight(x, z), seaLevel: terrain.seaLevel,
});
function spawnBuildingWanted() {
  if (settings.worldMode !== 'terrain') return false;
  if (isOnline()) return roomTerrainConfig?.spawnBuilding === true;
  return !(settings.terrainVolumetric && !!terrain.source?.densityAt);
}
// Reseats the building on the current source. Called after every setSource and from updateWorld.
function syncSpawnBuilding() {
  spawnBuilding.rebuild((x, z) => terrain.groundHeight(x, z), terrain.seaLevel);
  spawnBuilding.setVisible(spawnBuildingWanted());
}`);

// 4. the terrain source changes: online join and a runtime project apply.
rep(`    if (!same) terrain.setSource(check.config.descriptor);`,
    `    if (!same) { terrain.setSource(check.config.descriptor); syncSpawnBuilding(); }`);
rep(`  terrain.setSource(descriptor);
  activeTerrainDescriptor = descriptor;`,
    `  terrain.setSource(descriptor);
  syncSpawnBuilding();
  activeTerrainDescriptor = descriptor;`);

// 5. spawn on the plaza when the building is there, 1.5 m up like the server.
rep(`function worldSpawn() { return settings.worldMode === 'terrain' ? terrain.spawnPosition(0, 0) : traversalLab.layout.spawn; }`,
    `function worldSpawn() {
  if (settings.worldMode !== 'terrain') return traversalLab.layout.spawn;
  if (spawnBuildingWanted()) { const s = spawnBuilding.spawn; return [s[0], s[1] + 1.5, s[2]]; }
  return terrain.spawnPosition(0, 0);
}`);

// 6. visibility follows the world mode with the lab's.
rep(`  traversalLab.setVisible(traversalLabVisible);`,
    `  traversalLab.setVisible(traversalLabVisible);
  spawnBuilding.setVisible(spawnBuildingWanted());`);

// 7. rain: the concrete has a colour graph to darken; the plain materials take the lab's route.
rep(`for (const material of traversalLab.materials) {`,
    `for (const material of spawnBuilding.materials) {
  applyWetSurface(material, rain.uniforms, { baseColor: material.colorNode ? undefined : materialColor, rippleScale: 2.6, puddleScale: 0.12 });
}
for (const material of traversalLab.materials) {`);

fs.writeFileSync(file, s);
console.log('base-game.html: spawn building wired');
