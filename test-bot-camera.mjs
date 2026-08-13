import assert from 'node:assert/strict';
import {
  EYE_EXIT,
  GROUND_CLEARANCE,
  PITCH_LIMIT,
  angleDelta,
  captureIntent,
  createCameraIntent,
  distanceToZoom,
  eyeBlendFor,
  panIntent,
  recenterOnBotAim,
  resolveCameraPose,
  restoreIntent,
  rotateIntent,
  stepCameraFocus,
  translateFocus,
  yawPitchFromDirection,
  zoomIntent,
  zoomToDistance,
} from './bot-camera.js';

// The property the old design could not hold: deriving a pose must not disturb the intent.
{
  const cam = createCameraIntent({ yaw: 1.1, pitch: -0.3, distance: 9.25 });
  cam.focus = { x: 4, y: 1.5, z: -2 };
  const before = captureIntent(cam);
  for (let i = 0; i < 10; i++) resolveCameraPose(cam, { maxDistance: 90 });
  assert.deepEqual(captureIntent(cam), before, 'resolving a pose never writes back to the intent');
}

// Pose round-trip: position must sit exactly `distance` from the aim point, along the look ray.
{
  const cam = createCameraIntent({ yaw: 2.4, pitch: 0.35, distance: 6 });
  cam.focus = { x: -3, y: 2, z: 7 };
  const pose = resolveCameraPose(cam, { maxDistance: 90 });
  const dx = pose.lookAt.x - pose.position.x;
  const dy = pose.lookAt.y - pose.position.y;
  const dz = pose.lookAt.z - pose.position.z;
  assert(Math.abs(Math.hypot(dx, dy, dz) - 1) < 1e-9, 'lookAt is one unit along the forward ray');
  const toTarget = Math.hypot(
    cam.focus.x - pose.position.x, cam.focus.y - pose.position.y, cam.focus.z - pose.position.z);
  assert(Math.abs(toTarget - 6) < 1e-9, 'the camera sits exactly `distance` from the focus');
}

{
  const cam = createCameraIntent({ pitch: 0 });
  rotateIntent(cam, 0, 99);
  assert.equal(cam.pitch, PITCH_LIMIT, 'pitch clamps at the top');
  rotateIntent(cam, 0, -99);
  assert.equal(cam.pitch, -PITCH_LIMIT, 'pitch clamps symmetrically at the bottom');
  assert(PITCH_LIMIT > Math.PI * 0.485 - Math.PI / 2 + 1.4,
    'the new limit reaches far below the old maxPolarAngle');
}

{
  const cam = createCameraIntent({ yaw: 0 });
  rotateIntent(cam, -0.5, 0);
  assert(cam.yaw > 0, 'yaw wraps into [0, 2pi) rather than going negative');
  assert(Math.abs(angleDelta(cam.yaw, 0) + 0.5) < 1e-9, 'the wrapped yaw is still -0.5 away');
}

// Log zoom: monotonic, self-inverse, and it can actually reach 0 without a special case.
{
  assert(Math.abs(zoomToDistance(distanceToZoom(7.5)) - 7.5) < 1e-9, 'zoom mapping round-trips');
  assert.equal(zoomToDistance(0), 0, 'zero in z-space is exactly zero metres');

  const cam = createCameraIntent({ distance: 7.5 });
  let previous = cam.distance;
  for (let i = 0; i < 40; i++) {
    zoomIntent(cam, 1);
    if (previous > 0) assert(cam.distance < previous, 'scrolling in is strictly monotonic');
    else assert.equal(cam.distance, 0, 'zoom saturates at the eye instead of going negative');
    previous = cam.distance;
  }
  assert.equal(cam.distance, 0, 'enough notches in reaches exactly zero, not an asymptote');

  zoomIntent(cam, -1);
  assert(cam.distance > 0, 'scrolling back out leaves the eye');

  // Proportional once distance dominates the shift term...
  const far = createCameraIntent({ distance: 60 });
  const mid = createCameraIntent({ distance: 30 });
  const farRatio = (zoomIntent(far, 1), far.distance / 60);
  const midRatio = (zoomIntent(mid, 1), mid.distance / 30);
  assert(Math.abs(farRatio - midRatio) < 0.01, 'a notch is the same proportion at 30 m and 60 m');

  // ...but deliberately sub-proportional near the eye, which is what lets zoom land exactly on 0.
  const close = createCameraIntent({ distance: 1 });
  const closeRatio = (zoomIntent(close, 1), close.distance / 1);
  assert(closeRatio < farRatio, 'steps shrink near the eye so the last notch can reach it');
}

