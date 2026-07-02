import {
  DEFAULT_CONFIG, FIELD_GROUPS, FIELD_RANGES, fieldLabel, BIOME_INDEX,
  gradientMagnitude, flowAccumulation, simulateErosion, buildDerivedMaps, buildMaterialMasks,
  generateFullGrid,
} from './terrain-generator-js.js';
import { generateGrid } from './biome-classifier-js.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// --- Task 2: field schema ---
ok(DEFAULT_CONFIG.seed === 1337, '2: DEFAULT_CONFIG.seed matches config.py');
ok(DEFAULT_CONFIG.world_x === 1200.0, '2: DEFAULT_CONFIG.world_x matches config.py');
ok(DEFAULT_CONFIG.world_z === 1200.0, '2: DEFAULT_CONFIG.world_z matches config.py');
ok(DEFAULT_CONFIG.preview_resolution === 384, '2: DEFAULT_CONFIG.preview_resolution matches config.py');
ok(DEFAULT_CONFIG.sea_level === 0.0, '2: DEFAULT_CONFIG.sea_level matches config.py');
ok(DEFAULT_CONFIG.hydraulic_erosion_strength === 5.0, '2: DEFAULT_CONFIG.hydraulic_erosion_strength matches config.py');
ok(DEFAULT_CONFIG.thermal_erosion_iterations === 3, '2: DEFAULT_CONFIG.thermal_erosion_iterations matches config.py');
ok(DEFAULT_CONFIG.lake_flow_threshold === 0.58, '2: DEFAULT_CONFIG.lake_flow_threshold matches config.py');
ok(DEFAULT_CONFIG.lake_bank_height === 2.5, '2: DEFAULT_CONFIG.lake_bank_height matches config.py');
ok(DEFAULT_CONFIG.snow_height_full === 112.0, '2: DEFAULT_CONFIG.snow_height_full matches config.py');

const groupNames = FIELD_GROUPS.map((g) => g.name);
ok(JSON.stringify(groupNames) === JSON.stringify(['World', 'Noise Fields', 'Height Composer', 'Erosion Simulation', 'Hydrology', 'Derived Masks']),
  '2: FIELD_GROUPS names/order match config.py');

const worldGroup = FIELD_GROUPS.find((g) => g.name === 'World');
ok(JSON.stringify(worldGroup.fields) === JSON.stringify(['seed', 'world_x', 'world_z', 'preview_resolution', 'sea_level']),
  '2: World group fields match config.py');

const allFieldNames = FIELD_GROUPS.flatMap((g) => g.fields);
ok(allFieldNames.length === 33, '2: six groups list 33 fields total');
let allFieldsValid = true;
for (const name of allFieldNames) {
  if (!(name in DEFAULT_CONFIG)) allFieldsValid = false;
  if (!(name in FIELD_RANGES)) allFieldsValid = false;
}
ok(allFieldsValid, '2: every FIELD_GROUPS field has a DEFAULT_CONFIG value and a FIELD_RANGES entry');

const [lo, hi, step] = FIELD_RANGES.preview_resolution;
ok(lo === 96 && hi === 1024 && step === 32, '2: preview_resolution range matches config.py (96-1024 step 32)');

ok(fieldLabel('snow_height_start') === 'snow start', '2: fieldLabel looks up FIELD_LABELS');
ok(fieldLabel('seed') === 'seed', '2: fieldLabel falls back to raw name when no FIELD_LABELS entry exists');

// --- Task 3: gradientMagnitude + flowAccumulation ---
{
  const flat = new Float32Array(9).fill(5.0);
  const slope = gradientMagnitude(flat, 3, 300, 300);
  let allZero = true;
  for (const s of slope) if (Math.abs(s) >= 1e-9) allZero = false;
  ok(allZero, '3: flat height has zero slope everywhere');
}
{
  const res = 3;
  const height = new Float32Array([8, 7, 6, 7, 6, 5, 6, 5, 0]); // (2,2) is the lowest by far
  const { raw, norm } = flowAccumulation(height, res);
  ok(raw.length === 9, '3: flowAccumulation returns one value per cell');
  ok(raw[8] >= 8, `3: sink cell accumulates close to all upstream flow, got ${raw[8]}`);
  let everyoneAtLeastOne = true, normInRange = true;
  for (const r of raw) if (r < 1) everyoneAtLeastOne = false;
  for (const n of norm) if (n < 0 || n > 1) normInRange = false;
  ok(everyoneAtLeastOne, '3: every cell accumulates at least itself');
  ok(normInRange, '3: normalized flow is in [0,1]');
  ok(norm[8] > norm[0], '3: the sink has higher normalized flow than a high corner');
}

// --- Task 4: simulateErosion ---
{
  const res = 5;
  const n = res * res;
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) height[i] = 10 - i * 0.3; // simple downhill ramp

  const noErosionCfg = { ...DEFAULT_CONFIG, hydraulic_erosion_strength: 0, thermal_erosion_iterations: 0 };
  const noOpResult = simulateErosion(height, res, noErosionCfg);
  let noOp = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(noOpResult.height[i] - height[i]) >= 1e-9) noOp = false;
    if (Math.abs(noOpResult.erosionDelta[i]) >= 1e-9) noOp = false;
  }
  ok(noOp, '4: strength=0/iterations=0 is a no-op');

  const eroded = simulateErosion(height, res, { ...DEFAULT_CONFIG });
  let anyChanged = false;
  for (let i = 0; i < n; i++) if (Math.abs(eroded.height[i] - height[i]) > 1e-6) anyChanged = true;
  ok(anyChanged, '4: default erosion strength actually changes the height field');
  ok(eroded.flowNorm.length === n, '4: flowNorm has one value per cell');

  const again = simulateErosion(height, res, { ...DEFAULT_CONFIG });
  let deterministic = true;
  for (let i = 0; i < n; i++) if (eroded.height[i] !== again.height[i]) deterministic = false;
  ok(deterministic, '4: erosion is deterministic');
}

