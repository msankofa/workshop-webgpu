import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createRingFx, PALETTES } from './moves/fx-ring.js';

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
const terrainHeight = (x, z) => Math.sin(x * 0.3) * 0.2 + Math.cos(z * 0.25) * 0.15;

function makeDeps({ noLights = false } = {}) {
  const scene = new THREE.Scene();
  const pool = [];
  const busy = new Set();
  const lights = noLights ? { acquire: () => null, release: () => {} } : {
    acquire() { const l = new THREE.PointLight(); pool.push(l); busy.add(l); scene.add(l); return l; },
    release(l) { busy.delete(l); const i = pool.indexOf(l); if (i >= 0) pool.splice(i, 1); },
  };
  return { deps: { THREE, TSL, NODES, scene, terrainHeight, lights }, scene, pool };
}
// Hazard line (fx-crystals-style, real length): attacker to target.
const hazardLine = () => makeLine({ from: { x: 0, z: 0 }, to: { x: 6, z: 3 }, terrainHeight });
// Self-cast line: castMove clamps `to` to `from`, so this is what a real self move hands in.
const selfLine = () => makeLine({ from: { x: 2, z: -1 }, to: { x: 2, z: -1 }, terrainHeight });

// Read a raw instance matrix: Matrix4.decompose() reports scale 1 for a zero matrix, so read the array.
const yScale = (mesh, i) => {
  const a = mesh.instanceMatrix.array, o = i * 16;
  return Math.hypot(a[o + 4], a[o + 5], a[o + 6]);
};
const posOf = (mesh, i) => {
  const a = mesh.instanceMatrix.array, o = i * 16;
  return { x: a[o + 12], y: a[o + 13], z: a[o + 14] };
};

