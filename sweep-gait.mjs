// Sweep the walker's tuning space and report where the feet misbehave.
//
//   node sweep-gait.mjs                 baseline across every shipped species
//   node sweep-gait.mjs <knob>          one knob swept across its range, all species
//   node sweep-gait.mjs all             every knob, one at a time
//   node sweep-gait.mjs grid            the two-knob interactions worth looking at
//
// This is a measuring instrument, not a test — it prints numbers and never fails. `test-stadium-rig.mjs`
// is where the conclusions get pinned down so they cannot drift.

import fs from 'node:fs';
import * as THREE from 'three';
import { mapStadiumRigFromGLB } from './stadium-rig-map.js';
import { createStadiumWalker } from './stadium-walker.js';
import { createGaitMonitor, formatGaitReport, gaitHeadroom, diagnoseGait, createLegWatch } from './gait-diagnostics.js';
import { GAITS } from './creature-locomotion.js';

// `GAIT=gallop node sweep-gait.mjs ...`. Every number in the drag work was taken under `walk`, which was
// a listed gap: gallop halves the step duration and doubles how many legs may be airborne at once, and
// both of those are exactly the mechanisms the sweep found to matter.
const BASE_GAIT = GAITS[process.env.GAIT || 'walk'] ?? GAITS.walk;

const SPECIES = fs.readdirSync('models/stadium').filter(f => f.endsWith('.glb')).map(f => f.replace('.glb', ''))
  .filter(s => !process.env.ONLY || process.env.ONLY.split(',').some(p => s.includes(p)));
const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const WARMUP = 2.0, MEASURE = +(process.env.MEASURE || 20), DT = 1 / 60;

/**
 * A stand-in for GLTFLoader's output: one Object3D per glTF node, named and parented the same way. That
 * is all the walker touches, so a real loader would add nothing. Same helper as `test-stadium-rig.mjs`.
 */
function buildScene(json) {
  const objs = json.nodes.map((n) => {
    const o = new THREE.Object3D();
    o.name = n.name || '';
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    if (n.matrix) { o.matrix.fromArray(n.matrix); o.matrix.decompose(o.position, o.quaternion, o.scale); }
    return o;
  });
  json.nodes.forEach((n, i) => { for (const c of n.children || []) objs[i].add(objs[c]); });
  const root = new THREE.Group();
  for (const r of json.scenes[0].nodes) root.add(objs[r]);
  return root;
}

const CACHE = new Map();
function load(species) {
  if (!CACHE.has(species)) CACHE.set(species, mapStadiumRigFromGLB(fs.readFileSync(`models/stadium/${species}.glb`)));
  return CACHE.get(species);
}

/**
 * Build, settle, then walk one creature and score it. Ground defaults to flat.
 *
 * Knobs go through `retune`, NOT through the constructor. Most of them — `speedScale`,
 * `stepDurationScale`, `concurrentScale`, `strideScale` — are fields on the tuning object with no
 * constructor argument behind them, so passing them to `createStadiumWalker` sets nothing at all and the
 * sweep reports the default over and over. It did exactly that, and the tell was every row of a sweep
 * coming out byte-identical. `worldHeight` is the exception: the unit scale is baked into the leg lengths
 * at build time, so it has to be known before the rig exists.
 */
function run(species, tuning = {}, { ground = null, seed = 7 } = {}) {
  const { json, map } = load(species);
  if (!map.legs.length) return null;
  const { worldHeight = 0.5, ...rest } = tuning;
  const walker = createStadiumWalker({
    THREE, scene: buildScene(json), map, terrainHeight: ground ?? (() => 0), rng: seeded(seed), worldHeight,
    gait: BASE_GAIT,
  });
  if (Object.keys(rest).length) walker.retune(rest);
  for (let t = 0; t < WARMUP; t += DT) walker.update(DT, { walk: false });
  const mon = createGaitMonitor();
  for (let t = 0; t < MEASURE; t += DT) {
    walker.update(DT);
    mon.sample(walker.diagnosticFrame());
  }
  const r = mon.report();
  if (r) {
    // The prediction, taken from the same walker that was just measured. Read together they answer the
    // question the demo panel has to answer live: does the arithmetic on the tuning agree with what the
    // feet actually did? `predict` mode below scores that agreement rather than assuming it.
    r.headroom = gaitHeadroom(walker.diagnosticFrame());
    r.species = species;
    r.rideHeight = map.rideHeight * walker.unitScale;
    r.heightRatio = (walker.body.pos.y - walker.state.terrainHeight(walker.body.pos.x, walker.body.pos.z)) / r.rideHeight;
    r.legCount = map.legs.length;
  }
  return r;
}

