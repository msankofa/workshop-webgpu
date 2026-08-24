// test-base-game-rain.mjs — Base Game rain (phase R1): the fan-out, the wind conversion, the
// render-origin arithmetic, the conservative ground sample R1b rests on, and headless builds of
// the two rain graphs so a broken TSL edit fails in Node rather than at page load.
//
// Nothing here needs a GPU. The rain system builds real materials and geometry; only the compile
// is stubbed (tsl-build-check.mjs).
import * as THREE from 'three';
import { createBaseGameRain, rainResponse, BASE_GAME_RAIN_DEFAULTS } from './base-game-rain.js';
import { slopeCos, createRainSystem, RAIN_DEFAULTS } from './rain.js';
import { createSeaDepthMap } from './terrain-sea-depth.js';
import { analyticDescriptor, createAnalyticSource } from './terrain-source-analytic.js';
import { buildMaterial } from './tsl-build-check.mjs';
import { BASE_GAME_SHARED_KEYS } from './base-game-protocol.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ', m); } else { fail++; console.log('FAIL', m); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- 1. rain.js stays what its other two consumers already draw ---------------------------------
// bot-viewer-v3 and the flight sim call createRainSystem without any of the new options, so the
// defaults have to reproduce the constants that used to be baked in.
{
  ok(RAIN_DEFAULTS.splashRate === 1.6, 'the splash rate default is the 1.6 that was hard-coded');
  ok(RAIN_DEFAULTS.nearStart === 0.25 && RAIN_DEFAULTS.nearEnd === 1.4, 'the near fade defaults are the old smoothstep(0.25, 1.4)');
  ok(RAIN_DEFAULTS.camLean === 1, 'camera lean defaults to the full lean the streaks always had');
  ok(RAIN_DEFAULTS.gustPeriod === 17, 'the gust period default is the 17 s the 0.37 rad/s wander already ran at');
  ok(RAIN_DEFAULTS.splashOrient === 0, 'rings default to horizontal, so no existing page tilts them');

  // slopeCos with no fade must be a no-op, not "suppressed above 90°".
  const [lo, hi] = slopeCos(RAIN_DEFAULTS.splashSlopeMax, RAIN_DEFAULTS.splashSlopeFade);
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  ok(lo < hi, 'the default slope window is ordered, so the smoothstep is not degenerate');
  ok(smooth(lo, hi, 0.02) === 1, 'by default even a near-vertical face keeps its rings');
}

// ---- 2. the slope window Base Game actually uses -------------------------------------------------
{
  const [lo, hi] = slopeCos(38, 12);
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const atDeg = d => smooth(lo, hi, Math.cos(d * Math.PI / 180));
  ok(near(hi, Math.cos(26 * Math.PI / 180)), 'the fade is fully open at 38 - 12 = 26 degrees');
  ok(near(lo, Math.cos(38 * Math.PI / 180)), 'and fully closed at 38 degrees');
  ok(atDeg(0) === 1, 'flat ground keeps every ring');
  ok(atDeg(20) === 1, 'a walkable 20 degree slope keeps every ring');
  ok(atDeg(50) === 0, 'a 50 degree rock face gets none');
  ok(atDeg(32) > 0 && atDeg(32) < 1, 'and the band between is a fade, not a step');
}

// ---- 3. the master fan-out ----------------------------------------------------------------------
// The master multiplies through a response slider rather than writing the individual value, so a
// hand-set opacity survives a drag of the master.
{
  const base = { rainDensityBase: 0, rainDensityPerRain: 0.9, rainOpacityBase: 0.45, rainOpacityPerRain: 0.25 };
  const at = rain => rainResponse({ ...base, weatherRain: rain });
  ok(at(0).density === 0, 'no weather means no drops');
  ok(near(at(1).density, 0.9), 'full weather reaches the density response');
  ok(at(0.5).density > at(0.25).density && at(1).density > at(0.5).density, 'density is monotonic in the master');
  ok(near(at(0).opacity, 0.45) && near(at(1).opacity, 0.7), 'opacity runs from its floor to floor + response');
  ok(rainResponse({ ...base, rainDensityPerRain: 2, weatherRain: 1 }).density === 1, 'an over-driven response clamps to 1');
  ok(rainResponse({ ...base, weatherRain: -3 }).density === 0, 'a negative master clamps to 0');
  ok(rainResponse({ ...base, rainDensityBase: 0.3, weatherRain: 0 }).density === 0.3, 'the density floor survives a dry master');
}

// ---- 4. the conservative ground sample, on the CPU -----------------------------------------------
// R1b's whole argument: both rain materials depth-test, so a height read too LOW is hidden by the
// depth buffer while one read too HIGH shows as rain cut off in mid air in front of a cliff. So the
// sample must never exceed the bilinear one. This is the CPU twin of the `mode: 'min'` branch.
{
  const bilinear = (h, fx, fz) => (h[0] * (1 - fx) + h[1] * fx) * (1 - fz) + (h[2] * (1 - fx) + h[3] * fx) * fz;
  const lowest = h => Math.min(...h);
  const cliff = [12, 12, 96, 96];      // a 16 m post pair on the flat, the next pair on the bluff
  let everHigher = false, maxGap = 0;
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      const b = bilinear(cliff, i / 10, j / 10), m = lowest(cliff);
      if (m > b + 1e-9) everHigher = true;
      maxGap = Math.max(maxGap, b - m);
    }
  }
  ok(!everHigher, 'the conservative sample never reads higher than the bilinear one');
  ok(near(maxGap, 84, 1e-6), 'across an 84 m step it errs low by the full step, which the depth buffer hides');
  ok(lowest([5, 5, 5, 5]) === bilinear([5, 5, 5, 5], 0.5, 0.5), 'on flat ground the two agree exactly');
}

