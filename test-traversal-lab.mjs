import fs from 'node:fs';
import * as THREE from 'three';
import { createBaseGameTraversalLab } from './base-game-traversal-lab.js';
import { createTraversalLabLayout, TRAVERSAL_LAB_LAYOUT_VERSION } from './traversal-lab-layout.js';
import { createMapColliderWorldQueryProvider } from './world-query-map-provider.js';
import { createWorldQueryService } from './world-query.js';

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

const a = createTraversalLabLayout();
const b = createTraversalLabLayout();
ok(a.version === TRAVERSAL_LAB_LAYOUT_VERSION && a.version === 1, 'layout is explicitly versioned');
ok(JSON.stringify(a) === JSON.stringify(b), 'layout generation is deterministic');
ok(a.primitives.length >= 45, 'lab contains a substantial diagnostic geometry set');

const ids = new Set(a.primitives.map(primitive => primitive.id));
ok(ids.size === a.primitives.length, 'every diagnostic primitive has a unique stable ID');
ok(a.primitives.every(p => p.sx > 0 && p.sy > 0 && p.sz > 0 && [p.cx, p.cy, p.cz, p.rx, p.ry, p.rz].every(Number.isFinite)),
  'every primitive has finite coordinates/rotation and positive dimensions');
ok(a.primitives.every(p => a.materials[p.material]), 'every primitive references a declared material');

const zones = new Set(a.primitives.map(primitive => primitive.zone));
for (const zone of ['origin', 'slopes', 'stairs', 'steps', 'bridge', 'tunnel', 'clearance', 'stacked-floors', 'ledges', 'corners', 'cave', 'distance']) {
  ok(zones.has(zone), `required diagnostic zone exists: ${zone}`);
}

ok(a.probes.some(probe => probe.expectedY.length >= 3), 'at least one probe describes three surfaces at one X/Z');
ok(a.probes.every(probe => new Set(probe.expectedY).size === probe.expectedY.length), 'stacked probe elevations are distinct');
ok(a.primitives.some(p => p.id === 'distant-rebase-platform' && Math.abs(p.cx) > 8192),
  'long-distance platform crosses the default rebase threshold');

{
  const calls = [];
  const collider = {
    raycast(origin, direction, maxDistance) {
      calls.push(['one', origin, direction, maxDistance]);
      return { distance: 3, point: [origin[0], origin[1] - 3, origin[2]], normal: [0, 1, 0] };
    },
    raycastAll(origin, direction, maxDistance) {
      calls.push(['all', origin, direction, maxDistance]);
      return [
        { distance: 3, point: [origin[0], origin[1] - 3, origin[2]], normal: [0, 1, 0] },
        { distance: 8, point: [origin[0], origin[1] - 8, origin[2]], normal: [0, 1, 0] },
      ];
    },
  };
  const provider = createMapColliderWorldQueryProvider(collider, { id: 'lab-test', priority: 7, layers: 0b10 });
  const world = createWorldQueryService();
  world.registerProvider(provider);
  const hit = world.raycast({ origin: [1, 10, 2], direction: [0, -1, 0], maxDistance: 20, mask: 0b10 });
  const hits = world.raycastAll({ origin: [1, 10, 2], direction: [0, -1, 0], maxDistance: 20, mask: 0b10 });
  ok(hit?.providerId === 'lab-test' && hit.distance === 3, 'map collider adapter answers through world-query service');
  ok(hits.length === 2 && hits[1].distance === 8, 'map collider adapter preserves stacked multi-hit results');
  provider.enabled = false;
  ok(world.raycast({ origin: [1, 10, 2], direction: [0, -1, 0], maxDistance: 20 }) === null,
    'live provider enablement removes hidden lab from queries');
  ok(calls.length === 2, 'disabled provider does not call the collider');
}

{
  const html = fs.readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  ok(html.includes("worldMode: 'traversalLab'"), 'Base Game defaults to visible Traversal Lab world mode');
  ok(html.includes("addSelect(worldSec, 'worldMode'"), 'world mode is an in-game saved control');
  ok(html.includes("addToggle(worldSec, 'labCollisionDebug'"), 'collision debug is an in-game saved control');
  ok(html.includes('createBaseGameTraversalLab({ scene, worldQuery })'), 'Base Game constructs the lab with the shared query service');
}

{
  const scene = new THREE.Scene();
  const world = createWorldQueryService();
  const lab = createBaseGameTraversalLab({ scene, worldQuery: world });
  ok(scene.getObjectByName('base-game-traversal-lab') === lab.root, 'real merged Traversal Lab is attached to the scene');
  ok(lab.stats.materialDraws === Object.keys(a.materials).length, 'real lab merges geometry to one mesh per material');
  ok(lab.stats.collisionTriangles > 0 && lab.stats.collisionTriangles < 50_000, 'real BVH collider stays inside the diagnostic triangle budget');

  for (const probe of a.probes) {
    const hits = world.raycastAll({ origin: probe.origin, direction: [0, -1, 0], maxDistance: 30 });
    const upwardY = hits.filter(hit => hit.normal?.[1] > 0.5).map(hit => hit.point[1]);
    const found = probe.expectedY.every(expected => upwardY.some(actual => Math.abs(actual - expected) < 1e-6));
    ok(found, `real BVH preserves expected stacked walkable surfaces: ${probe.id}`);
  }

  lab.setVisible(false);
  ok(world.raycast({ origin: [-34, 12, 0], direction: [0, -1, 0], maxDistance: 20 }) === null,
    'hiding real lab also disables its BVH provider');
  lab.setVisible(true);
  ok(world.groundProbe({ origin: [-34, 12, 0], maxDistance: 20 })?.point[1] === 6,
    'real world-query ground probe selects bridge deck above ground at the same X/Z');
  lab.dispose();
  ok(scene.getObjectByName('base-game-traversal-lab') === undefined && world.providerIds().length === 0,
    'disposing lab removes both scene geometry and query provider');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
