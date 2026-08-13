// Runs in Node.js. Verifies bot-projectiles.js: ballistic arc solving, arc sampling, the
// projectile manager's wrapping of combat-projectile (detonate/trail/removal), and grenade
// threat lookup. Run: node test-bot-projectiles.mjs
import { solveBallisticArc, sampleArcPoints, createProjectileManager, livingGrenadeThreat } from './bot-projectiles.js';

let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error('FAIL:', msg); } };
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;

// --- arc solver: re-simulating the solved velocity forward lands on the target ---
{
  const from = [0, 1.6, 0], to = [22, 0.5, -9], speed = 35, g = 24;
  const v = solveBallisticArc(from, to, speed, g);
  ok(v !== null, 'in-range throw has a solution');
  ok(near(Math.hypot(v.vx, v.vy, v.vz), speed, 1e-6), `solved velocity has the requested speed — got ${Math.hypot(v.vx, v.vy, v.vz)}`);

  // analytic: at the time the horizontal distance is covered, height must match
  const d = Math.hypot(to[0] - from[0], to[2] - from[2]);
  const horiz = Math.hypot(v.vx, v.vz);
  const t = d / horiz;
  const y = from[1] + v.vy * t - 0.5 * g * t * t;
  ok(near(y, to[1], 1e-6), `arc height at arrival matches target — got ${y} want ${to[1]}`);

  // forward re-sim through sampleArcPoints: some sample comes within tolerance of the target
  const pts = sampleArcPoints(from, v, g, 4000, t * 1.1);
  let best = Infinity;
  for (const p of pts) best = Math.min(best, Math.hypot(p[0] - to[0], p[1] - to[1], p[2] - to[2]));
  ok(best < 0.05, `re-simulated path passes through the target — closest ${best.toFixed(4)}`);

  // low arc: the flat root is chosen, so launch pitch stays under 45 degrees for this shot
  ok(Math.atan2(v.vy, horiz) < Math.PI / 4, 'low-arc (flat) root chosen');
}

// --- out of range / degenerate inputs return null ---
{
  ok(solveBallisticArc([0, 0, 0], [200, 0, 0], 10, 24) === null, 'target beyond max range returns null');
  ok(solveBallisticArc([0, 0, 0], [0, 10, 0], 35, 24) === null, 'zero horizontal distance returns null');
  ok(solveBallisticArc([0, 0, 0], [0, 0, 0], 35, 0) === null, 'zero-length throw returns null');
  ok(solveBallisticArc([0, 0, 0], [10, 0, 0], 0, 24) === null, 'zero speed returns null');
  ok(solveBallisticArc([0, 0, 0], [NaN, 0, 0], 35, 24) === null, 'NaN target returns null');
}

// --- zero gravity is a straight line at full speed ---
{
  const v = solveBallisticArc([0, 0, 0], [0, 0, 10], 50, 0);
  ok(v && near(v.vx, 0) && near(v.vy, 0) && near(v.vz, 50), `zero gravity gives a straight shot — got ${JSON.stringify(v)}`);
  const diag = solveBallisticArc([0, 0, 0], [3, 4, 0], 100, 0);
  ok(diag && near(diag.vx, 60) && near(diag.vy, 80), `zero gravity keeps the aim direction — got ${JSON.stringify(diag)}`);
}

// --- sampleArcPoints spans the requested time and starts at the origin ---
{
  const pts = sampleArcPoints([1, 2, 3], { vx: 10, vy: 0, vz: 0 }, 0, 6, 2.0);
  ok(pts.length === 7, `steps+1 points returned (origin included) — got ${pts.length}`);
  ok(pts[0][0] === 1 && pts[0][1] === 2 && pts[0][2] === 3, 'first sample is the launch point');
  ok(near(pts[6][0], 21), `last sample is at t=span — got ${pts[6][0]}`);
  const drop = sampleArcPoints([0, 0, 0], { vx: 0, vy: 0, vz: 0 }, 20, 2, 2.0);
  ok(near(drop[2][1], -40), `gravity applied to samples — got ${drop[2][1]}`);
}

