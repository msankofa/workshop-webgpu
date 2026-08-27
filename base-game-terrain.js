// base-game-terrain.js — Base Game's terrain runtime owner (terrain plan Phase 4).
// Owns the source-injected terrain-system streamer, a render-origin-rebased scene
// root, the heightfield world-query provider, debug views and runtime stats.
// It does not own the player, camera, networking or the state file.

import * as THREE from 'three';
import { MeshNormalNodeMaterial } from 'three/webgpu';
import { createTerrainSystem } from './terrain-system.js';
import { createSource } from './terrain-source.js';
import { createHeightfieldWorldQueryProvider } from './world-query-heightfield-provider.js';
import { createChunkMeshWorldQueryProvider } from './world-query-chunk-mesh-provider.js';
import { globalToRenderLocal } from './world-coordinates.js';
import { createTerrainClipmap } from './terrain-clipmap.js';
import { createChunkBatcher } from './terrain-chunk-batches.js';
import { createStreamedSplatMaterial, syncStreamedSplatCoverage, updateStreamedSplat } from './terrain-splat-streamed.js';
import { createLodCoverage } from './terrain-lod-coverage.js';
import { createSeaDepthMap } from './terrain-sea-depth.js';
import { createFieldScheduler, FIELD_PRIORITY } from './terrain-field-scheduler.js';
import { createFieldWindow, createFieldWindowRegistry } from './terrain-field-window.js';
import { BIOMES, BIOME_INDEX, treeDensityForBiome } from './terrain-biome-point.js';
import { createTileCover, COVER_CHANNELS, decodeCover } from './flora-field.js';
import { splatWeights } from './terrain-splat-streamed.js';

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

