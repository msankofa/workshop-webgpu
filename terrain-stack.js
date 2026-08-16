// terrain-generator-v5's ordered layer stack: the height source that replaces v4's single
// hard-wired composer. Layer 0 is normally `classic` (v4's climate composer, supplied as a
// grid), and further layers fold procedural noise, imports and constants on top with a
// blend mode, opacity and an optional height-band mask. Modifiers (`domainWarp`, `terrace`)
// act on coordinates / the running height rather than adding a value. Pure JS, Node-testable.

import {
  fbm2, ridged2, billow2, voronoi2, terrace, domainWarp2, seedDomainOffset,
  applyBlend, BLEND_MODES, smoothstep, clamp,
} from './terrain-noise.js';

export { BLEND_MODES };
export const MAX_LAYERS = 12;

const COMMON = {
  opacity:   { min: 0, max: 1, step: 0.01, default: 1, label: 'opacity', desc: 'How much of this layer reaches the stack; 0 is off, 1 is full.' },
  amplitude: { min: -300, max: 300, step: 1, default: 60, label: 'amplitude (m)', desc: 'World-unit height range this layer adds. Negative flips it.' },
  scale:     { min: 20, max: 4000, step: 5, default: 600, label: 'scale (m)', desc: 'Size of the largest feature in metres.' },
  seedOffset:{ min: 0, max: 999, step: 1, default: 0, label: 'seed offset', desc: 'Shifts this layer to a different part of the noise domain.' },
};
const FRACTAL = {
  octaves:     { min: 1, max: 8, step: 1, default: 5, label: 'octaves', desc: 'Detail levels; each adds finer noise at half the amplitude.', structural: true },
  persistence: { min: 0.2, max: 0.9, step: 0.01, default: 0.5, label: 'persistence', desc: 'Amplitude falloff per octave; higher is rougher.' },
  lacunarity:  { min: 1.5, max: 3.5, step: 0.05, default: 2.0, label: 'lacunarity', desc: 'Frequency step per octave.' },
};
const FEEDBACK = {
  erosion: { min: 0, max: 2, step: 0.01, default: 0, label: 'erosion look', desc: 'Damps detail on steep slopes using the noise gradient; a cheap eroded look without simulation.' },
  warp:    { min: 0, max: 1, step: 0.01, default: 0, label: 'self warp', desc: 'Feeds the running gradient back into the sample point so ridges bend and flow.' },
};

export const LAYER_TYPES = {
  classic: {
    label: 'Classic composer', kind: 'source',
    desc: 'v4\'s continentalness / erosion / weirdness height composer, in world units.',
    params: { opacity: COMMON.opacity, gain: { min: 0, max: 3, step: 0.01, default: 1, label: 'gain', desc: 'Multiplier on the composed height.' } },
  },
  fbm: {
    label: 'FBM noise', kind: 'source', desc: 'Layered value noise; rolling hills to rough ground.',
    params: { ...COMMON, ...FRACTAL, ...FEEDBACK },
  },
  ridged: {
    label: 'Ridged noise', kind: 'source', desc: 'Sharp mountain ridges and crests.',
    params: { ...COMMON, ...FRACTAL, sharpness: { min: 0.5, max: 6, step: 0.1, default: 2, label: 'sharpness', desc: 'Exponent on the ridge fold; higher is knife-edged.' }, ...FEEDBACK },
  },
  billow: {
    label: 'Billow noise', kind: 'source', desc: 'Puffy rounded mounds and dune-like swells.',
    params: { ...COMMON, ...FRACTAL },
  },
  voronoi: {
    label: 'Voronoi cells', kind: 'source', desc: 'Cellular plateaus, mesas or crack networks.',
    params: {
      ...COMMON,
      jitter: { min: 0, max: 1, step: 0.01, default: 1, label: 'jitter', desc: 'Randomness of cell centres; 0 is a regular grid.' },
      distanceMode: { min: 0, max: 2, step: 1, default: 0, label: 'distance mode', desc: '0 euclidean, 1 manhattan, 2 chebyshev.', structural: true },
      outputMode: { min: 0, max: 3, step: 1, default: 1, label: 'output mode', desc: '0 cell id, 1 nearest distance, 2 edge distance, 3 edge lines.', structural: true },
    },
  },
  constant: {
    label: 'Constant', kind: 'source', desc: 'A flat value; useful with masks and blend modes.',
    params: { opacity: COMMON.opacity, amplitude: { ...COMMON.amplitude, default: 10 } },
  },
  import: {
    label: 'Imported heightmap', kind: 'source', desc: 'A grayscale image or real-world tile fetched into a grid; sampled bilinearly.',
    params: { opacity: COMMON.opacity, amplitude: { ...COMMON.amplitude, default: 120 }, offset: { min: -200, max: 200, step: 1, default: 0, label: 'offset (m)', desc: 'Added after scaling.' } },
  },
  domainWarp: {
    label: 'Domain warp', kind: 'modifier', desc: 'Bends the coordinates every later layer samples; makes noise swirl and meander.',
    params: {
      scale: { ...COMMON.scale, default: 500 },
      amount: { min: 0, max: 300, step: 1, default: 60, label: 'amount (m)', desc: 'Maximum coordinate displacement.' },
      octaves: { ...FRACTAL.octaves, default: 3 },
      seedOffset: COMMON.seedOffset,
    },
  },
  terrace: {
    label: 'Terrace', kind: 'modifier', desc: 'Quantizes the running height into steps.',
    params: {
      stepHeight: { min: 1, max: 80, step: 0.5, default: 12, label: 'step height (m)', desc: 'Vertical size of each terrace.' },
      smoothness: { min: 0, max: 1, step: 0.01, default: 0.35, label: 'smoothness', desc: 'How soft the riser between steps is.' },
      strength: { min: 0, max: 1, step: 0.01, default: 1, label: 'strength', desc: 'Blend between untouched and fully terraced.' },
    },
  },
};

