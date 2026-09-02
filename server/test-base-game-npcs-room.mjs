// NPC bots through the room server: the owner spawns two sides, they appear on the wire as
// socketless players with a team, they move, they shoot each other, the dead respawn (or not),
// and a player is a target for the enemy side only. Run: node server/test-base-game-npcs-room.mjs
import assert from 'node:assert/strict';
import { createBaseGameRoomService, formatBaseGameNpcProfStats } from './base-game-rooms.js';
import { BASE_GAME_PROTOCOL_VERSION, BASE_GAME_SIM_HZ, BASE_GAME_TEAMS } from '../base-game-protocol.mjs';
import { analyticDescriptor } from '../terrain-source-analytic.js';

let clock = 1_000;
let tokenSeq = 0;
const service = createBaseGameRoomService({ now: () => clock, makeToken: () => `token-${++tokenSeq}`, graceMs: 1_000 });

function socket() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; } };
}
function message(ws, type) { return [...ws.sent].reverse().find(packet => packet.type === type); }

const owner = socket();
service.handle(owner, { type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'NPCS', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor: analyticDescriptor({ key: 'base-game-analytic', sourceVersion: '1' }) } });
const guest = socket();
service.handle(guest, { type: 'base:join', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'NPCS' });
await service.ensureWorld();
const ownerId = message(owner, 'base:joined').clientId;
const profLine = formatBaseGameNpcProfStats({ syncMs: 1, thinkMs: 2, inputMs: 3, raycasts: 4, heights: 5, bakes: 6 });
assert.match(profLine, /heightAt 5\b/, 'the profiler prints the real height counter');
assert.doesNotMatch(profLine, /undefined/, 'the profiler has no undefined counter');

let tick = 0;
const base = { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, sprint: false, crouch: false, stance: 0, jump: false, slot: 0, aim: false, reload: false, fire: false, throw: false };
function drive(seconds, over = {}) {
  const slices = Math.round(seconds * 10);
  for (let s = 0; s < slices; s++) {
    const ticks = [];
    for (let i = 0; i < BASE_GAME_SIM_HZ / 10; i++) { tick++; ticks.push({ ...base, ...over, tick }); }
    service.handle(owner, { type: 'base:input', protocol: BASE_GAME_PROTOCOL_VERSION, ticks, clientTime: clock });
    clock += 100;
    service.step(clock);
  }
  service.broadcastSnapshots();
  return message(guest, 'base:snapshot');
}
const npcs = (snap, team = null) => snap.players.filter(p => p.npc && (team === null || p.team === team));

