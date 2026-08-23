// Node checks for the search loop and the trial log. Run with `node test-gait-search.mjs`.
//
// The optimiser is tested against a made-up cost function whose minimum is known in advance, which is the
// only way to tell "it found the best settings" apart from "it returned the settings it started with".

import fs from 'node:fs';
import {
  KNOBS, knobInfo, perturb, searchCost, optimise, transferValues, tuningDistance, changedKeys,
} from './gait-search.js';
import { createTrialLog, flattenMetrics, toCSV, tuningMatrix, verdictSeries } from './trial-log.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** A deterministic generator, so a failing case can be re-run. */
const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const SPECS = {
  speedScale:     { min: 0.2, max: 3, step: 0.05, value: 1 },
  restepFraction: { min: 0.05, max: 3, step: 0.05, value: 1.2 },
  standExtension: { min: 0.6, max: 1, step: 0.01, value: 0.9 },
  supportPolygonFloor: { min: 0, max: 4, step: 1, value: 3 },
  footGround:     { min: -0.02, max: 0.06, step: 0.002, value: 0 },
};
const BASE = { speedScale: 1, restepFraction: 1.2, standExtension: 0.9, supportPolygonFloor: 3, footGround: 0 };

// ===================== the knob table =====================

check('every slider either demo offers is described in KNOBS', () => {
  // The drift this prevents is silent and total: a knob added to the panel and not to the table would
  // never be randomised and would never transfer, and nothing would say so. Both pages are scraped —
  // v2 is where new knobs land, and it was unguarded while only v1 was read.
  for (const page of ['demos/stadium-walker.html', 'demos/stadium-walker-v2.html']) {
    const html = fs.readFileSync(page, 'utf8');
    const keys = [...html.matchAll(/key:\s*'([^']+)',\s*scope:\s*'(walker|rebuild)'/g)].map(m => m[1]);
    assert(keys.length > 10, `${page}: only found ${keys.length} tunable sliders — the scrape is broken`);
    const missing = keys.filter(k => !KNOBS[k]);
    assert(!missing.length, `${page}: sliders missing from KNOBS: ${missing.join(', ')}`);
  }
});

check('the stance sliders are kept out of the gait search', () => {
  // A search free to re-pose the model could improve its own numbers by changing the creature underneath
  // them, so stance knobs must never appear as walker/rebuild scope and never reach KNOBS.
  const html = fs.readFileSync('demos/stadium-walker-v2.html', 'utf8');
  const stanceKeys = [...html.matchAll(/key:\s*`?([A-Za-z_$][\w$]*(?:\$\{key\})?)`?,\s*scope:\s*'stance'/g)];
  assert(stanceKeys.length, 'no stance-scoped sliders found — has the scrape broken?');
  for (const k of Object.keys(KNOBS)) {
    assert(!k.startsWith('stance'), `${k} is a stance knob and must not be in KNOBS`);
  }
});

check('the absolute knobs are the ones marked non-transferable', () => {
  // Named explicitly rather than counted, because getting this list wrong is the failure that reads as
  // "the setpoint is broken on this species" months later.
  for (const k of ['footGround', 'roamRadius', 'worldHeight', 'supportPolygonFloor']) {
    assert(!knobInfo(k).transfer, `${k} should not transfer`);
    assert(knobInfo(k).why, `${k} should say why it does not transfer`);
  }
  // ...and the trap: this one is in absolute seconds and DOES transfer, because it is a floor on what the
  // eye can follow, and the eye does not care how big the animal is.
  assert(knobInfo('minStepSeconds').transfer, 'minStepSeconds should transfer');
  assert(knobInfo('restepFraction').transfer && knobInfo('standExtension').transfer, 'fractions should transfer');
});

check('an unknown knob is treated as the safe pair', () => {
  const info = knobInfo('somethingNew');
  assert(info.kind === 'linear' && info.transfer === false, 'an undescribed knob should not transfer');
});

// ===================== perturbation =====================

check('a percentage moves a multiplier the same amount up as down', () => {
  // The whole reason ratio knobs are perturbed in log space. Additive-on-range would move a knob at 0.3
  // and a knob at 3.0 by the same absolute amount, which is a rounding error for one and a rewrite of the
  // other.
  // Both sample points are kept AWAY FROM THE SLIDER'S ENDS on purpose. A knob already sitting at its
  // ceiling cannot move up, so comparing there measures the clamp rather than the log scaling — which is
  // how this check failed the first time it ran.
  const up = perturb({ speedScale: 0.3 }, SPECS, 0.3, () => 1, ['speedScale']).speedScale;
  const down = perturb({ speedScale: 0.3 }, SPECS, 0.3, () => 0, ['speedScale']).speedScale;
  const upBig = perturb({ speedScale: 2 }, SPECS, 0.3, () => 1, ['speedScale']).speedScale;
  assert(up > 0.3 && down < 0.3, 'the extremes of the generator should move it both ways');
  const ratioSmall = up / 0.3, ratioBig = upBig / 2;
  assert(Math.abs(ratioSmall - ratioBig) < 0.2, `the same nudge gave ${ratioSmall.toFixed(2)}x at 0.3 and ${ratioBig.toFixed(2)}x at 2`);
});

