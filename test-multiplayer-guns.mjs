// Runs in Node.js. Verifies multiplayer player interpolation carries the gun
// combat fields added in Milestone M3.
import { InterpolationBuffer } from './multiplayer.js';

let failed = false;
function assert(cond, msg) { if (!cond) { failed = true; console.error('FAIL:', msg); } }
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

const baseState = player => ({
  creatures: [],
  entities: { full: true, since: 0, version: 0, upserts: [], removes: [] },
  worldMode: 'shared',
  players: [player],
});

const buf = new InterpolationBuffer();
buf.push(baseState({
  id: 'guest-1',
  p: [0, 1, 0],
  q: [0, 0, 0, 1],
  h: 1.6,
  r: 0.35,
  hp: 100,
  maxHp: 100,
  alive: true,
  weapon: 'm1911',
  tool: 'm1911',
  ammoMag: 7,
  ammoReserve: 35,
  magazineSize: 7,
  firing: false,
  fireSeq: 1,
  lastShotAt: 100,
}), 0);
buf.push(baseState({
  id: 'guest-1',
  p: [10, 1, 0],
  q: [0, 0, 0, 1],
  h: 1.8,
  r: 0.4,
  hp: 40,
  maxHp: 100,
  alive: false,
  weapon: 'm24',
  tool: 'm24',
  ammoMag: 4,
  ammoReserve: 20,
  magazineSize: 5,
  firing: true,
  fireSeq: 2,
  lastShotAt: 200,
}), 100);

const mid = buf.sample(50);
const p = mid.players[0];

assert(near(p.p[0], 5), `position should interpolate, got ${p.p[0]}`);
assert(near(p.h, 1.7), `height should interpolate, got ${p.h}`);
assert(near(p.r, 0.375), `radius should interpolate, got ${p.r}`);
assert(near(p.hp, 70), `hp should interpolate, got ${p.hp}`);
assert(p.maxHp === 100, `maxHp should pass through from newer snapshot, got ${p.maxHp}`);
assert(p.alive === false, `alive should pass through from newer snapshot, got ${p.alive}`);
assert(p.weapon === 'm24', `weapon should pass through from newer snapshot, got ${p.weapon}`);
assert(p.firing === true, `firing should pass through from newer snapshot, got ${p.firing}`);
assert(p.fireSeq === 2, `fireSeq should pass through from newer snapshot, got ${p.fireSeq}`);
assert(p.lastShotAt === 200, `lastShotAt should pass through from newer snapshot, got ${p.lastShotAt}`);

if (failed) { console.error('multiplayer gun interpolation tests FAILED.'); process.exit(1); }
console.log('Multiplayer gun interpolation tests passed.');