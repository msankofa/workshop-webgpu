// Node tests for bot-drones.js — the drone operator's bomb drone and loitering munitions.
// Each claim here is one that is easy to get wrong and hard to see on screen: a bomb that lands
// where the drone was rather than where the target is, a glider that arrives slower than it left,
// a drone that never comes home. Run: node test-bot-drones.mjs
import {
  DRONE_BOMBER, DRONE_LOITER, DRONE_DEFS, OPERATOR_DEFAULTS,
  steerToward3, bombLead, diveSpeed, pickDroneTarget, decideDroneLaunch, createOperatorKit,
  createDrone, stepBotDrone, orphanDrone, crippleDrone, pickAirTarget, airLeadPoint,
} from './bot-drones.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

const DT = 1 / 60;

// ─── steering ────────────────────────────────────────────────────────────────
// The flight-sim bug this guards: lerp-and-normalise under-delivers the commanded turn rate, and a
// drone that quietly turns two thirds as fast as its table says makes every tuning number a lie.
{
  const v = [10, 0, 0];
  steerToward3(v, [0, 0, 10], 1.0, 0.1);
  const ang = Math.atan2(v[2], v[0]);
  ok(Math.abs(ang - 0.1) < 1e-6, `steerToward3 delivers the commanded 0.1 rad (got ${ang.toFixed(4)})`);
  ok(Math.abs(Math.hypot(...v) - 10) < 1e-9, 'steering keeps speed');
  const back = [5, 0, 0];
  steerToward3(back, [-5, 0, 0], 2, 0.5);   // exactly reversed: no cross product to rotate about
  ok(Number.isFinite(back[0] + back[1] + back[2]), 'a reversed command does not produce NaN');
}

// ─── bomb release ────────────────────────────────────────────────────────────
{
  const g = 9.81, h = 14, speed = 9;
  const lead = bombLead(h, speed, g);
  const t = Math.sqrt(2 * h / g);
  ok(Math.abs(lead - speed * t) < 1e-9, 'lead is release speed times time of fall');
  ok(bombLead(0, speed, g) === 0 && bombLead(h, speed, 0) === 0, 'no height or no gravity means no lead');
  ok(bombLead(h, speed, g, -3) < lead, 'a descending release falls sooner, so it needs less lead');
}

// A bomb drone flown at a MOVING target (which is what puts it on a flying pass rather than a hover
// drop) must put its bomb on that target, not near it. The bomb is integrated ballistically here
// exactly as entity-types/combat-projectile.js would fly it.
{
  const target = [30, 0, 0];
  const d = createDrone(DRONE_BOMBER, [-25, 0, 0], { team: 1 });
  let drop = null;
  for (let i = 0; i < 60 * 40 && !drop; i++) {
    const out = stepBotDrone(d, DT, { target, targetSpeed: 2.4, groundY: 0, home: [-25, 0, -25] });
    if (out.drop) drop = out.drop;
  }
  ok(!!drop, 'the bomber releases within 40 s of launch');
  if (drop) {
    const p = [...drop.p], v = [...drop.v];
    let t = 0;
    while (p[1] > target[1] && t < 20) { v[1] -= 9.81 * DT; p[0] += v[0] * DT; p[1] += v[1] * DT; p[2] += v[2] * DT; t += DT; }
    const miss = Math.hypot(p[0] - target[0], p[2] - target[2]);
    ok(miss < 2.0, `bomb lands within 2 m of the target (missed by ${miss.toFixed(2)} m)`);
    ok(drop.p[1] > 8, `release happens at altitude (${drop.p[1].toFixed(1)} m)`);
  }
  ok(d.bombs === DRONE_DEFS[DRONE_BOMBER].bombs - 1, 'a release costs exactly one bomb');
}

