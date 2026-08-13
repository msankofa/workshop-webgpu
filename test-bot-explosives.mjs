// test-bot-explosives.mjs — integration test across the three explosive modules, mirroring the
// wiring bot-viewer-v2.html uses: bot-grenade decides, bot-projectiles solves + flies, the real
// weapons.js specs drive both. Guards the glue (arc-lift compensation, arc:[0,0,0] + explicit
// gravity, trail cadence, fizzle silence) that lives in the viewer and so has no test of its own.

import { getWeapon } from './weapons.js';
import { solveBallisticArc, sampleArcPoints, createProjectileManager } from './bot-projectiles.js';
import { GRENADE_DEFAULTS, chooseGrenadeThrow, grenadeEvade } from './bot-grenade.js';
import { rayCapsuleHit } from './combat.js';

// Seeded PRNG so the broadphase fuzz below is reproducible.
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error(`FAIL: ${label}`); }
}
function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol, `${label} (got ${actual}, want ${expected} +/- ${tol})`);
}

const GRENADE = getWeapon('grenade');
const RPG = getWeapon('rpg');
const STEP = 1 / 60;

// The viewer's launch path: solved velocity in, spec arc deliberately NOT re-applied.
function launch(manager, weapon, origin, velocity, extra = {}) {
  const spec = weapon.projectile;
  const speed = Math.hypot(velocity.vx, velocity.vy, velocity.vz) || 1;
  return manager.spawn({
    origin,
    dir: [velocity.vx / speed, velocity.vy / speed, velocity.vz / speed],
    speed,
    arc: [0, 0, 0],
    gravity: spec.gravity ?? 0,
    life: spec.life, fuse: spec.fuse,
    bounces: spec.bounces === true,
    fizzleOnExpire: spec.fizzleOnExpire === true,
    radius: spec.radius, blastRadius: spec.blastRadius,
    damage: weapon.damage, weaponId: weapon.id, ownerId: 'thrower', throwerActorId: 'thrower',
    ...extra,
  });
}

// The viewer's solveGrenadeThrow: solve, then re-solve at a lifted aim to cancel the integrator's
// systematic undershoot (semi-implicit Euler decrements vy before integrating).
// groundY mirrors the viewer's groundHeight(): the aim is dropped to the floor under the target,
// because a lob solved to chest height passes through the target and lands many metres long.
function solveThrow(from, aimPoint, spec, groundY = 0) {
  const grounded = [aimPoint[0], groundY + 0.15, aimPoint[2]];
  const flat = Math.hypot(grounded[0] - from[0], grounded[2] - from[2]);
  let vel = solveBallisticArc(from, grounded, spec.speed, spec.gravity);
  if (!vel) return null;
  const flightS = flat / Math.max(0.1, Math.hypot(vel.vx, vel.vz));
  if (spec.gravity > 0) {
    const lifted = [grounded[0], grounded[1] + 0.5 * spec.gravity * STEP * flightS, grounded[2]];
    vel = solveBallisticArc(from, lifted, spec.speed, spec.gravity) || vel;
  }
  return { vel, flightS, grounded };
}

function flatGround() { return () => 0; }
function runToDetonation(manager, maxSteps = 600) {
  for (let i = 0; i < maxSteps && manager.list.length > 0; i++) manager.update(STEP);
}

// ---- 1. a decided throw actually lands near where the decision aimed ----
{
  const settings = { ...GRENADE_DEFAULTS, selfRadiusScale: 0, friendlyRadiusScale: 0 };
  const self = { id: 'me', team: 'alpha', p: [0, 1, 0] };
  const target = { id: 'foe', p: [0, 1, 20], visible: true, lastKnownP: null, lastKnownAt: null, velocity: null };
  const choice = chooseGrenadeThrow({
    self, target,
    enemies: [{ id: 'foe', p: [0, 1, 20] }, { id: 'foe2', p: [2, 1, 21] }],
    allies: [], blastRadius: GRENADE.projectile.blastRadius,
    grenadesLeft: 2, lastThrowAt: null, lastTeamThrowAt: null, now: 10000,
  }, settings);
  ok(choice !== null, 'a two-enemy cluster at 20 m produces a throw');

  const solved = solveThrow(self.p, choice.aimPoint, GRENADE.projectile);
  ok(solved !== null, 'the 20 m lob is solvable at the authored speed/gravity');

  let blast = null;
  const manager = createProjectileManager({
    terrainHeight: flatGround(),
    onDetonate: (point) => { blast = point; },
  });
  const proj = launch(manager, GRENADE, self.p, solved.vel);
  // First ground contact is the aiming result; the fuse then runs on while it bounces.
  let firstContact = null;
  for (let i = 0; i < 600 && manager.list.length > 0; i++) {
    manager.update(STEP);
    if (!firstContact && proj.transform.p[1] <= 0.13) firstContact = proj.transform.p.slice();
  }
  ok(firstContact !== null, 'the thrown grenade reaches the ground');
  const miss = Math.hypot(firstContact[0] - solved.grounded[0], firstContact[2] - solved.grounded[2]);
  ok(miss < 1.0, `lift-compensated throw first lands within 1 m of the aim point (missed by ${miss.toFixed(2)} m)`);
  ok(blast !== null, 'the thrown grenade detonates');
  ok(manager.list.length === 0, 'the projectile is removed after detonating');
}

