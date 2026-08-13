// test-player-body-gait.mjs
//
// Headless test for the biped gait scheduler in player-procedural-body.js.
// Plain node, no framework, no THREE — the module's pure gait-scheduler
// section is required to have zero THREE dependency (Contract 3) so this
// test can exercise it directly.
//
// Run: node test-player-body-gait.mjs

import { createGaitScheduler, GAIT_DEFAULTS, constrainFootTarget, LEG_WORKSPACE_DEFAULTS,
  leanAngleForSpeed, stepLeadFor, effectiveStepDuration, GAIT_MODELS, gaitForSpeed } from './player-procedural-body.js';
import { LOCOMOTION_DEFAULTS } from './body-locomotion.js';

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
// Test 5: workspace projection keeps feet separated and within reachable bounds.
// ---------------------------------------------------------------------------
{
  const workspace = { ...LEG_WORKSPACE_DEFAULTS };
  const hip = { x: 0, y: 0, z: 0 };
  const left = constrainFootTarget({ x: 3, y: 0, z: 3 }, hip, 0, -1, workspace);
  const right = constrainFootTarget({ x: -3, y: 0, z: -3 }, hip, 0, 1, workspace);
  const leftLocal = { lateral: -left.x, forward: left.z };
  const rightLocal = { lateral: right.x, forward: right.z };
  check('workspace: left foot cannot cross the central plane', leftLocal.lateral >= workspace.minLateral - 1e-9);
  check('workspace: right foot cannot cross the central plane', rightLocal.lateral >= workspace.minLateral - 1e-9);
  check('workspace: left foot stays inside maximum reach', Math.hypot(leftLocal.lateral, leftLocal.forward) <= workspace.maxReach + 1e-9);
  check('workspace: right foot stays inside maximum reach', Math.hypot(rightLocal.lateral, rightLocal.forward) <= workspace.maxReach + 1e-9);
}

