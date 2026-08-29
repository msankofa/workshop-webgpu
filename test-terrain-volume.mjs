// Phase 8 checks: streamed volumetric terrain (caves) from a v5 project's density config.
// Run: node test-terrain-volume.mjs
import * as THREE from 'three';
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG, generateNoiseFields, composeClassicHeight, buildDensityField3D, createUnboundedDensityNoiseSampler, createDensityNoiseSampler } from './terrain-generator-js.js';
import { defaultStack, makeLayer, evaluateStackGrid } from './terrain-stack.js';
import { normalizeProject, migrateProjectToUnbounded, PROJECT_APP } from './terrain-project-v5.js';
import { createV5Source, v5Descriptor } from './terrain-source-v5.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { createChunkMeshWorldQueryProvider } from './world-query-chunk-mesh-provider.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
// The density's real surface at (x, z): first solid sample scanning down from above the
// heightfield (the volume warps it by up to warp_strength_surface metres).
function trueTop(src, x, z, stepY = 0.25) {
  const h = src.heightAt(x, z);
  for (let y = h + 14; y > src.project.density.y_min; y -= stepY) if (src.densityAt(x, y, z, h) >= 0) return y;
  return null;
}

function cavyProject(seed = 4242) {
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 25, scale: 260, seedOffset: 2 } }));
  return migrateProjectToUnbounded(normalizeProject({
    app: PROJECT_APP, version: 1, name: 'Cavy',
    cfg: { ...DEFAULT_CONFIG, seed, preview_resolution: 32 },
    density: { ...DENSITY_DEFAULT_CONFIG, cave_strength: 60, cave_threshold: 0.45, cave_period: 70, y_min: -60, y_max: 120 },
    stack, paint: null, imports: {},
  }).project);
}
const size = 30, intervals = 24;
const req = (ix, iz, fields = ['heights', 'normals', 'volume']) => ({ ix, iz, xMin: ix * size, zMin: iz * size, size, intervals, apron: 1, fields });

console.log('\n[1] point density matches the editor\'s unbounded volumetric preview at its grid');
{
  const p = cavyProject();
  const res = 24;
  const fields = generateNoiseFields(p.cfg, res, { unbounded: true });
  const classic = composeClassicHeight(fields, p.cfg);
  const height = evaluateStackGrid(p.stack, { resolution: res, worldX: p.cfg.world_x, worldZ: p.cfg.world_z, seed: p.cfg.seed, classicHeight: classic });
  const d = { ...p.density, density_resolution: res };
  const field = buildDensityField3D({ height }, d, p.cfg.world_x, p.cfg.world_z, p.cfg.seed, { unbounded: true });
  const src = createV5Source(p);
  let maxD = 0, solid = 0, air = 0;
  for (let iz = 0; iz < res; iz += 3) for (let iy = 0; iy < res; iy += 3) for (let ix = 0; ix < res; ix += 3) {
    const x = (ix / (res - 1) - 0.5) * p.cfg.world_x, z = (iz / (res - 1) - 0.5) * p.cfg.world_z;
    const y = d.y_min + (iy / (res - 1)) * (d.y_max - d.y_min);
    const v = field[ix + iy * res + iz * res * res];
    maxD = Math.max(maxD, Math.abs(v - src.densityAt(x, y, z, height[iz * res + ix])));
    if (v > 0) solid++; else air++;
  }
  ok(maxD < 1e-4, `max |preview density - densityAt| = ${maxD.toExponential(2)} (${solid} solid / ${air} air samples)`);
  const bounded = createDensityNoiseSampler(), unbounded = createUnboundedDensityNoiseSampler();
  ok(Math.abs(unbounded.fbm3(7, 90, 0, 0, 0, 5000, 12, -7000)) <= 1 && unbounded.fbm3(7, 90, 0, 0, 0, 5000, 12, -7000) !== unbounded.fbm3(7, 90, 0, 0, 0, 5001, 12, -7000), 'unbounded 3D noise varies far outside any board');
  ok(bounded.fbm3(7, 90, 1200, 200, 1200, 5000, 12, 0) === bounded.fbm3(7, 90, 1200, 200, 1200, 9000, 12, 0), 'legacy bounded 3D noise still clamps (unchanged)');
}

