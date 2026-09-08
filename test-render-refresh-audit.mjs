import assert from 'node:assert/strict';
import { createRefreshAudit } from './render-refresh-audit.js';

let clock = 0;
const now = () => clock;

// The smallest shapes the audit reads: a matrix is its `elements`, a camera is a view and a
// projection, a bind group is a list of uniforms with `getValue()`.
const mat4 = () => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });

function fakeCamera(name = 'main') {
  return { name, type: 'PerspectiveCamera', matrixWorldInverse: mat4(), projectionMatrix: mat4() };
}

function fakeObject(name = 'wall') {
  return { name, type: 'Mesh', visible: true, layers: { mask: 1 }, castShadow: false, receiveShadow: true,
    matrixWorld: mat4(), geometry: { id: 7, attributes: { position: { id: 1, version: 0 } } } };
}

function fakeRenderObject(object, camera, { contextId = 1, uniforms = [] } = {}) {
  const group = { name: 'objectGroup', bindings: [{ uniforms }] };
  return {
    object, material: { type: 'NodeMaterial', version: 0, opacity: 1 },
    geometry: object.geometry, camera, context: { id: contextId },
    lightsNode: { getCacheKey: () => 'lights' },
    getBindings: () => [group],
  };
}

// A renderer with the call order of `_renderObjectDirect`: needsRefresh, then (always, since Three's
// answer is always true for node materials) the refresh stages. `onRefresh` is where a case makes
// the refresh do something the oracle should catch.
function fakeRenderer({ onRefresh = null } = {}) {
  const backend = { updateBinding() {}, updateAttribute() {} };
  const renderer = {
    _nodes: { nodeFrame: { frameId: 0, renderId: 0 }, needsRefresh() { return true; } },
    _bindings: { updateForRender(renderObject) { onRefresh?.(renderObject, backend, renderer); } },
    backend,
    encode(renderObject) {
      clock += 1;
      const needsRefresh = this._nodes.needsRefresh(renderObject);
      if (needsRefresh) this._bindings.updateForRender(renderObject);
      return needsRefresh;
    },
  };
  return renderer;
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}\n     ${error.message}`); }
}

// --- 1. an unchanged declared object whose refresh writes nothing: the skip would have been safe.
check('unchanged object with a silent refresh reports noObservedChange', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  assert.equal(audit.attach(renderer), true);
  assert.deepEqual(audit.missingHooks, []);
  const object = fakeObject();
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderer.encode(renderObject);
  const first = audit.take();
  // First sight has no previous snapshot, so it can only be reported as changed.
  assert.equal(first.snapshotChanged, 1);
  renderer.encode(renderObject);
  const second = audit.take();
  assert.equal(second.audited, 1);
  assert.equal(second.noObservedChange, 1);
  assert.equal(second.skipWrongly, 0);
  assert.equal(second.skipped, 0);
  assert.equal(second.topDisagreements.length, 0);
  audit.detach();
});

// --- 2. the same object when the refresh issues a binding write: the skip would have been wrong.
check('a binding write during the refresh is a skipWrongly with bindingWrite', () => {
  let writing = false;
  const renderer = fakeRenderer({ onRefresh: (ro, backend) => { if (writing) backend.updateBinding({}); } });
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject('spawn-building');
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderer.encode(renderObject);
  audit.take();
  writing = true;
  renderer.encode(renderObject);
  const out = audit.take();
  assert.equal(out.skipWrongly, 1);
  assert.equal(out.noObservedChange, 0);
  assert.equal(out.passRows[0].bindingWrites, 1);
  assert.equal(out.topDisagreements.length, 1);
  assert.deepEqual(out.topDisagreements[0].reasons, ['bindingWrite']);
  assert.equal(out.topDisagreements[0].name, 'spawn-building');
  audit.detach();
});

// --- 3. camera identity is not the dependency: the same camera object with a new projection.
check('a projection change on the same camera object changes the snapshot', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const camera = fakeCamera();
  const renderObject = fakeRenderObject(object, camera);
  renderer.encode(renderObject);
  audit.take();
  renderer.encode(renderObject);
  assert.equal(audit.take().noObservedChange, 1);
  camera.projectionMatrix.elements[0] = 1.7;   // same camera object, different effective dependency
  renderer.encode(renderObject);
  const out = audit.take();
  assert.equal(out.snapshotChanged, 1);
  assert.equal(out.noObservedChange, 0);
  assert.ok(out.topDisagreements[0].changed.includes('camera'));
  audit.detach();
});

// --- 4. a uniform value written from JS between frames.
check('a uniform changed between frames changes the snapshot', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const uniform = { name: 'tint', value: 0.5, getValue() { return this.value; } };
  const renderObject = fakeRenderObject(object, fakeCamera(), { uniforms: [uniform] });
  renderer.encode(renderObject);
  audit.take();
  renderer.encode(renderObject);
  assert.equal(audit.take().noObservedChange, 1);
  uniform.value = 0.9;
  renderer.encode(renderObject);
  const out = audit.take();
  assert.equal(out.snapshotChanged, 1);
  assert.ok(out.topDisagreements[0].changed.includes('bindings'));
  audit.detach();
});

// --- 5. a node callback that rewrites a uniform DURING the refresh: the oracle, not the snapshot.
check('a callback rewriting a uniform mid-refresh is a skipWrongly with uniformValue', () => {
  let rewriting = false;
  let tick = 0;
  const uniform = { name: 'phase', value: 0, getValue() { return this.value; } };
  const renderer = fakeRenderer({ onRefresh: () => { if (rewriting) uniform.value = ++tick; } });
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject('road');
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera(), { uniforms: [uniform] });
  renderer.encode(renderObject);
  audit.take();
  renderer.encode(renderObject);
  assert.equal(audit.take().noObservedChange, 1);
  rewriting = true;
  renderer.encode(renderObject);
  const out = audit.take();
  assert.equal(out.skipWrongly, 1);
  assert.deepEqual(out.topDisagreements[0].reasons, ['uniformValue']);
  audit.detach();
});

// --- 6. an object nobody declared is not audited at all.
check('an undeclared object is ignored', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const declaredObject = fakeObject('wall');
  audit.declare(declaredObject);
  renderer.encode(fakeRenderObject(declaredObject, fakeCamera()));
  renderer.encode(fakeRenderObject(fakeObject('player'), fakeCamera()));
  const out = audit.take();
  assert.equal(out.audited, 1);
  assert.equal(out.ignored, 1);
  audit.detach();
});

// --- 6b. a predicate instead of an explicit declaration.
check('the declare predicate selects the opt-in class', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now, declare: object => object?.name?.startsWith('structure') === true });
  audit.attach(renderer);
  renderer.encode(fakeRenderObject(fakeObject('structure-a'), fakeCamera()));
  renderer.encode(fakeRenderObject(fakeObject('grass'), fakeCamera()));
  const out = audit.take();
  assert.equal(out.audited, 1);
  assert.equal(out.ignored, 1);
  audit.detach();
});

// --- 7. detach puts every method back.
check('detach restores every wrapped method', () => {
  const renderer = fakeRenderer();
  const originals = {
    needsRefresh: renderer._nodes.needsRefresh,
    bindings: renderer._bindings.updateForRender,
    updateBinding: renderer.backend.updateBinding,
    updateAttribute: renderer.backend.updateAttribute,
  };
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  assert.notEqual(renderer._nodes.needsRefresh, originals.needsRefresh);
  audit.detach();
  assert.equal(renderer._nodes.needsRefresh, originals.needsRefresh);
  assert.equal(renderer._bindings.updateForRender, originals.bindings);
  assert.equal(renderer.backend.updateBinding, originals.updateBinding);
  assert.equal(renderer.backend.updateAttribute, originals.updateAttribute);
  assert.equal(audit.attached, false);
});

// --- 8. two passes in one frame over the same mesh: two RenderObjects, two independent verdicts.
check('two passes with different cameras hold independent verdicts', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject('wall');
  audit.declare(object);
  const mainCamera = fakeCamera('main');
  const shadowCamera = fakeCamera('shadow');
  const mainObject = fakeRenderObject(object, mainCamera, { contextId: 1 });
  const shadowObject = fakeRenderObject(object, shadowCamera, { contextId: 2 });
  renderer.encode(mainObject); renderer.encode(shadowObject);
  audit.take();
  renderer.encode(mainObject); renderer.encode(shadowObject);
  const settled = audit.take();
  assert.equal(settled.passes, 2);
  assert.equal(settled.noObservedChange, 2);
  // Only the shadow camera moves: only the shadow pass's verdict changes.
  shadowCamera.matrixWorldInverse.elements[12] = 5;
  renderer.encode(mainObject); renderer.encode(shadowObject);
  const out = audit.take();
  assert.equal(out.passes, 2);
  assert.equal(out.noObservedChange, 1);
  assert.equal(out.snapshotChanged, 1);
  const shadowPass = out.passRows.find(row => row.camera === 'shadow');
  assert.equal(shadowPass.snapshotChanged, 1);
  assert.equal(out.passRows.find(row => row.camera === 'main').noObservedChange, 1);
  audit.detach();
});

// --- 9. the render origin: a rebase moves everything at once and bumps no version.
check('a render-origin rebase changes every declared snapshot', () => {
  const renderer = fakeRenderer();
  let renderOrigin = [0, 0, 0];
  const audit = createRefreshAudit({ now, origin: () => renderOrigin });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderer.encode(renderObject);
  audit.take();
  renderer.encode(renderObject);
  assert.equal(audit.take().noObservedChange, 1);
  renderOrigin = [1024, 0, 0];
  renderer.encode(renderObject);
  const out = audit.take();
  assert.equal(out.snapshotChanged, 1);
  assert.ok(out.topDisagreements[0].changed.includes('origin'));
  audit.detach();
});

// --- 10. matrixWorld, and the material mutated with no version bump.
check('a moved object and a version-less material change both invalidate', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderer.encode(renderObject); audit.take();
  renderer.encode(renderObject); assert.equal(audit.take().noObservedChange, 1);
  object.matrixWorld.elements[13] = 2;
  renderer.encode(renderObject);
  assert.ok(audit.take().topDisagreements[0].changed.includes('matrix'));
  renderer.encode(renderObject); audit.take();
  renderObject.material.opacity = 0.4;   // no version bump: the observer's blind spot
  renderer.encode(renderObject);
  assert.ok(audit.take().topDisagreements[0].changed.includes('material'));
  audit.detach();
});

// --- 11. the audit's own cost is reported.
check('auditMs and the per-object cost are reported', () => {
  let ticking = 0;
  const audit = createRefreshAudit({ now: () => (ticking += 0.5) });
  const renderer = fakeRenderer();
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderer.encode(renderObject);
  const out = audit.take();
  assert.ok(out.auditMs > 0, 'auditMs should be positive with a moving clock');
  assert.equal(out.auditMsPerObject, out.auditMs / out.audited);
  assert.equal(out.passRows[0].auditMs > 0, true);
  audit.detach();
});

// --- 12. attaching to a renderer without the seam fails closed.
check('a renderer missing the hooks reports them and does not half-attach', () => {
  const audit = createRefreshAudit({ now });
  assert.equal(audit.attach({}), false);
  assert.deepEqual(audit.missingHooks.sort(),
    ['_bindings.updateForRender', '_nodes.needsRefresh', 'backend.updateAttribute', 'backend.updateBinding']);
});


// --- 13. aliasing: a Vector3 a uniform holds, mutated IN PLACE after the snapshot, is still seen.
check('a uniform vector mutated in place is detected', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const live = { x: 1, y: 2, z: 3 };   // the same object every frame; only its fields move
  const uniform = { name: 'wind', value: live, getValue() { return this.value; } };
  const renderObject = fakeRenderObject(object, fakeCamera(), { uniforms: [uniform] });
  renderer.encode(renderObject); audit.take();
  renderer.encode(renderObject);
  assert.equal(audit.take().noObservedChange, 1);
  live.y = 2.0000001;
  renderer.encode(renderObject);
  const out = audit.take();
  assert.equal(out.snapshotChanged, 1);
  assert.ok(out.topDisagreements[0].changed.includes('bindings'));
  audit.detach();
});

// --- 13b. a material colour and a texture, both mutated in place rather than replaced.
check('a material colour and a texture version bumped in place are detected', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const texture = { isTexture: true, uuid: 'tex-1', version: 1 };
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderObject.material.color = { r: 1, g: 1, b: 1 };
  renderObject.material.map = texture;
  renderer.encode(renderObject); audit.take();
  renderer.encode(renderObject);
  assert.equal(audit.take().noObservedChange, 1);
  renderObject.material.color.g = 0.5;   // same Color object, new contents
  renderer.encode(renderObject);
  assert.ok(audit.take().topDisagreements[0].changed.includes('material'));
  renderer.encode(renderObject); audit.take();
  texture.version = 2;                   // same Texture object, re-uploaded
  renderer.encode(renderObject);
  assert.ok(audit.take().topDisagreements[0].changed.includes('material'));
  audit.detach();
});

// --- 13c. the snapshot must hold no reference into a live object: every stored field is a number.
check('every stored snapshot field is a primitive, never a live object', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderer.encode(renderObject);
  const out = audit.take();
  for (const row of out.passRows) for (const value of Object.values(row)) {
    assert.ok(typeof value !== 'object' || value === null, 'a pass row must not carry a live object');
  }
  audit.detach();
});

// --- 14. hash width: a single crafted element difference between two matrices must not collide.
check('two matrices differing in one element hash differently', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderer.encode(renderObject); audit.take();
  // A difference in the last mantissa bit, and a swap of two elements, are both changes a 32-bit
  // truncating hash could lose. Each must read as a matrix change.
  const cases = [
    () => { object.matrixWorld.elements[5] = 1 + Number.EPSILON; },
    () => { object.matrixWorld.elements[1] = 1; object.matrixWorld.elements[5] = 0; },
    () => { object.matrixWorld.elements[12] = -0.0000000001; },
  ];
  for (const mutate of cases) {
    renderer.encode(renderObject); audit.take();
    mutate();
    renderer.encode(renderObject);
    const out = audit.take();
    assert.equal(out.snapshotChanged, 1);
    assert.ok(out.topDisagreements[0].changed.includes('matrix'));
  }
  audit.detach();
});

// --- 14b. -0 and 0 are the same dependency, so a sign flip on zero is not a spurious change.
check('negative zero is not reported as a change', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderer.encode(renderObject); audit.take();
  renderer.encode(renderObject); audit.take();
  object.matrixWorld.elements[1] = -0;
  renderer.encode(renderObject);
  assert.equal(audit.take().noObservedChange, 1);
  audit.detach();
});

// --- 15. the old name is gone from the record: nothing downstream can read a `skipSafe` field.
check('the take reports noObservedChange and no skipSafe field', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const object = fakeObject();
  audit.declare(object);
  const renderObject = fakeRenderObject(object, fakeCamera());
  renderer.encode(renderObject); audit.take();
  renderer.encode(renderObject);
  const out = audit.take();
  assert.ok('noObservedChange' in out);
  assert.equal('skipSafe' in out, false);
  assert.equal('skipSafe' in out.passRows[0], false);
  assert.ok('noObservedChange' in out.passRows[0]);
  audit.detach();
});

// --- 16. steady-state reuse: 2,000 frames of the same objects must retain no extra memory, and
// must keep reporting correctly. Retention is measured only under --expose-gc, where it is stable;
// the allocation-rate comparison lives in scratchpads/refresh-audit-d4/measure-alloc.mjs.
check('two thousand frames of the same objects retain nothing and stay correct', () => {
  const renderer = fakeRenderer();
  const audit = createRefreshAudit({ now });
  audit.attach(renderer);
  const objects = [];
  for (let i = 0; i < 20; i++) {
    const object = fakeObject(`wall-${i}`);
    audit.declare(object);
    objects.push(fakeRenderObject(object, fakeCamera()));
  }
  const frame = () => { for (const ro of objects) renderer.encode(ro); return audit.take(); };
  for (let f = 0; f < 300; f++) frame();   // long enough that JIT warm-up is not counted
  global.gc?.(); global.gc?.();
  const before = process.memoryUsage().heapUsed;
  let last;
  for (let f = 0; f < 2000; f++) last = frame();
  assert.equal(last.audited, 20);
  assert.equal(last.noObservedChange, 20);
  assert.equal(last.topDisagreements.length, 0, 'rows must be reset between takes');
  if (typeof global.gc === 'function') {
    global.gc(); global.gc();
    const grown = process.memoryUsage().heapUsed - before;
    assert.ok(grown < 64 * 1024, `retained ${grown} bytes after 40,000 audits of 20 objects`);
  }
  audit.detach();
});

console.log(failures === 0 ? '\nall refresh-audit checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
