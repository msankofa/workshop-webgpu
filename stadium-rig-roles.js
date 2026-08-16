// Hand-assigned bone roles for a Stadium rig, and the compile step that turns them into leg specs.
//
// `stadium-rig-map.js` guesses which bones are legs from geometry, and on several species it guesses
// wrong in ways `rig-audit.js` can name but nothing could correct: Sandslash's four legs are two limbs
// walked out to two claws each, Pikachu's pair is six bones against four. This is the correction layer.
//
// The document is per BONE — "bone14 is the left front foot" — because that is what a click on a skeleton
// produces. `compileRoles` turns it into the per-LEG specs the mapper wants. Keeping those two shapes
// apart is the whole point: the editor never has to know about joint lists or knee indices, and the mapper
// never has to know a UI exists.
//
// Pure. No THREE, no glTF, no DOM.

/** What a bone can be within a leg. Order matters: it is proximal to distal. */
export const LEG_ROLES = ['leg', 'knee', 'foot'];

/** A leg is identified by row and side, which survive editing; array indices do not. */
export const legKey = (row, side) => `${row}${side < 0 ? 'L' : 'R'}`;

export function parseLegKey(key) {
  const m = /^(\d+)([LR])$/.exec(String(key));
  if (!m) return null;
  return { row: Number(m[1]), side: m[2] === 'L' ? -1 : 1 };
}

/** An empty document for a species. */
export const emptyRoles = (species = null) => ({ species, bones: {}, attach: {} });

/**
 * Capture what the mapper detected, so an editor starts from the current answer rather than blank.
 *
 * The knee is stored as a role on one bone rather than as an index, because an index into a bone list
 * silently means something different the moment a bone is added or removed.
 */
export function rolesFromMap(map, species = null) {
  const doc = emptyRoles(species ?? map.source ?? null);
  for (const leg of map.legs || []) {
    const key = legKey(leg.row, leg.side);
    doc.attach[key] = leg.attach;
    const footSet = new Set(leg.footBones || [leg.bones[leg.bones.length - 1]]);
    leg.bones.forEach((b, i) => {
      const role = footSet.has(b) ? 'foot' : (i === leg.kneeIndex ? 'knee' : 'leg');
      doc.bones[b] = { leg: key, role };
    });
  }
  return doc;
}

/** Assign one bone. `role` of null removes it. Returns a new document. */
export function assignBone(doc, bone, { leg = null, role = 'leg' } = {}) {
  const bones = { ...doc.bones };
  if (role === null || leg === null) delete bones[bone];
  else bones[bone] = { leg, role };
  return { ...doc, bones };
}

/** Set which bone a leg hangs off. */
export function setAttach(doc, legKeyStr, bone) {
  return { ...doc, attach: { ...doc.attach, [legKeyStr]: bone } };
}

/** Every leg key the document mentions, in row then side order. */
export function legKeys(doc) {
  const keys = new Set(Object.values(doc.bones).map(v => v.leg));
  return [...keys].filter(k => parseLegKey(k)).sort((a, b) => {
    const pa = parseLegKey(a), pb = parseLegKey(b);
    return pa.row - pb.row || pa.side - pb.side;
  });
}

/**
 * Order a leg's bones proximal to distal by walking the parent chain.
 *
 * Returns null if they do not form one unbroken chain, which is the mistake this is here to catch: two
 * bones from different limbs assigned to one leg look fine in a list and cannot be solved.
 */
export function orderChain(bones, parent) {
  if (!bones.length) return null;
  const set = new Set(bones);
  const roots = bones.filter(b => !set.has(parent[b] ?? -1));
  if (roots.length !== 1) return null;
  const out = [];
  let cur = roots[0];
  while (cur !== undefined && set.has(cur)) {
    out.push(cur);
    const kids = bones.filter(b => (parent[b] ?? -1) === cur);
    if (kids.length > 1) return null;
    cur = kids[0];
  }
  return out.length === bones.length ? out : null;
}

/**
 * Turn a role document into leg specs for `mapStadiumRig({ roles })`, plus everything wrong with it.
 *
 * Never throws and never silently drops a leg: a leg that cannot be compiled comes back in `warnings`
 * with its key, because a rig editor that quietly ignores half your assignments is worse than one that
 * refuses them.
 */
