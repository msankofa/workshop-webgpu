import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createTetherFx, PALETTES } from './moves/fx-tether.js';

let fails = 0;
function check(name, fn) { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

const NODES = {
  MeshBasicNodeMaterial: THREE.MeshBasicNodeMaterial,
  MeshStandardNodeMaterial: THREE.MeshStandardNodeMaterial,
  MeshPhysicalNodeMaterial: THREE.MeshPhysicalNodeMaterial,
  SpriteNodeMaterial: THREE.SpriteNodeMaterial,
  PointsNodeMaterial: THREE.PointsNodeMaterial,
};

const terrainHeight = () => 0;
function makeDeps() {
  const scene = new THREE.Scene();
  const acquired = [];
  const lights = {
    acquire() { const l = new THREE.PointLight(); acquired.push(l); return l; },
    release(l) { const i = acquired.indexOf(l); if (i >= 0) acquired.splice(i, 1); },
  };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight, lights }, scene, acquired };
}
const line = () => makeLine({ from: { x: 0, z: 0 }, to: { x: 6, z: 2 }, terrainHeight });
const paletteNames = () => Object.keys(PALETTES).filter((n) => n !== 'default');

function run(fx, opts = {}) {
  const inst = fx.cast(Object.assign({ line: line(), seed: 7, palette: 'drain' }, opts));
  let impacts = 0, dones = 0, frames = 0;
  inst.onImpact = () => impacts++;
  inst.onDone = () => dones++;
  let alive = true;
  for (let i = 0; i < 200 && alive; i++) { alive = inst.update(1 / 60, i / 60); frames++; }
  return { inst, impacts, dones, frames, alive };
}

check('cast walks travel -> impact -> fade -> done exactly once, unheld', () => {
  const { deps, scene } = makeDeps();
  const fx = createTetherFx(deps);
  const r = run(fx);
  assert(r.impacts === 1, `impacts ${r.impacts}`);
  assert(r.dones === 1, `dones ${r.dones}`);
  assert(!r.alive && r.inst.machine.phase === Phase.DONE, `phase ${r.inst.machine.phase}`);
  assert(r.frames < 200, 'never finished');
  assert(scene.children.includes(r.inst.group), 'group not added to the scene');
  r.inst.dispose();
  assert(!scene.children.includes(r.inst.group), 'group not removed on dispose');
  fx.dispose();
});

check('onImpact fires on the very first update, one frame after cast', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const inst = fx.cast({ line: line(), seed: 1, palette: 'paralysis' });
  assert(inst.machine.phase === Phase.TRAVEL, 'did not start in TRAVEL');
  let impacted = false;
  inst.onImpact = () => { impacted = true; };
  inst.update(1 / 60, 0);
  assert(impacted, 'onImpact did not fire on the first update');
  assert(inst.machine.phase === Phase.IMPACT, `expected IMPACT after one frame, got ${inst.machine.phase}`);
  for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
  inst.dispose();
  fx.dispose();
});

check('every palette casts and builds two ribbon passes plus a mote mesh and a reticle', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  for (const name of paletteNames()) {
    const inst = fx.cast({ line: line(), seed: 3, palette: name, power: 1.3, sourceY: 0.9, targetY: 0.5 });
    const meshes = inst.group.children;
    assert(meshes.length === 4, `${name}: expected 2 ribbon + mote mesh + reticle, got ${meshes.length}`);
    const ribbons = meshes.filter((m) => m.geometry.isInstancedBufferGeometry && m.geometry.getAttribute('aStrand'));
    assert(ribbons.length === 2, `${name}: ribbon passes ${ribbons.length}`);
    assert(ribbons[0].renderOrder < ribbons[1].renderOrder, `${name}: glow must draw before the core`);
    for (const b of ribbons) {
      assert(b.frustumCulled === false, `${name}: displaced mesh is still frustum culled`);
      assert(b.material.positionNode && b.material.colorNode && b.material.opacityNode, `${name}: missing node graph`);
      assert(b.material.blending === THREE.AdditiveBlending, `${name}: not additive`);
    }
    for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
    inst.dispose();
  }
  fx.dispose();
});

