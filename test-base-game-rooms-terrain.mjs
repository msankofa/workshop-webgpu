// Phase 5 checks: room-owned terrain in the Base Game room service.
// Run: node test-base-game-rooms-terrain.mjs
import { BASE_GAME_PROTOCOL_VERSION, sanitizeBaseGameTerrainConfig, describeBaseGameTerrainConfig, withTerrainProject, terrainConfigNeedsProject, terrainConfigProjectHash } from './base-game-protocol.mjs';
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
// Wire configs carry v5 bodies by hash; rebuild the full config the way a client does (store fetch).
const fullConfig = (service, wire) => terrainConfigNeedsProject(wire) ? withTerrainProject(wire, service.terrainStore.get(terrainConfigProjectHash(wire))) : wire;

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
  ok(sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: analytic, volumetric: true }).error?.includes('volumetric'), 'volumetric on the analytic source rejected (no density)');
  const vol = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(v5Descriptor(v5Project(7)))), volumetric: true });
  ok(!vol.error && vol.config.volumetric === true && vol.config.worldVersion.endsWith(':volume') && vol.config.worldVersion !== v.config.worldVersion, 'volumetric v5 accepted with its own world version');
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
  service.handle(ws, { type: 'base:create', protocol: P, room: 'WALK', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor } });
  await service.ensureWorld();
  const client = service.rooms.get('WALK').clients.values().next().value;
  // the client predicts with the same source built from the joined config
  const joined = ws.last('base:joined');
  const local = createWorldQueryService();
  local.registerProvider(createHeightfieldWorldQueryProvider(createSource(fullConfig(service, joined.terrain).descriptor), { id: 'terrain' }));
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
  ok(j2 && j2.terrain.worldVersion === version && j2.terrain.descriptor.config.projectHash === descriptor.config.projectHash && !j2.terrain.descriptor.config.project, 'resume returns the identical terrain config (body by hash)');
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

  // owner setTerrain: sent as base:set_terrain, resolved by the base:terrain echo, onTerrain fired
  let sock = null; const got = [];
  class WS2 extends WS { constructor() { super(); sock = this; } }
  const joinedPromise = connectBaseGameSession({ mode: 'create', roomCode: 'own', world: {}, WebSocketImpl: WS2, handshakeTimeoutMs: 1000, onTerrain: t => got.push(t) });
  await tick(); await tick();
  sock.onmessage({ data: JSON.stringify({ type: 'base:joined', protocol: P, room: 'OWN', clientId: 'c1', resumeToken: 't', owner: true, simHz: 120, playerCap: 8, terrain: { kind: 'traversalLab', worldVersion: 'traversal-lab' } }) });
  sock.onmessage({ data: JSON.stringify({ type: 'base:snapshot', protocol: P, room: 'OWN', tick: 1, revision: 1, ownerId: 'c1', worldReady: true, worldVersion: 'traversal-lab', players: [], world: {} }) });
  const session = await joinedPromise;
  const req = session.setTerrain({ kind: 'terrain', descriptor: analytic });
  await tick();
  const msg = sent.find(m => m.type === 'base:set_terrain');
  ok(msg && msg.terrain.descriptor.key === 'base-game-analytic', 'owner sends base:set_terrain');
  const echo = { kind: 'terrain', worldVersion: 'terrain:analytic:base-game-analytic@1:x', descriptor: analytic, volumetric: false };
  sock.onmessage({ data: JSON.stringify({ type: 'base:terrain', protocol: P, room: 'OWN', revision: 2, terrain: echo }) });
  const resolved = await req;
  ok(resolved.worldVersion === echo.worldVersion && session.terrain.worldVersion === echo.worldVersion && got.length === 1, 'echo resolves the request, updates session.terrain and fires onTerrain');
  const bad = session.setTerrain({ kind: 'terrain', descriptor: analytic, volumetric: true });
  await tick();
  sock.onmessage({ data: JSON.stringify({ type: 'base:error', protocol: P, code: 'invalid_terrain', message: 'no' }) });
  ok(await bad.then(() => false, e => e.code === 'invalid_terrain'), 'invalid_terrain rejects the request');
  session.close?.();
}

