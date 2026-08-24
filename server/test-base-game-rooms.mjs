import assert from 'node:assert/strict';
import { createBaseGameRoomService } from './base-game-rooms.js';
import { BASE_GAME_PROTOCOL_VERSION } from '../base-game-protocol.mjs';

let clock = 1_000;
let tokenSeq = 0;
const service = createBaseGameRoomService({
  now: () => clock,
  makeToken: () => `token-${++tokenSeq}`,
  graceMs: 1_000,
});

function socket() {
  return {
    readyState: 1,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close() { this.readyState = 3; },
  };
}

function message(ws, type) {
  return [...ws.sent].reverse().find(packet => packet.type === type);
}

const owner = socket();
service.handle(owner, {
  type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'TEST',
  world: { todEnabled: true, todPlaying: true, todHour: 12, todSpeed: 60, sunIntensity: 3 },
});
const ownerJoined = message(owner, 'base:joined');
assert.ok(ownerJoined?.owner);
assert.equal(message(owner, 'base:snapshot').world.todHour, 12);

const duplicate = socket();
service.handle(duplicate, { type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'TEST' });
assert.equal(message(duplicate, 'base:error').code, 'room_exists');

const guest = socket();
service.handle(guest, { type: 'base:join', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'test' });
assert.equal(message(guest, 'base:joined').owner, false);
assert.equal(message(guest, 'base:snapshot').players.length, 2);

service.handle(guest, { type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { sunIntensity: 0 } });
assert.equal(message(guest, 'base:error').code, 'not_owner');

clock += 2_000;
service.handle(owner, { type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { sunIntensity: 99 } });
const authoritative = message(guest, 'base:snapshot');
assert.equal(authoritative.world.todHour, 14);
assert.equal(authoritative.world.sunIntensity, 4);

// Weather is carried, not simulated: the owner sets it, the server clamps it and echoes it to
// everyone, and a guest cannot. Local look keys are not part of the world at all.
service.handle(owner, {
  type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION,
  patch: { weatherRain: 0.6, weatherOvercast: 0.2, cloudAHeight: 1200, cloudBCover: 0.44, cloudAExtent: 31000 },
});
const weatherSnapshot = message(guest, 'base:snapshot');
assert.equal(weatherSnapshot.world.weatherRain, 0.6);
assert.equal(weatherSnapshot.world.cloudAHeight, 1200);
assert.equal(weatherSnapshot.world.cloudBCover, 0.44);
assert.equal('cloudAExtent' in weatherSnapshot.world, false, 'a local look key never enters the room world');

service.handle(owner, { type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { weatherRain: 7, cloudBHeight: -50 } });
const clamped = message(guest, 'base:snapshot');
assert.equal(clamped.world.weatherRain, 1, 'the server clamps an over-range master');
assert.equal(clamped.world.cloudBHeight, 0, 'the server clamps a negative deck height');

// Wind (phase R1). It leans every peer's drops, so it is the owner's, and it is clamped the same way.
service.handle(owner, {
  type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION,
  patch: { weatherWindDeg: 210, weatherWindSpeed: 9.5, weatherGust: 6, weatherGustPeriod: 24, rainMaxDrops: 999 },
});
const wind = message(guest, 'base:snapshot');
assert.equal(wind.world.weatherWindDeg, 210);
assert.equal(wind.world.weatherWindSpeed, 9.5);
assert.equal(wind.world.weatherGust, 6);
assert.equal(wind.world.weatherGustPeriod, 24);
assert.equal('rainMaxDrops' in wind.world, false, 'a drop budget is local, so it never enters the room world');

service.handle(owner, {
  type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION,
  patch: { weatherWindDeg: 999, weatherWindSpeed: -4, weatherGust: 1e6, weatherGustPeriod: 0 },
});
const windClamped = message(guest, 'base:snapshot');
assert.equal(windClamped.world.weatherWindDeg, 360, 'an over-range heading clamps to 360');
assert.equal(windClamped.world.weatherWindSpeed, 0, 'a negative wind speed clamps to 0');
assert.equal(windClamped.world.weatherGust, 40, 'an absurd gust clamps to the ceiling');
assert.equal(windClamped.world.weatherGustPeriod, 0.5, 'a zero gust period clamps to the floor, so nothing divides by it');

// `message` returns the LAST packet of a type and never clears, so a rejected patch has to be
// checked by counting broadcasts rather than by re-reading the newest snapshot.
const snapshotsBefore = guest.sent.filter(p => p.type === 'base:snapshot').length;
service.handle(guest, { type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { weatherRain: 0 } });
assert.equal(message(guest, 'base:error').code, 'not_owner');
assert.equal(guest.sent.filter(p => p.type === 'base:snapshot').length, snapshotsBefore,
  'a guest weather patch broadcasts nothing at all');

// A patch of only local keys sanitizes to nothing, so the server must not bump the revision for it.
const quietBefore = guest.sent.filter(p => p.type === 'base:snapshot').length;
service.handle(owner, { type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { cloudAOctaves: 6, rainDropsEnabled: false } });
assert.equal(guest.sent.filter(p => p.type === 'base:snapshot').length, quietBefore,
  'an all-local patch is dropped before the broadcast');

// Body identity is server-owned and survives reconnect. Clients choose only a whitelisted model;
// the server chooses its hit profile and starts a new pose epoch.
const ownerClient = service.rooms.get('TEST').clients.get(ownerJoined.clientId);
const bodyEpoch = ownerClient.poseEpoch;
service.handle(owner, { type: 'base:set_body', protocol: BASE_GAME_PROTOCOL_VERSION, bodyModel: 'v4' });
const bodyPlayer = message(guest, 'base:snapshot').players.find(player => player.id === ownerJoined.clientId);
assert.equal(bodyPlayer.bodyModel, 'v4');
assert.equal(bodyPlayer.hitProfile, 'humanoid-default');
assert.equal(bodyPlayer.poseEpoch, bodyEpoch + 1);
const rejectedBefore = ownerClient.rejectedInputs;
service.handle(owner, { type: 'base:set_body', protocol: BASE_GAME_PROTOCOL_VERSION, bodyModel: 'client-made-tiny-rig' });
assert.equal(ownerClient.bodyModel, 'v4', 'an unknown body cannot change server hit identity');
assert.equal(ownerClient.rejectedInputs, rejectedBefore + 1);

const resumeToken = ownerJoined.resumeToken;
owner.readyState = 3;
assert.equal(service.disconnect(owner), true);
const resumed = socket();
service.handle(resumed, {
  type: 'base:resume', protocol: BASE_GAME_PROTOCOL_VERSION, resumeToken,
});
assert.equal(message(resumed, 'base:joined').clientId, ownerJoined.clientId);
assert.equal(message(resumed, 'base:joined').owner, true);
assert.equal(message(resumed, 'base:snapshot').players.find(player => player.id === ownerJoined.clientId).bodyModel, 'v4');

resumed.readyState = 3;
service.disconnect(resumed);
clock += 1_100;
service.cleanup();
assert.equal(service.rooms.get('TEST').ownerId, message(guest, 'base:joined').clientId);

guest.readyState = 3;
service.disconnect(guest);
clock += 1_100;
service.cleanup();
assert.equal(service.rooms.has('TEST'), false);

console.log('Base-game authoritative room tests passed.');
