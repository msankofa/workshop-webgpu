// Node tests for hallway/corner bot traffic: smoothed-path legality (no corner cutting), convoy
// and opposing-flow transit through an L-hall, and scrum dissolution around parked bots -- the
// 2026-07-23 "bots bunch and grind at hallway corners" regression. Run: node test-bot-hallway.mjs
import { resolveBotPairs, separationXZ, blendSeparationDir, waypointContested } from './bot-separation.js';
import { buildNavGrid, findPath, smoothPath, lineWalkable, isWalkableCell, worldToCell } from './nav-grid.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// Constants mirror bot-viewer.html's movement wiring.
const R = 0.3, NAV_CELL = 0.5, WALL_MARGIN = 0.55, WALL_T = 0.3;
const WAYPOINT_REACH = 0.35, SEPARATION_RADIUS = 1.5, SEPARATION_WEIGHT = 0.5;
const SEPARATION_PROBE_M = 0.45, WAYPOINT_CONTEST_RANGE = 0.75, WAYPOINT_CONTEST_RELAX = 0.45;
const SPEED = 2.4, DT = 1 / 60;

// L-hallway of clear width W: leg A along +X (x 0..8, z 0..W), leg B along +Z (x 8-W..8, z 0..10).
function buildLHall(W) {
  const T = WALL_T;
  const walls = [
    { x: 4 + T, z: -T / 2, w: 8 + 3 * T, d: T },
    { x: (8 - W) / 2 - T / 2, z: W + T / 2, w: 8 - W + T, d: T },
    { x: 8 + T / 2, z: 5, w: T, d: 10 + 2 * T },
    { x: 8 - W - T / 2, z: (10 + W) / 2 + T / 2, w: T, d: 10 - W + T },
    { x: -T / 2, z: W / 2, w: T, d: W + 2 * T },
    { x: 8 - W / 2, z: 10 + T / 2, w: W + T, d: T },
  ];
  const bounds = { minX: -1, maxX: 9.5, minZ: -1, maxZ: 10.5 };
  const inWall = (x, z) => walls.some((w) => Math.abs(x - w.x) <= w.w / 2 + WALL_MARGIN && Math.abs(z - w.z) <= w.d / 2 + WALL_MARGIN);
  const grid = buildNavGrid(
    (x, z) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ && !inWall(x, z),
    bounds, NAV_CELL);
  return { walls, grid };
}

function makeBot(id, x, z) {
  return { id, alive: true, velocity: { x: 0, y: 0, z: 0 },
    capsule: { radius: R, start: { x, y: R, z }, end: { x, y: 1.8 - R, z } } };
}
function shiftXZ(e, dx, dz) {
  e.capsule.start.x += dx; e.capsule.start.z += dz;
  e.capsule.end.x += dx; e.capsule.end.z += dz;
}
// Stand-in for mapCollider.resolveCapsule: XZ circle-vs-rect pushout (same as test-bot-separation).
function resolveWallRects(e, rects) {
  const p = e.capsule.start;
  for (const w of rects) {
    const cx = Math.min(Math.max(p.x, w.x - w.w / 2), w.x + w.w / 2);
    const cz = Math.min(Math.max(p.z, w.z - w.d / 2), w.z + w.d / 2);
    const dx = p.x - cx, dz = p.z - cz;
    const d = Math.hypot(dx, dz);
    if (d >= R || d < 1e-9) continue;
    shiftXZ(e, (dx / d) * (R - d), (dz / d) * (R - d));
  }
}

