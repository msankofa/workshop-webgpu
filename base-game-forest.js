// base-game-forest.js — the drawn half of Base Game's forest (tree plan T2).
//
// base-game-trees.js decides which trees exist and where, in GLOBAL coordinates. This module
// bakes a variant palette once, hands those records to forest-gpu.js, and owns the three things
// no other host of that renderer has had to survive:
//
//   - A render origin that moves. Records stay global; the instance buffer holds render-local,
//     so a rebase re-uploads without redrawing a single RNG value (tree plan D8).
//   - A capacity that is a budget, not a cliff. capPerVariant x variants is a countable number,
//     and the panel says when it is clamping rather than dropping trees quietly (D9).
//   - Per-rung visibility. Every LOD band has its own distance AND its own on/off, because
//     collapsing a band and hiding a band measure two different costs (D5b).
//
// Trunk height comes from terrain.groundHeight — the same surface the player collides against, so
// a trunk cannot sit on ground the player walks through, and it does not change with distance the
// way a near/far window blend would (which would pop trunks as the camera walked past the handover).

import * as THREE from 'three';
import { Fn, attribute, float, vec2, fract, floor, dot, mix, sin } from 'three/tsl';
import { createBaseGameTrees, BASE_GAME_TREE_DEFAULTS, TREE_IDENTITY_KEYS } from './base-game-trees.js';
import { buildSpecies, rngFrom } from './forest-placement.js';

export const BASE_GAME_FOREST_DEFAULTS = Object.freeze({
  // Local quality, every one of them. None of these may join BASE_GAME_SHARED_KEYS: two peers
  // with different draw radii or LOD rings must still stand in the same forest.
  treeDrawRadius: 260,
  treeLodR0: 60, treeLodR1: 140, treeLodR2: 260,
  treeLod0: true, treeLod1: true, treeLod2: true,
  treeCapPerVariant: 1024,
  // Provisional performance default. Four remains available as the high-variety setting, but the
  // default should not double render objects/material graphs before GPU captures justify it.
  treeVariantsPerSpecies: 2,
  treeLeafSway: 1,
  treeBark: true, treeLeaves: true, treeBarkShadows: true, treeLeafShadows: true,
  // Half-extent of the host's directional shadow camera (base-game.html sets +/-90). A LOD rung
  // whose near edge is past this rasterises into a shadow map it cannot appear in.
  treeShadowReach: 90,
  // Bark photos and the four-leaf atlas from tree-textures.js, as environment-viewer and
  // bot-viewer-v3 default to; 'procedural' is the textureless bark grain over flat colours.
  treeTexMode: 'authored',
  // Palette authoring. Procedural species in v1; authored families are T5.
  treeLeafCount: 10, treeLeafSize: 1, treeLeafStart: 0.25, treeLeafSpread: 0,
  treeLeafShadowPct: 0.3, treeCoarseLeafRatio: 0.25, treeCoarseLeafSizeMult: 2.5,
  // Level-0 multipliers: the trunk alone, so these change a tree's PROPORTIONS. treeMaxSize is
  // the overall-size slider and already scales everything together.
  treeTrunkHeight: 1, treeTrunkWidth: 1,
});

// Palette-shaping settings: changing one rebakes the geometry and rebuilds the instance buffers,
// so they are commit-on-release in the panel and deferred to the next update() here.
const PALETTE_KEYS = Object.freeze([
  'treeTexMode', 'treeSpecies', 'treeSpeciesSelection', 'treeDiversity', 'treeGeneralization', 'treeVariantsPerSpecies', 'treeCapPerVariant',
  'treeLeafCount', 'treeLeafSize', 'treeLeafStart', 'treeLeafSpread', 'treeLeafShadowPct',
  'treeCoarseLeafRatio', 'treeCoarseLeafSizeMult', 'treeSeedOffset',
  'treeTrunkHeight', 'treeTrunkWidth',
]);

