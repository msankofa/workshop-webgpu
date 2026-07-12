// view-feel.js
// Pure, THREE-free math for first-person "game feel": run/gun weapon bob, trauma
// screen shake, strafe tilt / momentum lean easing, and HUD drag. Kept renderer-free
// so it unit-tests with plain `node test-view-feel.mjs`, same pattern as
// weapon-sequence.js. environment-viewer.html imports these and applies the results to
// the camera / weapon group / HUD. Ported from html-game-v2's feel layers.

// Perpendicular "sideways" bob axis for run bob, in the camera-local frame. `mx,mz` are
// the player's move direction already rotated into camera-local space with y stripped
// (so +x = right, -z = forward). Returns the unit axis 90deg from motion: pure forward
// motion -> {x:1,z:0} (bob left/right), pure strafe -> bob fore/aft. Degenerate input
// falls back to a plain left/right bob.
export function runBobAxis(mx, mz) {
  const len2 = mx * mx + mz * mz;
  if (len2 <= 1e-4) return { x: 1, z: 0 };
  const inv = 1 / Math.sqrt(len2);
  const nx = mx * inv, nz = mz * inv;
  return { x: -nz, z: nx };
}

// Sample a trauma-driven shake as camera pitch/yaw/roll offsets (radians). trauma is 0..1;
// squaring it makes the shake punchy near a hit and taper smoothly to nothing. `time` is a
// free-running seconds clock (the sine phases are irrational multiples so it never visibly
// repeats). max* cap each axis at full trauma.
export function traumaShake(trauma, time, maxPitch, maxYaw, maxRoll) {
  const s = trauma * trauma;
  if (s <= 0) return { pitch: 0, yaw: 0, roll: 0 };
  const t = time * 42;
  return {
    pitch: Math.sin(t * 1.13 + 0.7) * maxPitch * s,
    yaw: Math.sin(t * 1.71 + 2.3) * maxYaw * s,
    roll: Math.sin(t * 1.37 + 5.1) * maxRoll * s,
  };
}

// Exponential-ish decay of trauma toward 0 (linear in dt, clamped at 0).
export function decayTrauma(trauma, dt, rate) {
  return Math.max(0, trauma - dt * rate);
}

// Add trauma without exceeding 1 (multiple impacts stack but saturate).
export function addTrauma(trauma, amount) {
  return Math.min(1, trauma + Math.max(0, amount));
}

// Frame-rate-independent ease from `cur` toward `target`. rate is the stiffness (higher =
// snappier); the Math.min(1, ...) guard keeps a big dt from overshooting past the target.
export function easeToward(cur, target, dt, rate) {
  return cur + (target - cur) * Math.min(1, dt * rate);
}

// Momentum lean pitch target: lean forward under acceleration, back under braking.
// `accel` is d(speed)/dt; negative scale + clamp keeps it bounded and signed correctly
// (accelerating -> negative pitch = look down/forward).
export function momentumLeanTarget(accel, scale, max) {
  const v = -accel * scale;
  return v < -max ? -max : v > max ? max : v;
}

// HUD drag target offset (px) from look angular velocity. dYaw/dPitch are this frame's
// look deltas (radians); dividing by dt gives rad/s, gain converts to px, clamped to maxPx.
// Large deltas (teleport/respawn) should be zeroed by the caller before calling this.
export function hudDragTarget(dYaw, dPitch, dt, gain, maxPx) {
  if (dt <= 0) return { x: 0, y: 0 };
  const clamp = (v) => (v < -maxPx ? -maxPx : v > maxPx ? maxPx : v);
  return {
    x: clamp((dYaw / dt) * gain),
    y: clamp((dPitch / dt) * gain),
  };
}

// Clamp look pitch to just under straight up/down so the view can't flip over.
export const MAX_LOOK_PITCH = Math.PI * 0.5 - 0.02;
export function clampLookPitch(pitch) {
  return pitch < -MAX_LOOK_PITCH ? -MAX_LOOK_PITCH : pitch > MAX_LOOK_PITCH ? MAX_LOOK_PITCH : pitch;
}
