// base-game-trees.js — which trees exist, and where (tree plan T1).
//
// Placement only. This module decides candidate identity and hands out records; the renderer is
// T2 and does not exist yet. Splitting it that way is deliberate: placement is pure enough to test
// in Node, and it is the half multiplayer has to agree on.
//
// Records are GLOBAL. The render origin is subtracted at upload, never here, so a rebase can move
// where a tree draws but never which trees there are.

import { createFloraChunks } from './flora-chunks.js';
import { placementRecords } from './forest-placement.js';
import { speciesTableForSelection } from './base-game-tree-species.js';

export const BASE_GAME_TREE_DEFAULTS = Object.freeze({
  treesEnabled: false,
  // Per HECTARE, never per window. `treeCountForChunk` divides an absolute count by the resident
  // chunk count, so an absolute would make the forest a function of each peer's draw radius —
  // two peers with different draw distances would stand in different forests.
  treesPerHectare: 45,
  treeSeedOffset: 0,           // the owner's knob; the rest of the seed is the terrain descriptor
  treeChunkSize: 96,           // metres; the window radius is derived from this and treeRadius
  treeRadius: 400,             // draw radius, local to each peer
  treePlacement: 'clustered',  // 'random' | 'ring' | 'clustered' | 'scattered'
  treeClusterSize: 5,
  treeClusterSpread: 0.14,
  treeSpecies: 3,
  // Empty keeps the legacy procedural count path for reusable/headless callers. Base Game's page
  // supplies an explicit stable-id selection from base-game-tree-species.js.
  treeSpeciesSelection: '',
  treeDiversity: 0.5,
  treeGeneralization: 0.5,
  treeMaxSize: 0.55,
  treeSizeVar: 0.6,
  treeSkew: 0,
  treeShoreMargin: 0.5,        // metres above sea level before a trunk roots
  treeVerticalOffset: -0.08,   // bias low: a sunk trunk is invisible, a floating one shows daylight
  treeBudgetChunks: 1,         // chunks placed per frame
  treeBudgetMs: 1.5,
});

// Placement inputs that change which trees exist. Everything here is a shared key online and folds
// into worldVersion; draw radius, LODs and chunk budgets are deliberately absent because they are
// each peer's own business.
export const TREE_IDENTITY_KEYS = Object.freeze([
  'treesPerHectare', 'treeSeedOffset', 'treeChunkSize', 'treePlacement', 'treeClusterSize',
  'treeClusterSpread', 'treeSpecies', 'treeSpeciesSelection', 'treeDiversity', 'treeGeneralization', 'treeMaxSize',
  'treeSizeVar', 'treeSkew', 'treeShoreMargin',
]);

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// The seed every peer must agree on: the world's own identity plus the owner's offset.
export function treeSeedFor(descriptor, offset = 0) {
  const key = descriptor?.key ?? descriptor?.seed ?? 'base-game';
  return (hashString(`${key}|${descriptor?.seed ?? 0}`) + (Number(offset) | 0)) >>> 0;
}

// Expected trees in a chunk before any gate thins them. An UPPER bound: the shore test and the
// cover dart-throw both reject afterwards, and neither is knowable without the field.
export function expectedTreesPerChunk(perHectare, chunkSize) {
  const area = Math.max(0, chunkSize) ** 2;
  return Math.max(0, perHectare) * area / 10000;
}

