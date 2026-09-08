import assert from 'node:assert/strict';
import { createRenderTrace } from './render-trace.js';

let clock = 0;
const now = () => clock;
const round3 = v => Math.round(v * 1000) / 1000;

// A stand-in with the same call shape as the WebGPU renderer: render a scene, project the graph
// recursively, sort the list, then encode each object. The three hooks are the three places a
// nested scene render can start from: inside an object's encode (what a post chain does), between
// the sort and the object loop (inside no phase at all), and inside a bundle replay.
function fakeRenderer({ onEncode = null, beforeObjects = null, onBundle = null } = {}) {
  const list = { items: [], sort() { clock += 2; } };
  const renderer = {
    _renderLists: { get() { return list; } },
    _renderScene(scene, camera, objectCount) {
      clock += 1;
      this._projectObject({ depth: 2 });
      this._renderLists.get().sort();
      beforeObjects?.(renderer);
      this._renderObjects(new Array(objectCount).fill(0));
    },
    _projectObject(node) {
      clock += 1;
      if (node.depth > 0) this._projectObject({ depth: node.depth - 1 });
    },
    _renderObjects(objects) {
      clock += 1;
      for (const drawn of objects) this._renderObjectDirect(drawn?.object ?? null, drawn?.material ?? null, drawn?.cost);
    },
    _renderObjectDirect(object, material, cost) { clock += (cost ?? 3); onEncode?.(renderer); },
    _renderBundle() { clock += 4; onBundle?.(renderer); },
    // The managers the sub-phase hooks live on. Empty bodies: the flat-frame cases never call them,
    // and the sub-phase cases below drive them directly.
    _nodes: { updateBefore() {}, updateForRender() {}, needsRefresh() { return true; } },
    _geometries: { updateForRender() {} },
    _bindings: { updateForRender() {} },
    _pipelines: { updateForRender() {}, _getRenderPipeline() { return {}; } },
    backend: { draw() {}, createBindings() {}, updateBinding() {}, updateAttribute() {}, createProgram() {} },
  };
  return { renderer, list };
}

// A renderer whose encode runs the real six-stage chain, each stage costing what the case names.
function subPhaseRenderer({ cost = {}, refresh = () => true, onBindings = null } = {}) {
  const spend = (key, fallback) => { clock += cost[key] ?? fallback; };
  const list = { sort() {} };
  const renderer = {
    _renderLists: { get() { return list; } },
    _renderScene(scene, camera, drawn) { this._renderObjects(drawn); },
    _projectObject() {},
    _renderObjects(drawn) { for (const item of drawn) this._renderObjectDirect(item.object, item.material); },
    _renderObjectDirect(object, material) {
      const renderObject = { object, material };
      const needsRefresh = this._nodes.needsRefresh(renderObject);
      if (needsRefresh) {
        this._nodes.updateBefore(renderObject);
        this._geometries.updateForRender(renderObject);
        this._nodes.updateForRender(renderObject);
        this._bindings.updateForRender(renderObject);
      }
      this._pipelines.updateForRender(renderObject);
      this.backend.draw(renderObject);
    },
    _renderBundle() {},
    _nodes: {
      updateBefore() { spend('nodesBefore', 1); },
      updateForRender() { spend('nodesRender', 2); },
      needsRefresh(renderObject) { return refresh(renderObject); },
    },
    _geometries: { updateForRender() { spend('geometries', 1); } },
    _bindings: { updateForRender(renderObject) { spend('bindings', 5); onBindings?.(renderer, renderObject); } },
    _pipelines: {
      updateForRender(renderObject) { spend('pipelines', 1); if (renderObject?.material?.compile) this._getRenderPipeline(renderObject, {}, {}, 'key', renderObject.material.async ? [] : null); },
      _getRenderPipeline(renderObject) { spend('pipelineCreate', renderObject?.material?.compileMs ?? 40); renderer.backend.createProgram({}); return {}; },
    },
    backend: {
      draw() { spend('draw', 3); },
      createProgram() { spend('programCreate', 10); },
      createBindings() {},
      updateBinding() {},
      updateAttribute() {},
    },
  };
  return renderer;
}

// Runs `body` once, with a guard so the nested render does not itself nest forever.
function once(fn) {
  let inside = false;
  return (renderer) => {
    if (inside) return;
    inside = true;
    try { fn(renderer); } finally { inside = false; }
  };
}

