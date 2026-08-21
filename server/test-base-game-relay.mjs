import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { BASE_GAME_PROTOCOL_VERSION } from '../base-game-protocol.mjs';

const port = 18_000 + Math.floor(Math.random() * 1_000);
const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay start timeout')), 5_000);
    child.stdout.on('data', chunk => {
      if (!String(chunk).includes('relay listening')) return;
      clearTimeout(timeout); resolve();
    });
    child.once('exit', code => reject(new Error(`relay exited early (${code})`)));
  });
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function inbox(ws) {
  const queued = [];
  const waiters = [];
  ws.on('message', raw => {
    const packet = JSON.parse(raw);
    const index = waiters.findIndex(waiter => waiter.predicate(packet));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(packet);
    else queued.push(packet);
  });
  return predicate => {
    const index = queued.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
        reject(new Error('message timeout'));
      }, 3_000);
    });
  };
}

let owner;
let guest;
try {
  await waitForServer();
  owner = await openSocket();
  const ownerMessage = inbox(owner);
  owner.send(JSON.stringify({
    type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'LIVE',
    world: { todEnabled: true, todHour: 9, todSpeed: 0, sunIntensity: 3 },
  }));
  const joined = await ownerMessage(packet => packet.type === 'base:joined');
  assert.equal(joined.owner, true);

  guest = await openSocket();
  const guestMessage = inbox(guest);
  guest.send(JSON.stringify({ type: 'base:join', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'LIVE' }));
  await guestMessage(packet => packet.type === 'base:joined');

  owner.send(JSON.stringify({
    type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { sunIntensity: 1.25 },
  }));
  const snapshot = await guestMessage(packet => packet.type === 'base:snapshot' && packet.world.sunIntensity === 1.25);
  assert.equal(snapshot.world.todHour, 9);

  guest.send(JSON.stringify({
    type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: { sunIntensity: 4 },
  }));
  const denied = await guestMessage(packet => packet.type === 'base:error');
  assert.equal(denied.code, 'not_owner');

  // Player replication: the owner walks forward; the guest sees the authoritative movement.
  const ready = await guestMessage(packet => packet.type === 'base:snapshot' && packet.worldReady === true);
  const ownerBefore = ready.players.find(player => player.id === joined.clientId);
  assert.ok(ownerBefore && Array.isArray(ownerBefore.position), 'snapshot carries owner position');
  const tick = (n, moveZ) => ({ tick: n, moveX: 0, moveZ, yaw: 0, pitch: 0, sprint: true, jump: false });
  owner.send(JSON.stringify({
    type: 'base:input', protocol: BASE_GAME_PROTOCOL_VERSION, clientTime: 0,
    ticks: Array.from({ length: 60 }, (_, i) => tick(i + 1, 1)),
  }));
  const movedSnapshot = await guestMessage(packet => {
    if (packet.type !== 'base:snapshot') return false;
    const entry = packet.players.find(player => player.id === joined.clientId);
    return entry && entry.lastProcessedTick === 60 && entry.position[2] < ownerBefore.position[2] - 0.5;
  });
  assert.ok(movedSnapshot.tick > 0, 'server tick advances while simulating');
  owner.send(JSON.stringify({ type: 'base:set_position', protocol: BASE_GAME_PROTOCOL_VERSION, position: [0, 99, 0] }));
  owner.send(JSON.stringify({
    type: 'base:input', protocol: BASE_GAME_PROTOCOL_VERSION, clientTime: 0,
    ticks: Array.from({ length: 10 }, (_, i) => tick(61 + i, 0)),
  }));
  const stopped = await guestMessage(packet => packet.type === 'base:snapshot'
    && packet.players.find(player => player.id === joined.clientId)?.lastProcessedTick === 70);
  assert.ok(stopped.players.find(player => player.id === joined.clientId).position[1] < 5, 'transform injection is ignored');

  console.log('Base-game live relay tests passed.');
} finally {
  owner?.close();
  guest?.close();
  child.kill();
}
