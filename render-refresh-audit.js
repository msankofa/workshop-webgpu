// render-refresh-audit.js — measures whether a refresh-skip WOULD have been safe. It never skips.
//
// `NodeMaterialObserver.needsRefresh` (three.webgpu.js ~696) returns true for every node material,
// so every Base Game object takes the refresh branch every frame. The refresh-skip design proposes
// a candidate dependency check that could answer `false` for declared-static objects. Comparing
// that candidate against Three's answer proves nothing, because Three's answer is always true.
//
// So the oracle here is not Three's answer. It is what the refresh ACTUALLY changed: binding writes
// the backend was asked to issue for this object, attribute uploads, and uniform values that differ
// between a snapshot taken before the refresh and one taken after (a node with an onFrameUpdate or
// onObjectUpdate callback rewrote them mid-refresh). Against that oracle the audit asks one
// question per declared object per pass: if the candidate had skipped, would anything have been
// lost?
//
// Three answers, per object per pass:
//   snapshotChanged   — the dependency check saw a change, so the candidate would have refreshed.
//   noObservedChange  — the check saw nothing AND the refresh did nothing this audit can observe.
//                       It is a candidate, NOT permission to skip: `updateAfter` and any effect
//                       outside bindings, attributes and uniforms are outside the oracle.
//   skipWrongly       — the check saw nothing but the refresh DID something. A bug in the contract.
//
// A run with zero `skipWrongly` is evidence, not proof: the oracle sees writes and values, not
// whether a value that was rewritten with the same bytes mattered, and not any effect that leaves
// no trace in a binding, an attribute or a uniform.
//
// The audit's own cost is reported as `auditMs` beside `audited`, because a dependency check that
// costs more than the refresh it skips is not worth having, and that has to be known before any
// skip mode exists. The audit also allocates nothing per object per frame in the steady state:
// snapshot records, the diff array and the active record are reused (see `recordFor`).

const round3 = v => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;

// ---- hashing -------------------------------------------------------------------------------
//
// Two independent FNV-1a lanes, kept as two signed 32-bit values and compared as a pair, so the
// effective width is 64 bits. A collision reads as a false "unchanged": a real dependency change
// the diff misses, which downgrades a snapshotChanged to a noObservedChange or hides a skipWrongly.
// At 32 bits that is ~2.3e-10 per comparison — with ~9 fields x hundreds of objects x two passes
// at 60 Hz that is a coin flip inside a couple of hours of capture. At 64 bits it is ~5e-20, which
// is not a realistic false negative over any capture we will run. The pair is NOT folded into one
// 53-bit number: that number leaves the Smi range and V8 boxes one on every hash.
// Signed int32 lane state: `>>> 0` would push the value past 2^31, and a module-level binding
// holding that is a boxed heap number allocated on every mix.
const OFFSET_A = 2166136261 | 0;
const OFFSET_B = (2166136261 ^ 0x9e3779b9) | 0;
const PRIME_A = 16777619;
const PRIME_B = 2654435761;

let hA = 0;
let hB = 0;

// Exact float bits, so two nearly-equal numbers never collapse the way a mantissa cast would.
const floatView = new Float64Array(1);
const wordView = new Uint32Array(floatView.buffer);

function hashBegin() { hA = OFFSET_A; hB = OFFSET_B; }
// The two lanes, as small integers. `laneKey` folds them for a Map key only, where a collision
// merges two pass rows rather than hiding a dependency change.
function laneA() { return hA; }
function laneB() { return hB; }
function laneKey() { return (hA ^ hB) | 0; }

function mixInt(n) {
  hA = Math.imul(hA ^ n, PRIME_A) | 0;
  hB = Math.imul(hB ^ n, PRIME_B) | 0;
  hB = (hB ^ (hB >>> 13)) | 0;   // the lanes must not move in lockstep
}