// Materials cannot compile without a GPU, but the TSL callbacks can be run inside a stack, which is what
// catches a misspelled node function or a method that does not exist on a node.
check('every TSL graph body builds without throwing', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const inst = fx.cast({ line: line(), seed: 4, palette: 'paralysis' });
  for (const mesh of inst.group.children.slice(0, 2)) {
    for (const key of ['positionNode', 'colorNode', 'opacityNode']) {
      const n = mesh.material[key];
      assert(n, `missing ${key}`);
      const shaderNode = n.node ? n.node.shaderNode : n.shaderNode;
      assert(shaderNode && shaderNode.jsFunc, `${key} is not a TSL Fn call`);
      const stack = TSL.stack();
      TSL.setCurrentStack(stack);
      try { assert(shaderNode.jsFunc([], null), `${key} returned nothing`); }
      finally { TSL.setCurrentStack(null); }
    }
  }
  inst.dispose();
  fx.dispose();
});

check('unknown palette falls back instead of throwing', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const inst = fx.cast({ line: line(), seed: 1, palette: 'nope' });
  for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
  inst.dispose();
  fx.dispose();
});

check('a point light is acquired and released', () => {
  const { deps, acquired } = makeDeps();
  const fx = createTetherFx(deps);
  const r = run(fx);
  assert(acquired.length === 1, `acquired ${acquired.length}`);
  r.inst.dispose();
  assert(acquired.length === 0, 'light never released');
  fx.dispose();
});

check('nothing throws when the light pool is exhausted', () => {
  const { deps } = makeDeps();
  deps.lights = { acquire: () => null, release: () => {} };
  const fx = createTetherFx(deps);
  for (const name of paletteNames()) {
    const inst = fx.cast({ line: line(), seed: 2, palette: name });
    for (let i = 0; i < 60 && inst.update(1 / 60, i / 60); i++);
    inst.dispose();
  }
  fx.dispose();
});

check('drain motes stream deterministically: same seed twice gives identical positions', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const a = fx.cast({ line: line(), seed: 42, palette: 'drain' });
  for (let i = 0; i < 30; i++) a.update(1 / 60, i / 60);
  const motesA = a.group.children[2];
  assert(motesA.geometry.instanceCount > 0, 'drain never emitted a mote in 0.5s');
  const arrA = new Float32Array(motesA.geometry.getAttribute('aPos').array);
  a.dispose();

  const b = fx.cast({ line: line(), seed: 42, palette: 'drain' });
  for (let i = 0; i < 30; i++) b.update(1 / 60, i / 60);
  const motesB = b.group.children[2];
  const arrB = motesB.geometry.getAttribute('aPos').array;
  assert(arrA.length === arrB.length, 'aPos length mismatch');
  let diff = 0;
  for (let i = 0; i < arrA.length; i++) {
    assert(Number.isFinite(arrB[i]), `mote position NaN at ${i}`);
    if (Math.abs(arrA[i] - arrB[i]) > 1e-6) diff++;
  }
  assert(diff === 0, `${diff} mote position entries diverged for the same seed`);
  b.dispose();
  fx.dispose();
});

check('lock emits no motes; its reticle shows once attached and hides on dispose', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const inst = fx.cast({ line: line(), seed: 9, palette: 'lock' });
  for (let i = 0; i < 30; i++) inst.update(1 / 60, i / 60);
  const motes = inst.group.children[2];
  assert(motes.geometry.instanceCount === 0, 'lock should never stream motes');
  const reticle = inst.group.children[3];
  assert(reticle.visible === true, 'reticle should be visible once attached');
  assert(reticle.material.opacity > 0, 'reticle should have nonzero opacity while held');
  inst.dispose();
  assert(reticle.visible === false, 'reticle should hide once the rig is given back to the pool');
  fx.dispose();
});

