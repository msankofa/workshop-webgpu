// test-deadfall-geometry.mjs -- decay monotonicity (rotten cross-section < mossy < fresh),
// finite/indexed geometry, shelf-fungi attach only on mossy/rotten logs, mushroom parts, and
// createDeadfallPalette data-drivenness. Pure geometry (no GPU); `node test-deadfall-geometry.mjs`.
import {
  buildLog, buildStump, buildMushroom, createDeadfallPalette, DEFAULT_DEADFALL_TYPES, DECAY_WEIGHT,
} from './deadfall.js';
import { rngFrom } from './forest-placement.js';

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

function yExtent(geo) {
  const p = geo.getAttribute('position');
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); mn = Math.min(mn, y); mx = Math.max(mx, y); }
  return mx - mn;
}
function allFinite(geo) {
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (!Number.isFinite(p.getX(i)) || !Number.isFinite(p.getY(i)) || !Number.isFinite(p.getZ(i))) return false;
  return true;
}
function unitNormals(geo) {
  const n = geo.getAttribute('normal');
  for (let i = 0; i < n.count; i++) { const l = Math.hypot(n.getX(i), n.getY(i), n.getZ(i)); if (Math.abs(l - 1) > 1e-3) return false; }
  return true;
}
function countC1(geo, val, eps = 1e-3) {
  const a = geo.getAttribute('aC1'); let c = 0;
  for (let i = 0; i < a.count; i++) if (Math.abs(a.getX(i) - val) < eps) c++;
  return c;
}

// ---- 1: decay monotonicity -- rotten cross-section < mossy < fresh (shelf off to isolate tube).
// Same seed for each so ONLY decay differs.
const SEED = 424242;
const fresh = buildLog({ rng: rngFrom(SEED), decay: 'fresh', shelf: false }).geometry;
const mossy = buildLog({ rng: rngFrom(SEED), decay: 'mossy', shelf: false }).geometry;
const rotten = buildLog({ rng: rngFrom(SEED), decay: 'rotten', shelf: false }).geometry;
const yF = yExtent(fresh), yM = yExtent(mossy), yR = yExtent(rotten);
ok(yR < yM && yM < yF, `1: cross-section monotonic rotten<mossy<fresh (${yR.toFixed(3)} < ${yM.toFixed(3)} < ${yF.toFixed(3)})`);

// ---- 2: finite + indexed + unit normals for all builders ----
const stump = buildStump({ rng: rngFrom(7) }).geometry;
const mush = buildMushroom({ rng: rngFrom(9), kind: 'cap' }).geometry;
for (const [name, g] of [['fresh log', fresh], ['rotten log', rotten], ['stump', stump], ['mushroom', mush]]) {
  ok(g.getIndex() != null, `2: ${name} is indexed`);
  ok(allFinite(g), `2: ${name} positions finite`);
  ok(unitNormals(g), `2: ${name} normals unit length`);
  ok(g.boundingSphere && Number.isFinite(g.boundingSphere.radius), `2: ${name} has bounding sphere`);
}

// ---- 3: baked decay weight (aC0) matches the decay state on the tube verts ----
function tubeDecay(geo) {
  // tube verts have aC1==0 (non-shelf); read their aC0 (should be uniform = DECAY_WEIGHT)
  const c0 = geo.getAttribute('aC0'), c1 = geo.getAttribute('aC1');
  for (let i = 0; i < c0.count; i++) if (c1.getX(i) < 0.5) return c0.getX(i);
  return NaN;
}
ok(Math.abs(tubeDecay(fresh) - DECAY_WEIGHT.fresh) < 1e-3, '3: fresh log aC0 == 0.15');
ok(Math.abs(tubeDecay(mossy) - DECAY_WEIGHT.mossy) < 1e-3, '3: mossy log aC0 == 0.8');
ok(Math.abs(tubeDecay(rotten) - DECAY_WEIGHT.rotten) < 1e-3, '3: rotten log aC0 == 1.0');
ok(tubeDecay(rotten) > tubeDecay(mossy) && tubeDecay(mossy) > tubeDecay(fresh), '3: decay weight monotone rotten>mossy>fresh');

