// base-game-rain.js — the Base Game rain: rain.js's drops and splash rings over the streamed
// terrain, following base-game-water.js's shape (own uniforms, own render-origin offset, one
// update(dt, camera) the page calls in its own profiler slot).
//
// Three things this owns that the raw module does not. The render origin moves, so every world-XZ
// lookup carries a `uOffset` and every height comes back in scene space. There is no analytic
// terrain height here as there is in the flight sim, so the ground hook is the sea-depth clipmap
// window (terrain-sea-depth.js) — sampled conservatively low, because a height read too low is
// hidden by the depth buffer and one read too high shows as rain cut off in mid air. And the world
// has two grounds: the streamed terrain and the Traversal Lab's flat floor.
//
// Wetness (phase R2) is owned here rather than by the page because it is not the rain slider: it
// LAGS it, so ground that has been rained on stays wet for a while after the storm passes. The
// terrain splat, the Traversal Lab and the bodies all read the one `uWetness` this advances.
//
// The rain shadow map, lightning and the rain bed are later phases.

import * as THREE from 'three';
import { uniform, float, vec2, max, mix } from 'three/tsl';
import { createRainSystem, createRainUniforms } from './rain.js';

export const BASE_GAME_RAIN_DEFAULTS = Object.freeze({
  maxDrops: 40000,
  maxSplashes: 5000,
  labGroundY: 0,          // the Traversal Lab's floor slabs top out at y = 0
  noDataHeight: -10000,   // ground before the window has streamed: below everything, not 1e9 (precision)
  splashMaxAgl: 160,      // hide rings above this much height over the ground (flight-sim's rule)
  dryTime: 90,            // seconds for wetness to fall to 1/e of the way to dry after the rain stops
  wetRise: 8,             // seconds to wet up; ground darkens quickly and dries slowly, as it does
});

