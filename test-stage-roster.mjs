// Node checks for the stage module. Run with `node test-stage-roster.mjs`.
//
// The picking tests are the ones that earn their keep. A pick that is slightly wrong selects the creature
// behind the one you clicked, which looks like the UI ignoring you rather than like a geometry bug, so
// the cases here are built with the answer known in advance: rays that hit, rays that miss by a hair,
// rays pointing the wrong way, and two capsules in a line where only the order of the hits distinguishes
// a correct answer from a plausible one.

import { resolveScope, spawnLayout, pickCapsule, aggregateReports, idsToRemove, SCOPES } from './stage-roster.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}`);

const ROSTER = [
  { id: 'a', species: 'rattata' },
  { id: 'b', species: 'rattata' },
  { id: 'c', species: 'paras' },
];

// ===================== scope =====================

check('scope one, species and all reach the right creatures', () => {
  eq(resolveScope(ROSTER, 'one', 'b'), ['b'], 'one');
  eq(resolveScope(ROSTER, 'species', 'b'), ['a', 'b'], 'species');
  eq(resolveScope(ROSTER, 'all', 'b'), ['a', 'b', 'c'], 'all');
  eq(resolveScope(ROSTER, 'species', 'c'), ['c'], 'a species of one');
});

check('no selection reaches nothing, not everything', () => {
  // The failure this prevents: a slider quietly retuning the whole stage because the click that was
  // supposed to select a creature missed, which is invisible until several trials later.
  eq(resolveScope(ROSTER, 'one', null), [], 'one with no selection');
  eq(resolveScope(ROSTER, 'species', 'gone'), [], 'species with a stale id');
  eq(resolveScope(ROSTER, 'all', null), ['a', 'b', 'c'], 'all still means all');
  eq(resolveScope([], 'all', null), [], 'an empty stage');
});

check('scope order follows the roster, not a hash', () => {
  // Apply order has to be reproducible, or a bug that depends on it shows up only sometimes.
  const shuffled = [ROSTER[2], ROSTER[0], ROSTER[1]];
  eq(resolveScope(shuffled, 'all', 'a'), ['c', 'a', 'b'], 'roster order');
});

check('every declared scope is handled', () => {
  for (const s of SCOPES) {
    assert(Array.isArray(resolveScope(ROSTER, s, 'a')), `scope ${s} did not return a list`);
  }
});

// ===================== layout =====================

check('one creature stands at the origin, several stand apart', () => {
  eq(spawnLayout(0, 1, 2), { x: 0, z: 0, yaw: 0 }, 'a stage of one');
  const n = 6, spacing = 1.5;
  const pts = Array.from({ length: n }, (_, i) => spawnLayout(i, n, spacing));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
      assert(d > spacing * 0.9, `creatures ${i} and ${j} are ${d.toFixed(2)} apart, closer than the spacing`);
    }
  }
});

check('the ring grows with the count instead of crowding', () => {
  const r = (n) => Math.hypot(spawnLayout(0, n, 1).x, spawnLayout(0, n, 1).z);
  assert(r(12) > r(4), 'twelve creatures should stand on a wider ring than four');
});

// ===================== picking =====================

// A capsule standing on the origin, half a metre tall, 20 cm across.
const CAP = { id: 'a', ax: 0, ay: 0, az: 0, bx: 0, by: 0.5, bz: 0, radius: 0.2 };

check('a ray through a capsule picks it', () => {
  assert(pickCapsule({ x: -3, y: 0.25, z: 0 }, { x: 1, y: 0, z: 0 }, [CAP]) === 'a', 'a dead-centre hit missed');
});

check('a ray that misses by a hair picks nothing', () => {
  // 0.19 clears the 0.2 radius, 0.21 does not. Two cases either side of the surface, because a picker
  // that always hits is as useless as one that never does.
  assert(pickCapsule({ x: -3, y: 0.25, z: 0.19 }, { x: 1, y: 0, z: 0 }, [CAP]) === 'a', 'a grazing hit was missed');
  assert(pickCapsule({ x: -3, y: 0.25, z: 0.21 }, { x: 1, y: 0, z: 0 }, [CAP]) === null, 'a miss was picked');
});

check('the capsule ends where it says it ends', () => {
  // Above the top cap by more than the radius: a miss. The clamp on the segment parameter is what makes
  // this a capsule rather than an infinite cylinder, and getting it wrong is silent.
  assert(pickCapsule({ x: -3, y: 0.9, z: 0 }, { x: 1, y: 0, z: 0 }, [CAP]) === null, 'picked well above the head');
  assert(pickCapsule({ x: -3, y: 0.65, z: 0 }, { x: 1, y: 0, z: 0 }, [CAP]) === 'a', 'the round cap was missed');
  assert(pickCapsule({ x: -3, y: -0.15, z: 0 }, { x: 1, y: 0, z: 0 }, [CAP]) === 'a', 'the bottom cap was missed');
});

check('a ray pointing away picks nothing', () => {
  assert(pickCapsule({ x: -3, y: 0.25, z: 0 }, { x: -1, y: 0, z: 0 }, [CAP]) === null, 'picked something behind the camera');
});

