// How the 82 park residents that cannot walk get about.

/** Every style this module solves. The legged styles (`quad`/`biped`/`multi`) belong to the walker. */
// `ground` is not authored on any species.
export const MOVER_STYLES = Object.freeze(['hover', 'fly', 'swim', 'slither', 'roll', 'hop', 'burrow', 'static', 'ground']);

/** Per-style motion constants */
export const MOVER_TUNING = Object.freeze({
  hover:   { speed: 1.1, turn: 2.2, ride: 0.55, bobAmp: 0.10, bobRate: 1.4, bank: 0.20, accel: 2.5 },
  fly:     { speed: 3.2, turn: 1.4, ride: 4.00, bobAmp: 0.18, bobRate: 0.7, bank: 0.75, accel: 1.6 },
  swim:    { speed: 1.6, turn: 1.6, ride: 0.00, bobAmp: 0.07, bobRate: 0.9, bank: 0.25, accel: 2.0 },
  slither: { speed: 1.2, turn: 1.8, ride: 0.06, bobAmp: 0.00, bobRate: 0.0, bank: 0.00, accel: 3.0 },
  roll:    { speed: 2.4, turn: 2.6, ride: 0.50, bobAmp: 0.00, bobRate: 0.0, bank: 0.00, accel: 3.0 },
  hop:     { speed: 1.3, turn: 2.4, ride: 0.00, bobAmp: 0.00, bobRate: 0.0, bank: 0.00, accel: 4.0 },
  burrow:  { speed: 1.8, turn: 3.0, ride: 0.00, bobAmp: 0.00, bobRate: 0.0, bank: 0.00, accel: 4.0 },
  static:  { speed: 0.0, turn: 0.6, ride: 0.00, bobAmp: 0.02, bobRate: 0.8, bank: 0.00, accel: 1.0 },
  ground:  { speed: 1.0, turn: 2.0, ride: 0.00, bobAmp: 0.03, bobRate: 3.2, bank: 0.08, accel: 3.0 },
});

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Where the head has been, in metres of travel rather than in frames. */
export class Trail {
  constructor(length, spacing = 0.08) {
    this.spacing = Math.max(1e-4, spacing);
    this.capacity = Math.max(4, Math.ceil(length / this.spacing) + 2);
    this.pts = new Float32Array(this.capacity * 3);
    this.count = 0;
    this.head = 0;
  }

  reset(x, y, z) {
    this.count = 0; this.head = 0;
    for (let i = 0; i < this.capacity; i++) this._push(x, y, z);
  }

  _push(x, y, z) {
    this.head = (this.head + 1) % this.capacity;
    const i = this.head * 3;
    this.pts[i] = x; this.pts[i + 1] = y; this.pts[i + 2] = z;
    if (this.count < this.capacity) this.count++;
  }

  /** Advance the record to a new head position, emitting one sample per `spacing` of travel. */
  advance(x, y, z) {
    let i = this.head * 3;
    let ax = this.pts[i], ay = this.pts[i + 1], az = this.pts[i + 2];
    let dx = x - ax, dy = y - ay, dz = z - az;
    let d = Math.hypot(dx, dy, dz);
    while (d >= this.spacing) {
      const t = this.spacing / d;
      ax += dx * t; ay += dy * t; az += dz * t;
      this._push(ax, ay, az);
      dx = x - ax; dy = y - ay; dz = z - az;
      d = Math.hypot(dx, dy, dz);
    }
  }

  /** The point `back` metres behind the head, linearly interpolated between samples. */
  sample(back, out = { x: 0, y: 0, z: 0 }) {
    const f = clamp(back / this.spacing, 0, this.count - 1);
    const i0 = Math.floor(f), frac = f - i0;
    const a = ((this.head - i0) % this.capacity + this.capacity) % this.capacity;
    const b = ((this.head - i0 - 1) % this.capacity + this.capacity) % this.capacity;
    const ia = a * 3, ib = b * 3;
    out.x = this.pts[ia] + (this.pts[ib] - this.pts[ia]) * frac;
    out.y = this.pts[ia + 1] + (this.pts[ib + 1] - this.pts[ia + 1]) * frac;
    out.z = this.pts[ia + 2] + (this.pts[ib + 2] - this.pts[ia + 2]) * frac;
    return out;
  }
}

