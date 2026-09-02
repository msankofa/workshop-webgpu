// gpu-pipeline-meter.js — how much of a frame went into building WebGPU pipelines.
//
// WebGPU builds a render or compute pipeline lazily, on the first frame the thing that needs it
// actually draws, and three.js creates it synchronously inside render() unless compileAsync handed
// it a promises array (three.webgpu.js: `if (promises === null) device.createRenderPipeline(...)`).
// That cost lands in whatever profiler slot wraps the render call, so a profiler timing "the
// render" cannot say whether a spike was drawing or compiling. This separates the two.
//
// Wraps the device's four pipeline factories. The async variants compile off-thread, so only the
// blocking part of those calls is timed; their count is still reported, because a pipeline arriving
// at all is what a warmup exists to prevent.

const METHODS = [
  ['createRenderPipeline', 'render', 'renderMs', false],
  ['createComputePipeline', 'compute', 'computeMs', false],
  ['createRenderPipelineAsync', 'render', 'renderMs', true],
  ['createComputePipelineAsync', 'compute', 'computeMs', true],
];
const KEYS = ['ms', 'renderMs', 'computeMs', 'render', 'compute', 'async'];

export function createPipelineMeter(device, { now = () => performance.now() } = {}) {
  const live = { ms: 0, renderMs: 0, computeMs: 0, render: 0, compute: 0, async: 0 };
  const out = { ms: 0, renderMs: 0, computeMs: 0, render: 0, compute: 0, async: 0 };
  const restores = [];

  for (const [name, countKey, msKey, isAsync] of METHODS) {
    const original = device && device[name];
    if (typeof original !== 'function') continue;
    device[name] = function meteredPipelineFactory(...args) {
      const t0 = now();
      try {
        return original.apply(this, args);
      } finally {
        const ms = now() - t0;
        live.ms += ms;
        live[msKey] += ms;
        live[countKey]++;
        if (isAsync) live.async++;
      }
    };
    restores.push(() => { device[name] = original; });
  }

  return {
    // False on a backend with no device (file://, a stub, WebGL): the host reads zeros, not lies.
    get installed() { return restores.length > 0; },
    // Drains everything since the last call. The result object is reused, so a host reading it once
    // per frame allocates nothing: read it, do not hold it.
    take() {
      for (const key of KEYS) { out[key] = live[key]; live[key] = 0; }
      return out;
    },
    dispose() { for (const restore of restores) restore(); restores.length = 0; },
  };
}
