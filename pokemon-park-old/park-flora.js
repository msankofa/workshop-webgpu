// Grass, trees and boulders on the park's own ground.

import { PARK_TREE_DENSITY, PARK_GRASS_DENSITY, PARK_BIOMES } from './park-biomes.js';
import { buildParkTreeTable, applyMeasuredHeights } from './park-trees.js';
import { EZ_TREE_FAMILIES } from './tree-presets.js';

export const FLORA_DEFAULTS = Object.freeze({
  chunkSize: 75,
  masterSeed: 20260616,

  grass: true,
  grassDensity: 7.0,
  grassRadius: 150,
  grassCullStart: 100,
  // NOT 600. See the header.
  grassMaxRadius: 160,
  grassMaxBlades: 600000,
  grassBladeHeight: 0.9,
  grassBladeWidth: 4.0,
  // grass-look.js features. All off, which is the legacy graph exactly. `curlNormal` and
  // `translucency` replace or add to the lit normal, and turning them on blind gave a field lit in
  // patches; they are panel toggles now rather than defaults.
  grassLook: {
    windDir: false, windAngle: 35, windFlutter: 0.45,
    curl: false, curlAmount: 0.85, curlNormal: 0.0,
    translucency: false, translucencyAmount: 0.45,
    rootShade: false, rootShadeAmount: 0.35,
    coverage: false, coverageAmount: 0.55, coverageScale: 0.045, coverageEdge: 0.3,
  },

  forest: true,
  // Park-wide, divided by the total chunk count before use.
  treeCount: 40000,
  treeLodR0: 60, treeLodR1: 140, treeLodR2: 300,
  treeCapPerVariant: 1024,
  treeVariantsPerSpecies: 2,
  treeSizeVar: 0.6,
  // 'authored' loads the bark set and the four leaf PNGs. Without them the ez species render as
  // their flat vertex colour, and three of the four families authored that colour as white.
  treeTextures: 'authored',
  texDir: './textures',
  texWaitMs: 9000,
  treeRadiusChunks: 5,
  treeBuildBudgetMs: 2.5,
  treeChunksPerFrame: 2,
  // Every setChunks call costs a full source-buffer rebuild and upload, so chunks go up in batches.
  treeFlushChunks: 8,

  boulders: true,
  boulderDensity: 0.0016,
  boulderCullRadius: 200,
  boulderRadiusChunks: 3,
  rockBuildBudgetMs: 2.0,
  rockChunksPerFrame: 2,
  // Off by default and deliberately
  scree: false,
  screeDensity: 0.06,
  screeCullRadius: 70,
});

