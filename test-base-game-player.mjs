import * as THREE from 'three';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createWorldQueryService } from './world-query.js';
import { createBaseGameTraversalLab } from './base-game-traversal-lab.js';
import { createBaseGamePlayerController, BASE_GAME_PLAYER_DEFAULT_CONFIG } from './base-game-player-controller.js';
import { BASE_GAME_STANCES } from './base-game-protocol.mjs';
import { createBaseGameWaterSim } from './base-game-water-sim.js';
import { createBaseGamePlayerView } from './base-game-player-view.js';
import { createHeightfieldWorldQueryProvider } from './world-query-heightfield-provider.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};
const near = (a, b, epsilon = 0.03) => Math.abs(a - b) <= epsilon;

function simulate(controller, seconds, input = null, observe = null) {
  const frames = Math.ceil(seconds * 60);
  for (let frame = 0; frame < frames; frame++) {
    if (input) controller.setInput(input);
    controller.advance(1 / 60);
    observe?.(controller, frame);
  }
}

const scene = new THREE.Scene();
const worldQuery = createWorldQueryService();
const lab = createBaseGameTraversalLab({ scene, worldQuery });
const controller = createBaseGamePlayerController({ worldQuery, spawn: lab.layout.spawn });

simulate(controller, 1.5);
ok(controller.grounded && near(controller.getPosition()[1], 0), 'player settles on the origin floor through the shared BVH provider');
ok(controller.surface?.providerId === 'traversal-lab-static', 'grounded controller exposes a terrain-agnostic surface identity hook');

const startZ = controller.getPosition()[2];
// Expressed against the configured walk speed, not a magic distance: retuning the walk must not
// silently turn this into a test of nothing.
const walkSeconds = 0.75, walkSpeed = BASE_GAME_PLAYER_DEFAULT_CONFIG.moveSpeed;
simulate(controller, walkSeconds, { moveX: 0, moveZ: 1, yaw: 0, sprint: false });
ok(controller.getPosition()[2] < startZ - walkSpeed * walkSeconds * 0.5, 'camera-relative forward input advances the global 3D capsule');

controller.setInput({ moveX: 0, moveZ: 0, yaw: 0, sprint: false });
controller.queueJump();
let maximumJumpY = controller.getPosition()[1];
simulate(controller, 1.5, null, current => { maximumJumpY = Math.max(maximumJumpY, current.getPosition()[1]); });
ok(maximumJumpY > 0.8, 'queued jump creates a real airborne arc');
ok(controller.grounded && near(controller.getPosition()[1], 0), 'jump lands and snap-down restores stable grounded state');

controller.reset([0, 0.02, -31]);
controller.configure({ jumpSpeed: 11 });
simulate(controller, 0.25);
controller.queueJump();
let touchedCeiling = false;
simulate(controller, 1.2, null, current => { touchedCeiling ||= current.ceiling; });
ok(touchedCeiling, 'tunnel jump reports a distinct ceiling collision');
ok(controller.getPosition()[1] < 2.25, 'ceiling response keeps the capsule inside tunnel headroom');
controller.configure({ jumpSpeed: 8 });

controller.reset([47, 11.5, -23]);
simulate(controller, 1.2);
const upperFloorY = controller.getPosition()[1];
controller.reset([47, 6.5, -23]);
simulate(controller, 1.0);
const middleFloorY = controller.getPosition()[1];
ok(near(upperFloorY, 10) && near(middleFloorY, 5), 'same XZ resolves to two independently traversable stacked-floor Y coordinates');

controller.reset([25, 0.02, 27]);
simulate(controller, 2, { moveX: 1, moveZ: 0, yaw: 0, sprint: true });
ok(controller.getPosition()[0] < 31.7, 'distance microsteps stop a sprinting capsule at the corner wall without tunneling');

controller.reset([8, 0.02, 17]);
let standardStepTop = 0;
// Long enough to reach the tread at the configured walk speed, whatever that is tuned to.
simulate(controller, Math.max(0.8, 4 / BASE_GAME_PLAYER_DEFAULT_CONFIG.moveSpeed), { moveX: 0, moveZ: -1, yaw: 0, sprint: false }, current => {
  standardStepTop = Math.max(standardStepTop, current.getPosition()[1]);
});
ok(standardStepTop > 0.52, 'step-up climbs the Traversal Lab standard-height tread');

