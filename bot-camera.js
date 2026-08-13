// Pure camera intent model: the camera's state is these fields, and the rendered pose is derived
// from them. Nothing here reads a pose back. THREE-free and DOM-free so Node can test it, same
// convention as bot-camera-control.js.
import { dampAlpha } from './bot-camera-control.js';

export const PITCH_LIMIT = 1.48;          // ±85°, symmetric -- no more one-sided polar clamp
export const EYE_EXIT = 0.9;              // above this distance the view is fully third-person
export const ZOOM_SHIFT = 0.6;            // distance = ZOOM_SHIFT * (e^z - 1), so z=0 lands on 0 m
export const ZOOM_STEP = 0.18;            // per wheel notch, in z-space
export const GROUND_CLEARANCE = 0.25;
export const MAX_PAN = 12;                // pan is a framing nudge, not a second focus

const TAU = Math.PI * 2;

export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

// Shortest signed angle from `from` to `to`.
export function angleDelta(to, from) {
  return ((to - from + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

export function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// 1 when the eye sits at the focus point, 0 once fully orbiting.
export function eyeBlendFor(distance) {
  return 1 - smoothstep(0, EYE_EXIT, Math.max(0, distance));
}

// Look direction for a yaw/pitch pair. +Z forward at yaw 0, matching bot-entity's convention.
export function forwardFor(yaw, pitch, out = { x: 0, y: 0, z: 0 }) {
  const horizontal = Math.cos(pitch);
  out.x = Math.sin(yaw) * horizontal;
  out.y = Math.sin(pitch);
  out.z = Math.cos(yaw) * horizontal;
  return out;
}

export function createCameraIntent(overrides = {}) {
  return {
    anchorId: null,
    drive: false,
    focus: { x: 0, y: 0, z: 0 },
    pan: { x: 0, y: 0, z: 0 },
    yaw: 0.66,
    pitch: -0.42,
    distance: 7.5,
    fov: 55,
    lastBotYaw: null,       // for the eye-mode carry; null until the first anchored frame
    lastBotPitch: null,
    ...overrides,
    ...(overrides.focus ? { focus: { ...overrides.focus } } : {}),
    ...(overrides.pan ? { pan: { ...overrides.pan } } : {}),
  };
}

export function rotateIntent(cam, dyaw, dpitch) {
  cam.yaw = ((cam.yaw + dyaw) % TAU + TAU) % TAU;
  cam.pitch = clamp(cam.pitch + dpitch, -PITCH_LIMIT, PITCH_LIMIT);
  return cam;
}

// Log-scaled so a notch feels the same at 0.5 m and 80 m, and so z=0 reaches exactly 0 m.
export function distanceToZoom(distance) {
  return Math.log(Math.max(0, distance) / ZOOM_SHIFT + 1);
}
export function zoomToDistance(z) {
  return ZOOM_SHIFT * (Math.exp(Math.max(0, z)) - 1);
}
export function zoomIntent(cam, notches) {
  cam.distance = zoomToDistance(distanceToZoom(cam.distance) - notches * ZOOM_STEP);
  return cam;
}

// Screen-space pan: the world offset per pixel scales with distance, so framing holds while zooming.
export function panIntent(cam, dx, dy, basis, scale = 0.0016) {
  const gain = scale * Math.max(cam.distance, 1.2);
  cam.pan.x += (basis.right.x * -dx + basis.up.x * dy) * gain;
  cam.pan.y += (basis.right.y * -dx + basis.up.y * dy) * gain;
  cam.pan.z += (basis.right.z * -dx + basis.up.z * dy) * gain;
  const length = Math.hypot(cam.pan.x, cam.pan.y, cam.pan.z);
  if (length > MAX_PAN) {
    const k = MAX_PAN / length;
    cam.pan.x *= k; cam.pan.y *= k; cam.pan.z *= k;
  }
  return cam;
}

export function clearPan(cam) {
  cam.pan.x = 0; cam.pan.y = 0; cam.pan.z = 0;
  return cam;
}

// Drive-mode WASD. `move` is {forward, right, up} in -1..1; the basis comes from the current angles.
export function translateFocus(cam, move, dt, speed) {
  const forward = forwardFor(cam.yaw, cam.pitch);
  const rightX = Math.cos(cam.yaw), rightZ = -Math.sin(cam.yaw);
  let x = forward.x * move.forward + rightX * move.right;
  let y = forward.y * move.forward + move.up;
  let z = forward.z * move.forward + rightZ * move.right;
  const length = Math.hypot(x, y, z);
  if (length < 1e-8) return cam;
  const k = (speed * dt) / length;
  cam.focus.x += x * k;
  cam.focus.y += y * k;
  cam.focus.z += z * k;
  return cam;
}

// Anchored frames: ease the focus onto the bot and carry the user's angles with the bot's turn.
// Carrying a *delta* rather than storing a bot-relative offset is what makes the eye blend
// continuous -- at eyeBlend 0 the bot's turning does nothing, at 1 the view is locked to its aim.
export function stepCameraFocus(cam, ctx, dt) {
  const anchor = ctx.anchorPoint;
  if (!anchor) {
    cam.lastBotYaw = null;
    cam.lastBotPitch = null;
    return cam;
  }
  const alpha = dampAlpha(dt, ctx.focusRate ?? 7);
  cam.focus.x += (anchor.x - cam.focus.x) * alpha;
  cam.focus.y += (anchor.y - cam.focus.y) * alpha;
  cam.focus.z += (anchor.z - cam.focus.z) * alpha;

  const eye = eyeBlendFor(clamp(cam.distance, 0, ctx.maxDistance ?? Infinity));
  const weight = eye * (ctx.povFollowWeight ?? 0.9);
  if (weight > 0 && Number.isFinite(ctx.botYaw)) {
    if (cam.lastBotYaw !== null) {
      rotateIntent(cam,
        angleDelta(ctx.botYaw, cam.lastBotYaw) * weight,
        (Number.isFinite(ctx.botPitch) && cam.lastBotPitch !== null
          ? ctx.botPitch - cam.lastBotPitch : 0) * weight);
    }
    cam.lastBotYaw = ctx.botYaw;
    cam.lastBotPitch = Number.isFinite(ctx.botPitch) ? ctx.botPitch : null;
  } else {
    cam.lastBotYaw = Number.isFinite(ctx.botYaw) ? ctx.botYaw : null;
    cam.lastBotPitch = Number.isFinite(ctx.botPitch) ? ctx.botPitch : null;
  }
  return cam;
}

// Opt-in only (D3): the default is that a free-look offset persists instead of decaying.
export function decayTowardBotAim(cam, ctx, dt, rate) {
  if (!(rate > 0) || !Number.isFinite(ctx.botYaw)) return cam;
  const alpha = dampAlpha(dt, rate);
  cam.yaw += angleDelta(ctx.botYaw, cam.yaw) * alpha;
  if (Number.isFinite(ctx.botPitch)) cam.pitch += (ctx.botPitch - cam.pitch) * alpha;
  return cam;
}

export function recenterOnBotAim(cam, ctx) {
  if (Number.isFinite(ctx.botYaw)) cam.yaw = ctx.botYaw;
  if (Number.isFinite(ctx.botPitch)) cam.pitch = clamp(ctx.botPitch, -PITCH_LIMIT, PITCH_LIMIT);
  return cam;
}

// The only place a pose comes from. Read-only: call stepCameraFocus first for the per-frame easing.
export function resolveCameraPose(cam, ctx = {}) {
  const maxDistance = ctx.maxDistance ?? Infinity;
  // Clamped here and never written back, so a map that shrinks and regrows restores the zoom.
  const distance = clamp(cam.distance, 0, maxDistance);
  const eyeBlend = eyeBlendFor(distance);
  const forward = forwardFor(cam.yaw, cam.pitch);
  const targetX = cam.focus.x + cam.pan.x;
  const targetY = cam.focus.y + cam.pan.y;
  const targetZ = cam.focus.z + cam.pan.z;

  const position = {
    x: targetX - forward.x * distance,
    y: targetY - forward.y * distance,
    z: targetZ - forward.z * distance,
  };
  // Soft ground push -- bounded, and the reason a valley camera can still look up.
  if (typeof ctx.groundHeight === 'function') {
    const floor = ctx.groundHeight(position.x, position.z) + GROUND_CLEARANCE;
    if (position.y < floor) position.y = floor;
  }
  return {
    position,
    lookAt: { x: position.x + forward.x, y: position.y + forward.y, z: position.z + forward.z },
    forward,
    fov: cam.fov,
    eyeBlend,
    distance,
  };
}

export function captureIntent(cam) {
  return {
    anchorId: cam.anchorId, drive: cam.drive,
    focus: { ...cam.focus }, pan: { ...cam.pan },
    yaw: cam.yaw, pitch: cam.pitch, distance: cam.distance, fov: cam.fov,
  };
}

export function restoreIntent(cam, state = {}) {
  if (state.focus) cam.focus = { ...cam.focus, ...state.focus };
  if (state.pan) cam.pan = { ...cam.pan, ...state.pan };
  if (Number.isFinite(state.yaw)) cam.yaw = state.yaw;
  if (Number.isFinite(state.pitch)) cam.pitch = clamp(state.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  if (Number.isFinite(state.distance)) cam.distance = Math.max(0, state.distance);
  if (Number.isFinite(state.fov)) cam.fov = clamp(state.fov, 30, 90);
  if (typeof state.drive === 'boolean') cam.drive = state.drive;
  if ('anchorId' in state) cam.anchorId = state.anchorId;
  cam.lastBotYaw = null;
  cam.lastBotPitch = null;
  return cam;
}

// Legacy slots stored a follow direction vector; convert it to the angles intent uses.
export function yawPitchFromDirection(direction) {
  const { x = 0, y = 0, z = 1 } = direction || {};
  const length = Math.hypot(x, y, z) || 1;
  const nx = x / length, ny = y / length, nz = z / length;
  return {
    yaw: ((Math.atan2(-nx, -nz) % TAU) + TAU) % TAU,
    pitch: clamp(Math.asin(-ny), -PITCH_LIMIT, PITCH_LIMIT),
  };
}
