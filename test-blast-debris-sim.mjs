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
