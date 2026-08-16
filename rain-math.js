// rain-math.js — CPU twin of the maths inside rain.js's TSL graphs.
//
// Nothing here is imported by rain.js. It exists so the drop wrap, the streak basis, the
// occluder-map lookup and the ripple clock can be asserted in Node without a GPU (the same
// reason forest-cull.js mirrors forest-gpu.js). Keep it in sync by hand when rain.js changes.

// GLSL-style mod: always in [0, y) for y > 0, unlike JS %.
export function fmod(x, y) { return x - y * Math.floor(x / y); }

// Where drop `seed` (each component 0..1) sits at time t, wrapped into the camera-following box.
// origin is the box's min corner; vol its size; wind (x, z) and fall speed are in m/s.
export function dropPosition(seed, t, { origin, vol, wind, speed }) {
  const base = [seed[0] * vol[0], seed[1] * vol[1], seed[2] * vol[2]];
  const disp = [wind[0] * t, -speed * t, wind[2] * t];
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = fmod(base[i] + disp[i] - origin[i], vol[i]) + origin[i];
  return out;
}

// The box min corner for a camera at c: centred in x/z, biased upward so drops fall INTO view.
export function volumeOrigin(cam, vol, upBias = 0.85) {
  return [cam[0] - vol[0] * 0.5, cam[1] - vol[1] * upBias, cam[2] - vol[2] * 0.5];
}

function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

// Velocity of a drop as the eye sees it: wind (+gust) and fall, minus the camera's own motion.
export function relativeVelocity(wind, speed, camVel = [0, 0, 0]) {
  return [wind[0] - camVel[0], -speed - camVel[1], wind[2] - camVel[2]];
}

// Streak axes: `along` is the apparent motion direction, `side` is perpendicular to both it and the
// view ray, so the quad is edge-on to nobody and always faces the camera.
export function streakBasis(wind, speed, dropPos, camPos, camVel = [0, 0, 0]) {
  const along = norm(relativeVelocity(wind, speed, camVel));
  const toCam = norm([camPos[0] - dropPos[0], camPos[1] - dropPos[1], camPos[2] - dropPos[2]]);
  let side = cross(along, toCam);
  if (Math.hypot(...side) < 1e-6) side = [1, 0, 0]; // looking straight up the streak
  return { along, side: norm(side) };
}

// Streak length is motion blur: base length (authored at 18 m/s) × per-drop spread × apparent speed.
export function streakLength(baseLen, rnd, relSpeed) {
  const k = Math.min(3, Math.max(0.25, relSpeed / 18));
  return baseLen * (0.7 + 0.6 * rnd) * k;
}

// Drops within arm's reach of the lens fade out so nothing smears across the whole frame.
export function nearFade(dist, a = 0.25, b = 1.4) {
  const t = Math.min(1, Math.max(0, (dist - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Occluder-map uv for a world XZ, given the bake centre and total extent (a square). Outside → null.
export function occluderUv(x, z, center, extent) {
  const u = (x - center[0]) / extent + 0.5;
  const v = (z - center[1]) / extent + 0.5;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [u, v];
}

// A drop is visible only while it is above whatever the occluder map says is under it.
export function dropVisible(dropY, roofY) { return dropY > roofY; }

// Ripple clock for one ground cell: phase 0..1 through the ring's life; `birth` is the per-cell
// hash so cells do not pulse in unison. Ring radius grows linearly, amplitude decays linearly.
export function rippleState(t, speed, birth) {
  const life = fmod(t * speed + birth, 1);
  return { life, radius: life * 0.5, amp: 1 - life };
}

// Density 0..1 → instance count, never below 1 so the draw call stays valid.
export function countForDensity(density, maxCount) {
  const d = Math.min(1, Math.max(0, density));
  return Math.max(1, Math.floor(d * maxCount));
}