// Two bombs, then home, then a full rack: the drone is reusable, which is the point of it.
{
  const target = [30, 0, 0];
  const home = [-25, 0, 0];
  const d = createDrone(DRONE_BOMBER, home, { team: 1 });
  const misses = [];
  let drops = 0, rearmed = false;
  for (let i = 0; i < 60 * 200; i++) {
    // The target disappears once both bombs are gone, so the drone has a reason to come home.
    const out = stepBotDrone(d, DT, { target: drops < 2 ? target : null, targetSpeed: 2.4, groundY: 0, home });
    if (out.drop) {
      drops++;
      const p = [...out.drop.p], v = [...out.drop.v];
      let t = 0;
      while (p[1] > target[1] && t < 20) { v[1] -= 9.81 * DT; p[0] += v[0] * DT; p[1] += v[1] * DT; p[2] += v[2] * DT; t += DT; }
      misses.push(Math.hypot(p[0] - target[0], p[2] - target[2]));
    }
    if (out.rearmed) { rearmed = true; break; }
  }
  ok(drops === 2, `both bombs are dropped (${drops})`);
  // The second bomb is the one that used to land 3 m long: the drone was still aligned and closing
  // after the first release, so it dropped again from inside its own lead distance.
  ok(misses.every((m) => m < 2), `every bomb of the sortie lands on the target (${misses.map((m) => m.toFixed(2)).join(', ')} m)`);
  ok(rearmed, 'the drone returns to the operator and reloads');
  ok(d.bombs === DRONE_DEFS[DRONE_BOMBER].bombs, 'reloading fills the rack');
  ok(Math.hypot(d.p[0] - home[0], d.p[2] - home[2]) <= DRONE_DEFS[DRONE_BOMBER].homeRadius + 1,
    'it reloads over the operator, not wherever it ran out');
}

// A bomber with nothing to hit must not orbit the enemy side of the map waiting.
{
  const home = [0, 0, 0];
  const d = createDrone(DRONE_BOMBER, home, { team: 1 });
  for (let i = 0; i < 60 * 60; i++) stepBotDrone(d, DT, { target: null, groundY: 0, home });
  const def = DRONE_DEFS[DRONE_BOMBER];
  // A LOADED drone with nothing to bomb tags along over the operator's shoulder. Only an empty rack
  // is worth coming down into his hands for -- otherwise he spends the match servicing a full drone.
  ok(d.state === 'shadow', `no target means shadowing the operator (state ${d.state})`);
  ok(Math.abs(d.p[1] - def.shadowAlt) < 1, `at shadow height (${d.p[1].toFixed(1)} m)`);
  ok(Math.hypot(d.p[0] - home[0], d.p[2] - home[2]) < def.shadowOffset + 1, 'and right beside him');
  let x = 0;
  for (let i = 0; i < 60 * 20; i++) { x += 2.4 * DT; stepBotDrone(d, DT, { target: null, groundY: 0, home: [x, 0, 0], homeYaw: Math.PI / 2 }); }
  ok(x - d.p[0] < def.shadowOffset + 2, `the shadow keeps up with a walking operator (${(x - d.p[0]).toFixed(1)} m behind)`);
}

// ─── loitering munition ──────────────────────────────────────────────────────
{
  const def = DRONE_DEFS[DRONE_LOITER];
  ok(diveSpeed(0, def) === def.speed && diveSpeed(999, def) === def.diveSpeed,
    'dive speed runs from cruise to terminal and stops there');

  const d = createDrone(DRONE_LOITER, [-20, 0, 0], { team: 1 });
  // Nothing to hit yet: it has to climb and hold, not wander off or sink.
  for (let i = 0; i < 60 * 20; i++) stepBotDrone(d, DT, { target: null, groundY: 0 });
  ok(d.state === 'orbit', `it climbs to the orbit and stays there (state ${d.state})`);
  ok(Math.abs(d.p[1] - def.cruiseAlt) < 3, `orbit holds cruise altitude (${d.p[1].toFixed(1)} m)`);
  ok(!d.done, 'a loiterer with no target does not go off on its own');

  const target = [15, 1, 5];
  let hit = null, dived = false;
  const cruise = Math.hypot(d.v[0], d.v[1], d.v[2]);
  for (let i = 0; i < 60 * 40 && !hit; i++) {
    const out = stepBotDrone(d, DT, { target, groundY: 0 });
    if (d.state === 'dive') dived = true;
    if (out.detonate) hit = out.detonate;
  }
  ok(dived, 'a target inside the dive radius commits the loiterer');
  ok(!!hit, 'the dive reaches something');
  if (hit) {
    ok(Math.hypot(hit[0] - target[0], hit[2] - target[2]) < def.hitRadius + 0.6,
      `it detonates on the target (${Math.hypot(hit[0] - target[0], hit[2] - target[2]).toFixed(2)} m off)`);
    ok(Math.hypot(d.v[0], d.v[1], d.v[2]) > cruise * 1.4,
      'it arrives faster than it loitered — height traded for speed');
    ok(d.done, 'a kamikaze is spent by its own hit');
  }
}