export function compileRoles(doc, { parent = {}, names = {} } = {}) {
  const warnings = [];
  const legs = [];
  const nameOf = (b) => names[b] ?? `bone${b}`;

  for (const key of legKeys(doc)) {
    const { row, side } = parseLegKey(key);
    const mine = Object.entries(doc.bones)
      .filter(([, v]) => v.leg === key)
      .map(([b]) => Number(b));

    const ordered = orderChain(mine, parent);
    if (!ordered) {
      warnings.push(`leg ${key}: ${mine.length} bones do not form one unbroken chain (${mine.map(nameOf).join(', ')})`);
      continue;
    }

    // The solver is two-bone: one bone gives a knee joint sitting on the sole and a lower segment of length 0.
    if (ordered.length < 2) {
      warnings.push(`leg ${key}: one bone (${nameOf(ordered[0])}) cannot make a two-bone leg`);
      continue;
    }

    const roleOf = (b) => doc.bones[b].role;
    const footBones = ordered.filter(b => roleOf(b) === 'foot');
    // The foot has to be the distal END of the chain, or "below the ankle" means nothing.
    if (footBones.length) {
      const firstFoot = ordered.indexOf(footBones[0]);
      if (ordered.slice(firstFoot).some(b => roleOf(b) !== 'foot')) {
        warnings.push(`leg ${key}: foot bones are not the end of the chain`);
        continue;
      }
    }

    const kneeBones = ordered.filter(b => roleOf(b) === 'knee');
    if (kneeBones.length > 1) {
      warnings.push(`leg ${key}: ${kneeBones.length} bones marked knee, only one may be`);
      continue;
    }
    // `kneeIndex` indexes the JOINT list, and joint i is the joint at the start of bone i, so the index of
    // the bone marked knee is the joint above it. Left undefined when unmarked, so the mapper's
    // equal-halves split still applies.
    const kneeIndex = kneeBones.length ? ordered.indexOf(kneeBones[0]) : undefined;
    if (kneeIndex === 0) {
      warnings.push(`leg ${key}: the topmost bone cannot be the knee`);
      continue;
    }
    // No check for a knee inside the foot: a bone carries one role, so a knee at or below the first foot
    // bone leaves a non-foot bone in the foot's span and the end-of-chain rule above has already refused it.

    const attach = doc.attach[key] ?? parent[ordered[0]] ?? -1;
    if (attach < 0) {
      warnings.push(`leg ${key}: no attach bone, and ${nameOf(ordered[0])} has no parent`);
      continue;
    }
    if (ordered.includes(attach)) {
      warnings.push(`leg ${key}: attach ${nameOf(attach)} is also one of its own bones`);
      continue;
    }

    legs.push({ row, side, attach, bones: ordered, kneeIndex, footBones });
  }

  // Sides must pair up, or the walker's row logic has nothing to alternate against.
  const byRow = new Map();
  for (const l of legs) byRow.set(l.row, (byRow.get(l.row) || 0) + 1);
  for (const [row, n] of byRow) if (n !== 2) warnings.push(`row ${row} has ${n} leg(s), not a pair`);

  const claimed = new Map();
  for (const l of legs) for (const b of l.bones) {
    if (claimed.has(b)) warnings.push(`${nameOf(b)} is in both leg ${claimed.get(b)} and ${legKey(l.row, l.side)}`);
    claimed.set(b, legKey(l.row, l.side));
  }

  return { legs, warnings };
}

/** True when two documents would compile to the same thing. Used to decide whether a remap is needed. */
export function rolesEqual(a, b) {
  if (!a || !b) return a === b;
  const keys = (d) => Object.keys(d.bones).sort();
  const ka = keys(a), kb = keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  if (ka.some(k => a.bones[k].leg !== b.bones[k].leg || a.bones[k].role !== b.bones[k].role)) return false;
  const aa = Object.keys(a.attach).sort(), ab = Object.keys(b.attach).sort();
  if (aa.length !== ab.length || aa.some((k, i) => k !== ab[i])) return false;
  return aa.every(k => a.attach[k] === b.attach[k]);
}
