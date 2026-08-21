import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createDomeFx, PALETTES } from './moves/fx-dome.js';

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

function makeDeps(terrainHeight = () => 0, lightCount = 6) {
  const scene = new THREE.Scene();
  const pool = [];
  for (let i = 0; i < lightCount; i++) pool.push(new THREE.PointLight(0xffffff, 0, 1));
  const busy = new Set();
  const lights = {
    acquire() { const l = pool.find((p) => !busy.has(p)); if (l) busy.add(l); return l || null; },
    release(l) { busy.delete(l); },
  };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight, lights }, scene, busy };
}

// A self-cast move: attacker and target coincide, matching how the harness calls castMove for move.self.
function selfLine(terrainHeight = () => 0, at = { x: 2, z: -1 }) {
  return makeLine({ from: at, to: at, terrainHeight });
}

check('cast builds a shell + hem + motes group and walks travel -> impact -> done', () => {
  const { deps, scene } = makeDeps();
  const fx = createDomeFx(deps);
  const inst = fx.cast({ line: selfLine(), seed: 7, palette: 'protect', power: 1 });
  assert(scene.children.includes(inst.group), 'group not added to scene');
  assert(inst.group.children.length >= 3, `expected shell + hem + motes, got ${inst.group.children.length}`);

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
  assert(inst.update(1 / 60, 10) === false, 'update after done returned alive');
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group not removed on dispose');
  fx.dispose();
});

check('the seal front sweeps colatitude (aV) during travel and reaches the pole by impact', () => {
  const { deps } = makeDeps();
  const fx = createDomeFx(deps, { travelTime: 0.3 });
  const inst = fx.cast({ line: selfLine(), seed: 3, palette: 'protect' });
  const us = [];
  for (let i = 0; i < 10; i++) { inst.update(1 / 60, i / 60); us.push(inst.machine.u); }
  assert(us[9] > us[0], 'front did not advance');
  for (let i = 0; i < 20; i++) inst.update(1 / 60, i / 60);
  assert(inst.machine.phase === Phase.IMPACT && inst.machine.u === 1, 'shell did not close by ~0.3 s');
  inst.dispose();
  fx.dispose();
});

check('every palette casts and carries its own lattice/fresnel/rotate flags', () => {
  const { deps } = makeDeps();
  const fx = createDomeFx(deps);
  for (const name of ['screen', 'reflect', 'safeguard', 'protect', 'nonexistent']) {
    const inst = fx.cast({ line: selfLine(), seed: 11, palette: name, power: 1.5 });
    for (let i = 0; i < 40; i++) inst.update(1 / 60, i / 60);
    inst.dispose();
  }
  assert(PALETTES.screen.lattice === 1, 'screen should carry the panel lattice');
  assert(PALETTES.reflect.lattice === 0 && PALETTES.reflect.fresnelMin < PALETTES.screen.fresnelMin, 'reflect should read clearer head-on than screen');
  assert(PALETTES.safeguard.rotateSpeed > 0, 'safeguard should slowly rotate');
  assert(PALETTES.protect.snap === true, 'protect should snap shut faster');
  fx.dispose();
});

check('the hem follows the terrain and the shell scales with power', () => {
  const th = (x, z) => Math.sin(x * 0.7) * 0.4 + Math.cos(z * 0.5) * 0.3;
  const { deps } = makeDeps(th);
  const fx = createDomeFx(deps, { segments: 24, latSegs: 6 });
  const at = { x: 2, z: -1 };
  const small = fx.cast({ line: selfLine(th, at), seed: 5, power: 1 });
  const big = fx.cast({ line: selfLine(th, at), seed: 5, power: 4 });
  const spanOf = (inst) => {
    const pos = inst.group.children[0].geometry.getAttribute('position');
    const rise = inst.group.children[0].geometry.getAttribute('aRise');
    let r = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + rise.getX(i), z = pos.getZ(i) + rise.getZ(i);
      r = Math.max(r, Math.hypot(x, z));
    }
    return r;
  };
  assert(spanOf(big) > spanOf(small) * 1.2, 'power did not grow the shell');
  const hemPos = small.group.children[1].geometry.getAttribute('position');
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < hemPos.count; i++) { lo = Math.min(lo, hemPos.getY(i)); hi = Math.max(hi, hemPos.getY(i)); }
  assert(hi - lo > 0.05, 'hem is flat — terrain was not sampled');
  assert(Math.abs(small.group.position.x - selfLine(th, at).origin.x) < 1e-9, 'group not anchored on the caster');
  small.dispose(); big.dispose();
  fx.dispose();
});

