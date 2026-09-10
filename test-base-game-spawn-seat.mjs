// node test-base-game-spawn-seat.mjs -- the spawn building reseats exactly when one of its seat
// inputs changes (world mode, source, effective volumetric, sea level), samples the ground that is
// live at that moment, and puts a solo player on the new floor. Plus client/server parity through
// the shared model.
import { createSpawnSeatSync, spawnSeatState, spawnSeatChanged, playerAfterReseat, FLOOR_TOLERANCE } from './base-game-spawn-seat.js';
import { createSpawnBuildingModel, createSpawnBuildingCollider, createSpawnBuildingWorldQuery } from './base-game-spawn-collider.js';
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
  const b = { rebuilds: 0, sampled: [], visible: null, baseY: 0, fails: false };
  b.rebuild = (heightAt, sea) => { if (b.fails) throw new Error('boom'); b.rebuilds++; b.sampled.push(heightAt(0, 0)); b.baseY = Math.max(heightAt(0, 0), sea) + 0.05; };
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
// The page's order: apply the requested volume mode, then sync.
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
ok(building.rebuilds === 6 && Math.abs(building.baseY - 8.05) < 1e-9, 'a sea-level-only change reseats and lifts the datum above the water');
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

// The player after a reseat.
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
r = playerAfterReseat({ position: [1, 2, 1], wasOnFloor: false, onFloor: true, newFloor: 5.05, headroom: () => true, safeSpawn: safe });
ok(r.action === 'spawn', 'a player the new floor buried goes to the safe spawn');
r = playerAfterReseat({ position: [1, 5.05 - FLOOR_TOLERANCE / 2, 1], wasOnFloor: false, onFloor: true, newFloor: 5.05, headroom: () => true, safeSpawn: safe });
ok(r.action === 'keep', 'within the floor tolerance is not buried');
// The page's capture/settle hooks run around the rebuild.
{
  const b = fakeBuilding(); b.rebuild(() => 2, 0, {});
  const calls = [];
  const s = createSpawnSeatSync({ building: b, ground: () => ({ state: spawnSeatState({ worldMode: 'terrain', source: 'x', volumetric: true }), heightAt: () => 5, seaLevel: 0, options: {} }),
    wanted: () => true, initial: spawnSeatState({ worldMode: 'terrain', source: 'x' }), player: { capture: (bb) => { calls.push(['capture', bb.baseY]); return 'tok'; }, settle: (bb, t) => calls.push(['settle', bb.baseY, t]) } });
  s.sync();
  ok(calls.length === 2 && calls[0][1] === 2.05 && calls[1][1] === 5.05 && calls[1][2] === 'tok', 'capture sees the old floor, settle the new one with the capture token');
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
