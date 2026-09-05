// base-game-structures-page.js — the scattered eco-brutalist buildings on the page: the same
// streamed collider the room server runs (base-game-structure-collision.js, on the terrain's
// own plan window and ground), dressed the way the spawn building is (one instanced mesh per
// material bucket per 32 m cell, cast concrete), one child group per resident tile under a root
// the render-origin rebase shifts like the spawn building's.
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { instancedBoxes, clearBoxes } from './map-boxes.js';
import { createConcreteMaterial } from './concrete-material.js';
import { createStructureCollision } from './base-game-structure-collision.js';
import { clearanceAgainstRects, structureStampPaths } from './base-game-structures.js';
import { SPAWN_BUILDING_CHUNK, SPAWN_CONCRETE_WALL, SPAWN_CONCRETE_COVER } from './base-game-spawn-building.js';

export function createBaseGameStructures({ THREE, scene, worldQuery, terrain, renderer = null, camera = null, materials: shared = null, seaLevel = () => 0, seed = 1, spacing = 480, chunk = SPAWN_BUILDING_CHUNK, collision: collisionOptions = {} }) {
  if (!scene?.add) throw new TypeError('structures require a Three.js scene');
  if (!worldQuery?.registerProvider) throw new TypeError('structures require a world-query service');
  if (!terrain?.acquirePlan) throw new TypeError('structures need the terrain plan window');

  const root = new THREE.Group();
  root.name = 'structures';   // the visor sweep's default heat is a structure's
  scene.add(root);

  // Materials are shared with the spawn building when the page passes them: it is on screen from
  // the first frame, so its pipelines (main and shadow pass) are compiled before any scattered
  // tile is, and a structure seen for the first time costs no compile. Own materials otherwise.
  const own = !shared;
  const wallMat = shared?.wall ?? createConcreteMaterial({ THREE, color: 0x9c9e9a, block: SPAWN_CONCRETE_WALL });
  const coverMat = shared?.cover ?? createConcreteMaterial({ THREE, color: 0x8f918c, block: SPAWN_CONCRETE_COVER });
  const barMat = shared?.bar ?? new MeshStandardNodeMaterial({ color: 0xd6d9dc, roughness: 0.45, metalness: 0.5 });
  const soilMat = shared?.soil ?? new MeshStandardNodeMaterial({ color: 0x2a2319, roughness: 1.0, metalness: 0.0 });
  const waterMat = shared?.water ?? new MeshStandardNodeMaterial({ color: 0x1b3a2e, roughness: 0.06, metalness: 0.6, transparent: true, opacity: 0.86 });
  const materials = [wallMat, coverMat, barMat, soilMat, waterMat];
  const BUCKET_MATERIAL = { walls: wallMat, plinth: wallMat, ground: wallMat, covers: coverMat, bars: barMat, soil: soilMat, water: waterMat };

  // The plan window is held for as long as this exists: trails hold it too, but structures must
  // place without them.
  const releasePlan = terrain.acquirePlan();

  // Pipeline warmup: one instance per material, compiled off-screen through the non-blocking
  // path, so the first tile that comes into view does not stall the main thread on a compile.
  // The spawn building normally covers this by being visible; this covers the rooms without one.
  const warmup = { done: false, ms: 0 };
  async function warm() {
    if (!renderer?.compileAsync || !camera) return;
    const group = new THREE.Group();
    const t0 = performance.now();
    for (const mat of materials) instancedBoxes(group, mat, [{ x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 }]);
    scene.add(group);
    try { await renderer.compileAsync(group, camera, scene); }
    finally { clearBoxes(group); scene.remove(group); warmup.ms = performance.now() - t0; warmup.done = true; }
  }
  warm().catch(() => { warmup.done = true; });
  // Cover keep-out: every resident building's floor rects, for the field derive (tiles arriving
  // after a building) and for the stamp over resident posts (a building arriving after a tile).
  const floorRects = new Map();    // tile key -> rects
  const clearanceAt = (x, z) => {
    let clear = 1;
    for (const rects of floorRects.values()) { clear = Math.min(clear, clearanceAgainstRects(rects, x, z)); if (clear === 0) break; }
    return clear;
  };
  terrain.setStructureClearance?.(clearanceAt);
  let stampWrites = 0;
  function stamp(tile) {
    const fields = terrain.fields;
    if (!fields?.stampAlong) return 0;
    let writes = 0;
    for (const { path, reach } of structureStampPaths(tile.model, {}, tile.keepOut)) {
      writes += fields.stampAlong(['coverGrass', 'coverPlant', 'coverTree'], path, reach, (x, z, value) => Math.round(value * clearanceAt(x, z)));
    }
    stampWrites += writes;
    return writes;
  }
  let collision = null;
  let enabled = true;
  let dressedVersion = -1;
  let version = 0;                 // bumps when a tile's meshes are added or removed
  const groups = new Map();        // tile key -> THREE.Group
  const stats = { tiles: 0, built: 0, scattered: 0, meshes: 0, collisionTriangles: 0, buildMs: 0, stampWrites: 0 };

  function makeCollision() {
    collision?.dispose();
    collision = createStructureCollision(
      { heightAt: (x, z) => terrain.groundHeight(x, z), descriptor: terrain.source?.descriptor ?? null },
      { worldQuery, heightAt: (x, z) => terrain.groundHeight(x, z), seaLevel: seaLevel(), seed, spacing, plan: () => terrain.plan, ...collisionOptions },
    );
    collision.provider.enabled = enabled;
    dressedVersion = -1;
  }
  makeCollision();

  const toBox = (r) => ({ x: r.x, y: r.y + r.h / 2, z: r.z, w: r.w, h: r.h, d: r.d });
  function emit(group, mat, boxes) {
    if (!boxes.length) return 0;
    if (!(chunk > 0)) { instancedBoxes(group, mat, boxes); return 1; }
    const cells = new Map();
    for (const b of boxes) {
      const key = `${Math.floor(b.x / chunk)}:${Math.floor(b.z / chunk)}`;
      let list = cells.get(key); if (!list) cells.set(key, (list = [])); list.push(b);
    }
    for (const list of cells.values()) instancedBoxes(group, mat, list);
    return cells.size;
  }
  function dress(key, tile) {
    const group = new THREE.Group();
    group.name = `structure-${tile.structure.kind}-${key}`;
    let meshes = 0;
    for (const [bucket, list] of Object.entries(tile.model.boxes)) meshes += emit(group, BUCKET_MATERIAL[bucket], list.map(toBox));
    if (tile.scatter) {
      // The bot viewer's kinds in the same concrete: walls, slabs, ramps and foundations as the
      // walls, covers as the covers (the heavier weathering).
      const sc = tile.scatter.boxes;
      meshes += emit(group, wallMat, [...sc.walls, ...sc.slabs, ...sc.foundations].map(toBox));
      meshes += emit(group, coverMat, sc.covers.map(toBox));
      meshes += emit(group, wallMat, tile.scatter.ramps);   // already centre-form, with a tilt
    }
    root.add(group);
    groups.set(key, group);
    stats.meshes += meshes;
    floorRects.set(key, tile.keepOut);
    stamp(tile);
  }
  function undress(key) {
    const group = groups.get(key);
    if (!group) return;
    stats.meshes -= group.children.length;
    clearBoxes(group);
    root.remove(group);
    groups.delete(key);
    floorRects.delete(key);   // resident posts keep their zero until their tile re-derives
  }
  // Meshes follow the collider's tiles: one dress per newly built tile, one teardown per drop.
  function reconcile() {
    if (collision.version === dressedVersion) return;
    dressedVersion = collision.version;
    for (const [key, tile] of collision.tiles) if (!tile.empty && !groups.has(key)) dress(key, tile);
    for (const key of [...groups.keys()]) if (!collision.tiles.has(key) || collision.tiles.get(key).empty) undress(key);
    const s = collision.stats();
    stats.tiles = s.tiles; stats.built = s.built; stats.scattered = s.scattered; stats.collisionTriangles = s.triangles; stats.buildMs = s.buildMs; stats.stampWrites = stampWrites;
    version++;
  }

  return {
    root,
    materials,           // for the page's rain decorator (the spawn building's when shared)
    ownMaterials: own,
    warmup,
    stats,
    get collision() { return collision; },
    get version() { return version; },
    clearanceAt,
    get enabled() { return enabled; },
    // Global positions ([x, y, z]); the plan window is driven by the terrain's own update.
    update(positions) {
      if (!enabled) return;
      collision.ensure(positions);
      reconcile();
    },
    setEnabled(on) {
      enabled = !!on;
      root.visible = enabled;
      collision.provider.enabled = enabled;
    },
    // A new source or a new seed: everything placed is wrong now.
    reset({ seed: nextSeed = seed, spacing: nextSpacing = spacing } = {}) {
      seed = nextSeed; spacing = nextSpacing;
      for (const key of [...groups.keys()]) undress(key);
      makeCollision();
      version++;
    },
    // What stands near a point, for readouts and the spawn picker.
    nearest(x, z) {
      let best = null, bestD = Infinity;
      for (const t of collision.tiles.values()) {
        if (t.empty) continue;
        const d = Math.hypot(t.structure.x - x, t.structure.z - z);
        if (d < bestD) { bestD = d; best = t; }
      }
      return best ? { tile: best, distance: bestD } : null;
    },
    dispose() {
      for (const key of [...groups.keys()]) undress(key);
      collision?.dispose();
      terrain.setStructureClearance?.(null);
      releasePlan();
      if (own) for (const m of materials) m.dispose();
      scene.remove(root);
    },
  };
}
