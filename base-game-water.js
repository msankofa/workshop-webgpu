// base-game-water.js — the sea in Base Game: one camera-following wave surface (water-hybrid.js)
// at the terrain's sea level over the streamed sea-depth map (terrain-sea-depth.js) for thickness,
// reflecting the live sky dome, lit by the lighting rig's sun. The wave spectrum comes from the
// shared world keys so every peer sees and simulates the same water; surfaceHeightAt() is the CPU
// twin of the displaced surface for the camera and remote bodies (physics uses base-game-water-sim).
// The surface hides itself while no ground in the depth window is below sea level.

import * as THREE from 'three';
import {
  uniform, float, int, vec2, vec4, max, abs, normalize, smoothstep, oneMinus, saturate, mix, reflect, select,
  screenUV, positionView, positionWorld, cameraPosition, cameraNear, cameraFar, cameraViewMatrix, cameraProjectionMatrix,
  viewportDepthTexture, viewportSharedTexture, perspectiveDepthToViewZ, reflector, getScreenPosition, Fn, If, Loop, Break,
} from 'three/tsl';
import { makeWaterProfile, applyWaterPreset, rebuildWaveTable, createOceanSurface } from './water-hybrid.js';
import { surfaceAt } from './water-waves.js';

export const BASE_GAME_WATER_DEFAULTS = Object.freeze({
  gridR1: 12000,                  // outer ring radius (m), beyond any far plane this page uses
  dispFade: [600, 2400],          // displacement fades to flat over this scene distance
  normalFade: [1500, 6000],       // normal fades to straight up
  foamFade: [800, 2500],          // foam gone before the far cascade's coarse shorelines
  fallbackDepth: 80,              // water depth assumed outside the sea-depth window
  shallowFade: 2.5,               // wave height ramps to zero over this much depth at the shore
  reflectRate: 2,                 // mirror pass every Nth frame
  reflectResolutionScale: 0.5,
  preset: 'hybrid',
});

export const BASE_GAME_REFLECTION_MODES = Object.freeze(['sky', 'planar', 'ssr']);

