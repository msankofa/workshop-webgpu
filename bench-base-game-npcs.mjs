// N1 gate: server cost per 120 Hz tick with N NPC bots (analytic world, sea off, one player).
// Run: node bench-base-game-npcs.mjs [counts...]   e.g. node bench-base-game-npcs.mjs 0 4 8 16 32
import { createBaseGameRoomService } from './server/base-game-rooms.js';
import { BASE_GAME_PROTOCOL_VERSION, BASE_GAME_SIM_HZ, BASE_GAME_TEAMS } from './base-game-protocol.mjs';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { v5Descriptor } from './terrain-source-v5.js';
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { defaultStack, makeLayer } from './terrain-stack.js';
import { normalizeProject, migrateProjectToUnbounded, PROJECT_APP } from './terrain-project-v5.js';
function v5Project(seed) {
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 30, scale: 220 } }));
  return migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, name: 'Bench Hills', cfg: { ...DEFAULT_CONFIG, seed }, density: { ...DENSITY_DEFAULT_CONFIG }, stack, paint: null, imports: {} }).project);
}

const args = process.argv.slice(2);
const fight = args.includes('--fight');   // both sides spawn at the same spot: contact from tick one
const v5 = args.includes('--v5');         // a v5 noise-stack world instead of the analytic one
const descriptor = () => v5 ? v5Descriptor(v5Project(11)) : analyticDescriptor({ key: 'base-game-analytic', sourceVersion: '1' });
const counts = args.map(Number).filter(Number.isFinite);
const list = counts.length ? counts : [0, 4, 8, 16, 32];
for (const n of list) {
  let clock = 1000, seq = 0;
  const service = createBaseGameRoomService({ now: () => clock, makeToken: () => `t${++seq}`, graceMs: 1000 });
  const socket = () => ({ readyState: 1, sent: [], send() {}, close() {} });
  const owner = socket();
  service.handle(owner, { type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room: 'BENCH', world: { waterEnabled: false }, terrain: { kind: 'terrain', descriptor: descriptor() } });
  await service.ensureWorld();
  const room = service.rooms.get('BENCH');
  let tick = 0;
  const base = { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, sprint: false, crouch: false, stance: 0, jump: false, slot: 0, aim: false, reload: false, fire: false, throw: false };
  function drive(seconds) {
    let worst = 0, total = 0, steps = 0;
    for (let s = 0; s < seconds * 10; s++) {
      const ticks = []; for (let i = 0; i < BASE_GAME_SIM_HZ / 10; i++) { tick++; ticks.push({ ...base, tick }); }
      service.handle(owner, { type: 'base:input', protocol: BASE_GAME_PROTOCOL_VERSION, ticks, clientTime: clock });
      clock += 100;
      const t0 = performance.now(); service.step(clock); const ms = performance.now() - t0;
      total += ms; worst = Math.max(worst, ms); steps++;
      if (s % 5 === 0) service.broadcastSnapshots();
    }
    return { perTick: total / (steps * BASE_GAME_SIM_HZ / 10), worstSlice: worst, seconds };
  }
  if (n > 0) {
    service.handle(owner, { type: 'base:npc', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', team: BASE_GAME_TEAMS.enemy, count: Math.ceil(n / 2), at: fight ? [12, 0, 12] : null });
    service.handle(owner, { type: 'base:npc', protocol: BASE_GAME_PROTOCOL_VERSION, action: 'spawn', team: BASE_GAME_TEAMS.friendly, count: Math.floor(n / 2) });
  }
  const tb = performance.now(); const w = drive(2); const warm = performance.now() - tb;   // warm up: zone bake, first paths
  const bake = room.npcs?.zone();
  if (bake) console.log(`   bake: ${bake.cells} cells, ${bake.walkableCells} walkable, ${bake.bakeMs.toFixed(0)} ms wall sliced; phases finalize ${bake.phaseMs.finalize.toFixed(0)} / vis ${bake.phaseMs.vis.toFixed(0)} / corners ${bake.phaseMs.corners.toFixed(0)} ms; worst 100 ms slice during warm-up ${w.worstSlice.toFixed(1)} ms`);
  room.npcs?.resetStats();
  const r = drive(10);
  const st = room.npcs?.stats;
  const per = (v) => (v / r.seconds).toFixed(1);
  console.log(`${String(n).padStart(2)} bots: ${r.perTick.toFixed(3)} ms/tick (budget 8.33), worst 100 ms slice ${r.worstSlice.toFixed(1)} ms` +
    (st ? ` | per s: think ${per(st.thinkMs)} ms, sync ${per(st.syncMs)} ms, input ${per(st.inputMs)} ms, rays ${per(st.raycasts)} (${per(st.raycastMs)} ms), bakes ${st.bakes} (${st.bakeMs.toFixed(0)} ms), heightAt ${per(st.heights)} (${per(st.heightMs)} ms), vis ${per(st.vis)} (${per(st.visMs)} ms)` : ''));
}
