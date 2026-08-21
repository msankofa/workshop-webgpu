/**
 * test-moves-integration.mjs — casts every move in the registry through the effect that claims it.
 *
 * The per-module tests prove a module works. `test-move-registry.mjs` proves the table is
 * self-consistent. Neither proves the two agree: the registry's `FX_PALETTES` is a hand-written
 * mirror of what each module exports, so a row can name a palette the module has never heard of and
 * both tests still pass. This one imports the real modules, casts every row, and walks it to DONE.
 *
 * It also holds the whole thing to the harness's actual light budget — six lights for every live
 * effect — because a module that leaks one starves every effect cast after it.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { makeLine, hashSeed, Phase } from './moves/move-core.js';
import { MOVES, FX_PALETTES } from './moves/move-registry.js';

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

const FACTORIES = {
  bolt: 'createBoltFx', stream: 'createStreamFx', crystals: 'createCrystalsFx',
  fissure: 'createFissureFx', aurora: 'createAuroraFx', cloud: 'createCloudFx',
  blade: 'createBladeFx', shock: 'createShockFx', orb: 'createOrbFx', vortex: 'createVortexFx',
  ring: 'createRingFx', tether: 'createTetherFx', skyfall: 'createSkyfallFx',
  field: 'createFieldFx', dome: 'createDomeFx', aura: 'createAuraFx',
};

// Six lights, exactly as demos/pokemon-moves.html hands them out.
const scene = new THREE.Scene();
const pool = Array.from({ length: 6 }, () => {
  const l = new THREE.PointLight(); l.userData.busy = false; scene.add(l); return l;
});
const lights = {
  acquire() { const l = pool.find(x => !x.userData.busy); if (l) { l.userData.busy = true; l.intensity = 0; } return l || null; },
  release(l) { if (!l) return; l.intensity = 0; l.userData.busy = false; },
};
const busyCount = () => pool.filter(l => l.userData.busy).length;
const deps = { THREE, TSL, NODES, scene, terrainHeight: (x, z) => Math.sin(x * 0.3) * 0.15 + Math.cos(z * 0.25) * 0.1, lights };

const modules = {}, factories = {};
for (const key of Object.keys(FX_PALETTES)) {
  modules[key] = await import(`./moves/fx-${key}.js`);
  factories[key] = modules[key][FACTORIES[key]](deps);
}

check('every effect in the registry has a module, a factory and a PALETTES export', () => {
  for (const key of Object.keys(FX_PALETTES)) {
    assert(FACTORIES[key], `${key}: this test has no factory name for it`);
    assert(typeof modules[key][FACTORIES[key]] === 'function', `${key}: ${FACTORIES[key]} is not exported`);
    assert(modules[key].PALETTES && typeof modules[key].PALETTES === 'object', `${key}: no PALETTES export`);
  }
});

check('the registry palette table matches what the modules actually export', () => {
  const wrong = [];
  for (const [key, listed] of Object.entries(FX_PALETTES)) {
    const real = Object.keys(modules[key].PALETTES);
    for (const p of listed) if (!real.includes(p)) wrong.push(`${key}: registry lists '${p}', module has [${real.join(', ')}]`);
  }
  assert(wrong.length === 0, wrong.join('\n       '));
});

// A move that never reaches DONE would hang the harness's live list, so cap the walk generously.
function runMove(m) {
  const from = { x: -1.5, z: 0 }, to = { x: 1.5, z: 0.4 };
  const line = makeLine({ from, to: m.self ? from : to, terrainHeight: deps.terrainHeight, step: 0.08 });
  const inst = factories[m.fx].cast({
    ...(m.options || {}),
    line, seed: hashSeed(m.name), palette: m.palette, power: m.power,
    sourceY: 0.8, targetY: 0.7, travelSpeed: m.travelSpeed, travelTime: m.travelTime,
  });
  assert(inst && inst.machine && inst.group, `${m.name}: cast returned nothing usable`);
  if (m.travelTime > 0) inst.machine.travelTime = m.travelTime;
  else if (m.travelSpeed > 0) { inst.machine.travelTime = 0; inst.machine.travelSpeed = m.travelSpeed; }
  if (m.hold) { inst.machine.hold = true; inst.machine.maxHold = m.maxHold; }

  let impacts = 0;
  if (!m.self && !m.status) inst.onImpact = () => { impacts++; };

  let frames = 0, alive = true, released = false;
  while (alive && frames < 4000) {
    alive = inst.update(1 / 60, frames / 60);
    frames++;
    // Let a held move stand for a second, then take it down the way the harness does.
    if (!released && m.hold && inst.machine.holding && inst.machine.phaseAge > 1) { inst.machine.release(); released = true; }
  }
  assert(!alive, `${m.name}: still alive after ${frames} frames (${inst.machine.phase})`);
  assert(inst.machine.phase === Phase.DONE, `${m.name}: ended in ${inst.machine.phase}`);
  if (m.hold) assert(released, `${m.name}: declares hold but never parked in IMPACT`);
  inst.dispose();
  return { frames, impacts };
}

check('every move casts, runs to DONE, and disposes', () => {
  const bad = [];
  for (const m of MOVES) {
    try { runMove(m); } catch (e) { bad.push(`${m.name} [${m.fx}/${m.palette}]: ${e.message}`); }
  }
  assert(bad.length === 0, `${bad.length} of ${MOVES.length} moves failed:\n       ` + bad.join('\n       '));
});

check('no effect leaks a light: the pool is fully free again afterwards', () => {
  assert(busyCount() === 0, `${busyCount()} of 6 lights still held`);
});

check('the scene is left as clean as it started', () => {
  const strays = scene.children.filter(c => !(c.isLight));
  assert(strays.length === 0, `${strays.length} object(s) left in the scene: ${strays.map(c => c.type).join(', ')}`);
});

check('a damaging non-self move reports exactly one impact', () => {
  const m = MOVES.find(x => !x.self && !x.status);
  const { impacts } = runMove(m);
  assert(impacts === 1, `${m.name} fired onImpact ${impacts} times`);
});

check('every palette a module ships is reachable by some move, bar the fallback', () => {
  const used = new Map();
  for (const m of MOVES) { if (!used.has(m.fx)) used.set(m.fx, new Set()); used.get(m.fx).add(m.palette); }
  const idle = [];
  for (const [key, mod] of Object.entries(modules)) {
    // `default` is each module's unknown-palette fallback, so no move should name it.
    for (const p of Object.keys(mod.PALETTES)) if (p !== 'default' && !used.get(key)?.has(p)) idle.push(`${key}.${p}`);
  }
  assert(idle.length === 0, `palettes no move reaches: ${idle.join(', ')}`);
});

check('casting every effect at once stays inside the six-light budget without throwing', () => {
  const live = [];
  for (const key of Object.keys(FX_PALETTES)) {
    const m = MOVES.find(x => x.fx === key);
    const from = { x: -1.5, z: 0 }, to = { x: 1.5, z: 0.4 };
    const line = makeLine({ from, to: m.self ? from : to, terrainHeight: deps.terrainHeight, step: 0.08 });
    live.push(factories[key].cast({ ...(m.options || {}), line, seed: hashSeed(m.name), palette: m.palette, power: m.power, sourceY: 0.8, targetY: 0.7 }));
  }
  for (let f = 0; f < 120; f++) for (const i of live) { try { i.update(1 / 60, f / 60); } catch (e) { throw new Error(`concurrent update threw: ${e.message}`); } }
  for (const i of live) i.dispose();
  assert(busyCount() === 0, `${busyCount()} lights still held after disposing every effect`);
});

for (const f of Object.values(factories)) f.dispose?.();

console.log(fails ? `\n${fails} check(s) failed` : `\nall checks passed (${MOVES.length} moves across ${Object.keys(FX_PALETTES).length} effects)`);
process.exit(fails ? 1 : 0);
