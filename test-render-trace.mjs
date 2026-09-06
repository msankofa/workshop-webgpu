import assert from 'node:assert/strict';
import { createRenderTrace } from './render-trace.js';

let clock = 0;
const now = () => clock;

// A stand-in with the same call shape as the WebGPU renderer: render a scene, project the graph
// recursively, sort the list, then encode each object. `onEncode` is what a post chain does -- the
// output quad's single object triggers the real scene render inside its own encode.
function fakeRenderer({ onEncode = null } = {}) {
  const list = { items: [], sort() { clock += 2; } };
  const renderer = {
    _renderLists: { get() { return list; } },
    _renderScene(scene, camera, objectCount) {
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
    _renderObjectDirect() { clock += 3; onEncode?.(renderer); },
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
  renderer._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 2);
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
  assert.equal(t.sceneMs, 13, 'the scene contains project, sort and objects');
  assert.equal(t.bundleGroups, 1);
  assert.equal(t.bundleMs, 4, 'a bundle replayed outside any scene render is still counted');
  assert.equal(t.scenes.length, 1, 'one entry per scene render');
  assert.equal(t.scenes[0].name, 'base-game');
  assert.equal(t.scenes[0].camera, 'PerspectiveCamera', 'the entry says which camera drew it');
  assert.equal(t.scenes[0].objects, 2, 'the object count comes from the render list that pass encoded');
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
  let inner = false;
  const { renderer } = fakeRenderer({
    onEncode: (r) => {
      if (inner) return;
      inner = true;
      r._renderScene({ name: 'base-game' }, { type: 'PerspectiveCamera' }, 4);
      inner = false;
    },
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
