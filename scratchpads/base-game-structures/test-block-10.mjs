
console.log('\n[10] scattered structures: the room streams a building at a plan site and the page-style plan agrees on the site');
{
  const { createStructureCollision, STRUCTURES_PROVIDER_ID } = await import('./base-game-structure-collision.js');
  const { structuresForTile } = await import('./base-game-structures.js');
  const { createFieldScheduler } = await import('./terrain-field-scheduler.js');
  const { createFieldWindow } = await import('./terrain-field-window.js');
  const { createPlanWalkDerive } = await import('./base-game-plan.js');
  const descriptor = analyticDescriptor({ key: 'base-game-structs', sourceVersion: '1', seaLevel: -200 });
  const bare = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(descriptor)) }).config;
  const withStructs = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(descriptor)), structures: true, structureSeed: 9 }).config;
  ok(withStructs.structures === true && withStructs.structureSeed === 9 && withStructs.structureSpacing === 480 && bare.structures === false, 'structures are an explicit opt-in with a seed and a default spacing');
  ok(withStructs.worldVersion !== bare.worldVersion && withStructs.worldVersion.endsWith(':structs1:9:480'), 'structures are part of the world identity');
  ok(describeBaseGameTerrainConfig(withStructs).structures === true, 'the description carries them');
  const vol = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(v5Descriptor(v5Project(7)))), volumetric: true, structures: true });
  ok(vol.error?.includes('volumetric'), 'structures in a volumetric room are refused for now');

  let clock = 1000;
  const service = createBaseGameRoomService({ now: () => clock });
  const ws = new FakeSocket();
  service.handle(ws, { type: 'base:create', protocol: P, room: 'STRUCT', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor, structures: true, structureSeed: 9 } });
  await service.ensureWorld();
  const room = service.rooms.get('STRUCT');
  const structs = room.sim.structures;
  ok(structs && typeof room.sim.prepare === 'function', 'a structures room has a streamed provider and a prepare step');
  // A player standing in tile (1, 1): the private plan window fills over a few ticks, then one
  // building bakes per tick until the cover ring is done.
  const at = [[720, 50, 720]];
  let rounds = 0;
  while (rounds < 400 && structs.builtCount < 4) { room.sim.prepare(at); rounds++; }
  ok(structs.builtCount >= 4, `${structs.builtCount} buildings built around the player in ${rounds} prepare calls (${structs.tileCount} tiles settled)`);
  const tile = structs.get(1, 1);
  ok(tile && !tile.empty && tile.model, `tile 1:1 holds a ${tile?.structure?.kind}`);
  const spawn = tile.model.spawn;
  const hit = room.sim.worldQuery.raycast({ origin: [spawn[0], spawn[1] + 3, spawn[2]], direction: [0, -1, 0], maxDistance: 20 });
  ok(hit && hit.providerId === STRUCTURES_PROVIDER_ID && hit.surfaceType === 'structure' && Math.abs(hit.point[1] - spawn[1]) < 0.02, 'a ray down at the building spawn lands on its floor through the structures provider');
  ok(structs.navRectsWithin({ minX: 720 - 192, maxX: 720 + 192, minZ: 720 - 192, maxZ: 720 + 192 }).length > 0, 'the NPC zone around the player gets structure nav rects');

  // The page's plan window is a 16-tile, 30 m-post window on the same source; its site for the
  // tile must be the room's site, or the page draws a building the room does not collide with.
  const src = createSource(descriptor);
  const walk = createPlanWalkDerive({ seaLevel: descriptor.seaLevel ?? 0 });
  const scheduler = createFieldScheduler({ useWorker: false, maxInFlight: 64, syncBudgetMs: 1000 });
  const pagePlan = createFieldWindow({ source: src, descriptor, scheduler, gpu: false, fields: ['heights', 'biomeIds', 'planWalk'], derived: ['planWalk'], derive: walk.derive, post: 30, tileIntervals: 16, tilesPerSide: 16, maxRequestsPerUpdate: 64 });
  const release = pagePlan.acquire();
  for (let i = 0; i < 40 && pagePlan.coverage < 1; i++) { pagePlan.update(720, 720); scheduler.pump(); }
  const pageSites = structuresForTile(9, 1, 1, pagePlan, { spacing: 480 });
  ok(pageSites && pageSites.length === 1 && pageSites[0].x === tile.structure.x && pageSites[0].z === tile.structure.z && pageSites[0].kind === tile.structure.kind && pageSites[0].seed === tile.structure.seed,
    `the page-style plan places the same ${pageSites?.[0]?.kind} at ${pageSites?.[0]?.x}, ${pageSites?.[0]?.z}`);
  // And the page's collider, built from the same site on the same source, is the same collider.
  const local = createWorldQueryService();
  local.registerProvider(createHeightfieldWorldQueryProvider(src, { id: 'terrain' }));
  const pageStructs = createStructureCollision(src, { worldQuery: local, seaLevel: descriptor.seaLevel ?? 0, seed: 9, spacing: 480, plan: () => pagePlan, maxBuildsPerCall: 8 });
  pageStructs.ensure(at); pageStructs.ensure(at);
  const localHit = local.raycast({ origin: [spawn[0], spawn[1] + 3, spawn[2]], direction: [0, -1, 0], maxDistance: 20 });
  ok(localHit && localHit.providerId === STRUCTURES_PROVIDER_ID && Math.abs(localHit.point[1] - hit.point[1]) < 1e-9, 'the page collider and the room collider agree on the floor height');
  // Walking away drops tiles outside the keep ring.
  const before = structs.tileCount;
  for (let i = 0; i < 6; i++) room.sim.prepare([[720 + 480 * 6, 50, 720]]);
  ok(!structs.has(1, 1) && structs.tileCount < before + 9, `tiles far from the player are dropped (${before} tiles before, ${structs.tileCount} now)`);
  release(); pagePlan.dispose(); scheduler.dispose(); pageStructs.dispose();
}
