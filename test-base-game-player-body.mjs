import * as THREE from 'three';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createTraversalLabWorldQuery } from './traversal-lab-collider.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';
import { createBodySupportAdapter } from './base-game-body-support.js';
import { createBaseGamePlayerBodies } from './base-game-player-bodies.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };
const near = (a, b, epsilon = 0.02) => Math.abs(a - b) <= epsilon;

const worldQuery = createWorldQueryService();
const lab = createTraversalLabWorldQuery(worldQuery);
const coords = createWorldCoordinateSpace();

// ---- A1: bounded support probes through the existing world query ----
const support = createBodySupportAdapter({ worldQuery, worldCoordinates: coords });

// Stacked floors at x=47, z=-23: ground 0, floor 5, floor 10 (same X/Z).
support.setReference([47, 10, -23]);
ok(near(support.terrainHeight(47, -23), 10), 'a foot referenced at the top floor finds the top floor');
support.setReference([47, 5, -23]);
ok(near(support.terrainHeight(47, -23), 5), 'the same X/Z referenced at the middle floor finds the middle floor');
support.setReference([47, 0, -23]);
ok(near(support.terrainHeight(47, -23), 0), 'the same X/Z referenced at ground level finds the ground');

// Bridge deck (y=6) over ground (y=0) at x=-34, z=0.
support.setReference([-34, 6, 0]);
ok(near(support.terrainHeight(-34, 0), 6), 'a body on the bridge deck plants feet on the deck');
support.setReference([-34, 0, 0]);
ok(near(support.terrainHeight(-34, 0), 0), 'a body under the bridge plants feet on the ground, not the deck');

// Tunnel floor (y=0) under ceiling (y=4) and roof (y=9) at z=-31.
support.setReference([0, 0, -31]);
ok(near(support.terrainHeight(0, -31), 0), 'inside the tunnel the floor is the support, not the roof');
support.setReference([0, 9, -31]);
ok(near(support.terrainHeight(0, -31), 9), 'on the tunnel roof the roof is the support');

// Walkable ramp and the standard step.
support.setReference([28, 2.5, -3.5]);
const rampY = support.terrainHeight(28, -3.5);
ok(rampY > 1.5 && rampY < 4.5, `ramp support follows the slope (${rampY.toFixed(2)})`);
support.setReference([8, 0, 21]);
ok(near(support.terrainHeight(8, 21), 0.6), 'the 0.6 m standard step is found from a ground-level reference');

// Floating platform at y=10.25 top; a reference far below must not jump up to it.
support.setReference([-19, 0, -36]);
ok(support.terrainHeight(-19, -36) < 1 && support.lastHit === null, 'no support within the window returns the foot plane, not a distant surface');
ok(support.diagnostics.misses === 1, 'misses are counted');

// ---- render-origin independence ----
const shifted = createWorldCoordinateSpace({ renderOrigin: [1000, 0, 0] });
const shiftedSupport = createBodySupportAdapter({ worldQuery, worldCoordinates: shifted });
shiftedSupport.setReference([47, 5, -23]);
ok(near(shiftedSupport.terrainHeight(47 - 1000, -23), 5), 'a shifted render origin still resolves the global middle floor in local space');

// ---- A3: presentation owner feeds bodies and cannot mutate the controller ----
const scene = new THREE.Scene();
const controller = createBaseGamePlayerController({ worldQuery, spawn: lab.layout.spawn });
for (let i = 0; i < 90; i++) controller.advance(1 / 60);
const bodies = createBaseGamePlayerBodies({ THREE, scene, worldQuery, worldCoordinates: coords });
ok(bodies.setLocalMode('thirdPerson') === 'thirdPerson' && bodies.localBody, 'local third-person body is constructed on demand');
const before = JSON.stringify(controller.captureState());
const foot = controller.getPosition();
for (let i = 0; i < 30; i++) {
  bodies.updateLocal(1 / 60, { globalFoot: foot, velocity: [0, 0, 0], yaw: 0, grounded: controller.grounded, height: 1.8, radius: 0.35 });
}
ok(JSON.stringify(controller.captureState()) === before, 'body updates never mutate controller state');
const feet = bodies.localBody.gait.feet;
ok(near(feet.left.current.y, 0, 0.05) && near(feet.right.current.y, 0, 0.05), 'local feet plant on the origin floor');
ok(bodies.localSupport.diagnostics.probes > 0, 'the local body routes support through the adapter');