export function createBaseGameWater({ scene, terrain, sky, rig, worldCoordinates, excludeFromReflection = null, ...opts } = {}) {
  if (!scene || !terrain || !sky || !rig) throw new TypeError('base-game water needs scene, terrain, sky and rig');
  const cfg = { ...BASE_GAME_WATER_DEFAULTS, ...opts };
  const uTime = uniform(0), uWind = uniform(new THREE.Vector2(1, 0));
  const uLevel = uniform(terrain.seaLevel ?? 0);
  const uOffset = uniform(new THREE.Vector2());   // scene xz + offset = global xz
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0)), uSunColor = uniform(new THREE.Color(1, 1, 1));
  const profile = makeWaterProfile({ name: 'sea', uTime, uWind, preset: cfg.preset });
  const seaDepth = terrain.seaDepth;

  // Planar mirror (TSL reflector, own camera + half-res target). Its updateBefore is wrapped so it
  // runs only in planar mode, on every Nth frame, while the water is visible and the camera is
  // above it, with the water itself and the caller's excludes hidden for the mirror render.
  const planar = reflector({ resolutionScale: cfg.reflectResolutionScale, bounces: false });
  planar.target.rotation.x = -Math.PI / 2;   // local +Z → world +Y: the mirror plane is horizontal
  planar.target.name = 'base-game-water-mirror';
  scene.add(planar.target);
  const reflectStats = { passes: 0, skipped: 0, lastMs: 0 };
  let frame = 0, reflectLastFrame = -1, cameraBelow = false, surfaceVisible = false;
  const mirrorBase = planar.reflector;
  const renderMirror = mirrorBase.updateBefore.bind(mirrorBase);
  mirrorBase.updateBefore = (f) => {
    if (frame === reflectLastFrame) return;   // one pass per application frame, whatever reaches this hook
    reflectLastFrame = frame;
    if (profile.reflMode.value !== 1 || !surfaceVisible || cameraBelow || frame % Math.max(1, cfg.reflectRate) !== 0) { reflectStats.skipped++; return; }
    const hidden = [];
    const hide = obj => { if (obj && obj.visible) { obj.visible = false; hidden.push(obj); } };
    hide(surfaceMesh);
    const extra = typeof excludeFromReflection === 'function' ? excludeFromReflection() : excludeFromReflection;
    if (extra) for (const obj of extra) hide(obj);
    const t0 = performance.now();
    try { return renderMirror(f); }
    finally { for (const obj of hidden) obj.visible = true; reflectStats.passes++; reflectStats.lastMs = performance.now() - t0; }
  };
  let surfaceMesh = null;

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
    dispFade: cfg.dispFade, normalFade: cfg.normalFade, foamFade: cfg.foamFade,
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
    // Reflection by profile.reflMode: 0 sky dome, 1 planar mirror, 2 screen-space march against
    // the opaque depth buffer (the demo's march, sampling the framebuffer instead of a pre-pass).
    reflection: (viewDir, N) => {
      planar.uvNode = planar.uvNode.add(N.xz.mul(profile.reflRipple));   // ripple the mirror by the wave normal
      return Fn(() => {
      const R = reflect(viewDir.negate(), N);
      const skyRefl = sky.colorAlong(R);
      const refl = skyRefl.toVar();
      If(profile.reflMode.equal(int(1)), () => {
        refl.assign(planar.rgb.mul(profile.reflBright));
      }).ElseIf(profile.reflMode.equal(int(2)), () => {
        const Rv = cameraViewMatrix.mul(vec4(R, 0.0)).xyz;
        const p0 = positionView.xyz;
        const stepLen = profile.ssrStep.toVar();
        const dist = float(0).toVar();
        const hitUV = vec2(-1).toVar();
        const hit = float(0).toVar();
        Loop({ start: int(0), end: profile.ssrSteps, type: 'int', condition: '<' }, () => {
          dist.addAssign(stepLen);
          stepLen.mulAssign(1.06);
          const p = p0.add(Rv.mul(dist));
          const uv = getScreenPosition(p, cameraProjectionMatrix);
          If(uv.x.lessThan(0.0).or(uv.x.greaterThan(1.0)).or(uv.y.lessThan(0.0)).or(uv.y.greaterThan(1.0)), () => { Break(); });
          const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(uv), cameraNear, cameraFar);
          const diff = sceneZ.sub(p.z);   // positive when the ray point is behind the scene surface
          If(diff.greaterThan(0.0).and(diff.lessThan(profile.ssrThickness)), () => { hitUV.assign(uv); hit.assign(1.0); Break(); });
        });
        const edge = smoothstep(0.0, 0.14, hitUV.x).mul(smoothstep(0.0, 0.14, oneMinus(hitUV.x)))
          .mul(smoothstep(0.0, 0.14, hitUV.y)).mul(smoothstep(0.0, 0.14, oneMinus(hitUV.y)));
        const ssrCol = viewportSharedTexture(saturate(hitUV.add(N.xz.mul(profile.reflRipple)))).rgb;
        refl.assign(mix(skyRefl, ssrCol, hit.mul(edge)));
      });
      return refl;
      })();
    },
  });
  surfaceMesh = surface.mesh;
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
    planar.target.position.y = surface.mesh.position.y;
  }

  return {
    mesh: surface.mesh, material: surface.material, profile, uniforms: { time: uTime, wind: uWind, level: uLevel, offset: uOffset, sunDir: uSunDir, sunColor: uSunColor },
    state, reflectStats, mirror: planar,
    get reflectionMode() { return BASE_GAME_REFLECTION_MODES[profile.reflMode.value] ?? 'sky'; },
    setReflectionMode(mode) { const i = BASE_GAME_REFLECTION_MODES.indexOf(mode); if (i >= 0) profile.reflMode.value = i; },
    get cameraBelow() { return cameraBelow; },
    get enabled() { return enabled; },
    get level() { return uLevel.value; },
    get time() { return time; },
    setEnabled(flag) { enabled = !!flag; if (!enabled) surface.mesh.visible = false; terrain.setSeaDepthActive(enabled); },
    setLevel(level) { if (Number.isFinite(level) && level !== uLevel.value) { uLevel.value = level; applyOffset(); } },
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
      frame++;
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
      surfaceVisible = show;
      const o = worldCoordinates ? worldCoordinates.getOrigin() : [0, 0, 0];
      cameraBelow = cameraPosition.y + o[1] < this.surfaceHeightAt(cameraPosition.x + o[0], cameraPosition.z + o[2]);
    },
    dispose() { scene.remove(surface.mesh); scene.remove(planar.target); planar.dispose?.(); surface.dispose(); },
  };
}
