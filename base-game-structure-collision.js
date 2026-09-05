// base-game-structure-collision.js — the scattered eco-brutalist buildings as one streamed
// world-query provider. Used by the room server and by the page's prediction, so a wall is solid
// in the same place on both sides. Built on the pattern terrain-volume-collision.js uses for
// caves: one stable provider, one collider per resident tile, an ensure(positions) step that
// builds nearest-first under a per-call cap and drops tiles outside the keep ring.
//
// Sites come from the world plan (base-game-sites.js). A host that already holds a plan window
// (the page) passes `plan: () => window`; otherwise this module runs its own CPU-only plan window
// on the source, the way test-base-game-plan.mjs does, pumped from ensure().
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createFieldScheduler } from './terrain-field-scheduler.js';
import { createFieldWindow } from './terrain-field-window.js';
import { createChunkMeshWorldQueryProvider } from './world-query-chunk-mesh-provider.js';
import { buildSpawnBuildingGeometry } from './base-game-spawn-collider.js';
import { BASE_GAME_PLAN_DEFAULTS, createPlanWalkDerive } from './base-game-plan.js';
import { STRUCTURE_DEFAULTS, structuresForTile, createStructureModel, structureNavRects, structureBounds, structureKey, structureFloorRects, scatterForStructure } from './base-game-structures.js';

export const STRUCTURES_PROVIDER_ID = 'structures';
export const STRUCTURE_COLLISION_DEFAULTS = Object.freeze({
  coverRadius: 1,        // tiles around each position that must be built (480 m tiles: 1.4 km square)
  keepRadius: 2,         // tiles kept before a built tile is dropped
  maxBuildsPerCall: 1,   // a building is one BVH bake; one per tick keeps the room responsive
  planTilesPerSide: 6,   // the private plan window, when the host has none: 2.9 km, ~180 posts a side
  maxTrianglesPerChunk: 60_000,
});

// A box (y = base) or a rotated centre-form box (a ramp) as collision geometry.
function boxGeometry(b, centred = false) {
  const g = new THREE.BoxGeometry(b.w, b.h, b.d);
  if (b.rx) g.rotateX(b.rx);
  if (b.ry) g.rotateY(b.ry);
  if (b.rz) g.rotateZ(b.rz);
  g.translate(b.x, centred ? b.y : b.y + b.h / 2, b.z);
  return g;
}

