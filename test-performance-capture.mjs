import assert from 'node:assert/strict';
import {
  buildPerformanceMeasurement,
  changedPerformanceSettings,
  summarizePerformanceSeries,
} from './performance-capture.mjs';

assert.deepEqual(summarizePerformanceSeries([1, 2, 3, 4]).average, 2.5);
assert.equal(summarizePerformanceSeries([1, 2, 100]).p95, 100);
assert.equal(summarizePerformanceSeries([10, 20], { integer: true }).average, 15);

const result = buildPerformanceMeasurement([
  { frameMs: 20, drawCalls: 100, triangles: 1000 },
  { frameMs: 20, drawCalls: 120, triangles: 1400 },
], {
  requestedWindowSeconds: 2,
  startedAt: 1000,
  finishedAt: 3000,
  droppedFramesStart: 4,
  droppedFramesEnd: 7,
});
assert.equal(result.fps.effective, 50);
assert.equal(result.frameMs.max, 20);
assert.equal(result.drawCalls.average, 110);
assert.equal(result.triangles.latest, 1400);
assert.equal(result.droppedFrames.duringCapture, 3);

assert.deepEqual(changedPerformanceSettings(
  { starsEnabled: true, sunIntensity: 4 },
  { starsEnabled: false, sunIntensity: 4 },
), [{ key: 'starsEnabled', before: true, after: false }]);

assert.throws(() => buildPerformanceMeasurement([]), /No rendered frames/);

// A capture taken before the caller sampled the new fields must still build, reading zero rather
// than NaN -- research/stats/base-game-performance-log.json is full of those older entries.
const legacy = buildPerformanceMeasurement([{ frameMs: 16, drawCalls: 10, triangles: 20 }], {});
assert.equal(legacy.renderCalls.max, 0);
assert.equal(legacy.pipelinesBuilt.max, 0);

// Pipeline arrivals: the max says a warmup is missing, and passes.frames says on how many frames.
const compiling = buildPerformanceMeasurement([
  { frameMs: 16, drawCalls: 10, triangles: 20, renderCalls: 2, pipelinesBuilt: 0, passes: { passPipelineMs: 0 } },
  { frameMs: 48, drawCalls: 10, triangles: 20, renderCalls: 2, pipelinesBuilt: 3, passes: { passPipelineMs: 31 } },
], {});
assert.equal(compiling.pipelinesBuilt.max, 3);
assert.equal(compiling.renderCalls.average, 2);
assert.equal(compiling.passes.passPipelineMs.frames, 1);
// Not sparse: the per-frame average is over the whole window, so it reads as the real frame cost.
assert.equal(compiling.passes.passPipelineMs.average, 15.5);

// The post buckets are sparse: exactly one of a pair is marked per frame, so a bucket is averaged
// over the frames that actually took that path. Averaged over all four here it would read 15.
const buckets = buildPerformanceMeasurement([
  { frameMs: 16, drawCalls: 1, triangles: 1, passes: { passPostShadowMs: 30, passPostNoShadowMs: 0 } },
  { frameMs: 16, drawCalls: 1, triangles: 1, passes: { passPostShadowMs: 0, passPostNoShadowMs: 10 } },
], {});
assert.equal(buckets.passes.passPostShadowMs.average, 30);
assert.equal(buckets.passes.passPostShadowMs.frames, 1);
assert.equal(buckets.passes.passPostNoShadowMs.average, 10);

console.log('Performance capture statistics tests passed.');

// Spike attribution: the slow frames and what they carried.
{
  const { summarizeSpikeEvents } = await import('./performance-capture.mjs');
  const samples = [];
  for (let i = 0; i < 40; i++) samples.push({ frameMs: 16, drawCalls: 1, triangles: 1, events: { terrainInstalls: 0, grassReculls: i % 2 } });
  samples.push({ frameMs: 90, drawCalls: 1, triangles: 1, events: { terrainInstalls: 3, grassReculls: 1 } });
  samples.push({ frameMs: 80, drawCalls: 1, triangles: 1, events: { terrainInstalls: 1, grassReculls: 0 } });
  samples.push({ frameMs: 70, drawCalls: 1, triangles: 1, events: { terrainInstalls: 0, grassReculls: 0 } });
  const spikes = summarizeSpikeEvents(samples);
  assert.ok(spikes.thresholdMs >= 16 && spikes.spikeFrames >= 3, `threshold ${spikes.thresholdMs}, ${spikes.spikeFrames} spikes`);
  assert.equal(spikes.events.terrainInstalls.spikeFrames, 2);
  assert.equal(spikes.events.terrainInstalls.otherFrames, 0);
  assert.equal(spikes.events.terrainInstalls.spikeTotal, 4);
  assert.ok(spikes.events.grassReculls.otherShare > 0.4 && spikes.events.grassReculls.otherShare < 0.6, 'grass reculls are a background event, half of ordinary frames');
  assert.equal(spikes.quietSpikeFrames, 1, 'one spike had no telling event');
  assert.deepEqual(spikes.tellingEvents, ['terrainInstalls'], 'an event on half the ordinary frames is not telling');
  assert.equal(summarizeSpikeEvents([{ frameMs: 16 }, { frameMs: 17 }]), null, 'no events, no attribution');
  const withEvents = buildPerformanceMeasurement(samples, {});
  assert.ok(withEvents.spikes && withEvents.spikes.events.terrainInstalls, 'the measurement carries the spike table');
  assert.equal(buildPerformanceMeasurement([{ frameMs: 16, drawCalls: 1, triangles: 1 }], {}).spikes, null);
  console.log('spike attribution: slow frames name the events they carried');
}

