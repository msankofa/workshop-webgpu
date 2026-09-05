import io, sys
def load(p): return io.open(p, encoding='utf8').read()
def save(p, s): io.open(p, 'w', encoding='utf8', newline='\n').write(s)
def rep(s, a, b, cnt=1):
    assert a in s, a[:70]
    return s.replace(a, b, cnt)

# ---- collision module: synchronous private plan ----
p = 'base-game-structure-collision.js'; s = load(p)
s = rep(s, "import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';",
"import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';\nimport { createFieldScheduler } from './terrain-field-scheduler.js';\nimport { createFieldWindow } from './terrain-field-window.js';")
s = rep(s, """  let ownPlan = null, ownScheduler = null, ownRelease = null;
  let planReady = false;
  async function openOwnPlan() {
    if (ownPlan || plan) return;
    const [{ createFieldScheduler }, { createFieldWindow }] = await Promise.all([
      import('./terrain-field-scheduler.js'), import('./terrain-field-window.js'),
    ]);
    const walk""", """  let ownPlan = null, ownScheduler = null, ownRelease = null;
  function openOwnPlan() {
    if (ownPlan || plan) return;
    const walk""")
s = rep(s, """    ownRelease = ownPlan.acquire();
    planReady = true;
  }""", """    ownRelease = ownPlan.acquire();
  }""")
s = rep(s, """    if (!plan && !ownPlan) { openOwnPlan(); return 0; }   // async import: the first call only starts it
    if (ownPlan) {""", """    if (!plan) openOwnPlan();
    if (ownPlan) {""")
s = rep(s, """    get planReady() { return plan ? !!plan() : planReady; },
""", """    get planCoverage() { const p = currentPlan(); return p ? p.coverage : 0; },
""")
save(p, s)

# ---- protocol: config sanitizer ----
p = 'base-game-protocol.mjs'; s = load(p)
s = rep(s, """  const spawnBuilding = input.spawnBuilding === true;
  let text;""", """  const spawnBuilding = input.spawnBuilding === true;
  // Scattered eco-brutalist structures at the world plan's sites (base-game-structures.js). Their
  // seed and spacing fix where every wall stands, so they are world identity too.
  const structures = input.structures === true;
  const structureSeed = Math.max(0, Math.min(1e9, Math.round(Number(input.structureSeed ?? BASE_GAME_STRUCTURE_DEFAULTS.seed)))) || 0;
  const structureSpacing = Math.max(120, Math.min(1920, Math.round(Number(input.structureSpacing ?? BASE_GAME_STRUCTURE_DEFAULTS.spacing)))) || BASE_GAME_STRUCTURE_DEFAULTS.spacing;
  let text;""")
s = rep(s, """  const spawnTag = spawnBuilding ? ':spawnbld1' : '';
  const worldVersion = `terrain:${descriptor.kind}:${descriptor.key}@${descriptor.sourceVersion}:${descriptor.algorithmVersion}${volumetric ? ':volume' : ''}${seaTag}${spawnTag}`;
  return { config: { kind: 'terrain', descriptor, projectHash, volumetric, spawnBuilding, worldVersion }, error: null };""",
"""  const spawnTag = spawnBuilding ? ':spawnbld1' : '';
  if (structures && volumetric) return { config: null, error: 'scattered structures are not built in volumetric rooms yet' };
  const structTag = structures ? `:structs1:${structureSeed}:${structureSpacing}` : '';
  const worldVersion = `terrain:${descriptor.kind}:${descriptor.key}@${descriptor.sourceVersion}:${descriptor.algorithmVersion}${volumetric ? ':volume' : ''}${seaTag}${spawnTag}${structTag}`;
  return { config: { kind: 'terrain', descriptor, projectHash, volumetric, spawnBuilding, structures, structureSeed, structureSpacing, worldVersion }, error: null };""")
s = rep(s, """volumetric: config.volumetric === true, spawnBuilding: config.spawnBuilding === true };""",
"""volumetric: config.volumetric === true, spawnBuilding: config.spawnBuilding === true, structures: config.structures === true, structureSeed: config.structureSeed ?? null, structureSpacing: config.structureSpacing ?? null };""")
s = rep(s, """export function sanitizeBaseGameTerrainConfig(""", """export const BASE_GAME_STRUCTURE_DEFAULTS = Object.freeze({ seed: 1, spacing: 480 });   // mirrors base-game-structures.js
export function sanitizeBaseGameTerrainConfig(""")
save(p, s)

