// takeMetrics, extracted from the real bot-trace-viewer.html so the diff panel's numbers are tested
// rather than eyeballed.
//
// The property that actually matters here is dwell weighting. The recorder emits a row on every state
// change PLUS a ~1 s heartbeat, so rows are not evenly spaced in time -- a bot thrashing between two
// states emits extra rows without having stood there any longer. Every fixture below is built so that
// counting rows and weighting by dwell time give DIFFERENT answers, and asserts the dwell answer. If
// someone "simplifies" this back to a row count, these tests fail instead of quietly reporting
// "busy state machine" under the label "time spent".
import assert from 'node:assert';
import fs from 'node:fs';

const base = 'G:/My Drive/Scripts/procedural-creature/workshop-webgpu/';
const src = fs.readFileSync(base + 'bot-trace-viewer.html', 'utf8');

function grab(startsWith) {
  const i = src.indexOf(startsWith);
  if (i < 0) throw new Error('not found in viewer: ' + startsWith);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + startsWith);
}

// Same constants the viewer uses; pulled from the source so a change there reaches this test.
const GAP_HOLD_MS = Number(/const GAP_HOLD_MS = (\d+)/.exec(src)[1]);
const STILL_SPEED = Number(/const STILL_SPEED = ([\d.]+)/.exec(src)[1]);
const LOCO_SRC = /const LOCO = new Set\((\[[^\]]*\])\)/.exec(src)[1];
assert.ok(GAP_HOLD_MS > 0 && STILL_SPEED > 0, 'constants must come from the viewer, not be guessed');