// --- Task 5: buildDerivedMaps ---
{
  const res = 5;
  const n = res * res;
  // A bowl: low in the middle (below sea level), rising toward the edges.
  const height = new Float32Array(n);
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const dz = iz - 2, dx = ix - 2;
      height[iz * res + ix] = -10 + (dx * dx + dz * dz) * 5;
    }
  }
  const cfg = { ...DEFAULT_CONFIG, sea_level: 0 };
  const { flowNorm } = simulateErosion(height, res, { ...cfg, hydraulic_erosion_strength: 0, thermal_erosion_iterations: 0 });
  const derived = buildDerivedMaps(height, res, cfg, flowNorm);

  ok(derived.seaMask[12] === 1, '5: center cell (below sea level) is sea');
  ok(derived.seaMask[0] === 0, '5: corner cell (well above sea level) is not sea');
  let lakeBinary = true, beachInRange = true, mountainInRange = true, rockInRange = true, snowInRange = true;
  for (const m of derived.lakeMask) if (m !== 0 && m !== 1) lakeBinary = false;
  for (const m of derived.beachMask) if (m < 0 || m > 1) beachInRange = false;
  for (const m of derived.mountainMask) if (m < 0 || m > 1) mountainInRange = false;
  for (const m of derived.rockMask) if (m < 0 || m > 1) rockInRange = false;
  for (const m of derived.snowMask) if (m < 0 || m > 1) snowInRange = false;
  ok(lakeBinary, '5: lake mask is 0 or 1');
  ok(beachInRange, '5: beach mask is in [0,1]');
  ok(mountainInRange, '5: mountain mask is in [0,1]');
  ok(rockInRange, '5: rock mask is in [0,1]');
  ok(snowInRange, '5: snow mask is in [0,1]');
  ok(derived.slope.length === n, '5: slope has one value per cell');
}

// --- Task 6: buildMaterialMasks ---
{
  const res = 3;
  const n = res * res;
  const height = new Float32Array(n).fill(20); // all dry land
  const cfg = { ...DEFAULT_CONFIG, sea_level: 0 };
  const derived = {
    slope: new Float32Array(n).fill(0.05),
    seaMask: new Float32Array(n).fill(0),
    lakeMask: new Float32Array(n).fill(0),
    beachMask: new Float32Array(n).fill(0),
    mountainMask: new Float32Array(n).fill(0),
    rockMask: new Float32Array(n).fill(0),
    snowMask: new Float32Array(n).fill(0),
  };
  const biomeIds = new Uint8Array(n).fill(BIOME_INDEX.forest);
  const { masks, rgba } = buildMaterialMasks(height, derived, biomeIds, cfg, res);

  let mostlyForest = true, dryWater = true;
  for (let i = 0; i < n; i++) {
    if (masks.forest[i] <= 0.9) mostlyForest = false;
    if (masks.water[i] !== 0) dryWater = false;
  }
  ok(mostlyForest, '6: flat low-slope forest-biome land is mostly forest material');
  ok(dryWater, '6: dry land has zero water mask');
  ok(rgba.length === n * 4, '6: rgba has one RGBA quad per cell');
  let allOpaque = true;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] !== 255) allOpaque = false;
  ok(allOpaque, '6: alpha is always opaque');
}

// --- Task 7: generateFullGrid ---
{
  const res = 32;
  const cfg = { ...DEFAULT_CONFIG, world_x: 1200, world_z: 1200, preview_resolution: res };
  const grid = generateFullGrid(cfg, res);

  let allFieldsPresent = true;
  for (const key of ['continentalness', 'erosion', 'weirdness', 'temperature', 'humidity',
    'targetHeight', 'height', 'erosionDelta', 'flowNorm', 'slope', 'seaMask', 'lakeMask',
    'beachMask', 'mountainMask', 'rockMask', 'snowMask', 'biomeId', 'ruleIndex']) {
    if (!(key in grid) || grid[key].length !== res * res) allFieldsPresent = false;
  }
  ok(allFieldsPresent, '7: generateFullGrid result includes every stage output, one value per cell');

  const again = generateFullGrid(cfg, res);
  let deterministic = true;
  for (let i = 0; i < res * res; i++) if (grid.height[i] !== again.height[i]) deterministic = false;
  ok(deterministic, '7: generateFullGrid is deterministic');

  // Regression guard: with erosion fully disabled, Phase A's height output should match
  // biome-classifier-js.js's own generateGrid (WORLD_EXTENT=1200, same seed/knobs),
  // proving the Task 1 export-widening refactor changed nothing.
  const noErosionCfg = { ...cfg, hydraulic_erosion_strength: 0, thermal_erosion_iterations: 0 };
  const fullGrid = generateFullGrid(noErosionCfg, res);
  const legacyGrid = generateGrid({ ...DEFAULT_CONFIG, seed: cfg.seed }, res);
  let matchesLegacy = true;
  for (let i = 0; i < res * res; i++) {
    if (Math.abs(fullGrid.targetHeight[i] - legacyGrid.height[i]) >= 1e-4) matchesLegacy = false;
  }
  ok(matchesLegacy, '7: pre-erosion height matches legacy generateGrid (regression guard for Task 1)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
