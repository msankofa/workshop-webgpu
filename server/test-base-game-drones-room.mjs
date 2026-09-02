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

// Shot to pieces: it FALLS, and goes off where it lands. It used to end on the spot, which put the
// explosion wherever the drone happened to be hit -- often a couple of hundred metres up, with
// nothing on the ground to show for it.
{
  const { damageBaseGameDrone } = await import('../base-game-drones.js');
  const room = service.rooms.get('DRONES');
  const rec = [...room.drones.values()][0];
  const before = snap.drones[0].p;
  const res = damageBaseGameDrone(rec, 999, { roll: 0.9 });
  assert.ok(res.dead && res.deadstick, 'a killed drone comes down rather than ending in the air');
  let boom = null;
  for (let i = 0; i < 60 && !boom; i++) {
    snap = drive(0.2, { slot: GADGET });
    boom = snap.explosions.find(e => e.weapon === 'quad_crash');
  }
  assert.ok(boom, 'a crash explosion rides the snapshot');
  assert.equal(snap.drones.length, 0, 'and the drone is gone');
  assert.ok(Math.hypot(boom.p[0] - before[0], boom.p[2] - before[2]) < 120, 'it goes off near where it was hit');
  const groundHere = typeof room.sim.heightAt === 'function' ? room.sim.heightAt(boom.p[0], boom.p[2]) : (room.sim.spawn?.[1] ?? 1.5) - 1.5;
  assert.ok(boom.p[1] - groundHere < 3, `and on the ground, not in the air (${(boom.p[1] - groundHere).toFixed(1)} m up)`);
  assert.equal(boom.radius, 3);
}

// The hit volume: a bullet down the sight line at a drone brings it down. Before this, a drone had a
// bodyRadius that nothing read and you could shoot straight through it.
{
  const room = service.rooms.get('DRONES');
  const { droneHitVolumes, blastDamageOnDrone } = await import('../base-game-drones.js');
  const { createBaseGameDrone } = await import('../base-game-drones.js');
  const me = snap.players.find(p => p.id === ownerId);
  const rec = createBaseGameDrone('quad', { ownerId, from: [me.position[0], me.position[1] + 30, me.position[2] - 12], groundY: 0 });
  room.drones.set(rec.id, rec);
  const vols = droneHitVolumes(room.drones);
  assert.ok(vols.some(v => v.id === rec.id && v.r > 0 && v.h === 0), 'a live drone is a sphere the hitscan can see');
  assert.equal(droneHitVolumes(room.drones, rec.id).some(v => v.id === rec.id), false, 'the excluded id is left out');
  // Blast falloff measures from the SURFACE, so a blast beside a wide craft has hit it.
  assert.ok(blastDamageOnDrone(rec, [rec.d.p[0], rec.d.p[1], rec.d.p[2]], 10, 100) > 90, 'a blast on top of it does full damage');
  assert.equal(blastDamageOnDrone(rec, [rec.d.p[0] + 500, rec.d.p[1], rec.d.p[2]], 10, 100), 0, 'and none from far away');
  rec.done = true;
  assert.equal(droneHitVolumes(room.drones).some(v => v.id === rec.id), false, 'a dead drone is not a target');
  room.drones.delete(rec.id);
}

