// test-claudecraft-scale.mjs
import { makeScale } from './claudecraft-bridge/sim-scale.js';
// A workshop player 3.9 units tall maps the 2.6-yard sim humanoid to that height.
const s = makeScale(3.9);
console.assert(Math.abs(s.SCALE - 1.5) < 1e-9, `SCALE should be 1.5, got ${s.SCALE}`);
console.assert(Math.abs(s.toWorld(2) - 3) < 1e-9, 'toWorld(2) should be 3');
console.assert(Math.abs(s.toSim(3) - 2) < 1e-9, 'toSim(3) should be 2');
console.assert(Math.abs(s.toSim(s.toWorld(7.25)) - 7.25) < 1e-9, 'round-trips');
console.log('scale OK');
