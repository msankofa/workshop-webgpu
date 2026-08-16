// Gait diagnostics: name the two ways a procedural walk goes wrong, and measure them.
//
// TAPPING is a leg that steps without getting anywhere — it lands, immediately decides it wants to move
// again, and lifts. DRAGGING is a planted foot whose RENDERED position slides along the ground while the
// gait believes it is standing still. Neither is a solver failure. The IK is doing exactly what it was
// asked; the asking is wrong. So both are measured from the scheduler's own observables plus the one
// number the solver gives back, and neither detector knows what an IK chain is.
//
// WHY THIS IS A SEPARATE MODULE. It takes plain numbers, holds no THREE types and touches no DOM, so the
// detectors can run against hand-written traces whose answers are known in advance. That matters more than
// it sounds: a detector validated only against the live sim will happily report zero forever, and a sweep
// built on it measures nothing while looking like it measured everything. `test-gait-diagnostics.mjs`
// feeds it three synthetic traces — clean, tapping, dragging — before any real creature is involved.
//
// EVERYTHING IS NORMALISED, because these run across creatures three times different in size. A stride is
// measured against the stride envelope the rig can actually cover, a stance against the step duration, a
// skate against how far the body itself moved. Absolute millimetres would make every threshold a per-
// species constant.

/**
 * Detector thresholds. Exported so tests and the sweep can state which line they are standing on, and so
 * a caller that disagrees can say so rather than forking the module.
 *
 * The two tapping rules are deliberately an AND. Short stance alone is a fast gait, which is legitimate —
 * a gallop has short stances everywhere. A short stride alone is a creature stepping in place while it
 * turns, also legitimate. A step that is both is a leg cycling with nothing to show for it.
 */
