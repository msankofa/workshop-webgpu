// Node tests for advancePath in nav-grid.js (the waypoint-advance contract shared by bot
// capsules and creature bodies). Run: node test-advance-path.mjs
import { advancePath, buildNavGrid, lineWalkable } from './nav-grid.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// bot-viewer-v2's constants, so the shared helper is exercised at the tuning the bots ship with.
const REACH = 0.35;
const RELAX = 0.45;

// ---- pop at reach: standing inside the radius consumes the waypoint ----
{
  const path = [{ x: 0.1, z: 0 }, { x: 5, z: 0 }];
  const wp = advancePath({ x: 0, z: 0 }, path, REACH);
  ok(path.length === 1, `reaching a waypoint pops it (path length ${path.length})`);
  ok(wp === path[0] && wp.x === 5, 'the returned waypoint is the new head of the path');
}

// ---- no pop outside reach: the head survives and is returned ----
{
  const path = [{ x: 0.4, z: 0 }, { x: 5, z: 0 }];
  const wp = advancePath({ x: 0, z: 0 }, path, REACH);
  ok(path.length === 2, 'a waypoint just outside the reach radius is not popped');
  ok(wp.x === 0.4, 'the un-reached head is what gets steered at');
}

// ---- exactly on the radius is NOT a pop (strict <, matching followPath) ----
{
  const path = [{ x: REACH, z: 0 }];
  advancePath({ x: 0, z: 0 }, path, REACH);
  ok(path.length === 1, 'distance exactly equal to the reach radius does not pop');
}

// ---- contest relax: a squatted waypoint pops out to reach+relax, but no further ----
{
  const inBand = [{ x: 0.6, z: 0 }];            // 0.35 < 0.6 < 0.80
  advancePath({ x: 0, z: 0 }, inBand, REACH, { relaxRadius: RELAX, contested: () => true });
  ok(inBand.length === 0, 'a contested waypoint inside the relax band pops');

  const inBand2 = [{ x: 0.6, z: 0 }];
  advancePath({ x: 0, z: 0 }, inBand2, REACH, { relaxRadius: RELAX, contested: () => false });
  ok(inBand2.length === 1, 'an uncontested waypoint in the relax band stays');

  const outOfBand = [{ x: 0.9, z: 0 }];         // beyond 0.80
  advancePath({ x: 0, z: 0 }, outOfBand, REACH, { relaxRadius: RELAX, contested: () => true });
  ok(outOfBand.length === 1, 'the contest cannot pop a waypoint beyond reach+relax');

  // contested() must only ever be consulted inside the band -- it is the expensive neighbor scan.
  let calls = 0;
  const far = [{ x: 4, z: 0 }];
  advancePath({ x: 0, z: 0 }, far, REACH, { relaxRadius: RELAX, contested: () => { calls++; return true; } });
  ok(calls === 0, `the crowd predicate is not run outside the relax band (${calls} calls)`);
  const near = [{ x: 0.05, z: 0 }];
  advancePath({ x: 0, z: 0 }, near, REACH, { relaxRadius: RELAX, contested: () => { calls++; return true; } });
  ok(calls === 0, 'nor inside the base reach, where the pop is unconditional');
}

// ---- the skip guard vetoes a relaxed pop that would skip a load-bearing corner waypoint ----
{
  const path = [{ x: 0.6, z: 0 }, { x: 5, z: 0 }];
  advancePath({ x: 0, z: 0 }, path, REACH,
    { relaxRadius: RELAX, contested: () => true, canSkipTo: () => false });
  ok(path.length === 2, 'canSkipTo=false refuses the relaxed pop of a corner waypoint');

  const allowed = [{ x: 0.6, z: 0 }, { x: 5, z: 0 }];
  advancePath({ x: 0, z: 0 }, allowed, REACH,
    { relaxRadius: RELAX, contested: () => true, canSkipTo: () => true });
  ok(allowed.length === 1, 'canSkipTo=true lets the relaxed pop through');

  // With no next waypoint there is nothing to skip, so the guard must not be consulted at all.
  let guardCalls = 0;
  const last = [{ x: 0.6, z: 0 }];
  advancePath({ x: 0, z: 0 }, last, REACH,
    { relaxRadius: RELAX, contested: () => true, canSkipTo: () => { guardCalls++; return false; } });
  ok(last.length === 0 && guardCalls === 0, 'the last waypoint pops on contest without consulting the guard');

  // The base-reach pop is never guarded either -- only the relaxed one is.
  const inside = [{ x: 0.1, z: 0 }, { x: 5, z: 0 }];
  advancePath({ x: 0, z: 0 }, inside, REACH,
    { relaxRadius: RELAX, contested: () => true, canSkipTo: () => false });
  ok(inside.length === 1, 'a waypoint inside the base reach pops regardless of the skip guard');
}

