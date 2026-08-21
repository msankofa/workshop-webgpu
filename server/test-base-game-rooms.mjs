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

const resumeToken = ownerJoined.resumeToken;
owner.readyState = 3;
assert.equal(service.disconnect(owner), true);
const resumed = socket();
service.handle(resumed, {
  type: 'base:resume', protocol: BASE_GAME_PROTOCOL_VERSION, resumeToken,
});
assert.equal(message(resumed, 'base:joined').clientId, ownerJoined.clientId);
assert.equal(message(resumed, 'base:joined').owner, true);

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
