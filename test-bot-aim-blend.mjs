// node test-bot-aim-blend.mjs
// Covers bot-aim-blend.js: the authority split between torso, head and barrel trim, the trim rate
// limit, the aim lead, and the recoil channel. The load-bearing assertion is the last group: every
// channel at zero must reproduce the pre-2026-08-12 behaviour exactly, or the viewers that have not
// opted in change how they render.
import {
  AIM_BLEND_DEFAULTS, wrapAngle, clampAbs, easeToward, solveAimBlend, newAimChannels,
  stepAimChannels, barrelTrimFraction, releaseTrimFraction, aimLeadSeconds, addRecoil, stepRecoil,
  directionError,
} from './bot-aim-blend.js';

let checks = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}
function near(a, b, eps, label) {
  ok(Math.abs(a - b) <= eps, `${label} (got ${a}, want ${b} +/- ${eps})`);
}
// Every track ships off, so the maths below is exercised against an all-on config. The numbers still
// come from AIM_BLEND_DEFAULTS -- only the switches differ.
const ON = {
  ...AIM_BLEND_DEFAULTS,
  enabled: true, torsoEnabled: true, headEnabled: true, trimEnabled: true,
  barrelGate: true, leadEnabled: true, recoilEnabled: true,
};
const cfg = (over) => ({ ...ON, ...over });

