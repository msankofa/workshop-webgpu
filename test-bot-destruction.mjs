// Node tests for bot-destruction.js (wall hit points, the state ladder, fracture patterns).
// Run: node test-bot-destruction.mjs
import {
  WALL_STATE, FRACTURE_PATTERNS, DESTRUCTION_DEFAULTS,
  fracture, blocksSight, wallHitPoints, createDestructibleSet, activeRectsOf, rubbleRectsOf,
  applyWallDamage, makeWallRng, footprintOf, unionBounds, wallAtPoint,
} from './bot-destruction.js';
import { SIGHT_BLOCK_HEIGHT } from './nav-visibility.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

const WALL = { x: 4, z: -2, w: 0.3, d: 9, h: 3 };     // a long thin wall, z is its long axis
const WIDE = { x: -3, z: 5, w: 9, d: 0.3, h: 3 };     // the same wall the other way round

const area = r => r.w * r.d;
const within = (child, parent, slack) =>
  Math.abs(child.x - parent.x) + child.w / 2 <= parent.w / 2 + slack + 1e-9 &&
  Math.abs(child.z - parent.z) + child.d / 2 <= parent.d / 2 + slack + 1e-9;

// ---- fracture geometry ----
for (const rect of [WALL, WIDE]) {
  const label = rect === WALL ? 'z-long' : 'x-long';
  for (const pattern of FRACTURE_PATTERNS) {
    const cut = fracture(rect, pattern, { rng: makeWallRng(7, 1) });
    const all = [...cut.solids, ...cut.rubble];
    ok(all.length > 0, `${label} ${pattern}: emits geometry`);
    ok(all.every(r => r.w > 0 && r.d > 0 && r.h > 0), `${label} ${pattern}: every piece has positive extents`);
    ok(cut.solids.every(r => within(r, rect, 0)), `${label} ${pattern}: solids stay inside the parent footprint`);
    ok(cut.rubble.every(r => within(r, rect, DESTRUCTION_DEFAULTS.rubbleSpread)),
      `${label} ${pattern}: rubble stays within rubbleSpread of the footprint`);
    ok(cut.solids.every(r => r.h <= rect.h + 1e-9), `${label} ${pattern}: nothing ends up taller than the original`);
  }

  // Horizontal: same footprint, short enough to see over. This is the cut that REMOVES cover.
  {
    const cut = fracture(rect, 'horizontal', { rng: makeWallRng(7, 1) });
    ok(cut.solids.length === 1, `${label} horizontal: one stub left standing`);
    const stub = cut.solids[0];
    ok(Math.abs(area(stub) - area(rect)) < 1e-9, `${label} horizontal: the stub keeps the full footprint`);
    ok(stub.h < SIGHT_BLOCK_HEIGHT, `${label} horizontal: the stub is below sight height (${stub.h} < ${SIGHT_BLOCK_HEIGHT})`);
    ok(!blocksSight(stub), `${label} horizontal: the stub does not block sight`);
  }

  // Vertical: full height, half the length. This is the cut that CREATES a corner.
  {
    const cut = fracture(rect, 'vertical', { rng: makeWallRng(7, 1) });
    ok(cut.solids.length === 1, `${label} vertical: one half left standing`);
    const half = cut.solids[0];
    ok(Math.abs(half.h - rect.h) < 1e-9, `${label} vertical: the standing half keeps full height`);
    ok(blocksSight(half), `${label} vertical: the standing half still blocks sight`);
    ok(Math.abs(area(half) - area(rect) / 2) < 1e-6, `${label} vertical: the standing half is half the footprint`);
  }

  // Diagonal: a descending staircase, because nothing downstream reads a slant.
  {
    const cut = fracture(rect, 'diagonal', { rng: makeWallRng(7, 1) });
    ok(cut.solids.length === DESTRUCTION_DEFAULTS.stairSteps, `${label} diagonal: one rect per stair step`);
    const heights = cut.solids.map(r => r.h);
    const rising = heights.every((h, i) => i === 0 || h >= heights[i - 1] - 1e-9);
    const falling = heights.every((h, i) => i === 0 || h <= heights[i - 1] + 1e-9);
    ok(rising || falling, `${label} diagonal: step heights are monotonic (${heights.map(h => h.toFixed(2)).join(', ')})`);
    ok(Math.max(...heights) <= rect.h + 1e-9 && Math.min(...heights) >= DESTRUCTION_DEFAULTS.stubHeight - 1e-9,
      `${label} diagonal: steps run between the stub height and the full height`);
    const covered = cut.solids.reduce((s, r) => s + area(r), 0);
    ok(Math.abs(covered - area(rect)) < 1e-6, `${label} diagonal: the steps tile the whole footprint`);
    ok(cut.solids.some(r => blocksSight(r)) && cut.solids.some(r => !blocksSight(r)),
      `${label} diagonal: part of the staircase blocks sight and part does not`);
  }

  // Crushed: nothing solid left at all.
  {
    const cut = fracture(rect, 'crushed', { rng: makeWallRng(7, 1) });
    ok(cut.solids.length === 0, `${label} crushed: nothing is left standing`);
    ok(cut.rubble.length > 0, `${label} crushed: a pile is left behind`);
  }
}

