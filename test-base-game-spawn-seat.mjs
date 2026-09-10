// node test-base-game-spawn-seat.mjs -- the spawn building reseats exactly when one of its seat
// inputs changes (world mode, source, effective volumetric, sea level), samples the ground that is
// live at that moment, and moves a grounded player with the floor. The player cases run the real
// controller on the real building collider. The page's ordering is checked from its source text:
// the page cannot be executed here, so that check reads the order of the calls, nothing more.
import { readFileSync } from 'node:fs';
import { createSpawnSeatSync, spawnSeatState, spawnSeatChanged, playerAfterReseat, createSpawnSeatPlayer, FLOOR_TOLERANCE } from './base-game-spawn-seat.js';
import { createSpawnBuildingModel, createSpawnBuildingCollider, createSpawnBuildingWorldQuery } from './base-game-spawn-collider.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';
import { createWorldQueryService } from './world-query.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// A fake terrain: the heightfield is 2 m, the density surface 5 m, only sampled in volumetric mode.
function fakeTerrain() {
  const t = { source: { id: 'A', densityAt: () => 0 }, volumetric: false, seaLevel: 0 };
  t.groundHeight = () => (t.volumetric ? 5 : 2);
  return t;
}
// A fake building: the rebuild spy samples the ground it was handed.
function fakeBuilding() {
  const b = { rebuilds: 0, sampled: [], visible: null, stats: { baseY: 0 }, fails: false };
  b.rebuild = (heightAt, sea) => { if (b.fails) throw new Error('boom'); b.rebuilds++; b.sampled.push(heightAt(0, 0)); b.stats.baseY = Math.max(heightAt(0, 0), sea) + 0.05; };
  b.setVisible = (v) => { b.visible = v; };
  b.footprintContains = () => true;
  return b;
}
const settings = { worldMode: 'terrain', terrainVolumetric: false };
const terrain = fakeTerrain();
const building = fakeBuilding();
const ground = () => (settings.worldMode === 'terrain'
  ? { state: spawnSeatState({ worldMode: 'terrain', source: terrain.source, volumetric: terrain.volumetric, seaLevel: terrain.seaLevel }), heightAt: terrain.groundHeight, seaLevel: terrain.seaLevel, options: {} }
  : { state: spawnSeatState({ worldMode: 'slab' }), heightAt: () => 0, seaLevel: -1e9, options: { slab: true } });
// The same order as the page's updateWorld: apply the requested volume mode, then sync. The page
// source check further down is what ties this to the real page.
const canVolumetric = () => !!terrain.source.densityAt;
const updateWorld = () => { terrain.volumetric = settings.terrainVolumetric && canVolumetric(); return seat.sync(); };
const seated = [];
let errors = 0;
// The constructor seated the building on the initial inputs.
building.rebuild(ground().heightAt, ground().seaLevel, {});
const seat = createSpawnSeatSync({ building, ground, wanted: () => settings.worldMode === 'terrain', onSeated: (s) => seated.push(s), onError: () => errors++, initial: ground().state });
ok(building.rebuilds === 1 && updateWorld() === false && building.rebuilds === 1, 'the constructor seat is recorded: the first update does no work');

