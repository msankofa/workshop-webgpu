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
const plinthSide = cast(fp.minX - 5, model.site.plinthBottom + 0.5, (fp.minZ + fp.maxZ) / 2, [1, 0, 0], 20);
ok(plinthSide && Math.abs(plinthSide.point[0] - fp.minX) < 0.02, 'the plinth face is solid at the footprint edge');
const outside = cast(fp.minX - 40, 50, fp.minZ - 40);
ok(!outside, 'nothing outside the footprint belongs to the building');

// The server convenience registers and unregisters cleanly.
const wq2 = createWorldQueryService();
const svc = createSpawnBuildingWorldQuery(wq2, heightAt, { seaLevel: 0 });
ok(!!wq2.raycast({ origin: [svc.spawn[0], svc.spawn[1] + 3, svc.spawn[2]], direction: down, maxDistance: 20 }), 'server world query sees the building');
svc.dispose();
ok(!wq2.raycast({ origin: [svc.spawn[0], svc.spawn[1] + 3, svc.spawn[2]], direction: down, maxDistance: 20 }), 'dispose unregisters the provider');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
