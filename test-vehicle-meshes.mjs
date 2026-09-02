// Node tests for the ground-vehicle craft meshes in flight-meshes.js: the drawn wheels must sit on
// the simulation's own wheelbase, track and clearance, because `fitVehicleGround` samples the
// support plane at exactly those points. Run: node test-vehicle-meshes.mjs
import * as THREE from 'three';
import { buildCraftMesh } from './flight-meshes.js';
import { BASE_GAME_VEHICLE_DEFS, createBaseGameVehicle, stepBaseGameVehicle } from './base-game-vehicles.js';
import { quatFromHeading } from './base-game-drones.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const MATERIALS = {
  standard: (color, emissive = 0x000000) => new THREE.MeshStandardMaterial({ color, emissive }),
  basic: (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, opacity }),
};

const _box = new THREE.Box3(), _size = new THREE.Vector3(), _world = new THREE.Vector3();

function inspect(kind, def) {
  const g = buildCraftMesh(def.mesh, 0x8ea2b8, MATERIALS, def);
  g.updateMatrixWorld(true);
  const wheels = g.userData.wheels ?? [];
  const xs = [...new Set(wheels.map(w => +w.pivot.position.x.toFixed(6)))].sort((a, b) => a - b);
  const zs = [...new Set(wheels.map(w => +w.pivot.position.z.toFixed(6)))].sort((a, b) => a - b);
  let meshes = 0, triangles = 0, finite = true;
  g.traverse((o) => {
    if (!o.geometry) return;
    meshes++;
    const index = o.geometry.index, position = o.geometry.attributes.position;
    triangles += (index ? index.count : position.count) / 3;
    for (let i = 0; i < position.array.length; i++) if (!Number.isFinite(position.array[i])) finite = false;
  });
  _box.setFromObject(g).getSize(_size);
  return { g, wheels, xs, zs, meshes, triangles, finite, size: _size.clone() };
}

for (const [kind, def] of Object.entries(BASE_GAME_VEHICLE_DEFS)) {
  const v = inspect(kind, def);

  ok(v.wheels.length === 4, `${kind} exposes four wheels (got ${v.wheels.length})`);
  ok(v.finite, `${kind} has no non-finite vertices`);

  // The whole point of the fourth build argument: geometry from the simulation's numbers.
  ok(v.xs.length === 2 && near(v.xs[1] - v.xs[0], def.track),
    `${kind} drawn track ${(v.xs[1] - v.xs[0]).toFixed(4)} equals the def's ${def.track}`);
  ok(v.zs.length === 2 && near(v.zs[1] - v.zs[0], def.wheelbase),
    `${kind} drawn wheelbase ${(v.zs[1] - v.zs[0]).toFixed(4)} equals the def's ${def.wheelbase}`);

  // The record's y is ground + clearance, so the tyres must reach exactly that far below the origin
  // or the vehicle floats (they used to, by the whole clearance).
  for (const wheel of v.wheels) {
    wheel.pivot.getWorldPosition(_world);
    ok(near(_world.y - wheel.radius, -def.clearance, 1e-6),
      `${kind} wheel bottom ${(_world.y - wheel.radius).toFixed(4)} sits at -clearance ${-def.clearance}`);
  }

  // Nose is -Z for every craft mesh here, so the steered pair is the one at negative z.
  for (const wheel of v.wheels) {
    ok(wheel.front === (wheel.pivot.position.z < 0),
      `${kind} wheel at z=${wheel.pivot.position.z.toFixed(2)} has front=${wheel.front}`);
  }

  // Rolling and steering survive the static merge: the pivot steers, the spin group rolls, and the
  // merged wheel geometry stays centred on the axle rather than being offset twice.
  for (const wheel of v.wheels) {
    ok(wheel.spin.children.length > 0, `${kind} wheel spin group still has geometry to roll`);
    ok(wheel.spin.parent === wheel.pivot, `${kind} wheel spin group hangs off its steering pivot`);
    wheel.spin.updateMatrixWorld(true);
    wheel.spin.children[0].getWorldPosition(_world);
    wheel.pivot.getWorldPosition(new THREE.Vector3());
    ok(near(_world.x, wheel.pivot.position.x, 1e-6) && near(_world.z, wheel.pivot.position.z, 1e-6),
      `${kind} merged wheel geometry is centred on its axle, not displaced`);
  }

  // Static parts are baked to one draw per material; the other craft in this file sit at 6-18.
  ok(v.meshes <= 20, `${kind} draws in ${v.meshes} meshes, within the file's 6-18 family`);
  ok(v.triangles < 6000, `${kind} is ${Math.round(v.triangles)} triangles`);

  // Overall proportions have to exceed the axle box, or the body is inside the wheels.
  ok(v.size.z > def.wheelbase, `${kind} is longer (${v.size.z.toFixed(2)} m) than its wheelbase`);
  ok(v.size.x > def.track, `${kind} is wider (${v.size.x.toFixed(2)} m) than its track`);
  ok(v.size.y > def.clearance, `${kind} is taller (${v.size.y.toFixed(2)} m) than its clearance`);
}