function mixNumber(v) {
  floatView[0] = Number.isFinite(v) ? (v === 0 ? 0 : v) : 0;   // -0 and 0 are the same dependency
  mixInt(wordView[0]);
  mixInt(wordView[1]);
}

function mixString(s) {
  const text = String(s);
  mixInt(text.length);
  for (let i = 0; i < text.length; i++) mixInt(text.charCodeAt(i));
}

const VECTOR_KEYS = ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a'];

// Whatever a uniform, a material property or a node handle holds: numbers, vectors, matrices,
// colours, typed arrays, textures (identity + version), or a node with its own `.value`.
// Everything here is READ into the hash — no live matrix, array, vector or texture is ever stored,
// so an object Three mutates in place cannot make a stale snapshot look current.
function mixValue(value, depth = 0) {
  if (value === null || value === undefined) { mixString('nil'); return; }
  const type = typeof value;
  if (type === 'number') { mixNumber(value); return; }
  if (type === 'boolean') { mixNumber(value ? 1 : 0); return; }
  if (type === 'string') { mixString(value); return; }
  if (type !== 'object' && type !== 'function') { mixString(type); return; }
  if (depth > 3) { mixString('deep'); return; }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    mixNumber(value.length);
    for (let i = 0; i < value.length; i++) mixValue(value[i], depth + 1);
    return;
  }
  // A texture is identity plus version: a swapped or re-uploaded texture is a dependency change.
  if (value.isTexture === true) { mixString(value.uuid ?? 'tex'); mixNumber(value.version ?? 0); return; }
  if (Array.isArray(value.elements)) { mixValue(value.elements, depth + 1); return; }
  if (value.value !== undefined && value.isNode === true) { mixValue(value.value, depth + 1); return; }
  let touched = false;
  for (let i = 0; i < VECTOR_KEYS.length; i++) {
    const key = VECTOR_KEYS[i];
    if (typeof value[key] === 'number') { mixString(key); mixNumber(value[key]); touched = true; }
  }
  if (touched) return;
  // Anything else identity-bearing (render-target textures, buffers, samplers): uuid plus version,
  // so a swap or a re-upload still reads as a change instead of hashing to nothing.
  if (typeof value.uuid === 'string') { mixString(value.uuid); touched = true; }
  if (typeof value.version === 'number') { mixNumber(value.version); touched = true; }
  if (typeof value.id === 'number') { mixNumber(value.id); touched = true; }
  if (!touched) mixString('opaque');   // an object with no readable identity: recorded as such
}

// Material fields that can change with no `material.version` bump — the observer's own blind spot.
const MATERIAL_SCALARS = ['opacity', 'transparent', 'alphaTest', 'side', 'blending', 'depthWrite',
  'depthTest', 'wireframe', 'visible', 'colorWrite', 'toneMapped', 'roughness', 'metalness',
  'emissiveIntensity', 'transmission', 'thickness', 'ior', 'clearcoat', 'iridescence'];
const MATERIAL_COLOURS = ['color', 'emissive', 'specular', 'attenuationColor', 'sheenColor'];

function mixMaterial(material) {
  hashBegin();
  if (!material) { mixString('nomaterial'); return; }
  mixNumber(material.version ?? 0);
  for (const key of MATERIAL_SCALARS) if (material[key] !== undefined) { mixString(key); mixValue(material[key]); }
  for (const key of MATERIAL_COLOURS) if (material[key] !== undefined) { mixString(key); mixValue(material[key]); }
  // Every node-valued property: a TSL graph's `uniform()` handles and texture nodes live here, and
  // none of them bump the material version when their `.value` is rewritten from JS.
  for (const key in material) {
    const prop = material[key];
    if (!prop || typeof prop !== 'object') continue;
    if (prop.isTexture === true) { mixString(key); mixValue(prop); continue; }
    if (prop.isNode === true && prop.value !== undefined) { mixString(key); mixValue(prop.value); }
  }
}

