// Renderer-free spawn building for Base Game terrain rooms: the eco-brutalist complex from
// base-game-spawn-layout.js, seated on a concrete plinth at the highest ground under its
// footprint, baked into the map-collision BVH and adapted as a world-query provider. The room
// server and the browser both build from this one path, so collision cannot drift from render.
// The site is sampled on a fixed grid from whatever heightAt the host has (the server's source,
// the page's terrain), which is the same pure source on both sides.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createMapCollider } from './map-collision.js';
import { createMapColliderWorldQueryProvider } from './world-query-map-provider.js';
import { generateEco } from './base-game-spawn-layout.js';

export const SPAWN_BUILDING_PROVIDER_ID = 'spawn-building-static';
export const SPAWN_BUILDING_VERSION = 1;
export const SPAWN_BUILDING_DEFAULTS = Object.freeze({
  kind: 'complex', seed: 1, x: 0, z: 0,
  siteStep: 4,        // m between ground samples under the footprint
  siteMargin: 2,      // m the sampled footprint extends past the floor slabs
  plinthDepth: 1.5,   // m the plinth reaches below the lowest sampled ground
  clearance: 0.05,    // m the floor datum sits above the highest sampled ground
});

// The layout's floor slabs, the concrete under every room, give the footprint.
export function spawnFootprint(layout, margin = 0) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of layout.walls) {
    if (r.y >= 0) continue;
    minX = Math.min(minX, r.x - r.w / 2); maxX = Math.max(maxX, r.x + r.w / 2);
    minZ = Math.min(minZ, r.z - r.d / 2); maxZ = Math.max(maxZ, r.z + r.d / 2);
  }
  return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
}

// Ground statistics under the footprint on a fixed grid. Identical inputs give identical
// output on the server and the page, which is what keeps the two colliders at one height.
export function spawnSite(layout, heightAt, { seaLevel = 0, siteStep, siteMargin, plinthDepth, clearance } = SPAWN_BUILDING_DEFAULTS) {
  const step = siteStep ?? SPAWN_BUILDING_DEFAULTS.siteStep;
  const fp = spawnFootprint(layout, siteMargin ?? SPAWN_BUILDING_DEFAULTS.siteMargin);
  let minY = Infinity, maxY = -Infinity, samples = 0;
  const nx = Math.max(1, Math.ceil((fp.maxX - fp.minX) / step)), nz = Math.max(1, Math.ceil((fp.maxZ - fp.minZ) / step));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const h = heightAt(fp.minX + (i / nx) * (fp.maxX - fp.minX), fp.minZ + (j / nz) * (fp.maxZ - fp.minZ));
    if (!Number.isFinite(h)) continue;
    minY = Math.min(minY, h); maxY = Math.max(maxY, h); samples++;
  }
  if (!samples) { minY = 0; maxY = 0; }
  const baseY = Math.max(maxY, seaLevel) + (clearance ?? SPAWN_BUILDING_DEFAULTS.clearance);
  const plinthBottom = Math.min(minY, seaLevel) - (plinthDepth ?? SPAWN_BUILDING_DEFAULTS.plinthDepth);
  return { footprint: fp, minY, maxY, baseY, plinthBottom, samples };
}

// Everything a host needs: the layout in building space, the site, the boxes in world space
// per material bucket (y is the base, like the layout), and the spawn point in world space.
export function createSpawnBuildingModel(heightAt, options = {}) {
  const O = { ...SPAWN_BUILDING_DEFAULTS, ...options };
  const layout = generateEco(O.kind, O.params || {}, O.seed, { x: O.x, z: O.z });
  const site = spawnSite(layout, heightAt, { seaLevel: O.seaLevel ?? 0, ...O });
  const lift = (r) => ({ ...r, y: r.y + site.baseY });
  const fp = site.footprint;
  const plinth = {
    x: (fp.minX + fp.maxX) / 2, z: (fp.minZ + fp.maxZ) / 2, w: fp.maxX - fp.minX, d: fp.maxZ - fp.minZ,
    y: site.plinthBottom, h: site.baseY - 0.3 - site.plinthBottom,   // meets the underside of the floor slabs
  };
  const boxes = {
    walls: layout.walls.map(lift),
    covers: layout.covers.map(lift),
    bars: layout.bars.map(lift),
    soil: layout.planters.map((q) => ({ x: q.x, z: q.z, w: q.w - 0.08, d: q.d - 0.08, y: q.y + site.baseY, h: q.depth })),
    water: layout.water.map((q) => ({ x: q.x, z: q.z, w: q.w, d: q.d, y: q.y + site.baseY, h: 0.04 })),
    plinth: [plinth],
  };
  const spawn = [layout.spawn[0], layout.spawn[1] + site.baseY, layout.spawn[2]];
  return { layout, site, boxes, spawn, radius: layout.radius, version: SPAWN_BUILDING_VERSION, options: O };
}

// Merged geometry per collision bucket. Water is not solid; everything else is.
export function buildSpawnBuildingGeometry(model) {
  const merged = new Map();
  for (const bucket of ['walls', 'covers', 'bars', 'soil', 'plinth']) {
    const list = model.boxes[bucket];
    if (!list.length) continue;
    const parts = list.map((r) => {
      const g = new THREE.BoxGeometry(r.w, r.h, r.d);
      g.translate(r.x, r.y + r.h / 2, r.z);
      return g;
    });
    const geometry = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!geometry) throw new Error(`Could not merge spawn building bucket: ${bucket}`);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    merged.set(bucket, geometry);
  }
  return merged;
}

export function createSpawnBuildingCollider(heightAt, { priority = 100, ...options } = {}) {
  const model = createSpawnBuildingModel(heightAt, options);
  const root = new THREE.Group();
  root.name = 'base-game-spawn-building';
  const meshes = [];
  for (const [bucket, geometry] of buildSpawnBuildingGeometry(model)) {
    const mesh = new THREE.Mesh(geometry);
    mesh.name = `spawn-building-${bucket}`;
    mesh.userData.bucket = bucket;
    root.add(mesh);
    meshes.push(mesh);
  }
  const collider = createMapCollider(root, { maxTriangles: 50_000 });
  const provider = createMapColliderWorldQueryProvider(collider, { id: SPAWN_BUILDING_PROVIDER_ID, priority, enabled: true });
  return {
    model, root, meshes, collider, provider,
    spawn: model.spawn,
    stats: Object.freeze({ boxes: Object.values(model.boxes).reduce((n, l) => n + l.length, 0), collisionTriangles: collider.triangleCount }),
    dispose() { collider.dispose(); for (const m of meshes) m.geometry.dispose(); },
  };
}

// For hosts that only need queries (the room server): a registered provider, ready to go.
export function createSpawnBuildingWorldQuery(worldQuery, heightAt, options) {
  const building = createSpawnBuildingCollider(heightAt, options);
  const unregister = worldQuery.registerProvider(building.provider);
  return { ...building, dispose() { unregister(); building.dispose(); } };
}