// The builders must read the argument rather than closing over constants: a def with a different
// wheelbase has to move the wheels, which is what stops the two drifting apart again.
for (const [kind, def] of Object.entries(BASE_GAME_VEHICLE_DEFS)) {
  const stretched = { ...def, wheelbase: def.wheelbase * 1.5, track: def.track * 1.5, clearance: def.clearance * 1.5 };
  const v = inspect(kind, stretched);
  ok(near(v.zs[1] - v.zs[0], stretched.wheelbase),
    `${kind} follows a stretched wheelbase (${(v.zs[1] - v.zs[0]).toFixed(3)} vs ${stretched.wheelbase.toFixed(3)})`);
  ok(near(v.xs[1] - v.xs[0], stretched.track),
    `${kind} follows a stretched track (${(v.xs[1] - v.xs[0]).toFixed(3)} vs ${stretched.track.toFixed(3)})`);
}

// The UGV is the Roboneers Sablynx reconstruction (scratchpads/sablynx-ugv/intake-analysis.md).
// Its bands are fractions of the tyre diameter above ground, and the tyre is 0.55 x wheelbase.
{
  const def = BASE_GAME_VEHICLE_DEFS.ugv;
  const v = inspect('ugv', def);
  const D = def.wheelbase * 0.55;
  const band = (y) => (y + def.clearance) / D;
  _box.setFromObject(v.g);
  ok(near(band(_box.min.y), 0, 1e-6), `ugv sits on the ground plane (${band(_box.min.y).toFixed(3)}D)`);
  ok(Math.abs(band(_box.max.y) - 3.4) < 0.06,
    `ugv antenna tips reach the intake's 3.40D (${band(_box.max.y).toFixed(2)}D)`);
  ok(v.size.z > def.wheelbase * 1.7,
    `ugv is long enough for the gun barrel to clear the nose (${v.size.z.toFixed(2)} m)`);

  // The remote weapon station is cosmetic today, but it is kept out of the static merge so the
  // turret follow-up can train it without re-authoring the mesh.
  const turret = v.g.userData.turret;
  ok(!!turret && turret.isObject3D, 'ugv exposes userData.turret');
  ok(turret && turret.children.length > 0, 'ugv turret group survived the merge with geometry in it');
  ok(turret && turret.parent === v.g, 'ugv turret hangs off the craft root so a yaw rotates it');

  // The gun elevates about its trunnion, so the pitching parts hang off their own nested group.
  const elevation = v.g.userData.elevation;
  ok(!!elevation && elevation.isObject3D, 'ugv exposes userData.elevation');
  ok(elevation && elevation.parent === turret, 'the elevation cradle hangs off the turret, so a yaw carries it');
  ok(elevation && elevation.children.length > 0, 'and it kept its own geometry through the merge');

  // The simulation's trunnion and the drawn one are authored separately and must agree, or the
  // station pivots somewhere the muzzle is not. This is the only thing tying them together.
  {
    const pivot = def.turret.pivot;
    elevation.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    elevation.getWorldPosition(world);
    ok(Math.abs(world.y - pivot[1]) < 0.02,
      `drawn trunnion height ${world.y.toFixed(3)} matches the def's pivot ${pivot[1]}`);
    // The mesh points its nose down -Z and the simulation drives +Z forward, so the two z values
    // are negatives of one another. Getting this backwards would mirror the station fore and aft.
    ok(Math.abs(world.z + pivot[2]) < 0.02,
      `drawn trunnion z ${world.z.toFixed(3)} is the negation of the def's ${pivot[2]}, as the -Z nose convention requires`);
  }
}

// Winding: every closed part must enclose positive volume. The hull tub is a hand-rolled loft, and
// its first version was inside-out, which no schema check would have caught.
for (const [kind, def] of Object.entries(BASE_GAME_VEHICLE_DEFS)) {
  const v = inspect(kind, def);
  v.g.traverse((o) => {
    if (!o.geometry) return;
    const p = o.geometry.attributes.position, index = o.geometry.index;
    const count = index ? index.count : p.count;
    let volume = 0;
    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
      const ax = p.getX(ia), ay = p.getY(ia), az = p.getZ(ia);
      const bx = p.getX(ib), by = p.getY(ib), bz = p.getZ(ib);
      const cx = p.getX(ic), cy = p.getY(ic), cz = p.getZ(ic);
      volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    ok(volume > -1e-4, `${kind} part encloses positive volume (${volume.toFixed(4)} m3), so it is not inside-out`);
  });
}

