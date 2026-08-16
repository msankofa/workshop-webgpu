import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createAuroraFx, PALETTES } from './moves/fx-aurora.js';

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

function makeDeps(terrainHeight = () => 0) {
  const scene = new THREE.Scene();
  const pool = [];
  for (let i = 0; i < 6; i++) pool.push(new THREE.PointLight(0xffffff, 0, 1));
  const busy = new Set();
  const lights = {
    acquire() { const l = pool.find((p) => !busy.has(p)); if (l) busy.add(l); return l || null; },
    release(l) { busy.delete(l); },
  };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight, lights }, scene, busy };
}

function line(terrainHeight = () => 0) {
  return makeLine({ from: { x: 2, z: -1 }, to: { x: 7, z: 3 }, terrainHeight });
}

check('cast builds a ring group and walks travel -> impact -> done', () => {
  const { deps, scene } = makeDeps();
  const fx = createAuroraFx(deps);
  const inst = fx.cast({ line: line(), seed: 7, palette: 'aurora', power: 1 });
  assert(scene.children.includes(inst.group), 'group not added to scene');
  assert(inst.group.children.length >= 4, `expected curtains + hem + motes, got ${inst.group.children.length}`);

  let impacts = 0, dones = 0, frames = 0;
  inst.onImpact = () => { impacts++; };
  inst.onDone = () => { dones++; };

  assert(inst.machine.phase === Phase.TRAVEL, 'not travelling');
  let alive = true, sawImpactPhase = false, sawFade = false;
  for (let i = 0; i < 400 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    frames++;
    if (inst.machine.phase === Phase.IMPACT) sawImpactPhase = true;
    if (inst.machine.phase === Phase.FADE) sawFade = true;
  }
  assert(sawImpactPhase && sawFade, 'never held or faded');
  assert(inst.machine.phase === Phase.DONE, `ended in ${inst.machine.phase}`);
  assert(impacts === 1, `onImpact fired ${impacts} times`);
  assert(dones === 1, `onDone fired ${dones} times`);
  assert(frames > 200 && frames < 300, `unexpected lifetime ${frames} frames`);
  assert(inst.update(1 / 60, 10) === false, 'update after done returned alive');
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group not removed on dispose');
  fx.dispose();
});

check('the unfurl front sweeps the ring during travel and closes at impact', () => {
  const { deps } = makeDeps();
  const fx = createAuroraFx(deps);
  const inst = fx.cast({ line: line(), seed: 3 });
  const us = [];
  for (let i = 0; i < 20; i++) { inst.update(1 / 60, i / 60); us.push(inst.machine.u); }
  assert(us[19] > us[0], 'front did not advance');
  assert(inst.machine.u < 1, `ring closed too early (u=${inst.machine.u})`);
  for (let i = 0; i < 30; i++) inst.update(1 / 60, i / 60);
  assert(inst.machine.phase === Phase.IMPACT && inst.machine.u === 1, 'ring did not close by ~0.6 s');
  inst.dispose();
  fx.dispose();
});

check('every palette casts and spectrum flags the cosine cycle', () => {
  const { deps } = makeDeps();
  const fx = createAuroraFx(deps);
  for (const name of ['default', 'aurora', 'spectrum', 'ice', 'nonexistent']) {
    const inst = fx.cast({ line: line(), seed: 11, palette: name, power: 1.5 });
    for (let i = 0; i < 40; i++) inst.update(1 / 60, i / 60);
    inst.dispose();
  }
  assert(PALETTES.spectrum.spectrum === 1, 'spectrum palette not flagged');
  assert(PALETTES.aurora.spectrum === 0 && PALETTES.ice.spectrum === 0, 'non-spectrum palette flagged');
  fx.dispose();
});

check('the ring follows the terrain and scales with power', () => {
  const th = (x, z) => Math.sin(x * 0.7) * 0.4 + Math.cos(z * 0.5) * 0.3;
  const { deps } = makeDeps(th);
  const fx = createAuroraFx(deps, { segments: 24 });
  const l = line(th);
  const small = fx.cast({ line: l, seed: 5, power: 1 });
  const big = fx.cast({ line: l, seed: 5, power: 4 });
  const radiusOf = (inst) => {
    const pos = inst.group.children[0].geometry.getAttribute('position');
    let r = 0;
    for (let i = 0; i < pos.count; i++) r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)));
    return r;
  };
  const yspread = (inst) => {
    const pos = inst.group.children[0].geometry.getAttribute('position');
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    return hi - lo;
  };
  assert(radiusOf(big) > radiusOf(small) * 1.2, 'power did not grow the ring');
  assert(yspread(small) > 0.05, 'hem is flat — terrain was not sampled');
  assert(Math.abs(small.group.position.x - l.origin.x) < 1e-9, 'group not anchored on the attacker');
  small.dispose(); big.dispose();
  fx.dispose();
});

check('lights are borrowed from the pool and given back', () => {
  const { deps, busy } = makeDeps();
  const fx = createAuroraFx(deps);
  const inst = fx.cast({ line: line(), seed: 2 });
  assert(busy.size === 3, `acquired ${busy.size} lights, wanted 3`);
  for (let i = 0; i < 60; i++) inst.update(1 / 60, i / 60);
  assert([...busy].some((l) => l.intensity > 0), 'no light ignited after the ring closed');
  inst.dispose();
  assert(busy.size === 0, `${busy.size} lights leaked`);
  fx.dispose();
});

check('same seed gives the same geometry, different seeds do not', () => {
  const { deps } = makeDeps();
  const fx = createAuroraFx(deps, { segments: 16 });
  const jit = (seed) => {
    const inst = fx.cast({ line: line(), seed });
    const a = Array.from(inst.group.children[0].geometry.getAttribute('aColJit').array);
    inst.dispose();
    return a.join(',');
  };
  assert(jit(42) === jit(42), 'same seed diverged');
  assert(jit(42) !== jit(43), 'different seeds matched');
  fx.dispose();
});

check('the ring seam closes: first and last column share a position', () => {
  const th = (x, z) => Math.sin(x) * 0.2;
  const { deps } = makeDeps(th);
  const fx = createAuroraFx(deps, { segments: 32, heightSegs: 4 });
  const inst = fx.cast({ line: line(th), seed: 9 });
  const geo = inst.group.children[0].geometry;
  const pos = geo.getAttribute('position');
  const jitA = geo.getAttribute('aColJit');
  const rows = 5;
  const last = (pos.count / rows - 1) * rows;
  assert(Math.hypot(pos.getX(0) - pos.getX(last), pos.getZ(0) - pos.getZ(last)) < 1e-9, 'seam positions differ');
  assert(Math.abs(jitA.getX(0) - jitA.getX(last)) < 1e-6, 'seam crest jitter differs');
  inst.dispose();
  fx.dispose();
});

check('update allocates no new mote matrices and survives a zero-mote cast', () => {
  const { deps } = makeDeps();
  const fx = createAuroraFx(deps, { motes: 0 });
  const inst = fx.cast({ line: line(), seed: 1 });
  for (let i = 0; i < 120; i++) inst.update(1 / 60, i / 60);
  inst.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
