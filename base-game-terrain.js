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

export const BASE_GAME_TERRAIN_DEFAULTS = Object.freeze({
  chunkSize: 30,
  renderRadius: 3,
  maxChunksPerUpdate: 2,
  maxUnloadsPerUpdate: 2,
  killPlaneBelowSurface: 80,   // metres under the local ground before the player is respawned
});

export function createBaseGameTerrain({
  scene, worldQuery, worldCoordinates, source,
  params = {}, providerId = 'terrain', volumeProviderId = 'terrain-volume', useWorker = true, volumetric = false,
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
  function syncVolumeColliders() {
    if (!volumetricMode) { if (collidedChunks.size) { volumeProvider.clear(); collidedChunks.clear(); } return; }
    for (const [key, chunk] of system.chunks) {
      if (!chunk.meta.volumetric || !chunk.mesh) continue;
      if (collidedChunks.get(key) === chunk) continue;
      volumeProvider.setChunk(key, chunk.mesh.geometry, { sourceVersion: chunk.meta.sourceVersion });
      collidedChunks.set(key, chunk);
    }
    for (const key of [...collidedChunks.keys()]) {
      if (!system.chunks.has(key)) { volumeProvider.removeChunk(key); collidedChunks.delete(key); }
    }
  }
  if (volumetric) { system.setVolumetric(true); volumetricMode = true; }

  // Chunk geometry stays global; the root carries -renderOrigin (Traversal Lab pattern).
  const root = new THREE.Group();
  root.name = 'base-game-terrain';
  root.position.fromArray(globalToRenderLocal([0, 0, 0], worldCoordinates.getOrigin()));
  root.add(system.group);
  scene.add(root);
  const stopRebase = worldCoordinates.onRebase(event => { root.position.add(new THREE.Vector3().fromArray(event.delta)); });

  // Base Game readability tint: height/slope vertex colours (sea-level sand, grass, rock on
  // steep faces, snow up high). Biome/material masks from v5 are not streamed yet.
  system.material.vertexColors = true;
  system.material.color.set(0xffffff);
  const TINT = { water: [0.16, 0.32, 0.42], sand: [0.72, 0.66, 0.46], grass: [0.30, 0.48, 0.22], dry: [0.46, 0.44, 0.28], rock: [0.42, 0.40, 0.38], snow: [0.92, 0.93, 0.95] };
  const mixInto = (out, o, a, b, t) => { out[o] = a[0] + (b[0] - a[0]) * t; out[o + 1] = a[1] + (b[1] - a[1]) * t; out[o + 2] = a[2] + (b[2] - a[2]) * t; };
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  function colorizeGeometry(geo) {
    if (geo.getAttribute('color')) return;
    const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal');
    const colors = new Float32Array(pos.count * 3);
    const c = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), ny = nrm ? nrm.getY(i) : 1;
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
  let installedTotal = 0;
  let lastResident = 0;
  const perSecond = { installs: 0, window: 0, rate: 0 };

  function applyMaterials() {
    const mat = normals ? normalMaterial : system.material;
    system.material.wireframe = wireframe;
    normalMaterial.wireframe = wireframe;
    for (const child of system.group.children) {
      if (!child.isMesh || !child.userData.terrainChunk) continue;
      colorizeGeometry(child.geometry);
      child.material = mat;
    }
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
    return [x, groundHeight(x, z) + clearance, z];
  }
  function volumeFloorY() {
    const d = system.source?.project?.density;
    return d ? d.y_min : null;
  }

  const api = {
    root,
    system,
    provider,
    get source() { return system.source; },
    get active() { return active; },
    get killPlaneBelowSurface() { return cfg.killPlaneBelowSurface; },
    groundHeight,
    spawnPosition,
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
      handoffPending = next;     // heightfield -> volume waits for the chunk; the other way is immediate
      handoffDone = !next;
      applyProviders();
      syncVolumeColliders();
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
      installedTotal = 0;
      volumetricMode = false;
      if (wantVolumetric && system.source?.densityAt) { system.params.volumetric = true; volumetricMode = true; }
      handoffPending = volumetricMode;
      handoffDone = !volumetricMode && wantVolumetric;
      applyProviders();
      syncVolumeColliders();
    },

    // Per frame with the player's GLOBAL position; streaming focus never uses render-local coords.
    update(globalPosition, dt = 0) {
      if (!active) return false;
      const t0 = performance.now();
      const changed = system.update(globalPosition[0], globalPosition[2]);
      lastUpdateMs = performance.now() - t0;
      const resident = system.chunks.size;
      if (resident > lastResident) { perSecond.installs += resident - lastResident; installedTotal += resident - lastResident; }
      lastResident = resident;
      perSecond.window += dt;
      if (perSecond.window >= 1) { perSecond.rate = perSecond.installs / perSecond.window; perSecond.installs = 0; perSecond.window = 0; }
      if (changed) { applyMaterials(); syncVolumeColliders(); }
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

    // Performance-record block: identifies the source, residency, queues, draws and timing.
    get stats() {
      let draws = 0, triangles = 0;
      if (system.group.visible) {
        for (const child of system.group.children) {
          if (!child.isMesh || !child.userData.terrainChunk || !child.visible) continue;
          draws++;
          const idx = child.geometry.index;
          triangles += idx ? idx.count / 3 : child.geometry.attributes.position.count / 3;
        }
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
        epoch: system.epoch,
        lastSourceError: system.lastSourceError ?? null,
        collisionProvider: volumetricMode
          ? { id: volumeProvider.id, enabled: volumeProvider.enabled !== false, chunks: volumeProvider.chunkCount, triangles: volumeProvider.triangleCount }
          : { id: provider.id, enabled: provider.enabled !== false, colliderId: `${info.key}@${info.version}` },
        volumetric: volumetricMode,
        debug: { wireframe, normals, tileBounds, collisionDebug },
      };
    },

    dispose() {
      stopRebase();
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
