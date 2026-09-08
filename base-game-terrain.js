// base-game-terrain.js — Base Game's terrain runtime owner (terrain plan Phase 4).
// Owns the source-injected terrain-system streamer, a render-origin-rebased scene
// root, the heightfield world-query provider, debug views and runtime stats.
// It does not own the player, camera, networking or the state file.

import * as THREE from 'three';
import { MeshNormalNodeMaterial } from 'three/webgpu';
import { Fn, float, vec3, mix as tslMix, clamp as tslClamp, select, uniform as tslUniform } from 'three/tsl';
import { createTerrainSystem } from './terrain-system.js';
import { createTerrainWorkerPool } from './terrain-worker-pool.js';
import { TERRAIN_TINT, TERRAIN_TINT_BANDS, terrainTintAt } from './terrain-tint.js';
import { createSource } from './terrain-source.js';
import { createHeightfieldWorldQueryProvider } from './world-query-heightfield-provider.js';
import { createChunkMeshWorldQueryProvider } from './world-query-chunk-mesh-provider.js';
import { globalToRenderLocal } from './world-coordinates.js';
import { createTerrainClipmap } from './terrain-clipmap.js';
import { createChunkBatcher } from './terrain-chunk-batches.js';
import { createStreamedSplatMaterial, syncStreamedSplatCoverage, updateStreamedSplat, createSplatSampleNode, replaceStreamedSplatImages } from './terrain-splat-streamed.js';
import { createLodCoverage } from './terrain-lod-coverage.js';
import { createSeaDepthMap } from './terrain-sea-depth.js';
import { createFieldScheduler, FIELD_PRIORITY } from './terrain-field-scheduler.js';
import { createFieldWindow, createFieldWindowRegistry } from './terrain-field-window.js';
import { BIOMES, BIOME_INDEX, treeDensityForBiome } from './terrain-biome-point.js';
import { createTileCover, COVER_CHANNELS, decodeCover } from './flora-field.js';
import { splatWeights } from './terrain-splat-streamed.js';
import { createPlanWalkDerive } from './base-game-plan.js';

export const BASE_GAME_TERRAIN_DEFAULTS = Object.freeze({
  chunkSize: 30,
  renderRadius: 3,
  maxChunksPerUpdate: 2,
  maxUnloadsPerUpdate: 2,
  killPlaneBelowSurface: 80,   // metres under the local ground before the player is respawned
  collisionRadius: 2,          // volumetric: chunks around the player that get a BVH (5x5 = 150 m square)
  // Arrived chunks are folded in (colorize + copy into a BatchedMesh) and given colliders. Both
  // were unbudgeted, and measured as 86% of the terrain pass spike (up to 35 ms) because four
  // workers deliver at once. A chunk that misses its turn keeps drawing its own mesh for a frame,
  // which costs one draw call instead of a hitch. 0 = unlimited.
  maxFoldsPerUpdate: 2,
  // One, not two: measured 2026-08-25, the collider BVH is 91-96% of what is left of the fold at
  // ~2.4-3.75 ms per chunk (createMapCollider), and 1/frame at 60 Hz still outruns the ~14/s that
  // actually arrive.
  maxColliderRebuildsPerUpdate: 1,
  // One soft deadline for EVERY integration operation in a frame -- install, batch fold, collider
  // BVH -- across the near system and every cascade level. Operations are indivisible, so the one
  // that is running when the deadline passes finishes and then the frame stops: that overrun is
  // the guarantee, not the millisecond. A 3-4 ms BVH is bigger than this budget on its own, which
  // is why step 7 (the BVH in the worker) is what finally makes the number real.
  integrateBudgetMs: 2,
  // A queue older than this jumps the nearest-first order, so no stage starves under sustained
  // arrivals somewhere nearer.
  integrateAgeMs: 500,
  // The body's safety region: how far around the swept footprint counts as "under the player".
  safetyRadius: 2,
  // Prefetch and hysteresis (plan step 5). The lead is in chunk columns ahead of travel; the
  // margin is how far past the draw radius a chunk is kept before unloading, in chunks of the
  // system that owns it, so a cascade level's margin is its own 480 or 1920 m.
  prefetchChunks: 1,
  prefetchVehicleChunks: 2,
  vehicleSpeed: 12,
  unloadMargin: 1,
  // One in-flight cap shared by the near system and every cascade level, so four streamers
  // cannot put four times the work in flight. Bounds outstanding jobs only; simultaneous
  // completion is what the inbox bound is for.
  maxInFlight: 24,
  // Terrain worker THREADS, shared by the near system and every cascade level. 0 = sized from the
  // machine (cores/2 - 1, at most 2; 4 measured as halving the frame while they run). Four systems each spawning min(4, cores-2) made 16 threads,
  // and a boundary crossing lighting them all starved the main thread (trace 2026-09-07).
  terrainWorkers: 0,
  // Per-chunk frustum culling in the batches. Measured both ways 2026-08-26: turning it off skips
  // BatchedMesh's per-instance cull loop but doubles submitted draws, and the A/B said p50 encode
  // is a wash (postPlain 3.0-6.1 off vs 3.2-6.9 on) while the tail is much worse without it
  // (frame max median 88.8 ms vs 38.8). Culling stays on; ?chunkcull=0 runs the other arm.
  batchFrustumCulled: true,
  farLodLevels: 6,             // heightfield mode: clipmap rings (6 → 6.1 km half-extent at post0 2 m)
  // Streamed biome/moisture field around the player (plants plan F2). 8 m posts over 2 km is the
  // canonical placement resolution: candidate identity and species must not change with visual LOD.
  fieldPost: 8,
  fieldTileIntervals: 16,
  fieldTilesPerSide: 16,
  // Contact window: what things SIT on. 1.25 m posts at lod 0 - the exact field the near chunks
  // are built from - over 160 m, the weather plan's R1b footprint. Small and expensive per post,
  // so it is separate from the 8 m placement field rather than folded into it.
  contactPost: 1.25,
  contactTileIntervals: 16,
  contactTilesPerSide: 8,
  planPost: 30,
  planTileIntervals: 16,
  planTilesPerSide: 16,
  // Volumetric mode: marching-cubes LOD cascade. Each level is a chunk system with a fixed
  // segment count, so spacing grows with the chunk (120/24 = 5 m, 20 m, 80 m); radius 2 → five
  // chunks a side → half-extents 300 m, 1.2 km, 4.8 km. Coarser levels sit a little lower so the
  // finer ones draw over them where they overlap (no morphing for marching cubes).
  volumeLod: [
    // no yBias: the LOD dissolve handles the overlap the old −1.5/−6/−24 m sink used to hide
    { chunkSize: 120, renderRadius: 2, segments: 24, yBias: 0 },
    { chunkSize: 480, renderRadius: 2, segments: 24, yBias: 0 },
    { chunkSize: 1920, renderRadius: 2, segments: 24, yBias: 0 },
  ],
});

// Ground colour and its bands now live in terrain-tint.js, so the worker can tint a chunk
// without importing this file's dependencies. Re-exported here for existing importers.
export { TERRAIN_TINT, TERRAIN_TINT_BANDS, terrainTintAt } from './terrain-tint.js';

// GPU twin of terrainTintAt. Anything planted ON the terrain (grass
// today) tints toward this so it reads as the same ground. The two must stay in step: they are
// adjacent on purpose, and test-base-game-terrain checks them against each other.
export const terrainTintNode = /*@__PURE__*/ Fn(([yAboveSea, normalY]) => {
  const T = TERRAIN_TINT, B = TERRAIN_TINT_BANDS;
  const c = v => vec3(v[0], v[1], v[2]);
  const y = yAboveSea;
  const band = select(y.lessThan(0), tslMix(c(T.water), c(T.sand), tslClamp(float(1).add(y.div(B.shoreSpan)), 0, 1)),
    select(y.lessThan(B.sandTop), tslMix(c(T.sand), c(T.grass), tslClamp(y.div(B.sandTop), 0, 1)),
      select(y.lessThan(B.snowStart), tslMix(c(T.grass), c(T.dry), tslClamp(y.sub(B.dryStart).div(B.drySpan), 0, 1)),
        tslMix(c(T.dry), c(T.snow), tslClamp(y.sub(B.snowStart).div(B.snowSpan), 0, 1)))));
  const rock = tslClamp(float(B.rockNormalY).sub(normalY).div(B.rockSpan), 0, 1);
  return tslMix(band, c(T.rock), rock);
});

