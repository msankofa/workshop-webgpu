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
//   - Lifetime. The storage buffers are sized at construction, so grass is built ONCE at the widest
//     supported radius and every slider maps to a setter; dispose() does free them.

import * as THREE from 'three';
import { Fn, float, vec2, uniform, select, mix, length, texture, clamp, step } from 'three/tsl';
import { createFloraOcclusion } from './flora-occlusion.js';

export const BASE_GAME_FLORA_DEFAULTS = Object.freeze({
  grassEnabled: true,
  grassDensity: 12,           // blades per square metre
  grassRadius: 55,
  grassCullStart: 0,          // 0 = radius * 0.8, grass-compute's own default
  grassBladeHeight: 1,
  grassBladeWidth: 1,
  grassWind: 1,
  grassStyle: 'streaks',
  grassVerticalOffset: -0.05,  // bias low, never high
  grassCoverGate: 1,           // how hard scalar cover thins the field (0 = ignore cover)
  grassCoverFloor: 0,          // the density fraction kept where cover is 0 (0 = bare stays bare)
  // Distance tiers (grass plan phase 3): the density slider is the inner tier; the middle and far
  // tiers are fractions of it past their radii. 0 radii mean one tier, the old field. Raising
  // the draw radius then thins the far tier, not the grass at your feet.
  grassTierMid: 0,             // where the inner tier ends (m); 0 = no tiers
  grassMidDensity: 0.5,        // fraction of the density slider in the middle tier
  grassTierFar: 0,             // where the middle tier ends (m); 0 = no far tier
  grassFarDensity: 0.25,       // fraction in the far tier
  // Draw cost (grass plan phase 4). The view cone and its near keep are grass-compute's own
  // defaults; shading and shadow receive are the original look.
  grassFrustumCull: true,      // drop blades outside the camera's horizontal field of view
  grassNearKeep: 6,            // metres around the camera kept whatever the cone says
  grassShading: 'standard',    // 'standard' (PBR) or 'lambert' (diffuse only, cheaper per fragment)
  grassReceiveShadow: true,
  grassKmax: 512,              // blades per 2 m cell; the density ceiling is this / cellSize^2
  // The ceiling the radius slider can reach. Height comes from the contact window close in and the
  // 2 km placement window past it, so the limit is this number and the buffer budget, not a window.
  grassMaxRadius: 600,
  // Instance-buffer budget in MB at 32 bytes a blade. Sizing for the theoretical worst case (every
  // cell full out to grassMaxRadius) would be 331 MB for a field the cull gradient never fills.
  grassBufferMB: 96,
  // Millions of candidate threads a recull may dispatch. Radius and density both multiply into it,
  // so the far corner of the two sliders is a hang without a ceiling; over it, the field thins and
  // says so rather than stalling.
  grassDispatchBudgetM: 8,
  // What far blades stand on past the contact window (grass plan phase 5): 'drawn' is the height
  // the far rings actually draw (the clipmap's own textures, with its morph), 'field' the 8 m
  // placement field, which sits a median 0.35 m and a p95 3.5 m off the drawn ground. Without
  // rings (far LOD off, volumetric worlds) 'drawn' falls back to the field and the stats say so.
  grassHeightSource: 'drawn',
  // The field samplers return "missing" for a tile that has not landed (the residency gate). Off,
  // they trust the bounds test alone and read whatever the window holds, as before 2026-09-03.
  grassResidencyGate: false,
  grassNearFade: 10,           // metres over which height crosses from the contact to the placement window
  grassHandoverDistance: 0,    // where that crossing starts; 0 = the contact window's reach less the band
  // The distance fade in pieces (grass plan phase 2). Every 0 below means "as before": the keep
  // ramp ends at the radius, blades thin but do not shrink, the tint follows the keep ramp, and
  // nothing fades near the camera.
  grassFadeEnd: 0,             // where keep probability reaches 0 (m); 0 = the draw radius
  grassFadeCurve: 1,           // power on the ramp; above 1 holds density then drops it late
  grassFadeHeight: 0,          // 0..1, how far blades shrink across the fade band
  grassFadeWidth: 0,           // 0..1, how far they thin
  grassTintFadeStart: 0,       // the ground-tint ramp's own band (m); 0 = the keep band
  grassTintFadeEnd: 0,
  grassNearFadeStart: 0,       // blades nearer than this vanish, growing to full height by the end (m)
  grassNearFadeEnd: 0,         // 0 = off
  // Blades take the colour of the ground they stand on: at the root, and everywhere at the draw
  // edge, so the field dissolves into the terrain rather than ending on a line.
  grassGroundTint: 0.8,
  grassGroundTintFar: 1,
  // How far up the blade the root tint reaches, as 1 - smoothstep(0, reach, t). 0.35 confined it
  // to the base you never see from eye height; 0.7 carries it into the visible mid-blade.
  grassGroundTintReach: 0.7,
  // Mip the ground textures are read at, per blade. 0 is per-texel noise; 6 on a 1024 px map over
  // a 4 m tile is a 25 cm texel, roughly a blade's footprint, which is what blending wants.
  grassGroundTintMip: 6,
  // 'palette' (the tint sliders decide), 'ground' (tint 1 everywhere), 'proof' (the raw ground
  // sample and nothing else, for checking the sampling by eye).
  grassColorMode: 'palette',
  // grass-look's faceNormalMix: how much of the blade's own face is in the lighting normal, the
  // rest being straight up. Its default; base-game never set it before.
  grassFaceNormalMix: 0.65,
});

