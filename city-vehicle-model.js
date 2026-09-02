// city-vehicle-model.js -- fixed-step planar road-car physics.
//
// This mirrors the flight model's useful boundary: state + input go in, a
// renderer-free physics step comes out. It deliberately models a game car rather
// than a wheel/suspension simulator: longitudinal force, front/rear tire grip,
// yaw inertia, drag, and a handbrake are enough for a heavy, recoverable city car.

export const G = 9.81;

export const DEFAULT_ROAD_VEHICLE = Object.freeze({
  mass: 1480,
  wheelbase: 2.62,
  cgHeight: 0.54,
  yawInertia: 2450,
  engineForce: 8200,
  powerLimit: 112000,
  reverseForce: 3600,
  brakeForce: 14200,
  handbrakeForce: 8200,
  rollingResistance: 0.015,
  cdA: 0.72,
  frontGrip: 1.04,
  rearGrip: 1.00,
  cornerStiffnessFront: 98000,
  cornerStiffnessRear: 92000,
  maxSteer: 0.58,
  steerResponse: 7.5,
  steerSpeedFalloff: 0.045,
  yawDamping: 0.38,
  lateralDrag: 0.12,
  maxSpeed: 58,
});

export function makeRoadVehicle(options = {}) {
  const def = { ...DEFAULT_ROAD_VEHICLE, ...(options.def || {}) };
  return {
    def,
    x: options.x || 0,
    z: options.z || 0,
    yaw: options.yaw || 0, // 0 faces +Z, matching the city vehicle meshes
    vx: options.vx || 0,
    vz: options.vz || 0,
    yawRate: 0,
    steering: 0,
    speed: 0,
    longitudinalSpeed: 0,
    lateralSpeed: 0,
    acceleration: 0,
    grade: Number.isFinite(options.grade) ? options.grade : 0,
  };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Advance one fixed physics step. `input` is normalized: throttle/brake/reverse 0..1,
// steer -1..1 (positive is the driver's right), handbrake boolean. It is also safe at a
// variable dt for tests. Cars face +Z, so a right turn is negative yaw in Three's coordinates.
export function stepRoadVehicle(body, input = {}, dt = 1 / 120) {
  if (!(dt > 0) || !Number.isFinite(dt)) return body;
  const d = body.def;
  const throttle = clamp(Number(input.throttle) || 0, 0, 1);
  const brake = clamp(Number(input.brake) || 0, 0, 1);
  const reverse = clamp(Number(input.reverse) || 0, 0, 1);
  const steerInput = clamp(Number(input.steer) || 0, -1, 1);
  const handbrake = !!input.handbrake;

  const sy = Math.sin(body.yaw), cy = Math.cos(body.yaw);
  const fx = sy, fz = cy, rx = cy, rz = -sy;
  let vLong = body.vx * fx + body.vz * fz;
  let vLat = body.vx * rx + body.vz * rz;
  const speed = Math.hypot(body.vx, body.vz);

  const speedSteer = 1 / (1 + speed * d.steerSpeedFalloff);
  const targetSteer = -steerInput * d.maxSteer * speedSteer;
  body.steering += (targetSteer - body.steering) * Math.min(1, dt * d.steerResponse);

  // The engine transitions naturally from force-limited launch to power-limited top speed.
  const forward = Math.max(0, vLong);
  const driveForce = throttle * Math.min(d.engineForce, d.powerLimit / Math.max(4, forward));
  const reverseForce = reverse * Math.min(d.reverseForce, d.powerLimit / Math.max(4, Math.abs(vLong)));
  const brakeDirection = Math.sign(vLong || 1);
  let longitudinalForce = driveForce - reverseForce - brake * d.brakeForce * brakeDirection;
  if (handbrake) longitudinalForce -= d.handbrakeForce * brakeDirection;
  // Positive grade is uphill in the vehicle's forward direction. Callers that live on a
  // plane leave it at zero; terrain-aware callers update it from their ground fit.
  longitudinalForce -= d.mass * G * Math.sin(Number(body.grade) || 0);

  // Rolling and aerodynamic drag are both real forces, so mass changes acceleration and
  // power/drag produces top speed rather than an arbitrary clamp.
  if (Math.abs(vLong) > 0.02) {
    longitudinalForce -= Math.sign(vLong) * (d.rollingResistance * d.mass * G + 0.5 * 1.225 * d.cdA * vLong * Math.abs(vLong));
  }
  const estimatedAccel = longitudinalForce / d.mass;
  const rearStatic = d.mass * G * 0.5;
  const transfer = d.mass * estimatedAccel * d.cgHeight / d.wheelbase;
  const normalFront = Math.max(d.mass * G * 0.16, rearStatic - transfer);
  const normalRear = Math.max(d.mass * G * 0.16, d.mass * G - normalFront);
  const frontLength = d.wheelbase * 0.5, rearLength = d.wheelbase * 0.5;

  // Slip-angle tire forces. They saturate at mu*N, which gives controllable understeer
  // and lets the rear step out when the handbrake lowers its available grip.
  const referenceSpeed = Math.max(1.5, Math.abs(vLong));
  // Reversing a steered car rotates its nose opposite to the same steering input. Use the
  // commanded reverse direction near rest so steering does not twitch the wrong way at launch.
  const travelDirection = vLong < -0.25 || (reverse > 0 && throttle === 0 && vLong < 0.25) ? -1 : 1;
  const effectiveSteering = body.steering * travelDirection;
  const frontSlip = Math.atan2(vLat + frontLength * body.yawRate, referenceSpeed) - effectiveSteering;
  const rearSlip = Math.atan2(vLat - rearLength * body.yawRate, referenceSpeed);
  const frontLimit = d.frontGrip * normalFront;
  const rearLimit = d.rearGrip * normalRear * (handbrake ? 0.28 : 1);
  const frontLateral = clamp(-d.cornerStiffnessFront * frontSlip, -frontLimit, frontLimit);
  const rearLateral = clamp(-d.cornerStiffnessRear * rearSlip, -rearLimit, rearLimit);
  const lateralForce = frontLateral + rearLateral - vLat * d.lateralDrag * d.mass;
  const yawTorque = frontLength * frontLateral - rearLength * rearLateral - body.yawRate * d.yawDamping * d.yawInertia;

  const forceX = fx * longitudinalForce + rx * lateralForce;
  const forceZ = fz * longitudinalForce + rz * lateralForce;
  body.vx += forceX * dt / d.mass;
  body.vz += forceZ * dt / d.mass;
  body.yawRate += yawTorque * dt / d.yawInertia;
  body.yaw += body.yawRate * dt;

  const nextSpeed = Math.hypot(body.vx, body.vz);
  if (nextSpeed > d.maxSpeed) {
    const scale = d.maxSpeed / nextSpeed;
    body.vx *= scale; body.vz *= scale;
  }
  body.x += body.vx * dt;
  body.z += body.vz * dt;

  const nsy = Math.sin(body.yaw), ncy = Math.cos(body.yaw);
  vLong = body.vx * nsy + body.vz * ncy;
  vLat = body.vx * ncy - body.vz * nsy;
  body.acceleration = (vLong - body.longitudinalSpeed) / dt;
  body.longitudinalSpeed = vLong;
  body.lateralSpeed = vLat;
  body.speed = Math.hypot(body.vx, body.vz);
  return body;
}
