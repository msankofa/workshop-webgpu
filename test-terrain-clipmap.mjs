// Phase 9 checks: far-distance clipmap rings fed by band-limited source tiles.
// Run: node test-terrain-clipmap.mjs
import * as THREE from 'three';
import { createClipmapWindow, createClipmapLevels, wrapIndex } from './terrain-clipmap-window.js';
import { createTerrainClipmap, CLIPMAP_DEFAULTS } from './terrain-clipmap.js';
import { createSource } from './terrain-source.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { v5Descriptor } from './terrain-source-v5.js';
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { defaultStack, makeLayer } from './terrain-stack.js';
import { normalizeProject, migrateProjectToUnbounded, PROJECT_APP } from './terrain-project-v5.js';
import { octaveBandWeight, fbm2 } from './terrain-noise.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createBaseGameTerrain } from './base-game-terrain.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const analytic = createSource(analyticDescriptor({ key: 'clip-analytic', sourceVersion: '1' }));
function project(extraLayers = []) {
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 40, scale: 600, seedOffset: 2, octaves: 3 } }));
  for (const l of extraLayers) stack.layers.push(l);
  return migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, name: 'Clip', cfg: { ...DEFAULT_CONFIG, seed: 99, preview_resolution: 32 }, density: { ...DENSITY_DEFAULT_CONFIG }, stack, paint: null, imports: {} }).project);
}

console.log('\n[1] band limit: octaves finer than the sample spacing fade to their mean; lod 0 stays exact');
{
  ok(octaveBandWeight(1, 0) === 1 && octaveBandWeight(1, 1 / 8) === 1 && octaveBandWeight(1, 1 / 4) === 0 && near(octaveBandWeight(1, 1 / 6), 0.5), 'weight: 1 at 8 samples/wavelength, 0 at 4, linear between');
  const fine = makeLayer('fbm', { id: 'FINE', params: { amplitude: 30, scale: 20, octaves: 1, seedOffset: 5 } });   // 20 m is the smallest layer scale
  const withFine = createSource(v5Descriptor(project([fine]))), without = createSource(v5Descriptor(project()));
  let maxExactDiff = 0, maxCoarseDiff = 0;
  for (let i = 0; i < 200; i++) {
    const x = i * 7.3 - 700, z = i * 3.1 - 300;
    maxExactDiff = Math.max(maxExactDiff, Math.abs(withFine.heightAt(x, z) - without.heightAt(x, z)));
    maxCoarseDiff = Math.max(maxCoarseDiff, Math.abs(withFine.heightAtSpacing(x, z, 8) - without.heightAtSpacing(x, z, 8)));
  }
  ok(maxExactDiff > 5, `exact heights differ by up to ${maxExactDiff.toFixed(1)} m with the 20 m layer`);
  ok(maxCoarseDiff < 1e-9, `at 8 m spacing (2.5 samples per wavelength) the 20 m layer is gone entirely (${maxCoarseDiff.toExponential(1)})`);
  const t0 = withFine.buildTile({ ix: 0, iz: 0, lod: 0, xMin: 0, zMin: 0, size: 30, intervals: 23, apron: 1, fields: ['heights'] });
  ok(t0.heights[(1) * t0.texels + 1] === Math.fround(withFine.heightAt(0, 0)), 'lod 0 tile is the exact field');
  const t3 = withFine.buildTile({ ix: 0, iz: 0, lod: 3, xMin: 0, zMin: 0, size: 256, intervals: 32, apron: 1, fields: ['heights'] });
  ok(t3.heights[1 * t3.texels + 1] === Math.fround(withFine.heightAtSpacing(0, 0, 8)), 'lod 3 tile samples the band-limited field at its own spacing');
  ok(near(fbm2(3.3, 7.7, { octaves: 5 }), fbm2(3.3, 7.7, { octaves: 5, bandSpacing: 0 })), 'bandSpacing 0 is the exact kernel');
}

