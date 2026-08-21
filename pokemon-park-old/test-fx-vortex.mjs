import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createVortexFx, PALETTES, funnelRadiusAt, funnelHeightAt } from './moves/fx-vortex.js';

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

// A trapping move stands the funnel at the target, well away from the attacker.
const line = makeLine({ from: { x: 0, z: 0 }, to: { x: 3, z: 4 }, terrainHeight: () => 0 });

check('every required palette exists', () => {
  for (const k of ['flame', 'water', 'sand', 'leaf', 'gale']) assert(PALETTES[k], `missing palette ${k}`);
});

check('the CPU radius/height mirror agrees with the documented shader formula', () => {
  for (const key of Object.keys(PALETTES)) {
    const P = PALETTES[key];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      // Independent re-derivation of the exact expressions named in buildKit's comments, so this
      // catches the mirror drifting even though Node cannot execute the real TSL node graph.
      const wantR = P.radiusNear + (P.radiusFar - P.radiusNear) * Math.pow(t, P.radiusCurve);
      const gotR = funnelRadiusAt(P, 1, t);
      assert(Math.abs(gotR - wantR) < 1e-9, `${key} radius@${t}: ${gotR} vs ${wantR}`);
      const wantH = 5 * t;
      const gotH = funnelHeightAt(5, t);
      assert(Math.abs(gotH - wantH) < 1e-9, `${key} height@${t}: ${gotH} vs ${wantH}`);
    }
    // widthScale must multiply the radius linearly, since the GPU applies it as `.mul(u.width)`.
    assert(Math.abs(funnelRadiusAt(P, 2, 0.5) - funnelRadiusAt(P, 1, 0.5) * 2) < 1e-9, `${key} width scale not linear`);
  }
  assert(funnelRadiusAt({ radiusNear: 1, radiusFar: 1, radiusCurve: 1 }, 1, -1) === 1, 'radius not clamped below t=0');
  assert(funnelRadiusAt({ radiusNear: 1, radiusFar: 2, radiusCurve: 1 }, 1, 2) === 2, 'radius not clamped above t=1');
});

