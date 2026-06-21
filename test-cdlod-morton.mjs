import { part1by1, compact1by1, mortonKey, decodeMorton } from './cdlod-select.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

// part1by1/compact1by1 are inverses on 16-bit inputs
ok(compact1by1(part1by1(0)) === 0, 'spread/compact round-trips 0');
ok(compact1by1(part1by1(0xABCD)) === 0xABCD, 'spread/compact round-trips 0xABCD');
ok(compact1by1(part1by1(0xFFFF)) === 0xFFFF, 'spread/compact round-trips 0xFFFF');

// mortonKey round-trips signed cell indices (incl. negatives) and preserves level
for (const [L, ix, iz] of [[0, 0, 0], [3, 5, -3], [6, -100, 250], [2, -1, -1]]) {
  const d = decodeMorton(mortonKey(L, ix, iz));
  ok(d.level === L && d.ix === ix && d.iz === iz, `morton round-trips (${L},${ix},${iz})`);
}

// distinct cells → distinct codes
ok(mortonKey(0, 0, 0).code !== mortonKey(0, 1, 0).code, 'morton codes differ by ix');
ok(mortonKey(0, 0, 0).code !== mortonKey(0, 0, 1).code, 'morton codes differ by iz');

process.exit(fail ? 1 : 0);
