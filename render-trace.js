// render-trace.js — attributes one frame of Three's WebGPU renderer to its own phases.
//
// `passPostMs` is a single timer around `renderer.render`, so it cannot say whether the cost is the
// scene walk, the render-list sort, or the per-object encode. This wraps the five private methods
// those phases live in (`_renderScene`, `_projectObject`, `_renderObjects`, `_renderObjectDirect`,
// `_renderBundle`) plus each render list's `sort`.
//
// Scene renders NEST. A page rendering through a post chain draws a full-screen quad whose single
// object's encode runs the real scene render inside it via the pass node's updateBefore, and the
// shadow and mirror renders nest the same way. So scene renders are kept on a stack: each one is
// its own entry, timed inclusively and reported with its children's time subtracted, which is why
// `scenes` is the primary output and the totals are sums over it. Without that, one frame reads as
// a single object costing the whole render.
//
// Private methods are a deliberate trade: they are the only seam Three gives here, so `attach`
// reports which hooks it actually found and the caller records that beside the numbers.

function round3(v) {
  return Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;
}

function newEntry(name, camera) {
  return {
    name, camera,
    ms: 0, exclusiveMs: 0, childMs: 0,
    projectCalls: 0, projectMs: 0,
    sortCalls: 0, sortMs: 0,
    objectListCalls: 0, objectsMs: 0,
    objects: 0, draws: 0, encodeMs: 0,
    bundles: 0, bundleMs: 0,
    // Re-entry counters, per scene: projection recurses, and a phase must not be timed twice.
    depth: { project: 0, objects: 0, encode: 0, bundle: 0, sort: 0 },
  };
}

// What a scene render is: three renames the scene to `Shadow Map [ <light> ]` across a shadow pass,
// and the post chain's output quad renders a QuadMesh with an orthographic camera, so the name and
// the camera together tell main, shadow, mirror and quad apart in the record.
function describe(scene, camera) {
  const name = scene?.name || scene?.type || 'scene';
  const cam = camera ? (camera.name || camera.type || 'camera') : 'none';
  return { name, camera: cam };
}

