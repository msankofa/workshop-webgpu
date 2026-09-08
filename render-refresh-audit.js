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
//   snapshotChanged  — the dependency check saw a change, so the candidate would have refreshed.
//   skipSafe         — the check saw nothing AND the refresh did nothing observable.
//   skipWrongly      — the check saw nothing but the refresh DID something. A bug in the contract.
//
// A run with zero `skipWrongly` is evidence, not proof: the oracle sees writes and values, not
// whether a value that was rewritten with the same bytes mattered, and not any effect that leaves
// no trace in a binding, an attribute or a uniform.
//
// The audit's own cost is reported as `auditMs` beside `audited`, because a dependency check that
// costs more than the refresh it skips is not worth having, and that has to be known before any
// skip mode exists.

const round3 = v => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;

// A cheap order-sensitive numeric hash. Not cryptographic: it only has to separate frames.
function hashInit() { return 2166136261; }
function hashNumber(h, v) {
  const n = Number.isFinite(v) ? v : 0;
  // Two words, so a float's mantissa is not thrown away by a bitwise cast.
  h = Math.imul(h ^ (n | 0), 16777619);
  h = Math.imul(h ^ ((n * 4194304) | 0), 16777619);
  return h >>> 0;
}
function hashString(h, s) {
  const text = String(s);
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

// Whatever a uniform, a material property or a node handle holds: numbers, vectors, matrices,
// colours, typed arrays, textures (identity + version), or a node with its own `.value`.
function hashValue(h, value, depth = 0) {
  if (value === null || value === undefined) return hashString(h, 'nil');
  const type = typeof value;
  if (type === 'number') return hashNumber(h, value);
  if (type === 'boolean') return hashNumber(h, value ? 1 : 0);
  if (type === 'string') return hashString(h, value);
  if (type !== 'object' && type !== 'function') return hashString(h, type);
  if (depth > 3) return hashString(h, 'deep');
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    h = hashNumber(h, value.length);
    for (let i = 0; i < value.length; i++) h = hashValue(h, value[i], depth + 1);
    return h;
  }
  // A texture is identity plus version: a swapped or re-uploaded texture is a dependency change.
  if (value.isTexture === true) return hashNumber(hashString(h, value.uuid ?? 'tex'), value.version ?? 0);
  if (Array.isArray(value.elements)) return hashValue(h, value.elements, depth + 1);
  if (value.value !== undefined && value.isNode === true) return hashValue(h, value.value, depth + 1);
  for (const key of ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a']) {
    if (typeof value[key] === 'number') h = hashNumber(hashString(h, key), value[key]);
  }
  return h;
}

// Material fields that can change with no `material.version` bump — the observer's own blind spot.
const MATERIAL_SCALARS = ['opacity', 'transparent', 'alphaTest', 'side', 'blending', 'depthWrite',
  'depthTest', 'wireframe', 'visible', 'colorWrite', 'toneMapped', 'roughness', 'metalness',
  'emissiveIntensity', 'transmission', 'thickness', 'ior', 'clearcoat', 'iridescence'];
const MATERIAL_COLOURS = ['color', 'emissive', 'specular', 'attenuationColor', 'sheenColor'];

function hashMaterial(material) {
  let h = hashInit();
  if (!material) return hashString(h, 'nomaterial');
  h = hashNumber(h, material.version ?? 0);
  for (const key of MATERIAL_SCALARS) if (material[key] !== undefined) h = hashValue(hashString(h, key), material[key]);
  for (const key of MATERIAL_COLOURS) if (material[key] !== undefined) h = hashValue(hashString(h, key), material[key]);
  // Every node-valued property: a TSL graph's `uniform()` handles and texture nodes live here, and
  // none of them bump the material version when their `.value` is rewritten from JS.
  for (const key in material) {
    const prop = material[key];
    if (!prop || typeof prop !== 'object') continue;
    if (prop.isTexture === true) { h = hashValue(hashString(h, key), prop); continue; }
    if (prop.isNode === true && prop.value !== undefined) h = hashValue(hashString(h, key), prop.value);
  }
  return h >>> 0;
}

function hashGeometry(geometry) {
  let h = hashInit();
  if (!geometry) return hashString(h, 'nogeometry');
  h = hashNumber(h, geometry.id ?? 0);
  const attributes = geometry.attributes ?? {};
  for (const name of Object.keys(attributes).sort()) {
    const attribute = attributes[name];
    h = hashNumber(hashString(h, name), attribute?.version ?? 0);
    h = hashNumber(h, attribute?.id ?? 0);
  }
  if (geometry.index) h = hashNumber(hashString(h, 'index'), geometry.index.version ?? 0);
  return h >>> 0;
}