check('a knob at the end of its slider still yields a legal value', () => {
  // The behaviour the previous check tripped over, pinned down so it is documented rather than surprising.
  const p = perturb({ speedScale: 3 }, SPECS, 0.5, () => 1, ['speedScale']);
  assert(p.speedScale === 3, `expected the ceiling to hold, got ${p.speedScale}`);
});

check('a linear knob moves by a share of its own range', () => {
  const v = perturb({ standExtension: 0.8 }, SPECS, 0.5, () => 1, ['standExtension']).standExtension;
  // Half of a 0.4 range is 0.2, clamped to the 1.0 ceiling.
  assert(Math.abs(v - 1.0) < 1e-6, `expected the ceiling, got ${v}`);
});

check('proposals stay inside the slider and on its step', () => {
  const rng = seeded(11);
  for (let i = 0; i < 400; i++) {
    const p = perturb(BASE, SPECS, 0.9, rng);
    for (const [k, spec] of Object.entries(SPECS)) {
      assert(p[k] >= spec.min - 1e-9 && p[k] <= spec.max + 1e-9, `${k} left its range: ${p[k]}`);
      const steps = (p[k] - spec.min) / spec.step;
      assert(Math.abs(steps - Math.round(steps)) < 1e-6, `${k} landed off its step: ${p[k]}`);
    }
    assert(Number.isInteger(p.supportPolygonFloor), `a count came back fractional: ${p.supportPolygonFloor}`);
  }
});

check('zero percent changes nothing, and a key list limits what moves', () => {
  const same = perturb(BASE, SPECS, 0, seeded(3));
  for (const k of Object.keys(SPECS)) assert(same[k] === BASE[k], `${k} moved at 0%`);
  const one = perturb(BASE, SPECS, 0.5, seeded(3), ['speedScale']);
  assert(one.speedScale !== BASE.speedScale, 'the named knob did not move');
  for (const k of ['restepFraction', 'standExtension']) assert(one[k] === BASE[k], `${k} moved and was not asked to`);
});

// ===================== the objective =====================

check('cost prefers no risk, then prefers speed', () => {
  const h = (dragRisk, cycleSpeed) => ({ dragRisk, tapRisk: 0, cycleSpeed, legSpanLongest: 0.2 });
  assert(searchCost(h(0, 0.1)) < searchCost(h(0.5, 0.1)), 'risk should dominate');
  assert(searchCost(h(0, 0.2)) < searchCost(h(0, 0.1)), 'given equal risk, faster should win');
  // The trap this exists to close: without the speed term the cheapest answer is to stand still.
  assert(searchCost(h(0, 0.001)) > searchCost(h(0, 0.5)), 'crawling should not beat walking');
  assert(searchCost(null) === Infinity, 'no headroom should be infinitely bad');
});

check('cost is comparable across creature sizes', () => {
  // Same speed in leg spans per second, four times the animal. The costs must match, or the search would
  // chase absolute metres per second and always prefer the biggest creature's settings.
  const small = searchCost({ dragRisk: 0, tapRisk: 0, cycleSpeed: 0.1, legSpanLongest: 0.1 });
  const big = searchCost({ dragRisk: 0, tapRisk: 0, cycleSpeed: 0.4, legSpanLongest: 0.4 });
  assert(Math.abs(small - big) < 1e-9, `${small} vs ${big}`);
});

// ===================== the optimiser =====================

check('the optimiser finds a minimum it was not started at', () => {
  // A bowl with its floor away from the starting point, in two knobs at once.
  const target = { speedScale: 2.0, standExtension: 0.7 };
  const cost = (v) => (v.speedScale - target.speedScale) ** 2 + 4 * (v.standExtension - target.standExtension) ** 2;
  const r = optimise(BASE, SPECS, cost, { keys: ['speedScale', 'standExtension'] });
  assert(Math.abs(r.values.speedScale - target.speedScale) < 0.15, `speedScale landed at ${r.values.speedScale}`);
  assert(Math.abs(r.values.standExtension - target.standExtension) < 0.05, `standExtension landed at ${r.values.standExtension}`);
  assert(r.cost < cost(BASE), 'the result should beat the starting point');
});

