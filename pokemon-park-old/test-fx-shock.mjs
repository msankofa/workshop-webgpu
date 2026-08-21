import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createShockFx, PALETTES } from './moves/fx-shock.js';

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

function makeDeps() {
  const pool = [];
  const scene = new THREE.Scene();
  for (let i = 0; i < 6; i++) { const l = new THREE.PointLight(); scene.add(l); pool.push(l); }
  const free = pool.slice();
  return {
    deps: { THREE, TSL, NODES, scene, terrainHeight, lights: { acquire: () => free.pop() || null, release: (l) => free.push(l) } },
    scene, pool, free,
  };
}

const line = () => makeLine({ from: { x: -4, z: 1 }, to: { x: 6, z: -3 }, terrainHeight, step: 0.2 });

function runToDone(inst, maxFrames = 500) {
  let alive = true, frames = 0;
  while (alive && frames < maxFrames) { alive = inst.update(1 / 60, frames / 60); frames++; }
  return frames;
}

check('a cast runs travel -> impact -> fade -> done exactly once', () => {
  const { deps, scene } = makeDeps();
  const fx = createShockFx(deps);
  const inst = fx.cast({ line: line(), seed: 7, palette: 'blast', power: 1 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  assert(inst.group.children.length > 0, 'group should gain children at cast');
  let impacts = 0, dones = 0;
  inst.onImpact = () => impacts++;
  inst.onDone = () => dones++;
  let alive = true, frames = 0, sawTravel = false, sawFade = false;
  while (alive && frames < 500) {
    alive = inst.update(1 / 60, frames / 60);
    if (inst.machine.phase === Phase.TRAVEL) sawTravel = true;
    if (inst.machine.phase === Phase.FADE) sawFade = true;
    frames++;
  }
  assert(sawTravel && sawFade, 'never travelled or faded');
  assert(inst.machine.phase === Phase.DONE, `ended in ${inst.machine.phase}`);
  assert(impacts === 1 && dones === 1, `impacts=${impacts} dones=${dones}`);
  assert(inst.update(1 / 60, 10) === false, 'update after done should stay false');
  inst.dispose();
  assert(!scene.children.includes(inst.group), 'group still in the scene after dispose');
  fx.dispose();
});

check('every palette casts, runs to done, and builds its node graphs', () => {
  for (const name of Object.keys(PALETTES)) {
    if (name === 'default') continue;
    const { deps } = makeDeps();
    const fx = createShockFx(deps);
    const inst = fx.cast({ line: line(), seed: 3, palette: name, power: 1.3 });
    runToDone(inst);
    assert(inst.machine.phase === Phase.DONE, `${name} did not finish`);
    inst.dispose();
    fx.dispose();
  }
});

check('the ring carries its shader attributes and advances during travel', () => {
  const { deps } = makeDeps();
  const fx = createShockFx(deps);
  const inst = fx.cast({ line: line(), seed: 11, palette: 'blast', power: 1 });
  const ring = inst.group.children.find((c) => c.isMesh && c.geometry.getAttribute('aDir'));
  for (const a of ['aDir', 'aV', 'aTerrainY', 'aColJit']) assert(ring.geometry.getAttribute(a), `missing attribute ${a}`);
  let front = 0;
  for (let i = 0; i < 10; i++) { inst.update(1 / 60, i / 60); front = Math.max(front, inst.machine.u); }
  assert(front > 0 && front < 1, `front should be mid-flight, u=${front}`);
  inst.dispose();
  fx.dispose();
});

check('sonic draws several rings off one shared geometry', () => {
  const { deps } = makeDeps();
  const fx = createShockFx(deps);
  const inst = fx.cast({ line: line(), seed: 5, palette: 'sonic', power: 1 });
  const rings = inst.group.children.filter((c) => c.isMesh && c.geometry.getAttribute('aDir'));
  assert(rings.length === PALETTES.sonic.ringCount, `expected ${PALETTES.sonic.ringCount} ring meshes, got ${rings.length}`);
  const geos = new Set(rings.map((r) => r.geometry));
  assert(geos.size === 1, 'sonic should draw its rings off one shared geometry, not N copies');
  inst.dispose();
  fx.dispose();
});

check('quake grows radial cracks that are revealed by the same expanding radius', () => {
  const { deps } = makeDeps();
  const fx = createShockFx(deps);
  const inst = fx.cast({ line: line(), seed: 9, palette: 'quake', power: 1 });
  const crack = inst.group.children.find((c) => c.isMesh && c.geometry.getAttribute('aDist'));
  assert(crack, 'quake should build a crack mesh');
  assert(crack.geometry.getAttribute('aTaper'), 'crack ribbon missing aTaper');
  const dist = crack.geometry.getAttribute('aDist');
  let maxDist = 0;
  for (let i = 0; i < dist.count; i++) maxDist = Math.max(maxDist, dist.getX(i));
  assert(maxDist > 0.5, 'cracks should reach well past the centre');
  inst.dispose();
  fx.dispose();
});

check('same seed gives the same ring jitter and debris path, different seeds do not', () => {
  const { deps } = makeDeps();
  const fx = createShockFx(deps);
  const jitOf = (seed) => {
    const inst = fx.cast({ line: line(), seed, palette: 'quake', power: 1 });
    const ring = inst.group.children.find((c) => c.isMesh && c.geometry.getAttribute('aColJit'));
    const jit = Array.from(ring.geometry.getAttribute('aColJit').array);
    for (let i = 0; i < 20; i++) inst.update(1 / 60, i / 60);
    const debris = inst.group.children.find((c) => c.isInstancedMesh && c !== ring);
    const m = new THREE.Matrix4();
    debris.getMatrixAt(0, m);
    inst.dispose();
    return { jit, firstDebris: m.elements.slice() };
  };
  const a = jitOf(42), b = jitOf(42), c = jitOf(43);
  assert(a.jit.every((v, i) => v === b.jit[i]), 'seed 42 ring jitter was not reproducible');
  assert(a.firstDebris.every((v, i) => v === b.firstDebris[i]), 'seed 42 debris motion was not reproducible');
  assert(a.jit.some((v, i) => v !== c.jit[i]), 'seed 43 ring jitter matched seed 42');
  fx.dispose();
});

check('the ring radius stays inside its capped reach, and power grows it up to that cap', () => {
  const { deps } = makeDeps();
  const fx = createShockFx(deps);
  const weak = fx.cast({ line: line(), seed: 1, palette: 'wave', power: 0.2 });
  const strong = fx.cast({ line: line(), seed: 1, palette: 'wave', power: 5 });
  assert(weak.reach < strong.reach, 'higher power should reach further');
  assert(strong.reach <= PALETTES.wave.maxRadius + 1e-6, `reach should be capped at maxRadius: ${strong.reach}`);
  weak.dispose(); strong.dispose();
  fx.dispose();
});

check('lights are acquired for a palette that wants them and fully released on dispose', () => {
  const { deps, free } = makeDeps();
  const startFree = free.length;
  const fx = createShockFx(deps);
  const inst = fx.cast({ line: line(), seed: 2, palette: 'blast', power: 1 });
  assert(free.length === startFree - PALETTES.blast.lightCount, `expected ${PALETTES.blast.lightCount} lights acquired`);
  runToDone(inst);
  inst.dispose();
  assert(free.length === startFree, `lights leaked: ${free.length} of ${startFree}`);
  fx.dispose();
});

check('a palette with no free lights, and one with lightGain 0, never throw', () => {
  const scene = new THREE.Scene();
  const depsNoLights = { THREE, TSL, NODES, scene, terrainHeight, lights: { acquire: () => null, release: () => {} } };
  const fx = createShockFx(depsNoLights);
  const inst = fx.cast({ line: line(), seed: 4, palette: 'blast', power: 1 });
  runToDone(inst);
  inst.dispose();
  const inst2 = fx.cast({ line: line(), seed: 4, palette: 'quake', power: 1 }); // quake: lightGain 0
  runToDone(inst2);
  inst2.dispose();
  fx.dispose();
});

check('the centre defaults to the caster and can be moved to the target', () => {
  const { deps } = makeDeps();
  const fx = createShockFx(deps);
  const l = line();
  const atOrigin = fx.cast({ line: l, seed: 1, palette: 'blast' });
  assert(Math.abs(atOrigin.group.position.x - l.origin.x) < 1e-6, 'default centre should sit at line.origin');
  atOrigin.dispose();
  const fxTarget = createShockFx(deps, { centre: 'target' });
  const atTarget = fxTarget.cast({ line: l, seed: 1, palette: 'blast' });
  assert(Math.abs(atTarget.group.position.x - l.target.x) < 1e-6, 'centre: "target" should sit at line.target');
  atTarget.dispose();
  fx.dispose();
  fxTarget.dispose();
});

check('a degenerate line and an unknown palette still cast and finish', () => {
  const { deps } = makeDeps();
  const fx = createShockFx(deps);
  const inst = fx.cast({ line: makeLine({ from: { x: 0, z: 0 }, to: { x: 0, z: 0 }, terrainHeight }), seed: 1, palette: 'nope', power: 1 });
  runToDone(inst, 400);
  assert(inst.machine.phase === Phase.DONE, 'degenerate cast never finished');
  inst.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
