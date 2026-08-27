// base-game-flora.js — Base Game's plant layers over the streamed terrain (plants plan F5+).
//
// Grass first. The blades themselves are grass-compute.js unchanged: a GPU-driven candidate window
// that plants each blade on a terrain height and thins it by a density field. What Base Game hands
// it is where to read those two things — the terrain's own streamed windows, through injected TSL
// samplers built once at construction.
//
// Three things this module exists to get right:
//   - The frame boundary. Candidates and the camera are RENDER-LOCAL; the field windows are indexed
//     GLOBALLY. The adapters add the render origin before sampling and subtract its Y afterwards, so
//     a rebase moves a uniform rather than rebuilding a shader.
//   - Contact. Height comes from the lod-0 contact window — the exact field the visible chunks are
//     built from — and blades sit a few centimetres low on purpose. A sunk blade is invisible; a
//     floating one shows daylight underneath.
//   - Lifetime. grass-compute.js's dispose() does not free its storage buffers, so grass is built
//     ONCE at the widest supported radius and every slider maps to a setter.

import * as THREE from 'three';
import { Fn, float, vec2, uniform } from 'three/tsl';

export const BASE_GAME_FLORA_DEFAULTS = Object.freeze({
  grassEnabled: true,
  grassDensity: 12,           // blades per square metre
  // Metres, clamped to the contact window's safe half-extent: 160 m of window is 56 m of usable
  // circle. A wider grass radius wants a wider contact window, not a bigger number here.
  grassRadius: 55,
  grassCullStart: 0,          // 0 = radius * 0.8, grass-compute's own default
  grassBladeHeight: 1,
  grassBladeWidth: 1,
  grassWind: 1,
  grassStyle: 'streaks',
  grassVerticalOffset: -0.05,  // bias low, never high
  grassCoverGate: 1,           // how hard scalar cover thins the field (0 = ignore cover)
  maxRadiusHeadroom: 1.6,      // buffers are sized for radius x this, so the slider has room
  grassKmax: 256,              // blades per 2 m cell; the density ceiling is this / cellSize^2
});

// The contact window is a square; its safe half-extent is what a circular radius can use without
// reaching a corner the window does not hold.
export function safeRadiusFor(window, headroom = 1) {
  if (!window) return 0;
  return Math.max(0, (window.extent / 2) / Math.SQRT2 / Math.max(1e-6, headroom));
}

