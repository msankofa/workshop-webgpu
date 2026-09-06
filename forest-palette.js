// forest-palette.js — bake a fixed set of tree variant geometries ONCE (browser).
// The expensive procedural generation runs species x VARIANTS times total at startup,
// not per tree per chunk. Each variant is the generator's branch/leaf/shadow geometry
// with a FLAT per-species color attribute baked in (bark color on branches, leaf tint
// on leaves + shadow) — this replicates the baker's appendGeom flat-color step
// (environment-viewer.html:884-888), because the generator geometry has no color
// attribute and the materials use vertexColors:true.
import * as THREE from 'three';
import { buildSpecies, rngFrom } from './forest-placement.js';

// fill a clone of `geom` with a flat per-vertex color (hex -> rgb), matching appendGeom.
function bakeFlatColor(geom, hex) {
  const g = geom.clone();
  const n = g.attributes.position.count;
  const r = ((hex >> 16) & 255) / 255, gc = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = gc; col[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// Build the per-species leaf/bark options the same way the baker does
// (environment-viewer.html:862-878). In authored mode the leaves switch to the larger
// 'quad' atlas billboards (cell = speciesIdx % atlasCells); procedural uses 'simple'.
export function leafOptsFor(sp, params, texSet, spIdx) {
  const leafOpts = { ...sp.leaves, shadowFraction: params.leafShadowPct };
  leafOpts.count = Math.max(0, Math.floor(params.leafCount ?? sp.leaves.count ?? 10));
  leafOpts.size = sp.leaves.size * (params.leafSize ?? 1);
  if (params.leafStart !== undefined) leafOpts.start = params.leafStart;
  if (params.leafSpread !== undefined) leafOpts.spread = params.leafSpread;
  const useAtlas = texSet && texSet.mode && texSet.mode !== 'procedural' && texSet.leafAtlas;
  if (useAtlas) {
    const cells = texSet.leafAtlas.cols * texSet.leafAtlas.rows;
    leafOpts.shape = 'quad';
    // An AUTHORED species names its own cell (the ez families pin oak 0 / aspen 1 / ash 2 / pine 3,
    // matching tree-textures.js's LEAF_FILES), and that is real data, not a default to be improved
    // on. `spIdx % cells` is only right for buildSpecies()' procedural species, which carry no
    // atlas at all — applied to a family table it hands two of the three pines broadleaves.
    const authored = sp.leaves?.atlas?.cell;
    const cell = Number.isInteger(authored) && authored >= 0 && authored < cells
      ? authored
      : spIdx % cells;
    leafOpts.atlas = { cols: texSet.leafAtlas.cols, rows: texSet.leafAtlas.rows, cell };
  } else {
    leafOpts.shape = 'simple';
  }
  return leafOpts;
}

// createTree: the generator factory from trees.js. params/masterSeed: the same forest
// params + master seed the placement uses (so species match placementRecords). texSet:
// the active texture set (or null) — drives leaf shape (quad vs simple) and bark vScale,
// so the palette must be rebaked when texMode changes.
export function createPaletteState({ createTree, params, masterSeed, variantsPerSpecies = 4, texSet = null }) {
  // An authored species table (from buildSpeciesFromFamilies) takes over when present;
  // its entries are full trees.js opts objects too, so nothing else below needs to change.
  const species = params.speciesTable || buildSpecies(params, rngFrom(masterSeed));
  const variants = [];
  return { gen: null, createTree, species, variants, params, masterSeed, variantsPerSpecies, texSet, bakeMs: 0 };
}

export function bakeVariant(state, s, v) {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { species, variants, params, masterSeed, texSet } = state;
  const sp = species[s];
  const leafOpts = leafOptsFor(sp, params, texSet, s);
  const barkOpts = { ...sp.bark };
  if (texSet && texSet.barkVScale !== undefined) barkOpts.vScale = texSet.barkVScale;
  const seed = Math.floor(rngFrom(masterSeed + s * 977 + v * 131).next() * 0xffffffff) >>> 0;
  const options = { ...sp, seed, leaves: leafOpts, bark: barkOpts, branchLods: params.branchLods ?? [] };
  // Tree's constructor generates immediately. Start with the first real variant instead of
  // generating a seed-1 default tree whose geometry would be overwritten without ever used.
  if (!state.gen) state.gen = state.createTree(options);
  else state.gen.regenerate(options);
  const gen = state.gen;
  const branchesGeo = bakeFlatColor(gen.branchesMesh.geometry, sp.bark.color);
  const branchesLod1Geo = gen.branchLodGeometries[0]
    ? bakeFlatColor(gen.branchLodGeometries[0], sp.bark.color) : null;
  const branchesLod2Geo = gen.branchLodGeometries[1]
    ? bakeFlatColor(gen.branchLodGeometries[1], sp.bark.color) : null;
  const leavesGeo = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);
  const shadowGeo = bakeFlatColor(gen.leavesShadowMesh.geometry, sp.leaves.tint);

  const ratio = Math.max(0.05, Math.min(1.0, params.coarseLeafRatio ?? 0.25));
  const sizeMult = Math.max(1.0, params.coarseLeafSizeMult ?? 2.5);
  const coarseLeafOpts = {
    ...leafOpts,
    count: Math.max(1, Math.round(leafOpts.count * ratio)),
    size: leafOpts.size * sizeMult,
    shadowFraction: 0,
  };
  gen.regenerateLeaves(coarseLeafOpts);
  const leavesCoarseGeo = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);

  // LOD1 leaves: an intermediate bake between full and coarse. At the 1/1 defaults it is the full
  // leaf geometry itself (same object), so hosts that never set it bake and draw exactly as before.
  const midRatio = Math.max(0.05, Math.min(1.0, params.midLeafRatio ?? 1));
  const midSize = Math.max(1.0, params.midLeafSizeMult ?? 1);
  let leavesMidGeo = leavesGeo;
  if (midRatio !== 1 || midSize !== 1) {
    gen.regenerateLeaves({
      ...leafOpts, count: Math.max(1, Math.round(leafOpts.count * midRatio)), size: leafOpts.size * midSize, shadowFraction: 0,
    });
    leavesMidGeo = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);
  }

  const variant = {
    speciesIdx: s,
    variant: v,
    branches: branchesGeo,
    branchesLod1: branchesLod1Geo,
    branchesLod2: branchesLod2Geo,
    leaves: leavesGeo,
    leavesMid: leavesMidGeo,
    shadow: shadowGeo,
    leavesCoarse: leavesCoarseGeo,
  };
  // Keep species-major slot order even when the async baker visits one variant from every family.
  variants[s * state.variantsPerSpecies + v] = variant;
  state.bakeMs += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
  return variant;
}

