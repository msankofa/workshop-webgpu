// Node tests for creature-interaction.js (pure player-interaction decision math).
// Run: node test-creature-interaction.mjs
import {
  ROLE_WILD, ROLE_PET, ROLE_HOSTILE,
  followDesire, hostileDesire, meleeHitsPlayer, wildlifeSpawnPlan, pickRoamTarget,
} from './creature-interaction.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
function approx(a, b, e = 1e-6) { return Math.abs(a - b) <= e; }

// roles distinct
ok(ROLE_WILD !== ROLE_PET && ROLE_PET !== ROLE_HOSTILE, 'roles distinct');

// followDesire: stops inside standoff, else unit vector toward player
let f = followDesire(0, 0, 1, 0, 2.2);
ok(f.moving === false, 'follow stops within standoff');
f = followDesire(0, 0, 10, 0, 2.2);
ok(f.moving === true && approx(Math.hypot(f.dx, f.dz), 1), 'follow moves as unit vector');
ok(approx(f.dx, 1) && approx(f.dz, 0), 'follow points at player');
// spread aims at a ring slot, not the player center
f = followDesire(0, 0, 0, 0, 3, Math.PI / 2);
ok(f.moving === true && approx(f.dx, 1) && approx(f.dz, 0, 1e-6), 'spread slot east of player');
// reusable out object is written in place and returned
const scratch = {};
const r = followDesire(0, 0, 10, 0, 2.2, null, scratch);
ok(r === scratch && scratch.moving === true, 'follow writes into out object');

// hostileDesire: approach, hold in range, flee when weak
let h = hostileDesire(0, 0, 10, 0, 1.4);
ok(h.moving && !h.inRange && approx(h.dx, 1), 'hostile approaches player');
h = hostileDesire(0, 0, 1, 0, 1.4);
ok(!h.moving && h.inRange, 'hostile holds in attack range');
h = hostileDesire(0, 0, 10, 0, 1.4, true);
ok(h.moving && !h.inRange && approx(h.dx, -1), 'hostile flees when weak');
// exactly at attackRange counts as in-range (<=), not "approach"
h = hostileDesire(0, 0, 1.4, 0, 1.4);
ok(!h.moving && h.inRange, 'hostile holds exactly at attackRange boundary');

// meleeHitsPlayer: capsule proximity within height band
ok(meleeHitsPlayer({ handX: 0.4, handY: 1, handZ: 0, playerX: 0, playerY: 1, playerZ: 0, playerRadius: 0.35, playerHeight: 1.6 }), 'melee hits close hand');
ok(!meleeHitsPlayer({ handX: 3, handY: 1, handZ: 0, playerX: 0, playerY: 1, playerZ: 0, playerRadius: 0.35, playerHeight: 1.6 }), 'melee misses far hand');
ok(!meleeHitsPlayer({ handX: 0.1, handY: 5, handZ: 0, playerX: 0, playerY: 1, playerZ: 0, playerRadius: 0.35, playerHeight: 1.6 }), 'melee misses above capsule');
// exactly at radius+margin is a hit (<=), one unit past is a miss
ok(meleeHitsPlayer({ handX: 0.6, handY: 1, handZ: 0, playerX: 0, playerY: 1, playerZ: 0, playerRadius: 0.35, playerHeight: 1.6, margin: 0.25 }), 'melee hits exactly at radius+margin boundary');
ok(!meleeHitsPlayer({ handX: 0.61, handY: 1, handZ: 0, playerX: 0, playerY: 1, playerZ: 0, playerRadius: 0.35, playerHeight: 1.6, margin: 0.25 }), 'melee misses just past radius+margin boundary');

// wildlifeSpawnPlan: cull far, spawn to target on ring, capped
let seed = 0.5;
const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const plan = wildlifeSpawnPlan({
  playerX: 0, playerZ: 0,
  existing: [{ id: 1, x: 5, z: 0 }, { id: 2, x: 500, z: 0 }],
  target: 8, ringMin: 40, ringMax: 70, cullRadius: 120, rand, maxSpawnPerCall: 2,
});
ok(plan.despawnIds.length === 1 && plan.despawnIds[0] === 2, 'wildlife culls far creature');
ok(plan.spawns.length === 2, 'wildlife spawns capped at maxSpawnPerCall');
for (const s of plan.spawns) {
  const d = Math.hypot(s.x, s.z);
  ok(d >= 40 - 1e-6 && d <= 70 + 1e-6, 'wildlife spawn on ring');
}
// no deficit -> no spawn
const plan2 = wildlifeSpawnPlan({ playerX: 0, playerZ: 0, existing: [{ id: 1, x: 1, z: 0 }], target: 1, rand });
ok(plan2.spawns.length === 0, 'wildlife no spawn when at target');