// followPath mirror of bot-viewer.html (incl. the off-path-line skip/re-path recovery).
const REPATH_COOLDOWN_FRAMES = Math.round(0.35 * 60); // mirrors NAV_REPATH_COOLDOWN_MS
function followPath(grid, entity, path, all) {
  if (entity.repathHold > 0) entity.repathHold--;
  while (path.length > 0) {
    const target = path[0];
    const p = entity.capsule.start;
    const dx = target.x - p.x, dz = target.z - p.z;
    const dist = Math.hypot(dx, dz);
    const reach = waypointContested(entity, all, target, dist, WAYPOINT_CONTEST_RANGE)
      ? WAYPOINT_REACH + WAYPOINT_CONTEST_RELAX : WAYPOINT_REACH;
    if (dist < reach) { path.shift(); continue; }
    if (!lineWalkable(grid, p, target)) {
      if (path.length > 1 && lineWalkable(grid, p, path[1])) { path.shift(); continue; }
      if (!(entity.repathHold > 0)) {
        entity.repathHold = REPATH_COOLDOWN_FRAMES;
        const fresh = requestPath(grid, entity, path[path.length - 1]);
        if (fresh.length > 0) { path.length = 0; path.push(...fresh); continue; }
      }
    }
    let mx = dx / dist, mz = dz / dist;
    const sep = separationXZ(entity, all, SEPARATION_RADIUS);
    if (sep) {
      const m = blendSeparationDir(mx, mz, sep, SEPARATION_WEIGHT, (bx, bz) => {
        const cell = worldToCell(grid, p.x + bx * SEPARATION_PROBE_M, p.z + bz * SEPARATION_PROBE_M);
        return !isWalkableCell(grid, cell.c, cell.r);
      });
      mx = m.x; mz = m.z;
    }
    entity.velocity.x = mx * SPEED; entity.velocity.z = mz * SPEED;
    return false;
  }
  entity.velocity.x = 0; entity.velocity.z = 0;
  return true;
}
function requestPath(grid, e, to) {
  const raw = findPath(grid, { x: e.capsule.start.x, z: e.capsule.start.z }, to);
  return raw ? smoothPath(grid, raw).slice(1) : [];
}

// ---- smoothed paths never cut corners (supercover legality) ----
{
  let checked = 0, bad = 0;
  for (const W of [2.0, 2.6, 3.2]) {
    const { grid } = buildLHall(W);
    for (let sx = 0.7; sx <= 6; sx += 0.4) {
      for (let sz = 0.7; sz <= W - 0.6; sz += 0.3) {
        for (let gz = 6; gz <= 9.4; gz += 0.7) {
          const raw = findPath(grid, { x: sx, z: sz }, { x: 8 - W / 2, z: gz });
          if (!raw) continue;
          const sm = smoothPath(grid, raw);
          for (let k = 0; k + 1 < sm.length; k++) {
            checked++;
            const a = sm[k], b = sm[k + 1];
            const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.005));
            for (let i = 0; i <= steps; i++) {
              const t = i / steps;
              const { c, r } = worldToCell(grid, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
              if (!isWalkableCell(grid, c, r)) { bad++; break; }
            }
          }
        }
      }
    }
  }
  ok(checked > 100, `legality sweep covered a real sample (${checked} segments)`);
  ok(bad === 0, `no smoothed segment crosses a blocked cell (${bad}/${checked} illegal)`);
}

// ---- same-direction convoy clears the L-corner ----
{
  const W = 2.0;
  const { walls, grid } = buildLHall(W);
  const goal = { x: 8 - W / 2, z: 9 };
  let bots = [];
  for (let i = 0; i < 5; i++) {
    const b = makeBot('b' + i, 0.9 + i * 0.7, W / 2 + (i % 2 ? 0.1 : -0.1));
    b.path = requestPath(grid, b, goal);
    bots.push(b);
  }
  for (let f = 0; f < 30 * 60 && bots.length; f++) {
    for (const e of bots) {
      e.done = followPath(grid, e, e.path, bots);
      shiftXZ(e, e.velocity.x * DT, e.velocity.z * DT);
      resolveWallRects(e, walls);
      if (e.done || Math.hypot(goal.x - e.capsule.start.x, goal.z - e.capsule.start.z) < 0.6) e.arrived = true;
    }
    bots = bots.filter((b) => !b.arrived); // arrivals walk on out of the hall
    for (const e of resolveBotPairs(bots)) resolveWallRects(e, walls);
  }
  ok(bots.length === 0, `same-direction 5-bot convoy transits the corner within 30 s (${bots.length} stuck)`);
}

