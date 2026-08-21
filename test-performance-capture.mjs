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
console.log('Performance capture statistics tests passed.');