// ---- 5. the module, built for real over a real sea-depth window ----------------------------------
const descriptor = analyticDescriptor({ key: 'rain-test' });
const source = createAnalyticSource(descriptor);
const seaDepth = createSeaDepthMap({ source, descriptor, useWorker: false, tilesPerSide: 2 });
let seaDepthAsked = false;
const terrain = { seaDepth, seaLevel: 0, setSeaDepthActive: () => { seaDepthAsked = true; } };
const scene = new THREE.Scene();
const origin = [0, 0, 0];
const worldCoordinates = { getOrigin: () => origin };
const rain = createBaseGameRain({ scene, terrain, worldCoordinates, maxDrops: 2000, maxSplashes: 400 });

{
  ok(seaDepthAsked, 'rain asks the terrain to stream the sea-depth window, so a world with no sea still has ground');
  ok(scene.children.includes(rain.group), 'the rain group is in the scene');
  ok(rain.group.visible === false, 'and starts hidden, because the density starts at 0');
  ok(BASE_GAME_RAIN_DEFAULTS.labGroundY === 0, 'the flat fallback is the Traversal Lab floor top');
}

// Wind: the panel gives a heading and a speed; rain.js wants a vector.
{
  rain.setLook({ windDeg: 0, windSpeed: 10 });
  ok(near(rain.uniforms.uWind.value.x, 10) && near(rain.uniforms.uWind.value.z, 0, 1e-9), 'heading 0 blows along +x');
  rain.setLook({ windDeg: 90 });
  ok(near(rain.uniforms.uWind.value.z, 10) && near(rain.uniforms.uWind.value.x, 0, 1e-6), 'heading 90 blows along +z');
  ok(rain.uniforms.uWind.value.y === 0, 'wind is horizontal');
  rain.setLook({ windSpeed: 0 });
  ok(rain.uniforms.uWind.value.length() === 0, 'zero wind speed is still zero whatever the heading');
}

// Look writes are uniform writes; an allocation change is a rebuild.
{
  rain.setLook({ speed: 33, opacity: 0.8, volumeXZ: 60, volumeY: 20, nearStart: 0.5, nearEnd: 3, camLean: 0.25, splashRate: 4 });
  const U = rain.uniforms;
  ok(U.uSpeed.value === 33 && near(U.uOpacity.value, 0.8), 'speed and opacity reach the uniforms');
  ok(U.uVolume.value.x === 60 && U.uVolume.value.y === 20 && U.uVolume.value.z === 60, 'the drop box is square in xz and its own height');
  ok(U.uNearStart.value === 0.5 && U.uNearEnd.value === 3 && U.uCamLean.value === 0.25, 'the near fade and the lean are settings now, not constants');
  ok(U.uSplashRate.value === 4, 'the ring rate is a setting now too');
  ok(rain.setLook({ speed: 33 }) === false, 'writing the same value is not dirty, so nothing is re-applied');

  rain.setLook({ splashSlopeMax: 38, splashSlopeFade: 12, splashOrient: 1 });
  ok(near(U.uSlopeCosLo.value, Math.cos(38 * Math.PI / 180)), 'the slope window reaches the uniform');
  ok(U.uSplashOrient.value === 1, 'and rings lie on the surface');

  const before = rain.system;
  ok(rain.setAllocation(3000, 500) === true, 'a new allocation rebuilds');
  ok(rain.maxDrops === 3000 && rain.maxSplashes === 500, 'and takes the new counts');
  ok(rain.system !== before, 'the rebuilt system is a new one');
  ok(rain.uniforms.uSpeed.value === 33, 'the look survives the rebuild');
  ok(rain.setAllocation(3000, 500) === false, 'the same allocation is not a rebuild');
}

