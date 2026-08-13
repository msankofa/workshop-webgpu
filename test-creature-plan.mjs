// node test-creature-plan.mjs
//
// Covers the skeleton vocabulary lifted out of port-creature-system.js (creature-plan.js).
//
// Two things are being protected here. The first is that the extraction changed nothing: the stock
// plans and the seeded generator must produce exactly what the sim produced before. The second is
// `anchorsForPlan`, which is new — it is the seam the model studio's `creature` target hangs on, and
// the only reason that target can prove the spec has no fixed anchor list buried in it.

import * as THREE from 'three';
import { createCreaturePlans, anchorsForPlan, legName } from './creature-plan.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('PASS: ' + name); }
  else { failed++; console.log('FAIL: ' + name); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${a}, want ${b})`); }

const P = createCreaturePlans({ THREE });
const seeded = (s) => { let t = s >>> 0; return () => { t = (t * 1664525 + 1013904223) >>> 0; return t / 4294967296; }; };
const norm = (p) => JSON.stringify({
  label: p.label, bodyHeight: p.bodyHeight, bodyScale: p.bodyScale.toArray(), head: p.head,
  legs: p.legs.map((l) => ({ a: l.attachment.toArray(), r: l.rest.toArray(), s: l.side, row: l.row,
    seg: l.segments.map((g) => [g.length, g.initDirection.toArray()]) })),
});

// ---- the stock skeletons ----
{
  const keys = Object.keys(P.BODY_PLANS);
  eq(keys.length, 4, 'four stock plans');
  eq(P.BODY_PLANS.quadbot.legs.length, 4, 'quadbot has four legs');
  eq(P.BODY_PLANS.hexbot.legs.length, 6, 'hexbot has six');
  eq(P.BODY_PLANS.octobot.legs.length, 8, 'octobot has eight');
  ok(P.BODY_PLANS.crawler.head === false, 'the crawler is headless');

  // finalizePlan sorts front-to-back and assigns rows; the gait's stepping order reads them.
  for (const k of keys) {
    const legs = P.BODY_PLANS[k].legs;
    ok(legs.every((l, i) => i === 0 || legs[i - 1].rest.z >= l.rest.z), `${k}: legs are sorted front to back`);
    ok(legs.every((l) => l.row >= 0 && l.row < legs.length / 2 + 1), `${k}: every leg has a row`);
  }
  // pair() mirrors x on the attachment, the rest position AND each segment's initial direction.
  const [l, r] = P.pair(new THREE.Vector3(0.3, -0.2, 0.4), new THREE.Vector3(0.9, 0, 1.0),
    [P.segment(0.5, new THREE.Vector3(0.4, -0.3, 0.8).normalize())]);
  ok(l.attachment.x === -r.attachment.x && l.rest.x === -r.rest.x, 'pair mirrors the attachment and rest');
  ok(Math.abs(l.segments[0].initDirection.x + r.segments[0].initDirection.x) < 1e-9,
    'and mirrors the segment direction, which is what stops the left legs kicking inward');
}

// ---- round trips ----
{
  for (const k of Object.keys(P.BODY_PLANS)) {
    const src = P.BODY_PLANS[k];
    eq(norm(P.clonePlan(src)), norm(src), `${k}: clonePlan round-trips`);
    eq(norm(P.deserializePlan(P.serializePlan(src))), norm(src), `${k}: serialize/deserialize round-trips`);
    // A clone must be independent, or an edit to one creature would move every other.
    const c = P.clonePlan(src);
    c.legs[0].attachment.x += 5;
    ok(src.legs[0].attachment.x !== c.legs[0].attachment.x, `${k}: the clone is deep`);
  }
  ok(P.serializePlan(null) === null, 'serializing nothing gives nothing');
}

// ---- generation is seeded, and varies structurally ----
{
  eq(norm(P.generateBodyPlan(seeded(42), { pairCount: 3, segmentCount: 4 })),
     norm(P.generateBodyPlan(seeded(42), { pairCount: 3, segmentCount: 4 })),
     'the same seed gives the same creature');
  ok(norm(P.generateBodyPlan(seeded(42), { pairCount: 3, segmentCount: 4 })) !==
     norm(P.generateBodyPlan(seeded(43), { pairCount: 3, segmentCount: 4 })),
     'a different seed gives a different one');
  for (const pc of [1, 2, 5, 8]) {
    const p = P.generateBodyPlan(seeded(11), { pairCount: pc, segmentCount: 3 });
    eq(p.legs.length, pc * 2, `${pc} pairs gives ${pc * 2} legs`);
  }
  for (const sc of [1, 3, 6]) {
    const p = P.generateBodyPlan(seeded(11), { pairCount: 2, segmentCount: sc });
    ok(p.legs.every((l) => l.segments.length === sc), `${sc} segments per leg`);
  }
}

// ---- the model-studio seam: anchors derived from the plan ----
{
  const a = anchorsForPlan(P.BODY_PLANS.quadbot);
  ok(a[0] === 'body' && a.includes('head'), 'body and head come first');
  ok(!anchorsForPlan(P.BODY_PLANS.crawler).includes('head'), 'a headless plan has no head anchor');
  // A 3-segment chain has 4 points, so hip + two interior joints + foot.
  eq(a.filter((n) => n.startsWith('leg0L')).join(' '), 'leg0L.hip leg0L.j1 leg0L.j2 leg0L.foot',
    'each leg contributes hip, its interior joints, and the foot');
  eq(a.length, 2 + 4 * 4, 'quadbot derives 18 anchors');
  eq(anchorsForPlan(P.BODY_PLANS.octobot).length, 2 + 8 * 4, 'octobot derives 34');
  eq(legName(P.BODY_PLANS.quadbot.legs.find((l) => l.side < 0 && l.row === 0)), 'leg0L', 'names are row plus side');

  // Names must be unique across every shape the generator can make, or two pieces would land on the
  // same anchor and one would silently disappear.
  let dup = 0, min = Infinity, max = 0;
  for (let s = 1; s <= 120; s++) {
    for (const [pc, sc] of [[1, 1], [2, 3], [5, 5], [8, 6]]) {
      const names = anchorsForPlan(P.generateBodyPlan(seeded(s), { pairCount: pc, segmentCount: sc }));
      if (new Set(names).size !== names.length) dup++;
      min = Math.min(min, names.length); max = Math.max(max, names.length);
    }
  }
  eq(dup, 0, '480 generated plans give unique anchor names');
  ok(max > min * 4, `and the list length really varies with the plan (${min} to ${max})`);
}

// ---- editPlanWithSettings ----
{
  const settings = { scale: 2, bodyHeight: 1, bodyWidth: 1, bodyThickness: 1, bodyDepth: 1, hipX: 1, hipY: 1, restX: 1, restZ: 1, segmentScale: 1 };
  const src = P.BODY_PLANS.quadbot;
  const out = P.editPlanWithSettings(P.clonePlan(src), settings);
  ok(Math.abs(out.legs[0].segments[0].length - src.legs[0].segments[0].length * 2) < 1e-9, 'scale multiplies segment length');
  ok(Math.abs(out.bodyScale.x - src.bodyScale.x * 2) < 1e-9, 'and the body box');
  // It mutates what it is handed, so a caller that skips the clone loses the original.
  const victim = P.clonePlan(src);
  ok(P.editPlanWithSettings(victim, settings) === victim, 'editPlanWithSettings returns the plan it mutated');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
