// Aim authority split: how much of the angle between a bot's rendered facing and its aim point is
// taken up by the torso, the head, and the barrel trim. Pure -- no THREE, no DOM, no globals -- so
// the split is unit-testable in Node (test-bot-aim-blend.mjs) without a GPU.
//
// The contract the whole thing rests on: with `enabled` false, or with every channel at zero, the
// caller must render exactly what it rendered before this module existed. Every default below is
// chosen so that holds.

// Every track ships OFF (2026-08-16): the feature is opt-in, so an unconfigured viewer renders the
// pre-2026-08-12 aim. The numbers below are still the tuned ones a track uses once switched on.
export const AIM_BLEND_DEFAULTS = {
  enabled: false,
  torsoEnabled: false,      // track B: twist the spine toward the aim point
  headEnabled: false,       // track C: the head looks at the target instead of only anticipating turns
  trimEnabled: false,       // track A1/A3: rate-limit the barrel solve and unwind it on sight loss
  barrelGate: false,        // track A2: fire on the rendered barrel's error, not the entity's
  leadEnabled: false,       // track D: aim where the target will be
  recoilEnabled: false,     // track D: a shot kicks the torso, not just the weapon

  torsoYawMax: 0.61,        // rad, ~35 deg of twist
  torsoPitchMax: 0.44,      // rad, ~25 deg of lean
  torsoYawShare: 0.85,      // fraction of the yaw residual the torso tries to take
  torsoPitchShare: 0.55,    // fraction of the aim elevation the torso takes; the head keeps the rest
  torsoRate: 9,             // 1/s, how fast the torso channel chases its target

  headYawMax: 0.79,         // rad, ~45 deg -- matches the rig's own headTurnCfg.maxYaw
  headRate: 10,             // 1/s
  headLookWeight: 0.85,     // how far the look-at overrides the turn-anticipation yaw (1 = replace)

  barrelRate: 7,            // rad/s ceiling on the barrel trim; 0 disables the limit
  releaseRate: 6,           // rad/s the trim unwinds by once the aim point is gone

  // Seconds of aim latency added on top of flight time. Defaults to 0 on purpose: a hitscan round
  // arrives instantly, so leading one by any amount is a guaranteed miss ahead of the target. Only
  // real flight time is worth leading. The slider exists so tracking-ahead can be tried by eye.
  leadLatencyS: 0,
  leadScale: 1,
  leadMaxS: 0.5,

  recoilKick: 0.05,         // rad of torso pitch added per shot
  recoilDecay: 7,           // 1/s
};

export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function clampAbs(v, limit) {
  const l = Math.abs(limit);
  return v > l ? l : v < -l ? -l : v;
}

