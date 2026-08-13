// test-flight-drones.mjs — the three releasable drones.
//
// Each one has a claim attached to it that is easy to assert on screen and easy to get wrong:
// a decoy has to actually pull a seeker, a glider has to arrive faster than it left, an interceptor
// has to reach a missile before the missile reaches you. Those are simulations, not opinions.
//
//   node test-flight-drones.mjs

import * as THREE from 'three';
import {
  DRONE, DRONE_KINDS, steerToward, kamikazeSpeed, impactDamage,
  pickGroundTarget, pickInterceptTarget, stepDrone, canRelease, giveDrones, fullDroneLoad,
} from './flight-drones.js';
import { COMBAT, GROUND, proNavAccel, missileDanger } from './flight-combat.js';
import { makeFlyer } from './flight-model.js';

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const V = (x, y, z) => new THREE.Vector3(x, y, z);

function makeDrone(kind, p, v, owner = null, slot = 1) {
  return {
    live: true, kind, def: DRONE[kind], p: p.clone(), v: v.clone(), age: 0, slot,
    target: null, owner, lastLos: new THREE.Vector3(),
    flareTimer: 0, flaresLeft: DRONE[kind].flares || 0,
  };
}

// ---------------------------------------------------------------------------
console.log('--- 1. steering is bounded and never destroys the speed ---');
// ---------------------------------------------------------------------------
{
  const v = V(200, 0, 0);
  steerToward(v, V(0, 0, 200), 1.0, 0.1);         // 0.1 rad of a 90 deg turn
  const turned = Math.acos(v.clone().normalize().dot(V(1, 0, 0)));
  ok('turns at the commanded rate, not instantly', Math.abs(turned - 0.1) < 0.01,
    `${turned.toFixed(3)} rad in 0.1 s at 1.0 rad/s`);
  ok('speed is preserved', Math.abs(v.length() - 200) < 1e-6);

  const parallel = V(100, 0, 0);
  steerToward(parallel, V(5, 0, 0), 2, 0.1);
  ok('already-parallel does not produce a NaN', Number.isFinite(parallel.length()));

  // the degenerate case that matters: a reversal has no cross-product axis, and a fallback axis
  // that is itself parallel to the velocity silently does nothing at all
  for (const [name, v0, dir] of [
    ['along Z', V(0, 0, -200), V(0, 0, 1)],
    ['straight up', V(0, 200, 0), V(0, -1, 0)],
    ['along X', V(200, 0, 0), V(-1, 0, 0)],
  ]) {
    const v = v0.clone();
    steerToward(v, dir, 2.6, 1 / 60);
    const moved = Math.acos(THREE.MathUtils.clamp(
      v.clone().normalize().dot(v0.clone().normalize()), -1, 1));
    ok(`a 180° reversal ${name} actually turns`, moved > 2.6 / 60 * 0.9 && Number.isFinite(v.length()),
      `${moved.toFixed(4)} rad`);
  }

  const slow = V(0, 0, 0);
  steerToward(slow, V(1, 0, 0), 2, 0.1);
  ok('a stopped drone does not produce a NaN', Number.isFinite(slow.length()));
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. the decoy actually pulls a seeker ---');
// ---------------------------------------------------------------------------
{
  const d = makeDrone('decoy', V(0, 900, 0), V(0, 0, -150));
  let flares = 0;
  for (let i = 0; i < 60 * 30; i++) if (stepDrone(d, 1 / 60, {}).flare) flares++;
  ok('dispenses its whole load', flares === DRONE.decoy.flares, `${flares} flares`);
  console.log(`  ${DRONE.decoy.flares} flares over ${(DRONE.decoy.flares * DRONE.decoy.flareGap).toFixed(1)} s ` +
    `of a ${DRONE.decoy.life} s life`);

  // A decoy slower than the aircraft cannot do its job — it never gets anywhere the missile would
  // rather go, so it just flies alongside you laying flares on your own track.
  const plane = makeFlyer('plane');
  ok('outruns the aircraft that released it', DRONE.decoy.speed > plane.af.trimSpeed * 3,
    `${DRONE.decoy.speed} m/s vs a ${plane.af.trimSpeed} m/s aircraft`);
  ok('and is in missile territory, not aircraft territory', DRONE.decoy.speed > 400);

  const boosted = makeDrone('decoy', V(0, 900, 0), V(0, 0, -plane.af.trimSpeed));
  let reached = 0;
  for (let i = 0; i < 60 * 6 && !reached; i++) {
    stepDrone(boosted, 1 / 60, {});
    if (boosted.v.length() >= DRONE.decoy.speed - 1) reached = i / 60;
  }
  ok('gets up to speed before its second flare', reached > 0 && reached < DRONE.decoy.flareGap * 2,
    `${reached.toFixed(2)} s from ${plane.af.trimSpeed} m/s`);

  const d2 = makeDrone('decoy', V(0, 900, 0), V(0, 0, -plane.af.trimSpeed));
  for (let i = 0; i < 60 * 6; i++) stepDrone(d2, 1 / 60, {});
  const sep = d2.p.distanceTo(V(0, 900, 0));
  const ownTrack = plane.af.trimSpeed * 6;
  ok('leaves the aircraft well behind', sep > ownTrack * 3,
    `${sep.toFixed(0)} m in 6 s against ${ownTrack.toFixed(0)} m of aircraft travel`);

  // THE TRAIL MUST NOT HAVE HOLES. Spacing is speed times the dispense interval, and a gap wider
  // than the seeker range is a dotted line a missile flies straight through.
  const spacing = DRONE.decoy.speed * DRONE.decoy.flareGap;
  ok('consecutive flares land inside one seeker range of each other',
    spacing < COMBAT.flare.seekRange,
    `${spacing.toFixed(0)} m apart, seeker sees ${COMBAT.flare.seekRange} m`);
  console.log(`  ${DRONE.decoy.flares} flares every ${DRONE.decoy.flareGap} s at ` +
    `${DRONE.decoy.speed} m/s lays ${(spacing * (DRONE.decoy.flares - 1) / 1000).toFixed(1)} km of trail`);

  const spent = makeDrone('decoy', V(0, 900, 0), V(0, 0, -150));
  spent.flaresLeft = 0;
  let gone = 0;
  for (let i = 0; i < 60 * 20 && !gone; i++) if (stepDrone(spent, 1 / 60, {}).expired) gone = i / 60;
  ok('an empty decoy expires instead of loitering for its full life',
    gone > 0 && gone < DRONE.decoy.life * 0.3, `${gone.toFixed(1)} s`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. the kamikaze glider is faster and harder the longer it flies ---');
// ---------------------------------------------------------------------------
{
  const def = DRONE.kamikaze;
  ok('it starts slower than the aircraft that dropped it', def.speed < 150);
  ok('and ends faster than a missile cruises', def.maxSpeed > 400);
  const t10 = kamikazeSpeed(10), t30 = kamikazeSpeed(30), t99 = kamikazeSpeed(99);
  ok('speed grows with time in the air', t10 < t30);
  ok('and is capped', t99 === def.maxSpeed);
  console.log(`  ${def.speed} m/s at release, ${t10.toFixed(0)} at 10 s, ${t30.toFixed(0)} at 30 s, ` +
    `cap ${def.maxSpeed} reached at ${((def.maxSpeed - def.speed) / def.gain).toFixed(0)} s`);

  const near = makeDrone('kamikaze', V(0, 800, 0), V(0, 0, -110));
  near.v.setLength(kamikazeSpeed(0));
  const far = makeDrone('kamikaze', V(0, 800, 0), V(0, 0, -110));
  far.age = 25; far.v.setLength(kamikazeSpeed(25));
  ok('a long shot hits harder than a short one', impactDamage(far) > impactDamage(near),
    `${impactDamage(near).toFixed(0)} vs ${impactDamage(far).toFixed(0)} damage`);
  ok('even a short shot is worth releasing', impactDamage(near) > GROUND.sam.hp * 0.5);
  ok('a full-speed one kills a SAM outright', impactDamage(far) > GROUND.sam.hp);
  ok('but never an HQ in one hit', impactDamage(far) < GROUND.hq.hp);

  // target choice
  const sites = [
    { p: V(0, 40, -2000), dead: false, team: 1, range: 0, kind: 'hq' },
    { p: V(0, 40, -2400), dead: false, team: 1, range: GROUND.sam.range, kind: 'sam' },
    { p: V(0, 40, -400), dead: false, team: 0, range: 0, kind: 'depot' },
  ];
  const chooser = makeDrone('kamikaze', V(0, 900, 0), V(0, 0, -110), { team: 0 });
  const pick = pickGroundTarget(sites, chooser);
  ok('it will fly past a soft target to reach one that shoots back', pick === sites[1],
    `chose ${pick && pick.kind}`);
  ok('and never attacks its own side', pick.team !== 0);
  ok('nothing in reach means no target', pickGroundTarget([], chooser) === null);

  // the whole flight, against a real site
  const site = { p: V(0, 40, -3000), dead: false, team: 1, range: GROUND.sam.range, kind: 'sam' };
  const g = makeDrone('kamikaze', V(0, 1400, 0), V(0, -10, -110), { team: 0 });
  g.v.setLength(kamikazeSpeed(0));
  let hit = null, t = 0;
  for (let i = 0; i < 60 * 70 && !hit; i++) {
    t += 1 / 60;
    const ev = stepDrone(g, 1 / 60, { groundTargets: [site] });
    if (ev.hitSite) hit = ev.hitSite;
    if (ev.expired) break;
  }
  ok('a glider released 3 km out reaches the site', hit === site,
    hit ? `in ${t.toFixed(1)} s at ${g.v.length().toFixed(0)} m/s` : 'never arrived');
  ok('and arrives faster than it left', g.v.length() > DRONE.kamikaze.speed * 1.5);
  console.log(`  3 km glide: ${t.toFixed(1)} s, impact ${g.v.length().toFixed(0)} m/s, ` +
    `${impactDamage(g).toFixed(0)} damage — a ${GROUND.sam.hp} hp SAM ` +
    `${impactDamage(g) >= GROUND.sam.hp ? 'dies' : 'survives'}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. the interceptor reaches the missile before the missile reaches you ---');
// ---------------------------------------------------------------------------
{
  const me = {
    p: V(0, 1000, 0), v: V(0, 0, -180), airspeed: 180, dead: false, team: 0, af: {},
    fwd: V(0, 0, -1), right: V(1, 0, 0), up: V(0, 1, 0),
  };
  const inbound = { live: true, target: me, p: V(0, 1000, 2600), v: V(0, 0, -620) };

  ok('it picks the missile that is hunting its owner', pickInterceptTarget([inbound], me) === inbound);
  ok('nothing inbound means nothing to shoot', pickInterceptTarget([], me) === null);
  ok('a missile chasing somebody far away is not its problem',
    pickInterceptTarget([{ live: true, target: { p: V(9000, 1000, 0) }, p: V(9000, 1000, 900), v: V(0, 0, -600) }], me) === null);

  const d = makeDrone('interceptor', V(0, 1000, -20), V(0, 0, -180), me);
  const tti0 = missileDanger(inbound, me).tti;
  let killed = null, t = 0;
  for (let i = 0; i < 60 * 20 && !killed; i++) {
    t += 1 / 60;
    // the missile runs its own guidance at the same rate
    const acc = new THREE.Vector3();
    proNavAccel(acc, inbound.p, inbound.v, new THREE.Vector3().copy(me.p).sub(inbound.p).normalize(),
      me.p, me.v, 1 / 60, COMBAT.msl.N, COMBAT.msl.maxG);
    inbound.v.addScaledVector(acc, 1 / 60);
    inbound.p.addScaledVector(inbound.v, 1 / 60);
    me.p.addScaledVector(me.v, 1 / 60);
    const ev = stepDrone(d, 1 / 60, { missiles: [inbound] });
    if (ev.killed) killed = ev.killed;
    if (ev.expired) break;
  }
  ok('it kills a head-on missile', killed === inbound, `in ${t.toFixed(2)} s`);
  ok('with time to spare', t < tti0, `${t.toFixed(2)} s to intercept vs ${tti0.toFixed(2)} s to impact`);
  const missDist = d.p.distanceTo(me.p);
  ok('and far enough away that the blast does not catch you', missDist > COMBAT.msl.blast,
    `${missDist.toFixed(0)} m from you, blast is ${COMBAT.msl.blast} m`);

  // with nothing to do it should stay with the aircraft rather than fly off
  const escort = makeDrone('interceptor', V(0, 1000, -20), V(0, 0, -180), me, 1);
  for (let i = 0; i < 60 * 12; i++) { me.p.addScaledVector(me.v, 1 / 60); stepDrone(escort, 1 / 60, {}); }
  const station = escort.p.distanceTo(me.p);
  ok('it holds station on the wing with nothing inbound', station < DRONE.interceptor.station * 2.2,
    `${station.toFixed(0)} m off`);

  const orphan = makeDrone('interceptor', V(0, 1000, 0), V(0, 0, -300), { ...me, dead: true });
  for (let i = 0; i < 60 * 5; i++) stepDrone(orphan, 1 / 60, {});
  ok('an orphaned interceptor coasts down instead of flying forever', orphan.v.length() < 300);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. the racks ---');
// ---------------------------------------------------------------------------
{
  const f = { dead: false, drones: fullDroneLoad(), droneCool: {} };
  ok('you start with a full load of all three',
    DRONE_KINDS.every((k) => f.drones[k] === DRONE[k].max));
  ok('every kind can be released from full', DRONE_KINDS.every((k) => canRelease(f, k)));
  f.drones.decoy = 0;
  ok('an empty rack refuses', !canRelease(f, 'decoy'));
  f.drones.decoy = 2; f.droneCool.decoy = 0.5;
  ok('a cycling rack refuses', !canRelease(f, 'decoy'));
  f.droneCool.decoy = 0;
  ok('and accepts once it has cycled', canRelease(f, 'decoy'));
  f.dead = true;
  ok('a dead pilot releases nothing', DRONE_KINDS.every((k) => !canRelease(f, k)));

  const empty = { dead: false, drones: { decoy: 0, kamikaze: 0, interceptor: 0 }, droneCool: {} };
  giveDrones(empty, 1);
  ok('a resupply gives one of each', DRONE_KINDS.every((k) => empty.drones[k] === 1));
  giveDrones(empty, 99);
  ok('and never overfills', DRONE_KINDS.every((k) => empty.drones[k] === DRONE[k].max));
}

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