console.log('\n[2] volume tiles: geometry, seams and gradient normals');
{
  const src = createV5Source(cavyProject());
  const a = src.buildTile(req(0, 0)), b = src.buildTile(req(1, 0));
  ok(a.volume && a.volume.positions.length > 0 && a.volume.indices.length % 3 === 0 && a.volume.normals.length === a.volume.positions.length, `tile has a mesh (${a.volume.indices.length / 3} tris, ${a.volume.rows} rows)`);
  let maxH = -Infinity; for (const v of a.heights) maxH = Math.max(maxH, v);
  ok(a.volume.yMin === -60 && a.volume.yMax >= maxH + 10, `rows span the density floor ${a.volume.yMin} up to ${a.volume.yMax.toFixed(1)} (surface max ${maxH.toFixed(1)})`);
  // every vertex of A on the shared plane x=30 has a partner in B within float noise, with the same normal
  // skirt vertices also sit on the border plane, hanging down with their own normals: surface only
  const onPlane = (t, x) => { const out = []; const end = (t.volume.skirtVertexStart ?? t.volume.positions.length / 3) * 3; for (let i = 0; i < end; i += 3) if (Math.abs(t.volume.positions[i] - x) < 1e-4) out.push(i); return out; };
  const pa = onPlane(a, 30), pb = onPlane(b, 30);
  let unmatched = 0, maxNormalDelta = 0;
  for (const i of pa) {
    let best = null, bestD = Infinity;
    for (const j of pb) {
      const d = Math.hypot(a.volume.positions[i + 1] - b.volume.positions[j + 1], a.volume.positions[i + 2] - b.volume.positions[j + 2]);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (bestD > 1e-3) { unmatched++; continue; }
    for (let k = 0; k < 3; k++) maxNormalDelta = Math.max(maxNormalDelta, Math.abs(a.volume.normals[i + k] - b.volume.normals[best + k]));
  }
  ok(pa.length > 10 && unmatched === 0, `${pa.length} border vertices all matched by the neighbour tile (${unmatched} unmatched)`);
  ok(maxNormalDelta < 1e-3, `gradient normals agree across the seam (max delta ${maxNormalDelta.toExponential(2)})`);
  let bad = 0; for (let i = 0; i < a.volume.normals.length; i += 3) { const l = Math.hypot(a.volume.normals[i], a.volume.normals[i + 1], a.volume.normals[i + 2]); if (Math.abs(l - 1) > 1e-3) bad++; }
  ok(bad === 0, 'normals are unit length');
  // the mesh's highest vertex in a column sits on the density's true surface (heightfield +/- warp)
  let maxTopDelta = 0, checked = 0;
  for (const [x, z] of [[5, 5], [12, 22], [25, 8], [18, 18], [3, 27]]) {
    let best = -Infinity;
    for (let i = 0; i < a.volume.positions.length; i += 3) {
      if (Math.abs(a.volume.positions[i] - x) > 0.7 || Math.abs(a.volume.positions[i + 2] - z) > 0.7) continue;
      best = Math.max(best, a.volume.positions[i + 1]);
    }
    const top = trueTop(src, x, z);
    if (best === -Infinity || top === null) continue;
    maxTopDelta = Math.max(maxTopDelta, Math.abs(best - top)); checked++;
  }
  ok(checked >= 4 && maxTopDelta < 3, `column tops match the density surface (${checked} columns, max delta ${maxTopDelta.toFixed(2)} m, spacingY ${a.volume.spacingY})`);
  const flat = createV5Source(migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, cfg: { ...DEFAULT_CONFIG }, density: { ...DENSITY_DEFAULT_CONFIG, cave_strength: 0, warp_strength_surface: 0, warp_strength_global: 0 }, stack: defaultStack(), paint: null, imports: {} }).project));
  ok(flat.holeAt(5, 5) === false, 'no carve -> holeAt is false');
}