// helper: a manager with recording callbacks
function makeManager(opts = {}) {
  const dets = [];
  const trails = [];
  const mgr = createProjectileManager({
    onDetonate: (p, proj) => dets.push({ p: p.slice(), id: proj.id, weaponId: proj.weaponId }),
    onTrail: (proj, p) => trails.push({ id: proj.id, p: p.slice() }),
    ...opts,
  });
  return { mgr, dets, trails };
}

const GRENADE = { origin: [0, 1.6, 0], dir: [0, 0, 1], speed: 35, gravity: 24, arc: [0, 4.8, 0], fuse: 2.0, life: 2.15, bounces: true, radius: 0.35, blastRadius: 15, damage: 95, weaponId: 'grenade' };
const ROCKET = { origin: [0, 5, 0], dir: [0, 0, 1], speed: 108, gravity: 0, life: 19, radius: 0.42, blastRadius: 8.2, damage: 110, fizzleOnExpire: true, weaponId: 'rpg' };

// --- empty manager is safe; spawn metadata is populated ---
{
  const { mgr } = makeManager();
  mgr.update(0.016);
  ok(mgr.list.length === 0, 'update on an empty list is a no-op');
  const a = mgr.spawn({ ...GRENADE, throwerActorId: 'bot7' });
  const b = mgr.spawn({ ...ROCKET });
  ok(a.id !== b.id && typeof a.id === 'string', `ids are unique strings — ${a.id} / ${b.id}`);
  ok(a.weaponId === 'grenade' && a.throwerActorId === 'bot7', 'weaponId/throwerActorId stored on the projectile');
  ok(Array.isArray(a.transform.p) && a.sim && a.state, 'projectile exposes transform/sim/state');
  ok(mgr.list.length === 2, 'spawned projectiles are live');
  mgr.update(0.05);
  ok(a.prevP[1] === 1.6 && a.transform.p[1] !== a.prevP[1], 'prevP holds the position at the start of the update');
  mgr.clear();
  ok(mgr.list.length === 0, 'clear() empties the list');
}

// --- grenade fuse detonates in air at the fuse time ---
{
  const { mgr, dets } = makeManager(); // no terrainHeight -> never hits the ground
  mgr.spawn({ ...GRENADE });
  let t = 0;
  for (let i = 0; i < 200 && mgr.list.length; i++) { mgr.update(0.05); t += 0.05; }
  ok(dets.length === 1, `fuse fires onDetonate exactly once — got ${dets.length}`);
  ok(t >= 1.95 && t <= 2.11, `detonation lands at the fuse time — got t=${t.toFixed(2)}`);
  ok(mgr.list.length === 0, 'detonated grenade is removed from the list');
}

// --- bouncing grenade bounces off terrain instead of detonating on first contact ---
{
  const { mgr, dets } = makeManager({ terrainHeight: () => 0 });
  const g = mgr.spawn({ ...GRENADE, origin: [0, 0.5, 0], dir: [0, -1, 0], speed: 5, arc: [0, 0, 0], fuse: Infinity });
  mgr.update(0.1);
  ok(dets.length === 0, 'no detonation on first ground contact');
  ok(g.sim.bounceCount === 1, `bounce counted — got ${g.sim.bounceCount}`);
  ok(g.sim.vy > 0, 'bounce flips vy upward');
  ok(mgr.list.length === 1, 'bounced grenade stays live');
}

// --- a non-bouncing grenade detonates on the ground ---
{
  const { mgr, dets } = makeManager({ terrainHeight: () => 0 });
  mgr.spawn({ ...GRENADE, origin: [0, 0.5, 0], dir: [0, -1, 0], speed: 5, arc: [0, 0, 0], fuse: Infinity, bounces: false });
  mgr.update(0.1);
  ok(dets.length === 1 && near(dets[0].p[1], 0.12), `terrain impact detonates at ground clearance — got ${JSON.stringify(dets[0] && dets[0].p)}`);
  ok(mgr.list.length === 0, 'ground-detonated grenade removed');
}

// --- fizzleOnExpire rocket expires silently (no onDetonate) ---
{
  const { mgr, dets } = makeManager();
  mgr.spawn({ ...ROCKET, life: 0.2 });
  mgr.update(0.15);
  ok(mgr.list.length === 1 && dets.length === 0, 'rocket still flying before life end');
  mgr.update(0.15);
  ok(mgr.list.length === 0, 'expired rocket removed from the list');
  ok(dets.length === 0, `fizzleOnExpire never calls onDetonate — got ${dets.length}`);
}