// Two remote bodies at one X/Z on different floors keep distinct feet.
bodies.beginRemoteFrame();
bodies.updateRemote(1 / 60, 'upper', { globalFoot: [47, 10, -23], velocity: [0, 0, 0], yaw: 0, grounded: true });
bodies.updateRemote(1 / 60, 'lower', { globalFoot: [47, 0, -23], velocity: [0, 0, 0], yaw: 0, grounded: true });
bodies.endRemoteFrame();
ok(bodies.remoteCount === 2, 'remote bodies are created per id');
for (let i = 0; i < 30; i++) {
  bodies.beginRemoteFrame();
  bodies.updateRemote(1 / 60, 'upper', { globalFoot: [47, 10, -23], velocity: [0, 0, 0], yaw: 0, grounded: true });
  bodies.updateRemote(1 / 60, 'lower', { globalFoot: [47, 0, -23], velocity: [0, 0, 0], yaw: 0, grounded: true });
  bodies.endRemoteFrame();
}
ok(bodies.diagnostics.remoteBodies === 2 && bodies.diagnostics.supportMisses === 0, 'both stacked remote bodies found support without misses');
ok(bodies.releaseRemote('lower') && bodies.remoteCount === 1, 'remote bodies release by id');

// Render-origin rebase: the body keeps following the global foot.
const rebaseCoords = createWorldCoordinateSpace({ rebaseDistance: 10, rebaseSnap: 8 });
const rebaseBodies = createBaseGamePlayerBodies({ THREE, scene, worldQuery, worldCoordinates: rebaseCoords, instancedRemotes: false });
rebaseBodies.setLocalMode('thirdPerson');
const farFoot = [47, 10, -23];
for (let i = 0; i < 20; i++) rebaseBodies.updateLocal(1 / 60, { globalFoot: farFoot, velocity: [0, 0, 0], yaw: 0, grounded: true });
const feetBefore = rebaseBodies.localBody.gait.feet.left.current;
const localBefore = rebaseCoords.toRenderLocal(farFoot);
ok(near(feetBefore.x, localBefore[0], 0.5) && near(feetBefore.y, 10, 0.1), 'feet sit at the local projection of the global foot before rebasing');
rebaseCoords.maybeRebase(farFoot);
ok(rebaseCoords.revision === 1, 'render origin rebased');
for (let i = 0; i < 20; i++) rebaseBodies.updateLocal(1 / 60, { globalFoot: farFoot, velocity: [0, 0, 0], yaw: 0, grounded: true });
const feetAfter = rebaseBodies.localBody.gait.feet.left.current;
const localAfter = rebaseCoords.toRenderLocal(farFoot);
ok(near(feetAfter.x, localAfter[0], 0.5) && near(feetAfter.y, localAfter[1], 0.1), 'after a rebase the feet follow the new local projection of the same global foot');