{
  const { renderer } = fakeRenderer();
  const trace = createRenderTrace({ now });
  assert.equal(trace.attach(renderer), true, 'attaches to a renderer that has the hooks');
  assert.deepEqual(trace.missingHooks, [], 'all five hooks plus the render lists were found');

  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 2);
  renderer._renderBundle();
  // Two draws with no object behind them fold into one 'unknown' row rather than two.

  const t = trace.take();
  assert.equal(t.sceneRenders, 1);
  assert.equal(t.projectCalls, 1, 'recursion is counted once, not per node');
  assert.equal(t.projectMs, 3, 'three nested projects, one millisecond each, timed once');
  assert.equal(t.sortCalls, 1);
  assert.equal(t.sortMs, 2);
  assert.equal(t.objectListCalls, 1);
  assert.equal(t.encodedObjects, 2, 'the render list length is the object count');
  assert.equal(t.encodeCalls, 2);
  assert.equal(t.encodeMs, 6, 'per-object encode is summed across calls');
  assert.equal(t.objectsMs, 7, 'objectsMs contains encodeMs');
  assert.equal(t.sceneMs, 13, 'the scene contains project, sort and objects');
  assert.equal(t.bundleGroups, 1);
  assert.equal(t.bundleMs, 4, 'a bundle replayed outside any scene render is still counted');
  assert.equal(t.scenes.length, 1, 'one entry per scene render');
  assert.equal(t.scenes[0].name, 'base-game');
  assert.equal(t.scenes[0].camera, 'PerspectiveCamera', 'the entry says which camera drew it');
  assert.equal(t.scenes[0].objects, 2, 'the object count comes from the render list that pass encoded');
  assert.deepEqual(t.scenes[0].top, [{ name: 'unknown', material: 'none', ms: 6, calls: 2 }],
    'draws with no object share one row');
  assert.equal(t.scenes[0].topShare, 1);
  console.log('pass: a flat frame attributes the phases and does not double count recursion');

  const empty = trace.take();
  assert.equal(empty.sceneRenders, 0);
  assert.equal(empty.sceneMs, 0);
  console.log('pass: take() resets the totals');
}

{
  // The real Base Game shape: the post chain's output quad is the OUTER scene render, one object,
  // and the whole world render happens nested inside that object's encode. Before the stack, the
  // guard dropped the inner render and the frame read as one object costing 15-27 ms.
  const { renderer } = fakeRenderer({
    onEncode: once(r => r._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 4)),
  });
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'post' }, { type: 'OrthographicCamera' }, 1);
  const t = trace.take();

  assert.equal(t.scenes.length, 2, 'the nested scene render is its own entry');
  const [quad, world] = t.scenes;
  assert.equal(quad.name, 'post');
  assert.equal(world.name, 'base-game', 'and it is named and cameraed separately');
  assert.equal(world.camera, 'PerspectiveCamera');

  // The world render: 1 enter + 3 project + 2 sort + 1 objects + 4 x 3 encode = 19.
  assert.equal(world.ms, 19);
  assert.equal(world.exclusiveMs, 19, 'the innermost render has no children to subtract');
  assert.equal(world.objects, 4);
  assert.equal(world.draws, 4);
  assert.equal(world.encodeMs, 12);

  // The quad: 1 + 3 + 2 + 1 + 3 for its own object, plus the 19 the world cost inside that encode.
  assert.equal(quad.ms, 29);
  assert.equal(quad.exclusiveMs, 10, 'the outer render reports its own time, not the frame');
  assert.equal(quad.objects, 1);
  assert.equal(quad.draws, 1);
  assert.equal(quad.encodeMs, 3, 'the outer encode excludes the scene render nested inside it');
  assert.equal(quad.objectsMs, 4, 'and so does the object loop that contained it');

  assert.equal(t.sceneMs, 29, 'the totals sum exclusive time, so nesting is not counted twice');
  assert.equal(t.encodedObjects, 5, 'objects are the quad plus the world');
  assert.equal(t.encodeCalls, 5);
  assert.equal(t.projectCalls, 2, 'each scene render walks its own graph');
  assert.equal(t.sortCalls, 2);
  console.log('pass: a nested scene render is its own entry and the parent excludes its time');
}