// Endurance is finite: a loiterer with nothing to kill eventually comes down instead of hanging
// over the map forever.
{
  const d = createDrone(DRONE_LOITER, [0, 0, 0], { team: 1 });
  let done = false;
  for (let i = 0; i < 60 * 200 && !done; i++) done = stepBotDrone(d, DT, { target: null, groundY: 0 }).done;
  ok(done, 'the loiterer expires at the end of its life');
}

// Ground contact ends a dive even if the target is gone: no drone tunnelling through the floor.
{
  const d = createDrone(DRONE_LOITER, [0, 0, 0], { team: 1 });
  for (let i = 0; i < 60 * 12; i++) stepBotDrone(d, DT, { target: null, groundY: 0 });
  d.state = 'dive'; d.aim = [0, -40, 0]; d.diveT = 0;
  let hit = null;
  for (let i = 0; i < 60 * 20 && !hit; i++) hit = stepBotDrone(d, DT, { target: null, groundY: 0 }).detonate;
  ok(!!hit && hit[1] <= 0.5, 'a dive into empty ground detonates at the ground, not below it');
}

// ─── who gets bombed, and when a sortie leaves ───────────────────────────────
{
  const enemies = [
    { id: 'a', x: 5, y: 0, z: 0, alive: true },      // alone, closest
    { id: 'b', x: 40, y: 0, z: 0, alive: true },     // pair, further out
    { id: 'c', x: 42, y: 0, z: 1, alive: true },
    { id: 'd', x: 8, y: 0, z: 0, alive: false },
  ];
  const pick = pickDroneTarget(enemies, { blastRadius: 5, from: [0, 0, 0], minRange: 10 });
  ok(pick && (pick.id === 'b' || pick.id === 'c'), `the cluster outranks the near single target (picked ${pick?.id})`);
  ok(pickDroneTarget(enemies, { blastRadius: 5, from: [0, 0, 0], minRange: 100 }) === null,
    'everyone inside the minimum range means no sortie');
  ok(pickDroneTarget([{ id: 'x', x: 1, y: 0, z: 1, alive: false }], {}) === null, 'corpses are not targets');
}

