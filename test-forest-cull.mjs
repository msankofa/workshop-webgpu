import { cullInstance } from './forest-cull.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// Camera at origin; camera-centered distance cull (v1, distance-only per SP2).
const cam = { x: 0, z: 0 };
const maxDist = 100;

ok(cullInstance({ x: 0, z: -20 }, cam, maxDist) === true,  '2: in range kept');
ok(cullInstance({ x: 0, z: -200 }, cam, maxDist) === false, '2: beyond maxDist culled');
ok(cullInstance({ x: 80, z: -80 }, cam, maxDist) === false, '2: diagonal beyond radius culled');
ok(cullInstance({ x: 60, z: -60 }, cam, maxDist) === true,  '2: diagonal within radius kept');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