{
  // A nested render that starts BEFORE the parent's object loop is inside none of its phase timers,
  // so nothing may be subtracted from them. Charging every child to encode/objects unconditionally
  // made an outer render that had not encoded anything yet report negative time there.
  const { renderer } = fakeRenderer({
    beforeObjects: once(r => r._renderScene({ name: 'shadow' }, { type: 'OrthographicCamera' }, 2)),
  });
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 1);
  const t = trace.take();

  assert.equal(t.scenes.length, 2);
  const [outer, child] = t.scenes;
  assert.equal(child.name, 'shadow');
  // The child: 1 enter + 3 project + 2 sort + 1 objects + 2 x 3 encode = 13.
  assert.equal(child.ms, 13);
  assert.equal(child.exclusiveMs, 13);
  // The outer render's own object loop ran after the child returned, so its timers are untouched:
  // exactly what the same scene costs with no child at all.
  assert.equal(outer.objectsMs, 4, 'the object loop is unchanged by a child that ran before it');
  assert.equal(outer.encodeMs, 3, 'and so is the encode');
  assert.equal(outer.projectMs, 3, 'the projection had already finished too');
  assert.equal(outer.sortMs, 2);
  assert.equal(outer.ms, 23, 'the outer render still contains the child');
  assert.equal(outer.exclusiveMs, 10, 'but its own time does not');
  assert.equal(t.encodeMs, 9, 'the frame encode is the outer object plus the two in the child');
  console.log('pass: a child that runs outside the parent phases is subtracted from none of them');
}

{
  // The same rule for a bundle replay: a scene render nested inside _renderBundle comes out of the
  // parent's bundleMs, and out of nothing else.
  const { renderer } = fakeRenderer({
    onBundle: once(r => r._renderScene({ name: 'mirror' }, { type: 'PerspectiveCamera' }, 1)),
  });
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 1);
  renderer._renderBundle();
  const t = trace.take();

  assert.equal(t.scenes.length, 2);
  const child = t.scenes.find(entry => entry.name === 'mirror');
  // 1 enter + 3 project + 2 sort + 1 objects + 3 encode = 10.
  assert.equal(child.ms, 10);
  assert.equal(child.exclusiveMs, 10);
  // The bundle ran outside any scene render here, so its timer lives in the totals: 4 for the
  // replay itself, with the 10 the nested render cost taken back out.
  assert.equal(t.bundleMs, 4, 'the bundle replay excludes the scene render nested inside it');
  assert.equal(t.bundleGroups, 1);
  console.log('pass: a child nested inside a bundle replay comes out of the bundle timer');
}

{
  const { renderer, list } = fakeRenderer();
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 1);
  assert.equal(trace.take().sortCalls, 1);
  trace.detach();

  // Render lists are cached per (scene, camera) and outlive a trace, so a detached trace that left
  // its sort hook in place kept collecting through a list it had already let go of -- and the next
  // trace saw __traceSort and never patched it, so its sorts vanished.
  const second = createRenderTrace({ now });
  second.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 1);
  const t = second.take();
  assert.equal(t.sortCalls, 1, 'a fresh trace on the same render list still counts the sort');
  assert.equal(t.sortMs, 2);
  second.detach();
  assert.equal(list.__traceSort, undefined, 'and the flag is cleared on the way out');

  // A later owner's hook must survive our detach.
  const mine = list.sort;
  const third = createRenderTrace({ now });
  third.attach(renderer);
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 1);
  const theirs = function (...args) { return mine.apply(this, args); };
  list.sort = theirs;
  third.detach();
  assert.equal(list.sort, theirs, 'detach leaves a hook installed after ours alone');
  console.log('pass: detach unpatches the render lists it patched, and only those');
}