export const LAYER_TYPE_ORDER = Object.keys(LAYER_TYPES);

let nextId = 1;
export function makeLayer(type, overrides = {}) {
  const def = LAYER_TYPES[type];
  if (!def) throw new Error(`unknown layer type ${type}`);
  const params = {};
  for (const [k, p] of Object.entries(def.params)) params[k] = p.default;
  return {
    id: overrides.id ?? `L${nextId++}`,
    type, enabled: true, name: overrides.name ?? def.label,
    blendMode: overrides.blendMode ?? 'add',
    mask: { enabled: false, lo: -50, hi: 150, feather: 20 },
    params: { ...params, ...(overrides.params || {}) },
    source: overrides.source ?? null,
    ...('enabled' in overrides ? { enabled: overrides.enabled } : {}),
    ...(overrides.mask ? { mask: { ...overrides.mask } } : {}),
  };
}

export function defaultStack() {
  return { version: 1, layers: [makeLayer('classic', { id: 'classic', name: 'Classic composer' })] };
}

// Only fields that change control flow or the layer list shape; a stack with the same
// signature can reuse compiled machinery and differs only by continuous params.
export function structuralSignature(stack) {
  return stack.layers.filter((l) => l.enabled).map((l) => {
    const def = LAYER_TYPES[l.type];
    const structural = Object.entries(def.params).filter(([, p]) => p.structural).map(([k]) => `${k}=${l.params[k]}`).join(',');
    return `${l.type}/${l.blendMode}[${structural}]${l.mask.enabled ? 'm' : ''}`;
  }).join('|');
}

export function normalizeStack(raw) {
  const stack = defaultStack();
  if (!raw || !Array.isArray(raw.layers)) return stack;
  const layers = [];
  for (const l of raw.layers) {
    if (!l || !LAYER_TYPES[l.type]) continue;
    const layer = makeLayer(l.type, {
      id: typeof l.id === 'string' ? l.id : undefined, name: typeof l.name === 'string' ? l.name : undefined,
      blendMode: BLEND_MODES.includes(l.blendMode) ? l.blendMode : 'add',
      params: {}, source: l.source ?? null,
    });
    layer.enabled = l.enabled !== false;
    if (l.mask && typeof l.mask === 'object') {
      layer.mask = { enabled: !!l.mask.enabled, lo: Number(l.mask.lo) || 0, hi: Number(l.mask.hi) || 0, feather: Math.max(0, Number(l.mask.feather) || 0) };
    }
    for (const [k, p] of Object.entries(LAYER_TYPES[l.type].params)) {
      const v = Number(l.params?.[k]);
      layer.params[k] = Number.isFinite(v) ? clamp(v, p.min, p.max) : p.default;
    }
    const m = /^L(\d+)$/.exec(layer.id);
    if (m) nextId = Math.max(nextId, Number(m[1]) + 1);
    layers.push(layer);
    if (layers.length >= MAX_LAYERS) break;
  }
  if (layers.length) stack.layers = layers;
  return stack;
}

function bilinear(grid, res, u, v) {
  const gx = clamp(u, 0, 1) * (res - 1), gz = clamp(v, 0, 1) * (res - 1);
  const ix = Math.min(res - 2, Math.floor(gx)), iz = Math.min(res - 2, Math.floor(gz));
  const tx = gx - ix, tz = gz - iz;
  const a = grid[iz * res + ix], b = grid[iz * res + ix + 1];
  const c = grid[(iz + 1) * res + ix], d = grid[(iz + 1) * res + ix + 1];
  return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
}

