// node test-model-targets.mjs
//
// The round trip: adopt the shipped bot design into a ModelSpec, emit it back, and require the
// result to be identical.
//
// This is the cheapest test that can invalidate the whole spec design. Anything the schema cannot
// carry shows up as a missing field on a real 87-piece design rather than as an opinion, and it does
// so in milliseconds. It is also the test that will keep being right: every future schema change
// has to survive it.

import * as THREE from 'three';
import { botTarget, adoptGear, emitGear, BOT_PAIR_ANCHORS } from './model-targets/bot.js';
import { validateSpec, measureSpec, instanceCount } from './model-spec.js';
import { BOT_BODY_DESIGN } from './bot-body-design.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('PASS: ' + name); }
  else { failed++; console.log('FAIL: ' + name); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${a}, want ${b})`); }

// Canonical form: key order must not count as a difference, but key PRESENCE must. An emitted piece
// that gained `size: undefined` is a real defect — it would enter the geometry cache key.
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
};
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ---- the round trip, piece by piece then whole ----
{
  const spec = botTarget.adopt(BOT_BODY_DESIGN);
  const back = botTarget.emit(spec);
  const gear = BOT_BODY_DESIGN.gear;

  eq(spec.components.length, gear.length, 'every gear piece becomes a component');
  eq(back.gear.length, gear.length, 'and comes back');

  // Piece by piece first, so a failure names the piece instead of dumping 87 of them.
  let bad = [];
  for (let i = 0; i < gear.length; i++) {
    if (!same(gear[i], back.gear[i])) bad.push(`${i}(${gear[i].anchor}/${gear[i].type})`);
  }
  eq(bad.length, 0, `all ${gear.length} pieces round-trip unchanged${bad.length ? ': ' + bad.slice(0, 6).join(' ') : ''}`);

  // Field presence, not just values. A dropped optional field is invisible in a value comparison of
  // the fields that survived.
  const keysOf = (arr) => { const s = new Set(); for (const p of arr) for (const k of Object.keys(p)) s.add(k); return [...s].sort(); };
  eq(keysOf(back.gear).join(','), keysOf(gear).join(','), 'the emitted gear uses exactly the same field set');
  for (let i = 0; i < gear.length; i++) {
    if (Object.keys(gear[i]).length !== Object.keys(back.gear[i]).length) { bad.push(String(i)); break; }
  }
  ok(bad.length === 0, 'and no piece gained or lost a field');

  // The rig is not gear. It has to survive the trip without being modelled.
  const rigKeys = Object.keys(BOT_BODY_DESIGN).filter((k) => k !== 'gear');
  ok(rigKeys.length > 20, `the design carries ${rigKeys.length} rig fields the spec does not model`);
  ok(rigKeys.every((k) => same(BOT_BODY_DESIGN[k], back[k])), 'every rig field comes back untouched');
  ok(same(BOT_BODY_DESIGN, back), 'the whole design round-trips, rig and gear together');
}

// ---- what adopt puts where ----
{
  const g = { anchor: 'head', type: 'extrude', role: 'rubber', smooth: false, position: [0, 0.024, 0.096], depth: 0.05, bevel: 0.004, seg: 1, outline: [[0, 0], [0.1, 0]] };
  const c = adoptGear(g, 3);
  eq(c.parent, 'head', 'anchor becomes parent');
  eq(c.primitive, 'extrude', 'type becomes primitive');
  eq(c.material, 'rubber', 'role becomes material');
  ok(same(c.transform.position, g.position), 'position moves into transform');
  ok(same(c.geometry, { smooth: false, depth: 0.05, bevel: 0.004, seg: 1, outline: g.outline }),
    'everything the factory reads lands in the geometry bag');
  ok(!('size' in c), 'a piece with no size does not gain one');
  eq(c.id, 'gear3', 'a piece with no id gets an index-based one');
  ok(!('id' in emitGear(c)), 'which is dropped on emit, so adopting does not add 87 fields to the design');

  // An authored id survives, because that is the handle an editing tool holds onto.
  eq(adoptGear({ ...g, id: 'visor-slit' }, 3).id, 'visor-slit', 'an authored id is kept');
  eq(emitGear(adoptGear({ ...g, id: 'visor-slit' }, 3)).id, 'visor-slit', 'and emitted');

  // A descriptor field this file has never heard of must still survive. The vocabulary grows.
  const odd = adoptGear({ ...g, someFutureField: 7 }, 0);
  eq(odd.geometry.someFutureField, 7, 'an unknown descriptor field lands in geometry');
  eq(emitGear(odd).someFutureField, 7, 'and comes back out');

  // faceBody is a rig behaviour, not a shape, so it is a flag rather than schema vocabulary.
  ok(adoptGear({ ...g, faceBody: true }, 0).flags.faceBody === true, 'faceBody becomes a flag');
  ok(emitGear(adoptGear({ ...g, faceBody: true }, 0)).faceBody === true, 'and emits back as faceBody');
}

// ---- the adopted design passes its own gates ----
{
  const spec = botTarget.adopt(BOT_BODY_DESIGN);
  const r = validateSpec(spec, botTarget, { THREE });
  const shown = r.errors.slice(0, 8).map((e) => `${e.gate}/${e.code} ${e.component}: ${e.message}`);
  ok(r.ok, `the shipped design passes every gate${r.ok ? '' : '\n    ' + shown.join('\n    ')}`);

  // THE FINDING THAT CHANGED GATE 4. It first ran as an error and rejected the shipped design on 91
  // of 761 same-anchor pairs. Every pair inspected was correct work — `gear12` is a bar on the FACE
  // of `gear0`, a hollow lathe head shell — so the gate was measuring the wrong thing, not the
  // design. Overlap is now advisory; only exact duplicates fail. This assertion pins that: a design
  // that has been through four rounds of visual critique must not be rejected by a bounding box.
  const overlaps = r.warnings.filter((w) => w.code === 'overlap').length;
  ok(overlaps > 20, `${overlaps} overlaps are reported on a design that is correct, which is why they are warnings`);
  eq(r.penetration.duplicates.length, 0, 'and the shipped design has no duplicated piece');

  // The measured cost of the real design. If these move, every bot in the scene pays for it.
  const m = measureSpec(spec, botTarget, { THREE });
  eq(m.components, 87, 'the design has 87 components');
  eq(m.geometries, 120, 'and mints 120 geometries: 70 distinct descriptors plus 50 rbox LOD twins');
  console.log(`# shipped bot: ${m.components} pieces, ${m.instances} instances, ${m.geometries} geometries, ${m.triangles} tris (${m.trianglesLod} at LOD)`);

  // 22 pieces sit on side-less anchors and therefore draw on both sides. Counting them once is what
  // made the Stage 2 budget read 87 instances for a body that draws 109.
  const dbl = BOT_BODY_DESIGN.gear.filter((g) => BOT_PAIR_ANCHORS.includes(g.anchor)).length;
  eq(dbl, 22, '22 pieces sit on side-less anchors');
  eq(m.instances, 87 + 22, 'so the instance count is 109, not 87');
  eq(instanceCount({ parent: 'knee' }, botTarget), 2, 'instanceCount doubles a side-less anchor');
  eq(instanceCount({ parent: 'head' }, botTarget), 1, 'and leaves a single anchor alone');
  eq(instanceCount({ parent: 'knee', mirror: true, repeat: { count: 3 } }, botTarget), 12,
    'target factor, mirror and repeat all multiply');

  ok(m.triangles > m.trianglesLod * 2, 'the LOD twins are worth having');
  ok(m.geometries <= botTarget.budget.geometries && m.triangles <= botTarget.budget.triangles,
    'and the shipped design is inside the budget the target declares');
}

// ---- adopt survives the degenerate cases ----
{
  ok(botTarget.adopt({}).components.length === 0, 'a design with no gear adopts to an empty spec');
  ok(botTarget.adopt(null).components.length === 0, 'so does nothing at all');
  ok(same(botTarget.emit({ components: [] }), { gear: [] }), 'and emits back an empty gear array');
  // A spec that never came from adopt has no rig, and must not invent one.
  ok(same(botTarget.emit({ components: [adoptGear({ anchor: 'torso', type: 'rbox', role: 'plate', size: [0.1, 0.1, 0.1] }, 0)] }),
    { gear: [{ anchor: 'torso', type: 'rbox', role: 'plate', size: [0.1, 0.1, 0.1] }] }),
    'a hand-built spec emits gear and nothing else');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