ok((() => { try { fracture(WALL, 'nonsense'); return false; } catch { return true; } })(),
  'an unknown pattern throws rather than silently emitting nothing');

// ---- determinism ----
{
  const a = JSON.stringify(fracture(WALL, 'vertical', { rng: makeWallRng(42, 3) }));
  const b = JSON.stringify(fracture(WALL, 'vertical', { rng: makeWallRng(42, 3) }));
  ok(a === b, 'the same seed and id produce identical geometry');
  // A wall breaking must not depend on how many other walls broke first.
  const set1 = createDestructibleSet([WALL, WIDE, { ...WALL, x: 9 }], { seed: 5 });
  const set2 = createDestructibleSet([WALL, WIDE, { ...WALL, x: 9 }], { seed: 5 });
  applyWallDamage(set1, 2, 1e9);                       // break another wall first
  const t1 = applyWallDamage(set1, 1, wallHitPoints(WIDE) * 0.7);
  const t2 = applyWallDamage(set2, 1, wallHitPoints(WIDE) * 0.7);
  ok(t1?.to === WALL_STATE.CRUMBLED && t1.solids?.length > 0,
    'the ordering check actually crumbled a wall (otherwise it compares nothing)');
  ok(t1.pattern === t2.pattern && JSON.stringify(t1.solids) === JSON.stringify(t2.solids),
    'wall 1 breaks the same way whether or not wall 2 broke first');
}

// ---- restricting which cuts are allowed ----
{
  for (const only of FRACTURE_PATTERNS) {
    let seen = 0;
    for (let id = 0; id < 12; id++) {
      const set = createDestructibleSet([{ ...WALL, x: id }], { seed: 11 + id, patterns: [only] });
      const t = applyWallDamage(set, 0, set.entries[0].maxHp * 0.65);
      if (t?.pattern === only) seen++;
    }
    ok(seen === 12, `restricting patterns to '${only}' is honoured for every wall (${seen}/12)`);
  }
  // With all three allowed the choice must vary ACROSS a set: the stream is keyed on (seed, id), so
  // this has to be one set of many walls, not many sets of one wall.
  const many = createDestructibleSet(Array.from({ length: 60 }, (_, i) => ({ ...WALL, x: i * 2 })), { seed: 99 });
  const counts = new Map();
  for (let id = 0; id < 60; id++) {
    const t = applyWallDamage(many, id, many.entries[id].maxHp * 0.65);
    counts.set(t?.pattern, (counts.get(t?.pattern) || 0) + 1);
  }
  const tally = FRACTURE_PATTERNS.map(p => `${p} ${counts.get(p) || 0}`).join(', ');
  ok(FRACTURE_PATTERNS.every(p => (counts.get(p) || 0) > 0), `all three cuts occur across 60 walls (${tally})`);
  ok(FRACTURE_PATTERNS.every(p => (counts.get(p) || 0) >= 8),
    `no cut is starved by the per-id stream (${tally})`);
}

// ---- the state ladder ----
{
  const set = createDestructibleSet([WALL], { seed: 1 });
  const max = set.entries[0].maxHp;
  ok(Math.abs(max - wallHitPoints(WALL)) < 1e-9, 'hit points come from volume');

  ok(applyWallDamage(set, 0, 0) === null, 'zero damage is not a transition');
  ok(applyWallDamage(set, 0, max * 0.05) === null, 'a scratch leaves it intact');

  const cracked = applyWallDamage(set, 0, max * 0.35);
  ok(cracked?.to === WALL_STATE.CRACKED, 'crossing the first threshold cracks it');
  ok(cracked?.geometryChanged === false, 'cracking changes no geometry, so nothing rebakes');
  ok(set.entries[0].pieces === null, 'a cracked wall is still its original rect');
  ok(applyWallDamage(set, 0, max * 0.05) === null, 'more damage inside the same band is not a transition');

  const crumbled = applyWallDamage(set, 0, max * 0.3);
  ok(crumbled?.to === WALL_STATE.CRUMBLED, 'crossing the second threshold crumbles it');
  ok(crumbled?.geometryChanged === true, 'crumbling changes geometry');
  ok(FRACTURE_PATTERNS.includes(crumbled.pattern), `crumbling picks a real pattern (${crumbled?.pattern})`);
  ok(crumbled.solids.length > 0, 'a crumbled wall leaves something standing');
  ok(crumbled.dirty && crumbled.dirty.minX <= WALL.x && crumbled.dirty.maxX >= WALL.x,
    'the transition carries the dirty region the local rebuilds need');

  const crushed = applyWallDamage(set, 0, max);
  ok(crushed?.to === WALL_STATE.CRUSHED, 'enough damage crushes it');
  ok(crushed.solids.length === 0, 'a crushed wall leaves nothing standing');
  ok(applyWallDamage(set, 0, max) === null, 'a crushed wall cannot be damaged further');
}

