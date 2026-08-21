import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createAuraFx, PALETTES } from './moves/fx-aura.js';

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
  return { deps: { THREE, TSL, NODES, scene, terrainHeight, lights }, scene, busy, pool };
}

// A self-buff line: castMove passes the same object as `from` and `to`, which makeLine's degenerate
// branch turns into a fixed 5 cm walk rather than a true zero-length line (see the module's ANCHOR GAP
// note). Reproduced here rather than imported so the test does not depend on demos/pokemon-moves.html.
function selfLine(terrainHeight = () => 0, from = { x: 3, z: -2 }) {
  return makeLine({ from, to: from, terrainHeight });
}

check('cast builds a body-hugging group and walks travel -> impact -> done exactly once', () => {
  const { deps, scene } = makeDeps();
  const fx = createAuraFx(deps);
  const inst = fx.cast({ line: selfLine(), seed: 7, palette: 'might', power: 1, sourceY: 1.1 });
  assert(scene.children.includes(inst.group), 'group not added to scene');
  assert(inst.group.children.length >= 4, `expected curtains + hem + motes (+arcs/burst), got ${inst.group.children.length}`);

  let impacts = 0, dones = 0, frames = 0;
  inst.onImpact = () => { impacts++; };
  inst.onDone = () => { dones++; };
  assert(inst.machine.phase === Phase.TRAVEL, 'not travelling');

  let alive = true, sawImpact = false, sawFade = false;
  for (let i = 0; i < 300 && alive; i++) {
    alive = inst.update(1 / 60, i / 60);
    frames++;
    if (inst.machine.phase === Phase.IMPACT) sawImpact = true;
    if (inst.machine.phase === Phase.FADE) sawFade = true;
  }
  assert(sawImpact && sawFade, 'never held or faded');
  assert(inst.machine.phase === Phase.DONE, `ended in ${inst.machine.phase}`);
  assert(impacts === 1, `onImpact fired ${impacts} times`);
  assert(dones === 1, `onDone fired ${dones} times`);
  assert(inst.update(1 / 60, 10) === false, 'update after done returned alive');

  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group not removed on dispose');
  assert(inst.group.children.length === 0 || inst.group.parent === null, 'dispose did not detach the group');
  fx.dispose();
});

check('every palette casts, runs to completion, and leaves nothing live', () => {
  const { deps, scene } = makeDeps();
  const fx = createAuraFx(deps);
  for (const name of Object.keys(PALETTES)) {
    if (name === 'default') continue;
    const inst = fx.cast({ line: selfLine(), seed: 11, palette: name, power: 1.3, sourceY: 0.95 });
    assert(scene.children.includes(inst.group), `${name}: group not added`);
    let alive = true;
    for (let i = 0; i < 300 && alive; i++) alive = inst.update(1 / 60, i / 60);
    assert(!alive, `${name}: never finished`);
    inst.dispose();
    assert(!scene.children.includes(inst.group), `${name}: group not removed on dispose`);
  }
  fx.dispose();
});

check('an unknown palette falls back to default without throwing', () => {
  const { deps } = makeDeps();
  const fx = createAuraFx(deps);
  const inst = fx.cast({ line: selfLine(), seed: 4, palette: 'nonexistent', sourceY: 1 });
  for (let i = 0; i < 20; i++) inst.update(1 / 60, i / 60);
  inst.dispose();
  fx.dispose();
});

check('the sleeve is sized from sourceY, not guessed: taller casters get a bigger ring and a taller lift', () => {
  const { deps } = makeDeps();
  const fx = createAuraFx(deps);
  const spanOf = (inst) => {
    const pos = inst.group.children[0].geometry.getAttribute('position');
    let rMax = 0, yMax = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      rMax = Math.max(rMax, Math.hypot(pos.getX(i), pos.getZ(i)));
      yMax = Math.max(yMax, pos.getY(i));
    }
    return { rMax, yMax };
  };
  const short = fx.cast({ line: selfLine(), seed: 5, palette: 'might', sourceY: 0.6 });
  const tall = fx.cast({ line: selfLine(), seed: 5, palette: 'might', sourceY: 2.4 });
  const a = spanOf(short), b = spanOf(tall);
  assert(b.rMax > a.rMax, `radius did not grow with sourceY (${a.rMax} -> ${b.rMax})`);
  short.dispose(); tall.dispose();
  fx.dispose();
});