controller.reset([12, 0.02, 17]);
simulate(controller, 0.8, { moveX: 0, moveZ: -1, yaw: 0, sprint: false });
ok(controller.getPosition()[2] < 19.25 && controller.getPosition()[1] < 0.1,
  'step-up rejects the high-step probe instead of teleporting onto it');

const beforeCatchUp = controller.diagnostics;
const catchUp = controller.advance(1);
const afterCatchUp = controller.diagnostics;
ok(catchUp.steps <= controller.config.maxCatchUpSteps, 'long frames execute no more than the bounded fixed-step catch-up budget');
ok(afterCatchUp.droppedCatchUpSeconds > beforeCatchUp.droppedCatchUpSeconds, 'discarded catch-up time is explicit in diagnostics');

const state = controller.captureState();
controller.reset([0, 20, 0]);
controller.applyState(state);
ok(controller.getPosition().every((value, axis) => near(value, state.position[axis], 1e-9)), 'player state round-trips global xyz without flattening Y');

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
const coordinates = createWorldCoordinateSpace();
const view = createBaseGamePlayerView({ scene, camera, worldQuery, worldCoordinates: coordinates });
view.setLook(Math.PI / 2, 0);
view.syncCapsule([30.8, 0, 27], { visible: true, grounded: true });
const cameraResult = view.updateCamera(1 / 60, [30.8, 0, 27], {
  mode: 'thirdPerson', distance: 5, followRate: 14, obstructionPadding: 0.22,
});
ok(cameraResult.obstructed && cameraResult.boomDistance < 2, 'camera-only obstruction query shortens the boom at a wall');
view.updateCamera(1 / 60, [30.8, 0, 27], { mode: 'firstPerson' });
ok(!view.capsuleMesh.visible, 'first-person mode hides the diagnostic capsule from the camera');