export function createStructureCollision(source, {
  worldQuery = null, heightAt = null, seaLevel = 0, seed = STRUCTURE_DEFAULTS.seed, spacing = STRUCTURE_DEFAULTS.spacing,
  plan = null, priority = 100, chance = STRUCTURE_DEFAULTS.chance, scatter: scatterOptions = null, ...options
} = {}) {
  const cfg = { ...STRUCTURE_COLLISION_DEFAULTS, ...options };
  const groundAt = heightAt ?? ((x, z) => source.heightAt(x, z));
  const provider = createChunkMeshWorldQueryProvider({ id: STRUCTURES_PROVIDER_ID, priority, surfaceType: 'structure', maxTrianglesPerChunk: cfg.maxTrianglesPerChunk });
  const unregister = worldQuery ? worldQuery.registerProvider(provider) : null;

  // A private plan window when the host has none. Created lazily so a host that only reads
  // `structuresForTile` through its own plan never pays for a scheduler.
  let ownPlan = null, ownScheduler = null, ownRelease = null;
  function openOwnPlan() {
    if (ownPlan || plan) return;
    const walk = createPlanWalkDerive({ seaLevel });
    ownScheduler = createFieldScheduler({ useWorker: false, maxInFlight: 64, syncBudgetMs: 8 });
    ownPlan = createFieldWindow({
      source, descriptor: source.descriptor ?? null, scheduler: ownScheduler, gpu: false, label: 'structures-plan',
      fields: ['heights', 'biomeIds', 'planWalk'], derived: ['planWalk'], derive: walk.derive,
      post: BASE_GAME_PLAN_DEFAULTS.post, tileIntervals: BASE_GAME_PLAN_DEFAULTS.tileIntervals,
      tilesPerSide: cfg.planTilesPerSide, maxRequestsPerUpdate: 64,
    });
    ownRelease = ownPlan.acquire();
  }
  const currentPlan = () => (plan ? plan() : ownPlan);

  const tiles = new Map();     // key -> { tx, tz, structure|null, model|null, navRects, bounds, empty }
  let version = 0;             // bumps when a tile is added or dropped; the NPC bake watches it
  let buildMsTotal = 0;
  const tileIndex = (v) => Math.floor(v / spacing);
  const keyOf = (tx, tz) => structureKey(tx, tz);

  // Build one tile: null while its plan tile is not resident (try again next call), true when
  // something was placed, false when the tile is settled empty.
  function build(tx, tz) {
    const p = currentPlan();
    if (!p) return null;
    const list = structuresForTile(seed, tx, tz, p, { spacing, chance });
    if (list == null) return null;
    const key = keyOf(tx, tz);
    if (!list.length) { tiles.set(key, { tx, tz, structure: null, model: null, navRects: [], bounds: null, empty: true }); version++; return false; }
    const t0 = performance.now();
    const structure = list[0];
    const model = createStructureModel(structure, groundAt, { seaLevel });
    // The bot viewer's kinds around the anchor, seated on the same ground. `scatter: false` is
    // the anchor alone.
    const scatter = scatterOptions === false ? null : scatterForStructure(structure, model.radius, groundAt, { seaLevel, ...(scatterOptions || {}) });
    const parts = [...buildSpawnBuildingGeometry(model).values()];
    if (scatter) {
      for (const list of Object.values(scatter.boxes)) for (const b of list) parts.push(boxGeometry(b));
      for (const r of scatter.ramps) parts.push(boxGeometry(r, true));
    }
    const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (parts.length > 1) for (const g of parts) g.dispose();
    if (!geometry) throw new Error(`Could not merge structure geometry for tile ${key}`);
    geometry.computeBoundingBox();
    provider.setChunk(key, geometry, { sourceVersion: source.descriptor?.sourceVersion ?? null });
    const bb = geometry.boundingBox;
    tiles.set(key, {
      tx, tz, structure, model, scatter, empty: false, buildMs: performance.now() - t0,
      navRects: [...structureNavRects(model), ...(scatter ? scatter.navRects : [])],
      keepOut: [...structureFloorRects(model), ...(scatter ? scatter.keepOut : [])],
      bounds: { minX: bb.min.x, maxX: bb.max.x, minZ: bb.min.z, maxZ: bb.max.z },
    });
    buildMsTotal += performance.now() - t0;
    version++;
    return true;
  }

  // Positions are [x, y, z]. The private plan window follows their centroid.
  function ensure(positions) {
    if (!positions.length) return 0;
    if (!plan) openOwnPlan();
    if (ownPlan) {
      let x = 0, z = 0;
      for (const p of positions) { x += p[0]; z += p[2]; }
      ownPlan.update(x / positions.length, z / positions.length);
      ownScheduler.pump();
    }
    const wanted = [];
    const keep = new Set();
    for (const p of positions) {
      const cx = tileIndex(p[0]), cz = tileIndex(p[2]);
      for (let dz = -cfg.keepRadius; dz <= cfg.keepRadius; dz++) for (let dx = -cfg.keepRadius; dx <= cfg.keepRadius; dx++) keep.add(keyOf(cx + dx, cz + dz));
      for (let dz = -cfg.coverRadius; dz <= cfg.coverRadius; dz++) for (let dx = -cfg.coverRadius; dx <= cfg.coverRadius; dx++) {
        const tx = cx + dx, tz = cz + dz;
        if (!tiles.has(keyOf(tx, tz))) wanted.push({ tx, tz, d: dx * dx + dz * dz });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    let built = 0;
    for (const w of wanted) {
      if (built >= cfg.maxBuildsPerCall) break;
      if (build(w.tx, w.tz) === true) built++;
    }
    for (const [key, t] of [...tiles]) if (!keep.has(key)) { if (!t.empty) provider.removeChunk(key); tiles.delete(key); version++; }
    return built;
  }

  // Structures whose footprint (plus margin) touches an XZ box. What the NPC zone bake asks for.
  function within(box, margin = 0) {
    const out = [];
    for (const t of tiles.values()) {
      if (t.empty) continue;
      const b = t.bounds;
      if (b.maxX + margin < box.minX || b.minX - margin > box.maxX || b.maxZ + margin < box.minZ || b.minZ - margin > box.maxZ) continue;
      out.push(t);
    }
    return out;
  }
  function navRectsWithin(box) {
    const out = [];
    for (const t of within(box)) out.push(...t.navRects);
    return out;
  }

  return {
    provider, seed, spacing, chance, scatterOptions,
    get version() { return version; },
    get planCoverage() { const p = currentPlan(); return p ? p.coverage : 0; },
    get plan() { return currentPlan(); },
    get tileCount() { return tiles.size; },
    get builtCount() { let n = 0; for (const t of tiles.values()) if (!t.empty) n++; return n; },
    get scatteredCount() { let n = 0; for (const t of tiles.values()) if (t.scatter) n += t.scatter.placed.length; return n; },
    get buildMsTotal() { return buildMsTotal; },
    tiles, ensure, within, navRectsWithin,
    has: (tx, tz) => tiles.has(keyOf(tx, tz)),
    get: (tx, tz) => tiles.get(keyOf(tx, tz)) ?? null,
    stats() { return { tiles: tiles.size, built: this.builtCount, scattered: this.scatteredCount, triangles: provider.triangleCount, buildMs: buildMsTotal, version }; },
    dispose() {
      provider.clear(); tiles.clear();
      unregister?.();
      ownRelease?.(); ownPlan?.dispose(); ownScheduler?.dispose();
      ownPlan = null; ownScheduler = null;
    },
  };
}
