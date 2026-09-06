import assert from 'node:assert/strict';
import { createRenderTrace } from './render-trace.js';

let clock = 0;
const now = () => clock;

// A stand-in with the same call shape as the WebGPU renderer: render a scene, project the graph
// recursively, sort the list, then encode each object.
function fakeRenderer() {
  const list = { items: [], sort() { clock += 2; } };
  const renderer = {
    _renderLists: { get() { return list; } },
    _renderScene(objectCount) {
      clock += 1;
      this._projectObject({ depth: 2 });
      this._renderLists.get().sort();
      this._renderObjects(new Array(objectCount).fill(0));
    },
    _projectObject(node) {
      clock += 1;
      if (node.depth > 0) this._projectObject({ depth: node.depth - 1 });
    },
    _renderObjects(objects) {
      clock += 1;
      for (const _ of objects) this._renderObjectDirect();
    },
    _renderObjectDirect() { clock += 3; },
    _renderBundle() { clock += 4; },
  };
  return { renderer, list };
}

{
  const { renderer } = fakeRenderer();
  const trace = createRenderTrace({ now });
  assert.equal(trace.attach(renderer), true, 'attaches to a renderer that has the hooks');
  assert.deepEqual(trace.missingHooks, [], 'all five hooks plus the render lists were found');

  clock = 0;
  renderer._renderScene(2);
  renderer._renderBundle();
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
  assert.equal(t.sceneMs, 13, 'sceneMs contains project, sort and objects');
  assert.equal(t.bundleGroups, 1);
  assert.equal(t.bundleMs, 4);
  assert.equal(t.scenes.length, 1, 'one entry per whole scene render');
  assert.deepEqual(t.scenes[0], { ms: 13, objects: 2, draws: 2, bundles: 0 },
    'the per-pass object count comes from the render list that pass encoded');
  console.log('pass: one traced frame attributes the phases and does not double count nesting');

  const empty = trace.take();
  assert.equal(empty.sceneRenders, 0);
  assert.equal(empty.sceneMs, 0);
  console.log('pass: take() resets the totals');
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
