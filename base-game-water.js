// base-game-water.js — the sea in Base Game: one camera-following wave surface (water-hybrid.js)
// at the terrain's sea level over the streamed sea-depth map (terrain-sea-depth.js) for thickness,
// reflecting the live sky dome, lit by the lighting rig's sun. The wave spectrum comes from the
// shared world keys so every peer sees and simulates the same water; surfaceHeightAt() is the CPU
// twin of the displaced surface for the camera and remote bodies (physics uses base-game-water-sim).
// The surface hides itself while no ground in the depth window is below sea level.

import * as THREE from 'three';
import { uniform, float, max, abs, min, normalize, smoothstep, screenUV, positionView, positionWorld, cameraPosition, cameraNear, cameraFar, viewportDepthTexture, viewportSharedTexture, perspectiveDepthToViewZ } from 'three/tsl';
import { makeWaterProfile, applyWaterPreset, rebuildWaveTable, createOceanSurface } from './water-hybrid.js';
import { surfaceAt } from './water-waves.js';

export const BASE_GAME_WATER_DEFAULTS = Object.freeze({
  gridR1: 12000,                  // outer ring radius (m), beyond any far plane this page uses
  dispFade: [600, 2400],          // displacement fades to flat over this scene distance
  normalFade: [1500, 6000],       // normal fades to straight up
  fallbackDepth: 80,              // water depth assumed outside the sea-depth window
  shallowFade: 2.5,               // wave height ramps to zero over this much depth at the shore
  preset: 'hybrid',
});

export function createBaseGameWater({ scene, terrain, sky, rig, worldCoordinates, ...opts } = {}) {
  if (!scene || !terrain || !sky || !rig) throw new TypeError('base-game water needs scene, terrain, sky and rig');
  const cfg = { ...BASE_GAME_WATER_DEFAULTS, ...opts };
  const uTime = uniform(0), uWind = uniform(new THREE.Vector2(1, 0));
  const uLevel = uniform(terrain.seaLevel ?? 0);
  const uOffset = uniform(new THREE.Vector2());   // scene xz + offset = global xz
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0)), uSunColor = uniform(new THREE.Color(1, 1, 1));
  const profile = makeWaterProfile({ name: 'sea', uTime, uWind, preset: cfg.preset });
  const seaDepth = terrain.seaDepth;

  const surface = createOceanSurface({
    profile,
    grid: { rings: 160, spokes: 224, r0: 2, r1: cfg.gridR1 },
    level: uLevel.value,
    depthWrite: false,
    renderOrder: 1,
    worldOffset: uOffset,
    sky: dir => sky.colorAlong(dir),
    // thickness = sea level − ground; outside the window assume open sea so the edge never dries
    depthAt: xz => uLevel.sub(seaDepth.gpuHeightAt(xz, uLevel.sub(cfg.fallbackDepth))),
    sunDir: uSunDir, sunColor: uSunColor,
    dispFade: cfg.dispFade, normalFade: cfg.normalFade,
    shallowFade: cfg.shallowFade,
    // Per-pixel thickness: the rendered ground's depth under this fragment (opaque pass only, the
    // water does not write depth), along the view ray, scaled to a vertical depth for a flat bed.
    // The water ends exactly where the drawn ground rises through it, not at a 16 m post.
    thicknessAt: () => {
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(screenUV), cameraNear, cameraFar);
      const ray = max(positionView.z.sub(sceneZ), 0.0);
      const viewY = abs(normalize(cameraPosition.sub(positionWorld)).y);
      return ray.mul(max(viewY, 0.08));
    },
    // Refraction: the framebuffer under the surface, shifted by the wave normal and the depth
    // (a dry pixel must not be pulled in from above the shoreline).
    bedColorAt: (viewDir, N, thickness) => {
      const ripple = N.xz.mul(profile.refrRipple).mul(smoothstep(0.0, 1.5, thickness));
      return viewportSharedTexture(screenUV.add(ripple)).rgb;
    },
  });
  surface.mesh.name = 'base-game-water';
  scene.add(surface.mesh);

  let enabled = true, time = 0;
  let wind = 35;
  const state = { visible: false, reason: 'no data' };
  const _s = {};

  function setWindDeg(deg) {
    wind = deg;
    const r = deg * Math.PI / 180;
    uWind.value.set(Math.cos(r), Math.sin(r));
  }
  setWindDeg(profile.wave.windDeg);
  terrain.setSeaDepthActive(true);

  function applyOffset() {
    const o = worldCoordinates ? worldCoordinates.getOrigin() : [0, 0, 0];
    uOffset.value.set(o[0], o[2]);
    surface.mesh.position.y = uLevel.value - o[1];
  }

  return {
    mesh: surface.mesh, material: surface.material, profile, uniforms: { time: uTime, wind: uWind, level: uLevel, offset: uOffset, sunDir: uSunDir, sunColor: uSunColor },
    state,
    get enabled() { return enabled; },
    get level() { return uLevel.value; },
    get time() { return time; },
    setEnabled(flag) { enabled = !!flag; if (!enabled) surface.mesh.visible = false; terrain.setSeaDepthActive(enabled); },
    setLevel(level) { if (Number.isFinite(level)) { uLevel.value = level; applyOffset(); } },
    // Wave spectrum from the shared world (buildWaveTable options); rebuilds the table in place.
    setWaves(options) {
      let changed = false;
      for (const [k, v] of Object.entries(options)) if (k in profile.wave && profile.wave[k] !== v) { profile.wave[k] = v; changed = true; }
      if (changed) { rebuildWaveTable(profile); setWindDeg(profile.wave.windDeg); }
      return changed;
    },
    applyPreset(name) { applyWaterPreset(profile, name); rebuildWaveTable(profile); setWindDeg(profile.wave.windDeg); },
    // The displaced surface height (global x, z) at the current clock: camera and bodies, not physics.
    surfaceHeightAt(x, z) {
      if (profile.waveModel.value !== 1 || !profile.table) return uLevel.value;
      const s = surfaceAt(profile.table, x, z, time, profile.disp.value, 4, _s);
      return uLevel.value + s.y;
    },
    // Per frame, before render: clock, recentre, sun, gate.
    update(dt, cameraPosition) {
      if (!enabled) return;
      time += dt;
      uTime.value = time;
      applyOffset();
      surface.update(cameraPosition);
      const d = rig.dirLight;
      uSunDir.value.copy(d.position).normalize();
      uSunColor.value.copy(d.color).multiplyScalar(Math.min(1, d.intensity));
      const minGround = seaDepth.minHeight();
      const show = Number.isFinite(minGround) && minGround < uLevel.value;
      state.visible = show;
      state.reason = !Number.isFinite(minGround) ? 'no data' : show ? 'water in window' : 'all ground above sea level';
      surface.mesh.visible = show;
    },
    dispose() { scene.remove(surface.mesh); surface.dispose(); },
  };
}
