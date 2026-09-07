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
// One frame is kept aside: the worst the trace has seen since it was last cleared, with its whole
// scenes array. The frame a capture button lands on is not the frame that dipped, and the encode's
// p50 and its max are 12 ms and 60 ms apart, so without this the spikes are never named.
//
// The encode hook also attributes its time per (object, material), because a scene's encode cost has
// turned out not to be proportional to its object count -- 93 objects cost the same 11-12 ms as 202
// -- so the question is which few objects are expensive, not how many there are.
//
// A child is charged only to the parent phases that were open when it started: a nested render can
// begin before the parent reaches its object loop, and subtracting it from a timer it never ran
// inside would understate that timer. Nothing is clamped, so an accounting mistake shows up as a
// negative number instead of as a plausible zero.
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
    // Time nested scene renders spent inside each phase timer of this entry, subtracted on close.
    childInPhase: { project: 0, objects: 0, encode: 0, bundle: 0, sort: 0 },
    // What each drawn object cost in this scene render: descriptor -> { ms, calls }.
    perObject: new Map(),
  };
}

// What a scene render is: three renames the scene to `Shadow Map [ <light> ]` across a shadow pass,
// and the post chain's output quad renders a QuadMesh with an orthographic camera, so the name and
// the camera together tell main, shadow, mirror and quad apart in the record.
const PHASES = ['project', 'sort', 'objects', 'encode', 'bundle'];
const PHASE_MS = { project: 'projectMs', sort: 'sortMs', objects: 'objectsMs', encode: 'encodeMs', bundle: 'bundleMs' };

function describe(scene, camera) {
  const name = scene?.name || scene?.type || 'scene';
  const cam = camera ? (camera.name || camera.type || 'camera') : 'none';
  return { name, camera: cam };
}

// How many rows a scene entry reports. Long enough to show a heavy handful, short enough that a
// capture stays readable.
const TOP_OBJECTS = 12;

// One descriptor per (object, material) pair, built once and reused every frame, so the hot path
// costs two map lookups and no string work. Weak on the object, so a disposed mesh is collectable.
const descriptorCache = new WeakMap();

const UNKNOWN_OBJECT = { name: 'unknown', material: 'none' };

function describeObject(object, material) {
  if (!object) return UNKNOWN_OBJECT;   // one shared descriptor, so unnamed draws fold into one row
  let byMaterial = descriptorCache.get(object);
  if (byMaterial === undefined) { byMaterial = new Map(); descriptorCache.set(object, byMaterial); }
  let descriptor = byMaterial.get(material);
  if (descriptor === undefined) {
    descriptor = { name: object.name || object.type || 'object', material: material?.type ?? 'none' };
    byMaterial.set(material, descriptor);
  }
  return descriptor;
}

// The main scene render of a frame: the one that encoded the most objects. Picking by time would
// always pick the post chain's quad, which encodes one object and wraps the world render.
function mainScene(entries) {
  let best = null;
  for (const entry of entries) if (best === null || entry.objects > best.objects) best = entry;
  return best;
}