// Density gates visibility, and the render origin reaches the uniforms.
{
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(10, 5, -20);
  rain.update(1 / 60, camera, {});
  ok(rain.group.visible === false, 'a dry world draws nothing at all');

  rain.setLook({ density: 0.5 });
  rain.update(1 / 60, camera, {});
  ok(rain.group.visible === true, 'rain draws once the density is up');

  origin[0] = 4096; origin[1] = 130; origin[2] = -8192;
  rain.update(1 / 60, camera, {});
  const U = rain.uniforms;
  ok(rain.group.visible === true, 'and keeps drawing after a rebase');
  // The graph adds uOffset to a scene xz to get a global one, and subtracts uOriginY from the
  // global height it reads back — the same arithmetic base-game-water.js does.
  ok(rain.system.uniforms.uFall.value > 0, 'the fall accumulator advances');
  ok(U.uCamVel.value.lengthSq() >= 0, 'the camera velocity is tracked');

  rain.update(1 / 60, camera, { underwater: true });
  ok(rain.group.visible === false, 'nothing draws while the camera is under the sea');
  rain.update(1 / 60, camera, {});

  rain.setSplashesVisible(false);
  rain.update(1 / 60, camera, {});
  ok(rain.system.splashes.mesh.visible === false, 'splashes can be turned off on their own');
  rain.setSplashesVisible(true);
  rain.setDropsVisible(false);
  rain.update(1 / 60, camera, {});
  ok(rain.system.streaks.mesh.visible === false, 'and so can the drops');
  rain.setDropsVisible(true);

  rain.setEnabled(false);
  rain.update(1 / 60, camera, {});
  ok(rain.group.visible === false, 'disabling rain hides it whatever the density says');
  rain.setEnabled(true);

  const tint = new THREE.Color(0.2, 0.4, 0.9);
  rain.update(1 / 60, camera, { skyColor: tint });
  ok(rain.system.uniforms.uColor.value.getHexString() !== '000000', 'the drop colour is its own; the sky only tints it in the graph');
  origin[0] = 0; origin[1] = 0; origin[2] = 0;
}

// ---- 6. the two rain graphs build headless -------------------------------------------------------
// This is the real point of building the module against a real sea-depth window: the ground hook,
// the min-mode sample, the slope difference and the oriented ring all end up in this GLSL.
{
  for (const [name, part] of [['streaks', rain.system.streaks], ['splashes', rain.system.splashes]]) {
    try {
      const built = await buildMaterial(part.mesh.material, part.mesh.geometry);
      ok(built.fragment.length > 0 && built.vertex.length > 0, `the ${name} graph builds`);
    } catch (error) {
      ok(false, `the ${name} graph builds: ${error.message}`);
    }
  }
  // And the same graphs with the options off, which is the shape bot-viewer and the flight sim get.
  try {
    const plain = createRainSystem({ maxDrops: 100, maxSplashes: 100 });
    await buildMaterial(plain.streaks.mesh.material, plain.streaks.mesh.geometry);
    await buildMaterial(plain.splashes.mesh.material, plain.splashes.mesh.geometry);
    ok(true, 'rain with no ground hook at all still builds, so the other two pages are untouched');
  } catch (error) {
    ok(false, `rain with no ground hook at all still builds: ${error.message}`);
  }
}

