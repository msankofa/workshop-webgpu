// Base game firing on the multiplayer-guns stack: the lockstep trigger step over combat.js
// validateShot + player-ammo.js, then a two-player room where one player shoots the other dead
// and the server respawns them. combat.js hit math has its own test (test-combat.mjs).
import {
  BASE_GAME_PROTOCOL_VERSION, BASE_GAME_RELOAD_TICKS, BASE_GAME_RESPAWN_TICKS,
  sanitizeBaseGamePlayerState, sanitizeBaseGameHitEvent, sanitizeBaseGameDeathEvent, wireAmmo,
  sanitizeBaseGameShotEvent, sanitizeBaseGameExplosionEvent, sanitizeBaseGameProjectileState,
} from './base-game-protocol.mjs';
import { createTriggerState, stepTrigger, lookDirection, shotDirectionFor } from './base-game-fire.js';
import { botSeedFromId } from './bot-activity.js';
import { createAmmoStore, defaultAmmoFor } from './player-ammo.js';
import { createProjectileManager } from './bot-projectiles.js';
import { isSurfaceDetonation } from './entity-types/combat-projectile.js';
import { createWorldQueryService } from './world-query.js';
import { createTraversalLabWorldQuery } from './traversal-lab-collider.js';
import { createBaseGameRoomService } from './server/base-game-rooms.js';
import { getWeapon } from './weapons.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };
const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;
const P = BASE_GAME_PROTOCOL_VERSION;
const ticksFor = weaponId => Math.ceil(getWeapon(weaponId).fireIntervalMs * 120 / 1000);

