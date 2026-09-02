// Node checks for the gait detectors. Run with `node test-gait-diagnostics.mjs`.
//
// These are deliberately synthetic. The point of the module is to be pointed at a real walker and say
// whether its feet are misbehaving, and a detector that has only ever seen the real walker cannot be
// distinguished from a detector that returns zero. So the traces here are hand-built with the answer
// known in advance: one clean walk, one that taps, one that drags, and — the check that actually earns
// its keep — a fast clean walk that has every surface symptom of tapping and must not be flagged.

import {
  createGaitMonitor, analyseGait, formatGaitReport, GAIT_LIMITS,
  gaitHeadroom, createLegWatch, diagnoseGait,
} from './gait-diagnostics.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ===================== the trace generator =====================

const DT = 1 / 60;

/**
 * Build a trace of `seconds` from a per-leg square wave.
 *
 * Each leg cycles stance for `stance` seconds then swings for `swing`. During swing the drawn foot moves
 * `stride` forward; during stance it stays where it was put, unless `skate` says otherwise. The body
 * advances at `speed` throughout. Everything a detector reads is set from these four numbers, so a trace
 * can be made to fail exactly one detector on purpose.
 */
function makeTrace({
  seconds = 6, legCount = 4, speed = 0.5, stance = 0.4, swing = 0.2, stride = 0.2,
  strideEnvelope = 0.25, stepDuration = 0.2, legSpan = 0.5,
  skate = 0,           // fraction of body travel a PLANTED foot slides
  clamped = false,     // solver holding the drawn foot short
  gap = 0,
  // The tuning fields `gaitHeadroom` reads. Defaults describe a healthy creature: a guard of 1.2
  // envelopes and a placement margin comfortably under the ask-to-step threshold.
  maxConcurrentFraction = 0.25,
  restepEpsilon = strideEnvelope * 1.2,
  triggerH = strideEnvelope * 0.6,
  reachMargin = 0.7,
  reachStress = 0.9,
  maxSpeed = speed,
} = {}) {
  const frames = [];
  const period = stance + swing;
  const state = Array.from({ length: legCount }, (_, i) => ({
    x: 0, z: i * 0.1, phase: (i / legCount) * period, wasStepping: false,
  }));
  let bodyZ = 0;
  for (let f = 0; f * DT < seconds; f++) {
    const t = f * DT;
    const travel = speed * DT;
    bodyZ += travel;
    const legFrames = state.map((s) => {
      const local = (t + s.phase) % period;
      const stepping = local >= stance;
      let drawnStep = 0;
      if (stepping) {
        drawnStep = stride / (swing / DT);
        s.z += drawnStep;
      } else if (skate > 0) {
        drawnStep = travel * skate;
        s.z += drawnStep;
      }
      return {
        index: s.index, row: 0, side: 1,
        stepping,
        phase: stepping ? (local - stance) / swing : 1,
        wants: !stepping && local > stance * 0.8,
        canMove: true,
        targetGrounded: true,
        uncomfortable: false,
        planted: !stepping,
        endX: s.x, endY: 0, endZ: s.z + gap,
        drawnX: s.x, drawnY: 0, drawnZ: s.z,
        drawnStep,
        gap,
        clamped: clamped && !stepping,
        reach: 0, reachLimit: 1, span: legSpan,
      };
    });
    frames.push({
      t, dt: DT, bodyTravel: travel, speed, commandedSpeed: speed,
      maxSpeed, stepDuration, strideEnvelope, legSpan,
      legCount, maxConcurrentFraction, restepEpsilon, triggerH, reachMargin, reachStress,
      bodyY: 0.3, groundY: 0, legs: legFrames,
    });
  }
  return frames;
}

// ===================== a clean walk trips nothing =====================

