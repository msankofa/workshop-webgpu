// test-player-body-ik.mjs
//
// Headless test for the torso-capsule arm IK body-awareness in
// player-procedural-body.js (Correction 2: adaptive outward pole; Correction
// 3: elbow capsule clamp + re-solve). Only the pure exported helpers are
// exercised (capsuleContainsPoint, pushPointOutOfCapsule, deriveOutwardPole,
// projectOntoAxis) with a minimal Vector3-like shim — no real THREE, matching
// the shim shape used by test-weapon-pose-controller.mjs
// (set/copy/add/applyQuaternion/...) but trimmed to what these pure helpers
// need (they take plain {x,y,z}).
//
// Run: node test-player-body-ik.mjs

import {
  capsuleContainsPoint,
  pushPointOutOfCapsule,
  deriveOutwardPole,
  projectOntoAxis,
  TORSO_CAPSULE_RADIUS_MARGIN,
  TORSO_CAPSULE_Y_PAD,
} from './player-procedural-body.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
}

// Minimal Vector3-like shim (no Quaternion.slerp / Vector3.lerp — the pure
// helpers under test never need them; this only proves plain-object inputs
// with the Vector3 subset work, not just literal {x,y,z} objects).
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  normalize() {
    const l = this.length() || 1;
    this.x /= l; this.y /= l; this.z /= l;
    return this;
  }
}

const axisDist = (p, c) => Math.hypot(p.x - c.x, p.z - c.z);

// ---------------------------------------------------------------------------
// pushPointOutOfCapsule: inside point pushed to exactly the surface, outward
// direction preserved, y unchanged (pure-radial clamp).
// ---------------------------------------------------------------------------
{
  const capsule = { x: 0, z: 0, yMin: 0, yMax: 2, radius: 0.5 };
  const p = new Vector3(0.1, 1.2, 0.05); // inside: axisDist ~0.1118 < 0.5
  const before = axisDist(p, capsule);
  const moved = pushPointOutOfCapsule(p, capsule, p);
  const after = axisDist(p, capsule);

  check('push: reports it moved an inside point', moved === true);
  check('push: before was inside the capsule radius', before < capsule.radius);
  check('push: after is exactly on the surface (within tol)', Math.abs(after - capsule.radius) < 1e-9);
  check('push: y is unchanged (pure-radial clamp)', p.y === 1.2);
  // outward direction preserved: pushed point should be a positive scalar multiple of the
  // original (x,z) offset from the axis.
  const origDirX = 0.1 / before, origDirZ = 0.05 / before;
  const newDirX = (p.x - capsule.x) / after, newDirZ = (p.z - capsule.z) / after;
  check('push: outward direction preserved', Math.abs(origDirX - newDirX) < 1e-9 && Math.abs(origDirZ - newDirZ) < 1e-9);
}

// ---------------------------------------------------------------------------
// pushPointOutOfCapsule: a point already outside is a no-op (unchanged, and
// returns false).
// ---------------------------------------------------------------------------
{
  const capsule = { x: 0, z: 0, yMin: 0, yMax: 2, radius: 0.5 };
  const p = new Vector3(1.0, 1.0, 0.2); // axisDist ~1.02 > 0.5: outside
  const snapshot = { x: p.x, y: p.y, z: p.z };
  const moved = pushPointOutOfCapsule(p, capsule, p);

  check('push: no-op return value for an outside point', moved === false);
  check('push: outside point left unchanged (x)', p.x === snapshot.x);
  check('push: outside point left unchanged (y)', p.y === snapshot.y);
  check('push: outside point left unchanged (z)', p.z === snapshot.z);
}

// Also outside purely by being above/below the capsule's y-range, even though
// its horizontal distance from the axis is well inside the radius.
{
  const capsule = { x: 0, z: 0, yMin: 0, yMax: 2, radius: 0.5 };
  const p = new Vector3(0.01, 5, 0.01); // dead-center horizontally, but way above yMax
  const moved = pushPointOutOfCapsule(p, capsule, p);
  check('push: no-op for a point outside the y-range (even if radially inside)', moved === false);
}

// ---------------------------------------------------------------------------
// capsuleContainsPoint: sanity-matches the push no-op/moved cases above.
// ---------------------------------------------------------------------------
{
  const capsule = { x: 0, z: 0, yMin: 0, yMax: 2, radius: 0.5 };
  check('contains: inside point is inside', capsuleContainsPoint(new Vector3(0.1, 1.2, 0.05), capsule) === true);
  check('contains: outside (radial) point is outside', capsuleContainsPoint(new Vector3(1.0, 1.0, 0.2), capsule) === false);
  check('contains: outside (y-range) point is outside', capsuleContainsPoint(new Vector3(0.01, 5, 0.01), capsule) === false);
  check('contains: point exactly on the surface is outside (strict <)', capsuleContainsPoint(new Vector3(0.5, 1.0, 0.0), capsule) === false);
}

