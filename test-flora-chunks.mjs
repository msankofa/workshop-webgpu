// test-flora-chunks.mjs — plants plan F4: the windowed chunk host.
// node test-flora-chunks.mjs

import { createFloraChunks } from './flora-chunks.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

function host(opts = {}) {
  const h = createFloraChunks({ chunkSize: 32, radiusChunks: 2, budgetChunks: 100, budgetMs: 1e9, ...opts });
  const built = [], cleared = [];
  h.onBuild(chunk => built.push(chunk.key));
  h.onClear(key => cleared.push(key));
  return { h, built, cleared };
}
// A monotonic clock the test controls, so budgets are tested rather than raced.
function fakeClock(startMs = 0, stepMs = 0) {
  let t = startMs;
  return () => { const now = t; t += stepMs; return now; };
}

section('the window');
{
  const { h, built } = host();
  check('the first sync queues work', h.syncToFocus(0, 0) === true);
  h.drain();
  check('a radius-2 window is 25 chunks', built.length === 25, `built ${built.length}`);
  // At the exact corner of four chunks every neighbour is equidistant, so this asks from a
  // chunk centre where "nearest" has one answer.
  const c = host();
  c.h.syncToFocus(16, 16); c.h.drain();
  check('the nearest chunk is built first', c.built[0] === c.h.keyFor(0, 0), `first ${c.built[0]}`);
  check('a second sync at the same cell does nothing', h.syncToFocus(4, 4) === false);
  check('and costs no rebuild', h.drain() === 0);
}

section('crossing a cell boundary');
{
  const { h, built, cleared } = host();
  h.syncToFocus(0, 0); h.drain();
  built.length = 0;
  check('moving inside the cell is free', h.syncToFocus(31, 0) === false);
  check('crossing it re-syncs', h.syncToFocus(33, 0) === true);
  h.drain();
  check('only the new column is built', built.length === 5, `built ${built.length}: ${built.join(' ')}`);
  check('and the far column is cleared', cleared.length === 5, `cleared ${cleared.length}`);
  check('resident is still one window', h.stats.resident === 25, `resident ${h.stats.resident}`);
  check('nothing is both resident and cleared', !cleared.some(key => h.has(key)));
}

section('budgets');
{
  const { h, built } = host({ budgetChunks: 3, budgetMs: 1e9 });
  h.syncToFocus(0, 0);
  check('one drain builds at most the chunk budget', h.drain() === 3 && built.length === 3);
  h.drain(); h.drain();
  check('the rest arrive over later frames', built.length === 9);
  let n = 0;
  while (h.stats.queued) { h.drain(); if (++n > 50) break; }
  check('the queue finishes', h.stats.queued === 0 && built.length === 25);

  // The millisecond budget stops a slow frame even when the chunk budget would allow more.
  const slow = host({ budgetChunks: 100, budgetMs: 5 });
  slow.h.syncToFocus(0, 0);
  const stopped = slow.h.drain({ now: fakeClock(0, 3) });
  check('the time budget stops the build early', stopped > 0 && stopped < 25, `built ${stopped}`);
  check('a drain-all ignores the budget', slow.h.drain({ drain: true, now: fakeClock(0, 3) }) === 25 - stopped);
}

section('readiness deferral');
{
  const { h, built } = host();
  const ready = new Set();
  h.setReadyTest(chunk => ready.has(chunk.key));
  h.syncToFocus(0, 0);
  check('nothing builds while no field is resident', h.drain() === 0 && built.length === 0);
  check('but the work is still queued', h.stats.queued === 25, `queued ${h.stats.queued}`);
  check('deferral is counted, not silent', h.stats.deferrals > 0);

  // A deferred pass must not spin forever inside one frame.
  const before = h.stats.deferrals;
  h.drain();
  check('a second attempt is bounded', h.stats.deferrals - before <= 26, `${h.stats.deferrals - before} tries`);

  ready.add(h.keyFor(0, 0));
  h.drain();
  check('the ready chunk builds', built.includes(h.keyFor(0, 0)));
  check('and the rest stay queued', h.stats.queued === 24, `queued ${h.stats.queued}`);

  for (const key of h.residentKeys) ready.add(key);
  for (let i = 0; i < 25; i++) ready.add(h.keyFor(i % 5 - 2, Math.floor(i / 5) - 2));
  let guard = 0;
  while (h.stats.queued && guard++ < 60) h.drain();
  check('everything lands once its field arrives', h.stats.queued === 0 && built.length === 25, `built ${built.length}`);
}

