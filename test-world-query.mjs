import {
  WORLD_QUERY_ALL_LAYERS,
  WORLD_QUERY_CONTRACT_VERSION,
  createWorldQueryService,
} from './world-query.js';

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function horizontalPlaneProvider({ id, y, normal = [0, 1, 0], layers = WORLD_QUERY_ALL_LAYERS, priority = 0 }) {
  function hit(query) {
    if (Math.abs(query.direction[1]) < 1e-9) return null;
    const distance = (y - query.origin[1]) / query.direction[1];
    if (distance < 0 || distance > query.maxDistance) return null;
    return {
      distance,
      point: [
        query.origin[0] + query.direction[0] * distance,
        y,
        query.origin[2] + query.direction[2] * distance,
      ],
      normal,
      colliderId: `${id}-plane`,
      surfaceType: id,
    };
  }
  return { id, layers, priority, raycast: hit, raycastAll: query => { const value = hit(query); return value ? [value] : []; } };
}

ok(WORLD_QUERY_CONTRACT_VERSION === 2, 'world-query contract is versioned');

{
  const world = createWorldQueryService();
  world.registerProvider(horizontalPlaneProvider({ id: 'lower', y: 4 }));
  world.registerProvider(horizontalPlaneProvider({ id: 'upper', y: 10 }));
  const hit = world.raycast({ origin: [2, 20, 3], direction: [0, -10, 0], maxDistance: 30 });
  ok(hit?.providerId === 'upper' && near(hit.distance, 10), 'raycast normalizes direction and returns nearest stacked surface');
  const hits = world.raycastAll({ origin: [2, 20, 3], direction: [0, -1, 0], maxDistance: 30 });
  ok(hits.length === 2 && hits[0].providerId === 'upper' && hits[1].providerId === 'lower',
    'raycastAll retains vertically stacked surfaces in distance order');
  ok(hits[0].colliderId === 'upper-plane' && hits[0].surfaceType === 'upper', 'hit identity and surface metadata survive normalization');
}

{
  const world = createWorldQueryService();
  world.registerProvider({
    id: 'capsule-floor',
    resolveCapsule: query => {
      const capsule = structuredClone(query.capsule);
      const velocity = [...query.velocity];
      const bottom = capsule.start[1] - capsule.radius;
      if (bottom >= 0) return { capsule, velocity, grounded: false, contacts: [] };
      const lift = -bottom;
      capsule.start[1] += lift;
      capsule.end[1] += lift;
      velocity[1] = Math.max(0, velocity[1]);
      return { capsule, velocity, grounded: true, contacts: [{ normal: [0, 1, 0], depth: lift }] };
    },
  });
  const resolved = world.resolveCapsule({
    capsule: { start: [0, 0.2, 0], end: [0, 1.4, 0], radius: 0.35 },
    velocity: [1, -4, 0],
  });
  ok(near(resolved.capsule.start[1], 0.35) && resolved.grounded,
    'capsule resolution returns provider-corrected 3D geometry and grounded state');
  ok(near(resolved.velocity[1], 0) && resolved.contacts[0]?.providerId === 'capsule-floor',
    'capsule resolution carries corrected velocity and provider-tagged contacts');
}

{
  const world = createWorldQueryService();
  world.registerProvider({
    id: 'multi-only',
    raycastAll: query => [{ distance: 6, point: [query.origin[0], query.origin[1] - 6, query.origin[2]], normal: [0, 1, 0] }],
  });
  const hit = world.raycast({ origin: [0, 12, 0], direction: [0, -1, 0] });
  ok(hit?.providerId === 'multi-only' && near(hit.distance, 6),
    'raycast accepts a multi-hit-only provider and omitted maxDistance means unbounded');
}

{
  const world = createWorldQueryService();
  world.registerProvider(horizontalPlaneProvider({ id: 'steep-upper', y: 10, normal: [1, 0.1, 0] }));
  world.registerProvider(horizontalPlaneProvider({ id: 'walkable-lower', y: 4 }));
  const ground = world.groundProbe({ origin: [0, 20, 0], maxDistance: 30, slopeLimitCos: 0.5 });
  ok(ground?.providerId === 'walkable-lower' && ground.walkable, 'ground probe skips nearer non-walkable surface and finds lower floor');
  ok(near(ground.point[1], 4), 'ground probe returns complete 3D hit position');
  ok(ground.capsuleSupport === true, 'ray-backed ground probes identify mesh-shaped capsule support');
}