/** Knobs worth sweeping, with the range a slider actually offers. */
const KNOBS = {
  restepFraction:    [0.02, 0.05, 0.10, 0.15, 0.25, 0.40, 0.70, 1.20, 2.50, 5.00],
  concurrentScale:   [0.5, 1.0, 2.0, 3.0, 4.0],
  cooldownScale:     [0, 0.25, 0.5, 0.75, 1.0],
  supportPushLimit:  [0.25, 0.5, 0.75, 1.0, 1.5, 3.0, 99],
  speedScale:        [0.4, 0.7, 1.0, 1.3, 1.6, 2.0, 2.5],
  stepDurationScale: [0.5, 0.7, 1.0, 1.4, 2.0, 3.0],
  // 0 switches a floor off, which is the only way to see what it is buying.
  minStepSeconds:    [0, 0.05, 0.08, 0.10, 0.13, 0.16],
  strideNumberMax:   [0, 0.35, 0.5, 0.7, 1.0, 2.0],
  supportPolygonFloor: [0, 2, 3, 4],
  strideScale:       [0.4, 0.6, 0.8, 1.0, 1.2, 1.5],
  stepLiftScale:     [0.3, 0.6, 1.0, 1.6, 2.5],
  reachStress:       [0.70, 0.80, 0.90, 0.95, 0.99],
  reachMargin:       [0.70, 0.80, 0.92, 0.98, 1.00],
  placeMargin:       [0.40, 0.55, 0.70, 0.85, 1.00],
  maxExtension:      [0.90, 0.95, 0.99, 1.00],
  standExtension:    [0.70, 0.80, 0.90, 0.96],
  uprightSupport:    [0, 0.25, 0.5, 0.75, 1.0],
  swingLimit:        [Math.PI / 9, Math.PI / 7, Math.PI / 5, Math.PI / 3.5, Math.PI / 2.5],
  worldHeight:       [0.25, 0.5, 1.0, 2.0],
};

function summarise(rows, label) {
  const scored = rows.filter(Boolean);
  if (!scored.length) return;
  const tap = scored.filter(r => r.verdict.tapping).length;
  const drag = scored.filter(r => r.verdict.dragging).length;
  // The control that was missing from the first pass: a creature that has collapsed onto its hard floor
  // drags its feet trivially, and reading that as a foot-scheduling failure would send the whole sweep
  // chasing the wrong knob. Anything under 85% of its own ride height is not standing.
  const down = scored.filter(r => r.heightRatio < 0.85).length;
  console.log(`${label.padEnd(22)} tap ${String(tap).padStart(2)}/${scored.length}  drag ${String(drag).padStart(2)}/${scored.length}`
    + `  down ${String(down).padStart(2)}`
    + `  height ${(median(scored.map(r => r.heightRatio)) * 100).toFixed(0).padStart(3)}%`
    + `  skate ${(median(scored.map(r => r.dragging.stanceSkate)) * 100).toFixed(1).padStart(5)}%`
    + `  clamp ${(median(scored.map(r => r.dragging.clampedFraction)) * 100).toFixed(1).padStart(5)}%`
    + `  stray ${(Math.max(...scored.map(r => r.dragging.worstStrayFraction)) * 100).toFixed(2).padStart(5)}%`
    + `  tap/s ${median(scored.map(r => r.tapping.worstLegRate)).toFixed(2)}`
    + `  steps/s ${median(scored.map(r => r.tapping.stepRate)).toFixed(2)}`
    + `  stance ${median(scored.map(r => r.tapping.medianStance)).toFixed(1).padStart(4)}x`
    + `  short st/tr ${(median(scored.map(r => r.tapping.shortStanceFraction)) * 100).toFixed(0).padStart(3)}/`
    + `${(median(scored.map(r => r.tapping.shortTravelFraction)) * 100).toFixed(0).padStart(3)}%`
    + `  stride ${(median(scored.map(r => r.tapping.medianTravel)) * 100).toFixed(0).padStart(3)}%`
    + `  blocked ${(median(scored.map(r => r.dragging.blockedFraction)) * 100).toFixed(0).padStart(3)}%`
    + `  speed ${(median(scored.map(r => r.speedEfficiency)) * 100).toFixed(0).padStart(3)}%`);
}
function median(v) { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; }

