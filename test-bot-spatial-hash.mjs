// Node tests for the bot spatial hash (Phase 2 of the 2026-07-25 bot-viewer perf audit):
// circle/segment queries vs. brute force, rebuild reuse across frames, and the hashed separation/
// contested/pushout variants vs. their O(n^2) originals on seeded fixtures.
// Run: node test-bot-spatial-hash.mjs
import { createBotSpatialHash } from './bot-spatial-hash.js';
import {
  resolveBotPairs, separationXZ, waypointContested,
  resolveBotPairsHashed, separationXZHashed, waypointContestedHashed,
} from './bot-separation.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

const R = 0.3; // default capsule radius in bot-entity.js
function makeBot(id, { x, y = 0, z }, radius = R) {
  return {
    id, alive: true,
    capsule: { radius, start: { x, y: y + radius, z }, end: { x, y: y + 1.8 - radius, z } },
  };
}
function cloneBot(b) {
  const c = makeBot(b.id, { x: b.capsule.start.x, z: b.capsule.start.z }, b.capsule.radius);
  c.alive = b.alive;
  return c;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function xzDist(a, b) {
  return Math.hypot(b.capsule.start.x - a.capsule.start.x, b.capsule.start.z - a.capsule.start.z);
}
// Worst pair overlap left in a roster (0 = fully resolved).
function maxOverlap(bots, radius) {
  let worst = 0;
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) {
      const minDist = (radius ?? bots[i].capsule.radius) + (radius ?? bots[j].capsule.radius);
      worst = Math.max(worst, minDist - xzDist(bots[i], bots[j]));
    }
  }
  return worst;
}
// Collect everything a query visits, flagging duplicate visits (each entity lives in one cell).
function collect(runQuery) {
  const seen = new Set();
  let dupes = 0;
  runQuery((e) => { if (seen.has(e)) dupes++; seen.add(e); });
  return { seen, dupes };
}
function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
// Squared distance from p to segment ab, in XZ.
function segDistSq(px, pz, x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - x0) * dx + (pz - z0) * dz) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = x0 + dx * t, cz = z0 + dz * t;
  return (px - cx) ** 2 + (pz - cz) ** 2;
}

// Seeded layout: random bots plus deliberate cell-border straddlers and negative-quadrant bots.
function makeLayout(seed, n, extent = 30) {
  const rand = mulberry32(seed);
  const bots = [];
  for (let i = 0; i < n; i++) {
    bots.push(makeBot(`r${i}`, { x: (rand() * 2 - 1) * extent, z: (rand() * 2 - 1) * extent }));
  }
  for (const c of [-8, -2, 0, 2, 6]) { // exactly on cellSize=2 boundaries, both signs
    bots.push(makeBot(`bx${c}`, { x: c, z: c }));
    bots.push(makeBot(`by${c}`, { x: c, z: -c }));
    bots.push(makeBot(`be${c}`, { x: c - 1e-12, z: c + 1e-12 }));
  }
  return bots;
}

// ---- forEachNear vs brute force ----
{
  const CS = 2;
  const bots = makeLayout(1234, 250);
  const hash = createBotSpatialHash(CS);
  hash.rebuild(bots);
  ok(hash.size === bots.length, 'rebuild indexes every entity');

  const rand = mulberry32(99);
  let misses = 0, dupes = 0, checked = 0;
  for (let q = 0; q < 400; q++) {
    const qx = (rand() * 2 - 1) * 34, qz = (rand() * 2 - 1) * 34;
    const radius = 0.05 + rand() * 7; // spans well under and well over cellSize
    const { seen, dupes: d } = collect((fn) => hash.forEachNear(qx, qz, radius, fn));
    dupes += d;
    for (const b of bots) {
      const inRange = Math.hypot(b.capsule.start.x - qx, b.capsule.start.z - qz) <= radius;
      if (inRange) { checked++; if (!seen.has(b)) misses++; }
    }
  }
  ok(checked > 500, `brute-force in-range hits exercised (${checked})`);
  ok(misses === 0, `forEachNear never misses an entity inside the radius (${misses} missed)`);
  ok(dupes === 0, `forEachNear visits each entity at most once (${dupes} duplicates)`);
}
{
  // Cell-border straddling: a query circle wholly inside one cell must still see the neighbor cell's
  // entity when it sits a hair across the line.
  const hash = createBotSpatialHash(2);
  const inside = makeBot('in', { x: 1.99, z: 0.5 });
  const across = makeBot('across', { x: 2.01, z: 0.5 });
  hash.rebuild([inside, across]);
  const { seen } = collect((fn) => hash.forEachNear(1.99, 0.5, 0.1, fn));
  ok(seen.has(inside) && seen.has(across), 'a query near a cell border sees both sides');
}
{
  const hash = createBotSpatialHash(2);
  const far = makeBot('far', { x: 500, z: -500 });
  hash.rebuild([far]);
  const { seen } = collect((fn) => hash.forEachNear(500, -500, 1, fn));
  ok(seen.has(far), 'unbounded world coords (far negative quadrant) are indexed');
  const { seen: none } = collect((fn) => hash.forEachNear(0, 0, 1, fn));
  ok(none.size === 0, 'an empty neighborhood visits nothing');
}
{
  const hash = createBotSpatialHash(2);
  hash.rebuild([makeBot('a', { x: 0, z: 0 })]);
  let stops = 0;
  const stopped = hash.forEachNear(0, 0, 1, () => { stops++; return true; });
  ok(stopped === true && stops === 1, 'a visitor returning true stops the walk and reports it');
}