{
  // Per-object attribution. With trees and grass off, 93 objects cost the same encode as 202, so
  // the useful question is which objects are expensive, not how many there are.
  const standard = { type: 'MeshStandardNodeMaterial' };
  const prop = { name: 'prop' };   // one mesh drawn twice, as a two-group geometry is
  const list = [
    { object: { name: 'terrain' }, material: standard, cost: 9 },
    { object: { name: 'water' }, material: { type: 'MeshPhysicalNodeMaterial' }, cost: 4 },
    { object: prop, material: standard, cost: 1 },
    { object: prop, material: standard, cost: 2 },
    { object: { name: 'sky' }, material: { type: 'MeshBasicNodeMaterial' }, cost: 6 },
  ];
  const { renderer } = fakeRenderer();
  renderer._renderScene = function (scene, camera) {
    clock += 1;
    this._projectObject({ depth: 0 });
    this._renderLists.get().sort();
    this._renderObjects(list);
  };
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' });
  const t = trace.take();
  const [entry] = t.scenes;

  assert.equal(entry.draws, 5);
  assert.equal(entry.encodeMs, 22, '9 + 4 + 1 + 2 + 6');
  assert.deepEqual(entry.top.map(row => row.name), ['terrain', 'sky', 'water', 'prop'],
    'heaviest first, and the two prop draws are one row');
  assert.deepEqual(entry.top[0], { name: 'terrain', material: 'MeshStandardNodeMaterial', ms: 9, calls: 1 });
  assert.deepEqual(entry.top.at(-1), { name: 'prop', material: 'MeshStandardNodeMaterial', ms: 3, calls: 2 },
    'the same object and material accumulate across calls');
  assert.equal(entry.topShare, 1, 'four rows cover the whole encode here');
  console.log('pass: the heaviest objects of a scene render are named, in order, with their share');

  // More objects than the cap: the rows are the heaviest, and the share says what they miss.
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ object: { name: `mesh${i}` }, material: { type: 'M' }, cost: i + 1 });
  const second = fakeRenderer().renderer;
  second._renderScene = function () { this._renderObjects(many); };   // set before attach, or the hook is lost
  const cappedTrace = createRenderTrace({ now });
  cappedTrace.attach(second);
  clock = 0;
  second._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' });
  const capped = cappedTrace.take().scenes[0];
  assert.equal(capped.top.length, 12, 'capped at twelve rows');
  assert.equal(capped.top[0].name, 'mesh19');
  assert.equal(capped.top.at(-1).name, 'mesh8');
  // 20 + 19 + ... + 9 = 174, of 1 + ... + 20 = 210, plus the 1 ms the object loop itself costs.
  assert.equal(capped.encodeMs, 210);
  assert.equal(capped.objectsMs, 211, 'the object loop is the draws plus its own millisecond');
  assert.equal(capped.topShare, round3(174 / 210), 'the share says how much the rows account for');
  console.log('pass: the rows are capped and topShare says what they leave out');
}

{
  // The worst frame is kept aside with its rows. A capture reports the frame its button landed on,
  // which is never the frame that dipped, so the encode spikes were never named.
  const mesh = { name: 'terrain' };
  const material = { type: 'MeshStandardNodeMaterial' };
  // A renderer whose whole frame is one object costing what the case asks for, so sceneMs is that
  // number exactly.
  const list = { sort() {} };
  const renderer = {
    _renderLists: { get() { return list; } },
    _renderScene(scene, camera, cost) { this._renderObjects([cost]); },
    _projectObject() {},
    _renderObjects(costs) { for (const cost of costs) this._renderObjectDirect(mesh, material, cost); },
    _renderObjectDirect(object, mat, cost) { clock += cost; },
    _renderBundle() {},
  };
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  assert.equal(trace.worst, null, 'nothing retained before the first frame');

  for (const cost of [5, 30, 10]) {
    clock = 0;
    renderer._renderScene({ name: `frame-${cost}` }, { type: 'PerspectiveCamera' }, cost);
    trace.take();
  }

  const kept = trace.worst;
  assert.ok(kept, 'a worst frame is retained');
  assert.equal(kept.sceneMs, 30, 'the heaviest of the three, not the last');
  assert.equal(kept.encodeMs, 30);
  assert.equal(kept.scenes.length, 1);
  assert.equal(kept.scenes[0].name, 'frame-30', 'and it is that frame, whole');
  assert.deepEqual(kept.scenes[0].top, [{ name: 'terrain', material: 'MeshStandardNodeMaterial', ms: 30, calls: 1 }],
    'with its per-object rows');
  assert.equal(trace.worst.sceneMs, 30, 'reading it does not clear it');

  assert.equal(kept.frame, 2, 'the record says which frame it was');
  assert.equal(kept.metric, 'mainSceneEncodeMs', 'the record names the metric it was chosen by');
  assert.equal(kept.metricMs, 30);
  assert.equal(kept.mainScene, 'frame-30', 'and which scene render that was');
  assert.equal(trace.worstEncode.sceneMs, 30, 'worst by encode too, when one frame is worst by both');

  // The host attaches what only it knows about that frame.
  trace.annotateWorst({ atCaptureMs: 4210, speed: 5.2, events: { terrainInstalls: 3 } });
  assert.equal(trace.worst.atCaptureMs, undefined, 'a frame that is no longer the current one is left alone');

  const taken = trace.takeWorst();
  assert.equal(taken.worst.sceneMs, 30);
  assert.equal(taken.worstEncode.sceneMs, 30);
  assert.equal(trace.worst, null, 'takeWorst clears, so the next capture starts looking again');
  assert.equal(trace.worstEncode, null);

  clock = 0;
  renderer._renderScene({ name: 'frame-2' }, { type: 'PerspectiveCamera' }, 2);
  trace.take();
  assert.equal(trace.worst.sceneMs, 2, 'and the next frame becomes the new worst');
  trace.annotateWorst({ atCaptureMs: 120, speed: 4.5, events: { terrainInstalls: 2 } });
  assert.equal(trace.worst.atCaptureMs, 120, 'the frame just taken can be annotated by the host');
  assert.equal(trace.worst.speed, 4.5);
  assert.deepEqual(trace.worst.events, { terrainInstalls: 2 });
  console.log('pass: the worst frame is retained whole, read without clearing, and cleared on demand');
}