// ---- trigger step ----
{
  const ammo = createAmmoStore();
  const tr = createTriggerState();
  const step = (tick, fire, reload = false, weaponId = 'm1911') => stepTrigger(tr, ammo, { playerId: 'a', weaponId, tick, fire, reload });
  const mag = () => ammo.ensureAmmo('a', 'm1911');
  ok(defaultAmmoFor('m1911').mag === 7 && mag().reserve === 35, 'player-ammo.js seeds a magazine from weapons.js');
  ok(step(1, true).fired && mag().mag === 6, 'semi-auto fires on the press edge and spends one round');
  ok(!step(2, true).fired, 'holding the trigger does not repeat a semi-auto');
  step(3, false);
  ok(step(4, true).reason === 'cooldown' && mag().mag === 6, 'validateShot gates a second press inside the fire interval');
  const gap = ticksFor('m1911');
  step(gap, false);
  ok(step(1 + gap, true).fired && mag().mag === 5, 'a press after the interval fires');
  for (let i = 0; i < 5; i++) { step(100 + i * gap * 2, false); step(101 + i * gap * 2, true); }
  ok(mag().mag === 0, 'the magazine empties');
  step(500, false);
  let r = step(501, true);
  ok(r.dry && r.reloadStarted && tr.reloadUntilTick === 501 + BASE_GAME_RELOAD_TICKS, 'a dry press starts an automatic reload');
  r = step(502 + BASE_GAME_RELOAD_TICKS, false);
  ok(r.reloadDone && mag().mag === 7 && mag().reserve === 28, 'reloadAmmo commits from reserve when the reload window passes');
  step(700, false); step(701, true);
  ok(step(702, false, true).reloadStarted, 'a manual reload with a partial magazine starts');
  step(703, false);
  ok(!step(704, true).fired, 'no firing during a reload');

  const auto = createTriggerState();
  let shots = 0;
  for (let tick = 1; tick <= 120; tick++) if (stepTrigger(auto, ammo, { playerId: 'b', weaponId: 'cz_805_bren', tick, fire: true }).fired) shots++;
  ok(shots === Math.floor(119 / ticksFor('cz_805_bren')) + 1 && ammo.ensureAmmo('b', 'cz_805_bren').mag === 30 - shots, 'an automatic repeats at its interval while held');

  const knife = createTriggerState();
  ok(stepTrigger(knife, ammo, { playerId: 'c', weaponId: 'knife', tick: 1, fire: true }).fired, 'melee has no magazine and still fires');
  ok(wireAmmo(ammo.ensureAmmo('c', 'knife')).mag === 0, 'a melee slot reports an empty magazine on the wire');
  ok(!stepTrigger(createTriggerState(), ammo, { playerId: 'd', weaponId: null, tick: 1, fire: true }).fired, 'an empty slot never fires');
  const dead = createTriggerState();
  ok(!stepTrigger(dead, ammo, { playerId: 'e', weaponId: 'm1911', tick: 1, fire: true, alive: false }).fired && ammo.ensureAmmo('e', 'm1911').mag === 7, 'a dead shooter cannot fire');
  const d = lookDirection(0, 0);
  ok(near(d[0], 0) && near(d[1], 0) && near(d[2], -1), 'yaw 0 pitch 0 looks down -Z');

  // Spread: bot-aim.js's cone on weapons.js spreadRad, rolls seeded on (seed, tick).
  const t1 = createTriggerState(), t2 = createTriggerState();
  const s1 = shotDirectionFor(t1, { yaw: 0.3, pitch: 0.1, weaponId: 'cz_805_bren', tick: 50, seed: 7 });
  const s2 = shotDirectionFor(t2, { yaw: 0.3, pitch: 0.1, weaponId: 'cz_805_bren', tick: 50, seed: 7 });
  ok(s1.every((v, i) => v === s2[i]) && near(Math.hypot(...s1), 1), 'the same seed and tick give the same dispersed ray on both sides');
  const s3 = shotDirectionFor(t1, { yaw: 0.3, pitch: 0.1, weaponId: 'cz_805_bren', tick: 51, seed: 7 });
  ok(!s1.every((v, i) => v === s3[i]), 'a different tick rolls a different offset');
  const look = lookDirection(0.3, 0.1);
  const off = v => Math.acos(Math.min(1, v[0] * look[0] + v[1] * look[1] + v[2] * look[2]));
  const still = createTriggerState(), running = createTriggerState();
  let widened = 0;
  for (let tick = 1; tick <= 40; tick++) widened = Math.max(widened, off(shotDirectionFor(running, { yaw: 0.3, pitch: 0.1, weaponId: 'cz_805_bren', tick, seed: 2, moveSpeed01: 1 })) - off(shotDirectionFor(still, { yaw: 0.3, pitch: 0.1, weaponId: 'cz_805_bren', tick, seed: 2 })));
  ok(widened > 0, 'running widens the cone');
  let maxOff = 0;
  for (let tick = 1; tick <= 60; tick++) maxOff = Math.max(maxOff, off(shotDirectionFor(createTriggerState(), { yaw: 0.3, pitch: 0.1, weaponId: 'm24', tick, seed: 3 })));
  ok(maxOff <= (getWeapon('m24').spreadRad + 2.0 * Math.PI / 180) + 1e-6, 'a settled sniper shot stays inside its authored cone plus the first-shot term');
}

// ---- protocol ----
{
  const st = sanitizeBaseGamePlayerState({ position: [0, 0, 0], health: 40, dead: true, ammo: { mag: 3, reserve: 9 } });
  ok(st.health === 40 && st.dead === true && st.ammo.mag === 3 && st.ammo.reserve === 9, 'player state carries health, dead and ammo');
  ok(sanitizeBaseGamePlayerState({ position: [0, 0, 0], ammo: { mag: -1, reserve: 0 } }).ammo === null, 'negative ammo is dropped');
  ok(sanitizeBaseGameHitEvent({ shooter: 'a', victim: 'b', point: [1, 2, 3], damage: 24, head: true, tick: 5 })?.head === true, 'hit event sanitizer accepts a valid event');
  ok(sanitizeBaseGameHitEvent({ shooter: 'a', victim: 'b', point: [1, NaN, 3], damage: 24 }) === null, 'hit event with a bad point is rejected');
  ok(sanitizeBaseGameDeathEvent({ victim: 'b', killer: null, tick: 9 })?.killer === null && sanitizeBaseGameDeathEvent({}) === null, 'death event sanitizer');
  ok(sanitizeBaseGameShotEvent({ shooter: 'a', weapon: 'm24', origin: [0, 1, 0], dir: [0, 0, -1], end: [0, 1, -9], kind: 'world', tick: 2 })?.kind === 'world', 'shot event sanitizer accepts a valid shot');
  ok(sanitizeBaseGameShotEvent({ shooter: 'a', origin: [0, 1, 0], end: [0, NaN, 0] }) === null, 'shot event with a bad end is rejected');
  ok(sanitizeBaseGameExplosionEvent({ p: [1, 2, 3], radius: 8.2, owner: 'a', weapon: 'rpg' })?.radius === 8.2 && sanitizeBaseGameExplosionEvent({ p: [1, 2, 3], radius: 0 }) === null, 'explosion event sanitizer');
  const pr = sanitizeBaseGameProjectileState({ id: 'bp1', p: [0, 2, 0], v: [0, 0, -100], weapon: 'rpg', owner: 'a', radius: 0.42 });
  ok(pr && pr.v[2] === -100 && pr.radius === 0.42 && sanitizeBaseGameProjectileState({ id: 3, p: [0, 0, 0] }) === null, 'projectile state sanitizer');
}