// The attribute names, sorted once per geometry rather than per snapshot: `Object.keys().sort()`
// allocates an array, and this runs twice per object per pass. Rebuilt when the count moves.
const attributeNames = new WeakMap();
function sortedAttributeNames(attributes) {
  let names = attributeNames.get(attributes);
  let count = 0;
  for (const _ in attributes) count++;
  if (names === undefined || names.length !== count) {
    names = Object.keys(attributes).sort();
    attributeNames.set(attributes, names);
  }
  return names;
}

function mixGeometry(geometry) {
  hashBegin();
  if (!geometry) { mixString('nogeometry'); return; }
  mixNumber(geometry.id ?? 0);
  const attributes = geometry.attributes ?? {};
  for (const name of sortedAttributeNames(attributes)) {
    const attribute = attributes[name];
    mixString(name);
    mixNumber(attribute?.version ?? 0);
    mixNumber(attribute?.id ?? 0);
  }
  if (geometry.index) { mixString('index'); mixNumber(geometry.index.version ?? 0); }
}

// The EFFECTIVE camera dependency, not the camera's identity: a pass can reuse the same camera
// object with a moved view or a changed projection, and identity would call that unchanged. The
// matrices are read element by element, never held.
function mixCamera(camera) {
  hashBegin();
  if (!camera) { mixString('nocamera'); return; }
  mixString('view');
  mixValue(camera.matrixWorldInverse?.elements ?? null);
  mixString('proj');
  mixValue(camera.projectionMatrix?.elements ?? null);
}

// Set by `mixBindings` instead of returning a `{hash, uniforms}` literal every call.
let lastUniformCount = 0;

// Every uniform of every bind group, by value. This is both a dependency (a value written from JS
// between frames) and half the oracle (a value rewritten by a node callback DURING the refresh).
function mixBindings(renderObject) {
  hashBegin();
  lastUniformCount = 0;
  let groups;
  try { groups = renderObject?.getBindings?.(); } catch { mixString('nobindings'); return; }
  if (!Array.isArray(groups)) { mixString('nobindings'); return; }
  for (const group of groups) {
    mixString(group?.name ?? 'group');
    const bindings = group?.bindings ?? [];
    for (const binding of bindings) {
      if (Array.isArray(binding?.uniforms)) {
        for (const uniform of binding.uniforms) {
          lastUniformCount++;
          let value;
          try { value = uniform.getValue ? uniform.getValue() : uniform.value; } catch { value = null; }
          mixString(uniform?.name ?? 'u');
          mixValue(value);
        }
        continue;
      }
      if (binding?.texture !== undefined) { mixString('tex'); mixValue(binding.texture); continue; }
      if (binding?.version !== undefined) { mixString('v'); mixNumber(binding.version); }
    }
  }
}

function newSnapshot() {
  return { matrixA: 0, matrixB: 0, flagsA: 0, flagsB: 0, materialA: 0, materialB: 0,
    geometryA: 0, geometryB: 0, cameraA: 0, cameraB: 0, lightsA: 0, lightsB: 0,
    originA: 0, originB: 0, bindingsA: 0, bindingsB: 0,
    context: -1, uniformCount: 0, frameId: -1, renderId: -1 };
}