{
  // Which entry is the main scene: the one that encoded the most objects. The post chain's quad
  // encodes one and wraps the world render, so picking by time would always pick the quad.
  const { renderer } = fakeRenderer({
    onEncode: once(r => r._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 4)),
  });
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'post' }, { type: 'OrthographicCamera' }, 1);
  trace.take();
  assert.equal(trace.worstEncode.mainScene, 'base-game', 'the world render, not the quad that contains it');
  assert.equal(trace.worstEncode.metricMs, 12, 'and the metric is that scene encode, four objects at 3 ms');
  console.log('pass: the main scene is the world render, not the quad that wraps it');
}

{
  // A shadow pass LISTS more objects than the world pass and draws a fraction of them. Choosing by
  // list length labelled the shadow map the main scene and reported its 11 ms encode as the frame's
  // worst, while the world pass that actually cost 58 ms went unnamed.
  const list = { sort() {} };
  const renderer = {
    _renderLists: { get() { return list; } },
    // `listed` is what the render list held; `drawn` is what was encoded, each costing `each`.
    _renderScene(scene, camera, listed, drawn, each) {
      this._renderObjects(new Array(listed).fill(0), drawn, each);
    },
    _projectObject() {},
    _renderObjects(objects, drawn, each) {
      for (let i = 0; i < drawn; i++) this._renderObjectDirect({ name: 'mesh' }, { type: 'M' }, each);
    },
    _renderObjectDirect(object, material, cost) { clock += cost; },
    _renderBundle() {},
  };
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'Shadow Map [ sun ]' }, { type: 'OrthographicCamera' }, 240, 32, 0.35);
  renderer._renderScene({ name: 'Scene' }, { type: 'PerspectiveCamera' }, 206, 218, 0.269);
  const t = trace.take();

  const shadow = t.scenes[0], world = t.scenes[1];
  assert.equal(shadow.objects, 240, 'the shadow pass listed the most objects');
  assert.equal(shadow.draws, 32, 'and drew the fewest');
  assert.equal(world.objects, 206);
  assert.equal(world.draws, 218);
  assert.ok(world.encodeMs > shadow.encodeMs * 4, `world ${world.encodeMs} ms vs shadow ${shadow.encodeMs} ms`);

  const kept = trace.worstEncode;
  assert.equal(kept.mainScene, 'Scene', 'the world pass is the main scene, by draws and not by list length');
  assert.equal(kept.metricMs, world.encodeMs, 'so the metric is the encode that actually cost the frame');
  assert.notEqual(kept.metricMs, shadow.encodeMs);
  console.log('pass: a shadow pass that lists more objects than it draws is not the main scene');
}

{
  // No perspective pass in the frame at all: fall back to the most draws of anything, rather than
  // reporting no main scene.
  const list = { sort() {} };
  const renderer = {
    _renderLists: { get() { return list; } },
    _renderScene(scene, camera, drawn) { this._renderObjects(new Array(drawn).fill(0)); },
    _projectObject() {},
    _renderObjects(objects) { for (const _ of objects) this._renderObjectDirect({ name: 'mesh' }, { type: 'M' }, 1); },
    _renderObjectDirect(object, material, cost) { clock += cost; },
    _renderBundle() {},
  };
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'Shadow Map [ sun ]' }, { type: 'OrthographicCamera' }, 4);
  renderer._renderScene({ name: 'Shadow Map [ lamp ]' }, { type: 'OrthographicCamera' }, 9);
  trace.take();
  assert.equal(trace.worstEncode.mainScene, 'Shadow Map [ lamp ]', 'the heaviest of what there is');
  console.log('pass: with no perspective pass, the most draws of anything is the main scene');
}

