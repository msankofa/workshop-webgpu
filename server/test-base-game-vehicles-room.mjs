// Ground vehicles through the authoritative room: UGV gadget/orders/remote driving, buggy
// placement/seat prediction authority, ownership, exit momentum, snapshots and protocol state.
import assert from 'node:assert/strict';
import { createBaseGameRoomService } from './base-game-rooms.js';
import {
  BASE_GAME_PROTOCOL_VERSION, BASE_GAME_DEFAULT_LOADOUT, BASE_GAME_WEAPON_SLOTS, BASE_GAME_SIM_HZ,
  sanitizeBaseGamePlayerState, sanitizeBaseGameVehicleState, sanitizeBaseGameVehicleSeatState, BASE_GAME_VEHICLE_LIGHTS,
} from '../base-game-protocol.mjs';
import { BASE_GAME_VEHICLE_DEFS } from '../base-game-vehicles.js';

let clock = 5_000, tokenSeq = 0;
const service = createBaseGameRoomService({ now: () => clock, makeToken: () => `v${++tokenSeq}-token`, graceMs: 1_000 });
const socket = () => ({ readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; } });
const message = (ws, type) => [...ws.sent].reverse().find(packet => packet.type === type);

const owner = socket(), guest = socket();
service.handle(owner, { type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'VEHICLES' });
service.handle(guest, { type: 'base:join', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'VEHICLES' });
await service.ensureWorld();
const ownerId = message(owner, 'base:joined').clientId;
const guestId = message(guest, 'base:joined').clientId;
const GADGET = BASE_GAME_WEAPON_SLOTS.indexOf('gadget');
let ownerTick = 0, guestTick = 0;
const neutral = { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, sprint: false, crouch: false, stance: 0, jump: false, slot: 0, aim: false, reload: false, fire: false, throw: false, drone: null };

function drive(ws, seconds, over = {}, perTick = null) {
  const slices = Math.round(seconds * 10);
  for (let s = 0; s < slices; s++) {
    const ticks = [];
    for (let i = 0; i < BASE_GAME_SIM_HZ / 10; i++) {
      const tick = ws === owner ? ++ownerTick : ++guestTick;
      ticks.push({ ...neutral, ...over, ...(perTick ? perTick(tick) : {}), tick });
    }
    service.handle(ws, { type: 'base:input', protocol: BASE_GAME_PROTOCOL_VERSION, ticks, clientTime: clock });
    clock += 100; service.step(clock);
  }
  service.broadcastSnapshots();
  return message(owner, 'base:snapshot');
}

// Choose the UGV without changing the default loadout, then deploy the single stock item.
service.handle(owner, { type: 'base:loadout', protocol: BASE_GAME_PROTOCOL_VERSION, loadout: { ...BASE_GAME_DEFAULT_LOADOUT, gadget: 'ugv' } });
drive(owner, 1, { slot: GADGET });
drive(owner, 0.2, { slot: GADGET }, tick => ({ fire: tick % 12 === 1 }));
let snap = drive(owner, 0.4, { slot: GADGET });
assert.equal(snap.vehicles.length, 1);
let ugv = snap.vehicles[0];
assert.equal(ugv.kind, 'ugv'); assert.equal(ugv.owner, ownerId);
assert.equal(snap.players.find(p => p.id === ownerId).gadgets.ugv, 0);
snap = drive(owner, 5, { slot: GADGET });
assert.equal(snap.vehicles[0].state, 'follow');

// Remote driving is stepped in this player's tick: vehicle moves, operator remains where it was.
ugv = snap.vehicles[0];
const operator0 = [...snap.players.find(p => p.id === ownerId).position];
const ugv0 = [...ugv.p];
const remote = { id: ugv.id, mode: 1 };
snap = drive(owner, 2, { slot: GADGET, moveZ: 1, moveX: 0.25, drone: remote });
const operator1 = snap.players.find(p => p.id === ownerId);
assert.equal(operator1.controlling, ugv.id);
assert.ok(operator1.vehicle && sanitizeBaseGameVehicleSeatState(operator1.vehicle));
assert.ok(Math.hypot(operator1.position[0] - operator0[0], operator1.position[2] - operator0[2]) < 0.05);
assert.ok(Math.hypot(snap.vehicles[0].p[0] - ugv0[0], snap.vehicles[0].p[2] - ugv0[2]) > 1);

// A guest cannot take an owned UGV.
drive(guest, 0.2, { drone: remote, moveZ: 1 });
snap = message(owner, 'base:snapshot');
assert.equal(snap.vehicles[0].driver, ownerId);
assert.equal(snap.players.find(p => p.id === guestId).controlling, null);

// Release, send and recall reuse the drone input channel.
snap = drive(owner, 0.2, { slot: GADGET, drone: { id: ugv.id, mode: 0 } });
assert.equal(snap.players.find(p => p.id === ownerId).controlling, null);
snap = drive(owner, 0.2, { slot: GADGET, drone: { id: ugv.id, mode: 0, send: [12, 0, 12] } });
assert.equal(snap.vehicles[0].state, 'goto');
snap = drive(owner, 0.2, { slot: GADGET, drone: { id: ugv.id, mode: 0, recall: true } });
assert.ok(['return', 'follow'].includes(snap.vehicles[0].state));

