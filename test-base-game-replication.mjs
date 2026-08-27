import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  BASE_GAME_PROTOCOL_VERSION,
  createBaseGameRateLimiter,
  isAcceptableBaseGameTick,
  sanitizeBaseGameInputPacket,
  sanitizeBaseGameTickInput,
  sanitizeBaseGamePlayerState,
  sanitizeBaseGameLoadout,
  weaponForSlot,
  BASE_GAME_WEAPON_ACTION,
  BASE_GAME_RELOAD_TICKS,
} from './base-game-protocol.mjs';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createTraversalLabWorldQuery, createTraversalLabCollider } from './traversal-lab-collider.js';
import { createBaseGameTraversalLab } from './base-game-traversal-lab.js';
import { createBaseGamePlayerController, BASE_GAME_PLAYER_DEFAULT_CONFIG } from './base-game-player-controller.js';
import { createBaseGamePrediction } from './base-game-prediction.js';
import { createBaseGameRemotePlayers, createRemoteTrack } from './base-game-remote-players.js';
import { connectBaseGameSession } from './base-game-session.mjs';
import { createBaseGameRoomService } from './server/base-game-rooms.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };
const near = (a, b, epsilon = 0.02) => Math.abs(a - b) <= epsilon;
const P = BASE_GAME_PROTOCOL_VERSION;
const SWAP_SETTLE_TICKS = 160;   // longer than the slowest holster + draw (rifle 600 + 550 ms at 120 Hz)

// ---- protocol sanitizers ----
ok(P === 12, 'protocol is version 12');
const goodTick = sanitizeBaseGameTickInput({ tick: 5, moveX: 3, moveZ: -0.5, yaw: 1.2, pitch: 9, sprint: 1, jump: true });
ok(goodTick && goodTick.moveX === 1 && goodTick.moveZ === -0.5 && near(goodTick.pitch, Math.PI / 2, 1e-9)
  && goodTick.sprint === false && goodTick.jump === true, 'tick sanitizer clamps movement and keeps booleans strict');
ok(sanitizeBaseGameTickInput({ tick: 1.5, moveX: 0, moveZ: 0, yaw: 0, pitch: 0 }) === null, 'non-integer tick is rejected');
ok(sanitizeBaseGameTickInput({ tick: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0 }) === null, 'tick zero is rejected');
ok(sanitizeBaseGameTickInput({ tick: 1, moveX: NaN, moveZ: 0, yaw: 0, pitch: 0 }) === null, 'non-finite movement is rejected');
ok(sanitizeBaseGameTickInput({ tick: 1, moveX: 0, moveZ: 0, yaw: Infinity, pitch: 0 }) === null, 'non-finite yaw is rejected');
const t = (tick, extra = {}) => ({ tick, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, ...extra });
ok(sanitizeBaseGameInputPacket({ ticks: [t(7), t(8), t(9)] })?.ticks.length === 3, 'packet accepts consecutive ticks');
ok(sanitizeBaseGameInputPacket({ ticks: [t(1), t(2), t(4)] }) === null, 'packet rejects gapped ticks');
ok(sanitizeBaseGameInputPacket({ ticks: [t(2), t(1)] }) === null, 'packet rejects out-of-order ticks');
ok(sanitizeBaseGameInputPacket({ ticks: [] }) === null && sanitizeBaseGameInputPacket({ ticks: Array.from({ length: 65 }, (_, i) => t(i + 1)) }) === null,
  'packet rejects empty and oversized tick lists');
ok(sanitizeBaseGamePlayerState({ position: [1, 2, 3], velocity: [0, 0, 0] })?.position[1] === 2, 'player state sanitizer accepts a valid entry');
const bodyState = sanitizeBaseGamePlayerState({ position: [1, 2, 3], bodyModel: 'soldier:sniper', poseEpoch: 7 });
ok(bodyState.bodyModel === 'soldier:sniper' && bodyState.hitProfile === 'humanoid-default' && bodyState.poseEpoch === 7,
  'player snapshots carry validated body identity and server-selected hit profile');
ok(sanitizeBaseGamePlayerState({ position: [1, 2, 3], bodyModel: 'not-a-model' }).bodyModel === 'default',
  'unknown body identity is sanitized to the canonical default');