// ---- detonation cause: what decides whether a blast tears anything out of a surface ----
{
  ok(isSurfaceDetonation('impact') && isSurfaceDetonation('ground') && isSurfaceDetonation('rest'), 'hitting a body, the terrain, or cooking out on the ground all touch a surface');
  ok(!isSurfaceDetonation('fuse') && !isSurfaceDetonation('airburst') && !isSurfaceDetonation(undefined), 'a fuse or airburst detonation touches nothing');
  ok(getWeapon('grenade').projectile.rubble === false, 'a frag grenade is authored to throw no rubble');
  ok(getWeapon('rpg').projectile.rubble !== false, 'a rocket is not');

  // The manager hands the explosion init (with its cause) to onDetonate as a third argument.
  const causes = [];
  const flat = createProjectileManager({ terrainHeight: () => 0, onDetonate: (point, proj, init) => causes.push(init?.cause) });
  flat.spawn({ origin: [0, 20, 0], dir: [0, -1, 0], speed: 40, life: 8, blastRadius: 5, damage: 50, weaponId: 'rpg' });
  for (let i = 0; i < 200 && flat.list.length; i++) flat.update(1 / 60);
  ok(causes[0] === 'ground' && isSurfaceDetonation(causes[0]), 'a rocket flown into the ground detonates on contact');
  const air = createProjectileManager({ terrainHeight: () => -1000, onDetonate: (point, proj, init) => causes.push(init?.cause) });
  air.spawn({ origin: [0, 20, 0], dir: [0, 0, -1], speed: 10, life: 8, fuse: 0.5, blastRadius: 5, damage: 50, weaponId: 'grenade' });
  for (let i = 0; i < 200 && air.list.length; i++) air.update(1 / 60);
  ok(causes[1] === 'fuse' && !isSurfaceDetonation(causes[1]), 'a grenade fusing in mid-air touches nothing');
}

