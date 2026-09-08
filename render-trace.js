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
//
// The per-object encode is itself six stages (`_renderObjectDirect` at three.webgpu.js:61284 calls
// `needsRefresh` and then nodes/geometries/nodes/bindings updates, `Pipelines.updateForRender`
// unconditionally, and `backend.draw`), so those six are wrapped on the renderer's own manager
// instances as further phases. Nodes and bindings also keep per-(object, material) rows, because
// those two are where the sampling profile put the render path's largest named slice.
//
// `timePhases: false` installs every wrapper and every counter but makes each timer read zero, so a
// capture can be run twice and say what the instrumentation itself costs.

function round3(v) {
  return Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;
}

function newEntry(name, camera, cameraType) {
  return {
    name, camera, cameraType,
    ms: 0, exclusiveMs: 0, childMs: 0,
    projectCalls: 0, projectMs: 0,
    sortCalls: 0, sortMs: 0,
    objectListCalls: 0, objectsMs: 0,
    objects: 0, draws: 0, encodeMs: 0,
    bundles: 0, bundleMs: 0,
    // The six stages inside one object's encode, each an exclusive timer like the phases above.
    nodesBeforeMs: 0, geometriesMs: 0, nodesRenderMs: 0, bindingsMs: 0, pipelinesMs: 0, drawMs: 0,
    // Counters, not times: how many objects took the needsRefresh branch, how many distinct
    // materials this pass saw, and what the backend was asked to create or write.
    refreshes: 0, refreshChecks: 0,
    bindingCreates: 0, bindingWrites: 0, bindingWriteBytes: 0,
    attributeWrites: 0, attributeWriteBytes: 0,
    materials: new Set(),
    // Re-entry counters, per scene: projection recurses, and a phase must not be timed twice.
    depth: newPhaseCounters(),
    // Time nested scene renders spent inside each phase timer of this entry, subtracted on close.
    childInPhase: newPhaseCounters(),
    // What each drawn object cost in this scene render: descriptor -> { ms, calls }.
    perObject: new Map(),
    // The same shape for the two heaviest new phases, kept apart so the tables stay readable.
    perNodes: new Map(),
    perBindings: new Map(),
  };
}

// What a scene render is: three renames the scene to `Shadow Map [ <light> ]` across a shadow pass,
// and the post chain's output quad renders a QuadMesh with an orthographic camera, so the name and
// the camera together tell main, shadow, mirror and quad apart in the record.
const PHASES = ['project', 'sort', 'objects', 'encode', 'bundle',
  'nodesBefore', 'geometries', 'nodesRender', 'bindings', 'pipelines', 'draw'];
const PHASE_MS = { project: 'projectMs', sort: 'sortMs', objects: 'objectsMs', encode: 'encodeMs', bundle: 'bundleMs',
  nodesBefore: 'nodesBeforeMs', geometries: 'geometriesMs', nodesRender: 'nodesRenderMs',
  bindings: 'bindingsMs', pipelines: 'pipelinesMs', draw: 'drawMs' };

// One zeroed slot per phase, used for both the re-entry depths and the child subtraction.
function newPhaseCounters() {
  const out = {};
  for (const phase of PHASES) out[phase] = 0;
  return out;
}