console.log('\n[6] the owner switches the world; guests follow and respawn; guests cannot');
{
  let clock = 1000;
  const service = createBaseGameRoomService({ now: () => clock });
  const owner = new FakeSocket(), guest = new FakeSocket();
  service.handle(owner, { type: 'base:create', protocol: P, room: 'SWAP', world: {}, terrain: { kind: 'terrain', descriptor: analytic } });
  service.handle(guest, { type: 'base:join', protocol: P, room: 'SWAP' });
  await service.ensureWorld();
  const room = service.rooms.get('SWAP');
  const v1 = room.terrain.worldVersion;
  // guest asks: refused, nothing changes
  service.handle(guest, { type: 'base:set_terrain', protocol: P, terrain: { kind: 'traversalLab' } });
  await tick();
  ok(guest.last('base:error')?.code === 'not_owner' && room.terrain.worldVersion === v1, 'guest set_terrain refused');
  // owner switches to a v5 project: both clients get base:terrain with the full config and respawn on it
  const descriptor = v5Descriptor(v5Project(31));
  const revBefore = room.revision;
  const [gc] = [...room.clients.values()].filter(c => c.ws === guest);
  gc.controller.reset([40, 5, 40]);
  service.handle(owner, { type: 'base:set_terrain', protocol: P, terrain: { kind: 'terrain', descriptor } });
  for (let i = 0; i < 20 && room.terrain.worldVersion === v1; i++) await tick();
  await service.ensureWorld();
  const tp = guest.last('base:terrain');
  ok(tp && tp.terrain.kind === 'terrain' && tp.terrain.descriptor.config.projectHash === descriptor.config.projectHash && tp.terrain.worldVersion === room.terrain.worldVersion, 'guest receives the full new config');
  ok(owner.last('base:terrain')?.terrain.worldVersion === room.terrain.worldVersion, 'owner receives the same echo');
  ok(room.revision === revBefore + 1, 'room revision bumped');
  const src = createSource(descriptor);
  const positions = [...room.clients.values()].map(c => c.controller.getPosition());
  ok(positions.every(p => Math.abs(p[1] - (Math.max(src.heightAt(0, 0), descriptor.seaLevel) + 1.5)) < 1e-6 && p[0] === 0 && p[2] === 0), 'everyone respawned on the new ground (above the water)');
  ok([...room.clients.values()].every(c => c.spawnRevision >= 2 && c.awaitingResync), 'spawn revision bumped and resync requested for all');
  ok(guest.last('base:snapshot').worldVersion === room.terrain.worldVersion && guest.last('base:snapshot').worldReady, 'snapshot reports the new world');
  // same world again: just an echo, no rebuild
  const before = service.worldCount;
  service.handle(owner, { type: 'base:set_terrain', protocol: P, terrain: { kind: 'terrain', descriptor } });
  ok(service.worldCount === before && owner.last('base:terrain').terrain.worldVersion === room.terrain.worldVersion, 'identical config is an echo');
  // invalid terrain: error, world untouched
  service.handle(owner, { type: 'base:set_terrain', protocol: P, terrain: { kind: 'terrain', descriptor: analytic, volumetric: true } });
  await tick();
  ok(owner.last('base:error')?.code === 'invalid_terrain' && room.terrain.descriptor.kind === 'v5-recipe', 'invalid switch refused, world untouched');
  // back to the lab (cached from warm? no — built on demand here)
  service.handle(owner, { type: 'base:set_terrain', protocol: P, terrain: { kind: 'traversalLab' } });
  for (let i = 0; i < 200 && room.terrain.kind !== 'traversalLab'; i++) await tick();
  await service.ensureWorld();
  ok(room.terrain.kind === 'traversalLab' && room.sim?.worldVersion.startsWith('traversal-lab'), 'switched back to the Traversal Lab');
}