// ---- the guard wired to a real nav grid, the way followPath wires lineWalkable ----
{
  // A wall column at x in [3,4) with a doorway at z in [1,2).
  const grid = buildNavGrid((x, z) => (x >= 3 && x < 4) ? (z >= 1 && z < 2) : true,
    { minX: 0, maxX: 8, minZ: 0, maxZ: 4 }, 1);
  const opts = {
    relaxRadius: RELAX, contested: () => true,
    canSkipTo: (from, next) => lineWalkable(grid, from, next),
  };
  // Standing just short of the doorway waypoint, with the next waypoint on the far side.
  const pos = { x: 2.9, z: 1.5 };
  const throughDoor = [{ x: 3.5, z: 1.5 }, { x: 4.5, z: 1.5 }];
  advancePath(pos, throughDoor, REACH, opts);
  ok(throughDoor.length === 1, 'a walkable next leg lets the doorway waypoint pop under contest');
  // Same geometry, but the next waypoint sits past a wall segment: the corner is load-bearing.
  const acrossWall = [{ x: 3.5, z: 1.5 }, { x: 4.5, z: 3.5 }];
  advancePath(pos, acrossWall, REACH, opts);
  ok(acrossWall.length === 2, 'a wall-clipping next leg keeps the load-bearing corner waypoint');
}

// ---- empty / spent paths return null ----
{
  const empty = [];
  ok(advancePath({ x: 0, z: 0 }, empty, REACH) === null, 'an empty path returns null');
  ok(advancePath({ x: 0, z: 0 }, null, REACH) === null, 'a null path returns null rather than throwing');
  const spent = [{ x: 0, z: 0 }, { x: 0.1, z: 0.1 }];
  ok(advancePath({ x: 0, z: 0 }, spent, REACH) === null, 'consuming the final waypoint returns null');
  ok(spent.length === 0, 'and the path array is left empty');
}

// ---- multi-waypoint sequential advance: every reached waypoint is consumed in one call ----
{
  const path = [{ x: 0.05, z: 0 }, { x: 0.1, z: 0.1 }, { x: 0.2, z: 0 }, { x: 6, z: 0 }];
  const wp = advancePath({ x: 0, z: 0 }, path, REACH);
  ok(path.length === 1 && wp.x === 6, `a run of reached waypoints is popped in one call (left ${path.length})`);

  // ... and stepping along a corridor advances one waypoint per step, in order.
  const corridor = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }];
  const seen = [];
  for (let i = 0; i <= 3; i++) {
    const t = advancePath({ x: i, z: 0 }, corridor, REACH);
    seen.push(t ? t.x : null);
  }
  ok(JSON.stringify(seen) === JSON.stringify([1, 2, 3, null]),
    `waypoints are handed out in order as the body walks (got ${JSON.stringify(seen)})`);
}

// ---- creature scale: a bigger body just passes a bigger reach, no contest/grid machinery ----
{
  const CREATURE_REACH = 1.2;
  const path = [{ x: 0.9, z: 0 }, { x: 5, z: 0 }];
  const wp = advancePath({ x: 0, z: 0 }, path, CREATURE_REACH);
  ok(path.length === 1 && wp.x === 5, 'a creature-scale reach pops a waypoint a bot capsule would still walk to');
  // The same position/path at bot reach must NOT pop -- proving reachRadius is what differs.
  const botPath = [{ x: 0.9, z: 0 }, { x: 5, z: 0 }];
  advancePath({ x: 0, z: 0 }, botPath, REACH);
  ok(botPath.length === 2, 'the identical case at bot reach keeps the waypoint');
  // A wide creature can swallow several waypoints of a tight grid path at once.
  const tight = [{ x: 0.5, z: 0 }, { x: 1, z: 0 }, { x: 1.5, z: 0 }, { x: 4, z: 0 }];
  ok(advancePath({ x: 0.5, z: 0 }, tight, CREATURE_REACH).x === 4 && tight.length === 1,
    'a wide reach consumes a whole cluster of tight waypoints');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('advance-path: all assertions passed');
