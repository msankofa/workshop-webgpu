import io
def load(p): return io.open(p, encoding='utf8', newline='').read()
def save(p, s): io.open(p, 'w', encoding='utf8', newline='').write(s)
def rep(s, a, b):
    nl = '\r\n' if '\r\n' in s[:5000] else '\n'
    a = a.replace('\n', nl); b = b.replace('\n', nl)
    assert a in s, a[:80]
    return s.replace(a, b, 1)

# ---- pure module: a per-tile chance gate ----
p = 'base-game-structures.js'; s = load(p)
s = rep(s, """export const STRUCTURE_DEFAULTS = Object.freeze({
  seed: 1,
  spacing: 480,          // m per site tile; the trails default, so trails meet buildings by default""",
"""export const STRUCTURE_DEFAULTS = Object.freeze({
  seed: 1,
  spacing: 480,          // m per site tile; the trails default, so trails meet buildings by default
  chance: 1,             // share of tiles that get a building; the tile hash decides which""")
s = rep(s, """  if (tx === 0 && tz === 0) return [];
  const sites = sitesForTile(P.seed, tx, tz, plan, { spacing: P.spacing });
  if (sites == null) return null;""",
"""  if (tx === 0 && tz === 0) return [];
  const sites = sitesForTile(P.seed, tx, tz, plan, { spacing: P.spacing });
  if (sites == null) return null;
  if (P.chance < 1 && hash2(tx, tz, (Math.floor(P.seed) ^ 0x33c1) | 0) >= P.chance) return [];""")
save(p, s)

# ---- collision: chance and scatter options through to the generators ----
p = 'base-game-structure-collision.js'; s = load(p)
s = rep(s, """  plan = null, priority = 100, scatter: scatterOptions = null, ...options
} = {}) {""", """  plan = null, priority = 100, chance = STRUCTURE_DEFAULTS.chance, scatter: scatterOptions = null, ...options
} = {}) {""")
s = rep(s, """    const list = structuresForTile(seed, tx, tz, p, { spacing });""",
"""    const list = structuresForTile(seed, tx, tz, p, { spacing, chance });""")
s = rep(s, """    provider, seed, spacing,""", """    provider, seed, spacing, chance, scatterOptions,""")
save(p, s)

# ---- protocol ----
p = 'base-game-protocol.mjs'; s = load(p)
s = rep(s, """export const BASE_GAME_STRUCTURE_DEFAULTS = Object.freeze({ seed: 1, spacing: 480 });   // mirrors base-game-structures.js""",
"""export const BASE_GAME_STRUCTURE_DEFAULTS = Object.freeze({ seed: 1, spacing: 480, chance: 1, scatter: 5, reach: 110 });   // mirrors base-game-structures.js""")
s = rep(s, """  const structureSpacing = Math.max(120, Math.min(1920, Math.round(Number(input.structureSpacing ?? BASE_GAME_STRUCTURE_DEFAULTS.spacing)))) || BASE_GAME_STRUCTURE_DEFAULTS.spacing;""",
"""  const structureSpacing = Math.max(120, Math.min(1920, Math.round(Number(input.structureSpacing ?? BASE_GAME_STRUCTURE_DEFAULTS.spacing)))) || BASE_GAME_STRUCTURE_DEFAULTS.spacing;
  const clampNum = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  const structureChance = Math.round(clampNum(input.structureChance ?? BASE_GAME_STRUCTURE_DEFAULTS.chance, 0, 1, BASE_GAME_STRUCTURE_DEFAULTS.chance) * 100) / 100;
  const structureScatter = Math.round(clampNum(input.structureScatter ?? BASE_GAME_STRUCTURE_DEFAULTS.scatter, 0, 12, BASE_GAME_STRUCTURE_DEFAULTS.scatter));
  const structureReach = Math.round(clampNum(input.structureReach ?? BASE_GAME_STRUCTURE_DEFAULTS.reach, 30, 240, BASE_GAME_STRUCTURE_DEFAULTS.reach));""")
s = rep(s, """  const structTag = structures ? `:structs1:${structureSeed}:${structureSpacing}` : '';""",
"""  const structTag = structures ? `:structs2:${structureSeed}:${structureSpacing}:${structureChance}:${structureScatter}:${structureReach}` : '';""")
s = rep(s, """  return { config: { kind: 'terrain', descriptor, projectHash, volumetric, spawnBuilding, structures, structureSeed, structureSpacing, worldVersion }, error: null };""",
"""  return { config: { kind: 'terrain', descriptor, projectHash, volumetric, spawnBuilding, structures, structureSeed, structureSpacing, structureChance, structureScatter, structureReach, worldVersion }, error: null };""")
s = rep(s, """structures: config.structures === true, structureSeed: config.structureSeed ?? null, structureSpacing: config.structureSpacing ?? null };""",
"""structures: config.structures === true, structureSeed: config.structureSeed ?? null, structureSpacing: config.structureSpacing ?? null, structureChance: config.structureChance ?? null, structureScatter: config.structureScatter ?? null, structureReach: config.structureReach ?? null };""")
save(p, s)

