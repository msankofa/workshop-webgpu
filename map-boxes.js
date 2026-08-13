// map-boxes.js -- the box-mesh glue every map-building viewer needs: one shared unit geometry,
// instanced emission, teardown, and the two ground-fitting transforms. Extracted from
// bot-viewer-v3.html 2026-08-09 so structure-viewer.html is not a third copy of it.
// bot-viewer-v2.html is frozen and keeps its own copy on purpose.
//
// The ground transforms take a resolved height RANGE rather than a terrain field, so they are pure
// and Node-testable (test-map-boxes.mjs) and the caller keeps ownership of sampling.
import * as THREE from 'three';

// Shared across every box mesh in the scene: teardown must never dispose it.
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

// One static box mesh. Static because the viewers rebuild a layout rather than move it.
export function boxMesh(parent, mat, x, y, z, w, h, d) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  m.matrixAutoUpdate = false; m.updateMatrix();
  parent.add(m);
  return m;
}

// One InstancedMesh per material: a maze is ~950 boxes, and one draw call and one shadow caster
// beats 950. Collision is unaffected -- the collider expands instances into world triangles.
export function instancedBoxes(parent, mat, boxes) {
  if (!boxes.length) return null;
  const mesh = new THREE.InstancedMesh(UNIT_BOX, mat, boxes.length);
  const t = new THREE.Matrix4();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    t.makeScale(b.w, b.h, b.d).setPosition(b.x, b.y, b.z);
    mesh.setMatrixAt(i, t);
  }
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  mesh.matrixAutoUpdate = false; mesh.updateMatrix();
  parent.add(mesh);
  return mesh;
}

// Empty a map group, disposing what it owns and skipping what it shares.
export function clearBoxes(parent) {
  for (const m of [...parent.children]) {
    parent.remove(m);
    if (m.geometry && m.geometry !== UNIT_BOX) m.geometry.dispose();
    if (m.isInstancedMesh) m.dispose();   // frees the per-instance matrix buffer
  }
}

// A wall/cover box sunk into the hillside: base at the lowest ground under its footprint, top `h`
// above the highest, so it never floats over a dip nor loses height on a rise. `range` null = flat.
export function boxOnGround(x, z, w, h, d, range) {
  if (!range) return { x, y: h / 2, z, w, h, d };
  const base = range.min - 0.05;
  const top = range.max + h;
  return { x, y: (base + top) / 2, z, w, h: top - base, d };
}

// An ELEVATED box (lintel, canopy, portal deck): underside `baseY` above the HIGHEST ground under
// its footprint, so a slab spanning a dip never dives into the hillside and never loses headroom.
export function slabOnGround(x, z, w, d, baseY, h, groundMax = 0) {
  return { x, y: groundMax + baseY + h / 2, z, w, h, d };
}
