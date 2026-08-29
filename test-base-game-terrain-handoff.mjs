// Fall-through regressions (2026-08-22): the density surface is not the heightfield, the
// volumetric toggle must not drop collision while worker tiles are in flight, and holeAt must
// not fire on ordinary surface warp.
import * as THREE from 'three';
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { defaultStack, makeLayer } from './terrain-stack.js';
import { normalizeProject, migrateProjectToUnbounded, PROJECT_APP } from './terrain-project-v5.js';
import { createV5Source, v5Descriptor } from './terrain-source-v5.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';
import { createBaseGameTerrain } from './base-game-terrain.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

function project(density = {}) {
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 25, scale: 260, seedOffset: 2 } }));
  return migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, name: 'Handoff', cfg: { ...DEFAULT_CONFIG, seed: 4242, preview_resolution: 32 }, density: { ...DENSITY_DEFAULT_CONFIG, ...density }, stack, paint: null, imports: {} }).project);
}
const FRAME = 1 / 60;

console.log('\n[1] surfaceYAt / holeAt on the default density config (surface warp 8 m, no strong caves)');
{
  const src = createV5Source(v5Descriptor(project()));
  let holes = 0, n = 0, maxOff = 0, above = 0;
  for (let x = -1500; x <= 1500; x += 100) for (let z = -1500; z <= 1500; z += 100) {
    n++;
    const h = src.heightAt(x, z), s = src.surfaceYAt(x, z);
    maxOff = Math.max(maxOff, Math.abs(s - h));
    if (s > h + 1.5) above++;
    if (src.holeAt(x, z)) holes++;
    ok_density: { const d = src.densityAt(x, s + 0.05, z, h), e = src.densityAt(x, s - 0.05, z, h); if (!(d < 0 && e >= 0)) { ok(false, `surfaceYAt(${x},${z}) is not the air/rock boundary (${d.toFixed(2)} / ${e.toFixed(2)})`); break ok_density; } }
  }
  ok(maxOff > 3 && maxOff < 15, `density surface differs from the heightfield by up to ${maxOff.toFixed(1)} m (warp, not a bug)`);
  ok(above > n * 0.1, `surface sits above heightfield+1.5 at ${above}/${n} points: heightfield spawns would be inside rock`);
  ok(holes === 0, `holeAt fires at ${holes}/${n} points (warp alone must never count as a hole)`);
  const cavy = createV5Source(v5Descriptor(project({ cave_strength: 60, cave_threshold: 0.45, cave_period: 70, y_min: -60, y_max: 120 })));
  let caveHoles = 0; for (let x = -1500; x <= 1500; x += 100) for (let z = -1500; z <= 1500; z += 100) if (cavy.holeAt(x, z)) caveHoles++;
  ok(caveHoles > 0, `strong caves still register as holes (${caveHoles}/${n})`);
}

console.log('\n[2] spawnPosition lands on the volumetric surface where it rises above the heightfield');
{
  const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: v5Descriptor(project()), useWorker: false, params: { renderRadius: 1 }, volumetric: true });
  terrain.setActive(true);
  const src = terrain.source;
  let spot = null;
  for (let x = -1500; x <= 1500; x += 60) for (let z = -1500; z <= 1500; z += 60) { const d = src.surfaceYAt(x, z) - src.heightAt(x, z); if (!spot || d > spot.d) spot = { x, z, d }; }
  for (let i = 0; i < 60; i++) terrain.update([spot.x, 0, spot.z], FRAME);
  const top = worldQuery.raycastAll({ origin: [spot.x, 400, spot.z], direction: [0, -1, 0], maxDistance: 800 })[0]?.point[1];
  const spawn = terrain.spawnPosition(spot.x, spot.z);
  ok(Number.isFinite(top) && spawn[1] > top && spawn[1] - top < 2.5, `spawn y ${spawn[1].toFixed(2)} sits just above the mesh top ${top?.toFixed(2)} (heightfield ${src.heightAt(spot.x, spot.z).toFixed(2)})`);
  const c = createBaseGamePlayerController({ worldQuery, spawn });
  for (let i = 0; i < 240; i++) { c.advance(FRAME); terrain.update(c.getPosition(), FRAME); }
  ok(c.grounded && c.surface?.providerId === 'terrain-volume' && Math.abs(c.getPosition()[1] - top) < 1.2, `player stands on the volume there (y ${c.getPosition()[1].toFixed(2)}, grounded ${c.grounded})`);
  ok(terrain.killPlaneYAt(spot.x, spot.z) < top - 50, 'kill plane is relative to the real surface');
}

console.log('\n[3] live toggle: collision never lapses while volume chunks are still in flight');
{
  const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: v5Descriptor(project()), useWorker: false, params: { renderRadius: 1 } });
  terrain.setActive(true);
  for (let i = 0; i < 40; i++) terrain.update([0, 0, 0], FRAME);
  const c = createBaseGamePlayerController({ worldQuery, spawn: terrain.spawnPosition(0, 0) });
  for (let i = 0; i < 120; i++) { c.advance(FRAME); terrain.update(c.getPosition(), FRAME); }
  const hf = c.getPosition()[1];
  ok(c.grounded && c.surface?.providerId === 'terrain', `grounded on the heightfield first (y ${hf.toFixed(2)})`);

  // Captured BEFORE the toggle: restream drops the resident chunks (the far LOD covers the gap),
  // so after setVolumetric there is nothing left to stand in for the volume tiles.
  const saved = [...terrain.system.chunks.entries()];
  terrain.setVolumetric(true);
  ok(terrain.handoffPending && terrain.provider.enabled && terrain.volumeProvider.enabled, 'toggle: heightfield stays live until the volume chunk under the player exists');
  // Emulate worker latency: colliders are withheld for a full second while the player keeps moving.
  terrain.volumeProvider.clear();
  for (let i = 0; i < 60; i++) c.advance(FRAME);
  ok(c.grounded && Math.abs(c.getPosition()[1] - hf) < 0.5, `still standing after 1 s without volume colliders (y ${c.getPosition()[1].toFixed(2)})`);
  for (const [k, ch] of saved) terrain.volumeProvider.setChunk(k, ch.mesh.geometry);
  terrain.update(c.getPosition(), FRAME);
  ok(!terrain.handoffPending && terrain.takeHandoffCompleted() && !terrain.provider.enabled, 'handoff completes once the chunk under the player is collidable');
  ok(terrain.takeHandoffCompleted() === false, 'the completion flag reads once');
  // The page re-seats on the new surface; simulate that and settle.
  const p = c.getPosition();
  const ground = terrain.groundHeight(p[0], p[2]);
  if (Math.abs(p[1] - ground) > 1) c.reset(terrain.spawnPosition(p[0], p[2]));
  for (let i = 0; i < 240; i++) { c.advance(FRAME); terrain.update(c.getPosition(), FRAME); }
  ok(c.grounded && c.surface?.providerId === 'terrain-volume', `stands on the volume after the handoff (y ${c.getPosition()[1].toFixed(2)}, surface ${ground.toFixed(2)})`);

  terrain.setVolumetric(false);
  ok(!terrain.handoffPending && terrain.provider.enabled && !terrain.volumeProvider.enabled && terrain.takeHandoffCompleted(), 'toggle off: immediate, reports a handoff so the page re-seats');
  for (let i = 0; i < 240; i++) { c.advance(FRAME); terrain.update(c.getPosition(), FRAME); }
  ok(c.grounded && c.surface?.providerId === 'terrain', 'back on the heightfield');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