{
  const kit = createOperatorKit();
  // `bomberReady` is the viewer's answer to "is the bomb drone in a state to be sent": on the rack,
  // shadowing or docked with bombs. `bomberAloft` means it is already ON TASK.
  const ready = { hasTarget: true, targetRange: 30, bomberReady: true };
  ok(decideDroneLaunch(kit, { now: 0, ...ready, hasTarget: false }) === null, 'no target, no launch');
  ok(decideDroneLaunch(kit, { now: 0, ...ready, targetRange: 4 }) === null,
    'a target inside the minimum range is a rifle problem, not a drone problem');
  ok(decideDroneLaunch(kit, { now: 0, ...ready }) === DRONE_BOMBER, 'the reusable drone goes first');
  // One man flies one aircraft: with the bomb drone on task, nothing else leaves the ground.
  ok(decideDroneLaunch(kit, { now: 0, ...ready, bomberAloft: true }) === null,
    'nothing launches while the bomb drone is on task');
  ok(decideDroneLaunch(kit, { now: 0, ...ready, bomberReady: false }) === DRONE_LOITER,
    'a bomb drone that cannot fly (empty, or held) gives the slot to a munition');
  ok(decideDroneLaunch(kit, { now: 0, ...ready, bomberReady: false, loiterAloft: 1 }) === null,
    'and only one of those at a time either');
  kit.loiterLeft = 0;
  ok(decideDroneLaunch(kit, { now: 0, ...ready, bomberReady: false }) === null, 'an empty rack launches nothing');
  kit.loiterLeft = 2; kit.loiterReadyAt = 5000;
  ok(decideDroneLaunch(kit, { now: 1000, ...ready, bomberReady: false }) === null,
    'the cooldown holds the next loiterer on the ground');
  ok(decideDroneLaunch(kit, { now: 6000, ...ready, bomberReady: false }) === DRONE_LOITER,
    'and releases it once the cooldown is up');
  ok(decideDroneLaunch(kit, { now: 6000, ...ready, bomberAloft: true, loiterAloft: 0 }, { ...OPERATOR_DEFAULTS, aloftMax: 2 }) === DRONE_LOITER,
    'the cap is a setting, not a rule of nature');
}

// ─── the bomber is a multirotor: it can stop ─────────────────────────────────
// Hover-drop against a target that is holding still: the bomb falls straight down, so accuracy is a
// question of how still the drone is when it lets go, not of a lead solution.
{
  const def = DRONE_DEFS[DRONE_BOMBER];
  const target = [30, 0, 0];
  const d = createDrone(DRONE_BOMBER, [-25, 0, 0], { team: 1 });
  const misses = [];
  let releaseSpeed = null;
  for (let i = 0; i < 60 * 60 && d.bombs > 0; i++) {
    const out = stepBotDrone(d, DT, { target, targetSpeed: 0, groundY: 0, home: [-25, 0, 0], homeYaw: 0 });
    if (!out.drop) continue;
    releaseSpeed ??= Math.hypot(out.drop.v[0], out.drop.v[2]);
    const p = [...out.drop.p], v = [...out.drop.v];
    let t = 0;
    while (p[1] > target[1] && t < 20) { v[1] -= 9.81 * DT; p[0] += v[0] * DT; p[1] += v[1] * DT; p[2] += v[2] * DT; t += DT; }
    misses.push(Math.hypot(p[0] - target[0], p[2] - target[2]));
  }
  ok(misses.length === def.bombs, `a hover attack drops the whole rack (${misses.length})`);
  ok(misses.every((m) => m < 1), `and puts every bomb on the spot (${misses.map((m) => m.toFixed(2)).join(', ')} m)`);
  ok(releaseSpeed !== null && releaseSpeed <= def.hoverDropSettleSpeed + 0.05,
    `it is stopped when it releases (${releaseSpeed?.toFixed(2)} m/s)`);
}

// A target that is walking gets the flying pass instead: a bomb from a hover lands where the drone
// is, which is behind anything that moves.
{
  const d = createDrone(DRONE_BOMBER, [-25, 0, 0], { team: 1 });
  const states = new Set();
  for (let i = 0; i < 60 * 30; i++) {
    stepBotDrone(d, DT, { target: [30, 0, 0], targetSpeed: 2.4, groundY: 0, home: [-25, 0, 0], homeYaw: 0 });
    states.add(d.state);
  }
  ok(states.has('ingress') && !states.has('hoverdrop'), `a mover is bombed on the run (${[...states].join(', ')})`);
}