check('a clean walk trips neither detector', () => {
  const r = analyseGait(makeTrace());
  assert(!r.verdict.tapping, `clean walk flagged as tapping: ${r.tapping.worstLegRate.toFixed(2)}/s`);
  assert(!r.verdict.dragging, `clean walk flagged as dragging: ${(r.dragging.worstLegFraction * 100).toFixed(1)}%`);
  // `medianTravel` is a fraction of LEG SPAN and `medianTravelEnv` a fraction of the stride envelope.
  // The trace strides 0.2 on a 0.5 span and a 0.25 envelope, so 0.4 and 0.8 respectively.
  assert(r.tapping.medianTravel > 0.3, `strides should be a real fraction of the leg, got ${r.tapping.medianTravel.toFixed(2)}`);
  assert(r.perLeg[0].medianTravelEnv > 0.6, `strides should fill the envelope, got ${r.perLeg[0].medianTravelEnv.toFixed(2)}`);
  assert(r.speedVsMax > 0.9, `this trace walks at its top speed, got ${r.speedVsMax.toFixed(2)}`);
  assert(r.dragging.skateP95 < 0.01, `planted feet should not slide, got ${r.dragging.skateP95.toFixed(3)}`);
  assert(Object.values(r.failures).every(Number.isFinite), 'named failure report contains a non-finite value');
  assert(r.failures.terrainMissFrames === 0 && r.failures.schedulerStarvationFrames === 0,
    'a clean legacy trace acquired a named failure');
});

check('the monitor and the one-shot helper agree', () => {
  const trace = makeTrace();
  const m = createGaitMonitor();
  for (const f of trace) m.sample(f);
  const a = m.report(), b = analyseGait(trace);
  assert(a.frames === b.frames, `frame counts differ: ${a.frames} vs ${b.frames}`);
  assert(Math.abs(a.tapping.rate - b.tapping.rate) < 1e-12, 'tap rates differ');
});

// ===================== tapping =====================

check('a leg that lands and immediately relifts is caught', () => {
  // Stance one tenth of a step, strides a twentieth of the envelope: nowhere, constantly.
  const r = analyseGait(makeTrace({ stance: 0.02, swing: 0.2, stride: 0.01 }));
  assert(r.verdict.tapping, `tapping trace not flagged (rate ${r.tapping.worstLegRate.toFixed(2)}/s)`);
  assert(r.tapping.medianTravel < GAIT_LIMITS.tapTravelFraction,
    `taps should barely move the foot, got ${r.tapping.medianTravel.toFixed(3)}`);
  assert(!r.verdict.dragging, 'a tapping trace should not also read as dragging');
});

check('a FAST but productive walk is not tapping', () => {
  // This is the check that stops the detector being a step-rate counter with extra steps. Stances are
  // short — shorter than the tapping trace's threshold — but every step covers real ground, which is what
  // a gallop looks like. Flagging this would make the detector useless on the gait that needs it most.
  const r = analyseGait(makeTrace({ stance: 0.05, swing: 0.12, stride: 0.22, stepDuration: 0.12 }));
  assert(r.tapping.medianStance < GAIT_LIMITS.tapStanceFraction,
    `this trace is meant to have short stances, got ${r.tapping.medianStance.toFixed(2)}`);
  assert(!r.verdict.tapping,
    `a fast walk with full strides was flagged as tapping (${r.tapping.worstLegRate.toFixed(2)}/s)`);
});

check('a slow shuffle with tiny strides is not tapping either', () => {
  // The mirror of the above: tiny strides, but each foot sits down for a long time between them. That is
  // a creature creeping, not a creature vibrating.
  const r = analyseGait(makeTrace({ stance: 1.2, swing: 0.2, stride: 0.02, speed: 0.02 }));
  assert(r.tapping.medianTravel < GAIT_LIMITS.tapTravelFraction, 'this trace is meant to have tiny strides');
  assert(!r.verdict.tapping, `a slow shuffle was flagged as tapping (${r.tapping.worstLegRate.toFixed(2)}/s)`);
});

// ===================== dragging =====================

check('a planted foot carried along with the body is caught', () => {
  const r = analyseGait(makeTrace({ skate: 0.9 }));
  assert(r.verdict.dragging, `dragging trace not flagged (${(r.dragging.worstLegFraction * 100).toFixed(1)}%)`);
  assert(r.dragging.skateP95 > 0.5, `skate ratio should be near the 0.9 authored, got ${r.dragging.skateP95.toFixed(2)}`);
  assert(!r.verdict.tapping, 'a dragging trace should not also read as tapping');
});

