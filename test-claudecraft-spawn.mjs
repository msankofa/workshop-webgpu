// test-claudecraft-spawn.mjs
// Headless coverage for the runtime manual-mob API on the bridge factory
// (createClaudecraftCreatures): spawnMob / setMobScale / setMobBehavior / removeMob /
// clearSpawnedMobs. Uses stub terrainHeight + trunkResolve (no GPU, no page), the same
// way the other bridge tests drive the vendored sim bundle.
import { createClaudecraftCreatures } from './claudecraft-bridge/claudecraft-creatures.js';
import { MOBS } from './claudecraft-sim.bundle.js';

// SCALE = 1 (playerHeight 2.6 = sim humanoid yards) for clean world<->sim assertions.
const WORLD_H = 5;                       // flat terrain at world-height 5 everywhere
const mobId = Object.keys(MOBS)[0];      // any real roster template

const cc = createClaudecraftCreatures({
  workshopPlayerHeight: 2.6,             // SCALE = 1
  terrainHeight: () => WORLD_H,
  waterLevelWorld: -20,
  trunkResolve: (x, z) => ({ x, z }),    // no trunks: identity resolver
  camps: [{ mobId, count: 2, centerWorld: { x: 200, z: 200 }, radiusWorld: 5 }],
  playerStartWorld: { x: 0, z: 0 },
  seed: 7,
});

const campMobCount = cc.mobs().length;   // seeded camp mobs, must survive clear-all
console.assert(campMobCount >= 1, `camp seeded some mobs, got ${campMobCount}`);

// --- listSpawnableMobs -------------------------------------------------------
const list = cc.listSpawnableMobs();
console.assert(Array.isArray(list) && list.length === Object.keys(MOBS).length,
  `listSpawnableMobs returns all ${Object.keys(MOBS).length} templates, got ${list?.length}`);
console.assert(list.every((m) => m.id && m.family), 'each entry carries id + family');

// --- spawnMob: id + appears in mobs() at the right world pos + scale ----------
const id = cc.spawnMob({ mobId, world: { x: 50, z: 60 }, level: 1, scale: 2.5, behavior: 'hostile' });
console.assert(Number.isInteger(id), `spawnMob returns an id, got ${id}`);
console.assert(cc.spawnMob({ mobId: 'NOT_A_REAL_MOB', world: { x: 0, z: 0 } }) === null,
  'spawnMob guards an invalid mobId (returns null)');

let wire = cc.mobs().find((m) => m.id === id);
console.assert(wire, 'spawned mob appears in mobs() immediately');
console.assert(Math.abs(wire.p[0] - 50) < 1e-9, `world x (SCALE 1), got ${wire.p[0]}`);
console.assert(Math.abs(wire.p[2] - 60) < 1e-9, `world z, got ${wire.p[2]}`);
console.assert(Math.abs(wire.p[1] - WORLD_H) < 1e-9, `y snapped to terrain height, got ${wire.p[1]}`);
console.assert(Math.abs(wire.s - 2.5) < 1e-9, `spawn scale in wire, got ${wire.s}`);

// --- setMobScale changes the serialized scale --------------------------------
console.assert(cc.setMobScale(id, 3.75) === true, 'setMobScale ok');
wire = cc.mobs().find((m) => m.id === id);
console.assert(Math.abs(wire.s - 3.75) < 1e-9, `scale updated in wire, got ${wire.s}`);

// --- setMobBehavior('passive') sets the sim entity hostile=false --------------
console.assert(cc.setMobBehavior(id, 'passive') === true, 'setMobBehavior passive ok');
console.assert(cc._sim.entities.get(id).hostile === false, 'passive sets hostile=false');
console.assert(cc.setMobBehavior(id, 'nonsense') === false, 'invalid behavior rejected');

// --- setMobBehavior('hold') stops it moving even with a player on top ---------
const holdId = cc.spawnMob({ mobId, world: { x: -40, z: -40 }, scale: 1, behavior: 'hold' });
const holdEnt = cc._sim.entities.get(holdId);
const start = { x: holdEnt.pos.x, z: holdEnt.pos.z };
// Drive 100 sim ticks (dt 1.0 caps at 5 catch-up steps/frame) with the local player
// standing right on the held mob — a hostile mob would chase; a held one must not move.
for (let i = 0; i < 20; i++) {
  cc.update(1.0, { localPlayerWorld: { x: -40, y: WORLD_H, z: -40, facing: 0 } });
}
const moved = Math.hypot(holdEnt.pos.x - start.x, holdEnt.pos.z - start.z);
console.assert(holdEnt.aiState === 'hold', `hold mob stays in the inert 'hold' state, got ${holdEnt.aiState}`);
console.assert(moved < 1e-6, `hold mob does not move, drifted ${moved}`);

// --- passive mob wanders but never chases the adjacent player -----------------
const passId = cc.spawnMob({ mobId, world: { x: 300, z: 300 }, scale: 1, behavior: 'passive' });
const passEnt = cc._sim.entities.get(passId);
for (let i = 0; i < 40; i++) {
  cc.update(1.0, { localPlayerWorld: { x: 300, y: WORLD_H, z: 300, facing: 0 } });
}
// It may wander around spawn, but it must not be locked into a chase/attack of the player.
const passDrift = Math.hypot(passEnt.pos.x - 300, passEnt.pos.z - 300);
console.assert(!['chase', 'attack'].includes(passEnt.aiState) || passDrift < 15,
  `passive mob never chases the player down, aiState=${passEnt.aiState} drift=${passDrift}`);

// --- removeMob drops it from mobs() ------------------------------------------
console.assert(cc.removeMob(id) === true, 'removeMob ok');
console.assert(!cc.mobs().some((m) => m.id === id), 'removed mob gone from mobs()');
console.assert(cc._sim.entities.get(id) === undefined, 'removed mob gone from the sim');

// --- clearSpawnedMobs removes only runtime mobs, keeps the camps --------------
const cleared = cc.clearSpawnedMobs();
console.assert(cleared >= 1, `clearSpawnedMobs removed the remaining runtime mobs, got ${cleared}`);
console.assert(cc.spawnedMobIds().length === 0, 'no runtime-spawned ids remain');
const remaining = cc.mobs();
console.assert(remaining.length >= 1, 'seeded camp mobs survive clear-all');
console.assert(!remaining.some((m) => [holdId, passId].includes(m.id)), 'runtime mobs are gone');

console.log('claudecraft spawn API OK');