// --- posture: kneel and prone, and above all NO SNAPS ------------------------------------
// The capsule height, the move speed and the rig weights are all blended from bot-stance.js's eased
// weights rather than switched on the stance name, so every transition is a ramp. The test that
// matters is the per-tick delta: a snap is a single frame doing most of the travel.
{
  const poseQuery = createWorldQueryService();
  const poseLab = createBaseGameTraversalLab({ scene, worldQuery: poseQuery });
  const pose = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
  const settle = (stance, ticks = 240) => {
    const heights = [];
    for (let i = 0; i < ticks; i++) {
      pose.stepOnce({ moveX: 0, moveZ: 0, yaw: 0, sprint: false, stance }, false);
      heights.push(pose.getCapsule().end[1] - pose.getCapsule().start[1] + pose.getCapsule().radius * 2);
    }
    return heights;
  };
  const standing = settle('stand')[239];
  ok(Math.abs(standing - 1.8) < 1e-6, 'standing is the full configured height');

  const toKneel = settle('kneel');
  const kneeling = toKneel[toKneel.length - 1];
  ok(kneeling < standing - 0.3, `kneeling lowers the capsule (${standing.toFixed(2)} -> ${kneeling.toFixed(2)} m)`);
  const kneelSteps = toKneel.map((h, i) => Math.abs(h - (i ? toKneel[i - 1] : standing)));
  const kneelTravel = standing - kneeling;
  ok(Math.max(...kneelSteps) < kneelTravel * 0.1, `going to a knee is a ramp, not a snap (biggest single tick moves ${(Math.max(...kneelSteps) / kneelTravel * 100).toFixed(1)}% of the way)`);
  ok(kneelSteps.filter(d => d > 1e-5).length > 20, 'and it takes many ticks, not two');

  const toProne = settle('prone');
  const prone = toProne[toProne.length - 1];
  ok(prone < kneeling, `prone is lower still (${prone.toFixed(2)} m)`);
  ok(prone >= 0.7 - 1e-6, 'but never shorter than the capsule is wide, which would stop being a capsule');
  const proneSteps = toProne.map((h, i) => Math.abs(h - (i ? toProne[i - 1] : kneeling)));
  ok(Math.max(...proneSteps) < Math.abs(kneeling - prone) * 0.1, 'kneel to prone is a ramp too');

  const backUp = settle('stand');
  ok(Math.abs(backUp[backUp.length - 1] - standing) < 1e-3, 'standing back up returns to full height');
  const upSteps = backUp.map((h, i) => Math.abs(h - (i ? backUp[i - 1] : prone)));
  ok(Math.max(...upSteps) < (standing - prone) * 0.1, 'and getting up is a ramp, not a pop');

  // Speed follows the same eased weights, so it cannot step either.
  const speedAt = (stance, ticks) => {
    const c = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
    for (let i = 0; i < 60; i++) c.stepOnce({ moveX: 0, moveZ: 1, yaw: 0, sprint: false }, false);
    for (let i = 0; i < ticks; i++) c.stepOnce({ moveX: 0, moveZ: 1, yaw: 0, sprint: false, stance }, false);
    const v = c.getVelocity();
    return Math.hypot(v[0], v[2]);
  };
  const walkSpeed = speedAt('stand', 240);
  ok(speedAt('kneel', 240) < walkSpeed * 0.6, 'a kneeling player shuffles');
  ok(speedAt('prone', 240) < walkSpeed * 0.6, 'a prone player crawls');
  ok(speedAt('kneel', 6) > speedAt('kneel', 240) + 0.05, 'the slowdown ramps in with the pose instead of dropping on the key press');

  // The tick object the page builds IS the wire packet, so its `stance` is an INDEX, not a name.
  // Shipping a controller that only understood names meant only the SERVER ever changed posture:
  // solo and client prediction silently stood still. Both forms are accepted, against one list.
  {
    const byIndex = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
    const byName = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
    for (let i = 0; i < 240; i++) {
      byIndex.stepOnce({ moveX: 0, moveZ: 0, yaw: 0, sprint: false, stance: BASE_GAME_STANCES.indexOf('kneel') }, false);
      byName.stepOnce({ moveX: 0, moveZ: 0, yaw: 0, sprint: false, stance: 'kneel' }, false);
    }
    ok(byIndex.stance === 'kneel' && byName.stance === 'kneel', 'the controller takes a stance as the wire index or as a name');
    ok(Math.abs(byIndex.getCapsule().end[1] - byName.getCapsule().end[1]) < 1e-9, 'and both reach the identical capsule');
    const prone = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
    for (let i = 0; i < 240; i++) prone.stepOnce({ moveX: 0, moveZ: 0, yaw: 0, sprint: false, stance: BASE_GAME_STANCES.indexOf('prone') }, false);
    ok(prone.stance === 'prone', 'and prone arrives by index too');
  }

  // Walking out of a kneel gives you the crouch: a kneel pins both feet (rear knee on the ground,
  // front foot planted), so there is no gait that can walk it. Crouch is the same lowered pelvis
  // with the normal gait still running, so it can.
  {
    const c = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
    const hold = (stance, moveZ, ticks = 220) => {
      for (let i = 0; i < ticks; i++) c.stepOnce({ moveX: 0, moveZ, yaw: 0, sprint: false, stance }, false);
      return c.stanceWeights;
    };
    const still = hold('kneel', 0);
    ok(still.kneel01 > 0.9 && still.crouch01 < 0.1 && c.stance === 'kneel', 'kneeling still is a kneel');
    const moving = hold('kneel', 1);
    ok(moving.crouch01 > 0.9 && moving.kneel01 < 0.1, 'walking out of it hands over to the crouch');
    ok(c.stance === 'crouch' && c.requestedStance === 'kneel', 'the controller reports what the body IS, while remembering what was asked for');
    const stopped = hold('kneel', 0);
    ok(stopped.kneel01 > 0.9 && c.stance === 'kneel', 'stopping puts the knee back down');
    // Both directions are the same eased blend, so the handover cannot pop.
    const c2 = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
    for (let i = 0; i < 220; i++) c2.stepOnce({ moveX: 0, moveZ: 0, yaw: 0, sprint: false, stance: 'kneel' }, false);
    let worst = 0, last = c2.getCapsule().end[1];
    for (let i = 0; i < 220; i++) {
      c2.stepOnce({ moveX: 0, moveZ: 1, yaw: 0, sprint: false, stance: 'kneel' }, false);
      const now = c2.getCapsule().end[1];
      worst = Math.max(worst, Math.abs(now - last));
      last = now;
    }
    ok(worst < 0.02, `the kneel-to-crouch handover is a ramp (worst tick ${(worst * 100).toFixed(2)} cm)`);
    // Prone is left alone: crawling is its own pose, not a crouch.
    const c3 = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
    for (let i = 0; i < 220; i++) c3.stepOnce({ moveX: 0, moveZ: 1, yaw: 0, sprint: false, stance: 'prone' }, false);
    ok(c3.stance === 'prone' && c3.stanceWeights.prone01 > 0.9, 'moving while prone stays prone');
  }

  // Reconciliation carries the pose: a hard correction must not stand a prone player up.
  {
    const a = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
    for (let i = 0; i < 200; i++) a.stepOnce({ moveX: 0, moveZ: 0, yaw: 0, sprint: false, stance: 'prone' }, false);
    const b = createBaseGamePlayerController({ worldQuery: poseQuery, spawn: poseLab.layout.spawn });
    b.applyState(a.captureState());
    ok(Math.abs(b.getCapsule().end[1] - a.getCapsule().end[1]) < 1e-9, 'captureState carries the pose, so a correction lands the same capsule');
  }
  poseLab.dispose();
}