console.log('\n[7] volumetric room: server builds chunk collision around players; predicted client agrees');
{
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 25, scale: 260, seedOffset: 2 } }));
  const project = migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, name: 'Caves', cfg: { ...DEFAULT_CONFIG, seed: 4242 }, density: { ...DENSITY_DEFAULT_CONFIG, cave_strength: 60, cave_threshold: 0.45, cave_period: 70, y_min: -60, y_max: 120 }, stack, paint: null, imports: {} }).project);
  const descriptor = v5Descriptor(project);
  let clock = 1000;
  const service = createBaseGameRoomService({ now: () => clock });
  const ws = new FakeSocket();
  service.handle(ws, { type: 'base:create', protocol: P, room: 'CAVE', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor, volumetric: true } });
  await service.ensureWorld();
  const room = service.rooms.get('CAVE');
  const sim = room.sim;
  ok(room.terrain.volumetric === true && sim.volume && ws.last('base:joined').terrain.volumetric === true, 'volumetric room accepted; joined carries the flag');
  const src = createSource(descriptor);
  ok(Math.abs(sim.spawn[1] - (Math.max(src.surfaceYAt(0, 0), descriptor.seaLevel) + 1.5)) < 1e-6, 'spawn sits on the density surface (or the water), not the heightfield');
  const client = room.clients.values().next().value;
  clock += 1000 / 120; service.step(clock);
  ok(sim.covers(0, 0) && sim.volume.chunkCount >= 4, `first step built collision under the player first (${sim.volume.chunkCount} chunks, budget 4 per step)`);
  clock += 1000 / 120; service.step(clock); clock += 1000 / 120; service.step(clock);
  ok(sim.volume.chunkCount >= 9, `the 3x3 ring completes over the next steps (${sim.volume.chunkCount} chunks)`);
  // client prediction against locally streamed volume chunks (same tiles, same provider)
  const { createVolumeCollision } = await import('./terrain-volume-collision.js');
  const local = createWorldQueryService();
  const localVolume = createVolumeCollision(createSource(fullConfig(service, ws.last('base:joined').terrain).descriptor), { worldQuery: local, coverRadius: 2, maxBuildsPerCall: 25 });
  const predicted = createBaseGamePlayerController({ worldQuery: local, spawn: sim.spawn, config: { fixedHz: 120 } });
  const inputs = [];
  for (let k = 1; k <= 720; k++) inputs.push({ tick: k, moveX: 1, moveZ: 0, yaw: 0, pitch: 0, sprint: true, jump: k % 150 === 0 });
  for (const inp of inputs) { localVolume.ensure([predicted.getPosition()]); predicted.stepOnce({ moveX: inp.moveX, moveZ: inp.moveZ, yaw: inp.yaw, sprint: inp.sprint }, inp.jump); }
  for (let i = 0; i < inputs.length; i += 32) {
    clock += 40;
    service.handle(ws, { type: 'base:input', protocol: P, clientTime: clock, ticks: inputs.slice(i, i + 32) });
    for (let k = 0; k < 32; k++) { clock += 1000 / 120; service.step(clock); }
  }
  const sp = client.controller.getPosition(), cp = predicted.getPosition();
  const dist = Math.hypot(sp[0] - cp[0], sp[1] - cp[1], sp[2] - cp[2]);
  const supportHit = sim.worldQuery.raycast({ origin: [sp[0], sp[1] + 2, sp[2]], direction: [0, -1, 0], maxDistance: 5 });
  const supportDegrees = supportHit ? Math.acos(Math.max(-1, Math.min(1, supportHit.normal[1]))) * 180 / Math.PI : Infinity;
  const supportWalkable = supportDegrees <= client.controller.config.slopeLimitDegrees + 1e-6;
  const supportOffset = supportHit && supportHit.normal[1] > 0
    ? client.controller.config.radius * (1 / supportHit.normal[1] - 1)
    : 0;
  const supportGap = supportHit ? sp[1] - supportHit.point[1] : Infinity;
  ok(client.lastConsumedTick === 720, `server consumed all ${client.lastConsumedTick} ticks`);
  ok(sp[0] > 30, `travelled ${sp[0].toFixed(1)} m across a chunk seam on the volume`);
  ok(!!supportHit && Math.abs(supportGap - supportOffset) < 0.5 && (client.controller.grounded || !supportWalkable),
    `server player remains on 3D volume support (grounded ${client.controller.grounded}, support ${supportDegrees.toFixed(1)} deg, gap ${supportGap.toFixed(2)} m)`);
  ok(dist < 1e-6, `server and predicted client agree to ${dist.toExponential(2)} m`);
  ok(sim.volume.chunkCount <= 49, `collision footprint stays bounded (${sim.volume.chunkCount} chunks, ${sim.volume.stats.buildMsTotal.toFixed(0)} ms of builds)`);
  const deep = sim.killPlaneYAt(sp[0], sp[2]);
  ok(deep < project.density.y_min, 'kill plane sits under the density floor');
}