// ---- 2. the spec's own `arc` must not be re-applied on top of a solved velocity ----
{
  const from = [0, 1, 0], aim = [0, 1, 18];
  const solved = solveThrow(from, aim, GRENADE.projectile);
  const firstContactZ = (extra) => {
    const m = createProjectileManager({ terrainHeight: flatGround(), onDetonate: () => {} });
    const p = launch(m, GRENADE, from, solved.vel, extra);
    for (let i = 0; i < 600 && m.list.length > 0; i++) {
      m.update(STEP);
      if (p.transform.p[1] <= 0.13) return p.transform.p[2];
    }
    return Infinity;
  };
  const cleanMiss = Math.abs(firstContactZ({}) - solved.grounded[2]);
  const arcMiss = Math.abs(firstContactZ({ arc: GRENADE.projectile.arc }) - solved.grounded[2]);
  ok(cleanMiss < 1.0, 'arc:[0,0,0] lands on target');
  ok(arcMiss > cleanMiss + 2, `re-applying the spec arc overshoots badly (${arcMiss.toFixed(1)} m vs ${cleanMiss.toFixed(1)} m) — the viewer must zero it`);
}

// ---- 3. gravity must be passed explicitly: create() defaults it to 0 ----
{
  const from = [0, 1, 0], aim = [0, 1, 18];
  const solved = solveThrow(from, aim, GRENADE.projectile);
  let landed = null;
  const manager = createProjectileManager({ terrainHeight: flatGround(), onDetonate: (p) => { landed = p; } });
  // Deliberately omit gravity, as a careless caller would.
  const speed = Math.hypot(solved.vel.vx, solved.vel.vy, solved.vel.vz);
  manager.spawn({
    origin: from, dir: [solved.vel.vx / speed, solved.vel.vy / speed, solved.vel.vz / speed], speed,
    arc: [0, 0, 0], life: GRENADE.projectile.life, fuse: GRENADE.projectile.fuse,
    bounces: true, radius: 0.35, blastRadius: 15, weaponId: 'grenade',
  });
  runToDetonation(manager);
  ok(landed !== null, 'the gravity-less grenade still detonates on its fuse');
  ok(landed[1] > 3, `without explicit gravity the "lob" is still airborne at detonation (y=${landed[1].toFixed(1)}) — proves the spec gravity must be forwarded`);
}

// ---- 4. rocket: straight flight, detonates at a raycast hit, trails smoke on the way ----
{
  const wall = 40;
  const trail = [];
  let blast = null;
  const manager = createProjectileManager({
    terrainHeight: () => -1000,
    raycast: (from, to) => (to[2] >= wall ? { point: [0, 1, wall], kind: 'obstacle' } : null),
    onDetonate: (point) => { blast = point; },
    onTrail: (proj, point) => { trail.push(point); },
    trailIntervalS: 0.035,
  });
  launch(manager, RPG, [0, 1, 0], { vx: 0, vy: 0, vz: RPG.projectile.speed });
  runToDetonation(manager);
  ok(blast !== null && Math.abs(blast[2] - wall) < 1e-6, 'the rocket detonates exactly at the raycast hit point');
  const flightS = wall / RPG.projectile.speed;
  const expectedPuffs = Math.floor(flightS / 0.035);
  ok(trail.length >= expectedPuffs - 2 && trail.length <= expectedPuffs + 2,
    `trail cadence matches flight time (${trail.length} puffs, expected ~${expectedPuffs})`);
  ok(trail.every((p) => p[0] === 0 && Math.abs(p[1] - 1) < 1e-6), 'trail puffs sit on the rocket line');
}

// ---- 5. a rocket that hits nothing fizzles: no blast ----
{
  let blast = null;
  const manager = createProjectileManager({ terrainHeight: () => -1000, onDetonate: (p) => { blast = p; } });
  launch(manager, RPG, [0, 1, 0], { vx: 0, vy: 0, vz: RPG.projectile.speed });
  for (let i = 0; i < 3000 && manager.list.length > 0; i++) manager.update(STEP);
  ok(blast === null, 'an expiring rocket fizzles silently (fizzleOnExpire)');
  ok(manager.list.length === 0, 'the fizzled rocket is still removed');
}