// ---- forEachSegment vs brute force ----
{
  const CS = 2;
  const bots = makeLayout(777, 200);
  const hash = createBotSpatialHash(CS);
  hash.rebuild(bots);
  const rand = mulberry32(4242);
  let misses = 0, outOfBand = 0, dupes = 0, checked = 0;
  for (let q = 0; q < 300; q++) {
    const x0 = (rand() * 2 - 1) * 30, z0 = (rand() * 2 - 1) * 30;
    const x1 = x0 + (rand() * 2 - 1) * 20, z1 = z0 + (rand() * 2 - 1) * 20;
    const pad = 0.1 + rand() * 2.5;
    const { seen, dupes: d } = collect((fn) => hash.forEachSegment(x0, z0, x1, z1, pad, fn));
    dupes += d;
    const minX = Math.min(x0, x1) - pad, maxX = Math.max(x0, x1) + pad;
    const minZ = Math.min(z0, z1) - pad, maxZ = Math.max(z0, z1) + pad;
    for (const b of bots) {
      const p = b.capsule.start;
      if (segDistSq(p.x, p.z, x0, z0, x1, z1) <= pad * pad) { checked++; if (!seen.has(b)) misses++; }
    }
    for (const b of seen) { // visited set stays inside the AABB grown by one cell
      const p = b.capsule.start;
      if (p.x < minX - CS || p.x > maxX + CS || p.z < minZ - CS || p.z > maxZ + CS) outOfBand++;
    }
  }
  ok(checked > 200, `brute-force segment hits exercised (${checked})`);
  ok(misses === 0, `forEachSegment never misses an entity within pad of the segment (${misses})`);
  ok(dupes === 0, `forEachSegment visits each entity at most once (${dupes} duplicates)`);
  ok(outOfBand === 0, `forEachSegment stays within the padded AABB + one cell (${outOfBand})`);
}

// ---- rebuild reuse across frames ----
{
  const hash = createBotSpatialHash(2);
  const rand = mulberry32(555);
  const pool = makeLayout(31, 120);
  let bad = 0;
  for (let frame = 0; frame < 30; frame++) {
    const n = 5 + Math.floor(rand() * (pool.length - 5)); // roster grows and shrinks each frame
    const roster = pool.slice(0, n);
    for (const b of roster) { // drift so entities cross cell borders between frames
      b.capsule.start.x += (rand() * 2 - 1) * 1.5;
      b.capsule.start.z += (rand() * 2 - 1) * 1.5;
    }
    hash.rebuild(roster);
    const { seen, dupes } = collect((fn) => hash.forEachNear(0, 0, 200, fn));
    if (dupes !== 0) bad++;
    if (hash.size !== roster.length) bad++;
    if (!sameSet(seen, new Set(roster))) bad++; // no misses, no stale entities from earlier frames
  }
  ok(bad === 0, `rebuild reuse across 30 frames stays exact (${bad} bad frames)`);

  hash.rebuild([]);
  const { seen } = collect((fn) => hash.forEachNear(0, 0, 200, fn));
  ok(hash.size === 0 && seen.size === 0, 'rebuild with an empty roster clears the index');

  const stale = makeLayout(9, 10);
  hash.rebuild(stale);
  for (const b of stale) { b.capsule.start.x += 50; b.capsule.start.z -= 50; } // moved, not re-indexed
  let threw = false;
  try { hash.forEachNear(0, 0, 5, () => {}); hash.forEachSegment(0, 0, 5, 5, 1, () => {}); }
  catch { threw = true; }
  ok(!threw, 'querying a stale (un-rebuilt) hash never throws');
}

