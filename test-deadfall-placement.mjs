// test-deadfall-placement.mjs -- moisture->decay mapping, slope reject for logs, canopy
// weighting via a mock chunk-bucketed forest, mushroom hard-gate, determinism, collision export.
// Pure logic (no GPU); `node test-deadfall-placement.mjs`.
import {
  deadfallPlacementRecords, makeCanopyIndex, stumpCirclesFromRecords, logCirclesFromRecords,
} from './deadfall-placement.js';

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// ---- fixtures ----
const chunkSize = 32;
function chunkGrid(nx, nz) {
  const chunks = [];
  for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
    chunks.push({ key: `${ix},${iz}`, xMin: ix * chunkSize, zMin: iz * chunkSize, size: chunkSize,
      centerX: ix * chunkSize + chunkSize / 2, centerZ: iz * chunkSize + chunkSize / 2 });
  }
  return chunks;
}
const flatHeight = () => 5;                       // above waterLevel 0, dead flat
const TYPE_TABLE = [
  { key: 'logFresh', kind: 'log', decayClass: 'fresh', density: 1, sizeRange: [0.8, 1.2], nominalLength: 4 },
  { key: 'logMossy', kind: 'log', decayClass: 'mossy', density: 1, sizeRange: [0.8, 1.2], nominalLength: 4 },
  { key: 'logRotten', kind: 'log', decayClass: 'rotten', density: 1, sizeRange: [0.8, 1.2], nominalLength: 4 },
  { key: 'stump', kind: 'stump', density: 1 },
  { key: 'mushroom', kind: 'mushroom', density: 1 },
];
const baseParams = {
  masterSeed: 1, waterLevel: 0, deadfallTypeTable: TYPE_TABLE,
  logDensity: 0.01, stumpDensity: 0.005, mushroomDensity: 0.05,
};

// ---- 1: moisture -> decay class. Wet field -> rotten logs; dry field -> fresh logs. ----
const chunks = chunkGrid(3, 3);
function fieldConst(moisture, upness = 1) { return () => ({ moisture, upness, materialWeights: null }); }
const wetRecs = deadfallPlacementRecords(chunks, baseParams, flatHeight, fieldConst(0.95), null);
const dryRecs = deadfallPlacementRecords(chunks, baseParams, flatHeight, fieldConst(0.1), null);
const wetLogs = wetRecs.filter((r) => r.kind === 'log');
const dryLogs = dryRecs.filter((r) => r.kind === 'log');
ok(wetLogs.length > 0 && wetLogs.every((r) => r.decayClass === 'rotten'), '1: wet ground -> all logs rotten');
ok(dryLogs.length > 0 && dryLogs.every((r) => r.decayClass === 'fresh'), '1: dry ground -> all logs fresh');

// ---- 2: slope rejects logs (1-upness > slopeReject) but not stumps ----
const steepField = () => ({ moisture: 0.6, upness: 0.3, materialWeights: null }); // slope 0.7 > 0.5
const steepRecs = deadfallPlacementRecords(chunks, baseParams, flatHeight, steepField, null);
ok(steepRecs.filter((r) => r.kind === 'log').length === 0, '2: steep slope rejects all logs');
ok(steepRecs.filter((r) => r.kind === 'stump').length > 0, '2: steep slope still allows stumps');

// ---- 3: canopy weighting -- logs concentrate near trees, sparse in the open ----
// Forest records: a dense cluster of trunks in chunk (1,1), none elsewhere.
const forestRecs = [];
for (let i = 0; i < 40; i++) forestRecs.push({ x: 48 + (i % 8), z: 48 + Math.floor(i / 8), chunkKey: '1,1' });
const canopy = makeCanopyIndex(forestRecs, chunkSize, { canopyRadius: 9 });
const canopyParams = { ...baseParams, logDensity: 0.03, canopyLogWeight: 0.0, mushroomDensity: 0 };
const cRecs = deadfallPlacementRecords(chunks, canopyParams, flatHeight, fieldConst(0.6), canopy.canopyAt);
const nearTrees = cRecs.filter((r) => r.kind === 'log' && Math.hypot(r.x - 51, r.z - 51) < 12).length;
const farFromTrees = cRecs.filter((r) => r.kind === 'log' && Math.hypot(r.x - 51, r.z - 51) > 30).length;
ok(nearTrees > 0, '3: logs appear under the tree cluster');
ok(farFromTrees === 0, '3: NO logs far from any tree when canopy floor is 0 (canopy gating works)');

// canopyAt only scans 3x3 neighbor chunks (bounded) -- sanity: a query far from all trees is 0.
ok(canopy.canopyAt(5, 5).weight === 0, '3: canopy weight 0 in an empty region');
ok(canopy.canopyAt(51, 51).weight > 0.5, '3: canopy weight high inside the cluster');

// ---- 4: mushrooms HARD-gate on moisture x canopy -- none in dry OR open ground ----
const mushParams = { ...baseParams, logDensity: 0, stumpDensity: 0, mushroomDensity: 0.2 };
const dryMush = deadfallPlacementRecords(chunks, mushParams, flatHeight, fieldConst(0.2), canopy.canopyAt);
ok(dryMush.filter((r) => r.kind === 'mushroom').length === 0, '4: dry ground -> no mushrooms');
const wetOpenMush = deadfallPlacementRecords(chunks, mushParams, flatHeight, fieldConst(0.95), canopy.canopyAt);
const mushNear = wetOpenMush.filter((r) => r.kind === 'mushroom' && Math.hypot(r.x - 51, r.z - 51) < 12).length;
const mushFar = wetOpenMush.filter((r) => r.kind === 'mushroom' && Math.hypot(r.x - 51, r.z - 51) > 30).length;
ok(mushNear > 0, '4: wet + canopy -> mushrooms cluster under trees');
ok(mushFar === 0, '4: wet but open (no canopy) -> no mushrooms');