{
  const { renderer } = fakeRenderer();
  const trace = createRenderTrace({ now });
  const before = renderer._renderScene;
  trace.attach(renderer);
  assert.notEqual(renderer._renderScene, before, 'the hook replaced the method');
  trace.detach();
  assert.equal(renderer._renderScene, before, 'detach restores the original method');
  assert.equal(trace.attached, false);
  console.log('pass: detach restores every hook');
}

{
  const trace = createRenderTrace({ now });
  assert.equal(trace.attach({}), false, 'a renderer with none of the hooks does not attach');
  assert.ok(trace.missingHooks.includes('_renderScene'));
  assert.ok(trace.missingHooks.includes('_renderLists.get'));
  console.log('pass: a renderer without the private hooks reports them missing');
}

{
  // The six stages inside one object's encode, in the order _renderObjectDirect calls them.
  const standard = { type: 'MeshStandardNodeMaterial' };
  const basic = { type: 'MeshBasicNodeMaterial' };
  const drawn = [
    { object: { name: 'terrain' }, material: standard },
    { object: { name: 'sky' }, material: basic },
  ];
  const renderer = subPhaseRenderer();
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  assert.deepEqual(trace.missingHooks, [], 'every manager hook was found on the fake renderer');
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, drawn);
  const t = trace.take();
  const [entry] = t.scenes;

  assert.equal(entry.draws, 2);
  assert.equal(entry.nodesBeforeMs, 2, 'one millisecond per object');
  assert.equal(entry.geometriesMs, 2);
  assert.equal(entry.nodesRenderMs, 4);
  assert.equal(entry.bindingsMs, 10);
  assert.equal(entry.pipelinesMs, 2);
  assert.equal(entry.drawMs, 6);
  assert.equal(entry.encodeMs, 26, 'the six stages are inside the encode, and are the whole of it here');
  assert.equal(entry.nodesBeforeMs + entry.geometriesMs + entry.nodesRenderMs
    + entry.bindingsMs + entry.pipelinesMs + entry.drawMs, entry.encodeMs,
    'the stages add up to the encode when nothing else runs inside it');
  assert.equal(t.bindingsMs, 10, 'and the totals sum them over the scene entries');
  assert.equal(t.timed, true, 'this frame was timed, not an overhead run');

  assert.equal(entry.refreshChecks, 2);
  assert.equal(entry.refreshes, 2, 'both objects took the refresh branch');
  assert.equal(entry.uniqueMaterials, 2);
  assert.equal(t.uniqueMaterials, 2);

  assert.deepEqual(entry.topBindings.map(row => row.name), ['terrain', 'sky'],
    'the bindings phase names the objects it spent its time on');
  assert.deepEqual(entry.topBindings[0], { name: 'terrain', material: 'MeshStandardNodeMaterial', ms: 5, calls: 1 });
  assert.equal(entry.topBindingsShare, 1);
  // Both nodes stages share one table: 1 + 2 per object.
  assert.deepEqual(entry.topNodes[0], { name: 'terrain', material: 'MeshStandardNodeMaterial', ms: 3, calls: 2 });
  assert.equal(entry.topNodesShare, 1);
  console.log('pass: the six encode stages are timed separately and nodes and bindings name their objects');
}

{
  // Only some objects take the refresh branch, and only those run the four gated stages.
  const shared = { type: 'M' };   // one material instance, three objects
  const drawn = [
    { object: { name: 'a' }, material: shared },
    { object: { name: 'b' }, material: shared },
    { object: { name: 'c' }, material: shared },
  ];
  const renderer = subPhaseRenderer({ refresh: renderObject => renderObject.object.name === 'b' });
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, drawn);
  const entry = trace.take().scenes[0];
  assert.equal(entry.refreshChecks, 3, 'every object is asked');
  assert.equal(entry.refreshes, 1, 'only the truthy answers are counted');
  assert.equal(entry.bindingsMs, 5, 'and only that object paid for a binding update');
  assert.equal(entry.pipelinesMs, 3, 'while the pipeline stage runs for all three, outside the gate');
  assert.equal(entry.uniqueMaterials, 1, 'three objects sharing one material are one material');
  console.log('pass: the refresh counter counts truthy answers, not calls');
}