// ---- 6. evade: a bot inside a live grenade's blast is told to run, and urgency rises ----
{
  const threatFar = [{ p: [0, 1, 0], blastRadius: 15, fuseRemainingS: 1.8 }];
  const threatSoon = [{ p: [0, 1, 0], blastRadius: 15, fuseRemainingS: 0.2 }];
  ok(grenadeEvade([30, 1, 0], threatFar, GRENADE_DEFAULTS) === null, 'a bot outside the blast is not told to run');
  const early = grenadeEvade([5, 1, 0], threatFar, GRENADE_DEFAULTS);
  const late = grenadeEvade([5, 1, 0], threatSoon, GRENADE_DEFAULTS);
  ok(early !== null && late !== null, 'a bot inside the blast is told to run');
  ok(late.urgency > early.urgency, 'urgency rises as the fuse runs down');
  ok(Math.hypot(early.from[0] - 0, early.from[2] - 0) < 1e-6, 'the evade origin is the grenade itself');
}

// ---- 7. the arc clearance sampler brackets the real flight ----
{
  const from = [0, 1, 0], aim = [0, 1, 22];
  const solved = solveThrow(from, aim, GRENADE.projectile);
  const pts = sampleArcPoints(from, solved.vel, GRENADE.projectile.gravity, 6, solved.flightS);
  ok(pts.length === 7, 'sampleArcPoints returns steps+1 points');
  ok(Math.abs(pts[0][0] - from[0]) < 1e-9 && Math.abs(pts[0][2] - from[2]) < 1e-9, 'the first sample is the launch point');
  const last = pts[pts.length - 1];
  near(Math.hypot(last[0] - aim[0], last[2] - aim[2]), 0, 1.0, 'the last sample lands near the aim point');
  const apex = Math.max(...pts.map((p) => p[1]));
  ok(apex > from[1], 'the sampled lob actually arcs above the launch height');
}

// ---- 8. projectileRaycast's broadphase reject can never drop a real capsule hit ----
// The viewer skips rayCapsuleHit when |centre - from|^2 > (range + r + h/2)^2. That is only sound
// if every point of the capsule lies within r + h/2 of its centre; this fuzzes the claim.
{
  const rnd = mulberry(0xbeef);
  let tested = 0, missedByBroadphase = 0, rejected = 0;
  for (let i = 0; i < 20000; i++) {
    const from = [rnd() * 40 - 20, rnd() * 4, rnd() * 40 - 20];
    let dx = rnd() * 2 - 1, dy = rnd() * 2 - 1, dz = rnd() * 2 - 1;
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const range = 0.2 + rnd() * 4;
    const r = 0.2 + rnd() * 0.6, h = 0.8 + rnd() * 1.4;
    const cap = { id: 'c', p: [rnd() * 40 - 20, rnd() * 4, rnd() * 40 - 20], r, h, alive: true };
    const cx = cap.p[0] - from[0], cy = cap.p[1] - from[1], cz = cap.p[2] - from[2];
    const reach = range + r + h * 0.5;
    const accepted = (cx * cx + cy * cy + cz * cz) <= reach * reach;
    const hit = rayCapsuleHit(from, [dx, dy, dz], range, cap);
    tested++;
    if (!accepted) { rejected++; if (hit.hit) missedByBroadphase++; }
  }
  ok(missedByBroadphase === 0, `broadphase never rejects a real hit (${missedByBroadphase} of ${tested} lost)`);
  ok(rejected > tested * 0.5, `broadphase actually rejects the bulk of the roster (${rejected}/${tested})`);
}

// ---- 9. the effect list's single-pass compaction keeps order and drops only the expired ----
{
  const list = [];
  for (let i = 0; i < 10; i++) list.push({ id: `fx${i}`, expireAt: i * 100 });
  const now = 450;
  let w = 0;
  for (let i = 0; i < list.length; i++) { const e = list[i]; if (now < e.expireAt) list[w++] = e; }
  list.length = w;
  ok(list.length === 5, `compaction drops every expired entry (kept ${list.length}, want 5)`);
  ok(list[0].id === 'fx5' && list[4].id === 'fx9', 'compaction preserves insertion order');
  ok(list.every((e) => e.expireAt > now), 'no expired entry survives compaction');
}