ok(sanitizeBaseGamePlayerState({ position: [1, NaN, 3] }) === null, 'player state sanitizer rejects NaN');
ok(isAcceptableBaseGameTick(6, 5) && !isAcceptableBaseGameTick(5, 5) && !isAcceptableBaseGameTick(4, 5)
  && !isAcceptableBaseGameTick(5 + 10_000, 5), 'tick helper rejects stale, duplicate, and far-future values');
const limiter = createBaseGameRateLimiter({ hz: 30, burst: 3 });
ok(limiter.allow(0) && limiter.allow(0) && limiter.allow(0) && !limiter.allow(0), 'rate limiter drains its burst');
ok(limiter.allow(1000), 'rate limiter refills over time');

// ---- shared collider: browser lab and server lab agree ----
const browserScene = new THREE.Scene();
const browserQuery = createWorldQueryService();
const browserLab = createBaseGameTraversalLab({ scene: browserScene, worldQuery: browserQuery });
const serverQuery = createWorldQueryService();
const serverLab = createTraversalLabWorldQuery(serverQuery);
ok(browserLab.stats.collisionTriangles === serverLab.stats.collisionTriangles, 'browser and server bake the same triangle count');
for (const probe of serverLab.layout.probes) {
  const a = browserQuery.groundProbe({ origin: probe.origin, maxDistance: 40 });
  const b = serverQuery.groundProbe({ origin: probe.origin, maxDistance: 40 });
  ok(a && b && near(a.point[1], b.point[1], 1e-9), `probe ${probe.id} matches between browser and server colliders`);
}

// ---- server simulation ----
let clock = 1000;
let tokenSeq = 0;
const service = createBaseGameRoomService({
  now: () => clock,
  makeToken: () => `token-${++tokenSeq}`,
  graceMs: 1000,
  playerCap: 2,
  world: { worldQuery: serverQuery, spawn: serverLab.layout.spawn, killPlaneY: serverLab.layout.killPlaneY, worldVersion: 'test' },
});
function socket() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; } };
}
const lastOf = (ws, type) => [...ws.sent].reverse().find(packet => packet.type === type);
const owner = socket();
service.handle(owner, { type: 'base:create', protocol: P, room: 'SIM' });
const ownerId = lastOf(owner, 'base:joined').clientId;
const guest = socket();
service.handle(guest, { type: 'base:join', protocol: P, room: 'SIM' });
const third = socket();
service.handle(third, { type: 'base:join', protocol: P, room: 'SIM' });
ok(lastOf(third, 'base:error')?.code === 'room_full', 'room cap rejects the extra player');

const room = service.rooms.get('SIM');
const ownerClient = room.clients.get(ownerId);
function runSteps(count) {
  for (let index = 0; index < count; index++) { clock += 1000 / 120; service.step(clock); }
}
const sendTicks = (ws, ticks) => {
  for (let i = 0; i < ticks.length; i += 60) service.handle(ws, { type: 'base:input', protocol: P, clientTime: clock, ticks: ticks.slice(i, i + 60) });
};

// Players are frozen until they send ticks; a resync adopts the client's numbering.
runSteps(30);
ok(ownerClient.controller.getPosition()[1] === serverLab.layout.spawn[1], 'a player with no ticks does not move (no substitute input)');
let nextTick = 1;
const walk = (count, extra = {}) => { const ticks = []; for (let i = 0; i < count; i++) ticks.push(t(nextTick++, extra)); return ticks; };
sendTicks(owner, walk(120));
ok(ownerClient.spawnRevision === 2 && ownerClient.lastConsumedTick === 0, 'first packet after join resyncs and bumps the spawn revision');
runSteps(120);
service.broadcastSnapshots();
let snap = lastOf(guest, 'base:snapshot');
let me = snap.players.find(player => player.id === ownerId);
ok(me.grounded && near(me.position[1], 0) && me.lastProcessedTick === 120 && me.queueDepth === 0,
  'server consumes exactly one tick per step and settles the player');
ok(snap.tick === 150 && snap.worldReady === true, 'snapshot carries the authoritative tick and world readiness');

const startZ = me.position[2];
// Measured against the configured walk speed rather than a fixed distance, so retuning movement
// cannot quietly turn this into an assertion that passes on any value.
const movedTicks = 60, expectMoved = BASE_GAME_PLAYER_DEFAULT_CONFIG.moveSpeed * (movedTicks / 120) * 0.5;
sendTicks(owner, walk(movedTicks, { moveZ: 1 }));
runSteps(movedTicks);
ok(ownerClient.controller.getPosition()[2] < startZ - expectMoved && ownerClient.lastConsumedTick === 180, 'queued movement ticks move the server player');

