// node test-base-game-spawn-collider.mjs -- the spawn building seats on the ground the same way
// for any host, bakes into a collider, and answers world queries where the layout says it should.
import * as THREE from 'three';
import { createWorldQueryService } from './world-query.js';
import { ECO_DEFAULTS } from './base-game-spawn-layout.js';
import {
  createSpawnBuildingModel, createSpawnBuildingCollider, createSpawnBuildingWorldQuery, spawnSite, spawnFootprint,
  SPAWN_BUILDING_PROVIDER_ID,
} from './base-game-spawn-collider.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// A rolling ground: the site must sit on its highest point under the footprint.
const heightAt = (x, z) => 3 + 1.5 * Math.sin(x * 0.11) + 1.2 * Math.cos(z * 0.09);

const model = createSpawnBuildingModel(heightAt, { seaLevel: 0 });
const fp = model.site.footprint;
ok(fp.maxX - fp.minX > 70 && fp.maxZ - fp.minZ > 90, `footprint spans the complex (${(fp.maxX - fp.minX).toFixed(0)} by ${(fp.maxZ - fp.minZ).toFixed(0)} m)`);
let maxGround = -Infinity;
for (let x = fp.minX; x <= fp.maxX; x += 1) for (let z = fp.minZ; z <= fp.maxZ; z += 1) maxGround = Math.max(maxGround, heightAt(x, z));
ok(model.site.baseY >= maxGround - 0.3, `floor datum ${model.site.baseY.toFixed(2)} clears the ground (max ${maxGround.toFixed(2)})`);
ok(model.site.plinthBottom < model.site.minY, 'plinth reaches below the lowest ground');
ok(model.boxes.plinth[0].y + model.boxes.plinth[0].h <= model.site.baseY - 0.3 + 1e-6, 'plinth meets the floor slabs from below');
ok(Math.abs(model.spawn[1] - (ECO_DEFAULTS.lobbyFloor * 0 + model.site.baseY)) < 1e-6, 'spawn stands on the plaza at the floor datum');
ok(model.boxes.walls.every((r) => r.y >= model.site.baseY - 0.3 - 1e-6), 'every wall is lifted onto the datum');

// Determinism across hosts: two builds from the same heightAt agree bit for bit.
const again = createSpawnBuildingModel(heightAt, { seaLevel: 0 });
ok(JSON.stringify(again.site) === JSON.stringify(model.site) && again.spawn.join() === model.spawn.join(), 'site and spawn are deterministic');

// Sea level raises the datum when the ground is under water.
const wet = spawnSite(model.layout, () => -5, { seaLevel: 0 });
ok(wet.baseY > 0, 'a submerged site is lifted to sea level');

// Collider: rays find the floor, the walls and the plinth where the layout puts them.
const building = createSpawnBuildingCollider(heightAt, { seaLevel: 0 });
ok(building.stats.collisionTriangles > 5000, `collider has ${building.stats.collisionTriangles} triangles`);
ok(building.provider.id === SPAWN_BUILDING_PROVIDER_ID, 'provider carries the stable id');
const worldQuery = createWorldQueryService();
worldQuery.registerProvider(building.provider);
// World queries speak [x, y, z] arrays, and a hit's point comes back the same way.
const down = [0, -1, 0];
const cast = (x, y, z, dir = down, max = 200) => worldQuery.raycast({ origin: [x, y, z], direction: dir, maxDistance: max });
const plaza = cast(model.spawn[0], model.spawn[1] + 5, model.spawn[2]);
ok(plaza && Math.abs(plaza.point[1] - model.site.baseY) < 0.02, `a ray down at the spawn lands on the plaza floor (${plaza ? plaza.point[1].toFixed(2) : 'miss'} vs ${model.site.baseY.toFixed(2)})`);
const lobbyFloor = cast(model.spawn[0] - 8, model.spawn[1] + 5, model.spawn[2]);
ok(lobbyFloor && Math.abs(lobbyFloor.point[1] - (model.site.baseY + ECO_DEFAULTS.lobbyFloor)) < 0.02, 'the raised lobby floor is 0.45 above the plaza');
const wallTop = model.boxes.walls.find((r) => r.h === ECO_DEFAULTS.slotWallH && Math.min(r.w, r.d) === 0.7);
const onWall = cast(wallTop.x, wallTop.y + wallTop.h + 5, wallTop.z);
ok(onWall && Math.abs(onWall.point[1] - (wallTop.y + wallTop.h)) < 0.02, 'a hallway wall top is where the layout says');
// Plinths follow the floor slabs, not the bounding box: the face a westward ray meets is the
// west edge of whichever slab covers that z, and the courts between wings stay open.
const zMid = (fp.minZ + fp.maxZ) / 2;
const slabsHere = model.layout.walls.filter((r) => r.y < 0 && Math.abs(zMid - r.z) <= r.d / 2);
const westEdge = Math.min(...slabsHere.map((r) => r.x - r.w / 2));
const plinthSide = cast(fp.minX - 5, model.site.plinthBottom + 0.5, zMid, [1, 0, 0], 60);
ok(plinthSide && Math.abs(plinthSide.point[0] - westEdge) < 0.02, `the plinth face is solid at the nearest slab edge (${plinthSide ? plinthSide.point[0].toFixed(1) : 'miss'} vs ${westEdge.toFixed(1)})`);
ok(model.boxes.plinth.length === slabsHere.length + model.layout.walls.filter((r) => r.y < 0 && Math.abs(zMid - r.z) > r.d / 2).length, 'one plinth per floor slab');
const court = cast(fp.minX + 1, 50, zMid);
ok(!court || court.point[1] < model.site.plinthBottom + 1e-6, 'the bounding box corner outside every slab is not concrete');
const outside = cast(fp.minX - 40, 50, fp.minZ - 40);
ok(!outside, 'nothing outside the footprint belongs to the building');

