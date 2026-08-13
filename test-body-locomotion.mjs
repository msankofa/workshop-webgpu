// test-body-locomotion.mjs
//
// Headless test for the cyclic locomotion pose layer in body-locomotion.js, driven by the real
// gait scheduler from player-procedural-body.js so the phase lock is exercised against actual
// footfalls rather than a synthetic square wave.
//
// Run: node test-body-locomotion.mjs

import { createGaitScheduler, GAIT_DEFAULTS } from './player-procedural-body.js';
import { createLocomotion, createLocomotionState, stepLocomotion, LOCOMOTION_DEFAULTS } from './body-locomotion.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${detail ? `  (${detail})` : ''}`); }
}

const flat = () => 0;
const dt = 1 / 60;

// Walks a body forward at `speed` for `seconds`, ticking the gait scheduler and then the
// locomotion layer exactly the way player-procedural-body.js's update() does.
function walk(speed, seconds, { cfg = {}, gaitCfg = {}, dt: step = dt } = {}) {
  const gait = createGaitScheduler(gaitCfg);
  const loco = createLocomotion({ enabled: true, ...cfg });
  const hip = { x: 0, y: 0, z: 0 };
  const samples = [];
  const steps = Math.round(seconds / step);
  const dt = step;
  for (let i = 0; i < steps; i++) {
    hip.z += speed * dt;
    gait.update(dt, { hip, yaw: 0, velocity: { x: 0, z: speed }, hipWidth: 0.34 }, flat);
    const pose = loco.update(dt, { speed, feet: gait.feet });
    samples.push({
      t: i * dt,
      phase: pose.phase, weight: pose.weight, stridePeriod: pose.stridePeriod,
      bob: pose.bob, sway: pose.sway,
      armL: pose.armSwing.left, armR: pose.armSwing.right,
      legL: pose.legForward.left, legR: pose.legForward.right,
      ankleL: pose.anklePitch.left, ankleR: pose.anklePitch.right,
      pelvisRoll: pose.pelvisRoll, pelvisYaw: pose.pelvisYaw, shoulderYaw: pose.shoulderYaw,
      steppingL: gait.feet.left.stepping, steppingR: gait.feet.right.stepping,
    });
  }
  return { samples, gait, loco };
}

const maxJump = (samples, key) => {
  let m = 0;
  for (let i = 1; i < samples.length; i++) m = Math.max(m, Math.abs(samples[i][key] - samples[i - 1][key]));
  return m;
};
const tail = (samples, frac = 0.5) => samples.slice(Math.floor(samples.length * (1 - frac)));

