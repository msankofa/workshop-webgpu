// How violently the steering moves per tick, over rolling ground, driving to a far target.
import { createBaseGameVehicle, stepBaseGameVehicle, sendVehicleTo } from '../../base-game-vehicles.js';
const ground = (x, z) => 0.6 * Math.sin(x / 11) * Math.cos(z / 9);
const world = { groundY: ground, ownerPos: [0,0,0], ownerYaw: 0, ownerVel: [0,0,0], ownerAlive: true, seaLevel: -Infinity };
const rec = createBaseGameVehicle('ugv', { ownerId: 'o', from: [0,0,0], yaw: 0, groundY: ground });
stepBaseGameVehicle(rec, 1/120, world);
sendVehicleTo(rec, [70, 0, 70]);
let prev = rec.body.steering, worst = 0, sum = 0, n = 0, reversals = 0, prevSign = 0;
for (let i = 0; i < 120 * 25; i++) {
  stepBaseGameVehicle(rec, 1/120, world);
  const d = Math.abs(rec.body.steering - prev);
  worst = Math.max(worst, d); sum += d; n++;
  const sign = Math.sign(rec.body.steering - prev);
  if (sign && prevSign && sign !== prevSign) reversals++;
  prevSign = sign || prevSign;
  prev = rec.body.steering;
}
console.log(`per tick: worst ${(worst*1000).toFixed(2)} mrad, mean ${(sum/n*1000).toFixed(3)} mrad`);
console.log(`direction reversals in 25 s: ${reversals}`);
console.log(`arrived at ${rec.body.x.toFixed(1)}, ${rec.body.z.toFixed(1)}  state ${rec.state}`);