// Exponential chase, framerate-independent. rate <= 0 snaps (no smoothing requested).
export function easeToward(current, target, rate, dt) {
  if (!(rate > 0) || !(dt > 0)) return target;
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// The split itself. `yawResidual` is the signed angle from the body's RENDERED facing to the aim
// bearing; `aimPitch` is the elevation to the aim point. Both in radians.
//
// The head yaw is expressed RELATIVE to the twisted spine, because the rig parents the head to the
// shoulder-line rotation -- returning the absolute residual would sum with the torso and overshoot.
export function solveAimBlend(yawResidual, aimPitch, cfg = AIM_BLEND_DEFAULTS, out = {}) {
  const on = cfg.enabled !== false;
  const torso = on && cfg.torsoEnabled !== false;
  const head = on && cfg.headEnabled !== false;
  const yaw = Number.isFinite(yawResidual) ? wrapAngle(yawResidual) : 0;
  const pitch = Number.isFinite(aimPitch) ? aimPitch : 0;
  out.torsoYaw = torso ? clampAbs(yaw * cfg.torsoYawShare, cfg.torsoYawMax) : 0;
  out.torsoPitch = torso ? clampAbs(pitch * cfg.torsoPitchShare, cfg.torsoPitchMax) : 0;
  out.headYaw = head ? clampAbs(yaw - out.torsoYaw, cfg.headYawMax) : 0;
  // Total head elevation stays `aimPitch` however much of it the spine already carries.
  out.headPitch = pitch - out.torsoPitch;
  // What the barrel trim still has to cover. The head does not carry the gun, so it does not count.
  out.barrelYaw = yaw - out.torsoYaw;
  out.barrelPitch = pitch - out.torsoPitch;
  return out;
}

export function newAimChannels() {
  return { torsoYaw: 0, torsoPitch: 0, headYaw: 0, headPitch: 0, recoilPitch: 0, weight: 0 };
}

// Ease the live channels toward a solved split. Fading in and out is done by handing in a solved
// split of zeros (which is what a bot with no aim point gets), so acquisition and loss are the same
// code path as any other change of target -- nothing snaps either way.
//
// `weightTarget` tracks only whether an aim point exists at all; the caller uses it to fade the
// head's look-at over the rig's own turn-anticipation yaw.
export function stepAimChannels(ch, solved, cfg, dt, weightTarget = 1) {
  ch.weight = easeToward(ch.weight, weightTarget, cfg.headRate, dt);
  ch.torsoYaw = easeToward(ch.torsoYaw, solved.torsoYaw, cfg.torsoRate, dt);
  ch.torsoPitch = easeToward(ch.torsoPitch, solved.torsoPitch, cfg.torsoRate, dt);
  ch.headYaw = easeToward(ch.headYaw, solved.headYaw, cfg.headRate, dt);
  ch.headPitch = easeToward(ch.headPitch, solved.headPitch, cfg.headRate, dt);
  return ch;
}

// A1: what fraction of a barrel correction of `errorRad` may be applied this frame. 1 = all of it
// (which is what the viewer did before the limit existed).
export function barrelTrimFraction(errorRad, cfg, dt) {
  if (cfg.enabled === false || cfg.trimEnabled === false) return 1;
  const rate = cfg.barrelRate;
  if (!(rate > 0) || !(dt > 0)) return 1;
  const err = Math.abs(errorRad);
  if (!(err > 1e-6)) return 1;
  return Math.min(1, (rate * dt) / err);
}

// A3: the same fraction, for unwinding a held trim back to the authored hold after sight loss.
export function releaseTrimFraction(errorRad, cfg, dt) {
  if (cfg.enabled === false || cfg.trimEnabled === false) return 1;
  const rate = cfg.releaseRate;
  if (!(rate > 0) || !(dt > 0)) return 1;
  const err = Math.abs(errorRad);
  if (!(err > 1e-6)) return 1;
  return Math.min(1, (rate * dt) / err);
}

// D: how far ahead of the target to aim. Covers the projectile's flight plus the bot's own aim
// latency; hitscan weapons (speed 0 or non-finite) get the latency term only.
export function aimLeadSeconds(distance, projectileSpeed, cfg = AIM_BLEND_DEFAULTS) {
  if (cfg.enabled === false || cfg.leadEnabled === false) return 0;
  const flight = Number.isFinite(projectileSpeed) && projectileSpeed > 0 && Number.isFinite(distance)
    ? Math.max(0, distance) / projectileSpeed : 0;
  return Math.max(0, Math.min(cfg.leadMaxS, (flight + cfg.leadLatencyS) * cfg.leadScale));
}

// D: torso recoil. addRecoil on each shot, stepRecoil every frame.
export function addRecoil(value, cfg = AIM_BLEND_DEFAULTS) {
  if (cfg.enabled === false || cfg.recoilEnabled === false) return value;
  return value + cfg.recoilKick;
}

export function stepRecoil(value, cfg, dt) {
  if (!(value > 0)) return 0;
  return easeToward(value, 0, cfg.recoilDecay, dt);
}

// A2: angle between two unit-ish direction triples, in radians. The viewer feeds it the rendered
// barrel direction and the direction from the muzzle to the aim point.
export function directionError(ax, ay, az, bx, by, bz) {
  const al = Math.hypot(ax, ay, az), bl = Math.hypot(bx, by, bz);
  if (!(al > 1e-9) || !(bl > 1e-9)) return Math.PI;
  const d = (ax * bx + ay * by + az * bz) / (al * bl);
  return Math.acos(Math.max(-1, Math.min(1, d)));
}