console.log('\n[8] asset keys: projects travel once; rooms and packets carry the hash');
{
  const { createTerrainStore } = await import('./server/terrain-store.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcw-terrain-store-'));
  const store = createTerrainStore({ dir });
  const service = createBaseGameRoomService({ now: () => 1000, terrainStore: store });
  const project = v5Project(77);
  const descriptor = v5Descriptor(project);
  const ws = new FakeSocket();
  service.handle(ws, { type: 'base:terrain_put', protocol: P, project });
  const ref = ws.last('base:terrain_ref');
  ok(ref && ref.projectHash === descriptor.config.projectHash, 'terrain_put returns the project hash');
  service.handle(ws, { type: 'base:terrain_put', protocol: P, project });
  ok(store.size === 1, 'publishing again is idempotent');
  service.handle(ws, { type: 'base:create', protocol: P, room: 'KEY', world: {}, terrain: { kind: 'terrain', descriptor: { ...descriptor, config: { projectHash: ref.projectHash } } } });
  const joined = ws.last('base:joined');
  ok(joined && joined.terrain.projectHash === ref.projectHash && !joined.terrain.descriptor.config.project, 'room created from the hash; joined carries no body');
  ok(JSON.stringify(joined).length < 2000, `joined is small (${JSON.stringify(joined).length} bytes)`);
  const guest = new FakeSocket();
  service.handle(guest, { type: 'base:join', protocol: P, room: 'KEY' });
  service.handle(guest, { type: 'base:terrain_get', protocol: P, projectHash: ref.projectHash });
  const got = guest.last('base:terrain_project');
  ok(got && v5Descriptor(got.project).config.projectHash === ref.projectHash, 'terrain_get returns a body that re-hashes identically');
  service.handle(guest, { type: 'base:terrain_get', protocol: P, projectHash: 'f'.repeat(64) });
  ok(guest.last('base:error')?.code === 'unknown_terrain', 'unknown hash -> unknown_terrain');
  const ws2 = new FakeSocket();
  service.handle(ws2, { type: 'base:create', protocol: P, room: 'NOPE', world: {}, terrain: { kind: 'terrain', descriptor: { ...descriptor, config: { projectHash: 'a'.repeat(64) } } } });
  ok(ws2.last('base:error')?.code === 'unknown_terrain' && !service.rooms.has('NOPE'), 'create by unknown hash refused');
  const ws3 = new FakeSocket();
  service.handle(ws3, { type: 'base:create', protocol: P, room: 'INL', world: {}, terrain: { kind: 'terrain', descriptor: v5Descriptor(v5Project(78)) } });
  ok(store.size === 2 && !ws3.last('base:joined').terrain.descriptor.config.project, 'inline create is stored and echoed by hash');
  await new Promise(r => setTimeout(r, 50));
  const store2 = createTerrainStore({ dir });
  ok(store2.loadFromDisk() === 2 && store2.get(ref.projectHash) !== null, 'projects reload from disk by hash');
  fs.rmSync(dir, { recursive: true, force: true });

  // end to end through the client session: create publishes first, the joiner fetches the body
  const serverSvc = createBaseGameRoomService({ now: () => 1000, terrainStore: createTerrainStore() });
  class LiveWS {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.peer = { readyState: 1, send: text => setTimeout(() => this.onmessage?.({ data: text }), 0), close() {} }; setTimeout(() => this.onopen?.(), 0); }
    send(text) { serverSvc.handle(this.peer, JSON.parse(text)); }
    close() { this.readyState = 3; }
  }
  const ownerPending = connectBaseGameSession({ mode: 'create', roomCode: 'live', world: {}, terrain: { kind: 'terrain', descriptor: v5Descriptor(v5Project(79)) }, WebSocketImpl: LiveWS, handshakeTimeoutMs: 2000 });
  for (let i = 0; i < 10; i++) await tick();
  await serverSvc.ensureWorld(); serverSvc.broadcastSnapshots();
  const ownerSession = await ownerPending;
  ok(ownerSession.terrain.descriptor.config.project && serverSvc.terrainStore.size === 1, 'create published the project and the owner holds the full config');
  const guestPending = connectBaseGameSession({ mode: 'join', roomCode: 'live', world: {}, WebSocketImpl: LiveWS, handshakeTimeoutMs: 2000 });
  for (let i = 0; i < 10; i++) await tick();
  serverSvc.broadcastSnapshots();
  const guestSession = await guestPending;
  ok(guestSession.terrain.descriptor.config.project && guestSession.terrain.worldVersion === ownerSession.terrain.worldVersion, 'guest fetched the body by hash and holds the same world');
  ownerSession.close?.(); guestSession.close?.();
}