check('skate is measured against body travel, not in metres', () => {
  // Same 90% skate at a tenth of the speed. An absolute threshold would miss this; the whole reason the
  // metric is a ratio is that a slow creature drags just as visibly as a fast one.
  const fast = analyseGait(makeTrace({ skate: 0.9, speed: 0.5 }));
  const slow = analyseGait(makeTrace({ skate: 0.9, speed: 0.05 }));
  assert(slow.verdict.dragging, 'slow dragging missed');
  assert(Math.abs(fast.dragging.skateP95 - slow.dragging.skateP95) < 0.05,
    `same skate at two speeds should score the same: ${fast.dragging.skateP95.toFixed(2)} vs ${slow.dragging.skateP95.toFixed(2)}`);
});

check('numerical noise on a near-stationary creature is not dragging', () => {
  // The floor exists for this: a body that has effectively stopped divides a tiny slide by a tinier
  // travel and produces a huge ratio out of nothing.
  const r = analyseGait(makeTrace({ skate: 0.9, speed: 1e-6, stride: 1e-6, strideEnvelope: 0.25 }));
  assert(!r.verdict.dragging, `noise on a stopped creature read as dragging (${(r.dragging.worstLegFraction * 100).toFixed(1)}%)`);
});

check('a solver clamping a planted foot is dragging on its own', () => {
  // No sliding at all in this trace — but the solver is holding the drawn foot short of where the gait
  // thinks it is for every planted frame. The gait is lying to itself about where its feet are, which is
  // the failure whether or not it has yet produced visible motion.
  const r = analyseGait(makeTrace({ skate: 0, clamped: true, gap: 0.05 }));
  assert(r.dragging.clampedFraction > 0.9, `expected nearly every planted frame clamped, got ${r.dragging.clampedFraction.toFixed(2)}`);
  assert(r.verdict.dragging, 'a permanently clamped foot was not flagged');
});

// ===================== bookkeeping =====================

check('the report survives a leg that never steps', () => {
  const trace = makeTrace({ seconds: 2 });
  for (const f of trace) { f.legs[0].stepping = false; f.legs[0].planted = true; f.legs[0].drawnStep = 0; }
  const r = analyseGait(trace);
  assert(r, 'no report');
  assert(r.perLeg[0].steps === 0, 'leg 0 should have taken no steps');
  assert(Number.isFinite(r.tapping.rate), 'tap rate went non-finite');
  assert(Number.isFinite(r.dragging.skateP95), 'skate went non-finite');
});

check('an empty trace reports nothing rather than throwing', () => {
  assert(analyseGait([]) === null, 'expected null for an empty trace');
  const m = createGaitMonitor();
  m.sample(null);
  m.sample({});
  assert(m.report() === null, 'expected null after junk frames');
});

check('terrain, reach, scheduler and retry causes stay separate', () => {
  const trace = makeTrace({ seconds: 1 });
  const leg = (frame) => frame.legs[0];
  leg(trace[0]).clamped = true;
  leg(trace[0]).terrainMissNow = true;
  leg(trace[0]).failure = 'terrain';
  leg(trace[1]).schedulerWaiting = true;
  leg(trace[2]).schedulerWaiting = true;
  leg(trace[2]).schedulerStarved = true;
  leg(trace[2]).failure = 'scheduler-starvation';
  leg(trace[3]).forcedRestepNow = true;
  leg(trace[4]).retryExhaustedNow = true;
  leg(trace[4]).failure = 'retry-exhausted';

  const r = analyseGait(trace);
  const f = r.failures, p = r.perLeg[0];
  assert(f.terrainMissFrames === 1, `expected one terrain-miss frame, got ${f.terrainMissFrames}`);
  assert(f.reachClampFrames === 1, `expected one reach-clamp frame, got ${f.reachClampFrames}`);
  assert(f.schedulerWaitFrames === 2, `expected two scheduler-wait frames, got ${f.schedulerWaitFrames}`);
  assert(f.schedulerStarvationFrames === 1,
    `expected one scheduler-starvation frame, got ${f.schedulerStarvationFrames}`);
  assert(f.forcedResteps === 1, `expected one forced re-step, got ${f.forcedResteps}`);
  assert(f.exhaustedResteps === 1, `expected one exhausted retry, got ${f.exhaustedResteps}`);
  assert(p.terrainMissFrames === 1 && p.schedulerWaitFrames === 2 && p.exhaustedResteps === 1,
    'per-leg causes disagree with the aggregate');
});

