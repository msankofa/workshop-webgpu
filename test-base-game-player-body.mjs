import * as THREE from 'three';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createTraversalLabWorldQuery } from './traversal-lab-collider.js';
import { createBaseGamePlayerController, BASE_GAME_PLAYER_DEFAULT_CONFIG } from './base-game-player-controller.js';
import { createBodySupportAdapter } from './base-game-body-support.js';
import { BASE_GAME_BODY_DESIGNS } from './base-game-player-bodies.js';
import { createBaseGamePlayerBodies, BASE_GAME_MOVEMENT_DEFAULTS } from './base-game-player-bodies.js';
import { readFileSync } from 'node:fs';
import { createWeaponMountSystem } from './weapon-mount.js';
import { getWeapon } from './weapons.js';

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

// ---- model appearance: every bot body version builds, swaps in place, and still walks ----
const designBodies = createBaseGamePlayerBodies({ THREE, scene, worldQuery, worldCoordinates: coords, instancedRemotes: true });
designBodies.setLocalMode('thirdPerson');
for (const { key } of BASE_GAME_BODY_DESIGNS) {
  let threw = null;
  try {
    designBodies.setBodyDesign(key);
    for (let i = 0; i < 30; i++) {
      designBodies.updateLocal(1 / 60, { globalFoot: [-12, 0, 8 + i * 0.03], velocity: [0, 0, 2], yaw: 0, grounded: true, height: 1.8, radius: 0.35 });
      designBodies.beginRemoteFrame();
      designBodies.updateRemote(1 / 60, 'r1', { globalFoot: [-10, 0, 8], velocity: [0, 0, 0], yaw: 0, grounded: true, height: 1.8, radius: 0.35 });
      designBodies.endRemoteFrame();
    }
  } catch (error) { threw = error; }
  ok(!threw && designBodies.bodyDesign === key, `body design '${key}' builds and updates local + remote (${threw ? threw.message : 'ok'})`);
}
ok(designBodies.setBodyDesign('nonsense') === 'default', 'unknown design key falls back to the bare rig');
designBodies.beginRemoteFrame();
designBodies.updateRemote(1 / 60, 'model-a', { globalFoot: [-10, 0, 8], velocity: [0, 0, 0], yaw: 0, grounded: true, bodyModel: 'v4' });
designBodies.updateRemote(1 / 60, 'model-b', { globalFoot: [-8, 0, 8], velocity: [0, 0, 0], yaw: 0, grounded: true, bodyModel: 'soldier:medic' });
designBodies.endRemoteFrame();
ok(designBodies.remoteBodyModel('model-a') === 'v4' && designBodies.remoteBodyModel('model-b') === 'soldier:medic',
  'remote bodies keep independent authoritative model identities');
designBodies.setBodyDesign('v2');
ok(designBodies.remoteBodyModel('model-a') === 'v4', 'changing the local model does not rebuild a remote as the local design');
designBodies.dispose();

