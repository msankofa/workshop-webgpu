import assert from 'node:assert/strict';
import {
  chooseOcclusionCandidate,
  dampAngle,
  stepOcclusionMemory,
  stepPovRecenter,
} from './bot-camera-control.js';

{
  const smoothed = dampAngle(Math.PI - 0.05, -Math.PI + 0.05, 1 / 60, 8);
  assert(smoothed > Math.PI - 0.05, 'angle damping takes the short path across the wrap boundary');
  assert(smoothed < Math.PI + 0.05, 'angle damping cannot overshoot its wrapped target');
}

{
  const hit = stepOcclusionMemory({
    distance: 8, clearDistance: 3, obstructed: true,
    now: 1000, holdUntil: 0, dt: 1 / 60,
  });
  assert.equal(hit.distance, 3, 'a newly closer wall constrains immediately');
  assert.equal(hit.holdUntil, 1700, 'a closer wall starts the memory hold');

  const held = stepOcclusionMemory({
    distance: hit.distance, clearDistance: 6, obstructed: true,
    now: 1300, holdUntil: hit.holdUntil, dt: 1 / 60,
  });
  assert.equal(held.distance, 3, 'a less restrictive wall cannot expand during the hold');

  const easingAlongWall = stepOcclusionMemory({
    distance: held.distance, clearDistance: 6, obstructed: true,
    now: 1800, holdUntil: held.holdUntil, dt: 1 / 60,
  });
  assert(easingAlongWall.distance > 3 && easingAlongWall.distance < 6,
    'after the hold, a less restrictive wall is approached gradually');

  const released = stepOcclusionMemory({
    distance: easingAlongWall.distance, clearDistance: 8, obstructed: false,
    now: 1850, holdUntil: easingAlongWall.holdUntil, dt: 1 / 60,
  });
  assert(released.distance > easingAlongWall.distance && released.distance < 8,
    'full release is gradual and cannot overshoot');

  const pushedAgain = stepOcclusionMemory({
    distance: released.distance, clearDistance: 2, obstructed: true,
    now: 1900, holdUntil: released.holdUntil, dt: 1 / 60,
  });
  assert.equal(pushedAgain.distance, 2, 'a further push wins during recovery');
  assert.equal(pushedAgain.holdUntil, 2600, 'a further push refreshes the hold');
}

assert.equal(
  chooseOcclusionCandidate([2, 4.1], [0, 1], 0, 0.35),
  1,
  'a materially clearer shoulder candidate wins',
);
assert.equal(
  chooseOcclusionCandidate([3, 3.5], [0, 0.2], 0, 0.35),
  0,
  'hysteresis rejects a marginal alternate angle',
);

{
  const waiting = stepPovRecenter({
    yaw: 0.8, pitch: -0.3, enabled: true, dragging: false,
    now: 1500, lastInputAt: 1000, delayMs: 800, dt: 1 / 60,
  });
  assert.deepEqual(waiting, { yaw: 0.8, pitch: -0.3 }, 'POV offset holds during its idle delay');

  const recentering = stepPovRecenter({
    yaw: 0.8, pitch: -0.3, enabled: true, dragging: false,
    now: 2000, lastInputAt: 1000, delayMs: 800, dt: 1 / 60,
  });
  assert(Math.abs(recentering.yaw) < 0.8, 'POV yaw recenters after the delay');
  assert(Math.abs(recentering.pitch) < 0.3, 'POV pitch recenters after the delay');

  const disabled = stepPovRecenter({
    yaw: 0.8, pitch: -0.3, enabled: false, dragging: false,
    now: 5000, lastInputAt: 0, delayMs: 0, dt: 1 / 60,
  });
  assert.deepEqual(disabled, { yaw: 0.8, pitch: -0.3 }, 'disabled POV recenter preserves free-look');

  const dragging = stepPovRecenter({
    yaw: 0.8, pitch: -0.3, enabled: true, dragging: true,
    now: 5000, lastInputAt: 0, delayMs: 0, dt: 1 / 60,
  });
  assert.deepEqual(dragging, { yaw: 0.8, pitch: -0.3 }, 'active POV drag always wins over recentering');
}

console.log('bot camera control tests passed');
