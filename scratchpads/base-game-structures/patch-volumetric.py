import io
def load(p): return io.open(p, encoding='utf8', newline='').read()
def save(p, s): io.open(p, 'w', encoding='utf8', newline='').write(s)
def rep(s, a, b):
    nl = '\r\n' if '\r\n' in s[:5000] else '\n'
    a = a.replace('\n', nl); b = b.replace('\n', nl)
    assert a in s, a[:80]
    return s.replace(a, b, 1)

# protocol: accept structures on volumetric
p = 'base-game-protocol.mjs'; s = load(p)
s = rep(s, "  if (structures && volumetric) return { config: null, error: 'scattered structures are not built in volumetric rooms yet' };\n", "")
save(p, s)

# room server: volumetric branch seats structures on the density surface and runs both prepares
p = 'server/base-game-rooms.js'; s = load(p)
s = rep(s, """      const volume = createVolumeCollision(source, { worldQuery });
      const surface = (x, z) => source.surfaceYAt(x, z);
      const floorY = source.project?.density?.y_min;
      return {""", """      const volume = createVolumeCollision(source, { worldQuery });
      const surface = (x, z) => source.surfaceYAt(x, z);
      const floorY = source.project?.density?.y_min;
      // Structures seat on the density surface, the height plants and the spawn use here.
      let volumeStructures = null;
      if (config.structures) {
        const { createStructureCollision } = await import('../base-game-structure-collision.js');
        volumeStructures = createStructureCollision(source, { worldQuery, heightAt: surface, seaLevel, seed: config.structureSeed, spacing: config.structureSpacing });
      }
      return {""")
s = rep(s, """        volume,
        prepare: positions => volume.ensure(positions),
        covers: (x, z) => volume.covers(x, z),
      };""", """        volume,
        structures: volumeStructures,
        prepare: positions => { volume.ensure(positions); volumeStructures?.ensure(positions); },
        covers: (x, z) => volume.covers(x, z),
      };""")
save(p, s)

# page: no volumetric exclusion
p = 'base-game.html'; s = load(p)
s = rep(s, """    structures: settings.structuresEnabled && !volumetric, structureSeed: settings.structureSeed, structureSpacing: settings.structureSpacing };""",
"""    structures: settings.structuresEnabled, structureSeed: settings.structureSeed, structureSpacing: settings.structureSpacing };""")
s = rep(s, """  return settings.structuresEnabled && !(settings.terrainVolumetric && !!terrain.source?.densityAt);""",
"""  return settings.structuresEnabled;""")
s = rep(s, """  // Scattered structures are heightfield-only too, and their seed and spacing are world identity.""",
"""  // Scattered structures seat on groundHeight (the density surface when volumetric); seed and spacing are world identity.""")
s = rep(s, """const STRUCTURE_APPLY_KEYS = ['structuresEnabled', 'worldMode', 'structureSeed', 'structureSpacing', 'terrainVolumetric'];""",
"""const STRUCTURE_APPLY_KEYS = ['structuresEnabled', 'worldMode', 'structureSeed', 'structureSpacing'];""")
save(p, s)

# test: volumetric acceptance and a built structure on the surface
p = 'test-base-game-rooms-terrain.mjs'; s = load(p)
s = rep(s, """  const vol = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(v5Descriptor(v5Project(7)))), volumetric: true, structures: true });
  ok(vol.error?.includes('volumetric'), 'structures in a volumetric room are refused for now');""",
"""  const vol = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(v5Descriptor(v5Project(7)))), volumetric: true, structures: true });
  ok(!vol.error && vol.config.structures === true && vol.config.worldVersion.includes(':volume') && vol.config.worldVersion.endsWith(':structs1:1:480'), 'structures are accepted in a volumetric room');""")
s = rep(s, """  release(); pagePlan.dispose(); scheduler.dispose(); pageStructs.dispose();
}""", """  release(); pagePlan.dispose(); scheduler.dispose(); pageStructs.dispose();

  // Volumetric: the same buildings, seated on the density surface like the plants and the spawn.
  const caveDescriptor = v5Descriptor(v5Project(4242));
  const caveWs = new FakeSocket();
  service.handle(caveWs, { type: 'base:create', protocol: P, room: 'CAVEB', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor: caveDescriptor, volumetric: true, structures: true, structureSeed: 9 } });
  await service.ensureWorld();
  const cave = service.rooms.get('CAVEB');
  ok(cave.sim.volume && cave.sim.structures, 'a volumetric structures room streams both caves and buildings');
  const caveAt = [[720, 80, 720]];
  let caveRounds = 0;
  while (caveRounds < 400 && cave.sim.structures.builtCount < 1) { cave.sim.prepare(caveAt); caveRounds++; }
  const caveTile = [...cave.sim.structures.tiles.values()].find((t) => !t.empty);
  ok(caveTile, `a building bakes in the volumetric room (${cave.sim.structures.builtCount} in ${caveRounds} calls)`);
  if (caveTile) {
    const caveSrc = createSource(caveDescriptor);
    const s2 = caveTile.structure;
    ok(caveTile.model.site.baseY >= caveSrc.surfaceYAt(s2.x, s2.z) - 1e-6, 'it seats on the density surface, not the heightfield');
  }
}""")
save(p, s)
print('patched')