function describe(scene, camera) {
  const name = scene?.name || scene?.type || 'scene';
  const cam = camera ? (camera.name || camera.type || 'camera') : 'none';
  // The type as well as the label: a named camera reports its name, and the main-scene rule has to
  // ask what kind of camera it is, not what it is called.
  return { name, camera: cam, cameraType: camera?.type ?? 'none' };
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

// The main scene render of a frame: the perspective-camera pass that ISSUED the most draws.
// Not `objects`, which is the render list's length: a shadow pass can list 240 objects and draw 32
// of them, and picking by list length labelled that the main scene over a world render of 206
// listed and 218 drawn, reporting an 11 ms shadow encode as the frame's worst instead of 58 ms.
// Not time either, or the post chain's quad -- one draw, wrapping everything -- always wins.
function mainScene(entries) {
  let best = null;
  for (const entry of entries) {
    if (entry.cameraType !== 'PerspectiveCamera') continue;
    if (best === null || entry.draws > best.draws) best = entry;
  }
  if (best !== null) return best;
  // No perspective pass at all (a shadow-only frame, or a camera three did not name): the most
  // draws of anything, which is still nearer the truth than the longest list.
  for (const entry of entries) if (best === null || entry.draws > best.draws) best = entry;
  return best;
}

// The heaviest objects of one map, and how much of `phaseMs` they account for.
function topRows(map, phaseMs) {
  const rows = [];
  for (const [descriptor, cost] of map) {
    rows.push({ name: descriptor.name, material: descriptor.material, ms: cost.ms, calls: cost.calls });
  }
  rows.sort((a, b) => b.ms - a.ms);
  const top = rows.slice(0, TOP_OBJECTS);
  let sum = 0;
  for (const row of top) { sum += row.ms; row.ms = round3(row.ms); }
  return { top, share: phaseMs > 0 ? round3(sum / phaseMs) : 0 };
}

// The heaviest objects of one scene render, and how much of its encode they account for.
function topObjects(entry) {
  const encode = topRows(entry.perObject, entry.encodeMs);
  const nodes = topRows(entry.perNodes, entry.nodesBeforeMs + entry.nodesRenderMs);
  const bindings = topRows(entry.perBindings, entry.bindingsMs);
  return {
    top: encode.top, topShare: encode.share,
    // The two heaviest new phases keep their own rows; the other four are per-scene totals only,
    // so the table does not sextuple.
    topNodes: nodes.top, topNodesShare: nodes.share,
    topBindings: bindings.top, topBindingsShare: bindings.share,
  };
}

// A number a caller may or may not have: a byte count only where the argument exposes one.
function byteLengthOf(value) {
  if (!value || typeof value !== 'object') return 0;
  const direct = value.byteLength;
  if (Number.isFinite(direct)) return direct;
  const array = value.array?.byteLength;
  return Number.isFinite(array) ? array : 0;
}

// What WebGPUAttributeUtils.updateAttribute will write: one writeBuffer per update range, or the
// whole array when there are none. Ranges count elements, so bytes follow the array's element size.
function attributeBytesOf(attribute) {
  const ranges = attribute?.updateRanges;
  if (Array.isArray(ranges) && ranges.length > 0) {
    const bpe = attribute.array?.BYTES_PER_ELEMENT ?? attribute.data?.array?.BYTES_PER_ELEMENT ?? 4;
    let total = 0;
    for (const r of ranges) total += (r.count | 0) * bpe;
    return total;
  }
  return byteLengthOf(attribute);
}

export function createRenderTrace({ now = () => performance.now(), timePhases = true } = {}) {
  // Overhead mode: every wrapper and every counter is installed, but the clock is a constant, so a
  // capture run this way carries the wrappers' own cost and nothing else. Reported as `timed`.
  const tick = timePhases ? now : () => 0;
  let scenes = [];
  // Work outside any scene render still has to land somewhere; this entry is reported only if it
  // was actually used.
  let outside = newEntry('outside', 'none', 'none');
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
  function wrapPhase(target, name, key, msField, before, label = name) {
    const original = target?.[name];
    if (typeof original !== 'function') { missing.push(label); return; }
    target[name] = function (...args) {
      const entry = current();
      if (entry.depth[key] > 0) return original.apply(this, args);
      before?.(entry, args);
      entry.depth[key]++;
      const t0 = tick();
      try {
        return original.apply(this, args);
      } finally {
        entry.depth[key]--;
        entry[msField] += tick() - t0;
      }
    };
    restore.push(() => { target[name] = original; });
  }

  // A phase inside the per-object encode. Same timing rule, plus per-(object, material) rows when
  // `mapField` is given: these methods take the RenderObject, which carries both.
  function wrapObjectPhase(target, name, key, msField, label, mapField = null) {
    const original = target?.[name];
    if (typeof original !== 'function') { missing.push(label); return; }
    target[name] = function (renderObject, ...rest) {
      const entry = current();
      if (entry.depth[key] > 0) return original.call(this, renderObject, ...rest);
      if (renderObject?.material !== undefined) entry.materials.add(renderObject.material);
      entry.depth[key]++;
      const childBefore = entry.childMs;
      const t0 = tick();
      try {
        return original.call(this, renderObject, ...rest);
      } finally {
        entry.depth[key]--;
        const ms = tick() - t0;
        entry[msField] += ms;
        if (mapField !== null) {
          // A nested scene render started inside this stage comes back out, the same rule the
          // encode rows use, so a reflector's whole world render is not one object's binding cost.
          const own = ms - (entry.childMs - childBefore);
          const descriptor = describeObject(renderObject?.object, renderObject?.material);
          const cost = entry[mapField].get(descriptor);
          if (cost === undefined) entry[mapField].set(descriptor, { ms: own, calls: 1 });
          else { cost.ms += own; cost.calls++; }
        }
      }
    };
    restore.push(() => { target[name] = original; });
  }

  // Counters, not timers: the wrapped call is not timed, only counted, so these cost one call.
  // `measure` reads the arguments BEFORE the call: the backend clears an attribute's update ranges as it uploads them.
  function wrapCounter(target, name, label, count, measure = null) {
    const original = target?.[name];
    if (typeof original !== 'function') { missing.push(label); return; }
    target[name] = function (...args) {
      const measured = measure ? measure(args) : undefined;
      const result = original.apply(this, args);
      count(current(), result, args, measured);
      return result;
    };
    restore.push(() => { target[name] = original; });
  }

  function wrapScene(renderer) {
    const original = renderer._renderScene;
    if (typeof original !== 'function') { missing.push('_renderScene'); return; }
    renderer._renderScene = function (...args) {
      const { name, camera, cameraType } = describe(args[0], args[1]);
      const entry = newEntry(name, camera, cameraType);
      const parent = current();
      // Which of the parent's phases this child runs inside, read as it starts: the depth counters
      // already say which of the parent's timers are open.
      const openPhases = PHASES.filter(phase => parent.depth[phase] > 0);
      scenes.push(entry);
      stack.push(entry);
      const t0 = tick();
      try {
        return original.apply(this, args);
      } finally {
        stack.pop();
        entry.ms = tick() - t0;
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
      entry.materials.add(material);   // so the unique-material count survives a missing manager hook
      entry.depth.encode++;
      const childBefore = entry.childMs;
      const t0 = tick();
      try {
        return original.call(this, object, material, ...rest);
      } finally {
        entry.depth.encode--;
        const ms = tick() - t0;
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
          const t0 = tick();
          try { return originalSort.apply(this, sortArgs); }
          finally { entry.depth.sort--; entry.sortMs += tick() - t0; }
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
      // The six encode stages, and the counters that go with them.
      nodesBeforeMs: 0, geometriesMs: 0, nodesRenderMs: 0, bindingsMs: 0, pipelinesMs: 0, drawMs: 0,
      refreshes: 0, refreshChecks: 0, uniqueMaterials: 0,
      bindingCreates: 0, bindingWrites: 0, bindingWriteBytes: 0,
      attributeWrites: 0, attributeWriteBytes: 0,
      // Which mode this frame ran in: false means the wrappers were installed and every timer read
      // zero, so the frame time is the instrumentation's own cost.
      timed: timePhases,
      scenes: [],
    };
    const allMaterials = new Set();
    for (const entry of [...scenes, outside]) {
      // sceneMs sums the EXCLUSIVE times, so a nesting frame does not count the same work twice.
      out.sceneMs += entry.exclusiveMs;
      out.projectCalls += entry.projectCalls; out.projectMs += entry.projectMs;
      out.sortCalls += entry.sortCalls; out.sortMs += entry.sortMs;
      out.objectListCalls += entry.objectListCalls; out.objectsMs += entry.objectsMs;
      out.encodedObjects += entry.objects; out.encodeCalls += entry.draws; out.encodeMs += entry.encodeMs;
      out.bundleGroups += entry.bundles; out.bundleMs += entry.bundleMs;
      out.nodesBeforeMs += entry.nodesBeforeMs; out.geometriesMs += entry.geometriesMs;
      out.nodesRenderMs += entry.nodesRenderMs; out.bindingsMs += entry.bindingsMs;
      out.pipelinesMs += entry.pipelinesMs; out.drawMs += entry.drawMs;
      out.refreshes += entry.refreshes; out.refreshChecks += entry.refreshChecks;
      out.bindingCreates += entry.bindingCreates;
      out.bindingWrites += entry.bindingWrites; out.bindingWriteBytes += entry.bindingWriteBytes;
      out.attributeWrites += entry.attributeWrites; out.attributeWriteBytes += entry.attributeWriteBytes;
      for (const material of entry.materials) allMaterials.add(material);
    }
    // Frame-wide, not the sum of the per-scene counts: the same material drawn in the shadow pass
    // and the main pass is one material.
    out.uniqueMaterials = allMaterials.size;
    for (const key of ['sceneMs', 'projectMs', 'sortMs', 'objectsMs', 'encodeMs', 'bundleMs',
      'nodesBeforeMs', 'geometriesMs', 'nodesRenderMs', 'bindingsMs', 'pipelinesMs', 'drawMs']) out[key] = round3(out[key]);
    // One row per scene render, in the order they ran: the post chain's quad, then the shadow map,
    // the mirror and the main pass nested inside it.
    out.scenes = scenes.map(entry => ({
      name: entry.name, camera: entry.camera, cameraType: entry.cameraType,
      ms: round3(entry.ms), exclusiveMs: round3(entry.exclusiveMs),
      objects: entry.objects, draws: entry.draws, bundles: entry.bundles,
      projectMs: round3(entry.projectMs), sortMs: round3(entry.sortMs),
      objectsMs: round3(entry.objectsMs), encodeMs: round3(entry.encodeMs),
      // The six stages inside this pass's encode. Like the phases above they are not a partition:
      // all six sit inside encodeMs, which sits inside objectsMs.
      nodesBeforeMs: round3(entry.nodesBeforeMs), geometriesMs: round3(entry.geometriesMs),
      nodesRenderMs: round3(entry.nodesRenderMs), bindingsMs: round3(entry.bindingsMs),
      pipelinesMs: round3(entry.pipelinesMs), drawMs: round3(entry.drawMs),
      refreshes: entry.refreshes, refreshChecks: entry.refreshChecks,
      uniqueMaterials: entry.materials.size,
      bindingCreates: entry.bindingCreates,
      bindingWrites: entry.bindingWrites, bindingWriteBytes: entry.bindingWriteBytes,
      attributeWrites: entry.attributeWrites, attributeWriteBytes: entry.attributeWriteBytes,
      // The heaviest objects this pass encoded, and how much of its encode they were, plus the
      // same for the two heaviest new phases.
      ...topObjects(entry),
    }));
    return out;
  }

  return {
    get attached() { return attachedTo !== null; },
    // False in overhead mode: the wrappers ran, the timers read zero.
    get timed() { return timePhases; },
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
      // The six stages of one object's encode, on the renderer's own manager instances. Wrapping
      // the instance shadows the prototype method, so nothing else that uses the class is touched.
      wrapObjectPhase(renderer._nodes, 'updateBefore', 'nodesBefore', 'nodesBeforeMs', '_nodes.updateBefore', 'perNodes');
      wrapObjectPhase(renderer._geometries, 'updateForRender', 'geometries', 'geometriesMs', '_geometries.updateForRender');
      wrapObjectPhase(renderer._nodes, 'updateForRender', 'nodesRender', 'nodesRenderMs', '_nodes.updateForRender', 'perNodes');
      wrapObjectPhase(renderer._bindings, 'updateForRender', 'bindings', 'bindingsMs', '_bindings.updateForRender', 'perBindings');
      wrapObjectPhase(renderer._pipelines, 'updateForRender', 'pipelines', 'pipelinesMs', '_pipelines.updateForRender');
      wrapObjectPhase(renderer.backend, 'draw', 'draw', 'drawMs', 'backend.draw');
      // Counted, not timed: which objects took the refresh branch at all.
      wrapCounter(renderer._nodes, 'needsRefresh', '_nodes.needsRefresh', (entry, result) => {
        entry.refreshChecks++;
        if (result) entry.refreshes++;
      });
      // What the backend was actually asked to send. `updateBinding` and `updateAttribute` are
      // called only for buffers three decided are stale, so these are submitted writes rather than
      // dirty ranges -- but one `updateAttribute` can become several `writeBuffer` calls inside the
      // backend when the attribute carries update ranges, so the call count is a lower bound.
      wrapCounter(renderer.backend, 'createBindings', 'backend.createBindings', entry => { entry.bindingCreates++; });
      wrapCounter(renderer.backend, 'updateBinding', 'backend.updateBinding', (entry, result, args) => {
        entry.bindingWrites++;
        entry.bindingWriteBytes += byteLengthOf(args[0]);
      });
      wrapCounter(renderer.backend, 'updateAttribute', 'backend.updateAttribute', (entry, result, args, bytes) => {
        entry.attributeWrites++;
        entry.attributeWriteBytes += bytes;
      }, args => attributeBytesOf(args[0]));
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
          timed: timePhases,
          bindingsMs: out.bindingsMs, nodesMs: round3(out.nodesBeforeMs + out.nodesRenderMs),
          pipelinesMs: out.pipelinesMs, drawMs: out.drawMs, geometriesMs: out.geometriesMs,
          refreshes: out.refreshes, refreshChecks: out.refreshChecks, uniqueMaterials: out.uniqueMaterials,
          bindingCreates: out.bindingCreates, bindingWrites: out.bindingWrites,
          bindingWriteBytes: out.bindingWriteBytes,
          attributeWrites: out.attributeWrites, attributeWriteBytes: out.attributeWriteBytes,
        };
        if (worstEncode === null || record.metricMs > worstEncode.metricMs) worstEncode = record;
        if (worst === null || out.sceneMs > worst.sceneMs) worst = record;
      }
      scenes = [];
      outside = newEntry('outside', 'none', 'none');
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