// The server convenience registers and unregisters cleanly.
const wq2 = createWorldQueryService();
const svc = createSpawnBuildingWorldQuery(wq2, heightAt, { seaLevel: 0 });
ok(!!wq2.raycast({ origin: [svc.spawn[0], svc.spawn[1] + 3, svc.spawn[2]], direction: down, maxDistance: 20 }), 'server world query sees the building');
svc.dispose();
ok(!wq2.raycast({ origin: [svc.spawn[0], svc.spawn[1] + 3, svc.spawn[2]], direction: down, maxDistance: 20 }), 'dispose unregisters the provider');

// The spawn-area world: building on a flat slab at the origin, the lab moved 200 m east.
{
  const { createSpawnAreaWorldQuery, shiftedLabLayout, SPAWN_AREA_LAB_OFFSET } = await import('./base-game-spawn-collider.js');
  const { createTraversalLabLayout } = await import('./traversal-lab-layout.js');
  const base = createTraversalLabLayout();
  const moved = shiftedLabLayout(base, 200, 0);
  ok(moved.primitives.length === base.primitives.length && moved.primitives.every((p, i) => p.cx === base.primitives[i].cx + 200 && p.cz === base.primitives[i].cz), 'the shifted lab keeps every primitive, 200 m east');
  ok(moved.spawn[0] === base.spawn[0] + 200 && moved.version === base.version && moved.probes === base.probes, 'spawn moves with it; version and probes untouched');
  const wq = createWorldQueryService();
  const area = await createSpawnAreaWorldQuery(wq);
  ok(Math.abs(area.spawn[1] - 1.5) < 1e-6 && area.spawn[0] === 0, `the spawn-area spawn is on the plaza at the slab datum plus 1.5 (${area.spawn[1].toFixed(2)})`);
  const c = (x, y, z) => wq.raycast({ origin: [x, y, z], direction: [0, -1, 0], maxDistance: 50 });
  const onSlab = c(-120, 10, 120);   // clear of the building (x -18..61, z -68..34) and the lab (x 200+)
  ok(onSlab && Math.abs(onSlab.point[1] + 0.3) < 0.02, `open ground beside the building is the slab, 0.3 m under the datum (${onSlab ? onSlab.point[1].toFixed(2) + ' via ' + onSlab.providerId : 'miss'})`);
  const onLab = c(SPAWN_AREA_LAB_OFFSET.x, 10, 0);
  ok(onLab && onLab.providerId === 'traversal-lab-static' && Math.abs(onLab.point[1]) < 0.02, 'the lab floor answers at its offset');
  const plaza = c(0, 5, 4.5);
  ok(plaza && plaza.providerId === 'spawn-building-static', 'the building answers at the origin');
  ok(/^traversal-lab-v\d+-spawn-area-v1-bld1$/.test(area.worldVersion), `world version keeps the lab prefix the room service keys on (${area.worldVersion})`);
  area.dispose();
  ok(!c(0, 5, 4.5) && !c(SPAWN_AREA_LAB_OFFSET.x, 10, 0), 'dispose unregisters both');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
