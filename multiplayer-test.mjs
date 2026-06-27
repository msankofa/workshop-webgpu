// Runs in Node.js. Imports only the pure-logic parts of multiplayer.js.
import { InterpolationBuffer } from './multiplayer.js';

function approx(a, b, tol = 0.001) { return Math.abs(a - b) < tol; }

// Two snapshots: creature moves from x=0 to x=10, hp 1→0.5, over 100 ms
const buf = new InterpolationBuffer();
const stateA = { creatures: [{ id: 0, p: [0,0,0], q: [0,0,0,1], hp: 1.0, feet: [], hands: [] }], players: [] };
const stateB = { creatures: [{ id: 0, p: [10,0,0], q: [0,0,0,1], hp: 0.5, feet: [], hands: [] }], players: [] };
buf.push(stateA, 1000);
buf.push(stateB, 1100);

// sample at midpoint
const mid = buf.sample(1050);
console.assert(mid !== null, 'FAIL: sample should return state');
console.assert(approx(mid.creatures[0].p[0], 5), `FAIL: lerp x — got ${mid.creatures[0].p[0]}`);
console.assert(approx(mid.creatures[0].hp, 0.75), `FAIL: lerp hp — got ${mid.creatures[0].hp}`);

// sample before first snapshot — should return stateA
const before = buf.sample(900);
console.assert(approx(before.creatures[0].p[0], 0), 'FAIL: before range should return first snapshot');

// sample after last snapshot — should return stateB
const after = buf.sample(1200);
console.assert(approx(after.creatures[0].p[0], 10), 'FAIL: after range should return last snapshot');

// empty buffer
const empty = new InterpolationBuffer();
console.assert(empty.sample(1000) === null, 'FAIL: empty buffer should return null');

console.log('InterpolationBuffer tests passed.');
process.exit(0);
