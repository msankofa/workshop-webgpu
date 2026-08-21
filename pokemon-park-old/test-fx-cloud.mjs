import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createCloudFx, PALETTES } from './moves/fx-cloud.js';

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
const PALETTE_KEYS = ['frost', 'smoke', 'cinder', 'spore', 'dust'];

check('every palette in the brief exists with a shape and a cap', () => {
  for (const k of PALETTE_KEYS) {
    assert(PALETTES[k], `missing palette ${k}`);
    assert(['spray', 'puff', 'drift'].includes(PALETTES[k].shape), `${k} has no valid shape`);
    assert(PALETTES[k].cap > 0, `${k} has no cap`);
  }
});

check('a cast walks travel -> impact -> done, fires both callbacks once, and the scene gains/loses the group', () => {
  const { deps, scene } = makeDeps();
  const fx = createCloudFx(deps);
  const inst = fx.cast({ line, seed: 7, palette: 'smoke', power: 1.1, sourceY: 0.9, targetY: 0.7 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  let impacts = 0, dones = 0, sawTravel = false, sawImpact = false, sawFade = false;
  inst.onImpact = () => impacts++;
  inst.onDone = () => dones++;
  let alive = true;
  for (let i = 0; i < 400 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    if (inst.machine.phase === Phase.TRAVEL) sawTravel = true;
    if (inst.machine.phase === Phase.IMPACT) sawImpact = true;
    if (inst.machine.phase === Phase.FADE) sawFade = true;
  }
  assert(sawTravel && sawImpact && sawFade, `phases missed t=${sawTravel} i=${sawImpact} f=${sawFade}`);
  assert(inst.machine.phase === Phase.DONE, `ended in ${inst.machine.phase}`);
  assert(impacts === 1 && dones === 1, `callbacks ${impacts}/${dones}`);
  assert(inst.update(1 / 60, 5) === false, 'update after done stayed alive');
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group left in the scene');
  fx.dispose();
});

check('every palette casts, emits sprites within its cap, and cleans up', () => {
  const { deps, acquired } = makeDeps();
  const fx = createCloudFx(deps);
  for (const palette of PALETTE_KEYS) {
    const P = PALETTES[palette];
    const inst = fx.cast({ line, seed: 11, palette, power: 1 });
    let peak = 0, alive = true;
    for (let i = 0; i < 400 && alive; i++) {
      alive = inst.update(1 / 60, i / 60);
      peak = Math.max(peak, inst.group.children[0].geometry.instanceCount);
    }
    assert(peak > 0, `${palette} emitted no sprites`);
    assert(peak <= P.cap, `${palette} exceeded its cap: ${peak} > ${P.cap}`);
    inst.dispose();
  }
  assert(acquired.length === 0, `lights leaked: ${acquired.length}`);
  fx.dispose();
});

check('only cinder (the palette with a light) ever acquires one', () => {
  const { deps, free } = makeDeps();
  const fx = createCloudFx(deps);
  const before = free.length;
  for (const palette of ['frost', 'smoke', 'spore', 'dust']) {
    const inst = fx.cast({ line, seed: 2, palette });
    assert(free.length === before, `${palette} acquired a light`);
    inst.dispose();
  }
  const inst = fx.cast({ line, seed: 2, palette: 'cinder' });
  assert(free.length === before - 1, 'cinder did not acquire a light');
  inst.dispose();
  assert(free.length === before, 'light not released on dispose');
  fx.dispose();
});

check('dust alone carries a ground decal', () => {
  const { deps } = makeDeps();
  const fx = createCloudFx(deps);
  for (const palette of PALETTE_KEYS) {
    const inst = fx.cast({ line, seed: 1, palette });
    const hasDecal = inst.group.children.length > 1;
    assert(hasDecal === (palette === 'dust'), `${palette} decal presence ${hasDecal}, expected ${palette === 'dust'}`);
    inst.dispose();
  }
  fx.dispose();
});

check('puff (dust) bursts on impact instead of emitting during travel', () => {
  const { deps } = makeDeps();
  const fx = createCloudFx(deps);
  const inst = fx.cast({ line, seed: 9, palette: 'dust', power: 1 });
  let preImpact = 0, impacted = false, postImpactPeak = 0, alive = true;
  inst.onImpact = () => { impacted = true; };
  for (let i = 0; i < 400 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    const n = inst.group.children[0].geometry.instanceCount;
    if (!impacted) preImpact = Math.max(preImpact, n);
    else postImpactPeak = Math.max(postImpactPeak, n);
  }
  assert(postImpactPeak > preImpact, `burst did not raise the sprite count: pre=${preImpact} post=${postImpactPeak}`);
  inst.dispose();
  fx.dispose();
});

check('drift (spore) reaches a stable population under a long hold instead of still thickening', () => {
  const { deps } = makeDeps();
  const fx = createCloudFx(deps, { impactTime: 6 });
  const inst = fx.cast({ line, seed: 5, palette: 'spore', power: 1 });
  let alive = true;
  const samples = [];
  for (let i = 0; i < 60 * 6 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    if (i % 60 === 0) samples.push(inst.group.children[0].geometry.instanceCount);
  }
  const late = samples.slice(-3);
  const spread = Math.max(...late) - Math.min(...late);
  assert(spread <= Math.max(...late) * 0.25, `late population still moving a lot: ${late.join(',')}`);
  inst.dispose();
  fx.dispose();
});

check('the same seed produces identical first-frame transforms', () => {
  const run = () => {
    const { deps } = makeDeps();
    const fx = createCloudFx(deps);
    const inst = fx.cast({ line, seed: 4242, palette: 'frost' });
    inst.update(1 / 60, 0);
    const geo = inst.group.children[0].geometry;
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
  const fx = createCloudFx(deps);
  const a = fx.cast({ line, seed: 1, palette: 'smoke' });
  const groupA = a.group;
  a.dispose();
  const b = fx.cast({ line, seed: 2, palette: 'smoke' });
  assert(b.group === groupA, 'kit was not reused');
  assert(b.group.children[0].geometry.instanceCount === 0, 'reused kit kept stale sprites');
  b.dispose();
  fx.dispose();
  assert(scene.children.length === 0, 'scene not emptied');
});

check('a starved light pool (acquire returns null) never throws, for the palette that wants one', () => {
  const scene = new THREE.Scene();
  const lights = { acquire: () => null, release: () => {} };
  const fx = createCloudFx({ THREE, TSL, NODES, scene, terrainHeight: () => 0, lights });
  const inst = fx.cast({ line, seed: 3, palette: 'cinder' });
  let alive = true;
  for (let i = 0; i < 300 && alive; i++) alive = inst.update(1 / 60, i / 60);
  inst.dispose();
  fx.dispose();
});

check('missing deps.lights entirely never throws for a palette with no light', () => {
  const scene = new THREE.Scene();
  const fx = createCloudFx({ THREE, TSL, NODES, scene, terrainHeight: () => 0, lights: undefined });
  const inst = fx.cast({ line, seed: 3, palette: 'smoke' });
  let alive = true;
  for (let i = 0; i < 200 && alive; i++) alive = inst.update(1 / 60, i / 60);
  inst.dispose();
  fx.dispose();
});

check('double dispose and an unstarted cast are safe', () => {
  const { deps } = makeDeps();
  const fx = createCloudFx(deps);
  const inst = fx.cast({ line, seed: 5, palette: 'frost' });
  inst.dispose();
  inst.dispose();
  fx.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
