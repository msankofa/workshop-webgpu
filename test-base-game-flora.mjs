// test-base-game-flora.mjs — plants plan F5: the grass layer's wiring.
// The blades themselves need a GPU; what is testable here is everything around them — window
// references, the render-local/global boundary, the injected TSL graphs, and the clamps.
// node test-base-game-flora.mjs

import * as THREE from 'three';
import { Fn, float, vec2, uniform } from 'three/tsl';
import { createBaseGameFlora, safeRadiusFor, BASE_GAME_FLORA_DEFAULTS } from './base-game-flora.js';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { placeholderStreamedSplatTextures, createStreamedSplatMaterial } from './terrain-splat-streamed.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

function rig() {
  const scene = new THREE.Scene();
  const worldQuery = createWorldQueryService();
  const worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene, worldQuery, worldCoordinates,
    source: analyticDescriptor({ key: 'flora-test', seaLevel: 0 }), useWorker: false,
  });
  terrain.setActive(true);
  const flora = createBaseGameFlora({ scene, camera: new THREE.PerspectiveCamera(), terrain, worldCoordinates });
  return { scene, terrain, flora, worldCoordinates };
}
function settle(terrain, at = [0, 0, 0], frames = 60) {
  for (let i = 0; i < frames; i++) { terrain.update(at, 1 / 60); terrain.fieldScheduler.pump(); }
}

section('window references follow the toggle');
{
  const { terrain, flora } = rig();
  check('nothing streams before grass is enabled', terrain.fields === null && terrain.contactField === null);
  flora.setEnabled(true);
  check('enabling takes both the placement and contact windows', terrain.fields !== null && terrain.contactField !== null);
  check('the contact window is the exact one', terrain.contactField.lod === 0, `lod ${terrain.contactField.lod}`);
  check('and the placement window is band-limited', terrain.fields.lod > 0, `lod ${terrain.fields.lod}`);
  check('the contact window is fine, the placement window coarse',
    terrain.contactField.post < terrain.fields.post, `${terrain.contactField.post} vs ${terrain.fields.post}`);
  flora.setEnabled(false);
  check('disabling releases both', terrain.fields === null && terrain.contactField === null);
  check('toggling twice is idempotent', (flora.setEnabled(false), terrain.fields === null));
  terrain.dispose();
}

section('the radius is clamped to what the window can serve');
{
  const { terrain, flora } = rig();
  flora.setEnabled(true);
  settle(terrain);
  const safe = safeRadiusFor(terrain.contactField);
  // Half the extent less the half tile the origin snaps by: 160/2 - 20/2. No sqrt(2) — the corners
  // of a square are its farthest points, so a centred circle meets an edge long before a corner.
  check('a 160 m window serves a 70 m circle', Math.abs(safe - 70) < 0.01, `safe ${safe.toFixed(2)}`);
  check('it is short of the half extent by half a tile',
    Math.abs(safe - (terrain.contactField.extent / 2 - terrain.contactField.tileSize / 2)) < 1e-9);
  check('the default radius fits inside it', BASE_GAME_FLORA_DEFAULTS.grassRadius <= safe,
    `default ${BASE_GAME_FLORA_DEFAULTS.grassRadius} vs safe ${safe.toFixed(2)}`);

  // The placement window is what carries grass past the contact window's reach.
  const far = safeRadiusFor(terrain.fields);
  check('the placement window reaches far further', far > 900, `far ${far.toFixed(0)}`);
  check('and it carries a height field to plant on',
    terrain.fields.fields.includes('heights') || terrain.fields.fields.includes('surfaceHeights'),
    terrain.fields.fields.join(','));
  check('so the radius ceiling is the slider, not a window',
    BASE_GAME_FLORA_DEFAULTS.grassMaxRadius <= far, `${BASE_GAME_FLORA_DEFAULTS.grassMaxRadius} vs ${far.toFixed(0)}`);
  check('and nothing derives the ceiling from the current radius setting',
    !('maxRadiusHeadroom' in BASE_GAME_FLORA_DEFAULTS));
  flora.setEnabled(false);
  terrain.dispose();
}

