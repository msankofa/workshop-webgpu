import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createOrbFx, PALETTES } from './moves/fx-orb.js';

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

function makeDeps({ noLights = false } = {}) {
  const scene = new THREE.Scene();
  const pool = [new THREE.PointLight(), new THREE.PointLight()];
  const free = pool.slice();
  const acquired = [];
  const lights = {
    acquire() { if (noLights) return null; const l = free.pop() || null; if (l) acquired.push(l); return l; },
    release(l) { if (!l) return; const i = acquired.indexOf(l); if (i >= 0) acquired.splice(i, 1); free.push(l); },
  };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight: () => 0, lights }, scene, free, acquired };
}

const line = makeLine({ from: { x: 0, z: 0 }, to: { x: 6, z: 2 }, terrainHeight: () => 0 });
const BASE_PALETTES = ['shadow', 'verdant', 'sludge', 'aura', 'ember'];
const RECOLORS = ['electro', 'mud', 'weather', 'zapcannon'];

check('every required palette exists, plus the four recolors', () => {
  for (const k of BASE_PALETTES) assert(PALETTES[k], `missing palette ${k}`);
  for (const k of RECOLORS) assert(PALETTES[k], `missing recolor palette ${k}`);
});

check('a cast walks travel -> impact -> done and fires both callbacks once', () => {
  const { deps, scene } = makeDeps();
  const fx = createOrbFx(deps);
  const inst = fx.cast({ line, seed: 7, palette: 'shadow', power: 1.1, sourceY: 0.9, targetY: 0.7 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  let impacts = 0, dones = 0, sawTravel = false, sawImpact = false, sawFade = false, frames = 0;
  inst.onImpact = () => impacts++;
  inst.onDone = () => dones++;
  let alive = true;
  for (let i = 0; i < 400 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    frames++;
    if (inst.machine.phase === Phase.TRAVEL) sawTravel = true;
    if (inst.machine.phase === Phase.IMPACT) sawImpact = true;
    if (inst.machine.phase === Phase.FADE) sawFade = true;
  }
  assert(sawTravel && sawImpact && sawFade, `phases missed t=${sawTravel} i=${sawImpact} f=${sawFade}`);
  assert(inst.machine.phase === Phase.DONE, `ended in ${inst.machine.phase}`);
  assert(impacts === 1 && dones === 1, `callbacks ${impacts}/${dones}`);
  assert(frames < 400, 'never finished');
  assert(inst.update(1 / 60, 99) === false, 'update after done stayed alive');
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group left in the scene');
  fx.dispose();
});

check('u advances monotonically and a heavy-arc palette actually lobs', () => {
  const { deps } = makeDeps();
  const fx = createOrbFx(deps, { travelSpeed: 10 });
  const inst = fx.cast({ line, seed: 3, palette: 'sludge', power: 1, sourceY: 0.9, targetY: 0.7 });
  const orbPivot = inst.group.children[0];
  let last = -1, maxY = -Infinity, minY = Infinity, alive = true;
  for (let i = 0; i < 30 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    assert(inst.machine.u >= last, 'u went backwards');
    last = inst.machine.u;
    if (inst.machine.phase === Phase.TRAVEL) {
      maxY = Math.max(maxY, orbPivot.position.y);
      minY = Math.min(minY, orbPivot.position.y);
    }
  }
  assert(maxY > minY + 0.3, `sludge's arc barely rose: min=${minY.toFixed(2)} max=${maxY.toFixed(2)}`);
  while (alive) alive = inst.update(1 / 60, 9);
  inst.dispose();
  fx.dispose();
});

check('all five base palettes cast, spray a trail and clean up with no leaked lights', () => {
  const { deps, acquired } = makeDeps();
  const fx = createOrbFx(deps);
  for (const palette of BASE_PALETTES) {
    const inst = fx.cast({ line, seed: 11, palette });
    const trailGeo = inst.group.children[1].geometry;
    let peak = 0, alive = true;
    for (let i = 0; i < 400 && alive; i++) {
      alive = inst.update(1 / 60, i / 60);
      peak = Math.max(peak, trailGeo.instanceCount);
    }
    assert(peak > 3, `${palette} emitted only ${peak} trail particles`);
    inst.dispose();
  }
  assert(acquired.length === 0, `lights leaked: ${acquired.length}`);
  fx.dispose();
});

check('aura and its zapcannon recolor carry a ring, the others do not', () => {
  const { deps } = makeDeps();
  const fx = createOrbFx(deps);
  const withRing = fx.cast({ line, seed: 1, palette: 'aura' });
  const zap = fx.cast({ line, seed: 1, palette: 'zapcannon' });
  const withoutRing = fx.cast({ line, seed: 1, palette: 'verdant' });
  assert(withRing.group.children[0].children.length === 3, 'aura should have core+halo+ring');
  assert(zap.group.children[0].children.length === 3, 'zapcannon should have core+halo+ring');
  assert(withoutRing.group.children[0].children.length === 2, 'verdant should have only core+halo');
  withRing.dispose(); zap.dispose(); withoutRing.dispose();
  fx.dispose();
});

check('ember (Will-O-Wisp) skips the ground decal, shadow does not', () => {
  const { deps } = makeDeps();
  const fx = createOrbFx(deps);
  const noDecal = fx.cast({ line, seed: 1, palette: 'ember' });
  const decal = fx.cast({ line, seed: 1, palette: 'shadow' });
  assert(noDecal.group.children.length === 4, `ember should have no decal mesh, had ${noDecal.group.children.length} children`);
  assert(decal.group.children.length === 5, `shadow should have a decal mesh, had ${decal.group.children.length} children`);
  noDecal.dispose(); decal.dispose();
  fx.dispose();
});

check('the same seed produces the same trail cloud', () => {
  const run = () => {
    const { deps } = makeDeps();
    const fx = createOrbFx(deps);
    const inst = fx.cast({ line, seed: 4242, palette: 'ember' });
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) alive = inst.update(1 / 60, i / 60);
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

check('chargeIn actually delays the front: zapcannon starts slower than shadow at the same travelSpeed', () => {
  const { deps: depsA } = makeDeps();
  const { deps: depsB } = makeDeps();
  const fxA = createOrbFx(depsA, { travelSpeed: 10 });
  const fxB = createOrbFx(depsB, { travelSpeed: 10 });
  const shadow = fxA.cast({ line, seed: 1, palette: 'shadow' }); // chargeIn 0.08
  const zap = fxB.cast({ line, seed: 1, palette: 'zapcannon' }); // chargeIn 0.55
  for (let i = 0; i < 6; i++) { shadow.update(1 / 60, i / 60); zap.update(1 / 60, i / 60); }
  assert(zap.machine.u < shadow.machine.u, `charge beat had no effect: zap u=${zap.machine.u} shadow u=${shadow.machine.u}`);
  shadow.dispose(); zap.dispose();
  fxA.dispose(); fxB.dispose();
});

check('kits are pooled across casts and disposed by the factory', () => {
  const { deps, scene } = makeDeps();
  const fx = createOrbFx(deps);
  const a = fx.cast({ line, seed: 1, palette: 'aura' });
  const groupA = a.group;
  a.dispose();
  const b = fx.cast({ line, seed: 2, palette: 'aura' });
  assert(b.group === groupA, 'kit was not reused');
  assert(b.group.children[1].geometry.instanceCount === 0, 'reused kit kept a stale trail');
  b.dispose();
  fx.dispose();
  assert(scene.children.length === 0, 'scene not emptied');
});

check('double dispose and an unstarted cast are safe', () => {
  const { deps } = makeDeps();
  const fx = createOrbFx(deps);
  const inst = fx.cast({ line, seed: 5, palette: 'mud' });
  inst.dispose();
  inst.dispose();
  fx.dispose();
  fx.dispose();
});

check('nothing throws when lights.acquire() returns null', () => {
  const { deps } = makeDeps({ noLights: true });
  const fx = createOrbFx(deps);
  const inst = fx.cast({ line, seed: 9, palette: 'shadow' });
  let alive = true;
  for (let i = 0; i < 300 && alive; i++) alive = inst.update(1 / 60, i / 60);
  inst.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