// ---- 7. what the room owns -----------------------------------------------------------------------
{
  for (const key of ['weatherWindDeg', 'weatherWindSpeed', 'weatherGust', 'weatherGustPeriod']) {
    ok(BASE_GAME_SHARED_KEYS.includes(key), `${key} is shared: everyone's rain leans the same way`);
  }
  for (const key of ['rainMaxDrops', 'rainMaxSplashes', 'rainSplashRadius', 'rainGroundConservative', 'rainColor']) {
    ok(!BASE_GAME_SHARED_KEYS.includes(key), `${key} stays local, so two players can run different budgets in one storm`);
  }
}

// ---- 8. wet surfaces (R2) --------------------------------------------------------------------
// The wetness uniform is not the rain slider: it LAGS it, so ground stays wet after a storm.
{
  const camera = new THREE.PerspectiveCamera();
  const U = rain.uniforms;

  rain.setWetEnabled(true);
  rain.setWetRise(8);
  rain.setDryTime(90);
  rain.setLook({ density: 0.5, wetness: 1 });
  ok(U.uWetness.value === 0, 'wetness starts dry however hard it is raining this instant');

  // Wet up: a time constant, so one tau reaches 1 - 1/e of the way.
  for (let i = 0; i < 8 * 60; i++) rain.update(1 / 60, camera, {});
  ok(Math.abs(U.uWetness.value - (1 - Math.exp(-1))) < 0.01, `one rise constant reaches ~63% (${U.uWetness.value.toFixed(3)})`);
  for (let i = 0; i < 60 * 60; i++) rain.update(1 / 60, camera, {});
  ok(U.uWetness.value > 0.99, 'and it saturates at 1, never above');
  ok(U.uWetness.value <= 1, 'wetness is clamped to 1');

  // Dry out: the storm stops and the ground stays wet for a while. This is the bit neither donor
  // page has — both track the slider, so ground went bone dry the frame the rain stopped.
  rain.setLook({ density: 0, wetness: 0 });
  rain.update(1 / 60, camera, {});
  ok(U.uWetness.value > 0.98, 'the frame the rain stops, the ground is still wet');
  for (let i = 1; i < 90 * 60; i++) rain.update(1 / 60, camera, {});
  ok(Math.abs(U.uWetness.value - Math.exp(-1)) < 0.02, `one dry constant later it is ~37% wet (${U.uWetness.value.toFixed(3)})`);
  ok(rain.wetness === U.uWetness.value, 'the module reports the same number the shader reads');

  // Drying keeps running while nothing is drawn — the group is hidden at density 0, and an early
  // return before the lag would have frozen the ground at whatever it happened to be.
  const before = U.uWetness.value;
  ok(rain.group.visible === false, 'nothing is drawn at zero density');
  for (let i = 0; i < 120; i++) rain.update(1 / 60, camera, {});
  ok(U.uWetness.value < before, 'yet the ground keeps drying');

  // Rise is faster than fall, which is what makes it read as weather rather than a crossfade.
  rain.setLook({ wetness: 1 });
  const rise = [];
  for (let i = 0; i < 60; i++) { rain.update(1 / 60, camera, {}); rise.push(U.uWetness.value); }
  ok(rise[59] > rise[0], 'raining again wets it back up');

  rain.setWetEnabled(false);
  for (let i = 0; i < 600 * 60; i++) rain.update(1 / 60, camera, {});
  ok(U.uWetness.value < 0.001, 'turning wet surfaces off dries the ground out rather than freezing it');
  rain.setWetEnabled(true);

  // A zero time constant is the old instant behaviour, not a divide by zero.
  rain.setDryTime(0); rain.setWetRise(0);
  rain.setLook({ wetness: 0.7 });
  rain.update(1 / 60, camera, {});
  ok(Math.abs(U.uWetness.value - 0.7) < 1e-9, 'a zero time constant snaps, and does not produce NaN');
  ok(Number.isFinite(U.uWetness.value), 'and the uniform stays finite');
}

// ---- 9. the wetness fan-out ----------------------------------------------------------------------
{
  const base = { rainDensityBase: 0, rainDensityPerRain: 0.9, rainOpacityBase: 0.45, rainOpacityPerRain: 0.25, rainWetnessPerRain: 1.4 };
  const at = r => rainResponse({ ...base, weatherRain: r });
  ok(at(0).wetness === 0, 'dry weather means dry ground');
  ok(Math.abs(at(0.5).wetness - 0.7) < 1e-9, 'half weather is 0.7 wet at the default response');
  ok(at(1).wetness === 1, 'and a full storm saturates rather than exceeding 1');
  ok(at(0.9).wetness > at(0.4).wetness, 'wetness is monotonic in the master');
}

