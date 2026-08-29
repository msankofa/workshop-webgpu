// bot-drones.js — the drone operator's aircraft: one reusable bomb drone and expendable loitering
// munitions. Pure trajectory/decision math on plain arrays (no THREE); meshes, blasts, FX and sound
// stay in the viewer. Airframe feel is borrowed from flight-drones.js — the loiterer's dive trades
// height for speed the way the flight sim's kamikaze glider does. Tested in test-bot-drones.mjs.

export const DRONE_BOMBER = 'bomber';
export const DRONE_LOITER = 'loiter';
export const DRONE_KINDS = [DRONE_BOMBER, DRONE_LOITER];

// Speeds are m/s, turn rates rad/s, altitudes metres above the ground under the drone. Tuned for a
// bot arena (~50 m across, 3 m walls, bots at 2.4 m/s), not for the flight sim's kilometres.
export const DRONE_DEFS = {
  // The bomber is a multirotor and flies like one: it can stop. `canHover` is what unlocks the
  // hover-drop attack and the dock — the loiterer is a wing and has neither.
  [DRONE_BOMBER]: {
    kind: DRONE_BOMBER, label: 'Bomb drone',
    speed: 9, turn: 1.7, climbRate: 5, cruiseAlt: 14, stationRadius: 7,
    bombs: 2, dropGapS: 1.6, dropAlignRad: 0.3, dropAltTol: 3, dropWindow: 1.2, reattackRange: 26,
    reloadS: 7, homeRadius: 9, targetGraceS: 3, life: Infinity,
    // How long it will fly an attack it is not allowed to release before giving the run up. Without
    // it a drone held off by a roof or a friendly hovers over the spot for as long as the operator
    // keeps feeding it the same point, which is forever.
    holdGiveUpS: 6,
    wildS: 6,   // a wild dead stick flies this long before the rotors finally quit and it just falls
    damage: 46, blastRadius: 5.5, bombGravity: 9.81, bombRadius: 0.2, bombLife: 8,
    hp: 30, bodyRadius: 0.6,
    canHover: true, hoverSpeed: 7, hoverResponse: 4,
    // Hover-drop: stop directly over the target and let the bomb fall straight down. No lead solve,
    // so it is the accurate attack — and a stationary drone at 11 m is the easy one to shoot down.
    hoverDropAlt: 11, hoverDropRadius: 0.6, hoverDropSettleSpeed: 0.35, hoverDropSpeedGate: 0.6,
    // Dock: the drone comes to the operator's hands to be reloaded, and the rack only fills there.
    // The offset clears his shoulders -- the airframe is about a metre across.
    dockAlt: 1.0, dockOffset: 1.5, dockRadius: 1.3,
    // Shadow: a loaded drone with nothing to bomb follows the operator instead of sitting in his
    // hands. Only an EMPTY rack is worth stopping him to service.
    shadowAlt: 5, shadowOffset: 2.2,
  },
  [DRONE_LOITER]: {
    kind: DRONE_LOITER, label: 'Loiter drone',
    speed: 10, turn: 1.4, climbRate: 5, cruiseAlt: 20, parkAlt: 8, stationRadius: 9,
    orbitRadius: 11, orbitLeadRad: 0.45, centerDrift: 2.5,
    life: 80, armS: 3, diveRadius: 45, diveTurn: 2.6, diveSpeed: 26, diveGain: 9, hitRadius: 1.2,
    damage: 62, blastRadius: 5,
    hp: 22, bodyRadius: 0.55, wildS: 5, bombGravity: 9.81,
  },
};

// Operator-side gating: how often a sortie may leave and how many one-shot drones it brought.
export const OPERATOR_DEFAULTS = {
  bomberCooldownMs: 4000,
  loiterCooldownMs: 14000,
  loiterStock: 2,
  // One man flies one aircraft. The bomb drone comes down to his hands while a munition is up, so
  // there is never more than this many in the sky over him.
  aloftMax: 1,
  minTargetRange: 10,   // closer than this the operator shoots instead: its own blast would reach it
};

const EPS = 1e-6;

function vlen(v) { return Math.hypot(v[0], v[1], v[2]); }

