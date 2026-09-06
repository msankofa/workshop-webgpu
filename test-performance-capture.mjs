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
