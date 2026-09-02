// test-base-game-frame-cap.mjs — the frame cap's pacing, lifted out of base-game.html.
//
// The cap is four lines inside the page, and every one of them is a place a naive version goes
// wrong: a 60 cap that halves to 30 on a 60 Hz screen because of vsync jitter, a "last frame plus a
// period" deadline that drifts below the cap it was asked for, or a resume after a tab switch that
// fires a burst of frames to catch up. So the function is extracted and driven directly here.
import { readFile } from 'fs/promises';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ', m); } else { fail++; console.log('FAIL', m); } };

const html = await readFile('./base-game.html', 'utf8');
const source = html.match(/(let frameCapNext = 0[\s\S]*?\n\}\n)/)?.[1];
ok(!!source, 'the frame cap block was found in the page');

// One instance per test, so a grid left over from one case cannot pace the next.
function makeCap() {
  const settings = { frameCap: 'unlimited', frameCapSnap: false };
  const holds = new Function('settings', `${source}\nreturn frameCapHolds;`)(settings);
  return { settings, holds };
}

// Drive `seconds` of a display running at `refreshHz`, returning the times frames actually ran.
function run({ frameCap, refreshHz, seconds, jitterMs = 0, startAt = 0, snap = false }) {
  const { settings, holds } = makeCap();
  settings.frameCap = frameCap;
  settings.frameCapSnap = snap;
  const step = 1000 / refreshHz;
  const ran = [];
  let jitter = 0;
  for (let i = 0; i * step < seconds * 1000; i++) {
    // Deterministic sawtooth jitter: real vsync wobble, no Math.random in a test.
    jitter = jitterMs === 0 ? 0 : ((i % 5) - 2) / 2 * jitterMs;
    const now = startAt + i * step + jitter;
    if (!holds(now)) ran.push(now);
  }
  return ran;
}

const rate = (ran, seconds) => ran.length / seconds;

// ---- 1. unlimited is the pass-through ------------------------------------------------------------
{
  const ran = run({ frameCap: 'unlimited', refreshHz: 144, seconds: 2 });
  ok(rate(ran, 2) > 143, `unlimited runs every frame the display offers (${rate(ran, 2).toFixed(1)} of 144)`);
}

// ---- 2. each cap holds the rate it names ---------------------------------------------------------
// Measured over a 144 Hz display, where every cap is a real division of the refresh.
for (const [cap, want] of [['60', 60], ['45', 45], ['30', 30]]) {
  const ran = run({ frameCap: cap, refreshHz: 144, seconds: 4 });
  const got = rate(ran, 4);
  ok(Math.abs(got - want) <= 1, `a ${cap} cap runs at ${got.toFixed(1)} fps on a 144 Hz display`);
}

// ---- 3. THE JITTER CASE: a 60 cap on a 60 Hz screen ----------------------------------------------
// The reason for the half-a-display-frame of slack. A frame that arrives 0.4 ms early is the frame
// this cap is for; without the slack it is held, the next one is 16.7 ms later, and the page runs at
// 30 fps having been asked for 60.
{
  const strict = run({ frameCap: '60', refreshHz: 60, seconds: 4, jitterMs: 2 });
  ok(rate(strict, 4) > 58, `a 60 cap on a jittery 60 Hz display stays at 60 (${rate(strict, 4).toFixed(1)}), not 30`);
  const under = run({ frameCap: '60', refreshHz: 45, seconds: 4 });
  ok(rate(under, 4) > 44, `and a cap above what the display can do never throttles it further (${rate(under, 4).toFixed(1)} of 45)`);
}

// ---- 4. the deadline is a grid, not an accumulation ----------------------------------------------
// "Deadline = now + period" would add each frame's own arrival lateness to the next gap, so a 30 cap
// on a 144 Hz display would settle a little under 30 and keep sliding. The grid does not.
{
  const ran = run({ frameCap: '30', refreshHz: 144, seconds: 20 });
  const first = ran.slice(0, 30), last = ran.slice(-30);
  const spanFirst = (first.at(-1) - first[0]) / (first.length - 1);
  const spanLast = (last.at(-1) - last[0]) / (last.length - 1);
  ok(Math.abs(spanLast - spanFirst) < 0.5,
    `the gap at second 20 matches the gap at second 0 (${spanFirst.toFixed(2)} vs ${spanLast.toFixed(2)} ms): no drift`);
  ok(rate(ran, 20) > 29.5, `and twenty seconds in it is still 30 fps (${rate(ran, 20).toFixed(2)})`);
}