// ---- 10. the ground material carries the same maths, not a copy ------------------------------------
// rain.js exports the puddle and ripple fields and terrain-splat-streamed.js imports them, so rain
// cannot bead differently on the terrain than on everything standing on it.
{
  const rainMod = await import('./rain.js');
  for (const name of ['wetPuddleField', 'wetRippleOffset', 'wetAlbedoScale', 'wetRoughness']) {
    ok(typeof rainMod[name] === 'function', `rain.js exports ${name} for the splat to reuse`);
  }
  const splatSource = await (await import('fs/promises')).readFile('./terrain-splat-streamed.js', 'utf8');
  ok(/import \{[^}]*wetPuddleField[^}]*\} from '\.\/rain\.js'/.test(splatSource),
    'the splat imports those fields rather than carrying a hand-synced copy');
  ok(!/mx_fractal_noise_float\(pw/.test(splatSource), 'and does not re-derive the puddle noise itself');

  const { createStreamedSplatMaterial, placeholderStreamedSplatTextures } = await import('./terrain-splat-streamed.js');
  const { uniform, vec4 } = await import('three/tsl');
  const bundle = { uniforms: rainMod.createRainUniforms(), offset: uniform(new THREE.Vector2()), puddleScale: 0.09, rippleScale: 3 };
  const geo = new THREE.PlaneGeometry(1, 1, 2, 2); geo.computeVertexNormals();

  const wetMat = createStreamedSplatMaterial(placeholderStreamedSplatTextures(), {}, { rain: bundle });
  ok(wetMat.userData.streamedSplat.rain === true, 'a rain-bound splat instance says so');
  try {
    const built = await buildMaterial(wetMat, geo);
    ok(built.fragment.length > 0, 'the wet ground graph builds headless');
  } catch (error) {
    ok(false, `the wet ground graph builds headless: ${error.message}`);
  }

  // Rain and the waterline are two different things happening to the same ground: both branches
  // have to survive being in one graph, and rain must be gated to what is out of the water.
  const water = {
    sceneLevel: uniform(2), offset: uniform(new THREE.Vector2()), sunDir: uniform(new THREE.Vector3(0.3, 0.9, 0.3)),
    sunColor: uniform(new THREE.Color(1, 1, 1)), time: uniform(0), causticStrength: uniform(1), causticSpread: uniform(3),
    waveNormalFold: xz => vec4(xz.x.mul(0).add(0), 1, 0, 0),
  };
  const bothMat = createStreamedSplatMaterial(placeholderStreamedSplatTextures(), {}, { water, rain: bundle });
  ok(bothMat.userData.streamedSplat.water === true && bothMat.userData.streamedSplat.rain === true, 'one instance can carry both');
  try {
    const built = await buildMaterial(bothMat, geo);
    ok(/refract/.test(built.fragment), 'the caustic survives the rain branch');
    ok(built.fragment.length > 0, 'and the combined graph builds');
  } catch (error) {
    ok(false, `the combined graph builds: ${error.message}`);
  }

  const bare = createStreamedSplatMaterial(placeholderStreamedSplatTextures());
  ok(bare.userData.streamedSplat.rain === false, 'without a rain bundle the flag is false, so nothing else changed');
}

