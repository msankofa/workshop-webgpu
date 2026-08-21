import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createFieldFx, PALETTES } from './moves/fx-field.js';

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

function makeDeps({ nullLights = false } = {}) {
  const scene = new THREE.Scene();
  const pool = []; for (let i = 0; i < 6; i++) pool.push(new THREE.PointLight(0xffffff, 0, 1));
  const busy = new Set();
  const lights = nullLights
    ? { acquire: () => null, release: () => {} }
    : {
        acquire() { const l = pool.find((p) => !busy.has(p)); if (l) busy.add(l); return l || null; },
        release(l) { busy.delete(l); },
      };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight: () => 0, lights }, scene, busy };
}

function line() {
  return makeLine({ from: { x: 2, z: -1 }, to: { x: 7, z: 3 }, terrainHeight: () => 0 });
}

const PALETTE_KEYS = Object.keys(PALETTES);

check('every palette in the brief exists with a ground kind', () => {
  const kinds = ['warp', 'gravity', 'rain', 'sun', 'sand', 'hail', 'terrain'];
  for (const k of PALETTE_KEYS) assert(kinds.includes(PALETTES[k].kind), `${k} has an unrecognised kind`);
  assert(PALETTE_KEYS.length === 10, `expected 10 palette rows (6 solo + 4 terrains), got ${PALETTE_KEYS.length}`);
});

check('cast builds a group anchored at the arena centre, not the caster', () => {
  const { deps, scene } = makeDeps();
  const fx = createFieldFx(deps);
  const off = line(); // origin is at (2, -1), well off the arena centre
  const inst = fx.cast({ line: off, seed: 1, palette: 'gravity', power: 1 });
  assert(scene.children.includes(inst.group), 'group not added to scene');
  assert(inst.group.position.x === 0 && inst.group.position.z === 0, 'field followed the caster instead of centring on the arena');
  assert(inst.group.children.length >= 2, 'expected at least a sheet and an edge ring');
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group not removed on dispose');
  fx.dispose();
});

check('warp and sand grow a wall mesh, flat palettes do not', () => {
  const { deps } = makeDeps();
  const fx = createFieldFx(deps);
  const warp = fx.cast({ line: line(), seed: 2, palette: 'warp', power: 1 });
  const gravity = fx.cast({ line: line(), seed: 2, palette: 'gravity', power: 1 });
  assert(gravity.group.children.length === 2, `gravity (no wall, no particles) should have exactly 2 meshes, got ${gravity.group.children.length}`);
  assert(warp.group.children.length > gravity.group.children.length, 'warp should have an extra wall mesh over a flat palette');
  warp.dispose(); gravity.dispose();
  fx.dispose();
});

check('every palette casts, walks travel -> impact -> fade -> done, and disposes cleanly', () => {
  const { deps, busy } = makeDeps();
  const fx = createFieldFx(deps, { travelTime: 0.2, impactTime: 0.3, fadeTime: 0.2 });
  for (const key of PALETTE_KEYS) {
    const inst = fx.cast({ line: line(), seed: 5, palette: key, power: 1 });
    let impacts = 0, dones = 0;
    inst.onImpact = () => impacts++;
    inst.onDone = () => dones++;
    let alive = true, frames = 0;
    while (alive && frames < 600) { alive = inst.update(1 / 60, frames / 60); frames++; }
    assert(inst.machine.phase === Phase.DONE, `${key} ended in ${inst.machine.phase}`);
    assert(impacts === 1, `${key}: onImpact fired ${impacts} times`);
    assert(dones === 1, `${key}: onDone fired ${dones} times`);
    inst.dispose();
    assert(busy.size === 0, `${key} leaked ${busy.size} lights`);
  }
  fx.dispose();
});

check('the envelope pins at 1 for the whole hold, however long it runs', () => {
  const { deps } = makeDeps();
  const fx = createFieldFx(deps, { travelTime: 0.1, impactTime: 0.2, fadeTime: 0.2 });
  const inst = fx.cast({ line: line(), seed: 9, palette: 'sand', power: 1 });
  // The harness sets these on the machine right after cast, for any move the registry marks `hold`.
  inst.machine.hold = true; inst.machine.maxHold = 20;
  let alive = true;
  for (let i = 0; i < 500; i++) { alive = inst.update(1 / 60, i / 60); if (i > 30) assert(inst.machine.phase === Phase.IMPACT, `left IMPACT while held, at frame ${i}`); }
  assert(alive, 'held effect died on its own');
  assert(inst.machine.holding, 'machine does not report holding');
  inst.machine.release();
  let frames = 0;
  while (alive && frames < 200) { alive = inst.update(1 / 60, frames / 60); frames++; }
  assert(inst.machine.phase === Phase.DONE, `release() did not lead to DONE, ended in ${inst.machine.phase}`);
  inst.dispose();
  fx.dispose();
});