check('the optimiser reports what it changed and how much it looked', () => {
  const r = optimise(BASE, SPECS, (v) => (v.speedScale - 2) ** 2, { keys: ['speedScale'] });
  assert(r.evaluations > 5, `only ${r.evaluations} evaluations`);
  assert(r.history.length && r.history.every(h => h.key === 'speedScale'), 'the history should name the knob');
  // Attributability is the reason for coordinate descent: every step names one knob.
  for (const h of r.history) assert(typeof h.to === 'number', 'a history step with no value');
});

check('the optimiser stops early when nothing improves', () => {
  let calls = 0;
  const r = optimise(BASE, SPECS, () => { calls++; return 1; }, { rounds: 20 });
  assert(r.cost === 1 && r.evaluations === calls, 'bookkeeping');
  // A flat landscape should give up after one fruitless round, not grind through twenty.
  assert(calls < 200, `a flat cost function cost ${calls} evaluations`);
});

check('the optimiser never leaves the sliders', () => {
  // A cost that rewards running away, so the only thing holding it in is the clamp.
  const r = optimise(BASE, SPECS, (v) => -v.speedScale - v.standExtension, { rounds: 12 });
  assert(r.values.speedScale <= SPECS.speedScale.max + 1e-9, 'left the top of the range');
  assert(r.values.standExtension <= SPECS.standExtension.max + 1e-9, 'left the top of the range');
});

// ===================== setpoint transfer =====================

check('a setpoint keeps everything within a species and drops the absolutes across one', () => {
  const values = { speedScale: 1.4, restepFraction: 0.9, footGround: 0.01, supportPolygonFloor: 3, worldHeight: 2 };
  const same = transferValues(values, { sameSpecies: true });
  assert(Object.keys(same.values).length === 5 && !same.dropped.length, 'nothing should be lost within a species');
  const cross = transferValues(values, { sameSpecies: false });
  assert(cross.values.speedScale === 1.4 && cross.values.restepFraction === 0.9, 'the fractions should carry');
  assert(cross.values.footGround === undefined && cross.values.worldHeight === undefined, 'the absolutes should not');
  assert(cross.dropped.length === 3 && cross.dropped.every(d => d.why), 'every drop should be explained');
});

// ===================== distance and provenance =====================

check('distance is measured per knob against its own range', () => {
  const a = { ...BASE }, b = { ...BASE, speedScale: 3 };
  const c = { ...BASE, standExtension: 1.0 };
  // speedScale moved 2.0 of a 2.8 range; standExtension moved 0.1 of a 0.4 range. In raw units the first
  // looks twenty times bigger; normalised it is under three times.
  const dab = tuningDistance(a, b, SPECS), dac = tuningDistance(a, c, SPECS);
  assert(dab > dac && dab / dac < 5, `normalisation did not happen: ${dab.toFixed(3)} vs ${dac.toFixed(3)}`);
  assert(tuningDistance(a, a, SPECS) === 0, 'a vector should be zero from itself');
});

check('changedKeys names only what moved', () => {
  const b = { ...BASE, speedScale: 1.5 };
  const changed = changedKeys(BASE, b, SPECS);
  assert(changed.length === 1 && changed[0] === 'speedScale', `got ${changed.join(',')}`);
});

// ===================== the trial log =====================

function memoryStore() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), map };
}

check('a trial round-trips through storage', () => {
  const store = memoryStore();
  const log = createTrialLog(store);
  log.add({ species: 'a', values: { speedScale: 1 }, metrics: { skate: 0.1 } });
  const again = createTrialLog(store);
  again.load();
  assert(again.rows.length === 1 && again.rows[0].values.speedScale === 1, 'the row did not survive');
  assert(again.rows[0].verdict === null, 'a fresh row should be unrated');
});

check('a row with no metrics is unrated, not broken', () => {
  // The point the design turns on: absent metrics are a state, and every consumer filters for them. What
  // must never happen is a row carrying the PREVIOUS settings' numbers, which is a different bug and is
  // handled by the window id the viewer stamps on each report.
  const log = createTrialLog(memoryStore());
  log.add({ species: 'a', values: { speedScale: 1 }, metrics: null });
  log.add({ species: 'a', values: { speedScale: 2 }, metrics: { skate: 0.2 }, verdict: 'better' });
  assert(log.list({ measured: true }).length === 1, 'the unmeasured row leaked into a measured query');
  assert(log.list({ rated: true }).length === 1, 'the unrated row leaked into a rated query');
  assert(log.rows.length === 2, 'both rows should still be kept');
});

