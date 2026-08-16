import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createBoltFx, PALETTES } from './moves/fx-bolt.js';

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

function run(fx, opts = {}) {
  const inst = fx.cast(Object.assign({ line: line(), seed: 7, palette: 'electric' }, opts));
  let impacts = 0, dones = 0, frames = 0;
  inst.onImpact = () => impacts++;
  inst.onDone = () => dones++;
  assert(inst.machine.phase === Phase.TRAVEL, 'did not enter travel');
  let alive = true;
  for (let i = 0; i < 200 && alive; i++) { alive = inst.update(1 / 60, i / 60); frames++; }
  return { inst, impacts, dones, frames, alive };
}

check('cast walks travel -> impact -> done exactly once', () => {
  const { deps, scene } = makeDeps();
  const fx = createBoltFx(deps);
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

check('every palette casts and builds two bolt passes plus flashes and sparks', () => {
  const { deps } = makeDeps();
  const fx = createBoltFx(deps);
  for (const name of Object.keys(PALETTES)) {
    const inst = fx.cast({ line: line(), seed: 3, palette: name, power: 1.4, sourceY: 0.9, targetY: 0.5 });
    const meshes = inst.group.children;
    assert(meshes.length === 5, `${name}: expected 2 bolt + 2 flash + 1 spark mesh, got ${meshes.length}`);
    const bolts = meshes.filter((m) => m.geometry.isInstancedBufferGeometry);
    assert(bolts.length === 2, `${name}: bolt passes ${bolts.length}`);
    assert(bolts[0].renderOrder < bolts[1].renderOrder, `${name}: glow must draw before the core`);
    for (const b of bolts) {
      assert(b.frustumCulled === false, `${name}: displaced mesh is still frustum culled`);
      assert(b.material.positionNode && b.material.colorNode && b.material.opacityNode, `${name}: missing node graph`);
      assert(b.material.transparent && b.material.depthWrite === false, `${name}: blending flags`);
      assert(b.material.blending === THREE.AdditiveBlending, `${name}: not additive`);
      assert(b.geometry.getAttribute('aStrand').isInstancedBufferAttribute, `${name}: aStrand not instanced`);
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
  const fx = createBoltFx(deps);
  const inst = fx.cast({ line: line(), seed: 4, palette: 'electric' });
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
  const fx = createBoltFx(deps);
  const inst = fx.cast({ line: line(), seed: 1, palette: 'nope' });
  for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
  inst.dispose();
  fx.dispose();
});

check('a point light is acquired and released', () => {
  const { deps, acquired } = makeDeps();
  const fx = createBoltFx(deps);
  const r = run(fx);
  assert(acquired.length === 1, `acquired ${acquired.length}`);
  r.inst.dispose();
  assert(acquired.length === 0, 'light never released');
  fx.dispose();
});

check('sparks stay under the cap and the bolt is deterministic from the seed', () => {
  const { deps } = makeDeps();
  const fx = createBoltFx(deps, { sparkCap: 64 });
  const a = fx.cast({ line: line(), seed: 99, palette: 'dark' });
  for (let i = 0; i < 40; i++) a.update(1 / 60, i / 60);
  const matA = new Float32Array(a.group.children[4].instanceMatrix.array);
  assert(a.group.children[4].count === 64, `spark cap ${a.group.children[4].count}`);
  a.dispose();

  const b = fx.cast({ line: line(), seed: 99, palette: 'dark' });
  for (let i = 0; i < 40; i++) b.update(1 / 60, i / 60);
  const matB = b.group.children[4].instanceMatrix.array;
  let diff = 0;
  for (let i = 0; i < matA.length; i++) if (Math.abs(matA[i] - matB[i]) > 1e-6) diff++;
  assert(diff === 0, `${diff} spark matrix entries diverged for the same seed`);
  b.dispose();
  fx.dispose();
});

check('rigs are pooled so a repeat cast reuses the same materials', () => {
  const { deps } = makeDeps();
  const fx = createBoltFx(deps);
  const a = fx.cast({ line: line(), seed: 1, palette: 'fairy' });
  const matA = a.group.children[0].material;
  for (let i = 0; i < 200 && a.update(1 / 60, i / 60); i++);
  a.dispose();
  const b = fx.cast({ line: line(), seed: 2, palette: 'fairy' });
  assert(b.group.children[0].material === matA, 'material was rebuilt instead of pooled');
  b.dispose();
  fx.dispose();
});

check('a degenerate line does not produce NaN endpoints', () => {
  const { deps } = makeDeps();
  const fx = createBoltFx(deps);
  const l = makeLine({ from: { x: 2, z: 2 }, to: { x: 2, z: 2 }, terrainHeight });
  const inst = fx.cast({ line: l, seed: 5, sourceY: 0.6, targetY: 0.6 });
  for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
  const m = inst.group.children[4].instanceMatrix.array;
  for (let i = 0; i < m.length; i++) assert(Number.isFinite(m[i]), `spark matrix NaN at ${i}`);
  inst.dispose();
  fx.dispose();
});

check('two concurrent casts do not share uniform state', () => {
  const { deps } = makeDeps();
  const fx = createBoltFx(deps);
  const a = fx.cast({ line: line(), seed: 1, palette: 'electric' });
  const b = fx.cast({ line: line(), seed: 2, palette: 'electric' });
  assert(a.group !== b.group, 'same group');
  assert(a.group.children[0].material !== b.group.children[0].material, 'concurrent casts share a material');
  for (let i = 0; i < 200; i++) { a.update(1 / 60, i / 60); b.update(1 / 60, i / 60); }
  a.dispose(); b.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