// The EFFECTIVE camera dependency, not the camera's identity: a pass can reuse the same camera
// object with a moved view or a changed projection, and identity would call that unchanged.
function hashCamera(camera) {
  let h = hashInit();
  if (!camera) return hashString(h, 'nocamera');
  h = hashValue(hashString(h, 'view'), camera.matrixWorldInverse?.elements ?? null);
  h = hashValue(hashString(h, 'proj'), camera.projectionMatrix?.elements ?? null);
  return h >>> 0;
}

// Every uniform of every bind group, by value. This is both a dependency (a value written from JS
// between frames) and half the oracle (a value rewritten by a node callback DURING the refresh).
function hashBindings(renderObject) {
  let h = hashInit();
  let uniforms = 0;
  let groups;
  try { groups = renderObject?.getBindings?.(); } catch { return { hash: hashString(h, 'nobindings'), uniforms: 0 }; }
  if (!Array.isArray(groups)) return { hash: hashString(h, 'nobindings'), uniforms: 0 };
  for (const group of groups) {
    h = hashString(h, group?.name ?? 'group');
    const bindings = group?.bindings ?? [];
    for (const binding of bindings) {
      if (Array.isArray(binding?.uniforms)) {
        for (const uniform of binding.uniforms) {
          uniforms++;
          let value;
          try { value = uniform.getValue ? uniform.getValue() : uniform.value; } catch { value = null; }
          h = hashValue(hashString(h, uniform?.name ?? 'u'), value);
        }
        continue;
      }
      if (binding?.texture !== undefined) { h = hashValue(hashString(h, 'tex'), binding.texture); continue; }
      if (binding?.version !== undefined) h = hashNumber(hashString(h, 'v'), binding.version);
    }
  }
  return { hash: h >>> 0, uniforms };
}

// The whole dependency contract of section 3 of the design, as one comparable record.
function snapshot(renderObject, nodeFrame, originHash) {
  const object = renderObject?.object ?? null;
  const matrix = hashValue(hashInit(), object?.matrixWorld?.elements ?? null) >>> 0;
  let flags = hashInit();
  flags = hashNumber(flags, object?.visible ? 1 : 0);
  flags = hashNumber(flags, object?.layers?.mask ?? 0);
  flags = hashNumber(flags, object?.castShadow ? 1 : 0);
  flags = hashNumber(flags, object?.receiveShadow ? 1 : 0);
  const bindings = hashBindings(renderObject);
  let lights = hashInit();
  try { lights = hashString(lights, renderObject?.lightsNode?.getCacheKey?.() ?? 'nolights') >>> 0; }
  catch { lights = hashString(lights, 'lightserror') >>> 0; }
  return {
    matrix,
    flags: flags >>> 0,
    material: hashMaterial(renderObject?.material),
    geometry: hashGeometry(renderObject?.geometry ?? object?.geometry),
    context: renderObject?.context?.id ?? -1,
    camera: hashCamera(renderObject?.camera),
    lights,
    origin: originHash,
    bindings: bindings.hash,
    uniformCount: bindings.uniforms,
    // Recorded, never compared: a frame counter always differs, so comparing it would make every
    // object look changed. It is here so a verdict can be lined up against the frame it came from.
    frameId: nodeFrame?.frameId ?? -1,
    renderId: nodeFrame?.renderId ?? -1,
  };
}

// Which contract fields differ. `bindings` is listed last because it is the widest net.
const SNAPSHOT_FIELDS = ['matrix', 'flags', 'material', 'geometry', 'context', 'camera', 'lights',
  'origin', 'bindings'];

function snapshotDiff(previous, next) {
  if (previous === undefined) return ['firstSeen'];
  const changed = [];
  for (const field of SNAPSHOT_FIELDS) if (previous[field] !== next[field]) changed.push(field);
  return changed;
}

const UNKNOWN = { name: 'unknown', material: 'none' };
const descriptorCache = new WeakMap();
function describeObject(object, material) {
  if (!object) return UNKNOWN;
  let byMaterial = descriptorCache.get(object);
  if (byMaterial === undefined) { byMaterial = new Map(); descriptorCache.set(object, byMaterial); }
  let descriptor = byMaterial.get(material);
  if (descriptor === undefined) {
    descriptor = { name: object.name || object.type || 'object', material: material?.type ?? 'none' };
    byMaterial.set(material, descriptor);
  }
  return descriptor;
}

// How many disagreeing objects a take reports. Long enough to name the offenders, short enough that
// a capture stays readable.
const TOP_OBJECTS = 12;

