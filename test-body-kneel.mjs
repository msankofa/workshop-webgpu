// test-body-kneel.mjs
//
// The kneel pose (KNEEL_DEFAULTS in player-procedural-body.js) is a CLOSED kinematic chain: unlike
// prone, which lerps a foot target and lets IK find the knee, kneeling authors the knee AND the
// foot. If the authored positions do not sit at true bone length from each other, placeSegment
// stretch-fits and the limbs visibly grow or shrink. That is the one property the whole design
// rests on, and it is pure arithmetic over the exported defaults — so it is tested here.
//
// Run: node test-body-kneel.mjs

import { KNEEL_DEFAULTS, BODY_DESIGN_DEFAULTS } from './player-procedural-body.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${detail ? `  (${detail})` : ''}`); }
}

// Mirrors the body factory: H is the fixed skeleton baseline for EVERY body (only meshes scale
// per-instance), which is why the kneel offsets are in limb units and never in state.height.
const H = 1.8;
const legLen = H * BODY_DESIGN_DEFAULTS.legLenRatio;
const thighLen = legLen * BODY_DESIGN_DEFAULTS.thighFrac;
const shinLen = legLen * BODY_DESIGN_DEFAULTS.shinFrac;
const R = 0.35;
const hipWidth = R * 2 * 0.42;          // gait.cfg.hipWidthRatio at its default

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const err = (got, want) => Math.abs(got - want) / want;

// Rebuilds the joint positions exactly as the leg loop does, in the body's own frame:
// +x right, +y up, +z heading, origin at the ground under the body.
function kneelJoints(cfg, sideSign) {
  const rear = sideSign === (cfg.side < 0 ? -1 : 1);
  const hip = { x: sideSign * hipWidth * 0.5, y: thighLen * cfg.hipHeight, z: 0 };
  if (rear) {
    const knee = { x: sideSign * thighLen * cfg.rearKneeSpread, y: thighLen * cfg.rearKneeHeight, z: 0 };
    const foot = { x: knee.x, y: knee.y + shinLen * cfg.rearFootHeight, z: knee.z - shinLen * cfg.rearFootBack };
    return { hip, knee, foot, rear };
  }
  const knee = {
    x: sideSign * shinLen * cfg.frontFootSpread,
    y: thighLen * cfg.frontKneeHeight,
    z: thighLen * cfg.frontKneeFwd,
  };
  const foot = { x: knee.x, y: shinLen * cfg.frontFootHeight, z: knee.z };
  return { hip, knee, foot, rear };
}

const TOL = 0.05;   // 5% of bone length — beyond this the stretch is visible on a limb

// ---------------------------------------------------------------------------
// 1. Both chains close at true bone length, for both handednesses.
// ---------------------------------------------------------------------------
for (const side of [1, -1]) {
  const cfg = { ...KNEEL_DEFAULTS, side };
  for (const sideSign of [-1, 1]) {
    const { hip, knee, foot, rear } = kneelJoints(cfg, sideSign);
    const label = `${side > 0 ? 'right-handed' : 'left-handed'} ${rear ? 'rear' : 'front'} leg`;
    const thighErr = err(dist(hip, knee), thighLen);
    const shinErr = err(dist(knee, foot), shinLen);
    check(`closure: ${label} thigh is true length`, thighErr < TOL, `off by ${(thighErr * 100).toFixed(1)}%`);
    check(`closure: ${label} shin is true length`, shinErr < TOL, `off by ${(shinErr * 100).toFixed(1)}%`);
  }
}

// ---------------------------------------------------------------------------
// 2. The pose reads as a kneel, not as a squat or a crouch.
// ---------------------------------------------------------------------------
{
  const cfg = KNEEL_DEFAULTS;
  const rear = kneelJoints(cfg, 1);
  const front = kneelJoints(cfg, -1);
  check('shape: the rear knee is on the ground', rear.knee.y < 0.06, `y=${rear.knee.y.toFixed(3)}`);
  check('shape: the front foot is on the ground', front.foot.y < 0.08, `y=${front.foot.y.toFixed(3)}`);
  check('shape: the front foot is planted ahead of the hips', front.foot.z > 0.35, `z=${front.foot.z.toFixed(3)}`);
  check('shape: the rear foot trails behind the hips', rear.foot.z < -0.35, `z=${rear.foot.z.toFixed(3)}`);
  // Thigh horizontal + shin vertical is what separates a kneel from a deep squat.
  const frontThighRise = Math.abs(front.knee.y - front.hip.y);
  check('shape: the front thigh is near horizontal', frontThighRise < 0.10, `rise=${frontThighRise.toFixed(3)}`);
  const frontShinLean = Math.hypot(front.foot.x - front.knee.x, front.foot.z - front.knee.z);
  check('shape: the front shin is near vertical', frontShinLean < 0.10, `lean=${frontShinLean.toFixed(3)}`);
  // The rear thigh is what sets hip height; if it is not vertical the hip height is a coincidence.
  const rearThighLean = Math.hypot(rear.hip.x - rear.knee.x, rear.hip.z - rear.knee.z);
  check('shape: the rear thigh is near vertical', rearThighLean < 0.12, `lean=${rearThighLean.toFixed(3)}`);
  // Feet must not cross the centre line, or the legs interpenetrate.
  check('shape: legs stay on their own side', Math.sign(rear.foot.x) !== Math.sign(front.foot.x));
}

// ---------------------------------------------------------------------------
// 3. Hip height is reachable: the pelvis can never be further from the ground than a leg.
// ---------------------------------------------------------------------------
{
  const hipY = thighLen * KNEEL_DEFAULTS.hipHeight;
  check('reach: the kneeling hip is within leg reach', hipY < legLen, `hip=${hipY.toFixed(3)} legLen=${legLen.toFixed(3)}`);
  check('reach: the kneeling hip is below the standing hip', hipY < H * 0.58, `hip=${hipY.toFixed(3)}`);
  const front = kneelJoints(KNEEL_DEFAULTS, -1);
  check('reach: the front foot is within leg reach of its hip', dist(front.hip, front.foot) < legLen,
    `${dist(front.hip, front.foot).toFixed(3)} vs ${legLen.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 4. Mirroring `side` is a true mirror, not a re-tune.
// ---------------------------------------------------------------------------
{
  const r = kneelJoints({ ...KNEEL_DEFAULTS, side: 1 }, 1);      // right leg, right-handed => rear
  const l = kneelJoints({ ...KNEEL_DEFAULTS, side: -1 }, -1);    // left leg, left-handed => rear
  check('mirror: both handednesses kneel on their own side', r.rear && l.rear);
  check('mirror: the mirrored rear knee matches', Math.abs(r.knee.x + l.knee.x) < 1e-9 && Math.abs(r.knee.y - l.knee.y) < 1e-9);
  check('mirror: the mirrored rear foot matches', Math.abs(r.foot.z - l.foot.z) < 1e-9);
}

// ---------------------------------------------------------------------------
// 5. Defaults are sane as data (guards against a bad paste from the tuning harness).
// ---------------------------------------------------------------------------
{
  const cfg = KNEEL_DEFAULTS;
  check('data: side is +1 or -1', cfg.side === 1 || cfg.side === -1);
  check('data: every field is finite', Object.values(cfg).every(Number.isFinite));
  check('data: hipHeight is a limb multiple, not metres', cfg.hipHeight > 0.4 && cfg.hipHeight < 1.6, `${cfg.hipHeight}`);
  check('data: drops stay in 0..1', [cfg.torsoDrop, cfg.headDrop, cfg.shoulderDrop].every((v) => v >= 0 && v <= 1));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