section('rebuild and radius');
{
  const { h, built, cleared } = host();
  h.syncToFocus(0, 0); h.drain();
  built.length = 0; cleared.length = 0;
  h.rebuildAll(0, 0);
  h.drain();
  check('a rebuild clears every resident chunk', cleared.length === 25, `cleared ${cleared.length}`);
  check('and builds them again', built.length === 25, `built ${built.length}`);
  check('nothing leaked between the queues', h.stats.queued === 0 && h.stats.resident === 25);

  check('changing the radius invalidates the window', h.setRadiusChunks(1) === true);
  check('the same radius is a no-op', h.setRadiusChunks(1) === false);
  cleared.length = 0; built.length = 0;
  h.syncToFocus(0, 0);
  h.drain();
  check('shrinking clears the outer ring', cleared.length === 16 && h.stats.resident === 9, `cleared ${cleared.length}, resident ${h.stats.resident}`);

  h.clear();
  h.drain();
  check('clear() empties the host', h.stats.resident === 0 && h.stats.queued === 0);
}

section('no work, no allocation path');
{
  const { h } = host();
  h.syncToFocus(0, 0);
  h.drain();
  const before = { ...h.stats };
  for (let i = 0; i < 100; i++) { h.syncToFocus(1, 1); h.drain(); }
  check('a hundred idle frames change nothing', h.stats.built === before.built && h.stats.cleared === before.cleared && h.stats.syncs === before.syncs);
}

section('a build that pauses at its deadline');
{
  const h = createFloraChunks({ chunkSize: 32, radiusChunks: 1, budgetChunks: 100, budgetMs: 5 });
  const calls = [], abandoned = [];
  // Every chunk needs three calls: the first two report "not finished".
  const progress = new Map();
  h.onBuild((chunk, deadline) => {
    calls.push(chunk.key);
    const n = (progress.get(chunk.key) ?? 0) + 1;
    progress.set(chunk.key, n);
    if (!Number.isFinite(deadline)) return true;          // a drain-all finishes in one call
    return n >= 3 ? true : false;
  });
  h.onAbandon(chunk => abandoned.push(chunk.key));
  h.syncToFocus(0, 0);
  check('the first drain builds nothing yet', h.drain({ now: fakeClock(0, 1) }) === 0 && h.stats.pausedBuilds === 1);
  check('the paused chunk is not resident', h.stats.resident === 0 && h.pendingKey !== null);
  const first = h.pendingKey;
  h.drain({ now: fakeClock(0, 1) });
  check('the second drain resumes the same chunk and starts no other', calls.length === 2 && calls[0] === calls[1] && h.pendingKey === first);
  check('the third completes it and moves on within the budget', h.drain({ now: fakeClock(0, 1) }) >= 1 && h.has(first) && h.stats.pausedBuilds >= 2);
  // A window move that drops the pending chunk abandons it once, and never queues it twice.
  const pendingBefore = h.pendingKey;
  h.syncToFocus(5000, 5000);
  check('a move away abandons the paused build', pendingBefore === null || (abandoned.length === 1 && abandoned[0] === pendingBefore && h.pendingKey === null));
  const queuedKeys = new Set();
  let dup = false;
  h.syncToFocus(0, 0);
  for (let i = 0; i < 60 && (h.stats.queued || h.pendingKey); i++) h.drain({ now: fakeClock(0, 1) });
  for (const k of h.residentKeys) { if (queuedKeys.has(k)) dup = true; queuedKeys.add(k); }
  check('every chunk ends up resident exactly once', !dup && h.stats.resident === 9, `resident ${h.stats.resident}`);
  check('a drain-all finishes a paused build synchronously', (() => {
    const g = createFloraChunks({ chunkSize: 32, radiusChunks: 1, budgetChunks: 100, budgetMs: 5 });
    let n = 0;
    g.onBuild((chunk, deadline) => Number.isFinite(deadline) ? (++n % 2 === 0) : true);
    g.syncToFocus(0, 0);
    g.drain({ now: fakeClock(0, 1) });
    const paused = g.pendingKey !== null;
    g.drain({ drain: true, now: fakeClock(0, 1) });
    return paused && g.pendingKey === null && g.stats.resident === 9;
  })());
  check('clear() abandons the paused build', (() => {
    const g = createFloraChunks({ chunkSize: 32, radiusChunks: 1, budgetChunks: 100, budgetMs: 5 });
    const dropped = [];
    g.onBuild(() => false);
    g.onAbandon(c => dropped.push(c.key));
    g.syncToFocus(0, 0); g.drain({ now: fakeClock(0, 1) });
    g.clear();
    return dropped.length === 1 && g.pendingKey === null;
  })());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
