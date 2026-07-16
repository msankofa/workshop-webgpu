// Node tests for bot-activity.js (pure combat-bot FSM decision math, Phase 1: sentry).
// Run: node test-bot-activity.mjs
import {
  BOT_PATROL, BOT_SEEK, BOT_AIM, BOT_FIRE, SENSE_RANGE, AIM_TOLERANCE_RAD, TURN_RATE_RAD_S,
  chooseBotState, aimAnglesTo, aimError, slewAngle,
} from './bot-activity.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// states distinct
ok(new Set([BOT_PATROL, BOT_SEEK, BOT_AIM, BOT_FIRE]).size === 4, 'states distinct');

// no target, no last-known position -> patrol regardless of other ctx
{
  const { state } = chooseBotState({ ctx: { targetVisible: false, aimError: 0, readyToFire: true, hasLastKnown: false } });
  ok(state === BOT_PATROL, 'no visible target and no last-known position yields patrol');
}

// no target, but a remembered last-known position -> seek
{
  const { state } = chooseBotState({ ctx: { targetVisible: false, hasLastKnown: true } });
  ok(state === BOT_SEEK, 'no visible target but a last-known position yields seek');
}

// visible target always wins over seek/patrol, even with a stale last-known position
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: AIM_TOLERANCE_RAD + 0.1, hasLastKnown: true, readyToFire: false } });
  ok(state === BOT_AIM, 'visible target takes priority over hasLastKnown (aim, not seek)');
}

// visible but not aimed -> aim
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: AIM_TOLERANCE_RAD + 0.1, readyToFire: true } });
  ok(state === BOT_AIM, 'large aim error yields aim state even when ready to fire');
}

// visible, aimed, but cooldown not ready -> aim (holds aim, doesn't fire early)
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: 0, readyToFire: false } });
  ok(state === BOT_AIM, 'aimed but not ready to fire holds aim state');
}

// visible, aimed, ready -> fire
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: 0, readyToFire: true } });
  ok(state === BOT_FIRE, 'aimed and ready to fire yields fire state');
}

// aim tolerance boundary: exactly at tolerance is not "aimed enough" (strict >)
{
  const { state } = chooseBotState({ ctx: { targetVisible: true, aimError: AIM_TOLERANCE_RAD, readyToFire: true } });
  ok(state === BOT_FIRE, 'aim error exactly at tolerance counts as aimed');
}

// aimAnglesTo: straight ahead (+Z) is yaw 0, pitch 0
{
  const { yaw, pitch } = aimAnglesTo({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
  ok(Math.abs(yaw) < 1e-9, `yaw toward +Z is 0 (got ${yaw})`);
  ok(Math.abs(pitch) < 1e-9, `pitch toward level target is 0 (got ${pitch})`);
}
// aimAnglesTo: due +X is yaw +PI/2
{
  const { yaw } = aimAnglesTo({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
  ok(Math.abs(yaw - Math.PI / 2) < 1e-9, `yaw toward +X is PI/2 (got ${yaw})`);
}
// aimAnglesTo: target above is positive pitch
{
  const { pitch } = aimAnglesTo({ x: 0, y: 0, z: 0 }, { x: 0, y: 5, z: 5 });
  ok(pitch > 0, `pitch toward a target above is positive (got ${pitch})`);
}

// aimError: identical angles -> zero error
ok(aimError(0.4, 0.1, 0.4, 0.1) === 0, 'aimError is zero for identical yaw/pitch');
// aimError: wraps the short way around the circle (near +-PI boundary)
{
  const e = aimError(Math.PI - 0.05, 0, -Math.PI + 0.05, 0);
  ok(e < 0.2, `aimError takes the short way around the +-PI wrap (got ${e})`);
}

// slewAngle: step smaller than max reaches target exactly
{
  const a = slewAngle(0, 0.1, 0.5);
  ok(Math.abs(a - 0.1) < 1e-9, `slewAngle reaches target when within max delta (got ${a})`);
}
// slewAngle: step larger than max is capped, doesn't overshoot
{
  const a = slewAngle(0, 2, 0.2);
  ok(Math.abs(a - 0.2) < 1e-9, `slewAngle caps the step at maxDeltaRad (got ${a})`);
}
// slewAngle: takes the short way around the wrap
{
  const a = slewAngle(3.1, -3.1, 1); // shortest path crosses +-PI, not through 0
  ok(a > 3.1 || a < -3.1 + 1e-6, `slewAngle crosses the +-PI wrap the short way (got ${a})`);
}
// slewAngle: repeated stepping converges to target without overshoot oscillation
{
  let cur = 0;
  const target = 1.7;
  for (let i = 0; i < 200; i++) cur = slewAngle(cur, target, 0.05);
  ok(Math.abs(cur - target) < 1e-6, `repeated slewAngle steps converge to target (got ${cur})`);
}

// SENSE_RANGE is a sane positive metres value
ok(SENSE_RANGE > 0 && SENSE_RANGE < 200, 'SENSE_RANGE is a plausible in-map distance');
// TURN_RATE_RAD_S is positive and finite
ok(TURN_RATE_RAD_S > 0 && Number.isFinite(TURN_RATE_RAD_S), 'TURN_RATE_RAD_S is a positive finite rate');

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-activity: all assertions passed');
