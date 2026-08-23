// Streamed-chunk ground textures: layer rules, distance fades, headless shader build, wiring.
// Run: node test-terrain-splat-streamed.mjs
import * as THREE from 'three';
import { buildMaterial } from './tsl-build-check.mjs';
import { createStreamedSplatMaterial, placeholderStreamedSplatTextures, splatWeights, detailFade, updateStreamedSplat, STREAMED_SPLAT_DEFAULTS, STREAMED_SPLAT_LAYERS } from './terrain-splat-streamed.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { createBaseGameTerrain } from './base-game-terrain.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sum = w => w.reduce((a, b) => a + b, 0);
const argmax = w => w.indexOf(Math.max(...w));

console.log('\n[1] layer weights (CPU twin of the shader): partition of unity, rules by height and slope');
{
  let unity = true;
  for (let h = -10; h <= 200; h += 3) for (let ny = 0; ny <= 1; ny += 0.05) if (!near(sum(splatWeights(h, ny)), 1, 1e-9)) unity = false;
  ok(unity, 'weights always sum to 1');
  ok(argmax(splatWeights(0, 1)) === 0, 'sea level, flat -> sand');
  ok(argmax(splatWeights(20, 1)) === 1, '20 m, flat -> grass');
  ok(argmax(splatWeights(80, 1)) === 2, '80 m, flat -> dirt');
  ok(argmax(splatWeights(140, 1)) === 4, '140 m, flat -> snow');
  ok(argmax(splatWeights(20, 0.5)) === 3 && argmax(splatWeights(140, 0.5)) === 3, 'steep faces are rock at any height (cave walls, cliffs)');
  const mid = splatWeights(20, (STREAMED_SPLAT_DEFAULTS.rockSlope + STREAMED_SPLAT_DEFAULTS.rockFull) / 2);
  ok(mid[3] > 0.3 && mid[3] < 0.7 && mid[1] > 0.3, 'the rock ramp blends, it does not switch');
}

console.log('\n[2] distance fades: fine tile -> far tile -> average colour; nothing left to shimmer at range');
{
  const d0 = detailFade(0), d150 = detailFade(150), d800 = detailFade(800), dFar = detailFade(3000);
  ok(d0.farTile === 0 && d0.detail === 1, 'at the feet: fine tiling, full detail');
  ok(d150.farTile > 0.3 && d150.farTile < 1 && d150.detail === 1, `150 m: far tiling taking over (${d150.farTile.toFixed(2)}), detail intact`);
  ok(d800.farTile === 1 && d800.detail > 0 && d800.detail < 1, `800 m: far tiling only, detail fading (${d800.detail.toFixed(2)})`);
  ok(dFar.detail === 0, '3 km: average colour only, normal strength and macro hash at zero');
}

console.log('\n[3] the material builds headless and exposes live uniforms');
{
  const mat = createStreamedSplatMaterial(placeholderStreamedSplatTextures());
  const geo = new THREE.PlaneGeometry(1, 1, 2, 2); geo.computeVertexNormals();
  let built = null, error = null;
  try { built = await buildMaterial(mat, geo); } catch (e) { error = e; }
  ok(built && built.fragment && built.vertex, `shader graph builds (${error ? error.message.slice(0, 120) : 'ok'})`);
  ok(mat.userData.streamedSplat.layers === STREAMED_SPLAT_LAYERS && mat.vertexColors === false, 'material carries its layer list and ignores the tint attribute');
  ok(updateStreamedSplat(mat, { tileMeters: 8, fadeFar: 900, normalStrength: 0.3 }) && near(mat.userData.streamedSplat.uniforms.tile.value, 1 / 8) && mat.userData.streamedSplat.uniforms.fadeFar.value === 900, 'live tuning patches the uniforms');
  ok(updateStreamedSplat({}, { tileMeters: 2 }) === false, 'a non-splat material is refused');
  const mipsOk = Object.values(placeholderStreamedSplatTextures().layers).every(l => l.color.isTexture && l.normal.isTexture);
  ok(mipsOk, 'placeholder textures are ordinary textures (the real loader sets mipmaps + anisotropy)');
}