// The rack is filled by hand, so the drone has to come to the operator and the clock only runs there.
{
  const def = DRONE_BOMBER === DRONE_BOMBER ? DRONE_DEFS[DRONE_BOMBER] : null;
  const home = [0, 0, 0];
  const d = createDrone(DRONE_BOMBER, home, { team: 1 });
  d.bombs = 0; d.state = 'rearm';   // an empty rack is what sends it to his hands
  let dockedAt = null, t = 0;
  for (let i = 0; i < 60 * 90; i++) {
    const out = stepBotDrone(d, DT, { target: null, groundY: 0, home, homeYaw: 0 });
    t += DT;
    if (out.docked && dockedAt === null) dockedAt = t;
  }
  ok(dockedAt !== null, 'an empty drone comes down to the operator to be reloaded');
  ok(d.bombs === def.bombs, 'and the rack fills while it is there');
  ok(d.state === 'shadow', 'then it gets out of his hands again');
}

// Reload time is time in the operator's hands. A drone held away from him never finishes reloading,
// which is what makes the dock mean something.
{
  const d = createDrone(DRONE_BOMBER, [0, 0, 0], { team: 1 });
  d.state = 'rearm'; d.bombs = 0; d.reloadT = 0;
  for (let i = 0; i < 60 * 40; i++) stepBotDrone(d, DT, { target: null, groundY: 0, home: [200, 0, 200], homeYaw: 0 });
  ok(d.bombs === 0, 'a drone that never reaches its operator never rearms');
}

// ─── hold fire ───────────────────────────────────────────────────────────────
// An ally under the aim point stops the RELEASE, not the sortie. Nulling the target instead used to
// send the drone home, which is half of why it kept shuttling back over its own operator.
{
  const d = createDrone(DRONE_BOMBER, [-25, 0, 0], { team: 1 });
  const held = { target: [30, 0, 0], groundY: 0, home: [-25, 0, 0], holdFire: true };
  let drops = 0;
  // Inside the hold-give-up window it keeps flying the run, which is the point: a friendly walking
  // clear puts it straight back on the target instead of costing a whole sortie.
  for (let i = 0; i < 60 * 4; i++) if (stepBotDrone(d, DT, held).drop) drops++;
  ok(d.state === 'hoverdrop' || d.state === 'ingress' || d.state === 'reattack',
    `the attack continues while it is held off (state ${d.state})`);
  // But not forever. A run it is never allowed to release is given up rather than flown until the
  // operator dies -- otherwise a target under a roof parks the drone over it permanently.
  for (let i = 0; i < 60 * 56; i++) if (stepBotDrone(d, DT, held).drop) drops++;
  ok(drops === 0, `hold fire withholds every bomb (${drops} dropped)`);
  ok(d.state === 'egress' || d.state === 'shadow' || d.state === 'rearm',
    `and a run it can never release is eventually given up (state ${d.state})`);
  ok(d.bombs === d.def.bombs, 'with the rack still full');

  const l = createDrone(DRONE_LOITER, [-20, 0, 0], { team: 1 });
  let det = null;
  for (let i = 0; i < 60 * 60 && !det; i++) det = stepBotDrone(l, DT, { target: [10, 1, 0], groundY: 0, holdFire: true }).detonate;
  ok(!det, 'a loiterer waves off instead of diving into its own side');
  ok(l.p[1] > 10, `and it is still up there afterwards (${l.p[1].toFixed(1)} m)`);
}

// A target that blinks out for a moment must not turn a bombing run into a trip home and back.
{
  const d = createDrone(DRONE_BOMBER, [-25, 0, 0], { team: 1 });
  for (let i = 0; i < 60 * 4; i++) stepBotDrone(d, DT, { target: [30, 0, 0], groundY: 0, home: [-25, 0, 0] });
  const before = d.state;
  for (let i = 0; i < 30; i++) stepBotDrone(d, DT, { target: null, groundY: 0, home: [-25, 0, 0] });   // half a second of nothing
  ok(d.state === before, `a blink does not abandon the run (${before} -> ${d.state})`);
  for (let i = 0; i < 60 * 6; i++) stepBotDrone(d, DT, { target: null, groundY: 0, home: [-25, 0, 0] });
  ok(d.state === 'egress' || d.state === 'rearm', `a target that stays gone does end it (${d.state})`);
}