section('grass tints toward what the ground actually shows');
{
  // The terrain draws splat TEXTURES when ground textures are on and the vertex tint only when they
  // are off, so tinting toward the tint unconditionally matches a colour that is not on screen.
  const { terrain, flora } = rig();
  check('with no textures the ground colour is ready anyway once splat is off',
    terrain.groundColorReady === false, 'splat defaults on, so it waits for the load');
  terrain.setSplatEnabled(false);
  check('turning ground textures off makes it immediately ready', terrain.groundColorReady === true);
  terrain.setSplatEnabled(true);
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex, {}), tex);
  check('loading textures makes it ready', terrain.groundColorReady === true);
  const node = terrain.groundColorNode();
  check('the ground colour node takes world xz as well as height', typeof node === 'function');
  check('and it samples the real maps, not just their averages', terrain.groundColorSamplesTextures === true);
  terrain.dispose();
}

section('the injected graphs build');
{
  const { terrain, flora } = rig();
  flora.setEnabled(true);
  settle(terrain);
  // The same shape base-game-flora builds internally: TSL node construction needs no GPU, so a
  // broken graph throws here rather than rendering as an empty field.
  const uOrigin = uniform(new THREE.Vector3(1000, 5, -2000));
  const originXZ = vec2(uOrigin.x, uOrigin.z);
  const height = terrain.contactField.gpuSampler('heights');
  const cover = terrain.fields.gpuSampler('coverGrass');
  let heightNode = null, densityNode = null, err = null;
  try {
    heightNode = Fn(([x, z]) => height(vec2(x, z).add(originXZ), float(-1e5)).sub(uOrigin.y));
    densityNode = Fn(([x, z]) => cover(vec2(x, z).add(originXZ), float(0)).div(255).clamp(0, 1));
    heightNode(float(3), float(4));
    densityNode(float(3), float(4));
  } catch (e) { err = e; }
  check('the height adapter builds and calls', heightNode && !err, String(err?.message ?? ''));
  check('the cover adapter builds and calls', densityNode && !err, String(err?.message ?? ''));

  // grass-compute takes two scalars, not a vec2: a mismatch must fail loudly at construction.
  const { createComputeGrass } = await import('./grass-compute.js');
  let rejected = false;
  try { createComputeGrass({ camera: new THREE.PerspectiveCamera(), heightNode: 'not a node' }); } catch { rejected = true; }
  check('a non-node heightNode is refused at construction', rejected);
  flora.setEnabled(false);
  terrain.dispose();
}

section('the render-local boundary');
{
  const { terrain, flora, worldCoordinates } = rig();
  flora.setEnabled(true);
  settle(terrain, [0, 0, 0]);
  const globalHeight = terrain.contactHeightAt(20, 20);
  check('the contact window resolves near the player', globalHeight !== null);

  // A rebase moves the origin under everything. The window is indexed globally, so the same world
  // point must still read the same height afterwards.
  worldCoordinates.setRenderOrigin([4000, 0, 4000]);
  settle(terrain, [4000, 0, 4000]);
  const afterFar = terrain.contactHeightAt(4020, 4020);
  check('a far point resolves after the rebase', afterFar !== null);
  check('and its height is the terrain height there', Math.abs(afterFar - terrain.groundHeight(4020, 4020)) < 1,
    `window ${afterFar} vs ground ${terrain.groundHeight(4020, 4020)}`);
  flora.setEnabled(false);
  terrain.dispose();
}

section('lifetime guards');
{
  const { terrain, flora } = rig();
  check('update before enabling is a no-op', (await flora.update(0.016)) === false);
  flora.setEnabled(true);
  // No renderer here, so the build cannot complete; it must report false, not throw.
  let threw = false;
  try { await flora.update(0.016); } catch { threw = true; }
  check('update without a renderer reports rather than throws', !threw);
  check('and nothing was built', flora.built === false);
  check('apply() before a build does not throw', (flora.apply({ grassDensity: 3 }), true));
  flora.dispose();
  check('dispose releases the windows', terrain.fields === null && terrain.contactField === null);
  terrain.dispose();
}