// The original bug: a project with volume requested. Install the source, set the flag, update once.
settings.terrainVolumetric = true;
terrain.source = { id: 'B', densityAt: () => 0 };
ok(updateWorld() === true && building.rebuilds === 2 && building.sampled[1] === 5, `the apply reseats once on the density surface (sampled ${building.sampled[1]})`);
ok(updateWorld() === false && updateWorld() === false && building.rebuilds === 2, 'unchanged updates do nothing');
settings.terrainVolumetric = false; updateWorld();
ok(building.rebuilds === 3 && building.sampled[2] === 2, 'volumetric off reseats on the heightfield');
settings.terrainVolumetric = true; updateWorld();
ok(building.rebuilds === 4 && building.sampled[3] === 5, 'volumetric on reseats on the density surface');
terrain.source = { id: 'C', densityAt: () => 0 }; updateWorld();
ok(building.rebuilds === 5 && building.sampled[4] === 5, 'a replacement source while already volumetric reseats');
terrain.seaLevel = 8; updateWorld();
ok(building.rebuilds === 6 && Math.abs(building.stats.baseY - 8.05) < 1e-9, 'a sea-level-only change reseats and lifts the datum above the water');
terrain.source = { id: 'D', densityAt: () => 0 }; terrain.seaLevel = 0; settings.terrainVolumetric = false; updateWorld();
ok(building.rebuilds === 7, 'combined source, volume and sea changes coalesce to one rebuild');
terrain.source = { id: 'E' }; settings.terrainVolumetric = true; updateWorld(); updateWorld();
ok(building.rebuilds === 8 && seat.applied.volumetric === false && building.sampled[7] === 2, 'volume requested on a density-less source records effective false, once');
settings.worldMode = 'slab'; updateWorld();
ok(building.rebuilds === 9 && building.visible === false && seat.applied.worldMode === 'slab', 'the slab world seats flat and hides the building');
terrain.source = { id: 'F', densityAt: () => 0 }; terrain.seaLevel = 3; updateWorld();
ok(building.rebuilds === 9, 'terrain changes under the slab world do not rebuild the slab building');
settings.worldMode = 'terrain'; updateWorld();
ok(building.rebuilds === 10 && building.visible === true && seat.applied.source === terrain.source && seat.applied.seaLevel === 3, 'returning to terrain consumes the latest terrain state in one rebuild');
building.fails = true; terrain.seaLevel = 4; updateWorld(); updateWorld();
ok(building.rebuilds === 10 && errors === 1 && seat.stats.failures === 2 && seat.applied.seaLevel === 3, 'a failed rebuild publishes nothing, reports once, and stays due');
building.fails = false; updateWorld();
ok(building.rebuilds === 11 && seat.applied.seaLevel === 4, 'the retry lands');
ok(seated.length === 10, `onSeated fired per successful reseat after the first (${seated.length})`);
ok(!spawnSeatChanged(spawnSeatState({ worldMode: 'terrain', source: terrain.source, volumetric: 1, seaLevel: 4 }), seat.applied), 'the record compares by value, volumetric coerced');

// The decision on its own.
const safe = () => [9, 9, 9];
let r = playerAfterReseat({ position: [1, 2.05, 1], wasOnFloor: true, onFloor: true, newFloor: 5.05, headroom: () => true, safeSpawn: safe });
ok(r.action === 'floor' && r.position[1] === 5.05 && r.position[0] === 1, 'a floor occupant rides the floor up at the same X/Z');
r = playerAfterReseat({ position: [1, 5.05, 1], wasOnFloor: true, onFloor: true, newFloor: 2.05, headroom: () => true, safeSpawn: safe });
ok(r.action === 'floor' && r.position[1] === 2.05, 'and down');
r = playerAfterReseat({ position: [1, 2.05, 1], wasOnFloor: true, onFloor: true, newFloor: 5.05, headroom: () => false, safeSpawn: safe });
ok(r.action === 'spawn' && r.position[0] === 9, 'no headroom at the new floor means the safe spawn');
r = playerAfterReseat({ position: [1, 2, 1], wasOnFloor: false, onFloor: false, newFloor: 5.05, headroom: () => true, safeSpawn: safe });
ok(r.action === 'keep', 'a player in an open court or outside is left alone');
r = playerAfterReseat({ position: [1, 12, 1], wasOnFloor: false, onFloor: true, newFloor: 5.05, headroom: () => true, safeSpawn: safe });
ok(r.action === 'keep', 'a player on a roof or in the air over a slab is left alone');
r = playerAfterReseat({ position: [1, 5.05 - FLOOR_TOLERANCE / 2, 1], wasOnFloor: false, onFloor: true, newFloor: 5.05, headroom: () => true, safeSpawn: safe });
ok(r.action === 'keep', 'within the floor tolerance is not buried');