// Rejections never change the queue or consumed tick.
const queueBefore = ownerClient.queue.length;
const consumed = ownerClient.lastConsumedTick;
sendTicks(owner, [t(5, { moveX: -1 })]);
ok(ownerClient.queue.length === queueBefore, 'already-consumed ticks are ignored');
sendTicks(owner, [t(consumed + 5000, { moveX: -1 })]);
ok(ownerClient.queue.length === queueBefore, 'far-future ticks are ignored');
sendTicks(owner, [{ tick: consumed + 1, moveX: NaN, moveZ: 0, yaw: 0, pitch: 0 }]);
ok(ownerClient.queue.length === queueBefore, 'malformed packets are dropped whole');

// ---- weapons (phase 1): slot, aim and reload echo through the server; loadout message ----
{
  const tk = sanitizeBaseGameTickInput({ tick: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, slot: 1, aim: true, reload: true, fire: true });
  ok(tk.slot === 1 && tk.aim === true && tk.reload === true && tk.fire === true, 'tick input carries slot, aim, reload, fire');
  ok(sanitizeBaseGameTickInput({ tick: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, slot: 9 }).slot === 0, 'out-of-range slot falls back to primary');
  const lo = sanitizeBaseGameLoadout({ primary: 'm24', sidearm: 'bogus', melee: 'none' });
  ok(lo.primary === 'm24' && lo.sidearm === 'five_seven' && lo.melee === 'none' && lo.throwable === 'grenade', 'loadout sanitizer keeps valid ids and defaults the rest');
  ok(weaponForSlot(lo, 0) === 'm24' && weaponForSlot(lo, 2) === null, 'weaponForSlot resolves ids and empties');
  const st = sanitizeBaseGamePlayerState({ position: [0, 0, 0], weapon: 'cz_805_bren', slot: 1, aiming: true, action: 1, actionTick: 40, health: 150 });
  ok(st.weapon === 'cz_805_bren' && st.slot === 1 && st.aiming && st.action === 1 && st.actionTick === 40 && st.health === 100, 'player state carries weapon fields and clamps health');

  const c = ownerClient;
  ok(weaponForSlot(c.loadout, c.slot) === 'cz_805_bren', 'a new client holds the default primary');
  // Posture has to survive the round trip: the tick entry the prediction module builds IS the packet
// the relay receives AND the record the replay re-runs, so a field missing from it is missing from
// both. It was: only a server that had been fed the stance directly ever changed posture, and a
// client that kneeled while walking predicted full walk speed against the server's crouch speed.
{
  const entry = { tick: 7, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, sprint: false, crouch: false, stance: 2, jump: false };
  const clean = sanitizeBaseGameTickInput(entry);
  ok(clean?.stance === 2, 'the wire sanitizer keeps the stance on a tick');
  ok(sanitizeBaseGameTickInput({ ...entry, stance: 99 })?.stance === 0, 'and refuses a stance that is not in the ladder');
  const html = readFileSync(new URL('./base-game-prediction.js', import.meta.url), 'utf8');
  ok(html.includes('stance: Number.isInteger(input.stance)'), 'the predicted tick entry carries the stance');
  ok((html.match(/stance: (entry|item)\.stance/g) ?? []).length === 2, 'and both the live step and the replay pass it to the controller');
}

// Phase 4: a slot change is a swap. The slot moves at once, but the weapon in hand is still the
  // outgoing one until the holster finishes, and nothing can reload or fire on the way.
  sendTicks(owner, walk(10, { slot: 1, aim: true }));
  runSteps(10);
  ok(c.slot === 1 && c.aiming === true, 'slot and aim echo from consumed ticks');
  service.broadcastSnapshots();
  let s1 = lastOf(guest, 'base:snapshot').players.find((p) => p.id === ownerId);
  ok(s1.slot === 1 && s1.aiming === true && s1.health === 100, 'the snapshot echoes the slot and aim');
  ok(s1.weapon === 'cz_805_bren' && s1.action === BASE_GAME_WEAPON_ACTION.holster, 'mid-holster the rifle is still the weapon in hand');
  sendTicks(owner, walk(1, { slot: 1, reload: true }));
  runSteps(1);
  ok(c.action === BASE_GAME_WEAPON_ACTION.holster, 'a reload press during a swap does nothing');
  sendTicks(owner, walk(SWAP_SETTLE_TICKS, { slot: 1 }));
  runSteps(SWAP_SETTLE_TICKS);
  service.broadcastSnapshots();
  s1 = lastOf(guest, 'base:snapshot').players.find((p) => p.id === ownerId);
  ok(s1.weapon === 'five_seven' && c.action === BASE_GAME_WEAPON_ACTION.idle, 'once the draw finishes the pistol is in hand and the swap is over');
  sendTicks(owner, walk(1, { slot: 1, reload: true }));
  runSteps(1);
  const reloadTick = c.actionTick;
  ok(c.action === BASE_GAME_WEAPON_ACTION.reload && reloadTick === c.lastConsumedTick, 'a reload edge starts the reload action at that tick');
  sendTicks(owner, walk(5, { slot: 1, reload: true }));
  runSteps(5);
  ok(c.action === BASE_GAME_WEAPON_ACTION.reload && c.actionTick === reloadTick, 'reload edges during a reload do not restart it');
  sendTicks(owner, walk(1, { slot: 0 }));
  runSteps(1);
  ok(c.slot === 1 && c.action === BASE_GAME_WEAPON_ACTION.reload, 'a slot change during a reload is refused: both hands are busy');
  sendTicks(owner, walk(BASE_GAME_RELOAD_TICKS, { slot: 1 }));
  runSteps(BASE_GAME_RELOAD_TICKS);
  ok(c.action === BASE_GAME_WEAPON_ACTION.idle, 'the reload action clears after the reload window');
  sendTicks(owner, walk(1, { slot: 0 }));
  runSteps(1);
  ok(c.slot === 0, 'with the reload done the swap goes through');
  sendTicks(owner, walk(SWAP_SETTLE_TICKS, { slot: 0 }));
  runSteps(SWAP_SETTLE_TICKS);
  service.handle(owner, { type: 'base:loadout', protocol: P, loadout: { primary: 'm24' } });
  service.broadcastSnapshots();
  s1 = lastOf(guest, 'base:snapshot').players.find((p) => p.id === ownerId);
  ok(s1.weapon === 'm24', 'base:loadout replaces the loadout and the snapshot echoes it');
  const poses = room.poseHistory.get(c.id);
  const oldestPose = poses?.slots[poses.start];
  const newestPose = poses?.slots[(poses.start + poses.length - 1) % poses.capacity];
  ok(poses && poses.capacity === 32 && poses.length > 0 && poses.length <= poses.capacity
    && Number.isFinite(oldestPose?.t) && Number.isFinite(newestPose?.t) && oldestPose.t <= newestPose.t,
  'server keeps a fixed-capacity articulated pose history per client');
  sendTicks(owner, walk(SWAP_SETTLE_TICKS, { slot: 2 }));
  runSteps(SWAP_SETTLE_TICKS);
  sendTicks(owner, walk(1, { slot: 2, reload: true }));
  runSteps(1);
  ok(c.action === BASE_GAME_WEAPON_ACTION.idle, 'no reload on a slot that holds a knife');
}
service.handle(owner, { type: 'base:input', protocol: 1, ticks: [t(consumed + 1, { moveX: -1 })] });
ok(ownerClient.queue.length === queueBefore, 'wrong protocol input is ignored');
ok(service.handle(owner, { type: 'base:set_position', protocol: P, position: [0, 50, 0] }) === false
  && ownerClient.controller.getPosition()[1] < 1, 'direct transform injection is not a message');
