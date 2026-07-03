import {
  DEFAULT_CONFIG, FIELD_GROUPS, FIELD_RANGES, fieldLabel, fieldDescription, BIOME_INDEX, BIOMES,
  gradientMagnitude, flowAccumulation, simulateErosion, buildDerivedMaps, buildMaterialMasks,
  generateFullGrid, gradientColor, divergingColor, heightColor, maskColor,
  buildHeightfieldMesh,
  createDensityNoiseSampler,
  DENSITY_DEFAULT_CONFIG, DENSITY_FIELD_GROUPS, DENSITY_FIELD_RANGES, densityFieldLabel, densityFieldDescription,
  buildDensityField3D,
  marchingCubes,
  GRASS_DENSITY, grassDensityForIds,
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

let everyFieldHasDescription = true;
for (const name of allFieldNames) {
  const desc = fieldDescription(name);
  if (typeof desc !== 'string' || desc.length < 10) everyFieldHasDescription = false;
}
ok(everyFieldHasDescription, '2: every FIELD_GROUPS field has a non-trivial fieldDescription');

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

// --- Task 8: colormap helpers ---
{
  const stops = [[0, [0, 0, 0]], [1, [255, 255, 255]]];
  const black = gradientColor(0, stops, 0, 1);
  const white = gradientColor(1, stops, 0, 1);
  ok(JSON.stringify(black) === JSON.stringify([0, 0, 0]), '8: gradientColor at lo returns first stop');
  ok(JSON.stringify(white) === JSON.stringify([255, 255, 255]), '8: gradientColor at hi returns last stop');
  const mid = gradientColor(0.5, stops, 0, 1);
  ok(Math.abs(mid[0] - 127.5) < 1, '8: gradientColor midpoint interpolates');

  const lowDiv = divergingColor(-1);
  const highDiv = divergingColor(1);
  ok(JSON.stringify(lowDiv) === JSON.stringify([35, 72, 135]), '8: divergingColor(-1) matches color_maps.py stop');
  ok(JSON.stringify(highDiv) === JSON.stringify([142, 65, 45]), '8: divergingColor(1) matches color_maps.py stop');

  const seaColor = heightColor(-50, 0);
  const peakColor = heightColor(200, 0);
  ok(JSON.stringify(seaColor) !== JSON.stringify(peakColor), '8: heightColor differs well below vs above sea level');

  const off = maskColor(0, [96, 190, 255]);
  const on = maskColor(1, [96, 190, 255]);
  ok(JSON.stringify(off) === JSON.stringify([18, 22, 26]), '8: maskColor(0) is the base color');
  ok(JSON.stringify(on) === JSON.stringify([96, 190, 255]), '8: maskColor(1) is the target color');
}

// --- Task 1 (Phase C): buildHeightfieldMesh ---
{
  const res = 3;
  const height = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]); // flat
  const { positions, normals, indices } = buildHeightfieldMesh(height, res, 200, 200);

  ok(positions.length === res * res * 3, '1 (Phase C): positions has 3 floats per vertex');
  ok(normals.length === res * res * 3, '1 (Phase C): normals has 3 floats per vertex');
  const quadsPerAxis = res - 1;
  ok(indices.length === quadsPerAxis * quadsPerAxis * 6, '1 (Phase C): indices has 6 per quad');

  ok(Math.abs(positions[0] - (-100)) < 1e-6 && Math.abs(positions[1] - 0) < 1e-6 && Math.abs(positions[2] - (-100)) < 1e-6,
    '1 (Phase C): vertex 0 lands at the expected world corner');
  const centerIdx = 4;
  ok(Math.abs(positions[centerIdx * 3] - 0) < 1e-6 && Math.abs(positions[centerIdx * 3 + 2] - 0) < 1e-6,
    '1 (Phase C): center vertex lands at world origin on x/z');

  let allUp = true;
  for (let i = 0; i < res * res; i++) {
    if (Math.abs(normals[i * 3] - 0) > 1e-5 || Math.abs(normals[i * 3 + 1] - 1) > 1e-5 || Math.abs(normals[i * 3 + 2] - 0) > 1e-5) allUp = false;
  }
  ok(allUp, '1 (Phase C): flat terrain has every normal pointing straight up (0,1,0)');

  let allUnit = true;
  for (let i = 0; i < res * res; i++) {
    const len = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
    if (Math.abs(len - 1) > 1e-5) allUnit = false;
  }
  ok(allUnit, '1 (Phase C): every normal is unit length');
}
{
  const res = 5;
  const height = new Float32Array(res * res);
  for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) height[iz * res + ix] = ix * 10;
  const { normals } = buildHeightfieldMesh(height, res, 400, 400);
  const centerIdx = 2 * res + 2;
  ok(normals[centerIdx * 3] < -0.01, '1 (Phase C): a rising-with-x ramp tilts the normal toward -x');
  ok(normals[centerIdx * 3 + 2] > -1e-5 && normals[centerIdx * 3 + 2] < 1e-5, '1 (Phase C): a ramp with no z variation has zero normal.z');
}
console.log('Task 1 (Phase C: buildHeightfieldMesh) OK');

