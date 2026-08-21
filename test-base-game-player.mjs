import * as THREE from 'three';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { createWorldQueryService } from './world-query.js';
import { createBaseGameTraversalLab } from './base-game-traversal-lab.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';
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

const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
for (const marker of [
  'createBaseGamePlayerController',
  "playerControlMode: 'player'",
  "playerViewMode: 'thirdPerson'",
  'worldCoordinates.maybeRebase(playerController.getPosition())',
  'playerController.captureState()',
  'playerController.applyState(data.player)',
  'playerView.updateCamera',
]) ok(html.includes(marker), `base-game.html integrates ${marker}`);

view.dispose();
lab.dispose();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