const takeMetrics = new Function('GAP_HOLD_MS', 'STILL_SPEED', 'LOCO', `
  const isStalled = row => LOCO.has(row.stateChar) && (row.speed ?? 0) < STILL_SPEED;
  ${grab('function takeMetrics(rows)')}
  return takeMetrics;
`)(GAP_HOLD_MS, STILL_SPEED, new Set(JSON.parse(LOCO_SRC.replace(/'/g, '"'))));

const row = (o) => ({
  t: 0, id: 'bot-1', team: 'alpha', stateChar: 'P', speed: 0, pathMode: '',
  targetId: '', visGate: '', targetDist: null, ...o,
});

// 1. Dwell weighting, not sample counting.
// One bot: stalled at t=0,100,200 then moving at t=2200 (its last row).
//   dwell   0 ->  100 ms stalled
//         100 ->  100 ms stalled
//         200 -> 2000 ms stalled
//        2200 -> 1000 ms moving  (last row is credited one heartbeat)
// dwell-weighted stalled share = 2200 / 3200 = 68.75 %
// row-counted stalled share    =    3 /    4 = 75 %
{
  const rows = [
    row({ t: 0, speed: 0 }), row({ t: 100, speed: 0 }), row({ t: 200, speed: 0 }),
    row({ t: 2200, speed: 5 }),
  ];
  const m = takeMetrics(rows);
  assert.ok(Math.abs(m['stalled %'] - 68.75) < 1e-6,
    `expected the dwell-weighted 68.75%, got ${m['stalled %']} (75% would mean it is counting rows)`);
  assert.notStrictEqual(Math.round(m['stalled %']), 75, 'a row count would give 75% -- that is the bug');
  assert.ok(Math.abs(m['bot-seconds'] - 3) < 0.51, `bot-seconds ~3.2, got ${m['bot-seconds']}`);
  console.log(`ok  stalled % is dwell-weighted (${m['stalled %'].toFixed(2)}%, not the 75% a row count gives)`);
}

// 2. A gap longer than GAP_HOLD_MS is clamped: we do not know the bot stayed there, so crediting the
//    whole gap would invent dwell out of a recording pause.
{
  const rows = [row({ t: 0, speed: 5 }), row({ t: 0 + GAP_HOLD_MS * 4, speed: 5 })];
  const m = takeMetrics(rows);
  const expect = GAP_HOLD_MS / 1000 + 1;   // clamped first row + one heartbeat for the last
  assert.ok(Math.abs(m['bot-seconds'] - expect) < 0.51,
    `expected ~${expect}s after clamping, got ${m['bot-seconds']}`);
  console.log(`ok  a ${GAP_HOLD_MS * 4} ms gap is clamped to ${GAP_HOLD_MS} ms rather than credited whole`);
}

// 3. The shared-fallback-target signature: many bots holding ONE enemy. This is the metric that would
//    have made the original bug obvious, so it has to be sensitive to exactly that shape.
{
  const shared = [
    row({ id: 'bot-1', targetId: 'bot-9', visGate: 'y' }),
    row({ id: 'bot-2', targetId: 'bot-9', visGate: 'n' }),
    row({ id: 'bot-3', targetId: 'bot-9', visGate: 'n' }),
    row({ id: 'bot-4', targetId: 'bot-7', visGate: 'y' }),
  ];
  const spread = [
    row({ id: 'bot-1', targetId: 'bot-9', visGate: 'y' }),
    row({ id: 'bot-2', targetId: 'bot-8', visGate: 'y' }),
    row({ id: 'bot-3', targetId: 'bot-7', visGate: 'y' }),
    row({ id: 'bot-4', targetId: 'bot-6', visGate: 'y' }),
  ];
  const a = takeMetrics(shared), b = takeMetrics(spread);
  assert.ok(Math.abs(a['top target share %'] - 75) < 1e-6, `expected 75%, got ${a['top target share %']}`);
  assert.ok(Math.abs(b['top target share %'] - 25) < 1e-6, `expected 25%, got ${b['top target share %']}`);
  assert.ok(a['top target share %'] > b['top target share %'] * 2,
    'the collapsed case must read far higher than the healthy one');
  console.log(`ok  top target share separates collapse (${a['top target share %']}%) from spread (${b['top target share %']}%)`);
}

// 4. vis_gate shares are over TARGET rows, not all rows: "% of engagements blocked" is the question.
{
  const rows = [
    row({ id: 'bot-1', targetId: 'bot-9', visGate: 'n' }),
    row({ id: 'bot-2', targetId: 'bot-9', visGate: 'y' }),
    row({ id: 'bot-3' }),   // no target at all -- must not dilute the shares below
  ];
  const m = takeMetrics(rows);
  assert.ok(Math.abs(m['sight blocked %'] - 50) < 1e-6,
    `expected 50% of the two targeting rows, got ${m['sight blocked %']}`);
  assert.ok(Math.abs(m['sight clear %'] - 50) < 1e-6, `expected 50%, got ${m['sight clear %']}`);
  console.log('ok  vis_gate shares are over targeting rows only');
}

// 5. A bot already dead in its first row is not a death event (same rule load() applies), and a
//    corpse spends no dwell time.
{
  const alwaysDead = [row({ id: 'bot-1', stateChar: 'D' }), row({ id: 'bot-1', t: 500, stateChar: 'D' })];
  assert.strictEqual(takeMetrics(alwaysDead).deaths, 0, 'already-dead at t0 is not a death');
  const died = [row({ id: 'bot-1', stateChar: 'P', speed: 5 }), row({ id: 'bot-1', t: 500, stateChar: 'D' })];
  assert.strictEqual(takeMetrics(died).deaths, 1, 'a live->dead transition is one death');
  assert.ok(takeMetrics(alwaysDead)['bot-seconds'] === 0, 'a corpse accrues no bot-seconds');
  console.log('ok  deaths count transitions only, and corpses accrue no time');
}

// 6. Empty / degenerate input must yield nulls rather than NaN, because NaN renders as a number and
//    silently reads as a real measurement in the diff table.
{
  const m = takeMetrics([row({ id: 'bot-1', stateChar: 'D' })]);
  for (const k of ['stalled %', 'fire:aim', 'median target m', 'top target share %', 'sight clear %']) {
    assert.ok(m[k] === null || Number.isFinite(m[k]), `${k} must be null or finite, got ${m[k]}`);
    assert.ok(!Number.isNaN(m[k]), `${k} must never be NaN`);
  }
  console.log('ok  degenerate takes yield null, never NaN');
}

console.log('\nall trace-viewer metric tests passed');