// ---- jump: blended air weight, velocity-shaped tuck, landing absorb, feet re-plant ----
const jumper = createBaseGamePlayerController({ worldQuery, spawn: lab.layout.spawn });
for (let i = 0; i < 90; i++) jumper.advance(1 / 60);
const jumpBodies = createBaseGamePlayerBodies({ THREE, scene, worldQuery, worldCoordinates: coords, instancedRemotes: false });
jumpBodies.setLocalMode('thirdPerson');
const feedJumper = () => jumpBodies.updateLocal(1 / 60, {
  globalFoot: jumper.getPosition(), velocity: jumper.getVelocity(), yaw: 0, grounded: jumper.grounded, height: 1.8, radius: 0.35,
});
for (let i = 0; i < 30; i++) feedJumper();
const rig = jumpBodies.localBody;
let maxAirStep = 0, peakAir = 0, landedAbsorb = 0, prevAir = 0, wasGrounded = true, sawRiseTuck = false, sawFallExtend = false;
jumper.queueJump();
for (let i = 0; i < 120; i++) {
  jumper.advance(1 / 60);
  feedJumper();
  const air = rig.motion.airWeight;
  maxAirStep = Math.max(maxAirStep, Math.abs(air - prevAir));
  prevAir = air;
  peakAir = Math.max(peakAir, air);
  const vy = jumper.getVelocity()[1];
  if (!jumper.grounded && air > 0.9) {
    if (vy > 2) sawRiseTuck = true;
    if (vy < -2) sawFallExtend = true;
  }
  if (jumper.grounded && !wasGrounded) landedAbsorb = rig.motion.landingAbsorb;
  wasGrounded = jumper.grounded;
}
ok(peakAir > 0.95, 'air weight reaches full tuck during a jump');
ok(maxAirStep < 0.35, `air weight changes smoothly per frame (max step ${maxAirStep.toFixed(2)})`);
ok(sawRiseTuck && sawFallExtend, 'the body sees both the rising and falling phases');
ok(landedAbsorb > 0.02 && landedAbsorb <= rig.jumpCfg.absorbMax, `landing absorb engages (${landedAbsorb.toFixed(3)} m)`);
for (let i = 0; i < 60; i++) feedJumper();
ok(rig.motion.airWeight === 0 && rig.motion.landingAbsorb === 0, 'air weight and absorb settle to zero after landing');
ok(near(rig.gait.feet.left.current.y, 0, 0.05) && near(rig.gait.feet.right.current.y, 0, 0.05), 'both feet are planted on the floor after landing');
jumpBodies.dispose();

// ---- floor blips: a walking body that loses the floor for a frame or two must not jump ----
const blipBodies = createBaseGamePlayerBodies({ THREE, scene, worldQuery, worldCoordinates: coords, instancedRemotes: false });
blipBodies.setLocalMode('thirdPerson');
const blipRig = blipBodies.localBody;
const blipFoot = [-12, 0, 8];
const feedBlip = (grounded) => blipBodies.updateLocal(1 / 60, {
  globalFoot: blipFoot, velocity: [0, 0, 2.0], yaw: 0, grounded, height: 1.8, radius: 0.35,
});
let blipAir = 0, blipHold = 0, stepCount = 0, wasStepping = false;
for (let i = 0; i < 240; i++) {
  blipFoot[2] += 2.0 / 60;
  const grounded = !(i % 20 === 0 || i % 20 === 1);   // two-frame floor loss every 20 frames
  feedBlip(grounded);
  const stepping = blipRig.gait.feet.left.stepping;
  if (stepping && !wasStepping) stepCount++;
  wasStepping = stepping;
  blipAir = Math.max(blipAir, blipRig.motion.airWeight);
  if (grounded) blipHold = Math.max(blipHold, blipRig.motion.landingAbsorb);
}
ok(blipAir < 0.05, `two-frame floor blips while walking do not raise the air weight (${blipAir.toFixed(3)})`);
ok(blipHold === 0, 'floor blips while walking do not trigger the landing absorb');
ok(stepCount >= 3, `left foot keeps stepping through floor blips (${stepCount} steps over 4 s)`);
blipBodies.dispose();

