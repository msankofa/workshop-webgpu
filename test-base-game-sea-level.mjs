// test-base-game-sea-level.mjs — water W1: sea level as a descriptor field, through the protocol,
// the terrain facade and the server world; wave spectrum keys on the shared world patch.
import * as THREE from 'three';
import { normalizeDescriptor } from './terrain-source.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { v5Descriptor } from './terrain-source-v5.js';
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { defaultStack, makeLayer } from './terrain-stack.js';
import { normalizeProject, migrateProjectToUnbounded, PROJECT_APP } from './terrain-project-v5.js';
import { sanitizeBaseGameTerrainConfig, sanitizeBaseGameWorldPatch, waveOptionsFromWorld, BASE_GAME_SHARED_KEYS } from './base-game-protocol.mjs';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { createBaseGameRoomService } from './server/base-game-rooms.js';
import { createSource } from './terrain-source.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

function project(sea = 0) {
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 25, scale: 260, seedOffset: 2 } }));
  return migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, name: 'Sea', cfg: { ...DEFAULT_CONFIG, seed: 4242, sea_level: sea }, density: { ...DENSITY_DEFAULT_CONFIG }, stack, paint: null, imports: {} }).project);
}

console.log('\n[1] descriptor field');
{
  ok(analyticDescriptor({ key: 'a', sourceVersion: '1' }).seaLevel === 0, 'analytic defaults to 0');
  ok(analyticDescriptor({ key: 'a', sourceVersion: '1', seaLevel: 7.5 }).seaLevel === 7.5, 'analytic carries the slider value');
  ok(v5Descriptor(project(12)).seaLevel === 12, 'v5 takes cfg.sea_level');
  ok(v5Descriptor(project(12)).sourceVersion !== v5Descriptor(project(0)).sourceVersion, 'sea level is inside the v5 hash');
  let threw = false; try { normalizeDescriptor({ ...analyticDescriptor({ key: 'a', sourceVersion: '1' }), seaLevel: 'deep' }); } catch { threw = true; }
  ok(threw, 'a non-numeric sea level is rejected');
}

console.log('\n[2] protocol: room config and shared wave keys');
{
  const plain = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: analyticDescriptor({ key: 'a', sourceVersion: '1' }) }).config;
  const sea = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: analyticDescriptor({ key: 'a', sourceVersion: '1', seaLevel: 9 }) }).config;
  ok(sea.worldVersion.endsWith(':sea9') && !plain.worldVersion.includes(':sea'), `analytic sea level is in the world version (${sea.worldVersion})`);
  const clamped = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: analyticDescriptor({ key: 'a', sourceVersion: '1', seaLevel: 900 }) }).config;
  ok(clamped.descriptor.seaLevel === 120 && clamped.worldVersion.endsWith(':sea120'), 'sea level is clamped to the v5 field range');
  const v5 = sanitizeBaseGameTerrainConfig({ kind: 'terrain', descriptor: v5Descriptor(project(12)) }).config;
  ok(v5.descriptor.seaLevel === 12 && v5.worldVersion.endsWith(':sea12'), 'v5 keeps the project sea level');
  const patch = sanitizeBaseGameWorldPatch({ waveCount: 12.4, waveBaseAmp: 999, waveChop: 0.3, waveDispersion: false, waveSeed: 3.7, sunIntensity: 1, bogus: 1 });
  ok(patch.waveCount === 12 && patch.waveBaseAmp === 50 && patch.waveChop === 0.3 && patch.waveDispersion === false && patch.waveSeed === 4 && !('bogus' in patch), 'wave keys sanitized: rounded, clamped, boolean kept');
  const opts = waveOptionsFromWorld(patch);
  ok(opts.count === 12 && opts.baseAmp === 50 && opts.dispersion === false && opts.seed === 4 && !('sunIntensity' in opts), 'waveOptionsFromWorld maps to buildWaveTable names only');
  ok(BASE_GAME_SHARED_KEYS.includes('waveWindDeg'), 'wave keys are shared world keys');
}

console.log('\n[3] terrain facade: sea level, tint bands, spawn, live change');
{
  const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: analyticDescriptor({ key: 'a', sourceVersion: '1', seaLevel: 30 }), useWorker: false, params: { renderRadius: 1 } });
  terrain.setActive(true);
  for (let i = 0; i < 4; i++) terrain.update([0, 0, 0], 0.1);
  ok(terrain.seaLevel === 30, 'facade reads the descriptor sea level');
  const ground = terrain.groundHeight(0, 0);
  const spawn = terrain.spawnPosition(0, 0);
  ok(spawn[1] === Math.max(ground, 30) + 1.5, `spawn is above the water (ground ${ground.toFixed(1)}, spawn ${spawn[1].toFixed(1)})`);
  const mesh = terrain.system.group.children.find(c => c.isMesh && c.userData.terrainChunk);
  const before = mesh ? Array.from(mesh.geometry.getAttribute('color').array.slice(0, 30)) : null;
  ok(terrain.setSeaLevel(-40) === true && terrain.seaLevel === -40, 'setSeaLevel applies');
  const after = mesh ? Array.from(mesh.geometry.getAttribute('color').array.slice(0, 30)) : null;
  ok(before && after && before.some((v, i) => v !== after[i]), 'chunks recolour when the sea level moves');
  ok(terrain.setSeaLevel(-40) === false, 'no-op when unchanged');
  terrain.setSource(v5Descriptor(project(12)));
  ok(terrain.seaLevel === 12, 'a source swap takes the new sea level');
  terrain.dispose();
}

console.log('\n[4] server world spawns above the water');
{
  const service = createBaseGameRoomService();
  const descriptor = analyticDescriptor({ key: 'a', sourceVersion: '1', seaLevel: 60 });
  const ws = { sent: [], send(text) { this.sent.push(JSON.parse(text)); }, last(type) { return [...this.sent].reverse().find(m => m.type === type); } };
  service.handle(ws, { type: 'base:create', protocol: (await import('./base-game-protocol.mjs')).BASE_GAME_PROTOCOL_VERSION, room: 'SEA', world: {}, terrain: { kind: 'terrain', descriptor } });
  await service.ensureWorld();
  const room = service.rooms.get('SEA');
  const src = createSource(descriptor);
  ok(room && room.sim.seaLevel === 60 && Math.abs(room.sim.spawn[1] - (Math.max(src.heightAt(0, 0), 60) + 1.5)) < 1e-9, `server spawn ${room?.sim.spawn[1].toFixed(1)} above sea level 60`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