sendTicks(guest, [t(consumed + 1, { moveX: -1 })]);
ok(ownerClient.queue.length === queueBefore, 'another socket cannot drive this player');
const rejectedBefore = ownerClient.rejectedInputs;
for (let index = 0; index < 40; index++) sendTicks(owner, [t(consumed + 1 + index)]);
ok(ownerClient.rejectedInputs > rejectedBefore, 'over-rate packets are dropped by the token bucket');
clock += 2000;
ownerClient.queue.length = 0;
nextTick = ownerClient.lastConsumedTick + 1;
sendTicks(owner, [t(nextTick + 3)]);
ok(ownerClient.queue.length === 0, 'a tick that skips ahead of the expected one is not queued');
clock += 2000;
service.handle(owner, { type: 'base:resync', protocol: P });
ok(ownerClient.awaitingResync, 'client-requested resync is honored');
sendTicks(owner, [t(nextTick + 3)]);
ok(ownerClient.lastConsumedTick === nextTick + 2 && ownerClient.queue.length === 1, 'after a resync the server adopts the client numbering');
ownerClient.queue.length = 0;
nextTick = ownerClient.lastConsumedTick + 1;
clock += 2000;

// Resends are harmless: duplicated ticks are not queued twice.
const batch = walk(10);
sendTicks(owner, batch);
sendTicks(owner, batch);
ok(ownerClient.queue.length === 10, 'retransmitted ticks are deduplicated');
runSteps(10);