// --- Task 1 (Phase D): 3D value noise ---
{
  const sampler = createDensityNoiseSampler();
  const v1 = sampler.fbm3(42, 100, 400, 300, 400, 10, 20, 30);
  ok(typeof v1 === 'number' && v1 >= -1 && v1 <= 1, '1 (Phase D): fbm3 returns a number in [-1, 1]');

  const sampler2 = createDensityNoiseSampler();
  const v2 = sampler2.fbm3(42, 100, 400, 300, 400, 10, 20, 30);
  ok(v1 === v2, '1 (Phase D): fbm3 is deterministic for the same seed/period/point');

  const v3 = sampler2.fbm3(43, 100, 400, 300, 400, 10, 20, 30);
  ok(v1 !== v3, '1 (Phase D): fbm3 differs for a different seed');

  const vSame = sampler2.fbm3(42, 100, 400, 300, 400, 10, 20, 30);
  ok(v1 === vSame, '1 (Phase D): repeated calls on the same sampler instance are cached/deterministic');
}

// --- Task 2 (Phase D): density config schema ---
ok(DENSITY_DEFAULT_CONFIG.density_resolution === 96, '2 (Phase D): DENSITY_DEFAULT_CONFIG.density_resolution matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.y_min === -96.0, '2 (Phase D): DENSITY_DEFAULT_CONFIG.y_min matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.y_max === 192.0, '2 (Phase D): DENSITY_DEFAULT_CONFIG.y_max matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.warp_period === 187.0, '2 (Phase D): DENSITY_DEFAULT_CONFIG.warp_period matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.cave_threshold === 0.55, '2 (Phase D): DENSITY_DEFAULT_CONFIG.cave_threshold matches density_config.py');
ok(DENSITY_DEFAULT_CONFIG.floor_thickness === 4.0, '2 (Phase D): DENSITY_DEFAULT_CONFIG.floor_thickness matches density_config.py');

const densityGroupNames = DENSITY_FIELD_GROUPS.map((g) => g.name);
ok(JSON.stringify(densityGroupNames) === JSON.stringify(['Grid', 'Warp', 'Caves', 'Floor']),
  '2 (Phase D): DENSITY_FIELD_GROUPS names/order match the design spec');

const densityFieldNames = DENSITY_FIELD_GROUPS.flatMap((g) => g.fields);
ok(densityFieldNames.length === 12, '2 (Phase D): four groups list 12 fields total');
let densityFieldsValid = true;
for (const name of densityFieldNames) {
  if (!(name in DENSITY_DEFAULT_CONFIG)) densityFieldsValid = false;
  if (!(name in DENSITY_FIELD_RANGES)) densityFieldsValid = false;
}
ok(densityFieldsValid, '2 (Phase D): every DENSITY_FIELD_GROUPS field has a DENSITY_DEFAULT_CONFIG value and a DENSITY_FIELD_RANGES entry');