check('a held cast parks in IMPACT and only reaches DONE after release()', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const inst = fx.cast({ line: line(), seed: 5, palette: 'spectral' });
  inst.machine.hold = true;
  inst.machine.maxHold = 10;
  let impacts = 0;
  inst.onImpact = () => impacts++;
  for (let i = 0; i < 180; i++) inst.update(1 / 60, i / 60); // 3s, well past impactTime but parked
  assert(impacts === 1, `impacts ${impacts}`);
  assert(inst.machine.phase === Phase.IMPACT, `expected parked in IMPACT, got ${inst.machine.phase}`);
  assert(inst.machine.holding, 'machine.holding should read true while parked');
  inst.machine.release();
  let dones = 0;
  inst.onDone = () => dones++;
  for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
  assert(dones === 1, `dones ${dones}`);
  assert(inst.machine.phase === Phase.DONE, `phase ${inst.machine.phase}`);
  inst.dispose();
  fx.dispose();
});

check('maxHold forces release so a forgotten hold cannot leak', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const inst = fx.cast({ line: line(), seed: 6, palette: 'lock' });
  inst.machine.hold = true;
  inst.machine.maxHold = 0.3;
  let dones = 0;
  inst.onDone = () => dones++;
  let alive = true;
  for (let i = 0; i < 300 && alive; i++) alive = inst.update(1 / 60, i / 60);
  assert(dones === 1, `expected the hold to expire and finish, dones ${dones}`);
  assert(!alive, 'instance never went dormant');
  inst.dispose();
  fx.dispose();
});

check('rigs are pooled so a repeat cast reuses the same materials', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const a = fx.cast({ line: line(), seed: 1, palette: 'lock' });
  const matA = a.group.children[0].material;
  for (let i = 0; i < 200 && a.update(1 / 60, i / 60); i++);
  a.dispose();
  const b = fx.cast({ line: line(), seed: 2, palette: 'lock' });
  assert(b.group.children[0].material === matA, 'material was rebuilt instead of pooled');
  b.dispose();
  fx.dispose();
});

check('a degenerate line does not produce NaN endpoints', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const l = makeLine({ from: { x: 2, z: 2 }, to: { x: 2, z: 2 }, terrainHeight });
  const inst = fx.cast({ line: l, seed: 5, palette: 'drain', sourceY: 0.6, targetY: 0.6 });
  for (let i = 0; i < 60; i++) inst.update(1 / 60, i / 60);
  const arr = inst.group.children[2].geometry.getAttribute('aPos').array;
  for (let i = 0; i < arr.length; i++) assert(Number.isFinite(arr[i]), `mote position NaN at ${i}`);
  inst.dispose();
  fx.dispose();
});

check('two concurrent casts do not share uniform state', () => {
  const { deps } = makeDeps();
  const fx = createTetherFx(deps);
  const a = fx.cast({ line: line(), seed: 1, palette: 'paralysis' });
  const b = fx.cast({ line: line(), seed: 2, palette: 'paralysis' });
  assert(a.group !== b.group, 'same group');
  // Both are live at once, so the pool (which only recycles disposed rigs) hands out two separate rigs.
  assert(a.group.children[0].material !== b.group.children[0].material, 'concurrent casts share a material');
  for (let i = 0; i < 60; i++) { a.update(1 / 60, i / 60); b.update(1 / 60, i / 60); }
  a.dispose(); b.dispose();
  fx.dispose();
});

check('jitter and restrike are palette data, not code paths: only paralysis crackles', () => {
  assert(PALETTES.paralysis.jitter > 0 && PALETTES.paralysis.restrike > 1, 'paralysis should be kinked and restriking');
  for (const name of ['drain', 'spectral', 'lock']) {
    assert(PALETTES[name].jitter <= 0.02, `${name}: jitter should be near-zero`);
    assert(PALETTES[name].restrike === 0, `${name}: restrike should be off`);
  }
  assert(PALETTES.drain.sag > PALETTES.spectral.sag && PALETTES.spectral.sag > PALETTES.paralysis.sag, 'drain should sag the most, paralysis the least');
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
