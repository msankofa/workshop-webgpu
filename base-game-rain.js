// base-game-rain.js — the Base Game rain: rain.js's drops and splash rings over the streamed
// terrain, following base-game-water.js's shape (own uniforms, own render-origin offset, one
// update(dt, camera) the page calls in its own profiler slot).
//
// Three things this owns that the raw module does not. The render origin moves, so every world-XZ
// lookup carries a `uOffset` and every height comes back in scene space. There is no analytic
// terrain height here as there is in the flight sim, so the ground hook is a pair of streamed
// windows. And the world has two grounds: the streamed terrain and the Traversal Lab's flat floor.
//
// THE GROUND HOOK IS TWO WINDOWS, and which one answers matters more than it looks:
//
//   fine   the terrain's own contact field: lod 0, 1.25 m posts, 160 m across. In volumetric mode
//          it carries `surfaceHeights`, the VISIBLE marching-cubes surface, which is what grass
//          plants on and what a player walks on.
//   coarse the 16 m sea-depth window (terrain-sea-depth.js), which only ever carries `heights`:
//          the base heightfield. Sampled conservatively low, because a height read too low is
//          hidden by the depth buffer and one read too high shows as rain cut off in mid air.
//
// Rain used the coarse window alone, so under volumetric terrain it cut drops on a surface the
// player cannot see: the heightfield beneath the caves and overhangs rather than the ground in
// front of them. The fine window answers inside its 160 m, the coarse one beyond that, and a drop
// where neither has streamed simply does not cut.
//
// Wetness (phase R2) is owned here rather than by the page because it is not the rain slider: it
// LAGS it, so ground that has been rained on stays wet for a while after the storm passes. The
// terrain splat, the Traversal Lab and the bodies all read the one `uWetness` this advances.
//
// The rain shadow (phase R3) is owned here for the same reason: it is a world-XZ lookup, so its
// centre and its heights have to be carried in GLOBAL coordinates and converted every frame. Stored
// that way the bake survives a rebase untouched — the texture holds `globalY - globalFloor`, which
// no origin shift can change — where a bake stored in scene space would have to be redone.
//
// Lightning and the rain bed are base-game-lightning.js and base-game-audio.js.

import * as THREE from 'three';
import { uniform, float, vec2, max, mix } from 'three/tsl';
import { createRainSystem, createRainUniforms, bakeOccluderMap } from './rain.js';

