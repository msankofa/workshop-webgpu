// Phase 5 checks: room-owned terrain in the Base Game room service.
// Run: node test-base-game-rooms-terrain.mjs
import { BASE_GAME_PROTOCOL_VERSION, sanitizeBaseGameTerrainConfig, describeBaseGameTerrainConfig } from './base-game-protocol.mjs';
import { createBaseGameRoomService } from './server/base-game-rooms.js';
import { connectBaseGameSession } from './base-game-session.mjs';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { v5Descriptor } from './terrain-source-v5.js';
import { createSource } from './terrain-source.js';
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { defaultStack, makeLayer } from './terrain-stack.js';
import { normalizeProject, migrateProjectToUnbounded, PROJECT_APP } from './terrain-project-v5.js';
import { createWorldQueryService } from './world-query.js';
import { createHeightfieldWorldQueryProvider } from './world-query-heightfield-provider.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const P = BASE_GAME_PROTOCOL_VERSION;
const tick = () => new Promise(r => setTimeout(r, 0));

class FakeSocket {
  constructor() { this.readyState = 1; this.sent = []; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  last(type) { for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].type === type) return this.sent[i]; return null; }
}
function v5Project(seed) {
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 30, scale: 220 } }));
  return migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, name: 'Room Hills', cfg: { ...DEFAULT_CONFIG, seed }, density: { ...DENSITY_DEFAULT_CONFIG }, stack, paint: null, imports: {} }).project);
}
const analytic = analyticDescriptor({ key: 'base-game-analytic', sourceVersion: '1' });

console.log('\n[1] terrain config sanitizer');
{
  ok(sanitizeBaseGameTerrainConfig(undefined).config.kind === 'traversalLab', 'absent -> Traversal Lab');
  ok(sanitizeBaseGameTerrainConfig({ kind: 'traversalLab' }).config.worldVersion === 'traversal-lab', 'lab config');
  const a = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(analytic)) });
  ok(!a.error && a.config.kind === 'terrain' && a.config.worldVersion.startsWith('terrain:analytic:base-game-analytic@1'), `analytic accepted: ${a.config.worldVersion}`);
  const v = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(v5Descriptor(v5Project(7)))) });
  ok(!v.error && v.config.projectHash && v.config.worldVersion.includes('Room-Hills@'), `v5 accepted: ${v.config.worldVersion}`);
  const tampered = JSON.parse(JSON.stringify(v5Descriptor(v5Project(7)))); tampered.config.project.cfg.seed = 8;
  ok(sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: tampered }).error?.includes('hash'), 'project edited after hashing is rejected');
  const bounded = JSON.parse(JSON.stringify(v5Descriptor(v5Project(7)))); bounded.config.project.algorithmVersion = 'v5-bounded-1'; delete bounded.config.projectHash;
  ok(sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: bounded }).error?.includes('not streamable'), 'bounded project rejected');
  ok(sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: analytic, volumetric: true }).error?.includes('volumetric'), 'volumetric rejected');
  ok(sanitizeBaseGameTerrainConfig({ kind: 'lava' }).error, 'unknown kind rejected');
  ok(sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: { kind: 'analytic', key: 'x' } }).error?.includes('bad terrain descriptor'), 'malformed descriptor rejected');
  ok(sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: { ...analytic, kind: 'finite-map' } }).error?.includes('not available'), 'finite-map not available yet');
  const d = describeBaseGameTerrainConfig(v.config);
  ok(d.kind === 'terrain' && d.projectHash === v.config.projectHash && !('descriptor' in d), 'snapshot description carries identity only');
}

console.log('\n[2] rooms own their worlds; different sources do not share');
{
  const service = createBaseGameRoomService({ now: () => 1000 });
  const wsA = new FakeSocket(), wsB = new FakeSocket(), wsLab = new FakeSocket();
  service.handle(wsA, { type: 'base:create', protocol: P, room: 'ANA', world: {}, terrain: { kind: 'terrain', descriptor: analytic } });
  service.handle(wsB, { type: 'base:create', protocol: P, room: 'VFIVE', world: {}, terrain: { kind: 'terrain', descriptor: v5Descriptor(v5Project(11)) } });
  service.handle(wsLab, { type: 'base:create', protocol: P, room: 'LAB', world: {} });
  ok(wsA.last('base:joined').terrain.kind === 'terrain' && wsA.last('base:joined').terrain.descriptor.key === 'base-game-analytic', 'joined carries the full terrain config');
  ok(wsA.last('base:snapshot').worldReady === false, 'not ready until the world is built');
  await service.ensureWorld();
  service.broadcastSnapshots();
  const sA = wsA.last('base:snapshot'), sB = wsB.last('base:snapshot'), sL = wsLab.last('base:snapshot');
  ok(sA.worldReady && sB.worldReady && sL.worldReady, 'all three rooms ready');
  ok(sA.worldVersion !== sB.worldVersion && sB.worldVersion !== sL.worldVersion && sL.worldVersion.startsWith('traversal-lab'), `distinct world versions: ${sA.worldVersion} | ${sB.worldVersion} | ${sL.worldVersion}`);
  ok(sA.terrain.kind === 'terrain' && !sA.terrain.descriptor, 'snapshot terrain is identity only');
  const srcA = createSource(analytic), srcB = createSource(v5Descriptor(v5Project(11)));
  ok(Math.abs(sA.players[0].position[1] - (srcA.heightAt(0, 0) + 1.5)) < 1e-6 && Math.abs(sB.players[0].position[1] - (srcB.heightAt(0, 0) + 1.5)) < 1e-6, 'each room spawns on its own ground');
  ok(service.worldCount === 3, 'three world instances');
  const wsA2 = new FakeSocket();
  service.handle(wsA2, { type: 'base:create', protocol: P, room: 'ANA2', world: {}, terrain: { kind: 'terrain', descriptor: analytic } });
  await service.ensureWorld();
  ok(service.worldCount === 3 && service.rooms.get('ANA2').sim === service.rooms.get('ANA').sim, 'same descriptor shares one immutable world');
  const wsBad = new FakeSocket();
  service.handle(wsBad, { type: 'base:create', protocol: P, room: 'BAD', world: {}, terrain: { kind: 'terrain', descriptor: analytic, volumetric: true } });
  ok(wsBad.last('base:error')?.code === 'invalid_terrain' && !service.rooms.has('BAD'), 'invalid terrain fails the create deterministically');
}

