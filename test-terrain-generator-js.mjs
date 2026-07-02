import {
  DEFAULT_CONFIG, FIELD_GROUPS, FIELD_RANGES, fieldLabel, BIOME_INDEX,
  gradientMagnitude, flowAccumulation,
} from './terrain-generator-js.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