const [dLo, dHi, dStep] = DENSITY_FIELD_RANGES.density_resolution;
ok(dLo === 32 && dHi === 160 && dStep === 8, '2 (Phase D): density_resolution range matches density_config.py (32-160 step 8)');
const [wpLo, wpHi, wpStep] = DENSITY_FIELD_RANGES.warp_period;
ok(wpLo === 20 && wpHi === 600 && wpStep === 1, '2 (Phase D): warp_period range matches density_config.py (20-600 step 1)');
const [cpLo, cpHi, cpStep] = DENSITY_FIELD_RANGES.cave_period;
ok(cpLo === 20 && cpHi === 400 && cpStep === 5, '2 (Phase D): cave_period range matches density_config.py (20-400 step 5)');

ok(densityFieldLabel('density_resolution') === 'voxel res', '2 (Phase D): densityFieldLabel looks up DENSITY_FIELD_LABELS');
ok(densityFieldLabel('cave_threshold') === 'cave threshold', '2 (Phase D): densityFieldLabel looks up DENSITY_FIELD_LABELS (2)');

let everyDensityFieldHasDescription = true;
for (const name of densityFieldNames) {
  const desc = densityFieldDescription(name);
  if (typeof desc !== 'string' || desc.length < 10) everyDensityFieldHasDescription = false;
}
ok(everyDensityFieldHasDescription, '2 (Phase D): every DENSITY_FIELD_GROUPS field has a non-trivial densityFieldDescription');

// --- Task 3 (Phase D): buildDensityField3D ---
{
  // Flat height field, warp/cave disabled, no floor bias -- density should reduce to the
  // macro height - y - iso_level term: positive (solid) below the flat height, negative
  // (air) above it.
  const res = 8;
  const flatHeight = { height: new Float32Array(res * res).fill(50.0), resolution: res };
  const cfg = {
    ...DENSITY_DEFAULT_CONFIG,
    density_resolution: res, y_min: 0, y_max: 100, iso_level: 0,
    warp_strength_surface: 0, warp_strength_global: 0, cave_strength: 0, floor_thickness: 0,
  };
  const density = buildDensityField3D(flatHeight, cfg, 400, 400, 1337);
  ok(density.length === res * res * res, '3 (Phase D): buildDensityField3D returns a res^3-length array');

  // iy=0 -> y=0 (below the flat height of 50) should be solid (positive)
  ok(density[0 + 0 * res + 0 * res * res] > 0, '3 (Phase D): a voxel well below the flat height is solid (positive density)');
  // iy=res-1 -> y=100 (above the flat height of 50) should be air (negative)
  const topIy = res - 1;
  ok(density[0 + topIy * res + 0 * res * res] < 0, '3 (Phase D): a voxel well above the flat height is air (negative density)');
}
{
  // floor_thickness sanity check: with a large floor_thickness, the bottom-most layer
  // (iy=0, at y_min) must be strongly positive (solid) regardless of height/warp/cave.
  const res = 8;
  const flatHeight = { height: new Float32Array(res * res).fill(-10.0), resolution: res }; // height below y_min, so the macro term alone would be air
  const cfg = {
    ...DENSITY_DEFAULT_CONFIG,
    density_resolution: res, y_min: 0, y_max: 100, iso_level: 0,
    warp_strength_surface: 0, warp_strength_global: 0, cave_strength: 0, floor_thickness: 20,
  };
  const density = buildDensityField3D(flatHeight, cfg, 400, 400, 1337);
  ok(density[0 + 0 * res + 0 * res * res] > 0, '3 (Phase D): floor_thickness forces the bottom layer solid even when the macro term alone would be air');
}