// ---- separationXZHashed vs separationXZ ----
{
  const bots = makeLayout(2026, 180, 12); // dense enough that most bots have neighbors
  for (let i = 0; i < bots.length; i += 7) bots[i].alive = false; // dead bots must be skipped
  const hash = createBotSpatialHash(2);
  hash.rebuild(bots);
  let setMismatch = 0, valueMismatch = 0, nonNull = 0;
  for (const radius of [0.8, 1.5, 3.0, 5.5]) {
    for (const self of bots) {
      const expected = new Set();
      for (const other of bots) {
        if (other === self || other.alive === false) continue;
        const d = xzDist(self, other);
        if (d < 1e-6 || d > radius) continue;
        expected.add(other);
      }
      const got = new Set();
      hash.forEachNear(self.capsule.start.x, self.capsule.start.z, radius, (other) => {
        if (other === self || other.alive === false) return;
        const d = xzDist(self, other);
        if (d < 1e-6 || d > radius) return;
        got.add(other);
      });
      if (!sameSet(expected, got)) setMismatch++;

      const a = separationXZ(self, bots, radius);
      const b = separationXZHashed(self, hash, radius);
      if ((a === null) !== (b === null)) { valueMismatch++; continue; }
      if (a) {
        nonNull++;
        if (Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.z - b.z) > 1e-9) valueMismatch++;
      }
    }
  }
  ok(setMismatch === 0, `hashed separation contributor sets match brute force (${setMismatch} off)`);
  ok(nonNull > 100, `separation fixture produced real forces (${nonNull} non-null)`);
  ok(valueMismatch === 0, `separationXZHashed matches separationXZ (${valueMismatch} off)`);

  const lone = makeBot('lone', { x: 900, z: 900 });
  const h2 = createBotSpatialHash(2);
  h2.rebuild([lone, ...bots]);
  ok(separationXZHashed(lone, h2, 1.5) === null, 'no neighbors in radius -> null, as the original');
}

// ---- waypointContestedHashed vs waypointContested ----
{
  const bots = makeLayout(3131, 140, 10);
  for (let i = 0; i < bots.length; i += 5) bots[i].alive = false;
  const hash = createBotSpatialHash(2);
  hash.rebuild(bots);
  const rand = mulberry32(808);
  let mismatch = 0, trues = 0, falses = 0;
  for (let q = 0; q < 600; q++) {
    const self = bots[Math.floor(rand() * bots.length)];
    const waypoint = { x: self.capsule.start.x + (rand() * 2 - 1) * 3, z: self.capsule.start.z + (rand() * 2 - 1) * 3 };
    const wpDist = 0.2 + rand() * 1.5;
    const contactDist = 0.4 + rand() * 2.5;
    const a = waypointContested(self, bots, waypoint, wpDist, contactDist);
    const b = waypointContestedHashed(self, hash, waypoint, wpDist, contactDist);
    if (a !== b) mismatch++;
    if (a) trues++; else falses++;
  }
  ok(trues > 20 && falses > 20, `contested fixture hit both verdicts (${trues} true / ${falses} false)`);
  ok(mismatch === 0, `waypointContestedHashed matches waypointContested (${mismatch} off)`);
}