check('the nearest of two in a line wins', () => {
  // The case that separates a correct picker from a plausible one: both are hit, and only distance along
  // the ray decides. Reversing the list must not change the answer.
  const near = { ...CAP, id: 'near', ax: -1, bx: -1, az: 0, bz: 0 };
  const far = { ...CAP, id: 'far', ax: 1, bx: 1 };
  assert(pickCapsule({ x: -3, y: 0.25, z: 0 }, { x: 1, y: 0, z: 0 }, [near, far]) === 'near', 'took the far one');
  assert(pickCapsule({ x: -3, y: 0.25, z: 0 }, { x: 1, y: 0, z: 0 }, [far, near]) === 'near', 'list order changed the answer');
});

check('an unnormalised direction works the same', () => {
  const a = pickCapsule({ x: -3, y: 0.25, z: 0 }, { x: 1, y: 0, z: 0 }, [CAP]);
  const b = pickCapsule({ x: -3, y: 0.25, z: 0 }, { x: 17, y: 0, z: 0 }, [CAP]);
  assert(a === b && a === 'a', 'a longer direction vector changed the answer');
});

check('picking survives nothing to pick', () => {
  assert(pickCapsule({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, []) === null, 'an empty stage');
  assert(pickCapsule({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, [CAP]) === null, 'a zero-length ray');
});

// ===================== the group view =====================

const rep = (skate, clamped, dragging, tapping = false) => ({
  verdict: { dragging, tapping },
  dragging: { worstLegFraction: skate, clampedFraction: clamped },
});

check('the group counts creatures rather than averaging their metrics', () => {
  const g = aggregateReports([
    { id: 'a', species: 'rattata', label: 'A', report: rep(0.3, 0.0, true) },
    { id: 'b', species: 'rattata', label: 'B', report: rep(0.01, 0.0, false) },
    { id: 'c', species: 'paras', label: 'C', report: null },
  ]);
  assert(g.count === 3 && g.dragging === 1 && g.clean === 1 && g.measuring === 1,
    `bad counts: ${JSON.stringify({ c: g.count, d: g.dragging, cl: g.clean, m: g.measuring })}`);
  // The point of the whole module: no field anywhere is a mean of a per-creature metric.
  for (const k of Object.keys(g)) assert(!/^(mean|avg|average)/i.test(k), `${k} looks like an average`);
});

check('a creature still measuring is not counted as clean', () => {
  const g = aggregateReports([{ id: 'a', species: 's', label: 'A', report: null }]);
  assert(g.measuring === 1 && g.clean === 0, 'an unmeasured creature was reported as clean');
});

check('the worst offender sorts to the top and is selectable', () => {
  const g = aggregateReports([
    { id: 'mild', species: 's', label: 'M', report: rep(0.11, 0.0, true) },
    { id: 'awful', species: 's', label: 'A', report: rep(0.40, 0.30, true) },
    { id: 'fine', species: 's', label: 'F', report: rep(0.00, 0.0, false) },
  ]);
  eq(g.worst.map(w => w.id), ['awful', 'mild', 'fine'], 'worst order');
  assert(g.worst[0].label === 'A', 'the row carries a label to click');
});

check('prediction and measurement are kept in separate lists', () => {
  // A creature with no window yet still has a predicted risk, and that must never be presented as
  // something that was observed.
  const g = aggregateReports([
    { id: 'a', species: 's', label: 'A', report: null, headroom: { dragRisk: 0.9, tapRisk: 0.1, worst: { id: 'overrun' } } },
    { id: 'b', species: 's', label: 'B', report: rep(0.0, 0.0, false), headroom: { dragRisk: 0.1, tapRisk: 0, worst: { id: 'restep' } } },
  ]);
  assert(g.worst.length === 1, 'an unmeasured creature leaked into the measured list');
  assert(g.riskiest.length === 2 && g.riskiest[0].id === 'a', 'the prediction list is wrong');
  assert(g.riskiest[0].cause === 'overrun', 'the predicted cause was dropped');
});

check('species are broken out, biggest group first', () => {
  const g = aggregateReports([
    { id: 'a', species: 'rattata', label: 'A', report: rep(0.3, 0, true) },
    { id: 'b', species: 'rattata', label: 'B', report: rep(0, 0, false) },
    { id: 'c', species: 'paras', label: 'C', report: rep(0, 0, false) },
  ]);
  eq(g.bySpecies.map(s => [s.species, s.count, s.dragging]), [['rattata', 2, 1], ['paras', 1, 0]], 'by species');
});

check('an empty stage aggregates to zeroes rather than throwing', () => {
  const g = aggregateReports([]);
  assert(g.count === 0 && g.worst.length === 0 && g.bySpecies.length === 0, 'empty stage');
});

check('idsToRemove names what a respawn replaced', () => {
  eq(idsToRemove(ROSTER, ['a', 'c']), ['b'], 'removal set');
  eq(idsToRemove(ROSTER, []), ['a', 'b', 'c'], 'keeping nothing');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
