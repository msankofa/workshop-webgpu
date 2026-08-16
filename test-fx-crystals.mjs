import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createCrystalsFx, PALETTES } from './moves/fx-crystals.js';

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
const terrainHeight = (x, z) => Math.sin(x * 0.3) * 0.2 + Math.cos(z * 0.25) * 0.15;

function makeDeps() {
  const scene = new THREE.Scene();
  const pool = [];
  const lights = {
    acquire() { const l = new THREE.PointLight(); pool.push(l); scene.add(l); return l; },
    release(l) { const i = pool.indexOf(l); if (i >= 0) pool.splice(i, 1); },
  };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight, lights }, scene, pool };
}
const line = () => makeLine({ from: { x: 0, z: 0 }, to: { x: 9, z: 4 }, terrainHeight });
// Read the raw instance matrix: Matrix4.decompose() reports scale 1 for a zero matrix.
const yScale = (mesh, i) => {
  const a = mesh.instanceMatrix.array, o = i * 16;
  return Math.hypot(a[o + 4], a[o + 5], a[o + 6]);
};

function run(inst, steps = 400) {
  let impacts = 0, dones = 0, aliveFrames = 0;
  inst.onImpact = () => impacts++;
  inst.onDone = () => dones++;
  let t = 0;
  for (let i = 0; i < steps; i++) {
    t += 1 / 60;
    const alive = inst.update(1 / 60, t);
    if (alive) aliveFrames++; else break;
  }
  return { impacts, dones, aliveFrames };
}