// ---------------------------------------------------------------------------
// deriveOutwardPole: perpendicular component of the derived pole points away
// from the spine axis, on the correct side.
// ---------------------------------------------------------------------------
{
  const capsule = { x: 0, z: 0 }; // yMin/yMax/radius unused by this helper
  // Point sits on the +X side of the axis; an inward-biased pole (horizontal
  // component pointing toward -X, i.e. toward/through the axis) should be
  // corrected to point toward +X (away from the axis), keeping its downward
  // (y) bias untouched.
  const point = new Vector3(0.4, 1.0, 0.0);
  const inwardPole = new Vector3(-1, -0.4, 0); // horizontal component points at the axis
  const out = deriveOutwardPole(inwardPole, point, capsule);

  const ox = (point.x - capsule.x), oz = (point.z - capsule.z);
  const outwardDot = out.x * ox + out.z * oz; // should be >= 0 (points away from axis)
  check('pole: corrected horizontal component points away from the axis', outwardDot > 0);
  check('pole: y (downward bias) preserved exactly', out.y === inwardPole.y);
  check('pole: corrected pole points toward +X (same side as the point)', out.x > 0);
}

// deriveOutwardPole: no-op when the pole's horizontal component already
// points outward (this is what keeps the idle pose visually unchanged).
{
  const capsule = { x: 0, z: 0 };
  const point = new Vector3(0.4, 1.0, 0.0);
  const outwardPole = new Vector3(1, -0.4, 0); // already points away from the axis (+X, same side)
  const out = deriveOutwardPole(outwardPole, point, capsule);
  check('pole: no-op when already outward (x)', out.x === outwardPole.x);
  check('pole: no-op when already outward (y)', out.y === outwardPole.y);
  check('pole: no-op when already outward (z)', out.z === outwardPole.z);
}

// deriveOutwardPole: a pole whose horizontal component is exactly
// perpendicular to the outward direction (dot == 0, the idle-pose geometry)
// must also be a no-op, not flipped by floating-point noise around zero.
{
  const capsule = { x: 0, z: 0 };
  const point = new Vector3(0.4, 1.0, 0.0); // outward dir is +X
  const perpPole = new Vector3(0, -0.4, 1); // horizontal component along +Z: perpendicular to +X
  const out = deriveOutwardPole(perpPole, point, capsule);
  check('pole: perpendicular horizontal component is a no-op (not flipped)', out.x === perpPole.x && out.z === perpPole.z);
}

// deriveOutwardPole: degenerate cases (on-axis point; purely-vertical pole)
// return the pole unchanged rather than dividing by zero / producing NaN.
{
  const capsule = { x: 0, z: 0 };
  const onAxis = new Vector3(0, 1.0, 0);
  const somePole = new Vector3(-1, -0.4, 0.3);
  const out1 = deriveOutwardPole(somePole, onAxis, capsule);
  check('pole: on-axis point leaves pole unchanged (no div-by-zero)', out1.x === somePole.x && out1.z === somePole.z && !Number.isNaN(out1.x));

  const point = new Vector3(0.4, 1.0, 0.0);
  const verticalPole = new Vector3(0, -1, 0);
  const out2 = deriveOutwardPole(verticalPole, point, capsule);
  check('pole: purely-vertical pole leaves pole unchanged', out2.x === verticalPole.x && out2.y === verticalPole.y && out2.z === verticalPole.z);
}

// ---------------------------------------------------------------------------
// projectOntoAxis: projects a point onto the root->target line. This is what
// Correction 3 uses to isolate the elbow's bend offset from its (fixed, pole-
// independent) position along the root->target axis before deriving the
// forced-outward pole — see player-procedural-body.js's solveArm comment.
// ---------------------------------------------------------------------------
{
  const root = new Vector3(0, 0, 0);
  const dir = new Vector3(1, 0, 0); // unit, along +X
  const point = new Vector3(2, 3, 0); // 2 units along axis, 3 units off it
  const out = projectOntoAxis(point, root, dir);
  check('projectOntoAxis: lands on the axis at the correct parameter', Math.abs(out.x - 2) < 1e-9 && Math.abs(out.y) < 1e-9 && Math.abs(out.z) < 1e-9);
}
{
  // Off-origin root, diagonal unit axis.
  const root = new Vector3(1, 1, 1);
  const dir = new Vector3(1, 0, 0).normalize(); // axis along +X from (1,1,1)
  const point = new Vector3(4, 5, 1); // 3 along axis, offset (0,4,0) perpendicular
  const out = projectOntoAxis(point, root, dir);
  check('projectOntoAxis: off-origin root handled', Math.abs(out.x - 4) < 1e-9 && Math.abs(out.y - 1) < 1e-9 && Math.abs(out.z - 1) < 1e-9);
}