// ---- 5. a stall resyncs rather than firing a burst -----------------------------------------------
// A tab switch, a long shader compile, a breakpoint. The grid is behind by seconds; running every
// missed frame back to back would be a stutter storm on resume, which is what the resync avoids.
{
  const { settings, holds } = makeCap();
  settings.frameCap = '30';
  for (let i = 0; i < 20; i++) holds(i * (1000 / 144));
  const afterStall = [];
  for (let i = 0; i < 10; i++) { const now = 30000 + i * (1000 / 144); if (!holds(now)) afterStall.push(now); }
  // Ten frames at 144 Hz span 69 ms, which is two 30 fps periods: two is the cap working, not a burst.
  ok(afterStall.length <= 2, `a 30 s stall resumes on the cap rather than firing a burst (${afterStall.length} of 10 ran)`);
  ok(afterStall.length >= 1, 'and it does resume: the stalled grid does not hold the page off');
}

// ---- 6. changing the cap takes effect on the next frame ------------------------------------------
{
  const { settings, holds } = makeCap();
  settings.frameCap = '30';
  for (let i = 0; i < 100; i++) holds(i * (1000 / 144));
  settings.frameCap = 'unlimited';
  let ran = 0;
  for (let i = 100; i < 200; i++) if (!holds(i * (1000 / 144))) ran++;
  ok(ran === 100, `lifting the cap releases every frame immediately (${ran} of 100)`);
  settings.frameCap = '60';
  let capped = 0;
  for (let i = 200; i < 344; i++) if (!holds(i * (1000 / 144))) capped++;
  ok(Math.abs(capped - 60) <= 1, `and re-capping starts a fresh grid rather than the stale one (${capped} in a second)`);
}

// ---- 7. a cap that does not divide the display rate, with and without snapping ------------------
// The 2026-08-30 captures: a 45 cap on the 75 Hz display averaged 45-49 fps with a frame-time p50
// of 26.6 ms, because the grid can only alternate one refresh (13.3 ms) and two (26.7 ms). Snapping
// trades the number for a steady one: 37.5, the nearest exact division.
{
  const gaps = (ran) => ran.slice(1).map((t, i) => t - ran[i]);
  const plain = run({ frameCap: '45', refreshHz: 75, seconds: 4 });
  const plainGaps = gaps(plain);
  ok(Math.abs(rate(plain, 4) - 45) <= 1.5, `unsnapped, a 45 cap on a 75 Hz display averages 45 (${rate(plain, 4).toFixed(1)})`);
  ok(Math.max(...plainGaps) / Math.min(...plainGaps) > 1.8,
    `but it alternates one and two refreshes (${Math.min(...plainGaps).toFixed(1)} and ${Math.max(...plainGaps).toFixed(1)} ms): the judder the captures showed`);
  // The display-rate estimate is a slow EMA seeded at 60 Hz (it takes ~40 frames to settle, and a
  // page has run for minutes before anyone toggles this), so the snapped cases measure the last
  // four seconds of six.
  const settled = (frameCap, refreshHz) => run({ frameCap, refreshHz, seconds: 6, snap: true }).filter(t => t >= 2000);
  const snapped = settled('45', 75);
  const snappedGaps = gaps(snapped);
  ok(Math.abs(rate(snapped, 4) - 37.5) <= 0.5, `snapped, the same cap runs at 37.5 (${rate(snapped, 4).toFixed(1)}), the nearest division of 75`);
  ok(Math.max(...snappedGaps) - Math.min(...snappedGaps) < 0.5,
    `and every gap is the same (${Math.min(...snappedGaps).toFixed(1)}..${Math.max(...snappedGaps).toFixed(1)} ms): no alternation`);
  const sixty = settled('60', 75);
  ok(rate(sixty, 4) > 74, `a snapped 60 cap on 75 Hz goes to the display rate, the nearest division (${rate(sixty, 4).toFixed(1)})`);
  const thirty = settled('30', 144);
  ok(Math.abs(rate(thirty, 4) - 28.8) <= 0.5, `and on 144 Hz a snapped 30 becomes 28.8, one frame in five (${rate(thirty, 4).toFixed(1)})`);
  ok(/frameCapSnap: false,/.test(html) && /addToggle\(captureSec, 'frameCapSnap'/.test(html), 'the snap is a toggle in Performance Capture, off by default: the plain cap stays available');
}

// ---- 8. the page wires it where it belongs -------------------------------------------------------
{
  ok(/frameCap: 'unlimited',/.test(html), 'the page ships uncapped: a cap is something you ask for');
  ok(/frameCap: \['unlimited', '60', '45', '30'\],/.test(html), 'and the four values are validated on load like every other string setting');
  ok(/if \(frameBusy\) \{ frameProfiler\.markDropped\(\); return; \}\n\s*if \(frameCapHolds/.test(html),
    'the cap is checked AFTER the busy check, so a held frame is never counted as a dropped one');
  ok(/addSelect\(captureSec, 'frameCap'/.test(html),
    'the control sits in Performance Capture, where a capture also records the cap it ran under');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
