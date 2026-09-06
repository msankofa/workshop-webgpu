// render-trace.js — attributes one frame of Three's WebGPU renderer to its own phases.
//
// `passPostMs` is a single timer around `renderer.render`, so it cannot say whether the cost is
// the scene walk, the render-list sort, or the per-object encode. This wraps the four private
// methods those phases live in (`_renderScene`, `_projectObject`, `_renderObjects`,
// `_renderObjectDirect`) plus each render list's `sort`, and reports per-frame totals.
//
// Private methods are a deliberate trade: they are the only seam Three gives here, so `attach`
// reports which hooks it actually found and the caller records that beside the numbers.

function emptyTotals() {
  return {
    sceneRenders: 0, sceneMs: 0,
    projectCalls: 0, projectMs: 0,
    sortCalls: 0, sortMs: 0,
    objectListCalls: 0, objectsMs: 0,
    encodedObjects: 0, encodeCalls: 0, encodeMs: 0,
    bundleGroups: 0, bundleMs: 0,
    // One entry per whole scene render in the frame (main, shadow map, planar mirror), in the order
    // they ran, so a per-pass object count comes from the renderer's own render lists.
    scenes: [],
  };
}

export function createRenderTrace({ now = () => performance.now() } = {}) {
  let totals = emptyTotals();
  let attachedTo = null;
  let restore = [];
  const missing = [];
  // Every hooked method reenters (a scene render encodes objects, projection recurses), so only
  // the outermost call of each is timed; nesting would count the same milliseconds twice.
  const depth = { scene: 0, project: 0, objects: 0, encode: 0, bundle: 0, sort: 0 };

  function wrap(target, name, key, before, after) {
    const original = target[name];
    if (typeof original !== 'function') { missing.push(name); return; }
    target[name] = function (...args) {
      if (depth[key] > 0) return original.apply(this, args);
      before?.(args);
      depth[key]++;
      const t0 = now();
      try {
        return original.apply(this, args);
      } finally {
        depth[key]--;
        const ms = now() - t0;
        totals[key === 'scene' ? 'sceneMs' : key === 'project' ? 'projectMs'
          : key === 'objects' ? 'objectsMs' : key === 'encode' ? 'encodeMs' : 'bundleMs'] += ms;
        after?.(ms);
      }
    };
    restore.push(() => { target[name] = original; });
  }

  // Each render list is created once per (scene, camera) and reused, so its sort is patched on
  // first sight and left patched; the flag stops a second attach from double-wrapping it.
  function patchLists(renderer) {
    const lists = renderer._renderLists;
    if (!lists || typeof lists.get !== 'function') { missing.push('_renderLists.get'); return; }
    const originalGet = lists.get;
    lists.get = function (...args) {
      const list = originalGet.apply(this, args);
      if (list && typeof list.sort === 'function' && !list.__traceSort) {
        const originalSort = list.sort;
        list.sort = function (...sortArgs) {
          if (depth.sort > 0) return originalSort.apply(this, sortArgs);
          totals.sortCalls++;
          depth.sort++;
          const t0 = now();
          try { return originalSort.apply(this, sortArgs); }
          finally { depth.sort--; totals.sortMs += now() - t0; }
        };
        list.__traceSort = true;
      }
      return list;
    };
    restore.push(() => { lists.get = originalGet; });
  }

  return {
    get attached() { return attachedTo !== null; },
    get missingHooks() { return [...missing]; },
    attach(renderer) {
      if (attachedTo) return this.attached;
      missing.length = 0;
      restore = [];
      let sceneMark = null;
      wrap(renderer, '_renderScene', 'scene', () => {
        totals.sceneRenders++;
        sceneMark = { objects: totals.encodedObjects, draws: totals.encodeCalls, bundles: totals.bundleGroups };
      }, ms => {
        totals.scenes.push({
          ms: Math.round(ms * 1000) / 1000,
          objects: totals.encodedObjects - sceneMark.objects,
          draws: totals.encodeCalls - sceneMark.draws,
          bundles: totals.bundleGroups - sceneMark.bundles,
        });
      });
      wrap(renderer, '_projectObject', 'project', () => { totals.projectCalls++; });
      wrap(renderer, '_renderObjects', 'objects', args => {
        totals.objectListCalls++;
        totals.encodedObjects += Array.isArray(args[0]) ? args[0].length : 0;
      });
      wrap(renderer, '_renderObjectDirect', 'encode', () => { totals.encodeCalls++; });
      wrap(renderer, '_renderBundle', 'bundle', () => { totals.bundleGroups++; });
      patchLists(renderer);
      attachedTo = restore.length ? renderer : null;
      return this.attached;
    },
    detach() {
      for (const undo of restore.reverse()) undo();
      restore = [];
      attachedTo = null;
    },
    // Totals since the last take, then reset. Milliseconds nest: sceneMs contains projectMs,
    // sortMs, objectsMs and bundleMs; objectsMs and bundleMs contain encodeMs.
    take() {
      const out = totals;
      totals = emptyTotals();
      return out;
    },
  };
}