console.log('\n[2] window: toroidal addressing, tile commits, bilinear sample, eviction on recentre');
{
  const w = createClipmapWindow({ level: 0, post: 2 });
  ok(w.res === 256 && w.tileSize === 64, `res ${w.res} posts, tile ${w.tileSize} m`);
  ok(w.recentre(1000, -500), 'first recentre places the window');
  const [ox, oz] = w.desiredOrigin(1000, -500);
  ok(w.originPX === ox && w.originPZ === oz && ox % 32 === 0 && oz % 32 === 0, `origin snaps to tiles (${ox}, ${oz})`);
  const missing = w.missingTiles(1000, -500);
  ok(missing.length === 64 && missing[0].d <= missing[missing.length - 1].d, 'all 64 tiles missing, nearest first');
  for (const t of missing) w.commitTile(analytic.buildTile(w.tileRequest(t.ix, t.iz)));
  ok(w.coverage === 1 && w.presentCount === 64, 'window full');
  let maxErr = 0;
  for (let i = 0; i < 300; i++) {
    const x = 1000 + (i % 17) * 13.7 - 110, z = -500 + Math.floor(i / 17) * 9.1 - 80;
    const s = w.sample(x, z);
    if (s == null) { maxErr = Infinity; break; }
    // bilinear of the band-limited posts around (x, z)
    const fx = x / 2, fz = z / 2, gx = Math.floor(fx), gz = Math.floor(fz), t = fx - gx, u = fz - gz;
    const h = (X, Z) => analytic.heightAtSpacing(X * 2, Z * 2, 2);
    const ref = (h(gx, gz) * (1 - t) + h(gx + 1, gz) * t) * (1 - u) + (h(gx, gz + 1) * (1 - t) + h(gx + 1, gz + 1) * t) * u;
    maxErr = Math.max(maxErr, Math.abs(s - ref));
  }
  ok(maxErr < 1e-4, `sample() matches bilinear source posts (max err ${maxErr.toExponential(1)})`);
  ok(wrapIndex(-1, 256) === 255 && wrapIndex(256, 256) === 0 && wrapIndex(-257, 256) === 255, 'wrapIndex is a positive modulo');
  const gx = w.originPX + 5, gz = w.originPZ + 7;
  ok(near(w.heights[wrapIndex(gz, 256) * 256 + wrapIndex(gx, 256)], analytic.heightAtSpacing(gx * 2, gz * 2, 2)), 'global post (gx, gz) lives at texel (gx mod res, gz mod res)');
  // move one tile east: 8 tiles fall off the west, 8 new are missing, the rest stay put
  const before = w.heights.slice();
  ok(w.recentre(1000 + 64, -500), 'recentre by one tile changes the origin');
  ok(w.presentCount === 56 && w.missingTiles(1064, -500).length === 8, `eviction: ${w.presentCount} kept, 8 missing`);
  let moved = 0; for (let i = 0; i < before.length; i++) if (before[i] !== w.heights[i]) moved++;
  ok(moved === 0, 'no heights were copied or cleared by the move (toroidal)');
  ok(w.sample(1000, -500) !== null && w.sample(1000 - 200, -500) === null, 'kept area still samples; fallen-off area does not');
}

