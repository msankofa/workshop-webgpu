// Node tests for map-boxes.js. The ground transforms are the part worth testing: they decide
// whether a wall floats over a dip, whether a slab dives into a hillside, and whether a bot can
// still walk under a lintel. Run: node test-map-boxes.mjs
import * as THREE from 'three';
import { UNIT_BOX, boxMesh, instancedBoxes, clearBoxes, boxOnGround, slabOnGround } from './map-boxes.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- boxOnGround: flat ground ----
{
  const b = boxOnGround(3, -4, 2, 3, 0.3, null);
  ok(b.x === 3 && b.z === -4 && b.w === 2 && b.d === 0.3, 'flat ground passes the footprint through');
  ok(near(b.h, 3), 'flat ground keeps the requested height');
  ok(near(b.y, 1.5), 'flat ground sits the box on y=0');
  ok(near(b.y - b.h / 2, 0), 'the flat box bottom is exactly the ground');
}

// ---- boxOnGround: sloped ground ----
// The contract: base 0.05 BELOW the lowest ground under the footprint (so no gap on a dip), and
// the top a full `h` above the HIGHEST (so a wall on a rise is not shortened into cover).
{
  const h = 3, range = { min: -1.2, max: 2.5 };
  const b = boxOnGround(0, 0, 4, h, 0.3, range);
  ok(near(b.y - b.h / 2, range.min - 0.05), 'the box is buried 5 cm below the lowest ground');
  ok(near(b.y + b.h / 2, range.max + h), 'the box top clears the highest ground by its full height');
  ok(b.h > h, `a box on a slope is taller than requested (${b.h.toFixed(2)} m for a ${h} m wall)`);
  ok(near(b.h, (range.max + h) - (range.min - 0.05)), 'height is exactly base-to-top');

  // Degenerate range (perfectly level terrain that is still enabled) must not differ from flat by
  // more than the deliberate 5 cm bury.
  const level = boxOnGround(0, 0, 4, h, 0.3, { min: 0, max: 0 });
  ok(near(level.h, h + 0.05) && near(level.y + level.h / 2, h), 'level terrain matches the flat case at the top');

  // Height must never invert, whatever the range.
  for (const r of [{ min: 5, max: 5 }, { min: -8, max: 9 }, { min: 2, max: 2.0001 }]) {
    ok(boxOnGround(0, 0, 1, 0.1, 1, r).h > 0, `positive height for range ${r.min}..${r.max}`);
  }
}

// ---- slabOnGround: headroom is the whole point ----
// A slab is absent from the nav grid by design, so a bot walks straight under it. If its underside
// ever drops below standing height it becomes a trap rather than an overhang.
{
  const s = slabOnGround(1, 2, 5, 6, 2.2, 0.35, 0);
  ok(s.x === 1 && s.z === 2 && s.w === 5 && s.d === 6 && near(s.h, 0.35), 'slab passes its footprint through');
  ok(near(s.y - s.h / 2, 2.2), 'the slab underside is exactly baseY above flat ground');

  const onHill = slabOnGround(0, 0, 5, 6, 2.2, 0.35, 4.0);
  ok(near(onHill.y - onHill.h / 2, 4.0 + 2.2), 'on a hill the underside lifts by the HIGHEST ground');
  ok(onHill.y - onHill.h / 2 >= 1.8, 'a slab never loses standing headroom over its footprint');
  ok(near(slabOnGround(0, 0, 1, 1, 2.2, 0.35).y - 0.175, 2.2), 'groundMax defaults to flat');

  // The reason it uses max and not min: sampling the LOW point would sink the slab into the rise.
  const wrong = slabOnGround(0, 0, 5, 6, 2.2, 0.35, -1.0);
  ok(wrong.y - wrong.h / 2 < onHill.y - onHill.h / 2, 'a lower ground sample gives a lower slab (max is what protects headroom)');
}

// ---- mesh glue: the shared-geometry contract teardown depends on ----
{
  const parent = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial();
  const boxes = [{ x: 0, y: 1, z: 0, w: 2, h: 2, d: 2 }, { x: 5, y: 1, z: 5, w: 1, h: 4, d: 1 }];

  ok(instancedBoxes(parent, mat, []) === null, 'an empty box list emits nothing');
  ok(parent.children.length === 0, 'and adds nothing to the parent');

  const mesh = instancedBoxes(parent, mat, boxes);
  ok(mesh && mesh.isInstancedMesh && mesh.count === 2, 'boxes become one InstancedMesh');
  ok(mesh.geometry === UNIT_BOX, 'instances share the unit geometry rather than allocating their own');
  ok(mesh.castShadow && mesh.receiveShadow, 'instanced boxes cast and receive shadows');
  ok(mesh.matrixAutoUpdate === false, 'static: a layout is rebuilt, never moved');
  // The transform must be scale-then-position, or every box lands at its scaled offset.
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), q = new THREE.Quaternion();
  mesh.getMatrixAt(1, m); m.decompose(pos, q, scl);
  ok(near(pos.x, 5) && near(pos.y, 1) && near(pos.z, 5), 'instance position is the box centre, unscaled');
  ok(near(scl.x, 1) && near(scl.y, 4) && near(scl.z, 1), 'instance scale is the box extent');

  const single = boxMesh(parent, mat, 1, 2, 3, 4, 5, 6);
  ok(single.geometry !== UNIT_BOX, 'a single box owns its geometry (it is sized, not scaled)');
  ok(parent.children.length === 2, 'both meshes joined the parent');

  // The trap: disposing UNIT_BOX breaks every later rebuild, so teardown must skip it.
  const ownGeo = single.geometry;
  let unitDisposed = false, ownDisposed = false;
  UNIT_BOX.addEventListener('dispose', () => { unitDisposed = true; });
  ownGeo.addEventListener('dispose', () => { ownDisposed = true; });
  clearBoxes(parent);
  ok(parent.children.length === 0, 'teardown empties the parent');
  ok(ownDisposed, 'teardown disposes geometry the mesh owned');
  ok(!unitDisposed, 'teardown never disposes the shared unit geometry');
  ok(instancedBoxes(parent, mat, boxes) !== null, 'a rebuild after teardown still works');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('map-boxes: all assertions passed');
