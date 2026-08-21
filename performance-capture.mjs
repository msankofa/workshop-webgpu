function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function summarizePerformanceSeries(values, { integer = false } = {}) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { latest: 0, average: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, stdDev: 0 };
  const sorted = [...finite].sort((a, b) => a - b);
  const average = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.reduce((sum, value) => sum + (value - average) ** 2, 0) / finite.length;
  const clean = value => integer ? Math.round(value) : round(value);
  return {
    latest: clean(finite.at(-1)),
    average: clean(average),
    min: clean(sorted[0]),
    max: clean(sorted.at(-1)),
    p50: clean(percentile(sorted, 0.50)),
    p95: clean(percentile(sorted, 0.95)),
    p99: clean(percentile(sorted, 0.99)),
    stdDev: clean(Math.sqrt(variance)),
  };
}

export function changedPerformanceSettings(before = {}, after = {}) {
  const changed = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (Object.is(before[key], after[key])) continue;
    changed.push({ key, before: before[key], after: after[key] });
  }
  return changed;
}

export function buildPerformanceMeasurement(samples, {
  requestedWindowSeconds = 0,
  startedAt,
  finishedAt,
  droppedFramesStart = 0,
  droppedFramesEnd = droppedFramesStart,
} = {}) {
  const usable = samples.filter(sample => Number.isFinite(sample?.frameMs) && sample.frameMs > 0);
  if (!usable.length) throw new Error('No rendered frames were available for this performance capture');
  const frameMs = usable.map(sample => sample.frameMs);
  const elapsedFrameMs = frameMs.reduce((sum, value) => sum + value, 0);
  const frameFps = frameMs.map(value => 1000 / value);
  const wallDurationMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt - startedAt)
    : elapsedFrameMs;
  return {
    requestedWindowSeconds: round(Math.max(0, requestedWindowSeconds)),
    measuredWindowSeconds: round(wallDurationMs / 1000),
    sampleCount: usable.length,
    fps: {
      effective: round(usable.length * 1000 / elapsedFrameMs),
      ...summarizePerformanceSeries(frameFps),
    },
    frameMs: summarizePerformanceSeries(frameMs),
    drawCalls: summarizePerformanceSeries(usable.map(sample => sample.drawCalls), { integer: true }),
    triangles: summarizePerformanceSeries(usable.map(sample => sample.triangles), { integer: true }),
    droppedFrames: {
      start: Math.max(0, Math.round(droppedFramesStart || 0)),
      end: Math.max(0, Math.round(droppedFramesEnd || 0)),
      duringCapture: Math.max(0, Math.round((droppedFramesEnd || 0) - (droppedFramesStart || 0))),
    },
  };
}