// --- Task 4 (Phase D): marchingCubes ---
{
  // All-positive density (fully solid) -- no surface crossing, expect zero output.
  const res = 4;
  const density = new Float32Array(res * res * res).fill(5.0);
  const { positions, indices } = marchingCubes(density, res, 10, 10, 10, 0, 0, 0, 0.0);
  ok(positions.length === 0 && indices.length === 0, '4 (Phase D): an all-solid density field produces no geometry');
}
{
  // All-negative density (fully air) -- no surface crossing, expect zero output.
  const res = 4;
  const density = new Float32Array(res * res * res).fill(-5.0);
  const { positions, indices } = marchingCubes(density, res, 10, 10, 10, 0, 0, 0, 0.0);
  ok(positions.length === 0 && indices.length === 0, '4 (Phase D): an all-air density field produces no geometry');
}
{
  // Perfect sphere: density = R - distance_from_center. The extracted surface should be
  // very close to radius R from the center at every vertex (the standard marching-cubes
  // sanity check), and the vertex count should be roughly 2x the triangle count / ... in
  // general triangleCount should be positive and vertex-welding should keep vertexCount
  // well below 3*triangleCount (proof the shared-vertex cache is actually deduplicating).
  const res = 24;
  const R = 8;
  const center = (res - 1) / 2;
  const density = new Float32Array(res * res * res);
  for (let iz = 0; iz < res; iz++) {
    for (let iy = 0; iy < res; iy++) {
      for (let ix = 0; ix < res; ix++) {
        const dist = Math.hypot(ix - center, iy - center, iz - center);
        density[ix + iy * res + iz * res * res] = R - dist;
      }
    }
  }
  const originX = -center, originY = -center, originZ = -center;
  const { positions, indices } = marchingCubes(density, res, 1, 1, 1, originX, originY, originZ, 0.0);
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  ok(triangleCount > 0, '4 (Phase D): a sphere density field produces triangles');
  ok(vertexCount < triangleCount * 1.5, '4 (Phase D): shared-vertex welding keeps vertex count well below 3x triangle count');

  let maxError = 0;
  for (let i = 0; i < vertexCount; i++) {
    const dist = Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    maxError = Math.max(maxError, Math.abs(dist - R));
  }
  ok(maxError < 1.0, `4 (Phase D): every extracted vertex is within 1.0 of the true sphere radius (max error ${maxError.toFixed(3)})`);
}

// --- Task 5 (Phase D): grassDensityForIds ---
{
  ok(GRASS_DENSITY.forest === 0.85, '5 (Phase D): GRASS_DENSITY.forest matches biome_density.py');
  ok(GRASS_DENSITY.desert === 0.0, '5 (Phase D): GRASS_DENSITY.desert matches biome_density.py');
  ok(GRASS_DENSITY.jungle === 0.95, '5 (Phase D): GRASS_DENSITY.jungle matches biome_density.py');

  const biomeId = new Uint8Array([BIOME_INDEX.forest, BIOME_INDEX.desert]);
  const waterMask = new Float32Array([0.0, 0.0]);
  const density = grassDensityForIds(biomeId, waterMask);
  ok(Math.abs(density[0] - 0.85) < 1e-6, '5 (Phase D): grassDensityForIds looks up GRASS_DENSITY by biome (dry forest cell)');
  ok(Math.abs(density[1] - 0.0) < 1e-6, '5 (Phase D): grassDensityForIds looks up GRASS_DENSITY by biome (dry desert cell)');

  const wetBiomeId = new Uint8Array([BIOME_INDEX.forest]);
  const fullWater = new Float32Array([1.0]);
  const wetDensity = grassDensityForIds(wetBiomeId, fullWater);
  ok(Math.abs(wetDensity[0]) < 1e-6, '5 (Phase D): grassDensityForIds zeroes out fully-water cells regardless of biome');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
