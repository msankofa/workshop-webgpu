// test-flight-model.mjs — the flight model, flown headlessly.
//
// Every case here is a whole flight, not a unit call: the model is a closed loop, so an assertion
// on one force in isolation says almost nothing. This suite is what caught the five bugs listed in
// docs/subsystems/flight.md, every one of which would have looked like nothing in particular on
// screen.
//
//   node test-flight-model.mjs

import * as THREE from 'three';
import { AIRFRAMES, G } from './flight-airframes.js';
import {
  makeFlyer, stepFlyer, syncAxes, resetFlyer,
  startWreck, stepWreck, killMakesWreck, WRECK,
} from './flight-model.js';
import { heightAt, agl } from './flight-terrain.js';

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const DT = 1 / 60;

// Flies a craft for `secs` and reports what happened. `drive` gets (f, t) each step and sets inputs.
function fly(afKey, secs, drive, opts = {}) {
  const f = makeFlyer(afKey, opts);
  if (opts.speed !== undefined) f.v.copy(f.fwd).multiplyScalar(opts.speed);
  if (opts.throttle !== undefined) f.throttle = opts.throttle;
  const start = { y: f.p.y, speed: f.v.length() };
  let minAgl = Infinity, maxSpeed = 0, maxStall = 0, invertedSteps = 0, steps = 0;
  for (let t = 0; t < secs; t += DT, steps++) {
    if (drive) drive(f, t);
    stepFlyer(f, DT, opts.assist !== false);
    if (!Number.isFinite(f.p.y) || !Number.isFinite(f.v.x)) {
      return { f, start, blewUp: true, minAgl, maxSpeed, maxStall, inverted: 1, steps };
    }
    minAgl = Math.min(minAgl, agl(f.p));
    maxSpeed = Math.max(maxSpeed, f.v.length());
    maxStall = Math.max(maxStall, f.stallFrac);
    if (f.up.y < 0) invertedSteps++;
    if (f.crashed) break;
  }
  return {
    f, start, blewUp: false, minAgl, maxSpeed, maxStall, steps,
    inverted: steps ? invertedSteps / steps : 0,
  };
}

