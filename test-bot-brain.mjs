// bot-brain.js scenario: two teams on a flat bounded arena, no renderer, no physics beyond
// integrating the velocity the brain writes. Checks the harness brain runs headless, that bots
// acquire and fire at the other team only, and that a hurt bot breaks off.
import assert from 'node:assert/strict';
import { createBotBrain } from './bot-brain.js';
import { buildNavGrid } from './nav-grid.js';
import { buildSightGrid, buildLazyVisibilityField } from './nav-visibility.js';
import { buildCornerMap } from './nav-corners.js';
import { BOT_PATROL, BOT_AIM, BOT_FIRE, BOT_FLEE, BOT_HEAL } from './bot-activity.js';

const bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
const heightAt = () => 0;
const navGrid = buildNavGrid((x, z) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ, bounds, 1.5, { heightAt });
const visField = buildLazyVisibilityField(navGrid, buildSightGrid(navGrid, []), { terrain: { heights: navGrid.heights } });
const cornerMap = buildCornerMap(navGrid, [], visField, { heights: navGrid.heights });

const shots = [];
const brain = createBotBrain({
  world: { heightAt, raycast: () => null },
  hooks: {
    // The host's shot: here it only records who fired at whom and spends the round.
    fireBotShot(origin, now) {
      const { bot, target } = brain.bound();
      const ammo = brain.ammoFor(bot);
      if (ammo.mag <= 0) return false;
      ammo.mag -= 1;
      shots.push({ shooter: bot, target, now });
      return true;
    },
  },
  settings: {
    navGrid, visField, cornerMap, patrolPoints: [],
    mapCollider: { raycast: () => null },
    terrainField: { heightAt, slopeAt: () => 0 },
    terrainSettings: { enabled: false },
    dummyTargets: [],
  },
});

const alpha = [brain.spawn({ team: 'alpha', at: { x: -20, y: 0, z: -2 } }), brain.spawn({ team: 'alpha', at: { x: -20, y: 0, z: 2 } })];
const bravo = [brain.spawn({ team: 'bravo', at: { x: 20, y: 0, z: -2 } }), brain.spawn({ team: 'bravo', at: { x: 20, y: 0, z: 2 } })];
for (const a of alpha) a.entity.yaw = Math.PI / 2;      // bot forward is +Z-ish in v3 terms; face across
for (const b of bravo) b.entity.yaw = -Math.PI / 2;

const dt = 1 / 60;
let now = 1000;
const statesSeen = new Set();
for (let tick = 0; tick < 1800; tick++) {
  now += dt * 1000;
  brain.stepAll(dt, now);
  for (const actor of brain.actors()) {
    statesSeen.add(actor.state);
    const e = actor.entity;
    // host physics stand-in: integrate XZ velocity, hold the ground
    e.capsule.start.x += e.velocity.x * dt; e.capsule.start.z += e.velocity.z * dt;
    e.capsule.end.x += e.velocity.x * dt; e.capsule.end.z += e.velocity.z * dt;
    e.capsule.start.y = heightAt() + e.capsule.radius; e.capsule.end.y = heightAt() + 1.8 - e.capsule.radius;
    e.onFloor = true;
  }
}
console.log('states seen:', [...statesSeen].join(' '));
console.log('shots:', shots.length);
assert.ok(statesSeen.has(BOT_AIM) || statesSeen.has(BOT_FIRE), 'someone should aim or fire within 30 s of facing each other at 40 m');
assert.ok(shots.length > 0, 'shots should have been fired');
for (const s of shots) assert.notEqual(s.shooter.team, s.target?.team, 'a bot never fires at its own team');

// A hurt bot breaks off: the host applies the damage, the brain hears about it.
const victim = alpha[0].entity, shooter = bravo[0].entity;
victim.health = 12;
brain.damaged(victim, shooter, 88, now);
const victimStates = new Set();
for (let tick = 0; tick < 600; tick++) {
  now += dt * 1000;
  brain.stepAll(dt, now);
  victimStates.add(alpha[0].state);
  for (const actor of brain.actors()) {
    const e = actor.entity;
    e.capsule.start.x += e.velocity.x * dt; e.capsule.start.z += e.velocity.z * dt;
    e.capsule.end.x += e.velocity.x * dt; e.capsule.end.z += e.velocity.z * dt;
  }
}
console.log('victim states after the hit:', [...victimStates].join(' '));
assert.ok(victimStates.has(BOT_FLEE) || victimStates.has(BOT_HEAL), 'a bot at 12 hp should flee or heal');

// A kill: observers drop the dead target and stop shooting at it.
const dead = bravo[1].entity;
dead.health = 0;
brain.damaged(dead, alpha[1].entity, 100, now);
assert.equal(dead.alive, false);
const shotsBefore = shots.length;
for (let tick = 0; tick < 300; tick++) { now += dt * 1000; brain.stepAll(dt, now); }
for (const s of shots.slice(shotsBefore)) assert.notEqual(s.target?.id, dead.id, 'nobody shoots a corpse');
console.log('bot-brain scenario ok');