export function createRenderTrace({ now = () => performance.now() } = {}) {
  let scenes = [];
  // Work outside any scene render still has to land somewhere; this entry is reported only if it
  // was actually used.
  let outside = newEntry('outside', 'none');
  const stack = [];
  const current = () => stack[stack.length - 1] ?? outside;
  let attachedTo = null;
  let restore = [];
  const missing = [];

  // A phase inside whichever scene render is on top of the stack. Nested scene renders push their
  // own entry, so a phase always belongs to the innermost one.
  function wrapPhase(target, name, key, msField, before) {
    const original = target[name];
    if (typeof original !== 'function') { missing.push(name); return; }
    target[name] = function (...args) {
      const entry = current();
      if (entry.depth[key] > 0) return original.apply(this, args);
      before?.(entry, args);
      entry.depth[key]++;
      const t0 = now();
      try {
        return original.apply(this, args);
      } finally {
        entry.depth[key]--;
        entry[msField] += now() - t0;
      }
    };
    restore.push(() => { target[name] = original; });
  }

  function wrapScene(renderer) {
    const original = renderer._renderScene;
    if (typeof original !== 'function') { missing.push('_renderScene'); return; }
    renderer._renderScene = function (...args) {
      const { name, camera } = describe(args[0], args[1]);
      const entry = newEntry(name, camera);
      scenes.push(entry);
      stack.push(entry);
      const t0 = now();
      try {
        return original.apply(this, args);
      } finally {
        stack.pop();
        entry.ms = now() - t0;
        // A nested scene render happens inside this one's encode, so its whole cost is subtracted
        // from every timer that contained it. Otherwise the post chain's output quad reports one
        // object costing the entire frame.
        entry.exclusiveMs = entry.ms - entry.childMs;
        entry.encodeMs = Math.max(0, entry.encodeMs - entry.childMs);
        entry.objectsMs = Math.max(0, entry.objectsMs - entry.childMs);
        current().childMs += entry.ms;
      }
    };
    restore.push(() => { renderer._renderScene = original; });
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
          const entry = current();
          if (entry.depth.sort > 0) return originalSort.apply(this, sortArgs);
          entry.sortCalls++;
          entry.depth.sort++;
          const t0 = now();
          try { return originalSort.apply(this, sortArgs); }
          finally { entry.depth.sort--; entry.sortMs += now() - t0; }
        };
        list.__traceSort = true;
      }
      return list;
    };
    restore.push(() => { lists.get = originalGet; });
  }

  function totals() {
    const out = {
      sceneRenders: scenes.length, sceneMs: 0,
      projectCalls: 0, projectMs: 0,
      sortCalls: 0, sortMs: 0,
      objectListCalls: 0, objectsMs: 0,
      encodedObjects: 0, encodeCalls: 0, encodeMs: 0,
      bundleGroups: 0, bundleMs: 0,
      scenes: [],
    };
    for (const entry of [...scenes, outside]) {
      // sceneMs sums the EXCLUSIVE times, so a nesting frame does not count the same work twice.
      out.sceneMs += entry.exclusiveMs;
      out.projectCalls += entry.projectCalls; out.projectMs += entry.projectMs;
      out.sortCalls += entry.sortCalls; out.sortMs += entry.sortMs;
      out.objectListCalls += entry.objectListCalls; out.objectsMs += entry.objectsMs;
      out.encodedObjects += entry.objects; out.encodeCalls += entry.draws; out.encodeMs += entry.encodeMs;
      out.bundleGroups += entry.bundles; out.bundleMs += entry.bundleMs;
    }
    for (const key of ['sceneMs', 'projectMs', 'sortMs', 'objectsMs', 'encodeMs', 'bundleMs']) out[key] = round3(out[key]);
    // One row per scene render, in the order they ran: the post chain's quad, then the shadow map,
    // the mirror and the main pass nested inside it.
    out.scenes = scenes.map(entry => ({
      name: entry.name, camera: entry.camera,
      ms: round3(entry.ms), exclusiveMs: round3(entry.exclusiveMs),
      objects: entry.objects, draws: entry.draws, bundles: entry.bundles,
      projectMs: round3(entry.projectMs), sortMs: round3(entry.sortMs),
      objectsMs: round3(entry.objectsMs), encodeMs: round3(entry.encodeMs),
    }));
    return out;
  }

  return {
    get attached() { return attachedTo !== null; },
    get missingHooks() { return [...missing]; },
    attach(renderer) {
      if (attachedTo) return this.attached;
      missing.length = 0;
      restore = [];
      wrapScene(renderer);
      wrapPhase(renderer, '_projectObject', 'project', 'projectMs', entry => { entry.projectCalls++; });
      wrapPhase(renderer, '_renderObjects', 'objects', 'objectsMs', (entry, args) => {
        entry.objectListCalls++;
        entry.objects += Array.isArray(args[0]) ? args[0].length : 0;
      });
      wrapPhase(renderer, '_renderObjectDirect', 'encode', 'encodeMs', entry => { entry.draws++; });
      wrapPhase(renderer, '_renderBundle', 'bundle', 'bundleMs', entry => { entry.bundles++; });
      patchLists(renderer);
      attachedTo = restore.length ? renderer : null;
      return this.attached;
    },
    detach() {
      for (const undo of restore.reverse()) undo();
      restore = [];
      attachedTo = null;
    },
    // Totals since the last take, then reset. `scenes` is the primary result and the totals are
    // sums over it; scene milliseconds are exclusive, so they add up to the frame rather than
    // counting a nested render inside its parent as well.
    take() {
      const out = totals();
      scenes = [];
      outside = newEntry('outside', 'none');
      stack.length = 0;
      return out;
    },
  };
}