// ---- resolveBotPairsHashed vs resolveBotPairs ----
{
  // Crowded pile: many overlapping pairs, so pair order genuinely matters.
  const rand = mulberry32(6161);
  const base = [];
  for (let i = 0; i < 90; i++) base.push(makeBot(`p${i}`, { x: (rand() * 2 - 1) * 3.5, z: (rand() * 2 - 1) * 3.5 }));
  const orig = base.map(cloneBot);
  const hashed = base.map(cloneBot);
  const initialOverlap = maxOverlap(base, undefined);
  ok(initialOverlap > 2 * R * 0.5, `pile fixture starts badly overlapped (${initialOverlap.toFixed(3)} m)`);

  const hash = createBotSpatialHash(2);
  const movedO = resolveBotPairs(orig);
  hash.rebuild(hashed);
  const movedH = resolveBotPairsHashed(hashed, hash);
  const resO = maxOverlap(orig, undefined), resH = maxOverlap(hashed, undefined);
  // Pair ORDER differs from the nested loop, so a single pass lands at a comparable -- not
  // identical -- residual; both must be a large improvement on the starting pile.
  ok(resH < initialOverlap && resO < initialOverlap, 'one pass of either pushout reduces the worst overlap');
  ok(resH <= resO * 1.25 + 1e-6, `one hashed pass leaves overlap comparable to the original (${resH.toFixed(4)} vs ${resO.toFixed(4)})`);

  // Every bot that started inside another's radius must be reported moved by both passes.
  const shouldMove = new Set();
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) {
      if (xzDist(base[i], base[j]) < 2 * R) { shouldMove.add(base[i].id); shouldMove.add(base[j].id); }
    }
  }
  const idsO = new Set([...movedO].map((b) => b.id));
  const idsH = new Set([...movedH].map((b) => b.id));
  // Not identical: a differently-ordered pass can resolve a marginal contact before it is tested.
  const shared = [...idsH].filter((id) => idsO.has(id)).length;
  ok(shared >= Math.max(idsO.size, idsH.size) * 0.9,
    `hashed and original pushouts move essentially the same bots (${shared} shared of ${idsO.size}/${idsH.size})`);
  ok([...shouldMove].every((id) => idsH.has(id)), 'every initially overlapping bot is reported moved');

  // Converge: repeated passes (rebuild each frame, as wired) resolve the pile like the original.
  for (let frame = 0; frame < 60; frame++) {
    resolveBotPairs(orig);
    hash.rebuild(hashed);
    resolveBotPairsHashed(hashed, hash);
  }
  const convO = maxOverlap(orig, undefined), convH = maxOverlap(hashed, undefined);
  ok(convO <= 1e-3, `original pile converges (${convO.toFixed(5)} m residual)`);
  ok(convH <= Math.max(convO, 1e-3) * 1.25, `hashed pile converges no worse (${convH.toFixed(5)} vs ${convO.toFixed(5)} m)`);
}
{
  const a = makeBot('a', { x: 2, z: 2 });
  const b = makeBot('b', { x: 2, z: 2 });
  const hash = createBotSpatialHash(2);
  hash.rebuild([a, b]);
  const moved = resolveBotPairsHashed([a, b], hash);
  ok(xzDist(a, b) >= 2 * R - 1e-9 && moved.size === 2, 'coincident bots still separate under the hash');
}
{
  const a = makeBot('a', { x: 0, z: 0 });
  const b = makeBot('b', { x: 0.6, z: 0 });
  const hash = createBotSpatialHash(2);
  hash.rebuild([a, b]);
  const moved = resolveBotPairsHashed([a, b], hash, 0.5);
  ok(moved.size === 2 && xzDist(a, b) >= 1.0 - 1e-9, 'explicit radius override works through the hash');
}
{
  // Extra entities in the hash that are not in the resolve list must be left alone.
  const a = makeBot('a', { x: 0, z: 0 });
  const b = makeBot('b', { x: 0.1, z: 0 });
  const ghost = makeBot('ghost', { x: 0.05, z: 0.05 });
  ghost.alive = false;
  const hash = createBotSpatialHash(2);
  hash.rebuild([a, b, ghost]);
  const moved = resolveBotPairsHashed([a, b], hash);
  ok(!moved.has(ghost) && ghost.capsule.start.x === 0.05 && ghost.capsule.start.z === 0.05,
    'entities absent from the resolve list are never pushed');
  ok(xzDist(a, b) >= 2 * R - 1e-9, 'the listed pair still separates with a stranger in the cell');
}
{
  // Radii differ per bot: the query range must cover the largest possible pair distance.
  const small = makeBot('small', { x: 0, z: 0 }, 0.2);
  const big = makeBot('big', { x: 1.4, z: 0 }, 1.3);
  const hash = createBotSpatialHash(2);
  hash.rebuild([small, big]);
  const moved = resolveBotPairsHashed([small, big], hash);
  ok(moved.size === 2 && xzDist(small, big) >= 1.5 - 1e-9, 'mixed capsule radii are queried at the right range');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-spatial-hash: all assertions passed');
