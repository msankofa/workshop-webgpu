import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createSkyfallFx, PALETTES } from './moves/fx-skyfall.js';

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

function makeDeps(lightsOverride) {
  const scene = new THREE.Scene();
  const pool = [];
  const lights = lightsOverride || {
    acquire() { const l = new THREE.PointLight(); pool.push(l); scene.add(l); return l; },
    release(l) { const i = pool.indexOf(l); if (i >= 0) pool.splice(i, 1); },
  };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight, lights }, scene, pool };
}
const line = () => makeLine({ from: { x: 0, z: 0 }, to: { x: 9, z: 4 }, terrainHeight });

function readInstance(mesh, i) {
  const a = mesh.instanceMatrix.array, o = i * 16;
  return { x: a[o + 12], y: a[o + 13], z: a[o + 14], scale: Math.hypot(a[o + 4], a[o + 5], a[o + 6]) };
}
function bodyMeshes(inst) { return inst.group.children.filter((c) => c.userData.kind === 'body'); }
function kindMesh(inst, kind) { return inst.group.children.find((c) => c.userData.kind === kind); }

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
  const fx = createSkyfallFx(deps);
  const inst = fx.cast({ line: line(), seed: 7, palette: 'stone', power: 1 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  assert(inst.group.children.length > 0, 'group has no children after cast');
  assert(inst.machine.phase === Phase.TRAVEL, `phase ${inst.machine.phase}`);
  const r = run(inst);
  assert(r.impacts === 1, `impacts ${r.impacts}`);
  assert(r.dones === 1, `dones ${r.dones}`);
  assert(inst.machine.phase === Phase.DONE, `end phase ${inst.machine.phase}`);
  assert(r.aliveFrames > 60, `finished too fast: ${r.aliveFrames} frames`);
  assert(inst.update(1 / 60, 99) === false, 'update after done should be false');
  inst.dispose(); fx.dispose();
});

check('every palette casts and builds instanced falling bodies', () => {
  for (const name of Object.keys(PALETTES)) {
    const { deps } = makeDeps();
    const fx = createSkyfallFx(deps);
    const inst = fx.cast({ line: line(), seed: 3, palette: name, power: 1.2 });
    const meshes = bodyMeshes(inst);
    assert(meshes.length >= 3, `${name}: ${meshes.length} body meshes`);
    assert(meshes.every((m) => m.count > 0 && m.frustumCulled === false), `${name}: bad instanced mesh setup`);
    const r = run(inst);
    assert(r.impacts === 1 && r.dones === 1, `${name}: ${r.impacts}/${r.dones}`);
    inst.dispose(); fx.dispose();
  }
});

check('bodies stay hidden until the front launches them, then fall from above the ground', () => {
  const { deps } = makeDeps();
  const fx = createSkyfallFx(deps);
  const inst = fx.cast({ line: line(), seed: 11, palette: 'stone', power: 1 });
  const meshes = bodyMeshes(inst);
  const active = () => {
    const out = [];
    for (const mesh of meshes) for (let i = 0; i < mesh.count; i++) { const s = readInstance(mesh, i); if (s.scale > 1e-3) out.push(s); }
    return out;
  };
  assert(active().length === 0, 'bodies were falling before the front reached them');
  let t = 0;
  // Long enough to clear the front's travel to the nearest bodies plus their full launch stagger window.
  for (let i = 0; i < 45; i++) { t += 1 / 60; inst.update(1 / 60, t); }
  const early = active();
  assert(early.length > 0, 'nothing launched behind the front');
  // A falling body must start above its own landing point's terrain height, not at or below it.
  for (const s of early) assert(s.y > terrainHeight(s.x, s.z) + 0.05, `body below ground while still falling: y=${s.y}`);
  inst.dispose(); fx.dispose();
});

check('a falling body lands at its own terrain height and later sinks below it during fade', () => {
  const { deps } = makeDeps();
  const fx = createSkyfallFx(deps);
  const inst = fx.cast({ line: line(), seed: 5, palette: 'ice', power: 1 });
  const meshes = bodyMeshes(inst);
  const active = () => {
    const out = [];
    for (const mesh of meshes) for (let i = 0; i < mesh.count; i++) { const s = readInstance(mesh, i); if (s.scale > 1e-3) out.push(s); }
    return out;
  };
  let t = 0, sawLanded = false, sawSunk = false;
  for (let i = 0; i < 400; i++) {
    t += 1 / 60;
    if (!inst.update(1 / 60, t)) break;
    if (inst.machine.phase === Phase.IMPACT) {
      for (const s of active()) if (Math.abs(s.y - terrainHeight(s.x, s.z)) < 0.35) sawLanded = true;
    }
    if (inst.machine.phase === Phase.FADE) {
      for (const s of active()) if (s.y < terrainHeight(s.x, s.z) - 0.3) sawSunk = true;
    }
  }
  assert(sawLanded, 'no body ever settled near its own terrain height');
  assert(sawSunk, 'no body sank below ground during the fade');
  inst.dispose(); fx.dispose();
});

