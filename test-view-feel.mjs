// node test-view-feel.mjs
import {
  runBobAxis, traumaShake, decayTrauma, addTrauma, easeToward,
  momentumLeanTarget, hudDragTarget, clampLookPitch, MAX_LOOK_PITCH,
} from './view-feel.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }
function close(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// runBobAxis: forward motion (-z) -> left/right axis (x=1)
{
  const a = runBobAxis(0, -1);
  ok(close(a.x, 1) && close(a.z, 0), `forward run bobs sideways, got ${JSON.stringify(a)}`);
}
// pure right strafe (+x) -> fore/aft axis (z=1)
{
  const a = runBobAxis(1, 0);
  ok(close(a.x, 0) && close(a.z, 1), `strafe run bobs fore/aft, got ${JSON.stringify(a)}`);
}
// always unit length
{
  const a = runBobAxis(0.3, -0.9);
  ok(close(Math.hypot(a.x, a.z), 1), `axis is unit length, got ${Math.hypot(a.x, a.z)}`);
}
// degenerate -> fallback left/right
{
  const a = runBobAxis(0, 0);
  ok(close(a.x, 1) && close(a.z, 0), `degenerate falls back to sideways, got ${JSON.stringify(a)}`);
}

// traumaShake: zero trauma -> no shake
{
  const s = traumaShake(0, 12.3, 0.08, 0.08, 0.07);
  ok(s.pitch === 0 && s.yaw === 0 && s.roll === 0, 'zero trauma = no shake');
}
// full trauma stays within caps
{
  let maxP = 0, maxY = 0, maxR = 0;
  for (let t = 0; t < 5; t += 0.017) {
    const s = traumaShake(1, t, 0.08, 0.05, 0.07);
    maxP = Math.max(maxP, Math.abs(s.pitch));
    maxY = Math.max(maxY, Math.abs(s.yaw));
    maxR = Math.max(maxR, Math.abs(s.roll));
  }
  ok(maxP <= 0.08 + 1e-9 && maxY <= 0.05 + 1e-9 && maxR <= 0.07 + 1e-9, `shake within caps p${maxP} y${maxY} r${maxR}`);
}
// trauma-squared: half trauma gives quarter amplitude at a fixed phase
{
  const full = traumaShake(1, 1.0, 0.08, 0.08, 0.07);
  const half = traumaShake(0.5, 1.0, 0.08, 0.08, 0.07);
  ok(close(half.pitch, full.pitch * 0.25), `trauma squared: ${half.pitch} vs ${full.pitch * 0.25}`);
}

// decayTrauma / addTrauma
ok(close(decayTrauma(1, 0.5, 0.8), 0.6), 'decayTrauma linear');
ok(decayTrauma(0.1, 1, 0.8) === 0, 'decayTrauma clamps at 0');
ok(close(addTrauma(0.6, 0.3), 0.9), 'addTrauma stacks');
ok(addTrauma(0.8, 0.5) === 1, 'addTrauma saturates at 1');

// easeToward: converges, never overshoots on big dt
ok(close(easeToward(0, 10, 0.1, 5), 5), 'easeToward half step');
ok(easeToward(0, 10, 100, 5) === 10, 'easeToward clamps to target on huge dt');

// momentumLeanTarget
ok(momentumLeanTarget(100, 0.0006, 0.016) === -0.016, 'accel leans forward (clamped)');
ok(momentumLeanTarget(-100, 0.0006, 0.016) === 0.016, 'brake leans back (clamped)');
ok(close(momentumLeanTarget(10, 0.0006, 0.016), -0.006), 'small accel unclamped');

// hudDragTarget
{
  const d = hudDragTarget(0.02, 0, 0.016, 1.4, 20);
  ok(close(d.x, (0.02 / 0.016) * 1.4) && d.y === 0, `hud drag x from yaw vel, got ${JSON.stringify(d)}`);
}
ok(hudDragTarget(100, 0, 0.016, 1.4, 20).x === 20, 'hud drag clamps to maxPx');
ok(hudDragTarget(0.5, 0.5, 0, 1.4, 20).x === 0, 'hud drag zero on dt<=0');

// clampLookPitch
ok(clampLookPitch(10) === MAX_LOOK_PITCH, 'pitch clamps up');
ok(clampLookPitch(-10) === -MAX_LOOK_PITCH, 'pitch clamps down');
ok(clampLookPitch(0.3) === 0.3, 'pitch passes through in range');

console.log(`view-feel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