export function createBaseGameTerrain({
  scene, worldQuery, worldCoordinates, source,
  params = {}, providerId = 'terrain', volumeProviderId = 'terrain-volume', useWorker = true, volumetric = false, farLod = false,
}) {
  if (!scene?.add) throw new TypeError('Base Game terrain requires a Three.js scene');
  if (!worldQuery?.registerProvider) throw new TypeError('Base Game terrain requires a world-query service');
  if (!worldCoordinates?.getOrigin) throw new TypeError('Base Game terrain requires the world coordinate space');
  if (!source) throw new TypeError('Base Game terrain requires a terrain source or descriptor');

  const cfg = { ...BASE_GAME_TERRAIN_DEFAULTS, ...params };
  const system = createTerrainSystem({
    params: { chunkSize: cfg.chunkSize, renderRadius: cfg.renderRadius, maxChunksPerUpdate: cfg.maxChunksPerUpdate, maxUnloadsPerUpdate: cfg.maxUnloadsPerUpdate, useWorker },
    source,
  });
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
  // Returns true when colliders were left to rebuild. Nearest-first: a budget must never defer the
  // chunk the player is standing on, so the wanted list is ordered by distance from the focus and
  // the removals (cheap) always run.
  function syncVolumeColliders(maxRebuilds = 0) {
    if (!volumetricMode) { if (collidedChunks.size) { volumeProvider.clear(); collidedChunks.clear(); } return false; }
    const size = system.params.chunkSize, r = cfg.collisionRadius;
    const cx = Math.floor(colliderFocus[0] / size), cz = Math.floor(colliderFocus[1] / size);
    const wanted = new Set();
    const order = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const key = `${cx + dx},${cz + dz}`;
      wanted.add(key);
      order.push({ key, d2: dx * dx + dz * dz });
    }
    order.sort((a, b) => a.d2 - b.d2);
    let built = 0, deferred = false;
    for (const { key } of order) {
      const chunk = system.chunks.get(key);
      if (!chunk || !chunk.meta.volumetric || !chunk.mesh) continue;
      if (collidedChunks.get(key) === chunk) continue;
      if (maxRebuilds > 0 && built >= maxRebuilds) { deferred = true; break; }
      volumeProvider.setChunk(key, collisionGeometry(chunk), { sourceVersion: chunk.meta.sourceVersion });
      collidedChunks.set(key, chunk);
      built++;
    }
    for (const key of [...collidedChunks.keys()]) {
      if (!wanted.has(key) || !system.chunks.has(key)) { volumeProvider.removeChunk(key); collidedChunks.delete(key); }
    }
    return deferred;
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
  function splatFor(index) {
    if (!splatMaterial || !splatTextures) return null;
    let m = splatInstances.get(index);
    if (!m) {
      const self = index === 0 ? coverExact : coverLevels[index - 1];
      const finer = index === 0 ? null : (index === 1 ? coverExact : coverLevels[index - 2]);
      m = createStreamedSplatMaterial(splatTextures, splatMaterial.userData.streamedSplat.cfg, { lod: { self, finer }, water: splatWater, rain: splatRain });
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
  // Per frame: coverage ramps follow residency; origins follow the player; uniforms follow both.
  // The present-set rebuild iterates every resident chunk, so it runs only when residency changed,
  // a window recentred, or a ramp is still animating — not on every quiet frame.
  function updateCoverage(globalPosition, dt, residencyChanged) {
    let touched = false;
    const moved = coverExact.recentre(globalPosition[0], globalPosition[2]);
    if (residencyChanged || moved || coverExact.animating) { coverExact.update(presentKeys(system, hideStaleHeightfield), dt); touched = true; }
    cascade.forEach((c, i) => {
      const m2 = coverLevels[i].recentre(globalPosition[0], globalPosition[2]);
      if (residencyChanged || m2 || coverLevels[i].animating) { coverLevels[i].update(presentKeys(c.system, () => false), dt); touched = true; }
    });
    if (touched) for (const m of splatInstances.values()) syncStreamedSplatCoverage(m);
  }
  // Chunks draw through BatchedMesh pools (terrain-chunk-batches.js): one scene object per ~256
  // chunks instead of one each, but still one drawIndexed per visible chunk on WebGPU. A chunk's
  // own mesh is hidden once it is in a batch; it stays the fallback when a batch cannot take it.
  const batcher = createChunkBatcher({ material: system.material, name: 'base-game-terrain-batches', perObjectFrustumCulled: cfg.batchFrustumCulled });
  const batchedChunks = new Map();   // key -> chunk object currently copied into the batcher
  const cascadeBatchers = new Map(); // cascade system -> { batcher, batched }
  const cascade = [];   // [{ system, group, level, spec }]
  function ensureCascade() {
    if (cascade.length) return cascade;
    cfg.volumeLod.forEach((spec, i) => {
      const lvl = createTerrainSystem({
        params: { chunkSize: spec.chunkSize, renderRadius: spec.renderRadius, segmentsPerChunk: spec.segments, lod: i + 1, volumetric: true, maxChunksPerUpdate: 1, maxUnloadsPerUpdate: 2, useWorker },
        source: system.source,
      });
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
  const stopRebase = worldCoordinates.onRebase(event => { root.position.add(new THREE.Vector3().fromArray(event.delta)); });

  // Base Game readability tint: height/slope vertex colours (sea-level sand, grass, rock on
  // steep faces, snow up high). Biome/material masks from v5 are not streamed yet.
  system.material.vertexColors = true;
  system.material.color.set(0xffffff);
  const TINT = { water: [0.16, 0.32, 0.42], sand: [0.72, 0.66, 0.46], grass: [0.30, 0.48, 0.22], dry: [0.46, 0.44, 0.28], rock: [0.42, 0.40, 0.38], snow: [0.92, 0.93, 0.95] };
  const mixInto = (out, o, a, b, t) => { out[o] = a[0] + (b[0] - a[0]) * t; out[o + 1] = a[1] + (b[1] - a[1]) * t; out[o + 2] = a[2] + (b[2] - a[2]) * t; };
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  // Ground height around the player for water (terrain-sea-depth.js): streams only while active.
  const seaDepth = createSeaDepthMap({ source: system.source, useWorker });
  // Field windows (biome, moisture, visible surface) share one small worker pool, deliberately
  // separate from and smaller than terrain-system's, so a placement tile can never be what a
  // visible or collision chunk is queued behind.
  const fieldScheduler = createFieldScheduler({ useWorker });
  const fieldRegistry = createFieldWindowRegistry({ scheduler: fieldScheduler });
  const fieldHandles = new Set();   // one registry handle per consumer; the registry owns the window
  const contactHandles = new Set();
  // surfaceHeights costs a surfaceYAt scan per post (~26 us), so it is requested only where the
  // ground can actually differ from the heightfield: volumetric mode.
  // Cover is derived per texel as each tile lands, from the biome, the moisture and the very
  // splat weights the ground is textured with (flora-field.js). One number per layer per texel.
  const tileCover = createTileCover({ seaLevel: system.source?.descriptor?.seaLevel ?? 0, biomeNames: BIOMES });
  function placementFields() {
    return volumetricMode ? ['surfaceHeights', 'biomeIds', 'moisture'] : ['biomeIds', 'moisture'];
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
    for (const [set, open] of [[fieldHandles, openFieldWindow], [contactHandles, openContactWindow]]) {
      if (!set.size) continue;
      const previous = [...set];
      set.clear();
      for (const _ of previous) set.add(open());
      for (const handle of previous) handle.release();
    }
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
  // Tint bands sit on the sea level (descriptor.seaLevel, 0 without one); chunks recolour on change.
  let seaLevel = system.source?.descriptor?.seaLevel ?? 0;
  function colorizeGeometry(geo, force = false) {
    if (geo.getAttribute('color') && !force) return;
    const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal');
    const colors = new Float32Array(pos.count * 3);
    const c = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) - seaLevel, ny = nrm ? nrm.getY(i) : 1;
      if (y < 0) mixInto(c, 0, TINT.water, TINT.sand, clamp01(1 + y / 6));
      else if (y < 2) mixInto(c, 0, TINT.sand, TINT.grass, clamp01(y / 2));
      else if (y < 60) mixInto(c, 0, TINT.grass, TINT.dry, clamp01((y - 20) / 40));
      else mixInto(c, 0, TINT.dry, TINT.snow, clamp01((y - 60) / 40));
      const rock = clamp01((0.82 - ny) / 0.25);   // steeper than ~35 degrees fades to rock
      colors[i * 3] = c[0] + (TINT.rock[0] - c[0]) * rock;
      colors[i * 3 + 1] = c[1] + (TINT.rock[1] - c[1]) * rock;
      colors[i * 3 + 2] = c[2] + (TINT.rock[2] - c[2]) * rock;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
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

  // `budget` is shared across the near system and every cascade level, so one frame's fold-in is
  // bounded overall rather than per-system. Returns true when chunks were left unfolded.
  function syncBatches(sys, b, batched, hideRule, budget = null) {
    let deferred = false;
    b.beginFrame();
    for (const [key, chunk] of sys.chunks) {
      if (!chunk.mesh) continue;
      const hidden = hideRule(chunk);
      if (batched.get(key) !== chunk) {
        if (budget && budget.left <= 0) {
          // Not folded this frame: the chunk draws its own mesh, which is correct, just cheaper
          // to leave than to batch right now. Colours are already applied by applyMaterials.
          // A replaced chunk still has its predecessor's geometry in the batch under this key --
          // left visible it would draw over the new mesh, so the mesh wins until the fold lands.
          deferred = true;
          if (b.has(key)) b.setVisible(key, false);
          chunk.mesh.visible = !hidden;
          continue;
        }
        colorizeGeometry(chunk.mesh.geometry);
        if (b.add(key, chunk.mesh.geometry)) batched.set(key, chunk); else batched.delete(key);
        if (budget) budget.left--;
      }
      const inBatch = batched.get(key) === chunk;
      chunk.mesh.visible = !inBatch && !hidden;
      if (inBatch) b.setVisible(key, !hidden);
    }
    for (const key of [...batched.keys()]) if (!sys.chunks.has(key)) { b.remove(key); batched.delete(key); }
    return deferred;
  }
  function applyMaterials(maxFolds = 0) {
    const budget = maxFolds > 0 ? { left: maxFolds } : null;
    let deferred = false;
    const tColor = performance.now();
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
    // During a restream into volumetric mode the retained heightfield chunks are wrong ground:
    // hide them and let the cascade's 5 m level show through until the exact chunk lands.
    lastColorizeMs = performance.now() - tColor;
    const tBatch = performance.now();
    batcher.setMaterial(mat);
    deferred = syncBatches(system, batcher, batchedChunks, chunk => chunk.stale && volumetricMode && !chunk.meta.volumetric && farLodMode, budget) || deferred;
    for (const c of cascade) {
      const lvlMat = cascadeMaterial(c.level);
      const tLvl = performance.now();
      for (const child of c.system.group.children) {
        if (!child.isMesh || !child.userData.terrainChunk) continue;
        colorizeGeometry(child.geometry);
        child.material = lvlMat;
      }
      lastColorizeMs += performance.now() - tLvl;
      let cb = cascadeBatchers.get(c.system);
      if (!cb) { cb = { batcher: createChunkBatcher({ material: lvlMat, name: `base-game-terrain-lod-${c.level}-batches`, slots: 64, vertices: 200_000, indices: 600_000, perObjectFrustumCulled: cfg.batchFrustumCulled }), batched: new Map() }; cascadeBatchers.set(c.system, cb); c.group.add(cb.batcher.group); }
      cb.batcher.setMaterial(lvlMat);
      deferred = syncBatches(c.system, cb.batcher, cb.batched, () => false, budget) || deferred;
    }
    lastBatchMs = performance.now() - tBatch;
    return deferred;
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
    tileCover.setSeaLevel(level);
    fieldWindow()?.clear();          // cover was derived against the old waterline
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
    fieldsReady: (x, z) => fieldWindow()?.ready(x, z) === true,
    acquireContactField,
    get contactField() { return contactWindow(); },
    contactHeightAt,
    contactReady: (x, z) => contactWindow()?.ready(x, z) === true,
    biomeAt, biomeIdAt, moistureAt, treeDensityAt, surfaceFieldAt, coverAt,
    get tileCover() { return tileCover; },
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
      tileCover.setSplatCfg(material?.userData?.streamedSplat?.cfg ?? null);
      fieldWindow()?.clear();        // cover is reconciled against these weights
      for (const m of splatInstances.values()) m.dispose();
      splatInstances.clear();
      applyMaterials();
    },
    // Live tuning for every splat instance at once.
    updateSplat(patch) { if (splatMaterial) updateStreamedSplat(splatMaterial, patch); for (const m of splatInstances.values()) updateStreamedSplat(m, patch); },
    get lodCoverage() { return { exact: coverExact, levels: coverLevels }; },
    setSplatWater,
    setSplatRain,
    setSplatEnabled(value) { splatEnabled = !!value; applyMaterials(); },
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
      seaDepth.setSource(system.source);
      fieldWindow()?.setSource(system.source, system.source.descriptor);
      contactWindow()?.setSource(system.source, system.source.descriptor);
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

    // Per frame with the player's GLOBAL position; streaming focus never uses render-local coords.
    update(globalPosition, dt = 0) {
      if (!active) return false;
      const t0 = performance.now();
      const changed = system.update(globalPosition[0], globalPosition[2]);
      const size = system.params.chunkSize;
      const focusMoved = Math.floor(globalPosition[0] / size) !== Math.floor(colliderFocus[0] / size) || Math.floor(globalPosition[2] / size) !== Math.floor(colliderFocus[1] / size);
      colliderFocus[0] = globalPosition[0]; colliderFocus[1] = globalPosition[2];
      // Crossing a chunk boundary changes which chunks want colliders; the fold block below is the
      // one place that rebuilds them, so it only has to be told there is work.
      if (focusMoved && volumetricMode) colliderPending = true;
      lastUpdateMs = performance.now() - t0;
      const near = system.takeInstallCost();
      lastInstallMs = near.ms;
      lastInstallCount = near.count;
      for (const c of cascade) {
        const far = c.system.takeInstallCost();
        lastInstallMs += far.ms;
        lastInstallCount += far.count;
      }
      const resident = system.chunks.size;
      if (resident > lastResident) { perSecond.installs += resident - lastResident; installedTotal += resident - lastResident; }
      lastResident = resident;
      perSecond.window += dt;
      if (perSecond.window >= 1) { perSecond.rate = perSecond.installs / perSecond.window; perSecond.installs = 0; perSecond.window = 0; }
      lastFoldMs = lastColorizeMs = lastBatchMs = lastColliderMs = 0;
      // Budgeted, and resumed on later frames: a burst of arrivals is spread instead of landing
      // as one 20-35 ms hitch. Deferred chunks keep drawing their own mesh meanwhile.
      if (changed || foldPending || colliderPending) {
        const tFold = performance.now();
        foldPending = applyMaterials(cfg.maxFoldsPerUpdate);
        const tColl = performance.now();
        colliderPending = syncVolumeColliders(cfg.maxColliderRebuildsPerUpdate);
        lastColliderMs = performance.now() - tColl;
        lastFoldMs = performance.now() - tFold;
      }
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
        if (cascadeChanged) applyMaterials();
        lastClipmapMs = performance.now() - t1;
      }
      const tField = performance.now();
      const fw = fieldWindow(), cw = contactWindow();
      if (fw) fw.update(globalPosition[0], globalPosition[2]);
      if (cw) cw.update(globalPosition[0], globalPosition[2]);
      if (fw || cw) fieldScheduler.pump();
      if (changed || cascadeChanged) residencyRevision++;   // which chunks exist moved; anything baked over them is stale
      updateCoverage(globalPosition, dt, changed || cascadeChanged);
      lastFieldMs = performance.now() - tField;
      if (handoffPending && volumeProvider.hasChunk(chunkKeyAt(globalPosition[0], globalPosition[2]))) {
        handoffPending = false;
        handoffDone = true;
        applyProviders();
      }
      if (changed && tileBounds) refreshTileBounds();
      if (collisionDebug) {
        const hit = provider.groundProbe({ origin: [globalPosition[0], globalPosition[1] + 0.5, globalPosition[2]], maxDistance: 50, slopeLimitCos: -1 });
        contactMarker.visible = !!hit && visible;
        if (hit) contactMarker.position.set(hit.point[0], hit.point[1], hit.point[2]);
      }
      return changed;
    },

    // Per-frame cost split, cheap enough to read every frame (stats is not).
    get frameCost() {
      return {
        installMs: lastInstallMs, foldMs: lastFoldMs, fieldMs: lastFieldMs, installCount: lastInstallCount,
        colorizeMs: lastColorizeMs, batchMs: lastBatchMs, colliderMs: lastColliderMs,
      };
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
        batches: batcher.stats,
        farLod: !farLodMode ? null
          : volumetricMode
            ? { kind: 'volume-cascade', levels: cascade.map(c => ({ level: c.level, chunkSize: c.spec.chunkSize, spacing: +(c.spec.chunkSize / c.spec.segments).toFixed(2), resident: c.system.chunks.size, target: c.system.targetChunkCount, inFlight: c.system.inFlight.size, lastSourceError: c.system.lastSourceError ?? null })), outerHalfExtent: cascadeExtent(), triangles: cascade.reduce((n, c) => { for (const ch of c.system.group.children) if (ch.isMesh && ch.visible && ch.geometry.index) n += ch.geometry.index.count / 3; const cb = cascadeBatchers.get(c.system); if (cb) for (const chunk of cb.batched.values()) { const idx = chunk.mesh?.geometry.index; if (idx) n += idx.count / 3; } return n; }, 0), draws: cascade.reduce((n, c) => { n += c.system.group.children.filter(ch => ch.isMesh && ch.visible).length; const cb = cascadeBatchers.get(c.system); return n + (cb ? cb.batcher.drawCount : 0); }, 0), lastUpdateMs: +lastClipmapMs.toFixed(2) }
            : clipmap ? { kind: 'clipmap', ...clipmap.stats, lastUpdateMs: +lastClipmapMs.toFixed(2) } : null,
        debug: { wireframe, normals, tileBounds, collisionDebug },
      };
    },

    dispose() {
      stopRebase();
      for (const handle of fieldHandles) handle.release();
      fieldHandles.clear();
      for (const handle of contactHandles) handle.release();
      contactHandles.clear();
      fieldRegistry.dispose();
      fieldScheduler.dispose();
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