export const BASE_GAME_RAIN_DEFAULTS = Object.freeze({
  maxDrops: 40000,
  maxSplashes: 5000,
  labGroundY: 0,          // the Traversal Lab's floor slabs top out at y = 0
  noDataHeight: -10000,   // ground before the window has streamed: below everything, not 1e9 (precision)
  splashMaxAgl: 160,      // hide rings above this much height over the ground (flight-sim's rule)
  dryTime: 90,            // seconds for wetness to fall to 1/e of the way to dry after the rain stops
  wetRise: 8,             // seconds to wet up; ground darkens quickly and dries slowly, as it does
  occLayer: 3,            // enabled on the meshes for the bake only, so nothing else ever sees it
  occSize: 512,           // texels a side
  occExtent: 200,         // metres the window spans
  occTop: 220,            // metres above the window's floor the bake camera sits
  occMargin: 30,          // metres of headroom under the lowest thing baked, for half-float range
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
  const uUseFine = uniform(0);                    // 1 prefer the contact field, 0 coarse window only
  const uConservative = uniform(1);               // 1 min-of-four posts, 0 bilinear
  const uSlopeStep = uniform(1);                  // metres between the slope's central differences
  const uSkyTint = uniform(new THREE.Color(1, 1, 1));
  const uSkyTintAmount = uniform(0);

  // The contact field. The terrain recentres and streams it from its own update(); all that is
  // needed here is a reference, or it never streams at all. Held only while the ground source
  // actually reads it, and bound only while held: the registry disposes a window when its last
  // holder lets go, and a TSL graph keeps the texture object it captured, so sampling a disposed
  // one is a black screen rather than a missing height.
  const noData = float(cfg.noDataHeight);
  let contactRelease = null, contactWin = null, fineSampler = null;
  function currentContact() { return contactRelease ? (terrain.contactField ?? null) : null; }
  // Rebound with the materials, because a volumetric toggle swaps `heights` for `surfaceHeights`,
  // which the registry serves as a DIFFERENT window with a different texture.
  function bindContact() {
    contactWin = currentContact();
    fineSampler = null;
    if (!contactWin?.gpuSampler) return;
    const field = contactWin.fields.includes('surfaceHeights') ? 'surfaceHeights' : 'heights';
    fineSampler = contactWin.gpuSampler(field);
  }

  // Ground in SCENE space. Every branch is in the graph and mixed by a uniform, so the source and
  // conservative toggles are sliders rather than material rebuilds.
  function rawGround(global, conservative) {
    const lo = seaDepth.gpuHeightAt(global, noData, 'min');
    const blend = seaDepth.gpuHeightAt(global, noData);
    const coarse = conservative ? mix(blend, lo, uConservative) : blend;
    // The fine sampler returns its fallback outside its window, so this IS the handover.
    return fineSampler ? mix(coarse, fineSampler(global, coarse), uUseFine) : coarse;
  }
  function groundHeight(xz) {
    const ground = max(rawGround(xz.add(uOffset), true), uWaterLevel).sub(uOriginY);
    return mix(uFlatGround, ground, uUseWindow);
  }
  // Slope for the splash rings, central-differenced one post apart. Deliberately the BILINEAR
  // sample: the min filter is a staircase and its differences are zero across most of a cell. The
  // step follows whichever window is answering -- 16 m differences over a 1.25 m field would smooth
  // away the detail the fine window exists to provide, and rings only ever land inside it.
  function groundSlope(xz) {
    const step = uSlopeStep;
    const g = (dx, dz) => rawGround(vec2(xz.x.add(dx), xz.y.add(dz)).add(uOffset), false);
    const dx = g(step, float(0)).sub(g(step.negate(), float(0)));
    const dz = g(float(0), step).sub(g(float(0), step.negate()));
    return vec2(dx, dz).div(step.mul(2)).mul(uUseWindow);
  }
  uSlopeStep.value = seaDepth.spacing;

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
  // The rain shadow, all in GLOBAL coordinates (see the header). `occ` is the baked handle.
  let occ = null, occOn = false;
  const occCenter = new THREE.Vector2();       // global xz the window is centred on
  let occFloor = 0, occExtent = 0, occBakes = 0, occLastMs = 0;
  const _occBox = new THREE.Box3();

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
  // rain.js reports "no roof" as 0 by default, which would cut every drop at scene y = 0. This
  // world's ground goes below that, so the miss value is set once here and never left at zero.
  uniformSet.uOccMiss.value = cfg.noDataHeight;
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
  function rebuild() {
    group.remove(system.group);
    for (const mesh of [system.streaks.mesh, system.splashes.mesh]) { mesh.geometry.dispose(); mesh.material.dispose(); }
    build();
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

  // Every frame, in global-to-scene terms. Split out because both update() and a fresh bake need it.
  function syncOccluderUniforms(offsetX, offsetZ, originY) {
    const U = uniformSet;
    const live = occOn && !!occ;
    U.uOccOn.value = live ? 1 : 0;
    U.uOccCenter.value.set(occCenter.x - offsetX, occCenter.y - offsetZ);
    U.uOccExtent.value = occExtent || 1;
    U.uOccFloor.value = occFloor - originY;
    // Where there is no map there is no roof, at any height. Without this the drops are cut at
    // scene y = 0 and a valley below the origin gets no rain at all.
    U.uOccMiss.value = cfg.noDataHeight;
  }

  // Renders `roots` from straight above into a height texture. The layer is enabled on the meshes
  // for the bake and disabled again straight after, so nothing else in the page ever sees it.
  // `centerGlobal` is [x, z]; the floor comes from the roots' own bounds, so the half-float texture
  // spends its precision on the relief in the window rather than on the distance down to zero.
  function bakeOccluders({ renderer, roots = [], centerGlobal = null, extent = cfg.occExtent, size = cfg.occSize, top = cfg.occTop } = {}) {
    if (!renderer) throw new TypeError('the rain occluder bake needs a renderer');
    const list = roots.filter(Boolean);
    if (!list.length) return false;
    const o = worldCoordinates ? worldCoordinates.getOrigin() : [0, 0, 0];
    const center = centerGlobal ?? [o[0], o[2]];
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);

    const marked = [];
    _occBox.makeEmpty();
    for (const root of list) {
      root.updateMatrixWorld(true);       // the bake may run outside the frame loop's matrix pass
      root.traverse(node => { if (node.isMesh && node.visible) { node.layers.enable(cfg.occLayer); marked.push(node); } });
      if (root.visible) _occBox.expandByObject(root);
    }
    if (!marked.length) return false;
    // Scene space for the bake camera, global for everything we keep.
    const floorScene = (Number.isFinite(_occBox.min.y) ? _occBox.min.y : 0) - cfg.occMargin;
    occ?.dispose();
    occ = bakeOccluderMap(renderer, scene, uniformSet, {
      center: [center[0] - o[0], center[1] - o[2]],
      extent, size, layer: cfg.occLayer, top, floor: floorScene,
    });
    for (const node of marked) node.layers.disable(cfg.occLayer);

    occCenter.set(center[0], center[1]);
    occExtent = extent;
    occFloor = floorScene + o[1];
    occBakes++;
    occLastMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    syncOccluderUniforms(o[0], o[2], o[1]);
    return true;
  }

  return {
    group, groundShade, bakeOccluders,
    get system() { return system; },
    // How far the player may drift from the baked centre before the window stops covering them: the
    // plan's "middle half", so a bake lasts a quarter of the window's width of walking.
    get occluderDrift() { return occ ? occExtent * 0.25 : 0; },
    get occluderStats() { return { baked: !!occ, on: occOn && !!occ, bakes: occBakes, lastMs: occLastMs, extent: occExtent, center: [occCenter.x, occCenter.y], floor: occFloor }; },
    setOccludersEnabled(on) { occOn = !!on; },
    // True once the player has walked out of the middle half of the baked window.
    occludersStale(globalX, globalZ) {
      if (!occ) return true;
      const d = occExtent * 0.25;
      return Math.abs(globalX - occCenter.x) > d || Math.abs(globalZ - occCenter.y) > d;
    },
    clearOccluders() { occ?.dispose(); occ = null; occExtent = 0; uniformSet.uOccOn.value = 0; },
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
    // 'fine' prefers the 1.25 m contact field and falls back to the 16 m sea-depth window past its
    // reach; 'coarse' is the sea-depth window alone, which is the old behaviour and is wrong under
    // volumetric terrain; 'off' drops the hook to the flat fallback, which is the honest way to see
    // how much of what you are looking at is a window at all.
    setGroundSource(mode) {
      uUseWindow.value = mode === 'off' ? 0 : 1;
      const wantFine = mode === 'fine';
      uUseFine.value = wantFine ? 1 : 0;
      if (wantFine && !contactRelease && typeof terrain.acquireContactField === 'function') {
        contactRelease = terrain.acquireContactField();
      } else if (!wantFine && contactRelease) {
        contactRelease(); contactRelease = null;
      }
      // Rebound and rebuilt HERE rather than on the next update, because letting go of the last
      // reference disposes the window's texture while the graph is still holding it.
      if (currentContact() !== contactWin) { bindContact(); rebuild(); }
      uSlopeStep.value = wantFine && contactWin ? contactWin.post : seaDepth.spacing;
    },
    // What the ground hook is actually reading, for the panel: the fine field's name is the whole
    // point of the volumetric fix, so it is reported rather than inferred from the world mode.
    get groundStats() {
      return {
        fine: !!fineSampler,
        finePost: contactWin?.post ?? null,
        fineExtent: contactWin?.extent ?? null,
        fineField: contactWin ? (contactWin.fields.includes('surfaceHeights') ? 'surfaceHeights' : 'heights') : null,
        fineCoverage: contactWin?.coverage ?? 0,
        coarsePost: seaDepth.spacing,
        slopeStep: uSlopeStep.value,
      };
    },
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
      rebuild();
      return true;
    },

    // `underwater` hides everything (there is no rain to see from under the sea) and `skyColor` is
    // the page's current background, which already carries the time of day and the overcast lid.
    update(dt, camera, { underwater = false, skyColor = null } = {}) {
      // A volumetric toggle swaps `heights` for `surfaceHeights`, which is a different window and
      // therefore a different texture: the graph has to be rebuilt, not re-pointed.
      if (currentContact() !== contactWin) {
        bindContact();
        uSlopeStep.value = uUseFine.value > 0 && contactWin ? contactWin.post : seaDepth.spacing;
        rebuild();
      }
      const o = worldCoordinates ? worldCoordinates.getOrigin() : [0, 0, 0];
      uOffset.value.set(o[0], o[2]);
      uOriginY.value = o[1];
      // The shadow's centre and floor are global, so a rebase is a uniform write, not a re-bake.
      syncOccluderUniforms(o[0], o[2], o[1]);
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
      contactRelease?.(); contactRelease = null;
      occ?.dispose(); occ = null;
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
