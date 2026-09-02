// A10: the two things that stood between a bot seeing you and killing you -- nothing at all.
// Pure math for reaction (how long before a fresh contact is shootable) and dispersion (how far
// off the muzzle ray lands). No Three.js, no globals: the viewer owns state, this owns the curves.

export const AIM_DEFAULTS = {
  reactionEnabled: true,
  reactionMs: 260,            // recognition delay on a fresh contact at point blank
  reactionPerMetreMs: 12,     // added per metre of range (far targets register slower)
  reactionMaxMs: 900,         // ceiling, so a long sightline never means never
  reactionMinMs: 100,         // floor once the scales below stack, so no delay reads as inhuman
  alertReactionScale: 0.55,   // multiplier while the bot is already on a squad alert tier
  primedReactionScale: 0.4,   // multiplier while primed: mid-fight retarget/re-sight is an attention shift, not fresh recognition
  reactionJitter01: 0.25,     // +/- this fraction of the delay, per contact, so a file doesn't fire in unison
  reacquireGraceMs: 600,      // sight breaks shorter than this keep the existing acquisition
  spreadEnabled: true,
  baseSpreadDeg: 0.35,        // settled, stationary, first round of a burst
  moveSpreadDeg: 2.5,         // added at full run speed
  firstShotSpreadDeg: 2.0,    // added the instant a contact is acquired, decays over settleMs
  settleMs: 800,              // how long holding the same target takes to earn the tight cone
  bloomPerShotDeg: 0.45,      // recoil climb per shot fired
  bloomMaxDeg: 4.0,
  bloomDecayDegPerSecond: 3.0,
};

const clamp01 = (v) => (v > 1 ? 1 : v < 0 ? 0 : (Number(v) || 0));
const DEG = Math.PI / 180;

// Base Game exposes one 0..1 accuracy rule instead of the brain's individual cone controls.
// 0.5 is the donor/default behaviour, 0 doubles every dispersion contribution, and 1 is exact.
export function aimSettingsForAccuracy(accuracy, settings = AIM_DEFAULTS) {
  const scale = 2 * (1 - clamp01(accuracy));
  return {
    baseSpreadDeg: settings.baseSpreadDeg * scale,
    moveSpreadDeg: settings.moveSpreadDeg * scale,
    firstShotSpreadDeg: settings.firstShotSpreadDeg * scale,
    bloomPerShotDeg: settings.bloomPerShotDeg * scale,
    bloomMaxDeg: settings.bloomMaxDeg * scale,
  };
}

// Fresh-contact recognition delay in ms. `jitter01` is a caller-supplied 0..1 roll.
// `primed` = the bot recently held a completed contact (target switch, post-peek re-sight).
export function reactionDelayMs(distance, { alerted = false, primed = false, jitter01 = 0.5 } = {}, settings = AIM_DEFAULTS) {
  const s = { ...AIM_DEFAULTS, ...settings };
  if (!s.reactionEnabled) return 0;
  const range = Math.max(0, Number(distance) || 0);
  let ms = s.reactionMs + s.reactionPerMetreMs * range;
  if (alerted) ms *= s.alertReactionScale;
  if (primed) ms *= s.primedReactionScale;
  ms *= 1 + s.reactionJitter01 * (clamp01(jitter01) * 2 - 1);
  return Math.max(0, Math.min(s.reactionMaxMs, Math.max(s.reactionMinMs ?? 0, ms)));
}

// 1 the moment a target is acquired, 0 once the bot has held it for settleMs.
export function settleFactor01(heldMs, settings = AIM_DEFAULTS) {
  const s = { ...AIM_DEFAULTS, ...settings };
  if (!(s.settleMs > 0)) return 0;
  return clamp01(1 - Math.max(0, Number(heldMs) || 0) / s.settleMs);
}

// Half-angle of the cone the next round is drawn from, in radians.
export function spreadHalfAngleRad({ moveSpeed01 = 0, heldMs = Infinity, bloomDeg = 0 } = {}, settings = AIM_DEFAULTS) {
  const s = { ...AIM_DEFAULTS, ...settings };
  if (!s.spreadEnabled) return 0;
  const deg = s.baseSpreadDeg +
    s.moveSpreadDeg * clamp01(moveSpeed01) +
    s.firstShotSpreadDeg * settleFactor01(heldMs, s) +
    Math.max(0, Math.min(s.bloomMaxDeg, Number(bloomDeg) || 0));
  return Math.max(0, deg) * DEG;
}

export function bloomAfterShot(bloomDeg, settings = AIM_DEFAULTS) {
  const s = { ...AIM_DEFAULTS, ...settings };
  return Math.min(s.bloomMaxDeg, Math.max(0, Number(bloomDeg) || 0) + s.bloomPerShotDeg);
}

export function decayBloomDeg(bloomDeg, dtSeconds, settings = AIM_DEFAULTS) {
  const s = { ...AIM_DEFAULTS, ...settings };
  const decay = s.bloomDecayDegPerSecond * Math.max(0, Number(dtSeconds) || 0);
  return Math.max(0, (Math.max(0, Number(bloomDeg) || 0)) - decay);
}

// Rotate `dir` off-axis by a point drawn uniformly from the disc of half-angle `halfAngleRad`.
// r1/r2 are caller-supplied 0..1 rolls, so a test can pin the exact deflection.
export function dispersedDirection(dir, halfAngleRad, r1, r2, out = { x: 0, y: 0, z: 0 }) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const fx = dir.x / len, fy = dir.y / len, fz = dir.z / len;
  const half = Math.max(0, Number(halfAngleRad) || 0);
  if (half <= 0) { out.x = fx; out.y = fy; out.z = fz; return out; }
  // Any axis not parallel to the shot works as the basis seed.
  const ax = Math.abs(fy) < 0.9 ? 0 : 1, ay = Math.abs(fy) < 0.9 ? 1 : 0;
  let ux = ay * fz - 0 * fy, uy = 0 * fx - ax * fz, uz = ax * fy - ay * fx;
  const ulen = Math.hypot(ux, uy, uz) || 1;
  ux /= ulen; uy /= ulen; uz /= ulen;
  const vx = fy * uz - fz * uy, vy = fz * ux - fx * uz, vz = fx * uy - fy * ux;
  const angle = half * Math.sqrt(clamp01(r1));   // sqrt keeps the disc uniform, not centre-heavy
  const az = 2 * Math.PI * clamp01(r2);
  const sin = Math.sin(angle), cos = Math.cos(angle);
  const ox = Math.cos(az), oy = Math.sin(az);
  const dx = fx * cos + (ux * ox + vx * oy) * sin;
  const dy = fy * cos + (uy * ox + vy * oy) * sin;
  const dz = fz * cos + (uz * ox + vz * oy) * sin;
  const dlen = Math.hypot(dx, dy, dz) || 1;
  out.x = dx / dlen; out.y = dy / dlen; out.z = dz / dlen;
  return out;
}
