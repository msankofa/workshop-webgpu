import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createBladeFx, PALETTES } from './moves/fx-blade.js';

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
function makeDeps(opts = {}) {
  const scene = new THREE.Scene();
  const acquired = [];
  const lights = opts.noLights ? {
    acquire() { return null; },
    release() {},
  } : {
    acquire() { const l = new THREE.PointLight(); acquired.push(l); return l; },
    release(l) { const i = acquired.indexOf(l); if (i >= 0) acquired.splice(i, 1); },
  };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight, lights }, scene, acquired };
}
const line = () => makeLine({ from: { x: 0, z: 0 }, to: { x: 3, z: 1.5 }, terrainHeight });

function run(fx, opts = {}) {
  const inst = fx.cast(Object.assign({ line: line(), seed: 7, palette: 'steel' }, opts));
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
  const fx = createBladeFx(deps);
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

check('every palette casts and builds the expected mesh set', () => {
  const { deps } = makeDeps();
  const fx = createBladeFx(deps);
  for (const name of Object.keys(PALETTES)) {
    if (name === 'default') continue;
    const pal = PALETTES[name];
    const inst = fx.cast({ line: line(), seed: 3, palette: name, power: 1.2, sourceY: 0.9, targetY: 0.5 });
    const expected = 1 /* halo */ + (pal.doubled ? 2 : 1) /* core */ + 1 /* flash */ + 1 /* sparks */;
    assert(inst.group.children.length === expected, `${name}: expected ${expected} children, got ${inst.group.children.length}`);
    const strips = inst.group.children.filter((m) => m.geometry && m.geometry.isInstancedBufferGeometry && m.geometry.getAttribute('aBlade'));
    assert(strips.length === (pal.doubled ? 3 : 2), `${name}: expected ${pal.doubled ? 3 : 2} arc strips, got ${strips.length}`);
    for (const b of strips) {
      assert(b.frustumCulled === false, `${name}: displaced mesh is still frustum culled`);
      assert(b.material.positionNode && b.material.colorNode && b.material.opacityNode, `${name}: missing node graph`);
      assert(b.material.transparent && b.material.depthWrite === false, `${name}: blending flags`);
      assert(b.material.blending === THREE.AdditiveBlending, `${name}: not additive`);
      assert(b.geometry.getAttribute('aBlade').isInstancedBufferAttribute, `${name}: aBlade not instanced`);
    }
    const halo = strips.find((m) => m.renderOrder === 11);
    assert(halo, `${name}: no halo pass`);
    for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
    inst.dispose();
  }
  fx.dispose();
});

// Materials cannot compile without a GPU, but the TSL callbacks can be run inside a stack, which is what
// catches a misspelled node function or a method that does not exist on a node.
check('every TSL graph body builds without throwing', () => {
  const { deps } = makeDeps();
  const fx = createBladeFx(deps);
  const inst = fx.cast({ line: line(), seed: 4, palette: 'psychic' });
  const strips = inst.group.children.filter((m) => m.geometry.isInstancedBufferGeometry && m.geometry.getAttribute('aBlade'));
  for (const mesh of strips) {
    for (const key of ['positionNode', 'colorNode', 'opacityNode']) {
      const n = mesh.material[key];
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
  const fx = createBladeFx(deps);
  const inst = fx.cast({ line: line(), seed: 1, palette: 'nope' });
  for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
  inst.dispose();
  fx.dispose();
});

check('a point light is acquired only for glow palettes, and released on dispose', () => {
  const { deps, acquired } = makeDeps();
  const fx = createBladeFx(deps);
  const noGlow = run(fx, { palette: 'steel' });
  assert(acquired.length === 0, `steel should not take a light, got ${acquired.length}`);
  noGlow.inst.dispose();

  const glow = run(fx, { palette: 'shadow' });
  assert(acquired.length === 1, `shadow should take a light, got ${acquired.length}`);
  glow.inst.dispose();
  assert(acquired.length === 0, 'light never released');
  fx.dispose();
});

check('lights.acquire() returning null never throws', () => {
  const { deps } = makeDeps({ noLights: true });
  const fx = createBladeFx(deps);
  const r = run(fx, { palette: 'psychic' });
  r.inst.dispose();
  fx.dispose();
});

check('slashes overrides the palette default and fans out that many blades', () => {
  const { deps } = makeDeps();
  const fx = createBladeFx(deps);
  const inst = fx.cast({ line: line(), seed: 2, palette: 'steel', slashes: 3 });
  const strip = inst.group.children.find((m) => m.geometry.isInstancedBufferGeometry);
  assert(strip.geometry.instanceCount === 3, `expected 3 instances, got ${strip.geometry.instanceCount}`);
  for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
  inst.dispose();
  fx.dispose();
});

check('sparks are deterministic from the seed', () => {
  const { deps } = makeDeps();
  const fx = createBladeFx(deps, { sparkCap: 32 });
  const a = fx.cast({ line: line(), seed: 99, palette: 'wind' });
  for (let i = 0; i < 20; i++) a.update(1 / 60, i / 60);
  const sparkMeshA = a.group.children.find((m) => m.material && m.material.isSpriteNodeMaterial !== undefined && m.geometry.getAttribute('aPos'));
  const posA = new Float32Array(sparkMeshA.geometry.getAttribute('aPos').array);
  a.dispose();

  const b = fx.cast({ line: line(), seed: 99, palette: 'wind' });
  for (let i = 0; i < 20; i++) b.update(1 / 60, i / 60);
  const sparkMeshB = b.group.children.find((m) => m.geometry.getAttribute('aPos'));
  const posB = sparkMeshB.geometry.getAttribute('aPos').array;
  let diff = 0;
  for (let i = 0; i < posA.length; i++) if (Math.abs(posA[i] - posB[i]) > 1e-6) diff++;
  assert(diff === 0, `${diff} spark position entries diverged for the same seed`);
  b.dispose();
  fx.dispose();
});

check('rigs are pooled so a repeat cast reuses the same materials', () => {
  const { deps } = makeDeps();
  const fx = createBladeFx(deps);
  const a = fx.cast({ line: line(), seed: 1, palette: 'water' });
  const matA = a.group.children.find((m) => m.geometry.isInstancedBufferGeometry).material;
  for (let i = 0; i < 200 && a.update(1 / 60, i / 60); i++);
  a.dispose();
  const b = fx.cast({ line: line(), seed: 2, palette: 'water' });
  const matB = b.group.children.find((m) => m.geometry.isInstancedBufferGeometry).material;
  assert(matB === matA, 'material was rebuilt instead of pooled');
  b.dispose();
  fx.dispose();
});

check('a degenerate line does not produce NaN endpoints', () => {
  const { deps } = makeDeps();
  const fx = createBladeFx(deps);
  const l = makeLine({ from: { x: 2, z: 2 }, to: { x: 2, z: 2 }, terrainHeight });
  const inst = fx.cast({ line: l, seed: 5, palette: 'poison', sourceY: 0.6, targetY: 0.6 });
  for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
  const sparkMesh = inst.group.children.find((m) => m.geometry.getAttribute('aPos'));
  const pos = sparkMesh.geometry.getAttribute('aPos').array;
  for (let i = 0; i < pos.length; i++) assert(Number.isFinite(pos[i]), `spark position NaN at ${i}`);
  inst.dispose();
  fx.dispose();
});

check('two concurrent casts do not share uniform state', () => {
  const { deps } = makeDeps();
  const fx = createBladeFx(deps);
  const a = fx.cast({ line: line(), seed: 1, palette: 'steel' });
  const b = fx.cast({ line: line(), seed: 2, palette: 'steel' });
  assert(a.group !== b.group, 'same group');
  const stripA = a.group.children.find((m) => m.geometry.isInstancedBufferGeometry);
  const stripB = b.group.children.find((m) => m.geometry.isInstancedBufferGeometry);
  assert(stripA.material !== stripB.material, 'concurrent casts share a material');
  for (let i = 0; i < 200; i++) { a.update(1 / 60, i / 60); b.update(1 / 60, i / 60); }
  a.dispose(); b.dispose();
  fx.dispose();
});

check('a held-flag-free cast still reaches DONE (blade never sets hold itself)', () => {
  const { deps } = makeDeps();
  const fx = createBladeFx(deps);
  const inst = fx.cast({ line: line(), seed: 8, palette: 'shadow' });
  assert(inst.machine.hold === false, 'blade must not self-hold');
  for (let i = 0; i < 200 && inst.update(1 / 60, i / 60); i++);
  assert(inst.machine.phase === Phase.DONE, 'never reached DONE');
  inst.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
