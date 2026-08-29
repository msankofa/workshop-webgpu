import * as THREE from 'three';
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { defaultStack, makeLayer } from './terrain-stack.js';
import { normalizeProject, migrateProjectToUnbounded, PROJECT_APP } from './terrain-project-v5.js';
import { v5Descriptor } from './terrain-source-v5.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';
import { createBaseGameTerrain } from './base-game-terrain.js';
function project(density = {}) {
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 25, scale: 260, seedOffset: 2 } }));
  return migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, name: 'Handoff', cfg: { ...DEFAULT_CONFIG, seed: 4242, preview_resolution: 32 }, density: { ...DENSITY_DEFAULT_CONFIG, ...density }, stack, paint: null, imports: {} }).project);
}
const FRAME = 1 / 60;
const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace();
const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: v5Descriptor(project()), useWorker: false, params: { renderRadius: 1 } });
terrain.setActive(true);
for (let i = 0; i < 40; i++) terrain.update([0, 0, 0], FRAME);
const c = createBaseGamePlayerController({ worldQuery, spawn: terrain.spawnPosition(0, 0) });
for (let i = 0; i < 120; i++) { c.advance(FRAME); terrain.update(c.getPosition(), FRAME); }
terrain.setVolumetric(true);
const saved = [...terrain.system.chunks.entries()];
console.log('saved keys', saved.map(([k]) => k).join(' '));
terrain.volumeProvider.clear();
for (let i = 0; i < 60; i++) c.advance(FRAME);
for (const [k, ch] of saved) terrain.volumeProvider.setChunk(k, ch.mesh.geometry);
const p = c.getPosition();
const size = 30;
console.log('player', p.map(v => v.toFixed(2)).join(','), 'chunkKey', `${Math.floor(p[0]/size)},${Math.floor(p[2]/size)}`);
console.log('provider chunks now', terrain.volumeProvider.chunkCount, 'hasChunk', terrain.volumeProvider.hasChunk(`${Math.floor(p[0]/size)},${Math.floor(p[2]/size)}`));
terrain.update(p, FRAME);
console.log('after update: handoffPending', terrain.handoffPending, 'providerEnabled', terrain.provider.enabled, 'volProviderChunks', terrain.volumeProvider.chunkCount);
console.log('hasChunk after', terrain.volumeProvider.hasChunk(`${Math.floor(p[0]/size)},${Math.floor(p[2]/size)}`));