{
  // A scene render nested inside a binding update -- what a reflector does from a node's
  // updateBefore -- comes out of the parent's bindings timer and out of nothing else.
  const child = [{ object: { name: 'mirror-mesh' }, material: { type: 'M' } }];
  let inside = false;
  const renderer = subPhaseRenderer({
    onBindings: (r) => {
      if (inside) return;
      inside = true;
      try { r._renderScene({ name: 'mirror' }, { type: 'PerspectiveCamera' }, child); }
      finally { inside = false; }
    },
  });
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' },
    [{ object: { name: 'water' }, material: { type: 'M' } }]);
  const t = trace.take();
  assert.equal(t.scenes.length, 2);
  const [parent, mirror] = t.scenes;
  assert.equal(mirror.name, 'mirror');
  assert.equal(mirror.ms, 13, 'the child costs one full object chain');
  assert.equal(mirror.exclusiveMs, 13);
  assert.equal(mirror.bindingsMs, 5, 'its own binding update is its own');
  assert.equal(parent.bindingsMs, 5, 'the parent binding timer excludes the render nested inside it');
  assert.equal(parent.encodeMs, 13, 'and so does the encode that contained it');
  assert.equal(parent.ms, 26, 'the parent still contains the child inclusively');
  assert.equal(parent.exclusiveMs, 13);
  assert.equal(parent.topBindings[0].ms, 5, 'the water row is its own binding cost, not the mirror render');
  console.log('pass: a nested scene render is subtracted from the parent bindings phase');
}

{
  // Re-entrancy: a manager method that calls itself is timed once, by the outermost call.
  const inner = { object: { name: 'inner' }, material: { type: 'M' } };
  const renderer = subPhaseRenderer();
  const base = renderer._bindings.updateForRender.bind(renderer._bindings);
  let depth = 0;
  renderer._bindings.updateForRender = function (renderObject) {
    base(renderObject);
    if (depth === 0) { depth++; try { renderer._bindings.updateForRender(inner); } finally { depth--; } }
  };
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' },
    [{ object: { name: 'outer' }, material: { type: 'M' } }]);
  const entry = trace.take().scenes[0];
  assert.equal(entry.bindingsMs, 10, 'the outer call is timed once and contains the inner five');
  assert.equal(entry.topBindings.length, 1, 'and the re-entrant call opens no second row');
  assert.equal(entry.topBindings[0].name, 'outer');
  console.log('pass: a re-entrant sub-phase call is not timed twice');
}

{
  // What the backend was asked to send. Counted, not timed, so a missing byteLength reads as zero
  // bytes rather than as no write.
  const renderer = subPhaseRenderer();
  renderer._bindings.updateForRender = function (renderObject) {
    clock += 5;
    renderer.backend.createBindings({});
    renderer.backend.updateBinding({ byteLength: 256 });
    renderer.backend.updateBinding({});                          // a binding with no size to report
    renderer.backend.updateBinding(rangedBinding);               // a uniforms group with two changed uniforms
  };
  // A binding with update ranges (a UniformsGroup after two changed uniforms) counts the ranges,
  // read before the call because Bindings._update clears them after the upload.
  const rangedBinding = { name: 'objectGroup', byteLength: 4096, buffer: { byteLength: 4096, BYTES_PER_ELEMENT: 4 }, updateRanges: [{ start: 0, count: 16 }, { start: 64, count: 4 }], uniforms: [{ name: 'modelViewMatrix', offset: 0 }, { name: 'uSunDir', offset: 64 }] };
  const realUpdateBinding = renderer.backend.updateBinding;
  renderer.backend.updateBinding = function (b) { if (b.updateRanges) b.updateRanges.length = 0; return realUpdateBinding?.call(this, b); };
  // A ranged attribute counts what the backend will write; the fake backend clears the ranges as the
  // real one does, so the count has to be read before the call.
  const ranged = { array: { byteLength: 65536, BYTES_PER_ELEMENT: 4 }, updateRanges: [{ start: 0, count: 96 }, { start: 400, count: 4 }] };
  renderer.backend.updateAttribute = function (attr) { if (attr.updateRanges) attr.updateRanges.length = 0; };
  renderer._geometries.updateForRender = function () {
    clock += 1;
    renderer.backend.updateAttribute({ array: { byteLength: 1024 } });
    renderer.backend.updateAttribute(ranged);
  };
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' },
    [{ object: { name: 'a' }, material: { type: 'M' } }]);
  const t = trace.take();
  const entry = t.scenes[0];
  assert.equal(entry.bindingCreates, 1);
  assert.equal(entry.bindingWrites, 3);
  assert.deepEqual(entry.uniformWriteRows, [{ name: 'objectGroup/modelViewMatrix', count: 1 }, { name: 'objectGroup/uSunDir', count: 1 }], 'the changed uniforms are named by group and name');
  assert.equal(entry.bindingWriteBytes, 256 + 80, 'whole buffers report byteLength, ranged groups their ranges times element size, sizeless ones zero');
  assert.equal(rangedBinding.updateRanges.length, 0, 'read before the call cleared the ranges');
  assert.equal(entry.attributeWrites, 2);
  assert.equal(entry.attributeWriteBytes, 1024 + 400, 'a whole array reports its byteLength; ranges report count times element size, not the array');
  assert.equal(ranged.updateRanges.length, 0, 'the fake backend cleared the ranges, so the count was read before the call');
  assert.equal(t.bindingWrites, 3, 'and the totals carry them too');
  assert.equal(t.attributeWriteBytes, 1424);
  console.log('pass: binding creations and buffer writes are counted, with bytes where they are known');
}