console.log('\n[3] chunk-mesh provider: raycast and capsule over streamed chunks');
{
  const src = createV5Source(cavyProject());
  const prov = createChunkMeshWorldQueryProvider({ id: 'vol' });
  const wq = createWorldQueryService();
  wq.registerProvider(prov);
  for (const [ix, iz] of [[0, 0], [1, 0]]) {
    const t = src.buildTile(req(ix, iz));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(t.volume.positions, 3));
    g.setIndex(new THREE.BufferAttribute(t.volume.indices, 1));
    prov.setChunk(`${ix},${iz}`, g);
  }
  ok(prov.chunkCount === 2 && prov.triangleCount > 0, `two chunks, ${prov.triangleCount} triangles`);
  const h = trueTop(src, 15, 15);
  const hit = wq.raycast({ origin: [15, h + 50, 15], direction: [0, -1, 0], maxDistance: 200 });
  ok(hit && hit.providerId === 'vol' && hit.colliderId === '0,0' && Math.abs(hit.point[1] - h) < 3, `ray down hits the mesh top at the density surface (${hit && hit.point[1].toFixed(2)} vs ${h.toFixed(2)})`);
  const all = wq.raycastAll({ origin: [15, h + 50, 15], direction: [0, -1, 0], maxDistance: 200 });
  ok(all.length >= 1 && all.every(x => x.surfaceType === 'terrain'), `raycastAll returns ${all.length} surfaces down the column`);
  const top = hit.point[1];
  const r = wq.resolveCapsule({ capsule: { start: [15, top + 0.35 - 0.3, 15], end: [15, top + 1.45, 15], radius: 0.35 }, velocity: [0, -2, 0], slopeLimitCos: 0.5 });
  ok(r.contacts.length > 0 && r.contacts[0].colliderId === '0,0' && r.capsule.start[1] > top + 0.35 - 0.3 - 1e-6, 'capsule pushed out of the mesh with a chunk-keyed contact');
  ok(wq.raycast({ origin: [200, 50, 200], direction: [0, -1, 0], maxDistance: 200 }) === null, 'no chunk there: no hit');
  prov.removeChunk('1,0');
  ok(prov.chunkCount === 1 && wq.raycast({ origin: [45, h + 50, 15], direction: [0, -1, 0], maxDistance: 200 }) === null, 'removed chunk no longer collides');
}

