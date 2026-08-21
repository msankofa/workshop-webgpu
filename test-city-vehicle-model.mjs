import assert from 'node:assert/strict';
import { makeRoadVehicle, stepRoadVehicle } from './city-vehicle-model.js';

const DT = 1 / 120;
function run(body, seconds, input) {
  for (let t = 0; t < seconds; t += DT) stepRoadVehicle(body, input, DT);
  return body;
}

{
  const light = run(makeRoadVehicle({ def: { mass: 1000 } }), 3, { throttle: 1 });
  const heavy = run(makeRoadVehicle({ def: { mass: 2000 } }), 3, { throttle: 1 });
  assert(light.speed > heavy.speed * 1.25, 'mass changes acceleration under equal engine force');
}

{
  const car = run(makeRoadVehicle(), 6, { throttle: 1 });
  const before = car.speed;
  run(car, 2, { brake: 1 });
  assert(car.speed < before * 0.3, 'braking removes most forward speed');
}

{
  const car = run(makeRoadVehicle(), 3, { throttle: 1 });
  const yaw = car.yaw;
  run(car, 2, { throttle: 0.55, steer: 1 });
  assert(car.yaw < yaw - 0.35, 'right steering while moving forward produces a right/negative-yaw turn');
}

{
  const car = run(makeRoadVehicle(), 2, { reverse: 1 });
  assert(car.longitudinalSpeed < -1, 'reverse accelerates the car backwards from rest');
  const yaw = car.yaw;
  run(car, 1.5, { reverse: 0.6, steer: 1 });
  assert(car.yaw > yaw + 0.2, 'right steering in reverse rotates the nose left/positive-yaw');
}

{
  const car = makeRoadVehicle();
  run(car, 3, { throttle: 1 });
  run(car, 1, { throttle: 0.5, steer: 1, handbrake: true });
  assert(Number.isFinite(car.x) && Number.isFinite(car.z) && Number.isFinite(car.yaw), 'handbrake step remains finite');
}

console.log('city-vehicle-model: all assertions passed');