// ---- 10. live-tuned grenade ordnance: the viewer's fuse/radius/damage overrides ----
// Mirrors bot-viewer-v2's botGrenadeBlast launch path. The trap it guards: `life` expiry ALSO
// detonates, so a fuse pushed past the authored 2.15 s life would silently stop mattering unless
// the launch stretches life with it.
{
  const FUSE_TAIL_S = 0.5;   // GRENADE_FUSE_TAIL_S in the viewer
  const tunedLaunch = (manager, blast) => {
    const spec = GRENADE.projectile;
    return launch(manager, GRENADE, [0, 40, 0], { vx: 0, vy: 0, vz: 1 }, {
      gravity: 0,   // drift it level, far above the floor: this is a fuse test, not a ballistics one
      fuse: blast.fuseS,
      life: Math.max(spec.life ?? 0, blast.fuseS + FUSE_TAIL_S),
      blastRadius: blast.blastRadius, damage: blast.damage,
    });
  };
  const detonationAge = (blast) => {
    let age = null;
    const manager = createProjectileManager({ terrainHeight: () => -1000, onDetonate: (p, proj) => { age = proj.sim.age; } });
    tunedLaunch(manager, blast);
    runToDetonation(manager, 2000);
    return age;
  };
  near(detonationAge({ fuseS: 2, blastRadius: 15, damage: 95 }), 2, STEP * 1.5, 'the authored 2 s fuse detonates on time');
  near(detonationAge({ fuseS: 5, blastRadius: 15, damage: 95 }), 5, STEP * 1.5,
    'a fuse past the authored 2.15 s life still detonates on the fuse, not on life expiry');
  near(detonationAge({ fuseS: 0.3, blastRadius: 15, damage: 95 }), 0.3, STEP * 1.5, 'a short fuse cooks off early');

  const manager = createProjectileManager({ terrainHeight: () => -1000, onDetonate: () => {} });
  const proj = tunedLaunch(manager, { fuseS: 3, blastRadius: 22, damage: 140 });
  ok(proj.state.blastRadius === 22, 'the tuned radius is what the projectile carries (the evade scan reads it)');
  ok(proj.state.damage === 140, 'the tuned damage rides the projectile');

  // The rolled fuse: jitter spreads a volley but never cooks in the hand.
  const rolled = (fuseS, jitterS, r) => Math.max(0.15, fuseS + (r * 2 - 1) * jitterS);
  ok(rolled(2, 0, 0.9) === 2, 'zero jitter leaves every grenade on the same fuse');
  ok(rolled(2, 0.5, 1) === 2.5 && rolled(2, 0.5, 0) === 1.5, 'jitter spans +/- the full amount');
  ok(rolled(0.2, 5, 0) === 0.15, 'a wide jitter is clamped off zero rather than detonating on release');
}

// ---- 11. the fuse must survive the throw: a THROWN grenade detonates on its timer ----
// The regression this pins: contact used to be checked before the fuse, and a grenade lands and
// spends its 2-bounce budget in under a second — so every fuse longer than the flight (including
// the authored 2 s one) detonated early on ground contact and the delay was unreachable.
{
  const spec = GRENADE.projectile;
  const throwAndTime = (fuseS, extra = {}) => {
    let at = null, elapsed = 0;
    const manager = createProjectileManager({ terrainHeight: flatGround(), onDetonate: () => { at = elapsed; } });
    const from = [0, 1.5, 0];
    const solved = solveThrow(from, [0, 1, 20], spec);
    launch(manager, GRENADE, from, solved.vel, {
      fuse: fuseS, life: Math.max(spec.life, fuseS + 0.5), cooks: true, ...extra,
    });
    for (let i = 0; i < 1500 && manager.list.length > 0; i++) { manager.update(STEP); elapsed += STEP; }
    return at;
  };
  near(throwAndTime(2), 2, STEP * 2, 'the authored 2 s fuse survives the landing');
  near(throwAndTime(5), 5, STEP * 2, 'a long fuse cooks on the ground for its full delay');
  near(throwAndTime(0.4), 0.4, STEP * 2, 'a fuse shorter than the flight still airbursts on time');

  // ...and without the cook flag, contact still wins — the rocket/game path is unchanged.
  const contactTime = throwAndTime(5, { cooks: false });
  ok(contactTime !== null && contactTime < 1.5,
    `an uncooked grenade still detonates on contact (${contactTime?.toFixed(2)}s), leaving the shipped game's behaviour alone`);

  // A cooking grenade that hits a wall drops and cooks rather than detonating on the wall.
  {
    let at = null, elapsed = 0;
    const manager = createProjectileManager({
      terrainHeight: flatGround(),
      raycast: (from, to) => (to[2] >= 5 ? { point: [to[0], to[1], 5], kind: 'obstacle', id: null, distance: 1 } : null),
      onDetonate: () => { at = elapsed; },
    });
    launch(manager, GRENADE, [0, 1.5, 0], { vx: 0, vy: 2, vz: 18 }, { fuse: 3, life: 4, cooks: true });
    for (let i = 0; i < 900 && manager.list.length > 0; i++) { manager.update(STEP); elapsed += STEP; }
    near(at, 3, STEP * 2, 'a grenade that bonks a wall keeps cooking instead of detonating on impact');
  }
}

if (failures) {
  console.error(`\nbot-explosives: ${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`bot-explosives: all ${checks} checks passed.`);