console.log('\n[9] spawn building room: the server seats the building and a predicted client with the same collider agrees');
{
  const { createSpawnBuildingModel, createSpawnBuildingWorldQuery, SPAWN_BUILDING_PROVIDER_ID } = await import('./base-game-spawn-collider.js');
  const descriptor = v5Descriptor(v5Project(31));
  const bare = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(descriptor)) }).config;
  const withBuilding = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(descriptor)), spawnBuilding: true }).config;
  ok(withBuilding.spawnBuilding === true && bare.spawnBuilding === false, 'spawnBuilding is an explicit opt-in');
  ok(withBuilding.worldVersion !== bare.worldVersion && withBuilding.worldVersion.endsWith(':spawnbld1'), 'the building is part of the world identity');
  ok(describeBaseGameTerrainConfig(withBuilding).spawnBuilding === true, 'the description carries it');
  let clock = 1000;
  const service = createBaseGameRoomService({ now: () => clock });
  const ws = new FakeSocket();
  service.handle(ws, { type: 'base:create', protocol: P, room: 'BLDG', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor, spawnBuilding: true } });
  await service.ensureWorld();
  const room = service.rooms.get('BLDG');
  const src = createSource(descriptor);
  const model = createSpawnBuildingModel((x, z) => src.heightAt(x, z), { seaLevel: descriptor.seaLevel ?? 0 });
  ok(Math.abs(room.sim.spawn[1] - (model.spawn[1] + 1.5)) < 1e-6 && room.sim.spawn[0] === model.spawn[0] && room.sim.spawn[2] === model.spawn[2], 'the room spawns on the lobby plaza, 1.5 m up');
  const hit = room.sim.worldQuery.raycast({ origin: [model.spawn[0], model.spawn[1] + 3, model.spawn[2]], direction: [0, -1, 0], maxDistance: 20 });
  ok(hit && hit.providerId === SPAWN_BUILDING_PROVIDER_ID && Math.abs(hit.point[1] - model.spawn[1]) < 0.02, 'a ray down at the spawn lands on the building floor, not the terrain');
  // The client predicts with terrain plus the same building; walking south leaves through the pavilion door.
  const client = room.clients.values().next().value;
  const local = createWorldQueryService();
  local.registerProvider(createHeightfieldWorldQueryProvider(createSource(descriptor), { id: 'terrain' }));
  createSpawnBuildingWorldQuery(local, (x, z) => src.heightAt(x, z), { seaLevel: descriptor.seaLevel ?? 0 });
  const predicted = createBaseGamePlayerController({ worldQuery: local, spawn: room.sim.spawn, config: { fixedHz: 120 } });
  const inputs = [];
  for (let k = 1; k <= 480; k++) inputs.push({ tick: k, moveX: 0, moveZ: -1, yaw: 0, pitch: 0, sprint: true, jump: false });   // forward is -z; -1 walks south
  for (const inp of inputs) predicted.stepOnce({ moveX: inp.moveX, moveZ: inp.moveZ, yaw: inp.yaw, sprint: inp.sprint }, inp.jump);
  for (let i = 0; i < inputs.length; i += 32) {
    clock += 40;
    service.handle(ws, { type: 'base:input', protocol: P, clientTime: clock, ticks: inputs.slice(i, i + 32) });
    for (let k = 0; k < 32; k++) { clock += 1000 / 120; service.step(clock); }
  }
  const sp = client.controller.getPosition(), cp = predicted.getPosition();
  const dist = Math.hypot(sp[0] - cp[0], sp[1] - cp[1], sp[2] - cp[2]);
  ok(client.lastConsumedTick === 480, `server consumed all ${client.lastConsumedTick} ticks`);
  ok(sp[2] - room.sim.spawn[2] > 6, `walked ${(sp[2] - room.sim.spawn[2]).toFixed(1)} m south out of the plaza`);
  ok(dist < 1e-6, `server and predicted client agree to ${dist.toExponential(2)} m with the building in both`);
}