console.log('\n[4] Base Game fixture: surface, cave at the same X/Z, and back on top');
{
  const scene = new THREE.Scene();
  const worldQuery = createWorldQueryService();
  const worldCoordinates = createWorldCoordinateSpace();
  const project = cavyProject();
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: v5Descriptor(project), useWorker: false, params: { renderRadius: 1 }, volumetric: true });
  terrain.setActive(true);
  ok(terrain.volumetric && terrain.provider.enabled === false && terrain.volumeProvider.enabled === true, 'volumetric: heightfield provider stands down, chunk meshes collide');
  for (let i = 0; i < 40; i++) terrain.update([0, 0, 0], 1 / 60);
  ok(terrain.system.chunks.size === 9 && [...terrain.system.chunks.values()].every(c => c.meta.volumetric), 'nine volumetric chunks resident');
  ok(terrain.volumeProvider.chunkCount === 9, 'nine chunk colliders');
  const src = terrain.source;

  // Find a cave from the collision mesh itself: a downward raycastAll through a column whose
  // hits go top surface -> cave ceiling (normal down) -> cave floor (normal up) with headroom.
  let cave = null;
  outer: for (let x = -26; x <= 56; x += 2) for (let z = -26; z <= 56; z += 2) {
    const hits = worldQuery.raycastAll({ origin: [x, 120, z], direction: [0, -1, 0], maxDistance: 250 });
    if (hits.length < 3) continue;
    const top = hits[0];
    for (let k = 1; k + 1 < hits.length; k++) {
      const ceil = hits[k], floor = hits[k + 1];
      if (ceil.normal[1] < -0.3 && floor.normal[1] > 0.5 && floor.point[1] < ceil.point[1] - 3 && floor.point[1] < top.point[1] - 5) {
        cave = { x, z, topY: top.point[1], ceilY: ceil.point[1], floorY: floor.point[1] }; break outer;
      }
    }
  }
  ok(!!cave, cave ? `found a cave at (${cave.x}, ${cave.z}): top ${cave.topY.toFixed(1)}, ceiling ${cave.ceilY.toFixed(1)}, floor ${cave.floorY.toFixed(1)}` : 'no cave found in the window');

  const sim = (c, seconds) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) { c.advance(1 / 60); terrain.update(c.getPosition(), 1 / 60); } };
  const onTop = createBaseGamePlayerController({ worldQuery, spawn: [cave.x, cave.topY + 2, cave.z] });
  sim(onTop, 2);
  const top = onTop.getPosition();
  ok(onTop.grounded && onTop.surface?.providerId === 'terrain-volume' && Math.abs(top[1] - cave.topY) < 1, `stands on the mesh surface above the cave (y ${top[1].toFixed(2)} vs ${cave.topY.toFixed(2)}; grounded ${onTop.grounded}, provider ${onTop.surface?.providerId}, xz drift ${Math.hypot(top[0] - cave.x, top[2] - cave.z).toFixed(2)})`);
  const restStart = onTop.getPosition();
  for (let i = 0; i < 60 * 120; i++) onTop.stepOnce({ moveX: 0, moveZ: 0, yaw: 0 });
  const restEnd = onTop.getPosition();
  const restDrift = Math.hypot(restEnd[0] - restStart[0], restEnd[2] - restStart[2]);
  ok(onTop.grounded && restDrift < 1e-3, `holds position for 60 s on irregular volumetric ground (${restDrift.toExponential(2)} m drift)`);

  const inside = createBaseGamePlayerController({ worldQuery, spawn: [cave.x, cave.floorY + 1.0, cave.z] });
  sim(inside, 2);
  const inPos = inside.getPosition();
  ok(inside.grounded && inside.surface?.providerId === 'terrain-volume', `stands on the cave floor (y ${inPos[1].toFixed(2)} vs floor ${cave.floorY.toFixed(2)}; grounded ${inside.grounded}, provider ${inside.surface?.providerId}, xz drift ${Math.hypot(inPos[0] - cave.x, inPos[2] - cave.z).toFixed(2)})`);
  ok(inPos[1] < cave.topY - 4 && Math.abs(inPos[0] - cave.x) < 2 && Math.abs(inPos[2] - cave.z) < 2, 'same X/Z as the surface player, well below it: stacked surfaces stay distinct');
  ok(terrain.killPlaneYAt(cave.x, cave.z) < src.project.density.y_min, 'kill plane sits below the density floor, not just below the surface');

  // back on top: teleport above and settle again without snapping into the cave
  inside.reset([cave.x, cave.topY + 2, cave.z]);
  sim(inside, 2);
  ok(inside.grounded && Math.abs(inside.getPosition()[1] - cave.topY) < 1, 'returns to the surface at the same X/Z');

  // switching volumetric off restores heightfield collision and drops the chunk colliders
  terrain.setVolumetric(false);
  for (let i = 0; i < 60; i++) terrain.update([0, 0, 0], 1 / 60);
  ok(terrain.provider.enabled === true && terrain.volumeProvider.enabled === false && terrain.volumeProvider.chunkCount === 0, 'heightfield mode restored, volume colliders cleared');
  ok([...terrain.system.chunks.values()].every(c => !c.meta.volumetric && !c.stale), 'chunks restreamed as heightfield quads');
  const s = terrain.stats;
  ok(s.volumetric === false && s.collisionProvider.id === 'terrain', 'stats reflect the mode');
  terrain.dispose();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
