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
// The post* buckets are the same encode counted twice over: exactly one of each pair is marked per
// frame, so averaging a bucket over every frame would report half of what that kind of frame costs.
export const SPARSE_PASSES = new Set(['passReflectMs', 'passPostMirrorMs', 'passPostPlainMs',
  'passPostShadowMs', 'passPostNoShadowMs', 'passPostChainMs', 'passPostDirectMs']);

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

// One compact row per rendered frame, so a saved capture is not only a ten-second summary: the
// dips are in the tail of the distribution and a summary cannot say when they happened, whether the
// player was moving, or what arrived in the same frame. Rows are arrays of plain numbers with the
// keys named once, which keeps ~400 of them small enough to live in every entry.
export const SERIES_KEYS = Object.freeze(['tMs', 'frameMs', 'postRenderMs', 'speed', 'terrainInstalls',
  'terrainIntegrateMs', 'terrainQueued', 'forestReculls', 'grassReculls', 'pipelinesBuilt',
  // What happened BETWEEN frames: the gap from the end of one frame's work to the start of the
  // next, how much of that gap the browser attributed to a long task, and the JS heap. In the dips
  // the gap is 25-57 ms against a normal 6-10 (the vsync wait), with everything inside the frame
  // accounted for, so the cost is a task this page does not own.
  'betweenMs', 'longTaskMs', 'heapMB']);

export function buildPerformanceSeries(samples) {
  const rows = [];
  let elapsed = 0;
  for (const sample of samples) {
    const events = sample.events ?? {};
    // tMs is the sample's own offset when the caller stamped one, and the running sum of frame
    // times otherwise, so a capture taken before `atMs` existed still lines up in order.
    elapsed += Number(sample.frameMs) || 0;
    const at = Number.isFinite(sample.atMs) ? sample.atMs : elapsed;
    rows.push([
      round(at, 1),
      round(sample.frameMs),
      round(Number(sample.passes?.passPostMs) || 0),
      round(Number(sample.speed) || 0, 2),
      Math.round(Number(events.terrainInstalls) || 0),
      round(Number(events.terrainIntegrateMs) || 0),
      Math.round(Number(events.terrainQueued) || 0),
      Math.round(Number(events.forestReculls) || 0),
      Math.round(Number(events.grassReculls) || 0),
      Math.round(Number(sample.pipelinesBuilt) || 0),
      round(Number(sample.betweenMs) || 0),
      round(Number(sample.longTaskMs) || 0),
      round(Number(sample.heapMB) || 0, 1),
    ]);
  }
  return rows;
}

// How much of each frame's wall-clock interval the browser was inside a long task. A task that
// spans two frames counts its overlapping part in each: both frames waited on it, so both should
// say so, and the column then sums to more than the task's own duration.
//
// Frames are placed by `atMs` (their start, relative to the capture) and `frameMs`; long tasks
// arrive in the `performance.now()` timebase, so `startedAt` converts them.
export function attachLongTasks(samples, longTasks = [], startedAt = 0) {
  if (!Array.isArray(longTasks) || !longTasks.length) return samples;
  const tasks = longTasks
    .map(task => ({ start: Number(task.startTime) - startedAt, end: Number(task.startTime) - startedAt + (Number(task.duration) || 0) }))
    .filter(task => Number.isFinite(task.start) && Number.isFinite(task.end));
  let elapsed = 0;
  for (const sample of samples) {
    const frameMs = Number(sample.frameMs) || 0;
    const start = Number.isFinite(sample.atMs) ? sample.atMs : elapsed;
    elapsed += frameMs;
    const end = start + frameMs;
    let overlap = 0;
    for (const task of tasks) overlap += Math.max(0, Math.min(end, task.end) - Math.max(start, task.start));
    sample.longTaskMs = round(overlap);
  }
  return samples;
}

