// Runs in Node.js. Imports only the pure-logic parts of multiplayer.js.
import { InterpolationBuffer } from './multiplayer.js';

function approx(a, b, tol = 0.001) { return Math.abs(a - b) < tol; }

// Two snapshots: creature moves from x=0 to x=10, hp 1→0.5, over 100 ms
const buf = new InterpolationBuffer();
const stateA = {
  creatures: [{ id: 0, p: [0,0,0], q: [0,0,0,1], hp: 1.0, feet: [], hands: [] }],
  players: [
    { id: 'host', p: [0,1,0], q: [0,0,0,1], h: 1.6, r: 0.35 },
    { id: 'guest-a', p: [10,1,0], q: [0,0,0,1], h: 1.6, r: 0.35 },
  ],
  entities: {
    full: true, since: 0, version: 1,
    upserts: [
      { id: 'light-a', type: 'light', p: [0,2,0], color: [1,0.7,0.3], radius: 30, intensity: 60, lifespan: 10, totalLife: 15, ownerId: 'host' },
      { id: 'projectile-1', type: 'projectile', p: [0,5,0], color: [1,0.7,0.3], radius: 10, intensity: 60, ownerId: 'host', renders: true },
    ],
    removes: [],
  },
};
const stateB = {
  creatures: [{ id: 0, p: [10,0,0], q: [0,0,0,1], hp: 0.5, feet: [], hands: [] }],
  players: [
    { id: 'guest-a', p: [20,1,0], q: [0,0,0,1], h: 0.6, r: 0.35 },
    { id: 'host', p: [0,1,10], q: [0,0,0,1], h: 1.6, r: 0.35 },
    { id: 'guest-b', p: [-5,1,0], q: [0,0,0,1], h: 1.6, r: 0.35 },
  ],
  entities: {
    full: true, since: 0, version: 2,
    upserts: [
      { id: 'light-a', type: 'light', p: [10,2,0], color: [1,0.7,0.3], radius: 20, intensity: 20, lifespan: 8, totalLife: 15, ownerId: 'host' },
      { id: 'light-b', type: 'light', p: [5,2,0], color: [1,0.7,0.3], radius: 10, intensity: 10, lifespan: 5, totalLife: 5, ownerId: 'host', spawnedFrom: 'projectile-1' },
    ],
    removes: [],
  },
};
buf.push(stateA, 1000);
buf.push(stateB, 1100);

// sample at midpoint
const mid = buf.sample(1050);
console.assert(mid !== null, 'FAIL: sample should return state');
console.assert(approx(mid.creatures[0].p[0], 5), `FAIL: lerp x — got ${mid.creatures[0].p[0]}`);
console.assert(approx(mid.creatures[0].hp, 0.75), `FAIL: lerp hp - got ${mid.creatures[0].hp}`);
const midHost = mid.players.find(p => p.id === 'host');
const midGuest = mid.players.find(p => p.id === 'guest-a');
const midNewGuest = mid.players.find(p => p.id === 'guest-b');
console.assert(approx(midHost.p[2], 5), `FAIL: player lerp should match by id - got host z ${midHost.p[2]}`);
console.assert(approx(midGuest.p[0], 15), `FAIL: guest player lerp should match by id - got guest x ${midGuest.p[0]}`);
console.assert(approx(midGuest.h, 1.1), `FAIL: guest player height lerp - got ${midGuest.h}`);
console.assert(midNewGuest && approx(midNewGuest.p[0], -5), 'FAIL: player present only in newer snapshot should be retained');
const midLightA = mid.entities.upserts.find(e => e.id === 'light-a');
const midLightB = mid.entities.upserts.find(e => e.id === 'light-b');
console.assert(approx(midLightA.p[0], 5), `FAIL: entity position lerp — got ${midLightA.p[0]}`);
console.assert(approx(midLightA.radius, 25), `FAIL: entity radius lerp — got ${midLightA.radius}`);
console.assert(approx(midLightA.intensity, 40), `FAIL: entity intensity lerp — got ${midLightA.intensity}`);
console.assert(midLightB && approx(midLightB.p[0], 2.5) && approx(midLightB.p[1], 3.5),
  `FAIL: spawnedFrom entity should lerp from its projectile predecessor — got ${JSON.stringify(midLightB?.p)}`);

// Guard: _lerpState must tolerate a snapshot with no `entities` field (old shape / partial state).
const legacyA = { creatures: stateA.creatures, players: stateA.players };
const legacyB = { creatures: stateB.creatures, players: stateB.players };
const legacyBuf = new InterpolationBuffer();
legacyBuf.push(legacyA, 2000);
legacyBuf.push(legacyB, 2100);
const legacyMid = legacyBuf.sample(2050);
console.assert(legacyMid.entities && Array.isArray(legacyMid.entities.upserts) && legacyMid.entities.upserts.length === 0,
  'FAIL: missing entities field should degrade to an empty upserts array, not throw');

// sample before first snapshot — should return stateA
const before = buf.sample(900);
console.assert(approx(before.creatures[0].p[0], 0), 'FAIL: before range should return first snapshot');

// sample after last snapshot — should return stateB
const after = buf.sample(1200);
console.assert(approx(after.creatures[0].p[0], 10), 'FAIL: after range should return last snapshot');

// empty buffer
const empty = new InterpolationBuffer();
console.assert(empty.sample(1000) === null, 'FAIL: empty buffer should return null');

// ClaudeCraft mobs interpolate like players (matched by id): position lerps, hp lerps,
// tid/dead carry from the newer snapshot. Guests render these; they never run the sim.
{
  const mbuf = new InterpolationBuffer();
  mbuf.push({ mobs: [{ id: 1, tid: 'forest_wolf', p: [0, 0, 0], q: [0, 0, 0, 1], hp: 1, dead: false, s: 2.5 }] }, 1000);
  mbuf.push({ mobs: [{ id: 1, tid: 'forest_wolf', p: [10, 0, 0], q: [0, 0, 0, 1], hp: 0.5, dead: false, s: 2.5 }] }, 1100);
  const s = mbuf.sample(1050);
  console.assert(Array.isArray(s.mobs), 'FAIL: sampled state should carry a mobs array');
  console.assert(approx(s.mobs[0].p[0], 5), 'FAIL: mob x interpolates to 5');
  console.assert(approx(s.mobs[0].hp, 0.75), 'FAIL: mob hp interpolates to 0.75');
  console.assert(s.mobs[0].tid === 'forest_wolf', 'FAIL: mob tid carried');
  console.assert(s.mobs[0].s === 2.5, 'FAIL: mob per-mob scale carried through lerp');
  // A snapshot missing `s` (backward-safe) defaults to 1 through the lerp.
  const mbuf2 = new InterpolationBuffer();
  mbuf2.push({ mobs: [{ id: 2, tid: 'wild_boar', p: [0, 0, 0], q: [0, 0, 0, 1], hp: 1 }] }, 1000);
  mbuf2.push({ mobs: [{ id: 2, tid: 'wild_boar', p: [4, 0, 0], q: [0, 0, 0, 1], hp: 1 }] }, 1100);
  console.assert(mbuf2.sample(1050).mobs[0].s === 1, 'FAIL: absent scale defaults to 1');
  console.log('mob interpolation OK');
}

console.log('InterpolationBuffer tests passed.');
process.exit(0);