check('knee, retarget and ground measurements remain separate', () => {
  const trace = makeTrace({ seconds: 1, legCount: 2 });
  for (const frame of trace) {
    for (let i = 0; i < frame.legs.length; i++) {
      const leg = frame.legs[i];
      leg.bendSign = i === 0 ? -0.75 : 0.95;
      leg.kneeAngleDelta = i === 0 ? 0.12 : 0.01;
      leg.upperLengthError = i === 0 ? 0.02 : 0.001;
      leg.lowerLengthError = i === 0 ? 0.03 : 0.002;
      leg.jointContinuityRelative = i === 0 ? 0.04 : 0.003;
      leg.renderedGroundError = i === 0 ? -0.05 : 0.01;
      leg.poleSource = i === 0 ? 'fallback' : 'rest-geometry';
      leg.poleConfidence = i === 0 ? 0 : 1;
    }
  }
  const r = analyseGait(trace);
  assert(r.retarget.minBendSign === -0.75, `minimum bend sign was ${r.retarget.minBendSign}`);
  assert(Math.abs(r.retarget.maxKneeJump - 0.12) < 1e-12, 'knee jump was not preserved');
  assert(Math.abs(r.retarget.maxSegmentLengthError - 0.03) < 1e-12,
    'upper and lower segment errors were not combined by their maximum');
  assert(Math.abs(r.retarget.maxJointContinuityError - 0.04) < 1e-12,
    'joint continuity was mixed with segment length');
  assert(Math.abs(r.retarget.maxPlantedGroundError - 0.05) < 1e-12,
    'signed ground error was not aggregated by magnitude');
  assert(r.retarget.lowConfidencePoles === 1,
    `expected one low-confidence pole, got ${r.retarget.lowConfidencePoles}`);
  assert(!('knee' in r.verdict), 'retarget observations became a verdict before thresholds were measured');
});

check('clock loss and support margin aggregate without changing gait verdicts', () => {
  const trace = makeTrace({ seconds: 1 });
  trace.forEach((frame, i) => {
    frame.droppedTimeFrame = i === 0 ? 0.05 : 0;
    frame.maxInputDt = i === 0 ? 0.2 : DT;
    frame.supportMargin = i === 1 ? null : (i === 2 ? -0.02 : 0.1);
    frame.bodyClearance = i === 3 ? 0.08 : 0.2;
    frame.minimumBodyClearance = 0.1;
    frame.belowMinimumClearanceFrames = i >= 3 ? 1 : 0;
  });
  const r = analyseGait(trace);
  assert(Math.abs(r.timing.droppedTime - 0.05) < 1e-12, 'discarded time was not accumulated');
  assert(r.timing.substepCapHits === 1, `expected one cap hit, got ${r.timing.substepCapHits}`);
  assert(Math.abs(r.timing.maxInputDt - 0.2) < 1e-12, 'maximum input dt was lost');
  assert(Math.abs(r.support.minimumMargin + 0.02) < 1e-12, 'negative support margin was lost');
  assert(r.support.degenerateFrames === 1, `expected one degenerate support frame, got ${r.support.degenerateFrames}`);
  assert(Math.abs(r.support.minimumObservedClearance - 0.08) < 1e-12, 'minimum clearance was lost');
  assert(r.support.belowMinimumClearanceFrames === 1, 'below-minimum event was lost');
  assert(!r.verdict.tapping && !r.verdict.dragging, 'timing/support observations changed gait verdicts');
});

check('formatGaitReport produces one readable line', () => {
  const line = formatGaitReport(analyseGait(makeTrace({ skate: 0.9 })), 'test');
  assert(!line.includes('\n'), 'report should be one line');
  assert(line.includes('DRAG'), `expected a DRAG flag in: ${line}`);
});