console.log('\n[10] scattered structures: the room streams a building at a plan site and the page-style plan agrees on the site');
{
  const { createStructureCollision, STRUCTURES_PROVIDER_ID } = await import('./base-game-structure-collision.js');
  const { structuresForTile } = await import('./base-game-structures.js');
  const { createFieldScheduler } = await import('./terrain-field-scheduler.js');
  const { createFieldWindow } = await import('./terrain-field-window.js');
  const { createPlanWalkDerive } = await import('./base-game-plan.js');
  const descriptor = analyticDescriptor({ key: 'base-game-structs', sourceVersion: '1', seaLevel: -200 });
  const bare = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(descriptor)) }).config;
  const withStructs = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(descriptor)), structures: true, structureSeed: 9 }).config;
  ok(withStructs.structures === true && withStructs.structureSeed === 9 && withStructs.structureSpacing === 480 && bare.structures === false, 'structures are an explicit opt-in with a seed and a default spacing');
  ok(withStructs.worldVersion !== bare.worldVersion && withStructs.worldVersion.endsWith(':structs2:9:480:1:5:110'), 'structures are part of the world identity');
  ok(describeBaseGameTerrainConfig(withStructs).structures === true, 'the description carries them');
  const sparse = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(descriptor)), structures: true, structureSeed: 9, structureChance: 0.3, structureScatter: 2, structureReach: 60 }).config;
  ok(sparse.structureChance === 0.3 && sparse.structureScatter === 2 && sparse.structureReach === 60 && sparse.worldVersion.endsWith(':structs2:9:480:0.3:2:60') && sparse.worldVersion !== withStructs.worldVersion, 'chance, scatter and reach are clamped, carried and part of the world identity');
  const vol = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(v5Descriptor(v5Project(7)))), volumetric: true, structures: true });
  ok(!vol.error && vol.config.structures === true && vol.config.worldVersion.includes(':volume') && vol.config.worldVersion.endsWith(':structs2:1:480:1:5:110'), 'structures are accepted in a volumetric room');

  let clock = 1000;
  const service = createBaseGameRoomService({ now: () => clock });
  const ws = new FakeSocket();
  service.handle(ws, { type: 'base:create', protocol: P, room: 'STRUCT', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor, structures: true, structureSeed: 9 } });
  await service.ensureWorld();
  const room = service.rooms.get('STRUCT');
  const structs = room.sim.structures;
  ok(structs && typeof room.sim.prepare === 'function', 'a structures room has a streamed provider and a prepare step');
  // A player standing in tile (1, 1): the private plan window fills over a few ticks, then one
  // building bakes per tick until the cover ring is done.
  const at = [[720, 50, 720]];
  let rounds = 0;
  while (rounds < 400 && structs.builtCount < 4) { room.sim.prepare(at); rounds++; }
  ok(structs.builtCount >= 4, `${structs.builtCount} buildings built around the player in ${rounds} prepare calls (${structs.tileCount} tiles settled)`);
  const tile = structs.get(1, 1);
  ok(tile && !tile.empty && tile.model, `tile 1:1 holds a ${tile?.structure?.kind}`);
  ok(tile?.scatter && tile.scatter.placed.length > 0 && tile.navRects.length > tile.scatter.navRects.length, `and ${tile?.scatter?.placed.length} bot-viewer cover structures around it, all in the nav rects`);
  const spawn = tile.model.spawn;
  const hit = room.sim.worldQuery.raycast({ origin: [spawn[0], spawn[1] + 3, spawn[2]], direction: [0, -1, 0], maxDistance: 20 });
  ok(hit && hit.providerId === STRUCTURES_PROVIDER_ID && hit.surfaceType === 'structure' && Math.abs(hit.point[1] - spawn[1]) < 0.02, 'a ray down at the building spawn lands on its floor through the structures provider');
  ok(structs.navRectsWithin({ minX: 720 - 192, maxX: 720 + 192, minZ: 720 - 192, maxZ: 720 + 192 }).length > 0, 'the NPC zone around the player gets structure nav rects');

  // The page's plan window is a 16-tile, 30 m-post window on the same source; its site for the
  // tile must be the room's site, or the page draws a building the room does not collide with.
  const src = createSource(descriptor);
  const walk = createPlanWalkDerive({ seaLevel: descriptor.seaLevel ?? 0 });
  const scheduler = createFieldScheduler({ useWorker: false, maxInFlight: 64, syncBudgetMs: 1000 });
  const pagePlan = createFieldWindow({ source: src, descriptor, scheduler, gpu: false, fields: ['heights', 'biomeIds', 'planWalk'], derived: ['planWalk'], derive: walk.derive, post: 30, tileIntervals: 16, tilesPerSide: 16, maxRequestsPerUpdate: 64 });
  const release = pagePlan.acquire();
  for (let i = 0; i < 40 && pagePlan.coverage < 1; i++) { pagePlan.update(720, 720); scheduler.pump(); }
  const pageSites = structuresForTile(9, 1, 1, pagePlan, { spacing: 480 });
  ok(pageSites && pageSites.length === 1 && pageSites[0].x === tile.structure.x && pageSites[0].z === tile.structure.z && pageSites[0].kind === tile.structure.kind && pageSites[0].seed === tile.structure.seed,
    `the page-style plan places the same ${pageSites?.[0]?.kind} at ${pageSites?.[0]?.x}, ${pageSites?.[0]?.z}`);
  // And the page's collider, built from the same site on the same source, is the same collider.
  const local = createWorldQueryService();
  local.registerProvider(createHeightfieldWorldQueryProvider(src, { id: 'terrain' }));
  const pageStructs = createStructureCollision(src, { worldQuery: local, seaLevel: descriptor.seaLevel ?? 0, seed: 9, spacing: 480, plan: () => pagePlan, maxBuildsPerCall: 8 });
  pageStructs.ensure(at); pageStructs.ensure(at);
  const localHit = local.raycast({ origin: [spawn[0], spawn[1] + 3, spawn[2]], direction: [0, -1, 0], maxDistance: 20 });
  ok(localHit && localHit.providerId === STRUCTURES_PROVIDER_ID && Math.abs(localHit.point[1] - hit.point[1]) < 1e-9, 'the page collider and the room collider agree on the floor height');
  // Walking away drops tiles outside the keep ring.
  const before = structs.tileCount;
  for (let i = 0; i < 6; i++) room.sim.prepare([[720 + 480 * 6, 50, 720]]);
  ok(!structs.has(1, 1) && structs.tileCount < before + 9, `tiles far from the player are dropped (${before} tiles before, ${structs.tileCount} now)`);
  release(); pagePlan.dispose(); scheduler.dispose(); pageStructs.dispose();

  // Volumetric: the same buildings, seated on the density surface like the plants and the spawn.
  const caveDescriptor = v5Descriptor(v5Project(4242));
  const caveWs = new FakeSocket();
  service.handle(caveWs, { type: 'base:create', protocol: P, room: 'CAVEB', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor: caveDescriptor, volumetric: true, structures: true, structureSeed: 9 } });
  await service.ensureWorld();
  const cave = service.rooms.get('CAVEB');
  ok(cave.sim.volume && cave.sim.structures, 'a volumetric structures room streams both caves and buildings');
  const caveAt = [[720, 80, 720]];
  let caveRounds = 0;
  while (caveRounds < 400 && cave.sim.structures.builtCount < 1) { cave.sim.prepare(caveAt); caveRounds++; }
  const caveTile = [...cave.sim.structures.tiles.values()].find((t) => !t.empty);
  ok(caveTile, `a building bakes in the volumetric room (${cave.sim.structures.builtCount} in ${caveRounds} calls)`);
  if (caveTile) {
    const caveSrc = createSource(caveDescriptor);
    const s2 = caveTile.structure;
    ok(caveTile.model.site.baseY >= caveSrc.surfaceYAt(s2.x, s2.z) - 1e-6, 'it seats on the density surface, not the heightfield');
  }
}

