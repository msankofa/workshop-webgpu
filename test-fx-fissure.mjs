import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, Phase } from './moves/move-core.js';
import { createFissureFx, PALETTES } from './moves/fx-fissure.js';

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

check('a cast runs travel -> impact -> fade -> done exactly once', () => {
  const { deps, scene } = makeDeps();
  const fx = createFissureFx(deps);
  const inst = fx.cast({ line: line(), seed: 7, palette: 'magma', power: 1 });
  assert(scene.children.includes(inst.group), 'group not added to the scene');
  let impacts = 0, dones = 0;
  inst.onImpact = () => impacts++;
  inst.onDone = () => dones++;
  let alive = true, frames = 0, sawTravel = false, sawFade = false;
  while (alive && frames < 400) {
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

check('every palette casts and builds its node graphs', () => {
  for (const name of Object.keys(PALETTES)) {
    const { deps } = makeDeps();
    const fx = createFissureFx(deps);
    const inst = fx.cast({ line: line(), seed: 3, palette: name, power: 1.4 });
    for (let i = 0; i < 220; i++) inst.update(1 / 60, i / 60);
    assert(inst.machine.phase === Phase.DONE, `${name} did not finish`);
    inst.dispose();
    fx.dispose();
  }
});

check('the ribbon carries the shader attributes, the front advances, the burst opens at impact', () => {
  const { deps } = makeDeps();
  const fx = createFissureFx(deps);
  const inst = fx.cast({ line: line(), seed: 11, power: 1 });
  const ribbon = inst.group.children.find((c) => c.isMesh && c.geometry.getAttribute('aDist'));
  for (const a of ['aSide', 'aAcross', 'aDist', 'aJit', 'aWalk', 'aMaxWalk', 'aRank']) {
    assert(ribbon.geometry.getAttribute(a), `missing attribute ${a}`);
  }
  const dist = ribbon.geometry.getAttribute('aDist');
  const rank = ribbon.geometry.getAttribute('aRank');
  let maxDist = 0, branchVerts = 0;
  for (let i = 0; i < dist.count; i++) { maxDist = Math.max(maxDist, dist.getX(i)); if (rank.getX(i) > 0) branchVerts++; }
  assert(branchVerts > 0, 'no branch vertices were generated');
  assert(maxDist > inst.machine.line.length, 'no burst cracks past the end of the line');
  assert(inst.group.children.some((c) => c.isInstancedMesh), 'no instanced rock/ember meshes');
  let front = 0;
  for (let i = 0; i < 30; i++) { inst.update(1 / 60, i / 60); front = Math.max(front, inst.machine.u); }
  assert(front > 0 && front < 1, `front should be mid-flight, u=${front}`);
  const beforeBurst = inst.group.children.length;
  while (inst.machine.phase === Phase.TRAVEL) inst.update(1 / 60, 1);
  for (let i = 0; i < 20; i++) inst.update(1 / 60, 2 + i / 60);
  assert(inst.group.children.length === beforeBurst, 'impact should not add draw calls');
  inst.dispose();
  fx.dispose();
});

check('same seed gives the same geometry, different seeds do not', () => {
  const { deps } = makeDeps();
  const fx = createFissureFx(deps);
  const geoOf = (seed) => {
    const i = fx.cast({ line: line(), seed, power: 1 });
    const g = i.group.children.find((c) => c.isMesh && c.geometry.getAttribute('aJit')).geometry;
    const jit = Array.from(g.getAttribute('aJit').array);
    i.dispose();
    return jit;
  };
  const a = geoOf(42), b = geoOf(42), c = geoOf(43);
  assert(a.length === b.length && a.every((v, i) => v === b[i]), 'seed 42 was not reproducible');
  assert(a.length !== c.length || a.some((v, i) => v !== c[i]), 'seed 43 matched seed 42');
  fx.dispose();
});

check('power scales the crack, and lights are returned to the pool', () => {
  const { deps, free } = makeDeps();
  const startFree = free.length;
  const fx = createFissureFx(deps);
  const weak = fx.cast({ line: line(), seed: 5, power: 0.4 });
  const strong = fx.cast({ line: line(), seed: 5, power: 2 });
  const widthOf = (i) => i.group.children.find((c) => c.isMesh && c.geometry.getAttribute('aJit'));
  assert(widthOf(weak) && widthOf(strong), 'ribbons missing');
  const verts = (i) => widthOf(i).geometry.getAttribute('aDist').count;
  assert(verts(strong) > verts(weak), `power should grow the network: ${verts(weak)} vs ${verts(strong)}`);
  assert(free.length < startFree, 'no lights were acquired');
  weak.dispose(); strong.dispose();
  assert(free.length === startFree, `lights leaked: ${free.length} of ${startFree}`);
  fx.dispose();
});

check('a degenerate line and an unknown palette still cast', () => {
  const { deps } = makeDeps();
  const fx = createFissureFx(deps);
  const inst = fx.cast({ line: makeLine({ from: { x: 0, z: 0 }, to: { x: 0, z: 0 }, terrainHeight }), seed: 1, palette: 'nope', power: 1 });
  for (let i = 0; i < 250; i++) inst.update(1 / 60, i / 60);
  assert(inst.machine.phase === Phase.DONE, 'degenerate cast never finished');
  inst.dispose();
  fx.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