check('malice sinks: its curtain reveals top-down instead of bottom-up', () => {
  const { deps } = makeDeps();
  const fx = createAuraFx(deps, { segments: 16, heightSegs: 6 });
  const mightInst = fx.cast({ line: selfLine(), seed: 9, palette: 'might', sourceY: 1 });
  const maliceInst = fx.cast({ line: selfLine(), seed: 9, palette: 'malice', sourceY: 1 });
  assert(PALETTES.might.riseSign > 0, 'might should rise');
  assert(PALETTES.malice.riseSign < 0, 'malice should be flagged to sink');
  mightInst.dispose(); maliceInst.dispose();
  fx.dispose();
});

check('lights are borrowed from the pool (at most two) and given back on dispose', () => {
  const { deps, busy } = makeDeps();
  const fx = createAuraFx(deps);
  const inst = fx.cast({ line: selfLine(), seed: 2, palette: 'charge', sourceY: 1 });
  assert(busy.size > 0 && busy.size <= 2, `acquired ${busy.size} lights, wanted 1-2`);
  let sawLit = false;
  for (let i = 0; i < 60; i++) {
    inst.update(1 / 60, i / 60);
    if ([...busy].some((l) => l.intensity > 0)) sawLit = true;
  }
  assert(sawLit, 'no light ever ignited across the cast');
  inst.dispose();
  assert(busy.size === 0, `${busy.size} lights leaked`);
  fx.dispose();
});

check('nothing throws when the light pool is exhausted', () => {
  const { deps, pool, busy } = makeDeps();
  for (const l of pool) busy.add(l); // simulate every light already claimed by other live effects
  const fx = createAuraFx(deps);
  const inst = fx.cast({ line: selfLine(), seed: 3, palette: 'draconic', sourceY: 1 });
  for (let i = 0; i < 90; i++) inst.update(1 / 60, i / 60);
  inst.dispose();
  fx.dispose();
});

check('same seed gives identical first-frame transforms; a different seed diverges', () => {
  const { deps } = makeDeps();
  const fx = createAuraFx(deps);
  const firstFrame = (seed) => {
    const inst = fx.cast({ line: selfLine(), seed, palette: 'mind', sourceY: 1 });
    inst.update(1 / 60, 0);
    const pos = inst.group.children[0].geometry.getAttribute('position');
    const arr = Array.from(pos.array).join(',');
    const moteMesh = inst.group.children.find((c) => c.geometry?.attributes?.aPos);
    const motes = Array.from(moteMesh ? moteMesh.geometry.attributes.aPos.array : []).join(',');
    inst.dispose();
    return arr + '|' + motes;
  };
  const a1 = firstFrame(42), a2 = firstFrame(42), b = firstFrame(43);
  assert(a1 === a2, 'same seed diverged between two casts');
  assert(a1 !== b, 'different seeds produced identical geometry');
  fx.dispose();
});

check('the ring seam closes for a blade-mode palette (even harmonic by construction)', () => {
  const th = (x, z) => Math.sin(x) * 0.15;
  const { deps } = makeDeps(th);
  const fx = createAuraFx(deps, { segments: 24, heightSegs: 5 });
  const inst = fx.cast({ line: selfLine(th), seed: 6, palette: 'charge', sourceY: 1 });
  const geo = inst.group.children[0].geometry;
  const pos = geo.getAttribute('position');
  const rows = 6;
  const last = (pos.count / rows - 1) * rows;
  assert(Math.hypot(pos.getX(0) - pos.getX(last), pos.getZ(0) - pos.getZ(last)) < 1e-9, 'seam positions differ');
  inst.dispose();
  fx.dispose();
});

check('update is allocation-stable and survives a zero-power, zero-crackle, zero-burst palette', () => {
  const { deps } = makeDeps();
  const fx = createAuraFx(deps, { motesBurst: 0 });
  const inst = fx.cast({ line: selfLine(), seed: 1, palette: 'growth', power: 0.01, sourceY: 1 });
  let alive = true;
  for (let i = 0; i < 200 && alive; i++) alive = inst.update(1 / 60, i / 60);
  inst.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