console.log('\n[11] volumetric room with the spawn building: it seats on the density surface and the room spawns on its plaza');
{
  const { createSpawnBuildingModel, SPAWN_BUILDING_PROVIDER_ID } = await import('./base-game-spawn-collider.js');
  const descriptor = v5Descriptor(v5Project(23));
  const cfg = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: JSON.parse(JSON.stringify(descriptor)), volumetric: true, spawnBuilding: true });
  ok(!cfg.error && cfg.config.volumetric && cfg.config.spawnBuilding && cfg.config.worldVersion.includes(':volume') && cfg.config.worldVersion.includes(':spawnbld1'), 'volumetric plus the building is one accepted world identity');
  const service = createBaseGameRoomService({ now: () => 1000 });
  const ws = new FakeSocket();
  service.handle(ws, { type: 'base:create', protocol: P, room: 'VBLD', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor, volumetric: true, spawnBuilding: true } });
  await service.ensureWorld();
  const room = service.rooms.get('VBLD');
  const src = createSource(descriptor);
  const model = createSpawnBuildingModel((x, z) => src.surfaceYAt(x, z), { seaLevel: descriptor.seaLevel ?? 0 });
  ok(room.sim.volume && room.sim.building, 'the room has both the volume collision and the building');
  ok(Math.abs(room.sim.spawn[1] - (model.spawn[1] + 1.5)) < 1e-6 && room.sim.spawn[0] === model.spawn[0] && room.sim.spawn[2] === model.spawn[2], 'the room spawns on the plaza, 1.5 m up');
  ok(model.site.baseY >= model.site.maxY - 1e-6 && model.site.maxY >= src.surfaceYAt(model.spawn[0], model.spawn[2]) - 1e-6, 'the plaza sits at or above the density surface under it, not the heightfield');
  const hit = room.sim.worldQuery.raycast({ origin: [model.spawn[0], model.spawn[1] + 3, model.spawn[2]], direction: [0, -1, 0], maxDistance: 20 });
  ok(hit && hit.providerId === SPAWN_BUILDING_PROVIDER_ID && Math.abs(hit.point[1] - model.spawn[1]) < 0.02, 'a ray down at the spawn lands on the building floor');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