// Fills `into` — every field a small integer or a primitive id, never a reference into a live
// object, so a matrix, colour, vector or texture Three mutates in place cannot leave a stale
// snapshot looking current.
function snapshotInto(into, renderObject, nodeFrame, originA, originB) {
  const object = renderObject?.object ?? null;
  hashBegin();
  mixValue(object?.matrixWorld?.elements ?? null);
  into.matrixA = laneA(); into.matrixB = laneB();
  hashBegin();
  mixNumber(object?.visible ? 1 : 0);
  mixNumber(object?.layers?.mask ?? 0);
  mixNumber(object?.castShadow ? 1 : 0);
  mixNumber(object?.receiveShadow ? 1 : 0);
  into.flagsA = laneA(); into.flagsB = laneB();
  mixMaterial(renderObject?.material);
  into.materialA = laneA(); into.materialB = laneB();
  mixGeometry(renderObject?.geometry ?? object?.geometry);
  into.geometryA = laneA(); into.geometryB = laneB();
  into.context = renderObject?.context?.id ?? -1;
  mixCamera(renderObject?.camera);
  into.cameraA = laneA(); into.cameraB = laneB();
  hashBegin();
  try { mixString(renderObject?.lightsNode?.getCacheKey?.() ?? 'nolights'); }
  catch { mixString('lightserror'); }
  into.lightsA = laneA(); into.lightsB = laneB();
  into.originA = originA; into.originB = originB;
  mixBindings(renderObject);
  into.bindingsA = laneA(); into.bindingsB = laneB();
  into.uniformCount = lastUniformCount;
  // Recorded, never compared: a frame counter always differs, so comparing it would make every
  // object look changed. It is here so a verdict can be lined up against the frame it came from.
  into.frameId = nodeFrame?.frameId ?? -1;
  into.renderId = nodeFrame?.renderId ?? -1;
  return into;
}

// The contract fields, each stored as a two-lane pair. `bindings` is last because it is the widest
// net. `context` is an id, not a hash, and is compared on its own.
const HASH_FIELDS = ['matrix', 'flags', 'material', 'geometry', 'camera', 'lights', 'origin', 'bindings'];
const FIELD_A = HASH_FIELDS.map(field => `${field}A`);
const FIELD_B = HASH_FIELDS.map(field => `${field}B`);

function copySnapshot(from, to) {
  for (let i = 0; i < HASH_FIELDS.length; i++) { to[FIELD_A[i]] = from[FIELD_A[i]]; to[FIELD_B[i]] = from[FIELD_B[i]]; }
  to.context = from.context;
  to.uniformCount = from.uniformCount;
  to.frameId = from.frameId;
  to.renderId = from.renderId;
  return to;
}

// Writes into `changed` (reused) instead of allocating an array per object per frame.
function snapshotDiff(previous, next, changed) {
  changed.length = 0;
  if (previous === null) { changed.push('firstSeen'); return changed; }
  if (previous.context !== next.context) changed.push('context');
  for (let i = 0; i < HASH_FIELDS.length; i++) {
    if (previous[FIELD_A[i]] !== next[FIELD_A[i]] || previous[FIELD_B[i]] !== next[FIELD_B[i]]) changed.push(HASH_FIELDS[i]);
  }
  return changed;
}

const UNKNOWN = { name: 'unknown', material: 'none' };
const NO_MATERIAL = { marker: 'no-material' };   // stands in for null, which cannot key a WeakMap
const descriptorCache = new WeakMap();
function describeObject(object, material) {
  if (!object) return UNKNOWN;
  let byMaterial = descriptorCache.get(object);
  // A WeakMap, so a descriptor never keeps a dead material alive for the object's lifetime.
  if (byMaterial === undefined) { byMaterial = new WeakMap(); descriptorCache.set(object, byMaterial); }
  const key = material ?? NO_MATERIAL;
  let descriptor = byMaterial.get(key);
  if (descriptor === undefined) {
    descriptor = { name: object.name || object.type || 'object', material: material?.type ?? 'none' };
    byMaterial.set(key, descriptor);
  }
  return descriptor;
}

// How many disagreeing objects a take reports. Long enough to name the offenders, short enough that
// a capture stays readable.
const TOP_OBJECTS = 12;

function newPass(key, name, camera) {
  return { key, name, camera, audited: 0, noObservedChange: 0, skipWrongly: 0, snapshotChanged: 0,
    bindingWrites: 0, attributeWrites: 0, auditMs: 0 };
}

