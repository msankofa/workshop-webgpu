// Node smoke tests for bot-aim.js (A10 reaction + dispersion math).
import assert from 'node:assert/strict';
import {
  AIM_DEFAULTS, reactionDelayMs, settleFactor01, spreadHalfAngleRad,
  bloomAfterShot, decayBloomDeg, dispersedDirection,
} from './bot-aim.js';

let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

// --- reactionDelayMs ---
const mid = { jitter01: 0.5 }; // 0.5 = no jitter, so the curve is testable
check(reactionDelayMs(0, mid) === AIM_DEFAULTS.reactionMs, 'point-blank delay is the base delay');
check(reactionDelayMs(10, mid) > reactionDelayMs(2, mid), 'further targets take longer to register');
check(reactionDelayMs(10, { ...mid, alerted: true }) < reactionDelayMs(10, mid), 'an alerted bot reacts faster');
check(reactionDelayMs(1000, mid) === AIM_DEFAULTS.reactionMaxMs, 'delay is capped');
check(reactionDelayMs(-5, mid) === AIM_DEFAULTS.reactionMs, 'negative range is clamped, not negative delay');
check(reactionDelayMs(10, mid, { ...AIM_DEFAULTS, reactionEnabled: false }) === 0, 'toggle off = instant, the old behaviour');
check(reactionDelayMs(5, { jitter01: 0 }) < reactionDelayMs(5, mid), 'low jitter roll shortens');
check(reactionDelayMs(5, { jitter01: 1 }) > reactionDelayMs(5, mid), 'high jitter roll lengthens');
check(reactionDelayMs(5, { jitter01: 5 }) === reactionDelayMs(5, { jitter01: 1 }), 'out-of-range rolls clamp');
{
  const s = { ...AIM_DEFAULTS, reactionJitter01: 0 };
  const a = reactionDelayMs(6, { jitter01: 0 }, s), b = reactionDelayMs(6, { jitter01: 1 }, s);
  check(a === b, 'zero jitter setting makes the roll irrelevant');
}
check(reactionDelayMs(10, { ...mid, primed: true }) < reactionDelayMs(10, mid), 'a primed bot reacts faster');
check(reactionDelayMs(0, { jitter01: 0, alerted: true, primed: true }) === AIM_DEFAULTS.reactionMinMs, 'stacked scales floor at the minimum');
check(reactionDelayMs(0, mid, { ...AIM_DEFAULTS, reactionMinMs: undefined }) === AIM_DEFAULTS.reactionMs, 'an absent floor is inert');

// --- settleFactor01 ---
check(settleFactor01(0) === 1, 'a just-acquired target is at full first-shot penalty');
check(settleFactor01(AIM_DEFAULTS.settleMs) === 0, 'penalty is gone after settleMs');
check(settleFactor01(AIM_DEFAULTS.settleMs * 10) === 0, 'penalty never goes negative');
check(settleFactor01(Infinity) === 0, 'an infinitely held aim is fully settled');
check(Math.abs(settleFactor01(AIM_DEFAULTS.settleMs / 2) - 0.5) < 1e-9, 'penalty decays linearly');

// --- spreadHalfAngleRad ---
const settled = { moveSpeed01: 0, heldMs: Infinity, bloomDeg: 0 };
check(spreadHalfAngleRad(settled) > 0, 'even a settled bot has some spread');
check(Math.abs(spreadHalfAngleRad(settled) - AIM_DEFAULTS.baseSpreadDeg * Math.PI / 180) < 1e-9, 'settled spread is the base cone');
check(spreadHalfAngleRad({ ...settled, moveSpeed01: 1 }) > spreadHalfAngleRad(settled), 'running widens the cone');
check(spreadHalfAngleRad({ ...settled, moveSpeed01: 5 }) === spreadHalfAngleRad({ ...settled, moveSpeed01: 1 }), 'move factor clamps at full speed');
check(spreadHalfAngleRad({ ...settled, heldMs: 0 }) > spreadHalfAngleRad(settled), 'the opening shot is the loosest');
check(spreadHalfAngleRad({ ...settled, bloomDeg: 2 }) > spreadHalfAngleRad(settled), 'recoil bloom widens the cone');
check(spreadHalfAngleRad({ ...settled, bloomDeg: 99 }) === spreadHalfAngleRad({ ...settled, bloomDeg: AIM_DEFAULTS.bloomMaxDeg }), 'bloom is capped inside the cone too');
check(spreadHalfAngleRad({ heldMs: 0, moveSpeed01: 1, bloomDeg: 9 }, { ...AIM_DEFAULTS, spreadEnabled: false }) === 0, 'toggle off = perfect ray, the old behaviour');
check(spreadHalfAngleRad() > 0, 'missing args fall back to the widest sane defaults, not NaN');