export function createBaseGameTrees({ terrain, worldCoordinates = null, settings = {} } = {}) {
  if (!terrain) throw new TypeError('trees need the terrain facade');
  const cfg = { ...BASE_GAME_TREE_DEFAULTS, ...settings };
  void worldCoordinates;                       // T2 subtracts the origin at upload; T1 stays global

  const records = new Map();                   // chunk key -> records[], global coordinates
  // The renderer subscribes rather than polling: a chunk arriving or leaving is the only moment
  // its instance buffer needs touching, and a per-frame diff of the map would allocate.
  let onChunkCb = null, onClearCb = null;
  let releaseFields = null;
  let enabled = false;
  let masterSeed = treeSeedFor(terrain.source?.descriptor, cfg.treeSeedOffset);
  let selectedSpeciesTable = speciesTableForSelection(cfg.treeSpeciesSelection, { maxSize: cfg.treeMaxSize });

  const stats = {
    enabled: false, resident: 0, queued: 0, deferred: 0, trees: 0,
    lastChunkTrees: 0, lastChunkMs: 0, placeMs: 0, shoreDropped: 0, chunkSize: cfg.treeChunkSize,
    radiusChunks: 0, expectedPerChunk: 0, seed: masterSeed,
    // What the density slider ASKED for across the resident window, against what the cover gate
    // actually let stand. On the analytic test terrain the gate thins by roughly 86%, so a slider
    // reading trees-per-hectare would otherwise be off by a factor of seven with nothing saying so.
    requestedTrees: 0, coverThinning: 0,
  };

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // flora-chunks fixes chunkSize at construction, so a chunk-size change replaces the host rather
  // than resizing it. Everything else is a setter.
  let chunks = makeHost();
  function makeHost() {
    const host = createFloraChunks({
      chunkSize: cfg.treeChunkSize,
      radiusChunks: radiusChunksFor(cfg.treeRadius, cfg.treeChunkSize),
      budgetChunks: cfg.treeBudgetChunks,
      budgetMs: cfg.treeBudgetMs,
    });
    host.setReadyTest(isChunkReady);
    host.onBuild(buildChunk);
    host.onClear(clearChunk);
    return host;
  }

  // The window has to reach at least as far as the trees draw, or the forest ends at an invisible
  // line. Derived, never a slider: a window smaller than the radius is only ever a bug.
  function radiusChunksFor(radius, chunkSize) {
    return Math.max(1, Math.ceil(Math.max(0, radius) / Math.max(1, chunkSize)));
  }

  // Placement height: the field's own posts, band-limited to them. It decides where a tree goes,
  // never where it sits — contact height is the renderer's job. Null means the field is not here,
  // and -Infinity makes the shore test reject rather than inventing a candidate at sea level.
  function placementHeightAt(x, z) {
    const h = terrain.fieldSurfaceAt(x, z);
    return h == null ? -Infinity : h;
  }

  // The single ecology gate (tree plan D2). coverTree is
  // treeDensityForBiome x groundWelcome x slopeGate x moistureFactor, already multiplied together
  // at tile commit, so slope and dryness THIN the forest instead of only vetoing it. The plants
  // plan used treeDensityAt for the accept and this as a zero-veto, which threw the gradient away.
  function coverTreeAt(x, z) {
    const cover = terrain.coverAt(x, z);
    return cover == null ? 0 : cover.tree;
  }

  // Every one of these is load-bearing and every omission is silent, which is why they are written
  // out rather than spread from a partial object:
  //   waterLevel/shoreMargin undefined -> the sum is NaN -> every `height >= NaN` is false -> the
  //     forest comes out EMPTY with no error;
  //   skew/varPattern undefined -> Math.exp(skew * 1.5) is NaN -> every scale is poisoned;
  //   count/targetChunkCount -> per-area, so the forest is not a function of the draw radius.
  function placementParams() {
    return {
      masterSeed,
      count: expectedTreesPerChunk(cfg.treesPerHectare, cfg.treeChunkSize),
      targetChunkCount: 1,
      placement: cfg.treePlacement,
      clusterSize: cfg.treeClusterSize,
      clusterSpread: cfg.treeClusterSpread,
      species: selectedSpeciesTable?.length ?? cfg.treeSpecies,
      speciesTable: selectedSpeciesTable ?? undefined,
      diversity: cfg.treeDiversity,
      generalization: cfg.treeGeneralization,
      maxSize: cfg.treeMaxSize,
      sizeVar: cfg.treeSizeVar,
      skew: cfg.treeSkew,
      varPattern: 'random',
      waterLevel: terrain.seaLevel,
      shoreMargin: cfg.treeShoreMargin,
      treeDensityAt: coverTreeAt,
    };
  }

  function assertPlacementParams(params) {
    for (const key of ['count', 'maxSize', 'sizeVar', 'skew', 'waterLevel', 'shoreMargin', 'masterSeed']) {
      if (!Number.isFinite(params[key])) {
        throw new TypeError(`tree placement param ${key} is ${params[key]}; a non-finite value here yields a silently empty or NaN-scaled forest`);
      }
    }
  }

  // A chunk is built only once its field is actually here. Corners and centre, because a chunk can
  // straddle a tile boundary with only part of itself resident.
  function isChunkReady(chunk) {
    const x0 = chunk.xMin, x1 = chunk.xMin + chunk.size;
    const z0 = chunk.zMin, z1 = chunk.zMin + chunk.size;
    const pts = [[chunk.centerX, chunk.centerZ], [x0, z0], [x1, z0], [x0, z1], [x1, z1]];
    for (const [x, z] of pts) {
      if (terrain.coverAt(x, z) == null) return false;
      if (terrain.fieldSurfaceAt(x, z) == null) return false;
    }
    return true;
  }

  function buildChunk(chunk) {
    const t0 = now();
    const params = placementParams();
    assertPlacementParams(params);
    const recs = placementRecords([chunk], params, placementHeightAt);
    // `ground` is the drawn surface (the source, not the 8 m placement posts, which sit up to 4 m
    // off it on a slope), asked once here so the renderer never asks per tree per rebuild.
    const groundAt = typeof terrain.groundHeight === 'function' ? terrain.groundHeight : placementHeightAt;
    for (const r of recs) { r.ground = groundAt(r.x, r.z); r.y = r.ground + cfg.treeVerticalOffset; }
    // The shore gate ran on the posts; run it again on the real surface, or a slope the posts read
    // as dry roots a trunk in the sea. Deterministic, so every peer drops the same trees.
    const shore = (terrain.seaLevel ?? -Infinity) + cfg.treeShoreMargin;
    const kept = recs.filter(r => r.ground >= shore);
    stats.shoreDropped += recs.length - kept.length;
    records.set(chunk.key, kept);
    onChunkCb?.(chunk.key, kept);
    stats.lastChunkTrees = kept.length;
    stats.lastChunkMs = now() - t0;
    stats.trees += kept.length;
  }

  function clearChunk(key) {
    const recs = records.get(key);
    if (recs) stats.trees -= recs.length;
    if (records.delete(key)) onClearCb?.(key);
  }

  function syncStats() {
    stats.resident = chunks.stats.resident;
    stats.queued = chunks.stats.queued;
    stats.deferred = chunks.stats.deferred;
    stats.chunkSize = chunks.chunkSize;
    stats.radiusChunks = chunks.radiusChunks;
    stats.expectedPerChunk = expectedTreesPerChunk(cfg.treesPerHectare, cfg.treeChunkSize);
    stats.requestedTrees = stats.expectedPerChunk * chunks.stats.resident;
    stats.coverThinning = stats.requestedTrees > 0 ? 1 - stats.trees / stats.requestedTrees : 0;
    stats.seed = masterSeed;
  }

  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    stats.enabled = next;
    if (enabled) releaseFields ??= terrain.acquireFields();
    else { releaseFields?.(); releaseFields = null; clearAll(); }
    syncStats();
  }

  function clearAll() {
    chunks.clear();
    chunks.drain({ drain: true });
    forgetRecords();
    syncStats();
  }

  // Every resident chunk dropped at once, telling the renderer about each one.
  function forgetRecords() {
    if (onClearCb) for (const key of records.keys()) onClearCb(key);
    records.clear();
    stats.trees = 0;
  }

  return {
    stats,
    get enabled() { return enabled; },
    get seed() { return masterSeed; },
    get records() { return records; },
    get residentKeys() { return chunks.residentKeys; },
    recordsFor(key) { return records.get(key) ?? null; },
    // Every record currently resident, in global coordinates. The renderer's input.
    allRecords() {
      const out = [];
      for (const recs of records.values()) out.push(...recs);
      return out;
    },
    setEnabled,
    // The renderer's hooks. onChunk fires for each chunk placed, onClear when one leaves.
    setListeners({ onChunk = null, onClear = null } = {}) {
      onChunkCb = onChunk; onClearCb = onClear;
      if (onChunkCb) for (const [key, recs] of records) onChunkCb(key, recs);
    },
    // What placementRecords is being called with. The palette has to bake the SAME species table,
    // so it reads the species/diversity/generalization from here rather than keeping its own copy.
    get placementParams() { return placementParams(); },
    // One frame's worth: move the window, then place what the budget allows.
    update(x, z) {
      if (!enabled) return 0;
      const t0 = now();
      chunks.syncToFocus(x, z);
      const built = chunks.drain();
      stats.placeMs = now() - t0;
      syncStats();
      return built;
    },
    // Placement-affecting settings changed: everything is rebuilt, but over the budget, not now.
    apply(next = {}, focus = null) {
      let identityChanged = false;
      for (const [key, value] of Object.entries(next)) {
        if (!(key in cfg) || cfg[key] === value) continue;
        cfg[key] = value;
        if (TREE_IDENTITY_KEYS.includes(key)) identityChanged = true;
        if (key === 'treeSeedOffset') masterSeed = treeSeedFor(terrain.source?.descriptor, value);
        if (key === 'treeSpeciesSelection' || key === 'treeMaxSize') {
          selectedSpeciesTable = speciesTableForSelection(cfg.treeSpeciesSelection, { maxSize: cfg.treeMaxSize });
        }
      }
      if (cfg.treeChunkSize !== chunks.chunkSize) {
        chunks.clear(); chunks.drain({ drain: true });
        forgetRecords();
        chunks = makeHost();
      }
      chunks.setRadiusChunks(radiusChunksFor(cfg.treeRadius, cfg.treeChunkSize));
      chunks.setBudget({ budgetChunks: cfg.treeBudgetChunks, budgetMs: cfg.treeBudgetMs });
      if (identityChanged && focus) { forgetRecords(); chunks.rebuildAll(focus[0], focus[1]); }
      syncStats();
      return identityChanged;
    },
    get config() { return { ...cfg }; },
    dispose() {
      setEnabled(false);
      clearAll();
    },
  };
}
