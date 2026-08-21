// Resolve a shot against the individual parts of a procedural body.
//
// Combat hitscan tests one ~0.3 m capsule for the whole bot (bot-entity.js's DEFAULT_RADIUS), so a
// limb hit reports a "surface point" several centimetres off the mesh, in open air. A blood decal
// placed there can never look attached. This resolves the same shot against the rig's own parts and
// returns the hit in BOTH world space (spray/sparks, fire-and-forget) and part-local space (decals,
// which have to ride the animation).
//
// In instanced mode a part is a transform-only Object3D carrying `.geometry` and `._role`
// (player-procedural-body.js's makePart), so there is no Mesh to hand a Raycaster. This does a
// ray/AABB slab test in each part's own local space instead. The part geometry is mostly lathe
// surfaces rather than boxes (limbShape defaults to 'mannequin' and nothing overrides it), so the
// box is an approximation — chosen because it is GPU-free, Node-testable, and runs once per hit
// rather than once per frame.

let S = null;   // scratch, built once against the caller's THREE
function scratch(THREE) {
  if (!S) {
    S = {
      inv: new THREE.Matrix4(), nrm: new THREE.Matrix3(),
      o: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3(),
      hit: new THREE.Vector3(), n: new THREE.Vector3(), c: new THREE.Vector3(),
      po: new THREE.Vector3(), pe: new THREE.Vector3(), pd: new THREE.Vector3(),
      pm: new THREE.Matrix4(),
    };
  }
  return S;
}

// Parts live in `parts.all`, which player-procedural-body.js populates in instanced mode only. A
// mesh-mode body (the local first-person rig) has no index-addressable part list and is not a decal
// target, so it resolves to null rather than silently attaching to the wrong thing.
function partList(body) {
  const all = body?.parts?.all;
  return Array.isArray(all) && all.length ? all : null;
}

function boundsOf(part) {
  const g = part.geometry;
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox;
}

// Merged-gear parts (player-procedural-body.js mergeGear) carry per-piece OBBs so hit resolution
// keeps the same piece-level precision the individual parts had.
function mergedPieces(part) {
  const mp = part.userData?.mergedPieces;
  return Array.isArray(mp) && mp.length ? mp : null;
}

// The piece equivalent of partCrossSection: extents from the piece's own box, scale from the
// composed part-world x piece-local matrix.
function pieceCrossSection(part, piece, s) {
  s.pm.multiplyMatrices(part.matrixWorld, piece.matrix);
  const m = s.pm.elements;
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  return Math.min((piece.box.max.x - piece.box.min.x) * sx, (piece.box.max.z - piece.box.min.z) * sz);
}

// Matrices come from the last flush(), i.e. at most one frame stale — a hit resolved between frames
// against the previous frame's pose. Pass refresh:true to pay for a fresh walk of the whole rig.
function ensureMatrices(body, refresh) {
  if (refresh && body?.group?.updateMatrixWorld) body.group.updateMatrixWorld(true);
}

// Slab test in local space. Returns { t, axis, sign } for the ENTERING face, or null.
// `d` is deliberately not normalized: it is the world direction pushed through the inverse world
// matrix, so a non-uniformly scaled part still yields a `t` measured in world units and hits from
// different parts stay directly comparable.
function rayBox(ox, oy, oz, dx, dy, dz, box) {
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  let tmin = -Infinity, tmax = Infinity, axis = -1;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return null;   // parallel and outside the slab
      continue;
    }
    const inv = 1 / d[a];
    let t1 = (lo[a] - o[a]) * inv, t2 = (hi[a] - o[a]) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) { tmin = t1; axis = a; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis < 0 || tmin < 0 || tmin > tmax) return null;   // behind the muzzle, or origin inside the box
  return { t: tmin, axis, sign: d[axis] > 0 ? -1 : 1 };
}

// The wire-side handle. `part` is the index; `role` and `parts` exist to catch a stale or foreign
// index, which would otherwise resolve to a VALID matrix for the WRONG part and drop the decal
// somewhere else on the body. A guest builds its own rig and reviveCombatBot rebuilds the body, so
// index agreement is not guaranteed. This is a guard against gross mismatch, not proof of identity:
// `_role` is a MATERIAL role (shell/plate/trim/…), so several parts share one.
function makeAttachment(body, partIndex, lp, ln) {
  const all = partList(body);
  if (!all) return null;
  return { part: partIndex, role: all[partIndex]?._role ?? null, parts: all.length, lp, ln };
}