// --- climbing keeps its feet on the ground -------------------------------------------------
// Walking up a slope legitimately rises: 5.5 m/s at 15 deg is +1.47 m/s of vertical velocity. That
// used to read as "jumping" and cancelled the snap-to-ground, so the heightfield's exact seating
// left the capsule a hair off the surface every dozen steps and `grounded` flickered false. The gait,
// the footstep audio and the first-person camera height all read that flag, so a climb strobed.
function rampWorld(degrees, flattenAtX = Infinity) {
  const k = Math.tan(degrees * Math.PI / 180), n = Math.hypot(k, 1);
  const source = {
    heightAt: (x) => (x <= 0 ? 0 : x < flattenAtX ? x * k : flattenAtX * k),
    normalAt: (x, z, out = [0, 1, 0]) => {
      const onRamp = x > 0 && x < flattenAtX;
      out[0] = onRamp ? -k / n : 0; out[1] = onRamp ? 1 / n : 1; out[2] = 0;
      return out;
    },
  };
  const service = createWorldQueryService();
  service.registerProvider(createHeightfieldWorldQueryProvider(source));
  return service;
}
const climbInput = (sprint) => ({ moveX: 0, moveZ: 1, yaw: -Math.PI / 2, sprint });   // forward is +X at this yaw
function climb(degrees, { sprint = false, steps = 400, from = 250, flattenAtX = Infinity, jumpAt = -1 } = {}) {
  const controller = createBaseGamePlayerController({ worldQuery: rampWorld(degrees, flattenAtX), spawn: [-2, 0, 0] });
  let ungrounded = 0, sampled = 0, airPastCrest = 0;
  for (let step = 0; step < steps; step++) {
    controller.stepOnce(climbInput(sprint), step === jumpAt);
    if (step < from) continue;
    sampled++;
    if (!controller.grounded) {
      ungrounded++;
      if (controller.getPosition()[0] > flattenAtX - 0.5) airPastCrest++;
    }
  }
  return { ungrounded, sampled, airPastCrest, controller };
}
for (const degrees of [0, 5, 15, 30, 45, 49]) {
  ok(climb(degrees).ungrounded === 0, `walking up a ${degrees} deg slope never loses the ground`);
  ok(climb(degrees, { sprint: true }).ungrounded === 0, `sprinting up a ${degrees} deg slope never loses the ground`);
}
{
  // The threshold has to keep the cases it was guarding. A jump still leaves the ground...
  const jumped = climb(15, { steps: 380, from: 260, jumpAt: 260 });
  ok(jumped.ungrounded > 20, 'a jump taken while climbing still puts the player in the air');
  // ...and running off the top of a ramp still launches, instead of gluing you to the flat.
  const crest = climb(25, { sprint: true, steps: 400, from: 0, flattenAtX: 5 });
  ok(crest.airPastCrest > 10, 'running off the crest of a ramp still throws the player into the air');
}
{
  // Server-authoritative: the threshold reads this step's velocity and the probe's own hit normal,
  // never remembered surface state (which captureState does not carry), so a replay cannot diverge.
  const run = () => {
    const controller = createBaseGamePlayerController({ worldQuery: rampWorld(22), spawn: [-2, 0, 0] });
    for (let step = 0; step < 300; step++) controller.stepOnce(climbInput(step % 3 === 0), step === 150);
    return JSON.stringify(controller.captureState());
  };
  ok(run() === run(), 'a climb replays identically, so prediction and the relay cannot drift apart');
}