// The per-frame series: a saved capture keeps its frames, not only their summary.
{
  const { buildPerformanceSeries, SERIES_KEYS, summarizeSpikeEvents } = await import('./performance-capture.mjs');
  const samples = [
    { frameMs: 16.4, atMs: 0, speed: 0, passes: { passPostMs: 11.2 }, pipelinesBuilt: 0,
      events: { terrainInstalls: 0, terrainIntegrateMs: 0, terrainQueued: 0, forestReculls: 0, grassReculls: 1 } },
    { frameMs: 62.5, atMs: 16.4, speed: 4.83, passes: { passPostMs: 47.9 }, pipelinesBuilt: 2,
      events: { terrainInstalls: 3, terrainIntegrateMs: 4.25, terrainQueued: 7, forestReculls: 1, grassReculls: 1 } },
    { frameMs: 17.1, atMs: 78.9, speed: 4.8, passes: { passPostMs: 12 }, pipelinesBuilt: 0,
      events: { terrainInstalls: 0, terrainIntegrateMs: 0, terrainQueued: 5, forestReculls: 0, grassReculls: 0 } },
  ];
  const rows = buildPerformanceSeries(samples);
  assert.equal(rows.length, 3, 'one row per sample');
  assert.deepEqual(SERIES_KEYS, ['tMs', 'frameMs', 'postRenderMs', 'speed', 'terrainInstalls',
    'terrainIntegrateMs', 'terrainQueued', 'forestReculls', 'grassReculls', 'pipelinesBuilt',
    'betweenMs', 'longTaskMs', 'heapMB', 'terrainInFlight',
    'forestMs', 'grassMs', 'terrainMs', 'simMs', 'bodiesMs', 'skyMs']);
  assert.deepEqual(rows[1], [16.4, 62.5, 47.9, 4.83, 3, 4.25, 7, 1, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'the dip row, in key order');
  assert.deepEqual(rows.map(r => r[0]), [0, 16.4, 78.9], 'order is preserved and tMs is the sample offset');
  assert.ok(rows.every(row => row.length === SERIES_KEYS.length && row.every(Number.isFinite)),
    'every row is numbers only, one per key');

  // A capture taken before atMs existed still lines up: tMs falls back to the running frame time.
  const older = buildPerformanceSeries([{ frameMs: 10 }, { frameMs: 20 }]);
  assert.deepEqual(older.map(r => r[0]), [10, 30], 'without atMs the rows carry the running elapsed time');
  assert.deepEqual(older[0], [10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'and missing fields read as zero, not undefined');

  const measurement = buildPerformanceMeasurement(samples, {});
  assert.deepEqual(measurement.seriesKeys, SERIES_KEYS, 'the saved entry names the keys once');
  assert.equal(measurement.series.length, 3, 'and carries the rows');

  // Whether the dips are moving frames is now a number in the summary.
  const moving = [];
  for (let i = 0; i < 20; i++) moving.push({ frameMs: 16, speed: 0.2, events: { terrainInstalls: 0 } });
  for (let i = 0; i < 2; i++) moving.push({ frameMs: 70, speed: 5, events: { terrainInstalls: 2 } });
  const spikes = summarizeSpikeEvents(moving);
  assert.equal(spikes.speedInSpikes, 5, 'the spikes were moving frames');
  assert.equal(spikes.speedInOthers, 0.2, 'the ordinary ones were not');
  assert.equal(summarizeSpikeEvents([
    { frameMs: 16, events: { a: 0 } }, { frameMs: 16, events: { a: 0 } },
    { frameMs: 16, events: { a: 0 } }, { frameMs: 70, events: { a: 1 } },
  ]).speedInSpikes, null, 'no speed recorded, no claim made');
  console.log('per-frame series: the rows, their keys, and whether the dips were moving');
}

// Between the frames: the gap the page does not own, and what the browser called it.
{
  const { attachLongTasks, summarizeLongTasks, summarizeSpikeEvents, SERIES_KEYS, buildPerformanceSeries } =
    await import('./performance-capture.mjs');
  const startedAt = 1000;   // the capture's performance.now() origin
  // Three frames: a quiet one, a dip that a 48 ms long task runs into, and a quiet one after. A
  // sample's interval PRECEDES its atMs -- the dip below ran from 16 ms to 80 ms into the capture.
  const samples = [
    { frameMs: 16, atMs: 16, betweenMs: 7.4, heapMB: 512.5, passes: { passPostMs: 11 } },
    { frameMs: 64, atMs: 80, betweenMs: 41.2, heapMB: 540.25, passes: { passPostMs: 48 } },
    { frameMs: 17, atMs: 97, betweenMs: 8.1, heapMB: 541, passes: { passPostMs: 12 } },
  ];
  // In the page's timebase: starts at 1020 (20 ms into the capture), runs 48 ms to 1068.
  const longTasks = [
    { startTime: 1020, duration: 48, name: 'self', attribution: 'script terrain-worker.js' },
    { startTime: 900, duration: 30, name: 'self', attribution: 'unknown' },   // before the capture
  ];

  attachLongTasks(samples, longTasks, startedAt);
  assert.equal(samples[0].longTaskMs, 0, 'the quiet frame before the task overlaps nothing');
  assert.equal(samples[1].longTaskMs, 48, 'the dip frame is inside the task for its whole length');
  assert.equal(samples[2].longTaskMs, 0, 'and the frame after it is clear');

  // A task spanning two frames splits between them: intervals abut, so the halves add up to the
  // task and never to more than it.
  const split = [
    { frameMs: 20, atMs: 20 },
    { frameMs: 20, atMs: 40 },
  ];
  attachLongTasks(split, [{ startTime: startedAt + 10, duration: 20 }], startedAt);
  assert.equal(split[0].longTaskMs, 10);
  assert.equal(split[1].longTaskMs, 10, 'the halves add up to the task, one frame each');

  // The regression: variable frame lengths. Read forwards, these three rows overlap each other and
  // the task lands in the first two (60 and 10 ms of a 60 ms task). Read backwards, only the frame
  // that actually ran from 110 to 200 was inside it.
  const uneven = [
    { atMs: 100, frameMs: 100 },
    { atMs: 110, frameMs: 10 },
    { atMs: 200, frameMs: 90 },
  ];
  attachLongTasks(uneven, [{ startTime: 110, duration: 60 }], 0);
  assert.deepEqual(uneven.map(sample => sample.longTaskMs), [0, 0, 60],
    'a sample interval ends at its stamp, so the task belongs to the frame that ran through it');

  // Without atMs the fallback ends at the sample too, so the two agree.
  const noStamp = [{ frameMs: 100 }, { frameMs: 10 }, { frameMs: 90 }];
  attachLongTasks(noStamp, [{ startTime: 110, duration: 60 }], 0);
  assert.deepEqual(noStamp.map(sample => sample.longTaskMs), [0, 0, 60],
    'the running-sum fallback places frames the same way');

  const listed = summarizeLongTasks(longTasks, { startedAt, finishedAt: startedAt + 100 });
  assert.equal(listed.count, 1, 'a task that started before the capture is not in the window');
  assert.equal(listed.totalMs, 48);
  assert.deepEqual(listed.tasks[0], { tMs: 20, ms: 48, name: 'self', attribution: 'script terrain-worker.js' },
    'in the capture timebase, with the attribution the browser gave');
  assert.equal(summarizeLongTasks([], { startedAt }), null, 'no tasks, no section');
  const many = [];
  for (let i = 0; i < 150; i++) many.push({ startTime: startedAt + i, duration: 51 });
  const capped = summarizeLongTasks(many, { startedAt, finishedAt: startedAt + 1000 });
  assert.equal(capped.count, 150, 'the count is all of them');
  assert.equal(capped.listed, 100, 'the list is capped');

  const rows = buildPerformanceSeries(samples);
  assert.equal(rows[1][SERIES_KEYS.indexOf('tMs')], 80, 'the row is stamped at the end of its frame');
  assert.equal(rows[1][SERIES_KEYS.indexOf('betweenMs')], 41.2, 'the gap before the dip is a column');
  assert.equal(rows[1][SERIES_KEYS.indexOf('longTaskMs')], 48);
  assert.equal(rows[1][SERIES_KEYS.indexOf('heapMB')], 540.3, 'the heap, to a tenth of a megabyte');

  // The summary itself answers the question: did the dips wait longer, and was a long task running?
  const window = [];
  for (let i = 0; i < 20; i++) window.push({ frameMs: 16, betweenMs: 7, longTaskMs: 0, events: { terrainInstalls: 0 } });
  window.push({ frameMs: 70, betweenMs: 40, longTaskMs: 35, events: { terrainInstalls: 1 } });
  window.push({ frameMs: 66, betweenMs: 44, longTaskMs: 30, events: { terrainInstalls: 0 } });
  const spikes = summarizeSpikeEvents(window);
  assert.equal(spikes.meanBetweenInSpikes, 42, 'the dips waited 42 ms before they started');
  assert.equal(spikes.meanBetweenInOthers, 7, 'the ordinary frames waited 7');
  assert.equal(spikes.longTaskSpikeFrames, 2, 'and both dips had a long task running into them');
  assert.equal(spikes.longTaskOtherFrames, 0);
  assert.equal(summarizeSpikeEvents([
    { frameMs: 16, events: { a: 0 } }, { frameMs: 16, events: { a: 0 } },
    { frameMs: 16, events: { a: 0 } }, { frameMs: 70, events: { a: 1 } },
  ]).meanBetweenInSpikes, null, 'nothing recorded, nothing claimed');

  const measurement = buildPerformanceMeasurement(samples, { startedAt, finishedAt: startedAt + 120, longTasks });
  assert.equal(measurement.longTasks.count, 1, 'the saved entry carries the long tasks of the window');
  assert.equal(measurement.series[1][SERIES_KEYS.indexOf('longTaskMs')], 48, 'and the rows carry the overlap');
  console.log('between frames: the gap, the long tasks in it, and the heap');
}

// Which pass the dip is made of: the slots, in the rows and in the summary.
{
  const { buildPerformanceSeries, SERIES_KEYS, summarizeSpikeEvents } = await import('./performance-capture.mjs');
  const quiet = () => ({ forestGpu: 2.1, grassGpu: 1.4, terrain: 0.9, playerSim: 0.8, bodies: 1.2, sky: 0.3, water: 0.4 });
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ frameMs: 16, atMs: (i + 1) * 16, slots: quiet(), events: { terrainInstalls: 0 } });
  // Two dips: the forest slot is what inflates, terrain moves a little, the rest do not move.
  samples.push({ frameMs: 70, atMs: 336, slots: { ...quiet(), forestGpu: 44, terrain: 4 }, events: { terrainInstalls: 1 } });
  samples.push({ frameMs: 66, atMs: 402, slots: { ...quiet(), forestGpu: 38, terrain: 6 }, events: { terrainInstalls: 0 } });

  const rows = buildPerformanceSeries(samples);
  const at = key => SERIES_KEYS.indexOf(key);
  assert.equal(rows.at(-2)[at('forestMs')], 44, 'the forest slot is a column of its own');
  assert.equal(rows.at(-2)[at('terrainMs')], 4);
  assert.equal(rows.at(-2)[at('simMs')], 0.8);
  assert.equal(rows.at(-2)[at('skyMs')], 0.3);
  assert.equal(rows[0][at('forestMs')], 2.1, 'and an ordinary frame carries it too');
  assert.equal(rows[0].length, SERIES_KEYS.length, 'every row is still one number per key');

  const spikes = summarizeSpikeEvents(samples);
  assert.equal(spikes.slots.forestGpu.meanInSpikes, 41, 'the forest averages 41 ms in the dips');
  assert.equal(spikes.slots.forestGpu.meanInOthers, 2.1, 'against 2.1 in the ordinary frames');
  assert.equal(spikes.slots.terrain.meanInSpikes, 5, 'terrain moves, but by a little');
  assert.equal(spikes.slots.sky.meanInSpikes, spikes.slots.sky.meanInOthers, 'a slot that does not move says so');
  assert.ok(spikes.slots.water, 'a slot outside the series columns is still in the summary');
  assert.equal(summarizeSpikeEvents([
    { frameMs: 16, events: { a: 0 } }, { frameMs: 16, events: { a: 0 } },
    { frameMs: 16, events: { a: 0 } }, { frameMs: 70, events: { a: 1 } },
  ]).slots, null, 'no slots recorded, no slot table');
  console.log('pass slots: the rows carry the six busiest passes and the summary names which one inflates');
}
