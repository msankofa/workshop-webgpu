import * as THREE from 'three';
import { buildCraftMesh } from '../../flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS, createBaseGameVehicle, stepBaseGameVehicle } from '../../base-game-vehicles.js';
import { quatFromHeading } from '../../base-game-drones.js';
const M = { standard:(c,e=0)=>new THREE.MeshStandardMaterial({color:c,emissive:e}), basic:(c,o=1)=>new THREE.MeshBasicMaterial({color:c,opacity:o}) };
const ROLL_SIGN = Number(process.argv[2] ?? 1);
const def = BASE_GAME_VEHICLE_DEFS.ugv;
const mesh = buildCraftMesh('ugv', 0x8ea2b8, M, def);
const wheels = mesh.userData.wheels;

// Lowest drawn point of each tyre, in the world, for a record at (x,y,z) with yaw/pitch/roll.
const q = new THREE.Quaternion(), v = new THREE.Vector3(), axis = new THREE.Vector3(), up = new THREE.Vector3(0,1,0);
function drawnContacts(rec) {
  quatFromHeading(q, rec.body.yaw, rec.pitch, ROLL_SIGN * rec.roll);
  return wheels.map(w => {
    v.copy(w.pivot.position).applyQuaternion(q);
    axis.set(1,0,0).applyQuaternion(q);                    // the tyre spins about local X
    const drop = w.radius * Math.sqrt(Math.max(0, 1 - axis.dot(up) ** 2));
    return { x: rec.body.x + v.x, y: rec.y + v.y - drop, z: rec.body.z + v.z };
  });
}
function run(name, groundY, seconds = 2, input = null) {
  const rec = createBaseGameVehicle('ugv', { ownerId:'o', from:[0,0,0], yaw:0, groundY });
  rec.mode = 'parked'; rec.state = 'parked';
  const world = { groundY, ownerPos:[0,0,0], ownerYaw:0, ownerAlive:true, seaLevel:-Infinity };
  if (input) { rec.mode = 'manual'; rec.input = input; }
  let worstHigh = -Infinity, worstLow = Infinity, air = 0, n = 0;
  for (let i = 0; i < seconds * 120; i++) {
    stepBaseGameVehicle(rec, 1/120, world);
    if (rec.airborne) air++;
    n++;
    for (const c of drawnContacts(rec)) {
      const gap = c.y - groundY(c.x, c.z);
      worstHigh = Math.max(worstHigh, gap); worstLow = Math.min(worstLow, gap);
    }
  }
  console.log(`${name.padEnd(26)} tyre gap  min ${worstLow.toFixed(3)}  max ${worstHigh.toFixed(3)} m   airborne ${(air/n*100).toFixed(0)}%`);
}
run('flat ground, parked', () => 0);
run('flat ground, driving', () => 0, 3, { throttle: 1, brake:0, reverse:0, steer:0.2, handbrake:false });
run('10% slope, parked', (x,z) => 0.10 * x);
run('25% slope, driving', (x,z) => 0.25 * x, 3, { throttle:1, brake:0, reverse:0, steer:0, handbrake:false });
run('bumps 0.3m/8m, driving', (x,z) => 0.3*Math.sin(x/8)*Math.cos(z/8), 3, { throttle:1, brake:0, reverse:0, steer:0.1, handbrake:false });
