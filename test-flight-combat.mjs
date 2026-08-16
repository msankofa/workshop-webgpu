// test-flight-combat.mjs — guidance, gun lead, locking, and the threat warning.
//
// Everything here was wrong on first authoring in a way that looked fine on screen, which is why
// it is a module with a test rather than inline code in a viewer.
//
//   node test-flight-combat.mjs

import * as THREE from 'three';
import {
  COMBAT, GROUND, G, SHELL_GRAVITY,
  pointSegmentDistSq, leadPoint, proNavAccel, lockCandidate,
  createThreatWarning, threatCadence, evadedThisFrame,
  applyAimAssist, AIM_CONE, missileDanger, pickThreat, stepMissile, missileMaxG, interceptPoint,
  BOMBS, BOMB_KINDS, stepBomb, bombImpact, fullBombLoad, GUNS, gunFor,
  mountOrigin, mountBoresight, clampToArc, ballisticAim,
} from './flight-combat.js';
import { makeFlyer, stepFlyer, syncAxes } from './flight-model.js';
import { registerAirframe, AIRFRAMES, getAirframe, validateAirframe } from './flight-airframes.js';
import { airframeFor } from './aircraft-library.js';
import { heightAt } from './flight-terrain.js';
import { readFileSync } from 'node:fs';

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const DT = 1 / 60;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------
console.log('--- 1. swept hit detection, because a round moves 15 m per step ---');
// ---------------------------------------------------------------------------
{
  // 940 m/s is 15.7 m in a 60 Hz step, so testing the round's POINT against a 6.5 m target misses
  // most of the time. The segment test is what makes guns work at all.
  const a = [0, 0, 0], b = [0, 0, -15.7];
  const grazes = Math.sqrt(pointSegmentDistSq(2, 0, -8, ...a, ...b));
  const behind = Math.sqrt(pointSegmentDistSq(0, 0, 40, ...a, ...b));
  console.log(`  target 2 m off the line, half way along: segment distance ${grazes.toFixed(2)} m`);
  ok('a target mid-step is found', grazes < 6.5);
  ok('the point test would have missed it', Math.min(8, 15.7 - 8) > 6.5);
  ok('a target behind the muzzle is not', behind > 6.5, `${behind.toFixed(1)} m`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. gun lead: does the shell arrive where the target will be ---');
// ---------------------------------------------------------------------------
{
  // The obvious version — aim where the target will be after range/muzzle seconds — misses by 41 m
  // against a 210 m/s crosser at 900 m, because leading pushes the aim point further away, which
  // lengthens the flight, which moves the aim point again.
  const muzzle = GROUND.aa.muzzle;
  const site = v3(0, 0, 0);
  const aim = v3();
  let worst = 0, worstNaive = 0;
  for (const [range, speed] of [[600, 120], [1200, 160], [1500, 90], [900, 210]]) {
    const tgt = v3(0, 400, -range), vel = v3(speed, 0, 0);

    // Integrated at 1/240, not the 1/60 sim step. A 620 m/s shell covers 10 m per 60 Hz step, so
    // sampling closest approach at that rate reports a 5 m "miss" for a perfect shot — the
    // measurement interval, not the lead. This is the third time on this page that a metric was
    // measuring itself rather than the thing.
    const SDT = 1 / 240;
    const fireAt = (point) => {
      const dir = point.clone().sub(site).normalize();
      const sp = site.clone().addScaledVector(dir, 6);
      const sv = dir.clone().multiplyScalar(muzzle);
      let closest = Infinity;
      for (let i = 0; i < 2400; i++) {
        sv.y -= G * SDT * SHELL_GRAVITY;
        sp.addScaledVector(sv, SDT);
        closest = Math.min(closest, sp.distanceTo(tgt.clone().addScaledVector(vel, i * SDT)));
      }
      return closest;
    };

    leadPoint(aim, site, tgt, vel, muzzle);
    const miss = fireAt(aim);
    const naive = fireAt(tgt.clone().addScaledVector(vel, range / muzzle));
    worst = Math.max(worst, miss); worstNaive = Math.max(worstNaive, naive);
    console.log(`  ${range} m target crossing at ${speed} m/s: ` +
      `iterated lead misses by ${miss.toFixed(1)} m, single-pass by ${naive.toFixed(1)} m`);
  }
  ok('the iterated lead puts the burst on the target', worst < 5, `worst ${worst.toFixed(1)} m`);
  ok('and the single-pass version really was much worse', worstNaive > worst * 4,
    `${worstNaive.toFixed(1)} m vs ${worst.toFixed(1)} m`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2b. gun aim assist forgives a near miss and nothing else ---');
// ---------------------------------------------------------------------------
{
  // The property that makes this "forgiving" rather than "aiming for you" is the FALLOFF: full help
  // on boresight, none at the cone edge, on a squared curve so the middle is already weak. If it
  // were flat, a wild shot would be dragged onto the target and the gun would stop being a skill.
  // The scenario is the one a player is actually in: nose ON or near the enemy, which for a crosser
  // is NOT where the round has to go. So error is measured against the lead solution while the nose
  // is swept away from the TARGET — the two references are different, and an earlier version of both
  // the code and this test confused them.
  const shooter = { team: 0, dead: false, p: v3(0, 1000, 0), v: v3(0, 0, -120), fwd: v3(0, 0, -1) };

  function scenario(range, crossSpeed) {
    const target = { team: 1, dead: false, p: v3(0, 1000, -range), v: v3(crossSpeed, 0, 0) };
    const toTarget = target.p.clone().sub(shooter.p).normalize();
    const lead = v3();
    leadPoint(lead, shooter.p, target.p, target.v, COMBAT.gunSpeed);
    lead.sub(shooter.p).normalize();
    const err = (offTargetRad, strength) => {
      const aim = toTarget.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), offTargetRad);
      shooter.fwd.copy(aim);
      applyAimAssist(aim, shooter, [shooter, target], strength);
      return aim.angleTo(lead);
    };
    return { err, gap: toTarget.angleTo(lead) };
  }

  const cross = scenario(700, 140);
  const chase = scenario(700, 12);
  console.log(`  lead gap: ${THREE.MathUtils.radToDeg(cross.gap).toFixed(1)} deg against a fast ` +
    `crosser, ${THREE.MathUtils.radToDeg(chase.gap).toFixed(2)} deg in a near tail chase`);
  console.log('  nose off target   crosser: raw -> assisted    tail chase: raw -> assisted');
  for (const deg of [0, 2, 4, 6, 9]) {
    const off = THREE.MathUtils.degToRad(deg);
    const d = (r) => THREE.MathUtils.radToDeg(r).toFixed(2).padStart(5);
    console.log(`  ${String(deg).padStart(6)} deg        ${d(cross.err(off, 0))} -> ` +
      `${d(cross.err(off, 0.35))} deg        ${d(chase.err(off, 0))} -> ` +
      `${d(chase.err(off, 0.35))} deg`);
  }

  const on = 0, mid = THREE.MathUtils.degToRad(4), wide = THREE.MathUtils.degToRad(9);
  ok('aiming AT the enemy gets help — the case that matters',
    cross.err(on, 0.35) < cross.err(on, 0) * 0.75,
    `${THREE.MathUtils.radToDeg(cross.err(on, 0)).toFixed(2)} -> ` +
    `${THREE.MathUtils.radToDeg(cross.err(on, 0.35)).toFixed(2)} deg`);
  ok('a wild shot outside the cone is not touched at all',
    Math.abs(cross.err(wide, 0.35) - cross.err(wide, 0)) < 1e-12);
  ok('help falls off, so it is weaker further off the target',
    (1 - cross.err(mid, 0.35) / cross.err(mid, 0)) <
    (1 - cross.err(on, 0.35) / cross.err(on, 0)));
  ok('zero strength is genuinely off, not merely small', cross.err(on, 0) === cross.gap);
  ok('it never closes the whole gap at the default setting',
    cross.err(on, 0.35) > cross.gap * 0.5,
    'a fast crosser still has to be led by eye');
  ok('but a tail chase, where the gap is small, is nearly solved',
    chase.err(on, 0.35) < THREE.MathUtils.degToRad(0.5));
  ok('it never picks a team mate',
    applyAimAssist(v3(0, 0, -1), shooter,
      [shooter, { team: 0, dead: false, p: v3(0, 1000, -700), v: v3() }], 1) === null);
  ok('nor a dead one',
    applyAimAssist(v3(0, 0, -1), shooter,
      [shooter, { team: 1, dead: true, p: v3(0, 1000, -700), v: v3() }], 1) === null);
  ok('nor anything beyond gun range',
    applyAimAssist(v3(0, 0, -1), shooter,
      [shooter, { team: 1, dead: false, p: v3(0, 1000, -(COMBAT.gunRange + 400)), v: v3() }],
      1) === null);
  console.log(`  the cone is ${THREE.MathUtils.radToDeg(AIM_CONE).toFixed(1)} degrees wide`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. proportional navigation intercepts rather than chases ---');
// ---------------------------------------------------------------------------
{
  function shoot(targetSpeed, crossing) {
    const p = v3(0, 1000, 0), v = v3(0, 0, -260);
    const tp = v3(crossing ? 1400 : 0, 1000, -3200);
    const tv = crossing ? v3(-targetSpeed, 0, 0) : v3(0, 0, -targetSpeed);
    const lastLos = tp.clone().sub(p).normalize();
    const acc = v3(), grav = v3(0, -G, 0);
    let closest = Infinity, t = 0;
    for (; t < COMBAT.msl.life; t += DT) {
      tp.addScaledVector(tv, DT);
      const range = proNavAccel(acc, p, v, lastLos, tp, tv, DT, COMBAT.msl.N, COMBAT.msl.maxG);
      closest = Math.min(closest, range);
      acc.add(grav);
      if (t < COMBAT.msl.burn) {
        acc.addScaledVector(v, COMBAT.msl.thrust / (COMBAT.msl.mass * Math.max(1, v.length())));
      }
      v.addScaledVector(acc, DT);
      p.addScaledVector(v, DT);
      if (range < COMBAT.msl.fuse) return { hit: true, t, closest };
    }
    return { hit: false, t, closest };
  }
  for (const [name, speed, crossing] of [
    ['a target running away', 120, false],
    ['a fast target running away', 190, false],
    ['a crossing target', 150, true],
  ]) {
    const r = shoot(speed, crossing);
    console.log(`  ${name.padEnd(26)} ${r.hit ? `fused at ${r.t.toFixed(1)} s` : 'missed'}, ` +
      `closest ${r.closest.toFixed(1)} m`);
    ok(`${name}: intercepted`, r.hit, `closest ${r.closest.toFixed(1)} m`);
  }
  ok('the seeker respects its g limit',
    (() => {
      const acc = v3(), lastLos = v3(0, 0, -1);
      proNavAccel(acc, v3(), v3(0, 0, -900), lastLos, v3(3000, 0, -100), v3(0, 0, 400),
        DT, COMBAT.msl.N, COMBAT.msl.maxG);
      return acc.length() <= COMBAT.msl.maxG * G + 1e-6;
    })(), `${COMBAT.msl.maxG} g`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. locking: sides, cone, and what unarmed craft cannot do ---');
// ---------------------------------------------------------------------------
{
  const mk = (id, team, x, z, armed = true) => ({
    id, team, armed, dead: false, p: v3(x, 1000, z), v: v3(),
    fwd: v3(0, 0, -1), lockTarget: null,
  });
  const me = mk(1, 0, 0, 0);
  const ahead = mk(2, 1, 0, -2000);
  const mate = mk(3, 0, 0, -1800);
  const behind = mk(4, 1, 0, 2000);
  const wide = mk(5, 1, 3000, -2000);
  const trainer = mk(6, 1, 0, -1500, false);
  const all = [me, ahead, mate, behind, wide, trainer];

  // scored by boresight angle then range, so the NEAREST thing in the cone wins — and the trainer
  // is nearer than the bandit even though it is harmless
  ok('locks the nearest valid target in the cone', lockCandidate(me, all) === trainer);
  ok('and picks the bandit once the nearer one is gone',
    lockCandidate(me, [me, ahead, mate, behind, wide]) === ahead);
  ok('never locks a team mate', lockCandidate(me, [me, mate]) === null);
  ok('never locks behind', lockCandidate(me, [me, behind]) === null);
  ok('never locks outside the cone', lockCandidate(me, [me, wide]) === null,
    `${(Math.atan2(3000, 2000)).toFixed(2)} rad vs a ${COMBAT.lockCone} rad cone`);
  ok('an unarmed aircraft cannot lock at all — that is what keeps training silent',
    lockCandidate(trainer, all) === null);
  ok('but an unarmed aircraft can be locked', lockCandidate(me, [me, trainer]) === trainer);
  const far = mk(7, 1, 0, -(COMBAT.lockRange + 500));
  ok('and nothing beyond seeker range', lockCandidate(me, [me, far]) === null);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. the threat warning quickens, and keeps quickening ---');
// ---------------------------------------------------------------------------
{
  // Two defects, both found by simulating a closing missile rather than by listening. See the
  // comment on threatCadence for what each one sounded like.
  const state = createThreatWarning();
  const missile = { id: 'm1' };
  const p = v3(0, 1000, 0), v = v3(0, 0, -100);          // us
  const mp = v3(0, 1000, 3200), mv = v3(0, 0, -520);     // it, closing from behind
  let last = Infinity, worstIncrease = 0, solidAt = null;
  const marks = [];
  for (let t = 0; t < 12; t += DT) {
    p.addScaledVector(v, DT); mp.addScaledVector(mv, DT);
    const los = mp.clone().sub(p);
    const dist = los.length();
    const closing = -mv.clone().sub(v).dot(los.normalize());
    const r = threatCadence(state, missile, dist, closing, DT);
    if (r.interval > last + 1e-9) worstIncrease = Math.max(worstIncrease, r.interval - last);
    last = r.interval;
    if (r.solid && solidAt === null) solidAt = dist;
    if (marks.length < 4 && dist < [3000, 1500, 750, 350][marks.length]) {
      marks.push({ dist, rate: 1 / r.interval });
    }
    if (dist < 20) break;
  }
  for (const m of marks) console.log(`  at ${m.dist.toFixed(0)} m: ${m.rate.toFixed(1)} beeps/s`);
  console.log(`  goes solid at ${solidAt ? solidAt.toFixed(0) + ' m' : 'never'}`);
  ok('it only ever speeds up while the missile is closing', worstIncrease === 0,
    `worst slow-down ${worstIncrease.toExponential(1)} s`);
  ok('it ends up much faster than it started', marks[marks.length - 1].rate > marks[0].rate * 3);
  ok('and goes solid before impact', solidAt !== null && solidAt > 20);
}
{
  // ...but a missile that overshoots and starts opening the range must let it wind back down,
  // or the warning screams forever
  const state = createThreatWarning();
  const missile = { id: 'm2' };
  let tight = 0;
  for (let i = 0; i < 60; i++) tight = threatCadence(state, missile, 300 - i * 4, 500, DT).interval;
  let relaxed = tight;
  for (let i = 0; i < 400; i++) relaxed = threatCadence(state, missile, 60 + i * 12, -400, DT).interval;
  console.log(`  after an overshoot the interval relaxes from ${tight.toFixed(3)} s ` +
    `to ${relaxed.toFixed(3)} s`);
  ok('a pure ratchet would have screamed forever; this one relaxes', relaxed > tight * 2);
}

// ---------------------------------------------------------------------------
console.log('\n--- 6. the evaded cue fires on a miss and on nothing else ---');
// ---------------------------------------------------------------------------
{
  const cases = [
    ['a missile that burns out',        'm1', null, false, false, true],
    ['a flare decoy',                   'm1', null, false, false, true],
    ['a harmless wide fuse',            'm1', null, false, false, true],
    ['a missile that hits you',         'm1', null, false, true,  false],
    ['a missile that kills you',        'm1', null, true,  true,  false],
    ['two missiles back to back',       'm1', 'm2', false, false, false],
    ['nothing was ever inbound',        null, null, false, false, false],
  ];
  for (const [name, had, now, dead, sup, expect] of cases) {
    const got = evadedThisFrame(had, now, dead, sup);
    ok(name, got === expect, got ? 'fires' : 'silent');
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- 7. ground site envelopes leave a gap you can fly through ---');
// ---------------------------------------------------------------------------
{
  ok('SAM reaches further than AA', GROUND.sam.range > GROUND.aa.range);
  ok('SAM has a minimum range, so you can get under it', GROUND.sam.minRange > 0);
  ok('AA covers the gap the SAM cannot', GROUND.aa.range > GROUND.sam.minRange);
  const aaDps = GROUND.aa.rps * GROUND.aa.damage;
  console.log(`  AA does ${aaDps} damage a second: a 110 hp plane dies in ` +
    `${(110 / aaDps).toFixed(1)} s inside ${GROUND.aa.range} m`);
  ok('loitering over AA is fatal but not instant', 110 / aaDps > 1.5 && 110 / aaDps < 8);

  const passive = Object.entries(GROUND).filter(([, d]) => d.passive).map(([k]) => k);
  ok('the passive structures really have no weapon', passive.every((k) => !GROUND[k].range));
  ok('nothing armed is marked passive',
    Object.values(GROUND).every((d) => !(d.range > 0 && d.passive)));
  ok('the radar is unarmed but NOT passive — it is what gives the others their reach',
    !GROUND.radar.range && !GROUND.radar.passive);
  ok('the fuel depot is the biggest blast and the softest target',
    GROUND.depot.blast === Math.max(...Object.values(GROUND).map((d) => d.blast)) &&
    GROUND.depot.hp === Math.min(...passive.map((k) => GROUND[k].hp)));
  console.log(`  a depot takes ${(GROUND.depot.hp / (COMBAT.gunRps * COMBAT.gunDamage) * 1000)
    .toFixed(0)} ms of held trigger; an HQ takes ` +
    `${(GROUND.hq.hp / (COMBAT.gunRps * COMBAT.gunDamage) * 1000).toFixed(0)} ms`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 8. the warning is about the missile that arrives first ---');
// ---------------------------------------------------------------------------
{
  const me = { p: new THREE.Vector3(0, 900, 0), v: new THREE.Vector3(0, 0, -180), af: {}, team: 0 };
  const ally = { p: new THREE.Vector3(60, 900, -400), v: new THREE.Vector3(0, 0, -180), af: {}, team: 0 };
  // a missile straight at me, and a slower one far away also straight at me
  const near = { live: true, target: me, p: new THREE.Vector3(0, 900, 700), v: new THREE.Vector3(0, 0, -600) };
  const far = { live: true, target: me, p: new THREE.Vector3(0, 900, 7000), v: new THREE.Vector3(0, 0, -500) };

  const dNear = missileDanger(near, me), dFar = missileDanger(far, me);
  console.log(`  near missile ${dNear.tti.toFixed(1)} s out, far missile ${dFar.tti.toFixed(1)} s out`);
  ok('the reported symptom is reproducible: one reads under 2 s, the other over 10',
    dNear.tti < 2 && dFar.tti > 10);

  // the rule this replaced: whichever live slot came last. Kept as a regression witness.
  const lastInPool = (list) => { let t = null; for (const m of list) if (m.live && m.target === me) t = m; return t; };
  ok('last-in-pool really did report the far missile while the near one was arriving',
    lastInPool([near, far]) === far);

  // pool order is arbitrary, so the answer must not depend on it
  ok('picks the near one when the far one is later in the pool',
    pickThreat([near, far], me).missile === near);
  ok('picks the near one when the far one is EARLIER in the pool',
    pickThreat([far, near], me).missile === near);
  ok('a dead pool slot is ignored',
    pickThreat([{ ...far, live: false }, near], me).missile === near);
  ok('nothing inbound reads as no threat', pickThreat([{ ...near, live: false }], me) === null);

  // a missile chasing someone else, passing close enough that its blast reaches me
  const passing = { live: true, target: ally, p: new THREE.Vector3(30, 900, 900), v: new THREE.Vector3(0, 0, -700) };
  const wide = { live: true, target: ally, p: new THREE.Vector3(900, 900, 900), v: new THREE.Vector3(0, 0, -700) };
  const dPass = missileDanger(passing, me);
  ok('a missile aimed at my wingman that will pass inside the blast radius is a threat', !!dPass);
  ok('and it is flagged as passing, not aimed at me', dPass && dPass.aimed === false);
  ok('one passing wide is not a threat', missileDanger(wide, me) === null);
  ok('the blast radius is wider than the fuse, which is why passing counts',
    COMBAT.msl.blast > COMBAT.msl.fuse);

  // opening the range
  const going = { live: true, target: ally, p: new THREE.Vector3(0, 900, -400), v: new THREE.Vector3(0, 0, -700) };
  ok('a missile opening the range is not a passing threat', missileDanger(going, me) === null);
  const chasing = { live: true, target: me, p: new THREE.Vector3(0, 900, 400), v: new THREE.Vector3(0, 0, -700) };
  ok('but one aimed at me stays a threat from any aspect', !!missileDanger(chasing, me));

  // an aimed missile always outranks a passing one at the same distance
  const aimedFar = { live: true, target: me, p: new THREE.Vector3(0, 900, 900), v: new THREE.Vector3(0, 0, -700) };
  const picked = pickThreat([aimedFar, passing], me);
  console.log(`  head-on aimed ${missileDanger(aimedFar, me).tti.toFixed(2)} s vs ` +
    `passing ${dPass.tti.toFixed(2)} s`);
  ok('between two at similar range the sooner one wins regardless of aspect',
    picked.tti <= Math.min(missileDanger(aimedFar, me).tti, dPass.tti) + 1e-9);
}

// ---------------------------------------------------------------------------
console.log('\n--- 8b. intercepting solves for the soonest meeting, not just any meeting ---');
// ---------------------------------------------------------------------------
{
  const out = new THREE.Vector3();
  // a missile overhauling from astern: turning round to meet it beats letting it catch up
  const t = interceptPoint(out, new THREE.Vector3(0, 1000, -20),
    new THREE.Vector3(0, 1000, 2600), new THREE.Vector3(0, 0, -620), 300);
  ok('picks the head-on root, not the stern-chase one', t > 2.5 && t < 3.2, `${t.toFixed(2)} s`);
  ok('and the aim point is behind the chaser, which is what makes it turn', out.z > 0);

  // a gun shell against a crosser: only one root, and it should match the iterated solver closely
  const from = new THREE.Vector3(0, 1000, 0);
  const tp = new THREE.Vector3(0, 1000, -900), tv = new THREE.Vector3(210, 0, 0);
  const tq = interceptPoint(out, from, tp, tv, COMBAT.gunSpeed);
  const lead = new THREE.Vector3();
  const tl = leadPoint(lead, from, tp, tv, COMBAT.gunSpeed, 0);
  ok('agrees with the gun solver where the gun solver is right', Math.abs(tq - tl) < 0.01,
    `${tq.toFixed(4)} s vs ${tl.toFixed(4)} s`);

  ok('returns null when the chaser can never catch it',
    interceptPoint(out, from, new THREE.Vector3(0, 1000, -100), new THREE.Vector3(0, 0, -900), 100) === null);
}

// ---------------------------------------------------------------------------
console.log('\n--- 9. a missile can be beaten, and only by breaking early ---');
// ---------------------------------------------------------------------------
{
  // This is the one thing in the file that flies the real aircraft model, because "can you dodge it"
  // is not a property of the missile alone. Before speed-dependent g and induced drag, a full break
  // turn changed the miss distance from 5 m to 6 m at every launch range: there was no answer.
  const run = (launchRange, tactic) => {
    const f = makeFlyer('plane');
    f.p.set(0, 1200, 0);
    f.v.set(0, 0, -f.af.trimSpeed);
    f.airspeed = f.af.trimSpeed;
    syncAxes(f);
    const m = {
      live: true, age: 0, target: f,
      p: new THREE.Vector3(0, 1220, launchRange),
      v: new THREE.Vector3(0, 0, -f.af.trimSpeed - 40),
      lastLos: new THREE.Vector3(),
    };
    m.lastLos.copy(f.p).sub(m.p).normalize();
    let miss = Infinity, t = 0;
    for (let i = 0; i < 60 * 40; i++) {
      t += 1 / 60;
      f.input.pitch = 0; f.input.roll = 0; f.input.yaw = 0; f.input.throttle = 1;
      if (tactic === 'break') {
        if (t < 0.5) f.input.roll = 1;
        else { f.input.roll = 0.25; f.input.pitch = -1; }
      } else if (tactic === 'late' && f.p.distanceTo(m.p) < 900) {
        f.input.roll = 1;
        if (t > 0.3) f.input.pitch = -1;
      }
      stepFlyer(f, 1 / 60, true);
      if (f.p.y < 40) break;
      const st = stepMissile(m, 1 / 60);
      miss = Math.min(miss, f.p.distanceTo(m.p));
      if (st.fused || m.age > COMBAT.msl.life) break;
    }
    const dmg = miss < COMBAT.msl.blast ? COMBAT.msl.damage * (1 - miss / COMBAT.msl.blast) : 0;
    return { miss, dmg, hp: f.af.hp, lethal: dmg >= f.af.hp };
  };

  const hp = makeFlyer('plane').af.hp;
  for (const r of [800, 2000, 3600]) {
    const s = run(r, 'straight'), b = run(r, 'break'), l = run(r, 'late');
    console.log(`  launched ${String(r).padStart(4)} m — straight ${s.miss.toFixed(0).padStart(4)} m/` +
      `${s.dmg.toFixed(0).padStart(3)} dmg   break ${b.miss.toFixed(0).padStart(4)} m/` +
      `${b.dmg.toFixed(0).padStart(3)} dmg   late ${l.miss.toFixed(0).padStart(4)} m/` +
      `${l.dmg.toFixed(0).padStart(3)} dmg   (hp ${hp})`);
  }

  // NOT at every range: past about 3 km the missile runs out of energy before it arrives, so a
  // straight run already beats it and turning only drags it closer. The claim only holds where the
  // shot could actually reach you, which is the range band the AI shoots from.
  ok('breaking beats flying straight wherever the shot can reach you',
    [800, 2000].every((r) => run(r, 'break').miss > run(r, 'straight').miss));
  ok('breaking early beats breaking late at every range',
    [800, 2000, 3600].every((r) => run(r, 'break').miss > run(r, 'late').miss));
  ok('the further out it was launched, the better a break works',
    run(3600, 'break').miss > run(2000, 'break').miss &&
    run(2000, 'break').miss > run(800, 'break').miss);
  ok('a knife-range shot still kills through a break', run(800, 'break').lethal);
  ok('a long shot does not, if you turn at once', !run(3600, 'break').lethal);
  ok('leaving it late is always fatal', [800, 2000, 3600].every((r) => run(r, 'late').lethal));
  ok('and so is doing nothing at the ranges the AI actually shoots from',
    run(800, 'straight').lethal && run(2000, 'straight').lethal);

  // the mechanism, not just the outcome
  ok('a slow missile has less g than a fast one',
    missileMaxG(250) < missileMaxG(500) && missileMaxG(250) < COMBAT.msl.maxG * 0.4);
  ok('it still gets its full rating at design speed', missileMaxG(COMBAT.msl.gRef) === COMBAT.msl.maxG);
  console.log('  available g: ' + [600, 450, 300, 200].map(
    (s) => `${s} m/s ${missileMaxG(s).toFixed(1)}g`).join('   '));

  // started past burnout, or this measures the boost rather than the bleed
  const straightBleed = (() => {
    const m = {
      live: true, age: COMBAT.msl.burn + 0.01, target: null,
      p: new THREE.Vector3(0, 1200, 0), v: new THREE.Vector3(0, 0, -500),
      lastLos: new THREE.Vector3(0, 0, -1),
    };
    for (let i = 0; i < 60 * 6; i++) stepMissile(m, 1 / 60);
    return m.v.length();
  })();
  ok('a coasting missile keeps most of its speed — the big loss is the price of turning',
    straightBleed > 300, `${straightBleed.toFixed(0)} m/s after 6 s coasting from 500`);
}

// ---------------------------------------------------------------------------
console.log('\n--- guns belong to the aircraft, not to the module ---');
// ---------------------------------------------------------------------------
{
  ok('the default gun is exactly the numbers everybody used to share',
    GUNS.cannon.speed === COMBAT.gunSpeed && GUNS.cannon.rps === COMBAT.gunRps
    && GUNS.cannon.damage === COMBAT.gunDamage && GUNS.cannon.spread === COMBAT.gunSpread
    && GUNS.cannon.range === COMBAT.gunRange && GUNS.cannon.ammo === COMBAT.ammoMax,
    'so an aircraft that names no gun flies unchanged');

  ok('a craft with no gun named gets it', gunFor(undefined) === GUNS.cannon);
  let threw = false;
  try { gunFor('vulcan'); } catch (e) { threw = /unknown gun/.test(e.message); }
  ok('and an unknown one throws rather than quietly arming the default', threw);

  // the A-10's whole identity is this ratio
  const dps = (g) => g.rps * g.damage;
  ok('the GAU-8 is an order of magnitude more gun than the cannon',
    dps(GUNS.gau8) > dps(GUNS.cannon) * 8,
    `${dps(GUNS.gau8)} damage/s against ${dps(GUNS.cannon)}`);
  ok('and carries a proportionate 18 seconds of it',
    Math.abs(GUNS.gau8.ammo / GUNS.gau8.rps - 18) < 1.5,
    `${(GUNS.gau8.ammo / GUNS.gau8.rps).toFixed(1)} s of trigger`);

  // the flyer resolves it once and carries it, the way a bomb carries its def
  registerAirframe('gunprobe', { ...airframeFor('a10'), label: 'Gun probe' });
  const f = makeFlyer('gunprobe', {});
  ok('a flyer carries its resolved gun', f.gun === GUNS.gau8);
  ok('and spawns with that gun\'s magazine, not a global one', f.ammo === GUNS.gau8.ammo,
    `${f.ammo} rounds`);
  const plain = makeFlyer('plane', {});
  ok('while a craft naming no gun still gets 900 of the light one',
    plain.gun === GUNS.cannon && plain.ammo === 900);

  // aim assist has to lead with the SHOOTER's shell speed, or a fast gun is led like a slow one
  const fast = { ...plain, gun: GUNS.gau8, p: v3(0, 1000, 0), fwd: v3(0, 0, -1), team: 0 };
  const slow = { ...plain, gun: GUNS.cannon, p: v3(0, 1000, 0), fwd: v3(0, 0, -1), team: 0 };
  const target = { p: v3(0, 1000, -1200), v: v3(160, 0, 0), dead: false, team: 1 };
  const aimA = v3(0, 0, -1), aimB = v3(0, 0, -1);
  applyAimAssist(aimA, fast, [target], 1);
  applyAimAssist(aimB, slow, [target], 1);
  ok('a faster shell needs less lead than a slower one', aimA.x < aimB.x,
    `${aimA.x.toFixed(4)} against ${aimB.x.toFixed(4)}`);
  delete AIRFRAMES.gunprobe;
}

// ---------------------------------------------------------------------------
console.log('\n--- the fire rate must not depend on the frame rate ---');
//
// `fireGun` lives in the viewer, which needs a GPU, so this reads its source. Crude, and the
// alternative was leaving the one property that a 65 rps gun breaks entirely unguarded: it is
// called once a frame, so before this it could never exceed the frame rate. 22 rps was safely under
// 60 and nobody noticed. 65 would have fired at 60 on a good machine and 30 on a bad one.
// ---------------------------------------------------------------------------
{
  const src = readFileSync('./demos/flight-sim.html', 'utf8');
  const body = src.slice(src.indexOf('function fireGun'), src.indexOf('function fireMount'));

  ok('fireGun spends the cooldown in a loop rather than firing once',
    /while\s*\(\s*f\.gunCool\s*<=\s*0/.test(body));
  ok('and ACCUMULATES the cooldown instead of resetting it',
    /f\.gunCool\s*\+=\s*step/.test(body) && !/f\.gunCool\s*=\s*1\s*\//.test(body),
    'resetting would round the rate down to the frame rate');
  ok('with a cap, so a long frame cannot dump an unbounded burst',
    /fired\s*<\s*MAX_BURST/.test(body));
  ok('and it still does not decrement the cooldown itself',
    !/f\.gunCool\s*-=/.test(body),
    'the flyer loop owns that; doing both once ran the gun at 44 rps against a table saying 22');
  ok('the sound fires once per call, not once per round',
    (body.match(/playSfx\('gun'/g) || []).length === 1 && body.indexOf("playSfx('gun'") > body.indexOf('while'));

  // the debt has to be floored somewhere, or a trigger pulled after a long pause empties the backlog
  ok('the per-frame decrement floors the cooldown debt',
    /f\.gunCool\s*=\s*Math\.max\(\s*-?[\d.]+\s*,\s*f\.gunCool\s*-\s*dt\s*\)/.test(src));

  // a 65 rps gun reaching 3.6 km holds ~234 rounds in the air on its own
  const pool = Number((src.match(/const MAX_BULLETS = (\d+)/) || [])[1]);
  const inFlight = GUNS.gau8.rps * (GUNS.gau8.range / GUNS.gau8.speed);
  ok('the bullet pool holds more than one A-10 can put in the air', pool > inFlight * 2,
    `${pool} slots against ${inFlight.toFixed(0)} rounds aloft from a single burst`);

  // and the round has to carry its own damage, since it outlives the aircraft that fired it
  ok('rounds carry their own damage', /b\.damage\s*=\s*gun\.damage/.test(src));
  ok('and the hit path spends that rather than a module constant',
    /damage\(o, b\.damage/.test(src) && /damageSite\(g, b\.damage/.test(src));
}

// ---------------------------------------------------------------------------
console.log('\n--- bombs: the pipper is the weapon ---');
//
// A bomb cannot be aimed once released, so the only thing that decides a hit is whether the
// predicted impact point matches the real one. Everything here is a version of that question.
// ---------------------------------------------------------------------------

// Flies a released store to the ground the way the viewer does, and reports where it landed.
function dropTo(from, vel, def, maxT = 60) {
  const b = { p: from.clone(), v: vel.clone(), def, age: 0 };
  for (let t = 0; t < maxT; t += DT) {
    stepBomb(b, DT);
    if (b.p.y <= heightAt(b.p.x, b.p.z)) return { p: b.p, t: b.age };
  }
  return null;
}

{
  const from = v3(0, 900, 0);
  const vel = v3(0, 0, -140);            // level, 140 m/s, heading north

  // THE central assertion of the whole feature: the marker and the bomb agree.
  for (const kind of BOMB_KINDS) {
    const def = BOMBS[kind];
    const pred = v3();
    const tPred = bombImpact(pred, from, vel, def);
    const real = dropTo(from, vel, def);
    const miss = real ? pred.distanceTo(real.p) : Infinity;
    ok(`${kind}: the pipper lands where the bomb lands`, miss < 2.0,
      `${miss.toFixed(2)} m apart, ${tPred.toFixed(1)} s fall`);
    ok(`${kind}: and agrees about when`, Math.abs(tPred - real.t) < 0.15,
      `predicted ${tPred.toFixed(2)} s, flew ${real.t.toFixed(2)} s`);
  }

  // Drag is what separates the two stores. Without it they would land in the same place and the
  // second kind would be a label rather than a weapon.
  const gp = v3(), hv = v3();
  bombImpact(gp, from, vel, BOMBS.gp);
  bombImpact(hv, from, vel, BOMBS.heavy);
  const gpThrow = Math.hypot(gp.x - from.x, gp.z - from.z);
  const hvThrow = Math.hypot(hv.x - from.x, hv.z - from.z);
  ok('the cleaner store is thrown further from the same release', hvThrow > gpThrow + 40,
    `gp ${gpThrow.toFixed(0)} m, heavy ${hvThrow.toFixed(0)} m`);

  // ...and drag is doing real work, not rounding. A vacuum parabola is the wrong answer.
  const vac = Math.sqrt(2 * (from.y - heightAt(0, 0)) / G) * 140;
  ok('and drag costs a large part of the vacuum throw', gpThrow < vac * 0.92,
    `vacuum would be ${vac.toFixed(0)} m, gp reaches ${gpThrow.toFixed(0)} m`);
}

{
  // Release higher and the store lands further away and later — the whole skill of the delivery.
  const vel = v3(0, 0, -140);
  const lo = v3(), hi = v3();
  const tLo = bombImpact(lo, v3(0, 300, 0), vel, BOMBS.gp);
  const tHi = bombImpact(hi, v3(0, 1500, 0), vel, BOMBS.gp);
  ok('a higher release throws further and takes longer',
    Math.hypot(hi.x, hi.z) > Math.hypot(lo.x, lo.z) && tHi > tLo,
    `${Math.hypot(lo.x, lo.z).toFixed(0)} m in ${tLo.toFixed(1)} s vs ${Math.hypot(hi.x, hi.z).toFixed(0)} m in ${tHi.toFixed(1)} s`);

  // A dive throws it SHORT of a level release at the same speed, which is the part that catches
  // people out: the store is already going down, so it arrives sooner and travels less.
  const level = v3(), dive = v3();
  bombImpact(level, v3(0, 900, 0), v3(0, 0, -140), BOMBS.gp);
  bombImpact(dive, v3(0, 900, 0), v3(0, -70, -121), BOMBS.gp);
  ok('a dive release falls short of a level one at the same speed',
    Math.hypot(dive.x, dive.z) < Math.hypot(level.x, level.z),
    `dive ${Math.hypot(dive.x, dive.z).toFixed(0)} m, level ${Math.hypot(level.x, level.z).toFixed(0)} m`);
}

{
  // The predictor has to survive being asked about ground it cannot reach, and about a release
  // already underground — both happen on a low pass over rising terrain.
  const out = v3();
  ok('a store released at ground level impacts immediately',
    bombImpact(out, v3(500, heightAt(500, 500) - 1, 500), v3(0, 0, -100), BOMBS.gp) === 0);
  ok('and a climb steep enough to never come down inside the horizon reports nothing',
    bombImpact(out, v3(0, 900, 0), v3(0, 400, 0), BOMBS.gp, { maxT: 3 }) === null);
}

{
  // Frame rate must not move the impact point. The store steps on its own fixed substep precisely
  // so a 30 fps client and a 144 fps one bomb the same place.
  const a = dropTo(v3(0, 900, 0), v3(0, 0, -140), BOMBS.gp);
  const b = { p: v3(0, 900, 0), v: v3(0, 0, -140), def: BOMBS.gp, age: 0 };
  for (let t = 0; t < 60; t += 1 / 15) {
    stepBomb(b, 1 / 15);
    if (b.p.y <= heightAt(b.p.x, b.p.z)) break;
  }
  ok('a 15 fps client bombs the same place as a 60 fps one', a.p.distanceTo(b.p) < 1.0,
    `${a.p.distanceTo(b.p).toFixed(2)} m apart`);
}

// ---------------------------------------------------------------------------
console.log('\n--- mounts: guns that are not in the nose ---');
//
// A gunship's battery fires out of the left side at a point on the ground, from a platform that is
// itself moving, with a shell slow enough to drop a hundred metres on the way. Every one of those
// is a way for the reticle and the round to disagree, and the reticle is the weapon.
// ---------------------------------------------------------------------------

// Flies a round the way the viewer's bullet loop does: straight, plus a fraction of gravity.
function flyRound(from, vel, maxT = 30) {
  const p = from.clone(), v = vel.clone(), prev = from.clone();
  for (let t = 0; t < maxT; t += DT) {
    prev.copy(p);
    v.y -= G * DT * SHELL_GRAVITY;
    p.addScaledVector(v, DT);
    const under = p.y - heightAt(p.x, p.z);
    if (under <= 0) {
      // a 1,050 m/s round moves 17 m a step, so the crossing is interpolated, not the sample after it
      const over = prev.y - heightAt(prev.x, prev.z);
      const k = over / (over - under);
      return { p: prev.lerp(p, k), t: t + DT * k };
    }
  }
  return null;
}

{
  ok('the battery is three guns of three calibres',
    GUNS.m25 && GUNS.l60 && GUNS.m102 && GUNS.m25.speed > GUNS.l60.speed && GUNS.l60.speed > GUNS.m102.speed);
  ok('only the shells carry a blast', !GUNS.m25.blast && GUNS.l60.blast > 0 && GUNS.m102.blast > GUNS.l60.blast);
  ok('the nose gun table did not change', GUNS.cannon.blast === undefined && GUNS.gau8.blast === undefined);
  ok("'none' is the legal way to say no nose gun", gunFor('none') === null);

  const gunship = {
    ...airframeFor('a10'), label: 'Gunship probe', gun: 'none',
    mounts: [
      { id: 'g25', gun: 'm25', pos: [-1.5, -0.4, -2.0], dir: [-1, -0.25, 0], arc: 0.5 },
      { id: 'g40', gun: 'l60', pos: [-1.6, -0.5, 1.5], dir: [-1, -0.25, 0], arc: 0.5 },
      { id: 'g105', gun: 'm102', pos: [-1.6, -0.6, 4.0], dir: [-1, -0.25, 0], arc: 0.35 },
    ],
  };
  registerAirframe('gunship', gunship);
  const f = makeFlyer('gunship', {});
  ok('a gunship has no nose gun and no nose ammo', f.gun === null && f.ammo === 0);
  ok('and one live mount per descriptor, each with its own magazine',
    f.mounts.length === 3 && f.mounts[0].ammo === GUNS.m25.ammo && f.mounts[2].ammo === GUNS.m102.ammo);
  ok('mounts are independent state, not shared', f.mounts[0].cool === 0 && (f.mounts[0].cool = 3, f.mounts[1].cool === 0));
  ok('a plane without mounts gets an empty list, not undefined', Array.isArray(makeFlyer('plane', {}).mounts));

  let threw = false;
  try { registerAirframe('badmount', { ...gunship, mounts: [{ id: 'x', gun: 'm25', pos: [0, 0] }] }); }
  catch (e) { threw = /pos and dir/.test(e.message); }
  ok('a mount with a malformed position is rejected at registration', threw);
  registerAirframe('gunship2', { ...gunship, mounts: [{ id: 'x', gun: 'vulcan', pos: [0, 0, 0], dir: [-1, 0, 0] }] });
  threw = false;
  try { makeFlyer('gunship2', {}); } catch (e) { threw = /unknown gun/.test(e.message); }
  ok('and an unknown mount gun throws at construction, naming the gun', threw);
  delete AIRFRAMES.gunship2;

  // The muzzle: layout z is aft, so a mount at z = +4 sits BEHIND the centre. Roll the aircraft 90°
  // left and the port side is now underneath.
  f.p.set(0, 1000, 0); f.q.identity(); syncAxes(f);
  const o = v3();
  mountOrigin(o, f, f.mounts[2]);
  ok('the 105 sits on the port side, low, and aft of centre',
    Math.abs(o.x + 1.6) < 1e-6 && Math.abs(o.y - 999.4) < 1e-6 && Math.abs(o.z - 4.0) < 1e-6,
    `${o.x.toFixed(2)}, ${o.y.toFixed(2)}, ${o.z.toFixed(2)}`);
  f.q.setFromAxisAngle(v3(0, 0, -1), -Math.PI / 2); syncAxes(f);   // roll 90° left (port wing down)
  mountOrigin(o, f, f.mounts[2]);
  ok('roll the aircraft onto its side and the port muzzle is underneath it', o.y < 1000 - 1.5,
    `y = ${o.y.toFixed(2)}`);
  const bs = v3();
  mountBoresight(bs, f, f.mounts[2]);
  ok('and its boresight now points mostly at the ground', bs.y < -0.9, `y = ${bs.y.toFixed(3)}`);
  f.q.identity(); syncAxes(f);

  // The arc: a wanted direction inside it is left alone, one outside is walked to the rim.
  const want = v3(-1, -0.25, 0).normalize();
  ok('a direction on the boresight is inside the arc', clampToArc(want, f, f.mounts[0]));
  want.set(0, 0, -1);      // straight ahead — 90° off a port-facing gun
  const inside = clampToArc(want, f, f.mounts[0]);
  mountBoresight(bs, f, f.mounts[0]);
  const angAfter = Math.acos(bs.dot(want));
  ok('one dead ahead is outside, and is trained to the rim, not to the boresight',
    !inside && Math.abs(angAfter - 0.5) < 1e-3 && want.z < -0.3,
    `${(angAfter * 180 / Math.PI).toFixed(1)}° off boresight, z ${want.z.toFixed(2)}`);

  // THE central assertion: aim with the solution, fly the round the way the viewer does, land on the
  // point. From a moving platform, for all three calibres, at a gunship's stand-off.
  f.p.set(0, 2200 + heightAt(0, 0), 0);
  f.v.set(0, 0, -95);       // 340 km/h, heading north; the target is off the left wing
  const tgt = v3(-3200, 0, 0); tgt.y = heightAt(tgt.x, tgt.z);
  for (const m of f.mounts) {
    mountOrigin(o, f, m);
    const aim = v3();
    const tof = ballisticAim(aim, o, tgt, m.gun.speed, f.v, G * SHELL_GRAVITY);
    const land = flyRound(o, aim.clone().multiplyScalar(m.gun.speed).add(f.v));
    const miss = land ? land.p.distanceTo(tgt) : Infinity;
    ok(`${m.gun.label}: the round lands where the solution said, from a moving aircraft`, miss < 3,
      `${miss.toFixed(2)} m off, ${tof?.toFixed(2)} s, barrel at ${(Math.asin(aim.y) * 180 / Math.PI).toFixed(1)}° elevation`);
    ok(`${m.gun.label}: and the time of flight agrees`, land && Math.abs(land.t - tof) < 0.1,
      `${land?.t.toFixed(2)} s flown`);
  }
  // A slow shell must be aimed HIGHER than a fast one at the same point, or gravity is not in it.
  const a25 = v3(), a105 = v3();
  mountOrigin(o, f, f.mounts[0]);
  ballisticAim(a25, o, tgt, GUNS.m25.speed, f.v, G * SHELL_GRAVITY);
  ballisticAim(a105, o, tgt, GUNS.m102.speed, f.v, G * SHELL_GRAVITY);
  ok('the 105 is held higher than the 25 for the same target', a105.y > a25.y + 0.02,
    `${(Math.asin(a105.y) * 180 / Math.PI).toFixed(1)}° against ${(Math.asin(a25.y) * 180 / Math.PI).toFixed(1)}°`);
  // The platform velocity matters: ignore it and the round lands downrange of the aim.
  const still = v3();
  ballisticAim(still, o, tgt, GUNS.m102.speed, v3(), G * SHELL_GRAVITY);
  const landStill = flyRound(o, still.clone().multiplyScalar(GUNS.m102.speed).add(f.v));
  ok('a solution that ignored the aircraft\'s own speed misses by the drift', landStill.p.distanceTo(tgt) > 100,
    `${landStill.p.distanceTo(tgt).toFixed(0)} m off`);
  // Beyond reach it says so rather than firing short.
  ok('a target the muzzle speed cannot reach reports null',
    ballisticAim(v3(), o, v3(-120000, 0, 0), GUNS.m102.speed, f.v, G * SHELL_GRAVITY) === null,
    'at a third of g the 105 reaches sixty-odd kilometres, so this has to be far');
  delete AIRFRAMES.gunship;
}

{
  // The viewer's mount fire path has to keep every rule the nose gun learned the hard way.
  const src = readFileSync('./demos/flight-sim.html', 'utf8');
  const body = src.slice(src.indexOf('function fireMount'), src.indexOf('function detonateRound'));
  ok('fireMount exists and spends the mount\'s own cooldown in a loop', /while\s*\(\s*m\.cool\s*<=\s*0/.test(body));
  ok('accumulating, capped, and never decrementing itself',
    /m\.cool\s*\+=\s*step/.test(body) && /fired\s*<\s*MAX_BURST/.test(body) && !/m\.cool\s*-=/.test(body));
  ok('the flyer loop floors every mount\'s debt', /m\.cool\s*=\s*Math\.max\(\s*-?[\d.]+\s*,\s*m\.cool\s*-\s*dt\s*\)/.test(src));
  ok('it aims with the ballistic solution and trains into the arc',
    /ballisticAim\(/.test(body) && /clampToArc\(/.test(body));
  ok('it refuses to fire at a point it cannot reach', /tof === null\)\s*return/.test(body));
  ok('rounds carry their blast and a shell detonates on any contact',
    /b\.blast\s*=\s*gun\.blast/.test(src) && /if \(shell\) detonateRound\(b\)/.test(src));
  ok('and the nose gun and the mounts spawn rounds through the same function',
    (src.match(/spawnRound\(f, gun, _muzzle/g) || []).length === 2);

  // The arc lock: the sight line is clamped into a shrunk copy of the mount's cone and written back
  // to yaw/pitch, and it keeps pulling in while the ballistic solution is still outside the arc.
  const gb = src.slice(src.indexOf('function lockAimToArc'), src.indexOf('function fireGunner'));
  ok('arc lock is on by default and L toggles it', /arcLock:\s*true/.test(src) && /'KeyL'[^\n]*toggleArcLock\(\)/.test(src));
  ok('the lock clamps through clampToArc on a shrunk arc and writes yaw/pitch back',
    /_gLockM\.arc\s*=\s*m\.arc\s*\*\s*margin/.test(gb) && /clampToArc\(_gAim, f, _gLockM\)/.test(gb) && /gunner\.yaw\s*=/.test(gb) && /gunner\.pitch\s*=/.test(gb));
  ok('and pulls in further while the solution is out of arc', /!gunner\.inArc;\s*margin\s*-=/.test(gb));
  ok('the HUD draws the arc rim and the lock state', /drawArcRim\(w, h, f, m\)/.test(src) && /'ARC LOCK' : 'ARC FREE'/.test(src));

  // The weapons panel edits the defs the fire paths read, so the reloads must BE def fields.
  ok('missile and flare reloads are def fields, not literals',
    /f\.mslCool = COMBAT\.msl\.cool/.test(src) && /f\.flareCool = COMBAT\.flare\.cool/.test(src)
    && typeof COMBAT.msl.cool === 'number' && typeof COMBAT.flare.cool === 'number');
  ok('every trigger, selector, rack and the gunner mount list read the active set',
    /function fireSelected\(f\) \{ if \(isActive\(/.test(src) && /function deploySelected\(f\) \{ if \(isActive\(/.test(src)
    && /nextActive\(list, cur\)/.test(src) && /if \(!isActive\(list\[i\]\.key\)\)/.test(src)
    && /function gunnerMounts\(\) \{ return activeMounts\.length/.test(src));
  ok('the default active set follows armable, the gun and af.loadout',
    /if \(!f\.af\.armable\) return false/.test(src) && /if \(key === 'gun'\) return !!f\.gun/.test(src)
    && /f\.af\.loadout \? f\.af\.loadout\.includes\(key\) : true/.test(src));
}

{
  // `loadout` is validated like `mounts`: a list of store keys or nothing.
  const base = { ...getAirframe('plane') };
  ok('a loadout list of strings passes', validateAirframe('x', { ...base, loadout: ['flare', 'gun'] }).length === 0);
  ok('a non-list loadout is rejected', validateAirframe('x', { ...base, loadout: 'flare' }).some((m) => /loadout/.test(m)));
  ok('the AC-130 registers with flares only on the racks',
    Array.isArray(airframeFor('ac130').loadout) && airframeFor('ac130').loadout.join() === 'flare'
    && validateAirframe('ac130', airframeFor('ac130')).length === 0);
}

{
  // clampToArc reads only dir+arc, so the shim the lock hands it behaves like a narrower mount.
  const f = { right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), fwd: new THREE.Vector3(0, 0, -1) };
  const m = { dir: new THREE.Vector3(-1, 0, 0), arc: 0.5 };
  const shim = { dir: m.dir, arc: m.arc * 0.9 };
  const d = new THREE.Vector3(-Math.cos(0.48), 0, -Math.sin(0.48));
  ok('a direction inside the full arc but outside the shrunk one is clamped by the shim',
    clampToArc(d.clone(), f, m) === true && clampToArc(d, f, shim) === false);
  ok('to the shrunk rim, on the same side it came from',
    Math.abs(Math.acos(-d.x) - 0.45) < 1e-6 && d.z < 0);
}

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