// The Sentinel: an owner-only `base:drone` puts one into orbit over the sender; the guest is refused.
{
  service.handle(guest, { type: 'base:drone', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', kind: 'sentinel', preset: 'low' });
  assert.equal(message(guest, 'base:error')?.code, 'not_owner', 'a guest cannot spawn a world drone');
  service.handle(owner, { type: 'base:drone', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', kind: 'sentinel', preset: 'high', alt: 1200, radius: 700 });
  snap = drive(0.2, { slot: 0 });
  const sentinel = snap.drones.find(d => d.kind === 'sentinel');
  assert.ok(sentinel, 'the sentinel rides the snapshot');
  assert.equal(sentinel.owner, ownerId, 'it is owned by the spawner, so the orbit follows them');
  assert.equal(sentinel.state, 'follow', 'it appears already on station');
  const me = snap.players.find(p => p.id === ownerId);
  const room = service.rooms.get('DRONES');
  const groundY = typeof room.sim.heightAt === 'function' ? room.sim.heightAt(sentinel.p[0], sentinel.p[2]) : (room.sim.spawn?.[1] ?? 1.5) - 1.5;   // the server's roomGroundY rule
  assert.ok(Math.abs((sentinel.p[1] - groundY) - 1200) < 60, `it flies at the requested height (${(sentinel.p[1] - groundY).toFixed(0)} m)`);
  assert.ok(Math.hypot(sentinel.p[0] - me.position[0], sentinel.p[2] - me.position[2]) < 700 * 1.6, 'and near the requested ring');
  // F on it: the owner flies it like any other drone, and hands it back to its orbit.
  snap = drive(0.5, { slot: 0, drone: { id: sentinel.id, mode: 1, pitch: 0, roll: 0, yaw: 0, throttle: 0 } });
  assert.equal(snap.players.find(p => p.id === ownerId).controlling, sentinel.id, "the owner takes the sentinel's stick");
  assert.equal(snap.drones.find(d => d.kind === 'sentinel').mode, 'manual');
  snap = drive(0.5, { slot: 0, drone: { id: sentinel.id, mode: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0 } });
  assert.equal(snap.drones.find(d => d.kind === 'sentinel').mode, 'auto', 'released, it flies itself again');
  assert.ok(sanitizeBaseGameDroneState(JSON.parse(JSON.stringify(snap.drones.find(d => d.kind === 'sentinel')))), 'the sentinel wire state sanitizes');

  // The missile, end to end: the stick carries an aim and one trigger edge, the server takes a round
  // off the rack, flies it, and it goes off on the ground near where it was aimed.
  {
    const before = snap.drones.find(d => d.kind === 'sentinel');
    assert.equal(before.agm, 4, 'a fresh sentinel rides the wire with a full rack');
    const aim = [before.p[0], groundY, before.p[2] - 300];
    const stick = { id: before.id, mode: 1, pitch: 0, roll: 0, yaw: 0, throttle: 0, aim };
    // One tick with the trigger down, then hold the aim without it: a held key must not empty the rack.
    let fired = 0;
    snap = drive(0.2, { slot: 0, drone: stick }, () => ({ drone: { ...stick, fire: fired++ === 0 } }));
    const after = snap.drones.find(d => d.kind === 'sentinel');
    assert.equal(after.agm, 3, `one round left the rack, not ${4 - after.agm}`);
    const missile = snap.projectiles.find(pr => pr.weapon === 'agm');
    assert.ok(missile, 'the missile rides the snapshot so every client can draw it');
    assert.equal(missile.owner, ownerId, 'it belongs to whoever fired it');
    // Fly it in. It has to detonate, and near the aim.
    let boom = null;
    for (let i = 0; i < 60 && !boom; i++) {
      snap = drive(0.2, { slot: 0, drone: { ...stick, fire: false } });
      boom = snap.explosions.find(e => e.weapon === 'agm');
    }
    assert.ok(boom, 'the missile detonates');
    assert.ok(Math.hypot(boom.p[0] - aim[0], boom.p[2] - aim[2]) < 25, `it goes off near the aim (${Math.hypot(boom.p[0] - aim[0], boom.p[2] - aim[2]).toFixed(1)} m away)`);
    assert.equal(boom.radius, 10, 'with the rack\'s blast radius');
  }

  service.handle(owner, { type: 'base:drone', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'clear' });
  snap = drive(0.2, { slot: 0 });
  assert.equal(snap.drones.filter(d => d.kind === 'sentinel').length, 0, 'clear removes world drones');
}

console.log('Base-game drone room tests passed.');
