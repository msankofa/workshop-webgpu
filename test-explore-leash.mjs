// Bots exiled themselves. exploreHeading is rolled ONCE at spawn and every goal is 80-300 m along it,
// so an unleashed bot walks a straight line outward forever -- a 2026-08-08 session found six of
// twenty-one bots stranded 600 m to 1.1 km out, beached on coastline outside the 384 m nav zone,
// while the fight was happening within 150 m of the player.
//
// leashedExploreAim is pure, so the walk is simulated here rather than asserted structurally: pick a
// goal, walk to it, pick the next, and check the bot stays in a bounded area instead of running off.
// The copy below must stay in step with environment-viewer-v2.html's (the viewer inlines it).
const BOT_EXPLORE_MIN_DIST = 80, BOT_EXPLORE_MAX_DIST = 300;
const BOT_EXPLORE_CONE_JITTER = Math.PI / 6;
const BOT_LEASH_RADIUS = 140;

function leashedExploreAim(pos, spawn, heading) {
  if (!spawn) return { heading, maxDist: BOT_EXPLORE_MAX_DIST, leashed: false };
  const dx = spawn.x - pos.x, dz = spawn.z - pos.z;
  const fromSpawn = Math.hypot(dx, dz);
  if (fromSpawn <= BOT_LEASH_RADIUS) return { heading, maxDist: BOT_EXPLORE_MAX_DIST, leashed: false };
  return {
    heading: Math.atan2(dx, dz),
    maxDist: Math.max(BOT_EXPLORE_MIN_DIST, Math.min(BOT_EXPLORE_MAX_DIST, fromSpawn)),
    leashed: true,
  };
}

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

// Deterministic PRNG so a failure is reproducible.
let _seed = 12345;
const rand = () => { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; };

// One goal hop, then teleport the bot onto it (the walk itself is not what is under test).
function hop(pos, spawn, heading, leash) {
  const aim = leash ? leashedExploreAim(pos, spawn, heading)
    : { heading, maxDist: BOT_EXPLORE_MAX_DIST, leashed: false };
  const angle = aim.heading + (rand() * 2 - 1) * BOT_EXPLORE_CONE_JITTER;
  const minD = Math.min(BOT_EXPLORE_MIN_DIST, aim.maxDist);
  const dist = minD + rand() * (aim.maxDist - minD);
  return { x: pos.x + Math.sin(angle) * dist, z: pos.z + Math.cos(angle) * dist };
}
function walk(leash, hops = 40) {
  const spawn = { x: 0, z: 0 };
  const heading = 1.1;   // any fixed heading; the point is that it never changes
  let pos = { x: 0, z: 0 }, furthest = 0;
  for (let i = 0; i < hops; i++) {
    pos = hop(pos, spawn, heading, leash);
    furthest = Math.max(furthest, Math.hypot(pos.x - spawn.x, pos.z - spawn.z));
  }
  return { final: Math.hypot(pos.x - spawn.x, pos.z - spawn.z), furthest };
}

console.log('unleashed: the bug');
_seed = 12345;
const free = walk(false);
check('40 hops carry the bot kilometres from spawn', free.final > 3000,
  `ended ${free.final.toFixed(0)} m out — this is why bots were found 600-1100 m away`);

console.log('\nleashed: bounded wandering');
_seed = 12345;
const tied = walk(true);
check('it never gets far past the leash', tied.furthest < BOT_LEASH_RADIUS + BOT_EXPLORE_MAX_DIST,
  `furthest ${tied.furthest.toFixed(0)} m vs leash ${BOT_LEASH_RADIUS}`);
check('and ends up near home, not in the next county', tied.final < BOT_LEASH_RADIUS * 3,
  `ended ${tied.final.toFixed(0)} m out`);

console.log('\nthe leash only engages when it should');
const inside = leashedExploreAim({ x: 50, z: 0 }, { x: 0, z: 0 }, 1.1);
check('inside the radius the bot keeps its own heading', !inside.leashed && inside.heading === 1.1);
check('and its full range', inside.maxDist === BOT_EXPLORE_MAX_DIST);
const outside = leashedExploreAim({ x: 500, z: 0 }, { x: 0, z: 0 }, 1.1);
check('outside, it aims home', outside.leashed && Math.abs(outside.heading - Math.atan2(-500, 0)) < 1e-9,
  `heading ${outside.heading.toFixed(3)}`);
check('a goal never overshoots spawn onto the far side', outside.maxDist <= 500);
check('a bot with no spawn point is left alone', leashedExploreAim({ x: 900, z: 0 }, null, 1.1).leashed === false);

// The convention this depends on: pickExploreGoal projects with (sin, cos), so angle 0 is +Z.
console.log('\nangle convention matches pickExploreGoal');
const due = leashedExploreAim({ x: 0, z: 300 }, { x: 0, z: 0 }, 0);
const step = { x: Math.sin(due.heading), z: Math.cos(due.heading) };
check('a bot due north of spawn is sent south', step.z < -0.99,
  `step (${step.x.toFixed(2)}, ${step.z.toFixed(2)})`);

// This file carries a COPY of the viewer's helper (the viewer inlines it and cannot be imported in
// Node). Hand-synced copies drift -- see CLAUDE.md on forest-cull/light-cluster/post-grade -- so the
// copy is diffed against the real one, comments and whitespace stripped.
console.log('\nthe copy above has not drifted from the viewer');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'environment-viewer-v2.html'), 'utf8');
  const grab = (s) => {
    const i = s.indexOf('function leashedExploreAim');
    if (i < 0) return null;
    return s.slice(i, s.indexOf('\n}', i) + 2)
      .replace(/\/\/[^\n]*/g, '')       // line comments
      .replace(/\s+/g, ' ').trim();
  };
  const viewer = grab(src), mine = grab(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  check('leashedExploreAim matches environment-viewer-v2.html', !!viewer && viewer === mine,
    viewer ? `viewer: ${viewer}\n       test:   ${mine}` : 'leashedExploreAim not found in the viewer');
  check('the viewer uses the same leash radius',
    new RegExp(`BOT_LEASH_RADIUS = ${BOT_LEASH_RADIUS}\\b`).test(src),
    `test assumes ${BOT_LEASH_RADIUS} m`);
  check('and the same explore ranges',
    new RegExp(`BOT_EXPLORE_MIN_DIST = ${BOT_EXPLORE_MIN_DIST}, BOT_EXPLORE_MAX_DIST = ${BOT_EXPLORE_MAX_DIST}\\b`).test(src));
  check('the leash is actually wired into nextExploreGoal',
    /const aim = leashedExploreAim\(pos, rec\.spawnPos, rec\.exploreHeading\)/.test(src)
    && /heading: aim\.heading/.test(src) && /maxDist: aim\.maxDist/.test(src),
    'the helper existing but unused would pass every check above');
}

console.log(failures ? `\nexplore leash: ${failures} FAILED` : '\nexplore leash: all checks passed');
process.exit(failures ? 1 : 0);
