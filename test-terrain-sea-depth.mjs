// test-terrain-sea-depth.mjs — water W2: the sea-depth window fills from band-limited source
// tiles, samples bilinearly, tracks its minimum for the visibility gate, survives recentring and
// source swaps, and builds its TSL sampler headless.
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { createSeaDepthMap, SEA_DEPTH_DEFAULTS } from './terrain-sea-depth.js';
import { createAnalyticSource, analyticDescriptor } from './terrain-source-analytic.js';
import { createSource } from './terrain-source.js';
import { buildMaterial } from './tsl-build-check.mjs';
import { positionWorld } from 'three/tsl';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

console.log('\n[1] fill, sample, minimum');
{
  const src = createAnalyticSource(analyticDescriptor({ key: 'sea', sourceVersion: '1', seaLevel: 0 }));
  const map = createSeaDepthMap({ source: src, useWorker: false, spacing: 16, tileIntervals: 8, tilesPerSide: 4, syncBuildsPerUpdate: 4 });
  ok(map.res === 32 && map.extent === 512, `window ${map.res} posts = ${map.extent} m`);
  map.recentre(100, -40);
  let rounds = 0; while (!map.update() && rounds < 50) rounds++;
  ok(map.coverage === 1 && map.stats.tilesBuilt === 16, `window full after ${rounds + 1} updates (${map.stats.tilesBuilt} tiles)`);
  const ref = src.buildTile({ ix: 0, iz: 0, lod: 1, xMin: 0, zMin: 0, size: 128, intervals: 8, apron: 1, fields: ['heights'] });
  const at = map.heightAt(32, 48);   // post (2, 3) of tile (0,0): exact texel, no interpolation
  ok(at != null && Math.abs(at - ref.heights[(3 + 1) * ref.texels + (2 + 1)]) < 1e-6, `sample matches the band-limited tile (${at?.toFixed(2)})`);
  const mid = map.heightAt(40, 48), a = map.heightAt(32, 48), b = map.heightAt(48, 48);
  ok(Math.abs(mid - (a + b) / 2) < 1e-6, 'bilinear between posts');
  const w = map.window; let m = Infinity;
  for (let gz = w.originPZ; gz < w.originPZ + w.res; gz++) for (let gx = w.originPX; gx < w.originPX + w.res; gx++) { const h = map.heightAt(gx * 16, gz * 16); if (h != null && h < m) m = h; }
  ok(Math.abs(map.minHeight() - m) < 1e-6, `minimum over the window ${map.minHeight().toFixed(2)}`);
  ok(map.heightAt(5000, 0) == null && !map.covers(5000, 0), 'outside the window: null, not covered');
  map.dispose();
}

console.log('\n[2] recentre keeps overlap, source swap clears');
{
  const src = createAnalyticSource(analyticDescriptor({ key: 'sea', sourceVersion: '1' }));
  const map = createSeaDepthMap({ source: src, useWorker: false, spacing: 16, tileIntervals: 8, tilesPerSide: 4, syncBuildsPerUpdate: 16 });
  map.recentre(0, 0); map.update();
  const built = map.stats.tilesBuilt;
  const before = map.heightAt(64, 64);
  ok(map.recentre(128, 0) === true, 'moving one tile recentres the window');
  ok(map.heightAt(64, 64) === before, 'overlapping posts keep their heights without a rebuild');
  map.update();
  ok(map.stats.tilesBuilt - built === 4 && map.coverage === 1, `only the newly exposed column was built (${map.stats.tilesBuilt - built} tiles)`);
  const other = createSource(analyticDescriptor({ key: 'other', sourceVersion: '2', params: { baseAmp: 80 } }));
  map.setSource(other);
  ok(map.coverage === 0 && map.minHeight() === Infinity && map.heightAt(64, 64) == null, 'swap empties the window and the minimum');
  map.update();
  ok(map.coverage === 1 && map.heightAt(64, 64) !== before, 'refills from the new source');
  map.dispose();
}

console.log('\n[3] TSL sampler builds');
{
  const src = createAnalyticSource(analyticDescriptor({ key: 'sea', sourceVersion: '1' }));
  const map = createSeaDepthMap({ source: src, useWorker: false, tileIntervals: 8, tilesPerSide: 4 });
  const mat = new MeshBasicNodeMaterial();
  mat.colorNode = map.gpuHeightAt(positionWorld.xz).mul(0.01).toVec3();
  const geo = new THREE.PlaneGeometry(1, 1);
  let built = null; try { built = await buildMaterial(mat, geo); } catch (e) { built = e; }
  ok(built && built.fragment && /texelFetch|textureLoad/.test(built.fragment), `sampler compiles headless (${built?.message ?? 'ok'})`);
  ok(map.uniforms.res.value === 32 && map.uniforms.post.value === SEA_DEPTH_DEFAULTS.spacing, 'uniforms carry the window geometry');
  map.dispose();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