function newPass(key, name, camera) {
  return { key, name, camera, audited: 0, skipSafe: 0, skipWrongly: 0, snapshotChanged: 0,
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
  const snapshots = new WeakMap();   // renderObject -> last snapshot
  let passes = new Map();
  let objectRows = new Map();        // descriptor -> aggregated verdict row
  let auditMs = 0;
  let audited = 0;
  let ignored = 0;
  let frameCount = 0;
  // The object currently between `needsRefresh` and the end of its refresh: backend writes seen in
  // that window are this object's, and nothing else's.
  let active = null;

  const isDeclared = (object, material, renderObject) => {
    if (declared.has(object)) return true;
    if (typeof declare === 'function') { try { return declare(object, material, renderObject) === true; } catch { return false; } }
    return false;
  };

  const originHash = () => {
    if (typeof origin !== 'function') return 0;
    try { return hashValue(hashInit(), origin()) >>> 0; } catch { return 0; }
  };

  function passFor(renderObject) {
    const camera = renderObject?.camera;
    const contextId = renderObject?.context?.id ?? 'none';
    const cameraLabel = camera ? (camera.name || camera.type || 'camera') : 'none';
    // Context AND effective camera: one context reused with a different camera is a different pass,
    // and one camera used by two contexts is too.
    const key = `${contextId}|${cameraLabel}|${hashCamera(camera)}`;
    let pass = passes.get(key);
    if (pass === undefined) { pass = newPass(key, String(contextId), cameraLabel); passes.set(key, pass); }
    return pass;
  }

  function rowFor(descriptor) {
    let row = objectRows.get(descriptor);
    if (row === undefined) {
      row = { name: descriptor.name, material: descriptor.material,
        audited: 0, skipSafe: 0, skipWrongly: 0, snapshotChanged: 0, reasons: new Set(), fields: new Set() };
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
    const before = snapshot(renderObject, nodeFrame, originHash());
    const previous = snapshots.get(renderObject);
    const changedFields = snapshotDiff(previous, before);
    active = {
      renderObject, nodeFrame, before, changedFields,
      descriptor: describeObject(object, material),
      pass: passFor(renderObject),
      bindingWrites: 0, attributeWrites: 0,
      finished: false,
    };
    auditMs += now() - t0;
  }

  // Called when the refresh's binding stage has finished for the active object: the oracle is read
  // here, against the same contract fields.
  function finish() {
    const record = active;
    if (record === null || record.finished) return;
    record.finished = true;
    const t0 = now();
    const after = snapshot(record.renderObject, record.nodeFrame, originHash());
    snapshots.set(record.renderObject, after);

    const reasons = [];
    if (record.bindingWrites > 0) reasons.push('bindingWrite');
    if (record.attributeWrites > 0) reasons.push('attributeWrite');
    // A uniform whose value differs across the refresh was written BY the refresh: a node callback
    // (onFrameUpdate / onRenderUpdate / onObjectUpdate) with a side effect the frame depends on.
    if (record.before.bindings !== after.bindings) reasons.push('uniformValue');
    if (record.before.material !== after.material) reasons.push('materialValue');

    const snapshotUnchanged = record.changedFields.length === 0;
    const oracleChanged = reasons.length > 0;
    const verdict = snapshotUnchanged ? (oracleChanged ? 'skipWrongly' : 'skipSafe') : 'snapshotChanged';

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
      const passRows = [...passes.values()].map(pass => ({
        pass: pass.name, camera: pass.camera,
        audited: pass.audited, skipSafe: pass.skipSafe, skipWrongly: pass.skipWrongly,
        snapshotChanged: pass.snapshotChanged,
        bindingWrites: pass.bindingWrites, attributeWrites: pass.attributeWrites,
        auditMs: round3(pass.auditMs),
      }));
      const rows = [...objectRows.values()]
        .filter(row => row.skipWrongly > 0 || row.snapshotChanged > 0)
        .sort((a, b) => (b.skipWrongly - a.skipWrongly) || (b.snapshotChanged - a.snapshotChanged))
        .slice(0, TOP_OBJECTS)
        .map(row => ({ name: row.name, material: row.material, audited: row.audited,
          skipWrongly: row.skipWrongly, snapshotChanged: row.snapshotChanged, skipSafe: row.skipSafe,
          reasons: [...row.reasons], changed: [...row.fields] }));
      const out = {
        frame: frameCount,
        audited, ignored,
        passes: passRows.length,
        skipSafe: passRows.reduce((sum, p) => sum + p.skipSafe, 0),
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
      objectRows = new Map();
      auditMs = 0;
      audited = 0;
      ignored = 0;
      return out;
    },
  };
}
