import { createBaseGameVehicle, stepBaseGameVehicle } from '../../base-game-vehicles.js';
for (const [eb, hs] of [[0,0],[0.3,0],[0,0.35],[0.3,0.35]]) {
  const groundY = () => 0;
  const rec = createBaseGameVehicle('ugv', { ownerId: 'o', from: [0, 0, 6], yaw: 0, groundY });
  rec.body.def.engineBrake = eb; rec.body.def.holdSpeed = hs;
  const world = { groundY, ownerPos: [0, 0, 0], ownerYaw: 0, ownerVel: [0, 0, 0], ownerAlive: true, seaLevel: -Infinity };
  const settle = (n = 900) => { for (let i = 0; i < n; i++) stepBaseGameVehicle(rec, 1 / 120, world); };
  world.ownerVel = [0, 0, 3]; settle();
  const parked = [rec.body.x, rec.body.z];
  world.ownerVel = [0, 0, 0];
  for (let turn = 0; turn < 8; turn++) { world.ownerYaw = turn * Math.PI / 4; settle(120); }
  const drift = Math.hypot(rec.body.x - parked[0], rec.body.z - parked[1]);
  world.ownerYaw = 0; world.ownerVel = [3, 0, 0];
  const trail = [];
  for (let i = 0; i < 900; i++) { stepBaseGameVehicle(rec, 1 / 120, world); if (i % 120 === 0) trail.push(`${rec.body.x.toFixed(1)},${rec.body.z.toFixed(1)}/${rec.state}/${rec.body.speed.toFixed(1)}`); }
  console.log(`eb=${eb} hs=${hs} drift=${drift.toFixed(2)} end=(${rec.body.x.toFixed(2)}, ${rec.body.z.toFixed(2)}) state=${rec.state}`);
  console.log('  ', trail.join('  '));
}