export const GAIT_LIMITS = {
  // A stance shorter than this fraction of one step duration is suspiciously brief.
  tapStanceFraction: 0.5,
  // A step that carries the foot less than this fraction of the LEG'S OWN SPAN went nowhere.
  //
  // Against leg span rather than the stride envelope, and that is not cosmetic. `strideEnvelope` is a
  // single number per creature, taken as the minimum over its legs, so on a rig whose legs differ it is
  // the tightest leg's envelope — and every other leg's stride then reads as several hundred percent of
  // it. Measured on the shipped models, envelope-normalised strides ran from 116% to 616%, which put
  // every real step so far above the threshold that the detector could never fire. Span-normalised, the
  // same strides run 0.19 to 0.92, and the threshold means something.
  tapTravelFraction: 0.05,
  // Above this many taps per leg per second, call it tapping.
  tapRateLimit: 0.75,
  // A planted foot that slides more than this fraction of the body's own travel is being carried.
  skateRatioLimit: 0.25,
  // The noise floor goes on the DENOMINATOR, not on the slide. Putting it on the slide — "ignore slides
  // under a millimetre" — silently makes the whole metric speed-dependent, so a creature dragging its
  // feet at a tenth of walking pace reads as clean. A frame in which the body moved less than this
  // fraction of a stride envelope contributes nothing either way, which rejects the case the floor is
  // actually for: a stopped creature dividing numerical jitter by numerical jitter.
  travelFloorFraction: 1e-3,
  // A whole stance is only scored once the body moved this much of an envelope during it.
  stanceTravelFloor: 0.05,
  // Above this fraction of planted frames skating, call it dragging.
  dragFrameLimit: 0.10,
  // ...or above this much of the body's travel come along for the ride over an average stance.
  stanceSkateLimit: 0.20,
  // A leg asking for more reach than the two bones can span, for this fraction of its planted frames,
  // is being dragged by definition — the solver is holding the drawn foot short of the gait's foot.
  clampedFrameLimit: 0.05,
  // How far the drawn foot may sit from the gait's foot, as a fraction of leg span, before that frame
  // counts as a stray. Matches the tolerance `test-stadium-rig.mjs` asserts on.
  strayFraction: 0.05,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Predict both failures from the TUNING, without waiting to observe them.
 *
 * `createGaitMonitor` is a measurement: it needs seconds of walking before it can say anything, which is
 * too slow to hold a slider against. This is arithmetic on the numbers the walker already derived, so it
 * answers the instant a knob moves — at the cost of being a prediction rather than a fact. The two are
 * meant to be read side by side: the prediction says what the settings make likely, the monitor says what
 * actually happened, and the interesting case is when they disagree.
 *
 * THE STRIDE BUDGET is the load-bearing idea. A leg covers at most two stride envelopes of ground per
 * cycle, and a cycle lasts as long as it takes every leg to get its turn. That fixes a hard ceiling on
 * body speed which has nothing to do with how fast the gait would LIKE to go:
 *
 *     cycleSpeed = 0.8 x 2 x strideEnvelope x concurrent / (stepDuration x legCount)
 *
 * `deriveTuning` already clamps `maxSpeed` to exactly this — and then multiplies by `speedScale`, which
 * is the knob that breaks the relationship on purpose. So `speedOverrun` above 1 means the body has been
 * told to travel further per cycle than its feet can be picked up and put down, and the surplus can only
 * come out of the planted feet. That is dragging by arithmetic, before any solver is involved.
 *
 * The other two terms are the defects the sweep turned up, expressed as the quantity that was wrong:
 * a re-step guard smaller than one envelope, and a placement margin above the ask-to-step threshold.
 *
 * Takes a `diagnosticFrame()`. Returns risks in 0..1, plus every term so a UI can show its working —
 * a bare risk number is not actionable, and this whole module exists to be actionable.
 */
export function gaitHeadroom(frame) {
  if (!frame) return null;
  const env = frame.strideEnvelope || 0;
  const legCount = frame.legCount || (frame.legs ? frame.legs.length : 1);
  const concurrent = Math.max(1, Math.floor(legCount * (frame.maxConcurrentFraction ?? 1)));
  const cycleTime = (frame.stepDuration || 0) * legCount / concurrent;
  const cycleSpeed = cycleTime > 1e-9 ? 0.8 * 2 * env * (1 / cycleTime) : 0;
  const speedOverrun = cycleSpeed > 1e-9 ? (frame.maxSpeed || 0) / cycleSpeed : 0;
  const restepEnvelopes = env > 1e-9 ? (frame.restepEpsilon || 0) / env : 0;
  const triggerEnvelopes = env > 1e-9 ? (frame.triggerH || 0) / env : 0;
  const marginGap = (frame.reachStress ?? 0) - (frame.reachMargin ?? 0);

  // Each term is a SUFFICIENT cause on its own, so the risk is the worst of them rather than a sum.
  // Summing would let three mild problems outrank one fatal one, and the advice that follows has to point
  // at a single knob.
  const terms = [
    {
      id: 'overrun', risk: clamp01((speedOverrun - 1) / 0.5), value: speedOverrun,
      text: 'top speed vs what the stride can cycle',
      why: 'Above 1 the body is told to cover more ground per cycle than the feet can. The surplus comes out of the planted feet.',
    },
    {
      id: 'restep', risk: clamp01((1 - restepEnvelopes) / 0.7), value: restepEnvelopes,
      text: 're-step guard, in stride envelopes',
      why: 'Under one envelope the foot is re-placed before the body has walked it back through the envelope, so it lives at the front edge where the leg is longest, and drags there.',
    },
    {
      id: 'margin', risk: clamp01(-marginGap / 0.1), value: marginGap,
      text: 'ask-to-step minus placement margin',
      why: 'At or below zero every fresh foothold is born already past the reach that flags the leg as overextended.',
    },
  ];
  const dragRisk = Math.max(...terms.map(t => t.risk));

  // TWO DIFFERENT THINGS BOTH READ AS TAPPING, and only one of them is a scheduling failure.
  //
  // The first is a leg genuinely cycling without getting anywhere, and it needs BOTH sources of
  // hysteresis gone — hence the AND, matching the detector. It stays near zero in ordinary use, which is
  // the honest answer: `advanceLeg` copies the step target into the foot on landing and the trigger
  // measures distance TO the target, so a freshly landed foot is at zero error by construction.
  //
  // The second is a step too SHORT TO DRAW. `advanceLeg` lerps the foot along its arc and adds a
  // half-sine lift, so a step lasting three frames is two interior samples and the foot trail comes out
  // as a triangular spike rather than an arc. Nothing about the schedule is wrong; the motion is simply
  // over before it can be seen, and a limb that crosses its stride in 50 ms reads as teleporting whatever
  // its size. This is the one that actually fires on these models, and it is why the gauge is a MAX over
  // the two rather than a single number: they need different repairs.
  // A nominal 60 Hz when the frame carries no dt of its own. A walker that has been retuned but not yet
  // stepped has none, and treating that as "zero frames per step" made a freshly built creature report
  // maximum tap risk — which matters because the tune search evaluates exactly that state, hundreds of
  // times, before anything has moved.
  const dt = frame.dt > 0 ? frame.dt : 1 / 60;
  const stepFrames = (frame.stepDuration || 0) / dt;
  const legSpanLongest = frame.legSpanLongest || frame.legSpan || 0.1;
  const pendulum = Math.sqrt(Math.max(1e-9, legSpanLongest / 9.81));
  const strideNumber = (frame.stepDuration || 0) > 1e-9
    ? (concurrent / ((frame.stepDuration) * legCount)) * pendulum : 0;
  const tapTerms = [
    { id: 'snap', risk: clamp01((8 - stepFrames) / 5), value: stepFrames,
      text: 'frames a step is drawn in' },
    { id: 'cycleRate', risk: clamp01((strideNumber - 0.5) / 0.4), value: strideNumber,
      text: 'stride frequency x sqrt(span/g)' },
    { id: 'noGuard', risk: clamp01((0.15 - restepEnvelopes) / 0.15), value: restepEnvelopes,
      text: 're-step guard, in stride envelopes' },
    { id: 'noTrigger', risk: clamp01((0.12 - triggerEnvelopes) / 0.12), value: triggerEnvelopes,
      text: 'step trigger, in stride envelopes' },
  ];
  const hysteresisRisk = Math.min(tapTerms[2].risk, tapTerms[3].risk);
  const tapRisk = Math.max(tapTerms[0].risk, tapTerms[1].risk, hysteresisRisk);

  return {
    cycleTime, cycleSpeed, speedOverrun, restepEnvelopes, triggerEnvelopes, marginGap,
    strideEnvelope: env, legCount, concurrent, stepFrames, strideNumber, legSpanLongest,
    dragRisk, tapRisk, hysteresisRisk, terms, tapTerms,
    worst: terms.reduce((a, b) => (b.risk > a.risk ? b : a), terms[0]),
    worstTap: [tapTerms[0], tapTerms[1]].reduce((a, b) => (b.risk > a.risk ? b : a), tapTerms[0]),
  };
}

/**
 * Per-leg fault scores, updated every frame, for drawing on the creature itself.
 *
 * Separate from `createGaitMonitor` because they answer different questions on different clocks. The
 * monitor scores a WINDOW and reports per creature — right for a verdict, useless for a marker that has to
 * sit under one foot and change colour as that foot fails. This is exponentially smoothed per leg with a
 * short time constant, so it responds within a step or two while still surviving single-frame noise.
 *
 * Smoothing runs on PLANTED frames only. A swinging foot is supposed to be moving, so feeding swing frames
 * into a skate average would wash out exactly the signal being looked for.
 */
export function createLegWatch(limits = {}, { tau = 0.4, fracTau = 1.5, tapDecay = 1.2 } = {}) {
  const L = { ...GAIT_LIMITS, ...limits };
  let legs = null;

  function sample(frame) {
    if (!frame || !frame.legs) return legs;
    if (!legs || legs.length !== frame.legs.length) {
      legs = frame.legs.map((f) => ({
        index: f.index, row: f.row, side: f.side,
        skate: 0, skateFrames: 0, slideNow: 0, clamped: 0, blocked: 0, drag: 0, tap: 0,
        gapSpan: 0, reachFraction: 0, stepping: false, planted: false,
        lastTravel: 0, lastStance: 0, wasStepping: false, startX: 0, startZ: 0, stanceTime: 0,
        pendingStance: 0, steps: 0, taps: 0,
      }));
    }
    const dt = frame.dt || 0;
    // Time-based so the scores mean the same thing at 30 fps and at 144.
    const a = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
    // Slower, and it has to be: the frame fractions average a 0-or-1 sequence, and at 0.4 s a leg sliding
    // on a tenth of its frames produces an average that swings between 0 and 0.5 several times a second.
    // The marker driven from it would strobe, which reads as noise rather than as a fault.
    const aF = dt > 0 ? 1 - Math.exp(-dt / fracTau) : 0;
    const decay = dt > 0 ? Math.exp(-dt / tapDecay) : 1;
    const env = frame.strideEnvelope || 0;
    const bodyMoved = (frame.bodyTravel || 0) > env * L.travelFloorFraction;
    const stepDuration = frame.stepDuration || 0;

    for (let i = 0; i < frame.legs.length; i++) {
      const f = frame.legs[i], s = legs[i];
      const span = f.span || frame.legSpan || 1;

      if (f.stepping && !s.wasStepping) {
        s.startX = f.drawnX; s.startZ = f.drawnZ;
        s.pendingStance = s.stanceTime; s.stanceTime = 0;
      } else if (!f.stepping && s.wasStepping) {
        const travel = Math.hypot(f.drawnX - s.startX, f.drawnZ - s.startZ);
        s.lastTravel = travel / span;
        s.lastStance = stepDuration > 0 ? s.pendingStance / stepDuration : 0;
        s.steps++;
        if (s.lastStance < L.tapStanceFraction && s.lastTravel < L.tapTravelFraction) { s.taps++; s.tap = 1; }
      }
      if (!f.stepping) s.stanceTime += dt;

      s.tap *= decay;
      s.stepping = f.stepping;
      s.planted = f.planted;
      s.gapSpan = span > 0 ? f.gap / span : 0;
      s.reachFraction = f.reachLimit > 0 ? f.reach / (f.span || f.reachLimit) : 0;
      s.blocked += (((f.wants && !f.canMove && !f.stepping) ? 1 : 0) - s.blocked) * a;

      if (f.planted) {
        // Capped, because this is a ratio whose denominator is allowed to be tiny. On a creature that has
        // collapsed, a foot teleports while the body has crawled a hair over the noise floor and the frame
        // scores in the millions; an exponential average absorbs one of those and never recovers, so the
        // per-leg readout printed 837176737%. Everything past "carried several times the body's own
        // travel" is the same fact anyway.
        const ratio = bodyMoved ? Math.min(4, (f.drawnStep || 0) / frame.bodyTravel) : 0;
        // Unsmoothed, for anything that wants this frame's truth rather than the trend — a skid mark is
        // laid down at the moment of the slide and cannot wait for an average to catch up.
        s.slideNow = ratio;
        s.skate += (ratio - s.skate) * a;
        // The two are NOT the same question, and only the second one is what the verdict asks. `skate` is
        // how far a planted foot slides on an average frame, which reads well as a number. `skateFrames`
        // is how OFTEN it slides past the limit, which is what `dragging.worstLegFraction` counts. Scoring
        // the marker off the average made a leg amber at 12% mean slide on a creature the report called
        // clean, so the colour and the word disagreed on the same walk.
        s.skateFrames += ((ratio > L.skateRatioLimit ? 1 : 0) - s.skateFrames) * aF;
        s.clamped += ((f.clamped ? 1 : 0) - s.clamped) * aF;
      } else {
        s.slideNow = 0;
      }
      // Normalised against the same thresholds the verdict uses, so 1.0 on a marker and "DRAGGING" in the
      // report are the same line. Capped at 2 so a pathological setting stays on the colour ramp.
      s.drag = Math.min(2, Math.max(s.skateFrames / L.dragFrameLimit, s.clamped / L.clampedFrameLimit));
      s.wasStepping = f.stepping;
    }
    return legs;
  }

  return { sample, get legs() { return legs; } };
}

/**
 * Turn a scored window plus a headroom prediction into ranked, actionable advice.
 *
 * Every entry names ONE knob and a direction. That constraint is the whole point: a panel that lists six
 * correlated numbers tells you something is wrong and leaves you to guess which slider owns it, which is
 * the state this page was already in. Severity ranks them so the top entry is the one to move first.
 *
 * `report` may be null while the first window is still filling — the headroom rules alone still fire, and
 * those are the ones that matter for a slider being dragged right now.
 */
export function diagnoseGait({ report = null, headroom = null, limits = {} } = {}) {
  const L = { ...GAIT_LIMITS, ...limits };
  const out = [];
  const d = report?.dragging, t = report?.tapping;

  if (headroom) {
    if (headroom.speedOverrun > 1.02) {
      out.push({
        id: 'overrun', severity: clamp01((headroom.speedOverrun - 1) / 0.5),
        knob: 'speedScale', dir: -1, alt: { knob: 'strideScale', dir: +1 },
        symptom: 'The body outruns its own stride',
        evidence: `top speed is ${(headroom.speedOverrun * 100).toFixed(0)}% of what the legs can cycle`,
        why: 'Whatever the body covers beyond two envelopes per cycle has to be taken out of the planted feet. Lower the top speed, or give the legs a bigger envelope to spend.',
      });
    }
    if (headroom.restepEnvelopes < 0.9) {
      out.push({
        id: 'restep', severity: clamp01((0.9 - headroom.restepEnvelopes) / 0.7),
        knob: 'restepFraction', dir: +1,
        symptom: 'Feet are re-placed too eagerly',
        evidence: `re-step guard is ${headroom.restepEnvelopes.toFixed(2)} envelopes`,
        why: 'Under one envelope the foot is picked up again before the body has walked it back through the envelope, so it spends its whole stance at the front edge, where the leg is longest and slides.',
      });
    }
    if (headroom.stepFrames > 0 && headroom.stepFrames < 7) {
      out.push({
        id: 'snap', severity: clamp01((7 - headroom.stepFrames) / 4),
        knob: 'minStepSeconds', dir: +1, alt: { knob: 'stepDurationScale', dir: +1 },
        symptom: 'A step is over before it can be drawn',
        evidence: `the whole swing lasts ${headroom.stepFrames.toFixed(1)} frames`,
        why: 'The foot is lerped along its arc with a half-sine lift, so at three frames the arc is two interior samples and the trail comes out as a spike. The leg is not misbehaving; the motion is finishing before it can be seen.',
      });
    }
    if (headroom.strideNumber > 0.55) {
      out.push({
        id: 'cycleRate', severity: clamp01((headroom.strideNumber - 0.55) / 0.4),
        knob: 'strideNumberMax', dir: -1, alt: { knob: 'concurrentScale', dir: -1 },
        symptom: 'Legs cycle faster than legs that size can',
        evidence: `stride number ${headroom.strideNumber.toFixed(2)}, against about 0.6 for a real gallop`,
        why: 'A leg is a pendulum, so its natural rate goes as the square root of its length. Above roughly 0.6 the gait is asking for a frequency no animal of this size uses, and the give has to come from somewhere.',
      });
    }
    if (headroom.marginGap <= 0.01) {
      out.push({
        id: 'margin', severity: clamp01((0.01 - headroom.marginGap) / 0.1),
        knob: 'reachMargin', dir: -1, alt: { knob: 'reachStress', dir: +1 },
        symptom: 'Footholds are born overextended',
        evidence: `placement margin sits ${(-headroom.marginGap * 100).toFixed(0)}% above ask-to-step`,
        why: 'A foot placed further out than the distance that flags a leg as strained is already asking for its next step on the frame it lands.',
      });
    }
  }

  if (report) {
    if (report.speedVsMax > 1.1) {
      out.push({
        id: 'push', severity: clamp01((report.speedVsMax - 1.1) / 0.6),
        knob: 'supportPushLimit', dir: -1,
        symptom: 'Balance is acting as a motor',
        evidence: `travelling at ${(report.speedVsMax * 100).toFixed(0)}% of top speed`,
        why: 'The support normal leans the body toward its feet, and nothing else bounds the sideways part. It can push the body faster than the gait ever asked for, and the feet cannot keep up.',
      });
    }
    if (d.clampedFraction > L.clampedFrameLimit && (!headroom || headroom.marginGap > 0.01)) {
      out.push({
        id: 'clamped', severity: clamp01(d.clampedFraction / 0.3),
        knob: 'standExtension', dir: -1, alt: { knob: 'maxExtension', dir: +1 },
        symptom: 'Legs are asking for more than they can span',
        evidence: `${(d.clampedFraction * 100).toFixed(0)}% of planted frames past full reach`,
        why: 'The solver holds the drawn foot short of where the gait believes it is, so the foot slides. Settling the body shortens the reach every foothold needs and buys stride envelope with it.',
      });
    }
    if (d.blockedFraction > 0.6 && (!headroom || headroom.restepEnvelopes > 1.4)) {
      out.push({
        id: 'starved', severity: clamp01((d.blockedFraction - 0.6) / 0.4),
        knob: 'restepFraction', dir: -1,
        symptom: 'Legs want to step and are refused',
        evidence: `${(d.blockedFraction * 100).toFixed(0)}% of wanting frames blocked`,
        why: 'The guard is now wide enough that a leg has to be dragged a long way before it is allowed to move. That is the opposite failure to the one it prevents.',
      });
    }
    if (d.worstLegFraction > L.dragFrameLimit && !out.some(o => o.id === 'overrun' || o.id === 'push')) {
      out.push({
        id: 'skate', severity: clamp01(d.worstLegFraction / 0.4),
        knob: 'stepDurationScale', dir: -1, alt: { knob: 'strideScale', dir: +1 },
        symptom: 'Planted feet are sliding anyway',
        evidence: `leg ${d.worstLeg} slides on ${(d.worstLegFraction * 100).toFixed(0)}% of its planted frames`,
        why: 'Nothing in the tuning forces this, so the feet are simply cycling too slowly for the ground they cover. Shorter steps put each foot down more often.',
      });
    }
    if (report.verdict.tapping) {
      out.push({
        id: 'tap', severity: clamp01(t.worstLegRate / (L.tapRateLimit * 3)),
        knob: 'restepFraction', dir: +1, alt: { knob: 'stepDurationScale', dir: +1 },
        symptom: 'A leg is cycling without getting anywhere',
        evidence: `${t.worstLegRate.toFixed(2)} empty steps per second on leg ${t.worstLeg}`,
        why: 'The re-step guard is the gait\'s only hysteresis. With it this small a leg can lift again on the frame after it lands.',
      });
    }
  }

  return out.sort((a, b) => b.severity - a.severity);
}

/** Percentile of a sorted-in-place copy. Small traces, so the sort is not worth avoiding. */
function percentile(values, p) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const i = Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * p)));
  return v[i];
}

