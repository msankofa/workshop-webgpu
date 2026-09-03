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
// The spawn-area world (the old "traversal lab" world kind): the building on a flat concrete
// ground slab at the origin, the lab's diagnostic geometry kept in the same world but 200 m east.
export const SPAWN_AREA_VERSION = 1;
export const SPAWN_AREA_GROUND = Object.freeze({ size: 480, thickness: 1 });
export const SPAWN_AREA_LAB_OFFSET = Object.freeze({ x: 200, z: 0 });
export const SPAWN_AREA_SEA_LEVEL = -1e9;   // no water in the spawn area: the datum sits on the slab
export const flatGround = () => 0;
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
  // Below the lowest ground; water above the ground is the datum's concern, not the plinth's.
  const plinthBottom = minY - (plinthDepth ?? SPAWN_BUILDING_DEFAULTS.plinthDepth);
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
  // One plinth under each floor slab, down to the lowest sampled ground: the building is an L
  // with courts between its wings, and a single plinth under its bounding box would bury the
  // terrain (and its grass) between them under concrete.
  const plinthH = site.baseY - 0.3 - site.plinthBottom;   // meets the underside of the floor slabs
  const plinths = plinthH > 1e-6
    ? layout.walls.filter((r) => r.y < 0).map((r) => ({ x: r.x, z: r.z, w: r.w, d: r.d, y: site.plinthBottom, h: plinthH }))
    : [];
  const boxes = {
    walls: layout.walls.map(lift),
    covers: layout.covers.map(lift),
    bars: layout.bars.map(lift),
    soil: layout.planters.map((q) => ({ x: q.x, z: q.z, w: q.w - 0.08, d: q.d - 0.08, y: q.y + site.baseY, h: q.depth })),
    water: layout.water.map((q) => ({ x: q.x, z: q.z, w: q.w, d: q.d, y: q.y + site.baseY, h: 0.04 })),
    plinth: plinths,
    // Flat worlds only: a concrete ground slab under everything, its top at the plinth bottom.
    ground: O.ground ? [{ x: O.x, z: O.z, w: O.ground.size, d: O.ground.size, y: site.plinthBottom - O.ground.thickness, h: O.ground.thickness }] : [],
  };
  const spawn = [layout.spawn[0], layout.spawn[1] + site.baseY, layout.spawn[2]];
  return { layout, site, boxes, spawn, radius: layout.radius, version: SPAWN_BUILDING_VERSION, options: O };
}

// Merged geometry per collision bucket. Water is not solid; everything else is.
export function buildSpawnBuildingGeometry(model) {
  const merged = new Map();
  for (const bucket of ['walls', 'covers', 'bars', 'soil', 'plinth', 'ground']) {
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

// The building's options in the flat spawn-area world: datum on the slab, no water lift.
export const SPAWN_AREA_BUILDING_OPTIONS = Object.freeze({ ground: SPAWN_AREA_GROUND, clearance: 0, plinthDepth: 0.3, seaLevel: SPAWN_AREA_SEA_LEVEL });

// The traversal lab's layout moved aside. Probes are left where the lab's own tests expect them.
export function shiftedLabLayout(layout, dx = SPAWN_AREA_LAB_OFFSET.x, dz = SPAWN_AREA_LAB_OFFSET.z) {
  return Object.freeze({
    ...layout,
    primitives: Object.freeze(layout.primitives.map((p) => Object.freeze({ ...p, cx: p.cx + dx, cz: p.cz + dz }))),
    spawn: Object.freeze([layout.spawn[0] + dx, layout.spawn[1], layout.spawn[2] + dz]),
    initialView: layout.initialView ? Object.freeze({
      camera: Object.freeze([layout.initialView.camera[0] + dx, layout.initialView.camera[1], layout.initialView.camera[2] + dz]),
      target: Object.freeze([layout.initialView.target[0] + dx, layout.initialView.target[1], layout.initialView.target[2] + dz]),
    }) : undefined,
  });
}

// The spawn-area world for the room server: building on the slab at the origin, lab 200 m east.
export async function createSpawnAreaWorldQuery(worldQuery, { labOffset = SPAWN_AREA_LAB_OFFSET } = {}) {
  const { createTraversalLabLayout } = await import('./traversal-lab-layout.js');
  const { createTraversalLabWorldQuery } = await import('./traversal-lab-collider.js');
  const lab = createTraversalLabWorldQuery(worldQuery, { layout: shiftedLabLayout(createTraversalLabLayout(), labOffset.x, labOffset.z) });
  const building = createSpawnBuildingWorldQuery(worldQuery, flatGround, SPAWN_AREA_BUILDING_OPTIONS);
  return {
    lab, building,
    spawn: [building.spawn[0], building.spawn[1] + 1.5, building.spawn[2]],
    killPlaneY: lab.layout.killPlaneY,
    // Keeps the lab's prefix: the room service and its tests identify the world kind by it.
    worldVersion: `traversal-lab-v${lab.layout.version}-spawn-area-v${SPAWN_AREA_VERSION}-bld${SPAWN_BUILDING_VERSION}`,
    dispose() { building.dispose(); lab.dispose(); },
  };
}