// ---- 4: shelf fungi (aC1==1) attach ONLY on mossy/rotten logs, never fresh ----
const freshShelf = buildLog({ rng: rngFrom(SEED), decay: 'fresh', shelf: true }).geometry;
const mossyShelf = buildLog({ rng: rngFrom(SEED), decay: 'mossy', shelf: true }).geometry;
const rottenShelf = buildLog({ rng: rngFrom(SEED), decay: 'rotten', shelf: true }).geometry;
ok(countC1(freshShelf, 1) === 0, '4: fresh log has NO shelf-fungus verts even with shelf:true');
ok(countC1(mossyShelf, 1) > 0, '4: mossy log has shelf-fungus verts');
ok(countC1(rottenShelf, 1) > 0, '4: rotten log has shelf-fungus verts');

// ---- 5: mushroom part channel (aC0) spans stem(0)/gills(0.5)/cap(1) ----
function hasNear(geo, attr, val, eps = 0.05) {
  const a = geo.getAttribute(attr);
  for (let i = 0; i < a.count; i++) if (Math.abs(a.getX(i) - val) < eps) return true;
  return false;
}
ok(hasNear(mush, 'aC0', 0) && hasNear(mush, 'aC0', 0.5) && hasNear(mush, 'aC0', 1), '5: mushroom has stem/gill/cap parts');
const shelfMush = buildMushroom({ rng: rngFrom(9), kind: 'shelf' }).geometry;
ok(shelfMush.getAttribute('aC0').count < mush.getAttribute('aC0').count, '5: shelf mushroom (half-arc, no stem) has fewer verts than a full cap');

// ---- 6: determinism -- same seed => byte-identical positions + aux channels ----
function sameGeo(a, b) {
  for (const attr of ['position', 'aC0', 'aC1']) {
    const pa = a.getAttribute(attr).array, pb = b.getAttribute(attr).array;
    if (pa.length !== pb.length) return false;
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return false;
  }
  return true;
}
ok(sameGeo(buildLog({ rng: rngFrom(55), decay: 'mossy' }).geometry, buildLog({ rng: rngFrom(55), decay: 'mossy' }).geometry), '6: buildLog deterministic for a fixed seed');
ok(sameGeo(buildStump({ rng: rngFrom(66) }).geometry, buildStump({ rng: rngFrom(66) }).geometry), '6: buildStump deterministic');

// ---- 7: createDeadfallPalette is data-driven (arbitrary type table, no code changes) ----
const pal = createDeadfallPalette({ masterSeed: 3 });
ok(pal.variants.length === DEFAULT_DEADFALL_TYPES.reduce((s, t) => s + (t.seedsPerType ?? 1), 0), '7: default palette bakes sum(seedsPerType) variants');
ok(pal.types.every((t) => t.startIdx + t.count <= pal.variants.length), '7: type startIdx/count index into variants');
const logRottenType = pal.types.find((t) => t.decayClass === 'rotten');
ok(logRottenType && pal.variants[logRottenType.startIdx].kind === 'log', '7: rotten log type present in palette');
// a custom 7-entry table with extra decay seeds -- scales with zero code changes
const custom = createDeadfallPalette({
  masterSeed: 1,
  types: [
    { key: 'a', kind: 'log', seedsPerType: 4, log: { decay: 'rotten', shelf: true } },
    { key: 'b', kind: 'stump', seedsPerType: 3 },
    { key: 'c', kind: 'mushroom', seedsPerType: 5, mushroom: { mushKind: 'cap' } },
  ],
});
ok(custom.variants.length === 12, '7: custom 3-type/12-seed table scales (no hardcoded cap)');
ok(custom.types[0].kind === 'log' && custom.types[2].kind === 'mushroom', '7: custom type kinds preserved');