// ─── memory is a direction, not a target ─────────────────────────────────────
// Storing a remembered point as a sighting re-dates the memory from itself, and the drone renews its
// own ghost forever. This is the check that a stale point is flown toward but never adopted.
{
  const d = createDrone(DRONE_LOITER, [0, 0, 0], { team: 1 });
  // holdFire keeps it circling so the test is about the aim store, not about the dive.
  for (let i = 0; i < 60 * 15; i++) stepBotDrone(d, DT, { target: [20, 1, 0], groundY: 0, holdFire: true });
  const seen = d.aim ? [...d.aim] : null;
  ok(seen && Math.abs(seen[0] - 20) < 0.001, 'a live sighting is stored as the aim');
  for (let i = 0; i < 60 * 2; i++) stepBotDrone(d, DT, { target: [80, 1, 60], groundY: 0, stale: true, holdFire: true });
  ok(d.aim && Math.abs(d.aim[0] - seen[0]) < 0.001 && Math.abs(d.aim[2] - seen[2]) < 0.001,
    `a remembered point does not overwrite the last real sighting (${d.aim?.map((v) => v.toFixed(1)).join(', ')})`);
  ok(!d.done, 'and nothing goes off over it');
}

// ─── air defence ─────────────────────────────────────────────────────────────
{
  const drones = [
    { id: 'near-friend', team: 1, done: false, p: [3, 12, 0], v: [0, 0, 0] },
    { id: 'far', team: 2, done: false, p: [30, 14, 0], v: [0, 0, 0] },
    { id: 'near', team: 2, done: false, p: [10, 14, 0], v: [0, 0, 0] },
    { id: 'spent', team: 2, done: true, p: [1, 12, 0], v: [0, 0, 0] },
  ];
  const from = [0, 1.6, 0];
  ok(pickAirTarget(drones, from, { range: 40, team: 1 })?.id === 'near', 'the nearest live enemy drone is the one shot at');
  // Range is a 3D distance, so altitude counts against it: the drone 10 m away is 15.9 m of slant.
  ok(pickAirTarget(drones, from, { range: 20, team: 1 })?.id === 'near', 'range culls the far one');
  ok(pickAirTarget(drones, from, { range: 14, team: 1 }) === null, 'a drone high overhead is further away than its ground track');
  ok(pickAirTarget(drones, from, { range: 0, team: 1 }) === null, 'zero range means bots ignore drones entirely');
  ok(pickAirTarget(drones, from, { range: 40, team: 2 })?.id === 'near-friend', 'a team never shoots its own aircraft');

  // Lead: a rocket at 108 m/s at a drone crossing at 10 m/s must be aimed ahead of it, and the
  // aim point has to be where the drone actually is when the rocket arrives.
  const out = [0, 0, 0];
  airLeadPoint(out, [0, 1.6, 0], [0, 14, 40], [10, 0, 0], 108);
  const flight = Math.hypot(out[0], out[1] - 1.6, out[2]) / 108;
  ok(Math.abs(out[0] - 10 * flight) < 0.05, `lead matches the time of flight (${out[0].toFixed(2)} m across)`);
  airLeadPoint(out, [0, 1.6, 0], [0, 14, 40], [0, 0, 0], 108);
  ok(out[0] === 0 && out[2] === 40, 'a stationary drone is aimed at directly');
}