console.log('\n[4] Base Game wiring: chunks and the cascade pick up the splat; tint returns when it is off');
{
  const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: analyticDescriptor({ key: 'splat', sourceVersion: '1' }), useWorker: false, params: { renderRadius: 1 } });
  terrain.setActive(true);
  for (let i = 0; i < 10; i++) terrain.update([0, 0, 0], 1 / 60);
  const chunkMeshes = () => terrain.system.group.children.filter(c => c.isMesh && c.userData.terrainChunk);
  ok(terrain.stats.textures === 'tint' && chunkMeshes().every(m => m.material === terrain.system.material), 'before textures arrive: the vertex tint material');
  const splat = createStreamedSplatMaterial(placeholderStreamedSplatTextures());
  terrain.setSplatMaterial(splat);
  ok(terrain.stats.textures === 'streamed-splat' && chunkMeshes().every(m => m.material === splat), 'setSplatMaterial re-materials every resident chunk');
  for (let i = 0; i < 5; i++) terrain.update([40, 0, 0], 1 / 60);
  ok(chunkMeshes().every(m => m.material === splat), 'chunks streamed later also get it');
  terrain.setSplatEnabled(false);
  ok(terrain.stats.textures === 'off' && chunkMeshes().every(m => m.material === terrain.system.material && m.geometry.getAttribute('color')), 'off: tint material back, colour attribute still on the geometry');
  terrain.setSplatEnabled(true);
  terrain.setWireframe(true);
  ok(splat.wireframe === true, 'wireframe reaches the splat material');
  terrain.dispose();
}


console.log('\n[5] LOD hole: cascade levels discard inside the finer level; the hole follows the player');
{
  const { setStreamedSplatHole } = await import('./terrain-splat-streamed.js');
  const holeMat = createStreamedSplatMaterial(placeholderStreamedSplatTextures(), {}, { hole: true });
  const geo = new THREE.PlaneGeometry(1, 1, 2, 2); geo.computeVertexNormals();
  let built = null; try { built = await buildMaterial(holeMat, geo); } catch (e) { built = null; }
  ok(built && /discard/.test(built.fragment), 'hole material builds with a discard');
  ok(setStreamedSplatHole(holeMat, [-10, -20, 30, 40]) && holeMat.userData.streamedSplat.uniforms.holeMin.value.x === -10 && holeMat.userData.streamedSplat.uniforms.holeMax.value.y === 40, 'hole rect lands in the uniforms');
  ok(setStreamedSplatHole(createStreamedSplatMaterial(placeholderStreamedSplatTextures()), [0, 0, 1, 1]) === false, 'a plain splat has no hole');

  const { v5Descriptor } = await import('./terrain-source-v5.js');
  const { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } = await import('./terrain-generator-js.js');
  const { defaultStack, makeLayer } = await import('./terrain-stack.js');
  const { normalizeProject, migrateProjectToUnbounded, PROJECT_APP } = await import('./terrain-project-v5.js');
  const stack = defaultStack(); stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 25, scale: 260, seedOffset: 2 } }));
  const project = migrateProjectToUnbounded(normalizeProject({ app: PROJECT_APP, version: 1, name: 'H', cfg: { ...DEFAULT_CONFIG, seed: 4242 }, density: { ...DENSITY_DEFAULT_CONFIG }, stack, paint: null, imports: {} }).project);
  const scene = new THREE.Scene(), worldQuery = createWorldQueryService(), worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: v5Descriptor(project), useWorker: false, params: { renderRadius: 1 }, volumetric: true, farLod: true });
  terrain.setActive(true);
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  for (let i = 0; i < 10; i++) terrain.update([0, 0, 0], 1 / 60);
  const m1 = terrain.cascadeMaterialFor(1), m2 = terrain.cascadeMaterialFor(2), m3 = terrain.cascadeMaterialFor(3);
  ok(m1 && m2 && m3 && m1 !== terrain.splatMaterial && m1.userData.streamedSplat.hole, 'each cascade level has its own hole-capable splat instance');
  const h1 = [m1.userData.streamedSplat.uniforms.holeMin.value.x, m1.userData.streamedSplat.uniforms.holeMin.value.y, m1.userData.streamedSplat.uniforms.holeMax.value.x, m1.userData.streamedSplat.uniforms.holeMax.value.y];
  // exact chunks: radius 1 around chunk (0,0) = [-30, 60]; inset one chunk -> [0, 30]
  ok(h1[0] === 0 && h1[1] === 0 && h1[2] === 30 && h1[3] === 30, `level 1 hole is the exact square inset by a chunk (${h1.join(', ')})`);
  const h2 = m2.userData.streamedSplat.uniforms.holeMax.value.x, h3 = m3.userData.streamedSplat.uniforms.holeMax.value.x;
  ok(h2 === 3 * 120 - 120 && h3 === 3 * 480 - 480, `levels 2/3 hide inside the finer level's square (${h2}, ${h3})`);
  for (let i = 0; i < 10; i++) terrain.update([95, 0, 0], 1 / 60);
  const moved = m1.userData.streamedSplat.uniforms.holeMin.value.x;
  ok(moved === 90, `hole follows the player across chunks (min x ${moved}: chunk 3 square 60-150 inset by a chunk)`);
  const lvl1Mesh = terrain.volumeLod[0].system.group.children.find(c => c.isMesh);
  ok(!lvl1Mesh || lvl1Mesh.material === m1 || !lvl1Mesh.visible, 'level-1 chunks carry the hole material (or are batched under it)');
  terrain.dispose();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
