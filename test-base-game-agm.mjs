// The Sentinel's air-to-ground missile: the rack that decides when one may leave, and the steering
// that turns one onto a point. Both run identically on the server and in Solo, so this is where the
// numbers are pinned. Run: node test-base-game-agm.mjs
import { spawnWorldDrone, createBaseGameDrone, fireAgm, agmReady, steerToward, stepGuidedProjectiles, BASE_GAME_DRONE_DEFS, DRONE_SENTINEL, DRONE_UAV } from './base-game-drones.js';

let failed = 0;
function ok(msg, cond, detail = '') { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${detail ? '  ' + detail : ''}`); if (!cond) failed++; }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const groundY = () => 0;

// ── the rack ────────────────────────────────────────────────────────────────
const sentinel = spawnWorldDrone(DRONE_SENTINEL, { ownerId: 'me', at: [0, 0, 0], look: [0, 0, -1], alt: 150, radius: 400, groundAt: groundY });
const def = BASE_GAME_DRONE_DEFS[DRONE_SENTINEL].agm;
ok('the Sentinel carries a rack', !!def && sentinel.agm.left === def.rounds, `${sentinel.agm?.left} rounds`);

const uav = createBaseGameDrone(DRONE_UAV, { ownerId: 'me', from: [0, 20, 0], groundY: 0 });
ok('the UAV carries none', uav.agm === null && !agmReady(uav));
ok('a bad aim fires nothing', fireAgm(sentinel, [0, NaN, 0], 0) === null);

const target = [sentinel.d.p[0] + 200, 0, sentinel.d.p[2] + 200];
const shot = fireAgm(sentinel, target, 0);
ok('a round comes off the rack', !!shot && sentinel.agm.left === def.rounds - 1, `${sentinel.agm.left} left`);
ok('it leaves from under the belly', shot.origin[1] < sentinel.d.p[1], `${shot.origin[1].toFixed(1)} vs ${sentinel.d.p[1].toFixed(1)}`);
ok('it is aimed at the target from the start', near(Math.hypot(...shot.dir), 1, 1e-9) && shot.dir[1] < 0, shot.dir.map(x => x.toFixed(2)).join(', '));
ok('it carries no gravity, so the steering owns the path', shot.gravity === 0);
ok('it knows which drone fired it', shot.guide.droneId === sentinel.id);
ok('the rack will not fire again inside the gap', fireAgm(sentinel, target, 0) === null && sentinel.agm.left === def.rounds - 1);
ok('and will once the gap has passed', !!fireAgm(sentinel, target, def.gapS + 0.01) && sentinel.agm.left === def.rounds - 2);

// Four rounds and no more, however long you wait.
let t = 10;
while (fireAgm(sentinel, target, t)) t += def.gapS + 0.01;
ok('the rack runs dry at its round count', sentinel.agm.left === 0 && !agmReady(sentinel, t), `${sentinel.agm.left} left after ${t.toFixed(1)} s`);

const wrecked = spawnWorldDrone(DRONE_SENTINEL, { ownerId: 'me', at: [0, 0, 0], groundAt: groundY });
wrecked.state = 'deadstick';
ok('a wrecked drone fires nothing', !agmReady(wrecked) && fireAgm(wrecked, target, 0) === null);

// ── the steering ────────────────────────────────────────────────────────────
// Turning holds the speed: the whole point of rotating the velocity rather than lerping toward the
// target, which would both cut the corner and arrive slow.
let v = steerToward([120, 0, 0], [0, 100, 0], [0, 0, 100], 1.2, 120, 0.1);
ok('a turn keeps the speed', near(Math.hypot(...v), 120, 1e-6), Math.hypot(...v).toFixed(3));

// And it turns no faster than the limit.
const before = [1, 0, 0], after = steerToward([120, 0, 0], [0, 0, 0], [0, 0, -1000], 1.2, 120, 0.1);
const cos = (after[0] * before[0] + after[1] * before[1] + after[2] * before[2]) / Math.hypot(...after);
ok('it turns at most turn * dt', near(Math.acos(Math.max(-1, Math.min(1, cos))), 0.12, 1e-6), `${Math.acos(cos).toFixed(4)} rad in 0.1 s`);

// Already pointed at the target: nothing changes.
v = steerToward([0, 0, -120], [0, 0, 0], [0, 0, -500], 1.2, 120, 0.1);
ok('an on-course missile is left alone', near(v[0], 0, 1e-9) && near(v[2], -120, 1e-6), v.map(x => x.toFixed(2)).join(', '));

// Exactly reversed, where the rotation plane is undefined: it must not stall or produce NaN.
v = steerToward([0, 0, -120], [0, 0, 0], [0, 0, 500], 1.2, 120, 0.1);
ok('a reversed aim does not produce NaN', v.every(Number.isFinite), v.map(x => x.toFixed(2)).join(', '));

// ── flying one all the way in ───────────────────────────────────────────────
// A stand-in for the projectile manager's entries: position, velocity, and the guide the manager
// copies off the spawn. `fireAgm` decides the launch, so this flies the real one rather than a
// heading of the test's choosing — the first version of this test picked its own and "found" a
// miss that the game cannot produce.
function fly(shot, { dt = 1 / 60, maxS = 60, reaimAt = null, reaimTo = null } = {}) {
  const g = shot.guide;
  const proj = { transform: { p: [...shot.origin] }, sim: { vx: shot.dir[0] * shot.speed, vy: shot.dir[1] * shot.speed, vz: shot.dir[2] * shot.speed }, guide: { ...g, aim: [...g.aim] } };
  let closest = Infinity;
  for (let t = 0; t < maxS; t += dt) {
    if (reaimAt !== null && t >= reaimAt && reaimTo) { proj.guide.aim[0] = reaimTo[0]; proj.guide.aim[1] = reaimTo[1]; proj.guide.aim[2] = reaimTo[2]; reaimAt = null; }
    stepGuidedProjectiles([proj], dt);
    proj.transform.p[0] += proj.sim.vx * dt; proj.transform.p[1] += proj.sim.vy * dt; proj.transform.p[2] += proj.sim.vz * dt;
    const a = proj.guide.aim;
    closest = Math.min(closest, Math.hypot(proj.transform.p[0] - a[0], proj.transform.p[1] - a[1], proj.transform.p[2] - a[2]));
    if (proj.transform.p[1] <= a[1]) return { closest, seconds: t };
  }
  return { closest, seconds: maxS };
}

// A fresh drone per shot, so the gap between rounds never decides the answer.
function launchAt(aim, { alt = 150, radius = 400 } = {}) {
  const rec = spawnWorldDrone(DRONE_SENTINEL, { ownerId: 'me', at: [0, 0, 0], look: [0, 0, -1], alt, radius, groundAt: groundY });
  const shot = fireAgm(rec, aim, 0);
  return { rec, shot };
}

const blast = def.blastRadius;
// Every aim point a player can pick from the low preset: under the wing, ahead of it, off to one
// side, and behind it. The launch is pointed at the target, so all of them are ordinary shots.
for (const [name, offset] of [
  ['straight below', [0, 0, 0]],
  ['ahead of the wing', [0, 0, -400]],
  ['off to one side', [300, 0, -300]],
  ['behind the wing', [0, 0, 500]],
  ['a long way out', [1200, 0, 900]],
]) {
  const { rec, shot } = launchAt([0, 0, 0]);
  const aim = [rec.d.p[0] + offset[0], 0, rec.d.p[2] + offset[2]];
  const s2 = fireAgm(rec, aim, def.gapS + 0.01);
  const r = fly(s2 || shot);
  ok(`it reaches a target ${name}`, r.closest <= blast, `misses by ${r.closest.toFixed(1)} m after ${r.seconds.toFixed(1)} s`);
}

// From the high preset, where the fall is ten times as long.
{
  const { rec } = launchAt([0, 0, 0], { alt: 1500, radius: 900 });
  const aim = [rec.d.p[0] + 600, 0, rec.d.p[2] - 600];
  const r = fly(fireAgm(rec, aim, def.gapS + 0.01));
  ok('a round from 1500 m reaches its aim', r.closest <= blast, `misses by ${r.closest.toFixed(1)} m after ${r.seconds.toFixed(1)} s`);
}

// Slewing the sensor after launch is the point of the thing: the round has to follow the crosshair,
// not the point it was fired at. A correction of 150 m one second in must still land.
{
  const { rec } = launchAt([0, 0, 0]);
  const aim = [rec.d.p[0], 0, rec.d.p[2] - 500];
  const shot = fireAgm(rec, aim, def.gapS + 0.01);
  const r = fly(shot, { reaimAt: 1.0, reaimTo: [aim[0] + 150, 0, aim[2]] });
  ok('it follows the aim after launch', r.closest <= blast, `misses by ${r.closest.toFixed(1)} m`);
}

// The turning circle is speed / turn, and it is what decides which corrections are possible. Pinned
// here so a change to either number has to face the consequence.
ok('its turning circle is the radius the numbers imply', near(def.speed / def.turn, 40, 0.5), `${(def.speed / def.turn).toFixed(1)} m`);

// The unguided drop: it must not steer before it has cleared the wing.
const dropping = { transform: { p: [0, 150, 0] }, sim: { vx: 0, vy: 0, vz: -120 }, guide: { aim: [0, 0, 500], turn: def.turn, speed: 120, armS: 0.35, droneId: 'd' } };
stepGuidedProjectiles([dropping], 0.1);
ok('it flies straight until the motor lights', dropping.sim.vz === -120 && dropping.sim.vx === 0);
stepGuidedProjectiles([dropping], 0.3);
ok('and steers once it has', dropping.sim.vz > -120);

// The fuse: arriving is what ends it, so a round aimed where nothing answers a raycast still goes
// off instead of flying on until its life runs out.
{
  const arriving = { transform: { p: [0, 0, -2] }, sim: { vx: 0, vy: 0, vz: -120, life: 30 }, guide: { aim: [0, 0, 0], turn: def.turn, speed: 120, armS: 0, droneId: 'd' } };
  stepGuidedProjectiles([arriving], 1 / 60);
  ok('a round that has passed its aim ends its own life', arriving.sim.life === 0, `life ${arriving.sim.life}`);
  const running = { transform: { p: [0, 0, 400] }, sim: { vx: 0, vy: 0, vz: -120, life: 30 }, guide: { aim: [0, 0, 0], turn: def.turn, speed: 120, armS: 0, droneId: 'd' } };
  stepGuidedProjectiles([running], 1 / 60);
  ok('one still on its way is left running', running.sim.life === 30, `life ${running.sim.life}`);
}

// Anything without a guide is not ours to touch.
const grenade = { transform: { p: [0, 10, 0] }, sim: { vx: 5, vy: 0, vz: 0 } };
stepGuidedProjectiles([grenade], 0.1);
ok('an unguided projectile is left alone', grenade.sim.vx === 5);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