// ---------------------------------------------------------------------------
// 1. The phase locks to real footfalls instead of free-running.
// ---------------------------------------------------------------------------
{
  const { samples } = walk(2.0, 8);
  // At every left-foot lift the phase should be near 0 (mod 1); at every right lift, near 0.5.
  let worstL = 0, worstR = 0, liftsL = 0, liftsR = 0;
  for (let i = 1; i < samples.length; i++) {
    const distTo = (p, target) => { let d = Math.abs(p - target); return Math.min(d, 1 - d); };
    if (samples[i].steppingL && !samples[i - 1].steppingL) { liftsL++; if (samples[i].t > 3) worstL = Math.max(worstL, distTo(samples[i].phase, 0)); }
    if (samples[i].steppingR && !samples[i - 1].steppingR) { liftsR++; if (samples[i].t > 3) worstR = Math.max(worstR, distTo(samples[i].phase, 0.5)); }
  }
  check('phase lock: both feet actually lifted repeatedly', liftsL > 4 && liftsR > 4, `L=${liftsL} R=${liftsR}`);
  check('phase lock: left lifts land near phase 0', worstL < 0.12, `worst=${worstL.toFixed(3)}`);
  check('phase lock: right lifts land near phase 0.5', worstR < 0.12, `worst=${worstR.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 2. Everything the layer outputs is CONTINUOUS — no per-frame pops. This is the property the
//    old per-step sine lacked (it snapped to 0 whenever both feet were down).
//
//    Note a raw per-frame delta cannot test this: at a 0.62 rad amplitude and a ~0.9 s stride
//    the arms legitimately move ~0.07 rad per frame at 60 Hz, which is indistinguishable from a
//    small pop by magnitude alone. Quadrupling the frame rate separates them — smooth motion's
//    per-frame delta falls with dt, a discontinuity's does not.
// ---------------------------------------------------------------------------
{
  const slow = tail(walk(2.0, 8, { dt: 1 / 60 }).samples);
  const fine = tail(walk(2.0, 8, { dt: 1 / 240 }).samples);
  for (const key of ['bob', 'sway', 'armL', 'armR', 'pelvisRoll', 'pelvisYaw', 'ankleL', 'ankleR']) {
    const a = maxJump(slow, key), b = maxJump(fine, key);
    // Ideal is a 4x drop. Allow 2.6x: the sampling grid rarely lands on the exact peak.
    check(`continuity: ${key} is smooth, not stepped`, b < a / 2.6,
      `60Hz=${a.toFixed(4)} 240Hz=${b.toFixed(4)} ratio=${(a / Math.max(b, 1e-9)).toFixed(2)}x`);
  }
}

// ---------------------------------------------------------------------------
// 3. Arms swing opposite their own leg (contralateral), which is the whole point.
// ---------------------------------------------------------------------------
{
  const { samples } = walk(2.0, 8);
  const s = tail(samples);
  let agree = 0;
  for (const x of s) if (Math.sign(x.armL) === -Math.sign(x.legL) || x.armL === 0) agree++;
  check('arms: left arm opposes the left leg every frame', agree === s.length, `${agree}/${s.length}`);
  const swung = s.some((x) => Math.abs(x.armL) > 0.2) && s.some((x) => Math.abs(x.armR) > 0.2);
  check('arms: both arms actually swing while walking', swung);
  // Left and right must be out of phase, not swinging together like a marching toy.
  const together = s.filter((x) => Math.sign(x.armL) === Math.sign(x.armR) && Math.abs(x.armL) > 0.1).length;
  check('arms: left and right are out of phase', together === 0, `${together} frames in phase`);
}

// ---------------------------------------------------------------------------
// 4. Amplitude follows speed and fades to neutral when standing.
// ---------------------------------------------------------------------------
{
  const slow = tail(walk(0.6, 6).samples);
  const fast = tail(walk(3.5, 6).samples);
  const amp = (s, key) => Math.max(...s.map((x) => Math.abs(x[key])));
  check('speed: a fast walk swings the arms further than a slow one',
    amp(fast, 'armL') > amp(slow, 'armL') * 1.5, `${amp(fast, 'armL').toFixed(2)} vs ${amp(slow, 'armL').toFixed(2)}`);
  check('speed: weight saturates at 1', Math.max(...fast.map((x) => x.weight)) <= 1.0001);

  // Stop dead and the pose must return to neutral rather than freezing mid-stride.
  const gait = createGaitScheduler();
  const loco = createLocomotion({ enabled: true });
  const hip = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 300; i++) {
    hip.z += 2.0 * dt;
    gait.update(dt, { hip, yaw: 0, velocity: { x: 0, z: 2.0 }, hipWidth: 0.34 }, flat);
    loco.update(dt, { speed: 2.0, feet: gait.feet });
  }
  const moving = Math.abs(loco.pose.armSwing.left);
  for (let i = 0; i < 180; i++) {
    gait.update(dt, { hip, yaw: 0, velocity: { x: 0, z: 0 }, hipWidth: 0.34 }, flat);
    loco.update(dt, { speed: 0, feet: gait.feet });
  }
  check('standing: the cyclic pose fades out', loco.pose.weight < 0.01 && Math.abs(loco.pose.armSwing.left) < 0.01,
    `weight=${loco.pose.weight.toFixed(4)} was moving=${moving.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 5. Ankle roll-through: toes down at lift, toes up approaching the plant.
// ---------------------------------------------------------------------------
{
  const { samples } = walk(2.0, 8);
  let atLift = [], atPlant = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t < 3) continue;
    if (samples[i].steppingL && !samples[i - 1].steppingL) atLift.push(samples[i].ankleL);
    if (!samples[i].steppingL && samples[i - 1].steppingL) atPlant.push(samples[i - 1].ankleL);
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  check('ankle: toes point down at toe-off', atLift.length > 3 && avg(atLift) > 0.05, `avg=${avg(atLift).toFixed(3)}`);
  check('ankle: toes point up at heel strike', atPlant.length > 3 && avg(atPlant) < -0.05, `avg=${avg(atPlant).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 6. Pelvis and shoulders counter-rotate, and the hip drops over the swing leg.
// ---------------------------------------------------------------------------
{
  const s = tail(walk(2.5, 8).samples);
  let opposed = 0;
  for (const x of s) if (Math.sign(x.shoulderYaw) === -Math.sign(x.pelvisYaw) || x.pelvisYaw === 0) opposed++;
  check('torso: shoulders counter-rotate against the pelvis', opposed === s.length, `${opposed}/${s.length}`);

  // pelvisRoll is positive (left hip down) only while the LEFT foot is the airborne one.
  let wrong = 0, checked = 0;
  for (const x of s) {
    if (!x.steppingL && !x.steppingR) continue;      // double support: either sign is fine
    checked++;
    if (x.steppingL && x.pelvisRoll < -0.02) wrong++;
    if (x.steppingR && x.pelvisRoll > 0.02) wrong++;
  }
  check('pelvis: the hip drops on the swinging side', checked > 50 && wrong === 0, `${wrong}/${checked} wrong`);
}

// ---------------------------------------------------------------------------
// 7. stepOverlap in the gait scheduler: default 0 keeps strict alternation,
//    a positive value lets the trailing foot lift before the leading one lands.
// ---------------------------------------------------------------------------
{
  const strict = walk(2.0, 6, { gaitCfg: { stepOverlap: 0 } });
  const both = strict.samples.filter((x) => x.steppingL && x.steppingR).length;
  check('overlap: default 0 never has both feet airborne', both === 0, `${both} frames`);
  check('overlap: GAIT_DEFAULTS still ships 0', GAIT_DEFAULTS.stepOverlap === 0);

  const loose = walk(2.0, 6, { gaitCfg: { stepOverlap: 0.25 } });
  const bothLoose = loose.samples.filter((x) => x.steppingL && x.steppingR).length;
  check('overlap: 0.25 produces real step overlap', bothLoose > 0, `${bothLoose} frames`);
  // The overlap must stay bounded — it is a roll-through, not a leap.
  const frac = bothLoose / loose.samples.length;
  check('overlap: overlap stays a minority of frames', frac < 0.35, `${(frac * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// 8. Defaults stay off, so importing this layer changes nothing until asked.
// ---------------------------------------------------------------------------
{
  check('defaults: the layer ships disabled', LOCOMOTION_DEFAULTS.enabled === false);
  const st = createLocomotionState();
  check('defaults: a fresh state is neutral', st.pose.weight === 0 && st.pose.armSwing.left === 0);
  // A disabled body never calls stepLocomotion, but the function itself must survive zero dt.
  const pose = stepLocomotion(st, 0, { speed: 0, feet: { left: { stepping: false }, right: { stepping: false } } }, { ...LOCOMOTION_DEFAULTS });
  check('defaults: zero dt does not produce NaN', Number.isFinite(pose.phase) && Number.isFinite(pose.bob));
}

// ---------------------------------------------------------------------------
// 9. Compatibility with bot-viewer-v2's rig LOD, which solves distant bodies every 2nd or 4th
//    frame with a banked dt. The phase is locked to lift events, so a coarser sampling grid means
//    coarser lock — this asserts it degrades gracefully and stays bounded instead of unravelling
//    (a free-running phase would drift without limit at 15 Hz).
// ---------------------------------------------------------------------------
{
  for (const [label, step, limit] of [['30 Hz (>18 m)', 1 / 30, 0.10], ['15 Hz (>45 m)', 1 / 15, 0.18]]) {
    for (const speed of [2.0, 5.0]) {
      const { samples } = walk(speed, 10, { dt: step, gaitCfg: { stepOverlap: 0.22 } });
      const distTo = (p, target) => { const d = Math.abs(p - target); return Math.min(d, 1 - d); };
      let worst = 0, lifts = 0;
      for (let i = 1; i < samples.length; i++) {
        if (samples[i].t < 4) continue;
        if (samples[i].steppingL && !samples[i - 1].steppingL) { lifts++; worst = Math.max(worst, distTo(samples[i].phase, 0)); }
        if (samples[i].steppingR && !samples[i - 1].steppingR) { lifts++; worst = Math.max(worst, distTo(samples[i].phase, 0.5)); }
      }
      check(`rig LOD: phase still locks at ${label}, ${speed} m/s`, lifts > 8 && worst < limit,
        `${lifts} lifts, worst=${worst.toFixed(3)} cycles`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