// --- bloom ---
check(bloomAfterShot(0) === AIM_DEFAULTS.bloomPerShotDeg, 'one shot climbs by one step');
check(bloomAfterShot(AIM_DEFAULTS.bloomMaxDeg) === AIM_DEFAULTS.bloomMaxDeg, 'bloom saturates');
check(decayBloomDeg(2, 0) === 2, 'no time, no decay');
check(decayBloomDeg(4, 0.5) === 4 - AIM_DEFAULTS.bloomDecayDegPerSecond * 0.5, 'decay is per second');
check(decayBloomDeg(0.1, 10) === 0, 'decay stops at zero');
check(decayBloomDeg(undefined, 1) === 0, 'undefined bloom reads as zero');
{
  let b = 0;
  for (let i = 0; i < 20; i++) b = bloomAfterShot(b);
  check(b === AIM_DEFAULTS.bloomMaxDeg, 'a long burst pins bloom at the cap');
  check(decayBloomDeg(b, 5) === 0, 'a pause fully recovers it');
}

// --- dispersedDirection ---
const forward = { x: 0, y: 0, z: 1 };
{
  const d = dispersedDirection(forward, 0, 0.9, 0.3);
  check(Math.abs(d.z - 1) < 1e-12, 'zero spread returns the original ray');
}
{
  const d = dispersedDirection(forward, 0.1, 0, 0.5);
  check(Math.abs(d.z - 1) < 1e-12, 'a zero radius roll lands dead centre');
}
{
  const half = 0.05;
  const d = dispersedDirection(forward, half, 1, 0.25);
  const angle = Math.acos(Math.max(-1, Math.min(1, d.x * forward.x + d.y * forward.y + d.z * forward.z)));
  check(Math.abs(angle - half) < 1e-9, 'a full radius roll deflects by exactly the half-angle');
  check(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-12, 'the dispersed ray stays unit length');
}
{
  // Opposite azimuths must mirror through the shot axis.
  const a = dispersedDirection(forward, 0.05, 1, 0.0);
  const b = dispersedDirection(forward, 0.05, 1, 0.5);
  check(Math.abs(a.x + b.x) < 1e-9 && Math.abs(a.y + b.y) < 1e-9, 'opposite azimuths mirror');
}
{
  // Straight up: the basis seed swaps, and the result must still be a real deflection.
  const up = { x: 0, y: 1, z: 0 };
  const d = dispersedDirection(up, 0.05, 1, 0.1);
  const angle = Math.acos(Math.max(-1, Math.min(1, d.y)));
  check(Math.abs(angle - 0.05) < 1e-9, 'a vertical shot disperses correctly (degenerate basis)');
}
{
  const d = dispersedDirection({ x: 0, y: 0, z: 5 }, 0.05, 0.4, 0.6);
  check(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-12, 'an unnormalised input ray is normalised');
}
{
  // Statistical: the mean deflection of a uniform disc sits at 2/3 of the half-angle.
  const half = 0.1;
  let sum = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const d = dispersedDirection(forward, half, (i + 0.5) / n, (i * 0.618) % 1);
    sum += Math.acos(Math.max(-1, Math.min(1, d.z)));
  }
  check(Math.abs(sum / n - half * 2 / 3) < half * 0.02, 'deflections are uniform over the disc');
}
{
  const out = { x: 0, y: 0, z: 0 };
  const d = dispersedDirection(forward, 0.05, 0.5, 0.5, out);
  check(d === out, 'writes into the supplied out object (no per-shot allocation)');
}

console.log(`bot-aim: ${checks} checks passed`);