// Branch LODs share the full tree's skeleton but retain fewer lengthwise rings and fewer sides.
// That keeps silhouettes and leaf attachment points stable while reducing the bark cost with range.
const BASE_GAME_BRANCH_LODS = Object.freeze([
  Object.freeze({ sectionStride: 2, segmentScale: 0.67 }),
  Object.freeze({ sectionStride: 3, segmentScale: 0.5 }),
]);

// Triangles one instance costs at each rung, averaged over the palette. Reported rather than
// guessed: a rung toggle is only worth having if the thing it removes is a number on screen.
export function rungTriangles(palette) {
  const tris = geo => (geo?.index ? geo.index.count : (geo?.attributes?.position?.count ?? 0)) / 3;
  const out = [0, 0, 0, 0];
  for (const v of palette.variants) {
    out[0] += tris(v.branches) + tris(v.leaves) + tris(v.shadow);
    out[1] += tris(v.branchesLod1 ?? v.branches) + tris(v.leaves);
    out[2] += tris(v.branchesLod2 ?? v.branches) + tris(v.leavesCoarse);
    out[3] += 2;
  }
  const n = Math.max(1, palette.variants.length);
  return out.map(t => t / n);
}

// Bark grain, ported from environment-viewer.html's proceduralBarkColorNode. The baked flat
// species colour is the vertex colour it multiplies, so a trunk reads as bark rather than as a
// coloured cylinder.
export function proceduralBarkColorNode() {
  const uv = attribute('uv', 'vec2');
  const vertexColor = attribute('color', 'vec3');
  const hash2D = Fn(([p]) => {
    const q = fract(p.mul(vec2(123.34, 456.21)));
    const r = q.add(dot(q, q.add(float(45.32))));
    return fract(r.x.mul(r.y));
  });
  const noise2D = Fn(([p]) => {
    const i = floor(p), f = fract(p);
    const a = hash2D(i), b = hash2D(i.add(vec2(1.0, 0.0)));
    const c = hash2D(i.add(vec2(0.0, 1.0))), d = hash2D(i.add(vec2(1.0, 1.0)));
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });
  const longGrain = noise2D(vec2(uv.x.mul(7.0), uv.y.mul(1.35)));
  const crossBreak = noise2D(vec2(uv.x.mul(16.0).add(longGrain.mul(2.0)), uv.y.mul(5.5)));
  const ridges = sin(uv.x.mul(42.0).add(longGrain.mul(7.0)).add(crossBreak.mul(2.5))).mul(0.5).add(0.5);
  const pores = noise2D(vec2(uv.x.mul(54.0), uv.y.mul(18.0)));
  const barkValue = ridges.mul(0.5).add(longGrain.mul(0.28)).add(pores.mul(0.22));
  return vertexColor.mul(mix(float(0.48), float(1.34), barkValue));
}

// The binding bot-trees.js (bot-viewer-v3) uses: procedural is the bark grain node over the baked
// flat colour, authored is the photo maps and the leaf atlas. Leaves are cut out by alphaTest and
// never `transparent`: blended cards need a sort order an instanced canopy does not have, and the
// half-covered edge texels blend against the sky as a pale rim around every leaf.
export function bindTreeMaterials(branchMat, leafMat, set) {
  leafMat.transparent = false;
  if (!set || set.mode === 'procedural') {
    branchMat.map = null;
    branchMat.normalMap = null;
    branchMat.colorNode = proceduralBarkColorNode();
    leafMat.map = null;
    leafMat.alphaTest = 0;
  } else {
    branchMat.colorNode = null;
    branchMat.map = set.barkMap;
    branchMat.normalMap = set.barkNormalMap;
    leafMat.map = set.leafMap;
    leafMat.alphaTest = set.leafMap ? (set.leafAlphaTest ?? 0.5) : 0;
  }
  branchMat.needsUpdate = true;
  leafMat.needsUpdate = true;
}