// ---- 8: triangle winding -- for a closed log/stump, side-wall triangle face normals (computed
// from vertex order, NOT the baked vertex normals) must point OUTWARD from the tube's local
// segment center, i.e. dot(faceNormal, vertexPos - segmentCenter) > 0. This is the actual
// index-winding signal a renderer's backface cull sees; it is independent of the explicit
// per-vertex normals Grower bakes (those are always correct per the file's own header comment,
// which is exactly why a winding bug can hide behind them under DoubleSide). Side-wall quads
// (`g.quad(a[k], b[k], b[k2], a[k2])` in sweepTube) span exactly TWO adjacent rings (rows sharing
// a uv.y value), never three, so `segmentCenter` for a sampled triangle is the centroid of every
// vertex belonging to the ring(s) its 3 corners touch (1 or 2 rings) -- a generic,
// geometry-agnostic stand-in for the sweep's centerline point near that triangle. Cap-fan
// triangles (which touch a lone apex vertex outside any >=3-vertex ring) are skipped.
function sampleWindingOutward(geo) {
  const pos = geo.getAttribute('position');
  const uvAttr = geo.getAttribute('uv');
  const idx = geo.getIndex().array;
  const v3 = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)];
  const vY = (i) => uvAttr.getY(i);
  // bucket vertex indices by rounded uv.y ("ring")
  const RING_EPS = 1e-3;
  const ringKey = (y) => Math.round(y / RING_EPS);
  const ringBuckets = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = ringKey(vY(i));
    if (!ringBuckets.has(k)) ringBuckets.set(k, []);
    ringBuckets.get(k).push(i);
  }
  // only keys with >=3 verts are real swept rings (cap apex vertices are lone singletons)
  const ringCentroid = new Map();
  for (const [k, bucket] of ringBuckets) {
    if (bucket.length < 3) continue;
    let cx = 0, cy = 0, cz = 0;
    for (const i of bucket) { const [x, y, z] = v3(i); cx += x; cy += y; cz += z; }
    ringCentroid.set(k, [cx / bucket.length, cy / bucket.length, cz / bucket.length]);
  }
  let checked = 0, outward = 0;
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const keys = [...new Set([ringKey(vY(a)), ringKey(vY(b)), ringKey(vY(c))])];
    const rings = keys.map((k) => ringCentroid.get(k)).filter(Boolean);
    if (rings.length === 0 || keys.length !== rings.length) continue; // touches a cap apex -- skip
    const center = rings.length === 1
      ? rings[0]
      : [
          rings.reduce((s, r) => s + r[0], 0) / rings.length,
          rings.reduce((s, r) => s + r[1], 0) / rings.length,
          rings.reduce((s, r) => s + r[2], 0) / rings.length,
        ];
    const pa = v3(a), pb = v3(b), pc = v3(c);
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const faceN = cross3(e1[0], e1[1], e1[2], e2[0], e2[1], e2[2]);
    const out = [pa[0] - center[0], pa[1] - center[1], pa[2] - center[2]];
    const d = faceN[0] * out[0] + faceN[1] * out[1] + faceN[2] * out[2];
    checked++;
    if (d > 0) outward++;
  }
  return { checked, outward };
}
function cross3(ax, ay, az, bx, by, bz) { return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]; }

const windLog = sampleWindingOutward(buildLog({ rng: rngFrom(11), decay: 'mossy', shelf: false }).geometry);
ok(windLog.checked > 0, '8: log winding test sampled side-wall triangles');
ok(windLog.outward === windLog.checked, `8: log side-wall triangles wind outward (${windLog.outward}/${windLog.checked})`);

const windStump = sampleWindingOutward(buildStump({ rng: rngFrom(12) }).geometry);
ok(windStump.checked > 0, '8: stump winding test sampled side-wall triangles');
ok(windStump.outward === windStump.checked, `8: stump side-wall triangles wind outward (${windStump.outward}/${windStump.checked})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
