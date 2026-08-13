// test-flight-ai.mjs — the AI flies the same model the player does, so the test is a flight.
//
// Three minutes per class, unattended. This is the suite that caught the AI banking AWAY from its
// target (heading increases to the left, positive bank rolls right) and the bird exhausting its
// stamina and never taking off again — both of which look like "it is just flying oddly" on screen.
//
//   node test-flight-ai.mjs

import * as THREE from 'three';
import { makeFlyer, stepFlyer, syncAxes } from './flight-model.js';
import {
  makeAi, offsetCircuit, driveAi, aiShoot, pickFoe, wrapPi,
  SQUAD, PRESETS, OWN_CIRCUIT_BELOW,
} from './flight-ai.js';
import { agl } from './flight-terrain.js';

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const DT = 1 / 60;
const KEYS = Object.keys(SQUAD);

// ---------------------------------------------------------------------------
console.log('--- 1. each class flies its circuit for three minutes, unattended ---');
// ---------------------------------------------------------------------------
for (const key of ['plane', 'drone', 'bird']) {
  const f = makeAi(makeFlyer(key, { x: 0, z: 0 }), 1);
  offsetCircuit(f, 0, 0);
  const world = { flyers: [f], player: null, aiEngage: true };
  let minAgl = Infinity, invertedSteps = 0, steps = 0, crashed = false, visited = new Set();
  for (let t = 0; t < 180; t += DT, steps++) {
    driveAi(f, DT, world);
    stepFlyer(f, DT, true);
    if (!Number.isFinite(f.p.y)) { crashed = true; break; }
    minAgl = Math.min(minAgl, agl(f.p));
    if (f.up.y < 0) invertedSteps++;
    visited.add(f.ai.i);
    if (f.crashed) { crashed = true; break; }
  }
  const wp = f.ai.pts[f.ai.i];
  const toWp = Math.hypot(wp.x - f.p.x, wp.z - f.p.z);
  const inverted = steps ? invertedSteps / steps : 1;
  console.log(`  ${key.padEnd(5)} min AGL ${minAgl.toFixed(0)} m, inverted ` +
    `${(inverted * 100).toFixed(0)}% of the time, visited ${visited.size}/6 waypoints, ` +
    `${toWp.toFixed(0)} m to the next`);
  ok(`${key} AI survives 3 minutes`, !crashed);
  ok(`${key} AI never flies inverted`, inverted === 0, `${(inverted * 100).toFixed(0)}%`);
  ok(`${key} AI stays off the ground`, minAgl > 20, `${minAgl.toFixed(0)} m`);
  // the bank-sign bug parked the heading error at 180 deg and flew off the map, so it never
  // captured a second waypoint
  ok(`${key} AI actually gets round its circuit`, visited.size >= 3, `${visited.size}/6`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. the bird does not exhaust itself into the ground ---');
// ---------------------------------------------------------------------------
{
  // flapping flat out drains the bird in seconds, and a grounded bird cannot take off again —
  // flap thrust alone is well under its weight, so the AI needs stamina hysteresis
  const f = makeAi(makeFlyer('bird', {}), 3);
  offsetCircuit(f, 0, 0);
  const world = { flyers: [f], player: null, aiEngage: true };
  let minStamina = 1, rests = 0, wasResting = false;
  for (let t = 0; t < 180; t += DT) {
    driveAi(f, DT, world);
    stepFlyer(f, DT, true);
    minStamina = Math.min(minStamina, f.stamina);
    if (f.ai.rest && !wasResting) rests++;
    wasResting = f.ai.rest;
    if (f.crashed) break;
  }
  console.log(`  stamina bottomed at ${(minStamina * 100).toFixed(0)}%, rested ${rests} times ` +
    `in 3 minutes, ${f.crashed ? 'CRASHED' : 'still flying'}`);
  ok('it rests before it runs dry', !f.crashed && minStamina > 0);
  ok('and it does rest, rather than never needing to', rests > 0);
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. target selection: sides, support, and practice targets ---');
// ---------------------------------------------------------------------------
{
  const mk = (id, team, x, z, armed = true) => ({
    id, team, armed, dead: false, p: new THREE.Vector3(x, 1000, z), v: new THREE.Vector3(),
    fwd: new THREE.Vector3(0, 0, -1), lockTarget: null,
  });
  const player = mk(1, 0, 0, 0);
  const ally = mk(2, 0, 100, 0);
  const near = mk(3, 1, 900, 0);              // closer, but minding its own business
  const attacker = mk(4, 1, 1900, 0);         // further, but locked onto the player
  attacker.lockTarget = player;
  const trainer = mk(5, 1, 300, 0, false);    // nearest of all, and harmless
  const world = { flyers: [player, ally, near, attacker, trainer], player, aiEngage: true };

  ok('nobody ever picks their own side',
    world.flyers.every((f) => { const o = pickFoe(f, world); return !o || o.team !== f.team; }));
  console.log(`  near bandit at 900 m, attacker at 1900 m: the ally chose ` +
    `${pickFoe(ally, world) === attacker ? 'the attacker' : 'the near one'}`);
  ok('support means taking the shot off your back, not the nearest kill',
    pickFoe(ally, world) === attacker);
  ok('PRACTICE TARGETS ARE YOURS — no AI takes them',
    world.flyers.every((f) => pickFoe(f, world) !== trainer));

  world.aiEngage = false;
  const noHunt = pickFoe(near, world);
  console.log(`  with "enemies hunt you" off, the near bandit goes for ` +
    `${noHunt === ally ? 'an ally' : noHunt ? 'the player anyway' : 'nothing'}`);
  ok('turning off hunting makes them fight your allies, not idle', noHunt === ally);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. trigger discipline, and what unarmed craft cannot do ---');
// ---------------------------------------------------------------------------
{
  const mkf = (armed, afKey = 'plane') => {
    const f = makeFlyer(afKey, {});
    f.armed = armed; f.mslCool = 0; f.lockProgress = 1;
    return f;
  };
  const shooter = mkf(true);
  shooter.p.set(0, 1000, 0); syncAxes(shooter);
  const foe = makeFlyer('plane', { team: 1 });
  foe.p.set(0, 1000, -500); foe.v.set(0, 0, 0);
  shooter.foe = foe; shooter.lockTarget = foe;
  const world = { flyers: [shooter, foe], player: null, aiEngage: true };

  ok('fires the gun inside the cone at short range', aiShoot(shooter, world).gun);
  foe.p.set(400, 1000, -500);
  ok('holds fire once the target is off boresight', !aiShoot(shooter, world).gun);
  foe.p.set(0, 1000, -2000);
  ok('takes a missile shot at medium range on a full lock', aiShoot(shooter, world).missile);
  shooter.lockProgress = 0.5;
  ok('but not without a full lock', !aiShoot(shooter, world).missile);

  const unarmed = mkf(false);
  unarmed.p.set(0, 1000, 0); syncAxes(unarmed);
  unarmed.foe = foe; unarmed.lockTarget = foe;
  const r = aiShoot(unarmed, world);
  ok('an unarmed aircraft fires nothing at all', !r.gun && !r.missile);

  const bird = mkf(true, 'bird');
  bird.foe = foe;
  const rb = aiShoot(bird, world);
  ok('a bird has no weapons either — it just menaces', !rb.gun && !rb.missile);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. the roster presets do what their names promise ---');
// ---------------------------------------------------------------------------
{
  const armedHostiles = (r) => KEYS.filter((k) => SQUAD[k].armed && SQUAD[k].team === 1)
    .reduce((n, k) => n + r[k], 0);
  const unarmed = (r) => KEYS.filter((k) => !SQUAD[k].armed).reduce((n, k) => n + r[k], 0);

  for (const [name, pre] of Object.entries(PRESETS)) {
    console.log(`  ${name.padEnd(9)} ${armedHostiles(pre)} armed hostile(s), ` +
      `${unarmed(pre)} practice target(s), ground sites ${pre.ground ? 'on' : 'off'}`);
  }
  ok('solo is an empty sky', KEYS.every((k) => PRESETS.solo[k] === 0));
  ok('TRAINING HAS NOTHING ARMED IN IT — the whole point of the feature',
    armedHostiles(PRESETS.training) === 0);
  ok('training still gives you something to chase', unarmed(PRESETS.training) > 0);
  ok('and turns the ground sites off, or a SAM makes it a fight again',
    !PRESETS.training.ground && !PRESETS.solo.ground);
  ok('mixed actually mixes', armedHostiles(PRESETS.mixed) > 0 && unarmed(PRESETS.mixed) > 0);
  ok('combat has no practice targets cluttering it', unarmed(PRESETS.combat) === 0);
  // a preset that forgets a key would silently leave the previous count in place
  ok('every preset names every roster key',
    Object.values(PRESETS).every((pre) => KEYS.every((k) => typeof pre[k] === 'number')));
  ok('every class is reachable from some preset',
    KEYS.every((k) => Object.values(PRESETS).some((pre) => pre[k] > 0)));
  ok('no preset exceeds a class maximum',
    Object.values(PRESETS).every((pre) => KEYS.every((k) => pre[k] <= SQUAD[k].max)));
}

// ---------------------------------------------------------------------------
console.log('\n--- 6. several tight circuits must not share a centre ---');
// ---------------------------------------------------------------------------
{
  // Circuits are centred on the player, which is right for planes on a 2.6 km ring — that is what
  // puts everyone in the same fight. Eight target drones on a 90 m ring would fly through each
  // other, so anything tighter than OWN_CIRCUIT_BELOW is centred on its own spawn point.
  const n = SQUAD.target.max;
  const centres = [];
  for (let i = 0; i < n; i++) {
    const spread = SQUAD.target.r * (0.8 + 0.35 * i);
    centres.push({ x: Math.cos(i * 1.4) * spread, z: Math.sin(i * 1.4) * spread });
  }
  let worst = Infinity;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      worst = Math.min(worst, Math.hypot(centres[a].x - centres[b].x, centres[a].z - centres[b].z));
    }
  }
  const radius = SQUAD.target.over.radius;
  console.log(`  ${n} target drones: closest two centres ${worst.toFixed(0)} m apart, ` +
    `against a ${radius} m circuit radius`);
  ok('their circuits do not overlap', worst > radius * 2, `${worst.toFixed(0)} m vs ${radius * 2} m`);
  ok('the tight classes are the ones that get their own centre',
    SQUAD.target.over.radius < OWN_CIRCUIT_BELOW && SQUAD.trainer.over.radius >= OWN_CIRCUIT_BELOW);
}

// ---------------------------------------------------------------------------
console.log('\n--- 7. wrapPi ---');
// ---------------------------------------------------------------------------
{
  ok('wraps past pi', Math.abs(wrapPi(Math.PI + 0.1) - (-Math.PI + 0.1)) < 1e-9);
  ok('leaves small angles alone', Math.abs(wrapPi(0.3) - 0.3) < 1e-12);
  ok('is bounded everywhere',
    [...Array(200).keys()].every((i) => Math.abs(wrapPi((i - 100) * 0.7)) <= Math.PI + 1e-9));
}

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
