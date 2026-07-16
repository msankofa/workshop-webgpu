// Pure-logic tests for the creature stats panel's data shaping (no browser/DOM).
// Run: node test-creature-stats.mjs
import { extractFeatures, toCsv, histogram } from './creature-stats.js';

let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name); }
}

// --- extractFeatures: a mock creature exercising every field path ---
const mockCreature = {
  legs: [
    { row: 0, segments: [{}, {}, {}] },
    { row: 0, segments: [{}, {}, {}] },
    { row: 1, segments: [{}, {}, {}] },
    { row: 1, segments: [{}, {}, {}] },
  ],
  plan: { bodyScale: { x: 0.7, y: 0.4, z: 1.1 }, bodyHeight: 1.05 },
  gait: { maxSpeed: 1.4, stepDuration: 0.18, stepLift: 0.22, comfort: { h: 0.9 }, maxConcurrentFraction: 0.4 },
  armSettings: { count: 2 },
  health: 80, teamId: 1,
  metrics: {
    speedAvg: 0.9, maxSpeed: 1.4, effAvg: 0.5,
    headingErrAvg: Math.PI / 2, groundedAvg: 0.75, stallFrac: 0.1, distance: 12.5, simTime: 30,
  },
};
const f = extractFeatures(mockCreature);
check('legs count', f.legs === 4);
check('segsPerLeg', f.segsPerLeg === 3);
check('legPairs (distinct rows)', f.legPairs === 2);
check('bodyW/H/D', f.bodyW === 0.7 && f.bodyH === 0.4 && f.bodyD === 1.1);
check('gait maxSpeed', f.maxSpeedCfg === 1.4);
check('armCount', f.armCount === 2);
check('speedAvg passthrough', f.speedAvg === 0.9);
check('effPct = effAvg*100', approx(f.effPct, 50));
check('headingErrDeg = rad*180/PI', approx(f.headingErrDeg, 90));
check('groundedPct', approx(f.groundedPct, 75));
check('stallPct', approx(f.stallPct, 10));
check('distance passthrough', f.distance === 12.5);

// --- robustness: missing/partial creature must not throw or NaN ---
const bare = extractFeatures({});
check('empty creature -> zeros, no NaN', bare.legs === 0 && bare.speedAvg === 0 && !Number.isNaN(bare.effPct));

// --- toCsv: header, row count, escaping ---
const db = [
  { id: 1, label: '#1 4L·3s', t: 100, ...f },
  { id: 2, label: 'has,comma', t: 200, ...bare },
];
const csv = toCsv(db);
const lines = csv.split('\n');
check('csv header starts id,label,t', lines[0].startsWith('id,label,t,'));
check('csv row count = 1 header + 2 rows', lines.length === 3);
check('csv quotes field with comma', lines[2].includes('"has,comma"'));

// --- histogram: binning correctness ---
const h1 = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 10);
check('hist span min/max', h1.min === 0 && h1.max === 9);
check('hist total count preserved', h1.counts.reduce((a, b) => a + b, 0) === 10);
const h2 = histogram([5, 5, 5], 4);
check('hist all-equal -> all in one bin', h2.counts.reduce((a, b) => a + b, 0) === 3);
const h3 = histogram([], 5);
check('hist empty -> zero counts', h3.counts.length === 5 && h3.counts.every(c => c === 0));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