/** A body that steers toward a target and travels above, on, or under the ground depending on its style. */
export function createMover({
  style,
  heightM = 1,
  lengthM = null,
  terrainHeight = () => 0,
  waterHeight = null,
  waterLevel = 0,
  roamRadius = 14,
  rng = Math.random,
  tuning = null,
} = {}) {
  if (!MOVER_STYLES.includes(style)) throw new Error(`createMover: unknown style ${style}`);
  const T = { ...MOVER_TUNING[style], ...(tuning || {}) };
  const H = Math.max(0.05, heightM);
  const L = Math.max(H, lengthM ?? H * 2);

  const body = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  // Style-specific outputs the renderer reads.
  const extra = { spin: 0, squash: 1, submerged: 0, speed: 0, airborne: false, phase: rng() * TAU };

  const home = { x: 0, z: 0 };
  const target = { x: 0, z: 0 };
  let haveTarget = false;
  let speed = 0;
  let elapsed = 0;
  let hopTimer = 0, hopVy = 0, hopY = 0;
  let surfaceTimer = 2 + rng() * 4;
  const trail = style === 'slither' ? new Trail(L * 1.2, Math.max(0.02, L / 24)) : null;

  const groundAt = (x, z) => terrainHeight(x, z);
  const surfaceAt = (x, z) => (waterHeight ? waterHeight(x, z) : waterLevel);

  function pickTarget() {
    // Around HOME, not around the world origin.
    const r = roamRadius * (0.3 + 0.7 * rng());
    const a = rng() * TAU;
    target.x = home.x + Math.cos(a) * r;
    target.z = home.z + Math.sin(a) * r;
    haveTarget = true;
  }

  function placeAt(x, z, yaw = 0) {
    body.x = x; body.z = z; body.yaw = yaw;
    home.x = x; home.z = z;
    body.pitch = 0; body.roll = 0;
    speed = 0; hopY = 0; hopVy = 0; hopTimer = rng() * 0.6;
    haveTarget = false;
    body.y = restY(x, z);
    if (trail) trail.reset(body.x, body.y, body.z);
    return body;
  }

  function setTarget(x, z) { target.x = x; target.z = z; haveTarget = true; }
  function setHome(x, z) { home.x = x; home.z = z; }

  /** The height this style rests at over the column (x, z), before bob and hop are added. */
  function restY(x, z) {
    const g = groundAt(x, z);
    if (style === 'swim') return surfaceAt(x, z);
    if (style === 'burrow') return g;
    return g + T.ride * H;
  }

  function steer(dt) {
    if (T.speed <= 0) return 0;
    if (!haveTarget) pickTarget();
    const dx = target.x - body.x, dz = target.z - body.z;
    const dist = Math.hypot(dx, dz);
    if (dist < Math.max(0.35 * H, roamRadius * 0.06)) { pickTarget(); return dist; }
    const desiredYaw = Math.atan2(dx, dz);
    const diff = wrapAngle(desiredYaw - body.yaw);
    const turn = T.turn * dt;
    body.yaw = wrapAngle(body.yaw + clamp(diff, -turn, turn));
    // Slow into the turn rather than skating sideways through it: the same rule the walker uses.
    const wanted = T.speed * H * (0.3 + 0.7 * Math.max(0, Math.cos(diff)));
    speed += (wanted - speed) * clamp(T.accel * dt, 0, 1);
    body.roll = -clamp(diff, -1, 1) * T.bank;
    return dist;
  }

  function step(dt, { walk = true } = {}) {
    if (!(dt > 0)) return body;
    elapsed += dt;
    const moving = walk && T.speed > 0;
    if (moving) steer(dt);
    else speed += (0 - speed) * clamp(T.accel * dt, 0, 1);

    let nx = body.x + Math.sin(body.yaw) * speed * dt;
    let nz = body.z + Math.cos(body.yaw) * speed * dt;

    if (style === 'swim') {
      // A swimmer that walks up the beach is the single most obvious failure of a lake full of Magikarp.
      const g = groundAt(nx, nz), s = surfaceAt(nx, nz);
      if (s - g < H * 0.45) { pickTarget(); nx = body.x; nz = body.z; speed *= 0.3; }
    }

    body.x = nx; body.z = nz;
    extra.speed = speed;

    const rest = restY(body.x, body.z);
    switch (style) {
      case 'hop': {
        hopTimer -= dt;
        if (hopY <= 0 && hopVy <= 0) {
          hopY = 0; hopVy = 0; extra.airborne = false;
          // Squash on the ground, stretch in the air — the whole read of a hop is in this one number.
          extra.squash = 1 - 0.18 * clamp(hopTimer / 0.25, 0, 1);
          if (hopTimer <= 0 && moving) { hopVy = Math.sqrt(2 * 9.81 * (0.45 * H)); hopTimer = 0.35 + rng() * 0.25; }
        } else {
          hopVy -= 9.81 * dt;
          hopY = Math.max(0, hopY + hopVy * dt);
          extra.airborne = hopY > 0;
          extra.squash = 1 + 0.14 * clamp(hopVy / 3, -1, 1);
          if (hopY <= 0) { hopVy = 0; hopTimer = 0.18 + rng() * 0.22; }
        }
        body.y = rest + hopY;
        body.pitch = 0;
        break;
      }
      case 'roll': {
        // Rolled angle is the distance covered over the radius, so the ball never skates.
        const radius = Math.max(1e-3, H * 0.5);
        extra.spin = wrapAngle(extra.spin + (speed * dt) / radius);
        body.y = rest;
        break;
      }
      case 'burrow': {
        surfaceTimer -= dt;
        if (surfaceTimer <= 0) { surfaceTimer = (extra.submerged > 0.5 ? 1.6 : 4) + rng() * 3; }
        const wantSub = surfaceTimer > 1.6 ? 0.75 : 0;
        extra.submerged += (wantSub - extra.submerged) * clamp(3 * dt, 0, 1);
        body.y = rest - extra.submerged * H;
        break;
      }
      case 'fly': {
        // Bank into the turn and pitch with the climb
        body.y += (rest + Math.sin(elapsed * T.bobRate + extra.phase) * T.bobAmp * H - body.y) * clamp(2.2 * dt, 0, 1);
        body.pitch = clamp((rest - body.y) * 0.25, -0.35, 0.35);
        break;
      }
      case 'swim': {
        body.y = rest + Math.sin(elapsed * T.bobRate + extra.phase) * T.bobAmp * H;
        body.pitch = Math.sin(elapsed * T.bobRate * 0.7 + extra.phase) * 0.08;
        break;
      }
      case 'slither': {
        body.y = rest;
        trail.advance(body.x, body.y, body.z);
        break;
      }
      case 'static': {
        body.y = rest;
        // Not motionless — a twitch every few seconds is what separates "asleep" from "not implemented".
        body.yaw = wrapAngle(body.yaw + Math.sin(elapsed * 0.6 + extra.phase) * 0.004);
        body.roll = Math.sin(elapsed * 1.3 + extra.phase) * 0.03;
        break;
      }
      default: { // hover
        body.y = rest + Math.sin(elapsed * T.bobRate + extra.phase) * T.bobAmp * H;
        break;
      }
    }
    return body;
  }

  /** Where a point `back` metres down the body should be, for styles that have a body worth bending. */
  function spineAt(back, out = null) {
    if (!trail) return null;
    // Allocates by default.
    return trail.sample(clamp(back, 0, trail.count * trail.spacing), out || { x: 0, y: 0, z: 0 });
  }

  return {
    style, body, extra, home,
    get speed() { return speed; },
    get elapsed() { return elapsed; },
    placeAt, setTarget, setHome, step, spineAt, restY,
    trail,
  };
}
