import io
p = 'base-game.html'
s = io.open(p, encoding='utf8', newline='').read()
nl = '\r\n' if '\r\n' in s[:5000] else '\n'
def rep(a, b, cnt=1):
    global s
    a = a.replace('\n', nl); b = b.replace('\n', nl)
    assert a in s, a[:80]
    s = s.replace(a, b, cnt)

rep("import { createBaseGameTrails, BASE_GAME_TRAIL_DEFAULTS } from './base-game-trails.js';",
"""import { createBaseGameTrails, BASE_GAME_TRAIL_DEFAULTS } from './base-game-trails.js';
import { createBaseGameStructures } from './base-game-structures-page.js';""")

rep("""  trailShow: true,
""", """  trailShow: true,
  structuresEnabled: true,        // eco-brutalist buildings at the plan sites (base-game-structures.js)
  structureSeed: 1,
  structureSpacing: 480,
""")

rep("""  return { kind: 'terrain', descriptor, volumetric, spawnBuilding: !volumetric };""",
"""  // Scattered structures are heightfield-only too, and their seed and spacing are world identity.
  return { kind: 'terrain', descriptor, volumetric, spawnBuilding: !volumetric,
    structures: settings.structuresEnabled && !volumetric, structureSeed: settings.structureSeed, structureSpacing: settings.structureSpacing };""")

rep("""    const check = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: config.descriptor, volumetric: config.volumetric === true });""",
"""    const check = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: config.descriptor, volumetric: config.volumetric === true,
      spawnBuilding: config.spawnBuilding === true, structures: config.structures === true, structureSeed: config.structureSeed, structureSpacing: config.structureSpacing });""")

# structures wanted + reset with the spawn building
rep("""let spawnBuildingMode = null;   // the world mode the building was last seated for
// Reseats the building on the current source. Called after every setSource and from updateWorld.
let floraForBuilding = null;   // set once the flora exists (it is created after the terrain)
function syncSpawnBuilding() {
  const g = spawnBuildingGround();
  spawnBuilding.rebuild(g.heightAt, g.seaLevel, g.options);
  spawnBuildingMode = settings.worldMode;
  spawnBuilding.setVisible(spawnBuildingWanted());
  syncSpawnBuildingFlora();
}""", """let spawnBuildingMode = null;   // the world mode the building was last seated for
// The scattered structures (base-game-structures-page.js) stand on heightfield terrain only.
// Online the room's terrain config decides and fixes their seed and spacing; Solo the settings do.
let structures = null;         // created after the trails, below
function structuresWanted() {
  if (settings.worldMode !== 'terrain') return false;
  if (isOnline()) return roomTerrainConfig?.structures === true;
  return settings.structuresEnabled && !(settings.terrainVolumetric && !!terrain.source?.densityAt);
}
function structureParams() {
  if (isOnline() && roomTerrainConfig?.structures) return { seed: roomTerrainConfig.structureSeed ?? 1, spacing: roomTerrainConfig.structureSpacing ?? 480 };
  return { seed: settings.structureSeed, spacing: settings.structureSpacing };
}
// Reseats the building on the current source. Called after every setSource and from updateWorld.
let floraForBuilding = null;   // set once the flora exists (it is created after the terrain)
function syncSpawnBuilding() {
  const g = spawnBuildingGround();
  spawnBuilding.rebuild(g.heightAt, g.seaLevel, g.options);
  spawnBuildingMode = settings.worldMode;
  spawnBuilding.setVisible(spawnBuildingWanted());
  structures?.reset(structureParams());   // a new source moves every site
  syncSpawnBuildingFlora();
}""")

rep("""  const roots = [];
  if (wanted) roots.push(spawnBuilding.root);
  if (settings.worldMode === 'traversalLab') roots.push(traversalLab.root);""",
"""  const roots = [];
  if (wanted) roots.push(spawnBuilding.root);
  if (structures && structuresWanted()) roots.push(structures.root);
  if (settings.worldMode === 'traversalLab') roots.push(traversalLab.root);""")

rep("""  floraOccResidency = terrain.residencyRevision;
}
// Streaming adds batches under an unmoved terrain root, so the marking must follow residency.
function updateFloraOccluders() {
  if (!floraForBuilding || settings.worldMode !== 'terrain' || !settings.grassTerrainOccludes) return;
  if (terrain.residencyRevision === floraOccResidency) return;
  floraOccResidency = terrain.residencyRevision;
  floraForBuilding.remarkOccluders();
}""", """  floraOccResidency = terrain.residencyRevision;
  floraOccStructures = structures?.version ?? -1;
}
// Streaming adds batches under an unmoved terrain root, and structures add groups under theirs,
// so the marking must follow both.
let floraOccStructures = -1;
function updateFloraOccluders() {
  if (!floraForBuilding || settings.worldMode !== 'terrain') return;
  const terrainMoved = settings.grassTerrainOccludes && terrain.residencyRevision !== floraOccResidency;
  const structuresMoved = structures && structuresWanted() && structures.version !== floraOccStructures;
  if (!terrainMoved && !structuresMoved) return;
  floraOccResidency = terrain.residencyRevision;
  floraOccStructures = structures?.version ?? -1;
  floraForBuilding.remarkOccluders();
}""")