// ---- opposing patrol flows keep circulating through a narrow hall ----
{
  const W = 1.6;
  const { walls, grid } = buildLHall(W);
  const patrol = [{ x: 0.9, z: W / 2 }, { x: 8 - W / 2, z: 9.4 }];
  const bots = [];
  for (let i = 0; i < 3; i++) {
    const b = makeBot('a' + i, 0.9 + i * 0.7, W / 2 + (i % 2 ? 0.1 : -0.1));
    b.patrolIdx = 1; b.path = []; b.legs = 0; bots.push(b);
  }
  for (let i = 0; i < 2; i++) {
    const b = makeBot('z' + i, 8 - W / 2 + (i % 2 ? 0.1 : -0.1), 9.4 - i * 0.7);
    b.patrolIdx = 0; b.path = []; b.legs = 0; bots.push(b);
  }
  for (let f = 0; f < 60 * 60; f++) {
    for (const e of bots) {
      if (e.path.length === 0) e.path = requestPath(grid, e, patrol[e.patrolIdx]);
      if (followPath(grid, e, e.path, bots)) { e.patrolIdx = (e.patrolIdx + 1) % 2; e.legs++; }
      shiftXZ(e, e.velocity.x * DT, e.velocity.z * DT);
      resolveWallRects(e, walls);
    }
    for (const e of resolveBotPairs(bots)) resolveWallRects(e, walls);
  }
  for (const b of bots) ok(b.legs >= 5, `opposing-flow bot ${b.id} keeps patrolling (${b.legs} legs in 60 s)`);
}

// ---- corner scrum around parked (holding) bots dissolves ----
// Two bots hold wall-hugging spots near the corner-side goal (like cover-hold/aiming bots: shoved
// by pushout, they steer back each frame); the rest must still thread past and arrive instead of
// being pinned against the walls by the parked pair's separation force.
{
  const W = 2.0;
  const { walls, grid } = buildLHall(W);
  const goal = { x: 8 - W / 2, z: 9 };
  const holdSpots = [{ x: goal.x + 0.55, z: goal.z }, { x: goal.x + 0.55, z: goal.z - 1.2 }];
  const movers = [];
  for (let i = 0; i < 5; i++) {
    const b = makeBot('b' + i, 0.9 + i * 0.75, W / 2 + (i % 2 ? 0.12 : -0.12));
    b.path = requestPath(grid, b, goal);
    movers.push(b);
  }
  const parked = [];
  let arrivedCount = 0;
  for (let f = 0; f < 45 * 60; f++) {
    const everyone = [...movers, ...parked];
    for (const e of movers) {
      const done = followPath(grid, e, e.path, everyone);
      shiftXZ(e, e.velocity.x * DT, e.velocity.z * DT);
      resolveWallRects(e, walls);
      if (done || Math.hypot(goal.x - e.capsule.start.x, goal.z - e.capsule.start.z) < 0.9) e.arrived = true;
    }
    for (const e of movers.filter((b) => b.arrived)) {
      arrivedCount++;
      // First two arrivals take up the hold spots; later arrivals walk on out of the hall.
      if (parked.length < holdSpots.length) { e.velocity.x = 0; e.velocity.z = 0; e.hold = holdSpots[parked.length]; parked.push(e); }
      movers.splice(movers.indexOf(e), 1);
    }
    for (const e of resolveBotPairs([...movers, ...parked])) resolveWallRects(e, walls);
    for (const e of parked) { // holding bots are shovable but steer back to their spot each frame
      const hx = e.hold.x - e.capsule.start.x, hz = e.hold.z - e.capsule.start.z;
      const hd = Math.hypot(hx, hz);
      if (hd > 1e-4) shiftXZ(e, (hx / hd) * Math.min(SPEED * DT, hd), (hz / hd) * Math.min(SPEED * DT, hd));
      resolveWallRects(e, walls);
    }
  }
  ok(arrivedCount === 5, `all 5 bots reach a goal held by 2 parked bots within 45 s (${arrivedCount} arrived)`);
}