// Jump edge: the tick that carries it jumps once; a repeated send cannot jump again.
const jumpBatch = [t(nextTick++, { jump: true }), ...walk(239)];
sendTicks(owner, jumpBatch);
let peaks = 0, wasAir = false;
for (let index = 0; index < 240; index++) {
  runSteps(1);
  const air = !ownerClient.controller.grounded;
  if (wasAir && !air) peaks++;
  wasAir = air;
}
ok(peaks === 1, 'a jump tick produces exactly one jump');

// Deep queue drains two ticks per step; stalled queue freezes then resyncs.
sendTicks(owner, walk(40));
runSteps(10);
ok(ownerClient.queue.length < 30, 'a deep queue drains faster than one tick per step');
ownerClient.queue.length = 0;
const frozen = ownerClient.controller.getPosition();
runSteps(30);
ok(ownerClient.controller.getPosition().every((value, axis) => value === frozen[axis]) && !ownerClient.awaitingResync,
  'a short stall freezes the player without a resync');
runSteps(60);
ok(ownerClient.awaitingResync, 'a long stall runs neutral steps and requests a resync');

// Respawn is a request: the server resets to its own spawn and resyncs the client's ticks.
clock += 2000;
const revBefore = ownerClient.spawnRevision;
service.handle(owner, { type: 'base:respawn', protocol: P });
ok(ownerClient.spawnRevision === revBefore + 1 && ownerClient.awaitingResync
  && near(ownerClient.controller.getPosition()[1], serverLab.layout.spawn[1], 1e-9), 'respawn resets the server player and requests a resync');

// Kill plane: the server respawns anyone below the layout limit.
ownerClient.controller.applyState({ position: [0, serverLab.layout.killPlaneY - 1, 0], velocity: [0, -5, 0], grounded: false });
const revKill = ownerClient.spawnRevision;
runSteps(1);
ok(ownerClient.spawnRevision === revKill + 1 && near(ownerClient.controller.getPosition()[1], serverLab.layout.spawn[1], 1e-9),
  'falling below the kill plane respawns on the server');

// Disconnected players receive neutral input.
owner.readyState = 3;
service.disconnect(owner);
const xBefore = ownerClient.controller.getPosition()[0];
runSteps(120);
ok(near(ownerClient.controller.getPosition()[0], xBefore, 1e-9) && ownerClient.awaitingResync, 'disconnected player runs neutral steps and awaits resync');