export function finishPalette(state) {
  return {
    variants: state.variants,
    variantsPerSpecies: state.variantsPerSpecies,
    speciesCount: state.species.length,
    bakeMs: state.bakeMs,
  };
}

export function createForestPalette(opts) {
  const state = createPaletteState(opts);
  for (let s = 0; s < state.species.length; s++) {
    for (let v = 0; v < state.variantsPerSpecies; v++) bakeVariant(state, s, v);
  }
  return finishPalette(state);
}

// Base Game enables trees at runtime, so baking the entire palette in the caller's frame creates a
// visible hitch. This twin keeps the synchronous API for existing hosts and yields between variants.
// `shouldContinue` lets a host abort a stale bake after disable/rebuild without finishing dead work.
export async function createForestPaletteAsync(opts, {
  yieldFn = async () => {},
  shouldContinue = () => true,
  onFamilyWave = null,
} = {}) {
  const state = createPaletteState(opts);
  const total = state.species.length * state.variantsPerSpecies;
  let built = 0;
  // Breadth-first across species: each wave contains the same variant number from every family.
  // A host can publish that complete wave, avoiding a temporary forest made from only one family.
  for (let v = 0; v < state.variantsPerSpecies; v++) {
    const wave = [];
    for (let s = 0; s < state.species.length; s++) {
      if (!shouldContinue()) return null;
      wave.push(bakeVariant(state, s, v));
      built++;
      if (s + 1 < state.species.length) await yieldFn();
    }
    if (!shouldContinue()) return null;
    if (onFamilyWave) {
      const keepGoing = await onFamilyWave({
        variant: v,
        variants: wave,
        palette: { ...finishPalette(state), variants: [...state.variants] },
        built,
        total,
      });
      if (keepGoing === false || !shouldContinue()) return null;
    }
    if (built < total) await yieldFn();
  }
  return shouldContinue() ? finishPalette(state) : null;
}

// Strip textures and functions so a params object survives structured clone into the worker.
function cloneableParams(params) {
  return JSON.parse(JSON.stringify(params, (k, v) => (k === 'map' || k === 'normalMap' || typeof v === 'function' ? undefined : v)));
}