// ===================== the prediction, as opposed to the measurement =====================
//
// `gaitHeadroom` is arithmetic on the tuning rather than a count of what happened, so its checks are
// about whether the arithmetic is the arithmetic it claims to be. The trace's defaults are chosen so the
// stride budget comes out at exactly the speed the trace walks: 4 legs, one airborne at a time, a 0.2 s
// step, so a cycle is 0.8 s, and 0.8 x 2 x 0.25 m of envelope per cycle is 0.5 m/s.

check('the stride budget is the speed two envelopes per cycle allow', () => {
  const h = gaitHeadroom(makeTrace({ seconds: 0.1 })[0]);
  assert(Math.abs(h.cycleTime - 0.8) < 1e-9, `cycle should take 0.8 s, got ${h.cycleTime}`);
  assert(Math.abs(h.cycleSpeed - 0.5) < 1e-9, `budget should be 0.5 m/s, got ${h.cycleSpeed}`);
  assert(Math.abs(h.speedOverrun - 1) < 1e-9, `a creature at its budget should read 1.00, got ${h.speedOverrun}`);
  assert(h.dragRisk < 0.05, `a creature at its budget should not be flagged, got ${h.dragRisk.toFixed(2)}`);
});

check('a body told to outrun its stride is predicted to drag', () => {
  const h = gaitHeadroom(makeTrace({ seconds: 0.1, maxSpeed: 1.0 })[0]);
  assert(Math.abs(h.speedOverrun - 2) < 1e-9, `expected 2x overrun, got ${h.speedOverrun}`);
  assert(h.dragRisk > 0.95, `doubling the speed should max the risk, got ${h.dragRisk.toFixed(2)}`);
  assert(h.worst.id === 'overrun', `the named cause should be the speed, got ${h.worst.id}`);
});

check('a re-step guard under one envelope is predicted to drag', () => {
  const h = gaitHeadroom(makeTrace({ seconds: 0.1, restepEpsilon: 0.25 * 0.15 })[0]);
  assert(Math.abs(h.restepEnvelopes - 0.15) < 1e-9, `expected 0.15 envelopes, got ${h.restepEnvelopes}`);
  assert(h.worst.id === 'restep', `the named cause should be the guard, got ${h.worst.id}`);
  assert(h.dragRisk > 0.9, `a guard this small should max the risk, got ${h.dragRisk.toFixed(2)}`);
  // ...and the shipped value must not be. This is the regression that catches me re-introducing the
  // fix that made dragging worse: a guard scaled to the creature but left small.
  const ok = gaitHeadroom(makeTrace({ seconds: 0.1 })[0]);
  assert(ok.terms.find(t => t.id === 'restep').risk < 0.05,
    `1.2 envelopes should be clean, got ${ok.terms.find(t => t.id === 'restep').risk.toFixed(2)}`);
});

check('a placement margin above ask-to-step is predicted to drag', () => {
  const h = gaitHeadroom(makeTrace({ seconds: 0.1, reachMargin: 0.92, reachStress: 0.9 })[0]);
  assert(h.marginGap < 0, `expected a negative gap, got ${h.marginGap}`);
  assert(h.worst.id === 'margin', `the named cause should be the margin, got ${h.worst.id}`);
});

check('the hysteresis half of tap risk needs BOTH guards gone, not either', () => {
  const noGuard = gaitHeadroom(makeTrace({ seconds: 0.1, restepEpsilon: 0 })[0]);
  assert(noGuard.hysteresisRisk < 0.05, `removing only the re-step guard should not predict tapping, got ${noGuard.hysteresisRisk.toFixed(2)}`);
  const noTrigger = gaitHeadroom(makeTrace({ seconds: 0.1, triggerH: 0 })[0]);
  assert(noTrigger.hysteresisRisk < 0.05, `removing only the trigger should not predict tapping, got ${noTrigger.hysteresisRisk.toFixed(2)}`);
  const neither = gaitHeadroom(makeTrace({ seconds: 0.1, restepEpsilon: 0, triggerH: 0 })[0]);
  assert(neither.hysteresisRisk > 0.95, `removing both should predict tapping, got ${neither.hysteresisRisk.toFixed(2)}`);
});