/**
 * @param {object} options
 * @param {function} [options.now] - clock, `performance.now` by default.
 * @param {function} [options.declare] - predicate `(object, material, renderObject) => boolean`.
 *   Only declared objects are audited; everything else is ignored entirely.
 * @param {function} [options.origin] - returns the render origin (array or vector). A rebase moves
 *   every render-local object at once and bumps no version, so it is part of the contract.
 */
export function createRefreshAudit({ now = () => performance.now(), declare = null, origin = null } = {}) {
  let attachedTo = null;
  let restore = [];
  const missing = [];
  const declared = new WeakSet();
  const records = new WeakMap();     // renderObject -> reused per-object audit record
  let passes = new Map();            // contextId -> Map(cameraHash -> pass)
  // Persistent across takes: the rows are zeroed rather than rebuilt, so a steady frame
  // allocates no row and no Set.
  const objectRows = new Map();      // descriptor -> aggregated verdict row
  let auditMs = 0;
  let audited = 0;
  let ignored = 0;
  let frameCount = 0;
  // The object currently between `needsRefresh` and the end of its refresh: backend writes seen in
  // that window are this object's, and nothing else's.
  let active = null;
  // Reused across every object: only one is ever active at a time.
  const beforeScratch = newSnapshot();
  const afterScratch = newSnapshot();
  const reasons = [];

  const isDeclared = (object, material, renderObject) => {
    if (declared.has(object)) return true;
    if (typeof declare === 'function') { try { return declare(object, material, renderObject) === true; } catch { return false; } }
    return false;
  };

  // The render origin as a lane pair, read into module scratch before each snapshot.
  let originA = 0;
  let originB = 0;
  const readOrigin = () => {
    if (typeof origin !== 'function') { originA = 0; originB = 0; return; }
    try { hashBegin(); mixValue(origin()); originA = laneA(); originB = laneB(); }
    catch { originA = 0; originB = 0; }
  };

  // One persistent record per renderObject: the last snapshot, its diff array, and the live state
  // of the current refresh. Allocated on first sight, reused every frame after.
  function recordFor(renderObject) {
    let record = records.get(renderObject);
    if (record === undefined) {
      record = { renderObject, nodeFrame: null, previous: null, store: newSnapshot(),
        changedFields: [], descriptor: UNKNOWN, pass: null,
        beforeBindingsA: 0, beforeBindingsB: 0, beforeMaterialA: 0, beforeMaterialB: 0,
        bindingWrites: 0, attributeWrites: 0, finished: false };
      records.set(renderObject, record);
    }
    return record;
  }

  function passFor(renderObject) {
    const camera = renderObject?.camera;
    const contextId = renderObject?.context?.id ?? 'none';
    const cameraLabel = camera ? (camera.name || camera.type || 'camera') : 'none';
    // Context AND effective camera: one context reused with a different camera is a different pass,
    // and one camera used by two contexts is too. Two Map levels rather than a template-string key,
    // so a pass lookup allocates nothing.
    let byCamera = passes.get(contextId);
    if (byCamera === undefined) { byCamera = new Map(); passes.set(contextId, byCamera); }
    mixCamera(camera);
    const cameraKey = laneKey();
    let pass = byCamera.get(cameraKey);
    if (pass === undefined) {
      pass = newPass(cameraKey, String(contextId), cameraLabel);
      byCamera.set(cameraKey, pass);
    }
    return pass;
  }

  function rowFor(descriptor) {
    let row = objectRows.get(descriptor);
    if (row === undefined) {
      row = { name: descriptor.name, material: descriptor.material,
        audited: 0, noObservedChange: 0, skipWrongly: 0, snapshotChanged: 0, reasons: new Set(), fields: new Set() };
      objectRows.set(descriptor, row);
    }
    return row;
  }

  // Called from the `needsRefresh` wrapper, BEFORE Three answers.
  function begin(renderObject, nodeFrame) {
    const object = renderObject?.object ?? null;
    const material = renderObject?.material ?? null;
    if (!isDeclared(object, material, renderObject)) { ignored++; return; }
    const t0 = now();
    const record = recordFor(renderObject);
    readOrigin();
    snapshotInto(beforeScratch, renderObject, nodeFrame, originA, originB);
    snapshotDiff(record.previous, beforeScratch, record.changedFields);
    record.nodeFrame = nodeFrame;
    record.descriptor = describeObject(object, material);
    record.pass = passFor(renderObject);
    record.bindingWrites = 0;
    record.attributeWrites = 0;
    record.finished = false;
    // The oracle needs the pre-refresh binding and material hashes; they are numbers, so keeping
    // them costs nothing and survives the scratch being reused by the after-snapshot.
    record.beforeBindingsA = beforeScratch.bindingsA;
    record.beforeBindingsB = beforeScratch.bindingsB;
    record.beforeMaterialA = beforeScratch.materialA;
    record.beforeMaterialB = beforeScratch.materialB;
    active = record;
    auditMs += now() - t0;
  }

  // Called when the refresh's binding stage has finished for the active object: the oracle is read
  // here, against the same contract fields.
  function finish() {
    const record = active;
    if (record === null || record.finished) return;
    record.finished = true;
    const t0 = now();
    readOrigin();
    snapshotInto(afterScratch, record.renderObject, record.nodeFrame, originA, originB);
    copySnapshot(afterScratch, record.store);
    record.previous = record.store;

    reasons.length = 0;
    if (record.bindingWrites > 0) reasons.push('bindingWrite');
    if (record.attributeWrites > 0) reasons.push('attributeWrite');
    // A uniform whose value differs across the refresh was written BY the refresh: a node callback
    // (onFrameUpdate / onRenderUpdate / onObjectUpdate) with a side effect the frame depends on.
    if (record.beforeBindingsA !== afterScratch.bindingsA || record.beforeBindingsB !== afterScratch.bindingsB) reasons.push('uniformValue');
    if (record.beforeMaterialA !== afterScratch.materialA || record.beforeMaterialB !== afterScratch.materialB) reasons.push('materialValue');

    const snapshotUnchanged = record.changedFields.length === 0;
    const oracleChanged = reasons.length > 0;
    // noObservedChange is a candidate, not permission to skip: the oracle does not see updateAfter
    // or any effect outside bindings, attributes and uniforms.
    const verdict = snapshotUnchanged ? (oracleChanged ? 'skipWrongly' : 'noObservedChange') : 'snapshotChanged';

    const pass = record.pass;
    pass.audited++;
    pass[verdict]++;
    pass.bindingWrites += record.bindingWrites;
    pass.attributeWrites += record.attributeWrites;

    const row = rowFor(record.descriptor);
    row.audited++;
    row[verdict]++;
    for (const reason of reasons) row.reasons.add(reason);
    for (const field of record.changedFields) row.fields.add(field);

    audited++;
    const ms = now() - t0;
    auditMs += ms;
    pass.auditMs += ms;
    active = null;
  }

  // ---- wrapping, following render-trace.js's conventions ----

  function wrap(target, name, label, make) {
    const original = target?.[name];
    if (typeof original !== 'function') { missing.push(label); return; }
    target[name] = make(original);
    restore.push(() => { if (target[name] !== original) target[name] = original; });
  }

  return {
    get attached() { return attachedTo !== null; },
    get missingHooks() { return [...missing]; },
    /** Mark one object as part of the opt-in class, in addition to any `declare` predicate. */
    declare(object) { if (object) declared.add(object); return object; },
    undeclare(object) { if (object) declared.delete(object); },

    attach(renderer) {
      if (attachedTo) return this.attached;
      missing.length = 0;
      restore = [];
      const nodes = renderer?._nodes;
      const bindings = renderer?._bindings;
      const backend = renderer?.backend;

      // The seam of the design, used read-only: the snapshot is taken here, and Three's answer is
      // returned untouched. There is no branch that returns false.
      wrap(nodes, 'needsRefresh', '_nodes.needsRefresh', original => function (renderObject, ...rest) {
        // A nested render object beginning inside another one would orphan the outer record; close
        // it rather than lose it.
        if (active !== null) finish();
        try { begin(renderObject, nodes?.nodeFrame ?? renderer?.nodeFrame ?? null); } catch { active = null; }
        return original.call(this, renderObject, ...rest);
      });

      // The last stage inside the refresh gate (three.webgpu.js ~61311), so the oracle is read once
      // the refresh has done everything it is going to do to this object's bindings.
      wrap(bindings, 'updateForRender', '_bindings.updateForRender', original => function (renderObject, ...rest) {
        try { return original.call(this, renderObject, ...rest); }
        finally { if (active !== null && active.renderObject === renderObject) finish(); }
      });

      // Anything the backend was actually asked to write while this object was refreshing.
      wrap(backend, 'updateBinding', 'backend.updateBinding', original => function (...args) {
        if (active !== null) active.bindingWrites++;
        return original.apply(this, args);
      });
      wrap(backend, 'updateAttribute', 'backend.updateAttribute', original => function (...args) {
        if (active !== null) active.attributeWrites++;
        return original.apply(this, args);
      });

      attachedTo = restore.length ? renderer : null;
      return this.attached;
    },

    detach() {
      // Identity-checked in `wrap`: a later owner's hook is left alone rather than silently removed.
      for (const undo of restore.reverse()) undo();
      restore = [];
      active = null;
      attachedTo = null;
    },

    /** Verdicts since the last take, then reset. Snapshots are kept, so the next frame can compare. */
    take() {
      if (active !== null) finish();
      frameCount++;
      const passRows = [];
      for (const byCamera of passes.values()) {
        for (const pass of byCamera.values()) {
          passRows.push({ pass: pass.name, camera: pass.camera,
            audited: pass.audited, noObservedChange: pass.noObservedChange, skipWrongly: pass.skipWrongly,
            snapshotChanged: pass.snapshotChanged,
            bindingWrites: pass.bindingWrites, attributeWrites: pass.attributeWrites,
            auditMs: round3(pass.auditMs) });
        }
      }
      const rows = [...objectRows.values()]
        .filter(row => row.skipWrongly > 0 || row.snapshotChanged > 0)
        .sort((a, b) => (b.skipWrongly - a.skipWrongly) || (b.snapshotChanged - a.snapshotChanged))
        .slice(0, TOP_OBJECTS)
        .map(row => ({ name: row.name, material: row.material, audited: row.audited,
          skipWrongly: row.skipWrongly, snapshotChanged: row.snapshotChanged,
          noObservedChange: row.noObservedChange,
          reasons: [...row.reasons], changed: [...row.fields] }));
      const out = {
        frame: frameCount,
        audited, ignored,
        passes: passRows.length,
        noObservedChange: passRows.reduce((sum, p) => sum + p.noObservedChange, 0),
        skipWrongly: passRows.reduce((sum, p) => sum + p.skipWrongly, 0),
        snapshotChanged: passRows.reduce((sum, p) => sum + p.snapshotChanged, 0),
        // The check's own cost, so it is known before any skip mode exists.
        auditMs: round3(auditMs),
        auditMsPerObject: audited > 0 ? round3(auditMs / audited) : 0,
        passRows, topDisagreements: rows,
        // Stated in the record, not just the doc: this mode never skips a refresh.
        skipped: 0,
      };
      passes = new Map();
      for (const row of objectRows.values()) {
        row.audited = 0; row.noObservedChange = 0; row.skipWrongly = 0; row.snapshotChanged = 0;
        row.reasons.clear(); row.fields.clear();
      }
      auditMs = 0;
      audited = 0;
      ignored = 0;
      return out;
    },
  };
}