console.log('\n[3] server and predicted client agree across a tile seam and a slope');
{
  const descriptor = v5Descriptor(v5Project(23));
  let clock = 1000;
  const service = createBaseGameRoomService({ now: () => clock });
  const ws = new FakeSocket();
  service.handle(ws, { type: 'base:create', protocol: P, room: 'WALK', world: {}, terrain: { kind: 'terrain', descriptor } });
  await service.ensureWorld();
  const client = service.rooms.get('WALK').clients.values().next().value;
  // the client predicts with the same source built from the joined config
  const joined = ws.last('base:joined');
  const local = createWorldQueryService();
  local.registerProvider(createHeightfieldWorldQueryProvider(createSource(joined.terrain.descriptor), { id: 'terrain' }));
  const predicted = createBaseGamePlayerController({ worldQuery: local, spawn: service.rooms.get('WALK').sim.spawn, config: { fixedHz: 120 } });
  // walk straight along +x for 8 s at 120 Hz: crosses the x=30 seam and whatever slopes come
  const inputs = [];
  for (let k = 1; k <= 960; k++) inputs.push({ tick: k, moveX: 1, moveZ: 0, yaw: 0, pitch: 0, sprint: true, jump: k % 200 === 0 });
  for (const inp of inputs) predicted.stepOnce({ moveX: inp.moveX, moveZ: inp.moveZ, yaw: inp.yaw, sprint: inp.sprint }, inp.jump);
  // drive the server like a live client: a 32-tick packet, then 32 simulation steps
  for (let i = 0; i < inputs.length; i += 32) {
    clock += 40;
    service.handle(ws, { type: 'base:input', protocol: P, clientTime: clock, ticks: inputs.slice(i, i + 32) });
    for (let k = 0; k < 32; k++) { clock += 1000 / 120; service.step(clock); }
  }
  const sp = client.controller.getPosition(), cp = predicted.getPosition();
  const dist = Math.hypot(sp[0] - cp[0], sp[1] - cp[1], sp[2] - cp[2]);
  ok(client.lastConsumedTick === 960, `server consumed all ${client.lastConsumedTick} ticks`);
  ok(sp[0] > 40, `travelled ${sp[0].toFixed(1)} m (past the 30 m seam)`);
  ok(dist < 1e-6, `server and predicted client agree to ${dist.toExponential(2)} m`);
}

console.log('\n[4] reconnect restores the same terrain; kill plane follows the surface');
{
  const service = createBaseGameRoomService({ now: () => 1000 });
  const ws = new FakeSocket();
  const descriptor = v5Descriptor(v5Project(5));
  service.handle(ws, { type: 'base:create', protocol: P, room: 'RES', world: {}, terrain: { kind: 'terrain', descriptor } });
  await service.ensureWorld();
  const token = ws.last('base:joined').resumeToken;
  const version = ws.last('base:joined').terrain.worldVersion;
  ws.close();
  service.disconnect(ws);
  const ws2 = new FakeSocket();
  service.handle(ws2, { type: 'base:resume', protocol: P, resumeToken: token });
  const j2 = ws2.last('base:joined');
  ok(j2 && j2.terrain.worldVersion === version && j2.terrain.descriptor.config.projectHash === descriptor.config.projectHash, 'resume returns the identical terrain config');
  const client = service.rooms.get('RES').clients.values().next().value;
  const src = createSource(descriptor);
  client.controller.reset([5, src.heightAt(5, 5) - 200, 5]);
  service.step(1000 + 1000 / 120 + 1);
  ok(client.controller.getPosition()[1] > src.heightAt(0, 0), 'fell 200 m under the surface -> respawned on the room spawn');
  ok(client.spawnRevision >= 2, 'respawn bumped the spawn revision');
}

console.log('\n[5] client session sends terrain on create and exposes the room config');
{
  let sent = [];
  class WS {
    static OPEN = 1;
    constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 0); }
    send(text) { sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
  }
  const pending = connectBaseGameSession({ mode: 'create', roomCode: 'sess', world: {}, terrain: { kind: 'terrain', descriptor: analytic }, WebSocketImpl: WS, handshakeTimeoutMs: 1000 });
  await tick(); await tick();
  const create = sent.find(m => m.type === 'base:create');
  ok(create && create.terrain.kind === 'terrain' && create.terrain.descriptor.key === 'base-game-analytic', 'create message carries the terrain config');
  pending.catch(() => {});
  ok(true, '(handshake completion is covered by test-base-game-session.mjs)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
