// test-player-body-gait.mjs
//
// Headless test for the biped gait scheduler in player-procedural-body.js.
// Plain node, no framework, no THREE — the module's pure gait-scheduler
// section is required to have zero THREE dependency (Contract 3) so this
// test can exercise it directly.
//
// Run: node test-player-body-gait.mjs

import { createGaitScheduler, GAIT_DEFAULTS } from './player-procedural-body.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
}

function flatTerrain(x, z) { return 0; }

function bumpyTerrain(x, z) {
  // deterministic, non-trivial height field so we can assert foot targets
  // actually sample it (not just default to 0).
  return Math.sin(x * 0.7) * 0.3 + Math.cos(z * 0.5) * 0.2;
}

// ---------------------------------------------------------------------------
// Test 1: walking forward — feet must alternate, never both stepping at once.
// ---------------------------------------------------------------------------
{
  const gait = createGaitScheduler();
  const hip = { x: 0, y: 0, z: 0 };
  const speed = 2.0; // m/s forward along +z (yaw = 0 -> forward = (0,0,1))
  const dt = 1 / 60;
  let bothSteppingEver = false;
  let anyStepStarted = false;

  for (let i = 0; i < 600; i++) { // 10 seconds of walking
    hip.z += speed * dt;
    gait.update(dt, { hip, yaw: 0, velocity: { x: 0, z: speed }, hipWidth: 0.34 }, flatTerrain);
    const { left, right } = gait.feet;
    if (left.stepping && right.stepping) bothSteppingEver = true;
    if (left.stepping || right.stepping) anyStepStarted = true;
  }

  check('walking: feet never both stepping simultaneously', !bothSteppingEver);
  check('walking: stepping actually occurs while moving', anyStepStarted);
}

// ---------------------------------------------------------------------------
// Test 2: foot targets sample terrainHeight (not just flat/zero).
// ---------------------------------------------------------------------------
{
  const gait = createGaitScheduler();
  const hip = { x: 0, y: 0, z: 0 };
  const dt = 1 / 60;
  let sampledNonZero = false;

  for (let i = 0; i < 300; i++) {
    hip.x += 0.03; // walk along +x through the bumpy field
    gait.update(dt, { hip, yaw: Math.PI / 2, velocity: { x: 0.03 / dt, z: 0 }, hipWidth: 0.34 }, bumpyTerrain);
    const { left, right } = gait.feet;
    const expectedLeftY = bumpyTerrain(left.target.x, left.target.z);
    const expectedRightY = bumpyTerrain(right.target.x, right.target.z);
    if (Math.abs(left.target.y - expectedLeftY) > 1e-9) throw new Error('left target.y does not match terrainHeight sample');
    if (Math.abs(right.target.y - expectedRightY) > 1e-9) throw new Error('right target.y does not match terrainHeight sample');
    if (Math.abs(left.target.y) > 1e-6 || Math.abs(right.target.y) > 1e-6) sampledNonZero = true;
  }

  check('foot targets sample terrainHeight(x,z) exactly', true);
  check('foot targets pick up non-flat terrain height', sampledNonZero);
}

// ---------------------------------------------------------------------------
// Test 3: standing still (~zero speed) settles both feet under the hips.
// ---------------------------------------------------------------------------
{
  const gait = createGaitScheduler();
  const hip = { x: 5, y: 0, z: -3 };
  const dt = 1 / 60;
  const hipWidth = 0.4;

  // Walk in for a bit so the feet start away from rest, then stop.
  for (let i = 0; i < 30; i++) {
    hip.z += 0.05;
    gait.update(dt, { hip, yaw: 0, velocity: { x: 0, z: 3 }, hipWidth }, flatTerrain);
  }
  // Now stand still and let the scheduler settle.
  for (let i = 0; i < 300; i++) {
    gait.update(dt, { hip, yaw: 0, velocity: { x: 0, z: 0 }, hipWidth }, flatTerrain);
  }

  const { left, right } = gait.feet;
  const leftErr = Math.hypot(left.current.x - left.rest.x, left.current.z - left.rest.z);
  const rightErr = Math.hypot(right.current.x - right.rest.x, right.current.z - right.rest.z);
  const leftUnderHips = Math.abs(left.rest.x - (hip.x - hipWidth / 2)) < 1e-6;
  const rightUnderHips = Math.abs(right.rest.x - (hip.x + hipWidth / 2)) < 1e-6;

  check('standing: rest anchors are under the hips (left)', leftUnderHips);
  check('standing: rest anchors are under the hips (right)', rightUnderHips);
  check('standing: left foot settles near rest', leftErr < 0.05);
  check('standing: right foot settles near rest', rightErr < 0.05);
  check('standing: neither foot left stepping mid-air', !left.stepping && !right.stepping);
}

// ---------------------------------------------------------------------------
// Test 4: a large teleport triggers an instant reset (no mid-air animation).
// ---------------------------------------------------------------------------
{
  const gait = createGaitScheduler();
  const hip = { x: 0, y: 0, z: 0 };
  const dt = 1 / 60;

  // Walk normally so feet drift away from a freshly-reset state.
  for (let i = 0; i < 60; i++) {
    hip.z += 0.05;
    gait.update(dt, { hip, yaw: 0, velocity: { x: 0, z: 3 }, hipWidth: 0.34 }, flatTerrain);
  }
  const preTeleport = {
    left: { ...gait.feet.left.current },
    right: { ...gait.feet.right.current },
  };

  // Teleport far away in one tick (bigger than GAIT_DEFAULTS.teleportDistance).
  hip.x += 50;
  hip.z += 50;
  gait.update(dt, { hip, yaw: 0, velocity: { x: 0, z: 0 }, hipWidth: 0.34 }, flatTerrain);

  const { left, right } = gait.feet;
  const leftNear = Math.hypot(left.current.x - left.rest.x, left.current.z - left.rest.z) < 1e-9;
  const rightNear = Math.hypot(right.current.x - right.rest.x, right.current.z - right.rest.z) < 1e-9;
  const jumpedFromOldPos =
    Math.hypot(left.current.x - preTeleport.left.x, left.current.z - preTeleport.left.z) > GAIT_DEFAULTS.teleportDistance * 0.5;

  check('teleport: left foot snaps to rest instantly (no drift)', leftNear);
  check('teleport: right foot snaps to rest instantly (no drift)', rightNear);
  check('teleport: neither foot left stepping after reset', !left.stepping && !right.stepping);
  check('teleport: feet actually moved with the hip jump', jumpedFromOldPos);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
