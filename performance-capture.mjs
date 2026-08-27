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

// Passes that run on only some frames by design. Averaging in the frames where they did not run
// would report half of what they actually cost when they do, so these are summarised over their
// non-zero samples only; `frames` says how many that was.
export const SPARSE_PASSES = new Set(['passReflectMs', 'passPostMirrorMs', 'passPostPlainMs']);

// Every pass key seen across the window. Missing samples count as 0 for ordinary passes, so a pass
// that ran rarely reports an honest per-frame average; see SPARSE_PASSES for the exceptions.
export function summarizePasses(samples) {
  const names = new Set();
  for (const sample of samples) if (sample.passes) for (const key of Object.keys(sample.passes)) names.add(key);
  if (!names.size) return null;
  const out = {};
  for (const name of [...names].sort()) {
    const series = samples.map(sample => Number(sample.passes?.[name]) || 0);
    const active = series.filter(v => v > 0);
    if (!active.length) continue;
    const used = SPARSE_PASSES.has(name) ? active : series;
    out[name] = { ...summarizePerformanceSeries(used), frames: active.length };
  }
  return Object.keys(out).length ? out : null;
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
    // Per-pass CPU time, when the caller sampled it. A frame total says nothing about which pass
    // owns it; this is what turns "high ms" into a name.
    passes: summarizePasses(usable),
    droppedFrames: {
      start: Math.max(0, Math.round(droppedFramesStart || 0)),
      end: Math.max(0, Math.round(droppedFramesEnd || 0)),
      duringCapture: Math.max(0, Math.round((droppedFramesEnd || 0) - (droppedFramesStart || 0))),
    },
  };
}