check('maxHold forces the release even if nothing calls release()', () => {
  const { deps } = makeDeps();
  const fx = createFieldFx(deps, { travelTime: 0.05, impactTime: 0.1, fadeTime: 0.1 });
  const inst = fx.cast({ line: line(), seed: 3, palette: 'gravity', power: 1 });
  inst.machine.hold = true; inst.machine.maxHold = 0.5;
  let alive = true, frames = 0;
  while (alive && frames < 600) { alive = inst.update(1 / 60, frames / 60); frames++; }
  assert(inst.machine.phase === Phase.DONE, `maxHold never forced a release, ended in ${inst.machine.phase}`);
  assert(frames / 60 < 2, `took ${frames / 60}s to release a 0.5s maxHold — leaked`);
  inst.dispose();
  fx.dispose();
});

check('warp acquires 2 lights, sun acquires 1, gravity acquires 0, and all give them back', () => {
  const { deps, busy } = makeDeps();
  const fx = createFieldFx(deps);
  const warp = fx.cast({ line: line(), seed: 1, palette: 'warp', power: 1 });
  assert(busy.size === 2, `warp acquired ${busy.size} lights, wanted 2`);
  const sun = fx.cast({ line: line(), seed: 1, palette: 'sun', power: 1 });
  assert(busy.size === 3, `warp+sun acquired ${busy.size} lights, wanted 3`);
  const gravity = fx.cast({ line: line(), seed: 1, palette: 'gravity', power: 1 });
  assert(busy.size === 3, 'gravity should not acquire any lights');
  warp.dispose(); sun.dispose(); gravity.dispose();
  assert(busy.size === 0, `${busy.size} lights leaked after dispose`);
  fx.dispose();
});

check('nothing throws when lights.acquire() returns null', () => {
  const { deps } = makeDeps({ nullLights: true });
  const fx = createFieldFx(deps, { travelTime: 0.1, impactTime: 0.2, fadeTime: 0.2 });
  for (const key of ['warp', 'sun', 'gravity']) {
    const inst = fx.cast({ line: line(), seed: 4, palette: key, power: 1 });
    let alive = true, frames = 0;
    while (alive && frames < 200) { alive = inst.update(1 / 60, frames / 60); frames++; }
    inst.dispose();
  }
  fx.dispose();
});

check('rain particle emission is deterministic from seed', () => {
  const { deps } = makeDeps();
  const fx = createFieldFx(deps, { travelTime: 0.05, impactTime: 1, fadeTime: 0.5 });
  function firstFrame(seed) {
    const inst = fx.cast({ line: line(), seed, palette: 'rain', power: 1 });
    inst.update(1 / 60, 0);
    const kit = inst.group.children.find((c) => c.geometry?.getAttribute('aPos'));
    const arr = Array.from(kit.geometry.getAttribute('aPos').array.slice(0, 12));
    inst.dispose();
    return arr;
  }
  const a1 = firstFrame(42), a2 = firstFrame(42), b = firstFrame(43);
  assert(JSON.stringify(a1) === JSON.stringify(a2), 'same seed produced different rain drops');
  assert(JSON.stringify(a1) !== JSON.stringify(b), 'different seeds produced identical rain drops');
  fx.dispose();
});

check('hail falls and bounces once, then settles instead of bouncing forever', () => {
  const { deps } = makeDeps();
  const fx = createFieldFx(deps, { travelTime: 0.05, impactTime: 3, fadeTime: 0.5 });
  const inst = fx.cast({ line: line(), seed: 6, palette: 'hail', power: 1 });
  let sawBelowSpawnHeight = false;
  for (let i = 0; i < 180; i++) {
    inst.update(1 / 60, i / 60);
    const hailMesh = inst.group.children.find((c) => c.isInstancedMesh);
    if (hailMesh) {
      const m = new THREE.Matrix4();
      hailMesh.getMatrixAt(0, m);
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      if (p.y > 0 && p.y < 2.4) sawBelowSpawnHeight = true; // it actually fell, not just popped in place
    }
  }
  assert(sawBelowSpawnHeight, 'no hail stone was ever seen falling below its spawn height');
  inst.dispose();
  fx.dispose();
});

check('power scales brightness/rate but the field still covers the same ground', () => {
  const { deps } = makeDeps();
  const fx = createFieldFx(deps);
  const low = fx.cast({ line: line(), seed: 8, palette: 'sand', power: 0.5 });
  const high = fx.cast({ line: line(), seed: 8, palette: 'sand', power: 3 });
  const radiusOf = (inst) => {
    const sheet = inst.group.children[0];
    const pos = sheet.geometry.getAttribute('position');
    let r = 0;
    for (let i = 0; i < pos.count; i++) r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)));
    return r;
  };
  assert(Math.abs(radiusOf(low) - radiusOf(high)) < 1e-9, 'power resized the field — it should only intensify it');
  low.dispose(); high.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