// ─── the operator dies ───────────────────────────────────────────────────────
{
  // Dead stick: the man flying it is dead, so it falls, and what is still on the rack goes off where
  // it lands -- on whoever is standing there, its own side included.
  const bomber = createDrone(DRONE_BOMBER, [0, 0, 0], { team: 1 });
  for (let i = 0; i < 60 * 8; i++) stepBotDrone(bomber, DT, { target: null, groundY: 0, home: [0, 0, 0], homeYaw: 0 });
  const alt = bomber.p[1];
  orphanDrone(bomber);
  ok(!bomber.done && bomber.state === 'deadstick', 'a bomb drone with no pilot goes dead stick, it does not vanish');
  let crash = null, fell = 0;
  for (let i = 0; i < 60 * 20 && !crash; i++) {
    const out = stepBotDrone(bomber, DT, { target: null, groundY: 0, home: [0, 0, 0], homeYaw: 0 });
    fell += DT;
    crash = out.crash;
    if (out.crash) ok(out.bombsAboard === DRONE_DEFS[DRONE_BOMBER].bombs, 'and reports the bombs it still had aboard');
  }
  ok(!!crash, `it reaches the ground (${fell.toFixed(1)} s from ${alt.toFixed(1)} m)`);
  ok(crash && crash[1] <= 0.3, 'and the wreck is at ground level, not under it');
  ok(bomber.done, 'the crash spends it');
  ok(bomber.tumble, 'it tumbles on the way down rather than gliding in level');

  const loiter = createDrone(DRONE_LOITER, [0, 0, 0], { team: 1 });
  for (let i = 0; i < 60 * 15; i++) stepBotDrone(loiter, DT, { target: null, groundY: 0 });
  loiter.aim = [30, 1, 0];   // the last place the operator pointed it before he was killed
  orphanDrone(loiter);
  ok(!loiter.done, 'a fire-and-forget munition does not care that the man who sent it is dead');
  ok(loiter.state === 'dive', 'it finishes its errand on the last target it was given');
  ok(loiter.def.life <= loiter.age + 20, 'and it is not left circling forever');
}

// ─── shot down: the two ways a drone stops being flown ───────────────────────
// Shot down is not always shot to pieces. `crippleDrone` is what the viewer reaches for on the roll
// it does not kill outright, and both flavours have to end on the ground with the load reported --
// a drone that simply stops existing takes its bombs out of the world with it.
{
  // Plain fall: straight down, tumbling, same as losing the pilot.
  const falling = createDrone(DRONE_BOMBER, [0, 0, 0], { team: 1 });
  for (let i = 0; i < 60 * 8; i++) stepBotDrone(falling, DT, { target: null, groundY: 0, home: [0, 0, 0], homeYaw: 0 });
  const fellFrom = [falling.p[0], falling.p[2]];
  crippleDrone(falling, { wild: false });
  ok(falling.state === 'deadstick' && !falling.wild && falling.tumble, 'a plain dead stick tumbles');
  let out = null;
  for (let i = 0; i < 60 * 20 && !out?.crash; i++) out = stepBotDrone(falling, DT, { target: null, groundY: 0, home: [0, 0, 0], homeYaw: 0 });
  ok(!!out?.crash, 'and it reaches the ground');
  ok(out.bombsAboard === DRONE_DEFS[DRONE_BOMBER].bombs, 'still carrying what it carried');
  ok(Math.hypot(out.crash[0] - fellFrom[0], out.crash[2] - fellFrom[1]) < 8,
    'and it lands near where it was hit rather than flying on');

  // Wild: the rotors keep turning with nobody steering, so it goes somewhere else entirely first.
  const wild = createDrone(DRONE_BOMBER, [0, 0, 0], { team: 1 });
  for (let i = 0; i < 60 * 8; i++) stepBotDrone(wild, DT, { target: null, groundY: 0, home: [0, 0, 0], homeYaw: 0 });
  wild.p[1] = 20;   // hit at cruise height, which is where one actually gets shot at
  const hitAt = [wild.p[0], wild.p[2]];
  crippleDrone(wild, { wild: true, phase: [0.4, 1.9, 3.3] });
  ok(wild.state === 'deadstick' && wild.wild && !wild.tumble, 'a wild dead stick is still flying, so it is not tumbling');
  let wOut = null, wSecs = 0;
  const track = [];
  for (let i = 0; i < 60 * 30 && !wOut?.crash; i++) {
    wOut = stepBotDrone(wild, DT, { target: null, groundY: 0, home: [0, 0, 0], homeYaw: 0 });
    wSecs += DT;
    if (i % 12 === 0) track.push(wild.yaw);
  }
  ok(!!wOut?.crash, `a wild one comes down too (${wSecs.toFixed(1)} s)`);
  ok(Math.hypot(wOut.crash[0] - hitAt[0], wOut.crash[2] - hitAt[1]) > 8,
    'and it carries well away from where it was hit, which is the whole difference');
  // Smooth, not jittery: consecutive headings stay close together. Per-frame noise fails this.
  let maxStep = 0;
  for (let i = 1; i < track.length; i++) {
    let dy = track[i] - track[i - 1];
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    maxStep = Math.max(maxStep, Math.abs(dy));
  }
  ok(maxStep < 1.6, `the wander is smooth rather than jittering (worst 0.2 s turn ${maxStep.toFixed(2)} rad)`);
  ok(wild.tumble, 'and once the power quits it gives up and falls');

  // A munition is its own warhead, so a dead-stick one has to say so when it lands.
  const munition = createDrone(DRONE_LOITER, [0, 0, 0], { team: 1 });
  for (let i = 0; i < 60 * 15; i++) stepBotDrone(munition, DT, { target: null, groundY: 0 });
  crippleDrone(munition, { wild: false });
  let mOut = null;
  for (let i = 0; i < 60 * 30 && !mOut?.crash; i++) mOut = stepBotDrone(munition, DT, { target: null, groundY: 0 });
  ok(!!mOut?.crash, 'a dead-stick munition reaches the ground');
  ok(mOut.warhead === true, 'and reports that it is a warhead, not an empty airframe');
  ok(munition.done, 'the impact spends it');

  // Crippling twice must not restart the fall, or a second hit resets the drone to full height.
  const twice = createDrone(DRONE_BOMBER, [0, 0, 0], { team: 1 });
  for (let i = 0; i < 60 * 8; i++) stepBotDrone(twice, DT, { target: null, groundY: 0, home: [0, 0, 0], homeYaw: 0 });
  crippleDrone(twice, { wild: true });
  for (let i = 0; i < 30; i++) stepBotDrone(twice, DT, { target: null, groundY: 0, home: [0, 0, 0], homeYaw: 0 });
  const midT = twice.stateT;
  crippleDrone(twice, { wild: false });
  ok(twice.stateT === midT && twice.wild === true, 'a second hit on a falling drone does not restart it');
}