// ---- prediction and reconciliation: lockstep ticks reproduce the server exactly ----
const localQuery = createWorldQueryService();
const localLab = createTraversalLabWorldQuery(localQuery);
const localController = createBaseGamePlayerController({ worldQuery: localQuery, spawn: localLab.layout.spawn });
const sentTicks = [];
const prediction = createBaseGamePrediction({ controller: localController, onTick: entry => sentTicks.push({ ...entry }) });
const authority = createBaseGamePlayerController({ worldQuery: serverQuery, spawn: serverLab.layout.spawn });
const forward = { moveX: 0, moveZ: 1, yaw: 0.3, pitch: 0, sprint: false };
let frames = 0;
const stepAuthorityThrough = tick => {
  while (authority.consumed < tick) {
    const entry = sentTicks[authority.consumed];
    authority.stepOnce({ moveX: entry.moveX, moveZ: entry.moveZ, yaw: entry.yaw, sprint: entry.sprint }, entry.jump);
    authority.consumed = entry.tick;
  }
};
authority.consumed = 0;
for (; frames < 60; frames++) prediction.advance(1 / 60, index => ({ ...forward, jump: frames === 10 && index === 0 }));
ok(prediction.tick === 120 && sentTicks.length === 120, 'prediction numbers one tick per fixed step');
stepAuthorityThrough(60);
let result = prediction.reconcile({ ...authority.captureState(), yaw: 0, pitch: 0, lastProcessedTick: 60, queueDepth: 3, spawnRevision: 1 });
ok(result.applied && result.hard, 'first snapshot with a new spawn revision hard-snaps');
ok(localController.getPosition().every((value, axis) => near(value, authority.getPosition()[axis], 1e-12)), 'hard snap installs the authoritative position');
// After the snap the local history is empty; continue ticking and have the server consume the same ticks.
for (; frames < 120; frames++) prediction.advance(1 / 60, () => forward);
stepAuthorityThrough(180);
// The server has consumed tick 180, but local history starts after tick 120 (hard snap cleared it),
// so install the server's tick-180 state and replay ticks 181..240 exactly.
result = prediction.reconcile({ ...authority.captureState(), yaw: 0, pitch: 0, lastProcessedTick: 180, queueDepth: 3, spawnRevision: 1 });
ok(result.applied && !result.hard && result.replayed === 60, 'replay covers exactly the unacknowledged ticks');
stepAuthorityThrough(240);
const serverPos = authority.getPosition();
const localPos = localController.getPosition();
ok(localPos.every((value, axis) => value === serverPos[axis]), 'lockstep replay reproduces the server position bit-for-bit');
result = prediction.reconcile({ ...authority.captureState(), yaw: 0, pitch: 0, lastProcessedTick: 240, queueDepth: 3, spawnRevision: 1 });
ok(result.reason === 'in-tolerance' && result.error === 0, 'an exact snapshot needs no correction at all');
for (; frames < 130; frames++) prediction.advance(1 / 60, () => forward);
const farState = { ...authority.captureState(), yaw: 0, pitch: 0, lastProcessedTick: 240, queueDepth: 3, spawnRevision: 1 };
farState.position = [farState.position[0] + 10, farState.position[1], farState.position[2]];
result = prediction.reconcile(farState);
ok(result.hard && result.replayed === 20 && prediction.historyLength === 20, 'a large-error hard snap still replays unacknowledged ticks');
ok(prediction.adjustPacing(0) > 1 && prediction.adjustPacing(20) < 1 && prediction.adjustPacing(3) === 1, 'pacing speeds up when the server starves and slows when its queue is deep');
ok(prediction.reconcile({ position: [1, NaN, 1] }).applied === false, 'invalid authoritative state is ignored');

// ---- remote track ----
const track = createRemoteTrack();
track.push(1000, { position: [0, 0, 0], velocity: [1, 0, 0], yaw: 0, pitch: 0, grounded: true, spawnRevision: 1 });
track.push(1050, { position: [1, 0, 0], velocity: [1, 0, 0], yaw: 1, pitch: 0, grounded: true, spawnRevision: 1 });
let sample = track.sample(1025);
ok(sample.mode === 'interpolate' && near(sample.position[0], 0.5) && near(sample.yaw, 0.5), 'track interpolates between samples');
sample = track.sample(1150);
ok(sample.mode === 'extrapolate' && near(sample.position[0], 1.1), 'track extrapolates using velocity');
sample = track.sample(2000);
ok(sample.mode === 'hold' && near(sample.position[0], 1.25), 'extrapolation caps at 250 ms then holds');
ok(track.push(1040, { position: [9, 9, 9], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, spawnRevision: 1 }) === false, 'out-of-order samples are dropped');
track.push(1100, { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, spawnRevision: 2 });
ok(track.sampleCount === 1, 'spawn revision change clears interpolation history');

