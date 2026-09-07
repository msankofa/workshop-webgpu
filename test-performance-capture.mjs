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
    'terrainIntegrateMs', 'terrainQueued', 'forestReculls', 'grassReculls', 'pipelinesBuilt']);
  assert.deepEqual(rows[1], [16.4, 62.5, 47.9, 4.83, 3, 4.25, 7, 1, 1, 2], 'the dip row, in key order');
  assert.deepEqual(rows.map(r => r[0]), [0, 16.4, 78.9], 'order is preserved and tMs is the sample offset');
  assert.ok(rows.every(row => row.length === SERIES_KEYS.length && row.every(Number.isFinite)),
    'every row is numbers only, one per key');

  // A capture taken before atMs existed still lines up: tMs falls back to the running frame time.
  const older = buildPerformanceSeries([{ frameMs: 10 }, { frameMs: 20 }]);
  assert.deepEqual(older.map(r => r[0]), [10, 30], 'without atMs the rows carry the running elapsed time');
  assert.deepEqual(older[0], [10, 10, 0, 0, 0, 0, 0, 0, 0, 0], 'and missing fields read as zero, not undefined');

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
