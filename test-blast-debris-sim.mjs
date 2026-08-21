// node test-blast-debris-sim.mjs
// Covers blast-debris-sim.js, the port of html-game-v2's shrapnel / rubble / spark / smoke pools.
// Like test-explosion-tier.mjs, the point is fidelity: pool sizes, counts, and the physics
// behaviours (bounce, settle, smoulder, secondary bursts) are checked against the original's numbers.

import { createDebrisSim, DEBRIS_CAPS, DEBRIS_DEFAULTS, TIER_DEBRIS_SCALE } from './blast-debris-sim.js';

let checks = 0, failures = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b}±${tol})`);
const section = (s) => console.log(s);

// Deterministic PRNG so every run sees the same scatter.
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const fresh = (opts = {}) => createDebrisSim({ groundAt: () => 0, random: mulberry(7), ...opts });

section('constants match html-game-v2');
eq(DEBRIS_CAPS.shrapnel, 900, 'shrapnel pool 900');
eq(DEBRIS_CAPS.rubble, 260, 'rubble pool 260');
eq(DEBRIS_CAPS.sparks, 80, 'spark pool 80');
eq(DEBRIS_CAPS.smoke, 2600, 'smoke pool 2600');
eq(DEBRIS_DEFAULTS.rubbleSmolderChance, 0.28, 'smolder chance 0.28');
eq(TIER_DEBRIS_SCALE.medium.shrapnel, 0.5, 'medium tier halves shrapnel');
eq(TIER_DEBRIS_SCALE.medium.rubble, 0.38, 'medium tier rubble 0.38');
eq(TIER_DEBRIS_SCALE.lite.shrapnel, 0, 'lite tier spawns no shrapnel');

section('spawnBlastShrapnel count follows clamp(16 + 10*size, 14, 56) with size = radius/4');
{
  const sim = fresh();
  eq(sim.spawnBlastShrapnel(0, 1, 0, 4), 26, 'radius 4 -> size 1 -> 26');
  eq(sim.spawnBlastShrapnel(0, 1, 0, 0.4), 17, 'radius 0.4 -> 16 + 1');
  eq(sim.spawnBlastShrapnel(0, 1, 0, 40), 56, 'huge blast caps at 56');
  eq(sim.spawnBlastShrapnel(0, 1, 0, 4, undefined, { countScale: 0.5 }), 13, 'countScale halves');
  const s2 = fresh({ settings: { shrapnelCountScale: 0 } });
  eq(s2.spawnBlastShrapnel(0, 1, 0, 4), 0, 'shrapnelCountScale 0 spawns nothing');
}

section('shrapnel is thrown, falls, bounces on the injected ground, then settles');
{
  const sim = fresh();
  sim.spawnBlastShrapnel(0, 1, 0, 6);
  const p = sim.shrapnel[0];
  const v0 = Math.hypot(p.vx, p.vy, p.vz);
  ok(v0 > 16 * 0.55 && v0 < (16 + 4.5) * 1.45 + 1, `launch speed in range (${v0.toFixed(1)})`);
  ok(p.life >= 20 && p.life <= 28, `life 20-28 s (${p.life.toFixed(1)})`);
  eq(p.maxBounces, 8, 'blast shrapnel gets 8 bounces');
  let bounced = false;
  for (let i = 0; i < 600; i++) { sim.step(1 / 60); if (p.bounces > 0) bounced = true; }
  ok(bounced, 'a fragment bounced within 10 s');
  for (const q of sim.shrapnel) ok(q.y >= q.radius - 1e-6, 'never below ground');
  for (let i = 0; i < 600; i++) sim.step(1 / 60);
  const settled = sim.shrapnel.filter((q) => q.vy === 0 && Math.hypot(q.vx, q.vz) < 0.05).length;
  ok(settled > sim.shrapnel.length * 0.8, `most fragments settled after 20 s (${settled}/${sim.shrapnel.length})`);
  ok(sim.smoke.length > 0 || sim.stats.smokeSpawned > 0, 'shrapnel trailed smoke while moving');
}

section('shrapnel flickers colour and fades over its last 4 s');
{
  const sim = fresh();
  sim.spawnBlastShrapnel(0, 1, 0, 6);
  const p = sim.shrapnel[0];
  const seen = new Set();
  for (let i = 0; i < 120; i++) { sim.step(1 / 60); seen.add(`${p.r.toFixed(3)},${p.g.toFixed(3)}`); }
  ok(seen.size >= 2, `flicker recolours (${seen.size} colours in 2 s)`);
  p.life = 2; sim.step(1 / 60);
  near(p.fade, 2 / 4, 0.02, 'fade = life/4 near the end');
}

section('shrapnel cone bias steers the scatter');
{
  const sim = fresh();
  sim.spawnBlastShrapnel(0, 5, 0, 6, undefined, { direction: [0, -1, 0], directionBias: 0.9 });
  const down = sim.shrapnel.filter((p) => p.vy < 0).length;
  ok(down > sim.shrapnel.length * 0.9, `biased down: ${down}/${sim.shrapnel.length} fragments descend`);
}

section('shrapnel life ends and the pool recycles its oldest when full');
{
  const sim = fresh({ caps: { shrapnel: 20 } });
  sim.spawnBlastShrapnel(0, 1, 0, 6);
  sim.spawnBlastShrapnel(0, 1, 0, 6);
  eq(sim.shrapnel.length, 20, 'capped at 20');
  ok(sim.stats.recycled > 0, 'recycle counted');
  for (const p of sim.shrapnel) p.life = 0.001;
  sim.step(0.01);
  eq(sim.shrapnel.length, 0, 'expired fragments leave the list');
}

section('spawnRubble follows the kill direction and clamp(7 + 6*size, 8, 34)');
{
  const sim = fresh();
  eq(sim.spawnRubble(0, 1, 0, 3, [1, 0]), 25, 'size 3 -> 25 pieces');
  let along = 0;
  for (const r of sim.rubble) if (r.vx > 0) along++;
  eq(along, sim.rubble.length, 'every piece flies +x when the blow came along +x');
  const anySmolder = sim.rubble.some((r) => r.smoldering);
  ok(anySmolder, 'some pieces smoulder at 28% chance');
  for (const r of sim.rubble) {
    ok(r.scaleX !== r.scaleY, 'non-uniform scale');
    ok(r.maxBounces >= 4 && r.maxBounces <= 6, 'rubble gets 4-6 bounces');
  }
  const s2 = fresh();
  eq(s2.spawnRubble(0, 1, 0, 0.1, null), 8, 'tiny target floors at 8');
  eq(s2.spawnRubble(0, 1, 0, 20, null), 34, 'huge target caps at 34');
}

section('smouldering rubble glows, lights, sparks and smokes; per-bounce spin damping');
{
  const sim = fresh({ settings: { rubbleSmolderChance: 1 } });
  sim.spawnRubble(0, 1.5, 0, 3, [0, 1]);
  const r = sim.rubble[0];
  const spin0 = Math.abs(r.sx) + Math.abs(r.sy) + Math.abs(r.sz);
  for (let i = 0; i < 300; i++) sim.step(1 / 60);
  ok(r.glowNow > 0, 'glowNow > 0 while smouldering');
  ok(r.light > 0 && r.lightDist > 0, 'light intensity + distance computed');
  ok(sim.stats.sparksSpawned > 0, 'ember sparks emitted');
  ok(sim.sparks.length <= DEBRIS_CAPS.sparks, 'sparks respect the 80 cap');
  ok(r.bounces > 0, 'rubble bounced');
  ok(Math.abs(r.sx) + Math.abs(r.sy) + Math.abs(r.sz) < spin0, 'spin damped by bounces');
  const hot = sim.hottestRubble(8);
  ok(hot.length <= 8 && hot.length > 0, `hottestRubble returns <= 8 (${hot.length})`);
  for (let i = 1; i < hot.length; i++) ok(hot[i - 1].light >= hot[i].light, 'hottest sorted descending');
  const s2 = fresh({ settings: { rubbleSmolderChance: 1, rubbleLightScale: 0 } });
  s2.spawnRubble(0, 1.5, 0, 3, [0, 1]); s2.step(0.1);
  eq(s2.rubble[0].light, 0, 'rubbleLightScale 0 disables lights');
}

section('impact slabs: big, upward, and they shed secondary shrapnel while fast');
{
  const sim = fresh();
  eq(sim.spawnImpactSlabs(0, 0, 0), 10, '10 slabs by default');
  const r = sim.rubble[0];
  ok(r.slab === true && r.smoldering === true, 'slabs are always smouldering');
  ok(r.vy > 50, `slabs launch hard upward (${r.vy.toFixed(0)} m/s)`);
  ok(r.scaleX > 3, 'slabs are metres across');
  const before = sim.stats.shrapnelSpawned;
  for (let i = 0; i < 90; i++) sim.step(1 / 60);
  ok(sim.stats.shrapnelSpawned > before, 'secondary shrapnel bursts fired from flying slabs');
  ok(sim.stats.smokeSpawned > 20, 'slabs drag dust');
  const small = fresh();
  small.spawnImpactSlabs(0, 0, 0, { scale: 0.25 });
  ok(small.rubble[0].scaleX < r.scaleX, 'scale option shrinks the slabs');
}

section('smoke expands and expires; sparks fly straight');
{
  const sim = fresh();
  sim.spawnSmoke(0, 0, 0, 0, 1, 0, 0.5, 2, 0.4, 0.2, 0.2, 0.2, 1);
  const p = sim.smoke[0];
  sim.step(0.5);
  near(p.y, 0.5, 1e-6, 'smoke drifts with velocity');
  sim.step(0.6);
  eq(sim.smoke.length, 0, 'smoke expires');
  ok(sim.time > 1.09, 'sim clock advances');
}

section('inherited velocity rides on top of the launch vector (NOT html-game-v2: for moving wrecks)');
{
  const still = fresh(); still.spawnBlastShrapnel(0, 200, 0, 24);
  const moving = fresh(); moving.spawnBlastShrapnel(0, 200, 0, 24, undefined, { velocity: [180, 0, 0] });
  eq(moving.shrapnel.length, still.shrapnel.length, 'inheritance does not change the count');
  const mean = (l, k) => l.reduce((t, q) => t + q[k], 0) / l.length;
  near(mean(moving.shrapnel, 'vx') - mean(still.shrapnel, 'vx'), 180, 1e-9, 'every fragment gains vx exactly');
  near(mean(moving.shrapnel, 'vy') - mean(still.shrapnel, 'vy'), 0, 1e-9, 'and nothing else moves');
  ok(moving.shrapnel.every((q) => q.vx > 0), 'a fast enough carrier throws the whole cone forward');
  const r0 = fresh(); r0.spawnRubble(0, 90, 0, 4, [1, 0]);
  const r1 = fresh(); r1.spawnRubble(0, 90, 0, 4, [1, 0], { velocity: [0, -60, 0] });
  near(mean(r1.rubble, 'vy') - mean(r0.rubble, 'vy'), -60, 1e-9, 'rubble inherits too');
  const noOpt = fresh(); noOpt.spawnBlastShrapnel(0, 200, 0, 24);
  eq(JSON.stringify(noOpt.shrapnel[0]), JSON.stringify(still.shrapnel[0]), 'omitting the option changes nothing');
}

section('a settled piece stops being simulated (no ground query, no drift, no spin)');
{
  let queries = 0;
  const sim = createDebrisSim({ groundAt: () => { queries++; return 0; }, random: mulberry(7) });
  sim.spawnBlastShrapnel(0, 1, 0, 6);
  sim.spawnRubble(0, 1, 0, 3, [1, 0], { countScale: 0.5 });
  for (let i = 0; i < 900; i++) sim.step(1 / 60);   // 15 s: long since down, well short of the 20 s life
  const resting = sim.shrapnel.filter((q) => q.resting).length;
  ok(resting > sim.shrapnel.length * 0.8, `most shrapnel is resting (${resting}/${sim.shrapnel.length})`);
  ok(sim.rubble.every((r) => r.resting), 'all rubble is resting');
  const before = queries;
  // Guarded: if the spin damping ever regresses, nothing rests at all and every assertion below
  // would throw on undefined instead of reporting. A crashed suite names the wrong culprit.
  const p0 = sim.shrapnel.find((q) => q.resting);
  const r0 = sim.rubble[0];
  if (!p0 || !r0) { ok(false, 'no resting piece to inspect -- the rest of this section cannot run'); }
  else {
  const snap = { x: p0.x, y: p0.y, z: p0.z, rx: p0.rx };
  const rSnap = { x: r0.x, y: r0.y, rx: r0.rx, glow: r0.glowNow };
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  eq(queries - before, 0, 'a second of stepping costs zero ground queries once everything has settled');
  eq(p0.x === snap.x && p0.y === snap.y && p0.z === snap.z, true, 'a resting fragment does not drift');
  eq(p0.rx, snap.rx, 'and does not keep spinning on the ground (its spin was damped out first)');
  eq(r0.x === rSnap.x && r0.y === rSnap.y && r0.rx === rSnap.rx, true, 'resting rubble is likewise still');
  ok(p0.fade < 1 || p0.life > 4, 'fade still runs while resting');
  if (r0.smoldering) ok(r0.glowNow > 0, 'resting rubble still smoulders');
  }
  // Nothing rests in mid-air: the flag is only ever set from the ground contact branch.
  const air = fresh(); air.spawnBlastShrapnel(0, 400, 0, 24);
  for (let i = 0; i < 30; i++) air.step(1 / 60);
  ok(air.shrapnel.every((q) => !q.resting), 'a falling fragment is never resting');
}

section('nothing is frozen mid-spin, and hottestRubble selects without sorting');
{
  // The rest test covers spin as well as speed, because html-game-v2 never damped shrapnel spin:
  // skipping a piece that is still turning at 7 rad/s would stop it dead in one frame.
  const sim = fresh();
  sim.spawnBlastShrapnel(0, 1, 0, 6);
  sim.spawnRubble(0, 1, 0, 3, [1, 0]);
  sim.spawnImpactSlabs(0, 0, 0, { scale: 0.3 });
  ok(sim.rubble.every((r) => Object.prototype.hasOwnProperty.call(r, 'resting')),
    'every rubble record, slabs included, carries the resting flag from birth');
  // The real assertion is that grounded SHRAPNEL damps its spin at all: html-game-v2 never did, and
  // without that a piece can satisfy the speed test while still turning, which is what made the
  // freeze visible. Asserting "spin at rest is under the rest threshold" would only restate the guard.
  const spin = (q) => Math.abs(q.sx) + Math.abs(q.sy) + Math.abs(q.sz);
  const tracked = sim.shrapnel.map((q) => ({ q, spawn: spin(q), atFirstContact: -1 }));
  let anyDamped = false;
  for (let i = 0; i < 1500; i++) {
    sim.step(1 / 60);
    for (const t of tracked) {
      if (t.atFirstContact < 0) { if (t.q.bounces > 0) t.atFirstContact = spin(t.q); }
      else if (spin(t.q) < t.atFirstContact - 1e-9) anyDamped = true;
    }
  }
  ok(anyDamped, 'shrapnel spin decays once it is on the ground');
  ok(tracked.some((t) => t.spawn > 5), `and it was born with a lot of it (max ${Math.max(...tracked.map((t) => t.spawn)).toFixed(1)} rad/s)`);
  const landed = tracked.filter((t) => t.q.resting);
  ok(landed.length > 0, `fragments landed and rested (${landed.length}/${tracked.length})`);
  ok(landed.every((t) => spin(t.q) < t.spawn * 0.02),
    'a rested fragment has shed essentially all of the spin it was born with');
  ok(sim.rubble.every((r) => r.resting), 'rubble rests too');

  // top-n selection has to agree with what a sort would have returned
  const s2 = fresh({ settings: { rubbleSmolderChance: 1 } });
  s2.spawnRubble(0, 2, 0, 5, [1, 0]);
  s2.spawnRubble(9, 2, 3, 4, [0, 1]);
  for (let i = 0; i < 90; i++) s2.step(1 / 60);
  const bySort = s2.rubble.filter((r) => r.light > 0).sort((x, y) => y.light - x.light);
  for (const n of [0, 1, 2, 8, 1000]) {
    const got = s2.hottestRubble(n);
    const want = bySort.slice(0, n);
    eq(got.length, want.length, `hottestRubble(${n}) returns the right count`);
    ok(got.every((r, i) => r === want[i]), `hottestRubble(${n}) matches a full sort, element for element`);
  }
  ok(bySort.length > 8, `and the pool was bigger than the ask (${bySort.length} lit)`);
}

section('clear empties everything');
{
  const sim = fresh();
  sim.spawnBlastShrapnel(0, 1, 0, 6); sim.spawnRubble(0, 1, 0, 3, null); sim.step(0.2);
  sim.clear();
  const c = sim.counts();
  eq(c.shrapnel + c.rubble + c.sparks + c.smoke, 0, 'all lists empty');
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