section('grass-compute injection points');
{
  const src = await import('node:fs').then(fs => fs.promises.readFile('./grass-compute.js', 'utf8'));
  check('the injected height wins over the texture path', /const heightFn = injectedHeight \? injectedHeight :/.test(src));
  check('the injected density wins too', /const densityFn = injectedDensity \? injectedDensity :/.test(src));
  check('injection disables the authored-map texture path', /const hasHeightTex = !injectedHeight/.test(src));
  check('both are validated', /heightNode must be a TSL node function/.test(src) && /densityNode must be a TSL node function/.test(src));
}

// The blade atlas is drawn on a canvas at construction; a stub is enough for the graph to build.
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {} }) }) };
const stubRenderer = { computeAsync: async () => {} };
function builtRig() {
  const scene = new THREE.Scene();
  const worldQuery = createWorldQueryService();
  const worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene, worldQuery, worldCoordinates,
    source: analyticDescriptor({ key: 'flora-built', seaLevel: 0 }), useWorker: false,
  });
  terrain.setActive(true);
  const camera = new THREE.PerspectiveCamera();
  const flora = createBaseGameFlora({ scene, renderer: stubRenderer, camera, terrain, worldCoordinates });
  return { terrain, flora, camera };
}

section('grass waits for the ground textures, whatever the toggle says');
{
  const { terrain, flora } = builtRig();
  // Textures off at boot: the vertex tint is what the ground shows NOW, but the maps are still
  // loading and the toggle can be turned on later, so a graph built here would never see them.
  terrain.setSplatEnabled(false);
  flora.setEnabled(true);
  settle(terrain);
  await flora.load();
  check('the terrain says its appearance is knowable with textures off', terrain.groundColorReady === true);
  check('but the maps have not arrived', terrain.groundTexturesLoaded === false);
  check('so grass does not build yet', (await flora.update(0.016)) === false && flora.built === false);
  check('and the stats say what it waits on', flora.stats.waitingOnTextures === true);
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  check('grass builds once they land', (await flora.update(0.032)) === true && flora.built === true);
  check('and the wait is over', flora.stats.waitingOnTextures === false);
  flora.dispose();
  terrain.dispose();
}

section('the mip slider forces a recull');
{
  const { terrain, flora } = builtRig();
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  flora.setEnabled(true);
  settle(terrain);
  await flora.load();
  check('grass is built', (await flora.update(0.016)) === true);
  check('the build cleared the dirty flag', flora.grass.stats.dirty === false);
  flora.apply({ grassGroundTintMip: BASE_GAME_FLORA_DEFAULTS.grassGroundTintMip });
  check('applying the same mip does not recull', flora.grass.stats.dirty === false);
  flora.apply({ grassGroundTintMip: BASE_GAME_FLORA_DEFAULTS.grassGroundTintMip + 2 });
  check('a new mip marks the cull dirty, since the colour is read there', flora.grass.stats.dirty === true);
  check('the colour mode starts on the palette', flora.grass.colorMode === 'palette');
  flora.apply({ grassColorMode: 'proof' });
  check('and apply() switches it', flora.grass.colorMode === 'proof');
  flora.apply({ grassColorMode: 'nonsense' });
  check('an unknown mode is ignored', flora.grass.colorMode === 'proof');
  flora.apply({ grassFaceNormalMix: 0.2 });
  check('the face-normal mix reaches grass-look', flora.grass.getLook().faceNormalMix === 0.2);
  // The fade controls, through apply(): 0 means "as before" for every one of them.
  const r = flora.grass.fade.end;
  check('the fade ends at the radius with the defaults', r === flora.stats.radius && r > flora.grass.fade.start, `${r} vs ${flora.stats.radius}`);
  const fadeEnd = Math.round((flora.grass.fade.start + r) / 2);
  flora.apply({ grassFadeEnd: fadeEnd, grassFadeCurve: 2.5, grassFadeHeight: 1, grassFadeWidth: 0.5,
    grassTintFadeStart: 5, grassTintFadeEnd: 20, grassNearFadeStart: 0.5, grassNearFadeEnd: 2 });
  const f = flora.grass.fade;
  check('every fade control reaches grass-compute', f.end === fadeEnd && f.curve === 2.5 && f.height === 1 && f.width === 0.5
    && f.tintStart === 5 && f.tintEnd === 20 && f.nearStart === 0.5 && f.nearEnd === 2, JSON.stringify(f));
  flora.apply({ grassFadeEnd: 0, grassTintFadeStart: 0, grassTintFadeEnd: 0 });
  check('and 0 hands them back to the radius and the keep band', flora.grass.fade.end >= r - 1e-6 && flora.grass.fade.tintStart === flora.grass.fade.start);
  const before = flora.stats.handover;
  flora.apply({ grassHandoverDistance: 30, grassNearFade: 5 });
  await flora.update(0.05);
  check('the height handover is exposed', before && flora.stats.handover.distance === 30 && flora.stats.handover.band === 5, JSON.stringify(flora.stats.handover));
  flora.dispose();
  terrain.dispose();
}

