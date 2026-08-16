// test-flight-autopilot.mjs — the orbit autopilot, flown by every registered airframe.
//
// The claim under test is geometric, and it is the one a gunship depends on: on a held left-hand
// orbit the PORT wing points at the centre. If it does not, the guns cannot see the target and no
// amount of camera work fixes it. So the test flies each class for two minutes and measures radius,
// altitude, and where the inside wing points — rather than trusting the paragraph in the module.
//
//   node test-flight-autopilot.mjs

import * as THREE from 'three';
import { makeFlyer, stepFlyer } from './flight-model.js';
import { agl, heightAt } from './flight-terrain.js';
import { airframeKeys, registerAirframe, AIRFRAMES } from './flight-airframes.js';
import { airframeFor } from './aircraft-library.js';
import {
  makeAutopilot, engageOrbitHere, disengageAutopilot, driveAutopilot, orbitGoal, orbitError, orbitSign,
  ORBIT_LIMITS,
} from './flight-autopilot.js';

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const DT = 1 / 60;
const deg = (r) => (r * 180 / Math.PI).toFixed(1) + '°';

// Flies `f` on its autopilot for `seconds` and reports how the last `settle` seconds went.
function flyOrbit(f, seconds, settle = 40) {
  let minAgl = Infinity, crashed = false, inverted = 0, steps = 0;
  let sumR = 0, sumA = 0, sumW = 0, maxW = 0, n = 0;
  for (let t = 0; t < seconds; t += DT, steps++) {
    driveAutopilot(f, DT);
    stepFlyer(f, DT, true);
    if (!Number.isFinite(f.p.y) || f.crashed) { crashed = true; break; }
    minAgl = Math.min(minAgl, agl(f.p));
    if (f.up.y < 0) inverted++;
    if (t > seconds - settle) {
      const e = orbitError(f, f.autopilot);
      sumR += Math.abs(e.radiusError); sumA += Math.abs(e.altError); sumW += e.wingAngle;
      maxW = Math.max(maxW, e.wingAngle); n++;
    }
  }
  return { crashed, minAgl, inverted: inverted / Math.max(1, steps),
    radius: sumR / Math.max(1, n), alt: sumA / Math.max(1, n), wing: sumW / Math.max(1, n), maxWing: maxW };
}