function run(inst, steps = 500) {
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

check('a hazard cast (centre: target) travels, impacts once, and finishes', () => {
  const { deps, scene } = makeDeps();
  const fx = createRingFx(deps);
  const inst = fx.cast({ line: hazardLine(), seed: 7, palette: 'stone', power: 1 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  assert(inst.machine.phase === Phase.TRAVEL, `phase ${inst.machine.phase}`);
  const r = run(inst);
  assert(r.impacts === 1, `impacts ${r.impacts}`);
  assert(r.dones === 1, `dones ${r.dones}`);
  assert(inst.machine.phase === Phase.DONE, `end phase ${inst.machine.phase}`);
  assert(r.aliveFrames > 30, `finished too fast: ${r.aliveFrames} frames`);
  assert(inst.update(1 / 60, 99) === false, 'update after done should be false');
  inst.dispose(); fx.dispose();
});

check('every palette casts, builds instanced spikes, and completes exactly once', () => {
  for (const name of Object.keys(PALETTES)) {
    const { deps } = makeDeps();
    const fx = createRingFx(deps);
    const pal = PALETTES[name];
    const line = pal.centre === 'origin' ? selfLine() : hazardLine();
    const inst = fx.cast({ line, seed: 3, palette: name, power: 1.2 });
    const meshes = inst.group.children.filter((c) => c.isInstancedMesh);
    assert(meshes.length >= 3, `${name}: ${meshes.length} instanced meshes (want >= crystal variants + chips)`);
    assert(meshes.every((m) => m.count > 0 && m.frustumCulled === false), `${name}: bad instanced mesh setup`);
    const r = run(inst);
    assert(r.impacts === 1 && r.dones === 1, `${name}: ${r.impacts}/${r.dones}`);
    inst.dispose(); fx.dispose();
  }
});

check('spikes are placed on a ring around the resolved centre, not along a line', () => {
  const { deps } = makeDeps();
  const fx = createRingFx(deps);
  const inst = fx.cast({ line: hazardLine(), seed: 11, palette: 'stone', power: 1 });
  // Force every spike up so the whole ring is standing, then check the spread of local radii is tight.
  let t = 0;
  for (let i = 0; i < 200; i++) { t += 1 / 60; if (!inst.update(1 / 60, t)) break; if (inst.machine.phase !== Phase.TRAVEL) break; }
  const mesh = inst.group.children.find((c) => c.isInstancedMesh);
  let minR = Infinity, maxR = 0, n = 0;
  for (let i = 0; i < mesh.count; i++) {
    if (yScale(mesh, i) <= 1e-3) continue;
    const p = posOf(mesh, i);
    const r = Math.hypot(p.x, p.z); // local to the group, which sits at the ring centre
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); n++;
  }
  assert(n > 0, 'nothing erupted yet');
  assert(minR > 0.3 && maxR < 2.2, `radii out of expected ring band: ${minR}..${maxR}`);
  inst.dispose(); fx.dispose();
});

check('a self cast (centre: origin) uses the caster position and does not stall on a near-zero line', () => {
  const { deps, scene } = makeDeps();
  const fx = createRingFx(deps);
  const inst = fx.cast({ line: selfLine(), seed: 5, palette: 'steel', power: 1 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  const r = run(inst, 800);
  assert(r.impacts === 1 && r.dones === 1, `self cast did not complete: ${r.impacts}/${r.dones} in ${r.aliveFrames} frames`);
  assert(r.aliveFrames < 700, `self cast took implausibly long: ${r.aliveFrames} frames`);
  inst.dispose(); fx.dispose();
});

check('spikes erupt progressively as the sweep passes their ring angle', () => {
  const { deps } = makeDeps();
  const fx = createRingFx(deps);
  const inst = fx.cast({ line: hazardLine(), seed: 11, palette: 'toxic', power: 1 });
  const mesh = inst.group.children.find((c) => c.isInstancedMesh);
  const scaled = () => { let n = 0; for (let i = 0; i < mesh.count; i++) if (yScale(mesh, i) > 1e-3) n++; return n; };
  assert(scaled() === 0, 'spikes were standing before the sweep reached them');
  let t = 0;
  for (let i = 0; i < 10; i++) { t += 1 / 60; inst.update(1 / 60, t); }
  const early = scaled();
  for (let i = 0; i < 40; i++) { t += 1 / 60; inst.update(1 / 60, t); }
  assert(scaled() >= early, `field did not keep growing (${early} then ${scaled()})`);
  inst.dispose(); fx.dispose();
});

check('the field sinks below the ground during the fade', () => {
  const { deps } = makeDeps();
  const fx = createRingFx(deps);
  const inst = fx.cast({ line: hazardLine(), seed: 5, palette: 'stone', power: 1 });
  const mesh = inst.group.children.find((c) => c.isInstancedMesh);
  const lowest = () => { let y = Infinity; for (let i = 0; i < mesh.count; i++) if (yScale(mesh, i) > 1e-3) y = Math.min(y, posOf(mesh, i).y); return y; };
  let t = 0, standing = Infinity;
  for (let i = 0; i < 500; i++) {
    t += 1 / 60;
    if (inst.machine.phase === Phase.IMPACT && standing === Infinity) standing = lowest();
    if (!inst.update(1 / 60, t)) break;
  }
  const sunk = lowest();
  assert(Number.isFinite(standing), 'never reached the standing phase');
  assert(sunk < standing - 0.3, `field did not retract: ${standing} -> ${sunk}`);
  inst.dispose(); fx.dispose();
});

check('a held cast parks in IMPACT and only fades after release()', () => {
  const { deps } = makeDeps();
  const fx = createRingFx(deps, { holdTime: 0.1 }); // short natural hold, so release is the only reason it lingers
  const inst = fx.cast({ line: hazardLine(), seed: 6, palette: 'toxic', power: 1 });
  inst.machine.hold = true; inst.machine.maxHold = 50; // as the harness sets it for a registry `hold: true` move
  let t = 0;
  for (let i = 0; i < 200; i++) { t += 1 / 60; inst.update(1 / 60, t); }
  assert(inst.machine.phase === Phase.IMPACT, `expected to be held in IMPACT, got ${inst.machine.phase}`);
  inst.machine.release();
  const r = run(inst, 300);
  assert(r.dones === 1, 'held cast never finished after release');
  inst.dispose(); fx.dispose();
});

check('web is pegs joined by strands; other palettes carry no strand mesh', () => {
  const { deps } = makeDeps();
  const fx = createRingFx(deps);
  const web = fx.cast({ line: hazardLine(), seed: 2, palette: 'web', power: 1 });
  const stone = fx.cast({ line: hazardLine(), seed: 2, palette: 'stone', power: 1 });
  const webMeshCount = web.group.children.filter((c) => c.isInstancedMesh).length;
  const stoneMeshCount = stone.group.children.filter((c) => c.isInstancedMesh).length;
  assert(webMeshCount === stoneMeshCount + 1, `web should carry exactly one extra instanced mesh (strands): web=${webMeshCount} stone=${stoneMeshCount}`);
  run(web); run(stone);
  web.dispose(); stone.dispose(); fx.dispose();
});

check('lights: toxic and glass acquire one, stone/web/steel acquire none, always released', () => {
  for (const [name, expect] of [['stone', 0], ['toxic', 1], ['web', 0], ['steel', 0], ['glass', 1]]) {
    const { deps, pool } = makeDeps();
    const fx = createRingFx(deps);
    const pal = PALETTES[name];
    const line = pal.centre === 'origin' ? selfLine() : hazardLine();
    const inst = fx.cast({ line, seed: 2, palette: name });
    assert(pool.length === expect, `${name}: acquired ${pool.length}, wanted ${expect}`);
    run(inst);
    assert(pool.length === 0, `${name}: light not released on done`);
    inst.dispose(); fx.dispose();
  }
});

check('lights.acquire() returning null never throws', () => {
  const { deps } = makeDeps({ noLights: true });
  const fx = createRingFx(deps);
  for (const name of ['toxic', 'glass']) {
    const pal = PALETTES[name];
    const line = pal.centre === 'origin' ? selfLine() : hazardLine();
    const inst = fx.cast({ line, seed: 1, palette: name });
    run(inst);
    inst.dispose();
  }
  fx.dispose();
});

check('the same seed builds the same field and a different one does not', () => {
  const { deps } = makeDeps();
  const fx = createRingFx(deps);
  const grab = (seed) => {
    const inst = fx.cast({ line: hazardLine(), seed, palette: 'toxic', power: 1 });
    for (let i = 0, t = 0; i < 20; i++) { t += 1 / 60; inst.update(1 / 60, t); }
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

check('first-frame transforms are identical for the same seed (determinism on frame one)', () => {
  const { deps } = makeDeps();
  const fx = createRingFx(deps);
  const first = (seed) => {
    const inst = fx.cast({ line: hazardLine(), seed, palette: 'steel', power: 1 });
    inst.update(1 / 60, 1 / 60);
    const mesh = inst.group.children.find((c) => c.isInstancedMesh);
    const out = Array.from(mesh.instanceMatrix.array);
    inst.dispose();
    return out;
  };
  const a = first(9), b = first(9);
  assert(a.join() === b.join(), 'first-frame transforms diverged for the same seed');
  fx.dispose();
});

check('chips pop at each breach', () => {
  const { deps } = makeDeps();
  const fx = createRingFx(deps, { chipLife: 0.5 });
  const inst = fx.cast({ line: hazardLine(), seed: 4, palette: 'stone', power: 1 });
  const chips = inst.group.children[inst.group.children.length - 1];
  const live = () => { let n = 0; for (let i = 0; i < chips.count; i++) if (yScale(chips, i) > 1e-4) n++; return n; };
  assert(live() === 0, 'chips existed before anything erupted');
  let t = 0, peak = 0;
  for (let i = 0; i < 60; i++) { t += 1 / 60; inst.update(1 / 60, t); peak = Math.max(peak, live()); }
  assert(peak > 0, 'no chips were thrown by the eruptions');
  run(inst, 400);
  inst.dispose(); fx.dispose();
});

check('dispose detaches the group and releases the light mid-cast', () => {
  const { deps, scene, pool } = makeDeps();
  const fx = createRingFx(deps);
  const inst = fx.cast({ line: hazardLine(), seed: 9, palette: 'toxic' });
  const before = inst.group.children.length;
  assert(before > 0, 'group has no children right after cast');
  for (let i = 0, t = 0; i < 20; i++) { t += 1 / 60; inst.update(1 / 60, t); }
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group still in the scene');
  assert(pool.length === 0, 'light still held');
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