// The long tasks of the window, in the capture's own timebase, newest work last. Capped: a bad
// window can hold hundreds and the list is for reading, not for statistics -- the per-sample
// `longTaskMs` column is what carries all of them.
export function summarizeLongTasks(longTasks = [], { startedAt = 0, finishedAt = Infinity, limit = 100 } = {}) {
  if (!Array.isArray(longTasks) || !longTasks.length) return null;
  const inside = longTasks
    .filter(task => Number.isFinite(task.startTime) && task.startTime >= startedAt && task.startTime <= finishedAt)
    .sort((a, b) => a.startTime - b.startTime);
  if (!inside.length) return null;
  const rows = inside.slice(0, limit).map(task => ({
    tMs: round(task.startTime - startedAt, 1),
    ms: round(task.duration),
    // 'self' is the page's own main thread, 'script'/'layout'/'unknown' come from the attribution,
    // and the container fields name the frame or script when the browser knows it.
    name: task.name ?? 'unknown',
    attribution: task.attribution ?? null,
  }));
  return { count: inside.length, listed: rows.length, totalMs: round(inside.reduce((sum, t) => sum + (Number(t.duration) || 0), 0)), tasks: rows };
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

// Which per-frame events the slow frames carried. `events` on a sample is { name: count } for
// things that happen some frames and not others (terrain tile installs, forest rebuilds, grass
// reculls...). Spikes are frames at or above the p95 frame time; for every event the result says
// how many spike frames and how many ordinary frames had it, so a cause reads as "present in 90% of
// spikes, 5% of the rest" rather than as a guess from averages.
export function summarizeSpikeEvents(samples, { percentile: fraction = 0.95 } = {}) {
  const usable = samples.filter(s => Number.isFinite(s?.frameMs) && s.frameMs > 0);
  const names = new Set();
  for (const s of usable) if (s.events) for (const k of Object.keys(s.events)) names.add(k);
  if (!names.size || usable.length < 4) return null;
  const sorted = usable.map(s => s.frameMs).sort((a, b) => a - b);
  const threshold = percentile(sorted, fraction);
  const spikes = usable.filter(s => s.frameMs >= threshold), rest = usable.filter(s => s.frameMs < threshold);
  const events = {};
  for (const name of [...names].sort()) {
    const inSpikes = spikes.filter(s => (Number(s.events?.[name]) || 0) > 0).length;
    const inRest = rest.filter(s => (Number(s.events?.[name]) || 0) > 0).length;
    const spikeTotal = spikes.reduce((n, s) => n + (Number(s.events?.[name]) || 0), 0);
    events[name] = {
      spikeFrames: inSpikes, spikeShare: round(spikes.length ? inSpikes / spikes.length : 0),
      otherFrames: inRest, otherShare: round(rest.length ? inRest / rest.length : 0),
      spikeTotal: round(spikeTotal),
    };
  }
  // An event present on nearly every frame (the near-tier grass recull) explains nothing; only events
  // that are rare on ordinary frames count toward an explained spike.
  const telling = [...names].filter(n => events[n].otherShare < 0.5);
  const quiet = spikes.filter(s => !telling.some(n => (Number(s.events?.[n]) || 0) > 0)).length;
  // Was the player moving? The terrain only streams while the body moves, so a spike population
  // that is faster than the ordinary frames points at streaming before anything else does.
  const meanSpeed = list => {
    const speeds = list.map(s => Number(s.speed)).filter(Number.isFinite);
    return speeds.length ? round(speeds.reduce((sum, v) => sum + v, 0) / speeds.length, 2) : null;
  };
  const meanOf = (list, key) => {
    const values = list.map(s => Number(s[key])).filter(Number.isFinite);
    return values.length ? round(values.reduce((sum, v) => sum + v, 0) / values.length, 2) : null;
  };
  const withLongTask = list => list.filter(s => (Number(s.longTaskMs) || 0) > 0).length;
  return { thresholdMs: round(threshold), spikeFrames: spikes.length, quietSpikeFrames: quiet, tellingEvents: telling,
    speedInSpikes: meanSpeed(spikes), speedInOthers: meanSpeed(rest),
    // The gap before each frame started, and whether the browser called that gap a long task. If
    // the spikes wait longer than the ordinary frames and carry long tasks, the cost is outside
    // this page's frame entirely.
    meanBetweenInSpikes: meanOf(spikes, 'betweenMs'), meanBetweenInOthers: meanOf(rest, 'betweenMs'),
    longTaskSpikeFrames: withLongTask(spikes), longTaskOtherFrames: withLongTask(rest),
    events };
}

export function buildPerformanceMeasurement(samples, {
  requestedWindowSeconds = 0,
  startedAt,
  finishedAt,
  droppedFramesStart = 0,
  droppedFramesEnd = droppedFramesStart,
  longTasks = [],
} = {}) {
  const usable = samples.filter(sample => Number.isFinite(sample?.frameMs) && sample.frameMs > 0);
  if (!usable.length) throw new Error('No rendered frames were available for this performance capture');
  // Before anything is summarised: the per-frame long-task overlap the spike table and the series
  // both read.
  attachLongTasks(usable, longTasks, startedAt);
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
    // Whole scene renders per frame: above 1 means a shadow map or a planar mirror redrew inside
    // the same render call. Zeros on captures taken before the caller sampled it.
    renderCalls: summarizePerformanceSeries(usable.map(sample => sample.renderCalls), { integer: true }),
    // WebGPU pipelines three had to build mid-frame. A non-zero max is a warmup that is missing;
    // passPipelineMs.frames says how many frames of the window paid for one.
    pipelinesBuilt: summarizePerformanceSeries(usable.map(sample => sample.pipelinesBuilt), { integer: true }),
    // Per-pass CPU time, when the caller sampled it. A frame total says nothing about which pass
    // owns it; this is what turns "high ms" into a name.
    passes: summarizePasses(usable),
    // Slow frames and the per-frame events they carried; null when no sample recorded events.
    spikes: summarizeSpikeEvents(usable),
    // Every frame of the window, one numeric row each, in the order they were rendered.
    seriesKeys: SERIES_KEYS,
    series: buildPerformanceSeries(usable),
    // The browser's own account of what ran on the main thread between the frames.
    longTasks: summarizeLongTasks(longTasks, { startedAt, finishedAt }),
    droppedFrames: {
      start: Math.max(0, Math.round(droppedFramesStart || 0)),
      end: Math.max(0, Math.round(droppedFramesEnd || 0)),
      duringCapture: Math.max(0, Math.round((droppedFramesEnd || 0) - (droppedFramesStart || 0))),
    },
  };
}