// Rotate a velocity toward a direction at a bounded rate, keeping its magnitude (flight-drones.js).
// A real rotation, not lerp-and-normalise, which under-turns badly on anything but a small correction.
export function steerToward3(v, dir, turn, dt) {
  const speed = vlen(v);
  const dl = vlen(dir);
  if (speed < EPS || dl < EPS) return v;
  const cx = v[0] / speed, cy = v[1] / speed, cz = v[2] / speed;
  const dx = dir[0] / dl, dy = dir[1] / dl, dz = dir[2] / dl;
  const dot = Math.max(-1, Math.min(1, cx * dx + cy * dy + cz * dz));
  const ang = Math.acos(dot);
  if (ang < 1e-5) return v;
  let ax = cy * dz - cz * dy, ay = cz * dx - cx * dz, az = cx * dy - cy * dx;
  let al = Math.hypot(ax, ay, az);
  if (al < 1e-9) {   // exactly reversed: any perpendicular axis will do
    ax = -cz; ay = 0; az = cx; al = Math.hypot(ax, ay, az);
    if (al < 1e-9) { ax = 0; ay = cz; az = -cy; al = Math.hypot(ax, ay, az); }
  }
  ax /= al; ay /= al; az /= al;
  const t = Math.min(ang, Math.max(0, turn) * Math.max(0, dt));
  const c = Math.cos(t), s = Math.sin(t);
  const k = (ax * cx + ay * cy + az * cz) * (1 - c);   // Rodrigues
  const nx = cx * c + (ay * cz - az * cy) * s + ax * k;
  const ny = cy * c + (az * cx - ax * cz) * s + ay * k;
  const nz = cz * c + (ax * cy - ay * cx) * s + az * k;
  v[0] = nx * speed; v[1] = ny * speed; v[2] = nz * speed;
  return v;
}

// Horizontal distance a bomb travels while it falls `height` at release speed `speed`, given the
// release vertical velocity. This is the whole aiming problem: release this far short and overfly.
export function bombLead(height, speed, gravity = 9.81, vy = 0) {
  const h = Number(height);
  const g = Number(gravity);
  if (!(h > 0) || !(g > 0)) return 0;
  const t = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * h))) / g;
  return Math.max(0, Number(speed) || 0) * t;
}

// Dive speed as a function of how long it has been diving: a loiterer arrives faster than it left.
export function diveSpeed(diveTime, def = DRONE_DEFS[DRONE_LOITER]) {
  return Math.min(def.diveSpeed, def.speed + def.diveGain * Math.max(0, diveTime));
}