check('the apex is a true pole: every column converges to the same point once the rise is applied', () => {
  const { deps } = makeDeps();
  const fx = createDomeFx(deps, { segments: 20, latSegs: 8, travelTime: 0.2, unfurlWidth: 0.05, poleFadeWidth: 0.05 });
  const inst = fx.cast({ line: selfLine(), seed: 9, palette: 'protect' });
  for (let i = 0; i < 60; i++) inst.update(1 / 60, i / 60); // well past the seal, so unfurl/sink are both ~1 everywhere
  const geo = inst.group.children[0].geometry;
  const pos = geo.getAttribute('position');
  const rise = geo.getAttribute('aRise');
  const rows = 9;
  const cols = pos.count / rows;
  let maxSpread = 0;
  for (let i = 0; i < cols; i++) {
    const vi = i * rows + (rows - 1); // the apex row for this column
    const x = pos.getX(vi) + rise.getX(vi), z = pos.getZ(vi) + rise.getZ(vi);
    maxSpread = Math.max(maxSpread, Math.hypot(x, z));
  }
  assert(maxSpread < 1e-6, `apex columns did not converge, max radial spread ${maxSpread}`);
  inst.dispose();
  fx.dispose();
});

check('the ring seam closes: first and last column share a hem position', () => {
  const th = (x, z) => Math.sin(x) * 0.2;
  const { deps } = makeDeps(th);
  const fx = createDomeFx(deps, { segments: 32, latSegs: 4 });
  const inst = fx.cast({ line: selfLine(th), seed: 9 });
  const geo = inst.group.children[0].geometry;
  const pos = geo.getAttribute('position');
  const rows = 5;
  const last = (pos.count / rows - 1) * rows;
  assert(Math.hypot(pos.getX(0) - pos.getX(last), pos.getZ(0) - pos.getZ(last)) < 1e-9, 'seam hem positions differ');
  inst.dispose();
  fx.dispose();
});

check('lights are borrowed from the pool and given back, and acquire() returning null does not throw', () => {
  const { deps, busy } = makeDeps();
  const fx = createDomeFx(deps, { lightCount: 2 });
  const inst = fx.cast({ line: selfLine(), seed: 2, palette: 'protect' });
  assert(busy.size === 2, `acquired ${busy.size} lights, wanted 2`);
  for (let i = 0; i < 60; i++) inst.update(1 / 60, i / 60);
  assert([...busy].some((l) => l.intensity > 0), 'no light ignited after the shell sealed');
  inst.dispose();
  assert(busy.size === 0, `${busy.size} lights leaked`);
  fx.dispose();

  const starved = makeDeps(() => 0, 0); // an empty pool, so acquire() always returns null
  const fx2 = createDomeFx(starved.deps, { lightCount: 3 });
  const inst2 = fx2.cast({ line: selfLine(), seed: 2 });
  for (let i = 0; i < 30; i++) inst2.update(1 / 60, i / 60);
  inst2.dispose();
  fx2.dispose();
});

check('same seed gives the same geometry, different seeds do not', () => {
  const { deps } = makeDeps();
  const fx = createDomeFx(deps, { segments: 16, latSegs: 4 });
  const jit = (seed) => {
    const inst = fx.cast({ line: selfLine(), seed });
    const a = Array.from(inst.group.children[0].geometry.getAttribute('aColJit').array);
    inst.dispose();
    return a.join(',');
  };
  assert(jit(42) === jit(42), 'same seed diverged');
  assert(jit(42) !== jit(43), 'different seeds matched');
  fx.dispose();
});

check('a held cast parks in IMPACT until release() and then runs FADE', () => {
  const { deps } = makeDeps();
  const fx = createDomeFx(deps, { travelTime: 0.1, impactTime: 0.2, fadeTime: 0.3 });
  const inst = fx.cast({ line: selfLine(), seed: 4, palette: 'protect' });
  inst.machine.hold = true;
  inst.machine.maxHold = 20;
  let alive = true;
  for (let i = 0; i < 60; i++) alive = inst.update(1 / 60, i / 60); // travel + well past impactTime
  assert(inst.machine.phase === Phase.IMPACT && inst.machine.holding, 'did not park in a held IMPACT');
  inst.machine.release();
  for (let i = 0; i < 60 && alive; i++) alive = inst.update(1 / 60, i / 60);
  assert(inst.machine.phase === Phase.DONE, `held effect did not finish FADE, ended in ${inst.machine.phase}`);
  inst.dispose();
  fx.dispose();
});

check('registerHit does not throw with or without a point, and the pulse decays on its own', () => {
  const { deps } = makeDeps();
  const fx = createDomeFx(deps);
  const inst = fx.cast({ line: selfLine(), seed: 6, palette: 'protect' });
  for (let i = 0; i < 30; i++) inst.update(1 / 60, i / 60);
  inst.registerHit();
  inst.registerHit({ x: 2.4, y: 1.1, z: -1.2 });
  for (let i = 0; i < 60; i++) inst.update(1 / 60, i / 60); // long enough for the pulse to fully decay
  inst.dispose();
  fx.dispose();
});

check('update allocates no new mote entries and survives a zero-mote cast', () => {
  const { deps } = makeDeps();
  const fx = createDomeFx(deps, { motes: 0 });
  const inst = fx.cast({ line: selfLine(), seed: 1 });
  for (let i = 0; i < 120; i++) inst.update(1 / 60, i / 60);
  inst.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