function maskWeight(mask, acc) {
  if (!mask.enabled) return 1;
  const f = Math.max(mask.feather, 1e-6);
  return smoothstep(mask.lo - f, mask.lo, acc) * (1 - smoothstep(mask.hi, mask.hi + f, acc));
}

// Evaluate the stack at every cell of a resolution x resolution grid spanning
// [-worldX/2, worldX/2] x [-worldZ/2, worldZ/2]. ctx: { resolution, worldX, worldZ, seed,
// classicHeight?: Float32Array, imports?: { [layerId]: { data: Float32Array, resolution } } }.
// Returns a Float32Array of heights in world units.
export function evaluateStackGrid(stack, ctx) {
  const { resolution: res, worldX, worldZ, seed = 0 } = ctx;
  const n = res * res;
  const out = new Float32Array(n);
  const layers = stack.layers.filter((l) => l.enabled);
  const seedBase = seedDomainOffset(seed);
  const warp = [0, 0];
  const prepared = layers.map((l) => ({
    l, def: LAYER_TYPES[l.type],
    off: seedBase + seedDomainOffset((seed * 31 + (l.params.seedOffset || 0) * 7919) | 0) * 0.37,
    imp: l.type === 'import' ? ctx.imports?.[l.id] ?? null : null,
  }));
  for (let iz = 0; iz < res; iz++) {
    const z = (iz / Math.max(1, res - 1) - 0.5) * worldZ;
    for (let ix = 0; ix < res; ix++) {
      const x = (ix / Math.max(1, res - 1) - 0.5) * worldX;
      const idx = iz * res + ix;
      let acc = 0, px = x, pz = z;
      for (let li = 0; li < prepared.length; li++) {
        const { l, def, off, imp } = prepared[li];
        const p = l.params;
        if (def.kind === 'modifier') {
          if (l.type === 'domainWarp') {
            domainWarp2(px + off, pz - off, { scale: p.scale, amount: p.amount, octaves: p.octaves }, warp);
            px += warp[0]; pz += warp[1];
          } else if (l.type === 'terrace') {
            acc = terrace(acc, { stepHeight: p.stepHeight, smoothness: p.smoothness, strength: p.strength });
          }
          continue;
        }
        let v;
        const s = p.scale ? 1 / p.scale : 0;
        const sx = px * s + off, sz = pz * s - off * 0.61;
        switch (l.type) {
          case 'classic': v = (ctx.classicHeight ? ctx.classicHeight[idx] : 0) * p.gain; break;
          case 'fbm': v = (fbm2(sx, sz, p) - 0.5) * p.amplitude; break;
          case 'ridged': v = ridged2(sx, sz, p) * p.amplitude; break;
          case 'billow': v = (billow2(sx, sz, p) - 0.5) * p.amplitude; break;
          case 'voronoi': v = (voronoi2(sx, sz, p) - 0.5) * p.amplitude; break;
          case 'constant': v = p.amplitude; break;
          case 'import': v = imp ? bilinear(imp.data, imp.resolution, ix / Math.max(1, res - 1), iz / Math.max(1, res - 1)) * p.amplitude + p.offset : 0; break;
          default: v = 0;
        }
        acc = applyBlend(l.blendMode, acc, v, p.opacity * maskWeight(l.mask, acc));
      }
      out[idx] = acc;
    }
  }
  return out;
}

// Small preset stacks users can start from.
export const STACK_PRESETS = {
  'classic only': () => defaultStack(),
  'alpine ridges': () => ({ version: 1, layers: [
    makeLayer('classic', { id: 'classic' }),
    makeLayer('domainWarp', { params: { amount: 90, scale: 700 } }),
    makeLayer('ridged', { params: { amplitude: 160, scale: 420, octaves: 6, erosion: 0.4, warp: 0.2 }, mask: { enabled: true, lo: 10, hi: 400, feather: 30 } }),
    makeLayer('fbm', { params: { amplitude: 12, scale: 90, octaves: 4 } }),
  ] }),
  'mesa country': () => ({ version: 1, layers: [
    makeLayer('classic', { id: 'classic', params: { gain: 0.6 } }),
    makeLayer('voronoi', { params: { amplitude: 90, scale: 500, outputMode: 1 }, mask: { enabled: true, lo: 0, hi: 400, feather: 15 } }),
    makeLayer('terrace', { params: { stepHeight: 18, smoothness: 0.25 } }),
    makeLayer('fbm', { params: { amplitude: 6, scale: 60 } }),
  ] }),
  'rolling dunes': () => ({ version: 1, layers: [
    makeLayer('classic', { id: 'classic', params: { gain: 0.4 } }),
    makeLayer('billow', { params: { amplitude: 40, scale: 320, octaves: 4 } }),
    makeLayer('fbm', { params: { amplitude: 8, scale: 45, octaves: 3 } }),
  ] }),
};