export function createBaseGameTerrain({
  scene, worldQuery, worldCoordinates, source,
  params = {}, providerId = 'terrain', volumeProviderId = 'terrain-volume', useWorker = true, volumetric = false, farLod = false,
  now = null,
}) {
  if (!scene?.add) throw new TypeError('Base Game terrain requires a Three.js scene');
  if (!worldQuery?.registerProvider) throw new TypeError('Base Game terrain requires a world-query service');
  if (!worldCoordinates?.getOrigin) throw new TypeError('Base Game terrain requires the world coordinate space');
  if (!source) throw new TypeError('Base Game terrain requires a terrain source or descriptor');

  const cfg = { ...BASE_GAME_TERRAIN_DEFAULTS, ...params };
  // One clock for the streamer's queues and the scheduler's deadline, so queue age and frame
  // timers are the same numbers. Injected by the tests; the page passes its own.
  const clock = typeof now === 'function' ? now : (() => performance.now());
  // Shared by every streamer below: one budget, not one each.
  const inFlightBudget = { max: Math.max(1, cfg.maxInFlight | 0), count: 0 };
  const workerPool = useWorker ? createTerrainWorkerPool({ count: cfg.terrainWorkers | 0 }) : null;
  const streamParams = { prefetchChunks: cfg.prefetchChunks, prefetchVehicleChunks: cfg.prefetchVehicleChunks, vehicleSpeed: cfg.vehicleSpeed, unloadMargin: cfg.unloadMargin };
  const system = createTerrainSystem({
    params: { chunkSize: cfg.chunkSize, renderRadius: cfg.renderRadius, maxChunksPerUpdate: cfg.maxChunksPerUpdate, maxUnloadsPerUpdate: cfg.maxUnloadsPerUpdate, useWorker, integrateExternally: true, ...streamParams },
    source, now: clock, inFlightBudget, workerPool,
  });
  // Tint bands sit on the sea level (descriptor.seaLevel, 0 without one); chunks recolour on change.
  let seaLevel = system.source?.descriptor?.seaLevel ?? 0;
  // Bumped when the tint changes. A worker reply stamped with an older revision is re-tinted on commit.
  let tintRevision = 1;
  function syncTint() {
    const request = { seaLevel, revision: tintRevision };
    system.setTint(request);
    for (const c of cascade) c.system.setTint(request);
  }
  const provider = createHeightfieldWorldQueryProvider(system.source, { id: providerId });
  const unregisterProvider = worldQuery.registerProvider(provider);
  // Volumetric mode: the marching-cubes chunk meshes ARE the ground (caves, overhangs), so
  // collision comes from their BVHs and the heightfield provider stands down.
  const volumeProvider = createChunkMeshWorldQueryProvider({ id: volumeProviderId, priority: 50 });
  const unregisterVolumeProvider = worldQuery.registerProvider(volumeProvider);
  const collidedChunks = new Map();   // key -> chunk object whose geometry the volume provider holds
  let volumetricMode = false;
  // Mode switches hand collision over: the heightfield stays live until the volume provider holds
  // the chunk under the player (worker tiles land later), then update() completes the handoff and
  // reports it so the caller can re-seat the player on the new surface.
  let handoffPending = false;
  let handoffDone = false;
  function applyProviders() {
    provider.enabled = active && (!volumetricMode || handoffPending);
    volumeProvider.enabled = active && volumetricMode;
  }
  function chunkKeyAt(x, z) {
    const size = system.params.chunkSize;
    return `${Math.floor(x / size)},${Math.floor(z / size)}`;
  }
  // Colliders exist only within `collisionRadius` chunks of the focus: a BVH per resident chunk at a
  // wide draw radius was ~1.4 M triangles of BVH built on the main thread (the frame spikes),
  // and nothing queries the ground that far from the player.
  let colliderFocus = [0, 0];
  // The render mesh carries LOD skirts; collision sees only the triangles before skirtIndexStart.
  function collisionGeometry(chunk) {
    const geo = chunk.mesh.geometry;
    const cut = chunk.meta.volume?.skirtIndexStart;
    if (cut == null || !geo.index || cut >= geo.index.count) return geo;
    const sliced = new THREE.BufferGeometry();
    sliced.setAttribute('position', geo.getAttribute('position'));
    sliced.setIndex(new THREE.BufferAttribute(geo.index.array.subarray(0, cut), 1));
    return sliced;
  }
  // Split into three so the scheduler can charge ONE BVH to its deadline. The removals are cheap
  // and always run; picking and building are separate so a pick never commits to a build.
  function colliderOrder() {
    const size = system.params.chunkSize, r = cfg.collisionRadius;
    const cx = Math.floor(colliderFocus[0] / size), cz = Math.floor(colliderFocus[1] / size);
    const order = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) order.push({ key: `${cx + dx},${cz + dz}`, d2: dx * dx + dz * dz });
    order.sort((a, b) => a.d2 - b.d2);
    return order;
  }
  function colliderWanted(key) {
    const chunk = system.chunks.get(key);
    return !!chunk && !!chunk.meta.volumetric && !!chunk.mesh && collidedChunks.get(key) !== chunk;
  }
  // Nearest-first from the collider focus (the BODY, not the stream centre): a budget must never
  // defer the chunk the player is standing on.
  function nextColliderKey() {
    if (!volumetricMode) return null;
    for (const { key } of colliderOrder()) if (colliderWanted(key)) return key;
    return null;
  }
  function buildCollider(key) {
    const chunk = system.chunks.get(key);
    if (!chunk || !chunk.mesh) return false;
    const t0 = clock();
    volumeProvider.setChunk(key, collisionGeometry(chunk), { sourceVersion: chunk.meta.sourceVersion });
    collidedChunks.set(key, chunk);
    lastColliderMs += clock() - t0;
    return true;
  }
  function syncColliderRemovals() {
    if (!volumetricMode) { if (collidedChunks.size) { volumeProvider.clear(); collidedChunks.clear(); } return; }
    const wanted = new Set(colliderOrder().map(o => o.key));
    for (const key of [...collidedChunks.keys()]) {
      if (!wanted.has(key) || !system.chunks.has(key)) { volumeProvider.removeChunk(key); collidedChunks.delete(key); }
    }
  }
  // Returns true when colliders were left to rebuild. Kept for the immediate paths (a mode
  // switch, a source swap) that must not wait for a frame budget.
  function syncVolumeColliders(maxRebuilds = 0) {
    syncColliderRemovals();
    if (!volumetricMode) return false;
    let built = 0, key;
    while ((key = nextColliderKey()) != null) {
      if (maxRebuilds > 0 && built >= maxRebuilds) return true;
      buildCollider(key);
      built++;
    }
    return false;
  }
  if (volumetric) { system.setVolumetric(true); volumetricMode = true; }

  // Far LOD (Phase 9), visual only, never collided. Heightfield mode: clipmap rings fed by the
  // source at coarser lods. Volumetric mode: a marching-cubes cascade (coarser chunk systems on
  // the same source with band-limited density), so cave mouths and overhangs survive at distance
  // as far as their size allows. Both are created on first use and kept.
  let clipmap = null;
  let farLodMode = false;
  function ensureClipmap() {
    if (clipmap) return clipmap;
    clipmap = createTerrainClipmap({ source: system.source, descriptor: system.source.descriptor, useWorker, levels: cfg.farLodLevels });
    system.group.add(clipmap.root);   // same −renderOrigin root as the chunks
    return clipmap;
  }
  // Ground textures (terrain-splat-streamed.js) replace the vertex tint when set; the tint
  // stays on the geometry so turning textures off costs nothing.
  let splatMaterial = null;     // the caller's instance: source of the tuning cfg
  let splatTextures = null;
  let splatEnabled = true;
  // LOD dissolve: one coverage map per streamer (exact chunks + each cascade level) and one splat
  // instance per streamer bound to its own map and the next finer one (terrain-lod-coverage.js).
  const coverExact = createLodCoverage({ chunkSize: cfg.chunkSize });
  // the last level's eroded texture has no coarser consumer
  const coverLevels = cfg.volumeLod.map((spec, i) => createLodCoverage({ chunkSize: spec.chunkSize, eroded: i < cfg.volumeLod.length - 1 }));
  const splatInstances = new Map();   // 0 = exact, 1..n = cascade levels
  let splatWater = null;              // the water module's groundShade (wet band + caustics)
  let splatRain = null;               // the rain module's groundShade (wetness, puddles, ripples)
  // Per-biome ground (a project's material.biomes): the splat reads the biome id from the
  // placement field window, indexed globally, so the instances carry the render origin.
  const uSplatOriginXZ = tslUniform(new THREE.Vector2());
  let splatBiomes = null;             // { textures, table, rules } once a project asks for them
  let splatFieldRelease = null;       // the ground's own hold on the field window while biomes are on
  function biomeBinding() {
    if (!splatBiomes) return null;
    const w = fieldWindow();
    if (!w || !w.fields.includes('biomeIds')) return null;
    const sampler = w.gpuSampler('biomeIds');
    return { window: w, idNode: Fn(([xz]) => sampler(xz.add(uSplatOriginXZ), float(-1000))) };
  }
  function splatFor(index) {
    if (!splatMaterial || !splatTextures) return null;
    const binding = biomeBinding();
    let m = splatInstances.get(index);
    if (m && m.userData.splatBiomeWindow !== (binding?.window ?? null)) { m.dispose(); splatInstances.delete(index); m = null; }
    if (!m) {
      const self = index === 0 ? coverExact : coverLevels[index - 1];
      const finer = index === 0 ? null : (index === 1 ? coverExact : coverLevels[index - 2]);
      m = createStreamedSplatMaterial(splatTextures, splatMaterial.userData.streamedSplat.cfg, { lod: { self, finer }, water: splatWater, rain: splatRain, biome: binding ? { idNode: binding.idNode } : null });
      m.userData.splatBiomeWindow = binding?.window ?? null;
      if (splatBiomes) updateStreamedSplat(m, { biomeTable: splatBiomes.table, biomeRules: splatBiomes.rules, biomeAverages: splatBiomes.textures?.averages ?? [] });
      splatInstances.set(index, m);
    }
    m.wireframe = wireframe;
    return m;
  }
  function setSplatWater(shade) {
    splatWater = shade ?? null;
    rebuildSplatInstances();
  }
  // Rain is bound ONCE at startup, not when it starts raining: the graph gates on the wetness
  // uniform, and rebuilding every splat instance mid-session is a visible hitch.
  function setSplatRain(shade) {
    splatRain = shade ?? null;
    rebuildSplatInstances();
  }
  function rebuildSplatInstances() {
    for (const m of splatInstances.values()) m.dispose();
    splatInstances.clear();
    applyMaterials();
  }
  function groundMaterial() { return splatEnabled && splatMaterial ? (splatFor(0) ?? splatMaterial) : system.material; }
  function cascadeMaterial(level) {
    if (normals || !(splatEnabled && splatMaterial)) return normals ? normalMaterial : system.material;
    return splatFor(level) ?? splatMaterial;
  }
  function presentKeys(sys, hideRule) {
    const out = new Set();
    for (const [key, chunk] of sys.chunks) if (chunk.mesh && !hideRule(chunk)) out.add(key);
    return out;
  }
  const hideStaleHeightfield = chunk => chunk.stale && volumetricMode && !chunk.meta.volumetric && farLodMode;
  const alwaysShow = () => false;   // hoisted: the cascade hide-rule is constant
  // Per frame: coverage ramps follow residency; origins follow the player; uniforms follow both.
  // The present-set rebuild iterates every resident chunk, so it runs only when residency changed,
  // a window recentred, or a ramp is still animating — not on every quiet frame.
  function updateCoverage(globalPosition, dt, residencyChanged) {
    let touched = false;
    const moved = coverExact.recentre(globalPosition[0], globalPosition[2]);
    if (residencyChanged || moved || coverExact.animating) { coverExact.update(presentKeys(system, hideStaleHeightfield), dt); touched = true; }
    // A plain loop, not forEach: this runs every frame and the callback closes over three locals,
    // so forEach allocates a closure per frame even when the cascade is empty.
    for (let i = 0; i < cascade.length; i++) {
      const m2 = coverLevels[i].recentre(globalPosition[0], globalPosition[2]);
      if (residencyChanged || m2 || coverLevels[i].animating) { coverLevels[i].update(presentKeys(cascade[i].system, alwaysShow), dt); touched = true; }
    }
    if (touched) for (const m of splatInstances.values()) syncStreamedSplatCoverage(m);
  }
  // Chunks draw through BatchedMesh pools (terrain-chunk-batches.js): one scene object per ~256
  // chunks instead of one each, but still one drawIndexed per visible chunk on WebGPU. A chunk's
  // own mesh is hidden once it is in a batch; it stays the fallback when a batch cannot take it.
  const batcher = createChunkBatcher({ material: system.material, name: 'base-game-terrain-batches', perObjectFrustumCulled: cfg.batchFrustumCulled });
  const batchedChunks = new Map();   // key -> chunk object currently copied into the batcher
  const cascadeBatchers = new Map(); // cascade system -> { batcher, batched }
  const cascade = [];   // [{ system, group, level, spec }]
  syncTint();
  function ensureCascade() {
    if (cascade.length) return cascade;
    cfg.volumeLod.forEach((spec, i) => {
      const lvl = createTerrainSystem({
        params: { chunkSize: spec.chunkSize, renderRadius: spec.renderRadius, segmentsPerChunk: spec.segments, lod: i + 1, volumetric: true, maxChunksPerUpdate: 1, maxUnloadsPerUpdate: 2, useWorker, integrateExternally: true, ...streamParams },
        source: system.source, now: clock, inFlightBudget, workerPool,
      });
      lvl.setTint({ seaLevel, revision: tintRevision });
      lvl.material = groundMaterial();   // chunks pick it up at creation: same look, same wireframe
      const group = new THREE.Group();
      group.name = `base-game-terrain-volume-lod-${i + 1}`;
      group.position.y = spec.yBias;
      group.add(lvl.group);
      cascade.push({ system: lvl, group, level: i + 1, spec });
    });
    return cascade;
  }
  function cascadeExtent() {
    const last = cfg.volumeLod[cfg.volumeLod.length - 1];
    return last ? (last.renderRadius + 0.5) * last.chunkSize : 0;
  }
  // The exact chunks' global XZ extent: the resident target square around the player's chunk.
  function chunkWindowRect() {
    const size = system.params.chunkSize, r = Math.max(0, Math.floor(system.params.renderRadius));
    const cx = system.centerChunkX, cz = system.centerChunkZ;
    if (cx == null || cz == null) return null;
    return [(cx - r) * size, (cz - r) * size, (cx + r + 1) * size, (cz + r + 1) * size];
  }
  // The far representation follows the ground mode; both are kept once built.
  function ensureFarLod() {
    if (volumetricMode) { if (!cascade.length) { ensureCascade(); for (const c of cascade) root.add(c.group); } }
    else ensureClipmap();
  }

  // Chunk geometry stays global; the root carries -renderOrigin (Traversal Lab pattern).
  const root = new THREE.Group();
  root.name = 'base-game-terrain';
  root.position.fromArray(globalToRenderLocal([0, 0, 0], worldCoordinates.getOrigin()));
  root.add(system.group);
  root.add(batcher.group);
  scene.add(root);
  if (farLod) { farLodMode = true; ensureFarLod(); }
  const syncSplatOrigin = () => { const o = worldCoordinates.getOrigin(); uSplatOriginXZ.value.set(o[0], o[2]); };
  syncSplatOrigin();
  const stopRebase = worldCoordinates.onRebase(event => { root.position.add(new THREE.Vector3().fromArray(event.delta)); syncSplatOrigin(); });

  // Base Game readability tint: height/slope vertex colours (sea-level sand, grass, rock on
  // steep faces, snow up high). Biome/material masks from v5 are not streamed yet.
  system.material.vertexColors = true;
  system.material.color.set(0xffffff);
  const mixInto = (out, o, a, b, t) => { out[o] = a[0] + (b[0] - a[0]) * t; out[o + 1] = a[1] + (b[1] - a[1]) * t; out[o + 2] = a[2] + (b[2] - a[2]) * t; };
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  // Ground height around the player for water (terrain-sea-depth.js): streams only while active.
  const seaDepth = createSeaDepthMap({ source: system.source, useWorker });
  // Field windows (biome, moisture, visible surface) share one small worker pool, deliberately
  // separate from and smaller than terrain-system's, so a placement tile can never be what a
  // visible or collision chunk is queued behind.
  const fieldScheduler = createFieldScheduler({ useWorker });
  const fieldRegistry = createFieldWindowRegistry({ scheduler: fieldScheduler });
  const planScheduler = createFieldScheduler({ useWorker, workerCount: 1 });
  const planRegistry = createFieldWindowRegistry({ scheduler: planScheduler });
  const fieldHandles = new Set();   // one registry handle per consumer; the registry owns the window
  const contactHandles = new Set();
  const planHandles = new Set();
  // surfaceHeights costs a surfaceYAt scan per post (~26 us), so it is requested only where the
  // ground can actually differ from the heightfield: volumetric mode.
  // Cover is derived per texel as each tile lands, from the biome, the moisture and the very
  // splat weights the ground is textured with (flora-field.js). One number per layer per texel.
  const tileCover = createTileCover({ seaLevel: system.source?.descriptor?.seaLevel ?? 0, biomeNames: BIOMES });
  const planWalk = createPlanWalkDerive({ seaLevel: system.source?.descriptor?.seaLevel ?? 0 });
  let trailSettledAt = null;
  // Cover clearance is the product of every planner that clears ground: trails and structures.
  let trailClearanceAt = null, structureClearanceAt = null;
  function composedClearance() {
    if (!trailClearanceAt) return structureClearanceAt;
    if (!structureClearanceAt) return trailClearanceAt;
    return (x, z) => trailClearanceAt(x, z) * structureClearanceAt(x, z);
  }
  // Height rides along: grass past the contact window's reach plants on this instead, and 8 m
  // posts over 2 km cost one float per texel against a window that is already streaming.
  function placementFields() {
    return volumetricMode ? ['surfaceHeights', 'biomeIds', 'moisture'] : ['heights', 'biomeIds', 'moisture'];
  }
  function fieldKey() {
    return `placement:${cfg.fieldPost}:${placementFields().join(',')}`;
  }
  function openFieldWindow() {
    const fields = placementFields();
    return fieldRegistry.acquire(fieldKey(), ({ scheduler }) => createFieldWindow({
      source: system.source, descriptor: system.source.descriptor, scheduler, label: 'placement',
      fields: [...fields, ...COVER_CHANNELS], derived: COVER_CHANNELS, derive: tileCover.derive,
      post: cfg.fieldPost, tileIntervals: cfg.fieldTileIntervals, tilesPerSide: cfg.fieldTilesPerSide,
      priority: FIELD_PRIORITY.placement,
    }));
  }
  function contactFields() { return volumetricMode ? ['surfaceHeights'] : ['heights']; }
  function openContactWindow() {
    const fields = contactFields();
    return fieldRegistry.acquire(`contact:${cfg.contactPost}:${fields.join(',')}`, ({ scheduler }) => createFieldWindow({
      source: system.source, descriptor: system.source.descriptor, scheduler, label: 'contact',
      fields, lod: 0, post: cfg.contactPost, tileIntervals: cfg.contactTileIntervals, tilesPerSide: cfg.contactTilesPerSide,
      priority: FIELD_PRIORITY.contact,
    }));
  }
  function openPlanWindow() {
    return planRegistry.acquire(`plan:${cfg.planPost}:${cfg.planTileIntervals}:${cfg.planTilesPerSide}`, ({ scheduler }) => createFieldWindow({
      source: system.source, descriptor: system.source.descriptor, scheduler, label: 'plan',
      fields: ['heights', 'biomeIds', 'planWalk'], derived: ['planWalk'], derive: planWalk.derive,
      post: cfg.planPost, tileIntervals: cfg.planTileIntervals, tilesPerSide: cfg.planTilesPerSide,
      priority: FIELD_PRIORITY.plan, gpu: false,
    }));
  }
  function acquirePlan() {
    const handle = openPlanWindow();
    planHandles.add(handle);
    let released = false;
    return () => { if (released) return; released = true; planHandles.delete(handle); handle.release(); };
  }
  function planWindow() { for (const handle of planHandles) return handle.window; return null; }
  // Grass and rain hold this; it is the surface they touch, at the spacing the ground is drawn at.
  function acquireContactField() {
    const handle = openContactWindow();
    contactHandles.add(handle);
    let released = false;
    return () => { if (released) return; released = true; contactHandles.delete(handle); handle.release(); };
  }
  function contactWindow() { for (const handle of contactHandles) return handle.window; return null; }
  function contactHeightAt(x, z) {
    const w = contactWindow();
    if (!w) return null;
    return w.fields.includes('surfaceHeights') ? w.sampleAt('surfaceHeights', x, z) : w.sampleAt('heights', x, z);
  }
  // Consumers (flora, later the ground material) hold a reference each; the window streams only
  // while someone does, and a mode switch rebuilds it because the field set differs.
  function acquireFields() {
    const handle = openFieldWindow();
    fieldHandles.add(handle);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      fieldHandles.delete(handle);
      handle.release();
    };
  }
  // Re-acquire every consumer against the current key, then drop the old handles: the window only
  // changes if the key did, so an unchanged mode switch is a no-op rather than a restream.
  function reopenFieldWindow() {
    for (const [set, open] of [[fieldHandles, openFieldWindow], [contactHandles, openContactWindow], [planHandles, openPlanWindow]]) {
      if (!set.size) continue;
      const previous = [...set];
      set.clear();
      for (const _ of previous) set.add(open());
      for (const handle of previous) handle.release();
    }
    // the per-biome splat instances sample the old window's textures; rebuild them against the new one
    if (splatBiomes && splatInstances.size) { for (const m of splatInstances.values()) m.dispose(); splatInstances.clear(); applyMaterials(); }
  }
  function fieldWindow() {
    for (const handle of fieldHandles) return handle.window;
    return null;
  }
  // Every read is null when the field has not streamed here yet. A placement loop must defer on
  // null rather than substitute a default, or the world records a candidate missing data invented.
  function biomeIdAt(x, z) {
    const id = fieldWindow()?.sampleAt('biomeIds', x, z);
    return id == null ? null : id | 0;
  }
  function biomeAt(x, z) {
    const id = biomeIdAt(x, z);
    return id == null ? null : (BIOMES[id] ?? null);
  }
  function moistureAt(x, z) {
    const m = fieldWindow()?.sampleAt('moisture', x, z);
    return m == null ? null : m;
  }
  // PLACEMENT height: the field's own post spacing, band-limited to it. It decides where things
  // go, never where they sit — contact height comes from the fine lod-0 window or a ground probe.
  function fieldSurfaceAt(x, z) {
    const w = fieldWindow();
    if (!w) return null;
    return w.fields.includes('surfaceHeights') ? w.sampleAt('surfaceHeights', x, z) : w.sampleAt('heights', x, z);
  }
  // 0..1 per layer, or null where the field has not streamed. This is what placement reads.
  function coverAt(x, z) {
    if (trailSettledAt && !trailSettledAt(x, z)) return null;
    const w = fieldWindow();
    if (!w) return null;
    const grass = w.sampleAt('coverGrass', x, z);
    if (grass == null) return null;
    return { grass: decodeCover(grass), plant: decodeCover(w.sampleAt('coverPlant', x, z)), tree: decodeCover(w.sampleAt('coverTree', x, z)) };
  }
  function treeDensityAt(x, z) {
    const biome = biomeAt(x, z);
    return biome == null ? null : treeDensityForBiome(biome);
  }
  // What the ground is made of where flora wants to grow: the biome's ambition and the splat
  // weights the terrain is actually textured with, from one sample.
  function surfaceFieldAt(x, z) {
    const biome = biomeAt(x, z);
    if (biome == null) return null;
    const height = fieldSurfaceAt(x, z);
    if (height == null) return null;
    const post = cfg.fieldPost;
    const hx = fieldSurfaceAt(x + post, z), hx0 = fieldSurfaceAt(x - post, z);
    const hz = fieldSurfaceAt(x, z + post), hz0 = fieldSurfaceAt(x, z - post);
    let normalY = 1;
    if (hx != null && hx0 != null && hz != null && hz0 != null) {
      const gx = (hx - hx0) / (2 * post), gz = (hz - hz0) / (2 * post);
      normalY = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    }
    const weights = splatWeights(height, normalY, splatMaterial?.userData?.streamedSplat?.cfg);
    return { biome, height, normalY, moisture: moistureAt(x, z) ?? 0, weights, treeDensity: treeDensityForBiome(biome) };
  }
  let seaDepthActive = false;
  let residencyRevision = 0;
  // What the ground actually looks like, for anything planted ON it. The vertex tint is only what
  // shows when ground textures are off, so this follows that toggle rather than assuming either.
  const uGroundSea = tslUniform(seaLevel);
  const uGroundSplatMix = tslUniform(0);
  // Built on first use, by which point the ground textures have normally arrived; a consumer that
  // needs the real maps waits on `groundColorReady` rather than racing the load.
  let splatGround = null;
  let groundNode = null;
  function syncGroundColor() {
    uGroundSea.value = seaLevel;
    const cfg = splatMaterial?.userData?.streamedSplat?.cfg ?? null;
    if (cfg) splatGround?.sync(cfg);
    uGroundSplatMix.value = (splatEnabled && splatTextures) ? 1 : 0;
  }
  const TINT = TERRAIN_TINT;
  let colorizeWork = 0;        // per-vertex tints actually performed, counted wherever they happen
  let colorizeBytes = 0;       // logical bytes of colour attribute written by those tints (cumulative)
  function colorizeGeometry(geo, force = false) {
    // A worker-tinted chunk is already done unless its revision is stale (the sea level moved
    // while it was in flight), in which case it is re-tinted here.
    if (geo.getAttribute('color') && !force && geo.userData.tintRevision === tintRevision) return;
    const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal');
    const colors = new Float32Array(pos.count * 3);
    const c = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      terrainTintAt(pos.getY(i) - seaLevel, nrm ? nrm.getY(i) : 1, colors, i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.userData.tintRevision = tintRevision;
    colorizeWork++;
    colorizeBytes += colors.byteLength;   // a fresh attribute on the CHUNK's geometry, never on a batch buffer
  }

  const normalMaterial = new MeshNormalNodeMaterial();
  const boundsMaterial = new THREE.LineBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.7, depthTest: false });
  const boundsGroup = new THREE.Group();
  boundsGroup.name = 'base-game-terrain-tile-bounds';
  boundsGroup.visible = false;
  system.group.add(boundsGroup);
  const boundsByKey = new Map();
  const contactMarker = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff3bd5, depthTest: false }));
  contactMarker.name = 'base-game-terrain-contact';
  contactMarker.renderOrder = 60;
  contactMarker.visible = false;
  system.group.add(contactMarker);

  let active = false;
  let visible = true;
  let wireframe = false;
  let normals = false;
  let tileBounds = false;
  let collisionDebug = false;
  let lastUpdateMs = 0;
  let lastClipmapMs = 0;
  let lastFoldMs = 0;          // applyMaterials + syncVolumeColliders, together
  let lastColorizeMs = 0;      // the UNBUDGETED per-vertex colour pass over newly arrived chunks
  let lastBatchMs = 0;         // budgeted: copying chunk geometry into the BatchedMesh pools
  let lastColliderMs = 0;      // budgeted: collisionGeometry + volumeProvider.setChunk (BVH build)
  let lastFieldMs = 0;         // field windows + coverage
  let lastInstallMs = 0;       // out-of-frame worker installs, drained from the systems
  let lastInstallCount = 0;
  let foldPending = false;     // chunks a budgeted frame left unfolded / uncollided
  let colliderPending = false;
  let installedTotal = 0;
  let lastResident = 0;
  const perSecond = { installs: 0, window: 0, rate: 0 };
  const frameCostOut = { installMs: 0, foldMs: 0, fieldMs: 0, installCount: 0, colorizeMs: 0, batchMs: 0, colliderMs: 0,
    integrateMs: 0, integrateItems: 0, maxItemMs: 0, queued: 0, queuedBytes: 0, colorizePassCount: 0,
    workerTintMs: 0, overruns: 0, queuedOldestMs: 0, inFlight: 0, busyWorkers: 0,
    // Logical upload accounting for this frame: bytes/ranges this code marked dirty, NOT what the
    // renderer submitted. Flat scalars, because the page shallow-copies this object.
    batchFirstUploads: 0, batchFirstUploadBytes: 0, batchVisibilityFlips: 0, batchFallbacks: 0,
    batchCompactions: 0, batchCompactionShifts: 0, batchCompactionBytes: 0, colorizeBytes: 0 };
  // Batch upload accounting for the frame, summed over the near batcher and every cascade one.
  // LOGICAL bytes: what this code marked dirty, not what the renderer submitted.
  const batchUploadFields = ['firstUploads', 'firstUploadBytes', 'visibilityFlips', 'fallbacks', 'compactions', 'compactionShifts', 'compactionBytes'];
  const lastBatchUpload = Object.fromEntries(batchUploadFields.map(k => [k, 0]));
  let lastColorizeBytes = 0;
  function collectBatchUpload() {
    for (const k of batchUploadFields) lastBatchUpload[k] = 0;
    const take = b => { const u = b.takeFrameUpload(); for (const k of batchUploadFields) lastBatchUpload[k] += u[k]; };
    take(batcher);
    for (const cb of cascadeBatchers.values()) take(cb.batcher);
  }
  let lastIntegrateMs = 0;     // everything the scheduler ran this frame, on one deadline
  let lastOverruns = 0;        // frames' worth of the one-item overrun rule firing
  let lastMaxItemMs = 0;       // the single most expensive operation, usually a collider BVH
  let lastColorizePassCount = 0;   // chunks the unbudgeted materials pass had to tint this frame
  let lastWorkerTintMs = 0;        // WORKER-thread tint time; never added to main-thread frame time
  let lastItemCount = 0;
  let stageCursor = 0;         // round-robin start, so no stage starves behind a nearer one
  let lastBody = null;         // previous frame's body position, for the swept footprint
  const bodyVelocity = [0, 0];  // m/s, smoothed; what the streamers prefetch along

  // The batch bookkeeping that costs nothing: visibility, and removals for chunks that left.
  // Folding a chunk INTO a batch is a separate operation the scheduler charges to its deadline.
  // A chunk not yet in its batch draws its own mesh, which is correct, just one draw call more;
  // and a replaced chunk still has its predecessor's geometry in the batch under this key, so
  // that entry is hidden or it would draw over the new mesh.
  function syncBatchVisibility(sys, b, batched, hideRule) {
    let pending = 0;
    b.beginFrame();
    for (const [key, chunk] of sys.chunks) {
      if (!chunk.mesh) continue;
      const hidden = hideRule(chunk);
      const inBatch = batched.get(key) === chunk;
      if (inBatch) b.setVisible(key, !hidden);
      else { pending++; if (b.has(key)) b.setVisible(key, false); }
      chunk.mesh.visible = !inBatch && !hidden;
    }
    for (const key of [...batched.keys()]) if (!sys.chunks.has(key)) { b.remove(key); batched.delete(key); }
    return pending;
  }
  // Fold exactly one chunk into its batch. One operation, one deadline charge.
  function foldOne(sys, b, batched, hideRule, key) {
    const chunk = sys.chunks.get(key);
    if (!chunk || !chunk.mesh) return false;
    const t0 = clock();
    colorizeGeometry(chunk.mesh.geometry);
    if (b.add(key, chunk.mesh.geometry)) batched.set(key, chunk); else batched.delete(key);
    const inBatch = batched.get(key) === chunk;
    const hidden = hideRule(chunk);
    chunk.mesh.visible = !inBatch && !hidden;
    if (inBatch) b.setVisible(key, !hidden);
    lastBatchMs += clock() - t0;
    return true;
  }
  // The next chunk of this system waiting to be folded, nearest to `focus` first.
  function nextFoldKey(sys, batched, focus) {
    let best = null, bestD = Infinity;
    for (const [key, chunk] of sys.chunks) {
      if (!chunk.mesh || batched.get(key) === chunk) continue;
      const d = (chunk.xMin + chunk.size * 0.5 - focus[0]) ** 2 + (chunk.zMin + chunk.size * 0.5 - focus[1]) ** 2;
      if (d < bestD) { bestD = d; best = key; }
    }
    return best;
  }
  const nearHideRule = chunk => chunk.stale && volumetricMode && !chunk.meta.volumetric && farLodMode;
  const cascadeHideRule = () => false;
  // Every batcher, near and cascade, as one list the scheduler and the material pass both walk.
  function batchTargets() {
    const out = [{ sys: system, b: batcher, batched: batchedChunks, hideRule: nearHideRule }];
    for (const c of cascade) {
      let cb = cascadeBatchers.get(c.system);
      if (!cb) { cb = { batcher: createChunkBatcher({ material: cascadeMaterial(c.level), name: `base-game-terrain-lod-${c.level}-batches`, slots: 64, vertices: 200_000, indices: 600_000, perObjectFrustumCulled: cfg.batchFrustumCulled }), batched: new Map() }; cascadeBatchers.set(c.system, cb); c.group.add(cb.batcher.group); }
      out.push({ sys: c.system, b: cb.batcher, batched: cb.batched, hideRule: cascadeHideRule, level: c.level });
    }
    return out;
  }
  // Materials, wireframe and batch visibility. No folding and, since the worker tints, no
  // per-vertex work either: colorizeGeometry returns early on a chunk whose revision is current.
  function applyMaterialsPass() {
    const tColor = clock();
    const workBefore = colorizeWork;
    const mat = normals ? normalMaterial : groundMaterial();
    system.material.wireframe = wireframe;
    normalMaterial.wireframe = wireframe;
    if (splatMaterial) splatMaterial.wireframe = wireframe;
    if (clipmap) clipmap.setWireframe(wireframe);
    for (const child of system.group.children) {
      if (!child.isMesh || !child.userData.terrainChunk) continue;
      colorizeGeometry(child.geometry);
      child.material = mat;
    }
    for (const c of cascade) {
      const lvlMat = cascadeMaterial(c.level);
      for (const child of c.system.group.children) {
        if (!child.isMesh || !child.userData.terrainChunk) continue;
        colorizeGeometry(child.geometry);
        child.material = lvlMat;
      }
    }
    lastColorizeMs += clock() - tColor;
    // How many chunks this UNBUDGETED pass had to tint. The scheduler tints on commit, so in a
    // healthy frame this is 0 and the per-vertex cost sits inside the deadline instead.
    lastColorizePassCount += colorizeWork - workBefore;
    let pending = 0;
    const targets = batchTargets();
    batcher.setMaterial(mat);
    for (const t of targets) {
      if (t.level != null) t.b.setMaterial(cascadeMaterial(t.level));
      pending += syncBatchVisibility(t.sys, t.b, t.batched, t.hideRule);
    }
    return pending;
  }
  // Immediate, unbudgeted fold of everything. This is the settings path (wireframe, normals, a
  // new splat material, recolorAll): a person changed something and expects to see it, and it is
  // not a per-frame cost. The per-frame path goes through the scheduler instead.
  function applyMaterials(maxFolds = 0) {
    applyMaterialsPass();
    let left = maxFolds > 0 ? maxFolds : Infinity;
    for (const t of batchTargets()) {
      let key;
      while (left > 0 && (key = nextFoldKey(t.sys, t.batched, [system.centerX, system.centerZ])) != null) {
        foldOne(t.sys, t.b, t.batched, t.hideRule, key);
        left--;
      }
    }
    return applyMaterialsPass() > 0;
  }

  // The chunks the body's footprint touched THIS frame: the swept segment from where it was to
  // where it is, sampled with the body's own radius, so a diagonal crossing is caught the same as
  // a cardinal one. Four cardinal neighbours would miss a corner cut.
  function safetyKeys(bodyPosition) {
    const size = system.params.chunkSize, r = cfg.safetyRadius;
    const from = lastBody ?? bodyPosition;
    const dx = bodyPosition[0] - from[0], dz = bodyPosition[2] - from[2];
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (size * 0.5)));
    const keys = new Set();
    for (let i = 0; i <= steps; i++) {
      const x = from[0] + dx * (i / steps), z = from[2] + dz * (i / steps);
      for (const ox of [-r, r]) for (const oz of [-r, r]) keys.add(`${Math.floor((x + ox) / size)},${Math.floor((z + oz) / size)}`);
    }
    // Nearest the body FIRST: the sweep is built from where the body was, and the chunk it is
    // standing in now is the one collision cannot wait for.
    return [...keys].sort((a, b) => keyDistance2(a, size, bodyPosition) - keyDistance2(b, size, bodyPosition));
  }
  function keyDistance2(key, size, at) {
    const [ix, iz] = key.split(',').map(Number);
    return ((ix + 0.5) * size - at[0]) ** 2 + ((iz + 0.5) * size - at[2]) ** 2;
  }

  // Commit one queued result and make sure it is tinted before anything draws it. A tile that
  // arrived without normals carries no worker colours (terrain-tint's finishTileTint), and the
  // chunk draws its own mesh from the moment it installs until its fold -- with vertexColors on
  // and no colour attribute if the tint waited for foldOne. Charged to the same operation.
  function commitAndTint(sys, key) {
    const committed = sys.commitNextResult(key);
    if (committed === null) return null;
    const chunk = sys.chunks.get(committed);
    if (chunk?.mesh && !chunk.mesh.geometry.getAttribute('color')) colorizeGeometry(chunk.mesh.geometry);
    return committed;
  }

  // One frame's integration. Every operation -- an install, one batch fold, one collider BVH --
  // is charged to the SAME deadline, safety region included; nothing is exempt. The next
  // operation is selected only while budget remains, and an operation already started may finish
  // past it, after which the frame stops globally. That overrun is the guarantee.
  function integrate(bodyPosition) {
    const t0 = clock();
    const deadline = t0 + cfg.integrateBudgetMs;
    const safety = safetyKeys(bodyPosition);
    const targets = batchTargets();
    let folds = cfg.maxFoldsPerUpdate > 0 ? cfg.maxFoldsPerUpdate : Infinity;
    let colliders = cfg.maxColliderRebuildsPerUpdate > 0 ? cfg.maxColliderRebuildsPerUpdate : Infinity;
    let items = 0, overran = false;
    lastMaxItemMs = 0;

    // (1) The body's safety region: its install prerequisite, then its collider. Highest
    // priority, same deadline.
    const pickSafety = () => {
      for (const key of safety) if (system.inbox.has(key)) return { run: () => commitAndTint(system, key) };
      if (volumetricMode) for (const key of safety) if (colliderWanted(key) && colliders > 0) return { run: () => { buildCollider(key); colliders--; } };
      return null;
    };
    // (2) Everything else, nearest-first within a stage, stages rotated so none starves, and a
    // queue older than integrateAgeMs jumping the order outright.
    const pickOther = () => {
      const stages = [];
      for (const t of targets) {
        if (t.sys.queuedCount > 0) stages.push({ age: t.sys.queuedOldestMs(), run: () => commitAndTint(t.sys) });
      }
      if (folds > 0) {
        for (const t of targets) {
          const key = nextFoldKey(t.sys, t.batched, t.sys === system ? [bodyPosition[0], bodyPosition[2]] : [system.centerX, system.centerZ]);
          if (key != null) { stages.push({ age: 0, run: () => { foldOne(t.sys, t.b, t.batched, t.hideRule, key); folds--; } }); break; }
        }
      }
      if (colliders > 0) {
        const key = nextColliderKey();
        if (key != null) stages.push({ age: 0, run: () => { buildCollider(key); colliders--; } });
      }
      if (!stages.length) return null;
      const aged = stages.filter(st => st.age > cfg.integrateAgeMs).sort((a, b) => b.age - a.age);
      if (aged.length) return aged[0];
      const pick = stages[stageCursor % stages.length];
      stageCursor++;
      return pick;
    };

    for (;;) {
      // Budget is checked BEFORE selecting, never in the middle of an operation.
      if (items > 0 && clock() >= deadline) { overran = true; break; }
      const op = pickSafety() ?? pickOther();
      if (!op) break;
      const opStart = clock();
      op.run();
      const ms = clock() - opStart;
      if (ms > lastMaxItemMs) lastMaxItemMs = ms;
      items++;
    }
    lastItemCount = items;
    if (overran && clock() > deadline) lastOverruns++;
    lastIntegrateMs = clock() - t0;
    return items;
  }

  // Queued integration work across the near system AND every cascade level, so the budget and
  // the panel see the whole backlog rather than one system's share of it.
  function queuedTotal() { let n = system.queuedCount; for (const c of cascade) n += c.system.queuedCount; return n; }
  function queuedBytesTotal() { let n = system.queuedBytes; for (const c of cascade) n += c.system.queuedBytes; return n; }
  function queuedOldestTotal() { let n = system.queuedOldestMs(); for (const c of cascade) n = Math.max(n, c.system.queuedOldestMs()); return n; }
  function staleDropsTotal() { let n = system.staleDrops; for (const c of cascade) n += c.system.staleDrops; return n; }

  // How far the body is from the nearest ground that wants a collider and has not got one, in
  // metres. 0 when everything near it is collided, and 0 in heightfield mode, where the
  // heightfield provider answers everywhere regardless of which chunks are resident.
  function collisionReadyDistance() {
    if (!volumetricMode) return 0;
    const size = system.params.chunkSize;
    let worst = 0;
    for (const { key } of colliderOrder()) {
      if (!colliderWanted(key) && collidedChunks.has(key)) continue;
      if (!system.chunks.has(key)) continue;      // nothing to collide yet: that is the stream's problem
      const [ix, iz] = key.split(',').map(Number);
      const d = Math.hypot((ix + 0.5) * size - colliderFocus[0], (iz + 0.5) * size - colliderFocus[1]);
      if (worst === 0 || d < worst) worst = d;
    }
    return +worst.toFixed(1);
  }

  function integratePending() {
    if (system.queuedCount > 0) return true;
    for (const c of cascade) if (c.system.queuedCount > 0) return true;
    return false;
  }

  function refreshTileBounds() {
    const want = new Set();
    for (const c of system.activeChunks) {
      want.add(c.key);
      if (!boundsByKey.has(c.key)) {
        const box = new THREE.Box3(new THREE.Vector3(c.xMin, -1, c.zMin), new THREE.Vector3(c.xMin + c.size, 1, c.zMin + c.size));
        const helper = new THREE.Box3Helper(box, 0x4fd1ff);
        helper.material = boundsMaterial;
        boundsGroup.add(helper);
        boundsByKey.set(c.key, { helper, box, stale: c.stale });
      }
      const entry = boundsByKey.get(c.key);
      const chunk = system.chunks.get(c.key);
      if (chunk?.mesh?.geometry?.boundingSphere) {
        const bs = chunk.mesh.geometry.boundingSphere;
        entry.box.min.y = bs.center.y - bs.radius; entry.box.max.y = bs.center.y + bs.radius;
      }
    }
    for (const [key, entry] of boundsByKey) {
      if (want.has(key)) continue;
      boundsGroup.remove(entry.helper);
      entry.helper.geometry.dispose();
      boundsByKey.delete(key);
    }
  }

  function applyVisibility() {
    system.group.visible = active && visible;
    batcher.group.visible = active && visible;
    if (clipmap) clipmap.setVisible(farLodMode && visible && !volumetricMode);
    for (const c of cascade) c.group.visible = active && visible && farLodMode && volumetricMode;
    boundsGroup.visible = active && visible && tileBounds;
    contactMarker.visible = active && visible && collisionDebug;
  }

  // The ground a body stands on at (x, z): the density surface in volumetric mode (it warps up
  // to ~warp_strength from the heightfield), the heightfield otherwise.
  function groundHeight(x, z) {
    if (volumetricMode && typeof system.source?.surfaceYAt === 'function') return system.source.surfaceYAt(x, z);
    return system.getHeight(x, z);
  }
  function spawnPosition(x = 0, z = 0, clearance = 1.5) {
    return [x, Math.max(groundHeight(x, z), seaLevel) + clearance, z];
  }
  function recolorAll() {
    for (const chunk of system.chunks.values()) if (chunk.mesh) colorizeGeometry(chunk.mesh.geometry, true);
    for (const c of cascade) for (const chunk of c.system.chunks.values()) if (chunk.mesh) colorizeGeometry(chunk.mesh.geometry, true);
    // batched copies hold the old colours: drop them so applyMaterials() re-adds every chunk
    for (const key of [...batchedChunks.keys()]) { batcher.remove(key); batchedChunks.delete(key); }
    for (const cb of cascadeBatchers.values()) for (const key of [...cb.batched.keys()]) { cb.batcher.remove(key); cb.batched.delete(key); }
    applyMaterials();
  }
  function setSeaLevel(level) {
    if (!Number.isFinite(level) || level === seaLevel) return false;
    seaLevel = level;
    tintRevision++;
    syncTint();
    uGroundSea.value = seaLevel;
    tileCover.setSeaLevel(level);
    planWalk.setSeaLevel(level);
    fieldWindow()?.clear();          // cover was derived against the old waterline
    planWindow()?.clear();
    recolorAll();
    return true;
  }
  function volumeFloorY() {
    const d = system.source?.project?.density;
    return d ? d.y_min : null;
  }

  const api = {
    root,
    system,
    batcher,        // exposed like `system`: the batched-chunk state tests and debug UI read
    provider,
    get source() { return system.source; },
    get active() { return active; },
    get killPlaneBelowSurface() { return cfg.killPlaneBelowSurface; },
    groundHeight,
    spawnPosition,
    get seaLevel() { return seaLevel; },
    setSeaLevel,
    seaDepth,
    setSeaDepthActive(flag) { seaDepthActive = !!flag; },
    // Streamed biome/moisture field (plants plan F2). Hold a reference to make it stream.
    acquireFields,
    get fields() { return fieldWindow(); },
    get fieldScheduler() { return fieldScheduler; },
    acquirePlan,
    get plan() { return planWindow(); },
    get planScheduler() { return planScheduler; },
    fieldsReady: (x, z) => fieldWindow()?.ready(x, z) === true,
    acquireContactField,
    get contactField() { return contactWindow(); },
    contactHeightAt,
    contactReady: (x, z) => contactWindow()?.ready(x, z) === true,
    biomeAt, biomeIdAt, moistureAt, treeDensityAt, surfaceFieldAt, coverAt,
    get tileCover() { return tileCover; },
    setTrailPlannerHooks({ clearanceAt = null, settledAt = null } = {}) {
      trailClearanceAt = typeof clearanceAt === 'function' ? clearanceAt : null;
      tileCover.setClearance(composedClearance());
      trailSettledAt = typeof settledAt === 'function' ? settledAt : null;
      fieldWindow()?.clear();
    },
    // Structures zero the cover under their floors. No window clear: a building arriving after a
    // tile stamps the resident posts itself; this hook covers the tiles that derive after it.
    setStructureClearance(clearanceAt = null) {
      structureClearanceAt = typeof clearanceAt === 'function' ? clearanceAt : null;
      tileCover.setClearance(composedClearance());
    },
    fieldSurfaceAt,
    // Kill plane follows the local surface so deep valleys never respawn a grounded player;
    // in volumetric mode caves reach down to the density floor, so it sits below that.
    killPlaneYAt(x, z) {
      const surface = groundHeight(x, z) - cfg.killPlaneBelowSurface;
      const floor = volumetricMode ? volumeFloorY() : null;
      return floor == null ? surface : Math.min(surface, floor - 10);
    },
    get volumetric() { return volumetricMode; },
    get volumeProvider() { return volumeProvider; },
    get handoffPending() { return handoffPending; },
    get farLod() { return farLodMode; },
    // Ground textures: hand in a built streamed-splat material (or null to drop it).
    // Chunks and every cascade level get their own instance from the same textures, bound to the
    // LOD coverage maps; the caller's `material` only supplies the tuning cfg.
    setSplatMaterial(material, textures = null) {
      splatMaterial = material ?? null;
      splatTextures = textures;
      if (splatTextures && splatBiomes) splatTextures.biomes = splatBiomes.textures;
      // Averages come from the loaded textures; the placeholder set carries them too.
      syncGroundColor();
      tileCover.setSplatCfg(material?.userData?.streamedSplat?.cfg ?? null);
      fieldWindow()?.clear();        // cover is reconciled against these weights
      for (const m of splatInstances.values()) m.dispose();
      splatInstances.clear();
      applyMaterials();
    },
    // Swap the pictures behind the bound texture set (a project's material slots). Every instance
    // and the grass ground node keep their graphs; only the images and averages change.
    swapSplatTextures(next) {
      if (!splatTextures || !next) return false;
      const patch = replaceStreamedSplatImages(splatTextures, next);
      splatGround?.setTextures?.(splatTextures);
      this.updateSplat(patch);
      return true;
    },
    get splatSlots() { return splatTextures?.slots ?? null; },
    // Per-biome overrides: `textures` from loadStreamedSplatBiomeArray (or null for rules only),
    // `table` from biomeLayerTable, `rules` from biomeRuleTable. Null drops the binding.
    setSplatBiomes(next) {
      const sameTextures = !!splatBiomes && !!next && splatBiomes.textures === (next.textures ?? null);
      if (!next) {
        splatBiomes = null;
        if (splatTextures) splatTextures.biomes = null;
        splatFieldRelease?.(); splatFieldRelease = null;
      } else {
        splatBiomes = { textures: next.textures ?? null, table: next.table, rules: next.rules };
        if (splatTextures) splatTextures.biomes = splatBiomes.textures;
        if (!splatFieldRelease) splatFieldRelease = acquireFields();
      }
      if (sameTextures) {
        for (const m of splatInstances.values()) updateStreamedSplat(m, { biomeTable: next.table, biomeRules: next.rules, biomeAverages: next.textures?.averages ?? [] });
        return;
      }
      for (const m of splatInstances.values()) m.dispose();
      splatInstances.clear();
      applyMaterials();
    },
    get splatBiomes() { return splatBiomes; },
    // Live tuning for every splat instance at once.
    updateSplat(patch) { if (splatMaterial) updateStreamedSplat(splatMaterial, patch); for (const m of splatInstances.values()) updateStreamedSplat(m, patch); },
    get lodCoverage() { return { exact: coverExact, levels: coverLevels }; },
    setSplatWater,
    setSplatRain,
    setSplatEnabled(value) { splatEnabled = !!value; syncGroundColor(); applyMaterials(); },
    // The ground colour under a point, in the frame grass wants: global height in, vec3 out. Built
    // once and cached, because a consumer bakes it into a shader graph.
    groundColorNode() {
      if (!groundNode) {
        splatGround = createSplatSampleNode(splatTextures, splatMaterial?.userData?.streamedSplat?.cfg);
        syncGroundColor();
        groundNode = Fn(([x, z, yGlobal, normalY]) => {
          const tint = terrainTintNode(yGlobal.sub(uGroundSea), normalY);
          return tslMix(tint, splatGround.node(x, z, yGlobal, normalY), uGroundSplatMix);
        });
      }
      return groundNode;
    },
    // True once the ground's real appearance is knowable: textures loaded, or textures off, in
    // which case the vertex tint IS what the ground shows.
    get groundColorReady() { return !!splatTextures || !splatEnabled; },
    // The maps themselves have arrived. A graph built before this has no maps to sample even if
    // the toggle is turned on later, so a consumer that bakes the ground colour waits on this.
    get groundTexturesLoaded() { return !!splatTextures; },
    // CPU twin of groundColorNode with the layers' AVERAGE colours where the GPU samples texels:
    // what a sample should land near, not equal. Linear rgb, or null where the field has not streamed.
    groundColorAt(x, z) {
      const s = surfaceFieldAt(x, z);
      if (!s) return null;
      const tint = terrainTintAt(s.height - seaLevel, s.normalY);
      if (!(splatEnabled && splatTextures)) return tint;
      const out = [0, 0, 0];
      ['sand', 'grass', 'dirt', 'rock', 'snow'].forEach((name, i) => {
        const a = splatTextures.layers?.[name]?.average;
        if (!a) return;
        for (let k = 0; k < 3; k++) out[k] += a[k] * s.weights[i];
      });
      return out;
    },
    get groundColorSamplesTextures() { return !!splatGround?.ready; },
    // The height the far rings draw at a GLOBAL xz: a TSL Fn(([xz]) => y) over the clipmap's own
    // textures, and its CPU twin. Null without the rings (far LOD off, or volumetric worlds).
    get drawnHeightNode() { return (clipmap && !volumetricMode) ? clipmap.drawnHeightNode : null; },
    // The same, compiled for only the ring levels that reach `maxRadius` (fewer texture bindings).
    drawnHeightNodeFor(maxRadius) { return (clipmap && !volumetricMode) ? clipmap.drawnHeightNodeFor(maxRadius) : null; },
    // Whether those levels have streamed; false during a restream, when they read as height 0.
    drawnHeightReady(maxRadius) { return !!(clipmap && !volumetricMode && clipmap.drawnHeightReady(maxRadius)); },
    drawnHeightAt(x, z) { return (clipmap && !volumetricMode) ? clipmap.drawnHeightAt(x, z) : null; },
    setGroundColorMip(v) { splatGround?.setMip(v); },
    syncGroundColor,
    get splatMaterial() { return splatMaterial; },
    get splatEnabled() { return splatEnabled; },
    get clipmap() { return clipmap; },
    // Far rings on/off. The rings' outer half-extent is what the camera far plane should cover.
    setFarLod(value) {
      const next = !!value;
      if (next === farLodMode) return;
      farLodMode = next;
      if (next) ensureFarLod();
      applyVisibility();
    },
    get farExtent() {
      if (!farLodMode) return 0;
      return volumetricMode ? cascadeExtent() : (clipmap ? clipmap.outerHalfExtent : 0);
    },
    get volumeLod() { return cascade.map(c => ({ level: c.level, system: c.system, spec: c.spec })); },
    cascadeMaterialFor(level) { return splatInstances.get(level) ?? null; },
    // Bumped whenever the resident chunk set changes, so a caller that bakes over the terrain (the
    // rain shadow) can tell staleness from a mere camera move without watching every chunk itself.
    get residencyRevision() { return residencyRevision; },
    // True once per completed handoff (read-and-clear), for the caller to re-seat the player.
    takeHandoffCompleted() { const v = handoffDone; handoffDone = false; return v; },

    // Mode switch: visuals and authoritative collision together (replaces Empty/Traversal Lab).
    setActive(value) {
      active = !!value;
      applyProviders();
      applyVisibility();
    },
    // Marching-cubes chunks (caves/overhangs) instead of the heightfield quad. Restreams.
    setVolumetric(value) {
      const next = !!value;
      if (next === volumetricMode) return;
      if (next && !system.source?.densityAt) throw new Error('the active terrain source has no density field (volumetric needs a v5 project)');
      system.setVolumetric(next);
      volumetricMode = next;
      reopenFieldWindow();          // volumetric adds surfaceHeights, so the payload differs
      handoffPending = next;     // heightfield -> volume waits for the chunk; the other way is immediate
      handoffDone = !next;
      applyProviders();
      syncVolumeColliders();
      if (farLodMode) ensureFarLod();
      applyVisibility();
    },
    // Visual toggle only: collision stays authoritative while hidden.
    setVisible(value) { visible = !!value; applyVisibility(); },
    // Hide far rings past this half-extent (heightfield mode only; the cascade has no rings).
    setFarExtentCap(r) { if (clipmap) clipmap.setMaxHalfExtent(r); },
    setDrawRadius(radius) {
      const r = Math.max(0, Math.floor(radius));
      if (r !== system.params.renderRadius) system.params.renderRadius = r;   // picked up by update()'s chunking signature
    },
    setWireframe(value) { wireframe = !!value; applyMaterials(); },
    setNormals(value) { normals = !!value; applyMaterials(); },
    setTileBounds(value) { tileBounds = !!value; applyVisibility(); if (tileBounds) refreshTileBounds(); },
    setCollisionDebug(value) { collisionDebug = !!value; applyVisibility(); },

    // Swap the streamed + collided source (Phase 7 apply path); epoch bump, no hole.
    setSource(next) {
      const wantVolumetric = volumetricMode;
      if (wantVolumetric) system.params.volumetric = false;   // a source without density cannot stream volume
      system.setSource(next);
      provider.setSource(system.source);
      if (clipmap) clipmap.setSource(system.source, system.source.descriptor);
      for (const c of cascade) c.system.setSource(next);
      seaLevel = system.source?.descriptor?.seaLevel ?? 0;
      tintRevision++;
      syncTint();
      uGroundSea.value = seaLevel;
      tileCover.setSeaLevel(seaLevel);   // cover is derived against the waterline, and the swap moved it
      planWalk.setSeaLevel(seaLevel);
      seaDepth.setSource(system.source);
      fieldWindow()?.setSource(system.source, system.source.descriptor);
      contactWindow()?.setSource(system.source, system.source.descriptor);
      planWindow()?.setSource(system.source, system.source.descriptor);
      // nothing survives a swap, so there is nothing to dissolve from: coverage restarts at zero
      coverExact.clear(); for (const cl of coverLevels) cl.clear();
      installedTotal = 0;
      volumetricMode = false;
      if (wantVolumetric && system.source?.densityAt) { system.params.volumetric = true; volumetricMode = true; }
      handoffPending = volumetricMode;
      handoffDone = !volumetricMode && wantVolumetric;
      reopenFieldWindow();          // the new source may need a different field set
      applyProviders();
      syncVolumeColliders();
    },

    // Per frame with GLOBAL positions, never render-local: the world streams around `globalPosition`
    // (the craft at the stick), colliders and the handoff follow `bodyPosition` (the player's body).
    update(globalPosition, dt = 0, bodyPosition = globalPosition) {
      if (!active) return false;
      // The lead the streamers prefetch along, from the body's own motion and the dt we are
      // given: this is the only place with a dt worth trusting.
      if (dt > 0 && lastBody) {
        const a = 0.25;   // smoothed, so one long frame does not swing the window
        bodyVelocity[0] += ((bodyPosition[0] - lastBody[0]) / dt - bodyVelocity[0]) * a;
        bodyVelocity[1] += ((bodyPosition[2] - lastBody[2]) / dt - bodyVelocity[1]) * a;
        system.setMotion(bodyVelocity[0], bodyVelocity[1]);
        for (const c of cascade) c.system.setMotion(bodyVelocity[0], bodyVelocity[1]);
      }
      const t0 = performance.now();
      const changed = system.update(globalPosition[0], globalPosition[2]);
      const size = system.params.chunkSize;
      const focusMoved = Math.floor(bodyPosition[0] / size) !== Math.floor(colliderFocus[0] / size) || Math.floor(bodyPosition[2] / size) !== Math.floor(colliderFocus[1] / size);
      colliderFocus[0] = bodyPosition[0]; colliderFocus[1] = bodyPosition[2];
      // Crossing a chunk boundary changes which chunks want colliders; the fold block below is the
      // one place that rebuilds them, so it only has to be told there is work.
      if (focusMoved && volumetricMode) colliderPending = true;
      lastUpdateMs = performance.now() - t0;
      const near = system.takeInstallCost();
      lastInstallMs = near.ms;
      lastInstallCount = near.count;
      lastWorkerTintMs = near.workerTintMs;
      for (const c of cascade) {
        const far = c.system.takeInstallCost();
        lastInstallMs += far.ms;
        lastInstallCount += far.count;
        lastWorkerTintMs += far.workerTintMs;
      }
      const resident = system.chunks.size;
      if (resident > lastResident) { perSecond.installs += resident - lastResident; installedTotal += resident - lastResident; }
      lastResident = resident;
      perSecond.window += dt;
      if (perSecond.window >= 1) { perSecond.rate = perSecond.installs / perSecond.window; perSecond.installs = 0; perSecond.window = 0; }
      lastFoldMs = lastColorizeMs = lastBatchMs = lastColliderMs = lastIntegrateMs = 0;
      lastItemCount = lastColorizePassCount = 0;
      const colorizeBytesMark = colorizeBytes;
      if (seaDepthActive) { seaDepth.recentre(globalPosition[0], globalPosition[2]); seaDepth.update(); }
      if (farLodMode && !volumetricMode && clipmap) {
        const t1 = performance.now();
        if (changed || !clipmap.holeRect) clipmap.setHoleRect(chunkWindowRect());
        clipmap.update(globalPosition);
        lastClipmapMs = performance.now() - t1;
      }
      let cascadeChanged = false;
      if (farLodMode && volumetricMode && cascade.length) {
        const t1 = performance.now();
        for (const c of cascade) cascadeChanged = c.system.update(globalPosition[0], globalPosition[2]) || cascadeChanged;
        lastClipmapMs = performance.now() - t1;
      }
      // One scheduler over the near system, every cascade level and the colliders, on one
      // deadline. The cascade's own unbudgeted applyMaterials() call is gone: it folded every
      // pending chunk at every level whenever a far chunk landed, which was the 27 ms fold.
      const tFold = performance.now();
      let committed = 0;
      if (changed || cascadeChanged || foldPending || colliderPending || integratePending()) {
        syncColliderRemovals();
        applyMaterialsPass();
        committed = integrate(bodyPosition);
        foldPending = applyMaterialsPass() > 0;   // a second pass: what the scheduler folded is now visible
        colliderPending = nextColliderKey() != null;
      }
      lastFoldMs = performance.now() - tFold;
      lastBody = [bodyPosition[0], bodyPosition[1], bodyPosition[2]];
      const tField = performance.now();
      const fw = fieldWindow(), cw = contactWindow(), pw = planWindow();
      if (fw) fw.update(globalPosition[0], globalPosition[2]);
      if (cw) cw.update(globalPosition[0], globalPosition[2]);
      if (pw) pw.update(globalPosition[0], globalPosition[2]);
      if (fw || cw) fieldScheduler.pump();
      if (pw) planScheduler.pump();
      // Commits, not just `changed`: a chunk installed by the scheduler this frame is residency
      // that moved this frame, and `changed` would not report it until the next update().
      const residencyMoved = changed || cascadeChanged || committed > 0;
      if (residencyMoved) residencyRevision++;   // anything baked over the chunks is stale
      updateCoverage(globalPosition, dt, residencyMoved);
      lastFieldMs = performance.now() - tField;
      const bodyCollided = volumeProvider.hasChunk(chunkKeyAt(bodyPosition[0], bodyPosition[2]));
      if (handoffPending && bodyCollided) {
        handoffPending = false;
        handoffDone = true;
        applyProviders();
      } else if (volumetricMode && !handoffPending && !bodyCollided) {
        // The body's chunk left (the stream focus is on a drone elsewhere): the heightfield answers until it is back.
        handoffPending = true;
        applyProviders();
      }
      lastColorizeBytes = colorizeBytes - colorizeBytesMark;
      collectBatchUpload();
      if (residencyMoved && tileBounds) refreshTileBounds();
      if (collisionDebug) {
        const hit = provider.groundProbe({ origin: [globalPosition[0], globalPosition[1] + 0.5, globalPosition[2]], maxDistance: 50, slopeLimitCos: -1 });
        contactMarker.visible = !!hit && visible;
        if (hit) contactMarker.position.set(hit.point[0], hit.point[1], hit.point[2]);
      }
      return changed;
    },

    // Per-frame cost split, cheap enough to read every frame (stats is not). One object, mutated:
    // the page reads this every frame and a fresh literal is per-frame garbage. Copy it (the
    // performance capture does) rather than holding the reference.
    get frameCost() {
      frameCostOut.installMs = lastInstallMs; frameCostOut.foldMs = lastFoldMs; frameCostOut.fieldMs = lastFieldMs;
      frameCostOut.installCount = lastInstallCount; frameCostOut.colorizeMs = lastColorizeMs;
      frameCostOut.batchMs = lastBatchMs; frameCostOut.colliderMs = lastColliderMs;
      frameCostOut.integrateMs = lastIntegrateMs; frameCostOut.integrateItems = lastItemCount;
      frameCostOut.maxItemMs = lastMaxItemMs; frameCostOut.colorizePassCount = lastColorizePassCount;
      frameCostOut.queued = queuedTotal(); frameCostOut.queuedBytes = queuedBytesTotal();
      frameCostOut.inFlight = inFlightBudget.count;   // jobs outstanding: queued at a worker or running
      frameCostOut.busyWorkers = workerPool?.busyWorkers ?? 0;   // workers holding unacknowledged work; approximates threads executing
      frameCostOut.workerTintMs = lastWorkerTintMs; frameCostOut.overruns = lastOverruns;
      frameCostOut.queuedOldestMs = queuedOldestTotal();
      frameCostOut.batchFirstUploads = lastBatchUpload.firstUploads;
      frameCostOut.batchFirstUploadBytes = lastBatchUpload.firstUploadBytes;
      frameCostOut.batchVisibilityFlips = lastBatchUpload.visibilityFlips;
      frameCostOut.batchFallbacks = lastBatchUpload.fallbacks;
      frameCostOut.batchCompactions = lastBatchUpload.compactions;
      frameCostOut.batchCompactionShifts = lastBatchUpload.compactionShifts;
      frameCostOut.batchCompactionBytes = lastBatchUpload.compactionBytes;
      frameCostOut.colorizeBytes = lastColorizeBytes;
      return frameCostOut;
    },

    // Performance-record block: identifies the source, residency, queues, draws and timing.
    // draws = GPU draw calls (one drawIndexed per visible batched chunk on WebGPU, plus fallback
    // meshes), not batch objects; batches.batches has the object count.
    get stats() {
      let draws = 0, triangles = 0;
      if (system.group.visible) {
        for (const child of system.group.children) {
          if (!child.isMesh || !child.userData.terrainChunk || !child.visible) continue;
          draws++;
          const idx = child.geometry.index;
          triangles += idx ? idx.count / 3 : child.geometry.attributes.position.count / 3;
        }
        draws += batcher.drawCount;
        for (const chunk of batchedChunks.values()) { const idx = chunk.mesh?.geometry.index; if (idx) triangles += idx.count / 3; }
      }
      const info = system.sourceInfo;
      return {
        active, visible,
        source: { kind: info.kind, key: info.key, version: info.version, algorithmVersion: info.algorithmVersion ?? null, bounds: info.bounds },
        lod: 0,
        residentTiles: system.chunks.size,
        staleTiles: [...system.chunks.values()].filter(c => c.stale).length,
        targetTiles: system.targetChunkCount,
        queuedTiles: Math.max(0, system.buildQueue.length - system.buildQueueIndex),
        inFlightTiles: system.inFlight.size,
        drawRadius: system.params.renderRadius,
        chunkSize: system.params.chunkSize,
        worker: !!system.worker,
        draws, triangles,
        installedTotal,
        installsPerSecond: perSecond.rate,
        lastUpdateMs,
        lastFoldMs: +lastFoldMs.toFixed(2),
        lastColorizeMs: +lastColorizeMs.toFixed(2),
        lastBatchMs: +lastBatchMs.toFixed(2),
        lastColliderMs: +lastColliderMs.toFixed(2),
        foldPending,
        colliderPending,
        queued: queuedTotal(),
        queuedBytes: queuedBytesTotal(),
        queuedOldestMs: +queuedOldestTotal().toFixed(1),
        staleDrops: staleDropsTotal(),
        overruns: lastOverruns,
        maxItemMs: +lastMaxItemMs.toFixed(2),
        lastIntegrateMs: +lastIntegrateMs.toFixed(2),
        integrateBudgetMs: cfg.integrateBudgetMs,
        inFlight: inFlightBudget.count,
        maxInFlight: inFlightBudget.max,
        workers: workerPool?.count ?? system.worker?.count ?? 0,
        busyWorkers: workerPool?.busyWorkers ?? 0,
        prefetchKeys: system.prefetchKeys,
        collisionReadyDistance: collisionReadyDistance(),
        workerTintMs: +lastWorkerTintMs.toFixed(2),
        colorizePassCount: lastColorizePassCount,
        speed: +system.speed.toFixed(2),
        maxFoldsPerUpdate: cfg.maxFoldsPerUpdate,
        maxColliderRebuildsPerUpdate: cfg.maxColliderRebuildsPerUpdate,
        lastFieldMs: +lastFieldMs.toFixed(2),
        lastInstallMs: +lastInstallMs.toFixed(2),
        lastInstallCount,
        epoch: system.epoch,
        lastSourceError: system.lastSourceError ?? null,
        collisionProvider: volumetricMode
          ? { id: volumeProvider.id, enabled: volumeProvider.enabled !== false, chunks: volumeProvider.chunkCount, triangles: volumeProvider.triangleCount,
              build: volumeProvider.buildStats ? { ...volumeProvider.buildStats } : null }
          : { id: provider.id, enabled: provider.enabled !== false, colliderId: `${info.key}@${info.version}` },
        volumetric: volumetricMode,
        textures: splatMaterial ? (splatEnabled ? 'streamed-splat' : 'off') : 'tint',
        plan: planWindow() ? { coverage: planWindow().coverage, tilesBuilt: planWindow().stats.tilesBuilt,
          queued: planScheduler.stats.queued, inFlight: planScheduler.stats.inFlight,
          extent: planWindow().extent } : null,
        batches: batcher.stats,
        // Resident vs wanted, per streamer. resident - target is the margin/hysteresis overhang:
        // chunks kept past the draw radius, which still draw while they are in view.
        residency: {
          near: { target: system.targetChunkCount, resident: system.chunks.size, batched: batcher.residentCount, margin: system.chunks.size - system.targetChunkCount },
          levels: cascade.map(c => {
            const cb = cascadeBatchers.get(c.system);
            return { level: c.level, target: c.system.targetChunkCount, resident: c.system.chunks.size, batched: cb ? cb.batcher.residentCount : 0, margin: c.system.chunks.size - c.system.targetChunkCount };
          }),
        },
        // Cumulative logical upload accounting over every batcher, plus this frame's slice.
        upload: (() => {
          const total = Object.fromEntries(batchUploadFields.map(k => [k, 0]));
          const addFrom = b => { const u = b.stats.upload; for (const k of batchUploadFields) total[k] += u[k]; };
          addFrom(batcher);
          for (const cb of cascadeBatchers.values()) addFrom(cb.batcher);
          return { total, frame: { ...lastBatchUpload }, colorizeBytesTotal: colorizeBytes, colorizeBytesFrame: lastColorizeBytes };
        })(),
        farLod: !farLodMode ? null
          : volumetricMode
            ? { kind: 'volume-cascade', levels: cascade.map(c => ({ level: c.level, chunkSize: c.spec.chunkSize, spacing: +(c.spec.chunkSize / c.spec.segments).toFixed(2), resident: c.system.chunks.size, target: c.system.targetChunkCount, inFlight: c.system.inFlight.size, lastSourceError: c.system.lastSourceError ?? null })), outerHalfExtent: cascadeExtent(), triangles: cascade.reduce((n, c) => { for (const ch of c.system.group.children) if (ch.isMesh && ch.visible && ch.geometry.index) n += ch.geometry.index.count / 3; const cb = cascadeBatchers.get(c.system); if (cb) for (const chunk of cb.batched.values()) { const idx = chunk.mesh?.geometry.index; if (idx) n += idx.count / 3; } return n; }, 0), draws: cascade.reduce((n, c) => { n += c.system.group.children.filter(ch => ch.isMesh && ch.visible).length; const cb = cascadeBatchers.get(c.system); return n + (cb ? cb.batcher.drawCount : 0); }, 0), lastUpdateMs: +lastClipmapMs.toFixed(2) }
            : clipmap ? { kind: 'clipmap', ...clipmap.stats, lastUpdateMs: +lastClipmapMs.toFixed(2) } : null,
        debug: { wireframe, normals, tileBounds, collisionDebug },
      };
    },

    dispose() {
      stopRebase();
      splatFieldRelease?.(); splatFieldRelease = null;
      for (const handle of fieldHandles) handle.release();
      fieldHandles.clear();
      for (const handle of contactHandles) handle.release();
      contactHandles.clear();
      for (const handle of planHandles) handle.release();
      planHandles.clear();
      fieldRegistry.dispose();
      fieldScheduler.dispose();
      planRegistry.dispose();
      planScheduler.dispose();
      seaDepth.dispose();
      unregisterProvider();
      unregisterVolumeProvider();
      volumeProvider.clear();
      for (const entry of boundsByKey.values()) entry.helper.geometry.dispose();
      boundsByKey.clear();
      contactMarker.geometry.dispose();
      contactMarker.material.dispose();
      boundsMaterial.dispose();
      normalMaterial.dispose();
      root.removeFromParent();
      if (clipmap) clipmap.dispose();
      for (const m of splatInstances.values()) m.dispose();
      coverExact.dispose(); for (const cl of coverLevels) cl.dispose();
      batcher.dispose();
      for (const cb of cascadeBatchers.values()) cb.batcher.dispose();
      for (const c of cascade) { c.system.dispose(); c.group.removeFromParent(); }
      system.dispose();
      workerPool?.dispose();
    },
  };
  applyProviders();   // inactive until the host selects the terrain world mode
  applyVisibility();
  return api;
}

// Convenience for hosts that keep descriptors in state: builds the source up front so
// a bad descriptor fails here, not inside the worker.
export function terrainSourceFromDescriptor(descriptor) {
  return createSource(descriptor);
}
