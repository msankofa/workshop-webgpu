import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createStreamFx, PALETTES } from './moves/fx-stream.js';

let fails = 0;
function check(name, fn) { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e.stack}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

const NODES = {
  MeshBasicNodeMaterial: THREE.MeshBasicNodeMaterial,
  MeshStandardNodeMaterial: THREE.MeshStandardNodeMaterial,
  MeshPhysicalNodeMaterial: THREE.MeshPhysicalNodeMaterial,
  SpriteNodeMaterial: THREE.SpriteNodeMaterial,
  PointsNodeMaterial: THREE.PointsNodeMaterial,
};

function makeDeps() {
  const scene = new THREE.Scene();
  const pool = [new THREE.PointLight(), new THREE.PointLight()];
  const free = pool.slice();
  const acquired = [];
  const lights = {
    acquire() { const l = free.pop() || null; if (l) acquired.push(l); return l; },
    release(l) { const i = acquired.indexOf(l); if (i >= 0) acquired.splice(i, 1); free.push(l); },
  };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight: () => 0, lights }, scene, free, acquired };
}

const line = makeLine({ from: { x: 0, z: 0 }, to: { x: 9, z: 3 }, terrainHeight: () => 0 });

check('every required palette exists', () => {
  for (const k of ['fire', 'water', 'dragon', 'ice']) assert(PALETTES[k], `missing palette ${k}`);
});

check('a cast walks travel -> impact -> done and fires both callbacks once', () => {
  const { deps, scene } = makeDeps();
  const fx = createStreamFx(deps);
  const inst = fx.cast({ line, seed: 7, palette: 'fire', power: 1.2, sourceY: 0.9, targetY: 0.7 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  let impacts = 0, dones = 0, frames = 0, sawTravel = false, sawImpact = false, sawFade = false;
  inst.onImpact = () => impacts++;
  inst.onDone = () => dones++;
  let alive = true;
  for (let i = 0; i < 300 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    frames++;
    if (inst.machine.phase === Phase.TRAVEL) sawTravel = true;
    if (inst.machine.phase === Phase.IMPACT) sawImpact = true;
    if (inst.machine.phase === Phase.FADE) sawFade = true;
  }
  assert(sawTravel && sawImpact && sawFade, `phases missed t=${sawTravel} i=${sawImpact} f=${sawFade}`);
  assert(inst.machine.phase === Phase.DONE, `ended in ${inst.machine.phase}`);
  assert(impacts === 1 && dones === 1, `callbacks ${impacts}/${dones}`);
  assert(frames < 300, 'never finished');
  assert(inst.update(1 / 60, 5) === false, 'update after done stayed alive');
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group left in the scene');
  fx.dispose();
});

check('the front advances monotonically and IMPACT holds the stream on', () => {
  const { deps } = makeDeps();
  const fx = createStreamFx(deps, { travelSpeed: 8, impactTime: 0.8 });
  const inst = fx.cast({ line, seed: 3, palette: 'dragon' });
  let last = -1, holdFrames = 0, alive = true;
  for (let i = 0; i < 20; i++) inst.update(1 / 60, i / 60);
  assert(inst.machine.u > 0 && inst.machine.u < 1, `progress ${inst.machine.u}`);
  for (let i = 0; i < 400 && alive; i++) {
    if (inst.machine.phase === Phase.TRAVEL) {
      assert(inst.machine.u >= last, 'front went backwards');
      last = inst.machine.u;
    }
    if (inst.machine.phase === Phase.IMPACT) holdFrames++;
    alive = inst.update(1 / 60, i / 60);
  }
  assert(holdFrames >= 45, `IMPACT held only ${holdFrames} frames, wanted ~48`);
  inst.dispose();
  fx.dispose();
});

check('all four palettes cast, emit puffs and clean up', () => {
  const { deps, acquired } = makeDeps();
  const fx = createStreamFx(deps);
  for (const palette of ['fire', 'water', 'dragon', 'ice']) {
    const inst = fx.cast({ line, seed: 11, palette });
    let peak = 0, alive = true;
    for (let i = 0; i < 400 && alive; i++) {
      alive = inst.update(1 / 60, i / 60);
      peak = Math.max(peak, inst.group.children[1].geometry.instanceCount);
    }
    assert(peak > 5, `${palette} emitted only ${peak} puffs`);
    assert(peak <= 300, `${palette} exceeded the puff cap: ${peak}`);
    inst.dispose();
  }
  assert(acquired.length === 0, `lights leaked: ${acquired.length}`);
  fx.dispose();
});

check('water takes no light, fire does', () => {
  const { deps, free } = makeDeps();
  const fx = createStreamFx(deps);
  const before = free.length;
  const w = fx.cast({ line, seed: 2, palette: 'water' });
  assert(free.length === before, 'water acquired a light');
  const f = fx.cast({ line, seed: 2, palette: 'fire' });
  assert(free.length === before - 1, 'fire did not acquire a light');
  w.dispose(); f.dispose();
  assert(free.length === before, 'light not released');
  fx.dispose();
});

check('the same seed produces the same puff cloud', () => {
  const run = () => {
    const { deps } = makeDeps();
    const fx = createStreamFx(deps);
    const inst = fx.cast({ line, seed: 4242, palette: 'water' });
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) alive = inst.update(1 / 60, i / 60);
    const geo = inst.group.children[1].geometry;
    const n = geo.instanceCount;
    const out = Array.from(geo.getAttribute('aPos').array.slice(0, n * 3));
    inst.dispose(); fx.dispose();
    return out;
  };
  const a = run(), b = run();
  assert(a.length > 0 && a.length === b.length, `lengths ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `diverged at ${i}: ${a[i]} vs ${b[i]}`);
});

check('kits are pooled across casts and disposed by the factory', () => {
  const { deps, scene } = makeDeps();
  const fx = createStreamFx(deps);
  const a = fx.cast({ line, seed: 1, palette: 'ice' });
  const groupA = a.group;
  a.dispose();
  const b = fx.cast({ line, seed: 2, palette: 'ice' });
  assert(b.group === groupA, 'kit was not reused');
  assert(b.group.children[1].geometry.instanceCount === 0, 'reused kit kept stale puffs');
  b.dispose();
  fx.dispose();
  assert(scene.children.length === 0, 'scene not emptied');
});

check('double dispose and an unstarted cast are safe', () => {
  const { deps } = makeDeps();
  const fx = createStreamFx(deps);
  const inst = fx.cast({ line, seed: 5, palette: 'fire' });
  inst.dispose();
  inst.dispose();
  fx.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