section('expectedBlades integrates the fade curve');
{
  const { expectedBlades } = await import('./base-game-flora.js');
  // The old closed form for the linear ramp, to pin the new one against.
  const old = (r, d, c) => { const b = r - c; return Math.round((Math.PI * c * c + (2 * Math.PI / b) * (r * (r * r - c * c) / 2 - (r ** 3 - c ** 3) / 3)) * d); };
  check('the linear ramp to the radius is unchanged', expectedBlades(100, 12, 80) === old(100, 12, 80), `${expectedBlades(100, 12, 80)} vs ${old(100, 12, 80)}`);
  check('a fade ending short of the radius holds fewer blades', expectedBlades(100, 12, 80, 90) < expectedBlades(100, 12, 80));
  check('a curve above 1 keeps more of the band', expectedBlades(100, 12, 80, 0, 3) > expectedBlades(100, 12, 80));
  check('and below 1 fewer', expectedBlades(100, 12, 80, 0, 0.5) < expectedBlades(100, 12, 80));
  check('a fade end at the start is the inner disc alone', expectedBlades(100, 12, 80, 80) === Math.round(Math.PI * 80 * 80 * 12));
}

section('cover floor and distance tiers reach the cull');
{
  const { tierSpecFor, expectedBlades } = await import('./base-game-flora.js');
  check('no radii is one tier', JSON.stringify(tierSpecFor({})) === JSON.stringify([{ radius: Infinity, density: 1 }]));
  check('a mid radius alone makes two tiers', tierSpecFor({ grassTierMid: 30, grassMidDensity: 0.5 }).length === 2);
  const three = tierSpecFor({ grassTierMid: 30, grassTierFar: 120, grassMidDensity: 0.5, grassFarDensity: 0.25 });
  check('mid and far make three, the last open-ended', three.length === 3 && three[1].radius === 120 && three[2].radius === Infinity && three[2].density === 0.25);
  check('a far radius alone is two tiers too', tierSpecFor({ grassTierFar: 120, grassFarDensity: 0.25 }).length === 2);
  check('a far radius inside the mid one is ignored', tierSpecFor({ grassTierMid: 30, grassTierFar: 20 }).length === 2);
  check('tiered expected blades are fewer', expectedBlades(100, 12, 80, 0, 1, [{ radius: 30, density: 1 }, { radius: Infinity, density: 0.25 }]) < expectedBlades(100, 12, 80));
  const numeric = expectedBlades(100, 12, 80, 0, 1, [{ radius: 20, density: 1 }, { radius: Infinity, density: 1 }]);
  check('the numeric integral matches the closed form', Math.abs(numeric / expectedBlades(100, 12, 80) - 1) < 0.002, `${numeric} vs ${expectedBlades(100, 12, 80)}`);
  const { terrain, flora } = builtRig();
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  flora.setEnabled(true);
  settle(terrain);
  await flora.load();
  await flora.update(0.016);
  check('the build leaves the cull clean', flora.grass.stats.dirty === false);
  flora.apply({ grassCoverFloor: 0.3 });
  check('a cover floor reculls, since the cull reads it', flora.grass.stats.dirty === true);
  await flora.update(0.05);
  flora.apply({ grassTierMid: 20, grassMidDensity: 0.5 });
  await flora.update(0.1);
  check('tiers reach grass-compute and the stats', flora.stats.tiers?.length === 2 && Math.abs(flora.stats.tiers[1].density - flora.stats.density * 0.5) < 0.5, JSON.stringify(flora.stats.tiers));
  flora.dispose();
  terrain.dispose();
}