// ---- room: one player shoots another ----
{
  const serverQuery = createWorldQueryService();
  const lab = createTraversalLabWorldQuery(serverQuery);
  let clock = 1000, tokenSeq = 0;
  const service = createBaseGameRoomService({
    now: () => clock, makeToken: () => `token-${++tokenSeq}`, graceMs: 1000, playerCap: 2,
    world: { worldQuery: serverQuery, spawn: lab.layout.spawn, killPlaneY: lab.layout.killPlaneY, worldVersion: 'test' },
  });
  const socket = () => ({ readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; } });
  const lastOf = (ws, type) => [...ws.sent].reverse().find(packet => packet.type === type);
  const shooterWs = socket(), victimWs = socket();
  service.handle(shooterWs, { type: 'base:create', protocol: P, room: 'GUN' });
  service.handle(victimWs, { type: 'base:join', protocol: P, room: 'GUN' });
  const room = service.rooms.get('GUN');
  const shooterId = lastOf(shooterWs, 'base:joined').clientId, victimId = lastOf(victimWs, 'base:joined').clientId;
  const shooter = room.clients.get(shooterId), victim = room.clients.get(victimId);
  const hp = c => room.combat.getSnapshot(c.id).hp, alive = c => room.combat.getSnapshot(c.id).alive;
  const mag = c => room.ammo.ensureAmmo(c.id, 'cz_805_bren').mag;
  const runSteps = n => { for (let i = 0; i < n; i++) { clock += 1000 / 120; service.step(clock); } };
  const ticks = { [shooterId]: 1, [victimId]: 1 };
  const send = (ws, client, count, extra = {}) => {
    const list = [];
    for (let i = 0; i < count; i++) list.push({ tick: ticks[client.id]++, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, ...extra });
    for (let i = 0; i < list.length; i += 60) service.handle(ws, { type: 'base:input', protocol: P, clientTime: clock, ticks: list.slice(i, i + 60) });
  };
  const both = (count, shooterExtra = {}, victimExtra = {}) => { send(shooterWs, shooter, count, shooterExtra); send(victimWs, victim, count, victimExtra); runSteps(count); };
  // Both settle, then the victim walks down -Z (yaw 0 faces -Z) and stands there.
  both(30); both(120, {}, { moveZ: 1 }); both(60);
  const sp = shooter.controller.getPosition(), vp = victim.controller.getPosition();
  ok(vp[2] < sp[2] - 2, 'the victim stands ahead of the shooter');
  const sc = shooter.controller.getCapsule();
  const dx = vp[0] - sp[0], dy = (vp[1] + 1.0) - (sc.end[1] + sc.radius), dz = vp[2] - sp[2];
  const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
  ok(hp(victim) === 100 && mag(shooter) === 30, 'everyone starts at full health with a full magazine');
  const spreadTick = ticks[shooterId];
  both(1, { yaw, pitch, aim: true, fire: true });
  ok(mag(shooter) === 29 && shooter.action === 2 && shooter.actionTick === shooter.lastConsumedTick, 'a fire tick spends a round and stamps the fire action');
  {
    const shot = room.events.shots[0];
    const expected = shotDirectionFor({ ...createTriggerState(), bloomDeg: shooter.trigger.bloomDeg, contactSinceTick: shooter.trigger.contactSinceTick }, { yaw, pitch, weaponId: 'cz_805_bren', tick: spreadTick, seed: botSeedFromId(shooterId) });
    ok(shot && shot.shooter === shooterId && shot.weapon === 'cz_805_bren' && shot.dir.every((v, i) => near(v, expected[i], 1e-12)), 'the shot event carries the seeded dispersed ray a client can reproduce');
    ok(shot.kind === 'player' && shot.end.every(Number.isFinite), 'the shot event ends on the victim');
  }
  ok(hp(victim) === 100 - getWeapon('cz_805_bren').damage, 'the victim takes the weapon damage through player-combat.js');
  service.broadcastSnapshots();
  let snap = lastOf(victimWs, 'base:snapshot');
  ok(snap.hits?.length === 1 && snap.hits[0].shooter === shooterId && snap.hits[0].victim === victimId && snap.hits[0].damage === 24, 'the snapshot carries the hit event');
  ok(snap.players.find(p => p.id === shooterId).ammo.mag === 29 && snap.players.find(p => p.id === victimId).health === 76, 'ammo and health ride the snapshot');
  service.broadcastSnapshots();
  ok(lastOf(victimWs, 'base:snapshot').hits.length === 0, 'events drain after one broadcast');
  // A shot into the floor hits nobody.
  both(20, { yaw, pitch: -1.2, aim: true });
  both(1, { yaw, pitch: -1.2, aim: true, fire: true });
  ok(hp(victim) === 76 && mag(shooter) === 28, 'a shot into the floor spends a round and hurts nobody');
  // Hold the trigger until the victim dies.
  for (let i = 0; i < 12 && alive(victim); i++) both(12, { yaw, pitch, aim: true, fire: true });   // packets of 12: the 30 Hz input limiter
  ok(!alive(victim) && hp(victim) === 0, 'sustained fire kills the victim');
  ok(shooter.kills === 1 && victim.deaths === 1, 'kill and death are credited');
  service.broadcastSnapshots();
  snap = lastOf(shooterWs, 'base:snapshot');
  ok(snap.deaths?.some(d => d.victim === victimId && d.killer === shooterId) && snap.players.find(p => p.id === victimId).dead === true, 'the death event and dead flag reach the clients');
  const deadPos = victim.controller.getPosition();
  both(30, {}, { moveZ: 1 });
  ok(near(victim.controller.getPosition()[2], deadPos[2], 1e-6), 'a dead player cannot move');
  both(1, { yaw, pitch, aim: true, fire: true });
  ok(hp(victim) === 0 && !room.events.hits.length, 'a corpse takes no further hits');
  const revBefore = victim.spawnRevision;
  both(BASE_GAME_RESPAWN_TICKS);
  ok(alive(victim) && hp(victim) === 100 && victim.spawnRevision === revBefore + 1 && mag(victim) === 30, 'the server respawns the victim with full health and ammo after the timer');
  ok(near(victim.controller.getPosition()[2], lab.layout.spawn[2], 1e-6), 'the respawn lands on the spawn point');
  ok(room.poseHistory.get(victimId)?.length > 0, 'combat.js pose history is kept for lag compensation');

  // Projectiles: an RPG flies as a bot-projectiles.js record, shows in the snapshot, and its blast
  // damages through entity-types/explosion.js falloff.
  ok(room.projectiles && room.projectiles.list.length === 0, 'the room owns a projectile manager with nothing in the air');
  service.handle(shooterWs, { type: 'base:loadout', protocol: P, loadout: { primary: 'rpg' } });
  room.events = { hits: [], deaths: [], shots: [], explosions: [] };
  both(20); both(120, {}, { moveZ: 1 }); both(60);   // the respawned victim walks clear of the shooter again
  const vp2 = victim.controller.getPosition(), sp2 = shooter.controller.getPosition();
  const sc2 = shooter.controller.getCapsule();
  const dx2 = vp2[0] - sp2[0], dy2 = (vp2[1] + 0.9) - (sc2.end[1] + sc2.radius), dz2 = vp2[2] - sp2[2];
  const yaw2 = Math.atan2(-dx2, -dz2), pitch2 = Math.atan2(dy2, Math.hypot(dx2, dz2));
  const hpBefore = hp(victim);
  both(1, { yaw: yaw2, pitch: pitch2, aim: true, fire: true });
  ok(room.projectiles.list.length === 1 && room.projectiles.list[0].weaponId === 'rpg' && room.ammo.ensureAmmo(shooterId, 'rpg').mag === 0, 'firing the rpg spends its round and puts a projectile in the air');
  service.broadcastSnapshots();
  snap = lastOf(victimWs, 'base:snapshot');
  ok(snap.projectiles?.length === 1 && snap.projectiles[0].weapon === 'rpg' && Math.hypot(...snap.projectiles[0].v) > 100, 'the snapshot carries the live projectile with its velocity');
  for (let i = 0; i < 10 && room.projectiles.list.length; i++) both(12, { yaw: yaw2, pitch: pitch2 });
  ok(room.projectiles.list.length === 0, 'the rocket detonates within a second');
  ok(hp(victim) < hpBefore, 'the blast damages the victim through blastDamageAt');
  service.broadcastSnapshots();
  snap = lastOf(victimWs, 'base:snapshot');
  ok(snap.explosions?.length === 1 && snap.explosions[0].weapon === 'rpg' && snap.explosions[0].radius === getWeapon('rpg').projectile.blastRadius, 'the explosion event reaches the clients');
  ok(snap.explosions[0].contact === true, 'a rocket that struck something reports surface contact, so the blast can tear rubble out of it');
  ok(snap.hits.some(h => h.victim === victimId && h.shooter === shooterId), 'blast damage is reported as a hit event');
}

// ---- page wiring markers ----
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  for (const marker of ['base-game-fire.js', 'stepTrigger(', 'audioDirector.localFire(', 'snapshot.hits', 'snapshot.deaths', 'combatStatus', 'createEffectRenderer(', 'tracerLifetime(', "pushEffect('muzzle_flash'", "pushEffect('explosion'", 'snapshot.projectiles', 'shotDirectionFor(', 'createFlashLights(', "pushEffect('smoke_puff'", 'soloProjectiles.spawn(', 'presentExplosion(', 'weaponThrowsRubble', 'isSurfaceDetonation(', 'createDebrisSim(', 'createDebrisRenderer(', 'spawnBlastDebris(', 'debrisSim.step(']) {
    ok(html.includes(marker), `base-game.html wires ${marker}`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