check('a step too short to draw reads as tapping on its own', () => {
  // The half of the gauge that actually fires on these models. The default trace steps for 0.2 s at
  // 60 Hz, which is 12 frames and fine; 0.05 s is three, and three frames of an eased arc with a
  // half-sine lift is a spike rather than a swing.
  const fine = gaitHeadroom(makeTrace({ seconds: 0.1 })[0]);
  assert(Math.abs(fine.stepFrames - 12) < 0.01, `expected 12 frames, got ${fine.stepFrames.toFixed(2)}`);
  assert(fine.tapRisk < 0.05, `a 12-frame step should be clean, got ${fine.tapRisk.toFixed(2)}`);
  const snap = gaitHeadroom(makeTrace({ seconds: 0.1, stepDuration: 0.05 })[0]);
  assert(Math.abs(snap.stepFrames - 3) < 0.01, `expected 3 frames, got ${snap.stepFrames.toFixed(2)}`);
  assert(snap.tapRisk > 0.95, `a 3-frame step should max the gauge, got ${snap.tapRisk.toFixed(2)}`);
  // ...and it must not be reached through the hysteresis half, which is a different repair.
  assert(snap.hysteresisRisk < 0.05, 'a short step should not be blamed on the guards');
  assert(snap.worstTap.id === 'snap', `the named cause should be the frame count, got ${snap.worstTap.id}`);
  const advice = diagnoseGait({ headroom: snap });
  assert(advice.some(a => a.knob === 'minStepSeconds' && a.dir === 1), 'no advice to lengthen the step');
});

check('a leg cycling faster than its own pendulum is flagged', () => {
  // Stride frequency x sqrt(span/g). The trace has 4 legs, one airborne at a time and a 0.2 s step, so
  // the cycle is 0.8 s and the frequency 1.25 Hz; on a 0.5 m span that is 1.25 x 0.226 = 0.28, inside
  // what a real animal does. Quartering the step duration quadruples it.
  const ok = gaitHeadroom(makeTrace({ seconds: 0.1 })[0]);
  assert(Math.abs(ok.strideNumber - 0.28) < 0.01, `expected 0.28, got ${ok.strideNumber.toFixed(3)}`);
  const fast = gaitHeadroom(makeTrace({ seconds: 0.1, stepDuration: 0.05, legSpan: 0.5 })[0]);
  assert(fast.strideNumber > 1.0, `expected a high stride number, got ${fast.strideNumber.toFixed(2)}`);
  assert(diagnoseGait({ headroom: fast }).some(a => a.id === 'cycleRate'), 'no advice about the cycle rate');
});

check('headroom survives a frame with nothing in it', () => {
  assert(gaitHeadroom(null) === null, 'expected null for no frame');
  const h = gaitHeadroom({ legs: [] });
  assert(h && Number.isFinite(h.dragRisk), 'an empty frame should still produce finite numbers');
});

// ===================== the per-leg watch =====================

check('the watch blames the one leg that is actually sliding', () => {
  // Only leg 2 skates. The whole-creature report averages that away; a marker under one foot must not.
  const trace = makeTrace({ seconds: 4, skate: 0 });
  for (const f of trace) {
    const l = f.legs[2];
    if (!l.stepping) { l.drawnStep = f.bodyTravel * 0.9; }
  }
  const w = createLegWatch();
  for (const f of trace) w.sample(f);
  const legs = w.legs;
  assert(legs[2].drag > 1, `the sliding leg should be flagged, got ${legs[2].drag.toFixed(2)}`);
  for (const i of [0, 1, 3]) {
    assert(legs[i].drag < 0.2, `leg ${i} is clean and should not be flagged, got ${legs[i].drag.toFixed(2)}`);
  }
});