check('the log caps itself oldest-first and says how many it dropped', () => {
  const log = createTrialLog(memoryStore(), { cap: 5 });
  for (let i = 0; i < 9; i++) log.add({ species: 'a', values: { speedScale: i } });
  assert(log.rows.length === 5, `cap not enforced: ${log.rows.length}`);
  assert(log.rows[0].values.speedScale === 4, 'the wrong end was dropped');
  assert(log.pruned === 4, `pruned count wrong: ${log.pruned}`);
});

check('a full quota does not take the session with it', () => {
  const store = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const log = createTrialLog(store);
  const res = log.add({ species: 'a', values: {} });
  assert(res.ok === false && res.error.includes('Quota'), 'the failure should be reported');
  assert(log.rows.length === 1, 'the row should still be in memory so it can be exported');
});

check('verdicts can be set after the fact', () => {
  const log = createTrialLog(memoryStore());
  const { row } = log.add({ species: 'a', values: {} });
  log.update(row.id, { verdict: 'better', note: 'legs looked right' });
  assert(log.rows[0].verdict === 'better' && log.rows[0].note === 'legs looked right', 'update failed');
  assert(log.update(9999, { verdict: 'worse' }) === null, 'updating a missing row should say so');
});

check('CSV carries every column any row has', () => {
  // The drift this catches: a knob added halfway through a session would otherwise be dropped from every
  // row, because the header was taken from the first one.
  const log = createTrialLog(memoryStore());
  log.add({ species: 'a', values: { speedScale: 1 }, metrics: { skate: 0.1 } });
  log.add({ species: 'a', values: { speedScale: 1, newKnob: 7 }, metrics: { skate: 0.2, tapRate: 0 } });
  const csv = toCSV(log.rows);
  const head = csv.split('\n')[0];
  assert(head.includes('set.newKnob') && head.includes('m.tapRate'), `late columns missing: ${head}`);
  assert(csv.split('\n').length === 3, 'wrong row count');
});

check('CSV escapes a note with a comma in it', () => {
  const log = createTrialLog(memoryStore());
  log.add({ species: 'a', values: {}, note: 'front legs, not back' });
  const csv = toCSV(log.rows);
  assert(csv.includes('"front legs, not back"'), `not escaped: ${csv}`);
});

check('the matrix normalises per knob and drops the ones nobody varied', () => {
  const rows = [
    { values: { speedScale: 0.2, standExtension: 0.9 } },
    { values: { speedScale: 3.0, standExtension: 0.9 } },
  ];
  const { keys, matrix } = tuningMatrix(rows, SPECS);
  assert(keys.includes('speedScale'), 'the knob that varied is missing');
  assert(!keys.includes('standExtension'), 'a constant column should be dropped');
  const col = keys.indexOf('speedScale');
  assert(Math.abs(matrix[0][col] - 0) < 1e-9 && Math.abs(matrix[1][col] - 1) < 1e-9,
    `range ends should map to 0 and 1, got ${matrix[0][col]} and ${matrix[1][col]}`);
});

check('the matrix is stable when a new trial arrives', () => {
  // The reason for normalising against the slider rather than against the trials: an existing point must
  // not move because somebody ran another trial. Under z-scoring every point would shift.
  const rows = [{ values: { speedScale: 1 } }, { values: { speedScale: 2 } }];
  const before = tuningMatrix(rows, SPECS).matrix[0][0];
  rows.push({ values: { speedScale: 3 } });
  const after = tuningMatrix(rows, SPECS).matrix[0][0];
  assert(before === after, `the first point moved from ${before} to ${after}`);
});

check('the eye and the machine can be lined up for a correlation', () => {
  const rows = [
    { verdict: 'better', metrics: { skate: 0.01 } },
    { verdict: 'worse', metrics: { skate: 0.30 } },
    { verdict: null, metrics: { skate: 0.10 } },
    { verdict: 'neutral', metrics: null },
  ];
  const s = verdictSeries(rows, 'skate');
  assert(s.n === 2, `expected only the rows with both, got ${s.n}`);
  assert(s.x[0] === 1 && s.x[1] === -1, 'verdicts should map to +1 and -1');
});

check('flattenMetrics survives having only one half', () => {
  assert(Object.keys(flattenMetrics(null, null)).length === 0, 'nothing in, nothing out');
  const onlyHeadroom = flattenMetrics(null, { dragRisk: 0.3, tapRisk: 0, stepFrames: 6 });
  assert(onlyHeadroom.dragRisk === 0.3 && onlyHeadroom.skate === undefined, 'prediction only');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