rep("""const trails = createBaseGameTrails({ terrain, options: {
  enabled: settings.trailsEnabled, seed: settings.trailSeed, spacing: settings.trailSpacing,
  width: settings.trailWidth, maxGrade: settings.trailMaxGrade,
} });""", """const trails = createBaseGameTrails({ terrain, options: {
  enabled: settings.trailsEnabled, seed: settings.trailSeed, spacing: settings.trailSpacing,
  width: settings.trailWidth, maxGrade: settings.trailMaxGrade,
} });
structures = createBaseGameStructures({ THREE, scene, worldQuery, terrain, seaLevel: () => terrain.seaLevel, ...structureParams() });
structures.setEnabled(structuresWanted());""")

# apply settings next to the trails
rep("""const TRAIL_APPLY_KEYS = ['trailsEnabled', 'worldMode', 'trailSeed', 'trailSpacing', 'trailWidth', 'trailMaxGrade', 'trailShow'];""",
"""const STRUCTURE_APPLY_KEYS = ['structuresEnabled', 'worldMode', 'structureSeed', 'structureSpacing', 'terrainVolumetric'];
const appliedStructures = {};
function applyStructureSettings() {
  let dirty = false;
  for (const key of STRUCTURE_APPLY_KEYS) if (appliedStructures[key] !== settings[key]) { appliedStructures[key] = settings[key]; dirty = true; }
  if (!dirty) return;
  const p = structureParams();
  if (p.seed !== structures.collision.seed || p.spacing !== structures.collision.spacing) structures.reset(p);
  structures.setEnabled(structuresWanted());
  syncSpawnBuildingFlora();
}
const TRAIL_APPLY_KEYS = ['trailsEnabled', 'worldMode', 'trailSeed', 'trailSpacing', 'trailWidth', 'trailMaxGrade', 'trailShow'];""")
rep("""  applyTrailSettings();
""", """  applyTrailSettings();
  applyStructureSettings();
""")

# per frame
rep("""    trails.update(streamFocus);
    roads.setResidency(streamFocus[0], streamFocus[2], 70);""",
"""    trails.update(streamFocus);
    if (structuresWanted()) structures.update([bodyPosition]);   // colliders follow the body, like the terrain's
    roads.setResidency(streamFocus[0], streamFocus[2], 70);""")

# rebase
rep("""  spawnBuilding.root.position.add(rebaseShift);
  roads.group.position.add(rebaseShift);""",
"""  spawnBuilding.root.position.add(rebaseShift);
  structures.root.position.add(rebaseShift);
  roads.group.position.add(rebaseShift);""")

# rain
rep("""for (const material of spawnBuilding.materials) {
  applyWetSurface(material, rain.uniforms, { baseColor: material.colorNode ? undefined : materialColor, rippleScale: 2.6, puddleScale: 0.12 });
}""", """for (const material of [...spawnBuilding.materials, ...structures.materials]) {
  applyWetSurface(material, rain.uniforms, { baseColor: material.colorNode ? undefined : materialColor, rippleScale: 2.6, puddleScale: 0.12 });
}""")

# panel
rep("""refreshTrailRuntimeLine();
const labSummary = document.createElement('div');""",
"""refreshTrailRuntimeLine();
const structuresSec = createSection(ctrlBody, 'Structures', { collapsed: true });
addToggle(structuresSec, 'structuresEnabled', 'Eco-brutalist buildings at the plan sites');
addRange(structuresSec, 'structureSeed', 'Structure seed', 0, 1e9, 1, value => value.toFixed(0));
addRange(structuresSec, 'structureSpacing', 'Site spacing', 120, 1920, 30, value => `${value.toFixed(0)} m`);
const structureRuntimeLine = document.createElement('div');
structureRuntimeLine.className = 'note';
structuresSec.append(structureRuntimeLine);
function refreshStructureRuntimeLine() {
  const st = structures.stats;
  const here = playerController.getPosition();
  const near = structuresWanted() ? structures.nearest(here[0], here[2]) : null;
  setTextIfChanged(structureRuntimeLine, !structuresWanted() ? (isOnline() ? 'Off in this room.' : 'Off.')
    : `${st.built} buildings in ${st.tiles} settled tiles · ${st.meshes} meshes · ${st.collisionTriangles.toLocaleString()} collision tris · bake ${st.buildMs.toFixed(0)} ms${near ? ` · nearest ${near.tile.structure.kind} ${near.distance.toFixed(0)} m` : ''}`);
}
refreshStructureRuntimeLine();
const labSummary = document.createElement('div');""")
rep("""      if (panelElementVisible(trailRuntimeLine)) refreshTrailRuntimeLine();""",
"""      if (panelElementVisible(trailRuntimeLine)) refreshTrailRuntimeLine();
      if (panelElementVisible(structureRuntimeLine)) refreshStructureRuntimeLine();""")

io.open(p, 'w', encoding='utf8', newline='').write(s)
print('patched')