{
  // Overhead mode: every wrapper installed, every timer reading zero. Run the same frame twice and
  // the difference in wall time is what the instrumentation costs.
  const drawn = [
    { object: { name: 'a' }, material: { type: 'M' } },
    { object: { name: 'b' }, material: { type: 'M' } },
  ];
  const renderer = subPhaseRenderer();
  const trace = createRenderTrace({ now, timePhases: false });
  trace.attach(renderer);
  assert.equal(trace.timed, false, 'the trace says which mode it is in');
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, drawn);
  const t = trace.take();
  const entry = t.scenes[0];
  assert.equal(t.timed, false, 'and so does the frame');
  for (const key of ['sceneMs', 'encodeMs', 'bindingsMs', 'nodesBeforeMs', 'nodesRenderMs',
    'geometriesMs', 'pipelinesMs', 'drawMs']) assert.equal(t[key], 0, `${key} reads zero without timing`);
  assert.equal(entry.ms, 0);
  assert.equal(entry.draws, 2, 'the counters still count');
  assert.equal(entry.refreshes, 2);
  assert.equal(entry.uniqueMaterials, 2);
  assert.equal(entry.topBindings.length, 2, 'the rows are still named, at zero milliseconds');
  assert.equal(entry.topBindings[0].ms, 0);
  console.log('pass: overhead mode counts everything and times nothing');

{
  // A pipeline cache miss names the material that compiled, with its time and path, and nothing
  // else in the frame is charged for it twice: the create sits inside pipelinesMs.
  const renderer = subPhaseRenderer();
  const trace = createRenderTrace({ now });
  trace.attach(renderer);
  clock = 0;
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, [
    { object: { name: 'tree' }, material: { type: 'MeshStandardNodeMaterial', name: 'bark', compile: true, compileMs: 700 } },
    { object: { name: 'rock' }, material: { type: 'MeshStandardNodeMaterial' } },
    { object: { name: 'flare' }, material: { type: 'SpriteNodeMaterial', name: 'glow', compile: true, compileMs: 30, async: true } },
  ]);
  const t = trace.take();
  const entry = t.scenes[0];
  assert.equal(entry.pipelineCreates, 2, 'two cache misses');
  assert.equal(entry.pipelineCreateMs, 700 + 10 + 30 + 10, 'the create time includes the program creation it triggered');
  assert.equal(entry.programCreates, 2);
  assert.equal(entry.programCreateMs, 20);
  assert.deepEqual(entry.pipelineCreateRows.map(r => [r.name, r.materialName, r.ms, r.async]), [['tree', 'bark', 710, false], ['flare', 'glow', 40, true]], 'rows name the object and material, time and path');
  assert.ok(entry.pipelinesMs >= entry.pipelineCreateMs, 'the create is part of the pipelines stage, not added to it');
  assert.equal(t.pipelineCreates, 2, 'and the frame totals carry them');
  assert.equal(t.pipelineCreateRows[0].scene, 'base-game');
  console.log('pass: a pipeline cache miss is named, timed and attributed to its path');
}
}

console.log('render-trace: all tests passed');