// ---- arms: hang when idle, swing when walking, pump when running, lift on a jump ----
const armController = createBaseGamePlayerController({ worldQuery, spawn: [-12, 0.1, 8] });
const armBodies = createBaseGamePlayerBodies({ THREE, scene, worldQuery, worldCoordinates: coords, instancedRemotes: false });
armBodies.setLocalMode('thirdPerson');
const armRig = armBodies.localBody;
function measureArms(moveX, sprint, frames) {
  armController.reset([-12, 0.1, 8]);
  for (let i = 0; i < 30; i++) armController.advance(1 / 60);
  let front = 9, back = -9, low = 9, high = -9;
  for (let i = 0; i < frames; i++) {
    armController.setInput({ moveX, moveZ: 0, yaw: 0, sprint });
    armController.advance(1 / 60);
    armBodies.updateLocal(1 / 60, { globalFoot: armController.getPosition(), velocity: armController.getVelocity(), yaw: Math.PI / 2, grounded: armController.grounded, height: 1.8, radius: 0.35 });
    if (i < 50) continue;
    const j = armRig.joints;
    const fwd = -(j.leftHand.position.x - j.leftShoulder.position.x);
    const up = j.leftHand.position.y - j.leftShoulder.position.y;
    front = Math.min(front, fwd); back = Math.max(back, fwd); low = Math.min(low, up); high = Math.max(high, up);
  }
  return { arc: back - front, high, low, grounded: armController.grounded };
}
const idleArms = measureArms(0, false, 90);
const walkArms = measureArms(1, false, 150);
const runArms = measureArms(1, true, 110);
ok(idleArms.arc < 0.02 && idleArms.high < -0.6, 'idle arms hang still from the shoulder');
ok(walkArms.arc > 0.5 && walkArms.high > idleArms.high, `walking arms swing (${walkArms.arc.toFixed(2)} m arc) and lift a little`);
ok(runArms.high > walkArms.high + 0.3 && runArms.grounded, `running arms pump up to shoulder height (${runArms.high.toFixed(2)} m above the shoulder)`);
armBodies.setArmTuning({ preset: 'sprinter' });
const sprinterArms = measureArms(1, true, 110);
ok(sprinterArms.high >= runArms.high - 0.05 && armRig.armCfg.preset === 'sprinter', 'presets apply live through the owner');
armBodies.setArmTuning({ preset: 'relaxed', runSwing: 0 });
ok(measureArms(1, true, 110).arc < runArms.arc * 0.5, 'a slider override beats the preset value');
ok(armRig.turnCfg.stiffness === 55 && armRig.gait.cfg.stepOverlap === 0.2 && armRig.locomotion.cfg.enabled === true,
  'rigs start on the saved movement tuning (states/base-game-state-20260822021519.json)');