# ---- room server: both branches ----
p = 'server/base-game-rooms.js'; s = load(p)
old_a = """        volumeStructures = createStructureCollision(source, { worldQuery, heightAt: surface, seaLevel, seed: config.structureSeed, spacing: config.structureSpacing });"""
new_a = """        volumeStructures = createStructureCollision(source, { worldQuery, heightAt: surface, seaLevel, ...structureCollisionOptions(config) });"""
s = rep(s, old_a, new_a)
s = rep(s, """      structures = createStructureCollision(source, { worldQuery, seaLevel, seed: config.structureSeed, spacing: config.structureSpacing });""",
"""      structures = createStructureCollision(source, { worldQuery, seaLevel, ...structureCollisionOptions(config) });""")
s = rep(s, """async function defaultWorldFactory(config = { kind: 'traversalLab' }) {""",
"""// The structure knobs a sanitized terrain config carries, in the collision module's terms.
function structureCollisionOptions(config) {
  return { seed: config.structureSeed, spacing: config.structureSpacing, chance: config.structureChance ?? 1,
    scatter: { count: config.structureScatter ?? 5, reach: config.structureReach ?? 110 } };
}
async function defaultWorldFactory(config = { kind: 'traversalLab' }) {""")
save(p, s)

# ---- page module: pass the knobs through reset ----
p = 'base-game-structures-page.js'; s = load(p)
s = rep(s, """seaLevel = () => 0, seed = 1, spacing = 480, chunk = SPAWN_BUILDING_CHUNK, collision: collisionOptions = {} }) {""",
"""seaLevel = () => 0, seed = 1, spacing = 480, chance = 1, scatter = { count: 5, reach: 110 }, chunk = SPAWN_BUILDING_CHUNK, collision: collisionOptions = {} }) {""")
s = rep(s, """      { worldQuery, heightAt: (x, z) => terrain.groundHeight(x, z), seaLevel: seaLevel(), seed, spacing, plan: () => terrain.plan, ...collisionOptions },""",
"""      { worldQuery, heightAt: (x, z) => terrain.groundHeight(x, z), seaLevel: seaLevel(), seed, spacing, chance, scatter: { ...scatter }, plan: () => terrain.plan, ...collisionOptions },""")
s = rep(s, """    reset({ seed: nextSeed = seed, spacing: nextSpacing = spacing } = {}) {
      seed = nextSeed; spacing = nextSpacing;""",
"""    reset({ seed: nextSeed = seed, spacing: nextSpacing = spacing, chance: nextChance = chance, scatter: nextScatter = scatter } = {}) {
      seed = nextSeed; spacing = nextSpacing; chance = nextChance; scatter = { ...scatter, ...nextScatter };""")
s = rep(s, """    get collision() { return collision; },""",
"""    get collision() { return collision; },
    get params() { return { seed, spacing, chance, scatter: { ...scatter } }; },""")
save(p, s)

# ---- page ----
p = 'base-game.html'; s = load(p)
s = rep(s, """  structureSeed: 1,
  structureSpacing: 480,
""", """  structureSeed: 1,
  structureSpacing: 480,
  structureChance: 1,             // share of tiles that get a building
  structureScatter: 5,            // bot-viewer cover structures around each building
  structureReach: 110,            // m they scatter within
""")
s = rep(s, """    structures: settings.structuresEnabled, structureSeed: settings.structureSeed, structureSpacing: settings.structureSpacing };""",
"""    structures: settings.structuresEnabled, structureSeed: settings.structureSeed, structureSpacing: settings.structureSpacing,
    structureChance: settings.structureChance, structureScatter: settings.structureScatter, structureReach: settings.structureReach };""")
s = rep(s, """      spawnBuilding: config.spawnBuilding === true, structures: config.structures === true, structureSeed: config.structureSeed, structureSpacing: config.structureSpacing });""",
"""      spawnBuilding: config.spawnBuilding === true, structures: config.structures === true, structureSeed: config.structureSeed, structureSpacing: config.structureSpacing,
      structureChance: config.structureChance, structureScatter: config.structureScatter, structureReach: config.structureReach });""")
