// node test-model-primitives.mjs
//
// Covers the extracted primitive vocabulary (model-primitives.js). Real THREE, no GPU: every
// builder here is pure math, so geometry can be asserted headlessly.
//
// The point of this file is that the CACHE KEY IS THE COST MODEL. A descriptor that should share a
// bucket must share one, and a descriptor that should not must not — because every distinct
// geometry mints an InstancedMesh bucket downstream that is never evicted.

import * as THREE from 'three';
import { createPrimitiveFactory, createGeometryCache, triangleCount, PRIMITIVE_TYPES, GEAR_LOD_SEG } from './model-primitives.js';
import { MODIFIER_OPS } from './model-modifiers.js';
import { signedVolume } from './model-csg.js';
import { BOT_BODY_DESIGN } from './bot-body-design.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('PASS: ' + name); }
  else { failed++; console.log('FAIL: ' + name); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${a}, want ${b})`); }

const make = (defaults = {}) => createPrimitiveFactory({ THREE, cache: createGeometryCache(), defaults });

// ---- every declared primitive actually builds ----
{
  const p = make();
  const sample = {
    rbox: { type: 'rbox', size: [0.2, 0.1, 0.05] },
    dome: { type: 'dome', profile: [[0.09, 0], [0.06, 0.06], [0.001, 0.09]], rim: [[0, 0], [0.5, 0.02]] },
    lathe: { type: 'lathe', profile: [[0.04, -0.05], [0.05, 0.05]] },
    extrude: { type: 'extrude', outline: [[0, 0], [0.1, 0], [0.1, 0.04], [0, 0.04]], depth: 0.03 },
    sphere: { type: 'sphere', size: [0.05] },
    cylinder: { type: 'cylinder', size: [0.04, 0.04, 0.12] },
    capsule: { type: 'capsule', size: [0.03, 0.08] },
    torus: { type: 'torus', size: [0.06, 0.015] },
    cone: { type: 'cone', size: [0.04, 0.1] },
    tube: { type: 'tube', size: [0.01], path: [[0, 0, 0], [0.05, 0.05, 0], [0.1, 0, 0]] },
  };
  for (const type of PRIMITIVE_TYPES) {
    const geo = p.geometryFor(sample[type]);
    ok(geo && triangleCount(geo) > 0, `${type} builds non-empty geometry`);
  }
  // An unknown type must not throw — it falls back to a box, which is visible and obviously wrong
  // rather than a silent hole in the model.
  ok(triangleCount(p.geometryFor({ type: 'nonsense', size: [0.1, 0.1, 0.1] })) === 12,
    'unknown type falls back to a 12-triangle box');
}

// ---- rbox tessellation is pinned ----
// These two numbers are quoted in the docs and drive every triangle budget, so they are asserted
// rather than trusted.
{
  const p = make();
  const g = { type: 'rbox', size: [0.2, 0.1, 0.05] };
  eq(triangleCount(p.geometryFor(g)), 828, 'rbox at the authored seg=3 is 828 triangles');
  eq(triangleCount(p.geometryFor(g, GEAR_LOD_SEG)), 156, 'rbox at the LOD seg=1 is 156 triangles');
}

// ---- cache identity: what shares a bucket and what does not ----
{
  const p = make();
  const a = { type: 'rbox', size: [0.2, 0.1, 0.05] };
  const b = { type: 'rbox', size: [0.2, 0.1, 0.05] };            // same content, different object
  const c = { type: 'rbox', size: [0.2, 0.1, 0.05], bevel: 0.004 };
  ok(p.geometryFor(a) === p.geometryFor(b), 'identical descriptors share one geometry');
  ok(p.geometryFor(a) !== p.geometryFor(c), 'a differing bevel mints a separate geometry');
  ok(p.geometryFor(a) !== p.geometryFor(a, GEAR_LOD_SEG), 'the LOD twin is a separate geometry');
  ok(p.geometryFor(a).userData.shared === true, 'cached geometry is tagged shared so destroy() spares it');
}

// ---- cache accounting and clear ----
{
  const cache = createGeometryCache();
  const p = createPrimitiveFactory({ THREE, cache });
  p.geometryFor({ type: 'sphere', size: [0.05] });
  p.geometryFor({ type: 'cone', size: [0.04, 0.1] });
  const s = cache.stats();
  eq(s.geometries, 2, 'stats counts distinct geometries');
  ok(s.triangles > 0, 'stats sums triangles');
  cache.clear();
  eq(cache.stats().geometries, 0, 'clear empties the cache');
}

// ---- defaults are options, not descriptor fields ----
{
  const outline = [[0, 0], [0.1, 0], [0.1, 0.05], [0, 0.05]];
  const plain = make({ outlineSmooth: 0 });
  const smooth = make({ outlineSmooth: 1 });
  const desc = { type: 'extrude', outline, depth: 0.02 };
  ok(triangleCount(plain.geometryFor(desc)) !== triangleCount(smooth.geometryFor(desc)),
    'outlineSmooth changes the extrusion, so it belongs in factory defaults');
  // An explicit descriptor field still wins over the default.
  ok(triangleCount(smooth.geometryFor({ ...desc, smooth: 0 })) === triangleCount(plain.geometryFor(desc)),
    'a descriptor smooth field overrides the default');
}

// ---- the real shipped design builds, and its cost is reported ----
// This is the budget gate's input: if these numbers move, every bot in the scene pays for it.
{
  const cache = createGeometryCache();
  const p = createPrimitiveFactory({ THREE, cache });
  const gear = BOT_BODY_DESIGN.gear || [];
  ok(gear.length > 0, 'the shipped bot design has gear to build');
  for (const g of gear) { p.geometryFor(g); p.geometryFor(g, GEAR_LOD_SEG); }
  const s = cache.stats();
  ok(s.geometries > 0 && s.geometries <= gear.length * 2,
    `shipped design mints ${s.geometries} geometries for ${gear.length} pieces (both LODs)`);
  console.log(`# shipped bot design: ${gear.length} gear pieces -> ${s.geometries} unique geometries, ${s.triangles} triangles cached`);
  // Every piece must name a type this factory can build, or it silently renders as a box.
  const unknown = gear.filter((g) => g.type && !PRIMITIVE_TYPES.includes(g.type));
  eq(unknown.length, 0, 'every shipped gear piece uses a declared primitive type');
}