// --- a grenade WITHOUT fizzleOnExpire airbursts at life end (onDetonate fires) ---
{
  const { mgr, dets } = makeManager();
  mgr.spawn({ ...GRENADE, fuse: Infinity, life: 0.2, gravity: 0, arc: [0, 0, 0] });
  mgr.update(0.15); mgr.update(0.15);
  ok(dets.length === 1, `life-expiry airburst reaches onDetonate — got ${dets.length}`);
}

// --- raycast hit detonates at the returned point, and gets the owner id ---
{
  let seen = null;
  const { mgr, dets } = makeManager({
    raycast: (from, to, radius, ownerId) => { seen = { radius, ownerId }; return { point: [0, 5, 7], kind: 'bot', id: 'b3' }; },
  });
  const r = mgr.spawn({ ...ROCKET, ownerId: 'bot1' });
  mgr.update(0.1);
  ok(dets.length === 1 && dets[0].p[2] === 7, `detonates at the raycast hit point — got ${JSON.stringify(dets[0] && dets[0].p)}`);
  ok(dets[0].id === r.id && dets[0].weaponId === 'rpg', 'onDetonate receives the projectile itself');
  ok(seen && seen.ownerId === 'bot1' && near(seen.radius, 0.42), `raycast receives radius+ownerId — got ${JSON.stringify(seen)}`);
  ok(mgr.list.length === 0, 'hit projectile removed');
}

// --- trail cadence ---
{
  const { mgr, trails } = makeManager({ trailIntervalS: 0.035 });
  mgr.spawn({ ...ROCKET });
  for (let i = 0; i < 20; i++) mgr.update(0.05); // 1.0 s of flight
  const expected = Math.floor(1.0 / 0.035);
  ok(Math.abs(trails.length - expected) <= 1, `trail fires ~1/${0.035}s — got ${trails.length}, expected ~${expected}`);
  ok(trails[0].p.length === 3, 'trail receives a position array');

  const { mgr: m2, trails: t2 } = makeManager({ trailIntervalS: 0.035 });
  m2.spawn({ ...ROCKET });
  m2.update(0.02);
  ok(t2.length === 0, 'no trail emitted before one interval has elapsed');
}

// --- livingGrenadeThreat ---
{
  const { mgr } = makeManager();
  const far = mgr.spawn({ ...GRENADE, origin: [10, 0, 0] });
  const nearG = mgr.spawn({ ...GRENADE, origin: [3, 0, 0] });
  const rocket = mgr.spawn({ ...ROCKET, origin: [1, 0, 0], blastRadius: 50 });
  const hit = livingGrenadeThreat(mgr.list, [0, 0, 0]);
  ok(hit === nearG, `nearest covering grenade wins — got ${hit && hit.id}`);
  ok(livingGrenadeThreat([rocket], [0, 0, 0]) === null, 'rockets are ignored even when their blast covers the point');
  ok(livingGrenadeThreat(mgr.list, [40, 0, 0]) === null, 'point outside every blast radius returns null');
  ok(livingGrenadeThreat([far], [30, 0, 0]) === null, 'grenade 20m away with a 15m blast is not a threat');
  ok(livingGrenadeThreat([far], [30, 0, 0], 6) === far, 'extraRadius widens the threat check');
  ok(livingGrenadeThreat([], [0, 0, 0]) === null, 'empty list returns null');
  ok(livingGrenadeThreat(null, [0, 0, 0]) === null, 'non-array list returns null');

  // a bouncing projectile counts even without weaponId 'grenade'
  const { mgr: m3 } = makeManager();
  const bouncer = m3.spawn({ origin: [2, 0, 0], dir: [0, 0, 1], speed: 10, bounces: true, blastRadius: 10, weaponId: 'improvised' });
  ok(livingGrenadeThreat(m3.list, [0, 0, 0]) === bouncer, 'state.bounces qualifies a projectile as a grenade threat');
}

if (failed > 0) { console.error(`${failed} test(s) failed.`); process.exit(1); }
console.log('bot-projectiles.js tests passed.');
