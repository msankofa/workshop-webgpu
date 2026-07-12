// test-weapon-sequence.mjs
// Plain-node test for weapon-sequence.js's evaluateSequence/resolveTargetRef. No framework,
// no THREE. Run: node test-weapon-sequence.mjs
import { evaluateSequence, resolveTargetRef, reloadPoseDelta } from './weapon-sequence.js';
import anchorData from './weapon-anchors.json' with { type: 'json' };
import poseData from './weapon-poses.json' with { type: 'json' };

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('FAIL: ' + msg);
  }
}

function approxEqual(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
function approxEqualVec(a, b, eps = 1e-6) {
  return a.length === b.length && a.every((v, i) => approxEqual(v, b[i], eps));
}

const m1911Anchors = anchorData.m1911.ikAnchors;
const reloadSeq = poseData.reloadSequence.m1911;

// ---------------------------------------------------------------------------
// Pose interpolation between keys
// ---------------------------------------------------------------------------
{
  const aimed = reloadSeq.poses.aimed;
  const reloadRaise = reloadSeq.poses.reloadRaise;

  const atStart = evaluateSequence(reloadSeq, 0);
  assert(approxEqualVec(atStart.weaponPose.p, aimed.p), 'pose at t=0 equals aimed.p');
  assert(approxEqual(atStart.weaponPose.scale, aimed.scale), 'pose at t=0 equals aimed.scale');

  const atKey1 = evaluateSequence(reloadSeq, 0.18);
  assert(approxEqualVec(atKey1.weaponPose.p, reloadRaise.p), 'pose at t=0.18 equals reloadRaise.p');

  // Midpoint between the aimed key (t=0) and the reloadRaise key (t=0.18) should be a 50/50 lerp.
  const mid = evaluateSequence(reloadSeq, 0.09);
  const expectedMidP = aimed.p.map((v, i) => (v + reloadRaise.p[i]) / 2);
  assert(approxEqualVec(mid.weaponPose.p, expectedMidP, 1e-4), 'pose at midpoint is a 50/50 lerp of aimed/reloadRaise');
  const expectedMidScale = (aimed.scale + reloadRaise.scale) / 2;
  assert(approxEqual(mid.weaponPose.scale, expectedMidScale, 1e-4), 'scale at midpoint lerps correctly');

  // After the last weaponPose-bearing key (t=1.38, 'aimed'), pose should hold at 'aimed' through duration.
  const atEnd = evaluateSequence(reloadSeq, reloadSeq.duration);
  assert(approxEqualVec(atEnd.weaponPose.p, aimed.p), 'pose holds at final key value through end of sequence');
}

// ---------------------------------------------------------------------------
// Hand target carry-forward (not interpolated)
// ---------------------------------------------------------------------------
{
  const beforeFirstLeftChange = evaluateSequence(reloadSeq, 0.10);
  assert(beforeFirstLeftChange.left === 'leftGrip', 'left hand holds leftGrip before the t=0.18 key');

  const afterMagwellKey = evaluateSequence(reloadSeq, 0.20);
  assert(afterMagwellKey.left === 'magwell', 'left hand switches to magwell at/after t=0.18');

  const afterToss = evaluateSequence(reloadSeq, 0.5);
  assert(typeof afterToss.left === 'object' && afterToss.left.body, 'left hand carries the toss body-space ref after t=0.48');

  const rightHandAlwaysGrip = evaluateSequence(reloadSeq, 1.0);
  assert(rightHandAlwaysGrip.right === 'rightGrip', 'right hand stays on rightGrip (no key changes it before t=1.0)');
}

// ---------------------------------------------------------------------------
// Events fire once when crossing their t
// ---------------------------------------------------------------------------
{
  // Stepping from just before to just after the detachMagazine key (t=0.35) should fire it once.
  const step = evaluateSequence(reloadSeq, 0.36, 0.30);
  const names = step.events.map(e => e.event);
  assert(names.includes('detachMagazine'), 'crossing t=0.35 fires detachMagazine');
  assert(names.length === 1, 'exactly one event fires for a single-key crossing');

  // Re-evaluating the same small step again (simulating the next frame, prevT==t of previous
  // frame) should NOT refire the same event.
  const stepAgain = evaluateSequence(reloadSeq, 0.40, 0.36);
  assert(!stepAgain.events.some(e => e.event === 'detachMagazine'), 'event does not refire once already crossed');

  // A big jump crossing multiple event keys fires all of them, in order.
  const bigJump = evaluateSequence(reloadSeq, 1.0, 0.30);
  const bigNames = bigJump.events.map(e => e.event);
  assert(bigNames.includes('detachMagazine'), 'big jump includes detachMagazine');
  assert(bigNames.includes('tossMagazine'), 'big jump includes tossMagazine');
  assert(bigNames.includes('spawnFreshMagazine'), 'big jump includes spawnFreshMagazine');
  assert(bigNames.includes('insertMagazine'), 'big jump includes insertMagazine');
  const times = bigJump.events.map(e => e.t);
  const sorted = [...times].sort((a, b) => a - b);
  assert(JSON.stringify(times) === JSON.stringify(sorted), 'events are returned in ascending time order');

  // No prevT supplied => no events (no crossing reference).
  const noPrev = evaluateSequence(reloadSeq, 0.5);
  assert(noPrev.events.length === 0, 'omitting prevT yields no events');

  // Scrubbing backward fires nothing.
  const backward = evaluateSequence(reloadSeq, 0.2, 0.5);
  assert(backward.events.length === 0, 'scrubbing backward fires no events');
}

// ---------------------------------------------------------------------------
// Out-of-range t clamps
// ---------------------------------------------------------------------------
{
  const negative = evaluateSequence(reloadSeq, -5);
  const atZero = evaluateSequence(reloadSeq, 0);
  assert(negative.t === 0, 't=-5 clamps to 0');
  assert(approxEqualVec(negative.weaponPose.p, atZero.weaponPose.p), 'negative t pose matches t=0 pose');

  const beyond = evaluateSequence(reloadSeq, 999);
  const atDuration = evaluateSequence(reloadSeq, reloadSeq.duration);
  assert(beyond.t === reloadSeq.duration, 't beyond duration clamps to duration');
  assert(approxEqualVec(beyond.weaponPose.p, atDuration.weaponPose.p), 'beyond-duration pose matches pose at duration');
}

// ---------------------------------------------------------------------------
// reloadPoseDelta (first-person viewmodel: reload pose as a delta from the sequence's OWN start)
// ---------------------------------------------------------------------------
{
  const m24Seq = poseData.reloadSequence.m24;

  // Zero at both ends for every sequence — start key and closing key both return to the start pose.
  for (const [name, seq] of [['m1911', reloadSeq], ['m24', m24Seq]]) {
    const atStart = reloadPoseDelta(seq, 0);
    assert(approxEqualVec(atStart.dp, [0, 0, 0], 1e-4), `reloadPoseDelta[${name}] at t=0 has ~zero position delta`);
    assert(approxEqualVec(atStart.dr, [0, 0, 0], 1e-4), `reloadPoseDelta[${name}] at t=0 has ~zero rotation delta`);
    const atEnd = reloadPoseDelta(seq, seq.duration);
    assert(approxEqualVec(atEnd.dp, [0, 0, 0], 1e-4), `reloadPoseDelta[${name}] at duration has ~zero position delta`);
    assert(approxEqualVec(atEnd.dr, [0, 0, 0], 1e-4), `reloadPoseDelta[${name}] at duration has ~zero rotation delta`);
  }

  // At the reloadRaise key (t=0.18) the delta should equal reloadRaise - start pose, non-zero.
  const startPose = reloadSeq.poses.aimed; // the t=0 key resolves to this
  const reloadRaise = reloadSeq.poses.reloadRaise;
  const atRaise = reloadPoseDelta(reloadSeq, 0.18);
  const expectedRaiseDp = reloadRaise.p.map((v, i) => v - startPose.p[i]);
  assert(approxEqualVec(atRaise.dp, expectedRaiseDp, 1e-4), 'reloadPoseDelta at reloadRaise key equals reloadRaise.p - startPose.p');
  assert(Math.hypot(...atRaise.dp) > 0.05, 'reloadPoseDelta has a non-trivial peak in the middle of the sequence');

  // Anchoring is to the sequence's own start, not to any external `aimed` — a sequence that starts
  // from a non-aimed pose is still flush (zero) at t=0.
  const offStartSeq = {
    duration: 1.0,
    poses: { lowReady: { p: [1, 2, 3], r: [0.1, 0.2, 0.3], scale: 1 } },
    keys: [{ t: 0, weaponPose: 'lowReady', right: 'rightGrip', left: 'leftGrip' }],
  };
  const offStart = reloadPoseDelta(offStartSeq, 0);
  assert(approxEqualVec(offStart.dp, [0, 0, 0], 1e-4), 'reloadPoseDelta anchors to sequence start (zero at t=0) even when start != aimed');

  // Missing sequence => zero deltas, not a throw.
  const missingSeq = reloadPoseDelta(null, 0.5);
  assert(approxEqualVec(missingSeq.dp, [0, 0, 0]), 'reloadPoseDelta with no sequence returns zero position delta');
  assert(approxEqualVec(missingSeq.dr, [0, 0, 0]), 'reloadPoseDelta with no sequence returns zero rotation delta');
}

// ---------------------------------------------------------------------------
// resolveTargetRef classifies all six forms
// ---------------------------------------------------------------------------
{
  // 1. weapon-anchor string, no root => local weapon space.
  const rGrip = resolveTargetRef('rightGrip', { anchors: m1911Anchors });
  assert(rGrip.space === 'weapon', 'weapon-anchor string classifies as space "weapon" with no root');
  assert(approxEqualVec(rGrip.position, m1911Anchors.rightGrip.p), 'weapon-anchor string resolves to anchor position');

  // 1b. weapon-anchor string, with weaponRoot => composed into world space.
  const weaponRoot = { position: [1, 2, 3], quaternion: [0, 0, 0, 1] };
  const rGripWorld = resolveTargetRef('rightGrip', { anchors: m1911Anchors, weaponRoot });
  assert(rGripWorld.space === 'world', 'weapon-anchor string with weaponRoot resolves to world space');
  const expectedWorldPos = m1911Anchors.rightGrip.p.map((v, i) => v + weaponRoot.position[i]);
  assert(approxEqualVec(rGripWorld.position, expectedWorldPos), 'weapon-anchor world position = anchor + root translation (identity rotation)');

  // 2. body-anchor string (not present in anchors) => body space.
  const belt = resolveTargetRef('beltMagazine', { anchors: m1911Anchors });
  assert(belt.space === 'body', 'string not found in anchors classifies as space "body"');
  assert(belt.anchorName === 'beltMagazine', 'unresolved body-anchor ref keeps its name for later lookup');

  // 3. { weaponAnchor, offset }
  const withOffset = resolveTargetRef({ weaponAnchor: 'chargingHandle', offset: [0, 0, -0.12] }, { anchors: m1911Anchors });
  assert(withOffset.space === 'weapon', '{weaponAnchor,offset} classifies as space "weapon"');
  const expectedOffsetPos = m1911Anchors.chargingHandle.p.map((v, i) => v + [0, 0, -0.12][i]);
  assert(approxEqualVec(withOffset.position, expectedOffsetPos), '{weaponAnchor,offset} position = anchor.p + offset');

  // 4. { body: [x,y,z] }
  const bodyLocal = resolveTargetRef({ body: [-0.35, -0.35, -0.35] }, {});
  assert(bodyLocal.space === 'body', '{body:[...]} classifies as space "body"');
  assert(approxEqualVec(bodyLocal.position, [-0.35, -0.35, -0.35]), '{body:[...]} keeps the given local position');

  // 5. { camera: [x,y,z] }
  const cameraLocal = resolveTargetRef({ camera: [0.1, -0.2, -0.3] }, {});
  assert(cameraLocal.space === 'camera', '{camera:[...]} classifies as space "camera"');
  assert(approxEqualVec(cameraLocal.position, [0.1, -0.2, -0.3]), '{camera:[...]} keeps the given local position');

  // 6. { world: [x,y,z] }
  const worldAbs = resolveTargetRef({ world: [5, 6, 7] }, {});
  assert(worldAbs.space === 'world', '{world:[...]} always classifies as space "world"');
  assert(approxEqualVec(worldAbs.position, [5, 6, 7]), '{world:[...]} passes through unchanged');
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('FAIL');
  process.exit(1);
} else {
  console.log('PASS');
}