// ---- 5: seating + tilt -- logs seated at lowest footprint on a slope, tilted ----
function rampHeight(x) { return x * 0.5; }         // steady ramp: dh/dx = 0.5
const rampParams = { ...baseParams, mushroomDensity: 0, stumpDensity: 0, logDensity: 0.02, slopeRejectLogs: 1 };
const rampRecs = deadfallPlacementRecords(chunks, rampParams, (x) => rampHeight(x), fieldConst(0.6, 0.9), null);
const rlog = rampRecs.find((r) => r.kind === 'log');
ok(rlog && rlog.y <= rampHeight(rlog.x) + 1e-6, '5: log seated at/below its center height (lowest footprint)');
ok(rlog && Math.abs(rlog.tiltZ) > 0.01, '5: log tilted to the ramp normal (non-zero tiltZ)');

// ---- 5b: tilt DIRECTION -- dressing-gpu.js's rotateXZY applies tiltX/tiltZ BEFORE yaw, so a
// log's rendered long axis must be tilted along its OWN post-yaw heading, not always along raw
// world-X. Reimplement rotateXZY exactly (mirrors dressing-gpu.js) and, for every accepted log
// (many different yaws), rotate its local +X axis and check the resulting axis is parallel to
// the ramp surface: its world-Y "climb" per unit horizontal travel must match the ramp's real
// slope sampled along that same post-yaw heading. Before the fix, tiltZ/tiltX were computed from
// raw world dh/dx, dh/dz regardless of yaw, so this would fail for any yaw far from 0.
function rotateXZYcpu(v, cx, sx, cz, sz, cy, sy) {
  const x1 = v.x, y1 = v.y * cx - v.z * sx, z1 = v.y * sx + v.z * cx;
  const x2 = x1 * cz - y1 * sz, y2 = x1 * sz + y1 * cz, z2 = z1;
  const x3 = x2 * cy + z2 * sy, y3 = y2, z3 = z2 * cy - x2 * sy;
  return { x: x3, y: y3, z: z3 };
}
const rampLogs = rampRecs.filter((r) => r.kind === 'log');
ok(rampLogs.length >= 4, '5b: enough ramp logs to exercise a spread of yaws');
const yawSpread = Math.max(...rampLogs.map((r) => r.yaw)) - Math.min(...rampLogs.map((r) => r.yaw));
ok(yawSpread > 1.0, '5b: sampled logs actually cover a spread of yaws (not all near 0)');
let worstErr = 0;
for (const r of rampLogs) {
  const cy = Math.cos(r.yaw), sy = Math.sin(r.yaw);
  const cx = Math.cos(r.tiltX), sx = Math.sin(r.tiltX);
  const cz = Math.cos(r.tiltZ), sz = Math.sin(r.tiltZ);
  const axis = rotateXZYcpu({ x: 1, y: 0, z: 0 }, cx, sx, cz, sz, cy, sy);
  const horizLen = Math.hypot(axis.x, axis.z);
  const axisSlope = axis.y / horizLen;                 // tan of the rendered axis's climb
  const dirx = axis.x / horizLen;                       // rampHeight only depends on x
  const d = 0.5;
  const trueSlope = (rampHeight(r.x + dirx * d) - rampHeight(r.x - dirx * d)) / (2 * d);
  worstErr = Math.max(worstErr, Math.abs(axisSlope - trueSlope));
}
ok(worstErr < 0.02, `5b: every log's rendered long axis matches the ramp slope along its own heading (worst err ${worstErr.toFixed(4)})`);

// ---- 6: determinism -- same seed/params => byte-stable records ----
const a = deadfallPlacementRecords(chunks, baseParams, flatHeight, fieldConst(0.6), canopy.canopyAt);
const b = deadfallPlacementRecords(chunks, baseParams, flatHeight, fieldConst(0.6), canopy.canopyAt);
ok(JSON.stringify(a) === JSON.stringify(b), '6: placement byte-stable for a fixed seed');

// ---- 7: record shape + collision export ----
ok(a.every((r) => 'x' in r && 'y' in r && 'z' in r && 'scale' in r && 'yaw' in r && 'extra' in r && 'variant' in r && 'kind' in r),
  '7: records carry the dressing-gpu shape (x/y/z/scale/yaw/extra) + variant/kind');
ok(a.filter((r) => r.kind === 'log').every((r) => r.footprintLen > 0), '7: log records carry footprintLen for collision');
const stumpCircles = stumpCirclesFromRecords(a);
ok(stumpCircles.length === a.filter((r) => r.kind === 'stump').length, '7: stumpCircles one-per-stump');
ok(stumpCircles.every((c) => 'x' in c && 'z' in c && 'r' in c), '7: stump circles are {x,z,r}');
const logCircles = logCirclesFromRecords(a, { circles: 3 });
ok(logCircles.length === a.filter((r) => r.kind === 'log').length * 3, '7: logCircles = 3 per log along the axis');
ok(logCircles.every((c) => 'x' in c && 'z' in c && 'r' in c && c.r > 0), '7: log circles are {x,z,r}');

// ---- 8: empty type table -> no records; missing surfaceField -> defaults, no crash ----
ok(deadfallPlacementRecords(chunks, { ...baseParams, deadfallTypeTable: [] }, flatHeight, null, null).length === 0, '8: empty type table -> empty');
ok(deadfallPlacementRecords(chunks, baseParams, flatHeight, null, null).length > 0, '8: no surfaceField -> defaults, still places');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
