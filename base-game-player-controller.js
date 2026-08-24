// Renderer-independent fixed-step kinematic capsule controller for Base Game.
// Positions are global [x, y, z] coordinates where y is the capsule's foot plane.

const EPSILON = 1e-8;

const DEFAULT_CONFIG = Object.freeze({
  radius: 0.35,
  height: 1.8,
  moveSpeed: 5.5,
  sprintMultiplier: 1.75,
  groundAcceleration: 38,
  airAcceleration: 10,
  groundDeceleration: 30,
  gravity: 26,
  jumpSpeed: 8,
  slopeLimitDegrees: 50,
  stepHeight: 0.6,
  snapDistance: 0.4,
  fixedHz: 120,
  maxCatchUpSteps: 8,
  maxMicrostepDistance: 0.14,
  collisionIterations: 5,
  // Water. The float point is the chest; buoyancy ramps in over floatDepth of submersion, so the
  // body settles where buoyancy * f == gravity and the head stays out of the swell.
  floatHeightFraction: 0.55,
  floatDepth: 0.6,
  buoyancy: 34,
  waterDrag: 3.2,
  swimSpeedMultiplier: 0.65,
  swimAcceleration: 18,
  swimUpSpeed: 3.2,
  swimDownSpeed: 3,
});

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function vec3(value, label) {
  if (!value || value.length < 3) throw new TypeError(`${label} must be [x, y, z]`);
  return [finite(value[0], `${label}[0]`), finite(value[1], `${label}[1]`), finite(value[2], `${label}[2]`)];
}

function moveToward(current, target, maxDelta) {
  if (current < target) return Math.min(target, current + maxDelta);
  return Math.max(target, current - maxDelta);
}

function capsuleAt(position, config) {
  return {
    start: [position[0], position[1] + config.radius, position[2]],
    end: [position[0], position[1] + config.height - config.radius, position[2]],
    radius: config.radius,
  };
}

function cloneCapsule(capsule) {
  return { start: [...capsule.start], end: [...capsule.end], radius: capsule.radius };
}

function translateCapsule(capsule, delta) {
  for (let axis = 0; axis < 3; axis++) {
    capsule.start[axis] += delta[axis];
    capsule.end[axis] += delta[axis];
  }
  return capsule;
}

function capsuleFoot(capsule) {
  return [capsule.start[0], capsule.start[1] - capsule.radius, capsule.start[2]];
}

function horizontalProgress(capsule, from, direction) {
  return (capsule.start[0] - from.start[0]) * direction[0]
    + (capsule.start[2] - from.start[2]) * direction[2];
}

function sanitizedConfig(next) {
  const config = { ...DEFAULT_CONFIG, ...(next || {}) };
  for (const [key, value] of Object.entries(config)) finite(value, `player config.${key}`);
  if (!(config.radius > 0)) throw new RangeError('player radius must be greater than zero');
  if (!(config.height > config.radius * 2)) throw new RangeError('player height must exceed its diameter');
  if (!(config.fixedHz >= 30 && config.fixedHz <= 240)) throw new RangeError('fixedHz must be in [30, 240]');
  if (!(config.maxCatchUpSteps >= 1)) throw new RangeError('maxCatchUpSteps must be positive');
  if (!(config.maxMicrostepDistance > 0)) throw new RangeError('maxMicrostepDistance must be positive');
  if (!(config.floatDepth > 0)) throw new RangeError('floatDepth must be positive');
  if (!(config.floatHeightFraction > 0 && config.floatHeightFraction < 1)) throw new RangeError('floatHeightFraction must be in (0, 1)');
  if (config.buoyancy < 0 || config.waterDrag < 0) throw new RangeError('buoyancy and waterDrag must not be negative');
  return config;
}