// Framing offsets move the eye in first person too -- which is exactly why the page keeps a
// separate set per mode instead of feeding one set to both (a shoulder camera would otherwise put
// the first-person eye out the side of the head).
{
  const settle = (opts) => { for (let i = 0; i < 200; i++) view.updateCamera(1 / 60, [0, 0, 0], opts); return camera.position.clone(); };
  const base = settle({ mode: 'firstPerson' });
  const sideways = settle({ mode: 'firstPerson', sideOffset: 0.6 });
  ok(Math.abs(sideways.x - base.x) > 0.3 || Math.abs(sideways.z - base.z) > 0.3, 'a side offset moves the first-person eye sideways');
  settle({ mode: 'firstPerson' });
  const raised = settle({ mode: 'firstPerson', heightOffset: 0.5 });
  ok(Math.abs(raised.y - base.y - 0.5) < 1e-3, 'a height offset raises the first-person eye by exactly that much');
  settle({ mode: 'firstPerson' });
  const anchored = settle({ mode: 'firstPerson', eyeAnchorY: 1.96, heightOffset: 0.25 });
  ok(Math.abs(anchored.y - (1.96 + 0.25)) < 1e-6, 'with a rig eye height the offset is applied once, on top of it');
}


// --- swimming (W8): the capsule floats on the shared water sim, on the tick clock ---
const flatSea = createBaseGameWaterSim({ level: 5, waves: { baseAmp: 0 }, enabled: true });
const swimmer = createBaseGamePlayerController({
  worldQuery,
  spawn: [0, 0.02, 0],
  waterSurfaceAt: (x, z, t) => flatSea.heightAt(x, z, t),
});
const swimCfg = swimmer.config;
const restSubmersion = swimCfg.floatDepth * (swimCfg.gravity / swimCfg.buoyancy);
const restFootY = 5 - restSubmersion - swimCfg.height * swimCfg.floatHeightFraction;

simulate(swimmer, 6);
ok(swimmer.swimming && !swimmer.grounded, 'a capsule under the surface swims instead of standing on the seabed');
ok(near(swimmer.getPosition()[1], restFootY, 0.05), `floats at the buoyancy equilibrium (${swimmer.getPosition()[1].toFixed(2)} vs ${restFootY.toFixed(2)})`);

const floatY = swimmer.getPosition()[1];
const dive = { moveX: 0, moveZ: 0, yaw: 0, sprint: false, crouch: true };
simulate(swimmer, 2, dive);
ok(swimmer.getPosition()[1] < floatY - 1, 'crouch swims down (to the seabed here)');
simulate(swimmer, 4, { moveX: 0, moveZ: 0, yaw: 0, sprint: false, crouch: false });
ok(near(swimmer.getPosition()[1], restFootY, 0.05), 'letting go floats back up to the surface');

// holding jump climbs faster than drifting up does, from the same depth
simulate(swimmer, 2, dive);
simulate(swimmer, 1, { moveX: 0, moveZ: 0, yaw: 0, sprint: false, crouch: false });
const driftedY = swimmer.getPosition()[1];
simulate(swimmer, 4, { moveX: 0, moveZ: 0, yaw: 0, sprint: false, crouch: false });
simulate(swimmer, 2, dive);
swimmer.setInput({ moveX: 0, moveZ: 0, yaw: 0, sprint: false });
for (let frame = 0; frame < 60; frame++) { swimmer.queueJump(); swimmer.advance(1 / 60); }
ok(swimmer.getPosition()[1] > driftedY + 0.5, `holding jump swims up (${swimmer.getPosition()[1].toFixed(2)} m vs ${driftedY.toFixed(2)} m drifting)`);