// Worth a drone? Score is the cluster inside the blast, distance only breaking near-ties, so a
// sortie goes to the pair standing together rather than to whoever happens to be nearest.
export function pickDroneTarget(enemies, { blastRadius = 5, from = null, minRange = 0 } = {}) {
  if (!Array.isArray(enemies)) return null;
  const live = enemies.filter((e) => e && e.alive !== false && Number.isFinite(e.x) && Number.isFinite(e.z));
  let best = null, bestScore = -Infinity;
  for (const e of live) {
    let cluster = 0;
    for (const o of live) {
      if (o === e) continue;
      if (Math.hypot(o.x - e.x, o.z - e.z) <= blastRadius) cluster++;
    }
    let range = 0;
    if (from) {
      range = Math.hypot(e.x - from[0], e.z - from[2]);
      if (range < minRange) continue;
    }
    const score = cluster * 10 - range * 0.05;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

// Which drone (if any) the operator should send this tick. Pure gating — the caller owns the clocks.
export function decideDroneLaunch(kit, ctx = {}, cfg = OPERATOR_DEFAULTS) {
  if (!kit || !ctx.hasTarget) return null;
  const range = Number(ctx.targetRange);
  if (Number.isFinite(range) && range < cfg.minTargetRange) return null;
  // `bomberAloft` means ON TASK, not merely existing: the bomb drone shadowing its operator or
  // sitting in his hands is not flying a mission and does not hold the slot.
  const aloft = (ctx.bomberAloft ? 1 : 0) + (Number(ctx.loiterAloft) || 0);
  if (aloft >= (cfg.aloftMax ?? 1)) return null;
  const now = Number(ctx.now) || 0;
  if (ctx.bomberReady && !ctx.bomberAloft && now >= (kit.bomberReadyAt || 0)) return DRONE_BOMBER;
  if ((kit.loiterLeft || 0) > 0 && now >= (kit.loiterReadyAt || 0)) return DRONE_LOITER;
  return null;
}

// ─── air defence ─────────────────────────────────────────────────────────────
// What a bot on the ground needs to shoot back with: which drone to shoot at, and where to aim so
// the bullet and the drone arrive together. Both are pure; the viewer owns LOS, ammo and the trigger.

// Nearest enemy drone within `range`, ignoring anything already spent. Nearest rather than most
// dangerous on purpose: a rifleman shoots at what is overhead, not at what it has worked out.
export function pickAirTarget(drones, from, { range = 40, team = null, lockId = null, lockMargin = 1 } = {}) {
  if (!Array.isArray(drones) || !from) return null;
  const r2 = range * range;
  let best = null, bestD2 = r2, lock = null, lockD2 = Infinity;
  for (const d of drones) {
    if (!d || d.done || (team != null && d.team === team)) continue;
    const dx = d.p[0] - from[0], dy = d.p[1] - from[1], dz = d.p[2] - from[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (lockId != null && d.id === lockId) { lock = d; lockD2 = d2; }
    if (d2 > bestD2) continue;
    bestD2 = d2; best = d;
  }
  // The drone's own commit dwell, pointed the other way: stay on the one already being tracked
  // unless a rival is clearly closer. Swapping restarts the shooter's recognition delay, so two
  // drones at similar range could otherwise leave a bot re-arming that timer and never firing.
  if (lock && lockD2 <= r2 && (!best || bestD2 > lockD2 * lockMargin)) return lock;
  return best;
}

// Where to put the crosshair. Two iterations of "time of flight at the current guess, then re-lead"
// converges well inside a drone's own body radius at these speeds, and never needs a solver.
export function airLeadPoint(out, from, p, v, bulletSpeed) {
  const speed = Math.max(1e-3, Number(bulletSpeed) || 0);
  out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
  for (let i = 0; i < 2; i++) {
    const t = Math.hypot(out[0] - from[0], out[1] - from[1], out[2] - from[2]) / speed;
    out[0] = p[0] + v[0] * t; out[1] = p[1] + v[1] * t; out[2] = p[2] + v[2] * t;
  }
  return out;
}

export function createOperatorKit(cfg = OPERATOR_DEFAULTS) {
  return { loiterLeft: cfg.loiterStock, bomberReadyAt: 0, loiterReadyAt: 0, bomberId: null };
}

let _droneSeq = 0;

// `from` is the launch point (the operator), `center` an optional [x, z] loiter centre. The drone
// owns copies of both — it never aliases caller state.
export function createDrone(kind, from, { ownerId = null, team = 0, def = null, center = null, groundY = 0, yaw = 0 } = {}) {
  const base = DRONE_DEFS[kind] || DRONE_DEFS[DRONE_BOMBER];
  const x = Number(from?.[0]) || 0, y = Number(from?.[1]) || 0, z = Number(from?.[2]) || 0;
  return {
    id: `dr${++_droneSeq}`,
    kind: base.kind,
    def: def ? { ...base, ...def } : base,
    ownerId, team,
    p: [x, y + 1.2, z],
    // A drone launched from rest has no heading to steer, so it leaves climbing the way it faced.
    v: [Math.sin(yaw) * 0.5, 1.5, Math.cos(yaw) * 0.5],
    home: [x, y, z],
    center: [Number(center?.[0]) || x, Number(center?.[1]) || z],
    wp: [x, z],   // frozen turn point for the bomber's go-around
    groundY,
    age: 0, state: 'climb', stateT: 0, diveT: 0, dropT: 0, reloadT: 0, lostT: 0, holdT: 0,
    wild: false, wildPhase: [0, 0, 0],
    hp: base.hp,
    bombs: base.kind === DRONE_BOMBER ? base.bombs : 0,
    aim: null, targetId: null,
    yaw, pitch: 0, bank: 0, faceYaw: null, tumble: false,
    orbitSign: (_droneSeq % 2 === 0) ? 1 : -1,
    done: false,
  };
}

// Steer toward a waypoint at `alt` above the drone's own ground, holding cruise speed.
export function cruiseTo(d, wx, wz, alt, dt, speed = d.def.speed, turn = d.def.turn) {
  const dx = wx - d.p[0], dz = wz - d.p[2];
  const flat = Math.hypot(dx, dz);
  const altErr = (d.groundY + alt) - d.p[1];
  // Vertical is a rate command folded into the direction, so climb is bounded by the airframe.
  const vy = Math.max(-d.def.climbRate, Math.min(d.def.climbRate, altErr * 1.4));
  const dirX = flat > EPS ? dx / flat : Math.sin(d.yaw);
  const dirZ = flat > EPS ? dz / flat : Math.cos(d.yaw);
  const horiz = Math.max(EPS, Math.sqrt(Math.max(0, speed * speed - vy * vy)));
  const dir = [dirX * horiz, vy, dirZ * horiz];
  const before = Math.atan2(d.v[0], d.v[2]);
  steerToward3(d.v, dir, turn, dt);
  const sp = vlen(d.v);
  if (sp > EPS) { const k = speed / sp; d.v[0] *= k; d.v[1] *= k; d.v[2] *= k; }
  const after = Math.atan2(d.v[0], d.v[2]);
  let turned = after - before;
  while (turned > Math.PI) turned -= Math.PI * 2;
  while (turned < -Math.PI) turned += Math.PI * 2;
  // Bank is cosmetic, but it is what makes a turn read as a turn from the ground.
  const rate = dt > EPS ? turned / dt : 0;
  d.bank += (Math.max(-1, Math.min(1, rate / d.def.turn)) * 0.55 - d.bank) * Math.min(1, dt * 4);
  return flat;
}

// Multirotor translation: the commanded velocity points straight at the goal and may be zero, which
// is what lets the bomber stop over a target and sit in its operator's hands. First-order approach,
// because a quad still has mass — it just has no turn radius. Returns the distance to the goal.
export function hoverTo(d, x, y, z, dt, maxSpeed = d.def.hoverSpeed, gain = 1.6) {
  const dx = x - d.p[0], dy = y - d.p[1], dz = z - d.p[2];
  const dist = Math.hypot(dx, dy, dz);
  const want = Math.min(maxSpeed, dist * gain);
  const ux = dist > EPS ? dx / dist : 0, uy = dist > EPS ? dy / dist : 0, uz = dist > EPS ? dz / dist : 0;
  const k = Math.min(1, dt * d.def.hoverResponse);
  d.v[0] += (ux * want - d.v[0]) * k;
  d.v[1] += (uy * want - d.v[1]) * k;
  d.v[2] += (uz * want - d.v[2]) * k;
  d.bank += (0 - d.bank) * Math.min(1, dt * 3);
  return dist;
}

const HEADING_SPEED = 0.5;   // below this there is no travel direction to read a heading from

export function advance(d, dt) {
  d.p[0] += d.v[0] * dt; d.p[1] += d.v[1] * dt; d.p[2] += d.v[2] * dt;
  const sp = vlen(d.v);
  // `faceYaw` is a commanded heading for the states where the drone is holding a pose relative to a
  // person rather than flying somewhere. Otherwise heading comes from travel — and below
  // HEADING_SPEED a hovering drone keeps the one it had rather than spinning on numerical noise.
  if (d.tumble) {
    d.yaw += dt * 2.6;                       // no pilot: it spins as it goes
    d.pitch = -0.6 + 0.35 * Math.sin(d.age * 4);
    d.bank = 0.8 * Math.sin(d.age * 3);
  } else if (Number.isFinite(d.faceYaw)) {
    let delta = d.faceYaw - d.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    d.yaw += delta * Math.min(1, dt * 4);
    d.pitch += (0 - d.pitch) * Math.min(1, dt * 4);
  } else if (sp > HEADING_SPEED) {
    d.yaw = Math.atan2(d.v[0], d.v[2]);
    d.pitch = Math.asin(Math.max(-1, Math.min(1, d.v[1] / sp)));
  } else d.pitch += (0 - d.pitch) * Math.min(1, dt * 4);
}

// Advance one drone. Mutates `d`; returns what the viewer has to make happen this frame.
// `world` = { home, homeYaw, target, targetId, targetSpeed, groundY, holdFire, stale, standDown }.
// `holdFire` covers every reason not to release: an ally under the aim point, a roof between the
// drone and it, or a point the drone only remembers rather than sees (`stale`).
export function stepBotDrone(d, dt, world = {}) {
  const out = { drop: null, detonate: null, done: false, rearmed: false, launched: false,
    docked: false, servicing: false, dock: null, crash: null, bombsAboard: 0, warhead: false };
  const def = d.def;
  const step = Math.max(0, Number(dt) || 0);
  d.age += step; d.stateT += step; d.dropT += step;
  if (Number.isFinite(world.groundY)) d.groundY = world.groundY;
  if (Array.isArray(world.home)) { d.home[0] = world.home[0]; d.home[1] = world.home[1]; d.home[2] = world.home[2]; }
  const target = Array.isArray(world.target) ? world.target : null;
  // A REMEMBERED point is flown toward but never stored as a sighting. Storing it re-dated the
  // memory from itself: the assignment lapsed, `aim` (the same stale point) was adopted as the new
  // last-known, and the drone kept renewing its own ghost until it bombed empty ground.
  if (target && !world.stale) { d.aim = [target[0], target[1], target[2]]; d.targetId = world.targetId ?? d.targetId; }
  else if (world.targetLost) { d.targetId = null; }

  if (d.age > def.life) { out.done = true; d.done = true; return out; }

  // Dead stick is the same for both airframes -- neither is being flown any more.
  if (d.state === 'deadstick') stepDeadstick(d, step, out);
  else if (d.kind === DRONE_BOMBER) stepBomber(d, step, world, target, out);
  else stepLoiter(d, step, world, target, out);

  if (!out.done && !out.detonate) advance(d, step);
  return out;
}

export function setState(d, state) { if (d.state !== state) { d.state = state; d.stateT = 0; } }

// Dead stick: nobody is flying it any more. Two ways that goes, because a drone that loses its pilot
// and a drone that loses a rotor do not fall the same way.
//   fall - ballistic and tumbling, straight down from wherever it was.
//   wild - the rotors still bite but nothing is steering: it flies off on a wandering heading,
//          sinking, until the power finally quits (`wildS`) and it drops the rest of the way.
// The wander is summed sines off a per-drone phase rather than per-frame noise, which reads as a
// stutter rather than as a drone. Whatever it still carries goes off where it lands.
function stepDeadstick(d, dt, out) {
  const def = d.def;
  const g = def.bombGravity || 9.81;
  if (d.wild) {
    const t = d.stateT, ph = d.wildPhase;
    // Slow, wide wander rather than a fast one: a heading held for a second or two is a drone flying
    // off out of control, where a fast oscillation is a drone circling one spot like a trapped fly.
    const yaw = Math.sin(t * 0.55 + ph[0]) * 1.9 + Math.sin(t * 0.23 + ph[1]) * 1.2;
    const sink = Math.sin(t * 0.9 + ph[2]) * def.climbRate * 0.7 - def.climbRate * 0.25;
    steerToward3(d.v, [Math.sin(yaw) * def.speed, sink, Math.cos(yaw) * def.speed], def.turn * 1.5, dt);
    const want = Math.max(def.speed * 0.6, vlen(d.v) - dt * 1.4);   // winding down the whole time
    const cur = vlen(d.v);
    if (cur > EPS) { const k = want / cur; d.v[0] *= k; d.v[1] *= k; d.v[2] *= k; }
    d.bank = 0.9 * Math.sin(t * 2.1 + ph[1]);
    if (t >= (def.wildS ?? 6)) { d.wild = false; d.tumble = true; }   // that is the power gone
  } else {
    d.v[1] -= g * dt;
    const drag = Math.max(0, 1 - 0.35 * dt);
    d.v[0] *= drag; d.v[2] *= drag;
  }
  if (d.p[1] + d.v[1] * dt <= d.groundY + 0.25) {
    out.crash = [d.p[0], d.groundY + 0.25, d.p[2]];
    out.bombsAboard = d.bombs;
    out.warhead = d.kind === DRONE_LOITER;   // a munition is a warhead: it goes off on impact
    d.done = true;
  }
}

// Park a turn point one reattack range beyond the target, along the heading the pass ended on.
function setReattack(d, target) {
  const hv = Math.max(EPS, Math.hypot(d.v[0], d.v[2]));
  d.wp = [target[0] + (d.v[0] / hv) * d.def.reattackRange, target[2] + (d.v[2] / hv) * d.def.reattackRange];
  setState(d, 'reattack');
}

// Fly a circle around a point instead of at it. Anything that "holds station" uses this: a drone
// that cruises straight at its own operator is on a collision course with him twice a lap.
export function orbitAround(d, cx, cz, radius, alt, dt, speed = d.def.speed) {
  const ang = Math.atan2(d.p[2] - cz, d.p[0] - cx) + d.orbitSign * (d.def.orbitLeadRad ?? 0.45);
  return cruiseTo(d, cx + Math.cos(ang) * radius, cz + Math.sin(ang) * radius, alt, dt, speed);
}

function stepBomber(d, dt, world, target, out) {
  const def = d.def;
  const hasTarget = !!target;
  const hold = !!world.holdFire;
  d.faceYaw = null;   // only the states that hold a pose beside the operator command a heading
  // Another aircraft is on task, so this one is not: it comes down to the operator and waits there,
  // which is what keeps exactly one drone in the sky over him.
  if (world.standDown && (d.state === 'shadow' || d.state === 'rearm')) setState(d, 'rearm');
  // A pass is not abandoned the instant a target blinks: the drone keeps flying its last aim for
  // targetGraceS, which is what stops it turning for home and back every time LOS flickers.
  if (hasTarget) d.lostT = 0; else d.lostT += dt;
  const goal = target || d.aim;
  // An attack it is never allowed to release -- the target is under a roof, or an ally is standing on
  // it -- is a run to give up, not one to fly forever. The operator will send it again.
  const attacking = d.state === 'hoverdrop' || d.state === 'ingress' || d.state === 'reattack';
  if (hold && attacking) d.holdT += dt; else d.holdT = 0;
  const givenUp = (!target && (d.lostT > def.targetGraceS || !d.aim)) || d.holdT > (def.holdGiveUpS ?? 6);
  // Which attack: a bomb dropped from a hover falls straight down, so it is the accurate one against
  // anything holding still and useless against anything that is not. A mover gets the flying pass.
  const attack = () => (def.canHover && (Number(world.targetSpeed) || 0) <= def.hoverDropSpeedGate ? 'hoverdrop' : 'ingress');
  if (d.state === 'climb') {
    // A quad climbs by going up, not by circling until it gets there.
    if (def.canHover) hoverTo(d, d.home[0], d.groundY + def.cruiseAlt, d.home[2], dt);
    else orbitAround(d, d.home[0], d.home[2], def.stationRadius, def.cruiseAlt, dt);
    if (d.p[1] >= d.groundY + def.cruiseAlt - def.dropAltTol) setState(d, !givenUp && d.bombs > 0 ? attack() : 'egress');
    return;
  }
  if (d.state === 'hoverdrop') {
    if (givenUp || d.bombs <= 0) { setState(d, 'egress'); return; }
    target = goal;
    // Stop directly overhead. The release gate is "still enough that the bomb goes down, not out".
    const dist = hoverTo(d, target[0], target[1] + def.hoverDropAlt, target[2], dt);
    const drift = Math.hypot(d.v[0], d.v[2]);
    const flat = Math.hypot(target[0] - d.p[0], target[2] - d.p[2]);
    if (!hold && flat <= def.hoverDropRadius && drift <= def.hoverDropSettleSpeed && d.dropT >= def.dropGapS) {
      d.bombs--; d.dropT = 0;
      out.drop = { p: [d.p[0], d.p[1], d.p[2]], v: [d.v[0], d.v[1], d.v[2]] };
      if (d.bombs <= 0) setState(d, 'egress');   // with bombs left it simply holds and drops again
    }
    // The target walked out from under it: chase on the hover, or switch to a flying pass if it is
    // properly moving now.
    if ((Number(world.targetSpeed) || 0) > def.hoverDropSpeedGate && dist > def.hoverDropRadius * 4) setState(d, 'ingress');
    return;
  }
  if (d.state === 'ingress') {
    if (givenUp || d.bombs <= 0) { setState(d, 'egress'); return; }
    target = goal;
    const flat = cruiseTo(d, target[0], target[2], def.cruiseAlt, dt);
    const height = d.p[1] - target[1];
    const lead = bombLead(height, Math.hypot(d.v[0], d.v[2]), def.bombGravity, d.v[1]);
    const toX = target[0] - d.p[0], toZ = target[2] - d.p[2];
    const hv = Math.hypot(d.v[0], d.v[2]);
    const closing = flat > EPS && hv > EPS ? (toX * d.v[0] + toZ * d.v[2]) / (flat * hv) : -1;
    const aligned = Math.acos(Math.max(-1, Math.min(1, closing))) <= def.dropAlignRad;
    const levelled = Math.abs(d.p[1] - (d.groundY + def.cruiseAlt)) <= def.dropAltTol;
    if (aligned && levelled && flat <= lead && d.dropT >= def.dropGapS && !hold) {
      // Inside the window the bomb lands on the target; past it the pass is already spoiled, and a
      // bomb released late lands long by exactly how late it was. Go around instead.
      if (flat < lead - def.dropWindow) { setReattack(d, target); return; }
      d.bombs--; d.dropT = 0;
      out.drop = { p: [d.p[0], d.p[1], d.p[2]], v: [d.v[0], d.v[1], d.v[2]] };
      // Release is a lead-length SHORT of the target, so the next bomb has to be flown around again
      // — without this the drone is still aligned and closing and drops the second one long.
      if (d.bombs <= 0) setState(d, 'egress'); else setReattack(d, target);
    }
    return;
  }
  if (d.state === 'reattack') {
    if (givenUp) { setState(d, 'egress'); return; }
    target = goal;
    // The turn point is frozen when the pass ends. Recomputing it from the live heading makes the
    // drone chase its own tail in a tight circle over the target and it never sets up again.
    const flat = cruiseTo(d, d.wp[0], d.wp[1], def.cruiseAlt, dt);
    const away = Math.hypot(d.p[0] - target[0], d.p[2] - target[2]);
    if (away >= def.reattackRange || flat <= 2) setState(d, 'ingress');
    return;
  }
  if (d.state === 'egress') {
    const flat = cruiseTo(d, d.home[0], d.home[2], def.cruiseAlt, dt);
    // Only an empty rack is worth landing in his hands for. A loaded drone just tags along.
    if (flat <= def.homeRadius) { setState(d, d.bombs < def.bombs ? 'rearm' : 'shadow'); d.reloadT = 0; }
    return;
  }
  if (d.state === 'shadow' && !world.standDown) {
    // Station keeping that follows: over the operator's shoulder, out of his way, ready to go again.
    const yaw = Number.isFinite(world.homeYaw) ? world.homeYaw : 0;
    d.faceYaw = yaw;
    hoverTo(d, d.home[0] - Math.sin(yaw) * def.shadowOffset, d.groundY + def.shadowAlt,
      d.home[2] - Math.cos(yaw) * def.shadowOffset, dt);
    if (d.bombs > 0 && target && !world.standDown) { setState(d, 'climb'); out.launched = true; }
    else if (d.bombs < def.bombs) { setState(d, 'rearm'); d.reloadT = 0; }
    return;
  }
  // rearm: come down into the operator's hands. Bombs are hung on the rack by a man standing there,
  // so the clock only runs while the drone is actually within reach of him -- the flight home is not
  // a reload. A wing has no way to do this and simply circles instead.
  if (def.canHover) {
    const yaw = Number.isFinite(world.homeYaw) ? world.homeYaw : 0;
    d.faceYaw = yaw;   // sitting in front of him facing his way, not drifting on its last heading
    const dx = Math.sin(yaw) * def.dockOffset, dz = Math.cos(yaw) * def.dockOffset;
    const dist = hoverTo(d, d.home[0] + dx, d.home[1] + def.dockAlt, d.home[2] + dz, dt, def.hoverSpeed);
    out.docked = dist <= def.dockRadius;
    out.dock = [d.home[0] + dx, d.home[1] + def.dockAlt, d.home[2] + dz];
    // Servicing is hands-on work and stops the operator; a drone merely parked in his hands does not.
    out.servicing = out.docked && d.bombs < def.bombs;
    if (out.docked) d.reloadT += dt;
  } else {
    orbitAround(d, d.home[0], d.home[2], def.stationRadius, def.cruiseAlt * 0.5, dt, def.speed * 0.55);
    d.reloadT += dt;
  }
  if (d.reloadT >= def.reloadS && d.bombs < def.bombs) { d.bombs = def.bombs; out.rearmed = true; }
  if (d.bombs > 0 && target && !world.standDown) { setState(d, 'climb'); out.launched = true; }
  else if (d.bombs >= def.bombs && def.canHover && !world.standDown) setState(d, 'shadow');
}

function stepLoiter(d, dt, world, target, out) {
  const def = d.def;
  const hold = !!world.holdFire;
  if (d.state === 'dive') {
    const aim = d.aim || target;
    // Wave-off: an ally walked into the impact ring, so pull out and go back up rather than press on.
    if (!aim || hold) { setState(d, 'climb'); d.diveT = 0; return; }
    d.diveT += dt;
    const dx = aim[0] - d.p[0], dy = aim[1] - d.p[1], dz = aim[2] - d.p[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= def.hitRadius || d.p[1] <= d.groundY + 0.4) {
      out.detonate = [d.p[0], d.p[1], d.p[2]];
      d.done = true;
      return;
    }
    steerToward3(d.v, [dx, dy, dz], def.diveTurn, dt);
    const sp = diveSpeed(d.diveT, def);
    const cur = vlen(d.v);
    if (cur > EPS) { const k = sp / cur; d.v[0] *= k; d.v[1] *= k; d.v[2] *= k; }
    return;
  }
  // The orbit drifts toward whatever the operator is watching: a loiterer belongs over the objective.
  if (target) {
    const cx = target[0] - d.center[0], cz = target[2] - d.center[1];
    const cl = Math.hypot(cx, cz);
    const move = Math.min(cl, def.centerDrift * dt);
    if (cl > EPS) { d.center[0] += (cx / cl) * move; d.center[1] += (cz / cl) * move; }
  }
  if (d.state === 'climb') {
    orbitAround(d, d.center[0], d.center[1], def.orbitRadius, def.cruiseAlt, dt);
    if (d.p[1] >= d.groundY + def.cruiseAlt - 2) setState(d, 'orbit');
    return;
  }
  orbitAround(d, d.center[0], d.center[1], def.orbitRadius, def.cruiseAlt, dt);
  if (target && !hold && d.age >= def.armS) {
    const flat = Math.hypot(target[0] - d.p[0], target[2] - d.p[2]);
    if (flat <= def.diveRadius) { setState(d, 'dive'); d.diveT = 0; }
  }
}

// The operator is gone. The bomb drone was being FLOWN by him, so it goes dead stick: no power, no
// stabilisation, and whatever it still has on the rack goes off where it lands -- on whoever is
// standing there. The loiterer is fire-and-forget and does not care that he is dead.
export function orphanDrone(d, opts = {}) {
  if (!d || d.done) return;
  if (d.kind === DRONE_BOMBER) { crippleDrone(d, opts); return; }
  if (d.state !== 'dive' && d.aim) { d.state = 'dive'; d.stateT = 0; d.diveT = 0; }
  d.def = { ...d.def, life: Math.min(d.def.life, d.age + 20) };
}

// Put any drone into dead stick. `wild` picks the flavour; `phase` seeds the wander so two drones
// crippled in the same blast do not fly the identical path. The caller rolls the dice -- this module
// stays deterministic so the tests can drive both flavours directly.
export function crippleDrone(d, { wild = false, phase = null } = {}) {
  if (!d || d.done || d.state === 'deadstick') return;
  d.state = 'deadstick'; d.stateT = 0;
  d.wild = !!wild;
  d.tumble = !wild;            // a wild one is still flying, so it still points where it is going
  d.faceYaw = null;
  d.wildPhase = Array.isArray(phase) && phase.length === 3
    ? [Number(phase[0]) || 0, Number(phase[1]) || 0, Number(phase[2]) || 0]
    : [0, 2.1, 4.2];
  // A wild one that was hovering when it was hit has no speed to run away with, and would just sink
  // on the spot -- indistinguishable from the plain fall. The rotors are still driving it, so give it
  // the airframe's own speed along whatever heading it was holding.
  if (d.wild && vlen(d.v) < d.def.speed * 0.6) {
    d.v[0] = Math.sin(d.yaw) * d.def.speed * 0.8;
    d.v[2] = Math.cos(d.yaw) * d.def.speed * 0.8;
  }
}
