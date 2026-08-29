// test-base-game-rooms-water.mjs — water W8: the room server and a predicting client swim in the
// same sea. Both run base-game-water-sim.js on the lockstep tick, so the same input script must
// reach the same position through a water entry and an exit, and stay identical across a mid-run
// wave patch. A control run that ignores the patch has to diverge, or the test proves nothing.
import { createBaseGameRoomService } from './server/base-game-rooms.js';
import { BASE_GAME_PROTOCOL_VERSION, waveOptionsFromWorld, sanitizeBaseGameWorldPatch } from './base-game-protocol.mjs';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { createSource } from './terrain-source.js';
import { createWorldQueryService } from './world-query.js';
import { createHeightfieldWorldQueryProvider } from './world-query-heightfield-provider.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';
import { createBaseGameWaterSim } from './base-game-water-sim.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const P = BASE_GAME_PROTOCOL_VERSION;

class FakeSocket {
  constructor() { this.readyState = 1; this.sent = []; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  last(type) { for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].type === type) return this.sent[i]; return null; }
}

const descriptor = analyticDescriptor({ key: 'base-game-analytic', sourceVersion: '1' });
const startWorld = sanitizeBaseGameWorldPatch({ waveBaseAmp: 0.6, waveBaseLength: 1598, waveCount: 17, waveSeed: 7 });
const patchWorld = { waveBaseAmp: 2.4, waveWindDeg: 200, waveBaseLength: 400 };

console.log('\n[1] the room owns a sea and the descriptor sets its level');
let service, room, ws, clock = 1000;
{
  service = createBaseGameRoomService({ now: () => clock });
  ws = new FakeSocket();
  service.handle(ws, { type: 'base:create', protocol: P, room: 'SEA', world: startWorld, terrain: { kind: 'terrain', descriptor } });
  await service.ensureWorld();
  room = service.rooms.get('SEA');
  ok(room.water.enabled && room.water.level === (descriptor.seaLevel ?? 0), `room water at the descriptor sea level (${room.water.level})`);
  ok(room.water.waves.baseAmp === 0.6 && room.water.waves.count === 17, 'wave spectrum comes from the shared world keys');
  ok(room.sim.spawn[1] >= room.water.level, `spawn is above the water (${room.sim.spawn[1].toFixed(2)})`);
}

console.log('\n[2] a lab room has no sea to swim in');
{
  const labWs = new FakeSocket();
  service.handle(labWs, { type: 'base:create', protocol: P, room: 'LAB', world: {}, terrain: { kind: 'traversalLab' } });
  await service.ensureWorld();
  const lab = service.rooms.get('LAB');
  ok(lab.water.enabled === false && lab.water.heightAt(0, 0, 0) === null, 'traversal lab water stays off');
}

console.log('\n[3] client prediction and the server swim to the same place');
{
  const local = createWorldQueryService();
  local.registerProvider(createHeightfieldWorldQueryProvider(createSource(descriptor), { id: 'terrain' }));
  const makeClient = () => {
    const sim = createBaseGameWaterSim({ level: descriptor.seaLevel ?? 0, waves: waveOptionsFromWorld(startWorld), enabled: true });
    return {
      sim,
      controller: createBaseGamePlayerController({
        worldQuery: local, spawn: room.sim.spawn, config: { fixedHz: 120 },
        waterSurfaceAt: (x, z, t) => sim.heightAt(x, z, t),
      }),
    };
  };
  const tracking = makeClient();     // applies the wave patch, like a live client
  const stale = makeClient();        // never hears it: the control
  const inputs = [];
  for (let k = 1; k <= 960; k++) inputs.push({ tick: k, moveX: 0, moveZ: -1, yaw: Math.PI / 2, pitch: 0, sprint: true, crouch: k > 600 && k <= 700, jump: k % 240 === 0 });

  let sawSwimming = false, sawGrounded = false, patchTick = 0;
  for (let i = 0; i < inputs.length; i += 32) {
    const batch = inputs.slice(i, i + 32);
    if (i === 480) {
      // the owner retunes the swell mid-run: the server rebuilds its table, the client rebuilds its own
      service.handle(ws, { type: 'base:set_world', protocol: P, patch: patchWorld });
      tracking.sim.setWaves(waveOptionsFromWorld(sanitizeBaseGameWorldPatch(patchWorld)));
      patchTick = batch[0].tick;
    }
    for (const step of batch) {
      for (const c of [tracking, stale]) c.controller.stepOnce({ tick: step.tick, moveX: step.moveX, moveZ: step.moveZ, yaw: step.yaw, sprint: step.sprint, crouch: step.crouch }, step.jump);
      sawSwimming ||= tracking.controller.swimming;
      sawGrounded ||= tracking.controller.grounded;
    }
    clock += 40;
    service.handle(ws, { type: 'base:input', protocol: P, clientTime: clock, ticks: batch });
    for (let k = 0; k < 32; k++) { clock += 1000 / 120; service.step(clock); }
  }
  const client = service.rooms.get('SEA').clients.values().next().value;
  const sp = client.controller.getPosition(), cp = tracking.controller.getPosition(), stp = stale.controller.getPosition();
  ok(patchTick === 481 && room.water.waves.baseAmp === 2.4, `the wave patch reached the room at tick ${patchTick}`);
  ok(sawSwimming, 'the script actually swam');
  ok(sawGrounded, 'and walked on the ground as well (entry and exit)');
  ok(Math.hypot(sp[0] - cp[0], sp[1] - cp[1], sp[2] - cp[2]) < 1e-9, `server and client land on the same point (${sp.map(v => v.toFixed(4))} vs ${cp.map(v => v.toFixed(4))})`);
  ok(Math.hypot(sp[0] - stp[0], sp[1] - stp[1], sp[2] - stp[2]) > 0.05, `a client that missed the patch drifts off (${Math.hypot(sp[0] - stp[0], sp[1] - stp[1], sp[2] - stp[2]).toFixed(3)} m)`);
  ok(client.controller.tick === 960, 'the server simulated the client tick numbers, not its own count');
}

console.log('\n[4] turning the sea off is a shared decision');
{
  service.handle(ws, { type: 'base:set_world', protocol: P, patch: { waterEnabled: false } });
  ok(room.water.enabled === false && room.water.heightAt(0, 0, 0) === null, 'the owner can drain the room');
  service.handle(ws, { type: 'base:set_world', protocol: P, patch: { waterEnabled: true } });
  ok(room.water.enabled === true, 'and fill it again');
}

console.log('\n[5] player physics controls are authoritative room rules');
{
  service.handle(ws, { type: 'base:set_world', protocol: P, patch: { playerGroundDeceleration: 73, playerSlopeSlideDeceleration: 19 } });
  const client = room.clients.values().next().value;
  ok(client.controller.config.groundDeceleration === 73 && client.controller.config.slopeSlideDeceleration === 19,
    'owner physics patch configures the server controller');
  const snapshot = ws.last('base:snapshot');
  ok(snapshot.world.playerGroundDeceleration === 73 && snapshot.world.playerSlopeSlideDeceleration === 19,
    'the authoritative values return in snapshots for client prediction');
  const sanitized = sanitizeBaseGameWorldPatch({ playerGroundDeceleration: 1e6, playerSlopeSlideDeceleration: -4 });
  ok(sanitized.playerGroundDeceleration === 100 && sanitized.playerSlopeSlideDeceleration === 0,
    'player physics controls use the same bounds as the in-game sliders');
}

service.dispose?.();
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