// ---- remote player manager with a shifted render origin ----
const remoteScene = new THREE.Scene();
const coords = createWorldCoordinateSpace({ renderOrigin: [1000, 0, 0] });
const remotes = createBaseGameRemotePlayers({ scene: remoteScene, worldCoordinates: coords });
const roster = (serverTime, x) => ({
  serverTime,
  players: [
    { id: 'me', position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, spawnRevision: 1 },
    { id: 'them', position: [x, 5, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, spawnRevision: 1 },
    { id: 'below', position: [x, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, spawnRevision: 1 },
  ],
});
remotes.ingestSnapshot(roster(5000, 1010), 'me', 100);
remotes.ingestSnapshot(roster(5050, 1010), 'me', 150);
remotes.update(250, { interpolationDelayMs: 100 });
ok(remotes.count === 2, 'local player is excluded from remote capsules');
const them = remotes.players.get('them').mesh;
const below = remotes.players.get('below').mesh;
ok(near(them.position.x, 10) && near(them.position.y, 5.9) && near(below.position.y, 0.9),
  'remote capsules are render-local and keep distinct Y at one X/Z');
remotes.ingestSnapshot({ serverTime: 5100, players: roster(5100, 1010).players.slice(0, 2) }, 'me', 200);
ok(remotes.count === 1 && !below.visible, 'players leaving the roster release their pooled capsule');

// ---- session input sending ----
class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.(); }
}
let fakeNow = 0;
const timers = [];
const pendingSession = connectBaseGameSession({
  mode: 'join', roomCode: 'net', relayUrl: 'ws://test', WebSocketImpl: FakeWebSocket,
  now: () => fakeNow,
  setTimer: (fn, ms) => { timers.push({ fn, at: fakeNow + ms }); return timers.length; },
  clearTimer: () => {},
});
const runTimers = () => { const due = timers.filter(x => x.at <= fakeNow); for (const x of due) timers.splice(timers.indexOf(x), 1); for (const x of due) x.fn(); };
const ws = FakeWebSocket.instances.at(-1);
ws.open();
ws.receive({ type: 'base:joined', protocol: P, room: 'NET', clientId: 'c1', resumeToken: 'r', owner: false });
ws.receive({ type: 'base:snapshot', protocol: P, room: 'NET', ownerId: 'x', serverTime: 450, tick: 0, worldReady: false, world: {}, players: [] });
let settled = false;
pendingSession.then(() => { settled = true; });
await new Promise(resolve => setTimeout(resolve, 0));
ok(settled === false, 'handshake waits for an authoritative world');
ws.receive({ type: 'base:snapshot', protocol: P, room: 'NET', ownerId: 'x', serverTime: 500, tick: 3, worldReady: true, world: {}, players: [{ id: 'c1', position: [0, 0, 0], lastProcessedTick: 0 }] });
const session = await pendingSession;
const inputPackets = () => ws.sent.filter(packet => packet.type === 'base:input');
ok(session.queueTick(t(1, { jump: true })) && session.queueTick(t(2)), 'ticks queue in order');
ok(session.queueTick(t(2)) === false && session.queueTick(t(4)) === false, 'repeated or gapped tick numbers are refused');
runTimers();
ok(inputPackets().length === 1 && inputPackets()[0].ticks.length === 2 && inputPackets()[0].ticks[0].jump === true, 'first packet flushes immediately with both ticks');
session.queueTick(t(3));
fakeNow += 5;
runTimers();
ok(inputPackets().length === 1, 'a new tick inside the 30 Hz window waits');
fakeNow += 40;
runTimers();
ok(inputPackets().length === 2 && inputPackets()[1].ticks.length === 3, 'unacknowledged ticks are resent together after the window');
ws.receive({ type: 'base:snapshot', protocol: P, room: 'NET', ownerId: 'x', serverTime: 600, tick: 9, worldReady: true, world: {}, players: [{ id: 'c1', position: [0, 0, 0], lastProcessedTick: 2 }] });
ok(session.pendingTickCount === 1 && session.stats.lastAckedTick === 2, 'acknowledged ticks leave the resend queue');
for (let n = 4; n <= 300; n++) session.queueTick(t(n));
ok(session.stats.resyncs === 1 && ws.sent.some(packet => packet.type === 'base:resync') && session.pendingTickCount < 256,
  'an unacknowledged backlog triggers an explicit resync instead of dropping ticks');
ok(session.stats.serverTick === 9, 'session tracks the server tick');
session.destroy();

// ---- HTML integration markers ----
const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
for (const marker of [
  'createBaseGamePrediction',
  'createBaseGameRemotePlayers',
  'remotePlayersEnabled',
  'networkDebugVisible',
  'interpolationDelayMs',
  'prediction.reconcile(',
  'remotePlayers.ingestSnapshot(',
  'queueTick(entry)',
  'requestResync()',
  'requestRespawn()',
  'flushInput()',
]) ok(html.includes(marker), `base-game.html integrates ${marker}`);

browserLab.dispose(); serverLab.dispose(); localLab.dispose(); remotes.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
