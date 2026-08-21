// Node checks for the eight non-legged movement solvers and the body trail.

import { createMover, MOVER_STYLES, MOVER_TUNING, Trail } from './park-movement.js';

let pass = 0, fail = 0;
const problems = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// A rolling ground and a flat lake surface at y = 0, so "did it follow the ground" is answerable.
const ground = (x, z) => 3 + 2 * Math.sin(x * 0.06) * Math.cos(z * 0.05);
const flat = () => 0;

// ===================== the trail =====================

{
  const t = new Trail(4, 0.1);
  t.reset(0, 0, 0);
  for (let i = 1; i <= 200; i++) t.advance(i * 0.05, 0, 0);
  const head = t.sample(0);
  check('the trail head is where the body is', Math.abs(head.x - 10) < 0.2, `head at ${head.x.toFixed(2)}`);
  const back = t.sample(2);
  check('two metres back is two metres back', Math.abs(back.x - 8) < 0.25, `got ${back.x.toFixed(2)}`);
}

{
  // Indexing by frame instead of by distance is the bug this guards
  const t = new Trail(4, 0.1);
  t.reset(0, 0, 0);
  for (let i = 1; i <= 100; i++) t.advance(i * 0.05, 0, 0);
  const before = t.sample(2).x;
  for (let i = 0; i < 500; i++) t.advance(5, 0, 0);   // standing still for 500 frames
  check('a stopped body does not eat its own tail', Math.abs(t.sample(2).x - before) < 0.2,
    `${before.toFixed(2)} -> ${t.sample(2).x.toFixed(2)}`);
}

{
  // One long frame must lay the same track as many short ones, or a hitch kinks the body.
  const a = new Trail(4, 0.1); a.reset(0, 0, 0);
  const b = new Trail(4, 0.1); b.reset(0, 0, 0);
  for (let i = 1; i <= 100; i++) a.advance(i * 0.05, 0, 0);
  b.advance(5, 0, 0);
  check('one long step lays the same track as many short ones',
    Math.abs(a.sample(1).x - b.sample(1).x) < 0.2,
    `${a.sample(1).x.toFixed(2)} vs ${b.sample(1).x.toFixed(2)}`);
}

// ===================== every style =====================

check('every style has tuning', MOVER_STYLES.every((s) => MOVER_TUNING[s]));

for (const style of MOVER_STYLES) {
  const isSwim = style === 'swim';
  const m = createMover({
    style, heightM: 1.2, terrainHeight: isSwim ? () => -6 : ground,
    waterLevel: 0, roamRadius: 40, rng: seeded(9),
  });
  m.placeAt(10, -4, 0.5);

  let finite = true, escaped = false, underground = 0;
  const start = { x: m.body.x, z: m.body.z };
  for (let i = 0; i < 3600; i++) {
    m.step(1 / 60);
    const b = m.body;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z) ||
        !Number.isFinite(b.yaw) || !Number.isFinite(b.pitch) || !Number.isFinite(b.roll)) { finite = false; break; }
    if (Math.hypot(b.x - start.x, b.z - start.z) > 200) { escaped = true; break; }
    if (style !== 'burrow' && style !== 'swim' && b.y < ground(b.x, b.z) - 0.6) underground++;
  }
  check(`${style}: stays finite for a minute`, finite);
  check(`${style}: stays near home`, !escaped);
  check(`${style}: does not sink through the ground`, underground === 0, `${underground} frames below`);
}

// ===================== per-style behaviour =====================

{
  // A swimmer that walks up the beach is the most visible failure a lake can have.
  const depth = (x) => (x < 0 ? -8 : 4);          // water to the west, land to the east
  const m = createMover({ style: 'swim', heightM: 1, terrainHeight: (x) => depth(x), waterLevel: 0, roamRadius: 60, rng: seeded(3) });
  m.placeAt(-30, 0, 0);
  let beached = 0;
  for (let i = 0; i < 6000; i++) {
    m.step(1 / 60);
    m.setTarget(60, 0);                            // aim it straight at the shore, every frame
    if (depth(m.body.x) > -1) beached++;
  }
  check('a swimmer refuses to leave the water', beached === 0, `${beached} frames aground`);
  check('and rides the surface', Math.abs(m.body.y) < 0.4, `y = ${m.body.y.toFixed(2)}`);
}