const mode = process.argv[2] || 'baseline';

if (mode === 'baseline') {
  console.log(`baseline — ${SPECIES.length} species, ${MEASURE}s each, flat ground\n`);
  const rows = [];
  for (const s of SPECIES) {
    const r = run(s);
    rows.push(r);
    if (r) console.log(formatGaitReport(r, `${s} (${r.legCount})`));
    else console.log(`${s.padEnd(16)} no legs`);
  }
  console.log('');
  summarise(rows, 'DEFAULTS');
  console.log('\nper-species detail (worst leg):');
  for (const r of rows.filter(Boolean)) {
    const w = r.perLeg.reduce((a, b) => (b.stanceSkate > a.stanceSkate ? b : a), r.perLeg[0]);
    console.log(`  ${r.species.padEnd(16)} height ${(r.heightRatio * 100).toFixed(0)}%`
      + `  stance-skate ${(r.dragging.stanceSkate * 100).toFixed(1)}%`
      + `  worst leg ${w.index} ${(w.stanceSkate * 100).toFixed(1)}%`
      + `  clamped ${(r.dragging.clampedFraction * 100).toFixed(1)}%`
      + `  blocked ${(r.dragging.blockedFraction * 100).toFixed(1)}%`
      + `  steps/s ${r.tapping.stepRate.toFixed(2)}`
      + `  stride ${(r.tapping.medianTravel * 100).toFixed(0)}%`);
  }
} else if (mode === 'scale') {
  // What a stride is actually worth, in millimetres and in every unit the detectors might normalise by.
  // This exists because the first sweep reported strides of 500% of the stride envelope, which is either
  // a broken metric or a broken derivation, and the two are not distinguishable from a percentage.
  console.log('stride envelope vs. what the feet actually do\n');
  const rows = [];
  for (const species of SPECIES) {
    const { json, map } = load(species);
    if (!map.legs.length) continue;
    const w = createStadiumWalker({
      THREE, scene: buildScene(json), map, terrainHeight: () => 0, rng: seeded(7), worldHeight: 0.5,
    });
    const spans = w.legs.map(l => l.l1 + l.l2);
    const travels = w.legs.map(() => []);
    const open = w.legs.map(() => null);
    for (let t = 0; t < WARMUP; t += DT) w.update(DT, { walk: false });
    for (let t = 0; t < MEASURE; t += DT) {
      w.update(DT);
      w.legs.forEach((l, i) => {
        if (l.stepping && open[i] == null) open[i] = { x: l.drawnFoot.x, z: l.drawnFoot.z };
        else if (!l.stepping && open[i]) {
          travels[i].push(Math.hypot(l.drawnFoot.x - open[i].x, l.drawnFoot.z - open[i].z));
          open[i] = null;
        }
      });
    }
    const all = travels.flat();
    const env = w.state.strideEnvelope;
    rows.push({
      species,
      'env mm': +(env * 1000).toFixed(1),
      'span mm': +(Math.min(...spans) * 1000).toFixed(1),
      'env/span': +(env / Math.min(...spans)).toFixed(3),
      'travel mm': +(median(all) * 1000).toFixed(1),
      'travel/env': +(median(all) / env).toFixed(2),
      'travel/span': +(median(all) / Math.min(...spans)).toFixed(3),
      'maxSpeed': +w.state.gait.maxSpeed.toFixed(3),
      'trigH mm': +(w.state.gait.movingTrigger.h * 1000).toFixed(1),
      'perLegSpread': +(Math.max(...spans) / Math.min(...spans)).toFixed(2),
    });
  }
  console.table(rows);
} else if (mode === 'provoke') {
  // Can the tapping detector fire on the REAL walker at all?
  //
  // Fifty grid cells came back with zero tapping, and there are two readings of that: the gait cannot tap,
  // or the detector cannot see. They are not distinguishable from the clean result alone, so this switches
  // off the three things that supply hysteresis — the concurrency cap, the turn-taking cooldowns and the
  // re-step guard — one at a time and then together. If tapping does not appear even with all three off,
  // the detector is what is broken, and everything above is worthless.
  const CASES = [
    ['shipped defaults', {}],
    ['no re-step guard', { restepFraction: 0.001 }],
    ['no cooldowns', { cooldownScale: 0 }],
    ['no concurrency cap', { concurrentScale: 4 }],
    ['no guard, no cooldowns', { restepFraction: 0.001, cooldownScale: 0 }],
    ['all three off', { restepFraction: 0.001, cooldownScale: 0, concurrentScale: 4 }],
    ['all three off, slow steps', { restepFraction: 0.001, cooldownScale: 0, concurrentScale: 4, stepDurationScale: 3 }],
  ];
  console.log('provoking tapping by removing hysteresis\n');
  for (const [label, tune] of CASES) {
    const rows = SPECIES.map(s => run(s, tune)).filter(Boolean);
    summarise(rows, label);
  }

  // Removing hysteresis was not enough, and the reason is structural: `advanceLeg` copies `stepEnd` into
  // `leg.end` on landing, and `stepEnd` was the target, so a foot that has just landed is at ZERO error
  // against the thing the trigger measures. The trigger cannot re-fire until the TARGET moves. Which means
  // tapping is not reachable by loosening the scheduler at all — it needs an unstable target, and the
  // target comes from a 3x3 foothold scan of the ground. So: rough ground, at the scan's own scale.
  console.log('\nrough ground, where the foothold scan itself is unstable\n');
  const rough = (amp, wl) => (x, z) =>
    amp * (Math.sin(x / wl) * Math.sin(z / wl) + 0.5 * Math.sin((x + z) / (wl * 0.37)));
  const GROUNDS = [
    ['flat', null],
    ['gentle 40mm/2m', rough(0.04, 2.0)],
    ['choppy 40mm/25cm', rough(0.04, 0.25)],
    ['choppy 80mm/12cm', rough(0.08, 0.12)],
    ['savage 150mm/6cm', rough(0.15, 0.06)],
  ];
  for (const [label, ground] of GROUNDS) {
    const rows = SPECIES.map(s => run(s, {}, { ground })).filter(Boolean);
    summarise(rows, label);
  }
  console.log('\n...and the same rough ground with the hysteresis removed\n');
  for (const [label, ground] of GROUNDS.slice(1)) {
    const rows = SPECIES.map(s => run(s, { restepFraction: 0.001, cooldownScale: 0, concurrentScale: 4 }, { ground })).filter(Boolean);
    summarise(rows, `${label} + loose`);
  }
} else if (mode === 'stand') {
  // How extended is each leg once the creature has settled and BEFORE it walks anywhere?
  //
  // `standExtension` settles the body until the TIGHTEST leg sits at 90% of its span. Nothing settles the
  // others, and a leg that is already at 98% standing still has no room to be walked over. This is the
  // measurement that says whether a ~50% clamp rate is a scheduling failure or simply the shape of the
  // animal.
  console.log('per-leg extension after settling, as a fraction of that leg\'s own span\n');
  for (const species of SPECIES) {
    const { json, map } = load(species);
    if (!map.legs.length) continue;
    const w = createStadiumWalker({
      THREE, scene: buildScene(json), map, terrainHeight: () => 0, rng: seeded(7), worldHeight: 0.5,
    });
    for (let t = 0; t < WARMUP * 2; t += DT) w.update(DT, { walk: false });
    const f = w.diagnosticFrame();
    const ext = f.legs.map(l => l.reach / l.span);
    const limit = w.tuning.maxExtension;
    const over = ext.filter(e => e > limit).length;
    console.log(`  ${species.padEnd(16)} limit ${limit.toFixed(2)}  legs ` +
      ext.map(e => (e > limit ? `[${e.toFixed(3)}]` : ` ${e.toFixed(3)} `)).join('') +
      `   ${over}/${ext.length} already past the limit standing still`);
  }
} else if (mode === 'grid') {
  // The two knobs the sweep has narrowed the failures down to.
  //
  //   `restepFraction`  how far a foot must be from its target before the leg may step, as a fraction of
  //                     the stride envelope. Small values pin the foot at the FRONT of the envelope,
  //                     where the leg is longest, and it drags there.
  //   `concurrentScale` how much of the body may be airborne at once. This is what decides whether a
  //                     stance can be short enough to tap at all.
  //
  // Cells are "<tapping>T/<dragging>D" out of the species that walk.
  const rowKnob = process.argv[3] || 'restepFraction';
  const colKnob = process.argv[4] || 'concurrentScale';
  if (!KNOBS[rowKnob] || !KNOBS[colKnob]) {
    console.log(`unknown knob; known: ${Object.keys(KNOBS).join(', ')}`);
  } else {
    console.log(`${rowKnob} x ${colKnob} — species failing out of ${SPECIES.length}, "<tap>T/<drag>D"\n`);
    const cols = KNOBS[colKnob];
    console.log(`${rowKnob}\\${colKnob}`.padEnd(30) + cols.map(s => String(s).padStart(10)).join(''));
    for (const rowValue of KNOBS[rowKnob]) {
      const cells = cols.map(colValue => {
        const rows = SPECIES.map(s => run(s, { [rowKnob]: rowValue, [colKnob]: colValue })).filter(Boolean);
        const tap = rows.filter(r => r.verdict.tapping).length;
        const drag = rows.filter(r => r.verdict.dragging).length;
        return `${tap}T/${drag}D`.padStart(10);
      });
      console.log(String(rowValue).padEnd(30) + cells.join(''));
    }
  }
} else if (mode === 'watch') {
  // The per-leg scorer the demo colours its foot markers from, run headless. The whole-creature report
  // averages legs together, which is right for a verdict and wrong for a marker that has to sit under ONE
  // foot — so this prints what each leg would be coloured, and exists because a marker validated only by
  // looking at it is not validated. `ONLY=025_pikachu node sweep-gait.mjs watch`.
  const pick = process.env.ONLY ? SPECIES.filter(s => s.includes(process.env.ONLY)) : SPECIES;
  // `TUNE='{"reachMargin":1}' node sweep-gait.mjs watch` — the markers have to be checkable in the states
  // that make them appear, and at the shipped defaults nothing clamps, so the drawn-to-target gap the
  // demo draws a stick for is zero on every model.
  const tune = process.env.TUNE ? JSON.parse(process.env.TUNE) : {};
  for (const species of pick) {
    const { json, map } = load(species);
    if (!map.legs.length) continue;
    const walker = createStadiumWalker({
      THREE, scene: buildScene(json), map, terrainHeight: () => 0, rng: seeded(7), worldHeight: 0.5,
      gait: BASE_GAIT,
    });
    if (Object.keys(tune).length) walker.retune(tune);
    for (let t = 0; t < WARMUP; t += DT) walker.update(DT, { walk: false });
    const watch = createLegWatch();
    const mon = createGaitMonitor();
    for (let t = 0; t < MEASURE; t += DT) {
      walker.update(DT);
      const f = walker.diagnosticFrame();
      mon.sample(f); watch.sample(f);
    }
    const r = mon.report();
    console.log(`${species}  ${r.verdict.dragging ? 'DRAGGING' : 'clean'}  `
      + `risk ${gaitHeadroom(walker.diagnosticFrame()).dragRisk.toFixed(2)}`);
    for (const l of watch.legs) {
      const bar = '#'.repeat(Math.min(20, Math.round(l.drag * 10))).padEnd(20, '.');
      console.log(`   ${String(l.row) + (l.side < 0 ? 'L' : 'R')}  drag ${l.drag.toFixed(2).padStart(5)} ${bar}`
        + `  slide ${(l.skate * 100).toFixed(0).padStart(3)}%  clamp ${(l.clamped * 100).toFixed(0).padStart(3)}%`
        + `  gap ${(l.gapSpan * 100).toFixed(1).padStart(4)}% of span  taps ${l.taps}/${l.steps}`);
    }
  }
} else if (mode === 'snap') {
  // FOOT KINEMATICS, which nothing else here measures. The stance-and-travel tap detector normalises
  // stance against `stepDuration` — so if the tuning makes `stepDuration` itself absurd, the detector
  // divides the absurdity out and reports nothing. This mode looks at the quantities that have no such
  // escape: how fast the drawn foot actually moves, how often it reverses direction, and how many times
  // a leg cycles per body length of ground covered.
  for (const species of SPECIES) {
    const { json, map } = load(species);
    if (!map.legs.length) continue;
    const walker = createStadiumWalker({
      THREE, scene: buildScene(json), map, terrainHeight: () => 0, rng: seeded(7), worldHeight: 0.5,
      gait: BASE_GAIT,
    });
    for (let t = 0; t < WARMUP; t += DT) walker.update(DT, { walk: false });

    const n = walker.legs.length;
    const prev = Array.from({ length: n }, () => ({ x: 0, z: 0, dx: 0, dz: 0, have: false }));
    const swing = Array.from({ length: n }, () => []);
    const rev = new Array(n).fill(0);
    const steps = new Array(n).fill(0);
    const wasStep = new Array(n).fill(false);
    let distance = 0, span = 0, stepDuration = 0, envelope = 0;

    for (let t = 0; t < MEASURE; t += DT) {
      walker.update(DT);
      const f = walker.diagnosticFrame();
      distance += f.bodyTravel; stepDuration = f.stepDuration; envelope = f.strideEnvelope;
      for (let i = 0; i < n; i++) {
        const l = f.legs[i], p = prev[i];
        span = Math.max(span, l.span);
        const dx = l.drawnX - p.x, dz = l.drawnZ - p.z;
        const len = Math.hypot(dx, dz);
        if (p.have && len > l.span * 1e-4) {
          // A reversal is the drawn foot turning more than 120 degrees between frames. That is the
          // zigzag in the foot trail, counted rather than looked at.
          const pl = Math.hypot(p.dx, p.dz);
          if (pl > l.span * 1e-4 && (dx * p.dx + dz * p.dz) / (len * pl) < -0.5) rev[i]++;
          p.dx = dx; p.dz = dz;
        }
        p.x = l.drawnX; p.z = l.drawnZ; p.have = true;
        if (l.stepping) swing[i].push(len / DT / l.span);
        if (l.stepping && !wasStep[i]) steps[i]++;
        wasStep[i] = l.stepping;
      }
    }

    const pk = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.round((a.length - 1) * 0.95)] : 0);
    const bodySpeed = distance / MEASURE;
    // The dimensionless stride frequency. Legs are pendulums, so the natural rate scales as the square
    // root of length over gravity — which is why a raw "steps per second" says nothing across models
    // that differ threefold in size, and this does. Real walking animals sit around 0.2 to 0.5.
    const strideNumber = (steps.reduce((a, b) => a + b, 0) / n / MEASURE) * Math.sqrt(span / 9.81);
    // THE ONE THAT DECIDES IT. A leg cycle is worth two stride envelopes of ground, so if the body
    // travelled two envelopes for every step the leg took, every step was paid for. Below 1 the leg is
    // cycling faster than the ground it covers justifies, which is tapping stated as a ratio — and it
    // needs no threshold on stance or stride, so the tuning cannot normalise it away.
    const stepsPerLeg = steps.reduce((a, b) => a + b, 0) / n;
    const paidFor = envelope > 0 ? (distance / stepsPerLeg) / (2 * envelope) : 0;
    console.log(`${species.padEnd(14)} span ${(span * 100).toFixed(1).padStart(5)}cm`
      + `  step ${(stepDuration * 1000).toFixed(0).padStart(4)}ms = ${(stepDuration * 60).toFixed(1).padStart(4)} frames`
      + `  steps/s ${(stepsPerLeg / MEASURE).toFixed(2).padStart(5)}`
      + `  strideNo ${strideNumber.toFixed(2).padStart(5)}`
      + `  paidFor ${paidFor.toFixed(2).padStart(5)}`
      + `  travel ${(distance / span / MEASURE).toFixed(2).padStart(5)} spans/s`
      + `  swing p95 ${pk(swing.flat()).toFixed(1).padStart(5)} span/s`
      + `  = ${(pk(swing.flat()) * span / Math.max(1e-6, bodySpeed)).toFixed(1).padStart(6)}x body`
      + `  reversals/s ${(rev.reduce((a, b) => a + b, 0) / n / MEASURE).toFixed(1).padStart(5)}`);
  }
} else if (mode === 'predict') {
  // DOES THE PREDICTION PREDICT? `gaitHeadroom` claims to say from the tuning alone what the monitor
  // needs seconds of walking to observe, and the demo panel puts that claim in front of a person the
  // instant they move a slider. A gauge that looks authoritative and is uncorrelated with the thing it
  // names is worse than no gauge, so this scores it as a classifier over every species crossed with the
  // knobs that are supposed to drive the prediction — and prints the disagreements, which are the rows
  // that say where the arithmetic stops holding.
  const CASES = [
    ...[0.7, 1.0, 1.6, 2.5].map(v => ({ speedScale: v })),
    ...[0.05, 0.15, 0.4, 1.2, 2.5].map(v => ({ restepFraction: v })),
    ...[0.70, 0.92, 1.00].map(v => ({ reachMargin: v })),
  ];
  let tp = 0, fp = 0, tn = 0, fn = 0;
  const misses = [];
  for (const tune of CASES) {
    for (const s of SPECIES) {
      const r = run(s, tune);
      if (!r) continue;
      const predicted = r.headroom.dragRisk > 0.5;
      const measured = r.verdict.dragging;
      if (predicted && measured) tp++;
      else if (predicted && !measured) fp++;
      else if (!predicted && measured) { fn++; misses.push([s, tune, r]); }
      else tn++;
    }
  }
  const label = (t) => Object.entries(t).map(([k, v]) => `${k}=${v}`).join(',');
  console.log(`predicted drag vs measured drag over ${CASES.length} settings x ${SPECIES.length} species\n`);
  console.log(`  caught      ${tp}   predicted and it dragged`);
  console.log(`  missed      ${fn}   dragged with no warning`);
  console.log(`  over-warned ${fp}   warned and it walked cleanly`);
  console.log(`  quiet       ${tn}   no warning, no drag`);
  console.log(`\n  recall ${(tp / Math.max(1, tp + fn) * 100).toFixed(0)}%  precision ${(tp / Math.max(1, tp + fp) * 100).toFixed(0)}%`);
  if (misses.length) {
    console.log(`\n  the misses — a drag the arithmetic does not see coming:\n`);
    for (const [s, tune, r] of misses.slice(0, 20)) {
      console.log(`    ${s.padEnd(14)} ${label(tune).padEnd(22)} risk ${r.headroom.dragRisk.toFixed(2)}`
        + `  overrun ${r.headroom.speedOverrun.toFixed(2)}  guard ${r.headroom.restepEnvelopes.toFixed(2)}env`
        + `  measured skate ${(r.dragging.worstLegFraction * 100).toFixed(0)}%`
        + ` clamp ${(r.dragging.clampedFraction * 100).toFixed(0)}%`
        + ` v/max ${(r.speedVsMax * 100).toFixed(0)}%`
        + `  advice: ${diagnoseGait({ report: r, headroom: r.headroom })[0]?.knob ?? 'none'}`);
    }
    if (misses.length > 20) console.log(`    ...and ${misses.length - 20} more`);
  }
} else {
  const knobs = mode === 'all' ? Object.keys(KNOBS) : [mode];
  for (const knob of knobs) {
    if (!KNOBS[knob]) { console.log(`unknown knob ${knob}; known: ${Object.keys(KNOBS).join(', ')}`); continue; }
    console.log(`\n=== ${knob} ===`);
    for (const value of KNOBS[knob]) {
      const rows = SPECIES.map(s => run(s, { [knob]: value }));
      summarise(rows, `${knob}=${typeof value === 'number' ? value.toFixed(3) : value}`);
    }
  }
}