// pickRoamTarget: band distance, anti-backtrack, bounds reject/clamp, null bounds, determinism
function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// band distance respected, no bounds
{
  const rand = mulberry(1);
  let px = 0, pz = 0, sx = 0, sz = -1;
  for (let i = 0; i < 200; i++) {
    const t = pickRoamTarget(sx, sz, px, pz, 6, 20, null, rand);
    const d = Math.hypot(t.x - sx, t.z - sz);
    ok(d >= 6 - 1e-6 && d <= 20 + 1e-6, `roam target within [6,20] band (got ${d})`);
    ok(Number.isFinite(t.x) && Number.isFinite(t.z), 'roam target is finite (no NaN)');
    px = sx; pz = sz; sx = t.x; sz = t.z;
  }
}

// anti-backtrack: new heading stays within the forward cone (not aimed back the way we came)
{
  const rand = mulberry(7);
  const selfX = 0, selfZ = 0, prevX = 0, prevZ = -5; // traveled north, forward = (0,1)
  const forward = { x: 0, z: 1 };
  let sawReverse = false;
  for (let i = 0; i < 100; i++) {
    const t = pickRoamTarget(selfX, selfZ, prevX, prevZ, 6, 20, null, rand);
    const hd = Math.hypot(t.x - selfX, t.z - selfZ);
    const dot = ((t.x - selfX) / hd) * forward.x + ((t.z - selfZ) / hd) * forward.z;
    if (dot < Math.cos((110 * Math.PI) / 180) - 1e-6) sawReverse = true;
  }
  ok(!sawReverse, 'anti-backtrack keeps headings within the forward cone when unconstrained by bounds');
}

// first pick (prev === self): no forward bias, any heading accepted
{
  const rand = mulberry(3);
  const t = pickRoamTarget(0, 0, 0, 0, 6, 20, null, rand);
  ok(Number.isFinite(t.x) && Number.isFinite(t.z), 'first pick (prev==self) produces a finite target');
  const d = Math.hypot(t.x, t.z);
  ok(d >= 6 - 1e-6 && d <= 20 + 1e-6, 'first pick respects band too');
}

// bounds: accepted target always falls inside a tight box (retry path)
{
  const rand = mulberry(11);
  const bounds = { minX: -8, maxX: 8, minZ: -8, maxZ: 8 };
  for (let i = 0; i < 100; i++) {
    const t = pickRoamTarget(0, 0, 5, 5, 6, 20, bounds, rand);
    ok(t.x >= bounds.minX - 1e-6 && t.x <= bounds.maxX + 1e-6, 'bounded roam target respects minX/maxX');
    ok(t.z >= bounds.minZ - 1e-6 && t.z <= bounds.maxZ + 1e-6, 'bounded roam target respects minZ/maxZ');
  }
}

// bounds: impossible box (band always exceeds it) forces the clamp fallback, still finite & inside
{
  const rand = mulberry(23);
  const bounds = { minX: -2, maxX: 2, minZ: -2, maxZ: 2 };
  const t = pickRoamTarget(0, 0, 3, 0, 6, 20, bounds, rand);
  ok(Number.isFinite(t.x) && Number.isFinite(t.z), 'clamp fallback is finite');
  ok(t.x >= bounds.minX - 1e-6 && t.x <= bounds.maxX + 1e-6, 'clamp fallback respects minX/maxX');
  ok(t.z >= bounds.minZ - 1e-6 && t.z <= bounds.maxZ + 1e-6, 'clamp fallback respects minZ/maxZ');
}

// null bounds accepts everything on the first try (no retries needed)
{
  let calls = 0;
  const rand = () => { calls++; return 0.5; };
  pickRoamTarget(0, 0, 0, -5, 6, 20, null, rand);
  ok(calls === 2, 'null bounds resolves on the first try (one angle + one distance draw)');
}

// determinism: same seed + same inputs -> same output
{
  const a = pickRoamTarget(1, 2, 0, 0, 6, 20, null, mulberry(42));
  const b = pickRoamTarget(1, 2, 0, 0, 6, 20, null, mulberry(42));
  ok(approx(a.x, b.x) && approx(a.z, b.z), 'pickRoamTarget is deterministic given a seeded rand');
}

// out object is written in place and returned
{
  const scratch = {};
  const r = pickRoamTarget(0, 0, 0, -5, 6, 20, null, mulberry(5), scratch);
  ok(r === scratch && Number.isFinite(scratch.x), 'pickRoamTarget writes into out object');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('creature-interaction: all assertions passed');