/**
 * Accumulate frames from `walker.diagnosticFrame()` and score them.
 *
 * Streaming rather than storing: a 60-second sweep run at 60 Hz across 14 species and a parameter grid is
 * millions of frames, and the report only ever needs counts, sums and one list of per-step travels.
 *
 * `limits` overrides `GAIT_LIMITS` per field.
 */
export function createGaitMonitor(limits = {}) {
  const L = { ...GAIT_LIMITS, ...limits };
  let legs = null;
  let frames = 0, elapsed = 0;
  let totalTravel = 0, totalCommanded = 0, totalSpeed = 0;
  let strideEnvelope = 0, stepDuration = 0, legSpan = 0, maxSpeed = 0;

  function legState() {
    return {
      // step bookkeeping
      wasStepping: false, stepStartX: 0, stepStartZ: 0, stanceTime: 0,
      steps: 0, taps: 0, shortStanceSteps: 0, shortTravelSteps: 0,
      travels: [], travelsEnv: [], stances: [],
      // planted-frame bookkeeping
      plantedFrames: 0, skatingFrames: 0, clampedFrames: 0,
      skate: [], gap: [], maxGap: 0, strayFrames: 0,
      // ...and per STANCE, which is the honest version of the same question: over one whole plant, how
      // much of the body's travel did this foot come along for? Integrating over the stance is what makes
      // it survive per-frame noise without an arbitrary distance threshold.
      stanceSlid: 0, stanceTravel: 0, stanceSkate: [],
      // scheduler bookkeeping — a leg that wants to move and is refused is the tell for drag-by-starvation
      blockedFrames: 0, wantFrames: 0,
    };
  }

  function sample(frame) {
    if (!frame || !frame.legs) return;
    if (!legs) legs = frame.legs.map(legState);
    frames++;
    const dt = frame.dt || 0;
    elapsed += dt;
    totalTravel += frame.bodyTravel || 0;
    totalCommanded += (frame.commandedSpeed || 0) * dt;
    totalSpeed += (frame.speed || 0) * dt;
    maxSpeed = frame.maxSpeed || maxSpeed;
    strideEnvelope = frame.strideEnvelope || strideEnvelope;
    stepDuration = frame.stepDuration || stepDuration;
    legSpan = frame.legSpan || legSpan;

    const travelFloor = strideEnvelope * L.travelFloorFraction;
    const bodyMoved = (frame.bodyTravel || 0) > travelFloor;

    for (let i = 0; i < frame.legs.length && i < legs.length; i++) {
      const f = frame.legs[i], s = legs[i];

      if (f.stepping && !s.wasStepping) {
        // Lift. The stance that just ended, and the stride about to begin, are judged together on landing.
        s.stepStartX = f.drawnX; s.stepStartZ = f.drawnZ;
        s.pendingStance = s.stanceTime;
        s.stanceTime = 0;
        if (s.stanceTravel > strideEnvelope * L.stanceTravelFloor) {
          s.stanceSkate.push(s.stanceSlid / s.stanceTravel);
        }
        s.stanceSlid = 0; s.stanceTravel = 0;
      } else if (!f.stepping && s.wasStepping) {
        // Landing. Travel is measured on the DRAWN foot, so a step the solver clamped into nothing counts
        // as the nothing it was rather than as the distance the gait intended.
        const travel = Math.hypot(f.drawnX - s.stepStartX, f.drawnZ - s.stepStartZ);
        const stance = s.pendingStance ?? 0;
        const span = f.span || legSpan || 1;
        s.steps++;
        s.travels.push(travel / span);
        s.travelsEnv.push(strideEnvelope > 0 ? travel / strideEnvelope : 0);
        s.stances.push(stepDuration > 0 ? stance / stepDuration : 0);
        // Counted SEPARATELY as well as together. A tap needs both halves, so a zero tap count is
        // ambiguous on its own: it could mean the gait is clean, or it could mean one half never fires and
        // the detector is dead. Keeping the halves lets a sweep say which, and the answer on the shipped
        // models turned out to be that stances are never short — never once in 70 configurations.
        const shortStance = stepDuration > 0 && stance < stepDuration * L.tapStanceFraction;
        const shortTravel = travel < span * L.tapTravelFraction;
        if (shortStance) s.shortStanceSteps++;
        if (shortTravel) s.shortTravelSteps++;
        if (shortStance && shortTravel) s.taps++;
      }

      if (!f.stepping) s.stanceTime += dt;
      if (f.wants) s.wantFrames++;
      if (f.wants && !f.canMove && !f.stepping) s.blockedFrames++;

      if (f.planted) {
        s.plantedFrames++;
        if (f.clamped) s.clampedFrames++;
        const slid = f.drawnStep || 0;
        const gapFrac = (f.span || legSpan) > 0 ? f.gap / (f.span || legSpan) : 0;
        s.gap.push(gapFrac);
        if (gapFrac > L.strayFraction) s.strayFrames++;
        if (f.gap > s.maxGap) s.maxGap = f.gap;
        s.stanceSlid += slid;
        s.stanceTravel += frame.bodyTravel || 0;
        // Skate is the slide as a fraction of how far the BODY moved over the same interval. A perfectly
        // planted foot scores 0; a foot carried along like a piece of the body scores 1.
        if (bodyMoved) {
          const ratio = slid / frame.bodyTravel;
          s.skate.push(ratio);
          if (ratio > L.skateRatioLimit) s.skatingFrames++;
        } else {
          s.skate.push(0);
        }
      }

      s.wasStepping = f.stepping;
    }
  }

  function report() {
    if (!legs || !frames) return null;
    const n = legs.length;
    const perLeg = legs.map((s, i) => {
      const planted = Math.max(1, s.plantedFrames);
      return {
        index: i,
        steps: s.steps,
        taps: s.taps,
        stepRate: elapsed > 0 ? s.steps / elapsed : 0,
        tapRate: elapsed > 0 ? s.taps / elapsed : 0,
        tapFraction: s.steps ? s.taps / s.steps : 0,
        shortStanceFraction: s.steps ? s.shortStanceSteps / s.steps : 0,
        shortTravelFraction: s.steps ? s.shortTravelSteps / s.steps : 0,
        medianTravel: percentile(s.travels, 0.5),
        medianTravelEnv: percentile(s.travelsEnv, 0.5),
        medianStance: percentile(s.stances, 0.5),
        skateP50: percentile(s.skate, 0.5),
        skateP95: percentile(s.skate, 0.95),
        skateFraction: s.skatingFrames / planted,
        stanceSkate: percentile(s.stanceSkate, 0.5),
        stanceSkateP95: percentile(s.stanceSkate, 0.95),
        stances: s.stanceSkate.length,
        clampedFraction: s.clampedFrames / planted,
        gapP95: percentile(s.gap, 0.95),
        maxGap: s.maxGap,
        strayFraction: s.strayFrames / planted,
        blockedFraction: s.wantFrames ? s.blockedFrames / s.wantFrames : 0,
        plantedFrames: s.plantedFrames,
      };
    });

    const worst = (key) => perLeg.reduce((a, b) => (b[key] > a[key] ? b : a), perLeg[0]);
    const mean = (key) => perLeg.reduce((a, b) => a + b[key], 0) / n;

    const tapping = {
      rate: mean('tapRate'),
      worstLegRate: worst('tapRate').tapRate,
      worstLeg: worst('tapRate').index,
      fraction: mean('tapFraction'),
      stepRate: mean('stepRate'),
      medianTravel: percentile(perLeg.map(l => l.medianTravel), 0.5),
      medianStance: percentile(perLeg.map(l => l.medianStance), 0.5),
      // The two halves on their own, so "no tapping" can be told apart from "detector never fires".
      shortStanceFraction: mean('shortStanceFraction'),
      shortTravelFraction: mean('shortTravelFraction'),
    };
    const dragging = {
      skateP50: percentile(perLeg.map(l => l.skateP50), 0.5),
      skateP95: percentile(perLeg.map(l => l.skateP95), 0.5),
      worstSkateP95: worst('skateP95').skateP95,
      fraction: mean('skateFraction'),
      worstLegFraction: worst('skateFraction').skateFraction,
      worstLeg: worst('skateFraction').index,
      stanceSkate: percentile(perLeg.map(l => l.stanceSkate), 0.5),
      worstStanceSkate: worst('stanceSkate').stanceSkate,
      scoredStances: perLeg.reduce((a, b) => a + b.stances, 0),
      clampedFraction: mean('clampedFraction'),
      gapP95: percentile(perLeg.map(l => l.gapP95), 0.5),
      maxGap: Math.max(...perLeg.map(l => l.maxGap)),
      strayFraction: mean('strayFraction'),
      worstStrayFraction: worst('strayFraction').strayFraction,
      blockedFraction: mean('blockedFraction'),
    };

    return {
      frames, elapsed, legs: n,
      strideEnvelope, stepDuration, legSpan,
      distance: totalTravel,
      meanSpeed: elapsed > 0 ? totalSpeed / elapsed : 0,
      meanCommanded: elapsed > 0 ? totalCommanded / elapsed : 0,
      // How much of the speed it asked for it actually got. Low with clean feet means the gait is
      // conservative; low with dirty feet means it is fighting itself.
      speedEfficiency: totalCommanded > 1e-9 ? totalSpeed / totalCommanded : 0,
      // Against the gait's TOP speed as well, because `speedEfficiency`'s denominator collapses toward
      // zero whenever a leg is flagged uncomfortable — the sim then commands 28% of an already small
      // number, and a perfectly ordinary creature reads as running at 600% of command. Only this one
      // says whether the body is outrunning the feet in absolute terms; anything much over 1 here is the
      // balance model pushing rather than the gait driving.
      speedVsMax: maxSpeed > 1e-9 ? totalSpeed / (elapsed * maxSpeed) : 0,
      tapping, dragging, perLeg,
      verdict: {
        tapping: tapping.worstLegRate > L.tapRateLimit,
        dragging: dragging.worstLegFraction > L.dragFrameLimit
          || dragging.worstStanceSkate > L.stanceSkateLimit
          || dragging.clampedFraction > L.clampedFrameLimit,
      },
      limits: L,
    };
  }

  return { sample, report, get frames() { return frames; } };
}

/**
 * Run a whole trace at once. Convenience for tests and for anything that already has the frames in an
 * array; the sweep streams instead.
 */
export function analyseGait(frames, limits) {
  const m = createGaitMonitor(limits);
  for (const f of frames) m.sample(f);
  return m.report();
}

/** One line per creature, for sweep output that a person has to read. */
export function formatGaitReport(r, label = '') {
  if (!r) return `${label} no frames`;
  const pct = (v) => (v * 100).toFixed(1).padStart(5) + '%';
  const flag = r.verdict.tapping || r.verdict.dragging
    ? ` <- ${[r.verdict.tapping && 'TAP', r.verdict.dragging && 'DRAG'].filter(Boolean).join(' ')}`
    : '';
  return `${label.padEnd(16)} tap/s ${r.tapping.worstLegRate.toFixed(2)}`
    + `  stride ${pct(r.tapping.medianTravel)}`
    + `  skate ${pct(r.dragging.worstLegFraction)}`
    + `  clamped ${pct(r.dragging.clampedFraction)}`
    + `  blocked ${pct(r.dragging.blockedFraction)}`
    + `  v/cmd ${pct(r.speedEfficiency)}  v/max ${pct(r.speedVsMax)}${flag}`;
}