section('the buffer and the cell cap rebuild; the draw controls do not');
{
  const { terrain, flora } = builtRig();
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  flora.setEnabled(true);
  settle(terrain);
  await flora.load();
  await flora.update(0.016);
  const first = flora.grass, capacity = flora.stats.capacity;
  flora.apply({ grassShading: 'lambert', grassReceiveShadow: false, grassFrustumCull: false, grassNearKeep: 10 });
  check('shading, shadows and the cone reach the mesh without a rebuild', flora.grass === first && first.shading === 'lambert'
    && first.mesh.receiveShadow === false && first.frustumCull === false);
  flora.apply({ grassBufferMB: 32 });
  check('a smaller buffer tears the grass down', flora.built === false && flora.grass === null && flora.stats.rebuilds === 1);
  await flora.update(0.05);
  check('and the next update builds it again, smaller', flora.built === true && flora.stats.capacity < capacity, `${flora.stats.capacity} vs ${capacity}`);
  check('the rebuilt grass keeps the draw controls', flora.grass.shading === 'lambert' && flora.grass.mesh.receiveShadow === false);
  flora.apply({ grassKmax: 64 });
  await flora.update(0.1);
  check('the cell cap rebuilds too and caps the density', flora.stats.rebuilds === 2 && flora.stats.maxDensity === 16);
  flora.dispose();
  terrain.dispose();
}

section('far blades stand on the drawn rings when there are rings');
{
  const { terrain, flora } = builtRig();
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  flora.setEnabled(true);
  settle(terrain);
  await flora.load();
  await flora.update(0.016);
  check('without far LOD the drawn source falls back to the field and says so', flora.stats.heightSource === 'field (no rings)', flora.stats.heightSource);
  flora.dispose();
  terrain.dispose();

  const scene = new THREE.Scene();
  const worldCoordinates = createWorldCoordinateSpace();
  const withRings = createBaseGameTerrain({
    scene, worldQuery: createWorldQueryService(), worldCoordinates,
    source: analyticDescriptor({ key: 'flora-rings', seaLevel: 0 }), useWorker: false, farLod: true,
  });
  withRings.setActive(true);
  withRings.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  const flora2 = createBaseGameFlora({ scene, renderer: stubRenderer, camera: new THREE.PerspectiveCamera(), terrain: withRings, worldCoordinates });
  flora2.setEnabled(true);
  settle(withRings, [0, 0, 0], 200);
  await flora2.load();
  await flora2.update(0.016);
  check('with far LOD the drawn rings are the source', flora2.stats.heightSource === 'drawn', flora2.stats.heightSource);
  check('the build leaves the cull clean', flora2.grass.stats.dirty === false);
  flora2.apply({ grassHeightSource: 'field' });
  check('switching to the field reculls', flora2.grass.stats.dirty === true);
  await flora2.update(0.05);
  check('and the stats follow', flora2.stats.heightSource === 'field');
  // The CPU twin: the drawn height near the focus is the 2 m ring, within a metre of the ground.
  const drawn = withRings.drawnHeightAt(120, 80), ground = withRings.groundHeight(120, 80);
  check('the terrain exposes the drawn height on the CPU', Number.isFinite(drawn), String(drawn));
  check('and near the focus it is the ground within a metre', Number.isFinite(drawn) && Math.abs(drawn - ground) < 1, `${drawn} vs ${ground}`);
  flora2.dispose();
  withRings.dispose();
}

section('new windows mean a new graph');
{
  // The registry disposes a window when its last holder releases it, and the terrain re-keys
  // its windows on a source swap that changes the field set; a graph built on the old ones read
  // dead textures and drew nothing (the "0 grass after applying a draft" bug).
  const { terrain, flora } = builtRig();
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  flora.setEnabled(true);
  settle(terrain);
  await flora.load();
  await flora.update(0.016);
  const fieldsBefore = terrain.fields, grassBefore = flora.grass;
  flora.setEnabled(false);
  check('switching grass off tears the graph down with its windows', flora.built === false && flora.grass === null);
  flora.setEnabled(true);
  settle(terrain);
  check('re-enabling takes new window objects', terrain.fields !== fieldsBefore);
  await flora.update(0.05);
  check('and builds a new graph on them', flora.built === true && flora.grass !== grassBefore && flora.stats.rebuilds === 1);
  // Windows swapped under a live graph, the way reopenFieldWindow does it on a source swap: the
  // flora compares the window objects it built on with the terrain's current ones every update.
  const src = await import('node:fs').then(fs => fs.promises.readFile('./base-game-flora.js', 'utf8'));
  check('a window swap under a live graph rebuilds it on the next update',
    /terrain\.fields !== builtWith\.fields \|\| terrain\.contactField !== builtWith\.contact\)\) rebuild\(\)/.test(src));
  flora.dispose();
  terrain.dispose();
}