console.log('\n[3] levels: rings always fit their windows, holes are always covered by the finer ring, centres only snap');
{
  const levels = createClipmapLevels({ levels: 6, post0: 2, ringCells: 192 });
  ok(levels.length === 6 && levels[5].post === 64, 'six levels, post doubles to 64 m');
  const N = 192, overlap = CLIPMAP_DEFAULTS.overlapCells;
  let fits = true, covered = true;
  for (let trial = 0; trial < 400; trial++) {
    const fx = (trial * 137.3) % 5000 - 2500, fz = (trial * 91.7) % 5000 - 2500;
    const centres = levels.map(w => { w.recentre(fx, fz); const s = w.post * 2; return [Math.round(fx / s) * s, Math.round(fz / s) * s]; });
    for (let L = 0; L < levels.length; L++) {
      const w = levels[L], half = (N / 2) * w.post, [cx, cz] = centres[L];
      // the ring plus one post of normal taps must lie inside the addressable window
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (!w.covers(cx + sx * (half + w.post), cz + sz * (half + w.post))) fits = false;
      }
      if (L > 0) {
        // this ring's hole (N/4 - overlap cells) must sit inside the finer ring's extent
        const holeHalf = (N / 4 - overlap) * w.post;
        const fine = levels[L - 1], fineHalf = (N / 2) * fine.post, [fx2, fz2] = centres[L - 1];
        if (cx - holeHalf < fx2 - fineHalf || cx + holeHalf > fx2 + fineHalf || cz - holeHalf < fz2 - fineHalf || cz + holeHalf > fz2 + fineHalf) covered = false;
      }
    }
  }
  ok(fits, 'every ring (plus normal taps) is inside its level window for 400 random focus points');
  ok(covered, 'every hole is inside the finer ring for 400 random focus points (no gaps while moving)');
  // snapping: a focus move smaller than two cells does not move a ring centre
  const w0 = levels[0]; const s = w0.post * 2;
  const c1 = Math.round(100.4 / s) * s, c2 = Math.round((100.4 + 1.5) / s) * s;
  ok(c1 === c2, 'centres snap to two cells: sub-snap motion never swims the lattice');
}

console.log('\n[4] clipmap renderer (Node, synchronous tiles): rings, windows, counts, source swap');
{
  const clip = createTerrainClipmap({ source: analytic, useWorker: false, levels: 4, maxDispatchPerUpdate: 64, maxInFlight: 64 });
  ok(clip.root.children.length === 4 && clip.outerHalfExtent === 96 * 2 * 8, `4 rings, outer half-extent ${clip.outerHalfExtent} m`);
  for (let i = 0; i < 8; i++) clip.update([0, 0, 0]);
  const s1 = clip.stats;
  ok(s1.coverage.every(c => c === 1), `all windows full after ${s1.tilesBuilt} tiles (${s1.coverage.join('/')})`);
  ok(s1.draws === 4 && s1.triangles > 0, `${s1.draws} draws, ${s1.triangles} triangles`);
  // walk 2 km at 250 m/s (60 Hz): triangle count constant, windows keep up
  let minCov = 1, triSet = new Set();
  for (let f = 0; f < 480; f++) {
    const x = f * (250 / 60);
    clip.update([x, 0, 0]);
    const st = clip.stats;
    triSet.add(st.triangles);
    if (f > 30) minCov = Math.min(minCov, ...st.coverage);
  }
  ok(triSet.size === 1, 'triangle count constant while travelling');
  ok(minCov >= 0.9, `windows stay >= 90% covered in flight (min ${minCov.toFixed(2)})`);
  const centre0 = clip.root.children[0].material.positionNode;   // exists, built from uniforms
  ok(!!centre0, 'ring material has a position node');
  // hole rectangle: inset by the overlap
  clip.setHoleRect([-90, -90, 120, 120]);
  ok(clip.holeRect[0] === -90 && clip.stats.holeRect[2] === 120, 'hole rect stored');
  // source swap restreams: windows empty then refill from the new source
  const v5 = createSource(v5Descriptor(project()));
  clip.setSource(v5);
  ok(clip.stats.coverage.every(c => c === 0) && clip.epoch === 1, 'setSource clears the windows (epoch bump)');
  for (let i = 0; i < 8; i++) clip.update([2000, 0, 0]);
  ok(clip.stats.coverage.every(c => c === 1), 'windows refill from the new source');
  const w1 = clip.windows[1];
  const probe = w1.sample(2000 + 10, 20);
  ok(probe != null && near(probe, (() => { const fx = 2010 / 4, fz = 20 / 4, gx = Math.floor(fx), gz = Math.floor(fz), t = fx - gx, u = fz - gz; const h = (X, Z) => v5.heightAtSpacing(X * 4, Z * 4, 4); return (h(gx, gz) * (1 - t) + h(gx + 1, gz) * t) * (1 - u) + (h(gx, gz + 1) * (1 - t) + h(gx + 1, gz + 1) * t) * u; })(), 1e-4), 'level 1 window holds the v5 recipe band-limited at 4 m');
  clip.dispose();
}