// The heaviest objects of one scene render, and how much of its encode they account for.
function topObjects(entry) {
  const rows = [];
  for (const [descriptor, cost] of entry.perObject) {
    rows.push({ name: descriptor.name, material: descriptor.material, ms: cost.ms, calls: cost.calls });
  }
  rows.sort((a, b) => b.ms - a.ms);
  const top = rows.slice(0, TOP_OBJECTS);
  let sum = 0;
  for (const row of top) { sum += row.ms; row.ms = round3(row.ms); }
  return { top, topShare: entry.encodeMs > 0 ? round3(sum / entry.encodeMs) : 0 };
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
  let patchedLists = [];
  // Two worst frames, because "worst" has two meanings here and picking one silently would hide
  // the other: `worst` is the heaviest total scene time, `worstEncode` the heaviest encode.
  let worst = null, worstEncode = null;
  let frameCount = 0;
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
      const parent = current();
      // Which of the parent's phases this child runs inside, read as it starts: the depth counters
      // already say which of the parent's timers are open.
      const openPhases = PHASES.filter(phase => parent.depth[phase] > 0);
      scenes.push(entry);
      stack.push(entry);
      const t0 = now();
      try {
        return original.apply(this, args);
      } finally {
        stack.pop();
        entry.ms = now() - t0;
        // Its own children come out of its own numbers: all of them out of the scene time, and each
        // out of exactly the phases that were open around it.
        entry.exclusiveMs = entry.ms - entry.childMs;
        for (const phase of PHASES) entry[PHASE_MS[phase]] -= entry.childInPhase[phase];
        parent.childMs += entry.ms;
        for (const phase of openPhases) parent.childInPhase[phase] += entry.ms;
      }
    };
    restore.push(() => { renderer._renderScene = original; });
  }

  // The per-object hook. Same shape as wrapPhase, plus the per-(object, material) accumulation and
  // the subtraction of any scene render that nested inside this one draw.
  function wrapEncode(renderer) {
    const original = renderer._renderObjectDirect;
    if (typeof original !== 'function') { missing.push('_renderObjectDirect'); return; }
    renderer._renderObjectDirect = function (object, material, ...rest) {
      const entry = current();
      if (entry.depth.encode > 0) return original.call(this, object, material, ...rest);
      entry.draws++;
      entry.depth.encode++;
      const childBefore = entry.childMs;
      const t0 = now();
      try {
        return original.call(this, object, material, ...rest);
      } finally {
        entry.depth.encode--;
        const ms = now() - t0;
        entry.encodeMs += ms;
        // What this one object cost, with any nested scene render taken back out, so the post
        // chain's quad does not report itself as the most expensive object in the frame.
        const own = ms - (entry.childMs - childBefore);
        const descriptor = describeObject(object, material);
        const cost = entry.perObject.get(descriptor);
        if (cost === undefined) entry.perObject.set(descriptor, { ms: own, calls: 1 });
        else { cost.ms += own; cost.calls++; }
      }
    };
    restore.push(() => { renderer._renderObjectDirect = original; });
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
        const patchedSort = function (...sortArgs) {
          const entry = current();
          if (entry.depth.sort > 0) return originalSort.apply(this, sortArgs);
          entry.sortCalls++;
          entry.depth.sort++;
          const t0 = now();
          try { return originalSort.apply(this, sortArgs); }
          finally { entry.depth.sort--; entry.sortMs += now() - t0; }
        };
        list.sort = patchedSort;
        list.__traceSort = true;
        // Render lists outlive a trace, so detach has to unpatch each one it touched.
        patchedLists.push({ list, patchedSort, originalSort });
      }
      return list;
    };
    restore.push(() => { lists.get = originalGet; });
  }

  function totals() {
    // The outside bucket is never closed by a scene exit, so it settles its own children here: a
    // bundle replayed between renders can still start a scene render.
    for (const phase of PHASES) {
      outside[PHASE_MS[phase]] -= outside.childInPhase[phase];
      outside.childInPhase[phase] = 0;
    }
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
      // The heaviest objects this pass encoded, and how much of its encode they were.
      ...topObjects(entry),
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
      wrapEncode(renderer);
      wrapPhase(renderer, '_renderBundle', 'bundle', 'bundleMs', entry => { entry.bundles++; });
      patchLists(renderer);
      attachedTo = restore.length ? renderer : null;
      return this.attached;
    },
    detach() {
      for (const undo of restore.reverse()) undo();
      restore = [];
      // Identity checked, never assumed: if something else wrapped a sort after we did, putting our
      // original back would silently uninstall the later owner's hook.
      for (const { list, patchedSort, originalSort } of patchedLists) {
        if (list.sort !== patchedSort) continue;
        list.sort = originalSort;
        delete list.__traceSort;
      }
      patchedLists = [];
      attachedTo = null;
    },
    // Totals since the last take, then reset. `scenes` is the primary result and the totals are
    // sums over it; scene milliseconds are exclusive, so they add up to the frame rather than
    // counting a nested render inside its parent as well.
    take() {
      const out = totals();
      // The heaviest frames since the last clear, kept whole -- rows included -- because a capture
      // otherwise only ever reports the frame its button happened to land on. The frame number and
      // the clock reading come with them, so a spike can be lined up against the frame's other
      // events.
      frameCount++;
      if (out.sceneRenders > 0) {
        const main = mainScene(out.scenes);
        const record = {
          frame: frameCount, at: round3(now()),
          metric: 'mainSceneEncodeMs', metricMs: main ? main.encodeMs : 0,
          mainScene: main ? main.name : null,
          sceneMs: out.sceneMs, encodeMs: out.encodeMs, scenes: out.scenes,
        };
        if (worstEncode === null || record.metricMs > worstEncode.metricMs) worstEncode = record;
        if (worst === null || out.sceneMs > worst.sceneMs) worst = record;
      }
      scenes = [];
      outside = newEntry('outside', 'none');
      stack.length = 0;
      return out;
    },
    // The retained worst frames, or null. Reading does not clear, so a caller can keep a running
    // copy every frame. `worst` is by total scene time, `worstEncode` by the main scene's encode
    // time, which is the metric the record names; they are one record when a frame is worst by both.
    get worst() { return worst; },
    get worstEncode() { return worstEncode; },
    // Fields the host knows and the trace does not -- the frame's event deltas, its speed, how far
    // into a capture it happened -- attached to whichever retained record is the frame just taken.
    annotateWorst(fields) {
      if (worst !== null && worst.frame === frameCount) Object.assign(worst, fields);
      if (worstEncode !== null && worstEncode.frame === frameCount) Object.assign(worstEncode, fields);
    },
    // Both records, and the trace starts looking again: called when a capture begins, so the spike
    // reported is one from inside the measured window.
    takeWorst() {
      const out = { worst, worstEncode };
      worst = null;
      worstEncode = null;
      return out;
    },
  };
}
