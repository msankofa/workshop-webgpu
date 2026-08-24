import * as THREE from 'three';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createWorldQueryService } from './world-query.js';
import { createBaseGameTraversalLab } from './base-game-traversal-lab.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';
import { createBaseGameWaterSim } from './base-game-water-sim.js';
import { createBaseGamePlayerView } from './base-game-player-view.js';
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
simulate(controller, 0.75, { moveX: 0, moveZ: 1, yaw: 0, sprint: false });
ok(controller.getPosition()[2] < startZ - 2, 'camera-relative forward input advances the global 3D capsule');

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
simulate(controller, 0.8, { moveX: 0, moveZ: -1, yaw: 0, sprint: false }, current => {
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
  "playerViewMode: 'thirdPerson'",
  'worldCoordinates.maybeRebase(playerController.getPosition(playerPositionScratch))',
  'playerController.captureState()',
  'playerController.applyState(data.player)',
  'playerView.updateCamera',
  'createBaseGameWaterSim',
  'waterSurfaceAt: (x, z, t) => waterSim.heightAt(x, z, t)',
]) ok(html.includes(marker), `base-game.html integrates ${marker}`);

view.dispose();
lab.dispose();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