// ─── air defence keeps the drone it is already shooting at ───────────────────
// Swapping targets restarts the shooter's recognition delay, so a bot that re-picks every frame
// never gets to fire at all. Same commit dwell the drone's own targeting has, pointed the other way.
{
  const near = { id: 'a', done: false, team: 2, p: [10, 12, 0] };
  const rival = { id: 'b', done: false, team: 2, p: [9.4, 12, 0] };   // closer, but not by much
  const from = [0, 1.5, 0];
  const held = pickAirTarget([near, rival], from, { range: 40, team: 1, lockId: 'a', lockMargin: 0.75 });
  ok(held === near, 'a marginally closer rival does not steal the lock');
  const stolen = pickAirTarget([near, { ...rival, p: [4, 12, 0] }], from, { range: 40, team: 1, lockId: 'a', lockMargin: 0.75 });
  ok(stolen.id === 'b', 'one that is clearly closer does');
  const gone = pickAirTarget([{ ...near, p: [90, 12, 0] }, rival], from, { range: 40, team: 1, lockId: 'a', lockMargin: 0.75 });
  ok(gone === rival, 'a lock that has left the engagement range is dropped');
  ok(pickAirTarget([near, rival], from, { range: 40, team: 1 }) !== null, 'with no lock it still picks by nearest');
  const own = pickAirTarget([{ ...near, team: 1 }], from, { range: 40, team: 1, lockId: 'a' });
  ok(own === null, 'and it never locks onto its own side');
}

console.log(failed ? `bot-drones: ${failed} FAILED` : 'bot-drones: all tests passed');
process.exit(failed ? 1 : 0);
