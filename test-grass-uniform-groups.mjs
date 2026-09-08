// test-grass-uniform-groups.mjs
// What a renderGroup uniform actually does, against the real three r184 build.
//
// REAL (imported from node_modules/three/build/three.webgpu.js):
//   NodeFrame, UniformGroupNode instances renderGroup/objectGroup, NodeUpdateType,
//   uniform() and .setGroup(), Node's version/needsUpdate bookkeeping.
// REIMPLEMENTED here (Nodes and NodeUniformsGroup are not exported by the build; each
//   function below is a line-for-line transcription of the shipped source, cited):
//   Nodes.updateGroup (three.webgpu.js ~54252), the renderer's renderId bookkeeping in
//   _renderScene (~59264) and compute() (~60479), NodeBuilderState.createBindings' shared
//   vs cloned rule (~48435), and UniformsGroup.updateNumber/updateVector2 (~62017/62042).
// NOT executed: the shipped UniformsGroup diff itself. The exported `UniformsGroup` is the
//   renderer-agnostic core class with no update(); the WebGPU one at ~61762 is internal.

import * as THREE from 'three';
import { NodeFrame, NodeUpdateType } from 'three/webgpu';
import { uniform, renderGroup, objectGroup, frameGroup } from 'three/tsl';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg} (got ${a}, want ${b})`);

// --- Nodes.updateGroup, transcribed (~54252). Real ChainMap replaced by a nested Map:
// same per-(groupNode, uniformsGroup) pair storage, same version compare.
function makeNodes() {
  const groupsData = new Map();
  return {
    updateGroup(nodeUniformsGroup) {
      const groupNode = nodeUniformsGroup.groupNode;
      let byGroup = groupsData.get(groupNode);
      if (!byGroup) groupsData.set(groupNode, byGroup = new Map());
      let groupData = byGroup.get(nodeUniformsGroup);
      if (groupData === undefined) byGroup.set(nodeUniformsGroup, groupData = {});
      if (groupData.version !== groupNode.version) {
        groupData.version = groupNode.version;
        return true;
      }
      return false;
    },
  };
}

// --- NodeBuilderState.createBindings, transcribed (~48435): a shared group belongs to the
// builder state and is handed to every render object using it; a non-shared one is cloned
// per render object. Render objects with the same material and geometry layout share a
// builder state, so the three grass tier meshes pass the same builderStateId here.
function bindingsFor(groupNode, builderStateId, renderObjectId, sharedStore) {
  if (groupNode.shared === true) {
    const key = builderStateId + '|' + groupNode.name;
    let g = sharedStore.get(key);
    if (!g) sharedStore.set(key, g = { groupNode, id: key });
    return g;
  }
  return { groupNode, id: 'clone:' + renderObjectId };
}

// --- The renderer's renderId bookkeeping. info.calls is monotonic for the life of the
// renderer (Info.reset() clears frameCalls/drawCalls only, ~31320); both _renderScene
// (~59264) and compute() (~60479) do `info.calls++; nodeFrame.renderId = info.calls`
// and restore the previous id afterwards.
function makeRenderer(nodeFrame) {
  const info = { calls: 0 };
  return {
    info,
    beginPass() { const prev = nodeFrame.renderId; info.calls++; nodeFrame.renderId = info.calls; return prev; },
    endPass(prev) { nodeFrame.renderId = prev; },
  };
}

console.log('1. group identity and update types');
{
  const uObj = uniform(0);
  const uRender = uniform(0).setGroup(renderGroup);
  eq(uObj.groupNode, objectGroup, 'a plain uniform() lands in objectGroup');
  eq(uRender.groupNode, renderGroup, 'setGroup(renderGroup) moves it');
  eq(renderGroup.getUpdateType(), NodeUpdateType.RENDER, 'renderGroup updates per render');
  eq(objectGroup.getUpdateType(), NodeUpdateType.OBJECT, 'objectGroup updates per object');
  eq(frameGroup.getUpdateType(), NodeUpdateType.FRAME, 'frameGroup updates per frame');
  eq(renderGroup.shared, true, 'renderGroup is shared (one uniform buffer per builder state)');
  eq(objectGroup.shared, false, 'objectGroup is cloned per render object');
}

console.log('2. one pass, three meshes: the render group bumps once');
{
  const nodeFrame = new NodeFrame();
  const renderer = makeRenderer(nodeFrame);
  const v0 = renderGroup.version, o0 = objectGroup.version;
  const prev = renderer.beginPass();
  for (let i = 0; i < 3; i++) { nodeFrame.updateNode(renderGroup); nodeFrame.updateNode(objectGroup); }
  renderer.endPass(prev);
  eq(renderGroup.version - v0, 1, 'renderGroup.version rose once for three objects');
  eq(objectGroup.version - o0, 3, 'objectGroup.version rose once per object');
}

console.log('3. a second pass bumps it again');
{
  const nodeFrame = new NodeFrame();
  const renderer = makeRenderer(nodeFrame);
  const v0 = renderGroup.version;
  for (let p = 0; p < 4; p++) {
    const prev = renderer.beginPass();
    nodeFrame.updateNode(renderGroup); nodeFrame.updateNode(renderGroup);
    renderer.endPass(prev);
  }
  eq(renderGroup.version - v0, 4, 'four passes, four bumps');
  // Shadow map, reflection and main pass are separate _renderScene calls, so a uniform
  // read by all three still refreshes for each.
  ok(renderer.info.calls === 4, 'each pass took its own renderId');
}

console.log('4. updateGroup: shared group once per pass, object clones once per object');
{
  const nodeFrame = new NodeFrame();
  const renderer = makeRenderer(nodeFrame);
  const nodes = makeNodes();
  const shared = new Map();
  const results = { render: [], object: [] };
  for (let p = 0; p < 2; p++) {
    const prev = renderer.beginPass();
    for (const meshId of ['tier0', 'tier1', 'tier2']) {
      nodeFrame.updateNode(renderGroup);
      nodeFrame.updateNode(objectGroup);
      results.render.push(nodes.updateGroup(bindingsFor(renderGroup, 'grassMat', meshId, shared)));
      results.object.push(nodes.updateGroup(bindingsFor(objectGroup, 'grassMat', meshId, shared)));
    }
    renderer.endPass(prev);
  }
  // Two passes x three meshes sharing ONE material -> one true per pass.
  eq(results.render.filter(Boolean).length, 2, 'render group reported an update twice (once per pass)');
  eq(results.render.join(','), 'true,false,false,true,false,false', 'render: first mesh of each pass only');
  eq(results.object.filter(Boolean).length, 6, 'object group reported an update for every mesh in every pass');
}

console.log('5. compute dispatches: does a render-group uniform refresh for them?');
{
  const nodeFrame = new NodeFrame();
  const renderer = makeRenderer(nodeFrame);
  const nodes = makeNodes();
  const shared = new Map();
  const seen = [];
  // A frame the grass actually runs: cull compute, then the main render pass.
  for (let f = 0; f < 3; f++) {
    const c = renderer.beginPass();                 // renderer.compute()
    nodeFrame.updateNode(renderGroup);
    seen.push(['compute', nodes.updateGroup(bindingsFor(renderGroup, 'cullKernel', 'cullKernel', shared))]);
    renderer.endPass(c);
    const r = renderer.beginPass();                 // renderer.render()
    nodeFrame.updateNode(renderGroup);
    seen.push(['render', nodes.updateGroup(bindingsFor(renderGroup, 'grassMat', 'tier0', shared))]);
    renderer.endPass(r);
  }
  ok(seen.filter(([k, v]) => k === 'compute' && v).length === 3, 'the compute kernel re-diffed on all three frames');
  ok(seen.filter(([k, v]) => k === 'render' && v).length === 3, 'the render pass re-diffed on all three frames');
  // Why it works: compute() increments info.calls too, and info.calls never resets, so no
  // renderId from a later frame can alias one already stored for an earlier frame.
  ok(renderer.info.calls === 6, 'compute() and render() each consumed a renderId');
}

console.log('6. renderId never repeats (the aliasing that would freeze a uniform)');
{
  const nodeFrame = new NodeFrame();
  const renderer = makeRenderer(nodeFrame);
  const ids = new Set();
  for (let f = 0; f < 50; f++) {
    for (let k = 0; k < 3; k++) { const p = renderer.beginPass(); ids.add(nodeFrame.renderId); renderer.endPass(p); }
  }
  eq(ids.size, 150, '150 passes produced 150 distinct renderIds');
}

console.log('7. value change between passes vs no change (diff transcribed, not the shipped code)');
{
  // UniformsGroup.updateNumber (~62017) / updateVector2 (~62042): compare against a JS
  // shadow array, write and report true only on a real change.
  const values = new Float32Array(8);
  const updateNumber = (offset, v) => { if (values[offset] !== v) { values[offset] = v; return true; } return false; };
  const updateVector2 = (offset, v) => {
    if (values[offset] !== v.x || values[offset + 1] !== v.y) { values[offset] = v.x; values[offset + 1] = v.y; return true; }
    return false;
  };
  const uTime = { value: 0 };
  const uWorldOrigin = { value: new THREE.Vector2(0, 0) };
  ok(updateNumber(0, uTime.value) === false, 'writing 0 over the zeroed shadow uploads nothing');
  uTime.value = 0.016;
  ok(updateNumber(0, uTime.value) === true, 'a ticked clock uploads');
  ok(updateVector2(2, uWorldOrigin.value) === false, 'origin at 0,0 matches the zeroed shadow');
  uWorldOrigin.value.set(512, -256);               // a floating-origin rebase
  ok(updateVector2(2, uWorldOrigin.value) === true, 'a rebase between passes is picked up by the next diff');
  ok(updateVector2(2, uWorldOrigin.value) === false, 'a stable origin uploads nothing');
  // Bindings._update (~32595) calls backend.updateBinding only when this returns true, so
  // the group being marked dirty by the version bump costs a diff, not an upload.
}

console.log('8. the saving depends on the tier meshes sharing a builder state');
{
  const nodeFrame = new NodeFrame();
  const renderer = makeRenderer(nodeFrame);
  const nodes = makeNodes();
  const shared = new Map();
  let trues = 0;
  const prev = renderer.beginPass();
  // Same material, but suppose each tier mesh compiled its own builder state.
  for (const meshId of ['tier0', 'tier1', 'tier2']) {
    nodeFrame.updateNode(renderGroup);
    if (nodes.updateGroup(bindingsFor(renderGroup, 'state-' + meshId, meshId, shared))) trues++;
  }
  renderer.endPass(prev);
  eq(trues, 3, 'three builder states means three diffs, the same as objectGroup');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
