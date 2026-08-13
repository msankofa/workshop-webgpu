// node bench-terrain.mjs [preset]
// Rebuild-cost benchmark for bot-terrain.js. Mirrors what applyLayout actually does on a layout:
// build the field, build the floor mesh arrays, then sample it the way buildNavGrid + navWalkable
// do (one heightAt per cell for the height grid, one slopeAt per cell for the walk gate).
// The point is a hard number to compare against when the generator gains features.
import { performance } from 'node:perf_hooks';
import { BOT_TERRAIN_DEFAULTS, createTerrainField, buildTerrainMeshArrays, footprintRange } from './bot-terrain.js';

const NAV_CELL = 0.5;
const TERRAIN_FLOOR_PAD = 2.5;

// The viewer's "Big open field" preset: 40x40 cells at 4.3 m, terrain amp 3.5 / scale 18.
const PRESETS = {
  'open-field': { half: 86, params: { enabled: true, hillAmp: 3.5, hillScale: 18, hillOctaves: 3, rippleAmp: 0.15, meshCell: 0.5 }, pads: 103, boxes: 120 },
  'maze': { half: 43, params: { enabled: true, hillAmp: 0.9, hillScale: 16, hillOctaves: 3, meshCell: 0.4 }, pads: 40, boxes: 400 },
  'huge': { half: 150, params: { enabled: true, hillAmp: 4, hillScale: 22, hillOctaves: 4, rippleAmp: 0.15, meshCell: 0.5 }, pads: 160, boxes: 200 },
  // Everything on at once: warped ridges, terraces and a full drainage network.
  'eroded': {
    half: 86, pads: 103, boxes: 120,
    params: {
      enabled: true, hillAmp: 3.5, hillScale: 18, hillOctaves: 3, rippleAmp: 0.15, meshCell: 0.5,
      landform: 'ridged', warpAmp: 6, warpScale: 35, terraceSteps: 5, terraceSharpness: 0.5,
      erosionAmp: 1.2, erosionArea: 300, erosionSmooth: 0.5,
    },
  },
};

// Deterministic scatter so every run benchmarks the identical workload.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePads(n, half) {
  const rng = mulberry32(1234);
  const pads = [];
  for (let i = 0; i < n; i++) {
    pads.push({ x: (rng() * 2 - 1) * half * 0.9, z: (rng() * 2 - 1) * half * 0.9, radius: 1.2 + rng() * 2.4 });
  }
  return pads;
}

function makeBoxes(n, half) {
  const rng = mulberry32(99);
  const boxes = [];
  for (let i = 0; i < n; i++) {
    boxes.push({ x: (rng() * 2 - 1) * half * 0.95, z: (rng() * 2 - 1) * half * 0.95, w: 0.8 + rng() * 2, d: 0.8 + rng() * 2 });
  }
  return boxes;
}

function bench(label, fn, runs = 3) {
  fn();  // warm the JIT so the first sample isn't measuring compilation
  let best = Infinity, total = 0;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    const dt = performance.now() - t;
    total += dt;
    if (dt < best) best = dt;
  }
  console.log(`  ${label.padEnd(30)} best ${best.toFixed(1)} ms   mean ${(total / runs).toFixed(1)} ms`);
  return best;
}

