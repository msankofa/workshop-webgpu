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
  };
  return { renderer, list };
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

console.log('render-trace: all tests passed');