check('a cast travels, impacts once, and finishes', () => {
  const { deps, scene } = makeDeps();
  const fx = createCrystalsFx(deps);
  const inst = fx.cast({ line: line(), seed: 7, palette: 'ice', power: 1 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  assert(inst.machine.phase === Phase.TRAVEL, `phase ${inst.machine.phase}`);
  const r = run(inst);
  assert(r.impacts === 1, `impacts ${r.impacts}`);
  assert(r.dones === 1, `dones ${r.dones}`);
  assert(inst.machine.phase === Phase.DONE, `end phase ${inst.machine.phase}`);
  assert(r.aliveFrames > 60, `finished too fast: ${r.aliveFrames} frames`);
  assert(inst.update(1 / 60, 99) === false, 'update after done should be false');
  inst.dispose(); fx.dispose();
});

check('every palette casts and builds instanced crystals', () => {
  for (const name of Object.keys(PALETTES)) {
    const { deps } = makeDeps();
    const fx = createCrystalsFx(deps);
    const inst = fx.cast({ line: line(), seed: 3, palette: name, power: 1.4 });
    const meshes = inst.group.children.filter((c) => c.isInstancedMesh);
    assert(meshes.length >= 3, `${name}: ${meshes.length} instanced meshes`);
    assert(meshes.every((m) => m.count > 0 && m.frustumCulled === false), `${name}: bad instanced mesh setup`);
    const r = run(inst);
    assert(r.impacts === 1 && r.dones === 1, `${name}: ${r.impacts}/${r.dones}`);
    inst.dispose(); fx.dispose();
  }
});

check('spikes erupt as the front passes and stand at full height', () => {
  const { deps } = makeDeps();
  const fx = createCrystalsFx(deps);
  const inst = fx.cast({ line: line(), seed: 11, palette: 'stone', power: 1 });
  const mesh = inst.group.children.find((c) => c.isInstancedMesh);
  const scaled = () => { let n = 0; for (let i = 0; i < mesh.count; i++) if (yScale(mesh, i) > 1e-3) n++; return n; };
  assert(scaled() === 0, 'crystals were standing before the front reached them');
  let t = 0;
  for (let i = 0; i < 12; i++) { t += 1 / 60; inst.update(1 / 60, t); }
  const early = scaled();
  assert(early > 0, 'nothing erupted behind the front');
  for (let i = 0; i < 60; i++) { t += 1 / 60; inst.update(1 / 60, t); }
  assert(scaled() > early, `field did not keep growing (${early} then ${scaled()})`);
  inst.dispose(); fx.dispose();
});

check('the field sinks below the ground during the fade', () => {
  const { deps } = makeDeps();
  const fx = createCrystalsFx(deps);
  const inst = fx.cast({ line: line(), seed: 5, palette: 'ice', power: 1 });
  const mesh = inst.group.children.find((c) => c.isInstancedMesh);
  const lowest = () => { let y = Infinity; for (let i = 0; i < mesh.count; i++) if (yScale(mesh, i) > 1e-3) y = Math.min(y, mesh.instanceMatrix.array[i * 16 + 13]); return y; };
  let t = 0, standing = Infinity;
  for (let i = 0; i < 400; i++) {
    t += 1 / 60;
    if (inst.machine.phase === Phase.IMPACT && standing === Infinity) standing = lowest();
    if (!inst.update(1 / 60, t)) break;
  }
  const sunk = lowest();
  assert(Number.isFinite(standing), 'never reached the standing phase');
  assert(sunk < standing - 0.5, `field did not retract: ${standing} -> ${sunk}`);
  inst.dispose(); fx.dispose();
});

check('chips pop up at each eruption', () => {
  const { deps } = makeDeps();
  const fx = createCrystalsFx(deps, { chipLife: 0.5 });
  const inst = fx.cast({ line: line(), seed: 4, palette: 'ice', power: 1 });
  const chips = inst.group.children[inst.group.children.length - 1];
  const live = () => { let n = 0; for (let i = 0; i < chips.count; i++) if (yScale(chips, i) > 1e-4) n++; return n; };
  assert(live() === 0, 'chips existed before anything erupted');
  let t = 0, peak = 0;
  for (let i = 0; i < 60; i++) { t += 1 / 60; inst.update(1 / 60, t); peak = Math.max(peak, live()); }
  assert(peak > 0, 'no chips were thrown by the eruptions');
  for (let i = 0; i < 400; i++) { t += 1 / 60; if (!inst.update(1 / 60, t)) break; }
  inst.dispose(); fx.dispose();
});

check('lights are acquired for ice and psychic, never for stone, and always released', () => {
  for (const [name, expect] of [['ice', 1], ['psychic', 1], ['stone', 0]]) {
    const { deps, pool } = makeDeps();
    const fx = createCrystalsFx(deps);
    const inst = fx.cast({ line: line(), seed: 2, palette: name });
    assert(pool.length === expect, `${name}: acquired ${pool.length}, wanted ${expect}`);
    run(inst);
    assert(pool.length === 0, `${name}: light not released on done`);
    inst.dispose(); fx.dispose();
  }
});

check('the same seed builds the same field and a different one does not', () => {
  const { deps } = makeDeps();
  const fx = createCrystalsFx(deps);
  const grab = (seed) => {
    const inst = fx.cast({ line: line(), seed, palette: 'psychic', power: 1 });
    for (let i = 0, t = 0; i < 90; i++) { t += 1 / 60; inst.update(1 / 60, t); }
    const mesh = inst.group.children.find((c) => c.isInstancedMesh);
    const out = Array.from(mesh.instanceMatrix.array);
    inst.dispose();
    return out;
  };
  const a = grab(42), b = grab(42), c = grab(43);
  assert(a.join() === b.join(), 'same seed diverged');
  assert(a.join() !== c.join(), 'different seeds matched');
  fx.dispose();
});

check('dispose detaches the group and releases the light mid-cast', () => {
  const { deps, scene, pool } = makeDeps();
  const fx = createCrystalsFx(deps);
  const inst = fx.cast({ line: line(), seed: 9, palette: 'ice' });
  for (let i = 0, t = 0; i < 20; i++) { t += 1 / 60; inst.update(1 / 60, t); }
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group still in the scene');
  assert(pool.length === 0, 'light still held');
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