// A guest cannot spawn bots; the owner can.
service.handle(guest, { type: 'base:npc', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', team: BASE_GAME_TEAMS.enemy, count: 2 });
assert.equal(message(guest, 'base:error')?.code, 'not_owner');
service.handle(owner, { type: 'base:npc', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', team: BASE_GAME_TEAMS.enemy, count: 2 });
service.handle(owner, { type: 'base:npc', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', team: BASE_GAME_TEAMS.friendly, count: 2, role: 'medic' });
const room = service.rooms.get('NPCS');
let aim = room.npcs.brain.aimSettings();
assert.equal(aim.reactionEnabled, true, 'a partial room setting preserves the reaction gate');
assert.equal(aim.reactionMs, 260, 'the default room notice time reaches the brain');
service.handle(owner, { type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { npcNoticeMs: 777, npcAccuracy: 1 } });
aim = room.npcs.brain.aimSettings();
assert.equal(aim.reactionMs, 777, 'notice-time changes reach the brain');
assert.equal(aim.reactionEnabled, true, 'notice-time changes retain the rest of the aim settings');
assert.equal(aim.baseSpreadDeg, 0, 'accuracy 1 removes base spread');
assert.equal(aim.bloomMaxDeg, 0, 'accuracy 1 removes bloom');
service.handle(owner, { type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { npcNoticeMs: 260, npcAccuracy: 0.5 } });
aim = room.npcs.brain.aimSettings();
assert.ok(aim.baseSpreadDeg > 0 && aim.bloomMaxDeg > 0, 'accuracy 0.5 restores donor dispersion');
let snap = drive(0.5);
assert.equal(npcs(snap).length, 4, 'four bots on the wire');
assert.equal(npcs(snap, BASE_GAME_TEAMS.enemy).length, 2);
assert.equal(npcs(snap, BASE_GAME_TEAMS.friendly).length, 2);
for (const p of npcs(snap)) {
  assert.equal(p.connected, true, 'a bot reads as connected so every client renders it');
  assert.ok(p.appearance && p.appearance.skin, 'a bot has a face');
  assert.ok(Number.isFinite(p.position[1]));
}
assert.equal(npcs(snap, BASE_GAME_TEAMS.friendly)[0].weapon, 'five_seven', 'a medic carries the sidearm');
const me = snap.players.find(p => p.id === ownerId);
assert.equal(me.team, BASE_GAME_TEAMS.friendly, 'players are team 1');
assert.equal(me.npc, false);

// They act: over a minute some bot moves and some shot is fired between the sides.
const start = new Map(npcs(snap).map(p => [p.id, [...p.position]]));
let shots = 0, hits = 0, crossTeamShots = 0;
for (let s = 0; s < 60; s++) {
  snap = drive(1);
  shots += snap.shots.length;
  hits += snap.hits.length;
  for (const shot of snap.shots) { const who = snap.players.find(p => p.id === shot.shooter); if (who?.npc) crossTeamShots++; }
}
const moved = npcs(snap).filter(p => { const s0 = start.get(p.id); return s0 && Math.hypot(p.position[0] - s0[0], p.position[2] - s0[2]) > 2; });
console.log(`after 60 s: ${npcs(snap).length} bots, ${moved.length} moved > 2 m, ${shots} shots, ${hits} hits, ${crossTeamShots} by bots`);
assert.ok(moved.length > 0, 'bots walk');
assert.ok(crossTeamShots > 0, 'bots shoot');
for (const h of [...snap.hits]) {
  const shooter = snap.players.find(p => p.id === h.shooter), victim = snap.players.find(p => p.id === h.victim);
  if (shooter?.npc && victim) assert.notEqual(shooter.team, victim.team, 'a bot hit is always across teams (aim is team-partitioned)');
}

// Respawn off: a dead bot leaves the roster after the respawn delay.
service.handle(owner, { type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { npcRespawn: false } });
const before = npcs(snap).length;
for (let s = 0; s < 120 && npcs(snap).length === before; s++) snap = drive(1);
console.log(`respawn off: ${before} -> ${npcs(snap).length} bots`);

// The spawner: an aimed request lands a bot on the ground along the owner's look, near them.
service.handle(owner, { type: 'base:npc', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', team: BASE_GAME_TEAMS.enemy, count: 1, role: 'sniper', aimed: true });
assert.equal(message(owner, 'base:error')?.code, 'no_ground', 'looking level at the horizon, there is nothing to stand on');
drive(0.1, { yaw: 0.7, pitch: -0.35 });   // look down at the ground a few metres out
service.handle(owner, { type: 'base:npc', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', team: BASE_GAME_TEAMS.enemy, count: 1, role: 'sniper', aimed: true });
snap = drive(0.2, { yaw: 0.7, pitch: -0.35 });
const placed = npcs(snap, BASE_GAME_TEAMS.enemy).filter(p => p.weapon === 'm24');
assert.equal(placed.length, 1, 'the aimed spawn placed one sniper');
const owner$ = snap.players.find(p => p.id === ownerId);
const dist = Math.hypot(placed[0].position[0] - owner$.position[0], placed[0].position[2] - owner$.position[2]);
console.log(`aimed spawn landed ${dist.toFixed(1)} m from the owner`);
assert.ok(dist > 1 && dist < 60, 'an aimed spawn lands a few metres out along the look, on the ground');

// Clear removes everyone.
service.handle(owner, { type: 'base:npc', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'clear' });
snap = drive(0.2);
assert.equal(npcs(snap).length, 0, 'clear empties the roster');
console.log('base-game npcs room ok');