# ---- room server: world factory ----
p = 'server/base-game-rooms.js'; s = load(p)
s = rep(s, """    return {
      worldQuery,
      spawn: building
        ? [building.spawn[0], building.spawn[1] + 1.5, building.spawn[2]]
        : [0, Math.max(source.heightAt(0, 0), seaLevel) + 1.5, 0],
      building,
      seaLevel,
      killPlaneYAt: (x, z) => source.heightAt(x, z) - killBelow,
      heightAt: (x, z) => source.heightAt(x, z),
      worldVersion: config.worldVersion,
      terrain: config,
    };""", """    // Scattered structures: one streamed provider, built around the players each tick from the
    // same plan-window sites the page places them at (base-game-structure-collision.js).
    let structures = null;
    if (config.structures) {
      const { createStructureCollision } = await import('../base-game-structure-collision.js');
      structures = createStructureCollision(source, { worldQuery, seaLevel, seed: config.structureSeed, spacing: config.structureSpacing });
    }
    return {
      worldQuery,
      spawn: building
        ? [building.spawn[0], building.spawn[1] + 1.5, building.spawn[2]]
        : [0, Math.max(source.heightAt(0, 0), seaLevel) + 1.5, 0],
      building,
      structures,
      seaLevel,
      killPlaneYAt: (x, z) => source.heightAt(x, z) - killBelow,
      heightAt: (x, z) => source.heightAt(x, z),
      worldVersion: config.worldVersion,
      terrain: config,
      prepare: structures ? positions => structures.ensure(positions) : undefined,
    };""")
s = rep(s, """      raycast: worldOccluder(room) ?? (() => null),
      seaLevel: () => (room.water?.enabled ? room.water.level : -Infinity),""",
"""      raycast: worldOccluder(room) ?? (() => null),
      structures: room.sim.structures ?? null,
      seaLevel: () => (room.water?.enabled ? room.water.level : -Infinity),""")
save(p, s)

# ---- NPCs: blockers in the zone bake ----
p = 'server/base-game-npcs.js'; s = load(p)
s = rep(s, "import { finalizeNavGrid } from '../nav-grid.js';", "import { finalizeNavGrid, rasterizeBlockers } from '../nav-grid.js';")
s = rep(s, """export const NPC_CREST = {""", """export const NPC_WALL_MARGIN = 0.55;         // m the nav raster grows a structure wall, as bot-viewer-v3 does, so paths do not hug it
export const NPC_CREST = {""")
s = rep(s, """export function createRoomNpcs({ room, heightAt: rawHeightAt, raycast: rawRaycast, seaLevel = () => -Infinity, roomMs, log = null }) {""",
"""export function createRoomNpcs({ room, heightAt: rawHeightAt, raycast: rawRaycast, structures = null, seaLevel = () => -Infinity, roomMs, log = null }) {""")
s = rep(s, """row: 0, phase: 'sample', t0: performance.now(), sea: seaLevel() };""",
"""row: 0, phase: 'sample', t0: performance.now(), sea: seaLevel(), structuresVersion: structures?.version ?? 0 };""")
s = rep(s, """    if (job.phase === 'finalize') {
      const tf = performance.now();
      job.grid = finalizeNavGrid(""", """    if (job.phase === 'finalize') {
      const tf = performance.now();
      // Structure walls and covers inside the zone: blocked cells for paths, tall rects for sight
      // and cover corners, the way bot-viewer-v3 feeds its layout in.
      job.rects = structures ? structures.navRectsWithin(bounds) : [];
      if (job.rects.length) {
        const blocked = rasterizeBlockers({ cols, rows, cellSize: cell, minX: bounds.minX, minZ: bounds.minZ }, job.rects, NPC_WALL_MARGIN);
        for (let k = 0; k < blocked.length; k++) if (blocked[k]) { cells[k] = 0; soft[k] = 0; }
      }
      job.grid = finalizeNavGrid(""")
s = rep(s, """buildSightGrid(job.grid, [])""", """buildSightGrid(job.grid, job.rects)""")
s = rep(s, """buildCornerMap(job.grid, [], job.visField""", """buildCornerMap(job.grid, job.rects, job.visField""")
s = rep(s, """corners: cornerMap?.corners?.length ?? 0, walkable };""",
"""corners: cornerMap?.corners?.length ?? 0, walkable, rects: job.rects.length, structuresVersion: job.structuresVersion };""")
s = rep(s, """    if (!job && (!zone || Math.hypot(c[0] - zone.cx, c[1] - zone.cz) > NPC_ZONE_REBAKE_DRIFT)) startBake(c[0], c[1]);""",
"""    // A structure arriving or leaving anywhere rebakes: the version is cheap and a zone is 384 m.
    const structuresMoved = zone && structures && structures.version !== zone.structuresVersion;
    if (!job && (!zone || structuresMoved || Math.hypot(c[0] - zone.cx, c[1] - zone.cz) > NPC_ZONE_REBAKE_DRIFT)) startBake(c[0], c[1]);""")
save(p, s)
print('patched')
