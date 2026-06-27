const DEFAULT_NAMES = [
  'sky',
  'terrainWindow',
  'creatures',
  'water',
  'hud',
  'grassGpu',
  'forestGpu',
  'cdlodGpu',
  'lightsGpu',
  'particlesGpu',
  'postRender',
];

const DEFAULT_PREFIXES = {
  sky: 'passSkyMs',
  terrainWindow: 'passTerrainWindowMs',
  creatures: 'passCreaturesMs',
  water: 'passWaterMs',
  hud: 'passHudMs',
  grassGpu: 'passGrassMs',
  forestGpu: 'passForestMs',
  cdlodGpu: 'passCdlodMs',
  lightsGpu: 'passLightsMs',
  particlesGpu: 'passParticlesMs',
  postRender: 'passPostMs',
};

const DEFAULT_GPU_PREFIXES = {
  grassGpu: 'gpuGrassMs',
  forestGpu: 'gpuForestMs',
  cdlodGpu: 'gpuCdlodMs',
  lightsGpu: 'gpuLightsMs',
  particlesGpu: 'gpuParticlesMs',
  postRender: 'gpuPostMs',
  computeTotal: 'gpuComputeMs',
  renderTotal: 'gpuRenderMs',
};

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

  function beginFrame() {
    for (const name of DEFAULT_NAMES) latest.set(name, 0);
    for (const name of Object.keys(DEFAULT_GPU_PREFIXES)) gpuLatest.set(name, 0);
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
    recordGpu,
    markDropped,
    snapshot,
    reset,
  };
}