// ---- what the rest of the world is handed ----
{
  const rects = [WALL, WIDE, { ...WALL, x: 12 }];
  const set = createDestructibleSet(rects, { seed: 2 });
  ok(activeRectsOf(set).length === 3, 'an untouched set contributes every rect');
  ok(rubbleRectsOf(set).length === 0, 'an untouched set contributes no rubble');

  applyWallDamage(set, 0, set.entries[0].maxHp * 0.65);   // -> crumbled
  const afterCrumble = activeRectsOf(set);
  ok(afterCrumble.length >= 3, 'a crumbled wall is replaced by its standing pieces, not dropped');
  ok(rubbleRectsOf(set).length > 0, 'a crumbled wall leaves rubble');
  ok(!afterCrumble.some(r => r.kind === 'rubble'), 'rubble never reaches the blocker list');

  applyWallDamage(set, 1, 1e9);                            // -> crushed
  const afterCrush = activeRectsOf(set);
  ok(!afterCrush.some(r => r === WIDE), 'a crushed wall is gone from the blocker list');
  ok(!afterCrush.some(r => r.kind === 'rubble'), 'crushed rubble never reaches the blocker list either');
}

// ---- the ladder ceiling ----
{
  // A caller with damage wired but no geometry rebuild yet runs at CRACKED. Damage must still
  // accrue, so lifting the ceiling later resumes from the hit points already taken.
  const set = createDestructibleSet([WALL], { seed: 1, maxState: WALL_STATE.CRACKED });
  const max = set.entries[0].maxHp;
  ok(applyWallDamage(set, 0, max * 0.35)?.to === WALL_STATE.CRACKED, 'it still cracks under a ceiling');
  ok(applyWallDamage(set, 0, max * 0.5) === null, 'and never transitions past the ceiling');
  ok(set.entries[0].state === WALL_STATE.CRACKED, 'the state stops at the ceiling');
  ok(set.entries[0].hp < max * 0.2, 'but the damage was still taken');
  ok(set.entries[0].pieces === null, 'so no geometry was produced');

  // The same damage without a ceiling gets past cracked, so the ceiling is what held it, not the
  // amount. 15% hp left is inside the crumbled band; only zero is crushed.
  const free = createDestructibleSet([WALL], { seed: 1 });
  applyWallDamage(free, 0, max * 0.85);
  ok(free.entries[0].state === WALL_STATE.CRUMBLED, 'without a ceiling the same damage crumbles it');
  ok(free.entries[0].pieces?.length > 0, 'and produces the geometry the ceiling suppressed');
}

// ---- fixed rects ----
{
  // The layout ring is the caller's business, not this module's: it only honours the predicate.
  const set = createDestructibleSet([WALL, WIDE], { indestructible: (r, i) => i === 0 });
  ok(applyWallDamage(set, 0, 1e9) === null, 'a rect marked indestructible never transitions');
  ok(set.entries[0].state === WALL_STATE.INTACT, 'and it stays intact');
  ok(applyWallDamage(set, 1, 1e9)?.to === WALL_STATE.CRUSHED, 'its neighbour still breaks normally');
}

// ---- hit attribution ----
{
  const set = createDestructibleSet([WALL, WIDE], { seed: 3 });
  // A hit on the +x face of WALL: the point is on the surface, the normal points back at the shooter.
  const hit = [WALL.x + WALL.w / 2, 1.5, WALL.z];
  ok(wallAtPoint(set, hit, [1, 0, 0]) === 0, 'a surface hit is attributed to the rect behind it');
  ok(wallAtPoint(set, [WALL.x, 1.5, WALL.z], null) === 0, 'an interior point needs no normal');
  ok(wallAtPoint(set, [100, 1.5, 100], null) === -1, 'a point in open ground belongs to no wall');

  // Two rects sharing a face: the normal decides which one the round hit.
  const a = { x: 0, z: 0, w: 2, d: 2, h: 3 };
  const b = { x: 2, z: 0, w: 2, d: 2, h: 3 };
  const pair = createDestructibleSet([a, b], { seed: 3 });
  ok(wallAtPoint(pair, [1, 1.5, 0], [-1, 0, 0]) === 1, 'a shared face resolves to the rect the ray entered');
  ok(wallAtPoint(pair, [1, 1.5, 0], [1, 0, 0]) === 0, 'and to the other one from the other side');

  // A crushed wall is not a target any more.
  applyWallDamage(set, 0, 1e9);
  ok(wallAtPoint(set, [WALL.x, 1.5, WALL.z], null) === -1, 'a crushed wall no longer owns its old footprint');
}

// ---- dirty bounds ----
{
  const u = unionBounds([footprintOf(WALL), footprintOf(WIDE)]);
  ok(u.minX <= Math.min(WALL.x - WALL.w / 2, WIDE.x - WIDE.w / 2) + 1e-9
    && u.maxZ >= Math.max(WALL.z + WALL.d / 2, WIDE.z + WIDE.d / 2) - 1e-9,
    'unionBounds covers every footprint it was given');
  ok(unionBounds([]) === null, 'an empty batch has no dirty region');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-destruction: all assertions passed');