export function createBaseGameFlora({ THREE: injectedTHREE = THREE, renderer, scene, camera, terrain, worldCoordinates, settings = {} } = {}) {
  if (!scene?.add) throw new TypeError('flora needs a scene');
  if (!terrain?.acquireFields) throw new TypeError('flora needs the Base Game terrain facade');
  const cfg = { ...BASE_GAME_FLORA_DEFAULTS, ...settings };

  let grass = null, grassModule = null, onMeshCb = null, uCoverGate = null;
  let releaseFields = null, releaseContact = null;
  let enabled = false, active = false, built = false;
  let maxRadius = 0;
  const stats = { enabled: false, built: false, radius: 0, requestedRadius: 0, maxRadius: 0, density: 0,
    requestedDensity: 0, maxDensity: 0, capacity: 0, dispatch: 0, reculls: 0, skippedReculls: 0, coverage: 0, lastError: null };

  // Global = render-local + origin. One vec3 uniform, mutated on rebase; the graph never rebuilds.
  const uRenderOrigin = uniform(new injectedTHREE.Vector3());
  const originScratch = [0, 0, 0];        // getOrigin() allocates without one, and this runs per frame
  function readOrigin() {
    return worldCoordinates?.getOrigin?.(originScratch) ?? originScratch;
  }
  function syncOrigin() {
    const o = readOrigin();
    uRenderOrigin.value.set(o[0], o[1], o[2]);
  }
  syncOrigin();

  function buildSamplers() {
    const contact = terrain.contactField;
    const field = terrain.fields;
    if (!contact) return null;
    const originXZ = vec2(uRenderOrigin.x, uRenderOrigin.z);
    const contactField = contact.fields.includes('surfaceHeights') ? 'surfaceHeights' : 'heights';
    const height = contact.gpuSampler(contactField);
    // Render-local (x, z) in, render-local Y out. Outside the window the fallback sinks the blade
    // far below the ground, where grass-compute's own water/height gates drop it.
    const heightNode = Fn(([x, z]) => height(vec2(x, z).add(originXZ), float(-1e5)).sub(uRenderOrigin.y));
    // Scalar grass cover, 0..255 from the r8unorm channel, gated to 0..1. No cover field yet (the
    // placement window is optional) means an unthinned field, which is the previous look.
    const coverSampler = field?.fields.includes('coverGrass') ? field.gpuSampler('coverGrass') : null;
    uCoverGate = uniform(cfg.grassCoverGate);
    const densityNode = coverSampler
      ? Fn(([x, z]) => {
          const cover = coverSampler(vec2(x, z).add(originXZ), float(0)).div(255).clamp(0, 1);
          return float(1).sub(uCoverGate).add(cover.mul(uCoverGate)).clamp(0, 1);
        })
      : null;
    return { heightNode, densityNode };
  }

  // One construction, at the widest radius the sliders can reach: grass-compute cannot free its
  // storage buffers, so a live rebuild would leak them.
  async function build() {
    if (built || !grassModule) return false;
    const contact = terrain.contactField;
    if (!contact) return false;
    const samplers = buildSamplers();
    if (!samplers) return false;
    maxRadius = Math.min(safeRadiusFor(contact), cfg.grassRadius * cfg.maxRadiusHeadroom);
    const radius = Math.min(cfg.grassRadius, maxRadius);
    grass = grassModule.createComputeGrass({
      renderer, camera,
      radius, maxRadius,
      Kmax: cfg.grassKmax,
      density: cfg.grassDensity,
      cullStart: cfg.grassCullStart || null,
      bladeHeight: cfg.grassBladeHeight,
      bladeWidth: cfg.grassBladeWidth,
      verticalOffset: cfg.grassVerticalOffset,
      waterLevel: terrain.seaLevel - readOrigin()[1],
      heightNode: samplers.heightNode,
      densityNode: samplers.densityNode,
    });
    grass.mesh.frustumCulled = false;
    scene.add(grass.mesh);
    onMeshCb?.(grass.mesh);
    grass.setWind?.(cfg.grassWind);
    grass.setBladeStyle?.(cfg.grassStyle);
    built = true;
    stats.built = true;
    stats.maxRadius = maxRadius;
    return true;
  }

  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    stats.enabled = next;
    if (enabled) {
      releaseFields ??= terrain.acquireFields();
      releaseContact ??= terrain.acquireContactField();
    } else {
      releaseFields?.(); releaseFields = null;
      releaseContact?.(); releaseContact = null;
    }
    if (grass) grass.mesh.visible = enabled;
    active = enabled;
  }

  return {
    stats,
    get grass() { return grass; },
    get built() { return built; },
    get maxRadius() { return maxRadius; },
    // The module is lazily imported so a page with grass off never pays for it.
    async load() {
      if (grassModule) return true;
      try {
        grassModule = await import('./grass-compute.js');
        return true;
      } catch (err) {
        stats.lastError = String(err?.message ?? err);
        return false;
      }
    },
    setEnabled,
    // The host hears about the mesh once it exists, so it can keep it out of the water mirror.
    onMesh(fn) { onMeshCb = fn; if (grass) fn(grass.mesh); },
    async update(seconds) {
      if (!enabled) return false;
      syncOrigin();
      if (!built) { const ok = await build(); if (!ok) return false; }
      // Sea level and the origin both move; the water gate is in render-local Y like the blades.
      grass.setWaterLevel(terrain.seaLevel - uRenderOrigin.value.y);
      await grass.update(seconds);
      // The surviving blade count is written by the GPU into the indirect buffer, so the CPU can
      // only report capacity and whether the cull actually ran.
      stats.capacity = grass.stats.capacity;
      stats.reculls = grass.stats.reculls;
      stats.skippedReculls = grass.stats.skippedReculls;
      stats.coverage = terrain.contactField?.coverage ?? 0;
      // Both sliders clamp; report the value in force and keep the request beside it.
      stats.radius = grass ? Math.min(cfg.grassRadius, maxRadius || cfg.grassRadius) : 0;
      stats.requestedRadius = cfg.grassRadius;
      stats.density = Math.min(cfg.grassDensity, grass.stats.maxDensity);
      stats.requestedDensity = cfg.grassDensity;
      stats.maxDensity = grass.stats.maxDensity;
      stats.dispatch = grass.stats.dispatch;
      return true;
    },
    // Every knob is a setter on the one instance. Radius is clamped to what the window can serve
    // and to what the buffers were sized for; nothing here reallocates.
    apply(next = {}) {
      Object.assign(cfg, next);
      if (!grass) return;
      const radius = Math.max(1, Math.min(cfg.grassRadius, maxRadius || cfg.grassRadius));
      grass.setRadius(radius);
      grass.setDensity(cfg.grassDensity);
      grass.setCullStart(cfg.grassCullStart || radius * 0.8);
      grass.setBladeHeight(cfg.grassBladeHeight);
      grass.setBladeWidth(cfg.grassBladeWidth);
      grass.setVerticalOffset(cfg.grassVerticalOffset);
      grass.setWind(cfg.grassWind);
      grass.setBladeStyle?.(cfg.grassStyle);
      if (uCoverGate && uCoverGate.value !== cfg.grassCoverGate) {
        uCoverGate.value = cfg.grassCoverGate;
        grass.forceRecull();
      }
    },
    setLook(partial) { grass?.setLook?.(partial); },
    setSunDir(v) { grass?.setSunDir?.(v); },
    dispose() {
      setEnabled(false);
      if (grass) { scene.remove(grass.mesh); grass.dispose(); grass = null; }
      built = false;
    },
  };
}