// createTextureSource is injectable so a Node test can hand in a fake authored set; the page uses
// tree-textures.js. Authored needs a document (it paints the leaf atlas on a canvas), so headless
// hosts fall back to procedural rather than throwing inside the build.
// The layer the forest's shadow-only meshes live on. The host enables it on its shadow camera and
// nowhere else, so the main pass never draws them; the rain occluder bake uses layer 3.
export const BASE_GAME_FOREST_SHADOW_LAYER = 4;

export function createBaseGameForest({ renderer, scene, camera, terrain, worldCoordinates, settings = {}, yieldTask = null, createTextureSource = null, shadowLayer = BASE_GAME_FOREST_SHADOW_LAYER } = {}) {
  if (!scene?.add) throw new TypeError('the forest needs a scene');
  if (!terrain?.acquireFields) throw new TypeError('the forest needs the Base Game terrain facade');
  const cfg = { ...BASE_GAME_TREE_DEFAULTS, ...BASE_GAME_FOREST_DEFAULTS, ...settings };
  // The placement window is derived from the draw radius, never set beside it: reconciled here as
  // well as in apply(), or a forest constructed and never re-applied places chunks nothing draws.
  cfg.treeRadius = drawRadius();

  const trees = createBaseGameTrees({ terrain, worldCoordinates, settings: cfg });
  let mods = null, palette = null, forestGPU = null;
  let texSet = null;
  let publishedMeshes = [];
  let gpuCanUpdate = false;
  let meshesCb = null;
  let enabled = false, built = false, building = false, buildFailed = false, pendingRebuild = false;
  let buildToken = 0;                 // a teardown mid-build invalidates the work in flight
  let rungTris = [0, 0, 0, 0];

  const stats = {
    enabled: false, built: false, loading: false, lastError: null,
    draws: 0, shadowDraws: 0, triangles: 0, instances: 0, capacity: 0, dropped: 0, truncating: false,
    textureMode: 'procedural', texturesReady: false,
    variants: 0, readyVariants: 0, visibleVariants: 0, paletteMs: 0, compileMs: 0, computeCompileMs: 0, updateMs: 0,
    lod0: 0, lod1: 0, lod2: 0, rejectedCone: 0, rejectedFar: 0,
    reculls: 0, skippedReculls: 0, cullEstimates: 0,
    // Placement, mirrored up so one readout answers "what did the density slider actually buy".
    trees: 0, requestedTrees: 0, coverThinning: 0, resident: 0, deferred: 0, placeMs: 0,
  };

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const yieldMain = yieldTask ?? (() => {
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
    if (typeof requestAnimationFrame === 'function') {
      return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }
    return new Promise(resolve => setTimeout(resolve, 0));
  });
  const originScratch = [0, 0, 0];
  const focusScratch = [0, 0, 0];
  function readOrigin() {
    return worldCoordinates?.getOrigin?.(originScratch) ?? originScratch;
  }
  // Global camera position: the placement window follows the player through the world, not
  // through the render frame.
  function readFocus() {
    const o = readOrigin();
    focusScratch[0] = camera.position.x + o[0];
    focusScratch[1] = camera.position.y + o[1];
    focusScratch[2] = camera.position.z + o[2];
    return focusScratch;
  }
  // Global in, global out. forest-gpu subtracts the origin itself at upload.
  function globalHeightAt(x, z) {
    const h = terrain.groundHeight(x, z);
    return Number.isFinite(h) ? h : -1e5;
  }

  trees.setListeners({
    onChunk: (key, recs) => forestGPU?.setChunk(key, recs),
    onClear: key => forestGPU?.clearChunk(key),
  });
  const dropRebase = worldCoordinates?.onRebase?.(() => syncOrigin()) ?? null;
  function syncOrigin() {
    if (!forestGPU) return;
    const o = readOrigin();
    forestGPU.setWorldOrigin(o[0], o[1], o[2]);
  }

  // The palette and the placement must agree on the species table, so the shared half comes from
  // placementParams rather than from a second copy of the same numbers.
  function paletteParams() {
    const params = {
      ...trees.placementParams,
      leafCount: cfg.treeLeafCount, leafSize: cfg.treeLeafSize,
      leafStart: cfg.treeLeafStart, leafSpread: cfg.treeLeafSpread,
      leafShadowPct: cfg.treeLeafShadowPct,
      coarseLeafRatio: cfg.treeCoarseLeafRatio, coarseLeafSizeMult: cfg.treeCoarseLeafSizeMult,
      branchLods: BASE_GAME_BRANCH_LODS,
    };
    params.speciesTable = scaledSpecies(params);
    return params;
  }

  // The species createForestPalette would have built, with the trunk scaled. buildSpecies is
  // deterministic from (params, seed), so rebuilding it here reproduces that table exactly rather
  // than a different one; placement never sees this table, and only ever needs the species COUNT.
  // trees.js leaves `radius` unset, so the trunk width multiplier needs the generator's own
  // default table rather than a copy of those four numbers.
  function scaledSpecies(params) {
    const height = Math.max(0.01, cfg.treeTrunkHeight);
    const width = Math.max(0.01, cfg.treeTrunkWidth);
    const fallback = mods?.TREE_DEFAULTS ?? {};
    const sourceSpecies = params.speciesTable ?? buildSpecies(params, rngFrom(trees.seed));
    return sourceSpecies.map(sp => {
      const length = [...(sp.length ?? fallback.length ?? [])];
      const radius = [...(sp.radius ?? fallback.radius ?? [])];
      if (length.length) length[0] *= height;
      if (radius.length) radius[0] *= width;
      return { ...sp, length, radius };
    });
  }

  function lodDistances() {
    // Monotone by construction: a panel that lets r1 fall below r0 would empty a band silently.
    const r0 = Math.max(1, cfg.treeLodR0);
    const r1 = Math.max(r0, cfg.treeLodR1);
    const r2 = Math.max(r1, cfg.treeLodR2);
    return [r0, r1, r2];
  }
  // No billboards in v1 (D6), so the forest ends at lodR2 rather than at a band of white quads.
  function drawRadius() {
    return Math.min(Math.max(1, cfg.treeDrawRadius), lodDistances()[2]);
  }

  function wantedTexMode() {
    const canAuthor = !!createTextureSource || typeof document !== 'undefined';
    return cfg.treeTexMode === 'authored' && canAuthor ? 'authored' : 'procedural';
  }
  // One set per mode. The palette bakes atlas-card leaves the moment the set exists, so a set that
  // is still decoding only delays the material binding, never the geometry: when it lands the
  // materials are rebound in place, no rebake. Changing the mode is a rebake (PALETTE_KEYS).
  function ensureTextureSet() {
    const mode = wantedTexMode();
    if (texSet && texSet.mode === mode) return texSet;
    const previous = texSet;
    const make = createTextureSource ?? mods?.createTextureSource;
    const set = make ? make(mode, {
      onReady: (ready) => {
        if (ready !== texSet) return;
        stats.texturesReady = true;
        forestGPU?.applyTextureSet((b, l) => bindTreeMaterials(b, l, texSet));
      },
    }) : { mode: 'procedural', ready: true, leafAtlas: { cols: 2, rows: 2 }, dispose() {} };
    texSet = set;
    stats.textureMode = set.mode;
    stats.texturesReady = !!set.ready;
    previous?.dispose?.();
    return set;
  }
  function bindMaterials() {
    const set = texSet?.ready ? texSet : null;
    forestGPU.applyTextureSet((b, l) => bindTreeMaterials(b, l, set));
  }

  function disposePalette() {
    if (!palette) return;
    const geometries = new Set();
    for (const v of palette.variants) {
      if (!v) continue;
      for (const geometry of [v.branches, v.branchesLod1, v.branchesLod2, v.leaves, v.shadow, v.leavesCoarse]) {
        if (geometry) geometries.add(geometry);
      }
    }
    for (const geometry of geometries) geometry.dispose();
    palette = null;
  }

  function teardownRenderer() {
    buildToken++;
    if (forestGPU) {
      scene.remove(...publishedMeshes);
      forestGPU.dispose();
      forestGPU = null;
      publishedMeshes = [];
      gpuCanUpdate = false;
      meshesCb?.([]);          // the host's mirror-exclusion list must forget the dead meshes
    }
    disposePalette();
    built = false;
    stats.built = false;
  }

  // Kicked off, never awaited by the frame loop: compiling ~84 render pipelines is the freeze, and
  // WebGPU can do it off the main thread. The forest appears when it is ready; until then the panel
  // says it is waiting.
  function beginBuild() {
    if (built || building || buildFailed || !mods) return false;
    building = true;
    buildAsync().catch(err => {
      teardownRenderer();
      buildFailed = true;
      stats.lastError = String(err?.message ?? err);
    })
      .finally(() => { building = false; });
    return false;
  }

  async function buildAsync() {
    const token = buildToken;
    const t0 = now();
    const variantsPerSpecies = Math.max(1, Math.round(cfg.treeVariantsPerSpecies));
    const readyPaletteVariants = [];
    ensureTextureSet();
    stats.paletteMs = 0;
    stats.compileMs = 0;
    stats.computeCompileMs = 0;
    stats.readyVariants = 0;

    async function publishFamilyWave({ variants: wave, palette: progressPalette, total }) {
      if (token !== buildToken || !enabled) return false;
      gpuCanUpdate = false;
      if (!forestGPU) {
        // The first wave contains variant zero from every family. Use each family's first geometry
        // as a hidden placeholder for its later slots so the fixed-size GPU buffers can be created
        // once; placeholders never draw and are replaced before their slot becomes ready.
        const slots = new Array(total);
        for (let s = 0; s < progressPalette.speciesCount; s++) {
          const fallback = progressPalette.variants[s * variantsPerSpecies];
          for (let v = 0; v < variantsPerSpecies; v++) {
            const g = s * variantsPerSpecies + v;
            slots[g] = progressPalette.variants[g] ?? fallback;
          }
        }
        palette = { ...progressPalette, variants: slots };
        const [r0, r1, r2] = lodDistances();
        forestGPU = mods.createForestGPU({
          renderer, camera, palette,
          heightAt: globalHeightAt,
          treeBaseOffset: cfg.treeVerticalOffset,
          lodR0: r0, lodR1: r1, lodR2: r2,
          maxDrawRadius: drawRadius(),
          capPerVariant: Math.max(16, Math.round(cfg.treeCapPerVariant)),
          leafSway: cfg.treeLeafSway,
          billboards: false,
          progressive: true,
          shadowLayer,
        });
        bindMaterials();
        syncOrigin();
        syncRenderState();
        if (trees.records.size) forestGPU.setChunks(trees.records);
        const sharedStart = now();
        await forestGPU.warmupComputeShared?.(yieldMain, () => token === buildToken && enabled);
        stats.computeCompileMs += now() - sharedStart;
        if (token !== buildToken || !enabled || !forestGPU) return false;
      }

      const gpu = forestGPU;
      const indices = [];
      for (const variant of wave) {
        const g = variant.speciesIdx * variantsPerSpecies + variant.variant;
        indices.push(g);
        readyPaletteVariants[g] = variant;
        palette.variants[g] = variant;
        gpu.installVariant(g, variant);
      }

      // Compile one complete cross-family wave off-scene. Publication happens only after every
      // family in the wave is ready, so the forest never temporarily becomes a monoculture.
      const waveMeshes = indices.flatMap(g => gpu.variantMeshes(g));
      const warm = new THREE.Group();
      for (const mesh of waveMeshes) { mesh.visible = true; warm.add(mesh); }
      const compileStart = now();
      if (renderer?.compileAsync) await renderer.compileAsync(warm, camera, scene);
      stats.compileMs += now() - compileStart;
      if (token !== buildToken || !enabled || forestGPU !== gpu) return false;
      for (const g of indices) {
        const computeStart = now();
        await gpu.warmupVariant?.(g, yieldMain, () => token === buildToken && enabled);
        stats.computeCompileMs += now() - computeStart;
        if (token !== buildToken || !enabled || forestGPU !== gpu) return false;
      }

      for (const g of indices) gpu.setVariantReady(g, true);
      gpu.refreshVisibility();
      scene.add(...waveMeshes);
      publishedMeshes.push(...waveMeshes);
      meshesCb?.(publishedMeshes);
      rungTris = rungTriangles({ variants: readyPaletteVariants.filter(Boolean) });
      built = true;
      stats.built = true;
      stats.variants = total;
      stats.readyVariants = readyPaletteVariants.filter(Boolean).length;
      gpuCanUpdate = true;
      return true;
    }

    const completePalette = await mods.createForestPaletteAsync({
      createTree: mods.createTree,
      params: paletteParams(),
      masterSeed: trees.seed,
      variantsPerSpecies,
      texSet,
    }, {
      yieldFn: yieldMain,
      shouldContinue: () => token === buildToken && enabled,
      onFamilyWave: publishFamilyWave,
    });
    if (!completePalette || token !== buildToken) return false;
    palette = completePalette;
    stats.paletteMs = completePalette.bakeMs ?? (now() - t0);
    rungTris = rungTriangles(palette);
    stats.variants = palette.variants.length;
    stats.readyVariants = palette.variants.length;
    gpuCanUpdate = true;
    return true;
  }

  function syncRenderState() {
    if (!forestGPU) return;
    const [r0, r1, r2] = lodDistances();
    forestGPU.setLodDistances(r0, r1, r2);
    forestGPU.setMaxDrawRadius(drawRadius());
    forestGPU.setLodEnabled([cfg.treeLod0, cfg.treeLod1, cfg.treeLod2, false]);
    // A rung casts only if it STARTS inside the shadow camera: rung 0 at 0, rung 1 at r0, rung 2 at r1.
    const reach = Math.max(0, cfg.treeShadowReach);
    forestGPU.setShadowRungs([0 < reach, r0 < reach, r1 < reach, false]);
    // The shadow list: every tree within reach casts, cone or not. Off when neither part casts.
    forestGPU.setShadowReach?.(cfg.treeBarkShadows || cfg.treeLeafShadows ? reach : 0);
    forestGPU.setRenderParts({
      bark: cfg.treeBark, leaves: cfg.treeLeaves, billboards: false,
      barkShadows: cfg.treeBarkShadows, leafShadows: cfg.treeLeafShadows,
    });
    forestGPU.setLeafSway(cfg.treeLeafSway);
    forestGPU.setTreeBaseOffset(cfg.treeVerticalOffset);
  }

  // The per-frame read. forestGPU.summary neither scans nor allocates; forestGPU.stats does both
  // (computeCullEstimate walks every live instance), which is 0.2 ms a frame at a draw radius the
  // sliders reach. The per-rung numbers come from sampleDetail() instead, on the panel's interval.
  function syncStats() {
    const t = trees.stats;
    stats.trees = t.trees; stats.requestedTrees = t.requestedTrees; stats.coverThinning = t.coverThinning;
    stats.resident = t.resident; stats.deferred = t.deferred; stats.placeMs = t.placeMs;
    if (!forestGPU) return;
    const f = forestGPU.summary;
    stats.draws = f.draws; stats.shadowDraws = f.shadowDraws;
    stats.instances = f.instances; stats.variants = f.variants;
    stats.readyVariants = f.readyVariants;
    stats.visibleVariants = f.visibleVariants;
    stats.capacity = f.capacity; stats.dropped = f.droppedInstances; stats.truncating = f.truncating;
    stats.reculls = f.reculls; stats.skippedReculls = f.skippedReculls;
    stats.cullEstimates = f.cullEstimates;
  }

  // The expensive half, on demand: per-rung instance counts and the triangle estimate derived from
  // them. Called by the panel readout and by a capture, never from the frame loop.
  function sampleDetail() {
    if (!forestGPU) return stats;
    const f = forestGPU.stats;
    stats.lod0 = f.lod0Instances; stats.lod1 = f.lod1Instances; stats.lod2 = f.lod2Instances;
    stats.rejectedCone = f.rejectedFrustum; stats.rejectedFar = f.rejectedFar;
    stats.cullEstimates = f.cullEstimates;
    const on = f.lodEnabled;
    stats.triangles = Math.round(
      (on[0] ? f.lod0Instances * rungTris[0] : 0)
      + (on[1] ? f.lod1Instances * rungTris[1] : 0)
      + (on[2] ? f.lod2Instances * rungTris[2] : 0));
    return stats;
  }

  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    stats.enabled = next;
    if (next) { buildFailed = false; stats.lastError = null; }
    trees.setEnabled(next);
    if (!next) teardownRenderer();
  }

  return {
    stats,
    trees,
    get built() { return built; },
    get building() { return building; },
    get meshes() { return publishedMeshes; },
    get forestGPU() { return forestGPU; },
    get rungTriangles() { return [...rungTris]; },
    // Fills the per-rung and triangle fields of `stats` and returns it. Not free — do not call it
    // per frame.
    sampleDetail,
    get palette() { return palette; },
    // Lazily imported, so a page with trees off never pays for the generator or the palette.
    async load() {
      if (mods) return true;
      stats.loading = true;
      try {
        const [treesMod, paletteMod, gpuMod, texMod] = await Promise.all([
          import('./trees.js'), import('./forest-palette.js'), import('./forest-gpu.js'),
          import('./tree-textures.js'),
        ]);
        mods = {
          createTextureSource: texMod.createTextureSource,
          createTree: treesMod.createTree,
          createForestPalette: paletteMod.createForestPalette,
          createForestPaletteAsync: paletteMod.createForestPaletteAsync,
          createForestGPU: gpuMod.createForestGPU,
          TREE_DEFAULTS: treesMod.TREE_DEFAULTS,
        };
        return true;
      } catch (err) {
        stats.lastError = String(err?.message ?? err);
        return false;
      } finally {
        stats.loading = false;
      }
    },
    setEnabled,
    // The host hears about the meshes once they exist, so it can keep them out of the water mirror.
    onMeshes(fn) { meshesCb = fn; if (forestGPU) fn(publishedMeshes); },
    async update() {
      if (!enabled) return false;
      if (pendingRebuild) { pendingRebuild = false; teardownRenderer(); }
      const t0 = now();
      const focus = readFocus();
      trees.update(focus[0], focus[2]);
      if (!built) { beginBuild(); syncStats(); return false; }
      syncOrigin();
      if (!gpuCanUpdate) { syncStats(); return false; }
      await forestGPU.update();
      stats.updateMs = now() - t0;
      syncStats();
      return true;
    },
    // Placement settings rebuild the forest over the chunk budget; render settings are setters;
    // palette settings defer a rebake to the next update so one never lands mid-frame.
    apply(next = {}) {
      let paletteDirty = false;
      const placement = {};
      for (const [key, value] of Object.entries(next)) {
        if (!(key in cfg) || cfg[key] === value) continue;
        cfg[key] = value;
        if (PALETTE_KEYS.includes(key)) paletteDirty = true;
        if (key in BASE_GAME_TREE_DEFAULTS) placement[key] = value;
      }
      // One slider: the window has to reach at least as far as the trees draw.
      cfg.treeRadius = drawRadius();
      placement.treeRadius = cfg.treeRadius;
      const focus = readFocus();
      trees.apply(placement, [focus[0], focus[2]]);
      if (paletteDirty) pendingRebuild = true;
      if (paletteDirty) { buildFailed = false; stats.lastError = null; }
      else syncRenderState();
    },
    get config() { return { ...cfg }; },
    dispose() {
      setEnabled(false);
      dropRebase?.();
      trees.dispose();
      teardownRenderer();
      texSet?.dispose?.();
      texSet = null;
    },
  };
}

export { TREE_IDENTITY_KEYS };