check('chips and dust appear once bodies start landing', () => {
  const { deps } = makeDeps();
  const fx = createSkyfallFx(deps, { chipLife: 0.5 });
  const inst = fx.cast({ line: line(), seed: 4, palette: 'gem', power: 1 });
  const chipMesh = kindMesh(inst, 'chip');
  const dustMesh = kindMesh(inst, 'dust');
  assert(chipMesh && dustMesh, 'chip or dust mesh missing from the group');
  const chipsLive = () => { let n = 0; for (let i = 0; i < chipMesh.count; i++) if (readInstance(chipMesh, i).scale > 1e-4) n++; return n; };
  let t = 0, peakChips = 0, peakDust = 0;
  for (let i = 0; i < 400; i++) {
    t += 1 / 60;
    if (!inst.update(1 / 60, t)) break;
    peakChips = Math.max(peakChips, chipsLive());
    peakDust = Math.max(peakDust, dustMesh.geometry.instanceCount);
  }
  assert(peakChips > 0, 'no chips were thrown at any landing');
  assert(peakDust > 0, 'no dust puffs were emitted at any landing');
  inst.dispose(); fx.dispose();
});

check('meteor gets a trail and a bounded number of decals; other palettes still get decals but no trail', () => {
  for (const name of Object.keys(PALETTES)) {
    const { deps } = makeDeps();
    const fx = createSkyfallFx(deps);
    const inst = fx.cast({ line: line(), seed: 6, palette: name, power: 1 });
    const trailMesh = kindMesh(inst, 'trail');
    const decalMeshes = inst.group.children.filter((c) => c.userData.kind === 'decal');
    assert((trailMesh != null) === (name === 'meteor'), `${name}: trail presence ${trailMesh != null}`);
    assert(decalMeshes.length <= 3, `${name}: too many decals (${decalMeshes.length})`);
    inst.dispose(); fx.dispose();
  }
});

check('lights are acquired only for meteor, budgeted at two, and always released', () => {
  for (const [name, maxExpect] of [['stone', 0], ['ice', 0], ['meteor', 2], ['gem', 0]]) {
    const { deps, pool } = makeDeps();
    const fx = createSkyfallFx(deps);
    const inst = fx.cast({ line: line(), seed: 2, palette: name, power: 1 });
    assert(pool.length <= maxExpect, `${name}: acquired ${pool.length}, budget ${maxExpect}`);
    if (name === 'meteor') assert(pool.length > 0, 'meteor acquired no lights at all');
    run(inst);
    assert(pool.length === 0, `${name}: light not released on done`);
    inst.dispose(); fx.dispose();
  }
});

check('a null light pool never throws and still finishes cleanly', () => {
  const nullLights = { acquire: () => null, release: () => {} };
  const { deps } = makeDeps(nullLights);
  const fx = createSkyfallFx(deps);
  const inst = fx.cast({ line: line(), seed: 8, palette: 'meteor', power: 1 });
  const r = run(inst);
  assert(r.impacts === 1 && r.dones === 1, `meteor with no lights: ${r.impacts}/${r.dones}`);
  inst.dispose(); fx.dispose();
});

check('the main (largest) body fires onImpact exactly once', () => {
  const { deps } = makeDeps();
  const fx = createSkyfallFx(deps);
  const inst = fx.cast({ line: line(), seed: 13, palette: 'meteor', power: 1 });
  const r = run(inst);
  assert(r.impacts === 1, `expected exactly one onImpact, got ${r.impacts}`);
  inst.dispose(); fx.dispose();
});

check('the same seed builds the same field and a different one does not', () => {
  const { deps } = makeDeps();
  const fx = createSkyfallFx(deps);
  const grab = (seed) => {
    const inst = fx.cast({ line: line(), seed, palette: 'stone', power: 1 });
    for (let i = 0, t = 0; i < 90; i++) { t += 1 / 60; inst.update(1 / 60, t); }
    const mesh = bodyMeshes(inst)[0];
    const out = Array.from(mesh.instanceMatrix.array);
    inst.dispose();
    return out;
  };
  const a = grab(42), b = grab(42), c = grab(43);
  assert(a.join() === b.join(), 'same seed diverged');
  assert(a.join() !== c.join(), 'different seeds matched');
  fx.dispose();
});

check('dispose detaches the group and releases lights mid-cast', () => {
  const { deps, scene, pool } = makeDeps();
  const fx = createSkyfallFx(deps);
  const inst = fx.cast({ line: line(), seed: 9, palette: 'meteor' });
  for (let i = 0, t = 0; i < 20; i++) { t += 1 / 60; inst.update(1 / 60, t); }
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group still in the scene');
  assert(pool.length === 0, 'light still held');
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
