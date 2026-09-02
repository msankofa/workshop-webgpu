// The Solo path: the trigger has to reach the record, or fireVehicleTurret refuses forever.
import { BASE_GAME_VEHICLE_DEFS, createBaseGameVehicle, stepBaseGameVehicle, aimVehicleTurret, fireVehicleTurret } from '../../base-game-vehicles.js';
const groundY = () => 0;
const world = { groundY, ownerPos: [0,0,0], ownerYaw: 0, ownerAlive: true, seaLevel: -Infinity };
// Exactly what applyLocalVehicleControl now does with a tick input.
function applyLocalVehicleControl(rec, di) {
  if (rec.def.turret) { if (di.aim) rec.aim = di.aim; rec.firing = di.mode === 1 && di.fire === true; }
}
const rec = createBaseGameVehicle('ugv', { ownerId:'local', from:[0,0,0], yaw:0, groundY });
rec.mode = 'parked'; rec.state = 'parked';
const aim = [0, 1.3, 60];
let fired = 0;
for (let i = 0; i < 480; i++) {
  applyLocalVehicleControl(rec, { id: rec.id, mode: 1, aim, fire: true });
  stepBaseGameVehicle(rec, 1/120, world);
  if (fireVehicleTurret(rec)) fired++;
}
console.log(`held trigger for 4 s in Solo -> ${fired} rounds, ammo ${rec.mount.ammo}/${BASE_GAME_VEHICLE_DEFS.ugv.turret.ammo}`);
let after = 0;
for (let i = 0; i < 240; i++) {
  applyLocalVehicleControl(rec, { id: rec.id, mode: 1, aim, fire: false });
  stepBaseGameVehicle(rec, 1/120, world);
  if (fireVehicleTurret(rec)) after++;
}
console.log(`trigger released for 2 s      -> ${after} rounds`);
