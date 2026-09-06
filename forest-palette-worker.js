// forest-palette-worker.js — module Web Worker that runs the forest palette bake off the render
// thread and posts each baked variant back as one transferable buffer (forest-palette-io.js).
// Import maps do not reach workers, so the page sends the resolved URL of `three` in an `init`
// job and this file loads the bake chain through a tiny specifier-rewriting loader. The
// main-thread client is `createForestPaletteWorker()` in forest-palette.js; `runBakeJob` is the
// job itself, exported so Node can run it against the same inputs as the sync bake.

// Loads a module by URL with `three` and relative imports rewritten to absolute or blob URLs.
async function loadModule(url, threeUrl, cache = new Map()) {
  if (cache.has(url)) return cache.get(url);
  const pending = (async () => {
    const text = await (await fetch(url)).text();
    const specs = [...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    const map = new Map();
    for (const spec of new Set(specs)) {
      if (spec === 'three') map.set(spec, threeUrl);
      else if (spec.startsWith('.')) map.set(spec, await loadModule(new URL(spec, url).href, threeUrl, cache).then(m => m.__url));
    }
    const rewritten = text.replace(/((?:from|import)\s*['"])([^'"]+)(['"])/g, (all, a, spec, c) =>
      map.has(spec) ? `${a}${map.get(spec)}${c}` : all);
    const blob = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
    const mod = await import(blob);
    return Object.assign(Object.create(mod), { __url: blob });
  })();
  cache.set(url, pending);
  return pending;
}

// Bakes one palette breadth-first (variant-major, species-minor, the same order as
// createForestPaletteAsync) and posts each variant. `isCancelled` is polled between variants.
export async function runBakeJob(job, mods, post, { isCancelled = () => false, yieldFn = async () => {} } = {}) {
  const { key, params, masterSeed, variantsPerSpecies = 4, texSet = null } = job;
  const state = mods.createPaletteState({ createTree: mods.createTree, params, masterSeed, variantsPerSpecies, texSet });
  const total = state.species.length * variantsPerSpecies;
  let built = 0;
  for (let v = 0; v < variantsPerSpecies; v++) {
    for (let s = 0; s < state.species.length; s++) {
      if (isCancelled()) { post({ jobType: 'cancelled', key }); return null; }
      const variant = mods.bakeVariant(state, s, v);
      const buffer = mods.serializePalette([variant]);
      for (const geo of Object.values(variant)) if (geo?.isBufferGeometry) geo.dispose();
      built++;
      post({ jobType: 'variant', key, speciesIdx: s, variant: v, built, total, bakeMs: state.bakeMs, buffer }, [buffer]);
      await yieldFn();
    }
  }
  const done = { jobType: 'done', key, bakeMs: state.bakeMs, speciesCount: state.species.length, total };
  post(done);
  state.gen?.dispose?.();
  return done;
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  let mods = null;
  const cancelled = new Set();
  const post = (msg, transfer) => self.postMessage(msg, transfer);
  self.onmessage = async (e) => {
    const job = e.data;
    try {
      if (job.jobType === 'init') {
        const base = job.baseUrl;
        const cache = new Map();
        const [trees, palette, io] = await Promise.all([
          loadModule(new URL('./trees.js', base).href, job.threeUrl, cache),
          loadModule(new URL('./forest-palette.js', base).href, job.threeUrl, cache),
          loadModule(new URL('./forest-palette-io.js', base).href, job.threeUrl, cache),
        ]);
        mods = { createTree: trees.createTree, createPaletteState: palette.createPaletteState,
          bakeVariant: palette.bakeVariant, serializePalette: io.serializePalette };
        post({ jobType: 'ready', treesVersion: trees.TREES_VERSION });
      } else if (job.jobType === 'cancel') {
        cancelled.add(job.key);
      } else if (job.jobType === 'bake') {
        if (!mods) throw new Error('bake before init');
        cancelled.delete(job.key);
        await runBakeJob(job, mods, post, {
          isCancelled: () => cancelled.has(job.key),
          yieldFn: () => new Promise(r => setTimeout(r, 0)),
        });
        cancelled.delete(job.key);
      }
    } catch (err) {
      post({ jobType: 'error', key: job.key, error: String(err?.message || err) });
    }
  };
}