// ---------------------------------------------------------------------------
console.log('--- 1. plane trim: does it hold altitude hands-off ---');
// ---------------------------------------------------------------------------
{
  // Trim used to seek ZERO angle of attack, which is zero lift, so an untouched aircraft sank
  // 780 m in 30 s. The fix seeks the AoA that supports 1 g, blended toward the airframe's
  // REFERENCE speed — which buys speed stability, and that has a consequence worth asserting
  // rather than working around: hands-off, THROTTLE CONTROLS CLIMB AND THE STICK CONTROLS SPEED,
  // the way a real aircraft is flown. So the test is not "it holds altitude at some throttle" —
  // that would only be true at one throttle. It is that climb rate rises monotonically with
  // throttle while the speed stays pinned near the trim speed.
  const sweep = [0.15, 0.25, 0.4, 0.55, 0.7].map((thr) => {
    const r = fly('plane', 40, null, { throttle: thr });
    return { thr, drift: r.f.p.y - r.start.y, speed: r.f.airspeed, crashed: r.f.crashed,
      inverted: r.inverted };
  });
  for (const s of sweep) {
    console.log(`  throttle ${s.thr.toFixed(2)}: ${s.drift >= 0 ? '+' : ''}${s.drift.toFixed(0)} m ` +
      `over 40 s at ${s.speed.toFixed(0)} m/s`);
  }
  ok('nothing crashes or inverts hands-off',
    sweep.every((s) => !s.crashed && s.inverted === 0));
  ok('climb rate rises with throttle, monotonically',
    sweep.every((s, i) => i === 0 || s.drift > sweep[i - 1].drift));
  ok('there is a real level-flight throttle, not just "climbs or sinks"',
    sweep.some((s) => s.drift < 0) && sweep.some((s) => s.drift > 0));
  ok('speed stays pinned near the trim speed across the whole sweep',
    sweep.every((s) => Math.abs(s.speed - AIRFRAMES.plane.trimSpeed) < 40),
    `${sweep[0].speed.toFixed(0)}-${sweep[sweep.length - 1].speed.toFixed(0)} m/s ` +
    `against a trim speed of ${AIRFRAMES.plane.trimSpeed}`);
  ok('and it never sinks the way the original bug did', sweep.every((s) => s.drift > -780));
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. a dive pulls out on its own ---');
// ---------------------------------------------------------------------------
{
  // The second trim bug was a dive that SELF-SUSTAINED: trimming to 1 g at the current speed has
  // no speed reference, so a dive kept steepening and rode into the ground. That is the property
  // to guard — the flight path must never get steeper than it started.
  //
  // It is NOT the same claim as "it pulls out on its own quickly". The assist is trim, not an
  // autopilot, and the numbers below say so plainly. That is a design choice: you are expected to
  // pull.
  function dive(deg, pull) {
    const f = makeFlyer('plane', {});
    f.p.y = 6000;                                  // room to measure the whole recovery
    f.q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -THREE.MathUtils.degToRad(deg));
    syncAxes(f);
    f.v.copy(f.fwd).multiplyScalar(120);
    f.throttle = 0.5;
    const y0 = f.p.y;
    let lost = 0, steepest = deg, t = 0;
    for (; t < 90; t += DT) {
      if (pull) f.input.pitch = 1;
      stepFlyer(f, DT, true);
      lost = Math.max(lost, y0 - f.p.y);
      const path = -THREE.MathUtils.radToDeg(
        Math.asin(THREE.MathUtils.clamp(f.v.y / Math.max(1, f.v.length()), -1, 1)));
      steepest = Math.max(steepest, path);
      if (f.v.y > 0) break;                        // recovered: climbing again
    }
    return { lost, steepest, t, recovered: f.v.y > 0 };
  }

  for (const deg of [20, 30, 40, 55]) {
    const hands = dive(deg, false), stick = dive(deg, true);
    console.log(`  ${String(deg).padStart(2)} deg dive: hands-off loses ${hands.lost.toFixed(0)} m ` +
      `in ${hands.t.toFixed(1)} s; with the stick pulled, ${stick.lost.toFixed(0)} m ` +
      `in ${stick.t.toFixed(1)} s`);
    ok(`${deg} deg: the dive never steepens — the original bug`,
      hands.steepest <= deg + 0.5, `steepest ${hands.steepest.toFixed(1)} deg`);
    ok(`${deg} deg: hands-off it still recovers eventually`, hands.recovered);
    ok(`${deg} deg: pulling recovers it in a fraction of the height`,
      stick.lost < hands.lost * 0.2, `${stick.lost.toFixed(0)} m vs ${hands.lost.toFixed(0)} m`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. plane stall: pull hard at low power ---');
// ---------------------------------------------------------------------------
{
  const r = fly('plane', 26, (f, t) => { f.input.pitch = t < 14 ? 1 : 0; }, { throttle: 0.12 });
  console.log(`  peak stall fraction ${(r.maxStall * 100).toFixed(0)}%, ` +
    `stall now ${(r.f.stallFrac * 100).toFixed(0)}%`);
  ok('a real stall happens', r.maxStall > 0.55, `${(r.maxStall * 100).toFixed(0)}%`);
  ok('and it recovers when the stick is released', r.f.stallFrac < 0.25 || r.f.crashed === false);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. energy: a hard turn costs speed at fixed throttle ---');
// ---------------------------------------------------------------------------
{
  const straight = fly('plane', 18, null, { throttle: 0.7, speed: 140 });
  const turning = fly('plane', 18, (f) => { f.input.roll = 0.85; f.input.pitch = 0.7; },
    { throttle: 0.7, speed: 140 });
  console.log(`  straight ${straight.f.airspeed.toFixed(1)} m/s vs turning ` +
    `${turning.f.airspeed.toFixed(1)} m/s after 18 s`);
  ok('turning bleeds energy with no scripting', turning.f.airspeed < straight.f.airspeed - 8);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. drone hover at the analytic hover throttle ---');
// ---------------------------------------------------------------------------
{
  const af = AIRFRAMES.drone;
  const hover = (af.mass * G) / af.thrustMax;
  const r = fly('drone', 20, (f) => { f.throttle = hover; f.input.throttle = 0; });
  const drift = r.f.p.y - r.start.y;
  console.log(`  hover throttle ${(hover * 100).toFixed(0)}%, drift ${drift.toFixed(2)} m over 20 s`);
  ok('holds altitude', Math.abs(drift) < 3, `${drift.toFixed(2)} m drift`);
  ok('hover throttle leaves headroom', hover < 0.7, `${(hover * 100).toFixed(0)}%`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 6. drone self-levels after a tilt input is released ---');
// ---------------------------------------------------------------------------
{
  const af = AIRFRAMES.drone;
  const hover = (af.mass * G) / af.thrustMax;
  const f = makeFlyer('drone', {});
  let tilted = 0;
  for (let t = 0; t < 12; t += DT) {
    f.throttle = hover;
    f.input.pitch = t < 4 ? 1 : 0;
    stepFlyer(f, DT, true);
    if (t > 3.5 && t < 4) tilted = Math.abs(Math.asin(THREE.MathUtils.clamp(f.fwd.y, -1, 1)));
  }
  const level = Math.abs(Math.asin(THREE.MathUtils.clamp(f.fwd.y, -1, 1)));
  console.log(`  tilt under command ${THREE.MathUtils.radToDeg(tilted).toFixed(0)} deg, ` +
    `after release ${THREE.MathUtils.radToDeg(level).toFixed(1)} deg`);
  ok('tilts under command', tilted > 0.2);
  ok('returns to level when released', level < 0.06);
}

// ---------------------------------------------------------------------------
console.log('\n--- 7. bird sustains flight by flapping ---');
// ---------------------------------------------------------------------------
{
  // Flap thrust used to point 0.72 UPWARD, so the bird levitated its own flight path into a
  // steepening climb until it stalled. A flap is thrust; the wing is what lifts.
  const r = fly('bird', 45, (f) => { f.input.flap = true; });
  console.log(`  45 s of flapping: min AGL ${r.minAgl.toFixed(0)} m, ` +
    `speed ${r.f.airspeed.toFixed(1)} m/s, stamina ${(r.f.stamina * 100).toFixed(0)}%`);
  ok('does not sink into the ground', !r.f.crashed && r.minAgl > 5, `${r.minAgl.toFixed(0)} m`);
  ok('flies slowly, as a bird should', r.f.airspeed > 8 && r.f.airspeed < 60,
    `${r.f.airspeed.toFixed(1)} m/s`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 8. bird glide with wings folded dives faster ---');
// ---------------------------------------------------------------------------
{
  const open = fly('bird', 8, (f) => { f.input.sweep = false; }, { speed: 24 });
  const fold = fly('bird', 8, (f) => { f.input.sweep = true; }, { speed: 24 });
  console.log(`  wings out ${open.f.airspeed.toFixed(1)} m/s, folded ${fold.f.airspeed.toFixed(1)} m/s`);
  ok('folding trades lift for speed', fold.f.airspeed > open.f.airspeed);
}

// ---------------------------------------------------------------------------
console.log('\n--- 9. a wreck falls, tumbles and lands ---');
// ---------------------------------------------------------------------------
{
  for (const [name, alt, speed] of [
    ['drone at 90 m', 90, 11], ['plane at 220 m', 220, 140],
    ['plane at 1100 m', 1100, 120], ['plane at 2400 m', 2400, 160],
  ]) {
    const f = makeFlyer('plane', {});
    f.p.set(0, heightAt(0, 0) + alt, 0);
    f.v.set(0, 0, -speed);
    syncAxes(f);
    startWreck(f);
    let t = 0, fires = 0, smokes = 0, pops = 0, landed = false;
    for (; t < 60; t += DT) {
      const ev = stepWreck(f, DT);
      if (ev.fire) fires++;
      if (ev.smoke) smokes++;
      if (ev.pop) pops++;
      if (ev.landed) { landed = true; break; }
    }
    console.log(`  ${name.padEnd(16)} fell for ${t.toFixed(1)} s, ` +
      `${fires} flames / ${smokes} smoke / ${pops} pops`);
    ok(`${name}: it lands`, landed);
    ok(`${name}: the backstop is not what ends it`, t < WRECK.maxAge, `${t.toFixed(1)} s`);
    ok(`${name}: the attitude stays a unit quaternion`,
      Math.abs(f.q.length() - 1) < 1e-6, (f.q.length() - 1).toExponential(1));
  }
  // pool arithmetic: fire is short-lived so it can be emitted fast, smoke is not
  const liveFire = 0.32 / WRECK.fireGap, liveSmoke = 2.9 / WRECK.smokeGap;
  console.log(`  one wreck holds ~${liveFire.toFixed(0)}/72 fire and ~${liveSmoke.toFixed(0)}/96 ` +
    `smoke sprites alive; on one shared clock the smoke would be ~${(2.9 / WRECK.fireGap).toFixed(0)}`);
  ok('two wrecks still fit in both sprite pools', liveFire * 2 < 72 && liveSmoke * 2 < 96);
  ok('the separate smoke clock is load-bearing, not decoration', 2.9 / WRECK.fireGap > 96);
}

// ---------------------------------------------------------------------------
console.log('\n--- 10. a kill at the ground makes no wreck, it just detonates ---');
// ---------------------------------------------------------------------------
{
  const high = makeFlyer('plane', {});
  ok('a kill at cruise altitude leaves something to watch fall', killMakesWreck(high));
  const low = makeFlyer('plane', {});
  low.p.y = heightAt(low.p.x, low.p.z) + 0.5;
  ok('a crash into the ground does not', !killMakesWreck(low));
}

// ---------------------------------------------------------------------------
console.log('\n--- 11. reset puts a craft back to a flyable state ---');
// ---------------------------------------------------------------------------
{
  const f = makeFlyer('plane', {});
  f.hp = 1; f.dead = true; f.crashed = true; f.ammo = 0; f.wreck = true;
  f.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);   // upside down
  resetFlyer(f);
  syncAxes(f);
  ok('alive, level, fuelled and armed again',
    !f.dead && !f.crashed && !f.wreck && f.hp === f.af.hp && f.ammo > 0 && f.up.y > 0.99);
  ok('and above the ground it respawned over', agl(f.p) > 100, `${agl(f.p).toFixed(0)} m`);
}

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