// The resolver half of the contract, injected into effect-renderer.js as `resolveAttachment`.
// Returns the part's live world matrix, or null when the handle no longer refers to that part.
export function resolveAttachmentMatrix(body, attach) {
  if (!body || !attach) return null;
  const all = partList(body);
  if (!all || all.length !== attach.parts) return null;
  const part = all[attach.part];
  if (!part || part._role !== attach.role) return null;
  return part.matrixWorld;
}

// How wide the part is, in world metres, ACROSS its own long axis — the narrower of its two
// cross-axis extents. A decal sized against this can't overhang the limb it's on, which is what a
// fixed decal size gets wrong in both directions: 0.15 m swallows a ~0.10 m forearm whole and is
// lost on a ~0.35 m torso. Local Y is the long axis for every part the rig builds (lathe profiles
// and placeSegment's stretch axis both run along it), so X and Z are the cross-axes.
export function partCrossSection(part) {
  const box = boundsOf(part);
  if (!box) return 0;
  const m = part.matrixWorld.elements;
  const sx = Math.hypot(m[0], m[1], m[2]);      // world scale of the local X axis
  const sz = Math.hypot(m[8], m[9], m[10]);     // ...and of the local Z axis
  return Math.min((box.max.x - box.min.x) * sx, (box.max.z - box.min.z) * sz);
}

function finish(THREE, body, all, idx, localPoint, localNormal, crossSection = null) {
  const part = all[idx];
  const s = scratch(THREE);
  const point = localPoint.clone().applyMatrix4(part.matrixWorld);
  // Normals need the normal matrix, not the model matrix — placeSegment stretches limb segments, so
  // the model matrix skews them. Same correction body-part-batches.js:180-183 makes for its raycast.
  s.nrm.getNormalMatrix(part.matrixWorld);
  const normal = localNormal.clone().applyMatrix3(s.nrm).normalize();
  const lp = [localPoint.x, localPoint.y, localPoint.z];
  const ln = [localNormal.x, localNormal.y, localNormal.z];
  return {
    partIndex: idx, part, role: part._role ?? null,
    point, normal, localPoint: lp, localNormal: ln,
    crossSection: crossSection ?? partCrossSection(part),
    attach: makeAttachment(body, idx, lp, ln),
  };
}

// Nearest part hit by the ray, or null if the shot misses every part.
export function resolveBodyHit({ THREE, body, origin, dir, refresh = false }) {
  const all = partList(body);
  if (!all || !origin || !dir) return null;
  ensureMatrices(body, refresh);
  const s = scratch(THREE);
  let bestT = Infinity, bestIdx = -1, bestAxis = -1, bestSign = 1, bestPiece = null;
  const bLocal = new THREE.Vector3();
  for (let i = 0; i < all.length; i++) {
    const part = all[i];
    if (!part.visible) continue;
    const pieces = mergedPieces(part);
    if (pieces) {
      s.inv.copy(part.matrixWorld).invert();
      s.o.set(origin.x, origin.y, origin.z).applyMatrix4(s.inv);
      s.e.set(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z).applyMatrix4(s.inv);
      for (const piece of pieces) {
        s.po.copy(s.o).applyMatrix4(piece.inverse);
        s.pe.copy(s.e).applyMatrix4(piece.inverse);
        s.pd.subVectors(s.pe, s.po);
        const r = rayBox(s.po.x, s.po.y, s.po.z, s.pd.x, s.pd.y, s.pd.z, piece.box);
        if (!r || r.t >= bestT) continue;
        bestT = r.t; bestIdx = i; bestAxis = r.axis; bestSign = r.sign; bestPiece = piece;
        bLocal.copy(s.po).addScaledVector(s.pd, r.t);   // piece space; mapped to part space below
      }
      continue;
    }
    const box = boundsOf(part);
    if (!box) continue;
    s.inv.copy(part.matrixWorld).invert();
    s.o.set(origin.x, origin.y, origin.z).applyMatrix4(s.inv);
    // Direction as (origin+dir) - origin, both pushed through the inverse: keeps the world scale in
    // the vector, which is what makes `t` comparable across differently-scaled parts.
    s.e.set(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z).applyMatrix4(s.inv);
    s.d.subVectors(s.e, s.o);
    const r = rayBox(s.o.x, s.o.y, s.o.z, s.d.x, s.d.y, s.d.z, box);
    if (!r || r.t >= bestT) continue;
    bestT = r.t; bestIdx = i; bestAxis = r.axis; bestSign = r.sign; bestPiece = null;
    bLocal.copy(s.o).addScaledVector(s.d, r.t);
  }
  if (bestIdx < 0) return null;
  const ln = new THREE.Vector3(
    bestAxis === 0 ? bestSign : 0, bestAxis === 1 ? bestSign : 0, bestAxis === 2 ? bestSign : 0);
  if (bestPiece) {
    bLocal.applyMatrix4(bestPiece.matrix);
    s.nrm.getNormalMatrix(bestPiece.matrix);
    ln.applyMatrix3(s.nrm).normalize();
    return finish(THREE, body, all, bestIdx, bLocal, ln, pieceCrossSection(all[bestIdx], bestPiece, s));
  }
  return finish(THREE, body, all, bestIdx, bLocal, ln);
}