export function createBaseGameRain({ scene, terrain, worldCoordinates = null, ...opts } = {}) {
  if (!scene || !terrain) throw new TypeError('base game rain needs a scene and terrain');
  const cfg = { ...BASE_GAME_RAIN_DEFAULTS, ...opts };
  const seaDepth = terrain.seaDepth;
  if (!seaDepth) throw new TypeError('base game rain needs terrain.seaDepth');

  const uOffset = uniform(new THREE.Vector2());   // scene xz + offset = global xz
  const uOriginY = uniform(0);
  const uWaterLevel = uniform(-1e6);              // global; rain lands on the sea, not the sea bed
  const uFlatGround = uniform(cfg.labGroundY);    // scene y of the Traversal Lab floor
  const uUseWindow = uniform(0);                  // 1 in terrain mode, 0 in the lab
  const uConservative = uniform(1);               // 1 min-of-four posts, 0 bilinear
  const uSkyTint = uniform(new THREE.Color(1, 1, 1));
  const uSkyTintAmount = uniform(0);

  // Ground in SCENE space. Both sample modes are built into the graph and mixed by a uniform, so
  // the conservative toggle is a slider rather than a material rebuild.
  const noData = float(cfg.noDataHeight);
  function groundHeight(xz) {
    const global = xz.add(uOffset);
    const lo = seaDepth.gpuHeightAt(global, noData, 'min');
    const blend = seaDepth.gpuHeightAt(global, noData);
    const ground = max(mix(blend, lo, uConservative), uWaterLevel).sub(uOriginY);
    return mix(uFlatGround, ground, uUseWindow);
  }
  // Slope for the splash rings, central-differenced one post apart. Deliberately the BILINEAR
  // sample: the min filter is a staircase and its differences are zero across most of a cell.
  const step = float(seaDepth.spacing);
  function groundSlope(xz) {
    const g = (dx, dz) => seaDepth.gpuHeightAt(vec2(xz.x.add(dx), xz.y.add(dz)).add(uOffset), noData);
    const dx = g(step, float(0)).sub(g(step.negate(), float(0)));
    const dz = g(float(0), step).sub(g(float(0), step.negate()));
    return vec2(dx, dz).div(step.mul(2)).mul(uUseWindow);
  }

  let system = null, maxDrops = cfg.maxDrops, maxSplashes = cfg.maxSplashes;
  const group = new THREE.Group();
  group.name = 'base-game-rain';
  group.visible = false;
  scene.add(group);

  // Look settings survive a reallocation, which disposes and rebuilds the instanced geometry.
  const look = {
    density: 0, opacity: 0.55, speed: 18, length: 1.1, width: 0.014,
    volumeXZ: 44, volumeY: 36, nearStart: 0.25, nearEnd: 1.4, camLean: 1,
    color: '#b8bcc4', skyTint: 0,
    splashRadius: 20, splashSize: 0.22, splashRate: 1.6,
    splashSlopeMax: 38, splashSlopeFade: 12, splashOrient: 1,
    windDeg: 38, windSpeed: 2.1, gust: 3, gustPeriod: 17,
    wetness: 0, puddle: 0.45, ripple: 1.0,
  };
  let enabled = true, dropsOn = true, splashOn = true, splashMaxAgl = cfg.splashMaxAgl;
  let wetEnabled = true, dryTime = cfg.dryTime, wetRise = cfg.wetRise, wetness = 0;

  function applyLook() {
    const U = system.uniforms;
    U.uOpacity.value = look.opacity;
    U.uSpeed.value = look.speed;
    U.uLength.value = look.length;
    U.uWidth.value = look.width;
    U.uVolume.value.set(look.volumeXZ, look.volumeY, look.volumeXZ);
    U.uNearStart.value = look.nearStart;
    U.uNearEnd.value = look.nearEnd;
    U.uCamLean.value = look.camLean;
    U.uSplashRadius.value = look.splashRadius;
    U.uSplashSize.value = look.splashSize;
    U.uSplashRate.value = look.splashRate;
    U.uPuddle.value = look.puddle;
    U.uRipple.value = look.ripple;
    uSkyTintAmount.value = look.skyTint;
    system.setSplashSlope(look.splashSlopeMax, look.splashSlopeFade);
    system.setSplashOrient(look.splashOrient);
    system.setDensity(look.density);
    system.setGust(look.gust);
    system.setGustPeriod(look.gustPeriod);
    const r = look.windDeg * Math.PI / 180;
    system.setWind(Math.cos(r) * look.windSpeed, Math.sin(r) * look.windSpeed);
  }

  // One uniform set for the life of the page. The splat's wet-ground graph captures these node
  // objects when it compiles, so a reallocation must not hand it a fresh set — the ground would be
  // left reading RAIN_DEFAULTS.wetness (0.8) for ever while the drops read the real value.
  const uniformSet = createRainUniforms({ splashRadius: 20 });
  function build() {
    system = createRainSystem({
      maxDrops, maxSplashes, density: look.density,
      uniformSet,
      groundHeight, groundSlope,
      // A little of the sky's own colour, so drops belong to the weather they fall out of.
      colorFn: rgb => mix(rgb, uSkyTint, uSkyTintAmount),
    });
    system.uniforms.uColor.value.set(look.color);
    group.add(system.group);
    applyLook();
  }
  build();
  // The ground hook is the sea-depth window, and the window streams only while something asks for
  // it — water does, but rain has to ask too or a world with the sea off has no ground to land on.
  terrain.setSeaDepthActive(true);

  const _camGlobal = new THREE.Vector3();

  // What the ground material needs (terrain.setSplatRain(groundShade)), the same shape water's
  // bundle has: the rain uniforms plus the global-xz offset, so puddles are anchored to the world.
  const groundShade = {
    uniforms: uniformSet, offset: uOffset,
    puddleScale: 0.09, rippleScale: 3.0,
  };

  return {
    group, groundShade,
    get system() { return system; },
    get wetness() { return wetness; },
    get uniforms() { return system.uniforms; },
    get maxDrops() { return maxDrops; },
    get maxSplashes() { return maxSplashes; },

    setEnabled(on) { enabled = !!on; if (!enabled) group.visible = false; },
    setDropsVisible(on) { dropsOn = !!on; },
    setSplashesVisible(on) { splashOn = !!on; },
    setSplashMaxAgl(m) { splashMaxAgl = m; },
    // Wet surfaces. `dryTime` is the time constant of the fall back to dry, not a hard duration:
    // neither donor page has one at all, so ground went bone dry the frame a storm stopped.
    setWetEnabled(on) { wetEnabled = !!on; },
    setDryTime(seconds) { dryTime = Math.max(0, seconds); },
    setWetRise(seconds) { wetRise = Math.max(0, seconds); },
    // 'coarse' samples the 16 m sea-depth window; 'off' drops the ground hook to the flat fallback,
    // which is the honest way to see how much of what you are looking at is the window.
    setGroundSource(mode) { uUseWindow.value = mode === 'off' ? 0 : 1; },
    setConservative(on) { uConservative.value = on ? 1 : 0; },
    setFlatGround(y) { uFlatGround.value = y; },
    // Global sea level, or null when there is no sea: rain then lands on the ground alone.
    setWaterLevel(level) { uWaterLevel.value = Number.isFinite(level) ? level : -1e6; },

    setLook(patch = {}) {
      let dirty = false;
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in look) || look[key] === value) continue;
        look[key] = value;
        dirty = true;
        if (key === 'color') system.uniforms.uColor.value.set(value);
      }
      if (dirty) applyLook();
      return dirty;
    },

    // Reallocating the instanced geometry is a rebuild, not a uniform write.
    setAllocation(drops, splashes) {
      if (drops === maxDrops && splashes === maxSplashes) return false;
      maxDrops = Math.max(1, Math.round(drops));
      maxSplashes = Math.max(1, Math.round(splashes));
      group.remove(system.group);
      for (const mesh of [system.streaks.mesh, system.splashes.mesh]) { mesh.geometry.dispose(); mesh.material.dispose(); }
      build();
      return true;
    },

    // `underwater` hides everything (there is no rain to see from under the sea) and `skyColor` is
    // the page's current background, which already carries the time of day and the overcast lid.
    update(dt, camera, { underwater = false, skyColor = null } = {}) {
      const o = worldCoordinates ? worldCoordinates.getOrigin() : [0, 0, 0];
      uOffset.value.set(o[0], o[2]);
      uOriginY.value = o[1];
      if (skyColor?.isColor) uSkyTint.value.copy(skyColor);
      // Wetness chases the target with a time constant, rising faster than it falls: ground darkens
      // as the rain arrives and dries over minutes, not in the frame the slider moves. Written even
      // when nothing is drawn, so a storm that ends still leaves the ground drying rather than
      // freezing at whatever it happened to be.
      const target = wetEnabled ? Math.max(0, Math.min(1, look.wetness)) : 0;
      const tau = target > wetness ? wetRise : dryTime;
      wetness = tau > 0 ? wetness + (target - wetness) * (1 - Math.exp(-dt / tau)) : target;
      system.uniforms.uWetness.value = wetness;

      const drawing = enabled && look.density > 0 && !underwater;
      group.visible = drawing;
      if (!drawing) return;
      system.streaks.mesh.visible = dropsOn;
      // Above enough ground the rings are a band of noise under the aircraft, so they stop.
      _camGlobal.set(camera.position.x + o[0], camera.position.y + o[1], camera.position.z + o[2]);
      const ground = uUseWindow.value > 0 ? seaDepth.heightAt(_camGlobal.x, _camGlobal.z) : uFlatGround.value + o[1];
      const agl = Number.isFinite(ground) ? _camGlobal.y - ground : 0;
      system.splashes.mesh.visible = splashOn && agl < splashMaxAgl;
      system.update(dt, camera);
    },

    dispose() {
      scene.remove(group);
      for (const mesh of [system.streaks.mesh, system.splashes.mesh]) { mesh.geometry.dispose(); mesh.material.dispose(); }
    },
  };
}

// The rain fan-out, kept out of the page so it is testable in Node: one master plus a response
// slider per effect, never writing a value the user set by hand.
export function rainResponse(settings) {
  const rain = Math.max(0, Math.min(1, settings.weatherRain));
  return {
    density: Math.max(0, Math.min(1, settings.rainDensityBase + rain * settings.rainDensityPerRain)),
    opacity: Math.max(0, Math.min(1, settings.rainOpacityBase + rain * settings.rainOpacityPerRain)),
    wetness: Math.max(0, Math.min(1, rain * settings.rainWetnessPerRain)),
  };
}