check('a cast walks travel -> impact -> done and fires both callbacks once', () => {
  const { deps, scene } = makeDeps();
  const fx = createVortexFx(deps);
  const inst = fx.cast({ line, seed: 7, palette: 'flame', power: 1.2, sourceY: 0.9, targetY: 0.7 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  let impacts = 0, dones = 0, sawTravel = false, sawImpact = false, sawFade = false;
  inst.onImpact = () => impacts++;
  inst.onDone = () => dones++;
  let alive = true, frames = 0;
  for (let i = 0; i < 600 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    frames++;
    if (inst.machine.phase === Phase.TRAVEL) sawTravel = true;
    if (inst.machine.phase === Phase.IMPACT) sawImpact = true;
    if (inst.machine.phase === Phase.FADE) sawFade = true;
  }
  assert(sawTravel && sawImpact && sawFade, `phases missed t=${sawTravel} i=${sawImpact} f=${sawFade}`);
  assert(inst.machine.phase === Phase.DONE, `ended in ${inst.machine.phase}`);
  assert(impacts === 1 && dones === 1, `callbacks ${impacts}/${dones}`);
  assert(frames < 600, 'never finished');
  assert(inst.update(1 / 60, 5) === false, 'update after done stayed alive');
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group left in the scene');
  fx.dispose();
});

check('the front reaches u=1 and IMPACT holds the funnel standing', () => {
  const { deps } = makeDeps();
  const fx = createVortexFx(deps, { travelSpeed: 6, impactTime: 1 });
  const inst = fx.cast({ line, seed: 3, palette: 'sand' });
  let last = -1, holdFrames = 0, alive = true;
  for (let i = 0; i < 600 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    assert(inst.machine.u >= last, 'front went backwards');
    last = inst.machine.u;
    if (inst.machine.phase === Phase.IMPACT) holdFrames++;
  }
  assert(last === 1, `travel never reached u=1 (last=${last})`);
  assert(holdFrames >= 55, `IMPACT held only ${holdFrames} frames, wanted ~60`);
  inst.dispose();
  fx.dispose();
});

check('a held cast parks in IMPACT until release() and then fades', () => {
  const { deps } = makeDeps();
  const fx = createVortexFx(deps, { travelSpeed: 20 });
  const inst = fx.cast({ line, seed: 9, palette: 'gale' });
  inst.machine.hold = true; inst.machine.maxHold = 50; // set by the harness, mirrored here
  let alive = true;
  for (let i = 0; i < 400 && alive; i++) alive = inst.update(1 / 60, i / 60);
  assert(inst.machine.phase === Phase.IMPACT, `expected a hold in IMPACT, got ${inst.machine.phase}`);
  inst.machine.release();
  let n = 0;
  while (alive && n < 400) { alive = inst.update(1 / 60, n / 60); n++; }
  assert(inst.machine.phase === Phase.DONE, `release() did not let it finish, ended ${inst.machine.phase}`);
  inst.dispose();
  fx.dispose();
});

check('all five palettes cast, emit debris and clean up', () => {
  const { deps, acquired } = makeDeps();
  const fx = createVortexFx(deps);
  for (const palette of Object.keys(PALETTES)) {
    const inst = fx.cast({ line, seed: 11, palette });
    let peak = 0, alive = true;
    for (let i = 0; i < 600 && alive; i++) {
      alive = inst.update(1 / 60, i / 60);
      peak = Math.max(peak, inst.group.children[3].geometry.instanceCount);
    }
    assert(peak > 3, `${palette} emitted only ${peak} debris sprites`);
    assert(peak <= 220, `${palette} exceeded the debris cap: ${peak}`);
    inst.dispose();
  }
  assert(acquired.length === 0, `lights leaked: ${acquired.length}`);
  fx.dispose();
});

check('sand and gale take no light, flame does', () => {
  const { deps, free } = makeDeps();
  const fx = createVortexFx(deps);
  const before = free.length;
  const s = fx.cast({ line, seed: 2, palette: 'sand' });
  assert(free.length === before, 'sand acquired a light');
  const g = fx.cast({ line, seed: 2, palette: 'gale' });
  assert(free.length === before, 'gale acquired a light');
  const f = fx.cast({ line, seed: 2, palette: 'flame' });
  assert(free.length === before - 1, 'flame did not acquire a light');
  s.dispose(); g.dispose(); f.dispose();
  assert(free.length === before, 'light not released');
  fx.dispose();
});

check('nothing throws when the light pool is exhausted', () => {
  const { deps } = makeDeps();
  deps.lights = { acquire: () => null, release: () => {} };
  const fx = createVortexFx(deps);
  const inst = fx.cast({ line, seed: 1, palette: 'flame' });
  let alive = true;
  for (let i = 0; i < 300 && alive; i++) alive = inst.update(1 / 60, i / 60);
  inst.dispose();
  fx.dispose();
});

check('the same seed produces the same debris cloud on the first frames', () => {
  const run = () => {
    const { deps } = makeDeps();
    const fx = createVortexFx(deps);
    const inst = fx.cast({ line, seed: 4242, palette: 'water' });
    let alive = true;
    for (let i = 0; i < 90 && alive; i++) alive = inst.update(1 / 60, i / 60);
    const geo = inst.group.children[3].geometry;
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
  const fx = createVortexFx(deps);
  const a = fx.cast({ line, seed: 1, palette: 'leaf' });
  const groupA = a.group;
  a.dispose();
  const b = fx.cast({ line, seed: 2, palette: 'leaf' });
  assert(b.group === groupA, 'kit was not reused');
  assert(b.group.children[3].geometry.instanceCount === 0, 'reused kit kept stale debris');
  b.dispose();
  fx.dispose();
  assert(scene.children.length === 0, 'scene not emptied');
});

check('double dispose and an unstarted cast are safe', () => {
  const { deps } = makeDeps();
  const fx = createVortexFx(deps);
  const inst = fx.cast({ line, seed: 5, palette: 'flame' });
  inst.dispose();
  inst.dispose();
  fx.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