armBodies.setMovementTuning({ armAsym: 0.3, stepOverlap: 0.1 });
ok(armRig.locomotion.cfg.armAsym === 0.3 && armRig.gait.cfg.stepOverlap === 0.1, 'movement tuning patches reach the live rig');
armBodies.setMovementTuning({ armAsym: 0.8, stepOverlap: 0.22 });
armBodies.setArmTuning({ preset: 'relaxed', elbowPole: 0.8 });
ok(armRig.ikCfg.leftArmPole === 0.8 && armRig.ikCfg.rightArmPole === -0.8, 'elbowPole writes a mirrored pole rotation into the rig');
armBodies.setArmTuning({ preset: 'relaxed' });
armController.reset([-12, 0.1, 8]);
for (let i = 0; i < 30; i++) { armController.advance(1 / 60); armBodies.updateLocal(1 / 60, { globalFoot: armController.getPosition(), velocity: armController.getVelocity(), yaw: 0, grounded: armController.grounded, height: 1.8, radius: 0.35 }); }
armController.queueJump();
let jumpHandPeak = -9;
for (let i = 0; i < 90; i++) {
  armController.advance(1 / 60);
  armBodies.updateLocal(1 / 60, { globalFoot: armController.getPosition(), velocity: armController.getVelocity(), yaw: 0, grounded: armController.grounded, height: 1.8, radius: 0.35 });
  jumpHandPeak = Math.max(jumpHandPeak, armRig.joints.leftHand.position.y - armRig.joints.leftShoulder.position.y);
}
ok(jumpHandPeak > 0.2, `both arms lift above the shoulders on takeoff (${jumpHandPeak.toFixed(2)} m)`);
// A long drop: arms keep rising with fall speed and time, higher than a hop's takeoff lift.
armController.reset([-19, 10.3, -36]);
for (let i = 0; i < 20; i++) { armController.advance(1 / 60); armBodies.updateLocal(1 / 60, { globalFoot: armController.getPosition(), velocity: armController.getVelocity(), yaw: 0, grounded: armController.grounded, height: 1.8, radius: 0.35 }); }
armController.setInput({ moveX: 0, moveZ: -1, yaw: 0 });
let fallHandEarly = null, fallHandLate = -9;
for (let i = 0; i < 110; i++) {
  armController.setInput({ moveX: 0, moveZ: i < 50 ? 1 : 0, yaw: 0 });
  armController.advance(1 / 60);
  armBodies.updateLocal(1 / 60, { globalFoot: armController.getPosition(), velocity: armController.getVelocity(), yaw: 0, grounded: armController.grounded, height: 1.8, radius: 0.35 });
  const up = armRig.joints.leftHand.position.y - armRig.joints.leftShoulder.position.y;
  if (!armController.grounded && armController.getVelocity()[1] < -2 && fallHandEarly == null) fallHandEarly = up;
  if (!armController.grounded && armController.getVelocity()[1] < -6) fallHandLate = Math.max(fallHandLate, up);
}
ok(fallHandEarly != null && fallHandLate > fallHandEarly + 0.5 && fallHandLate > 0,
  `a long drop raises the arms with fall speed and time (${(fallHandEarly ?? 0).toFixed(2)} -> ${fallHandLate.toFixed(2)} m)`);
// Sprint tap: the arm pose speed ramps over a few strides instead of following the physics speed.
armBodies.setArmTuning({ preset: 'relaxed', poseSmoothing: 0.35 });
armController.reset([-12, 0.1, 8]);
for (let i = 0; i < 30; i++) armController.advance(1 / 60);
let poseSpeedJump = 0, prevPoseSpeed = null, physicsSpeedJump = 0, prevPhysics = null;
for (let i = 0; i < 150; i++) {
  armController.setInput({ moveX: 1, moveZ: 0, yaw: 0, sprint: i >= 60 });
  armController.advance(1 / 60);
  armBodies.updateLocal(1 / 60, { globalFoot: armController.getPosition(), velocity: armController.getVelocity(), yaw: Math.PI / 2, grounded: armController.grounded, height: 1.8, radius: 0.35 });
  const v = armController.getVelocity(); const physics = Math.hypot(v[0], v[2]);
  const poseSpeed = armRig.motion.armPoseSpeed;
  if (i >= 60) {
    if (prevPoseSpeed != null) poseSpeedJump = Math.max(poseSpeedJump, poseSpeed - prevPoseSpeed);
    if (prevPhysics != null) physicsSpeedJump = Math.max(physicsSpeedJump, physics - prevPhysics);
  }
  prevPoseSpeed = poseSpeed; prevPhysics = physics;
}
ok(poseSpeedJump < physicsSpeedJump * 0.6 && armRig.motion.armPoseSpeed > 9,
  `arm pose speed ramps smoothly on a sprint tap (${poseSpeedJump.toFixed(2)} vs physics ${physicsSpeedJump.toFixed(2)} m/s per frame) and still reaches the run`);
armBodies.dispose();

ok(bodies.setLocalMode('off') === 'off' && bodies.localBody === null, 'body off destroys the local rig');

const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
for (const marker of ['createBaseGamePlayerBodies', 'playerBodyMode', 'playerBodies.updateLocal(', 'playerBodies.updateRemote(', 'armPreset', 'playerBodies.setArmTuning(']) {
  ok(html.includes(marker), `base-game.html integrates ${marker}`);
}

bodies.dispose(); rebaseBodies.dispose(); lab.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