{
  // A roller that skates reads as a sliding prop. Angle covered must equal distance over radius.
  const m = createMover({ style: 'roll', heightM: 1, terrainHeight: flat, roamRadius: 500, rng: seeded(5) });
  m.placeAt(0, 0, 0);
  let dist = 0, spin = 0, px = 0, pz = 0;
  let prev = m.extra.spin;
  for (let i = 0; i < 1200; i++) {
    m.setTarget(0, 4000);
    m.step(1 / 60);
    dist += Math.hypot(m.body.x - px, m.body.z - pz);
    px = m.body.x; pz = m.body.z;
    let d = m.extra.spin - prev;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    spin += d; prev = m.extra.spin;
  }
  const expected = dist / 0.5;
  check('a roller rolls rather than skates', Math.abs(spin - expected) / Math.max(expected, 1e-6) < 0.02,
    `turned ${spin.toFixed(2)} rad over ${dist.toFixed(2)} m, expected ${expected.toFixed(2)}`);
}

{
  const m = createMover({ style: 'hop', heightM: 1, terrainHeight: flat, roamRadius: 200, rng: seeded(2) });
  m.placeAt(0, 0, 0);
  let air = 0, maxY = 0, squashSeen = false;
  for (let i = 0; i < 1800; i++) {
    m.setTarget(0, 300);
    m.step(1 / 60);
    if (m.extra.airborne) air++;
    maxY = Math.max(maxY, m.body.y);
    if (m.extra.squash < 0.95) squashSeen = true;
  }
  check('a hopper leaves the ground', air > 200, `${air} airborne frames of 1800`);
  check('and comes back down', maxY > 0.2 && maxY < 1.2, `peak ${maxY.toFixed(2)} m`);
  check('and squashes on the ground', squashSeen);
}

{
  const m = createMover({ style: 'burrow', heightM: 0.7, terrainHeight: flat, roamRadius: 200, rng: seeded(4) });
  m.placeAt(0, 0, 0);
  let under = 0, over = 0;
  for (let i = 0; i < 3600; i++) { m.step(1 / 60); if (m.extra.submerged > 0.5) under++; else if (m.extra.submerged < 0.1) over++; }
  check('a burrower spends time under the soil', under > 300, `${under} frames submerged`);
  check('and surfaces to look around', over > 300, `${over} frames surfaced`);
}

{
  const m = createMover({ style: 'static', heightM: 0.7, terrainHeight: ground, rng: seeded(6) });
  m.placeAt(4, 4, 0);
  const x0 = m.body.x, z0 = m.body.z;
  let moved = 0, rolled = 0;
  for (let i = 0; i < 1800; i++) {
    m.step(1 / 60);
    moved = Math.max(moved, Math.hypot(m.body.x - x0, m.body.z - z0));
    rolled = Math.max(rolled, Math.abs(m.body.roll));
  }
  check('a sessile creature stays put', moved < 1e-6, `drifted ${moved.toFixed(4)} m`);
  check('but is not frozen', rolled > 0.005, `max roll ${rolled.toFixed(4)}`);
}

{
  const m = createMover({ style: 'fly', heightM: 1.5, terrainHeight: ground, roamRadius: 120, rng: seeded(8) });
  m.placeAt(0, 0, 0);
  let minClear = Infinity, banked = 0;
  for (let i = 0; i < 3600; i++) {
    m.step(1 / 60);
    minClear = Math.min(minClear, m.body.y - ground(m.body.x, m.body.z));
    banked = Math.max(banked, Math.abs(m.body.roll));
  }
  check('a flier clears the ground it crosses', minClear > 1.5, `closest ${minClear.toFixed(2)} m`);
  check('and banks into its turns', banked > 0.05, `max roll ${banked.toFixed(3)}`);
}

