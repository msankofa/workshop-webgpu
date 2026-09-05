// test-render-pass-recorder.mjs — the pass recorder, against a fake renderer + inspector.
//
// node test-render-pass-recorder.mjs

import { createRenderPassRecorder } from './render-pass-recorder.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

function fakeRenderer() {
  const seen = [];
  const inspector = { beginRender(uid, scene) { seen.push(scene.name); } };
  return { renderer: { inspector }, seen, inspector };
}

section('naming the passes');
{
  const { renderer, seen } = fakeRenderer();
  const rec = createRenderPassRecorder(renderer);
  check('installed over an existing inspector', rec.installed === true);
  const scene = { name: 'base-game' };
  renderer.inspector.beginRender('a', scene, null, null);
  // Three renames the scene for the length of a shadow render, then puts it back.
  scene.name = 'Shadow Map [ sun ]';
  renderer.inspector.beginRender('b', scene, null, null);
  scene.name = 'Shadow Map [ weaponLaser ]';
  renderer.inspector.beginRender('c', scene, null, null);
  scene.name = 'base-game';
  check('the wrapped inspector still runs', seen.length === 3, `saw ${seen.length}`);
  check('summary names every pass', rec.summary() === 'base-game, Shadow Map [ sun ], Shadow Map [ weaponLaser ]', rec.summary());
  const drained = rec.take();
  check('take() returns one row per distinct pass', drained.length === 3, `got ${drained.length}`);
  check('a shadow pass is attributed to its light', drained[2].name === 'Shadow Map [ weaponLaser ]');
}

section('repeats and draining');
{
  const { renderer } = fakeRenderer();
  const rec = createRenderPassRecorder(renderer);
  const scene = { name: 'Shadow Map [ lamp ]' };
  renderer.inspector.beginRender('a', scene, null, null);
  renderer.inspector.beginRender('b', scene, null, null);
  check('the same pass twice is counted, not duplicated', rec.summary() === 'Shadow Map [ lamp ] x2', rec.summary());
  check('take() carries the count', rec.take()[0].count === 2);
  check('and a second take is empty', rec.take().length === 0);
}

section('a scene with no name');
{
  const { renderer } = fakeRenderer();
  const rec = createRenderPassRecorder(renderer);
  renderer.inspector.beginRender('a', { name: '' }, null, null);
  check('an unnamed scene still gets a row', rec.take()[0].name === '(unnamed scene)');
}

section('nothing to wrap');
{
  const rec = createRenderPassRecorder({});
  check('no inspector: installed is false', rec.installed === false);
  check('no inspector: take() is empty rather than throwing', rec.take().length === 0);
  check('no inspector: summary is empty', rec.summary() === '');
  rec.dispose();
}

section('dispose puts the inspector back');
{
  const { renderer, inspector } = fakeRenderer();
  const original = inspector.beginRender;
  const rec = createRenderPassRecorder(renderer);
  check('the hook was replaced', inspector.beginRender !== original);
  rec.dispose();
  check('and restored exactly', inspector.beginRender === original);
  renderer.inspector.beginRender('a', { name: 'x' }, null, null);
  check('a disposed recorder records nothing', rec.take().length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