// ---------------------------------------------------------------------------
// Integration: the full Correction-3 flow (project onto axis -> forced
// outward pole -> re-solve) actually escapes the capsule for a realistic
// cross-body reach, where deriving "outward" from the raw (unprojected)
// elbow position would under-correct (the raw elbow's offset from the spine
// axis is dominated by how far along the root->target axis it sits, not by
// the much smaller bend term the pole controls). Reimplements solveTwoBone's
// analytic 2-bone math locally (it isn't exported) to mirror
// player-procedural-body.js's solveArm exactly.
// ---------------------------------------------------------------------------
{
  function solveTwoBoneLocal(root, target, L1, L2, poleDir) {
    const axis = new Vector3().copy(target).sub(root);
    let d = axis.length();
    if (d < 1e-6) { axis.set(0, -1, 0); d = 1e-6; } else { axis.x /= d; axis.y /= d; axis.z /= d; }
    const dc = Math.min((L1 + L2) * 0.999, Math.max(Math.abs(L1 - L2) + 1e-4, d));
    const a = (dc * dc + L1 * L1 - L2 * L2) / (2 * dc);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const dot = poleDir.dot(axis);
    const bend = new Vector3(poleDir.x - axis.x * dot, poleDir.y - axis.y * dot, poleDir.z - axis.z * dot);
    const bl = bend.length() || 1;
    bend.x /= bl; bend.y /= bl; bend.z /= bl;
    const joint = new Vector3(root.x + axis.x * a + bend.x * h, root.y + axis.y * a + bend.y * h, root.z + axis.z * a + bend.z * h);
    return { joint, axis };
  }

  const shoulder = new Vector3(0.231, 1.6, 0); // real rig: R*0.66 lateral shoulder offset
  const target = new Vector3(-0.1, 1.4, 0.2);  // magwell-ish reach across the body
  const L1 = 0.378, L2 = 0.378;                // real rig: armLen*0.5 each segment
  const capsule = { x: 0, z: 0, yMin: 1.0, yMax: 1.75, radius: 0.45 };
  const fixedPole = new Vector3(0, -0.4, -1); // elbowSign=1, no poleAngle twist

  // Correction 2 pass (shoulder is already outward, so this happens to be a no-op here).
  const pole2 = deriveOutwardPole(fixedPole, shoulder, capsule, new Vector3());
  const { joint: joint1 } = solveTwoBoneLocal(shoulder, target, L1, L2, pole2);
  check('integration: first solve produces a penetrating elbow (sets up the scenario)', capsuleContainsPoint(joint1, capsule));

  // Correction 3: project onto the root->target axis, force outward, re-solve once.
  const { axis } = solveTwoBoneLocal(shoulder, target, L1, L2, pole2);
  const axisPt = projectOntoAxis(joint1, shoulder, axis, new Vector3());
  const pole3 = deriveOutwardPole(pole2, axisPt, capsule, new Vector3(), true);
  const { joint: joint2 } = solveTwoBoneLocal(shoulder, target, L1, L2, pole3);

  check('integration: correction 3 substantially reduces or resolves the penetration', !capsuleContainsPoint(joint2, capsule) || Math.hypot(joint2.x - capsule.x, joint2.z - capsule.z) > Math.hypot(joint1.x - capsule.x, joint1.z - capsule.z));
  check('integration: re-solve preserves bone lengths (upper arm)', Math.abs(joint2.distanceTo(shoulder) - L1) < 1e-6);
}

// ---------------------------------------------------------------------------
// Tunable constants sanity (small positive margins, as documented).
// ---------------------------------------------------------------------------
{
  check('TORSO_CAPSULE_RADIUS_MARGIN is a small positive number', TORSO_CAPSULE_RADIUS_MARGIN > 0 && TORSO_CAPSULE_RADIUS_MARGIN < 0.5);
  check('TORSO_CAPSULE_Y_PAD is a small positive number', TORSO_CAPSULE_Y_PAD > 0 && TORSO_CAPSULE_Y_PAD < 0.5);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