section('the ground colour probe and its CPU twin');
{
  const { terrain, flora } = builtRig();
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  flora.setEnabled(true);
  settle(terrain);
  await flora.load();
  await flora.update(0.016);
  check('grass exposes a ground probe when the colour is injected', flora.grass.hasGroundProbe === true);
  const twin = terrain.groundColorAt(10, 10);
  check('the terrain has a CPU twin of the ground colour', Array.isArray(twin) && twin.length === 3 && twin.every(Number.isFinite));
  terrain.setSplatEnabled(false);
  const tint = terrain.groundColorAt(10, 10);
  check('with textures off the twin is the vertex tint', Array.isArray(tint) && tint.some((v, i) => Math.abs(v - twin[i]) > 1e-6));
  check('no readback runs without a renderer that can read buffers', flora.stats.drawn === null && flora.stats.probe === null);
  check('the stats carry the placement window coverage', typeof flora.stats.placementCoverage === 'number');
  flora.dispose();
  terrain.dispose();
}

section('mesh subscribers release retired grass on every lifecycle path');
{
  const { terrain, flora } = builtRig();
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  const registered = new Set();
  const removed = [];
  flora.onMesh((mesh, previous) => {
    if (previous) { registered.delete(previous); removed.push(previous); }
    if (mesh) registered.add(mesh);
  });
  await flora.load();
  flora.setEnabled(true);
  settle(terrain);
  await flora.update(0);
  const first = flora.grass.mesh;
  check('the initial mesh is registered once', registered.size === 1 && registered.has(first));
  flora.apply({ grassBufferMB: 8 });
  check('a buffer rebuild unregisters the old mesh immediately', registered.size === 0 && removed.includes(first));
  await flora.update(1);
  check('only the rebuilt mesh is retained', registered.size === 1 && registered.has(flora.grass.mesh) && !registered.has(first));
  flora.setEnabled(false);
  check('disabling releases the replacement', registered.size === 0);
  flora.setEnabled(true);
  settle(terrain);
  await flora.update(2);
  check('re-enabling registers one new mesh', registered.size === 1);
  flora.dispose();
  check('disposal unregisters the final mesh', registered.size === 0 && removed.length === 3);
  flora.dispose();
  check('repeated disposal emits no duplicate removal', removed.length === 3);
  terrain.dispose();
}