// ── the shipped switches ─────────────────────────────────────────────────────────────────────
for (const key of ['enabled', 'torsoEnabled', 'headEnabled', 'trimEnabled', 'barrelGate', 'leadEnabled', 'recoilEnabled']) {
  ok(AIM_BLEND_DEFAULTS[key] === false, `${key} ships off`);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────
near(wrapAngle(Math.PI * 3), Math.PI, 1e-9, 'wrapAngle folds 3pi to pi');
near(wrapAngle(-Math.PI * 1.5), Math.PI * 0.5, 1e-9, 'wrapAngle folds -1.5pi');
near(clampAbs(5, 2), 2, 1e-12, 'clampAbs positive');
near(clampAbs(-5, 2), -2, 1e-12, 'clampAbs negative');
near(clampAbs(1, -2), 1, 1e-12, 'clampAbs takes the magnitude of the limit');
near(easeToward(0, 1, 0, 0.016), 1, 1e-12, 'rate 0 snaps');
near(easeToward(0, 1, 10, 0), 1, 1e-12, 'dt 0 snaps');
ok(easeToward(0, 1, 10, 0.016) > 0 && easeToward(0, 1, 10, 0.016) < 1, 'ease moves part of the way');
{
  let v = 0;
  for (let i = 0; i < 600; i++) v = easeToward(v, 1, 10, 1 / 60);
  near(v, 1, 1e-6, 'ease converges');
}

// ── the split ────────────────────────────────────────────────────────────────────────────────
{
  const out = solveAimBlend(0.4, 0.2, ON, {});
  near(out.torsoYaw + out.barrelYaw, 0.4, 1e-12, 'torso + barrel yaw = the commanded residual');
  near(out.torsoPitch + out.headPitch, 0.2, 1e-12, 'torso + head pitch = the commanded elevation');
  near(out.torsoYaw, 0.4 * AIM_BLEND_DEFAULTS.torsoYawShare, 1e-12, 'torso takes its share of the yaw');
  ok(out.headYaw !== 0, 'the head takes what the torso left');
  near(out.headYaw, 0.4 - out.torsoYaw, 1e-12, 'head yaw is RELATIVE to the twisted spine');
}
{
  // Sign symmetry: the split must not favour one side.
  const l = solveAimBlend(-0.4, -0.2, ON, {});
  const r = solveAimBlend(0.4, 0.2, ON, {});
  near(l.torsoYaw, -r.torsoYaw, 1e-12, 'yaw split is symmetric');
  near(l.torsoPitch, -r.torsoPitch, 1e-12, 'pitch split is symmetric');
}
{
  // Clamps hold at an extreme bearing, and the sum identity survives them.
  const out = solveAimBlend(3.0, 1.4, ON, {});
  near(out.torsoYaw, AIM_BLEND_DEFAULTS.torsoYawMax, 1e-12, 'torso yaw clamps');
  near(out.torsoPitch, AIM_BLEND_DEFAULTS.torsoPitchMax, 1e-12, 'torso pitch clamps');
  ok(Math.abs(out.headYaw) <= AIM_BLEND_DEFAULTS.headYawMax + 1e-12, 'head yaw clamps');
  near(out.torsoYaw + out.barrelYaw, 3.0, 1e-12, 'sum identity survives the clamps');
  near(out.torsoPitch + out.headPitch, 1.4, 1e-12, 'pitch sum identity survives the clamps');
}
{
  const out = solveAimBlend(Math.PI * 2 + 0.3, 0, ON, {});
  near(out.torsoYaw, 0.3 * AIM_BLEND_DEFAULTS.torsoYawShare, 1e-9, 'residual is wrapped before it is split');
}
{
  const out = solveAimBlend(NaN, undefined, ON, {});
  ok(Object.values(out).every(Number.isFinite), 'non-finite input degrades to zeros, never NaN');
}

// ── per-track switches ───────────────────────────────────────────────────────────────────────
{
  const out = solveAimBlend(0.5, 0.3, cfg({ torsoEnabled: false }), {});
  near(out.torsoYaw, 0, 1e-12, 'torso off: no twist');
  near(out.torsoPitch, 0, 1e-12, 'torso off: no lean');
  near(out.barrelYaw, 0.5, 1e-12, 'torso off: the barrel covers the whole angle, as it used to');
  near(out.headPitch, 0.3, 1e-12, 'torso off: the head keeps the whole elevation');
}
{
  const out = solveAimBlend(0.5, 0.3, cfg({ headEnabled: false }), {});
  near(out.headYaw, 0, 1e-12, 'head off: no look-at yaw');
  ok(out.torsoYaw !== 0, 'head off does not disable the torso');
}
{
  const out = solveAimBlend(0.5, 0.3, cfg({ enabled: false }), {});
  near(out.torsoYaw, 0, 1e-12, 'master off: no twist');
  near(out.headYaw, 0, 1e-12, 'master off: no look-at');
  near(out.barrelYaw, 0.5, 1e-12, 'master off: the barrel is the aiming mechanism again');
  near(out.headPitch, 0.3, 1e-12, 'master off: head pitch is the raw aim pitch');
}

// ── channel stepping ─────────────────────────────────────────────────────────────────────────
{
  const ch = newAimChannels();
  ok(Object.values(ch).every((v) => v === 0), 'a fresh channel set is all zeros');
  const solved = solveAimBlend(0.4, 0.2, ON, {});
  for (let i = 0; i < 600; i++) stepAimChannels(ch, solved, ON, 1 / 60, 1);
  near(ch.torsoYaw, solved.torsoYaw, 1e-6, 'torso yaw converges on the solved split');
  near(ch.headYaw, solved.headYaw, 1e-6, 'head yaw converges');
  near(ch.weight, 1, 1e-6, 'weight rises while an aim point exists');
  // Losing the target hands the channels back to zero, and the head back to the entity pitch.
  const idle = { torsoYaw: 0, torsoPitch: 0, headYaw: 0, headPitch: 0.11, barrelYaw: 0, barrelPitch: 0 };
  for (let i = 0; i < 600; i++) stepAimChannels(ch, idle, ON, 1 / 60, 0);
  near(ch.torsoYaw, 0, 1e-6, 'torso unwinds on sight loss');
  near(ch.weight, 0, 1e-6, 'weight falls on sight loss');
  near(ch.headPitch, 0.11, 1e-6, 'head pitch returns to the entity pitch, it does not snap to zero');
}
{
  // Nothing may jump: one 1/60 s step covers only a fraction of a large change.
  const ch = newAimChannels();
  const solved = solveAimBlend(3.0, 0, ON, {});
  stepAimChannels(ch, solved, ON, 1 / 60, 1);
  ok(ch.torsoYaw < solved.torsoYaw * 0.5, 'a single frame does not snap the torso onto the target');
}

// ── barrel trim (A1/A3) ──────────────────────────────────────────────────────────────────────
near(barrelTrimFraction(1, cfg({ barrelRate: 0 }), 1 / 60), 1, 1e-12, 'rate 0 applies the whole correction');
near(barrelTrimFraction(1, cfg({ trimEnabled: false }), 1 / 60), 1, 1e-12, 'trim off applies the whole correction');
near(barrelTrimFraction(1, cfg({ enabled: false }), 1 / 60), 1, 1e-12, 'master off applies the whole correction');
near(barrelTrimFraction(0, ON, 1 / 60), 1, 1e-12, 'a zero error needs no limiting');
{
  const dt = 1 / 60, err = 1.0;
  near(barrelTrimFraction(err, ON, dt), (AIM_BLEND_DEFAULTS.barrelRate * dt) / err, 1e-12,
    'the fraction is rate*dt/error');
  ok(barrelTrimFraction(0.001, ON, dt) === 1, 'a correction inside the frame budget is applied whole');
  ok(releaseTrimFraction(1.0, ON, dt) < barrelTrimFraction(1.0, ON, dt),
    'the release unwinds slower than the solve chases');
}
{
  // The reframe, as a property: with the body carrying the angle, what is left for the barrel goes
  // to zero. Body yaw eases toward the bearing; the torso takes its share of what remains.
  let bodyYaw = 0;
  const bearing = 1.2;
  let last = Infinity;
  for (let i = 0; i < 240; i++) {
    bodyYaw = easeToward(bodyYaw, bearing, 4.5, 1 / 60);
    const out = solveAimBlend(bearing - bodyYaw, 0, ON, {});
    ok(Math.abs(out.barrelYaw) <= last + 1e-9, 'the barrel residual never grows while the body closes');
    last = Math.abs(out.barrelYaw);
  }
  ok(last < 0.01, `barrel residual tends to zero (ended at ${last})`);
}

// ── lead (D) ─────────────────────────────────────────────────────────────────────────────────
near(aimLeadSeconds(50, 0, ON), 0, 1e-12, 'hitscan gets no lead even with the track on');
near(aimLeadSeconds(50, Infinity, ON), 0, 1e-12, 'an infinite speed gets no lead');
near(aimLeadSeconds(54, 108, ON), 0.5, 1e-12, 'a projectile leads by its flight time');
near(aimLeadSeconds(500, 108, ON), AIM_BLEND_DEFAULTS.leadMaxS, 1e-12, 'lead is capped');
near(aimLeadSeconds(54, 108, cfg({ leadEnabled: false })), 0, 1e-12, 'lead off');
near(aimLeadSeconds(54, 108, cfg({ enabled: false })), 0, 1e-12, 'master off disables the lead');
near(aimLeadSeconds(10, 100, cfg({ leadScale: 0.5 })), 0.05, 1e-12, 'lead scale applies');
near(aimLeadSeconds(0, 100, cfg({ leadLatencyS: 0.12 })), 0.12, 1e-12, 'latency lead is available but 0 in the numbers');

// ── recoil (D) ───────────────────────────────────────────────────────────────────────────────
{
  let r = 0;
  r = addRecoil(r, ON);
  near(r, AIM_BLEND_DEFAULTS.recoilKick, 1e-12, 'a shot kicks the torso');
  r = addRecoil(r, ON);
  near(r, AIM_BLEND_DEFAULTS.recoilKick * 2, 1e-12, 'sustained fire stacks');
  for (let i = 0; i < 300; i++) r = stepRecoil(r, ON, 1 / 60);
  near(r, 0, 1e-6, 'recoil settles back to zero');
  near(addRecoil(0, cfg({ recoilEnabled: false })), 0, 1e-12, 'recoil off');
  near(stepRecoil(0, ON, 1 / 60), 0, 1e-12, 'stepping a settled recoil is a no-op');
}

// ── direction error (A2) ─────────────────────────────────────────────────────────────────────
near(directionError(0, 0, 1, 0, 0, 1), 0, 1e-9, 'parallel directions have no error');
near(directionError(0, 0, 1, 1, 0, 0), Math.PI / 2, 1e-9, 'perpendicular is a quarter turn');
near(directionError(0, 0, 1, 0, 0, -1), Math.PI, 1e-9, 'opposite is a half turn');
near(directionError(0, 0, 2, 0, 0, 9), 0, 1e-9, 'magnitude does not matter');
near(directionError(0, 0, 0, 0, 0, 1), Math.PI, 1e-9, 'a degenerate direction reads as maximally wrong');

// ── the pin: everything off reproduces the legacy path ───────────────────────────────────────
{
  // The shipped defaults ARE this config now, so the legacy path is what an unconfigured caller gets.
  for (const off of [AIM_BLEND_DEFAULTS, cfg({ enabled: false })]) {
    for (const [yaw, pitch] of [[0, 0], [0.3, -0.2], [-1.1, 0.6], [2.9, 1.2]]) {
      const out = solveAimBlend(yaw, pitch, off, {});
      near(out.torsoYaw, 0, 1e-12, 'legacy: no torso yaw');
      near(out.torsoPitch, 0, 1e-12, 'legacy: no torso pitch');
      near(out.headYaw, 0, 1e-12, 'legacy: no look-at');
      near(out.barrelYaw, wrapAngle(yaw), 1e-12, 'legacy: the barrel covers the whole angle');
      near(out.headPitch, pitch, 1e-12, 'legacy: the head keeps the raw aim pitch');
    }
    near(barrelTrimFraction(2, off, 1 / 60), 1, 1e-12, 'legacy: the solve is applied whole');
    near(aimLeadSeconds(100, 50, off), 0, 1e-12, 'legacy: no lead');
    near(addRecoil(0, off), 0, 1e-12, 'legacy: no body recoil');
  }
}

// The default-argument path: a caller that omits cfg entirely gets the legacy behaviour too.
near(aimLeadSeconds(100, 50), 0, 1e-12, 'no cfg: no lead');
near(addRecoil(0), 0, 1e-12, 'no cfg: no body recoil');
{
  const out = solveAimBlend(0.5, 0.3);
  near(out.torsoYaw, 0, 1e-12, 'no cfg: no twist');
  near(out.barrelYaw, 0.5, 1e-12, 'no cfg: the barrel covers the whole angle');
}

console.log(`bot-aim-blend: all ${checks} assertions passed`);