s = rep(s, """function structureParams() {
  if (isOnline() && roomTerrainConfig?.structures) return { seed: roomTerrainConfig.structureSeed ?? 1, spacing: roomTerrainConfig.structureSpacing ?? 480 };
  return { seed: settings.structureSeed, spacing: settings.structureSpacing };
}""", """function structureParams() {
  const c = isOnline() && roomTerrainConfig?.structures ? roomTerrainConfig : null;
  return {
    seed: c ? c.structureSeed ?? 1 : settings.structureSeed,
    spacing: c ? c.structureSpacing ?? 480 : settings.structureSpacing,
    chance: c ? c.structureChance ?? 1 : settings.structureChance,
    scatter: { count: c ? c.structureScatter ?? 5 : settings.structureScatter, reach: c ? c.structureReach ?? 110 : settings.structureReach },
  };
}""")
s = rep(s, """const STRUCTURE_APPLY_KEYS = ['structuresEnabled', 'worldMode', 'structureSeed', 'structureSpacing'];""",
"""const STRUCTURE_APPLY_KEYS = ['structuresEnabled', 'worldMode', 'structureSeed', 'structureSpacing', 'structureChance', 'structureScatter', 'structureReach'];""")
s = rep(s, """  const p = structureParams();
  if (p.seed !== structures.collision.seed || p.spacing !== structures.collision.spacing) structures.reset(p);""",
"""  const p = structureParams();
  if (JSON.stringify(p) !== JSON.stringify(structures.params)) structures.reset(p);""")
s = rep(s, """const ROOM_OWNED_GROUND_KEYS = ['worldMode', 'terrainVolumetric', 'terrainSeaLevel', 'structuresEnabled', 'structureSeed', 'structureSpacing'];""",
"""const ROOM_OWNED_GROUND_KEYS = ['worldMode', 'terrainVolumetric', 'terrainSeaLevel', 'structuresEnabled', 'structureSeed', 'structureSpacing', 'structureChance', 'structureScatter', 'structureReach'];""")
s = rep(s, """addRange(structuresSec, 'structureSpacing', 'Site spacing', 120, 1920, 30, value => `${value.toFixed(0)} m`);""",
"""addRange(structuresSec, 'structureSpacing', 'Site spacing', 120, 1920, 30, value => `${value.toFixed(0)} m`);
addRange(structuresSec, 'structureChance', 'Building chance per site', 0, 1, 0.05, value => `${(value * 100).toFixed(0)}%`);
addRange(structuresSec, 'structureScatter', 'Cover structures per building', 0, 12, 1, value => value.toFixed(0));
addRange(structuresSec, 'structureReach', 'Cover reach', 30, 240, 10, value => `${value.toFixed(0)} m`);""")
s = rep(s, """  const fixed = isOnline() && roomTerrainConfig?.structures ? ` · room seed ${roomTerrainConfig.structureSeed} at ${roomTerrainConfig.structureSpacing} m` : '';""",
"""  const fixed = isOnline() && roomTerrainConfig?.structures ? ` · room: seed ${roomTerrainConfig.structureSeed}, ${roomTerrainConfig.structureSpacing} m, ${Math.round((roomTerrainConfig.structureChance ?? 1) * 100)}%, ${roomTerrainConfig.structureScatter ?? 5} cover within ${roomTerrainConfig.structureReach ?? 110} m` : '';""")
save(p, s)

# ---- tests ----
p = 'test-base-game-rooms-terrain.mjs'; s = load(p)
s = rep(s, """withStructs.worldVersion.endsWith(':structs1:9:480')""", """withStructs.worldVersion.endsWith(':structs2:9:480:1:5:110')""")
s = rep(s, """vol.config.worldVersion.endsWith(':structs1:1:480')""", """vol.config.worldVersion.endsWith(':structs2:1:480:1:5:110')""")
s = rep(s, """  ok(describeBaseGameTerrainConfig(withStructs).structures === true, 'the description carries them');""",
"""  ok(describeBaseGameTerrainConfig(withStructs).structures === true, 'the description carries them');
  const sparse = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(descriptor)), structures: true, structureSeed: 9, structureChance: 0.3, structureScatter: 2, structureReach: 60 }).config;
  ok(sparse.structureChance === 0.3 && sparse.structureScatter === 2 && sparse.structureReach === 60 && sparse.worldVersion.endsWith(':structs2:9:480:0.3:2:60') && sparse.worldVersion !== withStructs.worldVersion, 'chance, scatter and reach are clamped, carried and part of the world identity');""")
save(p, s)

p = 'test-base-game-structures.mjs'; s = load(p)
s = rep(s, """ok(structuresForTile(8, 3, -2, plan)[0].seed !== a[0].seed, 'the world seed changes the building seed');""",
"""ok(structuresForTile(8, 3, -2, plan)[0].seed !== a[0].seed, 'the world seed changes the building seed');
{
  let n = 0, all = 0;
  for (let tx = 1; tx <= 20; tx++) for (let tz = 1; tz <= 20; tz++) { all += structuresForTile(7, tx, tz, plan).length; n += structuresForTile(7, tx, tz, plan, { chance: 0.3 }).length; }
  ok(all === 400 && n > 80 && n < 160, `a 30% chance keeps about a third of the tiles (${n} of 400)`);
  ok(structuresForTile(7, 3, -2, plan, { chance: 0 }).length === 0, 'chance 0 places nothing');
  const kept = structuresForTile(7, 5, 5, plan, { chance: 0.3 });
  ok(JSON.stringify(kept) === JSON.stringify(structuresForTile(7, 5, 5, plan, { chance: 0.3 })), 'the chance gate is deterministic');
}""")
save(p, s)
print('patched')