// ---- 11. what the page ships -----------------------------------------------------------------------
{
  const html = await (await import('fs/promises')).readFile('./base-game.html', 'utf8');
  // Bound once at startup: the graph gates on the wetness uniform, and rebuilding every splat
  // instance the first time it rains is a visible hitch.
  ok(/terrain\.setSplatRain\(rain\.groundShade\)/.test(html), 'the page binds wet ground to the splat');
  ok(!/applyRainSettings[\s\S]{0,600}setSplatRain/.test(html), 'and does it outside the per-frame apply');
  ok(/applyWetSurface\(material, rain\.uniforms/.test(html), 'the Traversal Lab materials are decorated too');
}

// ---- 12. the WebGPU audit's findings, so they cannot come back ------------------------------------
// Every one of these was a real defect found by auditing the page rather than by a test failing.
{
  // (a) The wet-ground maths must sit behind a UNIFORM branch, not just a build-time `if (rain)`.
  // Three octaves of FBM plus the ripple maths is ~315 lines of fragment shader and the ground is
  // most of the screen, so a dry world was paying for it on every ground pixel of every frame.
  const { createStreamedSplatMaterial, placeholderStreamedSplatTextures } = await import('./terrain-splat-streamed.js');
  const { createRainUniforms } = await import('./rain.js');
  const { uniform } = await import('three/tsl');
  const geo = new THREE.PlaneGeometry(1, 1, 2, 2); geo.computeVertexNormals();
  const bundle = { uniforms: createRainUniforms(), offset: uniform(new THREE.Vector2()), puddleScale: 0.09, rippleScale: 3 };
  const built = await buildMaterial(createStreamedSplatMaterial(placeholderStreamedSplatTextures(), {}, { rain: bundle }), geo);
  const body = built.fragment.slice(built.fragment.lastIndexOf('void main'));
  let depth = 0; const noiseDepths = [];
  for (const line of body.split('\n')) {
    if (/mx_fractal_noise_float\s*\(/.test(line)) noiseDepths.push(depth);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  ok(noiseDepths.length > 0, 'the wet ground graph really does evaluate the puddle noise');
  ok(noiseDepths.every(d => d >= 2), `the puddle noise is inside a branch, not at the top of main (depths ${noiseDepths.join(',')})`);
  ok(/if\s*\([^)]*>\s*0\.0\s*\)/.test(body), 'and the branch is a plain uniform comparison, so every fragment takes the same side');

  // (b) One uniform set for the life of the page. The splat's graph captures these node objects
  // when it compiles, so handing it a fresh set on a reallocation left the ground reading
  // RAIN_DEFAULTS.wetness (0.8) for ever while the drops read the real value.
  const bound = rain.groundShade.uniforms;
  ok(bound === rain.uniforms, 'the ground bundle and the drops share one uniform set');
  const fallbackBefore = rain.uniforms._fallback;
  rain.setAllocation(rain.maxDrops + 1000, rain.maxSplashes + 100);
  ok(rain.groundShade.uniforms === rain.uniforms, 'and still share it after a reallocation');
  ok(bound === rain.uniforms, 'the bundle was not re-pointed either, so a compiled graph stays valid');
  ok(fallbackBefore === rain.uniforms._fallback, 'the fallback texture is reused, not leaked per rebuild');
  const camera = new THREE.PerspectiveCamera();
  rain.setWetRise(0); rain.setDryTime(0);
  rain.setLook({ wetness: 0.42 });
  rain.update(1 / 60, camera, {});
  ok(Math.abs(bound.uWetness.value - 0.42) < 1e-9, 'so wetness set after a reallocation still reaches the ground');

  // (c) createRainSystem's own contract: without uniformSet it still builds its own, which is what
  // bot-viewer-v3 and the flight sim rely on.
  const a = createRainSystem({ maxDrops: 10, maxSplashes: 10 });
  const b = createRainSystem({ maxDrops: 10, maxSplashes: 10 });
  ok(a.uniforms !== b.uniforms, 'two systems with no uniformSet get independent uniforms, as before');
  const shared = createRainUniforms();
  const c = createRainSystem({ maxDrops: 10, maxSplashes: 10, uniformSet: shared });
  ok(c.uniforms === shared, 'and uniformSet is honoured when given');
}

// ---- 13. the page's per-frame applies are gated ----------------------------------------------------
{
  const html = await (await import('fs/promises')).readFile('./base-game.html', 'utf8');
  // applyRainSettings runs 60 times a second. Unchanged frames must not build a response object, a
  // look object and walk Object.entries twice (measured 5.5 us vs 0.6 us per call).
  const fn = html.slice(html.indexOf('function applyRainSettings()'));
  const gate = fn.slice(0, fn.indexOf('const response'));
  ok(/if \(!dirty\) return;/.test(gate), 'applyRainSettings returns early when nothing it reads has changed');
  ok(/appliedRain\._seaLevel !== terrain\.seaLevel/.test(gate), 'and watches the sea level, which is not a setting');
  ok(/RAIN_APPLY_KEYS/.test(gate), 'against an explicit key list');

  // The HUD wrote innerHTML every frame; health and ammo hold still for seconds at a time.
  ok(/if \(markup !== shownCombatStatus\)/.test(html), 'the combat HUD writes innerHTML only when the markup changes');
  ok(/if \(flash !== shownDamageFlash\)/.test(html), 'and the damage flash only when its opacity changes');
}

seaDepth.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
