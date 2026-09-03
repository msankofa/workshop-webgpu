// base-game-spawn-building.js -- the eco-brutalist spawn building in the Base Game page: the
// shared collider (base-game-spawn-collider.js) registered as a world-query provider, dressed
// with chunked instanced boxes in cast concrete. One instanced mesh per bucket per cell, so the
// renderer's per-object frustum test skips the rooms behind the camera in the main and shadow
// passes. Materials are exposed for the page's rain decorator; heat tags come from the page's
// visor sweep (the root is named for it).
//
// Usage:
//   const building = createBaseGameSpawnBuilding({ THREE, scene, worldQuery, heightAt, seaLevel });
//   building.setVisible(settings.worldMode === 'terrain');
//   building.rebuild(heightAt, seaLevel);      // when the terrain source changes
//   playerController.reset(building.spawn);
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { instancedBoxes, clearBoxes } from './map-boxes.js';
import { createConcreteMaterial } from './concrete-material.js';
import { createSpawnBuildingCollider } from './base-game-spawn-collider.js';
import { soilTopAt } from './base-game-spawn-layout.js';
import { rasterizeGrowth } from './bot-flora-place.js';

// The planters as a biome for the base game's compute grass: over the building's footprint,
// density 1 inside a planter and 0 everywhere else (no grass through the floors), height the
// soil top in global metres. Nearest-filtered so a rim is a hard edge and blades never climb it.
function buildFloraStructure(THREE, model, texel = 0.25) {
  const fp = model.site.footprint, baseY = model.site.baseY;
  const planters = model.layout.planters;
  const soil = (x, z) => { const t = soilTopAt(planters, x, z); return t == null ? null : t + baseY; };
  const raster = rasterizeGrowth({
    padded: fp, texel, index: null,
    clearFn: (x, z) => soil(x, z) == null,
    groundHeight: (x, z) => soil(x, z) ?? baseY,
  });
  const mk = (arr) => {
    const t = new THREE.DataTexture(arr, raster.res, raster.res, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  };
  return { bounds: raster.bounds, densityTex: mk(raster.density), heightTex: mk(raster.height), growArea: raster.growArea, dispose() { this.densityTex.dispose(); this.heightTex.dispose(); } };
}

export const SPAWN_BUILDING_CHUNK = 32;   // m per instanced-mesh cell

// Occupied building, not a ruin: panels and tie holes on, growth low.
export const SPAWN_CONCRETE_WALL = Object.freeze({
  gain: 1.0, panelW: 2.4, panelH: 1.8, seamWidth: 0.018, seamDark: 0.42,
  boardPitch: 0.22, boardWidth: 0.01, boardGain: 0.25, boardToneVar: 0.06,
  tieGain: 0.45, tieRadius: 0.032, tieH: 1.2, tieV: 0.9,
  grainGain: 0.30, mottleGain: 0.18,
  stainColor: 0x4d5150, stainGain: 0.3, stainLength: 0.55,
  mossColor: 0x4a6b32, mossGain: 0.35,
  algaeGain: 0.3, algaeHeight: 0.18,
});
export const SPAWN_CONCRETE_COVER = Object.freeze({
  ...SPAWN_CONCRETE_WALL, panelW: 1.6, panelH: 1.2, mossGain: 0.7, algaeGain: 0.5, algaeHeight: 0.3,
});

export function createBaseGameSpawnBuilding({ THREE, scene, worldQuery, heightAt, seaLevel = 0, chunk = SPAWN_BUILDING_CHUNK, options = {} }) {
  if (!scene?.add) throw new TypeError('spawn building requires a Three.js scene');
  if (!worldQuery?.registerProvider) throw new TypeError('spawn building requires a world-query service');

  const root = new THREE.Group();
  root.name = 'spawn-building';   // the visor sweep tags by name prefix; the default heat is a structure's
  scene.add(root);

  const wallMat = createConcreteMaterial({ THREE, color: 0x9c9e9a, block: SPAWN_CONCRETE_WALL });
  const coverMat = createConcreteMaterial({ THREE, color: 0x8f918c, block: SPAWN_CONCRETE_COVER });
  const barMat = new MeshStandardNodeMaterial({ color: 0xd6d9dc, roughness: 0.45, metalness: 0.5 });
  const soilMat = new MeshStandardNodeMaterial({ color: 0x2a2319, roughness: 1.0, metalness: 0.0 });
  const waterMat = new MeshStandardNodeMaterial({ color: 0x1b3a2e, roughness: 0.06, metalness: 0.6, transparent: true, opacity: 0.86 });
  const materials = [wallMat, coverMat, barMat, soilMat, waterMat];
  const BUCKET_MATERIAL = { walls: wallMat, plinth: wallMat, covers: coverMat, bars: barMat, soil: soilMat, water: waterMat };

  let building = null, unregister = null, visible = true, floraStructure = null;
  const stats = { chunks: 0, boxes: 0, collisionTriangles: 0, baseY: 0, planterArea: 0 };

  const toBox = (r) => ({ x: r.x, y: r.y + r.h / 2, z: r.z, w: r.w, h: r.h, d: r.d });
  function emit(mat, boxes) {
    if (!boxes.length) return;
    if (!(chunk > 0)) { instancedBoxes(root, mat, boxes); stats.chunks++; return; }
    const cells = new Map();
    for (const b of boxes) {
      const key = `${Math.floor(b.x / chunk)}:${Math.floor(b.z / chunk)}`;
      let list = cells.get(key); if (!list) cells.set(key, (list = [])); list.push(b);
    }
    for (const list of cells.values()) { instancedBoxes(root, mat, list); stats.chunks++; }
  }

  function build(heightFn, sea) {
    teardown();
    building = createSpawnBuildingCollider(heightFn, { seaLevel: sea, ...options });
    unregister = worldQuery.registerProvider(building.provider);
    building.provider.enabled = visible;
    stats.chunks = 0;
    for (const [bucket, list] of Object.entries(building.model.boxes)) emit(BUCKET_MATERIAL[bucket], list.map(toBox));
    stats.boxes = building.stats.boxes;
    stats.collisionTriangles = building.stats.collisionTriangles;
    stats.baseY = building.model.site.baseY;
    floraStructure = buildFloraStructure(THREE, building.model);
    stats.planterArea = floraStructure.growArea;
    root.visible = visible;
  }
  function teardown() {
    if (unregister) { unregister(); unregister = null; }
    if (building) { building.dispose(); building = null; }
    if (floraStructure) { floraStructure.dispose(); floraStructure = null; }
    clearBoxes(root);
  }

  build(heightAt, seaLevel);

  return {
    root,
    materials,           // for the page's rain decorator
    get model() { return building?.model ?? null; },
    get spawn() { return building ? building.spawn : [0, 0, 0]; },
    get provider() { return building?.provider ?? null; },
    // For base-game-flora.js's setStructure: the planters as painted density and height textures.
    get floraStructure() { return floraStructure; },
    stats,
    rebuild(heightFn, sea = seaLevel) { seaLevel = sea; build(heightFn, sea); },
    setVisible(on) {
      visible = !!on;
      root.visible = visible;
      if (building) building.provider.enabled = visible;
    },
    // Ground under (x, z) inside the footprint: the plinth top or the floor datum, else null.
    footprintContains(x, z) {
      const fp = building?.model.site.footprint;
      return !!fp && x >= fp.minX && x <= fp.maxX && z >= fp.minZ && z <= fp.maxZ;
    },
    dispose() {
      teardown();
      for (const m of materials) m.dispose();
      scene.remove(root);
    },
  };
}
