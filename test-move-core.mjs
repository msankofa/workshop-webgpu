import { makeLine, createPhaseMachine, Phase, mulberry32, hashSeed, createRateEmitter, Easing } from './moves/move-core.js';

let fails = 0;
function check(name, fn) { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);

check('makeLine samples the terrain and interpolates', () => {
  const line = makeLine({ from: { x: 0, z: 0 }, to: { x: 4, z: 0 }, terrainHeight: (x) => x * 0.5, step: 0.5 });
  near(line.length, 4, 1e-9, 'length');
  assert(line.samples.length === 9, `sample count ${line.samples.length}`);
  near(line.pointAt(0.5).x, 2, 1e-9, 'midpoint x');
  near(line.pointAt(0.5).y, 1, 1e-9, 'midpoint y follows terrain');
  near(line.side.z, -1, 1e-9, 'side is dir x up');
});

check('a zero-length line is stretched, not divided by zero', () => {
  const line = makeLine({ from: { x: 1, z: 1 }, to: { x: 1, z: 1 } });
  assert(Number.isFinite(line.dir.x) && line.length > 0, 'degenerate line');
});

check('phase machine walks travel, impact, fade, done and fires impact once', () => {
  let impacts = 0; const ts = [];
  const m = createPhaseMachine({ travelSpeed: 5, impactTime: 0.5, fadeTime: 0.5, easeIn: 0,
    onImpact() { impacts++; }, onFade(dt, t) { ts.push(t); } });
  m.spawn(makeLine({ from: { x: 0, z: 0 }, to: { x: 5, z: 0 } }));
  assert(m.phase === Phase.TRAVEL, 'not travelling');
  for (let i = 0; i < 30; i++) m.update(1 / 60);
  assert(m.phase === Phase.TRAVEL && m.u > 0.4 && m.u < 0.6, `u after 0.5 s = ${m.u}`);
  for (let i = 0; i < 31; i++) m.update(1 / 60);
  assert(m.phase === Phase.IMPACT && impacts === 1, `impact ${m.phase} ${impacts}`);
  for (let i = 0; i < 31; i++) m.update(1 / 60);
  assert(m.phase === Phase.FADE, `fade ${m.phase}`);
  for (let i = 0; i < 31; i++) m.update(1 / 60);
  assert(m.phase === Phase.DONE && !m.alive && impacts === 1, 'done');
  assert(ts.some(t => t > 1) && ts.every(t => t >= 0 && t <= 2), 'fade t range');
  assert(m.update(1 / 60) === false, 'update after done');
});

check('travelTime wins over travelSpeed and respawn resets state', () => {
  const m = createPhaseMachine({ travelSpeed: 1, travelTime: 0.25, easeIn: 0 });
  m.spawn(makeLine({ from: { x: 0, z: 0 }, to: { x: 100, z: 0 } }));
  for (let i = 0; i < 16; i++) m.update(1 / 60);
  assert(m.phase === Phase.IMPACT, `travelTime ignored: ${m.phase} u=${m.u}`);
  m.spawn(makeLine({ from: { x: 0, z: 0 }, to: { x: 1, z: 0 } }));
  assert(m.u === 0 && m.age === 0 && m.phase === Phase.TRAVEL, 'respawn did not reset');
});

check('rng is deterministic and the rate emitter carries remainders', () => {
  const a = mulberry32(hashSeed('thunderbolt#1')), b = mulberry32(hashSeed('thunderbolt#1'));
  for (let i = 0; i < 5; i++) assert(a() === b(), 'rng diverged');
  const e = createRateEmitter(); let n = 0;
  for (let i = 0; i < 60; i++) n += e.take(3.5, 1 / 60);
  assert(n === 3, `emitted ${n}, wanted 3`);
  near(Easing.outBack(1), 1, 1e-9, 'outBack(1)');
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