{
  const m = createMover({ style: 'slither', heightM: 1, lengthM: 6, terrainHeight: ground, roamRadius: 90, rng: seeded(1) });
  m.placeAt(0, 0, 0);
  for (let i = 0; i < 1800; i++) m.step(1 / 60);
  const head = m.spineAt(0), tail = m.spineAt(5);
  check('a slitherer has a body behind its head', head && tail);
  check('and the tail is behind, not on top of, the head',
    Math.hypot(head.x - tail.x, head.z - tail.z) > 1.5,
    `separation ${Math.hypot(head.x - tail.x, head.z - tail.z).toFixed(2)} m`);
  check('a style with no body reports none', createMover({ style: 'hover', terrainHeight: flat }).spineAt(1) === null);
}

{
  // Size is expressed in body heights, so two sizes of the same animal move like the same animal.
  const small = createMover({ style: 'hover', heightM: 0.5, terrainHeight: flat, roamRadius: 1e5, rng: seeded(11) });
  const big = createMover({ style: 'hover', heightM: 2.0, terrainHeight: flat, roamRadius: 1e5, rng: seeded(11) });
  small.placeAt(0, 0, 0); big.placeAt(0, 0, 0);
  for (let i = 0; i < 600; i++) { small.setTarget(0, 1e4); big.setTarget(0, 1e4); small.step(1 / 60); big.step(1 / 60); }
  check('a body four times the height travels four times as far',
    Math.abs(big.body.z / Math.max(small.body.z, 1e-6) - 4) < 0.15,
    `ratio ${(big.body.z / small.body.z).toFixed(2)}`);
  check('and rides four times as high', Math.abs(big.body.y / Math.max(small.body.y, 1e-6) - 4) < 0.25);
}

{
  let threw = false;
  try { createMover({ style: 'quad' }); } catch { threw = true; }
  check('a legged style is refused — the walker owns those', threw);
}

{
  const a = createMover({ style: 'hover', heightM: 1, terrainHeight: ground, rng: seeded(42) });
  const b = createMover({ style: 'hover', heightM: 1, terrainHeight: ground, rng: seeded(42) });
  a.placeAt(3, 3, 0); b.placeAt(3, 3, 0);
  for (let i = 0; i < 900; i++) { a.step(1 / 60); b.step(1 / 60); }
  check('the same seed wanders the same way',
    Math.abs(a.body.x - b.body.x) < 1e-9 && Math.abs(a.body.z - b.body.z) < 1e-9);
}

{
  // Roaming is around HOME, not around the world origin
  const m = createMover({ style: 'hover', heightM: 1, terrainHeight: flat, roamRadius: 20, rng: seeded(13) });
  m.placeAt(400, -300, 0);
  let maxFromHome = 0;
  for (let i = 0; i < 7200; i++) { m.step(1 / 60); maxFromHome = Math.max(maxFromHome, Math.hypot(m.body.x - 400, m.body.z + 300)); }
  check('a creature roams around its own home', maxFromHome < 40, `strayed ${maxFromHome.toFixed(1)} m`);
}

{
  const m = createMover({ style: 'hover', heightM: 1, terrainHeight: flat, roamRadius: 60, rng: seeded(21) });
  m.placeAt(0, 0, 0);
  for (let i = 0; i < 600; i++) m.step(1 / 60);
  const moving = Math.hypot(m.body.x, m.body.z);
  for (let i = 0; i < 600; i++) m.step(1 / 60, { walk: false });
  check('walk:false brings a creature to rest', m.speed < 0.02, `still at ${m.speed.toFixed(3)} m/s`);
  check('and it had been moving before', moving > 1);
}

console.log(`\npark movement: ${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