section('diagnostics are opt-in, sequential, and cannot publish retired results');
{
  const { terrain, flora } = builtRig();
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  flora.setEnabled(true);
  settle(terrain);
  await flora.load();
  await flora.update(0);
  stubRenderer.getArrayBufferAsync = async () => new ArrayBuffer(4);
  const calls = [];
  let finishCount, finishProbe;
  const pendingCounts = () => {
    calls.push('count');
    return new Promise(resolve => { finishCount = survivors => resolve({
      survivors, planar: 1, density: 2, ground: 3, view: 4, occlusion: 5, overflow: 0,
    }); });
  };
  flora.grass.readCullCounts = pendingCounts;
  flora.grass.readGroundProbe = (x, z) => {
    calls.push([x, z]);
    return new Promise(resolve => { finishProbe = resolve; });
  };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const probeResult = r => ({ r, g: 0, b: 0, y: 1, density: 1, inCone: true, aboveWater: true });
  await flora.update(2);
  check('a hidden panel submits no GPU reads', calls.length === 0);
  flora.setDiagnosticsEnabled(true);
  await flora.update(3);
  check('opting in starts the count read', calls.length === 1 && calls[0] === 'count');
  finishCount(42);
  await flush();
  check('only the first probe is submitted', calls.length === 2);
  await flora.update(5);
  check('an in-flight sample prevents overlapping samples', calls.length === 2);
  finishProbe(probeResult(0.25));
  await flush();
  check('the ring probe starts after the first readback', calls.length === 3 && calls[2][0] !== calls[1][0]);
  finishProbe(probeResult(0.75));
  await flush();
  check('the camera probe keeps its own value', flora.stats.drawn === 42 && flora.stats.probe.r === 0.25);
  check('the staged rejection counters publish with the survivor count',
    flora.stats.cull.survivors === 42 && flora.stats.cull.occlusion === 5);
  await flora.update(6);
  const oldCount = finishCount;
  flora.apply({ grassBufferMB: 8 });
  oldCount(999);
  await flush();
  check('a retired sample cannot update stats or submit more probes', flora.stats.drawn === null && calls.length === 4);
  await flora.update(7);
  flora.grass.readCullCounts = () => { calls.push('new count'); return new Promise(resolve => {
    finishCount = survivors => resolve({ survivors, planar: 0, density: 0, ground: 0, view: 0, occlusion: 0, overflow: 0 });
  }); };
  flora.setDiagnosticsEnabled(false);
  await flora.update(9);
  check('disabling stops subsequent readbacks', calls.length === 4);
  flora.setDiagnosticsEnabled(true, { groundProbes: false });
  flora.grass.readGroundProbe = () => { throw new Error('HUD must not submit ground probes'); };
  await flora.update(10);
  finishCount(27);
  await flush();
  check('HUD-only sampling reads the count without ground probes', flora.stats.drawn === 27 && flora.stats.probe === null);
  check('HUD counts carry a fresh view and occlusion mode',
    Number.isFinite(flora.stats.drawnSample?.atMs) && flora.stats.drawnSample.view.length === 23
    && flora.stats.drawnSample.occlusion === false);
  await flora.update(12);
  flora.setDiagnosticsEnabled(false, { groundProbes: false });
  finishCount(999);
  await flush();
  check('hiding the HUD discards an in-flight count and its metadata', flora.stats.drawn === null && flora.stats.drawnSample === null);
  delete stubRenderer.getArrayBufferAsync;
  flora.dispose();
  terrain.dispose();
}

section('occlusion root refreshes preserve the requested toggle and retire old roots');
{
  const { terrain, flora } = rig();
  const building = new THREE.Group(), terrainRoot = new THREE.Group();
  const terrainMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  terrainRoot.add(terrainMesh);
  flora.setOccluders([building, terrainRoot]);
  flora.setOcclusionEnabled(false);
  flora.setOccluders([building, terrainRoot]);
  check('refreshing roots cannot silently turn requested occlusion back on', flora.occlusion.enabled === false);
  flora.setOccluders([building]);
  check('removing terrain retires its occluder layer immediately', !terrainMesh.layers.isEnabled(2));
  flora.setOcclusionEnabled(true);
  check('the requested toggle can enable the remaining root set', flora.occlusion.enabled === true);
  flora.setOccluders([]);
  check('an empty root set disables the pass', flora.occlusion.enabled === false);
  flora.setOccluders([building]);
  check('adding roots restores the requested enabled state', flora.occlusion.enabled === true);
  flora.dispose(); terrain.dispose(); terrainMesh.geometry.dispose(); terrainMesh.material.dispose();
}

section('settings-derived telemetry is reused until its inputs change');
{
  const { terrain, flora } = builtRig();
  const tex = placeholderStreamedSplatTextures();
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex), tex);
  flora.setEnabled(true); settle(terrain); await flora.load();
  flora.apply({ grassTierMid: 20, grassMidDensity: 0.5 });
  await flora.update(0);
  const tint = flora.stats.groundTint, fade = flora.stats.fade, handover = flora.stats.handover;
  const expected = flora.stats.expected;
  for (let i = 1; i <= 10; i++) await flora.update(i / 60);
  check('idle frames reuse their diagnostic objects', tint === flora.stats.groundTint && fade === flora.stats.fade && handover === flora.stats.handover);
  check('the tiered expected count stays accurate', flora.stats.expected === expected);
  flora.apply({ grassDensity: 6, grassFadeCurve: 2, grassNearFade: 5 });
  await flora.update(1);
  check('new settings refresh telemetry', flora.stats.expected !== expected && flora.stats.handover.band === 5 && flora.stats.fade !== fade);
  flora.dispose(); terrain.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
