// node test-model-spec.mjs
//
// Covers the ModelSpec gates (model-spec.js) against both targets that exist.
//
// The reason `creature` is in here from the start: a bot's anchors come from a constant, so every
// assertion against it is also consistent with a spec that has a nine-anchor list hard-coded
// somewhere. A creature's anchors are computed from its plan and change with leg and segment count,
// so it is the only one of the two that can catch that.

import * as THREE from 'three';
import { validateSpec, measureSpec, topologyConflict, defineTarget, instanceCount, TOPOLOGY_CLASSES, LEVELS } from './model-spec.js';
import { botTarget, BOT_ANCHORS } from './model-targets/bot.js';
import { createCreatureTarget } from './model-targets/creature.js';
import { createCreaturePlans, anchorsForPlan } from './creature-plan.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('PASS: ' + name); }
  else { failed++; console.log('FAIL: ' + name); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${a}, want ${b})`); }
const has = (r, gate, code) => r.errors.some((e) => e.gate === gate && (!code || e.code === code));

const plans = createCreaturePlans({ THREE });
const seeded = (s) => { let t = s >>> 0; return () => { t = (t * 1664525 + 1013904223) >>> 0; return t / 4294967296; }; };

const comp = (over = {}) => ({
  id: 'c1', parent: 'torso', primitive: 'rbox', size: [0.1, 0.1, 0.04],
  material: 'plate', topologyClass: 'assembled-solid', level: 'meso',
  transform: { position: [0, 0, 0] }, ...over,
});
const spec = (components, target = 'bot') => ({ id: 's', name: 'test', target, components });

// ---- gate 1: legality ----
{
  const good = spec([comp()]);
  ok(validateSpec(good, botTarget, { THREE }).ok, 'a legal one-piece spec passes every gate');

  ok(has(validateSpec(spec([]), botTarget), 'legality', 'empty'), 'an empty spec is rejected');
  ok(has(validateSpec(spec([comp({ primitive: 'tube' })]), botTarget), 'legality', 'primitive'),
    'a primitive the target does not render is rejected, even though the factory can build it');
  ok(has(validateSpec(spec([comp({ material: 'chrome' })]), botTarget), 'legality', 'role'),
    'a role the target does not have is rejected');
  ok(has(validateSpec(spec([comp({ parent: 'tail' })]), botTarget), 'legality', 'parent'),
    'an anchor the target does not have is rejected');
  ok(has(validateSpec(spec([comp({ id: 'a' }), comp({ id: 'a' })]), botTarget), 'legality', 'duplicate-id'),
    'two components cannot share an id');
  ok(has(validateSpec(spec([comp({ topologyClass: 'blob' })]), botTarget), 'legality', 'topology-class'),
    'an unknown topology class is rejected');
  ok(has(validateSpec(spec([comp({ level: 'huge' })]), botTarget), 'legality', 'level'), 'an unknown level is rejected');
  ok(has(validateSpec(spec([comp({ modifiers: [{ op: 'melt' }] })]), botTarget), 'legality', 'modifier'),
    'an unknown modifier op is rejected');
  ok(has(validateSpec(spec([comp({ csg: [{ op: 'carve', shape: { type: 'sphere' } }] })]), botTarget), 'legality', 'csg'),
    'an unknown CSG op is rejected');

  // A component parented to another component is normal; a loop is not, and it would hang the
  // transform walk in the penetration gate, so it has to be caught before anything else runs.
  ok(validateSpec(spec([comp({ id: 'a' }), comp({ id: 'b', parent: 'a' })]), botTarget, { THREE }).ok,
    'a component may parent to another component');
  const cyc = validateSpec(spec([comp({ id: 'a', parent: 'b' }), comp({ id: 'b', parent: 'a' })]), botTarget, { THREE });
  ok(has(cyc, 'legality', 'cycle'), 'a parent cycle is caught');
  ok(cyc.skipped.includes('penetration'), 'and the gates that would walk that chain are skipped, not run');

  ok(has(validateSpec(spec([comp()], 'prop'), botTarget), 'legality', 'target-mismatch'),
    'a spec validated against the wrong target says so');
}

// ---- gate 3: topology vs primitive ----
{
  ok(!topologyConflict(comp({ topologyClass: 'assembled-solid' })), 'armour as an assembled-solid is fine');

  // The rule img2threejs has, adapted: they ban the primitive outright, we allow it once a shaping
  // modifier is on it, because we have a modifier layer and they do not.
  ok(topologyConflict(comp({ topologyClass: 'continuous-sculpt', primitive: 'cylinder' })),
    'a bare cylinder cannot be a continuous-sculpt');
  ok(!topologyConflict(comp({ topologyClass: 'continuous-sculpt', primitive: 'cylinder', modifiers: [{ op: 'taper', end: 0.4 }] })),
    'the same cylinder with a taper can be, which is what the modifier layer bought');
  ok(!topologyConflict(comp({ topologyClass: 'continuous-sculpt', primitive: 'sphere' })),
    'a curved primitive needs no modifier to be a sculpt');
  ok(topologyConflict(comp({ topologyClass: 'continuous-sculpt', primitive: 'cylinder', modifiers: [{ op: 'displace', amount: 0 }] }))
    === null, 'displace counts as shaping');

  ok(topologyConflict(comp({ topologyClass: 'fiber-strand', primitive: 'rbox' })),
    'a cable made of boxes is the flat-projection failure this gate exists for');
  ok(!topologyConflict(comp({ topologyClass: 'fiber-strand', primitive: 'tube' })), 'a tube is a legal strand');

  ok(topologyConflict(comp({ topologyClass: 'material-only' })), 'material-only must not carry a primitive');
  ok(!topologyConflict({ ...comp(), primitive: null, topologyClass: 'material-only' }), 'material-only with no primitive is fine');

  ok(topologyConflict(comp({ topologyClass: 'open-shell', primitive: 'sphere' })), 'a closed solid is not an open-shell');
  ok(!topologyConflict(comp({ topologyClass: 'open-shell', primitive: 'tube', geometry: { cap: false } })),
    'an uncapped tube is');
  eq(TOPOLOGY_CLASSES.length, 7, 'seven topology classes are declared');
  eq(LEVELS.length, 3, 'three levels are declared');
}

// ---- gate 2: budget ----
{
  const plate = (i) => comp({ id: 'p' + i, size: [0.1 + i * 0.01, 0.1, 0.04], transform: { position: [i * 0.5, 0, 0] } });
  const m = measureSpec(spec([plate(0), plate(1)]), botTarget, { THREE });
  // Two distinct sizes plus their two rbox LOD twins.
  eq(m.geometries, 4, 'two distinct rbox pieces cost four cache entries, counting the LOD twins');
  eq(m.triangles, 828 * 2, 'triangles are the full-detail sum');
  eq(m.trianglesLod, 156 * 2, 'and the LOD sum uses the twin');

  // Identical descriptors collapse, which is the whole reason the cache key is the cost model.
  const same = measureSpec(spec([plate(0), { ...plate(0), id: 'p9' }]), botTarget, { THREE });
  eq(same.geometries, 2, 'two identical pieces cost one geometry and its twin');
  eq(same.triangles, 828 * 2, 'but still draw twice');

  // Mirroring and repetition buy instances for free in geometry terms. That is what makes authored
  // repetition a spec feature rather than a primitive.
  const rep = measureSpec(spec([plate(0), { ...plate(0), id: 'p8', mirror: true, repeat: { count: 6 } }]), botTarget, { THREE });
  eq(rep.geometries, 2, 'mirror and repeat cost no extra geometries');
  eq(rep.instances, 13, 'but they do cost instances');
  eq(rep.triangles, 828 * 13, 'and triangles');
  eq(instanceCount(comp({ mirror: true, repeat: { count: 3 } })), 6, 'instanceCount multiplies mirror by repeat');

  const tight = defineTarget({ ...botTarget, key: 'bot', budget: { geometries: 1, triangles: 10 } });
  const over = validateSpec(spec([plate(0), plate(1)]), tight, { THREE });
  ok(has(over, 'budget', 'geometries') && has(over, 'budget', 'triangles'), 'a spec over budget fails both counts');

  // A gate that did not run must never look like a gate that passed.
  const noThree = validateSpec(spec([plate(0)]), botTarget);
  ok(noThree.skipped.includes('budget') && noThree.measured === null, 'without THREE the budget gate is skipped, loudly');
}

// ---- gate 4: overlap (advisory) and duplicates (an error) ----
//
// This gate was built assuming a piece inside another is a defect. It is not: run against the
// shipped bot design it fired on 91 of 761 same-anchor pairs, and the ones inspected were all
// correct work — detail laid on plate is the design language. A box is not the shape, so overlap
// cannot separate buried from layered. It is reported for a person to scan; only exact duplicates
// are errors. See test-model-targets.mjs, which is where the measurement came from.
{
  const a = comp({ id: 'a', size: [0.2, 0.2, 0.2], transform: { position: [0, 0, 0] } });
  const near = comp({ id: 'b', size: [0.2, 0.2, 0.2], transform: { position: [0.19, 0, 0] } });
  const inside = comp({ id: 'b', size: [0.2, 0.2, 0.2], transform: { position: [0.02, 0, 0] } });
  const warned = (r) => r.warnings.some((w) => w.gate === 'penetration' && w.code === 'overlap');

  const touch = validateSpec(spec([a, near]), botTarget, { THREE });
  ok(touch.ok && !warned(touch), 'pieces that merely touch raise nothing — plates legitimately abut');

  const buried = validateSpec(spec([a, inside]), botTarget, { THREE });
  ok(warned(buried), 'a piece deep inside another is reported');
  ok(buried.ok, 'but as a warning, because it might be a detail sitting on a shell');

  // A child is MEANT to overlap its parent, so that pair is never reported at all.
  ok(!warned(validateSpec(spec([a, { ...inside, parent: 'a' }]), botTarget, { THREE })),
    'a child overlapping its parent is not reported');

  // The one thing with no innocent reading: the same geometry at the same pose on the same anchor.
  const dup = validateSpec(spec([a, { ...a, id: 'b' }]), botTarget, { THREE });
  ok(has(dup, 'penetration', 'duplicate'), 'an exact duplicate piece is an error');
  ok(!dup.ok, 'and fails the spec');
  ok(validateSpec(spec([a, { ...a, id: 'b', transform: { position: [1, 0, 0] } }]), botTarget, { THREE }).ok,
    'the same geometry somewhere else is fine — that is what instancing is for');

  // Two pieces on different anchors have no known relative pose. Reporting them would be inventing
  // data, so they are counted as unchecked instead.
  const cross = validateSpec(spec([a, { ...inside, parent: 'head' }]), botTarget, { THREE });
  ok(!warned(cross), 'pieces on different anchors are not compared');
  eq(cross.penetration.unchecked, 1, 'and the spec says how many pairs it could not judge');

  // Ranked, so the worst offender is first when there are dozens.
  const many = validateSpec(spec([a, inside, comp({ id: 'c', size: [0.2, 0.2, 0.2], transform: { position: [0.13, 0, 0] } })]), botTarget, { THREE });
  const shares = many.penetration.hits.map((h) => h.share);
  ok(shares.every((s, i) => i === 0 || shares[i - 1] >= s), 'overlaps come back ranked worst first');
}

// ---- the creature target: anchors that are computed, not declared ----
{
  const quad = plans.BODY_PLANS.quadbot;
  const t4 = createCreatureTarget(quad);
  // quadbot: 4 legs x 3 segments. A 3-segment chain has 4 points, so 2 interior joints:
  // body + head + 4 x (hip + j1 + j2 + foot).
  eq(t4.anchors.length, 2 + 4 * 4, 'quadbot derives 18 anchors from its plan');
  ok(t4.anchors.includes('leg0L.foot') && t4.anchors.includes('leg1R.hip'), 'and they are named per leg');

  const crawler = plans.BODY_PLANS.crawler;
  const tc = createCreatureTarget(crawler);
  ok(!tc.anchors.includes('head'), 'a headless plan has no head anchor');
  ok(tc.anchors.length !== t4.anchors.length, 'a different plan yields a different anchor list');

  // THE POINT OF THIS TARGET. The same component is legal against one plan and illegal against
  // another, purely because the anchor list is derived. No fixed list can express that.
  const onLeg2 = spec([comp({ parent: 'leg2L.foot', material: 'shell' })], 'creature');
  const big = createCreatureTarget(plans.generateBodyPlan(seeded(3), { pairCount: 4, segmentCount: 3 }));
  ok(validateSpec(onLeg2, big, { THREE }).ok, 'a four-pair creature accepts a piece on its third leg row');
  ok(has(validateSpec(onLeg2, t4, { THREE }), 'legality', 'parent'), 'a two-pair creature rejects the same piece');

  // Segment count moves the joint anchors too, not just the leg count.
  const long = createCreatureTarget(plans.generateBodyPlan(seeded(3), { pairCount: 2, segmentCount: 5 }));
  ok(long.anchors.includes('leg0L.j4'), 'a five-segment leg exposes four interior joints');
  ok(!t4.anchors.includes('leg0L.j4'), 'a three-segment leg does not');

  // The creature's budget is its own. Its segments do not go through the batches, so borrowing the
  // bot's unique-geometry economics would be a cost model that does not apply.
  ok(t4.budget.geometries !== botTarget.budget.geometries, 'the creature declares its own budget');
  ok(t4.lodTwin({ primitive: 'rbox' }) === false && botTarget.lodTwin({ primitive: 'rbox' }) === true,
    'and twins nothing, because it does not render through the batches');

  // A creature may use `tube`; a bot may not. Same spec, two verdicts.
  const tail = spec([comp({ id: 't', parent: 'body', primitive: 'tube', material: 'shell', topologyClass: 'fiber-strand', geometry: { path: [[0, 0, 0], [0, 0, -0.4]] }, size: [0.03] })], 'creature');
  ok(validateSpec(tail, t4, { THREE }).ok, 'a creature can carry a swept tail');
  ok(has(validateSpec({ ...tail, target: 'bot' }, botTarget, { THREE }), 'legality', 'primitive'), 'a bot cannot');
}

// ---- generated plans stay valid, whatever they generate ----
{
  let bad = 0, minA = Infinity, maxA = 0;
  for (let s = 1; s <= 60; s++) {
    const plan = plans.generateBodyPlan(seeded(s), { pairCount: 1 + (s % 5), segmentCount: 2 + (s % 4) });
    const anchors = anchorsForPlan(plan);
    minA = Math.min(minA, anchors.length); maxA = Math.max(maxA, anchors.length);
    if (new Set(anchors).size !== anchors.length) bad++;             // names must be unique
    const t = createCreatureTarget(plan);
    const one = spec([comp({ parent: anchors[anchors.length - 1], material: 'shell' })], 'creature');
    if (!validateSpec(one, t, { THREE }).ok) bad++;
  }
  eq(bad, 0, '60 generated plans give unique anchor names and accept a piece on the last one');
  ok(maxA > minA * 2, `anchor counts really do vary with the plan (${minA} to ${maxA})`);
}

// ---- a target declaration that is itself broken fails at definition ----
{
  let threw = 0;
  try { defineTarget({ key: 'x', primitives: ['rbox'], roles: ['a'] }); } catch { threw++; }
  try { defineTarget({ key: 'x', primitives: ['blancmange'], roles: ['a'], anchors: ['b'] }); } catch { threw++; }
  eq(threw, 2, 'a target missing anchors, or naming a primitive the factory cannot build, throws');
  eq(BOT_ANCHORS.length, 23, 'the bot declares 23 anchors, counting the side-less pair names');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