// Eye blend must be continuous, and so must the pose across the threshold.
{
  assert.equal(eyeBlendFor(0), 1, 'zero distance is fully first person');
  assert.equal(eyeBlendFor(EYE_EXIT), 0, 'past the exit distance is fully third person');
  assert.equal(eyeBlendFor(-5), 1, 'a negative distance cannot escape the blend');

  let previousBlend = eyeBlendFor(0);
  let previousY = null;
  const cam = createCameraIntent({ yaw: 0.4, pitch: -0.2 });
  cam.focus = { x: 0, y: 1.6, z: 0 };
  for (let step = 0; step <= 200; step++) {
    cam.distance = (step / 200) * (EYE_EXIT * 1.5);
    const blend = eyeBlendFor(cam.distance);
    assert(Math.abs(blend - previousBlend) < 0.05, 'eye blend has no step discontinuity');
    previousBlend = blend;
    const pose = resolveCameraPose(cam, { maxDistance: 90 });
    if (previousY !== null) {
      assert(Math.abs(pose.position.y - previousY) < 0.05, 'camera height moves smoothly to the eye');
    }
    previousY = pose.position.y;
  }
}

// Anchored turning carries the user's angle by a delta -- weight 0 must not drag the view at all.
{
  const cam = createCameraIntent({ yaw: 1, distance: 4 });
  const ctx = { anchorPoint: { x: 0, y: 1.6, z: 0 }, botYaw: 0, povFollowWeight: 0, maxDistance: 90 };
  stepCameraFocus(cam, ctx, 1 / 60);
  ctx.botYaw = 2;
  stepCameraFocus(cam, ctx, 1 / 60);
  assert.equal(cam.yaw, 1, 'a zero follow weight leaves the user angle untouched');
}

{
  const cam = createCameraIntent({ yaw: 1, distance: 0 });
  const ctx = { anchorPoint: { x: 0, y: 1.6, z: 0 }, botYaw: 0, povFollowWeight: 1, maxDistance: 90 };
  stepCameraFocus(cam, ctx, 1 / 60);   // seeds lastBotYaw without moving the view
  assert.equal(cam.yaw, 1, 'the first anchored frame does not jerk the view to the bot aim');
  ctx.botYaw = 0.5;
  stepCameraFocus(cam, ctx, 1 / 60);
  assert(Math.abs(cam.yaw - 1.5) < 1e-9, 'at full weight the bot turn carries the view one-for-one');
  assert(Math.abs(angleDelta(cam.yaw, ctx.botYaw) - 1) < 1e-9,
    'the user free-look offset survives the turn instead of decaying');
}

{
  const cam = createCameraIntent({ yaw: 1, distance: 0 });
  const ctx = { anchorPoint: { x: 0, y: 1.6, z: 0 }, botYaw: 0, botPitch: 0.2, povFollowWeight: 1 };
  stepCameraFocus(cam, ctx, 1 / 60);
  recenterOnBotAim(cam, ctx);
  assert.equal(cam.yaw, 0, 'explicit recenter snaps yaw to the bot aim');
  assert.equal(cam.pitch, 0.2, 'explicit recenter snaps pitch to the bot aim');
}