// ---- tube: a cross-section swept along a curve ----
// The claim this primitive earns its place on is that the shape is unreachable otherwise, so the
// assertions are about the sweep following the path, not just about building.
{
  const p = make();
  const straight = { type: 'tube', size: [0.02], path: [[0, 0, 0], [0, 0.5, 0]], seg: 8, radial: 24 };
  const geo = p.geometryFor(straight);
  // A capped straight run is a closed solid with positive winding. The section is an INSCRIBED
  // 24-gon, not a circle, so the exact volume is the polygon's area times the length — 1.1% under
  // pi r^2 h, and using the circle here would have hidden a real 1% shortfall inside the tolerance.
  const v = signedVolume(geo);
  const sectionArea = 0.5 * 24 * 0.02 * 0.02 * Math.sin((Math.PI * 2) / 24);
  ok(Math.abs(v - sectionArea * 0.5) < 1e-8,
    `a capped straight tube has the volume of its swept section (got ${v.toExponential(4)})`);

  // The sweep must actually follow a bent path: a curved run is longer than the straight one.
  const bentGeo = p.geometryFor({ ...straight, path: [[0, 0, 0], [0.3, 0.25, 0], [0, 0.5, 0]] });
  bentGeo.computeBoundingBox();
  ok(bentGeo.boundingBox.max.x > 0.1, 'the sweep follows the path instead of ignoring it');

  // An explicit section makes a strap out of the same primitive a cable comes from. Which of the
  // two perpendicular axes the section's x lands on is the frame's business, so compare the pair.
  const strap = p.geometryFor({ ...straight, section: [[-1, -0.2], [1, -0.2], [1, 0.2], [-1, 0.2]] });
  strap.computeBoundingBox();
  const sz = strap.boundingBox.getSize(new THREE.Vector3());
  ok(Math.max(sz.x, sz.z) > Math.min(sz.x, sz.z) * 3, 'an explicit section gives a flat strap, not a round cable');

  // cap:false drops exactly the two end fans. It cannot be checked by volume: the signed volume of
  // an OPEN surface is not zero, it is origin-dependent, so only the triangle count is meaningful.
  const open = p.geometryFor({ ...straight, cap: false });
  eq(triangleCount(geo) - triangleCount(open), 2 * 24, 'cap:false drops exactly the two end fans');
  ok(p.geometryFor(straight) !== p.geometryFor({ ...straight, path: [[0, 0, 0], [0, 0.4, 0]] }),
    'a differing path mints a separate geometry');
}

