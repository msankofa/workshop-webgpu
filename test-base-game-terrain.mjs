// Phase 4 checks for Base Game's terrain runtime owner (sync build path, real scene,
// real world-query service, real player controller). Run: node test-base-game-terrain.mjs
import * as THREE from 'three';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { createBaseGameTerrain } from './base-game-terrain.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const scene = new THREE.Scene();
const worldQuery = createWorldQueryService();
const worldCoordinates = createWorldCoordinateSpace();
const descA = analyticDescriptor({ key: 'base-game-analytic', sourceVersion: '1' });
const descB = analyticDescriptor({ key: 'base-game-analytic', sourceVersion: '2', params: { baseAmp: 2.2, lake: 0.3, lakeDepth: 1 } });
const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: descA, useWorker: false, params: { renderRadius: 2 } });
const settle = (pos, n = 80) => { for (let i = 0; i < n; i++) terrain.update(pos, 1 / 60); };

console.log('\n[1] construction and mode switch');
{
  ok(scene.children.includes(terrain.root) && terrain.root.name === 'base-game-terrain', 'root added to the scene');
  ok(worldQuery.providerIds().includes('terrain') && terrain.provider.enabled === false, 'provider registered but inactive until the mode is selected');
  ok(worldQuery.groundProbe({ origin: [0, 50, 0], maxDistance: 100 }) === null, 'inactive terrain answers no probes');
  terrain.setActive(true);
  ok(terrain.provider.enabled === true && terrain.system.group.visible === true, 'active: collision + visuals on');
  settle([0, 0, 0]);
  ok(terrain.system.chunks.size === 25, `resident ${terrain.system.chunks.size}/25 chunks at radius 2`);
  ok(terrain.stats.source.key === 'base-game-analytic' && terrain.stats.source.version === '1' && terrain.stats.draws === 25 && terrain.stats.triangles > 0, 'stats identify the source and count draws/triangles');
}

console.log('\n[2] the player walks, jumps and crosses chunk boundaries on terrain');
{
  const spawn = terrain.spawnPosition(0, 0);
  const controller = createBaseGamePlayerController({ worldQuery, spawn });
  const sim = (seconds, input = null) => {
    for (let i = 0; i < Math.ceil(seconds * 60); i++) {
      if (input) controller.setInput(input);
      controller.advance(1 / 60);
      terrain.update(controller.getPosition(), 1 / 60);
    }
  };
  sim(1.5);
  let p = controller.getPosition();
  ok(controller.grounded && near(p[1], terrain.system.getHeight(p[0], p[2]), 0.05), 'settles on the terrain at spawn');
  ok(controller.surface?.providerId === 'terrain', 'surface identity is the terrain provider');
  let minGroundedGap = Infinity, airborneFrames = 0;
  for (let i = 0; i < 60 * 12; i++) {
    controller.setInput({ moveX: 0, moveZ: 1, yaw: 0, sprint: true });
    controller.advance(1 / 60);
    p = controller.getPosition();
    terrain.update(p, 1 / 60);
    if (i > 30) { if (!controller.grounded) airborneFrames++; minGroundedGap = Math.min(minGroundedGap, p[1] - terrain.system.getHeight(p[0], p[2])); }
  }
  ok(Math.abs(p[2]) > 60, `travelled ${Math.abs(p[2]).toFixed(1)} m (crosses several 30 m chunks)`);
  ok(airborneFrames < 60 * 2, `mostly grounded while walking (${airborneFrames} airborne frames)`);
  ok(minGroundedGap > -0.2, `never sank into terrain (min gap ${minGroundedGap.toFixed(3)})`);
  ok(terrain.system.chunks.size === 25 && terrain.system.activeChunks.every(c => Math.abs(c.centerZ - p[2]) < 90), 'window followed the player; old chunks unloaded');
  controller.setInput({ moveX: 0, moveZ: 0, yaw: 0, sprint: false });
  controller.queueJump();
  let maxRise = 0; const baseY = p[1];
  for (let i = 0; i < 120; i++) { controller.advance(1 / 60); terrain.update(controller.getPosition(), 1 / 60); maxRise = Math.max(maxRise, controller.getPosition()[1] - baseY); }
  ok(maxRise > 1 && controller.grounded, `jumped ${maxRise.toFixed(2)} m and landed`);
  // respawn through the host's spawn helper lands on ground
  controller.reset(terrain.spawnPosition(40, -20));
  sim(1);
  p = controller.getPosition();
  ok(controller.grounded && near(p[1], terrain.system.getHeight(p[0], p[2]), 0.05), 'respawn at another point settles on terrain');
  ok(terrain.killPlaneYAt(p[0], p[2]) < p[1] - 50, 'kill plane sits well below the local surface');
}