{
  const cam = createCameraIntent();
  cam.focus = { x: 10, y: 10, z: 10 };
  stepCameraFocus(cam, { anchorPoint: { x: 0, y: 0, z: 0 }, focusRate: 7 }, 1 / 60);
  const progress = (10 - cam.focus.x) / 10;
  assert(progress > 0 && progress < 0.25, 'the focus eases toward the anchor rather than snapping');
  stepCameraFocus(cam, {}, 1 / 60);
  assert.equal(cam.lastBotYaw, null, 'unanchoring clears the carry state so re-anchoring cannot jerk');
}

// Ground push is applied to the pose, never to the intent.
{
  const cam = createCameraIntent({ yaw: 0, pitch: 1.2, distance: 8 });
  cam.focus = { x: 0, y: 0.5, z: 0 };
  const pose = resolveCameraPose(cam, { maxDistance: 90, groundHeight: () => 3 });
  assert(Math.abs(pose.position.y - (3 + GROUND_CLEARANCE)) < 1e-9, 'the camera is pushed above ground');
  assert.equal(cam.pitch, 1.2, 'the ground push does not rewrite the requested pitch');
}

// The bug this replaces: a map resize used to clamp the stored distance and lose it permanently.
{
  const cam = createCameraIntent({ distance: 42 });
  const small = resolveCameraPose(cam, { maxDistance: 12 });
  assert.equal(small.distance, 12, 'the applied distance respects a smaller map');
  assert.equal(cam.distance, 42, 'the requested distance is not overwritten by the clamp');
  const large = resolveCameraPose(cam, { maxDistance: 90 });
  assert.equal(large.distance, 42, 'growing the map restores the original zoom');
}

{
  const cam = createCameraIntent({ distance: 5 });
  const basis = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };
  panIntent(cam, 100, 0, basis);
  assert(cam.pan.x < 0, 'dragging right moves the world right, i.e. the pan offset goes left');
  for (let i = 0; i < 400; i++) panIntent(cam, 100, 100, basis);
  assert(Math.hypot(cam.pan.x, cam.pan.y, cam.pan.z) <= 12 + 1e-9, 'pan is bounded');
}

{
  const cam = createCameraIntent({ yaw: 0, pitch: 0 });
  cam.focus = { x: 0, y: 0, z: 0 };
  translateFocus(cam, { forward: 1, right: 0, up: 0 }, 1, 10);
  assert(Math.abs(cam.focus.z - 10) < 1e-9, 'driving forward at yaw 0 moves along +Z');
  assert(Math.abs(cam.focus.x) < 1e-9, 'driving forward introduces no lateral drift');

  const diagonal = createCameraIntent({ yaw: 0, pitch: 0 });
  diagonal.focus = { x: 0, y: 0, z: 0 };
  translateFocus(diagonal, { forward: 1, right: 1, up: 0 }, 1, 10);
  const travelled = Math.hypot(diagonal.focus.x, diagonal.focus.y, diagonal.focus.z);
  assert(Math.abs(travelled - 10) < 1e-9, 'diagonal drive is normalized, not faster');
}

// Legacy slot migration: the stored follow direction pointed from target to camera.
{
  const { yaw, pitch } = yawPitchFromDirection({ x: 0, y: 0, z: 1 });
  assert(Math.abs(angleDelta(yaw, Math.PI)) < 1e-9, 'a +Z offset means the camera looks toward -Z');
  assert(Math.abs(pitch) < 1e-9, 'a level offset converts to level pitch');

  const above = yawPitchFromDirection({ x: 0, y: 1, z: 0 });
  assert(above.pitch < 0, 'an offset above the target converts to a downward pitch');

  const cam = createCameraIntent();
  restoreIntent(cam, { yaw: 0.3, pitch: 9, distance: 11, fov: 200, drive: true });
  assert.equal(cam.pitch, PITCH_LIMIT, 'restore clamps a hostile pitch');
  assert.equal(cam.fov, 90, 'restore clamps a hostile fov');
  assert.equal(cam.distance, 11, 'restore keeps a valid distance');
  assert.equal(cam.drive, true, 'restore carries the drive axis');
  assert.equal(cam.lastBotYaw, null, 'restore clears carry state');
}

console.log('bot-camera: all assertions passed');