console.log('\n[5] Base Game integration: far LOD is visual only; collision stays exact lod 0; rebasing is a translation');
{
  const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace({ rebaseDistance: 512, rebaseSnap: 256 });
  const src = v5Descriptor(project([makeLayer('fbm', { id: 'FINE', params: { amplitude: 12, scale: 20, octaves: 1, seedOffset: 5 } })]));
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: src, useWorker: false, params: { renderRadius: 1, farLodLevels: 3 } });
  terrain.setActive(true);
  ok(!terrain.farLod && terrain.clipmap === null, 'far LOD off by default, no clipmap built');
  terrain.setFarLod(true);
  ok(terrain.farLod && terrain.clipmap && terrain.clipmap.root.parent === terrain.system.group, 'enabling builds the clipmap under the chunk root (shares −renderOrigin)');
  for (let i = 0; i < 12; i++) terrain.update([0, 0, 0], 1 / 60);
  const st = terrain.stats;
  ok(st.farLod && st.farLod.levels === 3 && st.farLod.coverage[0] === 1, `stats carry the far LOD block (coverage ${st.farLod.coverage.join('/')})`);
  ok(Array.isArray(terrain.clipmap.holeRect) && terrain.clipmap.holeRect[0] === -30 && terrain.clipmap.holeRect[2] === 60, `hole follows the resident chunk square (${terrain.clipmap.holeRect.join(', ')})`);
  // collision: exact lod-0 height, not the band-limited window
  const exact = terrain.source.heightAt(5, 5);
  const hit = worldQuery.groundProbe({ origin: [5, exact + 1, 5], maxDistance: 5, slopeLimitCos: -1 });
  ok(hit && near(hit.point[1], exact, 1e-9), 'ground probe returns the exact lod-0 height');
  // level 1 samples every 4 m: the 20 m layer is at 5 samples/wavelength, 3/4 faded
  let maxDiff = 0; for (let x = -40; x <= 40; x += 3) { const c = terrain.clipmap.windows[1].sample(x, 5); if (c != null) maxDiff = Math.max(maxDiff, Math.abs(c - terrain.source.heightAt(x, 5))); }
  ok(maxDiff > 1, `the far ring's own height differs from the exact ground by up to ${maxDiff.toFixed(2)} m (band limit), yet collision ignores it`);
  ok(terrain.farExtent === 96 * 2 * 4, `far extent ${terrain.farExtent} m for the camera far plane`);
  // rebase: the clipmap root does not move in global terms; render-local root shifts
  const before = terrain.root.position.clone();
  worldCoordinates.maybeRebase([900, 0, 0]);
  ok(!terrain.root.position.equals(before) && terrain.clipmap.root.position.lengthSq() === 0, 'rebase translates the shared root; clipmap rings stay global');
  terrain.setFarLod(false);
  ok(!terrain.clipmap.root.children[0].visible, 'turning far LOD off hides the rings without disposing them');
  terrain.dispose();
}