console.log('\n[3] visual off keeps authoritative collision');
{
  terrain.setVisible(false);
  ok(terrain.system.group.visible === false && terrain.provider.enabled === true, 'group hidden, provider still enabled');
  ok(worldQuery.groundProbe({ origin: [5, 50, 5], maxDistance: 100 })?.providerId === 'terrain', 'probes still hit hidden terrain');
  ok(terrain.stats.draws === 0 && terrain.stats.residentTiles === 25, 'stats report 0 draws but full residency');
  terrain.setVisible(true);
}

console.log('\n[4] render-origin rebase moves presentation only');
{
  settle([3, 0, 3]);
  const keysBefore = [...terrain.system.chunks.keys()].sort().join('|');
  const meshBefore = terrain.system.chunks.get('0,0').mesh;
  const vertexBefore = meshBefore.geometry.attributes.position.getX(5);
  const hitBefore = worldQuery.groundProbe({ origin: [3, 50, 3], maxDistance: 100 }).point[1];
  worldCoordinates.setRenderOrigin([1024, 0, -2048]);
  ok(near(terrain.root.position.x, -1024) && near(terrain.root.position.z, 2048), `root translated by -renderOrigin (${terrain.root.position.x}, ${terrain.root.position.z})`);
  settle([3, 0, 3]);
  ok([...terrain.system.chunks.keys()].sort().join('|') === keysBefore, 'tile keys unchanged by rebase');
  ok(terrain.system.chunks.get('0,0').mesh === meshBefore && meshBefore.geometry.attributes.position.getX(5) === vertexBefore, 'chunk geometry untouched (stays global)');
  ok(near(worldQuery.groundProbe({ origin: [3, 50, 3], maxDistance: 100 }).point[1], hitBefore), 'collision unaffected by rebase');
  worldCoordinates.setRenderOrigin([0, 0, 0]);
}

console.log('\n[5] debug views and draw radius');
{
  terrain.setWireframe(true);
  ok(terrain.system.chunks.get('0,0').mesh.material.wireframe === true, 'wireframe applied to chunk material');
  terrain.setNormals(true);
  ok(terrain.system.chunks.get('0,0').mesh.material !== terrain.system.material, 'normals view swaps the chunk material');
  terrain.setNormals(false); terrain.setWireframe(false);
  terrain.setTileBounds(true);
  settle([0, 0, 0], 5);
  const bounds = terrain.system.group.children.find(c => c.name === 'base-game-terrain-tile-bounds');
  ok(bounds.visible && bounds.children.length === 25, `tile bounds helper per resident chunk (${bounds.children.length})`);
  terrain.setTileBounds(false);
  terrain.setCollisionDebug(true);
  terrain.update([2, 10, 2], 1 / 60);
  const marker = terrain.system.group.children.find(c => c.name === 'base-game-terrain-contact');
  ok(marker.visible && near(marker.position.y, terrain.system.getHeight(2, 2)), 'collision marker sits on the probed ground');
  terrain.setCollisionDebug(false);
  terrain.setDrawRadius(1);
  settle([0, 0, 0], 120);
  ok(terrain.system.chunks.size === 9, `draw radius 1 -> ${terrain.system.chunks.size}/9 chunks`);
  terrain.setDrawRadius(2);
  settle([0, 0, 0], 120);
  ok(terrain.system.chunks.size === 25, 'back to 25');
}

console.log('\n[6] source swap and removal without rebuilding the player');
{
  const h1 = worldQuery.groundProbe({ origin: [7, 50, 7], maxDistance: 100 }).point[1];
  terrain.setSource(descB);
  settle([0, 0, 0], 200);
  const h2 = worldQuery.groundProbe({ origin: [7, 50, 7], maxDistance: 100 });
  ok(terrain.stats.source.version === '2' && h2.colliderId === 'base-game-analytic@2' && !near(h1, h2.point[1]), 'swap changes streamed + collided source');
  ok([...terrain.system.chunks.values()].every(c => !c.stale && c.meta.sourceVersion === '2'), 'all chunks replaced under budget');
  terrain.setActive(false);
  ok(terrain.provider.enabled === false && terrain.system.group.visible === false, 'inactive again: collision and visuals off');
  ok(worldQuery.groundProbe({ origin: [7, 50, 7], maxDistance: 100 }) === null, 'no terrain answers after removal');
  const stats = terrain.stats;
  ok(stats.active === false && stats.source.key === 'base-game-analytic' && 'queuedTiles' in stats && 'inFlightTiles' in stats && 'lastUpdateMs' in stats, 'performance record fields present');
  terrain.dispose();
  ok(!scene.children.includes(terrain.root) && !worldQuery.providerIds().includes('terrain'), 'dispose removes root and provider');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