// Blades a full disc holds once the edge fade has thinned it. Keep probability is 1 up to
// cullStart and falls as t^curve to 0 at fadeEnd (the radius unless set), so this is the area
// integral of that, not pi*r^2: with b = fadeEnd - cullStart the band holds
// 2*pi*b*(c*(1 - 1/(p+1)) + b*(1/2 - 1/(p+2))) per blade of density. It is still an UPPER bound:
// biome cover and the water gate thin further, and neither is knowable on the CPU.
// With distance tiers ([{ radius, density }], density a fraction) the closed form no longer
// applies, so the disc is integrated numerically in 1024 rings; the closed form is what the test
// pins the linear, single-tier case against.
export function expectedBlades(radius, density, cullStart, fadeEnd = 0, curve = 1, tiers = null) {
  const r = Math.max(0, radius), d = Math.max(0, density);
  if (!r || !d) return 0;
  const c = Math.max(0, Math.min(cullStart || r * 0.8, r));
  const e = Math.max(c, Math.min(fadeEnd || r, r));
  const b = e - c, p = Math.max(0.01, curve || 1);
  if (!tiers?.length || (tiers.length === 1 && tiers[0].density === 1)) {
    const outer = b > 1e-6 ? 2 * Math.PI * b * (c * (1 - 1 / (p + 1)) + b * (0.5 - 1 / (p + 2))) : 0;
    return Math.round((Math.PI * c * c + outer) * d);
  }
  const N = 1024, dr = e / N;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) * dr;
    const keep = x <= c ? 1 : b > 1e-6 ? 1 - ((x - c) / b) ** p : 0;
    let frac = tiers[tiers.length - 1].density;
    for (const t of tiers) if (x <= t.radius) { frac = t.density; break; }
    sum += 2 * Math.PI * x * keep * frac * dr;
  }
  return Math.round(sum * d);
}

// The grass-compute tier spec for a settings block: [{ radius, density }], the last open-ended.
export function tierSpecFor(cfg) {
  const mid = Math.max(0, cfg.grassTierMid || 0), far = Math.max(0, cfg.grassTierFar || 0);
  const tiers = [];
  if (mid > 0 && far > mid) {
    tiers.push({ radius: mid, density: 1 }, { radius: far, density: cfg.grassMidDensity }, { radius: Infinity, density: cfg.grassFarDensity });
  } else if (mid > 0) {
    tiers.push({ radius: mid, density: 1 }, { radius: Infinity, density: cfg.grassMidDensity });
  } else if (far > 0) {
    tiers.push({ radius: far, density: 1 }, { radius: Infinity, density: cfg.grassFarDensity });
  } else {
    tiers.push({ radius: Infinity, density: 1 });
  }
  return tiers;
}

// How far from the player a square window can be trusted. Half the extent, less the half tile the
// origin can be snapped away by (`desiredOrigin` rounds to whole tiles), so the answer holds
// wherever the player sits inside the centre tile. There is no sqrt(2) here: the corners of a
// square are its FARTHEST points, so a circle grown from the centre reaches an edge long before it
// reaches a corner. An earlier version divided by sqrt(2) and gave away 13 m for nothing.
export function safeRadiusFor(window, headroom = 1) {
  if (!window) return 0;
  const tile = window.tileSize ?? 0;
  return Math.max(0, (window.extent / 2 - tile / 2) / Math.max(1e-6, headroom));
}