// The DRAWN tyres must sit on the ground the physics fits them to, at any attitude. The dimension
// checks above all run on an unrotated mesh, so none of them noticed that a vehicle was drawn with
// its roll inverted: on a 25% hillside the uphill wheels sank in and the downhill pair hung 0.19 m
// clear, which read as the vehicle floating.
{
  const def = BASE_GAME_VEHICLE_DEFS.ugv;
  const mesh = buildCraftMesh('ugv', 0x8ea2b8, MATERIALS, def);
  const wheels = mesh.userData.wheels;
  const q = new THREE.Quaternion(), local = new THREE.Vector3();
  const axis = new THREE.Vector3(), worldUp = new THREE.Vector3(0, 1, 0);

  // The view's own conversion, so this test fails if that sign is ever changed back.
  const drawnContacts = (rec) => {
    quatFromHeading(q, rec.body.yaw, rec.pitch, -rec.roll);
    return wheels.map((w) => {
      local.copy(w.pivot.position).applyQuaternion(q);
      axis.set(1, 0, 0).applyQuaternion(q);
      const drop = w.radius * Math.sqrt(Math.max(0, 1 - axis.dot(worldUp) ** 2));
      return [rec.body.x + local.x, rec.y + local.y - drop, rec.body.z + local.z];
    });
  };

  for (const [name, grade] of [['flat', 0], ['10% slope', 0.10], ['25% slope', 0.25], ['25% across', -0.25]]) {
    const groundY = (x) => grade * x;
    const rec = createBaseGameVehicle('ugv', { ownerId: 'o', from: [0, 0, 0], yaw: 0, groundY });
    rec.mode = 'parked'; rec.state = 'parked';
    const world = { groundY, ownerPos: [0, 0, 0], ownerYaw: 0, ownerAlive: true, seaLevel: -Infinity };
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      stepBaseGameVehicle(rec, 1 / 120, world);
      for (const c of drawnContacts(rec)) worst = Math.max(worst, Math.abs(c[1] - groundY(c[0])));
    }
    // 0.02 m leaves room for the three-point plane fit's own approximation and nothing else; the
    // inverted roll was ten times that.
    ok(worst < 0.02, `ugv tyres sit on the ground on ${name} (worst gap ${worst.toFixed(3)} m)`);
  }
}

// The drawn front wheels must point INTO the turn. Two sign conventions meet here: the road model
// yaws negative to the right, and a positive rotation.y swings the mesh's -Z nose toward its left.
{
  const def = BASE_GAME_VEHICLE_DEFS.ugv;
  const groundY = () => 0;
  const world = { groundY, ownerPos: [0, 0, 0], ownerYaw: 0, ownerAlive: true, seaLevel: -Infinity };
  const rec = createBaseGameVehicle('ugv', { ownerId: 'o', from: [0, 0, 0], yaw: 0, groundY });
  rec.mode = 'manual';
  rec.input = { throttle: 1, brake: 0, reverse: 0, steer: 1, handbrake: false };   // the driver's right
  const yaw0 = rec.body.yaw;
  for (let i = 0; i < 120; i++) stepBaseGameVehicle(rec, 1 / 120, world);
  ok(rec.body.yaw < yaw0, `steering right yaws the vehicle right (${(rec.body.yaw - yaw0).toFixed(3)} rad)`);

  // The view's own expression, so this fails if that sign is put back.
  const mesh = buildCraftMesh('ugv', 0x8ea2b8, MATERIALS, def);
  const front = mesh.userData.wheels.find(w => w.front);
  front.pivot.rotation.y = rec.body.steering;
  front.pivot.updateMatrixWorld(true);
  const point = new THREE.Vector3(0, 0, -1).applyQuaternion(front.pivot.quaternion);
  ok(point.x > 0.05,
    `and the drawn front wheel points right with it (x ${point.x.toFixed(3)}, +x is the mesh's right)`);
}

// A builder called with no dims (the flight sim's own path) still produces a usable craft.
for (const kind of ['ugv', 'buggy']) {
  const g = buildCraftMesh(kind, 0x8ea2b8, MATERIALS);
  ok((g.userData.wheels ?? []).length === 4, `${kind} built without dims still has four wheels`);
}

console.log(failed ? `\n${failed} assertion(s) failed` : '\nvehicle meshes: all assertions passed');
process.exit(failed ? 1 : 0);