// horizontal drag: the same forward input covers less ground in water than on the floor
swimmer.reset([0, 0.02, 0]);
simulate(swimmer, 4, { moveX: 0, moveZ: 1, yaw: 0, sprint: false });
const swamZ = Math.abs(swimmer.getPosition()[2]);
const walker = createBaseGamePlayerController({ worldQuery, spawn: [0, 0.02, 0] });
simulate(walker, 4, { moveX: 0, moveZ: 1, yaw: 0, sprint: false });
const walkedZ = Math.abs(walker.getPosition()[2]);
ok(swamZ < walkedZ * 0.8, `swimming is slower than walking (${swamZ.toFixed(1)} m vs ${walkedZ.toFixed(1)} m)`);

// a swell lifts the body: the same column, waves on, tracks the surface within the wave band
const swell = createBaseGameWaterSim({ level: 5, waves: { count: 3, baseLength: 90, baseAmp: 0.8, chop: 0 }, enabled: true });
const rider = createBaseGamePlayerController({ worldQuery, spawn: [0, 0.02, 0], waterSurfaceAt: (x, z, t) => swell.heightAt(x, z, t) });
simulate(rider, 8);
let minRide = Infinity, maxRide = -Infinity, worstOffset = 0;
simulate(rider, 6, null, current => {
  const y = current.getPosition()[1];
  minRide = Math.min(minRide, y); maxRide = Math.max(maxRide, y);
  worstOffset = Math.max(worstOffset, Math.abs(current.waterSurface - y - (restSubmersion + swimCfg.height * swimCfg.floatHeightFraction)));
});
ok(maxRide - minRide > 0.3, `the body rides the swell (${(maxRide - minRide).toFixed(2)} m of travel)`);
ok(worstOffset < 1, `it stays near the surface while riding (worst offset ${worstOffset.toFixed(2)} m)`);

// draining the sea drops the swimmer back onto the floor
swell.setEnabled(false);
simulate(rider, 3);
ok(rider.grounded && !rider.swimming && near(rider.getPosition()[1], 0), 'with the sea gone the swimmer falls and lands grounded');

// the water clock is the tick, so the same ticks reproduce the same swim exactly
const scriptA = createBaseGamePlayerController({ worldQuery, spawn: [0, 0.02, 0], waterSurfaceAt: (x, z, t) => swell.heightAt(x, z, t) });
const scriptB = createBaseGamePlayerController({ worldQuery, spawn: [0, 0.02, 0], waterSurfaceAt: (x, z, t) => swell.heightAt(x, z, t) });
swell.setEnabled(true);
for (let k = 1; k <= 400; k++) {
  const step = { tick: k, moveX: 0, moveZ: 1, yaw: 0, sprint: false, crouch: k > 200 };
  scriptA.stepOnce(step, k % 90 === 0);
  scriptB.stepOnce({ ...step }, k % 90 === 0);
}
const a = scriptA.getPosition(), b = scriptB.getPosition();
ok(a[0] === b[0] && a[1] === b[1] && a[2] === b[2], 'the same tick script reproduces the same position bit for bit');
ok(scriptA.tick === 400 && scriptA.captureState().tick === 400, 'the controller carries the tick it last simulated');

const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
for (const marker of [
  'createBaseGamePlayerController',
  "playerControlMode: 'player'",
  "playerViewMode: 'firstPerson'",
  'worldCoordinates.maybeRebase(playerController.getPosition(playerPositionScratch))',
  'playerController.captureState()',
  'playerController.applyState(data.player)',
  'playerView.updateCamera',
  // Posture: the keys, and the stance actually reaching the local controller (not just the wire).
  "event.code === 'KeyC'",
  "event.code === 'KeyZ'",
  'stance: stanceIndex(playerStance)',
  'stanceWeights: playerController.stanceWeights,',
  'posture ${playerStance}',
  // Per-mode framing: the sliders edit one set, the frame feeds the set the live mode owns.
  "cameraOffsetTarget: 'thirdPerson'",
  'fpCameraSideOffset',
  'addCameraOffsetRange(',
  'firstPerson ? settings.fpCameraSideOffset : settings.cameraSideOffset,',
  'createBaseGameWaterSim',
  'waterSurfaceAt: (x, z, t) => waterSim.heightAt(x, z, t)',
]) ok(html.includes(marker), `base-game.html integrates ${marker}`);

view.dispose();
lab.dispose();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