// ---------------------------------------------------------------------------
// Test 6: a stationary turn creates one short adjustment step, never two.
// ---------------------------------------------------------------------------
{
  const gait = createGaitScheduler();
  const hip = { x: 0, y: 0, z: 0 };
  gait.update(1 / 60, { hip, yaw: 0, velocity: { x: 0, z: 0 }, hipWidth: 0.34 }, flatTerrain);
  gait.update(1 / 60, { hip, yaw: Math.PI / 2, velocity: { x: 0, z: 0 }, hipWidth: 0.34, turnAmount: Math.PI / 2 }, flatTerrain);
  const { left, right } = gait.feet;
  check('turning: a planted foot takes an adjustment step', left.stepping || right.stepping);
  check('turning: only one foot may step at once', !(left.stepping && right.stepping));
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lean into step: the pure half of the balance-point offset the rig applies in update().
// ---------------------------------------------------------------------------
{
  check('lean angle tracks the cyclic layer',
    Math.abs(leanAngleForSpeed(2) - LOCOMOTION_DEFAULTS.torsoLean * 2) < 1e-12);
  check('lean angle caps at torsoLeanMax', leanAngleForSpeed(1000) === LOCOMOTION_DEFAULTS.torsoLeanMax);
  check('lean angle is zero at rest', leanAngleForSpeed(0) === 0);
  check('lean angle never goes negative', leanAngleForSpeed(-9) === 0);

  // effectiveStepDuration must reproduce what stepGait computes for itself, or the lead is derived
  // from a duration the scheduler never uses.
  const cfg = { ...GAIT_DEFAULTS };
  check('effective duration is the authored one while standing',
    effectiveStepDuration(0, cfg) === cfg.stepDuration);
  check('effective duration never exceeds the authored one',
    [0.5, 1, 2, 5, 20].every(v => effectiveStepDuration(v, cfg) <= cfg.stepDuration + 1e-12));
  check('effective duration is floored at MIN_STEP_DURATION',
    Math.abs(effectiveStepDuration(500, cfg) - 0.12) < 1e-12);
  check('effective duration shortens as speed rises',
    effectiveStepDuration(6, cfg) < effectiveStepDuration(3, cfg));

  // Default OFF must be exactly off, at every speed and every gait config.
  const cfgs = [cfg, { ...cfg, stepDuration: 0.45 }, { ...cfg, maxStepDistance: 0.4 }];
  const offEverywhere = [0, 0.5, 2, 5, 20].every(v =>
    cfgs.every(c => stepLeadFor(v, c) === 0 && stepLeadFor(v, c, 0) === 0));
  check('lead is 0 by default at every speed and gait config', offEverywhere);
  check('lead is 0 when standing still', stepLeadFor(0, cfg, 2) === 0);
  check('lead is 0 for negative speed', stepLeadFor(-3, cfg, 1) === 0);

  check('lead grows with speed', stepLeadFor(5, cfg, 1) > stepLeadFor(1, cfg, 1));
  // Below the stride clamp, or these measure the clamp rather than the formula.
  check('lead grows with scale', stepLeadFor(2, cfg, 2) > stepLeadFor(2, cfg, 1));
  check('lead is scale * speed * effective step duration',
    Math.abs(stepLeadFor(2, cfg, 1.5) - 1.5 * 2 * effectiveStepDuration(2, cfg)) < 1e-12);
  check('lead clamps to one stride once the raw value passes it',
    stepLeadFor(5, cfg, 2) === cfg.maxStepDistance && 2 * 5 * effectiveStepDuration(5, cfg) > cfg.maxStepDistance);
  // At scale 1 the foot is aimed exactly one swing's hip travel ahead, which is the whole point:
  // that is the distance the shipped rig currently lands short by.
  check('scale 1 equals one swing of hip travel',
    Math.abs(stepLeadFor(4.08, cfg, 1) - 4.08 * effectiveStepDuration(4.08, cfg)) < 1e-12);
  // Magnitude sanity against the config the rig actually runs - gait.cfg after gaitForSpeed has
  // written it, not the raw GAIT_DEFAULTS. A dashing v3 bot moves 4.69 m/s.
  const dashCfg = { ...GAIT_DEFAULTS, ...gaitForSpeed(4.69) };
  check('lead is about 0.93 m at a dash, scale 1',
    Math.abs(stepLeadFor(4.69, dashCfg, 1) - 0.928) < 0.02);
  check('lead is about 0.51 m at a dash, tuned scale',
    Math.abs(stepLeadFor(4.69, dashCfg, GAIT_MODELS.tuned.stepLeadScale) - 0.510) < 0.02);
  // This is a stride-scale effect. The lean-derived formula it replaced could not exceed
  // pelvisHeight * tan(0.20 rad) ~ 0.21 m however far its scale was pushed.
  check('lead well exceeds what the lean projection could offer',
    stepLeadFor(4.69, dashCfg, 1) > 4 * 1.044 * Math.tan(LOCOMOTION_DEFAULTS.torsoLeanMax));
  check('lead never exceeds one stride, at any speed', [1, 3, 5, 20, 500].every(v =>
    stepLeadFor(v, cfg, 1) <= cfg.maxStepDistance + 1e-12));
}

// ---------------------------------------------------------------------------
// Selectable gait models
// ---------------------------------------------------------------------------
{
  check('shipped model exists and leads nothing', GAIT_MODELS.shipped.stepLeadScale === 0);
  check('tuned model leads something', GAIT_MODELS.tuned.stepLeadScale > 0);
  // The result of the search was that the fit itself did not need changing. If someone later edits
  // one bundle's coefficients without the other, this says so rather than letting it pass silently.
  check('tuned shares the shipped speed fit', GAIT_MODELS.tuned.speed === GAIT_MODELS.shipped.speed);
  check('every model names itself', Object.values(GAIT_MODELS).every(m => m.label && m.note));
  check('every model carries the scheduler constants', Object.values(GAIT_MODELS).every(m =>
    Number.isFinite(m.triggerDistance) && Number.isFinite(m.stepOverlap)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
