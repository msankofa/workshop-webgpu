// Drones through the room server: launch from the gadget slot, follow, take over, release, send,
// and the snapshot every client reads. Run: node server/test-base-game-drones-room.mjs
import assert from 'node:assert/strict';
import { createBaseGameRoomService } from './base-game-rooms.js';
import { BASE_GAME_PROTOCOL_VERSION, BASE_GAME_WEAPON_SLOTS, BASE_GAME_SIM_HZ } from '../base-game-protocol.mjs';

let clock = 1_000;
let tokenSeq = 0;
const service = createBaseGameRoomService({ now: () => clock, makeToken: () => `token-${++tokenSeq}`, graceMs: 1_000 });

function socket() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; } };
}
function message(ws, type) { return [...ws.sent].reverse().find(packet => packet.type === type); }

const owner = socket();
service.handle(owner, { type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'DRONES' });
const guest = socket();
service.handle(guest, { type: 'base:join', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'DRONES' });
await service.ensureWorld();
const ownerId = message(owner, 'base:joined').clientId;
const GADGET = BASE_GAME_WEAPON_SLOTS.indexOf('gadget');

// Drive the room in 100 ms slices: 12 ticks of input per slice, then one service step.
let tick = 0;
const base = { moveX: 0, moveZ: 0, yaw: 0.4, pitch: 0.2, sprint: false, crouch: false, stance: 0, jump: false, slot: 0, aim: false, reload: false, fire: false, throw: false };
function drive(seconds, over = {}, perTick = null) {
  const slices = Math.round(seconds * 10);
  for (let s = 0; s < slices; s++) {
    const ticks = [];
    for (let i = 0; i < BASE_GAME_SIM_HZ / 10; i++) { tick++; ticks.push({ ...base, ...over, ...(perTick ? perTick(tick) : {}), tick }); }
    service.handle(owner, { type: 'base:input', protocol: BASE_GAME_PROTOCOL_VERSION, ticks, clientTime: clock });
    clock += 100;
    service.step(clock);
  }
  service.broadcastSnapshots();
  return message(guest, 'base:snapshot');
}

// Draw the gadget, wait out the swap, then press fire once: one quad in the sky, owned by the thrower.
let snap = drive(1.0, { slot: GADGET });
assert.equal(snap.drones.length, 0, 'holding the gadget launches nothing');
snap = drive(0.2, { slot: GADGET }, t => ({ fire: t % 12 === 1 }));
assert.equal(snap.drones.length, 0, 'the press starts the throw; the drone is still in the hands');
let thrower = snap.players.find(p => p.id === ownerId);
assert.equal(thrower.action, 5, 'the throw action is playing');
assert.equal(thrower.gadgetReady, false, 'the hands are committed');
assert.equal(thrower.gadgets.quad, 1, 'the throw spent one of two quads');
snap = drive(0.3, { slot: GADGET });
assert.equal(snap.drones.length, 1, 'the drone leaves the hands at the release tick');
const drone = snap.drones[0];
assert.equal(drone.kind, 'quad');
assert.equal(drone.owner, ownerId);
assert.equal(drone.state, 'launch');
const me = snap.players.find(p => p.id === ownerId);
assert.equal(me.weapon, 'quad', 'the held item on the wire is the gadget');
assert.equal(me.controlling, null);

snap = drive(3, { slot: GADGET }, () => ({ fire: true }));
assert.equal(snap.drones.length, 1, 'holding fire does not launch a second quad');
// Empty hands: a press does nothing; R brings the next one out over two seconds.
snap = drive(0.2, { slot: GADGET }, t => ({ fire: t % 12 === 1 }));
assert.equal(snap.players.find(p => p.id === ownerId).gadgetReady, false, 'nothing to throw until the next is brought out');
snap = drive(0.1, { slot: GADGET, reload: true });
thrower = snap.players.find(p => p.id === ownerId);
assert.equal(thrower.action, 1, 'the reload action is playing');
assert.equal(thrower.gadgetReady, false, 'not ready mid-reload');
snap = drive(2.2, { slot: GADGET });
assert.equal(snap.players.find(p => p.id === ownerId).gadgetReady, true, 'the next quad is in the hands after the reload');
snap = drive(0.5, { slot: GADGET }, t => ({ fire: t % 12 === 1 }));
assert.equal(snap.drones.length, 1, 'one quad aloft per player, even with one in the hands');
assert.equal(snap.drones[0].state, 'follow', `the quad is following (${snap.drones[0].state})`);
const p = snap.players.find(p => p.id === ownerId).position;
const d = snap.drones[0].p;
assert.ok(Math.hypot(d[0] - p[0], d[2] - p[2]) < 5, 'it shadows the owner');
assert.ok(d[1] > p[1] + 2, 'above the owner');

