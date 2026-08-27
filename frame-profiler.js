const DEFAULT_NAMES = [
  'sky',
  'terrainWindow',
  'creatures',
  'water',
  'hud',
  'grassGpu',
  'forestGpu',
  'plantsGpu',
  'dressingGpu',
  'cdlodGpu',
  'lightsGpu',
  'particlesGpu',
  'postRender',
  'timestampResolve',
];

const DEFAULT_PREFIXES = {
  sky: 'passSkyMs',
  terrainWindow: 'passTerrainWindowMs',
  creatures: 'passCreaturesMs',
  water: 'passWaterMs',
  hud: 'passHudMs',
  grassGpu: 'passGrassMs',
  forestGpu: 'passForestMs',
  plantsGpu: 'passPlantsMs',
  dressingGpu: 'passDressingMs',
  cdlodGpu: 'passCdlodMs',
  lightsGpu: 'passLightsMs',
  particlesGpu: 'passParticlesMs',
  postRender: 'passPostMs',
  timestampResolve: 'passTimestampResolveMs',
};

const DEFAULT_GPU_PREFIXES = {
  grassGpu: 'gpuGrassMs',
  forestGpu: 'gpuForestMs',
  plantsGpu: 'gpuPlantsMs',
  cdlodGpu: 'gpuCdlodMs',
  lightsGpu: 'gpuLightsMs',
  particlesGpu: 'gpuParticlesMs',
  postRender: 'gpuPostMs',
  computeTotal: 'gpuComputeMs',
  renderTotal: 'gpuRenderMs',
};
const DEFAULT_GPU_NAMES = Object.keys(DEFAULT_GPU_PREFIXES);   // hoisted: beginFrame runs per frame

function round3(v) {
  return Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;
}

export function createFrameProfiler({ smoothing = 0.2, now = () => performance.now() } = {}) {
  const latest = new Map();
  const smooth = new Map();
  const gpuLatest = new Map();
  const gpuSmooth = new Map();
  let droppedFrames = 0;

  function record(mapLatest, mapSmooth, name, ms) {
    const v = Math.max(0, Number(ms) || 0);
    mapLatest.set(name, v);
    const prev = mapSmooth.has(name) ? mapSmooth.get(name) : v;
    mapSmooth.set(name, prev + (v - prev) * smoothing);
    return v;
  }

  // Zeroes every name seen so far plus the defaults, so a timer that doesn't run reads 0, not stale.
  function beginFrame() {
    for (const name of latest.keys()) latest.set(name, 0);
    for (const name of DEFAULT_NAMES) latest.set(name, 0);
    for (const name of gpuLatest.keys()) gpuLatest.set(name, 0);
    for (const name of DEFAULT_GPU_NAMES) gpuLatest.set(name, 0);
    // smooth/gpuSmooth are deliberately untouched: the HUD's EMA decays instead of snapping to 0.
  }

  function time(name, fn) {
    const t0 = now();
    try {
      return fn();
    } finally {
      record(latest, smooth, name, now() - t0);
    }
  }

  async function timeAsync(name, fn) {
    const t0 = now();
    try {
      return await fn();
    } finally {
      record(latest, smooth, name, now() - t0);
    }
  }

  // Record a duration measured by the caller. For regions that cannot be wrapped in a closure
  // because they declare bindings the rest of the frame uses.
  function mark(name, ms) {
    return record(latest, smooth, name, ms);
  }

  function recordGpu(name, ms) {
    return record(gpuLatest, gpuSmooth, name, ms);
  }

  function markDropped(count = 1) {
    droppedFrames += Math.max(0, count | 0);
  }

  function snapshot(prefixMap = DEFAULT_PREFIXES, opts = {}) {
    const source = opts.smooth ? smooth : latest;
    const gpuSource = opts.smooth ? gpuSmooth : gpuLatest;
    const out = {};
    for (const [name, key] of Object.entries(prefixMap)) out[key] = round3(source.get(name) || 0);
    for (const [name, key] of Object.entries(DEFAULT_GPU_PREFIXES)) out[key] = round3(gpuSource.get(name) || 0);
    out.passGpuAwaitMs = round3(
      (source.get('grassGpu') || 0) +
      (source.get('forestGpu') || 0) +
      (source.get('plantsGpu') || 0) +
      (source.get('dressingGpu') || 0) +
      (source.get('cdlodGpu') || 0) +
      (source.get('lightsGpu') || 0) +
      (source.get('particlesGpu') || 0) +
      (source.get('postRender') || 0)
    );
    out.droppedFrames = droppedFrames;
    return out;
  }

  function reset() {
    latest.clear();
    smooth.clear();
    gpuLatest.clear();
    gpuSmooth.clear();
    droppedFrames = 0;
  }

  return {
    beginFrame,
    time,
    timeAsync,
    mark,
    recordGpu,
    markDropped,
    snapshot,
    reset,
  };
}