const which = process.argv[2] || 'open-field';
const preset = PRESETS[which];
if (!preset) {
  console.error(`unknown preset "${which}" -- try: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

const { half, pads: padCount, boxes: boxCount } = preset;
const params = { ...BOT_TERRAIN_DEFAULTS, ...preset.params };
const bounds = { minX: -half, maxX: half, minZ: -half, maxZ: half };
const padded = {
  minX: bounds.minX - TERRAIN_FLOOR_PAD, maxX: bounds.maxX + TERRAIN_FLOOR_PAD,
  minZ: bounds.minZ - TERRAIN_FLOOR_PAD, maxZ: bounds.maxZ + TERRAIN_FLOOR_PAD,
};
const pads = makePads(padCount, half);
const boxes = makeBoxes(boxCount, half);
const navCols = Math.ceil((bounds.maxX - bounds.minX) / NAV_CELL);
const navRows = Math.ceil((bounds.maxZ - bounds.minZ) / NAV_CELL);

console.log(`\nbench-terrain "${which}" -- ${(half * 2).toFixed(0)} m map, ${navCols}x${navRows} nav grid, ${padCount} pads, ${boxCount} boxes`);
console.log(`  amp ${params.hillAmp} scale ${params.hillScale} octaves ${params.hillOctaves} meshCell ${params.meshCell}\n`);

function runStages(label, fieldOpts) {
  console.log(`--- ${label} ---`);
  const t = measureStages(fieldOpts);
  console.log(`  ${'TOTAL rebuild'.padEnd(30)} ${t.total.toFixed(1)} ms\n`);
  return t;
}

function measureStages(fieldOpts) {
// Stage 1: field construction (pad level resolution + whatever bake the field does internally).
const tField = bench('createTerrainField', () => { createTerrainField(params, pads, fieldOpts); });

const field = createTerrainField(params, pads, fieldOpts);

// Stage 2: the floor mesh the collider swallows -- 1 heightAt + 1 normalAt per vertex.
const tMesh = bench('buildTerrainMeshArrays', () => { buildTerrainMeshArrays(padded, field); });
const mesh = buildTerrainMeshArrays(padded, field);

// Stage 3: wall/cover sinking -- footprintRange(4) per box.
const tBoxes = bench('footprintRange x boxes', () => {
  for (const b of boxes) footprintRange(field, b.x, b.z, b.w, b.d, 4);
});

// Stage 4: what buildNavGrid does -- a height per cell.
const tHeights = bench('nav height grid', () => {
  const out = new Float32Array(navCols * navRows);
  for (let r = 0; r < navRows; r++) {
    const z = bounds.minZ + (r + 0.5) * NAV_CELL;
    for (let c = 0; c < navCols; c++) out[r * navCols + c] = field.heightAt(bounds.minX + (c + 0.5) * NAV_CELL, z);
  }
  return out;
});

// Stage 5: what navWalkable does -- a slope test per cell (central differences: 4 heightAt each).
const tSlope = bench('nav walk-slope gate', () => {
  let blocked = 0;
  for (let r = 0; r < navRows; r++) {
    const z = bounds.minZ + (r + 0.5) * NAV_CELL;
    for (let c = 0; c < navCols; c++) {
      if (field.slopeAt(bounds.minX + (c + 0.5) * NAV_CELL, z, NAV_CELL * 0.5) > params.maxSlope) blocked++;
    }
  }
  return blocked;
});

// Runtime sampling cost: heightAt runs per frame for decals, ragdolls, the fly camera and FX.
const probe = new Float64Array(200);
for (let i = 0; i < 200; i++) probe[i] = (i * 0.7919 % 1) * half * 2 - half;
const RUNTIME_N = 200000;
const tRuntime = bench('heightAt x200k (runtime)', () => {
  let s = 0;
  for (let i = 0; i < RUNTIME_N; i++) s += field.heightAt(probe[i % 200], probe[(i * 7 + 3) % 200]);
  return s;
});
console.log(`  ${'per heightAt'.padEnd(30)} ${(tRuntime * 1e6 / RUNTIME_N).toFixed(0)} ns`);

  return { total: tField + tMesh + tBoxes + tHeights + tSlope, field, mesh };
}

// Shape report, so a "faster" field that quietly flattened the terrain can't pass unnoticed.
function shapeReport(field, mesh) {
  let min = Infinity, max = -Infinity, sumAbsSlope = 0, n = 0, steep = 0;
  for (let r = 0; r < navRows; r += 2) {
    const z = bounds.minZ + (r + 0.5) * NAV_CELL;
    for (let c = 0; c < navCols; c += 2) {
      const x = bounds.minX + (c + 0.5) * NAV_CELL;
      const h = field.heightAt(x, z);
      if (h < min) min = h;
      if (h > max) max = h;
      const s = field.slopeAt(x, z, NAV_CELL * 0.5);
      sumAbsSlope += s;
      if (s > params.maxSlope) steep++;
      n++;
    }
  }
  console.log(`  relief ${(max - min).toFixed(2)} m (${min.toFixed(2)} .. ${max.toFixed(2)}), mean slope ${(sumAbsSlope / n).toFixed(3)}, unwalkable ${(steep / n * 100).toFixed(1)}%, mesh ${mesh.triangleCount.toLocaleString()} tris`);
}

const analytic = runStages('analytic (pre-bake baseline)', {});
shapeReport(analytic.field, analytic.mesh);
console.log('');
const baked = runStages('baked grid', { bounds });
shapeReport(baked.field, baked.mesh);

// Fidelity: the bake must not quietly reshape the ground it claims to be a faster copy of.
let maxDiff = 0, sumDiff = 0, maxAngle = 0, samples = 0;
for (let r = 0; r < navRows; r++) {
  const z = bounds.minZ + (r + 0.5) * NAV_CELL;
  for (let c = 0; c < navCols; c++) {
    const x = bounds.minX + (c + 0.5) * NAV_CELL;
    const diff = Math.abs(baked.field.heightAt(x, z) - analytic.field.heightAt(x, z));
    if (diff > maxDiff) maxDiff = diff;
    sumDiff += diff;
    const na = analytic.field.normalAt(x, z), nb = baked.field.normalAt(x, z);
    const dot = Math.min(1, Math.max(-1, na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]));
    const ang = Math.acos(dot) * 180 / Math.PI;
    if (ang > maxAngle) maxAngle = ang;
    samples++;
  }
}
const g = baked.field.grid;
console.log(`\n  bake fidelity vs analytic: mean |dh| ${(sumDiff / samples * 1000).toFixed(1)} mm, max ${(maxDiff * 1000).toFixed(0)} mm, max normal deviation ${maxAngle.toFixed(1)} deg`);
console.log(`  grid ${g.cols}x${g.rows} @ ${g.step.toFixed(2)} m = ${(g.heights.byteLength / 1048576).toFixed(2)} MB`);
console.log(`  speedup ${(analytic.total / baked.total).toFixed(2)}x  (${analytic.total.toFixed(1)} -> ${baked.total.toFixed(1)} ms)\n`);