// Take over: the body stops moving even with the keys down, the drone goes manual.
const stick = { id: drone.id, mode: 1, pitch: 0, roll: 0, yaw: 0, throttle: 0 };
snap = drive(1, { slot: GADGET, moveZ: 1, drone: stick });
assert.equal(snap.drones[0].mode, 'manual');
const controlling = snap.players.find(p => p.id === ownerId);
assert.equal(controlling.controlling, drone.id, 'the roster says who is flying it');
const before = [...controlling.position];
snap = drive(1, { slot: GADGET, moveZ: 1, drone: stick });
const after = snap.players.find(p => p.id === ownerId).position;
assert.ok(Math.hypot(after[0] - before[0], after[2] - before[2]) < 0.05, 'an operator at the stick does not walk');
// Pitch forward for two seconds: the drone travels.
const dp0 = [...snap.drones[0].p];
snap = drive(2, { slot: GADGET, drone: { ...stick, pitch: 1, throttle: 0.2 } });
const dp1 = snap.drones[0].p;
assert.ok(Math.hypot(dp1[0] - dp0[0], dp1[2] - dp0[2]) > 3, 'a pitched quad moves under manual control');

// Hands off (mode 0): back to auto, and the body walks again.
snap = drive(0.5, { slot: GADGET, moveZ: 1, drone: { ...stick, mode: 0 } });
assert.equal(snap.drones[0].mode, 'auto');
assert.equal(snap.players.find(p => p.id === ownerId).controlling, null);
const w0 = [...snap.players.find(p => p.id === ownerId).position];
snap = drive(1, { slot: GADGET, moveZ: 1 });
const w1 = snap.players.find(p => p.id === ownerId).position;
assert.ok(Math.hypot(w1[0] - w0[0], w1[2] - w0[2]) > 0.5, 'released, the operator walks again');

// Send it somewhere and it goes; the guest sees the same order.
snap = drive(0.2, { slot: GADGET, drone: { id: drone.id, mode: 0, send: [40, 0, -30] } });
assert.equal(snap.drones[0].state, 'goto');
assert.deepEqual(snap.drones[0].target, [40, 0, -30]);
const ownerView = message(owner, 'base:snapshot');
assert.deepEqual(ownerView.drones[0].target, snap.drones[0].target, 'owner and guest read one drone list');

// A guest cannot fly it: the input names a drone it does not own.
const guestId = message(guest, 'base:joined').clientId;
void guestId;
service.handle(guest, { type: 'base:input', protocol: BASE_GAME_PROTOCOL_VERSION, ticks: [{ ...base, tick: 1, drone: { id: drone.id, mode: 1 } }], clientTime: clock });
clock += 100; service.step(clock); service.broadcastSnapshots();
snap = message(guest, 'base:snapshot');
assert.equal(snap.drones[0].mode, 'auto', 'a non-owner cannot take the stick');

// Let it get some way out, then recall: it turns for home and ends up following again.
snap = drive(3, { slot: GADGET });
assert.equal(snap.drones[0].state, 'goto');
snap = drive(0.2, { slot: GADGET, drone: { id: drone.id, mode: 0, recall: true } });
assert.ok(['return', 'follow'].includes(snap.drones[0].state), `recall turns it home (${snap.drones[0].state})`);
assert.equal(snap.drones[0].target, null);
snap = drive(15, { slot: GADGET });
assert.equal(snap.drones[0].state, 'follow', 'and it is back on the owner');

// The wire shape survives the protocol sanitizer.
const { sanitizeBaseGameDroneState, sanitizeBaseGamePlayerState } = await import('../base-game-protocol.mjs');
assert.ok(sanitizeBaseGameDroneState(JSON.parse(JSON.stringify(snap.drones[0]))));
assert.equal(sanitizeBaseGamePlayerState(JSON.parse(JSON.stringify(snap.players[0]))).controlling, null);

// Shot to pieces: the crash goes off where it ends, as an explosion every client presents.
{
  const { damageBaseGameDrone } = await import('../base-game-drones.js');
  const room = service.rooms.get('DRONES');
  const rec = [...room.drones.values()][0];
  const before = snap.drones[0].p;
  damageBaseGameDrone(rec, 999, { roll: 0.9 });
  snap = drive(0.2, { slot: GADGET });
  assert.equal(snap.drones.length, 0, 'the drone is gone');
  const boom = snap.explosions.find(e => e.weapon === 'quad_crash');
  assert.ok(boom, 'a crash explosion rides the snapshot');
  assert.ok(Math.hypot(boom.p[0] - before[0], boom.p[2] - before[2]) < 30, 'it goes off where the drone was');
  assert.equal(boom.radius, 3);
}

console.log('Base-game drone room tests passed.');