export function createBaseGameFlora({ THREE: injectedTHREE = THREE, renderer, scene, camera, terrain, worldCoordinates, settings = {} } = {}) {
  if (!scene?.add) throw new TypeError('flora needs a scene');
  if (!terrain?.acquireFields) throw new TypeError('flora needs the Base Game terrain facade');
  const cfg = { ...BASE_GAME_FLORA_DEFAULTS, ...settings };

  let grass = null, grassModule = null, onMeshCb = null, uCoverGate = null, uCoverFloor = null;
  // A structure (the spawn building): inside its global rectangle the density and height come
  // from its painted textures, a planter biome, and the terrain samplers stop applying. The
  // textures are read through nodes whose values swap on setStructure, so no graph rebuild.
  let structure = null;
  const uStructOn = uniform(0);
  const uStructMin = uniform(new injectedTHREE.Vector2());
  const uStructSize = uniform(new injectedTHREE.Vector2(1, 1));
  const placeholderTex = new injectedTHREE.DataTexture(new Float32Array([0]), 1, 1, injectedTHREE.RedFormat, injectedTHREE.FloatType);
  placeholderTex.minFilter = placeholderTex.magFilter = injectedTHREE.NearestFilter;   // r32float is unfilterable
  placeholderTex.needsUpdate = true;
  const structDensityNode = texture(placeholderTex);
  const structHeightNode = texture(placeholderTex);
  // The occluder depth image the cull kernels test against; built on the first setOccluders.
  let occlusion = null, occluderRoot = null;
  function wrapStructure(samplers) {
    const originXZ = vec2(uRenderOrigin.x, uRenderOrigin.z);
    const inside = (g) => {
      const t = g.sub(uStructMin).div(uStructSize);
      return uStructOn.greaterThan(0.5)
        .and(t.x.greaterThan(0)).and(t.x.lessThan(1)).and(t.y.greaterThan(0)).and(t.y.lessThan(1));
    };
    const uvOf = (g) => clamp(g.sub(uStructMin).div(uStructSize), 0, 1);
    // A texel below zero means "not the structure's ground": the courts between a building's
    // wings sit inside its rectangle but are terrain, so the terrain samplers answer there.
    const terrainDensity = samplers.densityNode || Fn(() => float(1));
    const densityNode = Fn(([x, z]) => {
      const g = vec2(x, z).add(originXZ);
      const d = structDensityNode.sample(uvOf(g)).r;
      return select(inside(g).and(d.greaterThanEqual(0)), d, terrainDensity(x, z));
    });
    const heightNode = Fn(([x, z]) => {
      const g = vec2(x, z).add(originXZ);
      const h = structHeightNode.sample(uvOf(g)).r;
      const d = structDensityNode.sample(uvOf(g)).r;
      return select(inside(g).and(d.greaterThanEqual(0)), h.sub(uRenderOrigin.y), samplers.heightNode(x, z));
    });
    return { ...samplers, densityNode, heightNode };
  }
  let releaseFields = null, releaseContact = null;
  let enabled = false, active = false, built = false;
  let maxRadius = 0;
  const stats = { enabled: false, built: false, radius: 0, requestedRadius: 0, maxRadius: 0, density: 0,
    requestedDensity: 0, maxDensity: 0, capacity: 0, dispatch: 0, expected: 0, truncating: false, dispatchClamped: false,
    reculls: 0, skippedReculls: 0, coverage: 0, placementCoverage: 0, lastError: null,
    // Readbacks on a timer: blades the last cull kept, the ground colour under the camera as the
    // cull packs it (global y), and the CPU twin of that colour from the layer averages.
    drawn: null, probe: null, groundTwin: null, probeError: null, coverHere: null, waitingOnTextures: false,
    rebuilds: 0, recullRate: 0 };

  // Global = render-local + origin. One vec3 uniform, mutated on rebase; the graph never rebuilds.
  const uRenderOrigin = uniform(new injectedTHREE.Vector3());
  const uCamXZ = uniform(new injectedTHREE.Vector2());
  let uNearEnd = null, uFadeBand = null;
  const uHeightSource = uniform(0);      // 0 = placement field, 1 = the drawn rings
  const uDrawnReady = uniform(0);        // 1 once the rings the graph reads have streamed
  let drawnAvailable = false, drawnRetried = false;
  let lastStreamed = -1, lastStreamRecull = -Infinity, pendingStreamRecull = false;
  const HEIGHT_MISSING = -1e6;                 // sentinel: the window had nothing at this xz
  const originScratch = [0, 0, 0];        // getOrigin() allocates without one, and this runs per frame
  function readOrigin() {
    return worldCoordinates?.getOrigin?.(originScratch) ?? originScratch;
  }
  function syncOrigin() {
    const o = readOrigin();
    uRenderOrigin.value.set(o[0], o[1], o[2]);
    // Placement hashes and world-space samples add this back, so a rebase does not re-roll the field.
    grass?.setWorldOrigin?.(o[0], o[2]);
  }
  syncOrigin();

  const heightFieldOf = w => (w?.fields.includes('surfaceHeights') ? 'surfaceHeights'
    : w?.fields.includes('heights') ? 'heights' : null);
  // Where the height handover to the coarse field starts: set, or the contact window's reach
  // less the band so the crossing finishes before the exact heights run out.
  const handoverDistance = () => (cfg.grassHandoverDistance > 0
    ? cfg.grassHandoverDistance
    : Math.max(4, safeRadiusFor(terrain.contactField) - cfg.grassNearFade));

  function buildSamplers() {
    const contact = terrain.contactField;
    const field = terrain.fields;
    if (!contact) return null;
    const originXZ = vec2(uRenderOrigin.x, uRenderOrigin.z);
    const nearField = heightFieldOf(contact);
    const farField = heightFieldOf(field);
    const near = contact.gpuSampler(nearField);
    const far = farField ? field.gpuSampler(farField) : null;
    // Only the ring levels the radius can reach are compiled in: each is a sampled-texture binding
    // in the cull, and with the splat maps, the windows, their residency masks and an occluder image
    // the stage passed WebGPU's default 16 (the page asks the adapter for more; a device that did
    // not grant it keeps the field).
    const sampledLimit = renderer?.backend?.device?.limits?.maxSampledTexturesPerShaderStage;
    const roomForRings = sampledLimit === undefined || sampledLimit > 16;
    const drawn = roomForRings ? (terrain.drawnHeightNodeFor?.(cfg.grassMaxRadius) ?? terrain.drawnHeightNode ?? null) : null;
    drawnAvailable = !!drawn;
    stats.sampledTextureLimit = sampledLimit ?? null;
    stats.ringsWhy = drawn ? '' : !roomForRings ? `the device allows ${sampledLimit} sampled textures` : 'far LOD off or a volumetric world';
    uHeightSource.value = (cfg.grassHeightSource === 'drawn' && drawn) ? 1 : 0;
    // Contact posts are 1.25 m and reach ~70 m; the placement window is 8 m posts over 2 km. Blades
    // cross from one to the other over a band, by distance from the camera rather than by window
    // edge, so the handover is a fixed ring and not a moving square.
    uNearEnd = uniform(handoverDistance());
    uFadeBand = uniform(Math.max(0.5, cfg.grassNearFade));
    // Render-local (x, z) in, render-local Y out. MISSING sinks the blade far below the ground,
    // where grass-compute's own water/height gates drop it.
    const heightNode = Fn(([x, z]) => {
      const g = vec2(x, z).add(originXZ);
      const hNear = near(g, float(HEIGHT_MISSING));
      const hField = far ? far(g, float(HEIGHT_MISSING)) : float(HEIGHT_MISSING);
      // Past the contact window: the drawn rings' height when chosen and available, else the field.
      // The rings' windows are zero-filled on a restream and their sampler clamps instead of
      // reporting a hole, so the drawn source is used only while the rings have streamed.
      const hFar = drawn ? select(uHeightSource.greaterThan(0.5).and(uDrawnReady.greaterThan(0.5)), drawn(g), hField) : hField;
      const nearOk = hNear.greaterThan(float(HEIGHT_MISSING / 2));
      const farOk = hFar.greaterThan(float(HEIGHT_MISSING / 2));
      const t = length(vec2(x, z).sub(uCamXZ)).sub(uNearEnd).div(uFadeBand).clamp(0, 1);
      // Never blend toward a sample that is not there.
      const blended = mix(hNear, hFar, select(farOk, t, float(0)));
      return select(nearOk, blended, select(farOk, hFar, float(-1e5))).sub(uRenderOrigin.y);
    });
    // Scalar grass cover, 0..255 from the r8unorm channel, gated to 0..1. No cover field yet (the
    // placement window is optional) means an unthinned field, which is the previous look.
    const coverSampler = field?.fields.includes('coverGrass') ? field.gpuSampler('coverGrass') : null;
    uCoverGate = uniform(cfg.grassCoverGate);
    uCoverFloor = uniform(cfg.grassCoverFloor);
    const densityNode = coverSampler
      ? Fn(([x, z]) => {
          const cover = coverSampler(vec2(x, z).add(originXZ), float(0)).div(255).clamp(0, 1);
          // The floor keeps a fraction of the density where nothing grows, beside the gate.
          return float(1).sub(uCoverGate).add(cover.mul(uCoverGate)).max(uCoverFloor).clamp(0, 1);
        })
      : null;
    // The ground colour a blade should read as. Terrain owns it, because what the ground actually
    // shows is the splat textures' average when ground textures are on and the vertex tint when
    // they are off -- the earlier version of this tinted toward the tint either way, which is the
    // colour the terrain is NOT showing by default. Slope is a central difference on the coarse
    // window, and this runs once per SURVIVING blade in the cull.
    const groundColor = terrain.groundColorNode?.() ?? null;
    terrain.setGroundColorMip?.(cfg.grassGroundTintMip);
    const groundColorNode = (far && groundColor) ? Fn(([x, z, y]) => {
      const g = vec2(x, z).add(originXZ);
      const yGlobal = y.add(uRenderOrigin.y);
      const p = float(field.post);
      const hx1 = far(vec2(g.x.add(p), g.y), yGlobal), hx0 = far(vec2(g.x.sub(p), g.y), yGlobal);
      const hz1 = far(vec2(g.x, g.y.add(p)), yGlobal), hz0 = far(vec2(g.x, g.y.sub(p)), yGlobal);
      const dx = hx1.sub(hx0).div(p.mul(2)), dz = hz1.sub(hz0).div(p.mul(2));
      const normalY = float(1).div(dx.mul(dx).add(dz.mul(dz)).add(1).sqrt());
      // The maps are tiled at RENDER-LOCAL xz, because that is the frame the terrain material
      // tiles them from (positionWorld); the weights take the global height.
      return groundColor(x, z, yGlobal, normalY);
    }) : null;
    return { heightNode, densityNode, groundColorNode };
  }

  // One construction, at the widest radius the sliders can reach: grass-compute cannot free its
  // storage buffers, so a live rebuild would leak them.
  // Ground textures load in the background and the grass graph is built once, so building before
  // they land would leave blades tinted from the fallback for the session -- whatever the textures
  // toggle says at boot, since it can be turned on later. Bounded, because a failed load must not
  // stop grass forever.
  let groundWait = 0;
  const GROUND_WAIT_FRAMES = 600;
  let appliedMip = null;
  // The buffer budget and the per-cell cap size the storage buffers, so changing either is a
  // teardown and a fresh build on the next update; dispose() frees the buffers.
  let builtWith = null;
  function rebuild() {
    if (!grass) return;
    const previousMesh = grass.mesh;
    scene.remove(grass.mesh);
    grass.dispose();
    grass = null;
    built = false;
    stats.built = false;
    stats.rebuilds++;
    onMeshCb?.(null, previousMesh);
  }
  async function build() {
    if (built || !grassModule) return false;
    const contact = terrain.contactField;
    if (!contact) return false;
    const texturesIn = terrain.groundTexturesLoaded ?? (terrain.groundColorReady !== false);
    stats.waitingOnTextures = !texturesIn;
    if (!texturesIn && groundWait++ < GROUND_WAIT_FRAMES) return false;
    stats.waitingOnTextures = false;
    appliedMip = cfg.grassGroundTintMip;
    const samplers = wrapStructure(buildSamplers());
    if (!samplers) return false;
    // The reach of the widest window that can supply a height, capped by the slider's own ceiling.
    const reach = Math.max(safeRadiusFor(contact), heightFieldOf(terrain.fields) ? safeRadiusFor(terrain.fields) : 0);
    maxRadius = Math.max(1, Math.min(cfg.grassMaxRadius, reach));
    const radius = Math.min(cfg.grassRadius, maxRadius);
    grass = grassModule.createComputeGrass({
      renderer, camera,
      radius, maxRadius,
      Kmax: cfg.grassKmax,
      maxInstances: Math.floor(cfg.grassBufferMB * 1e6 / 32),
      dispatchBudget: Math.floor(cfg.grassDispatchBudgetM * 1e6),
      density: cfg.grassDensity,
      cullStart: cfg.grassCullStart || null,
      bladeHeight: cfg.grassBladeHeight,
      bladeWidth: cfg.grassBladeWidth,
      verticalOffset: cfg.grassVerticalOffset,
      waterLevel: terrain.seaLevel - readOrigin()[1],
      heightNode: samplers.heightNode,
      densityNode: samplers.densityNode,
      groundColorNode: samplers.groundColorNode,
      groundTint: cfg.grassGroundTint,
      groundTintFar: cfg.grassGroundTintFar,
      groundTintReach: cfg.grassGroundTintReach,
      colorMode: cfg.grassColorMode,
      fadeEnd: cfg.grassFadeEnd || null,
      fadeCurve: cfg.grassFadeCurve,
      fadeHeight: cfg.grassFadeHeight,
      fadeWidth: cfg.grassFadeWidth,
      tintFadeStart: cfg.grassTintFadeStart || null,
      tintFadeEnd: cfg.grassTintFadeEnd || null,
      nearFadeStart: cfg.grassNearFadeStart,
      nearFadeEnd: cfg.grassNearFadeEnd,
      tiers: tierSpecFor(cfg),
      frustumCull: cfg.grassFrustumCull,
      occlusion: occlusion ? occlusion.state : null,
      nearKeep: cfg.grassNearKeep,
      shading: cfg.grassShading,
    });
    builtWith = { bufferMB: cfg.grassBufferMB, kmax: cfg.grassKmax, fields: terrain.fields, contact: terrain.contactField };
    grass.setLook?.({ faceNormalMix: cfg.grassFaceNormalMix });
    grass.setReceiveShadow?.(cfg.grassReceiveShadow);
    grass.setWorldOrigin?.(readOrigin()[0], readOrigin()[2]);
    grass.mesh.frustumCulled = false;
    grass.mesh.name = 'base-game-grass';
    scene.add(grass.mesh);
    onMeshCb?.(grass.mesh, null);
    grass.setWind?.(cfg.grassWind);
    grass.setBladeStyle?.(cfg.grassStyle);
    built = true;
    stats.built = true;
    stats.maxRadius = maxRadius;
    return true;
  }

  // GPU readbacks for the panel, once a second: the blade count the last cull kept, and the ground
  // colour under the camera as the cull packs it, beside its CPU twin from the layer averages.
  let lastSample = -Infinity, sampling = false, lastReculls = 0, ringStep = 0;
  const ringResults = new Array(8).fill(null);
  const SAMPLE_EVERY = 1;
  function sampleReadbacks(seconds) {
    if (sampling || seconds - lastSample < SAMPLE_EVERY) return;
    // Reculls a second: the compute cost is per recull, so this says whether a spike is grass.
    stats.recullRate = (stats.reculls - lastReculls) / SAMPLE_EVERY;
    lastReculls = stats.reculls;
    if (typeof renderer?.getArrayBufferAsync !== 'function' || !grass?.readBladeCount) { lastSample = seconds; return; }
    sampling = true; lastSample = seconds;
    const o = uRenderOrigin.value, ox = o.x, oy = o.y, oz = o.z;
    const x = camera.position.x, z = camera.position.z;
    stats.groundTwin = terrain.groundColorAt?.(x + ox, z + oz) ?? null;
    // Diagnostics the panel prints beside the readbacks: the structure rectangle (the spawn
    // building's footprint, where the terrain samplers stop applying) and the residency masks.
    stats.structure = structure ? {
      w: structure.bounds.worldX, d: structure.bounds.worldZ,
      distance: Math.hypot(x + ox - (structure.bounds.minX + structure.bounds.worldX / 2), z + oz - (structure.bounds.minZ + structure.bounds.worldZ / 2)),
      inside: x + ox > structure.bounds.minX && x + ox < structure.bounds.minX + structure.bounds.worldX
        && z + oz > structure.bounds.minZ && z + oz < structure.bounds.minZ + structure.bounds.worldZ,
    } : null;
    const holes = w => (w?.residency ? w.residency.reduce((n, v) => n + (v ? 0 : 1), 0) : null);
    stats.maskHoles = { contact: holes(terrain.contactField), placement: holes(terrain.fields) };
    // A tile build that throws is swallowed into the window's stats, and that tile never lands.
    stats.windowError = terrain.fields?.stats?.lastError ?? terrain.contactField?.stats?.lastError ?? null;
    // A second probe walks a ring around the camera, one step a second, so a hole in the far
    // height (a tile the GPU reads as not landed, or anything else that sinks a blade) shows up
    // as a count rather than as a missing block you have to spot.
    const RING_R = 45, k = ringStep++ % 8, a = k * Math.PI / 4;
    const rx = x + Math.cos(a) * RING_R, rz = z + Math.sin(a) * RING_R;
    Promise.all([grass.readBladeCount(), grass.readGroundProbe ? grass.readGroundProbe(x, z) : null,
      grass.readGroundProbe ? grass.readGroundProbe(rx, rz) : null])
      .then(([drawn, probe, ring]) => {
        stats.drawn = drawn;
        // probeDelta: how far the height the cull used sits from the drawn ground there.
        const ground = terrain.groundHeight?.(x + ox, z + oz);
        stats.probe = probe ? { r: probe.r, g: probe.g, b: probe.b, y: probe.y + oy,
          delta: Number.isFinite(ground) ? probe.y + oy - ground : null } : null;
        if (ring) {
          const g2 = terrain.groundHeight?.(rx + ox, rz + oz);
          // One letter per direction: what would kill a blade there. '.' = nothing, h = height
          // missing, w = under the water line, d = density 0, c = outside the view cone.
          const why = ring.y < -1e4 ? 'h' : !ring.aboveWater ? 'w' : ring.density <= 0 ? 'd' : !ring.inCone ? 'c' : '.';
          ringResults[k] = { missing: ring.y < -1e4, why, delta: Number.isFinite(g2) ? ring.y + oy - g2 : null };
          const seen = ringResults.filter(Boolean);
          stats.ringProbe = { radius: RING_R, of: seen.length, missing: seen.filter(r => r.missing).length,
            worst: seen.reduce((m, r) => (r.delta != null && Math.abs(r.delta) > Math.abs(m) ? r.delta : m), 0),
            compass: ['+x', '+x+z', '+z', '-x+z', '-x', '-x-z', '-z', '+x-z'].map((d, i) => `${d}:${ringResults[i]?.why ?? '?'}`).join(' ') };
        }
        stats.probeError = null;
      })
      .catch(err => { stats.probeError = String(err?.message ?? err); })
      .finally(() => { sampling = false; });
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
      // Releasing the last holder disposes the windows, so the graph goes with them.
      rebuild();
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
    // Notify removal too: a mirror exclusion retaining a disposed mesh also retains its node
    // graph and CPU storage arrays. Arguments are (currentMesh, removedMesh).
    onMesh(fn) { onMeshCb = fn; if (grass) fn(grass.mesh, null); },
    // { bounds: {minX, minZ, worldX, worldZ}, densityTex, heightTex } in GLOBAL metres, or null.
    // Live: the uniforms and texture nodes swap without a rebuild.
    setStructure(next) {
      structure = next || null;
      uStructOn.value = structure ? 1 : 0;
      if (structure) {
        uStructMin.value.set(structure.bounds.minX, structure.bounds.minZ);
        uStructSize.value.set(Math.max(1e-3, structure.bounds.worldX), Math.max(1e-3, structure.bounds.worldZ));
        structDensityNode.value = structure.densityTex;
        structHeightNode.value = structure.heightTex;
      } else {
        structDensityNode.value = placeholderTex;
        structHeightNode.value = placeholderTex;
      }
      grass?.forceRecull?.();
    },
    // The group whose opaque meshes occlude blades. The kernels compile the test in at build, so
    // the first call before the grass exists is free; a later first call rebuilds the field.
    setOccluders(root) {
      occluderRoot = root || null;
      if (!occluderRoot) { if (occlusion) occlusion.setEnabled(false); return; }
      if (!occlusion) {
        occlusion = createFloraOcclusion({ renderer, scene, camera });
        if (grass) rebuild();
      }
      occlusion.setEnabled(true);
      occlusion.markOccluders(occluderRoot);
    },
    setOcclusionEnabled(on) { if (occlusion) occlusion.setEnabled(!!on); },
    get occlusion() { return occlusion ? occlusion.state : null; },
    async update(seconds) {
      if (!enabled) return false;
      syncOrigin();
      // The near/far height handover is a ring around the camera, so the graph needs where it is.
      uCamXZ.value.set(camera.position.x, camera.position.z);
      // The terrain re-keys its windows when the field set changes (a source swap into or out of
      // volumetric mode) and the registry disposes the old ones, so a graph built on them reads
      // dead textures and keeps nothing. New window objects mean a new graph.
      if (built && builtWith && (terrain.fields !== builtWith.fields || terrain.contactField !== builtWith.contact)) rebuild();
      if (!built) { const ok = await build(); if (!ok) return false; }
      // The far rings can appear after the grass was built (far LOD is applied by a later
      // settings pass). Once, when they do and the drawn source is wanted, build again on them.
      if (!drawnAvailable && !drawnRetried && cfg.grassHeightSource === 'drawn' && terrain.drawnHeightNode) {
        drawnRetried = true;
        rebuild();
        const ok = await build();
        if (!ok) return false;
      }
      // Sea level and the origin both move; the water gate is in render-local Y like the blades.
      grass.setWaterLevel(terrain.seaLevel - uRenderOrigin.value.y);
      // Read in the cull: while the rings restream, far blades stand on the field and come back
      // to the rings with one recull once every level the graph reads has landed.
      const ready = drawnAvailable && terrain.drawnHeightReady?.(cfg.grassMaxRadius) ? 1 : 0;
      if (uDrawnReady.value !== ready) { uDrawnReady.value = ready; grass.forceRecull(); }
      // Tiles landing change what the samplers return, and a cull that ran while a window was
      // empty stays that way until the next cell crossing; so a residency change reculls, at most
      // twice a second while a window is streaming.
      const streamed = (terrain.fields?.residencyRevision ?? 0) + (terrain.contactField?.residencyRevision ?? 0) * 1e6;
      if (streamed !== lastStreamed) {
        lastStreamed = streamed;
        pendingStreamRecull = true;
      }
      if (pendingStreamRecull && seconds - lastStreamRecull >= 0.5) {
        pendingStreamRecull = false;
        lastStreamRecull = seconds;
        grass.forceRecull();
      }
      if (occlusion && occlusion.state.enabled) occlusion.update();
      await grass.update(seconds);
      // The surviving blade count is written by the GPU into the indirect buffer, so the CPU can
      // only report capacity and whether the cull actually ran.
      stats.capacity = grass.stats.capacity;
      stats.reculls = grass.stats.reculls;
      stats.skippedReculls = grass.stats.skippedReculls;
      stats.coverage = terrain.contactField?.coverage ?? 0;
      stats.placementCoverage = terrain.fields?.coverage ?? 0;
      // Cover under the camera, so the panel can say what fraction of the density slider applies here.
      const o = uRenderOrigin.value;
      stats.coverHere = terrain.coverAt?.(camera.position.x + o.x, camera.position.z + o.z)?.grass ?? null;
      sampleReadbacks(seconds);
      // Both sliders clamp; report the value in force and keep the request beside it.
      stats.radius = grass ? Math.min(cfg.grassRadius, maxRadius || cfg.grassRadius) : 0;
      stats.requestedRadius = cfg.grassRadius;
      // grass-compute owns these now: density is thinned by the thread budget, not just clamped.
      stats.density = grass.stats.density;
      stats.requestedDensity = cfg.grassDensity;
      stats.dispatchClamped = grass.stats.dispatchClamped;
      stats.maxDensity = grass.stats.maxDensity;
      stats.dispatch = grass.stats.dispatch;
      // Blades the sliders are asking for against blades the buffer holds. Over the line the field
      // truncates at the far edge rather than clamping the sliders, so the panel can say so.
      stats.groundTint = grass.groundTint;
      stats.groundSamplesTextures = terrain.groundColorSamplesTextures ?? false;
      stats.tiers = grass.stats.tiers ?? null;
      stats.expected = expectedBlades(stats.radius, stats.density, cfg.grassCullStart || stats.radius * 0.8,
        cfg.grassFadeEnd, cfg.grassFadeCurve, stats.tiers?.map(t => ({ radius: t.radius, density: stats.density > 0 ? t.density / stats.density : 0 })));
      stats.truncating = stats.expected > stats.capacity;
      stats.fade = grass.fade ?? null;
      stats.handover = uNearEnd ? { distance: uNearEnd.value, band: uFadeBand.value } : null;
      stats.heightSource = uHeightSource.value > 0.5
        ? (uDrawnReady.value > 0.5 ? 'drawn' : 'field (rings streaming)')
        : drawnAvailable ? 'field' : 'field (no rings)';
      stats.lastRecull = grass.stats.lastRecull ?? '';
      return true;
    },
    // Every knob is a setter on the one instance. Radius is clamped to what the window can serve
    // and to what the buffers were sized for; nothing here reallocates.
    apply(next = {}) {
      Object.assign(cfg, next);
      if (!grass) return;
      if (builtWith && (builtWith.bufferMB !== cfg.grassBufferMB || builtWith.kmax !== cfg.grassKmax)) { rebuild(); return; }
      grass.setFrustumCull?.(cfg.grassFrustumCull);
      grass.setNearKeep?.(cfg.grassNearKeep);
      grass.setShading?.(cfg.grassShading);
      grass.setReceiveShadow?.(cfg.grassReceiveShadow);
      const radius = Math.max(1, Math.min(cfg.grassRadius, maxRadius || cfg.grassRadius));
      grass.setRadius(radius);
      grass.setDispatchBudget(cfg.grassDispatchBudgetM * 1e6);
      grass.setDensity(cfg.grassDensity);
      grass.setCullStart(cfg.grassCullStart || radius * 0.8);
      grass.setBladeHeight(cfg.grassBladeHeight);
      grass.setBladeWidth(cfg.grassBladeWidth);
      grass.setVerticalOffset(cfg.grassVerticalOffset);
      grass.setWind(cfg.grassWind);
      grass.setBladeStyle?.(cfg.grassStyle);
      grass.setGroundTint?.(cfg.grassGroundTint, cfg.grassGroundTintFar, cfg.grassGroundTintReach);
      grass.setColorMode?.(cfg.grassColorMode);
      grass.setLook?.({ faceNormalMix: cfg.grassFaceNormalMix });
      grass.setFadeEnd?.(cfg.grassFadeEnd || null);
      grass.setFadeCurve?.(cfg.grassFadeCurve);
      grass.setFadeHeight?.(cfg.grassFadeHeight);
      grass.setFadeWidth?.(cfg.grassFadeWidth);
      grass.setTintFade?.(cfg.grassTintFadeStart || null, cfg.grassTintFadeEnd || null);
      grass.setNearFade?.(cfg.grassNearFadeStart, cfg.grassNearFadeEnd);
      // Read in the cull, so a change reculls; unavailable rings leave it on the field.
      const source = (cfg.grassHeightSource === 'drawn' && drawnAvailable) ? 1 : 0;
      if (uHeightSource.value !== source) { uHeightSource.value = source; grass.forceRecull(); }
      for (const w of [terrain.fields, terrain.contactField]) {
        if (w?.setResidencyGate && w.residencyGate !== !!cfg.grassResidencyGate) { w.setResidencyGate(cfg.grassResidencyGate); grass.forceRecull(); }
      }
      // The height handover is read in the cull, like the mip.
      if (uNearEnd && uFadeBand) {
        const distance = handoverDistance(), band = Math.max(0.5, cfg.grassNearFade);
        if (uNearEnd.value !== distance || uFadeBand.value !== band) {
          uNearEnd.value = distance; uFadeBand.value = band;
          grass.forceRecull();
        }
      }
      // The mip is read in the cull, so without a recull the slider does nothing until the next cell.
      if (cfg.grassGroundTintMip !== appliedMip) {
        appliedMip = cfg.grassGroundTintMip;
        terrain.setGroundColorMip?.(appliedMip);
        grass.forceRecull();
      }
      if (uCoverGate && uCoverGate.value !== cfg.grassCoverGate) {
        uCoverGate.value = cfg.grassCoverGate;
        grass.forceRecull();
      }
      if (uCoverFloor && uCoverFloor.value !== cfg.grassCoverFloor) {
        uCoverFloor.value = cfg.grassCoverFloor;
        grass.forceRecull();
      }
      grass.setTiers?.(tierSpecFor(cfg));
    },
    setLook(partial) { grass?.setLook?.(partial); },
    setSunDir(v) { grass?.setSunDir?.(v); },
    dispose() {
      setEnabled(false);
      rebuild();
      if (occlusion) { occlusion.dispose(); occlusion = null; }
      placeholderTex.dispose();
      built = false;
    },
  };
}