// ---- weapons: mount per body, aim channels, remote weapon from the sample, reload on a new tick ----
{
  const anchorsJson = JSON.parse(readFileSync('./weapon-anchors.json', 'utf8'));
  const posesJson = JSON.parse(readFileSync('./weapon-poses.json', 'utf8'));
  const fakeGLB = () => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.5, 5, 22), new THREE.MeshBasicMaterial());
    m.position.set(0, 0, -4.5); g.add(m);
    return Promise.resolve({ scene: g });
  };
  const weaponSystem = createWeaponMountSystem({ THREE, scene, loadGLB: fakeGLB, getWeapon, loadData: () => Promise.resolve([anchorsJson, posesJson]) });
  const wb = createBaseGamePlayerBodies({ THREE, scene, worldQuery, worldCoordinates: coords, instancedRemotes: true, weaponSystem });
  wb.setLocalMode('thirdPerson');
  wb.setWeapon('cz_805_bren');
  await new Promise((r) => setTimeout(r, 0));
  ok(wb.localMount && wb.localMount.weaponId === 'cz_805_bren', 'local body got a cz mount');
  const sampleAt = (z, over = {}) => ({ globalFoot: [-12, 0, z], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, height: 1.8, radius: 0.35, ...over });
  const targets = {};
  const rig = wb.localBody;
  const orig = rig.setArmTarget;
  rig.setArmTarget = (side, t) => { targets[side] = t ? t.position.clone() : null; return orig.call(rig, side, t); };
  // Default path is environment-viewer's: the body faces the look yaw, authored hold, no trim.
  for (let i = 0; i < 60; i++) { wb.updateLocal(1 / 60, sampleAt(8, { yaw: 1.1 })); wb.beginRemoteFrame(); wb.endRemoteFrame(); }
  ok(Math.abs(wb.localHeading - 1.1) < 1e-6, 'default facing: the body heading is the look yaw');
  ok(Math.abs(wb.localMount.weaponRig.position.y - 1.5) < 0.05, `default hold: mount root at feet + 1.5 (${wb.localMount.weaponRig.position.y.toFixed(2)})`);
  // The experimental path: travel heading, torso/head split, body-relative hold, trim, reach solve.
  wb.setFacingMode('travel'); wb.setAimTrim(true); wb.setReachSolve(true); wb.setHoldMode('body');
  for (let i = 0; i < 60; i++) { wb.updateLocal(1 / 60, sampleAt(8)); wb.beginRemoteFrame(); wb.endRemoteFrame(); }
  const mount = wb.localMount;
  mount.weaponView.updateWorldMatrix(true, false);
  const grip = new THREE.Vector3().fromArray(mount.bakedAnchors.rightGrip.p).applyMatrix4(mount.weaponView.matrixWorld);
  ok(targets.right && targets.right.distanceTo(grip) < 0.05, `local right hand on the grip (${targets.right?.distanceTo(grip).toFixed(3)} m)`);
  {
    const sh = new THREE.Vector3(); rig.joints.rightShoulder.getWorldPosition(sh);
    const frac = grip.distanceTo(sh) / rig.limbLengths.armLen;
    ok(frac > 0.4 && frac < 0.8, `body hold keeps the trigger grip at a bent-elbow distance (${frac.toFixed(2)} of the arm)`);
  }
  ok(weaponSystem.stats.flushed === 1, 'local mount flushed once per frame');

  // Aiming to the side: the torso takes most of the residual.
  wb.setLocalAim(true, new THREE.Vector3(-12 + 20, 1.5, 8));
  let peakTwist = 0, peakHeading = 0;
  for (let i = 0; i < 90; i++) {
    wb.updateLocal(1 / 60, sampleAt(8, { yaw: -Math.PI / 2 }));
    peakTwist = Math.max(peakTwist, Math.abs(rig.motion.aimYaw));
    peakHeading = Math.max(peakHeading, Math.abs(wb.localHeading ?? 0));
  }
  ok(peakTwist > 0.2, `torso twists toward the aim while the body turns (${peakTwist.toFixed(2)} rad)`);
  const headingErr = Math.abs(Math.atan2(Math.sin(wb.localHeading + Math.PI / 2), Math.cos(wb.localHeading + Math.PI / 2)));
  ok(headingErr < 0.15, `standing body turns in place to face the look (${headingErr.toFixed(2)} rad off)`);
  // Small look changes stay on the torso/head: no body turn below the threshold.
  const before = wb.localHeading;
  for (let i = 0; i < 60; i++) wb.updateLocal(1 / 60, sampleAt(8, { yaw: -Math.PI / 2 + 0.4 }));
  ok(Math.abs(wb.localHeading - before) < 1e-6, 'a look change under the threshold does not turn the body');
  // The gun is bound to the body: an aim point far off the heading is clamped into the reach cone.
  wb.setLocalAim(true, new THREE.Vector3(-12, 1.5, 8 + 20));   // directly behind the body's facing
  for (let i = 0; i < 30; i++) wb.updateLocal(1 / 60, sampleAt(8, { yaw: -Math.PI / 2 + 0.4 }));
  const bdir = new THREE.Vector3(); weaponSystem.barrelDirection(wb.localMount, bdir);
  const hx = -Math.sin(wb.localHeading), hz = -Math.cos(wb.localHeading);
  const off = Math.acos(Math.max(-1, Math.min(1, (bdir.x * hx + bdir.z * hz) / Math.hypot(bdir.x, bdir.z))));
  ok(off < 1.0, `barrel stays within the body's yaw cone (${off.toFixed(2)} rad off heading)`);
  wb.setLocalAim(false, null);

  // Remote: weapon id arrives in the sample; a new actionTick plays the reload once.
  wb.beginRemoteFrame();
  wb.updateRemote(1 / 60, 'p2', sampleAt(4, { weapon: 'five_seven', action: 0, actionTick: -1 }));
  wb.endRemoteFrame();
  await new Promise((r) => setTimeout(r, 0));
  ok(wb.remoteWeapon('p2')?.mount?.weaponId === 'five_seven', 'remote body got the sampled weapon');
  for (let i = 0; i < 5; i++) { wb.beginRemoteFrame(); wb.updateRemote(1 / 60, 'p2', sampleAt(4, { weapon: 'five_seven', action: 1, actionTick: 100 })); wb.endRemoteFrame(); }
  ok(wb.remoteWeapon('p2').mount.controller.getAction() === 'reload', 'remote reload plays on a new action tick');
  ok(wb.remoteWeapon('p2').lastActionTick === 100, 'action tick recorded once');
  wb.beginRemoteFrame(); wb.updateRemote(1 / 60, 'p2', sampleAt(4, { weapon: 'cz_805_bren', action: 0, actionTick: 100 })); wb.endRemoteFrame();
  await new Promise((r) => setTimeout(r, 0));
  ok(wb.remoteWeapon('p2').mount?.weaponId === 'cz_805_bren', 'remote weapon swaps when the sample changes');

  // Phase 2: first-person blend through the bodies module, part mask, eye point.
  {
    const eye = wb.localEyePoint([0, 0, 0]);
    ok(eye && eye[1] > 1.8 && eye[1] < 2.1, `eye point rides the animated head (y ${eye?.[1]?.toFixed(2)})`);
    wb.setLocalPartMask({ head: false, torso: false });
    ok(rig.parts.core.head.visible === false && rig.parts.core.torso.visible === false && rig.parts.core.pelvis.visible === true, 'part mask hides head and torso only');
    wb.setLocalPartMask({ head: true, torso: true });
    const vf = { position: new THREE.Vector3(-12.3, 1.4, 7.6), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.3, 0)) };
    wb.setReachSolve(false);   // exact placement check; the reach solve would pull a far frame back
    for (let i = 0; i < 30; i++) wb.updateLocal(1 / 60, sampleAt(8, { viewFrame: vf, viewBlend: 1 }));
    const m = wb.localMount;
    m.weaponView.updateWorldMatrix(true, false);
    const vp = new THREE.Vector3(); m.weaponView.getWorldPosition(vp);
    ok(vp.distanceTo(vf.position) < 0.01, `viewBlend 1 through updateLocal places the gun on the view frame (${vp.distanceTo(vf.position).toFixed(3)} m)`);
    const gripNow = new THREE.Vector3().fromArray(m.bakedAnchors.rightGrip.p).applyMatrix4(m.weaponView.matrixWorld);
    ok(targets.right.distanceTo(gripNow) < 0.05, 'hands follow the blended gun');
    for (let i = 0; i < 30; i++) wb.updateLocal(1 / 60, sampleAt(8));
    ok(wb.localMount.weaponRig.position.distanceTo(vf.position) > 0.3, 'without a view frame the mount returns to the body hold');
    wb.setReachSolve(true);
  }

  // Design swap rebuilds the body and re-creates the local mount.
  wb.setBodyDesign('soldier:rifleman');
  await new Promise((r) => setTimeout(r, 0));
  ok(wb.localMount && wb.localMount.body === wb.localBody, 'design swap re-creates the mount on the new body');
  ok(wb.localReload() === true, 'local reload plays');
  wb.setWeapon(null);
  ok(wb.localMount === null, 'clearing the weapon drops the mount');
  wb.dispose();
  weaponSystem.dispose();
}

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
ok(armRig.turnCfg.stiffness === BASE_GAME_MOVEMENT_DEFAULTS.turnStiffness
  && armRig.gait.cfg.stepOverlap === BASE_GAME_MOVEMENT_DEFAULTS.stepOverlap
  && armRig.locomotion.cfg.enabled === BASE_GAME_MOVEMENT_DEFAULTS.locoEnabled,
  'rigs start on the shipped movement tuning (base-game-states/base-game-state-20260826184842.json)');
ok(BASE_GAME_MOVEMENT_DEFAULTS.stepOverlap === 0.02 && BASE_GAME_MOVEMENT_DEFAULTS.cadenceScale === 2
  && BASE_GAME_MOVEMENT_DEFAULTS.behindStride === 1.5 && BASE_GAME_MOVEMENT_DEFAULTS.swayScale === 1.05,
  'the shipped gait is the browser-tuned one: double cadence, stride behind the body, barely-overlapping feet');
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
// Walk until the ledge actually runs out rather than for a fixed count: how many frames that takes
// depends on the configured walk speed.
for (let i = 0; i < 260; i++) {
  armController.setInput({ moveX: 0, moveZ: armController.grounded ? 1 : 0, yaw: 0 });
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
const sprintSpeed = BASE_GAME_PLAYER_DEFAULT_CONFIG.moveSpeed * BASE_GAME_PLAYER_DEFAULT_CONFIG.sprintMultiplier;
ok(poseSpeedJump < physicsSpeedJump * 0.6 && armRig.motion.armPoseSpeed > sprintSpeed * 0.9,
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
