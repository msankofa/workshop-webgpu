// Why 92% of a terrain nav zone came back "mesh blocked" (2026-08-08).
//
// botMeshBlockedAt stands a test capsule at a cell and asks the collision mesh whether anything is in
// the way. map-collision.js's resolveOnce only registers a triangle when it comes within the capsule
// RADIUS, so where the probe is SEATED decides whether accurate ground registers at all. The old probe
// sat 2 cm ABOVE the sampled ground: it touched nothing, `grounded` came back false, and the rule
// `blocked = !grounded || pushedXZ > tol` therefore called every correctly-sampled open cell blocked.
// The measured bake: 65536 cells, 6.6% walkable, 92% rejected here, 89 stranded regions.
//
// three-mesh-bvh (which supplies Triangle.closestPointToSegment) is not installed for Node, so the
// fixtures here are infinite PLANES and the capsule/plane distance is computed directly. That is exact
// for a flat floor, a flat wall face and a flat slope, and those are the three cases the seating
// decision turns on -- it models the placement rule, not the BVH.
let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

const R = 0.3;                 // BOT_NAV_OBSTACLE_RADIUS
const STAND = 1.8;             // BOT_NAV_STAND_HEIGHT
const PUSH_TOL = 0.05;         // BOT_NAV_MESH_PUSH_TOLERANCE
const GROUND_Y = 10;

// Plane as a unit normal + offset: dot(n, p) = d, with n pointing into the walkable side.
const plane = (nx, ny, nz, d) => { const L = Math.hypot(nx, ny, nz); return { n: [nx / L, ny / L, nz / L], d: d / L }; };
const FLOOR = plane(0, 1, 0, GROUND_Y);          // horizontal ground
const WALL = plane(-1, 0, 0, -1);                // vertical face at x = 1, walkable side is x < 1
const SLOPE45 = plane(-1, 1, 0, GROUND_Y);       // 45 degrees, rising toward +x

// Push a vertical capsule segment out of every plane it penetrates, as resolveOnce does.
function resolve(planes, start, end) {
  let p0 = [...start], p1 = [...end], touched = false;
  for (let iter = 0; iter < 4; iter++) {
    let hit = false;
    for (const pl of planes) {
      // The segment is vertical, so the nearer endpoint to the plane is the one with the smaller
      // signed distance; the capsule surface reaches R beyond it.
      const s0 = pl.n[0] * p0[0] + pl.n[1] * p0[1] + pl.n[2] * p0[2] - pl.d;
      const s1 = pl.n[0] * p1[0] + pl.n[1] * p1[1] + pl.n[2] * p1[2] - pl.d;
      const s = Math.min(s0, s1);
      if (s >= R) continue;
      hit = true; touched = true;
      const push = R - s;
      for (let k = 0; k < 3; k++) { p0[k] += pl.n[k] * push; p1[k] += pl.n[k] * push; }
    }
    if (!hit) break;
  }
  return { touched, start: p0 };
}
// `seat` is where the bottom sphere centre sits relative to the sampled ground height.
function probe(planes, x, z, seat) {
  const res = resolve(planes, [x, GROUND_Y + R + seat, z], [x, GROUND_Y + STAND - R, z]);
  return { touched: res.touched, pushedXZ: Math.hypot(res.start[0] - x, res.start[2] - z) };
}

console.log('the old probe: 2 cm above the sampled ground');
const oldFlat = probe([FLOOR], -5, 0, +0.02);
check('it never touches flat ground', !oldFlat.touched);
check('so the old rule (!grounded || pushed) called open ground BLOCKED',
  !oldFlat.touched || oldFlat.pushedXZ > PUSH_TOL,
  'the cells it did pass were the ones where the mesh rose INTO the capsule -- the obstacles');

console.log('\nthe shipped rule: same placement, lateral push is the ONLY signal');
const newFlat = probe([FLOOR], -5, 0, +0.02);
check('flat ground produces no lateral push', newFlat.pushedXZ <= 1e-9,
  `lateral push ${newFlat.pushedXZ.toFixed(6)} m`);
check('so open ground is walkable', !(newFlat.pushedXZ > PUSH_TOL));

console.log('\na wall still blocks');
const atWall = probe([FLOOR, WALL], 0.85, 0, +0.02);   // 0.15 m from the face, inside the radius
check('the capsule is shoved laterally past tolerance', atWall.pushedXZ > PUSH_TOL,
  `lateral push ${atWall.pushedXZ.toFixed(3)} m vs tolerance ${PUSH_TOL}`);

console.log('\nthe steepest slope a bot may stand on does not read as a wall');
// Checked at the REAL limit, not an arbitrary 45 degrees: BOT_TERRAIN_SLOPE_TOLERANCE (0.9 m rise per
// 1.5 m cell) rejects anything steeper than atan(0.6) = 31 degrees before this probe ever runs.
const LIMIT_RAD = Math.atan(0.9 / 1.5);
const limitSlope = plane(-Math.sin(LIMIT_RAD), Math.cos(LIMIT_RAD), 0, GROUND_Y * Math.cos(LIMIT_RAD));
const onSlope = probe([limitSlope], 0, 0, +0.02);
check('lateral push stays under tolerance at the slope limit', onSlope.pushedXZ <= PUSH_TOL,
  `${(LIMIT_RAD * 180 / Math.PI).toFixed(1)} deg -> lateral push ${onSlope.pushedXZ.toFixed(4)} m vs tolerance ${PUSH_TOL}`);
check('with real margin, not a hair', onSlope.pushedXZ <= PUSH_TOL * 0.5,
  `lateral push ${onSlope.pushedXZ.toFixed(4)} m vs half-tolerance ${PUSH_TOL * 0.5}`);

// The falsified attempt, kept as a guard: nobody should re-seat the probe without re-checking slopes.
const seated45 = probe([SLOPE45], 0, 0, -0.03);
check('a 3 cm seat WOULD have failed on a steep face -- which is why the shipped rule does not seat',
  seated45.pushedXZ > PUSH_TOL, `lateral push ${seated45.pushedXZ.toFixed(4)} m`);

console.log(failures ? `\nnav mesh probe: ${failures} FAILED` : '\nnav mesh probe: all checks passed');
process.exit(failures ? 1 : 0);