// ---- modifiers deform, in order, and only where there is tessellation ----
{
  const p = make();
  // Long thin cylinder along Y, subdivided so the deformers have rings to move.
  const base = { type: 'cylinder', size: [0.05, 0.05, 0.4], radial: 16, lengthSeg: 24 };

  const taper = p.geometryFor({ ...base, modifiers: [{ op: 'taper', axis: 'y', start: 1, end: 0.2 }] });
  taper.computeBoundingBox();
  // Volume falls because the top end shrinks; the extent along the axis is untouched.
  ok(signedVolume(taper) < signedVolume(p.geometryFor(base)) * 0.7, 'taper narrows the solid');
  ok(Math.abs(taper.boundingBox.max.y - 0.2) < 1e-5, 'taper leaves the length alone');

  const bent = p.geometryFor({ ...base, modifiers: [{ op: 'bend', axis: 'y', around: 'z', angle: 1.2 }] });
  bent.computeBoundingBox();
  ok(bent.boundingBox.max.x - bent.boundingBox.min.x > 0.11, 'bend deflects off the axis');
  // `angle` is the TOTAL sweep, so a full turn closes the length into a ring of radius span/2pi.
  // Asserting that pins the units; asserting "the extent shrinks" would not, because the outer
  // edge of a bend is longer than the centreline and can grow past the original length.
  const ring = p.geometryFor({ ...base, modifiers: [{ op: 'bend', axis: 'y', around: 'z', angle: Math.PI * 2 }] });
  ring.computeBoundingBox();
  const span = ring.boundingBox.max.y - ring.boundingBox.min.y;
  ok(Math.abs(span - (2 * 0.4 / (Math.PI * 2) + 0.1)) < 0.02, `a full-turn bend closes into a ring (got ${span.toFixed(3)})`);
  ok(p.geometryFor({ ...base, modifiers: [{ op: 'bend', axis: 'y', angle: 0 }] }), 'a zero-angle bend is a safe no-op');

  // THE TRAP THIS TEST EXISTS FOR: with no rings along the axis a bend has nothing to move, and it
  // looks like the modifier is broken when it is the descriptor that is.
  const flat = p.geometryFor({ ...base, lengthSeg: 1, modifiers: [{ op: 'bend', axis: 'y', around: 'z', angle: 1.2 }] });
  flat.computeBoundingBox();
  ok(flat.boundingBox.max.x - flat.boundingBox.min.x < 0.11,
    'without lengthSeg a bend barely deforms, so lengthSeg is load-bearing');

  const twisted = p.geometryFor({ ...base, modifiers: [{ op: 'twist', axis: 'y', angle: Math.PI }] });
  ok(Math.abs(signedVolume(twisted) - signedVolume(p.geometryFor(base))) < 2e-5,
    'twist preserves volume, since it only rotates rings in place');

  const bulged = p.geometryFor({ ...base, modifiers: [{ op: 'bulge', axis: 'y', amount: 0.6, center: 0.5, width: 0.5 }] });
  ok(signedVolume(bulged) > signedVolume(p.geometryFor(base)) * 1.1, 'bulge adds volume at the centre');

  // Order is authored, never sorted: taper-then-bend is a different solid from bend-then-taper.
  const ab = p.geometryFor({ ...base, modifiers: [{ op: 'taper', axis: 'y', end: 0.3 }, { op: 'bend', axis: 'y', around: 'z', angle: 1 }] });
  const ba = p.geometryFor({ ...base, modifiers: [{ op: 'bend', axis: 'y', around: 'z', angle: 1 }, { op: 'taper', axis: 'y', end: 0.3 }] });
  ok(Math.abs(signedVolume(ab) - signedVolume(ba)) > 1e-7, 'modifier order changes the result');

  let threw = false;
  try { p.geometryFor({ ...base, modifiers: [{ op: 'nonsense' }] }); } catch { threw = true; }
  ok(threw, 'an unknown modifier throws, because a silent no-op is invisible');
  ok(MODIFIER_OPS.length === 5, 'five modifier ops are declared');
}

// ---- displacement is deterministic, because geometry is cached and shared ----
{
  const disp = { type: 'sphere', size: [0.1], radial: 24, seg: 18, modifiers: [{ op: 'displace', amount: 0.01, frequency: 30, seed: 7 }] };
  const a = make().geometryFor(disp);
  const b = make().geometryFor(disp);          // separate factory, separate cache
  let same = a.attributes.position.count === b.attributes.position.count;
  for (let i = 0; same && i < a.attributes.position.array.length; i++) {
    if (a.attributes.position.array[i] !== b.attributes.position.array[i]) same = false;
  }
  ok(same, 'displace rebuilds identically across caches, so shared geometry cannot disagree');
  const plain = make().geometryFor({ ...disp, modifiers: [] });
  ok(a.attributes.position.array[0] !== plain.attributes.position.array[0], 'displace actually moves vertices');
  ok(make().geometryFor(disp) !== make().geometryFor({ ...disp, modifiers: [{ op: 'displace', amount: 0.01, frequency: 30, seed: 8 }] }),
    'a differing seed mints a separate geometry');
}

// ---- CSG through the descriptor: a hole is authored, not faked ----
{
  const p = make();
  const plate = { type: 'rbox', size: [0.2, 0.2, 0.04] };
  const drilled = {
    ...plate,
    csg: [{ op: 'subtract', shape: { type: 'cylinder', size: [0.03, 0.03, 0.2], radial: 24 }, rotation: [Math.PI / 2, 0, 0] }],
  };
  const solid = p.geometryFor(plate), holed = p.geometryFor(drilled);
  ok(signedVolume(holed) < signedVolume(solid) - 1e-5, 'the subtraction removes material');
  ok(Math.abs(signedVolume(holed) - (signedVolume(solid) - Math.PI * 0.03 * 0.03 * 0.04)) < 2e-6,
    'and removes as much as the bore is worth');
  ok(solid !== holed, 'a csg stack mints a separate geometry');
  ok(p.geometryFor(drilled) === holed, 'the same csg stack still shares one geometry');

  // A cutter must never enter the cache: it is never rendered, and the budget gate counts entries.
  const cache = createGeometryCache();
  createPrimitiveFactory({ THREE, cache }).geometryFor(drilled);
  eq(cache.stats().geometries, 1, 'a cut piece costs one cached geometry, not two');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