{
  const world = createWorldQueryService();
  world.registerProvider(horizontalPlaneProvider({ id: 'terrain', y: 2, layers: 0b001 }));
  world.registerProvider(horizontalPlaneProvider({ id: 'structure', y: 8, layers: 0b010 }));
  const terrain = world.raycast({ origin: [0, 20, 0], direction: [0, -1, 0], maxDistance: 30, mask: 0b001 });
  const structure = world.raycast({ origin: [0, 20, 0], direction: [0, -1, 0], maxDistance: 30, mask: 0b010 });
  const excluded = world.raycast({ origin: [0, 20, 0], direction: [0, -1, 0], maxDistance: 30, excludeProviderIds: ['structure'] });
  ok(terrain?.providerId === 'terrain' && structure?.providerId === 'structure', 'query masks select provider layers');
  ok(excluded?.providerId === 'terrain', 'provider exclusion works without changing registrations');
}

{
  const world = createWorldQueryService();
  world.registerProvider(horizontalPlaneProvider({ id: 'first', y: 5, priority: 0 }));
  const removePreferred = world.registerProvider(horizontalPlaneProvider({ id: 'preferred', y: 5, priority: 10 }));
  ok(world.raycast({ origin: [0, 10, 0], direction: [0, -1, 0], maxDistance: 20 })?.providerId === 'preferred',
    'provider priority deterministically breaks equal-distance ties');
  ok(removePreferred() && !removePreferred(), 'registration disposer unregisters exactly once');
  ok(world.raycast({ origin: [0, 10, 0], direction: [0, -1, 0], maxDistance: 20 })?.providerId === 'first',
    'unregistered provider stops answering queries');
}

{
  const world = createWorldQueryService();
  world.registerProvider({
    id: 'volume',
    sweep: query => ({ distance: 3, point: [query.origin[0] + 3, query.origin[1], query.origin[2]], normal: [-1, 0, 0], fraction: 0.3 }),
    overlap: () => [{ colliderId: 'box-a' }, { colliderId: 'box-b' }],
    pointContents: query => query.origin[1] < 0 ? { solid: true, kind: 'cave-rock' } : false,
  });
  const sweep = world.sweep({ origin: [0, 1, 0], direction: [1, 0, 0], maxDistance: 10, shape: { type: 'capsule' } });
  ok(sweep?.providerId === 'volume' && near(sweep.fraction, 0.3), '3D shape sweep dispatches and normalizes provider hit');
  const overlaps = world.overlap({ origin: [0, 0, 0], shape: { type: 'capsule' } });
  ok(overlaps.length === 2 && overlaps.every(hit => hit.providerId === 'volume'), 'overlap aggregates provider identities');
  const inside = world.pointContents({ origin: [0, -1, 0] });
  const outside = world.pointContents({ origin: [0, 1, 0] });
  ok(inside.solid && inside.entries[0].contents.kind === 'cave-rock', 'point contents supports volumetric solid metadata');
  ok(!outside.solid && outside.entries.length === 0, 'point contents reports empty space');
  ok(world.hasCapability('sweep') && !world.hasCapability('groundProbe'), 'capability discovery reflects registered providers');
}

{
  const world = createWorldQueryService();
  const provider = horizontalPlaneProvider({ id: 'toggle', y: 3 });
  world.registerProvider(provider);
  provider.enabled = false;
  ok(world.raycast({ origin: [0, 10, 0], direction: [0, -1, 0], maxDistance: 20 }) === null, 'disabled provider is ignored live');
  provider.enabled = true;
  ok(world.raycast({ origin: [0, 10, 0], direction: [0, -1, 0], maxDistance: 20 })?.providerId === 'toggle', 'provider can be re-enabled without re-registration');
}

{
  const world = createWorldQueryService();
  let duplicate = false, asyncRejected = false;
  world.registerProvider(horizontalPlaneProvider({ id: 'unique', y: 0 }));
  try { world.registerProvider(horizontalPlaneProvider({ id: 'unique', y: 1 })); } catch { duplicate = true; }
  world.registerProvider({ id: 'bad-async', raycast: async () => null });
  try { world.raycast({ origin: [0, 2, 0], direction: [0, -1, 0], maxDistance: 10 }); } catch { asyncRejected = true; }
  ok(duplicate, 'duplicate provider IDs fail loudly');
  ok(asyncRejected, 'frame-critical world queries reject asynchronous providers');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
