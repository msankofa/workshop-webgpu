// Picking bones and chains.
//
// One representation, two gestures. Clicking a bone toggles that bone; clicking a chain toggles all of its
// bones at once. Both land in the same set, so a part can be roughed in with one chain click and then
// corrected bone by bone without switching anything -- there is no mode to be in, which is the whole
// point. `pokemon-annotation.js` applies the same rule when a selection becomes a part.
//
// The chain gesture exists because a median 11 significant chains beats a median 42 bones. The bone
// gesture exists because the chain decomposition is itself a structural guess: `extractChains` splits at
// every branch point, so a tuft hanging off a thigh cuts one leg into three. Neither is a fallback for the
// other.

/**
 * Add or remove keys as a group.
 *
 * A PARTLY present group is completed rather than having each key flipped, which is what a person means by
 * clicking a chain they have already started. Only a wholly present group is removed. Returns a new Set.
 */
export function toggleKeys(selected, keys, force = null) {
  const list = Array.isArray(keys) ? keys : [keys];
  const next = new Set(selected || []);
  const adding = force === null ? !list.every(k => next.has(k)) : force;
  for (const k of list) { if (adding) next.add(k); else next.delete(k); }
  return next;
}

/**
 * The chain a bone belongs to.
 *
 * Every NON-ROOT bone is in exactly one. The root is in none, on all 151 -- `extractChains` splits at
 * branch points and the root is one, so it is an attachment rather than a link. That is 151 bones dex-wide
 * and it is why `chainKeysOf` has a fallback rather than an assertion.
 */
export function chainContaining(rig, key) {
  return rig?.chains?.find(c => c.bones.includes(key)) || null;
}

/** The bones of the chain a bone belongs to, falling back to that bone alone for a root. */
export function chainKeysOf(rig, key) {
  return chainContaining(rig, key)?.bones ?? (rig?.byKey?.has(key) ? [key] : []);
}

/** Chains that are wholly selected, partly selected, or untouched. */
export function chainCoverage(rig, selected) {
  const have = new Set(selected || []);
  const whole = [], partial = [];
  for (const c of rig?.chains || []) {
    const n = c.bones.filter(b => have.has(b)).length;
    if (!n) continue;
    (n === c.bones.length ? whole : partial).push(c.id);
  }
  return { whole, partial };
}

/**
 * What is selected, in the terms the panel needs.
 *
 * `massFraction` is how much of the model's mesh the selection carries, which is the number that says
 * whether a selection is a limb or a decoration. Bones come back root-to-tip, so a selection built by
 * clicking in any order is still in the order a limb needs.
 */
export function selectionInfo(rig, selected) {
  const bones = orderSelection(rig, selected);
  const total = rig?.units?.totalVertices || 0;
  let vertices = 0;
  for (const b of bones) vertices += rig.geometry.get(b)?.count ?? 0;
  return {
    bones,
    count: bones.length,
    vertices,
    massFraction: total ? vertices / total : 0,
    chains: chainCoverage(rig, bones),
    unbroken: isUnbrokenRun(rig, bones),
  };
}

/** Bones root-to-tip, mirroring `orderBones` in pokemon-annotation.js so a selection needs no reordering. */
export function orderSelection(rig, selected) {
  return [...new Set(selected || [])]
    .filter(b => rig?.byKey?.has(b))
    .sort((a, b) => depth(rig, a) - depth(rig, b) || (rig.byKey.get(a).node - rig.byKey.get(b).node));
}

function depth(rig, key) {
  let d = 0, cur = rig.byKey.get(key)?.parent ?? null;
  while (cur) { d++; cur = rig.byKey.get(cur)?.parent ?? null; }
  return d;
}

/**
 * Whether the selection is one unbroken parent-to-child run.
 *
 * Reported, never enforced. A part does not have to be a chain -- a pair of ears is one part and two runs
 * -- so this is a hint in the panel and a gate's business later, not a rule here.
 */
export function isUnbrokenRun(rig, bones) {
  if (!bones?.length) return false;
  for (let i = 1; i < bones.length; i++) {
    if (rig.byKey.get(bones[i])?.parent !== bones[i - 1]) return false;
  }
  return true;
}

// ===================== screen-space picking =====================
//
// Nearest joint on screen rather than a raycast against joint spheres. The skeleton is drawn over the mesh
// with depth testing off, so what the eye picks is what is nearest in the picture -- a raycast would
// disagree with the drawing every time a bone sits behind a leg. It is also forgiving in a way a small
// sphere is not, which matters when a Magikarp's bones are a few pixels apart.

/**
 * The nearest projected point to (x, y) within `radius` pixels, or -1.
 *
 * `points` are already-projected `{x, y, depth, hidden}` in pixels. Ties go to the one nearest the camera,
 * so clicking where two bones overlap picks the one in front. Anything `hidden` is skipped.
 */
export function nearestPoint(points, x, y, radius = 14) {
  let best = -1, bestD = radius * radius, bestDepth = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || p.hidden) continue;
    const dx = p.x - x, dy = p.y - y;
    const d = dx * dx + dy * dy;
    if (d > bestD) continue;
    // A clearly nearer point wins on distance; an equally near one wins on depth.
    if (d < bestD - 0.5 || p.depth < bestDepth) { best = i; bestD = Math.min(bestD, d); bestDepth = p.depth; }
  }
  return best;
}

/**
 * Every projected point inside a screen rectangle, in `points` order.
 *
 * Corners come in either order, since a drag starts at whichever one the pointer went down on. `hidden` is
 * skipped for the same reason `nearestPoint` skips it: behind the camera the projection wraps and the
 * position is nonsense, so a box on the left of the picture would catch bones off to the right.
 *
 * Depth is ignored on purpose. This takes what is inside the box IN THE PICTURE, including bones the mesh
 * is in front of, which is the same promise the overlay makes by drawing with depth testing off.
 */
export function pointsInRect(points, x0, y0, x1, y1) {
  const left = Math.min(x0, x1), right = Math.max(x0, x1);
  const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || p.hidden) continue;
    if (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) out.push(i);
  }
  return out;
}