/** Tallest baked variant per species, in ez-tree units, measured off the geometry. */
function measureSpeciesHeights(THREE, palette) {
  const out = [];
  const box = new THREE.Box3();
  for (const variant of palette.variants) {
    let hi = -Infinity, lo = Infinity;
    for (const geo of [variant.branches, variant.leaves]) {
      if (!geo?.attributes.position.count) continue;
      geo.computeBoundingBox();
      box.copy(geo.boundingBox);
      hi = Math.max(hi, box.max.y); lo = Math.min(lo, box.min.y);
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    out[variant.speciesIdx] = Math.max(out[variant.speciesIdx] ?? 0, Math.max(0.01, hi - lo));
  }
  return out;
}

/** A `THREE.DataTexture` over a Float32Array laid out row-major, which is what these grids already are. */
function floatTexture(THREE, data, resolution) {
  const tex = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  // No colour space, deliberately: this is data, not colour. Tagging it sRGB would bend every height.
  tex.needsUpdate = true;
  return tex;
}

/** Dress the park. */
export async function createParkFlora({
  THREE, renderer, camera, scene, park, options = {}, onStatus = null, clearFn = null,
} = {}) {
  const O = { ...FLORA_DEFAULTS, ...options };
  const { grid, map } = park;
  const HALF_X = grid.worldX / 2, HALF_Z = grid.worldZ / 2;
  const bounds = { minX: -HALF_X, minZ: -HALF_Z, worldX: grid.worldX, worldZ: grid.worldZ };
  const heightAt = (x, z) => map.heightAt(x, z);
  const say = (m) => onStatus?.(m) ?? Promise.resolve();

  const meshes = [];
  const disposers = [];
  const stats = { grassBlades: 0, trees: 0, boulders: 0, treeChunks: 0, rockChunks: 0, treeSpecies: 0, treeTextures: 'flat' };

  // Chunks are clamped to the park, so nothing is ever placed outside the ground that exists.
  const CH = O.chunkSize;
  const chunkMin = { x: Math.floor(-HALF_X / CH), z: Math.floor(-HALF_Z / CH) };
  const chunkMax = { x: Math.ceil(HALF_X / CH) - 1, z: Math.ceil(HALF_Z / CH) - 1 };
  const totalChunks = (chunkMax.x - chunkMin.x + 1) * (chunkMax.z - chunkMin.z + 1);

  function chunksAround(fx, fz, radiusChunks) {
    const cx = Math.floor(fx / CH), cz = Math.floor(fz / CH);
    const out = [];
    for (let iz = Math.max(chunkMin.z, cz - radiusChunks); iz <= Math.min(chunkMax.z, cz + radiusChunks); iz++) {
      for (let ix = Math.max(chunkMin.x, cx - radiusChunks); ix <= Math.min(chunkMax.x, cx + radiusChunks); ix++) {
        const xMin = ix * CH, zMin = iz * CH;
        out.push({ key: `${ix},${iz}`, xMin, zMin, size: CH, centerX: xMin + CH / 2, centerZ: zMin + CH / 2 });
      }
    }
    return out;
  }

  // ===================== the two masks =====================

  const res = grid.resolution;
  const grassDensityGrid = new Float32Array(res * res);
  const cellX = grid.worldX / (res - 1), cellZ = grid.worldZ / (res - 1);
  for (let i = 0; i < res * res; i++) {
    let d = PARK_GRASS_DENSITY[PARK_BIOMES[map.biome[i]]] ?? 0;
    if (d > 0 && clearFn && clearFn(-HALF_X + (i % res) * cellX, -HALF_Z + Math.floor(i / res) * cellZ)) d = 0;
    grassDensityGrid[i] = d;
  }
  const treeDensityAt = clearFn
    ? (x, z) => (clearFn(x, z) ? 0 : PARK_TREE_DENSITY[map.biomeAt(x, z)] ?? 0)
    : (x, z) => PARK_TREE_DENSITY[map.biomeAt(x, z)] ?? 0;

  // ===================== grass =====================

  let grassRef = null;
  if (O.grass) {
    await say('sowing the grass');
    try {
      const { createComputeGrass } = await import('./grass-compute.js?v=mesh-anchors-1');
      // The park's own height array IS the layout `DataTexture` wants
      const heightTex = floatTexture(THREE, grid.height, res);
      const densityTex = floatTexture(THREE, grassDensityGrid, res);
      const cg = createComputeGrass({
        renderer, camera,
        heightTex, heightTexBounds: bounds,
        densityTex, densityTexBounds: bounds,
        waterLevel: grid.waterLevel, shoreMargin: 0.35,
        density: O.grassDensity,
        radius: O.grassRadius, cullStart: O.grassCullStart, maxRadius: O.grassMaxRadius,
        maxBlades: O.grassMaxBlades,
        bladeHeight: O.grassBladeHeight, bladeWidth: O.grassBladeWidth,
        grassRecull: 'cell',
        // Anchor mode samples a collider mesh per frame to plant blades on overhangs.
        surfaceGeometry: null,
        look: O.grassLook,
      });
      scene.add(cg.mesh);
      meshes.push(cg.mesh);
      grassRef = cg;
      disposers.push(() => { scene.remove(cg.mesh); heightTex.dispose(); densityTex.dispose(); cg.dispose?.(); });
    } catch (e) { console.warn('[park-flora] grass:', e.message); }
  }

  // ===================== forest =====================

  let forestGPU = null;
  let texSet = null;
  let trunkIndex = null;
  let placementRecords = null;
  const treeChunks = new Set();
  let treeQueue = [];
  let treeDensityScale = 1;
  let treeSizeScale = 1;
  let treeLeafScale = 1;
  let treeLeafDensity = 1;
  const treeChunkRecords = new Map();
  const treeChunkSpecs = new Map();
  let createTreeForForest = null;
  let createForestPaletteForPark = null;
  let createForestGPUForPark = null;
  let speciesHeightsMeasured = false;
  const biomeAt = (x, z) => map.biomeAt(x, z);

  // leafCount, leafStart and leafSpread are absent on purpose: forest-palette treats them as
  // absolutes, which flattens pine's needles and ash's sprays to one number.
  const treeSpeciesTable = buildParkTreeTable(EZ_TREE_FAMILIES);
  const trunkRadiusOf = (r) => {
    const r0 = treeSpeciesTable[r.speciesIdx]?.radius?.[0] ?? 1;
    return Math.max(0.22, r0 * r.scale * 1.35);
  };
  const FOREST_PARAMS = {
    count: O.treeCount, placement: 'random',
    maxSize: 1, sizeVar: O.treeSizeVar, skew: 0, varPattern: 'random', shoreMargin: 0.35,
    speciesTable: treeSpeciesTable,
    treeBaseOffset: -0.1, leafSize: 1.0,
    leafShadowPct: 0.3, coarseLeafRatio: 0.25, coarseLeafSizeMult: 2.5,
  };

  // Same rebuild contract used by environment-viewer: leaf size is an input to trees.js geometry
  // generation, never a post-bake transform around the tree origin. That keeps every leaf card's
  // branch-relative centre fixed while changing only the card itself.
  const scaledTreeRecords = (records) => records.map((r) => ({
    ...r,
    scale: r.scale * treeSizeScale,
  }));

  async function rebuildForestGPU() {
    if (!createTreeForForest || !createForestPaletteForPark || !createForestGPUForPark) return null;
    // Bot Viewer precedent: both controls multiply each species' authored leaves. In particular,
    // do not pass one absolute leafCount through FOREST_PARAMS; that erases the pine/ash/etc.
    // count differences which make the presets recognizable.
    const bakeTable = treeSpeciesTable.map((sp) => ({
      ...sp,
      leaves: {
        ...sp.leaves,
        count: Math.max(0, Math.round((sp.leaves?.count ?? 10) * treeLeafDensity)),
      },
    }));
    const paletteParams = {
      ...FOREST_PARAMS,
      speciesTable: bakeTable,
      leafSize: treeLeafScale,
    };
    const palette = createForestPaletteForPark({
      createTree: createTreeForForest,
      params: paletteParams,
      masterSeed: O.masterSeed,
      texSet,
      variantsPerSpecies: O.treeVariantsPerSpecies,
    });
    // Placement normalization is established by the initial authored-species bake. A later leaf
    // edit must not silently rescale whole trees (or make newly streamed chunks a different size)
    // merely because larger cards changed the palette bounding box.
    if (!speciesHeightsMeasured) {
      applyMeasuredHeights(treeSpeciesTable, measureSpeciesHeights(THREE, palette), O.treeSizeVar);
      speciesHeightsMeasured = true;
    }
    stats.treeSpecies = treeSpeciesTable.length;
    const nextForest = createForestGPUForPark({
      renderer, camera, palette, heightAt,
      treeBaseOffset: FOREST_PARAMS.treeBaseOffset,
      lodR0: O.treeLodR0, lodR1: O.treeLodR1, lodR2: O.treeLodR2,
      maxDrawRadius: O.treeLodR2,
      capPerVariant: O.treeCapPerVariant,
    });
    if (texSet) {
      nextForest.applyTextureSet((bark, leaf) => {
        bark.colorNode = null;
        bark.map = texSet.barkMap;
        leaf.map = texSet.leafMap;
        leaf.transparent = true;
        leaf.alphaTest = texSet.leafAlphaTest;
        bark.needsUpdate = true;
        leaf.needsUpdate = true;
      });
      stats.treeTextures = 'authored';
    }

    // Populate and cull the replacement while the currently rendered forest is still live.
    // Palette edits are baked geometry changes, but they do not change placement, so restarting
    // the budgeted chunk streamer here creates an avoidable empty/reappearing interval.
    const active = new Map();
    for (const [key, records] of treeChunkRecords) active.set(key, scaledTreeRecords(records));
    if (active.size) {
      nextForest.setChunks(active);
      await nextForest.update();
    }

    const oldForest = forestGPU;
    const oldMeshes = oldForest?.meshes?.slice() || [];
    forestGPU = nextForest;
    scene.add(...nextForest.meshes);
    meshes.push(...nextForest.meshes);
    if (oldForest) {
      scene.remove(...oldMeshes);
      oldForest.dispose();
      for (const mesh of oldMeshes) {
        const i = meshes.indexOf(mesh);
        if (i >= 0) meshes.splice(i, 1);
      }
    }
    return forestGPU;
  }

  if (O.forest) {
    await say('planting the trees');
    try {
      const [treeModule, paletteModule, gpuModule, place, { createTrunkIndex }, { createTextureSource }] = await Promise.all([
        import('./trees.js'),
        import('./forest-palette.js'),
        import('./forest-gpu.js?v=visible-gating-debounce-1'),
        import('./forest-placement.js'),
        import('./collision.js'),
        import('./tree-textures.js'),
      ]);
      createTreeForForest = treeModule.createTree;
      createForestPaletteForPark = paletteModule.createForestPalette;
      createForestGPUForPark = gpuModule.createForestGPU;
      // Awaited rather than hot-swapped: the leaf geometry differs between atlas cards and
      // procedural silhouettes, so a late texture set means rebaking the palette.
      if (O.treeTextures === 'authored') {
        await say('loading the bark and leaves');
        let arrived;
        const decoded = new Promise((r) => { arrived = r; });
        const set = createTextureSource('authored', { texDir: O.texDir, onReady: () => arrived(true) });
        await Promise.race([decoded, new Promise((r) => setTimeout(r, O.texWaitMs))]);
        texSet = set;
        if (!texSet.ready) {
          console.warn('[park-flora] the tree textures did not decode in time; falling back to flat colour');
          texSet.dispose();
          texSet = null;
        } else {
          disposers.push(() => texSet.dispose());
        }
      }
      placementRecords = place.placementRecords;
      trunkIndex = createTrunkIndex(CH);
      // `texSet: null` is a supported mode, not a shortcut. The same function is reused for leaf
      // size edits so the initial bake and every later rebake cannot drift apart.
      await rebuildForestGPU();
      disposers.push(() => { scene.remove(...forestGPU.meshes); forestGPU.dispose(); });
    } catch (e) { console.warn('[park-flora] forest:', e.message); }
  }

  const treeParams = () => ({
    ...FOREST_PARAMS,
    count: FOREST_PARAMS.count * treeDensityScale,
    masterSeed: O.masterSeed,
    waterLevel: grid.waterLevel,
    // The park's TOTAL chunk count, not the window's.
    targetChunkCount: totalChunks,
    treeDensityAt,
  });

  // ===================== boulders =====================

  let dressingGPU = null;
  let dressingIndex = null;
  let rockPlacementRecords = null;
  let boulderCircles = null;
  let rockGroupOf = null;
  const rockChunks = new Set();
  let rockQueue = [];
  let rockParams = null;

  if (O.boulders) {
    await say('setting the rocks');
    try {
      const [{ createRockPalette, buildBoulderMaterial, buildScreeMaterial }, rp, { createDressingGPU }, { createTrunkIndex }] = await Promise.all([
        import('./rocks.js?v=dressing-lichen-color-8'),
        import('./rocks-placement.js?v=dressing-wire-1'),
        import('./dressing-gpu.js?v=dressing-cull-2'),
        import('./collision.js'),
      ]);
      rockPlacementRecords = rp.rockPlacementRecords;
      boulderCircles = rp.boulderCirclesFromRecords;
      dressingIndex = createTrunkIndex(CH);
      const rockPalette = createRockPalette({ masterSeed: O.masterSeed });

      const groups = [];
      rockGroupOf = new Map();
      for (const t of rockPalette.types) {
        if (t.scree && !O.scree) continue;
        rockGroupOf.set(t.key, { offset: groups.length, count: t.count });
        for (let v = 0; v < t.count; v++) {
          groups.push({
            key: `${t.key}#${v}`,
            geometry: rockPalette.variants[t.startIdx + v],
            cap: t.scree ? 8000 : 512,
            cullRadius: t.scree ? O.screeCullRadius : O.boulderCullRadius,
            // Scree is too small and too dense to be worth a shadow-map slot each.
            castShadow: !t.scree,
            receiveShadow: true,
            buildMaterial: t.scree
              ? () => buildScreeMaterial({ textures: {}, textureScale: 1 })
              : (nodes) => buildBoulderMaterial({ textures: {}, normalBase: nodes.nWorld, moistureNode: nodes.extra }),
          });
        }
      }
      dressingGPU = createDressingGPU({ renderer, camera, heightAt, groups });
      scene.add(...dressingGPU.meshes);
      meshes.push(...dressingGPU.meshes);

      const rockTypeTable = rockPalette.types
        .filter((t) => !t.scree || O.scree)
        .map((t) => ({
          key: t.key, scree: t.scree, density: 1, variantCount: t.count,
          sizeRange: t.scree ? [0.05, 0.28] : [0.4, 2.6], footprintScale: t.scree ? 0.5 : 0.8,
        }));
      rockParams = () => ({
        masterSeed: O.masterSeed, waterLevel: grid.waterLevel, rockTypeTable,
        boulderDensity: O.boulderDensity, screeDensity: O.screeDensity,
        rockGateStart: 0.3, rockGateEnd: 0.6,
      });
      disposers.push(() => { scene.remove(...dressingGPU.meshes); dressingGPU.dispose(); });
    } catch (e) { console.warn('[park-flora] rocks:', e.message); }
  }

  /** The material field the rock placer gates scree on, synthesised from the park's own slope. */
  const _mw = { indices: [0], weights: [0], layers: ['rock'] };
  const surfaceFieldAt = (x, z) => {
    const slope = Math.min(1, map.slopeAt(x, z) / 0.6);
    _mw.weights[0] = slope;
    return { upness: 1 - slope, moisture: 0.42, materialWeights: _mw };
  };

  // ===================== streaming =====================

  let lastTreeWindow = '';
  let lastRockWindow = '';
  let treeBatch = new Map();

  function rebuildActiveTreePlacements() {
    if (!forestGPU || !placementRecords) return;
    const batch = new Map();
    for (const [key, chunk] of treeChunkSpecs) {
      const sourceRecords = placementRecords([chunk], treeParams(), heightAt, biomeAt);
      const recs = scaledTreeRecords(sourceRecords);
      treeChunkRecords.set(key, sourceRecords);
      batch.set(key, recs);
      trunkIndex?.setTrunks(key, recs.map((r) => ({ x: r.x, z: r.z, r: trunkRadiusOf(r) })));
    }
    if (batch.size) forestGPU.setChunks(batch);
    treeBatch = new Map();
  }

  function syncTrees(focus) {
    if (!forestGPU || !placementRecords) return;
    const key = `${Math.floor(focus.x / CH)},${Math.floor(focus.z / CH)}`;
    if (key === lastTreeWindow && !treeQueue.length && !treeBatch.size) return;
    if (key !== lastTreeWindow) {
      lastTreeWindow = key;
      const active = chunksAround(focus.x, focus.z, O.treeRadiusChunks);
      const activeKeys = new Set(active.map((c) => c.key));
      for (const k of [...treeChunks]) {
        if (!activeKeys.has(k)) {
          forestGPU.clearChunk(k);
          treeBatch.delete(k);
          treeChunkRecords.delete(k);
          treeChunkSpecs.delete(k);
          trunkIndex.clearTrunks(k);
          treeChunks.delete(k);
        }
      }
      treeQueue = active.filter((c) => !treeChunks.has(c.key));
    }
    // Budgeted: a chunk is a few hundred trees of CPU placement
    const deadline = performance.now() + O.treeBuildBudgetMs;
    let built = 0;
    while (treeQueue.length && built < O.treeChunksPerFrame && performance.now() < deadline) {
      const chunk = treeQueue.shift();
      const sourceRecords = placementRecords([chunk], treeParams(), heightAt, biomeAt);
      // Bot Viewer precedent: one placement-record scale drives branches, leaves, culling, and
      // trunk collision together. Never scale branch and leaf meshes independently after baking.
      const recs = scaledTreeRecords(sourceRecords);
      treeChunkRecords.set(chunk.key, sourceRecords);
      treeChunkSpecs.set(chunk.key, chunk);
      treeBatch.set(chunk.key, recs);
      trunkIndex.setTrunks(chunk.key, recs.map((r) => ({ x: r.x, z: r.z, r: trunkRadiusOf(r) })));
      treeChunks.add(chunk.key);
      built++;
    }
    if (treeBatch.size && (!treeQueue.length || treeBatch.size >= O.treeFlushChunks)) {
      forestGPU.setChunks(treeBatch);
      treeBatch = new Map();
    }
    stats.treeChunks = treeChunks.size;
    stats.trees = forestGPU.stats?.instances ?? 0;
  }

  function syncRocks(focus) {
    if (!dressingGPU || !rockPlacementRecords) return;
    const key = `${Math.floor(focus.x / CH)},${Math.floor(focus.z / CH)}`;
    if (key === lastRockWindow && !rockQueue.length) return;
    const clearKeys = [];
    if (key !== lastRockWindow) {
      lastRockWindow = key;
      const active = chunksAround(focus.x, focus.z, O.boulderRadiusChunks);
      const activeKeys = new Set(active.map((c) => c.key));
      for (const k of [...rockChunks]) {
        if (!activeKeys.has(k)) { clearKeys.push(k); dressingIndex.clearTrunks(k); rockChunks.delete(k); }
      }
      rockQueue = active.filter((c) => !rockChunks.has(c.key));
    }
    const batch = new Map();
    const deadline = performance.now() + O.rockBuildBudgetMs;
    let built = 0;
    while (rockQueue.length && built < O.rockChunksPerFrame && performance.now() < deadline) {
      const chunk = rockQueue.shift();
      const recs = rockPlacementRecords([chunk], rockParams(), heightAt, surfaceFieldAt);
      const out = [];
      for (const r of recs) {
        const g = rockGroupOf.get(r.variant);
        if (!g) continue;
        if (clearFn && clearFn(r.x, r.z)) continue;
        out.push({
          x: r.x, y: r.y, z: r.z, scale: r.scale, yaw: r.yaw, tiltX: r.tiltX, tiltZ: r.tiltZ,
          extra: r.moisture, groupIdx: g.offset + Math.min(r.variantIdx | 0, g.count - 1),
        });
      }
      batch.set(chunk.key, out);
      dressingIndex.setTrunks(chunk.key, boulderCircles(clearFn ? recs.filter((r) => !clearFn(r.x, r.z)) : recs));
      rockChunks.add(chunk.key);
      built++;
    }
    if (batch.size || clearKeys.length) dressingGPU.setChunks(batch, clearKeys);
    stats.rockChunks = rockChunks.size;
    stats.boulders = dressingGPU.stats?.instances ?? 0;
  }

  /** Push anything overlapping a trunk or a boulder back out, in XZ only. */
  function resolveCollision(x, z, radius) {
    let out = { x, z, pushed: false };
    if (trunkIndex) {
      const t = trunkIndex.resolve(out.x, out.z, radius);
      if (t.pushed) out = { x: t.x, z: t.z, pushed: true };
    }
    if (dressingIndex) {
      const d = dressingIndex.resolve(out.x, out.z, radius);
      if (d.pushed) out = { x: d.x, z: d.z, pushed: true };
    }
    return out;
  }

  /** Advance independently switchable work paths for live performance isolation. */
  async function update(focus, seconds, runtime = {}) {
    const grassEnabled = runtime.grass !== false;
    const treesEnabled = runtime.trees !== false;
    const rocksEnabled = runtime.rocks !== false;
    if (treesEnabled) syncTrees(focus);
    if (rocksEnabled) syncRocks(focus);
    if (grassEnabled && grassRef) {
      await grassRef.update(seconds);
      stats.grassBlades = grassRef.stats?.live ?? 0;
    }
    if (treesEnabled && forestGPU) await forestGPU.update();
    if (rocksEnabled && dressingGPU) await dressingGPU.update();
  }

  return {
    update, stats, meshes,
    trunkIndex, dressingIndex, resolveCollision,
    grass: grassRef, get forest() { return forestGPU; }, dressing: dressingGPU,
    treeSpeciesTable,
    setSunDir(v) { grassRef?.setSunDir?.(v); },
    setGrassLook(partial) { grassRef?.setLook?.(partial); },
    getGrassLook() { return grassRef?.getLook?.() ?? { ...O.grassLook }; },
    setGrass({ height, width, density, radius } = {}) {
      if (height !== undefined) grassRef?.setBladeHeight?.(height);
      if (width !== undefined) grassRef?.setBladeWidth?.(width);
      if (density !== undefined) grassRef?.setDensity?.(density);
      if (radius !== undefined) grassRef?.setRadius?.(radius);
    },
    setTreeDensity(scale) {
      const next = Math.max(0, Math.min(2, Number(scale) || 0));
      if (treeDensityScale === next) return;
      treeDensityScale = next;
      rebuildActiveTreePlacements();
    },
    get treeDensityScale() { return treeDensityScale; },
    setTreeScale(scale) {
      const value = Number(scale);
      const next = Number.isFinite(value) ? Math.max(0.001, value) : 1;
      if (treeSizeScale === next) return false;
      treeSizeScale = next;
      // The active placements do not change. Replace every active chunk's record array in one
      // deferred GPU-buffer rebuild, and update collision from those same scaled records.
      treeBatch = new Map();
      for (const [key, sourceRecords] of treeChunkRecords) {
        const recs = scaledTreeRecords(sourceRecords);
        treeBatch.set(key, recs);
        trunkIndex?.setTrunks(key, recs.map((r) => ({ x: r.x, z: r.z, r: trunkRadiusOf(r) })));
      }
      if (treeBatch.size) forestGPU?.setChunks(treeBatch);
      treeBatch = new Map();
      return true;
    },
    get treeScale() { return treeSizeScale; },
    async setTreeLeafOptions({ size = treeLeafScale, density = treeLeafDensity } = {}) {
      const sizeValue = Number(size);
      const densityValue = Number(density);
      const nextSize = Number.isFinite(sizeValue) ? Math.max(0.01, sizeValue) : 1;
      const nextDensity = Number.isFinite(densityValue) ? Math.max(0, densityValue) : 1;
      if (treeLeafScale === nextSize && treeLeafDensity === nextDensity) return false;
      treeLeafScale = nextSize;
      treeLeafDensity = nextDensity;
      await rebuildForestGPU();
      return true;
    },
    async setTreeLeafScale(scale) { return this.setTreeLeafOptions({ size: scale }); },
    get treeLeafScale() { return treeLeafScale; },
    get treeLeafDensity() { return treeLeafDensity; },
    totalChunks, chunkSize: CH,
    dispose() { for (const d of disposers) { try { d(); } catch (_) {} } },
  };
}
