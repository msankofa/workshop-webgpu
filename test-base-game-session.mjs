import assert from 'node:assert/strict';
import { connectBaseGameSession } from './base-game-session.mjs';
import { BASE_GAME_PROTOCOL_VERSION } from './base-game-protocol.mjs';

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const statuses = [];
const snapshots = [];
const pending = connectBaseGameSession({
  mode: 'create', roomCode: ' wolf ', relayUrl: 'ws://test', WebSocketImpl: FakeWebSocket,
  world: { todHour: 12, todPlaying: true, skyEnabled: false },
  onStatus: status => statuses.push(status.state),
  onSnapshot: snapshot => snapshots.push(snapshot),
});

const ws = FakeWebSocket.instances[0];
ws.open();
assert.deepEqual(ws.sent[0], {
  type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'WOLF',
  world: { todHour: 12, todPlaying: true },
  terrain: { kind: 'traversalLab' },
});
ws.receive({
  type: 'base:joined', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'WOLF',
  clientId: 'p1', resumeToken: 'resume-1', owner: true,
});
ws.receive({
  type: 'base:snapshot', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'WOLF',
  ownerId: 'p1', revision: 1, worldReady: true, world: { todHour: 12 }, players: [],
});

const session = await pending;
assert.equal(session.owner, true);
assert.equal(session.roomCode, 'WOLF');
assert.equal(snapshots.length, 1);
assert.equal(session.setWorld({ todHour: 99, skyEnabled: false }), true);
assert.deepEqual(ws.sent[1].patch, { todHour: 0 });
assert.equal(session.setBodyModel('soldier:medic'), true);
assert.deepEqual(ws.sent[2], { type: 'base:set_body', protocol: BASE_GAME_PROTOCOL_VERSION, bodyModel: 'soldier:medic' });

session.destroy();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(FakeWebSocket.instances.length, 1, 'destroy must not reconnect');
assert.equal(statuses.at(-1), 'closed');

await assert.rejects(
  connectBaseGameSession({
    mode: 'join', roomCode: 'SLOW', relayUrl: 'ws://test', WebSocketImpl: FakeWebSocket,
    handshakeTimeoutMs: 5,
  }),
  /did not answer/,
);

console.log('Base-game client session tests passed.');