check('a swinging foot is not accused of sliding', () => {
  // Every leg moves a long way during its swing. Feeding swing frames into the average would flag all
  // four of them, which is the bug this check exists to prevent.
  const w = createLegWatch();
  for (const f of makeTrace({ seconds: 4, stride: 0.24 })) w.sample(f);
  for (const l of w.legs) assert(l.drag < 0.2, `a clean walk flagged leg ${l.index}: ${l.drag.toFixed(2)}`);
});

check('the watch pulses on a step that went nowhere, then forgets it', () => {
  const trace = makeTrace({ seconds: 3, stride: 0.004, stance: 0.05, swing: 0.05, stepDuration: 0.4 });
  const w = createLegWatch();
  let peak = 0;
  for (const f of trace) { w.sample(f); peak = Math.max(peak, ...w.legs.map(l => l.tap)); }
  assert(peak > 0.9, `expected a tap pulse, got ${peak.toFixed(2)}`);
  // Now walk it properly and confirm the pulse decays rather than latching on forever.
  for (const f of makeTrace({ seconds: 6 })) w.sample(f);
  assert(Math.max(...w.legs.map(l => l.tap)) < 0.1, 'the tap pulse latched instead of decaying');
});

check('a clamped foot is flagged even when it is not sliding', () => {
  const w = createLegWatch();
  for (const f of makeTrace({ seconds: 3, skate: 0, clamped: true, gap: 0.05 })) w.sample(f);
  assert(w.legs.every(l => l.drag > 1), 'a permanently clamped foot should be flagged on every leg');
  assert(w.legs.every(l => l.gapSpan > 0.09), 'the drawn-to-target gap should be reported per leg');
});

// ===================== the advice =====================

check('advice names one knob and a direction, worst first', () => {
  const frame = makeTrace({ seconds: 0.1, maxSpeed: 1.0, restepEpsilon: 0.25 * 0.6 })[0];
  const advice = diagnoseGait({ headroom: gaitHeadroom(frame) });
  assert(advice.length >= 2, `expected both problems, got ${advice.length}`);
  assert(advice[0].id === 'overrun', `the 2x overspeed should rank first, got ${advice[0].id}`);
  for (const a of advice) {
    assert(typeof a.knob === 'string' && a.knob, `advice ${a.id} names no knob`);
    assert(a.dir === 1 || a.dir === -1, `advice ${a.id} has no direction`);
    assert(a.why && a.evidence, `advice ${a.id} is missing its reasoning`);
  }
  for (let i = 1; i < advice.length; i++) {
    assert(advice[i - 1].severity >= advice[i].severity, 'advice came back out of order');
  }
});

check('advice needs no measurement to fire', () => {
  // The point of the headroom rules: a slider being dragged right now cannot wait four seconds for a
  // window to fill, so the prediction has to stand on its own.
  const advice = diagnoseGait({ headroom: gaitHeadroom(makeTrace({ seconds: 0.1, maxSpeed: 1.5 })[0]) });
  assert(advice.length === 1 && advice[0].knob === 'speedScale', `expected speed advice alone, got ${JSON.stringify(advice.map(a => a.knob))}`);
  assert(diagnoseGait({}).length === 0, 'no inputs should produce no advice');
});

check('advice never tells you to raise and lower the same knob at once', () => {
  // `restepFraction` has a rule in each direction — too small drags, too large starves. A creature that
  // somehow tripped both would get contradictory instructions, so the rules are written to exclude each
  // other and this is the check that keeps them that way.
  const cases = [0.05, 0.3, 0.9, 1.2, 2.0, 3.0].map(r => makeTrace({ seconds: 0.1, restepEpsilon: 0.25 * r })[0]);
  const report = analyseGait(makeTrace({ seconds: 4, skate: 0.9 }));
  report.dragging.blockedFraction = 0.95;   // force the starvation rule to want to fire
  for (const frame of cases) {
    const advice = diagnoseGait({ report, headroom: gaitHeadroom(frame) });
    const dirs = new Set(advice.filter(a => a.knob === 'restepFraction').map(a => a.dir));
    assert(dirs.size <= 1, `contradictory advice on restepFraction at ${gaitHeadroom(frame).restepEnvelopes.toFixed(2)} envelopes`);
  }
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