// Attribute an ALREADY-accurate world point (e.g. from body-part-batches.js's triangle raycast) to
// the part nearest it, so it can be attached. Ranking uses the point clamped into each part's box;
// the returned local point is the unclamped one, so the decal stays exactly where it was placed.
export function attachFromPoint({ THREE, body, point, normal = null, refresh = false }) {
  const all = partList(body);
  if (!all || !point) return null;
  ensureMatrices(body, refresh);
  const s = scratch(THREE);
  let bestD = Infinity, bestIdx = -1, bestPiece = null;
  const bLocal = new THREE.Vector3();
  for (let i = 0; i < all.length; i++) {
    const part = all[i];
    if (!part.visible) continue;
    const pieces = mergedPieces(part);
    if (pieces) {
      s.inv.copy(part.matrixWorld).invert();
      s.o.set(point.x, point.y, point.z).applyMatrix4(s.inv);
      for (const piece of pieces) {
        s.po.copy(s.o).applyMatrix4(piece.inverse);
        const box = piece.box;
        s.c.set(
          Math.min(Math.max(s.po.x, box.min.x), box.max.x),
          Math.min(Math.max(s.po.y, box.min.y), box.max.y),
          Math.min(Math.max(s.po.z, box.min.z), box.max.z));
        const d = s.c.distanceToSquared(s.po);
        if (d >= bestD) continue;
        bestD = d; bestIdx = i; bestPiece = piece; bLocal.copy(s.po);
      }
      continue;
    }
    const box = boundsOf(part);
    if (!box) continue;
    s.inv.copy(part.matrixWorld).invert();
    s.o.set(point.x, point.y, point.z).applyMatrix4(s.inv);
    s.c.set(
      Math.min(Math.max(s.o.x, box.min.x), box.max.x),
      Math.min(Math.max(s.o.y, box.min.y), box.max.y),
      Math.min(Math.max(s.o.z, box.min.z), box.max.z));
    const d = s.c.distanceToSquared(s.o);
    if (d >= bestD) continue;
    bestD = d; bestIdx = i; bestPiece = null; bLocal.copy(s.o);
  }
  if (bestIdx < 0) return null;
  if (bestPiece) bLocal.applyMatrix4(bestPiece.matrix);   // piece -> part space
  // World normal in, part-local normal out: the inverse-transpose of the inverse world matrix is the
  // world matrix transposed, so pushing the normal through the part's own matrix as a direction and
  // renormalizing is the correct local normal even under non-uniform scale.
  const ln = new THREE.Vector3(0, 1, 0);
  if (normal) {
    s.nrm.getNormalMatrix(s.inv.copy(all[bestIdx].matrixWorld).invert());
    ln.set(normal.x, normal.y, normal.z).applyMatrix3(s.nrm).normalize();
  }
  if (bestPiece) return finish(THREE, body, all, bestIdx, bLocal, ln, pieceCrossSection(all[bestIdx], bestPiece, s));
  return finish(THREE, body, all, bestIdx, bLocal, ln);
}