console.log('\n[6] volumetric far LOD: a marching-cubes cascade on band-limited density; caves survive where their size allows');
{
  const caveProject = (() => {
    const stack = defaultStack();
    stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 25, scale: 260, seedOffset: 2 } }));
    return migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, name: 'CaveLod', cfg: { ...DEFAULT_CONFIG, seed: 4242, preview_resolution: 32 }, density: { ...DENSITY_DEFAULT_CONFIG, cave_strength: 60, cave_threshold: 0.45, cave_period: 70, y_min: -60, y_max: 120 }, stack, paint: null, imports: {} }).project);
  })();
  const src = createSource(v5Descriptor(caveProject));
  // coarse volume tiles build at every lod and stay cheap
  const t1 = performance.now();
  const tile1 = src.buildTile({ ix: 0, iz: 0, lod: 1, xMin: 0, zMin: 0, size: 120, intervals: 24, apron: 1, fields: ['heights', 'normals', 'volume'] });
  const ms1 = performance.now() - t1;
  const t3 = performance.now();
  const tile3 = src.buildTile({ ix: 0, iz: 0, lod: 3, xMin: 0, zMin: 0, size: 1920, intervals: 24, apron: 1, fields: ['heights', 'volume'] });
  const ms3 = performance.now() - t3;
  ok(tile1.volume.indices.length > 0 && tile3.volume.indices.length > 0, `lod 1 (5 m) and lod 3 (80 m) volume tiles build: ${tile1.volume.indices.length / 3} and ${tile3.volume.indices.length / 3} triangles`);
  ok(ms1 < 400 && ms3 < 400, `coarse tiles are cheap (${ms1.toFixed(0)} ms, ${ms3.toFixed(0)} ms)`);
  // the 5 m level still carves caves: count columns whose downward ray crosses more than one surface
  const { createChunkMeshWorldQueryProvider } = await import('./world-query-chunk-mesh-provider.js');
  const countCaveColumns = (tile, step) => {
    const prov = createChunkMeshWorldQueryProvider({ id: 'lod' });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(tile.volume.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(tile.volume.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(tile.volume.indices, 1));
    prov.setChunk('t', geo);
    let caves = 0, n = 0;
    for (let x = 2; x < tile.size - 2; x += step) for (let z = 2; z < tile.size - 2; z += step) {
      n++;
      const hits = prov.raycastAll({ origin: [x, 200, z], direction: [0, -1, 0], maxDistance: 400 });
      if (hits.length >= 3) caves++;
    }
    return [caves, n];
  };
  const exact = src.buildTile({ ix: 0, iz: 0, lod: 0, xMin: 0, zMin: 0, size: 120, intervals: 90, apron: 1, fields: ['heights', 'volume'] });
  const [c0, n0] = countCaveColumns(exact, 6);
  const [c1, n1] = countCaveColumns(tile1, 6);
  ok(c0 > 0 && c1 > 0, `cave columns: exact ${c0}/${n0}, 5 m level ${c1}/${n1} (caves still read as caves at the first far level)`);
  // the cascade in the Base Game fixture: visual only, its own chunk systems, collision untouched
  const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: v5Descriptor(caveProject), useWorker: false, params: { renderRadius: 1 }, volumetric: true, farLod: true });
  terrain.setActive(true);
  for (let i = 0; i < 40; i++) terrain.update([0, 0, 0], 1 / 60);
  const st = terrain.stats;
  ok(st.farLod?.kind === 'volume-cascade' && st.farLod.levels.length === 3, 'volumetric far LOD is the cascade, not the heightfield rings');
  ok(st.farLod.levels.every(l => l.resident > 0 && !l.lastSourceError), `levels stream: ${st.farLod.levels.map(l => `${l.chunkSize} m × ${l.resident} (${l.spacing} m)`).join(', ')}`);
  ok(terrain.farExtent === 2.5 * 1920, `far extent ${terrain.farExtent} m`);
  ok(terrain.volumeProvider.chunkCount === terrain.system.chunks.size, 'only the exact chunks collide; cascade chunks never enter the volume provider');
  const lvl1 = terrain.volumeLod[0].system;
  const mesh = lvl1.group.children.find(c => c.isMesh);
  ok(mesh && mesh.material === terrain.system.material && mesh.geometry.getAttribute('color'), 'cascade chunks share the chunk material and tint');
  ok(terrain.volumeLod.every(l => l.system.group.parent.position.y < 0), 'coarser levels sit lower (bias) so the finer ones draw over them');
  terrain.setVolumetric(false);
  ok(terrain.stats.farLod?.kind === 'clipmap', 'heightfield mode falls back to the clipmap rings');
  terrain.dispose();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