// The bake in a module worker (forest-palette-worker.js). `bake()` has createForestPaletteAsync's
// contract (same opts, same callbacks, same wave order) so a host swaps one call for the other,
// and it falls back to the in-thread async bake when no worker can be made (file://, no module
// workers, or the worker fails before its first variant).
export function createForestPaletteWorker({ threeUrl = null, deserialize = null } = {}) {
  let worker = null, ready = null, failed = false;
  let job = null;
  const listeners = new Map();

  function start() {
    if (worker || failed) return ready;
    try {
      const url = threeUrl ?? import.meta.resolve?.('three');
      if (!url) throw new Error('cannot resolve three for the worker');
      worker = new Worker(new URL('./forest-palette-worker.js', import.meta.url), { type: 'module' });
      ready = new Promise((resolve, reject) => {
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.jobType === 'ready') { resolve(true); return; }
          if (msg.jobType === 'error' && !msg.key) { reject(new Error(msg.error)); return; }
          listeners.get(msg.key)?.(msg);
        };
        worker.onerror = (err) => { reject(err); fail(); };
        worker.postMessage({ jobType: 'init', threeUrl: url, baseUrl: import.meta.url });
      }).catch(() => { fail(); return false; });
    } catch {
      fail();
      ready = Promise.resolve(false);
    }
    return ready;
  }
  function fail() {
    failed = true;
    worker?.terminate();
    worker = null;
    for (const l of listeners.values()) l({ jobType: 'error', error: 'worker failed' });
    listeners.clear();
  }

  async function bake(opts, { yieldFn = async () => {}, shouldContinue = () => true, onFamilyWave = null } = {}) {
    const ok = await start();
    if (!ok || !shouldContinue()) return ok ? null : createForestPaletteAsync(opts, { yieldFn, shouldContinue, onFamilyWave });
    if (!deserialize) ({ deserializePalette: deserialize } = await import('./forest-palette-io.js'));
    const state = createPaletteState(opts);
    const total = state.species.length * state.variantsPerSpecies;
    const key = `bake-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    job = key;
    const { texSet } = state;
    const msg = {
      jobType: 'bake', key, params: cloneableParams(state.params), masterSeed: state.masterSeed,
      variantsPerSpecies: state.variantsPerSpecies,
      texSet: texSet ? { mode: texSet.mode, barkVScale: texSet.barkVScale,
        leafAtlas: texSet.leafAtlas ? { cols: texSet.leafAtlas.cols, rows: texSet.leafAtlas.rows } : null } : null,
    };
    let firstVariant = false;
    const cancel = () => { worker?.postMessage({ jobType: 'cancel', key }); listeners.delete(key); };
    return new Promise((resolve, reject) => {
      let wave = [], waveIdx = 0, chain = Promise.resolve(true);
      listeners.set(key, (m) => {
        chain = chain.then(async (alive) => {
          if (!alive) return false;
          if (!shouldContinue()) { cancel(); resolve(null); return false; }
          if (m.jobType === 'error') {
            listeners.delete(key);
            if (firstVariant) reject(new Error(m.error));
            else resolve(createForestPaletteAsync(opts, { yieldFn, shouldContinue, onFamilyWave }));
            return false;
          }
          if (m.jobType === 'cancelled') { listeners.delete(key); resolve(null); return false; }
          if (m.jobType === 'variant') {
            firstVariant = true;
            const variant = deserialize(m.buffer).variants[0];
            state.variants[m.speciesIdx * state.variantsPerSpecies + m.variant] = variant;
            state.bakeMs = m.bakeMs;
            wave.push(variant);
            if (wave.length === state.species.length) {
              const published = wave; wave = [];
              if (onFamilyWave) {
                const keepGoing = await onFamilyWave({
                  variant: waveIdx, variants: published,
                  palette: { ...finishPalette(state), variants: [...state.variants] }, built: m.built, total,
                });
                if (keepGoing === false || !shouldContinue()) { cancel(); resolve(null); return false; }
              }
              waveIdx++;
            }
            await yieldFn();
            return true;
          }
          if (m.jobType === 'done') {
            listeners.delete(key);
            state.bakeMs = m.bakeMs;
            resolve(shouldContinue() ? finishPalette(state) : null);
            return false;
          }
          return true;
        });
      });
      worker.postMessage(msg);
    });
  }

  return {
    bake,
    get available() { return !failed; },
    cancel() { if (job && worker) worker.postMessage({ jobType: 'cancel', key: job }); },
    dispose() { worker?.terminate(); worker = null; failed = true; listeners.clear(); },
  };
}