// `waterSurfaceAt(x, z, t)` returns the sea surface height above a global column, or null where
// there is no water. `t` is the tick clock in seconds, so the whole step is a pure function of the
// tick: the client's prediction and the server's simulation reach the same position.
export function createBaseGamePlayerController({ worldQuery, spawn = [0, 1.2, 0], config, waterSurfaceAt = null } = {}) {
  if (!worldQuery || typeof worldQuery.resolveCapsule !== 'function' || typeof worldQuery.groundProbe !== 'function') {
    throw new TypeError('player controller requires resolveCapsule() and groundProbe() world queries');
  }

  let cfg = sanitizedConfig(config);
  const position = vec3(spawn, 'spawn');
  const previousPosition = [...position];
  const velocity = [0, 0, 0];
  const input = { moveX: 0, moveZ: 0, yaw: 0, sprint: false, crouch: false };
  let grounded = false;
  let ceiling = false;
  let accumulator = 0;
  let jumpQueued = false;
  let simulatedSteps = 0;
  let droppedCatchUpSeconds = 0;
  let contacts = [];
  let surface = null;
  let clockTick = 0;        // the lockstep tick being simulated; the water clock reads it
  let swimming = false;
  let submersion = 0;       // metres the float point sits below the surface (negative when clear)
  let waterDepth = 0;       // metres the feet sit below the surface (negative when clear)
  let waterLevel = null;    // last sampled surface height, or null where there is no water

  function sampleWater() {
    waterLevel = null;
    submersion = 0;
    waterDepth = 0;
    if (typeof waterSurfaceAt !== 'function') return;
    const y = waterSurfaceAt(position[0], position[2], clockTick / cfg.fixedHz);
    if (!Number.isFinite(y)) return;
    waterLevel = y;
    waterDepth = y - position[1];
    submersion = y - (position[1] + cfg.height * cfg.floatHeightFraction);
  }

  function surfaceIdentity(hit) {
    if (!hit) return null;
    return {
      providerId: hit.providerId ?? null,
      colliderId: hit.colliderId ?? null,
      entityId: hit.entityId ?? null,
      material: hit.material ?? null,
      surfaceType: hit.surfaceType ?? null,
      point: hit.point ? [...hit.point] : null,
      normal: hit.normal ? [...hit.normal] : null,
    };
  }

  function configure(patch) {
    cfg = sanitizedConfig({ ...cfg, ...(patch || {}) });
    return { ...cfg };
  }

  function resolve(capsule, candidateVelocity) {
    return worldQuery.resolveCapsule({
      capsule,
      velocity: candidateVelocity,
      slopeLimitCos: Math.cos(cfg.slopeLimitDegrees * Math.PI / 180),
      iterations: cfg.collisionIterations,
    });
  }

  function trySnapDown(capsule, wasGrounded, candidateVelocity, alreadyGrounded) {
    if (swimming || (!wasGrounded && !alreadyGrounded) || candidateVelocity[1] > EPSILON || cfg.snapDistance <= 0) {
      return { capsule, grounded: alreadyGrounded, surface: null };
    }
    const foot = capsuleFoot(capsule);
    const skin = 0.05;
    const hit = worldQuery.groundProbe({
      origin: [foot[0], foot[1] + skin, foot[2]],
      maxDistance: cfg.snapDistance + skin,
      slopeLimitCos: Math.cos(cfg.slopeLimitDegrees * Math.PI / 180),
    });
    if (!hit) return { capsule, grounded: alreadyGrounded, surface: null };
    const drop = foot[1] - hit.point[1];
    if (drop < -skin || drop > cfg.snapDistance + EPSILON) return { capsule, grounded: alreadyGrounded, surface: null };
    translateCapsule(capsule, [0, -drop, 0]);
    candidateVelocity[1] = Math.max(0, candidateVelocity[1]);
    return { capsule, grounded: true, surface: hit };
  }

  function tryStepUp(from, displacement, baseline, incomingVelocity, wasGrounded) {
    const horizontalLength = Math.hypot(displacement[0], displacement[2]);
    if (swimming || !wasGrounded || cfg.stepHeight <= 0 || horizontalLength <= EPSILON) return baseline;
    const direction = [displacement[0] / horizontalLength, 0, displacement[2] / horizontalLength];
    const baseProgress = horizontalProgress(baseline.capsule, from, direction);
    if (baseProgress >= horizontalLength * 0.8) return baseline;

    const candidate = cloneCapsule(from);
    translateCapsule(candidate, [displacement[0], cfg.stepHeight, displacement[2]]);
    const stepped = resolve(candidate, [...incomingVelocity]);
    const foot = capsuleFoot(stepped.capsule);
    const skin = 0.05;
    const probeLead = stepped.capsule.radius + skin + 0.02;
    const hit = worldQuery.groundProbe({
      origin: [foot[0] + direction[0] * probeLead, foot[1] + skin, foot[2] + direction[2] * probeLead],
      maxDistance: cfg.stepHeight + cfg.snapDistance + skin,
      slopeLimitCos: Math.cos(cfg.slopeLimitDegrees * Math.PI / 180),
    });
    if (!hit) return baseline;
    const oldFootY = from.start[1] - from.radius;
    const rise = hit.point[1] - oldFootY;
    const geometryTolerance = 1e-4;
    if (rise < -cfg.snapDistance - geometryTolerance || rise > cfg.stepHeight + geometryTolerance) return baseline;
    translateCapsule(stepped.capsule, [0, hit.point[1] - foot[1], 0]);
    const seated = resolve(stepped.capsule, stepped.velocity);
    const steppedProgress = horizontalProgress(seated.capsule, from, direction);
    if (steppedProgress <= baseProgress + 1e-4) return baseline;
    return {
      ...seated,
      grounded: true,
      surface: hit,
      contacts: [...(stepped.contacts || []), ...(seated.contacts || [])],
    };
  }

  function moveAndCollide(displacement) {
    const distance = Math.hypot(displacement[0], displacement[1], displacement[2]);
    const microsteps = Math.max(1, Math.ceil(distance / cfg.maxMicrostepDistance));
    const delta = displacement.map(component => component / microsteps);
    let capsule = capsuleAt(position, cfg);
    let anyGrounded = false;
    let anyCeiling = false;
    const allContacts = [];
    let resolvedSurface = null;

    for (let step = 0; step < microsteps; step++) {
      const from = cloneCapsule(capsule);
      const wasGrounded = grounded || anyGrounded;
      const baselineCapsule = translateCapsule(cloneCapsule(from), delta);
      let result = resolve(baselineCapsule, [...velocity]);
      result = tryStepUp(from, delta, result, velocity, wasGrounded);
      const snapped = trySnapDown(result.capsule, wasGrounded, result.velocity, result.grounded);
      capsule = snapped.capsule;
      velocity[0] = result.velocity[0];
      velocity[1] = result.velocity[1];
      velocity[2] = result.velocity[2];
      anyGrounded = anyGrounded || snapped.grounded;
      anyCeiling = anyCeiling || result.ceiling;
      if (result.contacts) allContacts.push(...result.contacts);
      if (result.surface) resolvedSurface = result.surface;
      if (snapped.surface) resolvedSurface = snapped.surface;
    }

    const foot = capsuleFoot(capsule);
    position[0] = foot[0]; position[1] = foot[1]; position[2] = foot[2];
    grounded = anyGrounded;
    ceiling = anyCeiling;
    contacts = allContacts;
    surface = grounded ? surfaceIdentity(resolvedSurface) : null;
    if (grounded && velocity[1] < 0) velocity[1] = 0;
    if (ceiling && velocity[1] > 0) velocity[1] = 0;
  }

  function fixedStep(dt) {
    previousPosition[0] = position[0];
    previousPosition[1] = position[1];
    previousPosition[2] = position[2];

    const inputLength = Math.hypot(input.moveX, input.moveZ);
    const localX = inputLength > 1 ? input.moveX / inputLength : input.moveX;
    const localZ = inputLength > 1 ? input.moveZ / inputLength : input.moveZ;
    const sy = Math.sin(input.yaw), cy = Math.cos(input.yaw);
    const worldX = localX * cy - localZ * sy;
    const worldZ = -localX * sy - localZ * cy;
    sampleWater();
    swimming = submersion > 0;
    // Wading slows you down before it floats you: the drag ramps with how deep the body is.
    const wade = waterLevel === null ? 0 : Math.max(0, Math.min(1, waterDepth / cfg.height));
    const waterSlow = 1 + (cfg.swimSpeedMultiplier - 1) * wade;
    const speed = cfg.moveSpeed * (input.sprint ? cfg.sprintMultiplier : 1) * waterSlow;
    const acceleration = swimming ? cfg.swimAcceleration : (grounded ? cfg.groundAcceleration : cfg.airAcceleration);

    if (inputLength > EPSILON) {
      velocity[0] = moveToward(velocity[0], worldX * speed, acceleration * dt);
      velocity[2] = moveToward(velocity[2], worldZ * speed, acceleration * dt);
    } else if (grounded || swimming) {
      velocity[0] = moveToward(velocity[0], 0, (swimming ? cfg.waterDrag * cfg.moveSpeed : cfg.groundDeceleration) * dt);
      velocity[2] = moveToward(velocity[2], 0, (swimming ? cfg.waterDrag * cfg.moveSpeed : cfg.groundDeceleration) * dt);
    }

    if (swimming) {
      // Buoyancy replaces gravity, jump swims up and crouch swims down; the seabed still stops you.
      const lift = Math.max(0, Math.min(1, submersion / cfg.floatDepth));
      velocity[1] += (cfg.buoyancy * lift - cfg.gravity) * dt;
      if (jumpQueued) velocity[1] = moveToward(velocity[1], cfg.swimUpSpeed, cfg.swimAcceleration * dt);
      if (input.crouch) velocity[1] = moveToward(velocity[1], -cfg.swimDownSpeed, cfg.swimAcceleration * dt);
      velocity[1] -= velocity[1] * Math.min(1, cfg.waterDrag * dt);
      jumpQueued = false;
      grounded = false;
    } else {
      if (jumpQueued && grounded) {
        velocity[1] = cfg.jumpSpeed;
        grounded = false;
        jumpQueued = false;
      }
      if (!grounded) velocity[1] -= cfg.gravity * dt;
    }
    moveAndCollide([velocity[0] * dt, velocity[1] * dt, velocity[2] * dt]);
    simulatedSteps++;
  }

  function advance(realDt) {
    const dt = Math.max(0, finite(realDt, 'realDt'));
    const fixedDt = 1 / cfg.fixedHz;
    const maxAccumulated = fixedDt * cfg.maxCatchUpSteps;
    const accepted = Math.min(dt, maxAccumulated);
    droppedCatchUpSeconds += Math.max(0, dt - accepted);
    accumulator = Math.min(maxAccumulated, accumulator + accepted);
    let steps = 0;
    let frameCeiling = false;
    while (accumulator + EPSILON >= fixedDt && steps < cfg.maxCatchUpSteps) {
      clockTick++;
      fixedStep(fixedDt);
      frameCeiling = frameCeiling || ceiling;
      accumulator -= fixedDt;
      steps++;
    }
    if (steps > 0) ceiling = frameCeiling;
    return { steps, alpha: Math.max(0, Math.min(1, accumulator / fixedDt)) };
  }

  function interpolatedPosition(alpha = accumulator * cfg.fixedHz, out = [0, 0, 0]) {
    const t = Math.max(0, Math.min(1, alpha));
    out[0] = previousPosition[0] + (position[0] - previousPosition[0]) * t;
    out[1] = previousPosition[1] + (position[1] - previousPosition[1]) * t;
    out[2] = previousPosition[2] + (position[2] - previousPosition[2]) * t;
    return out;
  }

  function reset(nextPosition = spawn) {
    const next = vec3(nextPosition, 'reset position');
    position.splice(0, 3, ...next);
    previousPosition.splice(0, 3, ...next);
    velocity.fill(0);
    accumulator = 0;
    grounded = false;
    ceiling = false;
    jumpQueued = false;
    contacts = [];
    surface = null;
    swimming = false;
    submersion = 0;
    waterDepth = 0;
    waterLevel = null;
  }

  return {
    configure,
    setInput(next = {}) {
      input.moveX = Math.max(-1, Math.min(1, Number(next.moveX) || 0));
      input.moveZ = Math.max(-1, Math.min(1, Number(next.moveZ) || 0));
      input.yaw = Number.isFinite(next.yaw) ? next.yaw : input.yaw;
      input.sprint = !!next.sprint;
      input.crouch = !!next.crouch;
    },
    queueJump() { jumpQueued = true; },
    // One fixed step from an explicit input, bypassing the frame accumulator. Client prediction
    // and the room server both drive lockstep ticks through this so their arithmetic is identical.
    // The tick names the water clock, so an explicit `next.tick` keeps the client's replay and the
    // server's simulation on the same second of the swell; without one the counter just advances.
    stepOnce(next = null, jump = false) {
      if (next) this.setInput(next);
      if (jump) jumpQueued = true;
      clockTick = Number.isSafeInteger(next?.tick) ? next.tick : clockTick + 1;
      fixedStep(1 / cfg.fixedHz);
      return { grounded, ceiling, swimming };
    },
    clearJump() { jumpQueued = false; },
    advance,
    reset,
    interpolatedPosition,
    getPosition(out = [0, 0, 0]) {
      out[0] = position[0]; out[1] = position[1]; out[2] = position[2]; return out;
    },
    getVelocity(out = [0, 0, 0]) {
      out[0] = velocity[0]; out[1] = velocity[1]; out[2] = velocity[2]; return out;
    },
    getCapsule() { return capsuleAt(position, cfg); },
    get grounded() { return grounded; },
    get ceiling() { return ceiling; },
    get tick() { return clockTick; },
    get waterTime() { return clockTick / cfg.fixedHz; },
    get swimming() { return swimming; },
    get inWater() { return waterLevel !== null && waterDepth > 0; },
    get submersion() { return submersion; },
    get waterSurface() { return waterLevel; },
    get contacts() { return contacts.map(contact => ({ ...contact })); },
    get surface() { return surface ? { ...surface, point: surface.point && [...surface.point], normal: surface.normal && [...surface.normal] } : null; },
    get config() { return { ...cfg }; },
    get diagnostics() {
      return { simulatedSteps, droppedCatchUpSeconds, accumulator, grounded, ceiling, contactCount: contacts.length, tick: clockTick, swimming, submersion };
    },
    captureState() {
      return { position: [...position], previousPosition: [...previousPosition], velocity: [...velocity], grounded, tick: clockTick };
    },
    applyState(state) {
      if (!state || typeof state !== 'object') return false;
      const nextPosition = vec3(state.position, 'player state.position');
      const nextVelocity = vec3(state.velocity ?? [0, 0, 0], 'player state.velocity');
      position.splice(0, 3, ...nextPosition);
      previousPosition.splice(0, 3, ...(state.previousPosition ? vec3(state.previousPosition, 'player state.previousPosition') : nextPosition));
      velocity.splice(0, 3, ...nextVelocity);
      grounded = state.grounded === true;
      if (Number.isSafeInteger(state.tick)) clockTick = state.tick;
      swimming = false;
      ceiling = false;
      accumulator = 0;
      jumpQueued = false;
      contacts = [];
      surface = null;
      return true;
    },
  };
}

export { DEFAULT_CONFIG as BASE_GAME_PLAYER_DEFAULT_CONFIG };
