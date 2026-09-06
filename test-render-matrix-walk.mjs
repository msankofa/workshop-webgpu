import assert from 'node:assert/strict';
import { createMatrixWalk } from './render-matrix-walk.js';

// A stand-in Object3D: only the parts the walk touches.
function node(name, parent = null) {
  const object = {
    name, parent, children: [], walks: 0, matrixWorldAutoUpdate: true, isObject3D: true,
    updateMatrixWorld(force) { this.walks++; for (const child of this.children) child.updateMatrixWorld(force); },
    add(child) { child.parent = this; this.children.push(child); return child; },
    remove(child) { const at = this.children.indexOf(child); if (at >= 0) this.children.splice(at, 1); return this; },
  };
  if (parent) parent.add(object);
  return object;
}

let clock = 0;
const now = () => clock++;

{
  const scene = node('scene');
  const body = node('body', scene);
  node('limb', body);
  const forest = node('forest', scene);
  node('tree', forest);
  const walk = createMatrixWalk({ enabled: true, refreshEvery: 10 });
  assert.equal(walk.attach(scene), true);
  assert.equal(scene.matrixWorldAutoUpdate, false, 'three no longer walks the scene itself');
  walk.skip(forest);
  assert.equal(walk.stats.statics, 1);

  walk.update(now);
  assert.equal(scene.walks, 1, 'the first frame places everything once');
  assert.equal(forest.walks, 1);
  assert.equal(forest.children[0].walks, 1);

  walk.update(now);
  assert.equal(scene.walks, 1, 'later frames never walk the scene root');
  assert.equal(body.walks, 2, 'a moving root is walked every frame');
  assert.equal(body.children[0].walks, 2, 'and so is its subtree');
  assert.equal(forest.walks, 1, 'a static root is not walked again');
  assert.equal(walk.stats.walkedRoots, 1);
  console.log('pass: static roots drop out of the per-frame walk, everything else stays in it');

  forest.add(node('new tree'));
  walk.update(now);
  assert.equal(forest.walks, 2, 'adding to a static root places the new child at once');
  assert.equal(forest.children.at(-1).walks, 1);
  console.log('pass: a streamed-in child of a static root is placed the next frame');

  const deep = node('chunk group', forest);
  walk.update(now);
  const afterDeepGroup = forest.walks;
  deep.add(node('chunk'));
  walk.update(now);
  assert.equal(forest.walks, afterDeepGroup + 1, 'a child added deeper in a static subtree also dirties it');
  console.log('pass: add is wrapped at every depth of a static root');

  const walksBefore = forest.walks;
  for (let i = 0; i < 9; i++) walk.update(now);
  assert.equal(forest.walks, walksBefore, 'inside the refresh interval the static root stays skipped');
  walk.update(now);
  assert.equal(forest.walks, walksBefore + 1, 'and is re-walked once the interval expires');
  console.log('pass: static roots are re-walked periodically as insurance');

  const sceneWalks = scene.walks;
  walk.touchAll();
  walk.update(now);
  assert.equal(scene.walks, sceneWalks + 1, 'touchAll walks everything again (an origin rebase)');
  console.log('pass: touchAll does one full walk');

  walk.unskip(forest);
  const beforeUnskip = forest.walks;
  walk.update(now);
  assert.equal(forest.walks, beforeUnskip + 1, 'an unskipped root is walked every frame again');
  walk.detach();
  assert.equal(scene.matrixWorldAutoUpdate, true, 'detach hands the walk back to three');
  console.log('pass: unskip and detach');
}

{
  const scene = node('scene');
  const forest = node('forest', scene);
  const walk = createMatrixWalk({ enabled: false });
  assert.equal(walk.attach(scene), false);
  assert.equal(scene.matrixWorldAutoUpdate, true, 'the flag off leaves three in charge');
  walk.skip(forest);
  assert.equal(walk.update(now), 0);
  assert.equal(forest.walks, 0, 'disabled, the walk does nothing at all');
  console.log('pass: disabled is a no-op');
}

{
  const scene = node('scene');
  const forest = node('forest', scene);
  const walk = createMatrixWalk({ enabled: true });
  walk.attach(scene);
  walk.skip(forest);
  walk.detach();
  const child = node('late tree');
  forest.add(child);
  assert.equal(forest.children.at(-1), child, 'add still works after the patch is removed');
  console.log('pass: detach restores add/remove on static roots');
}

console.log('render-matrix-walk: all tests passed');