// ---------------------------------------------------------------------------
console.log('--- 1. every registered airframe holds a left orbit, port wing on the centre ---');
// ---------------------------------------------------------------------------
// The layout-built craft are registered too: the A-10 because it behaves least like the hand-tuned
// plane, and the AC-130 because it is the aircraft this autopilot exists for.
registerAirframe('a10', airframeFor('a10'));
registerAirframe('ac130', airframeFor('ac130'));
for (const key of airframeKeys()) {
  const f = makeFlyer(key, { x: 0, z: 0 });
  const c = f.af.circuit;
  // each class at its own patrol radius and height, since a bird cannot fly a 3 km ring
  const R = THREE.MathUtils.clamp(c.radius, ...ORBIT_LIMITS.radius);
  const A = THREE.MathUtils.clamp(c.alt, ...ORBIT_LIMITS.alt);
  makeAutopilot(f, { x: 0, z: 0, radius: R, alt: A, turn: 'left' });
  // start on the ring, so the question is holding it, not finding it — that is section 2
  f.p.set(R, heightAt(R, 0) + A, 0);
  const r = flyOrbit(f, 120);
  console.log(`  ${key.padEnd(5)} R ${R} m, alt ${A} m: radius error ${r.radius.toFixed(0)} m, ` +
    `alt error ${r.alt.toFixed(0)} m, port wing ${deg(r.wing)} off the centre (worst ${deg(r.maxWing)}), min AGL ${r.minAgl.toFixed(0)}`);
  ok(`${key}: survives two minutes on autopilot`, !r.crashed);
  ok(`${key}: never inverted`, r.inverted === 0, `${(r.inverted * 100).toFixed(0)}%`);
  ok(`${key}: holds the radius inside 15%`, r.radius < R * 0.15, `${r.radius.toFixed(0)} m of ${R}`);
  ok(`${key}: holds the altitude inside 120 m`, r.alt < 120, `${r.alt.toFixed(0)} m`);
  ok(`${key}: keeps the port wing within 25° of the centre`, r.wing < 25 * Math.PI / 180, deg(r.wing));
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. it finds the ring from far away, from either side ---');
// ---------------------------------------------------------------------------
{
  for (const [label, x0, z0] of [['inside', 300, 0], ['outside', 9000, 2000]]) {
    const f = makeFlyer('a10', { x: x0, z: z0 });
    makeAutopilot(f, { x: 0, z: 0, radius: 3000, alt: 2000, turn: 'left' });
    const r = flyOrbit(f, 240, 60);
    ok(`from ${label} the ring: converges and holds`, !r.crashed && r.radius < 450 && r.wing < 25 * Math.PI / 180,
      `radius error ${r.radius.toFixed(0)} m, wing ${deg(r.wing)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. right turns put the STARBOARD wing on the centre — the sign is measured, not assumed ---');
// ---------------------------------------------------------------------------
{
  const f = makeFlyer('a10', { x: 0, z: 0 });
  makeAutopilot(f, { x: 0, z: 0, radius: 3000, alt: 2000, turn: 'right' });
  f.p.set(3000, heightAt(3000, 0) + 2000, 0);
  const r = flyOrbit(f, 120);
  ok('a right orbit is held', !r.crashed && r.radius < 450, `${r.radius.toFixed(0)} m`);
  ok('with the starboard wing on the centre', r.wing < 25 * Math.PI / 180, deg(r.wing));
  // and the two turns really are opposite: the port wing is on the OUTSIDE now
  const dx = -f.p.x, dz = -f.p.z, dist = Math.hypot(dx, dz);
  const portDot = -(f.right.x * dx + f.right.z * dz) / dist;
  ok('so the port wing points away from it', portDot < -0.7, portDot.toFixed(2));
  ok('orbitSign agrees with what was flown', orbitSign('left') === -1 && orbitSign('right') === 1);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. engage here: on the ring and tangent from the first frame ---');
// ---------------------------------------------------------------------------
{
  const f = makeFlyer('a10', { x: 1200, z: -800, heading: 0.9 });
  f.p.y = heightAt(f.p.x, f.p.z) + 2400;
  const ap = engageOrbitHere(f, { radius: 3000 });
  const e0 = orbitError(f, ap);
  ok('the centre is placed one radius off the port wing', Math.abs(e0.radiusError) < 1 && e0.wingAngle < 1e-3,
    `${e0.radiusError.toFixed(2)} m, ${deg(e0.wingAngle)}`);
  ok('at the height the aircraft already has', Math.abs(e0.altError) < 1, `${e0.altError.toFixed(1)} m`);
  const r = flyOrbit(f, 90, 60);
  ok('and it settles into the orbit without a swing', !r.crashed && r.radius < 300 && r.wing < 20 * Math.PI / 180,
    `radius error ${r.radius.toFixed(0)} m, wing ${deg(r.wing)}`);
  disengageAutopilot(f);
  ok('disengaging clears it and driveAutopilot then does nothing', f.autopilot === null && driveAutopilot(f, DT) === false);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. the goal point leads the aircraft, and terrain wins over the ring altitude ---');
// ---------------------------------------------------------------------------
{
  const f = makeFlyer('plane', { x: 0, z: 0 });
  const ap = makeAutopilot(f, { x: 0, z: 0, radius: 2000, alt: 800, turn: 'left' });
  f.p.set(2000, 1500, 0);
  const g = new THREE.Vector3();
  orbitGoal(g, f, ap);
  ok('the goal sits on the ring', Math.abs(Math.hypot(g.x, g.z) - 2000) < 1e-6);
  ok('ahead of the aircraft in the turn direction (left: decreasing ring angle)', g.z < -100, `z ${g.z.toFixed(0)}`);
  ok('never below 150 m over the ground under it', g.y >= heightAt(g.x, g.z) + 150);
  ok('the limits clamp a silly request', makeAutopilot(f, { radius: 5, alt: -100 }).radius === ORBIT_LIMITS.radius[0]
    && f.autopilot.alt === ORBIT_LIMITS.alt[0]);
}

// ---------------------------------------------------------------------------
console.log('\n--- 6. the gunship: on its orbit, every mount can see the centre ---');
// ---------------------------------------------------------------------------
// The whole design in one assertion: from a held left orbit at the gunship's own radius and height,
// the line from each PORT mount to the orbit centre lies inside that mount's arc — because if the
// bank and the depression do not add up, the guns point at sky or at the wing.
{
  const { mountOrigin, clampToArc } = await import('./flight-combat.js');
  const f = makeFlyer('ac130', { x: 0, z: 0 });
  const c = f.af.circuit;
  makeAutopilot(f, { x: 0, z: 0, radius: c.radius, alt: c.alt, turn: 'left' });
  f.p.set(c.radius, heightAt(c.radius, 0) + c.alt, 0);
  const centre = new THREE.Vector3(0, heightAt(0, 0), 0);
  const o = new THREE.Vector3(), want = new THREE.Vector3();
  let inArc = 0, n = 0, worst = 0;
  for (let t = 0; t < 150; t += DT) {
    driveAutopilot(f, DT);
    stepFlyer(f, DT, true);
    if (t < 60) continue;
    for (const m of f.mounts) {
      mountOrigin(o, f, m);
      want.copy(centre).sub(o).normalize();
      const before = want.clone();
      if (clampToArc(want, f, m)) inArc++;
      worst = Math.max(worst, Math.acos(THREE.MathUtils.clamp(before.dot(want), -1, 1)));
      n++;
    }
  }
  ok('on the held orbit every mount can be trained on the centre', inArc === n,
    `${inArc}/${n} samples inside the arc, worst clamp ${deg(worst)}`);
}

delete AIRFRAMES.a10; delete AIRFRAMES.ac130;
console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