// The real controller on the real building collider. Seat the building at 2 m, stand the player
// on its plaza, then reseat at 5 m and at 1 m and see where the hooks put them.
const asBuilding = (b) => ({ stats: { baseY: b.model.site.baseY }, footprintContains: (x, z) => b.model.layout.walls.some((w) => w.y < 0 && Math.abs(x - w.x) <= w.w / 2 && Math.abs(z - w.z) <= w.d / 2) });
function standing(worldQuery, spawn) {
  const c = createBaseGamePlayerController({ worldQuery, spawn: [spawn[0], spawn[1] + 0.3, spawn[2]] });
  for (let i = 0; i < 90 && !c.grounded; i++) c.advance(1 / 60);
  return c;
}
{
  const wq = createWorldQueryService();
  let b = createSpawnBuildingWorldQuery(wq, () => 2, { seaLevel: 0 });
  const controller = standing(wq, b.model.spawn);
  ok(controller.grounded && Math.abs(controller.getPosition()[1] - b.model.site.baseY) < 0.05, `the player stands on the plaza at ${controller.getPosition()[1].toFixed(3)}`);
  let active = true;
  const hooks = createSpawnSeatPlayer({ controller, worldQuery: wq, safeSpawn: safe, active: () => active });
  const reseat = (h) => { const before = hooks.capture(asBuilding(b)); b.dispose(); b = createSpawnBuildingWorldQuery(wq, () => h, { seaLevel: 0 }); return hooks.settle(asBuilding(b), before); };
  let res = reseat(5);
  ok(res.action === 'floor' && Math.abs(controller.getPosition()[1] - 5.05) < 1e-9, 'a grounded plaza occupant rides the floor up to the new datum');
  for (let i = 0; i < 30; i++) controller.advance(1 / 60);   // a reset clears grounded; the next frames restore it
  ok(controller.grounded && Math.abs(controller.getPosition()[1] - 5.05) < 0.05, `and stands there through the collider (${controller.getPosition()[1].toFixed(3)})`);
  res = reseat(1);
  ok(res.action === 'floor' && Math.abs(controller.getPosition()[1] - 1.05) < 1e-9, `and back down (${res.action} ${controller.getPosition()[1].toFixed(3)})`);
  for (let i = 0; i < 30; i++) controller.advance(1 / 60);
  ok(controller.grounded && Math.abs(controller.getPosition()[1] - 1.05) < 0.05, `and stays standing there through the collider (${controller.grounded} ${controller.getPosition()[1].toFixed(3)})`);
  // Jumping: not grounded, so not a floor occupant. Down keeps them in the air; up buries them.
  controller.queueJump(); for (let i = 0; i < 3 && controller.grounded; i++) controller.advance(1 / 60);
  ok(!controller.grounded && controller.getVelocity()[1] > 0, `the player has taken off (${controller.grounded} vy ${controller.getVelocity()[1].toFixed(2)})`);
  const airY = controller.getPosition()[1], airV = controller.getVelocity()[1];
  res = reseat(0.5);
  ok(res.action === 'keep' && controller.getPosition()[1] === airY && controller.getVelocity()[1] === airV, 'a jumping player is left in the air with their velocity when the floor drops');
  res = reseat(6);
  ok(res.action === 'spawn' && controller.getPosition()[0] === 9, 'a jumping player the new floor buries goes to the safe spawn');
  // Not active (online, in a vehicle, flying a drone): the hooks do nothing.
  active = false;
  standing(wq, b.model.spawn);
  ok(hooks.capture(asBuilding(b)) === null && hooks.settle(asBuilding(b), null) === null, 'inactive hooks neither capture nor move');
  b.dispose();
}
// Headroom through the capsule: an obstruction that only pushes the capsule sideways still fails,
// a ceiling fails, and a query exception is not free space.
{
  const controller = { grounded: true, getPosition: () => [1, 2, 1], getCapsule: () => ({ start: [1, 2.35, 1], end: [1, 3.45, 1], radius: 0.35 }), reset: () => {} };
  const probe = (fn) => createSpawnSeatPlayer({ controller, worldQuery: { resolveCapsule: fn }, safeSpawn: safe });
  const b = { stats: { baseY: 5 }, footprintContains: () => true };
  ok(probe((q) => ({ capsule: q.capsule, ceiling: false })).settle(b, { wasOnFloor: true }).action === 'floor', 'an untouched capsule is headroom');
  ok(probe((q) => ({ capsule: { ...q.capsule, start: [q.capsule.start[0] + 0.2, q.capsule.start[1], q.capsule.start[2]] }, ceiling: false })).settle(b, { wasOnFloor: true }).action === 'spawn', 'a sideways push is an obstruction');
  ok(probe((q) => ({ capsule: q.capsule, ceiling: true })).settle(b, { wasOnFloor: true }).action === 'spawn', 'a ceiling is an obstruction');
  ok(probe(() => { throw new Error('no providers'); }).settle(b, { wasOnFloor: true }).action === 'spawn', 'a failed query is not free space');
  let seen = null;
  probe((q) => { seen = q.capsule; return { capsule: q.capsule, ceiling: false }; }).settle(b, { wasOnFloor: true });
  ok(seen && Math.abs(seen.start[1] - 5.35) < 1e-9 && Math.abs(seen.end[1] - 6.45) < 1e-9 && seen.radius === 0.35, 'the live stance capsule is tested at the new floor');
}