// ---- lone bot shoved off the path line at the corner still completes transit (QA bug A) ----
{
  const W = 2.0;
  const { walls, grid } = buildLHall(W);
  const goal = { x: 8 - W / 2, z: 9 };
  const b = makeBot('shoved', 5.0, 1.0);
  b.path = requestPath(grid, b, goal);
  while (b.path.length > 1 && b.path[0].z < 3) b.path.shift(); // bend waypoints popped by contested relax
  ok(b.path.length > 0, 'displaced-corner repro keeps a waypoint past the bend');
  shiftXZ(b, 5.6 - 5.0, 0.35 - 1.0); // pushout shove: pinned near the outer wall, off the path line
  ok(!lineWalkable(grid, b.capsule.start, b.path[0]), 'repro really starts with an illegal bot->waypoint segment');
  let done = false;
  for (let f = 0; f < 15 * 60 && !done; f++) {
    done = followPath(grid, b, b.path, [b]);
    shiftXZ(b, b.velocity.x * DT, b.velocity.z * DT);
    resolveWallRects(b, walls);
    if (Math.hypot(goal.x - b.capsule.start.x, goal.z - b.capsule.start.z) < 0.6) done = true;
  }
  ok(done, 'corner-displaced bot recovers and completes the transit within 15 s');
}

// ---- perpendicular press (pre-fix this froze at the wall face forever): must re-path around ----
{
  const walls = [
    { x: 2, z: 2.15, w: 8, d: 0.3 },  // long wall, x in [-2,6], z in [2,2.3]
    { x: 8.65, z: 5, w: 0.3, d: 14 }, // east wall keeps the detour inside the map
  ];
  const bounds = { minX: -1, maxX: 8.5, minZ: -1, maxZ: 10.5 };
  const inWall = (x, z) => walls.some((w) => Math.abs(x - w.x) <= w.w / 2 + WALL_MARGIN && Math.abs(z - w.z) <= w.d / 2 + WALL_MARGIN);
  const grid = buildNavGrid((x, z) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ && !inWall(x, z), bounds, NAV_CELL);
  const goal = { x: 5.5, z: 9 };
  const b = makeBot('pressed', 5.9, 1.6); // shoved into the wall margin, off the (legal) path line
  b.path = [{ x: 5.5, z: 4 }, { x: goal.x, z: goal.z }];
  ok(lineWalkable(grid, b.path[0], b.path[1]), 'the remaining PATH itself is legal');
  ok(!lineWalkable(grid, b.capsule.start, b.path[0]), 'but the bot->waypoint segment clips the wall');
  let done = false;
  for (let f = 0; f < 15 * 60 && !done; f++) {
    done = followPath(grid, b, b.path, [b]);
    shiftXZ(b, b.velocity.x * DT, b.velocity.z * DT);
    resolveWallRects(b, walls);
    if (Math.hypot(goal.x - b.capsule.start.x, goal.z - b.capsule.start.z) < 0.6) done = true;
  }
  ok(done, 'perpendicular-pressed bot re-paths around the wall and completes');
}

// ---- pure helper units ----
{
  const sep = { x: 0, z: 5 }; // hard sideways shove
  const gated = blendSeparationDir(1, 0, sep, 0.5, () => true); // everything ahead blocked
  ok(gated.x === 1 && gated.z === 0, 'blocked probe drops the separation component entirely');
  const open = blendSeparationDir(1, 0, sep, 0.5, () => false);
  ok(open.z > 0 && Math.abs(Math.hypot(open.x, open.z) - 1) < 1e-9, 'open probe keeps the normalized blend');
  const cancel = blendSeparationDir(1, 0, { x: -2, z: 0 }, 0.5, null);
  ok(cancel.x === 1 && cancel.z === 0, 'near-cancelling blend falls back to the path direction');

  const self = makeBot('s', 0, 0);
  const blocker = makeBot('n', 0.55, 0);
  const wp = { x: 1.0, z: 0 };
  ok(waypointContested(self, [self, blocker], wp, 1.0, WAYPOINT_CONTEST_RANGE), 'contact-range neighbor nearer the waypoint contests it');
  blocker.alive = false;
  ok(!waypointContested(self, [self, blocker], wp, 1.0, WAYPOINT_CONTEST_RANGE), 'dead neighbors never contest');
  const behind = makeBot('m', -0.55, 0);
  ok(!waypointContested(self, [self, behind], wp, 1.0, WAYPOINT_CONTEST_RANGE), 'a neighbor farther from the waypoint does not contest');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-hallway: all assertions passed');