// The owner places a world buggy. Place it beside the current body so the seat is in range.
const p = snap.players.find(row => row.id === ownerId).position;
clock += 200;
service.handle(owner, { type: 'base:vehicle', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', kind: 'buggy', at: [p[0], 0, p[2] + 1], aimed: false });
service.broadcastSnapshots(); snap = message(owner, 'base:snapshot');
const buggy = snap.vehicles.find(v => v.kind === 'buggy');
assert.ok(buggy && sanitizeBaseGameVehicleState(buggy));

// Enter and drive. The authoritative player transform is the onboard seat and carries seat state.
snap = drive(owner, 0.2, { drone: { id: buggy.id, mode: 1 } });
assert.equal(snap.players.find(row => row.id === ownerId).controlling, buggy.id);
const buggy0 = [...snap.vehicles.find(v => v.id === buggy.id).p];
snap = drive(owner, 2, { moveZ: 1, moveX: -0.2, drone: { id: buggy.id, mode: 1 } });
const driven = snap.vehicles.find(v => v.id === buggy.id);
const seated = snap.players.find(row => row.id === ownerId);
assert.ok(Math.hypot(driven.p[0] - buggy0[0], driven.p[2] - buggy0[2]) > 2);
assert.ok(seated.vehicle && seated.vehicle.id === buggy.id);
assert.ok(Math.hypot(seated.position[0] - driven.p[0], seated.position[2] - driven.p[2]) < 1);

// Non-driver movement cannot move the occupied buggy.
const occupied0 = [...driven.p];
drive(guest, 0.5, { moveZ: 1, drone: { id: buggy.id, mode: 1 } });
snap = message(owner, 'base:snapshot');
const occupied1 = snap.vehicles.find(v => v.id === buggy.id).p;
assert.ok(Math.hypot(occupied1[0] - occupied0[0], occupied1[2] - occupied0[2]) < 0.25);

// Exit leaves the buggy rolling, after which the room-wide zero-input step slows it naturally.
snap = drive(owner, 0.1, { drone: { id: buggy.id, mode: 0 } });
assert.equal(snap.players.find(row => row.id === ownerId).controlling, null);
const released = snap.vehicles.find(v => v.id === buggy.id);
const speed0 = Math.hypot(...released.v);
snap = drive(owner, 4, {});
const stopped = snap.vehicles.find(v => v.id === buggy.id);
assert.ok(Math.hypot(...stopped.v) < speed0, 'released buggy slows under rolling and aerodynamic drag');

// Snapshot and player payloads survive the protocol boundary.
assert.ok(sanitizeBaseGameVehicleState(JSON.parse(JSON.stringify(stopped))));
assert.ok(sanitizeBaseGamePlayerState(JSON.parse(JSON.stringify(snap.players.find(row => row.id === ownerId)))));

// ---- the weapon station -----------------------------------------------------
// It trains on a world aim point, refuses to fire until the barrel is there, and its rounds go
// through the same lag-compensated hitscan a hand weapon uses.
{
  const shooter = { id: ugv.id, mode: 1 };
  const aimAt = (v, reach) => [v.p[0] + Math.sin(v.yaw) * reach, v.p[1] + 0.6, v.p[2] + Math.cos(v.yaw) * reach];

    // Aim well off the boresight, then check it is still slewing rather than already there.
  let s = message(owner, 'base:snapshot');
  let v = s.vehicles.find(x => x.id === ugv.id);
  // The switches. Only the driver's stick sets them, they stay as left when the stick is dropped,
  // and a bit the hull does not have never reaches the wire.
  s = drive(owner, 0.05, { drone: { ...shooter, lights: BASE_GAME_VEHICLE_LIGHTS.head | BASE_GAME_VEHICLE_LIGHTS.high } });
  v = s.vehicles.find(x => x.id === ugv.id);
  assert.equal(v.lights, BASE_GAME_VEHICLE_LIGHTS.head, 'the driver switches the headlight on; high beams are not a UGV switch');
  s = drive(owner, 0.05, { drone: { ...shooter } });
  v = s.vehicles.find(x => x.id === ugv.id);
  assert.equal(v.lights, BASE_GAME_VEHICLE_LIGHTS.head, 'a stick that does not mention the lights leaves them on');

  const side = [v.p[0] + 40, v.p[1] + 0.6, v.p[2]];
  s = drive(owner, 0.05, { drone: { ...shooter, aim: side, fire: true } });
  v = s.vehicles.find(x => x.id === ugv.id);
  assert.ok(Number.isFinite(v.turretYaw), 'the trained angle is on the wire');
  assert.equal(v.turretAmmo, BASE_GAME_VEHICLE_DEFS.ugv.turret.ammo,
    'a station still slewing has not fired');

  // Hold the aim until it arrives, then hold the trigger: rounds leave and the count drops.
  s = drive(owner, 3, { drone: { ...shooter, aim: side, fire: true } });
  v = s.vehicles.find(x => x.id === ugv.id);
  assert.ok(v.turretAmmo < BASE_GAME_VEHICLE_DEFS.ugv.turret.ammo, 'a trained station fires');
  const spent = BASE_GAME_VEHICLE_DEFS.ugv.turret.ammo - v.turretAmmo;
  assert.ok(spent > 3 && spent < 60, `and at its own rate, not once per tick (${spent} rounds)`);

  // Letting the trigger go stops it.
  const held = v.turretAmmo;
  s = drive(owner, 1, { drone: { ...shooter, aim: side, fire: false } });
  v = s.vehicles.find(x => x.id === ugv.id);
  assert.equal(v.turretAmmo, held, 'trigger released, nothing leaves');

  // A player who does not own the station cannot fire it.
  drive(guest, 1, { drone: { ...shooter, aim: side, fire: true } });
  s = message(owner, 'base:snapshot');
  v = s.vehicles.find(x => x.id === ugv.id);
  assert.equal(v.turretAmmo, held, 'a non-owner cannot fire the station');

  // And the payload still survives the protocol boundary with the new fields on it.
  const clean = sanitizeBaseGameVehicleState(JSON.parse(JSON.stringify(v)));
  assert.ok(clean && Number.isFinite(clean.turretYaw) && Number.isFinite(clean.turretAmmo));
}

// Destruction, through the room. Before this a vehicle was scenery: `damageBaseGameVehicle` existed
// and nothing called it, so the UGV could kill and could not be killed.
{
  const room = service.rooms.get('VEHICLES');
  const { createBaseGameVehicle, vehicleHitVolumes, blastDamageOnVehicle, WRECK_SECONDS } =
    await import('../base-game-vehicles.js');

  const rec = createBaseGameVehicle('buggy', { ownerId, from: [40, 0, 40], yaw: 0, groundY: 0 });
  room.vehicles.set(rec.id, rec);

  const vols = vehicleHitVolumes(room.vehicles).filter(v => v.id === rec.id);
  assert.equal(vols.length, 2, 'a live vehicle is two capsules the hitscan can see');
  assert.equal(vehicleHitVolumes(room.vehicles, rec.id).some(v => v.id === rec.id), false,
    'the excluded id is left out, so a gunner does not shoot his own hull');

  // A blast beside it hurts it; one across the map does not.
  assert.ok(blastDamageOnVehicle(rec, [rec.body.x, rec.y + 0.5, rec.body.z], 10, 100) > 90,
    'a blast on the hull does full damage');
  assert.equal(blastDamageOnVehicle(rec, [rec.body.x + 500, rec.y, rec.body.z], 10, 100), 0,
    'and none from far away');

  // Kill it and watch the wreck: it stays on the roster, and the crash blast reaches the snapshot.
  const def = BASE_GAME_VEHICLE_DEFS.buggy;
  const before = [rec.body.x, rec.body.z];
  const { damageBaseGameVehicle } = await import('../base-game-vehicles.js');
  assert.equal(damageBaseGameVehicle(rec, def.hp * 2).dead, true, 'enough damage kills it');
  const snap = drive(owner, 0.3);
  const wreck = snap.vehicles.find(v => v.id === rec.id);
  assert.ok(wreck, 'the wreck is still replicated rather than deleted on the tick it died');
  assert.equal(wreck.state, 'wreck', 'and says so on the wire');
  assert.equal(wreck.hp, 0, 'with no health left');

  const boom = snap.explosions?.find(e => e.weapon === 'buggy_crash');
  assert.ok(boom, 'the crash blast rides the snapshot');
  assert.ok(Math.hypot(boom.p[0] - before[0], boom.p[2] - before[1]) < 4,
    'and goes off where the vehicle stood');

  // The secondaries follow, each its own explosion event, because it carries fuel. The first
  // snapshot already covers 0.3 s of wreck, so its own count goes in too.
  let blasts = (snap.explosions ?? []).filter(e => e.weapon === 'buggy_crash').length;
  for (let i = 0; i < 12; i++) {
    const s = drive(owner, 0.1);
    blasts += (s.explosions ?? []).filter(e => e.weapon === 'buggy_crash').length;
  }
  assert.equal(blasts, 1 + def.secondaries.length,
    `the crash blast and all ${def.secondaries.length} secondaries go off (${blasts})`);

  // It is not a target while it burns, and it is gone once it has.
  assert.equal(vehicleHitVolumes(room.vehicles).some(v => v.id === rec.id), false,
    'a wreck offers nothing to hit');
  for (let i = 0; i < Math.ceil(WRECK_SECONDS / 2) + 2; i++) drive(owner, 2);
  assert.equal(room.vehicles.has(rec.id), false, `the wreck is cleared after ${WRECK_SECONDS} s`);
}

console.log('Base-game vehicle room tests passed.');