// The page's order, from its source: updateWorld applies the volumetric switch before the seat
// sync, the apply and adopt paths hold no reseat of their own, and both reach updateWorld(0).
{
  const page = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  const body = (name) => { const i = page.indexOf(`function ${name}(`); const j = page.indexOf('\nfunction ', i + 1); return page.slice(i, j < 0 ? undefined : j); };
  const uw = body('updateWorld');
  ok(uw.indexOf('terrain.setVolumetric(') > 0 && uw.indexOf('terrain.setVolumetric(') < uw.indexOf('spawnSeat.sync()'), 'updateWorld switches volumetric before the seat sync');
  ok(uw.indexOf('applyWaterSettings()') < uw.indexOf('spawnSeat.sync()'), 'and applies the water settings before it');
  ok(!page.includes('syncSpawnBuilding(') && !page.includes('spawnBuilding.rebuild('), 'no hand reseat is left in the page');
  for (const name of ['applyTerrainProjectAtRuntime', 'adoptRoomTerrain']) {
    const b = body(name);
    ok(b.indexOf('terrain.setSource(') > 0 && b.indexOf('terrain.setSource(') < b.indexOf('updateWorld(0)'), `${name} installs the source, then reaches updateWorld(0)`);
  }
}

// Client/server parity: the page's rebuild(heightAt, seaLevel, {}) and the room's
// createSpawnBuildingWorldQuery(worldQuery, surface, { seaLevel }) reach the same datum and spawn.
for (const [name, heightAt] of [['heightfield', (x, z) => 2 + Math.sin(x * 0.07) * 3 + Math.cos(z * 0.05)], ['density', (x, z) => 6 + Math.sin(x * 0.11) * 2]]) {
  const page = createSpawnBuildingCollider(heightAt, { seaLevel: 4.5 });
  const server = createSpawnBuildingWorldQuery(createWorldQueryService(), heightAt, { seaLevel: 4.5 });
  const model = createSpawnBuildingModel(heightAt, { seaLevel: 4.5 });
  const same = (a, b) => Math.abs(a - b) < 1e-9;
  ok(same(page.model.site.baseY, server.model.site.baseY) && same(page.model.site.baseY, model.site.baseY)
    && page.model.spawn.every((v, i) => same(v, server.model.spawn[i])), `${name}: page and server datum ${page.model.site.baseY.toFixed(3)} and spawn agree`);
  ok(page.model.site.baseY >= 4.5 + 0.05 - 1e-9 && page.model.site.baseY >= page.model.site.maxY, `${name}: the datum clears the sea and the highest sample`);
  page.dispose?.(); server.dispose?.();
}

console.log(`test-base-game-spawn-seat: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
